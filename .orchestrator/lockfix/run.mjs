// Stress harness for registry.ts's withFileLock, driven through the module's real exports
// (updateStats / updateRegistry / reapDeadTasks) from real separate processes.
//
//   node build.mjs --name fixed --out <scratch>            # -> <scratch>/fixed/registry.cjs
//   node run.mjs --bundle <scratch>/fixed/registry.cjs --scenario all --runs 200
//   node run.mjs --bundle … --scenario paused --runs 200 --parallel 25
//   node run.mjs --bundle … --scenario hostile --only pid1 --runs 20
//
// Every run gets its own throwaway HOME (LOCKFIX_TMP or the OS temp dir), so the module's data
// root is a sandbox; the real ~/.claude-code-orchestrator is never opened. A run PASSES only
// when the final counters are exactly the number of calls that returned, no child saw two
// holders at once (see child.cjs), no child failed in a way the scenario did not predict, and
// the lock file is gone at the end.
//
// --timeout-ms N   the acquire timeout of the bundle under test (default 15000). Only the
//                  scenarios that WAIT for that timeout use it; pass it when the bundle was
//                  built with `--set LOCK_ACQUIRE_TIMEOUT_MS=…`.
// --stop-ms N      how long the `paused` holder stays SIGSTOPped (default 35000 — longer than
//                  the 30 s staleness threshold and the 15 s acquire timeout).
import keychainGuard from '../fixes/keychain-guard.cjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('lockfix-run');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'child.cjs');
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const BUNDLE = path.resolve(arg('--bundle', ''));
const SCENARIO = arg('--scenario', 'all');
const RUNS = Number(arg('--runs', '20'));
const PARALLEL = arg('--parallel') ? Number(arg('--parallel')) : undefined;
const ONLY = arg('--only');
const TIMEOUT_MS = Number(arg('--timeout-ms', '15000'));
const STOP_MS = Number(arg('--stop-ms', '35000'));
const STOP_ON_FAIL = argv.includes('--stop-on-fail');
// --chaos P,MAXMS  every child parks for up to MAXMS ms before a share P of the system calls the
//                  lock is built from (child.cjs, SCHEDULE FUZZING). Explores interleavings that
//                  otherwise need a badly overloaded machine.
const CHAOS = arg('--chaos') ? { p: Number(arg('--chaos').split(',')[0]), maxMs: Number(arg('--chaos').split(',')[1] ?? 3) } : undefined;
// LOAD BUDGET. A campaign that saturates the machine starves everybody else's tests and proves
// nothing extra, so:
// --max-procs N     at most N harness children alive at once: scenarios shrink their process
//                   count to fit (the total work per run is kept) and run one at a time.
// --load-gate HI,LO before each run, if the 1-minute load average is above HI, wait until it is
//                   below LO. Time spent waiting is reported and not counted against the budget.
// --budget-s S      stop starting runs once this invocation has been ACTIVE for S seconds; the
//                   summary then reports the number of runs actually completed.
const MAX_PROCS = Number(arg('--max-procs', '0'));
const CAPPED = MAX_PROCS > 0;
const GATE = arg('--load-gate') ? arg('--load-gate').split(',').map(Number) : undefined;
const BUDGET_S = Number(arg('--budget-s', '0'));
const T_START = Date.now();
let pausedMs = 0;
const activeSeconds = () => (Date.now() - T_START - pausedMs) / 1000;
let gating;
/** Wait while the machine is too busy. One waiter at a time; the others queue behind it. */
async function loadGate() {
  if (!GATE) return;
  while (gating) await gating;
  if (os.loadavg()[0] <= GATE[0]) return;
  const t0 = Date.now();
  gating = (async () => {
    while (os.loadavg()[0] >= GATE[1]) await sleep(5000);
  })();
  await gating;
  gating = undefined;
  pausedMs += Date.now() - t0;
}
const TMP = process.env.LOCKFIX_TMP || os.tmpdir();
if (!fs.existsSync(BUNDLE)) {
  console.error(`bundle not found: ${BUNDLE}`);
  process.exit(2);
}
fs.mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox() {
  const home = fs.mkdtempSync(path.join(TMP, 'cco-lockfix-'));
  const root = path.join(home, '.claude-code-orchestrator');
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stats.json'), '{}');
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ workers: [] }));
  return { home, root, cleanup: [] };
}
function destroy(sb) {
  for (const fn of sb.cleanup) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
  try {
    fs.rmSync(sb.home, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function spawnChild(sb, params) {
  if (CHAOS && !params.chaos) params = { ...params, chaos: CHAOS };
  const child = spawn(process.execPath, [CHILD, BUNDLE, JSON.stringify(params)], {
    env: { ...process.env, HOME: sb.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      let report;
      try {
        report = JSON.parse(out.trim().split('\n').pop());
      } catch {
        report = undefined;
      }
      resolve({ code, signal, report, stderr: err, pid: child.pid });
    });
  });
  return { child, done, pid: child.pid };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
async function deadPid() {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = c.pid;
  await new Promise((r) => c.once('exit', r));
  for (let i = 0; i < 100 && pidAlive(pid); i++) await sleep(10);
  return pid;
}
function sleeper(sb) {
  const c = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  sb.cleanup.push(() => c.kill('SIGKILL'));
  return c.pid;
}
/** A zombie: a child that has exited under a parent that never reaps it. Returns its pid. */
async function zombiePid(sb) {
  const c = spawn('/bin/sh', ['-c', 'sleep 0 & echo $!; exec sleep 600'], { stdio: ['ignore', 'pipe', 'ignore'] });
  sb.cleanup.push(() => c.kill('SIGKILL'));
  const pid = await new Promise((resolve) => {
    let buf = '';
    c.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(parseInt(buf, 10));
    });
  });
  await sleep(150);
  return pid;
}

const statsLock = (sb) => path.join(sb.root, 'stats.json.lock');
const registryLock = (sb) => path.join(sb.root, 'registry.json.lock');
/** The token at a lock path: a 2.0 lock is a symlink whose target IS the token; older ones are files. */
function readLock(p) {
  try {
    return fs.readlinkSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
  }
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
function readCount(sb, key = 'w') {
  try {
    return JSON.parse(fs.readFileSync(path.join(sb.root, 'stats.json'), 'utf8'))[key]?.tasks ?? 0;
  } catch (e) {
    return `unparseable stats.json (${e.message})`;
  }
}
function readRegistryCount(sb) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sb.root, 'registry.json'), 'utf8')).lockfixCounter ?? 0;
  } catch (e) {
    return `unparseable registry.json (${e.message})`;
  }
}
function violations(sb) {
  try {
    return fs.readFileSync(path.join(sb.root, 'HARNESS.violations.log'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
/** Names left in the data root that are neither state files nor the harness's own. */
function litter(sb) {
  return fs
    .readdirSync(sb.root)
    .filter((n) => !['stats.json', 'registry.json', 'tasks', 'tasks.jsonl'].includes(n) && !n.startsWith('HARNESS.'));
}

/** Fail unless every child exited 0 with no error and no violation. Returns sum of ok counts. */
function sumClean(results, problems, label = 'writer') {
  let stats = 0;
  let registry = 0;
  for (const r of results) {
    if (!r.report) {
      problems.push(`${label} ${r.pid} produced no report (code ${r.code}, signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
      continue;
    }
    stats += r.report.ok.stats;
    registry += r.report.ok.registry;
    if (r.report.errors.length) problems.push(`${label} ${r.pid} errors: ${r.report.errors.slice(0, 2).join(' | ')}`);
    if (r.report.violations.length) problems.push(`${label} ${r.pid} violations: ${r.report.violations.slice(0, 2).join(' | ')}`);
    if (r.stderr.trim()) problems.push(`${label} ${r.pid} stderr: ${r.stderr.trim().slice(0, 300)}`);
  }
  return { stats, registry };
}

async function writers(sb, n, params) {
  const startAt = Date.now() + 250;
  const kids = Array.from({ length: n }, () => spawnChild(sb, { startAt, ...params }));
  return Promise.all(kids.map((k) => k.done));
}

function finalChecks(sb, problems, expect) {
  if ('stats' in expect) {
    const got = readCount(sb, expect.key || 'w');
    if (got !== expect.stats) problems.push(`stats count ${got}, expected ${expect.stats}`);
  }
  if ('registry' in expect) {
    const got = readRegistryCount(sb);
    if (got !== expect.registry) problems.push(`registry count ${got}, expected ${expect.registry}`);
  }
  const v = violations(sb);
  if (v.length) problems.push(`${v.length} overlap(s): ${v.slice(0, 2).join(' | ')}`);
  if (!expect.lockMayRemain) {
    if (exists(statsLock(sb))) problems.push('stats.json.lock left behind');
    if (exists(registryLock(sb))) problems.push('registry.json.lock left behind');
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios. Each returns { problems: string[], note?: string }.
// ---------------------------------------------------------------------------------------------

/** 1. N processes × M increments, nothing planted. */
async function plain(sb) {
  const problems = [];
  const res = await writers(sb, 8, { stats: 20, csDelayMs: 1 });
  const sum = sumClean(res, problems);
  if (sum.stats !== 160) problems.push(`children report ${sum.stats} successful increments, expected 160`);
  finalChecks(sb, problems, { stats: 160 });
  return { problems };
}

/** 2. The same, behind an abandoned lock (dead holder). Alternates the legacy and current token shapes. */
async function dead(sb, i) {
  const problems = [];
  const pid = await deadPid();
  const shapes = [
    `${pid} ${Date.now()}`, // what probe.mjs plants (and what 1.5.3 could leave, minus the nonce)
    `${pid} ${Date.now()} abc123`, // 1.5.3 / 1.6-wip
    `${pid} ${Date.now()} abc123 ${Date.now() - 5000} 123456`, // 2.0's token, in a file (its fallback form)
    `${pid} ${Date.now()} abc123 ${Date.now() - 5000} -`, // 2.0's token as 2.0 publishes it: a symlink
  ];
  if (i % shapes.length === 3) fs.symlinkSync(shapes[3], statsLock(sb));
  else fs.writeFileSync(statsLock(sb), shapes[i % shapes.length]);
  const res = await writers(sb, 8, { stats: 20, csDelayMs: 1 });
  const sum = sumClean(res, problems);
  if (sum.stats !== 160) problems.push(`children report ${sum.stats} successful increments, expected 160`);
  finalChecks(sb, problems, { stats: 160 });
  return { problems };
}

/**
 * 3. A LIVE holder frozen inside the critical section for longer than every threshold.
 * Nobody may enter while it is stopped; its lock must still be there, still its own, when it is
 * resumed; every waiter that gave up must have failed with the lock error rather than entered;
 * and after the resume no increment is lost.
 */
async function paused(sb) {
  const problems = [];
  const signalFile = path.join(sb.root, 'HARNESS.paused');
  const holder = spawnChild(sb, { stats: 1, stopInside: true, signalFile });
  sb.cleanup.push(() => holder.child.kill('SIGKILL'));
  const t0 = Date.now();
  while (!exists(signalFile)) {
    if (Date.now() - t0 > 60_000) return { problems: ['holder never entered the section'] };
    await sleep(20);
  }
  await sleep(100); // let SIGSTOP land
  const tokenAtStop = readLock(statsLock(sb));
  if (tokenAtStop === undefined) problems.push('the holder is inside the section but there is no lock at the path');
  const W = 4;
  const M = 3;
  const kids = Array.from({ length: W }, () =>
    spawnChild(sb, { stats: M, retry: true, budgetMs: STOP_MS + 4 * TIMEOUT_MS + 60_000 }),
  );
  await sleep(STOP_MS);
  // Still stopped. The lock must be exactly what the holder wrote, and nobody may have counted.
  const tokenBeforeCont = readLock(statsLock(sb));
  if (tokenBeforeCont !== tokenAtStop) {
    problems.push(`the stopped holder's lock was replaced or removed (was ${JSON.stringify(tokenAtStop)}, now ${JSON.stringify(tokenBeforeCont)})`);
  }
  const countWhileStopped = readCount(sb);
  if (countWhileStopped !== 0) problems.push(`${countWhileStopped} increment(s) landed while the holder was stopped inside the section`);
  const contAt = Date.now();
  holder.child.kill('SIGCONT');
  const h = await holder.done;
  const res = await Promise.all(kids.map((k) => k.done));
  if (!h.report || h.report.ok.stats !== 1 || h.report.errors.length || h.report.violations.length) {
    problems.push(`holder did not finish cleanly after SIGCONT: ${JSON.stringify(h.report)} ${h.stderr.slice(0, 200)}`);
  }
  let ok = 0;
  let timeouts = 0;
  for (const r of res) {
    if (!r.report) {
      problems.push(`waiter ${r.pid} produced no report: ${r.stderr.slice(0, 200)}`);
      continue;
    }
    ok += r.report.ok.stats;
    timeouts += r.report.errorCount || 0;
    if (r.report.violations.length) problems.push(`waiter violations: ${r.report.violations[0]}`);
    for (const e of r.report.errors) {
      if (!/^Could not lock /.test(e)) problems.push(`waiter failed with an unexpected error: ${e}`);
    }
    const early = r.report.successAt.filter((t) => t < contAt);
    if (early.length) problems.push(`waiter ${r.pid} completed ${early.length} increment(s) before SIGCONT`);
    if (STOP_MS > TIMEOUT_MS + 2000 && (r.report.errorCount || 0) === 0) {
      problems.push(`waiter ${r.pid} never timed out although the holder was stopped for ${STOP_MS} ms`);
    }
  }
  if (ok !== W * M) problems.push(`waiters completed ${ok} increments, expected ${W * M}`);
  finalChecks(sb, problems, { stats: 1 + W * M });
  return { problems, note: `${timeouts} timeouts` };
}

/**
 * 4. Holders SIGKILLed at arbitrary moments — inside the section (self-kill from the mutate
 * callback) and anywhere else (the parent's random kills land in the create, the break, the
 * release) — while survivors keep writing. No survivor may lose an increment or fail, and the
 * lock must not be wedged afterwards.
 */
async function kill(sb) {
  const problems = [];
  let stop = false;
  let killed = 0;
  const victims = new Set();
  const churn = async () => {
    while (!stop) {
      const v = spawnChild(sb, { mode: 'victim', key: 'v', csDelayMs: 6, selfKill: 0.1 });
      victims.add(v);
      const fuse = setTimeout(() => {
        try {
          v.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 40 + Math.random() * 500);
      await v.done;
      clearTimeout(fuse);
      victims.delete(v);
      killed++;
    }
  };
  const churners = [churn(), churn(), churn()];
  // 6×20 by default; 5×24 under --max-procs, so that with the three victims at most 8 are alive.
  const res = await writers(sb, CAPPED ? 5 : 6, { stats: CAPPED ? 24 : 20, csDelayMs: 1 });
  stop = true;
  for (const v of victims) v.child.kill('SIGKILL');
  await Promise.all(churners);
  const sum = sumClean(res, problems, 'survivor');
  if (sum.stats !== 120) problems.push(`survivors report ${sum.stats} successful increments, expected 120`);
  // Whatever the last victim left behind must not wedge the next writer.
  const t0 = Date.now();
  const [last] = await writers(sb, 1, { stats: 1, key: 'after' });
  if (!last.report || last.report.ok.stats !== 1 || last.report.errors.length) {
    problems.push(`a writer arriving after the kills could not write: ${JSON.stringify(last.report)}`);
  }
  if (Date.now() - t0 > TIMEOUT_MS) problems.push(`the writer after the kills needed ${Date.now() - t0} ms`);
  finalChecks(sb, problems, { stats: 120 });
  return { problems, note: `${killed} victims killed, v=${readCount(sb, 'v')}` };
}

/**
 * 5. Hostile things at the lock path. `expect: 'cleared'` — every writer succeeds and all 40
 * increments land; `expect: 'refused'` — nobody enters, every call fails with the lock error,
 * and the planted file is untouched.
 */
const HOSTILE = {
  empty: { plant: (sb) => fs.writeFileSync(statsLock(sb), '') },
  garbage: { plant: (sb) => fs.writeFileSync(statsLock(sb), 'hello world\n\u0000\u0001 not a token') },
  huge: { plant: (sb) => fs.writeFileSync(statsLock(sb), Buffer.alloc(10 * 1024 * 1024, 0x41)) },
  fifo: { plant: (sb) => execFileSync('mkfifo', [statsLock(sb)]) },
  dir: { plant: (sb) => fs.mkdirSync(statsLock(sb)) },
  'dir-nonempty': {
    plant: (sb) => {
      fs.mkdirSync(statsLock(sb));
      fs.writeFileSync(path.join(statsLock(sb), 'x'), 'x');
    },
  },
  'symlink-dangling': { plant: (sb) => fs.symlinkSync(path.join(sb.root, 'nowhere'), statsLock(sb)) },
  'symlink-live-token': {
    // A symlink to a file holding a well-formed token of a LIVE process. The link is not a lock;
    // the file it points at must survive.
    plant: (sb) => {
      const target = path.join(sb.home, 'decoy');
      fs.writeFileSync(target, `${process.pid} ${Date.now()} zzz`);
      fs.symlinkSync(target, statsLock(sb));
      sb.decoy = target;
    },
    after: (sb, problems) => {
      if (!exists(sb.decoy)) problems.push('the symlink TARGET was removed');
    },
  },
  'symlink-devzero': { plant: (sb) => fs.symlinkSync('/dev/zero', statsLock(sb)) },
  // Unreadable by its mode. (Garbage inside, so that root — who can read it anyway, as in a
  // container — reaches the same verdict by the other road.)
  mode000: {
    plant: (sb) => {
      fs.writeFileSync(statsLock(sb), 'not a token');
      fs.chmodSync(statsLock(sb), 0o000);
    },
  },
  'garbage-future-mtime': {
    plant: (sb) => {
      fs.writeFileSync(statsLock(sb), 'garbage');
      const t = new Date(Date.now() + 3600_000);
      fs.utimesSync(statsLock(sb), t, t);
    },
  },
  // pid 1 is alive and was running long before the claim: indistinguishable from a held lock
  // (and in a container pid 1 may well BE an orchestrator), so it is refused, not cleared.
  pid1: { expect: 'refused', plant: (sb) => fs.writeFileSync(statsLock(sb), `1 ${Date.now()} zzz`) },
  // A live process that started AFTER the lock was claimed: the pid was recycled.
  'live-pid-recycled': {
    plant: (sb) => {
      const pid = sleeper(sb);
      const then = Date.now() - 120_000;
      fs.writeFileSync(statsLock(sb), `${pid} ${then} zzz`);
      fs.utimesSync(statsLock(sb), new Date(then), new Date(then));
    },
  },
  // A live process of the same user that was already running when the lock was claimed. Nothing
  // can tell this from a held lock, so it must be treated as one.
  'live-pid-older': {
    expect: 'refused',
    plant: async (sb) => {
      const pid = sleeper(sb);
      await sleep(6500); // older than the claim by more than the start-time slack
      fs.writeFileSync(statsLock(sb), `${pid} ${Date.now()} zzz`);
    },
  },
  // The same two, in the form 2.0 itself publishes: a symlink whose target text is the token.
  'symlink-token-older': {
    expect: 'refused',
    plant: async (sb) => {
      const pid = sleeper(sb);
      await sleep(6500);
      fs.symlinkSync(`${pid} ${Date.now()} zzz 0 -`, statsLock(sb));
    },
  },
  'symlink-token-zombie': {
    plant: async (sb) => fs.symlinkSync(`${await zombiePid(sb)} ${Date.now()} zzz 0 -`, statsLock(sb)),
  },
  zombie: {
    plant: async (sb) => {
      const pid = await zombiePid(sb);
      fs.writeFileSync(statsLock(sb), `${pid} ${Date.now()} zzz`);
    },
  },
  // The breaker election's own directory, occupied.
  'breakers-is-file': {
    plant: async (sb) => {
      fs.writeFileSync(statsLock(sb), `${await deadPid()} ${Date.now()} zzz`);
      fs.writeFileSync(`${statsLock(sb)}.breakers`, 'squatter');
    },
  },
  'breakers-dead-entry': {
    plant: async (sb) => {
      fs.writeFileSync(statsLock(sb), `${await deadPid()} ${Date.now()} zzz`);
      fs.mkdirSync(`${statsLock(sb)}.breakers`);
      fs.writeFileSync(path.join(`${statsLock(sb)}.breakers`, `${await deadPid()}.${Date.now()}.abc.${Date.now()}.0`), '');
      fs.writeFileSync(path.join(`${statsLock(sb)}.breakers`, 'junk'), 'junk');
    },
  },
};
async function hostile(sb, i) {
  const names = ONLY ? ONLY.split(',') : Object.keys(HOSTILE);
  const name = names[i % names.length];
  const spec = HOSTILE[name];
  const problems = [];
  await spec.plant(sb);
  const before = spec.expect === 'refused' ? readLock(statsLock(sb)) : undefined;
  const t0 = Date.now();
  const res = await writers(sb, 4, { stats: 10, csDelayMs: 1 });
  const elapsed = Date.now() - t0;
  if (spec.expect === 'refused') {
    for (const r of res) {
      if (!r.report) {
        problems.push(`writer produced no report: ${r.stderr.slice(0, 200)}`);
        continue;
      }
      if (r.report.ok.stats !== 0) problems.push(`a writer entered ${r.report.ok.stats} time(s) past a lock nothing proved abandoned`);
      // A writer without `retry` stops at its first failed call.
      if ((r.report.errorCount || 0) !== 1) problems.push(`expected the first call to be refused, got ${r.report.errorCount} refusals`);
      for (const e of r.report.errors) {
        if (!/^Could not lock /.test(e)) problems.push(`unexpected error: ${e}`);
      }
    }
    const now = readLock(statsLock(sb));
    if (now === undefined || now !== before) problems.push('the lock nothing proved abandoned was removed or replaced');
    finalChecks(sb, problems, { stats: 0, lockMayRemain: true });
  } else {
    const sum = sumClean(res, problems);
    if (sum.stats !== 40) problems.push(`children report ${sum.stats} successful increments, expected 40`);
    finalChecks(sb, problems, { stats: 40 });
    if (elapsed > TIMEOUT_MS) problems.push(`took ${elapsed} ms — longer than the acquire timeout`);
  }
  if (spec.after) spec.after(sb, problems);
  return { problems: problems.map((p) => `[${name}] ${p}`), note: name };
}

/** 6. Many concurrent breakers of one abandoned lock. */
async function breakers(sb) {
  const problems = [];
  fs.writeFileSync(statsLock(sb), `${await deadPid()} ${Date.now()} zzz`);
  // 24×5 by default; 8×15 under --max-procs.
  const res = await writers(sb, CAPPED ? 8 : 24, { stats: CAPPED ? 15 : 5 });
  const sum = sumClean(res, problems);
  if (sum.stats !== 120) problems.push(`children report ${sum.stats} successful increments, expected 120`);
  finalChecks(sb, problems, { stats: 120 });
  return { problems };
}

/**
 * 7. Every caller of the lock at once: updateStats and updateRegistry interleaved from the same
 * processes (two different locks, each behind an abandoned one), plus three concurrent
 * reapDeadTasks sweeps racing for the per-task reconcile locks of five planted dead tasks, one
 * of which also starts behind an abandoned reconcile lock. Each task must settle exactly once.
 */
async function mixed(sb) {
  const problems = [];
  const gone = await deadPid();
  fs.writeFileSync(statsLock(sb), `${gone} ${Date.now()} zzz`);
  fs.writeFileSync(registryLock(sb), `${gone} ${Date.now()} zzz`);
  const ids = [];
  const log = path.join(sb.root, 'tasks.jsonl');
  for (let t = 0; t < 5; t++) {
    const id = `lockfix${t}x${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    const outputFile = path.join(sb.root, 'tasks', `${id}.md`);
    fs.writeFileSync(outputFile, `# t\n\n- status: RUNNING\n`);
    fs.appendFileSync(
      log,
      JSON.stringify({ id, title: 't', worker: 'wa', model: 'opus', outputFile, cwd: sb.home, promptPreview: 'p', ts: Date.now() - 1000, status: 'running', pid: gone, pgid: gone }) + '\n',
    );
  }
  fs.writeFileSync(path.join(sb.root, 'tasks', `${ids[0]}.reconcile.lock`), `${gone} ${Date.now()} zzz`);
  const startAt = Date.now() + 250;
  const kids = [
    // 6×(15+15) by default; 5×(18+18) under --max-procs, which with the three sweeps makes 8.
    ...Array.from({ length: CAPPED ? 5 : 6 }, () =>
      spawnChild(sb, { startAt, stats: CAPPED ? 18 : 15, registry: CAPPED ? 18 : 15, interleave: true, csDelayMs: 1 }),
    ),
    ...Array.from({ length: 3 }, () => spawnChild(sb, { startAt, mode: 'reap' })),
  ];
  const res = await Promise.all(kids.map((k) => k.done));
  const sum = sumClean(res, problems);
  if (sum.stats !== 90) problems.push(`children report ${sum.stats} stats increments, expected 90`);
  if (sum.registry !== 90) problems.push(`children report ${sum.registry} registry increments, expected 90`);
  const reaped = res.reduce((n, r) => n + (r.report?.ok.reaped ?? 0), 0);
  if (reaped !== 5) problems.push(`sweeps report ${reaped} tasks settled, expected 5`);
  const events = fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const id of ids) {
    const terminal = events.filter((e) => e.id === id && e.status !== 'running');
    if (terminal.length !== 1) problems.push(`task ${id} has ${terminal.length} terminal events, expected exactly 1`);
    if (exists(path.join(sb.root, 'tasks', `${id}.reconcile.lock`))) problems.push(`reconcile lock of ${id} left behind`);
  }
  finalChecks(sb, problems, { stats: 90, registry: 90 });
  return { problems };
}

/**
 * 9. Holders that EXIT the moment they release. Sixty one-shot processes, one increment each,
 * arriving over a second: every token a waiter reads names a pid that is about to disappear, so
 * "the holder I read about is dead" is true again and again of a lock that was properly released
 * and has since been taken by somebody else. Always fuzzed — the gap between reading a token and
 * probing its pid is what this is about.
 */
async function exiters(sb) {
  const problems = [];
  const N = 60;
  const t0 = Date.now() + 300;
  const chaos = CHAOS ?? { p: 0.5, maxMs: 6 };
  let res;
  if (CAPPED) {
    // The same sixty one-shot writers, as a pool that keeps MAX_PROCS of them alive: each slot
    // starts the next writer the moment its own exits, so holders still exit continuously.
    res = [];
    let started = 0;
    const slot = async () => {
      while (started < N) {
        started++;
        res.push(await spawnChild(sb, { stats: 1, chaos }).done);
      }
    };
    await Promise.all(Array.from({ length: MAX_PROCS }, slot));
  } else {
    const kids = Array.from({ length: N }, () =>
      spawnChild(sb, { startAt: t0 + Math.random() * 1000, stats: 1, chaos }),
    );
    res = await Promise.all(kids.map((k) => k.done));
  }
  const sum = sumClean(res, problems);
  if (sum.stats !== N) problems.push(`children report ${sum.stats} successful increments, expected ${N}`);
  finalChecks(sb, problems, { stats: N });
  return { problems };
}

/**
 * 8. Release is identity-checked. Something OUTSIDE the protocol — a pre-2.0 process, a person —
 * removes a live holder's lock while it is frozen inside the section, and a different lock is at
 * the path when it resumes. The holder must leave that lock alone and must say what happened.
 */
async function evicted(sb) {
  const problems = [];
  const signalFile = path.join(sb.root, 'HARNESS.paused');
  const holder = spawnChild(sb, { stats: 1, stopInside: true, signalFile });
  sb.cleanup.push(() => holder.child.kill('SIGKILL'));
  const t0 = Date.now();
  while (!exists(signalFile)) {
    if (Date.now() - t0 > 60_000) return { problems: ['holder never entered the section'] };
    await sleep(20);
  }
  await sleep(100);
  fs.unlinkSync(statsLock(sb));
  const usurper = `${sleeper(sb)} ${Date.now()} usurper`;
  fs.writeFileSync(statsLock(sb), usurper);
  holder.child.kill('SIGCONT');
  const h = await holder.done;
  const now = readLock(statsLock(sb));
  if (now !== usurper) problems.push(`the evicted holder removed or replaced the lock that had taken its place (now ${JSON.stringify(now)})`);
  const errors = h.report?.errors ?? [];
  if (errors.length !== 1 || !/was removed by another process while this one held it/.test(errors[0])) {
    problems.push(`the evicted holder did not report the eviction: ${JSON.stringify(h.report)} ${h.stderr.slice(0, 200)}`);
  }
  return { problems };
}

const SCENARIOS = {
  // `procs`: harness children alive at once in ONE run under --max-procs 8.
  plain: { fn: plain, parallel: 3, procs: 8 },
  dead: { fn: dead, parallel: 3, procs: 8 },
  paused: { fn: paused, parallel: 25, procs: 5 },
  kill: { fn: kill, parallel: 3, procs: 8 },
  hostile: { fn: hostile, parallel: 6, procs: 4 },
  breakers: { fn: breakers, parallel: 2, procs: 8 },
  mixed: { fn: mixed, parallel: 3, procs: 8 },
  evicted: { fn: evicted, parallel: 6, procs: 1 },
  exiters: { fn: exiters, parallel: 2, procs: 8 },
};

async function runScenario(name) {
  const sc = SCENARIOS[name];
  const parallel = PARALLEL ?? (CAPPED ? Math.max(1, Math.floor(MAX_PROCS / sc.procs)) : sc.parallel);
  const t0 = Date.now();
  const loads = [os.loadavg()[0]];
  let next = 0;
  let failed = 0;
  let aborted = false;
  let outOfBudget = false;
  let completedOrStarted = 0;
  const pausedBefore = pausedMs;
  const reasons = new Map();
  const notes = new Map();
  const leftovers = new Map();
  const samples = [];
  const worker = async () => {
    for (;;) {
      await loadGate();
      if (next >= RUNS || aborted) return;
      if (BUDGET_S > 0 && activeSeconds() > BUDGET_S) {
        outOfBudget = true;
        return;
      }
      const i = next++;
      completedOrStarted++;
      const sb = makeSandbox();
      let result;
      try {
        result = await sc.fn(sb, i);
      } catch (e) {
        result = { problems: [`harness error: ${e.stack || e}`] };
      }
      for (const n of litter(sb)) {
        const kind = n.replace(/\d+/g, 'N');
        leftovers.set(kind, (leftovers.get(kind) || 0) + 1);
      }
      destroy(sb);
      loads.push(os.loadavg()[0]);
      if (result.note && name === 'hostile') notes.set(result.note, (notes.get(result.note) || 0) + 1);
      if (result.problems.length) {
        failed++;
        if (samples.length < 6) samples.push(`run ${i}: ${result.problems.slice(0, 3).join(' ;; ')}`);
        for (const p of result.problems) {
          const key = p.replace(/\d+/g, 'N').slice(0, 110);
          reasons.set(key, (reasons.get(key) || 0) + 1);
        }
        if (STOP_ON_FAIL) aborted = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, RUNS) }, worker));
  const done = completedOrStarted;
  const summary = {
    scenario: name,
    runs: aborted ? `${done} (stopped at first failure)` : outOfBudget ? `${done} of ${RUNS} (budget reached)` : done,
    failed,
    parallel,
    wallSeconds: Math.round((Date.now() - t0) / 100) / 10,
    ...(GATE ? { pausedForLoadSeconds: Math.round((pausedMs - pausedBefore) / 1000) } : {}),
    load1: { min: Math.min(...loads).toFixed(1), max: Math.max(...loads).toFixed(1), avg: (loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1) },
  };
  console.log(JSON.stringify(summary));
  if (notes.size && name === 'hostile') console.log(`  cases: ${JSON.stringify(Object.fromEntries(notes))}`);
  if (leftovers.size) console.log(`  leftovers in data root (name shape: runs): ${JSON.stringify(Object.fromEntries(leftovers))}`);
  if (failed) {
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [k, n] of top) console.log(`  ${n}× ${k}`);
    for (const s of samples.slice(0, 3)) console.log(`  e.g. ${s.slice(0, 600)}`);
  }
  return failed;
}

const names = SCENARIO === 'all' ? Object.keys(SCENARIOS) : SCENARIO.split(',');
let totalFailed = 0;
const tAll = Date.now();
for (const n of names) {
  if (!SCENARIOS[n]) {
    console.error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  totalFailed += await runScenario(n);
}
console.log(`TOTAL failed runs: ${totalFailed}; wall ${Math.round((Date.now() - tAll) / 1000)} s; load now ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`);
process.exit(totalFailed ? 1 : 0);
