import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { TextDecoder } from 'util';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { hostConfigDir } from '../platform';
import { isPidAlive, processStartedAt, ROOT_DIR } from '../registry';
import { readTextSafe } from '../safeFs';
import {
  TEAM_RPC,
  TEAM_TEXT,
  TeamProtocolError,
  type ConnId,
  type TeamConnections,
  type TeamHostSide,
} from '../team/contract';
import {
  COMMAND_SPELLING,
  HOST_REFUSED_EXIT,
  hostFilesOf,
  LINE_MAX_BYTES,
  METHOD,
  METHOD_TEAM,
  PING_METHOD,
  PROTOCOL_VERSION,
  RPC_ERROR,
  runDirOf,
  sameProcess,
  SESSION_POLL_MS,
  TEAM_FEATURE,
  TEAM_MEMBER_METHODS,
  TEAM_OBSERVER_METHODS,
  TEAM_OBSERVER_OUTBOUND_MAX_BYTES,
  TEAM_OBSERVER_TOOLS,
  TEAM_OPS,
  type HelloParams,
  type HelloResult,
  type HostRecord,
  type HostRole,
  type HostSpec,
  type ProcessIdentity,
} from './host-protocol';

/**
 * mcp/host — the DISPATCH HOST: the cco-dispatch server reached over a Unix socket instead of
 * stdio, living exactly as long as the Claude Code session process that asked for it
 * (contract-2.0-fixes.md §15.1–15.4; every constant, method name, exit code and file name comes
 * from the shared contract file host-protocol.ts and is never spelled here a second time).
 *
 * WHY A SECOND TRANSPORT AND NOT A SECOND SERVER. Everything the MCP server does that matters —
 * the dispatch gate, the round-robin, the mesh owner marker, the session-end stop of its workers,
 * the cancel paths, the reconcile — rests on it being ONE long-lived process per session. A
 * process per `cco` call loses all of that (that is what the critique of the first draft of §15
 * found, nearly finding by finding). So `cco` is a thin client and the server stays exactly what
 * it is: server.ts runs behind this module unchanged in what it does, and this module owns only
 * what the socket adds — STARTING (the spec, its checks, the listen, the record), SERVING (the
 * hello, the line reader, the id mapping) and ENDING (the session watch, the cleanup on the way
 * out).
 *
 * WHAT THIS MODULE DOES NOT DO. It interprets no request beyond the hello. Every other message
 * goes to server.ts's handleRequest — the function stdin's lines go to — under a request id THIS
 * HOST made up, so the bookkeeping server.ts keys by request id (requests in flight, tasks by
 * request, aborted requests) cannot confuse two clients that both count from 1; the answer comes
 * back here, through the transport server.ts sends everything through, and leaves with the
 * client's own id put back. It does not import server.ts: the dependency runs one way, through
 * the hooks server.ts hands to runHost, so loading this file starts nothing.
 *
 * A CLOSED CONNECTION IS NEVER A CANCEL (§15.4). A client that exits, is killed, stops waiting
 * (`--no-wait`, a `--wait` that ran out) or is moved to the background and then ended by the Bash
 * tool takes nothing with it: its requests go on, and their answers are dropped when they come.
 * `cco cancel` is the one way to stop work, and it is a request like any other.
 *
 * NOTHING HERE MAY THROW INTO THE EVENT LOOP. Every socket, server and timer callback is guarded:
 * an error on one connection is that connection's — it is closed, its later answers are dropped
 * — and never another connection's, and never the host's. failServer is installed (by server.ts,
 * before runHost) for whatever a guard here misses.
 *
 * TEAM MODE (team contract §7.1, §7.6 — H1). A connection now has a ROLE, fixed by its hello:
 * `session` (the `cco` client of this host's session — the hello checked exactly as before),
 * `observer` (a front end: any process of this user, no session claim) or `member` (a teammate's
 * team MCP server, identified by the credential its hello presents). host.ts owns the SOCKETS of
 * team mode and the engine owns their MEANING: an observer's or member's hello is decided by the
 * engine's TeamHostSide.hello; every cco/team.* and cco/member.* request of a role that may call
 * it goes to TeamHostSide.request under the connection's ConnId; what a role may not call is
 * refused HERE (-32013) and never reaches either the engine or server.ts. The engine talks back
 * through TeamConnections — a notification to one connection, with the 4 MiB outbound cap
 * enforced on socket.writableLength, a close, a role — and hears every close of a connection
 * that ever greeted through TeamHostSide.closed, once. A team request that is HELD (cco/team.wait,
 * cco/team.subscribe) is mapped like any request until it is answered, so a connection holding
 * one is never closed as idle. With no team side (the engine could not be built) the host serves
 * as before team mode: no TEAM_FEATURE, the team methods are server.ts's -32601, and an observer
 * or member hello is refused.
 *
 * Node built-ins and this repository's own modules only; must not import 'vscode'.
 */

/** What the host knows, once its spec is read, that the team engine is built from (server.ts TeamRuntime). */
export interface HostTeamSetup {
  /** The spec's workspace (absolute; the process's cwd from step c on). */
  workspace: string;
  /** The session this host serves, as the spec has it. */
  session: ProcessIdentity;
  /** The socket this host listens on. */
  socket: string;
  /** This process's start time as its record has it. */
  hostStartedAt: number;
}

/** The team side of a host (team contract §7.1): what server.ts hands host.ts once the engine is built. */
export interface HostTeam {
  /** The engine's half of the socket: hellos of observers and members, team requests, closes. */
  readonly hostSide: TeamHostSide;
  /** TeamSurface.setConnections — called once, before the first connection is accepted. */
  setConnections(connections: TeamConnections): void;
  /**
   * TeamEngine.footer (§4.4 item 2, L9): the unread line, put into TextResult.footer of every
   * TextResult answer on a SESSION connection — every `cco` answer that reached the host.
   */
  footer(): string | undefined;
  /** The host listens and its record is written: the orphan sweep starts (S1-6, P13). Never throws. */
  listening(): void;
}

/**
 * What the host tells server.ts about a message besides the message: the ROLE of the connection it
 * came on, as that connection's accepted hello fixed it (§7.6). Handed beside the message, never in
 * it — a client's JSON-RPC fields are the client's to write, and a role read from them would be a
 * claim, not a fact. server.ts keys list_workers' poll floor on it (host-protocol, list_workers'
 * RULES: an observer may be answered from the cache, a session never).
 */
export interface HostRequestContext {
  /** Only greeted connections reach the server, so a role is always known. */
  role: HostRole;
}

/** What server.ts hands the host: the pieces of the server the socket transport needs. */
export interface HostHooks {
  /**
   * server.ts handleRequest — one decoded JSON-RPC message, exactly as a line of stdin is handed
   * to it, with the role of the connection it came on (HostRequestContext; stdio hands none). Its
   * answer comes back through the transport installed with setTransport.
   */
  handleRequest(msg: unknown, context: HostRequestContext): Promise<void>;
  /** Route everything server.ts sends through `transport` from now on (send() in server.ts). */
  setTransport(transport: HostTransport): void;
  /**
   * Run `hook` once on the way out — shutdown's finish and failServer — before process.exit, so
   * the host's socket and record go with it (§15.2 step 4).
   */
  setExitHook(hook: () => void): void;
  /** server.ts shutdown(): the session-end path stdin's EOF takes on stdio. Idempotent, total. */
  shutdown(reason: string): void;
  /** The reason shutdown records against every task it ends when the session is gone. */
  shutdownReason: string;
  /** One diagnostic line on stderr (which, in host mode, is the host's log). Never throws. */
  log(line: string): void;
  /**
   * Team mode: build the team side from what the start learned — called once, after the session
   * check and the probe of the socket path, before the listen (so before the first connection).
   * Undefined, or a throw (logged), leaves the host without teams.
   */
  team?(setup: HostTeamSetup): HostTeam | undefined;
}

/** The socket side of server.ts's send(): what the server needs to answer, notify and ask. */
export interface HostTransport {
  /**
   * One message from the server — an answer to a request, carrying the host's id for it. Routed
   * to the connection the request came on, with the client's own id put back; dropped, silently,
   * when that connection is gone. Never throws.
   */
  send(message: Record<string, unknown>): void;
  /**
   * A notification about the request `requestId` (the host's id for it) to the connection it came
   * on: `params` with `requestId` — the CLIENT's id of that request — put first. Dropped when the
   * connection is gone or the request is already answered. Never throws.
   */
  notify(requestId: string | number, method: string, params: Record<string, unknown>): void;
  /** Whether anybody is still there to read the answer to `requestId` (the host's id). */
  isOpen(requestId: string | number): boolean;
  /**
   * The server has started to shut down: from now on no connection is accepted (one accepted a
   * moment before and not greeted yet is dropped unanswered, hello and all) and no request is
   * started; the answers of what is already running still go out, while their connections last.
   */
  shuttingDown(): void;
}

/* ------------------------------------------------------------------------- *
 * Limits of this module (not part of the wire contract)
 * ------------------------------------------------------------------------- */

/** Read ceiling for the start spec: a record of a few paths and numbers. */
const SPEC_MAX_BYTES = 64 * 1024;
/** Read ceiling for the host record, read back on the way out. */
const RECORD_MAX_BYTES = 64 * 1024;
/** How long the start waits for a connect to a socket file that is already there. */
const PROBE_CONNECT_TIMEOUT_MS = 2_000;
/**
 * How long a process that accepted the start's probe connection has to answer its cco/hello before
 * it counts as nobody (§15.12 M5). A serving host answers a hello at once.
 */
const PROBE_HELLO_TIMEOUT_MS = 2_000;
/** The most the probe reads while it waits for the hello's answer — which is a few hundred bytes. */
const PROBE_ANSWER_MAX_BYTES = 64 * 1024;
/** The id the probe's cco/hello carries: no client of a host ever sees it. */
const PROBE_HELLO_ID = 'cco-host-start-probe';
/** After an answer that closes a connection, how long the client gets to read it before the close. */
const CLOSE_AFTER_ANSWER_MS = 2_000;
/**
 * The session watch (§15.12 L5): kill(0) at every look; the start-time comparison — a `ps` — at
 * every this-many-th look (with SESSION_POLL_MS 2,000: about every 30 s).
 */
const SESSION_COMPARE_EVERY_LOOKS = 15;
/**
 * Start-time comparisons in a row that could not read a start time (a `ps` that failed or timed
 * out) after which a session that kill(0) still finds counts as alive and the watch goes back to
 * its ordinary pace (§15.12 L5). One such comparison is retried at the very next look.
 */
const SESSION_UNKNOWN_LIMIT = 2;
/**
 * A wall-clock step smaller than this is taken for the noise of two clocks read a moment apart,
 * not for a step (the session watch and the hello compare identities across steps).
 */
const WALL_STEP_MIN_MS = 1_000;
/**
 * Team contract A37 (review S4): before its hello a connection is nobody's, so it gets the bounds
 * of a hello and no more. A hello of any role is well under 1 KiB; LINE_MAX_BYTES (80 MiB) is the
 * bound of a GREETED connection's line, and applied before the hello it let every process of the
 * user hold that much per socket.
 */
const PRE_HELLO_LINE_MAX_BYTES = 64 * 1024;
/** A37: an accepted connection that has not been greeted this long after its accept is closed. */
const HELLO_DEADLINE_MS = 10_000;
/** A37: ungreeted connections held at once; the accept of one more is closed at once. */
const UNGREETED_MAX = 32;
/** A37: the refusals of ungreeted connections are logged at most once per this long, with their count. */
const UNGREETED_LOG_EVERY_MS = 10_000;
/**
 * Team contract A35 (review S2): a host log (`s<P>.log`, `s<P>.log.1`) whose session is gone and
 * that nothing wrote to for this long is removed at a host's start.
 */
const HOST_LOG_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The names of the run directory's host logs, the session pid captured. */
const HOST_LOG_NAME = /^s([1-9][0-9]{0,9})\.log(?:\.1)?$/;

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The errno code of a caught value when it carries one (`ENOENT`, `EACCES`), else undefined. */
function errnoOf(err: unknown): string | undefined {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
}

/** At most `max` characters of a value, on one line — all a message here ever quotes of one. */
function shown(value: unknown, max = 300): string {
  return sliceOneLine(flattenOneLine(value), max);
}

/** Remove a file when it is there. Never throws. */
function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone, or not ours to remove — either way nothing more is done about it
  }
}

/** A positive integer pid, by value. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

/** A process identity, by value: a pid and a finite start time. Undefined for anything else. */
function identityOf(value: unknown): ProcessIdentity | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const pid: unknown = value.pid;
  const startedAt: unknown = value.startedAt;
  if (!isPid(pid) || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return undefined;
  }
  return { pid, startedAt };
}

/** What identifies one file whatever its name: its device and inode, exactly (bigint). */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** The identity of what is at `file` now — the entry itself, never what a link points to — or undefined. Never throws. */
function fileIdentityOf(file: string): FileIdentity | undefined {
  try {
    const st = fs.lstatSync(file, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch {
    return undefined;
  }
}

/** Two identities of one file. An identity that could not be read is nobody's. */
function sameFile(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Is the session process still the one this host serves? `gone`: no process has the pid, or the
 * one that has it started at another time (its pid was handed on — host-protocol.sameProcess
 * decides, within START_SLACK_MS). `unknown`: it is alive and its start time could not be read
 * (`ps` failed or timed out) — nothing is concluded from that. `startedAt` is the reading, when
 * there is one. Never throws.
 *
 * Both questions at once — what the START asks (§15.2 b), once. The session watch asks the first
 * at every look and the second only now and then (HostServer.watchSession, §15.12 L5).
 *
 * Stated residual: a session process that has exited and not yet been reaped by its parent (a
 * zombie) still answers both questions as the live process did, so it reads `same` until its
 * parent — the editor that ran it — collects it, which an editor does at once.
 */
function sessionVerdict(
  session: ProcessIdentity,
  wallStepMs = 0,
): { verdict: 'same' | 'gone' | 'unknown'; startedAt?: number } {
  if (!isPidAlive(session.pid)) {
    return { verdict: 'gone' };
  }
  return startTimeVerdict(session, wallStepMs);
}

/**
 * The second question alone: does the process that has the session's pid now have the session's
 * start time? `same` / `gone` / `unknown` as sessionVerdict says them — `unknown` also for a pid
 * that names no process by the time `ps` runs, which the caller's kill(0) then sees for itself.
 * One `ps` (registry.processStartedAt: synchronous, at most 2 s). Never throws.
 *
 * `wallStepMs`, when given, is how far the wall clock was MOVED since `session.startedAt` was
 * last read (a step, not time passing — see HostServer.watchSession). A reading is `now − etime`
 * (registry.processStartedAt), and where `etime` runs on a clock the wall clock is stepped
 * against, a step moves every later reading of the same process by as much: such a reading is the
 * same process too, and is not taken for a pid that changed hands.
 */
function startTimeVerdict(
  session: ProcessIdentity,
  wallStepMs = 0,
): { verdict: 'same' | 'gone' | 'unknown'; startedAt?: number } {
  const startedAt = processStartedAt(session.pid);
  if (startedAt === undefined) {
    return { verdict: 'unknown' };
  }
  const reading: ProcessIdentity = { pid: session.pid, startedAt };
  const same =
    sameProcess(session, reading) ||
    (wallStepMs !== 0 && sameProcess({ pid: session.pid, startedAt: session.startedAt + wallStepMs }, reading));
  return { verdict: same ? 'same' : 'gone', startedAt };
}

/* ------------------------------------------------------------------------- *
 * Starting (§15.2 step 2)
 * ------------------------------------------------------------------------- */

/** What a refusal at start has to clean up and where it leaves its sentence. */
interface StartState {
  /** The spec this host was started with — removed on every way out of the start. */
  specPath: string | undefined;
  /** Where the refusal's sentence goes: the spec's own failPath once read, until then its sibling. */
  failPath: string | undefined;
  /** The socket this host bound, once it has: a refusal after the listen removes it again. */
  boundSocket: string | undefined;
}

/**
 * The fail file of the host of session pid P, found from the spec's own NAME (`s<P>.spec.json` in
 * the run dir — host-protocol.hostFilesOf is the one naming rule) — for a refusal that comes before
 * the spec could be read, when the spec itself cannot say where its fail file is.
 */
function failPathBeside(specPath: string): string | undefined {
  const match = /^s([1-9][0-9]{0,9})\.spec\.json$/.exec(path.basename(specPath));
  return match === null ? undefined : hostFilesOf(path.dirname(specPath), Number(match[1])).fail;
}

/**
 * Leave `sentence` for the starter in the fail file. Created EXCLUSIVELY and owner-only, and never
 * written through what is already at the name: the client removes a stale fail file before it
 * starts a host, so anything there now is either a leftover (cleared, then created again) or not
 * ours to write through (a link). Exactly the sentence, with no line end. Never throws.
 */
function writeFailFile(failPath: string, sentence: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(failPath, sentence, { mode: 0o600, flag: 'wx' });
      return;
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        return;
      }
      try {
        fs.rmSync(failPath, { recursive: true, force: true });
      } catch {
        return;
      }
    }
  }
}

/**
 * Refuse to start: ONE sentence to the fail file and the log, then exit HOST_REFUSED_EXIT — before
 * listening, or, for the one refusal that can come after it (the record could not be written),
 * with the socket that was bound removed again. Nothing is running yet that would need a
 * shutdown: no request has been read. The spec is removed too — it is read once, by this process.
 */
function refuse(state: StartState, hooks: HostHooks, sentence: string): never {
  hooks.log(`cco-dispatch host: refused to start — ${sentence}`);
  if (state.failPath !== undefined) {
    writeFailFile(state.failPath, sentence);
  }
  if (state.boundSocket !== undefined) {
    unlinkQuietly(state.boundSocket);
  }
  if (state.specPath !== undefined) {
    unlinkQuietly(state.specPath);
  }
  return process.exit(HOST_REFUSED_EXIT);
}

/**
 * Step a: the spec, read once and checked BY VALUE — the protocol equal to this build's, the
 * session a positive pid with a start time, the workspace an absolute directory that exists, the
 * socket absolute, and the remaining fields of the shape the contract gives them. Returns the
 * spec, or the refusal's sentence.
 *
 * Through safeFs without following a link: the run dir is the user's own (0700), and the spec is
 * a small regular file the client wrote there; a pipe or a link at that name is not it.
 */
function readSpec(specPath: string): HostSpec | string {
  const read = readTextSafe(specPath, SPEC_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return `the dispatch host's start spec ${shown(specPath)} could not be read (${read.reason})`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return "the dispatch host's start spec is not valid JSON";
  }
  if (!isPlainObject(raw)) {
    return "the dispatch host's start spec is not a JSON object";
  }
  if (raw.protocol !== PROTOCOL_VERSION) {
    return (
      `the cco command speaks protocol ${shown(raw.protocol, 20)} and this dispatch host speaks ` +
      `${PROTOCOL_VERSION} — they are from different builds; reopen VS Code so both are replaced`
    );
  }
  const session = identityOf(raw.session);
  if (session === undefined) {
    return "the dispatch host's start spec does not name a Claude Code session (a positive pid and its start time)";
  }
  const workspace = raw.workspace;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    return "the dispatch host's start spec does not name an absolute workspace directory";
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(workspace).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return `the session's project directory ${shown(workspace)} is not a directory that exists`;
  }
  const socket = raw.socket;
  if (typeof socket !== 'string' || !path.isAbsolute(socket)) {
    return "the dispatch host's start spec does not name an absolute socket path";
  }
  const { serverHash, logPath, failPath } = raw;
  if (typeof serverHash !== 'string' || typeof logPath !== 'string' || typeof failPath !== 'string') {
    return "the dispatch host's start spec is missing its serverHash, logPath or failPath";
  }
  return { protocol: PROTOCOL_VERSION, session, workspace, socket, serverHash, logPath, failPath };
}

/**
 * The sentence of the sandbox refusal (§15.2 d, worded as §15.12 M2 amends it), with the command
 * in its one spelling.
 *
 * WHO READS IT, AND WHY IT NAMES THE COMMAND. The client prints it whole, and the one who reads it
 * is the model in the Claude Code session — which the installed policy tells not to change
 * settings itself, and which cannot run a VS Code command. So the remedy is addressed to the
 * USER, through the model, by the exact name of the command and of the item to check in it: the
 * earlier "Update Workspace Setup does this" named a fix that nothing in the session could reach.
 */
function sandboxRefusal(): string {
  return (
    "cco is running inside Claude Code's sandbox, where workers cannot sign in or write their own " +
    'settings. Run it as one simple command (no pipe, redirection or cd), and ask the user to run ' +
    'the VS Code command "Claude Code Orchestrator: Update Workspace Setup" and check "Allow cco ' +
    `without a prompt" — it adds \`${COMMAND_SPELLING} *\` to sandbox.excludedCommands; when the ` +
    "organization manages the sandbox, that entry must go in the user's own settings."
  );
}

/**
 * Step d, for one directory: exclusively create, then remove, a zero-byte file in it. Returns the
 * errno that refused it, or undefined when both steps worked (or failed for a reason that is not a
 * refusal to write — the check exists to recognise the sandbox, and a full disk is not it).
 *
 * WHY WRITING, AND WHY THE CONFIG DIR. The sandbox the Bash tool can run a command in (F8)
 * write-protects the session's config dir with no exemption, and every process a sandboxed process
 * starts inherits the sandbox. A host started from inside it would start workers that cannot
 * refresh a login or write their own settings, and their failures would read as expired logins
 * and be recorded against healthy accounts. So the host asks the one question that tells: can it
 * write where its workers must — before anything is started or recorded.
 */
function writeRefusalIn(dir: string): string | undefined {
  const file = path.join(dir, `.cco-write-check-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    const code = errnoOf(err);
    return code === 'EPERM' || code === 'EACCES' || code === 'EROFS' ? code : undefined;
  }
  try {
    fs.closeSync(fd);
  } catch {
    // nothing was written through it
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    const code = errnoOf(err);
    return code === 'EPERM' || code === 'EACCES' || code === 'EROFS' ? code : undefined;
  }
  return undefined;
}

/**
 * Step d: the sandbox check over (i) the run dir and (ii) the session's config dir —
 * `CLAUDE_CONFIG_DIR` when the environment sets it, else `~/.claude` (platform.hostConfigDir is
 * that rule); a config dir that is not there, or is not a directory, skips (ii). Returns true when
 * either refused the write.
 */
function insideSandbox(runDir: string): boolean {
  if (writeRefusalIn(runDir) !== undefined) {
    return true;
  }
  const configDir = hostConfigDir();
  let present = false;
  try {
    present = fs.statSync(configDir).isDirectory();
  } catch {
    present = false;
  }
  return present && writeRefusalIn(configDir) !== undefined;
}

/** What the start's look at the socket path found (probeSocket). */
type SocketVerdict = 'absent' | 'live' | 'stale' | 'unknown';

/**
 * Whether one line read from a probed socket is a JSON-RPC answer: an object of version 2.0 that
 * carries a `result` or an `error`, under any id (a host answers a hello it refuses under the
 * hello's own id, and a line it cannot read under `null`). Never throws.
 */
function isRpcAnswer(line: Buffer): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(line.toString('utf8'));
  } catch {
    return false;
  }
  return isPlainObject(msg) && msg.jsonrpc === '2.0' && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'));
}

/**
 * What is at the socket path before this host listens (§15.2 e, as §15.12 M5 amends it):
 *  - `absent`: nothing is there;
 *  - `live`: a host ANSWERS there — a connect worked, and a cco/hello sent on it got a JSON-RPC
 *    answer, a result or an error, within PROBE_HELLO_TIMEOUT_MS;
 *  - `stale`: nobody answers there — the connect failed with ECONNREFUSED or ENOENT (the only two
 *    errnos that prove nobody listens), or it was accepted and then closed or reset, or accepted
 *    and never answered, or "answered" with something that is not a JSON-RPC answer;
 *  - `unknown`: what could not be judged — another errno, a connect that neither worked nor failed
 *    within PROBE_CONNECT_TIMEOUT_MS — and is left alone (the listen then meets EADDRINUSE).
 * Never rejects.
 *
 * WHY A HELLO, AND NOT A CONNECT. A host that is shutting down — its session ended, a SIGTERM, a
 * fault caught by failServer — keeps its listener bound through shutdown's grace and drops every
 * connection it accepts (HostServer.accept), so a connect alone succeeds against a host that will
 * never serve again. Judged `live` on that, this host left "because another host is live", and
 * the client that started it found no host for its whole start timeout and reported 22 — for a
 * call that would have worked a second later (review M5). An answer is the one thing a serving
 * host gives and a dying one does not.
 *
 * WHY ANY ANSWER. A host of another build answers -32010, a host of another incarnation of this
 * session's pid answers -32011: each is alive and holds that socket, and which of them should
 * serve is the client's to sort out (it reads the same answers). The hello sent is the one this
 * host would be asked — this session, this server's hash — so a host of this session answers it
 * with its result. A host that answers is left exactly as it was: the probe's connection closes,
 * which it takes like any client that goes away.
 *
 * Stated residual: a LIVE host whose event loop is held past PROBE_HELLO_TIMEOUT_MS reads `stale`
 * and loses its socket file to this one (its open connections are untouched, and its exit no
 * longer removes the files of the host that took over — removeOwnFiles). A probe runs only when a
 * client found no host to greet, and a host that accepts connects and answers late does not make
 * a client find that.
 */
function probeSocket(socketPath: string, hello: HelloParams): Promise<SocketVerdict> {
  try {
    fs.lstatSync(socketPath);
  } catch (err) {
    const verdict: SocketVerdict = errnoOf(err) === 'ENOENT' ? 'absent' : 'unknown';
    return Promise.resolve(verdict);
  }
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    let timer: NodeJS.Timeout | undefined;
    let probe: net.Socket | undefined;
    // What has arrived of the line being read — never more than PROBE_ANSWER_MAX_BYTES.
    let partial: Buffer = Buffer.alloc(0);
    const finish = (verdict: Exclude<SocketVerdict, 'absent'>): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      try {
        probe?.destroy();
      } catch {
        // already closed
      }
      resolve(verdict);
    };
    // The connection is over (closed, reset, or the peer ended its half) and no answer was read.
    // A last line sent without its line end still counts — a host ends every line, but nothing is
    // lost by reading what came.
    const ended = (): void => {
      if (!connected) {
        finish('unknown');
        return;
      }
      finish(partial.length > 0 && isRpcAnswer(partial) ? 'live' : 'stale');
    };
    try {
      probe = net.connect(socketPath);
      timer = setTimeout(() => finish('unknown'), PROBE_CONNECT_TIMEOUT_MS);
      probe.on('connect', () => {
        connected = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        // Accepted. From here, silence and a close both say "nobody serves here".
        timer = setTimeout(() => finish('stale'), PROBE_HELLO_TIMEOUT_MS);
        try {
          probe?.write(`${JSON.stringify({ jsonrpc: '2.0', id: PROBE_HELLO_ID, method: METHOD.hello, params: hello })}\n`);
        } catch {
          finish('stale');
        }
      });
      probe.on('data', (chunk: Buffer) => {
        if (done) {
          return;
        }
        let from = 0;
        for (let end = chunk.indexOf(0x0a, from); end !== -1; end = chunk.indexOf(0x0a, from)) {
          const piece = chunk.subarray(from, end);
          const line = partial.length === 0 ? piece : Buffer.concat([partial, piece]);
          partial = Buffer.alloc(0);
          if (isRpcAnswer(line)) {
            finish('live');
            return;
          }
          from = end + 1;
        }
        const rest = chunk.subarray(from);
        if (partial.length + rest.length > PROBE_ANSWER_MAX_BYTES) {
          // Not a host: a hello's answer is a few hundred bytes on one line.
          finish('stale');
          return;
        }
        partial = Buffer.concat([partial, rest]);
      });
      probe.on('end', ended);
      probe.on('close', ended);
      probe.on('error', (err) => {
        if (connected) {
          ended();
          return;
        }
        const code = errnoOf(err);
        finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'stale' : 'unknown');
      });
    } catch {
      finish('unknown');
    }
  });
}

/**
 * Listen on `socketPath` with umask 077 around the bind (a Unix socket is created by the bind
 * itself, synchronously inside listen(), so the file never exists with a wider mode) and chmod
 * 0600 once listening. Resolves `listening`, or the errno that refused the listen. Never rejects.
 */
function listenOn(server: net.Server, socketPath: string, hooks: HostHooks): Promise<'listening' | string> {
  return new Promise((resolve) => {
    const onError = (err: unknown): void => {
      resolve(errnoOf(err) ?? 'EIO');
    };
    server.once('error', onError);
    let previous: number | undefined;
    try {
      previous = process.umask(0o077);
      server.listen(socketPath, () => {
        server.removeListener('error', onError);
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (err) {
          // umask 077 already left it 0700 at most, in a run dir only this user can enter
          hooks.log(`cco-dispatch host: the socket's mode could not be set to 0600 (${errnoOf(err) ?? 'the chmod failed'})`);
        }
        resolve('listening');
      });
    } catch (err) {
      server.removeListener('error', onError);
      resolve(errnoOf(err) ?? 'EIO');
    } finally {
      if (previous !== undefined) {
        process.umask(previous);
      }
    }
  });
}

/**
 * Step f: the host record, published by atomic replace — written to a name only this process
 * uses, exclusively and owner-only, then renamed over `s<P>.json` — so a client never reads half
 * of one. Returns the errno that refused it, or undefined.
 */
function writeRecord(recordPath: string, record: HostRecord): string | undefined {
  const tmp = `${recordPath}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, recordPath);
    return undefined;
  } catch (err) {
    unlinkQuietly(tmp);
    return errnoOf(err) ?? 'EIO';
  }
}

/** The files this host made, as they were once made: what its way out may remove (removeOwnFiles). */
interface OwnFiles {
  /** The socket file its listen created; undefined when it could not be looked at then. */
  socket: FileIdentity | undefined;
  /** The record its atomic replace put in place; undefined when it could not be looked at then. */
  record: FileIdentity | undefined;
}

/**
 * Step 4, on the way out (shutdown's finish, failServer): remove the socket and the record — but
 * ONLY while the record still names this process. A record that names another host means another
 * host has taken this session's files over (it unlinked a socket it found dead and bound its own),
 * and the files at those names are then ITS: removing them would cut a live host off from its
 * clients. A record that is gone or unreadable names nobody, and nothing is removed either: a
 * socket left behind answers ECONNREFUSED, which is the stale-socket rule's case. Never throws.
 *
 * AND EACH FILE ONLY WHILE IT IS STILL THE VERY FILE THIS HOST MADE (its device and inode, `own`).
 * Since a host that accepts a connect and answers nothing counts as nobody (probeSocket, §15.12
 * M5), a new host can take this session's socket over WHILE this one is still on its way out —
 * the shutdown grace is exactly that window: it unlinks this host's socket, binds its own at the
 * same name and only then writes its record. A host leaving inside that window still finds its own
 * record, and by the record alone would remove the NEW socket and leave a host nobody can reach.
 * A file whose identity could not be taken when it was made is removed by the record's word
 * alone, as before.
 */
function removeOwnFiles(recordPath: string, socketPath: string, own: OwnFiles): void {
  try {
    const read = readTextSafe(recordPath, RECORD_MAX_BYTES, { noFollow: true });
    if (!read.ok) {
      return;
    }
    const record: unknown = JSON.parse(read.text);
    if (!isPlainObject(record) || record.hostPid !== process.pid) {
      return;
    }
    // The socket first: from here a client finds nothing to connect to and starts a new host,
    // rather than connecting to one that is about to exit.
    if (own.socket === undefined || sameFile(own.socket, fileIdentityOf(socketPath))) {
      unlinkQuietly(socketPath);
    }
    if (own.record === undefined || sameFile(own.record, fileIdentityOf(recordPath))) {
      unlinkQuietly(recordPath);
    }
  } catch {
    // a record that does not parse names nobody
  }
}

/**
 * Start the dispatch host from its spec and serve until the session ends — §15.2 steps 2–6 and
 * §15.4. Called by server.ts main() for `server.js --host <spec path>`, with stderr already the
 * log and the cwd already the workspace (the client's intermediate did both, step 1).
 *
 * The order is the contract's: a. the spec; b. the session; c. chdir; d. the sandbox check;
 * e. listen; f. the record, and the spec removed; g. what main() does apart from reading stdin.
 * Of g, the fault handlers and the signal handlers are installed by server.ts BEFORE this runs —
 * earlier than g, which only widens what they cover: a fault during the start ends the process
 * through failServer instead of on the spot, and a signal through shutdown (which, before the
 * record exists, has nothing of its own to clean up). Every refusal before the listen writes one
 * sentence to the fail file and the log and exits HOST_REFUSED_EXIT (refuse).
 *
 * Never throws: a step that throws where it should have refused is refused with what it threw.
 */
export function runHost(specPath: string | undefined, hooks: HostHooks): void {
  const state: StartState = { specPath: undefined, failPath: undefined, boundSocket: undefined };
  startHost(specPath, hooks, state).catch((err: unknown) => {
    refuse(
      state,
      hooks,
      `the dispatch host failed while starting: ${shown(err instanceof Error ? err.message : err)}`,
    );
  });
}

async function startHost(specPath: string | undefined, hooks: HostHooks, state: StartState): Promise<void> {
  if (process.platform === 'win32') {
    // The client refuses on win32 before it ever starts a host (§15.3 step 2); a host started by
    // hand there would have no Unix socket to listen on.
    refuse(state, hooks, 'cco does not run on Windows in this version; use the cco-dispatch MCP server');
  }
  if (typeof specPath !== 'string' || specPath === '' || !path.isAbsolute(specPath)) {
    refuse(state, hooks, 'the dispatch host was started without the absolute path of its start spec');
  }
  state.specPath = specPath;
  state.failPath = failPathBeside(specPath);

  // a. The spec.
  const spec = readSpec(specPath);
  if (typeof spec === 'string') {
    refuse(state, hooks, spec);
  }
  // The spec's own fail path from here — when it is one this process can be sure of: a relative
  // path would be resolved against whatever the cwd happens to be.
  if (path.isAbsolute(spec.failPath)) {
    state.failPath = spec.failPath;
  }

  // b. The session that asked for this host is the one still running under that pid. At START an
  // identity that cannot be read is not the session's (refused, and the client may try again); the
  // session watch below is lenient about that same case, because there a false "gone" would end a
  // session's running work.
  if (sessionVerdict(spec.session).verdict !== 'same') {
    refuse(state, hooks, 'the Claude Code session that asked for this host is gone');
  }

  // c. Every cwd reader of the server — the task events, the mesh ledger, the io directories,
  // the dashboard check-in, the workers' own cwd — sees the session's project directory.
  try {
    process.chdir(spec.workspace);
  } catch (err) {
    refuse(
      state,
      hooks,
      `the session's project directory ${shown(spec.workspace)} could not be entered (${errnoOf(err) ?? 'chdir failed'})`,
    );
  }

  // d. The sandbox check (M2, F8). Nothing is recorded against any account by a refusal here:
  // no worker exists yet, and none will be started by this process.
  const runDir = runDirOf(ROOT_DIR);
  if (insideSandbox(runDir)) {
    refuse(state, hooks, sandboxRefusal());
  }

  // e. Listen. A socket file already at the name is unlinked ONLY when the look at it proves nobody
  // serves there; a host that ANSWERS this host's own hello there is another live host, which the
  // client will use (probeSocket — an answer, not a connect, since §15.12 M5).
  const files = hostFilesOf(runDir, spec.session.pid);
  const hello: HelloParams = {
    protocol: PROTOCOL_VERSION,
    session: spec.session,
    serverHash: spec.serverHash,
    clientPid: process.pid,
  };
  const existing = await probeSocket(spec.socket, hello);
  if (existing === 'live') {
    exitForLiveHost(state, hooks);
  }
  if (existing === 'stale') {
    unlinkQuietly(spec.socket);
  }
  // This process's start time as every reader of it measures one (registry.processStartedAt, F9),
  // read before the first client can ask for it in a hello. A `ps` that cannot answer leaves the
  // process's own reckoning, which is the same instant to within the reading's precision.
  const hostStartedAt = processStartedAt(process.pid) ?? Math.round(Date.now() - process.uptime() * 1000);
  // Team mode: the engine is built here, from the spec's facts, and handed its connections before
  // the listen — so before host.ts can accept the first connection that would need them.
  let team: HostTeam | undefined;
  try {
    team = hooks.team?.({ workspace: spec.workspace, session: spec.session, socket: spec.socket, hostStartedAt });
  } catch (err) {
    hooks.log(
      `cco-dispatch host: the team engine could not be built — this host serves no teams (${shown(err instanceof Error ? err.message : err, 200)})`,
    );
    team = undefined;
  }
  const host = new HostServer(spec, hooks, hostStartedAt, team);
  if (team !== undefined) {
    try {
      team.setConnections(host.teamConnections());
    } catch (err) {
      hooks.log(
        `cco-dispatch host: the team engine refused its connections — this host serves no teams (${shown(err instanceof Error ? err.message : err, 200)})`,
      );
      host.dropTeam();
      team = undefined;
    }
  }
  hooks.setTransport(host.transport());
  const server = net.createServer({ allowHalfOpen: true }, (socket) => host.accept(socket));
  let listened = await listenOn(server, spec.socket, hooks);
  if (listened === 'EADDRINUSE') {
    // Bound by somebody between the look above and this listen — another host of this session
    // started in that instant — or a file the look could not judge. One more look decides.
    const again = await probeSocket(spec.socket, hello);
    if (again === 'live') {
      exitForLiveHost(state, hooks);
    }
    if (again === 'stale' || again === 'absent') {
      if (again === 'stale') {
        unlinkQuietly(spec.socket);
      }
      listened = await listenOn(server, spec.socket, hooks);
    }
  }
  if (listened !== 'listening') {
    refuse(state, hooks, `the dispatch host could not listen on ${shown(spec.socket)} (${listened})`);
  }
  state.boundSocket = spec.socket;
  // The socket file this listen made, as it was made: the way out removes only that one.
  const ownSocket = fileIdentityOf(spec.socket);
  // From here an accept error is the one connection's, logged, and the listener stays (§15.9).
  server.on('error', (err) => {
    hooks.log(`cco-dispatch host: a connection could not be accepted (${errnoOf(err) ?? shown(err, 120)})`);
  });

  // f. The record, then the spec removed.
  const record: HostRecord = {
    protocol: PROTOCOL_VERSION,
    hostPid: process.pid,
    hostStartedAt,
    session: spec.session,
    workspace: spec.workspace,
    socket: spec.socket,
    serverHash: spec.serverHash,
  };
  const refused = writeRecord(files.record, record);
  if (refused !== undefined) {
    refuse(state, hooks, `the dispatch host could not write its record ${shown(files.record)} (${refused})`);
  }
  // Likewise the record file this replace put in place.
  const ownRecord = fileIdentityOf(files.record);
  unlinkQuietly(specPath);
  state.specPath = undefined;
  // From here, every way out of this process takes the socket and the record with it (step 4) —
  // while they are still the ones it made.
  hooks.setExitHook(() => removeOwnFiles(files.record, spec.socket, { socket: ownSocket, record: ownRecord }));

  // 3. The session watch.
  host.watchSession();
  hooks.log(
    `cco-dispatch host: pid ${process.pid} serves Claude Code session ${spec.session.pid} in ` +
      `${shown(spec.workspace)} on ${shown(spec.socket)}`,
  );
  // The logs of sessions long gone (A35) — after the start, so the client waiting for this host
  // never waits for it.
  setImmediate(() => pruneHostLogs(runDir, hooks));
  // Team mode: the orphan sweep, once the host listens and can be found (S1-6, P13).
  if (team !== undefined) {
    try {
      team.listening();
    } catch (err) {
      hooks.log(`cco-dispatch host: the team sweep could not start (${shown(err instanceof Error ? err.message : err, 200)})`);
    }
  }
}

/**
 * Another host already serves this session's socket — it answered this host's hello there
 * (probeSocket, §15.2 e as §15.12 M5 amends it): this one leaves at once and quietly — no fail
 * file, exit 0 — and the client goes on with that host. The spec it was started with is removed:
 * it was read, and it is nobody's any more.
 */
function exitForLiveHost(state: StartState, hooks: HostHooks): never {
  hooks.log('cco-dispatch host: another dispatch host already serves this session — this one exits');
  if (state.specPath !== undefined) {
    unlinkQuietly(state.specPath);
  }
  return process.exit(0);
}

/**
 * Team contract A35 (review S2): remove the run directory's host logs — `s<P>.log` and its one
 * rotation `s<P>.log.1` — of sessions that are PROVABLY gone and that nothing wrote to for
 * HOST_LOG_KEEP_MS. Every session that ever ran `cco` leaves one or two, and nothing else ever
 * removes them; a front end that scanned `run/` in directory order stopped finding live hosts
 * behind a few hundred of them.
 *
 * WHAT PROVES A SESSION GONE: no process has its pid (kill(0) — isPidAlive; EPERM counts as
 * alive), AND the record `s<P>.json`, when there is one, names no host that is still the process
 * it records (pid alive and its start time that of the record, host-protocol.sameProcess) — a host
 * on its way out of a session that just ended still writes its log. A pid that some process has
 * is never proof of anything either way, so a log whose pid is alive is KEPT, whoever has the pid
 * now (stated residual: after the pid was handed to another process the log stays until that
 * process ends too — kept, never wrongly removed). Only regular files, by lstat; a link is left.
 *
 * Best effort and quiet: run once at the start, after the record is written; a failure to read
 * the directory or to remove one file costs that file only. What was removed is logged, once.
 * Never throws.
 */
function pruneHostLogs(runDir: string, hooks: HostHooks): void {
  try {
    const now = Date.now();
    let removed = 0;
    for (const name of fs.readdirSync(runDir)) {
      const match = HOST_LOG_NAME.exec(name);
      if (match === null) {
        continue;
      }
      const pid = Number(match[1]);
      const file = path.join(runDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || now - st.mtimeMs < HOST_LOG_KEEP_MS || !isPid(pid) || isPidAlive(pid) || hostStillThere(runDir, pid)) {
        continue;
      }
      try {
        fs.unlinkSync(file);
        removed++;
      } catch {
        // gone already, or not ours to remove
      }
    }
    if (removed > 0) {
      hooks.log(`cco-dispatch host: removed ${removed} host log(s) of sessions that ended more than 7 days ago`);
    }
  } catch (err) {
    hooks.log(`cco-dispatch host: the old host logs could not be looked at (${errnoOf(err) ?? shown(err, 120)})`);
  }
}

/**
 * Whether the record `s<pid>.json` names a host that is still the process it records — its pid
 * alive and started when the record says (one `ps`, only for a host pid kill(0) finds). An
 * unreadable record, or a host whose start time cannot be read, counts as there: nothing is
 * removed on a guess. Never throws.
 */
function hostStillThere(runDir: string, pid: number): boolean {
  const read = readTextSafe(hostFilesOf(runDir, pid).record, RECORD_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return read.reason !== 'absent';
  }
  let record: unknown;
  try {
    record = JSON.parse(read.text);
  } catch {
    return true;
  }
  const hostPid: unknown = isPlainObject(record) ? record.hostPid : undefined;
  const hostStartedAt: unknown = isPlainObject(record) ? record.hostStartedAt : undefined;
  if (!isPid(hostPid) || typeof hostStartedAt !== 'number' || !Number.isFinite(hostStartedAt)) {
    return true;
  }
  if (!isPidAlive(hostPid)) {
    return false;
  }
  const startedAt = processStartedAt(hostPid);
  return startedAt === undefined || sameProcess({ pid: hostPid, startedAt: hostStartedAt }, { pid: hostPid, startedAt });
}

/* ------------------------------------------------------------------------- *
 * Serving (§15.4)
 * ------------------------------------------------------------------------- */

/** One client connection. */
interface Connection {
  /** Minted per accepted socket: how the team engine names this connection (TeamHostSide, TeamConnections). */
  readonly id: ConnId;
  readonly socket: net.Socket;
  /** Lines are read and answers written while this is true; false once it closed or is closing. */
  open: boolean;
  /** The connection's cco/hello was answered with a result. */
  greeted: boolean;
  /** The role its hello gave it (§7.6) — set together with `greeted`. */
  role: HostRole | undefined;
  /**
   * The host id of the connection's held cco/team.subscribe while it is unanswered: its CLIENT id
   * is the `requestId` of every notification pushed on this connection (TeamConnections.push).
   * A second subscribe replaces it (L8); the first is answered by the engine.
   */
  subscription: number | undefined;
  /** TeamHostSide.closed was called for it — once, for a connection that ever greeted. */
  teamToldClosed: boolean;
  /** The part of the current line received so far — never more than LINE_MAX_BYTES in all. */
  pieces: Buffer[];
  pieceBytes: number;
  /** Requests of this connection handed to the server and not answered yet. */
  inFlight: number;
  /** The client has finished sending (its half of the connection is closed). */
  peerEnded: boolean;
  /** A37: closes the connection when it is not greeted in time; cleared at the hello and at the close. */
  helloTimer: NodeJS.Timeout | undefined;
  /** A37: reading is paused until the client takes what is queued for it (holdReading). */
  readingHeld: boolean;
  /**
   * The `clientPid` its accepted hello CLAIMED, and an observer's `client` — what the host log
   * names for every mutating observer call (A34). Claimed, not proven: Node cannot read a Unix
   * socket peer's pid, so a process lying in its hello is logged as what it said.
   */
  clientPid: number | undefined;
  client: string | undefined;
}

/** A request handed to the server, until it is answered: where the answer goes, under which id. */
interface PendingRequest {
  readonly connection: Connection;
  /** The client's own id of the request, put back on the answer. */
  readonly clientId: string | number | null;
}

/** Strict UTF-8: a line that is not valid UTF-8 is not one JSON-RPC message. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** What a request that arrives while the host goes down is told. */
const SHUTTING_DOWN_MESSAGE =
  'the dispatch host is shutting down (its Claude Code session ended, or it was stopped) — nothing ' +
  'was started for this request';

/** The team operations as tools/call names (§7.5) — refused with the `suspending` sentence while the host goes down. */
const TEAM_OP_NAMES: ReadonlySet<string> = new Set(TEAM_OPS);
/** What an observer may call (§7.6), besides ping and TEAM_OBSERVER_TOOLS. */
const OBSERVER_METHODS: ReadonlySet<string> = new Set(TEAM_OBSERVER_METHODS);
/** What a member may call (§7.6). */
const MEMBER_METHODS: ReadonlySet<string> = new Set(TEAM_MEMBER_METHODS);
/** The one tools/call an observer may make (§7.6). */
const OBSERVER_TOOLS: ReadonlySet<string> = new Set(TEAM_OBSERVER_TOOLS);
/**
 * The observer methods that CHANGE a team (A34): each call is logged with the client's claimed pid.
 * The rest of TEAM_OBSERVER_METHODS only read.
 */
const MUTATING_OBSERVER_METHODS: ReadonlySet<string> = new Set([
  METHOD_TEAM.send,
  METHOD_TEAM.task,
  METHOD_TEAM.member,
  METHOD_TEAM.takeover,
  METHOD_TEAM.attached,
  METHOD_TEAM.release,
  METHOD_TEAM.end,
  METHOD_TEAM.markRead,
]);

/** Where one request of a greeted connection goes (§7.6's role table). */
type Route = 'server' | 'team' | 'forbidden';

/** Whether a result is a TextResult (`content` an array) — the answers the unread footer rides on. */
function isTextResult(value: unknown): value is Record<string, unknown> & { content: unknown[] } {
  return isPlainObject(value) && Array.isArray(value.content);
}

/**
 * The serving half of the host: the connections, the id mapping, the session watch. One per
 * process, made by startHost once the checks of the start have passed.
 *
 * HALF-CLOSED CONNECTIONS. The server is made with `allowHalfOpen`: a client that sends its
 * request and then ends its own half of the connection still gets its answer — the socket is not
 * ended under it the moment its FIN arrives. Such a connection is closed by this side once
 * nothing of it is in flight any more, so a client that ended and went away does not keep a
 * descriptor of this process for the rest of the session.
 */
class HostServer {
  /** Requests handed to the server and not answered yet, by the host's id for them. */
  private readonly requests = new Map<number, PendingRequest>();
  /** The next host id. A number nothing but this host mints, so no client id can be confused with one. */
  private nextRequestId = 1;
  /** Shutdown has begun: nothing new is accepted or started. */
  private closing = false;
  private watch: NodeJS.Timeout | undefined;
  /**
   * The session this host serves, as its LATEST reading has it: the spec's identity at first, then
   * every reading the watch judged to be the same process (watchSession). What a hello is compared
   * with, so a hello and the watch never disagree about which process the session is.
   */
  private session: ProcessIdentity;
  /**
   * How far the wall clock was STEPPED since `session.startedAt` was read — kept by the watch at
   * every look, used by the watch's next comparison and by every hello in between (servesSession).
   */
  private wallStepSinceReading = 0;
  /** Every accepted connection that has not closed yet, by its ConnId. */
  private readonly connections = new Map<ConnId, Connection>();
  /** The next ConnId. Never reused within this process: a stale id names nobody. */
  private nextConnId = 1;
  /** A37: accepts closed for UNGREETED_MAX since the last log line about them, and when that line was written. */
  private ungreetedRefused = 0;
  private ungreetedLoggedAt = 0;

  constructor(
    private readonly spec: HostSpec,
    private readonly hooks: HostHooks,
    /** This process's start time as the record has it — what hello answers with. */
    private readonly hostStartedAt: number,
    /** The team side (team mode), or undefined: a host that serves no teams. */
    private team: HostTeam | undefined,
  ) {
    this.session = { pid: spec.session.pid, startedAt: spec.session.startedAt };
  }

  /** Serve without teams from now on (the engine refused its connections at the start). */
  dropTeam(): void {
    this.team = undefined;
  }

  /**
   * The engine's way back to the sockets (TeamConnections, §7.1). Each part is synchronous and
   * never throws; a ConnId that names no open, greeted connection is `closed` / `undefined`.
   */
  teamConnections(): TeamConnections {
    return {
      push: (conn, method, params, lossy) => this.push(conn, method, params, lossy),
      close: (conn, code, message) => this.closeConnection(conn, code, message),
      role: (conn) => {
        const connection = this.connections.get(conn);
        return connection !== undefined && connection.open && connection.greeted ? connection.role : undefined;
      },
    };
  }

  /** The transport server.ts sends everything through (HostTransport says what each part does). */
  transport(): HostTransport {
    return {
      send: (message) => this.answer(message),
      notify: (requestId, method, params) => this.notify(requestId, method, params),
      isOpen: (requestId) => {
        const pending = typeof requestId === 'number' ? this.requests.get(requestId) : undefined;
        return pending !== undefined && this.writable(pending.connection);
      },
      shuttingDown: () => {
        this.closing = true;
        if (this.watch !== undefined) {
          clearInterval(this.watch);
          this.watch = undefined;
        }
      },
    };
  }

  /**
   * Step 3, as §15.12 L5 paces it: every SESSION_POLL_MS a LOOK; gone → shutdown with the
   * session-end reason — the function stdin's EOF calls on stdio, with the same effect (one-shot
   * children killed, owned session workers stopped, the bridge stopped, the owner marker released;
   * detach tasks survive). Referenced on purpose — this timer is part of what keeps the host alive
   * for exactly the session's life.
   *
   * WHAT A LOOK IS. Every look asks kill(0) whether any process has the session's pid — a system
   * call, nothing spawned; none → the session has ended. The second question, whether that
   * process is still the session (its start time, so a pid handed to another process is noticed),
   * costs a `ps`, which is synchronous on this host's one thread and may take up to its 2 s
   * timeout; asked at every look, a slow `ps` under load held the event loop for most of every
   * look, and every client's hello with it (review L5). So it is asked at every
   * SESSION_COMPARE_EVERY_LOOKS-th look (~30 s) and, after a comparison that could not read a
   * start time, again at the very next look kill(0) still finds the process.
   *
   * A `ps` THAT FAILS OR TIMES OUT IS "UNKNOWN", NEVER "GONE": ending a live session's work over a
   * `ps` that could not answer would be the worse mistake. SESSION_UNKNOWN_LIMIT unknowns in a row,
   * with kill(0) finding the process at each of them, count as alive, and the watch goes back to
   * its ordinary pace — so a `ps` that keeps failing costs at most that many `ps` runs per ~30 s,
   * not one per look. Stated: a session whose start time can NEVER be read is noticed only by its
   * death, not by its pid passing to another process; and a pid that passes to another process
   * between two comparisons is noticed at the next one, ~30 s at most (kill(0) alone cannot tell
   * the two processes apart — and a session that ends is still noticed within one look).
   *
   * WHAT A READING IS COMPARED WITH: the latest reading judged to be the same process, not only
   * the spec's — and with the wall clock's own steps taken out. A reading is `now − etime`, and
   * where `etime` is kept on a clock the wall clock is stepped against (a monotonic one), an NTP
   * step of more than START_SLACK_MS would move every reading of a session that is very much
   * alive outside the slack, and this watch would end that session's work. Between two looks the
   * step is what the wall clock moved beyond what the monotonic clock says passed — measured at
   * EVERY look, `ps` or not, and summed until a reading is accepted, so a step taken between two
   * comparisons, or while `ps` could not answer, is not lost; a reading off by about that much is
   * still the session. A pid handed to another process reads as that process's start — seconds
   * ago — and stays `gone` whatever the step. (A reading taken across a sleep of the machine is
   * either unmoved or moved by the step; both are recognised.) The hello compares a client's
   * reading the same way (servesSession), so the two never disagree about which process the
   * session is, between comparisons any more than at them.
   */
  watchSession(): void {
    let lastWall = Date.now();
    let lastMono = process.hrtime.bigint();
    // Looks since the start time was last compared (or given up on): due at SESSION_COMPARE_EVERY_LOOKS.
    let looksSinceCompare = 0;
    // Comparisons in a row that could not read a start time; one of them makes the next look compare.
    let unknownInARow = 0;
    this.watch = setInterval(() => {
      try {
        const wall = Date.now();
        const mono = process.hrtime.bigint();
        this.wallStepSinceReading += wall - lastWall - Number(mono - lastMono) / 1e6;
        lastWall = wall;
        lastMono = mono;
        if (this.closing) {
          return;
        }
        // Every look: is there a process with the session's pid at all? (kill(0); nothing spawned.)
        if (!isPidAlive(this.session.pid)) {
          this.sessionEnded();
          return;
        }
        looksSinceCompare++;
        if (looksSinceCompare < SESSION_COMPARE_EVERY_LOOKS && unknownInARow === 0) {
          return;
        }
        const step = this.wallStepSinceReading;
        const look = startTimeVerdict(this.session, Math.abs(step) > WALL_STEP_MIN_MS ? step : 0);
        if (look.verdict === 'same' && look.startedAt !== undefined) {
          this.session = { pid: this.session.pid, startedAt: look.startedAt };
          this.wallStepSinceReading = 0;
          looksSinceCompare = 0;
          unknownInARow = 0;
          return;
        }
        if (look.verdict === 'gone') {
          this.sessionEnded();
          return;
        }
        // `unknown`: kill(0) found the process this look, and `ps` could not say when it started.
        unknownInARow++;
        if (unknownInARow >= SESSION_UNKNOWN_LIMIT) {
          // Taken for alive. The step since the last ACCEPTED reading keeps adding up: no reading
          // was accepted, and the next comparison is still made against that one.
          unknownInARow = 0;
          looksSinceCompare = 0;
        }
      } catch {
        // a look that threw said nothing; the next tick looks again
      }
    }, SESSION_POLL_MS);
  }

  /** The session is gone: shutdown with the session-end reason (idempotent — it also stops this watch). */
  private sessionEnded(): void {
    this.hooks.log(`cco-dispatch host: Claude Code session ${this.session.pid} has ended — shutting down`);
    this.hooks.shutdown(this.hooks.shutdownReason);
  }

  /**
   * Whether `asked` — a client's reading of its session — is the session this host serves: the
   * latest reading the watch accepted, within the slack (host-protocol.sameProcess), or that reading
   * moved by the wall-clock step taken since it, exactly as the watch's own comparison allows
   * (startTimeVerdict). The second form matters since readings are taken only every ~30 s (L5): a
   * step in between moves a client's reading where `etime` runs on a stepped-against clock, and
   * this session's own clients must not be turned away (-32011) until the next comparison.
   */
  private servesSession(asked: ProcessIdentity): boolean {
    const known = this.session;
    if (sameProcess(asked, known)) {
      return true;
    }
    const step = this.wallStepSinceReading;
    return Math.abs(step) > WALL_STEP_MIN_MS && sameProcess(asked, { pid: known.pid, startedAt: known.startedAt + step });
  }

  /**
   * A new connection. Never throws: a connection that cannot be set up is destroyed.
   *
   * UNTIL ITS HELLO (A37, review S4) a connection is held to what a hello needs: at most
   * UNGREETED_MAX such connections at once (one more is destroyed at its accept, the refusals
   * logged at most once per UNGREETED_LOG_EVERY_MS with their count, so a flood cannot flood the
   * log too), HELLO_DEADLINE_MS to say it (then -32002 and closed, logged), and a line of at most
   * PRE_HELLO_LINE_MAX_BYTES (receive). Without these, a process of the user could open hundreds
   * of sockets that each hold up to 80 MiB, uncounted and untimed — the observer cap counts only
   * greeted connections. A start's probe from another host of this session (probeSocket) hellos
   * at once and is not affected.
   */
  accept(socket: net.Socket): void {
    const connection: Connection = {
      id: this.nextConnId++,
      socket,
      open: true,
      greeted: false,
      role: undefined,
      subscription: undefined,
      teamToldClosed: false,
      pieces: [],
      pieceBytes: 0,
      inFlight: 0,
      peerEnded: false,
      helloTimer: undefined,
      readingHeld: false,
      clientPid: undefined,
      client: undefined,
    };
    try {
      // First of all: an 'error' with no listener would end the host over one client. EPIPE and
      // ECONNRESET end up here — that connection is over, and only that one.
      socket.on('error', () => {
        this.drop(connection);
      });
      if (this.closing) {
        this.drop(connection);
        return;
      }
      let ungreeted = 0;
      for (const other of this.connections.values()) {
        if (other.open && !other.greeted) {
          ungreeted++;
        }
      }
      if (ungreeted >= UNGREETED_MAX) {
        this.ungreetedRefused++;
        const now = Date.now();
        if (now - this.ungreetedLoggedAt >= UNGREETED_LOG_EVERY_MS || now < this.ungreetedLoggedAt) {
          this.hooks.log(
            `cco-dispatch host: ${this.ungreetedRefused} connection(s) closed at once — ${UNGREETED_MAX} connections that have not said hello are already open`,
          );
          this.ungreetedRefused = 0;
          this.ungreetedLoggedAt = now;
        }
        this.drop(connection);
        return;
      }
      this.connections.set(connection.id, connection);
      connection.helloTimer = setTimeout(() => {
        connection.helloTimer = undefined;
        if (connection.open && !connection.greeted) {
          this.hooks.log(`cco-dispatch host: a connection that did not say hello within ${HELLO_DEADLINE_MS / 1000} s was closed`);
          this.closeWithError(
            connection,
            null,
            RPC_ERROR.helloFirst,
            `no ${METHOD.hello} within ${HELLO_DEADLINE_MS / 1000} s; this connection is closed.`,
          );
        }
      }, HELLO_DEADLINE_MS);
      connection.helloTimer.unref();
      socket.on('close', () => {
        connection.open = false;
        connection.pieces = [];
        connection.pieceBytes = 0;
        this.clearHelloTimer(connection);
        this.connections.delete(connection.id);
        this.tellTeamClosed(connection);
      });
      socket.on('end', () => {
        connection.peerEnded = true;
        this.closeIfIdle(connection);
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          this.receive(connection, chunk);
        } catch (err) {
          // A defect in the reading of one connection: that connection ends, nothing else does.
          this.hooks.log(
            `cco-dispatch host: a connection's input could not be read (${shown(err instanceof Error ? err.message : err, 200)})`,
          );
          this.closeWithError(connection, null, RPC_ERROR.invalidRequest, 'Invalid Request — the input could not be read.');
        }
      });
    } catch {
      this.connections.delete(connection.id);
      this.drop(connection);
    }
  }

  /**
   * Cut a connection's bytes into lines (`\n`-delimited; the line end is not part of the line) and
   * hand each to onLine. A line longer than the limit is never assembled: the moment the current
   * line passes it, the host answers -32600 and closes the connection (§15.4), and nothing more of
   * it is read. The limit is LINE_MAX_BYTES once the connection is greeted and
   * PRE_HELLO_LINE_MAX_BYTES before (A37) — judged per line, so the bytes after a hello in the same
   * chunk already have the greeted limit (the hello is decided synchronously, in onLine).
   */
  private receive(connection: Connection, chunk: Buffer): void {
    let from = 0;
    while (connection.open) {
      const end = chunk.indexOf(0x0a, from);
      const part = chunk.subarray(from, end === -1 ? chunk.length : end);
      const limit = connection.greeted ? LINE_MAX_BYTES : PRE_HELLO_LINE_MAX_BYTES;
      if (connection.pieceBytes + part.length > limit) {
        connection.pieces = [];
        connection.pieceBytes = 0;
        if (!connection.greeted) {
          this.hooks.log(`cco-dispatch host: a connection sent more than ${limit} bytes before its hello — closed`);
        }
        this.closeWithError(
          connection,
          null,
          RPC_ERROR.invalidRequest,
          `Invalid Request — a line longer than ${limit} bytes${connection.greeted ? '' : ' before the hello'}; this connection is closed.`,
        );
        return;
      }
      if (end === -1) {
        if (part.length > 0) {
          connection.pieces.push(part);
          connection.pieceBytes += part.length;
        }
        return;
      }
      const line = connection.pieces.length === 0 ? part : Buffer.concat([...connection.pieces, part]);
      connection.pieces = [];
      connection.pieceBytes = 0;
      this.onLine(connection, line);
      from = end + 1;
    }
  }

  /**
   * One line of a connection. Before the hello, only the hello: anything else — a request, a
   * notification, a line that is not a message — is answered -32002 and the connection closed.
   * After it, a request goes to the server under a host id (forward); a line that is not one
   * JSON-RPC object is answered -32600 and the connection stays.
   */
  private onLine(connection: Connection, line: Buffer): void {
    let text: string;
    try {
      text = utf8.decode(line);
    } catch {
      this.notOneMessage(connection);
      return;
    }
    if (text.trim() === '') {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.notOneMessage(connection);
      return;
    }
    if (!isPlainObject(msg)) {
      this.notOneMessage(connection);
      return;
    }
    const { id, method } = msg;
    const idUsable = id === null || typeof id === 'string' || typeof id === 'number';
    if (!connection.greeted) {
      if (this.closing) {
        // Accepted a moment before shutdown began: dropped unanswered, as accept drops one now. Any
        // answer — a refusal too — is what tells a starting host's probe that a live host is here
        // (probeSocket, §15.12 M5), and this one will never serve again.
        this.drop(connection);
        return;
      }
      // A hello carries a real id: it is the one request whose answer a client must be able to
      // tell apart.
      if (method !== METHOD.hello || (typeof id !== 'string' && typeof id !== 'number')) {
        this.closeWithError(
          connection,
          idUsable ? (id as string | number | null) : null,
          RPC_ERROR.helloFirst,
          `the first message on this socket must be the request ${METHOD.hello}`,
        );
        return;
      }
      this.hello(connection, id, msg.params);
      return;
    }
    if (method === METHOD.hello) {
      // A second hello on a greeted connection is answered as the first was.
      if (typeof id === 'string' || typeof id === 'number') {
        this.hello(connection, id, msg.params);
      }
      return;
    }
    if (id !== undefined && !idUsable) {
      this.write(connection, {
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_ERROR.invalidRequest, message: 'Invalid Request — "id" must be a string or a number.' },
      });
      return;
    }
    const route = this.route(connection, method, msg.params);
    if (route === 'forbidden') {
      // A notification a role may not send is dropped: there is nothing to answer it with.
      if (id !== undefined) {
        this.write(connection, {
          jsonrpc: '2.0',
          id,
          error: {
            code: RPC_ERROR.roleForbidden,
            message: `a connection of role ${connection.role ?? 'unknown'} may not call ${shown(method, 80)}`,
          },
        });
      }
      return;
    }
    if (route === 'team') {
      // Team requests go on while the host goes down: the engine is what knows it is suspending
      // (§7.9) — it refuses what must be refused, and an observer keeps being answered (and its
      // connection writable) until the exit.
      this.teamRequest(connection, msg, id as string | number | null | undefined);
      return;
    }
    if (this.closing) {
      if (id !== undefined) {
        if (this.team !== undefined && this.isTeamOpCall(method, msg.params)) {
          // §7.6/§7.9: during a suspend every team tools/call is refused with the `suspending`
          // sentence — an answer of the operation (exit 20), not a fault of the transport.
          this.write(connection, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: TEAM_TEXT.suspending() }], isError: true },
          });
          return;
        }
        this.write(connection, { jsonrpc: '2.0', id, error: { code: -32603, message: SHUTTING_DOWN_MESSAGE } });
      }
      return;
    }
    this.forward(connection, msg, id as string | number | null | undefined);
  }

  /** Whether a request is a tools/call of one of the team operations (§7.5). */
  private isTeamOpCall(method: unknown, params: unknown): boolean {
    return method === 'tools/call' && isPlainObject(params) && typeof params.name === 'string' && TEAM_OP_NAMES.has(params.name);
  }

  /**
   * §7.6's role table, for one request (or notification) of a greeted connection:
   *  - session: everything it could call before team mode goes to the server, as before;
   *    cco/team.wait and every observer method go to the engine; cco/member.call is refused;
   *  - observer: `ping` and tools/call of TEAM_OBSERVER_TOOLS go to the server; the observer
   *    methods to the engine; anything else is refused;
   *  - member: `ping` goes to the server; cco/member.call to the engine; anything else is refused.
   * Without a team side every team method is the server's, which does not have it (-32601), and
   * only session connections exist.
   */
  private route(connection: Connection, method: unknown, params: unknown): Route {
    const team = this.team !== undefined && typeof method === 'string';
    switch (connection.role) {
      case 'observer':
        if (method === PING_METHOD) {
          return 'server';
        }
        if (method === 'tools/call') {
          return isPlainObject(params) && typeof params.name === 'string' && OBSERVER_TOOLS.has(params.name)
            ? 'server'
            : 'forbidden';
        }
        return team && OBSERVER_METHODS.has(method) ? 'team' : 'forbidden';
      case 'member':
        if (method === PING_METHOD) {
          return 'server';
        }
        return team && MEMBER_METHODS.has(method) ? 'team' : 'forbidden';
      default:
        if (team && (OBSERVER_METHODS.has(method) || method === METHOD_TEAM.wait)) {
          return 'team';
        }
        return team && method === METHOD_TEAM.memberCall ? 'forbidden' : 'server';
    }
  }

  /** A line that is not one JSON-RPC object: -32002 and closed before the hello, -32600 after it. */
  private notOneMessage(connection: Connection): void {
    if (!connection.greeted) {
      this.closeWithError(
        connection,
        null,
        RPC_ERROR.helloFirst,
        `the first message on this socket must be the request ${METHOD.hello}`,
      );
      return;
    }
    this.write(connection, {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_ERROR.invalidRequest, message: 'Invalid Request — expected one JSON-RPC request object per line.' },
    });
  }

  /**
   * cco/hello: the protocol must be this build's (-32010); then the ROLE decides (§7.6, H1).
   *
   * `session` (the role absent, as every client before team mode sends it): the session must be
   * this host's — the same pid, started within the slack of the session's latest accepted reading,
   * wall-clock steps since that reading allowed for (-32011, servesSession). A start's probe from
   * another host of this session is a hello like any other (probeSocket): its answer is what tells
   * that host this one is alive.
   *
   * `observer` / `member`: NO session check — the engine decides (TeamHostSide.hello: any process
   * of this user may observe, up to the observer cap; a member only with the credential of a live
   * member). Refused, it answers the engine's code (-32012, -32013); with no team side, -32013.
   *
   * A refused hello closes the connection: nothing else can be asked on it. The answer carries the
   * host's identity, its workspace, the hash of the server.js it was started from (the client
   * compares it with its own, §15.2 step 6), the data root, and — when this host serves teams —
   * `features: [TEAM_FEATURE]`; an observer's or member's answer adds the engine's own fields.
   *
   * A second hello on a greeted connection is answered as the first was when both are a
   * session's; one that would CHANGE the connection's role, or re-greet an observer or a member
   * (whose slots the engine counts), is refused -32013 and the connection stays as it was.
   */
  private hello(connection: Connection, id: string | number, params: unknown): void {
    const asked: Record<string, unknown> = isPlainObject(params) ? params : {};
    if (asked.protocol !== PROTOCOL_VERSION) {
      this.closeWithError(
        connection,
        id,
        RPC_ERROR.protocolMismatch,
        `this dispatch host speaks protocol ${PROTOCOL_VERSION}, not ${shown(asked.protocol, 20)} — the cco ` +
          'command and the host are from different builds',
      );
      return;
    }
    const role: unknown = asked.role === undefined ? 'session' : asked.role;
    if (role !== 'session' && role !== 'observer' && role !== 'member') {
      this.closeWithError(
        connection,
        id,
        RPC_ERROR.roleForbidden,
        `"role" must be session, observer or member, not ${shown(role, 40)}`,
      );
      return;
    }
    if (connection.greeted && (connection.role !== 'session' || role !== 'session')) {
      this.write(connection, {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_ERROR.roleForbidden, message: `this connection already greeted as ${connection.role ?? 'unknown'}` },
      });
      return;
    }
    if (role !== 'session') {
      this.teamHello(connection, id, role, params);
      return;
    }
    const session = identityOf(asked.session);
    if (session === undefined || !this.servesSession(session)) {
      this.closeWithError(
        connection,
        id,
        RPC_ERROR.wrongSession,
        `this dispatch host serves Claude Code session ${this.session.pid}, not the session that asked`,
      );
      return;
    }
    this.greet(connection, 'session', params);
    this.write(connection, { jsonrpc: '2.0', id, result: this.helloResult() });
  }

  /**
   * The connection's hello was accepted: it takes its role, its hello deadline ends (A37), and the
   * pid it claimed (and an observer's client name) is kept for the log of its mutating calls (A34).
   */
  private greet(connection: Connection, role: HostRole, params: unknown): void {
    connection.greeted = true;
    connection.role = role;
    this.clearHelloTimer(connection);
    const asked: Record<string, unknown> = isPlainObject(params) ? params : {};
    connection.clientPid = isPid(asked.clientPid) ? asked.clientPid : undefined;
    connection.client = typeof asked.client === 'string' ? shown(asked.client, 20) : undefined;
  }

  private clearHelloTimer(connection: Connection): void {
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = undefined;
    }
  }

  /** This host's hello result: its identity, and TEAM_FEATURE when it serves teams. */
  private helloResult(): HelloResult {
    const result: HelloResult = {
      protocol: PROTOCOL_VERSION,
      hostPid: process.pid,
      hostStartedAt: this.hostStartedAt,
      workspace: this.spec.workspace,
      serverHash: this.spec.serverHash,
      dataRoot: ROOT_DIR,
    };
    if (this.team !== undefined) {
      result.features = [TEAM_FEATURE];
    }
    return result;
  }

  /**
   * An observer's or a member's hello, decided by the engine (TeamHostSide.hello — synchronous,
   * total by its contract; a throw is taken for a refusal of this one hello, and logged). Accepted:
   * the connection takes the role, and the answer is the engine's fields under this host's own
   * hello result (the host's identity fields are never the engine's to change).
   */
  private teamHello(connection: Connection, id: string | number, role: 'observer' | 'member', params: unknown): void {
    const team = this.team;
    if (team === undefined) {
      this.closeWithError(connection, id, RPC_ERROR.roleForbidden, 'this dispatch host serves no teams');
      return;
    }
    let decided: ReturnType<TeamHostSide['hello']>;
    try {
      decided = team.hostSide.hello(connection.id, role, params);
    } catch (err) {
      this.hooks.log(`cco-dispatch host: a ${role} hello could not be decided (${shown(err instanceof Error ? err.message : err, 200)})`);
      this.closeWithError(connection, id, TEAM_RPC.internalError, "Internal error — the hello could not be decided; see the host's log.");
      return;
    }
    if (!decided.ok) {
      this.closeWithError(connection, id, decided.code, decided.message);
      return;
    }
    this.greet(connection, role, params);
    const extra: Record<string, unknown> = isPlainObject(decided.result) ? decided.result : {};
    this.write(connection, { jsonrpc: '2.0', id, result: { ...extra, ...this.helloResult() } });
  }

  /**
   * One team request (cco/team.*, cco/member.call) of a role that may call it, to the engine
   * (TeamHostSide.request) under the connection's ConnId — mapped under a host id like any
   * request until it is answered, so a HELD one (wait, subscribe) keeps its connection from
   * being closed as idle (H1). A subscribe becomes the connection's subscription BEFORE the
   * engine sees it: its snapshot is pushed while the request is being handled, and carries the
   * subscribe's client id. A notification of a team method is not a thing the engine takes:
   * dropped.
   *
   * A34 (review S1): every call of an observer method that changes a team is logged first — the
   * role, the method, the team id it names and the pid (and client) its hello claimed. That is a
   * record for a post-mortem, not a defence: any process of this OS user can hello as an observer
   * and make these calls (the contract states it as a known limitation), and the pid is the one the
   * client CLAIMED.
   */
  private teamRequest(connection: Connection, msg: Record<string, unknown>, id: string | number | null | undefined): void {
    const team = this.team;
    if (team === undefined || id === undefined || typeof msg.method !== 'string') {
      return;
    }
    const method = msg.method;
    if (MUTATING_OBSERVER_METHODS.has(method)) {
      const teamId: unknown = isPlainObject(msg.params) ? msg.params.teamId : undefined;
      this.hooks.log(
        `cco-dispatch host: ${connection.role ?? 'unknown'} call ${method}` +
          `${teamId === undefined ? '' : ` for team ${shown(teamId, 40)}`} from client pid ${connection.clientPid ?? 'unknown'}` +
          `${connection.client === undefined ? '' : ` (${connection.client})`} on connection ${connection.id}`,
      );
    }
    const hostId = this.nextRequestId++;
    this.requests.set(hostId, { connection, clientId: id });
    connection.inFlight++;
    if (method === METHOD_TEAM.subscribe) {
      connection.subscription = hostId;
    }
    let handled: Promise<unknown>;
    try {
      handled = Promise.resolve(team.hostSide.request(connection.id, method, msg.params));
    } catch (err) {
      handled = Promise.reject(err);
    }
    handled.then(
      (result) => this.teamAnswer(hostId, { result: result === undefined ? null : result }),
      (err: unknown) => {
        if (err instanceof TeamProtocolError) {
          this.teamAnswer(hostId, { error: { code: err.rpcCode, message: err.message } });
          return;
        }
        this.hooks.log(
          `cco-dispatch host: a team request (${shown(method, 60)}) could not be handled: ${shown(err instanceof Error ? err.message : err)}`,
        );
        this.teamAnswer(hostId, {
          error: { code: TEAM_RPC.internalError, message: "Internal error — the request could not be handled; see the host's log." },
        });
      },
    );
  }

  /** The answer of a team request, to its connection under the client's id (dropped when the connection is gone). Never throws. */
  private teamAnswer(hostId: number, body: { result: unknown } | { error: { code: number; message: string } }): void {
    try {
      const pending = this.take(hostId);
      if (pending === undefined) {
        return;
      }
      const connection = pending.connection;
      if (connection.subscription === hostId) {
        connection.subscription = undefined;
      }
      const answer: Record<string, unknown> = { jsonrpc: '2.0', id: pending.clientId, ...body };
      if ('result' in body && connection.role === 'session') {
        answer.result = this.withFooter(body.result);
      }
      this.write(connection, answer);
      this.closeIfIdle(connection);
    } catch {
      // an answer that cannot be sent is dropped — its connection is the only one that loses it
    }
  }

  /**
   * A TextResult with the unread team footer (§4.4 item 2, L9) when this host's team has unread
   * messages for the lead and the result carries none yet; anything else as it is. Only ever
   * applied to answers on a SESSION connection: those are the `cco` answers that reached the host.
   */
  private withFooter(result: unknown): unknown {
    const team = this.team;
    if (team === undefined || !isTextResult(result) || result.footer !== undefined) {
      return result;
    }
    let footer: string | undefined;
    try {
      footer = team.footer();
    } catch {
      footer = undefined;
    }
    return typeof footer === 'string' && footer !== '' ? { ...result, footer } : result;
  }

  /** TeamHostSide.closed for a connection that ever greeted — once. Never throws. */
  private tellTeamClosed(connection: Connection): void {
    const team = this.team;
    if (team === undefined || !connection.greeted || connection.teamToldClosed) {
      return;
    }
    connection.teamToldClosed = true;
    try {
      team.hostSide.closed(connection.id);
    } catch (err) {
      this.hooks.log(`cco-dispatch host: the team engine failed on a closed connection (${shown(err instanceof Error ? err.message : err, 200)})`);
    }
  }

  /**
   * TeamConnections.push (§7.6, H1/MD-55): one notification to one connection, `requestId` — the
   * client's id of the connection's held subscribe, `null` when it holds none — put first.
   * TEAM_OBSERVER_OUTBOUND_MAX_BYTES bounds what may be QUEUED on the socket (writableLength),
   * this notification included:
   *  - it fits → written, `sent`;
   *  - it does not and it is `lossy` (activity) → nothing written, `dropped`;
   *  - it does not and it is not lossy (an event, a host state) → `cco/team.host {state:'running',
   *    reason:'overflow'}` is written first when THAT fits, then the connection is closed —
   *    `closed`; the engine hears it through TeamHostSide.closed, and the front end resubscribes
   *    from its last seq.
   * A connection that is gone, closing or never greeted → `closed`. Params that cannot be written
   * as JSON are the engine's defect: logged, `dropped`. Never throws.
   */
  private push(conn: ConnId, method: string, params: object, lossy: boolean): 'sent' | 'dropped' | 'closed' {
    const connection = this.connections.get(conn);
    if (connection === undefined || !connection.greeted || !this.writable(connection)) {
      return 'closed';
    }
    try {
      const requestId = this.subscriptionClientId(connection);
      const rest: Record<string, unknown> = { ...(params as Record<string, unknown>) };
      delete rest.requestId;
      let line: string;
      try {
        line = `${JSON.stringify({ jsonrpc: '2.0', method, params: { requestId, ...rest } })}\n`;
      } catch (err) {
        this.hooks.log(
          `cco-dispatch host: a team notification (${shown(method, 60)}) could not be written as JSON — dropped (${shown(err instanceof Error ? err.message : err, 120)})`,
        );
        return 'dropped';
      }
      const queued = connection.socket.writableLength;
      if (queued + Buffer.byteLength(line, 'utf8') <= TEAM_OBSERVER_OUTBOUND_MAX_BYTES) {
        connection.socket.write(line);
        this.holdReading(connection);
        return 'sent';
      }
      if (lossy) {
        return 'dropped';
      }
      this.closeOverflowing(connection, `a ${method} notification`);
      return 'closed';
    } catch {
      this.drop(connection);
      return 'closed';
    }
  }

  /**
   * An observer or member connection whose client does not take what is queued for it (MD-55, and
   * for answers A37): `cco/team.host {state:'running', reason:'overflow'}` is written last when it
   * still fits under TEAM_OBSERVER_OUTBOUND_MAX_BYTES, then the connection is closed (closeSocket);
   * the engine hears it through TeamHostSide.closed, and a front end resubscribes from its last
   * seq. Logged, once per connection. Never throws.
   */
  private closeOverflowing(connection: Connection, what: string): void {
    const queued = connection.socket.writableLength;
    const notice = `${JSON.stringify({
      jsonrpc: '2.0',
      method: METHOD_TEAM.host,
      params: { requestId: this.subscriptionClientId(connection), state: 'running', reason: 'overflow' },
    })}\n`;
    this.hooks.log(
      `cco-dispatch host: ${connection.role ?? 'a'} connection ${connection.id} does not read what is sent to it ` +
        `(${queued} bytes queued) — closed at ${what}`,
    );
    this.closeSocket(connection, queued + Buffer.byteLength(notice, 'utf8') <= TEAM_OBSERVER_OUTBOUND_MAX_BYTES ? notice : undefined);
  }

  /**
   * A37: while more than TEAM_OBSERVER_OUTBOUND_MAX_BYTES wait to be taken by an observer's or a
   * member's client, nothing more is READ from it — each request it sends is an answer more to
   * queue — until the queue drains (or the connection closes). Session connections are not
   * bounded: their client is this session's own `cco`. Never throws.
   */
  private holdReading(connection: Connection): void {
    if (
      connection.readingHeld ||
      (connection.role !== 'observer' && connection.role !== 'member') ||
      connection.socket.writableLength <= TEAM_OBSERVER_OUTBOUND_MAX_BYTES
    ) {
      return;
    }
    connection.readingHeld = true;
    try {
      connection.socket.pause();
      connection.socket.once('drain', () => {
        connection.readingHeld = false;
        try {
          if (connection.open) {
            connection.socket.resume();
          }
        } catch {
          // closed meanwhile
        }
      });
    } catch {
      connection.readingHeld = false;
    }
  }

  /** The client id of the connection's held subscribe, or null. */
  private subscriptionClientId(connection: Connection): string | number | null {
    const hostId = connection.subscription;
    if (hostId === undefined) {
      return null;
    }
    const pending = this.requests.get(hostId);
    return pending !== undefined && pending.connection === connection ? pending.clientId : null;
  }

  /**
   * TeamConnections.close: with `code`, one JSON-RPC error `{id: null, error:{code, message}}`
   * first (closeWithError); without, the connection is ended once what is queued is out
   * (closeSocket). Idempotent; never throws.
   */
  private closeConnection(conn: ConnId, code?: number, message?: string): void {
    const connection = this.connections.get(conn);
    if (connection === undefined || !connection.open) {
      return;
    }
    if (code !== undefined) {
      this.closeWithError(connection, null, code, typeof message === 'string' && message !== '' ? message : 'closed by the dispatch host');
      return;
    }
    this.closeSocket(connection, undefined);
  }

  /**
   * Hand one message to the server. A request gets a host id first — the server's bookkeeping is
   * keyed by request id, and only an id this host mints is unique across connections — and the
   * way back to its connection and the client's own id is kept until it is answered. A
   * notification goes as it is: there is nothing to answer, and nothing to map. Either goes with
   * the role of its connection (HostRequestContext) — list_workers' poll floor holds back an
   * observer's call and never a session's.
   *
   * When the server's handling of a request is over, anything still mapped will never be answered
   * (a message with an id and no method; a request the shutdown aborted), and the mapping goes. A
   * handling that REJECTED is a defect of the server: the request is told so, as on stdio.
   */
  private forward(connection: Connection, msg: Record<string, unknown>, id: string | number | null | undefined): void {
    // Only a greeted connection's messages are forwarded, and greeting sets the role; the
    // fallback is never taken, and would be the role the floor never holds back.
    const context: HostRequestContext = { role: connection.role ?? 'session' };
    if (id === undefined) {
      this.hooks.handleRequest(msg, context).catch((err: unknown) => {
        this.hooks.log(
          `cco-dispatch host: a notification could not be handled: ${shown(err instanceof Error ? err.message : err)}`,
        );
      });
      return;
    }
    const hostId = this.nextRequestId++;
    this.requests.set(hostId, { connection, clientId: id });
    connection.inFlight++;
    this.hooks.handleRequest({ ...msg, id: hostId }, context).then(
      () => {
        const unanswered = this.take(hostId);
        if (unanswered !== undefined) {
          this.closeIfIdle(unanswered.connection);
        }
      },
      (err: unknown) => {
        this.hooks.log(
          `cco-dispatch host: a request could not be handled: ${shown(err instanceof Error ? err.message : err)}`,
        );
        const pending = this.take(hostId);
        if (pending !== undefined) {
          this.write(pending.connection, {
            jsonrpc: '2.0',
            id: pending.clientId,
            error: { code: -32603, message: "Internal error — the request could not be handled; see the host's log." },
          });
          this.closeIfIdle(pending.connection);
        }
      },
    );
  }

  /** The mapping of host id `hostId`, removed — its request is answered, or will never be. */
  private take(hostId: number): PendingRequest | undefined {
    const pending = this.requests.get(hostId);
    if (pending === undefined) {
      return undefined;
    }
    this.requests.delete(hostId);
    pending.connection.inFlight = Math.max(0, pending.connection.inFlight - 1);
    return pending;
  }

  /**
   * HostTransport.send: an answer, to the connection of its request, under the client's id — on a
   * SESSION connection with the unread team footer when there is one (withFooter, L9).
   */
  private answer(message: Record<string, unknown>): void {
    try {
      const hostId = message.id;
      // Only an id this host minted can be answered: there is no connection to send anything else to.
      const pending = typeof hostId === 'number' ? this.take(hostId) : undefined;
      if (pending === undefined) {
        return;
      }
      const out: Record<string, unknown> = { jsonrpc: '2.0', ...message, id: pending.clientId };
      if (pending.connection.role === 'session' && Object.hasOwn(message, 'result')) {
        out.result = this.withFooter(message.result);
      }
      this.write(pending.connection, out);
      this.closeIfIdle(pending.connection);
    } catch {
      // an answer that cannot be sent is dropped — its connection is the only one that loses it
    }
  }

  /** HostTransport.notify: params with the client's own requestId first, to the request's connection. */
  private notify(requestId: string | number, method: string, params: Record<string, unknown>): void {
    try {
      const pending = typeof requestId === 'number' ? this.requests.get(requestId) : undefined;
      if (pending === undefined) {
        return;
      }
      this.write(pending.connection, { jsonrpc: '2.0', method, params: { requestId: pending.clientId, ...params } });
    } catch {
      // as for an answer
    }
  }

  /** Whether anything can still be written to a connection. */
  private writable(connection: Connection): boolean {
    return connection.open && !connection.socket.destroyed && connection.socket.writable;
  }

  /**
   * One message, as one line, to one connection — or nothing, when it is gone. A write that fails
   * ends that connection and touches no other. Never throws.
   *
   * A37 (review S5): on an OBSERVER or MEMBER connection an answer obeys the cap pushes obey — when
   * something is already queued and the line would take the queue past
   * TEAM_OBSERVER_OUTBOUND_MAX_BYTES, the connection is closed with the overflow notice instead
   * (closeOverflowing), and the answer is not written. A line into an EMPTY queue is always
   * written, whatever its size (a `cco/team.get` of a large team may come near the cap on its
   * own): a client that reads costs at most one answer, and one that does not is held
   * (holdReading) and then closed at its next answer. Before this, answers were never bounded,
   * and a client that kept asking and never read made the host buffer without bound.
   */
  private write(connection: Connection, message: Record<string, unknown>): void {
    if (!this.writable(connection)) {
      return;
    }
    try {
      const line = `${JSON.stringify(message)}\n`;
      if (connection.role === 'observer' || connection.role === 'member') {
        const queued = connection.socket.writableLength;
        if (queued > 0 && queued + Buffer.byteLength(line, 'utf8') > TEAM_OBSERVER_OUTBOUND_MAX_BYTES) {
          this.closeOverflowing(connection, 'an answer');
          return;
        }
      }
      connection.socket.write(line);
      this.holdReading(connection);
    } catch {
      this.drop(connection);
    }
  }

  /**
   * A connection whose client has ended its half and that has nothing in flight is closed from
   * this side as well, once what was written to it is out. One that is already closed, or being
   * closed by closeWithError (whose answer may still be on its way out), is left to that. Never
   * throws.
   */
  private closeIfIdle(connection: Connection): void {
    if (!connection.peerEnded || connection.inFlight > 0 || !connection.open) {
      return;
    }
    const socket = connection.socket;
    const writable = this.writable(connection);
    connection.open = false;
    try {
      if (!writable) {
        socket.destroy();
        return;
      }
      socket.end(() => socket.destroy());
    } catch {
      this.drop(connection);
    }
  }

  /**
   * Answer with an error and close the connection: nothing more is read from it, and it is
   * destroyed once the answer is out (or CLOSE_AFTER_ANSWER_MS later, for a client that does not
   * read). Never throws.
   */
  private closeWithError(connection: Connection, id: string | number | null, code: number, message: string): void {
    const socket = connection.socket;
    const writable = this.writable(connection);
    connection.open = false;
    try {
      if (!writable) {
        socket.destroy();
        return;
      }
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // already destroyed
        }
      }, CLOSE_AFTER_ANSWER_MS);
      timer.unref();
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, () => {
        clearTimeout(timer);
        socket.destroy();
      });
    } catch {
      this.drop(connection);
    }
  }

  /**
   * End a connection from this side without an answer — optionally after one last line — and
   * destroy it once what is queued is out, or CLOSE_AFTER_ANSWER_MS later for a client that does
   * not read (an overflowing observer, TeamConnections.close). Never throws.
   */
  private closeSocket(connection: Connection, lastLine: string | undefined): void {
    const socket = connection.socket;
    const writable = this.writable(connection);
    connection.open = false;
    try {
      if (!writable) {
        socket.destroy();
        return;
      }
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // already destroyed
        }
      }, CLOSE_AFTER_ANSWER_MS);
      timer.unref();
      const done = (): void => {
        clearTimeout(timer);
        socket.destroy();
      };
      if (lastLine !== undefined) {
        socket.end(lastLine, done);
      } else {
        socket.end(done);
      }
    } catch {
      this.drop(connection);
    }
  }

  /** The connection is over, now. Never throws. */
  private drop(connection: Connection): void {
    connection.open = false;
    try {
      connection.socket.destroy();
    } catch {
      // already destroyed
    }
  }
}
