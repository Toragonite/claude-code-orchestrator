// What the two ledger writers of src/mesh/pool.ts REPORT for each thing the write lock can do —
// the classification every caller's behaviour rests on (pool.ts, underLedgerLock). One process,
// deterministic, no contention: pool-stress.mjs is the concurrency harness, this is the table.
//
//   node pool-outcomes.mjs <scratch dir>            # bundles the live src/mesh/pool.ts
//   node pool-outcomes.mjs <scratch dir> --quick    # skips the two cases that wait 15 s twice
//
// Runs in a throwaway HOME; the real ~/.claude-code-orchestrator is never opened. Each case uses
// its own workspace path, i.e. its own state file. Prints PASS/FAIL per case and exits 1 on any
// FAIL.
import keychainGuard from '../fixes/keychain-guard.cjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);

if (process.env.POOL_OUTCOMES_BUNDLE === undefined) {
  // Parent: build, then run the cases in a child whose HOME is a sandbox (the module reads its
  // data root from the home directory when it is loaded). The child inherits
  // AGENT_CLI_CREDENTIAL_STORE=memory, the keychain guard and its log from process.env; the run
  // FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
  keychainGuard.harness('pool-outcomes');
  const scratch = path.resolve(process.argv[2] || '');
  if (!process.argv[2]) {
    console.error('usage: node pool-outcomes.mjs <scratch dir> [--quick]');
    process.exit(2);
  }
  const bundle = path.join(scratch, 'pool-outcomes', 'pool.cjs');
  const require = createRequire(path.join(REPO, 'package.json'));
  await require('esbuild').build({
    entryPoints: [path.join(REPO, 'src', 'mesh', 'pool.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
  });
  const home = fs.mkdtempSync(path.join(process.env.LOCKFIX_TMP || os.tmpdir(), 'cco-pooloutcomes-'));
  const res = spawnSync(process.execPath, [SELF, ...process.argv.slice(3)], {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, POOL_OUTCOMES_BUNDLE: bundle },
  });
  try {
    for (const dir of [path.join(home, '.claude-code-orchestrator', 'mesh')]) fs.chmodSync(dir, 0o700);
  } catch {
    // never created
  }
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(res.status ?? 1);
}

// ------------------------------------------------------------------------------------------
// Child: the cases.
// ------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const pool = require(process.env.POOL_OUTCOMES_BUNDLE);
const QUICK = process.argv.includes('--quick');
const meshDir = path.join(os.homedir(), '.claude-code-orchestrator', 'mesh');
let failed = 0;
let n = 0;

const record = (name) => ({ name, account: 'main', configDir: '/nowhere', jobId: 'deadbeef', model: 'opus', role: 'worker', spawnedAt: Date.now() });
/** A fresh workspace with an existing ledger; returns its paths. */
function ledger() {
  const cwd = path.join(os.homedir(), `ws-${++n}`);
  const before = new Set(fs.existsSync(meshDir) ? fs.readdirSync(meshDir) : []);
  pool.mutateMeshWorkers(cwd, () => {});
  const name = fs.readdirSync(meshDir).find((f) => /^[0-9a-f]+\.json$/.test(f) && !before.has(f));
  const state = path.join(meshDir, name);
  return { cwd, state, lock: `${state}.write.lock` };
}
const names = (l) => JSON.parse(fs.readFileSync(l.state, 'utf8')).workers.map((w) => w.name);
const lockText = (p) => {
  try {
    return fs.readlinkSync(p);
  } catch (e) {
    return e.code === 'ENOENT' ? undefined : `(not a link: ${e.code})`;
  }
};
function check(title, problems, note = '') {
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'} — ${title}${problems.length ? `: ${problems.join(' | ')}` : note ? `: ${note}` : ''}`);
}
const want = (problems, cond, what, got) => {
  if (!cond) problems.push(`expected ${what}; observed ${JSON.stringify(got)}`);
};
/** A token for a lock held by THIS process: alive, and running since before the claim. */
const liveToken = () => `${process.pid} ${Date.now()} outcomes 0 -`;
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// 1. the plain write
{
  const l = ledger();
  const p = [];
  const skips = [];
  const out = pool.mutateMeshWorkers(l.cwd, (w) => w.push(record('a')), { onSkip: (r) => skips.push(r) });
  want(p, out && out.written === true && out.skipped === undefined && out.contested === undefined, '{ written: true }', out);
  want(p, names(l).join() === 'a' && skips.length === 0 && lockText(l.lock) === undefined, 'the record on disk, no skip, no lock left', { names: names(l), skips, lock: lockText(l.lock) });
  check('a plain write reports written', p);
}

// 2. an abandoned lock (dead holder) is cleared and the write lands
for (const form of ['file', 'link']) {
  const l = ledger();
  const p = [];
  const token = `${deadPid()} ${Date.now()} zzz`;
  if (form === 'file') fs.writeFileSync(l.lock, token);
  else fs.symlinkSync(`${token} 0 -`, l.lock);
  const t0 = Date.now();
  const out = pool.mutateMeshWorkers(l.cwd, (w) => w.push(record('a')));
  want(p, out.written === true && names(l).join() === 'a', 'written past the abandoned lock', { out, names: names(l) });
  want(p, Date.now() - t0 < 5000 && lockText(l.lock) === undefined, 'promptly, with no lock left', { ms: Date.now() - t0, lock: lockText(l.lock) });
  check(`an abandoned lock (${form}) is cleared and the write lands`, p, `${Date.now() - t0} ms`);
}

// 3. the lock is taken away while the section runs, and what replaced it is nobody's: the write
//    is RE-APPLIED once against a fresh read, and then it is simply written
{
  const l = ledger();
  const p = [];
  const skips = [];
  let runs = 0;
  let seenOnSecondRun;
  const out = pool.mutateMeshWorkers(
    l.cwd,
    (w) => {
      runs++;
      if (runs === 1) {
        // What a pre-2.0 process breaking by deadline, or a person, does to a live holder — and
        // then it dies, leaving its own lock behind.
        fs.unlinkSync(l.lock);
        fs.symlinkSync(`${deadPid()} ${Date.now()} usurper 0 -`, l.lock);
      } else {
        seenOnSecondRun = w.map((r) => r.name).join();
      }
      if (!w.some((r) => r.name === 'a')) w.push(record('a'));
    },
    { onSkip: (r) => skips.push(r) },
  );
  want(p, runs === 2, 'the mutator run twice (the write re-applied once)', runs);
  want(p, seenOnSecondRun === 'a', "the second run to see the first run's write in a FRESH read", seenOnSecondRun);
  want(p, out.written === true && out.contested === undefined && out.skipped === undefined && skips.length === 0, '{ written: true } — settled by the re-apply, nothing to report', { out, skips });
  want(p, names(l).join() === 'a' && lockText(l.lock) === undefined, 'the record on disk exactly once, no lock left', { names: names(l), lock: lockText(l.lock) });
  let ownerRuns = 0;
  const owner = pool.mutateMeshOwnerFields(l.cwd, (o) => {
    if (++ownerRuns === 1) {
      fs.unlinkSync(l.lock);
      fs.symlinkSync(`${deadPid()} ${Date.now()} usurper 0 -`, l.lock);
    }
    o.ownerPid = 4242;
  });
  want(p, owner === true && ownerRuns === 2 && JSON.parse(fs.readFileSync(l.state, 'utf8')).ownerPid === 4242, 'mutateMeshOwnerFields → true after its own re-apply, with the field written', { owner, ownerRuns });
  want(p, names(l).join() === 'a', 'the workers array untouched by the owner write', names(l));
  check('a lock removed mid-section: the write is re-applied once and stands', p);
}

// 3b. the same, but what replaced the lock is a LIVE holder that keeps it: the re-apply cannot
//     run, and the write is reported contested — on disk, not vouched for, and never "failed"
if (QUICK) {
  console.log('SKIP — a lock removed mid-section and held by its usurper (--quick: it waits 15 s twice)');
} else {
  const l = ledger();
  const p = [];
  const usurper = liveToken();
  const skips = [];
  let runs = 0;
  const out = pool.mutateMeshWorkers(
    l.cwd,
    (w) => {
      runs++;
      fs.unlinkSync(l.lock);
      fs.symlinkSync(usurper, l.lock);
      if (!w.some((r) => r.name === 'a')) w.push(record('a'));
    },
    { onSkip: (r) => skips.push(r) },
  );
  want(p, runs === 1, 'the mutator NOT run a second time (the lock is held)', runs);
  want(p, out.written === true && typeof out.contested === 'string' && /removed by another process/.test(out.contested) && /could not be re-applied/.test(out.contested), '{ written: true, contested: "… removed by another process … could not be re-applied …" }', out);
  want(p, out.skipped === undefined && skips.length === 0, 'NOT reported as skipped', { out, skips });
  want(p, names(l).join() === 'a', 'the record on disk', names(l));
  want(p, lockText(l.lock) === usurper, "the lock that replaced ours left alone (it is somebody else's)", lockText(l.lock));
  const reasons = [];
  let ownerRuns = 0;
  fs.unlinkSync(l.lock);
  const owner = pool.mutateMeshOwnerFields(
    l.cwd,
    (o) => {
      ownerRuns++;
      fs.unlinkSync(l.lock);
      fs.symlinkSync(usurper, l.lock);
      o.ownerPid = 4242;
    },
    { onSkip: (r) => reasons.push(r) },
  );
  want(p, owner === false && ownerRuns === 1 && reasons.length === 1 && /removed by another process/.test(reasons[0]), 'mutateMeshOwnerFields → false (a claim nothing can vouch for), with the reason through onSkip', { owner, ownerRuns, reasons });
  fs.unlinkSync(l.lock);
  check('a lock removed mid-section and kept by its usurper: reported contested, not failed', p);
}

// 4. the mutator throws: the throw comes through, and the lock is released
{
  const l = ledger();
  const p = [];
  let thrown;
  try {
    pool.mutateMeshWorkers(l.cwd, () => {
      throw new Error('mutator blew up');
    });
  } catch (e) {
    thrown = e;
  }
  want(p, thrown instanceof Error && thrown.message === 'mutator blew up', "the mutator's own error, unchanged", thrown && thrown.message);
  want(p, lockText(l.lock) === undefined && names(l).length === 0, 'the lock released and nothing written', { lock: lockText(l.lock), names: names(l) });
  check("a mutator's throw propagates unchanged", p);
}

// 5. a state file whose bytes cannot be read: skipped, never rewritten
{
  const l = ledger();
  const p = [];
  fs.rmSync(l.state);
  fs.mkdirSync(l.state); // something IS there, and it is not a file
  const skips = [];
  let ran = false;
  const out = pool.mutateMeshWorkers(l.cwd, () => (ran = true), { onSkip: (r) => skips.push(r) });
  want(p, out.written === false && /could not be READ/.test(out.skipped ?? ''), '{ written: false, skipped: "… could not be READ …" }', out);
  want(p, !ran && skips.length === 1 && skips[0] === out.skipped, 'the mutator NOT run, and onSkip called once with the same sentence', { ran, skips });
  want(p, fs.statSync(l.state).isDirectory() && lockText(l.lock) === undefined, 'the thing at the state path untouched and the lock released', lockText(l.lock));
  const reasons = [];
  const owner = pool.mutateMeshOwnerFields(l.cwd, (o) => (o.ownerPid = 1), { onSkip: (r) => reasons.push(r) });
  want(p, owner === false && reasons.length === 1 && /could not be READ/.test(reasons[0]), 'mutateMeshOwnerFields → false, with the reason through onSkip', { owner, reasons });
  check('an unreadable state file is a skip, reported with its reason', p);
}

// 6. a lock that cannot be created at all
{
  const l = ledger();
  const p = [];
  fs.chmodSync(meshDir, 0o500);
  let writable = true;
  try {
    fs.writeFileSync(path.join(meshDir, 'probe'), '');
    fs.unlinkSync(path.join(meshDir, 'probe'));
  } catch {
    writable = false;
  }
  if (writable) {
    fs.chmodSync(meshDir, 0o700);
    console.log('SKIP — a lock that cannot be created: this user can write a mode-500 directory');
  } else {
    const t0 = Date.now();
    const out = pool.mutateMeshWorkers(l.cwd, (w) => w.push(record('a')));
    const owner = pool.mutateMeshOwnerFields(l.cwd, (o) => (o.ownerPid = 1));
    fs.chmodSync(meshDir, 0o700);
    want(p, out.written === false && /could not be taken \(E[A-Z]+: /.test(out.skipped ?? ''), '{ written: false, skipped: "… could not be taken (<errno>: …" }', out);
    want(p, owner === false, 'mutateMeshOwnerFields → false', owner);
    want(p, Date.now() - t0 < 3000 && names(l).length === 0, 'at once (no 15 s wait), nothing written', { ms: Date.now() - t0 });
    check('a lock that cannot be created is a skip, at once', p);
  }
}

// 7. a lock held by a LIVE process for the whole wait: skipped after 15 s, lock untouched
if (QUICK) {
  console.log('SKIP — a lock held by a live process (--quick: it waits 15 s twice)');
} else {
  const l = ledger();
  const p = [];
  const token = liveToken();
  fs.symlinkSync(token, l.lock);
  let ran = false;
  const t0 = Date.now();
  const out = pool.mutateMeshWorkers(l.cwd, () => (ran = true));
  const waited = Date.now() - t0;
  want(p, out.written === false && out.contested === undefined, '{ written: false }', out);
  want(p, /could not be taken \(Could not lock /.test(out.skipped ?? '') && (out.skipped ?? '').includes(`process ${process.pid}`) && (out.skipped ?? '').includes(l.lock), "the lock's own message whole inside the reason: the holder's pid and the lock file", out.skipped);
  want(p, !ran && waited >= 14_000 && waited < 25_000, 'the mutator NOT run, after the 15 s wait', { ran, waited });
  want(p, lockText(l.lock) === token, "the live holder's lock untouched", lockText(l.lock));
  const reasons = [];
  const owner = pool.mutateMeshOwnerFields(l.cwd, (o) => (o.ownerPid = 1), { onSkip: (r) => reasons.push(r) });
  want(p, owner === false && reasons.length === 1 && reasons[0].includes(l.lock), 'mutateMeshOwnerFields → false, with the reason through onSkip', { owner, reasons });
  want(p, lockText(l.lock) === token && names(l).length === 0, 'still untouched, nothing written', lockText(l.lock));
  fs.unlinkSync(l.lock);
  const after = pool.mutateMeshWorkers(l.cwd, (w) => w.push(record('a')));
  want(p, after.written === true && names(l).join() === 'a', 'the next write to land once the lock is released', after);
  check('a lock held by a live process is never broken: both writers skip after the wait', p, `${waited} ms`);
}

console.log(failed ? `${failed} case(s) FAILED` : 'all cases passed');
process.exit(failed ? 1 : 0);
