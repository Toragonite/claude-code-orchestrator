// helpers2.mjs — fixtures and drivers for the v2.0.0 mesh harness (.orchestrator/mesh2).
//
// Everything here is isolation plumbing, in the pattern of .orchestrator/detach/helpers.mjs:
//   - a throwaway SANDBOX directory per fixture holding a fake HOME (so the server's data
//     root, `$HOME/.claude-code-orchestrator`, and the CLI's default config dir,
//     `$HOME/.claude`, both land in it), the worker account dirs, one workspace, the scenario
//     file that drives fake-claude2.mjs, and that fake's invocation log;
//   - a newline-delimited JSON-RPC client for `out/mcp/server.js`;
//   - a direct runner for the fake (the self-test uses it with no server at all);
//   - cleanup that kills every process the fake started and removes the sandbox;
//   - the keychain guard (../fixes/keychain-guard.cjs), loaded into this process on import and
//     preloaded, with AGENT_CLI_CREDENTIAL_STORE=memory, into everything a fixture environment
//     starts: no adapter reads a keychain or a real login file (the harness fails at exit if
//     anything tried).
//
// Nothing in this file reads or writes outside a sandbox it created, and nothing here ever
// runs the real `claude`.

import keychainGuard from '../fixes/keychain-guard.cjs';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MESH2_DIR = HERE;
// .orchestrator/mesh2 → the repo root is two levels up.
export const REPO_ROOT = path.resolve(HERE, '..', '..');
/** The compiled server under test. `MESH2_SERVER_JS` points the harness at another bundle. */
export const SERVER_JS = process.env.MESH2_SERVER_JS
  ? path.resolve(process.env.MESH2_SERVER_JS)
  : path.join(REPO_ROOT, 'out', 'mcp', 'server.js');
export const FAKE_CLAUDE2 = path.join(HERE, 'fake-claude2.mjs');
/**
 * The network guard of the providers harness, reused READ-ONLY (nothing under ../providers is
 * modified): preloaded into every process a fixture with vendor workers starts, it replaces
 * the global `fetch` with a stub and refuses every non-loopback socket.
 */
export const NET_GUARD = path.join(REPO_ROOT, '.orchestrator', 'providers', 'net-guard.cjs');
export const KEYCHAIN = keychainGuard.harness('mesh2');

/**
 * src/providers.ts, restated for the three vendors a fixture can register: the registry id,
 * the CLI's executable name, and the directory (under HOME) of the machine's ordinary login.
 */
export const VENDORS = {
  codex: { cli: 'codex', home: '.codex' },
  cursor: { cli: 'cursor-agent', home: '.cursor' },
  gemini: { cli: 'agy', home: '.agy' },
};
/** Every vendor CLI name — none of them may ever resolve to a real binary during a run. */
export const VENDOR_CLIS = Object.values(VENDORS).map((v) => v.cli);

/** Test-only overrides handed to the server (contract §9); production values are 45 s / 15 s. */
export const NO_TEST_OVERRIDES = process.env.MESH2_NO_TEST_OVERRIDES === '1';
export const TEST_PARK_GRACE_MS = Number(process.env.MESH2_PARK_GRACE_MS) || 600;
export const TEST_LIVENESS_TICK_MS = Number(process.env.MESH2_LIVENESS_TICK_MS) || 200;
export const PROD_PARK_GRACE_MS = 45_000;
export const PROD_LIVENESS_TICK_MS = 15_000;
/** Keep sandboxes on disk after a run (debugging). Processes are still killed. */
export const KEEP_SANDBOXES = process.env.MESH2_KEEP === '1';

/** src/platform.ts SESSION_IDENTITY_ENV, restated: the harness must not import build output. */
export const SESSION_IDENTITY_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
];
/** src/platform.ts constants the probes assert against, restated for the same reason. */
export const SESSION_WORKER_SETTINGS_JSON = '{"worktree":{"baseRef":"head"}}';
export const SESSION_WORKER_TOOLS = 'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep';
export const MIN_SESSION_WORKER_VERSION = '2.1.283';
export const MODEL_FORMS_HINT = 'an alias (opus, sonnet, fable, haiku) or a full model id such as claude-opus-5-5';
export const ONESHOT_MARKER = 'FAKE2_ONESHOT_OK';

/* ------------------------------------------------------------------------- *
 * Small utilities
 * ------------------------------------------------------------------------- */

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Poll a predicate (sync or async) until it returns something truthy, or throw on timeout.
 * `abort` is a function returning true when the caller no longer wants the answer — a probe
 * that already timed out must stop polling a sandbox that is being removed.
 */
export async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 40, label = 'condition', abort } = {}) {
  const start = Date.now();
  for (;;) {
    if (abort && abort()) {
      throw new Error(`aborted while waiting for ${label}`);
    }
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

export function rmrf(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return !fs.existsSync(dir);
    } catch {
      // a dying process is still writing into it — try again
    }
  }
  return !fs.existsSync(dir);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // torn last line — keep the rest
    }
  }
  return rows;
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * A recursive listing of `dir` — the directory itself included, under the key `.` — as
 * `relative path → one line`: the entry's type, and for a file its size, its mtime (ms) and
 * the hash of its bytes; for a directory its mtime; for a symlink its target. Nothing is
 * followed and nothing is skipped.
 *
 * The DIRECTORY mtimes are the part that is easy to leave out and that catches the most: a
 * file created and removed again (a lock, a tmp-then-rename) leaves no entry behind, and still
 * moves the mtime of the directory it happened in. atime is deliberately not recorded — a
 * read is not a change, and this is used to prove that nothing was CREATED OR MODIFIED.
 */
export function snapshotTree(dir) {
  const out = new Map();
  const walk = (abs, rel) => {
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      out.set(rel, `unreadable (${e.code ?? e.message})`);
      return;
    }
    if (st.isSymbolicLink()) {
      out.set(rel, `symlink → ${fs.readlinkSync(abs)}`);
      return;
    }
    if (st.isDirectory()) {
      out.set(rel, `dir mtime=${st.mtimeMs}`);
      for (const name of fs.readdirSync(abs).sort()) {
        walk(path.join(abs, name), rel === '.' ? name : `${rel}/${name}`);
      }
      return;
    }
    if (st.isFile()) {
      out.set(rel, `file size=${st.size} mtime=${st.mtimeMs} sha256=${sha256(abs).slice(0, 16)}`);
      return;
    }
    out.set(rel, `other mode=${st.mode.toString(8)}`);
  };
  walk(dir, '.');
  return out;
}

/** What differs between two snapshotTree results: one line per added, removed or changed entry. */
export function diffTrees(before, after) {
  const out = [];
  for (const [rel, line] of after) {
    if (!before.has(rel)) {
      out.push(`ADDED ${rel} (${line})`);
    } else if (before.get(rel) !== line) {
      out.push(`CHANGED ${rel}: ${before.get(rel)} → ${line}`);
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) {
      out.push(`REMOVED ${rel}`);
    }
  }
  return out;
}

/** POSIX single-quoting, for the two shell scripts a vendor fixture writes. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** One line, bounded — for quoting server text inside a PASS/FAIL line. */
export function clip(text, max = 220) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Fail loudly with a build hint if the server bundle is not there. */
export function assertServerBuilt() {
  if (!fs.existsSync(SERVER_JS)) {
    throw new Error(`Server bundle not found at ${SERVER_JS}. Run \`npm run compile\` from the repo root first (or set MESH2_SERVER_JS).`);
  }
}

/* ------------------------------------------------------------------------- *
 * Environment
 * ------------------------------------------------------------------------- */

/**
 * The harness's own environment with everything that could leak a REAL Claude Code session
 * into the run removed. This harness is routinely started from inside a Claude Code session,
 * whose identity variables (CLAUDECODE, CLAUDE_CODE_MESSAGING_TOKEN, …) and CLAUDE_CONFIG_DIR
 * would otherwise reach the server under test and blur exactly what M2/M3 measure.
 */
export function cleanBaseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC_|CCO_|FAKE_CLAUDE|MESH2_|GIT_)/.test(k)) {
      continue;
    }
    env[k] = v;
  }
  return env;
}

/* ------------------------------------------------------------------------- *
 * Process bookkeeping — nothing the fake starts may outlive a run
 * ------------------------------------------------------------------------- */

/** Every sandbox created in this process and not yet cleaned up. */
const ACTIVE = new Set();
/**
 * Every fake process a pid file or a job file told us about: pid → { root, startedAt }.
 * The extra fields are what make a pid safe to signal — see isOurFake.
 */
const SEEN_PIDS = new Map();
/** Every sandbox root this process ever created. */
const SEEN_ROOTS = new Set();
/** Job ids of every fixture this process created — how a late `stop <id>` / `rm <id>` is recognized. */
const SEEN_JOB_IDS = new Set();

/** `ps` in the C locale, so `lstart` parses the same on every machine. */
function ps(args) {
  const res = spawnSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  return res.status === 0 ? String(res.stdout) : '';
}

/** Start time and command line of a live process, or undefined. */
function processInfo(pid) {
  const line = ps(['-o', 'lstart=,command=', '-p', String(pid)]).trim();
  const m = /^(\w{3} +\w{3} +\d{1,2} +\d\d:\d\d:\d\d +\d{4}) +(.*)$/.exec(line);
  if (!m) {
    return undefined;
  }
  const startedAt = Date.parse(m[1]);
  return { startedAt: Number.isNaN(startedAt) ? undefined : startedAt, command: m[2] };
}

/**
 * Is `pid` — as recorded with `meta` — STILL the fake process we recorded?
 *
 * A bare "is this pid alive and running fake-claude2.mjs" is not enough to signal it: pids
 * are recycled quickly on a busy machine, and with several probes running at once a stale pid
 * can come back as ANOTHER sandbox's live worker. So the process must also either carry this
 * sandbox's root on its command line (every worker helper and every `--bg` launcher does) or
 * have started at the moment the record says it did.
 */
function isOurFake(pid, meta) {
  if (!isPidAlive(pid)) {
    return false;
  }
  const info = processInfo(pid);
  if (!info || !info.command.includes('fake-claude2.mjs')) {
    return false;
  }
  if (meta.root && info.command.includes(meta.root)) {
    return true;
  }
  // `lstart` has one-second resolution; the pid file is written within the first moments.
  return info.startedAt !== undefined && Number.isFinite(meta.startedAt) && Math.abs(info.startedAt - meta.startedAt) <= 5000;
}

/** The fake processes one fixture knows about, each with what identifies it. */
function fakePidsOf(fx) {
  const found = new Map();
  let names = [];
  try {
    names = fs.readdirSync(fx.pidDir);
  } catch {
    // no fake process has registered yet (or the sandbox is already gone)
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) {
      continue;
    }
    const rec = readJson(path.join(fx.pidDir, name));
    found.set(pid, { root: fx.root, startedAt: rec && Number.isFinite(rec.startedAt) ? rec.startedAt : undefined });
  }
  for (const job of fx.jobs({ includeRemoved: true })) {
    if (Number.isInteger(job.pid)) {
      found.set(job.pid, { root: fx.root, startedAt: job.startedAt });
    }
    SEEN_JOB_IDS.add(job.jobId);
  }
  for (const [pid, meta] of found) {
    SEEN_PIDS.set(pid, meta);
  }
  return found;
}

/** Every running process whose command line names fake-claude2.mjs. */
function psFake() {
  const out = [];
  for (const line of ps(['-axo', 'pid=,command=']).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes('fake-claude2.mjs')) {
      out.push({ pid: Number(m[1]), command: m[2] });
    }
  }
  return out;
}

/** The job id of a `fake-claude2.mjs stop <id>` / `rm <id>` command line, or undefined. */
function stopOrRmTarget(command) {
  const m = /fake-claude2\.mjs (?:stop|rm) ([0-9a-f]{8})\b/.exec(command);
  return m ? m[1] : undefined;
}

/**
 * SIGKILL every live fake process of a fixture. Returns how many were killed.
 *
 * Three sources, because no single one sees everything: the pid files the fake writes, the
 * helper pids in its job files, and the process table — a `claude stop <id>` / `claude rm <id>`
 * the server fires at session end is DETACHED, outlives the server, and may not have written
 * its pid file yet when we look. The loop ends only after a quiet window with nothing to
 * kill; with a server involved that window is long enough to cover a fake's startup.
 */
export async function killFakeProcesses(fx, { quietMs = 80 } = {}) {
  let killed = 0;
  const jobIds = new Set();
  const deadline = Date.now() + 8000;
  let quietSince = Date.now();
  while (Date.now() < deadline && Date.now() - quietSince <= quietMs) {
    const targets = new Set();
    for (const [pid, meta] of fakePidsOf(fx)) {
      if (isOurFake(pid, meta)) {
        targets.add(pid);
      }
    }
    for (const job of fx.jobs({ includeRemoved: true })) {
      jobIds.add(job.jobId);
    }
    for (const p of psFake()) {
      const target = stopOrRmTarget(p.command);
      if (p.command.includes(fx.root) || (target !== undefined && jobIds.has(target))) {
        targets.add(p.pid);
      }
    }
    for (const pid of targets) {
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch {
        // raced its own exit
      }
    }
    if (targets.size > 0) {
      quietSince = Date.now();
    }
    await sleep(40);
  }
  return killed;
}

/** Fake processes that are STILL alive after cleanup — the harness's own leak check. */
export function strayFakeProcesses() {
  const strays = new Map();
  for (const [pid, meta] of SEEN_PIDS) {
    if (isOurFake(pid, meta)) {
      strays.set(pid, { pid, command: processInfo(pid)?.command ?? '' });
    }
  }
  for (const p of psFake()) {
    const target = stopOrRmTarget(p.command);
    if ([...SEEN_ROOTS].some((root) => p.command.includes(root)) || (target !== undefined && SEEN_JOB_IDS.has(target))) {
      strays.set(p.pid, p);
    }
  }
  return [...strays.values()];
}

/**
 * End-of-run sweep. A `claude stop` the server fired while shutting down is detached and can
 * still be on its way out (or only now starting, on a loaded machine) when the last probe's
 * cleanup has finished. Such a process is harmless — the sandbox is gone and the fake cannot
 * re-create it — but nothing may be left running, so it is killed here. Returns how many late
 * processes had to be killed, and any that SURVIVED (the real leak signal).
 */
export async function settleStrays({ timeoutMs = 5000 } = {}) {
  let lateKilled = 0;
  let quiet = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const strays = strayFakeProcesses();
    if (strays.length === 0) {
      quiet++;
      if (quiet >= 3) {
        return { lateKilled, remaining: [] };
      }
    } else {
      quiet = 0;
      for (const s of strays) {
        try {
          process.kill(s.pid, 'SIGKILL');
          lateKilled++;
        } catch {
          // exited by itself between the scan and the signal
        }
      }
    }
    if (Date.now() > deadline) {
      return { lateKilled, remaining: strayFakeProcesses() };
    }
    await sleep(120);
  }
}

/** Sandbox roots created by this process that still exist on disk (after one more removal attempt). */
export function leftoverSandboxes() {
  if (KEEP_SANDBOXES) {
    return [];
  }
  return [...SEEN_ROOTS].filter((root) => fs.existsSync(root) && !rmrf(root));
}

/** Clean up every fixture still open — the signal / crash path. */
export async function cleanupAll() {
  for (const fx of [...ACTIVE]) {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

/**
 * The only variables of the calling shell that reach a fixture with vendor workers. This
 * harness is normally run from a Claude Code session on a machine where the real vendor CLIs
 * are installed and logged in: its PATH, a CODEX_HOME / AGY_HOME / OPENAI_API_KEY /
 * CURSOR_API_KEY it may export and its proxy settings must not leak into such a run.
 */
function allowListEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && (['TMPDIR', 'LANG', 'USER', 'LOGNAME', 'TERM', 'TZ'].includes(k) || /^LC_/.test(k))) {
      env[k] = v;
    }
  }
  return env;
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

/**
 * A stand-in for one vendor CLI that DOES NOTHING: it appends its name and argv to the log
 * and exits 97. Its only job is to be what the name resolves to, so that a lookup can never
 * fall through to a real installation — and to leave evidence if anything ever started it.
 */
function writeVendorStub(file, cli, logFile) {
  fs.writeFileSync(
    file,
    ['#!/bin/sh', `# mesh2 harness stub for the vendor CLI "${cli}": logs the call and refuses.`, `printf '%s\\n' ${shq(cli)}" $*" >> ${shq(logFile)} 2>/dev/null`, 'exit 97', ''].join('\n'),
    { mode: 0o755 },
  );
}

/**
 * The sandbox "login shell". The server resolves a bare CLI name with
 * `$SHELL -lc "command -v <name>"`; a real login shell would run /etc/profile (on macOS
 * path_helper puts /usr/local/bin first) and the user's profile. This one reads no profile at
 * all, searches the sandbox PATH only, and logs what it was asked.
 */
function writeLoginShell(file, sandboxPath, logFile) {
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      '# Sandbox "login shell" of the mesh2 harness (vendor fixtures): no profile, sandbox PATH only.',
      `PATH=${shq(sandboxPath)}`,
      'export PATH',
      `printf '%s\\n' "$*" >> ${shq(logFile)} 2>/dev/null`,
      'case "$1" in',
      '  -*c*) shift; exec /bin/sh -c "$@" ;;',
      'esac',
      'exec /bin/sh "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** What `command -v` prints for each name, through one invocation of `shell`. */
function resolveThroughShell(shell, names, env, flag = '-lc') {
  const script = names.map((n) => `printf '%s=' ${n}; command -v ${n} || true; echo`).join('; ');
  const res = spawnSync(shell, [flag, script], { encoding: 'utf8', timeout: 15_000, env: { ...env, SHELL: shell }, stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.error || res.status !== 0) {
    return { __error: res.error ? res.error.message : `exit ${res.status}` };
  }
  const found = {};
  for (const line of String(res.stdout).split('\n')) {
    const m = /^([A-Za-z0-9._-]+)=(.*)$/.exec(line.trim());
    if (m && names.includes(m[1]) && m[2] !== '') {
      found[m[1]] = m[2];
    }
  }
  return found;
}

/**
 * Put files of the vendor's OWN into a vendor home, so it looks like one that has been used.
 * Every home gets a `sessions/` directory with files in it: for these CLIs that is a history
 * of their own conversations, and for a Claude config dir the same name is the session
 * registry — which is exactly the collision this fixture exists to make observable.
 *
 * NO credential file is written (no `auth.json`, no token): nothing in a run can find one to
 * send anywhere.
 */
function seedVendorHome(provider, dir) {
  const write = (rel, content) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const turn = (role, text) => JSON.stringify({ timestamp: '2026-10-12T09:00:00.000Z', type: 'response_item', payload: { role, content: [{ type: 'text', text }] } });
  if (provider === 'codex') {
    write('config.toml', 'model = "gpt-5.2-codex"\napproval_policy = "never"\n');
    write('history.jsonl', `${JSON.stringify({ session_id: '0199c0de-0000-7000-8000-000000000001', ts: 1760000000, text: 'vendor fixture history' })}\n`);
    write('sessions/2026/10/12/rollout-2026-10-12T09-00-00-0199c0de-0000-7000-8000-000000000001.jsonl', `${turn('user', 'hello')}\n${turn('assistant', 'a Codex conversation, not a Claude session entry')}\n`);
    write('sessions/index.json', JSON.stringify({ note: 'a JSON file of the vendor in its own sessions/ directory', sessions: 1 }));
    write('version.json', JSON.stringify({ latest_version: '0.145.0' }));
  } else if (provider === 'cursor') {
    write('cli-config.json', JSON.stringify({ version: 1, model: { modelId: 'auto' } }, null, 2));
    write('sessions/0199c0de-0000-7000-8000-00000000c0de.json', JSON.stringify({ id: '0199c0de-0000-7000-8000-00000000c0de', title: 'a Cursor chat, not a Claude session entry' }));
    write('projects/Users-fixture-ws/agent-transcripts/0199c0de-0000-7000-8000-00000000c0de.jsonl', `${turn('user', 'hello')}\n`);
  } else {
    write('settings.json', JSON.stringify({ theme: 'dark' }));
    write('sessions/readme.txt', 'vendor fixture\n');
  }
  // Old mtimes everywhere, so that even a byte-identical rewrite of any of it is visible.
  const old = new Date(Date.now() - 3 * 3_600_000);
  const age = (abs) => {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        age(path.join(abs, name));
      }
    }
    fs.utimesSync(abs, old, old);
  };
  age(dir);
}

function runGit(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanBaseEnv(), timeout: 20_000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(res.stderr || res.stdout).trim()}`);
  }
  return String(res.stdout).trim();
}

/** A real repository with one commit — a session worker only gets a worktree (`-w`) in one. */
function makeGitWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q']);
  runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# mesh2 fixture workspace\n');
  runGit(dir, ['add', '-A']);
  // `-c` identity: this machine has no global git identity, and the fixture must not need one.
  runGit(dir, [
    '-c',
    'user.name=mesh2 fixture',
    '-c',
    'user.email=mesh2@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    'fixture: initial commit',
  ]);
}

/**
 * Build one sandbox.
 *
 * opts:
 *   label            — goes into the directory name (probe id)
 *   workspace        — 'git' (default: a repo with one commit) | 'plain' (an ordinary directory)
 *   workers          — [{ name, model?, configDir? }]; `configDir: 'default'` puts the worker
 *                      in `$HOME/.claude`, the CLI's built-in directory (M3). Default: wa, wb.
 *   registry         — fields merged over the registry defaults (permissionMode, meshMode, …)
 *   scenario         — the initial scenario object for fake-claude2
 *   meshDir          — false leaves `<data root>/mesh` ABSENT (a machine that never ran mesh
 *                      mode). Default true: the directory exists, as it does on every machine
 *                      that has, so each probe measures its own row and not first-run setup.
 *   hostSessions     — false leaves `$HOME/.claude/sessions` ABSENT. Default true: the HOST
 *                      account has a session registry, as it does whenever a Claude Code
 *                      session is the client of this server (that session's own entry lives
 *                      there). It is where the bridge mirrors a worker of another account so
 *                      the orchestrator's SendMessage can address it; without the directory
 *                      no mirror can be written and the worker stays "not visible yet".
 *   vendors          — [{ name, provider: 'codex' | 'cursor' | 'gemini', configDir?, model? }]:
 *                      worker accounts on ANOTHER vendor's CLI, registered alongside `workers`.
 *                      Each gets that vendor's home under HOME (`.codex`, `.cursor`, `.agy`)
 *                      seeded with files of the vendor's own. A fixture with vendors runs
 *                      HERMETICALLY for those CLIs — see "Vendor workers" below.
 *   registryOrder    — worker names, in the order registry.json should list them (the rest
 *                      follow). Default: `workers`, then `vendors`.
 *
 * Vendor workers. This harness must never start a real `codex`, `cursor-agent` or `agy`, and
 * the machine it runs on usually has them installed and logged in. So a fixture with vendors
 * (and only such a fixture — the others register no vendor account, so nothing ever looks for
 * one) gets, in the pattern of ../providers/helpers.mjs:
 *   - `bin/` with STUBS named after the three CLIs, which log their argv to `vendor-cli.log`
 *     and exit 97 without touching anything, plus a `node` symlink for the fake's shebang;
 *   - a sandbox "login shell" that reads no profile and searches the sandbox PATH only (the
 *     server resolves a bare CLI name with `$SHELL -lc "command -v <name>"`), logging every
 *     lookup to `login-shell.log`;
 *   - an environment built from an allow-list, with `PATH=<sandbox>/bin:/usr/bin:/bin:…` and
 *     `SHELL` = that script, and the providers harness's network guard preloaded;
 *   - `assertHermetic()`, run before every server start: each of the three names must resolve
 *     to its stub, or the fixture refuses to start anything.
 */
export function makeFixture(opts = {}) {
  const label = String(opts.label ?? 'fx').replace(/[^A-Za-z0-9]/g, '');
  // realpath: on macOS os.tmpdir() is a symlink, while a child's process.cwd() and the
  // server's workspace hash see the resolved path. One canonical spelling everywhere.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cco-mesh2-${label}-`)));
  SEEN_ROOTS.add(root);
  const home = path.join(root, 'home');
  const orchRoot = path.join(home, '.claude-code-orchestrator');
  const defaultConfigDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(orchRoot, 'tasks'), { recursive: true });
  if (opts.meshDir !== false) {
    fs.mkdirSync(path.join(orchRoot, 'mesh'), { recursive: true });
  }
  fs.mkdirSync(defaultConfigDir, { recursive: true });
  const hostSessionsDir = path.join(defaultConfigDir, 'sessions');
  if (opts.hostSessions !== false) {
    fs.mkdirSync(hostSessionsDir, { recursive: true });
  }

  const workers = (opts.workers ?? [{ name: 'wa' }, { name: 'wb' }]).map((w) => {
    const configDir = w.configDir === 'default' ? defaultConfigDir : (w.configDir ?? path.join(home, 'accounts', w.name));
    fs.mkdirSync(configDir, { recursive: true });
    return { name: w.name, configDir, model: w.model ?? 'opus' };
  });

  // Worker accounts on another vendor's CLI. `configDir` is THAT vendor's home, and it is
  // seeded with files of the vendor's own — including, for every one of them, a `sessions/`
  // directory, which is the name a Claude config dir uses for something else entirely.
  const vendors = (opts.vendors ?? []).map((v) => {
    const info = VENDORS[v.provider];
    if (!info) {
      throw new Error(`makeFixture: unknown vendor provider ${JSON.stringify(v.provider)} (known: ${Object.keys(VENDORS).join(', ')})`);
    }
    const configDir = v.configDir ?? path.join(home, info.home);
    seedVendorHome(v.provider, configDir);
    return { name: v.name, configDir, model: v.model ?? '', provider: v.provider };
  });
  const hermetic = vendors.length > 0;
  const binDir = path.join(root, 'bin');
  const sandboxPath = [binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const loginShell = path.join(root, 'login-shell');
  const loginShellLogFile = path.join(root, 'login-shell.log');
  const vendorCliLogFile = path.join(root, 'vendor-cli.log');
  const netFile = path.join(root, 'net.json');
  const netLogFile = path.join(root, 'net.log.jsonl');
  if (hermetic) {
    if (!fs.existsSync(NET_GUARD)) {
      throw new Error(`makeFixture: the network guard ${NET_GUARD} is missing; a fixture with vendor workers refuses to run without it.`);
    }
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    for (const cli of VENDOR_CLIS) {
      writeVendorStub(path.join(binDir, cli), cli, vendorCliLogFile);
    }
    writeLoginShell(loginShell, sandboxPath, loginShellLogFile);
    fs.writeFileSync(netFile, JSON.stringify({ logFile: netLogFile, fetch: { mode: 'deny' } }, null, 2));
  }

  const byName = new Map([...workers, ...vendors].map((w) => [w.name, w]));
  const ordered = [];
  for (const name of [...(opts.registryOrder ?? []), ...byName.keys()]) {
    const w = byName.get(name);
    if (w && !ordered.includes(w)) {
      ordered.push(w);
    }
  }

  // registry.ts requires the execute bit on claudePath.
  fs.chmodSync(FAKE_CLAUDE2, 0o755);
  const registry = {
    workers: ordered,
    permissionMode: 'acceptEdits',
    claudePath: FAKE_CLAUDE2,
    cooldownMinutes: 30,
    workerTimeoutMinutes: 5,
    frontierWorkerDispatch: 'block',
    overageWorkerDispatch: 'block',
    meshMode: 'on',
    meshMaxLiveWorkers: 8,
    meshHistoryLimit: 50,
    ...(opts.registry ?? {}),
  };
  fs.writeFileSync(path.join(orchRoot, 'registry.json'), JSON.stringify(registry, null, 2));

  // A fresh, healthy usage reading for every worker: selection neither refuses nor has to
  // run a live auth re-check before the first dispatch.
  const now = Date.now();
  const future = new Date(now + 6 * 3_600_000).toISOString();
  const usage = {};
  for (const w of workers) {
    usage[w.configDir] = {
      name: w.name,
      configDir: w.configDir,
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
    };
  }
  // A vendor account's reading, in the shape the server files one under (the same cache, keyed
  // by the same directory): logged in, with usage windows — i.e. an account that LOOKS as
  // healthy as a Claude one to anything that trusts a cache entry without asking whose it is.
  for (const v of vendors) {
    usage[v.configDir] = {
      name: v.name,
      configDir: v.configDir,
      available: true,
      subscriptionType: 'chatgpt',
      windows: [{ kind: 'session', label: 'Session (5hr)', percent: 7, severity: 'normal', resetsAt: future }],
      sessionCostUsd: 0,
      extraUsage: { enabled: false, percent: null, spendLabel: null },
      auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now },
      fetchedAt: now,
      windowsFetchedAt: now,
      windowsStale: false,
      lastGoodWindowsAt: now,
    };
  }
  fs.writeFileSync(path.join(orchRoot, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(orchRoot, 'stats.json'), JSON.stringify({}, null, 2));

  const workspaceKind = opts.workspace ?? 'git';
  const workspace = path.join(root, workspaceKind === 'git' ? 'ws-git' : 'ws-plain');
  if (workspaceKind === 'git') {
    makeGitWorkspace(workspace);
  } else {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# mesh2 fixture workspace (not a repository)\n');
  }

  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake2.log.jsonl');
  const pidDir = path.join(root, 'pids');
  fs.mkdirSync(pidDir, { recursive: true });

  const servers = [];
  /** Sacrificial processes started by spawnBait — killed in cleanup through their handles. */
  const baits = [];
  let cleaned = false;

  const fx = {
    label,
    root,
    home,
    orchRoot,
    defaultConfigDir,
    /** `$HOME/.claude/sessions` — the host account's session registry (the bridge's mirror target). */
    hostSessionsDir,
    workspace,
    workspaceKind,
    /** The CLAUDE CODE worker accounts. Vendor accounts are `vendors`, never in this list. */
    workers,
    /** Worker accounts on another vendor's CLI: [{ name, configDir, model, provider }]. */
    vendors,
    registry,
    scenarioFile,
    logFile,
    pidDir,
    aborted: false,
    /** Servers started in this sandbox (for failure diagnostics). */
    servers,

    /** Replace the scenario fake-claude2 reads on its next invocation. */
    setScenario(scenario = {}) {
      writeJsonAtomic(scenarioFile, { ...scenario, sandboxRoot: root, logFile, pidDir });
    },

    /** The account a config dir belongs to (registry worker name), or undefined. */
    accountOf(configDir) {
      return workers.find((w) => w.configDir === configDir)?.name;
    },

    /** Environment for a server (or a direct fake run) inside this sandbox. `null` deletes. */
    env(extra = {}) {
      const env = hermetic
        ? {
            // Vendor accounts are registered: nothing of the caller's PATH, SHELL, vendor
            // homes, API keys or proxies may reach the run (see makeFixture's header).
            ...allowListEnv(),
            HOME: home,
            PATH: sandboxPath,
            SHELL: loginShell,
            FAKE_CLAUDE2_SCENARIO: scenarioFile,
            CCO_PROVIDERS_NET: netFile,
            NODE_OPTIONS: `--require ${JSON.stringify(NET_GUARD)}`,
          }
        : { ...cleanBaseEnv(), HOME: home, FAKE_CLAUDE2_SCENARIO: scenarioFile };
      // cleanBaseEnv drops every CCO_ variable, the guard log's name among them
      Object.assign(env, KEYCHAIN.env(env));
      if (!NO_TEST_OVERRIDES) {
        env.CCO_TEST_PARK_GRACE_MS = String(TEST_PARK_GRACE_MS);
        env.CCO_TEST_LIVENESS_TICK_MS = String(TEST_LIVENESS_TICK_MS);
      }
      for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === undefined) {
          delete env[k];
        } else {
          env[k] = String(v);
        }
      }
      return env;
    },

    /** Start the compiled server in this sandbox's workspace and complete `initialize`. */
    async startServer({ env = {}, initialize = true, protocolVersion = '2025-11-25' } = {}) {
      fx.assertHermetic();
      const srv = startServer(fx.env(env), workspace);
      servers.push(srv);
      if (initialize) {
        await srv.initialize(protocolVersion);
      }
      return srv;
    },

    /**
     * Refuse to start anything unless every vendor CLI name resolves to this sandbox's stub —
     * through the sandbox login shell (the lookup the server performs) and through a plain
     * PATH walk. A no-op for a fixture without vendor workers: it registers no vendor account,
     * so the server under test never looks for one of those CLIs.
     */
    assertHermetic() {
      if (!hermetic) {
        return;
      }
      for (const [how, found] of [
        ['the sandbox login shell', resolveThroughShell(loginShell, VENDOR_CLIS, fx.env())],
        ['/bin/sh with the sandbox PATH', resolveThroughShell('/bin/sh', VENDOR_CLIS, fx.env(), '-c')],
      ]) {
        const wrong = VENDOR_CLIS.filter((cli) => found[cli] !== path.join(binDir, cli));
        if (found.__error || wrong.length > 0) {
          throw new Error(
            `REFUSED TO RUN — through ${how}, ${found.__error ? `the lookup failed (${found.__error})` : wrong.map((cli) => `${cli} resolves to ${JSON.stringify(found[cli] ?? 'nothing')}`).join(', ')}; ` +
              `every vendor CLI must resolve to its stub in ${binDir}, so that no real codex / cursor-agent / agy can ever be started.`,
          );
        }
      }
    },
    /** Every invocation of a vendor-CLI stub: `<cli> <argv…>` lines. Expected to stay empty. */
    vendorCliLog() {
      return readLines(vendorCliLogFile);
    },
    /** Every command the sandbox login shell was asked to run (the server's CLI lookups). */
    loginShellLog() {
      return readLines(loginShellLogFile);
    },
    /** Every `fetch` the network guard stubbed and every connection it refused. */
    netLog() {
      return readJsonl(netLogFile);
    },
    /**
     * Start a sacrificial process that does nothing for ten minutes, and return its pid. A
     * planted session entry needs a LIVE pid to be bait at all — and that pid must never be the
     * harness's own, because the code under test may SIGKILL the pid of an entry it takes for
     * one of its workers. Killed in cleanup; `baitAlive(pid)` says whether it survived.
     *
     * `{ asCli: true }` starts one whose command line NAMES THE CLI (`…/bait/claude`): a process
     * that a command-line check alone takes for a Claude Code session.
     */
    spawnBait({ asCli = false } = {}) {
      let child;
      if (asCli) {
        // A decoy that PASSES the "is this the CLI?" test: the fake itself, started through a
        // symbolic link named `claude`, so that its command line is `node …/bait/claude __bait`.
        // It is nobody's worker — it has no job, no session entry of its own, and does nothing.
        const link = path.join(root, 'bait', 'claude');
        if (!fs.existsSync(link)) {
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.symlinkSync(FAKE_CLAUDE2, link);
        }
        child = spawn(process.execPath, [link, '__bait'], { stdio: 'ignore', env: fx.env() });
      } else {
        child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', env: fx.env() });
      }
      const bait = { pid: child.pid, exited: false };
      child.on('exit', () => {
        bait.exited = true;
      });
      child.on('error', () => {
        bait.exited = true;
      });
      baits.push({ child, bait });
      return child.pid;
    },
    baitAlive(pid) {
      const hit = baits.find((b) => b.bait.pid === pid);
      return hit !== undefined && !hit.bait.exited && isPidAlive(pid);
    },

    /** Every fake invocation so far, each with its exit code merged in when it has exited. */
    log() {
      const rows = readJsonl(logFile);
      const exits = new Map();
      for (const r of rows) {
        if (r.kind === 'exit') {
          exits.set(r.inv, r);
        }
      }
      return rows
        .filter((r) => r.kind !== 'exit')
        .map((r) => {
          const exit = r.inv === undefined ? undefined : exits.get(r.inv);
          return exit ? { ...r, exitCode: exit.code, exit } : r;
        });
    },
    invocations(kind) {
      return fx.log().filter((r) => r.kind === kind);
    },
    bgSpawns() {
      return fx.invocations('bg');
    },
    /** Invocations the fake did not understand, or that it refused for leaving the sandbox. */
    anomalies() {
      return fx.log().filter((r) => ['unsupported', 'sandbox-violation', 'fake-error'].includes(r.kind));
    },

    /** The fake's own job records (one per `--bg` that started a helper), across accounts. */
    jobs({ includeRemoved = false } = {}) {
      const out = [];
      const dirs = new Set([defaultConfigDir, ...workers.map((w) => w.configDir)]);
      for (const dir of dirs) {
        for (const sub of includeRemoved ? ['jobs', 'removed'] : ['jobs']) {
          const jobsDir = path.join(dir, 'fake-claude2', sub);
          let names = [];
          try {
            names = fs.readdirSync(jobsDir);
          } catch {
            continue;
          }
          for (const n of names) {
            if (!/^[0-9a-f]{8}\.json$/.test(n)) {
              continue;
            }
            const job = readJson(path.join(jobsDir, n));
            if (job && typeof job === 'object') {
              out.push({ ...job, file: path.join(jobsDir, n), removed: sub === 'removed' });
            }
          }
        }
      }
      return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    },
    job(jobId) {
      return fx.jobs({ includeRemoved: true }).find((j) => j.jobId === jobId);
    },
    /** Tell a LIVE fake worker to act out another scenario (see the fake's control channel). */
    command(jobId, cmd) {
      const job = fx.job(jobId);
      if (!job) {
        throw new Error(`no fake job ${jobId} to command`);
      }
      writeJsonAtomic(`${job.file}.cmd`, typeof cmd === 'string' ? { kind: cmd } : cmd);
    },
    /** The session-registry entry a fake worker wrote, or undefined. */
    sessionEntry(job) {
      return readJson(path.join(job.configDir, 'sessions', `${job.pid}.json`));
    },

    /** The task event log (`tasks.jsonl`). */
    events() {
      return readJsonl(path.join(orchRoot, 'tasks.jsonl'));
    },
    eventsFor(title) {
      return fx.events().filter((e) => e.title === title);
    },
    stats() {
      return readJson(path.join(orchRoot, 'stats.json')) ?? {};
    },

    /** Every workspace ledger under `mesh/` (there is one per workspace hash). */
    ledgers() {
      const dir = path.join(orchRoot, 'mesh');
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const out = [];
      for (const n of names) {
        if (!/^[0-9a-f]+\.json$/.test(n)) {
          continue;
        }
        const state = readJson(path.join(dir, n));
        if (state && typeof state === 'object') {
          out.push({ file: path.join(dir, n), state });
        }
      }
      return out;
    },
    ledgerRecord(jobId) {
      for (const { state } of fx.ledgers()) {
        const rec = Array.isArray(state.workers) ? state.workers.find((w) => w && w.jobId === jobId) : undefined;
        if (rec) {
          return rec;
        }
      }
      return undefined;
    },

    /** Stop servers, kill everything the fake started, remove the sandbox. Idempotent. */
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      fx.aborted = true;
      for (const srv of servers) {
        await srv.stop();
      }
      for (const { child } of baits) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      // With a server involved, detached `claude stop` / `claude rm` children may still be
      // starting after it has exited: wait for a quiet window longer than a fake's startup.
      await killFakeProcesses(fx, { quietMs: servers.length > 0 ? 400 : 80 });
      if (!KEEP_SANDBOXES && !rmrf(root)) {
        await sleep(250);
        await killFakeProcesses(fx, { quietMs: 200 });
        rmrf(root);
      }
      ACTIVE.delete(fx);
    },
  };

  fx.setScenario(opts.scenario ?? {});
  ACTIVE.add(fx);
  return fx;
}

/* ------------------------------------------------------------------------- *
 * Server driver — newline-delimited JSON-RPC over stdio
 * ------------------------------------------------------------------------- */

export function startServer(env, cwd) {
  const child = spawn(process.execPath, [SERVER_JS], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  const waiters = new Map();
  let outBuf = '';
  let stderr = '';
  let nextId = 100;
  let exited = false;
  let exitInfo = null;

  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    for (const [id, w] of waiters) {
      waiters.delete(id);
      w.reject(new Error(`server exited (code ${code}, signal ${signal}) before answering request ${id}; stderr tail: ${clip(stderr.slice(-600), 600)}`));
    }
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    outBuf += d;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      if (!line.trim()) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        responses.set(msg.id, msg);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w.resolve(msg);
        }
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 200_000) {
      stderr = stderr.slice(-100_000);
    }
  });

  const srv = {
    child,
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    get exitInfo() {
      return exitInfo;
    },
    send(msg) {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n');
      } catch {
        // the server is gone — the waiter for this id is rejected by the exit handler
      }
    },
    waitResponse(id, timeoutMs = 20_000) {
      if (responses.has(id)) {
        return Promise.resolve(responses.get(id));
      }
      if (exited) {
        return Promise.reject(new Error(`server already exited (code ${exitInfo?.code}); stderr tail: ${clip(stderr.slice(-600), 600)}`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiters.has(id)) {
            waiters.delete(id);
            reject(new Error(`no JSON-RPC response to request ${id} within ${timeoutMs} ms`));
          }
        }, timeoutMs);
        waiters.set(id, {
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    /** Send a request and wait for its response message (result or error). */
    request(method, params, timeoutMs = 20_000) {
      const id = nextId++;
      srv.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return srv.waitResponse(id, timeoutMs);
    },
    /** `protocolVersion: null` sends an `initialize` with NO protocolVersion at all. */
    async initialize(protocolVersion = '2025-11-25') {
      const params = { capabilities: {}, clientInfo: { name: 'mesh2-probe', version: '0' } };
      if (protocolVersion !== null) {
        params.protocolVersion = protocolVersion;
      }
      const resp = await srv.request('initialize', params, 15_000);
      srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return resp;
    },
    /**
     * `tools/call`. Resolves `{ text, isError, rpcError, elapsedMs, raw }` — a tool-level
     * failure (isError) and a protocol-level one (rpcError) are both ANSWERS, not throws.
     */
    async callTool(name, args = {}, timeoutMs = 30_000) {
      const started = Date.now();
      const resp = await srv.request('tools/call', { name, arguments: args }, timeoutMs);
      const elapsedMs = Date.now() - started;
      if (resp.error) {
        return { text: String(resp.error.message ?? ''), isError: true, rpcError: resp.error, elapsedMs, answeredAt: Date.now(), raw: resp };
      }
      const text = Array.isArray(resp.result?.content) ? resp.result.content.map((c) => c?.text ?? '').join('\n') : '';
      return { text, isError: resp.result?.isError === true, elapsedMs, answeredAt: Date.now(), raw: resp };
    },
    closeStdin() {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    },
    waitExit(timeoutMs = 12_000) {
      if (exited) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        child.once('exit', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    },
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
    /** Graceful end (stdin EOF = "the client is gone"), SIGKILL as the backstop. */
    async stop(timeoutMs = 12_000) {
      if (exited) {
        return true;
      }
      srv.closeStdin();
      const clean = await srv.waitExit(timeoutMs);
      if (!clean) {
        srv.kill();
        await srv.waitExit(3000);
      }
      return clean;
    },
  };
  return srv;
}

/* ------------------------------------------------------------------------- *
 * Direct fake runner (self-test) and the §4.6 bootstrap prompt
 * ------------------------------------------------------------------------- */

/** Run fake-claude2 once. Settles on 'exit' (+ a short drain), never on 'close' (P16). */
export function runFake(args, { env, cwd, input, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(FAKE_CLAUDE2, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout, stderr, pid: child.pid, ...result });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      done({ code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => done({ code: null, signal: null, spawnError: e.message }));
    child.on('exit', (code, signal) => setTimeout(() => done({ code, signal }), 80));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    if (input !== undefined || !args.includes('stream-json')) {
      child.stdin.end();
    }
  });
}

/** A long-lived fake child the caller drives by hand (the usage-probe self-test). */
export function spawnFake(args, { env, cwd } = {}) {
  return spawn(FAKE_CLAUDE2, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** What the bootstrap prompt's JSON template shows where the token goes — a stand-in, never a token. */
export const TOKEN_TEMPLATE_STAND_IN = '<the value from the first line of your task file>';
/** What its picture of the task file's first line shows there. */
export const TOKEN_SHAPE_STAND_IN = 'TOKEN';

/**
 * The first two lines of a task file as the server writes them: the token line, then the
 * comment that says what it is (src/mesh/contract.ts bgDispatchTaskFile).
 */
export function taskFileHead(token) {
  return (
    `<!-- cco-io-token: ${token} -->\n` +
    `<!-- The line above (line 1 of this file) carries this dispatch's result token; it is not part of your task. When the task is over, copy the ${token.length} characters after the label on that line - digits 0-9 and letters a-f, without the label and without the comment markers - into the "token" member of the result JSON you write. Do not put the token anywhere else. -->\n`
  );
}

/**
 * The worker bootstrap prompt of contract §4.6 (as amended by contract-2.0-fixes §4.1), with the
 * interpolations filled in. Rules 3–6 are shortened (they carry nothing the fake reads); the
 * first sentence, the task-file sentence and rule 1 — which name the task id, the task file and
 * the result file, and say where the token is — are verbatim.
 *
 * It takes NO token: the prompt is a command-line argument and never carries one. The token is
 * on the first line of the task file, which is where the fake (like a real worker) reads it.
 */
export function bootstrapPrompt({ workerName, taskId, taskFile, resultFile, worktree, maxBytes = 262_144, tokenChars = 32 }) {
  const inWorktree = typeof worktree === 'string' && worktree !== '';
  const lines = [
    `You are ${workerName}, a background worker executing ONE dispatch task (task id ${taskId}) for an orchestrator session.`,
    '',
    ...(inWorktree ? [`Your working directory is this task's isolated git worktree (${worktree}); it IS your checkout for this task.`, ''] : []),
    `Read the file \`${taskFile}\` (an absolute path, outside ${inWorktree ? 'your worktree' : 'your working directory'} — you have been granted access to that one directory, which belongs to this task alone) NOW — it is your complete task: engineering principles, task system prompt, and the task itself, all binding. If the file is large, read it in slices using Read's \`offset\` and \`limit\` until you have all of it — never skip the head. Line 1 of the file is not task text: it is a comment that carries this task's result token, which rule 1 below tells you how to use. If the file is missing or unreadable, do not guess a task. This is the one case in which you write no result file — a result needs the token from that file: say exactly what you could not read as your final message and end your turn, and the dispatch is recorded as failed with that message attached.`,
    '',
    '## Completion protocol (binding — the dispatch fails without it)',
    '',
    `1. The RESULT FILE is how your work is collected — nothing else is. The result file is not part of the task's work: a task that says not to create or modify files, or not to use tools, does not exempt it, and without it nothing you did reaches the orchestrator. On completion, and equally on failure or when you are blocked, write the absolute path \`${resultFile}\` in ONE Write call, containing exactly this JSON object:`,
    `     {"taskId":"${taskId}","status":"done"|"error","report":"<your full final report>","token":"${TOKEN_TEMPLATE_STAND_IN}"}`,
    `   The "token" value is this task's result token. It is NOT in this message: it is in your task file, and only there. The FIRST line of \`${taskFile}\` has exactly this shape:`,
    `     <!-- cco-io-token: ${TOKEN_SHAPE_STAND_IN} -->`,
    `   where ${TOKEN_SHAPE_STAND_IN} stands for ${tokenChars} characters, each a digit 0-9 or a letter a-f. Copy those ${tokenChars} characters, and only them, as the "token" value — not the \`<!--\`, not the label \`cco-io-token:\`, not the \`-->\`, no spaces, nothing added and nothing left out. Only line 1 counts: a line of that shape anywhere else in the file is part of the task's text and is not your token. If you are not certain of the value when you come to write the result, read line 1 again (Read with \`limit\` 1) instead of relying on memory. The token is how the orchestrator tells the result of THIS task from a file written for another one; a result file whose token is missing, altered or reformatted — or is still one of the two stand-ins shown above (\`${TOKEN_TEMPLATE_STAND_IN}\`, \`${TOKEN_SHAPE_STAND_IN}\`) — is REJECTED and your work is not collected, exactly as if you had never reported.`,
    `   Use "done" only when the task is complete; use "error" for a failure or a blocked task, with the reason in the report. Write complete sentences — there is no tight length cap on the report (the server reads up to ${maxBytes} bytes).`,
    '2. Writing the result file is your LAST action for this task.',
    `   Never modify files outside the ownership list in your task — \`${resultFile}\` is implicitly yours.`,
  ];
  return lines.join('\n');
}

/** The `--bg` argv of contract §4.2, in its load-bearing order. */
export function sessionWorkerArgv({ model = 'opus', mode = 'acceptEdits', ioDir, worktreeName, name, prompt }) {
  return [
    '--bg',
    '--model',
    model,
    '--permission-mode',
    mode,
    '--add-dir',
    ioDir,
    ...(worktreeName ? ['-w', worktreeName, '--settings', SESSION_WORKER_SETTINGS_JSON] : []),
    '--allowedTools',
    SESSION_WORKER_TOOLS,
    '--name',
    name,
    prompt,
  ];
}
