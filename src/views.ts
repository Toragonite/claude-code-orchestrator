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

/**
 * Two-level tree: worker accounts expand into per-account usage rows —
 * availability, dispatch usage in Claude's quota windows (5h session / 7d),
 * lifetime totals, and a shortcut to check the account's real plan quota.
 */
export class WorkersProvider implements vscode.TreeDataProvider<WorkerNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly workers: WorkerManager) {
    workers.onDidChange(() => this._onDidChangeTreeData.fire());
    // Usage/cooldown is written by the MCP server process — watch for changes.
    fs.watchFile(STATS_FILE, { interval: 2000 }, () => this._onDidChangeTreeData.fire());
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, () => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    fs.unwatchFile(STATS_FILE);
    fs.unwatchFile(TASKS_LOG_FILE);
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
    item.description =
      node.model + (node.preferred ? ' · preferred' : '') + (coolingDown ? ' · ⏸ cooldown' : '');
    item.tooltip =
      `CLAUDE_CONFIG_DIR=${node.configDir}\n` +
      'Expand for per-account usage · terminal button opens a live session · right-click for re-login / remove';
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
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Session (5h)',
      description:
        session.tasks === 0
          ? 'no dispatches'
          : `${session.tasks} tasks · ${fmtTokens(session.inputTokens)} in / ${fmtTokens(session.outputTokens)} out`,
      icon: 'history',
      tooltip: 'Dispatch usage in the last 5 hours — the window of Claude plans\' session limit.',
    });
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Weekly (7d)',
      description:
        week.tasks === 0
          ? 'no dispatches'
          : `${week.tasks} tasks · ${fmtTokens(week.inputTokens)} in / ${fmtTokens(week.outputTokens)} out`,
      icon: 'calendar',
      tooltip: 'Dispatch usage in the last 7 days — the window of Claude plans\' weekly limit.',
    });
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'All time',
      description: stats
        ? `${stats.tasks} tasks · ${fmtTokens(stats.inputTokens)} in / ${fmtTokens(stats.outputTokens)} out` +
          (stats.costUsd ? ` · ~$${stats.costUsd.toFixed(2)}` : '')
        : 'no dispatches yet',
      icon: 'graph',
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
    rows.push({
      kind: 'stat',
      worker: worker.name,
      label: 'Plan quota',
      description: 'open terminal → type /usage',
      icon: 'link-external',
      tooltip:
        "The numbers above only count this extension's dispatches. The account's real plan quota " +
        '(session %, weekly %) is only visible inside Claude Code — this opens a terminal on this ' +
        'account; type /usage there.',
      command: {
        command: 'claudeCodeOrchestrator.loginWorker',
        title: 'Check plan quota',
        arguments: [{ id: worker.name }],
      },
    });
    return rows;
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

  constructor() {
    fs.watchFile(TASKS_LOG_FILE, { interval: 1500 }, () => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    fs.unwatchFile(TASKS_LOG_FILE);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(event: TaskEvent): vscode.TreeItem {
    const item = new vscode.TreeItem(event.title);
    item.id = `${event.id}-${event.ts}`;
    item.description = `${event.worker} · ${event.model} · ${event.status}`;
    item.tooltip = event.error ?? undefined;
    item.iconPath = new vscode.ThemeIcon(
      event.status === 'running' ? 'sync~spin' : event.status === 'done' ? 'check' : 'error',
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
