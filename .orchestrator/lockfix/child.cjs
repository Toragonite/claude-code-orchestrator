// One stress participant. Spawned by run.mjs with HOME pointing at a throwaway sandbox, so the
// registry module's data root is <sandbox>/.claude-code-orchestrator and nothing real is touched.
//
//   node child.cjs <registry bundle> '<json params>'
//
// THE INVARIANT CHECK lives here and only here — nothing in src/ knows about it. The critical
// section of updateStats / updateRegistry is [mutate callback … lock release]. This process
// marks its entry from inside the mutate callback and its exit from a wrapper around
// fs.unlinkSync that fires just BEFORE the module unlinks its own lock file. The mark is a file
// created by hard link (atomic, complete, exclusive), carrying this pid:
//
//   - entering while a mark with a LIVE pid exists  => two holders at once  => violation
//   - leaving and finding the mark is no longer ours => somebody entered meanwhile => violation
//
// A mark left by a process that was killed inside the section is not a violation: its pid is
// dead (or a zombie — checked, because a killed child is a zombie until its parent reaps it and
// kill(pid, 0) still succeeds on one).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const bundle = process.argv[2];
const params = JSON.parse(process.argv[3] || '{}');
const root = path.join(os.homedir(), '.claude-code-orchestrator');
const violationsFile = path.join(root, 'HARNESS.violations.log');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function violation(what) {
  try {
    fs.appendFileSync(violationsFile, `${Date.now()} pid=${process.pid} ${what}\n`);
  } catch {
    // the parent also sees it in our own report
  }
  report.violations.push(what);
}

/** Alive AND not a zombie. */
function reallyAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      return state !== 'Z' && state !== 'X';
    }
    const st = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return st !== '' && !st.startsWith('Z');
  } catch {
    return false; // ps exits 1 when the pid is gone
  }
}

const inside = new Map(); // tag -> marker path
function enter(tag) {
  const marker = path.join(root, `HARNESS.${tag}.inside`);
  const tmp = `${marker}.${process.pid}`;
  fs.writeFileSync(tmp, String(process.pid));
  for (let i = 0; i < 3; i++) {
    try {
      fs.linkSync(tmp, marker);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let other = NaN;
      try {
        other = parseInt(fs.readFileSync(marker, 'utf8'), 10);
      } catch {
        continue; // it left between our link and our read — try again
      }
      if (other !== process.pid && reallyAlive(other)) {
        violation(`${tag}: entered while pid ${other} was inside`);
      }
      // dead predecessor (or a violation already recorded): take the mark over
      try {
        fs.renameSync(tmp, marker);
      } catch {
        // fine
      }
      break;
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // renamed away
  }
  inside.set(tag, marker);
}
function leave(tag) {
  const marker = inside.get(tag);
  if (marker === undefined) return;
  inside.delete(tag);
  let owner = NaN;
  try {
    owner = parseInt(fs.readFileSync(marker, 'utf8'), 10);
  } catch {
    // gone
  }
  if (owner !== process.pid) {
    violation(`${tag}: our mark was replaced (now ${owner}) while we were inside`);
    return;
  }
  try {
    fs.unlinkSync(marker);
  } catch {
    // fine
  }
}

// SCHEDULE FUZZING (params.chaos = { p, maxMs }). A lock protocol is wrong if SOME interleaving
// breaks it, and the interleavings that matter are the ones where a process is descheduled
// between two of its own system calls — between reading a token and asking whether its pid is
// alive, between judging a lock and removing it. An idle machine almost never produces those;
// this does, by parking the process for a random moment before a random share of the calls the
// lock is built from. It changes WHEN things happen and nothing else, so anything it breaks,
// load can break.
function jitter() {
  const c = params.chaos;
  if (c && Math.random() < c.p) sleep(Math.random() * c.maxMs);
}
if (params.chaos) {
  for (const name of ['lstatSync', 'statSync', 'readlinkSync', 'symlinkSync', 'openSync', 'mkdirSync', 'rmdirSync', 'opendirSync', 'renameSync', 'linkSync']) {
    const real = fs[name];
    fs[name] = function chaotic(...a) {
      jitter();
      return real.apply(fs, a);
    };
  }
  const realKill = process.kill;
  process.kill = function chaoticKill(pid, sig) {
    if (sig === 0) jitter();
    return realKill.call(process, pid, sig);
  };
}

// Exit hook: the module releases by unlinking `<target>.lock`. Leave just before that.
const realUnlink = fs.unlinkSync;
fs.unlinkSync = function patchedUnlink(p, ...rest) {
  jitter();
  if (typeof p === 'string') {
    if (p.endsWith('stats.json.lock')) leave('stats');
    else if (p.endsWith('registry.json.lock')) leave('registry');
  }
  return realUnlink.call(fs, p, ...rest);
};

const report = {
  pid: process.pid,
  ok: { stats: 0, registry: 0, reaped: 0 },
  errors: [],
  violations: [],
  successAt: [],
  firstErrorAt: 0,
  maxWaitMs: 0,
};
function finish(code) {
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(code);
}

const reg = require(bundle);

if (typeof params.startAt === 'number') {
  const wait = params.startAt - Date.now();
  if (wait > 0) sleep(wait);
}

function csBody(tag) {
  enter(tag);
  if (params.signalFile && !fs.existsSync(params.signalFile)) {
    fs.writeFileSync(params.signalFile, String(process.pid));
  }
  if (params.stopInside) {
    // Freeze INSIDE the critical section until the parent sends SIGCONT.
    process.kill(process.pid, 'SIGSTOP');
  }
  if (params.selfKill && Math.random() < params.selfKill) {
    process.kill(process.pid, 'SIGKILL');
    sleep(1000); // never returns
  }
  if (params.csDelayMs) {
    sleep(Math.random() * params.csDelayMs);
  }
}

function attempt(kind) {
  const t0 = Date.now();
  try {
    if (kind === 'stats') {
      const key = params.key || 'w';
      reg.updateStats((s) => {
        csBody('stats');
        s[key] = s[key] || { tasks: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        s[key].tasks++;
      });
    } else {
      reg.updateRegistry((r) => {
        csBody('registry');
        r.lockfixCounter = (r.lockfixCounter || 0) + 1;
      });
    }
  } catch (e) {
    // The section may have been entered and then failed; make sure we are not left "inside".
    leave(kind);
    if (report.firstErrorAt === 0) report.firstErrorAt = Date.now();
    if (report.errors.length < 20) report.errors.push(String(e && e.message));
    report.errorCount = (report.errorCount || 0) + 1;
    return false;
  }
  if (inside.has(kind)) {
    // The call returned but the module never unlinked its lock: the lock was no longer ours at
    // release, i.e. somebody removed a LIVE holder's lock. That is the defect, whether or not
    // the two sections happened to overlap this time.
    violation(`${kind}: returned without releasing — the lock was taken from under us`);
    leave(kind);
  }
  report.maxWaitMs = Math.max(report.maxWaitMs, Date.now() - t0);
  report.ok[kind]++;
  if (report.successAt.length < 50) report.successAt.push(Date.now());
  return true;
}

const deadline = Date.now() + (params.budgetMs || 120_000);
function doMany(kind, n) {
  for (let i = 0; i < n; i++) {
    while (!attempt(kind)) {
      if (!params.retry || Date.now() > deadline) return;
    }
  }
}

if (params.mode === 'reap') {
  try {
    report.ok.reaped = reg.reapDeadTasks();
  } catch (e) {
    report.errors.push(String(e && e.message));
  }
  finish(0);
} else if (params.mode === 'victim') {
  // Runs until killed.
  for (;;) {
    attempt('stats');
  }
} else {
  const stats = params.stats || 0;
  const registry = params.registry || 0;
  if (params.interleave) {
    for (let i = 0; i < Math.max(stats, registry); i++) {
      if (i < stats) doMany('stats', 1);
      if (i < registry) doMany('registry', 1);
    }
  } else {
    doMany('stats', stats);
    doMany('registry', registry);
  }
  finish(report.errors.length === 0 && report.violations.length === 0 ? 0 : 3);
}
