import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { WorkerManager } from './workerManager';
import {
  appendOutputNote,
  appendTaskEvent,
  cancelRunningTask,
  latestEventById,
  readRegistry,
  readStats,
  readTaskEvents,
  STATS_FILE,
  TaskEvent,
  TASKS_LOG_FILE,
  windowUsage,
  WorkerProfile,
} from './registry';
import {
  AccountUsage,
  formatAge,
  formatRelativeReset,
  getCachedUsage,
  isElevated,
  isLoginExpired,
  listAccounts,
  USAGE_CACHE_FILE,
} from './usage';
import {
  MESH_STATE_DIR,
  MeshState,
  MeshWorkerRecord,
  meshStateFile,
  parseSessionEntry,
  SessionEntry,
  sessionsDir,
} from './mesh/contract';
import { removeWorkerJob } from './mesh/pool';
import { markWorkerStopped } from './mesh/reaper';

interface WorkerStatRow {
  kind: 'stat';
  worker: string;
  label: string;
  description: string;
  icon: string;
  tooltip?: string;
  command?: vscode.Command;
}

/** Collapsible parent of the attachable-worker rows (experimental Mesh Mode). */
interface MeshGroupRow {
  kind: 'meshGroup';
}

/** One mesh worker: the union of its state-file record and its live session entry. */
interface MeshWorkerRow {
  kind: 'meshWorker';
  name: string;
  account: string;
  configDir: string;
  jobId?: string;
  model?: string;
  role?: string;
  /** Dispatch task this worker was spawned for (role 'dispatch' records). */
  taskId?: string;
  /** Orchestrator-set idle-stop suppressor, as recorded in the ledger. */
  keepAlive?: boolean;
  /**
   * Workspace the owning state file belongs to. The keep-alive write addresses a
   * record through ITS workspace, which is not necessarily the editor's (the tree
   * reads every workspace's state file). Absent on live-only rows, which have no
   * ledger record to address.
   */
  cwd?: string;
  alive: boolean;
  /** Live status from the session registry, when the worker has a live entry. */
  status?: string;
}

export type WorkerNode = WorkerProfile | WorkerStatRow | MeshGroupRow | MeshWorkerRow;

function isStatRow(node: WorkerNode): node is WorkerStatRow {
  return (node as WorkerStatRow).kind === 'stat';
}

function isMeshGroup(node: WorkerNode): node is MeshGroupRow {
  return (node as MeshGroupRow).kind === 'meshGroup';
}

function isMeshWorker(node: WorkerNode): node is MeshWorkerRow {
  return (node as MeshWorkerRow).kind === 'meshWorker';
}

/** Mesh worker names are `cco-w-<hash>-<account>-<seq>` — the discovery filter for session entries. */
const MESH_WORKER_NAME_PREFIX = 'cco-w-';

function meshModeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('claudeCodeOrchestrator')
    .get<boolean>('meshMode', false);
}

/** kill(pid,0) liveness probe — matches the mesh contract's alive check. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A ledger record plus the workspace whose state file holds it. */
type LedgerRecord = MeshWorkerRecord & { stateCwd?: string };

/**
 * Every mesh worker record across all workspaces' state files in MESH_STATE_DIR.
 * The dir may be absent and any file may be corrupt (it is written by a separate
 * process); both are tolerated by returning what could be read. Each record carries
 * its state file's `cwd` so callers that must WRITE the ledger (the keep-alive mark)
 * address the owning workspace rather than assuming the editor's.
 */
function readAllMeshWorkerRecords(): LedgerRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(MESH_STATE_DIR);
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(MESH_STATE_DIR, file), 'utf8'),
      ) as Partial<MeshState>;
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

/** The ledger record for one worker name, or undefined when no state file holds it. */
function findMeshWorkerRecord(name: string): LedgerRecord | undefined {
  return readAllMeshWorkerRecords().find((rec) => rec.name === name);
}

/** How long `claude stop <jobId>` may run before the cancel gives up on it. */
const MESH_STOP_TIMEOUT_MS = 15_000;

/**
 * Run `claude stop <jobId>` for one attachable worker under its own account
 * (CLAUDE_CONFIG_DIR). Resolves to an error string when the stop could not be
 * performed, or undefined on success — it never throws, because the caller must
 * record the cancellation either way.
 */
function stopMeshWorkerJob(jobId: string, configDir: string | undefined): Promise<string | undefined> {
  // registry.claudePath is the RESOLVED absolute path (the extension host writes it
  // through resolveClaudePathPreserving on every settings sync); a bare "claude"
  // would often be ENOENT here, since the host may not carry the login-shell PATH.
  const claudePath = readRegistry().claudePath || 'claude';
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ['stop', jobId],
      {
        env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env,
        timeout: MESH_STOP_TIMEOUT_MS,
      },
      (err) => resolve(err ? (err.message || String(err)) : undefined),
    );
  });
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
 * actually stopped an attachable worker (contract §8.9 F3d).
 *
 * `claude stop` only kills the session. Without these writes the ledger record still
 * looks live, so the MCP server's idle sweep re-runs `claude stop` against a dead job
 * every 60 seconds forever, and the task's worktree lingers even when it is clean —
 * exactly the state the adversarial review found. `markWorkerStopped` converges the
 * sweep; `removeWorkerJob` is the same teardown finisher the server-side stop and the
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
  // stoppedAt FIRST: it is the write that stops the 60s retry loop, and the `claude
  // rm` below may burn its full timeout before it returns anything at all.
  if (record.stateCwd) {
    try {
      const marked = markWorkerStopped(record.stateCwd, record.name);
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
 * Cancel a dispatched task from the UI, mesh-aware. A `--bg` (attachable) task
 * carries `meshWorker` on its events and NEVER a pid (contract P4.10), so the
 * signal path in cancelRunningTask can only ever no-op on it: the worker is a
 * detached background session addressed by job id. This routes such a task to
 * `claude stop <jobId>` (looked up in the mesh ledger, run under the worker's own
 * account), finishes the ledger + worktree bookkeeping a server-side stop would have
 * done (finishCancelledMeshWorker), and then writes the same terminal event + output
 * note cancelRunningTask writes. Every other task takes the unchanged signal path.
 *
 * Returns false when the task is absent or no longer running — identical to
 * cancelRunningTask, so a second call is idempotent. It also returns TRUE without writing
 * an event when another surface authored this task's terminal event while the stop was in
 * flight (S2c, at the end of this function): the cancel still happened.
 */
export async function cancelTaskMeshAware(id: string, reason: string): Promise<boolean> {
  const latest = latestEventById(id);
  const workerName = typeof latest?.meshWorker === 'string' ? latest.meshWorker : undefined;
  if (!latest || latest.status !== 'running' || !workerName) {
    return cancelRunningTask(id, reason);
  }
  const record = findMeshWorkerRecord(workerName);
  let stopNote: string;
  if (!record || typeof record.jobId !== 'string' || record.jobId === '') {
    // The ledger no longer names this worker (stale row, or a state file removed
    // under us): the task row is still ours to close, the process is not ours to
    // address. The session-end and orphan reapers remain the backstop.
    stopNote = `\nCould not stop the attachable worker "${workerName}": no job id in the mesh ledger.\n`;
  } else {
    const error = await stopMeshWorkerJob(record.jobId, record.configDir);
    if (error) {
      // A failed stop leaves the session's fate unknown, so neither finisher runs:
      // stamping stoppedAt on a possibly-live worker would hide it from the idle
      // sweep and the orphan reaper — the two things that would still catch it.
      stopNote = `\nStopping the attachable worker "${workerName}" failed: ${error}\n`;
    } else {
      stopNote =
        `\nStopped the attachable worker "${workerName}" (claude stop ${record.jobId}).\n` +
        (await finishCancelledMeshWorker(record));
    }
  }
  // S2c — re-read the task's latest event IMMEDIATELY before appending ours. `latest` was
  // read at the top of this function, before the `claude stop` await, and that await takes
  // SECONDS: inside it the MCP server's timeout/death path can decide this worker is gone,
  // run its own parity guard (which sees a task still marked `running`, because we have not
  // appended yet) and author the terminal event itself. A second one from here is exactly
  // the parity break that guard exists to prevent — two terminal events for one task, and a
  // recordFailure charged to a healthy account for what is really a user cancel. The two
  // guards are mirror images: one closes each sequential ordering. What remains is a
  // genuinely simultaneous double-read, whose only consequence is a cosmetic second event
  // (every reader takes the latest event per id), never a wrong status and never a failure
  // record — the recordFailure lives on the server's side of the race and is guarded there.
  //
  // The ledger convergence above (markWorkerStopped) and the rm finisher deliberately run
  // BEFORE this check and regardless of who wins it: both are idempotent, and the stopped
  // mark is what stops the idle sweep re-running `claude stop` against a dead job forever.
  let current: TaskEvent | undefined;
  try {
    current = latestEventById(id);
  } catch {
    // An unreadable task log reads as "nobody else closed it" — the same side of the trade
    // the server's guard takes. Suppressing a REAL cancel record because a read blipped
    // would lose the only evidence the task ended at all.
    current = undefined;
  }
  if (current !== undefined && current.status !== 'running') {
    // Somebody else already closed this task. Skip the terminal event and the CANCELLED
    // header (both would claim a cancellation the recorded terminal event contradicts), but
    // return TRUE: the cancel happened — the worker was stopped and its ledger record
    // converged — and the task is closed either way. `false` means "there was nothing
    // running to cancel", which is a different thing to tell the user.
    //
    // The teardown line still goes out, without that header. It is the only place a KEPT
    // worktree — one holding uncommitted worker changes that nothing will ever remove for
    // the user — is reported, and losing it because the server won a race would mean
    // silently dropping the one fact the user must act on.
    appendOutputNote(latest.outputFile, `\n${stopNote}`);
    return true;
  }
  appendTaskEvent({ ...latest, ts: Date.now(), status: 'error', error: reason });
  appendOutputNote(
    latest.outputFile,
    `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n${stopNote}`,
  );
  return true;
}

/** Live mesh-worker session entries in one account's sessions/ dir (missing dir → none). */
function liveMeshEntries(configDir: string): SessionEntry[] {
  const dir = sessionsDir(configDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const entry = parseSessionEntry(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      if (entry && typeof entry.name === 'string' && entry.name.startsWith(MESH_WORKER_NAME_PREFIX)) {
        out.push(entry);
      }
    } catch {
      // unreadable/corrupt entry — skip
    }
  }
  return out;
}

/**
 * Dispatch task ids are `t<base36 time><4 random>` — long enough to crowd a tree
 * row out of its label. Keep the leading, time-ordered part: it is what a reader
 * matches against the Dispatched Tasks view, and the full id is in the tooltip.
 */
function shortTaskId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 9)}…`;
}

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

/** Compact per-window labels for the collapsed row's inline usage summary. */
const USAGE_SHORT_LABEL: Record<string, string> = {
  session: '5h',
  weekly_all: '7d',
  weekly_scoped: 'Fable',
};

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

const NO_LIMITS_MESSAGE = 'no plan limits (token/non-subscription login)';
const NO_WINDOWS_MESSAGE = 'no rate-limit windows reported';
/**
 * An expired/logged-out subscription reports the same "no limits" shape as a
 * genuine token account, so every `available !== true` branch must ask
 * `isLoginExpired` before falling through to NO_LIMITS_MESSAGE — otherwise the
 * row reads "no plan limits" for an account that in fact has a plan it can no
 * longer reach.
 */
const EXPIRED_SUMMARY = 'login expired — re-login needed';

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
 */
function safeWindows(usage: AccountUsage): SafeWindow[] {
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
    windows.push({
      kind: str(w.kind, ''),
      label: str(w.label, ''),
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
 * One-line live-usage tail for a worker's collapsed `description`, e.g.
 * `· 5h 12% · 7d 72% · ⚠Fable 100%`. Handles all six render states.
 */
function usageSummary(usage: AccountUsage | undefined): string {
  if (!usage) {
    return 'usage: — (refreshing)';
  }
  if (usage.error !== undefined) {
    return 'usage unavailable';
  }
  if (usage.available !== true) {
    return isLoginExpired(usage) ? EXPIRED_SUMMARY : NO_LIMITS_MESSAGE;
  }
  const windows = safeWindows(usage);
  if (windows.length === 0) {
    return isTempUnavailable(usage)
      ? `plan usage unavailable (last ${formatAge(usage.lastGoodWindowsAt)})`
      : NO_WINDOWS_MESSAGE;
  }
  return windows
    .map((w) => {
      const short = USAGE_SHORT_LABEL[w.kind] ?? w.label;
      return `${isElevated(w.severity) ? '⚠' : ''}${short} ${pct(w.percent)}`;
    })
    .join(' · ');
}

/**
 * Append a rich live-usage block to a worker's Markdown tooltip. Handles all six
 * render states. Account-derived strings go through `appendText`, which escapes
 * markdown metacharacters — a crafted plan name or stderr must not break formatting.
 */
function appendUsageTooltip(md: vscode.MarkdownString, usage: AccountUsage | undefined): void {
  md.appendMarkdown('\n\n');
  if (!usage) {
    md.appendMarkdown('Plan quota — usage: — (refreshing)');
    return;
  }
  if (usage.error !== undefined) {
    md.appendMarkdown('Plan quota — usage unavailable\n\n');
    md.appendText(str(usage.error, ''));
    return;
  }
  if (usage.available !== true) {
    // The actionable "run Re-login Account" sentence is added by the caller, so
    // this section only labels the quota state — it does not repeat the advice.
    md.appendMarkdown(`Plan quota — ${isLoginExpired(usage) ? 'login expired' : NO_LIMITS_MESSAGE}`);
    return;
  }
  const windows = safeWindows(usage);
  if (windows.length === 0) {
    if (isTempUnavailable(usage)) {
      md.appendMarkdown(
        `Plan quota — temporarily unavailable: upstream returned no data. Last good reading ${formatAge(
          usage.lastGoodWindowsAt,
        )}.`,
      );
    } else {
      md.appendMarkdown(`Plan quota — ${NO_WINDOWS_MESSAGE}`);
    }
    return;
  }
  md.appendMarkdown('**Plan quota — ');
  md.appendText(str(usage.subscriptionType, 'subscription'));
  md.appendMarkdown('**');
  for (const w of windows) {
    const elevated = isElevated(w.severity) ? ` ⚠${w.severity}` : '';
    md.appendMarkdown('\n\n');
    md.appendText(`${w.label}: ${pct(w.percent)}${elevated} — resets ${formatRelativeReset(w.resetsAt)}`);
  }
}

/**
 * Two-level tree: worker accounts expand into per-account usage rows —
 * availability, dispatch usage in Claude's quota windows (5h session / 7d),
 * lifetime totals, and a shortcut to check the account's real plan quota.
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
  private readonly onMeshChange = (): void => this._onDidChangeTreeData.fire();
  /** This workspace's mesh state file — watched so spawn/stop refreshes the tree. */
  private readonly meshStatePath: string | undefined;

  constructor(private readonly workers: WorkerManager) {
    workers.onDidChange(() => this._onDidChangeTreeData.fire());
    // Usage/cooldown is written by the MCP server process — watch for changes.
    fs.watchFile(STATS_FILE, { interval: 2000 }, this.onStatsChange);
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, this.onTasksChange);
    // Live plan usage is written by a background refresher — watch its cache too.
    fs.watchFile(USAGE_CACHE_FILE, { interval: 2000 }, this.onUsageChange);
    // The mesh state file is written by the MCP server as workers spawn/stop.
    // watchFile tolerates a not-yet-existing path and fires when it appears.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd) {
      this.meshStatePath = meshStateFile(cwd);
      fs.watchFile(this.meshStatePath, { interval: 2000 }, this.onMeshChange);
    }
  }

  dispose(): void {
    fs.unwatchFile(STATS_FILE, this.onStatsChange);
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
    fs.unwatchFile(USAGE_CACHE_FILE, this.onUsageChange);
    if (this.meshStatePath) {
      fs.unwatchFile(this.meshStatePath, this.onMeshChange);
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: WorkerNode): vscode.TreeItem {
    if (isStatRow(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = `${node.worker}:${node.label}`;
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      item.command = node.command;
      item.contextValue = 'workerStat';
      return item;
    }
    if (isMeshGroup(node)) {
      const item = new vscode.TreeItem(
        vscode.l10n.t('Attachable workers'),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = 'meshGroup';
      item.iconPath = new vscode.ThemeIcon('broadcast');
      item.contextValue = 'meshGroup';
      return item;
    }
    if (isMeshWorker(node)) {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.id = `mesh:${node.name}`;
      const statusText = node.alive
        ? node.status ?? vscode.l10n.t('alive')
        : vscode.l10n.t('stopped');
      // Under attachable dispatch every worker belongs to ONE dispatch task, so the
      // row leads with what it is working on (role + short task id) before its
      // liveness — the account and model are secondary.
      const work = node.role
        ? node.taskId
          ? `${node.role} ${shortTaskId(node.taskId)}`
          : node.role
        : undefined;
      item.description =
        [work, node.account, statusText].filter((part) => Boolean(part)).join(' · ') +
        (node.keepAlive === true ? ` · ${vscode.l10n.t('keep-alive')}` : '') +
        (node.model && node.model !== '-' ? ` · ${node.model}` : '');
      item.iconPath = new vscode.ThemeIcon(node.alive ? 'pulse' : 'circle-slash');
      item.contextValue = 'meshWorker';
      const lines: string[] = [];
      if (node.role) {
        lines.push(vscode.l10n.t('Role: {0}', node.role));
      }
      if (node.taskId) {
        lines.push(vscode.l10n.t('Dispatch task: {0}', node.taskId));
      }
      if (node.keepAlive === true) {
        lines.push(
          vscode.l10n.t('Keep-alive is set — idle auto-stop will not stop this worker.'),
        );
      }
      lines.push(
        vscode.l10n.t(
          'Attach in a terminal: {0}',
          `CLAUDE_CONFIG_DIR=${node.configDir} claude attach ${node.jobId ?? '—'}`,
        ),
      );
      item.tooltip = lines.join('\n');
      return item;
    }
    const stats = readStats()[node.name];
    const coolingDown = (stats?.cooldownUntil ?? 0) > Date.now();
    const item = new vscode.TreeItem(
      (node.preferred ? '★ ' : '') + node.name,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const usage = getCachedUsage(node.configDir);
    const expired = isLoginExpired(usage);
    // No separate expired badge here: usageSummary already reports the expired
    // login in place of its old "no plan limits" fall-through, and the two
    // together read as contradictory copy on one row.
    item.description =
      node.model +
      (node.preferred ? ' · preferred' : '') +
      (coolingDown ? ' · ⏸ cooldown' : '') +
      ` · ${usageSummary(usage)}` +
      (usage?.extraUsage?.enabled === true ? ' · ⚠overage' : '') +
      (usage?.windowsStale === true ? ` · ⏱ plan usage ${formatAge(usage.windowsFetchedAt)}` : '');
    const tooltip = new vscode.MarkdownString(
      `CLAUDE_CONFIG_DIR=${node.configDir}\n\n` +
        'Expand for per-account usage · terminal button opens a live session · right-click for re-login / remove',
    );
    if (expired) {
      tooltip.appendMarkdown(
        '\n\nLogin expired — run "Re-login Account" (right-click) to restore dispatches.',
      );
    }
    appendUsageTooltip(tooltip, usage);
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(coolingDown ? 'debug-pause' : 'server-process');
    item.contextValue = 'worker';
    item.id = node.name;
    return item;
  }

  getChildren(node?: WorkerNode): WorkerNode[] {
    if (!node) {
      const roots: WorkerNode[] = [...this.workers.list()];
      // The mesh group is present only in Mesh Mode; absent entirely otherwise.
      if (meshModeEnabled()) {
        roots.push({ kind: 'meshGroup' });
      }
      return roots;
    }
    if (isMeshGroup(node)) {
      return this.meshWorkerRows();
    }
    if (isStatRow(node) || isMeshWorker(node)) {
      return [];
    }
    return this.statRows(node);
  }

  /**
   * Rows under the mesh group: the union of state-file records and live session
   * entries across every known account. Records seed the list; a live session
   * entry (matched by name) wins for liveness/status and fills a missing job id.
   * Live-only workers (adopted, or from a since-crashed server) still appear,
   * attributed to the account whose sessions/ dir held them.
   */
  private meshWorkerRows(): MeshWorkerRow[] {
    const byName = new Map<string, MeshWorkerRow>();
    for (const rec of readAllMeshWorkerRecords()) {
      byName.set(rec.name, {
        kind: 'meshWorker',
        name: rec.name,
        account: rec.account,
        configDir: rec.configDir,
        jobId: rec.jobId,
        model: rec.model,
        role: rec.role,
        taskId: typeof rec.taskId === 'string' ? rec.taskId : undefined,
        keepAlive: rec.keepAlive === true,
        cwd: rec.stateCwd,
        alive: typeof rec.pid === 'number' ? isPidAlive(rec.pid) : false,
      });
    }

    // Accounts to scan: every account the view already knows (main + workers),
    // plus ~/.claude in case the main account's CLAUDE_CONFIG_DIR points elsewhere.
    const dirToAccount = new Map<string, string>();
    for (const account of listAccounts()) {
      if (!dirToAccount.has(account.configDir)) {
        dirToAccount.set(account.configDir, account.name);
      }
    }
    const homeClaude = path.join(os.homedir(), '.claude');
    if (!dirToAccount.has(homeClaude)) {
      dirToAccount.set(homeClaude, 'main');
    }

    for (const [configDir, account] of dirToAccount) {
      for (const entry of liveMeshEntries(configDir)) {
        const name = entry.name;
        if (!name) {
          continue;
        }
        const alive = typeof entry.pid === 'number' && isPidAlive(entry.pid);
        const existing = byName.get(name);
        if (existing) {
          existing.alive = alive; // the live entry is authoritative for status
          if (typeof entry.status === 'string') {
            existing.status = entry.status;
          }
          if (!existing.jobId && typeof entry.jobId === 'string') {
            existing.jobId = entry.jobId;
          }
        } else {
          byName.set(name, {
            kind: 'meshWorker',
            name,
            account,
            configDir,
            jobId: typeof entry.jobId === 'string' ? entry.jobId : undefined,
            alive,
            status: typeof entry.status === 'string' ? entry.status : undefined,
          });
        }
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private statRows(worker: WorkerProfile): WorkerStatRow[] {
    const stats = readStats()[worker.name];
    const now = Date.now();
    const coolingDown = (stats?.cooldownUntil ?? 0) > now;
    const session = windowUsage(worker.name, 5 * 60 * 60 * 1000);
    const week = windowUsage(worker.name, 7 * 24 * 60 * 60 * 1000);
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
    this.pushPlanQuotaRows(rows, worker);
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Dispatch · Session (5h)',
      description:
        session.tasks === 0
          ? vscode.l10n.t('no dispatches')
          : vscode.l10n.t(
              '{0} tasks · {1} in / {2} out',
              session.tasks,
              fmtTokens(session.inputTokens),
              fmtTokens(session.outputTokens),
            ),
      icon: 'history',
      tooltip:
        'Dispatches sent by this extension in the last 5 hours. Counts only this extension\'s ' +
        'traffic, not the account\'s overall consumption.',
    });
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Dispatch · Weekly (7d)',
      description:
        week.tasks === 0
          ? vscode.l10n.t('no dispatches')
          : vscode.l10n.t(
              '{0} tasks · {1} in / {2} out',
              week.tasks,
              fmtTokens(week.inputTokens),
              fmtTokens(week.outputTokens),
            ),
      icon: 'calendar',
      tooltip:
        'Dispatches sent by this extension in the last 7 days. Counts only this extension\'s ' +
        'traffic, not the account\'s overall consumption.',
    });
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Dispatch · All time',
      description: stats
        ? `${stats.tasks} tasks · ${fmtTokens(stats.inputTokens)} in / ${fmtTokens(stats.outputTokens)} out` +
          (stats.costUsd ? ` · ~$${stats.costUsd.toFixed(2)}` : '')
        : 'no dispatches yet',
      icon: 'graph',
      tooltip:
        'Every dispatch this extension has ever sent to this worker. Counts only this ' +
        'extension\'s traffic, not the account\'s overall consumption.',
    });
    if (stats && stats.errors > 0) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: vscode.l10n.t('Errors'),
        description: stats.lastError
          ? vscode.l10n.t('{0} · last: {1}', stats.errors, stats.lastError.slice(0, 60))
          : String(stats.errors),
        icon: 'warning',
        tooltip: stats.lastError,
      });
    }
    return rows;
  }

  /**
   * Live plan-quota rows from the cached `get_usage` reading (never spawns).
   * Renders one row per rate-limit window when available, or a single row for
   * the refreshing / unavailable / no-limits / no-windows states.
   */
  private pushPlanQuotaRows(rows: WorkerStatRow[], worker: WorkerProfile): void {
    const usage = getCachedUsage(worker.configDir);

    if (!usage) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan quota',
        description: 'usage: — (refreshing)',
        icon: 'sync',
        tooltip: 'No cached reading yet — the background refresher will populate this shortly.',
      });
      return;
    }
    if (usage.error !== undefined) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan quota',
        description: 'usage unavailable',
        icon: 'warning',
        tooltip: usage.error,
      });
      return;
    }
    if (usage.available !== true) {
      if (isLoginExpired(usage)) {
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: 'Plan quota',
          description: 'login expired',
          icon: 'warning',
          tooltip:
            'This account\'s subscription login expired or was logged out. Plan usage is ' +
            'unavailable and dispatches to it fail until you run "Re-login Account" ' +
            '(right-click the worker).',
        });
        return;
      }
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan quota',
        description: NO_LIMITS_MESSAGE,
        icon: 'circle-slash',
        tooltip:
          'This account exposes no claude.ai plan rate limits — typically a setup-token or ' +
          'non-subscription login. This is a valid state, not an error.',
      });
      return;
    }
    const windows = safeWindows(usage);
    if (windows.length === 0) {
      if (isTempUnavailable(usage)) {
        rows.push({
          kind: 'stat',
          worker: worker.name,
          label: 'Plan quota',
          description: `temporarily unavailable — last good reading ${formatAge(usage.lastGoodWindowsAt)}`,
          icon: 'warning',
          tooltip:
            'get_usage is intermittently returning no rate-limit data for this account — a known ' +
            `upstream flakiness. The last good reading was ${formatAge(usage.lastGoodWindowsAt)}. This is ` +
            "unrelated to the account having no plan (that state reads 'no plan limits'); the numbers " +
            'return on their own once upstream reports windows again.',
        });
        return;
      }
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan quota',
        description: NO_WINDOWS_MESSAGE,
        icon: 'info',
        tooltip:
          'The account has a subscription but reported no rate-limit windows in the last ' +
          'reading. This is a valid state, not an error.',
      });
      return;
    }
    if (usage.windowsStale === true) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan · (stale)',
        description: `showing last reading from ${formatAge(usage.windowsFetchedAt)} — upstream returned no data`,
        icon: 'clock',
        tooltip:
          'The numbers below are the last good reading, not current. They are kept for up to 30 ' +
          'minutes while get_usage returns no rate-limit data, then cleared.',
      });
    }
    for (const w of windows) {
      const elevated = isElevated(w.severity);
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: `Plan · ${w.label}`,
        description: `${pct(w.percent)} · resets ${formatRelativeReset(w.resetsAt)}`,
        icon: elevated ? 'warning' : 'pulse',
        tooltip:
          `Real plan usage${usage.subscriptionType ? ` (${usage.subscriptionType})` : ''} — ` +
          `${w.label}: ${pct(w.percent)}${elevated ? ` ⚠${w.severity}` : ''} — ` +
          `resets ${formatRelativeReset(w.resetsAt)}`,
      });
    }
    const extra = safeExtraUsage(usage);
    if (extra !== null) {
      rows.push({
        kind: 'stat',
        worker: worker.name,
        label: 'Plan · Extra usage',
        description: extra.enabled
          ? 'ON' +
            (extra.spendLabel !== null ? ` · ${extra.spendLabel}` : '') +
            (extra.percent !== null ? ` · ${extra.percent}% of cap` : '')
          : 'off · plan limits block instead of billing',
        icon: extra.enabled ? 'warning' : 'shield',
        tooltip: extra.enabled
          ? 'Overage billing is ON: dispatching past a plan window bills money against this ' +
            "account's monthly cap instead of being blocked."
          : 'Overage billing is off: exhausting a plan window blocks work until it resets — ' +
            'no money is spent. Turn it on to bill past the limit against a monthly cap.',
      });
    }
  }
}

/**
 * Tails the shared tasks.jsonl, which the MCP dispatch server appends to as
 * the main session fans tasks out. Scoped to the current workspace by
 * default (dispatches record their cwd); toggleable to show all workspaces.
 */
export class TasksProvider implements vscode.TreeDataProvider<TaskEvent>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** true → only tasks dispatched from the current workspace. */
  scopeToWorkspace = true;

  /** Kept so dispose() removes only this listener — WorkersProvider watches this path too. */
  private readonly onTasksChange = (): void => this._onDidChangeTreeData.fire();

  constructor() {
    fs.watchFile(TASKS_LOG_FILE, { interval: 1500 }, this.onTasksChange);
  }

  dispose(): void {
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(event: TaskEvent): vscode.TreeItem {
    const item = new vscode.TreeItem(event.title);
    item.id = `${event.id}-${event.ts}`;
    // package.json shows the inline Cancel button only on `runningTask`.
    item.contextValue = event.status === 'running' ? 'runningTask' : 'task';

    // Cancelled and orphaned tasks are recorded as `error`, distinguished from a
    // genuine failure by the leading word of the (trimmed, case-insensitive) error
    // text. A missing/blank error is a plain error, never cancelled.
    const errText = (event.error ?? '').trim().toLowerCase();
    const errKind =
      event.status !== 'error'
        ? undefined
        : errText.startsWith('cancelled')
        ? 'cancelled'
        : errText.startsWith('orphaned')
        ? 'orphaned'
        : 'error';

    item.description = `${event.worker} · ${event.model} · ${errKind ?? event.status}`;
    // Prompt and error text are untrusted (account-derived): build the tooltip
    // with appendText, which escapes markdown metacharacters. Undefined when
    // there is nothing to show, as before.
    const preview = typeof event.promptPreview === 'string' ? event.promptPreview : '';
    if (preview || event.error) {
      const tip = new vscode.MarkdownString();
      if (preview) {
        tip.appendMarkdown('**Prompt** ');
        tip.appendText(preview);
      }
      if (event.error) {
        if (preview) {
          tip.appendMarkdown('\n\n');
        }
        tip.appendMarkdown('**Error**\n\n');
        tip.appendText(event.error);
      }
      item.tooltip = tip;
    } else {
      item.tooltip = undefined;
    }
    item.iconPath = new vscode.ThemeIcon(
      event.status === 'running'
        ? 'sync~spin'
        : event.status === 'done'
        ? 'check'
        : errKind === 'cancelled'
        ? 'circle-slash'
        : errKind === 'orphaned'
        ? 'debug-disconnect'
        : 'error',
    );
    item.command = {
      command: 'claudeCodeOrchestrator.showTaskOutput',
      title: vscode.l10n.t('Show Task Output'),
      arguments: [event.outputFile],
    };
    return item;
  }

  getChildren(element?: TaskEvent): TaskEvent[] {
    if (element) {
      return [];
    }
    // Latest event per task id wins (running → done/error).
    const byId = new Map<string, TaskEvent>();
    for (const event of readTaskEvents()) {
      byId.set(event.id, event);
    }
    let events = [...byId.values()];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (this.scopeToWorkspace && root) {
      events = events.filter((e) => e.cwd && (e.cwd === root || e.cwd.startsWith(root + '/')));
    }
    return events.sort((a, b) => b.ts - a.ts);
  }
}
