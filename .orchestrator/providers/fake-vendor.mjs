// fake-vendor.mjs — the shared implementation behind the three fake vendor CLIs of the
// providers harness (.orchestrator/providers): `codex`, `cursor-agent` and `agy`.
//
// It emulates exactly the surface the published adapters (@toragonite/agent-mesh-codex,
// -cursor, -gemini, 0.1.1) drive, and answers in exactly the shape each adapter parses:
//
//   codex         exec --json [--model M] [--sandbox MODE] … -- <prompt>     JSONL events
//                 exec resume <id> --json … -- <message>
//                 --version | login status
//                 (the adapter's auth probe reads <CODEX_HOME>/auth.json itself — see
//                 helpers.mjs writeCodexAuth; this fake reads the same file to decide
//                 whether a run is "logged in")
//   cursor-agent  -p --output-format json [--trust] [--model M] [--sandbox MODE] … -- <prompt>
//                 status | models | create-chat | --version
//   agy           --output-format json [--model M] [--mode MODE] … -p <prompt>
//                 models | --version
//
// SANDBOX RULE. Nothing here runs unless CCO_PROVIDERS_SCENARIO names a readable scenario
// file that lives in a harness sandbox (a directory carrying the marker file
// `.cco-providers-sandbox`), and HOME, the vendor's home directory and — for a run — the
// working directory are all inside that sandbox. Anything else is refused with exit 97, so
// a harness bug that leaked the real HOME can never make this program act on a real
// `~/.codex`, `~/.cursor` or `~/.agy`, or "edit" a real checkout.
//
// Every invocation appends one record (argv, cwd, the full environment, the resolved home,
// the scenario it acted out) to the scenario's log file, and one exit record. No network,
// no login, no vendor quota — and it never executes anything but itself.

import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

export const SCENARIO_ENV = 'CCO_PROVIDERS_SCENARIO';
export const SANDBOX_MARKER = '.cco-providers-sandbox';
export const EXIT_UNSUPPORTED = 2;
export const EXIT_NO_SANDBOX = 97;
export const EXIT_INTERNAL = 98;

/** A field planted in every success payload; it must never reach a result, an event or a log. */
export const RAW_MARKER = 'HARNESS-RAW-PAYLOAD-MARKER-do-not-relay';

/** Identity the fake `cursor-agent status` prints; a ProviderStatus must never carry it. */
export const CURSOR_IDENTITY = 'harness-cursor-user@example.invalid';

/** Vendor ids as the server names them → the fake's facts. */
export const VENDORS = {
  codex: { cli: 'codex', homeEnv: 'CODEX_HOME', defaultHome: '.codex', version: 'codex-cli 0.145.0' },
  cursor: { cli: 'cursor-agent', homeEnv: null, defaultHome: '.cursor', version: '2026.09.18-9a7762b' },
  gemini: { cli: 'agy', homeEnv: 'AGY_HOME', defaultHome: '.agy', version: '1.1.12' },
};

/**
 * The texts each scenario emits. None of the `error` / `auth` texts may contain one of the
 * WORDS the server's quota classifier looks for (helpers.mjs `QUOTA_CLASSIFIER`, a checked copy
 * of provider-runner's `QUOTA_WORDS`: quota, usage limit, rate limit, limit [has been] reached /
 * exceeded, too many requests, overloaded, out of [extra] usage, "hit / reached / exceeded your
 * … limit") and every `quota` text must — the
 * self-test asserts both. The digits 429 and 529 are no longer part of that: the server reads
 * them only where they are stated as a status, so a text may carry them anywhere else.
 */
export const TEXTS = {
  codex: {
    ok: 'FAKE_CODEX_OK',
    error: 'FAKE_CODEX_ERROR: the model run failed — stream disconnected before completion',
    quota: "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 3 hours 12 minutes.",
    auth: 'Not logged in. Run `codex login` to sign in to your ChatGPT account. (401 Unauthorized)',
  },
  cursor: {
    ok: 'FAKE_CURSOR_OK',
    error: 'FAKE_CURSOR_ERROR: the agent run failed — connection lost during the turn',
    quota: "You've hit your usage limit for this billing cycle. Upgrade your plan or wait until your usage resets.",
    auth: "Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.",
  },
  gemini: {
    ok: 'FAKE_AGY_OK',
    error: 'FAKE_AGY_ERROR: the agent run failed — internal error while executing the step',
    quota: 'RESOURCE_EXHAUSTED: you have exhausted your quota for this model; it resets in 2h31m.',
    auth: 'not signed in: open Antigravity and sign in with your Google account, then retry',
  },
};

/** Token counts a default `ok` run reports. Chosen to contain neither "429" nor "529". */
export const TOKENS = {
  codex: { input: 1234, output: 56, cached: 100 },
  cursor: { input: 2345, output: 67, cached: 300 },
  gemini: { input: 3456, output: 78, cached: 0 },
};

/** Every run scenario. `spawn-grandchild` is `ok` plus a grandchild left in the process group. */
export const RUN_KINDS = [
  'ok',
  'ok-empty-text',
  'ok-blank-text',
  'ok-no-conversation',
  'error',
  'quota',
  'auth',
  'hang',
  'huge',
  'slow',
  'spawn-grandchild',
  'garbage',
  'exit',
];

const MAX_LIFETIME_MS = 600_000;
const DEFAULT_HUGE_BYTES = 12 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
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

/** 0 → "aaaa", 1 → "aaab" … letters only, so an id can never contain a digit run like 429. */
function letters(n) {
  let out = '';
  let v = Math.max(0, Math.trunc(n));
  for (let i = 0; i < 4; i++) {
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Argument parsing — one parser per CLI, mirroring what each adapter sends
 * ------------------------------------------------------------------------- */

function parseCodex(argv) {
  if (argv[0] === 'exec') {
    let i = 1;
    let resumeId;
    if (argv[1] === 'resume') {
      resumeId = argv[2];
      i = 3;
    }
    const p = { kind: resumeId === undefined ? 'run' : 'resume', json: false, flags: [], fence: false, resumeId };
    const positionals = [];
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') {
        p.fence = true;
        p.prompt = argv[i + 1];
        p.afterPrompt = argv.slice(i + 2);
        break;
      }
      if (a === '--json') {
        p.json = true;
      } else if (a === '--model' || a === '-m') {
        p.model = argv[++i];
      } else if (a === '--sandbox' || a === '-s') {
        p.permission = argv[++i];
      } else if (a.startsWith('-')) {
        p.flags.push(a);
      } else {
        positionals.push(a);
      }
    }
    if (!p.fence) {
      p.prompt = positionals[positionals.length - 1];
    }
    p.permissionFlag = '--sandbox';
    return p;
  }
  if (argv[0] === 'login' && argv[1] === 'status') {
    return { kind: 'login-status' };
  }
  if (argv.includes('--version') || argv[0] === '-V') {
    return { kind: 'version' };
  }
  return { kind: 'unsupported' };
}

function parseCursor(argv) {
  if (argv.includes('-p') || argv.includes('--print')) {
    const p = { kind: 'run', flags: [], fence: false, format: 'text' };
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') {
        p.fence = true;
        p.prompt = argv[i + 1];
        p.afterPrompt = argv.slice(i + 2);
        break;
      }
      if (a === '-p' || a === '--print') {
        continue;
      }
      if (a === '--output-format') {
        p.format = argv[++i];
      } else if (a === '--model') {
        p.model = argv[++i];
      } else if (a === '--sandbox') {
        p.permission = argv[++i];
      } else if (a === '--resume') {
        p.resumeId = argv[++i];
        p.kind = 'resume';
      } else if (a.startsWith('-')) {
        p.flags.push(a);
      } else {
        positionals.push(a);
      }
    }
    if (!p.fence) {
      p.prompt = positionals[positionals.length - 1];
    }
    p.json = p.format === 'json' || p.format === 'stream-json';
    p.permissionFlag = '--sandbox';
    return p;
  }
  if (argv[0] === 'status' || argv[0] === 'whoami') {
    return { kind: 'status' };
  }
  if (argv[0] === 'models') {
    return { kind: 'models' };
  }
  if (argv[0] === 'create-chat') {
    return { kind: 'create-chat' };
  }
  if (argv.includes('--version') || argv[0] === '-v') {
    return { kind: 'version' };
  }
  return { kind: 'unsupported' };
}

function parseAgy(argv) {
  const at = argv.findIndex((a) => a === '-p' || a === '--print');
  if (at >= 0) {
    const p = { kind: 'run', flags: [], fence: false, format: 'text' };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-p' || a === '--print') {
        // The prompt is the VALUE of -p, so a flag-shaped prompt is still the prompt.
        p.prompt = argv[i + 1];
        p.afterPrompt = argv.slice(i + 2);
        break;
      }
      if (a === '--output-format') {
        p.format = argv[++i];
      } else if (a === '--model') {
        p.model = argv[++i];
      } else if (a === '--mode') {
        p.permission = argv[++i];
      } else if (a === '--conversation') {
        p.resumeId = argv[++i];
        p.kind = 'resume';
      } else {
        p.flags.push(a);
      }
    }
    p.json = p.format === 'json' || p.format === 'stream-json';
    p.permissionFlag = '--mode';
    return p;
  }
  if (argv[0] === 'models') {
    return { kind: 'models' };
  }
  if (argv.includes('--version')) {
    return { kind: 'version' };
  }
  return { kind: 'unsupported' };
}

const PARSERS = { codex: parseCodex, cursor: parseCursor, gemini: parseAgy };

/* ------------------------------------------------------------------------- *
 * Scenario
 * ------------------------------------------------------------------------- */

/** A run spec: a kind name ("ok", "slow:300", "exit:3") or `{ kind, …knobs }`. */
export function normalizeSpec(spec) {
  const fromString = (s) => {
    let m;
    if ((m = /^slow:(\d+)$/.exec(s))) {
      return { kind: 'slow', ms: Number(m[1]) };
    }
    if ((m = /^exit:(\d+)$/.exec(s))) {
      return { kind: 'exit', code: Number(m[1]) };
    }
    return { kind: s };
  };
  if (spec === undefined || spec === null) {
    return { kind: 'ok' };
  }
  if (typeof spec === 'string') {
    return fromString(spec);
  }
  if (isObj(spec) && typeof spec.kind === 'string') {
    return { ...spec, ...fromString(spec.kind), ...Object.fromEntries(Object.entries(spec).filter(([k]) => k !== 'kind')) };
  }
  return { kind: 'invalid', raw: spec };
}

/** `sequence[n]` (by run order) beats `byHome[<home basename>]`, which beats `default`. */
function pickRunSpec(cfg, seq, homeKey) {
  const run = cfg.run;
  if (isObj(run) && run.kind === undefined && ('default' in run || 'sequence' in run || 'byHome' in run)) {
    if (Array.isArray(run.sequence) && run.sequence[seq] !== undefined && run.sequence[seq] !== null) {
      return normalizeSpec(run.sequence[seq]);
    }
    if (isObj(run.byHome) && run.byHome[homeKey] !== undefined && run.byHome[homeKey] !== null) {
      return normalizeSpec(run.byHome[homeKey]);
    }
    return normalizeSpec(run.default);
  }
  return normalizeSpec(run);
}

/** `login: "in" | "out"`, or `{ default, byHome: { <home basename>: "out" } }`. */
function pickLogin(cfg, homeKey) {
  const login = cfg.login;
  if (isObj(login)) {
    if (isObj(login.byHome) && typeof login.byHome[homeKey] === 'string') {
      return login.byHome[homeKey];
    }
    return typeof login.default === 'string' ? login.default : 'in';
  }
  return login === 'out' ? 'out' : 'in';
}

/** Does `<home>/auth.json` describe a login, by the same value rule the Codex adapter applies? */
function codexAuthFileLoggedIn(home) {
  const parsed = readJson(path.join(home, 'auth.json'));
  if (!isObj(parsed)) {
    return false;
  }
  const nonEmpty = (x) => typeof x === 'string' && x.trim().length > 0;
  const tokens = isObj(parsed.tokens) ? parsed.tokens : undefined;
  return (tokens !== undefined && (nonEmpty(tokens.access_token) || nonEmpty(tokens.id_token))) || nonEmpty(parsed.OPENAI_API_KEY);
}

/* ------------------------------------------------------------------------- *
 * Wire formats — what each adapter's parser reads
 * ------------------------------------------------------------------------- */

const line = (obj) => JSON.stringify(obj) + '\n';

function wireOk(vendor, { text, conv, input, output, cached, reportModel }) {
  if (vendor === 'codex') {
    return (
      (conv ? line({ type: 'thread.started', thread_id: conv }) : '') +
      line({ type: 'turn.started' }) +
      line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text, ...(reportModel ? { model: reportModel } : {}) } }) +
      line({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, harness_raw_marker: RAW_MARKER })
    );
  }
  if (vendor === 'cursor') {
    return line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1200,
      duration_api_ms: 1100,
      result: text,
      ...(conv ? { session_id: conv } : {}),
      request_id: 'req-harness',
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0 },
      harness_raw_marker: RAW_MARKER,
    });
  }
  return line({
    conversation_id: conv,
    status: 'SUCCESS',
    // `agy` ends its printed answer with a newline; the adapter strips exactly one.
    response: text === '' ? '' : `${text}\n`,
    duration_seconds: 1.2,
    num_turns: 1,
    usage: { input_tokens: input, output_tokens: output, thinking_tokens: 12, cache_read_tokens: cached, total_tokens: input + output },
    harness_raw_marker: RAW_MARKER,
  });
}

/** A vendor-reported failure. Returns { stdout, stderr, code }. */
function wireError(vendor, { message, conv, text }) {
  if (vendor === 'codex') {
    return {
      stdout:
        (conv ? line({ type: 'thread.started', thread_id: conv }) : '') +
        line({ type: 'turn.started' }) +
        (text ? line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }) : '') +
        line({ type: 'error', message }) +
        line({ type: 'turn.failed', error: { message } }),
      stderr: '',
      code: 1,
    };
  }
  if (vendor === 'cursor') {
    return {
      stdout: line({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 900, result: message, ...(conv ? { session_id: conv } : {}), request_id: 'req-harness' }),
      stderr: '',
      code: 1,
    };
  }
  return { stdout: line({ conversation_id: '', status: 'ERROR', response: text ?? '', error: message }), stderr: '', code: 1 };
}

/** What a run answers when the account is not logged in. */
function wireAuth(vendor) {
  const message = TEXTS[vendor].auth;
  if (vendor === 'cursor') {
    // cursor-agent prints no JSON at all here: the adapter raises AdapterExecError with this stderr.
    return { stdout: '', stderr: `${message}\n`, code: 1 };
  }
  const out = wireError(vendor, { message });
  return { ...out, stderr: `${message}\n` };
}

const CURSOR_MODELS = [
  'Available models',
  '',
  'auto - Auto',
  'composer-2.5 - Composer 2.5',
  'cursor-grok-4.5-high - Grok 4.5 High',
  'gpt-5.6 - GPT 5.6',
  '',
  "Tip: use --model <id>, e.g. --model 'composer-2.5'",
  '',
].join('\n');

const AGY_MODELS = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

/* ------------------------------------------------------------------------- *
 * The program
 * ------------------------------------------------------------------------- */

function refuse(message) {
  try {
    fs.writeSync(2, `fake-vendor: ${message}\n`);
  } catch {
    // stderr already gone — the exit code still tells the story
  }
  process.exit(EXIT_NO_SANDBOX);
}

/** Write to stdout honouring backpressure — a `huge` run must not buffer 12 MiB in one call. */
function writeOut(stream, text) {
  return new Promise((resolve) => {
    if (text === '') {
      resolve();
      return;
    }
    stream.write(text, () => resolve());
  });
}

export async function main(vendor) {
  const facts = VENDORS[vendor];
  let argv = process.argv.slice(2);
  // The sandbox launcher (helpers.mjs) passes `--fake-root=<sandbox>` first: it puts the
  // sandbox on this process's command line, which is how cleanup finds it in `ps`.
  let fakeRoot;
  while (argv.length > 0 && argv[0].startsWith('--fake-root=')) {
    fakeRoot = argv[0].slice('--fake-root='.length);
    argv = argv.slice(1);
  }
  const grandchildMode = argv[0] === '__grandchild';
  const inv = crypto.randomUUID();
  // A reader that goes away mid-write (a killed caller, a capped pipe) must not turn into an
  // unhandled EPIPE: the scenario decides how this process ends, not a broken pipe.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  /* ---- sandbox ---- */
  const scenarioFile = process.env[SCENARIO_ENV];
  const raw = typeof scenarioFile === 'string' && scenarioFile !== '' ? readJson(scenarioFile) : undefined;
  if (!isObj(raw)) {
    // Started by something that did not pass the harness environment through. Say so in the
    // sandbox's own log when the launcher told us which sandbox this is — a probe can then
    // report "the vendor child did not inherit the environment" instead of a bare exit code.
    if (fakeRoot && fs.existsSync(path.join(fakeRoot, SANDBOX_MARKER))) {
      try {
        fs.appendFileSync(
          path.join(fakeRoot, 'fake-vendor.log.jsonl'),
          line({ ts: Date.now(), inv, pid: process.pid, vendor, kind: 'no-scenario', argv, cwd: process.cwd(), env: { ...process.env } }),
        );
      } catch {
        // evidence only
      }
    }
    refuse(`${SCENARIO_ENV} is not set or does not name a JSON object; refusing to run outside a harness sandbox.`);
  }
  const sandboxRoot = typeof raw.sandboxRoot === 'string' && path.isAbsolute(raw.sandboxRoot) ? raw.sandboxRoot : path.dirname(path.resolve(scenarioFile));
  if (!fs.existsSync(path.join(sandboxRoot, SANDBOX_MARKER))) {
    refuse(`${sandboxRoot} is not a harness sandbox (no ${SANDBOX_MARKER}); refusing to run.`);
  }
  if (fakeRoot !== undefined && canon(fakeRoot) !== canon(sandboxRoot)) {
    refuse(`launcher sandbox ${fakeRoot} is not the scenario's sandbox ${sandboxRoot}; refusing to run.`);
  }
  const logFile = typeof raw.logFile === 'string' ? raw.logFile : path.join(sandboxRoot, 'fake-vendor.log.jsonl');
  const pidDir = typeof raw.pidDir === 'string' ? raw.pidDir : path.join(sandboxRoot, 'pids');
  const cfg = isObj(raw[vendor]) ? raw[vendor] : {};

  const appendLog = (record) => {
    try {
      // No mkdir: a log write must never bring a removed sandbox back.
      fs.appendFileSync(logFile, line(record));
    } catch {
      // the log is evidence, never a dependency
    }
  };
  const logExit = (code, extra = {}) => appendLog({ ts: Date.now(), inv, pid: process.pid, vendor, kind: 'exit', code, ...extra });

  const homeDir = process.env.HOME || os.homedir();
  const explicitHome = facts.homeEnv ? process.env[facts.homeEnv] : undefined;
  const home = typeof explicitHome === 'string' && explicitHome !== '' ? explicitHome : path.join(homeDir, facts.defaultHome);
  const homeSource = typeof explicitHome === 'string' && explicitHome !== '' ? 'env' : facts.homeEnv ? 'default' : 'ambient';
  const homeKey = path.basename(home.replace(/[/\\]+$/, ''));

  const violation = (what, where) => {
    appendLog({ ts: Date.now(), inv, pid: process.pid, vendor, kind: 'sandbox-violation', argv, what, where, sandboxRoot });
    refuse(`${what} ${where} is outside the sandbox root ${sandboxRoot}; refusing to run.`);
  };
  if (!isInside(homeDir, sandboxRoot)) {
    violation('HOME', homeDir);
  }
  if (!isInside(home, sandboxRoot)) {
    violation(`the ${facts.cli} home`, home);
  }

  /* ---- bookkeeping shared by every mode ---- */
  const pidFile = path.join(pidDir, `${process.pid}.json`);
  const register = (kind) => {
    try {
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, vendor, kind, startedAt: Date.now() }));
    } catch {
      // best effort — cleanup also finds this process by the sandbox root on its command line
    }
    process.on('exit', () => {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // already removed with the sandbox
      }
    });
  };
  // Safety nets: nothing this fake starts may outlive a harness that was itself killed.
  const lifeline = setInterval(() => {
    if (!fs.existsSync(sandboxRoot)) {
      process.exit(EXIT_NO_SANDBOX);
    }
  }, 500);
  lifeline.unref();
  const deadline = setTimeout(() => process.exit(EXIT_INTERNAL), MAX_LIFETIME_MS);
  deadline.unref();

  /** SIGTERM: either ignored (the `ignoreSigterm` knob) or logged and then taken for real. */
  const armSigterm = (ignore) => {
    process.on('SIGTERM', () => {
      if (ignore) {
        appendLog({ ts: Date.now(), inv, pid: process.pid, vendor, kind: 'sigterm-ignored' });
        return;
      }
      logExit(null, { signal: 'SIGTERM' });
      process.removeAllListeners('SIGTERM');
      process.kill(process.pid, 'SIGTERM');
    });
  };

  if (grandchildMode) {
    // `__grandchild <lifetime ms> <ignore SIGTERM 0|1> <parent invocation>` — plays a helper
    // the vendor CLI started: same process group as the CLI, and nothing kills it but a
    // signal to that group (or its own lifetime running out).
    const lifetimeMs = Number(argv[1]) || 120_000;
    register('grandchild');
    armSigterm(argv[2] === '1');
    appendLog({ ts: Date.now(), inv, pid: process.pid, ppid: process.ppid, vendor, kind: 'grandchild', parentInv: argv[3], lifetimeMs, ignoreSigterm: argv[2] === '1' });
    await sleep(lifetimeMs);
    logExit(0, { reason: 'lifetime' });
    process.exit(0);
  }

  const parsed = PARSERS[vendor](argv);
  const isRun = parsed.kind === 'run' || parsed.kind === 'resume';
  register(parsed.kind);

  const finish = async (code, { stdout = '', stderr = '', extra = {} } = {}) => {
    logExit(code, extra);
    if (stderr !== '') {
      await writeOut(process.stderr, stderr);
    }
    await writeOut(process.stdout, stdout);
    process.exit(code);
  };

  const record = {
    ts: Date.now(),
    inv,
    pid: process.pid,
    ppid: process.ppid,
    vendor,
    cli: facts.cli,
    kind: parsed.kind,
    argv,
    cwd: process.cwd(),
    env: { ...process.env },
    home,
    homeSource,
    homeKey,
  };

  if (!isRun) {
    const login = vendor === 'codex' ? (codexAuthFileLoggedIn(home) || (process.env.OPENAI_API_KEY ?? '').trim() !== '' ? 'in' : 'out') : pickLogin(cfg, homeKey);
    appendLog({ ...record, login });
    if (parsed.kind === 'version') {
      await finish(0, { stdout: `${typeof cfg.version === 'string' ? cfg.version : facts.version}\n` });
    }
    if (parsed.kind === 'login-status') {
      await finish(login === 'in' ? 0 : 1, { stdout: login === 'in' ? 'Logged in using ChatGPT\n' : 'Not logged in\n' });
    }
    if (parsed.kind === 'status') {
      await finish(login === 'in' ? 0 : 1, { stdout: login === 'in' ? `\n ✓ Logged in as ${CURSOR_IDENTITY}\n\n` : '\n ✗ Not logged in\n\n' });
    }
    if (parsed.kind === 'models') {
      if (login !== 'in') {
        await finish(1, { stdout: vendor === 'gemini' ? 'Fetching available models...\n' : '', stderr: `${TEXTS[vendor].auth}\n` });
      }
      await finish(0, { stdout: vendor === 'gemini' ? AGY_MODELS : CURSOR_MODELS });
    }
    if (parsed.kind === 'create-chat') {
      await finish(0, { stdout: 'cursor-session-minted\n' });
    }
    await finish(EXIT_UNSUPPORTED, { stderr: `fake-vendor (${facts.cli}): unsupported invocation: ${JSON.stringify(argv)}\n` });
  }

  /* ---- a run ---- */
  if (!isInside(process.cwd(), sandboxRoot)) {
    violation('the working directory', process.cwd());
  }
  // Atomic cross-process counter (mkdir is atomic): 0, 1, 2 … per vendor, in run order.
  const seqDir = path.join(sandboxRoot, '.fake-seq');
  let seq = 0;
  try {
    fs.mkdirSync(seqDir);
  } catch {
    // exists (or the sandbox is going away — the mkdir below then fails too)
  }
  for (; seq < 100_000; seq++) {
    try {
      fs.mkdirSync(path.join(seqDir, `${vendor}-${seq}`));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        process.exit(EXIT_NO_SANDBOX);
      }
    }
  }

  let spec = pickRunSpec(cfg, seq, homeKey);
  if (spec.kind === 'spawn-grandchild') {
    spec = { ...spec, kind: 'ok', grandchild: spec.grandchild ?? true };
  }
  const loggedIn = vendor === 'codex' ? codexAuthFileLoggedIn(home) || (process.env.OPENAI_API_KEY ?? '').trim() !== '' : pickLogin(cfg, homeKey) === 'in';
  // A logged-out account cannot run anything, whatever the scenario asked for.
  const effective = !loggedIn && spec.ignoreLogin !== true && spec.kind !== 'auth' ? { ...spec, kind: 'auth', forcedBy: 'login-state' } : spec;

  const tokens = TOKENS[vendor];
  const input = Number.isFinite(effective.inputTokens) ? effective.inputTokens : tokens.input;
  const output = Number.isFinite(effective.outputTokens) ? effective.outputTokens : tokens.output;
  const convPrefix = { codex: 'codex-thread', cursor: 'cursor-session', gemini: 'agy-conversation' }[vendor];
  const conv = effective.kind === 'ok-no-conversation' ? '' : typeof effective.conversationId === 'string' ? effective.conversationId : (parsed.resumeId ?? `${convPrefix}-${letters(seq)}`);
  const text =
    typeof effective.text === 'string'
      ? effective.text
      : `${TEXTS[vendor].ok} seq=${letters(seq)} model=${parsed.model ?? 'default'} mode=${parsed.permission ?? 'none'} home=${homeKey}`;

  let pgid;
  try {
    const res = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
    const n = Number(String(res.stdout).trim());
    pgid = Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    pgid = undefined;
  }

  // The grandchild: NOT detached, so it shares this process's group — only a signal to the
  // group reaches it. `holdPipes` makes it inherit stdout/stderr, so the caller's 'close'
  // never fires while it lives (a caller must settle on 'exit' plus a short drain).
  let grandchildPid;
  if (effective.grandchild) {
    const g = isObj(effective.grandchild) ? effective.grandchild : {};
    const child = spawn(
      process.execPath,
      [SELF, `--fake-root=${sandboxRoot}`, '__grandchild', String(Number(g.lifetimeMs) || 120_000), g.ignoreSigterm ? '1' : '0', inv],
      { detached: false, stdio: g.holdPipes ? ['ignore', 'inherit', 'inherit'] : 'ignore', env: { ...process.env, CCO_FAKE_VENDOR: vendor } },
    );
    child.unref();
    grandchildPid = child.pid;
  }

  appendLog({
    ...record,
    seq,
    pgid,
    groupLeader: pgid === process.pid,
    scenario: effective.kind,
    spec: effective,
    loggedIn,
    grandchildPid,
    conversationId: conv,
    text: effective.kind === 'huge' ? undefined : text,
    inputTokens: input,
    outputTokens: output,
    parsed: {
      model: parsed.model,
      permission: parsed.permission,
      permissionFlag: parsed.permissionFlag,
      prompt: parsed.prompt,
      fence: parsed.fence,
      format: parsed.format,
      json: parsed.json,
      flags: parsed.flags,
      afterPrompt: parsed.afterPrompt,
      resumeId: parsed.resumeId,
    },
  });
  armSigterm(effective.ignoreSigterm === true);

  if (!RUN_KINDS.includes(effective.kind)) {
    appendLog({ ts: Date.now(), inv, pid: process.pid, vendor, kind: 'fake-error', error: `unknown run scenario ${JSON.stringify(effective)}` });
    await finish(EXIT_INTERNAL, { stderr: `fake-vendor: unknown run scenario ${JSON.stringify(effective.kind)}\n` });
  }
  if (typeof parsed.prompt !== 'string' || parsed.prompt === '') {
    await finish(EXIT_UNSUPPORTED, { stderr: `fake-vendor (${facts.cli}): a run needs a prompt\n` });
  }

  const ok = (overrides = {}) => wireOk(vendor, { text, conv, input, output, cached: tokens.cached, reportModel: effective.reportModel, ...overrides });

  switch (effective.kind) {
    case 'hang': {
      // Says who it is (so a timeout still has a conversation id to show), then never answers.
      if (vendor === 'codex') {
        await writeOut(process.stdout, line({ type: 'thread.started', thread_id: conv }) + line({ type: 'turn.started' }));
      }
      await sleep(MAX_LIFETIME_MS);
      await finish(EXIT_INTERNAL);
      break;
    }
    case 'slow': {
      await sleep(Number(effective.ms) || 0);
      await finish(0, { stdout: ok() });
      break;
    }
    case 'ok':
    case 'ok-no-conversation':
      await finish(0, { stdout: ok() });
      break;
    case 'ok-empty-text':
      await finish(0, { stdout: ok({ text: '' }) });
      break;
    case 'ok-blank-text':
      await finish(0, { stdout: ok({ text: '  \n\t ' }) });
      break;
    case 'error': {
      const out = wireError(vendor, { message: typeof effective.message === 'string' ? effective.message : TEXTS[vendor].error, conv, text: effective.partialText });
      await finish(out.code, out);
      break;
    }
    case 'quota': {
      // `carrier: "text"` additionally puts the vendor's sentence in the assistant text; by
      // default it is only where the real CLI puts it (Codex / agy: the error event, which
      // the adapter surfaces as RunResult.note; cursor-agent: the result text).
      const out = wireError(vendor, { message: TEXTS[vendor].quota, conv, text: effective.carrier === 'text' ? TEXTS[vendor].quota : undefined });
      await finish(out.code, out);
      break;
    }
    case 'auth': {
      const out = wireAuth(vendor);
      await finish(out.code, out);
      break;
    }
    case 'garbage':
      await finish(0, { stdout: 'this is not JSON at all\n{ "broken": \n' });
      break;
    case 'exit':
      await finish(Number.isInteger(effective.code) ? effective.code : 3, { stderr: `fake-vendor (${facts.cli}): deterministic crash, no output\n` });
      break;
    case 'huge': {
      // More than 8 MiB on stdout (and, unless `stderr: false`, as much again on stderr).
      //   where "text"   — the ANSWER itself is that large (one JSON line);
      //   where "after"  — a normal answer, then that much non-JSON chatter;
      //   where "before" — that much chatter, then a normal answer.
      const bytes = Number(effective.bytes) || DEFAULT_HUGE_BYTES;
      const where = effective.where ?? 'text';
      const fillerLine = `# harness filler ${'H'.repeat(1000)}\n`;
      const chatter = async (stream) => {
        for (let written = 0; written < bytes; written += fillerLine.length * 64) {
          await writeOut(stream, fillerLine.repeat(64));
        }
      };
      logExit(0, { huge: { bytes, where } });
      if (effective.stderr !== false) {
        await chatter(process.stderr);
      }
      if (where === 'text') {
        await writeOut(process.stdout, ok({ text: 'H'.repeat(bytes) }));
      } else if (where === 'before') {
        await chatter(process.stdout);
        await writeOut(process.stdout, ok());
      } else {
        await writeOut(process.stdout, ok());
        await chatter(process.stdout);
      }
      process.exit(0);
      break;
    }
    default:
      await finish(EXIT_INTERNAL);
  }
}

export function runAsCli(vendor) {
  main(vendor).catch((err) => {
    try {
      fs.writeSync(2, `fake-vendor: internal error: ${err && err.stack ? err.stack : err}\n`);
    } catch {
      // nothing left to say
    }
    process.exit(EXIT_INTERNAL);
  });
}

// The grandchild re-invokes THIS file; the vendor it plays for rides in the environment.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  runAsCli(Object.hasOwn(VENDORS, process.env.CCO_FAKE_VENDOR ?? '') ? process.env.CCO_FAKE_VENDOR : 'codex');
}
