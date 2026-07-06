import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorkerManager } from './workerManager';
import { TasksProvider, WorkersProvider } from './views';
import { clearTaskLog, readRegistry, ROOT_DIR, WORKER_MODELS, WorkerModel } from './registry';
import { hasPolicy, upsertPolicy } from './prompts';
import { openDashboard } from './dashboard';

const MCP_SERVER_NAME = 'cco-dispatch';
/** Pre-rename server key — removed from .mcp.json when re-registering. */
const LEGACY_MCP_SERVER_NAME = 'fable-dispatch';

/**
 * Copy the bundled MCP server to a version-independent path. Installed
 * extensions live in a per-version directory, so registering the bundled path
 * in .mcp.json would break on every extension update; the stable copy under
 * ~/.fable-orchestrator survives updates and is refreshed on each activation.
 */
function ensureStableServerCopy(context: vscode.ExtensionContext): string {
  const bundled = context.asAbsolutePath(path.join('out', 'mcp', 'server.js'));
  const stable = path.join(ROOT_DIR, 'mcp', 'server.js');
  try {
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.copyFileSync(bundled, stable);
    return stable;
  } catch {
    return bundled;
  }
}

let cachedNodeCommand: string | undefined;

/**
 * Absolute path to the node binary. The MCP server is spawned by the Claude
 * Code CLI, which on macOS/Linux may not inherit the user's shell PATH (nvm,
 * homebrew) — a bare "node" command then fails the server's health check.
 * Resolve through the user's login shell; fall back to "node".
 */
function resolveNodeCommand(): string {
  if (cachedNodeCommand) {
    return cachedNodeCommand;
  }
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/sh';
      const out = execFileSync(shell, ['-lc', 'command -v node'], {
        encoding: 'utf8',
        timeout: 10_000,
      })
        .trim()
        .split('\n')
        .pop();
      if (out && fs.existsSync(out)) {
        cachedNodeCommand = out;
        return out;
      }
    } catch {
      // fall through
    }
  }
  cachedNodeCommand = 'node';
  return cachedNodeCommand;
}

function mcpRegisteredIn(folder: vscode.WorkspaceFolder): boolean {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, '.mcp.json'), 'utf8'));
    return Boolean(json?.mcpServers?.[MCP_SERVER_NAME]);
  } catch {
    return false;
  }
}

function registerMcp(folder: vscode.WorkspaceFolder, serverPath: string): void {
  const mcpFile = path.join(folder.uri.fsPath, '.mcp.json');
  let json: { mcpServers?: Record<string, unknown> } = {};
  try {
    json = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  } catch {
    // new file
  }
  json.mcpServers = {
    ...json.mcpServers,
    [MCP_SERVER_NAME]: { command: resolveNodeCommand(), args: [serverPath] },
  };
  delete json.mcpServers[LEGACY_MCP_SERVER_NAME];
  fs.writeFileSync(mcpFile, JSON.stringify(json, null, 2) + '\n');
}

/** Write/refresh the dispatch policy block in the workspace's CLAUDE.md. */
function writeDispatchPolicy(folder: vscode.WorkspaceFolder): void {
  const file = path.join(folder.uri.fsPath, 'CLAUDE.md');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // new file
  }
  fs.writeFileSync(file, upsertPolicy(existing));
}

async function offerDispatchPolicy(folder: vscode.WorkspaceFolder): Promise<void> {
  const file = path.join(folder.uri.fsPath, 'CLAUDE.md');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // no CLAUDE.md yet
  }
  if (hasPolicy(existing)) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Add the dispatch policy to this workspace\'s CLAUDE.md? It tells the main session to delegate ' +
      'all implementation to workers (it only designs, integrates, and verifies), batch subtasks in ' +
      'parallel, and write per-task system prompts.',
    'Add to CLAUDE.md',
    'Skip',
  );
  if (choice === 'Add to CLAUDE.md') {
    writeDispatchPolicy(folder);
  }
}

/** One-time-per-workspace offer to register the MCP server automatically. */
async function maybeOfferMcpRegistration(
  context: vscode.ExtensionContext,
  serverPath: string,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || readRegistry().workers.length === 0 || mcpRegisteredIn(folder)) {
    return;
  }
  const dismissKey = `fableOrchestrator.mcpOfferDismissed:${folder.uri.fsPath}`;
  if (context.workspaceState.get<boolean>(dismissKey)) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Fable Orchestrator: worker accounts are configured, but the dispatch MCP server is not ' +
      'registered in this workspace. Register it so your Claude Code session can dispatch tasks?',
    'Register',
    'Not in this workspace',
  );
  if (choice === 'Register') {
    registerMcp(folder, serverPath);
    vscode.window.showInformationMessage(
      'Registered. Restart the Claude Code session here and approve the project MCP server.',
    );
    await offerDispatchPolicy(folder);
  } else if (choice === 'Not in this workspace') {
    await context.workspaceState.update(dismissKey, true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const workers = new WorkerManager();
  workers.syncSettings();
  const serverPath = ensureStableServerCopy(context);
  void maybeOfferMcpRegistration(context, serverPath);

  const workersProvider = new WorkersProvider(workers);
  const tasksProvider = new TasksProvider();

  const tasksView = vscode.window.createTreeView('fableOrchestrator.tasks', {
    treeDataProvider: tasksProvider,
  });
  tasksView.description = 'this workspace';

  context.subscriptions.push(
    tasksProvider,
    workersProvider,
    tasksView,
    vscode.window.registerTreeDataProvider('fableOrchestrator.workers', workersProvider),
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
        void maybeOfferMcpRegistration(context, serverPath);
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

    vscode.commands.registerCommand('fableOrchestrator.togglePreferred', async (item?: { id?: string }) => {
      const worker = await resolveWorker(workers, item);
      if (!worker) {
        return;
      }
      const enabled = workers.togglePreferred(worker.name);
      vscode.window.showInformationMessage(
        enabled
          ? `"${worker.name}" is now the preferred worker — automatic assignment favors it unless it's busier than the alternatives.`
          : `"${worker.name}" is no longer preferred.`,
      );
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
      if (!fs.existsSync(serverPath)) {
        vscode.window.showErrorMessage(`MCP server missing (${serverPath}). Reinstall the extension or run "npm run compile".`);
        return;
      }
      registerMcp(folder, serverPath);
      vscode.window.showInformationMessage(
        `Registered "${MCP_SERVER_NAME}" in .mcp.json. Restart the Claude Code session in this workspace ` +
          'and approve the project MCP server — dispatch_tasks / dispatch_task / list_workers will then be available.',
      );
      await offerDispatchPolicy(folder);
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

    vscode.commands.registerCommand('fableOrchestrator.toggleTaskScope', () => {
      tasksProvider.scopeToWorkspace = !tasksProvider.scopeToWorkspace;
      tasksView.description = tasksProvider.scopeToWorkspace ? 'this workspace' : 'all workspaces';
      tasksProvider.refresh();
    }),

    vscode.commands.registerCommand('fableOrchestrator.openDashboard', () => openDashboard()),

    vscode.commands.registerCommand('fableOrchestrator.addDispatchPolicy', () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      writeDispatchPolicy(folder);
      vscode.window.showInformationMessage(
        'Dispatch policy written to CLAUDE.md (existing policy block updated in place).',
      );
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
