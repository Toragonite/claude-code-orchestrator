#!/usr/bin/env node
// login-state.mjs — offline checks of the LOGIN STATE of Claude Code accounts (task CA,
// contract-2.0-fixes.md "Login state (CA)"): the reproduction of the false "logged out" that
// list_workers printed for a working default account, the two hypotheses for it, the fix, the
// dispatch and team gates, `list_workers --check` / `--diagnostics`, and the state machine itself.
//
//   node .orchestrator/fixes/login-state.mjs                 every section, on the CURRENT sources
//   node .orchestrator/fixes/login-state.mjs --src <dir>     bundle from <dir>/src instead — e.g. the
//                                                            committed sources (`git archive HEAD src |
//                                                            tar -x -C <dir>`), to see which checks
//                                                            fail there
//   node .orchestrator/fixes/login-state.mjs --only h1,gate  some sections
//   node .orchestrator/fixes/login-state.mjs --keep          leave the scratch directory behind
//
// Sections: model · h1 · h2 · check · gate · run · team. Each check prints `PASS <name>` or
// `FAIL <name> — <why>`; INFO lines document what the old code does where both behave alike. The
// last line is the tally. Exit 0 only when every check passed.
//
// WHAT RUNS. Two esbuild bundles in a scratch directory (never `out/`): the dispatch server
// (src/mcp/server.ts) — run over stdio, and as a real host for the team section — and a library
// of src/usage.ts + src/mcp/task-runner.ts loaded in THIS process with HOME pointed at the same
// sandbox.
//
// ISOLATION. HOME (and USERPROFILE) are a scratch directory for every process, and `claude` is a
// FAKE written below: it answers per account from a control file (logged in / not logged in /
// a failing check / a hanging one; a usage reading or none; a run that works or one that says
// "Not logged in"), and it models VERIFICATION-2.0 PP-5 — CLAUDE_CONFIG_DIR exported as the
// DEFAULT directory is a different credential store, which is logged out. Every invocation is
// logged with how CLAUDE_CONFIG_DIR was given. `codex`, `cursor-agent` and `agy` on PATH are shims
// that log and fail. No vendor CLI runs, nothing under the real home is read or written.
//
// KEYCHAIN. AGENT_CLI_CREDENTIAL_STORE=memory in every environment handed to product code; the
// keychain guard (.orchestrator/fixes/keychain-guard.cjs) is preloaded when it exists, and the
// run FAILS when its log is not empty at the end.

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
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const SRC_ROOT = opt('--src') !== undefined ? path.resolve(opt('--src')) : REPO;
const ONLY = opt('--only') !== undefined ? new Set(opt('--only').split(',').map((s) => s.trim())) : undefined;

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-login-state-')));
const SOCK_DIR = fs.mkdtempSync('/tmp/cco-ls-');
const OUT = path.join(BASE, 'out');
const BIN = path.join(BASE, 'bin');
const SYSTEM_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

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
function clip(value, max = 500) {
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
const info = (text) => console.log(`INFO ${text}`);

/* ------------------------------------------------------------------------- *
 * Build
 * ------------------------------------------------------------------------- */

const SERVER_JS = path.join(OUT, 'mcp', 'server.js');
const LIB_CJS = path.join(OUT, 'lib.cjs');

async function build() {
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  const common = { bundle: true, platform: 'node', target: 'node18', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')] };
  await esbuild.build({ ...common, entryPoints: [path.join(SRC_ROOT, 'src', 'mcp', 'server.ts')], outfile: SERVER_JS });
  await esbuild.build({
    ...common,
    stdin: {
      contents: [`export * as U from './src/usage';`, `export * as TR from './src/mcp/task-runner';`, `export * as REG from './src/registry';`, `export * as HP from './src/mcp/host-protocol';`].join('\n'),
      resolveDir: SRC_ROOT,
      loader: 'ts',
      sourcefile: 'login-state-entry.ts',
    },
    format: 'cjs',
    outfile: LIB_CJS,
  });
}

/* ------------------------------------------------------------------------- *
 * The fake `claude`
 * ------------------------------------------------------------------------- */

const HOME = path.join(BASE, 'home');
const ROOT = path.join(HOME, '.claude-code-orchestrator');
const WS = path.join(BASE, 'ws');
const MAIN_DIR = path.join(HOME, '.claude');
const cfg = (name) => path.join(HOME, 'configs', name);
const FAKE_LOG = path.join(BASE, 'fake.log');
const CTRL = path.join(BASE, 'fake-ctrl.json');
const USAGE_FILE = path.join(ROOT, 'usage.json');
const REG_FILE = path.join(ROOT, 'registry.json');

function writeFakes() {
  fs.mkdirSync(BIN, { recursive: true });
  const fake = path.join(BIN, 'claude');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const kind = argv.includes('--version') ? 'version' : argv.includes('auth') && argv.includes('status') ? 'auth'
  : argv.includes('stream-json') && argv.includes('--input-format') ? 'usage' : argv[0] === 'agents' ? 'agents' : argv.includes('-p') ? 'run' : 'other';
const set = typeof process.env.CLAUDE_CONFIG_DIR === 'string';
// PP-5: CLAUDE_CONFIG_DIR exported as the DEFAULT directory is another credential store.
const key = !set ? '(default)' : process.env.CLAUDE_CONFIG_DIR === process.env.LS_DEFAULT_DIR ? '(explicit-default)' : process.env.CLAUDE_CONFIG_DIR;
let ctrl = {};
try { ctrl = JSON.parse(fs.readFileSync(process.env.LS_CTRL, 'utf8')); } catch {}
const me = Object.assign(key === '(explicit-default)' ? { auth: 'out', usage: 'none', run: 'notloggedin' } : { auth: 'in', usage: 'max', run: 'ok' }, ctrl[key] || {});
try { fs.appendFileSync(process.env.LS_FAKE_LOG, JSON.stringify({ kind, key, set, t: Date.now() }) + '\\n'); } catch {}
const say = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
if (kind === 'version') say('9.9.9 (Claude Code)\\n');
else if (kind === 'agents') say('[]\\n');
else if (kind === 'auth') {
  if (me.auth === 'in') say(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\\n');
  else if (me.auth === 'out') say(JSON.stringify({ loggedIn: false, authMethod: 'none' }) + '\\n', 1);
  else if (me.auth === 'hang') setTimeout(() => process.exit(0), 60000);
  else { process.stderr.write('Error: User interaction is not allowed. (SecKeychainItemCopyContent -25308) for stub@example.invalid\\n'); process.exit(1); }
}
else if (kind === 'usage') {
  let sent = false;
  const answer = () => {
    if (sent) return; sent = true;
    if (me.usage === 'fail') { process.stderr.write('boom\\n'); process.exit(1); }
    const resp = me.usage === 'max'
      ? { rate_limits_available: true, subscription_type: 'max', rate_limits: { limits: [{ kind: 'session', percent: 7, severity: 'normal', resets_at: new Date(Date.now() + 3600000).toISOString() }] } }
      : { rate_limits_available: false };
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'u1', response: resp } }) + '\\n');
  };
  process.stdin.on('data', answer);
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 15000);
}
else if (kind === 'run') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (me.run === 'notloggedin') say(JSON.stringify({ type: 'result', is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' }) + '\\n', 1);
    else say(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done by ' + key, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }) + '\\n');
  });
}
else { process.stderr.write('fake claude: unsupported ' + argv.join(' ') + '\\n'); process.exit(2); }
`,
  );
  fs.chmodSync(fake, 0o755);
  for (const cli of ['codex', 'cursor-agent', 'agy']) {
    const shim = path.join(BIN, cli);
    fs.writeFileSync(shim, `#!/bin/sh\necho '{"kind":"vendor-shim","cli":"${cli}"}' >> "$LS_FAKE_LOG"\nexit 1\n`);
    fs.chmodSync(shim, 0o755);
  }
}
const fakeRecords = () => {
  try {
    return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const clearFakeLog = () => fs.writeFileSync(FAKE_LOG, '');
const setCtrl = (ctrl) => fs.writeFileSync(CTRL, JSON.stringify(ctrl));

function env(extra = {}) {
  return {
    PATH: `${BIN}:${SYSTEM_PATH}`,
    HOME,
    USERPROFILE: HOME,
    TMPDIR: path.join(BASE, 'tmp'),
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    LS_FAKE_LOG: FAKE_LOG,
    LS_CTRL: CTRL,
    LS_DEFAULT_DIR: MAIN_DIR,
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    CCO_KEYCHAIN_GUARD_LOG: GUARD_LOG,
    ...(NODE_OPTIONS !== '' ? { NODE_OPTIONS } : {}),
    ...extra,
  };
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

/**
 * The registry: `workers` (name → { dir, model }) — every one a Claude Code worker. A fresh
 * stats.json, an empty task log.
 */
function writeRegistry(workers, extra = {}) {
  fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.mkdirSync(MAIN_DIR, { recursive: true });
  for (const w of workers) fs.mkdirSync(w.configDir, { recursive: true });
  writeJson(REG_FILE, {
    workers: workers.map((w) => ({ name: w.name, configDir: w.configDir, model: w.model ?? 'opus' })),
    permissionMode: 'acceptEdits',
    claudePath: path.join(BIN, 'claude'),
    cooldownMinutes: 30,
    workerTimeoutMinutes: 2,
    frontierWorkerDispatch: 'allow',
    overageWorkerDispatch: 'block',
    ...extra,
  });
  writeJson(path.join(ROOT, 'stats.json'), {});
}

/**
 * A reading as a 1.x writer (or any writer that is not this version's probe) leaves it: logged
 * out, no plan limits, no login probes — stamped `at` (default: now, i.e. "fresh").
 */
function foreignLoggedOut(name, dir, at = Date.now()) {
  return { name, configDir: dir, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: at, auth: { loggedIn: false, method: 'none', email: null, checkedAt: at } };
}

/* ------------------------------------------------------------------------- *
 * A stdio server, a host and its connections
 * ------------------------------------------------------------------------- */

const live = new Set();
function startStdio(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], { cwd: WS, env: env(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
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
  const request = (method, params, timeoutMs = 60_000) =>
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
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'login-state', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    listWorkers: (args = {}) => request('tools/call', { name: 'list_workers', arguments: args }),
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

/** A host whose SESSION is this test process — so its connections may say `role: session`. */
async function startHost(lib, extraEnv = {}) {
  const session = { pid: process.pid, kill: () => undefined };
  let startedAt;
  for (let i = 0; i < 50 && startedAt === undefined; i++) {
    startedAt = lib.REG.processStartedAt(session.pid);
    if (startedAt === undefined) await sleep(100);
  }
  const runDir = lib.HP.runDirOf(ROOT);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const socket = path.join(SOCK_DIR, `h${session.pid}.sock`);
  const specPath = path.join(runDir, `s${session.pid}.spec.json`);
  writeJson(specPath, {
    protocol: lib.HP.PROTOCOL_VERSION,
    session: { pid: session.pid, startedAt },
    workspace: fs.realpathSync(WS),
    socket,
    serverHash: 'login-state-test',
    logPath: path.join(runDir, `s${session.pid}.log`),
    failPath: path.join(runDir, `s${session.pid}.fail`),
  });
  const host = spawn(process.execPath, [SERVER_JS, '--host', specPath], { cwd: WS, env: env(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(host);
  let stderr = '';
  host.stderr.on('data', (d) => (stderr += d));
  host.on('exit', () => live.delete(host));
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await sleep(100);
  if (!fs.existsSync(socket)) {
    throw new Error(`the host did not listen (stderr ${clip(stderr)})`);
  }
  return { socket, session: { pid: session.pid, startedAt }, stderr: () => stderr, stop: () => host.kill('SIGKILL') };
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
        request: (method, params, timeoutMs = 60_000) =>
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

const textOf = (msg) => msg?.result?.content?.[0]?.text;
const lineOf = (text, prefix) => String(text ?? '').split('\n').find((l) => l.startsWith(prefix));
/** The account block of `name` in a list_workers text: its head line and its indented lines. */
function blockOf(text, head) {
  const lines = String(text ?? '').split('\n');
  const i = lines.findIndex((l) => l.startsWith(head));
  if (i === -1) return '';
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j++) out.push(lines[j]);
  return out.join('\n');
}

/* ------------------------------------------------------------------------- *
 * Sections
 * ------------------------------------------------------------------------- */

/** The state machine, in this process (usage.computeLoginState and the predicates around it). */
async function modelSection(lib) {
  const U = lib.U;
  const has = typeof U.computeLoginState === 'function';
  check('model/usage exports the login-state model (computeLoginState, loginStateOf, isLoginSuspect)', has && typeof U.loginStateOf === 'function' && typeof U.isLoginSuspect === 'function', Object.keys(U).filter((k) => /login/i.test(k)));
  if (!has) {
    // The old code: isLoginExpired is the only verdict — a foreign reading is "expired".
    const dir = cfg('m-old');
    writeRegistry([{ name: 'm-old', configDir: dir }]);
    check('model/a logged-out reading no probe of this version took is NOT a verdict (isLoginExpired false)', U.isLoginExpired(foreignLoggedOut('m-old', dir)) === false, 'isLoginExpired(foreign reading) is true');
    return;
  }
  const W = cfg('m1');
  writeRegistry([{ name: 'm1', configDir: W }]);
  // Probes a few seconds old must still be "in this process's lifetime" (PROCESS_STARTED_AT is when
  // the library was loaded).
  await sleep(U.PROCESS_STARTED_AT + 3_000 - Date.now());
  const now = Date.now();
  const probe = (at, result, via = 'status', p = 'explicit', reason = 'r') => ({ at, path: p, result, via, reason });
  const reading = (probes, over = {}) => ({ name: 'm1', configDir: W, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: now, loginProbes: probes, ...over });
  const st = (r) => U.computeLoginState(r, Date.now());
  const N = U.LOGIN_CONFIRM_GAP_MS;
  check('model/N is at least 10 s and the floor longer than the editor\'s 5-minute refresh', N >= 10_000 && U.LOGIN_FLOOR_MS > 5 * 60_000, [N, U.LOGIN_FLOOR_MS]);

  const foreign = foreignLoggedOut('m1', W);
  check('model/a foreign logged-out reading (no probes): unconfirmed, last known out, suspect, NOT expired', st(foreign).state === 'unconfirmed' && st(foreign).lastKnown === 'out' && U.isLoginSuspect(foreign) && !U.isLoginExpired(foreign), st(foreign));
  check('model/…and a check is due', U.loginCheckDue(foreign, Date.now()) === true, '');
  const one = reading([probe(now, 'out')]);
  check('model/ONE "not logged in" in this process: unconfirmed (confirming), suspect, not expired', st(one).state === 'unconfirmed' && /confirming/.test(st(one).reason) && U.isLoginSuspect(one) && !U.isLoginExpired(one), st(one));
  check('model/…its confirmation is not due before N', U.loginCheckDue(one, now + 1_000) === false && U.loginCheckDue(one, now + N + 1) === true, '');
  const twoClose = reading([probe(now - 5_000, 'out'), probe(now, 'out')]);
  check('model/two "not logged in" 5 s apart: still unconfirmed (a token refreshed a second later is no logout)', st(twoClose).state === 'unconfirmed' && !U.isLoginExpired(twoClose), st(twoClose));
  // Both inside this process's lifetime: the first may predate it, the newer may not.
  const twoApart = reading([probe(now - N - 1_000, 'out'), probe(now, 'out')]);
  check('model/two "not logged in" ≥ N apart, the newer in this process: loggedOut, expired, not suspect', st(twoApart).state === 'loggedOut' && U.isLoginExpired(twoApart) && !U.isLoginSuspect(twoApart), st(twoApart));
  check('model/…since the first of them', st(twoApart).since === now - N - 1_000, st(twoApart));
  const interrupted = reading([probe(now - N - 2_000, 'out'), probe(now - N - 1_000, 'failed'), probe(now, 'out')]);
  check('model/"not logged in", failed, "not logged in": not consecutive — unconfirmed', st(interrupted).state === 'unconfirmed', st(interrupted));
  const outThenFail = reading([probe(now - 1_000, 'out'), probe(now, 'failed', 'status', 'explicit', 'the macOS keychain is locked')]);
  check('model/a lone "not logged in" then a failed probe: probeFailed — neither suspect nor expired', st(outThenFail).state === 'probeFailed' && !U.isLoginSuspect(outThenFail) && !U.isLoginExpired(outThenFail), st(outThenFail));
  const confirmedThenFail = reading([probe(now - N - 2_000, 'out'), probe(now - 1_000, 'out'), probe(now, 'failed')]);
  check('model/a confirmed logout then a failed probe: still loggedOut (a failed probe says nothing)', st(confirmedThenFail).state === 'loggedOut' && U.isLoginExpired(confirmedThenFail), st(confirmedThenFail));
  const okThenFail = reading([probe(now - 1_000, 'in', 'usage'), probe(now, 'failed', 'status', 'explicit', 'the check timed out')]);
  check('model/a "logged in" then a failed probe: still ok, and the line says the last check could not run', st(okThenFail).state === 'ok' && /could not run: the check timed out — retrying/.test(U.loginStateText(st(okThenFail))), U.loginStateText(st(okThenFail)));
  const runBuried = reading([probe(now - 2_000, 'out', 'run'), probe(now, 'out', 'status')]);
  check('model/a failed dispatch followed by a "not logged in" check: still loggedOut', st(runBuried).state === 'loggedOut' && /a dispatch failed on login/.test(st(runBuried).reason), st(runBuried));
  const failedOnly = reading([probe(now, 'failed', 'status', 'explicit', 'the check timed out')]);
  check('model/only failed probes: probeFailed with the probe\'s reason; due again after a minute', st(failedOnly).state === 'probeFailed' && st(failedOnly).reason === 'the check timed out' && U.loginCheckDue(failedOnly, now + 1_000) === false && U.loginCheckDue(failedOnly, now + 61_000) === true, st(failedOnly));
  const run = reading([probe(now, 'out', 'run')]);
  check('model/a dispatch that failed on login: loggedOut at once', st(run).state === 'loggedOut' && U.isLoginExpired(run), st(run));
  const ok = reading([probe(now, 'in', 'usage')], { available: true });
  check('model/a "logged in" probe: ok', st(ok).state === 'ok' && !U.isLoginExpired(ok) && !U.isLoginSuspect(ok), st(ok));
  const wrongPath = reading([probe(now, 'in', 'usage', 'unset')]);
  check('model/a probe taken with the OTHER CLAUDE_CONFIG_DIR binding: unconfirmed', st(wrongPath).state === 'unconfirmed' && /CLAUDE_CONFIG_DIR/.test(st(wrongPath).reason), st(wrongPath));
  const old = reading([probe(now - U.LOGIN_FLOOR_MS - 60_000, 'in', 'usage')]);
  check('model/a probe older than the floor: unconfirmed, due', st(old).state === 'unconfirmed' && U.loginCheckDue(old, Date.now()), st(old));
  const before = reading([probe(U.PROCESS_STARTED_AT - 20_000, 'out'), probe(U.PROCESS_STARTED_AT - 1_000, 'out')]);
  check('model/a confirmed-looking logout taken BEFORE this process started: unconfirmed, suspect (never a verdict on another process\'s word)', st(before).state === 'unconfirmed' && U.isLoginSuspect(before) && !U.isLoginExpired(before), st(before));
  const sharedOk = reading([probe(U.PROCESS_STARTED_AT - 1_000, 'in', 'usage')], { available: true });
  check('model/a "logged in" another process of this version took: ok (shared, no re-probe)', st(sharedOk).state === 'ok' && U.loginCheckDue(sharedOk, Date.now()) === false, st(sharedOk));

  // Team routing's `cached` pick (M15: every account marked probed, nothing spawned): a foreign
  // "not logged in" is believed for the pick; this process's own lone "not logged in" holds.
  const TR = lib.TR;
  const workersOf = [{ name: 'm1', configDir: W, model: 'opus' }];
  const pickCached = async (entry) => {
    try {
      const r = await TR.pickWorkerLive(workersOf, undefined, new Set(), undefined, { [W]: entry }, false, new Set([W]), false);
      return r.worker.name;
    } catch (err) {
      return `refused: ${err.message}`;
    }
  };
  check('model/cached pick (team routing): a foreign "logged out" reading is not a refusal', (await pickCached(foreignLoggedOut('m1', W))) === 'm1', await pickCached(foreignLoggedOut('m1', W)));
  const ownOut = await pickCached(reading([probe(Date.now(), 'out')]));
  check('model/cached pick: this process\'s own fresh "not logged in" still holds the account back', /^refused: .*login expired\/logged out/.test(ownOut), ownOut);
  const conf = await pickCached(reading([probe(Date.now() - N - 1_000, 'out'), probe(Date.now(), 'out')]));
  check('model/cached pick: a confirmed logout is refused', /^refused: /.test(conf), conf);

  // Another vendor's reading keeps its rule: a raw "logged out" is expired.
  const cx = cfg('m-cx');
  writeJson(REG_FILE, { ...readJson(REG_FILE), workers: [...readJson(REG_FILE).workers, { name: 'm-cx', configDir: cx, model: '', provider: 'codex' }] });
  check('model/another vendor\'s raw "logged out" is still expired (its rule is unchanged)', U.isLoginExpired(foreignLoggedOut('m-cx', cx)) === true, '');

  // Reasons: a locked keychain is said as such; no address, nothing token-shaped.
  const why = U.loginFailureReason('Error: User interaction is not allowed. (SecKeychainItemCopyContent -25308) for stub@example.invalid');
  check('model/a locked keychain reads as one, and says what to do', /keychain is locked/.test(why) && /GUI session/.test(why) && !why.includes('@'), why);
  const scrub = U.loginFailureReason('failed for someone@example.com token sk-ant-abcdefghijklmnop0123456789');
  check('model/a reason never carries an address or a token', !scrub.includes('@example.com') && !scrub.includes('sk-ant-'), scrub);
  const line = U.loginDiagnosticsLine('m1', reading([probe(now - N - 1_000, 'out'), probe(now, 'out')]));
  check('model/a diagnostics line: state, then the probes with how CLAUDE_CONFIG_DIR was given', /^m1: loggedOut — logged out/.test(line) && (line.match(/explicit dir status → not logged in/g) ?? []).length === 2, line);
  check('model/wording: "logged out" only for loggedOut', !/logged out/.test(U.loginStateText(st(one))) && !/logged out/.test(U.loginStateText(st(failedOnly))) && /^couldn't check the login \(/.test(U.loginStateText(st(failedOnly))) && /^login not confirmed \(/.test(U.loginStateText(st(foreign))), [U.loginStateText(st(one)), U.loginStateText(st(failedOnly)), U.loginStateText(st(foreign))]);
}

/**
 * HYPOTHESIS 1 — the observed failure. main is a working Max login; usage.json holds, freshly
 * stamped, the logged-out reading a 1.x writer left for it (1.5.3 probed the default directory
 * with CLAUDE_CONFIG_DIR exported — `git show v1.5.3:src/usage.ts`, its spawn env — which reads
 * logged out, PP-5). The worker `tg` really is logged out.
 */
async function h1Section() {
  const TG = cfg('tg');
  writeRegistry([{ name: 'tg', configDir: TG }]);
  setCtrl({ [TG]: { auth: 'out', usage: 'none', run: 'notloggedin' } });
  const now = Date.now();
  writeJson(USAGE_FILE, { [MAIN_DIR]: foreignLoggedOut('main', MAIN_DIR, now), [TG]: foreignLoggedOut('tg', TG, now) });
  clearFakeLog();
  const srv = startStdio();
  try {
    await srv.init();
    const a = await srv.listWorkers();
    const text = textOf(a) ?? '';
    const mainBlock = blockOf(text, 'main (this session)');
    const probesOfMain = fakeRecords().filter((r) => r.key === '(default)' && (r.kind === 'usage' || r.kind === 'auth'));
    check('h1/main (a working login, foreign "logged out" reading in the cache) is NOT said to be logged out', mainBlock !== '' && !/logged out|LOGGED OUT|re-login needed/.test(mainBlock), mainBlock);
    check('h1/…the reading was not believed: main was probed in this call', probesOfMain.length > 0, fakeRecords());
    check('h1/…and main\'s line ends with its state and age: "login ok · checked just now"', / · login ok · checked just now$/m.test(mainBlock), mainBlock);
    const tg1 = blockOf(text, '- tg');
    check('h1/the really logged-out worker, after ONE probe: "login not confirmed", never LOGGED OUT', /login not confirmed/.test(tg1) && !/LOGGED OUT/.test(tg1), tg1);
    // The second probe: the server schedules it itself LOGIN_CONFIRM_GAP_MS later; a list_workers
    // after that sees it (or makes it).
    await sleep(16_500);
    const b = await srv.listWorkers();
    const tg2 = blockOf(textOf(b), '- tg');
    check('h1/…confirmed by a second probe ≥ N later: LOGGED OUT, "logged out (confirmed by checks at …)"', /— LOGGED OUT \(re-login needed\)/.test(tg2) && /logged out \(confirmed by checks at \d\d:\d\d and \d\d:\d\d/.test(tg2), tg2);
    const mainAgain = blockOf(textOf(b), 'main (this session)');
    check('h1/…while main stays "login ok"', / · login ok · /.test(mainAgain) && !/logged out/i.test(mainAgain), mainAgain);
  } finally {
    srv.stop();
  }

  // The same foreign reading, but OLDER than the 120 s refresh window: both old and new code
  // probe and say what the CLI says. So the observed failure needs a reading stamped recently by
  // ANOTHER process — a 1.x editor window still running, or a 1.x server of an older session.
  writeRegistry([]);
  writeJson(USAGE_FILE, { [MAIN_DIR]: foreignLoggedOut('main', MAIN_DIR, Date.now() - 10 * 60_000) });
  clearFakeLog();
  const old = startStdio();
  try {
    await old.init();
    const t = textOf(await old.listWorkers()) ?? '';
    info(`h1/a foreign reading older than the refresh window is re-probed by old and new code alike: main block = ${clip(blockOf(t, 'main (this session)'), 200)}`);
    check('h1/an old foreign reading: probed, not logged out', !/logged out/i.test(blockOf(t, 'main (this session)')) && fakeRecords().some((r) => r.key === '(default)'), t);
  } finally {
    old.stop();
  }
}

/**
 * HYPOTHESIS 2 — the probe environment. The fake treats CLAUDE_CONFIG_DIR exported as the default
 * directory as a different (logged-out) store. The host runs without the variable (as a session
 * on the default login does), so its probes of main must run without it too — and they do, in
 * old and new code: 2.0's probe goes through platform.claudeEnv (rule 2: unset for the default
 * directory). This pins it.
 */
async function h2Section(lib) {
  writeRegistry([]);
  writeJson(USAGE_FILE, {});
  setCtrl({});
  clearFakeLog();
  const srv = startStdio();
  try {
    await srv.init();
    const t = textOf(await srv.listWorkers()) ?? '';
    const ofMain = fakeRecords().filter((r) => r.kind === 'usage' || r.kind === 'auth');
    check('h2/every probe of main ran with CLAUDE_CONFIG_DIR ABSENT (as the session runs the CLI)', ofMain.length > 0 && ofMain.every((r) => r.set === false && r.key === '(default)'), ofMain);
    check('h2/…so main reads logged in', / · login ok · /.test(blockOf(t, 'main (this session)')), t);
  } finally {
    srv.stop();
  }
  // The in-process live check (dispatch and team gates) goes through the same environment.
  if (typeof lib.U.checkClaudeLogin === 'function') {
    process.env.HOME = HOME;
    clearFakeLog();
    const r = await lib.U.checkClaudeLogin({ name: 'main', configDir: MAIN_DIR }, 5_000);
    const rec = fakeRecords().filter((x) => x.kind === 'auth');
    check('h2/the live login check of main also runs without CLAUDE_CONFIG_DIR, and reads logged in', rec.length === 1 && rec[0].set === false && r.auth?.loggedIn === true && r.probe.path === 'unset', [rec, r.probe]);
  } else {
    check('h2/the live login check of main also runs without CLAUDE_CONFIG_DIR, and reads logged in', false, 'usage.checkClaudeLogin is not exported');
  }
  info('h2/the explicit binding of the default dir (what 1.5.3 did) reads logged out with this fake, exactly as PP-5 recorded for the real CLI; 2.0 never uses it for an unset host');
}

/** `list_workers --check` and `--diagnostics`. */
async function checkSection() {
  const WA = cfg('wa');
  writeRegistry([{ name: 'wa', configDir: WA }]);
  setCtrl({});
  writeJson(USAGE_FILE, {});
  const srv = startStdio();
  try {
    await srv.init();
    await srv.listWorkers();
    clearFakeLog();
    // Fresh and confirmed: a plain call probes nothing…
    await srv.listWorkers();
    check('check/a plain list_workers over fresh, confirmed readings probes nothing', fakeRecords().filter((r) => r.kind === 'usage' || r.kind === 'auth').length === 0, fakeRecords());
    // …`check: true` re-probes every Claude Code account, side by side.
    const t0 = Date.now();
    const c = await srv.listWorkers({ check: true });
    const took = Date.now() - t0;
    const keys = new Set(fakeRecords().filter((r) => r.kind === 'usage').map((r) => r.key));
    check('check/check: true re-probes every Claude Code account live', keys.has('(default)') && keys.has(WA), [...keys]);
    check('check/…bounded (well under 15 s with a prompt CLI)', took < 15_000, took);
    check('check/…and the answer carries the states', / · login ok · checked just now$/m.test(textOf(c) ?? ''), textOf(c));
    // A hanging login check of one account (with no earlier word on its login): --check still
    // answers within its 15 s round.
    const u = readJson(USAGE_FILE);
    delete u[WA];
    writeJson(USAGE_FILE, u);
    setCtrl({ [WA]: { usage: 'none', auth: 'hang' } });
    const t1 = Date.now();
    const h = await srv.listWorkers({ check: true });
    const took2 = Date.now() - t1;
    check('check/a hanging login check: --check still answers within ~15 s (the probe\'s own 5 s bound)', took2 < 20_000 && typeof textOf(h) === 'string', took2);
    check('check/…and the account reads "couldn\'t check the login (…) — retrying", not logged out', /couldn't check the login \(the login check timed out after 5 s\) — retrying/.test(blockOf(textOf(h), '- wa')) && !/LOGGED OUT|logged out/i.test(blockOf(textOf(h), '- wa')), blockOf(textOf(h), '- wa'));
    // Diagnostics.
    setCtrl({ [WA]: { usage: 'none', auth: 'fail' } });
    await srv.listWorkers({ check: true });
    const d = textOf(await srv.listWorkers({ diagnostics: true })) ?? '';
    const diag = d.slice(d.indexOf('Login diagnostics'));
    check('check/diagnostics: one line per Claude Code account', /\n- main: \w+ — /.test(diag) && /\n- wa: \w+ — /.test(diag), diag);
    check('check/…main\'s probes say env-unset, the worker\'s explicit dir', /- main: [^\n]*env-unset/.test(diag) && /- wa: [^\n]*explicit dir/.test(diag), diag);
    check('check/…a locked keychain is named as the reason, with what to do', /- wa: probeFailed — [^\n]*keychain is locked/.test(diag), diag);
    check('check/…no address, no token, no directory', !diag.includes('@example.invalid') && !diag.includes(HOME), diag);
    check('check/…and a plain list_workers has no diagnostics', !(textOf(await srv.listWorkers()) ?? '').includes('Login diagnostics'), '');
  } finally {
    srv.stop();
  }
}

/** The dispatch gate. */
async function gateSection() {
  // A worker whose only reading is a foreign "logged out", and whose login check FAILS (a locked
  // keychain). The run itself works. Old code: refused on the cached verdict. New: not refused.
  const WB = cfg('wb');
  writeRegistry([{ name: 'wb', configDir: WB }]);
  setCtrl({ [WB]: { auth: 'fail', usage: 'none', run: 'ok' } });
  writeJson(USAGE_FILE, { [WB]: foreignLoggedOut('wb', WB) });
  const srv = startStdio();
  try {
    await srv.init();
    clearFakeLog();
    const r = await srv.call('dispatch_task', { title: 'gate', prompt: 'say hi' }, 90_000);
    check('gate/an unconfirmed "logged out" + a login check that cannot run: the dispatch is NOT refused', r?.result?.isError !== true && /done by /.test(textOf(r) ?? ''), textOf(r));
    check('gate/…the gate re-checked the login live first', fakeRecords().some((x) => x.kind === 'auth' && x.key === WB), fakeRecords());
    const after = readJson(USAGE_FILE)[WB];
    check('gate/…and the successful run made the account `ok` (real work is evidence)', Array.isArray(after?.loginProbes) && after.loginProbes.at(-1)?.via === 'run' && after.loginProbes.at(-1)?.result === 'in', after?.loginProbes);

    // A named worker whose foreign "logged out" is contradicted by a live check: runs.
    writeJson(USAGE_FILE, { [WB]: foreignLoggedOut('wb', WB) });
    setCtrl({ [WB]: { auth: 'in', usage: 'none', run: 'ok' } });
    const n = await srv.call('dispatch_task', { title: 'named', prompt: 'say hi', worker: 'wb' }, 90_000);
    check('gate/named worker, foreign "logged out", live check says logged in: runs', /done by /.test(textOf(n) ?? ''), textOf(n));

    // A worker that really is logged out: refused after a live check, with the re-login route.
    writeJson(USAGE_FILE, { [WB]: foreignLoggedOut('wb', WB) });
    setCtrl({ [WB]: { auth: 'out', usage: 'none', run: 'notloggedin' } });
    clearFakeLog();
    const o = await srv.call('dispatch_task', { title: 'out', prompt: 'say hi' }, 90_000);
    check('gate/a really logged-out worker: refused after a live check, with the re-login command', o?.result?.isError === true && /login expired\/logged out/.test(textOf(o) ?? '') && /claude auth login/.test(textOf(o) ?? '') && fakeRecords().some((x) => x.kind === 'auth' && x.key === WB) && !fakeRecords().some((x) => x.kind === 'run'), textOf(o));
  } finally {
    srv.stop();
  }
}

/** A failed real dispatch that says "Not logged in": loggedOut at once, and the task fails over. */
async function runSection() {
  const WC = cfg('wc');
  const WD = cfg('wd');
  writeRegistry([{ name: 'wc', configDir: WC }, { name: 'wd', configDir: WD }]);
  setCtrl({ [WC]: { auth: 'out', usage: 'none', run: 'notloggedin' } });
  writeJson(USAGE_FILE, {});
  const srv = startStdio();
  try {
    await srv.init();
    clearFakeLog();
    const r = await srv.call('dispatch_task', { title: 'run', prompt: 'say hi', worker: 'wc' }, 90_000);
    const wc = readJson(USAGE_FILE)[WC];
    check('run/a named run that fails "Not logged in": the account is loggedOut at once (run probe)', Array.isArray(wc?.loginProbes) && wc.loginProbes.some((p) => p.via === 'run' && p.result === 'out'), [textOf(r), wc]);
    const l = textOf(await srv.listWorkers()) ?? '';
    check('run/…list_workers says LOGGED OUT for it right away', /- wc[^\n]*— LOGGED OUT/.test(l) && /logged out \(a dispatch failed on login at/.test(blockOf(l, '- wc')), blockOf(l, '- wc'));
    // Automatic assignment: wc is skipped now; with wc's verdict cleared it would be tried first —
    // so clear it and let the run prove it again, with wd there to fail over to.
    writeJson(USAGE_FILE, {});
    const a = await srv.call('dispatch_task', { title: 'auto', prompt: 'say hi' }, 90_000);
    const runs = fakeRecords().filter((x) => x.kind === 'run').map((x) => x.key);
    info(`run/automatic dispatch ran on: ${runs.join(', ')}`);
    check('run/automatic dispatch: a run that fails on login fails over to the next account', /done by /.test(textOf(a) ?? '') && (textOf(a) ?? '').includes(`done by ${WD}`), textOf(a));
  } finally {
    srv.stop();
  }
}

/**
 * team_create routes from CACHED verdicts and spawns nothing (team contract M15). A foreign
 * "logged out" reading of the only Claude Code worker made it refuse ("No account can take member
 * …"). The host now re-checks such an account live before the engine routes.
 */
async function teamSection(lib) {
  const WT = cfg('wt');
  writeRegistry([{ name: 'wt', configDir: WT }], { teamMode: 'on' });
  setCtrl({});
  writeJson(USAGE_FILE, { [WT]: foreignLoggedOut('wt', WT) });
  // The workspace is a git repository with one commit (team_create needs a base).
  const git = (...args) => execFileSync('git', args, { cwd: WS, env: { ...env(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' }, stdio: 'pipe' });
  if (!fs.existsSync(path.join(WS, '.git'))) {
    git('init', '-q');
    fs.writeFileSync(path.join(WS, 'README'), 'x\n');
    git('add', 'README');
    git('commit', '-q', '-m', 'init');
  }
  const host = await startHost(lib);
  try {
    const c = await connect(host.socket);
    const hello = await c.request('cco/hello', { protocol: lib.HP.PROTOCOL_VERSION, role: 'session', session: host.session, client: 'cco', clientPid: process.pid });
    check('team/the session is greeted', hello?.result !== undefined, hello);
    clearFakeLog();
    const r = await c.request('tools/call', { name: 'team_create', arguments: { name: 'web', goal: 'g', members: [{ name: 'alice', role: 'r', brief: 'b', start: false }] } }, 60_000);
    const t = textOf(r) ?? JSON.stringify(r);
    info(`team/team_create answered: ${clip(t, 300)}`);
    check('team/team_create over a foreign "logged out" reading of the only worker: NOT refused', !/No account can take member/.test(t) && r?.result?.isError !== true, t);
    check('team/…the host re-checked that login live before routing', fakeRecords().some((x) => x.kind === 'auth' && x.key === WT), fakeRecords());
    // A confirmed, fresh logout (< 60 s) is refused on without another probe.
    const now = Date.now();
    const usage = readJson(USAGE_FILE);
    usage[WT] = { ...foreignLoggedOut('wt', WT), loginProbes: [{ at: now - 20_000, path: 'explicit', result: 'out', via: 'status', reason: 'x' }, { at: now, path: 'explicit', result: 'out', via: 'status', reason: 'x' }] };
    writeJson(USAGE_FILE, usage);
    clearFakeLog();
    const r2 = await c.request('tools/call', { name: 'team_add', arguments: { members: [{ name: 'bob', role: 'r', brief: 'b', start: false }] } }, 60_000);
    const t2 = textOf(r2) ?? JSON.stringify(r2);
    info(`team/team_add over a fresh confirmed logout answered: ${clip(t2, 300)}`);
    check('team/…team_add over a confirmed logout of the only worker is refused for its login', /No account can take member bob/.test(t2) && /log/i.test(t2), t2);
    check('team/…a confirmed logout younger than 60 s is not probed again', !fakeRecords().some((x) => x.kind === 'auth' && x.key === WT), fakeRecords());
    c.close();
  } finally {
    host.stop();
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

async function main() {
  console.log(`login-state: sources from ${SRC_ROOT}`);
  await build();
  writeFakes();
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  process.env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  process.env.CCO_KEYCHAIN_GUARD_LOG = GUARD_LOG;
  process.env.PATH = `${BIN}:${SYSTEM_PATH}`;
  process.env.LS_FAKE_LOG = FAKE_LOG;
  process.env.LS_CTRL = CTRL;
  process.env.LS_DEFAULT_DIR = MAIN_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  const require = createRequire(import.meta.url);
  if (GUARD_PRESENT) require(GUARD);
  fs.mkdirSync(ROOT, { recursive: true });
  const lib = require(LIB_CJS);
  const sections = [
    ['model', () => modelSection(lib)],
    ['h1', () => h1Section()],
    ['h2', () => h2Section(lib)],
    ['check', () => checkSection()],
    ['gate', () => gateSection()],
    ['run', () => runSection()],
    ['team', () => teamSection(lib)],
  ];
  for (const [name, run] of sections) {
    if (ONLY !== undefined && !ONLY.has(name)) continue;
    try {
      await run();
    } catch (err) {
      check(`${name}/the section ran to its end`, false, err instanceof Error ? err.stack : String(err));
    }
  }
  let guardLog = '';
  try {
    guardLog = fs.readFileSync(GUARD_LOG, 'utf8');
  } catch {
    // none written
  }
  check('keychain guard log is empty', guardLog.trim() === '', guardLog);
}

try {
  await main();
} finally {
  for (const child of live) {
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  if (!KEEP) {
    fs.rmSync(BASE, { recursive: true, force: true });
    fs.rmSync(SOCK_DIR, { recursive: true, force: true });
  } else {
    console.log(`kept ${BASE}`);
  }
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
