import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readRegistry, readTaskEvents, TaskEvent, TASKS_LOG_FILE } from './registry';
import { readMeshWorkerRecords } from './mesh/pool';
import { MeshWorkerRecord } from './mesh/contract';

/**
 * How many finished mesh dispatches the history view keeps. Reads the SAME sanitized value
 * the reaper's cap-prune uses (readRegistry().meshHistoryLimit) — one source of truth, so the
 * view can never show a different count than the reaper retains on disk. The registry's
 * sanitizer applies the default, the floor of 1, and the ceiling.
 */
function meshHistoryLimit(): number {
  return readRegistry().meshHistoryLimit;
}

/**
 * A mesh dispatch is the only kind that records a worker NAME on its events. That
 * presence — not the workspace-global mesh toggle — is what marks an event as a mesh
 * dispatch, so the history stays scoped to attachable workers even when the toggle is off.
 */
function isMeshEvent(event: TaskEvent): boolean {
  return typeof event.meshWorker === 'string' && event.meshWorker !== '';
}

/**
 * The fullest prompt text available for a task: the complete dispatched prompt from the
 * event's `promptFile` when present and readable, else the ~300-char `promptPreview` the
 * event always carries. Best-effort — a missing or unreadable file falls back to preview.
 */
function fullPrompt(event: TaskEvent): string {
  const file = event.promptFile;
  if (typeof file === 'string' && file !== '') {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // fall through to the always-present inline preview
    }
  }
  return typeof event.promptPreview === 'string' ? event.promptPreview : '';
}

/**
 * "Worker history" tree: finished mesh (attachable `claude --bg`) dispatches for the
 * current workspace, newest first, capped at the meshHistoryLimit setting. Each row opens
 * the task's output file; its hover carries the full prompt, model, account, branch and
 * completion time. A worker that KEPT its worktree (uncommitted work the platform refused
 * to remove) is flagged so the unmerged branch is never silently lost.
 *
 * This provider is exported only — the extension host (a sibling slice) registers it under
 * the pinned view id `claudeCodeOrchestrator.workerHistory`.
 */
export class WorkerHistoryProvider
  implements vscode.TreeDataProvider<TaskEvent>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Kept so dispose() removes only this listener — other providers watch this path too. */
  private readonly onTasksChange = (): void => this._onDidChangeTreeData.fire();

  /**
   * Name → ledger record for the current workspace, rebuilt on each getChildren so
   * getTreeItem can read a worker's worktree/branch/kept verdict without re-reading the
   * ledger per row. The task event itself carries no worktree fields.
   */
  private recordsByName = new Map<string, MeshWorkerRecord>();

  /**
   * Worker names whose worktree still EXISTS on disk, rebuilt each getChildren. This is the
   * disk-truth the "unmerged branch" badge gates on — a removed worktree is never falsely
   * flagged (its stale worktreeKept flag is not trusted), matching the reaper's keptWorktree.
   */
  private liveWorktree = new Set<string>();

  constructor() {
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, this.onTasksChange);
  }

  dispose(): void {
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(event: TaskEvent): vscode.TreeItem {
    const item = new vscode.TreeItem(event.title);
    item.id = `history:${event.id}-${event.ts}`;
    item.contextValue = 'workerHistory';

    const rec = this.recordsByName.get(event.meshWorker ?? '');
    const parts = [event.worker, event.model];
    // A branch whose worktree still EXISTS on disk holds committed-but-unmerged work
    // (auto-committed at settle) — flag it loudly so it is not lost. A worktree that is GONE is
    // not flagged (the stale worktreeKept flag is not trusted), matching the reaper's disk-truth;
    // and the durable work is a commit on the branch regardless.
    if (rec?.branch) {
      parts.push(
        this.liveWorktree.has(event.meshWorker ?? '')
          ? `⚠ unmerged branch ${rec.branch}`
          : `branch ${rec.branch}`,
      );
    }
    item.description = parts.join(' · ');

    item.iconPath = new vscode.ThemeIcon(event.status === 'done' ? 'check' : 'error');
    item.command = {
      command: 'claudeCodeOrchestrator.showTaskOutput',
      title: vscode.l10n.t('Show Task Output'),
      arguments: [event.outputFile],
    };

    // Prompt is untrusted (account-derived): build the hover with appendText, which
    // escapes markdown metacharacters. Metadata values go through it too, out of caution.
    const tip = new vscode.MarkdownString();
    const promptText = fullPrompt(event);
    if (promptText) {
      tip.appendMarkdown('**Prompt** ');
      tip.appendText(promptText);
      tip.appendMarkdown('\n\n');
    }
    tip.appendText(`Model ${event.model} · Account ${event.worker}`);
    if (rec?.branch) {
      tip.appendMarkdown('\n\n');
      tip.appendText(
        `Branch ${rec.branch}${this.liveWorktree.has(event.meshWorker ?? '') ? ' (unmerged — worktree on disk)' : ''}`,
      );
    }
    tip.appendMarkdown('\n\n');
    tip.appendText(`Completed ${new Date(event.ts).toLocaleTimeString()}`);
    item.tooltip = tip;
    return item;
  }

  getChildren(element?: TaskEvent): TaskEvent[] {
    if (element) {
      return [];
    }
    // Latest event per task id wins (running → done/error), as the tasks provider does.
    const byId = new Map<string, TaskEvent>();
    for (const event of readTaskEvents()) {
      byId.set(event.id, event);
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.recordsByName = new Map();
    this.liveWorktree = new Set();
    if (root) {
      for (const rec of readMeshWorkerRecords(root)) {
        this.recordsByName.set(rec.name, rec);
        if (typeof rec.worktree === 'string' && rec.worktree !== '') {
          // Contain the path exactly like reaper.keptWorktree — an absolute / `..` / root-
          // resolving value is never a live worktree of THIS workspace (path.resolve, not join,
          // so an absolute second segment cannot escape the base silently).
          const resolved = path.resolve(root, rec.worktree);
          if (resolved !== root && resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
            this.liveWorktree.add(rec.name);
          }
        }
      }
    }

    const events = [...byId.values()].filter(
      (e) =>
        typeof e.cwd === 'string' &&
        typeof root === 'string' &&
        (e.cwd === root || e.cwd.startsWith(root + '/')) &&
        isMeshEvent(e) &&
        (e.status === 'done' || e.status === 'error'),
    );
    events.sort((a, b) => b.ts - a.ts);
    return events.slice(0, meshHistoryLimit());
  }
}
