// litter.mjs — offline checks of src/sessionLitter.ts for the 2.0 fix wave (contract-2.0-fixes §2.7).
//
//   node .orchestrator/fixes/litter.mjs                 every check, against the live src/
//   node .orchestrator/fixes/litter.mjs --only socket   only checks whose name contains "socket"
//   node .orchestrator/fixes/litter.mjs --src <dir>     bundle <dir>/sessionLitter.ts instead (a
//                                                       snapshot — to show the checks FAIL on the
//                                                       code before the fixes)
//   node .orchestrator/fixes/litter.mjs --bench         ALSO build the two large fixtures the
//                                                       module header quotes numbers from, and
//                                                       print the numbers (about a minute, and
//                                                       ~150,000 small files in the temp dir)
//
// Everything lives in a fresh directory under the system temp dir and is removed at the end.
// The "sessions" directories are fixtures: no real account directory is read. The only processes
// started are `node` children that sleep, or that listen on a unix socket inside the fixture.
// Every connect the module makes is counted, by wrapping `net.connect` in this process.
import keychainGuard from './keychain-guard.cjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-litter', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');
const net = require('net');

const argv = process.argv.slice(2);
function opt(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const SRC = path.resolve(opt('--src', path.join(REPO, 'src')));
const ONLY = opt('--only');
const BENCH = argv.includes('--bench');

if (process.platform === 'win32') {
  console.log('SKIP litter.mjs — unix sockets, FIFOs and symlinks are what this exercises');
  process.exit(0);
}

// A unix socket address holds about 100 bytes, so the fixture needs a SHORT directory.
const tmpBase = os.tmpdir().length <= 70 ? os.tmpdir() : '/tmp';
const WORK = fs.mkdtempSync(path.join(tmpBase, 'ccl-'));
const BUNDLE = path.join(WORK, 'sessionLitter.cjs');
await esbuild.build({
  entryPoints: [path.join(SRC, 'sessionLitter.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: BUNDLE,
  logLevel: 'warning',
});

// Count every connect attempt the module makes, and where to.
const connects = [];
const realConnect = net.connect;
net.connect = function countedConnect(...args) {
  connects.push(args[0] && typeof args[0] === 'object' ? args[0].path : args[0]);
  return realConnect.apply(this, args);
};
const { pruneSessionLitter, pruneAllSessionLitter } = require(BUNDLE);

// ---- plumbing ------------------------------------------------------------------------------

const tally = { pass: 0, fail: 0 };
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) {
    return;
  }
  try {
    await fn();
    tally.pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    tally.fail++;
    console.log(`FAIL ${name} — ${String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX = 'a'.repeat(64);
/** The cwd a fixture probe "ran in". Passed as `tmpDirs`, so the real temp dir is not involved. */
const PROBE_CWD = '/fixture/probe-tmp';
const OPTS = { tmpDirs: [PROBE_CWD] };
const MINUTES = 60_000;
const OLD = 11 * MINUTES; // past the 10-minute age floor
const VERY_OLD = 25 * 60 * MINUTES; // past the 24-hour orphan-key floor

let seq = 0;
function account() {
  const dir = path.join(WORK, `acct${++seq}`);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}
function put(cfg, name, body, ageMs = OLD) {
  const file = path.join(cfg, 'sessions', name);
  fs.writeFileSync(file, body);
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return file;
}
const signature = (pid, extra = {}) =>
  JSON.stringify({ pid, sessionId: '11111111-2222-3333-4444-555555555555', kind: 'interactive', entrypoint: 'sdk-cli', cwd: PROBE_CWD, ...extra });
/** A pid that named a process a moment ago and names none now. */
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(Number.isInteger(done.pid) && done.pid > 1, 'could not make a dead pid');
  assert.throws(() => process.kill(done.pid, 0), { code: 'ESRCH' }, 'the "dead" pid is alive');
  return done.pid;
}
const exists = (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

// A process that is ALIVE for the whole run and plays "a session".
const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
await sleep(200);
const LIVE = live.pid;
process.kill(LIVE, 0);

/**
 * A stale socket file named for a dead process: a child listens on `<dir>/<its pid>.sock` and
 * is SIGKILLed, which is exactly how a session leaves one behind. Returns the pid and the path.
 */
async function staleSocket(dir, nameFor = (pid) => `${pid}.sock`) {
  const child = spawn(
    process.execPath,
    ['-e', `const net=require('net');const p=require('path').join(process.argv[1],(${nameFor.toString()})(process.pid));net.createServer(()=>{}).listen(p,()=>console.log(p));`, dir],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const sock = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        resolve(out.trim());
      }
    });
    child.on('exit', () => reject(new Error('the socket child exited before listening')));
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.ok(fs.lstatSync(sock).isSocket(), 'fixture: no stale socket file was left');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return { pid: child.pid, sock };
}
function sockDir() {
  const dir = path.join(WORK, `s${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}

// ---- (1) the process must be gone, for every rule -------------------------------------------

const LIVE_CASES = {
  'a  zero-byte entry': () => '',
  'b1 sdk-cli, no messagingSocketPath': (pid) => signature(pid),
  'b1 claude-vscode, no socket': (pid) => signature(pid, { entrypoint: 'claude-vscode' }),
  'b1 messagingSocketPath: null': (pid) => signature(pid, { messagingSocketPath: null }),
  'b1 entry without a pid field': () => JSON.stringify({ kind: 'interactive', entrypoint: 'sdk-cli', cwd: PROBE_CWD }),
  'b2 socket path that does not exist': (pid) => signature(pid, { messagingSocketPath: path.join(WORK, 'nowhere', `${pid}.sock`) }),
};

for (const [label, body] of Object.entries(LIVE_CASES)) {
  await check(`live pid is kept — ${label} (real run and dry run)`, async () => {
    for (const dryRun of [true, false]) {
      const cfg = account();
      const entry = put(cfg, `${LIVE}.json`, body(LIVE));
      const key = put(cfg, `${LIVE}.${HEX}.key`, 'k');
      const before = connects.length;
      const report = await pruneSessionLitter(cfg, { ...OPTS, dryRun });
      assert.equal(report.removed, 0, `${dryRun ? 'dry' : 'real'} run counted ${report.removed} removals for a live process`);
      assert.ok(exists(entry), `${dryRun ? 'dry' : 'real'} run removed the entry of a live process`);
      assert.ok(exists(key), `${dryRun ? 'dry' : 'real'} run removed the key of a live process`);
      assert.equal(connects.length, before, 'a connect was made for a live process');
      assert.equal(report.errors, 0);
    }
  });
  await check(`dead pid is removed — ${label} (dry run counts, real run unlinks)`, async () => {
    const pid = deadPid();
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, body(pid));
    const key = put(cfg, `${pid}.${HEX}.key`, 'k');
    const dry = await pruneSessionLitter(cfg, { ...OPTS, dryRun: true });
    assert.equal(dry.removed, 2, `dry run: ${JSON.stringify(dry)}`);
    assert.ok(exists(entry) && exists(key), 'a dry run unlinked something');
    const real = await pruneSessionLitter(cfg, OPTS);
    assert.equal(real.removed, 2, `real run: ${JSON.stringify(real)}`);
    assert.ok(!exists(entry) && !exists(key), 'litter of a dead process was left behind');
    assert.equal(real.errors, 0);
  });
}

await check('an orphan key older than 24 h: kept while its pid is alive, removed once it is gone', async () => {
  const cfg = account();
  const liveKey = put(cfg, `${LIVE}.${HEX}.key`, 'k', VERY_OLD);
  const gone = deadPid();
  const deadKey = put(cfg, `${gone}.${HEX}.key`, 'k', VERY_OLD);
  const youngKey = put(cfg, `${deadPid()}.${HEX}.key`, 'k', OLD);
  const report = await pruneSessionLitter(cfg, OPTS);
  assert.ok(exists(liveKey), 'the orphan key of a live pid was removed');
  assert.ok(!exists(deadKey), 'the orphan key of a dead pid was kept');
  assert.ok(exists(youngKey), 'an orphan key younger than 24 h was removed');
  assert.equal(report.removed, 1);
});

// ---- (2) names whose pid is not understood --------------------------------------------------

await check('a name whose pid is not understood keeps the file (0, 1, 4194305, 007, non-digits)', async () => {
  const cfg = account();
  const kept = [];
  for (const stem of ['0', '1', '4194305', '2147483647', '007', '00', '0123', '99999999999', 'abc', '12a', '-5', '+5', '1e3', '5.0', ' 5', '']) {
    kept.push(put(cfg, `${stem}.json`, ''));
    kept.push(put(cfg, `${stem}.${HEX}.key`, 'k', VERY_OLD));
  }
  // A signature entry under an odd name, and near-miss names.
  kept.push(put(cfg, '0042.json', signature(42)));
  for (const name of [`${deadPid()}.json.bak`, `${deadPid()}.JSON`, `x${deadPid()}.json`, `${deadPid()}.${'A'.repeat(64)}.key`, `${deadPid()}.${'a'.repeat(63)}.key`, 'notes.txt']) {
    kept.push(put(cfg, name, ''));
  }
  for (const dryRun of [true, false]) {
    const report = await pruneSessionLitter(cfg, { ...OPTS, dryRun });
    assert.equal(report.removed, 0, `${dryRun ? 'dry' : 'real'} run: ${report.removed} removals`);
    assert.equal(report.errors, 0);
  }
  for (const file of kept) {
    assert.ok(exists(file), `removed: ${path.basename(file)}`);
  }
  // The largest pid a name may stand for IS understood (and is dead on any machine that does
  // not issue pids that high; skipped where it happens to be alive).
  try {
    process.kill(4194304, 0);
  } catch (err) {
    if (err.code === 'ESRCH') {
      const top = put(cfg, '4194304.json', '');
      await pruneSessionLitter(cfg, OPTS);
      assert.ok(!exists(top), '4194304.json (a dead pid, in range) was kept');
    }
  }
});

// ---- (3)(4)(5) the socket rule ---------------------------------------------------------------

await check('socket: a LISTENING socket under another name is never connected to, and the entry is kept', async () => {
  const dir = sockDir();
  let accepted = 0;
  const servers = [];
  const listen = async (name) => {
    const server = net.createServer((c) => {
      accepted++;
      c.destroy();
    });
    await new Promise((resolve) => server.listen(path.join(dir, name), resolve));
    servers.push(server);
    return path.join(dir, name);
  };
  try {
    const pid = deadPid();
    const cases = [await listen('unrelated.sock'), await listen(`${pid + 1}.sock`), await listen(`${pid}.sock.bak`), await listen(`x${pid}.sock`)];
    for (const sock of cases) {
      for (const dryRun of [true, false]) {
        const cfg = account();
        const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: sock }));
        const before = connects.length;
        const report = await pruneSessionLitter(cfg, { ...OPTS, dryRun });
        await sleep(50);
        assert.equal(connects.length, before, `a connect was made to ${path.basename(sock)}`);
        assert.equal(accepted, 0, `the unrelated listener at ${path.basename(sock)} received a connection`);
        assert.equal(report.removed, 0);
        assert.ok(exists(entry), `the entry naming ${path.basename(sock)} was removed`);
      }
    }
  } finally {
    for (const server of servers) {
      server.close();
    }
  }
});

await check('socket: <pid>.sock left behind by a SIGKILLed process (nobody listening) — the entry is removed', async () => {
  const dir = sockDir();
  const { pid, sock } = await staleSocket(dir);
  const cfg = account();
  const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: sock }));
  const key = put(cfg, `${pid}.${HEX}.key`, 'k');
  const before = connects.length;
  const dry = await pruneSessionLitter(cfg, { ...OPTS, dryRun: true });
  assert.equal(dry.removed, 2);
  assert.ok(exists(entry));
  const real = await pruneSessionLitter(cfg, OPTS);
  assert.equal(real.removed, 2, JSON.stringify(real));
  assert.ok(!exists(entry) && !exists(key));
  assert.deepEqual(connects.slice(before), [sock, sock], 'expected exactly one connect per pass, to <pid>.sock');
  assert.ok(fs.lstatSync(sock).isSocket(), 'the socket file itself must never be touched');
});

await check('socket: <pid>.sock with somebody LISTENING keeps the entry (one connect, nothing sent)', async () => {
  const dir = sockDir();
  const pid = deadPid();
  const sock = path.join(dir, `${pid}.sock`);
  let accepted = 0;
  let bytes = 0;
  const server = net.createServer((c) => {
    accepted++;
    c.on('data', (d) => {
      bytes += d.length;
    });
    c.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: sock }));
    const report = await pruneSessionLitter(cfg, OPTS);
    await sleep(100);
    assert.equal(report.removed, 0);
    assert.ok(exists(entry), 'an entry whose socket has a listener was removed');
    assert.equal(accepted, 1);
    assert.equal(bytes, 0, 'the probe wrote to the socket');
  } finally {
    server.close();
  }
});

await check('socket: a path where nothing exists — removed WITHOUT a connect', async () => {
  const dir = sockDir();
  for (const name of [(pid) => `${pid}.sock`, () => 'whatever.sock', () => 'no-extension']) {
    const pid = deadPid();
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: path.join(dir, name(pid)) }));
    const before = connects.length;
    const report = await pruneSessionLitter(cfg, OPTS);
    assert.equal(report.removed, 1, JSON.stringify(report));
    assert.ok(!exists(entry));
    assert.equal(connects.length, before, `a connect was made to a path where nothing exists (${name(pid)})`);
  }
});

await check('socket: a path that is not a socket, or cannot be one, keeps the entry and is never connected to', async () => {
  const dir = sockDir();
  const stale = await staleSocket(sockDir());
  const pid = deadPid();
  const regular = path.join(dir, `${pid}.sock`);
  fs.writeFileSync(regular, 'not a socket');
  const directory = path.join(sockDir(), `${pid}.sock`);
  fs.mkdirSync(directory);
  const link = path.join(sockDir(), `${pid}.sock`);
  fs.symlinkSync(stale.sock, link);
  const fifo = path.join(sockDir(), `${pid}.sock`);
  spawnSync('mkfifo', [fifo]);
  const underFile = path.join(regular, `${pid}.sock`); // ENOTDIR, not ENOENT
  const paths = {
    'a regular file': regular,
    'a directory': directory,
    'a symlink to a stale socket': link,
    'a FIFO': fifo,
    'a path under a regular file (ENOTDIR)': underFile,
    'a relative path': `relative/${pid}.sock`,
    'a path holding a NUL': `${dir}/\u0000/${pid}.sock`,
    'a path longer than a socket address': `/${'x'.repeat(200)}/${pid}.sock`,
    'an empty string': '',
  };
  for (const [label, socketPath] of Object.entries(paths)) {
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: socketPath }));
    const before = connects.length;
    const report = await pruneSessionLitter(cfg, OPTS);
    assert.equal(report.removed, 0, `${label}: removed`);
    assert.ok(exists(entry), `${label}: the entry was removed`);
    assert.equal(connects.length, before, `${label}: a connect was made`);
  }
  // Shapes of the field this code does not know.
  for (const value of [42, true, {}, ['/x'], 0]) {
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, signature(pid, { messagingSocketPath: value }));
    assert.equal((await pruneSessionLitter(cfg, OPTS)).removed, 0);
    assert.ok(exists(entry), `messagingSocketPath ${JSON.stringify(value)}: removed`);
  }
});

// ---- (6) the guards that were already there --------------------------------------------------

await check('guards: an entry that is not a leaked probe\'s is kept whatever its pid', async () => {
  const pid = deadPid();
  const bodies = {
    'kind bg': signature(pid, { kind: 'bg' }),
    'another entrypoint': signature(pid, { entrypoint: 'cli' }),
    'a cwd that is not the probe tmp dir': signature(pid, { cwd: '/Users/someone/project' }),
    'ccoMirror present': signature(pid, { ccoMirror: false }),
    'pid field of another process (b1)': signature(pid + 1),
    'pid field of another process (b2)': signature(pid + 1, { messagingSocketPath: path.join(WORK, 'nowhere', `${pid}.sock`) }),
    'pid field that is a string': signature(String(pid)),
    'pid field null': signature(null),
    'socket path but no pid field': JSON.stringify({ kind: 'interactive', entrypoint: 'sdk-cli', cwd: PROBE_CWD, messagingSocketPath: path.join(WORK, 'nowhere', `${pid}.sock`) }),
    'not JSON': '{ this is not json',
    'a JSON array': '[1,2,3]',
    'a JSON null': 'null',
    'larger than 64 KiB': signature(pid, { pad: 'x'.repeat(70 * 1024) }),
  };
  for (const [label, body] of Object.entries(bodies)) {
    const cfg = account();
    const entry = put(cfg, `${pid}.json`, body);
    const key = put(cfg, `${pid}.${HEX}.key`, 'k', VERY_OLD);
    const report = await pruneSessionLitter(cfg, OPTS);
    assert.equal(report.removed, 0, `${label}: ${report.removed} removed`);
    assert.ok(exists(entry) && exists(key), `${label}: something was removed`);
  }
});

await check('guards: the age floor, symlinks, non-files and a symlinked sessions directory', async () => {
  const pid = deadPid();
  // Younger than the age floor.
  let cfg = account();
  const young = put(cfg, `${pid}.json`, '', 60_000);
  const youngKey = put(cfg, `${pid}.${HEX}.key`, 'k', 60_000);
  assert.equal((await pruneSessionLitter(cfg, OPTS)).removed, 0);
  assert.ok(exists(young) && exists(youngKey), 'a file younger than the age floor was removed');
  // A future mtime is not "old".
  const future = put(cfg, `${deadPid()}.json`, '', -3_600_000);
  assert.equal((await pruneSessionLitter(cfg, OPTS)).removed, 0);
  assert.ok(exists(future));
  // A symlink named like an entry, pointing at real litter elsewhere: neither is removed.
  cfg = account();
  const target = path.join(WORK, `target-${pid}.json`);
  fs.writeFileSync(target, '');
  const when = (Date.now() - OLD) / 1000;
  fs.utimesSync(target, when, when);
  const link = path.join(cfg, 'sessions', `${pid}.json`);
  fs.symlinkSync(target, link);
  const dirEntry = path.join(cfg, 'sessions', `${deadPid()}.json`);
  fs.mkdirSync(dirEntry);
  const fifoEntry = path.join(cfg, 'sessions', `${deadPid()}.json`);
  spawnSync('mkfifo', [fifoEntry]);
  const report = await pruneSessionLitter(cfg, OPTS);
  assert.equal(report.removed, 0);
  assert.ok(exists(link) && exists(target) && exists(dirEntry) && exists(fifoEntry), 'a symlink, its target, a directory or a FIFO was removed');
  // sessions/ itself is a symlink to a directory full of litter.
  const realSessions = account();
  const litter = put(realSessions, `${pid}.json`, '');
  const linked = path.join(WORK, `acct-linked-${pid}`);
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(realSessions, 'sessions'), path.join(linked, 'sessions'));
  const viaLink = await pruneSessionLitter(linked, OPTS);
  assert.deepEqual([viaLink.scanned, viaLink.removed], [0, 0]);
  assert.ok(exists(litter), 'litter behind a symlinked sessions directory was removed');
});

await check('guards: a key follows its entry — kept with a kept entry, removed with a removed one', async () => {
  const gone = deadPid();
  const cfg = account();
  const keptEntry = put(cfg, `${gone}.json`, signature(gone, { kind: 'bg' }));
  const keptKey = put(cfg, `${gone}.${HEX}.key`, 'k', VERY_OLD);
  const gone2 = deadPid();
  put(cfg, `${gone2}.json`, '');
  const goneKey = put(cfg, `${gone2}.${HEX}.key`, 'k');
  const gone2Key2 = put(cfg, `${gone2}.${'b'.repeat(64)}.key`, 'k');
  const report = await pruneSessionLitter(cfg, OPTS);
  assert.ok(exists(keptEntry) && exists(keptKey), 'the key of a kept entry was removed');
  assert.ok(!exists(goneKey) && !exists(gone2Key2), 'the keys of a removed entry were kept');
  assert.equal(report.removed, 3);
});

await check('guards: arguments that are not a config directory are refused; nothing is ever thrown', async () => {
  for (const bad of [undefined, null, 7, {}, '', 'relative/dir', `${WORK}/\u0000x`]) {
    const report = await pruneSessionLitter(bad, OPTS);
    assert.deepEqual([report.scanned, report.removed, report.errors], [0, 0, 1], `configDir ${JSON.stringify(String(bad))}`);
  }
  const missing = await pruneSessionLitter(path.join(WORK, 'no-such-account'), OPTS);
  assert.deepEqual([missing.scanned, missing.removed, missing.errors], [0, 0, 0]);
  assert.deepEqual(await pruneAllSessionLitter('not an array', OPTS), []);
  // Options of the wrong type fall back to the defaults instead of removing more.
  const pid = deadPid();
  const cfg = account();
  const young = put(cfg, `${pid}.json`, '', 60_000);
  for (const opts of [{ ...OPTS, minAgeMs: -1 }, { ...OPTS, minAgeMs: NaN }, { ...OPTS, minAgeMs: '0' }, null, 7, 'x']) {
    await pruneSessionLitter(cfg, opts);
    assert.ok(exists(young), `options ${JSON.stringify(opts)} removed a young file`);
  }
  // An empty tmpDirs list switches rule (b) off; rule (a) still applies.
  const cfg2 = account();
  const b1 = put(cfg2, `${pid}.json`, signature(pid));
  const pid2 = deadPid();
  const a = put(cfg2, `${pid2}.json`, '');
  await pruneSessionLitter(cfg2, { tmpDirs: [] });
  assert.ok(exists(b1) && !exists(a));
});

await check('the default tmpDirs is the real path of the system temp dir', async () => {
  const pid = deadPid();
  const cfg = account();
  const here = put(cfg, `${pid}.json`, JSON.stringify({ pid, kind: 'interactive', entrypoint: 'sdk-cli', cwd: fs.realpathSync(os.tmpdir()) }));
  const pid2 = deadPid();
  const elsewhere = put(cfg, `${pid2}.json`, JSON.stringify({ pid: pid2, kind: 'interactive', entrypoint: 'sdk-cli', cwd: os.homedir() }));
  const report = await pruneSessionLitter(cfg);
  assert.equal(report.removed, 1);
  assert.ok(!exists(here) && exists(elsewhere));
});

await check('a capped pass reports truncated and a later pass finishes the job', async () => {
  const cfg = account();
  const pids = [];
  // Pids no process can have on a machine that stops below them; verified dead one by one.
  for (let pid = 3_000_000; pids.length < 300; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        pids.push(pid);
      }
    }
  }
  // Keys are older than 24 h: a key whose entry went in an EARLIER pass is an orphan when it is
  // finally met, and an orphan is held until it is that old.
  for (const pid of pids) {
    put(cfg, `${pid}.json`, pid % 2 ? '' : signature(pid));
    put(cfg, `${pid}.${HEX}.key`, 'k', VERY_OLD);
  }
  const first = await pruneSessionLitter(cfg, { ...OPTS, maxFiles: 100 });
  assert.equal(first.truncated, true);
  assert.equal(first.scanned, 100);
  let removed = first.removed;
  for (let pass = 0; pass < 20 && fs.readdirSync(path.join(cfg, 'sessions')).length > 0; pass++) {
    removed += (await pruneSessionLitter(cfg, { ...OPTS, maxFiles: 100 })).removed;
  }
  assert.deepEqual(fs.readdirSync(path.join(cfg, 'sessions')), []);
  assert.equal(removed, 600);
});

// ---- optional: the numbers the module header quotes ------------------------------------------

async function bench() {
  /** Dead pids in the range a name may stand for, above anything this machine has issued. */
  function deadPids(count, from) {
    const out = [];
    for (let pid = from; out.length < count && pid <= 4_194_304; pid++) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          out.push(pid);
        }
      }
    }
    assert.equal(out.length, count, 'not enough dead pids in range for the fixture');
    return out;
  }
  async function emptyOut(cfg, label, expected) {
    const sessions = path.join(cfg, 'sessions');
    let longestGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const passes = [];
    let removed = 0;
    const connectsBefore = connects.length;
    for (;;) {
      const started = performance.now();
      last = started;
      const report = await pruneSessionLitter(cfg, OPTS);
      passes.push(Math.round(performance.now() - started));
      removed += report.removed;
      assert.equal(report.errors, 0, `${label}: errors in a pass`);
      if (!report.truncated) {
        break;
      }
      assert.ok(passes.length < 50, `${label}: did not finish in 50 passes`);
    }
    clearInterval(tick);
    const left = fs.readdirSync(sessions).length;
    console.log(
      `BENCH ${label}: ${expected} files, removed ${removed}, left ${left}, passes ${passes.length} ` +
        `(ms: ${passes.join(', ')}), longest event-loop gap ${Math.round(longestGap)} ms, ` +
        `connects ${connects.length - connectsBefore}, load average ${os.loadavg()[0].toFixed(1)}`,
    );
    assert.equal(left, 0, `${label}: files were left`);
  }
  // Older than 24 h, so that a key orphaned by a pass that stopped at its cap can still go.
  const when = (Date.now() - VERY_OLD) / 1000;
  const write = (file, body) => {
    fs.writeFileSync(file, body);
    fs.utimesSync(file, when, when);
  };

  // Fixture 1: rules (a) and (b1), each entry with its key. 38,778 entries + 38,778 keys.
  {
    const cfg = account();
    const sessions = path.join(cfg, 'sessions');
    const pids = deadPids(38_778, 1_000_000);
    pids.forEach((pid, i) => {
      write(path.join(sessions, `${pid}.json`), i % 2 ? '' : signature(pid));
      write(path.join(sessions, `${pid}.${HEX}.key`), 'k');
    });
    await emptyOut(cfg, 'rules (a)/(b1)', pids.length * 2);
  }

  // Fixture 2: rule (b2) — every entry names `<pid>.sock`; five in eight of those sockets are
  // real leftover socket files (bound, then their process SIGKILLed), the rest do not exist.
  {
    const cfg = account();
    const sessions = path.join(cfg, 'sessions');
    const socks = sockDir();
    const pids = deadPids(38_776, 2_000_000);
    const withSocket = pids.filter((_, i) => i % 8 < 5);
    for (let at = 0; at < withSocket.length; at += 4000) {
      const batch = withSocket.slice(at, at + 4000);
      const binder = spawn(
        process.execPath,
        ['-e', `const net=require('net'),path=require('path');let left=0;let buf='';process.stdin.on('data',d=>buf+=d).on('end',()=>{const pids=buf.trim().split(',');left=pids.length;for(const p of pids)net.createServer(()=>{}).listen(path.join(process.argv[1],p+'.sock'),()=>{if(--left===0)console.log('bound')});});`, socks],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      );
      binder.stdin.end(batch.join(','));
      await new Promise((resolve, reject) => {
        binder.stdout.on('data', resolve);
        binder.on('exit', () => reject(new Error('the binder exited early')));
      });
      const exited = new Promise((resolve) => binder.on('exit', resolve));
      binder.kill('SIGKILL');
      await exited;
    }
    assert.equal(fs.readdirSync(socks).length, withSocket.length, 'fixture: stale sockets missing');
    for (const pid of pids) {
      write(path.join(sessions, `${pid}.json`), signature(pid, { messagingSocketPath: path.join(socks, `${pid}.sock`) }));
      write(path.join(sessions, `${pid}.${HEX}.key`), 'k');
    }
    await emptyOut(cfg, 'rule (b2)', pids.length * 2);
    assert.equal(fs.readdirSync(socks).length, withSocket.length, 'a socket file was removed');
  }
}

if (BENCH) {
  await check('bench: the two large fixtures are emptied', bench);
}

// ---- done ----------------------------------------------------------------------------------

live.kill('SIGKILL');
net.connect = realConnect;
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${tally.pass} passed, ${tally.fail} failed — src: ${SRC}`);
process.exit(tally.fail === 0 ? 0 : 1);
