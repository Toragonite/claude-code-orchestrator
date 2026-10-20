import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  BOARD_ID,
  FEED_KINDS,
  LINE_MAX_BYTES,
  MEMBER_MAILBOX,
  MEMBER_NAME,
  MEMBER_STATES,
  MESSAGE_KINDS,
  METHOD,
  METHOD_TEAM,
  NOTICE_KINDS,
  PROTOCOL_VERSION,
  RESERVED_NAMES,
  RPC_ERROR,
  runDirOf,
  socketPathFor,
  TASK_ID,
  TASK_STATES,
  TEAM_DIR_ENTRIES,
  TEAM_DIR_SCAN_MAX,
  TEAM_FEATURE,
  TEAM_FEATURE_MISSING_SENTENCE,
  TEAM_ID,
  TEAM_LIST_MAX,
  TEAM_PROVIDERS,
  TEAM_STATUSES,
  TEAM_SUBSCRIBE_REPLAY_MAX,
  TEAM_WARNING_KINDS,
  teamOwnerIsLive,
  teamsDirOf,
  type BoardTask,
  type FeedItem,
  type HostRecord,
  type MemberState,
  type MessageKind,
  type ObserverHelloParams,
  type TeamState,
} from './mcp/host-protocol';
import { FRONTEND_NOTIFY_INTERVAL_MS, STATE_MAX } from './team/contract';
import { isPidAlive, processStartedAt } from './registry';
import { readTextSafe } from './safeFs';

/**
 * teamClient — the extension's client of the dispatch host's OBSERVER role (team contract §7.6,
 * §8.1, T0 amendment A14). It finds the hosts of this workspace, says hello to each as an observer,
 * subscribes to the team the host owns, and keeps a SNAPSHOT of every team of the workspace for
 * the Team view, the status bar, the notifications and the task tree's Cancel routing.
 *
 * WHAT IT HOLDS AND WHERE IT COMES FROM. A14: no reducer of the log is frozen for front ends, so a
 * `cco/team.event` is a CHANGE SIGNAL — every one schedules a fresh `cco/team.get`, at most two per
 * second per team — and the engine's own projection (what `get` answers) is the only state shown.
 * What the projection does not hold is kept from the events themselves: the last messages
 * (`msg.posted`), the notices the user is told about, and the activity lines. A team no live host
 * owns is read from its `state.json` (§2.4), and its `active` status and `running` members are
 * believed only per L7 (teamOwnerIsLive): a dead or unprovable owner renders "host gone".
 *
 * EVERYTHING HERE IS DATA FROM ANOTHER PROCESS: a host record, a hello answer, a snapshot, an event,
 * a `state.json`. Each is checked BY VALUE before it is kept (teamStateOf, hostRecordOf, …): a
 * string is kept as a string (capped), never as markup — the view flattens and caps it again
 * before it renders (uiTypes rule 1) — and a record of another shape contributes nothing. A host
 * record is only connected to when its socket is exactly the one `socketPathFor` names for its
 * session (the one rule of §15.1): a record cannot point this client at an arbitrary socket.
 *
 * Total: nothing here throws to a caller and no promise it returns rejects. Must not import
 * 'vscode' (§8.1) — the view layer (teamView.ts) owns every user-visible string.
 *
 * Residuals, stated: messages are known only from the events this client saw — it replays at most
 * MESSAGE_REPLAY_EVENTS events of history at subscribe time, so an older message is not listed;
 * a team without a live host shows no messages (the log is engine-private and is never read
 * here). A resubscribe after a dropped connection starts from the last seq seen (§7.6); when the
 * host can no longer replay that far (`resnapshot_required`) the messages posted in the gap are
 * not listed. win32 has no team mode (I12): start() does nothing there.
 */

/* ------------------------------------------------------------------------- *
 * Bounds
 * ------------------------------------------------------------------------- */

/** Discovery tick (§8.1: "every 5 s"): run directory, team directories, list polls. */
const DISCOVERY_INTERVAL_MS = 5_000;
/**
 * A change in `run/` is acted on once this long after the burst it belongs to. The directory also
 * holds every host's continuously appended `s<P>.log`, whose events are not looked at at all.
 */
const RUN_WATCH_DEBOUNCE_MS = 250;
/** A tick lists a host's teams at most this often (a connect, a Refresh and a `cco/team.host` notice list at once). */
const LIST_POLL_MIN_INTERVAL_MS = 4_500;
/** §8.1 reconnect backoff, by consecutive failures of one host. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
const CONNECT_TIMEOUT_MS = 5_000;
/** A non-held request is answered within this or read as unreachable. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A14: at most two snapshot reads per second per team. */
const SNAPSHOT_MIN_INTERVAL_MS = 500;
/** Change signals to the listeners are coalesced over this window. */
const CHANGE_COALESCE_MS = 100;
/** Messages kept per team (§8.1: the Messages node shows the last 50). */
export const TEAM_MESSAGES_KEPT = 50;
/** Events of history replayed at subscribe time to fill the Messages node (≤ TEAM_SUBSCRIBE_REPLAY_MAX). */
const MESSAGE_REPLAY_EVENTS = 2_000;
/** Characters of a message body kept in memory; the whole text is cco/team.messageBody's. */
const MESSAGE_BODY_KEPT_CHARS = 4_000;
/** Host records (`s<P>.json`, newest first) examined per scan — never other run-directory entries (A35) — and the size one is read up to. */
const RUN_DIR_SCAN_MAX = 200;
const RUN_RECORD_MAX_BYTES = 64 * 1024;
const TEAM_HEADER_MAX_BYTES = 64 * 1024;
/** An `ended` team stays listed this long after it ended; older ones are history. */
const ENDED_SHOWN_MS = 24 * 60 * 60_000;
/** A notice event older than this (a replay after a reconnect) is not announced. */
const NOTICE_RECENT_MS = 60_000;
/** How long one L7 verdict (it runs `ps`) serves the following ticks. */
const OWNER_VERDICT_MS = 15_000;
/** Generous caps on what is KEPT of a host string; the view cuts to its own, smaller ones. */
const TEXT_KEPT = 4_096;
const NAME_KEPT = 256;
const LIST_KEPT = 500;

/* ------------------------------------------------------------------------- *
 * Public shapes
 * ------------------------------------------------------------------------- */

/** One message of a team as this client saw it (`msg.posted`). */
export interface TeamMessage {
  seq: number;
  /** `m<seq>`. */
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: MessageKind;
  urgent: boolean;
  /** The inline body's first MESSAGE_BODY_KEPT_CHARS, or undefined when it lives in a body file. */
  body: string | undefined;
  /** The body is longer than what is kept here (or lives in a body file): ask messageBody for it. */
  cut: boolean;
  bytes: number;
}

/** One team, as every surface renders it. */
export interface TeamSnapshot {
  teamId: string;
  state: TeamState;
  /** A connected host owns the team and this client is subscribed to it: actions can be sent. */
  live: boolean;
  /**
   * L7: the snapshot's `active` status and `running`/`attached` members are current. Always true
   * for a live team; for one read from `state.json`, true only when its owner host is provably
   * alive (teamOwnerIsLive) or the team is not `active`.
   */
  believed: boolean;
  /** Newest first, at most TEAM_MESSAGES_KEPT. Empty for a team without a live host. */
  messages: TeamMessage[];
}

/** What a notification is about (§8.1: blocked / turns-only / context-lost / team suspended / team idle). */
export type TeamNoticeKind = 'blocked' | 'turns-only' | 'context-lost' | 'suspended' | 'idle';

/** One notice to show the user — at most one per team per FRONTEND_NOTIFY_INTERVAL_MS. */
export interface TeamNotice {
  teamId: string;
  teamName: string;
  kind: TeamNoticeKind;
  /** The notice's own text (host data, unflattened), when it carried one inline. */
  text: string | undefined;
  /** The member it is about, when known. */
  member: string | undefined;
}

/** The answer of one observer request. */
export type TeamCallOutcome =
  | { kind: 'ok'; result: Record<string, unknown> }
  /** A domain refusal `{ok:false, code, sentence}`, or a JSON-RPC error read as one (`rpc:<code>`). */
  | { kind: 'refused'; code: string; sentence: string }
  /** No connected host owns the team, or the connection went away before the answer. */
  | { kind: 'unreachable'; why: string };

/** What the task tree's Cancel of a team turn did (M8). */
export type TeamTurnPause =
  | { kind: 'paused' }
  | { kind: 'refused'; sentence: string }
  /** The owning host answered, and the task is not its member's running turn. */
  | { kind: 'not-current' }
  | { kind: 'unreachable' };

export interface TeamClientOptions {
  /** The data root (`~/.claude-code-orchestrator`). */
  dataRoot: string;
  /** The workspace folder the view is scoped to, or undefined. Asked on every tick. */
  workspace: () => string | undefined;
  /** Connect to hosts at all? (teamMode on, or a team of this workspace is not ended). Asked on every tick. */
  connectWanted: () => boolean;
  /** One line to the output channel. */
  log: (line: string) => void;
}

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number = TEXT_KEPT): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function oneOf<T extends string>(value: unknown, list: readonly T[]): T | undefined {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

function strings(value: unknown, max: number, each: number = NAME_KEPT): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= max) {
      break;
    }
    const s = str(entry, each);
    if (s !== undefined) {
      out.push(s);
    }
  }
  return out;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Is one of the two paths the other or inside it (the §7.6 host-record rule)? Case as the filesystem folds it. */
function related(a: string, b: string): boolean {
  const fold = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  const x = fold(a);
  const y = fold(b);
  const within = (child: string, root: string): boolean =>
    child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  return within(x, y) || within(y, x);
}

function realDir(dir: string | undefined): string | undefined {
  if (dir === undefined || dir === '' || !path.isAbsolute(dir)) {
    return undefined;
  }
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/* ------------------------------------------------------------------------- *
 * Records from another process, checked by value
 * ------------------------------------------------------------------------- */

/** The name of a host record in `run/` (§15.1), the session pid captured. */
const HOST_RECORD_NAME = /^s([1-9][0-9]{0,9})\.json$/;

/**
 * The host-record names of `dir`, newest first by modification time (A35): every other entry of
 * the run directory is left out BEFORE any cap is applied. A record that cannot be stat'ed sorts
 * last. Throws only what readdirSync throws.
 */
function newestRecordNames(dir: string): string[] {
  const records: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!HOST_RECORD_NAME.test(name)) {
      continue;
    }
    let mtimeMs = -Infinity;
    try {
      mtimeMs = fs.lstatSync(path.join(dir, name)).mtimeMs;
    } catch {
      // gone meanwhile: last
    }
    records.push({ name, mtimeMs });
  }
  records.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return records.map((r) => r.name);
}

/** `run/s<P>.json` (§15.1) → the record, when it has its shape and protocol. */
export function hostRecordOf(raw: unknown): HostRecord | undefined {
  if (!isRecord(raw) || !isRecord(raw.session)) {
    return undefined;
  }
  const hostPid = positiveInt(raw.hostPid);
  const hostStartedAt = finite(raw.hostStartedAt);
  const sessionPid = positiveInt(raw.session.pid);
  const sessionStartedAt = finite(raw.session.startedAt);
  const workspace = str(raw.workspace);
  const socket = str(raw.socket);
  const serverHash = str(raw.serverHash, 64);
  if (
    raw.protocol !== PROTOCOL_VERSION ||
    hostPid === undefined ||
    hostStartedAt === undefined ||
    sessionPid === undefined ||
    sessionStartedAt === undefined ||
    workspace === undefined ||
    !path.isAbsolute(workspace) ||
    workspace.includes('\u0000') ||
    socket === undefined ||
    serverHash === undefined
  ) {
    return undefined;
  }
  return {
    protocol: PROTOCOL_VERSION,
    hostPid,
    hostStartedAt,
    session: { pid: sessionPid, startedAt: sessionStartedAt },
    workspace,
    socket,
    serverHash,
  };
}

function memberStateOf(raw: unknown): MemberState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const name = typeof raw.name === 'string' && MEMBER_NAME.test(raw.name) ? raw.name : undefined;
  const state = oneOf(raw.state, MEMBER_STATES);
  const provider = oneOf(raw.provider, TEAM_PROVIDERS);
  if (name === undefined || state === undefined || provider === undefined) {
    return undefined;
  }
  const reasonRaw = isRecord(raw.reason) ? raw.reason : undefined;
  const reasonCode = str(reasonRaw?.code, 32);
  const worktreeRaw = isRecord(raw.worktree) ? raw.worktree : {};
  const turnRaw = isRecord(raw.turn) ? raw.turn : undefined;
  const turnId = typeof turnRaw?.id === 'string' && TASK_ID.test(turnRaw.id) ? turnRaw.id : undefined;
  const lastTurnRaw = isRecord(raw.lastTurn) ? raw.lastTurn : undefined;
  const attachRaw = isRecord(raw.attach) ? raw.attach : undefined;
  const activityRaw = isRecord(raw.lastActivity) ? raw.lastActivity : undefined;
  const tokensRaw = isRecord(raw.tokens) ? raw.tokens : {};
  const member: MemberState = {
    name,
    index: count(raw.index),
    role: str(raw.role, NAME_KEPT) ?? '',
    state,
    provider,
    worker: str(raw.worker, NAME_KEPT) ?? '',
    accountLabel: str(raw.accountLabel, NAME_KEPT) ?? '',
    machineLogin: raw.machineLogin === true,
    sharesLeadPlan: raw.sharesLeadPlan === true,
    billableOverage: raw.billableOverage === true,
    runsCommands: raw.runsCommands === true,
    model: str(raw.model, NAME_KEPT) ?? '',
    incarnation: count(raw.incarnation),
    mailbox: oneOf(raw.mailbox, MEMBER_MAILBOX) ?? 'unverified',
    portBase: count(raw.portBase),
    worktree: {
      path: str(worktreeRaw.path) ?? '',
      branch: str(worktreeRaw.branch, NAME_KEPT) ?? '',
      baseCommit: str(worktreeRaw.baseCommit, 64) ?? '',
      ready: worktreeRaw.ready === true,
      headSha: str(worktreeRaw.headSha, 64),
      ahead: finite(worktreeRaw.ahead),
      filesChanged: finite(worktreeRaw.filesChanged),
      dirty: typeof worktreeRaw.dirty === 'boolean' ? worktreeRaw.dirty : undefined,
      merged: typeof worktreeRaw.merged === 'boolean' ? worktreeRaw.merged : undefined,
    },
    turns: count(raw.turns),
    tokens: { in: count(tokensRaw.in), out: count(tokensRaw.out) },
    costUsd: finite(raw.costUsd) ?? null,
    pending: count(raw.pending),
    tasks: strings(raw.tasks, 32).filter((id) => BOARD_ID.test(id)),
    peerWakes: count(raw.peerWakes),
  };
  if (reasonRaw !== undefined && reasonCode !== undefined) {
    member.reason = {
      code: reasonCode as NonNullable<MemberState['reason']>['code'],
      text: str(reasonRaw.text) ?? '',
      until: finite(reasonRaw.until),
    };
  }
  if (raw.elevated === 'cursor-force' || raw.elevated === 'agy-skip-permissions') {
    member.elevated = raw.elevated;
  }
  const modelUsed = str(raw.modelUsed, NAME_KEPT);
  if (modelUsed !== undefined) {
    member.modelUsed = modelUsed;
  }
  const conversationShort = str(raw.conversationShort, 16);
  if (conversationShort !== undefined) {
    member.conversationShort = conversationShort;
  }
  const mailboxReason = str(raw.mailboxReason, NAME_KEPT);
  if (mailboxReason !== undefined) {
    member.mailboxReason = mailboxReason;
  }
  if (turnRaw !== undefined && turnId !== undefined) {
    member.turn = {
      id: turnId,
      n: count(turnRaw.n),
      startedAt: finite(turnRaw.startedAt) ?? 0,
      pid: positiveInt(turnRaw.pid),
      lastOutputAt: finite(turnRaw.lastOutputAt),
    };
  }
  const lastInputTokens = finite(raw.lastInputTokens);
  if (lastInputTokens !== undefined) {
    member.lastInputTokens = lastInputTokens;
  }
  if (lastTurnRaw !== undefined) {
    member.lastTurn = {
      id: str(lastTurnRaw.id, 160) ?? '',
      n: count(lastTurnRaw.n),
      outcome: str(lastTurnRaw.outcome, 32) ?? '',
      endedAt: finite(lastTurnRaw.endedAt) ?? 0,
      head: str(lastTurnRaw.head, 400) ?? '',
    };
  }
  const rssMb = finite(raw.rssMb);
  if (rssMb !== undefined) {
    member.rssMb = rssMb;
  }
  if (attachRaw !== undefined && typeof attachRaw.lease === 'string') {
    member.attach = {
      lease: str(attachRaw.lease, 32) ?? '',
      pid: positiveInt(attachRaw.pid),
      client: str(attachRaw.client, 32) ?? '',
      since: finite(attachRaw.since) ?? 0,
    };
  }
  if (activityRaw !== undefined) {
    member.lastActivity = { ts: finite(activityRaw.ts) ?? 0, text: str(activityRaw.text, 400) ?? '' };
  }
  return member;
}

function boardTaskOf(raw: unknown): BoardTask | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = typeof raw.id === 'string' && BOARD_ID.test(raw.id) ? raw.id : undefined;
  const state = oneOf(raw.state, TASK_STATES);
  if (id === undefined || state === undefined) {
    return undefined;
  }
  const assignee = typeof raw.assignee === 'string' && MEMBER_NAME.test(raw.assignee) ? raw.assignee : undefined;
  const task: BoardTask = {
    id,
    title: str(raw.title, NAME_KEPT) ?? '',
    state,
    paths: strings(raw.paths, 32, 400),
    allowOverlap: raw.allowOverlap === true,
    createdBy: raw.createdBy === 'lead' ? 'lead' : 'user',
    createdAt: finite(raw.createdAt) ?? 0,
    reports: [],
    commits: strings(raw.commits, 200, 64),
    turns: strings(raw.turns, 200, 160),
    updatedAt: finite(raw.updatedAt) ?? 0,
    updatedBy: str(raw.updatedBy, NAME_KEPT) ?? '',
  };
  if (assignee !== undefined) {
    task.assignee = assignee;
  }
  const body = str(raw.body, TEXT_KEPT);
  if (body !== undefined) {
    task.body = body;
  }
  const note = str(raw.note, TEXT_KEPT);
  if (note !== undefined) {
    task.note = note;
  }
  return task;
}

/**
 * A snapshot (a `cco/team.get` answer, a subscription's first event, or `state.json`) → a
 * TeamState every field of which has its type, or undefined when its identity is not one (§2.4).
 * Members, tasks and warnings of another shape are dropped one by one; a missing count reads 0.
 */
export function teamStateOf(raw: unknown): TeamState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = typeof raw.id === 'string' && TEAM_ID.test(raw.id) ? raw.id : undefined;
  const status = oneOf(raw.status, TEAM_STATUSES);
  const name = str(raw.name, 64);
  if (raw.v !== 1 || id === undefined || status === undefined || name === undefined) {
    return undefined;
  }
  const ownerRaw = isRecord(raw.owner) ? raw.owner : undefined;
  const ownerSession = isRecord(ownerRaw?.session) ? ownerRaw.session : undefined;
  const leadRaw = isRecord(raw.lead) ? raw.lead : {};
  const userRaw = isRecord(raw.user) ? raw.user : {};
  const budgetsRaw = isRecord(raw.budgets) ? raw.budgets : {};
  const totalsRaw = isRecord(raw.totals) ? raw.totals : {};
  const members: MemberState[] = [];
  for (const entry of Array.isArray(raw.members) ? raw.members.slice(0, 64) : []) {
    const member = memberStateOf(entry);
    if (member !== undefined && !members.some((m) => m.name === member.name)) {
      members.push(member);
    }
  }
  const board: BoardTask[] = [];
  for (const entry of Array.isArray(raw.board) ? raw.board.slice(0, LIST_KEPT) : []) {
    const task = boardTaskOf(entry);
    if (task !== undefined && !board.some((t) => t.id === task.id)) {
      board.push(task);
    }
  }
  const warnings: TeamState['warnings'] = [];
  for (const entry of Array.isArray(raw.warnings) ? raw.warnings.slice(0, 50) : []) {
    if (isRecord(entry)) {
      const kind = oneOf(entry.kind, TEAM_WARNING_KINDS);
      const text = str(entry.text);
      if (kind !== undefined && text !== undefined) {
        warnings.push({ kind, text });
      }
    }
  }
  const state: TeamState = {
    v: 1,
    id,
    name,
    title: str(raw.title, NAME_KEPT) ?? '',
    status,
    workspace: str(raw.workspace) ?? '',
    repoRoot: str(raw.repoRoot) ?? '',
    leadRel: str(raw.leadRel) ?? '',
    baseCommit: str(raw.baseCommit, 64) ?? '',
    createdAt: finite(raw.createdAt) ?? 0,
    seq: count(raw.seq),
    owner:
      ownerRaw !== undefined && ownerSession !== undefined
        ? {
            hostPid: positiveInt(ownerRaw.hostPid) ?? 0,
            hostStartedAt: finite(ownerRaw.hostStartedAt) ?? 0,
            session: { pid: positiveInt(ownerSession.pid) ?? 0, startedAt: finite(ownerSession.startedAt) ?? 0 },
          }
        : null,
    lead: {
      unread: count(leadRaw.unread),
      readSeq: count(leadRaw.readSeq),
      waiter: leadRaw.waiter === true,
      lastCallAt: finite(leadRaw.lastCallAt) ?? null,
      wakesToday: count(leadRaw.wakesToday),
    },
    user: { unread: count(userRaw.unread), readSeq: count(userRaw.readSeq) },
    members,
    board,
    budgets: {
      turnsToday: count(budgetsRaw.turnsToday),
      turnsPerDay: count(budgetsRaw.turnsPerDay),
      running: count(budgetsRaw.running),
      maxRunning: count(budgetsRaw.maxRunning),
      pingPongTripped: budgetsRaw.pingPongTripped === true,
    },
    totals: {
      turns: count(totalsRaw.turns),
      inputTokens: count(totalsRaw.inputTokens),
      outputTokens: count(totalsRaw.outputTokens),
      costUsd: finite(totalsRaw.costUsd) ?? null,
    },
    warnings,
  };
  const damagedReason = str(raw.damagedReason);
  if (damagedReason !== undefined) {
    state.damagedReason = damagedReason;
  }
  const goal = str(raw.goal);
  if (goal !== undefined) {
    state.goal = goal;
  }
  const endedAt = finite(raw.endedAt);
  if (endedAt !== undefined) {
    state.endedAt = endedAt;
  }
  return state;
}

/** A `msg.posted` event's data → a message, or undefined. `seq` is the event's. */
function messageOf(seq: number, ts: number, data: Record<string, unknown>): TeamMessage | undefined {
  const kind = oneOf(data.kind, MESSAGE_KINDS);
  const from = str(data.from, NAME_KEPT);
  const to = str(data.to, NAME_KEPT);
  if (kind === undefined || from === undefined || to === undefined) {
    return undefined;
  }
  const inline = typeof data.body === 'string' ? data.body : undefined;
  return {
    seq,
    id: `m${seq}`,
    ts,
    from,
    to,
    kind,
    urgent: data.urgent === true,
    body: inline === undefined ? undefined : inline.slice(0, MESSAGE_BODY_KEPT_CHARS),
    cut: inline === undefined || inline.length > MESSAGE_BODY_KEPT_CHARS,
    bytes: count(data.bytes),
  };
}

/** Activity items of a notification, by value (§3.8). */
export function feedItemsOf(raw: unknown): FeedItem[] {
  const out: FeedItem[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, LIST_KEPT) : []) {
    if (!isRecord(entry)) {
      continue;
    }
    const k = oneOf(entry.k, FEED_KINDS);
    if (k === undefined) {
      continue;
    }
    const item: FeedItem = { ts: finite(entry.ts) ?? 0, turn: str(entry.turn, 160) ?? '', k };
    const s = str(entry.s, 2_048);
    if (s !== undefined) {
      item.s = s;
    }
    const tool = str(entry.tool, 64);
    if (tool !== undefined) {
      item.tool = tool;
    }
    const d = str(entry.d, 200);
    if (d !== undefined) {
      item.d = d;
    }
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * One connection to one host
 * ------------------------------------------------------------------------- */

type Answer =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: number | undefined; message: string }
  | { kind: 'gone'; why: string };

/** The one subscription a connection holds (§7.6: a second subscribe replaces the first). */
interface Subscription {
  teamId: string;
  requestId: number;
  activity: boolean;
  /**
   * A replay was asked for (`fromSeq` sent). Its opening snapshot then says nothing about which
   * events arrived — a connection closed mid-replay (MD-55) must resume from the last EVENT — so
   * only a subscription without a replay takes the snapshot's seq as the last one seen.
   */
  replay: boolean;
}

/**
 * One observer connection: newline-delimited JSON-RPC 2.0 (§15.4), a line split on the newline
 * BYTE before it is decoded, at most LINE_MAX_BYTES; a longer one ends the connection. A line that
 * is not one JSON object is skipped. Requests are answered by id; a held request (subscribe) has no
 * timeout. Every answer still pending when the connection goes is answered `gone`.
 */
class HostConnection {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private nextId = 1;
  private readonly pending = new Map<number, (answer: Answer) => void>();
  closed = false;
  sub: Subscription | undefined;

  constructor(
    private readonly socket: net.Socket,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onClose: (why: string) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.take(chunk));
    socket.on('error', (err: Error) => this.close(`the connection failed (${errnoOf(err) ?? err.message})`));
    socket.on('close', () => this.close('the connection closed'));
  }

  /** Connect to `socketPath`; never rejects. */
  static open(
    socketPath: string,
    onNotification: (method: string, params: Record<string, unknown>) => void,
    onClose: (why: string) => void,
  ): Promise<HostConnection | { error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: net.Socket;
      try {
        socket = net.createConnection({ path: socketPath });
      } catch (err) {
        resolve({ error: errnoOf(err) ?? String(err) });
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve({ error: 'ETIMEDOUT' });
        }
      }, CONNECT_TIMEOUT_MS);
      const onError = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve({ error: errnoOf(err) ?? 'ECONNREFUSED' });
        }
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(new HostConnection(socket, onNotification, onClose));
      });
    });
  }

  /** Send one request. `held`: no timeout (a subscribe is answered only when it ends). `onId` gets the id before it is sent. */
  request(method: string, params: unknown, held = false, onId?: (id: number) => void): Promise<Answer> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ kind: 'gone', why: 'the connection is closed' });
        return;
      }
      const id = this.nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, (answer) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(answer);
      });
      if (!held) {
        timer = setTimeout(() => {
          const settle = this.pending.get(id);
          this.pending.delete(id);
          settle?.({ kind: 'gone', why: 'the dispatch host did not answer in time' });
        }, REQUEST_TIMEOUT_MS);
      }
      onId?.(id);
      try {
        this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        // the 'error' / 'close' events answer it
      }
    });
  }

  close(why: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // gone already
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const settle of waiting) {
      settle({ kind: 'gone', why });
    }
    this.onClose(why);
  }

  private take(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0 && !this.closed) {
      const newline = rest.indexOf(0x0a);
      if (newline === -1) {
        this.buffered += rest.length;
        if (this.buffered > LINE_MAX_BYTES) {
          this.close('the dispatch host sent a line that is too long');
          return;
        }
        this.chunks.push(rest);
        return;
      }
      const head = rest.subarray(0, newline);
      rest = rest.subarray(newline + 1);
      if (this.buffered + head.length > LINE_MAX_BYTES) {
        this.close('the dispatch host sent a line that is too long');
        return;
      }
      const line = this.chunks.length === 0 ? head : Buffer.concat([...this.chunks, head]);
      this.chunks = [];
      this.buffered = 0;
      this.deliver(line);
    }
  }

  private deliver(line: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined && isRecord(message.params)) {
        try {
          this.onNotification(message.method, message.params);
        } catch {
          // a defect in one handler costs that notification only
        }
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const settle = this.pending.get(message.id);
    if (settle === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {};
      settle({
        kind: 'error',
        code: typeof error.code === 'number' ? error.code : undefined,
        message: str(error.message, 400) ?? 'no description was given',
      });
      return;
    }
    settle({ kind: 'result', result: message.result });
  }
}

/* ------------------------------------------------------------------------- *
 * The client
 * ------------------------------------------------------------------------- */

/** One host of this workspace, found through its run-directory record. */
interface HostEntry {
  /** The record's file name stem, `s<pid>`. */
  key: string;
  record: HostRecord;
  conn: HostConnection | undefined;
  connecting: boolean;
  failures: number;
  retryAt: number;
  /** The hostPid whose hello lacked TEAM_FEATURE: skipped (one log line) until the record changes. */
  noTeamsPid: number | undefined;
  /** A list poll is in flight. */
  listing: boolean;
  /** When the last list poll was sent (0: never, or a Refresh asked for one now). */
  lastListAt: number;
}

/** The live side of a team this client is subscribed to. */
interface LiveTeam {
  hostKey: string;
  state: TeamState | undefined;
  messages: Map<number, TeamMessage>;
  lastEventSeq: number;
  lastGetAt: number;
  getting: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * What a team's live side leaves behind when its connection or subscription goes: the last seq
 * seen, so the next subscription resumes from it (§7.6), and the messages already known. Kept
 * until the team is forgotten — no longer under `teams/` for this workspace and not live.
 */
interface ResumePoint {
  lastEventSeq: number;
  messages: Map<number, TeamMessage>;
}

/** A team found under `teams/` for this workspace. */
interface DiskTeam {
  state: TeamState;
  stamp: string;
}

export class TeamClient {
  private readonly hosts = new Map<string, HostEntry>();
  private readonly live = new Map<string, LiveTeam>();
  private readonly disk = new Map<string, DiskTeam>();
  private readonly resume = new Map<string, ResumePoint>();
  /**
   * team.json headers, by team id, once READ AND JUDGED (A38): the header, or null for one that
   * was read and is not a header of a team (another id, no absolute paths). Immutable once written
   * (§2.2), so a judgement is kept; a header that could not be read is not judged and not kept.
   */
  private readonly headers = new Map<string, { workspace: string; repoRoot: string } | null>();
  private readonly ownerVerdicts = new Map<string, { at: number; live: boolean }>();
  private readonly lastNoticeAt = new Map<string, number>();
  /** Members whose activity is wanted, per team (Show Activity). */
  private readonly activityWanted = new Map<string, Set<string>>();
  private readonly changeListeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: TeamNotice) => void>();
  private readonly activityListeners = new Set<(teamId: string, member: string, items: FeedItem[]) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private version = 0;
  private readonly runDir: string;

  constructor(private readonly opts: TeamClientOptions) {
    this.runDir = runDirOf(opts.dataRoot);
  }

  /** Start discovery: at once, on a watch of `run/`, and every 5 s (§8.1). No-op on win32 (I12). */
  start(): void {
    if (this.disposed || this.timer !== undefined || process.platform === 'win32') {
      return;
    }
    this.timer = setInterval(() => this.tick(), DISCOVERY_INTERVAL_MS);
    this.watchRunDir();
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.changeTimer !== undefined) {
      clearTimeout(this.changeTimer);
    }
    if (this.watchTimer !== undefined) {
      clearTimeout(this.watchTimer);
    }
    try {
      this.watcher?.close();
    } catch {
      // closed already
    }
    for (const team of this.live.values()) {
      if (team.timer !== undefined) {
        clearTimeout(team.timer);
      }
    }
    for (const host of this.hosts.values()) {
      host.conn?.close('the extension is shutting down');
    }
    this.hosts.clear();
    this.changeListeners.clear();
    this.noticeListeners.clear();
    this.activityListeners.clear();
  }

  /** A counter that moves whenever what teams() answers may have changed. */
  get changeCount(): number {
    return this.version;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onNotice(listener: (notice: TeamNotice) => void): { dispose(): void } {
    this.noticeListeners.add(listener);
    return { dispose: () => this.noticeListeners.delete(listener) };
  }

  onActivity(listener: (teamId: string, member: string, items: FeedItem[]) => void): { dispose(): void } {
    this.activityListeners.add(listener);
    return { dispose: () => this.activityListeners.delete(listener) };
  }

  /** Read again now (a user's Refresh). */
  refresh(): void {
    for (const host of this.hosts.values()) {
      host.retryAt = 0;
      host.lastListAt = 0;
    }
    this.tick();
  }

  /**
   * Every team of this workspace: the live ones first, then by creation, newest first. An `ended`
   * team is listed for ENDED_SHOWN_MS after it ended. At most TEAM_LIST_MAX.
   */
  teams(): TeamSnapshot[] {
    const now = Date.now();
    const ids = new Set<string>([...this.live.keys(), ...this.disk.keys()]);
    const out: TeamSnapshot[] = [];
    for (const teamId of ids) {
      const snap = this.snapshot(teamId, now);
      if (snap !== undefined) {
        out.push(snap);
      }
    }
    out.sort((a, b) => Number(b.live) - Number(a.live) || b.state.createdAt - a.state.createdAt);
    return out.slice(0, TEAM_LIST_MAX);
  }

  /** One team of teams(), or undefined. */
  team(teamId: string): TeamSnapshot | undefined {
    return this.snapshot(teamId, Date.now());
  }

  /** The live snapshot of a team this client is subscribed to, else its `state.json` one (L7), else undefined. */
  private snapshot(teamId: string, now: number): TeamSnapshot | undefined {
    const team = this.live.get(teamId);
    const host = team === undefined ? undefined : this.hosts.get(team.hostKey);
    if (team?.state !== undefined && host?.conn !== undefined && host.conn.sub?.teamId === teamId) {
      return {
        teamId,
        state: team.state,
        live: true,
        believed: true,
        messages: [...team.messages.values()].sort((a, b) => b.seq - a.seq).slice(0, TEAM_MESSAGES_KEPT),
      };
    }
    const disk = this.disk.get(teamId);
    if (disk === undefined) {
      return undefined;
    }
    const { state } = disk;
    if (state.status === 'ended' && (state.endedAt === undefined || now - state.endedAt > ENDED_SHOWN_MS)) {
      return undefined;
    }
    return { teamId, state, live: false, believed: this.believed(state), messages: [] };
  }

  /**
   * One observer request about `teamId`, on the connection of the host that owns it (§7.6: every
   * method but get/activityTail/messageBody/turnText needs the owning host). Never rejects.
   */
  async call(teamId: string, method: string, params: Record<string, unknown>): Promise<TeamCallOutcome> {
    const conn = this.ownerConnection(teamId);
    if (conn === undefined) {
      return { kind: 'unreachable', why: 'no running dispatch host leads this team' };
    }
    return outcomeOf(await conn.request(method, params));
  }

  /**
   * M8 / L12: the task tree's Cancel of the team turn `taskId` of `member`. Asks the owning host
   * for a FRESH snapshot first: only when that member's running turn IS this task is the member
   * paused (`cco/team.member {op:'pause', now:true}`) — so the engine stops its own turn and never
   * reads it as killed behind its back. Never rejects.
   */
  async pauseTurn(teamId: string, member: string, taskId: string): Promise<TeamTurnPause> {
    const conn = this.ownerConnection(teamId);
    if (conn === undefined) {
      return { kind: 'unreachable' };
    }
    const got = outcomeOf(await conn.request(METHOD_TEAM.get, { teamId }));
    if (got.kind === 'unreachable') {
      return { kind: 'unreachable' };
    }
    if (got.kind === 'refused') {
      return { kind: 'refused', sentence: got.sentence };
    }
    const state = teamStateOf(got.result.state);
    const running = state?.members.find((m) => m.name === member);
    if (state === undefined || running?.turn?.id !== taskId) {
      return { kind: 'not-current' };
    }
    const paused = outcomeOf(
      await conn.request(METHOD_TEAM.member, { teamId, member, op: 'pause', now: true }),
    );
    this.scheduleSnapshot(teamId);
    if (paused.kind === 'ok') {
      return { kind: 'paused' };
    }
    return paused.kind === 'refused' ? { kind: 'refused', sentence: paused.sentence } : { kind: 'unreachable' };
  }

  /**
   * Show Activity: live `cco/team.activity` for `member` of `teamId` while `on` (§8.1). The one
   * subscription of the owning connection is renewed with `activity` set as needed — the host
   * answers the replaced one `{ok:true, replaced:true}` (L8) and starts the new one from the last
   * seq seen.
   */
  setActivity(teamId: string, member: string, on: boolean): void {
    let wanted = this.activityWanted.get(teamId);
    if (on) {
      if (wanted === undefined) {
        wanted = new Set();
        this.activityWanted.set(teamId, wanted);
      }
      wanted.add(member);
    } else {
      wanted?.delete(member);
    }
    const want = (this.activityWanted.get(teamId)?.size ?? 0) > 0;
    const team = this.live.get(teamId);
    const host = team === undefined ? undefined : this.hosts.get(team.hostKey);
    const conn = host?.conn;
    if (conn !== undefined && conn.sub?.teamId === teamId && conn.sub.activity !== want) {
      this.subscribe(host as HostEntry, conn, teamId, team?.lastEventSeq ?? 0);
    }
  }

  /* ---- discovery ---- */

  private watchRunDir(): void {
    try {
      this.watcher = fs.watch(this.runDir, { persistent: false }, (_event, filename) => this.onRunDirChange(filename));
      this.watcher.on('error', () => {
        // the 5 s tick still runs
        try {
          this.watcher?.close();
        } catch {
          // closed already
        }
        this.watcher = undefined;
      });
    } catch {
      // no run directory yet: the 5 s tick finds it (and retries the watch)
      this.watcher = undefined;
    }
  }

  /** A watch event of `run/`: a host log line is not a discovery event; a burst is one tick. */
  private onRunDirChange(filename: string | Buffer | null): void {
    if (typeof filename === 'string' && filename.endsWith('.log')) {
      return;
    }
    if (this.watchTimer !== undefined || this.disposed) {
      return;
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.tick();
    }, RUN_WATCH_DEBOUNCE_MS);
  }

  private tick(): void {
    if (this.disposed) {
      return;
    }
    try {
      if (this.watcher === undefined) {
        this.watchRunDir();
      }
      const folder = realDir(this.opts.workspace());
      const diskChanged = this.scanTeams(folder);
      for (const teamId of [...this.resume.keys()]) {
        if (!this.disk.has(teamId) && !this.live.has(teamId)) {
          this.resume.delete(teamId);
        }
      }
      if (folder !== undefined && this.connectWanted()) {
        this.scanHosts(folder);
      } else {
        this.dropHosts(new Set());
      }
      if (diskChanged) {
        this.changed();
      }
    } catch (err) {
      this.opts.log(`[team] discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private connectWanted(): boolean {
    try {
      if (this.opts.connectWanted()) {
        return true;
      }
    } catch {
      // read as "not asked for"
    }
    for (const team of this.disk.values()) {
      if (team.state.status !== 'ended') {
        return true;
      }
    }
    return false;
  }

  /**
   * The run directory's host records of this workspace (§7.6 "Front ends find hosts").
   *
   * A35 (review S2): `run/` also holds every session's `s<P>.log` / `.log.1`, its lock, fail and
   * spec files; the cap of RUN_DIR_SCAN_MAX applies to the RECORDS only, taken newest first (by
   * modification time) — capping the raw directory listing, in directory order, hid every live
   * host behind a few hundred old logs, with nothing said.
   */
  private scanHosts(folder: string): void {
    let names: string[];
    try {
      names = newestRecordNames(this.runDir).slice(0, RUN_DIR_SCAN_MAX);
    } catch {
      names = [];
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const found = new Set<string>();
    for (const name of names) {
      const match = HOST_RECORD_NAME.exec(name);
      if (match === null) {
        continue;
      }
      const sessionPid = Number(match[1]);
      const read = readTextSafe(path.join(this.runDir, name), RUN_RECORD_MAX_BYTES, { noFollow: true });
      if (!read.ok) {
        continue;
      }
      let record: HostRecord | undefined;
      try {
        record = hostRecordOf(JSON.parse(read.text));
      } catch {
        record = undefined;
      }
      if (
        record === undefined ||
        record.session.pid !== sessionPid ||
        !related(record.workspace, folder) ||
        !isPidAlive(record.hostPid) ||
        !this.isHostSocket(record, uid)
      ) {
        continue;
      }
      const key = `s${sessionPid}`;
      found.add(key);
      const known = this.hosts.get(key);
      if (known === undefined || known.record.hostPid !== record.hostPid || known.record.socket !== record.socket) {
        known?.conn?.close('the host record changed');
        this.hosts.set(key, {
          key,
          record,
          conn: undefined,
          connecting: false,
          failures: 0,
          retryAt: 0,
          noTeamsPid: undefined,
          listing: false,
          lastListAt: 0,
        });
      }
    }
    this.dropHosts(found);
    const now = Date.now();
    for (const host of this.hosts.values()) {
      if (host.noTeamsPid === host.record.hostPid) {
        continue;
      }
      if (host.conn !== undefined && !host.conn.closed) {
        if (now - host.lastListAt >= LIST_POLL_MIN_INTERVAL_MS || now < host.lastListAt) {
          void this.pollList(host);
        }
      } else if (!host.connecting && now >= host.retryAt) {
        void this.connect(host);
      }
    }
  }

  /**
   * Is the record's socket THE socket of its session (§15.1: socketPathFor)? A fallback socket
   * under the temp directory is used only when that directory is this user's, not a link, and
   * private — the check `cco` makes before it uses one.
   */
  private isHostSocket(record: HostRecord, uid: number): boolean {
    const expected = socketPathFor(this.runDir, record.session.pid, uid);
    if (expected === undefined || expected.socket !== record.socket) {
      return false;
    }
    if (expected.fallbackDir === undefined) {
      return true;
    }
    try {
      const st = fs.lstatSync(expected.fallbackDir);
      return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  private dropHosts(keep: Set<string>): void {
    for (const [key, host] of this.hosts) {
      if (!keep.has(key)) {
        this.hosts.delete(key);
        host.conn?.close('the host is gone');
        this.dropLiveOf(key);
      }
    }
  }

  /** The live side of the teams of `hostKey` goes; what a later subscription resumes from stays. */
  private dropLiveOf(hostKey: string): void {
    let dropped = false;
    for (const [teamId, team] of this.live) {
      if (team.hostKey === hostKey) {
        if (team.timer !== undefined) {
          clearTimeout(team.timer);
        }
        this.live.delete(teamId);
        this.resume.set(teamId, { lastEventSeq: team.lastEventSeq, messages: team.messages });
        dropped = true;
      }
    }
    if (dropped) {
      this.changed();
    }
  }

  private async connect(host: HostEntry): Promise<void> {
    host.connecting = true;
    const opened = await HostConnection.open(
      host.record.socket,
      (method, params) => this.onNotification(host, method, params),
      (why) => this.onConnectionClosed(host, why),
    );
    host.connecting = false;
    if (this.disposed || this.hosts.get(host.key) !== host) {
      if (opened instanceof HostConnection) {
        opened.close('not needed any more');
      }
      return;
    }
    if (!(opened instanceof HostConnection)) {
      this.failed(host, `could not connect (${opened.error})`);
      return;
    }
    host.conn = opened;
    const hello: ObserverHelloParams = {
      protocol: PROTOCOL_VERSION,
      role: 'observer',
      client: 'vscode',
      clientPid: process.pid,
    };
    const answer = await opened.request(METHOD.hello, hello);
    if (answer.kind !== 'result') {
      opened.close('hello refused');
      this.failed(host, answer.kind === 'error' ? `hello refused: ${answer.message}` : answer.why);
      return;
    }
    const result = isRecord(answer.result) ? answer.result : {};
    if (result.protocol !== PROTOCOL_VERSION || result.hostPid !== host.record.hostPid) {
      opened.close('not the host its record names');
      this.failed(host, 'the host answered for another process or protocol');
      return;
    }
    const features = Array.isArray(result.features) ? result.features : [];
    if (!features.includes(TEAM_FEATURE)) {
      // §8.1: skipped with ONE log line, until the record names another host process.
      host.noTeamsPid = host.record.hostPid;
      opened.close('no team feature');
      this.opts.log(`[team] host pid ${host.record.hostPid}: ${TEAM_FEATURE_MISSING_SENTENCE}`);
      return;
    }
    host.failures = 0;
    await this.pollList(host);
  }

  private failed(host: HostEntry, why: string): void {
    const delay = RECONNECT_BACKOFF_MS[Math.min(host.failures, RECONNECT_BACKOFF_MS.length - 1)];
    host.failures += 1;
    host.retryAt = Date.now() + delay;
    if (host.failures === 1) {
      this.opts.log(`[team] host pid ${host.record.hostPid}: ${why}; retrying`);
    }
    setTimeout(() => this.tick(), delay + 50);
  }

  private onConnectionClosed(host: HostEntry, why: string): void {
    if (host.conn !== undefined && host.conn.closed) {
      host.conn = undefined;
    }
    // An overflow close (MD-55) or the host going away: the live view falls back to the disk
    // until the next connection resubscribes from the last seq seen.
    const hadSub = [...this.live.values()].some((t) => t.hostKey === host.key);
    if (hadSub && !this.disposed && this.hosts.get(host.key) === host) {
      this.failed(host, why);
    }
    this.changed();
  }

  /** cco/team.list: subscribe to the team this host owns (one active team per host, MD-10). */
  private async pollList(host: HostEntry): Promise<void> {
    const conn = host.conn;
    if (conn === undefined || conn.closed || host.listing) {
      return;
    }
    host.listing = true;
    host.lastListAt = Date.now();
    try {
      const listed = outcomeOf(await conn.request(METHOD_TEAM.list, {}));
      if (listed.kind !== 'ok') {
        return;
      }
      const teams = Array.isArray(listed.result.teams) ? listed.result.teams : [];
      let owned: string | undefined;
      for (const entry of teams.slice(0, TEAM_LIST_MAX)) {
        if (
          isRecord(entry) &&
          entry.ownedHere === true &&
          typeof entry.teamId === 'string' &&
          TEAM_ID.test(entry.teamId) &&
          entry.state !== 'ended'
        ) {
          owned = entry.teamId;
          break;
        }
      }
      if (owned === undefined) {
        if (conn.sub !== undefined) {
          const teamId = conn.sub.teamId;
          conn.sub = undefined;
          void conn.request(METHOD_TEAM.unsubscribe, { teamId });
          this.dropLiveOf(host.key);
        }
        return;
      }
      if (conn.sub?.teamId !== owned) {
        await this.startTeam(host, conn, owned);
      }
    } finally {
      host.listing = false;
    }
  }

  /** get, then subscribe from far enough back to fill the Messages node (A14, §8.1). */
  private async startTeam(host: HostEntry, conn: HostConnection, teamId: string): Promise<void> {
    const got = outcomeOf(await conn.request(METHOD_TEAM.get, { teamId }));
    const state = got.kind === 'ok' ? teamStateOf(got.result.state) : undefined;
    if (state === undefined || state.id !== teamId || conn.closed) {
      return;
    }
    let team = this.live.get(teamId);
    if (team === undefined || team.hostKey !== host.key) {
      // The seqs are the team's log's, whichever host serves it: a team that moved resumes too.
      const kept = this.resume.get(teamId);
      this.resume.delete(teamId);
      team = {
        hostKey: host.key,
        state,
        messages: team?.messages ?? kept?.messages ?? new Map(),
        lastEventSeq: team?.lastEventSeq ?? kept?.lastEventSeq ?? 0,
        lastGetAt: Date.now(),
        getting: false,
        dirty: false,
        timer: undefined,
      };
      this.live.set(teamId, team);
    } else {
      team.state = state;
    }
    const fromSeq =
      team.lastEventSeq > 0
        ? team.lastEventSeq
        : Math.max(0, state.seq - Math.min(MESSAGE_REPLAY_EVENTS, TEAM_SUBSCRIBE_REPLAY_MAX));
    this.subscribe(host, conn, teamId, fromSeq);
    this.changed();
  }

  /**
   * The held subscribe; its ANSWER is the end of the subscription (§7.6, L8). `fromSeq` is sent
   * whenever it is a number, 0 included: the host replays the events AFTER it, and an absent
   * `fromSeq` replays nothing (undefined here: the snapshot alone).
   */
  private subscribe(host: HostEntry, conn: HostConnection, teamId: string, fromSeq: number | undefined): void {
    const activity = (this.activityWanted.get(teamId)?.size ?? 0) > 0;
    const params: Record<string, unknown> = { teamId, activity };
    if (fromSeq !== undefined) {
      params.fromSeq = fromSeq;
    }
    let requestId = -1;
    void conn
      .request(METHOD_TEAM.subscribe, params, true, (id) => {
        requestId = id;
        conn.sub = { teamId, requestId: id, activity, replay: fromSeq !== undefined };
      })
      .then((answer) => {
        if (conn.sub?.requestId !== requestId) {
          return; // replaced (L8) — the newer subscription is the one that counts
        }
        const outcome = outcomeOf(answer);
        if (outcome.kind === 'refused' && outcome.code === 'resnapshot_required') {
          this.subscribe(host, conn, teamId, undefined);
          return;
        }
        // Ended by the host (an unsubscribe, the team ended or moved): the next list poll decides.
        conn.sub = undefined;
        this.dropLiveOf(host.key);
        if (outcome.kind === 'refused') {
          this.opts.log(`[team] subscription to ${teamId} ended: ${outcome.code}`);
        }
      });
  }

  /* ---- notifications ---- */

  private onNotification(host: HostEntry, method: string, params: Record<string, unknown>): void {
    const conn = host.conn;
    if (conn === undefined) {
      return;
    }
    if (method === METHOD_TEAM.host) {
      const state = str(params.state, 32);
      const reason = str(params.reason, 64);
      this.opts.log(`[team] host pid ${host.record.hostPid}: ${state ?? '?'}${reason ? ` (${reason})` : ''}`);
      if (reason === 'lease-lost' || state === 'ending') {
        void this.pollList(host);
      }
      return;
    }
    const sub = conn.sub;
    if (sub === undefined || params.requestId !== sub.requestId || params.teamId !== sub.teamId) {
      return;
    }
    const team = this.live.get(sub.teamId);
    if (team === undefined) {
      return;
    }
    if (method === METHOD_TEAM.activity) {
      const member = typeof params.member === 'string' && MEMBER_NAME.test(params.member) ? params.member : undefined;
      if (member !== undefined && this.activityWanted.get(sub.teamId)?.has(member)) {
        const items = feedItemsOf(params.items);
        for (const listener of this.activityListeners) {
          try {
            listener(sub.teamId, member, items);
          } catch {
            // one listener's defect is its own
          }
        }
      }
      return;
    }
    if (method !== METHOD_TEAM.event) {
      return;
    }
    const kind = str(params.kind, 64);
    const seq = count(params.seq);
    if (kind === 'snapshot') {
      const state = teamStateOf(params.state);
      if (state !== undefined && state.id === sub.teamId) {
        team.state = state;
        if (!sub.replay) {
          team.lastEventSeq = Math.max(team.lastEventSeq, state.seq);
        }
        this.changed();
      }
      return;
    }
    if (kind === undefined) {
      return;
    }
    team.lastEventSeq = Math.max(team.lastEventSeq, seq);
    const data = isRecord(params.data) ? params.data : {};
    const ts = finite(params.ts) ?? Date.now();
    if (kind === 'msg.posted' && seq > 0 && !team.messages.has(seq)) {
      const message = messageOf(seq, ts, data);
      if (message !== undefined) {
        team.messages.set(seq, message);
        if (team.messages.size > TEAM_MESSAGES_KEPT * 2) {
          for (const old of [...team.messages.keys()].sort((a, b) => a - b).slice(0, team.messages.size - TEAM_MESSAGES_KEPT)) {
            team.messages.delete(old);
          }
        }
        if (message.kind === 'notice') {
          const notice = oneOf(data.notice, NOTICE_KINDS);
          if (notice === 'blocked' || notice === 'idle' || notice === 'context-lost' || notice === 'suspended') {
            // The notice's own text names whom it is about; its recipient is the lead, not a member.
            this.notice(sub.teamId, team, notice, ts, message.body, undefined);
          }
        }
      }
    } else if (kind === 'member.mailbox' && data.mailbox === 'turns-only') {
      this.notice(sub.teamId, team, 'turns-only', ts, str(data.reason), str(data.name, NAME_KEPT));
    } else if (kind === 'team.status' && data.status === 'suspended') {
      this.notice(sub.teamId, team, 'suspended', ts, str(data.reason), undefined);
    }
    // A14: the event is a change signal; the state shown is the engine's own projection.
    this.scheduleSnapshot(sub.teamId);
  }

  /** §8.1: at most one notification per team per FRONTEND_NOTIFY_INTERVAL_MS; replays of old events are not announced. */
  private notice(
    teamId: string,
    team: LiveTeam,
    kind: TeamNoticeKind,
    ts: number,
    text: string | undefined,
    member: string | undefined,
  ): void {
    const now = Date.now();
    if (now - ts > NOTICE_RECENT_MS) {
      return;
    }
    const last = this.lastNoticeAt.get(teamId);
    if (last !== undefined && now - last >= 0 && now - last < FRONTEND_NOTIFY_INTERVAL_MS) {
      return;
    }
    this.lastNoticeAt.set(teamId, now);
    const notice: TeamNotice = {
      teamId,
      teamName: team.state?.name ?? teamId,
      kind,
      text,
      member:
        member !== undefined && MEMBER_NAME.test(member) && !(RESERVED_NAMES as readonly string[]).includes(member)
          ? member
          : undefined,
    };
    for (const listener of this.noticeListeners) {
      try {
        listener(notice);
      } catch {
        // one listener's defect is its own
      }
    }
  }

  /** A14: re-read the snapshot, at most twice a second, one read in flight at a time. */
  private scheduleSnapshot(teamId: string): void {
    const team = this.live.get(teamId);
    if (team === undefined) {
      return;
    }
    if (team.getting || team.timer !== undefined) {
      team.dirty = true;
      return;
    }
    const wait = SNAPSHOT_MIN_INTERVAL_MS - (Date.now() - team.lastGetAt);
    if (wait > 0) {
      team.timer = setTimeout(() => {
        team.timer = undefined;
        void this.readSnapshot(teamId);
      }, wait);
      return;
    }
    void this.readSnapshot(teamId);
  }

  private async readSnapshot(teamId: string): Promise<void> {
    const team = this.live.get(teamId);
    const conn = team === undefined ? undefined : this.hosts.get(team.hostKey)?.conn;
    if (team === undefined || conn === undefined || conn.closed) {
      return;
    }
    team.getting = true;
    team.dirty = false;
    team.lastGetAt = Date.now();
    const got = outcomeOf(await conn.request(METHOD_TEAM.get, { teamId }));
    team.getting = false;
    const state = got.kind === 'ok' ? teamStateOf(got.result.state) : undefined;
    if (state !== undefined && state.id === teamId && this.live.get(teamId) === team) {
      team.state = state;
      this.changed();
    }
    if (team.dirty) {
      this.scheduleSnapshot(teamId);
    }
  }

  /* ---- teams on disk (§2.4, L7) ---- */

  /** Re-read `teams/*` for this workspace; true when what it holds changed. */
  private scanTeams(folder: string | undefined): boolean {
    if (folder === undefined) {
      const had = this.disk.size > 0;
      this.disk.clear();
      return had;
    }
    let names: string[];
    try {
      names = fs.readdirSync(teamsDirOf(this.opts.dataRoot)).slice(0, TEAM_DIR_SCAN_MAX);
    } catch {
      names = [];
    }
    let changed = false;
    const found = new Set<string>();
    for (const teamId of names) {
      if (!TEAM_ID.test(teamId)) {
        continue;
      }
      const dir = path.join(teamsDirOf(this.opts.dataRoot), teamId);
      let header = this.headers.get(teamId);
      if (header === undefined) {
        header = this.readHeader(dir, teamId);
        if (header !== undefined) {
          this.headers.set(teamId, header);
        }
      }
      if (header === undefined || header === null || !(related(header.workspace, folder) || related(header.repoRoot, folder))) {
        continue;
      }
      const file = path.join(dir, TEAM_DIR_ENTRIES.state);
      let stamp: string;
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile()) {
          continue;
        }
        stamp = `${st.size}:${st.mtimeMs}:${st.ino}`;
      } catch {
        continue;
      }
      found.add(teamId);
      const known = this.disk.get(teamId);
      if (known !== undefined && known.stamp === stamp) {
        continue;
      }
      const read = readTextSafe(file, STATE_MAX, { noFollow: true });
      let state: TeamState | undefined;
      if (read.ok) {
        try {
          state = teamStateOf(JSON.parse(read.text));
        } catch {
          state = undefined;
        }
      }
      if (state === undefined || state.id !== teamId) {
        // A state.json being replaced (temp + rename) or of another shape: keep what was known.
        continue;
      }
      this.disk.set(teamId, { state, stamp });
      changed = true;
    }
    for (const teamId of [...this.disk.keys()]) {
      if (!found.has(teamId)) {
        this.disk.delete(teamId);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * A team's `team.json`, judged: the header; null when it was read and is not a header of this
   * team; UNDEFINED when it could not be judged — not there yet (the engine makes the directory a
   * moment before it renames the header into it), any read error (EMFILE, a refused path), or a
   * text that is not JSON — which the caller must not keep (A38, review S6): kept, that one
   * moment hid a team from this window for the extension's whole life. Never throws.
   */
  private readHeader(dir: string, teamId: string): { workspace: string; repoRoot: string } | null | undefined {
    const read = readTextSafe(path.join(dir, TEAM_DIR_ENTRIES.header), TEAM_HEADER_MAX_BYTES, { noFollow: true });
    if (!read.ok) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(read.text);
    } catch {
      return undefined;
    }
    if (!isRecord(raw) || raw.id !== teamId) {
      return null;
    }
    const workspace = str(raw.workspace);
    const repoRoot = str(raw.repoRoot);
    return workspace !== undefined && repoRoot !== undefined && path.isAbsolute(workspace) && path.isAbsolute(repoRoot)
      ? { workspace, repoRoot }
      : null;
  }

  /** L7 for a team read from disk: `active` believed only with a provably live owner. */
  private believed(state: TeamState): boolean {
    if (state.status !== 'active') {
      return true;
    }
    const owner = state.owner;
    if (owner === null) {
      return false;
    }
    const key = `${owner.hostPid}:${owner.hostStartedAt}`;
    const cached = this.ownerVerdicts.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at >= 0 && now - cached.at < OWNER_VERDICT_MS) {
      return cached.live;
    }
    let live: boolean;
    try {
      live = teamOwnerIsLive(owner, { isAlive: isPidAlive, startedAt: processStartedAt });
    } catch {
      live = false;
    }
    if (this.ownerVerdicts.size > 64) {
      this.ownerVerdicts.clear();
    }
    this.ownerVerdicts.set(key, { at: now, live });
    return live;
  }

  /* ---- plumbing ---- */

  private ownerConnection(teamId: string): HostConnection | undefined {
    const team = this.live.get(teamId);
    const conn = team === undefined ? undefined : this.hosts.get(team.hostKey)?.conn;
    return conn !== undefined && !conn.closed && conn.sub?.teamId === teamId ? conn : undefined;
  }

  private changed(): void {
    this.version += 1;
    if (this.changeTimer !== undefined || this.disposed) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      for (const listener of this.changeListeners) {
        try {
          listener();
        } catch {
          // one listener's defect is its own
        }
      }
    }, CHANGE_COALESCE_MS);
  }
}

/** A request's answer as a caller reads it: a result object, a refusal, or no answer. */
function outcomeOf(answer: Answer): TeamCallOutcome {
  if (answer.kind === 'gone') {
    return { kind: 'unreachable', why: answer.why };
  }
  if (answer.kind === 'error') {
    // Protocol misuse is a JSON-RPC error (MD-54). Two codes have words of the view's own
    // (teamView.refusalText): -32601, a host of an earlier build (§7.6), and roleForbidden; any
    // other keeps the host's message.
    return {
      kind: 'refused',
      code: `rpc:${answer.code ?? '?'}`,
      sentence: answer.code === -32601 || answer.code === RPC_ERROR.roleForbidden ? '' : answer.message,
    };
  }
  const result = isRecord(answer.result) ? answer.result : undefined;
  if (result === undefined) {
    return { kind: 'refused', code: 'bad_answer', sentence: '' };
  }
  if (result.ok === false) {
    return {
      kind: 'refused',
      code: str(result.code, 64) ?? 'refused',
      sentence: str(result.sentence, 1_000) ?? '',
    };
  }
  return { kind: 'ok', result };
}
