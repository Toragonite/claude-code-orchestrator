import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { configDirForName, dirHasLogin, openReloginTerminal, WorkerManager } from './workerManager';
import { TasksProvider, WorkersProvider } from './views';
import {
  cancelRunningTask,
  clearTaskLog,
  LEGACY_ROOT_DIR,
  reapDeadTasks,
  readRegistry,
  ROOT_DIR,
  runningTasks,
  WORKER_MODELS,
  WorkerModel,
} from './registry';
import { hasPolicy, upsertPolicy } from './prompts';
import { openDashboard } from './dashboard';
import {
  getCachedUsage,
  isLoginExpired,
  listAccounts,
  refreshAllUsage,
  refreshAllUsageIfStale,
} from './usage';
import { KEEPALIVE_TICK_MS, runKeepaliveSweep } from './keepalive';

const MCP_SERVER_NAME = 'cco-dispatch';
/** Pre-rename server key — removed from .mcp.json when re-registering. */
const LEGACY_MCP_SERVER_NAME = 'fable-dispatch';

/**
 * Copy the bundled MCP server to a version-independent path. Installed
 * extensions live in a per-version directory, so registering the bundled path
 * in .mcp.json would break on every extension update; the stable copy under
 * ~/.claude-code-orchestrator survives updates and is refreshed on each activation.
 */
function ensureStableServerCopy(context: vscode.ExtensionContext): string {
  const bundled = context.asAbsolutePath(path.join('out', 'mcp', 'server.js'));
  const stable = path.join(ROOT_DIR, 'mcp', 'server.js');
  try {
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.copyFileSync(bundled, stable);
    ensureLegacyServerShim(stable);
    return stable;
  } catch {
    return bundled;
  }
}

/**
 * Workspaces registered before the data-directory rename point their
 * .mcp.json at the old stable path. Keep a one-line forwarding shim there so
 * those registrations keep working without a re-register.
 */
function ensureLegacyServerShim(stable: string): void {
  try {
    const legacy = path.join(LEGACY_ROOT_DIR, 'mcp', 'server.js');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, `require(${JSON.stringify(stable)});\n`);
  } catch {
    // best-effort compatibility only
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
  const dismissKey = `claudeCodeOrchestrator.mcpOfferDismissed:${folder.uri.fsPath}`;
  if (context.workspaceState.get<boolean>(dismissKey)) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Claude Code Orchestrator: worker accounts are configured, but the dispatch MCP server is not ' +
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

/** One-time copy of user-set values from the pre-rename settings namespace. */
async function migrateLegacySettings(): Promise<void> {
  const KEYS = ['workerPermissionMode', 'claudePath', 'quotaCooldownMinutes', 'frontierWorkerDispatch'];
  const legacy = vscode.workspace.getConfiguration('fableOrchestrator');
  const current = vscode.workspace.getConfiguration('claudeCodeOrchestrator');
  for (const key of KEYS) {
    const oldValue = legacy.inspect(key);
    const newValue = current.inspect(key);
    try {
      if (oldValue?.globalValue !== undefined && newValue?.globalValue === undefined) {
        await current.update(key, oldValue.globalValue, vscode.ConfigurationTarget.Global);
      }
      if (oldValue?.workspaceValue !== undefined && newValue?.workspaceValue === undefined) {
        await current.update(key, oldValue.workspaceValue, vscode.ConfigurationTarget.Workspace);
      }
    } catch {
      // settings migration is best-effort
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const workers = new WorkerManager();
  void migrateLegacySettings().then(() => workers.syncSettings());
  workers.syncSettings();
  const serverPath = ensureStableServerCopy(context);
  void maybeOfferMcpRegistration(context, serverPath);

  // Live-usage cache: never block activation on a probe. Fire an initial
  // refresh, keep the cache warm on a timer, and let users refresh on demand.
  // The tree/dashboard/MCP surfaces watch the cache file this writes. Both the
  // activation refresh and the timer go through the stale-guarded variant so a
  // second editor sharing the cache doesn't re-probe readings another window
  // just took; only the explicit Refresh command below forces a real probe.
  void refreshAllUsageIfStale().catch(() => {});
  const usageTimer = setInterval(() => {
    void refreshAllUsageIfStale().catch(() => {});
  }, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });

  // Session keepalive (opt-in): one minimal request per subscription account per
  // 24h so an idle account's OAuth session doesn't lapse into the expired state.
  // The setting is read fresh on every tick rather than captured at activation,
  // so toggling it takes effect without a window reload. The first sweep is
  // deferred ~2 minutes to keep activation and the initial usage refresh clear.
  // runKeepaliveSweep never throws and enforces the per-account 24h stamps itself.
  const keepaliveTick = (): void => {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeOrchestrator')
      .get<boolean>('sessionKeepalive', false);
    if (enabled) {
      void runKeepaliveSweep();
    }
  };
  const keepaliveTimer = setInterval(keepaliveTick, KEEPALIVE_TICK_MS);
  const keepaliveFirstRun = setTimeout(keepaliveTick, 2 * 60 * 1000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(keepaliveTimer);
      clearTimeout(keepaliveFirstRun);
    },
  });

  const workersProvider = new WorkersProvider(workers);
  const tasksProvider = new TasksProvider();

  // A crashed or killed orchestrator session leaves its dispatches stuck at
  // 'running'. Reclaim them on startup — best-effort, never blocks activation.
  try {
    const reaped = reapDeadTasks();
    if (reaped > 0) {
      tasksProvider.refresh();
      vscode.window.showInformationMessage(
        `Reclaimed ${reaped} dispatched task(s) left running by a previous session.`,
      );
    }
  } catch {
    // stale task rows are cosmetic; activation must still succeed
  }

  const tasksView = vscode.window.createTreeView('claudeCodeOrchestrator.tasks', {
    treeDataProvider: tasksProvider,
  });
  tasksView.description = 'this workspace';

  context.subscriptions.push(
    tasksProvider,
    workersProvider,
    tasksView,
    vscode.window.registerTreeDataProvider('claudeCodeOrchestrator.workers', workersProvider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeOrchestrator')) {
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
    vscode.commands.registerCommand('claudeCodeOrchestrator.addWorker', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Worker account name (e.g. "w1") — a config directory ~/.claude-<name> will be created',
        validateInput: (v) => {
          const trimmed = v.trim();
          if (!/^[\w-]+$/.test(trimmed)) {
            return 'Use letters, digits, - or _';
          }
          // 'main' is how the orchestrator's own account is listed everywhere; a
          // worker sharing that name makes the two indistinguishable by name.
          return trimmed === 'main'
            ? '"main" is reserved for the orchestrator session\'s own account.'
            : undefined;
        },
      });
      if (!name) {
        return;
      }
      const model = await pickModel();
      if (!model) {
        return;
      }
      // The config dir is derived from the name and KEPT across renames, so a
      // leftover ~/.claude-<name> from a since-renamed worker still holds a login.
      // If that dir belongs to a REGISTERED worker, add() throws and the catch
      // below surfaces it; this modal is only for an unregistered leftover login.
      const dir = configDirForName(name.trim());
      if (dirHasLogin(dir)) {
        const proceed = await vscode.window.showWarningMessage(
          `The config directory ${dir} already exists and contains a Claude login — possibly from a ` +
            'worker that was later renamed (a worker keeps its original directory when renamed). Adding ' +
            'this worker will reuse that existing login rather than start a fresh sign-in.',
          { modal: true },
          'Use Existing Login',
          'Cancel',
        );
        if (proceed !== 'Use Existing Login') {
          return;
        }
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

    vscode.commands.registerCommand('claudeCodeOrchestrator.importWorkers', async () => {
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

    vscode.commands.registerCommand('claudeCodeOrchestrator.removeWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        workers.remove(worker.name);
      }
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.togglePreferred', async (item?: unknown) => {
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

    vscode.commands.registerCommand('claudeCodeOrchestrator.renameWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (!worker) {
        return;
      }
      const taken = new Set(
        workers.list().map((w) => w.name).filter((n) => n !== worker.name),
      );
      const newName = await vscode.window.showInputBox({
        value: worker.name,
        prompt: 'New name for this worker — the config directory and login are unchanged',
        validateInput: (v) => {
          const trimmed = v.trim();
          if (!/^[\w-]+$/.test(trimmed)) {
            return 'Use letters, digits, - or _';
          }
          // Mirrors addWorker: 'main' labels the orchestrator's own account, so a
          // worker renamed into it becomes indistinguishable from that entry.
          if (trimmed === 'main') {
            return '"main" is reserved for the orchestrator session\'s own account.';
          }
          return taken.has(trimmed) ? `A worker named "${trimmed}" already exists.` : undefined;
        },
      });
      if (!newName || newName.trim() === worker.name) {
        return;
      }
      try {
        workers.rename(worker.name, newName.trim());
        vscode.window.showInformationMessage(
          `Worker "${worker.name}" renamed to "${newName.trim()}". Its config directory and login are unchanged.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.loginWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        workers.openTerminal(worker);
      }
    }),

    // Re-authenticate an account whose subscription login expired. Reachable from
    // the dashboard card (which posts `{ configDir }`, covering 'main', which has
    // no WorkerProfile), from the workers tree (which passes the element), and
    // from the command palette (no argument at all).
    vscode.commands.registerCommand('claudeCodeOrchestrator.reloginWorker', async (item?: unknown) => {
      const accounts = listAccounts();
      // Account NAMES are not unique: listAccounts unconditionally prepends the
      // orchestrator's own dir as 'main' and a registry worker may legally carry
      // that name too. The config DIRECTORY is the account's real identity, so it
      // is matched first everywhere; a name match is only the legacy fallback.
      const byDir = (dir: string): { name: string; configDir: string } | undefined => {
        const matches = accounts.filter((a) => a.configDir === dir);
        // Several entries can share one directory. Any of them re-logs the same
        // login — only the LABEL differs, so prefer the more informative
        // worker name over the generic 'main'.
        return matches.find((a) => a.name !== 'main') ?? matches[0];
      };
      let target: { name: string; configDir: string } | undefined;
      const asRecord =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
      if (asRecord && typeof asRecord.configDir === 'string') {
        target = byDir(asRecord.configDir);
        if (!target) {
          // A card rendered before the account was removed or its dir changed.
          vscode.window.showWarningMessage(`Unknown account directory "${asRecord.configDir}"`);
          return;
        }
      } else if (typeof item === 'string') {
        target = byDir(item) ?? accounts.find((a) => a.name === item);
        if (!target) {
          // A card rendered before the account was removed or renamed.
          vscode.window.showWarningMessage(`Unknown account "${item}"`);
          return;
        }
      } else {
        // Only take the tree path when an element was actually passed —
        // resolveWorker's own quick pick would otherwise pre-empt the
        // expired-first pick below and omit 'main'.
        const rec = item as { id?: unknown; name?: unknown } | undefined;
        if (rec && (typeof rec.id === 'string' || typeof rec.name === 'string')) {
          const worker = await resolveWorker(workers, item);
          if (worker) {
            target = { name: worker.name, configDir: worker.configDir };
          }
        }
      }
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          accounts
            .map((a) => ({ account: a, expired: isLoginExpired(getCachedUsage(a.configDir)) }))
            // Expired accounts first — they are the reason this command exists.
            .sort((a, b) => Number(b.expired) - Number(a.expired))
            .map(({ account, expired }) => ({
              label: account.name,
              description: expired ? `⚠ login expired · ${account.configDir}` : account.configDir,
              account,
            })),
          { placeHolder: 'Account to re-login' },
        );
        if (!picked) {
          return;
        }
        target = picked.account;
      }
      openReloginTerminal(target.name, target.configDir);
      vscode.window.showInformationMessage(
        'Complete the login in the terminal — usage refreshes within a few minutes.',
      );
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.openWorkerSession', async (item?: unknown) => {
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

    vscode.commands.registerCommand('claudeCodeOrchestrator.installMcp', async () => {
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

    vscode.commands.registerCommand('claudeCodeOrchestrator.showTaskOutput', async (outputFile: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outputFile));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`Task output not found: ${outputFile}`);
      }
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.clearTasks', () => {
      clearTaskLog();
      tasksProvider.refresh();
    }),

    // Invoked with a TaskEvent from the tree context menu, { id } from the
    // dashboard webview, or no argument at all from the command palette.
    vscode.commands.registerCommand('claudeCodeOrchestrator.cancelTask', async (arg?: { id?: string }) => {
      let id = arg?.id;
      if (!id) {
        const running = runningTasks();
        if (running.length === 0) {
          vscode.window.showInformationMessage('No running dispatches.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          running.map((t) => ({ label: t.title, description: t.worker, id: t.id })),
          { placeHolder: 'Running dispatch to cancel — its worker will be terminated' },
        );
        id = picked?.id;
      }
      if (!id) {
        return;
      }
      try {
        const cancelled = await cancelRunningTask(id, 'cancelled by user');
        tasksProvider.refresh();
        vscode.window.showInformationMessage(
          cancelled
            ? 'Dispatched task cancelled.'
            : 'That dispatch was no longer running — its row has been cleared.',
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to cancel dispatch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.cancelAllTasks', async () => {
      const running = runningTasks();
      if (running.length === 0) {
        vscode.window.showInformationMessage('No running dispatches.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Cancel ${running.length} running dispatch(es)? Their workers will be terminated.`,
        { modal: true },
        'Cancel Dispatches',
      );
      if (confirm !== 'Cancel Dispatches') {
        return;
      }
      // allSettled: one worker refusing to die must not strand the others.
      const results = await Promise.allSettled(
        running.map((t) => cancelRunningTask(t.id, 'cancelled by user')),
      );
      tasksProvider.refresh();
      const cancelled = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      vscode.window.showInformationMessage(
        failed > 0
          ? `Cancelled ${cancelled} of ${running.length} dispatch(es); ${failed} failed.`
          : `Cancelled ${cancelled} of ${running.length} dispatch(es).`,
      );
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.toggleTaskScope', () => {
      tasksProvider.scopeToWorkspace = !tasksProvider.scopeToWorkspace;
      tasksView.description = tasksProvider.scopeToWorkspace ? 'this workspace' : 'all workspaces';
      tasksProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.openDashboard', () => openDashboard()),

    vscode.commands.registerCommand('claudeCodeOrchestrator.refreshUsage', async () => {
      try {
        await refreshAllUsage();
        vscode.window.showInformationMessage('Account usage refreshed.');
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to refresh account usage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('claudeCodeOrchestrator.addDispatchPolicy', () => {
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

/**
 * Resolve which worker a command targets. VS Code passes the tree ELEMENT (a
 * WorkerProfile, `{ name, configDir, model }`) to view/item/context commands,
 * while the dashboard and programmatic callers pass `{ id }`. Resolve `id`
 * first (a string), then the element's `name` (a string), and only fall back to
 * a quick pick when neither is present (command palette / no argument).
 */
async function resolveWorker(workers: WorkerManager, item?: unknown) {
  const rec = item as { id?: unknown; name?: unknown } | undefined;
  if (rec && typeof rec.id === 'string') {
    return workers.get(rec.id);
  }
  if (rec && typeof rec.name === 'string') {
    return workers.get(rec.name);
  }
  const picked = await vscode.window.showQuickPick(
    workers.list().map((w) => ({ label: w.name, description: w.model })),
    { placeHolder: 'Worker account' },
  );
  return picked ? workers.get(picked.label) : undefined;
}

export function deactivate(): void {}
