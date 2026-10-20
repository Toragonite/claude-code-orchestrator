import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import * as path from 'path';
import type { ProviderId } from '../providers';
import type { WorkerProfile } from '../registry';
import {
  BOARD_ID,
  COMMAND_SPELLING,
  DISPATCHED_TASK_ENV,
  footerReserveChars,
  MEMBER_NAME,
  MESSAGE_ID,
  memberDirOf,
  PROTOCOL_VERSION,
  RESERVED_NAMES,
  TEAM_DIR_ENTRIES,
  TEAM_ID,
  TEAM_MCP_ARG,
  TEAM_MCP_SERVER_NAME,
  TEAM_MEMBER_ENV,
  TEAM_PORT_BASE_ENV,
  TEAM_SUBSCRIBE_REPLAY_MAX,
  teamDirOf,
} from '../mcp/host-protocol';
import type {
  BlockedCode,
  BoardTask,
  FeedItem,
  MemberOpName,
  MemberReasonCode,
  MemberRoutedBody,
  MemberStateName,
  ProcessIdentity,
  SenderMessageKind,
  TakeoverPlan,
  TaskFileEntry,
  TaskState,
  TeamEvent,
  TeamEventBody,
  TeamEventEnvelope,
  TeamEventParams,
  TeamEventBy,
  TeamHeader,
  TeamOp,
  TeamProviderId,
  TeamRefusal,
  TeamState,
  TeamTaskOp,
  TextResult,
  TurnEndedBody,
  TurnOutcomeKind,
} from '../mcp/host-protocol';

/**
 * team/contract — THE CONTRACT FILE of Teammate mode (contract-team-mode-v2.md, task T1). Every
 * type of §2–§6, the constants of §12, the regexes, the reserved names, the file layout, the exact
 * sentences, the per-vendor argv building blocks as data, and the FOUR interfaces of §7.1 that
 * split the engine between parallel builders (H1):
 *
 *   TeamHostSide     host.ts → engine   (host.ts owns sockets, the engine owns meaning)
 *   TeamConnections  engine → host.ts   (push / close / role of a connection)
 *   TeamEngine       server.ts → engine (the lead's team ops, the footer, the turn ownership
 *                                        questions, the suspend and the sweep)
 *   TeamCore         T5a ↔ T5b          (the internal seam: engine.ts implements it, surface.ts
 *                                        consumes it, T9's fakes implement it too)
 *
 * Frozen BEFORE T5a, T5b and T6 start; each side codes against a fake of the other. A name, field,
 * constant or sentence here is what every implementer uses — an implementer that needs a text
 * this file has calls the function here, never writes the words again.
 *
 * WHAT IS NOT HERE. The records and names a FRONT END needs (TeamState, BoardTask, the log events
 * an observer is sent, the method names, the roles, the team directory's layout) are DEFINED in
 * mcp/host-protocol.ts — Gilde's sidecar vendors that file alone with host-client.ts (§8), so it
 * must hold them — and re-exported below, so this file is still the one place to import a team
 * name from. What the MEMBER is told — the brief, the protocol, the principles, the turn prompt's
 * fixed sentences, the hand-off packet — is prose owned by src/prompts.ts (§3.6, §7.8).
 * `CLAUDE_LOGIN_TRIGGER_TEXTS` and `recordTurnBookkeeping` are exported by mcp/task-runner.ts
 * (§7.7), `isOurWorker` and `signalWorker` by registry.ts. CONTRACT-AMBIGUITY: §12 lists
 * CLAUDE_LOGIN_TRIGGER_TEXTS among "all in contract.ts", §7.7 among task-runner's exports; it is
 * defined there (task-runner's classification reads it; this file must not load task-runner).
 *
 * Runtime imports: Node built-ins and mcp/host-protocol.ts (itself Node built-ins only). The
 * imports of registry.ts and providers.ts are TYPE-ONLY and erased. Must not import 'vscode';
 * both bundles may load it.
 *
 * Markers used below: `CONTRACT-AMBIGUITY:` — the contract is ambiguous or self-contradictory at
 * that point and the reading most consistent with the rest of it was taken (listed in the T1
 * report); `T1 ADDITION` — something the contract names or requires without defining it (a type
 * the interfaces reference, a code without words); `PROBE RP-n:` — a value still to be measured.
 */

/* ------------------------------------------------------------------------- *
 * Re-exports: the front-end-visible half, defined in mcp/host-protocol.ts
 * ------------------------------------------------------------------------- */

export {
  BLOCKED_CODES,
  BOARD_ID,
  BUDGET_KINDS,
  boardBodyFileOf,
  boardReportFileOf,
  COMMAND_SPELLING,
  DISPATCHED_TASK_ENV,
  FEED_KINDS,
  FOOTER_RESERVE_BASE_CHARS,
  FOOTER_RESERVE_PER_ID_CHARS,
  footerReserveChars,
  MEMBER_MAILBOX,
  MEMBER_NAME,
  MEMBER_OPS,
  MEMBER_STATES,
  memberDirOf,
  memberFeedFileOf,
  MESSAGE_ID,
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  messageBodyFileOf,
  METHOD_TEAM,
  NOTICE_KINDS,
  PING_METHOD,
  RESERVED_NAMES,
  ROUTE_CAUSES,
  SENDER_MESSAGE_KINDS,
  START_LOCK_STALE_MS,
  START_SLACK_MS,
  TASK_STATES,
  TEAM_ACTIVITY_COALESCE_MS,
  TEAM_ACTIVITY_NOTIFY_MAX_BYTES,
  TEAM_ACTIVITY_TAIL_MAX,
  TEAM_ANY_TEAM_METHODS,
  TEAM_DIR_ENTRIES,
  TEAM_DIR_SCAN_MAX,
  TEAM_FEATURE,
  TEAM_FEATURE_MISSING_SENTENCE,
  TEAM_FOOTER_RESERVE_CHARS,
  TEAM_HELD_METHODS,
  TEAM_HOST_GONE_TEXT,
  TEAM_ID,
  TEAM_LIST_MAX,
  TEAM_MCP_ARG,
  TEAM_MCP_SERVER_NAME,
  TEAM_MEMBER_CONNECTIONS_MAX,
  TEAM_MEMBER_ENV,
  TEAM_MEMBER_METHODS,
  TEAM_MODE_IN_VSCODE_TEXT,
  TEAM_NAME,
  TEAM_OBSERVER_CLIENTS,
  TEAM_OBSERVER_CONNECTIONS_MAX,
  TEAM_OBSERVER_METHODS,
  TEAM_OBSERVER_OUTBOUND_MAX_BYTES,
  TEAM_OBSERVER_TOOLS,
  TEAM_OPS,
  TEAM_PORT_BASE_ENV,
  TEAM_PREVIEW_READ_ONLY_TEXT,
  TEAM_PROVIDERS,
  TEAM_READ_ONLY_METHODS,
  TEAM_STATUSES,
  TEAM_SUBSCRIBE_REPLAY_MAX,
  TEAM_SUSPEND_BUDGET_MS,
  TEAM_TURN_TEXT_MAX_BYTES,
  TEAM_WARNING_KINDS,
  TEAM_WAS_RUNNING_TEXT,
  TEAMS_DIR_NAME,
  teamDirOf,
  teamOwnerIsLive,
  teamsDirOf,
  TURN_END_REASONS,
  TURN_OUTCOMES,
  TURN_TRIGGERS,
  turnTextFileOf,
  WAIT_MAX_SECONDS,
  WAKE_NOTICE_KINDS,
} from '../mcp/host-protocol';

export type {
  AnyHelloParams,
  AttachEndedBody,
  AttachGrantedBody,
  AttachStartedBody,
  BlockedCode,
  BoardCreatedBody,
  BoardTask,
  BoardUpdatedBody,
  BudgetKind,
  BudgetTrippedBody,
  FeedItem,
  FeedKind,
  HostRole,
  LeaseAcquiredBody,
  LeaseReleasedBody,
  LogRepairedBody,
  MemberAddedBody,
  MemberCallParams,
  MemberConversationBody,
  MemberHelloParams,
  MemberMailbox,
  MemberMailboxBody,
  MemberOpName,
  MemberProcessBody,
  MemberReasonCode,
  MemberRoutedBody,
  MemberSpecRecord,
  MemberState,
  MemberStateBody,
  MemberStateName,
  MemberWorktreeBody,
  MemberWorktreePlannedBody,
  MessageKind,
  MessageSource,
  MsgDeliveredBody,
  MsgPostedBody,
  MsgReadBody,
  NoticeKind,
  ObserverHelloParams,
  OverlapDetectedBody,
  ProcessIdentity,
  ReportMeta,
  RouteCause,
  SenderMessageKind,
  StashChangedBody,
  StoreWarningBody,
  TakeoverPlan,
  TaskFileEntry,
  TaskOpUpdateState,
  TaskState,
  TeamActivityParams,
  TeamActivityTailParams,
  TeamActivityTailResult,
  TeamAttachedParams,
  TeamCreatedBody,
  TeamEndParams,
  TeamEvent,
  TeamEventBody,
  TeamEventBy,
  TeamEventData,
  TeamEventEnvelope,
  TeamEventParams,
  TeamEventType,
  TeamGetParams,
  TeamGetResult,
  TeamHeader,
  TeamHostParams,
  TeamListEntry,
  TeamListResult,
  TeamMarkReadParams,
  TeamMemberParams,
  TeamMemberResult,
  TeamMessageBodyParams,
  TeamMessageBodyResult,
  TeamObserverClient,
  TeamOk,
  TeamOp,
  TeamProviderId,
  TeamRefusal,
  TeamReleaseParams,
  TeamSendParams,
  TeamSendResult,
  TeamState,
  TeamStatus,
  TeamStatusBody,
  TeamSubscribeParams,
  TeamSubscribeResult,
  TeamTakeoverParams,
  TeamTakeoverResult,
  TeamTaskOp,
  TeamTaskParams,
  TeamTaskResult,
  TeamTurnTextParams,
  TeamTurnTextResult,
  TeamUnsubscribeParams,
  TeamWaitParams,
  TeamWaitResult,
  TeamWarningKind,
  TextResult,
  TurnAcceptedBody,
  TurnCheckpointBody,
  TurnCheckpointErrorBody,
  TurnEndedBody,
  TurnEndReason,
  TurnOutcomeKind,
  TurnPlannedBody,
  TurnRunningBody,
  TurnTrigger,
} from '../mcp/host-protocol';

/* ------------------------------------------------------------------------- *
 * Compile-time agreement with the rest of the repository
 * ------------------------------------------------------------------------- */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;
/** host-protocol's TeamProviderId (spelled there for the vendored copy) IS providers.ProviderId. A drift fails the build here. */
export type ProviderIdsAgree = AssertTrue<Equals<TeamProviderId, ProviderId>>;

/* ------------------------------------------------------------------------- *
 * Settings and the registry (§7.7) — registry.ts sanitizes with these
 * ------------------------------------------------------------------------- */

/**
 * The numeric team settings: their default and range (§7.7, §12). Synced into registry.json
 * exactly as `meshMaxLiveWorkers` is (registry.sanitizeTeamNumberSetting): a value that is not a
 * finite number reads as the default; one outside the range is clamped and rounded. They are the
 * USER's — the lead cannot raise them (MD-22). The host reads the registry at every team op and
 * every turn start.
 */
export const TEAM_NUMBER_SETTINGS = {
  /** Members per team, stopped ones included (they keep their name and index). */
  teamMaxMembers: { default: 6, min: 1, max: 8 },
  /** Team turns running at once on this host; turns take no dispatch slot (MD-14). */
  teamMaxRunningTurns: { default: 4, min: 1, max: 16 },
  /** Turns one member may start per rolling hour (over it: `idle` with reason `budget`, M20). */
  teamTurnsPerMemberPerHour: { default: 20, min: 1, max: 240 },
  /** Turns per team per local day. */
  teamTurnsPerDay: { default: 300, min: 10, max: 5000 },
} as const;
/** The numeric team settings' registry keys. */
export type TeamNumberSettingKey = keyof typeof TEAM_NUMBER_SETTINGS;

/**
 * teamTurnTimeoutMinutes: DEFAULT = the registry's workerTimeoutMinutes (45), always clamped to
 * this range (§7.7, §12). CONTRACT-AMBIGUITY: "sanitised like meshMaxLiveWorkers" has no constant
 * default to fall back to here. Because its default is another setting's value, an absent or unreadable
 * value is kept ABSENT in the registry and derived at read time (registry.teamTurnTimeoutMinutesOf)
 * — a default written down once would stop following workerTimeoutMinutes.
 */
export const TEAM_TURN_TIMEOUT_MINUTES = { min: 5, max: 240 } as const;

/** The three on/off team settings: anything but the literal `on` reads `off` (§7.7). */
export type TeamSwitch = 'on' | 'off';
/**
 * The registry keys of the switches: `teamMode` (default off, experimental — I12),
 * `teamCursorForce` ("Cursor teammates run with --force (commands run without approval)") and
 * `teamAgySkipPermissions` ("Antigravity teammates run with --dangerously-skip-permissions —
 * needed for their team tools; every command then runs without approval"); both default off
 * (S3(b), I14).
 */
export const TEAM_SWITCH_SETTINGS = ['teamMode', 'teamCursorForce', 'teamAgySkipPermissions'] as const;

/* ------------------------------------------------------------------------- *
 * Constants (§12). Milliseconds unless a name says otherwise.
 * ------------------------------------------------------------------------- */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** At most this many members of ONE team on one account identity (§6.2 step 1; fixed). */
export const TEAM_MAX_PER_ACCOUNT = 3;

/** Consecutive turns a member may be woken ONLY by teammates (§3.5.1). */
export const PEER_WAKE_BUDGET = 6;
/** Consecutive member→member messages with no lead/user message anywhere that trip the team breaker (§3.5.1). */
export const PINGPONG_THRESHOLD = 12;

/** A message body's limit, in UTF-8 bytes, after CRLF/CR→LF and trimming trailing whitespace (MD-16). */
export const MESSAGE_MAX_BYTES = 65_536;
/** Message bodies up to this many bytes are inline in the log; longer ones live in `bodies/m<seq>.md`. */
export const BODY_INLINE = 16 * KiB;
/** Undelivered messages per MEMBER recipient before `inbox_full` (M20); the lead/user inboxes are unbounded and warned at this count. */
export const PENDING_MAX = 100;
/** Member sends per turn (reports are not counted). */
export const MEMBER_SENDS_PER_TURN = 20;
/** Member sends per rolling hour. */
export const MEMBER_SENDS_PER_HOUR = 100;
/** Lead and user sends per LEAD_USER_SEND_WINDOW_MS. */
export const LEAD_USER_SENDS_PER_WINDOW = 120;
/** The lead/user send window: 10 minutes. */
export const LEAD_USER_SEND_WINDOW_MS = 10 * 60_000;
/** L4: the duplicate window for a member sender: 5 minutes (in ms). */
export const DUPLICATE_WINDOW_MEMBER = 5 * 60_000;
/** L4: the duplicate window for the lead and the user: 60 s (in ms). */
export const DUPLICATE_WINDOW_LEAD = 60_000;
/** L4: bodies under this many bytes are exempt from the duplicate guard. */
export const DUPLICATE_MIN_BYTES = 64;
/** MD-23: at most one urgent interrupt per member per this interval: 120 s (in ms). */
export const INTERRUPT_MIN_INTERVAL = 120_000;
/** A turn input carries at most this many messages … */
export const TURN_INPUT_MAX_MESSAGES = 16;
/** … and this many bytes of message text; the rest ride the next turn or a team_inbox call. */
export const TURN_INPUT_MAX_BYTES = 96 * KiB;

/** The longest composed turn prompt (MD-64). */
export const TURN_PROMPT_MAX = 192 * KiB;
/** Above this a turn's prompt goes by file indirection (`members/<name>/turn-<n>.prompt.md`, MD-64). */
export const PROMPT_ARGV_MAX = 64 * KiB;
/** The lead's brief of one member, bytes (1 … this). */
export const BRIEF_MAX = 256 * KiB;
/** The team's goal, bytes (1 … this). */
export const GOAL_MAX = 64 * KiB;
/** A member spec's `start` text, bytes. */
export const START_MAX = 16 * KiB;
/** A board report (team_update `report`), bytes. */
export const REPORT_MAX_BYTES = 65_536;
/** A board task body, bytes. */
export const BOARD_BODY_MAX_BYTES = 65_536;
/** Board bodies up to this many bytes are inline; longer ones live in `bodies/b<n>.md`. */
export const BOARD_BODY_INLINE = 8 * KiB;
/** A board task title, characters (1 … this, one line). */
export const BOARD_TITLE_MAX_CHARS = 120;
/** A board status note, bytes. */
export const NOTE_MAX_BYTES = 2_048;
/** Ownership paths per task. */
export const BOARD_PATHS_MAX = 32;
/** One ownership path, characters. */
export const BOARD_PATH_MAX_CHARS = 200;
/** Board tasks per team (`board_full`). */
export const BOARD_TASKS_MAX = 200;
/** Tasks one member may hold in claimed/blocked/review (`claim_limit`); the lead is not bound by it. */
export const CLAIMS_ACTIVE_MAX = 3;
/** A member's role, characters (1 … this, one line). */
export const ROLE_MAX_CHARS = 80;
/** A team's title, characters (one line). */
export const TITLE_MAX_CHARS = 80;
/** A board task's `turns` list keeps at most this many ids. */
export const BOARD_TURNS_MAX = 200;

/** M10: messages per team_inbox tool answer. */
export const TOOL_INBOX_MAX_MESSAGES = 8;
/** M10: bytes of rendered messages per team_inbox tool answer. PROBE RP-20: confirmed or lowered per vendor's MCP result limit. */
export const TOOL_INBOX_MAX_BYTES = 24 * KiB;
/** M10: the team_board tool answer's cap. PROBE RP-20 as above. */
export const TOOL_BOARD_MAX_BYTES = 24 * KiB;
/** M10: other members' task bodies are cut to this many characters in team_board. */
export const TOOL_BOARD_OTHER_BODY_CHARS = 300;
/** team_board with task_id answers at most this many bytes of body and notes. */
export const TOOL_BOARD_TASK_MAX_BYTES = 64 * KiB;
/** P32: after this many team_inbox calls in one turn the answer tells the member to stop polling. */
export const TOOL_INBOX_POLLS_MAX = 30;

/**
 * A kill ladder: signal the turn's process GROUP with each stage's signal, then wait that stage's
 * `waitMs` for the exit before the next stage; after SIGKILL a turn that never reports `exit`
 * settles `reapGraceMs` later (provider-runner's REAP_GRACE_MS).
 */
export interface KillLadder {
  /**
   * T0 amendment A1: each stage names its TARGET. `leader` = only the vendor CLI the driver spawned
   * (alone in its own process group); `group` = that whole process group. SIGINT always goes to the
   * leader — a group SIGINT does NOT interrupt Codex (it completes the turn) — and the escalation
   * stages go to the group so nothing the turn started survives.
   */
  readonly stages: ReadonlyArray<{ readonly signal: NodeJS.Signals; readonly waitMs: number; readonly target: 'leader' | 'group' }>;
  readonly reapGraceMs: number;
}
/** The normal ladder (urgent, cancel, pause --now, stop, end, take-over, timeout): SIGINT → 10 s → SIGTERM → 5 s → SIGKILL. */
export const NORMAL_KILL_LADDER: KillLadder = {
  stages: [
    { signal: 'SIGINT', waitMs: 10_000, target: 'leader' },
    { signal: 'SIGTERM', waitMs: 5_000, target: 'group' },
    { signal: 'SIGKILL', waitMs: 0, target: 'group' },
  ],
  reapGraceMs: 5_000,
};
/** H2: the SUSPEND ladder (lead session end only): SIGINT → 5 s → SIGTERM → 3 s → SIGKILL. */
export const SUSPEND_KILL_LADDER: KillLadder = {
  stages: [
    { signal: 'SIGINT', waitMs: 5_000, target: 'leader' },
    { signal: 'SIGTERM', waitMs: 3_000, target: 'group' },
    { signal: 'SIGKILL', waitMs: 0, target: 'group' },
  ],
  reapGraceMs: 5_000,
};
/** "The ladder from SIGTERM" (TurnHandle.kill, the orphan sweep §2.5): the normal ladder's last two stages. */
export const TERM_KILL_LADDER: KillLadder = {
  stages: [
    { signal: 'SIGTERM', waitMs: 5_000, target: 'group' },
    { signal: 'SIGKILL', waitMs: 0, target: 'group' },
  ],
  reapGraceMs: 5_000,
};
/** §3.4 step 4 (3): a straggler found by the env-marker search: SIGTERM, 3 s, SIGKILL. */
export const STRAGGLER_KILL_LADDER: KillLadder = {
  stages: [
    { signal: 'SIGTERM', waitMs: 3_000, target: 'group' },
    { signal: 'SIGKILL', waitMs: 0, target: 'group' },
  ],
  reapGraceMs: 5_000,
};

/** A lead `team_end` without `--now`: every running turn may finish for at most this long, then the normal ladder. */
export const END_DRAIN_MS = 120_000;
/**
 * §7.9 step 3, §12: failServer's hard-exit timer while a team is active —
 * TEAM_SUSPEND_BUDGET_MS + SHUTDOWN_GRACE_MS (server.ts, 2,500) + 2000 = 34,500. server.ts computes
 * it from its own SHUTDOWN_GRACE_MS; this is the number the gates check.
 */
export const TEAM_FAILSERVER_EXIT_MS = 34_500;
/** P13: team ops wait for the orphan sweep at most this long. */
export const SWEEP_WAIT_MS = 15_000;

/** MD-59: a turn that crashed before any stream event is retried once, after 5 s; a second early crash → `blocked: crash`. */
export const EARLY_CRASH_RETRY = { retries: 1, delayMs: 5_000 } as const;
/** Consecutive `error` turns → `blocked: error` with the last message. */
export const CONSECUTIVE_ERRORS_MAX = 3;
/** A second `context` within this many turns → `blocked: context`. */
export const CONTEXT_REPEAT_TURNS = 3;
/** §6.5 step 2: a quota reset within this many minutes is waited for (`paused`, `quota-wait`). */
export const QUOTA_WAIT_MAX_MINUTES = 15;
/** §6.5: timers fire this long after a reset or an `until`. */
export const RESET_MARGIN_MS = 60_000;
/** §6.5 step 4: scheduled `continue` attempts while the reading stays stale; then it stays blocked until --unpause. */
export const BLOCKED_RETRY_MAX = 3;
/** M13: a member's report wakes the lead's waiter at most once per this window. */
export const REPORT_COALESCE_MS = 60_000;
/** M13: a turn whose reported INPUT tokens exceed this makes the member's next turn a refresh. */
export const MEMBER_CONTEXT_REFRESH_TOKENS = 150_000;
/** M11: team_wait --settle default, seconds. */
export const WAIT_SETTLE_DEFAULT_S = 20;
/** M11: team_wait --settle maximum, seconds. */
export const WAIT_SETTLE_MAX_S = 300;
/** §7.2: the `--settle` flag's shape (then ≤ WAIT_SETTLE_MAX_S). */
export const WAIT_SETTLE_FLAG = /^(0|[1-9][0-9]{0,2})$/;
/** §5.5: board notices to the lead are coalesced over this window. */
export const LEAD_NOTICE_COALESCE_MS = 30_000;
/** §4.3: a message for an idle member starts its turn within this long. */
export const IDLE_WAKE_MAX_MS = 2_000;
/** §8.1: VS Code shows at most one notice notification per team per this window. */
export const FRONTEND_NOTIFY_INTERVAL_MS = 30_000;

/** One line of events.jsonl, bytes. */
export const LOG_LINE_MAX = 64 * KiB;
/** The whole events.jsonl; then the team is `readonly`. */
export const TEAM_LOG_MAX = 64 * MiB;
/** state.json. */
export const STATE_MAX = 4 * MiB;
/** MD-9: appends are batched over at most this window and fdatasync'ed per batch. */
export const LOG_BATCH_WINDOW_MS = 50;
/** §2.3 ENOSPC: results kept in memory while the log cannot be written — events … */
export const ENOSPC_HOLD_MAX_EVENTS = 1_000;
/** … and bytes (feed events dropped first). */
export const ENOSPC_HOLD_MAX_BYTES = 16 * MiB;

/** feed.jsonl rotates once (to `.1`) at this size. */
export const FEED_ROTATE = 4 * MiB;
/** A feed item's `s`, bytes. */
export const FEED_TEXT_MAX_BYTES = 2 * KiB;
/** A feed item's `d`, characters. */
export const FEED_DETAIL_MAX_CHARS = 200;
/** A feed item's `tool`, characters. */
export const FEED_TOOL_MAX_CHARS = 64;
/** Text deltas are coalesced into one feed item over this window. */
export const FEED_COALESCE_MS = 100;

/** Ended team directories kept per repository (MD-62); `suspended` and `damaged` ones are never removed. */
export const TEAM_HISTORY_KEEP = 20;

/** MD-45: one notice when a turn's process group reaches this RSS (bytes) … */
export const RSS_NOTICE = 2 * GiB;
/** … and the kill ladder (outcome `memory`) at this one. */
export const RSS_KILL = 8 * GiB;
/** L13: no output for this long → one notice to lead and user; never a kill. */
export const SILENCE_NOTICE = 10 * 60_000;
/** L14: one async `ps -A -o pid=,pgid=,rss=` per tick for the whole host. */
export const RSS_TICK_MS = 10_000;
/** §7.3: free space needed on the volume of `<data root>/worktrees` (bytes). */
export const DISK_MIN_FREE = 2 * GiB;
/** M23: untracked files over this size are left out of a checkpoint (LFS-tracked paths never are). */
export const CHECKPOINT_FILE_MAX = 20 * MiB;
/** M23: untracked basenames left out of a checkpoint: `.env`, `.env.*`, `*.pem`, `*.key`. */
export const CHECKPOINT_SKIP_NAMES = ['.env', '.env.*', '*.pem', '*.key'] as const;
/** M23: whether an untracked file's basename is one of CHECKPOINT_SKIP_NAMES. */
export function isCheckpointSkipName(basename: string): boolean {
  return basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.pem') || basename.endsWith('.key');
}
/** M23: at most this many skipped paths are recorded in `turn.checkpoint.skipped`. */
export const CHECKPOINT_SKIPPED_MAX = 20;
/** `turn.checkpoint.touched` keeps at most this many paths. */
export const CHECKPOINT_TOUCHED_MAX = 200;
/** §9.2: `git diff --name-only` reads at most this many paths. */
export const CHECKPOINT_DIFF_PATHS_MAX = 2_000;
/** L5: an `index.lock` older than this AND held by no process (lsof/fuser) is stale. */
export const INDEX_LOCK_STALE_MS = 60_000;
/** H5: the pathspec excludes of every dirty test, `ahead`, the checkpoint test and its `add` — relative to the WORKTREE ROOT (M6). */
export const CHECKPOINT_EXCLUDES = [':(exclude).cursor/mcp.json', ':(exclude).agents/mcp_config.json'] as const;
/** §9.2: the checkpoint commit identity (`-c user.name=… -c user.email=…`). */
export const CHECKPOINT_IDENTITY = {
  name: 'Claude Code Orchestrator',
  email: 'orchestrator@users.noreply.github.com',
} as const;
/** M18: on every engine git call that can trigger a hook. */
export const GIT_NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const;
/** M18: in every engine git call's environment. */
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' } as const;
/** §12 git timeouts. */
export const GIT_TIMEOUTS_MS = {
  /** rev-parse, status, sparse-checkout list, reflog. */
  quick: 5_000,
  /** `worktree add --no-checkout` (phase 1). */
  worktreePhase1: 60_000,
  /** checkpoint `add` and `commit`. */
  checkpoint: 60_000,
  /** each hand-off packet fact. */
  packetFact: 15_000,
  /** `diff --name-only`. */
  diffNames: 30_000,
  /** lsof / fuser. */
  lockHolder: 5_000,
} as const;
/** §7.3 `worktree.timeout_minutes` (H6): phase 2 of a worktree's creation. */
export const WORKTREE_TIMEOUT_MINUTES = { default: 20, min: 1, max: 120 } as const;
/** §7.3 `worktree.setup.timeout_minutes`. */
export const SETUP_TIMEOUT_MINUTES = { default: 10, min: 1, max: 60 } as const;
/** §7.3 `worktree.setup.argv`: 1 … 32 strings, each ≤ 1,000 chars; argv[0] a bare name or an absolute path. */
export const SETUP_ARGV_MAX = 32;
export const SETUP_ARG_MAX_CHARS = 1_000;

/** M16: the first member's ports start at TEAM_PORT_BASE + TEAM_PORT_STRIDE (index 1 → 20100). */
export const TEAM_PORT_BASE = 20_000;
export const TEAM_PORT_STRIDE = 100;

/** §3.10: a take-over grant with no `cco/team.attached` within this long expires (`attach.ended reason=never-started`). */
export const ATTACH_START_GRACE = 60_000;
/** §3.10: the granting connection gone AND no pid reported for this long → released. */
export const ATTACH_ORPHAN_MS = 10 * 60_000;
/** §3.10: the attached pid is checked (kill(0)) this often. */
export const ATTACH_WATCH_MS = 2_000;

/** §4.4: a message over this many bytes is cut in the lead's inbox (with the team_status --message line). */
export const INBOX_MESSAGE_CUT_BYTES = 4_096;
/** §4.4: `team_inbox --all` returns the last this-many messages, marking nothing. */
export const INBOX_ALL_MAX = 50;
/** §3.7, §5.5: a review notice carries the first this-many characters of the report. */
export const REPORT_NOTICE_CHARS = 600;
/** §4.1: a user→member notice to the lead quotes the first this-many characters. */
export const USER_WROTE_QUOTE_CHARS = 200;
/** §3.6.2: a report's body inline in the message, bytes (cut at a paragraph; the full text is tasks/<turnId>.md). */
export const REPORT_INLINE_MAX_BYTES = 64 * KiB;
/** §2.5: a crash's stderr tail in `blocked: crash`, characters. */
export const CRASH_TAIL_CHARS = 300;
/** Reasons in `member.state` / `member.routed`, characters (flattened). */
export const REASON_MAX_CHARS = 300;
/** `turn.ended.text`, bytes (the whole text is `textFile`). */
export const TURN_TEXT_INLINE_MAX = 16 * KiB;
/** MemberState.lastTurn.head and lastActivity.text, characters. */
export const HEAD_MAX_CHARS = 200;
/** §7.3: at most this many value problems are listed before `Nothing was created.` */
export const VALUE_PROBLEMS_MAX = 20;
/** §7.4 team_status: board bodies ≤ 2 KiB each; --task: body and each report ≤ 64 KiB. */
export const STATUS_BODY_MAX_BYTES = 2 * KiB;
export const STATUS_TASK_MAX_BYTES = 64 * KiB;
/** §7.4 team_status --member: its last 20 feed items and last 10 messages. */
export const STATUS_MEMBER_FEED_ITEMS = 20;
export const STATUS_MEMBER_MESSAGES = 10;

/** §6.6: the hand-off packet's cap and its parts' caps. */
export const HANDOFF_MAX_BYTES = 24 * KiB;
export const HANDOFF_LIMITS = {
  commits: 30,
  statusLines: 100,
  diffStatLines: 100,
  reports: 3,
  reportBytes: 4 * KiB,
  messages: 10,
  messageBytes: 2 * KiB,
} as const;

/** §6.3, M15: the live checks before a member's first turn — `pickWorkerLive` (≤ 3 dirs × 5 s) and providerStatus (≤ 20 s). */
export const FIRST_TURN_LIVE_CHECK_MS = { perDir: 5_000, maxDirs: 3, providerStatus: 20_000 } as const;
/** §6.2 step 6: the one background `availableModels()` of a Codex member with no model. */
export const CODEX_MODEL_LOOKUP_MS = 25_000;
/** §3.7: the team MCP server's tool-spec file: a regular file of the uid, 0600, at most this many bytes. */
export const TOOL_SPEC_MAX_BYTES = 4 * KiB;
/** §3.7: the team MCP server reconnects once after this backoff. */
export const TEAM_MCP_RECONNECT_MS = 2_000;
/** A credential: 64 lowercase hex — 32 random bytes, re-minted at every lease acquisition. */
export const CREDENTIAL = /^[0-9a-f]{64}$/;
/** An attach lease id (§2.1): `a` + 8 hex. */
export const ATTACH_LEASE = /^a[0-9a-f]{8}$/;
/** A fence id (MD-26): 12 hex, random per bundle. */
export const FENCE_ID = /^[0-9a-f]{12}$/;
/** The fence's opening and closing marks (§3.6.1). */
export const FENCE_OPEN = '<<<cco-msg';
export const FENCE_CLOSE = '>>>cco-msg';
/** Directory and file modes under the data root (§2.2). */
export const TEAM_DIR_MODE = 0o700;
export const TEAM_FILE_MODE = 0o600;

/**
 * RP-9 [probed, 2026-10-16]: the text a `next` turn fails with BEFORE any event when the vendor
 * has no such conversation → outcome `resume-failed` (§3.3). Each entry is a fixed part of the
 * measured line, matched as a case-sensitive substring of the failed turn's failure text
 * (isResumeNotFoundText). Cursor's applies to a NON-UUID id only — a well-formed missing UUID
 * SILENTLY starts a new chat; agy's is a stderr WARNING after which agy silently starts a new
 * conversation: for both, the id comparison after the turn (`contextLost`) is the detection, and
 * these texts only decide a turn that ALSO failed before any event.
 */
export const RESUME_NOT_FOUND_TEXTS: Readonly<Record<ProviderId, readonly string[]>> = {
  /** The full line: `thread/resume failed: no rollout found for thread id <id>`. */
  codex: ['no rollout found for thread id'],
  /** The full line: `No conversation found with session ID: <id>`. */
  claude: ['No conversation found with session ID'],
  /** A non-UUID chat id only. */
  cursor: ['Persistent-session chat ID must be a UUID'],
  /** The stderr line `warning: conversation "<id>" not found`: its fixed prefix (the id varies). */
  gemini: ['warning: conversation "'],
};
/**
 * T0 amendment A4 (RP-18): a second `claude --session-id S` after a run that created S's transcript
 * fails with `Error: Session ID S is already in use.` — the fixed part below. The early-crash retry
 * therefore continues with `--resume S` whenever the transcript exists, and treats this text, if it
 * is ever seen, as "the conversation exists": retry once with `--resume`.
 */
export const CLAUDE_SESSION_ID_IN_USE_TEXT = 'is already in use';
/** Whether a failed turn's failure text is `provider`'s conversation-not-found text (RESUME_NOT_FOUND_TEXTS). */
export function isResumeNotFoundText(provider: ProviderId, text: string): boolean {
  return RESUME_NOT_FOUND_TEXTS[provider].some((fixed) => text.includes(fixed));
}

/**
 * §3.3, §12: the vendor's context-overflow failure → outcome `context`, matched case-insensitively
 * as a substring of a FAILED turn's failure text (isContextOverflowText). Claude: the result
 * subtypes of the `prompt_too_long` class (and the API's own "prompt is too long" sentence);
 * Codex: `ContextWindowExceeded`; Cursor and Antigravity: none measured yet — collected in
 * VERIFICATION as seen, and extended here ("extended as seen").
 */
export const CONTEXT_OVERFLOW_TEXTS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ['prompt_too_long', 'prompt is too long'],
  codex: ['ContextWindowExceeded'],
  cursor: [],
  gemini: [],
};
/** Whether a failed turn's failure text is `provider`'s context-overflow text (CONTEXT_OVERFLOW_TEXTS). */
export function isContextOverflowText(provider: ProviderId, text: string): boolean {
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_TEXTS[provider].some((fixed) => lower.includes(fixed.toLowerCase()));
}

/* ------------------------------------------------------------------------- *
 * Identities, minting, names (§2.1)
 * ------------------------------------------------------------------------- */

/** `count` random base36 characters (crypto). */
function randomBase36(count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += randomInt(36).toString(36);
  }
  return out;
}

/** A new team id: `tm` + base36(now) + 4 random base36 (matches TEAM_ID). */
export function newTeamId(now: number = Date.now()): string {
  return `tm${Math.trunc(now).toString(36)}${randomBase36(4)}`;
}
/** A new turn id — the task-log id shape every dispatcher mints: `t` + base36(now) + 4 random base36. */
export function newTurnId(now: number = Date.now()): string {
  return `t${Math.trunc(now).toString(36)}${randomBase36(4)}`;
}
/** A new member credential: 32 random bytes as 64 lowercase hex (CREDENTIAL). */
export function newCredential(): string {
  return randomBytes(32).toString('hex');
}
/** A new attach lease id: `a` + 8 hex (ATTACH_LEASE). */
export function newAttachLease(): string {
  return `a${randomBytes(4).toString('hex')}`;
}
/** A new fence id: 12 hex (FENCE_ID), one per bundle. */
export function newFenceId(): string {
  return randomBytes(6).toString('hex');
}
/** A Claude member's conversation id: a UUID v4 the host mints BEFORE the spawn (`--session-id`, §2.1). */
export function newClaudeSessionId(): string {
  return randomUUID();
}

/** `m<seq>` — a message's id is the seq of its `msg.posted` event (MD-4). */
export function messageIdOf(seq: number): string {
  return `m${seq}`;
}
/** The seq a MESSAGE_ID names, or undefined for anything that is not one. */
export function seqOfMessageId(id: unknown): number | undefined {
  return typeof id === 'string' && MESSAGE_ID.test(id) ? Number(id.slice(1)) : undefined;
}
/** `b<n>` (MD-5). */
export function boardIdOf(n: number): string {
  return `b${n}`;
}
/** The n a BOARD_ID names, or undefined. */
export function numberOfBoardId(id: unknown): number | undefined {
  return typeof id === 'string' && BOARD_ID.test(id) ? Number(id.slice(1)) : undefined;
}

/** Why a member name is refused, or undefined when it is allowed: its shape (MEMBER_NAME) or a reserved word (MD-3). */
export function memberNameProblem(name: unknown): 'shape' | 'reserved' | undefined {
  if (typeof name !== 'string' || !MEMBER_NAME.test(name)) {
    return 'shape';
  }
  return (RESERVED_NAMES as readonly string[]).includes(name) ? 'reserved' : undefined;
}

/** MD-2: `<name>-<last 4 chars of teamId>` — the branch and worktree component. */
export function teamSlugOf(name: string, teamId: string): string {
  return `${name}-${teamId.slice(-4)}`;
}
/** MD-2: `cco/<teamSlug>/<member>`. */
export function teamBranchOf(teamSlug: string, member: string): string {
  return `cco/${teamSlug}/${member}`;
}
/** `<data root>/worktrees`. */
export const WORKTREES_DIR_NAME = 'worktrees';
/**
 * MD-2: `<data root>/worktrees/<repoHash>/<teamSlug>/<member>` — outside the repository (§9.1).
 * `repoHash` = mesh/contract.meshWorkspaceHash(repoRoot), computed by the caller.
 */
export function memberWorktreeOf(dataRoot: string, repoHash: string, teamSlug: string, member: string): string {
  return path.join(dataRoot, WORKTREES_DIR_NAME, repoHash, teamSlug, member);
}
/** M16: a member's port base: 20000 + 100 × index (index from 1). */
export function memberPortBase(index: number): number {
  return TEAM_PORT_BASE + TEAM_PORT_STRIDE * index;
}
/** TEAM_MEMBER_ENV's value: `<teamId>:<member>:<incarnation>`. */
export function teamMemberEnvValue(teamId: string, member: string, incarnation: number): string {
  return `${teamId}:${member}:${incarnation}`;
}
/** TEAM_MEMBER_ENV's value read back, or undefined when it is not one (a set but unreadable value still COUNTS as set for every guard). */
export function parseTeamMemberEnv(
  value: string | undefined,
): { teamId: string; member: string; incarnation: number } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parts = value.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const [teamId, member, incarnation] = parts;
  return TEAM_ID.test(teamId) && MEMBER_NAME.test(member) && /^[1-9][0-9]{0,8}$/.test(incarnation)
    ? { teamId, member, incarnation: Number(incarnation) }
    : undefined;
}
/** The CCO_DISPATCHED_TASK value of a take-over terminal (§3.9). */
export function attachDispatchedTaskValue(lease: string): string {
  return `attach-${lease}`;
}

/**
 * §5.3: why an ownership path is invalid — a predicate for TEAM_TEXT.invalidPath (`is absolute`,
 * `has a . or .. segment`, …) — or undefined when it is valid: repo-relative POSIX, `/`-separated,
 * no leading `/`, no `.` or `..` segment, no empty segment except ONE trailing `/` ("this directory
 * and everything under it"), none of `* ? [ ] \`, no control character, ≤ BOARD_PATH_MAX_CHARS.
 * Paths are ownership HINTS and the input of overlap detection — never a sandbox.
 */
export function boardPathProblem(p: unknown): string | undefined {
  if (typeof p !== 'string' || p === '') {
    return 'is empty';
  }
  if (p.length > BOARD_PATH_MAX_CHARS) {
    return `is longer than ${BOARD_PATH_MAX_CHARS} characters`;
  }
  if (hasControlChar(p)) {
    return 'holds a control character';
  }
  if (/[*?[\]\\]/.test(p)) {
    return 'holds a glob character or a backslash';
  }
  if (p.startsWith('/')) {
    return 'is absolute';
  }
  const segments = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  if (segments.some((s) => s === '')) {
    return 'has an empty segment';
  }
  if (segments.some((s) => s === '.' || s === '..')) {
    return 'has a . or .. segment';
  }
  return undefined;
}
/** §5.3: two paths overlap when equal, or when one ends with `/` and is a prefix of the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}

/** Whether a string holds a control character (`unsafe_path` for the Codex wiring, §3.2; flag values, §7.2). */
export function hasControlChar(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text);
}

/**
 * §4.2: a message body as it is recorded: CRLF/CR → LF and trailing whitespace trimmed, then 1 …
 * MESSAGE_MAX_BYTES UTF-8 bytes, strict UTF-8 (no lone surrogate — the form invalid UTF-8 takes in
 * a decoded string), no NUL, at least one non-space character. The refusal code is the tool's /
 * cco's exit-20 sentence's.
 */
export function normalizeMessageText(
  raw: unknown,
):
  | { ok: true; text: string; bytes: number }
  | { ok: false; code: 'empty_message' | 'message_too_large' | 'invalid_text'; bytes?: number } {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_text' };
  }
  const text = raw.replace(/\r\n?/g, '\n').trimEnd();
  if (/\u0000/.test(text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    return { ok: false, code: 'invalid_text' };
  }
  if (!/\S/.test(text)) {
    return { ok: false, code: 'empty_message' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes > MESSAGE_MAX_BYTES ? { ok: false, code: 'message_too_large', bytes } : { ok: true, text, bytes };
}
/** `msg.posted.sha256`: of the recorded body's UTF-8 bytes. */
export function bodySha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** L4: the duplicate guard's key — (from, to, reply_to, task, sha256(body)); bodies under DUPLICATE_MIN_BYTES are exempt (the caller skips them). */
export function duplicateKeyOf(from: string, to: string, replyTo: string | undefined, task: string | undefined, sha256: string): string {
  return JSON.stringify([from, to, replyTo ?? null, task ?? null, sha256]);
}

/** The opening fence line (§3.6.1): `<<<cco-msg <fence>[ <header>]`. */
export function fenceOpenLine(fence: string, header?: string): string {
  return header === undefined || header === '' ? `${FENCE_OPEN} ${fence}` : `${FENCE_OPEN} ${fence} ${header}`;
}
/** The closing fence line: `>>>cco-msg <fence>`. */
export function fenceCloseLine(fence: string): string {
  return `${FENCE_CLOSE} ${fence}`;
}
/**
 * MD-26, §3.6.1: every body line that begins (after optional whitespace) with `<<<cco-msg` or
 * `>>>cco-msg` is prefixed with `> ` — so a fence can never be forged from inside a body. Applied
 * to EVERY text put between fences: messages, reports, packet facts.
 */
export function quoteFenceLines(body: string): string {
  return body
    .split('\n')
    .map((line) => (/^\s*(<<<cco-msg|>>>cco-msg)/.test(line) ? `> ${line}` : line))
    .join('\n');
}

/* ---- display formats shared by the engine's texts ---- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
/** `HH:MM`, local time — `until 15:10`, `started <hh:mm>`, a fence header's time. */
export function clockHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** `HH:MM:SS`, local time — the lead's inbox headers (§4.4). */
export function clockHHMMSS(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** ISO 8601 (UTC) — the turn prompt's header and the packet's (§3.6.1, §6.6). */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
/** A duration as the report header writes it: `45s`, `6m12s`, `1h03m`. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m${pad2(s % 60)}s`;
  }
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
}
/** An age as the members line writes it: `40s`, `2m`, `3h`, `2d`. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
/** Tokens in thousands as the report header writes them: `41k`. */
export function kTokens(n: number): string {
  return `${Math.round(Math.max(0, n) / 1000)}k`;
}

/* ------------------------------------------------------------------------- *
 * Files under the data root (§2.2) — the engine-private half
 * ------------------------------------------------------------------------- */

/** The goal's file when it is over BODY_INLINE (T1 ADDITION, see TeamCreatedBody.goal), relative to the team directory. */
export const GOAL_FILE = 'bodies/goal.md';

/** The files of one team directory (§2.2). */
export function teamFilesOf(dataRoot: string, teamId: string): {
  dir: string;
  header: string;
  log: string;
  state: string;
  lease: string;
  leaseLock: string;
  /** `lease.json.<oldHostPid>.stale` — the taken-over lease, kept (H4). */
  staleLease(oldHostPid: number): string;
  bodies: string;
  goal: string;
  members: string;
} {
  const dir = teamDirOf(dataRoot, teamId);
  return {
    dir,
    header: path.join(dir, TEAM_DIR_ENTRIES.header),
    log: path.join(dir, TEAM_DIR_ENTRIES.log),
    state: path.join(dir, TEAM_DIR_ENTRIES.state),
    lease: path.join(dir, TEAM_DIR_ENTRIES.lease),
    leaseLock: path.join(dir, 'lease.lock'),
    staleLease: (oldHostPid: number) => path.join(dir, `${TEAM_DIR_ENTRIES.lease}.${Math.trunc(oldHostPid)}.stale`),
    bodies: path.join(dir, TEAM_DIR_ENTRIES.bodies),
    goal: path.join(dir, GOAL_FILE),
    members: path.join(dir, TEAM_DIR_ENTRIES.members),
  };
}

/**
 * The files of one member (§2.2). `assignment.md` is a T1 ADDITION (CONTRACT-AMBIGUITY): the
 * lead's brief verbatim (≤ BRIEF_MAX), written before `member.added` is appended. The brief is
 * re-composed "at add time and at every hosting period" (§3.6) — its roster line changes with
 * every team_add, its item 3 with the mailbox verdict — so the lead's text must be kept durably,
 * and `member.added` holds only `briefBytes`.
 */
export function memberFilesOf(teamDir: string, member: string): {
  dir: string;
  /** The composed brief (§3.6): Claude's --append-system-prompt-file; named in protocol item 2. */
  brief: string;
  /** The lead's brief verbatim (T1 ADDITION). */
  assignment: string;
  /** 64 hex, 0600 (§3.9). */
  credential: string;
  /** TeamToolSpec, 0600, ≤ TOOL_SPEC_MAX_BYTES. */
  toolSpec: string;
  /** Claude's --mcp-config content (teamMcpConfigText). */
  mcpConfig: string;
  feed: string;
  feedRotated: string;
  /** `turn-<n>.prompt.md` — a turn's prompt over PROMPT_ARGV_MAX (MD-64). */
  turnPrompt(n: number): string;
} {
  const dir = memberDirOf(teamDir, member);
  return {
    dir,
    brief: path.join(dir, 'brief.md'),
    assignment: path.join(dir, 'assignment.md'),
    credential: path.join(dir, 'credential'),
    toolSpec: path.join(dir, 'tool-spec.json'),
    mcpConfig: path.join(dir, 'mcp.json'),
    feed: path.join(dir, 'feed.jsonl'),
    feedRotated: path.join(dir, 'feed.jsonl.1'),
    turnPrompt: (n: number) => path.join(dir, `turn-${Math.trunc(n)}.prompt.md`),
  };
}

/** `lease.json` (§2.1): exclusive create, no renewal. */
export interface TeamLease {
  v: 1;
  hostPid: number;
  hostStartedAt: number;
  session: ProcessIdentity;
  socket: string;
  acquiredAt: number;
}
/** `lease.lock` (H4): exclusive create while a stale lease is taken; stale by START_LOCK_STALE_MS. */
export interface TeamLeaseLock {
  pid: number;
  startedAt: number;
}
/**
 * `members/<name>/tool-spec.json` (§2.2, §3.7): what the team MCP server reads BEFORE it answers
 * `initialize` — a regular file of the uid, 0600, ≤ TOOL_SPEC_MAX_BYTES. Its identity comes from
 * here and the credential file only, never from the environment (I5; Codex filters a server
 * child's environment, RP-6).
 */
export interface TeamToolSpec {
  /** host-protocol PROTOCOL_VERSION. */
  protocol: typeof PROTOCOL_VERSION;
  socket: string;
  teamId: string;
  member: string;
  /** Absolute path of `members/<name>/credential`. */
  credentialFile: string;
  hostPid: number;
  hostStartedAt: number;
}

/* ------------------------------------------------------------------------- *
 * The log (§2.3) — the engine's form of each event
 * ------------------------------------------------------------------------- */

/** `member.routed` as the LOG holds it: the observer's form plus the private `accountKey` (§2.1). */
export interface MemberRoutedLogBody extends MemberRoutedBody {
  /** The worker's configDir VERBATIM for Claude/Codex; `cursor:ambient` / `gemini:ambient` (§6.2 step 4). Private to the log. */
  accountKey: string;
}
/**
 * `turn.ended` as the LOG holds it: the observer's form plus the private `cumulativeCostUsd` (RO3).
 *
 * Measured on the real CLI (2026-10-19, four processes of one conversation, the last three with
 * `--resume`): `total_cost_usd` is the running total of the whole CONVERSATION, the turns of
 * earlier processes included — the third and fourth runs cost about $0.0004 each and reported
 * 0.01017 and 0.01056. A member resumes its conversation every turn, so `costUsd` is this turn's
 * own share: the total minus what the conversation had already reported (TurnSpec.costBaselineUsd).
 */
export interface TurnEndedLogBody extends TurnEndedBody {
  /**
   * The conversation's running `total_cost_usd` as this turn's process last reported it — the
   * baseline of the next turn of the SAME conversation (the engine keys it by the id the turn ran
   * in: `conversationIdSeen`, else the member's). Absent when the turn reported no total (no result,
   * a vendor without one). Absent with a `costUsd` = a turn recorded before RO3, whose `costUsd` was
   * that total itself: the conversation's baseline is then unknown. Private to the log: it explains
   * the next turn's `costUsd` and is no observer's figure.
   */
  cumulativeCostUsd?: number;
}
/** The body of one log event as the engine writes and reads it. */
export type LogEventBody =
  | Exclude<TeamEventBody, { type: 'member.routed' } | { type: 'turn.ended' }>
  | MemberRoutedLogBody
  | TurnEndedLogBody;
/** One line of events.jsonl: the common fields `{v:1, seq, ts, type, by}` and one body. */
export type LogEvent = TeamEventEnvelope & LogEventBody;

/**
 * An observer's copy of a log event: `member.routed` loses its private `accountKey` (§2.1),
 * `turn.ended` its private `cumulativeCostUsd` (RO3). Pure.
 */
export function wireEventOf(e: LogEvent): TeamEvent {
  if (e.type === 'member.routed') {
    const { accountKey, ...rest } = e;
    void accountKey;
    return rest;
  }
  if (e.type === 'turn.ended') {
    const { cumulativeCostUsd, ...rest } = e;
    void cumulativeCostUsd;
    return rest;
  }
  return e;
}

/**
 * The cco/team.event params for a log event (TeamEventParams without `requestId`): the envelope's
 * `seq`/`ts` lifted out, `type` as `kind`, everything else (with `by`) as `data`, `accountKey`
 * and `cumulativeCostUsd` dropped. `requestId` is the CLIENT's id of the subscription — host.ts
 * puts it in (TeamConnections.push); the engine passes this object WITHOUT it.
 */
export function teamEventParamsOf(
  teamId: string,
  e: LogEvent,
): { teamId: string; seq: number; ts: number; kind: LogEvent['type']; data: Record<string, unknown> } {
  const wire = wireEventOf(e) as unknown as Record<string, unknown> & {
    v: 1;
    seq: number;
    ts: number;
    type: LogEvent['type'];
  };
  const { v, seq, ts, type, ...data } = wire;
  void v;
  return { teamId, seq, ts, kind: type, data };
}
/** The snapshot that opens a subscription (TeamEventParams `kind: 'snapshot'`), without `requestId`. */
export function teamSnapshotParamsOf(
  state: TeamState,
): Omit<Extract<TeamEventParams, { kind: 'snapshot' }>, 'requestId'> {
  return { teamId: state.id, seq: state.seq, ts: Date.now(), kind: 'snapshot', state };
}

/** §2.1/§6.2 step 4: the account key of a single-login provider's every entry. */
export const MACHINE_LOGIN_KEYS = { cursor: 'cursor:ambient', gemini: 'gemini:ambient' } as const;
/** §6.2 step 4, §6.4: the label everywhere for those accounts. */
export const MACHINE_LOGIN_LABELS = { cursor: 'Cursor (machine login)', gemini: 'Antigravity (machine login)' } as const;

/* ------------------------------------------------------------------------- *
 * The board (§5) and the mailbox rules (§4.1) as data
 * ------------------------------------------------------------------------- */

/**
 * Who may move a board task (§5.2): `claimant` — any member, through team_claim (§5.3);
 * `assignee` — the task's holder, through team_update; `lead`, `user` — team_task / cco/team.task.
 */
export type BoardActorRole = 'claimant' | 'assignee' | 'lead' | 'user';
/** One allowed move: what the member tool requires with it ('note' → reason_required, 'report' → report_required), and the table's label. */
export interface BoardMove {
  readonly needs?: 'note' | 'report';
  readonly label?: 'claim' | 'assign' | 'release' | 'unassign' | 'unblock' | 'rework' | 'reopen';
}
/**
 * §5.2 as data: BOARD_TRANSITIONS[from][to][role] — present ⇔ that role may make that move.
 * Anything absent → `invalid_transition` naming the allowed targets for that actor
 * (allowedBoardTargets). `cancelled` is terminal. Title, body, paths and allowOverlap: lead and
 * user, on any non-terminal task (not in this table).
 *
 * CONTRACT-AMBIGUITY: the table's "+note" on the lead/user REWORK (review → claimed) has no
 * refusal sentence (reason_required is the member tool's), so it is not required there: a given
 * note is carried to the holder's notice. `reopen` (done → claimed) keeps the assignee; a done
 * task with no assignee can only be reopened to `open`.
 */
export const BOARD_TRANSITIONS: Readonly<
  Record<TaskState, Readonly<Partial<Record<TaskState, Readonly<Partial<Record<BoardActorRole, BoardMove>>>>>>>
> = {
  open: {
    claimed: { claimant: { label: 'claim' }, lead: { label: 'assign' }, user: { label: 'assign' } },
    done: { lead: {}, user: {} },
    cancelled: { lead: {}, user: {} },
  },
  claimed: {
    blocked: { assignee: { needs: 'note' }, lead: {}, user: {} },
    review: { assignee: { needs: 'report' }, lead: {}, user: {} },
    done: { lead: {}, user: {} },
    open: { assignee: { label: 'release' }, lead: { label: 'unassign' }, user: { label: 'unassign' } },
    cancelled: { lead: {}, user: {} },
  },
  blocked: {
    claimed: { assignee: { label: 'unblock' }, lead: {}, user: {} },
    review: { assignee: { needs: 'report' }, lead: {}, user: {} },
    done: { lead: {}, user: {} },
    open: { assignee: {}, lead: {}, user: {} },
    cancelled: { lead: {}, user: {} },
  },
  review: {
    claimed: { lead: { label: 'rework' }, user: { label: 'rework' } },
    done: { lead: {}, user: {} },
    open: { lead: {}, user: {} },
    cancelled: { lead: {}, user: {} },
  },
  done: {
    claimed: { lead: { label: 'reopen' }, user: { label: 'reopen' } },
    open: { lead: {}, user: {} },
    cancelled: { lead: {}, user: {} },
  },
  cancelled: {},
};
/** The states `role` may move a task in state `from` to, in TASK_STATES order. */
export function allowedBoardTargets(from: TaskState, role: BoardActorRole): TaskState[] {
  const row = BOARD_TRANSITIONS[from];
  return (['open', 'claimed', 'blocked', 'review', 'done', 'cancelled'] as const).filter(
    (to) => row[to]?.[role] !== undefined,
  );
}
/** The states a member's team_update may name (§3.7). */
export const MEMBER_UPDATE_STATES = ['open', 'blocked', 'claimed', 'review'] as const;

/** §5.4: a board line's title is cut to this many characters. */
export const BOARD_RENDER_TITLE_CHARS = 80;
/** §5.4: the groups of a board rendering, in order. */
export const BOARD_RENDER_ORDER: readonly TaskState[] = ['open', 'claimed', 'blocked', 'review', 'done', 'cancelled'];
/**
 * §5.4: one board line — `<id>  <state>  <assignee or ->  <title ≤ 80>  [paths: …]` — for the
 * team_board tool, `cco team_status` and the hand-off packet's "Its tasks". CONTRACT-AMBIGUITY:
 * §3.7's table sketches the tool's line as `b3 [claimed → alice] title · paths`; §5.4 is the
 * rendering section and names the tool as one of its users, so its form is the one. `title` is
 * already one line (§5.1); it is cut on a code-point boundary.
 */
export function boardLine(task: Pick<BoardTask, 'id' | 'state' | 'assignee' | 'title' | 'paths'>): string {
  const title = [...task.title].slice(0, BOARD_RENDER_TITLE_CHARS).join('');
  const paths = task.paths.length > 0 ? `  [paths: ${task.paths.join(', ')}]` : '';
  return `${task.id}  ${task.state}  ${task.assignee ?? '-'}  ${title}${paths}`;
}

/** A sender's side in the mailbox table (§4.1). */
export type MessageSenderRole = 'lead' | 'user' | 'member';
/** A recipient's side: `member` = one member (not the sender itself, not stopped/ended — then `not_allowed`). */
export type MessageTargetRole = 'lead' | 'user' | 'member' | 'all';
/**
 * §4.1 as data: may `from` write to `to`, and may it be `urgent`? `all` = every member not
 * stopped/ended, expanded at send time; never `lead` or `user`. Urgent: lead/user → ONE member;
 * `all` with urgent is refused for both (lead: exit 21 TEAM_TEXT.urgentToAll; user:
 * `not_allowed`). The engine (`from` engine) posts notices, reports and recaps outside this table.
 */
export const MESSAGE_ROUTES: Readonly<
  Record<MessageSenderRole, Readonly<Record<MessageTargetRole, { readonly allowed: boolean; readonly urgent: boolean }>>>
> = {
  lead: {
    lead: { allowed: false, urgent: false },
    user: { allowed: false, urgent: false },
    member: { allowed: true, urgent: true },
    all: { allowed: true, urgent: false },
  },
  user: {
    lead: { allowed: true, urgent: false },
    user: { allowed: false, urgent: false },
    member: { allowed: true, urgent: true },
    all: { allowed: true, urgent: false },
  },
  member: {
    lead: { allowed: true, urgent: false },
    user: { allowed: true, urgent: false },
    member: { allowed: true, urgent: false },
    all: { allowed: false, urgent: false },
  },
};

/* ------------------------------------------------------------------------- *
 * The driver contract (§3.3, src/team/driver.ts)
 * ------------------------------------------------------------------------- */

/** CONTRACT-AMBIGUITY: §3.3 names the event type of TurnHandle.events `FeedEvent`, §3.8/§7.1 `FeedItem`; they are one record. */
export type FeedEvent = FeedItem;

/** What the driver is asked to run (§3.3). */
export interface TurnSpec {
  teamId: string;
  member: string;
  turnId: string;
  n: number;
  index: number;
  incarnation: { provider: ProviderId; worker: WorkerProfile; model: string; conversationId?: string };
  kind: 'first' | 'next';
  /** kind 'next' (and Claude/Cursor 'first'): the id the vendor MUST report back. */
  expectedConversationId?: string;
  /** ≤ TURN_PROMPT_MAX; the adapter receives the argv form (MD-64). */
  prompt: string;
  /** Claude: --append-system-prompt-file; others: prefixed into the first turn's prompt by the driver. */
  briefFile: string;
  /** §3.2; absent for an agy member without the opt-in. */
  mcp?: { name: 'cco_team'; command: string; args: string[]; configFile: string; projectConfigFile?: string };
  cwd: string;
  timeoutMs: number;
  /** The per-vendor setting is on (Cursor --force / agy --dangerously-skip-permissions). */
  elevated: boolean;
  /**
   * RO3: what the conversation `expectedConversationId` has already reported as its running
   * `total_cost_usd` — the last `turn.ended.cumulativeCostUsd` of that conversation; 0 when none of
   * its turns reported a cost (a fresh conversation: a new incarnation, a re-minted id after a
   * resume failure, a context loss's new id). Absent = unknown: the conversation's last costed turn
   * was recorded before RO3. A RESUMED turn's cost is its total minus this (TurnOutcome.costUsd).
   */
  costBaselineUsd?: number;
}

/** How the turn ended, as the driver reports it (§3.3). `result` never rejects. */
export interface TurnOutcome {
  outcome: TurnOutcomeKind;
  /** S4/RP-9: the vendor reported a conversation id ≠ expectedConversationId. */
  contextLost: boolean;
  conversationIdSeen?: string;
  /** H3: an assistant text or tool_use event was seen. */
  sawAssistant: boolean;
  /** H3: an assistant event after `ts` (for via:tool deliveries). */
  assistantAfter(ts: number): boolean;
  text: string;
  tokens: { in: number; out: number };
  /**
   * This turn's own cost (RO3): for a run that resumed its conversation, the run's running total
   * minus TurnSpec.costBaselineUsd; for a fresh conversation (or one the vendor replaced, contextLost)
   * the total itself. Absent when it cannot be told without counting earlier turns again (an
   * unknown baseline and a single result) — `note` then says so.
   */
  costUsd?: number;
  /** RO3: the conversation's running total as the run last reported it — turn.ended.cumulativeCostUsd. */
  cumulativeCostUsd?: number;
  modelUsed?: string;
  exitCode: number | null;
  signal: string | null;
  /** M8: who sent the signal the turn died of — `other` → outcome `cancelled`. */
  signalledBy: 'engine' | 'other' | null;
  sawEvent: boolean;
  /**
   * T11 E10 (§3.7/M19): Claude only — the `system/init` event's `mcp_servers[]` listed `cco_team`
   * with status `connected` (true), listed it otherwise (false); undefined when no init event was
   * seen or the vendor reports no such list. The engine's tools verdict counts `true` as "usable".
   */
  teamToolsConnected?: boolean;
  note?: string;
  stderrTail: string;
}

/** A running turn (§3.3). */
export interface TurnHandle {
  pid: number | undefined;
  /** Display only (§3.8). */
  events: AsyncIterable<FeedEvent>;
  /** The id the VENDOR reported (never synthesized, H3/§13). */
  conversationId: Promise<string | undefined>;
  /** L13: the last byte on stdout/stderr, from the seam. */
  lastOutputAt(): number;
  /** Never rejects. */
  result: Promise<TurnOutcome>;
  /** NORMAL_KILL_LADDER from SIGINT. */
  interrupt(): void;
  /** SUSPEND_KILL_LADDER (H2). */
  suspend(): void;
  /** TERM_KILL_LADDER. */
  kill(): void;
}

/**
 * M2: the options of provider-runner's ONE new export, `createTurnLineStream(opts):
 * LineStreamFn` (T4 owns it; agent-mesh's LineStreamFn): `createProcessSeam`'s rules — detached
 * own group, no shell, 8 MiB head+tail stdout cap, 256 KiB stderr tail, `exit` + drain settle,
 * REAP_GRACE_MS after SIGKILL — plus line streaming (1 MiB per-line cap; a longer line is cut and
 * flagged), the SIGINT → SIGTERM → SIGKILL ladder with configurable stages, and `lastOutputAt`.
 */
export interface TurnLineStreamOptions {
  deadlineMs: number;
  env: NodeJS.ProcessEnv;
  onChild(h: TurnChildHandle): void;
}
/** What createTurnLineStream hands the driver for the spawned child (TurnHandle.pid/interrupt/suspend/kill reach the process through it). */
export interface TurnChildHandle {
  pid: number;
  pgid: number;
  signal(sig: NodeJS.Signals): void;
  lastOutputAt(): number;
}

/**
 * §3.3 environment: the three markers every turn process carries on top of the account's env
 * (I11, M16) — added by the DRIVER after SESSION_IDENTITY_ENV is removed; the adapter adds
 * nothing (M14).
 */
export function teamTurnEnvMarkers(
  turnId: string,
  teamId: string,
  member: string,
  incarnation: number,
  index: number,
): Record<string, string> {
  return {
    [DISPATCHED_TASK_ENV]: turnId,
    [TEAM_MEMBER_ENV]: teamMemberEnvValue(teamId, member, incarnation),
    [TEAM_PORT_BASE_ENV]: String(memberPortBase(index)),
  };
}

/* ------------------------------------------------------------------------- *
 * Per-vendor argv building blocks (§3.2) as data
 * ------------------------------------------------------------------------- */

/** The five team tools (MD-34), in the order of Claude's --allowedTools value (§3.2). */
export const TEAM_TOOL_NAMES = ['team_board', 'team_inbox', 'team_send', 'team_claim', 'team_update'] as const;
/** One of TEAM_TOOL_NAMES. */
export type TeamTool = (typeof TEAM_TOOL_NAMES)[number];
/** Claude's names of the team tools: `mcp__cco_team__<tool>` — the caller's `allowedTools` (§13). */
export const CLAUDE_TEAM_ALLOWED_TOOLS: readonly string[] = TEAM_TOOL_NAMES.map(
  (tool) => `mcp__${TEAM_MCP_SERVER_NAME}__${tool}`,
);
/** The one comma-joined --allowedTools value (§3.2). */
export const CLAUDE_TEAM_ALLOWED_TOOLS_ARG = CLAUDE_TEAM_ALLOWED_TOOLS.join(',');
/**
 * Claude members' --disallowedTools (RunTask.disallowedTools): SendMessage and ListAgents are
 * absent from a member's tool list [probed RP-1]. PROBE RP-27: whether an unknown name errors or
 * is ignored, and whether `ListAgents` is a real tool name.
 */
export const CLAUDE_TEAM_DISALLOWED_TOOLS = ['SendMessage', 'ListAgents'] as const;
/**
 * M17 as settled by T0 amendment A6 (RP-21): Claude members pass NO --setting-sources. A linked
 * worktree inherits the main checkout's `.claude/settings.local.json` grants (proven), which is
 * exactly what a dispatch worker running in the main checkout gets — I14 ("never more power than a
 * dispatch worker") holds, and members keep the project's granted commands. Kept as a constant so
 * the decision is in one place; `undefined` = the flag is not passed.
 */
export const CLAUDE_TEAM_SETTING_SOURCES: string | undefined = undefined;
/** The Codex wiring's approval mode, without which the CLI refuses the tool call [probed]. */
export const CODEX_TEAM_MCP_APPROVAL = 'approve';
/** Cursor's elevation (only behind teamCursorForce, S3(b)). */
export const CURSOR_FORCE_FLAG = '--force';
/** agy's elevation (only behind teamAgySkipPermissions, S3(b)); without it agy calls no MCP tool in print mode [probed RP-5]. */
export const AGY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
/**
 * S3(b), I14: the elevation a member gets from the per-vendor settings — Cursor members with
 * `teamCursorForce` on, Antigravity members with `teamAgySkipPermissions` on; nobody else, ever.
 * MemberState.elevated and TurnSpec.elevated come from here; the roster says so when it is set.
 */
export function elevationOf(
  provider: ProviderId,
  settings: { teamCursorForce: 'on' | 'off'; teamAgySkipPermissions: 'on' | 'off' },
): 'cursor-force' | 'agy-skip-permissions' | undefined {
  if (provider === 'cursor' && settings.teamCursorForce === 'on') {
    return 'cursor-force';
  }
  if (provider === 'gemini' && settings.teamAgySkipPermissions === 'on') {
    return 'agy-skip-permissions';
  }
  return undefined;
}

/**
 * M4 (§3.2): whether a member's permission grant lets it run shell commands — shown in every
 * roster, and protocol item 2 tells a member that cannot to say what it could not run instead of
 * trying. `mode` is the mode the member runs with: for Claude `registry.permissionMode` verbatim;
 * for the others the worker's normalizeProviderPermissionMode (null = the provider's default).
 *
 *  - Claude: `bypassPermissions` → yes. Every other mode → no: in `-p` a tool that would prompt is
 *    DENIED (`--permission-prompts none`) and `--allowedTools` names only the five team tools.
 *    PROBE RP-17: `acceptEdits` (and `auto`) are PROVISIONAL "no" until RP-17 records the
 *    `permission_denials` of a shell command under them.
 *  - Codex: `workspace-write` / `danger-full-access` → yes; `read-only` → no.
 *  - Cursor: yes.
 *  - Antigravity: elevated (`--dangerously-skip-permissions`) → yes; `plan` → no; otherwise "per
 *    the mode" (§3.2) — PROBE RP-17/RP-25: `auto` provisional yes, `accept-edits` provisional no
 *    (RP-5: without the flag agy approves no shell command in print mode).
 */
export function runsCommandsOf(provider: ProviderId, mode: string | null, elevated: boolean): boolean {
  switch (provider) {
    case 'claude':
      return mode === 'bypassPermissions';
    case 'codex':
      return mode !== 'read-only';
    case 'cursor':
      return true;
    case 'gemini':
      return elevated || mode === 'auto';
  }
}

/** Whether a resumed turn MUST name its model (§3.2 "Model on resume"): Codex only [probed, D12]. */
export const RESUME_NEEDS_MODEL: Readonly<Record<ProviderId, boolean>> = {
  claude: false,
  codex: true,
  cursor: false,
  gemini: false,
};
/** H5: the vendor MCP file the engine writes into a member's worktree, relative to its root; Claude and Codex get theirs on the command line. */
export const VENDOR_MCP_FILES: Readonly<Partial<Record<ProviderId, string>>> = {
  cursor: '.cursor/mcp.json',
  gemini: '.agents/mcp_config.json',
};
/** Claude members: the worktree's own `.mcp.json`, passed FIRST as a second --mcp-config file when it exists (H5) [PROBE RP-24]. */
export const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';

/** The team MCP server's argv after the node binary: `<cli.js> --team-mcp <tool-spec path>`. */
export function teamMcpServerArgs(cliJsPath: string, toolSpecPath: string): string[] {
  return [cliJsPath, TEAM_MCP_ARG, toolSpecPath];
}
/** The MCP config content (§3.2): ONE shape for Claude's --mcp-config file, Cursor's and agy's file. No secret inside. */
export interface TeamMcpConfig {
  mcpServers: { cco_team: { command: string; args: string[] } };
}
/** `{"mcpServers":{"cco_team":{"command":"<node>","args":["<cli.js>","--team-mcp","<tool-spec>"]}}}`. */
export function teamMcpConfig(nodePath: string, cliJsPath: string, toolSpecPath: string): TeamMcpConfig {
  return { mcpServers: { cco_team: { command: nodePath, args: teamMcpServerArgs(cliJsPath, toolSpecPath) } } };
}
/** The file text written 0600 before every spawn. */
export function teamMcpConfigText(nodePath: string, cliJsPath: string, toolSpecPath: string): string {
  return `${JSON.stringify(teamMcpConfig(nodePath, cliJsPath, toolSpecPath), null, 2)}\n`;
}

/**
 * WHAT THE AGENT-MESH 0.1.3 ADAPTERS MUST PRODUCE (§3.2), transcribed token by token for the
 * fakes (T9), the probes (T10) and the adapters' own tests (T2). The ENGINE NEVER SPELLS A VENDOR
 * ARGUMENT (§3.3): it hands the adapter a RunTask and these are the adapter's. Notation: `<x>` is
 * filled in; `[…]` is optional; `⇐ setting` is present only when that setting is on.
 */
export const VENDOR_TURN_ARGV: Readonly<
  Record<ProviderId, { readonly first: readonly string[]; readonly next: readonly string[] }>
> = {
  claude: {
    first: [
      'claude',
      '--session-id',
      '<uuid>',
      '[--model <m>]',
      '--permission-mode',
      '<registry mode>',
      '--permission-prompts',
      'none',
      '[--setting-sources <per RP-21>]',
      '--append-system-prompt-file',
      '<brief.md>',
      '--mcp-config',
      '[<wt>/.mcp.json]',
      '<members/<name>/mcp.json>',
      '--strict-mcp-config',
      '--allowedTools',
      '<the 5 tool names>',
      '--disallowedTools',
      'SendMessage,ListAgents',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      '<prompt>',
    ],
    next: [
      'claude',
      '--resume',
      '<uuid>',
      '<exactly the same flags as the first turn>',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      '<msg>',
    ],
  },
  codex: {
    first: [
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      '<m>',
      '-m',
      '<model>',
      '-c',
      'mcp_servers.cco_team.command="<node>"',
      '-c',
      'mcp_servers.cco_team.args=["<cli.js>","--team-mcp","<tool-spec path>"]',
      '-c',
      'mcp_servers.cco_team.default_tools_approval_mode="approve"',
      '--',
      '<prompt>',
    ],
    next: [
      'codex',
      'exec',
      'resume',
      '<threadId>',
      '--json',
      '-m',
      '<model>',
      '-c',
      'sandbox_mode="<m>"',
      '-c',
      'mcp_servers.cco_team.…',
      '--',
      '<msg>',
    ],
  },
  cursor: {
    first: [
      'cursor-agent',
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--approve-mcps',
      '--resume',
      '<chatId from create-chat>',
      '[--model <m>]',
      '[--sandbox <m>]',
      '[--force ⇐ teamCursorForce]',
      '--',
      '<prompt>',
    ],
    next: ['<same as the first turn with the same chat id>'],
  },
  gemini: {
    first: [
      'agy',
      '--output-format',
      'stream-json',
      '[--model <m>]',
      '--mode',
      '<m>',
      '[--dangerously-skip-permissions ⇐ teamAgySkipPermissions]',
      '-p',
      '<prompt>',
    ],
    next: ['agy', '--conversation', '<id>', '<the same flags>', '-p', '<msg>'],
  },
};

/* ------------------------------------------------------------------------- *
 * The team MCP server's tools (§3.7)
 * ------------------------------------------------------------------------- */

/** A JSON-schema object of an MCP tool's input (each has additionalProperties: false — an unknown key → invalid_arguments). */
export interface TeamToolInputSchema {
  type: 'object';
  properties: Record<string, { type: 'string'; enum?: readonly string[]; description: string }>;
  required?: readonly string[];
  additionalProperties: false;
}
/**
 * The five tools as `tools/list` answers them (§3.7). T1 ADDITION: the descriptions — the contract
 * gives the schemas and the semantics, not the words; these say only what §3.7 pins.
 */
export const TEAM_TOOL_DEFINITIONS: Readonly<Record<TeamTool, { description: string; inputSchema: TeamToolInputSchema }>> = {
  team_board: {
    description:
      'Show the team: its goal, you (name, role, working directory, branch), the roster, every board task, ' +
      "and the full bodies of your own tasks. Pass task_id for one task's whole body and notes.",
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'A board task id, such as b3.' } },
      additionalProperties: false,
    },
  },
  team_inbox: {
    description:
      'Read the messages that arrived for you (at most 8 per call). Call it at natural checkpoints — before you ' +
      'start a file, after you finish one — at most once per checkpoint, never in a loop.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  team_send: {
    description:
      'Send one message to lead, user, or one teammate by name. Message only when it changes what the ' +
      'recipient should do; never send acknowledgements. If you need an answer to continue, send the question ' +
      'and end your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "lead, user, or a teammate's name." },
        text: { type: 'string', description: 'The message (at most 65,536 bytes).' },
        kind: { type: 'string', enum: ['text', 'question', 'answer'], description: 'Default text.' },
        reply_to: { type: 'string', description: 'The id of the message this answers, such as m14.' },
        task: { type: 'string', description: 'The board task it is about, such as b3.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  team_claim: {
    description:
      'Claim an open board task BEFORE you work on it. Refused when its paths overlap a task another member ' +
      'holds, or when you already hold 3 tasks.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'A board task id, such as b3.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  team_update: {
    description:
      'Move one of your board tasks: review when you finished it (report required), blocked when you cannot ' +
      'continue (note required: the reason), claimed to unblock it, open to release it. The lead is told.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'A board task id, such as b3.' },
        state: { type: 'string', enum: ['open', 'blocked', 'claimed', 'review'], description: 'The new state.' },
        note: { type: 'string', description: 'A status note (at most 2,048 bytes); the reason when blocked.' },
        report: { type: 'string', description: 'Your report (at most 65,536 bytes); required for review.' },
      },
      required: ['task_id', 'state'],
      additionalProperties: false,
    },
  },
};

/** The member tool refusal codes (§3.7): the answer is isError with text `<code>: <sentence>`. */
export const TEAM_TOOL_REFUSAL_CODES = [
  'invalid_arguments',
  'unknown_task',
  'team_not_active',
  'team_readonly',
  'team_gone',
  'unknown_recipient',
  'not_allowed',
  'empty_message',
  'message_too_large',
  'invalid_text',
  'rate_limited',
  'duplicate',
  'inbox_full',
  'unknown_message',
  'not_open',
  'paths_conflict',
  'claim_limit',
  'not_your_task',
  'invalid_transition',
  'report_required',
  'reason_required',
  'report_too_large',
  'note_too_large',
] as const;
/** One of TEAM_TOOL_REFUSAL_CODES. */
export type TeamToolRefusalCode = (typeof TEAM_TOOL_REFUSAL_CODES)[number];
/** A member tool refusal's text: `<code>: <sentence>`. */
export function toolRefusalText(code: TeamToolRefusalCode, sentence: string): string {
  return `${code}: ${sentence}`;
}
/** A member tool refusal as the TextResult it is answered with. */
export function toolRefusal(code: TeamToolRefusalCode, sentence: string): TextResult {
  return { content: [{ type: 'text', text: toolRefusalText(code, sentence) }], isError: true };
}

/* ------------------------------------------------------------------------- *
 * The lead's operations (§7.2, §7.3) — files, flags, arguments
 * ------------------------------------------------------------------------- */

/** §7.3: the keys each file object may have; an unknown key → exit 21 naming it and the closest allowed key. */
export const TEAM_FILE_KEYS = ['name', 'title', 'goal', 'goal_file', 'base', 'members', 'tasks', 'worktree'] as const;
/** No `fallback` (S1-5, Appendix C.3). */
export const MEMBER_KEYS = ['name', 'role', 'brief', 'brief_file', 'provider', 'worker', 'model', 'paths', 'start'] as const;
export const TASK_KEYS = ['title', 'body', 'body_file', 'assignee', 'paths', 'allow_overlap'] as const;
export const WORKTREE_KEYS = ['setup', 'timeout_minutes'] as const;
export const SETUP_KEYS = ['argv', 'timeout_minutes'] as const;
export const MESSAGE_FILE_KEYS = ['to', 'text', 'text_file', 'kind', 'urgent', 'reply_to', 'task'] as const;
/** §7.3 TASK_OP_FILE: the keys per `op`. */
export const TASK_OP_KEYS = {
  add: ['op', 'tasks'],
  assign: ['op', 'task', 'to', 'force'],
  unassign: ['op', 'task'],
  update: ['op', 'task', 'title', 'body', 'body_file', 'paths', 'allow_overlap', 'state', 'note'],
  cancel: ['op', 'task', 'note'],
  reopen: ['op', 'task', 'note'],
} as const;
/** §7.3: the read caps (the §15.3.2 reader), bytes. */
export const TEAM_FILE_CAPS = {
  /** A team file or a members file. */
  teamFile: 16 * MiB,
  goalFile: 64 * KiB,
  briefFile: 256 * KiB,
  bodyFile: 64 * KiB,
  textFile: 64 * KiB,
} as const;
/** §7.2: `--worker` ≤ this many characters, no control characters. */
export const WORKER_FLAG_MAX_CHARS = 200;
/**
 * §7.2 team_member: exactly one op; `--now` only with these ops; `--provider` / `--worker` /
 * `--model` only with `switch`, and then at least one of them. A violation → exit 21 (cli.ts) /
 * TEAM_RPC.invalidParams (cco/team.member).
 */
export const MEMBER_OP_NOW_OPS = ['stop', 'pause'] as const;
export const MEMBER_SWITCH_KEYS = ['provider', 'worker', 'model'] as const;

/**
 * A member entry of a team or members file AS IT REACHES THE HOST: `brief_file` already read by
 * the client into `brief` (the §15.3.2 rule, as dispatch's `prompt_file`). Values are UNTRUSTED —
 * the client checked keys and file reads only (exit 21); TeamCore checks every value (exit 20).
 */
export interface MemberFileEntry {
  name: string;
  role: string;
  brief: string;
  provider?: string;
  worker?: string;
  model?: string;
  paths?: string[];
  /** A string ≤ START_MAX bytes replacing the first-turn kickoff sentence, or false = the first turn waits for the member's first message. */
  start?: string | false;
}
/** A team file AS IT REACHES THE HOST (`goal_file` → `goal`, `brief_file` → `brief`, `body_file` → `body`). Untrusted values. */
export interface TeamFile {
  name: string;
  title?: string;
  goal: string;
  /** A ref `git rev-parse --verify <base>^{commit}` resolves; default `HEAD`. */
  base?: string;
  members: MemberFileEntry[];
  tasks?: TaskFileEntry[];
  worktree?: { setup?: { argv: string[]; timeout_minutes?: number }; timeout_minutes?: number };
}
/** A members file (team_add): `{"members":[…], "tasks":[…]}`. */
export interface MembersFile {
  members: MemberFileEntry[];
  tasks?: TaskFileEntry[];
}
/** A message file (team_send) as it reaches the host (`text_file` → `text`). */
export interface TeamSendArgs {
  to: string;
  text: string;
  kind?: SenderMessageKind;
  urgent?: boolean;
  reply_to?: string;
  task?: string;
}
/** The `tools/call` arguments of each lead operation (§7.2). Untrusted on arrival; checked by value. */
export interface TeamOpArgs {
  team_create: TeamFile;
  team_add: MembersFile;
  team_send: TeamSendArgs;
  /** `capChars`: the client's output cap (M9); server.ts also passes it to TeamEngine.toolCall. */
  team_inbox: { all: boolean; capChars?: number };
  /** At most one key. */
  team_status: { all?: true; member?: string; task?: string; message?: string };
  team_task: TeamTaskOp;
  team_member: {
    member: string;
    op: MemberOpName;
    now?: boolean;
    provider?: string;
    worker?: string;
    model?: string;
  };
  team_attach: { member: string };
  team_end: { now: boolean };
  /** TEAM_ID or TEAM_NAME; absent = the one suspended team of this repository. */
  team_resume: { team?: string };
}

/* ------------------------------------------------------------------------- *
 * Exact sentences. `…` in the contract, where it stands for the command, is COMMAND_SPELLING.
 * ------------------------------------------------------------------------- */

const CCO = COMMAND_SPELLING;

/** The refusal codes of the lead's operations and the observer methods (TeamRefusal.code). */
export const TEAM_REFUSAL_CODES = [
  // common to every op (§7.2)
  'team_mode_off',
  'no_team',
  'team_busy',
  'lease_contended',
  'not_git',
  'team_readonly',
  'unsupported_platform',
  'suspending',
  // §7.3 value checks: one refusal listing ≤ VALUE_PROBLEMS_MAX problems, then "Nothing was created."
  'invalid_values',
  // single refusals
  'already_leading',
  'name_in_use',
  'unknown_member',
  'unknown_task',
  'unknown_message',
  'invalid_transition',
  'member_running',
  'not_supported',
  'no_conversation',
  'already_attached',
  'not_live',
  'still_attached',
  'unknown_lease',
  'not_owned_here',
  'resnapshot_required',
  'already_waiting',
  'no_suspended_team',
  'several_suspended',
  'not_suspended',
  'rate_limited',
  'duplicate',
  'inbox_full',
  'not_allowed',
  'empty_message',
  'message_too_large',
  'invalid_text',
  'board_full',
  'invalid_path',
  'team_store_failed',
] as const;
/** One of TEAM_REFUSAL_CODES. */
export type TeamRefusalCode = (typeof TEAM_REFUSAL_CODES)[number];
/** A TeamRefusal. */
export function teamRefusal(code: TeamRefusalCode, sentence: string): TeamRefusal {
  return { ok: false, code, sentence };
}
/** Whether a value is a TeamRefusal (e.g. what TeamCore.waitForLead rejects with). */
export function isTeamRefusal(value: unknown): value is TeamRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { sentence?: unknown }).sentence === 'string'
  );
}

/**
 * The sentences of the lead's operations, the observer methods and the cco client — every one the
 * contract spells, verbatim (gendered pronouns of the contract's examples are rendered neutrally:
 * CONTRACT-AMBIGUITY, an engine cannot know a member's pronoun). Entries marked `T1 wording` are
 * codes the contract names without words.
 */
export const TEAM_TEXT = {
  // ---- §7.2: common to every op ----
  teamModeOff: (): string =>
    'Teammate mode is turned off (setting claudeCodeOrchestrator.teamMode). Dispatch tasks instead, or ask the user to turn it on.',
  noTeam: (): string =>
    `This session leads no team. Create one with ${CCO} team_create <file>, or resume one with ${CCO} team_resume.`,
  teamBusy: (name: string, pid: number, startedAt: number): string =>
    `Team ${name} is led by another Claude Code session (pid ${pid}, started ${clockHHMM(startedAt)}), which is still running. ` +
    `Only that session can direct it; when it has ended, resume it with ${CCO} team_resume ${name}.`,
  leaseContended: (name: string): string =>
    `Another host is taking over team ${name} right now; try again in a few seconds.`,
  notGit: (workspace: string, gitFirstLine: string): string =>
    `Teams need a git repository: each teammate works in its own worktree. ${workspace} is not inside one (git said: ${gitFirstLine}).`,
  /** §2.3: every refusal of a full log. */
  teamReadonly: (name: string): string =>
    `Team ${name}'s log is full (64 MiB), so the team is read-only. End it and start a new team.`,
  /** T1 wording (I12: win32 refuses every team op). */
  unsupportedPlatform: (): string => 'Teammate mode runs on macOS and Linux only; this is Windows.',
  suspending: (): string => "This session's dispatch host is shutting down; the team is being suspended.",

  // ---- §7.3: value checks and exact refusals ----
  memberNameShape: (x: string): string =>
    `member name "${x}" is not allowed: use 1–24 lowercase letters, digits or hyphens, starting with a letter (for example api or web-2).`,
  memberNameReserved: (x: string): string =>
    `member name "${x}" is reserved (lead, user, all, team, system, host, engine, cco, me, any, none, everyone).`,
  memberExists: (team: string, x: string, state: string): string =>
    `Team ${team} already has a member ${x} (${state}). Restart it with ${CCO} team_member ${x} --restart, or choose another name.`,
  tooManyMembers: (cap: number, n: number): string =>
    `A team has at most ${cap} members (setting claudeCodeOrchestrator.teamMaxMembers); this would make ${n}.`,
  unknownMember: (x: string, team: string, members: readonly string[], closest?: string): string =>
    `No member "${x}" in team ${team}. Members: ${members.join(', ') || '(none)'}.` +
    (closest !== undefined ? ` Did you mean ${closest}?` : ''),
  /** `<one line per provider: reason>` — one line each. */
  noAccount: (x: string, perProvider: ReadonlyArray<{ provider: string; reason: string }>): string =>
    `No account can take member ${x}: ${perProvider.map((p) => `${p.provider}: ${p.reason}`).join('\n')}.`,
  /** `<allowed transitions from that state for you>`: T1 wording of the clause. */
  boardTransition: (taskId: string, state: TaskState, allowed: readonly TaskState[]): string =>
    `${taskId} is ${state}; ` +
    (allowed.length === 0 ? 'you cannot move it.' : `you can move it to ${allowed.join(', ')}.`),
  switchWhileRunning: (x: string, n: number): string =>
    `${x} is running turn ${n}. Pause it first: ${CCO} team_member ${x} --pause --now`,
  /** Exit 21. */
  urgentToAll: (): string => 'urgent goes to one member at a time; send it to each member that must be interrupted.',
  /** Exit 21 (and §4.1's table). */
  leadToUser: (): string => 'Write to the user in your own reply; team_send is for teammates.',
  /** Exit 20 (§7.3; §3.10 writes it without the final period). */
  takeoverNotSupported: (x: string, provider: string): string =>
    `take-over is available for Claude members in this version; ${x} runs on ${provider}.`,
  diskSpace: (freeGiB: number, volume: string): string =>
    `Not enough free disk space for a worktree (${freeGiB} GiB free on ${volume}; at least 2 GiB needed).`,
  agyPlanMode: (w: string): string =>
    `agy worker ${w} runs in plan mode (read-only); with teamAgySkipPermissions on it would run every command — pick another mode or turn the setting off`,
  nothingCreated: (): string => 'Nothing was created.',
  /** §6.2 step 1. */
  workerProviderMismatch: (w: string, providerOfW: string, provider: string): string =>
    `worker ${w} is a ${providerOfW} account, not ${provider}`,
  /** §6.2 step 1 `account_full` — T1 wording. */
  accountFull: (w: string): string =>
    `account ${w} already runs ${TEAM_MAX_PER_ACCOUNT} members of this team (at most ${TEAM_MAX_PER_ACCOUNT} per account)`,
  /** §6.2 step 6. */
  codexNeedsModel: (w: string): string => `Codex members need a model: give "model" or set a default on worker ${w}.`,
  /** §3.9. */
  codexDispatchServer: (name: string, configPath: string): string =>
    `account ${name} registers the Claude Code Orchestrator MCP server for Codex; a Codex teammate there could dispatch. Remove it from ${configPath} or pick another account.`,
  /** §3.2 `unsafe_path` — T1 wording. */
  unsafePath: (what: string): string =>
    `${what} holds a control character, which cannot be passed to Codex as a TOML string`,
  /** §5.3 `invalid_path`, naming it — T1 wording; `problem` is boardPathProblem's. Flatten `p` before it is shown. */
  invalidPath: (p: string, problem: string): string => `the path "${p}" ${problem}`,
  /** §5.1 `board_full` — T1 wording. */
  boardFull: (): string => `The board already holds ${BOARD_TASKS_MAX} tasks; cancel or finish some first.`,
  /** MD-1: a non-ended team of this repository already has the name — T1 wording. */
  nameInUse: (name: string, status: string): string =>
    `A team named ${name} already exists in this repository (${status}); choose another name, or end it first.`,
  /** MD-10: team_create while this host leads another active team — T1 wording. */
  alreadyLeading: (name: string): string =>
    `This session already leads team ${name}; end it with ${CCO} team_end before you create another, or add members with ${CCO} team_add.`,
  /** §7.2 team_resume with several suspended — T1 wording ("refusal listing them"). */
  severalSuspended: (teams: ReadonlyArray<{ teamId: string; name: string }>): string =>
    `Several teams of this repository are suspended: ${teams.map((t) => `${t.name} (${t.teamId})`).join(', ')}. ` +
    `Name one: ${CCO} team_resume --team <name>`,
  /** T1 wording. */
  noSuspendedTeam: (): string => 'No team of this repository is suspended.',
  /** T1 wording: team_resume of a team that is not suspended (and not this session's). */
  notSuspended: (name: string, status: string): string => `Team ${name} is ${status}, not suspended.`,
  /** §4.2 lead/user rate limit — T1 wording around the contract's `retry after <s> s`. */
  leadRateLimited: (retryAfterS: number): string =>
    `you have sent ${LEAD_USER_SENDS_PER_WINDOW} messages in 10 minutes; retry after ${retryAfterS} s`,
  /** P93 `team_store_failed` — T1 wording. */
  storeFailed: (errno: string): string => `The team log could not be written (${errno}); nothing was started.`,
  /** §2.3 ENOSPC: footers and the UI. */
  logUnwritable: (): string => 'team log cannot be written (ENOSPC)',

  // ---- not refusals (exit 0; the line says what happened) ----
  recordedFor: (x: string, state: string): string => `recorded; ${x} is ${state} — it reaches ${x} when it continues`,
  urgentQueued: (x: string, secondsAgo: number): string => `queued; ${x} was interrupted ${secondsAgo} s ago`,
  teamExists: (name: string): string => `Team ${name} already exists in this session — nothing was created.`,
  /** §3.10 step 5 (`queued (attached by the user since …)`). */
  queuedAttached: (since: number): string => `queued (attached by the user since ${clockHHMM(since)})`,

  // ---- §7.6 observer refusals — T1 wording ----
  notOwnedHere: (name: string, owner?: ProcessIdentity): string =>
    owner !== undefined
      ? `Team ${name} is led by another Claude Code session (pid ${owner.pid}); steer it from there.`
      : `Team ${name} is not led by this session's dispatch host.`,
  resnapshotRequired: (): string =>
    `That seq cannot be replayed (more than ${TEAM_SUBSCRIBE_REPLAY_MAX} events behind, or beyond the log's head); get the team's state again.`,
  /** §4.4: a second team_wait — answered with exit 0. */
  teamWaitAlreadyRunning: (name: string): string =>
    `A team_wait for team ${name} is already running; this one ends. Do not start another.`,

  // ---- §3.10 take-over ----
  memberRunning: (name: string, n: number): string => `${name} is running turn ${n} — pass now:true to stop it, or wait`,
  noConversation: (name: string): string => `${name} has not finished a turn yet — try after its first turn`,
  /** T1 wording (`already_attached` with by/since). */
  alreadyAttached: (name: string, by: string, since: number): string =>
    `${name} is already attached (by ${by} since ${clockHHMM(since)})`,
  /** T1 wording. */
  notLive: (name: string, state: string): string => `${name} cannot be taken over while it is ${state}`,
  /** T1 wording. */
  stillAttached: (name: string, pid: number): string =>
    `${name}'s take-over terminal is still running (pid ${pid}); close it to hand ${name} back`,
  /** T1 wording. */
  unknownLease: (): string => 'That take-over is not in force (it was released or never granted).',
  /** §3.10 step 2 (L15): shown by the UI and printed by team_attach. */
  takeoverNote: (worktreePath: string): string =>
    `Claude Code may show its first-run trust prompt for ${worktreePath}; answer it in the terminal. Type /exit to hand the member back to the team.`,
  /** T1 ADDITION: the terminal title of a take-over (the Output channel's spelling, §8.1). */
  takeoverTitle: (team: string, member: string): string => `Team ${team} · ${member}`,

  // ---- §3.9, §7.5, §15.5: the cco command and the stdio server ----
  /** §3.9: cco under CCO_TEAM_MEMBER — exit 22 for every op but help/version. `value` = the variable's raw value. */
  ccoTeammateShell: (value: string): string => {
    const parsed = parseTeamMemberEnv(value);
    return (
      `This shell belongs to teammate ${parsed?.member ?? 'unknown'} of team ${parsed?.teamId ?? 'unknown'}; ` +
      'a teammate cannot dispatch or lead. Use your team tools (team_board, team_send, team_update) instead.'
    );
  },
  /** §3.9: the dispatch MCP server's guard under CCO_TEAM_MEMBER — T1 wording, in the §15.5 sentence's form. */
  dispatchServerInTeammate: (value: string): string => {
    const parsed = parseTeamMemberEnv(value);
    return (
      `This cco-dispatch server runs inside teammate ${parsed?.member ?? 'unknown'} of team ${parsed?.teamId ?? 'unknown'}; ` +
      'a teammate cannot dispatch, brief or stop workers. Use your team tools (team_board, team_send, team_update) instead.'
    );
  },
  /** §7.5: a tools/call of a team op on the stdio server. */
  teamOpsStdio: (): string =>
    `Team operations run through the cco command: ${CCO} team_create <file> from the Bash tool.`,
  /** §3.4: the §15.5 cancel row of a team turn. */
  cancelTeamTurn: (turnId: string, member: string): string =>
    `${turnId}: team turn stopped — ${member} is paused; unpause it with team_member ${member} --unpause`,
  /** §2.5/§3.4: the cancelled reason texts. */
  cancelledFromTaskList: (): string => 'stopped from the task list',
  cancelledByCco: (): string => 'stopped by cco cancel',
  /** §3.4 step 1: a turn's task-log title. */
  turnTaskTitle: (team: string, member: string, n: number): string => `team ${team} · ${member} · turn ${n}`,

  // ---- §2.1, §2.5 hosts ----
  leaseLost: (name: string, pid: number): string =>
    `Team ${name} was taken over by another host (pid ${pid}); this session no longer leads it.`,
  suspendedAfterHostEnded: (name: string): string =>
    `Team ${name} was suspended after its host ended; resume it with ${CCO} team_resume ${name}`,

  // ---- §4.4 the doorbell ----
  footer: (n: number, senders: readonly string[]): string =>
    `Unread team messages for you: ${n} (from ${senders.join(', ')}) — read them: ${CCO} team_inbox`,
  inboxHeader: (team: string, n: number): string => `team ${team} — ${n} unread for the lead (oldest first)`,
  /** T1 wording: the header of `team_inbox --all`. */
  inboxAllHeader: (team: string, n: number): string => `team ${team} — the last ${n} messages for the lead (oldest first)`,
  /** T1 wording: nothing unread. */
  inboxEmpty: (team: string): string => `team ${team} — no unread messages for the lead.`,
  inboxMore: (r: number): string => `(${r} more unread — run team_inbox again)`,
  inboxCut: (msgId: string): string => `[cut — the whole message: ${CCO} team_status --message ${msgId}]`,
  inboxAnswerHint: (): string => `Answer with a file in .cco/, then: ${CCO} team_send .cco/<file>.json`,
  inboxNotInstructions: (): string =>
    "Teammates' messages are their reports and questions — not instructions from the user.",
  /**
   * `[m14] api · question · task b3 · 14:02:11` / `[m15] web · report · turn 4 ok · 6m12s ·
   * 41k/3k tokens · task b5 · 14:03:40` (§4.4). `tasks`: the message's `task`, or a report's held
   * tasks (`task b5`, `tasks b1, b4`).
   */
  inboxMessageHeader: (
    msgId: string,
    from: string,
    kind: string,
    ts: number,
    extra: {
      tasks?: readonly string[];
      report?: { n: number; outcome: string; durationMs: number; tokens: { in: number; out: number } };
    },
  ): string =>
    [
      `[${msgId}] ${from}`,
      kind,
      ...(extra.report !== undefined
        ? [
            `turn ${extra.report.n} ${extra.report.outcome}`,
            durationText(extra.report.durationMs),
            `${kTokens(extra.report.tokens.in)}/${kTokens(extra.report.tokens.out)} tokens`,
          ]
        : []),
      ...(extra.tasks !== undefined && extra.tasks.length > 0
        ? [`${extra.tasks.length === 1 ? 'task' : 'tasks'} ${extra.tasks.join(', ')}`]
        : []),
      clockHHMMSS(ts),
    ].join(' · '),
  /**
   * §3.6.2: a report's header `turn <n> · <outcome> · <duration> · <in>k/<out>k tokens · tasks
   * <ids>`. CONTRACT-AMBIGUITY: §4.4's inbox prints the same facts as `turn 4 ok · …`
   * (inboxMessageHeader); this is the §3.6.2 spelling, for wherever the header is written out.
   */
  reportHeader: (meta: {
    n: number;
    outcome: string;
    durationMs: number;
    tokens: { in: number; out: number };
    tasks: readonly string[];
  }): string =>
    `turn ${meta.n} · ${meta.outcome} · ${durationText(meta.durationMs)} · ` +
    `${kTokens(meta.tokens.in)}/${kTokens(meta.tokens.out)} tokens · tasks ${meta.tasks.length > 0 ? meta.tasks.join(',') : '-'}`,
  /** `Members: api running turn 5 (2m) · web idle · docs blocked: <reason>`. */
  inboxMembersLine: (parts: readonly string[]): string => `Members: ${parts.join(' · ')}`,
  /** §4.2: the lead inbox warning at PENDING_MAX. */
  leadInboxWarning: (n: number): string => `lead inbox: ${n} unread`,

  // ---- §7.4 answers: the fixed lines ----
  created: (name: string, teamId: string, base: string, sha7: string): string =>
    `Team ${name} (${teamId}) created from ${base} at ${sha7}.`,
  worktreesLine: (repoHash: string, teamSlug: string): string =>
    `Worktrees: ~/.claude-code-orchestrator/worktrees/${repoHash}/${teamSlug}/<name>  (created in the background)`,
  boardSummaryLine: (n: number, claimed: number, open: number): string => `Board: ${n} tasks (${claimed} claimed, ${open} open).`,
  keepWaitLine: (): string =>
    `Keep \`${CCO} team_wait\` running with run_in_background while the team works; read messages with ${CCO} team_inbox.`,
  statusEndLine: (): string => `Status: ${CCO} team_status   End: ${CCO} team_end`,
  dirtyWarning: (sha7: string): string =>
    `[warning: your checkout has uncommitted changes; members start from ${sha7} and do not see them.]`,
  /** §7.3 step 5's sentence (the dirty checkout at create/add). */
  dirtyCheckout: (n: number, sha7: string): string =>
    `Your checkout has uncommitted changes (${n} files). Members start from ${sha7} and will not see them — commit what they need (for example shared contract files) before you add members.`,
  elevatedNote: (name: string, setting: 'teamCursorForce' | 'teamAgySkipPermissions'): string =>
    `[note: ${name} runs every command without approval (setting ${setting}).]`,
  reviewLine: (repoRoot: string, base: string, branch: string): string => `Review: git -C ${repoRoot} diff ${base}...${branch}`,
  verifyLine: (worktreePath: string): string => `Verify: run the build and tests in ${worktreePath}`,
  mergeLine: (repoRoot: string, branch: string): string => `Merge:  git -C ${repoRoot} merge --no-ff ${branch}`,
  neverMergeWhileRunning: (): string => 'Never merge while a member runs — pause it first.',
  /** §9.5: printed per member at team_end when its branch is merged (never --force). */
  worktreeRemoveLine: (worktreePath: string): string => `git worktree remove ${worktreePath}`,
  /** §7.4 team_member's example effect. */
  pausing: (name: string, maxMinutes: number): string =>
    `${name} is pausing: it finishes its current turn (at most ${maxMinutes} minutes), then its worktree is committed.`,

  // ---- roster notes (§3.2, §6.2, §8.1) ----
  inheritsLocalSettings: (): string => "inherits the lead's local settings",
  sharesLeadPlan: (): string => "shares the lead's plan",
  billingOverage: (): string => 'billing overage',
  sharesMachineLogin: (provider: 'cursor' | 'gemini', other: string): string =>
    `shares the machine's ${provider === 'cursor' ? 'Cursor' : 'Antigravity'} login with ${other}; both draw on one plan`,
  routedTo: (provider: string, worker: string, why: string): string => `routed to ${provider}/${worker}: ${why}`,
  cursorSlow: (): string => 'Cursor turns take ~30 s to start',
  turnsOnlyNote: (reason: string): string => `turns-only (${reason})`,
} as const;

/** The member tool answers and refusal sentences (§3.7). Neutral pronouns (CONTRACT-AMBIGUITY, see TEAM_TEXT). */
export const TEAM_TOOL_TEXT = {
  /** Every SUCCESS answer ends with this line when n > 0. */
  unreadFooter: (n: number): string => `Unread messages for you: ${n} — call team_inbox.`,
  sentStarts: (msgId: string, to: string): string => `Sent ${msgId} to ${to} — ${to} was idle and starts a turn now.`,
  sentBusy: (msgId: string, to: string): string =>
    `Sent ${msgId} to ${to} — ${to} is busy; it waits for ${to}'s next turn or next team_inbox call.`,
  sentWaits: (msgId: string, to: string, state: string, why?: string): string =>
    `Sent ${msgId} to ${to} — it waits: ${to} is ${state}${why !== undefined && why !== '' ? ` (${why})` : ''}.`,
  /** T1 wording: to lead or user. */
  sentInbox: (msgId: string, to: string): string => `Sent ${msgId} to ${to}.`,
  claimed: (taskId: string, title: string, paths: readonly string[]): string =>
    `Claimed ${taskId} "${title}" — it is yours. Paths: ${paths.length > 0 ? paths.join(', ') : '(none)'}`,
  updated: (taskId: string, state: string): string =>
    `${taskId} is now ${state}. Your worktree is committed when this turn ends; the lead has been told.`,
  inboxEmpty: (): string => 'No new messages.',
  inboxMore: (r: number): string => `(${r} more — call team_inbox again)`,
  inboxStopPolling: (): string => 'No new messages. Do not poll — end your turn; you will be woken.',
  /** A call from a connection whose member is not `running` (§3.7) — the contract's literal, with no code prefix. */
  turnEnded: (): string => 'your turn has ended',
  /** The text of `team_board {task_id}` when the cut binds. */
  boardBodyCut: (): string => '[cut — call team_board with task_id]',
  /** §5.4: a body beyond its cap. */
  bodyCut: (n: number): string => `[body cut: ${n} bytes]`,

  // refusal sentences (the code is prefixed by toolRefusal)
  teamGone: (): string => 'The team engine is gone (the lead session ended). Stop working and end your turn.',
  unknownRecipient: (to: string, names: readonly string[]): string =>
    `there is no "${to}" in this team; write to one of: ${['lead', 'user', ...names].join(', ')}`,
  /** T1 wording (the contract: `all`, yourself, a stopped member). */
  notAllowedAll: (): string => 'you cannot write to all; write to lead, user or one teammate',
  notAllowedSelf: (): string => 'you cannot write to yourself',
  notAllowedStopped: (to: string, state: string): string => `${to} is ${state} and takes no messages`,
  emptyMessage: (): string => 'the message is empty',
  messageTooLarge: (n: number): string => `text is ${n} bytes; the limit is ${MESSAGE_MAX_BYTES}`,
  invalidText: (): string => 'text must be valid UTF-8 without NUL characters',
  rateLimitedTurn: (): string => `you have sent ${MEMBER_SENDS_PER_TURN} messages this turn; finish your work and report`,
  rateLimitedHour: (): string => `you have sent ${MEMBER_SENDS_PER_HOUR} messages this hour; finish your work and report`,
  duplicate: (earlierId: string): string => `you already sent this message as ${earlierId}`,
  inboxFull: (to: string, state: string): string => `inbox of ${to} is full (${PENDING_MAX} undelivered); it is ${state}`,
  unknownMessage: (id: string): string => `${id} is not a message of this team`,
  unknownTask: (id: string): string => `${id} is not a task on the board`,
  teamNotActive: (name: string, status: string): string => `team ${name} is ${status}`,
  notOpen: (taskId: string, state: string, holder?: string): string =>
    holder !== undefined ? `${taskId} is ${state} by ${holder}` : `${taskId} is ${state}`,
  pathsConflict: (taskId: string, ownedPath: string, otherTask: string, otherMember: string, otherState: string): string =>
    `${taskId}'s path ${ownedPath} overlaps ${otherTask} (${otherMember}, ${otherState})`,
  claimLimit: (held: readonly string[]): string =>
    `you already hold ${held.length} tasks: ${held.join(', ')} — finish or release one`,
  notYourTask: (taskId: string): string => `${taskId} is not yours`,
  invalidTransition: (taskId: string, state: string, allowed: readonly string[]): string =>
    `${taskId} is ${state}; ` + (allowed.length === 0 ? 'you cannot move it' : `you can move it to ${allowed.join(', ')}`),
  reportRequired: (): string => 'review needs report',
  reasonRequired: (): string => 'blocked needs note',
  reportTooLarge: (n: number): string => `report is ${n} bytes; the limit is ${REPORT_MAX_BYTES}`,
  noteTooLarge: (n: number): string => `note is ${n} bytes; the limit is ${NOTE_MAX_BYTES}`,
  invalidArguments: (key: string, problem: string): string => `${key} ${problem}`,
} as const;

/**
 * The engine's notices whose words the contract spells (§3.5, §3.5.1, §3.6.2, §4.1, §5.5, §6.3,
 * §6.5, §9.2). Notices the contract describes without words (memory, ping-pong, refresh, the
 * turns-only verdict and its flip-back, overlap, expired messages) are the engine's to word.
 */
export const TEAM_NOTICE = {
  /** §3.5 `cancelled`. */
  cancelled: (name: string, n: number): string =>
    `${name}'s turn ${n} was stopped from outside the team engine; it is paused — unpause it when you are ready`,
  /** §3.5 `timeout`. CONTRACT-AMBIGUITY: the contract's notice starts `turn <n> …`; the member is named, since the lead's inbox shows the engine as the sender. */
  timeout: (name: string, n: number, minutes: number): string =>
    `${name}'s turn ${n} stopped after ${minutes} min (turn limit); its changes are on disk`,
  /** §3.5 contextLost (S4). */
  contextLost: (name: string): string =>
    `${name}'s CLI did not find its conversation and started a new one; ${name} was re-briefed and continues in the same worktree`,
  /** §3.5.1. */
  peerWakes: (a: string, n: number): string =>
    `${a} has been woken ${n} times by teammates without a message from you or board progress; teammate messages to ${a} now wait for a message from you or the user.`,
  /** §3.6.2. */
  noAnswer: (name: string, n: number): string => `${name} ended turn ${n} with no answer`,
  /** §4.1 (L8: `tellLead`): the quote is the message's first USER_WROTE_QUOTE_CHARS characters, on one line. */
  userWrote: (to: string, msgId: string, text: string): string =>
    `the user wrote to ${to} (${msgId}): ${[...text.replace(/\s+/g, ' ').trim()].slice(0, USER_WROTE_QUOTE_CHARS).join('')}`,
  /** §4.1. */
  memberWroteUser: (name: string, msgId: string): string => `${name} wrote to the user (${msgId})`,
  /** §4.1 — `by the lead` (or the user). */
  reassigned: (taskId: string, to: string, by: 'lead' | 'user'): string =>
    `${taskId} was reassigned to ${to} by the ${by} — stop working on it`,
  /** §5.5 (neutral pronoun). */
  stillClaimed: (name: string, taskId: string, lastWords: string): string =>
    `${name} ended a turn with ${taskId} still claimed; its last words: ${lastWords}`,
  /** §5.5: posted when the team BECOMES idle (M11). */
  teamIdle: (): string => 'the team is idle',
  /** §6.3. */
  reroutedBeforeFirstTurn: (name: string, provider: string, worker: string, oldWorker: string): string =>
    `${name} re-routed to ${provider}/${worker} before its first turn: ${oldWorker} is logged out`,
  /** §6.5 step 2. `window` e.g. `5-hour`. */
  quotaWait: (name: string, provider: string, worker: string, window: string, until: number): string =>
    `${name} is paused: ${provider}/${worker} is at its ${window} limit until ${clockHHMM(until)}; it continues then.`,
  /** §6.5 step 3 (worded as availability, S3(a)). */
  failover: (name: string, provider: string, worker: string, oldWorker: string, until: number): string =>
    `${name} continues on ${provider}/${worker} (${oldWorker} is at its limit until ${clockHHMM(until)}); it picks up from a hand-off note in the same worktree.`,
  /** §6.5 step 4. */
  blockedQuota: (name: string, provider: string, until: number, worker: string): string =>
    `${name} is blocked: every ${provider} account is out of quota (earliest reset ${clockHHMM(until)} on ${worker}).`,
  /** §9.2 M23. */
  checkpointSkipped: (name: string, paths: readonly string[]): string =>
    `${name}'s checkpoint left ${paths.length} files uncommitted (too large or secret-like): ${paths.join(', ')}`,
  /** §9.2 L6. */
  stashChanged: (name: string, n: number): string =>
    `the repository's stash changed during ${name}'s turn ${n} (members share refs/stash with your checkout — check \`git stash list\`)`,
  /** §9.1 step 6. */
  setupFailed: (exitCode: number, lastLine: string): string => `worktree setup failed (exit ${exitCode}): ${lastLine}`,
} as const;

/* ------------------------------------------------------------------------- *
 * §9.2 the checkpoint commit
 * ------------------------------------------------------------------------- */

/**
 * The checkpoint commit message (§9.2): `team(<name>/<member>): turn <n> — <head of the final
 * text ≤ 60 chars | checkpoint>`, a blank line, the trailers `Teammate: <member>
 * (<provider>/<worker>/<model>)` and `Board-Task: b3` (when exactly one is held). `head` is
 * flattened by the caller; '' → `checkpoint`. CONTRACT-AMBIGUITY: `n` absent (a checkpoint not at
 * a turn's end: stop, team_end, take-over) → the subject is `team(<name>/<member>): checkpoint`.
 */
export function checkpointCommitMessage(v: {
  team: string;
  member: string;
  n?: number;
  head: string;
  provider: string;
  worker: string;
  model: string;
  heldTasks: readonly string[];
}): string {
  const head = v.head.trim() === '' ? 'checkpoint' : [...v.head.trim()].slice(0, 60).join('');
  const subject =
    v.n === undefined ? `team(${v.team}/${v.member}): checkpoint` : `team(${v.team}/${v.member}): turn ${v.n} — ${head}`;
  const trailers = [`Teammate: ${v.member} (${v.provider}/${v.worker}/${v.model || '—'})`];
  if (v.heldTasks.length === 1) {
    trailers.push(`Board-Task: ${v.heldTasks[0]}`);
  }
  return `${subject}\n\n${trailers.join('\n')}\n`;
}

/* ------------------------------------------------------------------------- *
 * The seam types the interfaces of §7.1 use — T1 ADDITIONS where the contract names a type only
 * ------------------------------------------------------------------------- */

/** A connection, as host.ts mints it per accepted socket. */
export type ConnId = number;

/** Who acts through TeamCore: the lead (cco) or the user (a front end). Members act only through memberTool. */
export type Actor = 'lead' | 'user';

/** `{ok:true, value, warnings}` or a refusal (§7.1). `warnings` are lines the answer adds (e.g. §5.3 `warning: b3 overlaps …`). */
export type Result<T> = { ok: true; value: T; warnings: string[] } | TeamRefusal;
/** A successful Result. */
export function okResult<T>(value: T, warnings: string[] = []): { ok: true; value: T; warnings: string[] } {
  return { ok: true, value, warnings };
}

/**
 * A JSON-RPC error for PROTOCOL misuse on a team method (MD-54: domain refusals are results;
 * these are errors): TeamHostSide.request rejects with one, and host.ts answers
 * `{error:{code: rpcCode, message}}`. Any other rejection is answered as an internal error.
 */
export class TeamProtocolError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeamProtocolError';
  }
}
/** The JSON-RPC codes a team method answers besides RPC_ERROR's. */
export const TEAM_RPC = { methodNotFound: -32601, invalidParams: -32602, internalError: -32603 } as const;

/**
 * A message the lead or the user sends (TeamCore.send). From cco's team_send (`reply_to` →
 * `replyTo`; `tellLead` unused) or cco/team.send (`tellLead` default true, L8). Untrusted values.
 */
export interface OutgoingMessage {
  to: string;
  text: string;
  kind?: SenderMessageKind;
  urgent?: boolean;
  replyTo?: string;
  task?: string;
  tellLead?: boolean;
}
/**
 * What became of a message for one recipient — the facts the answers of §3.7/§7.3/§7.4 render:
 * `starts` (idle: a turn starts within IDLE_WAKE_MAX_MS), `busy` (running: it waits for the next
 * team_inbox call or turn), `interrupts` (urgent to a running member: its turn is interrupted
 * now), `urgent-queued` (urgent inside INTERRUPT_MIN_INTERVAL: queued; `secondsAgo`), `held`
 * (starting/pausing/paused/blocked/stopped: recorded, reaches it when it continues; `reason`,
 * `until`), `attached` (queued while the user is attached; `since`), `inbox` (lead/user).
 */
export interface SendRecipient {
  to: string;
  state: MemberStateName | 'lead' | 'user';
  delivery: 'starts' | 'busy' | 'interrupts' | 'urgent-queued' | 'held' | 'attached' | 'inbox';
  secondsAgo?: number;
  reason?: string;
  until?: number;
  since?: number;
}
/** TeamCore.send's answer: the message id and each recipient (`all` expanded). */
export interface SendAnswer {
  msgId: string;
  recipients: SendRecipient[];
}

/** A board operation (the TASK_OP_FILE union, as it reaches the host). */
export type TaskOp = TeamTaskOp;
/** TeamCore.board's answer: `task` — the task changed (for `add`, the first added); `tasks` — every task changed. */
export interface BoardAnswer {
  task: BoardTask;
  tasks: BoardTask[];
}

/** A member operation (team_member, cco/team.member). Untrusted values; `provider` is canonicalized by the core (parseProvider). */
export interface MemberOp {
  member: string;
  op: MemberOpName;
  now?: boolean;
  provider?: string;
  worker?: string;
  model?: string;
}
/** TeamCore.member's answer: the state after it, and one line per effect (written with TEAM_TEXT / the core's words). */
export interface MemberAnswer {
  member: string;
  state: MemberStateName;
  lines: string[];
}

/** TeamCore.end's answer (§7.4 team_end): the effects, then every branch with the review/merge commands (§9.5). */
export interface EndAnswer {
  teamId: string;
  name: string;
  /** `drain`: running turns finished first (≤ END_DRAIN_MS); `now`: the normal ladder at once. */
  mode: 'drain' | 'now';
  lines: string[];
  branches: Array<{
    member: string;
    branch: string;
    worktree: string;
    baseCommit: string;
    ahead?: number;
    dirty?: boolean;
    merged?: boolean;
    /** §9.2: restoring the merged vendor MCP file failed — stated in the answer. */
    restoreError?: string;
  }>;
}

/**
 * TeamCore.create/add/resume's answer — the facts §7.4's skeleton renders; the roster rows come
 * from `state.members` (those named in `members`).
 */
export interface CreateAnswer {
  /** The projection right after the answer's events were durable. */
  state: TeamState;
  /**
   * `created` (team_create), `added` (team_add), `resumed` (team_resume), `exists` (the idempotent
   * team_create: same name, active, this host — nothing was created), `already-led` (team_resume
   * of the team this session already leads).
   */
  outcome: 'created' | 'added' | 'resumed' | 'exists' | 'already-led';
  /** The ref the base was taken from (`base`, default `HEAD`). */
  baseRef: string;
  /** The members this call concerns: every member (create/resume), the added ones (add). */
  members: string[];
  /** `exists`: the names the file has and the team lacks. */
  missing?: string[];
  /** §7.3 step 5: the lead's checkout had this many uncommitted files. */
  dirtyFiles?: number;
  /** `resumed`: members whose last turn was interrupted, and those whose report was lost (§7.4). */
  interrupted?: string[];
  reportLost?: string[];
}

/**
 * TeamCore.inbox's page (M9): `text` is the §4.4 rendering (TEAM_TEXT.inbox*) within
 * `capChars − footerReserveChars(capChars)`; `shown` the message ids on it, oldest first;
 * `remaining` the unread ones not shown; `readThrough` the seq read-marked through (the LAST
 * message shown — never beyond), undefined when nothing was marked (`all`, or nothing shown).
 */
export interface InboxPage {
  text: string;
  shown: string[];
  remaining: number;
  readThrough?: number;
}

/* ------------------------------------------------------------------------- *
 * THE FOUR INTERFACES (§7.1)
 * ------------------------------------------------------------------------- */

/**
 * host.ts → engine (new HostHooks members): host.ts owns the sockets, the engine owns what they
 * mean. Implemented by src/team/surface.ts (T5b) over TeamCore.
 *
 * State rules (§7.1, §7.6): a hello of role `observer` or `member` is decided WITHOUT host.ts's
 * session check; METHOD_TEAM.wait and METHOD_TEAM.subscribe are HELD requests whose host id stays
 * mapped (`inFlight > 0`) until answered — closeIfIdle never closes a connection holding one;
 * `closed(conn)` fires for every connection that ever greeted, once.
 */
export interface TeamHostSide {
  /**
   * Decide a hello of role `observer` or `member` (a `session` hello is host.ts's own, as before).
   * `params` is the hello's params, untrusted (ObserverHelloParams / MemberHelloParams by shape).
   *
   *  - observer: any process of this user (§15.12 L4); refused RPC_ERROR.roleForbidden past
   *    TEAM_OBSERVER_CONNECTIONS_MAX.
   *  - member: sha256(credential) compared (crypto.timingSafeEqual) with that of the LIVE
   *    member's credential — CONTRACT-AMBIGUITY: TeamCore has no credential method, so the surface
   *    reads the file memberFilesOf(...).credential the core writes 0600 at every lease acquisition
   *    (the credential lives in "file + host memory", §2.1); a mismatch, an unknown team or a member that is not `running` →
   *    RPC_ERROR.badCredential (-32012); past TEAM_MEMBER_CONNECTIONS_MAX →
   *    RPC_ERROR.roleForbidden (-32013). Accepted → TeamCore.memberConnection(member, conn, true).
   *  - during a suspend (§7.9) no hello reaches here: host.ts accepts no connection then.
   *
   * `{ok:true, result}`: host.ts answers with its own HelloResult (TEAM_FEATURE in `features`)
   * plus `result`'s fields, and the connection takes the role. `{ok:false, code, message}`:
   * host.ts answers that JSON-RPC error and closes the connection. Synchronous; never throws.
   */
  hello(
    conn: ConnId,
    role: 'observer' | 'member',
    params: unknown,
  ): { ok: true; result: object } | { ok: false; code: number; message: string };

  /**
   * Every cco/team.* and cco/member.* request of a greeted connection whose role may call it —
   * host.ts enforces the role table first (TEAM_OBSERVER_METHODS, TEAM_MEMBER_METHODS; anything
   * else → RPC_ERROR.roleForbidden, never reaching here). `params` untrusted.
   *
   * Resolves with the JSON-RPC RESULT: domain refusals are results `{ok:false, code, sentence}`
   * (MD-54); cco/member.call resolves with a TextResult `{content, isError}`. Rejects only with a
   * TeamProtocolError for protocol misuse (malformed params → TEAM_RPC.invalidParams); any other
   * rejection is a defect, answered as an internal error by host.ts.
   *
   * A HELD request (wait, subscribe) resolves when it is answered: a wake or the deadline (wait);
   * an unsubscribe, a replacement `{ok:true, replaced:true}` (L8) or `resnapshot_required`
   * (subscribe). Its connection closing first is told through `closed`; the promise then resolves
   * whenever the surface lets it (its answer is dropped by host.ts). Notifications of a
   * subscription are pushed through TeamConnections.push, never through this promise.
   */
  request(conn: ConnId, method: string, params: unknown): Promise<unknown>;

  /**
   * The connection is gone — fires once for every connection that ever greeted (session ones too:
   * the waiter is on a session connection). The engine frees what it held: the waiter slot (H1),
   * the subscription, a member connection (TeamCore.memberConnection(member, conn, false)), and an
   * attach grant's ATTACH_ORPHAN_MS clock starts. Synchronous; never throws.
   */
  closed(conn: ConnId): void;
}

/**
 * engine → host.ts. Implemented by host.ts (T6); handed to the surface with TeamSurface.setConnections.
 */
export interface TeamConnections {
  /**
   * Send one notification on `conn`. CONTRACT-AMBIGUITY: §7.6's notifications carry `requestId`,
   * but TeamHostSide.request is handed no request id — so `params` come WITHOUT `requestId`:
   * host.ts puts the CLIENT's id of the connection's held subscribe first (`null` when it holds
   * none), as HostTransport.notify does. host.ts enforces TEAM_OBSERVER_OUTBOUND_MAX_BYTES on socket.writableLength:
   *  - `lossy` (cco/team.activity) over the cap → nothing written, `'dropped'`;
   *  - not lossy (cco/team.event, cco/team.host) over the cap → host.ts writes
   *    `cco/team.host {requestId, state:'running', reason:'overflow'}` first when THAT fits, then
   *    closes the connection → `'closed'`, and the engine learns it through TeamHostSide.closed;
   *  - `conn` already gone → `'closed'`.
   * Synchronous; never throws.
   */
  push(conn: ConnId, method: string, params: object, lossy: boolean): 'sent' | 'dropped' | 'closed';
  /**
   * Close `conn` (a member's connections at `turn.ended`, M19; a forged credential). With `code`,
   * host.ts first writes one JSON-RPC error `{id: null, error:{code, message}}`. Idempotent; never
   * throws; TeamHostSide.closed fires for it as for any close.
   */
  close(conn: ConnId, code?: number, message?: string): void;
  /** The connection's greeted role; undefined when it has not greeted or is gone. */
  role(conn: ConnId): 'session' | 'observer' | 'member' | undefined;
}

/**
 * server.ts → engine. Implemented by src/team/surface.ts (T5b). Loaded only by the server bundle,
 * used only in HOST mode.
 */
export interface TeamEngine {
  /**
   * The lead's team operations (`tools/call` of TEAM_OPS on a session connection — never on
   * stdio, §7.5). `args` untrusted (TeamOpArgs[name] by shape); `capChars` the client's output cap
   * when the call carried one (team_inbox's `arguments.capChars`, read by value by server.ts), else
   * undefined. Waits for the orphan sweep (≤ SWEEP_WAIT_MS, P13). Resolves with the answer text of
   * §7.4: `isError: true` for a refusal (the client's exit 20, the TEAM_TEXT sentence), false
   * otherwise. NEVER rejects — an internal failure is an isError answer naming it.
   * The unread footer is NOT in this text: server.ts puts footer() into TextResult.footer of every
   * answer on a session connection (L9).
   */
  toolCall(name: TeamOp, args: unknown, capChars: number | undefined): Promise<TextResult>;
  /**
   * The unread line (§4.4 item 2: TEAM_TEXT.footer) when this host's team has unread messages for
   * the lead; undefined otherwise or without a team. Cheap and synchronous: server.ts asks it for
   * every answer that reached the host (not exit 21/22, help or version, L9).
   */
  footer(): string | undefined;
  /**
   * Whether `taskId` is a team turn this engine holds (planned, running or in its ladder). Asked
   * FIRST by cco/cancel, dispatch_status's alive check and statusAliveCheck (§7.9 step 5, H2): an
   * owned id is alive while this says so, and is never in server.ts's own maps (I7).
   */
  ownsTurn(taskId: string): boolean;
  /**
   * `cco cancel <turnId>` of a team turn (§3.4): the normal ladder from SIGINT; the turn ends
   * `interrupted reason=cancel`; the member becomes `paused` with reason
   * `{code:'cancelled', text: TEAM_TEXT.cancelledByCco()}`. Resolves, once the ladder has started,
   * with the §15.5 row TEAM_TEXT.cancelTeamTurn; a turn that ended meanwhile resolves with the
   * §15.5 terminal row `<id>: already <done|error>`. Never rejects.
   */
  cancelTurn(taskId: string): Promise<string>;
  /**
   * H2, §7.9: suspend this host's team because the lead session ended — no new turns;
   * `cco/team.host {state:'suspending'}` to every observer; SUSPEND_KILL_LADDER on every running
   * turn; `turn.ended interrupted reason=lead-ended`; checkpoints with what remains; members idle
   * with a recap pending; `team.status suspended`; lease released. Resolves within `budgetMs`
   * ALWAYS (internally bounded; whatever is unfinished is left to the next host's sweep); resolves
   * at once without a team. Never rejects. Idempotent.
   */
  suspendAll(budgetMs: number): Promise<void>;
  /**
   * S1-6, P13, §2.5: the orphan sweep, run once after `listen` — for every team of this workspace
   * whose lease is stale: take it (H4), fence and stop orphaned turns (pid + start time +
   * isOurWorker; the env-marker search for planned-without-running turns, M7), checkpoint, mark
   * `suspended`, release, and report `TEAM_TEXT.suspendedAfterHostEnded` (a footer line for the
   * lead, cco/team.host for observers). Never rejects; idempotent.
   */
  sweep(): Promise<void>;
  /** Whether this host leads a team (an `active` one): failServer's timer becomes TEAM_FAILSERVER_EXIT_MS (§7.9 step 3). */
  active(): boolean;
}

/**
 * T5a ↔ T5b: the internal seam. src/team/engine.ts (T5a) implements it; src/team/surface.ts (T5b)
 * consumes it; T9's fakes implement it too. Every mutating method serialises per team (the board
 * mutex, §5.3), appends DURABLY before it resolves (I2), and resolves refusals as results — none
 * rejects except waitForLead (with a TeamRefusal). Owned team = the team whose lease this host
 * holds; this host leads at most one ACTIVE team (D4).
 */
export interface TeamCore {
  /** This host's team (projection), undefined when it leads none. */
  team(): TeamState | undefined;
  /** A team of this repository: from the log when owned, from `state.json` otherwise (L7 is the reader's); undefined when unknown. A damaged team reads `damaged` (I10), never undefined. */
  snapshotOf(teamId: string): TeamState | undefined;
  /** This host's team plus the suspended/ended/damaged teams of its repository, newest first, ≤ TEAM_LIST_MAX. `owner`: the live owner's SESSION, absent when none is alive. */
  listTeams(): Array<{
    teamId: string;
    name: string;
    state: TeamState['status'];
    members: number;
    ownedHere: boolean;
    owner?: ProcessIdentity;
  }>;
  /**
   * Every durable event of the owned team, in `seq` order, called after its batch is durable (I2)
   * and never for a team this host does not own. Returns the unsubscribe. A throwing callback is
   * caught and logged; it never affects the engine.
   */
  onEvent(cb: (e: LogEvent) => void): () => void;
  /** Feed items of the owned team's members, coalesced over FEED_COALESCE_MS. Returns the unsubscribe. */
  onActivity(cb: (member: string, items: FeedItem[]) => void): () => void;
  /**
   * The events with `seq > fromSeq`, in order, at most `max`; `'resnapshot_required'` when more
   * than TEAM_SUBSCRIBE_REPLAY_MAX lie after `fromSeq`, when `fromSeq` is ahead of the log, or when
   * the log cannot be read.
   */
  eventsFrom(teamId: string, fromSeq: number, max: number): LogEvent[] | 'resnapshot_required';

  /**
   * team_create (§7.3): EVERY value check happens HERE (aggregated, ≤ VALUE_PROBLEMS_MAX, then
   * `Nothing was created.` — code `invalid_values`), then the order of §7.3: repository, uniqueness,
   * base, disk, routing from CACHED facts only (M15 — nothing is spawned), the events, `state.json`,
   * credentials, briefs, tool specs. Resolves at once (target < 3 s); worktrees, the background live
   * account checks and first turns proceed after. The idempotent case resolves ok with outcome
   * `exists`.
   */
  create(file: TeamFile, by: 'lead'): Promise<Result<CreateAnswer>>;
  /** team_add: the same checks as create, counting existing members (stopped ones too). */
  add(file: MembersFile, by: 'lead'): Promise<Result<CreateAnswer>>;
  /** A message from the lead or the user (§4): every limit of §4.2; recorded durably before it resolves. */
  send(msg: OutgoingMessage, by: Actor): Promise<Result<SendAnswer>>;
  /** A board operation (§5.2/§5.3) — the actor table, the claim and path rules; a lead/user path conflict is a WARNING, not a refusal. */
  board(op: TaskOp, by: Actor): Promise<Result<BoardAnswer>>;
  /** A member operation (§7.2 team_member, §3.5): stop/restart/pause/unpause (also clears `blocked`, M20)/interrupt/switch. Idempotent controls answer what they found (P102). */
  member(op: MemberOp, by: Actor): Promise<Result<MemberAnswer>>;
  /** End the team (§2.5): drain (≤ END_DRAIN_MS) or `now` (the normal ladder); checkpoints; restore merged vendor files; members `ended`; task-log terminal events; lease released. Resolves when it has ended. */
  end(now: boolean, by: Actor): Promise<Result<EndAnswer>>;
  /** team_resume (§2.5): allowed only when the lease is stale (taken per H4) and the team is `suspended`; `ref` a TEAM_ID or TEAM_NAME, absent = the one suspended team of this repository. */
  resume(ref: string | undefined, by: 'lead'): Promise<Result<CreateAnswer>>;
  /**
   * The reader's inbox page (§4.4, M9): unread messages oldest first, composed under
   * `capChars − footerReserveChars(capChars)`, a message over INBOX_MESSAGE_CUT_BYTES cut with
   * TEAM_TEXT.inboxCut; marks read through the LAST message SHOWN (never beyond) — `all`: the last
   * INBOX_ALL_MAX regardless of state, marking nothing.
   */
  inbox(reader: 'lead' | 'user', capChars: number, all: boolean): InboxPage;
  /** Mark `reader`'s messages read through `upToSeq` (`msg.read`); a seq at or below the current mark changes nothing. */
  markRead(reader: 'lead' | 'user', upToSeq: number): void;
  /**
   * The lead's doorbell (§4.4 item 1, M11): resolves `'woken'` as soon as a WAKE-WORTHY unread
   * message exists for the lead (also one that already exists), plus up to `settleMs` of batching
   * after the first; `'aborted'` when `signal` aborts (the deadline, the connection closed).
   * Counts `lead.wakesToday`; holds `lead.waiter` while pending. ONE waiter: a second one REJECTS
   * with TeamRefusal `already_waiting` (sentence TEAM_TEXT.teamWaitAlreadyRunning) — never
   * supersede. Also rejects with a TeamRefusal when there is no team (`no_team`) or the host is
   * suspending.
   */
  waitForLead(signal: AbortSignal, settleMs: number): Promise<'woken' | 'aborted'>;
  /**
   * A member's tool call (§3.7) — `member` is the identity the surface established from the
   * connection (I5), never an argument. The answer: TEAM_TOOL_TEXT / toolRefusal; every success
   * answer ends with TEAM_TOOL_TEXT.unreadFooter when n > 0; a member that is not `running` →
   * isError TEAM_TOOL_TEXT.turnEnded. A successful call is the M19 mailbox verdict `tools`.
   */
  memberTool(member: string, tool: TeamTool, args: unknown): Promise<TextResult>;
  /** The surface tells the core a member connection opened or closed (its hello was accepted / TeamHostSide.closed). The SURFACE closes a member's connections at its `turn.ended` (M19). */
  memberConnection(member: string, conn: ConnId, open: boolean): void;
  /**
   * Take-over (§3.10, Claude members only — else `not_supported`). by `user` (cco/team.takeover):
   * the grant — preconditions, the normal ladder for a running member with `now`, checkpoint,
   * `attach.granted`, state `attach_pending`; `conn` is the granting connection (its close starts
   * ATTACH_ORPHAN_MS). by `lead` (team_attach): CONTRACT-AMBIGUITY — TeamCore has no other way to
   * compute the plan, and §3.10 says the lead's team_attach "only PRINTS the plan and changes
   * nothing": so by `lead` the plan is computed WITHOUT a grant — nothing appended, no state
   * change, `now` ignored, `lease` the empty string, and `env.set` without CCO_DISPATCHED_TASK.
   */
  takeover(member: string, now: boolean, by: Actor, conn: ConnId): Promise<Result<TakeoverPlan>>;
  /** cco/team.attached: the TUI's pid is the lease (`attach.started`, state `attached`); the pid is then watched every ATTACH_WATCH_MS. */
  attached(lease: string, pid: number): Result<void>;
  /** cco/team.release / the orphan rule / the pid's death: `attach.ended` → `idle`. Refused `still_attached` while the pid is alive (explicit releases). */
  release(lease: string, reason: string): Promise<Result<void>>;
  /** As TeamEngine.ownsTurn. */
  ownsTurn(taskId: string): boolean;
  /** As TeamEngine.cancelTurn. */
  cancelTurn(taskId: string): Promise<string>;
  /** As TeamEngine.suspendAll. */
  suspendAll(budgetMs: number): Promise<void>;
  /** As TeamEngine.sweep. */
  sweep(): Promise<void>;
  /** The footer's facts (§4.4 item 2), undefined when there is nothing unread or no team. */
  footerCounts(): { unread: number; senders: string[] } | undefined;
}

/* ------------------------------------------------------------------------- *
 * How the engine is built — T1 ADDITION (the contract names the interfaces, not their factories)
 * ------------------------------------------------------------------------- */

/** What server.ts knows and the engine needs. */
export interface TeamRuntime {
  /** The data root (registry.ROOT_DIR). */
  dataRoot: string;
  /** The host's workspace (HostSpec.workspace, realpath'd). */
  workspace: string;
  /** This host: process.pid and its start time as its HostRecord has it. */
  host: ProcessIdentity;
  /** The lead session (HostSpec.session). */
  session: ProcessIdentity;
  /** The host's socket path (TeamToolSpec.socket). */
  socket: string;
  /** process.execPath — the team MCP server's command. */
  nodePath: string;
  /** `<data root>/mcp/cli.js`. */
  cliJsPath: string;
  /** One line in the host's log. Never throws. */
  log(line: string): void;
}
/** src/team/engine.ts exports `createTeamCore: CreateTeamCore` (T5a). */
export type CreateTeamCore = (runtime: TeamRuntime) => TeamCore;
/** What src/team/surface.ts builds over a core. */
export interface TeamSurface {
  readonly engine: TeamEngine;
  readonly hostSide: TeamHostSide;
  /** host.ts's connections — set once by server.ts before host.ts accepts its first connection. */
  setConnections(connections: TeamConnections): void;
}
/** src/team/surface.ts exports `createTeamSurface: CreateTeamSurface` (T5b). */
export type CreateTeamSurface = (core: TeamCore, runtime: TeamRuntime) => TeamSurface;

/* ------------------------------------------------------------------------- *
 * Small helpers the surface and the core share
 * ------------------------------------------------------------------------- */

/** The footer's text from the core's counts (TeamEngine.footer). */
export function footerText(counts: { unread: number; senders: readonly string[] } | undefined): string | undefined {
  return counts === undefined || counts.unread <= 0 ? undefined : TEAM_TEXT.footer(counts.unread, counts.senders);
}
/** The text budget of an inbox page (M9): `capChars − FOOTER_RESERVE`. */
export function inboxBudgetChars(capChars: number): number {
  return Math.max(0, capChars - footerReserveChars(capChars));
}
/** MemberState.reason for `blocked` (§2.4): a BlockedCode with a flattened text ≤ REASON_MAX_CHARS. */
export type BlockedReason = { code: BlockedCode; text: string; until?: number };
/** Any MemberState.reason. */
export type MemberReason = { code: MemberReasonCode; text: string; until?: number };

/* ------------------------------------------------------------------------- *
 * T1b — THE THREE SEAMS src/team/engine.ts (T5a) CALLS: the store (T3, §2), the driver entry
 * (T4, §3.3–§3.4) and the worktrees (T4, §9). Frozen before T3, T4 and T5a start, so each side
 * codes against a fake of the other. What these doc comments pin is contract; where the contract
 * text left a seam open, the reading taken is marked CONTRACT-AMBIGUITY.
 * ------------------------------------------------------------------------- */

/* ---- the store (§2.1 lease, §2.2 files, §2.3 log, §2.4 projection; src/team/store.ts) ---- */

/**
 * Why a store operation did not happen. EVERY store method is total: an expected failure is one of
 * these as a value, never a throw (a throw out of the store is a defect).
 *
 *  - `invalid-id`    the id is not TEAM_ID — no path is ever built from it;
 *  - `absent`        no such team directory or file;
 *  - `exists`        create: the team directory (or its `.creating` sibling) already exists;
 *  - `damaged`       the log breaks a rule of §2.3 (I10): an unparseable line other than the torn
 *                    final line, a `seq` gap or duplicate, seq 1 not `team.created`, an empty log,
 *                    a `team.json` that is unreadable or whose `id` is not the directory's name, or
 *                    a log that cannot be read at all (unknown ≠ absent). `reason` names the line;
 *  - `unreadable`    a file other than the log exists but cannot be read (EACCES, EIO, over its cap,
 *                    not UTF-8, not the JSON shape it must have);
 *  - `busy`          acquire: a live host holds the lease — `holder` is its lease.json;
 *  - `contended`     acquire: another host is taking the lease right now (`lease.lock` held by a
 *                    live process, or a step of H4 lost a race to another host);
 *  - `not-owner`     a write on a store that does not hold the lease (never acquired, released);
 *  - `lease-lost`    the per-batch fence found `lease.json` gone or naming another host (`holder`
 *                    when readable): this store has stopped writing this team FOR GOOD (I2, H4);
 *  - `log-full`      the batch would take `events.jsonl` past its limit (TeamStore.append);
 *  - `line-too-long` one event serialises to more than LOG_LINE_MAX bytes — a caller defect (the
 *                    engine keeps every text under its cap); `index` names the item; nothing written;
 *  - `too-large`     a file to write is over its cap (STATE_MAX for state.json);
 *  - `io`            the OS refused a write, an fsync, a link or a rename (`errno`); nothing durable.
 *
 * How the engine answers them (§7.2): busy → `team_busy` (TEAM_TEXT.teamBusy with the holder's
 * session), contended → `lease_contended`, io → `team_store_failed` (TEAM_TEXT.storeFailed(errno)),
 * log-full → `team_readonly`, damaged → the team reads `damaged`, never "no team".
 */
export type StoreFailureCode =
  | 'invalid-id'
  | 'absent'
  | 'exists'
  | 'damaged'
  | 'unreadable'
  | 'busy'
  | 'contended'
  | 'not-owner'
  | 'lease-lost'
  | 'log-full'
  | 'line-too-long'
  | 'too-large'
  | 'io';
/** A store failure: `reason` is one line for the host log and the answers that quote it. */
export interface StoreFailure {
  ok: false;
  code: StoreFailureCode;
  reason: string;
  /** The Node error code when the OS said no (`ENOSPC`, `EACCES`, …). */
  errno?: string;
  /** `busy` / `lease-lost`: the lease that names the other host, when it could be read. */
  holder?: TeamLease;
  /** `line-too-long`: the index of the offending item in the batch. */
  index?: number;
}
/** What a store method answers. */
export type StoreResult<T> = { ok: true; value: T } | StoreFailure;

/** A `msg.posted` event as the log holds it. */
export type MsgPostedEvent = Extract<LogEvent, { type: 'msg.posted' }>;

/** One event to append (TeamStore.append): who wrote it and its body; the store adds `v`, `seq` and `ts`. */
export interface LogAppend {
  by: TeamEventBy;
  body: LogEventBody;
  /**
   * `msg.posted` only: the full text of a body over BODY_INLINE bytes. The store writes it to
   * `bodies/m<seq>.md` — the seq it assigns THIS event — 0600 and fsync'd BEFORE the batch's log
   * write, and sets `bodyFile` to that path RELATIVE to the team directory (as BoardTask.bodyFile);
   * `body.body` and `body.bodyFile` must then be absent. A failed batch's body files are removed
   * (best effort). Every other file an event names (`bodies/goal.md`, `bodies/b<n>.md`,
   * `bodies/b<n>-r<k>.md`, `tasks/<turnId>.md`) has a name the engine knows before the append and
   * is written by it FIRST (TeamStore.writeFile, the task log), so no event names a missing file.
   */
  bodyText?: string;
}

/**
 * The facts of TeamState that NO log event holds — the engine's runtime, settings and clock —
 * applied over the store's projection. A14: the store's reducer stays the ONLY reducer of the log;
 * an overlay only fills these fields, which the reducer leaves at the neutral value in brackets:
 *
 *   TeamState: `lead.waiter` (false), `lead.lastCallAt` (null), `lead.wakesToday` (0),
 *   `budgets.turnsToday` (0), `budgets.turnsPerDay` and `budgets.maxRunning` (the
 *   TEAM_NUMBER_SETTINGS defaults), and `warnings` of the kinds no event carries (`inbox`, `idle`,
 *   `attach` — appended by the overlay to the reducer's own);
 *   MemberState: `sharesLeadPlan` (false), `billableOverage` (false), `runsCommands` (false),
 *   `elevated` (absent), `peerWakes` (0), `rssMb`, `lastActivity`, `turn.lastOutputAt`,
 *   `worktree.ahead`, `worktree.dirty`, `worktree.merged` (absent), `attach.client` ('').
 *
 * Everything else is the reducer's, from the log alone — header facts, status and `endedAt`,
 * `owner` (the last `lease.acquired` with no later `lease.released`), read marks and unread counts,
 * every member's state/reason/routing/mailbox/worktree path/conversation/turn/totals/pending/tasks,
 * `worktree.headSha` and `filesChanged` (the last `turn.checkpoint`), the board, `budgets.running`
 * and `pingPongTripped`, totals, and the warnings an event carries. `goal` is the inline text, or
 * `bodies/goal.md` read once when the store loads (absent when unreadable). Unknown event types and
 * unknown fields are ignored; an event whose fields are not what its type needs is skipped and
 * logged — the reducer never throws.
 *
 * An overlay is pure, synchronous and cheap (it runs on every TeamStore.state() call); one that
 * throws is caught and logged, and the projection is used without it.
 */
export type TeamStateOverlay = (projected: TeamState) => TeamState;

/** What TeamStores.create needs: the header, the first batch and the files the first batch names. */
export interface TeamCreateInit {
  /** `id` must be TEAM_ID; written once as `team.json`. */
  header: TeamHeader;
  /** The first batch. `events[0]` MUST be `team.created`; the store inserts `lease.acquired` right after it. */
  events: LogAppend[];
  /** Files written (0600) inside the new directory BEFORE the first batch — `bodies/goal.md` when the goal is over BODY_INLINE. Paths relative to the team directory. */
  files?: Array<{ rel: string; text: string }>;
}

/** One team directory as TeamStores.list reads it — never from the log unless `state.json` fails. */
export interface TeamDirListing {
  teamId: string;
  /** `team.json`; absent when it cannot be read (the state is then `damaged`). */
  header?: TeamHeader;
  /**
   * `state.json`; when it is absent or unreadable, the projection of the log (projectLog); when
   * neither can be read, a `damaged` state built from the header — or, without one, with
   * `name` = the team id (I10: listed, never skipped).
   */
  state: TeamState;
  /** `lease.json` when present and readable. Liveness is the caller's judgement (§2.1, L7). */
  lease?: TeamLease;
}

/**
 * The teams under one data root (§2.2). ONE instance per host process (server.ts builds it and hands
 * it to the engine). Every method is total. src/team/store.ts exports `createTeamStores:
 * CreateTeamStores`.
 */
export interface TeamStores {
  /**
   * team_create's write (§7.3 "the events"): the team is built in `teams/<teamId>.creating/` —
   * `team.json` (0600, fsync'd), `init.files`, `lease.json` naming this host (TeamRuntime.host,
   * .session, .socket), and the first batch `[team.created, lease.acquired, …the rest of
   * init.events]` (one write, fdatasync) — then that directory is RENAMED to `teams/<teamId>` and
   * `teams/` is fsync'd. A crash before the rename leaves only a `.creating` directory, which no
   * reader lists (it is not TEAM_ID) and prune removes; so no team directory ever exists without
   * its first batch. Resolves with the OWNED store of the new team (open(teamId) answers the same
   * instance). Fails `exists` when either directory exists, `invalid-id`, `line-too-long`, `io`.
   */
  create(init: TeamCreateInit): Promise<StoreResult<TeamStore>>;
  /**
   * The store of one team, owned or not. Memoised: the same id answers the SAME instance for the
   * life of this TeamStores — with one instance per host process, that is what makes the
   * single-writer rule hold inside a host. No I/O happens here; a team that does not exist answers
   * `absent` from its reads. Fails only `invalid-id`.
   */
  open(teamId: string): StoreResult<TeamStore>;
  /**
   * Every team directory under `teams/` (TEAM_ID names only), newest first by the creation time
   * the id encodes, at most TEAM_DIR_SCAN_MAX read. Filtering by repository and status is the
   * caller's (TeamCore.listTeams, name uniqueness, team_resume's lookup). Never writes.
   */
  list(): TeamDirListing[];
  /**
   * Retention (§2.2, MD-62), run by the engine after a team_create: of the teams whose
   * `header.repoRoot` is `repoRoot` and whose LOG projection (not only state.json) says `ended`,
   * all but the newest TEAM_HISTORY_KEEP are removed — the team directory ONLY, never a worktree or
   * a branch. Never removed: a team that is `active`, `suspended`, `readonly` or `damaged`, one
   * with a `lease.json`, one that is open and owned here. A directory is first renamed to
   * `teams/.<teamId>.removing` and then removed (no half team is ever listed); symlinks are
   * unlinked, never followed. Leftover `.creating` / `.removing` directories older than
   * START_LOCK_STALE_MS are removed too. Answers the removed team ids; a removal that fails is
   * logged and skipped.
   */
  prune(repoRoot: string): StoreResult<string[]>;
}
/** src/team/store.ts exports `createTeamStores: CreateTeamStores` (T3). */
export type CreateTeamStores = (runtime: TeamRuntime) => TeamStores;

/**
 * One team's directory (§2.2–§2.4): the log, the projection, the lead seat and the files.
 *
 * SINGLE WRITER (I2). Only the store that holds the lease writes into the team directory —
 * `events.jsonl`, `state.json`, `lease.json`, `bodies/`, `members/` — and only through this
 * interface. Two stated exceptions, both inside the lease-holding host process: the driver writes
 * a turn's prompt file `members/<name>/turn-<n>.prompt.md` itself (StartTurn), and the task log's
 * own files under `<data root>/tasks/` are registry.ts's. Readers never need the lease, never write,
 * and never repair: a torn final line seen by a reader is IGNORED (the owner may be mid-write).
 *
 * Every write is 0600 under 0700 directories, made with safeFs's own-directory rules (a symlink or a
 * directory of another user is refused → `io` with errno `ELOOP` / `EPERM`).
 */
export interface TeamStore {
  readonly teamId: string;
  /** teamFilesOf(runtime.dataRoot, teamId). */
  readonly files: ReturnType<typeof teamFilesOf>;

  /* ---- reading: any host, no lease, never a write ---- */

  /** `team.json`; `unreadable` when it is not a TeamHeader whose `id` is this team's. */
  readHeader(): StoreResult<TeamHeader>;
  /** `state.json` (≤ STATE_MAX, a JSON object with `v: 1` and this `id`) — what a non-owner shows (L7 is the caller's). */
  readStateFile(): StoreResult<TeamState>;
  /**
   * The whole log, validated by the rules of §2.3 (H4): every line a JSON object with `v: 1`, an
   * integer `seq` = previous + 1 from 1, a finite `ts`, string `type` and `by`; seq 1 is
   * `team.created`; `team.json`'s id is the directory's. A final line with no `\n` that does not
   * parse as the next valid event is the TORN TAIL: excluded, its size in `tornBytes`. Unknown
   * types are returned as they are (every consumer switches on `type` and ignores what it does not
   * know). Anything else wrong → `damaged`, with the line number in `reason`. Owner: from memory.
   */
  readLog(): StoreResult<{ header: TeamHeader; events: LogEvent[]; tornBytes: number }>;
  /**
   * The reducer's projection of the log (no overlay). A damaged log → ok, with a state of status
   * `damaged` and `damagedReason` built from the header (I10). `absent` only when the team
   * directory does not exist.
   */
  projectLog(): StoreResult<TeamState>;
  /**
   * The events with `seq > fromSeq`, in order, at most `max` — `'resnapshot_required'` when more
   * than TEAM_SUBSCRIBE_REPLAY_MAX lie after `fromSeq`, when `fromSeq` is not a non-negative
   * integer or is ahead of the log, or when the log cannot be read (TeamCore.eventsFrom is this).
   */
  eventsFrom(fromSeq: number, max: number): LogEvent[] | 'resnapshot_required';
  /**
   * `msg.posted` events in seq order: `to` matches a message's `to` OR its `recipients` (a `to: all`
   * message for that member); `from` its sender; only seqs after `afterSeq`; with `max`, the
   * NEWEST `max` of them (still in seq order). Pending, delivered and read are the caller's (the
   * engine's delivery accounting, H3). Owner: from memory; otherwise from the log file; [] when
   * the log cannot be read.
   */
  messages(query: { to?: string; from?: string; afterSeq?: number; max?: number }): MsgPostedEvent[];
  /** A message's text: its inline `body`, or `bodyFile` read (≤ MESSAGE_MAX_BYTES) and checked against `sha256` — a mismatch is `unreadable`. */
  messageText(message: MsgPostedEvent): StoreResult<string>;
  /** A UTF-8 file under the team directory (`rel` as for writeFile), at most `maxBytes`. */
  readFile(rel: string, maxBytes: number): StoreResult<string>;
  /** A member's last `max` feed items (`feed.jsonl`, then `feed.jsonl.1` when more are needed), oldest first; unparseable lines skipped; [] when none. */
  feedTail(member: string, max: number): FeedItem[];

  /* ---- the lead seat (§2.1, H4) ---- */

  /**
   * Become the team's writer. In order:
   *  1. Already owned by this store → ok at once, nothing appended (idempotent). Lost earlier
   *     (`lease-lost`) → `lease-lost` again: a lost lease stops this store for good (I2).
   *  2. `lease.json` absent → create it EXCLUSIVELY with this host's TeamLease (written to a temp
   *     file, fsync'd, then `link()`ed into place — atomic and complete, never a half-written
   *     lease; EEXIST → `contended`).
   *  3. Present and naming this host (sameProcess with TeamRuntime.host) → it is ours.
   *     Present and unparseable → stale when its mtime is older than START_LOCK_STALE_MS, else
   *     `contended`. Present and naming a LIVE holder → `busy` with `holder`. Live = the pid is
   *     alive and registry.processStartedAt(pid) is within START_SLACK_MS of `hostStartedAt`; a
   *     start time that cannot be read is NOT stale (`ps` unknown ⇒ not stale, MD-7).
   *  4. Stale → H4 exactly: (1) create `lease.lock` exclusively (`{pid, startedAt}` of this host,
   *     temp + link) — an existing lock is removed only when stale by the start-lock rule (holder
   *     dead, or older than START_LOCK_STALE_MS with no live holder), then tried once more, else
   *     `contended`; (2) re-read `lease.json` and judge it stale AGAIN (no longer stale → `busy`;
   *     changed → `contended`); (3) rename it to `lease.json.<oldHostPid>.stale` (kept); (4) create
   *     the new lease exclusively (EEXIST → `contended`); (5) unlink `lease.lock` — always, also
   *     after a failed step. Any failure → this host does not own the team, nothing appended.
   *  5. Load and validate the log (readLog). `damaged` → the lease this call created is unlinked
   *     and `damaged` answered: a damaged team is never written (I10).
   *  6. Repair (owner only): the torn tail is truncated (the file is cut at the last `\n`; a
   *     final unterminated line that parses as the next valid event is kept and given its `\n`
   *     instead), then ONE batch `[log.repaired {droppedBytes}` (only when bytes were dropped)`,
   *     lease.acquired {hostPid, hostStartedAt, session, tookOver?}]` is appended with `reserve`.
   *     A failure → the lease is unlinked and the failure answered.
   * Then the store owns the team: the projection is built, `state.json` rewritten. The engine
   * re-mints the credentials after it (§2.1, writeFile).
   */
  acquire(): Promise<StoreResult<{ tookOver?: { oldHostPid: number }; repairedBytes: number }>>;
  /** Whether this store holds the lease (false after release and after `lease-lost`). */
  owned(): boolean;
  /**
   * Give the seat up (suspend, end, the sweep): appends `lease.released {reason}` (with `reserve`),
   * then unlinks `lease.json` when it still names this host; the store no longer owns the team.
   * The append failing `io` still unlinks (the seat must be free for team_resume; the log then
   * shows an owner L7 proves dead); `lease-lost` unlinks nothing. Not owned → ok, nothing done.
   */
  release(reason: string): Promise<StoreResult<void>>;

  /* ---- writing: the owner only (`not-owner` otherwise) ---- */

  /**
   * Append ONE batch of events, durably (MD-9, I2):
   *  - The items of one call get consecutive seqs in their order, and calls are ordered as they
   *    were MADE. Calls within one LOG_BATCH_WINDOW_MS window are written together: ONE `write()`
   *    (`O_APPEND`) and ONE `fdatasync` — all items of a call land, or none do.
   *  - Before every batch, the FENCE (H4): `lease.json` is stat'ed (cached by inode, mtime and
   *    size; re-read when they changed) and must still name this host. Gone or naming another host
   *    → `lease-lost`, nothing written, the store stops writing for good and the engine drops the
   *    team (`lease.lost` is a host log line and a cco/team.host notification — never an event of
   *    the log it lost). The fence unreadable for another reason → that batch fails `io`, the store
   *    is not stopped.
   *  - `ts` = the wall clock when the batch is written (display only; order is `seq`).
   *  - Limits: an event over LOG_LINE_MAX bytes (with its `\n`) → `line-too-long`. A batch that
   *    would take the file past the SOFT limit TEAM_LOG_MAX − 16 × LOG_LINE_MAX → `log-full`,
   *    unless `opts.reserve`, which may use the room up to TEAM_LOG_MAX (past it: `log-full`). The
   *    engine appends `team.status readonly` with `reserve` on its first `log-full`, and every
   *    event that winds a team down (`turn.ended`, `msg.delivered`, `member.state`, the checkpoint,
   *    `team.status`, `lease.released`) with `reserve`, so a full team can still stop and end.
   *  - A failed write or fdatasync → the file is truncated back to the offset the batch began at,
   *    `io` with errno. When that truncation also fails, the store stops writing (every later call
   *    `io`) — the next acquisition repairs the tail. The store never holds events for later: the
   *    ENOSPC hold of §2.3 (≤ ENOSPC_HOLD_MAX_EVENTS / _BYTES) is the ENGINE's, re-appended in order
   *    once an append succeeds again.
   *  - After the fdatasync, in this order: the projection applied; every onEvents callback called
   *    with the batch (seq order, synchronously); `state.json` rewritten (writeState; a failure is
   *    logged only); then every call of the batch resolves with ITS events, seqs and ts filled in.
   */
  append(items: readonly LogAppend[], opts?: { reserve?: boolean }): Promise<StoreResult<LogEvent[]>>;
  /**
   * Called with every durable batch of this store — those of acquire and release included —
   * before any append of that batch resolves (TeamCore.onEvent is fed from here). create's first
   * batch is durable before the store is handed out, so no callback sees it: the engine reads it
   * from state() / readLog. A throwing callback is caught and logged. Returns the unsubscribe.
   */
  onEvents(cb: (events: LogEvent[]) => void): () => void;
  /** The current projection with the overlay applied — undefined when not owned (a non-owner reads readStateFile / projectLog). */
  state(): TeamState | undefined;
  /** The engine's overlay, used by state() and every `state.json` write from now on (set it before acquire). */
  setOverlay(overlay: TeamStateOverlay): void;
  /**
   * Rewrite `state.json` now (temp + rename) with the overlay applied — after every batch, and
   * whenever the engine's overlay facts changed (the engine debounces). Over STATE_MAX → written
   * once more without the inline board bodies (`body` dropped, `bodyFile` kept); still over →
   * `too-large`, the previous file stays.
   */
  writeState(): StoreResult<void>;
  /**
   * Write one file under the team directory atomically (temp + rename, fsync, 0600; missing parent
   * directories created 0700): `rel` is relative, `/`-separated, without `.`/`..`/empty segments,
   * and must stay inside the team directory — anything else `io` (errno `EINVAL`) without a
   * write. Resolves its absolute path. For the credentials (re-minted at every acquisition), tool
   * specs, `mcp.json`, `brief.md`, `assignment.md`, `bodies/goal.md`, `bodies/b<n>.md`,
   * `bodies/b<n>-r<k>.md` — each written BEFORE the event that names it.
   */
  writeFile(rel: string, text: string): StoreResult<string>;
  /**
   * Append feed items to `members/<member>/feed.jsonl` (§3.8): one line each, no fsync (display
   * only). When the file would pass FEED_ROTATE it is renamed to `feed.jsonl.1` (replacing the old
   * one) first. Each item's caps (FEED_TEXT_MAX_BYTES, FEED_TOOL_MAX_CHARS, FEED_DETAIL_MAX_CHARS)
   * are enforced here. A failure is answered — the engine appends ONE `store.warning` per member.
   */
  appendFeed(member: string, items: readonly FeedItem[]): StoreResult<void>;
}

/* ---- the driver entry (§3.3, §3.4, T0 A1/A2/A4; src/team/driver.ts) ---- */

/**
 * What the driver needs from the host for ONE turn, assembled by the engine at that turn's start
 * (§7.7: the host reads the registry at every turn start).
 */
export interface TurnDeps {
  /** The data root (TeamRuntime.dataRoot) — teamDirOf / memberFilesOf for the prompt file. */
  dataRoot: string;
  /**
   * CONTRACT-AMBIGUITY: CCO_TEAM_MEMBER carries `<teamId>:<member>:<incarnation>` (I11) but
   * TurnSpec.incarnation has no NUMBER — this is the member's current incarnation number
   * (teamTurnEnvMarkers' `incarnation`).
   */
  incarnationNumber: number;
  /**
   * `registry.permissionMode` VERBATIM (M4, I14): a Claude member's `--permission-mode` on every
   * turn, with `--permission-prompts none` beside it. Other vendors run the worker's own
   * `permissionMode` (normalizeProviderPermissionMode; absent = the provider's default).
   */
  claudePermissionMode: string;
  /**
   * M14: the live login probe pickWorkerLive runs (usage.fetchAuthStatus, ≤ 5 s) — true logged in,
   * false logged out, undefined unknown; never rejects; it files its own verdict as dispatch's
   * does. Called ONLY for a FAILED Claude turn whose failure text holds a CLAUDE_LOGIN_TRIGGER_TEXTS
   * entry: false → outcome `auth`; true or undefined → `error` (the text alone never files a verdict).
   */
  claudeLoginProbe(worker: WorkerProfile): Promise<boolean | undefined>;
  /**
   * Called once for every process the driver spawns for the turn, synchronously right after the
   * spawn: `pgid` = `pid` (detached, its own group, I7); `startedAt` = registry.processStartedAt(pid)
   * when readable, else the spawn time. The engine appends `turn.running` + `member.process` and the
   * task log's `running` event with the pid from it (§3.4 step 1). At most twice per turn (A4's
   * one re-spawn).
   */
  onSpawn(child: { pid: number; pgid: number; startedAt: number }): void;
  /** One line in the host's log. Never throws. */
  log(line: string): void;
}

/**
 * Start one turn (§3.3, §3.4). src/team/driver.ts exports `startTurn: StartTurn` (T4). Returns the
 * handle SYNCHRONOUSLY and never throws; the spawn happens after it returns. `result` never rejects:
 * a turn that could not start resolves `crashed` with `sawEvent: false` and a note.
 *
 * PRECONDITIONS (the engine's, §3.4 step 1): `turn.planned` is durable; `members/<name>/mcp.json`
 * (`spec.mcp.configFile`), the tool spec and the credential are written; the vendor MCP file is in
 * the worktree (TeamWorktrees.writeVendorMcp); a Claude/Cursor first turn's id
 * (`expectedConversationId`, from mintConversation) is durable in `member.conversation`.
 *
 * WHAT THE DRIVER DOES:
 *  - Spawns ONLY through the agent-mesh adapter's `stream(task)` with `lineStream =
 *    createTurnLineStream({deadlineMs: spec.timeoutMs, env, onChild})` (M2); the engine never spells
 *    a vendor argument. `kind: 'next'` → `task.resumeId = spec.expectedConversationId`. The model
 *    is `spec.incarnation.model` ('' = the CLI's default; never '' for Codex — the engine's, M15).
 *    Claude: CLAUDE_TEAM_ALLOWED_TOOLS, CLAUDE_TEAM_DISALLOWED_TOOLS, `--permission-prompts none`,
 *    CLAUDE_TEAM_SETTING_SOURCES (undefined = not passed, A6). `spec.elevated` → Cursor
 *    CURSOR_FORCE_FLAG / agy AGY_SKIP_PERMISSIONS_FLAG. `spec.mcp` absent → no team server.
 *  - A4 (Claude): a `first` turn with `expectedConversationId` S runs `--resume S` when
 *    `<configDir>/projects/<encoded spec.cwd>/S.jsonl` exists, else `--session-id S` — the engine's
 *    early-crash retry (MD-59, a new `first` turn) gets the right one by this rule. A turn that
 *    fails before any event with CLAUDE_SESSION_ID_IN_USE_TEXT is re-spawned ONCE at once with
 *    `--resume S` inside the same handle (a second onSpawn; `pid` follows the new child); the
 *    handle's outcome is the re-spawn's.
 *  - The brief: Claude → `--append-system-prompt-file spec.briefFile` on EVERY turn. Others →
 *    on `kind: 'first'` only, the vendor text is the brief file's content, `\n\n---\n\n`, then
 *    `spec.prompt`. CONTRACT-AMBIGUITY: a `rebrief` turn is `kind: 'next'` (same incarnation, new
 *    id), so the ENGINE puts the brief into its `spec.prompt` (after the packet, prompts.ts); the
 *    driver adds nothing to a `next` turn. A packet turn is `first`: its brief comes before the
 *    packet.
 *  - MD-64: when the vendor text is over PROMPT_ARGV_MAX UTF-8 bytes it is written (0600, safeFs)
 *    to memberFilesOf(teamDirOf(dataRoot, teamId), member).turnPrompt(n) and the positional
 *    becomes prompts.TEAM_TURN_TEXT.promptFile(<that path>). The engine sets
 *    `turn.planned.promptFile` to that path exactly when the same test holds on the same text (the
 *    composition above is deterministic). A failed write → `crashed`, note `prompt-file: <errno>`.
 *  - Environment (M14, M16): Claude → platform.claudeEnv(worker.configDir); others →
 *    vendorChildEnv() + the provider's home variable; then SESSION_IDENTITY_ENV removed and
 *    teamTurnEnvMarkers(turnId, teamId, member, deps.incarnationNumber, index) added.
 *  - `events`: FeedItems with `turn: spec.turnId`. The FIRST item is `{k: 'turn'}`, yielded at the
 *    vendor's first stream event — the engine appends `turn.accepted` on it (H3, display only).
 *    Text deltas coalesced over FEED_COALESCE_MS; the caps of §3.8. One consumer; it never slows
 *    the turn: past 1,000 unconsumed items the oldest are dropped. Ends when the process ends.
 *  - `conversationId` resolves at the vendor's session event (Claude `system/init.session_id`,
 *    Codex `thread.started.thread_id`, Cursor's stream session id, agy `init.conversation_id`), or
 *    with undefined when the turn ended without one — never synthesized (H3).
 *  - Classification, on FAILURE text only (§3.3): `quota` (isQuotaError), `auth` (non-Claude
 *    isLoginFailureText; Claude via deps.claudeLoginProbe), `context` (isContextOverflowText),
 *    `resume-failed` (a `next` turn failing before any event with isResumeNotFoundText, or with no
 *    id reported at all), `timeout` (the seam's deadline), `cancelled` (an exit by a signal the
 *    seam did not send: `signalledBy: 'other'`, M8), `interrupted` (EVERY ladder the engine started
 *    through interrupt/suspend/kill — the engine knows why it called it and records the reason,
 *    and `memory` for its RSS kill), `error` (the vendor answered an error), `crashed` (any other
 *    failed exit), `ok`. `contextLost` = an `expectedConversationId` and a different reported id.
 *    A vendor CLI that cannot be resolved or spawned → `crashed`, note `cli-missing: <command>`.
 *  - Signals (A1): `interrupt()` NORMAL_KILL_LADDER, `suspend()` SUSPEND_KILL_LADDER, `kill()`
 *    TERM_KILL_LADDER — SIGINT to the LEADER pid only, the escalation to the group. A call before
 *    the spawn means no spawn (`interrupted`, `sawEvent: false`); a call during a ladder moves to
 *    the faster remaining schedule, never a slower one; after the exit a call is a no-op.
 *  - BEFORE `result` resolves, the process half of §3.4 step 4: (2) SIGTERM the group if anything
 *    in it survived; (3) the env-marker sweep for `CCO_DISPATCHED_TASK=<turnId>` (RP-19; found →
 *    fenced with isOurWorker → STRAGGLER_KILL_LADDER; the search unavailable → skipped, and the
 *    note says so); A2: processes of the uid whose command line holds TEAM_MCP_ARG and this
 *    member's tool-spec path (`spec.mcp.args`' last element), started at or after the turn's spawn
 *    and identity-checked (pid + start time), get STRAGGLER_KILL_LADDER — when any had to,
 *    `deps.log('mcp.orphan …')` and the note gains `mcp.orphan: reaped <n>`. CONTRACT-AMBIGUITY: A2
 *    says "the turn's credential path"; the server's command line holds the TOOL-SPEC path (which
 *    names the credential file), so that is the marker `ps` can see, and `mcp.orphan` — no event
 *    type — is recorded through `turn.ended.note`. Steps (4)–(6) are the engine's.
 *  - Driver notes are joined to the adapter's note with `; `, flattened, ≤ REASON_MAX_CHARS.
 *  - The handle is the ENGINE's alone (H2, I7): nothing of the turn enters server.ts's maps.
 */
export type StartTurn = (spec: TurnSpec, deps: TurnDeps) => TurnHandle;

/**
 * A conversation id known BEFORE the spawn (§2.1 conversation row): Claude → a fresh
 * newClaudeSessionId(); Cursor → `cursor-agent create-chat` run for this worker (its env, `cwd`,
 * at most `timeoutMs`, no shell); Codex and Antigravity → `{ok: true, conversationId: undefined}`
 * (their id comes from the first stream event). The engine makes the id durable
 * (`member.conversation`) and passes it as `expectedConversationId` of the `first` turn.
 * Never rejects; a failed create-chat → `{ok: false, text}` (its first line), which the engine
 * treats as a turn that crashed before any event (MD-59). T1b ADDITION: §3.3 needs the Cursor id
 * before the spawn and the engine never runs a vendor command, so the driver does it.
 * src/team/driver.ts exports `mintConversation: MintConversation` (T4).
 */
export type MintConversation = (
  provider: ProviderId,
  worker: WorkerProfile,
  cwd: string,
  timeoutMs: number,
  deps: Pick<TurnDeps, 'log'>,
) => Promise<{ ok: true; conversationId: string | undefined } | { ok: false; text: string }>;

/* ---- the worktrees (§9, H5, H6, M18, M23, L5, L6, T0 A5; src/team/worktree.ts) ---- */

/**
 * Why a worktree operation did not happen. `text` is ONE line — the phase or rule and git's first
 * line — ready for a `blocked` reason, a `turn.checkpoint.error` or a `store.warning` (the engine
 * flattens and cuts it to REASON_MAX_CHARS):
 *
 *  - `not-git`          repository(): the workspace is not inside a git work tree (TEAM_TEXT.notGit);
 *  - `bad-base`         resolveBase(): the ref names no commit;
 *  - `branch_exists`    populate(): the branch exists with no worktree registered for it (H6);
 *  - `worktree_exists`  populate(): a worktree is registered for the branch but its tip moved off
 *                       `baseCommit`, or the path exists and is not that branch's worktree;
 *  - `phase1` `sparse` `phase2` `lfs`  populate(): that step failed or timed out;
 *  - `aborted`          the signal aborted it (a suspend): the git process GROUP was killed; nothing
 *                       deleted; the member stays `starting` with its planned record (§9.1);
 *  - `missing`          check(): the directory or its registration is gone → `blocked: worktree-missing`;
 *  - `branch-moved`     check(): the worktree's HEAD is not its branch → `blocked: worktree-branch`;
 *  - `setup`            runSetup(): `text` = TEAM_NOTICE.setupFailed(exit, last line) (exit -1 and
 *                       `timed out after <m> minutes` / the spawn error for a timeout / no spawn);
 *  - `mcp-merge`        writeVendorMcp(): `cannot merge <path>: not an mcpServers file` → `blocked: worktree`;
 *  - `lock`             checkpoint(): `index.lock` held, or its staleness undeterminable (L5);
 *  - `git`              any other git failure or timeout.
 *
 * The engine's mapping: populate's codes → `blocked: worktree` with `text`; `git` from check() →
 * `blocked: worktree` too (unproven ≠ fine).
 */
export type WorktreeFailureCode =
  | 'not-git'
  | 'bad-base'
  | 'branch_exists'
  | 'worktree_exists'
  | 'phase1'
  | 'sparse'
  | 'phase2'
  | 'lfs'
  | 'aborted'
  | 'missing'
  | 'branch-moved'
  | 'setup'
  | 'mcp-merge'
  | 'lock'
  | 'git';
/** What a worktree operation answers — never a throw. */
export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; code: WorktreeFailureCode; text: string };

/** The repository facts of team_create / team_add (§7.3 steps 1–5, §2.1, M6). */
export interface RepositoryFacts {
  /**
   * The MAIN working tree's top level (§9.1, so a lead in a linked worktree attaches to the common
   * dir): the parent of the absolute, realpath'd common dir when that directory is named `.git`;
   * otherwise the workspace's own `--show-toplevel` (stated).
   */
  repoRoot: string;
  /** `git rev-parse --git-common-dir`, absolute and realpath'd. */
  commonDir: string;
  /** M6: the workspace relative to ITS OWN top level, `/`-separated; '' at the root. */
  leadRel: string;
  /** mesh/contract.meshWorkspaceHash(repoRoot) — memberWorktreeOf's `repoHash`. */
  repoHash: string;
  /** `git status --porcelain` lines of the lead's checkout (§7.3 step 5's warning). */
  dirtyFiles: number;
}

/** One member's worktree as the log records it (`member.worktree.planned`). Paths: memberWorktreeOf, teamBranchOf. */
export interface WorktreePlan {
  repoRoot: string;
  /** Absolute: `<data root>/worktrees/<repoHash>/<teamSlug>/<member>`. */
  path: string;
  /** `cco/<teamSlug>/<member>`. */
  branch: string;
  /** 40 hex. */
  baseCommit: string;
}

/** What one checkpoint did (§9.2, §9.3). */
export type CheckpointOutcome =
  /** Nothing to commit after the excludes and the skips — no `turn.checkpoint` is appended (but the skip notice is still due when `skipped` is new). */
  | { committed: false; skipped: string[] }
  | {
      committed: true;
      /** 40 hex. */
      sha: string;
      /** Paths of `git diff --name-only <baseCommit>...HEAD` (read ≤ CHECKPOINT_DIFF_PATHS_MAX). */
      filesChanged: number;
      /** The first CHECKPOINT_TOUCHED_MAX of those paths. */
      touched: string[];
      /** §9.3: touched paths that overlap none of the member's owned paths ([] when it owns none). */
      outsideOwnership: string[];
      /** M23: left out, ≤ CHECKPOINT_SKIPPED_MAX. */
      skipped: string[];
    };

/**
 * The git half of the engine (§9). src/team/worktree.ts exports `createTeamWorktrees:
 * CreateTeamWorktrees` (T4).
 *
 * EVERY git call: `execFile` (no shell), its own process group (so an abort kills git and what it
 * started), GIT_ENV in its environment, GIT_NO_HOOKS on every call that can run a hook (M18), the
 * GIT_TIMEOUTS_MS budget of its kind (a timeout kills the group), stdin ignored, stdout/stderr read
 * bounded — git's first stderr line is what a failure's `text` quotes. CONTRACT-AMBIGUITY: §9.2
 * says `stdio: 'ignore'` on the mutating calls; their stderr is read here only to word a failure.
 * I8: never `--force`, `reset`, `clean`, a branch deletion, a worktree removal or a merge — the
 * only rewrites are populate's re-population of a planned-never-ready worktree (exception a) and
 * restoreVendorMcp (exception b). Every method is total.
 */
export interface TeamWorktrees {
  /** §7.3 steps 1–5: the facts of the lead's workspace (quick timeouts). */
  repository(workspace: string): Promise<WorktreeResult<RepositoryFacts>>;
  /**
   * `git -C <cwd> rev-parse --verify <ref>^{commit}` → the 40-hex sha (`bad-base` otherwise).
   * T11 E3: `cwd` is the LEAD'S WORKSPACE (team_create) or the team's recorded lead checkout
   * (team_add), never `repoRoot` — in a linked worktree `HEAD` is that worktree's HEAD, not the
   * main checkout's (§9.1 "baseCommit: the lead's HEAD").
   */
  resolveBase(cwd: string, ref: string): Promise<WorktreeResult<string>>;
  /** Free bytes on the volume of `dir` (statfs; `<data root>/worktrees` or its nearest existing parent); undefined when unknown — the DISK_MIN_FREE gate then does not refuse (stated). */
  freeBytes(dir: string): Promise<number | undefined>;

  /**
   * §9.1 steps 2–4 (H6, A5). PRECONDITION: `member.worktree.planned` is durable. In order:
   *  - Recovery first: a worktree registered for `plan.branch` at `plan.path` (`git worktree list
   *    --porcelain`) whose branch tip is still `baseCommit` → steps 3–4 re-run in place
   *    (`recovered: true`). The branch exists with no registered worktree → `branch_exists`; a
   *    registered one whose tip moved, or `plan.path` existing as anything else → `worktree_exists`.
   *    Nothing is reused or deleted in those cases.
   *  - Phase 1: `git -C <repoRoot> worktree add --no-checkout -b <branch> <path> <baseCommit>`
   *    (GIT_TIMEOUTS_MS.worktreePhase1; parents created 0700).
   *  - Sparse: when `git -C <repoRoot> sparse-checkout list` is non-empty, the same patterns are set
   *    in the worktree (cone mode as the main checkout's `core.sparseCheckoutCone`).
   *  - Phase 2 (A5): `git -C <path> read-tree -mu HEAD` — NEVER `checkout-index -a -f`. LFS: when
   *    `.gitattributes` names `filter=lfs` and git-lfs is installed, `git lfs checkout` (`lfs:
   *    'checked-out'`); when it is not installed, `lfs: 'pointers'` (the member is told LFS files
   *    are pointers). Phase 2 and LFS share `timeoutMs` (worktree.timeout_minutes, default 20).
   * `signal` aborts the running step (`aborted`). The ENGINE then appends `member.worktree`
   * (ready, `cwd` = path) and only after that calls runSetup (§9.1 steps 5–6).
   */
  populate(
    plan: WorktreePlan,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<WorktreeResult<{ recovered: boolean; sparse: boolean; lfs: 'none' | 'checked-out' | 'pointers' }>>;
  /**
   * §9.1 step 6: `argv` run in the worktree root, no shell (argv[0] a bare name on PATH or an
   * absolute path), within `timeoutMs`, its own group; the environment is the host's with
   * SESSION_IDENTITY_ENV removed and TEAM_MEMBER_ENV set to `setup.teamMemberEnv`
   * (teamMemberEnvValue — so a setup cannot lead or dispatch). Each
   * output line (flattened, ≤ FEED_TEXT_MAX_BYTES) goes to `onLine` — the engine's `notice` feed
   * items. Non-zero exit, timeout, spawn failure, abort → `setup` (abort: `aborted`).
   */
  runSetup(
    path: string,
    setup: { argv: readonly string[]; timeoutMs: number; teamMemberEnv: string },
    opts: { signal: AbortSignal; onLine(line: string): void },
  ): Promise<WorktreeResult<void>>;
  /** Before every turn (§2.5): the directory exists, is registered, and its HEAD is `branch` → ok; else `missing` / `branch-moved` (`git` when it cannot be told). */
  check(wt: { path: string; branch: string }): Promise<WorktreeResult<void>>;
  /** team_member --restart of a MISSING worktree (§2.5): `git -C <repoRoot> worktree add <path> <branch>` when the branch exists — no `--force`, no `-b`, hooks off. */
  restore(wt: { repoRoot: string; path: string; branch: string }): Promise<WorktreeResult<void>>;

  /**
   * H5, Claude members — TurnSpec.mcp.projectConfigFile. T11 E2: the project's `.mcp.json`
   * (CLAUDE_PROJECT_MCP_FILE) AS IT IS AT `baseCommit` (`git -C <path> show <baseCommit>:.mcp.json`,
   * quick timeout, ≤ 1 MiB), NEVER the working-tree copy a member can edit (a member-written
   * `.mcp.json` would otherwise start commands for a member that may not run any — I14). Written
   * 0600 (atomic) to `outFile` (host-owned, outside the worktree) → `outFile`; absent at the base →
   * ok with undefined (and `outFile` removed if present); not a JSON object → ok with undefined plus
   * nothing written. A git failure → `git` (the engine then passes no project file, and says so in
   * a `store.warning` once per incarnation).
   */
  projectMcpFile(wt: { path: string; baseCommit: string; outFile: string }): Promise<WorktreeResult<string | undefined>>;
  /**
   * H5 (§2.2), before EVERY spawn of a member whose provider has a VENDOR_MCP_FILES entry (agy only
   * when elevated — the engine's call; no entry → ok with undefined, nothing written). The path is
   * relative to the WORKTREE ROOT. TRACKED in the worktree's index → the merge: the INDEX version
   * (`git show :<rel>`, so repeated writes never compound) must be a JSON object with an
   * `mcpServers` object (else `mcp-merge`); its servers plus `config.mcpServers.cco_team` (a
   * `cco_team` already there is replaced) are written, then `git -C <path> update-index
   * --skip-worktree <rel>`. UNTRACKED → `config` written as teamMcpConfigText would. Files 0600.
   * Stateless: tracked-ness is asked of git every call.
   */
  writeVendorMcp(
    path: string,
    provider: ProviderId,
    config: TeamMcpConfig,
  ): Promise<WorktreeResult<{ file: string; tracked: boolean } | undefined>>;
  /** §3.4 step 4 (4), at every turn exit BEFORE the checkpoint: an UNTRACKED vendor MCP file is deleted (absent → ok); a tracked one is left (skip-worktree'd). */
  removeVendorMcp(path: string, provider: ProviderId): Promise<WorktreeResult<void>>;
  /**
   * I8 exception (b), §9.2, at stop, team_end and every incarnation end: for a TRACKED vendor MCP
   * file whose skip-worktree bit is set, `update-index --no-skip-worktree <rel>` then `checkout --
   * <rel>` (that one path, quick timeout) → `true`; nothing to restore → `false`. A failure → `git`
   * (the engine's `store.warning` and EndAnswer.restoreError); the file stays as the engine left it.
   */
  restoreVendorMcp(path: string, provider: ProviderId): Promise<WorktreeResult<boolean>>;

  /**
   * §9.2 — only at a turn boundary, never while a turn runs or the member is attached (the
   * engine's). In order: the dirty test `status --porcelain -- . <CHECKPOINT_EXCLUDES>` (empty →
   * `committed: false`); the skips (M23: `status --porcelain -z --untracked-files=all`; untracked
   * files over CHECKPOINT_FILE_MAX unless `check-attr filter` says `lfs`, and isCheckpointSkipName
   * basenames, become excludes too; the dirty test again with them); `add -A -- . <excludes>
   * <skips>`; `commit --no-verify --no-gpg-sign -q -F <message file>` with CHECKPOINT_IDENTITY;
   * GIT_TIMEOUTS_MS.checkpoint each. `index.lock` (L5): the lock at `rev-parse --git-dir` is stale
   * only when older than INDEX_LOCK_STALE_MS AND `lsof -t` (darwin) / `fuser` (linux) names no
   * process — then removed and the step retried ONCE; undeterminable → not stale → `lock`. Then
   * `diff --name-only <baseCommit>...HEAD` (GIT_TIMEOUTS_MS.diffNames). `message` is
   * checkpointCommitMessage's; `ownedPaths` the paths of the member's held tasks.
   */
  checkpoint(input: {
    path: string;
    /**
     * T11 E5: the member's branch (`cco/<slug>/<member>`). FIRST step: `git symbolic-ref -q HEAD`
     * must be `refs/heads/<branch>`; otherwise NOTHING is added or committed and the answer is
     * `branch-moved` (text names what HEAD is: `detached at <sha7>` or `on <other branch>`) — the
     * engine records `turn.checkpoint {error}` and blocks the member `worktree-branch` at once.
     */
    branch: string;
    baseCommit: string;
    message: string;
    ownedPaths: readonly string[];
    signal?: AbortSignal;
  }): Promise<WorktreeResult<CheckpointOutcome>>;
  /** L6: `git -C <repoRoot> reflog show --format=%H refs/stash` (quick), trimmed; '' when there is no stash. The engine compares the reading before and after a turn and records each one's first line. */
  readStash(repoRoot: string): Promise<WorktreeResult<string>>;
  /**
   * The overlay facts of MemberState.worktree and team_status/team_end (§9.4): `headSha`; `ahead`
   * (`rev-list --count <baseCommit>..HEAD`); `filesChanged` (diff names since the base); `dirty`
   * (the dirty test with CHECKPOINT_EXCLUDES); `merged` (`git -C <leadCheckout> merge-base
   * --is-ancestor <headSha> HEAD`).
   */
  facts(wt: {
    path: string;
    baseCommit: string;
    leadCheckout: string;
  }): Promise<WorktreeResult<{ headSha: string; ahead: number; filesChanged: number; dirty: boolean; merged: boolean }>>;
  /**
   * §6.6: the packet's git facts, each GIT_TIMEOUTS_MS.packetFact, never failing as a whole — a
   * fact that cannot be read is `{unavailable: <reason>}` (prompts.HandoffFact): `commits` (`log
   * --oneline <base>..HEAD`), `uncommitted` (`status --porcelain`), `diffStat` (`diff --stat
   * <base>..HEAD`). The caps are applied by prompts.teamHandoffPacket.
   */
  handoffFacts(wt: { path: string; baseCommit: string }): Promise<{
    commits: string | { unavailable: string };
    uncommitted: string | { unavailable: string };
    diffStat: string | { unavailable: string };
  }>;
  /**
   * §9.3, pure: the paths touched by two or more of the given members (the engine passes only
   * members that are not stopped/ended, each with its last checkpoint's `touched`), and the members
   * that touched them — undefined when none. "Once per new path set" is the engine's.
   */
  overlapOf(touched: Readonly<Record<string, readonly string[]>>): { members: string[]; paths: string[] } | undefined;
}
/** src/team/worktree.ts exports `createTeamWorktrees: CreateTeamWorktrees` (T4). */
export type CreateTeamWorktrees = (runtime: TeamRuntime) => TeamWorktrees;
