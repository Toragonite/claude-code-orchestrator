// helpers.mjs — fixtures and drivers for the v2.0.0 providers harness (.orchestrator/providers).
//
// Isolation plumbing, in the pattern of .orchestrator/mesh2/helpers2.mjs:
//   - one throwaway SANDBOX directory per fixture: a fake HOME (so the server's data root,
//     every vendor's default home and the Claude config dirs all land in it), a `bin/`
//     holding launchers for the FAKE `codex`, `cursor-agent` and `agy`, a sandbox "login
//     shell", one workspace, the scenario files and the invocation logs;
//   - an environment built from an ALLOW-list, with PATH and SHELL replaced, so that nothing
//     named codex / cursor-agent / agy / claude outside the sandbox can be resolved;
//   - a preloaded network guard (net-guard.cjs), so no process the harness starts can open a
//     non-loopback connection or reach a vendor endpoint;
//   - the keychain guard (../fixes/keychain-guard.cjs), loaded into this process on import and
//     preloaded into every process the sandbox environment starts, with
//     AGENT_CLI_CREDENTIAL_STORE=memory: no adapter reads a keychain or a real login file, and an
//     attempt to run `security` is refused and logged (the harness then fails at exit);
//   - a newline-delimited JSON-RPC client for `out/mcp/server.js`, a runner for
//     `out/mcp/provider-cli.js`, and a loader for the REAL adapter packages (self-test);
//   - cleanup that kills every process started in a sandbox and removes the sandbox.
//
// Nothing here reads or writes outside a sandbox it created, and nothing here ever runs a
// real `codex`, `cursor-agent`, `agy` or `claude`.

import keychainGuard from '../fixes/keychain-guard.cjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SANDBOX_MARKER, SCENARIO_ENV } from './fake-vendor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDERS_DIR = HERE;
export const REPO_ROOT = path.resolve(HERE, '..', '..');
/** The compiled bundles under test. `PROVIDERS_OUT_DIR` points the harness at another build. */
export const OUT_MCP_DIR = process.env.PROVIDERS_OUT_DIR ? path.resolve(process.env.PROVIDERS_OUT_DIR) : path.join(REPO_ROOT, 'out', 'mcp');
export const SERVER_JS = path.join(OUT_MCP_DIR, 'server.js');
export const PROVIDER_CLI_JS = path.join(OUT_MCP_DIR, 'provider-cli.js');
export const RUN_TASK_JS = path.join(OUT_MCP_DIR, 'run-task.js');
export const NET_GUARD = path.join(HERE, 'net-guard.cjs');
export const KEYCHAIN = keychainGuard.harness('providers');
export const FAKE_ENTRIES = {
  codex: path.join(HERE, 'fake-codex.mjs'),
  'cursor-agent': path.join(HERE, 'fake-cursor-agent.mjs'),
  agy: path.join(HERE, 'fake-agy.mjs'),
};
/** The fake `claude` of the mesh2 harness, reused read-only for the Claude legs. */
export const FAKE_CLAUDE2 = path.join(REPO_ROOT, '.orchestrator', 'mesh2', 'fake-claude2.mjs');
export const CLAUDE_ONESHOT_MARKER = 'FAKE2_ONESHOT_OK';

export const KEEP_SANDBOXES = process.env.PROVIDERS_KEEP === '1';
/** Where sandboxes are created. `PROVIDERS_TMPDIR` moves them off the system temp directory. */
export const TMP_BASE = process.env.PROVIDERS_TMPDIR ? path.resolve(process.env.PROVIDERS_TMPDIR) : os.tmpdir();
export const TEST_PARK_GRACE_MS = 600;
export const TEST_LIVENESS_TICK_MS = 200;

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
export const MODEL_FORMS_HINT = 'an alias (opus, sonnet, fable, haiku) or a full model id such as claude-opus-5-5';

/**
 * src/providers.ts, restated (the self-test checks these against the source text, so a
 * change to the frozen module shows up as a self-test failure, not as a wrong probe).
 */
export const PROVIDERS = {
  claude: { label: 'Claude Code', cli: 'claude', homeEnv: 'CLAUDE_CONFIG_DIR', defaultHome: '.claude', isolation: 'env', defaultPermissionMode: 'acceptEdits', firstSuggestedModel: 'opus' },
  codex: {
    label: 'Codex',
    cli: 'codex',
    homeEnv: 'CODEX_HOME',
    defaultHome: '.codex',
    isolation: 'env',
    permissionFlag: '--sandbox',
    permissionModes: ['workspace-write', 'read-only', 'danger-full-access'],
    defaultPermissionMode: 'workspace-write',
    firstSuggestedModel: 'gpt-6.1-sol',
  },
  cursor: {
    label: 'Cursor',
    cli: 'cursor-agent',
    homeEnv: null,
    defaultHome: '.cursor',
    isolation: 'none',
    permissionFlag: '--sandbox',
    permissionModes: ['enabled', 'disabled'],
    defaultPermissionMode: null,
    firstSuggestedModel: 'auto',
  },
  gemini: {
    label: 'Antigravity',
    cli: 'agy',
    homeEnv: 'AGY_HOME',
    defaultHome: '.agy',
    isolation: 'env',
    permissionFlag: '--mode',
    permissionModes: ['accept-edits', 'plan'],
    defaultPermissionMode: 'accept-edits',
    firstSuggestedModel: 'gemini-3.8-flash-high',
  },
};
export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'gemini'];
export const VENDOR_IDS = ['codex', 'cursor', 'gemini'];
export const VENDOR_CLIS = ['codex', 'cursor-agent', 'agy'];
export const ALL_CLIS = [...VENDOR_CLIS, 'claude'];

/** providers.ts `providerModelHint`, restated. */
export function providerModelHint(id) {
  return id === 'claude'
    ? MODEL_FORMS_HINT
    : `${/^[aeiou]/i.test(PROVIDERS[id].label) ? 'an' : 'a'} ${PROVIDERS[id].label} model id such as ${PROVIDERS[id].firstSuggestedModel}`;
}

/**
 * The WORDS of the server's quota classifier (provider-runner `QUOTA_WORDS`), restated for the
 * self-test — which also checks this copy, character for character, against the source.
 *
 * It is the words and nothing more, on purpose. The classifier itself (`isQuotaError`) is no
 * longer one regex: it removes stack frames, test-report lines, paths, file names and quoted
 * identifiers first, reads 429 / 529 only where they are stated as a status, and does not count
 * a limit that is not an account's allowance ("context limit exceeded") or a rate that is not
 * one of requests ("sampling rate limit"). None of that can be restated in a line, and a second
 * implementation here would be the drift this copy exists to catch; those rules are tested
 * against the real function in `.orchestrator/fixes/runner.mjs`. For the FIXTURE texts the words
 * are the whole question: every `quota` text has to contain one, and no other text may — which
 * is a property of the fixtures, and is what the self-test uses this for.
 */
export const QUOTA_CLASSIFIER = /quota|usage limit|rate.?limit|limit (?:has been )?(?:reached|exceeded)|too many requests|overloaded|out of (?:extra )?usage|(?:hit|reached|exceeded) your(?: [^\s.,;:!?()]+){0,2} limit/i;

/**
 * Recognizable secrets planted in the Codex `auth.json` fixture. None may ever appear in a
 * tool result, an event, an output file, a helper's output or the server's stderr.
 */
export const SECRETS = {
  idToken: 'HARNESS-ID-TOKEN.SECRET-MARKER-IDTOKEN',
  accessToken: 'HARNESS-ACCESS-TOKEN-SECRET-MARKER-ACCESS',
  refreshToken: 'HARNESS-REFRESH-TOKEN-SECRET-MARKER-REFRESH',
  apiKey: 'sk-HARNESS-API-KEY-SECRET-MARKER',
  email: 'harness-codex-user@example.invalid',
  accountId: 'aaaaaaaa-bbbb-cccc-dddd-harnessacct',
};
export const PASSTHROUGH_VALUE = 'kept-by-scrubSessionEnv';

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

/** Poll a predicate until it returns something truthy, or throw on timeout. */
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

/** One line, bounded — for quoting server text inside a PASS/FAIL line. */
export function clip(text, max = 220) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** POSIX single-quoting, for the launcher scripts. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isSpawnableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function assertBuilt(files = [SERVER_JS]) {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(`Build output not found: ${missing.join(', ')}. Run \`npm run compile\` from the repo root first (or set PROVIDERS_OUT_DIR).`);
  }
}

/* ------------------------------------------------------------------------- *
 * Environment — an allow-list, never the caller's environment
 * ------------------------------------------------------------------------- */

const ENV_ALLOW = ['TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'TERM', 'TZ'];
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The only variables of the calling shell that reach anything the harness starts. This
 * harness is normally run from inside a Claude Code session on a machine where the real
 * vendor CLIs are installed and logged in: its PATH, its Claude session variables, a
 * CODEX_HOME / AGY_HOME / OPENAI_API_KEY / CURSOR_API_KEY it may export and its proxy
 * settings must not leak into a run.
 */
function baseEnv() {
  const env = {};
  for (const k of ENV_ALLOW) {
    if (typeof process.env[k] === 'string') {
      env[k] = process.env[k];
    }
  }
  return env;
}

/* ------------------------------------------------------------------------- *
 * Hermeticity — "would a real binary have been resolved?"
 * ------------------------------------------------------------------------- */

function writeLoginShell(file, sandboxPath, logFile) {
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      '# Sandbox "login shell" of the providers harness. The server resolves a bare CLI name',
      '# with `$SHELL -lc "command -v <name>"`; a real login shell would run /etc/profile',
      "# (path_helper puts /usr/local/bin first) and the user's profile. This one reads no",
      '# profile at all and searches the sandbox PATH only.',
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

/** Lines `command -v` printed for each CLI name, through one shell invocation. */
function resolveThroughShell(shell, names, env) {
  const script = names.map((n) => `printf '%s=' ${n}; command -v ${n} || true; echo`).join('; ');
  try {
    const out = execFileSync(shell, ['-lc', script], { encoding: 'utf8', timeout: 15_000, env: { ...env, SHELL: shell }, stdio: ['ignore', 'pipe', 'ignore'] });
    const found = {};
    for (const line of out.split('\n')) {
      const m = /^([A-Za-z0-9._-]+)=(.*)$/.exec(line.trim());
      if (m && names.includes(m[1]) && m[2] !== '') {
        found[m[1]] = m[2];
      }
    }
    return found;
  } catch (e) {
    return { __error: e.message };
  }
}

/**
 * What a sandbox environment with NO fakes installed can resolve. Every entry in
 * `violations` is a real binary (or anything else with that name) the server could have
 * started instead of a fake; `systemBinaries` are the fixed absolute locations the server's
 * well-known-location fallback probes when a name is not found at all.
 *
 * `extraPath` exists for the self-test, which plants a decoy to prove this check can see one.
 */
export function inspectHermeticity({ extraPath = [] } = {}) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, 'cco-prov-preflight-')));
  SEEN_ROOTS.add(root);
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const pathDirs = [bin, ...extraPath, ...SYSTEM_PATH];
    const sandboxPath = pathDirs.join(':');
    const loginShell = path.join(root, 'login-shell');
    writeLoginShell(loginShell, sandboxPath, path.join(root, 'login-shell.log'));
    const env = { ...baseEnv(), HOME: home, PATH: sandboxPath };
    const violations = [];
    for (const cli of ALL_CLIS) {
      for (const dir of pathDirs) {
        if (isSpawnableFile(path.join(dir, cli))) {
          violations.push(`${cli} is on the sandbox PATH at ${path.join(dir, cli)}`);
        }
      }
    }
    // The sandbox shell is what the server is handed; the system shells are checked too, in
    // case an implementation names one itself. With HOME redirected none of them reads the
    // user's profile, so what remains is /etc/profile, /etc/zprofile and /etc/paths.
    for (const shell of [loginShell, '/bin/sh', '/bin/bash', '/bin/zsh']) {
      if (!isSpawnableFile(shell)) {
        continue;
      }
      const found = resolveThroughShell(shell, ALL_CLIS, env);
      for (const [cli, where] of Object.entries(found)) {
        if (cli === '__error') {
          continue;
        }
        violations.push(`\`${shell} -lc "command -v ${cli}"\` resolves ${where}`);
      }
    }
    // registry.ts wellKnownLocations: ~/.npm-global/bin, ~/.local/bin (both under the fake
    // HOME, so empty) and these two, which no environment can redirect.
    const systemBinaries = {};
    for (const cli of ALL_CLIS) {
      systemBinaries[cli] = ['/opt/homebrew/bin', '/usr/local/bin'].map((d) => path.join(d, cli)).filter(isSpawnableFile);
    }
    return { violations, systemBinaries };
  } finally {
    rmrf(root);
  }
}

let hermeticMemo;
/** inspectHermeticity(), once per process. */
export function hermeticVerdict() {
  if (hermeticMemo === undefined) {
    hermeticMemo = inspectHermeticity();
  }
  return hermeticMemo;
}

/* ------------------------------------------------------------------------- *
 * Process bookkeeping — nothing started in a sandbox may outlive a run
 * ------------------------------------------------------------------------- */

/** Every sandbox created in this process and not yet cleaned up. */
const ACTIVE = new Set();
/** Every sandbox root this process ever created. */
const SEEN_ROOTS = new Set();
/** Job ids of fake-claude2 workers seen in any fixture (a late `stop <id>` carries only that). */
const SEEN_JOB_IDS = new Set();

function ps(args) {
  const res = spawnSync('/bin/ps', args, { encoding: 'utf8', env: { LC_ALL: 'C', LANG: 'C', PATH: SYSTEM_PATH.join(':') } });
  return res.status === 0 ? String(res.stdout) : '';
}

function psAll() {
  const out = [];
  for (const line of ps(['-axo', 'pid=,command=']).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid) {
      out.push({ pid: Number(m[1]), command: m[2] });
    }
  }
  return out;
}

/** Process-group id of a live process, or undefined. */
export function pgidOf(pid) {
  const n = Number(ps(['-o', 'pgid=', '-p', String(pid)]).trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function processInfo(pid) {
  const line = ps(['-o', 'lstart=,command=', '-p', String(pid)]).trim();
  const m = /^(\w{3} +\w{3} +\d{1,2} +\d\d:\d\d:\d\d +\d{4}) +(.*)$/.exec(line);
  if (!m) {
    return undefined;
  }
  const startedAt = Date.parse(m[1]);
  return { startedAt: Number.isNaN(startedAt) ? undefined : startedAt, command: m[2] };
}

/** Is `command` a process of this sandbox? Launchers and helpers carry the root on argv. */
function belongsTo(command, root, jobIds) {
  if (command.includes(root)) {
    return true;
  }
  const m = /fake-claude2\.mjs (?:stop|rm) ([0-9a-f]{8})\b/.exec(command);
  return m !== null && jobIds.has(m[1]);
}

/**
 * SIGKILL every live process of a fixture: whatever names the sandbox root on its command
 * line (vendor fakes, grandchildren, fake-claude2 helpers, a detach supervisor), a
 * fake-claude2 one-shot recorded in the pid directory, and a detached `claude stop <id>` /
 * `claude rm <id>` the server fired at session end. Ends after a quiet window.
 */
export async function killSandboxProcesses(fx, { quietMs = 120 } = {}) {
  let killed = 0;
  const deadline = Date.now() + 8000;
  let quietSince = Date.now();
  while (Date.now() < deadline && Date.now() - quietSince <= quietMs) {
    for (const id of fx.claudeJobIds()) {
      SEEN_JOB_IDS.add(id);
    }
    const targets = new Set();
    for (const p of psAll()) {
      if (belongsTo(p.command, fx.root, SEEN_JOB_IDS)) {
        targets.add(p.pid);
      }
    }
    for (const dir of [fx.pidDir, fx.claudePidDir]) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // already removed
      }
      for (const name of names) {
        const pid = Number(name.replace(/\.json$/, ''));
        const rec = readJson(path.join(dir, name));
        if (!Number.isInteger(pid) || !isPidAlive(pid)) {
          continue;
        }
        // A pid is recycled quickly on a busy machine: signal it only when it is still a
        // fake that started when the record says it did.
        const info = processInfo(pid);
        if (info && /fake-(claude2|vendor|codex|cursor-agent|agy)\.mjs/.test(info.command) && rec && Number.isFinite(rec.startedAt) && info.startedAt !== undefined && Math.abs(info.startedAt - rec.startedAt) <= 5000) {
          targets.add(pid);
        }
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

/** Processes of any sandbox of this run that are STILL alive — the harness's own leak check. */
export function strayProcesses() {
  return psAll().filter((p) => [...SEEN_ROOTS].some((root) => belongsTo(p.command, root, SEEN_JOB_IDS)));
}

/** End-of-run sweep: kill late stragglers, report any that survive. */
export async function settleStrays({ timeoutMs = 5000 } = {}) {
  let lateKilled = 0;
  let quiet = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const strays = strayProcesses();
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
      return { lateKilled, remaining: strayProcesses() };
    }
    await sleep(100);
  }
}

/** Sandbox roots created by this process that still exist on disk. */
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
 * Write `<dir>/auth.json`, the file the Codex adapter's auth probe reads.
 *
 *   'chatgpt'        a ChatGPT login WITHOUT a usable access token: `authStatus()` says
 *                    logged in (an id_token is enough), `quota()` resolves null before any
 *                    fetch. The default — a probe that does not test quota cannot reach the
 *                    usage endpoint at all.
 *   'chatgpt-quota'  the same plus an access token: `quota()` will call `fetch` (which the
 *                    network guard answers).
 *   'api-key'        a key embedded in the file, no bearer.
 *   'out'            the token-less file a logout leaves behind.
 *   'garbage'        not JSON.
 *   'absent'         no file.
 */
export function writeCodexAuth(dir, state = 'chatgpt') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'auth.json');
  const tokens = { id_token: SECRETS.idToken, refresh_token: SECRETS.refreshToken, account_id: SECRETS.accountId };
  const write = (obj) => fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  switch (state) {
    case 'chatgpt':
      write({ OPENAI_API_KEY: null, tokens, email: SECRETS.email, last_refresh: new Date().toISOString() });
      break;
    case 'chatgpt-quota':
      write({ OPENAI_API_KEY: null, tokens: { ...tokens, access_token: SECRETS.accessToken }, email: SECRETS.email, last_refresh: new Date().toISOString() });
      break;
    case 'api-key':
      write({ OPENAI_API_KEY: SECRETS.apiKey });
      break;
    case 'out':
      write({ OPENAI_API_KEY: null, tokens: null });
      break;
    case 'garbage':
      write('this is not json {');
      break;
    case 'absent':
      fs.rmSync(file, { force: true });
      break;
    default:
      throw new Error(`writeCodexAuth: unknown state ${state}`);
  }
  return file;
}

function runGit(cwd, args) {
  const res = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...baseEnv(), PATH: SYSTEM_PATH.join(':'), HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 20_000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(res.stderr || res.stdout).trim()}`);
  }
}

/** A real repository with one commit — a session worker only gets a worktree in one. */
function makeGitWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q']);
  runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# providers fixture workspace\n');
  runGit(dir, ['add', '-A']);
  runGit(dir, ['-c', 'user.name=providers fixture', '-c', 'user.email=providers@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'fixture: initial commit']);
}

/**
 * Build one sandbox.
 *
 * opts:
 *   label      — goes into the directory name (probe id)
 *   workspace  — 'plain' (default) | 'git' (a repository with one commit; needed for --bg)
 *   workers    — [{ name, provider?, configDir?, model?, permissionMode?, auth?, extra? }]
 *                  provider   absent = a Claude Code worker (registry entry carries no key)
 *                  configDir  'default' = the provider's default home under the fake HOME;
 *                             an absolute path is used verbatim; absent = a per-worker dir
 *                             (Cursor: always the default home — it has one ambient login)
 *                  model      Claude default 'opus'; a vendor worker has NONE unless given
 *                  auth       Codex only: a writeCodexAuth state (default 'chatgpt')
 *                  extra      raw fields merged into the registry entry (hostile values)
 *   rawWorkers — registry entries appended verbatim after `workers` (registry-hygiene probes)
 *   registry   — fields merged over the registry defaults (meshMode, …)
 *   usage      — { <worker name>: object merged over that worker's reading | null (no reading) }.
 *                Claude workers get a fresh healthy reading by default; vendor workers get
 *                none (a machine whose extension has not polled them yet).
 *   clis       — which fake CLIs to install in bin/ (default: all three)
 *   scenario   — initial scenario for the vendor fakes
 *   claude     — initial scenario for fake-claude2
 *   net        — what the network guard answers a fetch with (default { mode: 'deny' })
 */
export function makeFixture(opts = {}) {
  const label = String(opts.label ?? 'fx').replace(/[^A-Za-z0-9]/g, '');
  // realpath: on macOS os.tmpdir() is a symlink, while a child's process.cwd() sees the
  // resolved path. One canonical spelling everywhere.
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, `cco-prov-${label}-`)));
  SEEN_ROOTS.add(root);
  fs.writeFileSync(path.join(root, SANDBOX_MARKER), 'providers harness sandbox — safe to delete\n');
  const home = path.join(root, 'home');
  const orchRoot = path.join(home, '.claude-code-orchestrator');
  const binDir = path.join(root, 'bin');
  const pidDir = path.join(root, 'pids');
  const claudePidDir = path.join(root, 'pids-claude');
  const sandboxTmp = path.join(root, 'tmp');
  fs.mkdirSync(sandboxTmp, { mode: 0o700 });
  fs.mkdirSync(path.join(orchRoot, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(orchRoot, 'mesh'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(binDir);
  fs.mkdirSync(pidDir);
  fs.mkdirSync(claudePidDir);

  const sandboxPath = [binDir, ...SYSTEM_PATH].join(':');
  const loginShell = path.join(root, 'login-shell');
  const loginShellLog = path.join(root, 'login-shell.log');
  writeLoginShell(loginShell, sandboxPath, loginShellLog);
  // fake-claude2.mjs starts with `#!/usr/bin/env node`; this is the only `node` on the PATH.
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));

  const installCli = (cli) => {
    fs.writeFileSync(
      path.join(binDir, cli),
      ['#!/bin/sh', `# providers-harness launcher: the FAKE ${cli}. Never the real CLI.`, `exec ${shq(process.execPath)} ${shq(FAKE_ENTRIES[cli])} ${shq(`--fake-root=${root}`)} "$@"`, ''].join('\n'),
      { mode: 0o755 },
    );
  };
  const clis = opts.clis ?? VENDOR_CLIS;
  for (const cli of clis) {
    installCli(cli);
  }

  const defaultHomeOf = (provider) => path.join(home, PROVIDERS[provider].defaultHome);
  const workers = (opts.workers ?? []).map((w) => {
    const provider = w.provider ?? 'claude';
    let configDir;
    if (typeof w.configDir === 'string' && w.configDir !== 'default') {
      configDir = w.configDir;
    } else if (w.configDir === 'default' || provider === 'cursor') {
      configDir = defaultHomeOf(provider);
    } else if (provider === 'claude') {
      configDir = path.join(home, 'accounts', w.name);
    } else {
      configDir = path.join(home, `${PROVIDERS[provider].defaultHome}-${w.name}`);
    }
    fs.mkdirSync(configDir, { recursive: true });
    if (provider === 'codex' && w.auth !== 'untouched') {
      writeCodexAuth(configDir, w.auth ?? 'chatgpt');
    }
    const model = w.model !== undefined ? w.model : provider === 'claude' ? 'opus' : undefined;
    const entry = {
      name: w.name,
      configDir,
      ...(model !== undefined ? { model } : {}),
      ...(w.provider !== undefined ? { provider: w.provider } : {}),
      ...(w.permissionMode !== undefined ? { permissionMode: w.permissionMode } : {}),
      ...(w.preferred ? { preferred: true } : {}),
      ...(w.extra ?? {}),
    };
    return { name: w.name, provider, configDir, model, entry };
  });

  // registry.ts requires the execute bit on claudePath. The file belongs to the mesh2
  // harness, so it is checked here, never changed: without the bit the Claude legs fail with
  // the server's own "claude not found" error, which names this path.
  const registry = {
    workers: [...workers.map((w) => w.entry), ...(opts.rawWorkers ?? [])],
    permissionMode: 'acceptEdits',
    claudePath: FAKE_CLAUDE2,
    cooldownMinutes: 30,
    workerTimeoutMinutes: 5,
    frontierWorkerDispatch: 'block',
    overageWorkerDispatch: 'block',
    meshMode: 'off',
    meshMaxLiveWorkers: 8,
    meshHistoryLimit: 50,
    ...(opts.registry ?? {}),
  };
  fs.writeFileSync(path.join(orchRoot, 'registry.json'), JSON.stringify(registry, null, 2));

  const now = Date.now();
  const future = new Date(now + 6 * 3_600_000).toISOString();
  const usage = {};
  for (const w of workers) {
    const override = opts.usage ? opts.usage[w.name] : undefined;
    if (override === null) {
      continue;
    }
    if (w.provider === 'claude') {
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
        ...(override ?? {}),
      };
    } else if (override !== undefined) {
      usage[w.configDir] = { name: w.name, configDir: w.configDir, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: now, ...override };
    }
  }
  fs.writeFileSync(path.join(orchRoot, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(orchRoot, 'stats.json'), JSON.stringify({}, null, 2));

  const workspaceKind = opts.workspace ?? 'plain';
  const workspace = path.join(root, workspaceKind === 'git' ? 'ws-git' : 'ws-plain');
  if (workspaceKind === 'git') {
    makeGitWorkspace(workspace);
  } else {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# providers fixture workspace (not a repository)\n');
  }

  const scenarioFile = path.join(root, 'vendor-scenario.json');
  const logFile = path.join(root, 'fake-vendor.log.jsonl');
  const claudeScenarioFile = path.join(root, 'claude-scenario.json');
  const claudeLogFile = path.join(root, 'fake-claude.log.jsonl');
  const netFile = path.join(root, 'net.json');
  const netLogFile = path.join(root, 'net.log.jsonl');

  const servers = [];
  let cleaned = false;

  const mergeExits = (rows) => {
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
  };

  const fx = {
    label,
    root,
    home,
    orchRoot,
    tasksDir: path.join(orchRoot, 'tasks'),
    binDir,
    pidDir,
    claudePidDir,
    workspace,
    workspaceKind,
    workers,
    registry,
    loginShell,
    sandboxPath,
    aborted: false,
    servers,

    worker(name) {
      return workers.find((w) => w.name === name);
    },
    defaultHome: defaultHomeOf,
    launcher(cli) {
      return path.join(binDir, cli);
    },
    installCli,
    removeCli(cli) {
      fs.rmSync(path.join(binDir, cli), { force: true });
    },

    /** Replace the scenario the vendor fakes read on their next invocation. */
    setScenario(scenario = {}) {
      writeJsonAtomic(scenarioFile, { ...scenario, sandboxRoot: root, logFile, pidDir });
    },
    /** Replace the scenario fake-claude2 reads on its next invocation. */
    setClaudeScenario(scenario = {}) {
      writeJsonAtomic(claudeScenarioFile, { ...scenario, sandboxRoot: root, logFile: claudeLogFile, pidDir: claudePidDir });
    },
    /** What the network guard answers a `fetch` with (see net-guard.cjs). */
    setNet(fetchCfg = { mode: 'deny' }, extra = {}) {
      writeJsonAtomic(netFile, { logFile: netLogFile, fetch: fetchCfg, ...extra });
    },

    /** Environment for anything started in this sandbox. `null` deletes a variable. */
    env(extra = {}) {
      const env = {
        ...baseEnv(),
        HOME: home,
        // Vendor adapters place helper dirs under os.tmpdir() (the agy usage lookup's cwd): keep
        // them inside the sandbox, or the fakes' containment check refuses the run.
        TMPDIR: sandboxTmp,
        PATH: sandboxPath,
        SHELL: loginShell,
        [SCENARIO_ENV]: scenarioFile,
        FAKE_CLAUDE2_SCENARIO: claudeScenarioFile,
        CCO_PROVIDERS_NET: netFile,
        NODE_OPTIONS: keychainGuard.nodeOptionsWith(`--require ${JSON.stringify(NET_GUARD)}`),
        AGENT_CLI_CREDENTIAL_STORE: 'memory',
        CCO_KEYCHAIN_GUARD_LOG: KEYCHAIN.logFile,
        CCO_PROVIDERS_PASSTHROUGH: PASSTHROUGH_VALUE,
        CCO_TEST_PARK_GRACE_MS: String(TEST_PARK_GRACE_MS),
        CCO_TEST_LIVENESS_TICK_MS: String(TEST_LIVENESS_TICK_MS),
      };
      for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === undefined) {
          delete env[k];
        } else {
          env[k] = String(v);
        }
      }
      return env;
    },

    /**
     * Fail loudly unless every installed fake is what a bare CLI name resolves to in this
     * sandbox — through the login-shell lookup and through a plain PATH walk — and no CLI
     * that is NOT installed resolves to anything at all.
     */
    assertHermetic() {
      const found = resolveThroughShell(loginShell, VENDOR_CLIS, fx.env());
      for (const cli of VENDOR_CLIS) {
        const installed = fs.existsSync(path.join(binDir, cli));
        const viaPath = sandboxPath.split(':').map((d) => path.join(d, cli)).find(isSpawnableFile);
        const expected = installed ? path.join(binDir, cli) : undefined;
        if (found[cli] !== expected || viaPath !== expected) {
          throw new Error(`REFUSING TO RUN: in this sandbox \`${cli}\` resolves to ${found[cli] ?? 'nothing'} (login shell) / ${viaPath ?? 'nothing'} (PATH), expected ${expected ?? 'nothing'} — a real binary could be started`);
        }
        if (!installed && hermeticVerdict().systemBinaries[cli].length > 0) {
          throw new Error(`REFUSING TO RUN a "CLI not installed" case: a real ${cli} exists at ${hermeticVerdict().systemBinaries[cli].join(', ')}, where the server's well-known-location fallback would find and start it`);
        }
      }
    },

    /** Start the compiled server in this sandbox's workspace and complete `initialize`. */
    async startServer({ env = {}, initialize = true } = {}) {
      fx.assertHermetic();
      const srv = startServer(fx.env(env), workspace);
      servers.push(srv);
      if (initialize) {
        await srv.initialize();
      }
      return srv;
    },

    /** Every vendor-fake invocation so far, each with its exit code merged in once it exited. */
    vendorLog() {
      return mergeExits(readJsonl(logFile));
    },
    /** The one-shot runs (`run` / `resume`) of one vendor, or of all. */
    runs(vendor) {
      return fx.vendorLog().filter((r) => (r.kind === 'run' || r.kind === 'resume') && (vendor === undefined || r.vendor === vendor));
    },
    invocations(vendor) {
      return fx.vendorLog().filter((r) => r.vendor === vendor && r.kind !== 'grandchild' && r.kind !== 'sigterm-ignored');
    },
    grandchildren() {
      return fx.vendorLog().filter((r) => r.kind === 'grandchild');
    },
    /** Invocations a fake refused or did not understand. */
    anomalies() {
      return fx.vendorLog().filter((r) => ['unsupported', 'sandbox-violation', 'fake-error', 'no-scenario'].includes(r.kind));
    },

    claudeLog() {
      return mergeExits(readJsonl(claudeLogFile));
    },
    claudeOneShots() {
      return fx.claudeLog().filter((r) => r.kind === 'oneshot');
    },
    claudeBgSpawns() {
      return fx.claudeLog().filter((r) => r.kind === 'bg');
    },
    /** fake-claude2's job records (one per `--bg` helper), across the Claude config dirs. */
    claudeJobs() {
      const out = [];
      const dirs = new Set([path.join(home, '.claude'), ...workers.filter((w) => w.provider === 'claude').map((w) => w.configDir)]);
      for (const dir of dirs) {
        for (const sub of ['jobs', 'removed']) {
          const jobsDir = path.join(dir, 'fake-claude2', sub);
          let names = [];
          try {
            names = fs.readdirSync(jobsDir);
          } catch {
            continue;
          }
          for (const n of names) {
            if (/^[0-9a-f]{8}\.json$/.test(n)) {
              const job = readJson(path.join(jobsDir, n));
              if (job && typeof job === 'object') {
                out.push(job);
              }
            }
          }
        }
      }
      return out;
    },
    claudeJobIds() {
      return fx.claudeJobs().map((j) => j.jobId).filter((id) => typeof id === 'string');
    },

    netLog() {
      return readJsonl(netLogFile);
    },
    /** Commands the SERVER asked the sandbox login shell to run (the harness's own checks excluded). */
    loginShellLog() {
      try {
        return fs
          .readFileSync(loginShellLog, 'utf8')
          .split('\n')
          .filter((l) => l !== '' && !l.includes("printf '%s='"));
      } catch {
        return [];
      }
    },

    events() {
      return readJsonl(path.join(orchRoot, 'tasks.jsonl'));
    },
    eventsOfTask(id) {
      return fx.events().filter((e) => e.id === id);
    },
    eventsFor(title) {
      return fx.events().filter((e) => e.title === title);
    },
    stats() {
      return readJson(path.join(orchRoot, 'stats.json')) ?? {};
    },
    usage() {
      return readJson(path.join(orchRoot, 'usage.json')) ?? {};
    },
    /** Total bytes under the data root — "is anything this run recorded unbounded?". */
    dataRootBytes() {
      let total = 0;
      const walk = (dir) => {
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(p);
          } else if (e.isFile()) {
            try {
              total += fs.statSync(p).size;
            } catch {
              // removed meanwhile
            }
          }
        }
      };
      walk(orchRoot);
      return total;
    },

    /** Stop servers, kill everything started in the sandbox, remove it. Idempotent. */
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      fx.aborted = true;
      for (const srv of servers) {
        await srv.stop();
      }
      await killSandboxProcesses(fx, { quietMs: servers.length > 0 ? 300 : 80 });
      if (!KEEP_SANDBOXES && !rmrf(root)) {
        await sleep(250);
        await killSandboxProcesses(fx, { quietMs: 200 });
        rmrf(root);
      }
      ACTIVE.delete(fx);
    },
  };

  fx.setScenario(opts.scenario ?? {});
  fx.setClaudeScenario(opts.claude ?? {});
  fx.setNet(opts.net ?? { mode: 'deny' });
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
  let stdoutBytes = 0;
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
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdoutBytes += Buffer.byteLength(d);
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
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 400_000) {
      stderr = stderr.slice(-200_000);
    }
  });

  const toToolAnswer = (resp, started) => {
    const elapsedMs = Date.now() - started;
    if (resp.error) {
      return { text: String(resp.error.message ?? ''), isError: true, rpcError: resp.error, elapsedMs, raw: resp };
    }
    const text = Array.isArray(resp.result?.content) ? resp.result.content.map((c) => c?.text ?? '').join('\n') : '';
    return { text, isError: resp.result?.isError === true, elapsedMs, raw: resp };
  };

  const srv = {
    child,
    get stderr() {
      return stderr;
    },
    get stdoutBytes() {
      return stdoutBytes;
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
    notify(method, params) {
      srv.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    hasResponse(id) {
      return responses.has(id);
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
    request(method, params, timeoutMs = 20_000) {
      const id = nextId++;
      srv.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return srv.waitResponse(id, timeoutMs);
    },
    async initialize(protocolVersion = '2025-11-25') {
      const resp = await srv.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'providers-probe', version: '0' } }, 15_000);
      srv.notify('notifications/initialized');
      return resp;
    },
    /**
     * `tools/call`. Resolves `{ text, isError, rpcError, elapsedMs, raw }` — a tool-level
     * failure (isError) and a protocol-level one (rpcError) are both ANSWERS, not throws.
     */
    async callTool(name, args = {}, timeoutMs = 30_000) {
      const started = Date.now();
      return toToolAnswer(await srv.request('tools/call', { name, arguments: args }, timeoutMs), started);
    },
    /** Start a `tools/call` without waiting: `{ id, answer(timeoutMs) }` — for cancellation. */
    startTool(name, args = {}) {
      const id = nextId++;
      const started = Date.now();
      srv.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      return { id, answer: async (timeoutMs = 30_000) => toToolAnswer(await srv.waitResponse(id, timeoutMs), started) };
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
    async stop(timeoutMs = 10_000) {
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
 * One-off Node processes (provider-cli.js, self-test children)
 * ------------------------------------------------------------------------- */

/** Run `node <args>` to completion. Settles on 'exit' plus a short drain, never on 'close'. */
export function runNode(args, { env, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ stdout, stderr, elapsedMs: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      done({ code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: null, signal: null, spawnError: e.message, timedOut: false }));
    child.on('exit', (code, signal) => setTimeout(() => done({ code, signal, timedOut: false }), 80));
  });
}

/** Run an executable (a fake's entry file or a launcher) to completion. */
export function runFile(file, args, { env, cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('error', (e) => done({ code: null, signal: null, spawnError: e.message }));
    child.on('exit', (code, signal) => setTimeout(() => done({ code, signal }), 80));
  });
}

/** The REAL adapter packages, exactly as installed in node_modules (self-test only). */
export async function loadAdapters() {
  const [core, codex, cursor, gemini] = await Promise.all([
    import('@toragonite/agent-mesh'),
    import('@toragonite/agent-mesh-codex'),
    import('@toragonite/agent-mesh-cursor'),
    import('@toragonite/agent-mesh-gemini'),
  ]);
  const version = (name) => readJson(path.join(REPO_ROOT, 'node_modules', '@toragonite', name, 'package.json'))?.version;
  return {
    core,
    CodexAdapter: codex.CodexAdapter,
    CursorAdapter: cursor.CursorAdapter,
    GeminiAdapter: gemini.GeminiAdapter,
    versions: {
      'agent-mesh': version('agent-mesh'),
      'agent-mesh-codex': version('agent-mesh-codex'),
      'agent-mesh-cursor': version('agent-mesh-cursor'),
      'agent-mesh-gemini': version('agent-mesh-gemini'),
    },
  };
}
