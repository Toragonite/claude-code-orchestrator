import * as vscode from 'vscode';
import { AccountManager } from './accounts';
import { TaskRegistry } from './tasks';
import { WorkerPool } from './workers';
import { runOrchestratedTask } from './orchestrator';
import { AccountsProvider, TasksProvider, TaskDocumentProvider } from './views';
import { config, WORKER_MODELS, WorkerModel } from './models';
import { Credentials } from './accounts';
import { authorizeUrl, exchangeCode, generatePkce } from './oauth';
import { discoverStoredLogins } from './importers';

/**
 * Browser sign-in for one Claude account: open the authorize URL, then accept
 * the pasted code from the callback page. Returns undefined if cancelled.
 */
async function signInWithClaude(accountName: string): Promise<Credentials | undefined> {
  const pkce = generatePkce();
  const url = authorizeUrl(pkce);
  const open = await vscode.window.showInformationMessage(
    `Sign in to Claude for account "${accountName}". ` +
      'A browser will open — log in with the Claude account you want to use for this slot, ' +
      'then copy the code shown on the callback page.',
    { modal: true },
    'Open Browser',
  );
  if (open !== 'Open Browser') {
    return undefined;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
  const pasted = await vscode.window.showInputBox({
    prompt: `Paste the authorization code for "${accountName}" (looks like "code#state")`,
    ignoreFocusOut: true,
    password: true,
    validateInput: (v) => (v.trim() ? undefined : 'Authorization code is required'),
  });
  if (!pasted) {
    return undefined;
  }
  return exchangeCode(pasted, pkce);
}

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
      const method = await vscode.window.showQuickPick(
        [
          {
            label: 'Sign in with Claude (OAuth)',
            description: 'Browser login with this account — recommended',
            value: 'oauth' as const,
          },
          {
            label: 'Anthropic API key',
            description: 'Paste a key from the Console instead',
            value: 'apiKey' as const,
          },
        ],
        { placeHolder: 'Authentication method' },
      );
      if (!method) {
        return;
      }
      try {
        let credentials: Credentials | undefined;
        if (method.value === 'oauth') {
          credentials = await signInWithClaude(name.trim());
        } else {
          const apiKey = await vscode.window.showInputBox({
            prompt: `Anthropic API key for "${name.trim()}" (stored in VS Code Secret Storage)`,
            password: true,
            validateInput: (v) => (v.trim() ? undefined : 'API key is required'),
          });
          if (apiKey) {
            credentials = { type: 'apiKey', apiKey: apiKey.trim() };
          }
        }
        if (!credentials) {
          return;
        }
        await accounts.add(name.trim(), role.value, credentials, model);
        vscode.window.showInformationMessage(`Account "${name.trim()}" added.`);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.importLogins', async () => {
      const logins = discoverStoredLogins();
      if (logins.length === 0) {
        vscode.window.showInformationMessage(
          'No stored Claude logins found on this machine. Looked for Claude Code credentials ' +
            '(~/.claude*/.credentials.json, $CLAUDE_CONFIG_DIR) and ant CLI profiles ' +
            '(~/.config/anthropic/credentials). On macOS, Claude Code may store tokens in the ' +
            'Keychain instead — use "Add Account" to sign in via the browser.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        logins.map((l) => ({ label: l.label, description: l.source, login: l })),
        { placeHolder: 'Stored logins to import as accounts', canPickMany: true },
      );
      if (!picked || picked.length === 0) {
        return;
      }

      const usedNames = new Set(accounts.list().map((a) => a.name));
      const uniqueName = (base: string) => {
        let name = base;
        for (let i = 2; usedNames.has(name); i++) {
          name = `${base}-${i}`;
        }
        usedNames.add(name);
        return name;
      };

      let imported = 0;
      for (const { login } of picked) {
        const roleOptions: { label: string; description?: string; value: 'main' | WorkerModel | 'skip' }[] = [];
        if (!accounts.main()) {
          roleOptions.push({ label: 'Main (Fable orchestrator)', value: 'main' });
        }
        roleOptions.push(
          { label: 'Worker — claude-opus-4-8', value: 'claude-opus-4-8' },
          { label: 'Worker — claude-sonnet-5', value: 'claude-sonnet-5' },
          { label: 'Skip this login', value: 'skip' },
        );
        const assignment = await vscode.window.showQuickPick(roleOptions, {
          placeHolder: `Role for "${login.label}"`,
          ignoreFocusOut: true,
        });
        if (!assignment || assignment.value === 'skip') {
          continue;
        }
        const base = login.label
          .replace(/[^\w~./ -]+/g, '')
          .replace(/\s+/g, '-')
          .toLowerCase();
        try {
          if (assignment.value === 'main') {
            await accounts.add(uniqueName(base), 'main', login.tokens);
          } else {
            await accounts.add(uniqueName(base), 'worker', login.tokens, assignment.value);
          }
          imported++;
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to import "${login.label}": ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (imported > 0) {
        vscode.window.showInformationMessage(
          `Imported ${imported} account(s). Tokens were copied into Secret Storage — after the ` +
            'extension refreshes them, the original tool may need to sign in again.',
        );
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.reauthAccount', async (item?: { id?: string }) => {
      let id = item?.id;
      if (!id) {
        const picked = await vscode.window.showQuickPick(
          accounts
            .list()
            .filter((a) => a.auth === 'oauth')
            .map((a) => ({ label: a.name, description: a.role, id: a.id })),
          { placeHolder: 'Account to re-authenticate' },
        );
        id = picked?.id;
      }
      if (!id) {
        return;
      }
      const account = accounts.get(id);
      if (!account) {
        return;
      }
      try {
        const credentials = await signInWithClaude(account.name);
        if (!credentials) {
          return;
        }
        await accounts.storeCredentials(account.id, credentials);
        vscode.window.showInformationMessage(`Account "${account.name}" re-authenticated.`);
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
