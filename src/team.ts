import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ENTRY_APPEAR_GRACE_MS, MESH_STATE_DIR, sessionsDir } from './mesh/contract';
import {
  claudeAccountDirCheck,
  claudeAccounts,
  listDirCapped,
  readMeshWorkerRecords,
  type ClaudeAccountCheck,
} from './mesh/pool';
import { hostConfigDir } from './platform';
import { isPidAlive, readRegistry, ROOT_DIR } from './registry';
import { readTextSafe } from './safeFs';
import { WORKTREES_DIR_NAME } from './team/contract';
import {
  displayString,
  epochMs,
  knownAccounts,
  pathWithin,
  recordedTime,
  taskBrief,
  type KnownAccount,
} from './uiModel';
import type { SessionKey, UiSession, UiSessionSource, UiSessionStatus } from './uiTypes';

/**
 * team — the live sessions across accounts, as rows for the Team tree view and the
 * dashboard's Team lanes.
 *
 * Three sources, merged in this order (a later source never replaces an earlier row):
 *
 *  1. WORKERS   — `claude --bg` sessions this extension dispatched: the mesh ledger, joined
 *                 with the platform's session registry (is it alive, is it mid-turn) and
 *                 with the task log (what it was asked to do).
 *  2. TEAMMATES — members of a native Claude Code agent team, read from the team config.
 *  3. PEERS     — every other live session of a known account — except the Claude members of a
 *                 Claude Code Orchestrator team (team contract §8.1): their sessions work in
 *                 worktrees under `<data root>/worktrees/` and are listed under Teams, not twice.
 *
 * All three are CLAUDE CODE sessions. Accounts on another vendor's CLI (Codex, Cursor,
 * Antigravity) are dispatched one-shot and have no session to show, so they are not scanned.
 *
 * Two of those three are files this product does not own and whose shape is undocumented
 * (the session registry, the team config). So every read here is CAPPED, every value is
 * read by `typeof`, and nothing throws: a file of another shape contributes no rows. And a
 * listing that could not be completed is never silently short — it adds a row that says so
 * (a session directory holding tens of thousands of leaked files is a state earlier
 * versions really produced), because "not listed" must not be mistaken for "not running".
 *
 * Rows carry display-safe values only (`uiTypes.ts`). Everything a command needs to ACT on
 * a session — its config dir, job id, worktree path — stays on the host in `resolveSession`,
 * keyed by an opaque `SessionKey`, and each of those values is checked before it is kept: a
 * config dir must be one of the known accounts', a job id and a branch must have the shape
 * of one, because the caller will put them on a command line.
 *
 * Must not import `vscode`.
 */

export interface TeamOptions {
  workspaceRoot: string | undefined;
  scope: 'workspace' | 'all';
  now?: number;
  /** Cache TTL in ms, default 3000. */
  maxAgeMs?: number;
}

/** What the host needs to act on a session row. Never sent to a webview. */
export interface ResolvedSession {
  key: SessionKey;
  source: UiSessionSource;
  /** The name `SendMessage` takes. */
  name: string;
  /** Config dir of a KNOWN account (the registry's string verbatim), else undefined. */
  configDir: string | undefined;
  /** Background job id, shape-checked; undefined when the session has none. */
  jobId: string | undefined;
  /** Absolute worktree directory, only while it exists on disk and is inside its workspace. */
  worktreeAbs: string | undefined;
  /** Result branch, shape-checked. */
  branch: string | undefined;
  /** Workspace of a worker; working directory of a teammate or peer. Absolute. */
  cwd: string | undefined;
  taskId: string | undefined;
}

/* ------------------------------------------------------------------------- *
 * Bounds
 * ------------------------------------------------------------------------- */

const DEFAULT_MAX_AGE_MS = 3_000;

/**
 * Directory entries examined per account's `sessions/`. Past it the listing is reported
 * incomplete rather than read on: v1.x usage probes leaked 18,000–77,000 files into these
 * directories, and this runs synchronously on the extension host every few seconds. Of the
 * entries examined, only those of a process that is still there are opened (scanSessions).
 */
const SESSION_FILES_MAX = 2_000;

/** One session entry is a few hundred bytes; 64 KiB is ~100x that. */
const SESSION_ENTRY_MAX_BYTES = 64 * 1024;

const TEAMS_MAX = 50;
const TEAM_CONFIG_MAX_BYTES = 64 * 1024;
const TEAM_MEMBERS_MAX = 100;

/** Workspace ledgers read for scope 'all' (one file per workspace that ever ran a worker). */
const LEDGERS_MAX = 200;
/** Directory entries examined in the ledger directory (it also holds lock and temp files). */
const LEDGER_DIR_ENTRIES_MAX = 2_000;
/** Same ceiling mesh/pool applies to a ledger (its MESH_STATE_FILE_MAX_BYTES). */
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const LEDGER_RECORDS_MAX = 500;

/** Cached collections kept (one per scope × workspace; two consumers use different scopes). */
const COLLECTIONS_MAX = 4;

/**
 * How long the keys of a collection keep resolving after it was made. Any VISIBLE consumer
 * re-collects every few seconds, so a collection this old belongs to a view nobody is
 * looking at, and what it describes (a config dir, a job id) should no longer be acted on.
 */
const RESOLVE_MAX_AGE_MS = 10 * 60_000;

const KEY_MAX = 160;

/** The pinned text of the row that makes a cut-short session listing visible. */
const INCOMPLETE_NAME = '(session list incomplete — run "Clean up stale session files")';

/** The same kind of row for the two other listings, where that advice would be wrong. */
const INCOMPLETE_OTHER: Record<UiSessionSource, string> = {
  worker: '(worker list incomplete)',
  teammate: '(team list incomplete)',
  peer: '(session list incomplete)',
};

/**
 * A background job id. Today it is the first 8 hex of the session id (P8/P10), but that is
 * the platform's choice and may change, so this pins only what SAFETY needs: letters, digits,
 * `-` and `_`, not starting with a dash. The id ends up as an ARGUMENT of
 * `claude attach|logs|stop`, in a terminal; a ledger is a hand-editable file, and a "job id"
 * of `;rm -rf ~` or `--help` must never be handed to a caller as one.
 */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A git branch name we are willing to hand to `git diff` (no leading dash, no `..`). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

const TASK_ID_RE = /^t[a-z0-9]{6,24}$/;

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * One property of the caller's options, or undefined. Property access is the one thing a
 * caller's object can make throw before any guard here runs; an option that cannot be read
 * is an absent option.
 */
function option(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** An absolute, resolved directory path — or undefined. Relative values are refused. */
function absoluteDir(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096 || raw.includes('\u0000')) {
    return undefined;
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : undefined;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jobIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && JOB_ID_RE.test(value) ? value : undefined;
}

function branchOf(value: unknown): string | undefined {
  return typeof value === 'string' && BRANCH_RE.test(value) && !value.includes('..') ? value : undefined;
}

/**
 * A label for where a session works: relative to the workspace when it is inside it, else
 * the folder's own name. NEVER an absolute path — the page must not hold a string it could
 * post back as a filesystem target — so anything that still reads as absolute is dropped.
 */
function locationLabel(dir: string | undefined, root: string | undefined): string | null {
  if (dir === undefined) {
    return null;
  }
  let label: string;
  if (root !== undefined && pathWithin(dir, root)) {
    const relative = path.relative(root, dir);
    label = relative === '' ? path.basename(root) : relative.split(path.sep).join('/');
  } else {
    label = path.basename(dir);
  }
  const shown = displayString(label, 120);
  return shown === '' || path.posix.isAbsolute(shown) || path.win32.isAbsolute(shown) ? null : shown;
}

/**
 * The name a command may use for a session. The recorded name is returned verbatim only when
 * it is ALREADY exactly what the row displays; otherwise the displayed text is. So the name
 * the user copies is always the name they were shown, and a name carrying invisible or
 * control characters never reaches a clipboard or a command through this module.
 */
function addressable(raw: string | undefined, shown: string): string {
  return raw !== undefined && displayString(raw, 80) === raw ? raw : shown;
}

/* ------------------------------------------------------------------------- *
 * The platform's session registry (`<configDir>/sessions/<pid>.json`)
 * ------------------------------------------------------------------------- */

/** The fields of a LIVE session entry this module reads, each already type-checked. */
interface LiveEntry {
  pid: number;
  /** `''` when the entry names none. */
  sessionId: string;
  cwd: string | undefined;
  /** `''` when the entry names none. */
  kind: string;
  name: string | undefined;
  jobId: string | undefined;
  status: string | undefined;
  waitingFor: string | undefined;
  model: string | undefined;
  startedAt: number | null;
  updatedAt: number | null;
  /** Has a messaging socket: a real, addressable session (probe litter has none — P3). */
  hasSocket: boolean;
  /** A copy the bridge wrote into another account's directory, not that account's session. */
  mirror: boolean;
}

/** The largest value a process id can have on any platform this runs on (a signed 32-bit int). */
const PID_MAX = 0x7fffffff;

/** `<pid>.json` with the pid in canonical decimal: digits only, no sign, no leading zero. */
const SESSION_ENTRY_NAME = /^([1-9][0-9]{0,9})\.json$/;

/**
 * The process a session entry belongs to, read off its FILE NAME — the platform names an
 * entry `<pid>.json` — or undefined for a name that is not one. The name, not a field of the
 * file: it is known before anything is opened, and it is what lets a scan pass over the
 * entries of processes that are gone without reading them.
 */
function pidOfEntryName(name: string): number | undefined {
  const found = SESSION_ENTRY_NAME.exec(name);
  if (found === null) {
    return undefined;
  }
  const pid = Number(found[1]);
  return pid <= PID_MAX ? pid : undefined;
}

/**
 * One parsed entry of the live process `pid` → a row's worth of it, or undefined (not an
 * object, or an entry that says it is some other process's).
 *
 * `pid` is the one its file name states, already known to be alive. A `pid` field inside the
 * file is only checked against it: an entry that names another process is not this one's.
 *
 * Deliberately NOT `contract.parseSessionEntry`. That is the strict parse the bridge needs
 * before it COPIES an entry (it demands `version`, `peerProtocol`, …); a listing needs only
 * a live process and whatever else happens to be there. The format is the platform's and
 * undocumented, so every field is optional here and a release that renames one costs a
 * column, not the whole view. The two times are read as times (uiModel.recordedTime).
 */
function liveEntry(raw: unknown, pid: number, readAt: number): LiveEntry | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const bag = raw;
  if (bag.pid !== undefined && bag.pid !== pid) {
    return undefined;
  }
  return {
    pid,
    sessionId: text(bag.sessionId) ?? '',
    cwd: text(bag.cwd),
    kind: text(bag.kind) ?? '',
    name: text(bag.name),
    jobId: jobIdOf(bag.jobId),
    status: text(bag.status),
    waitingFor: text(bag.waitingFor),
    model: text(bag.model),
    startedAt: recordedTime(bag.startedAt, readAt),
    updatedAt: recordedTime(bag.updatedAt, readAt),
    hasSocket: text(bag.messagingSocketPath) !== undefined,
    mirror: bag.ccoMirror === true,
  };
}

/**
 * Read the entry of process `pid` in a sessions directory. `unreadable` is true when the
 * process is there, something IS at its entry's name, and those bytes could not be read
 * (oversized, a FIFO, EACCES): that is not the same fact as "no such session", and the one
 * caller that concludes "stopped" from an absence needs to know the difference.
 *
 * LIVENESS IS ASKED FIRST, of the pid the name states. A process that is gone has no session,
 * whatever a file left under its name says, so that file is not opened at all: a sessions
 * directory can hold thousands of entries of dead processes (usage probes of earlier versions
 * left them), and opening each of them to find its pid made every poll of the Team view read
 * thousands of files on the extension host.
 */
function readEntryFile(
  dir: string,
  pid: number,
  readAt: number,
): { entry: LiveEntry | undefined; unreadable: boolean } {
  if (!isPidAlive(pid)) {
    return { entry: undefined, unreadable: false };
  }
  // A session entry is a file the CLI writes under a name of its own (`<pid>.json`) in its own
  // directory; a symbolic link at that name is not followed — it reads as "something is there
  // that could not be read", never as the file it points at.
  const read = readTextSafe(path.join(dir, `${pid}.json`), SESSION_ENTRY_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return { entry: undefined, unreadable: read.reason !== 'absent' };
  }
  try {
    return { entry: liveEntry(JSON.parse(read.text), pid, readAt), unreadable: false };
  } catch {
    // read whole and not JSON — positively not a session entry
    return { entry: undefined, unreadable: false };
  }
}

/**
 * Run `work` with no stack trace captured for the errors raised inside it, and put the limit
 * back. Asking whether a process exists (`process.kill(pid, 0)`) answers "no" by THROWING, and
 * most of what such a throw costs is the stack trace nobody reads: a scan that asks it of
 * thousands of dead pids takes a fraction of the time without. Synchronous work only —
 * nothing else runs in between, so no other code ever sees the changed limit.
 */
function withoutStackTraces<T>(work: () => T): T {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return work();
  } finally {
    Error.stackTraceLimit = limit;
  }
}

interface AccountScan {
  entries: LiveEntry[];
  /** False when the listing was cut short or refused: absence from `entries` proves nothing. */
  complete: boolean;
  /** Why it is incomplete, for the row that reports it. */
  problem: string | null;
}

/**
 * The live sessions of one account. Each entry examined is first a NAME: one that is not
 * `<pid>.json` is passed over, and so is one whose process is gone — neither is opened
 * (pidOfEntryName, readEntryFile). What is read is the entries of processes that exist.
 */
function scanSessions(configDir: string, readAt: number): AccountScan {
  const dir = sessionsDir(configDir);
  const listing = listDirCapped(dir, SESSION_FILES_MAX);
  if (!listing.ok) {
    // A directory that is not there is an honest empty; one we were refused is not.
    return listing.absent
      ? { entries: [], complete: true, problem: null }
      : { entries: [], complete: false, problem: 'the session directory could not be read' };
  }
  const entries: LiveEntry[] = [];
  withoutStackTraces(() => {
    for (const name of listing.names) {
      const pid = pidOfEntryName(name);
      if (pid === undefined) {
        continue;
      }
      const { entry } = readEntryFile(dir, pid, readAt);
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
  });
  // Directory order is the filesystem's business; ours must not change between two scans of
  // an unchanged directory (the dashboard re-posts its model only when it differs).
  entries.sort(
    (a, b) => a.pid - b.pid || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  return {
    entries,
    complete: !listing.truncated,
    problem: listing.truncated
      ? `only the first ${SESSION_FILES_MAX} files of the session directory were read`
      : null,
  };
}

function isBackgroundKind(kind: string): boolean {
  return kind === 'bg' || kind === 'background';
}

function entryStatus(entry: LiveEntry): UiSessionStatus {
  return entry.status === 'busy' || entry.status === 'waiting' || entry.status === 'idle'
    ? entry.status
    : 'unknown';
}

/** First 8 characters of a session id when they are hex (a UUID's are), else a hash of it. */
function sessionTag(sessionId: string): string {
  return /^[0-9a-f]{8}/i.test(sessionId)
    ? sessionId.slice(0, 8).toLowerCase()
    : shortHash(sessionId).slice(0, 8);
}

/* ------------------------------------------------------------------------- *
 * The mesh ledger
 * ------------------------------------------------------------------------- */

/** One ledger record, reduced to what a row needs; every field re-checked by type. */
interface LedgerRecord {
  name: string;
  account: string | undefined;
  configDir: string;
  jobId: string;
  pid: number | undefined;
  model: string | undefined;
  spawnedAt: number;
  stoppedAt: number | undefined;
  settledAt: number | undefined;
  taskId: string | undefined;
  worktree: string | undefined;
  branch: string | undefined;
  /** Workspace whose ledger holds the record (worktree paths are relative to it). */
  stateCwd: string | undefined;
}

/**
 * A raw ledger record → one we can list, or undefined. Read defensively on purpose even for
 * records `readMeshWorkerRecords` already validated: the ledger's shape is changing across
 * versions (`settledAt` is new, `keepAlive` is gone) and scope 'all' parses files itself.
 *
 * The REQUIRED fields are the pool reader's own (name, account, configDir, jobId, model,
 * role as strings; a finite spawnedAt), so the two scopes cannot disagree about what a
 * record is. On top of that, a record without a job id of the right shape cannot be joined,
 * keyed or acted on, and is not listed.
 */
function ledgerRecord(raw: unknown, stateCwd: string | undefined): LedgerRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const name = text(raw.name);
  const configDir = text(raw.configDir);
  const jobId = jobIdOf(raw.jobId);
  const spawnedAt = epochMs(raw.spawnedAt);
  if (
    name === undefined ||
    configDir === undefined ||
    jobId === undefined ||
    spawnedAt === null ||
    typeof raw.account !== 'string' ||
    typeof raw.model !== 'string' ||
    typeof raw.role !== 'string'
  ) {
    return undefined;
  }
  const worktree = text(raw.worktree);
  return {
    name,
    account: text(raw.account),
    configDir,
    jobId,
    pid: typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : undefined,
    model: text(raw.model),
    spawnedAt,
    // "Stopped" and "settled" are what the ledger's owner means by them: the field holds a
    // finite number. Whether that number is also a showable timestamp is a separate question,
    // asked where it is displayed.
    stoppedAt: finiteNumber(raw.stoppedAt),
    settledAt: finiteNumber(raw.settledAt),
    taskId: typeof raw.taskId === 'string' && TASK_ID_RE.test(raw.taskId) ? raw.taskId : undefined,
    worktree:
      worktree !== undefined && worktree.length <= 1024 && !worktree.includes('\u0000')
        ? worktree
        : undefined,
    branch: branchOf(raw.branch),
    stateCwd,
  };
}

/**
 * The records to list. `incomplete` is set when more ledgers exist than were read.
 *
 * Scope 'workspace' reads this workspace's ledger through the pool's own reader. Scope 'all'
 * has to open every state file itself, because a ledger is addressed by a hash of its
 * workspace path and that path is only written INSIDE the file.
 */
function readLedgers(
  root: string | undefined,
  scope: 'workspace' | 'all',
): { records: LedgerRecord[]; incomplete: boolean } {
  const records: LedgerRecord[] = [];
  if (scope === 'workspace') {
    if (root !== undefined) {
      for (const raw of readMeshWorkerRecords(root).slice(0, LEDGER_RECORDS_MAX)) {
        const record = ledgerRecord(raw, root);
        if (record !== undefined) {
          records.push(record);
        }
      }
    }
    return { records, incomplete: false };
  }
  const listing = listDirCapped(MESH_STATE_DIR, LEDGER_DIR_ENTRIES_MAX);
  if (!listing.ok) {
    return { records, incomplete: !listing.absent };
  }
  const files = listing.names.filter((name) => name.endsWith('.json')).sort();
  for (const file of files.slice(0, LEDGERS_MAX)) {
    // A ledger is this product's own file under a name it builds in its own directory: a
    // symbolic link at that name is not followed.
    const read = readTextSafe(path.join(MESH_STATE_DIR, file), LEDGER_MAX_BYTES, { noFollow: true });
    if (!read.ok) {
      continue;
    }
    let state: unknown;
    try {
      state = JSON.parse(read.text);
    } catch {
      continue;
    }
    if (!isRecord(state) || !Array.isArray(state.workers)) {
      continue;
    }
    const stateCwd = absoluteDir(state.cwd);
    for (const raw of state.workers.slice(0, LEDGER_RECORDS_MAX)) {
      const record = ledgerRecord(raw, stateCwd);
      if (record !== undefined) {
        records.push(record);
      }
    }
  }
  return { records, incomplete: listing.truncated || files.length > LEDGERS_MAX };
}

/* ------------------------------------------------------------------------- *
 * Collection
 * ------------------------------------------------------------------------- */

interface Collection {
  seq: number;
  /** The caller's clock at collection (`now`), for the TTL. */
  at: number;
  /** The wall clock at collection, for how long its keys keep resolving. */
  wall: number;
  fresh: boolean;
  rows: UiSession[];
  resolved: Map<SessionKey, ResolvedSession>;
}

/** The rows of one pass, with the "first row wins" rule in one place. */
class Rows {
  readonly rows: UiSession[] = [];
  readonly resolved = new Map<SessionKey, ResolvedSession>();
  private readonly keys = new Set<SessionKey>();

  /** Adds the row unless its key is already taken. `resolved` is omitted for rows that are not sessions. */
  add(row: UiSession, resolved?: Omit<ResolvedSession, 'key' | 'source'>): boolean {
    if (this.keys.has(row.key)) {
      return false;
    }
    this.keys.add(row.key);
    this.rows.push(row);
    if (resolved !== undefined) {
      this.resolved.set(row.key, { key: row.key, source: row.source, ...resolved });
    }
    return true;
  }
}

/**
 * A row that is not a session: it reports that a listing could not be completed. Given an
 * account it is that account's session directory (the pinned text, which names the fix);
 * without one it is the ledger or team listing of `source`. It has no entry in
 * `resolveSession`, so every action on it is a no-op.
 */
function incompleteRow(
  source: UiSessionSource,
  account: KnownAccount | undefined,
  detail: string,
): UiSession {
  return {
    key: account === undefined ? `${source}:incomplete` : `${source}:${account.key}:incomplete`,
    source,
    name: account === undefined ? INCOMPLETE_OTHER[source] : INCOMPLETE_NAME,
    accountKey: account?.key ?? null,
    accountName: account?.label ?? '-',
    kind: source === 'worker' ? 'background' : source === 'teammate' ? 'teammate' : 'interactive',
    status: 'unknown',
    detail: displayString(detail, 160) || null,
    taskId: null,
    taskTitle: null,
    model: null,
    startedAt: null,
    updatedAt: null,
    location: null,
    branch: null,
    unmerged: false,
    settled: false,
    // Not a property of any one folder: it must survive whatever scope filter a view applies.
    inWorkspace: true,
    canAttach: false,
    canStop: false,
    team: null,
    role: null,
  };
}

interface Context {
  root: string | undefined;
  scope: 'workspace' | 'all';
  now: number;
  /** The wall clock of this pass: what a timestamp out of a file is held against (recordedTime). */
  readAt: number;
  accounts: KnownAccount[];
  /** Known accounts by RESOLVED config dir. */
  accountByDir: Map<string, KnownAccount>;
  /** One scan per account per pass. */
  scan: (account: KnownAccount) => AccountScan;
  /**
   * Is a directory a LEDGER RECORD names a current Claude Code account's? The pool's check
   * (claudeAccountDirCheck). A record whose directory fails it is not looked into at all.
   */
  isClaudeAccountDir: ClaudeAccountCheck;
  /** Entries already shown as a worker — a peer row for the same session would be a duplicate. */
  claimed: Set<LiveEntry>;
  out: Rows;
}

/**
 * The live entry of a worker: the one in the record's OWN config dir whose job id is the
 * record's. Liveness is keyed on the job id, never the name — names are reused across
 * generations. `conclusive: false` means the entry was not found AND we could not finish
 * looking, so "stopped" must not be concluded from it.
 */
function findWorkerEntry(
  record: LedgerRecord,
  configDir: string,
  scan: AccountScan,
  readAt: number,
): { entry: LiveEntry | undefined; conclusive: boolean } {
  const prefix = record.jobId.toLowerCase();
  const matches = (e: LiveEntry): boolean =>
    !e.mirror &&
    (e.jobId !== undefined
      ? e.jobId === record.jobId
      : // An entry that names no job id is still the worker's when it is a background
        // session whose session id starts with the job id — that is what a job id IS (P10).
        isBackgroundKind(e.kind) && e.sessionId.toLowerCase().startsWith(prefix));
  const scanned = scan.entries.find(matches);
  if (scanned !== undefined) {
    return { entry: scanned, conclusive: true };
  }
  let conclusive = scan.complete;
  if (record.pid !== undefined) {
    // The entry of a known pid has a known name, so it can be read directly even when the
    // directory is too full to list. (A pid that is gone has no live entry, and none is read.)
    const direct = readEntryFile(sessionsDir(configDir), record.pid, readAt);
    if (direct.entry !== undefined && matches(direct.entry)) {
      return { entry: direct.entry, conclusive: true };
    }
    conclusive = conclusive && !direct.unreadable;
  }
  return { entry: undefined, conclusive };
}

function collectWorkers(ctx: Context): void {
  const { records, incomplete } = readLedgers(ctx.root, ctx.scope);
  // Newest first; the job id breaks ties so the order is a function of the data alone. A
  // `spawnedAt` that is not a time (recordedTime) orders a record after every one that has
  // one: a value from a ledger file cannot put its record at the head of the list.
  const spawned = (record: LedgerRecord): number => recordedTime(record.spawnedAt, ctx.readAt) ?? 0;
  records.sort((a, b) => spawned(b) - spawned(a) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
  for (const record of records) {
    // The account is the one that OWNS the record's directory in the registry — and only a
    // directory that is a CURRENT Claude Code account's is looked into at all. A ledger
    // record's directory is stored data: it was a Claude Code account's when the record was
    // written, and since then the account may have been removed, the file edited, or the
    // directory may have become the home of a worker on another vendor's CLI, whose
    // `sessions/` is that CLI's own store. For such a record nothing is read from the
    // directory and nothing is ever run against it (the same rule the dispatch server applies
    // to its ledger): the row has no account, cannot be attached or stopped, and its state is
    // "unknown" unless the ledger itself recorded the stop.
    const account = ctx.isClaudeAccountDir(record.configDir)
      ? ctx.accountByDir.get(path.resolve(record.configDir))
      : undefined;
    const found =
      account !== undefined
        ? findWorkerEntry(record, account.configDir, ctx.scan(account), ctx.readAt)
        : { entry: undefined, conclusive: false };
    const entry = found.entry;

    let status: UiSessionStatus;
    if (entry !== undefined) {
      status = entryStatus(entry);
    } else if (record.stoppedAt !== undefined) {
      status = 'stopped';
    } else if (!found.conclusive) {
      status = 'unknown';
    } else {
      // A worker is recorded before its session has registered itself; for that short
      // window "no entry" means "not yet", not "gone".
      const age = ctx.now - record.spawnedAt;
      status = age >= 0 && age < ENTRY_APPEAR_GRACE_MS ? 'unknown' : 'stopped';
    }

    // The worktree path on a record is workspace-relative. It names a worktree of THIS
    // ledger's workspace only if it resolves strictly inside it (the rule of
    // reaper.keptWorktree); disk existence — not the record's own flag — is what "unmerged"
    // means.
    let worktreeAbs: string | undefined;
    if (record.stateCwd !== undefined && record.worktree !== undefined) {
      const candidate = path.resolve(record.stateCwd, record.worktree);
      if (pathWithin(candidate, record.stateCwd, true)) {
        worktreeAbs = candidate;
      }
    }
    const unmerged = worktreeAbs !== undefined && isDirectory(worktreeAbs);
    if (status === 'stopped' && !unmerged) {
      continue; // nothing live and nothing left to merge: history, not team
    }

    const brief = record.taskId === undefined ? undefined : taskBrief(record.taskId);
    const inWorkspace =
      ctx.root !== undefined && record.stateCwd !== undefined && pathWithin(record.stateCwd, ctx.root);
    const shownName = displayString(record.name, 80) || '-';
    // Reachable at all: the record's directory is a current Claude Code account's.
    const reachable = account !== undefined;
    // Attach and logs open a LIVE session. A worker that is stopped has no process to attach
    // to — `claude attach` on it only fails in the user's terminal — so neither is offered;
    // what a stopped worker still has is its result branch, and that is what its row keeps
    // (it is listed at all only while its worktree exists, and Diff goes by the branch).
    // `unknown` is not "stopped": a session whose state could not be read may well be alive.
    const live = status !== 'stopped';
    if (entry !== undefined) {
      ctx.claimed.add(entry);
    }
    ctx.out.add(
      {
        key: `worker:${record.jobId}`,
        source: 'worker',
        name: shownName,
        accountKey: account?.key ?? null,
        accountName: account?.label ?? (displayString(record.account, 64) || '-'),
        kind: 'background',
        status,
        detail: status === 'waiting' ? displayString(entry?.waitingFor, 160) || null : null,
        taskId: record.taskId ?? null,
        taskTitle: brief?.title ?? null,
        model: displayString(record.model, 64) || null,
        startedAt: recordedTime(record.spawnedAt, ctx.readAt),
        updatedAt:
          entry?.updatedAt ??
          recordedTime(record.stoppedAt, ctx.readAt) ??
          recordedTime(record.settledAt, ctx.readAt),
        location: inWorkspace
          ? locationLabel(worktreeAbs ?? record.stateCwd, ctx.root)
          : locationLabel(record.stateCwd, undefined),
        branch: record.branch ?? null,
        unmerged,
        settled: record.settledAt !== undefined || (brief !== undefined && brief.status !== 'running'),
        inWorkspace,
        canAttach: reachable && live,
        canStop: reachable && live,
        team: null,
        role: null,
      },
      {
        name: addressable(record.name, shownName),
        configDir: account?.configDir,
        jobId: record.jobId,
        worktreeAbs: unmerged ? worktreeAbs : undefined,
        branch: record.branch,
        cwd: record.stateCwd,
        taskId: record.taskId,
      },
    );
  }
  if (incomplete) {
    ctx.out.add(incompleteRow('worker', undefined, 'not every workspace ledger could be read'));
  }
}

/**
 * Native agent-team members (P17). The config is Claude Code's own file, experimental and
 * undocumented: a config that is not an object, or whose `members` is not an array,
 * contributes nothing, and each member is read field by field.
 */
function collectTeammates(ctx: Context): void {
  const main = ctx.accounts.find((a) => a.isMain);
  const teamsDir = path.join(hostConfigDir(), 'teams');
  const listing = listDirCapped(teamsDir, TEAMS_MAX);
  if (!listing.ok) {
    // No teams directory is the normal state (the feature is experimental and opt-in).
    if (!listing.absent) {
      ctx.out.add(incompleteRow('teammate', undefined, 'the team directory could not be read'));
    }
    return;
  }
  if (listing.truncated) {
    ctx.out.add(incompleteRow('teammate', undefined, `only the first ${TEAMS_MAX} teams were read`));
  }
  for (const dirName of [...listing.names].sort()) {
    // Followed if it is a link: the team config is the user's own file, and may be kept as one.
    const read = readTextSafe(path.join(teamsDir, dirName, 'config.json'), TEAM_CONFIG_MAX_BYTES);
    if (!read.ok) {
      continue;
    }
    let config: unknown;
    try {
      config = JSON.parse(read.text);
    } catch {
      continue;
    }
    if (!isRecord(config) || !Array.isArray(config.members)) {
      continue;
    }
    const team = displayString(config.name, 64) || displayString(dirName, 64) || '-';
    const leadAgentId = text(config.leadAgentId);
    for (const member of config.members.slice(0, TEAM_MEMBERS_MAX)) {
      if (!isRecord(member)) {
        continue;
      }
      const agentId = text(member.agentId);
      const rawName = text(member.name);
      const identity = agentId ?? rawName;
      // The lead is the session that owns the team, not a teammate of it.
      if (
        identity === undefined ||
        member.agentType === 'team-lead' ||
        (agentId !== undefined && agentId === leadAgentId)
      ) {
        continue;
      }
      const cwd = absoluteDir(member.cwd);
      const inWorkspace = ctx.root !== undefined && cwd !== undefined && pathWithin(cwd, ctx.root);
      if (ctx.scope === 'workspace' && !inWorkspace) {
        continue;
      }
      const joined = typeof member.joinedAt === 'string' ? Date.parse(member.joinedAt) : member.joinedAt;
      const shownName = displayString(rawName, 80) || '-';
      ctx.out.add(
        {
          key: `teammate:${shortHash(`${dirName}/${identity}`)}`,
          source: 'teammate',
          name: shownName,
          accountKey: main?.key ?? null,
          accountName: main?.label ?? 'main',
          kind: 'teammate',
          status: member.isActive === true ? 'busy' : member.isActive === false ? 'idle' : 'unknown',
          detail: null,
          taskId: null,
          taskTitle: null,
          model: displayString(member.model, 64) || null,
          startedAt: recordedTime(joined, ctx.readAt),
          updatedAt: null,
          location: locationLabel(cwd, inWorkspace ? ctx.root : undefined),
          branch: null,
          unmerged: false,
          settled: false,
          inWorkspace,
          canAttach: false,
          canStop: false,
          team,
          role: displayString(member.agentType, 64) || null,
        },
        {
          name: addressable(rawName, shownName),
          configDir: main?.configDir,
          jobId: undefined,
          worktreeAbs: undefined,
          branch: undefined,
          cwd,
          taskId: undefined,
        },
      );
    }
  }
}

/**
 * Where every team member's worktree lives (team contract §2.1). A Claude member's turn — or its
 * take-over terminal — is a Claude Code session working there; the Teams group shows it.
 */
const TEAM_WORKTREES_ROOT = path.join(ROOT_DIR, WORKTREES_DIR_NAME);

/** Every other live, addressable session of a known account. */
function collectPeers(ctx: Context): void {
  for (const account of ctx.accounts) {
    for (const entry of ctx.scan(account).entries) {
      // No socket: probe litter or a session that cannot be messaged. A mirror: the bridge's
      // copy of another account's session, listed under the account that really runs it.
      if (!entry.hasSocket || entry.mirror || ctx.claimed.has(entry)) {
        continue;
      }
      const cwd = absoluteDir(entry.cwd);
      // A team member's session (§8.1): under Teams, never a second time as a peer.
      if (cwd !== undefined && pathWithin(cwd, TEAM_WORKTREES_ROOT, true)) {
        continue;
      }
      const inWorkspace = ctx.root !== undefined && cwd !== undefined && pathWithin(cwd, ctx.root);
      if (ctx.scope === 'workspace' && !inWorkspace) {
        continue;
      }
      const tag = sessionTag(entry.sessionId);
      const background = isBackgroundKind(entry.kind);
      const status = entryStatus(entry);
      const shownName = displayString(entry.name, 80) || tag;
      const hasJob = background && entry.jobId !== undefined;
      ctx.out.add(
        {
          key: `peer:${account.key}:${entry.pid}:${tag}`,
          source: 'peer',
          name: shownName,
          accountKey: account.key,
          accountName: account.label,
          kind: background ? 'background' : 'interactive',
          status,
          detail: status === 'waiting' ? displayString(entry.waitingFor, 160) || null : null,
          taskId: null,
          taskTitle: null,
          model: displayString(entry.model, 64) || null,
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          location: locationLabel(cwd, inWorkspace ? ctx.root : undefined),
          branch: null,
          unmerged: false,
          settled: false,
          inWorkspace,
          canAttach: hasJob,
          canStop: hasJob,
          team: null,
          role: null,
        },
        {
          name: addressable(entry.name, shownName),
          configDir: account.configDir,
          jobId: hasJob ? entry.jobId : undefined,
          worktreeAbs: undefined,
          branch: undefined,
          cwd,
          taskId: undefined,
        },
      );
    }
  }
}

function collect(root: string | undefined, scope: 'workspace' | 'all', now: number): Rows {
  const out = new Rows();
  if (scope === 'workspace' && root === undefined) {
    return out; // "this workspace" with no workspace is nothing, not everything
  }
  // CLAUDE CODE accounts only. Every row here is a Claude Code session, found in Claude Code's
  // own session registry (`<configDir>/sessions/<pid>.json`); a worker on another vendor's CLI
  // has no such registry — the directory of the same name under a Codex home is that CLI's
  // conversation store — and runs one-shot, so it has no live session to list.
  const accounts = knownAccounts().filter((account) => account.provider === 'claude');
  const accountByDir = new Map<string, KnownAccount>();
  for (const account of accounts) {
    accountByDir.set(path.resolve(account.configDir), account);
  }
  // The check a LEDGER RECORD's directory has to pass before anything is read from it
  // (collectWorkers): membership in the current Claude Code accounts, by the pool's own
  // definition of them and its comparison. Should building it fail, no directory is admitted.
  let isClaudeAccountDir: ClaudeAccountCheck;
  try {
    isClaudeAccountDir = claudeAccountDirCheck(claudeAccounts(readRegistry(), hostConfigDir()));
  } catch {
    isClaudeAccountDir = () => false;
  }
  const readAt = Date.now();
  // One scan per directory per pass, whoever asks first.
  const scans = new Map<string, AccountScan>();
  const scanDir = (configDir: string): AccountScan => {
    const key = path.resolve(configDir);
    let scan = scans.get(key);
    if (scan === undefined) {
      scan = scanSessions(configDir, readAt);
      scans.set(key, scan);
    }
    return scan;
  };
  const ctx: Context = {
    root,
    scope,
    now,
    readAt,
    accounts,
    accountByDir,
    scan: (account) => scanDir(account.configDir),
    isClaudeAccountDir,
    claimed: new Set(),
    out,
  };
  // Each source is total on its own; the guard is so that a defect in one of them costs its
  // rows and says so, instead of blanking the two that worked.
  const sources: [UiSessionSource, (c: Context) => void][] = [
    ['worker', collectWorkers],
    ['teammate', collectTeammates],
    ['peer', collectPeers],
  ];
  for (const [source, run] of sources) {
    try {
      run(ctx);
    } catch {
      out.add(incompleteRow(source, undefined, `the ${source} list could not be assembled`));
    }
  }
  // ONE row per account whose session directory could not be listed in full, so the gap is
  // visible. Every known account has been scanned by now (the peer pass visits them all).
  for (const account of accounts) {
    const scan = scans.get(path.resolve(account.configDir));
    if (scan !== undefined && !scan.complete) {
      out.add(incompleteRow('peer', account, scan.problem ?? 'the session list is incomplete'));
    }
  }
  return out;
}

const collections = new Map<string, Collection>();
let collectionSeq = 0;

/**
 * The live sessions, as display-safe rows. Never throws.
 *
 * Results are cached for `maxAgeMs` (default 3 s) PER scope and workspace: the dashboard
 * and the Team view poll on their own clocks, often with different scopes, and neither
 * should make the other re-scan — or make the other's rows stop resolving.
 */
export function collectSessions(opts: TeamOptions): UiSession[] {
  const root = absoluteDir(option(opts, 'workspaceRoot'));
  const scope = option(opts, 'scope') === 'all' ? 'all' : 'workspace';
  const now = epochMs(option(opts, 'now')) ?? Date.now();
  const maxAgeMs = option(opts, 'maxAgeMs');
  const maxAge =
    typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
      ? maxAgeMs
      : DEFAULT_MAX_AGE_MS;
  const slot = `${scope}\u0000${root ?? ''}`;
  const cached = collections.get(slot);
  if (cached !== undefined && cached.fresh) {
    // A negative age is a clock that went backwards: re-collect rather than trust it.
    const age = now - cached.at;
    if (age >= 0 && age < maxAge) {
      return cached.rows.map((row) => ({ ...row }));
    }
  }
  let result: Rows;
  try {
    result = collect(root, scope, now);
  } catch {
    result = new Rows();
  }
  collections.delete(slot);
  collections.set(slot, {
    seq: ++collectionSeq,
    at: now,
    wall: Date.now(),
    fresh: true,
    rows: result.rows,
    resolved: result.resolved,
  });
  while (collections.size > COLLECTIONS_MAX) {
    const oldest = collections.keys().next();
    if (oldest.done) {
      break;
    }
    collections.delete(oldest.value);
  }
  return result.rows.map((row) => ({ ...row }));
}

/**
 * What the host may act on for a key the page (or a tree node) handed back, or undefined.
 *
 * Exact match against rows this module itself produced — never a parse of the key. "The
 * last collection" is kept per scope and workspace (see collectSessions), and the newest one
 * that lists the key answers; a collection older than ten minutes answers nothing. A key
 * that is not a string, is malformed, or names a row no current listing holds resolves to
 * nothing, and the caller does nothing.
 */
export function resolveSession(key: unknown): ResolvedSession | undefined {
  if (typeof key !== 'string' || key === '' || key.length > KEY_MAX) {
    return undefined;
  }
  let hit: ResolvedSession | undefined;
  let seq = -1;
  const wall = Date.now();
  for (const collection of collections.values()) {
    const age = wall - collection.wall;
    if (age < 0 || age > RESOLVE_MAX_AGE_MS) {
      continue;
    }
    const candidate = collection.resolved.get(key);
    if (candidate !== undefined && collection.seq > seq) {
      hit = candidate;
      seq = collection.seq;
    }
  }
  return hit === undefined ? undefined : { ...hit };
}

/**
 * Make the next `collectSessions` re-read instead of answering from cache (call after an
 * action that changes the list: a stop, a dispatch, a ledger change). Rows already shown
 * keep resolving until that next collection replaces them.
 */
export function invalidateTeamCache(): void {
  for (const collection of collections.values()) {
    collection.fresh = false;
  }
}
