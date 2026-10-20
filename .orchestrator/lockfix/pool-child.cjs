// One stress participant for the mesh LEDGER lock. Spawned by pool-stress.mjs with HOME pointing
// at a throwaway sandbox, so the pool module's data root is <sandbox>/.claude-code-orchestrator
// and nothing real is touched.
//
//   node pool-child.cjs <pool bundle> '<json params>'
//
// It drives the two real writers of the state file — mutateMeshWorkers (one uniquely named
// record appended per call) and mutateMeshOwnerFields (`startedAt` used as a counter, one
// increment per call) — and reports, as one JSON line, exactly which calls it was TOLD landed.
// The parent compares that with what is on disk.
//
// THE INVARIANT CHECK lives here and only here — nothing in src/ knows about it. It is the one
// child.cjs uses for the registry lock, on the ledger's lock: the critical section is
// [mutator callback … lock release]. This process marks its entry from inside the mutator and
// its exit from a wrapper around fs.unlinkSync that fires just BEFORE the module unlinks its own
// `<state>.write.lock`. The mark is a file created by hard link (atomic, complete, exclusive),
// carrying this pid:
//
//   - entering while a mark with a LIVE pid exists   => two holders at once          => violation
//   - leaving and finding the mark is no longer ours => somebody entered meanwhile   => violation
//   - the call returns and the lock was never unlinked => it was taken from under us => violation
//
// A mark left by a process that was killed inside the section is not a violation: its pid is
// dead (or a zombie — checked, because a killed child is a zombie until its parent reaps it and
// kill(pid, 0) still succeeds on one).
//
//   - the module runs our mutator TWICE in one call => it found its lock gone at release and
//     re-applied the write (pool.ts, runLedgerWrite)   => the lock was taken from under us
//                                                                                    => violation
//
// A write the module REPORTS as skipped (mutateMeshWorkers' onSkip, mutateMeshOwnerFields'
// `false`) is not an error here: it is counted, and retried when params.retry says so. Whether a
// skip was expected is the scenario's business.
//
// The append is written the way the module requires of every mutator — idempotent: the record is
// pushed only if it is not there. The owner write is a COUNTER on purpose (an increment is what
// shows a lost update), which is not idempotent; the one situation in which the module would run
// it twice is the violation above.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const bundle = process.argv[2];
const params = JSON.parse(process.argv[3] || '{}');
const root = path.join(os.homedir(), '.claude-code-orchestrator');
const violationsFile = path.join(root, 'HARNESS.violations.log');
const TAG = 'ledger';

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

const report = {
  pid: process.pid,
  /** Calls the module said landed. Record i of this process is named `<tag>-<pid>-<i>`. */
  ok: { workers: 0, owner: 0 },
  /** Calls the module said it skipped (lock not taken, or the state file unreadable). */
  skips: 0,
  skipReasons: [],
  errors: [],
  violations: [],
  successAt: [],
  maxWaitMs: 0,
};

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

let marker; // set while this process believes it is inside the section
function enter() {
  const file = path.join(root, `HARNESS.${TAG}.inside`);
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, String(process.pid));
  for (let i = 0; i < 3; i++) {
    try {
      fs.linkSync(tmp, file);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let other = NaN;
      try {
        other = parseInt(fs.readFileSync(file, 'utf8'), 10);
      } catch {
        continue; // it left between our link and our read — try again
      }
      if (other !== process.pid && reallyAlive(other)) {
        violation(`entered while pid ${other} was inside`);
      }
      // dead predecessor (or a violation already recorded): take the mark over
      try {
        fs.renameSync(tmp, file);
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
  marker = file;
}
function leave() {
  const file = marker;
  if (file === undefined) return;
  marker = undefined;
  let owner = NaN;
  try {
    owner = parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    // gone
  }
  if (owner !== process.pid) {
    violation(`our mark was replaced (now ${owner}) while we were inside`);
    return;
  }
  try {
    realUnlink.call(fs, file);
  } catch {
    // fine
  }
}

// SCHEDULE FUZZING (params.chaos = { p, maxMs }), as in child.cjs: park for a random moment
// before a random share of the system calls a lock is built from. It changes WHEN things happen
// and nothing else, so anything it breaks, load can break.
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

// Exit hook: both lock implementations release by unlinking `<state>.write.lock`. Leave just
// before that. (A breaker removing an ABANDONED lock unlinks the same name; it is not inside,
// so leave() is a no-op for it.)
const realUnlink = fs.unlinkSync;
fs.unlinkSync = function patchedUnlink(p, ...rest) {
  jitter();
  if (typeof p === 'string' && p.endsWith('.write.lock')) leave();
  return realUnlink.call(fs, p, ...rest);
};

function finish(code) {
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(code);
}

const pool = require(bundle);
const cwd = params.cwd;
const tag = params.tag || 'r';

if (typeof params.startAt === 'number') {
  const wait = params.startAt - Date.now();
  if (wait > 0) sleep(wait);
}

function csBody() {
  enter();
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

/** One call. Returns 'ok', 'skip' or 'error'. */
function attempt(kind) {
  const t0 = Date.now();
  let skipped;
  let runs = 0;
  try {
    if (kind === 'workers') {
      const name = `${tag}-${process.pid}-${report.ok.workers}`;
      pool.mutateMeshWorkers(
        cwd,
        (workers) => {
          runs++;
          csBody();
          if (!workers.some((w) => w.name === name)) {
            workers.push({ name, account: 'main', configDir: '/nowhere', jobId: 'deadbeef', model: 'opus', role: 'worker', spawnedAt: Date.now() });
          }
        },
        {
          onSkip: (why) => {
            skipped = String(why);
          },
        },
      );
    } else {
      const landed = pool.mutateMeshOwnerFields(cwd, (owner) => {
        runs++;
        csBody();
        owner.startedAt = (owner.startedAt || 0) + 1;
      });
      if (landed === false) skipped = 'mutateMeshOwnerFields returned false';
    }
  } catch (e) {
    // The section may have been entered and then failed; make sure we are not left "inside".
    leave();
    if (report.errors.length < 20) report.errors.push(String(e && e.message));
    report.errorCount = (report.errorCount || 0) + 1;
    return 'error';
  }
  if (marker !== undefined) {
    // The call returned but the module never unlinked its lock: the lock was no longer ours at
    // release, i.e. somebody removed a LIVE holder's lock. That is the defect, whether or not
    // the two sections happened to overlap this time.
    violation('returned without releasing — the lock was taken from under us');
    leave();
  }
  if (runs > 1) {
    // The 2.0 writers re-apply a write whose lock was gone at release, and the second run does
    // release — so the check above cannot see it. The second run of our mutator can.
    violation(`the mutator was run ${runs} times in one call — the lock was taken from under us and the write re-applied`);
  }
  if (skipped !== undefined) {
    report.skips++;
    // Long enough for a sandbox path AND the words after it: the scenario matches on those.
    if (report.skipReasons.length < 5) report.skipReasons.push(skipped.slice(0, 1200));
    return 'skip';
  }
  report.maxWaitMs = Math.max(report.maxWaitMs, Date.now() - t0);
  report.ok[kind]++;
  if (report.successAt.length < 50) report.successAt.push(Date.now());
  return 'ok';
}

const deadline = Date.now() + (params.budgetMs || 120_000);
function doMany(kind, n) {
  for (let i = 0; i < n; i++) {
    for (;;) {
      const r = attempt(kind);
      if (r === 'ok') break;
      if (r === 'error' || !params.retry || Date.now() > deadline) return false;
    }
  }
  return true;
}

if (params.mode === 'touch') {
  // Create the state file so the parent can find its name; nothing is appended.
  pool.mutateMeshWorkers(cwd, () => {});
  finish(0);
} else if (params.mode === 'victim') {
  // Runs until killed.
  for (;;) {
    attempt('workers');
  }
} else {
  const workers = params.workers || 0;
  const owner = params.owner || 0;
  if (params.interleave) {
    for (let i = 0; i < Math.max(workers, owner); i++) {
      if (i < workers && !doMany('workers', 1)) break;
      if (i < owner && !doMany('owner', 1)) break;
    }
  } else {
    doMany('workers', workers) && doMany('owner', owner);
  }
  finish(report.errors.length === 0 && report.violations.length === 0 ? 0 : 3);
}
