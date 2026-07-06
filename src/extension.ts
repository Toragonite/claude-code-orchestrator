import * as vscode from 'vscode';
import { AccountManager } from './accounts';
import { TaskRegistry } from './tasks';
import { WorkerPool } from './workers';
import { runOrchestratedTask } from './orchestrator';
import { AccountsProvider, TasksProvider, TaskDocumentProvider } from './views';
import { config, WORKER_MODELS, WorkerModel } from './models';

export function activate(context: vscode.ExtensionContext): void {
  const accounts = new AccountManager(context);
  const tasks = new TaskRegistry();
  const pool = new WorkerPool(accounts);
  const output = vscode.window.createOutputChannel('Fable Orchestrator');

  const accountsProvider = new AccountsProvider(accounts);
  const tasksProvider = new TasksProvider(tasks);
  const taskDocs = new TaskDocumentProvider(tasks);

  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider('fableOrchestrator.accounts', accountsProvider),
    vscode.window.registerTreeDataProvider('fableOrchestrator.tasks', tasksProvider),
    vscode.workspace.registerTextDocumentContentProvider(TaskDocumentProvider.scheme, taskDocs),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fableOrchestrator.addAccount', async () => {
      const role = await vscode.window.showQuickPick(
        [
          {
            label: 'Main (Fable orchestrator)',
            description: 'Plans work and dispatches tasks — runs claude-fable-5',
            value: 'main' as const,
          },
          {
            label: 'Worker (Opus/Sonnet)',
            description: 'Executes dispatched tasks',
            value: 'worker' as const,
          },
        ],
        { placeHolder: 'Account role' },
      );
      if (!role) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Account name (e.g. "main", "worker-1")',
        validateInput: (v) => (v.trim() ? undefined : 'Name is required'),
      });
      if (!name) {
        return;
      }
      let model: WorkerModel | undefined;
      if (role.value === 'worker') {
        const picked = await vscode.window.showQuickPick(
          WORKER_MODELS.map((m) => ({ label: m })),
          { placeHolder: 'Default model for this worker' },
        );
        if (!picked) {
          return;
        }
        model = picked.label as WorkerModel;
      }
      const apiKey = await vscode.window.showInputBox({
        prompt: `Anthropic API key for "${name.trim()}" (stored in VS Code Secret Storage)`,
        password: true,
        validateInput: (v) => (v.trim() ? undefined : 'API key is required'),
      });
      if (!apiKey) {
        return;
      }
      try {
        await accounts.add(name.trim(), role.value, apiKey.trim(), model);
        vscode.window.showInformationMessage(`Account "${name.trim()}" added.`);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.removeAccount', async (item?: { id?: string }) => {
      let id = item?.id;
      if (!id) {
        const picked = await vscode.window.showQuickPick(
          accounts.list().map((a) => ({ label: a.name, description: a.role, id: a.id })),
          { placeHolder: 'Account to remove' },
        );
        id = picked?.id;
      }
      if (!id) {
        return;
      }
      const account = accounts.get(id);
      const confirmed = await vscode.window.showWarningMessage(
        `Remove account "${account?.name ?? id}" and its stored API key?`,
        { modal: true },
        'Remove',
      );
      if (confirmed === 'Remove') {
        await accounts.remove(id);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.runTask', async () => {
      if (!accounts.main()) {
        vscode.window.showErrorMessage('Add a main (Fable) account first: "Fable Orchestrator: Add Account".');
        return;
      }
      const request = await vscode.window.showInputBox({
        prompt: 'Task for the Fable orchestrator (it will plan and dispatch to workers as needed)',
        ignoreFocusOut: true,
      });
      if (!request) {
        return;
      }
      const record = tasks.create('orchestration', request.slice(0, 60), accounts.main()!.name, config().mainModel);
      output.show(true);
      output.appendLine(`\n━━━ Orchestrated task: ${request}\n`);
      try {
        await runOrchestratedTask(
          request,
          accounts,
          pool,
          tasks,
          {
            onText: (chunk) => {
              output.append(chunk);
              tasks.append(record.id, chunk);
            },
            onStatus: (line) => output.appendLine(`\n[orchestrator] ${line}`),
          },
        );
        tasks.finish(record.id, 'done');
        output.appendLine('\n━━━ Done.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tasks.finish(record.id, 'error', message);
        output.appendLine(`\n━━━ Failed: ${message}`);
        vscode.window.showErrorMessage(`Orchestration failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.dispatchDirect', async () => {
      const workers = accounts.workers();
      if (workers.length === 0) {
        vscode.window.showErrorMessage('Add a worker account first: "Fable Orchestrator: Add Account".');
        return;
      }
      const pickedWorker = await vscode.window.showQuickPick(
        workers.map((w) => ({ label: w.name, description: w.model, id: w.id })),
        { placeHolder: 'Worker account' },
      );
      if (!pickedWorker) {
        return;
      }
      const pickedModel = await vscode.window.showQuickPick(
        WORKER_MODELS.map((m) => ({ label: m })),
        { placeHolder: 'Model' },
      );
      if (!pickedModel) {
        return;
      }
      const prompt = await vscode.window.showInputBox({ prompt: 'Task prompt', ignoreFocusOut: true });
      if (!prompt) {
        return;
      }
      const account = accounts.get(pickedWorker.id)!;
      const model = pickedModel.label as WorkerModel;
      const record = tasks.create('dispatch', prompt.slice(0, 60), account.name, model);
      output.show(true);
      output.appendLine(`\n━━━ Direct dispatch to ${account.name} (${model}): ${prompt}\n`);
      try {
        await pool.run(account, model, prompt, (chunk) => {
          output.append(chunk);
          tasks.append(record.id, chunk);
        });
        tasks.finish(record.id, 'done');
        output.appendLine('\n━━━ Done.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tasks.finish(record.id, 'error', message);
        output.appendLine(`\n━━━ Failed: ${message}`);
        vscode.window.showErrorMessage(`Dispatch failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.showTaskOutput', async (taskId: string) => {
      const uri = vscode.Uri.parse(`${TaskDocumentProvider.scheme}:/${taskId}`);
      taskDocs.refresh(taskId);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('fableOrchestrator.clearTasks', () => tasks.clearFinished()),
  );
}

export function deactivate(): void {}
