import * as vscode from 'vscode';
import * as fs from 'fs';
import { WorkerManager } from './workerManager';
import {
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
  USAGE_CACHE_FILE,
} from './usage';

interface WorkerStatRow {
  kind: 'stat';
  worker: string;
  label: string;
  description: string;
  icon: string;
  tooltip?: string;
  command?: vscode.Command;
}

export type WorkerNode = WorkerProfile | WorkerStatRow;

function isStatRow(node: WorkerNode): node is WorkerStatRow {
  return (node as WorkerStatRow).kind === 'stat';
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

  constructor(private readonly workers: WorkerManager) {
    workers.onDidChange(() => this._onDidChangeTreeData.fire());
    // Usage/cooldown is written by the MCP server process — watch for changes.
    fs.watchFile(STATS_FILE, { interval: 2000 }, this.onStatsChange);
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, this.onTasksChange);
    // Live plan usage is written by a background refresher — watch its cache too.
    fs.watchFile(USAGE_CACHE_FILE, { interval: 2000 }, this.onUsageChange);
  }

  dispose(): void {
    fs.unwatchFile(STATS_FILE, this.onStatsChange);
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
    fs.unwatchFile(USAGE_CACHE_FILE, this.onUsageChange);
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
      return this.workers.list();
    }
    if (isStatRow(node)) {
      return [];
    }
    return this.statRows(node);
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
      label: 'Status',
      description: coolingDown
        ? `cooling down until ${new Date(stats!.cooldownUntil!).toLocaleTimeString()} (quota error)`
        : 'available',
      icon: coolingDown ? 'debug-pause' : 'check',
      tooltip: coolingDown
        ? 'Skipped by automatic assignment until the cooldown ends. Dispatches naming this worker explicitly still run.'
        : 'Eligible for automatic assignment.',
    });
    this.pushPlanQuotaRows(rows, worker);
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Dispatch · Session (5h)',
      description:
        session.tasks === 0
          ? 'no dispatches'
          : `${session.tasks} tasks · ${fmtTokens(session.inputTokens)} in / ${fmtTokens(session.outputTokens)} out`,
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
          ? 'no dispatches'
          : `${week.tasks} tasks · ${fmtTokens(week.inputTokens)} in / ${fmtTokens(week.outputTokens)} out`,
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
        label: 'Errors',
        description: `${stats.errors}${stats.lastError ? ` · last: ${stats.lastError.slice(0, 60)}` : ''}`,
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
      title: 'Show Task Output',
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
