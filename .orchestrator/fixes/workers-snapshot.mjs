#!/usr/bin/env node
// workers-snapshot.mjs — offline checks of list_workers' STRUCTURED answer (task G1, host-protocol
// "list_workers' structured answer": WorkersSnapshot, schema cco.workers/1) and of the host-side
// poll floor that goes with it.
//
//   node .orchestrator/fixes/workers-snapshot.mjs           every section
//   node .orchestrator/fixes/workers-snapshot.mjs --keep    leave the scratch directory behind
//   node .orchestrator/fixes/workers-snapshot.mjs --no-floor-wait
//                                                           skip the one check that waits out the
//                                                           floor (WORKERS_SNAPSHOT_MIN_POLL_MS, 60 s)
//   node .orchestrator/fixes/workers-snapshot.mjs --src <dir>
//                                                           bundle NEW and LIB from <dir>/src instead
//                                                           of this repository's — e.g. a copy with
//                                                           the pre-change sources, to show which
//                                                           checks fail there
//
// Each check prints `PASS <name>` or `FAIL <name> — <why>`; the last line is the tally. Exit 0 only
// when every check passed.
//
// WHAT RUNS. Three esbuild bundles in a scratch directory (never `out/`):
//   - NEW: src/mcp/server.ts as it is now;
//   - OLD: the same sources with src/mcp/server.ts as COMMITTED (git show HEAD:…) — the text
//     before this addition, which the new text must equal byte for byte;
//   - LIB: src/uiModel.ts, src/registry.ts and src/mcp/host-protocol.ts, loaded in THIS process
//     with HOME pointed at the same sandbox, to build the dashboard's accounts from the same files.
// The servers run over stdio (no --host) and as a real host (`server.js --host <spec>`, started
// here from a spec this file writes, for a `/bin/sleep` that stands in for the session), reached
// over its socket by OBSERVER connections.
//
// ISOLATION. HOME (and USERPROFILE) are a scratch directory for every process; `claude` is a fake
// written below (it logs each invocation with its CLAUDE_CONFIG_DIR, and answers a usage probe
// after a delay so that concurrent calls overlap it); `codex`, `cursor-agent` and `agy` on PATH
// are shims that log and fail. No vendor CLI runs, nothing under the real home is read or written.
// The host's socket lives in a short directory under /tmp (a Unix socket path is ≤ 104 bytes),
// removed at the end.
//
// KEYCHAIN. Every environment handed to product code — the children's and this process's own —
// has AGENT_CLI_CREDENTIAL_STORE=memory; when .orchestrator/fixes/keychain-guard.cjs exists it is
// preloaded (NODE_OPTIONS=--require, merged with any NODE_OPTIONS already set; required here before
// the lib bundle loads), and the run FAILS when the guard's log (CCO_KEYCHAIN_GUARD_LOG, a file in
// the scratch directory) is not empty at the end.
//
// G2 (role-keyed floor, generation, servedFromCache, caps, in-memory cooldowns, isError `~`): the
// sections `role`, `memory` and `caps` below. Run with `--src <copy with the pre-change sources>`
// to see each of them fail there.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const FLOOR_WAIT = !argv.includes('--no-floor-wait');
const srcAt = argv.indexOf('--src');
// The directory whose `src` NEW and LIB are bundled from (OLD is always this repository's).
const SRC_ROOT = srcAt === -1 ? REPO : path.resolve(argv[srcAt + 1] ?? '');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-workers-snapshot-')));
const SOCK_DIR = fs.mkdtempSync('/tmp/cco-ws-');
const OUT = path.join(BASE, 'out');
const BIN = path.join(BASE, 'bin');
const SYSTEM_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// The keychain guard (task H1): preloaded into every product process when it exists.
const GUARD = path.join(HERE, 'keychain-guard.cjs');
const GUARD_PRESENT = fs.existsSync(GUARD);
const GUARD_LOG = path.join(BASE, 'keychain-guard.log');
const NODE_OPTIONS = [process.env.NODE_OPTIONS, GUARD_PRESENT ? `--require ${JSON.stringify(GUARD)}` : '']
  .filter((x) => typeof x === 'string' && x.trim() !== '')
  .join(' ');

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
function check(name, ok, why = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} — ${clip(why === '' ? 'the condition did not hold' : why)}`);
  }
  return ok;
}
function checkEq(name, observed, expected) {
  const a = JSON.stringify(observed);
  const b = JSON.stringify(expected);
  return check(name, a === b, `expected ${clip(b, 600)} — observed ${clip(a, 600)}`);
}

/* ------------------------------------------------------------------------- *
 * Build
 * ------------------------------------------------------------------------- */

const NEW_JS = path.join(OUT, 'new', 'mcp', 'server.js');
const OLD_JS = path.join(OUT, 'old', 'mcp', 'server.js');
const LIB_CJS = path.join(OUT, 'lib.cjs');

async function build() {
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  const common = { bundle: true, platform: 'node', target: 'node18', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')] };
  await esbuild.build({ ...common, entryPoints: [path.join(SRC_ROOT, 'src', 'mcp', 'server.ts')], outfile: NEW_JS });
  // OLD: the working tree's sources with the committed server.ts — the text this change must keep.
  const oldSrc = path.join(BASE, 'old-src');
  fs.cpSync(path.join(REPO, 'src'), oldSrc, { recursive: true });
  const committed = execFileSync('git', ['show', 'HEAD:src/mcp/server.ts'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(oldSrc, 'mcp', 'server.ts'), committed);
  await esbuild.build({ ...common, entryPoints: [path.join(oldSrc, 'mcp', 'server.ts')], outfile: OLD_JS });
  const entry = [
    `export * as UI from './src/uiModel';`,
    `export * as REG from './src/registry';`,
    `export * as HP from './src/mcp/host-protocol';`,
  ].join('\n');
  await esbuild.build({
    ...common,
    stdin: { contents: entry, resolveDir: SRC_ROOT, loader: 'ts', sourcefile: 'workers-snapshot-entry.ts' },
    format: 'cjs',
    outfile: LIB_CJS,
  });
}

/* ------------------------------------------------------------------------- *
 * The fake CLIs
 * ------------------------------------------------------------------------- */

const FAKE_LOG = path.join(BASE, 'fake.log');
function writeFakes() {
  fs.mkdirSync(BIN, { recursive: true });
  const fake = path.join(BIN, 'claude');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const kind = argv.includes('--version') ? 'version' : argv.includes('auth') && argv.includes('status') ? 'auth'
  : argv.includes('stream-json') ? 'usage' : argv[0] === 'agents' ? 'agents' : 'other';
try { fs.appendFileSync(process.env.WS_FAKE_LOG, JSON.stringify({ kind, dir: process.env.CLAUDE_CONFIG_DIR || '(default)', t: Date.now() }) + '\\n'); } catch {}
const say = (text) => process.stdout.write(text, () => process.exit(0));
if (kind === 'version') say('9.9.9 (Claude Code)\\n');
else if (kind === 'auth') say(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\\n');
else if (kind === 'usage') setTimeout(() => say(JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\\n'), 700);
else if (kind === 'agents') say('[]\\n');
else if (argv.includes('-p')) {
  // A dispatch run: read the prompt, then answer what Claude Code answers at a usage limit.
  try { fs.appendFileSync(process.env.WS_FAKE_LOG, JSON.stringify({ kind: 'run', dir: process.env.CLAUDE_CONFIG_DIR || '(default)', t: Date.now() }) + '\\n'); } catch {}
  process.stdin.resume();
  process.stdin.on('end', () => say(JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1760000000' }) + '\\n'));
}
else { process.stderr.write('fake claude: unsupported\\n'); process.exit(2); }
`,
  );
  fs.chmodSync(fake, 0o755);
  for (const cli of ['codex', 'cursor-agent', 'agy']) {
    const shim = path.join(BIN, cli);
    fs.writeFileSync(shim, `#!/bin/sh\necho '{"kind":"vendor-shim","cli":"${cli}"}' >> "$WS_FAKE_LOG"\nexit 1\n`);
    fs.chmodSync(shim, 0o755);
  }
  return fake;
}
const fakeRecords = () => {
  try {
    return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------------- *
 * The sandbox — ONE home for every process of this run
 * ------------------------------------------------------------------------- */

const HOME = path.join(BASE, 'home');
const ROOT = path.join(HOME, '.claude-code-orchestrator');
const WS = path.join(BASE, 'ws');
const MAIN_DIR = path.join(HOME, '.claude');
const cfg = (name) => path.join(HOME, 'configs', name);
// Short enough for the 200-character cap: every home path in it arrives whole.
const COOL_ERROR = `E ${HOME}/a ${HOME}x`;
// Long enough that the cap cuts the home path in it: 180 characters, a space, then the home.
const CUT_ERROR = `${'x'.repeat(180)} ${HOME}/deep/er`;

function env() {
  return {
    PATH: `${BIN}:${SYSTEM_PATH}`,
    HOME,
    USERPROFILE: HOME,
    TMPDIR: path.join(BASE, 'tmp'),
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    WS_FAKE_LOG: FAKE_LOG,
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    CCO_KEYCHAIN_GUARD_LOG: GUARD_LOG,
    ...(NODE_OPTIONS !== '' ? { NODE_OPTIONS } : {}),
  };
}

/**
 * The fixture: main, a plain worker `wa`, a cooling-down worker `cool` whose lastError holds the
 * home path, a logged-out worker `out`, a Codex worker `cx`, a worker named `__proto__`, and one
 * entry this version cannot use. `stale` makes every Claude Code reading old (a refresh probes).
 */
function writeFixture({ guards = { frontierWorkerDispatch: 'allow', overageWorkerDispatch: 'yes please' }, stale = false } = {}) {
  fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.mkdirSync(MAIN_DIR, { recursive: true });
  const names = ['wa', 'cool', 'out', 'cx', '__proto__'];
  for (const n of names) fs.mkdirSync(cfg(n), { recursive: true });
  const registry = {
    workers: [
      { name: 'wa', configDir: cfg('wa'), model: 'opus', preferred: true },
      { name: 'cool', configDir: cfg('cool'), model: 'sonnet' },
      { name: 'out', configDir: cfg('out'), model: 'opus' },
      { name: 'cx', configDir: cfg('cx'), model: '', provider: 'codex' },
      { name: '__proto__', configDir: cfg('__proto__'), model: 'opus' },
      { name: 'ghost', configDir: cfg('ghost'), model: 'x', provider: 'nope' },
    ],
    permissionMode: 'acceptEdits',
    claudePath: path.join(BIN, 'claude'),
    cooldownMinutes: 30,
    workerTimeoutMinutes: 2,
    ...guards,
  };
  fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify(registry, null, 2));
  const now = Date.now();
  const at = stale ? now - 3_600_000 : now;
  const future = new Date(now + 6 * 3_600_000 + 1_800_000).toISOString();
  const reading = (name, dir) => ({
    name,
    configDir: dir,
    available: true,
    subscriptionType: 'max',
    windows: [
      { kind: 'session', label: 'Session (5hr)', percent: 12, severity: 'normal', resetsAt: future },
      { kind: 'weekly_all', label: 'Weekly (7 day)', percent: 40, severity: 'normal', resetsAt: future },
    ],
    sessionCostUsd: 0,
    extraUsage: { enabled: false, percent: null, spendLabel: null },
    fetchedAt: at,
    windowsFetchedAt: at,
    windowsStale: false,
    lastGoodWindowsAt: at,
    // Written as this version's refresh writes it (Login state (CA)): the login probe the reading
    // amounts to. Without it the reading is "not confirmed" and the server probes the account.
    loginProbes: [loginProbe(dir, at)],
  });
  const usage = {
    [MAIN_DIR]: reading('main', MAIN_DIR),
    [cfg('wa')]: reading('wa', cfg('wa')),
    [cfg('cool')]: reading('cool', cfg('cool')),
    [cfg('out')]: { name: 'out', configDir: cfg('out'), available: false, auth: { loggedIn: false, method: 'claude.ai', email: null }, windows: [], fetchedAt: at },
    // Fresh for the run (its 120 s window outlasts the floor wait): nothing here may start the codex shim.
    [cfg('cx')]: { name: 'cx', configDir: cfg('cx'), available: false, subscriptionType: 'chatgpt', auth: { loggedIn: true, method: 'chatgpt', email: null }, windows: [], fetchedAt: now },
    [cfg('__proto__')]: reading('__proto__', cfg('__proto__')),
  };
  fs.writeFileSync(path.join(ROOT, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(
    path.join(ROOT, 'stats.json'),
    JSON.stringify({
      cool: { tasks: 3, errors: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.5, cooldownUntil: now + 20 * 60_000, lastError: COOL_ERROR },
      out: { tasks: 0, errors: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, lastError: CUT_ERROR },
      ['__proto__']: { tasks: 1, errors: 0, inputTokens: 7, outputTokens: 8, costUsd: 0 },
    }),
  );
}

/* ------------------------------------------------------------------------- *
 * A stdio server
 * ------------------------------------------------------------------------- */

const live = new Set();
function startStdio(script) {
  const child = spawn(process.execPath, [script], { cwd: WS, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  child.on('exit', () => live.delete(child));
  const waiters = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      waiters.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve) => {
      const id = next++;
      const timer = setTimeout(() => resolve({ timedOut: true, stderr }), timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workers-snapshot', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    listWorkers: () => request('tools/call', { name: 'list_workers', arguments: {} }),
    call: (name, args, timeoutMs) => request('tools/call', { name, arguments: args }, timeoutMs),
    stop() {
      try {
        child.stdin.end();
      } catch {
        // gone
      }
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    },
  };
}

/* ------------------------------------------------------------------------- *
 * A host, and observer connections to it
 * ------------------------------------------------------------------------- */

async function startHost(lib) {
  const session = spawn('/bin/sleep', ['600'], { cwd: WS, stdio: 'ignore' });
  live.add(session);
  let startedAt;
  for (let i = 0; i < 50 && startedAt === undefined; i++) {
    startedAt = lib.REG.processStartedAt(session.pid);
    if (startedAt === undefined) await sleep(100);
  }
  const runDir = lib.HP.runDirOf(ROOT);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // One socket per host: a host killed earlier in the run leaves its socket file behind.
  const socket = path.join(SOCK_DIR, `h${session.pid}.sock`);
  const specPath = path.join(runDir, `s${session.pid}.spec.json`);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      protocol: lib.HP.PROTOCOL_VERSION,
      session: { pid: session.pid, startedAt },
      workspace: fs.realpathSync(WS),
      socket,
      serverHash: 'workers-snapshot-test',
      logPath: path.join(runDir, `s${session.pid}.log`),
      failPath: path.join(runDir, `s${session.pid}.fail`),
    }),
  );
  const host = spawn(process.execPath, [NEW_JS, '--host', specPath], { cwd: WS, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(host);
  let stderr = '';
  host.stderr.on('data', (d) => (stderr += d));
  host.on('exit', () => live.delete(host));
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await sleep(100);
  if (!fs.existsSync(socket)) {
    let fail = '';
    try {
      fail = fs.readFileSync(path.join(runDir, `s${session.pid}.fail`), 'utf8');
    } catch {
      // none
    }
    throw new Error(`the host did not listen (stderr ${clip(stderr)}; fail ${clip(fail)})`);
  }
  return { socket, session: { pid: session.pid, startedAt }, stop: () => [host, session].forEach((c) => c.kill('SIGKILL')) };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const waiters = new Map();
    let buffer = '';
    let next = 1;
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        waiters.get(msg.id)?.(msg);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () =>
      resolve({
        request: (method, params, timeoutMs = 40_000) =>
          new Promise((res) => {
            const id = next++;
            const timer = setTimeout(() => res({ timedOut: true }), timeoutMs);
            waiters.set(id, (msg) => {
              clearTimeout(timer);
              res(msg);
            });
            sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          }),
        close: () => sock.destroy(),
      }),
    );
  });
}

/* ------------------------------------------------------------------------- *
 * Sections
 * ------------------------------------------------------------------------- */

const textOf = (msg) => msg?.result?.content?.[0]?.text;
/**
 * A list_workers text without what CA added on purpose: the login state at the end of each Claude
 * Code account line, the block of the worker `out` and the "Logged-out accounts" footer (that
 * worker's reading is re-checked now — see the checks that use this).
 */
const sansLoginState = (text) => {
  const lines = String(text)
    .replace(/\n\nLogged-out accounts \([^\n]*/g, '')
    .split('\n')
    .map((l) => l.replace(/ · (login ok · checked|login not confirmed \(|logged out \(|couldn't check the login \(|login checking now \().*$/, ''));
  const out = [];
  let skipping = false;
  for (const l of lines) {
    if (l.startsWith('- ')) skipping = l.startsWith('- out ');
    else if (!l.startsWith('  ')) skipping = false;
    if (!skipping) out.push(l);
  }
  return out.join('\n');
};
const redactHome = (value) => JSON.parse(JSON.stringify(value).split(HOME).join('~'));

async function stdioSection(lib) {
  writeFixture();
  const fresh = startStdio(NEW_JS);
  const old = startStdio(OLD_JS);
  await Promise.all([fresh.init(), old.init()]);
  // The text names relative reset times: the two answers are asked for together, and again should
  // a minute boundary fall between them.
  let a;
  let b;
  for (let i = 0; i < 3; i++) {
    [a, b] = await Promise.all([fresh.listWorkers(), old.listWorkers()]);
    if (textOf(a) === textOf(b)) break;
  }
  check('stdio/the answer is not an error', a?.result !== undefined && a.result.isError !== true, a);
  // CA (Login state): every Claude Code account line now ends with its login state, and the
  // worker `out` — whose logged-out reading was written by something else (no login probes, as a
  // 1.x writer leaves it) — is not believed: it is probed, and the fake CLI says logged in. So the
  // text equals the committed server's once those two intended differences are taken out, and
  // they are checked on their own. (OLD is built from the working tree's other sources, so the
  // old code's failure itself is shown by login-state.mjs, against the committed sources.)
  check('stdio/the text, without the login-state endings and the `out` worker, is BYTE-IDENTICAL to the committed server\'s', typeof textOf(a) === 'string' && sansLoginState(textOf(a)) === sansLoginState(textOf(b)), { new: sansLoginState(textOf(a)), old: sansLoginState(textOf(b)) });
  check('CA stdio/every Claude Code account line ends with its login state and age', typeof textOf(a) === 'string' && (textOf(a).match(/ · login ok · checked just now$/gm) ?? []).length === 5, textOf(a));
  check('CA stdio/…this one probed the account and says what the CLI says: not logged out', typeof textOf(a) === 'string' && !/LOGGED OUT|logged out —/.test(textOf(a)) && /- out \[Claude Code\]: default model opus — .*available\n  no plan limits \(login is a token \/ non-subscription\) · login ok · checked just now/.test(textOf(a)), textOf(a));
  checkEq('stdio/the result has exactly content and structuredContent', Object.keys(a?.result ?? {}).sort(), ['content', 'structuredContent']);
  const snap = a?.result?.structuredContent;
  check('stdio/schema is cco.workers/1', snap?.schema === lib.HP.WORKERS_SNAPSHOT_SCHEMA && snap?.schema === 'cco.workers/1', snap?.schema);
  check('stdio/generatedAt is an epoch ms of this call', typeof snap?.generatedAt === 'number' && Math.abs(Date.now() - snap.generatedAt) < 60_000, snap?.generatedAt);
  check('G2 stdio/servedFromCache is false on a fresh answer', snap?.servedFromCache === false, snap?.servedFromCache);

  // The dashboard's builder, in this process, over the same files at the snapshot's moment.
  const own = lib.UI.buildAccountsSnapshot(snap.generatedAt);
  const dash = lib.UI.buildDashboardModel({ now: snap.generatedAt, workspaceRoot: WS, scope: 'all' });
  checkEq('lib/buildAccountsSnapshot gives exactly the dashboard model\'s accounts', own?.accounts, dash.accounts);
  checkEq('lib/buildAccountsSnapshot gives exactly the dashboard model\'s unsupportedAccounts', own?.unsupportedAccounts, dash.unsupportedAccounts);
  // The two fields made to test the redaction (a home-like longer name, a home path the cap cut)
  // are compared by their own checks below.
  const sansCut = (list) => list.map((x) => (x.name === 'out' || x.name === 'cool' ? { ...x, lastError: null } : x));
  checkEq('stdio/accounts equal the dashboard builder\'s (home shown as ~)', sansCut(snap.accounts), sansCut(redactHome(own.accounts)));
  checkEq('stdio/unsupportedAccounts equal the dashboard builder\'s', snap.unsupportedAccounts, redactHome(own.unsupportedAccounts));
  // The dashboard's order (same builder): main, the Claude Code workers in registry order, then the other vendors'.
  checkEq('stdio/account order is the dashboard\'s', snap.accounts.map((x) => x.name), ['main', 'wa', 'cool', 'out', '__proto__', 'cx']);
  const by = Object.fromEntries(snap.accounts.map((x) => [x.name, x]));
  check('stdio/the dashboard model itself still shows the home path (redaction is the snapshot\'s only)', dash.accounts.find((x) => x.name === 'cool')?.lastError?.includes(HOME), dash.accounts.find((x) => x.name === 'cool')?.lastError);
  checkEq('stdio/lastError: the home directory is ~, a longer name that only starts like it is kept', by.cool?.lastError, `E ~/a ${HOME}x`);
  checkEq('stdio/lastError: a home path the 200-character cap cut in the middle is ~ too', by.out?.lastError, `${'x'.repeat(180)} ~`);
  check('stdio/…where the dashboard has the cut home path', dash.accounts.find((x) => x.name === 'out')?.lastError === `${'x'.repeat(180)} ${HOME}`.slice(0, 200), dash.accounts.find((x) => x.name === 'out')?.lastError);
  check('stdio/no string of the snapshot holds the home path as a path', JSON.stringify(snap).split(HOME).slice(1).every((rest) => rest.startsWith('x')), JSON.stringify(snap));
  check('stdio/a cooling-down worker has cooldownUntil in the future', typeof by.cool?.cooldownUntil === 'number' && by.cool.cooldownUntil > Date.now(), by.cool);
  // CA: the fixture's logged-out reading of `out` carries no login probe of this version — what a
  // 1.x writer or another process leaves — so it is no verdict: the server probed it, and the fake
  // CLI is logged in. ("expired" for a confirmed logout is checked by login-state.mjs.)
  check('CA stdio/an unconfirmed logged-out reading is not "expired" — it was re-probed and the CLI is logged in', by.out?.login === 'no-plan-limits' && by.out?.loginCheck?.state === 'ok', by.out);
  check('CA stdio/a Claude Code account carries loginCheck; another vendor\'s does not', by.main?.loginCheck?.state === 'ok' && by.cx?.loginCheck === null, [by.main?.loginCheck, by.cx?.loginCheck]);
  check('stdio/the other-vendor worker is provider codex, label not Claude', by.cx?.provider === 'codex' && by.cx?.isWorker === true && by.cx?.providerLabel !== 'Claude Code', by.cx);
  check('stdio/a worker named __proto__ is an own, plain entry with its own counters', Object.hasOwn(by, '__proto__') && by['__proto__']?.allTime?.tasks === 1 && by['__proto__']?.isWorker === true, snap.accounts.map((x) => x.name));
  checkEq('stdio/the unusable entry is listed', snap.unsupportedAccounts.map((x) => x.name), ['ghost']);
  checkEq('stdio/guards: "allow" is allow, anything else (here "yes please") is block', snap.guards, { overageWorkerDispatch: 'block', frontierWorkerDispatch: 'allow' });

  // The other guard values.
  writeFixture({ guards: { frontierWorkerDispatch: 'block', overageWorkerDispatch: 'allow' } });
  const g1 = await fresh.listWorkers();
  checkEq('stdio/guards: block / allow as written', g1?.result?.structuredContent?.guards, { overageWorkerDispatch: 'allow', frontierWorkerDispatch: 'block' });
  writeFixture({ guards: { frontierWorkerDispatch: 42, overageWorkerDispatch: 'ALLOW' } });
  const g2 = await fresh.listWorkers();
  checkEq('stdio/guards: a number and "ALLOW" are block', g2?.result?.structuredContent?.guards, { overageWorkerDispatch: 'block', frontierWorkerDispatch: 'block' });

  // An unreadable registry.
  const regFile = path.join(ROOT, 'registry.json');
  const good = fs.readFileSync(regFile, 'utf8');
  fs.writeFileSync(regFile, '{ "workers": [ , }');
  const [ua, ub] = await Promise.all([fresh.listWorkers(), old.listWorkers()]);
  check('stdio/unreadable registry: isError true', ua?.result?.isError === true, ua);
  check('stdio/unreadable registry: no structuredContent at all', ua?.result !== undefined && !Object.hasOwn(ua.result, 'structuredContent'), ua);
  check('stdio/unreadable registry: the error text is the committed server\'s', textOf(ua) === textOf(ub), { new: textOf(ua), old: textOf(ub) });
  fs.writeFileSync(regFile, good);
  fresh.stop();
  old.stop();

  // The refreshes themselves are single-flight — shown on stdio, where no answer is reused.
  writeFixture({ stale: true });
  fs.writeFileSync(FAKE_LOG, '');
  const solo = startStdio(NEW_JS);
  await solo.init();
  const many = await Promise.all(Array.from({ length: 10 }, () => solo.listWorkers()));
  const perDir = {};
  for (const r of fakeRecords().filter((x) => x.kind === 'usage')) perDir[r.dir] = (perDir[r.dir] ?? 0) + 1;
  check('stdio/10 parallel calls against stale readings: every one answered with a snapshot', many.every((m) => m?.result?.structuredContent?.schema === 'cco.workers/1'), many.find((m) => !m?.result?.structuredContent));
  check('stdio/…and at most one usage probe per account (single-flight refresh)', Object.keys(perDir).length > 0 && Object.values(perDir).every((n) => n === 1), perDir);
  solo.stop();
}

async function hostSection(lib) {
  writeFixture({ stale: true });
  fs.writeFileSync(FAKE_LOG, '');
  const host = await startHost(lib);
  try {
    const conns = [];
    for (let i = 0; i < 4; i++) {
      const c = await connect(host.socket);
      const hello = await c.request('cco/hello', { protocol: lib.HP.PROTOCOL_VERSION, role: 'observer', client: 'gilde', clientPid: process.pid });
      check(`host/observer ${i + 1} is greeted`, hello?.result !== undefined, hello);
      conns.push(c);
    }
    // 20 calls at once, five on each of four observer connections, against stale readings.
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => conns[i % 4].request('tools/call', { name: 'list_workers', arguments: {} })));
    const snaps = answers.map((m) => m?.result?.structuredContent);
    check('host/every observer call got a structuredContent', snaps.every((s) => s?.schema === 'cco.workers/1'), answers.find((m) => m?.result?.structuredContent === undefined));
    const gens = new Set(snaps.map((s) => s?.generatedAt));
    check('host/20 parallel observer calls share ONE generatedAt', gens.size === 1, [...gens]);
    check('host/…and one text', new Set(answers.map(textOf)).size === 1, '');
    const usageProbes = fakeRecords().filter((r) => r.kind === 'usage');
    const perDir = {};
    for (const r of usageProbes) perDir[r.dir] = (perDir[r.dir] ?? 0) + 1;
    check('host/the stale readings WERE probed (the test exercises the refresh)', usageProbes.length > 0, fakeRecords());
    check('host/at most one usage probe per account', Object.values(perDir).every((n) => n <= 1), perDir);
    check('host/no vendor shim ran', !fakeRecords().some((r) => r.kind === 'vendor-shim'), fakeRecords());
    const accountsOf = snaps[0]?.accounts ?? [];
    check('host/the snapshot has the fixture\'s accounts', accountsOf.map((a) => a.name).join(',') === 'main,wa,cool,out,__proto__,cx', accountsOf.map((a) => a.name));
    check('host/observer lastError shows ~', accountsOf.find((a) => a.name === 'cool')?.lastError === `E ~/a ${HOME}x`, accountsOf.find((a) => a.name === 'cool'));
    check('host/no unread footer or other member was added to the observer\'s result', Object.keys(answers[0]?.result ?? {}).sort().join(',') === 'content,structuredContent', answers[0]?.result);

    // Within the floor: the same answer, nothing started.
    const before = fakeRecords().length;
    const again = await conns[0].request('tools/call', { name: 'list_workers', arguments: {} });
    check('host/a call within the floor gets the same generatedAt', again?.result?.structuredContent?.generatedAt === snaps[0]?.generatedAt, [again?.result?.structuredContent?.generatedAt, snaps[0]?.generatedAt]);
    check('host/…and the same text', textOf(again) === textOf(answers[0]), '');
    check('host/…and starts no probe', fakeRecords().length === before, fakeRecords().slice(before));

    if (FLOOR_WAIT) {
      await sleep(lib.HP.WORKERS_SNAPSHOT_MIN_POLL_MS + 1500);
      const later = await conns[1].request('tools/call', { name: 'list_workers', arguments: {} });
      const g = later?.result?.structuredContent?.generatedAt;
      check('host/a call after the floor gets a NEW generatedAt', typeof g === 'number' && g > snaps[0].generatedAt + lib.HP.WORKERS_SNAPSHOT_MIN_POLL_MS, [g, snaps[0]?.generatedAt]);
    } else {
      console.log('SKIP host/a call after the floor gets a NEW generatedAt (--no-floor-wait)');
    }
    for (const c of conns) c.close();
  } finally {
    host.stop();
  }
}


/* ------------------------------------------------------------------------- *
 * G2 sections
 * ------------------------------------------------------------------------- */

const lw = (conn) => conn.request('tools/call', { name: 'list_workers', arguments: {} });
const snapOf = (msg) => msg?.result?.structuredContent;
const namesOf = (msg) => (snapOf(msg)?.accounts ?? []).map((a) => a.name);
const accountOf = (msg, name) => snapOf(msg)?.accounts?.find((a) => a.name === name);
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const REG_FILE = () => path.join(ROOT, 'registry.json');
const USAGE_FILE = () => path.join(ROOT, 'usage.json');
const STATS_FILE = () => path.join(ROOT, 'stats.json');
/** A fresh, logged-in reading for `dir` (no probe is due for it during the run). */
/** The login probe this version's refresh files beside a good usage reading (usage.loginProbeOfReading). */
function loginProbe(dir, at, result = 'in') {
  return { at, path: dir === MAIN_DIR ? 'unset' : 'explicit', result, via: result === 'in' ? 'usage' : 'status', reason: result === 'in' ? 'plan usage read (max)' : 'claude auth status said not logged in' };
}

function freshReading(name, dir) {
  const now = Date.now();
  return {
    loginProbes: [loginProbe(dir, now)],
    name,
    configDir: dir,
    available: true,
    subscriptionType: 'max',
    windows: [{ kind: 'session', label: 'Session (5hr)', percent: 5, severity: 'normal', resetsAt: new Date(now + 3_600_000).toISOString() }],
    sessionCostUsd: 0,
    extraUsage: { enabled: false, percent: null, spendLabel: null },
    fetchedAt: now,
    windowsFetchedAt: now,
    windowsStale: false,
    lastGoodWindowsAt: now,
  };
}

/**
 * role — the floor keyed on the connection's role, the generation that invalidates the observer
 * cache, servedFromCache, and the isError `~`, through a real host with observer AND session
 * connections.
 */
async function roleSection(lib) {
  writeFixture({ stale: true });
  fs.writeFileSync(FAKE_LOG, '');
  const host = await startHost(lib);
  try {
    const hello = async (role) => {
      const c = await connect(host.socket);
      const params =
        role === 'observer'
          ? { protocol: lib.HP.PROTOCOL_VERSION, role: 'observer', client: 'gilde', clientPid: process.pid }
          : { protocol: lib.HP.PROTOCOL_VERSION, session: host.session, clientPid: process.pid };
      const r = await c.request('cco/hello', params);
      check(`G2 role/${role} connection is greeted`, r?.result !== undefined, r);
      return c;
    };
    const o1 = await hello('observer');
    const o2 = await hello('observer');
    const s1 = await hello('session');
    const s2 = await hello('session');
    const conns = [o1, s1, o2, s2];

    // Before any answer exists: an unreadable registry is an isError text with the home as `~`.
    const intact = fs.readFileSync(REG_FILE(), 'utf8');
    fs.writeFileSync(REG_FILE(), '{ "workers": [ , }');
    const [fo, fs1] = await Promise.all([lw(o1), lw(s1)]);
    for (const [who, m] of [['observer', fo], ['session', fs1]]) {
      check(`G2 role/first call, unreadable registry (${who}): isError whose text names the registry with ~ and holds no home path`, m?.result?.isError === true && typeof textOf(m) === 'string' && textOf(m).includes('~/.claude-code-orchestrator/registry.json') && !textOf(m).includes(HOME), textOf(m));
    }
    fs.writeFileSync(REG_FILE(), intact);

    // 20 calls at once, mixed session and observer, against stale readings.
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => lw(conns[i % 4])));
    check('G2 role/20 parallel mixed session+observer calls: every one has a snapshot', many.every((m) => snapOf(m)?.schema === 'cco.workers/1'), many.find((m) => !snapOf(m)));
    const perDir = {};
    for (const r of fakeRecords().filter((x) => x.kind === 'usage')) perDir[r.dir] = (perDir[r.dir] ?? 0) + 1;
    check('G2 role/…the stale readings were probed', Object.keys(perDir).length > 0, fakeRecords());
    check('G2 role/…at most one usage probe per account', Object.values(perDir).every((n) => n <= 1), perDir);

    // A session call 1 s after an observer call: fresh. An observer call after it: the cache.
    const a = await lw(o1);
    await sleep(1000);
    const b = await lw(s1);
    check('G2 role/a SESSION call 1 s after an observer call gets a NEW generatedAt', snapOf(b)?.generatedAt > snapOf(a)?.generatedAt, [snapOf(a)?.generatedAt, snapOf(b)?.generatedAt]);
    check('G2 role/…and servedFromCache false', snapOf(b)?.servedFromCache === false, snapOf(b)?.servedFromCache);
    const c = await lw(o2);
    check('G2 role/a second observer call inside the floor gets servedFromCache true', snapOf(c)?.servedFromCache === true, snapOf(c)?.servedFromCache);
    check('G2 role/…with the session\'s answer (its generatedAt and text — the session\'s fresh answer refreshed the cache)', snapOf(c)?.generatedAt === snapOf(b)?.generatedAt && textOf(c) === textOf(b), [snapOf(c)?.generatedAt, snapOf(b)?.generatedAt]);
    await sleep(5);
    const d = await lw(s2);
    check('G2 role/another session call inside the floor is fresh again (never the observer cache)', snapOf(d)?.servedFromCache === false && snapOf(d)?.generatedAt > snapOf(b)?.generatedAt, [snapOf(d)?.servedFromCache, snapOf(d)?.generatedAt, snapOf(b)?.generatedAt]);

    // The registry rewritten with the same bytes is not a change (content, not stat).
    fs.writeFileSync(REG_FILE(), fs.readFileSync(REG_FILE()));
    const e = await lw(o1);
    check('G2 role/the registry rewritten byte for byte: the observer is still answered from the cache', snapOf(e)?.servedFromCache === true && snapOf(e)?.generatedAt === snapOf(d)?.generatedAt, [snapOf(e)?.servedFromCache, snapOf(e)?.generatedAt, snapOf(d)?.generatedAt]);

    // A worker added inside the floor.
    fs.mkdirSync(cfg('nw'), { recursive: true });
    const usage = readJson(USAGE_FILE());
    usage[cfg('nw')] = freshReading('nw', cfg('nw'));
    writeJson(USAGE_FILE(), usage);
    const reg = readJson(REG_FILE());
    reg.workers.splice(1, 0, { name: 'nw', configDir: cfg('nw'), model: 'opus' });
    writeJson(REG_FILE(), reg);
    const f = await lw(o1);
    check('G2 role/a worker added to registry.json inside the floor: the next observer call is fresh', snapOf(f)?.servedFromCache === false, snapOf(f)?.servedFromCache);
    check('G2 role/…and lists it', namesOf(f).includes('nw'), namesOf(f));
    const f2 = await lw(o2);
    check('G2 role/…and the observer call after that is the cache again (the generation is stable)', snapOf(f2)?.servedFromCache === true && snapOf(f2)?.generatedAt === snapOf(f)?.generatedAt, [snapOf(f2)?.servedFromCache, snapOf(f2)?.generatedAt]);

    // …and removed.
    reg.workers = reg.workers.filter((w) => w.name !== 'nw');
    writeJson(REG_FILE(), reg);
    const g = await lw(o1);
    check('G2 role/a worker removed: gone from the next observer call at once', snapOf(g) !== undefined && !namesOf(g).includes('nw') && snapOf(g).servedFromCache === false, [snapOf(g)?.servedFromCache, namesOf(g)]);

    // A cooldown written to stats.json.
    const until = Date.now() + 10 * 60_000;
    const stats = readJson(STATS_FILE());
    stats.wa = { tasks: 1, errors: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, cooldownUntil: until };
    writeJson(STATS_FILE(), stats);
    const h = await lw(o2);
    check('G2 role/a cooldown written to stats.json: the next observer call is fresh', snapOf(h)?.servedFromCache === false, snapOf(h)?.servedFromCache);
    checkEq('G2 role/…and shows it', accountOf(h, 'wa')?.cooldownUntil, until);
    const h2 = await lw(o1);
    check('G2 role/…then the cache again', snapOf(h2)?.servedFromCache === true, snapOf(h2)?.servedFromCache);

    // …and cleared.
    delete stats.wa.cooldownUntil;
    writeJson(STATS_FILE(), stats);
    const i = await lw(o1);
    check('G2 role/a cooldown cleared: fresh, cooldownUntil null', snapOf(i)?.servedFromCache === false && accountOf(i, 'wa')?.cooldownUntil === null, [snapOf(i)?.servedFromCache, accountOf(i, 'wa')?.cooldownUntil]);

    // A login change of one account.
    const usage2 = readJson(USAGE_FILE());
    usage2[cfg('wa')] = { name: 'wa', configDir: cfg('wa'), available: false, auth: { loggedIn: false, method: 'claude.ai', email: null }, windows: [], fetchedAt: Date.now() };
    writeJson(USAGE_FILE(), usage2);
    const j = await lw(o2);
    // CA: a reading that says "logged out" without a login probe of this version is no verdict — the
    // fresh answer re-probes it (the fake CLI is logged in), so it is not "expired".
    check('G2 role/a login change: the next observer call is fresh (and re-probes the unconfirmed reading)', snapOf(j)?.servedFromCache === false && accountOf(j, 'wa')?.login !== 'expired' && accountOf(j, 'wa')?.loginCheck?.state === 'ok', [snapOf(j)?.servedFromCache, accountOf(j, 'wa')?.login, accountOf(j, 'wa')?.loginCheck]);

    // An unreadable registry: isError, with the home directory as `~`, for both roles.
    const good = fs.readFileSync(REG_FILE(), 'utf8');
    fs.writeFileSync(REG_FILE(), '{ "workers": [ , }');
    const [eo, es] = await Promise.all([lw(o1), lw(s1)]);
    for (const [who, m] of [['observer', eo], ['session', es]]) {
      check(`G2 role/unreadable registry (${who}): isError, no structuredContent`, m?.result?.isError === true && !Object.hasOwn(m.result, 'structuredContent'), m);
      check(`G2 role/…its text names the registry with ~ (${who})`, typeof textOf(m) === 'string' && textOf(m).includes('~/.claude-code-orchestrator/registry.json'), textOf(m));
      check(`G2 role/…and holds no home path (${who})`, typeof textOf(m) === 'string' && !textOf(m).includes(HOME), textOf(m));
    }
    fs.writeFileSync(REG_FILE(), good);
    // The refusal was not remembered, and the registry is now what it was at answer `j`: the same
    // generation, so `j` is a true answer again.
    const k = await lw(o1);
    check('G2 role/the registry readable again (the same bytes): the answer from before the refusal, from the cache', snapOf(k)?.servedFromCache === true && snapOf(k)?.generatedAt === snapOf(j)?.generatedAt, k);
    for (const conn of conns) conn.close();
  } finally {
    host.stop();
  }
}

/**
 * memory — a cooldown the server could not write to stats.json (stats.json is unreadable here)
 * is held in its memory; the text shows it, and so must the snapshot.
 */
async function memorySection(lib) {
  writeFixture();
  writeJson(REG_FILE(), { ...readJson(REG_FILE()), workers: [{ name: 'wa', configDir: cfg('wa'), model: 'opus' }] });
  // A stats.json that cannot be READ refuses every update (registry.updateStats: a failed read
  // never becomes reset counters) — so the quota cooldown cannot be written, and is held in memory.
  fs.chmodSync(STATS_FILE(), 0o000);
  fs.writeFileSync(FAKE_LOG, '');
  const srv = startStdio(NEW_JS);
  try {
    await srv.init();
    const before = Date.now();
    const run = await srv.call('dispatch_task', { title: 'quota', prompt: 'say hi', worker: 'wa' }, 90_000);
    check('G2 memory/the dispatch ran the fake and failed on quota', fakeRecords().some((r) => r.kind === 'run') && /quota|limit/i.test(textOf(run) ?? ''), { run: textOf(run), fakes: fakeRecords() });
    const m = await srv.listWorkers();
    const line = (textOf(m) ?? '').split('\n').find((l) => l.startsWith('- wa'));
    check('G2 memory/the text shows the cooldown held in memory', typeof line === 'string' && line.includes('COOLING DOWN'), textOf(m));
    const cd = accountOf(m, 'wa')?.cooldownUntil;
    check('G2 memory/an in-memory cooldown is present in the snapshot', typeof cd === 'number' && cd > before && cd > snapOf(m).generatedAt, accountOf(m, 'wa'));
    const dashWa = lib.UI.buildDashboardModel({ now: Date.now(), workspaceRoot: WS, scope: 'all' }).accounts.find((x) => x.name === 'wa');
    check('G2 memory/…while the dashboard (which cannot see that memory) shows none', dashWa?.cooldownUntil === null, { cooldownUntil: dashWa?.cooldownUntil, now: Date.now() });
  } finally {
    srv.stop();
    fs.chmodSync(STATS_FILE(), 0o600);
  }
}

/** caps — the snapshot's caps at their limit and one past; a past cooldown is null. */
async function capsSection(lib) {
  const cap = lib.UI.capSnapshotAccounts;
  const has = typeof cap === 'function';
  writeFixture();
  const srv = startStdio(NEW_JS);
  try {
    await srv.init();
    // A cooldown that has passed.
    const stats = readJson(STATS_FILE());
    stats.cool.cooldownUntil = Date.now() - 5_000;
    writeJson(STATS_FILE(), stats);
    const past = await srv.listWorkers();
    check('G2 caps/a past cooldownUntil is null', accountOf(past, 'cool') !== undefined && accountOf(past, 'cool').cooldownUntil === null, accountOf(past, 'cool'));
    const base = accountOf(past, 'wa');
    const one = (over) => (has ? cap([{ ...base, ...over }])[0] : undefined);
    const exact = (name, over, read, expected) => check(name, has && JSON.stringify(read(one(over))) === JSON.stringify(expected), has ? read(one(over)) : 'capSnapshotAccounts is not exported');
    const k128 = 'k'.repeat(128);
    exact('G2 caps/key of 128 chars is kept', { key: k128 }, (a) => a?.key, k128);
    exact('G2 caps/key of 129 chars is cut to 128', { key: `${k128}z` }, (a) => a?.key, k128);
    const s40 = 's'.repeat(40);
    exact('G2 caps/overage.spendLabel of 40 is kept', { overage: { enabled: true, percent: 3, spendLabel: s40 } }, (a) => a?.overage, { enabled: true, percent: 3, spendLabel: s40 });
    exact('G2 caps/overage.spendLabel of 41 is cut to 40', { overage: { enabled: true, percent: 3, spendLabel: `${s40}z` } }, (a) => a?.overage, { enabled: true, percent: 3, spendLabel: s40 });
    const n64 = 'n'.repeat(64);
    exact('G2 caps/a sameAccountAs name of 64 is kept', { sameAccountAs: [n64] }, (a) => a?.sameAccountAs, [n64]);
    exact('G2 caps/a sameAccountAs name of 65 is cut to 64', { sameAccountAs: [`${n64}z`] }, (a) => a?.sameAccountAs, [n64]);
    const names = Array.from({ length: 9 }, (_, i) => `a${i}`);
    exact('G2 caps/8 sameAccountAs names are kept', { sameAccountAs: names.slice(0, 8) }, (a) => a?.sameAccountAs, names.slice(0, 8));
    exact('G2 caps/9 sameAccountAs names are cut to the first 8', { sameAccountAs: names }, (a) => a?.sameAccountAs, names.slice(0, 8));
    const win = base.windows[0] ?? { kind: 'session', label: 'S', percent: 1, severity: 'normal', resetsAt: null };
    const wins = Array.from({ length: 9 }, (_, i) => ({ ...win, percent: i }));
    exact('G2 caps/8 windows are kept', { windows: wins.slice(0, 8) }, (a) => a?.windows, wins.slice(0, 8));
    exact('G2 caps/9 windows are cut to the first 8', { windows: wins }, (a) => a?.windows, wins.slice(0, 8));
    const list = (n) => Array.from({ length: n }, (_, i) => ({ ...base, name: `w${i}` }));
    check('G2 caps/200 accounts are kept', has && cap(list(200)).length === 200, has ? cap(list(200)).length : 'not exported');
    check('G2 caps/201 accounts are cut to the first 200', has && cap(list(201)).length === 200 && cap(list(201)).at(-1).name === 'w199', has ? cap(list(201)).length : 'not exported');
    checkEq('G2 caps/a value within every cap is the same value', has ? cap([base]) : 'not exported', [base]);

    // Through the server: the registry's own limit (200 workers) plus main is 201 accounts.
    const usage = readJson(USAGE_FILE());
    const workers = [];
    for (let i = 0; i < 200; i++) {
      const dir = cfg(`m${i}`);
      workers.push({ name: `m${i}`, configDir: dir, model: 'opus' });
      usage[dir] = freshReading(`m${i}`, dir);
    }
    usage[MAIN_DIR] = freshReading('main', MAIN_DIR);
    writeJson(USAGE_FILE(), usage);
    writeJson(REG_FILE(), { ...readJson(REG_FILE()), workers });
    const big = await srv.listWorkers();
    const dash = lib.UI.buildDashboardModel({ now: Date.now(), workspaceRoot: WS, scope: 'all' });
    check('G2 caps/200 registered workers + main: the dashboard has 201 accounts', dash.accounts.length === 201, dash.accounts.length);
    check('G2 caps/…the snapshot 200 (main first, the last worker cut)', snapOf(big)?.accounts?.length === 200 && namesOf(big)[0] === 'main' && namesOf(big).at(-1) === 'm198', [snapOf(big)?.accounts?.length, namesOf(big).at(-1)]);
    check('G2 caps/…and no probe ran for them', !fakeRecords().some((r) => r.kind === 'usage' && /\/m\d+$/.test(r.dir)), '');
  } finally {
    srv.stop();
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

async function main() {
  await build();
  writeFakes();
  // THIS process reads the same sandbox through the lib bundle: HOME first, then the load — with
  // the keychain kept out of it as for every child.
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  process.env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  process.env.CCO_KEYCHAIN_GUARD_LOG = GUARD_LOG;
  if (NODE_OPTIONS !== '') process.env.NODE_OPTIONS = NODE_OPTIONS;
  delete process.env.CLAUDE_CONFIG_DIR;
  if (GUARD_PRESENT) createRequire(import.meta.url)(GUARD);
  else console.log('NOTE the keychain guard (.orchestrator/fixes/keychain-guard.cjs) is not there yet: not preloaded');
  writeFixture();
  const lib = createRequire(import.meta.url)(LIB_CJS);
  await stdioSection(lib);
  await capsSection(lib);
  await memorySection(lib);
  await roleSection(lib);
  await hostSection(lib);
}

let crashed = false;
try {
  await main();
} catch (err) {
  crashed = true;
  console.log(`FAIL harness — ${clip(err instanceof Error ? err.stack : err, 1200)}`);
}
for (const child of live) child.kill('SIGKILL');
let guardLog = '';
try {
  guardLog = fs.readFileSync(GUARD_LOG, 'utf8');
} catch {
  // no log: nothing was refused
}
check('keychain/the keychain guard logged nothing', guardLog.trim() === '', guardLog);
if (!KEEP) {
  fs.rmSync(BASE, { recursive: true, force: true });
} else {
  console.log(`kept ${BASE}`);
}
fs.rmSync(SOCK_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length + (crashed ? 1 : 0)} failed`);
process.exit(failures.length === 0 && !crashed ? 0 : 1);
