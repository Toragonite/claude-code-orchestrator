import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyFrontierGuard,
  applyOverageGuard,
  findWorkerByConfigDir,
  readRegistry,
  renameWorker,
  resolveClaudePathPreserving,
  writeRegistry,
  WorkerModel,
  WorkerProfile,
} from './registry';
import { deleteUsageEntries, readOauthEmail, sanitizeEmailForShell } from './usage';

/**
 * Quote a command path for a terminal command line when it contains whitespace
 * (e.g. `C:\Program Files\...\claude.cmd`). Double quotes are the one form
 * POSIX shells, PowerShell and cmd.exe all accept. A path containing a double
 * quote itself is out of scope — no escaping is attempted.
 */
function quoteCommandPath(command: string): string {
  return /\s/.test(command) ? `"${command}"` : command;
}

/**
 * The config directory a worker gets when created from `name`. This derivation is
 * the single source of truth: the extension's addWorker command imports it to
 * pre-check for a collision before calling add().
 */
export function configDirForName(name: string): string {
  return path.join(os.homedir(), `.claude-${name}`);
}

/**
 * Whether `dir` holds a Claude Code login — probed the same way discoverConfigDirs
 * decides a directory is logged in: a `.credentials.json` or `.claude.json` file.
 * Any fs error (missing/unreadable dir) reads as "no login".
 */
export function dirHasLogin(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, '.credentials.json')) ||
      fs.existsSync(path.join(dir, '.claude.json'))
    );
  } catch {
    return false;
  }
}

/**
 * Extension-side management of worker accounts. A worker account is simply a
 * Claude Code config directory (CLAUDE_CONFIG_DIR) with its own login — no
 * tokens are copied or stored by this extension. The registry file is shared
 * with the MCP dispatch server.
 */
export class WorkerManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  list(): WorkerProfile[] {
    return readRegistry().workers;
  }

  get(name: string): WorkerProfile | undefined {
    return this.list().find((w) => w.name === name);
  }

  add(name: string, model: WorkerModel, configDir?: string): WorkerProfile {
    const registry = readRegistry();
    // 'main' is the fixed label for the orchestrator session's own account, which
    // every account listing prepends. A worker carrying it would be ambiguous with
    // that entry anywhere accounts are addressed by name. The addWorker input box
    // rejects it too; this is the last line of defense (import, MCP, direct calls).
    if (name === 'main') {
      throw new Error('"main" is reserved for the orchestrator session\'s own account.');
    }
    if (registry.workers.some((w) => w.name === name)) {
      throw new Error(`A worker named "${name}" already exists.`);
    }
    const dir = configDir ?? configDirForName(name);
    // A worker keeps its original directory when renamed, so a previously-used
    // name (or an explicit dir) can already belong to another worker. Adding a
    // second worker on that dir would silently share its login — refuse it here.
    const owner = findWorkerByConfigDir(registry.workers, dir);
    if (owner) {
      throw new Error(
        `Config directory ${dir} already belongs to worker "${owner.name}". A worker keeps its original directory when renamed, so this name would silently share that worker's login. Pick a different name, or remove/rename "${owner.name}" first.`,
      );
    }
    fs.mkdirSync(dir, { recursive: true });
    const worker: WorkerProfile = { name, configDir: dir, model };
    registry.workers.push(worker);
    writeRegistry(registry);
    this._onDidChange.fire();
    return worker;
  }

  remove(name: string): void {
    const registry = readRegistry();
    const removed = registry.workers.find((w) => w.name === name);
    registry.workers = registry.workers.filter((w) => w.name !== name);
    writeRegistry(registry);
    // Drop the removed worker's usage-cache entry so a re-registered name/dir
    // doesn't inherit a stale quota-exhausted verdict — but only when no
    // remaining worker still uses that directory. We cannot know the main
    // session's config dir here, so a directory shared with the main session
    // may be deleted; the background refresher re-creates the main entry within
    // minutes, so that transient loss is acceptable.
    if (removed && !findWorkerByConfigDir(registry.workers, removed.configDir)) {
      deleteUsageEntries([removed.configDir]);
    }
    this._onDidChange.fire();
  }

  /** Relabel a worker; its config directory and login are untouched. */
  rename(oldName: string, newName: string): void {
    // Same reservation add() enforces — renaming into 'main' would otherwise
    // recreate exactly the ambiguity the reservation exists to prevent.
    if (newName === 'main') {
      throw new Error('"main" is reserved for the orchestrator session\'s own account.');
    }
    renameWorker(oldName, newName);
    this._onDidChange.fire();
  }

  /** Mark one worker as preferred (clears the flag on all others). */
  togglePreferred(name: string): boolean {
    const registry = readRegistry();
    const target = registry.workers.find((w) => w.name === name);
    if (!target) {
      return false;
    }
    const enabling = !target.preferred;
    for (const w of registry.workers) {
      w.preferred = false;
    }
    target.preferred = enabling;
    writeRegistry(registry);
    this._onDidChange.fire();
    return enabling;
  }

  setModel(name: string, model: WorkerModel): void {
    const registry = readRegistry();
    const worker = registry.workers.find((w) => w.name === name);
    if (worker) {
      worker.model = model;
      writeRegistry(registry);
      this._onDidChange.fire();
    }
  }

  /** Push extension settings the MCP server needs into the shared registry. */
  syncSettings(): void {
    const cfg = vscode.workspace.getConfiguration('claudeCodeOrchestrator');
    const registry = readRegistry();
    registry.permissionMode = cfg.get<string>('workerPermissionMode', 'acceptEdits');
    registry.claudePath = resolveClaudePathPreserving(
      cfg.get<string>('claudePath', 'claude'),
      registry.claudePath,
    );
    registry.cooldownMinutes = cfg.get<number>('quotaCooldownMinutes', 30);
    // Billing guards: reconcile across editors that share this registry. Use
    // inspect() (not get()) so an editor where the setting is UNSET is
    // distinguished from one that explicitly chose the default — an unset editor
    // must not clobber another editor's explicit `allow` back to `block`. The two
    // guards are independent: frontier governs WHICH MODEL may be dispatched,
    // overage governs whether ANY dispatch may bill past an exhausted plan window.
    const fg = cfg.inspect<string>('frontierWorkerDispatch');
    const explicit = fg?.workspaceFolderValue ?? fg?.workspaceValue ?? fg?.globalValue;
    applyFrontierGuard(registry, vscode.env.appName, explicit);
    const og = cfg.inspect<string>('overageWorkerDispatch');
    const overageExplicit = og?.workspaceFolderValue ?? og?.workspaceValue ?? og?.globalValue;
    applyOverageGuard(registry, vscode.env.appName, overageExplicit);
    writeRegistry(registry);
  }

  /** Claude Code config directories on disk that aren't registered yet. */
  discoverConfigDirs(): { dir: string; suggestedName: string; loggedIn: boolean }[] {
    const home = os.homedir();
    const registered = new Set(this.list().map((w) => w.configDir));
    const found: { dir: string; suggestedName: string; loggedIn: boolean }[] = [];
    try {
      for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.claude')) {
          continue;
        }
        const dir = path.join(home, entry.name);
        if (registered.has(dir)) {
          continue;
        }
        const loggedIn = dirHasLogin(dir);
        const suggestedName =
          entry.name === '.claude' ? 'default' : entry.name.replace(/^\.claude-?/, '') || entry.name;
        found.push({ dir, suggestedName, loggedIn });
      }
    } catch {
      // home unreadable
    }
    return found;
  }

  /**
   * Open an interactive Claude Code session for this worker in an integrated
   * terminal (the account's CLAUDE_CONFIG_DIR is set on the terminal). If the
   * account isn't logged in yet, Claude Code prompts for login right there.
   */
  openTerminal(worker: WorkerProfile, initialPrompt?: string): vscode.Terminal {
    const cfg = vscode.workspace.getConfiguration('claudeCodeOrchestrator');
    const claudePath = cfg.get<string>('claudePath', 'claude');
    const terminal = vscode.window.createTerminal({
      name: `claude: ${worker.name}`,
      env: { CLAUDE_CONFIG_DIR: worker.configDir },
    });
    terminal.show();
    if (initialPrompt) {
      const quoted = `"${initialPrompt.replace(/(["\\$`])/g, '\\$1')}"`;
      terminal.sendText(`${quoteCommandPath(claudePath)} ${quoted}`);
    } else {
      terminal.sendText(quoteCommandPath(claudePath));
    }
    return terminal;
  }
}

/**
 * Open a terminal running `claude auth login` against `configDir`, to recover an
 * expired or logged-out account. Standalone rather than a WorkerManager method
 * because the 'main' account is not in the registry and so has no WorkerProfile —
 * it is addressed by (label, configDir) alone, exactly like every worker.
 */
export function openReloginTerminal(label: string, configDir: string): vscode.Terminal {
  const cfg = vscode.workspace.getConfiguration('claudeCodeOrchestrator');
  const claudePath = cfg.get<string>('claudePath', 'claude');
  const terminal = vscode.window.createTerminal({
    name: `login: ${label}`,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });
  terminal.show();
  // The stored OAuth address pre-fills the login so the user re-authenticates the
  // account this directory already belongs to, not whichever one their browser is
  // signed into. sanitizeEmailForShell guarantees a shell-safe charset, so the
  // value needs no quoting; when it rejects the address the flag is dropped
  // entirely rather than an unvetted string reaching the command line.
  const email = sanitizeEmailForShell(readOauthEmail(configDir));
  terminal.sendText(`${quoteCommandPath(claudePath)} auth login${email ? ` --email ${email}` : ''}`);
  return terminal;
}
