import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager } from './workerManager';
import { TasksProvider, WorkersProvider } from './views';
import { clearTaskLog, WORKER_MODELS, WorkerModel } from './registry';

const MCP_SERVER_NAME = 'fable-dispatch';

export function activate(context: vscode.ExtensionContext): void {
  const workers = new WorkerManager();
  workers.syncSettings();

  const workersProvider = new WorkersProvider(workers);
  const tasksProvider = new TasksProvider();

  context.subscriptions.push(
    tasksProvider,
    vscode.window.registerTreeDataProvider('fableOrchestrator.workers', workersProvider),
    vscode.window.registerTreeDataProvider('fableOrchestrator.tasks', tasksProvider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fableOrchestrator')) {
        workers.syncSettings();
      }
    }),
  );

  const pickModel = async (): Promise<WorkerModel | undefined> => {
    const picked = await vscode.window.showQuickPick(
      WORKER_MODELS.map((m) => ({ label: m })),
      { placeHolder: 'Default model for this worker' },
    );
    return picked?.label as WorkerModel | undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fableOrchestrator.addWorker', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Worker account name (e.g. "w1") — a config directory ~/.claude-<name> will be created',
        validateInput: (v) => (/^[\w-]+$/.test(v.trim()) ? undefined : 'Use letters, digits, - or _'),
      });
      if (!name) {
        return;
      }
      const model = await pickModel();
      if (!model) {
        return;
      }
      try {
        const worker = workers.add(name.trim(), model);
        const login = await vscode.window.showInformationMessage(
          `Worker "${worker.name}" added. Sign in once with the Claude account for this slot — ` +
            'a terminal will open running Claude Code under this worker\'s config directory.',
          'Open Login Terminal',
          'Later',
        );
        if (login === 'Open Login Terminal') {
          workers.openTerminal(worker);
        }
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.importWorkers', async () => {
      const discovered = workers.discoverConfigDirs();
      if (discovered.length === 0) {
        vscode.window.showInformationMessage(
          'No unregistered Claude Code config directories (~/.claude*) found.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        discovered.map((d) => ({
          label: d.suggestedName,
          description: d.dir,
          detail: d.loggedIn ? 'login found' : 'no login yet — sign in on first use',
          entry: d,
        })),
        { placeHolder: 'Config directories to register as workers', canPickMany: true },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      for (const { entry } of picked) {
        const model = await vscode.window.showQuickPick(
          WORKER_MODELS.map((m) => ({ label: m })),
          { placeHolder: `Default model for "${entry.suggestedName}" (${entry.dir})`, ignoreFocusOut: true },
        );
        if (!model) {
          continue;
        }
        try {
          workers.add(entry.suggestedName, model.label as WorkerModel, entry.dir);
        } catch (err) {
          vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.removeWorker', async (item?: { id?: string }) => {
      let name = item?.id;
      if (!name) {
        const picked = await vscode.window.showQuickPick(
          workers.list().map((w) => ({ label: w.name, description: w.configDir })),
          { placeHolder: 'Worker to remove (its config directory and login stay on disk)' },
        );
        name = picked?.label;
      }
      if (name) {
        workers.remove(name);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.loginWorker', async (item?: { id?: string }) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        workers.openTerminal(worker);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.openWorkerSession', async (item?: { id?: string }) => {
      const worker = await resolveWorker(workers, item);
      if (!worker) {
        return;
      }
      const prompt = await vscode.window.showInputBox({
        prompt: `Initial task for the interactive session on "${worker.name}" (leave empty to just open Claude Code)`,
        ignoreFocusOut: true,
      });
      workers.openTerminal(worker, prompt?.trim() || undefined);
    }),

    vscode.commands.registerCommand('fableOrchestrator.installMcp', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const serverPath = context.asAbsolutePath(path.join('out', 'mcp', 'server.js'));
      if (!fs.existsSync(serverPath)) {
        vscode.window.showErrorMessage(`MCP server not built yet (missing ${serverPath}). Run "npm run compile".`);
        return;
      }
      const mcpFile = path.join(folder.uri.fsPath, '.mcp.json');
      let json: { mcpServers?: Record<string, unknown> } = {};
      try {
        json = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      } catch {
        // new file
      }
      json.mcpServers = {
        ...json.mcpServers,
        [MCP_SERVER_NAME]: { command: 'node', args: [serverPath] },
      };
      fs.writeFileSync(mcpFile, JSON.stringify(json, null, 2) + '\n');
      vscode.window.showInformationMessage(
        `Registered "${MCP_SERVER_NAME}" in .mcp.json. Restart the Claude Code session in this workspace ` +
          'and approve the project MCP server — dispatch_task / list_workers will then be available.',
      );
    }),

    vscode.commands.registerCommand('fableOrchestrator.showTaskOutput', async (outputFile: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outputFile));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`Task output not found: ${outputFile}`);
      }
    }),

    vscode.commands.registerCommand('fableOrchestrator.clearTasks', () => {
      clearTaskLog();
      tasksProvider.refresh();
    }),
  );
}

async function resolveWorker(workers: WorkerManager, item?: { id?: string }) {
  if (item?.id) {
    return workers.get(item.id);
  }
  const picked = await vscode.window.showQuickPick(
    workers.list().map((w) => ({ label: w.name, description: w.model })),
    { placeHolder: 'Worker account' },
  );
  return picked ? workers.get(picked.label) : undefined;
}

export function deactivate(): void {}
