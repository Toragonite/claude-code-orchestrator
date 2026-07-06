import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRegistry, writeRegistry, WorkerModel, WorkerProfile } from './registry';

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
    if (registry.workers.some((w) => w.name === name)) {
      throw new Error(`A worker named "${name}" already exists.`);
    }
    const dir = configDir ?? path.join(os.homedir(), `.claude-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const worker: WorkerProfile = { name, configDir: dir, model };
    registry.workers.push(worker);
    writeRegistry(registry);
    this._onDidChange.fire();
    return worker;
  }

  remove(name: string): void {
    const registry = readRegistry();
    registry.workers = registry.workers.filter((w) => w.name !== name);
    writeRegistry(registry);
    this._onDidChange.fire();
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
    const cfg = vscode.workspace.getConfiguration('fableOrchestrator');
    const registry = readRegistry();
    registry.permissionMode = cfg.get<string>('workerPermissionMode', 'acceptEdits');
    registry.claudePath = cfg.get<string>('claudePath', 'claude');
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
        const loggedIn =
          fs.existsSync(path.join(dir, '.credentials.json')) ||
          fs.existsSync(path.join(dir, '.claude.json'));
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
    const cfg = vscode.workspace.getConfiguration('fableOrchestrator');
    const claudePath = cfg.get<string>('claudePath', 'claude');
    const terminal = vscode.window.createTerminal({
      name: `claude: ${worker.name}`,
      env: { CLAUDE_CONFIG_DIR: worker.configDir },
    });
    terminal.show();
    if (initialPrompt) {
      const quoted = `"${initialPrompt.replace(/(["\\$`])/g, '\\$1')}"`;
      terminal.sendText(`${claudePath} ${quoted}`);
    } else {
      terminal.sendText(claudePath);
    }
    return terminal;
  }
}
