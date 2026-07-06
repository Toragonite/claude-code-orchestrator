import * as vscode from 'vscode';
import { Account, AccountManager } from './accounts';
import { TaskRecord, TaskRegistry } from './tasks';
import { config, FABLE_MODEL } from './models';

export class AccountsProvider implements vscode.TreeDataProvider<Account> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly accounts: AccountManager) {
    accounts.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(account: Account): vscode.TreeItem {
    const item = new vscode.TreeItem(account.name);
    const authLabel = account.auth === 'oauth' ? 'oauth' : 'api key';
    if (account.role === 'main') {
      item.description = `main · ${config().mainModel || FABLE_MODEL} · ${authLabel}`;
      item.iconPath = new vscode.ThemeIcon('star-full');
    } else {
      item.description = `worker · ${account.model ?? config().defaultWorkerModel} · ${authLabel}`;
      item.iconPath = new vscode.ThemeIcon('server-process');
    }
    item.contextValue = `account-${account.role}`;
    item.id = account.id;
    return item;
  }

  getChildren(element?: Account): Account[] {
    if (element) {
      return [];
    }
    return this.accounts.list();
  }
}

export class TasksProvider implements vscode.TreeDataProvider<TaskRecord> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly tasks: TaskRegistry) {
    tasks.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(task: TaskRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title);
    item.id = task.id;
    item.description = `${task.accountName} · ${task.model} · ${task.status}`;
    item.tooltip = task.error ?? undefined;
    item.iconPath = new vscode.ThemeIcon(
      task.status === 'running' ? 'sync~spin' : task.status === 'done' ? 'check' : 'error',
    );
    item.command = {
      command: 'fableOrchestrator.showTaskOutput',
      title: 'Show Task Output',
      arguments: [task.id],
    };
    return item;
  }

  getChildren(element?: TaskRecord): TaskRecord[] {
    if (element) {
      return [];
    }
    return this.tasks.list();
  }
}

/** Read-only virtual documents for task output (fable-task:/<taskId>). */
export class TaskDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'fable-task';
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly tasks: TaskRegistry) {}

  refresh(taskId: string): void {
    this._onDidChange.fire(vscode.Uri.parse(`${TaskDocumentProvider.scheme}:/${taskId}`));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const taskId = uri.path.replace(/^\//, '');
    const task = this.tasks.get(taskId);
    if (!task) {
      return `Task ${taskId} not found (it may have been cleared).`;
    }
    const header = [
      `# ${task.title}`,
      `- account: ${task.accountName}`,
      `- model: ${task.model}`,
      `- status: ${task.status}${task.error ? ` (${task.error})` : ''}`,
      '',
      '---',
      '',
    ].join('\n');
    return header + task.output;
  }
}
