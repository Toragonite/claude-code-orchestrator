// Stress harness for the mesh LEDGER's write lock (src/mesh/pool.ts), driven through the
// module's real exports — mutateMeshWorkers and mutateMeshOwnerFields — from real separate
// processes. Modelled on run.mjs (the registry lock's harness) and on pool-repro.mjs (the
// reproduction that showed the ledger's own lock losing records).
//
//   node pool-stress.mjs --out <scratch> --name after                       # the live src/
//   node pool-stress.mjs --out <scratch> --name before --src <a src/ tree> --legacy
//   node pool-stress.mjs --bundle <scratch>/after/pool.cjs --scenario paused --runs 100
//
// --src <dir>      the `src/` tree to bundle `mesh/pool.ts` from (default: this repository's).
//                  The tree is COPIED into <out>/<name>/src first and bundled from the copy, so a
//                  variant is one fixed set of files however long the campaign runs — other
//                  workers edit src/ at the same time. The copy's pool.ts and registry.ts hashes
//                  are printed.
// --bundle <file>  skip the build and test this bundle.
// --scenario a,b   plain, dead, kill, paused, mixed (default: all five, in that order).
// --runs N         runs per scenario (default 100).
// --legacy         the bundle under test carries the pre-2.0 lock, which only ever wrote regular
//                  files: plant abandoned locks in that form only. Without it the plants rotate
//                  through every form a lock can have (see `dead`).
// --stop-ms N      how long the `paused` holder stays SIGSTOPped (default 35000 — longer than
//                  the old lock's 30 s staleness threshold and both locks' 15 s acquire wait).
// --timeout-ms N   the acquire wait of the bundle under test (default 15000).
// --max-load N     STOP the campaign when the 1-minute load average passes N (default 40).
// --chaos P,MAXMS  schedule fuzzing in every child (pool-child.cjs).
//
// LOAD. At most EIGHT stress processes exist at any moment, whatever the scenario — the runs of
// a scenario are sequential except `paused`, whose four processes per run sleep nearly all the
// time and run two at a time. There is no load generator. The load average is read before every
// run and the campaign stops, saying so, when it passes --max-load.
//
// Every run gets its own throwaway HOME (LOCKFIX_TMP or the OS temp dir), so the module's data
// root is a sandbox; the real ~/.claude-code-orchestrator is never opened. A run PASSES only
// when the ledger ends with EXACTLY the records the writers were told had landed (each once),
// the owner counter is exactly the number of owner writes that were told had landed, no child
// saw two holders at once (pool-child.cjs), no write was skipped or failed that the scenario did
// not predict, and no lock is left at the path.
import keychainGuard from '../fixes/keychain-guard.cjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('pool-stress');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'pool-child.cjs');
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const SCENARIO = arg('--scenario', 'all');
const RUNS = Number(arg('--runs', '100'));
const LEGACY = argv.includes('--legacy');
const TIMEOUT_MS = Number(arg('--timeout-ms', '15000'));
const STOP_MS = Number(arg('--stop-ms', '35000'));
const MAX_LOAD = Number(arg('--max-load', '40'));
const STOP_ON_FAIL = argv.includes('--stop-on-fail');
const CHAOS = arg('--chaos') ? { p: Number(arg('--chaos').split(',')[0]), maxMs: Number(arg('--chaos').split(',')[1] ?? 3) } : undefined;
const TMP = process.env.LOCKFIX_TMP || os.tmpdir();
/** The ceiling on stress processes alive at once. Every scenario below is sized against it. */
const MAX_PROCS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);

async function buildBundle() {
  const out = arg('--out');
  const name = arg('--name');
  if (!out || !name) {
    console.error('usage: node pool-stress.mjs (--bundle <pool.cjs> | --out <dir> --name <variant> [--src <src dir>]) [--scenario …] [--runs N] [--legacy]');
    process.exit(2);
  }
  const src = path.resolve(arg('--src', path.join(REPO, 'src')));
  const stage = path.join(path.resolve(out), name);
  const copy = path.join(stage, 'src');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(src, copy, { recursive: true });
  const require = createRequire(path.join(REPO, 'package.json'));
  const bundle = path.join(stage, 'pool.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(copy, 'mesh', 'pool.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
  });
  console.log(`bundle ${bundle} — from ${src} (pool.ts ${sha(path.join(copy, 'mesh', 'pool.ts'))}, registry.ts ${sha(path.join(copy, 'registry.ts'))})`);
  return bundle;
}

const BUNDLE = arg('--bundle') ? path.resolve(arg('--bundle')) : await buildBundle();
if (!fs.existsSync(BUNDLE)) {
  console.error(`bundle not found: ${BUNDLE}`);
  process.exit(2);
}
fs.mkdirSync(TMP, { recursive: true });

function spawnChild(sb, params) {
  if (CHAOS && !params.chaos) params = { ...params, chaos: CHAOS };
  const child = spawn(process.execPath, [CHILD, BUNDLE, JSON.stringify({ cwd: sb.cwd, ...params })], {
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

/**
 * A sandbox with an EXISTING, empty ledger. The state file's name is a hash of the workspace
 * path, so the module is asked for it (one no-op write) rather than the hash being guessed.
 */
async function makeSandbox() {
  const home = fs.mkdtempSync(path.join(TMP, 'cco-poolstress-'));
  const root = path.join(home, '.claude-code-orchestrator');
  const meshDir = path.join(root, 'mesh');
  const cwd = path.join(home, 'ws');
  fs.mkdirSync(cwd);
  fs.mkdirSync(meshDir, { recursive: true });
  const sb = { home, root, meshDir, cwd, cleanup: [] };
  await spawnChild(sb, { mode: 'touch', chaos: { p: 0, maxMs: 0 } }).done;
  const stateName = fs.readdirSync(meshDir).find((n) => /^[0-9a-f]+\.json$/.test(n));
  if (!stateName) {
    throw new Error(`could not locate the state file; the mesh dir holds ${JSON.stringify(fs.readdirSync(meshDir))}`);
  }
  sb.state = path.join(meshDir, stateName);
  sb.lock = `${sb.state}.write.lock`;
  return sb;
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
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function readLedger(sb) {
  try {
    const state = JSON.parse(fs.readFileSync(sb.state, 'utf8'));
    return { workers: Array.isArray(state.workers) ? state.workers : [], startedAt: state.startedAt ?? 0 };
  } catch (e) {
    return { error: `unparseable state file (${e.message})`, workers: [], startedAt: 0 };
  }
}
function violations(sb) {
  try {
    return fs.readFileSync(path.join(sb.root, 'HARNESS.violations.log'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

/**
 * Leave an abandoned write lock (dead holder). `--legacy` plants only the two forms the pre-2.0
 * lock itself wrote; otherwise the plant rotates through every form a lock can take: those two,
 * 2.0's token in a regular file (its fallback form), and 2.0's token as 2.0 publishes it — a
 * symbolic link whose target text is the token.
 */
async function plantAbandoned(sb, i) {
  const pid = await deadPid();
  const shapes = [
    `${pid} ${Date.now()} zzz`, // what the pre-2.0 ledger lock wrote
    `${pid} ${Date.now()}`,
    `${pid} ${Date.now()} abc123 ${Date.now() - 5000} 123456`,
    `${pid} ${Date.now()} abc123 ${Date.now() - 5000} -`,
  ];
  const k = i % (LEGACY ? 2 : shapes.length);
  if (k === 3) fs.symlinkSync(shapes[3], sb.lock);
  else fs.writeFileSync(sb.lock, shapes[k]);
}

async function writers(sb, n, params) {
  const startAt = Date.now() + 250;
  const kids = Array.from({ length: n }, () => spawnChild(sb, { startAt, ...params }));
  return Promise.all(kids.map((k) => k.done));
}

/**
 * Compare what the writers were told with what is on disk. `results` are the children whose
 * every reported success must be in the ledger exactly once (tag `r`); nothing else tagged `r`
 * may be there. Fills `tally` so the summary can say HOW a run failed, not only that it did.
 */
function settle(sb, results, problems, tally, expect) {
  let told = 0;
  let toldOwner = 0;
  const want = new Set();
  for (const r of results) {
    if (!r.report) {
      problems.push(`writer ${r.pid} produced no report (code ${r.code}, signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
      continue;
    }
    told += r.report.ok.workers;
    toldOwner += r.report.ok.owner;
    for (let i = 0; i < r.report.ok.workers; i++) want.add(`r-${r.report.pid}-${i}`);
    if (r.report.errors.length) problems.push(`writer ${r.pid} errors: ${r.report.errors.slice(0, 2).join(' | ')}`);
    if (r.report.violations.length) problems.push(`writer ${r.pid} violations: ${r.report.violations.slice(0, 2).join(' | ')}`);
    if (!expect.skipsAllowed && r.report.skips) problems.push(`writer ${r.pid} had ${r.report.skips} write(s) skipped: ${String(r.report.skipReasons[0]).slice(0, 300)}`);
    if (r.stderr.trim()) problems.push(`writer ${r.pid} stderr: ${r.stderr.trim().slice(0, 300)}`);
  }
  if ('workers' in expect && told !== expect.workers) problems.push(`writers report ${told} appends landed, expected ${expect.workers}`);
  if ('owner' in expect && toldOwner !== expect.owner) problems.push(`writers report ${toldOwner} owner writes landed, expected ${expect.owner}`);
  const ledger = readLedger(sb);
  if (ledger.error) problems.push(ledger.error);
  const seen = new Map();
  for (const w of ledger.workers) {
    if (typeof w?.name === 'string' && w.name.startsWith('r-')) seen.set(w.name, (seen.get(w.name) || 0) + 1);
  }
  let missing = 0;
  for (const name of want) if (!seen.has(name)) missing++;
  const duplicated = [...seen.values()].filter((n) => n > 1).length;
  const strangers = [...seen.keys()].filter((n) => !want.has(n)).length;
  if (missing) problems.push(`${missing} of ${want.size} records the writers were told had landed are NOT in the ledger`);
  if (duplicated) problems.push(`${duplicated} record(s) appear more than once`);
  if (strangers) problems.push(`${strangers} record(s) in the ledger that no writer reported`);
  if ('owner' in expect && ledger.startedAt !== toldOwner) {
    problems.push(`owner counter is ${ledger.startedAt}, but ${toldOwner} owner writes were told had landed`);
    tally.ownerLost += Math.max(0, toldOwner - ledger.startedAt);
  }
  const v = violations(sb);
  if (v.length) problems.push(`${v.length} overlap(s): ${v.slice(0, 2).join(' | ')}`);
  if (exists(sb.lock)) problems.push('the write lock was left behind');
  tally.missing += missing;
  if (missing) tally.shortRuns++;
  tally.overlaps += v.length;
  if (v.length) tally.overlapRuns++;
  return { told, toldOwner, ledger };
}

// ---------------------------------------------------------------------------------------------
// Scenarios. Each returns { problems: string[], note?: string } and is sized to MAX_PROCS.
// ---------------------------------------------------------------------------------------------

/** 1. 8 processes × 20 appends, nothing planted. */
async function plain(sb, i, tally) {
  const problems = [];
  const res = await writers(sb, 8, { workers: 20, csDelayMs: 1 });
  settle(sb, res, problems, tally, { workers: 160 });
  return { problems };
}

/** 2. The same, behind an abandoned lock (dead holder) — the case that needs a lock BROKEN. */
async function dead(sb, i, tally) {
  const problems = [];
  await plantAbandoned(sb, i);
  const res = await writers(sb, 8, { workers: 20, csDelayMs: 1 });
  settle(sb, res, problems, tally, { workers: 160 });
  return { problems };
}

/**
 * 3. Writers SIGKILLed again and again — inside the section (self-kill from the mutator) and
 * anywhere else (the parent's random kills land in the create, the break, the release) — while
 * five survivors keep appending. Three victims are alive at a time, so eight processes in all.
 * No survivor may lose a record, be skipped or fail, and the lock must not be wedged afterwards.
 */
async function kill(sb, i, tally) {
  const problems = [];
  let stop = false;
  let killed = 0;
  const victims = new Set();
  const churn = async () => {
    while (!stop) {
      const v = spawnChild(sb, { mode: 'victim', tag: 'v', csDelayMs: 6, selfKill: 0.1 });
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
  const res = await writers(sb, MAX_PROCS - 3, { workers: 20, csDelayMs: 1 });
  stop = true;
  for (const v of victims) v.child.kill('SIGKILL');
  await Promise.all(churners);
  // Whatever the last victim left behind must not wedge the next writer.
  const t0 = Date.now();
  const [last] = await writers(sb, 1, { workers: 1 });
  if (!last.report || last.report.ok.workers !== 1) {
    problems.push(`a writer arriving after the kills could not write: ${JSON.stringify(last.report)}`);
  }
  if (Date.now() - t0 > TIMEOUT_MS) problems.push(`the writer after the kills needed ${Date.now() - t0} ms`);
  const { ledger } = settle(sb, [...res, last], problems, tally, { workers: (MAX_PROCS - 3) * 20 + 1 });
  return { problems, note: `${killed} victims killed, ${ledger.workers.filter((w) => String(w?.name).startsWith('v-')).length} of their records landed` };
}

/**
 * 4. A LIVE holder frozen inside the critical section for longer than every threshold. Nobody
 * may enter while it is stopped; its lock must still be there, still its own, when it is
 * resumed; every waiter that gave up must have been told its write was SKIPPED rather than have
 * entered; and after the resume every record is there. Four processes per run.
 */
async function paused(sb, i, tally) {
  const problems = [];
  const signalFile = path.join(sb.root, 'HARNESS.paused');
  const holder = spawnChild(sb, { workers: 1, stopInside: true, signalFile });
  sb.cleanup.push(() => holder.child.kill('SIGKILL'));
  const t0 = Date.now();
  while (!exists(signalFile)) {
    if (Date.now() - t0 > 60_000) return { problems: ['holder never entered the section'] };
    await sleep(20);
  }
  await sleep(100); // let SIGSTOP land
  const tokenAtStop = readLock(sb.lock);
  if (tokenAtStop === undefined) problems.push('the holder is inside the section but there is no lock at the path');
  const W = 3;
  const M = 3;
  const kids = Array.from({ length: W }, () =>
    spawnChild(sb, { workers: M, retry: true, budgetMs: STOP_MS + 4 * TIMEOUT_MS + 60_000 }),
  );
  await sleep(STOP_MS);
  // Still stopped. The lock must be exactly what the holder wrote, and nobody may have written.
  const tokenBeforeCont = readLock(sb.lock);
  if (tokenBeforeCont !== tokenAtStop) {
    problems.push(`the stopped holder's lock was replaced or removed (was ${JSON.stringify(tokenAtStop)}, now ${JSON.stringify(tokenBeforeCont)})`);
  }
  const whileStopped = readLedger(sb).workers.length;
  if (whileStopped !== 0) problems.push(`${whileStopped} record(s) landed while the holder was stopped inside the section`);
  const contAt = Date.now();
  holder.child.kill('SIGCONT');
  const h = await holder.done;
  const res = await Promise.all(kids.map((k) => k.done));
  if (!h.report || h.report.ok.workers !== 1 || h.report.skips) {
    problems.push(`holder did not finish cleanly after SIGCONT: ${JSON.stringify(h.report)} ${h.stderr.slice(0, 200)}`);
  }
  let skips = 0;
  for (const r of res) {
    if (!r.report) continue;
    skips += r.report.skips;
    const early = r.report.successAt.filter((t) => t < contAt);
    if (early.length) problems.push(`waiter ${r.pid} completed ${early.length} append(s) before SIGCONT`);
    if (STOP_MS > TIMEOUT_MS + 2000 && r.report.skips === 0) {
      problems.push(`waiter ${r.pid} was never told a write was skipped although the holder was stopped for ${STOP_MS} ms`);
    }
    for (const why of r.report.skipReasons) {
      if (!/could not be taken/i.test(why)) problems.push(`waiter skipped for an unexpected reason: ${why.slice(0, 300)}`);
    }
  }
  settle(sb, [h, ...res], problems, tally, { workers: 1 + W * M, skipsAllowed: true });
  return { problems, note: `${skips} skipped writes` };
}

/**
 * 5. Both writers of the state file at once, from the same eight processes and behind an
 * abandoned lock: 15 appends through mutateMeshWorkers interleaved with 15 increments of the
 * owner fields through mutateMeshOwnerFields. One lock covers both, so neither count may be
 * short — an owner write that put back a stale `workers` array would show as missing records.
 */
async function mixed(sb, i, tally) {
  const problems = [];
  await plantAbandoned(sb, i);
  const res = await writers(sb, 8, { workers: 15, owner: 15, interleave: true, csDelayMs: 1 });
  settle(sb, res, problems, tally, { workers: 120, owner: 120 });
  return { problems };
}

const SCENARIOS = {
  plain: { fn: plain, parallel: 1 },
  dead: { fn: dead, parallel: 1 },
  kill: { fn: kill, parallel: 1 },
  paused: { fn: paused, parallel: 2 },
  mixed: { fn: mixed, parallel: 1 },
};

let overloaded;
async function runScenario(name) {
  const sc = SCENARIOS[name];
  const t0 = Date.now();
  const loads = [os.loadavg()[0]];
  let next = 0;
  let done = 0;
  let failed = 0;
  let aborted = false;
  const tally = { shortRuns: 0, missing: 0, overlapRuns: 0, overlaps: 0, ownerLost: 0 };
  const reasons = new Map();
  const leftovers = new Map();
  const notes = [];
  const samples = [];
  const worker = async () => {
    for (;;) {
      const load = os.loadavg()[0];
      if (load > MAX_LOAD) {
        overloaded = load;
        aborted = true;
      }
      const i = next++;
      if (i >= RUNS || aborted) return;
      let sb;
      let result;
      try {
        sb = await makeSandbox();
        result = await sc.fn(sb, i, tally);
      } catch (e) {
        result = { problems: [`harness error: ${e.stack || e}`] };
      }
      if (sb) {
        for (const n of fs.readdirSync(sb.meshDir)) {
          if (path.join(sb.meshDir, n) === sb.state) continue;
          const kind = n.replace(/\d+/g, 'N').replace(/^[0-9a-fN]+\.json/, '<state>');
          leftovers.set(kind, (leftovers.get(kind) || 0) + 1);
        }
        destroy(sb);
      }
      done++;
      loads.push(os.loadavg()[0]);
      if (result.note && notes.length < 3) notes.push(result.note);
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
  await Promise.all(Array.from({ length: Math.min(sc.parallel, RUNS) }, worker));
  const summary = {
    scenario: name,
    runs: done,
    failed,
    runsWithRecordsMissing: tally.shortRuns,
    recordsMissing: tally.missing,
    ownerWritesLost: tally.ownerLost,
    runsWithOverlap: tally.overlapRuns,
    overlaps: tally.overlaps,
    wallSeconds: Math.round((Date.now() - t0) / 100) / 10,
    load1: { min: Math.min(...loads).toFixed(1), max: Math.max(...loads).toFixed(1), avg: (loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1) },
  };
  console.log(JSON.stringify(summary));
  if (done < RUNS) {
    console.log(
      overloaded !== undefined
        ? `  STOPPED after ${done} of ${RUNS} runs: the load average reached ${overloaded.toFixed(1)}, past --max-load ${MAX_LOAD}`
        : `  stopped after ${done} of ${RUNS} runs (--stop-on-fail)`,
    );
  }
  if (notes.length) console.log(`  e.g. ${notes.join(' / ')}`);
  if (leftovers.size) console.log(`  left in the mesh dir beside the state file (name shape: runs): ${JSON.stringify(Object.fromEntries(leftovers))}`);
  if (failed) {
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [k, n] of top) console.log(`  ${n}× ${k}`);
    for (const s of samples.slice(0, 3)) console.log(`  e.g. ${s.slice(0, 600)}`);
  }
  return failed;
}

const names = SCENARIO === 'all' ? Object.keys(SCENARIOS) : SCENARIO.split(',');
console.log(
  `pool-stress: ${names.join(', ')} × ${RUNS} runs each; at most ${MAX_PROCS} stress processes at a time; ` +
    `${LEGACY ? 'legacy plants (regular files only)' : 'plants rotate through every lock form'}${CHAOS ? `; chaos ${CHAOS.p},${CHAOS.maxMs}` : ''}; ` +
    `load now ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`,
);
let totalFailed = 0;
const tAll = Date.now();
for (const n of names) {
  if (!SCENARIOS[n]) {
    console.error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  if (overloaded !== undefined) break;
  totalFailed += await runScenario(n);
}
console.log(`TOTAL failed runs: ${totalFailed}; wall ${Math.round((Date.now() - tAll) / 1000)} s; load now ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`);
process.exit(overloaded !== undefined ? 3 : totalFailed ? 1 : 0);
