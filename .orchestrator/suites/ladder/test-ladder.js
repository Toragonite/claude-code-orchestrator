// Drives the compiled usage.ts / keepalive.ts against fake-claude.js. Run with HOME=<scratch>/home.
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const S = __dirname;
const FAKE = path.join(S, '..', 'lib', 'fake-claude.js');
const HOME = os.homedir();
if (!HOME.startsWith(S)) {
  console.error('REFUSING TO RUN: HOME is not the scratch home:', HOME);
  process.exit(2);
}
fs.chmodSync(FAKE, 0o755);
const WORKER_DIR = path.join(S, 'home', '.claude-worker-a');
const MAIN_DIR = path.join(HOME, '.claude');
fs.writeFileSync(
  path.join(HOME, '.claude-code-orchestrator', 'registry.json'),
  JSON.stringify({
    claudePath: FAKE,
    workers: [
      { name: 'alpha', configDir: WORKER_DIR },
      { name: 'shadow-of-main', configDir: MAIN_DIR },
    ],
  }),
);
// Session-identity variables a Claude Code host injects — every spawn must strip them.
Object.assign(process.env, {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
  CLAUDE_CODE_SESSION_ID: 'host-session',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-token',
  CLAUDE_PROJECT_DIR: '/host/project',
  CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
  CLAUDE_CODE_USE_BEDROCK: '1',
});
delete process.env.CLAUDE_CONFIG_DIR;

const usage = require('./build/usage.js');
const keepalive = require('./build/keepalive.js');
if (!usage.USAGE_CACHE_FILE.startsWith(S)) {
  console.error('REFUSING TO RUN: cache file outside scratch:', usage.USAGE_CACHE_FILE);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) {
    pass++;
  } else {
    fail++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readLog = (f) => {
  try {
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const first = (log, ev) => log.find((e) => e.ev === ev);
const lastOf = (log, ev) => [...log].reverse().find((e) => e.ev === ev);
const waitGone = async (pid, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) {
      return true;
    }
    await sleep(25);
  }
  return !alive(pid);
};
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

async function run(name, mode, fn) {
  const logFile = path.join(S, 'logs', name + '.jsonl');
  fs.rmSync(logFile, { force: true });
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = logFile;
  const t0 = Date.now();
  const result = await fn();
  const tResolved = Date.now();
  const atResolve = readLog(logFile);
  return { result, t0, tResolved, logFile, atResolve, log: () => readLog(logFile) };
}

(async () => {
  console.log('--- A. usage probe, polite child: stdin end is enough');
  {
    const baseTimers = timeouts();
    const r = await run('A', '', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const u = r.result;
    check('A1 reading parsed', u.available === true && u.error === undefined && u.windows.length === 2 && u.windows[0].percent === 12 && u.windows[1].percent === 34 && u.subscriptionType === 'max' && u.sessionCostUsd === 0.5, JSON.stringify({ available: u.available, windows: u.windows.map((w) => w.percent), err: u.error }));
    const pid = first(r.atResolve, 'start').pid;
    check('A2 promise resolved while the child was still alive (caller not delayed)', alive(pid) && !first(r.atResolve, 'exit'), `resolved after ${r.tResolved - r.t0}ms`);
    await waitGone(pid, 3000);
    const log = r.log();
    check('A3 child saw stdin end', !!first(log, 'stdin-end'));
    check('A4 child exited 0 by itself', first(log, 'exit') && first(log, 'exit').code === 0, `exit ${first(log, 'exit') && first(log, 'exit').t - r.tResolved}ms after resolve`);
    check('A5 no SIGTERM was sent', !first(log, 'sigterm'));
    await sleep(350); // exit drain
    check('A6 ladder timers cleared on exit (no Timeout resource left)', timeouts() === baseTimers, `timeouts=${timeouts()} base=${baseTimers}`);
    check('A7 cwd is os.tmpdir()', fs.realpathSync(first(log, 'start').cwd) === fs.realpathSync(os.tmpdir()));
    check('A8 argv unchanged', JSON.stringify(first(log, 'start').argv) === JSON.stringify(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']));
  }

  console.log('--- B. child ignores stdin end: SIGTERM after 3000 ms');
  {
    const r = await run('B', 'ignore-stdin', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const pid = first(r.atResolve, 'start').pid;
    check('B1 reading parsed and resolved early', r.result.available === true && alive(pid), `resolved after ${r.tResolved - r.t0}ms`);
    await sleep(2500);
    check('B2 not signalled before 3000 ms', alive(pid) && !first(r.log(), 'sigterm'));
    await waitGone(pid, 2000);
    const log = r.log();
    const dt = first(log, 'sigterm') ? first(log, 'sigterm').t - r.tResolved : NaN;
    check('B3 SIGTERM arrived ~3000 ms after the reading', dt >= 2900 && dt <= 3400, `${dt}ms`);
    check('B4 child exited on SIGTERM (143), no SIGKILL needed', first(log, 'exit') && first(log, 'exit').code === 143);
  }

  console.log('--- C. child ignores stdin end AND SIGTERM: SIGKILL 2000 ms later');
  {
    const r = await run('C', 'ignore-stdin,ignore-term', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const pid = first(r.atResolve, 'start').pid;
    check('C1 resolved early', r.result.available === true && alive(pid), `resolved after ${r.tResolved - r.t0}ms`);
    await sleep(4500);
    check('C2 still alive at +4500 ms (SIGTERM ignored, SIGKILL not yet due)', alive(pid));
    const gone = await waitGone(pid, 1500);
    const log = r.log();
    const dtTerm = first(log, 'sigterm').t - r.tResolved;
    const dtDead = lastOf(log, 'hb').t - r.tResolved;
    check('C3 SIGTERM at ~3000 ms', dtTerm >= 2900 && dtTerm <= 3400, `${dtTerm}ms`);
    check('C4 process gone by ~5000 ms (last heartbeat)', gone && dtDead >= 4750 && dtDead <= 5300, `last hb ${dtDead}ms`);
    check('C5 it never ran an exit handler (killed, not exited)', !first(log, 'exit'));
  }

  console.log('--- D. child never answers: timeout resolves, then the ladder runs');
  {
    const r = await run('D', 'silent,ignore-stdin', () => usage.fetchAccountUsage('alpha', WORKER_DIR, 700));
    const pid = first(r.atResolve, 'start').pid;
    check('D1 resolves error "timeout" at ~700 ms', r.result.error === 'timeout' && r.tResolved - r.t0 >= 690 && r.tResolved - r.t0 <= 1000, `${r.tResolved - r.t0}ms err=${r.result.error}`);
    check('D2 child got the request', !!first(r.atResolve, 'request'));
    await waitGone(pid, 4500);
    const log = r.log();
    const dt = first(log, 'sigterm') ? first(log, 'sigterm').t - r.tResolved : NaN;
    check('D3 stdin ended at once, SIGTERM ~3000 ms after the timeout', !!first(log, 'stdin-end') && dt >= 2900 && dt <= 3400, `${dt}ms`);
  }

  console.log('--- E. child exits without answering: settle on exit');
  {
    const r = await run('E', 'exit-early', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const log = r.log();
    const dt = r.tResolved - first(log, 'exit').t;
    check('E1 error carries stderr', r.result.error === 'claude exited: boom: not logged in\n' || /^claude exited: boom: not logged in/.test(r.result.error || ''), JSON.stringify(r.result.error));
    check('E2 resolved within the drain of the exit', dt <= 400, `${dt}ms after exit`);
  }

  console.log('--- F. grandchild holds the pipes open ("close" never comes)');
  {
    const r = await run('F', 'grandchild,exit-early', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const log = r.log();
    const gpid = first(log, 'grandchild').gpid;
    const dt = r.tResolved - first(log, 'exit').t;
    check('F1 grandchild is alive and holding the pipes when we settle', alive(gpid));
    check('F2 settled on exit + <=250 ms drain, not on close', /^claude exited: boom/.test(r.result.error || '') && dt >= 200 && dt <= 500, `${dt}ms after exit`);
    process.kill(gpid, 'SIGKILL');
  }
  {
    const r = await run('F3', 'grandchild', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const pid = first(r.atResolve, 'start').pid;
    await waitGone(pid, 3000);
    const log = r.log();
    check('F3 reading still parsed with a pipe-holding grandchild; child left on stdin end', r.result.available === true && first(log, 'exit') && first(log, 'exit').code === 0 && !first(log, 'sigterm'));
    process.kill(first(log, 'grandchild').gpid, 'SIGKILL');
  }

  console.log('--- H. assorted probe paths');
  {
    const r = await run('H1', 'respond-then-exit', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    check('H1 answer written just before exit is not lost', r.result.available === true && r.result.error === undefined, JSON.stringify(r.result.error));
  }
  {
    const r = await run('H2', 'error-response', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    check('H2 non-success control_response', r.result.error === 'control_response error', JSON.stringify(r.result.error));
    await waitGone(first(r.atResolve, 'start').pid, 3000);
    check('H2b child still ended gracefully after an error reading', first(r.log(), 'exit') && first(r.log(), 'exit').code === 0 && !first(r.log(), 'sigterm'));
  }
  {
    const r = await run('H3', 'no-hello', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    check('H3 no first line: request goes out on the 800 ms timer', r.result.available === true && r.tResolved - r.t0 >= 790, `${r.tResolved - r.t0}ms`);
    await waitGone(first(r.atResolve, 'start').pid, 3000);
  }
  {
    const before = process.memoryUsage().heapUsed;
    const r = await run('H4', 'chatty-after,ignore-stdin', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const pid = first(r.atResolve, 'start').pid;
    await waitGone(pid, 5000);
    const log = r.log();
    const grew = process.memoryUsage().heapUsed - before;
    check('H4 child spewing ~3 MB/s after the reading is drained, not accumulated, and still ended', r.result.available === true && !!first(log, 'sigterm') && first(log, 'exit').code === 143, `heap delta ${(grew / 1e6).toFixed(1)}MB`);
  }
  {
    // exec format failure: an executable file whose interpreter does not exist → async 'error'
    const bad = path.join(S, 'bad-interp');
    fs.writeFileSync(bad, '#!/nonexistent/interpreter\n');
    fs.chmodSync(bad, 0o755);
    const reg = path.join(HOME, '.claude-code-orchestrator', 'registry.json');
    const saved = fs.readFileSync(reg, 'utf8');
    fs.writeFileSync(reg, JSON.stringify({ claudePath: bad, workers: [] }));
    usage.resetProbeCommandMemoForTest();
    const baseTimers = timeouts();
    const r = await run('H5', '', () => usage.fetchAccountUsage('alpha', WORKER_DIR));
    const a = await usage.fetchAuthStatus(WORKER_DIR);
    check('H5 spawn failure: usage resolves an error, auth resolves undefined, nothing thrown', /^spawn failed: /.test(r.result.error || '') && a === undefined, JSON.stringify(r.result.error));
    check('H5b no ladder timers armed for a child that never spawned', timeouts() === baseTimers, `timeouts=${timeouts()} base=${baseTimers}`);
    fs.writeFileSync(reg, saved);
    usage.resetProbeCommandMemoForTest();
  }
  {
    // a config dir that is not a string must not reject (claudeEnv would throw on it)
    let threw = false;
    let u;
    let a;
    let p;
    try {
      u = await usage.fetchAccountUsage('x', undefined);
      a = await usage.fetchAuthStatus(undefined);
      p = await keepalive.pingAccount(FAKE, undefined);
    } catch {
      threw = true;
    }
    check('H6 non-string configDir: all three resolve, none rejects', !threw && /^spawn failed: /.test(u.error || '') && a === undefined && p === false, JSON.stringify(u && u.error));
  }

  console.log('--- M. auth probe');
  {
    const r = await run('M1', '', () => usage.fetchAuthStatus(WORKER_DIR));
    check('M1 logged-in JSON parsed past a leading notice', r.result && r.result.loggedIn === true && r.result.method === 'claude.ai' && r.result.email === 'a@example.com');
    check('M1b argv', JSON.stringify(first(r.log(), 'start').argv) === JSON.stringify(['auth', 'status', '--json']));
    check('M1c child exited by itself, never signalled', first(r.log(), 'exit').code === 0 && !first(r.log(), 'sigterm'));
  }
  {
    const r = await run('M2', 'logged-out', () => usage.fetchAuthStatus(WORKER_DIR));
    check('M2 logged-out answer with exit 1 is still an answer', r.result && r.result.loggedIn === false && r.result.method === 'none' && r.result.email === null);
  }
  {
    const r = await run('M3', 'hang', () => usage.fetchAuthStatus(WORKER_DIR, 500));
    const pid = first(r.atResolve, 'start').pid;
    check('M3 hung CLI: timeout parses what arrived, at ~500 ms', r.result && r.result.loggedIn === true && r.tResolved - r.t0 >= 490 && r.tResolved - r.t0 <= 800, `${r.tResolved - r.t0}ms`);
    await waitGone(pid, 1500);
    const log = r.log();
    const dt = first(log, 'sigterm') ? first(log, 'sigterm').t - r.tResolved : NaN;
    check('M3b no stdin protocol: SIGTERM at once, child exits 143', dt >= -20 && dt <= 250 && first(log, 'exit').code === 143, `${dt}ms`);
  }
  {
    const r = await run('M4', 'hang,ignore-term', () => usage.fetchAuthStatus(WORKER_DIR, 500));
    const pid = first(r.atResolve, 'start').pid;
    await sleep(1500);
    check('M4 SIGTERM ignored: still alive at +1500 ms', alive(pid));
    const gone = await waitGone(pid, 1500);
    const log = r.log();
    const dtTerm = first(log, 'sigterm').t - r.tResolved;
    const dtDead = lastOf(log, 'hb').t - r.tResolved;
    check('M4b SIGKILL 2000 ms after the SIGTERM', gone && dtTerm <= 250 && dtDead >= 1750 && dtDead <= 2350, `sigterm +${dtTerm}ms, last hb +${dtDead}ms`);
  }
  {
    const r = await run('M5', 'grandchild', () => usage.fetchAuthStatus(WORKER_DIR));
    const log = r.log();
    const dt = r.tResolved - first(log, 'exit').t;
    check('M5 pipes held by a grandchild: settles on exit + drain with the JSON', r.result && r.result.loggedIn === true && dt >= 200 && dt <= 500 && alive(first(log, 'grandchild').gpid), `${dt}ms after exit`);
    process.kill(first(log, 'grandchild').gpid, 'SIGKILL');
  }
  {
    const r = await run('M6', 'silent', () => usage.fetchAuthStatus(WORKER_DIR));
    check('M6 no JSON at all → undefined', r.result === undefined);
  }

  console.log('--- N. keepalive ping');
  {
    const r = await run('N1', '', () => keepalive.pingAccount(FAKE, WORKER_DIR));
    check('N1 exit 0 → true', r.result === true);
    check('N1b argv', JSON.stringify(first(r.log(), 'start').argv) === JSON.stringify(['-p', 'Reply with exactly: OK', '--model', 'haiku']));
  }
  {
    const r = await run('N2', 'ping-fail', () => keepalive.pingAccount(FAKE, WORKER_DIR));
    check('N2 exit 3 → false', r.result === false);
  }
  {
    const r = await run('N3', 'hang', () => keepalive.pingAccount(FAKE, WORKER_DIR, 500));
    const pid = first(r.atResolve, 'start').pid;
    check('N3 timeout → false at ~500 ms', r.result === false && r.tResolved - r.t0 >= 490 && r.tResolved - r.t0 <= 800, `${r.tResolved - r.t0}ms`);
    await waitGone(pid, 1500);
    const log = r.log();
    check('N3b SIGTERM at once, exits 143', first(log, 'sigterm') && first(log, 'sigterm').t - r.tResolved <= 250 && first(log, 'exit').code === 143, `${first(log, 'sigterm').t - r.tResolved}ms`);
  }
  {
    const r = await run('N4', 'hang,ignore-term', () => keepalive.pingAccount(FAKE, WORKER_DIR, 500));
    const pid = first(r.atResolve, 'start').pid;
    await sleep(1500);
    const mid = alive(pid);
    const gone = await waitGone(pid, 1500);
    const log = r.log();
    const dtDead = lastOf(log, 'hb').t - r.tResolved;
    check('N4 SIGTERM ignored → SIGKILL 2000 ms later', mid && gone && dtDead >= 1750 && dtDead <= 2350, `last hb +${dtDead}ms`);
  }
  {
    const r = await run('N5', '', () => keepalive.pingAccount('/nonexistent/dir/claude', WORKER_DIR));
    check('N5 ENOENT → false, no throw', r.result === false);
  }

  console.log('--- O. environment (platform.claudeEnv at every spawn site)');
  {
    const envOf = (r) => first(r.log(), 'start').env;
    const stripped = (e) => e.CLAUDECODE === null && e.CLAUDE_CODE_ENTRYPOINT === null && e.CLAUDE_CODE_SESSION_ID === null && e.CLAUDE_CODE_MESSAGING_SOCKET === null && e.CLAUDE_CODE_MESSAGING_TOKEN === null && e.CLAUDE_PROJECT_DIR === null;
    const sites = {
      usage: (dir) => usage.fetchAccountUsage('n', dir),
      auth: (dir) => usage.fetchAuthStatus(dir),
      ping: (dir) => keepalive.pingAccount(FAKE, dir),
    };
    for (const [site, fn] of Object.entries(sites)) {
      const m = await run(`O-${site}-main`, '', () => fn(MAIN_DIR));
      const em = envOf(m);
      check(`O ${site}: main account → CLAUDE_CONFIG_DIR ABSENT, identity stripped, host token kept`, em.CLAUDE_CONFIG_DIR === null && stripped(em) && em.CLAUDE_CODE_OAUTH_TOKEN === 'host-oauth' && em.CLAUDE_CODE_USE_BEDROCK === '1', JSON.stringify(em));
      const w = await run(`O-${site}-worker`, '', () => fn(WORKER_DIR + '/'));
      const ew = envOf(w);
      check(`O ${site}: worker account → dir VERBATIM (trailing slash kept), identity stripped, host token removed`, ew.CLAUDE_CONFIG_DIR === WORKER_DIR + '/' && stripped(ew) && ew.CLAUDE_CODE_OAUTH_TOKEN === null && ew.CLAUDE_CODE_USE_BEDROCK === '1', JSON.stringify(ew));
    }
    process.env.CLAUDE_CONFIG_DIR = MAIN_DIR + '/';
    const h = await run('O-host-explicit', '', () => usage.fetchAccountUsage('n', MAIN_DIR));
    check('O host runs with an explicit dir naming the same directory → the host string is passed through', envOf(h).CLAUDE_CONFIG_DIR === MAIN_DIR + '/', JSON.stringify(envOf(h).CLAUDE_CONFIG_DIR));
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  console.log('--- P. listAccounts');
  {
    const a1 = usage.listAccounts();
    check('P1 env unset → main is ~/.claude; a worker sharing it is not listed twice', a1.length === 2 && a1[0].name === 'main' && a1[0].configDir === MAIN_DIR && a1[1].name === 'alpha' && a1[1].configDir === WORKER_DIR, JSON.stringify(a1));
    process.env.CLAUDE_CONFIG_DIR = '/some/explicit/dir';
    const a2 = usage.listAccounts();
    check('P2 env set → main is that string verbatim', a2[0].configDir === '/some/explicit/dir' && a2.length === 3, JSON.stringify(a2.map((x) => x.configDir)));
    process.env.CLAUDE_CONFIG_DIR = '   ';
    check('P3 blank env → the default dir', usage.listAccounts()[0].configDir === MAIN_DIR);
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  console.log('--- Q. terminateChild / onChildExit used directly');
  {
    const baseTimers = timeouts();
    const never = spawn('/nonexistent/dir/claude', [], { stdio: 'ignore' });
    never.on('error', () => undefined);
    let threw = false;
    try {
      usage.terminateChild(never, 'end-stdin');
      usage.terminateChild(never, 'signal');
      usage.terminateChild(null, 'signal');
      usage.terminateChild({}, 'signal');
      usage.terminateChild(undefined, 'end-stdin');
    } catch {
      threw = true;
    }
    await sleep(50);
    check('Q1 never-spawned child / garbage argument: no throw, no timers', !threw && timeouts() === baseTimers, `timeouts=${timeouts()} base=${baseTimers}`);
  }
  {
    const logFile = path.join(S, 'logs', 'Q2.jsonl');
    fs.rmSync(logFile, { force: true });
    const c = spawn(FAKE, ['-p', 'x'], { stdio: 'ignore', env: { ...process.env, FAKE_MODE: 'hang,ignore-term', FAKE_LOG: logFile } });
    let exitInfo;
    usage.onChildExit(c, (code, signal) => (exitInfo = { code, signal, t: Date.now() }));
    await sleep(400);
    const t = Date.now();
    usage.terminateChild(c, 'signal');
    usage.terminateChild(c, 'signal');
    usage.terminateChild(c, 'end-stdin');
    await waitGone(c.pid, 3000);
    await sleep(50);
    const log = readLog(logFile);
    const terms = log.filter((e) => e.ev === 'sigterm').length;
    check('Q2 three calls on one child = ONE ladder (exactly one SIGTERM), then SIGKILL at 2000 ms', terms === 1 && exitInfo && exitInfo.signal === 'SIGKILL' && exitInfo.t - t >= 1950 && exitInfo.t - t <= 2300, `sigterms=${terms} exit=${JSON.stringify(exitInfo && { signal: exitInfo.signal, dt: exitInfo.t - t })}`);
  }
  {
    const baseTimers = timeouts();
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => c.once('exit', r));
    usage.terminateChild(c, 'signal');
    check('Q3 already-exited child: no-op, no timers', timeouts() === baseTimers);
  }

  console.log(`\nladder: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('UNEXPECTED THROW', e);
  process.exit(3);
});
