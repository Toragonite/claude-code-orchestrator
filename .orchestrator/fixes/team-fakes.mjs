// team-fakes.mjs — the shared half of the team-mode harness (contract-team-mode-v2.md §11.1 T9):
//
//   PART A, the FAKE RUNTIME: what the four stand-in vendor CLIs (team-fake-claude.mjs,
//   team-fake-codex.mjs, team-fake-cursor.mjs, team-fake-agy.mjs) have in common — the log they
//   write, the per-member turn scripts they obey, the conversation store that gives them the
//   measured resume behaviour (RP-9), the MCP client with which they start and call the team MCP
//   server they are wired to (§3.2), the leader-versus-group SIGINT detector (T0 A1), and the
//   generic "work" of a turn (files, tool calls, duration, stragglers, a cco call).
//
//   PART B, the SUITE HELPERS: installing the fakes on a scratch PATH under the names `claude`,
//   `codex`, `cursor-agent` and `agy` (plus a `git` shim that can be told to fail one git
//   operation, and a stand-in MCP server for the fakes' own checks), the scripting API, and the
//   log readers.
//
// Written from the contract ONLY (§3.2, §3.3, §3.7, §12, the T0 amendments and team-probes.md);
// never from src/team/*.ts other than contract.ts. Node built-ins only, no top-level side effect:
// the fakes import Part A, team.mjs imports Part B, and both may load the whole module.
//
// THE INSTALLATION (one per sandbox, `installFakes(root, …)`):
//
//   <root>/bin/node                  a symlink to the node running the suite
//   <root>/bin/claude|codex|cursor-agent|agy
//                                    `#!/bin/bash` launchers: `exec -a "$0" <node> <fake> "$@"`. The
//                                    `-a "$0"` keeps the vendor name as argv[0], so `ps` shows
//                                    `<root>/bin/cursor-agent <fake> -p …` — the command line
//                                    registry.isOurWorker fences with (its vendor branch wants the
//                                    CLI's name as a path segment and its headless switch; its
//                                    Claude branch `claude` and ` -p`).
//   <root>/bin/git                   a shim: `exec /usr/bin/git "$@"` unless the state directory
//                                    holds `git-fail/<op>` (then: `fatal: <that file's text>`, exit
//                                    128) or `git-hang/<op>` (then it sleeps until killed) for
//                                    the first git subcommand of the call — how the suite makes
//                                    phase 2 of a worktree fail or time out (H6).
//   <root>/fakes/*.mjs               the four fakes and this module
//   <root>/fakes/state/              the fakes' state (found from the fake's own file — never from
//                                    an environment variable, which the driver may not pass, and
//                                    which Codex filters for its MCP children anyway, RP-6):
//     config.json                    {logFile, node, binDir, cliJs?}
//     log.jsonl                      one record per line, O_APPEND (see "The log" below)
//     scripts/<member>.json          the member's turn scripts (`scriptMember`)
//     scripts/_default.json          the scripts of a member that has none of its own
//     counters/<vendor>-<member>     turns run so far, per vendor and member
//     conversations/<vendor>/<id>.json   every conversation a fake started (Claude's own transcript
//                                    lives where the real CLI keeps it, `<configDir>/projects/…`)
//     prompts/<vendor>-<pid>.txt     the prompt each turn received (after a file indirection)
//     auth/<vendor>/<account>        `out` → that account reads as logged out
//
// THE LOG. Every record is `{vendor, pid, t, ev, …}`:
//   start        {kind, argv (the prompt elided), cwd, member, ppid, pgid, env, envKeys, problems, unknown}
//                — `problems`: where the argv departs from the contract's §3.2 shape for this
//                vendor (empty when it conforms); `unknown`: flags the real CLI would reject (the
//                fake then exits 2 as the CLI does)
//   prompt       {file, bytes, sha256, indirect}
//   conversation {id, resumed, expected?, found, replaced?}
//   mcp-start    {command, args, envKeys, cwd}
//   mcp-init     {ok, why?, tools?, stderr?}
//   tool-call    {tool, arguments, isError, text}
//   tool-refused {tool, why}                  the VENDOR refused the call (approval, agy without the flag)
//   files        {written: [...]}
//   sigint       {scope: 'leader' | 'group', ignored}
//   sigterm      {ignored}
//   straggler    {child, kind}            (`child`: the log's own `pid` is the fake's)
//   cco          {args, status, stdout, stderr}
//   end          {how, code, sawAssistant, conversationId}
//
// A TURN SCRIPT (a "step"; `scriptMember(root, member, [step, step, …], {fallback})` — turn k of
// a member uses entry k, then `fallback`, then the built-in default). A message or brief that
// holds `[[fake-step:{…json…}]]` overrides the step of the turn that receives it (the last one
// in the prompt wins). Every field is optional:
//
//   durationMs        time spent working (a progress text every 250 ms)      default 300
//   hang              work until a signal ends the turn
//   text              the final answer                                      default `FAKE_OK <vendor> <member> turn <k>`
//   writeFiles        [{path, content}] relative to the cwd, written at once
//   toolCalls         [{tool, arguments}] team tools called after the ids line
//   toolCallsAfter    [{tool, arguments}] team tools called after the work
//   tokens            {in, out}                                             default {in: 1200, out: 80}
//   fail              'quota' | 'auth' | 'context' | 'error'  — the turn ends failed with that
//                     vendor's measured wording (classification is the engine's)
//   failBeforeAssistant  the failure comes right after the ids line, before any assistant event (H3)
//   crashEarly        exit 1 before ANY stream line (stderr only) — §2.5's early crash
//   transcriptThenCrash  Claude: create the transcript, then crash early (M21 / A4)
//   newConversation   report a NEW conversation id on this turn (S4; Cursor/agy do it by themselves
//                     for a well-formed missing id — RP-9)
//   deaf              ignore SIGINT and SIGTERM (only SIGKILL ends it)
//   ignoreSigint      ignore SIGINT only
//   exitCode          the exit code of a normal end                         default 0
//   stderr            a line written to stderr
//   straggler         'ours' | 'foreign' — leave a detached process (its own group) that carries the
//                     turn's environment: `ours` re-runs this vendor's launcher in hang mode (its
//                     command line passes isOurWorker), `foreign` is `node -e <idle 120 s>` (it does
//                     not). Both are node processes: macOS `ps -E` hides the environment of Apple's
//                     platform binaries (/bin/sleep), so only a non-Apple foreign process makes the
//                     isOurWorker fence — not an unreadable marker — what spares it
//   mcpOrphan         the team MCP server's stdin is a FIFO this fake also holds a write end of, so
//                     it never sees EOF when the fake dies — only its parent-pid poll (T0 A2) or the
//                     driver's reaper ends it
//   mcpReject         the vendor refuses every MCP call (Cursor without --force, RP-26)
//   surviveClosedStdout  a broken stdout/stderr (EPIPE: the host that read it is gone) does NOT end
//                     the turn: the fake stops writing and works on — an orphan the next host's
//                     sweep must fence and stop (§2.5). Without it the fake exits on EPIPE, which
//                     is what a real CLI most likely does (an unverified assumption, stated)
//   runCco            argv of a `cco` call run from inside the turn (I11, §3.9): `node <cliJs> …`
//
// Never a real CLI: no network, no login, no tokens; nothing outside the sandbox is touched.

import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/* ========================================================================= *
 * PART A — the fake runtime
 * ========================================================================= */

/** The five team tools and Claude's names for them (§3.2, MD-34). */
export const TEAM_TOOLS = ['team_board', 'team_inbox', 'team_send', 'team_claim', 'team_update'];
export const CLAUDE_TEAM_TOOLS = TEAM_TOOLS.map((t) => `mcp__cco_team__${t}`);
export const CLAUDE_ALLOWED_ARG = CLAUDE_TEAM_TOOLS.join(',');
/** The tools a Claude `-p` run has before --disallowedTools (RP-27: SendMessage and ListAgents are real names). */
export const CLAUDE_BASE_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'ListAgents', 'Read', 'SendMessage', 'Task', 'TodoWrite', 'WebFetch', 'Write'];
/** RFC 4122 version 4 (the id the host mints for --session-id, §2.1). */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Any well-formed UUID (Cursor's create-chat ids, §3.2 / RP-9). */
export const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The measured failure wordings (team-probes.md; RP-9, RP-23, A4) and plausible quota / context
 * sentences — the CLASSIFICATION is the engine's (§3.3); a fake only says what its CLI says.
 */
export const VENDOR_TEXT = {
  claude: {
    quota: 'Claude AI usage limit reached — your limit will reset at 5pm (rate_limit_error 429)',
    auth: 'Not logged in · Please run /login',
    context: 'Prompt is too long',
    error: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    resumeMissing: (id) => `No conversation found with session ID: ${id}`,
    inUse: (id) => `Error: Session ID ${id} is already in use.`,
  },
  codex: {
    quota: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 5:10 PM.",
    auth: 'Not logged in. Please run `codex login` to sign in.',
    context: 'stream error: ContextWindowExceeded: the conversation is longer than the model context window',
    error: 'stream error: unexpected status 500 Internal Server Error',
    resumeMissing: (id) => `Error: thread/resume failed: no rollout found for thread id ${id}`,
    noModel: (m) => `Model metadata for ${m} not found`,
    approval: 'MCP tool call requires approval, but approval policy is never',
  },
  cursor: {
    quota: "You've hit your usage limit for this billing period. Usage limit reached (429).",
    auth: "Authentication required. Please run 'cursor-agent login' first.",
    context: 'The conversation is too long for the model context window',
    error: 'Internal server error (500)',
    notUuid: 'Persistent-session chat ID must be a UUID',
    rejected: 'MCP tool call rejected: run with --force to allow it',
  },
  gemini: {
    quota: 'RESOURCE_EXHAUSTED: You have exhausted your quota (429). Your quota will reset after 5h.',
    auth: 'Not logged in. Please run `agy login`.',
    context: 'The input token count exceeds the maximum number of tokens allowed',
    error: 'INTERNAL: an internal error occurred (500)',
    missing: (id) => `warning: conversation "${id}" not found`,
  },
};

/** The fake's version line per vendor (team-probes.md "versions"). */
export const VENDOR_VERSION = {
  claude: '2.1.299 (Claude Code)',
  codex: 'codex-cli 0.162.1',
  cursor: '2026.10.14-0f9edde',
  gemini: '1.3.6',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** `ps -o <field>= -p <pid>`, trimmed, or '' — never throws. */
function psField(pid, field) {
  try {
    const r = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return String(r.stdout || '').trim();
  } catch {
    return '';
  }
}

/** The member a turn belongs to: the basename of its cwd (§2.1: the cwd IS the member's worktree root). */
export function memberOfCwd(cwd) {
  return path.basename(cwd);
}

/** What a log record keeps of an environment: the identity and marker variables, verbatim. */
const ENV_KEEP = [
  'CCO_DISPATCHED_TASK',
  'CCO_TEAM_MEMBER',
  'CCO_TEAM_PORT_BASE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'AGY_HOME',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'HOME',
  'GIT_TERMINAL_PROMPT',
];

/**
 * The runtime of one fake invocation. `vendor` ∈ claude | codex | cursor | gemini; `metaUrl` the
 * fake's own import.meta.url (the state directory is `<its dir>/state`).
 */
export function fakeRuntime(vendor, metaUrl) {
  const fakeFile = fileURLToPath(metaUrl);
  const stateDir = path.join(path.dirname(fakeFile), 'state');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
  } catch {
    // run by hand outside an installation: log nowhere
  }
  const logFile = config.logFile;
  const rt = {
    vendor,
    fakeFile,
    stateDir,
    config,
    log(record) {
      if (!logFile) return;
      try {
        // One appendFileSync is one O_APPEND write: concurrent fakes never interleave a line.
        fs.appendFileSync(logFile, JSON.stringify({ vendor, pid: process.pid, t: Date.now(), ...record }) + '\n');
      } catch {
        // an unwritable log is the harness's to report, not a reason to change the run
      }
    },
    /** The log record of the invocation itself. */
    logStart(kind, argv, extra = {}) {
      const env = {};
      for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
      rt.log({
        ev: 'start',
        kind,
        argv: argv.map((a) => (a.length > 2000 ? `<${Buffer.byteLength(a)} bytes sha256 ${sha256(a).slice(0, 12)}>` : a)),
        cwd: process.cwd(),
        member: memberOfCwd(process.cwd()),
        ppid: process.ppid,
        pgid: Number(psField(process.pid, 'pgid')) || null,
        env,
        envKeys: Object.keys(process.env).sort(),
        ...extra,
      });
    },
    /** `out` written there → logged out. */
    authOut(account) {
      try {
        return fs.readFileSync(path.join(stateDir, 'auth', vendor, account), 'utf8').trim() === 'out';
      } catch {
        return false;
      }
    },
    /** The next step of `member`'s script (and the prompt's override). */
    nextStep(member, prompt) {
      const counterFile = path.join(stateDir, 'counters', `${vendor}-${member}`);
      let n = 0;
      try {
        n = Number(fs.readFileSync(counterFile, 'utf8')) || 0;
      } catch {
        // first turn
      }
      try {
        fs.mkdirSync(path.dirname(counterFile), { recursive: true });
        fs.writeFileSync(counterFile, String(n + 1));
      } catch {
        // counted in memory only
      }
      let script;
      for (const name of [member, '_default']) {
        try {
          script = JSON.parse(fs.readFileSync(path.join(stateDir, 'scripts', `${name}.json`), 'utf8'));
          break;
        } catch {
          // none
        }
      }
      let step = (script?.turns ?? [])[n] ?? script?.fallback ?? {};
      const overrides = [...String(prompt ?? '').matchAll(/\[\[fake-step:(\{.*?\})\]\]/g)];
      if (overrides.length > 0) {
        try {
          step = { ...JSON.parse(overrides[overrides.length - 1][1]) };
        } catch {
          // a malformed override is ignored
        }
      }
      return { turn: n + 1, step };
    },
    /** Keep the prompt the turn received; follow the MD-64 file indirection as a model would. */
    recordPrompt(positional) {
      let prompt = positional ?? '';
      let indirect;
      const m = /^Your turn input is in the file (.+)\. Read it now and act on it\.$/.exec(prompt.trim());
      if (m) {
        indirect = m[1];
        try {
          prompt = fs.readFileSync(indirect, 'utf8');
        } catch {
          prompt = '';
        }
      }
      const file = path.join(stateDir, 'prompts', `${vendor}-${process.pid}.txt`);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, prompt);
      } catch {
        // kept in the log's sha only
      }
      rt.log({ ev: 'prompt', file, bytes: Buffer.byteLength(prompt), sha256: sha256(prompt), ...(indirect ? { indirect } : {}) });
      return prompt;
    },
    /* ---- the conversation store ---- */
    convFile(id) {
      return path.join(stateDir, 'conversations', vendor, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    },
    convExists(id) {
      try {
        fs.lstatSync(rt.convFile(id));
        return true;
      } catch {
        return false;
      }
    },
    convWrite(id, data) {
      try {
        fs.mkdirSync(path.dirname(rt.convFile(id)), { recursive: true });
        fs.writeFileSync(rt.convFile(id), JSON.stringify({ id, ...data }));
      } catch {
        // the next resume reads it as missing
      }
    },
    convRead(id) {
      try {
        return JSON.parse(fs.readFileSync(rt.convFile(id), 'utf8'));
      } catch {
        return undefined;
      }
    },
  };
  return rt;
}

/**
 * The SIGINT discipline of a vendor CLI (T0 A1). A canary child in the fake's own process group
 * tells a GROUP SIGINT (the canary gets it too) from one sent to the leader's pid alone. `opts`:
 * `ignoreGroup` (Codex: a group SIGINT does not interrupt it — it finishes the turn), `onInterrupt`
 * (called for an interrupt that is honoured), `isDeaf()` / `ignoresSigint()` (the step's wishes).
 */
export function installSignals(rt, opts) {
  let canaryHits = 0;
  try {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CCO_')) delete env[k];
    const canary = spawn(
      process.execPath,
      ['-e', "process.on('SIGINT',()=>{try{process.send('int')}catch{}});process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1<<30)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env },
    );
    canary.on('message', () => canaryHits++);
    canary.on('error', () => {});
    canary.unref();
    canary.channel?.unref?.();
  } catch {
    // without a canary every SIGINT reads as the leader's
  }
  process.on('SIGINT', () => {
    const before = canaryHits;
    setTimeout(() => {
      const scope = canaryHits > before ? 'group' : 'leader';
      const ignored = opts.isDeaf() || opts.ignoresSigint() || (scope === 'group' && opts.ignoreGroup === true);
      rt.log({ ev: 'sigint', scope, ignored });
      if (!ignored) opts.onInterrupt(scope);
    }, 150);
  });
  process.on('SIGTERM', () => {
    const ignored = opts.isDeaf();
    rt.log({ ev: 'sigterm', ignored });
    if (ignored) return;
    process.removeAllListeners('SIGTERM');
    // Die BY the signal, as a CLI without a handler does: the engine tells a kill from an exit.
    process.kill(process.pid, 'SIGTERM');
  });
}

/* ---- TOML, as the Codex `-c key=value` values are spelled (§3.2) ---- */

/** One TOML basic string `"…"` (\\ \" \n \t \uXXXX), or undefined. */
function tomlString(src, i) {
  if (src[i] !== '"') return undefined;
  let out = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const n = src[++j];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '"' || n === '\\') out += n;
      else if (n === 'u') {
        out += String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16));
        j += 4;
      } else return undefined;
    } else if (c.charCodeAt(0) < 0x20) {
      return undefined;
    } else out += c;
  }
  return undefined;
}
/** A TOML value of the shapes Codex's -c takes here: a basic string or an array of them. Else the raw text (codex: "If it fails to parse as TOML, the raw string is used as a literal"). */
export function parseTomlValue(raw) {
  const s = raw.trim();
  const str = tomlString(s, 0);
  if (str && str.end === s.length) return { ok: true, value: str.value };
  if (s.startsWith('[') && s.endsWith(']')) {
    const items = [];
    let i = 1;
    for (;;) {
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] === ']') return { ok: true, value: items };
      const item = tomlString(s, i);
      if (!item) break;
      items.push(item.value);
      i = item.end;
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] === ',') i++;
      else if (s[i] === ']') return { ok: true, value: items };
      else break;
    }
  }
  return { ok: false, value: raw };
}

/* ---- the MCP client a fake uses to start the team MCP server it is wired to ---- */

/**
 * Start a stdio MCP server and speak MCP to it (newline-delimited JSON-RPC 2.0). `env` is what
 * the vendor gives its MCP child (Codex: a FILTERED environment, RP-6). With `orphan` its stdin is
 * a FIFO this process holds open read-write, so its stdin never ends when the fake dies (A2).
 */
export function startMcp(rt, { command, args, env, cwd, orphan = false }) {
  rt.log({ ev: 'mcp-start', command, args, envKeys: Object.keys(env).sort(), cwd, orphan });
  let child;
  let fifoFd;
  try {
    if (orphan) {
      const fifo = path.join(rt.stateDir, `fifo-${process.pid}-${Date.now()}`);
      spawnSync('mkfifo', [fifo]);
      fifoFd = fs.openSync(fifo, 'r+');
      child = spawn(command, args, { cwd, env, stdio: [fifoFd, 'pipe', 'pipe'] });
      rt.log({ ev: 'mcp-orphan-armed', fifo, child: child.pid });
    } else {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } catch (err) {
    rt.log({ ev: 'mcp-init', ok: false, why: `spawn failed: ${err.message}` });
    return undefined;
  }
  const waiting = new Map();
  let nextId = 1;
  let buf = '';
  let stderr = '';
  let exited = false;
  child.on('error', () => {
    exited = true;
  });
  child.on('exit', () => {
    exited = true;
    for (const [, w] of waiting) w(undefined);
    waiting.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stdout.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    if (stderr.length < 8192) stderr += d;
  });
  child.stderr.on('error', () => {});
  const write = (obj) => {
    const line = JSON.stringify(obj) + '\n';
    try {
      if (fifoFd !== undefined) fs.writeSync(fifoFd, line);
      else child.stdin.write(line);
    } catch {
      // the server is gone
    }
  };
  child.stdin?.on?.('error', () => {});
  const request = (method, params, ms) =>
    new Promise((resolve) => {
      if (exited) {
        resolve(undefined);
        return;
      }
      const id = nextId++;
      const t = setTimeout(() => {
        waiting.delete(id);
        resolve(undefined);
      }, ms);
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      write({ jsonrpc: '2.0', id, method, params });
    });
  const mcp = {
    child,
    pid: child.pid,
    tools: [],
    ok: false,
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    async init(ms = 10_000) {
      const r = await request(
        'initialize',
        { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `fake-${rt.vendor}`, version: '0' } },
        ms,
      );
      if (!r || r.error) {
        rt.log({ ev: 'mcp-init', ok: false, why: r ? `error ${JSON.stringify(r.error).slice(0, 300)}` : exited ? 'the server exited' : 'no answer', stderr: stderr.slice(0, 2000) });
        return false;
      }
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await request('tools/list', {}, ms);
      mcp.tools = Array.isArray(list?.result?.tools) ? list.result.tools.map((t) => t?.name).filter((n) => typeof n === 'string') : [];
      mcp.ok = true;
      rt.log({ ev: 'mcp-init', ok: true, tools: mcp.tools, serverInfo: r.result?.serverInfo ?? null });
      return true;
    },
    async call(tool, args, ms = 15_000) {
      const r = await request('tools/call', { name: tool, arguments: args ?? {} }, ms);
      const text = Array.isArray(r?.result?.content) ? r.result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : r?.error ? String(r.error.message) : '';
      const isError = r === undefined ? true : r.error !== undefined || r.result?.isError === true;
      rt.log({ ev: 'tool-call', tool, arguments: args ?? {}, isError, text: text.slice(0, 8192), noAnswer: r === undefined });
      return { isError, text, answered: r !== undefined };
    },
    close() {
      try {
        if (fifoFd === undefined) child.stdin.end();
      } catch {
        // gone
      }
    },
  };
  return mcp;
}

/** The team server entry of a Claude-style `{"mcpServers":{"cco_team":{command,args}}}` file, or undefined. */
export function teamServerOfFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = j?.mcpServers?.cco_team;
    if (s && typeof s.command === 'string' && Array.isArray(s.args)) return { command: s.command, args: s.args.map(String) };
  } catch {
    // unreadable
  }
  return undefined;
}

/** The environment Codex gives an MCP server child (RP-6): exactly these names, nothing of the turn's markers. */
export function codexFilteredEnv() {
  const env = {};
  for (const k of ['HOME', 'LANG', 'PATH', 'TERM', 'USER', '__CF_USER_TEXT_ENCODING']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * The work of one turn, common to all four fakes (see the header for the step fields).
 * `hooks.progress(i)` emits the vendor's progress line; `hooks.toolUse(tool, args)` /
 * `hooks.toolResult(tool, res)` its tool lines; `hooks.stopped()` is true once an interrupt is
 * honoured. Resolves when the work is over (or the turn was stopped).
 */
export async function doWork(rt, step, ctx, hooks) {
  const cwd = process.cwd();
  if (Array.isArray(step.writeFiles) && step.writeFiles.length > 0) {
    const written = [];
    for (const f of step.writeFiles) {
      if (ctx.readOnly) {
        rt.log({ ev: 'write-denied', path: f.path, why: 'read-only sandbox' });
        continue;
      }
      try {
        const target = path.resolve(cwd, String(f.path));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(f.content ?? ''));
        written.push(f.path);
      } catch (err) {
        rt.log({ ev: 'write-failed', path: f.path, why: err.message });
      }
    }
    rt.log({ ev: 'files', written });
  }
  const callAll = async (calls) => {
    for (const c of calls ?? []) {
      if (hooks.stopped()) return;
      if (ctx.toolsBlocked) {
        rt.log({ ev: 'tool-refused', tool: c.tool, why: ctx.toolsBlocked });
        hooks.toolResult?.(c.tool, { isError: true, text: ctx.toolsBlocked });
        continue;
      }
      if (!ctx.mcp?.ok) {
        rt.log({ ev: 'tool-refused', tool: c.tool, why: 'no team MCP server connected' });
        continue;
      }
      hooks.toolUse?.(c.tool, c.arguments ?? {});
      const res = await ctx.mcp.call(c.tool, c.arguments ?? {});
      hooks.toolResult?.(c.tool, res);
    }
  };
  await callAll(step.toolCalls);
  if (step.straggler === 'ours' || step.straggler === 'foreign') {
    try {
      const cmd = step.straggler === 'ours' ? path.join(rt.config.binDir, ctx.cliName) : process.execPath;
      const args = step.straggler === 'ours' ? [...ctx.stragglerArgs, '[[fake-step:{"hang":true}]]'] : ['-e', 'setTimeout(() => {}, 120000)'];
      const s = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd, env: { ...process.env, FAKE_STRAGGLER: '1' } });
      s.unref();
      rt.log({ ev: 'straggler', child: s.pid, kind: step.straggler });
    } catch (err) {
      rt.log({ ev: 'straggler', child: null, kind: step.straggler, why: err.message });
    }
  }
  if (Array.isArray(step.runCco) && rt.config.cliJs) {
    if (ctx.runsCommands === false) {
      rt.log({ ev: 'command-denied', command: 'cco', why: ctx.commandDeniedWhy ?? 'permission denied' });
    } else {
      const r = spawnSync(rt.config.node ?? process.execPath, [rt.config.cliJs, ...step.runCco.map(String)], {
        env: process.env,
        encoding: 'utf8',
        timeout: 30_000,
        cwd,
      });
      rt.log({ ev: 'cco', args: step.runCco, status: r.status, signal: r.signal, stdout: String(r.stdout || '').slice(0, 2000), stderr: String(r.stderr || '').slice(0, 2000) });
    }
  }
  const duration = step.hang ? Infinity : Number.isFinite(step.durationMs) ? step.durationMs : 300;
  const started = Date.now();
  let i = 0;
  while (!hooks.stopped() && Date.now() - started < duration) {
    await sleep(Math.min(250, duration - (Date.now() - started)));
    if (hooks.stopped()) break;
    hooks.progress?.(++i);
  }
  if (!hooks.stopped()) await callAll(step.toolCallsAfter);
}

/**
 * One turn, the same for every vendor; the vendor's own spelling comes in `o.lines`:
 *   ids(mcpStatuses)            the first stream line(s): the conversation id (as measured, ids first)
 *   assistant(text)             an assistant text event
 *   toolUse(tool, args, k)      / toolResult(tool, res, k)   the vendor's tool lines
 *   progress(k)                 a line while working
 *   failure(kind, text)         the failed end (stream lines + stderr); returns the exit code
 *   result(text, tokens)        the successful end
 * `o`: { step, turn, member, mcpServers: [{name, command, args, env}], toolsBlocked?, readOnly?,
 * runsCommands?, commandDeniedWhy?, cliName, stragglerArgs, ignoreGroupSigint?, sigintExit,
 * vendorText (VENDOR_TEXT[vendor]) }.
 */
export async function runTurnFlow(rt, o) {
  const step = o.step ?? {};
  if (step.surviveClosedStdout === true) {
    pipes.survive = true;
    pipes.onBroken = () => rt.log({ ev: 'stdout-closed' });
  }
  let stopped = false;
  let sawAssistant = false;
  const servers = [];
  installSignals(rt, {
    ignoreGroup: o.ignoreGroupSigint === true,
    isDeaf: () => step.deaf === true,
    ignoresSigint: () => step.ignoreSigint === true,
    onInterrupt: () => {
      if (stopped) return;
      stopped = true;
      for (const s of servers) s.mcp?.close();
      setTimeout(() => finish(rt, 'sigint', o.sigintExit, { sawAssistant }), 200);
    },
  });
  if (typeof step.stderr === 'string') process.stderr.write(`${step.stderr}\n`);
  if (step.crashEarly) {
    process.stderr.write(`fatal: ${rt.vendor} fake crashed before any output (scripted)\n`);
    finish(rt, 'crash-early', 1, { sawAssistant: false });
    return;
  }
  const statuses = [];
  for (const s of o.mcpServers ?? []) {
    const mcp = startMcp(rt, { command: s.command, args: s.args, env: s.env, cwd: process.cwd(), orphan: step.mcpOrphan === true && s.name === 'cco_team' });
    const ok = mcp ? await mcp.init() : false;
    servers.push({ name: s.name, mcp });
    statuses.push({ name: s.name, status: ok ? 'connected' : 'failed' });
  }
  if (stopped) return;
  await o.lines.ids(statuses);
  const team = servers.find((s) => s.name === 'cco_team')?.mcp;
  const failWith = async (kind) => {
    const text = o.vendorText[kind] ?? o.vendorText.error;
    const code = await o.lines.failure(kind, text);
    for (const s of servers) s.mcp?.close();
    finish(rt, `fail-${kind}`, code, { sawAssistant });
  };
  if (step.fail && step.failBeforeAssistant) {
    await failWith(step.fail);
    return;
  }
  await o.lines.assistant('Working on it.');
  sawAssistant = true;
  let k = 0;
  await doWork(
    rt,
    step,
    {
      mcp: team,
      toolsBlocked: step.mcpReject ? o.vendorText.rejected ?? o.vendorText.approval ?? 'MCP tool call rejected' : o.toolsBlocked,
      readOnly: o.readOnly,
      runsCommands: o.runsCommands,
      commandDeniedWhy: o.commandDeniedWhy,
      cliName: o.cliName,
      stragglerArgs: o.stragglerArgs,
    },
    {
      stopped: () => stopped,
      progress: (i) => o.lines.progress(i),
      toolUse: (tool, args) => o.lines.toolUse(tool, args, ++k),
      toolResult: (tool, res) => o.lines.toolResult(tool, res, k),
    },
  );
  if (stopped) return;
  if (step.fail) {
    await failWith(step.fail);
    return;
  }
  const text = typeof step.text === 'string' ? step.text : `FAKE_OK ${rt.vendor} ${o.member} turn ${o.turn}`;
  await o.lines.result(text, step.tokens ?? { in: 1200, out: 80 });
  for (const s of servers) s.mcp?.close();
  finish(rt, 'ok', Number.isInteger(step.exitCode) ? step.exitCode : 0, { sawAssistant });
}

/** Write a stream line and resolve when it is flushed. */
export function emitLine(obj) {
  return new Promise((resolve) => {
    if (pipes.broken) {
      resolve();
      return;
    }
    try {
      process.stdout.write(JSON.stringify(obj) + '\n', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Exit once stdout and stderr are drained (EPIPE is an exit too, §3.4). */
export function finish(rt, how, code, extra = {}) {
  rt.log({ ev: 'end', how, code, ...extra });
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  setTimeout(() => process.exit(code), 2000).unref();
}

/**
 * What every fake does first: a broken stdout (EPIPE — the driver is gone) ends it as the real
 * CLIs end, and so does a broken stderr. Called by the fakes, never at import.
 */
export function guardPipes() {
  const broken = () => {
    if (pipes.survive) {
      if (!pipes.broken) pipes.onBroken?.();
      pipes.broken = true;
      return;
    }
    process.exit(1);
  };
  process.stdout.on('error', broken);
  process.stderr.on('error', broken);
}
/** The step `surviveClosedStdout` turns guardPipes' exit into "stop writing, keep working". */
const pipes = { survive: false, broken: false, onBroken: undefined };

/**
 * The SIGINT exit of each vendor's CLI (team-probes.md TP KR): codex exit 1 within 0.5 s, cursor
 * 130, agy 1. Claude's code was not recorded (it "stopped in 1.1 s"); 1 is assumed here.
 */
export const SIGINT_EXIT = { claude: 1, codex: 1, cursor: 130, gemini: 1 };

/* ========================================================================= *
 * PART B — the suite helpers
 * ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The fake file of each vendor and the CLI name it is installed under. */
export const FAKE_FILES = {
  claude: { file: 'team-fake-claude.mjs', cli: 'claude' },
  codex: { file: 'team-fake-codex.mjs', cli: 'codex' },
  cursor: { file: 'team-fake-cursor.mjs', cli: 'cursor-agent' },
  gemini: { file: 'team-fake-agy.mjs', cli: 'agy' },
};

/**
 * A stand-in stdio MCP server for the fakes' own checks (no host): it records its argv, its
 * environment's names, its parent pid and every request in `<its argv[2]>` (a JSONL file), answers
 * `initialize`, `tools/list` (one tool, `echo`, and the five team tool names) and `tools/call`
 * (the arguments echoed), exits on stdin EOF, and — like the team server (A2) — when its parent
 * pid changes (2 s poll).
 */
export const PROBE_MCP_SERVER = `#!/usr/bin/env node
const fs = require('fs');
const out = process.argv[2];
const rec = (r) => { try { fs.appendFileSync(out, JSON.stringify({ pid: process.pid, t: Date.now(), ...r }) + '\\n'); } catch {} };
rec({ ev: 'start', argv: process.argv.slice(2), envKeys: Object.keys(process.env).sort(), env: { CCO_DISPATCHED_TASK: process.env.CCO_DISPATCHED_TASK ?? null, CCO_TEAM_MEMBER: process.env.CCO_TEAM_MEMBER ?? null }, ppid: process.ppid });
const ppid0 = process.ppid;
setInterval(() => { if (process.ppid !== ppid0) { rec({ ev: 'exit', why: 'parent changed' }); process.exit(0); } }, 2000);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    rec({ ev: 'request', method: m.method });
    if (m.id === undefined) continue;
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } };
    else if (m.method === 'tools/list') result = { tools: ['echo', 'team_board', 'team_inbox', 'team_send', 'team_claim', 'team_update'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'ECHO ' + JSON.stringify(m.params) }], isError: false };
    else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => { rec({ ev: 'exit', why: 'stdin ended' }); process.exit(0); });
`;

/**
 * Install the fakes into `<root>`: `bin/` (launchers, node, git shim), `fakes/` (the modules) and
 * `fakes/state/`. `opts.cliJs` is the bundled cli.js a `runCco` step runs; `opts.node` the node
 * binary (default the running one). Returns the paths.
 */
export function installFakes(root, opts = {}) {
  const node = opts.node ?? process.execPath;
  const binDir = path.join(root, 'bin');
  const fakesDir = path.join(root, 'fakes');
  const stateDir = path.join(fakesDir, 'state');
  for (const d of [binDir, fakesDir, stateDir, path.join(stateDir, 'scripts'), path.join(stateDir, 'git-fail'), path.join(stateDir, 'git-hang')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  try {
    fs.symlinkSync(node, path.join(binDir, 'node'));
  } catch {
    // already there
  }
  fs.copyFileSync(path.join(HERE, 'team-fakes.mjs'), path.join(fakesDir, 'team-fakes.mjs'));
  const launchers = {};
  for (const [vendor, { file, cli }] of Object.entries(FAKE_FILES)) {
    fs.copyFileSync(path.join(HERE, file), path.join(fakesDir, file));
    const launcher = path.join(binDir, cli);
    // `exec -a "$0"`: argv[0] stays `<bin>/<cli>`, which is what `ps` shows and isOurWorker reads.
    fs.writeFileSync(launcher, `#!/bin/bash\nexec -a "$0" ${shq(node)} ${shq(path.join(fakesDir, file))} "$@"\n`);
    fs.chmodSync(launcher, 0o755);
    launchers[vendor] = launcher;
  }
  const realGit = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((g) => fs.existsSync(g)) ?? '/usr/bin/git';
  const gitShim = path.join(binDir, 'git');
  fs.writeFileSync(
    gitShim,
    [
      '#!/bin/bash',
      '# The harness git shim (team-fakes.mjs): the first subcommand of the call can be told to fail or hang.',
      `STATE=${shq(stateDir)}`,
      'op=""',
      'skip=0',
      'for a in "$@"; do',
      '  if [ $skip -eq 1 ]; then skip=0; continue; fi',
      '  case "$a" in',
      '    -C|-c|--git-dir|--work-tree) skip=1 ;;',
      '    -*) ;;',
      '    *) op="$a"; break ;;',
      '  esac',
      'done',
      'if [ -n "$op" ] && [ -f "$STATE/git-fail/$op" ]; then',
      '  echo "{\\"ev\\":\\"git-fail\\",\\"op\\":\\"$op\\",\\"pid\\":$$}" >> "$STATE/log.jsonl"',
      '  echo "fatal: $(cat "$STATE/git-fail/$op")" >&2',
      '  exit 128',
      'fi',
      'if [ -n "$op" ] && [ -f "$STATE/git-hang/$op" ]; then',
      '  echo "{\\"ev\\":\\"git-hang\\",\\"op\\":\\"$op\\",\\"pid\\":$$}" >> "$STATE/log.jsonl"',
      '  exec /bin/sleep 3600',
      'fi',
      `exec ${shq(realGit)} "$@"`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(gitShim, 0o755);
  const probeServer = path.join(fakesDir, 'probe-mcp-server.cjs');
  fs.writeFileSync(probeServer, PROBE_MCP_SERVER);
  const logFile = path.join(stateDir, 'log.jsonl');
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ logFile, node, binDir, cliJs: opts.cliJs ?? null }, null, 2));
  return { root, binDir, fakesDir, stateDir, logFile, launchers, gitShim, realGit, probeServer, node };
}

/** A single-quoted shell word. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Script a member's turns: `steps[k]` is turn k+1; `fallback` every turn after them. `member` '_default' scripts every member without its own. */
export function scriptMember(inst, member, steps, fallback) {
  fs.writeFileSync(path.join(inst.stateDir, 'scripts', `${member}.json`), JSON.stringify({ turns: steps ?? [], ...(fallback ? { fallback } : {}) }, null, 2));
}
/** Forget a member's turn counter (the next turn uses steps[0] again). */
export function resetCounter(inst, vendor, member) {
  fs.rmSync(path.join(inst.stateDir, 'counters', `${vendor}-${member}`), { force: true });
}
/** The text a step override is spelled with inside a message body. */
export function stepDirective(step) {
  return `[[fake-step:${JSON.stringify(step)}]]`;
}
/** Make `vendor`'s `account` (the basename of its config dir / home) read as logged out (`out`) or in. */
export function setAuth(inst, vendor, account, state) {
  const f = path.join(inst.stateDir, 'auth', vendor, account);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (state === 'out') fs.writeFileSync(f, 'out');
  else fs.rmSync(f, { force: true });
}
/** Make the git subcommand `op` fail (`text`) — or, with `text === undefined`, work again. */
export function gitFail(inst, op, text) {
  const f = path.join(inst.stateDir, 'git-fail', op);
  if (text === undefined) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, text);
}
/** Make the git subcommand `op` hang until killed — or work again (`on === false`). */
export function gitHang(inst, op, on = true) {
  const f = path.join(inst.stateDir, 'git-hang', op);
  if (on) fs.writeFileSync(f, '1');
  else fs.rmSync(f, { force: true });
}
/** Delete a conversation from a vendor's store (the next resume of it is a "missing id", RP-9). */
export function forgetConversation(inst, vendor, id) {
  fs.rmSync(path.join(inst.stateDir, 'conversations', vendor, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`), { force: true });
}
export function conversationKnown(inst, vendor, id) {
  return fs.existsSync(path.join(inst.stateDir, 'conversations', vendor, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`));
}

/** Every record of the fakes' log. */
export function fakeLog(inst) {
  let raw;
  try {
    raw = fs.readFileSync(inst.logFile, 'utf8');
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
/** The TURN invocations (start records of kind `turn`), optionally of one vendor / member. */
export function turnStarts(inst, { vendor, member } = {}) {
  return fakeLog(inst).filter((r) => r.ev === 'start' && r.kind === 'turn' && (vendor === undefined || r.vendor === vendor) && (member === undefined || r.member === member));
}
/** Every record of one fake process. */
export function recordsOfPid(inst, pid) {
  return fakeLog(inst).filter((r) => r.pid === pid);
}
/** The prompt a fake process received (after a file indirection). */
export function promptOfPid(inst, pid) {
  const rec = fakeLog(inst).find((r) => r.pid === pid && r.ev === 'prompt');
  if (!rec) return undefined;
  try {
    return fs.readFileSync(rec.file, 'utf8');
  } catch {
    return undefined;
  }
}
/** The `end` record of a fake process. */
export function endOfPid(inst, pid) {
  return fakeLog(inst).find((r) => r.pid === pid && r.ev === 'end');
}
/** The argv values that follow flag `flag` in an argv (variadic: every value up to the next `-` flag). */
export function flagValues(argv, flag, variadic = false) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  if (!variadic) return argv[i + 1];
  const vals = [];
  for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('-'); j++) vals.push(argv[j]);
  return vals;
}
