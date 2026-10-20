import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { TextDecoder } from 'util';
import {
  BOARD_ID,
  COMMAND_SPELLING,
  DISPATCHED_TASK_ENV,
  EXIT,
  footerReserveChars,
  HOST_ARG,
  HOST_LOG_ROTATE_BYTES,
  HOST_REFUSED_EXIT,
  HOST_START_TIMEOUT_MS,
  IDS_MAX,
  LAUNCH_HOST_ARG,
  LINE_MAX_BYTES,
  MEMBER_NAME,
  MESSAGE_ID,
  METHOD,
  METHOD_TEAM,
  OUT_CAP_CHARS,
  OUT_CAP_ENV_MARGIN,
  OUT_CAP_MIN_ENV,
  OUTPUT_SUBDIR,
  PROTOCOL_VERSION,
  RECENT_DEFAULT,
  RECENT_MAX,
  REQUEST_MAX_BYTES,
  RPC_ERROR,
  SOCKET_PATH_MAX_BYTES,
  START_LOCK_STALE_MS,
  STATUS_WAIT_CLIENT_SLACK_MS,
  TASK_FILE_DIR,
  TASK_FILE_DIR_GITIGNORE,
  TASK_FILE_KEYS,
  TASK_ID,
  TASK_JSON_MAX_BYTES,
  TEAM_FEATURE,
  TEAM_FEATURE_MISSING_SENTENCE,
  TEAM_FOOTER_RESERVE_CHARS,
  TEAM_ID,
  TEAM_MCP_ARG,
  TEAM_MCP_SERVER_NAME,
  TEAM_MEMBER_ENV,
  TEAM_NAME,
  WAIT_MAX_SECONDS,
  hostFilesOf,
  runDirOf,
  sameProcess,
  serverHashOf,
  socketPathFor,
  type HelloParams,
  type HelloResult,
  type HostSpec,
  type MemberHelloParams,
  type ProcessIdentity,
} from './host-protocol';
import { connectHost, helloResultOf, HostConnection, type HostClient, type HostConnectionEnd } from './host-client';
import { ROOT_DIR, processStartedAt } from '../registry';
import { negotiateMcpProtocol } from '../platform';
import { parseProvider, PROVIDER_IDS } from '../providers';
import {
  CREDENTIAL,
  hasControlChar,
  MEMBER_KEYS,
  MEMBER_OP_NOW_OPS,
  MEMBER_SWITCH_KEYS,
  MESSAGE_FILE_KEYS,
  SETUP_KEYS,
  TASK_KEYS,
  TASK_OP_KEYS,
  TEAM_FILE_CAPS,
  TEAM_FILE_KEYS,
  TEAM_MCP_RECONNECT_MS,
  TEAM_TEXT,
  TEAM_TOOL_DEFINITIONS,
  TEAM_TOOL_NAMES,
  TEAM_TOOL_TEXT,
  TOOL_SPEC_MAX_BYTES,
  toolRefusal,
  WAIT_SETTLE_DEFAULT_S,
  WAIT_SETTLE_FLAG,
  WAIT_SETTLE_MAX_S,
  WORKER_FLAG_MAX_CHARS,
  WORKTREE_KEYS,
} from '../team/contract';
import {
  DISPATCH_BATCH_MAX_TASKS,
  DISPATCH_PROMPT_MAX_BYTES,
  DISPATCH_SYSTEM_PROMPT_MAX_BYTES,
  UNTITLED_TASK,
} from './dispatch-args';

/**
 * cco — the dispatch operations WITHOUT MCP (contract-2.0-fixes.md §15.3). The orchestrating
 * Claude session runs `~/.claude-code-orchestrator/bin/cco <operation> …` through its Bash tool;
 * this file is what the launcher execs. It is a THIN client: parse the command line, read the
 * task files, connect to this session's dispatch host over its Unix socket (starting the host when
 * there is none), send ONE JSON-RPC request, print the answer, exit with a code of
 * host-protocol EXIT. Everything the MCP server knows how to do stays in the host (server.ts in
 * `--host` mode, mcp/host.ts); nothing of it is re-implemented here.
 *
 * ITS READER IS A MODEL. Whoever reads stdout, stderr and the exit code is a language model that
 * cannot ask a follow-up question, so every line says exactly what happened and what to do next,
 * and every way out is ONE code of EXIT — 0 / 20 the host answered (stdout), 21 the command or a
 * task file is wrong and nothing was sent (stderr), 22 cco cannot run here or lost its host
 * (stderr), 23 a `--wait` ran out and the work goes on, 24 a signal ended the waiting and the work
 * goes on. A fault of this file at run time is a 22 that says so (uncaughtException /
 * unhandledRejection end in finish() too); only a bundle that cannot even load ends in Node's own
 * code, which the policy reads as "cco itself is broken".
 *
 * IN THIS ORDER (§15.3): help / version, which run anywhere; the environment (win32, the
 * dispatched-worker marker, Node ≥ 18, CLAUDE_PID), before anything else is read; the command
 * line and the task files — everything of §15.3.1 and §15.3.2 is judged BEFORE a connection is
 * made, so a usage error never starts a host; then the connection (§15.4), the request, the
 * answer (§15.3.4).
 *
 * NO PROMPT IS EVER PARSED BY A SHELL. Prompts, system prompts and titles exist only in files the
 * model wrote with its Write tool; they are read here as bytes (non-blocking open, fstat, capped
 * read, strict UTF-8) and travel as JSON strings. No stdin is read, ever. Every process this file
 * starts is started with execFile / spawn and an argv — never through a shell.
 *
 * THE HOST IS NEVER A CHILD OF THIS PROCESS. The Bash tool may move a long foreground command to
 * the background or end it; nothing it ends may reach the host. So the host is started through an
 * INTERMEDIATE (`cli.js --cco-launch-host <spec>`, launchHostIntermediate below) spawned detached
 * with stdio 'ignore', which spawns the host detached and exits at once: the host's parent is then
 * launchd / init, and this process holds no ChildProcess of it — it waits only for the host's
 * socket to answer, or for its fail file.
 *
 * WRITING (§15.3.4). stdout carries the answer and the pinned lines only; stderr the pinned lines
 * (`cco: accepted …`, `cco: settled …`, the skew line) and at most five diagnostic lines of at
 * most 300 characters. Three lines other clauses pin are written WHOLE instead, each stated where
 * it is written: a host's fail sentence (hostRefused — the sandbox refusal is longer than 300 and
 * ends with its remedy), the host-ended line with its ids (onCallGone), and the log's last five
 * lines after a start that timed out (startTimedOut — a sixth stderr line). Everything written
 * to stderr is counted against the answer's cap (outCap — §15.12 M3: the two streams are one
 * output to Claude Code). The process never ends with output pending: every way out goes through
 * finish(), which sets process.exitCode, stops all writing, releases what this process holds (the
 * start lock, the socket, timers, a running lsof or ps) and lets the event loop drain — a pending
 * write keeps the loop alive until it is flushed. EPIPE on either stream is swallowed. The
 * streams are deliberately NOT `.end()`ed: on a socketpair shared by fd 1 and fd 2 (which is what
 * a parent that merges the two hands over) ending stdout shuts the socket's write side down for
 * stderr too, and could cut the stderr lines still queued behind it; draining the loop flushes
 * both without that hazard.
 *
 * TEAM MODE (team contract §7.2–§7.5, §3.7, §3.9). The lead's team operations are `cco team_*`
 * commands (team ops are cco-only in 2.0): the same thin client — files read here with the
 * §15.3.2 reader and judged for their KEYS only (an unknown key is 21 naming the closest allowed
 * one), flags judged by value, every value of meaning judged by the host's engine (20). Every
 * answer that reached the host may carry the unread team footer (TextResult.footer), printed as
 * the LAST line of stdout inside FOOTER_RESERVE (host-protocol footerReserveChars — the one
 * reserve the host composes the lead's inbox under, so the two sides cut alike). A shell that
 * belongs to a teammate (CCO_TEAM_MEMBER) is refused before everything but help and version.
 * And `cli.js --team-mcp <tool-spec>` is not `cco` at all: it is a teammate's team MCP server
 * (runTeamMcp, at the end of this file) — a stdio MCP server that forwards its tools/calls over
 * the host's socket on a member connection whose identity comes from its ARGUMENT's files only.
 *
 * Node built-ins only; must not import 'vscode'. Bundled by esbuild into `out/mcp/cli.js` and
 * installed beside `server.js` in `<data root>/mcp/`, which is how `path.join(__dirname,
 * 'server.js')` names the server this client starts and hashes.
 */

/**
 * The extension version `cco version` prints — the same literal as server.ts SERVER_INFO.version,
 * and kept in step with package.json the same way (by hand, at a release). Stated residual: the
 * release procedure bumps package.json only, so a release that forgets both literals ships a
 * server and a cco that call themselves by the old number; `protocol` and the server hash on the
 * same line are what identify a build.
 */
const CCO_VERSION = '2.0.0';

/** JSON-RPC request ids of this client's two requests: the hello, then the one operation. */
const HELLO_ID = 1;
const REQUEST_ID = 2;

/** How often the start poll looks for the host's socket and its fail file (§15.3 step 5). */
const HOST_POLL_MS = 100;
/** How often a client waiting for ANOTHER client's start re-reads that client's lock. */
const LOCK_RECHECK_MS = 1_000;
/**
 * A lock whose content cannot be read as `{pid, startedAt}` is judged by its age alone: younger
 * than this it is taken to be one being written right now (the starter creates it, then writes
 * it), older its writer died before writing it — a holder that is gone. A lock that holds an
 * identity is judged by its holder and, once older than START_LOCK_STALE_MS, by whether a process
 * of its spec is alive (§15.12 L11 — judgeLock).
 */
const LOCK_BEING_WRITTEN_MS = 2_000;
/** The bound on one connect to the socket (a Unix-socket connect answers at once or fails). */
const CONNECT_TIMEOUT_MS = 5_000;
/** `lsof` on macOS is given this long to name the session process's cwd (§15.3 step 4). */
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_PATH = '/usr/sbin/lsof';
/**
 * The environment of the system tools this client runs — lsof and ps — EXACTLY this, nothing of
 * the Bash environment (§15.12 H1). lsof prints every byte of a name that is not printable in the
 * CURRENT locale as `\xNN`, and the Bash tool's environment often has no LANG / LC_* at all (VS
 * Code started from the Dock, no `export LANG` in the shell files): a project directory named in
 * Korean then reached this client as `/…/\xed\x95\x9c…`, and every cco command of that session
 * ended in 22. Under `en_US.UTF-8` lsof prints such characters as themselves; `C.UTF-8` does not
 * do that on macOS (probed 2026-10-15). decodeLsofName undoes the escapes whether or not the
 * locale took effect.
 */
const SYSTEM_TOOL_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'en_US.UTF-8' };
/** The most of lsof's name the 22 quotes (§15.12 H1). */
const LSOF_NAME_SHOWN_MAX_CHARS = 200;
/** `ps` is given this long to list the processes (hostProcessOfSpec — §15.12 M5, L11). */
const PS_TIMEOUT_MS = 5_000;
/** The most one process listing may print: a busy machine's whole table, untruncated (`-ww`). */
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * §15.12 M5: after a start, the socket must have read "none" for this long — and no process of the
 * spec be alive — before ONE more start is made.
 */
const RESTART_AFTER_NONE_MS = 3_000;
/** From then on, how often `ps` is asked again (each ask lists every process of the machine). */
const HOST_PROCESS_RECHECK_MS = 1_000;

/**
 * §15.12 M3: the cap of the answer, less what this invocation already wrote to stderr, never goes
 * below this — a batch's accepted / settled lines must never leave the answer itself without room.
 */
const OUT_CAP_FLOOR_CHARS = 8_000;
/** §15.3.4: the longest title an `accepted` line shows. */
const ACCEPTED_TITLE_MAX_CHARS = 120;
/** §15.3.4: at most this many diagnostic lines, each at most this long (the `cco: ` included). */
const DIAGNOSTICS_MAX = 5;
const DIAGNOSTIC_MAX_CHARS = 300;
/** §15.3 step 5: the log lines quoted when the host did not start — how many, and how long. */
const LOG_TAIL_LINES = 5;
const LOG_TAIL_LINE_MAX_CHARS = 200;
/** How much of the log's end is read to find those lines. */
const LOG_TAIL_READ_BYTES = 64 * 1024;
/** Caps on the small files of the run directory read here: record, lock, fail file, spec. */
const RECORD_MAX_BYTES = 64 * 1024;
const LOCK_MAX_BYTES = 4 * 1024;
const FAIL_MAX_BYTES = 8 * 1024;
const SPEC_MAX_BYTES = 64 * 1024;
/** The largest piece one read asks for; a capped read takes as many as the cap allows. */
const READ_CHUNK_BYTES = 1024 * 1024;
/** `--model` (§15.3.1): the host's own limit (server.ts BRIEFING_MODEL_MAX_CHARS). */
const MODEL_MAX_CHARS = 100;
/** `--job` / `--name` (§15.3.1): the host's own limit (server.ts MESH_STOP_KEY_MAX_CHARS). */
const MESH_KEY_MAX_CHARS = 200;
/** The longest a path is quoted in a message (its end is kept). */
const PATH_SHOWN_MAX_CHARS = 120;
/** The longest a host's fail sentence is printed (§15.2 step 2 — it is printed whole up to this). */
const FAIL_SENTENCE_MAX_CHARS = 1_000;
/** Unknown task keys longer than this are not compared with the allowed ones. */
const KEY_COMPARE_MAX_CHARS = 64;
/** The longest a task-key typo may be from an allowed key to be named as "did you mean". */
const KEY_SUGGEST_MAX_DISTANCE = 3;

/** The one skew line of §15.2 step 6, verbatim. */
const SKEW_LINE =
  "cco: ⚠ this session's dispatch host runs an earlier build; start a new Claude Code session to use the new one.";

/* ------------------------------------------------------------------------- *
 * Text
 * ------------------------------------------------------------------------- */

/** C0, DEL, C1 and the two Unicode line separators: what must never reach a line of output. */
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** One line: every run of control characters becomes one space. */
function oneLine(value: string): string {
  return value.replace(CONTROL_RUN, ' ');
}

/** At most `max` UTF-16 units, never ending between the two halves of a surrogate pair. */
function sliceChars(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  let end = Math.max(0, max);
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
  }
  return value.slice(0, end);
}

/** A token, key or path quoted in a message: one line, at most `max` characters, `…` when cut. */
function shown(value: string, max = 80): string {
  const line = oneLine(value);
  return line.length <= max ? line : `${sliceChars(line, max - 1)}…`;
}

/** A byte cap as the messages say it: `16 MiB`, `256 KiB`, or a plain count. */
function bytesLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The errno code of a caught value (`ENOENT`, …), or undefined when it carries none. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return undefined;
}

/** A caught value in words, one bounded line. Never throws. */
function describe(err: unknown): string {
  try {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return shown(text, 200) || 'no description';
  } catch {
    return 'no description';
  }
}

/* ------------------------------------------------------------------------- *
 * Writing, and the one way out
 * ------------------------------------------------------------------------- */

/** Set once the exit code is decided: from then on nothing is written and nothing is started. */
let finished = false;
let diagnosticsWritten = 0;
/**
 * The characters this invocation has written to stderr so far, line ends included (§15.12 M3):
 * Claude Code shows a command's stdout and stderr as ONE output, so they share its room — outCap
 * takes them off the cap of the answer. Counted as the cap is measured: in UTF-16 units.
 */
let stderrChars = 0;

/**
 * What finish() releases: the start lock, the socket, timers, a running lsof or ps. Each entry
 * removes itself once it no longer needs releasing; finish() runs whatever is left, once.
 */
const cleanups = new Set<() => void>();

/** One line on stderr as it is (the pinned lines). Never throws; EPIPE arrives as an event. */
function writeErrLine(line: string): void {
  stderrChars += line.length + 1;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // no stderr to write to
  }
}

/** Text on stdout as it is. Never throws. */
function writeOut(text: string): void {
  if (text === '') {
    return;
  }
  try {
    process.stdout.write(text);
  } catch {
    // no stdout to write to
  }
}

/**
 * One diagnostic line on stderr (§15.3.4): `cco: ` and one line of at most 300 characters, and at
 * most five of them in one run — a sixth is dropped, so that what a model reads stays bounded.
 */
function writeDiagnostic(line: string): void {
  if (diagnosticsWritten >= DIAGNOSTICS_MAX) {
    return;
  }
  diagnosticsWritten++;
  writeErrLine(sliceChars(`cco: ${oneLine(line)}`, DIAGNOSTIC_MAX_CHARS));
}

/**
 * THE way out. Decides the exit code once — a second call, from a handler that fired late, does
 * nothing — releases everything this process holds, writes the last lines and lets the process
 * end by itself. `stderrLines` are diagnostics (writeDiagnostic); `pinnedErrLines` go out as they
 * are — the one pinned stderr line that can outgrow 300 characters (the host-ended line with its
 * ids) uses it.
 */
function finish(
  code: number,
  stdoutText = '',
  stderrLines: readonly string[] = [],
  pinnedErrLines: readonly string[] = [],
): void {
  if (finished) {
    return;
  }
  finished = true;
  process.exitCode = code;
  for (const release of [...cleanups]) {
    try {
      release();
    } catch {
      // releasing is best effort; the exit code is already decided
    }
  }
  cleanups.clear();
  for (const line of stderrLines) {
    writeDiagnostic(line);
  }
  for (const line of pinnedErrLines) {
    writeErrLine(line);
  }
  writeOut(stdoutText);
}

/**
 * A decided way out raised from deep inside the run: main()'s catch hands it to finish(). Used
 * only for 21 and 22 (and to unwind after finish() already ran); every other code is decided
 * where it happens.
 */
class CcoExit extends Error {
  constructor(
    readonly code: number,
    /** Diagnostic lines (at most five are written, each cut to 300 characters). */
    readonly lines: readonly string[],
    /** Lines written as they are, after the diagnostics (the quoted log lines of a failed start). */
    readonly pinned: readonly string[] = [],
  ) {
    super('cco exit');
  }
}

/** 22: cco cannot run here, or lost its host. */
function cannotRun(...lines: string[]): never {
  throw new CcoExit(EXIT.cannotRun, lines);
}

/**
 * The errno codes a sandbox gives a refused file or socket operation. Claude Code's sandbox (F8)
 * can refuse THIS process — creating the run directory, writing the lock or the spec, connecting
 * to a Unix socket — before any host exists to give §15.2 step 2d's refusal; then the bare errno
 * is followed by the remedy that refusal would have named.
 */
const SANDBOX_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EROFS']);

const SANDBOX_HINT =
  "If Claude Code's sandbox is on, that is why: run cco as one simple command (no pipe, redirection or cd) " +
  `and ask the user to run the VS Code command "Claude Code Orchestrator: Update Workspace Setup" and check "Allow cco without a prompt" — it adds \`${COMMAND_SPELLING} *\` to sandbox.excludedCommands.`;

/** 22 for a file or socket operation this process could not do, with the sandbox remedy when the code fits. */
function cannotRunOn(sentence: string, code: string | undefined): never {
  throw new CcoExit(EXIT.cannotRun, code !== undefined && SANDBOX_CODES.has(code) ? [sentence, SANDBOX_HINT] : [sentence]);
}

/** Unwind a flow that is still running after finish() decided the code (a signal, a timer). */
function stopIfFinished(): void {
  if (finished) {
    throw new CcoExit(EXIT.signal, []);
  }
}

/** Whatever a run, a handler or a timer threw: a decided exit, or a defect of this file (22). */
function finishFrom(err: unknown): void {
  if (err instanceof CcoExit) {
    finish(err.code, '', err.lines, err.pinned);
    return;
  }
  finish(EXIT.cannotRun, '', [`cco stopped on an internal error — a defect in cco, not in the command: ${describe(err)}`]);
}

/** A handler that can never throw out of the event it handles. */
function guarded<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      handler(...args);
    } catch (err) {
      finishFrom(err);
    }
  };
}

/**
 * Wait `ms`, unless finish() comes first (it clears the timer; the promise then never settles —
 * which holds nothing open, so the process still ends). After finish() nothing is started at all.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (finished) {
      return;
    }
    const release = (): void => clearTimeout(timer);
    const timer = setTimeout(() => {
      cleanups.delete(release);
      resolve();
    }, ms);
    cleanups.add(release);
  });
}

/* ------------------------------------------------------------------------- *
 * The operations (§15.3.1), help and version (§15.3 step 1)
 * ------------------------------------------------------------------------- */

type OperationName =
  | 'orchestrator_briefing'
  | 'list_workers'
  | 'dispatch_task'
  | 'dispatch_tasks'
  | 'dispatch_status'
  | 'cancel'
  | 'recent'
  | 'mesh_status'
  | 'mesh_stop_worker'
  | TeamOperationName;

/** The lead's team operations (team contract §7.2): TEAM_OPS, and team_wait (the held cco/team.wait). */
type TeamOperationName =
  | 'team_create'
  | 'team_add'
  | 'team_send'
  | 'team_inbox'
  | 'team_wait'
  | 'team_status'
  | 'team_task'
  | 'team_member'
  | 'team_attach'
  | 'team_end'
  | 'team_resume';

/** The team operations whose one argument is a JSON file (§7.3), and what each file is called. */
const TEAM_FILE_OPS = {
  team_create: 'team file',
  team_add: 'members file',
  team_send: 'message file',
  team_task: 'task-op file',
} as const;
type TeamFileOp = keyof typeof TEAM_FILE_OPS;

/** The flags of team_member that name its operation — exactly one is given (§7.2). */
const MEMBER_OP_FLAGS = ['--stop', '--restart', '--pause', '--unpause', '--interrupt', '--switch'] as const;

interface OperationSpec {
  /** The usage line after COMMAND_SPELLING. */
  usage: string;
  /** The one sentence `help` gives it. */
  sentence: string;
  /** Flags that take the next argv element as their value. */
  valueFlags: readonly string[];
  /** Flags that take no value. */
  switches: readonly string[];
  /** What its positional arguments are. */
  positionals: 'none' | 'file' | 'ids' | 'member';
}

const OPERATIONS: Readonly<Record<OperationName, OperationSpec>> = {
  orchestrator_briefing: {
    usage: 'orchestrator_briefing --model <id>',
    sentence:
      "Register this session's exact model id (verbatim from your system prompt) and print the operating brief — run it once, before the first dispatch.",
    valueFlags: ['--model'],
    switches: [],
    positionals: 'none',
  },
  list_workers: {
    usage: 'list_workers [--check] [--diagnostics]',
    sentence:
      'List the worker accounts with their models, usage, cooldowns, plan limits and login state (each Claude Code account line ends with it and its age) — check it before a large fan-out; --check re-probes every Claude Code account live first (at most 15 s), --diagnostics adds each account\'s last login probes for a support question.',
    valueFlags: [],
    switches: ['--check', '--diagnostics'],
    positionals: 'none',
  },
  dispatch_task: {
    usage: 'dispatch_task <task file> [--wait <s> | --no-wait]',
    sentence:
      'Run the one task of a task file on a worker account and print its result; its id is printed on stderr at once.',
    valueFlags: ['--wait'],
    switches: ['--no-wait'],
    positionals: 'file',
  },
  dispatch_tasks: {
    usage: 'dispatch_tasks <batch file> [--wait <s> | --no-wait]',
    sentence:
      'Run every task of a batch file {"tasks": [...]} in parallel and print all their results; their ids are printed on stderr at once.',
    valueFlags: ['--wait'],
    switches: ['--no-wait'],
    positionals: 'file',
  },
  dispatch_status: {
    usage: 'dispatch_status [--wait <s>] <id> …',
    sentence:
      'Print the state of tasks by id, with the result of each one that has finished; --wait <s> answers as soon as all have finished, or after <s> seconds.',
    valueFlags: ['--wait'],
    switches: [],
    positionals: 'ids',
  },
  cancel: {
    usage: 'cancel <id> …',
    sentence: 'Stop tasks by id — a queued one never starts — and print one line per id saying what was done.',
    valueFlags: [],
    switches: [],
    positionals: 'ids',
  },
  recent: {
    usage: 'recent [--limit <n>] [--team]',
    sentence: `List this workspace's latest tasks, newest first (${RECENT_DEFAULT} unless --limit says another number up to ${RECENT_MAX}) — for when you have lost their ids; --team lists your team's turns instead.`,
    valueFlags: ['--limit'],
    switches: ['--team'],
    positionals: 'none',
  },
  mesh_status: {
    usage: 'mesh_status',
    sentence:
      "Show Mesh Mode's session workers of this workspace: their tasks, accounts, states, job ids and how to message, attach to or stop each.",
    valueFlags: [],
    switches: [],
    positionals: 'none',
  },
  mesh_stop_worker: {
    usage: 'mesh_stop_worker (--job <id> | --name <name>) [--force]',
    sentence:
      'Stop one session worker, named by its job id from mesh_status (or by its name); --force kills it when the clean stop fails.',
    valueFlags: ['--job', '--name'],
    switches: ['--force'],
    positionals: 'none',
  },
  team_create: {
    usage: 'team_create <team file>',
    sentence:
      'Teammate mode: create a team from a team file (goal, members, board tasks); it answers at once and the members start in their own worktrees.',
    valueFlags: [],
    switches: [],
    positionals: 'file',
  },
  team_add: {
    usage: 'team_add <members file>',
    sentence: 'Add members (and board tasks) to your team from a file {"members": [...], "tasks": [...]}.',
    valueFlags: [],
    switches: [],
    positionals: 'file',
  },
  team_send: {
    usage: 'team_send <message file>',
    sentence: 'Send one message (to, text or text_file, kind, urgent, reply_to, task) to a teammate, or to all.',
    valueFlags: [],
    switches: [],
    positionals: 'file',
  },
  team_inbox: {
    usage: 'team_inbox [--all]',
    sentence: "Print your unread team messages, oldest first, and mark the ones shown read; --all prints the last 50 and marks nothing.",
    valueFlags: [],
    switches: ['--all'],
    positionals: 'none',
  },
  team_wait: {
    usage: 'team_wait [--wait <s>] [--settle <s>]',
    sentence:
      'Run with run_in_background while the team works: it exits as soon as a teammate needs you (printing the messages, exit 0), or after --wait <s> (exit 23); --settle <s> (0 to 300, default 20) batches what follows the first.',
    valueFlags: ['--wait', '--settle'],
    switches: [],
    positionals: 'none',
  },
  team_status: {
    usage: 'team_status [--all | --member <name> | --task <id> | --message <id>]',
    sentence:
      "Print your team's state — members, board, warnings; --member, --task or --message one of them in full; --all every team of this repository.",
    valueFlags: ['--member', '--task', '--message'],
    switches: ['--all'],
    positionals: 'none',
  },
  team_task: {
    usage: 'team_task <task-op file>',
    sentence: 'Change the board from a file {"op": "add" | "assign" | "unassign" | "update" | "cancel" | "reopen", …}.',
    valueFlags: [],
    switches: [],
    positionals: 'file',
  },
  team_member: {
    usage:
      'team_member <name> (--stop | --restart | --pause | --unpause | --interrupt | --switch) [--now] [--provider <p>] [--worker <w>] [--model <m>]',
    sentence:
      'Control one teammate: exactly one operation; --now only with --stop or --pause; --provider, --worker, --model only with --switch.',
    valueFlags: ['--provider', '--worker', '--model'],
    switches: [...MEMBER_OP_FLAGS, '--now'],
    positionals: 'member',
  },
  team_attach: {
    usage: 'team_attach <name>',
    sentence: "Print the command line that takes over a Claude teammate's conversation in a terminal, for the user; it changes nothing.",
    valueFlags: [],
    switches: [],
    positionals: 'member',
  },
  team_end: {
    usage: 'team_end [--now]',
    sentence:
      'End your team: running turns finish (--now stops them), worktrees are committed, and every branch is listed with the commands that review and merge it.',
    valueFlags: [],
    switches: ['--now'],
    positionals: 'none',
  },
  team_resume: {
    usage: 'team_resume [--team <id or name>]',
    sentence: "Resume a suspended team of this repository (the one there is, or the one --team names) after its lead's session ended.",
    valueFlags: ['--team'],
    switches: [],
    positionals: 'none',
  },
};

const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];

/** The operation a token names, or undefined. By own key only: `constructor` names nothing. */
function operationOf(token: string): OperationName | undefined {
  return hasOwn(OPERATIONS, token) ? (token as OperationName) : undefined;
}

function usageLine(op: OperationName): string {
  return `usage: ${COMMAND_SPELLING} ${OPERATIONS[op].usage}`;
}

/** The text of `help` (§15.3 step 1): every operation, the flags, where task files go, the codes. */
function helpText(): string {
  const S = COMMAND_SPELLING;
  const lines: string[] = [
    `cco — the Claude Code Orchestrator dispatch operations, run from a Claude Code session's Bash tool as ${S} <operation>.`,
    'Run each as ONE simple command, spelled exactly so: no cd, pipe, redirection, heredoc, $, backticks or &&.',
    '',
  ];
  for (const op of OPERATION_NAMES) {
    lines.push(`  ${S} ${OPERATIONS[op].usage}`, `      ${OPERATIONS[op].sentence}`);
  }
  lines.push(
    `  ${S} help`,
    '      Print this text.',
    `  ${S} version`,
    '      Print the version of cco, its protocol and the build of the dispatch server beside it.',
    '',
    `Waiting: a dispatch waits until every task has finished. --wait <s> (1 to ${WAIT_MAX_SECONDS}) waits at most <s> seconds, then exits 23 while the work goes on; --no-wait prints the task ids once the tasks are accepted and exits 0. Ending or interrupting the command ends only the waiting — never the work; cancel stops work.`,
    '',
    `Task files: write them with your Write tool into the ${TASK_FILE_DIR} directory at the workspace root (git ignores it). A task file is one JSON object with the keys ${TASK_FILE_KEYS.join(', ')} — exactly one of prompt / prompt_file, at most one of system_prompt / system_prompt_file; the prompt goes in its own file, named by prompt_file relative to the JSON file. A batch file is {"tasks": [ ... ]} holding such objects. Never put a prompt, a system prompt or a title on the command line; cco never reads stdin.`,
    '',
    `Team files (team_create, team_add, team_send, team_task) are JSON objects written the same way into ${TASK_FILE_DIR}/; a long text goes in its own file, named by goal_file, brief_file, body_file or text_file relative to the JSON file. A team file has the keys ${TEAM_FILE_KEYS.join(', ')}; a member ${MEMBER_KEYS.join(', ')}; a board task ${TASK_KEYS.join(', ')}; a message ${MESSAGE_FILE_KEYS.join(', ')}. An unknown key is refused (21) naming the closest allowed one. When this session's team has unread messages for you, the last line of every answer says so.`,
    '',
    'Exit codes:',
    '  0   the operation answered — read stdout (a batch whose tasks failed is still 0)',
    '  20  the operation answered with an error, on stdout; nothing was started',
    '  21  the command line or a task file is wrong, and nothing was sent — stderr says why; fix it and run again',
    '  22  cco cannot run here, or lost its dispatch host — stderr says why',
    '  23  --wait ran out; the work goes on — stdout names the ids and the command that reads them',
    '  24  a signal ended the waiting; the work goes on — stdout as for 23',
    '  any other code: cco itself is broken — tell the user to run "Claude Code Orchestrator: Update Workspace Setup", and change nothing under ~/.claude-code-orchestrator',
  );
  return `${lines.join('\n')}\n`;
}

/** `path.join(__dirname, 'server.js')`: the server this client starts, and hashes for the skew check. */
function serverJsPath(): string {
  return path.join(__dirname, 'server.js');
}

/**
 * serverHashOf the server.js beside this file, or undefined when it is not there or cannot be read
 * (`version` prints "missing"; a start refuses). Read whole — it is this product's own bundle in
 * the data root, a few MB. Never throws.
 */
function serverHashBeside(): string | undefined {
  try {
    const file = serverJsPath();
    if (!fs.statSync(file).isFile()) {
      return undefined;
    }
    return serverHashOf(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** `cco <extension version> protocol <n> server <hash or "missing">` (§15.3 step 1). */
function versionLine(): string {
  return `cco ${CCO_VERSION} protocol ${PROTOCOL_VERSION} server ${serverHashBeside() ?? 'missing'}\n`;
}

/* ------------------------------------------------------------------------- *
 * The environment (§15.3 step 2)
 * ------------------------------------------------------------------------- */

const NO_SESSION_SENTENCE =
  "cco runs from a Claude Code session's Bash tool; this shell has no Claude Code session (CLAUDE_PID).";

/** Does process `pid` exist? EPERM says it does (another user's); a pid Node refuses names none. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoOf(err) === 'EPERM';
  }
}

/** The marker's task id as the refusal shows it: one bounded line, `unknown` when empty. */
function markerId(value: string): string {
  const id = shown(value.trim(), 128);
  return id === '' ? 'unknown' : id;
}

/**
 * §15.3 step 2, in the contract's order, each failure one stderr sentence and 22: win32; the
 * teammate marker CCO_TEAM_MEMBER (team contract §3.9, asked before the next one); the
 * dispatched-worker marker (§15.5 — ANY value, the empty string included, counts as set: the
 * refusing direction is the safe one for a guard against the accident; stated: it is not a guard
 * against a hostile worker, which can unset it); Node ≥ 18; CLAUDE_PID, which must be a decimal pid
 * whose process exists. Returns the session's identity `{pid, startedAt}` (§15.1).
 *
 * The start time is registry.processStartedAt (`ps`, ±1–2 s, compared within START_SLACK_MS by
 * sameProcess). A live process whose start time `ps` cannot give is not "no session": that is said
 * as itself, also 22 — the identity cannot be formed, and the hello cannot be sent without it.
 */
function checkEnvironment(): ProcessIdentity {
  if (process.platform === 'win32') {
    cannotRun('cco does not run on Windows in this version; use the cco-dispatch MCP server.');
  }
  // Team contract §3.9: a teammate's shell carries both markers, and is told it is a TEAMMATE's —
  // so this one is asked first. Any value counts, an unreadable one included, as for the other.
  const teammate = process.env[TEAM_MEMBER_ENV];
  if (teammate !== undefined) {
    cannotRun(TEAM_TEXT.ccoTeammateShell(teammate));
  }
  const marker = process.env[DISPATCHED_TASK_ENV];
  if (marker !== undefined) {
    cannotRun(
      `This shell belongs to a dispatched worker (task ${markerId(marker)}); a dispatched worker cannot ` +
        'dispatch, brief or stop workers. Do the task yourself.',
    );
  }
  const major = Number(/^(\d+)\./.exec(process.versions.node)?.[1] ?? NaN);
  if (!Number.isInteger(major) || major < 18) {
    cannotRun(`cco needs Node.js 18 or later; this is ${shown(process.version, 40)}.`);
  }
  const raw = process.env.CLAUDE_PID;
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) {
    cannotRun(NO_SESSION_SENTENCE);
  }
  const pid = Number(raw);
  if (!pidAlive(pid)) {
    cannotRun(NO_SESSION_SENTENCE);
  }
  const startedAt = processStartedAt(pid);
  if (startedAt === undefined) {
    if (!pidAlive(pid)) {
      cannotRun(NO_SESSION_SENTENCE);
    }
    cannotRun(
      `cco could not tell when the Claude Code session process (CLAUDE_PID ${pid}) started — \`ps\` gave ` +
        'no answer — so it cannot name its dispatch host.',
      SANDBOX_HINT,
    );
  }
  return { pid, startedAt };
}

/**
 * This process's own identity, for the start lock's content. Taken from the process's uptime, not
 * from `ps`: exact to the millisecond and spawns nothing, and a reader comparing it with its own
 * `ps` reading (±1–2 s) still finds it within START_SLACK_MS.
 */
function selfIdentity(): ProcessIdentity {
  return { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };
}

/* ------------------------------------------------------------------------- *
 * The command line (§15.3.1)
 * ------------------------------------------------------------------------- */

/** The command line after the checks: only values of the shapes §15.3.1 allows. */
interface Command {
  op: OperationName;
  /** orchestrator_briefing: the model id as given (the host trims and checks it again). */
  model?: string;
  /** dispatch_task / dispatch_tasks / dispatch_status: whole seconds, 1..WAIT_MAX_SECONDS. */
  wait?: number;
  noWait: boolean;
  /** recent: 1..RECENT_MAX. */
  limit?: number;
  /** mesh_stop_worker: exactly one of the two, as given. */
  job?: string;
  name?: string;
  force: boolean;
  /** dispatch_task / dispatch_tasks / the team file operations: the file argument as given. */
  file?: string;
  /** dispatch_status / cancel: the ids, duplicates dropped, first occurrence kept. */
  ids: string[];
  /** team_inbox / team_status `--all`. */
  all: boolean;
  /** recent `--team` (L12). */
  recentTeam: boolean;
  /** list_workers `--check` / `--diagnostics` (Login state (CA)). */
  check: boolean;
  diagnostics: boolean;
  /** team_wait `--settle`: whole seconds, 0..WAIT_SETTLE_MAX_S. */
  settle?: number;
  /** team_status: at most one of the three — MEMBER_NAME, BOARD_ID, MESSAGE_ID. */
  memberFlag?: string;
  taskFlag?: string;
  messageFlag?: string;
  /** team_resume `--team`: a TEAM_ID or a TEAM_NAME. */
  team?: string;
  /** team_member / team_attach: the member's name (MEMBER_NAME). */
  member?: string;
  /** team_member: its one operation, and its options. */
  memberOp?: 'stop' | 'restart' | 'pause' | 'unpause' | 'interrupt' | 'switch';
  now: boolean;
  /** team_member --switch: the provider's id (parseProvider), the worker as given. */
  provider?: string;
  worker?: string;
}

/** 21: one sentence naming the token, then that operation's usage line (§15.3.1). */
function usageError(op: OperationName | undefined, sentence: string): never {
  throw new CcoExit(EXIT.usage, op === undefined ? [sentence] : [sentence, usageLine(op)]);
}

/** 21 for a task file: one sentence; nothing was sent. */
function taskFileError(sentence: string): never {
  throw new CcoExit(EXIT.usage, [sentence]);
}

/** A token not naming an operation (§15.3.1): 21, with the operations and where help is. */
function unknownOperation(token: string): never {
  throw new CcoExit(EXIT.usage, [
    `\`${shown(token)}\` is not a cco operation.`,
    `The operations are ${OPERATION_NAMES.join(', ')}; \`${COMMAND_SPELLING} help\` explains each.`,
  ]);
}

/** The operations whose flag `name` is, for "a flag of another operation". */
function operationsWithFlag(name: string): OperationName[] {
  return OPERATION_NAMES.filter(
    (op) => OPERATIONS[op].valueFlags.includes(name) || OPERATIONS[op].switches.includes(name),
  );
}

/**
 * A one-line text value of a flag (`--model`, `--job`, `--name`): non-empty once trimmed, at most
 * `max` characters once trimmed (the host's own measure), no control character. Returned as given;
 * the host trims and checks it again.
 */
function textFlag(op: OperationName, flag: string, value: string, max: number, what: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    usageError(op, `\`${flag}\` needs ${what}; it was given an empty value.`);
  }
  if (trimmed.length > max) {
    usageError(op, `\`${flag}\` takes at most ${max} characters; it was given ${trimmed.length}.`);
  }
  if (CONTROL_CHAR.test(value)) {
    usageError(op, `\`${flag}\` must be one line of text without control characters; it was given \`${shown(value)}\`.`);
  }
  return value;
}

/**
 * Parse the arguments after the operation. Every violation is 21 with one sentence naming the
 * token and the operation's usage line, and nothing is read or sent:
 *
 *  - flags only as `--name value`, the value being the NEXT argv element whatever it looks like
 *    (`--wait --no-wait` is a `--wait` whose value is not a number); `--name=value` is refused
 *    with the spelling to use; a switch (`--no-wait`, `--force`) takes no value; a flag at most
 *    once; an unknown flag, or one of another operation, refused; `--` is not supported;
 *  - `-` is never standard input — there is none to read;
 *  - a token that starts with `-` is a flag, so no file or id is ever taken for one (a task id is
 *    `t<base36>…` and never starts with `-`; a file named `-x.json` is passed as `./-x.json`);
 *  - the values of §15.3.1, judged by value: `--wait` /^[1-9][0-9]{0,4}$/ and ≤ 86,400 (so `0`,
 *    `1e3`, `""`, `05` and 99999 are refused, not converted); `--limit` /^[1-9][0-9]?$/ and ≤ 50;
 *    `--model` and `--job` / `--name` one line of bounded length; ids TASK_ID, 1..IDS_MAX of them
 *    as given (the count is of the arguments, before duplicates are dropped — the bound is on what
 *    is read, and matches the host's own count of a raw `ids` array).
 */
function parseCommand(op: OperationName, args: readonly string[]): Command {
  const spec = OPERATIONS[op];
  const values = new Map<string, string>();
  const switchesGiven = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      usageError(op, '`--` is not supported: every argument after the operation is a flag or what the operation takes.');
    }
    if (token === '-') {
      usageError(
        op,
        spec.positionals === 'file'
          ? 'write the task to a file with your Write tool — cco never reads stdin, so `-` names no file.'
          : '`-` (standard input) is not supported — cco never reads stdin.',
      );
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const isValueFlag = spec.valueFlags.includes(name);
      const isSwitch = spec.switches.includes(name);
      if (eq !== -1 && isSwitch) {
        usageError(op, `\`${shown(name)}\` takes no value; write it alone, not \`${shown(token)}\`.`);
      }
      if (eq !== -1 && isValueFlag) {
        usageError(op, `write \`${shown(name)} ${shown(token.slice(eq + 1))}\`, not \`${shown(token)}\`.`);
      }
      if (!isValueFlag && !isSwitch) {
        const owners = operationsWithFlag(name);
        usageError(
          op,
          owners.length > 0
            ? `\`${shown(name)}\` is not a flag of ${op} (it belongs to ${owners.join(', ')}).`
            : `unknown flag \`${shown(token)}\`.`,
        );
      }
      if (values.has(name) || switchesGiven.has(name)) {
        usageError(op, `\`${name}\` is given twice; give each flag at most once.`);
      }
      if (isSwitch) {
        switchesGiven.add(name);
        continue;
      }
      if (i + 1 >= args.length) {
        usageError(op, `\`${name}\` needs a value, as the next argument.`);
      }
      i += 1;
      values.set(name, args[i]);
      continue;
    }
    if (token.startsWith('-')) {
      usageError(op, `unknown flag \`${shown(token)}\` — flags are written \`--name value\`.`);
    }
    positionals.push(token);
  }

  const command: Command = {
    op,
    noWait: switchesGiven.has('--no-wait'),
    force: switchesGiven.has('--force'),
    ids: [],
    all: switchesGiven.has('--all'),
    recentTeam: op === 'recent' && switchesGiven.has('--team'),
    check: op === 'list_workers' && switchesGiven.has('--check'),
    diagnostics: op === 'list_workers' && switchesGiven.has('--diagnostics'),
    now: switchesGiven.has('--now'),
  };

  const wait = values.get('--wait');
  if (wait !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(wait) || Number(wait) > WAIT_MAX_SECONDS) {
      usageError(op, `\`--wait ${shown(wait)}\` is not a whole number of seconds from 1 to ${WAIT_MAX_SECONDS}.`);
    }
    if (command.noWait) {
      usageError(op, '`--wait` and `--no-wait` cannot be given together.');
    }
    command.wait = Number(wait);
  }
  const limit = values.get('--limit');
  if (limit !== undefined) {
    if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > RECENT_MAX) {
      usageError(op, `\`--limit ${shown(limit)}\` is not a whole number from 1 to ${RECENT_MAX}.`);
    }
    command.limit = Number(limit);
  }
  const model = values.get('--model');
  if (model !== undefined) {
    command.model = textFlag(op, '--model', model, MODEL_MAX_CHARS, 'your exact model id');
  }
  const job = values.get('--job');
  if (job !== undefined) {
    command.job = textFlag(op, '--job', job, MESH_KEY_MAX_CHARS, 'a job id from mesh_status');
  }
  const name = values.get('--name');
  if (name !== undefined) {
    command.name = textFlag(op, '--name', name, MESH_KEY_MAX_CHARS, 'a worker name from mesh_status');
  }
  if (op === 'orchestrator_briefing' && command.model === undefined) {
    usageError(op, 'orchestrator_briefing needs `--model <your exact model id>`, verbatim from your system prompt.');
  }
  if (op === 'mesh_stop_worker') {
    if (command.job !== undefined && command.name !== undefined) {
      usageError(op, 'give `--job` or `--name`, not both: they can name different workers.');
    }
    if (command.job === undefined && command.name === undefined) {
      usageError(op, 'mesh_stop_worker needs `--job <id>` (the job id mesh_status prints) or `--name <name>`.');
    }
  }
  parseTeamFlags(command, values, switchesGiven);

  switch (spec.positionals) {
    case 'none':
      if (positionals.length > 0) {
        usageError(op, `${op} takes no arguments; \`${shown(positionals[0])}\` is extra.`);
      }
      break;
    case 'file':
      if (positionals.length === 0) {
        usageError(
          op,
          `${op} needs a ${isTeamFileOp(op) ? TEAM_FILE_OPS[op] : op === 'dispatch_tasks' ? 'batch file' : 'task file'}: write it as JSON with your Write tool (in ${TASK_FILE_DIR}/) and pass its path.`,
        );
      }
      if (positionals.length > 1) {
        usageError(op, `${op} takes one file; \`${shown(positionals[1])}\` is extra.`);
      }
      command.file = positionals[0];
      break;
    case 'member': {
      if (positionals.length === 0) {
        usageError(op, `${op} needs the name of a member of your team.`);
      }
      if (positionals.length > 1) {
        usageError(op, `${op} takes one member name; \`${shown(positionals[1])}\` is extra.`);
      }
      if (!MEMBER_NAME.test(positionals[0])) {
        usageError(
          op,
          `\`${shown(positionals[0])}\` is not a member name (1 to 24 lowercase letters, digits or hyphens, starting with a letter).`,
        );
      }
      command.member = positionals[0];
      break;
    }
    case 'ids': {
      if (positionals.length === 0) {
        usageError(op, `${op} needs at least one task id.`);
      }
      if (positionals.length > IDS_MAX) {
        usageError(op, `${positionals.length} ids were given; at most ${IDS_MAX} per call.`);
      }
      for (const id of positionals) {
        if (!TASK_ID.test(id)) {
          usageError(op, `\`${shown(id)}\` is not a task id (1 to 128 letters, digits, \`_\` and \`-\`).`);
        }
      }
      command.ids = [...new Set(positionals)];
      break;
    }
  }
  return command;
}

/** Whether an operation is one of the team file operations (§7.3). */
function isTeamFileOp(op: OperationName): op is TeamFileOp {
  return hasOwn(TEAM_FILE_OPS, op);
}

/** Whether an operation is a team operation — it needs a host with TEAM_FEATURE (§7.6). */
function isTeamOp(op: OperationName): op is TeamOperationName {
  return op.startsWith('team_');
}

/**
 * The flags of the team operations (team contract §7.2), judged by value — each violation 21 with
 * the operation's usage line, nothing read or sent: `--settle` WAIT_SETTLE_FLAG and at most
 * WAIT_SETTLE_MAX_S; `--member` MEMBER_NAME, `--task` BOARD_ID, `--message` MESSAGE_ID, at most
 * one of them and not with `--all` (team_status); `--team` TEAM_ID or TEAM_NAME (team_resume);
 * team_member's exactly one operation, `--now` only with stop / pause, `--provider` (a provider id
 * or alias, as parseProvider reads it — sent as the id), `--worker` (one line of at most
 * WORKER_FLAG_MAX_CHARS) and `--model` only with `--switch`, which needs at least one of them. The
 * flags of other operations never reach here (parseCommand refuses them first).
 */
function parseTeamFlags(command: Command, values: ReadonlyMap<string, string>, switchesGiven: ReadonlySet<string>): void {
  const op = command.op;
  const settle = values.get('--settle');
  if (settle !== undefined) {
    if (!WAIT_SETTLE_FLAG.test(settle) || Number(settle) > WAIT_SETTLE_MAX_S) {
      usageError(op, `\`--settle ${shown(settle)}\` is not a whole number of seconds from 0 to ${WAIT_SETTLE_MAX_S}.`);
    }
    command.settle = Number(settle);
  }
  const member = values.get('--member');
  if (member !== undefined) {
    if (!MEMBER_NAME.test(member)) {
      usageError(op, `\`--member ${shown(member)}\` is not a member name (1 to 24 lowercase letters, digits or hyphens, starting with a letter).`);
    }
    command.memberFlag = member;
  }
  const task = values.get('--task');
  if (task !== undefined) {
    if (!BOARD_ID.test(task)) {
      usageError(op, `\`--task ${shown(task)}\` is not a board task id (b and a number, such as b3).`);
    }
    command.taskFlag = task;
  }
  const message = values.get('--message');
  if (message !== undefined) {
    if (!MESSAGE_ID.test(message)) {
      usageError(op, `\`--message ${shown(message)}\` is not a message id (m and a number, such as m57).`);
    }
    command.messageFlag = message;
  }
  if (op === 'team_status') {
    const given = [command.all, member !== undefined, task !== undefined, message !== undefined].filter(Boolean).length;
    if (given > 1) {
      usageError(op, 'give at most one of `--all`, `--member`, `--task` and `--message`.');
    }
  }
  const team = values.get('--team');
  if (team !== undefined) {
    if (!TEAM_ID.test(team) && !TEAM_NAME.test(team)) {
      usageError(op, `\`--team ${shown(team)}\` is neither a team id (tm…) nor a team name (lowercase letters, digits and hyphens).`);
    }
    command.team = team;
  }
  if (op !== 'team_member') {
    return;
  }
  const ops = MEMBER_OP_FLAGS.filter((flag) => switchesGiven.has(flag));
  if (ops.length !== 1) {
    usageError(
      op,
      ops.length === 0
        ? `team_member needs exactly one of ${MEMBER_OP_FLAGS.join(', ')}.`
        : `give exactly one of ${MEMBER_OP_FLAGS.join(', ')}; \`${ops[0]}\` and \`${ops[1]}\` were both given.`,
    );
  }
  const memberOp = ops[0].slice(2) as NonNullable<Command['memberOp']>;
  command.memberOp = memberOp;
  if (command.now && !(MEMBER_OP_NOW_OPS as readonly string[]).includes(memberOp)) {
    usageError(op, '`--now` goes only with `--stop` or `--pause`.');
  }
  const provider = values.get('--provider');
  if (provider !== undefined) {
    const id = parseProvider(provider);
    if (id === undefined) {
      usageError(
        op,
        `\`--provider ${shown(provider)}\` is not a provider: use ${PROVIDER_IDS.join(', ')} (or antigravity, agy, claude-code).`,
      );
    }
    command.provider = id;
  }
  const worker = values.get('--worker');
  if (worker !== undefined) {
    command.worker = textFlag(op, '--worker', worker, WORKER_FLAG_MAX_CHARS, 'a worker account name from list_workers');
  }
  const switching = [command.provider, command.worker, command.model].some((v) => v !== undefined);
  if (memberOp === 'switch' && !switching) {
    usageError(op, `\`--switch\` needs at least one of ${MEMBER_SWITCH_KEYS.map((k) => `--${k}`).join(', ')}.`);
  }
  if (memberOp !== 'switch' && switching) {
    usageError(op, `${MEMBER_SWITCH_KEYS.map((k) => `--${k}`).join(', ')} go only with \`--switch\`.`);
  }
}

/* ------------------------------------------------------------------------- *
 * Task files (§15.3.2)
 * ------------------------------------------------------------------------- */

type FileKind =
  | 'task file'
  | 'batch file'
  | 'prompt file'
  | 'system prompt file'
  | 'team file'
  | 'members file'
  | 'message file'
  | 'task-op file'
  | 'goal file'
  | 'brief file'
  | 'body file'
  | 'text file';

/**
 * Read-only and NON-BLOCKING: opening a FIFO for reading without O_NONBLOCK waits for a writer —
 * forever, for a FIFO the model made by mistake — and with it the open returns at once, and fstat
 * then refuses it. O_NOCTTY so that opening a terminal device can never make it ours. Written as
 * explicit `typeof` tests: a constant a platform lacks must add nothing, not NaN.
 */
const READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/** The fatal UTF-8 decoder: undefined until first needed, null where this Node cannot make one. */
let fatalDecoder: TextDecoder | null | undefined;

/**
 * Strict UTF-8 (§15.3.2): the text when `bytes` are valid UTF-8, else undefined — an invalid
 * sequence refuses the file instead of becoming U+FFFD. A leading BOM is KEPT (removed by the
 * caller, once). TextDecoder `fatal`, made on first use: a Node built without ICU throws when one
 * is made, and that must cost the decoder, not the command — there the same answer comes from a
 * lossless round trip (Node's decoder replaces every invalid sequence, so the bytes come back
 * unchanged exactly when they were valid).
 */
function strictUtf8(bytes: Buffer): string | undefined {
  if (fatalDecoder === undefined) {
    try {
      fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    } catch {
      fatalDecoder = null;
    }
  }
  if (fatalDecoder !== null) {
    try {
      return fatalDecoder.decode(bytes);
    } catch {
      return undefined;
    }
  }
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // nothing left to release
  }
}

/**
 * A path quoted in a message: one line, and when it is long its END is kept — the file name is
 * what identifies it — so that the sentence around it still fits one diagnostic line.
 */
function shownPath(file: string): string {
  const line = oneLine(file);
  if (line.length <= PATH_SHOWN_MAX_CHARS) {
    return line;
  }
  let start = line.length - (PATH_SHOWN_MAX_CHARS - 1);
  const code = line.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }
  return `…${line.slice(start)}`;
}

/**
 * A path the reader must be able to OPEN (the host log): one line, never shortened. A diagnostic
 * that holds one is written whole when it could outgrow 300 characters (startTimedOut, onCallGone).
 */
function fullPath(file: string): string {
  return oneLine(file);
}

/** What JSON gave, as a message says it. */
function jsonKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** What fstat says a thing that is not a regular file is. */
function statKind(st: fs.Stats): string {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO (named pipe)';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  if (st.isCharacterDevice() || st.isBlockDevice()) {
    return 'a device';
  }
  return 'a special file';
}

type Opened = { kind: 'open'; fd: number } | { kind: 'missing' } | { kind: 'refused'; why: string };

/**
 * Open `file` for reading if it is a REGULAR file. `missing` only for "nothing is there" (ENOENT,
 * ENOTDIR) — the one answer that lets a relative task path fall back to the workspace; every other
 * failure, and every thing that is not a regular file, is `refused` with why. Never throws.
 */
function openRegular(file: string): Opened {
  if (file.includes('\u0000')) {
    return { kind: 'refused', why: 'has a NUL character in its path' };
  }
  let fd: number;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing' };
    }
    return { kind: 'refused', why: `could not be opened (${code ?? describe(err)})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      closeQuietly(fd);
      return { kind: 'refused', why: `is ${statKind(st)}, not a regular file` };
    }
  } catch (err) {
    closeQuietly(fd);
    return { kind: 'refused', why: `could not be examined (${errnoOf(err) ?? describe(err)})` };
  }
  return { kind: 'open', fd };
}

/**
 * Up to `cap` + 1 bytes of an open file, WHATEVER st_size says (a file can grow while it is read,
 * and a special file's size means nothing): the bytes when there are at most `cap`, undefined
 * when there are more. Throws what readSync throws.
 */
function readCapped(fd: number, cap: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(READ_CHUNK_BYTES, cap + 1 - total);
    if (want <= 0) {
      break;
    }
    const chunk = Buffer.allocUnsafe(want);
    const n = fs.readSync(fd, chunk, 0, want, null);
    if (n <= 0) {
      break;
    }
    chunks.push(n === want ? chunk : chunk.subarray(0, n));
    total += n;
  }
  return total > cap ? undefined : Buffer.concat(chunks, total);
}

/**
 * The text of the file at `file` by §15.3.2's rule — regular file, at most `cap` bytes, strict
 * UTF-8, one leading U+FEFF removed, no NUL — or undefined when nothing is there. Every refusal is
 * 21, naming the file (and the cap). The text is otherwise VERBATIM: not trimmed, line ends kept.
 */
function readTextFile(file: string, kind: FileKind, cap: number): string | undefined {
  const opened = openRegular(file);
  if (opened.kind === 'missing') {
    return undefined;
  }
  if (opened.kind === 'refused') {
    taskFileError(`the ${kind} ${shownPath(file)} ${opened.why}.`);
  }
  let bytes: Buffer | undefined;
  let readFailure: string | undefined;
  try {
    bytes = readCapped(opened.fd, cap);
  } catch (err) {
    readFailure = errnoOf(err) ?? describe(err);
  } finally {
    closeQuietly(opened.fd);
  }
  if (readFailure !== undefined) {
    taskFileError(`the ${kind} ${shownPath(file)} could not be read (${readFailure}).`);
  }
  if (bytes === undefined) {
    taskFileError(`the ${kind} ${shownPath(file)} is larger than ${bytesLabel(cap)}, the limit for a ${kind}.`);
  }
  let text = strictUtf8(bytes);
  if (text === undefined) {
    taskFileError(`the ${kind} ${shownPath(file)} is not valid UTF-8 text — save it as UTF-8.`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.includes('\u0000')) {
    taskFileError(`the ${kind} ${shownPath(file)} contains a NUL character.`);
  }
  return text;
}

/** Levenshtein distance; both strings are short (KEY_COMPARE_MAX_CHARS bounds the longer). */
function editDistance(a: string, b: string): number {
  const row: number[] = [];
  for (let j = 0; j <= b.length; j++) {
    row.push(j);
  }
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The allowed key an unknown one most likely meant: `-` read as `_`, case ignored, Levenshtein
 * distance at most 3, the nearest (the first in `keys` order on a tie); undefined when none is
 * that near. `system-prompt` → `system_prompt` — the typo §15.3.2 says must never be dropped
 * silently. The team files use the same rule (team contract §7.3).
 */
function closestKey(key: string, keys: readonly string[]): string | undefined {
  if (key.length > KEY_COMPARE_MAX_CHARS) {
    return undefined;
  }
  const normalised = key.replace(/-/g, '_').toLowerCase();
  let best: string | undefined;
  let bestDistance = KEY_SUGGEST_MAX_DISTANCE + 1;
  for (const allowed of keys) {
    const distance = editDistance(normalised, allowed);
    if (distance < bestDistance) {
      best = allowed;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The prompt files of one invocation. ONE FILE PATH IS READ ONCE (§15.3.2): a batch whose tasks
 * share a system prompt file reads it once, and every later use is checked against its own cap
 * from the bytes the one read found.
 */
class PromptFiles {
  private readonly cache = new Map<string, { text: string; bytes: number }>();

  constructor(private readonly onRead: (file: string) => void) {}

  read(value: unknown, key: string, baseDir: string, kind: FileKind, cap: number, where: string): string {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
      taskFileError(`${where}: \`${key}\` must be a non-empty string — the path of the ${kind}.`);
    }
    const file = path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
    const cached = this.cache.get(file);
    if (cached !== undefined) {
      if (cached.bytes > cap) {
        taskFileError(`the ${kind} ${shownPath(file)} is larger than ${bytesLabel(cap)}, the limit for a ${kind}.`);
      }
      return cached.text;
    }
    const text = readTextFile(file, kind, cap);
    if (text === undefined) {
      taskFileError(`the ${kind} ${shownPath(file)} was not found — a relative \`${key}\` is read from the JSON file's directory.`);
    }
    this.cache.set(file, { text, bytes: Buffer.byteLength(text, 'utf8') });
    this.onRead(file);
    return text;
  }
}

/**
 * One task object of a task file, as it is sent (§15.3.2): its keys ⊆ TASK_FILE_KEYS (an unknown
 * key is 21 naming it and the closest allowed key); exactly one of prompt / prompt_file; at most
 * one of system_prompt / system_prompt_file. A key whose value is null counts as not given — the
 * host reads null as "not given" too. `prompt_file` / `system_prompt_file` become `prompt` /
 * `system_prompt` holding the file's text verbatim; every other value goes as JSON gave it, for
 * the host to judge with exactly the MCP checks (`"ultrathink": "yes"` is the host's error, 20).
 */
function taskFrom(raw: unknown, where: string, baseDir: string, prompts: PromptFiles): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    taskFileError(`${where} must be a task object such as {"title": …, "prompt_file": …}; it is ${jsonKind(raw)}.`);
  }
  const fields: Record<string, unknown> = raw;
  for (const key of Object.keys(fields)) {
    if (!(TASK_FILE_KEYS as readonly string[]).includes(key)) {
      const closest = closestKey(key, TASK_FILE_KEYS);
      taskFileError(
        closest !== undefined
          ? `${where}: unknown key \`${shown(key)}\` — did you mean \`${closest}\`?`
          : `${where}: unknown key \`${shown(key)}\` — the allowed keys are ${TASK_FILE_KEYS.join(', ')}.`,
      );
    }
  }
  const given = (key: string): boolean => hasOwn(fields, key) && fields[key] !== null;
  if (given('prompt') && given('prompt_file')) {
    taskFileError(`${where} gives both \`prompt\` and \`prompt_file\` — keep one.`);
  }
  if (!given('prompt') && !given('prompt_file')) {
    taskFileError(`${where} has no \`prompt_file\` (or \`prompt\`): name the file that holds the task's prompt.`);
  }
  if (given('system_prompt') && given('system_prompt_file')) {
    taskFileError(`${where} gives both \`system_prompt\` and \`system_prompt_file\` — keep one.`);
  }
  const task: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (key !== 'prompt_file' && key !== 'system_prompt_file') {
      task[key] = fields[key];
    }
  }
  if (given('prompt_file')) {
    task.prompt = prompts.read(fields.prompt_file, 'prompt_file', baseDir, 'prompt file', DISPATCH_PROMPT_MAX_BYTES, where);
  }
  if (given('system_prompt_file')) {
    task.system_prompt = prompts.read(
      fields.system_prompt_file,
      'system_prompt_file',
      baseDir,
      'system prompt file',
      DISPATCH_SYSTEM_PROMPT_MAX_BYTES,
      where,
    );
  }
  return task;
}

/**
 * Find and read the task / batch file named on the command line. A path is used as given; a
 * relative one is looked for under process.cwd() first and, when NOTHING is there (or the cwd is
 * gone), under the workspace — the Bash tool's cwd wanders (F2). Only "nothing is there" falls
 * back: a directory, a FIFO or an unreadable file where the cwd says is that file's refusal.
 */
async function locateTaskFile(
  given: string,
  kind: FileKind,
  workspace: () => Promise<string>,
): Promise<{ file: string; text: string }> {
  if (path.isAbsolute(given)) {
    const file = path.normalize(given);
    const text = readTextFile(file, kind, TASK_JSON_MAX_BYTES);
    if (text === undefined) {
      taskFileError(`the ${kind} ${shownPath(file)} was not found.`);
    }
    return { file, text };
  }
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    cwd = undefined;
  }
  if (cwd !== undefined) {
    const file = path.resolve(cwd, given);
    const text = readTextFile(file, kind, TASK_JSON_MAX_BYTES);
    if (text !== undefined) {
      return { file, text };
    }
  }
  const root = await workspace();
  const file = path.resolve(root, given);
  const text = readTextFile(file, kind, TASK_JSON_MAX_BYTES);
  if (text === undefined) {
    taskFileError(
      `the ${kind} ${shown(given)} was not found, neither under the current directory nor under the workspace ${shownPath(root)}.`,
    );
  }
  return { file, text };
}

/**
 * The `arguments` of a dispatch_task / dispatch_tasks call, read from the command's file — or 21.
 * `onRead` is told the path of every file read (the task file and each prompt file), for the
 * `.cco/.gitignore` rule. A dispatch_task file is ONE task object; a dispatch_tasks file is
 * exactly `{"tasks": [task, …]}`. A file of the other kind is named as such, with the command that
 * takes it. A batch is refused here when it holds no task or more than DISPATCH_BATCH_MAX_TASKS —
 * before a single prompt file of it is read: such a file can never be dispatched as written.
 */
async function readDispatchArguments(
  command: Command,
  workspace: () => Promise<string>,
  onRead: (file: string) => void,
): Promise<Record<string, unknown>> {
  const given = command.file ?? '';
  const batch = command.op === 'dispatch_tasks';
  const kind: FileKind = batch ? 'batch file' : 'task file';
  const { file, text } = await locateTaskFile(given, kind, workspace);
  onRead(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    taskFileError(`the ${kind} ${shownPath(file)} is not valid JSON: ${shown(err instanceof Error ? err.message : String(err), 160)}.`);
  }
  const baseDir = path.dirname(file);
  const prompts = new PromptFiles(onRead);
  const where = `the ${kind} ${shownPath(file)}`;
  checkInputValues(json, where, false);
  if (!batch) {
    if (isPlainObject(json) && hasOwn(json, 'tasks') && !hasOwn(json, 'prompt') && !hasOwn(json, 'prompt_file')) {
      taskFileError(`${where} holds a batch {"tasks": …} — run \`${COMMAND_SPELLING} dispatch_tasks ${shown(given)}\`.`);
    }
    return taskFrom(json, where, baseDir, prompts);
  }
  if (Array.isArray(json)) {
    taskFileError(`${where} is a bare array — write {"tasks": [...]}.`);
  }
  if (!isPlainObject(json)) {
    taskFileError(`${where} must hold {"tasks": [...]}; it holds ${jsonKind(json)}.`);
  }
  if (!hasOwn(json, 'tasks')) {
    if (hasOwn(json, 'prompt') || hasOwn(json, 'prompt_file')) {
      taskFileError(
        `${where} holds one task, not a batch — run \`${COMMAND_SPELLING} dispatch_task ${shown(given)}\`, or write {"tasks": [ … ]}.`,
      );
    }
    taskFileError(`${where} must hold {"tasks": [...]}; it has no "tasks".`);
  }
  const extra = Object.keys(json).find((key) => key !== 'tasks');
  if (extra !== undefined) {
    taskFileError(`${where} must hold exactly {"tasks": [...]}; \`${shown(extra)}\` does not belong there.`);
  }
  const tasks = json.tasks;
  if (!Array.isArray(tasks)) {
    taskFileError(`${where}: "tasks" must be an array of task objects; it is ${jsonKind(tasks)}.`);
  }
  if (tasks.length === 0) {
    taskFileError(`${where} has no tasks in "tasks".`);
  }
  if (tasks.length > DISPATCH_BATCH_MAX_TASKS) {
    taskFileError(
      `${where} has ${tasks.length} tasks; at most ${DISPATCH_BATCH_MAX_TASKS} per call — split it into several batch files.`,
    );
  }
  return { tasks: tasks.map((task: unknown, i: number) => taskFrom(task, `${where}, tasks[${i}]`, baseDir, prompts)) };
}

/* ------------------------------------------------------------------------- *
 * Team files (team contract §7.3)
 * ------------------------------------------------------------------------- */

/**
 * The keys of one object of a team file, against the keys allowed there: an unknown key is 21
 * naming it and the closest allowed key (closestKey), or every allowed key when none is near —
 * the rule of task files (§15.3.2), which §7.3 keeps.
 */
function checkTeamKeys(fields: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      const closest = closestKey(key, allowed);
      taskFileError(
        closest !== undefined
          ? `${where}: unknown key \`${shown(key)}\` — did you mean \`${closest}\`?`
          : `${where}: unknown key \`${shown(key)}\` — the allowed keys are ${allowed.join(', ')}.`,
      );
    }
  }
}

/**
 * One text that a team file may give inline (`key`) or as a file (`key_file`), read by the
 * §15.3.2 reader with `cap`, relative to the JSON file's directory, each path once per invocation
 * (PromptFiles). `exactlyOne`: one of the two must be given (§7.3: "exactly one of x / x_file
 * where both exist"); otherwise at most one. A key whose value is null counts as not given. The
 * `_file` key is replaced by `key` holding the file's text verbatim; an inline value goes as JSON
 * gave it, for the host to judge.
 */
function teamText(
  fields: Record<string, unknown>,
  key: 'goal' | 'brief' | 'body' | 'text',
  kind: FileKind,
  cap: number,
  exactlyOne: boolean,
  where: string,
  baseDir: string,
  files: PromptFiles,
): void {
  const fileKey = `${key}_file`;
  const given = (k: string): boolean => hasOwn(fields, k) && fields[k] !== null;
  if (given(key) && given(fileKey)) {
    taskFileError(`${where} gives both \`${key}\` and \`${fileKey}\` — keep one.`);
  }
  if (exactlyOne && !given(key) && !given(fileKey)) {
    taskFileError(`${where} has no \`${fileKey}\` (or \`${key}\`): name the file that holds it.`);
  }
  if (given(key) && typeof fields[key] !== 'string') {
    taskFileError(`${where}: \`${key}\` must be a string; it holds ${jsonKind(fields[key])}.`);
  }
  if (given(fileKey)) {
    fields[key] = files.read(fields[fileKey], fileKey, baseDir, kind, cap, where);
  }
  delete fields[fileKey];
}

/** A36: the one-line values of a team file — no control character in any of them. */
const ONE_LINE_KEYS: ReadonlySet<string> = new Set(['role', 'title', 'name']);
/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Team contract A36 (review S3, S7): the VALUES a `cco` input file carries inline that no reader
 * of them can survive are refused here, before anything is sent (21, naming the field):
 *  - any number JSON.parse could not hold — `1e309` parses as Infinity, which JSON.stringify then
 *    sends as `null`, and the host read "not given" and used its default without a word;
 *  - with `texts` (team files): a NUL or a lone UTF-16 surrogate in ANY string of the file — the
 *    inline texts (goal, brief, role, title, body, text, start, note) above all, which ride into
 *    briefs, prompts and argv, where a NUL made every non-Claude member `blocked: crash` with a
 *    spawn error that named nothing the lead could fix (a `_file` text already passed the §15.3.2
 *    reader's strict UTF-8 and no-NUL rule) — and a control character in a ONE-LINE value
 *    (`role`, `title`, `name`), which would reach a member's system prompt as it is.
 * The host makes the same text checks in its aggregated value check (20, nothing created); this
 * is the client's half. The walk is iterative: a deeply nested file cannot overflow the stack.
 */
function checkInputValues(json: unknown, where: string, texts: boolean): void {
  const stack: Array<{ value: unknown; at: string; key: string | undefined }> = [{ value: json, at: '', key: undefined }];
  while (stack.length > 0) {
    const { value, at, key } = stack.pop() as { value: unknown; at: string; key: string | undefined };
    const field = (): string => (at === '' ? 'the file' : `\`${at}\``);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        taskFileError(`${where}: ${field()} is not a number JSON can carry (a value such as 1e309 overflows to infinity); write a finite number.`);
      }
    } else if (typeof value === 'string') {
      if (!texts) {
        continue;
      }
      if (value.includes('\u0000')) {
        taskFileError(`${where}: ${field()} contains a NUL character (\\u0000).`);
      }
      if (LONE_SURROGATE.test(value)) {
        taskFileError(`${where}: ${field()} contains a lone UTF-16 surrogate (a \\ud800–\\udfff escape without its pair), which is not text.`);
      }
      if (key !== undefined && ONE_LINE_KEYS.has(key) && hasControlChar(value)) {
        taskFileError(`${where}: ${field()} must be one line of text without control characters.`);
      }
    } else if (Array.isArray(value)) {
      // Pushed last to first, so the first offending field in the file's order is the one named.
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], at: `${at}[${i}]`, key });
      }
    } else if (isPlainObject(value)) {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        stack.push({ value: v, at: at === '' ? k : `${at}.${k}`, key: k });
      }
    }
  }
}

/** A copy of a JSON object's own fields, so the reader can replace `_file` keys without touching what JSON.parse made. */
function copyFields(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw };
}

/**
 * `members` / `tasks` (null = not given): an array of JSON objects, or 21 — a SHAPE the client
 * must see to judge the keys inside (§7.3); the values inside stay the host's (20).
 */
function arrayOfObjects(value: unknown, key: 'members' | 'tasks', where: string): unknown[] {
  if (!Array.isArray(value)) {
    taskFileError(`${where}: \`${key}\` must be an array of JSON objects; it holds ${jsonKind(value)}.`);
  }
  value.forEach((raw: unknown, i: number) => {
    if (!isPlainObject(raw)) {
      taskFileError(`${where}, ${key}[${i}] must be a JSON object; it holds ${jsonKind(raw)}.`);
    }
  });
  return value;
}

/**
 * The members of a team or members file: an array of objects (else 21), each object's keys ⊆
 * MEMBER_KEYS, exactly one of brief / brief_file (BRIEF cap), the brief a string. Every VALUE is
 * the host's to refuse (20), with every other problem of the file at once.
 */
function teamMembers(value: unknown, where: string, baseDir: string, files: PromptFiles): unknown {
  if (value === null) {
    return value;
  }
  return arrayOfObjects(value, 'members', where).map((raw: unknown, i: number) => {
    const at = `${where}, members[${i}]`;
    const fields = copyFields(raw as Record<string, unknown>);
    checkTeamKeys(fields, MEMBER_KEYS, at);
    teamText(fields, 'brief', 'brief file', TEAM_FILE_CAPS.briefFile, true, at, baseDir, files);
    return fields;
  });
}

/**
 * Board task entries (TASK_KEYS): at most one of body / body_file (a task may have no body —
 * TaskFileEntry; CONTRACT reading of §7.3's "exactly one where both exist" for the one optional
 * text). The array and its objects as for teamMembers.
 */
function teamTasks(value: unknown, where: string, baseDir: string, files: PromptFiles): unknown {
  if (value === null) {
    return value;
  }
  return arrayOfObjects(value, 'tasks', where).map((raw: unknown, i: number) => {
    const at = `${where}, tasks[${i}]`;
    const fields = copyFields(raw as Record<string, unknown>);
    checkTeamKeys(fields, TASK_KEYS, at);
    teamText(fields, 'body', 'body file', TEAM_FILE_CAPS.bodyFile, false, at, baseDir, files);
    return fields;
  });
}

/**
 * The `arguments` of a team file operation (team contract §7.2, §7.3), read from the command's
 * file — or 21. The file is found as a task file is (locateTaskFile: the cwd, then the workspace),
 * read with the §15.3.2 reader and the cap of a team file (TEAM_FILE_CAPS.teamFile, which is
 * TASK_JSON_MAX_BYTES), and must hold ONE JSON object. Only its KEYS are judged here, at every
 * level the contract names (an unknown key → 21 naming the closest allowed one), the SHAPES those
 * key checks and text reads need (`members` / `tasks` an array of objects, `worktree` and its
 * `setup` objects, `goal` / `brief` / `body` / `text` strings — else 21), and its `_file` texts
 * read (goal 64 KiB, brief 256 KiB, body 64 KiB, text 64 KiB); every other VALUE goes to the host
 * as JSON gave it — the engine checks them all at once and answers 20 (§7.3).
 *
 * Two message refusals are the client's own, by the contract's exit 21: `urgent` to `all`
 * (TEAM_TEXT.urgentToAll) and anything to `user` from the lead (TEAM_TEXT.leadToUser).
 */
async function readTeamArguments(
  op: TeamFileOp,
  given: string,
  workspace: () => Promise<string>,
  onRead: (file: string) => void,
): Promise<Record<string, unknown>> {
  const kind: FileKind = TEAM_FILE_OPS[op];
  const { file, text } = await locateTaskFile(given, kind, workspace);
  onRead(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    taskFileError(`the ${kind} ${shownPath(file)} is not valid JSON: ${shown(err instanceof Error ? err.message : String(err), 160)}.`);
  }
  const where = `the ${kind} ${shownPath(file)}`;
  if (!isPlainObject(json)) {
    taskFileError(`${where} must hold one JSON object; it holds ${jsonKind(json)}.`);
  }
  checkInputValues(json, where, true);
  const baseDir = path.dirname(file);
  const files = new PromptFiles(onRead);
  const fields = copyFields(json);
  switch (op) {
    case 'team_create': {
      checkTeamKeys(fields, TEAM_FILE_KEYS, where);
      teamText(fields, 'goal', 'goal file', TEAM_FILE_CAPS.goalFile, true, where, baseDir, files);
      if (hasOwn(fields, 'members')) {
        fields.members = teamMembers(fields.members, where, baseDir, files);
      }
      if (hasOwn(fields, 'tasks')) {
        fields.tasks = teamTasks(fields.tasks, where, baseDir, files);
      }
      const worktree = fields.worktree;
      if (worktree !== undefined && worktree !== null && !isPlainObject(worktree)) {
        taskFileError(`${where}: \`worktree\` must be a JSON object; it holds ${jsonKind(worktree)}.`);
      }
      if (isPlainObject(worktree)) {
        checkTeamKeys(worktree, WORKTREE_KEYS, `${where}, worktree`);
        const setup = worktree.setup;
        if (setup !== undefined && setup !== null && !isPlainObject(setup)) {
          taskFileError(`${where}: \`worktree.setup\` must be a JSON object; it holds ${jsonKind(setup)}.`);
        }
        if (isPlainObject(setup)) {
          checkTeamKeys(setup, SETUP_KEYS, `${where}, worktree.setup`);
        }
      }
      return fields;
    }
    case 'team_add':
      checkTeamKeys(fields, ['members', 'tasks'], where);
      if (hasOwn(fields, 'members')) {
        fields.members = teamMembers(fields.members, where, baseDir, files);
      }
      if (hasOwn(fields, 'tasks')) {
        fields.tasks = teamTasks(fields.tasks, where, baseDir, files);
      }
      return fields;
    case 'team_send':
      checkTeamKeys(fields, MESSAGE_FILE_KEYS, where);
      teamText(fields, 'text', 'text file', TEAM_FILE_CAPS.textFile, true, where, baseDir, files);
      if (fields.to === 'all' && fields.urgent === true) {
        taskFileError(TEAM_TEXT.urgentToAll());
      }
      if (fields.to === 'user') {
        taskFileError(TEAM_TEXT.leadToUser());
      }
      return fields;
    case 'team_task': {
      const opName = fields.op;
      if (typeof opName !== 'string' || !hasOwn(TASK_OP_KEYS, opName)) {
        taskFileError(
          `${where}: \`op\` must be one of ${Object.keys(TASK_OP_KEYS).join(', ')}` +
            (typeof opName === 'string' ? `, not \`${shown(opName)}\`.` : '.'),
        );
      }
      checkTeamKeys(fields, TASK_OP_KEYS[opName as keyof typeof TASK_OP_KEYS], where);
      if (opName === 'add' && hasOwn(fields, 'tasks')) {
        fields.tasks = teamTasks(fields.tasks, where, baseDir, files);
      }
      if (opName === 'update') {
        teamText(fields, 'body', 'body file', TEAM_FILE_CAPS.bodyFile, false, where, baseDir, files);
      }
      return fields;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The session's place: run directory, socket, workspace (§15.1, §15.3 step 4)
 * ------------------------------------------------------------------------- */

type HostFiles = ReturnType<typeof hostFilesOf>;

function lstatQuiet(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

function statQuiet(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // absent already, or not ours to remove — either way nothing more is done
  }
}

/**
 * A small file of the run directory (record, lock, fail file, spec) as text, or undefined when it
 * is absent, not a regular file, over `cap` or unreadable. Lenient UTF-8: these files are written
 * by this product, and an undecodable byte must cost one character, not the reading. Never throws.
 */
function readSmallText(file: string, cap: number): string | undefined {
  const opened = openRegular(file);
  if (opened.kind !== 'open') {
    return undefined;
  }
  try {
    const bytes = readCapped(opened.fd, cap);
    return bytes === undefined ? undefined : bytes.toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeQuietly(opened.fd);
  }
}

/** `{pid, startedAt}` out of a JSON text (the lock's content), by value; undefined otherwise. */
function identityOf(value: unknown): ProcessIdentity | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { pid, startedAt } = value;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return undefined;
  }
  return { pid, startedAt };
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * A directory this process may keep its host's files in: a REAL directory (not a symbolic link)
 * owned by this uid. Created (0700) when absent; group / other access taken off when it is ours
 * and grants any. Anything else is 22 with the sentence saying what is wrong — the run directory
 * and the socket fallback directory are where the host's socket and its start spec live, and a
 * directory another user can reach would let them answer as the host or read the spec.
 */
function privateDirectory(dir: string, what: string, recursive: boolean): void {
  let created: string | undefined;
  try {
    fs.mkdirSync(dir, { recursive, mode: 0o700 });
  } catch (err) {
    created = errnoOf(err) ?? describe(err);
  }
  const st = lstatQuiet(dir);
  if (st === undefined) {
    cannotRunOn(`could not create ${what} ${shownPath(dir)} (${created ?? 'it is not there'}).`, created);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    cannotRun(
      `${what} ${shownPath(dir)} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; cco uses it ` +
        'only as a real directory of this user. Tell the user; once it is removed, cco creates it again.',
    );
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    cannotRun(`${what} ${shownPath(dir)} belongs to another user (uid ${st.uid}); cco uses it only when it is this user's. Tell the user.`);
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      cannotRunOn(`${what} ${shownPath(dir)} is open to other users and its mode could not be set to 0700.`, errnoOf(err));
    }
  }
}

/**
 * What the OS said about the session process's cwd (§15.3 step 4): `path` when it was learned —
 * on darwin decoded from lsof's name and proved by its inode (lsofCwdAnswer). On darwin also the
 * two things the 22 says when there is no usable path: the name lsof printed, AS IT PRINTED IT
 * (§15.12 H1 — so the user sees the bytes), and whether lsof failed — could not be run, ended
 * non-zero, timed out — or named nothing (L12).
 */
interface CwdAnswer {
  path: string | undefined;
  lsofName?: string;
  lsofFailed?: boolean;
}

/** lsof's one-letter escapes (the byte after a `\`) and the byte each stands for. */
const LSOF_ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x5c, 0x5c], // `\\` → `\`
  [0x62, 0x08], // `\b`
  [0x66, 0x0c], // `\f`
  [0x6e, 0x0a], // `\n`
  [0x72, 0x0d], // `\r`
  [0x74, 0x09], // `\t`
]);

/**
 * The bytes a name stands for, lsof's escapes undone (§15.12 H1), or undefined when it holds an
 * escape lsof does not write — a `\` followed by anything else, or `\x` without two hex digits.
 * lsof prints a name byte by byte: what is printable in its locale as it is, `\` as `\\`, BS FF NL
 * CR TAB as `\b \f \n \r \t`, any other byte it cannot print as `\xNN`. The remaining control
 * bytes it prints as `^X`, which is ALSO how the two characters `^` `X` print (probed: a directory
 * `ctl<0x01>x` and one named `caret^Ax` print alike): that is not undone — such a name decodes to
 * a path whose inode is not the one lsof named, and lsofCwdAnswer refuses it.
 */
function decodeLsofName(raw: Buffer): Buffer | undefined {
  // Never longer than the raw name: every escape is two or four bytes for one.
  const bytes = Buffer.alloc(raw.length);
  let length = 0;
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte !== 0x5c) {
      bytes[length++] = byte;
      continue;
    }
    const letter = raw[i + 1];
    if (letter === 0x78) {
      const hex = raw.toString('latin1', i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        return undefined;
      }
      bytes[length++] = parseInt(hex, 16);
      i += 3;
      continue;
    }
    // A `\` that ends the name reads `undefined` here, which no escape is.
    const value = LSOF_ESCAPES.get(letter);
    if (value === undefined) {
      return undefined;
    }
    bytes[length++] = value;
    i += 1;
  }
  return bytes.subarray(0, length);
}

/**
 * The `i` and `n` fields of the first file in lsof's `-Fin` answer — lines `p<pid>`, `f<fd>`,
 * `i<inode>`, `n<name>`, each ended by a newline (probed on macOS 14). A newline inside a name is
 * printed `\n`, so the answer is split on the newline BYTE before anything in it is decoded. The
 * inode as a decimal string without leading zeros (as String() of a bigint writes it); undefined
 * when lsof gave none, or not a decimal number.
 */
function lsofCwdFields(stdout: Buffer): { inode: string | undefined; name: Buffer } | undefined {
  let inode: string | undefined;
  let start = 0;
  while (start < stdout.length) {
    const newline = stdout.indexOf(0x0a, start);
    const end = newline === -1 ? stdout.length : newline;
    const field = stdout.subarray(start, end);
    start = end + 1;
    if (field.length === 0) {
      continue;
    }
    const tag = field[0];
    if (tag === 0x66) {
      // `f`: the fields of a new file begin.
      inode = undefined;
    } else if (tag === 0x69) {
      const digits = field.toString('latin1', 1);
      inode = /^[0-9]{1,20}$/.test(digits) ? digits.replace(/^0+(?=[0-9])/, '') : undefined;
    } else if (tag === 0x6e && field.length > 1) {
      // `n`: the name, the last field lsof prints for a file.
      return { inode, name: field.subarray(1) };
    }
  }
  return undefined;
}

/**
 * lsof's answer as a CwdAnswer (§15.12 H1). Its name is DECODED (decodeLsofName), read as strict
 * UTF-8, and believed only when it is an absolute path to a DIRECTORY WHOSE INODE IS THE ONE LSOF
 * GAVE: whatever the escaping did, or could not undo, the inode says whether the decoded path is
 * the directory lsof looked at (a bigint stat — an inode is 64 bits). `err` is execFile's: an
 * exit code other than 0 still lets a name lsof printed be judged, and counts as a failure for the
 * 22; anything else — lsof not run, ended by the timeout or by finish(), over its buffer — means
 * what it printed is not taken.
 */
function lsofCwdAnswer(err: unknown, stdout: Buffer): CwdAnswer {
  let failed = false;
  if (err !== null && err !== undefined) {
    const { code, killed, signal } = err as { code?: unknown; killed?: unknown; signal?: unknown };
    if (typeof code !== 'number' || killed === true || (signal !== null && signal !== undefined)) {
      return { path: undefined, lsofFailed: true };
    }
    failed = true;
  }
  const fields = lsofCwdFields(stdout);
  if (fields === undefined) {
    return { path: undefined, lsofFailed: true };
  }
  const lsofName = fields.name.toString('utf8');
  const unproved: CwdAnswer = { path: undefined, lsofName, lsofFailed: failed };
  const decoded = decodeLsofName(fields.name);
  const text = decoded === undefined ? undefined : strictUtf8(decoded);
  if (text === undefined || fields.inode === undefined || !path.isAbsolute(text) || text.includes('\u0000')) {
    return unproved;
  }
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(text, { bigint: true });
  } catch {
    return unproved;
  }
  if (!st.isDirectory() || String(st.ino) !== fields.inode) {
    return unproved;
  }
  return { path: text, lsofName, lsofFailed: failed };
}

/**
 * Where the CLAUDE_PID process is — its cwd, the session's project directory (F2) — as the OS
 * says it. Linux: the `/proc/<pid>/cwd` link (what `readlink` reads, read directly — unchanged by
 * §15.12). macOS: `/usr/sbin/lsof -a -p <pid> -d cwd -Fin` (execFile with SYSTEM_TOOL_ENV, 5 s,
 * never a shell; its answer as BYTES), judged by lsofCwdAnswer. Any other platform: nothing is
 * learned. A running lsof is ended by finish(). Never rejects.
 */
function sessionProcessCwd(pid: number): Promise<CwdAnswer> {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve({ path: fs.readlinkSync(`/proc/${pid}/cwd`) });
    } catch {
      return Promise.resolve({ path: undefined });
    }
  }
  if (process.platform !== 'darwin' || finished) {
    return Promise.resolve({ path: undefined });
  }
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    const release = (): void => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // gone already
      }
    };
    try {
      child = execFile(
        LSOF_PATH,
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fin'],
        { encoding: 'buffer', env: SYSTEM_TOOL_ENV, timeout: LSOF_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          cleanups.delete(release);
          resolve(lsofCwdAnswer(err, stdout));
        },
      );
      child.on('error', () => undefined);
      cleanups.add(release);
    } catch {
      resolve({ path: undefined, lsofFailed: true });
    }
  });
}

/** §15.3 step 4: the 22 when the session's project directory cannot be found, without its end. */
const NO_PROJECT_DIR = "could not find the Claude Code session's project directory";

/**
 * §15.12 L12: said when lsof failed, timed out or named nothing. Inside Claude Code's sandbox lsof
 * may not be allowed to look at the session process — and the host, whose own sandbox check
 * (§15.2 step 2d) would have said so, is never started.
 */
const LSOF_SANDBOX_SENTENCE =
  'If Claude Code\'s sandbox is on, cco must run outside it — see Update Workspace Setup\'s "Allow cco without a prompt".';

/**
 * The 22 of §15.3 step 4: the sentence — with what lsof answered when it named something (§15.12
 * H1: its first 200 characters, as it printed them) — then, when lsof failed, timed out or named
 * nothing, LSOF_SANDBOX_SENTENCE as a line of its own (L12; as SANDBOX_HINT follows its sentence).
 */
function projectDirLines(answer: CwdAnswer): string[] {
  const lines = [
    answer.lsofName === undefined
      ? `${NO_PROJECT_DIR}.`
      : `${NO_PROJECT_DIR} (lsof answered ${sliceChars(oneLine(answer.lsofName), LSOF_NAME_SHOWN_MAX_CHARS)}).`,
  ];
  if (answer.lsofFailed === true) {
    lines.push(LSOF_SANDBOX_SENTENCE);
  }
  return lines;
}

/**
 * Everything this invocation learns about its session's dispatch host, each thing once and only
 * when it is needed — so that a command whose arguments are refused never touches the run
 * directory, and one that finds its host running never runs lsof.
 */
class SessionPlace {
  /** The paths of the host's files in the run directory (§15.1). */
  private files_: HostFiles | undefined;
  private runDir_: string | undefined;
  private socket_: string | undefined;
  private sessionCwd_: Promise<string> | undefined;
  private earlyWorkspace_: Promise<string> | undefined;
  /** Why the last intermediate could not be spawned, once its 'error' says so. */
  spawnFailure: string | undefined;
  /** Whether this process holds `s<P>.lock` — finish() releases it then. */
  lockHeld = false;

  /** serverHashOf the server.js beside this file — null until first asked. */
  private serverHash_: string | undefined | null = null;

  constructor(
    readonly session: ProcessIdentity,
    readonly self: ProcessIdentity,
  ) {}

  /**
   * serverHashOf the server.js beside this file; undefined when it is missing. Hashed once, and
   * only when a host is to be talked to — a command refused before that never reads the bundle.
   */
  get serverHash(): string | undefined {
    if (this.serverHash_ === null) {
      this.serverHash_ = serverHashBeside();
    }
    return this.serverHash_;
  }

  /** `<data root>/run`, checked (§15.1): a real directory of this uid, else 22. */
  runDir(): string {
    if (this.runDir_ === undefined) {
      const dir = runDirOf(ROOT_DIR);
      privateDirectory(dir, 'the run directory', true);
      this.runDir_ = dir;
    }
    return this.runDir_;
  }

  files(): HostFiles {
    if (this.files_ === undefined) {
      this.files_ = hostFilesOf(this.runDir(), this.session.pid);
    }
    return this.files_;
  }

  /**
   * THE socket path (host-protocol socketPathFor, the one rule): `<run dir>/s<P>.sock`, or the
   * hashed fallback in `/tmp/cco-<uid>/` — whose directory must be private (privateDirectory) —
   * or 22 when even that is longer than SOCKET_PATH_MAX_BYTES.
   */
  socket(): string {
    if (this.socket_ === undefined) {
      const chosen = socketPathFor(this.runDir(), this.session.pid, currentUid() ?? 0);
      if (chosen === undefined) {
        cannotRun(
          `the socket of this session's dispatch host would be longer than ${SOCKET_PATH_MAX_BYTES} bytes even in ` +
            `/tmp, because the data root's path is too long: ${shownPath(ROOT_DIR)}.`,
        );
      }
      if (chosen.fallbackDir !== undefined) {
        privateDirectory(chosen.fallbackDir, 'the socket directory', false);
      }
      this.socket_ = chosen.socket;
    }
    return this.socket_;
  }

  /**
   * The session's project directory as the session process's own cwd (§15.3 step 4) — realpath'd,
   * and a directory — or 22 (projectDirLines: what lsof answered, and the sandbox sentence when
   * lsof failed or named nothing — §15.12 H1, L12). Asked once; what is needed to START a host.
   */
  sessionCwd(): Promise<string> {
    if (this.sessionCwd_ === undefined) {
      this.sessionCwd_ = sessionProcessCwd(this.session.pid).then((answer) => {
        stopIfFinished();
        let real: string | undefined;
        if (answer.path !== undefined && path.isAbsolute(answer.path)) {
          try {
            real = fs.realpathSync(answer.path);
          } catch {
            real = undefined;
          }
        }
        if (real === undefined || statQuiet(real)?.isDirectory() !== true) {
          cannotRun(...projectDirLines(answer));
        }
        return real;
      });
    }
    return this.sessionCwd_;
  }

  /**
   * The workspace BEFORE any hello — for a relative task path that is not under the cwd (§15.3.2).
   * A running host's record gives it (§15.3 step 4) when it names THIS session (same pid, start
   * time within the slack) and this protocol, and its workspace is a directory; otherwise the
   * session process's cwd. The hello's own `workspace` is what everything after the hello uses.
   */
  earlyWorkspace(): Promise<string> {
    if (this.earlyWorkspace_ === undefined) {
      const fromRecord = this.recordWorkspace();
      this.earlyWorkspace_ = fromRecord !== undefined ? Promise.resolve(fromRecord) : this.sessionCwd();
    }
    return this.earlyWorkspace_;
  }

  /**
   * The record's workspace, read WITHOUT creating or judging the run directory — that is step 5's
   * work, and a command still being checked (step 3) must not make anything. A run directory that
   * is not a real directory of this uid is not read at all: the session's own cwd answers instead.
   */
  private recordWorkspace(): string | undefined {
    const runDir = runDirOf(ROOT_DIR);
    const dirStat = lstatQuiet(runDir);
    const uid = currentUid();
    if (dirStat === undefined || dirStat.isSymbolicLink() || !dirStat.isDirectory() || (uid !== undefined && dirStat.uid !== uid)) {
      return undefined;
    }
    const text = readSmallText(hostFilesOf(runDir, this.session.pid).record, RECORD_MAX_BYTES);
    if (text === undefined) {
      return undefined;
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isPlainObject(record) || record.protocol !== PROTOCOL_VERSION) {
      return undefined;
    }
    const session = identityOf(record.session);
    if (session === undefined || !sameProcess(session, this.session)) {
      return undefined;
    }
    const workspace = record.workspace;
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || statQuiet(workspace)?.isDirectory() !== true) {
      return undefined;
    }
    return workspace;
  }

  /** The hello's params (§15.4): this protocol, this session, this build, this process. */
  helloParams(): HelloParams {
    return {
      protocol: PROTOCOL_VERSION,
      session: this.session,
      serverHash: this.serverHash ?? 'missing',
      clientPid: process.pid,
    };
  }
}

/* ------------------------------------------------------------------------- *
 * The socket (§15.4)
 * ------------------------------------------------------------------------- */

/**
 * One connection to a host — mcp/host-client's HostConnection (the factored client: lines split
 * on the newline byte, at most LINE_MAX_BYTES each, a line that is not one JSON object skipped)
 * held the way this process holds everything: registered with finish()'s cleanups, and every
 * handler `guarded`, so that whatever one throws is finishFrom()'s, never the socket's. Destroyed
 * by finish().
 */
class HostLink {
  private readonly release = (): void => this.destroy();

  private constructor(private readonly connection: HostConnection) {
    cleanups.add(this.release);
  }

  /**
   * Connect to `socketPath`: the link, or the errno of the failure (ENOENT and ECONNREFUSED mean
   * "no host"; ETIMEDOUT is this bound's own; ECANCELED, finish() came first). Never rejects.
   */
  static async open(socketPath: string): Promise<{ link: HostLink } | { code: string }> {
    if (finished) {
      // The exit code is decided: no new socket that finish() could no longer release.
      return { code: 'ECANCELED' };
    }
    const abort = new AbortController();
    const release = (): void => abort.abort();
    cleanups.add(release);
    const opened = await HostConnection.open(socketPath, { timeoutMs: CONNECT_TIMEOUT_MS, signal: abort.signal });
    cleanups.delete(release);
    if ('code' in opened) {
      return opened;
    }
    if (finished) {
      opened.connection.close();
      return { code: 'ECANCELED' };
    }
    return { link: new HostLink(opened.connection) };
  }

  /** Who hears what arrives from now on. */
  listen(
    onMessage: (message: Record<string, unknown>) => void,
    onGone: (why: string, protocolFailure: boolean) => void,
  ): void {
    this.connection.listen(
      guarded(onMessage),
      guarded((end: HostConnectionEnd) => onGone(endWords(end), end.kind === 'line-too-long')),
    );
  }

  /** One line (with its newline) to the host. A link that is gone takes nothing. */
  send(line: string): void {
    this.connection.writeLine(line);
  }

  /** Close it. Its requests go on in the host: closing is never a cancel (§15.4). */
  destroy(): void {
    cleanups.delete(this.release);
    this.connection.close();
  }
}

/** How a connection's end is said in this file's lines. */
function endWords(end: HostConnectionEnd): string {
  switch (end.kind) {
    case 'line-too-long':
      return `the dispatch host sent a line longer than ${bytesLabel(LINE_MAX_BYTES)}`;
    case 'error':
      return `the connection failed (${end.code ?? describe(end.error)})`;
    case 'closed':
      return 'the connection closed';
  }
}

/** A JSON-RPC message that answers request `id` (not a notification, not a request). */
function isAnswerTo(message: Record<string, unknown>, id: number): boolean {
  return message.id === id && message.method === undefined;
}

/** The `{code, message}` of a JSON-RPC error member, by value. */
function rpcErrorOf(value: unknown): { code: number | undefined; message: string } {
  if (!isPlainObject(value)) {
    return { code: undefined, message: 'no description was given' };
  }
  const code = typeof value.code === 'number' ? value.code : undefined;
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? shown(value.message, 240) : 'no description was given';
  return { code, message };
}

const MISMATCH_SENTENCE =
  "this session's dispatch host speaks another version of the cco protocol (an older or newer build of " +
  'Claude Code Orchestrator); start a new Claude Code session to use this one.';

/** What one connect + hello found (§15.3 step 5, §15.4). */
type HelloOutcome =
  | { kind: 'ok'; link: HostLink; hello: HelloResult }
  /** Nothing listens (ENOENT / ECONNREFUSED), or the connection closed before the answer. */
  | { kind: 'none' }
  /** -32011: the host on this socket serves another session (a stale one, after pid reuse). */
  | { kind: 'stale' }
  /** -32010, or a result naming another protocol. */
  | { kind: 'mismatch' }
  /** Connected, and no answer within the time given. */
  | { kind: 'silent' }
  /** Anything else: 22 with this sentence (and the errno, when a connect failed). */
  | { kind: 'broken'; sentence: string; code?: string };

/**
 * Connect to this session's socket and say hello, waiting at most `answerMs` for the answer. The
 * link is kept only when the hello succeeded; it is destroyed otherwise. Rejects only with the 22
 * of a run or socket directory that cannot be used (SessionPlace.socket).
 */
async function connectAndHello(place: SessionPlace, answerMs: number): Promise<HelloOutcome> {
  const socketPath = place.socket();
  const opened = await HostLink.open(socketPath);
  if ('code' in opened) {
    if (opened.code === 'ENOENT' || opened.code === 'ECONNREFUSED') {
      return { kind: 'none' };
    }
    if (opened.code === 'ECANCELED') {
      return { kind: 'none' };
    }
    return {
      kind: 'broken',
      sentence: `could not connect to this session's dispatch host at ${shownPath(socketPath)} (${opened.code}).`,
      code: opened.code,
    };
  }
  const { link } = opened;
  const outcome = await new Promise<HelloOutcome>((resolve) => {
    let settled = false;
    const settle = (value: HelloOutcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanups.delete(release);
        resolve(value);
      }
    };
    const release = (): void => settle({ kind: 'none' });
    const timer = setTimeout(() => settle({ kind: 'silent' }), Math.max(1, answerMs));
    cleanups.add(release);
    link.listen(
      (message) => {
        if (!isAnswerTo(message, HELLO_ID)) {
          return;
        }
        if (message.error !== undefined && message.error !== null) {
          const error = rpcErrorOf(message.error);
          if (error.code === RPC_ERROR.wrongSession) {
            settle({ kind: 'stale' });
          } else if (error.code === RPC_ERROR.protocolMismatch) {
            settle({ kind: 'mismatch' });
          } else {
            settle({ kind: 'broken', sentence: `the dispatch host refused this client's hello: ${error.message}` });
          }
          return;
        }
        const hello = helloResultOf(message.result);
        if (hello === undefined) {
          settle({
            kind: 'broken',
            sentence: 'the dispatch host answered the hello with something cco does not understand — a defect in the dispatch server.',
          });
          return;
        }
        settle(hello.protocol === PROTOCOL_VERSION ? { kind: 'ok', link, hello } : { kind: 'mismatch' });
      },
      () => settle({ kind: 'none' }),
    );
    link.send(`${JSON.stringify({ jsonrpc: '2.0', id: HELLO_ID, method: METHOD.hello, params: place.helloParams() })}\n`);
  });
  if (outcome.kind !== 'ok') {
    link.destroy();
  }
  return outcome;
}

/* ------------------------------------------------------------------------- *
 * Starting the host (§15.2 step 1, §15.3 step 5)
 * ------------------------------------------------------------------------- */

/** A fail file older than the lock it answers, by more than this, is a previous attempt's. */
const FAIL_FRESH_SLACK_MS = 1_000;
/** How many times one invocation goes round take-the-lock (a stale lock is removed once only). */
const LOCK_ROUNDS_MAX = 4;

/** Write all of `text` at the file's position. Throws what writeSync throws. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error('the write made no progress');
    }
    offset += written;
  }
}

/** Create `file` exclusively with `mode`: its descriptor, or the errno of the failure. */
function createExclusive(file: string, mode: number): number | string {
  try {
    return fs.openSync(file, 'wx', mode);
  } catch (err) {
    return errnoOf(err) ?? describe(err);
  }
}

type LockJudgement =
  | { kind: 'taken' }
  /** It vanished between the attempt to create it and the look at it. */
  | { kind: 'gone' }
  /**
   * Its holder is alive, and it is younger than START_LOCK_STALE_MS or a process of its spec is
   * (or may be) alive.
   */
  | { kind: 'held'; mtimeMs: number }
  /**
   * Removable (once): its holder is gone — or it is older than START_LOCK_STALE_MS and no process
   * of its spec is alive (§15.12 L11). `holderDead` says whether its spec may go with it.
   */
  | { kind: 'stale'; content: string; mtimeMs: number; holderDead: boolean };

/** Is the holder a lock names still that process (same pid, start time within the slack)? */
function holderAlive(holder: ProcessIdentity): boolean {
  if (!pidAlive(holder.pid)) {
    return false;
  }
  const startedAt = processStartedAt(holder.pid);
  // `ps` without an answer proves nothing either way; the lock's age and its spec's processes
  // still decide (judgeLock).
  return startedAt === undefined || sameProcess(holder, { pid: holder.pid, startedAt });
}

/**
 * Is a process started for this session's start spec alive — the host (`server.js --host <spec>`)
 * or the intermediate about to start it (`cli.js --cco-launch-host <spec>`)? The question §15.12
 * asks before a start lock is taken over (L11) and before one more host is started (M5). `true` /
 * `false` from one listing of every process (`ps -A -ww -o pid= -o args=` — each `-o` on its own,
 * as procps needs; execFile with SYSTEM_TOOL_ENV, 5 s); `undefined` when `ps` gave no listing,
 * which both callers read as "maybe": a host that may be starting must not have its spec replaced
 * under it or a second host started beside it, and "maybe" costs only a wait that is bounded.
 *
 * A command line is matched by its ASCII TAIL — ` --host ` (or ` --cco-launch-host `) in it and
 * `/s<P>.spec.json` at its end — never by the whole spec path: `ps` prints a byte its locale
 * cannot print as `M-x` (probed on macOS with no locale), so a data root under a non-ASCII path
 * would never match whole. The tail can match too much (a host of another data root for a
 * session of the same pid), never too little — and too much is the waiting side. The host never
 * renames its process (no process.title), so its argv is what `ps` shows. A running `ps` is ended
 * by finish(). Never rejects.
 */
function hostProcessOfSpec(place: SessionPlace): Promise<boolean | undefined> {
  if (finished) {
    return Promise.resolve(undefined);
  }
  const tail = `${path.sep}${path.basename(place.files().spec)}`;
  const flags = [` ${HOST_ARG} `, ` ${LAUNCH_HOST_ARG} `];
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    const release = (): void => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // gone already
      }
    };
    try {
      child = execFile(
        'ps',
        ['-A', '-ww', '-o', 'pid=', '-o', 'args='],
        { encoding: 'buffer', env: SYSTEM_TOOL_ENV, timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: PS_MAX_BUFFER_BYTES },
        (err, stdout) => {
          cleanups.delete(release);
          if (err !== null) {
            resolve(undefined);
            return;
          }
          let listed = 0;
          for (const entry of stdout.toString('utf8').split('\n')) {
            const columns = /^\s*([0-9]+)\s+(.*)$/.exec(entry.trimEnd());
            if (columns === null) {
              continue;
            }
            listed += 1;
            const args = columns[2];
            if (Number(columns[1]) !== process.pid && args.endsWith(tail) && flags.some((flag) => args.includes(flag))) {
              resolve(true);
              return;
            }
          }
          // A listing without a single process (not even `ps` itself) is no listing.
          resolve(listed > 0 ? false : undefined);
        },
      );
      child.on('error', () => undefined);
      cleanups.add(release);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * What the lock that is there says (§15.3 step 5, §15.12 L11). Stale ONLY when its holder is
 * gone, or when it is older than START_LOCK_STALE_MS (60 s — longer than the longest legitimate
 * hold: lsof, then two starts of 20 s each) AND no process of its spec is alive (hostProcessOfSpec
 * says `false`; a `ps` that cannot answer keeps it held). So a live holder whose start is merely
 * slow is never taken over, and the spec its host has yet to read is never removed under it
 * (removeStaleLock). A lock without an identity in it is one being written (younger than
 * LOCK_BEING_WRITTEN_MS) or one whose writer died before writing it — a holder that is gone.
 * Never rejects.
 */
async function judgeLock(place: SessionPlace): Promise<LockJudgement> {
  const lock = place.files().lock;
  const st = lstatQuiet(lock);
  if (st === undefined) {
    return { kind: 'gone' };
  }
  const content = readSmallText(lock, LOCK_MAX_BYTES) ?? '';
  const age = Date.now() - st.mtimeMs;
  let holder: ProcessIdentity | undefined;
  try {
    holder = identityOf(JSON.parse(content));
  } catch {
    holder = undefined;
  }
  if (holder === undefined) {
    return age < LOCK_BEING_WRITTEN_MS
      ? { kind: 'held', mtimeMs: st.mtimeMs }
      : { kind: 'stale', content, mtimeMs: st.mtimeMs, holderDead: true };
  }
  if (!holderAlive(holder)) {
    return { kind: 'stale', content, mtimeMs: st.mtimeMs, holderDead: true };
  }
  if (age >= START_LOCK_STALE_MS && (await hostProcessOfSpec(place)) === false) {
    return { kind: 'stale', content, mtimeMs: st.mtimeMs, holderDead: false };
  }
  return { kind: 'held', mtimeMs: st.mtimeMs };
}

/** Release `s<P>.lock` when this process holds it — only while it still names this process. */
function releaseStartLock(place: SessionPlace): void {
  if (!place.lockHeld) {
    return;
  }
  place.lockHeld = false;
  cleanups.delete(lockReleases.get(place) ?? noop);
  lockReleases.delete(place);
  const lock = place.files().lock;
  const text = readSmallText(lock, LOCK_MAX_BYTES);
  let holder: ProcessIdentity | undefined;
  try {
    holder = text === undefined ? undefined : identityOf(JSON.parse(text));
  } catch {
    holder = undefined;
  }
  if (holder !== undefined && holder.pid === place.self.pid && holder.startedAt === place.self.startedAt) {
    removeQuietly(lock);
  }
}

function noop(): void {
  // nothing to release
}

/** The cleanup that releases a place's lock, so that releaseStartLock can take it back out. */
const lockReleases = new Map<SessionPlace, () => void>();

/**
 * Take `s<P>.lock` (exclusive create, content `{pid, startedAt}` of this client), or say what the
 * lock that is there means. A create that fails for another reason than EEXIST is 22: without the
 * lock, two clients could start two hosts at once. Asynchronous only in judging a lock that is
 * there (judgeLock may ask `ps`); a lock this process takes is held, and on finish()'s list,
 * before the call returns.
 */
async function takeStartLock(place: SessionPlace): Promise<LockJudgement> {
  const lock = place.files().lock;
  const fd = createExclusive(lock, 0o600);
  if (typeof fd === 'string') {
    if (fd !== 'EEXIST') {
      cannotRunOn(`could not take the start lock ${shownPath(lock)} (${fd}).`, fd);
    }
    return judgeLock(place);
  }
  let failure: string | undefined;
  try {
    writeAllSync(fd, JSON.stringify(place.self));
  } catch (err) {
    failure = errnoOf(err) ?? describe(err);
  } finally {
    closeQuietly(fd);
  }
  if (failure !== undefined) {
    removeQuietly(lock);
    cannotRunOn(`could not write the start lock ${shownPath(lock)} (${failure}).`, failure);
  }
  place.lockHeld = true;
  const release = (): void => releaseStartLock(place);
  lockReleases.set(place, release);
  cleanups.add(release);
  return { kind: 'taken' };
}

/**
 * Remove a stale lock — only while it is still the one judged stale (same mtime, same content) —
 * and its spec ONLY when the lock's holder is dead (§15.12 L11): a live holder's spec may be the
 * one its host has yet to read, and a host that finds its spec gone refuses to start. (A spec
 * left here is replaced, removed first, by the next start's writeStartSpec.) Stated residual:
 * between that look and the unlink another client can remove the lock and create its own, which
 * this unlink would then remove; the worst that follows is two hosts started at once, and the
 * second one finds the first listening and exits quietly (§15.2 step 2e), so both clients end up
 * with the one host.
 */
function removeStaleLock(place: SessionPlace, judged: { content: string; mtimeMs: number; holderDead: boolean }): void {
  const files = place.files();
  const st = lstatQuiet(files.lock);
  if (st === undefined) {
    return;
  }
  if (st.mtimeMs !== judged.mtimeMs || (readSmallText(files.lock, LOCK_MAX_BYTES) ?? '') !== judged.content) {
    return;
  }
  removeQuietly(files.lock);
  if (judged.holderDead) {
    removeQuietly(files.spec);
  }
}

/**
 * The sentence a host that refused to start left in its fail file (§15.2 step 2), when there is
 * one written at or after `sinceMs` (undefined = any). One line, bounded; a fail file with no
 * words still says that the host refused.
 */
function failSentence(files: HostFiles, sinceMs: number | undefined): string | undefined {
  const st = lstatQuiet(files.fail);
  if (st === undefined || (sinceMs !== undefined && st.mtimeMs < sinceMs)) {
    return undefined;
  }
  const text = readSmallText(files.fail, FAIL_MAX_BYTES);
  if (text === undefined) {
    return undefined;
  }
  const sentence = shown(text.trim(), FAIL_SENTENCE_MAX_CHARS);
  return sentence === '' ? `the dispatch host refused to start and gave no reason (its log: ${fullPath(files.log)}).` : sentence;
}

/**
 * 22 with the host's own refusal (§15.3 step 5: "the fail file → 22 with its sentence"). Written
 * WHOLE, as a pinned line, not as a 300-character diagnostic: the sandbox refusal of §15.2 step 2d
 * is longer than that, and its second half is the setting to add — cutting it would keep the
 * complaint and drop the remedy (stated).
 */
function hostRefused(sentence: string): never {
  throw new CcoExit(EXIT.cannotRun, [], [`cco: ${sentence}`]);
}

/** The last LOG_TAIL_LINES non-empty lines of the host log, each one line of at most 200 characters. */
function logTail(logPath: string): string[] {
  const opened = openRegular(logPath);
  if (opened.kind !== 'open') {
    return [];
  }
  try {
    const size = fs.fstatSync(opened.fd).size;
    const length = Math.min(size, LOG_TAIL_READ_BYTES);
    if (length <= 0) {
      return [];
    }
    const buf = Buffer.alloc(length);
    const n = fs.readSync(opened.fd, buf, 0, length, size - length);
    return buf
      .subarray(0, n)
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => sliceChars(oneLine(line).trimEnd(), LOG_TAIL_LINE_MAX_CHARS))
      .filter((line) => line.trim() !== '')
      .slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  } finally {
    closeQuietly(opened.fd);
  }
}

/**
 * 22: no host answered in time (§15.3 step 5) — the sentence, then the log's last five lines. That
 * is six stderr lines where §15.3.4 allows five diagnostics: all six are written as they are
 * (pinned), because the contract asks for all five log lines, and the log path must be whole to
 * be opened (stated).
 */
function startTimedOut(files: HostFiles): never {
  throw new CcoExit(EXIT.cannotRun, [], [
    `cco: the dispatch host did not start within ${Math.round(HOST_START_TIMEOUT_MS / 1000)} s — see ${fullPath(files.log)}`,
    ...logTail(files.log).map((line) => `cco:   ${line}`),
  ]);
}

/**
 * The start spec (§15.2 step 1), 0600, created fresh: a leftover of an earlier attempt is removed
 * first, and the exclusive create cannot follow a link planted at its name.
 */
function writeStartSpec(place: SessionPlace, workspace: string, serverHash: string): void {
  const files = place.files();
  const spec: HostSpec = {
    protocol: PROTOCOL_VERSION,
    session: place.session,
    workspace,
    socket: place.socket(),
    serverHash,
    logPath: files.log,
    failPath: files.fail,
  };
  removeQuietly(files.spec);
  const fd = createExclusive(files.spec, 0o600);
  if (typeof fd === 'string') {
    cannotRunOn(`could not write the start spec ${shownPath(files.spec)} (${fd}).`, fd);
  }
  let failure: string | undefined;
  try {
    writeAllSync(fd, JSON.stringify(spec));
  } catch (err) {
    failure = errnoOf(err) ?? describe(err);
  } finally {
    closeQuietly(fd);
  }
  if (failure !== undefined) {
    removeQuietly(files.spec);
    cannotRunOn(`could not write the start spec ${shownPath(files.spec)} (${failure}).`, failure);
  }
}

/**
 * Start the INTERMEDIATE of the double fork (§15.2 step 1): `process.execPath cli.js
 * --cco-launch-host <spec>`, detached, stdio 'ignore', unref'd. It is the only child this process
 * ever has, it lives for milliseconds, and nothing waits for it: whether a host came up is learned
 * from the socket and the fail file. A spawn that fails says so through `place.spawnFailure`.
 */
function spawnIntermediate(place: SessionPlace, workspace: string): void {
  place.spawnFailure = undefined;
  let child: ChildProcess | string;
  try {
    child = spawn(process.execPath, [__filename, LAUNCH_HOST_ARG, place.files().spec], {
      detached: true,
      stdio: 'ignore',
      cwd: workspace,
      env: process.env,
    });
  } catch (err) {
    child = errnoOf(err) ?? describe(err);
  }
  if (typeof child === 'string') {
    cannotRunOn(`the dispatch host could not be started: ${shownPath(process.execPath)} did not run (${child}).`, child);
  }
  child.on('error', (err: Error) => {
    place.spawnFailure = errnoOf(err) ?? describe(err);
  });
  child.unref();
}

type Connected = { link: HostLink; hello: HelloResult };

/** One start of the host (§15.2 step 1): a fresh spec, then the intermediate. That start's deadline. */
function startOnce(place: SessionPlace, workspace: string, serverHash: string): number {
  writeStartSpec(place, workspace, serverHash);
  spawnIntermediate(place, workspace);
  return Date.now() + HOST_START_TIMEOUT_MS;
}

/**
 * This process holds the lock: remove a stale fail file, then start the host and poll every
 * 100 ms (§15.3 step 5) for connect + hello → done; the fail file → 22 with its sentence;
 * HOST_START_TIMEOUT_MS → 22 with the log's tail.
 *
 * The intermediate is spawned when a poll finds NOTHING listening — normally the first poll. A
 * poll that meets another session's host on the socket (-32011, a stale host after pid reuse)
 * spawns nothing yet: a host started now would find that one listening and exit quietly (§15.2
 * step 2e). That host shuts itself down within SESSION_POLL_MS of noticing its session is gone,
 * and the first poll that then finds the socket free starts ours.
 *
 * §15.12 M5: one more start, too, when after a start the socket has read "none" for
 * RESTART_AFTER_NONE_MS without a break and no process of the spec is alive (hostProcessOfSpec,
 * asked at most every HOST_PROCESS_RECHECK_MS; a `ps` that cannot answer starts nothing) — the
 * host that was started left without listening and without a refusal: it met a host in its
 * shutdown grace, still bound but no longer answering, and took it for a live one; or the start
 * died before a word. A refusal is looked for first, every poll, so it is said rather than
 * retried. At most two starts in all, by either rule, each with a fresh spec and its own
 * HOST_START_TIMEOUT_MS.
 */
async function startHostAndWait(place: SessionPlace): Promise<Connected> {
  const files = place.files();
  removeQuietly(files.fail);
  const serverHash = place.serverHash;
  if (serverHash === undefined) {
    cannotRun(
      `the dispatch server ${shownPath(serverJsPath())} is missing. Reopen VS Code so Claude Code Orchestrator can restore it.`,
    );
  }
  const workspace = await place.sessionCwd();
  let spawns = 0;
  let staleSinceSpawn = false;
  /** Since when the polls after the last start have read "none" without a break; undefined otherwise. */
  let noneSince: number | undefined;
  let lastProcessLook = 0;
  let deadline = Date.now() + HOST_START_TIMEOUT_MS;
  for (;;) {
    stopIfFinished();
    const outcome = await connectAndHello(place, Math.max(HOST_POLL_MS, deadline - Date.now()));
    stopIfFinished();
    if (outcome.kind === 'ok') {
      return outcome;
    }
    if (outcome.kind === 'mismatch') {
      cannotRun(MISMATCH_SENTENCE);
    }
    if (outcome.kind === 'broken') {
      cannotRunOn(outcome.sentence, outcome.code);
    }
    if (outcome.kind === 'stale') {
      staleSinceSpawn = true;
    }
    if (outcome.kind !== 'none') {
      noneSince = undefined;
    } else if (noneSince === undefined) {
      noneSince = Date.now();
    }
    if (outcome.kind === 'none' && (spawns === 0 || (staleSinceSpawn && spawns < 2))) {
      deadline = startOnce(place, workspace, serverHash);
      spawns += 1;
      staleSinceSpawn = false;
      noneSince = undefined;
    }
    // 'silent' (connected, no answer yet) and 'none' after the spawn: keep polling.
    const refusal = failSentence(files, undefined);
    if (refusal !== undefined) {
      hostRefused(refusal);
    }
    if (place.spawnFailure !== undefined) {
      cannotRunOn(
        `the dispatch host could not be started: ${shownPath(process.execPath)} did not run (${place.spawnFailure}).`,
        place.spawnFailure,
      );
    }
    if (
      spawns === 1 &&
      noneSince !== undefined &&
      Date.now() - noneSince >= RESTART_AFTER_NONE_MS &&
      Date.now() - lastProcessLook >= HOST_PROCESS_RECHECK_MS
    ) {
      lastProcessLook = Date.now();
      const alive = await hostProcessOfSpec(place);
      stopIfFinished();
      if (alive === false) {
        deadline = startOnce(place, workspace, serverHash);
        spawns += 1;
        noneSince = undefined;
      }
    }
    if (Date.now() >= deadline) {
      startTimedOut(files);
    }
    await sleep(HOST_POLL_MS);
  }
}

/**
 * Another live client holds the lock and is starting the host: poll every 100 ms, up to
 * HOST_START_TIMEOUT_MS, for connect + hello. Its host's fail file (written after that lock) is
 * this call's answer too. Every LOCK_RECHECK_MS the lock is looked at again: gone or stale (its
 * holder died between the spec and the intermediate — §15.9 — or it outlived START_LOCK_STALE_MS
 * with no process of its spec alive — §15.12 L11), and the poll made at once after that still
 * finds no host → 'retake', and the caller takes the lock and starts the host itself.
 */
async function waitForAnotherStart(place: SessionPlace, lockMtimeMs: number): Promise<Connected | 'retake'> {
  const files = place.files();
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  let lastLockLook = Date.now();
  let lockLost = false;
  for (;;) {
    stopIfFinished();
    const outcome = await connectAndHello(place, Math.max(HOST_POLL_MS, deadline - Date.now()));
    stopIfFinished();
    if (outcome.kind === 'ok') {
      return outcome;
    }
    if (outcome.kind === 'mismatch') {
      cannotRun(MISMATCH_SENTENCE);
    }
    if (outcome.kind === 'broken') {
      cannotRunOn(outcome.sentence, outcome.code);
    }
    const refusal = failSentence(files, lockMtimeMs - FAIL_FRESH_SLACK_MS);
    if (refusal !== undefined) {
      hostRefused(refusal);
    }
    if (lockLost) {
      // The poll right after the lock went found no host either: the start it covered failed.
      return 'retake';
    }
    if (Date.now() - lastLockLook >= LOCK_RECHECK_MS) {
      lastLockLook = Date.now();
      const judged = await judgeLock(place);
      stopIfFinished();
      if (judged.kind === 'gone' || judged.kind === 'stale') {
        // A starter releases its lock the moment its host answered, so one more poll — at once —
        // usually finds that host; only when it does not is the lock taken over.
        lockLost = true;
        continue;
      }
    }
    if (Date.now() >= deadline) {
      startTimedOut(files);
    }
    await sleep(HOST_POLL_MS);
  }
}

/**
 * No host answered for this session (ENOENT / ECONNREFUSED / -32011): take the start lock and
 * start one, or wait for the one another client of this session is starting (§15.3 step 5, §15.9
 * "two cco of one session start at once"). A stale lock is removed ONCE — with its spec only when
 * its holder is dead (§15.12 L11); the lock this process takes is released on every way out — here
 * in `finally`, and by finish() when a signal ends the run first.
 */
async function startOrJoinHost(place: SessionPlace): Promise<Connected> {
  let staleRemoved = false;
  for (let round = 0; round < LOCK_ROUNDS_MAX; round++) {
    stopIfFinished();
    const judged = await takeStartLock(place);
    if (judged.kind === 'taken') {
      try {
        return await startHostAndWait(place);
      } finally {
        releaseStartLock(place);
      }
    }
    // Judging a lock that is there may have waited for `ps`: a signal in that time decided the end.
    stopIfFinished();
    if (judged.kind === 'gone') {
      continue;
    }
    if (judged.kind === 'stale' && !staleRemoved) {
      staleRemoved = true;
      removeStaleLock(place, judged);
      continue;
    }
    const joined = await waitForAnotherStart(place, judged.mtimeMs);
    if (joined !== 'retake') {
      return joined;
    }
  }
  cannotRun(
    `could not start this session's dispatch host: its start lock ${shownPath(place.files().lock)} kept changing ` +
      'hands. Run the command again.',
  );
}

/**
 * Connect to this session's host (§15.3 step 5): the hello first; no host → start one (or join the
 * start under way). A host that answers in another protocol is 22 with the new-session sentence;
 * one that is connected but silent for HOST_START_TIMEOUT_MS is 22 naming its log.
 *
 * The host record is NOT required when the hello succeeds: a hello that names this session and
 * this protocol proves a live host of this session, while a host that has just begun to listen
 * has not written its record yet (§15.2 step 2f comes after 2e) — treating that as "no host" would
 * start a second host for nothing (it would exit quietly). The record is read only for the
 * workspace before a hello (SessionPlace.earlyWorkspace).
 */
async function connectToHost(place: SessionPlace): Promise<Connected> {
  const first = await connectAndHello(place, HOST_START_TIMEOUT_MS);
  stopIfFinished();
  if (first.kind === 'ok') {
    return first;
  }
  if (first.kind === 'mismatch') {
    cannotRun(MISMATCH_SENTENCE);
  }
  if (first.kind === 'broken') {
    cannotRunOn(first.sentence, first.code);
  }
  if (first.kind === 'silent') {
    cannotRun(
      `this session's dispatch host did not answer within ${Math.round(HOST_START_TIMEOUT_MS / 1000)} s — see ` +
        `${fullPath(place.files().log)}`,
    );
  }
  // 'none' or 'stale': there is no host of this session to talk to.
  return startOrJoinHost(place);
}

/* ------------------------------------------------------------------------- *
 * The request (§15.3.1 table, §15.4)
 * ------------------------------------------------------------------------- */

interface PreparedRequest {
  /** The whole JSON-RPC request line, newline included — built (and measured) before connecting. */
  line: string;
  /** dispatch_task / dispatch_tasks: the calls that report accepted / settled tasks. */
  dispatch: boolean;
  noWait: boolean;
  /** dispatch_task / dispatch_tasks `--wait`: this client's own wait, in seconds. */
  dispatchWait?: number;
  /** dispatch_status `--wait`: cco/status's waitSeconds. */
  statusWait?: number;
  /** dispatch_status / cancel: the ids asked about. */
  ids: string[];
  /** team_wait: cco/team.wait's waitSeconds — the client's own deadline is this plus STATUS_WAIT_CLIENT_SLACK_MS. */
  teamWait?: number;
}

/**
 * The one request of this invocation, as §15.3.1's table (and the team contract's §7.2) says.
 * Built in full BEFORE any connection, so that its size is judged before anything is sent: more
 * than REQUEST_MAX_BYTES once the prompt files are inlined is 21. `args` are the arguments read
 * from the command's file (a dispatch's or a team file operation's). `capChars` is the cap of the
 * answer as it would be printed now (outCap) — sent with team_inbox and team_wait, whose text the
 * host composes to fit it (team contract M9); main() builds the request once more after the hello,
 * when what has been written to stderr meanwhile has lowered it.
 */
function prepareRequest(command: Command, args: Record<string, unknown> | undefined, capChars = outCap()): PreparedRequest {
  let method = 'tools/call';
  let params: Record<string, unknown> = {};
  let teamWait: number | undefined;
  switch (command.op) {
    case 'orchestrator_briefing':
      params = { name: 'orchestrator_briefing', arguments: { model: command.model } };
      break;
    case 'list_workers':
      // Only the switches given are sent: a plain list_workers asks exactly what it always did.
      params = {
        name: command.op,
        arguments: { ...(command.check ? { check: true } : {}), ...(command.diagnostics ? { diagnostics: true } : {}) },
      };
      break;
    case 'mesh_status':
      params = { name: command.op, arguments: {} };
      break;
    case 'dispatch_task':
    case 'dispatch_tasks':
      params = { name: command.op, arguments: args ?? {} };
      break;
    case 'dispatch_status':
      if (command.wait !== undefined) {
        method = METHOD.status;
        params = { ids: command.ids, waitSeconds: command.wait };
      } else {
        params = { name: 'dispatch_status', arguments: { ids: command.ids } };
      }
      break;
    case 'cancel':
      method = METHOD.cancel;
      params = { ids: command.ids };
      break;
    case 'recent':
      method = METHOD.recent;
      params = { limit: command.limit ?? RECENT_DEFAULT };
      if (command.recentTeam) {
        params.team = true;
      }
      break;
    case 'team_create':
    case 'team_add':
    case 'team_send':
    case 'team_task':
      params = { name: command.op, arguments: args ?? {} };
      break;
    case 'team_inbox':
      params = { name: 'team_inbox', arguments: { all: command.all, capChars } };
      break;
    case 'team_wait':
      method = METHOD_TEAM.wait;
      teamWait = command.wait ?? WAIT_MAX_SECONDS;
      params = { waitSeconds: teamWait, settleSeconds: command.settle ?? WAIT_SETTLE_DEFAULT_S, capChars };
      break;
    case 'team_status': {
      const statusArgs: Record<string, unknown> = {};
      if (command.all) {
        statusArgs.all = true;
      } else if (command.memberFlag !== undefined) {
        statusArgs.member = command.memberFlag;
      } else if (command.taskFlag !== undefined) {
        statusArgs.task = command.taskFlag;
      } else if (command.messageFlag !== undefined) {
        statusArgs.message = command.messageFlag;
      }
      params = { name: 'team_status', arguments: statusArgs };
      break;
    }
    case 'team_member': {
      const memberArgs: Record<string, unknown> = { member: command.member, op: command.memberOp };
      if (command.now) {
        memberArgs.now = true;
      }
      if (command.provider !== undefined) {
        memberArgs.provider = command.provider;
      }
      if (command.worker !== undefined) {
        memberArgs.worker = command.worker;
      }
      if (command.model !== undefined) {
        memberArgs.model = command.model;
      }
      params = { name: 'team_member', arguments: memberArgs };
      break;
    }
    case 'team_attach':
      params = { name: 'team_attach', arguments: { member: command.member } };
      break;
    case 'team_end':
      params = { name: 'team_end', arguments: { now: command.now } };
      break;
    case 'team_resume':
      params = { name: 'team_resume', arguments: command.team !== undefined ? { team: command.team } : {} };
      break;
    case 'mesh_stop_worker': {
      const args: Record<string, unknown> = command.job !== undefined ? { job_id: command.job } : { name: command.name };
      if (command.force) {
        args.force = true;
      }
      params = { name: 'mesh_stop_worker', arguments: args };
      break;
    }
  }
  const line = `${JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, method, params })}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > REQUEST_MAX_BYTES) {
    taskFileError(
      `the request is ${bytes} bytes once the prompt files are inlined; the limit is ${bytesLabel(REQUEST_MAX_BYTES)} — ` +
        (isTeamFileOp(command.op) ? 'move long texts into fewer, smaller files.' : 'split the batch into several files.'),
    );
  }
  const dispatch = command.op === 'dispatch_task' || command.op === 'dispatch_tasks';
  return {
    line,
    dispatch,
    noWait: command.noWait,
    dispatchWait: dispatch ? command.wait : undefined,
    statusWait: command.op === 'dispatch_status' ? command.wait : undefined,
    ids: command.ids,
    teamWait,
  };
}

/* ------------------------------------------------------------------------- *
 * Output (§15.3.4)
 * ------------------------------------------------------------------------- */

/** OUT_CAP: 28,000 characters, or BASH_MAX_OUTPUT_LENGTH − 1,000 when that is an integer ≥ 4,000 and less (F5). */
function baseOutCap(): number {
  const raw = process.env.BASH_MAX_OUTPUT_LENGTH?.trim();
  if (raw !== undefined && /^[0-9]{1,15}$/.test(raw)) {
    const value = Number(raw);
    if (value >= OUT_CAP_MIN_ENV && value - OUT_CAP_ENV_MARGIN < OUT_CAP_CHARS) {
      return value - OUT_CAP_ENV_MARGIN;
    }
  }
  return OUT_CAP_CHARS;
}

/**
 * The cap of the answer on stdout (§15.12 M3): OUT_CAP (baseOutCap) less the characters this
 * invocation has written to stderr so far, floored at OUT_CAP_FLOOR_CHARS. Claude Code shows
 * stdout and stderr as ONE output: a batch's accepted / settled lines on top of a full 28,000
 * would push the two past its ~30,000-character limit (F5), and the model would get a
 * 2,000-character preview instead of the cut answer and its footer. The floor never lifts the cap
 * above OUT_CAP itself (a BASH_MAX_OUTPUT_LENGTH of 4,000 keeps 3,000). Asked when the answer is
 * rendered — every stderr line of the call has been written by then; the answer's own finish()
 * writes none.
 */
function outCap(): number {
  const base = baseOutCap();
  return Math.min(base, Math.max(OUT_CAP_FLOOR_CHARS, base - stderrChars));
}

/**
 * Where a text longer than the cap is cut (§15.3.4): after the last line end that leaves at most
 * `limit` characters; when there is no line end in the last half of those, at `limit` itself —
 * never between the two halves of a surrogate pair.
 */
function cutPoint(text: string, limit: number): number {
  const newline = text.lastIndexOf('\n', limit - 1);
  if (newline >= 0 && newline + 1 > limit / 2) {
    return newline + 1;
  }
  let at = limit;
  const code = text.charCodeAt(at - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    at -= 1;
  }
  return at;
}

/**
 * `<workspace>/.cco` as a REAL directory, with `.gitignore` holding exactly `*\n` created when
 * absent (§15.3.2) — exclusive create, so an existing one (or a link at its name) is never
 * rewritten, and a create that fails says nothing. `.cco` is created when absent only when
 * `create` says so. The errno-like code of why there is no usable directory otherwise (a
 * symbolic link: ELOOP; not a directory: ENOTDIR). Nothing in `.cco/` is ever deleted. Stated
 * residual: a `.gitignore` whose write fails after its create (a full disk) stays as created —
 * empty — and is never rewritten.
 */
function ensureCcoDir(workspace: string, create: boolean): { dir: string } | { code: string } {
  const dir = path.join(workspace, TASK_FILE_DIR);
  let st = lstatQuiet(dir);
  if (st === undefined) {
    if (!create) {
      return { code: 'ENOENT' };
    }
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        return { code: errnoOf(err) ?? 'EIO' };
      }
    }
    st = lstatQuiet(dir);
    if (st === undefined) {
      return { code: 'ENOENT' };
    }
  }
  if (st.isSymbolicLink()) {
    return { code: 'ELOOP' };
  }
  if (!st.isDirectory()) {
    return { code: 'ENOTDIR' };
  }
  const fd = createExclusive(path.join(dir, '.gitignore'), 0o644);
  if (typeof fd === 'number') {
    try {
      writeAllSync(fd, TASK_FILE_DIR_GITIGNORE);
    } catch {
      // nothing is said; see the residual above
    } finally {
      closeQuietly(fd);
    }
  }
  return { dir };
}

/** Open for writing: create or replace, never through a link, never blocking on a FIFO. */
const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0);

/** Local time as `YYYYMMDD-HHMMSS`. */
function fileStamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

/** What the output of one answer needs to know (§15.3.4). */
interface AnswerView {
  op: OperationName;
  /** The hello's workspace: where `.cco/out/` is. */
  workspace: string;
  /** The hello's data root: where the reports are. */
  dataRoot: string;
  /** dispatch_task / dispatch_tasks. */
  dispatch: boolean;
  /** The accepted ids, in order. */
  accepted: string[];
  /** The id the saved file is named after; the client pid when there is none. */
  firstId: string | undefined;
}

/**
 * The FULL text, into `<workspace>/.cco/out/<YYYYMMDD-HHMMSS>-<operation>-<first id or pid>.md`
 * (creating `.cco/` and `.cco/out/`): the path, or the errno code of why it could not be saved.
 * Never throws.
 */
function saveFullText(text: string, view: AnswerView): { file: string } | { code: string } {
  const cco = ensureCcoDir(view.workspace, true);
  if ('code' in cco) {
    return cco;
  }
  const outDir = path.join(cco.dir, OUTPUT_SUBDIR);
  let st = lstatQuiet(outDir);
  if (st === undefined) {
    try {
      fs.mkdirSync(outDir, { mode: 0o700 });
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        return { code: errnoOf(err) ?? 'EIO' };
      }
    }
    st = lstatQuiet(outDir);
  }
  if (st === undefined) {
    return { code: 'ENOENT' };
  }
  if (st.isSymbolicLink()) {
    return { code: 'ELOOP' };
  }
  if (!st.isDirectory()) {
    return { code: 'ENOTDIR' };
  }
  const file = path.join(outDir, `${fileStamp(new Date())}-${view.op}-${view.firstId ?? String(process.pid)}.md`);
  let fd: number;
  try {
    fd = fs.openSync(file, WRITE_FLAGS, 0o600);
  } catch (err) {
    return { code: errnoOf(err) ?? 'EIO' };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      return { code: 'EINVAL' };
    }
    writeAllSync(fd, text);
    return { file };
  } catch (err) {
    return { code: errnoOf(err) ?? 'EIO' };
  } finally {
    closeQuietly(fd);
  }
}

/**
 * The answer's text as stdout gets it (§15.3.4). At most OUT_CAP characters as it is — the cap of
 * outCap, less what this invocation already wrote to stderr (§15.12 M3); a longer one is saved in
 * full and printed cut at a line end before OUT_CAP − FOOTER_RESERVE (that same cap, and the
 * reserve at most half of it), then `[cut at <n> of <m> characters — the full text is in <path>]`
 * (or `… could not be saved: <code>`) and, for a dispatch, `<id>  report: <data root>/tasks/<id>.md`
 * for every accepted id. A disk that is full costs the saved copy, never the printed text.
 *
 * FOOTER_RESERVE is host-protocol footerReserveChars: 1,000 + 100 per accepted id, at most half
 * the cap — and, since team mode, + TEAM_FOOTER_RESERVE_CHARS (300) for the unread team footer
 * (team contract §4.4 item 2, L9), WHETHER OR NOT this answer carries one: the host composes the
 * lead's inbox under exactly this reserve (M9), so the two sides must cut alike. `tailChars` is
 * the room the line that follows the answer will take (the footer, printed last by onAnswer):
 * a text that fits only without it is cut like a longer one, so that the footer always fits.
 */
function renderAnswer(text: string, view: AnswerView, tailChars = 0): string {
  const cap = outCap();
  if (text.length <= cap - tailChars) {
    return text === '' || text.endsWith('\n') ? text : `${text}\n`;
  }
  const reserve = footerReserveChars(cap, view.accepted.length);
  const at = cutPoint(text, cap - reserve);
  const head = text.slice(0, at);
  const saved = saveFullText(text, view);
  const where = 'file' in saved ? `the full text is in ${saved.file}` : `the full text could not be saved: ${saved.code}`;
  const lines = [`${head}${head.endsWith('\n') ? '' : '\n'}[cut at ${at} of ${text.length} characters — ${where}]`];
  if (view.dispatch) {
    for (const id of view.accepted) {
      lines.push(`${id}  report: ${path.join(view.dataRoot, 'tasks', `${id}.md`)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The text of an MCP-shaped answer: `content[0].text` when it is a string (§15.4's last rule). */
function answerTextOf(result: unknown): string | undefined {
  if (!isPlainObject(result) || !Array.isArray(result.content) || result.content.length === 0) {
    return undefined;
  }
  const item: unknown = result.content[0];
  return isPlainObject(item) && typeof item.text === 'string' ? item.text : undefined;
}

/**
 * The unread team footer of an answer (TextResult.footer, team contract §4.4 item 2, L9), as the
 * LAST line of stdout prints it: one line, at most TEAM_FOOTER_RESERVE_CHARS — the share of
 * FOOTER_RESERVE kept for it. Undefined when the answer carries none (no team, nothing unread, a
 * host of an earlier build).
 */
function footerLineOf(result: unknown): string | undefined {
  if (!isPlainObject(result) || typeof result.footer !== 'string') {
    return undefined;
  }
  const line = sliceChars(oneLine(result.footer).trim(), TEAM_FOOTER_RESERVE_CHARS);
  return line === '' ? undefined : line;
}

/** cco/status's `pending`, by value: the well-formed ids, in order, once each. */
function pendingIdsOf(result: unknown): string[] {
  if (!isPlainObject(result) || !Array.isArray(result.pending)) {
    return [];
  }
  const ids = result.pending.filter((id: unknown): id is string => typeof id === 'string' && TASK_ID.test(id));
  return [...new Set(ids)];
}

/**
 * §15.3.4: the line a wait that ran out (23), or a signal (24), leaves on stdout. `settledNote`
 * follows the ids when some of a dispatch's tasks already settled (§15.12 L3 — dispatchStillOutLine).
 */
function stillRunningLine(seconds: number, ids: readonly string[], settledNote = ''): string {
  const list = ids.join(' ');
  return (
    `Still running after ${seconds} s: ${list}${settledNote} — the work goes on. ` +
    `Read it with: ${COMMAND_SPELLING} dispatch_status --wait 540 ${list}`
  );
}

/** A wait that ended before any task id was reported: one line, and where to find the work. */
function nothingAcceptedLine(how: string): string {
  return (
    `${how}: nothing was accepted yet — the work, if any, goes on; ` +
    `${COMMAND_SPELLING} recent lists this workspace's tasks.`
  );
}

/* ------------------------------------------------------------------------- *
 * The call (§15.3 step 6, §15.3.3, §15.3.4)
 * ------------------------------------------------------------------------- */

/** What a signal, a timer or the end of the connection needs to know to say what goes on. */
const callState = {
  /** When the request was sent; 0 before. */
  sentAt: 0,
  dispatch: false,
  /** Accepted tasks, in order (cco/accepted). */
  accepted: [] as Array<{ id: string; title: string }>,
  /** cco/settled per task id: the first status heard for it (§15.12 L3). */
  settled: new Map<string, 'done' | 'error'>(),
  /** dispatch_status --wait: the ids asked about. */
  statusIds: [] as string[],
  /** The team operation of this call, when it is one. */
  teamOp: undefined as TeamOperationName | undefined,
};

/**
 * The line of a team operation's 23 or 24: what goes on, and what to run. A team_wait that
 * stopped waiting changes nothing of the team (§4.4): it is run again. Any other team operation
 * was sent and is carried out by the host whether or not this call heard its answer — team_status
 * says how it went.
 */
function teamStillOutLine(op: TeamOperationName, how: string): string {
  if (op === 'team_wait') {
    return `${how}: the team goes on — run ${COMMAND_SPELLING} team_wait again (with run_in_background) to keep waiting.`;
  }
  return `${how}: the ${op} request was sent and the host carries it out — check with ${COMMAND_SPELLING} team_status.`;
}

function secondsSinceSent(): number {
  return callState.sentAt > 0 ? Math.max(0, Math.floor((Date.now() - callState.sentAt) / 1000)) : 0;
}

/**
 * The ids out as far as the call knows: a dispatch's accepted ones — ALL of them, as the host-ended
 * line names them (onCallGone) — or a status wait's own.
 */
function idsStillOut(): string[] {
  return callState.dispatch ? callState.accepted.map((task) => task.id) : callState.statusIds;
}

/**
 * §15.12 L3: what a dispatch's wait that ran out (23), or a signal (24), leaves on stdout. It names
 * only the accepted ids not settled yet, in acceptance order — the model re-polls what is still
 * out, not what its `settled` lines already told it about — then ` (<k> already settled: done <d>,
 * error <e>)` when k > 0; the status command it gives names the same ids. When every accepted id
 * settled before the answer arrived (the answer was on its way), the line says so and names them
 * all for dispatch_status, without a wait: `All <n> tasks settled; read them with: …` (the pinned
 * words, whatever n is). Called with at least one accepted id.
 */
function dispatchStillOutLine(seconds: number): string {
  const ids = callState.accepted.map((task) => task.id);
  const open = ids.filter((id) => !callState.settled.has(id));
  if (open.length === 0) {
    return `All ${ids.length} tasks settled; read them with: ${COMMAND_SPELLING} dispatch_status ${ids.join(' ')}`;
  }
  let done = 0;
  let error = 0;
  for (const id of ids) {
    const status = callState.settled.get(id);
    if (status === 'done') {
      done += 1;
    } else if (status === 'error') {
      error += 1;
    }
  }
  const settled = done + error;
  return stillRunningLine(seconds, open, settled > 0 ? ` (${settled} already settled: done ${done}, error ${error})` : '');
}

/**
 * The line of a 23 or a 24 (§15.3.4): for a dispatch with accepted tasks dispatchStillOutLine
 * (§15.12 L3); for a status wait its ids, all of them (no task settles on that call); with nothing
 * out yet, `how` and where the work is found.
 */
function stillOutLine(seconds: number, how: string): string {
  if (callState.dispatch && callState.accepted.length > 0) {
    return dispatchStillOutLine(seconds);
  }
  if (callState.teamOp !== undefined) {
    return teamStillOutLine(callState.teamOp, how);
  }
  const ids = idsStillOut();
  return ids.length > 0 ? stillRunningLine(seconds, ids) : nothingAcceptedLine(how);
}

/**
 * SIGINT / SIGTERM / SIGHUP (§15.3.3: 24): stop waiting — the work goes on; a closed connection is
 * never a cancel (§15.4) — and say on stdout what is still out, as for 23. A start lock held at that
 * moment is released by finish(); a host already being started comes up all the same and serves
 * the next command. A second signal finds the code decided and does nothing.
 */
function onSignal(signal: NodeJS.Signals): void {
  if (finished) {
    return;
  }
  finish(EXIT.signal, `${stillOutLine(secondsSinceSent(), `Stopped waiting (${signal})`)}\n`);
}

/** A timer finish() clears (none is started once finish() has run). */
function startTimer(ms: number, onFire: () => void): void {
  if (finished) {
    return;
  }
  const release = (): void => clearTimeout(timer);
  const timer = setTimeout(
    guarded(() => {
      cleanups.delete(release);
      onFire();
    }),
    ms,
  );
  cleanups.add(release);
}

/** `cco/accepted` (§15.4): one `cco: accepted <id> — <title>` line per task, at once. */
function onAccepted(params: unknown, request: PreparedRequest): void {
  if (!request.dispatch || !isPlainObject(params) || params.requestId !== REQUEST_ID || !Array.isArray(params.tasks)) {
    return;
  }
  let added = 0;
  for (const task of params.tasks as unknown[]) {
    if (!isPlainObject(task) || typeof task.id !== 'string' || !TASK_ID.test(task.id)) {
      continue;
    }
    const id = task.id;
    if (callState.accepted.some((known) => known.id === id)) {
      continue;
    }
    // The host sends the checked title (UNTITLED_TASK when the task had none); a title that is
    // missing or blank here is called the same, so every line keeps the pinned shape.
    const given = typeof task.title === 'string' ? sliceChars(oneLine(task.title).trim(), ACCEPTED_TITLE_MAX_CHARS) : '';
    const title = given === '' ? UNTITLED_TASK : given;
    callState.accepted.push({ id, title });
    added += 1;
    writeErrLine(`cco: accepted ${id} — ${title}`);
  }
  if (request.noWait && added > 0) {
    // §15.3.4 --no-wait: the ids on stdout, the command that reads them, the connection closed, 0.
    const ids = callState.accepted.map((task) => task.id);
    const lines = callState.accepted.map((task) => `${task.id}  ${task.title}`);
    lines.push(`Read the result with: ${COMMAND_SPELLING} dispatch_status ${ids.join(' ')}`);
    finish(EXIT.ok, `${lines.join('\n')}\n`);
  }
}

/**
 * `cco/settled` (§15.4): `cco: settled <id> <done|error>` as each task settles — and the first
 * status heard per id is kept for the 23 / 24 line (§15.12 L3).
 */
function onSettled(params: unknown): void {
  if (!isPlainObject(params) || params.requestId !== REQUEST_ID) {
    return;
  }
  const { id, status } = params;
  if (typeof id !== 'string' || !TASK_ID.test(id) || (status !== 'done' && status !== 'error')) {
    return;
  }
  if (!callState.settled.has(id)) {
    callState.settled.set(id, status === 'done' ? 'done' : 'error');
  }
  writeErrLine(`cco: settled ${id} ${status}`);
}

/**
 * The answer to the request: a JSON-RPC error → 22 with its message; an MCP-shaped result →
 * stdout, 0 or 20 by its `isError`; cco/status with ids still pending → the text, the
 * still-running line, 23 (§15.4).
 */
function onAnswer(message: Record<string, unknown>, request: PreparedRequest, view: AnswerView): void {
  if (message.error !== undefined && message.error !== null) {
    const error = rpcErrorOf(message.error);
    finish(EXIT.cannotRun, '', [
      `the dispatch host refused the request: ${error.message}${error.code === undefined ? '' : ` (${error.code})`}`,
    ]);
    return;
  }
  const result = message.result;
  const text = answerTextOf(result);
  if (text === undefined) {
    finish(EXIT.cannotRun, '', ['the dispatch host answered with no text — a defect in the dispatch server, not in the request.']);
    return;
  }
  const accepted = callState.accepted.map((task) => task.id);
  const firstId = view.dispatch ? accepted[0] : request.ids[0];
  // The unread team footer is the LAST line of stdout, after everything else this answer prints.
  const footer = footerLineOf(result);
  const tail = footer === undefined ? '' : `${footer}\n`;
  const out = renderAnswer(text, { ...view, accepted, firstId }, tail.length);
  if (request.statusWait !== undefined) {
    const pending = pendingIdsOf(result);
    if (pending.length > 0) {
      finish(EXIT.waitElapsed, `${out}${stillRunningLine(request.statusWait, pending)}\n${tail}`);
      return;
    }
  }
  // team_wait (team contract §4.4 item 1): 23 when its deadline came with nothing to wake for.
  if (request.teamWait !== undefined && isPlainObject(result) && result.timedOut === true) {
    finish(EXIT.waitElapsed, `${out}${tail}`);
    return;
  }
  finish(isPlainObject(result) && result.isError === true ? EXIT.toolError : EXIT.ok, `${out}${tail}`);
}

/**
 * The connection ended before the answer (§15.3.3): 22 — "the dispatch host ended while this call
 * waited", its log, and the status command with the ids that are out. That line is written as it
 * is: with up to IDS_MAX ids it can outgrow a diagnostic's 300 characters, and cutting it would
 * lose ids. A line too long for the protocol is the host's defect, said as such.
 */
function onCallGone(why: string, protocolFailure: boolean, place: SessionPlace): void {
  if (finished) {
    return;
  }
  const log = fullPath(place.files().log);
  if (protocolFailure) {
    finish(EXIT.cannotRun, '', [], [`cco: ${why} — a defect in the dispatch server; its log: ${log}`]);
    return;
  }
  const ids = idsStillOut();
  const line =
    ids.length > 0
      ? `cco: the dispatch host ended while this call waited (its log: ${log}); read the outcome with \`${COMMAND_SPELLING} dispatch_status ${ids.join(' ')}\``
      : `cco: the dispatch host ended while this call waited (its log: ${log}).`;
  finish(EXIT.cannotRun, '', [], [line]);
}

/**
 * Send the request and wait (§15.3 step 6). Every way this ends is finish(): the answer; a
 * `--no-wait` dispatch's cco/accepted; a `--wait` that ran out (23 — for a dispatch at <s>
 * seconds, naming the accepted ids not settled yet, or all of them when every one has (§15.12 L3:
 * dispatchStillOutLine); for cco/status at waitSeconds + 30 s, the client's own deadline); a
 * signal (24); the connection ending first (22).
 */
function runCall(place: SessionPlace, connected: Connected, request: PreparedRequest, op: OperationName): void {
  const { link, hello } = connected;
  const view: AnswerView = {
    op,
    workspace: hello.workspace,
    dataRoot: hello.dataRoot,
    dispatch: request.dispatch,
    accepted: [],
    firstId: undefined,
  };
  callState.dispatch = request.dispatch;
  callState.statusIds = request.statusWait !== undefined ? request.ids : [];
  callState.teamOp = isTeamOp(op) ? op : undefined;
  link.listen(
    (message) => {
      if (finished) {
        return;
      }
      if (message.method === METHOD.accepted) {
        onAccepted(message.params, request);
      } else if (message.method === METHOD.settled) {
        onSettled(message.params);
      } else if (isAnswerTo(message, REQUEST_ID)) {
        onAnswer(message, request, view);
      }
    },
    (why, protocolFailure) => onCallGone(why, protocolFailure, place),
  );
  callState.sentAt = Date.now();
  link.send(request.line);
  const dispatchWait = request.dispatchWait;
  if (dispatchWait !== undefined) {
    startTimer(dispatchWait * 1000, () => {
      finish(EXIT.waitElapsed, `${stillOutLine(dispatchWait, `Still running after ${dispatchWait} s`)}\n`);
    });
  }
  const statusWait = request.statusWait;
  if (statusWait !== undefined) {
    startTimer(statusWait * 1000 + STATUS_WAIT_CLIENT_SLACK_MS, () => {
      finish(EXIT.waitElapsed, `${stillRunningLine(secondsSinceSent(), request.ids)}\n`);
    });
  }
  // team_wait: the host answers at its deadline (timedOut, 23); this is the client's own bound on
  // a host that does not, as cco/status has one.
  const teamWait = request.teamWait;
  if (teamWait !== undefined) {
    startTimer(teamWait * 1000 + STATUS_WAIT_CLIENT_SLACK_MS, () => {
      finish(EXIT.waitElapsed, `${teamStillOutLine('team_wait', `No answer from the host after ${secondsSinceSent()} s`)}\n`);
    });
  }
}

/* ------------------------------------------------------------------------- *
 * After the hello: the skew line and `.cco/.gitignore`
 * ------------------------------------------------------------------------- */

/** Is `file` inside `dir` (both as the OS resolves them, links followed when they can be)? */
function liesInside(file: string, dir: string): boolean {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    real = path.resolve(file);
  }
  return real.startsWith(`${dir}${path.sep}`);
}

/**
 * Once the hello has named the host: the skew line when the server.js beside this file is not the
 * build the host runs (§15.2 step 6 — the call proceeds; when the server.js here is missing nothing
 * can be compared and nothing is said); then `<workspace>/.cco/.gitignore` (§15.3.2) on every
 * orchestrator_briefing (creating `.cco/` when absent, so that the scratch files the policy tells
 * the model to write there are ignored from the first one on) and whenever a file read lies inside
 * `<workspace>/.cco/`.
 */
function afterHello(place: SessionPlace, hello: HelloResult, op: OperationName, filesRead: readonly string[]): void {
  const ours = place.serverHash;
  // Team contract §7.6: a host without TEAM_FEATURE (an earlier build) has none of the team
  // methods — said before anything is sent, as 22: this session cannot run teams.
  if (op.startsWith('team_') && !(hello.features ?? []).includes(TEAM_FEATURE)) {
    cannotRun(TEAM_FEATURE_MISSING_SENTENCE);
  }
  if (ours !== undefined && hello.serverHash !== ours) {
    writeErrLine(SKEW_LINE);
  }
  if (op === 'orchestrator_briefing') {
    ensureCcoDir(hello.workspace, true);
    return;
  }
  const ccoDir = path.join(hello.workspace, TASK_FILE_DIR);
  if (filesRead.some((file) => liesInside(file, ccoDir))) {
    ensureCcoDir(hello.workspace, false);
  }
}

/* ------------------------------------------------------------------------- *
 * The intermediate of the double fork (§15.2 step 1): `cli.js --cco-launch-host <spec>`
 * ------------------------------------------------------------------------- */

/** Open the host log for appending: never through a link, never blocking on a FIFO; a regular file or nothing. */
function openHostLog(logPath: string): number | undefined {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0);
  let fd: number;
  try {
    fd = fs.openSync(logPath, flags, 0o600);
  } catch {
    return undefined;
  }
  try {
    if (fs.fstatSync(fd).isFile()) {
      return fd;
    }
  } catch {
    // not examinable: not used
  }
  closeQuietly(fd);
  return undefined;
}

/**
 * The INTERMEDIATE: started detached by a client with stdio 'ignore', it starts the HOST —
 * `process.execPath server.js --host <spec>`, detached (its own session and process group), stdio
 * ['ignore', 'ignore', <the log>], cwd = the spec's workspace, env = this process's (the client's,
 * i.e. the Bash environment) — unrefs it and exits 0 at once. The host's parent is then launchd /
 * init: nothing that ends the Bash command, or the client, reaches it.
 *
 * The log (`s<P>.log`) is renamed to `s<P>.log.1` first when it is larger than
 * HOST_LOG_ROTATE_BYTES, then opened for appending. A log that cannot be opened costs the
 * diagnostics, not the host: the host is started with its stderr ignored.
 *
 * It prints nothing (nobody reads its stdio). When it cannot start the host it leaves one sentence
 * in the fail file — the spec's `failPath`, or the one beside the spec when the spec could not be
 * read — so that the waiting client says it at once instead of after 20 s, and exits
 * HOST_REFUSED_EXIT. The host checks the spec again in full (§15.2 step 2a); only what this step
 * needs (workspace, log) is judged here.
 */
function launchHostIntermediate(specArg: string | undefined): void {
  const besideSpec =
    typeof specArg === 'string' && specArg.endsWith('.spec.json')
      ? `${specArg.slice(0, -'.spec.json'.length)}.fail`
      : undefined;
  const refuse = (sentence: string, failPath: string | undefined): void => {
    if (failPath !== undefined) {
      try {
        fs.writeFileSync(failPath, `${sentence}\n`, { mode: 0o600 });
      } catch {
        // the client's 20 s bound is then what ends its wait
      }
    }
    process.exitCode = HOST_REFUSED_EXIT;
  };
  try {
    if (typeof specArg !== 'string' || !path.isAbsolute(specArg)) {
      refuse('the dispatch host could not be started: its start spec was not named.', besideSpec);
      return;
    }
    const text = readSmallText(specArg, SPEC_MAX_BYTES);
    let spec: unknown;
    try {
      spec = text === undefined ? undefined : JSON.parse(text);
    } catch {
      spec = undefined;
    }
    if (!isPlainObject(spec)) {
      refuse(`the dispatch host could not be started: its start spec ${shownPath(specArg)} could not be read.`, besideSpec);
      return;
    }
    const failPath = typeof spec.failPath === 'string' && path.isAbsolute(spec.failPath) ? spec.failPath : besideSpec;
    const { workspace, logPath } = spec;
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || statQuiet(workspace)?.isDirectory() !== true) {
      refuse('the dispatch host could not be started: the workspace its start spec names is not a directory.', failPath);
      return;
    }
    if (typeof logPath !== 'string' || !path.isAbsolute(logPath)) {
      refuse('the dispatch host could not be started: its start spec names no log file.', failPath);
      return;
    }
    const st = lstatQuiet(logPath);
    if (st !== undefined && st.isFile() && st.size > HOST_LOG_ROTATE_BYTES) {
      try {
        fs.renameSync(logPath, `${logPath}.1`);
      } catch {
        // kept as it is; it is rotated at a later start
      }
    }
    const logFd = openHostLog(logPath);
    let child: ChildProcess | string;
    try {
      child = spawn(process.execPath, [serverJsPath(), HOST_ARG, specArg], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
        cwd: workspace,
        env: process.env,
      });
    } catch (err) {
      child = errnoOf(err) ?? describe(err);
    } finally {
      if (logFd !== undefined) {
        closeQuietly(logFd);
      }
    }
    if (typeof child === 'string') {
      refuse(`the dispatch host could not be started: ${shownPath(process.execPath)} did not run (${child}).`, failPath);
      return;
    }
    // A spawn that failed reports it as an 'error' event on the next tick: heard, never thrown.
    child.on('error', () => undefined);
    if (child.pid === undefined) {
      refuse(`the dispatch host could not be started: ${shownPath(process.execPath)} did not run.`, failPath);
      return;
    }
    child.unref();
    process.exitCode = 0;
  } catch (err) {
    refuse(`the dispatch host could not be started: ${describe(err)}`, besideSpec);
  }
}

/* ------------------------------------------------------------------------- *
 * main
 * ------------------------------------------------------------------------- */

/**
 * One invocation, in §15.3's order. Every way out is finish(): directly, through a CcoExit (21 /
 * 22) caught by the entry point, or from the handlers runCall installs.
 */
async function main(argv: readonly string[]): Promise<void> {
  const first = argv[0];
  // Step 1 — help and version run anywhere: before the environment is looked at.
  if (first === undefined || first === 'help' || first === '--help') {
    finish(EXIT.ok, helpText());
    return;
  }
  if (first === 'version') {
    finish(EXIT.ok, versionLine());
    return;
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, guarded(() => onSignal(signal)));
  }
  // Step 2 — the environment, before anything else is read.
  const session = checkEnvironment();
  // Step 3 — the command line and the task files; nothing is connected to before both passed.
  const op = operationOf(first) ?? unknownOperation(first);
  const command = parseCommand(op, argv.slice(1));
  const place = new SessionPlace(session, selfIdentity());
  const filesRead: string[] = [];
  const onRead = (file: string): void => {
    filesRead.push(file);
  };
  const args =
    command.op === 'dispatch_task' || command.op === 'dispatch_tasks'
      ? await readDispatchArguments(command, () => place.earlyWorkspace(), onRead)
      : isTeamFileOp(command.op)
        ? await readTeamArguments(command.op, command.file ?? '', () => place.earlyWorkspace(), onRead)
        : undefined;
  stopIfFinished();
  let request = prepareRequest(command, args);
  // Steps 4 and 5 — the host (started when there is none).
  const connected = await connectToHost(place);
  stopIfFinished();
  afterHello(place, connected.hello, op, filesRead);
  if (command.recentTeam && !(connected.hello.features ?? []).includes(TEAM_FEATURE)) {
    // An earlier host would ignore `team` and list the dispatches as if asked for team turns.
    cannotRun(TEAM_FEATURE_MISSING_SENTENCE);
  }
  if (command.op === 'team_inbox' || command.op === 'team_wait') {
    // Their capChars is the cap of the answer as it will be printed (M9) — lowered by whatever
    // the start and the hello wrote to stderr meanwhile (the skew line, §15.12 M3).
    request = prepareRequest(command, args);
  }
  // Step 6 — the request; runCall's handlers end the run.
  runCall(place, connected, request, op);
}

/* ------------------------------------------------------------------------- *
 * The team MCP server (team contract §3.7): `cli.js --team-mcp <tool-spec path>`
 * ------------------------------------------------------------------------- */

/** A2: how often the team MCP server looks whether its parent (the vendor CLI) is still the one that started it. */
const TEAM_MCP_PARENT_POLL_MS = 2_000;
/** How long the team MCP server waits for the host's answer to its hello. */
const TEAM_MCP_HELLO_TIMEOUT_MS = 10_000;
/** How long the team MCP server waits for its last answers to be written before it exits. */
const TEAM_MCP_EXIT_FLUSH_MS = 1_000;

/**
 * Read one of the team MCP server's two files (the tool spec, the credential) as §3.7 requires:
 * opened without following a link and without blocking on a FIFO; a REGULAR file of this uid,
 * readable by nobody else (no group or other permission bit — the engine writes them 0600), at
 * most `cap` bytes, strict UTF-8. The text, or why not (one clause). Never throws.
 */
function readPrivateFile(file: string, cap: number): { text: string } | { why: string } {
  const flags = READ_FLAGS | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
  let fd: number;
  try {
    fd = fs.openSync(file, flags);
  } catch (err) {
    return { why: `could not be opened (${errnoOf(err) ?? describe(err)})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return { why: `is ${statKind(st)}, not a regular file` };
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      return { why: 'belongs to another user' };
    }
    if ((st.mode & 0o077) !== 0) {
      return { why: 'is readable or writable by other users (it must be 0600)' };
    }
    const bytes = readCapped(fd, cap);
    if (bytes === undefined) {
      return { why: `is larger than ${bytesLabel(cap)}` };
    }
    const text = strictUtf8(bytes);
    return text === undefined ? { why: 'is not valid UTF-8' } : { text };
  } catch (err) {
    return { why: `could not be read (${errnoOf(err) ?? describe(err)})` };
  } finally {
    closeQuietly(fd);
  }
}

/** The tool spec's fields this server uses (team/contract TeamToolSpec), checked by value. */
interface TeamMcpSpec {
  socket: string;
  teamId: string;
  member: string;
  credentialFile: string;
}

/** The tool spec at `specPath`, checked by value — or the sentence of why it cannot be used. */
function readTeamToolSpec(specPath: string | undefined): TeamMcpSpec | string {
  if (typeof specPath !== 'string' || !path.isAbsolute(specPath)) {
    return `${TEAM_MCP_ARG} needs the absolute path of the member's tool spec`;
  }
  const read = readPrivateFile(specPath, TOOL_SPEC_MAX_BYTES);
  if ('why' in read) {
    return `the tool spec ${shownPath(specPath)} ${read.why}`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return `the tool spec ${shownPath(specPath)} is not valid JSON`;
  }
  if (!isPlainObject(raw)) {
    return `the tool spec ${shownPath(specPath)} is not a JSON object`;
  }
  const { protocol, socket, teamId, member, credentialFile } = raw;
  if (protocol !== PROTOCOL_VERSION) {
    return `the tool spec speaks protocol ${shown(String(protocol), 20)}, and this server ${PROTOCOL_VERSION} — they are from different builds`;
  }
  if (typeof socket !== 'string' || !path.isAbsolute(socket)) {
    return 'the tool spec names no absolute socket path';
  }
  if (typeof teamId !== 'string' || !TEAM_ID.test(teamId) || typeof member !== 'string' || !MEMBER_NAME.test(member)) {
    return 'the tool spec names no team id and member name of the right shape';
  }
  if (typeof credentialFile !== 'string' || !path.isAbsolute(credentialFile)) {
    return 'the tool spec names no absolute credential file';
  }
  return { socket, teamId, member, credentialFile };
}

/**
 * The team MCP server (team contract §3.7, T0 A2): started BY the vendor CLI of a teammate's turn
 * as `<node> cli.js --team-mcp <members/<name>/tool-spec.json>`, a stdio MCP server named
 * TEAM_MCP_SERVER_NAME with the five member tools (TEAM_TOOL_DEFINITIONS), every tools/call
 * forwarded to the host as `cco/member.call {tool, arguments}` and the host's `{content, isError}`
 * answered verbatim.
 *
 * IDENTITY COMES FROM ITS ARGUMENT'S FILES, NEVER FROM ITS ENVIRONMENT (I5): Codex hands an MCP
 * child a filtered environment (RP-6), and a dispatched worker must not be able to pose as a
 * member. BEFORE it answers `initialize` — every message that arrives earlier waits — it reads the
 * spec (readTeamToolSpec), reads the credential file (64 lowercase hex), connects to the spec's
 * socket and greets as `member` (MemberHelloParams); a connect that finds nobody is tried once
 * more after TEAM_MCP_RECONNECT_MS. ANY failure there is one stderr line and exit 1, so the CLI
 * reports that the server failed (and the engine's turns-only verdict sees it, §3.7).
 *
 * ITS LIFE IS ITS TURN'S. It exits — 0 — when its stdin ends (the CLI is gone), when its parent
 * pid changes (A2: a vendor that leaves it behind; looked at every TEAM_MCP_PARENT_POLL_MS), or
 * when the host closes its connection (the host closes a member's connections at `turn.ended`,
 * M19; or the host itself ended). CONTRACT-QUESTION (§3.7 says both "Host gone → every later call
 * answers isError team_gone" and "the server exits on socket close"): the calls in flight when
 * the connection ends are answered isError `team_gone: …` (TEAM_TOOL_TEXT.teamGone), so the model
 * reads why; then the server exits — a later call finds the server gone, as the M19 pin wants.
 *
 * Total: a fault of this code is one stderr line and exit 1. It prints nothing else on stderr.
 */
function runTeamMcp(specArg: string | undefined): void {
  let exiting = false;
  const exitNow = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    process.exitCode = code;
    // What is queued on stdout is written first; a stdout that never drains does not hold the exit.
    const timer = setTimeout(() => process.exit(code), TEAM_MCP_EXIT_FLUSH_MS);
    timer.unref();
    try {
      process.stdout.write('', () => process.exit(code));
    } catch {
      process.exit(code);
    }
  };
  const fail = (sentence: string): void => {
    if (exiting) {
      return;
    }
    try {
      process.stderr.write(`${TEAM_MCP_SERVER_NAME}: ${oneLine(sentence)}\n`);
    } catch {
      // nobody to tell
    }
    exitNow(1);
  };
  process.on('uncaughtException', (err) => fail(`stopped on an internal error: ${describe(err)}`));
  process.on('unhandledRejection', (reason) => fail(`stopped on an internal error: ${describe(reason)}`));
  process.stdout.on('error', () => exitNow(0));
  process.stderr.on('error', () => undefined);

  const write = (message: Record<string, unknown>): void => {
    if (exiting) {
      return;
    }
    try {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    } catch {
      // stdout is gone; its 'error' ends this process
    }
  };

  let client: HostClient | undefined;
  /** tools/call ids waiting for the host's answer — answered `team_gone` when the connection ends. */
  const inFlight = new Set<string | number>();
  const goneAnswer = toolRefusal('team_gone', TEAM_TOOL_TEXT.teamGone());
  const waiting: Array<Record<string, unknown>> = [];

  const handle = (msg: Record<string, unknown>): void => {
    const { id, method } = msg;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (typeof method !== 'string') {
      return;
    }
    if (!hasId) {
      // notifications (initialized, cancelled, …) need no answer
      return;
    }
    switch (method) {
      case 'initialize': {
        const params = isPlainObject(msg.params) ? msg.params : {};
        write({
          id,
          result: {
            protocolVersion: negotiateMcpProtocol(params.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: TEAM_MCP_SERVER_NAME, version: CCO_VERSION },
          },
        });
        return;
      }
      case 'ping':
        write({ id, result: {} });
        return;
      case 'tools/list':
        write({
          id,
          result: {
            tools: TEAM_TOOL_NAMES.map((name) => ({
              name,
              description: TEAM_TOOL_DEFINITIONS[name].description,
              inputSchema: TEAM_TOOL_DEFINITIONS[name].inputSchema,
            })),
          },
        });
        return;
      case 'tools/call': {
        const params = isPlainObject(msg.params) ? msg.params : {};
        const name = params.name;
        if (typeof name !== 'string' || !(TEAM_TOOL_NAMES as readonly string[]).includes(name)) {
          write({
            id,
            error: { code: -32602, message: `Unknown tool: ${shown(String(name), 64)} — tools/list names the tools of this server.` },
          });
          return;
        }
        const host = client;
        if (host === undefined || host.closed) {
          write({ id, result: goneAnswer });
          return;
        }
        inFlight.add(id);
        void host.request(METHOD_TEAM.memberCall, { tool: name, arguments: params.arguments ?? {} }).then((answer) => {
          if (!inFlight.delete(id)) {
            return;
          }
          if (answer.kind === 'result' && isPlainObject(answer.result) && Array.isArray(answer.result.content)) {
            write({ id, result: { content: answer.result.content, isError: answer.result.isError === true } });
            return;
          }
          if (answer.kind === 'error') {
            write({ id, result: { content: [{ type: 'text', text: oneLine(answer.message) }], isError: true } });
            return;
          }
          write({ id, result: goneAnswer });
        });
        return;
      }
      default:
        write({ id, error: { code: -32601, message: `Method not found: ${shown(method, 64)}` } });
    }
  };

  // stdin: read from the start (an end of it is an exit at any moment), answered once connected.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (line.trim() === '') {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(msg)) {
      return;
    }
    if (client === undefined) {
      waiting.push(msg);
      return;
    }
    handle(msg);
  });
  rl.on('close', () => exitNow(0));
  process.stdin.on('error', () => exitNow(0));

  // A2: a parent that changed (the CLI died and this process was handed to init) ends this one.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) {
      exitNow(0);
    }
  }, TEAM_MCP_PARENT_POLL_MS).unref();

  const connect = async (): Promise<void> => {
    const spec = readTeamToolSpec(specArg);
    if (typeof spec === 'string') {
      fail(spec);
      return;
    }
    const credential = readPrivateFile(spec.credentialFile, TOOL_SPEC_MAX_BYTES);
    if ('why' in credential) {
      fail(`the credential file ${shownPath(spec.credentialFile)} ${credential.why}`);
      return;
    }
    const secret = credential.text.trim();
    if (!CREDENTIAL.test(secret)) {
      fail(`the credential file ${shownPath(spec.credentialFile)} does not hold a credential (64 lowercase hex)`);
      return;
    }
    const hello: MemberHelloParams = {
      protocol: PROTOCOL_VERSION,
      role: 'member',
      teamId: spec.teamId,
      member: spec.member,
      credential: secret,
      clientPid: process.pid,
    };
    const opts = { connectTimeoutMs: CONNECT_TIMEOUT_MS, helloTimeoutMs: TEAM_MCP_HELLO_TIMEOUT_MS };
    let greeted = await connectHost(spec.socket, hello, opts);
    if (greeted.kind === 'unreachable' || greeted.kind === 'gone') {
      // §3.7: reconnect once, after a backoff — a host that was busy a moment, not one that refused.
      await new Promise((resolve) => setTimeout(resolve, TEAM_MCP_RECONNECT_MS));
      greeted = await connectHost(spec.socket, hello, opts);
    }
    switch (greeted.kind) {
      case 'ok':
        break;
      case 'unreachable':
        fail(`could not connect to the team's dispatch host at ${shownPath(spec.socket)} (${greeted.code})`);
        return;
      case 'refused':
        fail(`the team's dispatch host refused this member: ${oneLine(greeted.message)}${greeted.code === undefined ? '' : ` (${greeted.code})`}`);
        return;
      case 'timeout':
        fail(`the team's dispatch host did not answer within ${Math.round(TEAM_MCP_HELLO_TIMEOUT_MS / 1000)} s`);
        return;
      default:
        fail("the team's dispatch host closed the connection before it answered");
        return;
    }
    const host = greeted.client;
    client = host;
    host.listen(
      () => undefined,
      () => {
        // The host closed this member's connection (its turn ended, M19) or ended itself: what is
        // in flight is told why, then this server goes.
        for (const id of [...inFlight]) {
          inFlight.delete(id);
          write({ id, result: goneAnswer });
        }
        exitNow(0);
      },
    );
    for (const msg of waiting.splice(0)) {
      handle(msg);
    }
  };
  connect().catch((err: unknown) => fail(`stopped on an internal error: ${describe(err)}`));
}

function entry(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === LAUNCH_HOST_ARG) {
    launchHostIntermediate(argv[1]);
    return;
  }
  if (argv[0] === TEAM_MCP_ARG) {
    runTeamMcp(argv[1]);
    return;
  }
  // EPIPE and its kind arrive as 'error' events on the stream; heard, and nothing more.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  process.on('uncaughtException', (err) => finishFrom(err));
  process.on('unhandledRejection', (reason) => finishFrom(reason));
  main(argv).catch(finishFrom);
}

entry();
