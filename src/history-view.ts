import * as vscode from 'vscode';
import * as fs from 'fs';
import { TASKS_LOG_FILE } from './registry';
import { LedgerReadNote, readMeshWorkerRecords } from './mesh/pool';
import { meshStateFile, MeshWorkerRecord } from './mesh/contract';
import { listTasks, rebuildTaskIndex, type TaskRow } from './uiModel';
import {
  BRANCH_LABEL_MAX,
  isTaskNode,
  ledgerRecordForTask,
  registryForDrawing,
  rowText,
  StatKeyed,
  taskLogProblemItem,
  TaskLogProblemRow,
  taskModelLine,
  taskModelSourceLine,
  taskPromptText,
  worktreeOnDisk,
} from './views';

/**
 * How many finished mesh dispatches the history view keeps. The SAME sanitized value the
 * reaper's cap-prune uses (the registry's `meshHistoryLimit`) — one source of truth, so the
 * view can never show a different count than the reaper retains on disk. The registry's
 * sanitizer applies the default, the floor of 1, and the ceiling. Taken from the reading of
 * the registry the tree views share, which is re-taken only when the file changed.
 */
function meshHistoryLimit(): number {
  return registryForDrawing().registry.meshHistoryLimit;
}

/**
 * The ledger records of one workspace, read again only when the ledger file's stat changes
 * (views.StatKeyed): the tree is redrawn on every change of the task log, and the ledger is
 * usually not what changed. A ledger that could not be READ yields no records and is not
 * kept — it is asked again at the next redraw.
 */
function ledgerReader(root: string): StatKeyed<MeshWorkerRecord[]> {
  let unreadable = false;
  return new StatKeyed<MeshWorkerRecord[]>(
    meshStateFile(root),
    () => {
      const note: LedgerReadNote = {};
      const records = readMeshWorkerRecords(root, note);
      unreadable = note.unreadable !== undefined;
      return records;
    },
    () => !unreadable,
  );
}

/** A row of the Worker History tree: a finished session-worker task, or the row about the log. */
export type HistoryNode = TaskRow | TaskLogProblemRow;

/**
 * "Worker history" tree: finished mesh (attachable `claude --bg`) dispatches for the
 * current workspace, newest first, capped at the meshHistoryLimit setting. Each row opens
 * the task's output file; its hover carries the full prompt, model, account, branch and
 * completion time. A worker that KEPT its worktree (uncommitted work the platform refused
 * to remove) is flagged so the unmerged branch is never silently lost.
 *
 * The rows come from the shared task index (uiModel.listTasks) — a task a session worker ran
 * is the only kind that records a worker NAME on its events, and that presence, not the
 * workspace-global mesh toggle, is what puts it here. Nothing in this file reads the task
 * log, and a row is drawn without opening any file: the prompt is read when the row is
 * HOVERED (resolveTreeItem).
 *
 * This provider is exported only — extension.ts registers it under the pinned view id
 * `claudeCodeOrchestrator.workerHistory`.
 */
export class WorkerHistoryProvider
  implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Kept so dispose() removes only this listener — other providers watch this path too. */
  private readonly onTasksChange = (): void => this._onDidChangeTreeData.fire();

  /**
   * The ledger records of the current workspace, taken on each getChildren (and read from
   * disk only when the ledger changed) so getTreeItem can find a task's worktree and branch
   * without asking per row (the task event itself carries no worktree fields).
   *
   * A row is joined to its record by TASK ID (views.ledgerRecordForTask), never by the
   * worker's name: names are handed out again by every new server while the records of
   * earlier workers stay in the ledger, so a name-keyed map — which this used to be — gave an
   * older row the branch, and the "unmerged" mark, of whichever task last ran under that name.
   */
  private records: MeshWorkerRecord[] = [];

  /**
   * The records (of `records`) whose worktree still EXISTS on disk, rebuilt each getChildren.
   * This is the disk-truth the "unmerged branch" badge gates on — a removed worktree is never
   * falsely flagged (its stale worktreeKept flag is not trusted), matching the reaper's
   * keptWorktree. A set of the record OBJECTS: no key of a record — least of all its name —
   * has to be trusted to be unique.
   */
  private liveWorktree = new Set<MeshWorkerRecord>();

  /** The reader of the current workspace's ledger (ledgerReader), remade when the folder changes. */
  private ledger: { root: string; reader: StatKeyed<MeshWorkerRecord[]> } | undefined;

  constructor() {
    fs.watchFile(TASKS_LOG_FILE, { interval: 2000 }, this.onTasksChange);
  }

  dispose(): void {
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
  }

  /**
   * Redraw because the USER asked — a command they ran. The task index is read again from
   * the first byte of the log first (uiModel.rebuildTaskIndex); the watcher redraws without.
   */
  refresh(): void {
    rebuildTaskIndex();
    this._onDidChangeTreeData.fire();
  }

  /** Redraw from what the index holds: for a change this extension just made itself. */
  redraw(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * The branch of the worker that ran this task, display-safe, and whether its worktree is
   * still on disk. The record of THIS task: one that names no task, or another one, says
   * nothing about this row — whatever its worker was called.
   */
  private branchOf(row: TaskRow): { branch: string | undefined; unmerged: boolean } {
    const rec = ledgerRecordForTask(this.records, row.id, row.sessionWorker ?? undefined);
    return {
      // The branch comes from the mesh ledger, a file other processes write, and goes on the
      // row under the same rule as every other stored value.
      branch:
        typeof rec?.branch === 'string' && rec.branch !== ''
          ? rowText(rec.branch, BRANCH_LABEL_MAX)
          : undefined,
      unmerged: rec !== undefined && this.liveWorktree.has(rec),
    };
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (!isTaskNode(node)) {
      return taskLogProblemItem(node.problem);
    }
    // Title, account and model are stored as a caller supplied them, in a log any dispatched
    // worker can append to; the index holds them flattened and capped, as the Tasks tree
    // shows them.
    const item = new vscode.TreeItem(node.title);
    item.id = `history:${node.id}-${node.lastTs ?? 0}`;
    item.contextValue = 'workerHistory';

    const { branch, unmerged } = this.branchOf(node);
    const parts = [node.worker, node.model];
    // A branch whose worktree still EXISTS on disk holds committed-but-unmerged work
    // (auto-committed at settle) — flag it loudly so it is not lost. A worktree that is GONE is
    // not flagged (the stale worktreeKept flag is not trusted), matching the reaper's disk-truth;
    // and the durable work is a commit on the branch regardless.
    if (branch !== undefined) {
      parts.push(
        unmerged
          ? vscode.l10n.t('⚠ unmerged branch {0}', branch)
          : vscode.l10n.t('branch {0}', branch),
      );
    }
    item.description = parts.join(' · ');

    item.iconPath = new vscode.ThemeIcon(node.status === 'done' ? 'check' : 'error');
    // The argument is the task's ID: the command opens the report that id names, never a path
    // taken from the log.
    item.command = {
      command: 'claudeCodeOrchestrator.showTaskOutput',
      title: vscode.l10n.t('Show Task Output'),
      arguments: [node.id],
    };
    // No tooltip here: left undefined, the editor asks resolveTreeItem for it on hover.
    return item;
  }

  /**
   * The hover of one row. Prompt is untrusted (account-derived): the hover is built with
   * appendText, which escapes markdown metacharacters, and metadata values go through it too,
   * out of caution. The text comes from views.taskPromptText — the prompt file found by the
   * task's ID, read bounded and non-blocking — and this is the only place a row reads a file.
   *
   * Each line is a whole sentence in the reader's language with the values set into it.
   */
  resolveTreeItem(item: vscode.TreeItem, node: HistoryNode): vscode.TreeItem {
    if (!isTaskNode(node)) {
      return item;
    }
    const { branch, unmerged } = this.branchOf(node);
    const tip = new vscode.MarkdownString();
    const promptText = taskPromptText(node);
    if (promptText) {
      tip.appendMarkdown('**');
      tip.appendText(vscode.l10n.t('Prompt'));
      tip.appendMarkdown('** ');
      tip.appendText(promptText);
      tip.appendMarkdown('\n\n');
    }
    tip.appendText(taskModelLine(node));
    const modelSource = taskModelSourceLine(node);
    if (modelSource !== undefined) {
      tip.appendMarkdown('\n\n');
      tip.appendText(modelSource);
    }
    if (branch !== undefined) {
      tip.appendMarkdown('\n\n');
      tip.appendText(
        unmerged
          ? vscode.l10n.t('Branch {0} (unmerged — worktree on disk)', branch)
          : vscode.l10n.t('Branch {0}', branch),
      );
    }
    tip.appendMarkdown('\n\n');
    // A time the index did not take as one (uiModel.recordedTime) is said to be unknown.
    tip.appendText(
      node.lastTs === null
        ? vscode.l10n.t('Completed at an unknown time — the task log records a time in the future')
        : vscode.l10n.t('Completed {0}', new Date(node.lastTs).toLocaleTimeString()),
    );
    item.tooltip = tip;
    return item;
  }

  getChildren(element?: HistoryNode): HistoryNode[] {
    if (element) {
      return [];
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!root) {
      this.ledger = undefined;
    } else if (this.ledger?.root !== root) {
      this.ledger = { root, reader: ledgerReader(root) };
    }
    this.records = this.ledger?.reader.get() ?? [];
    this.liveWorktree = new Set();
    for (const rec of this.records) {
      // views.worktreeOnDisk contains the recorded path exactly as reaper.keptWorktree does.
      if (worktreeOnDisk(root, rec)) {
        this.liveWorktree.add(rec);
      }
    }

    // The history is of THIS workspace: with no folder open there is nothing it is the
    // history of, so the query is made only with a root. The index still says when the log
    // itself could not be read, which is not the same as an empty history.
    const list = listTasks({
      root: typeof root === 'string' && root !== '' ? root : '',
      only: 'finished-session',
      limit: meshHistoryLimit(),
    });
    const nodes: HistoryNode[] = [];
    if (list.problem !== null) {
      nodes.push({ kind: 'taskLogProblem', problem: list.problem });
    }
    nodes.push(...list.rows);
    return nodes;
  }
}
