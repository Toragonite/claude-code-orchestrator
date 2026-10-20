import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager, workerPermissionMode } from './workerManager';
import {
  appendTaskNote,
  appendTerminalTaskEvent,
  cancelRunningTask,
  latestEventById,
  latestEventByIdChecked,
  readRegistry,
  readRegistryChecked,
  readStatsChecked,
  readTaskFile,
  REGISTRY_FILE,
  ROOT_DIR,
  STATS_FILE,
  TaskEvent,
  taskEventTeam,
  TASKS_LOG_FILE,
  WorkerProfile,
  workerProvider,
  WorkerStats,
} from './registry';
import {
  accountKeyOf,
  AccountUsage,
  formatTokenCount,
  isElevated,
  isLoginExpired,
  isLoginSuspect,
  isProviderCliMissing,
  loginStateOf,
  ownCacheEntry,
  ownsUsageReading,
  parseAuth,
  readUsageCache,
  runLoginFailureAt,
  USAGE_CACHE_FILE,
  UsageCache,
} from './usage';
import { MESH_STATE_DIR, MeshState, MeshWorkerRecord } from './mesh/contract';
import {
  DIR_SCAN_MAX_ENTRIES,
  MESH_STATE_FILE_MAX_BYTES,
  MESH_STOP_TIMEOUT_MS,
  claudeAccountDirCheck,
  claudeAccounts,
  describeProcFailure,
  listDirCapped,
  removeWorkerJob,
  runMeshProcess,
} from './mesh/pool';
import { flattenOneLine, sliceOneLine } from './displayText';
import { readTextSafe } from './safeFs';
import { markWorkerStopped } from './mesh/reaper';
import { claudeEnv, hostConfigDir, isFrontierModel, sameConfigDir } from './platform';
import { adapterAccountDir, parseProvider, ProviderId, providerInfo } from './providers';
import {
  dispatchWindows,
  listTasks,
  modelLastRanAs,
  rebuildTaskIndex,
  recordedTime,
  TASK_LIST_MAX,
  taskDetail,
  type TaskRow,
} from './uiModel';
import type { UiTaskStatus } from './uiTypes';
import { TEAM_DIR_ENTRIES, teamDirOf } from './mcp/host-protocol';
import type { TeamTurnPause } from './teamClient';

interface WorkerStatRow {
  kind: 'stat';
  worker: string;
  /** Position among the account's rows; part of the tree id, so two rows may share a label. */
  seq?: number;
  label: string;
  description: string;
  icon: string;
  tooltip?: string;
  command?: vscode.Command;
}

/**
 * The row of a registry entry this version cannot use (registry.UnsupportedWorkerEntry). The
 * shape is what the "Remove Registry Entry…" command receives: `index` is the entry's place
 * in `readRegistry().unsupportedWorkers` and `name` its name verbatim (`''` for an entry that
 * has none) — the two things that command checks before it removes anything.
 */
export interface UnsupportedWorkerNode {
  kind: 'unsupportedWorker';
  index: number;
  name: string;
}

/** The row that says the registry could not be read, and why. */
interface RegistryProblemRow {
  kind: 'registryProblem';
  problem: string;
}

/** The closing row that says how many unusable entries are not listed. */
interface UnsupportedRestRow {
  kind: 'unsupportedRest';
  count: number;
}

/**
 * The Workers tree holds accounts and, under each, read-only detail rows; after the accounts,
 * the registry entries this version cannot use; and, in front of everything, one row when the
 * registry itself could not be read.
 */
export type WorkerNode =
  | WorkerProfile
  | WorkerStatRow
  | UnsupportedWorkerNode
  | RegistryProblemRow
  | UnsupportedRestRow;

/*
 * WHICH KIND A NODE IS is decided by where it came from, never by a property it carries. An
 * account node is a registry entry as read — unknown keys and all — so an entry somebody gave
 * a `kind`, an `id` or an `index` key would otherwise be drawn, and acted on, as whatever that
 * key says. Every node is therefore remembered here when the tree makes it or hands it out,
 * and that memory is the ONE answer to what a node is: for drawing it (below), and for the
 * commands that receive it from a menu (isAccountRow, isUnsupportedRow, isWorkersTreeRow).
 *
 * For the same reason the three kinds of row about the registry carry NO tree id. An account's
 * id is built from its name, which in a hand-edited file is any string at all, and two rows
 * with one id make the editor refuse to draw the tree; a row without an id is filed by the
 * editor under its label and position, apart from every row that has one.
 */
const statRows = new WeakSet<object>();
/** Each unusable-entry node → why the entry cannot be used, as the row shows it. */
const unsupportedNodes = new WeakMap<object, string>();
const registryProblemRows = new WeakSet<object>();
const unsupportedRestRows = new WeakSet<object>();
/** Each account node the tree handed out → the registry name it was listed under. */
const accountRows = new WeakMap<object, string>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Is `element` an ACCOUNT row of the Workers tree — an object the tree itself handed to the
 * editor as one? What a command that received a tree element asks before it acts on a worker.
 * A look-alike built anywhere else is not one, whatever keys it carries, and neither is any
 * other row of the tree.
 */
export function isAccountRow(element: unknown): boolean {
  return isObject(element) && accountRows.has(element);
}

/**
 * The registry name an account row was listed under, or undefined for anything that is not
 * one. The name was taken down when the row was made; no key of the element is read here, so
 * nothing the registry file put on the entry can make the row stand for another account.
 */
export function accountRowName(element: unknown): string | undefined {
  return isObject(element) ? accountRows.get(element) : undefined;
}

/** Is `element` the row of a registry entry this version cannot use, as the tree made it? */
export function isUnsupportedRow(element: unknown): element is UnsupportedWorkerNode {
  return isObject(element) && unsupportedNodes.has(element);
}

/**
 * Is `element` ANY row of the Workers tree — an account, a detail row under one, or one of
 * the rows about the registry? For a command of another view: such an element is none of its
 * own rows, and no key on it names a task or a session.
 */
export function isWorkersTreeRow(element: unknown): boolean {
  return (
    isObject(element) &&
    (accountRows.has(element) ||
      statRows.has(element) ||
      unsupportedNodes.has(element) ||
      registryProblemRows.has(element) ||
      unsupportedRestRows.has(element))
  );
}

function isStatRow(node: WorkerNode): node is WorkerStatRow {
  return statRows.has(node);
}

function isUnsupportedNode(node: WorkerNode): node is UnsupportedWorkerNode {
  return unsupportedNodes.has(node);
}

function isRegistryProblemRow(node: WorkerNode): node is RegistryProblemRow {
  return registryProblemRows.has(node);
}

function isUnsupportedRestRow(node: WorkerNode): node is UnsupportedRestRow {
  return unsupportedRestRows.has(node);
}

/** Is this node an account — a usable registry entry — rather than a row this file made? */
function isAccountNode(node: WorkerNode): node is WorkerProfile {
  return (
    !isStatRow(node) && !isUnsupportedNode(node) && !isRegistryProblemRow(node) && !isUnsupportedRestRow(node)
  );
}

/** Unusable entries listed in the tree; a registry file can hold far more elements than rows. */
const UNSUPPORTED_ROWS_MAX = 200;

/**
 * Is `candidate` the directory `root` or something inside it? A path-BOUNDARY test on resolved
 * paths: `root + path.sep`, never `root + '/'` (which matches nothing on Windows) and never a
 * bare prefix (which would put `/work/app-old` inside `/work/app`). Shared by every view that
 * scopes rows to the open workspace.
 */
export function isInsideDir(root: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate === '' || root === '') {
    return false;
  }
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * One stored value as a tree LABEL or DESCRIPTION may show it: a single line with no control,
 * bidi-override or invisible characters (`flattenOneLine`), cut to `max` (`sliceOneLine`), or
 * `-` when no visible text is left.
 *
 * Every value that reaches a row from a file another process writes goes through here — the
 * task log is append-writable by any dispatched worker, the registry and the mesh ledger are
 * hand-editable. `MarkdownString.appendText` protects a TOOLTIP from markdown; nothing protects
 * a label, which renders a right-to-left override as written and a 5,000-character title at
 * full length.
 *
 * Only a string is text: a title that is a number or an object in the log is absent, not
 * "[object Object]". The value is cut to a window BEFORE it is flattened, because the flattener
 * is several regex passes over the whole value and this runs while VS Code draws a row.
 */
export function rowText(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw === '') {
    return '-';
  }
  const window = Math.max(4096, max * 16);
  const bounded = raw.length > window ? raw.slice(0, window) : raw;
  // The trailing trim: a cut can land directly after a space.
  return sliceOneLine(flattenOneLine(bounded), max).trimEnd() || '-';
}

/**
 * Make text that is not ours INERT where the editor draws `$(name)` as an icon: a quick pick's
 * label, description and detail, and the status bar. There `$(sync~spin)` in a model's display
 * name animates, and `$(check) current` imitates this extension's own mark. `$(` becomes
 * `$ (` — the text stays readable, and nothing in it opens an icon any more. For a string that
 * is already one display-safe line; a raw value goes through `pickText`.
 */
export function noIcons(text: string): string {
  return text.replace(/\$\(/g, '$ (');
}

/**
 * `rowText` for a surface that draws icons from text (see `noIcons`): one display-safe line
 * in which no `$(` is left, cut to `max` AFTER the icons were made inert — so the bound holds
 * whatever the value is made of.
 */
export function pickText(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw === '') {
    return '-';
  }
  const window = Math.max(4096, max * 16);
  const bounded = raw.length > window ? raw.slice(0, window) : raw;
  return sliceOneLine(noIcons(flattenOneLine(bounded)), max).trimEnd() || '-';
}

/** How far back from its limit a cut looks for the end of a word (see rowTextCut). */
const CUT_WORD_WINDOW = 12;

/**
 * `rowText` for a value that is a SENTENCE — an error a CLI printed — where a cut must not pass
 * for the end of the text. A value that fits, and one with no visible text at all, is returned
 * exactly as `rowText` returns it. One that does not fit is cut to at most `max` INCLUDING a closing "…", at the end of a word when one
 * ends within the last 12 characters before the limit, else at the limit itself (a path, a
 * hash, a line with no spaces). The full text belongs in the row's hover.
 */
export function rowTextCut(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw === '') {
    return '-';
  }
  const window = Math.max(4096, max * 16);
  const flat = flattenOneLine(raw.length > window ? raw.slice(0, window) : raw);
  if (flat === '') {
    // No visible text in what was looked at — however long the value is: `-`, as `rowText`.
    return '-';
  }
  if (flat.length <= max && raw.length <= window) {
    return flat;
  }
  const room = Math.max(1, Math.floor(max) - 1);
  let head = sliceOneLine(flat, room);
  // A cut that falls between two words keeps the whole of the first; one inside a word goes
  // back to the space before it, when that space is near enough.
  if (flat.length > head.length && flat[head.length] !== ' ') {
    const space = head.lastIndexOf(' ');
    if (space > 0 && space >= head.length - CUT_WORD_WINDOW) {
      head = head.slice(0, space);
    }
  }
  return `${head.trimEnd()}\u2026`;
}

/** Caps of the task fields a row shows — the ones documented on `UiTask` in uiTypes.ts. */
const TASK_TITLE_MAX = 160;
const TASK_WORKER_MAX = 120;
const TASK_MODEL_MAX = 64;
/** Cap for a product or provider name on a row (`UiAccount.providerLabel`). */
const PROVIDER_LABEL_MAX = 32;
/** Cap for an account name on a row (`UiAccount.name`). */
const WORKER_NAME_MAX = 64;
/** Cap for a usage-window label on a row (`UiUsageWindow.label`). */
const WINDOW_LABEL_MAX = 40;
/** Cap for an auth mode on a row. */
const AUTH_MODE_MAX = 32;
/** Cap for a probe error quoted on a row (`UiAccount.loginDetail`). */
const PROBE_ERROR_MAX = 200;
/** Cap for a subscription plan name on a row (`UiAccount.plan`). */
const PLAN_NAME_MAX = 24;
/** Usage windows drawn for one non-Claude account (the usage module stores at most this many). */
const PROVIDER_WINDOWS_SHOWN_MAX = 8;
/** Cap for the last error quoted on an account's Errors row. */
const ERROR_ROW_MAX = 60;
/** Cap for a branch name on a row (`UiTask.branch`). */
export const BRANCH_LABEL_MAX = 120;

/** The three stored strings every task row shows, display-safe and capped. */
export function taskRowText(event: TaskEvent): { title: string; worker: string; model: string } {
  return {
    title: rowText(event.title, TASK_TITLE_MAX),
    worker: rowText(event.worker, TASK_WORKER_MAX),
    model: rowText(event.model, TASK_MODEL_MAX),
  };
}

/**
 * Display name of the CLI that ran a task when that is NOT Claude Code, else undefined. Task
 * events carry `provider` only for another vendor's worker. A value this version does not know
 * (a newer editor wrote it) is shown as written, made display-safe — claiming Claude Code ran
 * a task some other CLI ran would be the wrong way to be tolerant. Both forms come from the
 * shared task index, which keeps the provider of a task past a terminal event that names none.
 */
export function taskProviderLabel(row: TaskRow): string | undefined {
  const known = row.provider === null ? undefined : parseProvider(row.provider);
  if (known !== undefined && known !== 'claude') {
    return rowText(providerInfo(known).label, PROVIDER_LABEL_MAX);
  }
  return row.providerText ?? undefined;
}

/**
 * The model line of a task's hover: the model the task ASKED for and its account, and — only
 * when the task's CLI reported what ran and that is another text — the model that ran. Shared
 * by the Tasks and the Worker History hovers.
 */
export function taskModelLine(row: TaskRow): string {
  return row.modelUsed !== null && row.modelUsed !== row.model
    ? vscode.l10n.t('Model {0} → {1} · Account {2}', row.model, row.modelUsed, row.worker)
    : vscode.l10n.t('Model {0} · Account {1}', row.model, row.worker);
}

/** Where a task's model came from, as one line — or undefined when its events do not say. */
export function taskModelSourceLine(row: TaskRow): string | undefined {
  switch (row.modelSource) {
    case 'dispatch':
      return vscode.l10n.t('Model source: named by the dispatch');
    case 'worker':
      return vscode.l10n.t('Model source: worker default');
    case 'cli':
      return vscode.l10n.t('Model source: CLI default');
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Localized relative times
 * ------------------------------------------------------------------------- */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago an instant was, as a WHOLE localized phrase: "just now", "5m ago", "3h ago",
 * "2d ago" — or an em dash when there is no usable timestamp.
 *
 * The host-side counterpart of usage.formatAge, which returns English and is for the dispatch
 * server's text. A tree row or a tooltip is a localized sentence, and an English fragment set
 * into it reads as two languages at once; this hands that sentence a phrase that is already in
 * the reader's own. (The dashboard page formats from timestamps through its string table and
 * needs neither.)
 *
 * What counts as a usable timestamp is uiModel.recordedTime's rule, the one every surface
 * shares: an instant up to five minutes ahead of `now` — two clocks that disagree a little —
 * is "just now" (it is the newest reading there is, and "in 4m ago" is not a thing to print);
 * one further ahead is not a time at all and gets the dash, never an age.
 */
export function agoText(epochMs: unknown, now: number = Date.now()): string {
  const at = typeof now === 'number' && Number.isFinite(now) ? recordedTime(epochMs, now) : null;
  if (at === null) {
    return '—';
  }
  const ms = now - at;
  if (!(ms >= MINUTE_MS)) {
    return vscode.l10n.t('just now');
  }
  if (ms < HOUR_MS) {
    return vscode.l10n.t('{0}m ago', Math.floor(ms / MINUTE_MS));
  }
  if (ms < DAY_MS) {
    return vscode.l10n.t('{0}h ago', Math.floor(ms / HOUR_MS));
  }
  return vscode.l10n.t('{0}d ago', Math.floor(ms / DAY_MS));
}

/**
 * When an instant given as ISO-8601 text will come, as a WHOLE localized phrase: "now" once it
 * has passed, else "in 12m", "in 2h 5m", "in 3d 4h" — or an em dash when the text is absent or
 * not a date. The host-side counterpart of usage.formatRelativeReset (see agoText).
 */
export function untilText(iso: unknown, now: number = Date.now()): string {
  const at = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) {
    return '—';
  }
  const ms = at - now;
  if (ms <= 0) {
    return vscode.l10n.t('now');
  }
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) {
    return vscode.l10n.t('in {0}m', minutes);
  }
  if (minutes < 24 * 60) {
    return vscode.l10n.t('in {0}h {1}m', Math.floor(minutes / 60), minutes % 60);
  }
  return vscode.l10n.t('in {0}d {1}h', Math.floor(minutes / (24 * 60)), Math.floor((minutes % (24 * 60)) / 60));
}

/** A ledger record plus the workspace whose state file holds it. */
type LedgerRecord = MeshWorkerRecord & { stateCwd?: string };

/**
 * The ledger record of the worker that ran task `taskId`, among `records` — or undefined.
 *
 * THE JOIN IS THE TASK ID, never the worker's name. A name says which SLOT a worker ran in and
 * is handed out again by the next server: the records of earlier workers stay in the ledger as
 * history, so "the record called X" can be any of several workers, and a row joined that way
 * shows another task's branch and another task's "unmerged" mark. A record that carries no
 * task id (an adopted worker, an old ledger) therefore belongs to NO task here: it yields
 * nothing rather than a guess.
 *
 * The name is consulted for one thing only — to choose among records of the SAME task, which
 * a failover produces when it runs the task a second time on another worker: the row's event
 * names the worker that ran it last. Failing that the most recently spawned one is taken.
 */
export function ledgerRecordForTask<T extends MeshWorkerRecord>(
  records: readonly T[],
  taskId: unknown,
  workerName?: unknown,
): T | undefined {
  if (typeof taskId !== 'string' || taskId === '') {
    return undefined;
  }
  const own = records.filter((rec) => rec.taskId === taskId);
  if (own.length <= 1) {
    return own[0];
  }
  return (
    own.find((rec) => rec.name === workerName) ??
    own.sort(
      (a, b) =>
        (typeof b.spawnedAt === 'number' ? b.spawnedAt : 0) - (typeof a.spawnedAt === 'number' ? a.spawnedAt : 0),
    )[0]
  );
}

/**
 * Does the worktree a ledger record names still EXIST inside `root`? This is what "unmerged"
 * means on every row: disk truth, not the record's own `worktreeKept` flag — a worktree that
 * is gone is never flagged, matching the reaper's keptWorktree. The recorded path is
 * workspace-relative and is contained exactly as the reaper contains it: an absolute, `..` or
 * root-resolving value is never a worktree of THIS workspace (`path.resolve`, not `join`, so an
 * absolute second segment cannot leave the base silently).
 */
export function worktreeOnDisk(root: unknown, record: { worktree?: unknown }): boolean {
  if (typeof root !== 'string' || root === '' || typeof record.worktree !== 'string' || record.worktree === '') {
    return false;
  }
  const resolved = path.resolve(root, record.worktree);
  return resolved !== path.resolve(root) && isInsideDir(root, resolved) && fs.existsSync(resolved);
}

/**
 * Every mesh worker record across all workspaces' state files in MESH_STATE_DIR.
 * The dir may be absent and any file may be corrupt (it is written by a separate
 * process); both are tolerated by returning what could be read. Each record carries
 * its state file's `cwd` so callers that must WRITE the ledger (the stopped mark)
 * address the owning workspace rather than assuming the editor's.
 */
function readAllMeshWorkerRecords(): LedgerRecord[] {
  // Both halves guarded: this runs on the tree-render path in the extension host, where a
  // blocking read is a frozen editor. listDirCapped streams the listing (nothing bigger than
  // the cap is allocated) and safeFs refuses a FIFO, a device or an oversized file instead of
  // hanging on it. Every failure still degrades to "show what we can", which is the right
  // answer for a view — the DECISIONS made from this ledger live in mesh/pool.ts, where the
  // same failures are classified rather than collapsed.
  const listing = listDirCapped(MESH_STATE_DIR, DIR_SCAN_MAX_ENTRIES);
  if (!listing.ok) {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const file of listing.names) {
    if (!file.endsWith('.json')) {
      continue;
    }
    // A ledger is a file this product writes under a name it builds in its own directory, so
    // a symbolic link at that name is not followed: it could only make the name mean a file
    // somewhere else.
    const read = readTextSafe(path.join(MESH_STATE_DIR, file), MESH_STATE_FILE_MAX_BYTES, {
      noFollow: true,
    });
    if (!read.ok) {
      continue; // absent, unreadable, oversized, a link or not a file — nothing to show from it
    }
    try {
      const raw = JSON.parse(read.text) as Partial<MeshState>;
      const stateCwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
      if (Array.isArray(raw.workers)) {
        for (const w of raw.workers) {
          if (w && typeof w.name === 'string') {
            out.push({ ...w, stateCwd });
          }
        }
      }
    } catch {
      // corrupt/partial state file — skip it, show what we can
    }
  }
  return out;
}

/**
 * The ledger record of the session worker a CANCEL of task `taskId` must stop, or undefined
 * when no state file holds one.
 *
 * The record's own task id is what pins it (ledgerRecordForTask). The name alone does not
 * identify a worker: names restart with the server while the records of earlier workers stay
 * in the ledger as history, so "the record called X" can be a worker that died days ago — or
 * one that is running ANOTHER task, and stopping that job would end work nobody asked to end.
 *
 * So the name is a fallback only among records that carry NO task id at all (an adopted
 * worker, a ledger written before the field existed): there the name is all there is, a
 * record not yet stopped is the only kind worth stopping, and the most recently spawned one
 * wins a tie. A record that names a different task is never this task's worker, whatever it
 * is called.
 */
function findTaskWorkerRecord(taskId: string, name: string): LedgerRecord | undefined {
  const all = readAllMeshWorkerRecords();
  const exact = ledgerRecordForTask(all, taskId, name);
  if (exact) {
    return exact;
  }
  const newestFirst = (a: LedgerRecord, b: LedgerRecord): number =>
    (typeof b.spawnedAt === 'number' ? b.spawnedAt : 0) - (typeof a.spawnedAt === 'number' ? a.spawnedAt : 0);
  return all
    .filter((rec) => rec.name === name && rec.taskId === undefined && rec.stoppedAt === undefined)
    .sort(newestFirst)[0];
}

/** One session worker the ledgers still track, as much of it as a stop needs. */
export interface TrackedSessionWorker {
  jobId: string;
  /** The worker's session name, as recorded. */
  name: string;
  /** The account directory the record was written under (the registry's string at the time). */
  configDir: string;
  /** The dispatch it was spawned for, when the record names one. */
  taskId: string | undefined;
}

/**
 * The session workers that REMOVING `worker` would strand: ledger records, in any workspace,
 * filed under its account directory and not marked stopped.
 *
 * Why they matter. Every `claude` command this extension runs against a recorded directory is
 * gated on that directory being a CURRENT Claude Code account's (isClaudeAccountDir) — so the
 * moment the account leaves the registry, its session workers can be neither stopped nor
 * attached to from here, and only `claude stop <job id>` in a terminal under that account
 * still reaches them. The one moment they can still be stopped is before the removal.
 *
 * Empty when nothing would be stranded: for a worker on another vendor's CLI (it has no
 * session workers), and when the directory stays a Claude Code account's without this worker —
 * it is the hosting session's own, or another registered worker's. Decided with the pool's own
 * rule over the registry as it would be AFTER the removal. A record whose job id is not one
 * (isJobId) is left out: nothing could be run for it before the removal either. Never throws.
 */
export function sessionWorkersStrandedByRemoval(worker: WorkerProfile): TrackedSessionWorker[] {
  try {
    if (workerProvider(worker) !== 'claude') {
      return [];
    }
    const registry = readRegistry();
    const without = { ...registry, workers: registry.workers.filter((w) => w.name !== worker.name) };
    if (claudeAccountDirCheck(claudeAccounts(without, hostConfigDir()))(worker.configDir)) {
      return [];
    }
    const seen = new Set<string>();
    const tracked: TrackedSessionWorker[] = [];
    for (const rec of readAllMeshWorkerRecords()) {
      if (
        // "Marked stopped" is what the ledger's owner means by it: the field holds a number.
        (typeof rec.stoppedAt === 'number' && Number.isFinite(rec.stoppedAt)) ||
        typeof rec.configDir !== 'string' ||
        rec.configDir === '' ||
        !sameConfigDir(rec.configDir, worker.configDir) ||
        !isJobId(rec.jobId) ||
        seen.has(rec.jobId)
      ) {
        continue;
      }
      seen.add(rec.jobId);
      tracked.push({
        jobId: rec.jobId,
        name: typeof rec.name === 'string' ? rec.name : '',
        configDir: rec.configDir,
        taskId: typeof rec.taskId === 'string' && rec.taskId !== '' ? rec.taskId : undefined,
      });
    }
    return tracked;
  } catch {
    return [];
  }
}

/**
 * What `claude stop`, `claude attach` and `claude logs` take as a job id: the first 8 hex
 * characters of the session id today. Checked before the value reaches a command line because
 * it comes from files other processes write (the ledger, a session entry): a wider, still
 * shell-inert alphabet tolerates a format change, and a leading `-` is refused so the value
 * can never be read as an option.
 */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_RE.test(value);
}

/** How much of the CLI's own words a failed stop quotes. */
const STOP_OUTPUT_TAIL_CHARS = 200;

/**
 * Is `configDir` the directory of a CURRENT Claude Code account — the hosting session's, or a
 * registered Claude Code worker's? The pool's own rule (`claudeAccounts` +
 * `claudeAccountDirCheck`, read fresh from the registry), asked before `claude` is aimed at a
 * directory that came from STORED DATA: a mesh ledger record, a resolved Team row.
 *
 * Such a directory was a Claude Code account's when it was written down and is plain data
 * afterwards: the account may have been removed, the file edited, or the directory may now be
 * the home of a worker on another vendor's CLI — and a `claude` process started with
 * CLAUDE_CONFIG_DIR pointed there creates Claude config files inside it. Total: any value that
 * is not such a directory, and any failure to read the registry, is `false`.
 */
export function isClaudeAccountDir(configDir: unknown): configDir is string {
  try {
    return claudeAccountDirCheck(claudeAccounts(readRegistry(), hostConfigDir()))(configDir);
  } catch {
    return false;
  }
}

/**
 * The one sentence a user is told when an action on a session was refused because its account
 * directory is not a current Claude Code account's (isClaudeAccountDir): nothing was run from
 * here, and this is how to reach the session instead.
 */
export function accountNotRegisteredAdvice(verb: 'stop' | 'attach' | 'logs', jobId: string): string {
  return verb === 'stop'
    ? vscode.l10n.t(
        "The session's account is no longer registered as a Claude Code account, so it has to be stopped from a terminal with `claude stop {0}` under that account.",
        jobId,
      )
    : vscode.l10n.t(
        "The session's account is no longer registered as a Claude Code account, so it can only be reached from a terminal, with `claude {0} {1}` under that account.",
        verb,
        jobId,
      );
}

/** Why a stop was not performed. */
interface StopFailure {
  /** One line, safe to quote to the user and into the task's output file. */
  error: string;
  /** Nothing was run at all: the directory is not a current Claude Code account's. */
  accountNotRegistered: boolean;
}

/**
 * Why `claude stop <jobId>` must NOT be run for this job under this directory, or undefined
 * when it may be. Decided from the values alone, without running anything — so a cancel can
 * know before it records the task what its stop will be.
 */
function stopRefusal(jobId: string, configDir: unknown): StopFailure | undefined {
  if (!isJobId(jobId)) {
    return { error: 'the recorded job id is not a valid job id', accountNotRegistered: false };
  }
  // THE gate for every `claude stop` this file starts. The directory comes from a ledger
  // record or a resolved row — stored data — and `claude` is about to be started with
  // CLAUDE_CONFIG_DIR pointed at it. Unless it is a current Claude Code account's, nothing is
  // spawned: the caller changes no ledger mark and tells the user how to stop the session
  // themselves. (A record naming no directory at all can only be the hosting account's.)
  if (configDir !== undefined && !isClaudeAccountDir(configDir)) {
    return {
      error:
        "the session's account is no longer registered as a Claude Code account, so nothing was " +
        `run under its recorded directory — stop it from a terminal with \`claude stop ${jobId}\` ` +
        'under that account',
      accountNotRegistered: true,
    };
  }
  return undefined;
}

/**
 * Run `claude stop <jobId>` for one session worker under its own account, as a child
 * process. Resolves to a StopFailure when the stop could not be performed, or undefined on
 * success — it never throws, because the caller must record the cancellation either way.
 *
 * Through runMeshProcess, not execFile: that runner settles when the child EXITS. A `claude`
 * command can start the background service, which keeps the stdio pipes open after the
 * command itself is done; a wrapper waiting for the pipes to close would then never return,
 * and neither would the cancel that awaits it.
 */
async function stopMeshWorkerJob(jobId: string, configDir: unknown): Promise<StopFailure | undefined> {
  const refused = stopRefusal(jobId, configDir);
  if (refused) {
    return refused;
  }
  const accountDir = typeof configDir === 'string' ? configDir : hostConfigDir();
  // registry.claudePath is the RESOLVED absolute path wherever one is known (the extension
  // host writes it at its settings sync, once its background lookup has an answer); a bare
  // "claude" would often be ENOENT here, since the host may not carry the login-shell PATH.
  const claudePath = readRegistry().claudePath || 'claude';
  const outcome = await runMeshProcess(
    claudePath,
    ['stop', jobId],
    meshSpawnCwd(undefined),
    // claudeEnv decides how the account is presented (the default directory must run with
    // the variable ABSENT) and strips this editor's own session-identity variables.
    claudeEnv(accountDir),
    MESH_STOP_TIMEOUT_MS,
  );
  if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
    return undefined;
  }
  // The CLI's output is quoted to the user and into the task's output file: one line, no
  // control or invisible characters, and only its tail.
  const said = flattenOneLine(outcome.output);
  const tail =
    said.length > STOP_OUTPUT_TAIL_CHARS
      ? // cut from the FRONT: drop a low surrogate the cut may have orphaned at the start
        `…${said.slice(-STOP_OUTPUT_TAIL_CHARS).replace(/^[\uDC00-\uDFFF]/, '')}`
      : said;
  return {
    error: `claude stop ${jobId} ${describeProcFailure(outcome)}${tail ? `: ${tail}` : ''}`,
    accountNotRegistered: false,
  };
}

/**
 * Directory to spawn a `claude` teardown command in. The ledger's own workspace is
 * the right one — `claude rm` addresses a background job under the checkout that
 * owns its worktree — but a state file can name a folder that has since been moved
 * or deleted, and spawning into a missing cwd is an ENOENT nobody downstream can
 * fix. Fall back to the editor's workspace, then to this process's own directory.
 */
function meshSpawnCwd(preferred: string | undefined): string {
  for (const dir of [preferred, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath]) {
    if (!dir) {
      continue;
    }
    try {
      if (fs.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch {
      // gone or unreadable — try the next candidate
    }
  }
  return process.cwd();
}

/**
 * The two finishers a stop owes the rest of the system, run after a UI cancel has
 * actually stopped a session worker.
 *
 * `claude stop` only kills the session. Without these writes the ledger record still
 * looks live: an unsettled one keeps counting against the in-flight cap until its deadline,
 * the session-end and orphan reapers run `claude stop` against a job that is already dead,
 * and the task's worktree lingers even when it is clean. `markWorkerStopped` converges the
 * ledger; `removeWorkerJob` is the same teardown finisher the server-side stop and the
 * orphan reaper run, never a force removal and never a `git worktree remove` by path:
 * a worktree holding uncommitted work is KEPT by the platform, which is a SUCCESS
 * path here (nothing unmerged is ever destroyed) and is surfaced, not retried.
 *
 * Strictly best-effort and total: the cancellation is recorded by the caller either
 * way, so every failure here only adds a line to the task's output note. Returns the
 * text to append (empty when there is nothing worth telling the user).
 */
async function finishCancelledMeshWorker(record: LedgerRecord): Promise<string> {
  const notes: string[] = [];
  // Reached only after a stop that ran under this record's directory, which passed the account
  // check a moment ago. Asked again because this function writes the ledger and aims a second
  // command (`claude rm`) at the same STORED directory: if it is not a current Claude Code
  // account's by now, neither happens.
  if (record.configDir !== undefined && !isClaudeAccountDir(record.configDir)) {
    return (
      `Its ledger record was left as it is and \`claude rm ${record.jobId}\` was not run: the ` +
      "session's account is no longer registered as a Claude Code account.\n"
    );
  }
  // stoppedAt FIRST: it is the write that takes the record out of the in-flight count, and
  // the `claude rm` below may burn its full timeout before it returns anything at all.
  if (record.stoppedAt !== undefined) {
    // Already marked by another surface. markWorkerStopped refuses a second mark, and that
    // refusal would read here as a failure of a stop that in fact succeeded.
  } else if (record.stateCwd) {
    try {
      // By JOB ID: names restart with the server while the records of earlier workers stay
      // in the ledger, so the name alone can address a worker that stopped days ago. Both
      // callers hold a record they found by a valid job id.
      const marked = markWorkerStopped(record.stateCwd, record.name, record.jobId);
      if (!marked.ok) {
        notes.push(
          `Could not mark "${record.name}" stopped in the mesh ledger (${marked.error ?? 'unknown error'}) — ` +
            'the session-end and orphan reapers remain the backstop.',
        );
      }
    } catch (err) {
      // A ledger write is filesystem work in a separate process's data directory.
      notes.push(
        `Could not mark "${record.name}" stopped in the mesh ledger (${
          err instanceof Error ? err.message : String(err)
        }) — the session-end and orphan reapers remain the backstop.`,
      );
    }
  } else {
    // A state file whose `cwd` field is missing or not a string (hand-edited, or a
    // torn write): the record cannot be addressed without knowing its workspace.
    notes.push(
      `Could not mark "${record.name}" stopped in the mesh ledger: its record names no workspace.`,
    );
  }
  try {
    const removal = await removeWorkerJob({
      claudePath: readRegistry().claudePath || 'claude',
      cwd: meshSpawnCwd(record.stateCwd),
      configDir: record.configDir,
      jobId: record.jobId,
    });
    if (removal.kept) {
      // Truthful, never forced. A "kept" verdict moments after a stop can also be the
      // wind-down race (cleanup register C6) — the activation sweep reaps the
      // stragglers later, and `claude rm` refuses a genuinely dirty worktree anyway.
      notes.push(
        `Its worktree ${record.worktree ?? '(path not recorded)'} was KEPT — it holds uncommitted ` +
          'changes. Inspect and merge it before removing it; nothing was discarded.',
      );
    } else if (removal.error !== undefined) {
      notes.push(
        `Finishing the teardown (claude rm ${record.jobId}) failed: ${removal.error}` +
          (typeof record.worktree === 'string'
            ? `. Its worktree ${record.worktree} may still exist — inspect it before removing it.`
            : '.'),
      );
    } else if (removal.removed && typeof record.worktree === 'string') {
      notes.push(`Its worktree ${record.worktree} was clean and has been removed.`);
    }
  } catch (err) {
    // removeWorkerJob is documented never to reject; this is belt and braces, because
    // a throw here would turn a completed cancel into a failed one for the user.
    notes.push(
      `Finishing the teardown (claude rm ${record.jobId}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return notes.length > 0 ? `${notes.join('\n')}\n` : '';
}

/**
 * What the task tree needs of the team client (team contract §8.1, L12, M8), wired by the
 * extension at activation (setTeamTaskHooks). Absent — no client — every team turn is cancelled
 * as any other task, and the engine reads that exit as `cancelled` (§2.5).
 */
export interface TeamTaskHooks {
  /** A team's display name, when the client knows the team. */
  teamName(teamId: string): string | undefined;
  /** Pause `member` with `now` on the host that owns the team, when `taskId` is its running turn. */
  pauseTurn(teamId: string, member: string, taskId: string): Promise<TeamTurnPause>;
}

let teamTaskHooks: TeamTaskHooks | undefined;

/** Wire (or, with undefined, unwire) the team client into the task tree and its Cancel. */
export function setTeamTaskHooks(hooks: TeamTaskHooks | undefined): void {
  teamTaskHooks = hooks;
}

/** A team turn's Cancel the owning host refused (M8): nothing was stopped, and the host's reason is the message. */
export class TeamCancelRefusedError extends Error {}

/** What the stop inside a mesh-aware cancel did; filled in by cancelTaskMeshAware. */
export interface MeshCancelReport {
  /** This call closed a running session-worker task, i.e. the stop path was taken at all. */
  sessionWorker?: boolean;
  /** Job id `claude stop` was run on; absent when the ledger named none. */
  jobId?: string;
  /** Why the session could not be stopped (the task row is closed regardless). */
  stopError?: string;
  /**
   * The stop was not ATTEMPTED: the ledger record's directory is not a current Claude Code
   * account's (isClaudeAccountDir), so nothing was run and no ledger mark was changed. The task
   * is cancelled in our own record only — the session itself is still whatever it was.
   */
  accountNotRegistered?: boolean;
  /** Ledger / worktree lines from the teardown (a KEPT worktree above all). */
  notes?: string;
  /**
   * The task log could not be read when the task was looked up. A `false` from the cancel then
   * does NOT mean "that task is not running": nothing is known about it, and the caller should
   * say the log is unreadable rather than that there was nothing to cancel.
   */
  logUnreadable?: boolean;
  /**
   * The task was a team member's running turn and its owning host PAUSED that member (M8): the
   * engine stops the turn itself and records its end; this call wrote nothing to the task log.
   */
  teamPaused?: boolean;
}

/**
 * Cancel a dispatched task from the UI, mesh-aware. A `--bg` (session-worker) task
 * carries `meshWorker` on its events and NEVER a pid, so the
 * signal path in cancelRunningTask can only ever no-op on it: the worker is a
 * detached background session addressed by job id. This routes such a task to
 * `claude stop <jobId>` (looked up in the mesh ledger, run under the worker's own
 * account) and finishes the ledger + worktree bookkeeping a server-side stop would have
 * done (finishCancelledMeshWorker). Every other task takes the signal path.
 *
 * RECORDED FIRST, THEN STOPPED — as cancelRunningTask does, and for the same reason. The
 * cancellation is appended through registry.appendTerminalTaskEvent: under the task's
 * reconcile lock, after re-reading the task's final event there, and only if the task is still
 * running. Every other writer of a terminal event — the dispatch recording its worker's result
 * or failure, the server recording a cancelled request, the sweep — goes through the same lock,
 * so a cancel and a completion that arrive in the same instant leave ONE terminal event:
 * whichever got there first. Recording before the stop (which takes seconds) is what makes the
 * user's cancel the record when it was asked for while the task ran: the worker's end that the
 * stop causes, seen by the dispatch, then finds the task closed and records nothing of its own.
 *
 * Returns true when THIS call closed the task, false when the task is absent or no longer
 * running — including when another hand closed it between the first read and the lock; then
 * nothing is recorded and nothing is stopped, exactly as cancelRunningTask. A second call is
 * therefore a no-op.
 *
 * `report`, when given, receives what the STOP did — the boolean cannot say it, because the
 * task row is closed whether or not the session could be stopped.
 *
 * The ledger record's directory is stored data. When it is not a current Claude Code account's
 * (a removed account, an edited file, a directory that now belongs to another vendor's worker)
 * NO `claude` command is run and no ledger mark is changed; the task is still closed — that is
 * our own record — and the record says what that means: cancelled here, the session not stopped.
 * That is known before anything is run (stopRefusal), so it is in the record from the start.
 *
 * A TEAM TURN (its events carry `team` — taskEventTeam; team contract L12, M8) is the team
 * engine's, not this tree's: it is routed to `cco/team.member {op:'pause', now:true}` on the host
 * that owns the team, so the engine stops its own turn, records its end and pauses the member —
 * never a kill behind the engine's back. Returns true then (the turn is being stopped) with
 * `report.teamPaused`. Only when no host answers for the team, or the host says the task is not
 * the member's running turn, is it cancelled as today — and the engine reads such an exit as
 * `cancelled` (§2.5), so it is never retried either way. A host that REFUSES the pause throws
 * TeamCancelRefusedError with the host's reason: nothing was recorded and nothing was stopped.
 *
 * Throws what appendTaskEvent throws (a log that refuses the write); nothing is stopped then.
 */
export async function cancelTaskMeshAware(
  id: string,
  reason: string,
  report?: MeshCancelReport,
): Promise<boolean> {
  const looked = latestEventByIdChecked(id);
  const latest = looked.event;
  if (looked.unreadable && report) {
    report.logUnreadable = true;
  }
  const team = latest?.status === 'running' ? taskEventTeam(latest) : undefined;
  if (team?.member !== undefined && teamTaskHooks !== undefined) {
    const routed = await teamTaskHooks.pauseTurn(team.team, team.member, id);
    if (routed.kind === 'paused') {
      if (report) {
        report.teamPaused = true;
      }
      return true;
    }
    if (routed.kind === 'refused') {
      throw new TeamCancelRefusedError(
        vscode.l10n.t(
          'the team host did not pause {0}: {1}',
          team.member,
          rowText(routed.sentence, 300) || vscode.l10n.t('no reason was given'),
        ),
      );
    }
    // unreachable / not-current: today's path below.
  }
  const workerName = typeof latest?.meshWorker === 'string' ? latest.meshWorker : undefined;
  if (!latest || latest.status !== 'running' || !workerName) {
    return cancelRunningTask(id, reason);
  }
  const record = findTaskWorkerRecord(id, workerName);
  const jobId = record && typeof record.jobId === 'string' && record.jobId !== '' ? record.jobId : undefined;
  // A stop that will not be attempted at all, known now from the values alone.
  const refused = record && jobId !== undefined ? stopRefusal(jobId, record.configDir) : undefined;
  const sessionUntouched = refused?.accountNotRegistered === true;
  // The record is ours to close either way; when the session will not be touched it says so,
  // still beginning with the reason so it files as a cancellation everywhere. The fields are
  // the running event's, the session-worker ones included (readResultForTask needs them on a
  // settled task).
  const recorded = sessionUntouched
    ? `${reason} — cancelled here; the session itself was not stopped`
    : reason;
  const close = appendTerminalTaskEvent({ ...latest, ts: Date.now(), status: 'error', error: recorded });
  if (!close.closed) {
    // Closed by another hand since the read above (its worker finished, the server ended it,
    // a sweep settled it): that record stands, and there is nothing left to cancel.
    return false;
  }
  if (report) {
    report.sessionWorker = true;
  }
  let stopNote: string;
  if (!record || jobId === undefined) {
    // The ledger no longer names this worker (stale row, or a state file removed
    // under us): the task row is still ours to close, the process is not ours to
    // address. The session-end and orphan reapers remain the backstop.
    stopNote = `\nCould not stop the attachable worker "${workerName}": no job id in the mesh ledger.\n`;
    if (report) {
      report.stopError = 'no job id in the mesh ledger';
    }
  } else {
    if (report) {
      report.jobId = jobId;
    }
    const failure = refused ?? (await stopMeshWorkerJob(jobId, record.configDir));
    if (failure) {
      // A failed stop leaves the session's fate unknown, so neither finisher runs:
      // stamping stoppedAt on a possibly-live worker would hide it from the session-end
      // and orphan reapers — the two things that would still catch it. A stop that was
      // REFUSED (the account check) ran nothing at all, and is worded as that.
      stopNote = failure.accountNotRegistered
        ? `\nThe attachable worker "${workerName}" was NOT stopped: ${failure.error}.\n`
        : `\nStopping the attachable worker "${workerName}" failed: ${failure.error}\n`;
      if (report) {
        report.stopError = failure.error;
        if (failure.accountNotRegistered) {
          report.accountNotRegistered = true;
        }
      }
    } else {
      // The ledger convergence (markWorkerStopped) and the rm finisher: both idempotent, and
      // the stopped mark is what takes a dead job out of the in-flight count and the reapers'
      // work list.
      const finished = await finishCancelledMeshWorker(record);
      stopNote = `\nStopped the attachable worker "${workerName}" (claude stop ${jobId}).\n${finished}`;
      if (report) {
        report.notes = finished;
      }
    }
  }
  // The note goes to the report the task's ID names (registry.appendTaskNote). `latest` came
  // out of the log, and the `outputFile` a log line carries is not a path to append to. It is
  // written once the stop is done, so it says what the stop did — a KEPT worktree above all,
  // the one fact here the user must act on.
  appendTaskNote(latest, `\n\n---\n\nCANCELLED: ${recorded} (${new Date().toISOString()})\n${stopNote}`);
  return true;
}

/** What stopping one live session from the UI did, for the caller to report. */
export interface SessionStopResult {
  /** `claude stop` ran and exited cleanly. */
  stopped: boolean;
  /** Why it did not, when it did not. */
  error?: string;
  /** Ledger / worktree lines worth telling the user (a KEPT worktree above all); may be empty. */
  notes: string;
  /** The session had a dispatch in flight, and that task is now recorded as cancelled. */
  cancelledTask: boolean;
  /**
   * The stop was not attempted: the session's recorded account directory is not a current
   * Claude Code account's. Nothing was run and no ledger mark was changed.
   */
  accountNotRegistered?: boolean;
}

/**
 * Stop a live session from the Team view or the dashboard.
 *
 * A worker whose dispatch is STILL RUNNING is stopped through the task-cancel path, so the
 * task is recorded as cancelled by the user. Stopping only the session would leave that to
 * the MCP server, which sees a worker that vanished: it records a failed dispatch and
 * charges the account an error for what was the user's own decision. Every other session —
 * a parked worker, a background session the user started — is simply stopped by job id.
 * Never throws.
 */
export async function stopSession(target: {
  jobId: string;
  configDir: string | undefined;
  name: string;
  taskId: string | undefined;
}): Promise<SessionStopResult> {
  if (!isJobId(target.jobId)) {
    return { stopped: false, error: 'the session has no valid job id', notes: '', cancelledTask: false };
  }
  let cancelledTask = false;
  try {
    const latest =
      typeof target.taskId === 'string' && target.taskId !== ''
        ? latestEventById(target.taskId)
        : undefined;
    // The NAME must match as well as the task id: after a failover the same task runs on a
    // second worker, and stopping the first (parked) one must not cancel what the second is doing.
    if (latest && latest.status === 'running' && latest.meshWorker === target.name) {
      const report: MeshCancelReport = {};
      const closed = await cancelTaskMeshAware(latest.id, 'cancelled by user', report);
      cancelledTask = closed && report.sessionWorker === true;
      // The cancel's own stop is the answer when it was run on THIS job — succeeded or not
      // (a second attempt on the same job would only fail the same way). If the ledger named
      // no job, or a different one, the session named here is still to be stopped below.
      if (cancelledTask && report.jobId === target.jobId) {
        return {
          stopped: report.stopError === undefined,
          error: report.stopError,
          notes: report.notes ?? '',
          cancelledTask,
          accountNotRegistered: report.accountNotRegistered,
        };
      }
    }
  } catch {
    // an unreadable task log decides nothing here — the session can still be stopped
  }
  return { ...(await stopSessionByJobId(target.jobId, target.configDir)), cancelledTask };
}

/**
 * Stop one session by job id and finish it exactly as a task cancel does (`claude stop` as
 * a child process, then the stopped mark and the `claude rm` teardown of
 * finishCancelledMeshWorker). Writes no task event — stopSession decides whether one is owed.
 *
 * The ledger record is found by JOB ID, never by name: names are reused across dispatches and
 * the job id is the one stable key. A session with no ledger record (a background session the
 * user started themselves) is only stopped — nothing of it is ours to mark or to remove.
 * Never throws.
 */
async function stopSessionByJobId(
  jobId: string,
  configDir: string | undefined,
): Promise<Omit<SessionStopResult, 'cancelledTask'>> {
  if (!isJobId(jobId)) {
    return { stopped: false, error: 'the session has no valid job id', notes: '' };
  }
  let record: LedgerRecord | undefined;
  try {
    // A job id is a prefix of a session id, so two ACCOUNTS can hold the same one: when the
    // caller knows the account, the record must be that account's too.
    record = readAllMeshWorkerRecords().find(
      (rec) =>
        rec.jobId === jobId &&
        (configDir === undefined ||
          (typeof rec.configDir === 'string' && sameConfigDir(rec.configDir, configDir))),
    );
  } catch {
    record = undefined; // the readers are total; this is belt and braces
  }
  // The caller's directory when it has one (a resolved Team row), else the ledger record's —
  // stored data either way, so stopMeshWorkerJob checks it before anything runs.
  const failure = await stopMeshWorkerJob(jobId, configDir ?? record?.configDir);
  if (failure) {
    return {
      stopped: false,
      error: failure.error,
      notes: '',
      accountNotRegistered: failure.accountNotRegistered || undefined,
    };
  }
  if (!record) {
    return { stopped: true, notes: '' };
  }
  try {
    return { stopped: true, notes: await finishCancelledMeshWorker(record) };
  } catch (err) {
    return { stopped: true, notes: err instanceof Error ? err.message : String(err) };
  }
}

/** A token count on a row: usage.formatTokenCount, the one helper for it (`642.8k`, `17.9M`). */
const fmtTokens = formatTokenCount;

/** A count out of a file a person can edit: a non-negative whole number, or 0. */
function wholeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/* ------------------------------------------------------------------------- *
 * What a redraw of the Workers tree reads
 * ------------------------------------------------------------------------- */

/**
 * What one `stat` says is at a path — enough to know whether a reading of it still stands.
 * Device, inode, size and modification time, and the change time as well: a file made readable
 * again by a `chmod` has the size and the modification time it had before.
 */
function fileStamp(file: string): { key: string; absent: boolean } {
  try {
    const st = fs.statSync(file, { bigint: true });
    return { key: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`, absent: false };
  } catch (err) {
    const code: unknown = (err as NodeJS.ErrnoException | null)?.code;
    return { key: `none:${typeof code === 'string' ? code : ''}`, absent: code === 'ENOENT' };
  }
}

/**
 * One small state file, read through its owning module's reader — and read AGAIN only when
 * the file's stat changes. A row of the tree asks for the registry, the stats and the usage
 * cache; VS Code draws every row of every account on each redraw, and a redraw is triggered
 * by a watcher of four files. Read per row, that was two opens for each account on every
 * redraw, whether or not anything had changed. With this, a redraw of an unchanged tree costs
 * `stat` calls and nothing else, and a change costs one read of the file that changed.
 *
 * `settled` says whether a reading is the file's content, as opposed to the stand-in a reader
 * returns when the read FAILED (an empty object, a `problem`). Only a settled reading is kept:
 * a failure that left the stat as it was — out of descriptors, an I/O error — must not be
 * shown until the file is next written.
 */
export class StatKeyed<T extends object> {
  private key: string | undefined;
  private value: T | undefined;

  constructor(
    private readonly file: string,
    private readonly load: () => T,
    private readonly settled: (value: T, absent: boolean) => boolean,
  ) {}

  get(): T {
    const stamp = fileStamp(this.file);
    if (this.value !== undefined && stamp.key === this.key) {
      return this.value;
    }
    // The stat was taken first: a file that changes between the two is read once more at the
    // next call, never kept under the stamp of what it was.
    const value = this.load();
    const keep = this.settled(value, stamp.absent);
    this.key = keep ? stamp.key : undefined;
    this.value = keep ? value : undefined;
    return value;
  }
}

/** The registry as the tree lists it (the checked read: a `problem` is a row of its own). */
const registryOnDisk = new StatKeyed(REGISTRY_FILE, readRegistryChecked, (read) => read.problem === null);

/**
 * The registry as a tree view reads it for a redraw: registry.readRegistryChecked's answer,
 * from the one reading this module keeps and re-takes only when the file changed. For
 * DRAWING only — a command acts on a fresh read of its own.
 */
export function registryForDrawing(): ReturnType<typeof readRegistryChecked> {
  return registryOnDisk.get();
}
const statsOnDisk = new StatKeyed(STATS_FILE, readStatsChecked, (read) => read.problem === null);
/** The reader answers `{}` for a cache it could not read; only a missing file is known to be empty. */
const usageOnDisk = new StatKeyed<UsageCache>(
  USAGE_CACHE_FILE,
  readUsageCache,
  (cache, absent) => absent || Object.keys(cache).length > 0,
);

/**
 * The recorded stats of ONE worker, or undefined when none are filed under its name.
 *
 * An OWN entry only. The stats file is read into a plain object and indexed by a name a person
 * chose; `stats['toString']` or `stats['constructor']` on a plain object is an inherited
 * function, which reads as "this worker has stats" and then has no numbers in it.
 */
function statsOf(name: string): WorkerStats | undefined {
  const all = statsOnDisk.get().stats;
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : undefined;
}

/** usage.ownsUsageReading's answers for the workers of one reading of the registry. */
const ownedReadings = new WeakMap<object, Map<string, boolean>>();

/**
 * Is the usage reading filed under `worker`'s directory its OWN (usage.ownsUsageReading)? For
 * a worker on another vendor's CLI that rule reads the registry, so its answer is kept for as
 * long as the registry reading it was given for: it depends on nothing but the registry and
 * the worker's own name, directory and CLI.
 */
function ownsReading(worker: WorkerProfile): boolean {
  const reading = registryOnDisk.get();
  let known = ownedReadings.get(reading);
  if (known === undefined) {
    known = new Map();
    ownedReadings.set(reading, known);
  }
  const key = JSON.stringify([worker.name, worker.configDir, worker.provider ?? null]);
  let owns = known.get(key);
  if (owns === undefined) {
    owns = ownsUsageReading(worker);
    known.set(key, owns);
  }
  return owns;
}

/**
 * The cached usage reading that is `worker`'s OWN, or undefined — usage.getCachedWorkerUsage's
 * answer, from the one reading of the cache this module keeps (usageOnDisk).
 */
function usageOf(worker: WorkerProfile): AccountUsage | undefined {
  return ownsReading(worker) ? ownCacheEntry(usageOnDisk.get(), worker.configDir) : undefined;
}

/**
 * The OTHER Claude Code accounts — the hosting session's own (`main`) included — that are signed
 * in to the same claude.ai account as `worker`: the same `accountKey` in their usage readings.
 * By name, in registry order, `main` first. Information only: no dispatch reads it.
 */
function sameAccountNames(worker: WorkerProfile, usage: AccountUsage | undefined): string[] {
  const key = accountKeyOf(usage);
  if (key === undefined) {
    return [];
  }
  const names: string[] = [];
  const mainDir = hostConfigDir();
  if (!sameConfigDir(worker.configDir, mainDir) && accountKeyOf(ownCacheEntry(usageOnDisk.get(), mainDir)) === key) {
    names.push('main');
  }
  for (const other of registryOnDisk.get().registry.workers) {
    if (
      other.name !== worker.name &&
      workerProvider(other) === 'claude' &&
      !sameConfigDir(other.configDir, worker.configDir) &&
      accountKeyOf(usageOf(other)) === key
    ) {
      names.push(rowText(other.name, WORKER_NAME_MAX));
    }
  }
  return names;
}

/** "Same claude.ai account as …": the sentence a row's hover carries, for one other or several. */
function sameAccountSentence(names: readonly string[]): string {
  return names.length === 1
    ? vscode.l10n.t("Same claude.ai account as {0} — one plan's limits for both.", names[0])
    : vscode.l10n.t("Same claude.ai account as {0} — one plan's limits for all of them.", names.join(', '));
}

/**
 * The tree ids of the two kinds of row that carry one. A name out of the registry file is any
 * string at all, so it is set into the id in a form that has an end (its JSON spelling) behind
 * a prefix the other kind does not have: no account's id can be another account's, and none
 * can be the id of a detail row — which a bare `name` and `name:position:label` could be, for
 * an account somebody named `a:0:Status`.
 */
function accountRowId(name: string): string {
  return `account:${JSON.stringify(name)}`;
}
function detailRowId(worker: string, seq: number, label: string): string {
  return `detail:${JSON.stringify(worker)}:${seq}:${label}`;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/*
 * The three fixed readings of a Claude Code account that has no figures to show. Functions,
 * not constants: a localized string is asked for when a row is drawn, never when this module
 * is loaded.
 *
 * An expired/logged-out subscription reports the same "no limits" shape as a genuine token
 * account, so every `available !== true` branch must ask `isLoginExpired` before falling
 * through to noLimitsMessage — otherwise the row reads "no plan limits" for an account that in
 * fact has a plan it can no longer reach.
 */
function noLimitsMessage(): string {
  return vscode.l10n.t('no plan limits (token/non-subscription login)');
}
function noWindowsMessage(): string {
  return vscode.l10n.t('no rate-limit windows reported');
}
function expiredSummary(): string {
  return vscode.l10n.t('login expired — re-login needed');
}
function unconfirmedSummary(): string {
  return vscode.l10n.t('login not confirmed — checking');
}

/**
 * A Claude Code account's login state (usage.loginStateOf — Login state (CA)) as the row's short
 * word: nothing while it is `ok` (or logged out, which usageSummary already says), else what is
 * going on — never "logged out" for a state that is not `loggedOut`.
 */
function loginSegment(usage: AccountUsage | undefined): string | undefined {
  const st = loginStateOf(usage);
  switch (st.state) {
    case 'checking':
      return vscode.l10n.t('checking login');
    case 'probeFailed':
      return vscode.l10n.t("couldn't check login");
    case 'unconfirmed':
      // A last known "not logged in" is already said by usageSummary.
      return st.lastKnown === 'out' ? undefined : vscode.l10n.t('login not confirmed');
    default:
      return undefined;
  }
}

/** The hover sentence of a Claude Code account's login state, with its reason and its age. */
function loginTooltip(usage: AccountUsage | undefined): string {
  const st = loginStateOf(usage);
  const when = agoText(st.checkedAt ?? undefined);
  switch (st.state) {
    case 'ok':
      return vscode.l10n.t('Login: ok — {0} (checked {1}).', st.reason, when);
    case 'loggedOut':
      return vscode.l10n.t('Login: logged out — {0}.', st.reason);
    case 'probeFailed':
      return vscode.l10n.t(
        'Login: could not be checked ({0}) — this says nothing about the login and it is retried. Right-click → "Check Login Now" to check again.',
        st.reason,
      );
    case 'checking':
      return vscode.l10n.t('Login: being checked now ({0}).', st.reason);
    default:
      return vscode.l10n.t(
        'Login: not confirmed ({0}) — a check is due. Right-click → "Check Login Now" to check now.',
        st.reason,
      );
  }
}

/** A window normalized from the cache file — every field guaranteed present and well-typed. */
interface SafeWindow {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * The usage cache is external input: a truncated or hand-edited entry may omit
 * `windows` entirely, or hold nulls / non-objects in it. Render paths must never
 * throw — the tree item would fail to render. Mirrors src/mcp/server.ts.
 *
 * `measuredOnly` additionally drops a window whose percentage is not a finite number, instead
 * of showing it as 0 %. It is how another vendor's windows are read: the writer of those
 * entries never stores an unreadable figure ("0 % used" is a claim), so one that is in the
 * file anyway was put there by hand and supports no number at all.
 */
function safeWindows(usage: AccountUsage, measuredOnly = false): SafeWindow[] {
  const raw: unknown = usage.windows;
  if (!Array.isArray(raw)) {
    return [];
  }
  const windows: SafeWindow[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const w = entry as Record<string, unknown>;
    const percent = w.percent;
    if (measuredOnly && !(typeof percent === 'number' && Number.isFinite(percent))) {
      continue;
    }
    windows.push({
      kind: str(w.kind, ''),
      // The label is put on a row as written (the vendor's own text for another CLI's account).
      label: rowText(w.label, WINDOW_LABEL_MAX),
      percent: typeof percent === 'number' && Number.isFinite(percent) ? percent : 0,
      severity: str(w.severity, 'normal'),
      resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
    });
  }
  return windows;
}

/**
 * The "temporarily unavailable" plan-usage state: the account HAS reported
 * windows before (`lastGoodWindowsAt` is finite) but the latest reading is an
 * available, error-free response with no windows — upstream get_usage is
 * intermittently returning no rate-limit data. Distinct from the never-had-data
 * NO_WINDOWS state, where `lastGoodWindowsAt` is absent.
 */
function isTempUnavailable(usage: AccountUsage): boolean {
  return (
    usage.available === true &&
    usage.error === undefined &&
    safeWindows(usage).length === 0 &&
    typeof usage.lastGoodWindowsAt === 'number' &&
    isFinite(usage.lastGoodWindowsAt)
  );
}

/** A normalized overage-billing reading, every field guaranteed well-typed. */
interface SafeExtra {
  enabled: boolean;
  percent: number | null;
  spendLabel: string | null;
}

/**
 * Like `safeWindows`: `extraUsage` is external input. Returns null when the
 * account reports no overage state OR the cached entry is malformed (a non-object
 * `extraUsage`) — callers push no overage row in that case. Nulls in individual
 * fields render as "not reported", never throw.
 */
function safeExtraUsage(usage: AccountUsage): SafeExtra | null {
  const raw: unknown = usage.extraUsage;
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const percent = e.percent;
  return {
    enabled: e.enabled === true,
    percent: typeof percent === 'number' && Number.isFinite(percent) ? percent : null,
    spendLabel: typeof e.spendLabel === 'string' ? e.spendLabel : null,
  };
}

/**
 * The name of one of a CLAUDE CODE account's plan windows. There the cache's `kind` says what
 * the window IS (`get_usage` names them), so the name is this product's own text, by kind, in
 * the reader's language; a kind this version does not know keeps the label the cache carries.
 * `short` is the form for the collapsed row's one-line summary.
 *
 * A `switch`, not a table indexed by `kind`: the kind comes out of a file, and a table would
 * answer `constructor` with a function.
 */
function planWindowLabel(w: SafeWindow, short = false): string {
  switch (w.kind) {
    case 'session':
      return short ? vscode.l10n.t('5h') : vscode.l10n.t('Session (5hr)');
    case 'weekly_all':
      return short ? vscode.l10n.t('7d') : vscode.l10n.t('Weekly (7 day)');
    case 'weekly_scoped':
      return short ? vscode.l10n.t('Fable') : vscode.l10n.t('Weekly Fable');
    default:
      return w.label;
  }
}

/**
 * A usage-window label of an account on ANOTHER vendor's CLI, as a row shows it. The label is
 * that vendor's own text and is shown as given — except when it is a bare word an adapter
 * reports instead of a name, which says nothing to a person: Codex's two unnamed limits
 * (`primary`, `secondary`) and Cursor's three shares of the billing period (`total` — all
 * usage, `auto` — Auto and Composer, `api` — the other models). Those read as the names
 * providers.usageWindowLabel gives them, here localized — and Antigravity's four bucket ids
 * (`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`). The dashboard page applies the same rule
 * to the same nine words.
 */
export function vendorWindowLabel(label: string): string {
  switch (label.trim().toLowerCase()) {
    case 'primary':
      return vscode.l10n.t('Primary limit');
    case 'secondary':
      return vscode.l10n.t('Secondary limit');
    case 'total':
      return vscode.l10n.t('Total usage');
    case 'auto':
      return vscode.l10n.t('Auto + Composer');
    case 'api':
      return vscode.l10n.t('API usage');
    // Antigravity's four limits, by the bucket ids `agy -p /usage` reports.
    case 'gemini-weekly':
      return vscode.l10n.t('Gemini weekly');
    case 'gemini-5h':
      return vscode.l10n.t('Gemini 5-hour');
    case '3p-weekly':
      return vscode.l10n.t('Claude + GPT weekly');
    case '3p-5h':
      return vscode.l10n.t('Claude + GPT 5-hour');
    default:
      return label;
  }
}

/**
 * An elevated severity in words. The two values upstream is known to send are this product's
 * to translate; anything else is upstream's own word and is shown as written, display-safe.
 */
function severityText(severity: string): string {
  switch (severity) {
    case 'warning':
      return vscode.l10n.t('warning');
    case 'critical':
      return vscode.l10n.t('critical');
    default:
      return rowText(severity, 24);
  }
}

/**
 * One-line live-usage tail for a worker's collapsed `description`, e.g.
 * `· 5h 12% · 7d 72% · ⚠Fable 100%`. Handles all six render states.
 */
function usageSummary(usage: AccountUsage | undefined): string {
  if (!usage) {
    return vscode.l10n.t('usage: — (refreshing)');
  }
  if (usage.error !== undefined) {
    return vscode.l10n.t('usage unavailable');
  }
  if (isLoginExpired(usage)) {
    return expiredSummary();
  }
  if (usage.available !== true) {
    return isLoginSuspect(usage) ? unconfirmedSummary() : noLimitsMessage();
  }
  const windows = safeWindows(usage);
  if (windows.length === 0) {
    return isTempUnavailable(usage)
      ? vscode.l10n.t('plan usage unavailable (last reading {0})', agoText(usage.lastGoodWindowsAt))
      : noWindowsMessage();
  }
  return windows
    .map((w) => `${isElevated(w.severity) ? '⚠' : ''}${planWindowLabel(w, true)} ${pct(w.percent)}`)
    .join(' · ');
}

/**
 * Append a rich live-usage block to a worker's Markdown tooltip. Handles all six
 * render states. EVERYTHING goes through `appendText`, which escapes markdown
 * metacharacters: account-derived strings because a crafted plan name or stderr must not
 * break formatting, and the sentences around them because a translation is text too.
 */
function appendUsageTooltip(md: vscode.MarkdownString, usage: AccountUsage | undefined): void {
  md.appendMarkdown('\n\n');
  if (!usage) {
    md.appendText(vscode.l10n.t('Plan quota — usage: — (refreshing)'));
    return;
  }
  if (usage.error !== undefined) {
    md.appendText(vscode.l10n.t('Plan quota — usage unavailable'));
    md.appendMarkdown('\n\n');
    md.appendText(str(usage.error, ''));
    return;
  }
  if (usage.available !== true) {
    // The actionable "run Re-login Account" sentence is added by the caller, so
    // this section only labels the quota state — it does not repeat the advice.
    md.appendText(
      isLoginExpired(usage)
        ? vscode.l10n.t('Plan quota — login expired')
        : vscode.l10n.t('Plan quota — no plan limits (token/non-subscription login)'),
    );
    return;
  }
  const windows = safeWindows(usage);
  if (windows.length === 0) {
    md.appendText(
      isTempUnavailable(usage)
        ? vscode.l10n.t(
            'Plan quota — temporarily unavailable: upstream returned no data. Last good reading {0}.',
            agoText(usage.lastGoodWindowsAt),
          )
        : vscode.l10n.t('Plan quota — no rate-limit windows reported'),
    );
    return;
  }
  const plan = rowText(usage.subscriptionType, PLAN_NAME_MAX);
  md.appendMarkdown('**');
  md.appendText(
    plan === '-' ? vscode.l10n.t('Plan quota — subscription') : vscode.l10n.t('Plan quota — {0}', plan),
  );
  md.appendMarkdown('**');
  for (const w of windows) {
    md.appendMarkdown('\n\n');
    md.appendText(
      isElevated(w.severity)
        ? vscode.l10n.t(
            '{0}: {1} ⚠ {2} — resets {3}',
            planWindowLabel(w),
            pct(w.percent),
            severityText(w.severity),
            untilText(w.resetsAt),
          )
        : vscode.l10n.t('{0}: {1} — resets {2}', planWindowLabel(w), pct(w.percent), untilText(w.resetsAt)),
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Accounts on another vendor's CLI
 * ------------------------------------------------------------------------- */

/**
 * Row icon per provider, so the four read apart at a glance without relying on the text:
 * Claude Code keeps the icon the tree always had, Codex is a book, Cursor a pointer,
 * Antigravity a rocket. The provider's NAME is on the row as well — an icon is never the only
 * place a fact is stated.
 */
const PROVIDER_ICON: Record<ProviderId, string> = {
  claude: 'server-process',
  codex: 'book',
  cursor: 'inspect',
  gemini: 'rocket',
};

/**
 * What the usage cache says about a non-Claude account's LOGIN. The entry is written by the
 * provider status helper: `auth.loggedIn` is present only when the CLI gave a definite answer,
 * so an entry without it is "unknown", which is never shown as "logged out".
 */
type ProviderLogin =
  | { state: 'unchecked' } // no reading yet
  | { state: 'missing'; detail: string } // the CLI could not be started at all
  | { state: 'error'; detail: string } // the status check itself failed (helper missing, crashed)
  | { state: 'in'; mode: string | null }
  /**
   * `failedRunAt`: the verdict was recorded because a RUN failed on login and is still in
   * force (usage.runLoginFailureAt) — the time of that run. Absent for a verdict the CLI's own
   * status check gave.
   */
  | { state: 'out'; failedRunAt?: number }
  | { state: 'unknown' };

function providerLogin(usage: AccountUsage | undefined): ProviderLogin {
  if (!usage) {
    return { state: 'unchecked' };
  }
  if (isProviderCliMissing(usage)) {
    // "Install the CLI" is a different thing to tell someone than "the check failed".
    return { state: 'missing', detail: rowText(usage.error, PROBE_ERROR_MAX) };
  }
  const auth = parseAuth(usage.auth);
  if (auth?.loggedIn === true) {
    // A definite "logged in" stands even when the same reading carries an error: that error
    // is then about the USAGE half of the check, and it is shown on the usage row.
    const mode = sliceOneLine(flattenOneLine(auth.method ?? ''), AUTH_MODE_MAX).trimEnd();
    return { state: 'in', mode: mode === '' ? null : mode };
  }
  if (auth?.loggedIn === false) {
    const failedRunAt = runLoginFailureAt(usage);
    return failedRunAt === undefined ? { state: 'out' } : { state: 'out', failedRunAt };
  }
  if (usage.error !== undefined) {
    return { state: 'error', detail: rowText(usage.error, PROBE_ERROR_MAX) };
  }
  return { state: 'unknown' };
}

function providerLoginText(login: ProviderLogin): string {
  switch (login.state) {
    case 'unchecked':
      return vscode.l10n.t('not checked yet');
    case 'missing':
      return vscode.l10n.t('CLI not found');
    case 'error':
      return vscode.l10n.t('status unavailable');
    case 'in':
      return login.mode !== null
        ? vscode.l10n.t('logged in ({0})', login.mode)
        : vscode.l10n.t('logged in');
    case 'out':
      // A run that failed on login is a different fact from a status check that says "logged
      // out", and the more useful one: it is why dispatches stopped going to the account.
      return login.failedRunAt !== undefined
        ? vscode.l10n.t('logged out — the last run failed on login')
        : vscode.l10n.t('logged out — sign in needed');
    default:
      return vscode.l10n.t('login state unknown');
  }
}

/**
 * Usage windows of a non-Claude account, labelled with the VENDOR'S OWN label: the cache's
 * `kind` only says where a window sits in the list for these accounts, so the short Claude
 * names ("5h", "7d", "Fable") must not be put on them.
 */
function providerWindows(usage: AccountUsage | undefined): SafeWindow[] {
  // Capped at what the writer stores per account; a file edited to hold more draws no more rows.
  return usage ? safeWindows(usage, true).slice(0, PROVIDER_WINDOWS_SHOWN_MAX) : [];
}

/** One-line login + usage tail for a non-Claude account's collapsed `description`. */
function providerSummary(usage: AccountUsage | undefined): string {
  const login = providerLogin(usage);
  const windows = providerWindows(usage);
  if (windows.length === 0) {
    if (login.state !== 'in') {
      return providerLoginText(login);
    }
    // The same two words the Usage detail row uses: an error beside a definite login is the
    // usage half of the check failing, which is not the same as no reading having come back.
    return `${providerLoginText(login)} · ${
      usage?.error !== undefined ? vscode.l10n.t('usage unavailable') : vscode.l10n.t('no usage reading')
    }`;
  }
  const usageText =
    windows
      .map((w) => `${isElevated(w.severity) ? '⚠' : ''}${vendorWindowLabel(w.label)} ${pct(w.percent)}`)
      .join(' · ') +
    // Carried forward from an earlier reading: real numbers, but not current ones.
    (usage?.windowsStale === true ? ` · ⏱ ${agoText(usage.windowsFetchedAt)}` : '');
  // A usage reading only comes back for a working login, so "logged in" — or "login state
  // unknown" — next to real numbers would be noise; any other state is a contradiction worth
  // showing (a stale snapshot beside a failed check) and leads.
  return login.state === 'in' || login.state === 'unknown'
    ? usageText
    : `${providerLoginText(login)} · ${usageText}`;
}

/** Cap for a registry problem on a row (`UiHealth.registryProblem`). */
const REGISTRY_PROBLEM_MAX = 200;

/**
 * The row that stands in front of the accounts when the registry could not be read: what is
 * wrong with the file, in the registry reader's own words (a class of problem and position
 * numbers — never any of the file's text), and one click to open the file.
 *
 * It opens through the editor's own `vscode.open`, so no command of this extension has to
 * exist for it — the row must work in exactly the state in which the rest may not.
 */
function registryProblemItem(problem: string): vscode.TreeItem {
  const shown = rowText(problem, REGISTRY_PROBLEM_MAX);
  const item = new vscode.TreeItem(
    vscode.l10n.t('Registry could not be read'),
    vscode.TreeItemCollapsibleState.None,
  );
  item.description = shown;
  item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  // A plain string: the path is shown as written, never rendered as markdown.
  item.tooltip = vscode.l10n.t(
    'The worker registry ({0}) could not be read: {1}. Its accounts cannot be shown, and nothing that changes the registry works until the file is fixed or deleted. Click to open the file.',
    REGISTRY_FILE,
    shown,
  );
  item.command = {
    command: 'vscode.open',
    title: vscode.l10n.t('Open File'),
    arguments: [vscode.Uri.file(REGISTRY_FILE)],
  };
  item.contextValue = 'registryProblem';
  return item;
}

/**
 * Why a registry entry cannot be used, as its row says it: the three reasons of
 * uiModel.unsupportedEntryDetail — the dispatch server's wording — in the reader's language.
 * The entry is read by `typeof`: it is whatever the registry file holds.
 */
function unsupportedEntryText(entry: { reason?: unknown; providerText?: unknown } | undefined): string {
  if (entry?.reason === 'provider') {
    return vscode.l10n.t(
      'unknown provider "{0}"',
      sliceOneLine(flattenOneLine(typeof entry.providerText === 'string' ? entry.providerText : ''), 80),
    );
  }
  return entry?.reason === 'duplicate-name'
    ? vscode.l10n.t('duplicate name')
    : vscode.l10n.t('incomplete entry');
}

/**
 * The row of a registry entry this version cannot use. It shows that the entry is there and
 * why it is not an account, and offers one action — its removal, through the context menu
 * (`unsupportedWorker`). Nothing about it is read as an account: no usage, no login, no CLI.
 */
function unsupportedEntryItem(node: UnsupportedWorkerNode, detail: string): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.name === '' ? vscode.l10n.t('(unnamed entry)') : rowText(node.name, WORKER_NAME_MAX),
    vscode.TreeItemCollapsibleState.None,
  );
  item.description = detail;
  item.iconPath = new vscode.ThemeIcon('warning');
  item.tooltip = vscode.l10n.t(
    'This version of the extension cannot use this registry entry ({0}). A newer version of the extension may have written it. It is kept in the registry file untouched and takes part in nothing. To delete it, right-click and choose "Remove Registry Entry…".',
    detail,
  );
  item.contextValue = 'unsupportedWorker';
  return item;
}

/**
 * What an account's default model last RAN AS, from the shared task index: the id its CLI
 * reported for its newest finished task that used the default — for an account with no
 * default, its newest finished task that left the model to the CLI. Null when no task has
 * reported one: an alias is resolved by the account's own CLI, so nothing is said until it
 * was seen. (A vendor run that NAMED a model reports none — the adapters only echo the
 * request — so a vendor account with a default shows no "last ran" at all.)
 */
function defaultRanAs(worker: WorkerProfile, provider: ProviderId): string | null {
  const ranAs = modelLastRanAs(worker.name, provider, worker.model ? worker.model : null);
  return ranAs === null ? null : rowText(ranAs, TASK_MODEL_MAX);
}

/**
 * Does the frontier guard block the frontier tier right now? What the dispatch server
 * enforces is the shared registry's value (another editor may have set it), read from the
 * reading the tree already holds; anything but an explicit `allow` blocks.
 */
function frontierGuardBlocks(): boolean {
  try {
    return registryOnDisk.get().registry.frontierWorkerDispatch !== 'allow';
  } catch {
    return true;
  }
}

/** One hover line that says what the account's default last ran as — only when that is known. */
function appendRanAsLine(tooltip: vscode.MarkdownString, worker: WorkerProfile, provider: ProviderId): void {
  const ranAs = defaultRanAs(worker, provider);
  if (ranAs === null) {
    return;
  }
  tooltip.appendText(
    worker.model
      ? vscode.l10n.t('Default model {0} — last ran {1}', rowText(worker.model, TASK_MODEL_MAX), ranAs)
      : vscode.l10n.t('No default model (the CLI chooses) — last ran {0}', ranAs),
  );
  tooltip.appendMarkdown('\n\n');
}

/**
 * Two-level tree: worker accounts expand into per-account detail rows — availability, the
 * account's login and usage as its own CLI reports them (for Claude Code the real plan quota),
 * and this extension's dispatch totals in 5-hour / 7-day / all-time windows. Every account
 * shows which agent CLI it runs on. Accounts only: the live sessions running under them are
 * listed by the Team view (teamView.ts). After the accounts come the registry entries this
 * version cannot use, one row each, and in front of everything one row when the registry
 * itself could not be read (rootNodes).
 */
export class WorkersProvider implements vscode.TreeDataProvider<WorkerNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // `fs.unwatchFile(file)` without a listener removes *every* listener on that path,
  // including other providers' (TasksProvider watches TASKS_LOG_FILE, the dashboard
  // watches USAGE_CACHE_FILE). Keep each listener so dispose() can remove only ours.
  private readonly onStatsChange = (): void => this._onDidChangeTreeData.fire();
  private readonly onTasksChange = (): void => this._onDidChangeTreeData.fire();
  private readonly onUsageChange = (): void => this._onDidChangeTreeData.fire();
  private readonly onRegistryChange = (): void => this._onDidChangeTreeData.fire();

  constructor(workers: WorkerManager) {
    workers.onDidChange(() => this._onDidChangeTreeData.fire());
    // Usage/cooldown is written by the MCP server process — watch for changes.
    fs.watchFile(STATS_FILE, { interval: 2000 }, this.onStatsChange);
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, this.onTasksChange);
    // Live plan usage is written by a background refresher — watch its cache too.
    fs.watchFile(USAGE_CACHE_FILE, { interval: 2000 }, this.onUsageChange);
    // The registry is shared by every editor and is hand-editable: an account another window
    // added, and a file that stopped being readable, both have to reach this tree.
    fs.watchFile(REGISTRY_FILE, { interval: 2000 }, this.onRegistryChange);
  }

  dispose(): void {
    fs.unwatchFile(STATS_FILE, this.onStatsChange);
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
    fs.unwatchFile(USAGE_CACHE_FILE, this.onUsageChange);
    fs.unwatchFile(REGISTRY_FILE, this.onRegistryChange);
  }

  /**
   * Redraw because the USER asked — a command they ran. The task index behind the dispatch
   * totals is read again from the first byte of the log first (uiModel.rebuildTaskIndex);
   * the watchers above redraw without that.
   */
  refresh(): void {
    rebuildTaskIndex();
    this._onDidChangeTreeData.fire();
  }

  /** Redraw from what the index holds: for a change this extension just made itself. */
  redraw(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: WorkerNode): vscode.TreeItem {
    if (isStatRow(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      // The position is part of the id: a vendor may report two usage windows under one
      // label, and two rows with one id make VS Code refuse to draw the tree.
      item.id = detailRowId(node.worker, node.seq ?? 0, node.label);
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      item.command = node.command;
      item.contextValue = 'workerStat';
      return item;
    }
    if (isRegistryProblemRow(node)) {
      return registryProblemItem(node.problem);
    }
    if (isUnsupportedNode(node)) {
      return unsupportedEntryItem(node, unsupportedNodes.get(node) ?? '');
    }
    if (isUnsupportedRestRow(node)) {
      const item = new vscode.TreeItem(
        vscode.l10n.t('More entries this version cannot use'),
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = vscode.l10n.t('{0} not listed', node.count);
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = vscode.l10n.t(
        'The registry holds {0} more entries this version cannot use than are listed here. They are kept in the file untouched.',
        node.count,
      );
      item.contextValue = 'unsupportedRest';
      return item;
    }
    const stats = statsOf(node.name);
    const coolingDown = (stats?.cooldownUntil ?? 0) > Date.now();
    const provider = workerProvider(node);
    const info = providerInfo(provider);
    // The name and the model come from registry.json, which is hand-editable: what the row
    // SHOWS is display-safe, what identifies the row (`item.id`, the element commands
    // receive) stays the registry's own string.
    const item = new vscode.TreeItem(
      (node.preferred ? '★ ' : '') + rowText(node.name, WORKER_NAME_MAX),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    // The account's OWN reading. The cache holds one reading per directory, so a worker on
    // another vendor's CLI that somebody registered on a Claude Code account's directory has
    // none — and is never shown that account's plan usage or login as if it were its own.
    const usage = usageOf(node);
    // The provider's name leads every row, Claude Code included: with accounts of several
    // vendors in one list, a row that names none would have to be read as a guess.
    const parts: string[] = [info.label];
    if (provider === 'claude') {
      const expired = isLoginExpired(usage);
      parts.push(rowText(node.model, TASK_MODEL_MAX));
      if (node.preferred) {
        parts.push(vscode.l10n.t('preferred'));
      }
      if (coolingDown) {
        parts.push(vscode.l10n.t('⏸ cooldown'));
      }
      // No separate expired badge here: usageSummary already reports the expired
      // login in place of its old "no plan limits" fall-through, and the two
      // together read as contradictory copy on one row.
      parts.push(usageSummary(usage));
      const loginWord = loginSegment(usage);
      if (loginWord !== undefined) {
        parts.push(loginWord);
      }
      if (usage?.extraUsage?.enabled === true) {
        parts.push(vscode.l10n.t('⚠overage'));
      }
      if (usage?.windowsStale === true) {
        parts.push(vscode.l10n.t('⏱ plan usage {0}', agoText(usage.windowsFetchedAt)));
      }
      const sameAs = sameAccountNames(node, usage);
      if (sameAs.length > 0) {
        parts.push(vscode.l10n.t('same claude.ai account as {0}', sameAs.join(', ')));
      }
      item.description = parts.join(' · ');
      // The directory comes from registry.json, which is hand-editable: appendText escapes it,
      // so a path holding markdown (a link, an image, backticks) is shown and never rendered.
      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(vscode.l10n.t('Config directory: {0}', node.configDir));
      tooltip.appendMarkdown('\n\n');
      if (sameAs.length > 0) {
        tooltip.appendText(sameAccountSentence(sameAs));
        tooltip.appendMarkdown('\n\n');
      }
      appendRanAsLine(tooltip, node, provider);
      tooltip.appendText(
        vscode.l10n.t(
          'Expand for per-account usage · terminal button opens a live session · right-click for default model, re-login or remove',
        ),
      );
      if (expired) {
        tooltip.appendMarkdown('\n\n');
        tooltip.appendText(
          vscode.l10n.t('Login expired — run "Re-login Account" (right-click) to restore dispatches.'),
        );
      }
      tooltip.appendMarkdown('\n\n');
      tooltip.appendText(loginTooltip(usage));
      appendUsageTooltip(tooltip, usage);
      item.tooltip = tooltip;
    } else {
      const login = providerLogin(usage);
      const mode = workerPermissionMode(node);
      parts.push(
        node.model ? rowText(node.model, TASK_MODEL_MAX) : vscode.l10n.t('CLI default model'),
      );
      if (node.preferred) {
        parts.push(vscode.l10n.t('preferred'));
      }
      if (coolingDown) {
        parts.push(vscode.l10n.t('⏸ cooldown'));
      }
      // Shown only when it differs from what the provider does by default — the unusual case
      // is the one worth a place on a crowded line.
      if (mode !== info.defaultPermissionMode && mode !== null) {
        parts.push(vscode.l10n.t('mode {0}', mode));
      }
      parts.push(providerSummary(usage));
      item.description = parts.join(' · ');
      // Every account-derived value goes through appendText, as on a Claude Code row.
      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(
        adapterAccountDir(provider, node.configDir) === undefined
          ? vscode.l10n.t(
              '{0} account — the login already on this machine ({1})',
              info.label,
              node.configDir,
            )
          : vscode.l10n.t('{0} account — home directory: {1}', info.label, node.configDir),
      );
      tooltip.appendMarkdown('\n\n');
      appendRanAsLine(tooltip, node, provider);
      tooltip.appendText(
        vscode.l10n.t(
          'Dispatched one-shot through the `{0}` CLI, and only when a dispatch names this worker or its provider. Not attachable; edits the working tree in place.',
          info.cli,
        ),
      );
      tooltip.appendMarkdown('\n\n');
      tooltip.appendText(
        vscode.l10n.t(
          'Expand for login and usage · terminal button opens the `{0}` CLI · right-click for default model, permission mode, re-login or remove',
          info.cli,
        ),
      );
      if (login.state === 'out') {
        tooltip.appendMarkdown('\n\n');
        tooltip.appendText(
          vscode.l10n.t('Logged out — run "Re-login Account" (right-click) to restore dispatches.'),
        );
      } else if (login.state === 'missing') {
        tooltip.appendMarkdown('\n\n');
        tooltip.appendText(
          vscode.l10n.t(
            'The `{0}` CLI could not be started — it is not installed, or not on PATH. Dispatches to this worker fail until it is.',
            info.cli,
          ),
        );
      } else if (login.state === 'error') {
        tooltip.appendMarkdown('\n\n');
        tooltip.appendText(vscode.l10n.t('Status check failed: {0}', login.detail));
      }
      item.tooltip = tooltip;
    }
    item.iconPath = new vscode.ThemeIcon(coolingDown ? 'debug-pause' : PROVIDER_ICON[provider]);
    // `worker.<provider>`, plus `.permission` where a per-worker permission mode exists (every
    // provider but Claude Code). The menus in package.json match on these, so an action that
    // does not apply to a provider is not offered on its rows.
    // A Claude Code row whose login is CONFIRMED logged out adds `.loggedOut`: "Re-login Account"
    // is offered on such a row only (Login state (CA)) — every other state offers "Check Login Now".
    item.contextValue =
      provider === 'claude'
        ? `worker.claude${isLoginExpired(usage) ? '.loggedOut' : ''}`
        : `worker.${provider}.permission`;
    item.id = accountRowId(node.name);
    return item;
  }

  getChildren(node?: WorkerNode): WorkerNode[] {
    if (!node) {
      return this.rootNodes();
    }
    if (!isAccountNode(node)) {
      return [];
    }
    return this.statRows(node).map((row, seq) => {
      const made: WorkerStatRow = { ...row, seq };
      statRows.add(made);
      return made;
    });
  }

  /**
   * The top level, from ONE checked reading of the registry (registryOnDisk — read again only
   * when the file changed): the row that says the registry could not be read (when it could
   * not), the accounts, then the entries this version cannot use. Accounts only — live
   * sessions, dispatched workers included, are the Team view's.
   *
   * Each account node is remembered with the name it is listed under (accountRows): that is
   * what a command handed the node goes by.
   *
   * With a problem the registry reads as empty, and an empty tree would say "no workers";
   * the row in front says what is actually known. An unusable entry is drawn as its own kind
   * of row and never as an account: it is in no enumeration, and nothing here asks which CLI
   * it runs on. Never throws — a tree that cannot be drawn hides the very row this is for.
   */
  private rootNodes(): WorkerNode[] {
    const nodes: WorkerNode[] = [];
    try {
      const { registry, problem } = registryOnDisk.get();
      if (problem !== null) {
        const row: RegistryProblemRow = { kind: 'registryProblem', problem };
        registryProblemRows.add(row);
        nodes.push(row);
      }
      for (const worker of registry.workers) {
        accountRows.set(worker, worker.name);
        nodes.push(worker);
      }
      const unsupported = Array.isArray(registry.unsupportedWorkers) ? registry.unsupportedWorkers : [];
      unsupported.slice(0, UNSUPPORTED_ROWS_MAX).forEach((entry, index) => {
        const made: UnsupportedWorkerNode = {
          kind: 'unsupportedWorker',
          index,
          name: typeof entry?.name === 'string' ? entry.name : '',
        };
        unsupportedNodes.set(made, unsupportedEntryText(entry));
        nodes.push(made);
      });
      if (unsupported.length > UNSUPPORTED_ROWS_MAX) {
        const rest: UnsupportedRestRow = {
          kind: 'unsupportedRest',
          count: unsupported.length - UNSUPPORTED_ROWS_MAX,
        };
        unsupportedRestRows.add(rest);
        nodes.push(rest);
      }
    } catch {
      const row: RegistryProblemRow = { kind: 'registryProblem', problem: 'the read failed' };
      registryProblemRows.add(row);
      nodes.unshift(row);
    }
    return nodes;
  }

  private statRows(worker: WorkerProfile): WorkerStatRow[] {
    const stats = statsOf(worker.name);
    const now = Date.now();
    const coolingDown = (stats?.cooldownUntil ?? 0) > now;
    // One look at the shared task index for both windows — nothing here reads the log.
    const windows = dispatchWindows(worker.name, now);
    const session = windows.session5h;
    const week = windows.week;
    const rows: WorkerStatRow[] = [];

    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Status'),
      description: coolingDown
        ? vscode.l10n.t(
            'cooling down until {0} (quota error)',
            new Date(stats!.cooldownUntil!).toLocaleTimeString(),
          )
        : vscode.l10n.t('available'),
      icon: coolingDown ? 'debug-pause' : 'check',
      tooltip: coolingDown
        ? vscode.l10n.t(
            'Skipped by automatic assignment until the cooldown ends. Dispatches naming this worker explicitly still run.',
          )
        : vscode.l10n.t('Eligible for automatic assignment.'),
    });
    rows.push(this.defaultModelRow(worker));
    // The plan-quota rows are Claude Code's own (`get_usage`: plan windows, overage billing,
    // the expired-login reading). Another vendor's account shows what ITS CLI reported.
    if (workerProvider(worker) === 'claude') {
      this.pushPlanQuotaRows(rows, worker);
    } else {
      this.pushProviderRows(rows, worker);
    }
    // A task log that could not be read counts nothing, which is not "no dispatches": both
    // window rows say so instead of showing a zero.
    const logProblem = windows.problem === null ? undefined : rowText(windows.problem, PROBE_ERROR_MAX);
    const unreadTooltip =
      logProblem === undefined
        ? undefined
        : vscode.l10n.t(
            'The task log could not be read ({0}), so the dispatches in this window cannot be counted. This is not "no dispatches".',
            logProblem,
          );
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Dispatch · Session (5h)'),
      description:
        logProblem !== undefined
          ? vscode.l10n.t('task log unreadable')
          : session.tasks === 0
            ? vscode.l10n.t('no dispatches')
            : vscode.l10n.t(
                '{0} tasks · {1} in / {2} out',
                session.tasks,
                fmtTokens(session.inputTokens),
                fmtTokens(session.outputTokens),
              ),
      icon: logProblem !== undefined ? 'warning' : 'history',
      tooltip:
        unreadTooltip ??
        vscode.l10n.t(
          "Dispatches sent by this extension in the last 5 hours. Counts only this extension's traffic, not the account's overall consumption.",
        ),
    });
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Dispatch · Weekly (7d)'),
      description:
        logProblem !== undefined
          ? vscode.l10n.t('task log unreadable')
          : week.tasks === 0
            ? vscode.l10n.t('no dispatches')
            : vscode.l10n.t(
                '{0} tasks · {1} in / {2} out',
                week.tasks,
                fmtTokens(week.inputTokens),
                fmtTokens(week.outputTokens),
              ),
      icon: logProblem !== undefined ? 'warning' : 'calendar',
      tooltip:
        unreadTooltip ??
        vscode.l10n.t(
          "Dispatches sent by this extension in the last 7 days. Counts only this extension's traffic, not the account's overall consumption.",
        ),
    });
    // The all-time totals come from stats.json, which a person can edit: every figure is read
    // as a number or not at all, and a cost is shown only when there is one.
    const allTimeCost =
      stats !== undefined && typeof stats.costUsd === 'number' && Number.isFinite(stats.costUsd) && stats.costUsd > 0
        ? stats.costUsd.toFixed(2)
        : undefined;
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Dispatch · All time'),
      description: !stats
        ? vscode.l10n.t('no dispatches yet')
        : allTimeCost !== undefined
          ? vscode.l10n.t(
              '{0} tasks · {1} in / {2} out · ~${3}',
              wholeCount(stats.tasks),
              fmtTokens(stats.inputTokens),
              fmtTokens(stats.outputTokens),
              allTimeCost,
            )
          : vscode.l10n.t(
              '{0} tasks · {1} in / {2} out',
              wholeCount(stats.tasks),
              fmtTokens(stats.inputTokens),
              fmtTokens(stats.outputTokens),
            ),
      icon: 'graph',
      tooltip: vscode.l10n.t(
        "Every dispatch this extension has ever sent to this worker. Counts only this extension's traffic, not the account's overall consumption.",
      ),
    });
    if (stats && stats.errors > 0) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Errors'),
        // The last error is a CLI's own words as the server recorded them: a cut says it is
        // one ("…") and ends on a whole word; the hover has all of it.
        description: stats.lastError
          ? vscode.l10n.t('{0} · last: {1}', stats.errors, rowTextCut(stats.lastError, ERROR_ROW_MAX))
          : String(stats.errors),
        icon: 'warning',
        tooltip: stats.lastError,
      });
    }
    return rows;
  }

  /**
   * The account's default model and what it last ran as. An alias (`opus`) or "no default"
   * names no model version: the account's own CLI decides which one runs. So the row adds the
   * id that CLI REPORTED for the account's newest finished task that used the default — and
   * says nothing more than the default itself until one has.
   */
  private defaultModelRow(worker: WorkerProfile): WorkerStatRow {
    const provider = workerProvider(worker);
    const info = providerInfo(provider);
    const model = worker.model ? rowText(worker.model, TASK_MODEL_MAX) : undefined;
    const ranAs = defaultRanAs(worker, provider);
    const description =
      model !== undefined
        ? ranAs !== null
          ? vscode.l10n.t('{0} · last ran {1}', model, ranAs)
          : model
        : ranAs !== null
          ? vscode.l10n.t('CLI default · last ran {0}', ranAs)
          : vscode.l10n.t('CLI default');
    const what =
      model !== undefined
        ? vscode.l10n.t(
            'Dispatches that name no model run on {0}. An alias is resolved by the `{1}` CLI of this account to the newest model of that family it offers.',
            model,
            info.cli,
          )
        : vscode.l10n.t(
            'No default is stored: a dispatch that names no model runs on the model the `{0}` CLI chooses.',
            info.cli,
          );
    const seen =
      ranAs !== null
        ? vscode.l10n.t(
            'The newest finished task of this account that used the default ran {0} — the id its CLI reported.',
            ranAs,
          )
        : vscode.l10n.t('No finished task of this account has reported which model the default ran as yet.');
    // A default on the frontier tier, while the guard blocks that tier: the account takes no
    // dispatch that leaves the model to it. Said here, where the default is shown.
    const guarded =
      provider === 'claude' && isFrontierModel(worker.model) && frontierGuardBlocks()
        ? vscode.l10n.t(
            'The frontier guard blocks this tier: while it does, dispatches that name no model skip this account.',
          )
        : undefined;
    return {
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Default model'),
      description,
      icon: 'chip',
      tooltip: [what, seen, guarded].filter((part) => part !== undefined).join(' '),
    };
  }

  /**
   * Detail rows of an account on another vendor's CLI, from the usage cache (never spawns):
   * which CLI it is and how it is dispatched, its login state, one row per usage window the
   * vendor reported — or a single "no usage reading" row — and its permission mode.
   *
   * Nothing here is keyed on WHICH provider it is: whether a vendor reports usage is decided
   * by the reading that came back, so a later adapter that starts reporting it lights these
   * rows up with no change here.
   */
  private pushProviderRows(rows: WorkerStatRow[], worker: WorkerProfile): void {
    const provider = workerProvider(worker);
    const info = providerInfo(provider);
    const usage = usageOf(worker);
    const ambient = adapterAccountDir(provider, worker.configDir) === undefined;

    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Provider'),
      description: ambient
        ? vscode.l10n.t('{0} · the login already on this machine', info.label)
        : vscode.l10n.t('{0} · its own login', info.label),
      icon: PROVIDER_ICON[provider],
      tooltip: vscode.l10n.t(
        'Runs on the `{0}` CLI as a one-shot worker. A dispatch reaches it only when it names this worker or asks for this provider; it is not attachable, and it edits the working tree in place.',
        info.cli,
      ),
    });

    const login = providerLogin(usage);
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Login'),
      description: providerLoginText(login),
      icon:
        login.state === 'in'
          ? 'pass'
          : login.state === 'out' || login.state === 'error' || login.state === 'missing'
            ? 'warning'
            : login.state === 'unchecked'
              ? 'sync'
              : 'question',
      tooltip:
        login.state === 'missing'
          ? vscode.l10n.t(
              'The `{0}` CLI could not be started — it is not installed, or not on PATH ({1}). Install it, then run "Refresh Account Usage".',
              info.cli,
              login.detail,
            )
          : login.state === 'out' && login.failedRunAt !== undefined
          ? // Proved by a run, not read from the status check — and held against that check,
            // which for some CLIs says "logged in" regardless.
            vscode.l10n.t(
              'The last dispatch to this account failed on login ({0}). It counts as logged out, whatever the status check of the `{1}` CLI says, until a dispatch to it succeeds, you run "Re-login Account" (right-click the worker), or 30 minutes have passed.',
              agoText(login.failedRunAt),
              info.cli,
            )
          : login.state === 'out'
          ? info.loginArgs !== null
            ? vscode.l10n.t(
                'The `{0}` CLI reports this account logged out. Dispatches to it fail until you run "Re-login Account" (right-click the worker).',
                info.cli,
              )
            : vscode.l10n.t(
                'The `{0}` CLI reports this account logged out. {1} signs in through its own app, not the CLI — sign in there, then refresh account usage.',
                info.cli,
                info.label,
              )
          : login.state === 'error'
            ? login.detail
            : login.state === 'unchecked'
              ? ownsReading(worker)
                ? vscode.l10n.t('No reading yet — the background refresher will populate this shortly.')
                : // Never read, and it will not be: saying "shortly" would be a promise nobody keeps.
                  vscode.l10n.t(
                    'No reading is kept for this account: its directory is also the directory of another account, and one directory holds one reading. Give this worker a home directory of its own to see its login and usage.',
                  )
              : login.state === 'unknown'
                ? vscode.l10n.t(
                    'The `{0}` CLI did not say whether this account is logged in. That is not the same as logged out.',
                    info.cli,
                  )
                : vscode.l10n.t('The `{0}` CLI reports this account logged in.', info.cli),
    });

    const windows = providerWindows(usage);
    if (windows.length === 0) {
      // A status check that failed ALTOGETHER is already on the Login row; an error next to a
      // definite login is about the usage half of the check and belongs here.
      const usageError =
        usage?.error !== undefined && login.state !== 'error' && login.state !== 'missing'
          ? rowText(usage.error, PROBE_ERROR_MAX)
          : undefined;
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Usage'),
        description:
          usageError !== undefined
            ? vscode.l10n.t('usage unavailable')
            : usage
              ? vscode.l10n.t('no usage reading')
              : vscode.l10n.t('not checked yet'),
        icon: usageError !== undefined ? 'warning' : 'circle-slash',
        tooltip:
          usageError ??
          vscode.l10n.t(
            'No usage reading came back for this account: its CLI did not report one, or "Provider Usage Polling" is turned off in the settings. This is not "no usage", and dispatch is unaffected.',
          ),
      });
    } else {
      if (usage?.windowsStale === true) {
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: vscode.l10n.t('Usage · (stale)'),
          description: vscode.l10n.t(
            'showing the last reading, from {0}',
            agoText(usage.windowsFetchedAt),
          ),
          icon: 'clock',
          tooltip: vscode.l10n.t(
            'The numbers below are the last usage reading, not current: the newest status of this account came without one. They are kept for up to 30 minutes, then cleared.',
          ),
        });
      }
      for (const w of windows) {
        const elevated = isElevated(w.severity);
        // The vendor's own label, except for a bare technical word (vendorWindowLabel).
        const name = vendorWindowLabel(w.label);
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: vscode.l10n.t('Usage · {0}', name),
          description: vscode.l10n.t('{0} · resets {1}', pct(w.percent), untilText(w.resetsAt)),
          icon: elevated ? 'warning' : 'pulse',
          tooltip: vscode.l10n.t(
            'Usage as reported for this {0} account — {1}: {2}, resets {3}.',
            info.label,
            name,
            pct(w.percent),
            untilText(w.resetsAt),
          ),
        });
      }
    }

    const mode = workerPermissionMode(worker);
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: vscode.l10n.t('Permission mode'),
      description:
        mode === null
          ? vscode.l10n.t("the CLI's own default")
          : mode === info.defaultPermissionMode
            ? vscode.l10n.t('{0} (provider default)', mode)
            : mode,
      icon: 'shield',
      tooltip: vscode.l10n.t(
        'The permission / sandbox mode handed to the `{0}` CLI for this worker\'s dispatches. Change it with "Set Permission Mode" (right-click the worker). The "Worker Permission Mode" setting applies to Claude Code workers only.',
        info.cli,
      ),
    });
  }

  /**
   * Live plan-quota rows from the cached `get_usage` reading (never spawns).
   * Renders one row per rate-limit window when available, or a single row for
   * the refreshing / unavailable / no-limits / no-windows states.
   */
  private pushPlanQuotaRows(rows: WorkerStatRow[], worker: WorkerProfile): void {
    const usage = usageOf(worker);
    const planQuota = vscode.l10n.t('Plan quota');

    if (!usage) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: planQuota,
        description: vscode.l10n.t('usage: — (refreshing)'),
        icon: 'sync',
        tooltip: vscode.l10n.t(
          'No cached reading yet — the background refresher will populate this shortly.',
        ),
      });
      return;
    }
    if (usage.error !== undefined) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: planQuota,
        description: vscode.l10n.t('usage unavailable'),
        icon: 'warning',
        // The probe's own words, shown as data.
        tooltip: str(usage.error, ''),
      });
      return;
    }
    if (usage.available !== true || isLoginExpired(usage)) {
      if (!isLoginExpired(usage) && isLoginSuspect(usage)) {
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: planQuota,
          description: unconfirmedSummary(),
          icon: 'sync',
          tooltip: loginTooltip(usage),
        });
        return;
      }
      if (isLoginExpired(usage)) {
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: planQuota,
          description: vscode.l10n.t('login expired'),
          icon: 'warning',
          tooltip: vscode.l10n.t(
            'This account\'s subscription login expired or was logged out. Plan usage is unavailable and dispatches to it fail until you run "Re-login Account" (right-click the worker).',
          ),
        });
        return;
      }
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: planQuota,
        description: noLimitsMessage(),
        icon: 'circle-slash',
        tooltip: vscode.l10n.t(
          'This account exposes no claude.ai plan rate limits — typically a setup-token or non-subscription login. This is a valid state, not an error.',
        ),
      });
      return;
    }
    const windows = safeWindows(usage);
    if (windows.length === 0) {
      if (isTempUnavailable(usage)) {
        const lastGood = agoText(usage.lastGoodWindowsAt);
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: planQuota,
          description: vscode.l10n.t('temporarily unavailable — last good reading {0}', lastGood),
          icon: 'warning',
          tooltip: vscode.l10n.t(
            "get_usage is intermittently returning no rate-limit data for this account — a known upstream flakiness. The last good reading was {0}. This is unrelated to the account having no plan (that state reads 'no plan limits'); the numbers return on their own once upstream reports windows again.",
            lastGood,
          ),
        });
        return;
      }
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: planQuota,
        description: noWindowsMessage(),
        icon: 'info',
        tooltip: vscode.l10n.t(
          'The account has a subscription but reported no rate-limit windows in the last reading. This is a valid state, not an error.',
        ),
      });
      return;
    }
    if (usage.windowsStale === true) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Plan · (stale)'),
        description: vscode.l10n.t(
          'showing last reading from {0} — upstream returned no data',
          agoText(usage.windowsFetchedAt),
        ),
        icon: 'clock',
        tooltip: vscode.l10n.t(
          'The numbers below are the last good reading, not current. They are kept for up to 30 minutes while get_usage returns no rate-limit data, then cleared.',
        ),
      });
    }
    // The plan's name is the account's own word for it (`max`, `pro`): data, shown display-safe.
    const plan = rowText(usage.subscriptionType, PLAN_NAME_MAX);
    for (const w of windows) {
      const elevated = isElevated(w.severity);
      const name = planWindowLabel(w);
      const used = pct(w.percent);
      const resets = untilText(w.resetsAt);
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Plan · {0}', name),
        description: vscode.l10n.t('{0} · resets {1}', used, resets),
        icon: elevated ? 'warning' : 'pulse',
        // One sentence per combination, rather than a sentence assembled from optional parts.
        tooltip:
          plan !== '-'
            ? elevated
              ? vscode.l10n.t(
                  'Real plan usage ({0}) — {1}: {2} ⚠ {3} — resets {4}',
                  plan,
                  name,
                  used,
                  severityText(w.severity),
                  resets,
                )
              : vscode.l10n.t('Real plan usage ({0}) — {1}: {2} — resets {3}', plan, name, used, resets)
            : elevated
              ? vscode.l10n.t(
                  'Real plan usage — {0}: {1} ⚠ {2} — resets {3}',
                  name,
                  used,
                  severityText(w.severity),
                  resets,
                )
              : vscode.l10n.t('Real plan usage — {0}: {1} — resets {2}', name, used, resets),
      });
    }
    const extra = safeExtraUsage(usage);
    if (extra !== null) {
      // The spend is money as the account reported it ("$0.00 / $50.00"): data.
      const spend = extra.spendLabel !== null ? rowText(extra.spendLabel, 48) : null;
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Plan · Extra usage'),
        description: !extra.enabled
          ? vscode.l10n.t('off · plan limits block instead of billing')
          : spend !== null && extra.percent !== null
            ? vscode.l10n.t('ON · {0} · {1}% of cap', spend, extra.percent)
            : spend !== null
              ? vscode.l10n.t('ON · {0}', spend)
              : extra.percent !== null
                ? vscode.l10n.t('ON · {0}% of cap', extra.percent)
                : vscode.l10n.t('ON'),
        icon: extra.enabled ? 'warning' : 'shield',
        tooltip: extra.enabled
          ? vscode.l10n.t(
              "Overage billing is ON: dispatching past a plan window bills money against this account's monthly cap instead of being blocked.",
            )
          : vscode.l10n.t(
              'Overage billing is off: exhausting a plan window blocks work until it resets — no money is spent. Turn it on to bill past the limit against a monthly cap.',
            ),
      });
    }
  }
}

/** Cap for a task log problem on a row (`UiHealth.taskLogProblem`). */
const TASK_LOG_PROBLEM_MAX = 120;

/** The row a task tree opens with when the task log could not be read. */
export interface TaskLogProblemRow {
  kind: 'taskLogProblem';
  problem: string;
}

/** The closing row of the Tasks tree: how many older tasks it does not list. */
interface OlderTasksRow {
  kind: 'olderTasks';
  count: number;
}

/**
 * The turns of one Claude Code Orchestrator team, folded into one row (team contract L12): every
 * member turn is a task of the log (I13), and a team of four would otherwise flood the list.
 * Collapsed by default; its children are the turns, newest first, each a task row like any other
 * (Cancel included — routed to the team engine by cancelTaskMeshAware, M8).
 */
export interface TeamTurnsRow {
  kind: 'teamTurns';
  teamId: string;
  rows: TaskRow[];
}

/** A row of the Tasks tree: a task of the shared index, a team's turns, or one of the two rows about the list. */
export type TaskNode = TaskRow | OlderTasksRow | TaskLogProblemRow | TeamTurnsRow;

/** Is this node a task? The rows of the index carry no `kind`; the two others are made here. */
export function isTaskNode(node: TaskRow | { kind: string }): node is TaskRow {
  return !('kind' in node);
}

/**
 * The row that says the task log could not be read. An unreadable log yields no tasks, and a
 * tree that then showed nothing would be saying "nothing was dispatched"; this says what is
 * known instead. The problem is the index's own text — a reason and numbers, no path and no
 * byte of the file.
 */
export function taskLogProblemItem(problem: string): vscode.TreeItem {
  const shown = rowText(problem, TASK_LOG_PROBLEM_MAX);
  const item = new vscode.TreeItem(
    vscode.l10n.t('Task log could not be read'),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = 'task-log:problem';
  item.description = shown;
  item.iconPath = new vscode.ThemeIcon('warning');
  item.tooltip = vscode.l10n.t(
    'The task log could not be read: {0}. This is not "no tasks" — the tasks recorded in it cannot be listed until it can be read again.',
    shown,
  );
  item.contextValue = 'taskLogProblem';
  return item;
}

/** Cap for a session worker's name on a row (`UiSession.name`). */
const MESH_WORKER_NAME_MAX = 80;

/**
 * A task-log line longer than this is not read back for its team fields: the engine's lines are
 * a few KiB (registry.TASK_EVENT_MAX_BYTES bounds every writer); a longer one is no team turn.
 */
const TEAM_ROW_LINE_MAX_BYTES = 256 * 1024;
/** team.json is read up to this for a team's name when the team client does not know it. */
const TEAM_HEADER_READ_MAX_BYTES = 64 * 1024;

/** The team fields of a row's latest event (registry.taskEventTeam), or null for a task that is no team turn. */
const rowTeams = new WeakMap<TaskRow, { team: string; member?: string } | null>();
/** Team names read from `teams/<id>/team.json`, by id; null when it could not be read. */
const teamHeaderNames = new Map<string, string | null>();

/**
 * Learn the team fields of the rows not yet known, opening the log once for all of them. The
 * index rows carry no team field (uiModel.TaskRow), so each latest event is read back from where
 * the index found it (`at`, `len`) — as uiModel.loadDetails does — and believed only when it is
 * the same task's line (its id). A read that could not be made leaves the row unknown, to be
 * tried again; only an answer is kept. Never throws.
 */
function learnRowTeams(rows: readonly TaskRow[]): void {
  const wanted = rows.filter((row) => !rowTeams.has(row));
  if (wanted.length === 0) {
    return;
  }
  let fd = -1;
  try {
    fd = fs.openSync(TASKS_LOG_FILE, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return;
    }
    for (const row of wanted) {
      if (row.len <= 0 || row.len > TEAM_ROW_LINE_MAX_BYTES) {
        rowTeams.set(row, null);
        continue;
      }
      if (row.at + row.len > st.size) {
        continue;
      }
      const bytes = Buffer.alloc(row.len);
      if (fs.readSync(fd, bytes, 0, row.len, row.at) !== row.len) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(bytes.toString('utf8'));
      } catch {
        continue; // not the line the index read
      }
      if (typeof event !== 'object' || event === null || (event as { id?: unknown }).id !== row.id) {
        continue;
      }
      rowTeams.set(row, taskEventTeam(event) ?? null);
    }
  } catch {
    // the log could not be opened or read: nothing is known, and nothing is remembered
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — nothing to do
      }
    }
  }
}

/**
 * A team's name for its turns row: the team client's, else its `team.json` header's (read once,
 * bounded, a link refused), else the id itself. Display-safe.
 */
function teamTurnsName(teamId: string): string {
  let name: string | undefined;
  try {
    name = teamTaskHooks?.teamName(teamId);
  } catch {
    name = undefined;
  }
  if (name === undefined) {
    let cached = teamHeaderNames.get(teamId);
    if (cached === undefined) {
      cached = null;
      try {
        const read = readTextSafe(
          path.join(teamDirOf(ROOT_DIR, teamId), TEAM_DIR_ENTRIES.header),
          TEAM_HEADER_READ_MAX_BYTES,
          { noFollow: true },
        );
        if (read.ok) {
          const header: unknown = JSON.parse(read.text);
          const raw = typeof header === 'object' && header !== null ? (header as { name?: unknown }).name : undefined;
          cached = typeof raw === 'string' && raw !== '' ? raw : null;
        }
      } catch {
        cached = null;
      }
      if (teamHeaderNames.size > 200) {
        teamHeaderNames.clear();
      }
      teamHeaderNames.set(teamId, cached);
    }
    name = cached ?? undefined;
  }
  return rowText(name ?? teamId, 64) || teamId;
}

/**
 * A task's status as a row and its hover say it, in the reader's language. The five are the
 * ones the shared task index assigns: `running` and `done` from the log, and `cancelled` /
 * `orphaned` / `failed` from the first word of a recorded error.
 */
function taskStatusText(status: UiTaskStatus): string {
  switch (status) {
    case 'running':
      return vscode.l10n.t('running');
    case 'done':
      return vscode.l10n.t('done');
    case 'cancelled':
      return vscode.l10n.t('cancelled');
    case 'orphaned':
      return vscode.l10n.t('orphaned');
    default:
      return vscode.l10n.t('error');
  }
}

/** The status-shaped icon of a task row. */
function taskStatusIcon(status: UiTaskStatus): string {
  switch (status) {
    case 'running':
      return 'sync~spin';
    case 'done':
      return 'check';
    case 'cancelled':
      return 'circle-slash';
    case 'orphaned':
      return 'debug-disconnect';
    default:
      return 'error';
  }
}

/**
 * Ceiling on the persisted prompt file this view will read.
 *
 * The writer's own ceiling is 64 KiB plus a truncation marker (mcp/bg-runner
 * PROMPT_FILE_MAX_BYTES), so 128 KiB is exactly twice any file this product writes — room for
 * a hand-edited or older file, and a refusal for anything that was grown to be read. It buys
 * nothing to read more: this string ends up in a hover tooltip.
 */
const PROMPT_FILE_READ_MAX_BYTES = 128 * 1024;

/**
 * The fullest prompt text available for a task: the complete dispatched prompt from the
 * task's prompt file when there is one, else the ~300-char preview its event carries.
 *
 * THE FILE IS FOUND BY THE TASK'S ID (registry.readTaskFile): `<id>.prompt.txt` in the tasks
 * directory, read bounded and non-blocking, a symbolic link at that name refused. The
 * `promptFile` path an event records is never opened: the log is a file any process running
 * as this user can append a line to, and a hover must not show the contents of whatever file
 * a line names.
 *
 * The fallback is deliberately the same for every failure — absent, unreadable, oversized, not
 * a file — and that collapse is correct HERE: the value is a display string with exactly two
 * states (the full text, or the preview), no caller draws a conclusion from which one it got,
 * and the preview is never worse than empty.
 *
 * Exported: the Worker History view builds the same hover and must read under the same guard
 * and the same cap — one owner for the rule, not a second copy of it.
 */
export function taskPromptText(row: TaskRow): string {
  const read = readTaskFile(row.id, 'prompt', PROMPT_FILE_READ_MAX_BYTES);
  return read.ok ? read.text : (taskDetail(row).promptPreview ?? '');
}

/** How long the ledger records read for one hover serve the next ones. */
const LEDGER_HOVER_MS = 3_000;

/**
 * The dispatched tasks of the shared task index (uiModel.listTasks), which follows the
 * tasks.jsonl the MCP dispatch server appends to as the main session fans tasks out. Scoped
 * to the current workspace by default (dispatches record their cwd); toggleable to show all
 * workspaces.
 *
 * WHAT A REDRAW COSTS. `getChildren` asks the index for the newest TASK_LIST_MAX tasks and
 * adds one closing row that counts the rest: with an unchanged log that is a `stat`. A row
 * (`getTreeItem`) is built from the index's row alone — no file is opened for it. Everything
 * that needs a file — the prompt, the error text, the worktree and branch of a session
 * worker — belongs to the HOVER, and is read in `resolveTreeItem`, which the editor calls for
 * the one row the pointer is on.
 */
export class TasksProvider implements vscode.TreeDataProvider<TaskNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** true → only tasks dispatched from the current workspace. */
  scopeToWorkspace = true;

  /** Kept so dispose() removes only this listener — WorkersProvider watches this path too. */
  private readonly onTasksChange = (): void => this._onDidChangeTreeData.fire();

  /**
   * Every mesh ledger record, as read for the last hover of a session-worker row, so that
   * moving along such rows does not re-read every state file per row. Dropped by each
   * getChildren and after LEDGER_HOVER_MS. Joined to a task by the record's TASK ID
   * (ledgerRecordForTask), never by the worker's name.
   */
  private ledger: { at: number; records: LedgerRecord[] } | undefined;

  constructor() {
    fs.watchFile(TASKS_LOG_FILE, { interval: 1500 }, this.onTasksChange);
  }

  dispose(): void {
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
  }

  /**
   * Redraw because the USER asked — a command they ran. The index is read again from the
   * first byte of the log first (uiModel.rebuildTaskIndex), which is what brings a log that
   * was rewritten in place back in step; the watcher above redraws without that.
   */
  refresh(): void {
    rebuildTaskIndex();
    this._onDidChangeTreeData.fire();
  }

  /** Redraw from what the index holds: for a change to the log this extension just made itself. */
  redraw(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TaskNode): vscode.TreeItem {
    if (!isTaskNode(node)) {
      if (node.kind === 'teamTurns') {
        return this.teamTurnsItem(node);
      }
      return node.kind === 'taskLogProblem' ? taskLogProblemItem(node.problem) : this.olderTasksItem(node.count);
    }
    // The title, the account and the model are stored as a caller supplied them, in a log any
    // dispatched worker can append to: the index holds them flattened and capped.
    const item = new vscode.TreeItem(node.title);
    // A new event of the task is a new row to the editor. (0: its latest event has no time.)
    item.id = `${node.id}-${node.lastTs ?? 0}`;
    // package.json shows the inline Cancel button only on `runningTask`.
    item.contextValue = node.status === 'running' ? 'runningTask' : 'task';

    // A task another vendor's CLI ran says so first; a Claude Code task reads as it always did.
    const ranOn = taskProviderLabel(node);
    item.description = [ranOn, node.worker, node.model, taskStatusText(node.status)]
      .filter((part) => part !== undefined)
      .join(' · ');

    // Keep the status-shaped icon; add a dispatch-mode color (session worker = blue, detached =
    // purple, one-shot = default/no color) so the row's mode reads at a glance.
    const color =
      node.mode === 'session'
        ? new vscode.ThemeColor('charts.blue')
        : node.mode === 'detached'
          ? new vscode.ThemeColor('charts.purple')
          : undefined;
    item.iconPath = new vscode.ThemeIcon(taskStatusIcon(node.status), color);
    // The argument is the task's ID. The command finds the report that id names; the path an
    // event records is not handed to anything that opens files.
    item.command = {
      command: 'claudeCodeOrchestrator.showTaskOutput',
      title: vscode.l10n.t('Show Task Output'),
      arguments: [node.id],
    };
    // No tooltip here, on purpose: left undefined, the editor asks resolveTreeItem for it when
    // the row is hovered.
    return item;
  }

  /** The hover of one row — the only place a task row reads a file. */
  resolveTreeItem(item: vscode.TreeItem, node: TaskNode): vscode.TreeItem {
    if (isTaskNode(node)) {
      item.tooltip = this.tooltipOf(node);
    }
    return item;
  }

  getChildren(element?: TaskNode): TaskNode[] {
    if (element) {
      return !isTaskNode(element) && element.kind === 'teamTurns' ? element.rows : [];
    }
    this.ledger = undefined;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const list = listTasks({
      root: this.scopeToWorkspace && root ? root : undefined,
      limit: TASK_LIST_MAX,
    });
    const nodes: TaskNode[] = [];
    if (list.problem !== null) {
      nodes.push({ kind: 'taskLogProblem', problem: list.problem });
    }
    // L12: a team's turns fold into one row, placed where its newest turn would be.
    learnRowTeams(list.rows);
    const teamRows = new Map<string, TeamTurnsRow>();
    for (const row of list.rows) {
      const team = rowTeams.get(row);
      if (team === undefined || team === null) {
        nodes.push(row);
        continue;
      }
      const group = teamRows.get(team.team);
      if (group === undefined) {
        const created: TeamTurnsRow = { kind: 'teamTurns', teamId: team.team, rows: [row] };
        teamRows.set(team.team, created);
        nodes.push(created);
      } else {
        group.rows.push(row);
      }
    }
    if (list.total > list.rows.length) {
      nodes.push({ kind: 'olderTasks', count: list.total - list.rows.length });
    }
    return nodes;
  }

  private teamTurnsItem(node: TeamTurnsRow): vscode.TreeItem {
    const item = new vscode.TreeItem(
      vscode.l10n.t('Team {0} turns', teamTurnsName(node.teamId)),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `team-turns:${node.teamId}`;
    const running = node.rows.filter((row) => row.status === 'running').length;
    item.description =
      running > 0
        ? vscode.l10n.t('{0} turns · {1} running', node.rows.length, running)
        : vscode.l10n.t('{0} turns', node.rows.length);
    item.iconPath = new vscode.ThemeIcon('organization');
    item.tooltip = vscode.l10n.t(
      'The member turns of team {0}, newest first. Cancelling a running turn pauses its member through the team instead of killing it.',
      teamTurnsName(node.teamId),
    );
    item.contextValue = 'teamTurns';
    return item;
  }

  private olderTasksItem(count: number): vscode.TreeItem {
    const item = new vscode.TreeItem(
      vscode.l10n.t('Older tasks — open the dashboard'),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = 'tasks:older';
    item.description = vscode.l10n.t('{0} not listed', count);
    item.iconPath = new vscode.ThemeIcon('ellipsis');
    item.tooltip = vscode.l10n.t(
      'This list shows the newest {0} tasks; {1} older ones are not listed. The dashboard shows the totals and the daily history.',
      TASK_LIST_MAX,
      count,
    );
    item.command = {
      command: 'claudeCodeOrchestrator.openDashboard',
      title: vscode.l10n.t('Open Dashboard'),
    };
    item.contextValue = 'olderTasks';
    return item;
  }

  private ledgerRecords(): LedgerRecord[] {
    const now = Date.now();
    if (this.ledger === undefined || Math.abs(now - this.ledger.at) > LEDGER_HOVER_MS) {
      // Every failure inside is "no records", which costs a hover its worktree line and
      // nothing else.
      this.ledger = { at: now, records: readAllMeshWorkerRecords() };
    }
    return this.ledger.records;
  }

  /**
   * Full-metadata hover. Prompt and error text are untrusted (account-derived) and go through
   * appendText, which escapes markdown metacharacters; the config-derived metadata values
   * (model, account, cwd, worktree) do too, out of the same caution. Every line is a whole
   * sentence in the reader's language with the values set into it, and every line goes
   * through appendText: a translation is text like any other.
   */
  private tooltipOf(row: TaskRow): vscode.MarkdownString {
    const ranOn = taskProviderLabel(row);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown('**');
    tip.appendText(
      row.mode === 'session'
        ? vscode.l10n.t(
            'Mesh — attachable claude --bg (worker {0})',
            rowText(row.sessionWorker, MESH_WORKER_NAME_MAX),
          )
        : ranOn !== undefined
          ? // Never "claude -p": this task did not run on Claude Code.
            row.mode === 'detached'
            ? vscode.l10n.t('Detached (supervised) — {0}', ranOn)
            : vscode.l10n.t('One-shot — {0}', ranOn)
          : row.mode === 'detached'
            ? vscode.l10n.t('Detached (supervised)')
            : vscode.l10n.t('One-shot (claude -p)'),
    );
    tip.appendMarkdown('**');
    tip.appendMarkdown('\n\n');
    tip.appendText(vscode.l10n.t('Task {0}', row.id));
    tip.appendMarkdown('\n\n');
    tip.appendText(taskModelLine(row));
    const modelSource = taskModelSourceLine(row);
    if (modelSource !== undefined) {
      tip.appendMarkdown('\n\n');
      tip.appendText(modelSource);
    }
    if (row.cwd !== undefined) {
      tip.appendMarkdown('\n\n');
      // A session worker's worktree and branch live in its ledger record — the record of THIS
      // TASK (its task id), never of whichever worker last carried the same name.
      const rec =
        row.mode === 'session'
          ? ledgerRecordForTask(this.ledgerRecords(), row.id, row.sessionWorker ?? undefined)
          : undefined;
      const worktree = typeof rec?.worktree === 'string' && rec.worktree !== '' ? rec.worktree : undefined;
      const branch = typeof rec?.branch === 'string' && rec.branch !== '' ? rec.branch : undefined;
      tip.appendText(
        worktree === undefined
          ? vscode.l10n.t('cwd {0}', row.cwd)
          : branch === undefined
            ? vscode.l10n.t('cwd {0} · worktree {1}', row.cwd, worktree)
            : vscode.l10n.t('cwd {0} · worktree {1} (branch {2})', row.cwd, worktree, branch),
      );
    }
    tip.appendMarkdown('\n\n');
    // A time the index did not take as one (uiModel.recordedTime) is said to be unknown: no
    // clock time and no duration is made up for it.
    if (row.status === 'running') {
      // Since the task's first event when that is its start, else since the last one the log has.
      const since = row.startedAt ?? row.lastTs;
      if (since === null) {
        tip.appendText(
          vscode.l10n.t('Started at an unknown time — the task log records a time in the future'),
        );
      } else {
        const runningMin = Math.max(0, Math.round((Date.now() - since) / 60_000));
        tip.appendText(
          vscode.l10n.t('Started {0} · running {1}m', new Date(since).toLocaleTimeString(), runningMin),
        );
      }
    } else if (row.lastTs === null) {
      tip.appendText(vscode.l10n.t('Ended at an unknown time — the task log records a time in the future'));
    } else {
      tip.appendText(vscode.l10n.t('Ended {0}', new Date(row.lastTs).toLocaleTimeString()));
    }
    tip.appendMarkdown('\n\n');
    tip.appendText(vscode.l10n.t('Status: {0}', taskStatusText(row.status)));
    const promptText = taskPromptText(row);
    if (promptText) {
      tip.appendMarkdown('\n\n**');
      tip.appendText(vscode.l10n.t('Prompt'));
      tip.appendMarkdown('** ');
      tip.appendText(promptText);
    }
    const errorText = taskDetail(row).errorText;
    if (errorText) {
      tip.appendMarkdown('\n\n**');
      tip.appendText(vscode.l10n.t('Error'));
      tip.appendMarkdown('**\n\n');
      tip.appendText(errorText);
    }
    return tip;
  }
}
