'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* F1 — rule (b2) of sessionLitter: an entry WITH a messaging socket is removed only when its
 * process is provably gone — pid equals the file name, kill(pid, 0) says ESRCH, and NOBODY IS
 * LISTENING at the socket: nothing is at the path (lstat ENOENT, no connect), or a socket named
 * `<pid>.sock` is there and a connect to it is refused (ECONNREFUSED; or ENOENT, gone in between).
 * A socket under any other name is never connected to and keeps the entry.
 * Fixtures only. Entry files live under this directory; the socket files live in a short
 * directory under os.tmpdir(), because a unix socket address is limited to ~104 bytes and
 * this directory's own path is longer than that. It is removed at the end.
 *   node test-f1.js <sessionLitter bundle>
 *
 * Since 2.0 the module connects ONLY to a socket named after the entry's own pid, so every
 * fixture that is about what a connect answers puts its socket at `<pid>.sock`; the sockets
 * under other names (live.sock, stale.sock) are kept for the cases that pin the new rule.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const { pruneSessionLitter } = require(path.resolve(process.argv[2]));
const ROOT = path.join(__dirname, 'f1-fixtures');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const SOCKS = fs.mkdtempSync(path.join(os.tmpdir(), 'f1s-'));
process.on('exit', () => {
  try {
    fs.chmodSync(path.join(SOCKS, 'locked'), 0o700);
  } catch {
    // not there
  }
  fs.rmSync(SOCKS, { recursive: true, force: true });
});

const TMP = fs.realpathSync(os.tmpdir());
const MIN = 60_000;
const OLD = 120 * MIN;
const ANCIENT = 48 * 60 * MIN;
const YOUNG = 1 * MIN;
const HEX = 'ab'.repeat(32);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + String(detail).slice(0, 260) + ']' : ''}`);
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const age = (p, ms) => {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(p, t, t);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errnoOfKill = (pid) => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return e.code;
  }
};
/** The socket path the platform would give the session of process `pid`. */
const sockOf = (pid, dir = SOCKS) => path.join(dir, `${pid}.sock`);
/** A pid that belonged to a process which has exited (and that no fixture socket is named for yet). */
const deadPid = () => {
  for (let i = 0; i < 20; i++) {
    const r = cp.spawnSync(process.execPath, ['-e', '']);
    if (typeof r.pid === 'number' && errnoOfKill(r.pid) === 'ESRCH' && !exists(sockOf(r.pid))) {
      return r.pid;
    }
  }
  throw new Error('could not obtain a dead pid');
};
// Every path the module hands net.connect, across the whole run (the stand-ins of section 7 replace
// this wrapper while they are in place and record their own).
const connectLog = [];
const platformConnect = net.connect;
net.connect = function (...args) {
  connectLog.push(args[0] && args[0].path);
  return platformConnect.apply(net, args);
};
let seq = 0;
const newCfg = () => {
  const cfg = path.join(ROOT, `cfg${++seq}`);
  fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
  return cfg;
};
const put = (cfg, name, content, ageMs) => {
  const p = path.join(cfg, 'sessions', name);
  fs.writeFileSync(p, content);
  age(p, ageMs);
  return p;
};
const entry = (extra = {}) =>
  JSON.stringify({
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: TMP,
    startedAt: 1700000000000,
    kind: 'interactive',
    entrypoint: 'sdk-cli',
    ...extra,
  });
const goneSock = (n) => path.join(SOCKS, `gone-${n}.sock`);
const brief = (r) => `scanned ${r.scanned} removed ${r.removed} truncated ${r.truncated} errors ${r.errors}`;
const fileId = (p) => {
  const st = fs.lstatSync(p);
  return `${st.ino}|${st.mode}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
};

/** One entry (+ its key) in its own config dir, pruned once. */
async function scenario(label, { name, body, ageMs = OLD, keyAge = OLD, opts }) {
  const cfg = newCfg();
  const file = put(cfg, name, body, ageMs);
  const key = put(cfg, name.replace(/\.json$/, `.${HEX}.key`), 'k', keyAge);
  const t0 = Date.now();
  const report = await pruneSessionLitter(cfg, opts);
  return { label, file, key, report, ms: Date.now() - t0, entryGone: !exists(file), keyGone: !exists(key) };
}
const removed = (r) => check(`${r.label} → entry and key REMOVED`, r.entryGone && r.keyGone && r.report.removed === 2 && r.report.errors === 0, brief(r.report));
const kept = (r) => check(`${r.label} → entry and key KEPT`, !r.entryGone && !r.keyGone && r.report.removed === 0 && r.report.errors === 0, brief(r.report));

/** Sockets a child bound and then lost its life over: socket FILES with nobody listening. */
async function staleSockets(names) {
  const paths = names.map((n) => path.join(SOCKS, n));
  const child = cp.spawn(process.execPath, ['-e', `const net = require('net'); let n = 0; const ps = ${JSON.stringify(paths)}; for (const p of ps) net.createServer().listen(p, () => { if (++n === ps.length) console.log('up'); }); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => child.stdout.once('data', res));
  child.kill('SIGKILL');
  await new Promise((res) => child.once('exit', res));
  return paths;
}
/** `<pid>.sock` for a pid chosen by the caller, left behind the same way. */
const staleSockFor = async (pid) => (await staleSockets([`${pid}.sock`]))[0];
/**
 * What a SIGKILLed session really leaves: a child listens on `<its own pid>.sock` and is killed.
 * Returns that (now dead) pid and the socket file nobody is listening on.
 */
async function staleOwn() {
  const child = cp.spawn(process.execPath, ['-e', `const net = require('net'); const p = require('path').join(${JSON.stringify(SOCKS)}, process.pid + '.sock'); net.createServer().listen(p, () => console.log('up')); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => child.stdout.once('data', res));
  child.kill('SIGKILL');
  await new Promise((res) => child.once('exit', res));
  const sock = sockOf(child.pid);
  if (!fs.lstatSync(sock).isSocket() || errnoOfKill(child.pid) !== 'ESRCH') {
    throw new Error('fixture: no stale <pid>.sock was left');
  }
  return { pid: child.pid, sock };
}

(async () => {
  // ---- a listener in THIS process that records everything a probe does to it
  const LIVE_SOCK = path.join(SOCKS, 'live.sock');
  const seen = { connections: 0, bytes: 0, open: 0 };
  const onConnection = (c) => {
    seen.connections++;
    seen.open++;
    c.on('data', (d) => (seen.bytes += d.length));
    c.on('error', () => undefined);
    c.on('close', () => seen.open--);
  };
  const server = net.createServer(onConnection);
  await new Promise((res, rej) => server.once('error', rej).listen(LIVE_SOCK, res));
  // the same recording listener, at the socket path of process `pid`
  const liveServers = [];
  const liveSockFor = async (pid, dir = SOCKS) => {
    const s = net.createServer(onConnection);
    await new Promise((res, rej) => s.once('error', rej).listen(sockOf(pid, dir), res));
    liveServers.push(s);
    return sockOf(pid, dir);
  };
  const [STALE_SOCK] = await staleSockets(['stale.sock']);
  check('fixture: live.sock is a socket with a listener; its path fits a socket address', fs.lstatSync(LIVE_SOCK).isSocket() && Buffer.byteLength(LIVE_SOCK) <= 103, `${Buffer.byteLength(LIVE_SOCK)} bytes`);
  check('fixture: stale.sock is still a socket FILE after its owner was SIGKILLed', fs.lstatSync(STALE_SOCK).isSocket());

  console.log('--- the cases the coordinator named');
  let D = deadPid();
  removed(await scenario('1 socket-carrying probe entry, pid DEAD, nothing at the socket path (ENOENT)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(1) }) }));

  {
    // dead pid + its stale socket FILE with no listener → removed, and the socket file is not touched
    const own = await staleOwn();
    const before = fileId(own.sock);
    const n0 = connectLog.length;
    removed(await scenario('2 pid dead + STALE socket file <pid>.sock, no listener (ECONNREFUSED)', { name: `${own.pid}.json`, body: entry({ pid: own.pid, messagingSocketPath: own.sock }) }));
    check('2 the stale socket file itself is untouched (same inode, mode, size, mtime, ctime) and still there', exists(own.sock) && fileId(own.sock) === before);
    check('2 … and that verdict came from ONE connect, to that path', connectLog.length === n0 + 1 && connectLog[n0] === own.sock, JSON.stringify(connectLog.slice(n0)));
    // 2.0: the same stale socket file under a name that is not the entry's pid is not approached at all
    const idBefore = fileId(STALE_SOCK);
    const n1 = connectLog.length;
    D = deadPid();
    kept(await scenario('2b pid dead + a STALE socket file under ANOTHER name (stale.sock): never connected to', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: STALE_SOCK }) }));
    check('2b … no connect was made, and the socket file is untouched', connectLog.length === n1 && fileId(STALE_SOCK) === idBefore, JSON.stringify(connectLog.slice(n1)));
    D = deadPid();
    const wrongPid = await staleSockFor(D + 1 === process.pid ? D + 2 : D + 1);
    kept(await scenario('2b pid dead + a STALE socket file named for ANOTHER pid (<pid+1>.sock): never connected to', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: wrongPid }) }));
    check('2b … no connect was made', connectLog.length === n1, JSON.stringify(connectLog.slice(n1)));
  }
  {
    // dead pid + its socket somebody IS listening on → kept; the listener sees a silent hang-up at most
    const c0 = seen.connections;
    D = deadPid();
    kept(await scenario('3 pid dead + <pid>.sock with a LIVE LISTENER (this process)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: await liveSockFor(D) }) }));
    await sleep(60);
    check('3 the listener saw exactly one connection, zero bytes, and it is already closed', seen.connections === c0 + 1 && seen.bytes === 0 && seen.open === 0, JSON.stringify(seen));
    // 2.0: a listened-to socket under another name is not even connected to
    D = deadPid();
    kept(await scenario('3b pid dead + a LISTENED-TO socket under another name (live.sock)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: LIVE_SOCK }) }));
    await sleep(60);
    check('3b … its listener saw no connection at all', seen.connections === c0 + 1 && seen.open === 0, JSON.stringify(seen));
  }
  {
    const c0 = seen.connections;
    const LIVE = process.pid;
    kept(await scenario('4 pid LIVE (this test process), socket path missing', { name: `${LIVE}.json`, body: entry({ pid: LIVE, messagingSocketPath: goneSock(2) }) }));
    kept(await scenario('4 pid LIVE, <pid>.sock with a live listener', { name: `${LIVE}.json`, body: entry({ pid: LIVE, messagingSocketPath: await liveSockFor(LIVE) }) }));
    kept(await scenario('4 pid 1 (exists, not ours), 1.sock with a live listener', { name: '1.json', body: entry({ pid: 1, messagingSocketPath: await liveSockFor(1) }) }));
    check('4 (precondition) kill(1, 0) does not say ESRCH', errnoOfKill(1) !== 'ESRCH', errnoOfKill(1));
    D = deadPid();
    const D2 = deadPid();
    kept(await scenario('4 `pid` (dead) does not match the file name (also dead), <file-name pid>.sock with a live listener', { name: `${D}.json`, body: entry({ pid: D2, messagingSocketPath: await liveSockFor(D) }) }));
    await sleep(60);
    check('4 the socket of a LIVE process, and of an entry whose pid does not match, is never even connected to', seen.connections === c0, `connections ${c0} → ${seen.connections}`);
  }
  {
    // each of these sits at the entry's OWN <pid>.sock, so what keeps the entry is what is at the path
    const n0 = connectLog.length;
    D = deadPid();
    const notSock = sockOf(D);
    fs.writeFileSync(notSock, 'not a socket');
    const before = fileId(notSock);
    kept(await scenario('5 pid dead + the path <pid>.sock is a REGULAR FILE', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: notSock }) }));
    check('5 the file at the socket path is untouched', fs.readFileSync(notSock, 'utf8') === 'not a socket' && fileId(notSock) === before);
    D = deadPid();
    const dirSock = sockOf(D);
    fs.mkdirSync(dirSock);
    kept(await scenario('5 pid dead + the path <pid>.sock is a DIRECTORY', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: dirSock }) }));
    D = deadPid();
    const fifo = sockOf(D);
    cp.execFileSync('mkfifo', [fifo]);
    kept(await scenario('5 pid dead + the path <pid>.sock is a FIFO (must not block)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: fifo }) }));
    D = deadPid();
    kept(await scenario('5 pid dead + a path COMPONENT is a file (ENOTDIR)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: path.join(notSock, `${D}.sock`) }) }));
    check('5 … and none of the four was connected to: what is not a socket is never approached', connectLog.length === n0, JSON.stringify(connectLog.slice(n0)));
  }
  {
    const locked = path.join(SOCKS, 'locked');
    fs.mkdirSync(locked);
    D = deadPid();
    const inner = sockOf(D, locked);
    const s2 = net.createServer();
    await new Promise((res) => s2.listen(inner, res));
    fs.chmodSync(locked, 0o000);
    const r = await scenario('6 pid dead + <pid>.sock in a directory we cannot traverse (EACCES) — a live listener is behind it', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: inner }) });
    D = deadPid();
    const r2 = await scenario('6 pid dead + nothing at <pid>.sock in a directory we cannot traverse', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: sockOf(D, locked) }) });
    fs.chmodSync(locked, 0o700);
    await new Promise((res) => s2.close(res));
    if (process.getuid && process.getuid() === 0) {
      check('6 (skipped: running as root, EACCES cannot be produced)', true);
    } else {
      kept(r);
      kept(r2);
    }
    D = deadPid();
    const ro = sockOf(D);
    const s3 = net.createServer();
    await new Promise((res) => s3.listen(ro, res));
    fs.chmodSync(ro, 0o000);
    const n0 = connectLog.length;
    kept(await scenario('6 pid dead + a LIVE <pid>.sock whose file mode forbids us to connect (EACCES)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: ro }) }));
    check('6 … the connect WAS attempted (it is the entry\'s own socket) and its EACCES kept the entry', connectLog.length === n0 + 1 && connectLog[n0] === ro, JSON.stringify(connectLog.slice(n0)));
    await new Promise((res) => s3.close(res));
  }

  console.log('--- a connect that does not answer; errors of every other kind (net.connect replaced by a stand-in)');
  {
    // A unix-domain connect cannot be made to hang on this platform: against a listener that
    // never accepts, with a backlog of 1, it answers at once (see the fact printed below). The
    // 500 ms cap is therefore exercised by standing in for net.connect itself.
    const realConnect = net.connect;
    const made = [];
    const fake = (behaviour) => (...args) => {
      const s = new EventEmitter();
      s.destroyed = false;
      s.wrote = false;
      s.args = args;
      s.destroy = () => {
        s.destroyed = true;
        s.destroyedAt = Date.now();
      };
      s.write = () => {
        s.wrote = true;
      };
      s.end = s.write;
      made.push(s);
      behaviour(s);
      return s;
    };
    // The module reaches net.connect only for a SOCKET named `<pid>.sock`, so by default each run gets
    // a real stale socket file at its dead pid's own path; `sockFor` puts something else there.
    const run = async (label, behaviour, sockFor = staleSockFor) => {
      made.length = 0;
      const d = deadPid();
      const sockPath = await sockFor(d);
      net.connect = fake(behaviour);
      let r;
      try {
        r = await scenario(label, { name: `${d}.json`, body: entry({ pid: d, messagingSocketPath: sockPath }) });
      } finally {
        net.connect = realConnect;
      }
      return Object.assign(r, { sockPath });
    };
    let r = await run('7 connect that never answers', () => undefined);
    check('7 (the stand-in is what the module called: one attempt, with the socket path)', made.length === 1 && JSON.stringify(made[0].args) === JSON.stringify([{ path: r.sockPath }]), JSON.stringify(made.map((s) => s.args)));
    kept(r);
    check('7 … kept by the cap: the pass took ~500 ms, and the attempt was destroyed, nothing written', r.ms >= 480 && r.ms < 1500 && made[0].destroyed === true && made[0].wrote === false, `${r.ms} ms destroyed=${made[0].destroyed}`);

    r = await run('7 connect that answers "connected" only after 2 s', (s) => setTimeout(() => s.emit('connect'), 2000).unref());
    kept(r);
    check('7 … the cap answered first (not the late event)', r.ms < 1500, `${r.ms} ms`);

    let uncaught = 0;
    const onUncaught = () => uncaught++;
    process.on('uncaughtException', onUncaught);
    r = await run('7 connect that never answers, then emits an error AFTER the cap', (s) => setTimeout(() => s.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' })), 700));
    kept(r);
    await sleep(400);
    check('7 … the late error is absorbed (no uncaught exception)', uncaught === 0);
    r = await run('7 connect refused, then a second error event on the destroyed socket', (s) => setImmediate(() => { s.emit('error', Object.assign(new Error('x'), { code: 'EPIPE' })); s.emit('error', Object.assign(new Error('y'), { code: 'ECONNREFUSED' })); }));
    kept(r);
    await sleep(50);
    check('7 … only the FIRST answer counts, and nothing is uncaught', uncaught === 0);
    process.removeListener('uncaughtException', onUncaught);

    r = await run('7 net.connect that THROWS synchronously', () => { throw new TypeError('bad address'); });
    kept(r);
    for (const code of ['EACCES', 'EPERM', 'ENOTSOCK', 'ENOTDIR', 'EAGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'EMFILE', 'EWHATEVER']) {
      r = await run(`7 connect fails with ${code}`, (s) => setImmediate(() => s.emit('error', Object.assign(new Error(code), { code }))));
      kept(r);
    }
    r = await run('7 connect fails with an error that has NO code', (s) => setImmediate(() => s.emit('error', new Error('mystery'))));
    kept(r);
    r = await run('7 connect fails with a code that is not a string', (s) => setImmediate(() => s.emit('error', Object.assign(new Error('n'), { code: 61 }))));
    kept(r);
    r = await run('7 connect "connected" (stand-in)', (s) => setImmediate(() => s.emit('connect')));
    kept(r);
    check('7 … an accepted connection is destroyed at once and never written to', made[0].destroyed === true && made[0].wrote === false);
    // What Linux reports for a NON-socket file is ECONNREFUSED (macOS says ENOTSOCK): the
    // refusal must not be believed unless a socket really is at the path.
    r = await run('7 ECONNREFUSED for a path <pid>.sock that is a REGULAR FILE (what Linux reports)', (s) => setImmediate(() => s.emit('error', Object.assign(new Error('r'), { code: 'ECONNREFUSED' }))), (d) => { fs.writeFileSync(sockOf(d), 'not a socket'); return sockOf(d); });
    kept(r);
    check('7 … and since 2.0 the question is settled before any connect: a regular file is never connected to', made.length === 0, `attempts ${made.length}`);
    // [2.0: was KEPT] Nothing at the path is "nobody is listening" by lstat alone; the connect whose
    // (impossible) ECONNREFUSED used to be disbelieved is no longer made.
    r = await run('7 a path where nothing exists at all (with a connect that WOULD say ECONNREFUSED)', (s) => setImmediate(() => s.emit('error', Object.assign(new Error('r'), { code: 'ECONNREFUSED' }))), () => goneSock(51));
    removed(r);
    check('7 … decided by lstat (ENOENT): no connect was attempted at all', made.length === 0, `attempts ${made.length}`);
    r = await run('7 ECONNREFUSED for a real stale socket file <pid>.sock (stand-in agrees with the platform)', (s) => setImmediate(() => s.emit('error', Object.assign(new Error('r'), { code: 'ECONNREFUSED' }))));
    removed(r);
    r = await run('7 ENOENT (stand-in)', (s) => setImmediate(() => s.emit('error', Object.assign(new Error('r'), { code: 'ENOENT' }))));
    removed(r);

    // A path that cannot be asked about is refused BEFORE any connect: the stand-in would
    // answer ENOENT ("nobody is listening"), so reaching it at all would remove the entry.
    for (const [what, p] of [
      ['a relative path', 'socks/gone.sock'],
      ['the empty string', ''],
      ['a path holding a NUL', goneSock(52) + '\u0000x'],
      ['an absolute path of 104 bytes', path.join(SOCKS, 'q'.repeat(104 - SOCKS.length - 1))],
      ['an absolute path of 5,000 bytes', '/' + 'a'.repeat(4999)],
    ]) {
      r = await run(`7c ${what}, with a connect that WOULD say ENOENT`, (s) => setImmediate(() => s.emit('error', Object.assign(new Error('r'), { code: 'ENOENT' }))), () => p);
      kept(r);
      check(`7c … ${what}: no connect was attempted at all`, made.length === 0, `attempts ${made.length}`);
    }

    // maxMs still stops a pass, and probes never exceed the concurrency bound
    {
      made.length = 0;
      let open = 0;
      let maxOpen = 0;
      net.connect = fake((s) => {
        open++;
        maxOpen = Math.max(maxOpen, open);
        const d0 = s.destroy;
        s.destroy = () => {
          if (!s.destroyed) open--;
          d0();
        };
      });
      const cfg = newCfg();
      // each entry's own <pid>.sock is a real stale socket file, so every one of them reaches the stand-in
      const pids60 = Array.from({ length: 60 }, (_, i) => 2000000 + i); // above any pid this OS issues → ESRCH
      const socks60 = await staleSockets(pids60.map((pid) => `${pid}.sock`));
      pids60.forEach((pid, i) => put(cfg, `${pid}.json`, entry({ pid, messagingSocketPath: socks60[i] }), OLD));
      const t0 = Date.now();
      let rep;
      try {
        rep = await pruneSessionLitter(cfg, { maxMs: 1200 });
      } finally {
        net.connect = realConnect;
      }
      const ms = Date.now() - t0;
      check('8 maxMs: 60 entries whose sockets never answer, budget 1200 ms → the pass stops on budget, truncated', rep.truncated === true && ms >= 1150 && ms < 2300 && rep.scanned < 60 && rep.removed === 0 && rep.errors === 0, `${ms} ms; ${brief(rep)}; attempts ${made.length}`);
      check('8 at most 3 connect attempts are ever open at once', maxOpen >= 1 && maxOpen <= 3, `max open ${maxOpen}`);
      check('8 no attempt outlives the pass: every one was destroyed before it returned', made.length > 0 && made.every((s) => s.destroyed === true) && open === 0, `attempts ${made.length}, still open ${open}`);
      check('8 the entries are all still there', fs.readdirSync(path.join(cfg, 'sessions')).length === 60);
    }
    check('(net.connect restored)', net.connect === realConnect);
  }
  {
    // the pid is asked AGAIN after the probe: gone the first time, alive the second → keep
    const realKill = process.kill;
    const d = deadPid();
    let asked = 0;
    process.kill = function (pid, sig) {
      if (pid === d && sig === 0) {
        asked++;
        if (asked === 1) {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return realKill.apply(process, arguments);
    };
    let r;
    try {
      r = await scenario('7b pid gone when first asked, ALIVE when asked again after the probe (nothing at the socket path)', { name: `${d}.json`, body: entry({ pid: d, messagingSocketPath: goneSock(60) }) });
    } finally {
      process.kill = realKill;
    }
    kept(r);
    check('7b … the pid was asked exactly twice: before the probe and after it', asked === 2, `asked ${asked}`);
  }
  {
    // the same budget property with REAL sockets and no stand-in
    const cfg = newCfg();
    // 4,000 real stale socket files, each named for its entry's pid (bound 250 at a time by a child
    // that is then SIGKILLed), so every entry costs a real connect
    for (let from = 0; from < 4000; from += 250) {
      const pids = Array.from({ length: 250 }, (_, i) => 3000000 + from + i);
      const socks = await staleSockets(pids.map((pid) => `${pid}.sock`));
      pids.forEach((pid, i) => put(cfg, `${pid}.json`, entry({ pid, messagingSocketPath: socks[i] }), OLD));
    }
    const n0 = connectLog.length;
    const t0 = Date.now();
    const rep = await pruneSessionLitter(cfg, { maxMs: 60, dryRun: true });
    const ms = Date.now() - t0;
    check('8 maxMs with real probes: 4,000 entries, budget 60 ms → stops early, truncated', rep.truncated === true && rep.scanned < 4000 && ms < 1500, `${ms} ms; ${brief(rep)}`);
    check('8 … and they WERE real probes: the pass connected to entries\' own sockets before the budget ran out', connectLog.length > n0 && connectLog.slice(n0).every((p) => /\/3\d{6}\.sock$/.test(String(p))), `${connectLog.length - n0} connects`);
  }
  {
    // platform fact, printed for the report: can a unix-domain connect hang?
    D = deadPid(); // the listener sits at this dead pid's own socket path, so the module would connect to it
    const blk = sockOf(D);
    const b = cp.spawn(process.execPath, ['-e', `const s = require('net').createServer(); s.listen({ path: ${JSON.stringify(blk)}, backlog: 1 }, () => { console.log('up'); setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000), 50); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => b.stdout.once('data', res));
    await sleep(300);
    const held = [];
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(await new Promise((res) => {
        const t0 = Date.now();
        const s = net.connect({ path: blk });
        held.push(s);
        s.on('connect', () => res(`connected/${Date.now() - t0}ms`));
        s.on('error', (e) => res(`${e.code}/${Date.now() - t0}ms`));
        setTimeout(() => res(`NO ANSWER/${Date.now() - t0}ms`), 1500);
      }));
    }
    console.log(`FACT  listener alive but never accepting, backlog 1, four connects held open: ${outcomes.join(', ')}`);
    check('platform fact: no unix-domain connect went unanswered (a real hang could not be constructed here)', outcomes.every((o) => !o.startsWith('NO ANSWER')), outcomes.join(', '));
    // with the queue full the answer is ECONNREFUSED: the module cannot tell that from "nobody is listening"
    const full = outcomes.some((o) => o.startsWith('ECONNREFUSED'));
    if (full) {
      const r = await scenario('RESIDUAL (documented): pid dead + a listener whose accept queue is FULL answers ECONNREFUSED', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: blk }) });
      console.log(`FACT  ${r.label} → ${r.entryGone ? 'REMOVED' : 'kept'} (${brief(r.report)})`);
    }
    held.forEach((s) => s.destroy());
    b.kill('SIGKILL');
    await new Promise((res) => b.once('exit', res));
  }

  console.log('--- dryRun classifies with the same probe, and unlinks nothing');
  {
    const cfg = newCfg();
    const own = await staleOwn();
    const d1 = own.pid;
    const a = put(cfg, `${d1}.json`, entry({ pid: d1, messagingSocketPath: own.sock }), OLD);
    const k = put(cfg, `${d1}.${HEX}.key`, 'k', OLD);
    const d2 = deadPid();
    const live9 = await liveSockFor(d2);
    const b = put(cfg, `${d2}.json`, entry({ pid: d2, messagingSocketPath: live9 }), OLD);
    // …and one that names a listened-to socket which is NOT its own: the dry run may not connect to it either
    const d3 = deadPid();
    const c = put(cfg, `${d3}.json`, entry({ pid: d3, messagingSocketPath: LIVE_SOCK }), OLD);
    const c0 = seen.connections;
    const before = fs.readdirSync(path.join(cfg, 'sessions')).sort().join();
    const staleBefore = fileId(own.sock);
    const r = await pruneSessionLitter(cfg, { dryRun: true });
    await sleep(60);
    check('9 dryRun: counts the stale-socket entry + its key (2), keeps the two listened-to ones, removes nothing', r.removed === 2 && r.scanned === 4 && exists(a) && exists(k) && exists(b) && exists(c) && fs.readdirSync(path.join(cfg, 'sessions')).sort().join() === before, brief(r));
    check('9 dryRun DID probe: the listener at the entry\'s own <pid>.sock saw one silent connection — and the socket under another name saw none', seen.connections === c0 + 1 && seen.bytes === 0 && seen.open === 0, JSON.stringify(seen));
    check('9 dryRun left the socket files exactly as they were', fileId(own.sock) === staleBefore && fs.lstatSync(live9).isSocket() && fs.lstatSync(LIVE_SOCK).isSocket());
    const r2 = await pruneSessionLitter(cfg);
    check('9 a real pass after it: exactly those two go, the listened-to entries stay', r2.removed === 2 && !exists(a) && !exists(k) && exists(b) && exists(c), brief(r2));
  }

  console.log('--- the original branch, and every other guard, unchanged');
  {
    // Since 2.0 every rule asks whether the process the FILE NAME names is gone, so these entries are
    // named for dead pids (they were 200.json … 203.json, numbers that may be anybody's process).
    const LIVE = process.pid;
    D = deadPid();
    removed(await scenario('10 NO messagingSocketPath, file named for a dead pid, `pid` field equal to it', { name: `${D}.json`, body: entry({ pid: D }) }));
    D = deadPid();
    removed(await scenario('10 messagingSocketPath null', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: null }) }));
    D = deadPid();
    removed(await scenario('10 no socket and no pid field at all', { name: `${D}.json`, body: entry() }));
    D = deadPid();
    const cfg = newCfg();
    const z = put(cfg, `${D}.json`, '', OLD);
    const r = await pruneSessionLitter(cfg);
    check('10 rule (a): zero-byte entry of a dead pid REMOVED', !exists(z) && r.removed === 1, brief(r));
    // [2.0: the first of these was REMOVED — "pid field is a live pid, irrelevant"]
    D = deadPid();
    kept(await scenario('10 NO messagingSocketPath, file named for a dead pid, but the `pid` field is ANOTHER process (this one)', { name: `${D}.json`, body: entry({ pid: LIVE }) }));
    kept(await scenario('10 NO messagingSocketPath, file named for a LIVE pid (this process)', { name: `${LIVE}.json`, body: entry({ pid: LIVE }) }));
    kept(await scenario('10 no socket and no pid field at all, file named for a LIVE pid', { name: `${LIVE}.json`, body: entry() }));
    kept(await scenario('10 no socket, file 1.json (a process that exists and is not ours)', { name: '1.json', body: entry({ pid: 1, messagingSocketPath: null }) }));
    const cfgLive = newCfg();
    const zLive = put(cfgLive, `${LIVE}.json`, '', OLD);
    const zKey = put(cfgLive, `${LIVE}.${HEX}.key`, 'k', ANCIENT);
    const rLive = await pruneSessionLitter(cfgLive);
    check('10 rule (a): the zero-byte entry of a LIVE pid, and its 48-hour-old key, are KEPT', exists(zLive) && exists(zKey) && rLive.removed === 0 && rLive.errors === 0, brief(rLive));
  }
  {
    const c0 = seen.connections;
    D = deadPid();
    {
      const other = deadPid();
      kept(await scenario('11 `pid` (dead) does not match the file name (also dead), nothing at the socket path', { name: `${D}.json`, body: entry({ pid: other, messagingSocketPath: goneSock(5) }) }));
    }
    kept(await scenario('11 pid 1 (exists, not ours → EPERM), nothing at the socket path', { name: '1.json', body: entry({ pid: 1, messagingSocketPath: goneSock(6) }) }));
    D = deadPid();
    kept(await scenario('11 pid is the right number but a STRING', { name: `${D}.json`, body: entry({ pid: String(D), messagingSocketPath: goneSock(7) }) }));
    D = deadPid();
    kept(await scenario('11 pid field missing', { name: `${D}.json`, body: entry({ messagingSocketPath: goneSock(8) }) }));
    D = deadPid();
    kept(await scenario('11 pid is a float', { name: `${D}.json`, body: entry({ pid: D + 0.5, messagingSocketPath: goneSock(9) }) }));
    kept(await scenario('11 file 0.json, pid 0 (would address our own process group)', { name: '0.json', body: entry({ pid: 0, messagingSocketPath: goneSock(10) }) }));
    kept(await scenario('11 pid past the C int range (4294967297 would wrap to 1)', { name: '4294967297.json', body: entry({ pid: 4294967297, messagingSocketPath: goneSock(11) }) }));
    kept(await scenario('11 pid past the C int range (9999999999)', { name: '9999999999.json', body: entry({ pid: 9999999999, messagingSocketPath: goneSock(12) }) }));
    for (const [what, value] of [['a number', 12345], ['an object', { path: goneSock(13) }], ['true', true], ['an array', [goneSock(13)]]]) {
      D = deadPid();
      kept(await scenario(`11 socket path is ${what}`, { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: value }) }));
    }
    D = deadPid();
    kept(await scenario('11 socket path is a RELATIVE string naming nothing', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: 'socks/gone.sock' }) }));
    D = deadPid();
    kept(await scenario('11 socket path is the EMPTY string', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: '' }) }));
    D = deadPid();
    kept(await scenario('11 socket path carries a NUL', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(14) + '\u0000x' }) }));
    D = deadPid();
    kept(await scenario('11 socket path is 50,000 characters long', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: '/' + 'a'.repeat(50_000) }) }));
    D = deadPid();
    const at104 = path.join(SOCKS, 'p'.repeat(104 - SOCKS.length - 1));
    kept(await scenario(`11 socket path of exactly 104 bytes (one past what an address holds), naming nothing`, { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: at104 }) }));
    D = deadPid();
    const at103 = path.join(SOCKS, 'p'.repeat(103 - SOCKS.length - 1));
    removed(await scenario(`11 socket path of exactly 103 bytes, naming nothing`, { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: at103 }) }));
    check('11 (those two paths are 104 and 103 bytes)', Buffer.byteLength(at104) === 104 && Buffer.byteLength(at103) === 103);
    // the links stand at the entries' OWN <pid>.sock, so the name is right and only "a link is not a socket" keeps them
    D = deadPid();
    fs.symlinkSync(STALE_SOCK, sockOf(D));
    kept(await scenario('11 the path <pid>.sock is a SYMLINK to a stale socket (refused, but not itself a socket)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: sockOf(D) }) }));
    D = deadPid();
    fs.symlinkSync(LIVE_SOCK, sockOf(D));
    kept(await scenario('11 the path <pid>.sock is a SYMLINK to a listened-to socket', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: sockOf(D) }) }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but YOUNGER than the age floor', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(15) }), ageMs: YOUNG, keyAge: ANCIENT }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but carries ccoMirror', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(16), ccoMirror: true }) }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but kind is "bg"', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(17), kind: 'bg' }) }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but entrypoint is "cli"', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(18), entrypoint: 'cli' }) }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but cwd is a project directory', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(19), cwd: '/work/someone/project' }) }));
    D = deadPid();
    kept(await scenario('11 dead + nobody listening, but tmpDirs is empty (rule (b) switched off)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(20) }), opts: { tmpDirs: [] } }));
    // [2.0: was REMOVED] a name is a pid only in its plain decimal spelling; a zero-padded one is not understood, and kept
    D = deadPid();
    const padded = String(D).padStart(10, '0');
    kept(await scenario('11 zero-padded file name (pid equals its NUMBER, nothing at the socket path)', { name: `${padded}.json`, body: entry({ pid: D, messagingSocketPath: goneSock(21) }) }));
    D = deadPid();
    removed(await scenario('11 pid dead, socket path under a directory that no longer exists (ENOENT)', { name: `${D}.json`, body: entry({ pid: D, messagingSocketPath: path.join(SOCKS, 'no-such-dir', 'deeper', 's.sock') }) }));
    await sleep(60);
    // [2.0: was "only the symlink-to-live case reached the listener (one silent connection)"] the path is
    // lstat'ed before any connect, and a symlink is not a socket
    check('11 of all of these, NONE reached the listener — not even the symlink to a listened-to socket', seen.connections === c0 && seen.bytes === 0 && seen.open === 0, `connections ${c0} → ${seen.connections}`);
  }

  console.log('--- a mixed directory');
  {
    const cfg = newCfg();
    // every socket is at its entry's own <pid>.sock
    const stale = [];
    const dead = [];
    for (let i = 0; i < 30; i++) {
      // odd: a session that was SIGKILLed and left its socket file; even: nothing at the socket path
      const own = i % 2 ? await staleOwn() : undefined;
      const d = own ? own.pid : deadPid();
      if (dead.includes(d) || exists(path.join(cfg, 'sessions', `${d}.json`))) continue;
      dead.push(d);
      if (own) stale.push(own.sock);
      put(cfg, `${d}.json`, entry({ pid: d, messagingSocketPath: own ? own.sock : goneSock(100 + i) }), OLD);
      put(cfg, `${d}.${HEX}.key`, 'k', OLD);
    }
    const sleepers = [];
    for (let i = 0; i < 5; i++) sleepers.push(cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
    const livePaths = [];
    for (const s of sleepers) {
      // a LIVE process whose own socket file is stale: its pid, not its socket, is what keeps it
      stale.push(await staleSockFor(s.pid));
      livePaths.push(put(cfg, `${s.pid}.json`, entry({ pid: s.pid, messagingSocketPath: sockOf(s.pid) }), OLD));
      livePaths.push(put(cfg, `${s.pid}.${HEX}.key`, 'k', ANCIENT));
    }
    const staleIds = stale.map(fileId).join();
    // dead pids whose socket somebody else is listening on
    const listened = [];
    for (let i = 0; i < 3; i++) {
      const d = deadPid();
      if (dead.includes(d) || exists(path.join(cfg, 'sessions', `${d}.json`))) continue;
      listened.push(put(cfg, `${d}.json`, entry({ pid: d, messagingSocketPath: await liveSockFor(d) }), OLD));
      listened.push(put(cfg, `${d}.${HEX}.key`, 'k', ANCIENT));
    }
    const c12 = seen.connections;
    const r = await pruneSessionLitter(cfg);
    await sleep(80);
    const left = fs.readdirSync(path.join(cfg, 'sessions'));
    check(`12 ${dead.length} dead entries (half with a stale socket file, half with none) + keys removed; 5 live-pid and ${listened.length / 2} listened-to entries + keys kept`, r.removed === dead.length * 2 && left.length === 10 + listened.length && livePaths.every(exists) && listened.every(exists) && r.errors === 0, brief(r) + ' left=' + left.length);
    check(`12 none of the ${stale.length} stale socket files was touched or removed`, stale.length === 20 && stale.map(fileId).join() === staleIds);
    check('12 each listened-to entry cost its listener exactly one silent connection; the live processes\' sockets were not approached', seen.connections === c12 + listened.length / 2, `connections ${c12} → ${seen.connections}`);
    check('12 nothing is left connected to the listener after the pass', seen.open === 0 && seen.bytes === 0);
    for (const s of sleepers) s.kill('SIGKILL');
    await sleep(300);
    const r3 = await pruneSessionLitter(cfg);
    check('12 once those processes are gone, the next pass removes their entries too (the listened-to ones still stay)', r3.removed === 10 && fs.readdirSync(path.join(cfg, 'sessions')).length === listened.length && listened.every(exists), brief(r3));
  }

  const totalSeen = { ...seen };
  await new Promise((res) => server.close(res));
  for (const s of liveServers) await new Promise((res) => s.close(res));
  check('the listener, across the whole run: never a byte, never a connection left open', totalSeen.bytes === 0 && totalSeen.open === 0, JSON.stringify(totalSeen));
  check('the stale socket file and the live socket file were never removed by a prune', exists(STALE_SOCK));
  console.log(`\nf1: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNEXPECTED THROW', e);
  process.exit(3);
});
