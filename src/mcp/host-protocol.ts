import { createHash } from 'crypto';
import * as path from 'path';
import type { UiAccount, UiUnsupportedAccount } from '../uiTypes';

/**
 * The contract between the `cco` command (mcp/cli.ts) and the dispatch host it talks to
 * (server.ts in host mode, mcp/host.ts) — contract-2.0-fixes.md §15. Both sides import this file
 * and nothing here may be redefined on either side: a constant written twice is two constants.
 *
 * Node built-ins only at runtime; must not import 'vscode'. Both bundles load it. Its one
 * type-only import is `../uiTypes` (WorkersSnapshot): a repository that vendors this file vendors
 * uiTypes.ts beside it at that relative path.
 */

/** A `running` event with no pid younger than this reads alive in every reconcile (contract §15.12 M4). */
export const FAILOVER_GRACE_MS = 180_000;

/** Bumped when a message, field or meaning below changes. The hello refuses a different one. */
export const PROTOCOL_VERSION = 1;

/** The one spelling of the command — in the installed texts, help, messages and permission rules. */
export const COMMAND_SPELLING = '~/.claude-code-orchestrator/bin/cco';

/** Set in every dispatched worker's environment to its task id (§15.5). Never scrubbed. */
export const DISPATCHED_TASK_ENV = 'CCO_DISPATCHED_TASK';

/** The workspace directory the installed texts tell the model to write task files into. */
export const TASK_FILE_DIR = '.cco';
/** Where a cut answer's full text is saved, inside TASK_FILE_DIR. */
export const OUTPUT_SUBDIR = 'out';
/** The exact content of `<workspace>/.cco/.gitignore`. */
export const TASK_FILE_DIR_GITIGNORE = '*\n';

/** argv[2] of server.js that selects host mode; argv[3] is the spec path. */
export const HOST_ARG = '--host';
/** argv[2] of cli.js for the short-lived intermediate of the double fork; argv[3] is the spec path. */
export const LAUNCH_HOST_ARG = '--cco-launch-host';

/** How often the host reads the session process's identity. */
export const SESSION_POLL_MS = 2_000;
/** How long a client waits for a host it started (or saw being started) to answer hello. */
export const HOST_START_TIMEOUT_MS = 20_000;
/**
 * A start lock is stale when its holder is gone, or when it is older than this AND no host process
 * for its spec is alive (a legitimate start can hold it ~45 s: a stale host's respawn).
 */
export const START_LOCK_STALE_MS = 60_000;
/** Two readings of one process's start time match within this (registry.processStartedAt is ±1–2 s). */
export const START_SLACK_MS = 5_000;
/**
 * The double fork's intermediate (cli.js LAUNCH_HOST_ARG) rotates the host's log before it
 * starts the host when the log is larger than this. The host itself never rotates: its stderr is
 * that file, and would follow the renamed one.
 */
export const HOST_LOG_ROTATE_BYTES = 2 * 1024 * 1024;
/** The longest line either side accepts. */
export const LINE_MAX_BYTES = 80 * 1024 * 1024;
/** How often the host looks while answering cco/status with a wait. */
export const STATUS_WAIT_POLL_MS = 2_000;
/** The client's own deadline for cco/status is waitSeconds plus this. */
export const STATUS_WAIT_CLIENT_SLACK_MS = 30_000;

/** Characters of answer printed on stdout before the cut (§15.3.4). */
export const OUT_CAP_CHARS = 28_000;
/** BASH_MAX_OUTPUT_LENGTH lowers the cap to (its value − this) when that is less, and it is ≥ OUT_CAP_MIN_ENV. */
export const OUT_CAP_ENV_MARGIN = 1_000;
export const OUT_CAP_MIN_ENV = 4_000;

/**
 * §15.3.4's FOOTER_RESERVE: 1,000 characters + 100 per accepted id, at most OUT_CAP / 2 — and,
 * since team mode, + TEAM_FOOTER_RESERVE_CHARS for the unread team footer (L9). Named here
 * because the HOST now composes text under the same reserve the client cuts with: team_inbox and
 * team_wait show only what fits under `capChars − FOOTER_RESERVE` and mark read through the last
 * message shown (team contract M9). cli.ts's private FOOTER_RESERVE_BASE / FOOTER_RESERVE_PER_ID
 * are these numbers and are to be taken from here, with footerReserveChars (T6).
 */
export const FOOTER_RESERVE_BASE_CHARS = 1_000;
export const FOOTER_RESERVE_PER_ID_CHARS = 100;
/** L9: what the unread-team-messages footer (TextResult.footer) adds to FOOTER_RESERVE. */
export const TEAM_FOOTER_RESERVE_CHARS = 300;

/** FOOTER_RESERVE for an output cap and a count of accepted ids, the team footer's share included. */
export function footerReserveChars(capChars: number, acceptedIds = 0): number {
  return Math.min(
    FOOTER_RESERVE_BASE_CHARS + TEAM_FOOTER_RESERVE_CHARS + FOOTER_RESERVE_PER_ID_CHARS * acceptedIds,
    Math.floor(capChars / 2),
  );
}

/** File caps (§15.3.2). The prompt caps are dispatch-args' own. */
export const TASK_JSON_MAX_BYTES = 16 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 64 * 1024 * 1024;

/** Flag value limits (§15.3.1). */
export const WAIT_MAX_SECONDS = 86_400;
export const RECENT_MAX = 50;
export const RECENT_DEFAULT = 10;
export const IDS_MAX = 100;
/** The task id shape — ranAs.isCountedTaskEvent's. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The keys a task object in a task file may have (§15.3.2). */
export const TASK_FILE_KEYS = [
  'title',
  'prompt',
  'prompt_file',
  'system_prompt',
  'system_prompt_file',
  'model',
  'worker',
  'provider',
  'ultrathink',
  'timeout_minutes',
  'detach',
] as const;

/** Exit codes of `cco` (§15.3.3). Nothing else is cco's own answer. */
export const EXIT = {
  ok: 0,
  toolError: 20,
  usage: 21,
  cannotRun: 22,
  waitElapsed: 23,
  signal: 24,
} as const;

/** Exit code of a host that refused to start (its sentence is in the fail file). */
export const HOST_REFUSED_EXIT = 3;

/** JSON-RPC methods on the socket that stdio does not have. */
export const METHOD = {
  hello: 'cco/hello',
  status: 'cco/status',
  cancel: 'cco/cancel',
  recent: 'cco/recent',
  accepted: 'cco/accepted',
  settled: 'cco/settled',
} as const;

/** JSON-RPC error codes of the socket transport. */
export const RPC_ERROR = {
  /** Something other than cco/hello came first. */
  helloFirst: -32002,
  protocolMismatch: -32010,
  wrongSession: -32011,
  /**
   * Team mode (team contract §7.6): a member hello whose credential is not the one the host holds
   * for that LIVE member — or names an unknown team, or a member that is not `running`. The
   * connection is closed after the answer.
   */
  badCredential: -32012,
  /**
   * Team mode: a method this connection's role may not call (the role table: TEAM_OBSERVER_METHODS,
   * TEAM_OBSERVER_TOOLS, TEAM_MEMBER_METHODS), or a hello past a role's connection cap
   * (TEAM_OBSERVER_CONNECTIONS_MAX, TEAM_MEMBER_CONNECTIONS_MAX).
   */
  roleForbidden: -32013,
  /** A line longer than LINE_MAX_BYTES, or not one JSON-RPC object. */
  invalidRequest: -32600,
} as const;

/** One process, as both sides identify it: pid + registry.processStartedAt (epoch ms). */
export interface ProcessIdentity {
  pid: number;
  startedAt: number;
}

/** Do two readings name the same process? Same pid, start times within START_SLACK_MS. */
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && Math.abs(a.startedAt - b.startedAt) <= START_SLACK_MS;
}

/** The start spec the client writes and the host reads once (§15.2.1). */
export interface HostSpec {
  protocol: number;
  session: ProcessIdentity;
  /** Absolute, realpath'd: the session process's cwd. */
  workspace: string;
  /** Absolute: socketPathFor's answer. */
  socket: string;
  /** serverHashOf the server.js the client starts. */
  serverHash: string;
  logPath: string;
  failPath: string;
}

/** The host record `s<P>.json` (§15.1). */
export interface HostRecord {
  protocol: number;
  hostPid: number;
  hostStartedAt: number;
  session: ProcessIdentity;
  workspace: string;
  socket: string;
  serverHash: string;
}

/** cco/hello params (client → host). */
export interface HelloParams {
  protocol: number;
  session: ProcessIdentity;
  serverHash: string;
  clientPid: number;
  /**
   * Team mode (team contract §7.6): the role this connection asks for. ABSENT means `session`,
   * exactly as before team mode, and the session check above is made as it always was. The two
   * other roles have hellos of their own shape — ObserverHelloParams and MemberHelloParams, which
   * carry no `session` claim — so on THIS shape the field is only ever absent or `session`.
   * Across all three shapes it is HostRole.
   */
  role?: 'session';
}

/** cco/hello result (host → client). */
export interface HelloResult {
  protocol: number;
  hostPid: number;
  hostStartedAt: number;
  workspace: string;
  serverHash: string;
  dataRoot: string;
  /**
   * Team mode (team contract §7.6): what this host serves beyond protocol 1's methods —
   * TEAM_FEATURE when it serves the cco/team.* and cco/member.* methods. CONTRACT-AMBIGUITY: §7.6
   * writes `features: string[]`; it is OPTIONAL here because a host of an earlier build sends none
   * (and host.ts / cli.ts build HelloResults without it today), and its absence reads as "no
   * features": such a host answers -32601 to every team method, and a client says so with
   * TEAM_FEATURE_MISSING_SENTENCE.
   */
  features?: string[];
}

/** cco/accepted notification params. `requestId` is the client's own id of the request. */
export interface AcceptedParams {
  requestId: string | number;
  tasks: Array<{ id: string; title: string }>;
}

/** cco/settled notification params. */
export interface SettledParams {
  requestId: string | number;
  id: string;
  status: 'done' | 'error';
}

/** cco/status params. */
export interface StatusParams {
  ids: string[];
  waitSeconds: number;
}

/** A text answer, as tools/call answers — cco/status adds `pending`. */
export interface TextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  /** cco/status only: the ids still queued or running when it answered. */
  pending?: string[];
  /**
   * Team mode (team contract §4.4 item 2, L9) — T1 ADDITION (CONTRACT-AMBIGUITY: the contract pins
   * WHERE the footer is printed, not how it travels): the unread-team-messages line
   * (`Unread team messages for you: <n> (from <senders>) — read them: …`), when this host's team
   * has unread messages for the lead. Carried BESIDE the text, never inside it, because the client
   * cuts a long text (§15.3.4) and this line must survive every cut: the client prints it as the
   * LAST line of stdout, inside FOOTER_RESERVE (which TEAM_FOOTER_RESERVE_CHARS enlarges for it).
   * Absent when there is nothing unread, and on every answer of a host without TEAM_FEATURE.
   */
  footer?: string;
}

/** cco/cancel params. */
export interface CancelParams {
  ids: string[];
}

/** cco/recent params. */
export interface RecentParams {
  limit: number;
}

/** The run directory, under the data root. */
export function runDirOf(dataRoot: string): string {
  return path.join(dataRoot, 'run');
}

/** The files of the host of session pid `pid` in `runDir` (§15.1), the socket aside. */
export function hostFilesOf(runDir: string, pid: number): {
  record: string;
  lock: string;
  fail: string;
  log: string;
  spec: string;
} {
  const base = path.join(runDir, `s${pid}`);
  return {
    record: `${base}.json`,
    lock: `${base}.lock`,
    fail: `${base}.fail`,
    log: `${base}.log`,
    spec: `${base}.spec.json`,
  };
}

/** The longest socket path used (macOS sun_path holds 104 bytes with its terminator). */
export const SOCKET_PATH_MAX_BYTES = 100;

/**
 * The socket of the host of session pid `pid` — THE one rule (§15.1). `<run dir>/s<pid>.sock`
 * when that fits SOCKET_PATH_MAX_BYTES; else `<tmp>/cco-<uid>/<8 hex of sha256(runDir)>-s<pid>.sock`
 * (the hash keeps two data roots apart). Undefined when even that does not fit. `fallbackDir` is
 * the directory the caller must check (0700, the uid's, not a symlink) before using a fallback
 * path; undefined when the run-dir path is used.
 */
export function socketPathFor(
  runDir: string,
  pid: number,
  uid: number,
  tmp = '/tmp',
): { socket: string; fallbackDir: string | undefined } | undefined {
  const direct = path.join(runDir, `s${pid}.sock`);
  if (Buffer.byteLength(direct, 'utf8') <= SOCKET_PATH_MAX_BYTES) {
    return { socket: direct, fallbackDir: undefined };
  }
  const fallbackDir = path.join(tmp, `cco-${uid}`);
  const tag = createHash('sha256').update(runDir, 'utf8').digest('hex').slice(0, 8);
  const socket = path.join(fallbackDir, `${tag}-s${pid}.sock`);
  if (Buffer.byteLength(socket, 'utf8') > SOCKET_PATH_MAX_BYTES) {
    return undefined;
  }
  return { socket, fallbackDir };
}

/** serverHash: the first 12 hex of sha256 of a server.js file's bytes. */
export function serverHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/* ========================================================================= *
 * TEAM MODE — contract-team-mode-v2.md §7.6. Additive: PROTOCOL_VERSION stays 1.
 * ========================================================================= */

/*
 * WHAT IS HERE, AND WHY HERE. Everything a FRONT END needs to talk to a dispatch host about a
 * team, and to read a team's files when no host is up (§2.4 L7, §8): the identity shapes, the
 * method names, the roles and what each may call, the records that cross the socket (the state
 * projection, board tasks, the log events an observer is sent, activity items), the observer
 * limits, and the layout of a team's directory. Gilde's sidecar vendors THIS file together with
 * host-client.ts (§8: two files, kept equal by a copy test in both repositories), so this block
 * is self-contained like the rest of the file: Node built-ins only, and no import — not even of
 * a type — from any other module of this repository.
 *
 * src/team/contract.ts re-exports every name below and adds what only the engine needs.
 * CONTRACT-AMBIGUITY: §12 says "the ones front ends need re-exported from host-protocol.ts" while
 * §7.6 DEFINES them here (`export const TEAM_ID = …`) and §8 has Gilde vendor this file without
 * contract.ts — so they are defined here, where the vendored copy can see them, and contract.ts
 * takes them from here (the same holds for the wire records). Nothing here may be defined a second
 * time over there — a constant written twice is two constants.
 *
 * Every record below is DATA from another process: a host or a front end that reads one checks it
 * by value before it relies on it (TEAM_ID, MEMBER_NAME, … are the shapes), and renders every
 * string of it flattened and capped (the uiTypes rule 1 of §8).
 */

/** In HelloResult.features when the host serves the cco/team.* and cco/member.* methods. */
export const TEAM_FEATURE = 'team-1';
/** A team id (§2.1): `tm` + base36(Date.now()) + 4 random base36. */
export const TEAM_ID = /^tm[0-9a-z]{9,20}$/;
/** A team name (MD-1): unique among the repository's non-ended teams. */
export const TEAM_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A member name (§2.1): unique in its team for the team's whole life, never in RESERVED_NAMES. */
export const MEMBER_NAME = /^[a-z][a-z0-9-]{0,23}$/;
/** A board task id (MD-5): `b<n>`, n decimal from 1. */
export const BOARD_ID = /^b[1-9][0-9]{0,4}$/;
/** A message id (MD-4): `m<seq>` — the `seq` of the message's `msg.posted` event. */
export const MESSAGE_ID = /^m[1-9][0-9]{0,8}$/;
/** Names no member may have (MD-3): the protocol's own addresses and words. */
export const RESERVED_NAMES = [
  'lead',
  'user',
  'all',
  'team',
  'system',
  'host',
  'engine',
  'cco',
  'me',
  'any',
  'none',
  'everyone',
] as const;
/**
 * `<teamId>:<name>:<incarnation>` in the environment of every team turn process and take-over
 * terminal (§3.9). Never scrubbed, like DISPATCHED_TASK_ENV. `cco` checks it FIRST and refuses
 * every operation but help/version under it (exit 22).
 */
export const TEAM_MEMBER_ENV = 'CCO_TEAM_MEMBER';
/** M16: the member's port base (TEAM_PORT_BASE + TEAM_PORT_STRIDE × index) in every turn process. */
export const TEAM_PORT_BASE_ENV = 'CCO_TEAM_PORT_BASE';
/** cli.js argv[2] that starts the team MCP server; argv[3] is the member's tool-spec path. */
export const TEAM_MCP_ARG = '--team-mcp';
/** The team MCP server's name: Claude sees its tools as `mcp__cco_team__<tool>`. */
export const TEAM_MCP_SERVER_NAME = 'cco_team';
/**
 * The lead's team operations as `tools/call` names — on a SESSION connection of a host, only
 * (§7.5: the stdio server never lists them and answers a call of one isError with the sentence of
 * team/contract TEAM_TEXT.teamOpsStdio). The eleventh operation, `team_wait`, is the held method
 * METHOD_TEAM.wait, not a tool.
 */
export const TEAM_OPS = [
  'team_create',
  'team_add',
  'team_send',
  'team_inbox',
  'team_status',
  'team_task',
  'team_member',
  'team_attach',
  'team_end',
  'team_resume',
] as const;
/** One of TEAM_OPS. */
export type TeamOp = (typeof TEAM_OPS)[number];
/**
 * H1/MD-55: the most an observer connection may have queued (socket.writableLength). host.ts
 * enforces it inside TeamConnections.push: a lossy notification over it is dropped; a non-lossy
 * one closes the connection.
 */
export const TEAM_OBSERVER_OUTBOUND_MAX_BYTES = 4 * 1024 * 1024;
/**
 * H2: the hard cap on suspending a team when the lead session ends (server.ts shutdown() waits
 * for TeamEngine.suspendAll at most this long, on its own timer).
 */
export const TEAM_SUSPEND_BUDGET_MS = 30_000;

/** The line a client prints when the host's HelloResult.features lacks TEAM_FEATURE (§7.6). */
export const TEAM_FEATURE_MISSING_SENTENCE =
  "this session's dispatch host is an earlier build without teams — start a new Claude Code session";

/* ---- roles and hellos ---- */

/**
 * The role of a connection (§7.6). `session`: the `cco` client of the session the host serves —
 * its hello is checked exactly as before team mode. `observer`: a front end (VS Code, Gilde) —
 * any process of this user (§15.12 L4), hello WITHOUT the session check (H1). `member`: a team
 * MCP server — identified ONLY by the credential its hello presents (I5).
 */
export type HostRole = 'session' | 'observer' | 'member';
/** The front ends an observer hello may name. */
export const TEAM_OBSERVER_CLIENTS = ['vscode', 'gilde', 'other'] as const;
/** One of TEAM_OBSERVER_CLIENTS. */
export type TeamObserverClient = (typeof TEAM_OBSERVER_CLIENTS)[number];

/** cco/hello params of an observer (§7.6): no `session` claim, nothing about the session is checked. */
export interface ObserverHelloParams {
  protocol: number;
  role: 'observer';
  client: TeamObserverClient;
  clientPid: number;
}

/**
 * cco/hello params of a team MCP server (§3.7): sent BEFORE it answers `initialize`. The host
 * compares sha256(credential) with the one it holds for that LIVE member (crypto.timingSafeEqual);
 * a mismatch, an unknown team, or a member that is not `running` → RPC_ERROR.badCredential and
 * the connection is closed.
 */
export interface MemberHelloParams {
  protocol: number;
  role: 'member';
  teamId: string;
  member: string;
  /** 64 lowercase hex, read from the member's credential file — never from an environment variable. */
  credential: string;
  clientPid: number;
}

/** Any cco/hello params: a session's (role absent or `session`), an observer's or a member's. */
export type AnyHelloParams = HelloParams | ObserverHelloParams | MemberHelloParams;

/* ---- methods ---- */

/** The team methods and notifications (§7.6), spelled once. */
export const METHOD_TEAM = {
  // session role (cco)
  /** {waitSeconds: 1..86400, settleSeconds: 0..300, capChars} → TeamWaitResult; HELD. */
  wait: 'cco/team.wait',
  // observer (and session) role — the read-only subset (Gilde uses ONLY list, get, subscribe + files, §8.2)
  list: 'cco/team.list',
  get: 'cco/team.get',
  subscribe: 'cco/team.subscribe',
  unsubscribe: 'cco/team.unsubscribe',
  // observer (and session) role — the rest (VS Code)
  activityTail: 'cco/team.activityTail',
  messageBody: 'cco/team.messageBody',
  turnText: 'cco/team.turnText',
  send: 'cco/team.send',
  task: 'cco/team.task',
  member: 'cco/team.member',
  takeover: 'cco/team.takeover',
  attached: 'cco/team.attached',
  release: 'cco/team.release',
  end: 'cco/team.end',
  markRead: 'cco/team.markRead',
  // member role
  /** role: 'member' (MemberHelloParams). */
  memberHello: 'cco/hello',
  memberCall: 'cco/member.call',
  // notifications host → client
  event: 'cco/team.event',
  activity: 'cco/team.activity',
  host: 'cco/team.host',
} as const;

/** `ping`: answered for every role. */
export const PING_METHOD = 'ping';

/**
 * The observer methods: what an `observer` connection may call besides `ping` and
 * TEAM_OBSERVER_TOOLS. A `session` connection may call every one of them too, as well as
 * everything it could call before team mode, `tools/call` of TEAM_OPS, and METHOD_TEAM.wait.
 * Anything else from an observer → RPC_ERROR.roleForbidden.
 */
export const TEAM_OBSERVER_METHODS = [
  METHOD_TEAM.list,
  METHOD_TEAM.get,
  METHOD_TEAM.subscribe,
  METHOD_TEAM.unsubscribe,
  METHOD_TEAM.activityTail,
  METHOD_TEAM.messageBody,
  METHOD_TEAM.turnText,
  METHOD_TEAM.send,
  METHOD_TEAM.task,
  METHOD_TEAM.member,
  METHOD_TEAM.takeover,
  METHOD_TEAM.attached,
  METHOD_TEAM.release,
  METHOD_TEAM.end,
  METHOD_TEAM.markRead,
] as const;
/** The one `tools/call` an observer may make (§7.6). */
export const TEAM_OBSERVER_TOOLS = ['list_workers'] as const;

/* ---- list_workers' structured answer (Gilde plan #3c, frozen 2026-10-16) ----
 *
 * WHY: a front end that is not this extension (Gilde) shows the worker accounts, their plan
 * windows, cooldowns and login state — and must DISPLAY what the engine knows, never compute it
 * (no second quota/selection implementation). The text answer is prose for a model; this is the
 * same facts as data.
 *
 * RULES (binding on server.ts and every reader):
 *  - A successful `tools/call list_workers` answers `{ content: [{type:'text', text}],
 *    structuredContent: WorkersSnapshot }`. The text is BYTE-IDENTICAL to what it was before this
 *    addition (stdio and host alike). An unreadable registry stays `isError: true` with text
 *    only — no `structuredContent` (absent = "no snapshot", never an empty one).
 *  - `accounts` is built by the SAME builder as the dashboard's `DashboardModel.accounts`
 *    (src/uiModel.ts), from the same readings the text was built from in this call — so the
 *    text, the dashboard and Gilde never disagree about one account at one moment. Every cap and
 *    clamp of UiAccount applies (strings bounded, percents 0–100, times epoch ms or null).
 *  - THE HOST ENFORCES THE POLL FLOOR (a reader's floor alone is a promise a buggy reader breaks,
 *    and each refresh may start real vendor probes): an OBSERVER call within
 *    WORKERS_SNAPSHOT_MIN_POLL_MS of the host's last completed list_workers answer gets THAT answer
 *    again (text + structuredContent, its original `generatedAt`), starting nothing. SESSION calls
 *    (the lead model) are not floored. Every caller shares SINGLE-FLIGHT refreshes: while a usage
 *    or provider refresh is in flight, a concurrent call awaits the same one — at most one probe
 *    per account at a time, whatever the number of connections. Readers also poll no more often
 *    than the floor; a user's "refresh" in a front end is just a call (the host may answer cached).
 *    The cached answer is also INVALIDATED by a known state change — a registry change (worker
 *    added/removed/edited), a login change, a cooldown set or cleared by a dispatch outcome — keyed
 *    on a generation counter: a changed generation means one fresh build (still single-flight).
 *    The floor keys on the CALLER'S ROLE as the host knows it on the connection; a lead (session)
 *    call is never answered from the observer cache (a stale cooldown/login misleads its choice).
 *  - Answers to a front end's questions (Gilde, 2026-10-16), binding:
 *    · An `isError` text answer gets the same `~` redaction as the snapshot.
 *    · Caps beyond UiAccount's own doc: `key` ≤ 128 chars, `overage.spendLabel` ≤ 40, each
 *      `sameAccountAs` name ≤ 64 (≤ 8 names), `windows` ≤ 8 per account, `accounts` ≤ 200.
 *    · A NEW value of `login`, a window `kind` or `severity` is ADDITIVE (same schema): readers show
 *      an unknown login as an error naming the value, an unknown kind as 'other', an unknown
 *      severity as 'normal'.
 *    · `cooldownUntil` is null when it is not after `generatedAt` (readers guard as well).
 *    · `servedFromCache` (additive, boolean): true when the host answered from its observer cache.
 *    · The login-failure marker string is exported from uiTypes.ts (RUN_LOGIN_FAILURE_DETAIL) so a
 *      vendoring front end can localize it without copying a literal.
 *    · Which session answered is the connection's host; the snapshot does not repeat it.
 *  - Free text in the snapshot (`lastError`, `loginDetail`, labels) has the user's home directory
 *    replaced by `~` (snapshot only; the dashboard is unchanged). Docs, screenshots and README
 *    images of any front end use a FIXTURE snapshot, never a live one.
 *  - Vendored copies of this file (and uiTypes.ts) in other repositories record the commit they
 *    were copied from and carry a check that they are byte-identical to it, plus a test that a
 *    `schema` they do not know is shown as "host newer/older", not parsed.
 *  - `schema` changes only incompatibly; additive fields keep it. A reader refuses a schema it
 *    does not know and shows "this dispatch host is newer/older than this front end".
 *  - Observers get exactly the session's answer (TEAM_OBSERVER_TOOLS); a host that predates this
 *    addition answers without `structuredContent` — a reader says so, it does not parse the text.
 */
export const WORKERS_SNAPSHOT_SCHEMA = 'cco.workers/1' as const;
/** Front ends poll list_workers no more often than this (it may start usage probes). */
export const WORKERS_SNAPSHOT_MIN_POLL_MS = 60_000;
export interface WorkersSnapshot {
  schema: typeof WORKERS_SNAPSHOT_SCHEMA;
  /** Epoch ms of the answer. */
  generatedAt: number;
  /** 'main' (this session's own account, when known) first, then every registered worker in registry order — DashboardModel.accounts' order. */
  accounts: UiAccount[];
  /** Registry entries this version cannot use (≤ 20), as the dashboard shows them. */
  unsupportedAccounts: UiUnsupportedAccount[];
  /** True when the host answered from its observer cache (the poll floor); false for a fresh build. */
  servedFromCache?: boolean;
  /** The operator's billing guards as this host reads them (only the literal 'allow' is 'allow'). */
  guards: { overageWorkerDispatch: 'allow' | 'block'; frontierWorkerDispatch: 'allow' | 'block' };
}
/** What a `member` connection may call (§7.6); anything else → RPC_ERROR.roleForbidden. */
export const TEAM_MEMBER_METHODS = [PING_METHOD, METHOD_TEAM.memberCall] as const;
/** The read-only subset Gilde's preview uses (S1-2, §8.2). */
export const TEAM_READ_ONLY_METHODS = [METHOD_TEAM.list, METHOD_TEAM.get, METHOD_TEAM.subscribe] as const;
/**
 * The observer methods that work for EVERY team of the host's repository — read from disk when
 * this host does not own the team (§7.6). Every other observer method needs the team this host
 * owns, else a TeamRefusal with code `not_owned_here`. `cco/team.list` takes no team.
 */
export const TEAM_ANY_TEAM_METHODS = [
  METHOD_TEAM.get,
  METHOD_TEAM.activityTail,
  METHOD_TEAM.messageBody,
  METHOD_TEAM.turnText,
] as const;
/**
 * HELD requests (H1): answered only when the engine decides (a wake, a deadline, an unsubscribe,
 * a replacement). host.ts keeps their host id mapped (`inFlight > 0`) until they are answered,
 * and closeIfIdle never closes a connection that holds one.
 */
export const TEAM_HELD_METHODS = [METHOD_TEAM.wait, METHOD_TEAM.subscribe] as const;

/* ---- observer limits (§7.6, §12) ---- */

/** Observer connections per host; one more → RPC_ERROR.roleForbidden. */
export const TEAM_OBSERVER_CONNECTIONS_MAX = 16;
/** Member connections per member; one more → RPC_ERROR.roleForbidden. */
export const TEAM_MEMBER_CONNECTIONS_MAX = 4;
/** cco/team.subscribe replays at most this many events after `fromSeq`; more → `resnapshot_required`. */
export const TEAM_SUBSCRIBE_REPLAY_MAX = 5_000;
/** cco/team.activity notifications are coalesced over this window … */
export const TEAM_ACTIVITY_COALESCE_MS = 100;
/** … and each carries at most this many bytes of items. */
export const TEAM_ACTIVITY_NOTIFY_MAX_BYTES = 64 * 1024;
/** cco/team.activityTail `limit`: 1 … this. */
export const TEAM_ACTIVITY_TAIL_MAX = 500;
/** cco/team.turnText reads at most this many bytes per call (§7.6); a front end reading files directly keeps to it too (§8.2). */
export const TEAM_TURN_TEXT_MAX_BYTES = 1024 * 1024;
/** cco/team.list answers at most this many teams, newest first. */
export const TEAM_LIST_MAX = 50;
/** A front end scans at most this many `teams/*` directories (§7.6). */
export const TEAM_DIR_SCAN_MAX = 200;

/* ---- records that cross the socket (§2.3, §2.4, §3.8, §5.1) ---- */

/** The four providers a member can run on (§2.4). Equal to providers.ProviderId — team/contract.ts asserts it at compile time. */
export const TEAM_PROVIDERS = ['claude', 'codex', 'cursor', 'gemini'] as const;
/** One of TEAM_PROVIDERS. */
export type TeamProviderId = (typeof TEAM_PROVIDERS)[number];

/** A team's status (§2.1, §2.4). `ended` is terminal; `readonly`: the log is full; `damaged`: the log cannot be read (I10). */
export const TEAM_STATUSES = ['active', 'suspended', 'ended', 'readonly', 'damaged'] as const;
/** One of TEAM_STATUSES. */
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** A member's state (MD-58, Appendix B). */
export const MEMBER_STATES = [
  'starting',
  'idle',
  'running',
  'pausing',
  'paused',
  'attach_pending',
  'attached',
  'blocked',
  'stopped',
  'ended',
] as const;
/** One of MEMBER_STATES. */
export type MemberStateName = (typeof MEMBER_STATES)[number];

/** Why a member is `blocked` — the COMPLETE list (M20). */
export const BLOCKED_CODES = [
  'quota',
  'login',
  'account-removed',
  'crash',
  'context',
  'resume',
  'worktree',
  'worktree-missing',
  'worktree-branch',
  'setup',
  'cap',
  'memory',
  'cli',
  'error',
  'unknown-turn',
] as const;
/** One of BLOCKED_CODES. */
export type BlockedCode = (typeof BLOCKED_CODES)[number];
/**
 * MemberState.reason.code: a BlockedCode while `blocked`; `budget` while `idle` over a turn budget
 * (M20); `quota-wait` while `paused` for a quota reset (§6.5 step 2); `cancelled` while `paused`
 * after a turn was stopped from outside the engine (M8).
 */
export type MemberReasonCode = BlockedCode | 'budget' | 'quota-wait' | 'cancelled';

/** §3.7: how a member reaches the team — its tools, only its turns, or not yet known. */
export const MEMBER_MAILBOX = ['tools', 'turns-only', 'unverified'] as const;
/** One of MEMBER_MAILBOX. */
export type MemberMailbox = (typeof MEMBER_MAILBOX)[number];

/** TeamState.warnings kinds (§2.4). */
export const TEAM_WARNING_KINDS = [
  'overlap',
  'budget',
  'blocked',
  'idle',
  'attach',
  'store',
  'mailbox',
  'context-lost',
  'stash',
  'inbox',
] as const;
/** One of TEAM_WARNING_KINDS. */
export type TeamWarningKind = (typeof TEAM_WARNING_KINDS)[number];

/**
 * One member in the projection (§2.4) — display-safe: no config dir, no prompt text, no
 * credential, no environment value.
 */
export interface MemberState {
  name: string;
  /** 1-based position in `member.added` order — the port base's index (§3.3). */
  index: number;
  role: string;
  state: MemberStateName;
  reason?: { code: MemberReasonCode; text: string; until?: number };
  provider: TeamProviderId;
  /** The registry worker's name. */
  worker: string;
  /** What every surface shows for the account: the worker's name, or `Cursor (machine login)` / `Antigravity (machine login)` (§6.2 step 4). */
  accountLabel: string;
  /** The account is the machine's one login of a single-login provider (Cursor, Antigravity). */
  machineLogin: boolean;
  /** The member runs on the lead's own account (MD-48; roster note `shares the lead's plan`). */
  sharesLeadPlan: boolean;
  /** Its turns bill overage past an exhausted plan window (roster note `billing overage`). */
  billableOverage: boolean;
  /** M4: whether its permission grant lets it run shell commands. */
  runsCommands: boolean;
  /** S3(b): the per-vendor setting that elevates it is on (the roster says so). */
  elevated?: 'cursor-force' | 'agy-skip-permissions';
  /** The model asked for ('' = the CLI's default, never for Codex). */
  model: string;
  /** The model the CLI reported it ran, when it did. */
  modelUsed?: string;
  incarnation: number;
  /** The first 8 characters of the conversation id. */
  conversationShort?: string;
  mailbox: MemberMailbox;
  /**
   * T1 ADDITION (CONTRACT-AMBIGUITY): the `member.mailbox` reason while `mailbox` is `turns-only`
   * — e.g. `agy approvals` — which the roster prints (`turns-only (agy approvals)`, §7.4) and
   * §2.4 has no field for.
   */
  mailboxReason?: string;
  /** M16: TEAM_PORT_BASE + TEAM_PORT_STRIDE × index. */
  portBase: number;
  worktree: {
    path: string;
    branch: string;
    baseCommit: string;
    ready: boolean;
    headSha?: string;
    ahead?: number;
    filesChanged?: number;
    dirty?: boolean;
    merged?: boolean;
  };
  /** The running turn (only while `running`; L7: believed only with a live owner). */
  turn?: { id: string; n: number; startedAt: number; pid?: number; lastOutputAt?: number };
  turns: number;
  tokens: { in: number; out: number };
  costUsd: number | null;
  lastInputTokens?: number;
  /** `head` ≤ 200 chars. */
  lastTurn?: { id: string; n: number; outcome: string; endedAt: number; head: string };
  /** Undelivered messages for it. */
  pending: number;
  /** Board ids it holds (claimed / blocked / review). */
  tasks: string[];
  peerWakes: number;
  rssMb?: number;
  attach?: { lease: string; pid?: number; client: string; since: number };
  /** `text` ≤ 200 chars. */
  lastActivity?: { ts: number; text: string };
}

/**
 * `state.json` — the projection front ends read when the host is down (§2.4): rewritten atomically
 * after each applied batch, at most STATE_MAX bytes, display-safe values only. Believe `active`
 * and every `running`/`attached` member only per L7 (teamOwnerIsLive).
 */
export interface TeamState {
  v: 1;
  id: string;
  name: string;
  title: string;
  status: TeamStatus;
  damagedReason?: string;
  /**
   * T1 ADDITION (CONTRACT-AMBIGUITY): the team's goal text (≤ GOAL_MAX bytes). §2.4 has no field
   * for it, yet Gilde's preview header shows the goal (§8.2) and reads nothing that holds it.
   */
  goal?: string;
  workspace: string;
  repoRoot: string;
  leadRel: string;
  baseCommit: string;
  createdAt: number;
  endedAt?: number;
  /** The seq of the last event applied. */
  seq: number;
  owner: { hostPid: number; hostStartedAt: number; session: { pid: number; startedAt: number } } | null;
  /** M13: `wakesToday` counts team_wait wakes since local midnight. */
  lead: { unread: number; readSeq: number; waiter: boolean; lastCallAt: number | null; wakesToday: number };
  user: { unread: number; readSeq: number };
  members: MemberState[];
  board: BoardTask[];
  budgets: { turnsToday: number; turnsPerDay: number; running: number; maxRunning: number; pingPongTripped: boolean };
  totals: { turns: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  warnings: Array<{ kind: TeamWarningKind; text: string }>;
}

/** A board task's state (§5.1). `cancelled` is terminal. */
export const TASK_STATES = ['open', 'claimed', 'blocked', 'review', 'done', 'cancelled'] as const;
/** One of TASK_STATES. */
export type TaskState = (typeof TASK_STATES)[number];

/** A board task (§5.1). A board task is NOT a task-log entry (§5.6). */
export interface BoardTask {
  /** `b<n>`. */
  id: string;
  /** 1 … 120 chars, one line (flattenOneLine + sliceOneLine). */
  title: string;
  /** ≤ 65,536 UTF-8 bytes. Held inline up to BOARD_BODY_INLINE; a longer body lives in `bodyFile`. */
  body?: string;
  /**
   * T1 ADDITION (CONTRACT-AMBIGUITY): when the body is over BOARD_BODY_INLINE (8 KiB) it "lives in
   * bodies/b<n>.md" (§5.1) — this is that file, relative to the team directory, and `body` is then
   * absent. Without it a reader of the record could not tell a long body from none.
   */
  bodyFile?: string;
  state: TaskState;
  /** A member name; set ⇔ state ∈ {claimed, blocked, review}; kept on done (who did it). */
  assignee?: string;
  /** 0 … 32 ownership paths (§5.3). */
  paths: string[];
  allowOverlap: boolean;
  createdBy: 'lead' | 'user';
  createdAt: number;
  /** The last status note ≤ 2,048 bytes (block reason, rework note). */
  note?: string;
  /** `file`: `bodies/b<n>-r<k>.md`, relative to the team directory. */
  reports: Array<{ at: number; by: string; file: string }>;
  /** Checkpoint shas attributed to it (§9.2). */
  commits: string[];
  /** Task-log ids of the turns that carried its messages (≤ 200). */
  turns: string[];
  updatedAt: number;
  /** `lead` | `user` | a member name | `engine`. */
  updatedBy: string;
}

/** The kinds of an activity item (§3.8). */
export const FEED_KINDS = ['turn', 'text', 'tool', 'usage', 'error', 'done', 'notice'] as const;
/** One of FEED_KINDS. */
export type FeedKind = (typeof FEED_KINDS)[number];

/**
 * One activity item (§3.8): a line of `members/<name>/feed.jsonl`, an item of cco/team.activity
 * and of cco/team.activityTail. Display only — never used for a decision, never a raw vendor
 * payload beyond `d`.
 */
export interface FeedItem {
  ts: number;
  /**
   * The turn it belongs to: its task-log id (`t…`). CONTRACT-AMBIGUITY: §3.8 writes only `turn`;
   * the id (not the member's turn number) is what links an item to `tasks/<turnId>.md`.
   */
  turn: string;
  k: FeedKind;
  /** Text, ≤ 2 KiB; text deltas coalesced over 100 ms. */
  s?: string;
  /** A tool name, ≤ 64 chars. */
  tool?: string;
  /** A one-line detail, ≤ 200 chars, flattened. */
  d?: string;
}

/* ---- the log events an observer is sent (§2.3; cco/team.event) ---- */

/** Who wrote an event (§2.3): `engine`, `lead`, `user` or `member:<name>`. */
export type TeamEventBy = 'engine' | 'lead' | 'user' | `member:${string}`;

/** The common fields of every log event (§2.3): `seq` strictly increasing from 1, no gaps; `ts` display only. */
export interface TeamEventEnvelope {
  v: 1;
  seq: number;
  ts: number;
  by: TeamEventBy;
}

/** What started a turn (§2.3 `turn.planned.trigger`). */
export const TURN_TRIGGERS = ['brief', 'message', 'urgent', 'continue', 'packet', 'rebrief'] as const;
/** One of TURN_TRIGGERS. */
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

/** How a turn ended (§3.3 TurnOutcome.outcome, `turn.ended.outcome`). */
export const TURN_OUTCOMES = [
  'ok',
  'error',
  'quota',
  'auth',
  'timeout',
  'interrupted',
  'crashed',
  'cancelled',
  'context',
  'resume-failed',
  'memory',
] as const;
/** One of TURN_OUTCOMES. */
export type TurnOutcomeKind = (typeof TURN_OUTCOMES)[number];

/**
 * Why an `interrupted` turn was stopped — `turn.ended … reason=<this>`. The contract spells
 * `lead-ended`, `engine-restart`, `cancel` and `takeover` (§2.5, §3.4, §3.10); the others are the
 * remaining stops of §3.5 (an urgent message, pause --now, stop, team end, team_member
 * --interrupt). CONTRACT-AMBIGUITY: §2.3 lists no `reason` field on `turn.ended`; the text of
 * §2.5/§3.4/§3.10 writes one.
 */
export const TURN_END_REASONS = [
  'urgent',
  'pause',
  'stop',
  'end',
  'interrupt',
  'lead-ended',
  'engine-restart',
  'takeover',
  'cancel',
] as const;
/** One of TURN_END_REASONS. */
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

/** Why an incarnation was routed (§2.3 `member.routed.cause`). */
export const ROUTE_CAUSES = ['initial', 'failover', 'switch', 'refresh', 'resume'] as const;
/** One of ROUTE_CAUSES. */
export type RouteCause = (typeof ROUTE_CAUSES)[number];

/** Message kinds (MD-15). */
export const MESSAGE_KINDS = ['text', 'question', 'answer', 'assignment', 'report', 'notice'] as const;
/** One of MESSAGE_KINDS. */
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** The kinds a sender (lead, user, member) may choose; `assignment`, `report` and `notice` are the engine's. */
export const SENDER_MESSAGE_KINDS = ['text', 'question', 'answer'] as const;
/** One of SENDER_MESSAGE_KINDS. */
export type SenderMessageKind = (typeof SENDER_MESSAGE_KINDS)[number];
/** Where a message came from (§2.3 `msg.posted.source`). */
export const MESSAGE_SOURCES = ['cco', 'tool', 'report', 'engine', 'frontend'] as const;
/** One of MESSAGE_SOURCES. */
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/**
 * T1 ADDITION (CONTRACT-AMBIGUITY): what an engine `notice` is about. M11 makes waking depend on a
 * notice's kind (WAKE_NOTICE_KINDS) and §8.1 notifies the user per kind, but §2.3's `msg.posted`
 * has no field that carries it — `msg.posted.notice` is that field.
 */
export const NOTICE_KINDS = [
  // wake-worthy (M11)
  'blocked',
  'idle',
  'mailbox',
  'budget',
  'context-lost',
  'suspended',
  // the rest wait in the inbox and are counted by the footer
  'overlap',
  'store',
  'board',
  'message',
  'stash',
  'checkpoint',
  'turn',
  'routing',
  'attach',
  'expired',
  'inbox',
] as const;
/** One of NOTICE_KINDS. */
export type NoticeKind = (typeof NOTICE_KINDS)[number];
/** M11: the notice kinds that wake the lead's team_wait. */
export const WAKE_NOTICE_KINDS = ['blocked', 'idle', 'mailbox', 'budget', 'context-lost', 'suspended'] as const;

/** `budget.tripped.kind`. Only `pingpong` is spelled by the contract (§3.5.1); the others name the budgets of §3.5. */
export const BUDGET_KINDS = ['pingpong', 'peer-wakes', 'turns-per-day', 'turns-per-hour'] as const;
/** One of BUDGET_KINDS. */
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** `member.added.spec` (§2.3). */
export interface MemberSpecRecord {
  provider?: TeamProviderId;
  worker?: string;
  model?: string;
  paths: string[];
  /**
   * CONTRACT-AMBIGUITY: §2.3 types this `start?: boolean`, but the spec's `start` is "a string ≤
   * 16,384 bytes replacing the first-turn kickoff sentence, or false" (§7.3) — the string must be
   * kept to compose the first turn, so it is recorded as given.
   */
  start?: string | false;
}

/**
 * The header facts of a `kind: report` message (§3.6.2: `turn <n> · <outcome> · <duration> ·
 * <in>k/<out>k tokens · tasks <ids>`), carried by `msg.posted.report` — a T1 ADDITION, because the
 * lead's inbox prints this header (§4.4) and §2.3's `msg.posted` has no field for it.
 */
export interface ReportMeta {
  turnId: string;
  n: number;
  outcome: TurnOutcomeKind;
  durationMs: number;
  tokens: { in: number; out: number };
  /** The board ids the member held. */
  tasks: string[];
}

/** `team.created`. */
export interface TeamCreatedBody {
  type: 'team.created';
  name: string;
  title: string;
  workspace: string;
  repoRoot: string;
  commonDir: string;
  baseCommit: string;
  /** The lead's workspace relative to repoRoot; '' at the root (M6). */
  leadRel: string;
  /**
   * `{bytes, file?}` in §2.3. CONTRACT-AMBIGUITY: the goal text must live somewhere — inline in
   * `text` when it is at most BODY_INLINE bytes, else in `file` (`bodies/goal.md`, relative to the
   * team directory). Exactly one of `text` / `file`.
   */
  goal: { bytes: number; text?: string; file?: string };
}
/** `team.status`. */
export interface TeamStatusBody {
  type: 'team.status';
  status: TeamStatus;
  reason: string;
}
/** `lease.acquired` — `tookOver` when a stale lease was taken (H4). */
export interface LeaseAcquiredBody {
  type: 'lease.acquired';
  hostPid: number;
  hostStartedAt: number;
  session: ProcessIdentity;
  tookOver?: { oldHostPid: number };
}
/** `lease.released`. */
export interface LeaseReleasedBody {
  type: 'lease.released';
  reason: string;
}
/** `member.added`. The lead's brief itself is in `members/<name>/assignment.md` (T1, see team/contract). */
export interface MemberAddedBody {
  type: 'member.added';
  name: string;
  index: number;
  role: string;
  briefBytes: number;
  spec: MemberSpecRecord;
}
/**
 * `member.routed` AS AN OBSERVER RECEIVES IT. CONTRACT-AMBIGUITY: cco/team.event carries "every log
 * event", yet §2.1 keeps the account binding private. The log's own event also holds `accountKey` — the
 * worker's config dir verbatim for Claude/Codex — which is private to the log (§2.1: "state.json
 * shows worker and machineLogin, never a path"), so it is not sent (team/contract.wireEventOf).
 */
export interface MemberRoutedBody {
  type: 'member.routed';
  name: string;
  incarnation: number;
  provider: TeamProviderId;
  worker: string;
  model: string;
  modelSource: 'dispatch' | 'worker' | 'cli';
  /** ≤ 300 chars. */
  reason: string;
  cause: RouteCause;
}
/** `member.worktree.planned` — write-ahead, durable before any git call (H6). */
export interface MemberWorktreePlannedBody {
  type: 'member.worktree.planned';
  name: string;
  path: string;
  branch: string;
  baseCommit: string;
}
/** `member.worktree` — ready. */
export interface MemberWorktreeBody {
  type: 'member.worktree';
  name: string;
  path: string;
  branch: string;
  baseCommit: string;
  /** The member's cwd: the worktree ROOT, always (M6). */
  cwd: string;
}
/** `member.conversation` — `replaced` = the id the vendor silently abandoned (context-lost, §3.3). */
export interface MemberConversationBody {
  type: 'member.conversation';
  name: string;
  incarnation: number;
  conversationId: string;
  replaced?: string;
}
/** `member.state` — `reason.text` ≤ 300 chars, flattened. */
export interface MemberStateBody {
  type: 'member.state';
  name: string;
  state: MemberStateName;
  reason?: { code: MemberReasonCode; text: string; until?: number };
}
/** `member.mailbox` (§3.7). */
export interface MemberMailboxBody {
  type: 'member.mailbox';
  name: string;
  mailbox: 'tools' | 'turns-only';
  reason: string;
}
/** `member.process` — the write-before-spawn companion of `turn.running`. */
export interface MemberProcessBody {
  type: 'member.process';
  name: string;
  turnId: string;
  pid: number;
  pgid: number;
  startedAt: number;
}
/** `turn.planned` — `deliver` / `resent` are the msg.posted seqs of the bundle (re-sent first). */
export interface TurnPlannedBody {
  type: 'turn.planned';
  turnId: string;
  name: string;
  n: number;
  incarnation: number;
  trigger: TurnTrigger;
  deliver: number[];
  resent: number[];
  promptBytes: number;
  promptFile?: string;
}
/** `turn.running`. */
export interface TurnRunningBody {
  type: 'turn.running';
  turnId: string;
  pid: number;
  pgid: number;
  startedAt: number;
}
/** `turn.accepted` — the first stream event; display only (H3). */
export interface TurnAcceptedBody {
  type: 'turn.accepted';
  turnId: string;
}
/** `turn.ended`. */
export interface TurnEndedBody {
  type: 'turn.ended';
  turnId: string;
  outcome: TurnOutcomeKind;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  tokens: { in: number; out: number };
  costUsd?: number;
  /** ≤ 16 KiB; the whole text is `textFile` (`tasks/<turnId>.md`). */
  text: string;
  textFile: string;
  sawAssistant: boolean;
  conversationIdSeen?: string;
  note?: string;
  /** For `interrupted`: why (TURN_END_REASONS). See TURN_END_REASONS for the ambiguity. */
  reason?: TurnEndReason;
  /**
   * T1 ADDITION (CONTRACT-AMBIGUITY): the model the CLI reported. MemberState.modelUsed needs a
   * durable source and §2.3 lists none.
   */
  modelUsed?: string;
}
/** `turn.checkpoint` — a commit … */
export interface TurnCheckpointBody {
  type: 'turn.checkpoint';
  /**
   * The turn whose end committed it. CONTRACT-AMBIGUITY: absent for a checkpoint that is not at a
   * turn's end — stop, team_end, take-over, an incarnation end (§9.2 "When").
   */
  turnId?: string;
  name: string;
  sha: string;
  filesChanged: number;
  /** ≤ 200 paths. */
  touched: string[];
  outsideOwnership: string[];
  /** ≤ 20 (M23). */
  skipped: string[];
}
/** … or `turn.checkpoint` with `error` (the files stay uncommitted). */
export interface TurnCheckpointErrorBody {
  type: 'turn.checkpoint';
  turnId?: string;
  name: string;
  error: string;
}
/** `msg.posted` (§2.3, §4). */
export interface MsgPostedBody {
  type: 'msg.posted';
  /** `lead` | `user` | `engine` | a member name. */
  from: string;
  /** `lead` | `user` | a member name | `all`. */
  to: string;
  /**
   * T1 ADDITION (CONTRACT-AMBIGUITY): for `to: all`, the members it was expanded to at send time
   * (§4.1) — pending and delivery are per recipient, and the expansion must be durable.
   */
  recipients?: string[];
  kind: MessageKind;
  urgent: boolean;
  /** The message id it replies to (`reply_to`). */
  re?: string;
  /** A board id. */
  task?: string;
  /** Inline when ≤ BODY_INLINE bytes; else `bodyFile` (`bodies/m<seq>.md`). Exactly one of the two. */
  body?: string;
  bodyFile?: string;
  bytes: number;
  sha256: string;
  source: MessageSource;
  /** T1 ADDITION: for `kind: notice`, what it is about (NOTICE_KINDS). */
  notice?: NoticeKind;
  /** T1 ADDITION: for `kind: report`, the header facts (§3.6.2). */
  report?: ReportMeta;
}
/**
 * `msg.delivered` — appended at `turn.ended` by the rule of §4.3 (H3). `msg` is the message id
 * (`m<seq>`); CONTRACT-AMBIGUITY: §2.3 writes `msg` without saying id or seq — the id is taken,
 * as everywhere a message is named.
 */
export interface MsgDeliveredBody {
  type: 'msg.delivered';
  msg: string;
  to: string;
  via: 'turn' | 'interrupt' | 'tool';
  turnId: string;
}
/** `msg.read` — the reader is the envelope's `by` (`lead` or `user`). */
export interface MsgReadBody {
  type: 'msg.read';
  upToSeq: number;
}
/** `board.created`. */
export interface BoardCreatedBody {
  type: 'board.created';
  task: BoardTask;
}
/** `board.updated` — the actor is the envelope's `by`. `assignee: null` unassigns. */
export interface BoardUpdatedBody {
  type: 'board.updated';
  id: string;
  changes: {
    state?: TaskState;
    assignee?: string | null;
    title?: string;
    body?: string;
    /** T1 ADDITION: a body over BOARD_BODY_INLINE is in this file instead (see BoardTask.bodyFile). */
    bodyFile?: string;
    paths?: string[];
    allowOverlap?: boolean;
  };
  note?: string;
  reportFile?: string;
}
/** `overlap.detected` (§9.3). */
export interface OverlapDetectedBody {
  type: 'overlap.detected';
  members: string[];
  paths: string[];
}
/** `stash.changed` (L6). */
export interface StashChangedBody {
  type: 'stash.changed';
  turnId: string;
  name: string;
  before: string;
  after: string;
}
/** `attach.granted` — only the env KEYS are recorded (MD-56). */
export interface AttachGrantedBody {
  type: 'attach.granted';
  lease: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
}
/** `attach.started`. */
export interface AttachStartedBody {
  type: 'attach.started';
  lease: string;
  pid: number;
  startedAt: number;
}
/** `attach.ended`. */
export interface AttachEndedBody {
  type: 'attach.ended';
  lease: string;
  reason: string;
}
/** `budget.tripped`. */
export interface BudgetTrippedBody {
  type: 'budget.tripped';
  name?: string;
  kind: BudgetKind;
  until?: number;
}
/** `log.repaired` — a torn final line was truncated by the owner. */
export interface LogRepairedBody {
  type: 'log.repaired';
  droppedBytes: number;
}
/** `store.warning` — a checkpoint, a feed write or a file write that failed. */
export interface StoreWarningBody {
  type: 'store.warning';
  text: string;
}

/**
 * Every event type of §2.3, as an observer receives it (`lease.lost` is NOT a log event: the host
 * that lost a lease must not write to that log). Unknown types and unknown fields are ignored by
 * every reader (forward compatibility).
 */
export type TeamEventBody =
  | TeamCreatedBody
  | TeamStatusBody
  | LeaseAcquiredBody
  | LeaseReleasedBody
  | MemberAddedBody
  | MemberRoutedBody
  | MemberWorktreePlannedBody
  | MemberWorktreeBody
  | MemberConversationBody
  | MemberStateBody
  | MemberMailboxBody
  | MemberProcessBody
  | TurnPlannedBody
  | TurnRunningBody
  | TurnAcceptedBody
  | TurnEndedBody
  | TurnCheckpointBody
  | TurnCheckpointErrorBody
  | MsgPostedBody
  | MsgDeliveredBody
  | MsgReadBody
  | BoardCreatedBody
  | BoardUpdatedBody
  | OverlapDetectedBody
  | StashChangedBody
  | AttachGrantedBody
  | AttachStartedBody
  | AttachEndedBody
  | BudgetTrippedBody
  | LogRepairedBody
  | StoreWarningBody;
/** One event as an observer receives it: the common fields and one body. */
export type TeamEvent = TeamEventEnvelope & TeamEventBody;
/** The `type` of an event. */
export type TeamEventType = TeamEventBody['type'];

/** `Omit` that keeps a union a union (a plain Omit keeps only the keys every member shares). */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The `data` of a cco/team.event of kind `K`: the event's own fields and `by`, without the envelope. */
export type TeamEventData<K extends TeamEventType> = OmitEach<Extract<TeamEventBody, { type: K }>, 'type'> & {
  by: TeamEventBy;
};

/* ---- observer methods: params and results (§7.6) ---- */

/** A domain refusal (MD-54): a RESULT, never a JSON-RPC error. JSON-RPC errors are for protocol misuse only. */
export interface TeamRefusal {
  ok: false;
  code: string;
  sentence: string;
}
/** `{ok:true}` — the answer of cco/team.end, .markRead, .attached, .release, .unsubscribe. */
export interface TeamOk {
  ok: true;
}

/**
 * One team of cco/team.list. `owner`: the live owner's SESSION (lease.json `session`), absent when
 * none is alive — CONTRACT-AMBIGUITY: §7.6 types it ProcessIdentity without saying whose; the
 * `--all` line prints "owner session".
 */
export interface TeamListEntry {
  teamId: string;
  name: string;
  state: TeamStatus;
  members: number;
  ownedHere: boolean;
  owner?: ProcessIdentity;
  /** A20a: why the team is listed as it is — `host gone` (stale lease) or a damaged team's reason; absent otherwise. One line, ≤ 300 chars as rendered. */
  reason?: string;
}
/** cco/team.list `{}` → this host's team plus the suspended/ended/damaged teams of its repository (≤ TEAM_LIST_MAX, newest first). */
export interface TeamListResult {
  ok: true;
  teams: TeamListEntry[];
}

/** cco/team.get. */
export interface TeamGetParams {
  teamId: string;
}
/** From the log when this host owns the team, from `state.json` otherwise. */
export interface TeamGetResult {
  ok: true;
  state: TeamState;
}

/**
 * cco/team.subscribe — HELD. It starts with one `kind: 'snapshot'` notification, then
 * cco/team.event for every log event after `fromSeq` (replay ≤ TEAM_SUBSCRIBE_REPLAY_MAX, else the
 * request is answered `{ok:false, code:'resnapshot_required', …}`) and live, plus
 * cco/team.activity when `activity` is true. A second subscribe on one connection replaces the
 * first, which is then ANSWERED `{ok:true, replaced:true}` (L8); cco/team.unsubscribe answers it
 * `{ok:true}`.
 */
export interface TeamSubscribeParams {
  teamId: string;
  fromSeq?: number;
  activity?: boolean;
}
/** How a held subscribe is answered. */
export type TeamSubscribeResult = { ok: true; replaced?: true } | TeamRefusal;
/** cco/team.unsubscribe → TeamOk (and the held subscribe is answered `{ok:true}`). */
export interface TeamUnsubscribeParams {
  teamId: string;
}

/** cco/team.activityTail: `limit` 1 … TEAM_ACTIVITY_TAIL_MAX. */
export interface TeamActivityTailParams {
  teamId: string;
  member: string;
  limit: number;
}
/** The member's last `limit` activity items, oldest first. */
export interface TeamActivityTailResult {
  ok: true;
  items: FeedItem[];
}

/** cco/team.messageBody. */
export interface TeamMessageBodyParams {
  teamId: string;
  msgId: string;
}
/** The whole message text. */
export interface TeamMessageBodyResult {
  ok: true;
  text: string;
}

/** cco/team.turnText: reads `tasks/<turnId>.md`, at most TEAM_TURN_TEXT_MAX_BYTES per call. */
export interface TeamTurnTextParams {
  turnId: string;
  offsetBytes?: number;
  maxBytes?: number;
}
/** `total` = the file's size in bytes. */
export interface TeamTurnTextResult {
  ok: true;
  text: string;
  total: number;
}

/** cco/team.send — the sender is `user`; `tellLead` defaults to true (L8). */
export interface TeamSendParams {
  teamId: string;
  to: string;
  text: string;
  kind?: SenderMessageKind;
  urgent?: boolean;
  replyTo?: string;
  tellLead?: boolean;
}
/** `recipients[].state`: the recipient member's state when the message was recorded (`lead` / `user` for those). */
export interface TeamSendResult {
  ok: true;
  msgId: string;
  recipients: Array<{ to: string; state: string }>;
}

/**
 * A task file entry (§7.3 TASK_KEYS) — as it reaches the host, `body_file` already read by the
 * client into `body` (the §15.3.2 rule). Values are untrusted: the host checks every one.
 */
export interface TaskFileEntry {
  title: string;
  body?: string;
  assignee?: string;
  paths?: string[];
  allow_overlap?: boolean;
}
/** The board state an `update` may set (§7.3 TASK_OP_FILE). */
export type TaskOpUpdateState = 'claimed' | 'blocked' | 'review' | 'done' | 'open';
/** A board operation (§7.3 TASK_OP_FILE) — `cco team_task <file>` and cco/team.task alike. */
export type TeamTaskOp =
  | { op: 'add'; tasks: TaskFileEntry[] }
  | { op: 'assign'; task: string; to: string; force?: boolean }
  | { op: 'unassign'; task: string }
  | {
      op: 'update';
      task: string;
      title?: string;
      body?: string;
      paths?: string[];
      allow_overlap?: boolean;
      state?: TaskOpUpdateState;
      note?: string;
    }
  | { op: 'cancel'; task: string; note?: string }
  | { op: 'reopen'; task: string; note?: string };
/** cco/team.task — the actor is `user`. */
export type TeamTaskParams = { teamId: string } & TeamTaskOp;
/**
 * `task`: the task the operation changed — for `add`, the first one added. CONTRACT-AMBIGUITY:
 * §7.6 answers one `task` while `add` takes several; `tasks` (T1 addition) holds them all.
 */
export interface TeamTaskResult {
  ok: true;
  task: BoardTask;
  tasks?: BoardTask[];
  warnings: string[];
}

/** A member operation (§7.2 team_member, §7.6 cco/team.member). */
export const MEMBER_OPS = ['stop', 'restart', 'pause', 'unpause', 'interrupt', 'switch'] as const;
/** One of MEMBER_OPS. */
export type MemberOpName = (typeof MEMBER_OPS)[number];
/** cco/team.member. `now` only with stop/pause; `provider`/`worker`/`model` only with switch (≥ 1 of them). */
export interface TeamMemberParams {
  teamId: string;
  member: string;
  op: MemberOpName;
  now?: boolean;
  provider?: string;
  worker?: string;
  model?: string;
}
/** The member's state after the operation. */
export interface TeamMemberResult {
  ok: true;
  state: MemberStateName;
}

/**
 * The take-over plan (§3.10 step 2): `command` = the host's RESOLVED absolute `claude` path;
 * `args` = `['--resume', <uuid>]`; `env` = exactly `claudeTerminalEnv(configDir)` — `set` its
 * exported values plus `CCO_DISPATCHED_TASK=attach-<lease>` and CCO_TEAM_MEMBER; `unset`
 * SESSION_IDENTITY_ENV and, for the default config dir, `CLAUDE_CONFIG_DIR` itself (applied as
 * nulls by VS Code's createTerminal). `note` = takeoverNote (the trust prompt, L15).
 */
export interface TakeoverPlan {
  lease: string;
  command: string;
  args: string[];
  cwd: string;
  env: { set: Record<string, string>; unset: string[] };
  title: string;
  note: string;
}
/** cco/team.takeover (Claude members only; else `not_supported`). */
export interface TeamTakeoverParams {
  teamId: string;
  member: string;
  now?: boolean;
}
/** The grant. */
export interface TeamTakeoverResult {
  ok: true;
  plan: TakeoverPlan;
}
/** cco/team.attached — the TUI the front end spawned (its pid is the lease). → TeamOk. */
export interface TeamAttachedParams {
  teamId: string;
  lease: string;
  pid: number;
}
/** cco/team.release — refused `still_attached` while the pid is alive. → TeamOk. */
export interface TeamReleaseParams {
  teamId: string;
  lease: string;
}
/** cco/team.end → TeamOk. */
export interface TeamEndParams {
  teamId: string;
  now?: boolean;
}
/** cco/team.markRead — clears `user` unread through that seq. → TeamOk. */
export interface TeamMarkReadParams {
  teamId: string;
  upToSeq: number;
}

/** cco/team.wait (session role, HELD): `capChars` is the client's output cap (M9). */
export interface TeamWaitParams {
  waitSeconds: number;
  settleSeconds: number;
  capChars: number;
}
/** The messages printed like team_inbox (exit 0), or `timedOut` (exit 23). */
export type TeamWaitResult = TextResult & { timedOut: boolean };

/** cco/member.call (member role): a `tools/call` of the team MCP server, forwarded verbatim; answered `{content, isError}` (TextResult). */
export interface MemberCallParams {
  tool: string;
  arguments: unknown;
}

/* ---- notifications host → client (§7.6) ---- */

/**
 * cco/team.event: every log event, in order, NEVER dropped (a connection that cannot take one is
 * closed and resubscribes from its last seq; a seq gap → re-get). The first one of a subscription
 * is the snapshot. `requestId` is the CLIENT's id of the subscribe — host.ts puts it in
 * (TeamConnections.push), as HostTransport.notify does.
 */
export type TeamEventParams =
  | { requestId: string | number; teamId: string; seq: number; ts: number; kind: 'snapshot'; state: TeamState }
  | {
      [K in TeamEventType]: {
        requestId: string | number;
        teamId: string;
        seq: number;
        ts: number;
        kind: K;
        data: TeamEventData<K>;
      };
    }[TeamEventType];
/** cco/team.activity: lossy, coalesced over TEAM_ACTIVITY_COALESCE_MS, ≤ TEAM_ACTIVITY_NOTIFY_MAX_BYTES. */
export interface TeamActivityParams {
  requestId: string | number;
  teamId: string;
  member: string;
  items: FeedItem[];
}
/**
 * cco/team.host: sent before a suspend or an end, on `lease-lost`, and before an overflow close
 * (`reason: 'overflow'`, when it fits). `requestId` is the client's id of the connection's
 * subscription, `null` on a connection that holds none.
 */
export interface TeamHostParams {
  requestId: string | number | null;
  state: 'running' | 'suspending' | 'ending';
  reason?: string;
}

/* ---- a team's directory (§2.2): what a front end reads when no host is up ---- */

/** `<data root>/teams`. */
export const TEAMS_DIR_NAME = 'teams';
/** The entries of a team directory that a front end may read (§2.2, §8.2). */
export const TEAM_DIR_ENTRIES = {
  /** The immutable header (TeamHeader). */
  header: 'team.json',
  /** THE truth (§2.3) — engine-private; a front end never reads it. */
  log: 'events.jsonl',
  /** The projection (TeamState). */
  state: 'state.json',
  /** The lead seat (§2.1) — engine-private. */
  lease: 'lease.json',
  bodies: 'bodies',
  members: 'members',
} as const;

/** `team.json` — written once at creation (§2.2). A front end lists teams by these (≤ TEAM_DIR_SCAN_MAX). */
export interface TeamHeader {
  v: 1;
  id: string;
  name: string;
  title: string;
  workspace: string;
  repoRoot: string;
  commonDir: string;
  createdAt: number;
}

/** `value` checked against `shape`, or a RangeError naming only WHAT failed — a path is never built from an unchecked id. */
function checkedId(value: string, shape: RegExp, what: string): string {
  if (typeof value !== 'string' || !shape.test(value)) {
    throw new RangeError(`not a ${what}`);
  }
  return value;
}

/** `<data root>/teams`. */
export function teamsDirOf(dataRoot: string): string {
  return path.join(dataRoot, TEAMS_DIR_NAME);
}
/** `<data root>/teams/<teamId>`. Throws a RangeError for an id that is not TEAM_ID — check first. */
export function teamDirOf(dataRoot: string, teamId: string): string {
  return path.join(teamsDirOf(dataRoot), checkedId(teamId, TEAM_ID, 'team id'));
}
/** `<team dir>/bodies/m<seq>.md` — a message body over BODY_INLINE. Throws for an id that is not MESSAGE_ID. */
export function messageBodyFileOf(teamDir: string, msgId: string): string {
  return path.join(teamDir, TEAM_DIR_ENTRIES.bodies, `${checkedId(msgId, MESSAGE_ID, 'message id')}.md`);
}
/** `<team dir>/bodies/b<n>.md` — a board body over BOARD_BODY_INLINE. Throws for an id that is not BOARD_ID. */
export function boardBodyFileOf(teamDir: string, taskId: string): string {
  return path.join(teamDir, TEAM_DIR_ENTRIES.bodies, `${checkedId(taskId, BOARD_ID, 'board task id')}.md`);
}
/** `<team dir>/bodies/b<n>-r<k>.md` — report `k` (from 1) of board task `b<n>`. */
export function boardReportFileOf(teamDir: string, taskId: string, k: number): string {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError('not a report number');
  }
  return path.join(teamDir, TEAM_DIR_ENTRIES.bodies, `${checkedId(taskId, BOARD_ID, 'board task id')}-r${k}.md`);
}
/** `<team dir>/members/<name>`. Throws for a name that is not MEMBER_NAME. */
export function memberDirOf(teamDir: string, member: string): string {
  return path.join(teamDir, TEAM_DIR_ENTRIES.members, checkedId(member, MEMBER_NAME, 'member name'));
}
/** `<team dir>/members/<name>/feed.jsonl` — or its one rotation, `feed.jsonl.1` (§3.8). */
export function memberFeedFileOf(teamDir: string, member: string, rotated = false): string {
  return path.join(memberDirOf(teamDir, member), rotated ? 'feed.jsonl.1' : 'feed.jsonl');
}
/** `<data root>/tasks/<turnId>.md` — a turn's full text (the task log's own file). Throws for an id that is not TASK_ID. */
export function turnTextFileOf(dataRoot: string, turnId: string): string {
  return path.join(dataRoot, 'tasks', `${checkedId(turnId, TASK_ID, 'turn id')}.md`);
}

/* ---- believing `running` (L7, §2.4) ---- */

/** How a front end renders a team whose `state.json` names an owner that is gone (L7). */
export const TEAM_HOST_GONE_TEXT = 'suspended (host gone — resume it from a lead session)';
/** … and every member pill that `state.json` calls `running` or `attached` then. */
export const TEAM_WAS_RUNNING_TEXT = 'was running';
/** Gilde's preview line (§8.2), on every team pane. */
export const TEAM_PREVIEW_READ_ONLY_TEXT = 'Preview — read-only. Steer the team from the lead session or VS Code.';
/** Gilde's text while team mode is off (§8.2, L17). */
export const TEAM_MODE_IN_VSCODE_TEXT = 'Team mode is turned on in VS Code (claudeCodeOrchestrator.teamMode)';

/**
 * L7: may a front end that read `state.json` (no live connection) believe its `active` status and
 * its `running`/`attached` members? Only when `owner.hostPid` is alive AND its start time is
 * within START_SLACK_MS of `owner.hostStartedAt`. A start time that cannot be read is not a match:
 * this decides what is DISPLAYED, and "was running" is the safe display. `probe` is the front
 * end's own process probe (kill(0) and a `ps` start time). Never throws when the probe does not.
 */
export function teamOwnerIsLive(
  owner: TeamState['owner'],
  probe: { isAlive(pid: number): boolean; startedAt(pid: number): number | undefined },
): boolean {
  if (owner === null || typeof owner !== 'object') {
    return false;
  }
  const { hostPid, hostStartedAt } = owner;
  if (typeof hostPid !== 'number' || !Number.isInteger(hostPid) || hostPid <= 0 || !probe.isAlive(hostPid)) {
    return false;
  }
  const startedAt = probe.startedAt(hostPid);
  return (
    typeof startedAt === 'number' &&
    typeof hostStartedAt === 'number' &&
    Math.abs(startedAt - hostStartedAt) <= START_SLACK_MS
  );
}
