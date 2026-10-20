#!/usr/bin/env node
// fake-claude2.mjs — a scenario-driven, hermetic stand-in for the `claude` CLI, used by the
// v2.0.0 mesh harness (.orchestrator/mesh2). It emulates the BACKGROUND-SESSION surface of
// Claude Code 2.1.283 exactly as contract-2.0.md §P records it, plus the three one-shot
// surfaces the dispatch server already used (`-p --output-format json`, `auth status --json`,
// the stream-json `get_usage` probe). No network, no login, no real session, no real quota.
//
// The dispatch server resolves this file as `claudePath` and spawns it exactly as it would
// spawn the real binary. What it emulates:
//
//   --version                          → the scenario's version text (default 2.1.283)
//   --bg … --name <n> <prompt>         → logs argv + env, prints `backgrounded · <8 hex> · <n>`,
//                                        and leaves a DETACHED helper process behind that plays
//                                        the worker session (P8, P9, P11, P12)
//   stop <id>                          → ends that helper, exit 0
//   rm <id>                            → `removed <id>` exit 0, or `kept <id> — its worktree is
//                                        still at …` exit 1 (P7)
//   agents --json [--all]              → rows per P10
//   auth status --json                 → canned login reading
//   -p --input-format stream-json …    → answers one `get_usage` control request (P15)
//   -p --output-format json …          → canned one-shot result (prompt on stdin)
//   __bait                             → harness only: stays alive and does nothing (a decoy that
//                                        IS this program; see baitMain)
//
// SANDBOX RULE. This program does nothing at all unless FAKE_CLAUDE2_SCENARIO names a readable
// scenario file, and it refuses (exit 97) to touch a config directory that is not inside the
// scenario's sandbox root. A harness bug that leaked the real HOME can therefore never make it
// read or write a real `~/.claude`.
//
// CONFIG DIRECTORY. Resolved the way the real CLI does (P1): `CLAUDE_CONFIG_DIR` when it is
// set and non-empty, otherwise `$HOME/.claude`. The account-level config file follows the same
// split: `<dir>/.claude.json` when the variable is set, `$HOME/.claude.json` when it is not.
// This fake only ever READS that file (for the optional trust check) — it never writes it, so
// a probe that asserts "the server did not modify ~/.claude.json" measures the server alone.
//
// WORKER HELPER. `--bg` re-invokes this same file as `__worker <job file>`, detached, with
// stdio ignored. The helper writes `<configDir>/sessions/<its pid>.json` and then acts out the
// scenario. It finds the task file, the result path and the task id by PARSING THE BOOTSTRAP
// PROMPT it was handed (contract §4.6), with the `--add-dir` value as the fallback — nothing is
// passed to it out of band, so a prompt that stopped naming them shows up as a failure.
//
// THE RESULT TOKEN is found the way a real worker is told to find it: on the FIRST LINE of the
// task file (`<!-- cco-io-token: <hex> -->`), and only there. A line of that shape further down
// is task text and is ignored. The bootstrap prompt is a command-line argument and must not
// carry the token at all; whether it does is RECORDED (`promptInfo.promptCarriesToken`) so the
// harness can fail loudly, and never used. A task file that cannot be read means no token, and
// therefore — as the prompt says — no result file: the worker says so and ends its turn.
//
// THE TRANSCRIPT (`<configDir>/projects/<cwd, encoded>/<sessionId>.jsonl`) gets a user row at
// the start and an end_turn assistant row whenever a turn ends. A `result-done` / `result-error`
// scenario can also ask for what a real transcript holds by the time the result file exists —
// the Write call's assistant row with its `message.model`, padding before it, sidechain or raw
// rows after it: `transcriptModel`, `transcriptPadBytes`, `transcriptRows` (see
// transcriptBeforeResult). Without them the transcript is what it has always been.

import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ARGV = process.argv.slice(2);
/** Ties an invocation's log record to its exit record (a pid can be recycled; this cannot). */
const INVOCATION = crypto.randomUUID();

const EXIT_UNSUPPORTED = 2;
const EXIT_NO_SANDBOX = 97;
const EXIT_INTERNAL = 98;

/** Every scenario name `--bg` understands. The first nine are the ones contract §9 lists. */
const BG_SCENARIOS = [
  'result-done',
  'result-error',
  'park-no-result',
  'park-waiting',
  'wrong-token',
  'die',
  'never',
  'untrusted',
  'bypass-refused',
  // Extras for the §F "result file rejected" row; not used by M1–M16.
  'wrong-task-id',
  'not-json',
  'oversize',
  // The three ways a worker gets the token wrong without altering it: it copies the stand-in
  // the prompt shows, it copies the whole first line of the task file, or it leaves the member
  // out.
  'placeholder-token',
  'header-line-token',
  'no-token',
  // A well-formed result with the RIGHT token — reachable only through a symbolic link at the
  // result path. The reader must refuse the link, whatever it points at.
  'symlink-result',
];

/** What the bootstrap prompt's JSON template shows where the token goes, if it cannot be parsed out. */
const TOKEN_STAND_IN_FALLBACK = '<the value from the first line of your task file>';

const TIMING_DEFAULTS = {
  /** Worker "thinks" this long before it writes its result file. */
  resultDelayMs: 150,
  /** Then this long before its turn ends (status idle / waiting). */
  parkDelayMs: 150,
  /** `die`: lifetime before the helper exits without a result. */
  dieAfterMs: 2500,
  /** Delay between `--bg` returning and the session-registry entry appearing. */
  entryDelayMs: 0,
  /** Safety net: a helper nobody stopped ends itself after this long. */
  maxLifetimeMs: 600_000,
  /** How long `--bg` waits for its helper to register before giving up. */
  registerTimeoutMs: 8000,
};

/* ------------------------------------------------------------------------- *
 * Small utilities
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fatal(code, message) {
  try {
    fs.writeSync(2, `fake-claude2: ${message}\n`);
  } catch {
    // stderr already gone — the exit code still tells the story
  }
  process.exit(code);
}

function readJson(file) {
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

function isPidAlive(pid) {
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

/** Realpath of the deepest existing ancestor, with the missing tail re-attached. */
function canon(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return path.resolve(p);
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(p, root) {
  const rel = path.relative(canon(root), canon(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Write to a stream and exit only once the bytes are flushed (pipe writes are async). */
function writeThenExit(stream, text, code) {
  if (text === '') {
    process.exit(code);
  }
  stream.write(text, () => process.exit(code));
}

/* ------------------------------------------------------------------------- *
 * Scenario, sandbox, logging
 * ------------------------------------------------------------------------- */

function loadScenario() {
  const file = process.env.FAKE_CLAUDE2_SCENARIO;
  if (typeof file !== 'string' || file === '') {
    fatal(EXIT_NO_SANDBOX, 'FAKE_CLAUDE2_SCENARIO is not set; refusing to run outside a harness sandbox.');
  }
  const raw = readJson(file);
  if (!isObj(raw)) {
    fatal(EXIT_NO_SANDBOX, `scenario file ${file} is missing or is not a JSON object; refusing to run.`);
  }
  const sandboxRoot =
    typeof raw.sandboxRoot === 'string' && path.isAbsolute(raw.sandboxRoot)
      ? raw.sandboxRoot
      : path.dirname(path.resolve(file));
  return {
    file,
    raw,
    sandboxRoot,
    logFile: typeof raw.logFile === 'string' ? raw.logFile : path.join(sandboxRoot, 'fake2.log.jsonl'),
    pidDir: typeof raw.pidDir === 'string' ? raw.pidDir : path.join(sandboxRoot, 'pids'),
  };
}

const SC = loadScenario();

/** The config directory, resolved as the real CLI resolves it (contract P1). */
function resolveConfigDir() {
  const explicit = process.env.CLAUDE_CONFIG_DIR;
  if (typeof explicit === 'string' && explicit !== '') {
    return { dir: explicit, source: 'env', accountFile: path.join(explicit, '.claude.json') };
  }
  const home = process.env.HOME || os.homedir();
  return { dir: path.join(home, '.claude'), source: 'default', accountFile: path.join(home, '.claude.json') };
}

const CONFIG = resolveConfigDir();

class SandboxGone extends Error {}

/**
 * `mkdir -p` that can never RE-CREATE a sandbox that is being removed.
 *
 * A `claude stop` the server fires at session end is detached and outlives it, so it can start
 * while the harness is deleting the sandbox. A recursive mkdir from such a late process would
 * quietly put the sandbox root back on disk after cleanup. Here each missing level is created
 * with a NON-recursive mkdir beneath a directory that still exists inside the sandbox; once
 * the root is gone there is no such directory, and the fake stops instead.
 */
function mkdirp(dir) {
  const missing = [];
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur)) {
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  if (!fs.existsSync(SC.sandboxRoot) || !isInside(cur, SC.sandboxRoot)) {
    throw new SandboxGone(`the sandbox root ${SC.sandboxRoot} no longer exists`);
  }
  for (const d of missing.reverse()) {
    try {
      fs.mkdirSync(d);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new SandboxGone(`the sandbox was removed while creating ${d}`);
      }
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }
  }
}

function appendLog(record) {
  try {
    // No mkdir: the log lives in the sandbox, and a log write must never bring a removed
    // sandbox back.
    fs.appendFileSync(SC.logFile, JSON.stringify(record) + '\n');
  } catch {
    // The log is evidence, never a dependency: a fake that died because it could not log
    // would turn a harness cleanup race into a spurious CLI failure.
  }
}

/** One record per invocation: what we were asked, and the environment we were asked in. */
function logInvocation(kind, extra = {}) {
  appendLog({
    ts: Date.now(),
    inv: INVOCATION,
    pid: process.pid,
    ppid: process.ppid,
    kind,
    argv: ARGV,
    cwd: process.cwd(),
    env: { ...process.env },
    configDir: CONFIG.dir,
    configDirSource: CONFIG.source,
    ...extra,
  });
}

function logExit(code, extra = {}) {
  appendLog({ ts: Date.now(), inv: INVOCATION, pid: process.pid, kind: 'exit', code, ...extra });
}

/** Log the exit code, then leave through `writeThenExit`. */
function finish(code, { stdout = '', stderr = '', extra = {} } = {}) {
  logExit(code, extra);
  if (stderr !== '') {
    process.stderr.write(stderr, () => writeThenExit(process.stdout, stdout, code));
  } else {
    writeThenExit(process.stdout, stdout, code);
  }
}

if (!isInside(CONFIG.dir, SC.sandboxRoot)) {
  appendLog({
    ts: Date.now(),
    pid: process.pid,
    kind: 'sandbox-violation',
    argv: ARGV,
    configDir: CONFIG.dir,
    configDirSource: CONFIG.source,
    sandboxRoot: SC.sandboxRoot,
  });
  fatal(
    EXIT_NO_SANDBOX,
    `resolved config dir ${CONFIG.dir} (${CONFIG.source}) is outside the sandbox root ${SC.sandboxRoot}; refusing to run.`,
  );
}

const STATE_DIR = path.join(CONFIG.dir, 'fake-claude2');
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const REMOVED_DIR = path.join(STATE_DIR, 'removed');
const SESSIONS_DIR = path.join(CONFIG.dir, 'sessions');

/** Let the harness find (and kill) every process this fake ever started. */
function registerSelf(kind) {
  const file = path.join(SC.pidDir, String(process.pid));
  try {
    mkdirp(SC.pidDir);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind, startedAt: Date.now() }));
  } catch {
    // best effort — the harness also knows helper pids from the job files
  }
  process.on('exit', () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // already removed with the sandbox
    }
  });
}

/** Atomic cross-process counter (mkdir is atomic): 0, 1, 2 … per counter name. */
function nextSeq(counter) {
  const dir = path.join(SC.sandboxRoot, '.fake2-seq');
  mkdirp(dir);
  for (let n = 0; n < 100_000; n++) {
    try {
      fs.mkdirSync(path.join(dir, `${counter}-${n}`));
      return n;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }
  }
  throw new Error('sequence counter exhausted');
}

/** Basename of the config dir — the scenario's per-account key. */
function accountKey() {
  return path.basename(CONFIG.dir.replace(/[/\\]+$/, ''));
}

/* ------------------------------------------------------------------------- *
 * Argument parsing — close enough to the real CLI to reproduce P8
 * ------------------------------------------------------------------------- */

const ALIASES = {
  '-v': '--version',
  '--print': '-p',
  '--worktree': '-w',
  '--allowed-tools': '--allowedTools',
  '--disallowed-tools': '--disallowedTools',
  '-n': '--name',
};
const VALUE_OPTS = new Set([
  '--model',
  '--permission-mode',
  '--settings',
  '--name',
  '--output-format',
  '--input-format',
  '--append-system-prompt',
  '--system-prompt',
  '--max-turns',
  '--session-id',
  '--fallback-model',
  '--discard-unpushed',
]);
/**
 * VARIADIC options swallow every following token until the next one that starts with `-`.
 * This is the P8 footgun: a positional prompt placed directly after `--allowedTools` becomes
 * part of the tool list and the session starts with no prompt at all.
 */
const VARIADIC_OPTS = new Set(['--allowedTools', '--disallowedTools', '--add-dir']);
const OPTIONAL_VALUE_OPTS = new Set(['-w']);
const FLAG_OPTS = new Set(['--bg', '-p', '--verbose', '--version', '--json', '--all', '--dangerously-skip-permissions']);

function parseArgs(argv) {
  const out = { flags: [], values: {}, lists: {}, positionals: [], unknown: [] };
  let i = 0;
  while (i < argv.length) {
    let tok = argv[i];
    let inline;
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      inline = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    }
    const opt = ALIASES[tok] ?? tok;
    if (VALUE_OPTS.has(opt)) {
      if (inline !== undefined) {
        out.values[opt] = inline;
        i += 1;
      } else {
        out.values[opt] = argv[i + 1];
        i += 2;
      }
      continue;
    }
    if (VARIADIC_OPTS.has(opt)) {
      const list = out.lists[opt] ?? (out.lists[opt] = []);
      if (inline !== undefined) {
        list.push(inline);
      }
      i += 1;
      while (i < argv.length && !argv[i].startsWith('-')) {
        list.push(argv[i]);
        i += 1;
      }
      continue;
    }
    if (OPTIONAL_VALUE_OPTS.has(opt)) {
      if (inline !== undefined) {
        out.values[opt] = inline;
        i += 1;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        out.values[opt] = argv[i + 1];
        i += 2;
      } else {
        out.values[opt] = '';
        i += 1;
      }
      continue;
    }
    if (FLAG_OPTS.has(opt)) {
      out.flags.push(opt);
      i += 1;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      out.unknown.push(argv[i]);
      i += 1;
      continue;
    }
    out.positionals.push(argv[i]);
    i += 1;
  }
  return out;
}

/** P13: aliases and well-formed full ids are accepted; anything else exits 1. */
function modelAccepted(model) {
  if (model === undefined) {
    return true;
  }
  if (typeof model !== 'string') {
    return false;
  }
  return /^(opus|sonnet|fable|haiku|default|opusplan)(\[1m\])?$/i.test(model) || /^claude-[a-z0-9][a-z0-9.-]*(\[1m\])?$/i.test(model);
}

/* ------------------------------------------------------------------------- *
 * Bootstrap-prompt parsing (contract §4.6)
 * ------------------------------------------------------------------------- */

/**
 * Pull the task file, the result file and the task id out of the bootstrap prompt, and the
 * result token off the FIRST LINE of the task file. Each value records WHERE it was found, so a
 * probe (or the self-test) can tell a prompt that names them from one that only works through
 * the `--add-dir` fallback — and a token that came from line 1 from one that did not.
 */
function parseBootstrapPrompt(prompt, addDirs = []) {
  const info = { empty: typeof prompt !== 'string' || prompt.trim() === '', from: {} };
  const text = typeof prompt === 'string' ? prompt : '';

  const taskFile = /Read the file `([^`]+)`/.exec(text);
  if (taskFile) {
    info.taskFile = taskFile[1];
    info.from.taskFile = 'prompt';
  }
  const resultFile = /write the absolute path `([^`]+)`/i.exec(text) ?? /`(\/[^`]*result\.json)`/.exec(text);
  if (resultFile) {
    info.resultFile = resultFile[1];
    info.from.resultFile = 'prompt';
  }
  // What the JSON template shows where the token goes. It is a STAND-IN, never the token: kept
  // only because the `placeholder-token` scenario writes exactly this, as a confused worker would.
  const jsonToken = /"token"\s*:\s*"([^"]*)"/.exec(text);
  if (jsonToken) {
    info.promptTokenTemplate = jsonToken[1];
  }
  const jsonTask = /"taskId"\s*:\s*"([^"]+)"/.exec(text);
  const proseTask = /\(task id ([^\s)]+)\)/.exec(text);
  if (jsonTask) {
    info.taskId = jsonTask[1];
    info.from.taskId = 'prompt-json';
  } else if (proseTask) {
    info.taskId = proseTask[1];
    info.from.taskId = 'prompt-prose';
  }
  const cap = /reads up to (\d+) bytes/.exec(text);
  if (cap) {
    info.resultMaxBytes = Number(cap[1]);
  }

  // Fallbacks through the granted io directory. They keep a scenario playable when the
  // prompt wording drifts, and `from` makes the drift visible instead of silent.
  const ioDir = addDirs.length > 0 ? addDirs[0] : undefined;
  if (ioDir !== undefined) {
    if (info.resultFile === undefined) {
      info.resultFile = path.join(ioDir, 'result.json');
      info.from.resultFile = 'add-dir';
    }
    if (info.taskFile === undefined) {
      info.taskFile = path.join(ioDir, 'task.md');
      info.from.taskFile = 'add-dir';
    }
    if (info.taskId === undefined) {
      info.taskId = path.basename(ioDir);
      info.from.taskId = 'add-dir';
    }
  }
  if (info.taskFile !== undefined) {
    let body = '';
    try {
      body = fs.readFileSync(info.taskFile, 'utf8');
      info.taskFileReadable = true;
    } catch {
      info.taskFileReadable = false;
    }
    // THE TOKEN: the first line of the task file, and nothing else in it.
    const nl = body.indexOf('\n');
    const firstLine = (nl === -1 ? body : body.slice(0, nl)).replace(/\r$/, '');
    info.taskFileFirstLine = firstLine.slice(0, 400);
    const header = /^<!-- cco-io-token: ([0-9a-f]+) -->$/.exec(firstLine);
    if (header) {
      info.token = header[1];
      info.taskFileToken = header[1];
      info.from.token = 'task-file-line-1';
    }
    // Lines of the same shape further down are the task's own text. Counted, never read.
    const rest = nl === -1 ? '' : body.slice(nl + 1);
    info.taskFileOtherTokenLines = (rest.match(/^<!-- cco-io-token: .*-->\s*$/gm) ?? []).length;
  }
  // The prompt is an argv element, visible in the process table: it must not carry the token.
  info.promptCarriesToken = typeof info.token === 'string' && info.token !== '' && text.includes(info.token);
  if (info.resultFile !== undefined) {
    info.resultInAddDir = addDirs.some((d) => isInside(info.resultFile, d));
  }
  return info;
}

/* ------------------------------------------------------------------------- *
 * Scenario selection for one `--bg` spawn
 * ------------------------------------------------------------------------- */

function pickBgScenario(seq) {
  const bg = isObj(SC.raw.bg) ? SC.raw.bg : {};
  let spec;
  if (Array.isArray(bg.sequence) && seq < bg.sequence.length) {
    spec = bg.sequence[seq];
  } else if (isObj(bg.byAccount) && bg.byAccount[accountKey()] !== undefined) {
    spec = bg.byAccount[accountKey()];
  } else {
    spec = bg.default ?? 'result-done';
  }
  if (typeof spec === 'string') {
    spec = { kind: spec };
  }
  if (!isObj(spec) || !BG_SCENARIOS.includes(spec.kind)) {
    throw new Error(`scenario names an unknown --bg kind: ${JSON.stringify(spec)}`);
  }
  return {
    ...TIMING_DEFAULTS,
    ...(isObj(SC.raw.timing) ? SC.raw.timing : {}),
    waitingFor: typeof SC.raw.waitingFor === 'string' ? SC.raw.waitingFor : 'fake2: approval needed to continue',
    dieLeavesEntry: SC.raw.dieLeavesEntry !== false,
    transcript: SC.raw.transcript !== false,
    ...spec,
  };
}

/** Nearest ancestor of `dir` that holds a `.git` (file or directory), or undefined. */
function gitRootOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return undefined;
    }
    cur = parent;
  }
}

function git(cwd, args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) {
      delete env[name];
    }
  }
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, timeout: 15_000 });
  return { ok: res.status === 0, out: String(res.stdout ?? '').trim(), err: String(res.stderr ?? '').trim() };
}

/** P9: is this workspace root trusted in the account's `.claude.json`? Read-only. */
function workspaceTrusted(root) {
  const cfg = readJson(CONFIG.accountFile);
  return isObj(cfg) && isObj(cfg.projects) && isObj(cfg.projects[root]) && cfg.projects[root].hasTrustDialogAccepted === true;
}

/* ------------------------------------------------------------------------- *
 * `--version`
 * ------------------------------------------------------------------------- */

function versionText() {
  return typeof SC.raw.version === 'string' ? SC.raw.version : '2.1.283 (Claude Code)';
}

function versionNumber() {
  const m = /(\d+\.\d+\.\d+)/.exec(versionText());
  return m ? m[1] : '2.1.283';
}

function versionMain() {
  registerSelf('version');
  logInvocation('version');
  if (SC.raw.versionExitCode !== undefined && SC.raw.versionExitCode !== 0) {
    finish(Number(SC.raw.versionExitCode), { stderr: 'fake-claude2: --version failure requested by the scenario\n' });
    return;
  }
  finish(0, { stdout: versionText() + '\n' });
}

/* ------------------------------------------------------------------------- *
 * `--bg` — the launcher half
 * ------------------------------------------------------------------------- */

async function bgMain(args) {
  registerSelf('bg');
  const seq = nextSeq('bg');
  const spec = pickBgScenario(seq);
  const sessionId = crypto.randomUUID();
  const jobId = sessionId.slice(0, 8);
  const name = args.values['--name'] ?? `session-${jobId}`;
  const model = args.values['--model'];
  const permissionMode = args.values['--permission-mode'] ?? 'default';
  const addDirs = args.lists['--add-dir'] ?? [];
  const allowedTools = args.lists['--allowedTools'] ?? [];
  const worktreeName = args.values['-w'];
  const settingsRaw = args.values['--settings'];
  let settings;
  if (typeof settingsRaw === 'string') {
    try {
      settings = JSON.parse(settingsRaw);
    } catch {
      settings = undefined;
    }
  }
  const prompt = args.positionals.join(' ');
  const promptInfo = parseBootstrapPrompt(prompt, addDirs);
  const launchCwd = process.cwd();
  const gitRoot = gitRootOf(launchCwd);
  const trustRoot = gitRoot ?? launchCwd;

  const parsed = {
    model,
    permissionMode,
    addDirs,
    addDirsExist: addDirs.map((d) => fs.existsSync(d)),
    allowedTools,
    worktreeName,
    settingsRaw,
    settings,
    name,
    prompt,
    positionals: args.positionals.length,
    unknownOptions: args.unknown,
    // P8: more than one token in the tool list means something was swallowed into it.
    swallowedIntoAllowedTools: allowedTools.length > 1 ? allowedTools.slice(1) : [],
  };
  logInvocation('bg', { seq, scenario: spec.kind, spec, jobId, sessionId, parsed, promptInfo, gitRoot, trustRoot });

  // --- refusals, in the order the real CLI reaches them ----------------------------------
  if (!modelAccepted(model)) {
    finish(1, { stderr: `error: unknown model ${JSON.stringify(model)}\n`, extra: { refused: 'unknown-model' } });
    return;
  }
  // P5: a `--bg` session in bypassPermissions is refused until the disclaimer was accepted
  // interactively. That is the real CLI's standing behaviour, so it is the default here too;
  // a scenario can declare the disclaimer accepted.
  if (permissionMode === 'bypassPermissions' && SC.raw.bypassDisclaimerAccepted !== true) {
    finish(1, {
      stderr:
        '--bg with bypassPermissions requires accepting the disclaimer first. Run `claude ' +
        '--permission-mode bypassPermissions` once in a terminal and accept it, then retry.\n',
      extra: { refused: 'bypass-disclaimer' },
    });
    return;
  }
  if (spec.kind === 'untrusted' || (SC.raw.enforceTrust === true && !workspaceTrusted(trustRoot))) {
    finish(1, {
      stderr: `Workspace not trusted. Run \`claude\` in ${trustRoot} once and accept the trust prompt, then retry.\n`,
      extra: { refused: 'workspace-untrusted' },
    });
    return;
  }

  // --- worktree (P6) ----------------------------------------------------------------------
  let worktree = null;
  let sessionCwd = launchCwd;
  if (worktreeName !== undefined) {
    if (gitRoot === undefined) {
      finish(1, { stderr: 'error: --worktree requires a git repository\n', extra: { refused: 'worktree-no-repo' } });
      return;
    }
    const wtName = worktreeName !== '' ? worktreeName : `wt-${jobId}`;
    const wtPath = path.join(gitRoot, '.claude', 'worktrees', wtName);
    const branch = `worktree-${wtName}`;
    // Without `worktree.baseRef: "head"` the real CLI branches from the REMOTE default
    // branch; with it, from the local HEAD.
    const wantsHead = isObj(settings) && isObj(settings.worktree) && settings.worktree.baseRef === 'head';
    let baseRef = 'HEAD';
    if (!wantsHead && git(gitRoot, ['rev-parse', '--verify', '--quiet', 'origin/HEAD']).ok) {
      baseRef = 'origin/HEAD';
    }
    if (!fs.existsSync(wtPath)) {
      mkdirp(path.dirname(wtPath));
      const made = git(gitRoot, ['worktree', 'add', '-q', '-b', branch, wtPath, baseRef]);
      if (!made.ok) {
        finish(1, { stderr: `error: could not create worktree ${wtName}: ${made.err}\n`, extra: { refused: 'worktree-failed' } });
        return;
      }
    }
    worktree = {
      name: wtName,
      path: wtPath,
      branch,
      baseRef,
      baseRefRequested: wantsHead ? 'head' : 'fresh',
      baseCommit: git(wtPath, ['rev-parse', 'HEAD']).out,
    };
    sessionCwd = wtPath;
  }

  // --- the worker session -------------------------------------------------------------------
  mkdirp(JOBS_DIR);
  const jobFile = path.join(JOBS_DIR, `${jobId}.json`);
  const liveBefore = listJobs().some((j) => isPidAlive(j.pid));
  writeJsonAtomic(jobFile, {
    jobId,
    sessionId,
    name,
    configDir: CONFIG.dir,
    configDirSource: CONFIG.source,
    launchCwd,
    cwd: sessionCwd,
    worktree,
    model: model ?? null,
    permissionMode,
    addDirs,
    version: versionNumber(),
    startedAt: Date.now(),
    spec,
    prompt,
    promptInfo,
    pid: null,
    registered: false,
    status: null,
    history: [],
  });

  // stdio is 'ignore' so the launcher's pipes close when it exits. `holdPipes` reproduces
  // P16 instead: the helper inherits stdout/stderr, so a wrapper waiting for 'close' never
  // settles while the session lives.
  const stdio = spec.holdPipes === true ? ['ignore', 'inherit', 'inherit'] : 'ignore';
  const child = spawn(process.execPath, [SELF, '__worker', jobFile], {
    cwd: sessionCwd,
    env: process.env,
    detached: true,
    stdio,
  });
  child.unref();

  const deadline = Date.now() + spec.registerTimeoutMs;
  let registered = false;
  while (Date.now() < deadline) {
    const job = readJson(jobFile);
    if (isObj(job) && job.registered === true) {
      registered = true;
      break;
    }
    await sleep(15);
  }
  if (!registered) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // never started
    }
    finish(1, { stderr: 'error: the background session did not start\n', extra: { refused: 'helper-timeout' } });
    return;
  }
  finish(0, {
    // P8: stderr MAY carry the service banner; stdout carries the line the caller parses.
    stderr: liveBefore || SC.raw.serviceBanner === false ? '' : 'Starting background service…\n',
    stdout: `backgrounded · ${jobId} · ${name}\n`,
    extra: { jobId, helperPid: child.pid },
  });
}

/* ------------------------------------------------------------------------- *
 * `--bg` — the worker helper (`__worker <job file>`)
 * ------------------------------------------------------------------------- */

async function workerMain(jobFile) {
  registerSelf('worker');
  const job = readJson(jobFile);
  if (!isObj(job)) {
    fatal(EXIT_INTERNAL, `worker helper could not read its job file ${jobFile}`);
  }
  const spec = job.spec;
  const info = job.promptInfo ?? {};
  const entryFile = path.join(SESSIONS_DIR, `${process.pid}.json`);
  let entry = null;
  let exiting = false;

  const updateJob = (fn) => {
    try {
      const cur = readJson(jobFile);
      if (!isObj(cur)) {
        return;
      }
      fn(cur);
      writeJsonAtomic(jobFile, cur);
    } catch {
      // the sandbox is being torn down under us — nothing left to record
    }
  };
  const note = (event, extra = {}) =>
    updateJob((j) => {
      j.history.push({ ts: Date.now(), event, ...extra });
    });
  const writeEntry = (patch) => {
    entry = { ...(entry ?? {}), ...patch, updatedAt: Date.now() };
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) {
        delete entry[key];
      }
    }
    mkdirp(SESSIONS_DIR);
    writeJsonAtomic(entryFile, entry);
    updateJob((j) => {
      j.status = entry.status;
    });
  };
  const removeEntry = () => {
    try {
      fs.unlinkSync(entryFile);
    } catch {
      // never written, or already gone
    }
  };
  /** A clean end (stop / SIGTERM / lifetime): the entry goes away, as it does for the CLI. */
  const exitClean = (reason, code) => {
    if (exiting) {
      return;
    }
    exiting = true;
    removeEntry();
    updateJob((j) => {
      j.exitedAt = Date.now();
      j.exit = reason;
      j.status = 'gone';
    });
    process.exit(code);
  };
  process.on('SIGTERM', () => exitClean('sigterm', 143));
  process.on('SIGINT', () => exitClean('sigint', 130));
  process.on('SIGHUP', () => {});

  // Register FIRST, so `--bg` can return: the real launcher returns before the session's
  // registry entry is guaranteed to exist, and `entryDelayMs` widens that window on demand.
  updateJob((j) => {
    j.pid = process.pid;
    j.registered = true;
    j.status = 'starting';
  });
  if (spec.entryDelayMs > 0) {
    await sleep(spec.entryDelayMs);
  }
  writeEntry({
    pid: process.pid,
    sessionId: job.sessionId,
    jobId: job.jobId,
    name: job.name,
    kind: 'bg',
    peerProtocol: 1,
    version: job.version,
    cwd: job.cwd,
    status: 'busy',
    startedAt: job.startedAt,
    messagingSocketPath: path.join(STATE_DIR, 'sockets', `${job.jobId}.sock`),
  });
  note('entry-written');

  /* --- transcript: what survives when nothing else does ---------------------------------- */
  const transcriptFile = path.join(
    CONFIG.dir,
    'projects',
    String(job.cwd).replace(/[^a-zA-Z0-9]/g, '-'),
    `${job.sessionId}.jsonl`,
  );
  const transcriptRow = (row) => {
    if (spec.transcript === false) {
      return;
    }
    try {
      mkdirp(path.dirname(transcriptFile));
      fs.appendFileSync(
        transcriptFile,
        JSON.stringify({
          uuid: crypto.randomUUID(),
          sessionId: job.sessionId,
          cwd: job.cwd,
          timestamp: new Date().toISOString(),
          isSidechain: false,
          sessionKind: 'bg',
          version: job.version,
          ...row,
        }) + '\n',
      );
    } catch {
      // evidence only
    }
  };
  transcriptRow({ type: 'user', message: { role: 'user', content: job.prompt } });
  /** A line written as given — no line feed added — for a torn or hostile last line. */
  const transcriptRaw = (text) => {
    if (spec.transcript === false) {
      return;
    }
    try {
      mkdirp(path.dirname(transcriptFile));
      fs.appendFileSync(transcriptFile, text);
    } catch {
      // evidence only
    }
  };
  /**
   * What a real worker's transcript holds by the time its result file exists: the assistant
   * row of the Write call, carrying `message.model` as the CLI writes it on every assistant
   * row. Only when the scenario asks — `transcriptModel` (any JSON value; written as given),
   * `transcriptPadBytes` (that many bytes of attachment rows BEFORE it) and `transcriptRows`
   * (rows AFTER it: an object is a row, merged over the defaults so it can say
   * `isSidechain: true`; a string is appended verbatim) — so every other scenario's transcript
   * is what it always was.
   */
  const transcriptBeforeResult = (o) => {
    if (Number.isInteger(o.transcriptPadBytes) && o.transcriptPadBytes > 0) {
      const ROW = 64 * 1024;
      for (let left = o.transcriptPadBytes; left > 0; left -= ROW) {
        transcriptRow({ type: 'attachment', attachment: { type: 'fake2-padding', content: 'p'.repeat(Math.max(0, Math.min(left, ROW) - 320)) } });
      }
    }
    if (o.transcriptModel !== undefined) {
      transcriptRow({
        type: 'assistant',
        message: {
          model: o.transcriptModel,
          id: 'msg_fake2',
          type: 'message',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_fake2', name: 'Write', input: { file_path: info.resultFile } }],
        },
      });
    }
    for (const row of Array.isArray(o.transcriptRows) ? o.transcriptRows : []) {
      if (typeof row === 'string') {
        transcriptRaw(row);
      } else if (isObj(row)) {
        transcriptRow(row);
      }
    }
  };

  /* --- the acts --------------------------------------------------------------------------- */
  const endTurn = (status, waitingFor, finalText) => {
    transcriptRow({
      type: 'assistant',
      message: {
        ...(spec.transcriptModel !== undefined ? { model: spec.transcriptModel } : {}),
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: finalText }],
      },
    });
    // Stamped BEFORE the entry changes, so `parkedAt` is never later than the moment a reader
    // could first see the parked status: "settled N ms after the worker parked" then errs
    // only on the long side, however slowly this process is scheduled.
    const parkedAt = Date.now();
    writeEntry({ status, waitingFor: status === 'waiting' ? waitingFor : undefined });
    updateJob((j) => {
      j.parkedAt = parkedAt;
      j.history.push({ ts: parkedAt, event: 'turn-ended', status, ...(status === 'waiting' ? { waitingFor } : {}) });
    });
  };
  const startTurn = () => {
    if (entry !== null && entry.status !== 'busy') {
      writeEntry({ status: 'busy', waitingFor: undefined });
      note('turn-started');
    }
  };
  const writeResultFile = (content, label) => {
    const file = info.resultFile;
    if (typeof file !== 'string') {
      note('result-not-written', { reason: 'the bootstrap prompt named no result path and no --add-dir was given' });
      return false;
    }
    try {
      fs.writeFileSync(file, content);
      updateJob((j) => {
        j.resultWrittenAt = Date.now();
        j.resultKind = label;
        j.history.push({ ts: j.resultWrittenAt, event: 'result-written', label, file, bytes: Buffer.byteLength(content) });
      });
      return true;
    } catch (e) {
      note('result-write-failed', { label, file, error: e.message });
      return false;
    }
  };
  const resultJson = (status, overrides = {}) => {
    const report = typeof spec.report === 'string' ? spec.report : `FAKE2_REPORT ${status} task=${info.taskId} worker=${job.name} job=${job.jobId}`;
    return JSON.stringify({ taskId: info.taskId, status, report, token: info.token, ...overrides });
  };
  /**
   * The protocol's branch for a task file that cannot be read: there is no task and no token, so
   * no result file is written — the worker says what it could not read and ends its turn.
   */
  const taskUnreadable = () => {
    if (info.taskFileReadable !== false) {
      return false;
    }
    note('no-result', { reason: 'the task file is missing or unreadable', taskFile: info.taskFile });
    endTurn('idle', undefined, `FAKE2_TRANSCRIPT the task file ${info.taskFile} is missing or unreadable, so there is no task and no result token: no result file was written.`);
    return true;
  };
  const editWorkingTree = () => {
    if (!isObj(spec.writeFile) || typeof spec.writeFile.name !== 'string') {
      return;
    }
    try {
      const target = path.join(job.cwd, path.basename(spec.writeFile.name));
      fs.writeFileSync(target, String(spec.writeFile.content ?? 'edited by fake-claude2\n'));
      note('file-edited', { file: target });
    } catch (e) {
      note('file-edit-failed', { error: e.message });
    }
  };

  const act = async (kind, knobs = {}) => {
    const o = { ...spec, ...knobs };
    note('act', { kind });
    startTurn();
    switch (kind) {
      case 'result-done':
      case 'result-error': {
        const status = kind === 'result-done' ? 'done' : 'error';
        await sleep(o.resultDelayMs);
        if (taskUnreadable()) {
          return;
        }
        editWorkingTree();
        transcriptBeforeResult(o);
        writeResultFile(resultJson(status), status);
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, `FAKE2_TRANSCRIPT ${kind}: the result file is written; this session is idle.`);
        return;
      }
      case 'wrong-token': {
        await sleep(o.resultDelayMs);
        const real = typeof info.token === 'string' ? info.token : '';
        const bogus = (real.startsWith('0') ? '1' : '0') + real.slice(1) || 'not-the-token';
        writeResultFile(resultJson('done', { token: bogus }), 'wrong-token');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT wrong-token: wrote a result with an altered token, then stopped.');
        return;
      }
      case 'placeholder-token': {
        // The stand-in the prompt's JSON template shows, copied where the value belongs.
        await sleep(o.resultDelayMs);
        writeResultFile(resultJson('done', { token: info.promptTokenTemplate ?? TOKEN_STAND_IN_FALLBACK }), 'placeholder-token');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT placeholder-token: wrote a result carrying the stand-in from the instructions, then stopped.');
        return;
      }
      case 'header-line-token': {
        // The whole first line of the task file — comment markers, label and all.
        await sleep(o.resultDelayMs);
        writeResultFile(resultJson('done', { token: info.taskFileFirstLine ?? `<!-- cco-io-token: ${info.token} -->` }), 'header-line-token');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT header-line-token: wrote a result carrying the whole token line, then stopped.');
        return;
      }
      case 'no-token': {
        await sleep(o.resultDelayMs);
        const body = JSON.parse(resultJson('done'));
        delete body.token;
        writeResultFile(JSON.stringify(body), 'no-token');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT no-token: wrote a result with no token member, then stopped.');
        return;
      }
      case 'symlink-result': {
        await sleep(o.resultDelayMs);
        const file = info.resultFile;
        const real = `${file}.real`;
        try {
          fs.writeFileSync(real, resultJson('done'));
          fs.rmSync(file, { force: true });
          fs.symlinkSync(real, file);
          updateJob((j) => {
            j.resultWrittenAt = Date.now();
            j.resultKind = 'symlink-result';
            j.history.push({ ts: j.resultWrittenAt, event: 'result-written', label: 'symlink-result', file, target: real });
          });
        } catch (e) {
          note('result-write-failed', { label: 'symlink-result', file, error: e.message });
        }
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT symlink-result: made the result path a link to a well-formed result, then stopped.');
        return;
      }
      case 'wrong-task-id': {
        await sleep(o.resultDelayMs);
        writeResultFile(resultJson('done', { taskId: 'tFAKE2wrongid' }), 'wrong-task-id');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT wrong-task-id: wrote a result naming another task, then stopped.');
        return;
      }
      case 'not-json': {
        await sleep(o.resultDelayMs);
        writeResultFile('FAKE2 this result file is not JSON at all\n', 'not-json');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT not-json: wrote a result that is not JSON, then stopped.');
        return;
      }
      case 'oversize': {
        await sleep(o.resultDelayMs);
        const cap = Number.isFinite(info.resultMaxBytes) ? info.resultMaxBytes : 262_144;
        writeResultFile(resultJson('done', { report: 'FAKE2_OVERSIZE ' + 'x'.repeat(cap + 1024) }), 'oversize');
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT oversize: wrote a result past the read cap, then stopped.');
        return;
      }
      case 'park-no-result': {
        await sleep(o.parkDelayMs);
        endTurn('idle', undefined, 'FAKE2_TRANSCRIPT park-no-result: I have a question before I continue. Which option do you prefer?');
        return;
      }
      case 'park-waiting': {
        await sleep(o.parkDelayMs);
        endTurn('waiting', o.waitingFor, `FAKE2_TRANSCRIPT park-waiting: blocked on ${o.waitingFor}.`);
        return;
      }
      case 'die': {
        await sleep(o.dieAfterMs);
        if (exiting) {
          return;
        }
        exiting = true;
        // A crash leaves the registry entry behind (P3); a tidy exit removes it.
        if (o.dieLeavesEntry === false) {
          removeEntry();
        }
        updateJob((j) => {
          j.exitedAt = Date.now();
          j.exit = 'die';
          j.crashed = true;
          j.status = 'gone';
          j.history.push({ ts: j.exitedAt, event: 'died', entryLeft: o.dieLeavesEntry !== false });
        });
        process.exit(1);
        return;
      }
      case 'impostor': {
        // Control-channel only. The helper stays alive, with its session entry exactly as it
        // was, and stops LOOKING like the CLI: `ps` now shows this title instead of the command
        // line. To anything that reads the process table that is what a recycled pid looks like
        // — the entry still names the pid, and the pid is somebody else.
        process.title = typeof o.title === 'string' && o.title !== '' ? o.title : 'mesh2-impostor';
        note('impostor', { title: process.title });
        return;
      }
      case 'busy':
      case 'never':
        return; // mid-turn until something else happens
      default:
        note('unknown-act', { kind });
    }
  };

  // Control channel for a probe that needs a LIVE worker to change course (`never` now,
  // `result-done` later): `<job file>.cmd` holding `{"kind": "<scenario>", …knobs}`.
  const cmdFile = `${jobFile}.cmd`;
  let acting = Promise.resolve();
  const poll = setInterval(() => {
    if (exiting) {
      return;
    }
    if (!fs.existsSync(jobFile)) {
      // The sandbox (or this job) was removed underneath us: there is nobody left to play to.
      exiting = true;
      removeEntry();
      process.exit(0);
    }
    if (!fs.existsSync(cmdFile)) {
      return;
    }
    let cmd = readJson(cmdFile);
    try {
      fs.unlinkSync(cmdFile);
    } catch {
      return; // another tick took it
    }
    if (typeof cmd === 'string') {
      cmd = { kind: cmd };
    }
    if (!isObj(cmd) || typeof cmd.kind !== 'string') {
      note('bad-command');
      return;
    }
    const { kind, ...knobs } = cmd;
    acting = acting.then(() => act(kind, knobs)).catch((e) => note('act-failed', { kind, error: e.message }));
  }, 40);
  const lifetime = setTimeout(() => exitClean('max-lifetime', 0), spec.maxLifetimeMs);
  void poll;
  void lifetime;

  // P8: a prompt swallowed by a variadic option means the session starts idle with nothing
  // to do — whatever the scenario said.
  const first = info.empty === true ? 'park-no-result' : spec.kind === 'bypass-refused' ? (spec.then ?? 'result-done') : spec.kind;
  if (info.empty === true) {
    note('started-without-prompt');
  }
  acting = acting.then(() => act(first)).catch((e) => note('act-failed', { kind: first, error: e.message }));
}

/* ------------------------------------------------------------------------- *
 * Job bookkeeping shared by stop / rm / agents
 * ------------------------------------------------------------------------- */

function listJobs() {
  let names = [];
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs = [];
  for (const n of names) {
    if (!/^[0-9a-f]{8}\.json$/.test(n)) {
      continue;
    }
    const job = readJson(path.join(JOBS_DIR, n));
    if (isObj(job)) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function findJob(idOrName) {
  const jobs = listJobs();
  return jobs.find((j) => j.jobId === idOrName) ?? jobs.find((j) => j.sessionId === idOrName) ?? jobs.find((j) => j.name === idOrName);
}

/** End a helper: SIGTERM, a short wait, SIGKILL. Returns how it went. */
async function endHelper(job) {
  const pid = job.pid;
  if (!isPidAlive(pid)) {
    return 'already-gone';
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'already-gone';
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return 'terminated';
    }
    await sleep(20);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // raced its own exit
  }
  for (let i = 0; i < 50 && isPidAlive(pid); i++) {
    await sleep(20);
  }
  return 'killed';
}

function markStopped(job, how) {
  const file = path.join(JOBS_DIR, `${job.jobId}.json`);
  const cur = readJson(file);
  if (!isObj(cur)) {
    return;
  }
  cur.stoppedAt = cur.stoppedAt ?? Date.now();
  cur.stopHow = how;
  cur.status = 'gone';
  cur.history = [...(cur.history ?? []), { ts: Date.now(), event: 'stopped', how }];
  writeJsonAtomic(file, cur);
  // A stopped session's registry entry is gone, however the helper ended.
  if (Number.isInteger(cur.pid)) {
    try {
      fs.unlinkSync(path.join(SESSIONS_DIR, `${cur.pid}.json`));
    } catch {
      // already removed by the helper's own exit
    }
  }
}

async function stopMain(args) {
  registerSelf('stop');
  const id = args.positionals[1];
  logInvocation('stop', { id });
  const job = typeof id === 'string' ? findJob(id) : undefined;
  if (!job) {
    finish(1, { stderr: `No background session found matching ${JSON.stringify(id ?? '')}.\n`, extra: { id, outcome: 'unknown-id' } });
    return;
  }
  if (isObj(SC.raw.stop) && SC.raw.stop.fail === true) {
    finish(1, { stderr: `error: could not stop ${job.jobId}\n`, extra: { id, outcome: 'forced-failure' } });
    return;
  }
  const how = await endHelper(job);
  markStopped(job, how);
  finish(0, { stdout: `stopped ${job.jobId}\n`, extra: { id, jobId: job.jobId, outcome: how } });
}

async function rmMain(args) {
  registerSelf('rm');
  const id = args.positionals[1];
  logInvocation('rm', { id, discardUnpushed: args.values['--discard-unpushed'] });
  const job = typeof id === 'string' ? findJob(id) : undefined;
  if (!job) {
    finish(1, { stderr: `No background session found matching ${JSON.stringify(id ?? '')}.\n`, extra: { id, outcome: 'unknown-id' } });
    return;
  }
  if (isPidAlive(job.pid)) {
    markStopped(job, await endHelper(job));
  }
  const mode = typeof SC.raw.rm === 'string' ? SC.raw.rm : 'auto';
  const wt = isObj(job.worktree) ? job.worktree : undefined;
  const wtExists = wt !== undefined && fs.existsSync(wt.path);
  let kept = false;
  let reason = '';
  if (mode === 'kept') {
    kept = true;
    reason = 'forced by the scenario';
  } else if (mode === 'auto' && wtExists) {
    // P7: a plain `rm` never discards work — uncommitted changes or unpushed commits keep
    // the worktree, every time.
    const dirty = git(wt.path, ['status', '--porcelain']);
    const head = git(wt.path, ['rev-parse', 'HEAD']);
    if (!dirty.ok || dirty.out !== '') {
      kept = true;
      reason = 'uncommitted changes';
    } else if (head.ok && wt.baseCommit && head.out !== wt.baseCommit) {
      kept = true;
      reason = 'unpushed commits';
    }
  }
  if (kept) {
    const where = wt !== undefined ? wt.path : job.cwd;
    finish(1, {
      stdout: `kept ${job.jobId} — its worktree is still at ${where} (${reason})\n`,
      extra: { id, jobId: job.jobId, outcome: 'kept', reason },
    });
    return;
  }
  if (wtExists) {
    const root = gitRootOf(job.launchCwd) ?? job.launchCwd;
    git(root, ['worktree', 'remove', '--force', wt.path]);
    git(root, ['branch', '-D', wt.branch]);
  }
  try {
    mkdirp(REMOVED_DIR);
    fs.renameSync(path.join(JOBS_DIR, `${job.jobId}.json`), path.join(REMOVED_DIR, `${job.jobId}.json`));
  } catch {
    // removed concurrently — the outcome is the same
  }
  finish(0, { stdout: `removed ${job.jobId}\n`, extra: { id, jobId: job.jobId, outcome: 'removed' } });
}

/** P10 rows. A LIVE row carries `pid` and `status`; a finished one carries neither. */
function agentsMain(args) {
  registerSelf('agents');
  const all = args.flags.includes('--all');
  logInvocation('agents', { all, json: args.flags.includes('--json') });
  const rows = [];
  for (const job of listJobs()) {
    const base = {
      id: job.jobId,
      sessionId: job.sessionId,
      cwd: job.cwd,
      kind: 'background',
      startedAt: job.startedAt,
      name: job.name,
    };
    if (isPidAlive(job.pid)) {
      const entry = readJson(path.join(SESSIONS_DIR, `${job.pid}.json`));
      const status = isObj(entry) && typeof entry.status === 'string' ? entry.status : 'busy';
      rows.push({
        ...base,
        // `state` is the model-written summary class; `status` is the mechanical truth. The
        // real emitter spreads the live process record into the row, so the entry's own
        // status (and `waitingFor`) pass through verbatim.
        state: status === 'busy' ? 'working' : status === 'waiting' ? 'blocked' : 'done',
        pid: job.pid,
        status,
        ...(isObj(entry) && typeof entry.waitingFor === 'string' ? { waitingFor: entry.waitingFor } : {}),
      });
      continue;
    }
    // A session that died without a clean stop keeps its PERSISTED "working" state, so the
    // real listing still shows it — with no pid. Presence is not liveness; the pid is.
    const crashed = job.crashed === true || (job.stoppedAt === undefined && job.exit === undefined);
    if (crashed && SC.raw.agentsHideCrashed !== true) {
      rows.push({ ...base, state: 'working' });
    } else if (all) {
      rows.push({ ...base, state: 'done' });
    }
  }
  if (!args.flags.includes('--json')) {
    const text = rows.map((r) => `${r.id}  ${r.name}  ${r.state}${r.pid ? `  pid ${r.pid}` : ''}`).join('\n');
    finish(0, { stdout: text === '' ? 'No background sessions.\n' : text + '\n' });
    return;
  }
  finish(0, { stdout: JSON.stringify(rows) + '\n', extra: { rows: rows.length } });
}

/* ------------------------------------------------------------------------- *
 * One-shot surfaces: auth status, usage probe, `-p --output-format json`
 * ------------------------------------------------------------------------- */

function perAccount(section, fallback) {
  const base = isObj(SC.raw[section]) ? SC.raw[section] : {};
  const override = isObj(base.byAccount) && isObj(base.byAccount[accountKey()]) ? base.byAccount[accountKey()] : {};
  const { byAccount: _ignored, ...rest } = base;
  return { ...fallback, ...rest, ...override };
}

function authMain() {
  registerSelf('auth');
  logInvocation('auth');
  const auth = perAccount('auth', { loggedIn: true, email: `fake2-${accountKey()}@example.invalid` });
  const body = auth.loggedIn
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: auth.email, subscriptionType: 'max' }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  finish(auth.loggedIn ? 0 : 1, { stdout: JSON.stringify(body) + '\n' });
}

function usagePayload() {
  const u = perAccount('usage', { available: true, fiveHour: 5, sevenDay: 5, delayMs: 0 });
  const iso = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
  return {
    delayMs: Number(u.delayMs) || 0,
    payload: {
      rate_limits_available: u.available === true,
      subscription_type: 'max',
      rate_limits:
        u.available === true
          ? {
              five_hour: { utilization: u.fiveHour, resets_at: iso(3) },
              seven_day: { utilization: u.sevenDay, resets_at: iso(72) },
              extra_usage: { is_enabled: false, utilization: null },
            }
          : null,
      session: { total_cost_usd: 0 },
    },
  };
}

/** P15: answer one `get_usage` control request; leave on stdin EOF (exit 0) or SIGTERM (143). */
function usageProbeMain() {
  registerSelf('usage');
  logInvocation('usage');
  const { delayMs, payload } = usagePayload();
  process.on('SIGTERM', () => {
    logExit(143);
    process.exit(143);
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(msg) || msg.type !== 'control_request' || !isObj(msg.request) || msg.request.subtype !== 'get_usage') {
      return;
    }
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: msg.request_id, response: payload },
        }) + '\n',
      );
    }, delayMs);
  });
  rl.on('close', () => {
    logExit(0);
    process.exit(0);
  });
  process.stdin.on('error', () => {});
}

const ONESHOT_MARKER = 'FAKE2_ONESHOT_OK';

function oneShotMain(args) {
  registerSelf('oneshot');
  const cfg = perAccount('oneShot', { mode: 'success', delayMs: 0 });
  const model = args.values['--model'];
  logInvocation('oneshot', {
    mode: cfg.mode,
    parsed: { model, permissionMode: args.values['--permission-mode'], outputFormat: args.values['--output-format'] },
  });
  if (!modelAccepted(model)) {
    finish(1, { stderr: `error: unknown model ${JSON.stringify(model)}\n`, extra: { refused: 'unknown-model' } });
    return;
  }
  if (cfg.mode === 'hang') {
    // Ignore stdin EOF; die only on a signal (the caller's timeout / cancel path).
    process.stdin.resume();
    process.stdin.on('data', () => {});
    process.stdin.on('error', () => {});
    setInterval(() => {}, 1 << 30);
    return;
  }
  let stdin = '';
  let fired = false;
  const fire = () => {
    if (fired) {
      return;
    }
    fired = true;
    setTimeout(() => {
      if (cfg.mode === 'fail') {
        finish(3, { stderr: 'fake-claude2: deterministic non-quota failure\n' });
        return;
      }
      if (cfg.mode === 'quota') {
        finish(0, {
          stdout: JSON.stringify({ is_error: true, subtype: 'rate_limit_error', result: 'Rate limit exceeded — usage limit reached (429).' }),
        });
        return;
      }
      finish(0, {
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result:
            typeof cfg.result === 'string'
              ? cfg.result
              : `${ONESHOT_MARKER} model=${model} account=${accountKey()} promptBytes=${Buffer.byteLength(stdin)}`,
          usage: { input_tokens: 11, output_tokens: 22 },
          total_cost_usd: 0.001,
        }),
      });
    }, Number(cfg.delayMs) || 0);
  };
  // Read the prompt to EOF, as the real CLI does, so the caller's stdin.end() completes.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    stdin += d;
  });
  process.stdin.on('end', fire);
  process.stdin.on('error', fire);
  setTimeout(fire, 3000);
}

/* ------------------------------------------------------------------------- *
 * Entry point
 * ------------------------------------------------------------------------- */

/**
 * `__bait` — a live process of this very program that does nothing at all. The harness starts it
 * through a symbolic link NAMED `claude`, so its command line names the CLI: a process that
 * passes every "is this running the CLI?" test and is nobody's worker. It ends when its sandbox
 * is removed, or after ten minutes.
 */
function baitMain() {
  registerSelf('bait');
  setInterval(() => {
    if (!fs.existsSync(SC.sandboxRoot)) {
      process.exit(0);
    }
  }, 200);
  setTimeout(() => process.exit(0), TIMING_DEFAULTS.maxLifetimeMs);
}

async function main() {
  if (ARGV[0] === '__worker') {
    await workerMain(ARGV[1]);
    return;
  }
  if (ARGV[0] === '__bait') {
    baitMain();
    return;
  }
  const args = parseArgs(ARGV);
  if (args.flags.includes('--version')) {
    versionMain();
  } else if (args.flags.includes('--bg')) {
    await bgMain(args);
  } else if (args.positionals[0] === 'stop') {
    await stopMain(args);
  } else if (args.positionals[0] === 'rm') {
    await rmMain(args);
  } else if (args.positionals[0] === 'agents') {
    agentsMain(args);
  } else if (args.positionals[0] === 'auth' && args.positionals[1] === 'status') {
    authMain();
  } else if (args.flags.includes('-p') && args.values['--input-format'] === 'stream-json') {
    usageProbeMain();
  } else if (args.flags.includes('-p')) {
    oneShotMain(args);
  } else {
    registerSelf('unsupported');
    logInvocation('unsupported');
    finish(EXIT_UNSUPPORTED, { stderr: `fake-claude2: unsupported invocation: ${JSON.stringify(ARGV)}\n` });
  }
}

main().catch((err) => {
  if (err instanceof SandboxGone || (err && err.code === 'ENOENT' && !fs.existsSync(SC.sandboxRoot))) {
    // Started while the harness was tearing the sandbox down: nothing to do, nothing to say.
    process.exit(EXIT_NO_SANDBOX);
  }
  appendLog({ ts: Date.now(), pid: process.pid, kind: 'fake-error', argv: ARGV, error: String(err && err.stack ? err.stack : err) });
  fatal(EXIT_INTERNAL, `internal error: ${err && err.message ? err.message : err}`);
});
