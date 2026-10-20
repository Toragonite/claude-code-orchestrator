#!/usr/bin/env node
// cco.mjs — black-box checks of the `cco` command (src/mcp/cli.ts → cli.js) and of the
// per-session dispatch host it talks to (server.js --host), written from
// contract-2.0-fixes.md §15 and src/mcp/host-protocol.ts ONLY — never from cli.ts, host.ts or the
// host code in server.ts: what is tested is the contract, not an implementation.
//
//   node .orchestrator/fixes/cco.mjs                       every section, on the CURRENT sources
//   node .orchestrator/fixes/cco.mjs --only argv,files     some sections
//   node .orchestrator/fixes/cco.mjs --skip-slow           leave out the slow checks (a start lock
//                                                          held through the client's whole 20 s
//                                                          wait; an 80 MiB line on the socket)
//   node .orchestrator/fixes/cco.mjs --keep                leave the scratch directories behind
//   node .orchestrator/fixes/cco.mjs --sources <dir>       as server.mjs: the current tree with every
//                                                          .ts file of <dir> laid over the src/mcp (or
//                                                          src) file of that name
//
// Sections: argv · files · env · start · life · proto · wait · cancel · output · recent · fx3 · turns (and the
// contract checks, which always run). Each check prints `PASS <name>` or
// `FAIL <name> — expected …, observed …`; the last line is the tally; exit 0 only when every
// check passed.
//
// WHAT RUNS. server.ts, run-task.ts, provider-cli.ts and cli.ts are bundled with esbuild into ONE
// scratch directory (never `out/`), so that cli.js finds server.js beside it. Every client is a
// REAL `node <scratch>/cli.js …` process; every host is the real one a client starts.
//
// THE SESSION. A Claude Code session is stood in for by a `sleep 600` this harness starts with
// the workspace as its cwd; its pid is CLAUDE_PID in the client's environment. Killing it is
// "the session ended".
//
// ISOLATION. A client — and so its host, which inherits the client's environment, and every
// worker — gets an environment BUILT HERE: HOME and USERPROFILE inside the sandbox; PATH a scratch
// `bin` holding `node` and stand-ins named claude, codex, cursor-agent and agy, then the system
// directories. No real agent CLI can be resolved by any code path and nothing under the real
// home directory is read or written. The data root is `<sandbox HOME>/.claude-code-orchestrator`.
// The one thing outside the scratch directories is what the contract itself puts there: a socket
// under `/tmp/cco-<uid>/` when a sandbox's run-dir path is too long for sun_path. Those — only the
// ones whose name carries one of THIS run's run-dir hashes — are removed at the end, and the
// directory too when this run made it and it is empty.
//
// LOAD. A section waits while the 1-minute load average is above 30. At the end of every section,
// and on exit (also on failure or Ctrl-C), every process the run started is killed: the session
// stand-ins it tracks, and every process whose command line names a scratch directory.

import keychainGuard from './keychain-guard.cjs';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-cco', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FAKE_SRC = path.join(HERE, 'cco-fake-claude.mjs');

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const SOURCES = opt('--sources') ? path.resolve(opt('--sources')) : undefined;
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : undefined;
const KEEP = argv.includes('--keep');
const SKIP_SLOW = argv.includes('--skip-slow');

/* ------------------------------------------------------------------------- *
 * The contract's values (§15, host-protocol.ts) — written here, and compared with the contract
 * file itself by the contract checks, so that a drift of either side is a FAIL, not a mystery.
 * ------------------------------------------------------------------------- */

const MiB = 1024 * 1024;
const PROTOCOL = 1;
const SPELLING = '~/.claude-code-orchestrator/bin/cco';
const EXIT = { ok: 0, toolError: 20, usage: 21, cannotRun: 22, waitElapsed: 23, signal: 24 };
const RPC = { helloFirst: -32002, protocolMismatch: -32010, wrongSession: -32011, badCredential: -32012, roleForbidden: -32013, invalidRequest: -32600 };
const OUT_CAP = 28_000;
/**
 * FOOTER_RESERVE for a cap and a count of accepted ids — taken from the contract file itself
 * (host-protocol footerReserveChars), not re-written here: since team mode it holds the unread
 * team footer's 300 characters as well (team contract §4.4 item 2, L9), and a cut point this
 * suite computed by its own rule would drift silently the next time the reserve moves. Only
 * callable after build() (the contract file is bundled there).
 */
const footerReserve = (cap, ids = 0) => createRequire(import.meta.url)(PROTO_CJS).footerReserveChars(cap, ids);
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHUTDOWN_REASON = 'cancelled — orchestrator session ended';
const NO_SESSION = "cco runs from a Claude Code session's Bash tool; this shell has no Claude Code session (CLAUDE_PID).";
const MARKER_SENTENCE = (id) =>
  `This shell belongs to a dispatched worker (task ${id}); a dispatched worker cannot dispatch, brief or stop workers. Do the task yourself.`;
const GUARD_SENTENCE = (id) =>
  `This cco-dispatch server runs inside a dispatched worker (task ${id}); a dispatched worker cannot dispatch, brief or stop workers. Do the task yourself.`;
const SANDBOX_SENTENCE = "cco is running inside Claude Code's sandbox, where workers cannot sign in or write their own settings.";
const SKEW_LINE = "cco: ⚠ this session's dispatch host runs an earlier build; start a new Claude Code session to use the new one.";
const stillRunning = (s, ids) =>
  `Still running after ${s} s: ${ids.join(' ')} — the work goes on. Read it with: ${SPELLING} dispatch_status --wait 540 ${ids.join(' ')}`;
const readItLine = (ids) => `Read the result with: ${SPELLING} dispatch_status ${ids.join(' ')}`;
const ACC_RE = /^cco: accepted (\S+) — (.*)$/m;
const FOOTER_RE = /\[cut at (\d+) of (\d+) characters — the full text is in ([^\]\n]+)\]/;

/* ------------------------------------------------------------------------- *
 * Scratch space
 * ------------------------------------------------------------------------- */

const UID = process.getuid();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-cco-')));
// A second scratch directory with a SHORT path: a data root under it keeps its socket in the run
// directory, where the long BASE path takes the /tmp fallback.
const SHORT = fs.realpathSync(fs.mkdtempSync('/tmp/ccoT-'));
const OUT = path.join(BASE, 'out');
const MCP_DIR = path.join(OUT, 'mcp');
const SERVER_JS = path.join(MCP_DIR, 'server.js');
const CLI_JS = path.join(MCP_DIR, 'cli.js');
const PROTO_CJS = path.join(BASE, 'host-protocol.cjs');
const BIN = path.join(BASE, 'bin');
const FAKE = path.join(BASE, 'fake', 'claude-fake.mjs');
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const FALLBACK_DIR = path.join('/tmp', `cco-${UID}`);
const FALLBACK_EXISTED = fs.existsSync(FALLBACK_DIR);
let SERVER_HASH = '';

fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(path.dirname(FAKE), { recursive: true });
fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
fs.copyFileSync(FAKE_SRC, FAKE);
fs.chmodSync(FAKE, 0o755);
// The only `node` and the only agent CLIs a client, a host or a worker started here can find by name.
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
fs.copyFileSync(FAKE_SRC, path.join(BIN, 'claude'));
fs.chmodSync(path.join(BIN, 'claude'), 0o755);
for (const cliName of ['codex', 'cursor-agent', 'agy']) {
  const shim = path.join(BIN, cliName);
  fs.writeFileSync(
    shim,
    '#!/bin/sh\n' + `[ -n "$SRV_FAKE_LOG" ] && echo '{"kind":"vendor-shim","cli":"${cliName}"}' >> "$SRV_FAKE_LOG"\n` + 'exit 1\n',
  );
  fs.chmodSync(shim, 0o755);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sha256hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
function clip(value, max = 400) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…[${flat.length} chars]` : flat;
}
/** PASS / FAIL line. `expected` says what the contract wants, `observed` what was seen. */
function check(name, ok, expected = 'the condition to hold', observed = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} — expected ${expected}, observed ${clip(observed, 700)}`);
  }
  return ok;
}
function brief(r) {
  if (r === undefined) return 'no result: the client had not ended in time';
  return {
    code: r.code,
    signal: r.signal,
    ms: r.elapsedMs,
    ...(r.timedOut ? { timedOut: true } : {}),
    ...(r.pipeHeld ? { pipeHeld: true } : {}),
    stdout: clip(r.stdout, 260),
    stderr: clip(r.stderr, 360),
  };
}

async function calm() {
  const deadline = Date.now() + 10 * 60_000;
  while (os.loadavg()[0] > 30 && Date.now() < deadline) {
    console.log(`  (load average ${os.loadavg()[0].toFixed(1)} — waiting)`);
    await sleep(5000);
  }
}

/** Poll `fn` until it returns a truthy value (returned) or `timeoutMs` passes (undefined). */
async function until(fn, timeoutMs = 10_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = fn();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------------- *
 * Files and processes
 * ------------------------------------------------------------------------- */

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line
    }
  }
  return rows;
}
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};
const isSocket = (file) => {
  try {
    return fs.lstatSync(file).isSocket();
  } catch {
    return false;
  }
};
const modeOf = (file) => {
  try {
    return fs.lstatSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
};
const octal = (m) => (m === undefined ? 'missing' : m.toString(8));
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}
const linesOf = (text) => String(text ?? '').split('\n').filter((l) => l !== '');

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
function killQuietly(pid, signal = 'SIGKILL') {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
/** A pid that names no process: one that just ended. */
function deadPid() {
  for (let i = 0; i < 5; i++) {
    const r = spawnSync('/usr/bin/true');
    if (Number.isInteger(r.pid) && !isPidAlive(r.pid)) return r.pid;
  }
  return 999_999_999;
}
/** Processes whose command line holds `needle`, as { pid, args }. */
function processesMatching(needle) {
  const res = spawnSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const rows = [];
  for (const line of String(res.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes(needle)) rows.push({ pid: Number(m[1]), args: m[2] });
  }
  return rows;
}
function psField(pid, field) {
  const r = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' });
  return String(r.stdout || '').trim();
}
/** registry.processStartedAt's reading: now − etime (±1–2 s, F9). */
function startedAtOf(pid) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(psField(pid, 'etime'));
  if (!m) return undefined;
  const secs = Number(m[1] || 0) * 86_400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Date.now() - secs * 1000;
}
/** The pids above `pid`, nearest first. */
function ancestry(pid) {
  const chain = [];
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const pp = Number(psField(cur, 'ppid'));
    if (!Number.isInteger(pp) || pp <= 0) break;
    chain.push(pp);
    cur = pp;
  }
  return chain;
}
function cwdOf(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  const r = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('n'));
  return line === undefined ? undefined : line.slice(1);
}

/** The socket the contract's one rule gives (§15.1, host-protocol.socketPathFor), re-implemented from the text. */
function socketRule(runDir, pid) {
  const direct = path.join(runDir, `s${pid}.sock`);
  if (Buffer.byteLength(direct, 'utf8') <= 100) return { socket: direct, fallbackDir: undefined };
  const tag = sha256hex(Buffer.from(runDir, 'utf8')).slice(0, 8);
  const socket = path.join(FALLBACK_DIR, `${tag}-s${pid}.sock`);
  return Buffer.byteLength(socket, 'utf8') > 100 ? undefined : { socket, fallbackDir: FALLBACK_DIR };
}

const tracked = { sessions: new Set(), clients: new Set(), conns: new Set(), readOnly: new Set() };

/** Kill everything this run started and may have left: any process whose command line names a scratch dir. */
function killStragglers() {
  for (const needle of [BASE, SHORT]) {
    for (const p of processesMatching(needle)) {
      if (p.pid !== process.pid) killQuietly(p.pid);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Build
 * ------------------------------------------------------------------------- */

async function build() {
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  let src = path.join(REPO, 'src');
  if (SOURCES !== undefined) {
    src = path.join(BASE, 'staged-src');
    fs.cpSync(path.join(REPO, 'src'), src, { recursive: true });
    for (const name of fs.readdirSync(SOURCES).filter((f) => f.endsWith('.ts')).sort()) {
      const target = [path.join(src, 'mcp', name), path.join(src, name)].find((f) => fs.existsSync(f));
      if (target === undefined) throw new Error(`--sources: ${name} is not a file of src/mcp or src`);
      fs.copyFileSync(path.join(SOURCES, name), target);
      console.log(`  using ${path.join(SOURCES, name)} as ${path.relative(src, target)}`);
    }
  }
  const common = { bundle: true, platform: 'node', target: 'node18', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')] };
  // ONE directory: cli.js finds the server as path.join(__dirname, 'server.js') (§15.1).
  for (const entry of ['server', 'run-task', 'provider-cli', 'cli']) {
    await esbuild.build({ ...common, entryPoints: [path.join(src, 'mcp', `${entry}.ts`)], outfile: path.join(MCP_DIR, `${entry}.js`) });
  }
  // The contract file as a module, for the contract checks only.
  await esbuild.build({ ...common, entryPoints: [path.join(src, 'mcp', 'host-protocol.ts')], format: 'cjs', outfile: PROTO_CJS });
  SERVER_HASH = sha256hex(fs.readFileSync(SERVER_JS)).slice(0, 12);
}

/* ------------------------------------------------------------------------- *
 * Sandboxes, sessions, clients
 * ------------------------------------------------------------------------- */

let sandboxSeq = 0;
const sandboxes = [];

/**
 * One isolated installation: a home with the product's data directory in it (two Claude Code
 * workers `wa` and `wb`, the fake as `claudePath`, fresh usage readings so that nothing probes a
 * login), a workspace directory, and the log the fake writes.
 */
function makeSandbox(label, opts = {}) {
  const dir = opts.base ? path.join(opts.base, label) : path.join(BASE, `sb${++sandboxSeq}-${label}`);
  const home = path.join(dir, opts.base ? 'h' : 'home');
  const root = path.join(home, '.claude-code-orchestrator');
  const runDir = path.join(root, 'run');
  const tasksDir = path.join(root, 'tasks');
  const ws = path.join(dir, 'ws');
  const fakeLog = path.join(dir, 'fake.log');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const workers = ['wa', 'wb'].map((name) => ({ name, configDir: path.join(home, 'configs', name), model: 'opus' }));
  for (const w of workers) fs.mkdirSync(w.configDir, { recursive: true });
  const registry = {
    workers,
    permissionMode: 'acceptEdits',
    claudePath: FAKE,
    cooldownMinutes: 30,
    workerTimeoutMinutes: 2,
    frontierWorkerDispatch: 'block',
    overageWorkerDispatch: 'block',
    ...(opts.registry ?? {}),
  };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry, null, 2));
  const now = Date.now();
  const future = new Date(now + 6 * 3_600_000).toISOString();
  const reading = (name, dirOf) => ({
    name,
    configDir: dirOf,
    available: true,
    subscriptionType: 'max',
    windows: [
      { kind: 'session', label: 'Session (5hr)', percent: 5, severity: 'normal', resetsAt: future },
      { kind: 'weekly_all', label: 'Weekly (7 day)', percent: 5, severity: 'normal', resetsAt: future },
    ],
    sessionCostUsd: 0,
    extraUsage: { enabled: false, percent: null, spendLabel: null },
    fetchedAt: now,
    windowsFetchedAt: now,
    windowsStale: false,
    lastGoodWindowsAt: now,
  });
  const usage = { [path.join(home, '.claude')]: reading('main', path.join(home, '.claude')) };
  for (const w of workers) usage[w.configDir] = reading(w.name, w.configDir);
  fs.writeFileSync(path.join(root, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(root, 'stats.json'), '{}');

  const sb = {
    dir,
    home,
    root,
    runDir,
    tasksDir,
    ws,
    fakeLog,
    env(extra = {}) {
      return {
        PATH: `${BIN}:${SYSTEM_PATH}`,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: path.join(BASE, 'tmp'),
        LANG: 'en_US.UTF-8',
        SHELL: '/bin/sh',
        SRV_FAKE_LOG: fakeLog,
        ...keychainGuard.envVars(),
        ...extra,
      };
    },
    filesOf(pid) {
      const base = path.join(runDir, `s${pid}`);
      return {
        record: `${base}.json`,
        lock: `${base}.lock`,
        fail: `${base}.fail`,
        log: `${base}.log`,
        spec: `${base}.spec.json`,
        socket: socketRule(runDir, pid)?.socket,
      };
    },
    recordOf: (pid) => readJson(path.join(runDir, `s${pid}.json`)),
    events: () => readJsonl(path.join(root, 'tasks.jsonl')),
    latest: (id) => readJsonl(path.join(root, 'tasks.jsonl')).filter((e) => e.id === id).pop(),
    fake: () => readJsonl(fakeLog),
    fakeWorkers: () => readJsonl(fakeLog).filter((r) => r.kind === 'worker'),
    fakeMode: (tag) => readJsonl(fakeLog).find((r) => r.kind === 'worker-mode' && r.tag === tag),
    /** A task file in the workspace's .cco/ (the place the installed texts name). */
    task: (name, value) => writeJson(path.join(ws, '.cco', name), value),
  };
  sandboxes.push(sb);
  return sb;
}

/** The session stand-in: a long-lived process whose cwd is the workspace. */
function startSession(cwd) {
  const child = spawn('/bin/sleep', ['600'], { cwd, stdio: 'ignore' });
  tracked.sessions.add(child);
  child.on('exit', () => tracked.sessions.delete(child));
  return {
    pid: child.pid,
    cwd,
    kill: () => killQuietly(child.pid),
    alive: () => isPidAlive(child.pid),
  };
}

/**
 * Start `node <cli.js> …args` and collect what it does. `sb` + `sess` build the environment
 * (CLAUDE_PID = the session's pid unless `sess` is left out); `extraEnv` adds to it, `env`
 * replaces it. The result resolves on 'close' — or, when the pipes stay open more than 3 s after
 * the client exited (something else holds them), with `pipeHeld: true`.
 */
function cli(args, o = {}) {
  const sb = o.sb;
  const env = o.env ?? sb.env({ ...(o.sess ? { CLAUDE_PID: String(o.sess.pid) } : {}), ...(o.extraEnv ?? {}) });
  const startedAt = Date.now();
  const child = spawn(process.execPath, [o.script ?? CLI_JS, ...args], {
    cwd: o.cwd ?? sb.ws,
    env,
    stdio: [o.stdin ?? 'ignore', 'pipe', 'pipe'],
    detached: o.detached === true,
  });
  tracked.clients.add(child);
  const out = [];
  let err = '';
  let partial = '';
  const errLines = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdin?.on?.('error', () => {});
  if (o.pauseStdoutMs) {
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), o.pauseStdoutMs);
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    err += d;
    partial += d;
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      errLines.push({ t: Date.now(), line: partial.slice(0, nl) });
      partial = partial.slice(nl + 1);
    }
  });
  let exitInfo;
  let timedOut = false;
  const done = new Promise((resolve) => {
    let finished = false;
    let pipeTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killQuietly(child.pid);
    }, o.timeoutMs ?? 60_000);
    const finish = (pipeHeld) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      tracked.clients.delete(child);
      if (partial !== '') errLines.push({ t: Date.now(), line: partial });
      try {
        child.stdin?.destroy();
      } catch {
        // already closed
      }
      const bytes = Buffer.concat(out);
      resolve({
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        timedOut,
        pipeHeld,
        stdout: bytes.toString('utf8'),
        stdoutBytes: bytes.length,
        stderr: err,
        errLines,
        startedAt,
        exitedAt: exitInfo?.t ?? Date.now(),
        elapsedMs: (exitInfo?.t ?? Date.now()) - startedAt,
      });
    };
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, t: Date.now() };
      pipeTimer = setTimeout(() => {
        finish(true);
        child.stdout.destroy();
        child.stderr.destroy();
      }, 3000 + (o.pauseStdoutMs ?? 0));
    });
    child.on('close', () => finish(false));
    child.on('error', (e) => {
      err += `\n[spawn error: ${e.message}]`;
      exitInfo = exitInfo ?? { code: null, signal: null, t: Date.now() };
      finish(false);
    });
  });
  return {
    child,
    pid: child.pid,
    done,
    get stderr() {
      return err;
    },
    errLines,
    /** The first match of `re` on stderr so far, waiting up to `ms`. */
    waitStderr: (re, ms = 20_000) => until(() => re.exec(err) ?? undefined, ms, 20),
  };
}
const run = (args, o) => cli(args, o).done;

const acceptedOf = (stderr) => [...String(stderr).matchAll(/^cco: accepted (\S+) — (.*)$/gm)].map((m) => ({ id: m[1], title: m[2] }));
const settledOf = (stderr) => [...String(stderr).matchAll(/^cco: settled (\S+) (\S+)$/gm)].map((m) => ({ id: m[1], status: m[2] }));
/** dispatch_status's records, from its JSON text (anything after the JSON — a still-running line — ignored). */
function recordsOf(stdout) {
  const text = String(stdout ?? '');
  const end = text.indexOf('\nStill running after ');
  try {
    const tasks = JSON.parse(end === -1 ? text : text.slice(0, end)).tasks;
    return Array.isArray(tasks) ? tasks : undefined;
  } catch {
    return undefined;
  }
}
function parseCut(stdout) {
  const m = FOOTER_RE.exec(stdout);
  if (!m) return undefined;
  const after = stdout.slice(m.index + m[0].length);
  return {
    n: Number(m[1]),
    total: Number(m[2]),
    file: m[3],
    footerAt: m.index,
    body: stdout.slice(0, Number(m[1])),
    reports: [...after.matchAll(/^(\S+) {2}report: (.+)$/gm)].map((x) => ({ id: x[1], path: x[2] })),
  };
}
function parseRecent(line) {
  const parts = String(line ?? '').split('  ');
  if (parts.length < 5) return undefined;
  return { id: parts[0], status: parts[1], age: parts[2], worker: parts[3], title: parts.slice(4).join('  ') };
}

/** `server.js --host` processes of sandbox `sb` (of session `pid` when given). */
function hostProcsOf(sb, pid) {
  return processesMatching(' --host ').filter(
    (p) => /server\.js --host /.test(p.args) && p.args.includes(sb.dir) && (pid === undefined || p.args.includes(`${path.sep}s${pid}.spec.json`)),
  );
}
/** What exists of session `pid`'s host: its record, its socket, host and intermediate processes. */
function hostState(sb, pid) {
  const f = sb.filesOf(pid);
  return {
    record: exists(f.record),
    socket: f.socket !== undefined && exists(f.socket),
    hosts: hostProcsOf(sb, pid).map((p) => p.pid),
    intermediates: processesMatching('--cco-launch-host')
      .filter((p) => p.args.includes(sb.dir))
      .map((p) => p.pid),
  };
}
const noHost = (st) => !st.record && !st.socket && st.hosts.length === 0 && st.intermediates.length === 0;
/** After a check found a host that should not exist: remove it, so the next check starts clean. */
function resetHost(sb, pid) {
  for (const p of hostProcsOf(sb, pid)) killQuietly(p.pid);
  const f = sb.filesOf(pid);
  for (const file of [f.record, f.socket, f.lock, f.spec, f.fail]) {
    try {
      if (file) fs.rmSync(file, { force: true });
    } catch {
      // gone
    }
  }
}
/** Sample the host processes of a session, until stopped. */
function sampleHosts(sb, pid) {
  const seen = new Set();
  let peak = 0;
  const timer = setInterval(() => {
    const live = hostProcsOf(sb, pid);
    for (const p of live) seen.add(p.pid);
    if (live.length > peak) peak = live.length;
  }, 50);
  return {
    seen,
    get peak() {
      return peak;
    },
    stop: () => clearInterval(timer),
  };
}

/** A small JSON-RPC client of a socket: every message kept, waits by predicate. */
function connectSocket(file, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const msgs = [];
    let buf = '';
    let closed = false;
    const sock = net.createConnection(file);
    const conn = {
      sock,
      msgs,
      failed: undefined,
      get closed() {
        return closed;
      },
      send(obj) {
        conn.sendRaw(JSON.stringify(obj));
      },
      sendRaw(line) {
        try {
          sock.write(line + '\n');
        } catch {
          // closed
        }
      },
      waitFor: (pred, ms = 10_000) => until(() => msgs.find(pred), ms, 10),
      waitClosed: (ms = 5000) => until(() => closed || undefined, ms, 10).then(Boolean),
      destroy() {
        try {
          sock.destroy();
        } catch {
          // closed
        }
      },
    };
    tracked.conns.add(conn);
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        try {
          msgs.push(JSON.parse(line));
        } catch {
          msgs.push({ unparsable: line.slice(0, 200) });
        }
      }
    });
    sock.on('close', () => {
      closed = true;
      tracked.conns.delete(conn);
    });
    sock.on('error', (e) => {
      conn.failed = e.code ?? e.message;
      closed = true;
      resolve(conn);
    });
    sock.on('connect', () => resolve(conn));
    setTimeout(() => resolve(conn), timeoutMs);
  });
}

/** A real dispatch server over STDIO (no --host), with a small JSON-RPC client. */
function startStdio(sb, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], { cwd: sb.ws, env: sb.env(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
  tracked.clients.add(child);
  const responses = new Map();
  const waiters = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 100;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null) {
        responses.set(msg.id, msg);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w(msg);
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      tracked.clients.delete(child);
      resolve({ code, signal });
    }),
  );
  const send = (m) => {
    try {
      child.stdin.write(JSON.stringify(m) + '\n');
    } catch {
      // gone
    }
  };
  const wait = (id, ms) =>
    responses.has(id)
      ? Promise.resolve(responses.get(id))
      : new Promise((resolve) => {
          const t = setTimeout(() => {
            waiters.delete(id);
            resolve(undefined);
          }, ms);
          waiters.set(id, (m) => {
            clearTimeout(t);
            resolve(m);
          });
        });
  const shape = (msg) => {
    if (msg === undefined) return { timedOut: true, isError: undefined, text: '', hasText: false };
    const item = msg.result?.content?.[0];
    return {
      raw: msg,
      rpcError: msg.error,
      isError: msg.error !== undefined ? true : msg.result?.isError === true,
      text: typeof item?.text === 'string' ? item.text : msg.error ? String(msg.error.message) : '',
      hasText: typeof item?.text === 'string',
    };
  };
  return {
    async request(msg, ms = 15_000) {
      send(msg);
      return shape(await wait(msg.id, ms));
    },
    async call(name, args, ms = 30_000) {
      const id = nextId++;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      return shape(await wait(id, ms));
    },
    async init() {
      const r = await this.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixes-cco', version: '0' } },
      });
      if (r.timedOut) throw new Error(`the stdio server did not answer initialize (stderr ${clip(stderr)})`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async stop() {
      try {
        child.stdin.end();
      } catch {
        // closed
      }
      if ((await Promise.race([exited, sleep(8000).then(() => undefined)])) === undefined) {
        killQuietly(child.pid);
        await Promise.race([exited, sleep(3000)]);
      }
    },
    get stderr() {
      return stderr;
    },
  };
}

/** End a section: the sessions go (their hosts shut down), then whatever is left is killed. */
async function endSection() {
  for (const c of [...tracked.conns]) c.destroy();
  for (const s of [...tracked.sessions]) killQuietly(s.pid);
  await until(() => processesMatching(' --host ').filter((p) => p.args.includes(BASE) || p.args.includes(SHORT)).length === 0 || undefined, 6000, 100);
  for (const c of [...tracked.clients]) killQuietly(c.pid);
  killStragglers();
}

/* ------------------------------------------------------------------------- *
 * Section: contract — the contract file holds what this suite was written from
 * ------------------------------------------------------------------------- */

function sectionContract() {
  const require = createRequire(import.meta.url);
  let hp;
  try {
    hp = require(PROTO_CJS);
  } catch (err) {
    check('contract/host-protocol.ts bundles and loads', false, 'a loadable module', err.message);
    return;
  }
  const want = {
    PROTOCOL_VERSION: PROTOCOL,
    COMMAND_SPELLING: SPELLING,
    DISPATCHED_TASK_ENV: 'CCO_DISPATCHED_TASK',
    TASK_FILE_DIR: '.cco',
    OUTPUT_SUBDIR: 'out',
    TASK_FILE_DIR_GITIGNORE: '*\n',
    HOST_ARG: '--host',
    LAUNCH_HOST_ARG: '--cco-launch-host',
    SESSION_POLL_MS: 2000,
    HOST_START_TIMEOUT_MS: 20_000,
    START_LOCK_STALE_MS: 60_000,
    START_SLACK_MS: 5000,
    HOST_LOG_ROTATE_BYTES: 2 * MiB,
    LINE_MAX_BYTES: 80 * MiB,
    STATUS_WAIT_POLL_MS: 2000,
    STATUS_WAIT_CLIENT_SLACK_MS: 30_000,
    OUT_CAP_CHARS: OUT_CAP,
    OUT_CAP_ENV_MARGIN: 1000,
    OUT_CAP_MIN_ENV: 4000,
    TASK_JSON_MAX_BYTES: 16 * MiB,
    REQUEST_MAX_BYTES: 64 * MiB,
    WAIT_MAX_SECONDS: 86_400,
    RECENT_MAX: 50,
    RECENT_DEFAULT: 10,
    IDS_MAX: 100,
    SOCKET_PATH_MAX_BYTES: 100,
    HOST_REFUSED_EXIT: 3,
    EXIT,
    RPC_ERROR: RPC,
    METHOD: { hello: 'cco/hello', status: 'cco/status', cancel: 'cco/cancel', recent: 'cco/recent', accepted: 'cco/accepted', settled: 'cco/settled' },
    TASK_FILE_KEYS: ['title', 'prompt', 'prompt_file', 'system_prompt', 'system_prompt_file', 'model', 'worker', 'provider', 'ultrathink', 'timeout_minutes', 'detach'],
  };
  const diffs = Object.entries(want)
    .filter(([k, v]) => JSON.stringify(hp[k]) !== JSON.stringify(v))
    .map(([k, v]) => ({ key: k, suite: v, contract: hp[k] }));
  check('contract/host-protocol.ts holds the values this suite was written from', diffs.length === 0, 'no difference', diffs);
  const runDirs = [path.join(SHORT, 'h', '.claude-code-orchestrator', 'run'), path.join(BASE, 'sb0-a-long-sandbox-name', 'home', '.claude-code-orchestrator', 'run')];
  const disagree = [];
  for (const rd of runDirs) {
    for (const pid of [1, 4242, 99_999, 1_234_567_890]) {
      const mine = socketRule(rd, pid);
      let theirs;
      try {
        theirs = hp.socketPathFor(rd, pid, UID);
      } catch (err) {
        theirs = `threw: ${err.message}`;
      }
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) disagree.push({ rd, pid, suite: mine, contract: theirs });
    }
  }
  check("contract/this suite's socket rule, re-implemented from §15.1, agrees with host-protocol.socketPathFor", disagree.length === 0, 'the same answer for every sample', disagree);
}

/* ------------------------------------------------------------------------- *
 * Section: argv — §15.3.1 (P6): every violation → 21 on stderr, nothing on stdout, no host
 * ------------------------------------------------------------------------- */

async function sectionArgv() {
  await calm();
  const sb = makeSandbox('argv');
  const sess = startSession(sb.ws);
  const ok = writeJson(path.join(sb.dir, 'argv-ok.json'), { title: 'argv: must never run', prompt: '[[fake:ok]] [[tag:argv-leak]] must never run' });
  const ids = (n) => Array.from({ length: n }, (_, i) => `targv${i}`);
  const ESC = String.fromCharCode(27);
  // [label, argv, a pattern the stderr must hold (the token named), when the token is plain]
  const cases = [
    ['dispatch_task --wait=5', ['dispatch_task', ok, '--wait=5'], /--wait=5/],
    ['dispatch_task --wait 0', ['dispatch_task', ok, '--wait', '0'], /--wait/],
    ['dispatch_task --wait 1e3', ['dispatch_task', ok, '--wait', '1e3'], /--wait/],
    ['dispatch_task --wait ""', ['dispatch_task', ok, '--wait', ''], /--wait/],
    ['dispatch_task --wait 86401', ['dispatch_task', ok, '--wait', '86401'], /--wait/],
    ['dispatch_task --wait 05 (a leading zero)', ['dispatch_task', ok, '--wait', '05'], /--wait/],
    ['dispatch_task --wait -5', ['dispatch_task', ok, '--wait', '-5'], undefined],
    ['dispatch_task --wait with no value', ['dispatch_task', ok, '--wait'], /--wait/],
    ['dispatch_task --wait twice', ['dispatch_task', ok, '--wait', '5', '--wait', '6'], /--wait/],
    ['dispatch_task --no-wait twice', ['dispatch_task', ok, '--no-wait', '--no-wait'], /--no-wait/],
    ['dispatch_task --wait 5 --no-wait', ['dispatch_task', ok, '--wait', '5', '--no-wait'], undefined],
    ['dispatch_task --no-wait --wait 5', ['dispatch_task', ok, '--no-wait', '--wait', '5'], undefined],
    ['an unknown flag --verbose', ['dispatch_task', ok, '--verbose'], /--verbose/],
    ["another operation's flag: dispatch_task --limit 3", ['dispatch_task', ok, '--limit', '3'], /--limit/],
    ["another operation's flag: dispatch_task --force", ['dispatch_task', ok, '--force'], /--force/],
    ["another operation's flag: recent --wait 5", ['recent', '--wait', '5'], /--wait/],
    ["another operation's flag: list_workers --job j", ['list_workers', '--job', 'j'], /--job/],
    ["another operation's flag: dispatch_status --no-wait", ['dispatch_status', '--no-wait', 'targv1'], /--no-wait/],
    ['-- before the file', ['dispatch_task', '--', ok], /--/],
    ['-- after the file', ['dispatch_task', ok, '--'], /--/],
    ['- as the task file', ['dispatch_task', '-'], /write the task to a file with your Write tool/],
    ['- as the batch file', ['dispatch_tasks', '-'], /write the task to a file with your Write tool/],
    ['dispatch_status with 101 ids', ['dispatch_status', ...ids(101)], undefined],
    ['cancel with 101 ids', ['cancel', ...ids(101)], undefined],
    ['dispatch_status --wait 5 with 101 ids', ['dispatch_status', '--wait', '5', ...ids(101)], undefined],
    ['an id with /', ['dispatch_status', 'a/b'], /a\/b/],
    ['an id ../x', ['dispatch_status', '../x'], /\.\.\/x/],
    ['an id of 129 characters', ['dispatch_status', 't'.repeat(129)], undefined],
    ['an id with a dot', ['cancel', 't1.x'], /t1\.x/],
    ['a good id and an id with /', ['cancel', 'tgood1', 'x/y'], /x\/y/],
    ['dispatch_status with no id', ['dispatch_status'], undefined],
    ['dispatch_status --wait 5 with no id', ['dispatch_status', '--wait', '5'], undefined],
    ['cancel with no id', ['cancel'], undefined],
    ['mesh_stop_worker with --job and --name', ['mesh_stop_worker', '--job', 'j1', '--name', 'n1'], undefined],
    ['mesh_stop_worker with neither --job nor --name', ['mesh_stop_worker'], undefined],
    ['mesh_stop_worker --force alone', ['mesh_stop_worker', '--force'], undefined],
    ['mesh_stop_worker --job ""', ['mesh_stop_worker', '--job', ''], /--job/],
    ['mesh_stop_worker --name of 201 characters', ['mesh_stop_worker', '--name', 'n'.repeat(201)], /--name/],
    ['mesh_stop_worker --name with a newline', ['mesh_stop_worker', '--name', 'a\nb'], /--name/],
    ['mesh_stop_worker --force given a value', ['mesh_stop_worker', '--name', 'w', '--force', 'yes'], /yes|--force/],
    ['recent --limit 0', ['recent', '--limit', '0'], /--limit/],
    ['recent --limit 51', ['recent', '--limit', '51'], /--limit/],
    ['recent --limit 5x', ['recent', '--limit', '5x'], /--limit/],
    ['recent --limit=5', ['recent', '--limit=5'], /--limit=5/],
    ['orchestrator_briefing --model ""', ['orchestrator_briefing', '--model', ''], /--model/],
    ['orchestrator_briefing --model of 101 characters', ['orchestrator_briefing', '--model', 'm'.repeat(101)], /--model/],
    ['orchestrator_briefing --model with an ESC', ['orchestrator_briefing', '--model', `claude${ESC}[31m`], /--model/],
    ['a positional for list_workers', ['list_workers', 'extra'], /extra/],
    ['a positional for recent', ['recent', '5'], undefined],
    ['dispatch_task with no file', ['dispatch_task'], undefined],
    ['dispatch_task with two files', ['dispatch_task', ok, ok], undefined],
    ['an unknown operation', ['frobnicate'], /frobnicate/],
  ];
  try {
    for (const [label, args, want] of cases) {
      const r = await run(args, { sb, sess, timeoutMs: 20_000 });
      const st = hostState(sb, sess.pid);
      const good = r.code === EXIT.usage && r.stdout === '' && r.stderr.trim() !== '' && (want === undefined || want.test(r.stderr)) && noHost(st);
      check(
        `argv/${label} → 21, the token named on stderr, nothing on stdout, no host started`,
        good,
        `exit 21, stdout empty, stderr non-empty${want ? ` matching ${want}` : ''}, no record / socket / host process`,
        { ...brief(r), host: st },
      );
      if (!noHost(st)) resetHost(sb, sess.pid);
    }

    // help and version: exit 0, anywhere.
    const usageOk = (r) => r.code === EXIT.ok && r.stdout.includes(SPELLING) && /dispatch_task/.test(r.stdout) && /dispatch_status/.test(r.stdout);
    for (const [label, args, o] of [
      ['help', ['help'], { sess }],
      ['--help', ['--help'], { sess }],
      ['no operation', [], { sess }],
      ['help with no CLAUDE_PID (it runs anywhere)', ['help'], {}],
      ['help in a dispatched worker’s shell (CCO_DISPATCHED_TASK set)', ['help'], { sess, extraEnv: { CCO_DISPATCHED_TASK: 't1' } }],
    ]) {
      const r = await run(args, { sb, ...o });
      check(`argv/${label} → 0, the usage on stdout with the one spelling`, usageOk(r) && noHost(hostState(sb, sess.pid)), `exit 0, stdout naming ${SPELLING} and the operations, no host`, brief(r));
    }
    const versionRe = /^cco (\S+) protocol (\d+) server ([0-9a-f]{12}|missing)\n?$/;
    for (const [label, o] of [
      ['version', { sess }],
      ['version with no CLAUDE_PID', {}],
      ['version in a dispatched worker’s shell', { sess, extraEnv: { CCO_DISPATCHED_TASK: 't1' } }],
    ]) {
      const r = await run(['version'], { sb, ...o });
      const m = versionRe.exec(r.stdout);
      check(
        `argv/${label} → 0, \`cco <version> protocol 1 server <the 12-hex hash of the server.js beside it>\``,
        r.code === EXIT.ok && m !== null && m[2] === String(PROTOCOL) && m[3] === SERVER_HASH && noHost(hostState(sb, sess.pid)),
        `exit 0 and "cco <v> protocol 1 server ${SERVER_HASH}"`,
        brief(r),
      );
    }
    const lonely = path.join(BASE, 'lonely');
    fs.mkdirSync(lonely, { recursive: true });
    fs.copyFileSync(CLI_JS, path.join(lonely, 'cli.js'));
    const lr = await run(['version'], { sb, sess, script: path.join(lonely, 'cli.js') });
    const lm = versionRe.exec(lr.stdout);
    check('argv/version with no server.js beside cli.js → 0, `server missing`', lr.code === EXIT.ok && lm?.[3] === 'missing', 'exit 0 and "… server missing"', brief(lr));

    await sleep(500);
    check(
      'argv/after every case above: no worker ran and no task was logged',
      sb.fakeMode('argv-leak') === undefined && sb.fakeWorkers().length === 0 && sb.events().length === 0,
      'an empty fake log and task log',
      { workers: sb.fakeWorkers().length, events: sb.events().length },
    );
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: files — §15.3.2 (P5): the task files and the files they name; `.cco/.gitignore`
 * ------------------------------------------------------------------------- */

async function sectionFiles() {
  await calm();
  const sb = makeSandbox('files');
  const sess = startSession(sb.ws);
  const F = path.join(sb.dir, 'f');
  fs.mkdirSync(F, { recursive: true });
  const w = (name, content) => {
    const p = path.join(F, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const wj = (name, value) => w(name, JSON.stringify(value));
  const fifo = (name) => {
    const p = path.join(F, name);
    spawnSync('/usr/bin/mkfifo', [p]);
    return p;
  };
  const leak = '[[fake:ok]] [[tag:files-leak]] must never run';
  const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));
  const NUL = String.fromCharCode(0);
  const BOM = '﻿';

  // [label, () => argv, { stdin, want: [patterns the stderr must hold] }]
  const hostile = [
    ['the task file is a FIFO', () => ['dispatch_task', fifo('task.fifo')]],
    ['the task file is a symbolic link to a FIFO', () => {
      const l = path.join(F, 'link-to-fifo.json');
      fs.symlinkSync(fifo('t2.fifo'), l);
      return ['dispatch_task', l];
    }],
    ['prompt_file is a FIFO', () => ['dispatch_task', wj('pf-fifo.json', { title: 'x', prompt_file: fifo('prompt.fifo') })]],
    ['system_prompt_file is a FIFO', () => ['dispatch_task', wj('sf-fifo.json', { title: 'x', prompt: leak, system_prompt_file: fifo('sys.fifo') })]],
    ['prompt_file is /dev/zero', () => ['dispatch_task', wj('pf-zero.json', { title: 'x', prompt_file: '/dev/zero' })]],
    ['the task file is /dev/zero', () => ['dispatch_task', '/dev/zero']],
    ['the task file is /dev/null', () => ['dispatch_task', '/dev/null']],
    ['the task file is /dev/stdin, a pipe left open (no stdin is ever read)', () => ['dispatch_task', '/dev/stdin'], { stdin: 'pipe' }],
    ['the task file is a directory', () => {
      const d = path.join(F, 'adir.json');
      fs.mkdirSync(d);
      return ['dispatch_task', d];
    }],
    ['prompt_file is a directory', () => {
      fs.mkdirSync(path.join(F, 'pdir'));
      return ['dispatch_task', wj('pf-dir.json', { title: 'x', prompt_file: 'pdir' })];
    }],
    ['prompt_file of 1 MiB + 1 byte', () => {
      w('big-prompt.txt', Buffer.alloc(MiB + 1, 0x61));
      return ['dispatch_task', wj('pf-big.json', { title: 'x', prompt_file: 'big-prompt.txt' })];
    }, { want: [/big-prompt\.txt/, /1048576|1 MiB|1,048,576|1024 KiB/] }],
    ['system_prompt_file of 256 KiB + 1 byte', () => {
      w('big-sys.txt', Buffer.alloc(256 * 1024 + 1, 0x61));
      return ['dispatch_task', wj('sf-big.json', { title: 'x', prompt: leak, system_prompt_file: 'big-sys.txt' })];
    }, { want: [/big-sys\.txt/, /262144|256 KiB|262,144/] }],
    ['a task JSON of 16 MiB + 1 byte', () => {
      const head = JSON.stringify({ title: 'x', prompt: leak });
      return ['dispatch_task', w('huge.json', head + ' '.repeat(16 * MiB + 1 - Buffer.byteLength(head)))];
    }, { want: [/huge\.json/] }],
    ['a batch that inlines past 64 MiB (65 tasks sharing one 1 MiB prompt_file)', () => {
      w('one-mib.txt', Buffer.alloc(MiB, 0x61));
      return ['dispatch_tasks', wj('inline-65.json', { tasks: Array.from({ length: 65 }, (_, i) => ({ title: `b${i}`, prompt_file: 'one-mib.txt' })) })];
    }],
    ['invalid UTF-8 in the task file (Latin-1 é)', () => ['dispatch_task', w('latin1.json', bytes('{"title":"caf', [0xe9], `","prompt":"${leak}"}`))]],
    ['invalid UTF-8 in prompt_file (Latin-1 é)', () => {
      w('latin1.txt', bytes('caf', [0xe9], ' au lait'));
      return ['dispatch_task', wj('pf-latin1.json', { title: 'x', prompt_file: 'latin1.txt' })];
    }],
    ['invalid UTF-8 in prompt_file (an encoded surrogate ED A0 80)', () => {
      w('surrogate.txt', bytes('a', [0xed, 0xa0, 0x80], 'b'));
      return ['dispatch_task', wj('pf-surrogate.json', { title: 'x', prompt_file: 'surrogate.txt' })];
    }],
    ['invalid UTF-8 in system_prompt_file (an overlong C0 AF)', () => {
      w('overlong.txt', bytes('a', [0xc0, 0xaf], 'b'));
      return ['dispatch_task', wj('sf-overlong.json', { title: 'x', prompt: leak, system_prompt_file: 'overlong.txt' })];
    }],
    ['a NUL in prompt_file', () => {
      w('nul.txt', `before${NUL}after`);
      return ['dispatch_task', wj('pf-nul.json', { title: 'x', prompt_file: 'nul.txt' })];
    }],
    ['a NUL in system_prompt_file', () => {
      w('nul-sys.txt', `sys${NUL}tem`);
      return ['dispatch_task', wj('sf-nul.json', { title: 'x', prompt: leak, system_prompt_file: 'nul-sys.txt' })];
    }],
    ['a NUL in the task file', () => ['dispatch_task', w('nul.json', `{"title":"x",${NUL}"prompt":"${leak}"}`)]],
    ['two BOMs before the task JSON (only one is removed)', () => ['dispatch_task', w('two-bom.json', `${BOM}${BOM}${JSON.stringify({ title: 'x', prompt: leak })}`)]],
    ['the unknown key `system-prompt`', () => ['dispatch_task', wj('typo-sys.json', { title: 'x', prompt: leak, 'system-prompt': 'be careful' })], { want: [/system-prompt/, /system_prompt/] }],
    ['the unknown key `promptfile`', () => ['dispatch_task', wj('typo-pf.json', { title: 'x', promptfile: 'p.txt' })], { want: [/promptfile/, /prompt_file/] }],
    ['an unknown key in the 2nd task of a batch', () => ['dispatch_tasks', wj('typo-batch.json', { tasks: [{ title: 'a', prompt: leak }, { title: 'b', prompt: leak, 'system-prompt': 'x' }] })], { want: [/system-prompt/] }],
    ['prompt and prompt_file both', () => {
      w('both.txt', leak);
      return ['dispatch_task', wj('pf-both.json', { title: 'x', prompt: leak, prompt_file: 'both.txt' })];
    }],
    ['neither prompt nor prompt_file', () => ['dispatch_task', wj('pf-none.json', { title: 'x' })]],
    ['system_prompt and system_prompt_file both', () => {
      w('sys-both.txt', 'sys');
      return ['dispatch_task', wj('sf-both.json', { title: 'x', prompt: leak, system_prompt: 's', system_prompt_file: 'sys-both.txt' })];
    }],
    ['prompt_file ""', () => ['dispatch_task', wj('pf-empty.json', { title: 'x', prompt_file: '' })]],
    ['prompt_file a number', () => ['dispatch_task', wj('pf-number.json', { title: 'x', prompt_file: 5 })]],
    ['prompt_file that does not exist', () => ['dispatch_task', wj('pf-missing.json', { title: 'x', prompt_file: 'no-such-prompt.txt' })]],
    ['a task file that does not exist', () => ['dispatch_task', 'no-such-task-file.json']],
    ['dispatch_tasks with a bare array', () => ['dispatch_tasks', wj('bare.json', [{ title: 'x', prompt: leak }])], { want: [/write \{"tasks": \[\.\.\.\]\}/] }],
    ['dispatch_tasks with an extra top-level key', () => ['dispatch_tasks', wj('extra-key.json', { tasks: [{ title: 'x', prompt: leak }], wait: 5 })]],
    ['dispatch_task with a {"tasks": [...]} file', () => ['dispatch_task', wj('batch-as-one.json', { tasks: [{ title: 'x', prompt: leak }] })]],
    ['dispatch_task with an array', () => ['dispatch_task', wj('array.json', [{ title: 'x', prompt: leak }])]],
    ['dispatch_task with null', () => ['dispatch_task', w('null.json', 'null')]],
    ['malformed JSON', () => ['dispatch_task', w('broken.json', '{"title": "x", "prompt": ')]],
  ];
  const tryHostile = async (label, mk, o = {}, prefix = 'files') => {
    let args;
    try {
      args = mk();
    } catch (err) {
      check(`${prefix}/${label}: the case could be set up`, false, 'no error', err.message);
      return undefined;
    }
    const r = await run(args, { sb, sess, timeoutMs: 20_000, stdin: o.stdin });
    const wantOk = (o.want ?? []).every((re) => re.test(r.stderr));
    return { r, wantOk };
  };

  try {
    for (const [label, mk, o = {}] of hostile) {
      const got = await tryHostile(label, mk, o);
      if (got === undefined) continue;
      const st = hostState(sb, sess.pid);
      check(
        `files/${label} → 21 at once, on stderr, nothing sent (no host started)`,
        got.r.code === EXIT.usage && got.r.stdout === '' && got.r.elapsedMs < 8000 && got.wantOk && noHost(st),
        `exit 21 within 8 s, stdout empty${o.want ? `, stderr matching ${o.want.join(' and ')}` : ''}, no record / socket / host`,
        { ...brief(got.r), host: st },
      );
      if (!noHost(st)) resetHost(sb, sess.pid);
    }

    // ---- what is accepted (a host starts here)
    const cco = path.join(sb.ws, '.cco');
    const gi = path.join(cco, '.gitignore');
    const sub = path.join(sb.ws, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    let r = await run(['orchestrator_briefing', '--model', 'claude-opus-5-5'], { sb, sess, cwd: sub, timeoutMs: 60_000 });
    check(
      'files/.gitignore: a briefing (Bash cwd a subdirectory, no .cco yet) → 0 and <workspace>/.cco/.gitignore holding exactly "*\\n"',
      r.code === EXIT.ok && readText(gi) === '*\n' && !exists(path.join(sub, '.cco')),
      'exit 0, <ws>/.cco/.gitignore = "*\\n", nothing under the Bash cwd',
      { ...brief(r), gitignore: readText(gi), underCwd: exists(path.join(sub, '.cco')) },
    );

    fs.writeFileSync(path.join(cco, 'bom.json'), BOM + JSON.stringify({ title: 'bom task', prompt: '[[fake:ok]] [[tag:bomtask]] a task file with a BOM' }));
    r = await run(['dispatch_task', '.cco/bom.json'], { sb, sess, timeoutMs: 60_000 });
    check('files/one BOM before the task JSON is removed — accepted, the task runs', r.code === EXIT.ok && r.stdout.includes('FAKE_OK bomtask'), 'exit 0 and FAKE_OK bomtask', brief(r));

    fs.writeFileSync(path.join(cco, 'bom-prompt.txt'), `${BOM}[[fake:ok]] [[tag:bomprompt]] a prompt file with a BOM`);
    writeJson(path.join(cco, 'bom-prompt.json'), { title: 'bom prompt', prompt_file: 'bom-prompt.txt' });
    r = await run(['dispatch_task', '.cco/bom-prompt.json'], { sb, sess, timeoutMs: 60_000 });
    const bm = sb.fakeMode('bomprompt');
    check('files/one BOM before a prompt_file is removed — the worker gets the text without it', r.code === EXIT.ok && r.stdout.includes('FAKE_OK bomprompt') && bm?.promptBom === false, 'exit 0, the worker’s prompt holding no U+FEFF', { ...brief(r), worker: bm });

    const head = '[[fake:ok]] [[tag:onemib]] ';
    fs.writeFileSync(path.join(cco, 'mib.txt'), head + 'a'.repeat(MiB - head.length));
    writeJson(path.join(cco, 'mib.json'), { title: 'one mebibyte', prompt_file: 'mib.txt' });
    r = await run(['dispatch_task', '.cco/mib.json'], { sb, sess, timeoutMs: 90_000 });
    const mm = sb.fakeMode('onemib');
    check('files/a prompt_file of exactly 1 MiB is accepted and reaches the worker whole', r.code === EXIT.ok && r.stdout.includes('FAKE_OK onemib') && mm?.promptBytes >= MiB, `exit 0 and a prompt of ≥ ${MiB} bytes at the worker`, { ...brief(r), promptBytes: mm?.promptBytes });

    writeJson(path.join(cco, 'ut.json'), { title: 'ultrathink yes', prompt: '[[fake:ok]] [[tag:utyes]] must not run', ultrathink: 'yes' });
    r = await run(['dispatch_task', '.cco/ut.json'], { sb, sess, timeoutMs: 60_000 });
    check('files/"ultrathink": "yes" goes to the host as JSON gave it → the host’s own error, 20 on stdout, nothing runs', r.code === EXIT.toolError && /invalid ultrathink/.test(r.stdout) && sb.fakeMode('utyes') === undefined, 'exit 20 with "invalid ultrathink" on stdout', brief(r));

    const jd = path.join(sb.ws, 'jdir');
    fs.mkdirSync(jd, { recursive: true });
    fs.writeFileSync(path.join(jd, 'p.txt'), '[[fake:ok]] [[tag:reljson]] the prompt beside the JSON');
    fs.writeFileSync(path.join(sb.ws, 'p.txt'), '[[fake:ok]] [[tag:relcwd]] the decoy in the cwd');
    writeJson(path.join(jd, 'rel.json'), { title: 'relative prompt_file', prompt_file: 'p.txt' });
    r = await run(['dispatch_task', 'jdir/rel.json'], { sb, sess, timeoutMs: 60_000 });
    check("files/a relative prompt_file resolves against the JSON file's directory, not the cwd", r.code === EXIT.ok && r.stdout.includes('FAKE_OK reljson') && !r.stdout.includes('relcwd'), 'FAKE_OK reljson', brief(r));

    const deep = path.join(sb.ws, 'deep', 'er');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(cco, 'only-ws.txt'), '[[fake:ok]] [[tag:onlyws]] found under the workspace');
    writeJson(path.join(cco, 'only-ws.json'), { title: 'only under the workspace', prompt_file: 'only-ws.txt' });
    r = await run(['dispatch_task', '.cco/only-ws.json'], { sb, sess, cwd: deep, timeoutMs: 60_000 });
    check('files/a relative task path that exists only under the workspace (Bash cwd a subdirectory) is found there', r.code === EXIT.ok && r.stdout.includes('FAKE_OK onlyws'), 'exit 0 and FAKE_OK onlyws', brief(r));

    const sub2 = path.join(sb.ws, 'sub2');
    writeJson(path.join(sub2, 'both.json'), { title: 'the cwd copy', prompt: '[[fake:ok]] [[tag:cwdwins]] the cwd copy' });
    writeJson(path.join(sb.ws, 'both.json'), { title: 'the workspace copy', prompt: '[[fake:ok]] [[tag:wswins]] the workspace copy' });
    r = await run(['dispatch_task', 'both.json'], { sb, sess, cwd: sub2, timeoutMs: 60_000 });
    check('files/a relative task path that exists under the cwd AND the workspace is taken from the cwd first', r.code === EXIT.ok && r.stdout.includes('FAKE_OK cwdwins') && !r.stdout.includes('wswins'), 'FAKE_OK cwdwins', brief(r));

    fs.writeFileSync(path.join(cco, 'sys.txt'), 'SYSMARK-shared7 You are a careful test worker.');
    writeJson(path.join(cco, 'batch-sys.json'), {
      tasks: [
        { title: 'sys one', prompt: '[[fake:ok]] [[tag:sys1]] first', system_prompt_file: 'sys.txt' },
        { title: 'sys two', prompt: '[[fake:ok]] [[tag:sys2]] second', system_prompt_file: 'sys.txt' },
      ],
    });
    r = await run(['dispatch_tasks', '.cco/batch-sys.json'], { sb, sess, timeoutMs: 60_000 });
    const s1 = sb.fakeMode('sys1');
    const s2 = sb.fakeMode('sys2');
    check(
      'files/one system_prompt_file shared by a batch: accepted, and both workers get its text',
      r.code === EXIT.ok && r.stdout.includes('FAKE_OK sys1') && r.stdout.includes('FAKE_OK sys2') && s1?.sysMarkers?.includes('SYSMARK-shared7') && s2?.sysMarkers?.includes('SYSMARK-shared7'),
      'exit 0, both answers, SYSMARK-shared7 in both workers’ system prompt',
      { ...brief(r), sys1: s1?.sysMarkers, sys2: s2?.sysMarkers },
    );

    // .gitignore: recreated on a task file read inside .cco; never rewritten; never through a link.
    fs.rmSync(gi, { force: true });
    writeJson(path.join(cco, 'gi.json'), { title: 'gitignore', prompt: '[[fake:ok]] [[tag:gi]] recreate' });
    r = await run(['dispatch_task', path.join(cco, 'gi.json')], { sb, sess, timeoutMs: 60_000 });
    check('files/.gitignore: a task file read inside .cco/ (none there) → created, exactly "*\\n"', r.code === EXIT.ok && readText(gi) === '*\n', 'exit 0 and "*\\n"', { ...brief(r), gitignore: readText(gi) });

    fs.writeFileSync(gi, 'keep-me\n');
    const r1 = await run(['orchestrator_briefing', '--model', 'claude-opus-5-5'], { sb, sess, timeoutMs: 60_000 });
    const r2 = await run(['dispatch_task', path.join(cco, 'gi.json')], { sb, sess, timeoutMs: 60_000 });
    check('files/.gitignore with other content is never rewritten (a briefing and a task file read in .cco)', r1.code === EXIT.ok && r2.code === EXIT.ok && readText(gi) === 'keep-me\n', 'both exit 0 and "keep-me\\n" kept', { briefing: r1.code, dispatch: r2.code, gitignore: readText(gi) });

    fs.renameSync(cco, `${cco}-real`);
    const elsewhere = path.join(sb.ws, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, cco);
    writeJson(path.join(elsewhere, 'link.json'), { title: 'through a linked .cco', prompt: '[[fake:ok]] [[tag:linked]] runs' });
    const l1 = await run(['orchestrator_briefing', '--model', 'claude-opus-5-5'], { sb, sess, timeoutMs: 60_000 });
    const l2 = await run(['dispatch_task', '.cco/link.json'], { sb, sess, timeoutMs: 60_000 });
    check(
      'files/.cco a symbolic link → no .gitignore is created through it (briefing, and a task file read inside it)',
      l1.code === EXIT.ok && l2.code === EXIT.ok && !exists(path.join(elsewhere, '.gitignore')) && fs.lstatSync(cco).isSymbolicLink(),
      'both exit 0, no .gitignore in the link target, the link left as it was',
      { briefing: l1.code, dispatch: brief(l2), gitignore: exists(path.join(elsewhere, '.gitignore')) },
    );
    fs.unlinkSync(cco);
    fs.writeFileSync(cco, 'a file, not a directory\n');
    const f1 = await run(['orchestrator_briefing', '--model', 'claude-opus-5-5'], { sb, sess, timeoutMs: 60_000 });
    check('files/.cco a regular file → the briefing still answers (0) and the file is left alone', f1.code === EXIT.ok && readText(cco) === 'a file, not a directory\n', 'exit 0 and the file unchanged', { ...brief(f1), content: readText(cco) });
    fs.rmSync(cco, { force: true });
    fs.renameSync(`${cco}-real`, cco);

    // Hostile files again, with the host running: nothing reaches it.
    const evBefore = sb.events().length;
    const wkBefore = sb.fakeWorkers().length;
    for (const [label, mk, o] of [
      ['a FIFO as the task file', () => ['dispatch_task', fifo('task-again.fifo')]],
      ['the unknown key `system-prompt`', () => ['dispatch_task', wj('typo-again.json', { title: 'x', prompt: leak, 'system-prompt': 'x' })], { want: [/system-prompt/] }],
      ['a NUL in prompt_file', () => ['dispatch_task', wj('pf-nul-again.json', { title: 'x', prompt_file: 'nul.txt' })]],
    ]) {
      const got = await tryHostile(label, mk, o ?? {});
      if (got) check(`files/with the host running: ${label} → 21`, got.r.code === EXIT.usage && got.r.stdout === '' && got.wantOk, 'exit 21, stdout empty', brief(got.r));
    }
    await sleep(500);
    check('files/with the host running: those refusals reached no worker and no task log', sb.events().length === evBefore && sb.fakeWorkers().length === wkBefore, 'the task log and the fake log unchanged', { events: sb.events().length - evBefore, workers: sb.fakeWorkers().length - wkBefore });

    r = await run(['orchestrator_briefing'], { sb, sess, timeoutMs: 60_000 });
    check('files/orchestrator_briefing without --model → refused (21 by the client, or 20 by the host)', r.code === EXIT.usage || r.code === EXIT.toolError, 'exit 21 or 20', brief(r));
    check('files/no refused task file ever reached a worker', sb.fakeMode('files-leak') === undefined, 'no run tagged files-leak', sb.fake().filter((x) => x.tag === 'files-leak'));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: env — §15.3 step 2, §15.5's marker and guard (P7)
 * ------------------------------------------------------------------------- */

async function sectionEnv() {
  await calm();
  const sb = makeSandbox('env');
  const sess = startSession(sb.ws);
  const ok = writeJson(path.join(sb.dir, 'env-ok.json'), { title: 'env: must never run', prompt: '[[fake:ok]] [[tag:env-leak]] must never run' });
  try {
    let r = await run(['list_workers'], { sb });
    check('env/no CLAUDE_PID → 22 with the no-session sentence', r.code === EXIT.cannotRun && r.stderr.includes(NO_SESSION) && r.stdout === '', `exit 22 and "${NO_SESSION}"`, brief(r));
    r = await run(['dispatch_task', '-'], { sb });
    check('env/no CLAUDE_PID and a wrong command line → 22: the environment is judged before the command line', r.code === EXIT.cannotRun && r.stderr.includes(NO_SESSION), 'exit 22 (not 21)', brief(r));
    for (const v of ['', 'abc', '0', '01', '-5', '12345678901', ' 123', '123 ', '1e3']) {
      r = await run(['list_workers'], { sb, extraEnv: { CLAUDE_PID: v } });
      check(`env/CLAUDE_PID=${JSON.stringify(v)} → 22`, r.code === EXIT.cannotRun && r.stderr.includes(NO_SESSION), 'exit 22 with the no-session sentence', brief(r));
    }
    const dead = deadPid();
    r = await run(['list_workers'], { sb, extraEnv: { CLAUDE_PID: String(dead) } });
    check('env/CLAUDE_PID of a process that has ended → 22', r.code === EXIT.cannotRun && r.stderr.includes(NO_SESSION), 'exit 22 with the no-session sentence', { ...brief(r), pid: dead });

    for (const [label, args] of [
      ['dispatch_task', ['dispatch_task', ok]],
      ['dispatch_tasks', ['dispatch_tasks', ok]],
      ['orchestrator_briefing', ['orchestrator_briefing', '--model', 'claude-opus-5-5']],
      ['cancel', ['cancel', 't9']],
      ['list_workers', ['list_workers']],
      ['dispatch_status', ['dispatch_status', 't9']],
      ['recent', ['recent']],
      ['mesh_stop_worker', ['mesh_stop_worker', '--name', 'w']],
      ['a wrong command line (dispatch_task -)', ['dispatch_task', '-']],
    ]) {
      r = await run(args, { sb, sess, extraEnv: { CCO_DISPATCHED_TASK: 't1' } });
      check(`env/CCO_DISPATCHED_TASK=t1 → ${label}: 22 with the dispatched-worker sentence`, r.code === EXIT.cannotRun && r.stderr.includes(MARKER_SENTENCE('t1')) && r.stdout === '', `exit 22 and "${MARKER_SENTENCE('t1')}"`, brief(r));
    }
    r = await run(['list_workers'], { sb, extraEnv: { CCO_DISPATCHED_TASK: 't1' } });
    check('env/CCO_DISPATCHED_TASK set and no CLAUDE_PID → the marker is judged first', r.code === EXIT.cannotRun && r.stderr.includes(MARKER_SENTENCE('t1')), 'exit 22 with the dispatched-worker sentence', brief(r));
    const st = hostState(sb, sess.pid);
    check('env/none of the refusals above started a host', noHost(st), 'no record / socket / host process', st);

    // The MCP server over STDIO, inside a dispatched worker.
    const srv = startStdio(sb, { CCO_DISPATCHED_TASK: 't1' });
    try {
      await srv.init();
      for (const [tool, args] of [
        ['dispatch_task', { title: 'guarded', prompt: '[[fake:ok]] [[tag:stdio-leak]] must not run' }],
        ['dispatch_tasks', { tasks: [{ title: 'guarded', prompt: '[[fake:ok]] [[tag:stdio-leak]] must not run' }] }],
        ['orchestrator_briefing', { model: 'claude-opus-5-5' }],
        ['mesh_stop_worker', { name: 'cco-w-x' }],
      ]) {
        const a = await srv.call(tool, args, 30_000);
        check(`env/stdio server with CCO_DISPATCHED_TASK=t1: ${tool} → isError with the guard sentence`, a.isError === true && a.text.includes(GUARD_SENTENCE('t1')), `isError and "${GUARD_SENTENCE('t1')}"`, { isError: a.isError, text: clip(a.text, 300) });
      }
      for (const tool of ['list_workers', 'dispatch_status', 'mesh_status']) {
        const a = await srv.call(tool, tool === 'dispatch_status' ? { id: 'tnope' } : {}, 40_000);
        const answered = a.hasText && !a.text.includes('runs inside a dispatched worker') && (tool === 'mesh_status' || a.isError === false);
        check(`env/stdio server with CCO_DISPATCHED_TASK=t1: ${tool} still answers`, answered, 'an answer that is not the guard', { isError: a.isError, text: clip(a.text, 200) });
      }
      let i = 0;
      for (const method of ['cco/hello', 'cco/status', 'cco/cancel', 'cco/recent']) {
        const a = await srv.request({ jsonrpc: '2.0', id: 700 + i++, method, params: {} });
        check(`env/stdio: ${method} → -32601`, a.rpcError?.code === -32601, 'JSON-RPC error -32601', a.raw ?? 'no answer');
      }
      await sleep(400);
      // A check-in may be touched by any call (activity); the refused briefing must not have recorded its model.
      const checkin = readText(path.join(sb.root, 'orchestrators.json')) ?? '';
      check('env/stdio guard: no worker started, no task logged, the refused briefing recorded no model', sb.fakeWorkers().length === 0 && sb.events().length === 0 && !checkin.includes('claude-opus-5-5'), 'nothing', { workers: sb.fakeWorkers().length, events: sb.events().length, checkin: clip(checkin, 200) });
    } catch (err) {
      check('env/stdio: ran', false, 'no error', err.message);
    } finally {
      await srv.stop();
    }

    // A worker dispatched through cco carries the marker, and cco refuses inside it.
    const inner = writeJson(path.join(sb.ws, 'inner.json'), { title: 'a worker that runs cco', prompt: `[[fake:cco:list_workers]] [[cli:${CLI_JS}]] [[tag:inner]] run cco from inside` });
    r = await run(['dispatch_task', inner], { sb, sess, timeoutMs: 90_000 });
    const acc = acceptedOf(r.stderr)[0];
    const m = sb.fakeMode('inner');
    check('env/a worker dispatched through cco has CCO_DISPATCHED_TASK = its own task id, and no CLAUDE_PID', acc !== undefined && m?.dispatched === acc.id && m?.claudePid === null, `dispatched = ${acc?.id}, claudePid = null`, { accepted: acc, worker: m && { dispatched: m.dispatched, claudePid: m.claudePid } });
    check(
      'env/cco run inside that worker → 22 with the dispatched-worker sentence naming its task',
      r.code === EXIT.ok && r.stdout.includes('CCO_EXIT 22') && acc !== undefined && r.stdout.includes(`dispatched worker (task ${acc.id})`),
      `the worker's answer "CCO_EXIT 22 … (task ${acc?.id}) …"`,
      brief(r),
    );

    // The run directory.
    const sb2 = makeSandbox('envrun');
    const sess2 = startSession(sb2.ws);
    const target = path.join(sb2.dir, 'elsewhere-run');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, sb2.runDir);
    r = await run(['list_workers'], { sb: sb2, sess: sess2, timeoutMs: 40_000 });
    check('env/the run directory is a symbolic link → 22, nothing made through it, no host', r.code === EXIT.cannotRun && fs.readdirSync(target).length === 0 && hostProcsOf(sb2).length === 0, 'exit 22, the link target empty', { ...brief(r), target: fs.readdirSync(target) });
    fs.unlinkSync(sb2.runDir);
    fs.writeFileSync(sb2.runDir, 'not a directory\n');
    r = await run(['list_workers'], { sb: sb2, sess: sess2, timeoutMs: 40_000 });
    check('env/the run directory is a regular file → 22, the file unchanged, no host', r.code === EXIT.cannotRun && readText(sb2.runDir) === 'not a directory\n' && hostProcsOf(sb2).length === 0, 'exit 22', brief(r));
    fs.rmSync(sb2.runDir, { force: true });
    r = await run(['list_workers'], { sb: sb2, sess: sess2, timeoutMs: 40_000 });
    check('env/…once it is gone, cco makes the run directory (0700) and answers', r.code === EXIT.ok && modeOf(sb2.runDir) === 0o700 && fs.lstatSync(sb2.runDir).isDirectory(), 'exit 0 and a 0700 directory', { ...brief(r), mode: octal(modeOf(sb2.runDir)) });
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: start — §15.1, §15.2, §15.3 step 5 (P4)
 * ------------------------------------------------------------------------- */

async function sectionStart() {
  await calm();
  // A long name, so that this sandbox's socket takes the /tmp fallback on any platform's tmpdir.
  const sb = makeSandbox(`start-${'p'.repeat(48)}`);
  const sess = startSession(sb.ws);
  const files = sb.filesOf(sess.pid);
  const expected = socketRule(sb.runDir, sess.pid);
  try {
    const sampler = sampleHosts(sb, sess.pid);
    const clients = Array.from({ length: 5 }, () => cli(['list_workers'], { sb, sess, timeoutMs: 45_000 }));
    const results = await Promise.all(clients.map((c) => c.done));
    await sleep(400);
    sampler.stop();
    const live = hostProcsOf(sb, sess.pid);
    check('start/5 clients at once with no host → all 5 answer: exit 0, the worker list', results.every((r) => r.code === EXIT.ok && /\bwa\b/.test(r.stdout)), 'five exits 0 naming wa', results.map(brief));
    check('start/…exactly ONE `server.js --host` process for that session was ever seen, and it is alive', sampler.seen.size === 1 && live.length === 1 && sampler.seen.has(live[0].pid), 'one host pid', { seen: [...sampler.seen], live: live.map((p) => p.pid) });
    check('start/…no client’s stdout / stderr is held open after it exits (the host is not on its pipes)', results.every((r) => !r.pipeHeld), 'every pipe closed with its client', results.map((r) => r.pipeHeld));
    const hostPid = live[0]?.pid;
    const rec = sb.recordOf(sess.pid);
    const ourStart = startedAtOf(sess.pid);
    check(
      'start/the record s<P>.json: {protocol 1, hostPid, hostStartedAt, session {pid, startedAt}, workspace, socket, serverHash}',
      rec?.protocol === PROTOCOL &&
        hostPid !== undefined &&
        rec?.hostPid === hostPid &&
        typeof rec?.hostStartedAt === 'number' &&
        rec?.session?.pid === sess.pid &&
        typeof rec?.session?.startedAt === 'number' &&
        Math.abs(rec.session.startedAt - ourStart) <= 5000 &&
        rec?.workspace === sb.ws &&
        rec?.socket === expected?.socket &&
        rec?.serverHash === SERVER_HASH,
      JSON.stringify({ protocol: 1, hostPid, session: { pid: sess.pid, startedAt: `≈${ourStart}` }, workspace: sb.ws, socket: expected?.socket, serverHash: SERVER_HASH }),
      rec ?? 'no record',
    );
    check(
      'start/the socket is where the one rule puts it — the /tmp/cco-<uid> fallback for this long run-dir path — mode 0600',
      expected?.fallbackDir !== undefined && isSocket(expected.socket) && modeOf(expected.socket) === 0o600,
      `a socket at ${expected?.socket}, mode 600`,
      { socket: isSocket(expected?.socket ?? ''), mode: octal(modeOf(expected?.socket ?? '')), record: rec?.socket, inRunDir: exists(path.join(sb.runDir, `s${sess.pid}.sock`)) },
    );
    let fb;
    try {
      fb = fs.lstatSync(FALLBACK_DIR);
    } catch {
      fb = undefined;
    }
    check('start/the fallback directory is 0700, the uid’s, and not a link', fb !== undefined && fb.isDirectory() && !fb.isSymbolicLink() && (fb.mode & 0o777) === 0o700 && fb.uid === UID, 'a 0700 directory owned by the uid', fb ? { mode: octal(fb.mode & 0o777), uid: fb.uid, dir: fb.isDirectory() } : 'missing');
    check('start/the run directory is 0700', modeOf(sb.runDir) === 0o700, 'mode 700', octal(modeOf(sb.runDir)));
    check('start/the start spec was removed and the start lock released; the host log exists', !exists(files.spec) && !exists(files.lock) && exists(files.log), 'no spec, no lock, a log', { spec: exists(files.spec), lock: exists(files.lock), log: exists(files.log) });
    const pgid = Number(psField(hostPid, 'pgid'));
    const above = ancestry(hostPid);
    check('start/the host leads its own process group and is not a descendant of the process that ran cco', pgid === hostPid && !above.includes(process.pid), `pgid ${hostPid}, ${process.pid} not among its ancestors`, { pgid, ancestors: above });
    check('start/the host’s cwd is the workspace (the session process’s cwd)', cwdOf(hostPid) === sb.ws, sb.ws, cwdOf(hostPid));
    check('start/no intermediate (--cco-launch-host) is left behind', hostState(sb, sess.pid).intermediates.length === 0, 'none', hostState(sb, sess.pid).intermediates);

    let r = await run(['list_workers'], { sb, sess, cwd: BASE });
    check('start/a client whose cwd is outside the workspace uses the same host', r.code === EXIT.ok && sb.recordOf(sess.pid)?.hostPid === hostPid && hostProcsOf(sb, sess.pid).length === 1, `exit 0 and host ${hostPid} still the one`, { ...brief(r), host: sb.recordOf(sess.pid)?.hostPid });

    // A host SIGKILLed: its socket and record are left; the next client starts another.
    killQuietly(hostPid);
    await until(() => !isPidAlive(hostPid), 5000);
    r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    const rec2 = sb.recordOf(sess.pid);
    check('start/after a SIGKILL of the host (stale socket and record left) the next client starts a new host and answers', r.code === EXIT.ok && rec2?.hostPid !== hostPid && isPidAlive(rec2?.hostPid) && hostProcsOf(sb, sess.pid).length === 1, 'exit 0, a new live hostPid in the record', { ...brief(r), old: hostPid, now: rec2?.hostPid });

    // A start lock whose holder is gone, with its stale spec.
    killQuietly(rec2?.hostPid);
    await until(() => !isPidAlive(rec2?.hostPid), 5000);
    fs.writeFileSync(files.lock, JSON.stringify({ pid: deadPid(), startedAt: Date.now() - 2000 }));
    fs.writeFileSync(files.spec, JSON.stringify({ stale: true }));
    r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    const rec3 = sb.recordOf(sess.pid);
    check('start/a start lock whose holder is gone (and a stale spec) → removed, a host starts, the client answers', r.code === EXIT.ok && !exists(files.lock) && isPidAlive(rec3?.hostPid) && rec3?.hostPid !== rec2?.hostPid && r.elapsedMs < 20_000, 'exit 0 within 20 s, no lock left, a new host', { ...brief(r), lock: exists(files.lock) });

    // A stale fail file.
    killQuietly(rec3?.hostPid);
    await until(() => !isPidAlive(rec3?.hostPid), 5000);
    fs.writeFileSync(files.fail, 'STALE: an earlier host refused to start.\n');
    r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    check('start/a stale s<P>.fail is removed before the start: the client answers and does not print it', r.code === EXIT.ok && !r.stderr.includes('STALE') && !exists(files.fail), 'exit 0, no STALE on stderr, no fail file', { ...brief(r), fail: exists(files.fail) });

    // Build skew.
    const skewDir = path.join(BASE, 'skew', 'mcp');
    fs.mkdirSync(skewDir, { recursive: true });
    for (const name of fs.readdirSync(MCP_DIR)) fs.copyFileSync(path.join(MCP_DIR, name), path.join(skewDir, name));
    fs.appendFileSync(path.join(skewDir, 'server.js'), '\n// a later build\n');
    const before = sb.recordOf(sess.pid)?.hostPid;
    r = await run(['list_workers'], { sb, sess, script: path.join(skewDir, 'cli.js'), timeoutMs: 45_000 });
    check('start/a client beside a different server.js → the skew line on stderr, and the call proceeds on the running host', r.code === EXIT.ok && r.stderr.includes(SKEW_LINE) && sb.recordOf(sess.pid)?.hostPid === before && /\bwa\b/.test(r.stdout), `exit 0 and "${SKEW_LINE}"`, brief(r));
    r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    check('start/…and a client of the host’s own build prints no skew line', r.code === EXIT.ok && !r.stderr.includes('earlier build'), 'no skew line', brief(r));

    // The sandbox check (15.2.2.d): the session's config dir cannot be written.
    const sbx = makeSandbox('start-sbx');
    const cfg = path.join(sbx.home, '.claude');
    fs.mkdirSync(cfg, { recursive: true });
    fs.chmodSync(cfg, 0o555);
    tracked.readOnly.add(cfg);
    const sx1 = startSession(sbx.ws);
    r = await run(['list_workers'], { sb: sbx, sess: sx1, timeoutMs: 45_000 });
    const fx = sbx.filesOf(sx1.pid);
    const ls = (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    };
    const leftovers = () => [...ls(sbx.runDir), ...ls(cfg)].filter((n) => n.startsWith('.cco-write-check-'));
    check('start/~/.claude cannot be written (the sandbox) → the host refuses: 22 with its sentence, within 20 s', r.code === EXIT.cannotRun && r.stderr.includes(SANDBOX_SENTENCE) && r.elapsedMs < 20_000, `exit 22 and "${SANDBOX_SENTENCE} …"`, brief(r));
    check('start/…the refused host left no record, no socket, no process, no write-check file', !exists(fx.record) && !exists(fx.socket) && hostProcsOf(sbx, sx1.pid).length === 0 && leftovers().length === 0, 'nothing left', { record: exists(fx.record), socket: exists(fx.socket), hosts: hostProcsOf(sbx, sx1.pid).map((p) => p.pid), leftovers: leftovers() });
    fs.chmodSync(cfg, 0o755);
    r = await run(['list_workers'], { sb: sbx, sess: sx1, timeoutMs: 45_000 });
    check('start/…once it can be written, the next client starts a host and answers (the old fail file removed)', r.code === EXIT.ok && !exists(fx.fail), 'exit 0, no fail file', { ...brief(r), fail: exists(fx.fail) });
    const ro = path.join(sbx.dir, 'ro-config');
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o555);
    tracked.readOnly.add(ro);
    const sx2 = startSession(sbx.ws);
    r = await run(['list_workers'], { sb: sbx, sess: sx2, extraEnv: { CLAUDE_CONFIG_DIR: ro }, timeoutMs: 45_000 });
    check('start/CLAUDE_CONFIG_DIR names a directory that cannot be written → the same refusal, 22', r.code === EXIT.cannotRun && r.stderr.includes(SANDBOX_SENTENCE) && hostProcsOf(sbx, sx2.pid).length === 0, `exit 22 and "${SANDBOX_SENTENCE} …"`, brief(r));
    fs.chmodSync(ro, 0o755);

    // A short data root: the socket in the run directory itself.
    const sh = makeSandbox('s', { base: SHORT });
    const ssh = startSession(sh.ws);
    const exp = socketRule(sh.runDir, ssh.pid);
    r = await run(['list_workers'], { sb: sh, sess: ssh, timeoutMs: 45_000 });
    const tag = sha256hex(Buffer.from(sh.runDir, 'utf8')).slice(0, 8);
    check(
      'start/a short data root → the socket is <run dir>/s<P>.sock (no fallback), mode 0600, and the record says so',
      r.code === EXIT.ok && exp?.fallbackDir === undefined && isSocket(exp.socket) && modeOf(exp.socket) === 0o600 && sh.recordOf(ssh.pid)?.socket === exp.socket && !exists(path.join(FALLBACK_DIR, `${tag}-s${ssh.pid}.sock`)),
      `exit 0 and a 0600 socket at ${exp?.socket}`,
      { ...brief(r), socket: isSocket(exp?.socket ?? ''), mode: octal(modeOf(exp?.socket ?? '')), record: sh.recordOf(ssh.pid)?.socket },
    );

    if (SKIP_SLOW) {
      console.log('  (the 20 s start-lock wait was skipped: --skip-slow)');
    } else {
      const sl = startSession(sb.ws);
      const holder = startSession(sb.dir);
      const fl = sb.filesOf(sl.pid);
      fs.writeFileSync(fl.lock, JSON.stringify({ pid: holder.pid, startedAt: startedAtOf(holder.pid) ?? Date.now() }));
      r = await run(['list_workers'], { sb, sess: sl, timeoutMs: 70_000 });
      check(
        'start/(slow) a start lock held by a live, young holder and no host coming → the client waits its 20 s, then 22; it starts no host of its own',
        r.code === EXIT.cannotRun && r.elapsedMs >= 15_000 && r.elapsedMs <= 45_000 && hostProcsOf(sb, sl.pid).length === 0,
        'exit 22 after 15–45 s, no host',
        brief(r),
      );
      holder.kill();
      fs.rmSync(fl.lock, { force: true });
    }
  } catch (err) {
    check('start/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: life — §15.2.3/.4, §15.4 "a closed connection is never a cancel" (P1/P2/P3)
 * ------------------------------------------------------------------------- */

async function lifeClientKilled() {
  const sb = makeSandbox('life-a');
  const sess = startSession(sb.ws);
  const f = sb.task('a.json', { title: 'outlives its client', prompt: '[[fake:delay:8000]] [[tag:life-a]] eight seconds' });
  const c = cli(['dispatch_task', f], { sb, sess, detached: true, timeoutMs: 60_000 });
  const acc = await c.waitStderr(ACC_RE, 30_000);
  if (!check('life/a dispatch prints `cco: accepted <id> — <title>` on stderr at once', acc !== undefined && acc[2] === 'outlives its client', 'an accepted line within 30 s', c.stderr)) return;
  const id = acc[1];
  const worker = await until(() => sb.fakeMode('life-a'), 15_000);
  try {
    process.kill(-c.pid, 'SIGKILL');
  } catch {
    killQuietly(c.pid);
  }
  const r = await c.done;
  await sleep(600);
  const rec = sb.recordOf(sess.pid);
  check('life/P2: the client’s whole process group SIGKILLed after `accepted` → the host and the worker live on', r.signal === 'SIGKILL' && isPidAlive(rec?.hostPid) && worker !== undefined && isPidAlive(worker.pid), 'the host and the worker alive', { client: r.signal, host: rec?.hostPid && isPidAlive(rec.hostPid), worker: worker && isPidAlive(worker.pid) });
  const st = await run(['dispatch_status', '--wait', '40', id], { sb, sess, timeoutMs: 90_000 });
  const t = recordsOf(st.stdout)?.[0];
  check('life/P2: …the task completes: `dispatch_status --wait 40 <id>` → 0, done, with its result', st.code === EXIT.ok && t?.status === 'done' && String(t?.result).includes('FAKE_OK life-a'), 'exit 0, done, FAKE_OK life-a', brief(st));
  check('life/the worker ran with CCO_DISPATCHED_TASK = its task id and without CLAUDE_PID', worker?.dispatched === id && worker?.claudePid === null, `dispatched ${id}, no CLAUDE_PID`, worker && { dispatched: worker.dispatched, claudePid: worker.claudePid });
}

async function lifeSessionEnds() {
  const sb = makeSandbox('life-b');
  const sess = startSession(sb.ws);
  const det = sb.task('det.json', { title: 'detached, outlives the session', prompt: '[[fake:delay:12000]] [[tag:life-det]] twelve seconds', detach: true });
  let r = await run(['dispatch_task', det, '--no-wait'], { sb, sess, timeoutMs: 45_000 });
  const detId = acceptedOf(r.stderr)[0]?.id;
  const long = sb.task('long.json', { title: 'ends with its session', prompt: '[[fake:delay:30000]] [[tag:life-p3]] thirty seconds' });
  const c = cli(['dispatch_task', long], { sb, sess, timeoutMs: 90_000 });
  const acc = await c.waitStderr(ACC_RE, 20_000);
  const p3Id = acc?.[1];
  const w3 = await until(() => sb.fakeMode('life-p3'), 15_000);
  const wd = await until(() => sb.fakeMode('life-det'), 15_000);
  const rec = sb.recordOf(sess.pid);
  const files = sb.filesOf(sess.pid);
  if (!check('life/P3: set up — a detached and a one-shot task running in one host', detId && p3Id && w3 && wd && rec?.hostPid, 'both ids, both workers, a record', { detId, p3Id, w3: !!w3, wd: !!wd, rec, stderr: clip(r.stderr) })) return;
  const hostPid = rec.hostPid;
  const t0 = Date.now();
  sess.kill();
  const hostGone = await until(() => !isPidAlive(hostPid), 8000, 50);
  const goneMs = Date.now() - t0;
  check('life/P3: the session process killed → the host is gone within 5 s', hostGone !== undefined && goneMs <= 5000, 'gone in ≤ 5000 ms', { gone: !!hostGone, ms: goneMs });
  check('life/P3: …it removed its socket and its record', !exists(files.socket) && !exists(files.record), 'neither left', { socket: exists(files.socket), record: exists(files.record) });
  const workerGone = await until(() => !isPidAlive(w3.pid), 8000, 50);
  check('life/P3: …its one-shot worker was stopped', workerGone !== undefined, `pid ${w3.pid} gone`, isPidAlive(w3.pid));
  const cr = await Promise.race([c.done, sleep(Math.max(0, t0 + 12_000 - Date.now())).then(() => undefined)]);
  check('life/P3: …the client waiting on that task ended (20, answered as an error, or 22, the host ended) within 12 s', cr !== undefined && (cr.code === EXIT.toolError || cr.code === EXIT.cannotRun), 'exit 20 or 22', brief(cr));
  check('life/P3: …the detached task’s worker lives on after the host', isPidAlive(wd.pid) || sb.latest(detId)?.status === 'done', `pid ${wd.pid} alive or the task done`, { alive: isPidAlive(wd.pid), latest: sb.latest(detId)?.status });
  const sess2 = startSession(sb.ws);
  r = await run(['dispatch_status', '--wait', '40', p3Id, detId], { sb, sess: sess2, timeoutMs: 90_000 });
  const recs = recordsOf(r.stdout) ?? [];
  const a = recs.find((x) => x.id === p3Id);
  const b = recs.find((x) => x.id === detId);
  check(`life/P3: through a NEW session’s host the one-shot task reads error "${SHUTDOWN_REASON}"`, r.code === EXIT.ok && a?.status === 'error' && String(a?.error).includes(SHUTDOWN_REASON), `error with "${SHUTDOWN_REASON}"`, { ...brief(r), record: a });
  check('life/P3: …and the detached task reads done, with its result', b?.status === 'done' && String(b?.result).includes('FAKE_OK life-det'), 'done, FAKE_OK life-det', b);
}

async function lifeHostKilled() {
  const sb = makeSandbox('life-c');
  const sess = startSession(sb.ws);
  const f = sb.task('c.json', { title: 'its host is killed', prompt: '[[fake:delay:8000]] [[tag:life-c]] eight seconds' });
  const c = cli(['dispatch_task', f], { sb, sess, timeoutMs: 60_000 });
  const acc = await c.waitStderr(ACC_RE, 30_000);
  const rec = sb.recordOf(sess.pid);
  const worker = await until(() => sb.fakeMode('life-c'), 15_000);
  if (!check('life/host killed mid-call: set up', acc && rec?.hostPid && worker, 'an accepted id, a host, a worker', { acc: acc?.[1], rec, worker: !!worker })) return;
  const id = acc[1];
  const t0 = Date.now();
  killQuietly(rec.hostPid);
  const cr = await Promise.race([c.done, sleep(10_000).then(() => undefined)]);
  const m = /the dispatch host ended while this call waited \(its log: (.+?)\); read the outcome with `?(\S+) dispatch_status ([^`\n]+?)`?\.?\s*$/m.exec(cr?.stderr ?? '');
  check(
    'life/the host SIGKILLed mid-call → the client exits 22 within 5 s, naming the host log and the status command for its id',
    cr?.code === EXIT.cannotRun && cr.exitedAt - t0 <= 5000 && m !== null && m[1] === sb.filesOf(sess.pid).log && m[2] === SPELLING && m[3].split(/\s+/).includes(id),
    `exit 22 and "the dispatch host ended while this call waited (its log: ${sb.filesOf(sess.pid).log}); read the outcome with \`${SPELLING} dispatch_status ${id}\`"`,
    { ...brief(cr), afterMs: cr ? cr.exitedAt - t0 : undefined },
  );
  const r = await run(['dispatch_status', id], { sb, sess, timeoutMs: 45_000 });
  check('life/…the next client of that session starts a new host and answers for that id', r.code === EXIT.ok && recordsOf(r.stdout)?.[0]?.id === id && sb.recordOf(sess.pid)?.hostPid !== rec.hostPid, 'exit 0, a record of the id, a new host', brief(r));
  killQuietly(worker.pid);
}

async function sectionLife() {
  await calm();
  try {
    await Promise.all(
      [lifeClientKilled, lifeSessionEnds, lifeHostKilled].map((fn) =>
        fn().catch((err) => {
          check(`life/${fn.name}: ran`, false, 'no error', err?.stack ?? String(err));
        }),
      ),
    );
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: proto — §15.4 on the socket itself
 * ------------------------------------------------------------------------- */

async function sectionProto() {
  await calm();
  const sb = makeSandbox('proto');
  const sess = startSession(sb.ws);
  try {
    const r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    const rec = sb.recordOf(sess.pid);
    if (!check('proto/a host is up (list_workers through cco) and its record names the socket', r.code === EXIT.ok && typeof rec?.socket === 'string', 'exit 0 and a record', { ...brief(r), rec })) return;
    const sock = rec.socket;
    const helloParams = (over = {}) => ({ protocol: PROTOCOL, session: { pid: sess.pid, startedAt: rec.session.startedAt }, serverHash: SERVER_HASH, clientPid: process.pid, ...over });
    const helloed = async (over = {}) => {
      const c = await connectSocket(sock);
      c.send({ jsonrpc: '2.0', id: 'hello', method: 'cco/hello', params: helloParams(over) });
      c.hello = await c.waitFor((x) => x.id === 'hello', 8000);
      return c;
    };

    let c = await connectSocket(sock);
    c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    let m = await c.waitFor((x) => x.id === 1, 5000);
    check('proto/ping before hello → -32002 and the connection is closed', m?.error?.code === RPC.helloFirst && (await c.waitClosed(3000)), 'error -32002, then close', { m, closed: c.closed, failed: c.failed });

    c = await connectSocket(sock);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch_task', arguments: { title: 'before hello', prompt: '[[fake:ok]] [[tag:proto-leak]] must not run' } } });
    m = await c.waitFor((x) => x.id === 2, 5000);
    check('proto/tools/call dispatch_task before hello → -32002 and the connection is closed', m?.error?.code === RPC.helloFirst && (await c.waitClosed(3000)), 'error -32002, then close', { m, closed: c.closed });

    c = await helloed({ protocol: 999 });
    check('proto/hello with protocol 999 → -32010', c.hello?.error?.code === RPC.protocolMismatch, 'error -32010', c.hello);
    c.destroy();
    c = await helloed({ session: { pid: process.pid, startedAt: startedAtOf(process.pid) } });
    check('proto/hello naming another live process as the session → -32011', c.hello?.error?.code === RPC.wrongSession, 'error -32011', c.hello);
    c.destroy();
    c = await helloed({ session: { pid: sess.pid, startedAt: rec.session.startedAt - 60_000 } });
    check('proto/hello with the right pid but a startedAt 60 s off → -32011', c.hello?.error?.code === RPC.wrongSession, 'error -32011', c.hello);
    c.destroy();
    c = await helloed({ session: { pid: sess.pid, startedAt: rec.session.startedAt + 2000 } });
    check('proto/hello with a startedAt 2 s off (inside the 5 s slack) → accepted', c.hello?.result !== undefined && c.hello?.error === undefined, 'a result', c.hello);
    c.destroy();

    const a = await helloed();
    const h = a.hello?.result;
    check(
      'proto/hello → {protocol, hostPid, hostStartedAt, workspace, serverHash, dataRoot} of this host',
      h?.protocol === PROTOCOL && h?.hostPid === rec.hostPid && typeof h?.hostStartedAt === 'number' && h?.workspace === sb.ws && h?.serverHash === SERVER_HASH && h?.dataRoot === sb.root,
      JSON.stringify({ protocol: 1, hostPid: rec.hostPid, workspace: sb.ws, serverHash: SERVER_HASH, dataRoot: sb.root }),
      a.hello,
    );
    a.send({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixes-cco', version: '0' } } });
    a.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
    a.send({ jsonrpc: '2.0', id: 12, method: 'ping' });
    const [mi, ml, mp] = await Promise.all([a.waitFor((x) => x.id === 10), a.waitFor((x) => x.id === 11), a.waitFor((x) => x.id === 12)]);
    const names = (ml?.result?.tools ?? []).map((t) => t.name);
    check('proto/initialize, tools/list and ping are answered as on stdio', mi?.result !== undefined && ['dispatch_task', 'dispatch_tasks', 'dispatch_status', 'list_workers'].every((n) => names.includes(n)) && mp?.result !== undefined && mp?.error === undefined, 'three results, the tools listed', { initialize: clip(mi, 120), tools: names, ping: mp });
    a.sendRaw('42');
    m = await a.waitFor((x) => x.error && (x.id === null || x.id === undefined), 5000);
    check('proto/after hello, a line that is not a JSON-RPC object (42) → -32600', m?.error?.code === RPC.invalidRequest, 'error -32600', m ?? a.msgs.slice(-2));
    a.destroy();

    // The same request id on two connections at once: each gets its own answer.
    const x = await helloed();
    const y = await helloed();
    x.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_workers', arguments: {} } });
    y.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'dispatch_status', arguments: { ids: ['tnope1'] } } });
    const [mx, my] = await Promise.all([x.waitFor((q) => q.id === 7, 40_000), y.waitFor((q) => q.id === 7, 40_000)]);
    const tx = mx?.result?.content?.[0]?.text;
    const ty = my?.result?.content?.[0]?.text;
    check('proto/request id 7 on two connections at once → each answered with its own result', typeof tx === 'string' && /\bwa\b/.test(tx) && recordsOf(tx) === undefined && recordsOf(ty)?.[0]?.id === 'tnope1', 'list_workers text on one, a tnope1 record on the other', { x: clip(tx, 120), y: clip(ty, 120) });
    x.destroy();
    y.destroy();

    // A dispatch with a notifications/cancelled on the socket (ignored), cco/status while it runs.
    const d = await helloed();
    d.send({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'dispatch_task', arguments: { title: 'proto: a cancel notification is ignored', prompt: '[[fake:delay:5000]] [[tag:proto-nc]] five seconds' } } });
    const acc = await d.waitFor((q) => q.method === 'cco/accepted', 15_000);
    const ncId = acc?.params?.tasks?.[0]?.id;
    check(
      'proto/cco/accepted carries the client’s own request id and the task’s id and title',
      acc?.params?.requestId === 42 && acc.params.tasks.length === 1 && TASK_ID.test(ncId ?? '') && acc.params.tasks[0].title === 'proto: a cancel notification is ignored',
      '{requestId: 42, tasks: [{id, title}]}',
      acc ?? d.msgs,
    );
    d.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
    const s = await helloed();
    const t0 = Date.now();
    s.send({ jsonrpc: '2.0', id: 'st', method: 'cco/status', params: { ids: [ncId], waitSeconds: 1 } });
    const ms = await s.waitFor((q) => q.id === 'st', 15_000);
    const stMs = Date.now() - t0;
    check(
      'proto/cco/status {waitSeconds: 1} on the running task → answered after ≈ 1–4 s, the id in pending, dispatch_status’s text',
      Array.isArray(ms?.result?.pending) && ms.result.pending.includes(ncId) && typeof ms.result.content?.[0]?.text === 'string' && recordsOf(ms.result.content[0].text)?.[0]?.id === ncId && stMs >= 900 && stMs < 6000,
      'pending [id], a text, 0.9–6 s',
      { ms: stMs, result: clip(ms?.result, 300) },
    );
    const ans = await d.waitFor((q) => q.id === 42, 30_000);
    const settled = d.msgs.find((q) => q.method === 'cco/settled' && q.params?.id === ncId);
    check('proto/notifications/cancelled on a socket is ignored — the dispatch completes and is answered', ans?.result !== undefined && ans.result.isError !== true && String(ans.result.content?.[0]?.text).includes('FAKE_OK proto-nc'), 'a non-error answer with FAKE_OK proto-nc', ans);
    check('proto/cco/settled {requestId: 42, id, status: "done"} arrives for it', settled?.params?.requestId === 42 && settled?.params?.status === 'done', 'a settled notification', settled ?? d.msgs.filter((q) => q.method));
    check('proto/the answer and the task log carry the id announced in cco/accepted', String(ans?.result?.content?.[0]?.text).includes(ncId) && sb.latest(ncId)?.status === 'done', `${ncId} in the answer, its last event done`, { latest: sb.latest(ncId)?.status });
    d.destroy();
    s.destroy();

    // A connection that closes mid-dispatch is not a cancel.
    const e = await helloed();
    e.send({ jsonrpc: '2.0', id: 'req-close', method: 'tools/call', params: { name: 'dispatch_task', arguments: { title: 'proto: its client goes away', prompt: '[[fake:delay:3000]] [[tag:proto-close]] three seconds' } } });
    const acc2 = await e.waitFor((q) => q.method === 'cco/accepted', 15_000);
    const closeId = acc2?.params?.tasks?.[0]?.id;
    check('proto/a string request id comes back as itself in cco/accepted', acc2?.params?.requestId === 'req-close', 'requestId "req-close"', acc2);
    e.destroy();
    const done = await until(() => sb.latest(closeId)?.status === 'done', 25_000, 100);
    check('proto/a connection closed mid-dispatch is not a cancel — the task completes done', done === true, 'its last event done', sb.latest(closeId));

    const f = await helloed();
    f.send({ jsonrpc: '2.0', id: 'cn', method: 'cco/cancel', params: { ids: ['tnope9'] } });
    f.send({ jsonrpc: '2.0', id: 'rc', method: 'cco/recent', params: { limit: 2 } });
    const [mc, mr] = await Promise.all([f.waitFor((q) => q.id === 'cn'), f.waitFor((q) => q.id === 'rc')]);
    check('proto/cco/cancel of an unknown id → {text "tnope9: not found", isError false}', mc?.result?.isError === false && String(mc.result.content?.[0]?.text).trim() === 'tnope9: not found', '"tnope9: not found"', mc);
    check('proto/cco/recent {limit: 2} → a text of at most 2 lines', typeof mr?.result?.content?.[0]?.text === 'string' && linesOf(mr.result.content[0].text).length <= 2, 'a text, ≤ 2 lines', mr);
    f.destroy();

    if (SKIP_SLOW) {
      console.log('  (the 80 MiB line was skipped: --skip-slow)');
    } else {
      const g = await helloed();
      const chunk = Buffer.alloc(MiB, 0x61);
      for (let i = 0; i < 81 && !g.closed; i++) {
        await Promise.race([
          new Promise((resolve) => {
            if (g.sock.write(chunk)) resolve(true);
            else g.sock.once('drain', () => resolve(true));
          }),
          sleep(5000),
        ]);
      }
      g.sendRaw('');
      const big = await g.waitFor((q) => q.error?.code === RPC.invalidRequest, 20_000);
      const closed = await g.waitClosed(10_000);
      check('proto/(slow) a line longer than 80 MiB → -32600 and that connection is closed', big !== undefined && closed, 'error -32600, then close', { got: g.msgs.slice(-2), closed });
    }
    const alive = await helloed();
    alive.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    const pm = await alive.waitFor((q) => q.id === 'p', 5000);
    check('proto/the host still answers a fresh connection after all of the above', pm?.result !== undefined, 'a ping result', pm);
    alive.destroy();
  } catch (err) {
    check('proto/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: wait — §15.3.3 / §15.3.4: --wait, --no-wait, the plain wait, signals, settles
 * ------------------------------------------------------------------------- */

async function sectionWait() {
  await calm();
  const sb = makeSandbox('wait');
  const sess = startSession(sb.ws);
  try {
    let r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    if (!check('wait/a host is up', r.code === EXIT.ok, 'exit 0', brief(r))) return;
    const w10 = sb.task('w10.json', { title: 'ten seconds', prompt: '[[fake:delay:10000]] [[tag:wait10]] ten seconds' });
    const nw = sb.task('nw.json', { title: 'no wait', prompt: '[[fake:delay:4000]] [[tag:nowait]] four seconds' });
    const nwb = sb.task('nwb.json', { tasks: [{ title: 'no wait one', prompt: '[[fake:delay:1000]] [[tag:nwb1]] one' }, { title: 'no wait two', prompt: '[[fake:delay:1000]] [[tag:nwb2]] two' }] });
    const q = sb.task('q.json', { title: 'quick', prompt: '[[fake:delay:1500]] [[tag:quick]] a second and a half' });

    const ca = cli(['dispatch_task', w10, '--wait', '2'], { sb, sess, timeoutMs: 40_000 });
    const cb = cli(['dispatch_task', nw, '--no-wait'], { sb, sess, timeoutMs: 40_000 });
    const cbb = cli(['dispatch_tasks', nwb, '--no-wait'], { sb, sess, timeoutMs: 40_000 });
    const cc = cli(['dispatch_task', q], { sb, sess, timeoutMs: 40_000 });
    const sigs = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((s) => ({
      s,
      c: cli(['dispatch_task', sb.task(`sig-${s}.json`, { title: `ended by ${s}`, prompt: `[[fake:delay:6000]] [[tag:sig${s}]] six seconds` })], { sb, sess, timeoutMs: 40_000 }),
    }));
    await Promise.all(
      sigs.map(async (x) => {
        x.acc = await x.c.waitStderr(ACC_RE, 20_000);
        x.sentAt = Date.now();
        killQuietly(x.c.pid, x.s);
        x.r = await x.c.done;
      }),
    );
    const [ra, rb, rbb, rc] = await Promise.all([ca.done, cb.done, cbb.done, cc.done]);

    const idA = acceptedOf(ra.stderr)[0]?.id;
    check(
      'wait/dispatch_task --wait 2 on a 10 s task → 23 after about 2 s; stdout the still-running line with its id',
      ra.code === EXIT.waitElapsed && ra.elapsedMs >= 1800 && ra.elapsedMs < 7000 && idA !== undefined && ra.stdout.split('\n').includes(stillRunning(2, [idA])),
      `exit 23 after 1.8–7 s and "${stillRunning(2, [idA ?? '<id>'])}"`,
      brief(ra),
    );
    check('wait/…its stderr: `cco: accepted <id> — ten seconds`, and no settle line', acceptedOf(ra.stderr)[0]?.title === 'ten seconds' && settledOf(ra.stderr).length === 0, 'the accepted line only', ra.stderr);
    if (idA !== undefined) {
      const rg = await run(['dispatch_status', '--wait', '2', idA], { sb, sess, timeoutMs: 60_000 });
      check(
        'wait/dispatch_status --wait 2 on it while it runs → 23: the status text (running), then the still-running line',
        rg.code === EXIT.waitElapsed && recordsOf(rg.stdout)?.[0]?.status === 'running' && rg.stdout.split('\n').includes(stillRunning(2, [idA])) && rg.elapsedMs >= 1800,
        `exit 23, a running record, "${stillRunning(2, [idA])}"`,
        brief(rg),
      );
      const rh = await run(['dispatch_status', '--wait', '40', idA], { sb, sess, timeoutMs: 90_000 });
      const t = recordsOf(rh.stdout)?.[0];
      check('wait/dispatch_status --wait 40 → 0 once it is done (within ~2 s of the end), with its result', rh.code === EXIT.ok && t?.status === 'done' && String(t?.result).includes('FAKE_OK wait10') && rh.elapsedMs < 14_000, 'exit 0, done, FAKE_OK wait10', brief(rh));
    }

    const accB = acceptedOf(rb.stderr)[0];
    const lb = linesOf(rb.stdout);
    check(
      'wait/--no-wait → 0 at once: `<id>  <title>` then the read-it line, nothing else',
      rb.code === EXIT.ok && rb.elapsedMs < 3500 && accB !== undefined && lb.length === 2 && lb[0] === `${accB.id}  no wait` && lb[1] === readItLine([accB.id]),
      `exit 0 in < 3.5 s, "${accB?.id}  no wait" and "${readItLine([accB?.id ?? '<id>'])}"`,
      brief(rb),
    );
    check('wait/--no-wait: stderr has `cco: accepted <id> — no wait`', accB?.title === 'no wait', 'the accepted line', rb.stderr);
    const accBB = acceptedOf(rbb.stderr);
    const lbb = linesOf(rbb.stdout);
    check(
      'wait/dispatch_tasks --no-wait → one `<id>  <title>` line per task in order, then one read-it line with both ids',
      rbb.code === EXIT.ok && accBB.length === 2 && lbb.length === 3 && lbb[0] === `${accBB[0].id}  no wait one` && lbb[1] === `${accBB[1].id}  no wait two` && lbb[2] === readItLine([accBB[0].id, accBB[1].id]),
      'three lines',
      brief(rbb),
    );

    const accC = acceptedOf(rc.stderr)[0];
    const el = rc.errLines.map((x) => x.line).filter((l) => l !== '');
    const other = el.filter((l) => !/^cco: (accepted|settled) /.test(l));
    const accAt = rc.errLines.find((x) => x.line.startsWith('cco: accepted '))?.t;
    check('wait/a plain dispatch_task → 0 when done; stdout the answer with its result and id', rc.code === EXIT.ok && rc.stdout.includes('FAKE_OK quick') && accC !== undefined && rc.stdout.includes(accC.id), 'exit 0, FAKE_OK quick and the id', brief(rc));
    check(
      'wait/…stderr: `cco: accepted <id> — quick` at once, later `cco: settled <id> done`; any other line a diagnostic (≤ 5, ≤ 300 chars)',
      el[0] === `cco: accepted ${accC?.id} — quick` && el.indexOf(`cco: settled ${accC?.id} done`) > 0 && accAt !== undefined && rc.exitedAt - accAt >= 1000 && other.length <= 5 && other.every((l) => l.length <= 300),
      'accepted first (≥ 1 s before the exit), then settled done',
      { lines: el, acceptedBeforeExitMs: accAt ? rc.exitedAt - accAt : undefined },
    );

    for (const x of sigs) {
      const id = x.acc?.[1];
      check(
        `wait/${x.s} while it waits → 24 (an exit code, not death by the signal); stdout names the id and the status command`,
        x.r?.code === EXIT.signal && x.r?.signal === null && id !== undefined && x.r.stdout.includes(id) && x.r.stdout.includes('dispatch_status') && x.r.exitedAt - x.sentAt < 3000,
        'exit 24 within 3 s, the id and dispatch_status on stdout',
        brief(x.r),
      );
    }
    const later = [accB?.id, ...accBB.map((a) => a.id), ...sigs.map((x) => x.acc?.[1])].filter(Boolean);
    r = await run(['dispatch_status', '--wait', '40', ...later], { sb, sess, timeoutMs: 90_000 });
    const recs = recordsOf(r.stdout) ?? [];
    check('wait/…the work goes on: the --no-wait tasks and the three signalled ones all read done', r.code === EXIT.ok && later.length === 6 && recs.length === 6 && recs.every((t) => t.status === 'done'), 'exit 0 and six done records', { ...brief(r), statuses: recs.map((t) => `${t.id}:${t.status}`) });

    r = await run(['dispatch_status', '--wait', '86400', 'tnope1'], { sb, sess, timeoutMs: 45_000 });
    check('wait/--wait 86400 (the largest) on an unknown id → 0 at once, not_found', r.code === EXIT.ok && r.elapsedMs < 10_000 && recordsOf(r.stdout)?.[0]?.status === 'not_found', 'exit 0 in < 10 s, not_found', brief(r));
    r = await run(['dispatch_status', '--wait', '1', 'tnope2'], { sb, sess, timeoutMs: 45_000 });
    check('wait/--wait 1 (the smallest) on an unknown id → 0, not_found', r.code === EXIT.ok && recordsOf(r.stdout)?.[0]?.status === 'not_found', 'exit 0, not_found', brief(r));
    const hundred = Array.from({ length: 100 }, (_, i) => `tnope${i}`);
    r = await run(['dispatch_status', ...hundred], { sb, sess, timeoutMs: 45_000 });
    check('wait/dispatch_status with 100 ids (the most) → 0, 100 records in the order given', r.code === EXIT.ok && recordsOf(r.stdout)?.map((t) => t.id).join(',') === hundred.join(','), 'exit 0, 100 records in order', { ...brief(r), n: recordsOf(r.stdout)?.length });
    r = await run(['dispatch_status', 'tdupB', 'tdupA', 'tdupB'], { sb, sess, timeoutMs: 45_000 });
    check('wait/duplicate ids are dropped and the order kept (tdupB tdupA tdupB → tdupB, tdupA)', r.code === EXIT.ok && recordsOf(r.stdout)?.map((t) => t.id).join(',') === 'tdupB,tdupA', 'records tdupB, tdupA', brief(r));
    r = await run(['cancel', 'tdupX', 'tdupX'], { sb, sess, timeoutMs: 45_000 });
    check('wait/…the same for cancel (tdupX tdupX → one line)', r.code === EXIT.ok && linesOf(r.stdout).join('|') === 'tdupX: not found', '"tdupX: not found" once', brief(r));

    // A worker that fails: a single dispatch is an error (20); a batch with a failed task is 0.
    const sf = makeSandbox('wait-fail');
    const sessF = startSession(sf.ws);
    r = await run(['dispatch_task', sf.task('fail.json', { title: 'fails', prompt: '[[fake:fail]] [[tag:wfail]] fails' })], { sb: sf, sess: sessF, timeoutMs: 120_000 });
    const idF = acceptedOf(r.stderr)[0]?.id;
    check('wait/a dispatch whose worker fails → 20, the error answer on stdout, `cco: settled <id> error`', r.code === EXIT.toolError && r.stdout.trim() !== '' && idF !== undefined && settledOf(r.stderr).some((x) => x.id === idF && x.status === 'error'), 'exit 20, settled error', brief(r));
    r = await run(['dispatch_tasks', sf.task('mixed.json', { tasks: [{ title: 'mixed ok', prompt: '[[fake:ok]] [[tag:mixok]] fine' }, { title: 'mixed fail', prompt: '[[fake:fail]] [[tag:mixfail]] fails' }] })], { sb: sf, sess: sessF, timeoutMs: 120_000 });
    const am = acceptedOf(r.stderr);
    const sm = settledOf(r.stderr);
    const okId = am.find((x) => x.title === 'mixed ok')?.id;
    const failId = am.find((x) => x.title === 'mixed fail')?.id;
    check('wait/a batch with a failed task → 0 (read it): settled done for one, error for the other', r.code === EXIT.ok && sm.some((x) => x.id === okId && x.status === 'done') && sm.some((x) => x.id === failId && x.status === 'error'), 'exit 0 and both settle lines', brief(r));
  } catch (err) {
    check('wait/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: cancel — §15.5 per-task cancel (P8)
 * ------------------------------------------------------------------------- */

async function sectionCancel() {
  await calm();
  const sb = makeSandbox('cancel', { registry: { maxConcurrentDispatches: 1 } });
  const s1 = startSession(sb.ws);
  try {
    let r = await run(['dispatch_task', sb.task('done.json', { title: 'cancel: already done', prompt: '[[fake:ok]] [[tag:cdone]] quick' })], { sb, sess: s1, timeoutMs: 60_000 });
    const doneId = acceptedOf(r.stderr)[0]?.id;
    if (!check('cancel/set up: a quick task is done', r.code === EXIT.ok && doneId !== undefined, 'exit 0 and an id', brief(r))) return;

    const batch = cli(['dispatch_tasks', sb.task('pair.json', { tasks: [{ title: 'cancel A', prompt: '[[fake:delay:20000]] [[tag:cA]] twenty seconds' }, { title: 'cancel B', prompt: '[[fake:delay:20000]] [[tag:cB]] twenty seconds' }] })], { sb, sess: s1, timeoutMs: 120_000 });
    await until(() => acceptedOf(batch.stderr).length === 2, 20_000);
    const acc = acceptedOf(batch.stderr);
    const byTitle = Object.fromEntries(acc.map((a) => [a.title, a.id]));
    const first = await until(() => sb.fakeMode('cA') ?? sb.fakeMode('cB'), 20_000);
    await sleep(500);
    check('cancel/at a limit of 1, one task of the batch runs and the other waits', acc.length === 2 && first !== undefined && !(sb.fakeMode('cA') && sb.fakeMode('cB')), 'one worker', { acc, first: first?.tag });
    if (first === undefined || acc.length !== 2) return;
    const R = first.tag === 'cA' ? byTitle['cancel A'] : byTitle['cancel B'];
    const Q = first.tag === 'cA' ? byTitle['cancel B'] : byTitle['cancel A'];
    const qTag = first.tag === 'cA' ? 'cB' : 'cA';

    r = await run(['dispatch_status', Q], { sb, sess: s1 });
    check('cancel/dispatch_status of the waiting id → a record of status queued, "queued — position <n> of <m>, waiting for a dispatch slot"', r.code === EXIT.ok && recordsOf(r.stdout)?.[0]?.status === 'queued' && /queued — position \d+ of \d+, waiting for a dispatch slot/.test(r.stdout), 'status queued and the sentence', brief(r));
    r = await run(['recent', '--limit', '5'], { sb, sess: s1 });
    const p0 = parseRecent(linesOf(r.stdout)[0]);
    check('cancel/recent lists this host’s queued id first, as queued', r.code === EXIT.ok && p0?.id === Q && p0?.status === 'queued', `${Q}  queued … first`, brief(r));

    r = await run(['cancel', Q], { sb, sess: s1 });
    check('cancel/cancel the queued id → 0, `<id>: cancelled before it started`', r.code === EXIT.ok && r.stdout.trim() === `${Q}: cancelled before it started`, `"${Q}: cancelled before it started"`, brief(r));
    r = await run(['dispatch_status', Q], { sb, sess: s1 });
    const qr = recordsOf(r.stdout)?.[0];
    check('cancel/…dispatch_status reads it error "cancelled before it started (cco cancel)", worker -', qr?.status === 'error' && String(qr?.error).includes('cancelled before it started (cco cancel)') && qr?.worker === '-', 'that record', qr ?? brief(r));

    r = await run(['cancel', R], { sb, sess: s1 });
    check('cancel/cancel the running one-shot → 0, `<id>: cancelled — its worker was stopped`', r.code === EXIT.ok && r.stdout.trim() === `${R}: cancelled — its worker was stopped`, `"${R}: cancelled — its worker was stopped"`, brief(r));
    const gone = await until(() => !isPidAlive(first.pid), 10_000, 50);
    check('cancel/…its worker process is gone', gone !== undefined, `pid ${first.pid} gone`, isPidAlive(first.pid));
    r = await run(['dispatch_status', R], { sb, sess: s1 });
    const rr = recordsOf(r.stdout)?.[0];
    check('cancel/…dispatch_status reads it error "cancelled (cco cancel)"', rr?.status === 'error' && String(rr?.error).includes('cancelled (cco cancel)'), 'that record', rr ?? brief(r));

    const br = await batch.done;
    const sections = br.stdout.split(/^===== Task \d+: .* =====$/m).slice(1);
    check('cancel/the batch answers — exit 0 (a batch with failed tasks is 0) — and shows both tasks cancelled', br.code === EXIT.ok && sections.length === 2 && sections.every((s) => /cancel/i.test(s)), 'exit 0, two sections, each saying cancelled', brief(br));
    const sb2 = settledOf(br.stderr);
    check('cancel/…its stderr has `cco: settled <id> error` for both', sb2.some((x) => x.id === Q && x.status === 'error') && sb2.some((x) => x.id === R && x.status === 'error'), 'two settle lines', br.stderr);
    check('cancel/the cancelled queued task never reached a worker', sb.fakeMode(qTag) === undefined, `no run tagged ${qTag}`, sb.fakeMode(qTag));

    r = await run(['cancel', 'tunknownzz9', doneId, Q], { sb, sess: s1 });
    const want = [`tunknownzz9: not found`, `${doneId}: already done`, `${Q}: already error`];
    check('cancel/one call, three ids → one line each, in order: not found, already done, already error', r.code === EXIT.ok && linesOf(r.stdout).join('\n') === want.join('\n'), want.join(' | '), brief(r));

    const account = rr?.worker;
    r = await run(['dispatch_task', sb.task('after.json', { title: 'after the cancel', prompt: '[[fake:ok]] [[tag:cafter]] quick', worker: account })], { sb, sess: s1, timeoutMs: 60_000 });
    check('cancel/no failure or cooldown was recorded against the cancelled task’s account — the next dispatch to it runs there', r.code === EXIT.ok && r.stdout.includes('FAKE_OK cafter') && sb.fakeMode('cafter')?.account === account, `exit 0 on ${account}`, { ...brief(r), ranOn: sb.fakeMode('cafter')?.account });

    r = await run(['dispatch_task', sb.task('det.json', { title: 'cancel: detached', prompt: '[[fake:delay:20000]] [[tag:cdet]] twenty seconds', detach: true }), '--no-wait'], { sb, sess: s1, timeoutMs: 60_000 });
    const D = acceptedOf(r.stderr)[0]?.id;
    const dw = await until(() => sb.fakeMode('cdet'), 20_000);
    r = await run(['cancel', D ?? 'tmissing'], { sb, sess: s1 });
    check('cancel/cancel a detached task → `<id>: cancel requested — its supervisor stops it`', r.code === EXIT.ok && D !== undefined && r.stdout.trim() === `${D}: cancel requested — its supervisor stops it`, `"${D}: cancel requested — its supervisor stops it"`, brief(r));
    const dgone = dw ? await until(() => !isPidAlive(dw.pid), 15_000, 50) : undefined;
    r = await run(['dispatch_status', '--wait', '30', D ?? 'tmissing'], { sb, sess: s1, timeoutMs: 60_000 });
    check('cancel/…its worker is gone and it reads error', dgone !== undefined && recordsOf(r.stdout)?.[0]?.status === 'error', 'worker gone, status error', { workerGone: !!dgone, ...brief(r) });

    r = await run(['dispatch_task', sb.task('x.json', { title: 'cancel: another session', prompt: '[[fake:delay:20000]] [[tag:cX]] twenty seconds' }), '--no-wait'], { sb, sess: s1, timeoutMs: 60_000 });
    const X = acceptedOf(r.stderr)[0]?.id;
    const xw = await until(() => sb.fakeMode('cX'), 25_000);
    const s2 = startSession(sb.ws);
    r = await run(['cancel', X ?? 'tmissing'], { sb, sess: s2, timeoutMs: 45_000 });
    await sleep(500);
    check(
      'cancel/from another session’s host, a task running in this one → `<id>: belongs to another Claude Code session — cancel it there or from the VS Code task list`, and it runs on',
      r.code === EXIT.ok && X !== undefined && r.stdout.trim() === `${X}: belongs to another Claude Code session — cancel it there or from the VS Code task list` && xw !== undefined && isPidAlive(xw.pid),
      'that line and the worker alive',
      { ...brief(r), alive: xw && isPidAlive(xw.pid) },
    );
    r = await run(['cancel', X ?? 'tmissing'], { sb, sess: s1 });
    const xgone = xw ? await until(() => !isPidAlive(xw.pid), 10_000, 50) : undefined;
    check('cancel/…and from its own session it is stopped', r.stdout.trim() === `${X}: cancelled — its worker was stopped` && xgone !== undefined, `"${X}: cancelled — its worker was stopped"`, brief(r));
  } catch (err) {
    check('cancel/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: output — §15.3.4 (P9): the cut, the saved file, the report lines, the pipe
 * ------------------------------------------------------------------------- */

async function sectionOutput() {
  await calm();
  const sb = makeSandbox('output');
  const sess = startSession(sb.ws);
  const outDir = path.join(sb.ws, '.cco', 'out');
  const stamp = (op, id) => new RegExp(`^${esc(outDir)}/\\d{8}-\\d{6}-${op}-${esc(id)}\\.md$`);
  try {
    let r = await run(['dispatch_task', sb.task('big.json', { title: 'three hundred kilobytes', prompt: '[[fake:lines:3000:99]] [[tag:big300]] a long answer' })], { sb, sess, timeoutMs: 90_000 });
    const id = acceptedOf(r.stderr)[0]?.id;
    const cut = parseCut(r.stdout);
    const full = cut ? readText(cut.file) : undefined;
    // Contract §15.12 M3: the cap is OUT_CAP minus what this invocation wrote to stderr (floored at
    // 8,000) — every stderr line of this run (accepted, settled) is written before the answer.
    const capHere = Math.min(OUT_CAP, Math.max(8_000, OUT_CAP - r.stderr.length));
    const limit = capHere - footerReserve(capHere, 1);
    check('output/a 300 KB answer → exit 0, stdout at most 28,000 characters', r.code === EXIT.ok && r.stdout.length <= OUT_CAP && id !== undefined, 'exit 0, ≤ 28000', { ...brief(r), length: r.stdout.length });
    check(
      'output/…the footer `[cut at <n> of <m> characters — the full text is in <path>]`, the path <ws>/.cco/out/<YYYYMMDD-HHMMSS>-dispatch_task-<id>.md',
      cut !== undefined && id !== undefined && stamp('dispatch_task', id).test(cut.file),
      `a footer naming ${outDir}/<stamp>-dispatch_task-${id}.md`,
      cut ?? clip(r.stdout.slice(-400)),
    );
    check(
      'output/…that file holds the full text: m is its length, from BIG_BEGIN through the 3,000th line to BIG_END',
      full !== undefined && cut.total === full.length && full.includes('BIG_BEGIN big300') && full.includes('L003000 ') && full.includes('BIG_END big300') && full.length > 300_000,
      'the whole answer',
      { m: cut?.total, fileLength: full?.length },
    );
    if (full !== undefined) {
      const k = full.lastIndexOf('\n', limit - 1);
      check(
        `output/…stdout before the footer is the first n characters, cut at the last line end before (OUT_CAP − stderr written) − FOOTER_RESERVE (${limit})`,
        cut.body === full.slice(0, cut.n) && cut.n <= limit && (cut.n === k || cut.n === k + 1 || (cut.n === limit && full[limit] === '\n')),
        `n ∈ {${k}, ${k + 1}} and the body equal to the file's first n characters`,
        { n: cut.n, sameBody: cut.body === full.slice(0, cut.n) },
      );
    }
    check(
      'output/…then one `<id>  report: <data root>/tasks/<id>.md` line for the accepted id',
      cut !== undefined && cut.reports.length === 1 && cut.reports[0].id === id && cut.reports[0].path === path.join(sb.tasksDir, `${id}.md`) && exists(cut.reports[0].path),
      `"${id}  report: ${path.join(sb.tasksDir, `${id}.md`)}"`,
      cut?.reports,
    );
    check('output/…stderr still has the accepted and the settled line', acceptedOf(r.stderr).length === 1 && settledOf(r.stderr).some((x) => x.id === id && x.status === 'done'), 'both lines', r.stderr);

    // dispatch_status of it: one JSON line of 300 KB — no line end in the last half → cut at the point.
    r = await run(['dispatch_status', id ?? 'tmissing'], { sb, sess });
    const c2 = parseCut(r.stdout);
    const full2 = c2 ? readText(c2.file) : undefined;
    const at2 = OUT_CAP - footerReserve(OUT_CAP);
    check(`output/dispatch_status of it (a 300 KB single JSON line) → no line end in the last half → cut at exactly ${at2} (no ids accepted: reserve ${footerReserve(OUT_CAP)})`, r.code === EXIT.ok && c2?.n === at2 && full2 !== undefined && c2.body === full2.slice(0, c2.n) && c2.total === full2.length, `n = ${at2}`, { ...brief(r), n: c2?.n, total: c2?.total });
    check('output/…saved as <ws>/.cco/out/<stamp>-dispatch_status-<first id>.md, no report line (not a dispatch)', c2 !== undefined && stamp('dispatch_status', id ?? '').test(c2.file) && c2.reports.length === 0, 'that name, no report lines', c2);
    let parsedFull;
    try {
      parsedFull = JSON.parse(full2 ?? '');
    } catch {
      parsedFull = undefined;
    }
    check('output/…the saved text is the whole answer: it parses, and its result runs to BIG_END', String(parsedFull?.tasks?.[0]?.result).includes('BIG_END big300'), 'parseable JSON with the full result', clip(full2?.slice(-200)));

    for (const [v, cap] of [['10000', 9000], ['4000', 3000], ['3999', OUT_CAP], ['50000', OUT_CAP], ['abc', OUT_CAP], ['12000.5', OUT_CAP]]) {
      r = await run(['dispatch_status', id ?? 'tmissing'], { sb, sess, extraEnv: { BASH_MAX_OUTPUT_LENGTH: v } });
      const c = parseCut(r.stdout);
      const reserve = footerReserve(cap);
      check(`output/BASH_MAX_OUTPUT_LENGTH=${v} → OUT_CAP ${cap}: cut at ${cap - reserve}, stdout ≤ ${cap}`, r.code === EXIT.ok && c?.n === cap - reserve && r.stdout.length <= cap, `n = ${cap - reserve}`, { n: c?.n, length: r.stdout.length });
    }

    r = await run(['dispatch_task', sb.task('ko.json', { title: 'seventy kilobytes of Korean', prompt: '[[fake:wide:23000]] [[tag:ko70]] Korean' })], { sb, sess, pauseStdoutMs: 1500, timeoutMs: 90_000 });
    check(
      'output/a ~70 KB Korean answer under the cap arrives WHOLE through a pipe read 1.5 s late (drained before exit)',
      r.code === EXIT.ok && r.stdout.includes(`BIG_BEGIN ko70\n${'한'.repeat(23_000)}\nBIG_END ko70`) && !r.stdout.includes('�') && parseCut(r.stdout) === undefined && r.stdoutBytes > 65_536,
      'exit 0, all 23,000 characters and BIG_END, no U+FFFD, no cut',
      { code: r.code, bytes: r.stdoutBytes, end: clip(r.stdout.slice(-80)), pipeHeld: r.pipeHeld },
    );

    for (const [label, prefix] of [['even', ''], ['odd', ':x']]) {
      r = await run(['dispatch_task', sb.task(`astral-${label}.json`, { title: `astral ${label}`, prompt: `[[fake:astral:20000${prefix}]] [[tag:astral${label}]] astral` })], { sb, sess, timeoutMs: 90_000 });
      const c = parseCut(r.stdout);
      const whole = c ? readText(c.file) : undefined;
      const body = c ? r.stdout.slice(0, c.footerAt).replace(/\n$/, '') : '';
      check(
        `output/a cut through astral characters (${label} offset) never splits a surrogate pair`,
        r.code === EXIT.ok && c !== undefined && !r.stdout.includes('�') && whole !== undefined && whole.startsWith(body) && !/[\uD800-\uDBFF]$/.test(body) && body.length > 13_000,
        'no U+FFFD on stdout and the body a prefix of the saved text',
        { code: r.code, n: c?.n, fffd: r.stdout.includes('�'), tail: JSON.stringify(body.slice(-4)) },
      );
    }

    r = await run(['dispatch_tasks', sb.task('pair.json', { tasks: [{ title: 'two hundred one', prompt: '[[fake:lines:2000:99]] [[tag:pairone]] long' }, { title: 'two hundred two', prompt: '[[fake:lines:2000:99]] [[tag:pairtwo]] long' }] })], { sb, sess, timeoutMs: 90_000 });
    const ab = acceptedOf(r.stderr);
    const c3 = parseCut(r.stdout);
    const full3 = c3 ? readText(c3.file) : undefined;
    const at3 = OUT_CAP - footerReserve(OUT_CAP, 2);
    check(`output/a batch of two 200 KB answers → exit 0, stdout ≤ 28,000, cut at or before ${at3} (reserve ${footerReserve(OUT_CAP, 2)}: 100 per accepted id included)`, r.code === EXIT.ok && r.stdout.length <= OUT_CAP && c3 !== undefined && c3.n <= at3, `n ≤ ${at3}`, { ...brief(r), n: c3?.n });
    check(
      'output/…one report line per accepted id, in accepted order; the file named after the first id holds both answers',
      ab.length === 2 && c3 !== undefined && c3.reports.map((x) => x.id).join(',') === ab.map((a) => a.id).join(',') && c3.reports.every((x) => x.path === path.join(sb.tasksDir, `${x.id}.md`)) && stamp('dispatch_tasks', ab[0].id).test(c3.file) && String(full3).includes('BIG_END pairone') && String(full3).includes('BIG_END pairtwo'),
      'two report lines and the whole batch saved',
      { accepted: ab.map((a) => a.id), reports: c3?.reports, file: c3?.file },
    );

    // ENOTDIR (the platform's) when .cco/out cannot be made: the cut text is printed regardless.
    if (full2 !== undefined && exists(outDir)) {
      fs.renameSync(outDir, `${outDir}.moved`);
      fs.writeFileSync(outDir, 'a file where the directory was\n');
      r = await run(['dispatch_status', id], { sb, sess });
      check(
        'output/.cco/out cannot be made (a file is there) → still 0: the cut text printed, the footer says it could not be saved, with the errno code',
        r.code === EXIT.ok && /could not be saved: E[A-Z]+/.test(r.stdout) && r.stdout.startsWith(full2.slice(0, 2000)) && r.stdout.length <= OUT_CAP && readText(outDir) === 'a file where the directory was\n',
        'exit 0, "… could not be saved: E…", the same first 2,000 characters',
        { ...brief(r), tail: clip(r.stdout.slice(-300)) },
      );
      fs.rmSync(outDir, { force: true });
      fs.renameSync(`${outDir}.moved`, outDir);
    }
  } catch (err) {
    check('output/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: recent — §15.4 cco/recent (L1)
 * ------------------------------------------------------------------------- */

// RO: what cco-fake-claude.mjs's [[fake:turns:…]] prints (kept in step with it by hand).
const TURNS_AFTERTHOUGHT = 'The progress monitor has expired; there is nothing to re-arm and the report stands.';
const turnsReport = (tag) =>
  [`REPORT_BEGIN ${tag}`, ...Array.from({ length: 40 }, (_, i) => `finding ${i + 1}: the work of ${tag} is done and verified.`), `REPORT_END ${tag}`].join('\n');

async function sectionTurns() {
  await calm();
  const sb = makeSandbox('turns');
  const sess = startSession(sb.ws);
  try {
    const want = `${turnsReport('ccoturns')}\n\n[after a background task finished: ${TURNS_AFTERTHOUGHT}]`;
    let r = await run(['dispatch_task', sb.task('turns.json', { title: 'turns', prompt: '[[fake:turns:user]] [[tag:ccoturns]] a report, then a monitor expires' })], { sb, sess, timeoutMs: 60_000 });
    const id = acceptedOf(r.stderr)[0]?.id;
    const count = (text, part) => String(text).split(part).length - 1;
    check(
      'turns/cco dispatch_task prints the report that answered the prompt, then the background turn marked',
      r.code === EXIT.ok && id !== undefined && r.stdout.includes(`\n\n${want}`) && count(r.stdout, TURNS_AFTERTHOUGHT) === 1,
      'the whole report, then `[after a background task finished: …]`',
      { ...brief(r), stdout: clip(r.stdout, 300) },
    );
    r = await run(['dispatch_status', id ?? 'tmissing'], { sb, sess });
    let result;
    try {
      result = JSON.parse(r.stdout).tasks?.[0]?.result;
    } catch {
      result = undefined;
    }
    check('turns/cco dispatch_status returns the same text', r.code === EXIT.ok && String(result).includes(want) && count(result, TURNS_AFTERTHOUGHT) === 1, 'a result holding the report and the marked turn', { ...brief(r), result: clip(result, 300) });
    // RO2: total_cost_usd is the session's running total — $0.50, then $0.75 — so the task cost $0.75.
    const done = sb.latest(id ?? 'tmissing');
    check('turns/cco the done event: tokens summed (1030 in, 2040 out), cost the last result\'s running total $0.75 — never the sum $1.25 (RO2)', done?.status === 'done' && done.inputTokens === 1030 && done.outputTokens === 2040 && done.costUsd === 0.75, '1030 / 2040 / 0.75', done);
  } finally {
    await endSection();
  }
}

async function sectionRecent() {
  await calm();
  const sb = makeSandbox('recent');
  const sess = startSession(sb.ws);
  try {
    const titles = ['recent zero', 'recent one', 'recent two', 'R'.repeat(150)];
    const ids = [];
    for (let i = 0; i < titles.length; i++) {
      const r = await run(['dispatch_task', sb.task(`r${i}.json`, { title: titles[i], prompt: `[[fake:ok]] [[tag:recent${i}]] quick` })], { sb, sess, timeoutMs: 60_000 });
      const acc = acceptedOf(r.stderr)[0];
      ids.push(acc?.id);
      if (i === 3) {
        check('recent/the accepted line cuts a 150-character title to at most 120 characters', r.code === EXIT.ok && acc !== undefined && acc.title.length <= 120 && acc.title.startsWith('R'.repeat(60)), '≤ 120 characters', { length: acc?.title.length, code: r.code });
      } else if (r.code !== EXIT.ok) {
        check(`recent/set up: dispatch ${i}`, false, 'exit 0', brief(r));
      }
      await sleep(50);
    }
    let r = await run(['recent', '--limit', '3'], { sb, sess });
    const ls = linesOf(r.stdout);
    const parsed = ls.map(parseRecent);
    check('recent/--limit 3 → exactly 3 lines, newest first', r.code === EXIT.ok && ls.length === 3 && parsed.map((p) => p?.id).join(',') === [ids[3], ids[2], ids[1]].join(','), `${ids[3]}, ${ids[2]}, ${ids[1]}`, brief(r));
    check(
      'recent/…each line is `<id>  <status>  <age>  <worker or ->  <title ≤ 80>`',
      parsed.length === 3 && parsed.every((p) => p !== undefined && TASK_ID.test(p.id) && p.status === 'done' && p.age.trim() !== '' && ['wa', 'wb', '-'].includes(p.worker) && p.title.length <= 80),
      'five fields separated by two spaces',
      ls,
    );
    check('recent/…the 150-character title is cut to at most 80; the others are whole', parsed[0]?.title.length <= 80 && parsed[0]?.title.startsWith('RRRR') && parsed[1]?.title === 'recent two' && parsed[2]?.title === 'recent one', 'titles', parsed.map((p) => p?.title));
    r = await run(['recent'], { sb, sess });
    check('recent/no --limit → all 4 of this workspace (fewer than the default 10), newest first', r.code === EXIT.ok && linesOf(r.stdout).map((l) => parseRecent(l)?.id).join(',') === [...ids].reverse().join(','), 'four lines', brief(r));
    r = await run(['recent', '--limit', '50'], { sb, sess });
    check('recent/--limit 50 (the most) → the same 4', r.code === EXIT.ok && linesOf(r.stdout).length === 4, 'four lines', brief(r));
    const sub = path.join(sb.ws, 'pkg', 'api');
    fs.mkdirSync(sub, { recursive: true });
    r = await run(['recent', '--limit', '1'], { sb, sess, cwd: sub });
    check('recent/from a subdirectory (the Bash cwd wanders) → the session’s workspace, the newest task', r.code === EXIT.ok && linesOf(r.stdout).length === 1 && parseRecent(linesOf(r.stdout)[0])?.id === ids[3], `${ids[3]}`, brief(r));
    const ws2 = path.join(sb.dir, 'ws-fresh');
    fs.mkdirSync(ws2, { recursive: true });
    const sess2 = startSession(ws2);
    r = await run(['recent'], { sb, sess: sess2, cwd: ws2, timeoutMs: 45_000 });
    check('recent/a fresh workspace (same data root, other workspaces’ tasks in the log) → "No tasks in this workspace yet."', r.code === EXIT.ok && r.stdout.trim() === 'No tasks in this workspace yet.', 'that sentence', brief(r));
  } catch (err) {
    check('recent/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * Section: fx3 — the T11 review's protocol/host/cco findings (team contract A34–A37)
 * ------------------------------------------------------------------------- */

async function sectionFx3() {
  await calm();
  // S3 + S7 (A36), the client's half: no NUL / lone surrogate in any string of a team file, no
  // control character in a one-line value, no number JSON cannot carry — 21 naming the field, and
  // nothing sent (no host is even started for the session).
  {
    const sb = makeSandbox('fx3-values');
    const sess = startSession(sb.ws);
    const member = (over = '') => `{"name":"alice","brief":"do it"${over}}`;
    const cases = [
      ['S3 a NUL in an inline goal', 'team_create', `{"name":"web","goal":"ship\\u0000it","members":[${member()}]}`, 'goal'],
      ['S3 variant: a NUL in members[0].brief', 'team_create', `{"name":"web","goal":"g","members":[{"name":"alice","brief":"a\\u0000b"}]}`, 'members[0].brief'],
      ['S3 variant: a lone high surrogate in members[0].role', 'team_create', `{"name":"web","goal":"g","members":[${member(',"role":"api \\ud800"')}]}`, 'members[0].role'],
      ['S3 variant: a NUL in members[0].start', 'team_create', `{"name":"web","goal":"g","members":[${member(',"start":"go\\u0000"')}]}`, 'members[0].start'],
      ['S3 variant: a NUL in a team_send text', 'team_send', '{"to":"alice","text":"hello\\u0000"}', 'text'],
      ['S3 variant: a lone low surrogate in a team_task update note', 'team_task', '{"op":"update","task":"b1","note":"\\udc00 x"}', 'note'],
      ['S7 a control character (ESC) in members[0].role', 'team_create', `{"name":"web","goal":"g","members":[${member(',"role":"api\\u001b[31m"')}]}`, 'members[0].role'],
      ['S7 variant: a tab in tasks[0].title', 'team_create', `{"name":"web","goal":"g","members":[${member()}],"tasks":[{"title":"a\\tb"}]}`, 'tasks[0].title'],
      ['S7 1e309 in worktree.timeout_minutes', 'team_create', `{"name":"web","goal":"g","members":[${member()}],"worktree":{"timeout_minutes":1e309}}`, 'worktree.timeout_minutes'],
      ['S7 variant: -1e400 in a team_add member', 'team_add', '{"members":[{"name":"bob","brief":"b","paths":[-1e400]}]}', 'members[0].paths[0]'],
    ];
    let n = 0;
    for (const [name, op, text, field] of cases) {
      const file = path.join(sb.ws, '.cco', `fx3-${++n}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      const r = await run([op, path.relative(sb.ws, file)], { sb, sess, timeoutMs: 30_000 });
      const said = `${r.stdout}\n${r.stderr}`;
      check(`${name} → exit 21 naming \`${field}\``, r.code === EXIT.usage && said.includes(`\`${field}\``), `exit 21 and \`${field}\` named`, brief(r));
    }
    check('S3/S7 nothing was sent: no host was started for the session', sb.recordOf(sess.pid) === undefined && !fs.existsSync(sb.filesOf(sess.pid).log), 'no record, no host log', { record: sb.recordOf(sess.pid) });
    const ok = path.join(sb.ws, '.cco', 'fx3-plain.json');
    fs.writeFileSync(ok, '{"title":"t","prompt":"p","model":1e309}');
    const d = await run(['dispatch_task', '.cco/fx3-plain.json'], { sb, sess, timeoutMs: 30_000 });
    check('S7 variant: a dispatch task file with 1e309 is refused too (exit 21 naming `model`)', d.code === EXIT.usage && `${d.stdout}${d.stderr}`.includes('`model`'), 'exit 21 naming `model`', brief(d));
    await endSection();
  }

  // S2 (A35): a starting host removes the logs of sessions provably gone and older than 7 days.
  {
    const sb = makeSandbox('fx3-prune');
    fs.mkdirSync(sb.runDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(sb.runDir, 0o700);
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    const recent = (Date.now() - 24 * 3_600_000) / 1000;
    const put = (name, when, text = 'old host log\n') => {
      const f = path.join(sb.runDir, name);
      fs.writeFileSync(f, text);
      fs.utimesSync(f, when, when);
      return f;
    };
    const gone = deadPid();
    const removedOld = [put(`s${gone}.log`, old), put(`s${gone}.log.1`, old)];
    const keptRecent = put('s900000002.log', recent);
    const keptLive = put(`s${process.pid}.log`, old);
    const keptHost = put('s900000003.log', old);
    writeJson(path.join(sb.runDir, 's900000003.json'), { protocol: PROTOCOL, hostPid: process.pid, hostStartedAt: startedAtOf(process.pid), session: { pid: 900000003, startedAt: 1 }, workspace: sb.ws, socket: '/tmp/x.sock', serverHash: 'x' });
    const target = put('target.txt', old, 'not a log');
    const keptLink = path.join(sb.runDir, 's900000004.log');
    fs.symlinkSync(target, keptLink);
    const bulk = [];
    for (let k = 1; k <= 400; k++) bulk.push(put(`s${900100000 + k}.log`, old));
    const sess = startSession(sb.ws);
    const r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    const gonePruned = await until(() => removedOld.every((f) => !fs.existsSync(f)) && bulk.every((f) => !fs.existsSync(f)), 10_000, 100);
    check('S2 a starting host removes s<P>.log and s<P>.log.1 of a dead session older than 7 days', r.code === EXIT.ok && gonePruned === true, 'both removed', { run: brief(r), left: removedOld.filter((f) => fs.existsSync(f)) });
    check('S2 variant: 400 such logs are all removed', bulk.every((f) => !fs.existsSync(f)), '0 left', bulk.filter((f) => fs.existsSync(f)).length);
    check('S2 a log of a LIVE pid is never removed, however old', fs.existsSync(keptLive), 'kept', keptLive);
    check('S2 variant: a dead session\'s log younger than 7 days is kept', fs.existsSync(keptRecent), 'kept', keptRecent);
    check('S2 variant: a log whose record names a host that is still that process is kept', fs.existsSync(keptHost), 'kept', keptHost);
    check('S2 variant: a symbolic link named like a log is left alone (and its target too)', fs.lstatSync(keptLink).isSymbolicLink() && fs.existsSync(target), 'kept', keptLink);
    check('S2 this host\'s own log is there and says what was removed', /removed 402 host log\(s\)/.test(fs.readFileSync(sb.filesOf(sess.pid).log, 'utf8')), 'a "removed 402 host log(s)" line', clip(fs.readFileSync(sb.filesOf(sess.pid).log, 'utf8'), 600));
    await endSection();
  }

  const sb = makeSandbox('fx3-host');
  const sess = startSession(sb.ws);
  try {
    const r = await run(['list_workers'], { sb, sess, timeoutMs: 45_000 });
    const rec = sb.recordOf(sess.pid);
    if (!check('fx3/a host is up', r.code === EXIT.ok && typeof rec?.socket === 'string', 'exit 0 and a record', { ...brief(r), rec })) return;
    const sock = rec.socket;
    const hostLog = () => {
      try {
        return fs.readFileSync(sb.filesOf(sess.pid).log, 'utf8');
      } catch {
        return '';
      }
    };
    const observer = async () => {
      const c = await connectSocket(sock);
      c.send({ jsonrpc: '2.0', id: 'hello', method: 'cco/hello', params: { protocol: PROTOCOL, role: 'observer', client: 'other', clientPid: process.pid } });
      c.hello = await c.waitFor((x) => x.id === 'hello', 8000);
      return c;
    };

    // S4 (A37): before the hello at most 64 KiB without a newline.
    let c = await connectSocket(sock);
    c.sock.write(Buffer.alloc(64 * 1024 + 1, 0x61));
    let m = await c.waitFor((x) => x.error !== undefined, 5000);
    check('S4 more than 64 KiB without a newline before the hello → -32600 and closed', m?.error?.code === RPC.invalidRequest && (await c.waitClosed(3000)), '-32600, then close', { m, closed: c.closed });
    c = await connectSocket(sock);
    c.sock.write(Buffer.alloc(40 * 1024, 0x61));
    await sleep(300);
    c.sock.write(Buffer.alloc(30 * 1024, 0x61));
    m = await c.waitFor((x) => x.error !== undefined, 5000);
    check('S4 variant: 64 KiB reached in two writes is refused the same way', m?.error?.code === RPC.invalidRequest && (await c.waitClosed(3000)), '-32600, then close', { m, closed: c.closed });
    const o = await observer();
    o.send({ jsonrpc: '2.0', id: 'x'.repeat(MiB), method: 'ping' });
    m = await o.waitFor((x) => typeof x.id === 'string' && x.id.length === MiB, 10_000);
    check('S4 variant: a GREETED connection still sends a 1 MiB line (the 80 MiB rule)', m?.result !== undefined, 'answered', m === undefined ? o.msgs.slice(-1) : 'answered');

    // S4: at most 32 ungreeted connections at once.
    const idle = [];
    for (let i = 0; i < 32; i++) idle.push(await connectSocket(sock));
    await sleep(300);
    const extra = await connectSocket(sock);
    const extraClosed = await extra.waitClosed(3000);
    check('S4 the 33rd connection that has not said hello is closed at once', extraClosed && idle.every((x) => !x.closed), 'the 33rd closed, 32 open', { extraClosed, open: idle.filter((x) => !x.closed).length });
    check('S4 the refusal is logged', /connection\(s\) closed at once — 32 connections that have not said hello/.test(hostLog()), 'a log line', clip(hostLog().split('\n').slice(-6), 600));
    for (const x of idle) x.destroy();
    await sleep(300);
    const after = await observer();
    check('S4 variant: once they are gone a new connection is greeted again', after.hello?.result !== undefined, 'a hello result', after.hello);

    // S4: a hello within 10 s.
    const silent = await connectSocket(sock);
    const halfHello = await connectSocket(sock);
    halfHello.sock.write('{"jsonrpc":"2.0","id":1,"method":"cco/hello","params":{"protocol":1');
    const t0 = Date.now();
    const silentClosed = await silent.waitClosed(13_000);
    const ms = Date.now() - t0;
    const notice = silent.msgs.find((x) => x.error?.code === RPC.helloFirst);
    check('S4 a connection that says nothing for 10 s is told -32002 and closed', silentClosed && notice !== undefined && ms >= 8_500, '-32002 and closed after ≈ 10 s', { silentClosed, ms, msgs: silent.msgs });
    check('S4 variant: one that sent half a hello and stopped is closed the same way', await halfHello.waitClosed(3000), 'closed', halfHello.msgs);

    // S5 (A37): answers obey the outbound cap on observer connections.
    for (const [label, method, params] of [
      ['ping (an answer of the server)', 'ping', undefined],
      ['cco/team.list (an answer of the team engine)', 'cco/team.list', {}],
    ]) {
      const slow = await observer();
      slow.sock.pause();
      for (let i = 0; i < 12; i++) slow.send({ jsonrpc: '2.0', id: `${i}-${'y'.repeat(MiB)}`, method, ...(params === undefined ? {} : { params }) });
      // Read again before the host's 2 s grace for a closing connection ends, so the notice it wrote last can be seen.
      await sleep(1000);
      const logged = /does not read what is sent to it/.test(hostLog());
      slow.sock.resume();
      const closed = await slow.waitClosed(8000);
      const overflow = slow.msgs.find((x) => x.method === 'cco/team.host' && x.params?.reason === 'overflow');
      check(`S5 an observer that does not read its answers is closed with the overflow notice — ${label}`, closed && overflow !== undefined && logged, 'cco/team.host overflow, then close, logged', { closed, overflow, logged, answered: slow.msgs.length });
    }
    const ping = await observer();
    ping.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    check('S5 the host still answers a fresh observer afterwards', (await ping.waitFor((x) => x.id === 'p', 5000))?.result !== undefined, 'a ping result', ping.msgs);

    // S1 (A34): every mutating observer call is logged with the claimed client pid.
    const team = 'tmfx3nope0001';
    const s1 = await observer();
    s1.send({ jsonrpc: '2.0', id: 'send', method: 'cco/team.send', params: { teamId: team, to: 'alice', text: 'from a process of this user' } });
    s1.send({ jsonrpc: '2.0', id: 'end', method: 'cco/team.end', params: { teamId: team, now: true } });
    s1.send({ jsonrpc: '2.0', id: 'list', method: 'cco/team.list', params: {} });
    await Promise.all(['send', 'end', 'list'].map((id) => s1.waitFor((x) => x.id === id, 10_000)));
    await sleep(200);
    const lines = hostLog().split('\n');
    const sendLine = lines.find((l) => l.includes('observer call cco/team.send') && l.includes(team));
    check('S1 an observer cco/team.send is logged with the team and the client pid', sendLine !== undefined && sendLine.includes(`client pid ${process.pid}`), `a log line naming cco/team.send, ${team}, pid ${process.pid}`, clip(lines.slice(-8), 800));
    check('S1 variant: cco/team.end is logged the same way', lines.some((l) => l.includes('observer call cco/team.end') && l.includes(`client pid ${process.pid}`)), 'a log line', clip(lines.slice(-8), 800));
    check('S1 variant: a read-only call (cco/team.list) is not logged', !lines.some((l) => l.includes('call cco/team.list')), 'no line', clip(lines.filter((l) => l.includes('cco/team.list')), 400));
  } catch (err) {
    check('fx3/ran', false, 'no error', err?.stack ?? String(err));
  } finally {
    await endSection();
  }
}

const SECTIONS = [
  ['argv', sectionArgv],
  ['files', sectionFiles],
  ['env', sectionEnv],
  ['start', sectionStart],
  ['life', sectionLife],
  ['proto', sectionProto],
  ['wait', sectionWait],
  ['cancel', sectionCancel],
  ['output', sectionOutput],
  ['recent', sectionRecent],
  ['fx3', sectionFx3],
  ['turns', sectionTurns],
];

/** The sockets this run's hosts may have left in /tmp/cco-<uid> (a SIGKILLed host leaves its own). */
function removeFallbackSockets() {
  let names;
  try {
    names = fs.readdirSync(FALLBACK_DIR);
  } catch {
    return;
  }
  const tags = new Set(sandboxes.map((sb) => sha256hex(Buffer.from(sb.runDir, 'utf8')).slice(0, 8)));
  for (const name of names) {
    const m = /^([0-9a-f]{8})-s\d+\.sock$/.exec(name);
    if (m && tags.has(m[1])) {
      try {
        fs.rmSync(path.join(FALLBACK_DIR, name), { force: true });
      } catch {
        // gone
      }
    }
  }
  if (!FALLBACK_EXISTED) {
    try {
      fs.rmdirSync(FALLBACK_DIR);
    } catch {
      // not empty (someone else's sockets) or gone: left as it is
    }
  }
}

function finalCleanup() {
  for (const s of [...tracked.sessions]) killQuietly(s.pid);
  for (const c of [...tracked.clients]) killQuietly(c.pid);
  killStragglers();
  removeFallbackSockets();
  for (const dir of tracked.readOnly) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // gone
    }
  }
}

async function main() {
  const started = Date.now();
  console.log(`scratch: ${BASE} (and ${SHORT})`);
  console.log(SOURCES === undefined ? 'sources: the current tree' : `sources: the current tree with ${SOURCES} laid over it`);
  await build();
  console.log(`server.js hash: ${SERVER_HASH}`);
  console.log('\n== contract');
  sectionContract();
  for (const [name, fn] of SECTIONS) {
    if (ONLY !== undefined && !ONLY.has(name)) continue;
    console.log(`\n== ${name}`);
    try {
      await fn();
    } catch (err) {
      check(`${name}/the section ran to its end`, false, 'no error', err?.stack ?? String(err));
    }
    await endSection();
  }
  finalCleanup();
  const total = passed + failures.length;
  const scope = ONLY === undefined ? '' : ` (sections: ${[...ONLY].join(', ')})`;
  console.log(`\n${passed} passed, ${failures.length} failed of ${total} checks in ${Math.round((Date.now() - started) / 1000)} s${scope}${SKIP_SLOW ? ' (--skip-slow)' : ''}`);
  if (failures.length > 0) {
    console.log(`failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }
  if (KEEP) {
    console.log(`kept: ${BASE} and ${SHORT}`);
  } else {
    fs.rmSync(BASE, { recursive: true, force: true });
    fs.rmSync(SHORT, { recursive: true, force: true });
  }
  const code = failures.length === 0 ? 0 : 1;
  // A pipe's writes are asynchronous on macOS: let the tally drain before the exit.
  process.stdout.write('', () => process.exit(code));
}

process.on('SIGINT', () => {
  finalCleanup();
  process.exit(130);
});
main().catch((err) => {
  console.error(err?.stack ?? String(err));
  finalCleanup();
  if (!KEEP) {
    try {
      fs.rmSync(BASE, { recursive: true, force: true });
      fs.rmSync(SHORT, { recursive: true, force: true });
    } catch {
      // left behind
    }
  }
  process.exit(2);
});
