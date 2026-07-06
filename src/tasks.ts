import * as vscode from 'vscode';

export type TaskStatus = 'running' | 'done' | 'error';
export type TaskKind = 'orchestration' | 'dispatch';

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  title: string;
  accountName: string;
  model: string;
  status: TaskStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private counter = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  create(kind: TaskKind, title: string, accountName: string, model: string): TaskRecord {
    const task: TaskRecord = {
      id: `task-${++this.counter}`,
      kind,
      title,
      accountName,
      model,
      status: 'running',
      output: '',
      startedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this._onDidChange.fire();
    return task;
  }

  append(id: string, text: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.output += text;
    }
  }

  finish(id: string, status: 'done' | 'error', error?: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = status;
      task.error = error;
      task.endedAt = Date.now();
      this._onDidChange.fire();
    }
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
      }
    }
    this._onDidChange.fire();
  }
}
