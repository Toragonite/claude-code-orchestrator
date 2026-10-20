import * as fs from 'fs';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { claudeTerminalEnv, hostConfigDir, SESSION_IDENTITY_ENV } from '../platform';
import { TEAM_TURN_TEXT, teamHandoffPacket, teamMemberBrief, TEAM_REBRIEF_REASON, type TeamMemberProtocolVars } from '../prompts';
import { normalizeProviderPermissionMode, parseProvider, type ProviderId } from '../providers';
import {
  appendTaskEvent,
  appendTerminalTaskEvent,
  isOurWorker,
  isPidAlive,
  processStartedAt,
  readRegistry,
  resolveClaudePathWithoutLookup,
  teamTurnTimeoutMinutesOf,
  writeTaskFile,
  type TaskEvent,
  type WorkerProfile,
} from '../registry';
import { providerModels } from '../mcp/provider-runner';
import { ownEntry, pickWorkerLive, recordTurnBookkeeping } from '../mcp/task-runner';
import { accountKeyOf as usageAccountKeyOf, exhaustedWindows, fetchAuthStatus, isLoginExpired, readUsageCache } from '../usage';
import { PROTOCOL_VERSION, TASK_ID } from '../mcp/host-protocol';
import { createTeamStores } from './store';
import { mintConversation as driverMintConversation, startTurn as driverStartTurn } from './driver';
import { createTeamWorktrees } from './worktree';
import {
  allowedBoardTargets,
  BLOCKED_RETRY_MAX,
  BOARD_BODY_INLINE,
  BOARD_BODY_MAX_BYTES,
  BOARD_PATHS_MAX,
  BOARD_TASKS_MAX,
  BOARD_TITLE_MAX_CHARS,
  BOARD_TRANSITIONS,
  boardIdOf,
  boardLine,
  boardPathProblem,
  BODY_INLINE,
  bodySha256,
  BRIEF_MAX,
  CLAIMS_ACTIVE_MAX,
  checkpointCommitMessage,
  clockHHMM,
  CODEX_MODEL_LOOKUP_MS,
  CONSECUTIVE_ERRORS_MAX,
  CONTEXT_REPEAT_TURNS,
  CRASH_TAIL_CHARS,
  DISK_MIN_FREE,
  DUPLICATE_MIN_BYTES,
  DUPLICATE_WINDOW_LEAD,
  DUPLICATE_WINDOW_MEMBER,
  duplicateKeyOf,
  EARLY_CRASH_RETRY,
  elevationOf,
  END_DRAIN_MS,
  ENOSPC_HOLD_MAX_BYTES,
  ENOSPC_HOLD_MAX_EVENTS,
  FEED_COALESCE_MS,
  fenceCloseLine,
  fenceOpenLine,
  GOAL_FILE,
  GOAL_MAX,
  HEAD_MAX_CHARS,
  INBOX_ALL_MAX,
  INBOX_MESSAGE_CUT_BYTES,
  inboxBudgetChars,
  INTERRUPT_MIN_INTERVAL,
  isoTime,
  LEAD_USER_SEND_WINDOW_MS,
  LEAD_USER_SENDS_PER_WINDOW,
  MEMBER_CONTEXT_REFRESH_TOKENS,
  MEMBER_SENDS_PER_HOUR,
  MEMBER_SENDS_PER_TURN,
  MEMBER_UPDATE_STATES,
  memberFilesOf,
  memberNameProblem,
  memberPortBase,
  memberWorktreeOf,
  MESSAGE_ID,
  MESSAGE_MAX_BYTES,
  messageIdOf,
  newAttachLease,
  newCredential,
  newFenceId,
  newTeamId,
  newTurnId,
  normalizeMessageText,
  NOTE_MAX_BYTES,
  numberOfBoardId,
  okResult,
  pathsOverlap,
  PEER_WAKE_BUDGET,
  PENDING_MAX,
  PINGPONG_THRESHOLD,
  PROMPT_ARGV_MAX,
  QUOTA_WAIT_MAX_MINUTES,
  quoteFenceLines,
  REASON_MAX_CHARS,
  REPORT_COALESCE_MS,
  REPORT_INLINE_MAX_BYTES,
  REPORT_MAX_BYTES,
  REPORT_NOTICE_CHARS,
  RESET_MARGIN_MS,
  ROLE_MAX_CHARS,
  RSS_KILL,
  RSS_NOTICE,
  RSS_TICK_MS,
  runsCommandsOf,
  SENDER_MESSAGE_KINDS,
  seqOfMessageId,
  SETUP_ARG_MAX_CHARS,
  SETUP_ARGV_MAX,
  SETUP_TIMEOUT_MINUTES,
  SILENCE_NOTICE,
  START_MAX,
  START_SLACK_MS,
  SWEEP_WAIT_MS,
  TEAM_ID,
  TEAM_LIST_MAX,
  TEAM_NAME,
  TEAM_NOTICE,
  TEAM_NUMBER_SETTINGS,
  TEAM_TEXT,
  TEAM_TOOL_TEXT,
  TEAM_MEMBER_ENV,
  teamBranchOf,
  teamDirOf,
  teamMcpConfig,
  teamMcpConfigText,
  teamMcpServerArgs,
  teamMemberEnvValue,
  teamRefusal,
  teamSlugOf,
  TITLE_MAX_CHARS,
  TOOL_BOARD_MAX_BYTES,
  TOOL_BOARD_OTHER_BODY_CHARS,
  TOOL_BOARD_TASK_MAX_BYTES,
  TOOL_INBOX_MAX_BYTES,
  TOOL_INBOX_MAX_MESSAGES,
  TOOL_INBOX_POLLS_MAX,
  toolRefusal,
  TURN_INPUT_MAX_BYTES,
  TURN_INPUT_MAX_MESSAGES,
  TURN_PROMPT_MAX,
  TURN_TEXT_INLINE_MAX,
  turnTextFileOf,
  VALUE_PROBLEMS_MAX,
  VENDOR_MCP_FILES,
  WAKE_NOTICE_KINDS,
  WORKTREE_TIMEOUT_MINUTES,
  DISPATCHED_TASK_ENV,
  attachDispatchedTaskValue,
  type Actor,
  type BoardAnswer,
  type BoardTask,
  type CheckpointOutcome,
  type ConnId,
  type CreateAnswer,
  type CreateTeamCore,
  type EndAnswer,
  type FeedItem,
  type InboxPage,
  type LogAppend,
  type LogEvent,
  type LogEventBody,
  type MemberAnswer,
  type MemberFileEntry,
  type MemberMailbox,
  type MemberOp,
  type MemberReason,
  type MemberReasonCode,
  type MemberSpecRecord,
  type MemberStateName,
  type MembersFile,
  type MessageKind,
  type MintConversation,
  type MsgPostedBody,
  type MsgPostedEvent,
  type NoticeKind,
  type OutgoingMessage,
  type ProcessIdentity,
  type ReportMeta,
  type Result,
  type RouteCause,
  type SendAnswer,
  type SendRecipient,
  type StartTurn,
  type StoreFailure,
  type StoreResult,
  type TakeoverPlan,
  type TaskFileEntry,
  type TaskOp,
  type TaskState,
  type TeamCore,
  type TeamDirListing,
  type TeamEventBy,
  type TeamFile,
  type TeamHeader,
  type TeamRefusal,
  type TeamRuntime,
  type TeamState,
  type TeamStatus,
  type TeamStore,
  type TeamStores,
  type TeamTool,
  type TeamToolSpec,
  type TeamWorktrees,
  type TextResult,
  type TurnEndReason,
  type TurnHandle,
  type TurnOutcome,
  type TurnOutcomeKind,
  type TurnSpec,
  type TurnTrigger,
  type WorktreeResult,
} from './contract';
import {
  accountLabelOf,
  identityKeysOf,
  namesOfIdentities,
  providerOfWorker,
  routeMember,
  type RouteChoice,
  type RoutedMember,
  type RouteRefusal,
  type RoutingFacts,
} from './routing';

/**
 * team/engine — THE TEAM ENGINE CORE (team contract §7.1 `TeamCore`, task T5a): the member state
 * machine (Appendix B), the scheduler and its trigger rule (§3.5, M12), the turn lifecycle
 * (§3.4, write-before-spawn) and the outcome table, delivery accounting (H3), budgets and loop
 * breakers (§3.5.1, §4.2), routing and SAME-PROVIDER failover and refresh (§6, S1-5), the
 * turns-only verdict re-evaluated every turn (§3.7, M19), context-lost → re-brief (S4), the
 * suspend at the lead session's end within its budget (H2), the orphan sweep and team_resume
 * (S1-6: one recovery path, no auto-adopt), the watchdogs (§3.4 step 3) and the checkpoints (§9.2).
 *
 * WHAT IT STANDS ON, AND NOTHING ELSE. Three frozen seams of contract.ts — TeamStores/TeamStore
 * (the log, the projection, the lease; T3), StartTurn + MintConversation (the vendor turn; T4)
 * and TeamWorktrees (git; T4) — and one seam of this file, TeamCoreHost: everything the engine
 * asks of the rest of the product (the registry, the usage cache, dispatch's selection, the task
 * log, process probes). `createTeamCore` wires the real modules; `createTeamCoreWith` takes them
 * as arguments, which is how the offline harness drives the core over fakes.
 *
 * TWO FOLDS, ONE TRUTH. The store's reducer is the ONLY reducer of TeamState (A14) — every
 * answer and snapshot is `store.state()` with this engine's overlay (TeamStateOverlay: the facts
 * no event holds). The engine ALSO folds the log into its own TeamModel, because what it DECIDES
 * on is not all in TeamState: the private `accountKey`, the full conversation id, which message
 * was delivered to whom, which seqs a failed turn carried. TeamModel is applied from the same
 * durable events (store.onEvents) and only from them — so a decision never rests on an event that
 * is not durable (I2), and a host restart rebuilds it from the log alone.
 *
 * SERIALISATION. Every mutation of the owned team runs inside `exclusive` (one promise chain per
 * host, which leads at most one team: the board mutex of §5.3 is the same chain). Nothing that
 * waits long — a turn, a drain, a ladder — holds it: such a wait happens outside, and re-enters.
 * A helper whose name ends in nothing special ASSUMES the chain is held; only the public methods,
 * timers and turn completions enter it.
 *
 * TOTALITY. No public method throws or rejects (except waitForLead, with a TeamRefusal, as the
 * interface says): every seam answers values, every callback is caught, every git or store
 * failure becomes a refusal, a `store.warning`, a blocked member or a host log line.
 *
 * WHAT A HOST RESTART REBUILDS FROM THE LOG (T11): the duplicate guard (E9, seedDuplicates), a
 * pending re-brief or hand-off packet (E15, derivePendingTurns), and every `until` timer (E8/E16,
 * armUntilTimers, at team_resume).
 *
 * STATED RESIDUALS (beyond the contract's own). In-memory facts that do not survive a host
 * restart: send-rate windows, peer-wake counters, recap lines (team_resume writes its own), whether
 * a `refresh` packet was due to start a turn AT ONCE (after a restart it rides the next turn), the
 * `via: tool` attempts of a turn (a message pulled by team_inbox in a turn that then crashed is
 * re-sent unlabelled), and the base commit of a member added by team_add whose worktree was never
 * planned (it falls back to the team's base). The worktree `setup` of the team file is
 * kept in `worktree.json` under the team directory (no event carries it). Lead notices are posted
 * once per state transition but not merged over the 30 s window of §5.5.
 */

/* ------------------------------------------------------------------------- *
 * The host seam
 * ------------------------------------------------------------------------- */

/** The registry facts the engine reads at every team op and every turn start (§7.7). */
export interface TeamHostSettings {
  teamMode: 'on' | 'off';
  teamMaxMembers: number;
  teamMaxRunningTurns: number;
  teamTurnsPerMemberPerHour: number;
  teamTurnsPerDay: number;
  /** registry.teamTurnTimeoutMinutesOf. */
  turnTimeoutMinutes: number;
  teamCursorForce: 'on' | 'off';
  teamAgySkipPermissions: 'on' | 'off';
  /** registry.permissionMode VERBATIM — a Claude member's --permission-mode (M4, I14). */
  permissionMode: string;
  /** registry.cooldownMinutes — the quota cooldown recordTurnBookkeeping files (§6.5 step 1). */
  cooldownMinutes: number;
}

/**
 * Everything the engine asks of the rest of the product. Every member is total: an expected
 * failure is a value (`undefined`, `false`, a refusal text), never a throw — and the engine
 * catches a throw anyway and treats it as "unknown".
 */
export interface TeamCoreHost {
  /** process.platform (I12: win32 refuses every team op). */
  readonly platform: NodeJS.Platform;
  settings(): TeamHostSettings;
  /** The routing facts of this moment (registry workers, usage cache, dispatch's selection). */
  routing(): RoutingFacts;
  /** §6.5 step 2: the earliest reset of an exhausted window that applies to `worker` for `model`, and the window's name (`5-hour`, `weekly`); undefined when none is known. */
  quotaResetAt(worker: WorkerProfile, model: string): { until: number; window: string } | undefined;
  /** §6.2 step 6, M15: one background `availableModels()` of a Codex worker (≤ CODEX_MODEL_LOOKUP_MS); its default id, or undefined. */
  codexModelLive(worker: WorkerProfile): Promise<string | undefined>;
  /** TurnDeps.claudeLoginProbe (M14). */
  claudeLoginProbe(worker: WorkerProfile): Promise<boolean | undefined>;
  /** task-runner.recordTurnBookkeeping (§6.5 step 1, M1/M3): undefined, or the lines of what was not recorded. */
  bookkeeping(
    worker: WorkerProfile,
    identityNames: readonly string[],
    outcome: TurnOutcome & { turnId: string; outcome: TurnOutcomeKind },
    cooldownMinutes: number,
  ): string | undefined;
  /** The task log (I13): every turn is one task. */
  taskLog: {
    append(event: TaskEvent): void;
    /** appendTerminalTaskEvent: `closed: false` = the task was closed by another hand (M8). */
    appendTerminal(event: TaskEvent): { closed: boolean };
    /** writeTaskFile(id, 'prompt'): the file's path, or undefined when it could not be written. */
    writePrompt(turnId: string, text: string): string | undefined;
    /** writeTaskFile(id, 'output'). */
    writeOutput(turnId: string, text: string): boolean;
  };
  /** Process probes for the orphan sweep and the watchdogs (I7). */
  process: {
    isAlive(pid: number): boolean;
    startedAt(pid: number): number | undefined;
    isOurWorker(pid: number, provider: ProviderId): boolean;
    /** Signal a whole process group; a failure is ignored (the group is gone). */
    signalGroup(pgid: number, sig: NodeJS.Signals): void;
    /** M7/RP-19: pids of this uid whose environment holds CCO_DISPATCHED_TASK=<turnId>; undefined when the search cannot run. */
    findByEnvMarker(turnId: string): Promise<number[] | undefined>;
    /** L14: ONE `ps -A -o pid=,pgid=,rss=` — summed RSS bytes per process group; undefined when it failed. */
    rssByGroup(): Promise<Map<number, number> | undefined>;
  };
  /** §3.10: the resolved absolute `claude` path and claudeTerminalEnv(configDir); undefined when no claude can be named. */
  claudeTakeover(configDir: string): { command: string; env: Record<string, string | null> } | undefined;
}

/** The engine's timings — the contract's constants by default; the offline harness shortens them. */
export interface TeamCoreTuning {
  earlyCrashRetryMs: number;
  resetMarginMs: number;
  idleWakeMs: number;
  endDrainMs: number;
  rssTickMs: number;
  silenceNoticeMs: number;
  attachStartGraceMs: number;
  attachWatchMs: number;
  /** How often a held ENOSPC batch is retried. */
  storeRetryMs: number;
  feedCoalesceMs: number;
  codexModelLookupMs: number;
  /** cursor-agent create-chat's budget (MintConversation). */
  mintTimeoutMs: number;
  /** The sweep's TERM ladder: SIGTERM → this → SIGKILL. */
  sweepTermWaitMs: number;
  sweepWaitMs: number;
  quotaWaitMaxMs: number;
}

const DEFAULT_TUNING: TeamCoreTuning = {
  earlyCrashRetryMs: EARLY_CRASH_RETRY.delayMs,
  resetMarginMs: RESET_MARGIN_MS,
  idleWakeMs: 50,
  endDrainMs: END_DRAIN_MS,
  rssTickMs: RSS_TICK_MS,
  silenceNoticeMs: SILENCE_NOTICE,
  attachStartGraceMs: 60_000,
  attachWatchMs: 2_000,
  storeRetryMs: 5_000,
  feedCoalesceMs: FEED_COALESCE_MS,
  codexModelLookupMs: CODEX_MODEL_LOOKUP_MS,
  mintTimeoutMs: 60_000,
  sweepTermWaitMs: 5_000,
  sweepWaitMs: SWEEP_WAIT_MS,
  quotaWaitMaxMs: QUOTA_WAIT_MAX_MINUTES * 60_000,
};

/** What createTeamCoreWith needs: the three frozen seams and the host. */
export interface TeamCoreSeams {
  stores: TeamStores;
  startTurn: StartTurn;
  mintConversation: MintConversation;
  worktrees: TeamWorktrees;
  host: TeamCoreHost;
  tuning?: Partial<TeamCoreTuning>;
}

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
function flat(raw: unknown, max: number = REASON_MAX_CHARS): string {
  return sliceOneLine(flattenOneLine(raw), max);
}
/** At most `max` UTF-8 bytes of `text`, cut on a code-point boundary. */
function cutBytes(text: string, max: number): string {
  if (bytesOf(text) <= max) {
    return text;
  }
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = bytesOf(ch);
    if (used + size > max) {
      break;
    }
    out += ch;
    used += size;
  }
  return out;
}
/** §3.6.2: a report body ≤ max bytes, cut at the last paragraph break that fits. */
function cutAtParagraph(text: string, max: number): string {
  if (bytesOf(text) <= max) {
    return text;
  }
  const head = cutBytes(text, max - 64);
  const at = head.lastIndexOf('\n\n');
  return `${at > 0 ? head.slice(0, at) : head}\n\n[cut — the whole text is in the turn's task file]`;
}
function firstChars(text: string, n: number): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, n).join('');
}
function errText(err: unknown): string {
  return flat(err instanceof Error ? err.message : String(err));
}
function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/**
 * T11 S3/S7 (A36): the host's own check of an inline text — a NUL or a lone surrogate (the form
 * invalid UTF-8 takes in a decoded string) can reach neither a brief, a prompt nor argv (a NUL in a
 * spawn argument fails every non-Claude member's turn with ERR_INVALID_ARG_VALUE). `oneLine` values
 * (role, titles) also refuse every control character, which would otherwise reach a member's system
 * prompt verbatim. `cco` checks the same client-side (exit 21); this is the check for every other
 * client. Answers the problem line, or undefined.
 */
function badTextProblem(what: string, value: string, oneLine: boolean): string | undefined {
  if (/\u0000/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    return `${what} holds a NUL character or invalid UTF-8 ${INVALID_TEXT_MARK}`;
  }
  if (oneLine && /[\u0001-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    return `${what} must be one line without control characters ${INVALID_TEXT_MARK}`;
  }
  return undefined;
}
/** Marks a problem line of badTextProblem: an aggregated refusal holding one answers `invalid_text`. */
const INVALID_TEXT_MARK = '(invalid_text)';

/**
 * T11 E12 (§3.9, A27): does a Codex account's `<configDir>/config.toml` register an `mcp_servers`
 * entry that runs this product's `server.js` (`…/mcp/server.js`, the stable copy under the data
 * root, its pre-rename shim and the extension's bundled one all end so)? A text check of at most
 * 1 MiB: a line inside a `[mcp_servers.*]` table, or a line naming `mcp_servers` itself (a dotted
 * key or an inline table), that names such a path. Answers the file's path, or undefined (also when
 * it cannot be read). Residual, stated: a registration spread over a multi-line array whose path
 * sits on a line of its own outside a `[mcp_servers.*]` header is not seen. Exported for the
 * offline checks only.
 */
export function codexConfigRegistersDispatch(configDir: string): string | undefined {
  const file = path.join(configDir, 'config.toml');
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) {
      return undefined;
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const serverJs = /[\\/]mcp[\\/]server\.js\b/;
  let inServers = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header !== null) {
      inServers = /^"?mcp_servers"?(\.|$)/.test(header[1]);
    }
    if ((inServers || /\bmcp_servers\b/.test(line)) && serverJs.test(line)) {
      return file;
    }
  }
  return undefined;
}

/** T11 E5 (A21): the `branch-moved` record and blocked reason — what HEAD is, and the exact remedy. */
function branchMovedText(gitText: string, worktree: string, branch: string): string {
  // the remedy before the explanation: a reason is cut at REASON_MAX_CHARS
  return `branch-moved: ${gitText} — put it back with: git -C ${worktree} checkout ${branch} (nothing was committed; the files stay in the worktree)`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: 'text', text }], isError };
}
function storeErrno(f: StoreFailure): string {
  return f.errno ?? f.code;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
function closest(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const n of names) {
    const d = editDistance(name, n);
    if (d < bestScore) {
      bestScore = d;
      best = n;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(name.length / 2)) ? best : undefined;
}
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/* ------------------------------------------------------------------------- *
 * TeamModel — the engine's own fold of the durable log (decision facts only)
 * ------------------------------------------------------------------------- */

interface MemberModel {
  name: string;
  index: number;
  role: string;
  spec: MemberSpecRecord;
  state: MemberStateName;
  reason?: MemberReason;
  incarnation: number;
  provider: ProviderId;
  worker: string;
  accountKey: string;
  model: string;
  modelSource: 'dispatch' | 'worker' | 'cli';
  routeCause?: RouteCause;
  conversationId?: string;
  /** The vendor holds this conversation (a turn reported it, or it was re-minted by the vendor). */
  conversationStarted: boolean;
  /**
   * RO3: the running `total_cost_usd` the member's conversation `conversationId` last reported
   * (`turn.ended.cumulativeCostUsd`) — what a resumed turn's total is measured against. Keyed by the
   * conversation it was reported in, so a new incarnation, a re-minted id or a context loss's new id
   * starts at 0 without a reset of its own. `usd` undefined: that conversation's last costed turn was
   * recorded before RO3 (its `costUsd` was the total), so the baseline is unknown. Folded from the
   * log, so a host restart or team_resume keeps it.
   */
  costBaseline?: { conversationId: string; usd: number | undefined };
  plan?: { path: string; branch: string; baseCommit: string };
  ready?: { path: string; branch: string; baseCommit: string; cwd: string };
  mailbox: MemberMailbox;
  mailboxReason?: string;
  /** The member's turn counter (the highest `n` planned). */
  turns: number;
  /** An undelivered brief (M12): set at `member.added` unless `start: false`; cleared by a turn the model saw. */
  briefPending: boolean;
  /** Seqs carried by a planned bundle — a pending one among them is re-sent LABELLED (H3). */
  attempted: Set<number>;
  delivered: Set<number>;
  lastTurn?: { turnId: string; n: number; outcome: TurnOutcomeKind; reason?: TurnEndReason; endedAt: number };
  touched: string[];
}

/**
 * RO3: TurnSpec.costBaselineUsd of a member's next turn — what its conversation has reported so far:
 * 0 when no costed turn ran in that conversation, absent when that is unknown (MemberModel.costBaseline).
 */
function costBaselineOf(m: MemberModel): { costBaselineUsd?: number } {
  const b = m.costBaseline;
  if (b === undefined || b.conversationId !== m.conversationId) {
    return { costBaselineUsd: 0 };
  }
  return b.usd !== undefined ? { costBaselineUsd: b.usd } : {};
}

interface TurnRecord {
  turnId: string;
  name: string;
  n: number;
  incarnation: number;
  trigger: TurnTrigger;
  plannedAt: number;
  running?: { pid: number; pgid: number; startedAt: number };
  ended?: { outcome: TurnOutcomeKind; reason?: TurnEndReason };
}

class TeamModel {
  seq = 0;
  status: TeamStatus = 'active';
  name = '';
  title = '';
  goal: { text?: string; file?: string } = {};
  workspace = '';
  repoRoot = '';
  commonDir = '';
  leadRel = '';
  baseCommit = '';
  createdAt = 0;
  members = new Map<string, MemberModel>();
  board = new Map<string, BoardTask>();
  boardMax = 0;
  messages = new Map<number, MsgPostedEvent>();
  read = { lead: 0, user: 0 };
  turns = new Map<string, TurnRecord>();
  peerStreak = 0;
  pingPongTripped = false;
  attaches = new Map<string, { name: string; pid?: number; startedAt?: number; grantedAt: number; ended: boolean }>();

  apply(e: LogEvent): void {
    if (typeof e.seq !== 'number' || e.seq <= this.seq) {
      return;
    }
    this.seq = e.seq;
    try {
      this.applyBody(e);
    } catch {
      // a malformed event is skipped, never thrown (the reducer's own rule)
    }
  }

  private applyBody(e: LogEvent): void {
    switch (e.type) {
      case 'team.created':
        this.name = e.name;
        this.title = e.title;
        this.workspace = e.workspace;
        this.repoRoot = e.repoRoot;
        this.commonDir = e.commonDir;
        this.baseCommit = e.baseCommit;
        this.leadRel = e.leadRel;
        this.goal = { text: e.goal.text, file: e.goal.file };
        this.createdAt = e.ts;
        return;
      case 'team.status':
        this.status = e.status;
        return;
      case 'member.added':
        this.members.set(e.name, {
          name: e.name,
          index: e.index,
          role: e.role,
          spec: e.spec,
          state: 'starting',
          incarnation: 0,
          provider: 'claude',
          worker: '',
          accountKey: '',
          model: '',
          modelSource: 'cli',
          conversationStarted: false,
          mailbox: 'unverified',
          turns: 0,
          briefPending: e.spec.start !== false,
          attempted: new Set(),
          delivered: new Set(),
          touched: [],
        });
        return;
      case 'member.routed': {
        const m = this.members.get(e.name);
        if (m === undefined) {
          return;
        }
        if (e.incarnation !== m.incarnation) {
          m.conversationId = undefined;
          m.conversationStarted = false;
        }
        m.incarnation = e.incarnation;
        m.provider = e.provider;
        m.worker = e.worker;
        m.accountKey = e.accountKey;
        m.model = e.model;
        m.modelSource = e.modelSource;
        m.routeCause = e.cause;
        return;
      }
      case 'member.worktree.planned': {
        const m = this.members.get(e.name);
        if (m !== undefined) {
          m.plan = { path: e.path, branch: e.branch, baseCommit: e.baseCommit };
        }
        return;
      }
      case 'member.worktree': {
        const m = this.members.get(e.name);
        if (m !== undefined) {
          m.plan = m.plan ?? { path: e.path, branch: e.branch, baseCommit: e.baseCommit };
          m.ready = { path: e.path, branch: e.branch, baseCommit: e.baseCommit, cwd: e.cwd };
        }
        return;
      }
      case 'member.conversation': {
        const m = this.members.get(e.name);
        if (m !== undefined && e.incarnation === m.incarnation) {
          m.conversationId = e.conversationId;
          if (e.replaced !== undefined) {
            m.conversationStarted = true;
          }
        }
        return;
      }
      case 'member.state': {
        const m = this.members.get(e.name);
        if (m !== undefined) {
          m.state = e.state;
          m.reason = e.reason;
        }
        return;
      }
      case 'member.mailbox': {
        const m = this.members.get(e.name);
        if (m !== undefined) {
          m.mailbox = e.mailbox;
          m.mailboxReason = e.reason;
        }
        return;
      }
      case 'turn.planned': {
        this.turns.set(e.turnId, {
          turnId: e.turnId,
          name: e.name,
          n: e.n,
          incarnation: e.incarnation,
          trigger: e.trigger,
          plannedAt: e.ts,
        });
        const m = this.members.get(e.name);
        if (m !== undefined) {
          m.turns = Math.max(m.turns, e.n);
          for (const s of e.deliver) {
            m.attempted.add(s);
          }
        }
        return;
      }
      case 'turn.running': {
        const t = this.turns.get(e.turnId);
        if (t !== undefined) {
          t.running = { pid: e.pid, pgid: e.pgid, startedAt: e.startedAt };
        }
        return;
      }
      case 'turn.ended': {
        const t = this.turns.get(e.turnId);
        if (t === undefined) {
          return;
        }
        t.ended = { outcome: e.outcome, reason: e.reason };
        const m = this.members.get(t.name);
        if (m === undefined) {
          return;
        }
        m.lastTurn = { turnId: e.turnId, n: t.n, outcome: e.outcome, reason: e.reason, endedAt: e.ts };
        if (e.sawAssistant) {
          m.briefPending = false;
        }
        if (t.incarnation === m.incarnation && (e.sawAssistant || e.conversationIdSeen !== undefined)) {
          m.conversationStarted = true;
        }
        const ranIn = e.conversationIdSeen ?? m.conversationId;
        if (t.incarnation === m.incarnation && ranIn !== undefined) {
          if (typeof e.cumulativeCostUsd === 'number' && Number.isFinite(e.cumulativeCostUsd)) {
            m.costBaseline = { conversationId: ranIn, usd: e.cumulativeCostUsd };
          } else if (typeof e.costUsd === 'number') {
            m.costBaseline = { conversationId: ranIn, usd: undefined };
          }
        }
        return;
      }
      case 'turn.checkpoint': {
        const m = this.members.get(e.name);
        if (m === undefined || !('sha' in e)) {
          return;
        }
        m.touched = e.touched;
        for (const task of this.board.values()) {
          if (task.assignee === e.name && (task.state === 'claimed' || task.state === 'blocked' || task.state === 'review')) {
            task.commits = [...task.commits, e.sha];
          }
        }
        return;
      }
      case 'msg.posted': {
        this.messages.set(e.seq, e);
        const fromMember = this.members.has(e.from);
        const toMember = this.members.has(e.to);
        if (e.from === 'lead' || e.from === 'user') {
          this.peerStreak = 0;
          this.pingPongTripped = false;
        } else if (fromMember && toMember) {
          this.peerStreak++;
        }
        return;
      }
      case 'msg.delivered': {
        const m = this.members.get(e.to);
        const seq = seqOfMessageId(e.msg);
        if (m !== undefined && seq !== undefined) {
          m.delivered.add(seq);
        }
        return;
      }
      case 'msg.read':
        if (e.by === 'lead' || e.by === 'user') {
          this.read[e.by] = Math.max(this.read[e.by], e.upToSeq);
        }
        return;
      case 'board.created':
        this.board.set(e.task.id, { ...e.task, paths: [...e.task.paths], reports: [...e.task.reports], commits: [...e.task.commits], turns: [...e.task.turns] });
        this.boardMax = Math.max(this.boardMax, numberOfBoardId(e.task.id) ?? 0);
        return;
      case 'board.updated': {
        const t = this.board.get(e.id);
        if (t === undefined) {
          return;
        }
        const c = e.changes;
        if (c.state !== undefined) {
          t.state = c.state;
        }
        if (c.assignee === null) {
          delete t.assignee;
        } else if (c.assignee !== undefined) {
          t.assignee = c.assignee;
        }
        if (c.title !== undefined) {
          t.title = c.title;
        }
        if (c.body !== undefined) {
          t.body = c.body;
          delete t.bodyFile;
        }
        if (c.bodyFile !== undefined) {
          t.bodyFile = c.bodyFile;
          delete t.body;
        }
        if (c.paths !== undefined) {
          t.paths = [...c.paths];
        }
        if (c.allowOverlap !== undefined) {
          t.allowOverlap = c.allowOverlap;
        }
        if (e.note !== undefined) {
          t.note = e.note;
        }
        const by = e.by.startsWith('member:') ? e.by.slice('member:'.length) : e.by;
        if (e.reportFile !== undefined) {
          t.reports = [...t.reports, { at: e.ts, by, file: e.reportFile }];
        }
        t.updatedAt = e.ts;
        t.updatedBy = by;
        return;
      }
      case 'budget.tripped':
        if (e.kind === 'pingpong') {
          this.pingPongTripped = true;
        }
        return;
      case 'attach.granted':
        this.attaches.set(e.lease, { name: e.name, grantedAt: e.ts, ended: false });
        return;
      case 'attach.started': {
        const a = this.attaches.get(e.lease);
        if (a !== undefined) {
          a.pid = e.pid;
          a.startedAt = e.startedAt;
        }
        return;
      }
      case 'attach.ended': {
        const a = this.attaches.get(e.lease);
        if (a !== undefined) {
          a.ended = true;
        }
        return;
      }
      default:
        return;
    }
  }

  /** The member's pending messages (posted to it, not delivered), oldest first. */
  pendingFor(member: string): MsgPostedEvent[] {
    const m = this.members.get(member);
    if (m === undefined) {
      return [];
    }
    const out: MsgPostedEvent[] = [];
    for (const [seq, msg] of this.messages) {
      if (msg.from === member || m.delivered.has(seq)) {
        continue;
      }
      if (msg.to === member || (msg.to === 'all' && (msg.recipients ?? []).includes(member))) {
        out.push(msg);
      }
    }
    return out;
  }

  /** Unread messages for `reader` (posted to it after its read mark), oldest first. */
  unreadFor(reader: 'lead' | 'user'): MsgPostedEvent[] {
    const out: MsgPostedEvent[] = [];
    for (const [seq, msg] of this.messages) {
      if (seq > this.read[reader] && msg.to === reader) {
        out.push(msg);
      }
    }
    return out;
  }

  /**
   * T11 S9 (A39): may `sender` name message `id` as its `reply_to`? Only a message it sent, or one
   * addressed to it — directly or by the expansion of a `to: all` (§4.2); any other id of the team
   * is `unknown_message`, so an inbox never shows `re m32` on an answer to a message its sender
   * never received.
   */
  repliable(id: unknown, sender: string): boolean {
    if (typeof id !== 'string' || !MESSAGE_ID.test(id)) {
      return false;
    }
    const msg = this.messages.get(seqOfMessageId(id) ?? 0);
    return msg !== undefined && (msg.from === sender || msg.to === sender || (msg.to === 'all' && (msg.recipients ?? []).includes(sender)));
  }

  /** Board ids a member holds (claimed / blocked / review). */
  heldBy(member: string): BoardTask[] {
    return [...this.board.values()].filter(
      (t) => t.assignee === member && (t.state === 'claimed' || t.state === 'blocked' || t.state === 'review'),
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Runtime records (in memory only)
 * ------------------------------------------------------------------------- */

type StopFor = 'urgent' | 'pause' | 'stop' | 'end' | 'interrupt' | 'lead-ended' | 'takeover' | 'cancel' | 'memory';

interface TurnRt {
  turnId: string;
  member: string;
  n: number;
  incarnation: number;
  trigger: TurnTrigger;
  kind: 'first' | 'next';
  deliver: number[];
  resent: number[];
  provider: ProviderId;
  worker: WorkerProfile;
  model: string;
  startedAt: number;
  handle?: TurnHandle;
  stopFor?: StopFor;
  spawned?: { pid: number; pgid: number; startedAt: number };
  toolPulls: Array<{ seqs: number[]; ts: number }>;
  toolsOk: boolean;
  /** E10: the vendor's stream showed a call of a `cco_team` tool (whether or not it reached the host). */
  teamToolSeen: boolean;
  sends: number;
  inboxCalls: number;
  boardTouched: boolean;
  vendorFile: boolean;
  rssMb?: number;
  rssNoticed: boolean;
  silenceNoticed: boolean;
  stashBefore?: string;
  done: Promise<void>;
  resolveDone: () => void;
}

interface MemberRt {
  turn?: TurnRt;
  starting: boolean;
  bringingUp: boolean;
  /** A turn due regardless of messages: failover/refresh (`packet`), context-lost (`rebrief`), the quota timer (`continue`). */
  forced?: 'packet' | 'rebrief' | 'continue';
  /** The proactive refresh (M13) or an incarnation change at resume: the NEXT turn carries the packet, but this alone starts nothing. */
  packetNext: boolean;
  packetReason?: string;
  urgentSeq?: number;
  lastInterruptAt?: number;
  lastStoppedN?: number;
  recaps: string[];
  peerWakes: number;
  peerNoticed: boolean;
  consecutiveErrors: number;
  earlyCrashes: number;
  holdUntil?: number;
  contextAtN: number[];
  resumeRefreshIncarnation?: number;
  failedIdentities: Set<string>;
  timer?: NodeJS.Timeout;
  blockedRetries: number;
  sendTimes: number[];
  lastWakeAt?: number;
  liveChecked: boolean;
  budgetUntil?: number;
  sharesLeadPlan: boolean;
  billableOverage: boolean;
  lastSkippedKey?: string;
  lastOutsideKey?: string;
  checkpointErrorNoticed: boolean;
  feedWarned: boolean;
  facts?: { ahead: number; dirty: boolean; merged: boolean; headSha: string };
  lastActivity?: { ts: number; text: string };
  attach?: { lease: string; conn: ConnId; since: number; pid?: number; startedAt?: number; timer?: NodeJS.Timeout; client: string };
  connections: Set<ConnId>;
  /** The base commit a member added by team_add starts from (team_add's HEAD), until its worktree is planned. */
  baseCommit?: string;
  /** E2: the incarnation whose project `.mcp.json` failure was already told (one store.warning each). */
  projectMcpWarned?: number;
  /** E5: a turn-end checkpoint found HEAD off the member's branch — the outcome's `idle` becomes `blocked: worktree-branch` with this text. */
  branchMoved?: string;
  stopped?: boolean;
}

interface Owned {
  teamId: string;
  store: TeamStore;
  header: TeamHeader;
  model: TeamModel;
  unsubscribe: () => void;
  repoHash: string;
  teamSlug: string;
  members: Map<string, MemberRt>;
  briefs: Map<string, string>;
  setup?: { argv: string[]; timeoutMs: number };
  worktreeTimeoutMs: number;
  suspending: boolean;
  ending: boolean;
  dropped: boolean;
  readonlyNoted: boolean;
  hold: Array<{ items: LogAppend[]; reserve: boolean }>;
  holdErrno?: string;
  holdTimer?: NodeJS.Timeout;
  wakeFlags: Map<number, boolean>;
  lastWakeByMember: Map<string, number>;
  waiter?: { resolve: (v: 'woken' | 'aborted') => void; settleMs: number; settling: boolean; cleanup: () => void };
  lastCallAt: number | null;
  wakes: number[];
  dupes: Map<string, { seq: number; at: number }>;
  leadSends: number[];
  userSends: number[];
  teamIdleNoticed: boolean;
  pingNoticed: boolean;
  overlapKeys: Set<string>;
  recentEnded: Map<string, TurnOutcomeKind>;
  stateTimer?: NodeJS.Timeout;
  watchdog?: NodeJS.Timeout;
  feedBuffers: Map<string, { items: FeedItem[]; timer?: NodeJS.Timeout }>;
  /** Aborts the git work of bring-up (populate, setup) when the team is suspended, ended or dropped (§9.1). */
  abort: AbortController;
}

function newMemberRt(): MemberRt {
  return {
    starting: false,
    bringingUp: false,
    packetNext: false,
    recaps: [],
    peerWakes: 0,
    peerNoticed: false,
    consecutiveErrors: 0,
    earlyCrashes: 0,
    contextAtN: [],
    failedIdentities: new Set(),
    blockedRetries: 0,
    sendTimes: [],
    liveChecked: false,
    sharesLeadPlan: false,
    billableOverage: false,
    checkpointErrorNoticed: false,
    feedWarned: false,
    connections: new Set(),
  };
}

/* ------------------------------------------------------------------------- *
 * The core
 * ------------------------------------------------------------------------- */

class Core implements TeamCore {
  private readonly tuning: TeamCoreTuning;
  private owned: Owned | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly eventListeners = new Set<(e: LogEvent) => void>();
  private readonly activityListeners = new Set<(member: string, items: FeedItem[]) => void>();
  private pokeTimer: NodeJS.Timeout | undefined;
  private sweepPromise: Promise<void> | undefined;
  /** E4: the start-up sweep has run — from then on listTeams shows an ownerless `active` team as `suspended` (host gone). */
  private sweepDone = false;
  private readonly sweepsInFlight = new Map<string, Promise<void>>();
  /** E4: the team team_resume is acquiring — no sweep of this host starts on it meanwhile. */
  private claimedTeam: string | undefined;
  /** E11: teams a sweep found `damaged`, with the store's reason (until a later acquire succeeds). */
  private readonly damagedSeen = new Map<string, string>();
  private suspendPromise: Promise<void> | undefined;
  private repoRootCache: string | undefined;

  constructor(
    private readonly runtime: TeamRuntime,
    private readonly seams: TeamCoreSeams,
  ) {
    this.tuning = { ...DEFAULT_TUNING, ...(seams.tuning ?? {}) };
    // The repository root this host's lists are filtered by, learned once in the background.
    void this.repoRoot();
  }

  /* ---- plumbing ---- */

  private log(line: string): void {
    try {
      this.runtime.log(`team: ${line}`);
    } catch {
      // never throws
    }
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(
      () => fn(),
      () => fn(),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private settings() {
    try {
      return this.seams.host.settings();
    } catch (err) {
      this.log(`settings unreadable: ${errText(err)}`);
      return {
        teamMode: 'off' as const,
        teamMaxMembers: TEAM_NUMBER_SETTINGS.teamMaxMembers.default,
        teamMaxRunningTurns: TEAM_NUMBER_SETTINGS.teamMaxRunningTurns.default,
        teamTurnsPerMemberPerHour: TEAM_NUMBER_SETTINGS.teamTurnsPerMemberPerHour.default,
        teamTurnsPerDay: TEAM_NUMBER_SETTINGS.teamTurnsPerDay.default,
        turnTimeoutMinutes: 45,
        teamCursorForce: 'off' as const,
        teamAgySkipPermissions: 'off' as const,
        permissionMode: 'acceptEdits',
        cooldownMinutes: 30,
      };
    }
  }

  private routingFacts(): RoutingFacts | undefined {
    try {
      return this.seams.host.routing();
    } catch (err) {
      this.log(`routing facts unreadable: ${errText(err)}`);
      return undefined;
    }
  }

  private workerByName(name: string): WorkerProfile | undefined {
    return this.routingFacts()?.workers.find((w) => w.name === name);
  }

  private overlayCache: { at: number; settings: TeamHostSettings; workers: readonly WorkerProfile[] } | undefined;

  /** The overlay runs on every state() call (each batch writes state.json): registry facts at most once a second there. */
  private overlayFacts(): { settings: TeamHostSettings; workers: readonly WorkerProfile[] } {
    const now = Date.now();
    if (this.overlayCache === undefined || now - this.overlayCache.at > 1_000) {
      this.overlayCache = { at: now, settings: this.settings(), workers: this.routingFacts()?.workers ?? [] };
    }
    return this.overlayCache;
  }

  private async repoRoot(): Promise<string | undefined> {
    if (this.repoRootCache !== undefined) {
      return this.repoRootCache;
    }
    try {
      const facts = await this.seams.worktrees.repository(this.runtime.workspace);
      if (facts.ok) {
        this.repoRootCache = facts.value.repoRoot;
      }
    } catch {
      // unknown: the lists fall back to the workspace
    }
    return this.repoRootCache;
  }

  private teamDir(teamId: string): string {
    return teamDirOf(this.runtime.dataRoot, teamId);
  }

  private memberRt(name: string): MemberRt {
    const o = this.owned;
    if (o === undefined) {
      return newMemberRt();
    }
    let rt = o.members.get(name);
    if (rt === undefined) {
      rt = newMemberRt();
      o.members.set(name, rt);
    }
    return rt;
  }

  /** The owned team when it can be steered: no team / suspending / dropped → a refusal. */
  private leading(opts: { mutate: boolean }): Owned | TeamRefusal {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return teamRefusal('no_team', TEAM_TEXT.noTeam());
    }
    if (o.suspending) {
      return teamRefusal('suspending', TEAM_TEXT.suspending());
    }
    if (opts.mutate) {
      if (o.model.status === 'readonly') {
        return teamRefusal('team_readonly', TEAM_TEXT.teamReadonly(o.model.name));
      }
      if (o.model.status !== 'active') {
        return teamRefusal('no_team', TEAM_TEXT.noTeam());
      }
      if (o.hold.length > 0) {
        return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(o.holdErrno ?? 'ENOSPC'));
      }
    }
    return o;
  }

  /* ---- the log ---- */

  private item(body: LogEventBody, by: TeamEventBy = 'engine', bodyText?: string): LogAppend {
    return bodyText === undefined ? { by, body } : { by, body, bodyText };
  }

  /**
   * Append one batch to the owned team's log (I2). A failure is answered, never thrown:
   * `lease-lost` drops the team for good; `log-full` makes it `readonly` (once, with `reserve`);
   * ENOSPC with `hold` keeps the batch in memory (§2.3, ≤ ENOSPC_HOLD_MAX_EVENTS / _BYTES) and
   * re-appends it in order once the log can be written again — no new turn starts meanwhile.
   */
  private async append(items: LogAppend[], opts: { reserve?: boolean; hold?: boolean } = {}): Promise<StoreResult<LogEvent[]>> {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return { ok: false, code: 'not-owner', reason: 'this host leads no team' };
    }
    if (items.length === 0) {
      return { ok: true, value: [] };
    }
    if (o.hold.length > 0) {
      await this.flushHold();
      if (o.hold.length > 0) {
        if (opts.hold === true) {
          this.holdBatch(o, items, opts.reserve === true);
        }
        return { ok: false, code: 'io', errno: o.holdErrno ?? 'ENOSPC', reason: 'the team log cannot be written' };
      }
    }
    let r: StoreResult<LogEvent[]>;
    try {
      r = await o.store.append(items, { reserve: opts.reserve === true });
    } catch (err) {
      r = { ok: false, code: 'io', reason: errText(err) };
    }
    if (r.ok) {
      return r;
    }
    if (r.code === 'lease-lost') {
      this.dropTeam(o, r);
    } else if (r.code === 'log-full' && !o.readonlyNoted) {
      o.readonlyNoted = true;
      this.log(`team ${o.model.name}: log full — read-only`);
      try {
        await o.store.append([this.item({ type: 'team.status', status: 'readonly', reason: 'log-full' })], { reserve: true });
      } catch {
        // already as full as it gets
      }
    } else if (r.code === 'io' && r.errno === 'ENOSPC' && opts.hold === true) {
      o.holdErrno = 'ENOSPC';
      this.holdBatch(o, items, opts.reserve === true);
    }
    return r;
  }

  private holdBatch(o: Owned, items: LogAppend[], reserve: boolean): void {
    const count = o.hold.reduce((n, h) => n + h.items.length, 0);
    const size = o.hold.reduce((n, h) => n + bytesOf(JSON.stringify(h.items)), 0);
    if (count + items.length > ENOSPC_HOLD_MAX_EVENTS || size + bytesOf(JSON.stringify(items)) > ENOSPC_HOLD_MAX_BYTES) {
      this.log(`team ${o.model.name}: ENOSPC hold full — ${items.length} events dropped`);
      return;
    }
    o.hold.push({ items, reserve });
    if (o.holdTimer === undefined) {
      o.holdTimer = setInterval(() => {
        void this.exclusive(async () => {
          await this.flushHold();
          if (o.hold.length === 0) {
            this.poke();
          }
        });
      }, this.tuning.storeRetryMs);
    }
  }

  private async flushHold(): Promise<void> {
    const o = this.owned;
    if (o === undefined) {
      return;
    }
    while (o.hold.length > 0) {
      const next = o.hold[0];
      let r: StoreResult<LogEvent[]>;
      try {
        r = await o.store.append(next.items, { reserve: next.reserve });
      } catch (err) {
        r = { ok: false, code: 'io', reason: errText(err) };
      }
      if (!r.ok) {
        if (r.code === 'lease-lost') {
          this.dropTeam(o, r);
        } else if (r.code !== 'io') {
          o.hold.shift();
          continue;
        }
        return;
      }
      o.hold.shift();
    }
    if (o.holdTimer !== undefined) {
      clearInterval(o.holdTimer);
      o.holdTimer = undefined;
    }
    o.holdErrno = undefined;
  }

  /** The lease was lost (H4): this host stops writing for good and lets the team go. */
  private dropTeam(o: Owned, f: StoreFailure): void {
    if (o.dropped) {
      return;
    }
    o.dropped = true;
    const pid = f.holder?.hostPid ?? 0;
    this.log(`lease.lost — ${TEAM_TEXT.leaseLost(o.model.name, pid)}`);
    for (const rt of o.members.values()) {
      if (rt.turn !== undefined) {
        rt.turn.stopFor = rt.turn.stopFor ?? 'lead-ended';
        rt.turn.handle?.interrupt();
      }
    }
    this.forget(o);
  }

  /** Forget the owned team (after end, suspend, lease loss): timers, waiter, subscriptions. */
  private forget(o: Owned): void {
    o.abort.abort();
    try {
      o.unsubscribe();
    } catch {
      // never throws
    }
    for (const rt of o.members.values()) {
      if (rt.timer !== undefined) {
        clearTimeout(rt.timer);
      }
      if (rt.attach?.timer !== undefined) {
        clearInterval(rt.attach.timer);
      }
    }
    if (o.holdTimer !== undefined) {
      clearInterval(o.holdTimer);
    }
    if (o.stateTimer !== undefined) {
      clearTimeout(o.stateTimer);
    }
    if (o.watchdog !== undefined) {
      clearInterval(o.watchdog);
    }
    for (const b of o.feedBuffers.values()) {
      if (b.timer !== undefined) {
        clearTimeout(b.timer);
      }
    }
    if (o.waiter !== undefined) {
      const w = o.waiter;
      o.waiter = undefined;
      w.cleanup();
      w.resolve('aborted');
    }
    if (this.owned === o) {
      this.owned = undefined;
    }
  }

  /** Take a store as THE owned team: overlay, the fold from its whole log, the event feed. */
  private adopt(store: TeamStore, header: TeamHeader, repoHash: string): Owned | StoreFailure {
    const model = new TeamModel();
    const o: Owned = {
      teamId: store.teamId,
      store,
      header,
      model,
      unsubscribe: () => undefined,
      repoHash,
      teamSlug: teamSlugOf(header.name, store.teamId),
      members: new Map(),
      briefs: new Map(),
      worktreeTimeoutMs: WORKTREE_TIMEOUT_MINUTES.default * 60_000,
      suspending: false,
      ending: false,
      dropped: false,
      readonlyNoted: false,
      hold: [],
      wakeFlags: new Map(),
      lastWakeByMember: new Map(),
      lastCallAt: null,
      wakes: [],
      dupes: new Map(),
      leadSends: [],
      userSends: [],
      teamIdleNoticed: false,
      pingNoticed: false,
      overlapKeys: new Set(),
      recentEnded: new Map(),
      feedBuffers: new Map(),
      abort: new AbortController(),
    };
    this.owned = o;
    store.setOverlay((s) => this.overlay(o, s));
    o.unsubscribe = store.onEvents((events) => {
      for (const e of events) {
        this.applyEvent(o, e);
      }
    });
    const log = store.readLog();
    if (!log.ok) {
      this.forget(o);
      return log;
    }
    for (const e of log.value.events) {
      this.applyEvent(o, e, false);
    }
    o.readonlyNoted = model.status === 'readonly';
    this.seedDuplicates(o, Date.now());
    this.derivePendingTurns(o, log.value.events);
    const setup = store.readFile('worktree.json', 64 * 1024);
    if (setup.ok) {
      try {
        const parsed: unknown = JSON.parse(setup.value);
        if (isPlainObject(parsed)) {
          if (isPlainObject(parsed.setup) && Array.isArray(parsed.setup.argv) && typeof parsed.setup.timeoutMs === 'number') {
            o.setup = { argv: parsed.setup.argv.filter((a): a is string => typeof a === 'string'), timeoutMs: parsed.setup.timeoutMs };
          }
          if (typeof parsed.worktreeTimeoutMs === 'number' && parsed.worktreeTimeoutMs > 0) {
            o.worktreeTimeoutMs = parsed.worktreeTimeoutMs;
          }
        }
      } catch {
        // an unreadable setup file: the defaults
      }
    }
    return o;
  }

  /**
   * T11 E9 (A25): the duplicate guard (§4.2, L4) seeded from the log — every lead / user / member
   * message (not a notice, not a report) of at least DUPLICATE_MIN_BYTES posted inside its sender's
   * window — so a send the lead retries after a host crash or a suspend is still refused as the
   * duplicate it is (P20). The key is the one the senders compute (duplicateKeyOf of from, to,
   * reply_to, task and the body's sha256).
   */
  private seedDuplicates(o: Owned, now: number): void {
    for (const msg of o.model.messages.values()) {
      if (msg.source !== 'cco' && msg.source !== 'frontend' && msg.source !== 'tool') {
        continue;
      }
      const window = msg.from === 'lead' || msg.from === 'user' ? DUPLICATE_WINDOW_LEAD : DUPLICATE_WINDOW_MEMBER;
      if (msg.bytes < DUPLICATE_MIN_BYTES || now - msg.ts >= window) {
        continue;
      }
      o.dupes.set(duplicateKeyOf(msg.from, msg.to, msg.re, msg.task, msg.sha256), { seq: msg.seq, at: msg.ts });
    }
  }

  /**
   * T11 E15 (A30): a re-brief or a hand-off packet that was due when the previous host ended is
   * derived from the log, never lost: for the member's CURRENT incarnation, a `member.conversation`
   * with `replaced` later than its last `turn.planned` → the next turn is `rebrief` (S4); an
   * incarnation that began with a `member.routed` of cause failover / switch (which start a packet
   * turn at once) and has no `turn.planned` yet → a `packet` turn; of cause refresh / resume → the
   * next turn carries the packet (it starts none by itself — the cause of a refresh that would have
   * started at once is not recorded, stated).
   */
  private derivePendingTurns(o: Owned, events: readonly LogEvent[]): void {
    for (const m of o.model.members.values()) {
      if (m.state === 'stopped' || m.state === 'ended' || m.incarnation === 0) {
        continue;
      }
      let lastPlanned = 0;
      let replacedAt = 0;
      let opened: { seq: number; cause: RouteCause; reason: string } | undefined;
      for (const e of events) {
        if (e.type === 'turn.planned' && e.name === m.name && e.incarnation === m.incarnation) {
          lastPlanned = e.seq;
        } else if (e.type === 'member.conversation' && e.name === m.name && e.incarnation === m.incarnation && e.replaced !== undefined) {
          replacedAt = e.seq;
        } else if (e.type === 'member.routed' && e.name === m.name && e.incarnation === m.incarnation && opened === undefined) {
          opened = { seq: e.seq, cause: e.cause, reason: e.reason };
        }
      }
      const rt = this.memberRt(m.name);
      if (replacedAt > lastPlanned) {
        rt.forced = 'rebrief';
        rt.packetReason = TEAM_REBRIEF_REASON;
      } else if (lastPlanned === 0 && opened !== undefined && m.incarnation > 1) {
        if (opened.cause === 'failover' || opened.cause === 'switch') {
          rt.forced = 'packet';
          rt.packetReason = opened.cause === 'switch' ? 'the lead switched it to another account or model' : `it was moved to another account (${flat(opened.reason, 200)})`;
        } else if (opened.cause === 'refresh' || opened.cause === 'resume') {
          rt.packetNext = true;
          rt.packetReason = opened.cause === 'resume' ? 'the team was resumed on another account' : 'it was moved to a fresh conversation';
        }
      }
    }
  }

  /** One durable event: the engine's fold, the wake flags, the listeners, the scheduler. */
  private applyEvent(o: Owned, e: LogEvent, live = true): void {
    o.model.apply(e);
    if (e.type === 'msg.posted') {
      if (e.to === 'lead') {
        o.wakeFlags.set(e.seq, this.wakeWorthy(o, e));
      }
      if (live && e.to !== 'lead' && e.to !== 'user' && e.kind !== 'notice') {
        this.poke();
      }
    }
    if (!live) {
      return;
    }
    for (const cb of this.eventListeners) {
      try {
        cb(e);
      } catch (err) {
        this.log(`onEvent listener threw: ${errText(err)}`);
      }
    }
    if (e.type === 'msg.posted' && e.to === 'lead' && o.wakeFlags.get(e.seq) === true) {
      this.wakeWaiter(o);
    }
  }

  /** M11/M13: does this message wake the lead's waiter? (A report: at most once per member per REPORT_COALESCE_MS.) */
  private wakeWorthy(o: Owned, e: MsgPostedEvent): boolean {
    switch (e.kind) {
      case 'question':
      case 'answer':
      case 'text': {
        o.lastWakeByMember.set(e.from, e.ts);
        return true;
      }
      case 'report': {
        const last = o.lastWakeByMember.get(e.from);
        if (last !== undefined && e.ts - last < REPORT_COALESCE_MS) {
          return false;
        }
        o.lastWakeByMember.set(e.from, e.ts);
        return true;
      }
      case 'notice':
        return e.notice !== undefined && (WAKE_NOTICE_KINDS as readonly string[]).includes(e.notice);
      default:
        return false;
    }
  }

  /** The overlay (TeamStateOverlay): the facts no event holds. Pure and cheap; total. */
  private overlay(o: Owned, s: TeamState): TeamState {
    try {
      const { settings, workers } = this.overlayFacts();
      const now = Date.now();
      const midnight = localMidnight(now);
      let turnsToday = 0;
      for (const t of o.model.turns.values()) {
        if (t.plannedAt >= midnight) {
          turnsToday++;
        }
      }
      const extra: TeamState['warnings'] = [];
      const leadUnread = o.model.unreadFor('lead').length;
      if (leadUnread >= PENDING_MAX) {
        extra.push({ kind: 'inbox', text: TEAM_TEXT.leadInboxWarning(leadUnread) });
      }
      if (o.teamIdleNoticed) {
        extra.push({ kind: 'idle', text: TEAM_NOTICE.teamIdle() });
      }
      const members = s.members.map((ms) => {
        const rt = o.members.get(ms.name);
        const mm = o.model.members.get(ms.name);
        const worker = mm !== undefined ? workers.find((w) => w.name === mm.worker) : undefined;
        const elevated = mm !== undefined ? elevationOf(mm.provider, settings) : undefined;
        const runsCommands =
          mm !== undefined
            ? runsCommandsOf(
                mm.provider,
                mm.provider === 'claude' ? settings.permissionMode : normalizeProviderPermissionMode(mm.provider, worker?.permissionMode),
                elevated !== undefined,
              )
            : false;
        if (rt?.attach !== undefined) {
          extra.push({ kind: 'attach', text: `${ms.name} is taken over in a terminal since ${clockHHMM(rt.attach.since)}` });
        }
        const lastOutputAt = rt?.turn?.handle !== undefined ? safeNumber(() => rt.turn?.handle?.lastOutputAt()) : undefined;
        return {
          ...ms,
          sharesLeadPlan: rt?.sharesLeadPlan ?? false,
          billableOverage: rt?.billableOverage ?? false,
          runsCommands,
          ...(elevated !== undefined ? { elevated } : {}),
          peerWakes: rt?.peerWakes ?? 0,
          ...(rt?.turn?.rssMb !== undefined ? { rssMb: rt.turn.rssMb } : {}),
          ...(rt?.lastActivity !== undefined ? { lastActivity: rt.lastActivity } : {}),
          ...(ms.turn !== undefined ? { turn: { ...ms.turn, ...(lastOutputAt !== undefined ? { lastOutputAt } : {}) } } : {}),
          worktree: {
            ...ms.worktree,
            ...(rt?.facts !== undefined ? { ahead: rt.facts.ahead, dirty: rt.facts.dirty, merged: rt.facts.merged } : {}),
          },
          ...(ms.attach !== undefined ? { attach: { ...ms.attach, client: rt?.attach?.client ?? '' } } : {}),
        };
      });
      return {
        ...s,
        lead: {
          ...s.lead,
          waiter: o.waiter !== undefined,
          lastCallAt: o.lastCallAt,
          wakesToday: o.wakes.filter((t) => t >= midnight).length,
        },
        budgets: { ...s.budgets, turnsToday, turnsPerDay: settings.teamTurnsPerDay, maxRunning: settings.teamMaxRunningTurns },
        members,
        warnings: [...s.warnings, ...extra],
      };
    } catch (err) {
      this.log(`overlay failed: ${errText(err)}`);
      return s;
    }
  }

  /** Rewrite state.json soon (overlay facts changed); debounced. */
  private touchState(): void {
    const o = this.owned;
    if (o === undefined || o.stateTimer !== undefined) {
      return;
    }
    o.stateTimer = setTimeout(() => {
      o.stateTimer = undefined;
      if (this.owned === o && !o.dropped) {
        try {
          o.store.writeState();
        } catch {
          // logged by the store
        }
      }
    }, 500);
  }

  /** A notice from the engine to each of `to` (lead, user, a member). */
  private noticeItems(to: ReadonlyArray<string>, kind: NoticeKind, text: string): LogAppend[] {
    return to.map((t) => this.msgItem('engine', t, 'notice', text, { source: 'engine', notice: kind }, 'engine'));
  }

  private msgItem(
    from: string,
    to: string,
    kind: MessageKind,
    text: string,
    opts: {
      source: MsgPostedBody['source'];
      urgent?: boolean;
      re?: string;
      task?: string;
      notice?: NoticeKind;
      report?: ReportMeta;
      recipients?: string[];
    },
    by: TeamEventBy,
  ): LogAppend {
    const body = cutBytes(text, MESSAGE_MAX_BYTES);
    const bytes = bytesOf(body);
    const posted: MsgPostedBody = {
      type: 'msg.posted',
      from,
      to,
      kind,
      urgent: opts.urgent === true,
      bytes,
      sha256: bodySha256(body),
      source: opts.source,
      ...(opts.recipients !== undefined ? { recipients: opts.recipients } : {}),
      ...(opts.re !== undefined ? { re: opts.re } : {}),
      ...(opts.task !== undefined ? { task: opts.task } : {}),
      ...(opts.notice !== undefined ? { notice: opts.notice } : {}),
      ...(opts.report !== undefined ? { report: opts.report } : {}),
    };
    if (bytes <= BODY_INLINE) {
      posted.body = body;
      return this.item(posted, by);
    }
    return this.item(posted, by, body);
  }

  private stateItem(name: string, state: MemberStateName, reason?: MemberReason): LogAppend {
    const r = reason !== undefined ? { ...reason, text: flat(reason.text) } : undefined;
    return this.item({ type: 'member.state', name, state, ...(r !== undefined ? { reason: r } : {}) });
  }

  private async setState(name: string, state: MemberStateName, reason?: MemberReason, extra: LogAppend[] = []): Promise<void> {
    await this.append([this.stateItem(name, state, reason), ...extra], { reserve: true, hold: true });
    this.touchState();
  }

  private async notice(to: ReadonlyArray<string>, kind: NoticeKind, text: string): Promise<void> {
    await this.append(this.noticeItems(to, kind, text), { hold: true });
  }

  private async storeWarning(text: string): Promise<void> {
    await this.append([this.item({ type: 'store.warning', text: flat(text) })], { reserve: true, hold: true });
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: reading
   * ------------------------------------------------------------------------- */

  team(): TeamState | undefined {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return undefined;
    }
    try {
      return o.store.state();
    } catch {
      return undefined;
    }
  }

  snapshotOf(teamId: string): TeamState | undefined {
    try {
      if (typeof teamId !== 'string' || !TEAM_ID.test(teamId)) {
        return undefined;
      }
      const o = this.owned;
      if (o !== undefined && o.teamId === teamId && !o.dropped) {
        return o.store.state();
      }
      const opened = this.seams.stores.open(teamId);
      if (!opened.ok) {
        return undefined;
      }
      const file = opened.value.readStateFile();
      if (file.ok) {
        return file.value;
      }
      const projected = opened.value.projectLog();
      return projected.ok ? projected.value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * TeamCore.listTeams. T11 E4 (A20): once this host's start-up sweep has run, a team of this
   * repository that is `active`/`readonly` with NO live owner (its host died after that sweep) is
   * listed as `suspended` with `reason: 'host gone'` — team_resume and team_create take it with the
   * one-team sweep. Before the start-up sweep it is left out, as it always was (the surface reports
   * what that sweep suspended by comparing the lists around it). E11: a `damaged` team carries its
   * reason — the listing's `damagedReason`, or what a sweep's acquire said.
   * CONTRACT-QUESTION: TeamCore.listTeams has no field for either text; `reason` is an addition
   * (structurally compatible) that a front end may print.
   */
  listTeams(): Array<{ teamId: string; name: string; state: TeamStatus; members: number; ownedHere: boolean; owner?: ProcessIdentity; reason?: string }> {
    try {
      const o = this.owned;
      const root = this.repoRootCache ?? o?.model.repoRoot;
      const out: Array<{ teamId: string; name: string; state: TeamStatus; members: number; ownedHere: boolean; owner?: ProcessIdentity; reason?: string }> = [];
      for (const listing of this.seams.stores.list()) {
        const ownedHere = o !== undefined && !o.dropped && o.teamId === listing.teamId;
        const headerRoot = listing.header?.repoRoot ?? listing.state.repoRoot;
        const sameRepo = root !== undefined ? headerRoot === root : listing.header?.workspace === this.runtime.workspace;
        if (!ownedHere && !sameRepo) {
          continue;
        }
        const liveOwner = listing.lease !== undefined && this.leaseIsLive(listing.lease.hostPid, listing.lease.hostStartedAt);
        let state: TeamStatus = ownedHere ? (o?.model.status ?? listing.state.status) : listing.state.status;
        let reason: string | undefined;
        const damaged = this.damagedSeen.get(listing.teamId);
        if (!ownedHere && damaged !== undefined && state !== 'ended') {
          state = 'damaged';
          reason = damaged;
        } else if (state === 'damaged') {
          reason = listing.state.damagedReason;
        } else if (!ownedHere && (state === 'active' || state === 'readonly') && !liveOwner && this.sweepDone) {
          state = 'suspended';
          reason = 'host gone';
        }
        if (!ownedHere && !(state === 'suspended' || state === 'ended' || state === 'damaged')) {
          continue;
        }
        const entry: { teamId: string; name: string; state: TeamStatus; members: number; ownedHere: boolean; owner?: ProcessIdentity; reason?: string } = {
          teamId: listing.teamId,
          name: listing.header?.name ?? listing.state.name,
          state,
          members: ownedHere ? (o?.model.members.size ?? 0) : listing.state.members.length,
          ownedHere,
          ...(reason !== undefined && reason !== '' ? { reason } : {}),
        };
        if (liveOwner && listing.lease !== undefined) {
          entry.owner = listing.lease.session;
        }
        out.push(entry);
        if (out.length >= TEAM_LIST_MAX) {
          break;
        }
      }
      return out;
    } catch (err) {
      this.log(`listTeams failed: ${errText(err)}`);
      return [];
    }
  }

  private leaseIsLive(pid: number, startedAt: number): boolean {
    try {
      if (!this.seams.host.process.isAlive(pid)) {
        return false;
      }
      const seen = this.seams.host.process.startedAt(pid);
      return seen === undefined || Math.abs(seen - startedAt) <= START_SLACK_MS;
    } catch {
      return true;
    }
  }

  onEvent(cb: (e: LogEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onActivity(cb: (member: string, items: FeedItem[]) => void): () => void {
    this.activityListeners.add(cb);
    return () => {
      this.activityListeners.delete(cb);
    };
  }

  eventsFrom(teamId: string, fromSeq: number, max: number): LogEvent[] | 'resnapshot_required' {
    try {
      if (typeof teamId !== 'string' || !TEAM_ID.test(teamId)) {
        return 'resnapshot_required';
      }
      const o = this.owned;
      const store = o !== undefined && o.teamId === teamId ? o.store : undefined;
      if (store !== undefined) {
        return store.eventsFrom(fromSeq, max);
      }
      const opened = this.seams.stores.open(teamId);
      return opened.ok ? opened.value.eventsFrom(fromSeq, max) : 'resnapshot_required';
    } catch {
      return 'resnapshot_required';
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: create / add (§7.3)
   * ------------------------------------------------------------------------- */

  create(file: TeamFile, by: 'lead'): Promise<Result<CreateAnswer>> {
    void by;
    return this.guarded(() => this.awaitSweep().then(() => this.exclusive(() => this.doCreate(file))));
  }

  add(file: MembersFile, by: 'lead'): Promise<Result<CreateAnswer>> {
    void by;
    return this.guarded(() => this.exclusive(() => this.doAdd(file)));
  }

  /** Any internal defect becomes a refusal naming it (never a rejection). */
  private async guarded<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await fn();
    } catch (err) {
      this.log(`internal failure: ${errText(err)}`);
      return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(errText(err)));
    }
  }

  private async awaitSweep(): Promise<void> {
    if (this.sweepPromise === undefined) {
      return;
    }
    await Promise.race([this.sweepPromise, sleep(this.tuning.sweepWaitMs)]);
  }

  /** §7.3 value checks of the member entries; problems appended to `problems`. */
  private checkMembers(
    entries: unknown,
    existing: ReadonlyMap<string, MemberModel>,
    teamName: string,
    settings: TeamHostSettings,
    problems: string[],
  ): MemberFileEntry[] {
    if (!Array.isArray(entries) || entries.length === 0) {
      problems.push('members must be a list of at least one member');
      return [];
    }
    const total = existing.size + entries.length;
    if (total > settings.teamMaxMembers) {
      problems.push(TEAM_TEXT.tooManyMembers(settings.teamMaxMembers, total));
    }
    const seen = new Set<string>();
    const workers = this.routingFacts()?.workers ?? [];
    const out: MemberFileEntry[] = [];
    for (const raw of entries) {
      if (!isPlainObject(raw)) {
        problems.push('every member must be an object');
        continue;
      }
      const name = typeof raw.name === 'string' ? raw.name : '';
      const shape = memberNameProblem(name);
      if (shape === 'shape') {
        problems.push(TEAM_TEXT.memberNameShape(flat(name, 40)));
      } else if (shape === 'reserved') {
        problems.push(TEAM_TEXT.memberNameReserved(name));
      } else if (existing.has(name)) {
        problems.push(TEAM_TEXT.memberExists(teamName, name, existing.get(name)?.state ?? 'stopped'));
      } else if (seen.has(name)) {
        problems.push(`member name "${name}" appears more than once`);
      }
      seen.add(name);
      const role = typeof raw.role === 'string' ? raw.role : '';
      const roleText = badTextProblem(`role of ${flat(name, 40)}`, role, true);
      if (roleText !== undefined) {
        problems.push(roleText);
      } else if (role.trim() === '' || [...role].length > ROLE_MAX_CHARS) {
        problems.push(`role of ${flat(name, 40)} must be 1–${ROLE_MAX_CHARS} characters on one line`);
      }
      const brief = typeof raw.brief === 'string' ? raw.brief : '';
      const briefText = badTextProblem(`brief of ${flat(name, 40)}`, brief, false);
      if (briefText !== undefined) {
        problems.push(briefText);
      } else if (brief.trim() === '' || bytesOf(brief) > BRIEF_MAX) {
        problems.push(`brief of ${flat(name, 40)} must be 1–${BRIEF_MAX} bytes`);
      }
      let provider: ProviderId | undefined;
      if (raw.provider !== undefined) {
        provider = parseProvider(raw.provider);
        if (provider === undefined) {
          problems.push(`provider of ${flat(name, 40)} must be claude, codex, cursor or gemini`);
        }
      }
      let worker: string | undefined;
      if (raw.worker !== undefined) {
        if (typeof raw.worker !== 'string' || raw.worker === '' || raw.worker.length > 200 || /[\u0000-\u001f\u007f]/.test(raw.worker)) {
          problems.push(`worker of ${flat(name, 40)} must be a worker name`);
        } else {
          worker = raw.worker;
          const w = workers.find((x) => x.name === worker);
          if (w !== undefined) {
            const wp = providerOfWorker(w);
            if (provider !== undefined && provider !== wp) {
              problems.push(TEAM_TEXT.workerProviderMismatch(w.name, wp, provider));
            }
            if (wp === 'gemini' && settings.teamAgySkipPermissions === 'on' && normalizeProviderPermissionMode('gemini', w.permissionMode) === 'plan') {
              problems.push(TEAM_TEXT.agyPlanMode(w.name));
            }
          }
        }
      }
      let model: string | undefined;
      if (raw.model !== undefined) {
        if (typeof raw.model !== 'string' || raw.model.trim() === '' || badTextProblem('model', raw.model, true) !== undefined) {
          problems.push(`model of ${flat(name, 40)} must be a model id`);
        } else {
          model = raw.model;
        }
      }
      const paths: string[] = [];
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths) || raw.paths.length > BOARD_PATHS_MAX) {
          problems.push(`paths of ${flat(name, 40)} must be a list of at most ${BOARD_PATHS_MAX} paths`);
        } else {
          for (const p of raw.paths) {
            const problem = boardPathProblem(p);
            if (problem !== undefined) {
              problems.push(TEAM_TEXT.invalidPath(flat(p, 80), problem));
            } else {
              paths.push(p as string);
            }
          }
        }
      }
      let start: string | false | undefined;
      if (raw.start !== undefined) {
        const startText = typeof raw.start === 'string' ? badTextProblem(`start of ${flat(name, 40)}`, raw.start, false) : undefined;
        if (raw.start === false) {
          start = false;
        } else if (startText !== undefined) {
          problems.push(startText);
        } else if (typeof raw.start === 'string' && raw.start.trim() !== '' && bytesOf(raw.start) <= START_MAX) {
          start = raw.start;
        } else {
          problems.push(`start of ${flat(name, 40)} must be false or a text of at most ${START_MAX} bytes`);
        }
      }
      out.push({
        name,
        role,
        brief,
        ...(provider !== undefined ? { provider } : {}),
        ...(worker !== undefined ? { worker } : {}),
        ...(model !== undefined ? { model } : {}),
        paths,
        ...(start !== undefined ? { start } : {}),
      });
    }
    return out;
  }

  /** §7.3 value checks of task entries. */
  private checkTasks(
    entries: unknown,
    existingCount: number,
    memberNames: ReadonlySet<string>,
    problems: string[],
  ): TaskFileEntry[] {
    if (entries === undefined) {
      return [];
    }
    if (!Array.isArray(entries)) {
      problems.push('tasks must be a list');
      return [];
    }
    if (existingCount + entries.length > BOARD_TASKS_MAX) {
      problems.push(TEAM_TEXT.boardFull());
    }
    const out: TaskFileEntry[] = [];
    for (const raw of entries) {
      if (!isPlainObject(raw)) {
        problems.push('every task must be an object');
        continue;
      }
      const title = typeof raw.title === 'string' ? raw.title : '';
      const titleText = badTextProblem(`task title "${flat(title, 40)}"`, title, true);
      if (titleText !== undefined) {
        problems.push(titleText);
      } else if (title.trim() === '' || [...title].length > BOARD_TITLE_MAX_CHARS) {
        problems.push(`task title "${flat(title, 40)}" must be 1–${BOARD_TITLE_MAX_CHARS} characters on one line`);
      }
      const bodyText = typeof raw.body === 'string' ? badTextProblem(`the body of task "${flat(title, 40)}"`, raw.body, false) : undefined;
      if (bodyText !== undefined) {
        problems.push(bodyText);
      } else if (raw.body !== undefined && (typeof raw.body !== 'string' || bytesOf(raw.body) > BOARD_BODY_MAX_BYTES)) {
        problems.push(`the body of task "${flat(title, 40)}" must be a text of at most ${BOARD_BODY_MAX_BYTES} bytes`);
      }
      if (raw.assignee !== undefined && (typeof raw.assignee !== 'string' || !memberNames.has(raw.assignee))) {
        problems.push(`the assignee of task "${flat(title, 40)}" must be a member of the team`);
      }
      const paths: string[] = [];
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths) || raw.paths.length > BOARD_PATHS_MAX) {
          problems.push(`the paths of task "${flat(title, 40)}" must be a list of at most ${BOARD_PATHS_MAX} paths`);
        } else {
          for (const p of raw.paths) {
            const problem = boardPathProblem(p);
            if (problem !== undefined) {
              problems.push(TEAM_TEXT.invalidPath(flat(p, 80), problem));
            } else {
              paths.push(p as string);
            }
          }
        }
      }
      if (raw.allow_overlap !== undefined && typeof raw.allow_overlap !== 'boolean') {
        problems.push(`allow_overlap of task "${flat(title, 40)}" must be true or false`);
      }
      out.push({
        title: flattenOneLine(title),
        ...(typeof raw.body === 'string' && raw.body !== '' ? { body: raw.body } : {}),
        ...(typeof raw.assignee === 'string' ? { assignee: raw.assignee } : {}),
        paths,
        allow_overlap: raw.allow_overlap === true,
      });
    }
    return out;
  }

  /**
   * §7.3's aggregated refusal (exit 20, then `Nothing was created.`). T11 S3/S7 (A36): when any
   * problem is an inline text the host refused (NUL, a lone surrogate, a control character in a
   * one-line value), the code is `invalid_text` — the other problems are still listed with it.
   */
  private problemsRefusal(problems: string[]): TeamRefusal {
    const code = problems.some((p) => p.endsWith(INVALID_TEXT_MARK)) ? 'invalid_text' : 'invalid_values';
    return teamRefusal(code, [...problems.slice(0, VALUE_PROBLEMS_MAX), TEAM_TEXT.nothingCreated()].join('\n'));
  }

  /** The members a team already has, as routing counts them (not stopped/ended). */
  private routedTeam(model: TeamModel | undefined, extra: RoutedMember[] = []): RoutedMember[] {
    const out: RoutedMember[] = [...extra];
    if (model !== undefined) {
      for (const m of model.members.values()) {
        if (m.state !== 'stopped' && m.state !== 'ended' && m.worker !== '') {
          out.push({ name: m.name, provider: m.provider, accountKey: m.accountKey, worker: m.worker });
        }
      }
    }
    return out;
  }

  /** §7.3 step 7: route every new member from CACHED facts (M15), nothing spawned. */
  private async routeNew(
    entries: MemberFileEntry[],
    model: TeamModel | undefined,
    problems: string[],
  ): Promise<Map<string, RouteChoice>> {
    const facts = this.routingFacts();
    const routes = new Map<string, RouteChoice>();
    if (facts === undefined) {
      problems.push('the registry could not be read, so no member could be routed');
      return routes;
    }
    const placed: RoutedMember[] = [];
    for (const e of entries) {
      const route = await routeMember(
        {
          member: e.name,
          spec: { provider: e.provider as ProviderId | undefined, worker: e.worker, model: e.model },
          team: this.routedTeam(model, placed),
          mode: 'cached',
        },
        facts,
      );
      if (!route.ok) {
        problems.push(route.kind === 'other' && route.perProvider !== undefined ? route.text : TEAM_TEXT.noAccount(e.name, [{ provider: e.provider ?? 'auto', reason: route.text }]));
        continue;
      }
      routes.set(e.name, route);
      placed.push({ name: e.name, provider: route.provider, accountKey: route.accountKey, worker: route.worker.name });
    }
    return routes;
  }

  /** The events of new members (§7.3 step 8): member.added + member.routed (+ member.mailbox for agy without the opt-in). */
  private memberItems(entries: MemberFileEntry[], routes: Map<string, RouteChoice>, firstIndex: number, settings: TeamHostSettings): LogAppend[] {
    const items: LogAppend[] = [];
    entries.forEach((e, i) => {
      const route = routes.get(e.name);
      if (route === undefined) {
        return;
      }
      const spec: MemberSpecRecord = {
        ...(e.provider !== undefined ? { provider: e.provider as ProviderId } : {}),
        ...(e.worker !== undefined ? { worker: e.worker } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
        paths: e.paths ?? [],
        ...(e.start !== undefined ? { start: e.start } : {}),
      };
      items.push(
        this.item({ type: 'member.added', name: e.name, index: firstIndex + i, role: flattenOneLine(e.role), briefBytes: bytesOf(e.brief), spec }, 'lead'),
      );
      items.push(this.routedItem(e.name, 1, route, 'initial'));
      if (route.provider === 'gemini' && elevationOf('gemini', settings) === undefined) {
        items.push(this.item({ type: 'member.mailbox', name: e.name, mailbox: 'turns-only', reason: 'agy approvals' }));
      }
    });
    return items;
  }

  private routedItem(name: string, incarnation: number, route: RouteChoice, cause: RouteCause, reason?: string): LogAppend {
    return this.item({
      type: 'member.routed',
      name,
      incarnation,
      provider: route.provider,
      worker: route.worker.name,
      accountKey: route.accountKey,
      model: route.model,
      modelSource: route.modelSource,
      reason: flat(reason ?? route.reason),
      cause,
    });
  }

  /** Board tasks of a file as `board.created` events (+ the body files and assignment messages). */
  private taskItems(
    tasks: TaskFileEntry[],
    firstN: number,
    by: 'lead' | 'user',
    files: Array<{ rel: string; text: string }>,
    now: number,
  ): { items: LogAppend[]; created: BoardTask[] } {
    const items: LogAppend[] = [];
    const created: BoardTask[] = [];
    tasks.forEach((t, i) => {
      const id = boardIdOf(firstN + i);
      const body = t.body ?? '';
      const task: BoardTask = {
        id,
        title: t.title,
        state: t.assignee !== undefined ? 'claimed' : 'open',
        ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
        paths: t.paths ?? [],
        allowOverlap: t.allow_overlap === true,
        createdBy: by,
        createdAt: now,
        reports: [],
        commits: [],
        turns: [],
        updatedAt: now,
        updatedBy: by,
      };
      if (body !== '') {
        if (bytesOf(body) > BOARD_BODY_INLINE) {
          const rel = `bodies/${id}.md`;
          files.push({ rel, text: body });
          task.bodyFile = rel;
        } else {
          task.body = body;
        }
      }
      items.push(this.item({ type: 'board.created', task }, by));
      created.push(task);
      if (t.assignee !== undefined) {
        items.push(this.msgItem(by, t.assignee, 'assignment', this.assignmentText(task, body), { source: by === 'lead' ? 'cco' : 'frontend', task: id }, by));
      }
    });
    return { items, created };
  }

  private assignmentText(task: BoardTask, body: string): string {
    const paths = task.paths.length > 0 ? `\nPaths: ${task.paths.join(', ')}` : '';
    return `${task.id} "${task.title}" is assigned to you.${paths}${body !== '' ? `\n\n${body}` : ''}`;
  }

  private checkWorktreeSpec(raw: unknown, problems: string[]): { setup?: { argv: string[]; timeoutMs: number }; timeoutMs: number } {
    const out: { setup?: { argv: string[]; timeoutMs: number }; timeoutMs: number } = {
      timeoutMs: WORKTREE_TIMEOUT_MINUTES.default * 60_000,
    };
    if (raw === undefined) {
      return out;
    }
    if (!isPlainObject(raw)) {
      problems.push('worktree must be an object');
      return out;
    }
    const minutes = (v: unknown, r: { default: number; min: number; max: number }, what: string): number => {
      if (v === undefined) {
        return r.default;
      }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < r.min || v > r.max) {
        problems.push(`${what} must be a whole number of minutes from ${r.min} to ${r.max}`);
        return r.default;
      }
      return v;
    };
    out.timeoutMs = minutes(raw.timeout_minutes, WORKTREE_TIMEOUT_MINUTES, 'worktree.timeout_minutes') * 60_000;
    if (raw.setup !== undefined) {
      const s = raw.setup;
      if (!isPlainObject(s) || !Array.isArray(s.argv) || s.argv.length === 0 || s.argv.length > SETUP_ARGV_MAX) {
        problems.push(`worktree.setup.argv must be a list of 1–${SETUP_ARGV_MAX} strings`);
      } else {
        const argv = s.argv;
        const bad = argv.some((a) => typeof a !== 'string' || a === '' || a.length > SETUP_ARG_MAX_CHARS || badTextProblem('', a, false) !== undefined);
        const first = typeof argv[0] === 'string' ? argv[0] : '';
        if (bad) {
          problems.push(`every worktree.setup.argv string must be 1–${SETUP_ARG_MAX_CHARS} characters`);
        } else if (first.includes('/') && !path.isAbsolute(first)) {
          problems.push('worktree.setup.argv[0] must be a bare command name or an absolute path');
        } else {
          out.setup = { argv: argv as string[], timeoutMs: minutes(s.timeout_minutes, SETUP_TIMEOUT_MINUTES, 'worktree.setup.timeout_minutes') * 60_000 };
        }
      }
    }
    return out;
  }

  private async doCreate(file: TeamFile): Promise<Result<CreateAnswer>> {
    if (this.seams.host.platform === 'win32') {
      return teamRefusal('unsupported_platform', TEAM_TEXT.unsupportedPlatform());
    }
    const settings = this.settings();
    if (settings.teamMode !== 'on') {
      return teamRefusal('team_mode_off', TEAM_TEXT.teamModeOff());
    }
    if (this.suspendPromise !== undefined) {
      return teamRefusal('suspending', TEAM_TEXT.suspending());
    }
    if (!isPlainObject(file)) {
      return this.problemsRefusal(['the team file must be a JSON object']);
    }
    const o = this.owned;
    if (o !== undefined && !o.dropped && (o.model.status === 'active' || o.model.status === 'readonly')) {
      if (file.name === o.model.name) {
        const names = Array.isArray(file.members) ? file.members.map((m) => (isPlainObject(m) && typeof m.name === 'string' ? m.name : '')) : [];
        return okResult({
          state: this.team() ?? this.fallbackState(o),
          outcome: 'exists' as const,
          baseRef: typeof file.base === 'string' ? file.base : 'HEAD',
          members: [...o.model.members.keys()],
          missing: names.filter((n) => n !== '' && !o.model.members.has(n)),
        });
      }
      return teamRefusal('already_leading', TEAM_TEXT.alreadyLeading(o.model.name));
    }
    // (2) the file's values
    const problems: string[] = [];
    const name = typeof file.name === 'string' ? file.name : '';
    if (!TEAM_NAME.test(name)) {
      problems.push(`team name "${flat(name, 40)}" is not allowed: use 1–32 lowercase letters, digits or hyphens, starting with a letter`);
    }
    const title = typeof file.title === 'string' ? file.title : name;
    const titleText = badTextProblem('title', title, true);
    if (titleText !== undefined) {
      problems.push(titleText);
    } else if ([...title].length > TITLE_MAX_CHARS) {
      problems.push(`title must be at most ${TITLE_MAX_CHARS} characters on one line`);
    }
    const goal = typeof file.goal === 'string' ? file.goal : '';
    const goalText = badTextProblem('goal', goal, false);
    if (goalText !== undefined) {
      problems.push(goalText);
    } else if (goal.trim() === '' || bytesOf(goal) > GOAL_MAX) {
      problems.push(`goal must be 1–${GOAL_MAX} bytes`);
    }
    const baseRef = file.base === undefined ? 'HEAD' : typeof file.base === 'string' && file.base.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(file.base) ? file.base : '';
    if (baseRef === '') {
      problems.push('base must be a git ref');
    }
    const members = this.checkMembers(file.members, new Map(), name, settings, problems);
    const names = new Set(members.map((m) => m.name));
    const tasks = this.checkTasks(file.tasks, 0, names, problems);
    const wt = this.checkWorktreeSpec(file.worktree, problems);
    if (problems.length > 0) {
      return this.problemsRefusal(problems);
    }
    // (3) repository
    const repo = await this.seams.worktrees.repository(this.runtime.workspace);
    if (!repo.ok) {
      return teamRefusal('not_git', TEAM_TEXT.notGit(this.runtime.workspace, flat(repo.text)));
    }
    this.repoRootCache = repo.value.repoRoot;
    // (4) uniqueness among the repository's non-ended teams — T11 E4 (A20): a same-name team whose
    // host died is swept first, so the refusal names what it is (suspended), never a dead "active".
    await this.sweepStale(repo.value.repoRoot, name);
    for (const listing of this.seams.stores.list()) {
      const lr = listing.header?.repoRoot ?? listing.state.repoRoot;
      if (lr === repo.value.repoRoot && (listing.header?.name ?? listing.state.name) === name && listing.state.status !== 'ended') {
        const damaged = this.damagedSeen.get(listing.teamId) ?? (listing.state.status === 'damaged' ? listing.state.damagedReason : undefined);
        return teamRefusal('name_in_use', TEAM_TEXT.nameInUse(name, damaged !== undefined ? `damaged: ${flat(damaged, 200)}` : listing.state.status));
      }
    }
    // (5) base — T11 E3 (A19): resolved in the LEAD'S WORKSPACE (in a linked worktree its HEAD is
    // that worktree's, not the main checkout's); repoRoot stays the target of `worktree add`.
    const base = await this.seams.worktrees.resolveBase(this.runtime.workspace, baseRef);
    if (!base.ok) {
      return this.problemsRefusal([`base ${flat(baseRef, 80)} names no commit (git said: ${flat(base.text)})`]);
    }
    // (6) disk
    const free = await this.seams.worktrees.freeBytes(path.join(this.runtime.dataRoot, 'worktrees'));
    if (free !== undefined && free < DISK_MIN_FREE) {
      // CONTRACT-QUESTION: §7.3 spells the disk sentence but no code; `invalid_values` (exit 20, nothing created) is used.
      return this.problemsRefusal([TEAM_TEXT.diskSpace(Math.floor((free / 1024 ** 3) * 10) / 10, path.join(this.runtime.dataRoot, 'worktrees'))]);
    }
    // (7) routing from cached facts
    const routes = await this.routeNew(members, undefined, problems);
    if (problems.length > 0) {
      return this.problemsRefusal(problems);
    }
    // (8) the events
    const now = Date.now();
    const teamId = newTeamId(now);
    const header: TeamHeader = {
      v: 1,
      id: teamId,
      name,
      title: flattenOneLine(title),
      workspace: this.runtime.workspace,
      repoRoot: repo.value.repoRoot,
      commonDir: repo.value.commonDir,
      createdAt: now,
    };
    const files: Array<{ rel: string; text: string }> = [];
    const goalBytes = bytesOf(goal);
    const goalField = goalBytes > BODY_INLINE ? { bytes: goalBytes, file: GOAL_FILE } : { bytes: goalBytes, text: goal };
    if (goalBytes > BODY_INLINE) {
      files.push({ rel: GOAL_FILE, text: goal });
    }
    for (const m of members) {
      files.push({ rel: `members/${m.name}/assignment.md`, text: m.brief });
    }
    files.push({ rel: 'worktree.json', text: `${JSON.stringify({ setup: wt.setup, worktreeTimeoutMs: wt.timeoutMs })}\n` });
    const events: LogAppend[] = [
      this.item(
        {
          type: 'team.created',
          name,
          title: header.title,
          workspace: header.workspace,
          repoRoot: header.repoRoot,
          commonDir: header.commonDir,
          baseCommit: base.value,
          leadRel: repo.value.leadRel,
          goal: goalField,
        },
        'lead',
      ),
      ...this.memberItems(members, routes, 1, settings),
      ...this.taskItems(tasks, 1, 'lead', files, now).items,
    ];
    const created = await this.seams.stores.create({ header, events, files });
    if (!created.ok) {
      return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(created)));
    }
    const adopted = this.adopt(created.value, header, repo.value.repoHash);
    if ('ok' in adopted) {
      return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(adopted)));
    }
    adopted.setup = wt.setup;
    adopted.worktreeTimeoutMs = wt.timeoutMs;
    for (const [n, route] of routes) {
      const rt = this.memberRt(n);
      rt.sharesLeadPlan = route.sharesLeadPlan;
      rt.billableOverage = route.billableOverage;
    }
    this.writeMemberFiles(adopted, [...adopted.model.members.keys()]);
    try {
      this.seams.stores.prune(repo.value.repoRoot);
    } catch {
      // retention is best effort
    }
    this.startBringUp(adopted);
    return okResult(
      {
        state: this.team() ?? this.fallbackState(adopted),
        outcome: 'created' as const,
        baseRef,
        members: members.map((m) => m.name),
        ...(repo.value.dirtyFiles > 0 ? { dirtyFiles: repo.value.dirtyFiles } : {}),
      },
      this.memberWarnings(routes),
    );
  }

  /**
   * The Result warnings of team_create / team_add. The elevated-permission notes are not here:
   * renderCreateAnswer writes them from each member's `elevated` state, and adding them here too
   * printed every note twice (seen live).
   */
  private memberWarnings(routes: Map<string, RouteChoice>): string[] {
    const out: string[] = [];
    for (const [name, r] of routes) {
      if (r.sharesMachineLoginWith !== undefined && (r.provider === 'cursor' || r.provider === 'gemini')) {
        out.push(TEAM_TEXT.sharesMachineLogin(r.provider, r.sharesMachineLoginWith));
      }
    }
    return out;
  }

  private fallbackState(o: Owned): TeamState {
    const m = o.model;
    return {
      v: 1,
      id: o.teamId,
      name: m.name,
      title: m.title,
      status: m.status,
      workspace: m.workspace,
      repoRoot: m.repoRoot,
      leadRel: m.leadRel,
      baseCommit: m.baseCommit,
      createdAt: m.createdAt,
      seq: m.seq,
      owner: null,
      lead: { unread: m.unreadFor('lead').length, readSeq: m.read.lead, waiter: false, lastCallAt: null, wakesToday: 0 },
      user: { unread: m.unreadFor('user').length, readSeq: m.read.user },
      members: [],
      board: [...m.board.values()],
      budgets: { turnsToday: 0, turnsPerDay: 0, running: 0, maxRunning: 0, pingPongTripped: m.pingPongTripped },
      totals: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
      warnings: [],
    };
  }

  private async doAdd(file: MembersFile): Promise<Result<CreateAnswer>> {
    if (this.seams.host.platform === 'win32') {
      return teamRefusal('unsupported_platform', TEAM_TEXT.unsupportedPlatform());
    }
    const settings = this.settings();
    if (settings.teamMode !== 'on') {
      return teamRefusal('team_mode_off', TEAM_TEXT.teamModeOff());
    }
    const o = this.leading({ mutate: true });
    if ('ok' in o) {
      return o;
    }
    if (!isPlainObject(file)) {
      return this.problemsRefusal(['the members file must be a JSON object']);
    }
    const problems: string[] = [];
    const members = this.checkMembers(file.members, o.model.members, o.model.name, settings, problems);
    const names = new Set([...o.model.members.keys(), ...members.map((m) => m.name)]);
    const tasks = this.checkTasks(file.tasks, o.model.board.size, names, problems);
    if (problems.length > 0) {
      return this.problemsRefusal(problems);
    }
    const repo = await this.seams.worktrees.repository(this.runtime.workspace);
    if (!repo.ok) {
      return teamRefusal('not_git', TEAM_TEXT.notGit(this.runtime.workspace, flat(repo.text)));
    }
    // T11 E3 (A19): team_add's HEAD is the recorded lead checkout's (team.created's workspace).
    const head = await this.seams.worktrees.resolveBase(o.model.workspace !== '' ? o.model.workspace : this.runtime.workspace, 'HEAD');
    const free = await this.seams.worktrees.freeBytes(path.join(this.runtime.dataRoot, 'worktrees'));
    if (free !== undefined && free < DISK_MIN_FREE) {
      return this.problemsRefusal([TEAM_TEXT.diskSpace(Math.floor((free / 1024 ** 3) * 10) / 10, path.join(this.runtime.dataRoot, 'worktrees'))]);
    }
    const routes = await this.routeNew(members, o.model, problems);
    if (problems.length > 0) {
      return this.problemsRefusal(problems);
    }
    for (const m of members) {
      const w = o.store.writeFile(`members/${m.name}/assignment.md`, m.brief);
      if (!w.ok) {
        return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(w)));
      }
    }
    const files: Array<{ rel: string; text: string }> = [];
    const firstIndex = Math.max(0, ...[...o.model.members.values()].map((m) => m.index)) + 1;
    const taskPart = this.taskItems(tasks, o.model.boardMax + 1, 'lead', files, Date.now());
    for (const f of files) {
      const w = o.store.writeFile(f.rel, f.text);
      if (!w.ok) {
        return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(w)));
      }
    }
    const r = await this.append([...this.memberItems(members, routes, firstIndex, settings), ...taskPart.items]);
    if (!r.ok) {
      return this.storeRefusal(o, r);
    }
    for (const [n, route] of routes) {
      const rt = this.memberRt(n);
      rt.sharesLeadPlan = route.sharesLeadPlan;
      rt.billableOverage = route.billableOverage;
      if (head.ok) {
        rt.baseCommit = head.value;
      }
    }
    // The roster in every brief changes with a team_add (§3.6).
    this.writeMemberFiles(o, [...o.model.members.keys()]);
    this.startBringUp(o);
    this.poke();
    return okResult(
      {
        state: this.team() ?? this.fallbackState(o),
        outcome: 'added' as const,
        baseRef: 'HEAD',
        members: members.map((m) => m.name),
        ...(repo.value.dirtyFiles > 0 ? { dirtyFiles: repo.value.dirtyFiles } : {}),
      },
      this.memberWarnings(routes),
    );
  }

  private storeRefusal(o: Owned, f: StoreFailure): TeamRefusal {
    if (f.code === 'log-full') {
      return teamRefusal('team_readonly', TEAM_TEXT.teamReadonly(o.model.name));
    }
    if (f.code === 'lease-lost' || f.code === 'not-owner') {
      return teamRefusal('no_team', TEAM_TEXT.noTeam());
    }
    return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(f)));
  }

  /**
   * Credentials (re-minted at every lease acquisition), tool specs, Claude's mcp.json and the
   * composed briefs (§2.2, §3.6, §3.9) — each written before anything that names it runs. A write
   * that fails is a `store.warning`; the member's next turn will fail to reach its tools and the
   * turns-only verdict says so.
   */
  private writeMemberFiles(o: Owned, names: string[]): void {
    const failures: string[] = [];
    for (const name of names) {
      const m = o.model.members.get(name);
      if (m === undefined || m.state === 'ended') {
        continue;
      }
      const files = memberFilesOf(this.teamDir(o.teamId), name);
      const credential = o.store.writeFile(`members/${name}/credential`, `${newCredential()}\n`);
      const spec: TeamToolSpec = {
        protocol: PROTOCOL_VERSION,
        socket: this.runtime.socket,
        teamId: o.teamId,
        member: name,
        credentialFile: files.credential,
        hostPid: this.runtime.host.pid,
        hostStartedAt: this.runtime.host.startedAt,
      };
      const toolSpec = o.store.writeFile(`members/${name}/tool-spec.json`, `${JSON.stringify(spec)}\n`);
      const mcp = o.store.writeFile(
        `members/${name}/mcp.json`,
        teamMcpConfigText(this.runtime.nodePath, this.runtime.cliJsPath, files.toolSpec),
      );
      const brief = this.composeBrief(o, m);
      o.briefs.set(name, brief);
      const briefWrite = o.store.writeFile(`members/${name}/brief.md`, brief);
      for (const [what, r] of [
        ['credential', credential],
        ['tool spec', toolSpec],
        ['mcp.json', mcp],
        ['brief', briefWrite],
      ] as const) {
        if (!r.ok) {
          failures.push(`${name}'s ${what}: ${storeErrno(r)}`);
        }
      }
    }
    if (failures.length > 0) {
      void this.storeWarning(`member files could not be written — ${failures.join('; ')}`);
    }
  }

  private goalText(o: Owned): string {
    if (o.model.goal.text !== undefined) {
      return o.model.goal.text;
    }
    if (o.model.goal.file !== undefined) {
      const r = o.store.readFile(o.model.goal.file, GOAL_MAX + 1024);
      if (r.ok) {
        return r.value;
      }
    }
    return '(the team goal could not be read)';
  }

  private worktreePathOf(o: Owned, m: MemberModel): { path: string; branch: string } {
    if (m.plan !== undefined) {
      return { path: m.plan.path, branch: m.plan.branch };
    }
    return {
      path: memberWorktreeOf(this.runtime.dataRoot, o.repoHash, o.teamSlug, m.name),
      branch: teamBranchOf(o.teamSlug, m.name),
    };
  }

  private runsCommands(m: MemberModel): boolean {
    const settings = this.settings();
    const worker = this.workerByName(m.worker);
    const elevated = elevationOf(m.provider, settings) !== undefined;
    return runsCommandsOf(
      m.provider,
      m.provider === 'claude' ? settings.permissionMode : normalizeProviderPermissionMode(m.provider, worker?.permissionMode),
      elevated,
    );
  }

  private composeBrief(o: Owned, m: MemberModel): string {
    const wt = this.worktreePathOf(o, m);
    const vars: TeamMemberProtocolVars = {
      team: o.model.name,
      member: m.name,
      role: m.role,
      teammates: [...o.model.members.values()]
        .filter((x) => x.name !== m.name && x.state !== 'ended')
        .map((x) => ({ name: x.name, role: x.role })),
      cwd: wt.path,
      branch: wt.branch,
      leadRel: o.model.leadRel,
      briefPath: memberFilesOf(this.teamDir(o.teamId), m.name).brief,
      portBase: memberPortBase(m.index),
      runsCommands: this.runsCommands(m),
      mailbox: m.mailbox,
    };
    const assignment = o.store.readFile(`members/${m.name}/assignment.md`, BRIEF_MAX + 1024);
    return teamMemberBrief(vars, this.goalText(o), assignment.ok ? assignment.value : '(the lead\'s brief could not be read)');
  }

  /* ------------------------------------------------------------------------- *
   * Bring-up: live account checks, the Codex model, worktrees (§6.3, §6.2 step 6, §9.1)
   * ------------------------------------------------------------------------- */

  private bringUpQueue: Promise<void> = Promise.resolve();

  /** Members in `starting` get their worktree, sequentially per team (§9.1), in the background. */
  private startBringUp(o: Owned): void {
    for (const m of o.model.members.values()) {
      const rt = this.memberRt(m.name);
      if (m.state === 'starting' && !rt.bringingUp) {
        rt.bringingUp = true;
        this.bringUpQueue = this.bringUpQueue.then(() => this.bringUp(o, m.name)).catch((err) => this.log(`bring-up failed: ${errText(err)}`));
      }
    }
  }

  private async bringUp(o: Owned, name: string): Promise<void> {
    const rt = this.memberRt(name);
    try {
      if (this.owned !== o || o.dropped || o.suspending || o.ending) {
        return;
      }
      const ok = await this.liveCheck(o, name);
      if (!ok) {
        return;
      }
      const m = o.model.members.get(name);
      if (m === undefined || m.state !== 'starting') {
        return;
      }
      // §9.1 step 1: write-ahead.
      if (m.ready === undefined) {
        const plan = m.plan ?? {
          ...this.worktreePathOf(o, m),
          baseCommit: rt.baseCommit ?? o.model.baseCommit,
        };
        if (m.plan === undefined) {
          const r = await this.exclusive(() =>
            this.append([this.item({ type: 'member.worktree.planned', name, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit })]),
          );
          if (!r.ok) {
            return;
          }
        }
        const populated = await this.seams.worktrees.populate(
          { repoRoot: o.model.repoRoot, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
          { timeoutMs: o.worktreeTimeoutMs, signal: o.abort.signal },
        );
        if (!populated.ok) {
          if (populated.code === 'aborted') {
            return;
          }
          await this.exclusive(() => this.block(name, 'worktree', `${populated.code}: ${populated.text}`));
          return;
        }
        if (populated.value.lfs === 'pointers') {
          await this.exclusive(() => this.notice(['lead'], 'checkpoint', `${name}'s worktree holds Git LFS pointers (git-lfs is not installed); LFS files are not checked out there.`));
        }
        const r = await this.exclusive(() =>
          this.append([this.item({ type: 'member.worktree', name, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit, cwd: plan.path })]),
        );
        if (!r.ok) {
          return;
        }
        if (o.setup !== undefined) {
          const lines: string[] = [];
          const setup = await this.seams.worktrees.runSetup(
            plan.path,
            { argv: o.setup.argv, timeoutMs: o.setup.timeoutMs, teamMemberEnv: teamMemberEnvValue(o.teamId, name, m.incarnation) },
            {
              signal: o.abort.signal,
              onLine: (line) => {
                lines.push(line);
                this.feed(name, [{ ts: Date.now(), turn: '', k: 'notice', s: line }]);
              },
            },
          );
          if (!setup.ok) {
            if (setup.code !== 'aborted') {
              await this.exclusive(() => this.block(name, 'setup', setup.text));
            }
            return;
          }
        }
      }
      await this.exclusive(async () => {
        const now = o.model.members.get(name);
        if (now !== undefined && now.state === 'starting') {
          await this.setState(name, 'idle');
        }
      });
      this.poke();
    } finally {
      rt.bringingUp = false;
    }
  }

  /**
   * §6.3 / M15: before a member's FIRST turn, the live login check of its account (pickWorkerLive)
   * and — for a Codex member with no model — the one background model lookup. A re-route stays in
   * the provider (`member.routed cause=initial` again + notice); nothing eligible → blocked.
   */
  private async liveCheck(o: Owned, name: string): Promise<boolean> {
    const rt = this.memberRt(name);
    const m = o.model.members.get(name);
    if (m === undefined || rt.liveChecked) {
      return m !== undefined;
    }
    rt.liveChecked = true;
    const facts = this.routingFacts();
    if (facts === undefined) {
      return true;
    }
    const worker = facts.workers.find((w) => w.name === m.worker);
    let picked: { ok: true } | { ok: false; text: string } = { ok: true };
    if (worker === undefined) {
      picked = { ok: false, text: `worker ${m.worker} is no longer in the registry` };
    } else {
      try {
        const r = await facts.pick(facts.workers, m.worker, new Set(), m.model === '' ? undefined : m.model, 'live');
        picked = r.ok ? { ok: true } : { ok: false, text: r.text };
      } catch (err) {
        picked = { ok: true };
        this.log(`live check of ${name} failed: ${errText(err)}`);
      }
    }
    if (!picked.ok) {
      const old = m.worker;
      const route = await routeMember(
        {
          member: name,
          spec: { model: m.spec.model },
          team: this.routedTeam(o.model),
          failedIdentities: new Set(worker !== undefined ? identityKeysOf(worker, facts) : [m.accountKey]),
          forceProvider: m.provider,
          mode: 'live',
        },
        facts,
      );
      const ok = await this.exclusive(async () => {
        if (route.ok) {
          await this.append([
            this.routedItem(name, m.incarnation, route, 'initial'),
            ...this.noticeItems(['lead'], 'routing', TEAM_NOTICE.reroutedBeforeFirstTurn(name, route.provider, route.accountLabel, old)),
          ]);
          rt.sharesLeadPlan = route.sharesLeadPlan;
          rt.billableOverage = route.billableOverage;
          return true;
        }
        await this.block(name, route.kind === 'quota' ? 'quota' : 'login', picked.ok ? route.text : `${picked.text}; ${route.text}`);
        return false;
      });
      if (!ok) {
        return false;
      }
    }
    return this.resolveCodexModel(o, name);
  }

  /** §6.2 step 6: a Codex member with no model gets the CLI's default (one lookup), else `blocked: cli`. */
  private async resolveCodexModel(o: Owned, name: string): Promise<boolean> {
    const m = o.model.members.get(name);
    if (m === undefined || m.provider !== 'codex' || m.model !== '') {
      return true;
    }
    const worker = this.workerByName(m.worker);
    let model: string | undefined;
    if (worker !== undefined) {
      try {
        model = await Promise.race([this.seams.host.codexModelLive(worker), sleep(this.tuning.codexModelLookupMs).then(() => undefined)]);
      } catch {
        model = undefined;
      }
    }
    return this.exclusive(async () => {
      const now = o.model.members.get(name);
      if (now === undefined) {
        return false;
      }
      if (typeof model === 'string' && model !== '') {
        await this.append([
          this.item({
            type: 'member.routed',
            name,
            incarnation: now.incarnation,
            provider: now.provider,
            worker: now.worker,
            accountKey: now.accountKey,
            model,
            modelSource: 'cli',
            reason: flat(`model ${model}: the CLI's default`),
            cause: now.routeCause ?? 'initial',
          }),
        ]);
        return true;
      }
      await this.block(name, 'cli', TEAM_TEXT.codexNeedsModel(now.worker));
      return false;
    });
  }

  /** `blocked: <code>` with a notice to the lead (and the user for login/quota). */
  private async block(name: string, code: MemberReasonCode, text: string, until?: number): Promise<void> {
    const reason: MemberReason = { code, text: flat(text), ...(until !== undefined ? { until } : {}) };
    await this.setState(name, 'blocked', reason, this.noticeItems(['lead'], 'blocked', `${name} is blocked: ${flat(text)}`));
  }

  /* ------------------------------------------------------------------------- *
   * The scheduler (§3.5 trigger rule, M12) and the turn lifecycle (§3.4)
   * ------------------------------------------------------------------------- */

  private poke(delay = this.tuning.idleWakeMs): void {
    if (this.pokeTimer !== undefined) {
      return;
    }
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = undefined;
      void this.exclusive(() => this.tick()).catch((err) => this.log(`scheduler failed: ${errText(err)}`));
    }, delay);
  }

  private runningCount(o: Owned): number {
    let n = 0;
    for (const rt of o.members.values()) {
      if (rt.turn !== undefined || rt.starting) {
        n++;
      }
    }
    return n;
  }

  /** M12: what would start this member's turn now, or undefined. */
  private triggerOf(o: Owned, m: MemberModel, rt: MemberRt): { trigger: TurnTrigger; peerOnly: boolean } | undefined {
    if (rt.holdUntil !== undefined && Date.now() < rt.holdUntil) {
      return undefined;
    }
    const pending = o.model.pendingFor(m.name);
    if (rt.urgentSeq !== undefined && pending.some((p) => p.seq === rt.urgentSeq)) {
      return { trigger: 'urgent', peerOnly: false };
    }
    if (rt.forced !== undefined) {
      return { trigger: rt.forced, peerOnly: false };
    }
    if (m.briefPending) {
      return { trigger: 'brief', peerOnly: false };
    }
    const wakers = pending.filter((p) => p.kind !== 'notice');
    if (wakers.length === 0) {
      return undefined;
    }
    const fromLeadOrUser = wakers.some((p) => p.from === 'lead' || p.from === 'user' || p.from === 'engine');
    if (fromLeadOrUser) {
      return { trigger: 'message', peerOnly: false };
    }
    if (rt.peerWakes >= PEER_WAKE_BUDGET || o.model.pingPongTripped) {
      return undefined;
    }
    return { trigger: 'message', peerOnly: true };
  }

  private canStartTurns(o: Owned): boolean {
    return this.owned === o && !o.dropped && !o.suspending && !o.ending && o.model.status === 'active' && o.hold.length === 0;
  }

  private async tick(): Promise<void> {
    const o = this.owned;
    if (o === undefined || !this.canStartTurns(o)) {
      return;
    }
    const settings = this.settings();
    const candidates: Array<{ m: MemberModel; rt: MemberRt; trigger: TurnTrigger; peerOnly: boolean; oldest: number }> = [];
    for (const m of o.model.members.values()) {
      const rt = this.memberRt(m.name);
      if (m.state !== 'idle' || rt.turn !== undefined || rt.starting || rt.attach !== undefined) {
        continue;
      }
      const t = this.triggerOf(o, m, rt);
      if (t === undefined) {
        if (rt.peerWakes >= PEER_WAKE_BUDGET && !rt.peerNoticed && o.model.pendingFor(m.name).some((p) => p.kind !== 'notice')) {
          rt.peerNoticed = true;
          await this.append([
            this.item({ type: 'budget.tripped', name: m.name, kind: 'peer-wakes' }),
            ...this.noticeItems(['lead'], 'budget', TEAM_NOTICE.peerWakes(m.name, rt.peerWakes)),
          ]);
        }
        continue;
      }
      const oldest = o.model.pendingFor(m.name)[0]?.seq ?? 0;
      candidates.push({ m, rt, ...t, oldest });
    }
    candidates.sort((a, b) => a.oldest - b.oldest);
    const now = Date.now();
    const midnight = localMidnight(now);
    let today = 0;
    for (const t of o.model.turns.values()) {
      if (t.plannedAt >= midnight) {
        today++;
      }
    }
    for (const c of candidates) {
      if (this.runningCount(o) >= settings.teamMaxRunningTurns) {
        break;
      }
      // M20: over a budget the member STAYS idle with reason `budget` and an `until`.
      let until: number | undefined;
      let kind: 'turns-per-day' | 'turns-per-hour' | undefined;
      if (today >= settings.teamTurnsPerDay) {
        until = midnight + 24 * 3_600_000;
        kind = 'turns-per-day';
      } else {
        const hourAgo = now - 3_600_000;
        const recent = [...o.model.turns.values()].filter((t) => t.name === c.m.name && t.plannedAt > hourAgo).map((t) => t.plannedAt).sort((a, b) => a - b);
        if (recent.length >= settings.teamTurnsPerMemberPerHour) {
          until = recent[recent.length - settings.teamTurnsPerMemberPerHour] + 3_600_000;
          kind = 'turns-per-hour';
        }
      }
      if (until !== undefined && kind !== undefined) {
        if (c.rt.budgetUntil !== until) {
          c.rt.budgetUntil = until;
          const text =
            kind === 'turns-per-day'
              ? `the team has used its ${settings.teamTurnsPerDay} turns of today`
              : `${c.m.name} has used its ${settings.teamTurnsPerMemberPerHour} turns of this hour`;
          await this.setState(c.m.name, 'idle', { code: 'budget', text, until }, [
            this.item({ type: 'budget.tripped', name: c.m.name, kind, until }),
            ...this.noticeItems(['lead'], 'budget', `${text}; ${c.m.name} continues at ${clockHHMM(until)}.`),
          ]);
          this.armTimer(c.m.name, until - now + 1_000, () => this.poke(0));
        }
        continue;
      }
      if (c.m.reason?.code === 'budget') {
        await this.setState(c.m.name, 'idle');
      }
      c.rt.budgetUntil = undefined;
      // §6.3: the account must still be usable — no doomed spawn.
      const account = await this.accountCheck(o, c.m);
      if (!account.ok) {
        await this.failover(o, c.m.name, account.kind, account.text);
        continue;
      }
      if (c.peerOnly) {
        c.rt.peerWakes++;
      } else if (c.trigger === 'message' || c.trigger === 'urgent') {
        c.rt.peerWakes = 0;
        c.rt.peerNoticed = false;
      }
      today++;
      this.launch(o, c.m.name, c.trigger);
    }
  }

  /** §6.3: the incarnation's account still exists, is logged in (cached) and not exhausted for its model. */
  private async accountCheck(o: Owned, m: MemberModel): Promise<{ ok: true } | { ok: false; kind: 'quota' | 'auth' | 'removed'; text: string }> {
    void o;
    const facts = this.routingFacts();
    if (facts === undefined) {
      return { ok: true };
    }
    if (!facts.workers.some((w) => w.name === m.worker)) {
      return { ok: false, kind: 'removed', text: `worker ${m.worker} is no longer in the registry` };
    }
    try {
      const r = await facts.pick(facts.workers, m.worker, new Set(), m.model === '' ? undefined : m.model, 'cached');
      if (r.ok) {
        return { ok: true };
      }
      return { ok: false, kind: /logged out|login/i.test(r.text) ? 'auth' : 'quota', text: r.text };
    } catch {
      return { ok: true };
    }
  }

  /** Start one member's turn: the slow preparation outside the chain, then plan + spawn inside it. */
  private launch(o: Owned, name: string, trigger: TurnTrigger): void {
    const rt = this.memberRt(name);
    rt.starting = true;
    void (async () => {
      try {
        const prep = await this.prepare(o, name, trigger);
        if (prep === undefined) {
          return;
        }
        await this.exclusive(() => this.spawnTurn(o, name, trigger, prep));
      } catch (err) {
        this.log(`turn start of ${name} failed: ${errText(err)}`);
      } finally {
        rt.starting = false;
        this.poke();
      }
    })();
  }

  private async prepare(
    o: Owned,
    name: string,
    trigger: TurnTrigger,
  ): Promise<{ minted?: string; packet?: string; stash?: string; projectConfigFile?: string; worker: WorkerProfile } | undefined> {
    const m = o.model.members.get(name);
    if (m === undefined || m.ready === undefined) {
      return undefined;
    }
    const worker = this.workerByName(m.worker);
    if (worker === undefined) {
      await this.exclusive(() => this.failover(o, name, 'removed', `worker ${m.worker} is no longer in the registry`));
      return undefined;
    }
    // Every later turn requires the worktree to exist (§2.5).
    const check = await this.seams.worktrees.check({ path: m.ready.path, branch: m.ready.branch });
    if (!check.ok) {
      const code: MemberReasonCode = check.code === 'missing' ? 'worktree-missing' : check.code === 'branch-moved' ? 'worktree-branch' : 'worktree';
      await this.exclusive(() => this.block(name, code, check.text));
      return undefined;
    }
    if (m.provider === 'codex' && m.model === '' && !(await this.resolveCodexModel(o, name))) {
      return undefined;
    }
    let minted: string | undefined;
    if ((m.provider === 'claude' || m.provider === 'cursor') && m.conversationId === undefined) {
      const r = await this.seams.mintConversation(m.provider, worker, m.ready.cwd, this.tuning.mintTimeoutMs, { log: (l) => this.log(l) });
      if (!r.ok) {
        await this.exclusive(() => this.earlyCrash(o, name, r.text, trigger));
        return undefined;
      }
      minted = r.conversationId;
    }
    const rt = this.memberRt(name);
    let packet: string | undefined;
    if (trigger === 'packet' || trigger === 'rebrief' || rt.packetNext) {
      packet = await this.composePacket(o, m, trigger === 'rebrief' ? TEAM_REBRIEF_REASON : (rt.packetReason ?? 'it was moved to a new conversation'));
    }
    let stash: string | undefined;
    const s = await this.seams.worktrees.readStash(o.model.repoRoot);
    if (s.ok) {
      stash = s.value;
    }
    const projectConfigFile = m.provider === 'claude' ? await this.projectMcp(o, m) : undefined;
    return { minted, packet, stash, ...(projectConfigFile !== undefined ? { projectConfigFile } : {}), worker };
  }

  /** §6.6: the hand-off packet's facts, gathered mechanically. */
  private async composePacket(o: Owned, m: MemberModel, reason: string): Promise<string> {
    const wt = m.ready ?? m.plan;
    const facts = wt !== undefined ? await this.seams.worktrees.handoffFacts({ path: wt.path, baseCommit: wt.baseCommit }) : undefined;
    const unavailable = { unavailable: 'the worktree is not ready' };
    const held = o.model.heldBy(m.name).map((t) => `${boardLine(t)}${t.note !== undefined ? ` — note: ${flat(t.note, 300)}` : ''}`);
    const reports: string[] = [];
    const messages: string[] = [];
    for (const msg of o.model.messages.values()) {
      if (msg.kind === 'report' && msg.from === m.name) {
        reports.push(this.messageBody(o, msg));
      } else if ((msg.from === m.name || msg.to === m.name) && msg.kind !== 'notice' && msg.kind !== 'report') {
        messages.push(`${messageIdOf(msg.seq)} · from ${msg.from} to ${msg.to} · ${msg.kind}: ${this.messageBody(o, msg)}`);
      }
    }
    return teamHandoffPacket({
      fence: newFenceId(),
      member: m.name,
      role: m.role,
      team: o.model.name,
      incarnation: m.incarnation,
      isoTime: isoTime(Date.now()),
      provider: m.provider,
      worker: accountLabelOf({ name: m.worker, provider: m.provider }),
      model: m.model,
      reason,
      branch: wt?.branch ?? '',
      baseCommit: wt?.baseCommit ?? o.model.baseCommit,
      commits: facts?.commits ?? unavailable,
      uncommitted: facts?.uncommitted ?? unavailable,
      diffStat: facts?.diffStat ?? unavailable,
      tasks: held,
      reports: reports.slice(-3),
      messages: messages.slice(-10),
    });
  }

  private messageBody(o: Owned, msg: MsgPostedEvent): string {
    if (typeof msg.body === 'string') {
      return msg.body;
    }
    try {
      const r = o.store.messageText(msg);
      return r.ok ? r.value : `(the body of ${messageIdOf(msg.seq)} could not be read: ${r.reason})`;
    } catch (err) {
      return `(the body of ${messageIdOf(msg.seq)} could not be read: ${errText(err)})`;
    }
  }

  /** §3.6.1 + §4.2: the bundle — the urgent message first, re-sent ones next, then seq order; ≤ 16 messages / 96 KiB. */
  private bundle(o: Owned, m: MemberModel, urgentSeq: number | undefined): { items: Array<{ msg: MsgPostedEvent; text: string; resent: boolean }>; more: number } {
    const pending = o.model.pendingFor(m.name);
    const ordered = [
      ...pending.filter((p) => p.seq === urgentSeq),
      ...pending.filter((p) => p.seq !== urgentSeq && m.attempted.has(p.seq)),
      ...pending.filter((p) => p.seq !== urgentSeq && !m.attempted.has(p.seq)),
    ];
    const items: Array<{ msg: MsgPostedEvent; text: string; resent: boolean }> = [];
    let used = 0;
    for (const msg of ordered) {
      if (items.length >= TURN_INPUT_MAX_MESSAGES) {
        break;
      }
      const text = this.messageBody(o, msg);
      const size = bytesOf(text);
      if (items.length > 0 && used + size > TURN_INPUT_MAX_BYTES) {
        break;
      }
      items.push({ msg, text: size > TURN_INPUT_MAX_BYTES ? cutBytes(text, TURN_INPUT_MAX_BYTES) : text, resent: m.attempted.has(msg.seq) });
      used += size;
    }
    return { items, more: ordered.length - items.length };
  }

  private async spawnTurn(
    o: Owned,
    name: string,
    trigger: TurnTrigger,
    prep: { minted?: string; packet?: string; stash?: string; projectConfigFile?: string; worker: WorkerProfile },
  ): Promise<void> {
    const rt = this.memberRt(name);
    let m = o.model.members.get(name);
    if (m === undefined || m.ready === undefined || m.state !== 'idle' || rt.turn !== undefined || !this.canStartTurns(o)) {
      return;
    }
    const settings = this.settings();
    const worker = prep.worker;
    const ready = m.ready;
    // H5 (§2.2): the vendor MCP file before the spawn. CONTRACT-QUESTION: written BEFORE
    // `turn.planned` (the contract lists it after) so a merge refusal blocks the member without
    // leaving a planned turn that never spawned.
    const elevated = elevationOf(m.provider, settings) !== undefined;
    const attachMcp = !(m.provider === 'gemini' && !elevated);
    const files = memberFilesOf(this.teamDir(o.teamId), name);
    let vendorFile = false;
    if (attachMcp && VENDOR_MCP_FILES[m.provider] !== undefined) {
      const w = await this.seams.worktrees.writeVendorMcp(m.ready.cwd, m.provider, teamMcpConfig(this.runtime.nodePath, this.runtime.cliJsPath, files.toolSpec));
      if (!w.ok) {
        await this.block(name, 'worktree', w.text);
        return;
      }
      vendorFile = w.value !== undefined;
    }
    if (prep.minted !== undefined) {
      const r = await this.append([this.item({ type: 'member.conversation', name, incarnation: m.incarnation, conversationId: prep.minted })]);
      if (!r.ok) {
        return;
      }
      m = o.model.members.get(name) ?? m;
    }
    const n = m.turns + 1;
    const kind: 'first' | 'next' = m.conversationStarted && m.conversationId !== undefined ? 'next' : 'first';
    const turnId = newTurnId();
    const now = Date.now();
    // ---- §3.6.1 the prompt ----
    const fence = newFenceId();
    const turnsOnly = m.mailbox === 'turns-only';
    const lines: string[] = [TEAM_TURN_TEXT.header(o.model.name, name, m.role, n, isoTime(now))];
    const recaps = [...rt.recaps];
    if (trigger === 'urgent' && rt.lastStoppedN !== undefined) {
      recaps.unshift(TEAM_TURN_TEXT.recapUrgent(rt.lastStoppedN));
    }
    if (trigger === 'rebrief') {
      recaps.unshift(TEAM_TURN_TEXT.recapRebrief());
    }
    lines.push(...recaps);
    if (trigger === 'rebrief' && m.provider !== 'claude') {
      lines.push('', o.briefs.get(name) ?? this.composeBrief(o, m));
    }
    if (prep.packet !== undefined) {
      lines.push('', prep.packet);
    }
    const urgentSeq = trigger === 'urgent' ? rt.urgentSeq : undefined;
    const bundle = this.bundle(o, m, urgentSeq);
    if (bundle.items.length > 0) {
      lines.push(TEAM_TURN_TEXT.messagesHeading(bundle.items.length), '');
      for (const it of bundle.items) {
        lines.push(
          fenceOpenLine(
            fence,
            TEAM_TURN_TEXT.messageFenceHeader(messageIdOf(it.msg.seq), it.msg.from, it.msg.kind, clockHHMM(it.msg.ts), {
              task: it.msg.task,
              resent: it.resent,
            }),
          ),
          quoteFenceLines(it.text),
          fenceCloseLine(fence),
          '',
        );
      }
    }
    if (bundle.more > 0) {
      lines.push(TEAM_TURN_TEXT.moreMessages(bundle.more, turnsOnly));
    }
    const held = o.model.heldBy(name);
    if (held.length > 0) {
      lines.push(TEAM_TURN_TEXT.yourTasks(held.map((t) => ({ id: t.id, title: t.title, state: t.state }))));
    }
    if (m.briefPending && m.spec.start !== false) {
      lines.push(typeof m.spec.start === 'string' ? m.spec.start : turnsOnly ? TEAM_TURN_TEXT.kickoffTurnsOnly() : TEAM_TURN_TEXT.kickoffTools());
    }
    lines.push(TEAM_TURN_TEXT.finalAnswer());
    let prompt = lines.join('\n');
    if (bytesOf(prompt) > TURN_PROMPT_MAX) {
      prompt = cutBytes(prompt, TURN_PROMPT_MAX - 200) + `\n[cut at ${TURN_PROMPT_MAX / 1024} KiB]\n${TEAM_TURN_TEXT.finalAnswer()}`;
    }
    const brief = o.briefs.get(name) ?? this.composeBrief(o, m);
    const vendorText = kind === 'first' && m.provider !== 'claude' ? `${brief}\n\n---\n\n${prompt}` : prompt;
    const promptFile = bytesOf(vendorText) > PROMPT_ARGV_MAX ? files.turnPrompt(n) : undefined;
    const deliver = bundle.items.map((it) => it.msg.seq);
    const resent = bundle.items.filter((it) => it.resent).map((it) => it.msg.seq);
    // ---- write-before-spawn (§3.4 step 1) ----
    const planned = await this.append([
      this.item({
        type: 'turn.planned',
        turnId,
        name,
        n,
        incarnation: m.incarnation,
        trigger,
        deliver,
        resent,
        promptBytes: bytesOf(prompt),
        ...(promptFile !== undefined ? { promptFile } : {}),
      }),
    ]);
    if (!planned.ok) {
      if (vendorFile) {
        await this.seams.worktrees.removeVendorMcp(ready.cwd, m.provider);
      }
      return;
    }
    rt.recaps = [];
    rt.forced = undefined;
    rt.packetNext = false;
    rt.packetReason = undefined;
    if (trigger === 'urgent') {
      rt.urgentSeq = undefined;
    }
    o.teamIdleNoticed = false;
    let done!: () => void;
    const turn: TurnRt = {
      turnId,
      member: name,
      n,
      incarnation: m.incarnation,
      trigger,
      kind,
      deliver,
      resent,
      provider: m.provider,
      worker,
      model: m.model,
      startedAt: now,
      toolPulls: [],
      toolsOk: false,
      teamToolSeen: false,
      sends: 0,
      inboxCalls: 0,
      boardTouched: false,
      vendorFile,
      rssNoticed: false,
      silenceNoticed: false,
      stashBefore: prep.stash,
      done: new Promise<void>((resolve) => {
        done = resolve;
      }),
      resolveDone: () => done(),
    };
    rt.turn = turn;
    const taskBase = this.taskBase(o, turn, m.modelSource);
    try {
      const promptPath = this.seams.host.taskLog.writePrompt(turnId, prompt);
      this.seams.host.taskLog.append({
        ...taskBase,
        ts: Date.now(),
        status: 'running',
        promptPreview: flat(prompt.split('\n').slice(1).join(' '), 200),
        ...(promptPath !== undefined ? { promptFile: promptPath } : {}),
      });
    } catch (err) {
      this.log(`task log of ${turnId}: ${errText(err)}`);
    }
    const spec: TurnSpec = {
      teamId: o.teamId,
      member: name,
      turnId,
      n,
      index: m.index,
      incarnation: { provider: m.provider, worker, model: m.model, ...(m.conversationId !== undefined ? { conversationId: m.conversationId } : {}) },
      kind,
      ...(m.conversationId !== undefined && (kind === 'next' || m.provider === 'claude' || m.provider === 'cursor')
        ? { expectedConversationId: m.conversationId }
        : {}),
      prompt,
      briefFile: files.brief,
      ...(attachMcp
        ? {
            mcp: {
              name: 'cco_team' as const,
              command: this.runtime.nodePath,
              args: teamMcpServerArgs(this.runtime.cliJsPath, files.toolSpec),
              configFile: files.mcpConfig,
              ...(m.provider === 'claude' && prep.projectConfigFile !== undefined ? { projectConfigFile: prep.projectConfigFile } : {}),
            },
          }
        : {}),
      cwd: ready.cwd,
      timeoutMs: settings.turnTimeoutMinutes * 60_000,
      elevated,
      ...costBaselineOf(m),
    };
    let handle: TurnHandle;
    try {
      handle = this.seams.startTurn(spec, {
        dataRoot: this.runtime.dataRoot,
        incarnationNumber: m.incarnation,
        claudePermissionMode: settings.permissionMode,
        claudeLoginProbe: (w) => this.seams.host.claudeLoginProbe(w),
        onSpawn: (child) => this.onSpawn(o, turn, child),
        log: (line) => this.log(line),
      });
    } catch (err) {
      handle = this.deadHandle(errText(err));
    }
    turn.handle = handle;
    if (turn.stopFor !== undefined) {
      handle.interrupt();
    }
    this.armWatchdog(o);
    void this.consumeEvents(o, turn, handle);
    if (kind === 'first' && (m.provider === 'codex' || m.provider === 'gemini')) {
      const incarnation = m.incarnation;
      void handle.conversationId
        .then((id) => {
          if (typeof id === 'string' && id !== '') {
            return this.exclusive(async () => {
              const cur = o.model.members.get(name);
              if (cur !== undefined && cur.incarnation === incarnation && cur.conversationId === undefined) {
                await this.append([this.item({ type: 'member.conversation', name, incarnation, conversationId: id })]);
              }
            });
          }
          return undefined;
        })
        .catch(() => undefined);
    }
    void handle.result
      .catch(
        (err): TurnOutcome => ({
          outcome: 'crashed',
          contextLost: false,
          sawAssistant: false,
          assistantAfter: () => false,
          text: '',
          tokens: { in: 0, out: 0 },
          exitCode: null,
          signal: null,
          signalledBy: null,
          sawEvent: false,
          note: errText(err),
          stderrTail: '',
        }),
      )
      .then((outcome) => this.turnEnded(o, turn, outcome))
      .catch((err) => this.log(`turn end of ${turnId} failed: ${errText(err)}`));
  }

  /**
   * H5 + T11 E2 (A18, I14): a Claude member's project MCP file is the repository's `.mcp.json` AS
   * IT IS AT THE MEMBER'S BASE COMMIT, copied by the worktrees seam to `<member dir>/project-mcp.json`
   * (0600, host-owned, outside the worktree) — never the worktree's own copy, which the member can
   * edit: a member that may only edit files would otherwise give itself a server command that runs
   * before its next turn's model does. A member's edit of `.mcp.json` therefore changes nothing about
   * its own tools (the lead merges it like any other file). A git failure passes no project file
   * (the member keeps its team tools; the project's servers are missing that turn) and is said ONCE
   * per incarnation in a `store.warning`. Runs outside the chain (a quick git call).
   */
  private async projectMcp(o: Owned, m: MemberModel): Promise<string | undefined> {
    const ready = m.ready;
    if (ready === undefined) {
      return undefined;
    }
    let r: WorktreeResult<string | undefined>;
    try {
      r = await this.seams.worktrees.projectMcpFile({
        path: ready.path,
        baseCommit: ready.baseCommit,
        outFile: path.join(memberFilesOf(this.teamDir(o.teamId), m.name).dir, 'project-mcp.json'),
      });
    } catch (err) {
      r = { ok: false, code: 'git', text: errText(err) };
    }
    // a seam that answers nothing (an implementation of the pre-T11 signature) means "no project file"
    if (r === undefined || r === null || r.ok) {
      return r?.value ?? undefined;
    }
    const rt = this.memberRt(m.name);
    if (rt.projectMcpWarned !== m.incarnation) {
      rt.projectMcpWarned = m.incarnation;
      const text = r.text;
      await this.exclusive(() => this.storeWarning(`${m.name}'s project .mcp.json could not be read at its base commit (${text}); its turns run without the project's MCP servers.`));
    }
    return undefined;
  }

  /** A handle for a driver that threw (a defect): the turn "crashed before any event". */
  private deadHandle(note: string): TurnHandle {
    const outcome: TurnOutcome = {
      outcome: 'crashed',
      contextLost: false,
      sawAssistant: false,
      assistantAfter: () => false,
      text: '',
      tokens: { in: 0, out: 0 },
      exitCode: null,
      signal: null,
      signalledBy: null,
      sawEvent: false,
      note,
      stderrTail: note,
    };
    return {
      pid: undefined,
      events: { [Symbol.asyncIterator]: async function* () {} },
      conversationId: Promise.resolve(undefined),
      lastOutputAt: () => Date.now(),
      result: Promise.resolve(outcome),
      interrupt: () => undefined,
      suspend: () => undefined,
      kill: () => undefined,
    };
  }

  private taskBase(o: Owned, turn: TurnRt, modelSource: 'dispatch' | 'worker' | 'cli'): Omit<TaskEvent, 'ts' | 'status'> {
    let outputFile = '';
    try {
      outputFile = turnTextFileOf(this.runtime.dataRoot, turn.turnId);
    } catch {
      outputFile = path.join(this.runtime.dataRoot, 'tasks', `${turn.turnId}.md`);
    }
    return {
      id: turn.turnId,
      title: TEAM_TEXT.turnTaskTitle(o.model.name, turn.member, turn.n),
      worker: turn.worker.name,
      model: turn.model,
      modelSource,
      provider: turn.provider,
      outputFile,
      cwd: this.runtime.workspace,
      team: o.teamId,
      member: turn.member,
      turn: turn.n,
      timeoutMinutes: this.settings().turnTimeoutMinutes,
    };
  }

  /** TurnDeps.onSpawn (§3.4 step 1): `turn.running` + `member.process` + `member.state running`, the task log's pid. */
  private onSpawn(o: Owned, turn: TurnRt, child: { pid: number; pgid: number; startedAt: number }): void {
    turn.spawned = child;
    const first = turn.spawned !== undefined && o.model.turns.get(turn.turnId)?.running === undefined;
    void this.append(
      [
        this.item({ type: 'turn.running', turnId: turn.turnId, pid: child.pid, pgid: child.pgid, startedAt: child.startedAt }),
        this.item({ type: 'member.process', name: turn.member, turnId: turn.turnId, pid: child.pid, pgid: child.pgid, startedAt: child.startedAt }),
        ...(first ? [this.stateItem(turn.member, 'running')] : []),
      ],
      { reserve: true, hold: true },
    );
    try {
      this.seams.host.taskLog.append({ ...this.taskBase(o, turn, o.model.members.get(turn.member)?.modelSource ?? 'cli'), ts: Date.now(), status: 'running', pid: child.pid, pgid: child.pgid });
    } catch (err) {
      this.log(`task log of ${turn.turnId}: ${errText(err)}`);
    }
  }

  /** The turn's activity: `turn.accepted` on the first item (display only, H3), the feed, onActivity. */
  private async consumeEvents(o: Owned, turn: TurnRt, handle: TurnHandle): Promise<void> {
    let accepted = false;
    try {
      for await (const item of handle.events) {
        if (!accepted && item.k === 'turn') {
          accepted = true;
          void this.append([this.item({ type: 'turn.accepted', turnId: turn.turnId })]);
        }
        // E10: a call of a team tool in the vendor's stream — `cco_team` in the name, or a bare team
        // tool name (an adapter that drops the server's name)
        if (item.k === 'tool' && typeof item.tool === 'string' && (item.tool.includes('cco_team') || /(^|[^A-Za-z0-9_])team_(board|inbox|send|claim|update)$/.test(item.tool))) {
          turn.teamToolSeen = true;
        }
        const rt = o.members.get(turn.member);
        if (rt !== undefined && (item.s !== undefined || item.d !== undefined || item.tool !== undefined)) {
          rt.lastActivity = { ts: item.ts, text: flat(item.s ?? item.d ?? item.tool ?? '', HEAD_MAX_CHARS) };
        }
        this.feed(turn.member, [item]);
      }
    } catch (err) {
      this.log(`activity of ${turn.turnId}: ${errText(err)}`);
    }
  }

  /** Feed items: `members/<name>/feed.jsonl` and the coalesced onActivity callbacks (§3.8). */
  private feed(member: string, items: FeedItem[]): void {
    const o = this.owned;
    if (o === undefined || o.dropped || items.length === 0) {
      return;
    }
    try {
      const r = o.store.appendFeed(member, items);
      const rt = o.members.get(member);
      if (!r.ok && rt !== undefined && !rt.feedWarned) {
        rt.feedWarned = true;
        void this.storeWarning(`the activity feed of ${member} could not be written: ${storeErrno(r)}`);
      }
    } catch {
      // display only
    }
    let buf = o.feedBuffers.get(member);
    if (buf === undefined) {
      buf = { items: [] };
      o.feedBuffers.set(member, buf);
    }
    buf.items.push(...items);
    if (buf.timer === undefined) {
      const b = buf;
      b.timer = setTimeout(() => {
        b.timer = undefined;
        const out = b.items.splice(0);
        for (const cb of this.activityListeners) {
          try {
            cb(member, out);
          } catch (err) {
            this.log(`onActivity listener threw: ${errText(err)}`);
          }
        }
      }, this.tuning.feedCoalesceMs);
    }
  }

  /* ---- §3.4 step 3: the watchdogs (RSS, silence) ---- */

  private armWatchdog(o: Owned): void {
    if (o.watchdog !== undefined) {
      return;
    }
    o.watchdog = setInterval(() => {
      void this.watchdogTick(o);
    }, this.tuning.rssTickMs);
  }

  private async watchdogTick(o: Owned): Promise<void> {
    const turns = [...o.members.values()].map((rt) => rt.turn).filter((t): t is TurnRt => t !== undefined);
    if (turns.length === 0 || this.owned !== o) {
      if (o.watchdog !== undefined) {
        clearInterval(o.watchdog);
        o.watchdog = undefined;
      }
      return;
    }
    let rss: Map<number, number> | undefined;
    try {
      rss = await this.seams.host.process.rssByGroup();
    } catch {
      rss = undefined;
    }
    const now = Date.now();
    for (const t of turns) {
      if (rss !== undefined && t.spawned !== undefined) {
        const bytes = rss.get(t.spawned.pgid) ?? 0;
        t.rssMb = Math.round(bytes / (1024 * 1024));
        if (bytes >= RSS_KILL && t.stopFor === undefined) {
          this.stopTurn(t, 'memory');
        } else if (bytes >= RSS_NOTICE && !t.rssNoticed) {
          t.rssNoticed = true;
          void this.exclusive(() => this.notice(['lead'], 'turn', `${t.member}'s turn ${t.n} uses ${t.rssMb} MB of memory.`));
        }
      }
      const last = safeNumber(() => t.handle?.lastOutputAt()) ?? t.startedAt;
      if (now - last >= this.tuning.silenceNoticeMs && !t.silenceNoticed) {
        t.silenceNoticed = true;
        const minutes = Math.round((now - last) / 60_000);
        void this.exclusive(() =>
          this.notice(['lead', 'user'], 'turn', `${t.member}'s turn ${t.n} has printed nothing for ${minutes} minutes; it is still running.`),
        );
      }
    }
    this.touchState();
  }

  /** Stop a running turn: the normal ladder from SIGINT, or the suspend ladder (H2). The first reason that ends a turn is kept, except that end/suspend override. */
  private stopTurn(turn: TurnRt, why: StopFor): void {
    if (turn.stopFor === undefined || why === 'lead-ended' || why === 'end') {
      turn.stopFor = why;
    }
    const h = turn.handle;
    if (h === undefined) {
      return;
    }
    try {
      if (why === 'lead-ended') {
        h.suspend();
      } else {
        h.interrupt();
      }
    } catch (err) {
      this.log(`signalling ${turn.turnId}: ${errText(err)}`);
    }
  }

  /* ---- §3.4 step 4: the turn's exit, in order ---- */

  private async turnEnded(o: Owned, turn: TurnRt, outcome: TurnOutcome): Promise<void> {
    const m = o.model.members.get(turn.member);
    const ready = m?.ready;
    // (4) the untracked vendor MCP file goes before the checkpoint.
    if (turn.vendorFile && ready !== undefined) {
      try {
        const removed = await this.seams.worktrees.removeVendorMcp(ready.cwd, turn.provider);
        if (!removed.ok) {
          this.log(`vendor MCP file of ${turn.member}: ${removed.text}`);
        }
      } catch {
        // logged above in the normal case
      }
    }
    // (5) the checkpoint and the stash check (L6) — the git work outside the chain.
    let checkpoint: WorktreeResult<CheckpointOutcome> | undefined;
    let stashAfter: string | undefined;
    if (ready !== undefined && this.owned === o && !o.dropped) {
      checkpoint = await this.gitCheckpoint(o, turn.member, turn.n, outcome.text);
      const s = await this.seams.worktrees.readStash(o.model.repoRoot);
      stashAfter = s.ok ? s.value : undefined;
    }
    await this.exclusive(() => this.finishTurn(o, turn, outcome, checkpoint, stashAfter));
  }

  private async gitCheckpoint(o: Owned, member: string, n: number | undefined, text: string, signal?: AbortSignal): Promise<WorktreeResult<CheckpointOutcome> | undefined> {
    const m = o.model.members.get(member);
    if (m === undefined || m.ready === undefined) {
      return undefined;
    }
    const held = o.model.heldBy(member);
    try {
      return await this.seams.worktrees.checkpoint({
        path: m.ready.path,
        branch: m.ready.branch,
        baseCommit: m.ready.baseCommit,
        message: checkpointCommitMessage({
          team: o.model.name,
          member,
          ...(n !== undefined ? { n } : {}),
          head: flat(text.split('\n').find((l) => l.trim() !== '') ?? '', 60),
          provider: m.provider,
          worker: m.worker,
          model: m.model,
          heldTasks: held.map((t) => t.id),
        }),
        ownedPaths: held.flatMap((t) => t.paths),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      return { ok: false, code: 'git', text: errText(err) };
    }
  }

  /**
   * The checkpoint's events and notices (§9.2, §9.3). Assumes the chain.
   *
   * T11 E5 (A21): `branch-moved` (HEAD is not `refs/heads/<branch>`) committed NOTHING — the files
   * stay in the worktree. It is recorded as `turn.checkpoint {error: branch-moved …}` naming the exact
   * remedy, and at a turn's end the member becomes `blocked: worktree-branch` AT ONCE (toIdle reads
   * `branchMoved`), instead of at its next turn's start; a moved branch is never fixed automatically.
   */
  private async recordCheckpoint(o: Owned, member: string, turnId: string | undefined, cp: WorktreeResult<CheckpointOutcome> | undefined): Promise<void> {
    if (cp === undefined) {
      return;
    }
    const rt = this.memberRt(member);
    if (!cp.ok && cp.code === 'branch-moved') {
      const wt = o.model.members.get(member)?.ready;
      const text = wt !== undefined ? branchMovedText(cp.text, wt.path, wt.branch) : `branch-moved: ${cp.text}`;
      await this.append([this.item({ type: 'turn.checkpoint', ...(turnId !== undefined ? { turnId } : {}), name: member, error: flat(text) })], { reserve: true, hold: true });
      if (turnId !== undefined) {
        rt.branchMoved = text;
      }
      return;
    }
    if (!cp.ok) {
      const items: LogAppend[] = [
        this.item({ type: 'turn.checkpoint', ...(turnId !== undefined ? { turnId } : {}), name: member, error: flat(cp.text) }),
        this.item({ type: 'store.warning', text: flat(`${member}'s checkpoint failed: ${cp.text}`) }),
      ];
      if (!rt.checkpointErrorNoticed) {
        rt.checkpointErrorNoticed = true;
        items.push(
          ...this.noticeItems(['lead'], 'checkpoint', `${member}'s checkpoint failed (${flat(cp.text, 200)}); its files stay uncommitted and the next checkpoint retries.`),
        );
      }
      await this.append(items, { reserve: true, hold: true });
      return;
    }
    rt.checkpointErrorNoticed = false;
    const items: LogAppend[] = [];
    const skipped = cp.value.skipped;
    const skipKey = skipped.join('\n');
    if (skipped.length > 0 && skipKey !== rt.lastSkippedKey) {
      items.push(...this.noticeItems(['lead'], 'checkpoint', TEAM_NOTICE.checkpointSkipped(member, skipped)));
    }
    rt.lastSkippedKey = skipKey;
    if (cp.value.committed) {
      const v = cp.value;
      items.push(
        this.item({
          type: 'turn.checkpoint',
          ...(turnId !== undefined ? { turnId } : {}),
          name: member,
          sha: v.sha,
          filesChanged: v.filesChanged,
          touched: v.touched,
          outsideOwnership: v.outsideOwnership,
          skipped: v.skipped,
        }),
      );
      const outsideKey = v.outsideOwnership.join('\n');
      if (v.outsideOwnership.length > 0 && outsideKey !== rt.lastOutsideKey) {
        items.push(
          ...this.noticeItems(['lead'], 'overlap', `${member} changed files outside its tasks' paths: ${flat(v.outsideOwnership.join(', '), 600)}`),
        );
      }
      rt.lastOutsideKey = outsideKey;
    }
    if (items.length > 0) {
      await this.append(items, { reserve: true, hold: true });
    }
    if (cp.value.committed) {
      await this.checkOverlap(o);
      void this.refreshFacts(o, member);
    }
  }

  /** §9.3: a path changed by two live members → `overlap.detected` once per new path set. */
  private async checkOverlap(o: Owned): Promise<void> {
    const touched: Record<string, string[]> = {};
    for (const m of o.model.members.values()) {
      if (m.state !== 'stopped' && m.state !== 'ended' && m.touched.length > 0) {
        touched[m.name] = m.touched;
      }
    }
    let overlap: { members: string[]; paths: string[] } | undefined;
    try {
      overlap = this.seams.worktrees.overlapOf(touched);
    } catch {
      overlap = undefined;
    }
    if (overlap === undefined) {
      return;
    }
    const key = `${overlap.members.join(',')}|${overlap.paths.join('\n')}`;
    if (o.overlapKeys.has(key)) {
      return;
    }
    o.overlapKeys.add(key);
    await this.append([
      this.item({ type: 'overlap.detected', members: overlap.members, paths: overlap.paths }),
      ...this.noticeItems(['lead'], 'overlap', `${overlap.members.join(' and ')} changed the same files: ${flat(overlap.paths.join(', '), 600)}`),
    ]);
  }

  private async refreshFacts(o: Owned, member: string): Promise<void> {
    const m = o.model.members.get(member);
    if (m?.ready === undefined) {
      return;
    }
    try {
      const f = await this.seams.worktrees.facts({ path: m.ready.path, baseCommit: m.ready.baseCommit, leadCheckout: this.runtime.workspace });
      if (f.ok) {
        this.memberRt(member).facts = { ahead: f.value.ahead, dirty: f.value.dirty, merged: f.value.merged, headSha: f.value.headSha };
        this.touchState();
      }
    } catch {
      // overlay facts are display only
    }
  }

  /** Map a TurnEndReason for an `interrupted` turn. */
  private endReason(stopFor: StopFor | undefined): TurnEndReason | undefined {
    switch (stopFor) {
      case 'urgent':
      case 'pause':
      case 'stop':
      case 'end':
      case 'interrupt':
      case 'lead-ended':
      case 'takeover':
      case 'cancel':
        return stopFor;
      default:
        return undefined;
    }
  }

  /** §3.4 step 4 (6) and §3.5's outcome table. Assumes the chain. */
  private async finishTurn(
    o: Owned,
    turn: TurnRt,
    outcome: TurnOutcome,
    checkpoint: WorktreeResult<CheckpointOutcome> | undefined,
    stashAfter: string | undefined,
  ): Promise<void> {
    const rt = this.memberRt(turn.member);
    try {
      if (this.owned !== o || o.dropped) {
        // E7 (A23): a turn that outlived its suspend — its turn.ended was written by the suspend
        // (or is left to the next host's sweep); its commit is still recorded while the lease is held.
        if (checkpoint?.ok === true && checkpoint.value.committed && !o.dropped && o.store.owned()) {
          const v = checkpoint.value;
          await o.store.append(
            [this.item({ type: 'turn.checkpoint', turnId: turn.turnId, name: turn.member, sha: v.sha, filesChanged: v.filesChanged, touched: v.touched, outsideOwnership: v.outsideOwnership, skipped: v.skipped })],
            { reserve: true },
          );
        }
        return;
      }
      const m = o.model.members.get(turn.member);
      if (m === undefined) {
        return;
      }
      await this.recordCheckpoint(o, turn.member, turn.turnId, checkpoint);
      if (turn.stashBefore !== undefined && stashAfter !== undefined && turn.stashBefore !== stashAfter) {
        await this.append([
          this.item({
            type: 'stash.changed',
            turnId: turn.turnId,
            name: turn.member,
            before: turn.stashBefore.split('\n')[0] ?? '',
            after: stashAfter.split('\n')[0] ?? '',
          }),
          ...this.noticeItems(['lead'], 'stash', TEAM_NOTICE.stashChanged(turn.member, turn.n)),
        ]);
      }
      // The outcome as recorded: the engine knows why it stopped a turn (memory is its RSS kill).
      let kind: TurnOutcomeKind = outcome.outcome;
      if (kind === 'interrupted' && turn.stopFor === 'memory') {
        kind = 'memory';
      } else if (kind === 'interrupted' && turn.stopFor === undefined) {
        kind = 'cancelled';
      }
      // The task log's terminal event FIRST (CONTRACT-QUESTION: §3.4 lists it after turn.ended;
      // it is written first because whether another hand already closed it decides `cancelled`, M8).
      const fullText = outcome.text ?? '';
      try {
        this.seams.host.taskLog.writeOutput(turn.turnId, fullText);
      } catch {
        // the file is a record, not the outcome
      }
      let closedElsewhere = false;
      try {
        const close = this.seams.host.taskLog.appendTerminal({
          ...this.taskBase(o, turn, m.modelSource),
          ts: Date.now(),
          status: kind === 'ok' ? 'done' : 'error',
          ...(kind !== 'ok'
            ? { error: turn.stopFor === 'end' ? 'team ended' : flat(`team turn ${kind}${outcome.note ? `: ${outcome.note}` : ''}`) }
            : {}),
          inputTokens: outcome.tokens.in,
          outputTokens: outcome.tokens.out,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          ...(outcome.modelUsed !== undefined ? { modelUsed: outcome.modelUsed } : {}),
        });
        closedElsewhere = !close.closed;
      } catch (err) {
        this.log(`task log of ${turn.turnId}: ${errText(err)}`);
      }
      if (closedElsewhere && turn.stopFor === undefined && kind !== 'ok') {
        kind = 'cancelled';
      }
      // H3: delivered only when the model produced output after the delivery point.
      const delivered: LogAppend[] = [];
      const seen = new Set<number>();
      if (outcome.sawAssistant) {
        for (const seq of turn.deliver) {
          if (!m.delivered.has(seq) && !seen.has(seq)) {
            seen.add(seq);
            delivered.push(this.item({ type: 'msg.delivered', msg: messageIdOf(seq), to: turn.member, via: turn.trigger === 'urgent' ? 'interrupt' : 'turn', turnId: turn.turnId }));
          }
        }
      }
      for (const pull of turn.toolPulls) {
        let after = false;
        try {
          after = outcome.assistantAfter(pull.ts);
        } catch {
          after = false;
        }
        if (!after) {
          continue;
        }
        for (const seq of pull.seqs) {
          if (!m.delivered.has(seq) && !seen.has(seq)) {
            seen.add(seq);
            delivered.push(this.item({ type: 'msg.delivered', msg: messageIdOf(seq), to: turn.member, via: 'tool', turnId: turn.turnId }));
          }
        }
      }
      const reason = kind === 'interrupted' ? this.endReason(turn.stopFor) : undefined;
      let textFile = '';
      try {
        textFile = turnTextFileOf(this.runtime.dataRoot, turn.turnId);
      } catch {
        textFile = path.join(this.runtime.dataRoot, 'tasks', `${turn.turnId}.md`);
      }
      const ended: LogAppend = this.item({
        type: 'turn.ended',
        turnId: turn.turnId,
        outcome: kind,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: Math.max(0, Date.now() - turn.startedAt),
        tokens: { in: Math.max(0, outcome.tokens.in || 0), out: Math.max(0, outcome.tokens.out || 0) },
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
        ...(outcome.cumulativeCostUsd !== undefined ? { cumulativeCostUsd: outcome.cumulativeCostUsd } : {}),
        text: cutBytes(fullText, TURN_TEXT_INLINE_MAX),
        textFile,
        sawAssistant: outcome.sawAssistant,
        ...(outcome.conversationIdSeen !== undefined ? { conversationIdSeen: outcome.conversationIdSeen } : {}),
        ...(outcome.note !== undefined && outcome.note !== '' ? { note: flat(outcome.note) } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(outcome.modelUsed !== undefined ? { modelUsed: outcome.modelUsed } : {}),
      });
      const batch: LogAppend[] = [ended, ...delivered];
      // S4: the vendor silently started a new conversation — the work is kept; the next turn re-briefs on the NEW id.
      const lostTo = outcome.contextLost && outcome.conversationIdSeen !== undefined && outcome.conversationIdSeen !== m.conversationId ? outcome.conversationIdSeen : undefined;
      if (lostTo !== undefined) {
        batch.push(
          this.item({
            type: 'member.conversation',
            name: turn.member,
            incarnation: m.incarnation,
            conversationId: lostTo,
            ...(m.conversationId !== undefined ? { replaced: m.conversationId } : {}),
          }),
        );
      }
      if (!(await this.appendTurnEnd(o, turn, batch, ended))) {
        return;
      }
      o.recentEnded.set(turn.turnId, kind);
      // Bookkeeping exactly as dispatch records the same outcome (§6.5 step 1, M3).
      try {
        const facts = this.routingFacts();
        const names = facts !== undefined ? namesOfIdentities(new Set(identityKeysOf(turn.worker, facts)), facts) : [turn.worker.name];
        const note = this.seams.host.bookkeeping(turn.worker, names, { ...outcome, outcome: kind, turnId: turn.turnId }, this.settings().cooldownMinutes);
        if (note !== undefined && note !== '') {
          await this.storeWarning(note);
        }
      } catch (err) {
        this.log(`bookkeeping of ${turn.turnId}: ${errText(err)}`);
      }
      // §3.7 / M19: the mailbox verdict, re-evaluated every turn.
      await this.mailboxVerdict(o, turn, outcome);
      // §3.6.2: the report.
      if (kind === 'ok' || kind === 'error' || kind === 'timeout' || kind === 'memory' || kind === 'cancelled') {
        await this.postReport(o, turn, kind, outcome);
      }
      // §5.5: ended a turn holding a claimed task and sent nothing.
      const claimed = o.model.heldBy(turn.member).filter((t) => t.state === 'claimed');
      if (claimed.length > 0 && turn.sends === 0 && !turn.boardTouched && (kind === 'ok' || kind === 'error')) {
        await this.notice(['lead'], 'board', TEAM_NOTICE.stillClaimed(turn.member, claimed[0].id, firstChars(fullText, REPORT_NOTICE_CHARS)));
      }
      rt.lastStoppedN = turn.n;
      await this.handleOutcome(o, turn, kind, outcome);
      if (lostTo !== undefined) {
        // the re-brief continues the SAME incarnation on the new id; an outcome that already moved
        // the member to a new incarnation (failover, refresh) carries the packet instead
        if (o.model.members.get(turn.member)?.incarnation === turn.incarnation) {
          rt.forced = rt.forced === 'packet' ? 'packet' : 'rebrief';
          rt.packetReason = TEAM_REBRIEF_REASON;
        }
        await this.notice(['lead', 'user'], 'context-lost', TEAM_NOTICE.contextLost(turn.member));
      }
      // M13: proactive refresh before the context wall.
      if (outcome.tokens.in > MEMBER_CONTEXT_REFRESH_TOKENS && (kind === 'ok' || kind === 'error' || kind === 'timeout') && lostTo === undefined) {
        await this.refresh(o, turn.member, 'refresh', `its last turn read ${Math.round(outcome.tokens.in / 1000)}k input tokens`, false);
      }
    } finally {
      rt.turn = undefined;
      // E5: an outcome that did not go through toIdle (paused, blocked for another cause) leaves the
      // moved branch to the next turn's check (§2.5), which blocks the member the same way.
      rt.branchMoved = undefined;
      try {
        turn.resolveDone();
      } catch {
        // never throws
      }
      this.touchState();
      if (this.owned === o) {
        await this.teamIdleCheck(o);
        this.poke();
      }
    }
  }

  /**
   * T11 E19 (A33): the `turn.ended` batch, durably — or the member is never left `running` in
   * silence. A batch the ENOSPC hold kept is as good as written (it lands in order once space
   * returns). Any other failure (`line-too-long`, `log-full` past the reserve, an `io` error) is
   * retried ONCE with a minimal `turn.ended` (no text, no note — the full text stays in the task
   * log's output file); when that fails too, the member becomes `blocked: error` (team_store_failed)
   * IN MEMORY, the lead is told (when the log still takes a notice) and a host log line says why.
   * Answers whether the outcome may be handled as usual. Assumes the chain.
   */
  private async appendTurnEnd(o: Owned, turn: TurnRt, batch: LogAppend[], ended: LogAppend): Promise<boolean> {
    const held = (items: LogAppend[]): boolean => o.hold.some((h) => h.items === items);
    let r = await this.append(batch, { reserve: true, hold: true });
    if (r.ok || held(batch) || o.dropped) {
      return r.ok || held(batch);
    }
    const minimal: LogAppend[] = [{ ...ended, body: { ...ended.body, text: '', note: undefined } as LogEventBody }, ...batch.slice(1)];
    r = await this.append(minimal, { reserve: true, hold: true });
    if (r.ok || held(minimal) || o.dropped) {
      return r.ok || held(minimal);
    }
    const m = o.model.members.get(turn.member);
    const text = TEAM_TEXT.storeFailed(storeErrno(r));
    if (m !== undefined) {
      m.state = 'blocked';
      m.reason = { code: 'error', text: flat(`team_store_failed: ${text}`) };
    }
    this.log(`turn.ended of ${turn.turnId} (${turn.member}) could not be written (${r.code}); ${turn.member} is blocked in memory`);
    await this.notice(['lead'], 'blocked', `${turn.member} is blocked: the end of its turn ${turn.n} could not be recorded (${storeErrno(r)}).`);
    return false;
  }

  /**
   * §3.7 / M19 as amended by T11 E10 (A26): the member's team tools are USABLE when a team
   * `tools/call` succeeded in the turn OR the vendor said the server connected
   * (`TurnOutcome.teamToolsConnected === true`, Claude's `system/init`) — usable flips a member to
   * `tools` (back from `turns-only` with a notice). It is demoted to `turns-only` only on EVIDENCE
   * that the tools are not usable, never for merely not calling one: an explicit `false` from the
   * vendor, or a failed call — the stream showed a `cco_team` tool call that never reached the host —
   * with no success in that turn, while it is still `unverified`. A member that did real work without
   * calling a tool keeps its tools. Residuals, stated: a non-Claude member whose CLI never started the
   * server (so the model never saw the tools to call) stays `unverified` and its brief still names
   * the tools. Cursor keeps A8's per-turn verdict (below): its stream carries no tool events, so a
   * call it rejected and no call at all look the same — CONTRACT-QUESTION: TurnOutcome has no "a team
   * tool call failed" fact for such a vendor.
   */
  private async mailboxVerdict(o: Owned, turn: TurnRt, outcome: TurnOutcome): Promise<void> {
    const m = o.model.members.get(turn.member);
    if (m === undefined) {
      return;
    }
    const usable = turn.toolsOk || outcome.teamToolsConnected === true;
    if (usable && m.mailbox !== 'tools') {
      const was = m.mailbox;
      await this.append([
        this.item({ type: 'member.mailbox', name: m.name, mailbox: 'tools', reason: turn.toolsOk ? 'a team tool call succeeded' : 'its team tools connected' }),
        ...(was === 'turns-only'
          ? this.noticeItems(['lead', 'user'], 'mailbox', `${m.name}'s team tools work again (${turn.toolsOk ? 'a tool call succeeded' : 'they connected'}); it is back on its tools.`)
          : []),
      ]);
      this.writeMemberFiles(o, [m.name]);
      return;
    }
    const failedCall = turn.teamToolSeen && !turn.toolsOk;
    // A8 (RP-26): Cursor's MCP calls are inconsistent and its stream reports neither a server status
    // nor tool events, so its per-turn verdict stays v2's — no successful call in a turn the model
    // answered is the evidence. CONTRACT-QUESTION: A26 read as the rule for vendors that HAVE an
    // evidence channel (Claude's init, tool events in the stream); A8 kept for Cursor.
    const cursorVerdict = m.provider === 'cursor' && !turn.toolsOk;
    if (!usable && m.mailbox === 'unverified' && outcome.sawAssistant && (outcome.teamToolsConnected === false || failedCall || cursorVerdict)) {
      const why =
        outcome.teamToolsConnected === false
          ? 'its CLI reported the team tools as not connected'
          : failedCall
            ? 'its team tool calls did not reach the team'
            : 'no team tool call succeeded in its turn';
      await this.append([
        this.item({ type: 'member.mailbox', name: m.name, mailbox: 'turns-only', reason: why }),
        ...this.noticeItems(
          ['lead', 'user'],
          'mailbox',
          `${m.name}'s team tools are not usable (${why}), so it runs turns-only: messages reach it at the start of each turn and its final answer is its report.`,
        ),
      ]);
      this.writeMemberFiles(o, [m.name]);
    }
  }

  private async postReport(o: Owned, turn: TurnRt, kind: TurnOutcomeKind, outcome: TurnOutcome): Promise<void> {
    const text = (outcome.text ?? '').trim();
    if (text === '') {
      await this.notice(['lead'], 'turn', TEAM_NOTICE.noAnswer(turn.member, turn.n));
      return;
    }
    const meta: ReportMeta = {
      turnId: turn.turnId,
      n: turn.n,
      outcome: kind,
      durationMs: Math.max(0, Date.now() - turn.startedAt),
      tokens: { in: outcome.tokens.in || 0, out: outcome.tokens.out || 0 },
      tasks: o.model.heldBy(turn.member).map((t) => t.id),
    };
    await this.append([this.msgItem(turn.member, 'lead', 'report', cutAtParagraph(text, REPORT_INLINE_MAX_BYTES), { source: 'report', report: meta }, `member:${turn.member}`)], {
      hold: true,
    });
  }

  /** §3.5's outcome table. Assumes the chain. */
  private async handleOutcome(o: Owned, turn: TurnRt, kind: TurnOutcomeKind, outcome: TurnOutcome): Promise<void> {
    const name = turn.member;
    const rt = this.memberRt(name);
    const m = o.model.members.get(name);
    if (m === undefined) {
      return;
    }
    if (outcome.sawEvent) {
      rt.earlyCrashes = 0;
    }
    switch (kind) {
      case 'ok':
        rt.consecutiveErrors = 0;
        await this.toIdle(name);
        return;
      case 'error': {
        rt.consecutiveErrors++;
        if (rt.consecutiveErrors >= CONSECUTIVE_ERRORS_MAX) {
          await this.block(name, 'error', flat(outcome.note || outcome.text || outcome.stderrTail || 'the turn failed', REASON_MAX_CHARS));
          return;
        }
        await this.toIdle(name);
        return;
      }
      case 'timeout': {
        const minutes = this.settings().turnTimeoutMinutes;
        rt.recaps.push(TEAM_TURN_TEXT.recapTimeout(minutes));
        await this.toIdle(name, this.noticeItems(['lead'], 'turn', TEAM_NOTICE.timeout(name, turn.n, minutes)));
        return;
      }
      case 'memory':
        await this.toIdle(
          name,
          this.noticeItems(['lead'], 'turn', `${name}'s turn ${turn.n} was stopped at ${turn.rssMb ?? 0} MB of memory (the limit is 8 GiB); its changes are on disk.`),
        );
        return;
      case 'cancelled':
        await this.setState(name, 'paused', { code: 'cancelled', text: TEAM_TEXT.cancelledFromTaskList() }, this.noticeItems(['lead'], 'turn', TEAM_NOTICE.cancelled(name, turn.n)));
        return;
      case 'interrupted':
        return this.handleInterrupted(o, turn);
      case 'crashed': {
        if (!outcome.sawEvent) {
          await this.earlyCrash(o, name, outcome.stderrTail || outcome.note || 'the turn ended before any output', turn.trigger);
          return;
        }
        rt.recaps.push(TEAM_TURN_TEXT.recapCrash());
        await this.toIdle(name, this.noticeItems(['lead'], 'turn', `${name}'s turn ${turn.n} ended unexpectedly; it is idle and waits for its next message.`));
        return;
      }
      case 'quota':
      case 'auth':
        await this.failover(o, name, kind, flat(outcome.note || outcome.text || outcome.stderrTail || kind));
        return;
      case 'context': {
        const recent = rt.contextAtN.filter((n) => turn.n - n <= CONTEXT_REPEAT_TURNS);
        rt.contextAtN.push(turn.n);
        if (recent.length > 0) {
          await this.block(name, 'context', `a second context overflow within ${CONTEXT_REPEAT_TURNS} turns: ${flat(outcome.note || outcome.text || '', 200)}`);
          return;
        }
        await this.refresh(o, name, 'refresh', 'its conversation ran out of context', true);
        await this.notice(['lead'], 'routing', `${name}'s conversation ran out of context; it continues in a fresh conversation from a hand-off note in the same worktree.`);
        return;
      }
      case 'resume-failed': {
        if (rt.resumeRefreshIncarnation === m.incarnation) {
          await this.block(name, 'resume', flat(outcome.stderrTail || outcome.note || 'the CLI could not resume the conversation'));
          return;
        }
        await this.refresh(o, name, 'refresh', 'its CLI could not resume its conversation', true);
        rt.resumeRefreshIncarnation = o.model.members.get(name)?.incarnation;
        await this.notice(['lead'], 'routing', `${name}'s CLI could not resume its conversation; it continues in a fresh conversation from a hand-off note in the same worktree.`);
        return;
      }
    }
  }

  /**
   * Back to `idle` after a turn — or `paused` when a graceful pause was asked during it (Appendix B:
   * pausing → paused at turn.ended). E5: when this turn's checkpoint found the branch moved, the
   * member is `blocked: worktree-branch` instead, with the remedy, in the same batch.
   */
  private async toIdle(name: string, extra: LogAppend[] = []): Promise<void> {
    const rt = this.memberRt(name);
    if (rt.branchMoved !== undefined) {
      const text = rt.branchMoved;
      rt.branchMoved = undefined;
      await this.setState(name, 'blocked', { code: 'worktree-branch', text: flat(text) }, [...this.noticeItems(['lead'], 'blocked', `${name} is blocked: ${flat(text)}`), ...extra]);
      return;
    }
    const paused = this.owned?.model.members.get(name)?.state === 'pausing';
    await this.setState(name, paused ? 'paused' : 'idle', undefined, extra);
  }

  private async handleInterrupted(o: Owned, turn: TurnRt): Promise<void> {
    const name = turn.member;
    const rt = this.memberRt(name);
    switch (turn.stopFor) {
      case 'urgent':
        await this.toIdle(name);
        this.poke(0);
        return;
      case 'pause':
        rt.recaps.push(TEAM_TURN_TEXT.recapInterrupted(turn.n, 'the lead paused you'));
        await this.setState(name, 'paused');
        return;
      case 'cancel':
        rt.recaps.push(TEAM_TURN_TEXT.recapInterrupted(turn.n, 'stopped by cco cancel'));
        await this.setState(name, 'paused', { code: 'cancelled', text: TEAM_TEXT.cancelledByCco() });
        return;
      case 'interrupt':
        rt.recaps.push(TEAM_TURN_TEXT.recapInterrupted(turn.n, 'the lead interrupted you'));
        await this.toIdle(name);
        return;
      case 'stop':
        await this.setState(name, 'stopped');
        await this.restoreVendor(o, name);
        return;
      case 'lead-ended':
        await this.toIdle(name);
        return;
      case 'takeover':
      case 'end':
        // the take-over / end flow sets the state
        return;
      default:
        await this.toIdle(name);
    }
  }

  /** MD-59 / M21: a turn that crashed before any event — one retry after 5 s, then `blocked: crash`. */
  private async earlyCrash(o: Owned, name: string, tail: string, trigger: TurnTrigger): Promise<void> {
    void o;
    const rt = this.memberRt(name);
    rt.earlyCrashes++;
    if (rt.earlyCrashes > EARLY_CRASH_RETRY.retries) {
      rt.earlyCrashes = 0;
      await this.block(name, 'crash', flat(tail, CRASH_TAIL_CHARS));
      return;
    }
    if (trigger === 'packet' || trigger === 'rebrief' || trigger === 'continue') {
      rt.forced = trigger;
    }
    rt.holdUntil = Date.now() + this.tuning.earlyCrashRetryMs;
    const m = this.owned?.model.members.get(name);
    if (m !== undefined && m.state !== 'idle') {
      await this.toIdle(name);
    }
    this.armTimer(name, this.tuning.earlyCrashRetryMs + 5, () => {
      rt.holdUntil = undefined;
      this.poke(0);
    });
  }

  private armTimer(name: string, ms: number, fn: () => void): void {
    const rt = this.memberRt(name);
    if (rt.timer !== undefined) {
      clearTimeout(rt.timer);
    }
    rt.timer = setTimeout(() => {
      rt.timer = undefined;
      try {
        fn();
      } catch (err) {
        this.log(`timer of ${name}: ${errText(err)}`);
      }
    }, Math.max(0, Math.min(ms, 2_147_000_000)));
  }

  /**
   * §6.5 — failover after a FAILED turn or a failed start, SAME PROVIDER only (S1-5). Quota whose
   * window resets within QUOTA_WAIT_MAX_MINUTES → `paused` (`quota-wait`) and the same
   * incarnation continues; otherwise route anew within the provider (every name of each failed
   * identity in `attempted`, M3) → a new incarnation and a `packet` turn; nothing eligible →
   * `blocked` with the earliest reset and at most BLOCKED_RETRY_MAX scheduled `continue`s.
   * Assumes the chain.
   */
  private async failover(o: Owned, name: string, kind: 'quota' | 'auth' | 'removed', text: string): Promise<void> {
    const m = o.model.members.get(name);
    if (m === undefined) {
      return;
    }
    const rt = this.memberRt(name);
    const facts = this.routingFacts();
    const worker = facts?.workers.find((w) => w.name === m.worker);
    const now = Date.now();
    if (kind === 'quota' && worker !== undefined) {
      let reset: { until: number; window: string } | undefined;
      try {
        reset = this.seams.host.quotaResetAt(worker, m.model);
      } catch {
        reset = undefined;
      }
      if (reset !== undefined && reset.until - now <= this.tuning.quotaWaitMaxMs) {
        const until = reset.until;
        await this.setState(name, 'paused', { code: 'quota-wait', text: `${accountLabelOf(worker)} is at its ${reset.window} limit`, until }, [
          ...this.noticeItems(['lead'], 'routing', TEAM_NOTICE.quotaWait(name, m.provider, accountLabelOf(worker), reset.window, until)),
        ]);
        this.armQuotaWait(o, name, until, now);
        return;
      }
    }
    if (facts === undefined) {
      await this.block(name, kind === 'auth' ? 'login' : kind === 'removed' ? 'account-removed' : 'quota', text);
      return;
    }
    for (const k of worker !== undefined ? identityKeysOf(worker, facts) : [m.accountKey]) {
      rt.failedIdentities.add(k);
    }
    const route = await routeMember(
      {
        member: name,
        spec: { model: m.spec.model },
        team: this.routedTeam(o.model),
        failedIdentities: rt.failedIdentities,
        forceProvider: m.provider,
        mode: 'cached',
      },
      facts,
    );
    if (route.ok) {
      const oldLabel = worker !== undefined ? accountLabelOf(worker) : m.worker;
      const reset = worker !== undefined ? safeReset(() => this.seams.host.quotaResetAt(worker, m.model)) : undefined;
      await this.newIncarnation(o, name, route, 'failover', `${oldLabel}: ${flat(text, 200)}`);
      rt.forced = 'packet';
      rt.packetReason = kind === 'quota' ? `${oldLabel} is at its limit` : kind === 'auth' ? `${oldLabel} is logged out` : `${oldLabel} was removed from the registry`;
      rt.blockedRetries = 0;
      const noticeText =
        kind === 'quota'
          ? TEAM_NOTICE.failover(name, route.provider, route.accountLabel, oldLabel, reset?.until ?? now)
          : `${name} continues on ${route.provider}/${route.accountLabel} (${oldLabel} ${kind === 'auth' ? 'is logged out' : 'is no longer in the registry'}); it picks up from a hand-off note in the same worktree.`;
      await this.notice(['lead', 'user'], 'routing', noticeText);
      if (m.state !== 'idle') {
        await this.toIdle(name);
      }
      this.poke(0);
      return;
    }
    await this.blockNoAccount(o, name, kind, route);
  }

  private async blockNoAccount(o: Owned, name: string, kind: 'quota' | 'auth' | 'removed', route: RouteRefusal): Promise<void> {
    const m = o.model.members.get(name);
    if (m === undefined) {
      return;
    }
    const rt = this.memberRt(name);
    const facts = this.routingFacts();
    const now = Date.now();
    let earliest: { until: number; worker: string } | undefined;
    for (const w of facts?.workers ?? []) {
      if (providerOfWorker(w) !== m.provider) {
        continue;
      }
      const r = safeReset(() => this.seams.host.quotaResetAt(w, m.model));
      if (r !== undefined && r.until > now && (earliest === undefined || r.until < earliest.until)) {
        earliest = { until: r.until, worker: accountLabelOf(w) };
      }
    }
    const code: MemberReasonCode = kind === 'auth' || route.kind === 'login' ? 'login' : kind === 'removed' ? 'account-removed' : 'quota';
    const text =
      code === 'quota' && earliest !== undefined
        ? TEAM_NOTICE.blockedQuota(name, m.provider, earliest.until, earliest.worker)
        : `${name} is blocked: ${flat(route.text)}`;
    await this.setState(name, 'blocked', { code, text: flat(route.text), ...(earliest !== undefined ? { until: earliest.until } : {}) }, this.noticeItems(['lead', 'user'], 'blocked', text));
    if (earliest !== undefined && rt.blockedRetries < BLOCKED_RETRY_MAX) {
      rt.blockedRetries++;
      this.armBlockedRetry(o, name, earliest.until, now);
    }
  }

  /** §6.5 step 2: at the reset (+ margin) a member still `paused: quota-wait` continues its SAME incarnation. */
  private armQuotaWait(o: Owned, name: string, until: number, now: number): void {
    const rt = this.memberRt(name);
    this.armTimer(name, until + this.tuning.resetMarginMs - now, () => {
      void this.exclusive(async () => {
        const cur = o.model.members.get(name);
        if (this.owned === o && cur?.state === 'paused' && cur.reason?.code === 'quota-wait') {
          rt.forced = 'continue';
          await this.toIdle(name);
          this.poke(0);
        }
      });
    });
  }

  /** §6.5 step 4: at the earliest reset (+ margin) a member blocked for want of an account is checked again — continue, fail over, or block anew. */
  private armBlockedRetry(o: Owned, name: string, until: number, now: number): void {
    const rt = this.memberRt(name);
    this.armTimer(name, until + this.tuning.resetMarginMs - now, () => {
      void this.exclusive(async () => {
        const cur = o.model.members.get(name);
        if (this.owned !== o || cur?.state !== 'blocked' || (cur.reason?.code !== 'quota' && cur.reason?.code !== 'login' && cur.reason?.code !== 'account-removed')) {
          return;
        }
        rt.failedIdentities.clear();
        const account = await this.accountCheck(o, cur);
        if (account.ok) {
          rt.forced = 'continue';
          await this.toIdle(name);
          this.poke(0);
          return;
        }
        await this.failover(o, name, account.kind, account.text);
      });
    });
  }

  /**
   * §2.5 / Appendix B: `blocked: unknown-turn` lasts until its `until` (2 × the turn timeout after
   * the lost turn was planned — by then that process is past any turn's limit); then the member is
   * `idle` (or `starting` without a worktree) with a notice, and may run again.
   */
  private armUnknownTurn(o: Owned, name: string, until: number, now: number): void {
    this.armTimer(name, until - now, () => {
      void this.exclusive(async () => {
        const cur = o.model.members.get(name);
        if (this.owned !== o || cur?.state !== 'blocked' || cur.reason?.code !== 'unknown-turn') {
          return;
        }
        await this.setState(name, cur.ready !== undefined ? 'idle' : 'starting', undefined, this.noticeItems(['lead'], 'blocked', `${name}'s lost turn is past its time limit; ${name} is free again.`));
        this.poke(0);
      });
    });
  }

  /**
   * T11 E8/E16 (A24): every member state with a `reason.until` has a live timer — after team_resume
   * they are armed from the log (a timer lives in memory only): `paused: quota-wait` and
   * `blocked: quota / login / account-removed` at `until + RESET_MARGIN_MS`, `blocked: unknown-turn`
   * at `until`; an `until` already past fires at once. (`idle: budget` needs none: the scheduler
   * re-judges the budget on every tick.) Assumes the chain.
   */
  private armUntilTimers(o: Owned): void {
    const now = Date.now();
    for (const m of o.model.members.values()) {
      const until = m.reason?.until;
      const code = m.reason?.code;
      if (until === undefined || !Number.isFinite(until)) {
        continue;
      }
      if (m.state === 'paused' && code === 'quota-wait') {
        this.armQuotaWait(o, m.name, until, now);
      } else if (m.state === 'blocked' && (code === 'quota' || code === 'login' || code === 'account-removed')) {
        this.armBlockedRetry(o, m.name, until, now);
      } else if (m.state === 'blocked' && code === 'unknown-turn') {
        this.armUnknownTurn(o, m.name, until, now);
      }
    }
  }

  /** A new incarnation (§2.1): the previous one's tracked vendor MCP file is restored (I8 b), `member.routed` appended. Assumes the chain. */
  private async newIncarnation(o: Owned, name: string, route: RouteChoice, cause: RouteCause, reason?: string): Promise<void> {
    const m = o.model.members.get(name);
    if (m === undefined) {
      return;
    }
    await this.restoreVendor(o, name);
    await this.append([this.routedItem(name, m.incarnation + 1, route, cause, reason)], { reserve: true, hold: true });
    const rt = this.memberRt(name);
    rt.sharesLeadPlan = route.sharesLeadPlan;
    rt.billableOverage = route.billableOverage;
    this.writeMemberFiles(o, [name]);
  }

  /** Refresh (§3.5 `context`, `resume-failed`; §3.5.2 proactive): new incarnation, same provider/account/model, new conversation, the packet. */
  private async refresh(o: Owned, name: string, cause: RouteCause, why: string, startNow: boolean): Promise<void> {
    const m = o.model.members.get(name);
    const facts = this.routingFacts();
    const worker = facts?.workers.find((w) => w.name === m?.worker);
    if (m === undefined || worker === undefined) {
      if (m !== undefined) {
        await this.failover(o, name, 'removed', `worker ${m.worker} is no longer in the registry`);
      }
      return;
    }
    const route: RouteChoice = {
      ok: true,
      provider: m.provider,
      worker,
      accountKey: m.accountKey,
      model: m.model,
      modelSource: m.modelSource,
      modelPending: false,
      billableOverage: this.memberRt(name).billableOverage,
      sharesLeadPlan: this.memberRt(name).sharesLeadPlan,
      machineLogin: m.provider === 'cursor' || m.provider === 'gemini',
      accountLabel: accountLabelOf(worker),
      reason: flat(`a fresh conversation: ${why}`),
    };
    await this.newIncarnation(o, name, route, cause);
    const rt = this.memberRt(name);
    rt.packetReason = why;
    if (startNow) {
      rt.forced = 'packet';
      if (o.model.members.get(name)?.state !== 'idle') {
        await this.toIdle(name);
      }
    } else {
      rt.packetNext = true;
      await this.notice(
        ['lead'],
        'routing',
        `${name} starts a fresh conversation on its next turn (${why}); it picks up from a hand-off note in the same worktree.`,
      );
    }
  }

  /** I8 exception (b): restore a tracked vendor MCP file the engine merged into. */
  private async restoreVendor(o: Owned, name: string): Promise<string | undefined> {
    const m = o.model.members.get(name);
    if (m?.ready === undefined || VENDOR_MCP_FILES[m.provider] === undefined) {
      return undefined;
    }
    try {
      const r = await this.seams.worktrees.restoreVendorMcp(m.ready.cwd, m.provider);
      if (!r.ok) {
        await this.storeWarning(`${name}'s ${VENDOR_MCP_FILES[m.provider]} could not be restored: ${r.text}`);
        return r.text;
      }
    } catch (err) {
      return errText(err);
    }
    return undefined;
  }

  /** §5.5: `the team is idle` — posted when the team BECOMES idle (M11), once per transition. */
  private async teamIdleCheck(o: Owned): Promise<void> {
    if (!this.canStartTurns(o) || o.teamIdleNoticed) {
      return;
    }
    const live = [...o.model.members.values()].filter((m) => m.state !== 'stopped' && m.state !== 'ended');
    if (live.length === 0) {
      return;
    }
    const idle = live.every((m) => {
      const rt = o.members.get(m.name);
      return (
        m.state === 'idle' &&
        rt?.turn === undefined &&
        rt?.starting !== true &&
        rt?.forced === undefined &&
        o.model.pendingFor(m.name).every((p) => p.kind === 'notice') &&
        o.model.heldBy(m.name).every((t) => t.state !== 'claimed')
      );
    });
    if (idle) {
      o.teamIdleNoticed = true;
      await this.notice(['lead'], 'idle', TEAM_NOTICE.teamIdle());
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: messages from the lead and the user (§4)
   * ------------------------------------------------------------------------- */

  send(msg: OutgoingMessage, by: Actor): Promise<Result<SendAnswer>> {
    return this.guarded(() => this.exclusive(() => this.doSend(msg, by)));
  }

  private async doSend(msg: OutgoingMessage, by: Actor): Promise<Result<SendAnswer>> {
    const o = this.leading({ mutate: true });
    if ('ok' in o) {
      return o;
    }
    if (!isPlainObject(msg)) {
      return teamRefusal('invalid_text', TEAM_TOOL_TEXT.invalidText());
    }
    const norm = normalizeMessageText(msg.text);
    if (!norm.ok) {
      return norm.code === 'empty_message'
        ? teamRefusal('empty_message', TEAM_TOOL_TEXT.emptyMessage())
        : norm.code === 'message_too_large'
          ? teamRefusal('message_too_large', TEAM_TOOL_TEXT.messageTooLarge(norm.bytes ?? 0))
          : teamRefusal('invalid_text', TEAM_TOOL_TEXT.invalidText());
    }
    const kind: MessageKind = msg.kind === undefined ? 'text' : (SENDER_MESSAGE_KINDS as readonly string[]).includes(msg.kind) ? msg.kind : 'text';
    const to = typeof msg.to === 'string' ? msg.to : '';
    const urgent = msg.urgent === true;
    if (to === by) {
      return teamRefusal('not_allowed', TEAM_TOOL_TEXT.notAllowedSelf());
    }
    if (by === 'lead' && to === 'user') {
      return teamRefusal('not_allowed', TEAM_TEXT.leadToUser());
    }
    if (to === 'all' && urgent) {
      return teamRefusal('not_allowed', TEAM_TEXT.urgentToAll());
    }
    const memberNames = [...o.model.members.keys()];
    let recipients: string[];
    if (to === 'all') {
      recipients = [...o.model.members.values()].filter((m) => m.state !== 'stopped' && m.state !== 'ended').map((m) => m.name);
      if (recipients.length === 0) {
        return teamRefusal('not_allowed', 'every member is stopped');
      }
    } else if (to === 'lead' || to === 'user') {
      recipients = [to];
    } else {
      if (!o.model.members.has(to)) {
        return teamRefusal('unknown_member', TEAM_TEXT.unknownMember(flat(to, 40), o.model.name, memberNames, closest(to, memberNames)));
      }
      recipients = [to];
    }
    if (msg.replyTo !== undefined && !o.model.repliable(msg.replyTo, by)) {
      return teamRefusal('unknown_message', TEAM_TOOL_TEXT.unknownMessage(flat(msg.replyTo, 20)));
    }
    if (msg.task !== undefined && (typeof msg.task !== 'string' || !o.model.board.has(msg.task))) {
      return teamRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(msg.task, 20)));
    }
    // §4.2: lead and user sends ≤ 120 per 10 minutes.
    const now = Date.now();
    const window = by === 'lead' ? o.leadSends : o.userSends;
    while (window.length > 0 && now - window[0] >= LEAD_USER_SEND_WINDOW_MS) {
      window.shift();
    }
    if (window.length >= LEAD_USER_SENDS_PER_WINDOW) {
      return teamRefusal('rate_limited', TEAM_TEXT.leadRateLimited(Math.ceil((window[0] + LEAD_USER_SEND_WINDOW_MS - now) / 1000)));
    }
    // L4: the duplicate guard (60 s for lead/user; bodies under 64 bytes exempt).
    const sha = bodySha256(norm.text);
    const dupKey = duplicateKeyOf(by, to, msg.replyTo, msg.task, sha);
    if (norm.bytes >= DUPLICATE_MIN_BYTES) {
      const earlier = o.dupes.get(dupKey);
      if (earlier !== undefined && now - earlier.at < DUPLICATE_WINDOW_LEAD) {
        return teamRefusal('duplicate', TEAM_TOOL_TEXT.duplicate(messageIdOf(earlier.seq)));
      }
    }
    // M20: PENDING_MAX per MEMBER recipient.
    for (const r of recipients) {
      if (o.model.members.has(r) && o.model.pendingFor(r).length >= PENDING_MAX) {
        return teamRefusal('inbox_full', TEAM_TOOL_TEXT.inboxFull(r, o.model.members.get(r)?.state ?? 'idle'));
      }
    }
    // Urgent (MD-23): one member, ≤ 1 per 120 s; a running member is interrupted.
    let urgentFor: { name: string; interrupt: boolean; secondsAgo?: number } | undefined;
    if (urgent && recipients.length === 1 && o.model.members.has(recipients[0])) {
      const rt = this.memberRt(recipients[0]);
      const ago = rt.lastInterruptAt !== undefined ? now - rt.lastInterruptAt : Infinity;
      urgentFor = { name: recipients[0], interrupt: ago >= INTERRUPT_MIN_INTERVAL, ...(ago < INTERRUPT_MIN_INTERVAL ? { secondsAgo: Math.round(ago / 1000) } : {}) };
    }
    const items: LogAppend[] = [
      this.msgItem(
        by,
        to,
        kind,
        norm.text,
        {
          source: by === 'lead' ? 'cco' : 'frontend',
          urgent,
          ...(msg.replyTo !== undefined ? { re: msg.replyTo } : {}),
          ...(msg.task !== undefined ? { task: msg.task } : {}),
          ...(to === 'all' ? { recipients } : {}),
        },
        by,
      ),
    ];
    const r = await this.append(items);
    if (!r.ok) {
      return this.storeRefusal(o, r);
    }
    const posted = r.value[0];
    window.push(now);
    if (norm.bytes >= DUPLICATE_MIN_BYTES) {
      o.dupes.set(dupKey, { seq: posted.seq, at: now });
    }
    const msgId = messageIdOf(posted.seq);
    // §4.1: every user→member message is told to the lead (tellLead, L8).
    if (by === 'user' && to !== 'lead' && msg.tellLead !== false) {
      await this.notice(['lead'], 'message', TEAM_NOTICE.userWrote(to, msgId, norm.text));
    }
    const answer: SendRecipient[] = [];
    for (const rcp of recipients) {
      if (rcp === 'lead' || rcp === 'user') {
        answer.push({ to: rcp, state: rcp, delivery: 'inbox' });
        continue;
      }
      const m = o.model.members.get(rcp);
      const rt = this.memberRt(rcp);
      rt.peerWakes = 0;
      rt.peerNoticed = false;
      const state = m?.state ?? 'idle';
      if (rt.attach !== undefined) {
        answer.push({ to: rcp, state, delivery: 'attached', since: rt.attach.since });
      } else if (urgentFor !== undefined && urgentFor.name === rcp && !urgentFor.interrupt) {
        // §4.2: inside the 120 s window the answer is the pinned "queued; <x> was interrupted <s> s
        // ago" whatever the member's state now — the message itself is an ordinary queued one (it
        // starts an idle member's turn as any message does).
        answer.push({ to: rcp, state, delivery: 'urgent-queued', secondsAgo: urgentFor.secondsAgo ?? 0 });
      } else if (urgentFor !== undefined && urgentFor.name === rcp && rt.turn !== undefined) {
        rt.urgentSeq = posted.seq;
        rt.lastInterruptAt = now;
        this.stopTurn(rt.turn, 'urgent');
        answer.push({ to: rcp, state, delivery: 'interrupts' });
      } else if (state === 'idle' && rt.turn === undefined && !rt.starting) {
        answer.push({ to: rcp, state, delivery: 'starts' });
      } else if (state === 'running' || rt.turn !== undefined || rt.starting) {
        answer.push({ to: rcp, state: 'running', delivery: 'busy' });
      } else {
        answer.push({ to: rcp, state, delivery: 'held', ...(m?.reason !== undefined ? { reason: m.reason.text } : {}), ...(m?.reason?.until !== undefined ? { until: m.reason.until } : {}) });
      }
    }
    this.poke(0);
    return okResult({ msgId, recipients: answer });
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: the board (§5)
   * ------------------------------------------------------------------------- */

  board(op: TaskOp, by: Actor): Promise<Result<BoardAnswer>> {
    return this.guarded(() => this.exclusive(() => this.doBoard(op, by)));
  }

  private async doBoard(op: TaskOp, by: Actor): Promise<Result<BoardAnswer>> {
    const o = this.leading({ mutate: true });
    if ('ok' in o) {
      return o;
    }
    if (!isPlainObject(op) || typeof op.op !== 'string') {
      return teamRefusal('invalid_transition', 'the task operation must name an op');
    }
    const now = Date.now();
    if (op.op === 'add') {
      const problems: string[] = [];
      const tasks = this.checkTasks(op.tasks, o.model.board.size, new Set(o.model.members.keys()), problems);
      if (problems.length > 0) {
        return problems.some((p) => p === TEAM_TEXT.boardFull()) ? teamRefusal('board_full', TEAM_TEXT.boardFull()) : this.problemsRefusal(problems);
      }
      if (tasks.length === 0) {
        return this.problemsRefusal(['tasks must hold at least one task']);
      }
      const files: Array<{ rel: string; text: string }> = [];
      const part = this.taskItems(tasks, o.model.boardMax + 1, by, files, now);
      for (const f of files) {
        const w = o.store.writeFile(f.rel, f.text);
        if (!w.ok) {
          return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(w)));
        }
      }
      const r = await this.append(part.items);
      if (!r.ok) {
        return this.storeRefusal(o, r);
      }
      const created = part.created.map((t) => o.model.board.get(t.id) ?? t);
      this.poke(0);
      return okResult({ task: created[0], tasks: created }, this.overlapWarnings(o, created));
    }
    const taskId = (op as { task?: unknown }).task;
    const task = typeof taskId === 'string' ? o.model.board.get(taskId) : undefined;
    if (task === undefined) {
      return teamRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(taskId, 20)));
    }
    const items: LogAppend[] = [];
    const warnings: string[] = [];
    const holder = task.assignee;
    const transition = (to: TaskState): TeamRefusal | undefined =>
      BOARD_TRANSITIONS[task.state][to]?.[by] === undefined
        ? teamRefusal('invalid_transition', TEAM_TEXT.boardTransition(task.id, task.state, allowedBoardTargets(task.state, by)))
        : undefined;
    switch (op.op) {
      case 'assign': {
        const to = op.to;
        const member = typeof to === 'string' ? o.model.members.get(to) : undefined;
        if (member === undefined) {
          const names = [...o.model.members.keys()];
          return teamRefusal('unknown_member', TEAM_TEXT.unknownMember(flat(to, 40), o.model.name, names, typeof to === 'string' ? closest(to, names) : undefined));
        }
        if (member.state === 'stopped' || member.state === 'ended') {
          return teamRefusal('not_allowed', TEAM_TOOL_TEXT.notAllowedStopped(member.name, member.state));
        }
        if (task.state === 'cancelled') {
          return teamRefusal('invalid_transition', TEAM_TEXT.boardTransition(task.id, task.state, []));
        }
        if (holder !== undefined && holder !== member.name && task.state !== 'open' && task.state !== 'done' && op.force !== true) {
          return teamRefusal('invalid_transition', `${task.id} is ${task.state} by ${holder}; pass force to reassign it`);
        }
        items.push(this.item({ type: 'board.updated', id: task.id, changes: { state: 'claimed', assignee: member.name } }, by));
        const body = task.body ?? (task.bodyFile !== undefined ? (o.store.readFile(task.bodyFile, BOARD_BODY_MAX_BYTES + 1024) as { ok: boolean; value?: string }).value ?? '' : '');
        items.push(this.msgItem(by, member.name, 'assignment', this.assignmentText(task, body), { source: by === 'lead' ? 'cco' : 'frontend', task: task.id }, by));
        if (holder !== undefined && holder !== member.name && o.model.members.has(holder)) {
          items.push(...this.noticeItems([holder], 'board', TEAM_NOTICE.reassigned(task.id, member.name, by)));
        }
        warnings.push(...this.overlapWarnings(o, [{ ...task, assignee: member.name, state: 'claimed' }]));
        break;
      }
      case 'unassign': {
        const refused = transition('open');
        if (refused !== undefined) {
          return refused;
        }
        items.push(this.item({ type: 'board.updated', id: task.id, changes: { state: 'open', assignee: null } }, by));
        if (holder !== undefined && o.model.members.has(holder)) {
          items.push(...this.noticeItems([holder], 'board', `${task.id} "${task.title}" was unassigned from you by the ${by} — stop working on it.`));
        }
        break;
      }
      case 'cancel': {
        const refused = transition('cancelled');
        if (refused !== undefined) {
          return refused;
        }
        const note = typeof op.note === 'string' ? cutBytes(op.note, NOTE_MAX_BYTES) : undefined;
        const noteText = note !== undefined ? badTextProblem('note', note, false) : undefined;
        if (noteText !== undefined) {
          return this.problemsRefusal([noteText]);
        }
        items.push(this.item({ type: 'board.updated', id: task.id, changes: { state: 'cancelled' }, ...(note !== undefined ? { note } : {}) }, by));
        if (holder !== undefined && o.model.members.has(holder)) {
          items.push(...this.noticeItems([holder], 'board', `${task.id} "${task.title}" was cancelled by the ${by} — stop working on it.`));
        }
        break;
      }
      case 'reopen': {
        const target: TaskState = task.state === 'done' && holder !== undefined ? 'claimed' : 'open';
        const refused = transition(target);
        if (refused !== undefined) {
          return refused;
        }
        const note = typeof op.note === 'string' ? cutBytes(op.note, NOTE_MAX_BYTES) : undefined;
        const noteText = note !== undefined ? badTextProblem('note', note, false) : undefined;
        if (noteText !== undefined) {
          return this.problemsRefusal([noteText]);
        }
        items.push(this.item({ type: 'board.updated', id: task.id, changes: { state: target }, ...(note !== undefined ? { note } : {}) }, by));
        if (target === 'claimed' && holder !== undefined && o.model.members.has(holder)) {
          items.push(this.msgItem(by, holder, 'assignment', `${task.id} "${task.title}" was reopened for you.${note !== undefined ? `\n\n${note}` : ''}`, { source: by === 'lead' ? 'cco' : 'frontend', task: task.id }, by));
        }
        break;
      }
      case 'update': {
        const changes: {
          state?: TaskState;
          title?: string;
          body?: string;
          bodyFile?: string;
          paths?: string[];
          allowOverlap?: boolean;
        } = {};
        const fieldEdit = op.title !== undefined || op.body !== undefined || op.paths !== undefined || op.allow_overlap !== undefined;
        if (fieldEdit && task.state === 'cancelled') {
          return teamRefusal('invalid_transition', TEAM_TEXT.boardTransition(task.id, task.state, []));
        }
        if (op.title !== undefined) {
          const titleText = typeof op.title === 'string' ? badTextProblem('title', op.title, true) : undefined;
          if (titleText !== undefined) {
            return this.problemsRefusal([titleText]);
          }
          if (typeof op.title !== 'string' || op.title.trim() === '' || [...op.title].length > BOARD_TITLE_MAX_CHARS) {
            return this.problemsRefusal([`title must be 1–${BOARD_TITLE_MAX_CHARS} characters on one line`]);
          }
          changes.title = op.title;
        }
        if (op.body !== undefined) {
          if (typeof op.body !== 'string' || bytesOf(op.body) > BOARD_BODY_MAX_BYTES) {
            return this.problemsRefusal([`body must be a text of at most ${BOARD_BODY_MAX_BYTES} bytes`]);
          }
          const bodyText = badTextProblem('body', op.body, false);
          if (bodyText !== undefined) {
            return this.problemsRefusal([bodyText]);
          }
          if (bytesOf(op.body) > BOARD_BODY_INLINE) {
            const rel = `bodies/${task.id}.md`;
            const w = o.store.writeFile(rel, op.body);
            if (!w.ok) {
              return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(w)));
            }
            changes.bodyFile = rel;
          } else {
            changes.body = op.body;
          }
        }
        if (op.paths !== undefined) {
          if (!Array.isArray(op.paths) || op.paths.length > BOARD_PATHS_MAX) {
            return teamRefusal('invalid_path', `paths must be a list of at most ${BOARD_PATHS_MAX} paths`);
          }
          for (const p of op.paths) {
            const problem = boardPathProblem(p);
            if (problem !== undefined) {
              return teamRefusal('invalid_path', TEAM_TEXT.invalidPath(flat(p, 80), problem));
            }
          }
          changes.paths = op.paths;
        }
        if (op.allow_overlap !== undefined) {
          changes.allowOverlap = op.allow_overlap === true;
        }
        let note: string | undefined;
        if (op.note !== undefined) {
          if (typeof op.note !== 'string' || bytesOf(op.note) > NOTE_MAX_BYTES) {
            return this.problemsRefusal([TEAM_TOOL_TEXT.noteTooLarge(typeof op.note === 'string' ? bytesOf(op.note) : 0)]);
          }
          const noteText = badTextProblem('note', op.note, false);
          if (noteText !== undefined) {
            return this.problemsRefusal([noteText]);
          }
          note = op.note;
        }
        if (op.state !== undefined && op.state !== task.state) {
          const refused = transition(op.state);
          if (refused !== undefined) {
            return refused;
          }
          if ((op.state === 'claimed' || op.state === 'blocked' || op.state === 'review') && holder === undefined) {
            return teamRefusal('invalid_transition', `${task.id} has no assignee; assign it first`);
          }
          changes.state = op.state;
        }
        items.push(this.item({ type: 'board.updated', id: task.id, changes, ...(note !== undefined ? { note } : {}) }, by));
        if (holder !== undefined && o.model.members.has(holder)) {
          const what =
            changes.state === 'done'
              ? `${task.id} "${task.title}" was marked done by the ${by}.`
              : changes.state === 'claimed' && task.state === 'review'
                ? `${task.id} "${task.title}" needs rework (the ${by})${note !== undefined ? `: ${note}` : '.'}`
                : changes.state === 'open'
                  ? `${task.id} "${task.title}" was unassigned from you by the ${by} — stop working on it.`
                  : `${task.id} "${task.title}" was changed by the ${by}${note !== undefined ? `: ${note}` : '.'}`;
          // a rework wakes the holder (it has work again); every other change is a notice
          items.push(
            changes.state === 'claimed' && task.state === 'review'
              ? this.msgItem(by, holder, 'assignment', what, { source: by === 'lead' ? 'cco' : 'frontend', task: task.id }, by)
              : this.noticeItems([holder], 'board', what)[0],
          );
        }
        if (changes.paths !== undefined && (task.state === 'claimed' || task.state === 'blocked')) {
          warnings.push(...this.overlapWarnings(o, [{ ...task, paths: changes.paths }]));
        }
        break;
      }
      default:
        return teamRefusal('invalid_transition', `unknown task op ${flat((op as { op: unknown }).op, 20)}`);
    }
    const r = await this.append(items);
    if (!r.ok) {
      return this.storeRefusal(o, r);
    }
    const after = o.model.board.get(task.id) ?? task;
    this.poke(0);
    return okResult({ task: after, tasks: [after] }, warnings);
  }

  /** §5.3: a lead/user path conflict is a WARNING: `warning: b3 overlaps b1 (alice) on src/net/`. */
  private overlapWarnings(o: Owned, tasks: BoardTask[]): string[] {
    const out: string[] = [];
    for (const t of tasks) {
      if (t.allowOverlap || t.assignee === undefined) {
        continue;
      }
      for (const other of o.model.board.values()) {
        if (other.id === t.id || other.allowOverlap || other.assignee === undefined || other.assignee === t.assignee) {
          continue;
        }
        if (other.state !== 'claimed' && other.state !== 'blocked') {
          continue;
        }
        const hit = t.paths.find((p) => other.paths.some((q) => pathsOverlap(p, q)));
        if (hit !== undefined) {
          out.push(`warning: ${t.id} overlaps ${other.id} (${other.assignee}) on ${hit}`);
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: member operations (§7.2 team_member, §3.5)
   * ------------------------------------------------------------------------- */

  member(op: MemberOp, by: Actor): Promise<Result<MemberAnswer>> {
    void by;
    return this.guarded(async () => {
      const pre = await this.exclusive(() => this.memberOpStart(op));
      if ('ok' in pre) {
        return pre;
      }
      if (pre.wait !== undefined) {
        await pre.wait;
      }
      return this.exclusive(() => this.memberOpFinish(op, pre.lines));
    });
  }

  private async memberOpStart(op: MemberOp): Promise<TeamRefusal | { lines: string[]; wait?: Promise<void> }> {
    const o = this.leading({ mutate: false });
    if ('ok' in o) {
      return o;
    }
    if (!isPlainObject(op) || typeof op.member !== 'string') {
      return teamRefusal('unknown_member', TEAM_TEXT.unknownMember('', o.model.name, [...o.model.members.keys()]));
    }
    const m = o.model.members.get(op.member);
    if (m === undefined) {
      const names = [...o.model.members.keys()];
      return teamRefusal('unknown_member', TEAM_TEXT.unknownMember(flat(op.member, 40), o.model.name, names, closest(op.member, names)));
    }
    if (m.state === 'ended') {
      return teamRefusal('not_allowed', `${m.name} is ended`);
    }
    const rt = this.memberRt(m.name);
    const turn = rt.turn;
    const lines: string[] = [];
    switch (op.op) {
      case 'stop':
        if (turn !== undefined) {
          this.stopTurn(turn, 'stop');
          lines.push(`${m.name}'s turn ${turn.n} is being stopped.`);
          return { lines, wait: turn.done };
        }
        return { lines };
      case 'pause':
        if (turn !== undefined) {
          if (op.now === true) {
            this.stopTurn(turn, 'pause');
            lines.push(`${m.name}'s turn ${turn.n} is being stopped.`);
            return { lines, wait: turn.done };
          }
          // the turn's end makes it `paused` (toIdle, Appendix B)
          await this.setState(m.name, 'pausing');
          rt.forced = undefined;
          lines.push(TEAM_TEXT.pausing(m.name, this.settings().turnTimeoutMinutes));
          return { lines };
        }
        return { lines };
      case 'interrupt':
        if (turn !== undefined) {
          this.stopTurn(turn, 'interrupt');
          lines.push(`${m.name}'s turn ${turn.n} is being interrupted.`);
          return { lines, wait: turn.done };
        }
        lines.push(`${m.name} is ${m.state}; there is no turn to interrupt.`);
        return { lines };
      case 'switch':
        if (turn !== undefined) {
          return teamRefusal('member_running', TEAM_TEXT.switchWhileRunning(m.name, turn.n));
        }
        return { lines };
      case 'restart':
      case 'unpause':
        if (turn !== undefined) {
          return teamRefusal('member_running', `${m.name} is running turn ${turn.n}`);
        }
        return { lines };
      default:
        return teamRefusal('not_allowed', `unknown member operation ${flat((op as { op: unknown }).op, 20)}`);
    }
  }

  private async memberOpFinish(op: MemberOp, lines: string[]): Promise<Result<MemberAnswer>> {
    const o = this.leading({ mutate: false });
    if ('ok' in o) {
      return o;
    }
    const name = op.member;
    const m = o.model.members.get(name);
    if (m === undefined) {
      return teamRefusal('unknown_member', TEAM_TEXT.unknownMember(name, o.model.name, [...o.model.members.keys()]));
    }
    const rt = this.memberRt(name);
    const answer = (): Result<MemberAnswer> => okResult({ member: name, state: o.model.members.get(name)?.state ?? m.state, lines });
    switch (op.op) {
      case 'stop': {
        if (m.state === 'stopped') {
          lines.push(lines.length > 0 ? `${name} is stopped; its worktree and branch are kept.` : `${name} is already stopped.`);
          return answer();
        }
        if (rt.timer !== undefined) {
          clearTimeout(rt.timer);
          rt.timer = undefined;
        }
        const cp = await this.gitCheckpoint(o, name, undefined, '');
        await this.recordCheckpoint(o, name, undefined, cp);
        await this.setState(name, 'stopped');
        await this.restoreVendor(o, name);
        lines.push(`${name} is stopped; its worktree and branch are kept.`);
        return answer();
      }
      case 'pause': {
        if (m.state === 'paused') {
          lines.push(lines.length > 0 ? `${name} is paused.` : `${name} is already paused.`);
        } else if (m.state === 'idle' || m.state === 'blocked' || m.state === 'starting') {
          await this.setState(name, 'paused');
          lines.push(`${name} is paused.`);
        } else if (m.state === 'running') {
          // the ladder ended it: handleInterrupted made it paused
        }
        return answer();
      }
      case 'interrupt':
        return answer();
      case 'unpause': {
        if (m.state !== 'paused' && m.state !== 'blocked' && m.state !== 'pausing') {
          lines.push(`${name} is ${m.state}; there is nothing to unpause.`);
          return answer();
        }
        // M20: the cause is re-checked; one that still holds blocks again with the same code.
        if (rt.timer !== undefined) {
          clearTimeout(rt.timer);
          rt.timer = undefined;
        }
        rt.blockedRetries = 0;
        rt.earlyCrashes = 0;
        rt.consecutiveErrors = 0;
        rt.contextAtN = [];
        rt.failedIdentities.clear();
        const code = m.reason?.code;
        if (code === 'worktree-missing' || code === 'worktree-branch' || code === 'worktree') {
          if (m.ready !== undefined) {
            const check = await this.seams.worktrees.check({ path: m.ready.path, branch: m.ready.branch });
            if (!check.ok) {
              await this.block(name, code, check.text);
              lines.push(`${name} is still blocked: ${flat(check.text)}`);
              return answer();
            }
          } else {
            await this.setState(name, 'starting');
            rt.liveChecked = false;
            this.startBringUp(o);
            lines.push(`${name} is starting again (its worktree is created).`);
            return answer();
          }
        }
        if (code === 'quota' || code === 'login' || code === 'account-removed' || code === 'quota-wait') {
          const account = await this.accountCheck(o, m);
          if (!account.ok) {
            await this.failover(o, name, account.kind, account.text);
            const after = o.model.members.get(name);
            lines.push(after?.state === 'blocked' ? `${name} is still blocked: ${after.reason?.text ?? ''}` : `${name} continues on another account.`);
            return answer();
          }
          rt.forced = 'continue';
        }
        if (m.ready === undefined) {
          await this.setState(name, 'starting');
          rt.liveChecked = false;
          this.startBringUp(o);
        } else {
          await this.toIdle(name);
        }
        lines.push(`${name} is unpaused.`);
        this.poke(0);
        return answer();
      }
      case 'restart': {
        if (rt.timer !== undefined) {
          clearTimeout(rt.timer);
          rt.timer = undefined;
        }
        rt.blockedRetries = 0;
        rt.earlyCrashes = 0;
        rt.consecutiveErrors = 0;
        rt.failedIdentities.clear();
        if (m.ready !== undefined) {
          const check = await this.seams.worktrees.check({ path: m.ready.path, branch: m.ready.branch });
          if (!check.ok && check.code === 'missing') {
            const restored = await this.seams.worktrees.restore({ repoRoot: o.model.repoRoot, path: m.ready.path, branch: m.ready.branch });
            if (!restored.ok) {
              await this.block(name, 'worktree-missing', restored.text);
              lines.push(`${name}'s worktree could not be recreated: ${flat(restored.text)}`);
              return answer();
            }
            lines.push(`${name}'s worktree was recreated from ${m.ready.branch}.`);
          } else if (!check.ok) {
            await this.block(name, check.code === 'branch-moved' ? 'worktree-branch' : 'worktree', check.text);
            lines.push(`${name} is blocked: ${flat(check.text)}`);
            return answer();
          }
        }
        const account = await this.accountCheck(o, m);
        if (!account.ok) {
          await this.failover(o, name, account.kind, account.text);
        } else if (m.ready === undefined) {
          await this.setState(name, 'starting');
          rt.liveChecked = false;
          this.startBringUp(o);
        } else {
          await this.toIdle(name);
        }
        lines.push(`${name} is restarted.`);
        this.poke(0);
        return answer();
      }
      case 'switch': {
        const provider = op.provider !== undefined ? parseProvider(op.provider) : undefined;
        if (op.provider !== undefined && provider === undefined) {
          return this.problemsRefusal(['provider must be claude, codex, cursor or gemini']);
        }
        if (op.provider === undefined && op.worker === undefined && op.model === undefined) {
          return this.problemsRefusal(['switch needs provider, worker or model']);
        }
        const facts = this.routingFacts();
        if (facts === undefined) {
          return teamRefusal('team_store_failed', TEAM_TEXT.storeFailed('the registry could not be read'));
        }
        const route = await routeMember(
          {
            member: name,
            spec: {
              provider: provider ?? (op.worker === undefined ? m.provider : undefined),
              ...(op.worker !== undefined ? { worker: op.worker } : {}),
              ...(op.model !== undefined ? { model: op.model } : m.spec.model !== undefined && provider === undefined ? { model: m.spec.model } : {}),
            },
            team: this.routedTeam(o.model),
            mode: 'live',
          },
          facts,
        );
        if (!route.ok) {
          return this.problemsRefusal([TEAM_TEXT.noAccount(name, [{ provider: provider ?? m.provider, reason: route.text }])]);
        }
        await this.newIncarnation(o, name, route, 'switch');
        rt.forced = 'packet';
        rt.packetReason = 'the lead switched it to another account or model';
        if (m.state !== 'idle' && m.ready !== undefined) {
          await this.toIdle(name);
        }
        lines.push(`${name} switches to ${route.provider}/${route.accountLabel}${route.model !== '' ? ` (${route.model})` : ''}; it continues from a hand-off note in the same worktree.`);
        this.poke(0);
        return answer();
      }
      default:
        return answer();
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: end, resume, suspend, sweep (§2.5, H2, S1-6)
   * ------------------------------------------------------------------------- */

  end(now: boolean, by: Actor): Promise<Result<EndAnswer>> {
    void by;
    return this.guarded(async () => {
      const pre = await this.exclusive(() => {
        const o = this.leading({ mutate: false });
        if ('ok' in o) {
          return o;
        }
        if (o.model.status !== 'active' && o.model.status !== 'readonly') {
          return teamRefusal('no_team', TEAM_TEXT.noTeam());
        }
        o.ending = true;
        o.abort.abort();
        if (now) {
          for (const rt of o.members.values()) {
            if (rt.turn !== undefined) {
              this.stopTurn(rt.turn, 'end');
            }
          }
        }
        return o;
      });
      if ('ok' in pre) {
        return pre;
      }
      const o = pre;
      const turns = (): TurnRt[] => [...o.members.values()].map((rt) => rt.turn).filter((t): t is TurnRt => t !== undefined);
      if (!now && turns().length > 0) {
        await Promise.race([Promise.all(turns().map((t) => t.done)), sleep(this.tuning.endDrainMs)]);
        for (const t of turns()) {
          this.stopTurn(t, 'end');
        }
      }
      await Promise.all(turns().map((t) => t.done));
      // members still starting (a worktree being created) finish their step first
      await Promise.race([this.bringUpQueue, sleep(5_000)]);
      return this.exclusive(() => this.finishEnd(o, now));
    });
  }

  private async finishEnd(o: Owned, now: boolean): Promise<Result<EndAnswer>> {
    const lines: string[] = [];
    const branches: EndAnswer['branches'] = [];
    for (const m of o.model.members.values()) {
      const rt = this.memberRt(m.name);
      if (rt.timer !== undefined) {
        clearTimeout(rt.timer);
        rt.timer = undefined;
      }
      if (m.state !== 'ended' && m.ready !== undefined) {
        const cp = await this.gitCheckpoint(o, m.name, undefined, '');
        await this.recordCheckpoint(o, m.name, undefined, cp);
      }
      const restoreError = await this.restoreVendor(o, m.name);
      if (m.state !== 'ended') {
        await this.append([this.stateItem(m.name, 'ended')], { reserve: true, hold: true });
      }
      const wt = m.ready ?? m.plan;
      if (wt !== undefined) {
        let facts: { ahead: number; dirty: boolean; merged: boolean } | undefined;
        try {
          const f = await this.seams.worktrees.facts({ path: wt.path, baseCommit: wt.baseCommit, leadCheckout: this.runtime.workspace });
          facts = f.ok ? f.value : undefined;
        } catch {
          facts = undefined;
        }
        branches.push({
          member: m.name,
          branch: wt.branch,
          worktree: wt.path,
          baseCommit: wt.baseCommit,
          ...(facts !== undefined ? { ahead: facts.ahead, dirty: facts.dirty, merged: facts.merged } : {}),
          ...(restoreError !== undefined ? { restoreError } : {}),
        });
      }
    }
    // §4.3 expired: a message to a member that never got it — the lead/user sender is told.
    const expired = new Map<string, string[]>();
    for (const m of o.model.members.values()) {
      for (const p of o.model.pendingFor(m.name)) {
        if (p.from === 'lead' || p.from === 'user') {
          const list = expired.get(p.from) ?? [];
          list.push(`${messageIdOf(p.seq)} to ${m.name}`);
          expired.set(p.from, list);
        }
      }
    }
    const items: LogAppend[] = [];
    for (const [sender, ids] of expired) {
      items.push(...this.noticeItems([sender], 'expired', `These messages were never delivered because the team ended: ${ids.slice(0, 50).join(', ')}.`));
    }
    items.push(this.item({ type: 'team.status', status: 'ended', reason: now ? 'ended-now' : 'ended' }));
    await this.append(items, { reserve: true, hold: true });
    lines.push(`Team ${o.model.name} has ended; every worktree and branch is kept.`);
    try {
      await o.store.release('ended');
    } catch {
      // the next host's sweep sees an ended team and leaves it
    }
    const answer: EndAnswer = { teamId: o.teamId, name: o.model.name, mode: now ? 'now' : 'drain', lines, branches };
    this.forget(o);
    return okResult(answer);
  }

  resume(ref: string | undefined, by: 'lead'): Promise<Result<CreateAnswer>> {
    void by;
    return this.guarded(() => this.awaitSweep().then(() => this.exclusive(() => this.doResume(ref))));
  }

  private async doResume(ref: string | undefined): Promise<Result<CreateAnswer>> {
    if (this.seams.host.platform === 'win32') {
      return teamRefusal('unsupported_platform', TEAM_TEXT.unsupportedPlatform());
    }
    if (this.suspendPromise !== undefined) {
      return teamRefusal('suspending', TEAM_TEXT.suspending());
    }
    const cur = this.owned;
    if (cur !== undefined && !cur.dropped) {
      if (ref === undefined || ref === cur.teamId || ref === cur.model.name) {
        return okResult({ state: this.team() ?? this.fallbackState(cur), outcome: 'already-led' as const, baseRef: 'HEAD', members: [...cur.model.members.keys()] });
      }
      return teamRefusal('already_leading', TEAM_TEXT.alreadyLeading(cur.model.name));
    }
    const repo = await this.seams.worktrees.repository(this.runtime.workspace);
    if (!repo.ok) {
      return teamRefusal('not_git', TEAM_TEXT.notGit(this.runtime.workspace, flat(repo.text)));
    }
    this.repoRootCache = repo.value.repoRoot;
    // T11 E4 (A20): a team whose host died after this host's start-up sweep is still `active` with a
    // stale lease — the one-team sweep takes it first (a LIVE lease is never taken: team_busy below).
    await this.sweepStale(repo.value.repoRoot, ref);
    const ofRepo = this.seams.stores.list().filter((l) => (l.header?.repoRoot ?? l.state.repoRoot) === repo.value.repoRoot);
    // E11 (A20): a damaged team is named with its reason — never "no team" or "active".
    const damagedOf = (l: TeamDirListing): string | undefined =>
      l.state.status === 'ended' ? undefined : l.state.status === 'damaged' ? (l.state.damagedReason ?? 'its log does not validate') : this.damagedSeen.get(l.teamId);
    let target: (typeof ofRepo)[number] | undefined;
    if (ref === undefined) {
      const suspended = ofRepo.filter((l) => l.state.status === 'suspended' && damagedOf(l) === undefined);
      if (suspended.length === 0) {
        const damaged = ofRepo.filter((l) => damagedOf(l) !== undefined);
        return teamRefusal(
          'no_suspended_team',
          damaged.length === 0
            ? TEAM_TEXT.noSuspendedTeam()
            : `${TEAM_TEXT.noSuspendedTeam()} Damaged: ${damaged.map((l) => `${l.header?.name ?? l.state.name} (${flat(damagedOf(l), 200)})`).join('; ')}.`,
        );
      }
      if (suspended.length > 1) {
        return teamRefusal('several_suspended', TEAM_TEXT.severalSuspended(suspended.map((l) => ({ teamId: l.teamId, name: l.header?.name ?? l.state.name }))));
      }
      target = suspended[0];
    } else {
      target =
        ofRepo.find((l) => l.teamId === ref) ??
        ofRepo.find((l) => (l.header?.name ?? l.state.name) === ref && l.state.status === 'suspended') ??
        ofRepo.find((l) => (l.header?.name ?? l.state.name) === ref);
      if (target === undefined) {
        return teamRefusal('no_suspended_team', TEAM_TEXT.noSuspendedTeam());
      }
    }
    const name = target.header?.name ?? target.state.name;
    const damagedReason = damagedOf(target);
    if (damagedReason !== undefined) {
      return teamRefusal('not_suspended', TEAM_TEXT.notSuspended(name, `damaged (${flat(damagedReason, 200)})`));
    }
    if (target.state.status !== 'suspended') {
      if (target.lease !== undefined && this.leaseIsLive(target.lease.hostPid, target.lease.hostStartedAt) && target.state.status === 'active') {
        return teamRefusal('team_busy', TEAM_TEXT.teamBusy(name, target.lease.session.pid, target.lease.session.startedAt));
      }
      return teamRefusal('not_suspended', TEAM_TEXT.notSuspended(name, target.state.status));
    }
    if (target.header === undefined) {
      return teamRefusal('not_suspended', TEAM_TEXT.notSuspended(name, 'damaged'));
    }
    // E4: never acquire a team a sweep of this host is taking at this moment (the store instance is
    // shared, so both would "own" it): wait for that sweep, and let none start on it until adopted.
    this.claimedTeam = target.teamId;
    const unclaim = <T>(v: T): T => {
      this.claimedTeam = undefined;
      return v;
    };
    await this.sweepsInFlight.get(target.teamId);
    const opened = this.seams.stores.open(target.teamId);
    if (!opened.ok) {
      return unclaim(teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(opened))));
    }
    const store = opened.value;
    // The overlay is set before acquire (TeamStore.setOverlay); it reads the owned team once adopted.
    store.setOverlay((s) => (this.owned !== undefined && this.owned.store === store ? this.overlay(this.owned, s) : s));
    const acquired = await store.acquire();
    if (!acquired.ok) {
      switch (acquired.code) {
        case 'busy':
          return unclaim(teamRefusal('team_busy', TEAM_TEXT.teamBusy(name, acquired.holder?.session.pid ?? 0, acquired.holder?.session.startedAt ?? Date.now())));
        case 'contended':
          return unclaim(teamRefusal('lease_contended', TEAM_TEXT.leaseContended(name)));
        case 'damaged':
          this.damagedSeen.set(target.teamId, flat(acquired.reason));
          return unclaim(teamRefusal('not_suspended', TEAM_TEXT.notSuspended(name, `damaged (${flat(acquired.reason, 200)})`)));
        default:
          return unclaim(teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(acquired))));
      }
    }
    const adopted = this.adopt(store, target.header, repo.value.repoHash);
    if ('ok' in adopted) {
      try {
        await store.release('unreadable');
      } catch {
        // nothing more to do
      }
      return unclaim(teamRefusal('team_store_failed', TEAM_TEXT.storeFailed(storeErrno(adopted))));
    }
    this.claimedTeam = undefined;
    const o = adopted;
    // A turn a suspend could not finish within its budget is still open in the log: closed here
    // by the sweep's own rule before anything else runs (§2.5, §7.9 step 3).
    const openBefore = new Set([...o.model.turns.values()].filter((t) => t.ended === undefined).map((t) => t.name));
    const orphans = await this.closeOrphanTurns(o.model, o.teamId);
    const closing: LogAppend[] = [...orphans.items];
    for (const [member, until] of orphans.blocked) {
      closing.push(this.stateItem(member, 'blocked', { code: 'unknown-turn', text: 'a turn of this member may still be running; it could not be found', until }));
    }
    // E7: a member a suspend blocked `unknown-turn` whose turn is closed now is free again.
    for (const m of o.model.members.values()) {
      if (m.state === 'blocked' && m.reason?.code === 'unknown-turn' && openBefore.has(m.name) && !orphans.blocked.has(m.name)) {
        closing.push(this.stateItem(m.name, m.ready !== undefined ? 'idle' : 'starting'));
      }
    }
    const r = await this.append([...closing, this.item({ type: 'team.status', status: 'active', reason: 'resumed' }, 'lead')], { reserve: true });
    if (!r.ok) {
      return this.storeRefusal(o, r);
    }
    this.writeMemberFiles(o, [...o.model.members.keys()]);
    const interrupted: string[] = [];
    const reportLost: string[] = [];
    const facts = this.routingFacts();
    const time = clockHHMM(Date.now());
    for (const m of o.model.members.values()) {
      if (m.state === 'stopped' || m.state === 'ended') {
        continue;
      }
      const rt = this.memberRt(m.name);
      rt.recaps.push(TEAM_TURN_TEXT.recapResumed(time));
      if (m.lastTurn !== undefined && (m.lastTurn.outcome === 'crashed' || (m.lastTurn.outcome === 'interrupted' && m.lastTurn.reason === 'engine-restart'))) {
        rt.recaps.push(TEAM_TURN_TEXT.recapReportLost());
        reportLost.push(m.name);
      }
      if (m.lastTurn !== undefined && m.lastTurn.outcome === 'interrupted') {
        interrupted.push(m.name);
      }
      if (m.state === 'running' || m.state === 'pausing' || m.state === 'attach_pending' || m.state === 'attached') {
        await this.setState(m.name, m.ready !== undefined ? 'idle' : 'starting');
      }
      // `cause: resume` routing for every member that was not stopped (§2.5): its last account when
      // still eligible — the same incarnation, so its conversation is resumed — else afresh within
      // the provider (packet).
      if (m.worker !== '') {
        const check = await this.accountCheck(o, m);
        if (check.ok) {
          await this.append([
            this.item({
              type: 'member.routed',
              name: m.name,
              incarnation: m.incarnation,
              provider: m.provider,
              worker: m.worker,
              accountKey: m.accountKey,
              model: m.model,
              modelSource: m.modelSource,
              reason: 'resumed on its last account',
              cause: 'resume',
            }),
          ]);
        } else if (facts !== undefined) {
          const route = await routeMember(
            { member: m.name, spec: { model: m.spec.model }, team: this.routedTeam(o.model), forceProvider: m.provider, mode: 'cached', failedIdentities: new Set([m.accountKey]) },
            facts,
          );
          if (route.ok) {
            await this.newIncarnation(o, m.name, route, 'resume', `resumed on another account: ${flat(check.text, 200)}`);
            rt.packetNext = true;
            rt.packetReason = 'the team was resumed on another account';
          } else {
            await this.block(m.name, check.kind === 'auth' ? 'login' : check.kind === 'removed' ? 'account-removed' : 'quota', route.text);
          }
        }
      }
    }
    this.armUntilTimers(o);
    this.startBringUp(o);
    this.poke();
    return okResult({
      state: this.team() ?? this.fallbackState(o),
      outcome: 'resumed' as const,
      baseRef: 'HEAD',
      members: [...o.model.members.keys()],
      interrupted,
      reportLost,
    });
  }

  suspendAll(budgetMs: number): Promise<void> {
    if (this.suspendPromise !== undefined) {
      return this.suspendPromise;
    }
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return Promise.resolve();
    }
    const budget = Math.max(0, Number.isFinite(budgetMs) ? budgetMs : 0);
    const deadline = Date.now() + budget;
    const work = this.doSuspend(o, deadline).catch((err) => this.log(`suspend failed: ${errText(err)}`));
    this.suspendPromise = Promise.race([work, sleep(budget)]).then(() => undefined);
    return this.suspendPromise;
  }

  /** H2: the suspend ladder on every turn, checkpoints with what remains, `suspended`, lease released — bounded by `deadline`. */
  private async doSuspend(o: Owned, deadline: number): Promise<void> {
    o.suspending = true;
    o.abort.abort();
    if (o.waiter !== undefined) {
      const w = o.waiter;
      o.waiter = undefined;
      w.cleanup();
      w.resolve('aborted');
    }
    const turns = [...o.members.values()].map((rt) => rt.turn).filter((t): t is TurnRt => t !== undefined);
    for (const t of turns) {
      this.stopTurn(t, 'lead-ended');
    }
    // the processes first (≤ 8 s + reap grace), keeping a margin for the checkpoints and the release
    const margin = Math.min(4_000, Math.max(0, (deadline - Date.now()) / 4));
    await Promise.race([Promise.all(turns.map((t) => t.done)), sleep(deadline - Date.now() - margin)]);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now() - 1_000));
    try {
      await this.exclusive(async () => {
        if (this.owned !== o || o.dropped) {
          return;
        }
        for (const m of o.model.members.values()) {
          if (Date.now() >= deadline - 1_000) {
            break;
          }
          const rt = o.members.get(m.name);
          if (rt?.turn !== undefined || m.ready === undefined || m.state === 'stopped' || m.state === 'ended') {
            continue;
          }
          const cp = await this.gitCheckpoint(o, m.name, undefined, '', abort.signal);
          await this.recordCheckpoint(o, m.name, undefined, cp);
        }
        await this.append(this.closeSuspendedTurns(o), { reserve: true });
        await this.append([this.item({ type: 'team.status', status: 'suspended', reason: 'lead-ended' })], { reserve: true });
        try {
          await o.store.release('lead-ended');
        } catch {
          // the next host's sweep finishes the job
        }
        this.forget(o);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * T11 E7 (A23): the turns a suspend could not see finish within its budget. `running` exists only
   * between `turn.running` and `turn.ended` (Appendix B), so before `team.status suspended`: a turn
   * whose process is PROVEN gone (never spawned, or its pid dead / reused — start time off) gets
   * `turn.ended {interrupted, reason: lead-ended}` and its member `idle` (its late finishTurn, if
   * any, finds the team released and appends nothing); a turn whose process may still live keeps its
   * open record — the next host's sweep fences it, as for a host crash — and its member is
   * `blocked: unknown-turn` until 2 × the turn timeout after it was planned. The task log is closed
   * for a turn ended here. Assumes the chain.
   */
  private closeSuspendedTurns(o: Owned): LogAppend[] {
    const items: LogAppend[] = [];
    const proc = this.seams.host.process;
    const settings = this.settings();
    for (const rt of o.members.values()) {
      const turn = rt.turn;
      if (turn === undefined) {
        continue;
      }
      const pid = turn.spawned?.pid ?? turn.handle?.pid;
      let alive = false;
      if (pid !== undefined) {
        try {
          if (proc.isAlive(pid)) {
            const seen = proc.startedAt(pid);
            // a start time that cannot be read is NOT proof the process is gone (MD-7)
            alive = turn.spawned === undefined || seen === undefined || Math.abs(seen - turn.spawned.startedAt) <= START_SLACK_MS;
          }
        } catch {
          alive = true;
        }
      }
      if (alive) {
        const plannedAt = o.model.turns.get(turn.turnId)?.plannedAt ?? turn.startedAt;
        items.push(
          this.stateItem(turn.member, 'blocked', {
            code: 'unknown-turn',
            text: `turn ${turn.n} may still be running (pid ${pid}); the next host stops it`,
            until: plannedAt + 2 * settings.turnTimeoutMinutes * 60_000,
          }),
        );
        continue;
      }
      items.push(
        this.item({
          type: 'turn.ended',
          turnId: turn.turnId,
          outcome: 'interrupted',
          exitCode: null,
          signal: null,
          durationMs: Math.max(0, Date.now() - turn.startedAt),
          tokens: { in: 0, out: 0 },
          text: '',
          textFile: safeTurnFile(this.runtime.dataRoot, turn.turnId),
          sawAssistant: false,
          note: 'the lead session ended; the turn process is gone',
          reason: 'lead-ended',
        }),
        this.stateItem(turn.member, 'idle'),
      );
      try {
        this.seams.host.taskLog.appendTerminal({ ...this.taskBase(o, turn, o.model.members.get(turn.member)?.modelSource ?? 'cli'), ts: Date.now(), status: 'error', error: 'team suspended' });
      } catch {
        // a record
      }
    }
    return items;
  }

  sweep(): Promise<void> {
    if (this.sweepPromise === undefined) {
      this.sweepPromise = this.doSweep()
        .catch((err) => this.log(`sweep failed: ${errText(err)}`))
        .finally(() => {
          this.sweepDone = true;
        });
    }
    return this.sweepPromise;
  }

  /**
   * S1-6, §2.5: every team of this repository whose lease is stale is taken (H4), its orphaned
   * turns fenced (pid + start time + isOurWorker; the env-marker search for a turn planned but
   * never recorded running, M7) and stopped, its dirty worktrees checkpointed, and it is marked
   * `suspended` and released — `team_resume` is the one way back. Never adopts. This start-up
   * sweep runs once per host; T11 E4 (A20): the same one-team sweep is re-run by team_resume and
   * team_create (sweepStale), so a team whose owner died AFTER this host's start-up sweep is never
   * stuck "active".
   */
  private async doSweep(): Promise<void> {
    await this.sweepStale(await this.repoRoot(), undefined);
  }

  /**
   * E4/E7 (A20, A23): does this listing need the one-team sweep? A team of this repository, not
   * the one led here, with no LIVE owner, that is `active`/`readonly` — or `suspended` while it still
   * holds an open turn (a suspend that could not see a turn end). A live lease is never taken.
   */
  private needsSweep(l: TeamDirListing, root: string | undefined): boolean {
    const lr = l.header?.repoRoot ?? l.state.repoRoot;
    if ((root !== undefined && lr !== root) || (root === undefined && l.header?.workspace !== this.runtime.workspace)) {
      return false;
    }
    if (this.owned !== undefined && !this.owned.dropped && this.owned.teamId === l.teamId) {
      return false;
    }
    const status = l.state.status;
    // a suspend leaves an open turn's member `blocked: unknown-turn` (the projection then drops its
    // `turn`): such a suspended team is confirmed by ONE read of its log before its lease is taken
    const maybeOpen =
      status === 'suspended' &&
      l.state.members.some((m) => m.turn !== undefined || m.state === 'running' || (m.state === 'blocked' && m.reason?.code === 'unknown-turn'));
    if (status !== 'active' && status !== 'readonly' && !maybeOpen) {
      return false;
    }
    if (l.lease !== undefined && this.leaseIsLive(l.lease.hostPid, l.lease.hostStartedAt)) {
      return false;
    }
    return !maybeOpen || this.hasOpenTurn(l.teamId);
  }

  /** Whether a team's log holds a `turn.planned` with no `turn.ended` (a reader's read; false when it cannot be read). */
  private hasOpenTurn(teamId: string): boolean {
    try {
      const opened = this.seams.stores.open(teamId);
      const log = opened.ok ? opened.value.readLog() : undefined;
      if (log === undefined || !log.ok) {
        return false;
      }
      const open = new Set<string>();
      for (const e of log.value.events) {
        if (e.type === 'turn.planned') {
          open.add(e.turnId);
        } else if (e.type === 'turn.ended') {
          open.delete(e.turnId);
        }
      }
      return open.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * The one-team sweep of every team of `root` that needs it (needsSweep) — of all of them, or only
   * of the team named `ref` (an id or a name). Never throws; a team that could not be taken is
   * logged (and remembered when it is `damaged`, with the reason — E11).
   */
  private async sweepStale(root: string | undefined, ref: string | undefined): Promise<void> {
    let listings: TeamDirListing[];
    try {
      listings = this.seams.stores.list();
    } catch {
      return;
    }
    for (const l of listings) {
      if (ref !== undefined && l.teamId !== ref && (l.header?.name ?? l.state.name) !== ref) {
        continue;
      }
      if (!this.needsSweep(l, root)) {
        continue;
      }
      try {
        await this.sweepOneOnce(l.teamId);
      } catch (err) {
        this.log(`sweep of ${l.teamId} failed: ${errText(err)}`);
      }
    }
  }

  /** One sweep per team at a time: the start-up sweep and a team_resume / team_create may meet on one team. */
  private sweepOneOnce(teamId: string): Promise<void> {
    const running = this.sweepsInFlight.get(teamId);
    if (running !== undefined) {
      return running;
    }
    const p = this.sweepOne(teamId).finally(() => {
      this.sweepsInFlight.delete(teamId);
    });
    this.sweepsInFlight.set(teamId, p);
    return p;
  }

  private async sweepOne(teamId: string): Promise<void> {
    if (this.claimedTeam === teamId || (this.owned !== undefined && !this.owned.dropped && this.owned.teamId === teamId)) {
      return;
    }
    const opened = this.seams.stores.open(teamId);
    if (!opened.ok) {
      return;
    }
    const store = opened.value;
    const acquired = await store.acquire();
    if (!acquired.ok) {
      if (acquired.code === 'damaged') {
        this.damagedSeen.set(teamId, flat(acquired.reason));
      }
      this.log(`sweep: ${teamId} not taken (${acquired.code})`);
      return;
    }
    this.damagedSeen.delete(teamId);
    const log = store.readLog();
    if (!log.ok) {
      await store.release('unreadable');
      return;
    }
    const model = new TeamModel();
    for (const e of log.value.events) {
      model.apply(e);
    }
    const wasSuspended = model.status === 'suspended';
    const closed = new Set([...model.turns.values()].filter((t) => t.ended === undefined).map((t) => t.name));
    const { items, blocked } = await this.closeOrphanTurns(model, teamId);
    for (const m of model.members.values()) {
      const until = blocked.get(m.name);
      if (until !== undefined) {
        items.push(this.item({ type: 'member.state', name: m.name, state: 'blocked', reason: { code: 'unknown-turn', text: 'a turn of this member may still be running; it could not be found', until } }));
      } else if (
        m.state === 'running' ||
        m.state === 'pausing' ||
        m.state === 'attach_pending' ||
        m.state === 'attached' ||
        (m.state === 'blocked' && m.reason?.code === 'unknown-turn' && closed.has(m.name))
      ) {
        items.push(this.item({ type: 'member.state', name: m.name, state: m.ready !== undefined ? 'idle' : 'starting' }));
      }
    }
    if (items.length > 0) {
      await store.append(items, { reserve: true });
    }
    for (const m of model.members.values()) {
      if (m.ready === undefined || m.state === 'ended') {
        continue;
      }
      try {
        const cp = await this.seams.worktrees.checkpoint({
          path: m.ready.path,
          branch: m.ready.branch,
          baseCommit: m.ready.baseCommit,
          message: checkpointCommitMessage({ team: model.name, member: m.name, head: '', provider: m.provider, worker: m.worker, model: m.model, heldTasks: model.heldBy(m.name).map((t) => t.id) }),
          ownedPaths: model.heldBy(m.name).flatMap((t) => t.paths),
        });
        if (cp.ok && cp.value.committed) {
          const v = cp.value;
          await store.append(
            [this.item({ type: 'turn.checkpoint', name: m.name, sha: v.sha, filesChanged: v.filesChanged, touched: v.touched, outsideOwnership: v.outsideOwnership, skipped: v.skipped })],
            { reserve: true },
          );
        } else if (!cp.ok) {
          const text = cp.code === 'branch-moved' ? branchMovedText(cp.text, m.ready.path, m.ready.branch) : cp.text;
          await store.append([this.item({ type: 'turn.checkpoint', name: m.name, error: flat(text) })], { reserve: true });
        }
      } catch {
        // the files stay uncommitted
      }
    }
    if (!wasSuspended) {
      const text = TEAM_TEXT.suspendedAfterHostEnded(model.name);
      await store.append(
        [
          ...this.noticeItems(['lead', 'user'], 'suspended', text),
          this.item({ type: 'team.status', status: 'suspended', reason: 'host-ended' }),
        ],
        { reserve: true },
      );
      this.log(text);
    } else {
      this.log(`sweep: the open turns of suspended team ${model.name} were closed`);
    }
    await store.release('host-ended');
  }

  /**
   * §2.5 host-crash row: every `turn.planned` / `turn.running` of `model` without a `turn.ended`.
   * Alive AND its start time within START_SLACK_MS AND isOurWorker → the ladder from SIGTERM →
   * `interrupted reason=engine-restart`; dead or unprovable → `crashed` (no signal). A turn planned
   * but never recorded running (M7): the env-marker search — found and fenced → the ladder; the
   * search cannot run → that member `blocked: unknown-turn` until 2 × the turn timeout after
   * `turn.planned`. Answers the events to append (and the task log's terminal events are written).
   */
  private async closeOrphanTurns(model: TeamModel, teamId: string): Promise<{ items: LogAppend[]; blocked: Map<string, number> }> {
    const items: LogAppend[] = [];
    const settings = this.settings();
    const proc = this.seams.host.process;
    const ladders: Array<Promise<void>> = [];
    const fenced = (pid: number, startedAt: number | undefined, provider: ProviderId): boolean => {
      try {
        if (!proc.isAlive(pid)) {
          return false;
        }
        if (startedAt !== undefined) {
          const seen = proc.startedAt(pid);
          if (seen === undefined || Math.abs(seen - startedAt) > START_SLACK_MS) {
            return false;
          }
        }
        return proc.isOurWorker(pid, provider);
      } catch {
        return false;
      }
    };
    const blocked = new Map<string, number>();
    for (const t of model.turns.values()) {
      if (t.ended !== undefined) {
        continue;
      }
      const m = model.members.get(t.name);
      const provider = m?.provider ?? 'claude';
      let outcome: TurnOutcomeKind = 'crashed';
      let note = 'the host ended; the turn process is gone or could not be proven ours';
      if (t.running !== undefined) {
        if (fenced(t.running.pid, t.running.startedAt, provider)) {
          ladders.push(this.termLadder(t.running.pgid, t.running.pid));
          outcome = 'interrupted';
          note = 'stopped by the next host (engine restart)';
        }
      } else {
        let pids: number[] | undefined;
        try {
          pids = await proc.findByEnvMarker(t.turnId);
        } catch {
          pids = undefined;
        }
        if (pids === undefined) {
          blocked.set(t.name, t.plannedAt + 2 * settings.turnTimeoutMinutes * 60_000);
          note = 'the host ended before the turn was recorded running, and the process search could not run';
        } else {
          const ours = pids.filter((pid) => fenced(pid, undefined, provider));
          for (const pid of ours) {
            ladders.push(this.termLadder(pid, pid));
          }
          if (ours.length > 0) {
            outcome = 'interrupted';
            note = 'stopped by the next host (engine restart)';
          }
        }
      }
      items.push(
        this.item({
          type: 'turn.ended',
          turnId: t.turnId,
          outcome,
          exitCode: null,
          signal: null,
          durationMs: Math.max(0, Date.now() - t.plannedAt),
          tokens: { in: 0, out: 0 },
          text: '',
          textFile: safeTurnFile(this.runtime.dataRoot, t.turnId),
          sawAssistant: false,
          note,
          ...(outcome === 'interrupted' ? { reason: 'engine-restart' as const } : {}),
        }),
      );
      try {
        this.seams.host.taskLog.appendTerminal({
          id: t.turnId,
          ts: Date.now(),
          status: 'error',
          title: TEAM_TEXT.turnTaskTitle(model.name, t.name, t.n),
          worker: m?.worker ?? '',
          model: m?.model ?? '',
          provider,
          outputFile: safeTurnFile(this.runtime.dataRoot, t.turnId),
          error: 'team host ended',
          team: teamId,
          member: t.name,
          turn: t.n,
        });
      } catch {
        // a record
      }
    }
    await Promise.all(ladders);
    return { items, blocked };
  }

  /** The sweep's ladder from SIGTERM (TERM_KILL_LADDER) on a fenced group. */
  private async termLadder(pgid: number, pid: number): Promise<void> {
    const proc = this.seams.host.process;
    try {
      proc.signalGroup(pgid, 'SIGTERM');
    } catch {
      return;
    }
    const until = Date.now() + this.tuning.sweepTermWaitMs;
    while (Date.now() < until) {
      if (!safeAlive(proc, pid)) {
        return;
      }
      await sleep(Math.min(200, this.tuning.sweepTermWaitMs));
    }
    try {
      proc.signalGroup(pgid, 'SIGKILL');
    } catch {
      // gone
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: the lead's inbox and doorbell (§4.4)
   * ------------------------------------------------------------------------- */

  inbox(reader: 'lead' | 'user', capChars: number, all: boolean): InboxPage {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return { text: TEAM_TEXT.noTeam(), shown: [], remaining: 0 };
    }
    try {
      const budget = inboxBudgetChars(Number.isFinite(capChars) && capChars > 0 ? capChars : 30_000);
      const fence = newFenceId();
      const unread = all
        ? [...o.model.messages.values()].filter((m) => m.to === reader).slice(-INBOX_ALL_MAX)
        : o.model.unreadFor(reader);
      if (unread.length === 0) {
        return { text: TEAM_TEXT.inboxEmpty(o.model.name), shown: [], remaining: 0 };
      }
      const tail = [
        '',
        TEAM_TEXT.inboxMembersLine(this.membersLineParts(o)),
        TEAM_TEXT.inboxAnswerHint(),
        TEAM_TEXT.inboxNotInstructions(),
      ];
      const header = all ? TEAM_TEXT.inboxAllHeader(o.model.name, unread.length) : TEAM_TEXT.inboxHeader(o.model.name, unread.length);
      const blocks: string[] = [];
      const shown: string[] = [];
      let used = header.length + tail.join('\n').length + 80;
      let lastSeq: number | undefined;
      for (const msg of unread) {
        const block = this.inboxBlock(o, msg, fence);
        if (used + block.length + 2 > budget) {
          if (blocks.length === 0) {
            // one message must still be shown: cut to what fits
            const room = Math.max(200, budget - used - 2);
            blocks.push(cutBytes(block, room));
            shown.push(messageIdOf(msg.seq));
            lastSeq = msg.seq;
          }
          break;
        }
        blocks.push(block);
        shown.push(messageIdOf(msg.seq));
        used += block.length + 2;
        lastSeq = msg.seq;
      }
      const remaining = unread.length - shown.length;
      const parts = [header, '', blocks.join('\n\n')];
      if (remaining > 0) {
        parts.push('', TEAM_TEXT.inboxMore(remaining));
      }
      parts.push(...tail);
      if (!all && lastSeq !== undefined) {
        this.markReadNow(o, reader, lastSeq);
      }
      return { text: parts.join('\n'), shown, remaining, ...(!all && lastSeq !== undefined ? { readThrough: lastSeq } : {}) };
    } catch (err) {
      this.log(`inbox failed: ${errText(err)}`);
      return { text: TEAM_TEXT.inboxEmpty(o.model.name), shown: [], remaining: 0 };
    }
  }

  private inboxBlock(o: Owned, msg: MsgPostedEvent, fence: string): string {
    let body = this.messageBody(o, msg);
    if (bytesOf(body) > INBOX_MESSAGE_CUT_BYTES) {
      body = `${cutBytes(body, INBOX_MESSAGE_CUT_BYTES)}\n${TEAM_TEXT.inboxCut(messageIdOf(msg.seq))}`;
    }
    const header = TEAM_TEXT.inboxMessageHeader(messageIdOf(msg.seq), msg.from, msg.kind, msg.ts, {
      ...(msg.report !== undefined
        ? { report: { n: msg.report.n, outcome: msg.report.outcome, durationMs: msg.report.durationMs, tokens: msg.report.tokens }, tasks: msg.report.tasks }
        : msg.task !== undefined
          ? { tasks: [msg.task] }
          : {}),
    });
    return [header, fenceOpenLine(fence), quoteFenceLines(body), fenceCloseLine(fence)].join('\n');
  }

  private membersLineParts(o: Owned): string[] {
    const now = Date.now();
    return [...o.model.members.values()]
      .filter((m) => m.state !== 'ended')
      .map((m) => {
        const turn = o.members.get(m.name)?.turn;
        if (turn !== undefined) {
          return `${m.name} running turn ${turn.n} (${Math.max(0, Math.round((now - turn.startedAt) / 60_000))}m)`;
        }
        if (m.state === 'blocked' || (m.state === 'paused' && m.reason !== undefined)) {
          return `${m.name} ${m.state}: ${flat(m.reason?.text ?? '', 120)}`;
        }
        return `${m.name} ${m.state}`;
      });
  }

  markRead(reader: 'lead' | 'user', upToSeq: number): void {
    const o = this.owned;
    if (o === undefined || o.dropped || !Number.isInteger(upToSeq) || upToSeq <= o.model.read[reader]) {
      return;
    }
    this.markReadNow(o, reader, Math.min(upToSeq, o.model.seq));
  }

  private markReadNow(o: Owned, reader: 'lead' | 'user', upToSeq: number): void {
    if (upToSeq <= o.model.read[reader]) {
      return;
    }
    // The fold advances when the event is durable; the in-memory mark moves now so a second read
    // in the same tick does not show the same messages again.
    o.model.read[reader] = Math.max(o.model.read[reader], upToSeq);
    void this.exclusive(() => this.append([this.item({ type: 'msg.read', upToSeq }, reader)]));
  }

  waitForLead(signal: AbortSignal, settleMs: number): Promise<'woken' | 'aborted'> {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return Promise.reject(teamRefusal('no_team', TEAM_TEXT.noTeam()));
    }
    if (o.suspending || this.suspendPromise !== undefined) {
      return Promise.reject(teamRefusal('suspending', TEAM_TEXT.suspending()));
    }
    if (o.waiter !== undefined) {
      return Promise.reject(teamRefusal('already_waiting', TEAM_TEXT.teamWaitAlreadyRunning(o.model.name)));
    }
    o.lastCallAt = Date.now();
    return new Promise<'woken' | 'aborted'>((resolve) => {
      let settleTimer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        const w = o.waiter;
        if (w === undefined) {
          return;
        }
        o.waiter = undefined;
        w.cleanup();
        this.touchState();
        resolve(w.settling ? 'woken' : 'aborted');
      };
      const cleanup = (): void => {
        if (settleTimer !== undefined) {
          clearTimeout(settleTimer);
        }
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // never throws
        }
      };
      o.waiter = {
        resolve: (v) => resolve(v),
        settleMs: Math.max(0, Number.isFinite(settleMs) ? settleMs : 0),
        settling: false,
        cleanup: () => cleanup(),
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
      this.touchState();
      const w = o.waiter;
      (w as { start?: (t: NodeJS.Timeout) => void }).start = (t) => {
        settleTimer = t;
      };
      this.wakeWaiter(o);
    });
  }

  /** A wake-worthy unread message exists → the settle window, then `woken` (M11). */
  private wakeWaiter(o: Owned): void {
    const w = o.waiter;
    if (w === undefined || w.settling) {
      return;
    }
    const worthy = o.model.unreadFor('lead').some((m) => o.wakeFlags.get(m.seq) === true);
    if (!worthy) {
      return;
    }
    w.settling = true;
    const finish = (): void => {
      if (o.waiter !== w) {
        return;
      }
      o.waiter = undefined;
      w.cleanup();
      o.wakes.push(Date.now());
      this.touchState();
      w.resolve('woken');
    };
    const t = setTimeout(finish, w.settleMs);
    (w as { start?: (t: NodeJS.Timeout) => void }).start?.(t);
  }

  footerCounts(): { unread: number; senders: string[] } | undefined {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return undefined;
    }
    try {
      const unread = o.model.unreadFor('lead');
      if (unread.length === 0) {
        return undefined;
      }
      const senders: string[] = [];
      for (const m of unread) {
        if (!senders.includes(m.from)) {
          senders.push(m.from);
        }
      }
      return { unread: unread.length, senders };
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: the member's tools (§3.7)
   * ------------------------------------------------------------------------- */

  memberTool(member: string, tool: TeamTool, args: unknown): Promise<TextResult> {
    return this.exclusive(() => this.doMemberTool(member, tool, args)).catch((err) => {
      this.log(`member tool failed: ${errText(err)}`);
      return textResult(`internal error: ${errText(err)}`, true);
    });
  }

  private checkArgs(args: unknown, allowed: Record<string, 'string'>, required: string[]): TextResult | Record<string, string> {
    const a = args === undefined || args === null ? {} : args;
    if (!isPlainObject(a)) {
      return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments('arguments', 'must be an object'));
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(a)) {
      if (!(k in allowed)) {
        return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments(flat(k, 40), 'is not an argument of this tool'));
      }
      if (typeof v !== 'string') {
        return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments(k, 'must be a string'));
      }
      out[k] = v;
    }
    for (const k of required) {
      if (out[k] === undefined) {
        return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments(k, 'is required'));
      }
    }
    return out;
  }

  private withFooter(o: Owned, member: string, turn: TurnRt, text: string): TextResult {
    const n = this.unseenFor(o, member, turn).length;
    return textResult(n > 0 ? `${text}\n\n${TEAM_TOOL_TEXT.unreadFooter(n)}` : text);
  }

  /** Pending messages not in this turn's prompt and not yet returned by a team_inbox call in it. */
  private unseenFor(o: Owned, member: string, turn: TurnRt): MsgPostedEvent[] {
    const shown = new Set<number>([...turn.deliver, ...turn.toolPulls.flatMap((p) => p.seqs)]);
    return o.model.pendingFor(member).filter((p) => !shown.has(p.seq));
  }

  private async doMemberTool(member: string, tool: TeamTool, args: unknown): Promise<TextResult> {
    const o = this.owned;
    if (o === undefined || o.dropped || o.suspending) {
      return toolRefusal('team_gone', TEAM_TOOL_TEXT.teamGone());
    }
    const m = o.model.members.get(member);
    const turn = o.members.get(member)?.turn;
    if (m === undefined || turn === undefined) {
      return textResult(TEAM_TOOL_TEXT.turnEnded(), true);
    }
    if (o.model.status !== 'active' && o.model.status !== 'readonly') {
      return toolRefusal('team_not_active', TEAM_TOOL_TEXT.teamNotActive(o.model.name, o.model.status));
    }
    let result: TextResult;
    switch (tool) {
      case 'team_board':
        result = this.toolBoard(o, m, turn, args);
        break;
      case 'team_inbox':
        result = this.toolInbox(o, m, turn, args);
        break;
      case 'team_send':
        result = await this.toolSend(o, m, turn, args);
        break;
      case 'team_claim':
        result = await this.toolClaim(o, m, turn, args);
        break;
      case 'team_update':
        result = await this.toolUpdate(o, m, turn, args);
        break;
      default:
        result = toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments('tool', 'is not a team tool'));
    }
    if (result.isError !== true) {
      turn.toolsOk = true;
    }
    return result;
  }

  private boardBody(o: Owned, t: BoardTask): string {
    if (t.body !== undefined) {
      return t.body;
    }
    if (t.bodyFile !== undefined) {
      const r = o.store.readFile(t.bodyFile, TOOL_BOARD_TASK_MAX_BYTES + 1024);
      return r.ok ? r.value : `(the body could not be read: ${r.reason})`;
    }
    return '';
  }

  private toolBoard(o: Owned, m: MemberModel, turn: TurnRt, args: unknown): TextResult {
    const a = this.checkArgs(args, { task_id: 'string' }, []);
    if ('content' in a) {
      return a as TextResult;
    }
    if (a.task_id !== undefined) {
      const t = o.model.board.get(a.task_id);
      if (t === undefined) {
        return toolRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(a.task_id, 20)));
      }
      const lines = [boardLine(t), '', this.boardBody(o, t)];
      if (t.note !== undefined) {
        lines.push('', `Note: ${t.note}`);
      }
      for (const r of t.reports) {
        const text = o.store.readFile(r.file, REPORT_MAX_BYTES + 1024);
        lines.push('', `Report by ${r.by} (${clockHHMM(r.at)}):`, text.ok ? text.value : '(unreadable)');
      }
      return this.withFooter(o, m.name, turn, cutBytes(lines.join('\n'), TOOL_BOARD_TASK_MAX_BYTES));
    }
    const wt = m.ready ?? m.plan;
    const head = [
      `team ${o.model.name} — goal: ${firstChars(this.goalText(o), 600)}`,
      `You: ${m.name} · ${m.role} · cwd ${wt?.path ?? '(not ready)'} · branch ${wt?.branch ?? ''}`,
      'Roster:',
      ...[...o.model.members.values()].filter((x) => x.state !== 'ended').map((x) => `  ${x.name} · ${x.role} · ${x.provider} · ${x.state}`),
      'Board:',
    ];
    const tasks = [...o.model.board.values()];
    const order: TaskState[] = ['open', 'claimed', 'blocked', 'review', 'done', 'cancelled'];
    for (const s of order) {
      for (const t of tasks.filter((x) => x.state === s)) {
        head.push(`  ${boardLine(t)}`);
      }
    }
    const own: string[] = [];
    const others: string[] = [];
    for (const t of tasks) {
      if (t.state === 'done' || t.state === 'cancelled') {
        continue;
      }
      const body = this.boardBody(o, t);
      if (body === '') {
        continue;
      }
      if (t.assignee === m.name) {
        own.push(`${t.id}:\n${body}`);
      } else {
        const cut = [...body].length > TOOL_BOARD_OTHER_BODY_CHARS ? `${[...body].slice(0, TOOL_BOARD_OTHER_BODY_CHARS).join('')} ${TEAM_TOOL_TEXT.bodyCut(bytesOf(body))}` : body;
        others.push(`${t.id}:\n${cut}`);
      }
    }
    let text = [...head, '--- bodies ---', ...others, ...own].join('\n');
    if (bytesOf(text) > TOOL_BOARD_MAX_BYTES) {
      // own bodies are cut first when the cap binds (§3.7)
      const ownCut = own.map((b) => `${firstChars(b, 300)} ${TEAM_TOOL_TEXT.boardBodyCut()}`);
      text = [...head, '--- bodies ---', ...others, ...ownCut].join('\n');
      text = cutBytes(text, TOOL_BOARD_MAX_BYTES);
    }
    return this.withFooter(o, m.name, turn, text);
  }

  private toolInbox(o: Owned, m: MemberModel, turn: TurnRt, args: unknown): TextResult {
    const a = this.checkArgs(args, {}, []);
    if ('content' in a) {
      return a as TextResult;
    }
    turn.inboxCalls++;
    const unseen = this.unseenFor(o, m.name, turn);
    if (unseen.length === 0) {
      return textResult(turn.inboxCalls > TOOL_INBOX_POLLS_MAX ? TEAM_TOOL_TEXT.inboxStopPolling() : TEAM_TOOL_TEXT.inboxEmpty());
    }
    const fence = newFenceId();
    const blocks: string[] = [];
    const seqs: number[] = [];
    let used = 0;
    for (const msg of unseen) {
      if (seqs.length >= TOOL_INBOX_MAX_MESSAGES) {
        break;
      }
      const block = [
        fenceOpenLine(fence, TEAM_TURN_TEXT.messageFenceHeader(messageIdOf(msg.seq), msg.from, msg.kind, clockHHMM(msg.ts), { task: msg.task, resent: m.attempted.has(msg.seq) })),
        quoteFenceLines(this.messageBody(o, msg)),
        fenceCloseLine(fence),
      ].join('\n');
      const size = bytesOf(block);
      if (seqs.length > 0 && used + size > TOOL_INBOX_MAX_BYTES) {
        break;
      }
      blocks.push(seqs.length === 0 && size > TOOL_INBOX_MAX_BYTES ? cutBytes(block, TOOL_INBOX_MAX_BYTES) : block);
      seqs.push(msg.seq);
      used += size;
    }
    // H3: delivered only if the model acts after this answer (assistantAfter at turn.ended).
    turn.toolPulls.push({ seqs, ts: Date.now() });
    const rest = unseen.length - seqs.length;
    const text = blocks.join('\n\n') + (rest > 0 ? `\n\n${TEAM_TOOL_TEXT.inboxMore(rest)}` : '');
    return textResult(text);
  }

  private async toolSend(o: Owned, m: MemberModel, turn: TurnRt, args: unknown): Promise<TextResult> {
    const a = this.checkArgs(args, { to: 'string', text: 'string', kind: 'string', reply_to: 'string', task: 'string' }, ['to', 'text']);
    if ('content' in a) {
      return a as TextResult;
    }
    if (o.model.status === 'readonly') {
      return toolRefusal('team_readonly', TEAM_TEXT.teamReadonly(o.model.name));
    }
    const to = a.to;
    const names = [...o.model.members.keys()];
    if (to === 'all') {
      return toolRefusal('not_allowed', TEAM_TOOL_TEXT.notAllowedAll());
    }
    if (to === m.name) {
      return toolRefusal('not_allowed', TEAM_TOOL_TEXT.notAllowedSelf());
    }
    if (to !== 'lead' && to !== 'user' && !o.model.members.has(to)) {
      return toolRefusal('unknown_recipient', TEAM_TOOL_TEXT.unknownRecipient(flat(to, 40), names.filter((n) => n !== m.name)));
    }
    const target = o.model.members.get(to);
    if (target !== undefined && (target.state === 'stopped' || target.state === 'ended')) {
      return toolRefusal('not_allowed', TEAM_TOOL_TEXT.notAllowedStopped(to, target.state));
    }
    const norm = normalizeMessageText(a.text);
    if (!norm.ok) {
      return norm.code === 'empty_message'
        ? toolRefusal('empty_message', TEAM_TOOL_TEXT.emptyMessage())
        : norm.code === 'message_too_large'
          ? toolRefusal('message_too_large', TEAM_TOOL_TEXT.messageTooLarge(norm.bytes ?? 0))
          : toolRefusal('invalid_text', TEAM_TOOL_TEXT.invalidText());
    }
    if (a.kind !== undefined && !(['text', 'question', 'answer'] as string[]).includes(a.kind)) {
      return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments('kind', 'must be text, question or answer'));
    }
    if (a.reply_to !== undefined && !o.model.repliable(a.reply_to, m.name)) {
      return toolRefusal('unknown_message', TEAM_TOOL_TEXT.unknownMessage(flat(a.reply_to, 20)));
    }
    if (a.task !== undefined && !o.model.board.has(a.task)) {
      return toolRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(a.task, 20)));
    }
    const rt = this.memberRt(m.name);
    const now = Date.now();
    rt.sendTimes = rt.sendTimes.filter((t) => now - t < 3_600_000);
    if (turn.sends >= MEMBER_SENDS_PER_TURN) {
      return toolRefusal('rate_limited', TEAM_TOOL_TEXT.rateLimitedTurn());
    }
    if (rt.sendTimes.length >= MEMBER_SENDS_PER_HOUR) {
      return toolRefusal('rate_limited', TEAM_TOOL_TEXT.rateLimitedHour());
    }
    const sha = bodySha256(norm.text);
    const dupKey = duplicateKeyOf(m.name, to, a.reply_to, a.task, sha);
    if (norm.bytes >= DUPLICATE_MIN_BYTES) {
      const earlier = o.dupes.get(dupKey);
      if (earlier !== undefined && now - earlier.at < DUPLICATE_WINDOW_MEMBER) {
        return toolRefusal('duplicate', TEAM_TOOL_TEXT.duplicate(messageIdOf(earlier.seq)));
      }
    }
    if (target !== undefined && o.model.pendingFor(to).length >= PENDING_MAX) {
      return toolRefusal('inbox_full', TEAM_TOOL_TEXT.inboxFull(to, target.state));
    }
    const kind = (a.kind ?? 'text') as MessageKind;
    const items: LogAppend[] = [
      this.msgItem(m.name, to, kind, norm.text, { source: 'tool', ...(a.reply_to !== undefined ? { re: a.reply_to } : {}), ...(a.task !== undefined ? { task: a.task } : {}) }, `member:${m.name}`),
    ];
    const r = await this.append(items);
    if (!r.ok) {
      return toolRefusal(r.code === 'log-full' ? 'team_readonly' : 'team_not_active', r.code === 'log-full' ? TEAM_TEXT.teamReadonly(o.model.name) : TEAM_TEXT.storeFailed(storeErrno(r)));
    }
    const msgId = messageIdOf(r.value[0].seq);
    turn.sends++;
    rt.sendTimes.push(now);
    if (norm.bytes >= DUPLICATE_MIN_BYTES) {
      o.dupes.set(dupKey, { seq: r.value[0].seq, at: now });
    }
    if (to === 'user') {
      await this.notice(['lead'], 'message', TEAM_NOTICE.memberWroteUser(m.name, msgId));
    }
    // §3.5.1: the team breaker — 12 consecutive member→member messages with no lead/user message.
    if (target !== undefined && o.model.peerStreak >= PINGPONG_THRESHOLD && !o.model.pingPongTripped) {
      await this.append([
        this.item({ type: 'budget.tripped', kind: 'pingpong' }),
        ...this.noticeItems(
          ['lead', 'user'],
          'budget',
          `Teammates have sent ${o.model.peerStreak} messages to each other without a message from you or the user; messages between teammates now wait for one from you or the user.`,
        ),
      ]);
    }
    let text: string;
    if (to === 'lead' || to === 'user') {
      text = TEAM_TOOL_TEXT.sentInbox(msgId, to);
    } else {
      const trt = this.memberRt(to);
      const st = target?.state ?? 'idle';
      if (trt.turn !== undefined || trt.starting || st === 'running') {
        text = TEAM_TOOL_TEXT.sentBusy(msgId, to);
      } else if (st === 'idle' && trt.peerWakes < PEER_WAKE_BUDGET && !o.model.pingPongTripped) {
        text = TEAM_TOOL_TEXT.sentStarts(msgId, to);
        this.poke(0);
      } else {
        const why = target?.reason !== undefined ? `${target.reason.text}${target.reason.until !== undefined ? ` until ${clockHHMM(target.reason.until)}` : ''}` : st === 'idle' ? 'teammate wakes are paused' : undefined;
        text = TEAM_TOOL_TEXT.sentWaits(msgId, to, st, why);
      }
    }
    return this.withFooter(o, m.name, turn, text);
  }

  private async toolClaim(o: Owned, m: MemberModel, turn: TurnRt, args: unknown): Promise<TextResult> {
    const a = this.checkArgs(args, { task_id: 'string' }, ['task_id']);
    if ('content' in a) {
      return a as TextResult;
    }
    if (o.model.status === 'readonly') {
      return toolRefusal('team_readonly', TEAM_TEXT.teamReadonly(o.model.name));
    }
    const t = o.model.board.get(a.task_id);
    if (t === undefined) {
      return toolRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(a.task_id, 20)));
    }
    if (t.state !== 'open') {
      return toolRefusal('not_open', TEAM_TOOL_TEXT.notOpen(t.id, t.state, t.assignee));
    }
    const held = o.model.heldBy(m.name);
    if (held.length >= CLAIMS_ACTIVE_MAX) {
      return toolRefusal('claim_limit', TEAM_TOOL_TEXT.claimLimit(held.map((x) => x.id)));
    }
    if (!t.allowOverlap) {
      for (const other of o.model.board.values()) {
        if (other.id === t.id || other.allowOverlap || other.assignee === undefined || other.assignee === m.name) {
          continue;
        }
        if (other.state !== 'claimed' && other.state !== 'blocked') {
          continue;
        }
        for (const p of t.paths) {
          if (other.paths.some((q) => pathsOverlap(p, q))) {
            return toolRefusal('paths_conflict', TEAM_TOOL_TEXT.pathsConflict(t.id, p, other.id, other.assignee, other.state));
          }
        }
      }
    }
    const r = await this.append([this.item({ type: 'board.updated', id: t.id, changes: { state: 'claimed', assignee: m.name } }, `member:${m.name}`)]);
    if (!r.ok) {
      return toolRefusal('team_not_active', TEAM_TEXT.storeFailed(storeErrno(r)));
    }
    turn.boardTouched = true;
    const rt = this.memberRt(m.name);
    rt.peerWakes = 0;
    rt.peerNoticed = false;
    return this.withFooter(o, m.name, turn, TEAM_TOOL_TEXT.claimed(t.id, t.title, t.paths));
  }

  private async toolUpdate(o: Owned, m: MemberModel, turn: TurnRt, args: unknown): Promise<TextResult> {
    const a = this.checkArgs(args, { task_id: 'string', state: 'string', note: 'string', report: 'string' }, ['task_id', 'state']);
    if ('content' in a) {
      return a as TextResult;
    }
    if (o.model.status === 'readonly') {
      return toolRefusal('team_readonly', TEAM_TEXT.teamReadonly(o.model.name));
    }
    const t = o.model.board.get(a.task_id);
    if (t === undefined) {
      return toolRefusal('unknown_task', TEAM_TOOL_TEXT.unknownTask(flat(a.task_id, 20)));
    }
    if (t.assignee !== m.name || !(t.state === 'claimed' || t.state === 'blocked' || t.state === 'review')) {
      return toolRefusal('not_your_task', TEAM_TOOL_TEXT.notYourTask(t.id));
    }
    if (!(MEMBER_UPDATE_STATES as readonly string[]).includes(a.state)) {
      return toolRefusal('invalid_arguments', TEAM_TOOL_TEXT.invalidArguments('state', 'must be open, blocked, claimed or review'));
    }
    const to = a.state as TaskState;
    const move = BOARD_TRANSITIONS[t.state][to]?.assignee;
    if (move === undefined) {
      return toolRefusal('invalid_transition', TEAM_TOOL_TEXT.invalidTransition(t.id, t.state, allowedBoardTargets(t.state, 'assignee')));
    }
    if (move.needs === 'report' && (a.report === undefined || a.report.trim() === '')) {
      return toolRefusal('report_required', TEAM_TOOL_TEXT.reportRequired());
    }
    if (move.needs === 'note' && (a.note === undefined || a.note.trim() === '')) {
      return toolRefusal('reason_required', TEAM_TOOL_TEXT.reasonRequired());
    }
    if (a.report !== undefined && bytesOf(a.report) > REPORT_MAX_BYTES) {
      return toolRefusal('report_too_large', TEAM_TOOL_TEXT.reportTooLarge(bytesOf(a.report)));
    }
    if (a.note !== undefined && bytesOf(a.note) > NOTE_MAX_BYTES) {
      return toolRefusal('note_too_large', TEAM_TOOL_TEXT.noteTooLarge(bytesOf(a.note)));
    }
    let reportFile: string | undefined;
    if (a.report !== undefined && a.report.trim() !== '') {
      const rel = `bodies/${t.id}-r${t.reports.length + 1}.md`;
      const w = o.store.writeFile(rel, a.report);
      if (!w.ok) {
        return toolRefusal('team_not_active', TEAM_TEXT.storeFailed(storeErrno(w)));
      }
      reportFile = rel;
    }
    const items: LogAppend[] = [
      this.item(
        {
          type: 'board.updated',
          id: t.id,
          changes: { state: to, ...(to === 'open' ? { assignee: null } : {}) },
          ...(a.note !== undefined ? { note: a.note } : {}),
          ...(reportFile !== undefined ? { reportFile } : {}),
        },
        `member:${m.name}`,
      ),
    ];
    if (to === 'review') {
      items.push(...this.noticeItems(['lead'], 'board', `${m.name} moved ${t.id} "${t.title}" to review: ${firstChars(a.report ?? '', REPORT_NOTICE_CHARS)}`));
    } else if (to === 'blocked') {
      items.push(...this.noticeItems(['lead'], 'blocked', `${m.name} is blocked on ${t.id} "${t.title}": ${firstChars(a.note ?? '', REPORT_NOTICE_CHARS)}`));
    }
    const r = await this.append(items);
    if (!r.ok) {
      return toolRefusal('team_not_active', TEAM_TEXT.storeFailed(storeErrno(r)));
    }
    turn.boardTouched = true;
    const rt = this.memberRt(m.name);
    rt.peerWakes = 0;
    rt.peerNoticed = false;
    return this.withFooter(o, m.name, turn, TEAM_TOOL_TEXT.updated(t.id, to));
  }

  memberConnection(member: string, conn: ConnId, open: boolean): void {
    const o = this.owned;
    if (o === undefined) {
      return;
    }
    const rt = o.members.get(member);
    if (rt === undefined) {
      return;
    }
    if (open) {
      rt.connections.add(conn);
    } else {
      rt.connections.delete(conn);
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: take-over (§3.10, Claude members only)
   * ------------------------------------------------------------------------- */

  takeover(member: string, now: boolean, by: Actor, conn: ConnId): Promise<Result<TakeoverPlan>> {
    return this.guarded(async () => {
      const pre = await this.exclusive(() => this.takeoverCheck(member, now, by));
      if ('ok' in pre) {
        return pre;
      }
      if (pre.wait !== undefined) {
        await pre.wait;
      }
      return this.exclusive(() => this.takeoverGrant(member, by, conn));
    });
  }

  private takeoverCheck(member: string, now: boolean, by: Actor): TeamRefusal | { wait?: Promise<void> } {
    const o = this.leading({ mutate: by === 'user' });
    if ('ok' in o) {
      return o;
    }
    const m = o.model.members.get(member);
    if (m === undefined) {
      const names = [...o.model.members.keys()];
      return teamRefusal('unknown_member', TEAM_TEXT.unknownMember(flat(member, 40), o.model.name, names, closest(member, names)));
    }
    if (m.provider !== 'claude') {
      return teamRefusal('not_supported', TEAM_TEXT.takeoverNotSupported(m.name, m.provider));
    }
    if (m.conversationId === undefined || !m.conversationStarted) {
      return teamRefusal('no_conversation', TEAM_TEXT.noConversation(m.name));
    }
    const rt = this.memberRt(member);
    if (rt.attach !== undefined || m.state === 'attached' || m.state === 'attach_pending') {
      return teamRefusal('already_attached', TEAM_TEXT.alreadyAttached(m.name, rt.attach?.client || 'the user', rt.attach?.since ?? Date.now()));
    }
    if (by === 'lead') {
      return {};
    }
    if (rt.turn !== undefined) {
      if (!now) {
        return teamRefusal('member_running', TEAM_TEXT.memberRunning(m.name, rt.turn.n));
      }
      this.stopTurn(rt.turn, 'takeover');
      return { wait: rt.turn.done };
    }
    if (!(m.state === 'idle' || m.state === 'paused' || m.state === 'blocked')) {
      return teamRefusal('not_live', TEAM_TEXT.notLive(m.name, m.state));
    }
    return {};
  }

  private async takeoverGrant(member: string, by: Actor, conn: ConnId): Promise<Result<TakeoverPlan>> {
    const o = this.leading({ mutate: false });
    if ('ok' in o) {
      return o;
    }
    const m = o.model.members.get(member);
    if (m === undefined || m.conversationId === undefined || m.ready === undefined) {
      return teamRefusal('no_conversation', TEAM_TEXT.noConversation(member));
    }
    const worker = this.workerByName(m.worker);
    const terminal = worker !== undefined ? this.seams.host.claudeTakeover(worker.configDir) : undefined;
    if (worker === undefined || terminal === undefined) {
      return teamRefusal('not_live', TEAM_TEXT.notLive(member, 'without a claude command'));
    }
    const lease = by === 'user' ? newAttachLease() : '';
    const set: Record<string, string> = {};
    const unset: string[] = [...SESSION_IDENTITY_ENV];
    for (const [k, v] of Object.entries(terminal.env)) {
      if (v === null) {
        if (!unset.includes(k)) {
          unset.push(k);
        }
      } else {
        set[k] = v;
      }
    }
    set[TEAM_MEMBER_ENV] = teamMemberEnvValue(o.teamId, member, m.incarnation);
    if (by === 'user') {
      set[DISPATCHED_TASK_ENV] = attachDispatchedTaskValue(lease);
    }
    const plan: TakeoverPlan = {
      lease,
      command: terminal.command,
      args: ['--resume', m.conversationId],
      cwd: m.ready.cwd,
      env: { set, unset: unset.filter((k) => !(k in set)) },
      title: TEAM_TEXT.takeoverTitle(o.model.name, member),
      note: TEAM_TEXT.takeoverNote(m.ready.path),
    };
    if (by === 'lead') {
      return okResult(plan);
    }
    const cp = await this.gitCheckpoint(o, member, undefined, '');
    await this.recordCheckpoint(o, member, undefined, cp);
    const r = await this.append([
      this.item({ type: 'attach.granted', lease, name: member, command: plan.command, args: plan.args, cwd: plan.cwd, envKeys: Object.keys(set) }, 'user'),
      this.stateItem(member, 'attach_pending'),
    ]);
    if (!r.ok) {
      return this.storeRefusal(o, r);
    }
    const rt = this.memberRt(member);
    const since = Date.now();
    rt.attach = { lease, conn, since, client: 'vscode' };
    // a grant with no `attached` within 60 s expires (§3.10 step 4)
    rt.attach.timer = setTimeout(() => {
      void this.exclusive(async () => {
        if (rt.attach?.lease === lease && rt.attach.pid === undefined) {
          await this.endAttach(o, member, lease, 'never-started');
        }
      });
    }, this.tuning.attachStartGraceMs);
    return okResult(plan);
  }

  attached(lease: string, pid: number): Result<void> {
    const o = this.owned;
    if (o === undefined || o.dropped) {
      return teamRefusal('no_team', TEAM_TEXT.noTeam());
    }
    const entry = [...o.members.entries()].find(([, rt]) => rt.attach?.lease === lease);
    if (entry === undefined || !Number.isInteger(pid) || pid <= 0) {
      return teamRefusal('unknown_lease', TEAM_TEXT.unknownLease());
    }
    const [member, rt] = entry;
    const attach = rt.attach;
    if (attach === undefined) {
      return teamRefusal('unknown_lease', TEAM_TEXT.unknownLease());
    }
    if (attach.timer !== undefined) {
      clearTimeout(attach.timer);
    }
    attach.pid = pid;
    let startedAt = Date.now();
    try {
      startedAt = this.seams.host.process.startedAt(pid) ?? startedAt;
    } catch {
      // the spawn time stands in
    }
    attach.startedAt = startedAt;
    void this.exclusive(() => this.append([this.item({ type: 'attach.started', lease, pid, startedAt }, 'user'), this.stateItem(member, 'attached')]));
    attach.timer = setInterval(() => {
      if (!safeAlive(this.seams.host.process, pid)) {
        if (attach.timer !== undefined) {
          clearInterval(attach.timer);
        }
        void this.exclusive(() => this.endAttach(o, member, lease, 'exited'));
      }
    }, this.tuning.attachWatchMs);
    return okResult(undefined);
  }

  release(lease: string, reason: string): Promise<Result<void>> {
    return this.guarded(() =>
      this.exclusive(async () => {
        const o = this.owned;
        if (o === undefined || o.dropped) {
          return teamRefusal('no_team', TEAM_TEXT.noTeam());
        }
        const entry = [...o.members.entries()].find(([, rt]) => rt.attach?.lease === lease);
        if (entry === undefined) {
          return teamRefusal('unknown_lease', TEAM_TEXT.unknownLease());
        }
        const [member, rt] = entry;
        if (rt.attach?.pid !== undefined && safeAlive(this.seams.host.process, rt.attach.pid)) {
          return teamRefusal('still_attached', TEAM_TEXT.stillAttached(member, rt.attach.pid));
        }
        await this.endAttach(o, member, lease, flat(reason || 'release', 60));
        return okResult(undefined);
      }),
    );
  }

  private async endAttach(o: Owned, member: string, lease: string, reason: string): Promise<void> {
    const rt = this.memberRt(member);
    if (rt.attach?.lease !== lease) {
      return;
    }
    if (rt.attach.timer !== undefined) {
      clearTimeout(rt.attach.timer);
      clearInterval(rt.attach.timer);
    }
    rt.attach = undefined;
    await this.append([this.item({ type: 'attach.ended', lease, reason }), this.stateItem(member, 'idle')], { reserve: true, hold: true });
    if (this.owned === o) {
      this.poke(0);
    }
  }

  /* ------------------------------------------------------------------------- *
   * TeamCore: the turn ownership questions (H2, §7.9 step 5)
   * ------------------------------------------------------------------------- */

  ownsTurn(taskId: string): boolean {
    const o = this.owned;
    if (o === undefined || typeof taskId !== 'string') {
      return false;
    }
    for (const rt of o.members.values()) {
      if (rt.turn?.turnId === taskId) {
        return true;
      }
    }
    return false;
  }

  cancelTurn(taskId: string): Promise<string> {
    const o = this.owned;
    if (o !== undefined) {
      for (const rt of o.members.values()) {
        if (rt.turn?.turnId === taskId) {
          this.stopTurn(rt.turn, 'cancel');
          return Promise.resolve(TEAM_TEXT.cancelTeamTurn(taskId, rt.turn.member));
        }
      }
      const ended = o.recentEnded.get(taskId);
      if (ended !== undefined) {
        return Promise.resolve(`${flat(taskId, 40)}: already ${ended === 'ok' ? 'done' : 'error'}`);
      }
    }
    return Promise.resolve(`${flat(taskId, 40)}: already done`);
  }
}

function safeNumber(fn: () => number | undefined): number | undefined {
  try {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
function safeReset(fn: () => { until: number; window: string } | undefined): { until: number; window: string } | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
function safeAlive(proc: TeamCoreHost['process'], pid: number): boolean {
  try {
    return proc.isAlive(pid);
  } catch {
    return true;
  }
}
function safeTurnFile(dataRoot: string, turnId: string): string {
  try {
    return turnTextFileOf(dataRoot, turnId);
  } catch {
    return path.join(dataRoot, 'tasks', `${turnId}.md`);
  }
}

/* ------------------------------------------------------------------------- *
 * Factories
 * ------------------------------------------------------------------------- */

/** The core over explicit seams — what the offline harness and createTeamCore both use. */
export function createTeamCoreWith(runtime: TeamRuntime, seams: TeamCoreSeams): TeamCore {
  return new Core(runtime, seams);
}

/**
 * The real host seam: the registry, the usage cache, dispatch's selection (pickWorkerLive), the
 * task log, recordTurnBookkeeping, the process probes. Every member is total.
 */
export function defaultTeamCoreHost(runtime: TeamRuntime): TeamCoreHost {
  const usage = () => {
    try {
      return readUsageCache();
    } catch {
      return {};
    }
  };
  return {
    platform: process.platform,
    settings(): TeamHostSettings {
      const r = readRegistry();
      return {
        teamMode: r.teamMode,
        teamMaxMembers: r.teamMaxMembers,
        teamMaxRunningTurns: r.teamMaxRunningTurns,
        teamTurnsPerMemberPerHour: r.teamTurnsPerMemberPerHour,
        teamTurnsPerDay: r.teamTurnsPerDay,
        turnTimeoutMinutes: teamTurnTimeoutMinutesOf(r),
        teamCursorForce: r.teamCursorForce,
        teamAgySkipPermissions: r.teamAgySkipPermissions,
        permissionMode: r.permissionMode,
        cooldownMinutes: r.cooldownMinutes,
      };
    },
    routing(): RoutingFacts {
      const reg = readRegistry();
      const cache = usage();
      const overageAllowed = reg.overageWorkerDispatch === 'allow';
      const frontierGuardBlocks = reg.frontierWorkerDispatch !== 'allow';
      const probeKey = (w: WorkerProfile): string => (providerOfWorker(w) === 'claude' ? w.configDir : `${providerOfWorker(w)}\0${w.configDir}`);
      return {
        workers: reg.workers,
        leadConfigDir: hostConfigDir(),
        sameLoginKey: (w) => usageAccountKeyOf(ownEntry(cache, w.configDir)),
        providerCached: (provider) => {
          const of = reg.workers.filter((w) => providerOfWorker(w) === provider);
          if (of.length === 0) {
            // unknown: AUTO tries it and routing says "no <provider> worker account is registered"
            return {};
          }
          const out = of.every((w) => isLoginExpired(ownEntry(cache, w.configDir)));
          return { loggedIn: out ? false : undefined };
        },
        headroom: (w) => {
          const entry = ownEntry(cache, w.configDir);
          const windows = entry?.windows ?? [];
          return windows.length === 0 ? undefined : 100 - Math.max(...windows.map((x) => x.percent));
        },
        frontierGuardBlocks,
        storedCodexDefault: () => undefined,
        codexDispatchServer: (w) => (providerOfWorker(w) === 'codex' ? codexConfigRegistersDispatch(w.configDir) : undefined),
        pick: async (candidates, named, attempted, model, mode) => {
          // `cached` (M15): every account is marked as already probed, so pickWorkerLive's live
          // re-check spawns nothing and the cached verdict stands.
          const probed = new Set<string>(mode === 'cached' ? candidates.map(probeKey) : []);
          try {
            const r = await pickWorkerLive([...candidates], named, new Set(attempted), model, cache, overageAllowed, probed, frontierGuardBlocks);
            return { ok: true, worker: r.worker, billableOverage: r.billableOverage };
          } catch (err) {
            return { ok: false, text: errText(err) };
          }
        },
      };
    },
    quotaResetAt(worker, model) {
      void model;
      const entry = ownEntry(usage(), worker.configDir);
      const windows = exhaustedWindows(entry, Date.now());
      let best: { until: number; window: string } | undefined;
      for (const w of windows) {
        const at = w.resetsAt !== null ? Date.parse(w.resetsAt) : NaN;
        if (Number.isFinite(at) && (best === undefined || at < best.until)) {
          best = { until: at, window: w.kind === 'session' ? '5-hour' : 'weekly' };
        }
      }
      return best;
    },
    async codexModelLive(worker) {
      try {
        const catalog = await providerModels({ provider: 'codex', configDir: worker.configDir }, { timeoutMs: CODEX_MODEL_LOOKUP_MS });
        return catalog.models.find((m) => m.default === true)?.id;
      } catch {
        return undefined;
      }
    },
    async claudeLoginProbe(worker) {
      // CONTRACT-QUESTION: TurnDeps says the probe "files its own verdict as dispatch's does";
      // task-runner's filing path (applyAuthReading / persistAuthReading) is module-private, so
      // this probe DECIDES the outcome (auth vs error) but writes nothing to the usage cache.
      try {
        const status = await fetchAuthStatus(worker.configDir, 5_000);
        return status === undefined ? undefined : status.loggedIn;
      } catch {
        return undefined;
      }
    },
    bookkeeping(worker, identityNames, outcome, cooldownMinutes) {
      return recordTurnBookkeeping({ name: worker.name, configDir: worker.configDir, provider: worker.provider, identityNames }, outcome, cooldownMinutes);
    },
    taskLog: {
      append(event) {
        appendTaskEvent(event);
      },
      appendTerminal(event) {
        const close = appendTerminalTaskEvent(event);
        return { closed: close.closed };
      },
      writePrompt(turnId, text) {
        const w = writeTaskFile(turnId, 'prompt', text);
        return w.ok ? path.join(runtime.dataRoot, 'tasks', `${turnId}.prompt.txt`) : undefined;
      },
      writeOutput(turnId, text) {
        return writeTaskFile(turnId, 'output', text).ok;
      },
    },
    process: {
      isAlive: (pid) => isPidAlive(pid),
      startedAt: (pid) => processStartedAt(pid),
      isOurWorker: (pid, provider) => isOurWorker(pid, provider),
      signalGroup: (pgid, sig) => {
        try {
          process.kill(-pgid, sig);
        } catch {
          // the group is gone
        }
      },
      findByEnvMarker: (turnId) => findByEnvMarker(turnId),
      rssByGroup: () => rssByGroup(),
    },
    claudeTakeover(configDir) {
      try {
        const reg = readRegistry();
        const command = resolveClaudePathWithoutLookup(reg.claudePath, reg.claudePath).path;
        if (typeof command !== 'string' || command === '') {
          return undefined;
        }
        return { command, env: claudeTerminalEnv(configDir) };
      } catch {
        return undefined;
      }
    },
  };
}

/** M7/RP-19: pids of this uid whose environment holds `CCO_DISPATCHED_TASK=<turnId>` (darwin `ps -E`, linux `/proc/<pid>/environ`); undefined when the search cannot run. */
async function findByEnvMarker(turnId: string): Promise<number[] | undefined> {
  if (!TASK_ID.test(turnId)) {
    return [];
  }
  const marker = `${DISPATCHED_TASK_ENV}=${turnId}`;
  const { execFile } = await import('child_process');
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('ps', ['-E', '-ww', '-A', '-o', 'pid=,command='], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const out: number[] = [];
        for (const line of String(stdout).split('\n')) {
          if (line.includes(marker)) {
            const pid = Number.parseInt(line.trim(), 10);
            if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
              out.push(pid);
            }
          }
        }
        resolve(out);
      });
    });
  }
  if (process.platform === 'linux') {
    try {
      const fs = await import('fs');
      const out: number[] = [];
      for (const name of fs.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(name)) {
          continue;
        }
        try {
          const env = fs.readFileSync(`/proc/${name}/environ`, 'latin1');
          if (env.split('\0').includes(marker)) {
            out.push(Number(name));
          }
        } catch {
          // another user's process, or gone
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** L14: ONE `ps -A -o pid=,pgid=,rss=` — summed RSS bytes per process group. */
async function rssByGroup(): Promise<Map<number, number> | undefined> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,pgid=,rss='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const out = new Map<number, number>();
      for (const line of String(stdout).split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) {
          continue;
        }
        const pgid = Number(parts[1]);
        const kb = Number(parts[2]);
        if (Number.isFinite(pgid) && Number.isFinite(kb)) {
          out.set(pgid, (out.get(pgid) ?? 0) + kb * 1024);
        }
      }
      resolve(out);
    });
  });
}

/** src/team/engine.ts exports `createTeamCore: CreateTeamCore` (contract §7.1, T5a): the core over the real store, driver, worktrees and host. */
export const createTeamCore: CreateTeamCore = (runtime) =>
  createTeamCoreWith(runtime, {
    stores: createTeamStores(runtime),
    startTurn: driverStartTurn,
    mintConversation: driverMintConversation,
    worktrees: createTeamWorktrees(runtime),
    host: defaultTeamCoreHost(runtime),
  });

