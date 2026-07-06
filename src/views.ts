import * as vscode from 'vscode';
import * as fs from 'fs';
import { WorkerManager } from './workerManager';
import { TaskEvent, TASKS_LOG_FILE, readTaskEvents, WorkerProfile } from './registry';

export class WorkersProvider implements vscode.TreeDataProvider<WorkerProfile> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly workers: WorkerManager) {
    workers.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(worker: WorkerProfile): vscode.TreeItem {
    const item = new vscode.TreeItem(worker.name);
    item.description = worker.model;
    item.tooltip = `CLAUDE_CONFIG_DIR=${worker.configDir}`;
    item.iconPath = new vscode.ThemeIcon('server-process');
    item.contextValue = 'worker';
    item.id = worker.name;
    return item;
  }

  getChildren(element?: WorkerProfile): WorkerProfile[] {
    return element ? [] : this.workers.list();
  }
}

/**
 * Tails ~/.fable-orchestrator/tasks.jsonl, which the MCP dispatch server
 * appends to as the main session fans tasks out.
 */
export class TasksProvider implements vscode.TreeDataProvider<TaskEvent>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

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
      command: 'fableOrchestrator.showTaskOutput',
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
    return [...byId.values()].sort((a, b) => b.ts - a.ts);
  }
}
