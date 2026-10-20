import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import {
  CODEX_KEYRING_CONFIG_LINE,
  configDirForName,
  dirUsedByClaudeCode,
  isFreshAccountHome,
  isPinnedClaudeModel,
  openRegistryFile,
  openReloginTerminal,
  providerHomeForName,
  registryIsUnreadable,
  removesSandbox,
  showStateWriteRefusal,
  suggestedWorkerName,
  updateRegistryIfChanged,
  WorkerManager,
  workerNameProblem,
  workerPermissionMode,
  writeCodexKeyringConfig,
} from './workerManager';
import {
  accountNotRegisteredAdvice,
  accountRowName,
  cancelTaskMeshAware,
  isAccountRow,
  isUnsupportedRow,
  isWorkersTreeRow,
  MeshCancelReport,
  noIcons,
  pickText,
  rowText,
  sessionWorkersStrandedByRemoval,
  setTeamTaskHooks,
  stopSession,
  TasksProvider,
  TrackedSessionWorker,
  WorkersProvider,
} from './views';
import { WorkerHistoryProvider } from './history-view';
import {
  pickSessionAction,
  registerTeamView,
  runSessionAction,
  sessionActionOf,
  sessionKeyOf,
  teamCommandHandlers,
} from './teamView';
import { TeamClient } from './teamClient';
import {
  claudeWorkers,
  clearOrchestrator,
  clearTaskLog,
  isStateWriteRefusal,
  isTaskFileId,
  LEGACY_ROOT_DIR,
  reapDeadTasks,
  readRegistry,
  readRegistryChecked,
  REGISTRY_FILE,
  resolveTaskFile,
  ROOT_DIR,
  runningTasks,
  sanitizeMeshHistoryLimit,
  sanitizeMeshMaxLive,
  sanitizeTeamNumberSetting,
  sanitizeTeamTurnTimeoutMinutes,
  WorkerProfile,
  workerProvider,
} from './registry';
import {
  clearStoppedWorkers,
  meshTaskAliveCheck,
  meshTaskRecovery,
  reapOrphanedMeshWorkers,
  sweepStaleIoArtifacts,
} from './mesh/reaper';
import { policyState, upsertPolicy, type PolicyState } from './prompts';
import { openDashboard, setDashboardLog, setDashboardSettingsSync } from './dashboard';
import {
  cachedProviderModels,
  claudeMenuOf,
  type ClaudeMenuModel,
  checkAllClaudeLoginsNow,
  clearProviderRunLoginFailure,
  computeLoginState,
  getCachedUsage,
  getCachedWorkerUsage,
  isLoginExpired,
  listAccounts,
  listProviderModels,
  LOGIN_CONFIRM_GAP_MS,
  LOGIN_LIVE_CHECK_TIMEOUT_MS,
  loginDiagnosticsLine,
  loginStateOf,
  ownCacheEntry,
  readUsageCache,
  type ProviderModelCatalog,
  refreshAllUsage,
  refreshAllUsageIfStale,
  refreshProviderUsage,
} from './usage';
import { KEEPALIVE_TICK_MS, runKeepaliveSweep } from './keepalive';
import { LitterReport, pruneAllSessionLitter } from './sessionLitter';
import { claudeModelLastRanAs, modelLastRanAs, rebuildTaskIndex, resolveAccount } from './uiModel';
import { TEAM_AGENT_FILE, TEAM_AGENT_MD, TEAM_AGENT_NAME, teamAgentState } from './teamAgent';
import {
  hostConfigDir,
  isFrontierModel,
  isLegacyTierId,
  MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
  normalizeModel,
  sameConfigDir,
  WORKER_MODELS,
} from './platform';
import {
  adapterAccountDir,
  allProviders,
  defaultProviderHome,
  isOwnModelFamily,
  normalizeProviderModel,
  ProviderId,
  ProviderInfo,
  providerInfo,
  providerModelHint,
} from './providers';
import { readTextSafe } from './safeFs';
import { UiAccountAction, UiSessionAction } from './uiTypes';
import { describeSync, openAssetManager, showAssetStateProblem } from './assetManager';
import { resolvePackSources } from './packSources';
import {
  CONFIG_SECTION,
  explicitUserSetting,
  LEGACY_CONFIG_SECTION,
  LEGACY_SETTING_KEYS,
  userSetting,
  workspaceLevelSettings,
} from './settings';
import {
  AssetPack,
  AssetStateUnreadableError,
  AssetType,
  assetStatus,
  readAssetState,
  relOwners,
  setAssetEnabled,
  sha256,
  syncWorkspace,
} from './assets';
// The server keys (MCP_SERVER_NAME; LEGACY_MCP_SERVER_NAME, the pre-rename key that is removed
// from .mcp.json when re-registering) are workspaceSetup's: one constant, not one per file.
import {
  allowItemStateOf,
  canDispatchFrom,
  ccoRules,
  type CcoRules,
  checkedByDefault,
  cliPathOf,
  isTrackedInGit,
  type JsonProblem,
  launcherPathOf,
  launcherPresent,
  launcherScript,
  LEGACY_MCP_SERVER_NAME,
  LOCAL_SETTINGS_FILE,
  lookUpSettingsRoot,
  MCP_SERVER_NAME,
  mcpItemStateOf,
  mcpJsonRegistersDispatch,
  offeredSetupItems,
  runSetupPlan,
  type SettingsRoot,
  type SetupItemId,
  type SetupItemStates,
  type SetupPlanSteps,
  type StepOutcome,
  withCcoRules,
  withoutEnabledMcpServers,
  withoutMcpServers,
} from './workspaceSetup';

/** Directory of the bundled entry points (`npm run bundle-server`), inside this extension. */
const BUNDLE_DIR = path.join('out', 'mcp');

/**
 * The provider helper: `node provider-cli.js status <provider> <configDir> [--quota]` for an
 * account's login and usage, `… models <provider> <configDir>` for the models its CLI offers.
 */
const PROVIDER_HELPER = 'provider-cli.js';

/**
 * Bundled entry points that are started FROM the dispatch server's own directory and so must
 * sit beside whichever copy of the server is running: the detach supervisor (the server spawns
 * `<its dir>/run-task.js`), the provider status helper, and the `cco` client — the launcher
 * runs `<data root>/mcp/cli.js`, which finds the server it starts the dispatch host from as
 * `server.js` beside itself (§15.1). Each is one self-contained file.
 */
const SERVER_COMPANIONS = ['run-task.js', PROVIDER_HELPER, 'cli.js'] as const;

/**
 * The largest bundled entry point this extension copies. The server bundle is about 700 KiB
 * and its companions are smaller; a file past this at one of their names is not one of them.
 */
const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The longest path a picker row shows. A path is shown whole — two directories that share a
 * long prefix must not look alike — so the bound is only for a value no file system holds
 * (a macOS path is at most 1,024 bytes).
 */
const PICK_PATH_MAX = 1024;

/** Is a REAL directory at `dir` (`lstat`: the thing itself, not a symbolic link to one)? */
function isOwnDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Make `dir` a directory this extension may put files in, or say why it is not one. Created
 * (with its missing parents) readable by the owner only; one that already exists keeps the
 * mode it has. A symbolic link at `dir` is refused: a file placed "in it" would land in
 * whatever directory the link names. Returns undefined when the directory is there.
 */
function ownDirectory(dir: string): string | undefined {
  let failed: string | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    failed = failureText(err);
  }
  if (isOwnDirectory(dir)) {
    return undefined;
  }
  return failed === undefined
    ? 'its directory is a symbolic link, and nothing is written through one'
    : `its directory could not be created (${failed})`;
}

/**
 * Make the file at `target` hold exactly `text` by REPLACING THE NAME, and say what happened:
 * `'written'`, `'unchanged'`, or the reason nothing could be done.
 *
 * `target` is a fixed name this extension writes on every activation, in a directory any
 * process of the user can reach. It is therefore never OPENED: opening a FIFO put at the name
 * would wait for a reader for ever, on the extension host's own thread, and opening a symbolic
 * link would write through it into whatever file it names. The text goes into a new file
 * beside the target (writeFileAtomic) and that file takes the name — which replaces a link, a
 * pipe or a socket found there without touching it. A DIRECTORY at the name is not replaced:
 * that is the refusal.
 *
 * Nothing is written when the name already holds a regular file with these bytes (asked with
 * `lstat`, then compared through a bounded read that follows no link and cannot block), so
 * an activation that changes nothing writes nothing. A comparison that could not be made
 * counts as "differs".
 */
function placeFile(target: string, text: string): 'written' | 'unchanged' | { refused: string } {
  let found: fs.Stats | undefined;
  try {
    found = fs.lstatSync(target);
  } catch {
    // nothing there, or nothing that can be examined: the write below says which
  }
  if (found?.isDirectory()) {
    return { refused: 'a directory is at that name' };
  }
  if (found?.isFile() && found.size === Buffer.byteLength(text, 'utf8')) {
    const held = readTextSafe(target, BUNDLE_MAX_BYTES, { noFollow: true });
    if (held.ok && held.text === text) {
      return 'unchanged';
    }
  }
  const failed = writeFileAtomic(target, text, 'name');
  return failed === undefined ? 'written' : { refused: failed };
}

/** The bundled entry point at `file` as text, or why it cannot be copied. */
function readBundled(file: string): { ok: true; text: string } | { ok: false; detail: string } {
  const read = readTextSafe(file, BUNDLE_MAX_BYTES);
  if (!read.ok) {
    return { ok: false, detail: read.detail };
  }
  // A copy made from text is the same file only when the text is all of it: a byte sequence
  // that is not UTF-8 decodes to something that encodes back differently.
  return Buffer.byteLength(read.text, 'utf8') === read.bytes
    ? { ok: true, text: read.text }
    : { ok: false, detail: 'the bundled file is not UTF-8 text' };
}

/** Where the stable copy of the dispatch server stands after ensureStableServerCopy. */
type StableServer =
  /** `path` holds this version's server. */
  | { ok: true; path: string }
  /** `path` does NOT hold this version's server, and `problem` says why it could not be put there. */
  | { ok: false; path: string; problem: string };

/**
 * Copy the bundled MCP server to a version-independent path. Installed
 * extensions live in a per-version directory, so registering the bundled path
 * in .mcp.json would break on every extension update; the stable copy under
 * ~/.claude-code-orchestrator survives updates and is refreshed on each activation.
 *
 * Each of the fixed names involved — the server, its companions, the forwarding file of the
 * pre-rename directory — is written by replacing the name (placeFile), and only when it does
 * not already hold the right bytes. A name that could not be given its file is ONE line in
 * `log`, and nothing here throws: activation goes on. The answer says whether the stable path
 * now holds this version's server; when it does not, nothing may be registered at it.
 *
 * The server's companions travel with it. A companion that cannot be copied is REMOVED from
 * the stable directory rather than left as it was: what would be left is the file of an
 * earlier version, and a supervisor or helper that is not the one this server was built with
 * misbehaves quietly, where a missing one fails with a message that says so.
 */
function ensureStableServerCopy(context: vscode.ExtensionContext, log: (line: string) => void): StableServer {
  const bundledDir = context.asAbsolutePath(BUNDLE_DIR);
  const stableDir = path.join(ROOT_DIR, 'mcp');
  const stable = path.join(stableDir, 'server.js');
  const refused = (file: string, why: string): string => {
    const line = `[mcp server] ${file} was not written: ${why}.`;
    log(line);
    return why;
  };
  const dirProblem = ownDirectory(stableDir);
  if (dirProblem !== undefined) {
    return { ok: false, path: stable, problem: refused(stable, dirProblem) };
  }
  const server = readBundled(path.join(bundledDir, 'server.js'));
  if (!server.ok) {
    return { ok: false, path: stable, problem: refused(stable, `the bundled server could not be read (${server.detail})`) };
  }
  const placed = placeFile(stable, server.text);
  if (typeof placed !== 'string') {
    return { ok: false, path: stable, problem: refused(stable, placed.refused) };
  }
  for (const file of SERVER_COMPANIONS) {
    const target = path.join(stableDir, file);
    const bundled = readBundled(path.join(bundledDir, file));
    const result = bundled.ok ? placeFile(target, bundled.text) : { refused: `the bundled file could not be read (${bundled.detail})` };
    if (typeof result !== 'string') {
      refused(target, result.refused);
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // nothing more to do: the server reports a companion it cannot start
      }
    }
  }
  ensureLegacyServerShim(stable, log);
  return { ok: true, path: stable };
}

/**
 * Workspaces registered before the data-directory rename point their
 * .mcp.json at the old stable path. Keep a one-line forwarding shim there so
 * those registrations keep working without a re-register.
 *
 * Written like every other fixed name (placeFile). The old directory is created readable by
 * the owner only when this version is the one creating it. When it leads to the directory
 * the stable copy itself is in — somebody linked the old name to the new one — nothing is
 * written: the old path already reaches the server, and a forwarding file there would
 * replace the server with a file that requires itself.
 */
function ensureLegacyServerShim(stable: string, log: (line: string) => void): void {
  const legacyDir = path.join(LEGACY_ROOT_DIR, 'mcp');
  const legacy = path.join(legacyDir, 'server.js');
  let why: string | undefined;
  try {
    why = ownDirectory(legacyDir);
    if (why === undefined) {
      if (fs.realpathSync(legacyDir) === fs.realpathSync(path.dirname(stable))) {
        return;
      }
      const placed = placeFile(legacy, `require(${JSON.stringify(stable)});\n`);
      why = typeof placed === 'string' ? undefined : placed.refused;
    }
  } catch (err) {
    why = failureText(err);
  }
  if (why !== undefined) {
    // Compatibility only: a workspace still registered at the old path has to register again.
    log(`[mcp server] ${legacy} (the forwarding file for registrations made before the rename) was not written: ${why}.`);
  }
}

/**
 * Open flags for a file this extension already placed and now only gives a mode: read-only,
 * and — where the platform has the flags — following no symbolic link at the name and waiting
 * on nothing. (Each is tested for: a constant the platform lacks would make the set NaN.)
 */
const PLACED_FILE_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * Give the regular file at `file` mode 0755, unless it has that mode already. The mode is set on
 * a DESCRIPTOR, after fstat said what it is: the name is opened without following a link and
 * without blocking, so a link or a pipe put at the name after the write is refused — never the
 * thing that gets the mode. Returns undefined on success, else why not. Never throws.
 */
function makeExecutable(file: string): string | undefined {
  let fd = -1;
  try {
    fd = fs.openSync(file, PLACED_FILE_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return 'it is not a regular file';
    }
    if ((stat.mode & 0o7777) !== 0o755) {
      fs.fchmodSync(fd, 0o755);
    }
    return undefined;
  } catch (err) {
    return failureText(err);
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing was written through it; there is nothing to lose
      }
    }
  }
}

/**
 * Put the `cco` launcher (§15.8) at `<data root>/bin/cco` — the one file every installed text
 * names (host-protocol COMMAND_SPELLING): a POSIX shell script that runs the stable copy of the
 * client (`<data root>/mcp/cli.js`, a SERVER_COMPANION) with `nodeCommand`. Its text is
 * workspaceSetup.launcherScript's. Not on win32, where cco does not run in this version.
 *
 * Written as every fixed name of this extension is (placeFile: by replacing the name, and only
 * when its bytes differ), in a `bin/` made by ownDirectory, then given mode 0755
 * (makeExecutable). A launcher that could not be written, or not made executable, is ONE line in
 * `log`; nothing here throws. Returns undefined once the launcher holds this text and can be
 * run, else why it cannot.
 *
 * Called at activation with `node`, and again once resolveNodeCommand answers — from then on the
 * launcher names the node the login shell found — and by Update Workspace Setup, which may be
 * run precisely because the launcher is missing.
 */
function ensureCcoLauncher(nodeCommand: string, log: (line: string) => void): string | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const target = launcherPathOf(ROOT_DIR);
  const dirProblem = ownDirectory(path.dirname(target));
  if (dirProblem !== undefined) {
    log(`[cco] ${target} was not written: ${dirProblem}.`);
    return dirProblem;
  }
  const placed = placeFile(target, launcherScript(nodeCommand, cliPathOf(ROOT_DIR)));
  if (typeof placed !== 'string') {
    log(`[cco] ${target} was not written: ${placed.refused}.`);
    return placed.refused;
  }
  const modeProblem = makeExecutable(target);
  if (modeProblem !== undefined) {
    log(`[cco] ${target} could not be made executable (mode 0755): ${modeProblem}.`);
  }
  return modeProblem;
}

let cachedNodeCommand: string | undefined;

/**
 * Absolute path to the node binary. The MCP server is spawned by the Claude
 * Code CLI, which on macOS/Linux may not inherit the user's shell PATH (nvm,
 * homebrew) — a bare "node" command then fails the server's health check.
 * Resolve through the user's login shell; fall back to "node".
 *
 * Asked without waiting: the login shell runs as a child process and its answer arrives as
 * a promise, so a profile that takes seconds does not hold the extension host. Never rejects.
 */
function resolveNodeCommand(): Promise<string> {
  if (cachedNodeCommand) {
    return Promise.resolve(cachedNodeCommand);
  }
  if (process.platform === 'win32') {
    cachedNodeCommand = 'node';
    return Promise.resolve(cachedNodeCommand);
  }
  return new Promise((resolve) => {
    const finish = (found: string | undefined): void => {
      // Only an answer is remembered: a lookup that failed is made again the next time.
      if (found !== undefined) {
        cachedNodeCommand = found;
      }
      resolve(found ?? 'node');
    };
    try {
      const shell = process.env.SHELL || '/bin/sh';
      const child = execFile(
        shell,
        ['-lc', 'command -v node'],
        { encoding: 'utf8', timeout: 10_000 },
        (err, stdout) => {
          let out: string | undefined;
          try {
            out = err ? undefined : String(stdout).trim().split('\n').pop();
          } catch {
            out = undefined;
          }
          finish(out && fs.existsSync(out) ? out : undefined);
        },
      );
      // The profile gets end-of-file on its stdin; an error on that stream must not be thrown.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end();
    } catch {
      finish(undefined);
    }
  });
}

/* ------------------------------------------------------------------------- *
 * Workspace files this extension adds to — never rewritten unless understood
 * ------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The errno code of a caught value when it looks like one, else its message. */
function failureText(err: unknown): string {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
    return code;
  }
  return rowText(err instanceof Error ? err.message : String(err), 200);
}

/**
 * Open flags of the new file writeFileAtomic writes beside its target: created EXCLUSIVELY, so
 * the open fails when anything at all already has the name — a file, a pipe, a symbolic link
 * (which an exclusive create does not follow) — rather than writing to it or through it. The
 * no-follow and non-blocking flags say the same thing a second time where the platform has
 * them: this open follows nothing and cannot wait on anything. (Each is tested for, because a
 * constant the platform lacks would turn the whole set into NaN.)
 */
const NEW_FILE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * Put `text` at `file` in one step, or change nothing. The text is written to a new file
 * beside the target (created exclusively, so nothing that already sits at that name is
 * written through), and that file then takes the target's name — the target itself is never
 * opened:
 *
 *  - `replacing` undefined — the caller found NOTHING at `file`: the new file is linked into
 *    place, which fails if something has appeared there since, instead of covering it;
 *  - `replacing` = the `lstat` the caller took when it read the file: the target must still be
 *    that same regular file (same inode, size and modification time), else nothing is written.
 *    The rename then replaces the NAME — a symbolic link put at the path in between is
 *    replaced, never followed;
 *  - `replacing` = `'name'` — the name is this extension's own, in a directory of its own,
 *    and whatever is at it is to be replaced: a file, a symbolic link, a pipe. The new file
 *    is readable by the owner only. A directory at the name is not replaced (the rename
 *    fails, and that is the answer).
 *
 * A reader never sees half a file, and a failure leaves the previous content whole. Returns
 * undefined on success, `'changed'` when the target is no longer what the caller read, else
 * the reason of the failure. Never throws.
 */
function writeFileAtomic(
  file: string,
  text: string,
  replacing: fs.Stats | undefined | 'name',
): string | undefined {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let created = false;
  try {
    const mode = replacing === 'name' ? 0o600 : replacing !== undefined ? replacing.mode & 0o777 : 0o666;
    const fd = fs.openSync(tmp, NEW_FILE_FLAGS, mode);
    created = true;
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    if (replacing === 'name') {
      // Nothing to compare with: the rename below takes the name from whatever holds it.
    } else if (replacing === undefined) {
      try {
        fs.linkSync(tmp, file);
        // In place under its own name; the temp name is removed on the way out.
        return undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
          return 'changed';
        }
        // A filesystem without hard links: fall back to a rename, after one more look.
        let present = true;
        try {
          fs.lstatSync(file);
        } catch {
          present = false;
        }
        if (present) {
          return 'changed';
        }
      }
    } else {
      const now = fs.lstatSync(file);
      if (!now.isFile() || now.ino !== replacing.ino || now.size !== replacing.size || now.mtimeMs !== replacing.mtimeMs) {
        return 'changed';
      }
    }
    fs.renameSync(tmp, file);
    created = false;
    return undefined;
  } catch (err) {
    return failureText(err);
  } finally {
    if (created) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // the temp file is ours and harmless; the caller reports the real failure
      }
    }
  }
}

/**
 * Does the directory `dir` — or, while it does not exist yet, the nearest ancestor that does —
 * lie inside the workspace folder `root` once symbolic links are followed? A `.claude` that is
 * a link to a directory elsewhere would take a file written "into the workspace" somewhere this
 * extension was never pointed at. Anything that cannot be resolved is not inside.
 */
function staysInsideFolder(root: string, dir: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    let at = dir;
    for (;;) {
      let present = true;
      try {
        fs.lstatSync(at);
      } catch {
        present = false;
      }
      if (present) {
        const real = fs.realpathSync(at);
        return real === realRoot || real.startsWith(realRoot + path.sep);
      }
      const parent = path.dirname(at);
      if (parent === at) {
        return false;
      }
      at = parent;
    }
  } catch {
    return false;
  }
}

/** Offer to open the workspace file an error message was about. */
function showFileProblem(message: string, file: string): void {
  const openLabel = vscode.l10n.t('Open File');
  void vscode.window.showErrorMessage(message, openLabel).then(
    async (choice) => {
      if (choice === openLabel) {
        try {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
        } catch {
          // not something an editor can open (a directory, a file that is gone)
        }
      }
    },
    () => undefined,
  );
}

/* ------------------------------------------------------------------------- *
 * Failures of a command — said, never thrown
 * ------------------------------------------------------------------------- */

/**
 * Say why something the user asked for did not happen.
 *
 * A REFUSAL of the shared state — the registry's lock stayed held, or a state file could not
 * be read (`isStateWriteRefusal`) — is shown as a warning in the registry's own words, with the
 * file to open while the registry is the one that cannot be read (`showStateWriteRefusal`):
 * that sentence already says what happened, that nothing was changed and what to do. Any other
 * failure is an error; `sentence` puts the caller's own words around its message.
 */
function showActionFailure(err: unknown, sentence?: (message: string) => string): void {
  if (showStateWriteRefusal(err)) {
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(sentence ? sentence(message) : message);
}

/**
 * Register a command whose handler can neither throw nor reject. Every command of this
 * extension goes through here: a command is run by a click, a key binding, a webview message
 * or another extension, and nothing on that side catches. A failure the handler did not deal
 * with closer to its cause ends here — said (`showActionFailure`) — and the command resolves to
 * undefined.
 */
function guardedCommand(id: string, run: (...args: unknown[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: unknown[]): Promise<unknown> => {
    try {
      return await run(...args);
    } catch (err) {
      try {
        showActionFailure(err);
      } catch {
        // a failure that cannot even be shown still must not leave the command
      }
      return undefined;
    }
  });
}

/**
 * The task a command was asked about: a task id, or an object that carries one as `id` (a
 * row of a task tree — whose `id` is the index's own, shape-checked — or the dashboard's
 * `{ id }`). Anything else names no task — in particular a PATH, which is what these commands
 * took before 2.0 and what an old key binding may still pass, and a row of the Workers tree:
 * that is a registry entry as read, and an `id` key on it is whatever its file holds.
 */
function taskIdOf(arg: unknown): string | undefined {
  if (isWorkersTreeRow(arg)) {
    return undefined;
  }
  const id: unknown = typeof arg === 'object' && arg !== null ? (arg as { id?: unknown }).id : arg;
  return isTaskFileId(id) ? id : undefined;
}

/**
 * Open the report of the task `arg` names, in the active editor group or beside it.
 *
 * The file is found from the task's ID alone (`resolveTaskFile`: the report's own name in the
 * tasks directory, and only a regular file — a link there is refused). No path is ever taken
 * from the caller or from the task log, so nothing a row, a page or a log line says can make
 * this open another file. An argument that is not a task id, and a task that has no report,
 * open nothing and are said.
 */
async function openTaskReport(arg: unknown, beside: boolean): Promise<void> {
  const id = taskIdOf(arg);
  const file = id === undefined ? undefined : resolveTaskFile(id, 'output');
  if (file === undefined) {
    void vscode.window.showWarningMessage(vscode.l10n.t('The output of that task could not be found.'));
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(
      doc,
      beside ? { preview: true, viewColumn: vscode.ViewColumn.Beside } : { preview: true },
    );
  } catch {
    void vscode.window.showWarningMessage(vscode.l10n.t('The task output could not be opened.'));
  }
}

/** `.mcp.json` lists a handful of servers; far past this it is not read, and not rewritten. */
const MCP_JSON_MAX_BYTES = 1024 * 1024;

type McpJsonRead =
  | {
      ok: true;
      /** The file's content; `{}` when there is no file, or nothing in it. */
      json: Record<string, unknown>;
      /** The file's text as it was read; undefined when there is no file. */
      text: string | undefined;
      /** The `lstat` of the file that was read; undefined when there is no file. */
      stat: fs.Stats | undefined;
    }
  | { ok: false; message: string };

/**
 * Read a workspace's `.mcp.json` for the purpose of adding to it.
 *
 * The file is the user's: it holds THEIR servers, and registering ours rewrites the whole of
 * it. So it is `ok` only when there is no file, or when the file is a regular file (not a
 * link, at most 1 MiB) whose text — one leading byte-order mark ignored — parses as JSON to an
 * object in which `mcpServers`, when present, is an object too. A file that holds NOTHING —
 * no characters, or only white space — is read as `{}` as well: there is nothing in it that a
 * rewrite could lose, and it is what an editor leaves behind when a new file is saved before
 * anything is typed. Everything else is refused with a sentence that names the file and says
 * why: a comment, a trailing comma, merge-conflict markers, `[]`, `null`. A file that holds
 * something and was not understood is never treated as an empty one.
 */
function readMcpJson(file: string): McpJsonRead {
  const refuse = (message: string): McpJsonRead => ({ ok: false, message });
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return refuse(
        vscode.l10n.t('The MCP server was not registered: {0} could not be read ({1}). Nothing was changed.', file, failureText(err)),
      );
    }
  }
  if (stat === undefined) {
    return { ok: true, json: {}, text: undefined, stat: undefined };
  }
  if (stat.isSymbolicLink()) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: {0} is a symbolic link, and this extension does not write through one. Nothing was changed.',
        file,
      ),
    );
  }
  if (!stat.isFile()) {
    return refuse(
      vscode.l10n.t('The MCP server was not registered: {0} is not a regular file. Nothing was changed.', file),
    );
  }
  if (stat.size > MCP_JSON_MAX_BYTES) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: {0} is larger than 1 MiB, which is more than this extension reads. Nothing was changed.',
        file,
      ),
    );
  }
  if (!ownerCanWrite(stat)) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: {0} is read-only (its owner has no write permission), and this extension does not replace a file its owner cannot write. Nothing was changed.',
        file,
      ),
    );
  }
  // The file is written back from what is read here, so the read has to be lossless: bytes
  // that are not UTF-8 would come back as replacement characters in the user's own values.
  const read = readTextSafe(file, MCP_JSON_MAX_BYTES, { strictUtf8: true });
  if (!read.ok) {
    return refuse(
      read.reason === 'not-utf8'
        ? vscode.l10n.t(
            'The MCP server was not registered: {0} is not valid UTF-8 text, and a file that cannot be read and written back byte for byte is not rewritten. Nothing was changed.',
            file,
          )
        : vscode.l10n.t('The MCP server was not registered: {0} could not be read ({1}). Nothing was changed.', file, read.detail),
    );
  }
  const body = read.text.replace(/^\uFEFF/, '');
  if (body.trim() === '') {
    // Still the file that was read: the write replaces it only while it is unchanged.
    return { ok: true, json: {}, text: read.text, stat };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: {0} is not valid JSON ({1}). Nothing was changed — correct the file, then register again.',
        file,
        rowText(err instanceof Error ? err.message : String(err), 200),
      ),
    );
  }
  if (!isPlainObject(parsed)) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: {0} does not hold a JSON object. Nothing was changed — correct the file, then register again.',
        file,
      ),
    );
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers') && !isPlainObject(parsed.mcpServers)) {
    return refuse(
      vscode.l10n.t(
        'The MCP server was not registered: "mcpServers" in {0} is not a JSON object. Nothing was changed — correct the file, then register again.',
        file,
      ),
    );
  }
  return { ok: true, json: parsed, text: read.text, stat };
}

/**
 * Is the dispatch server registered in this workspace? A question only — nothing is written on
 * its answer — so the file is read wherever it lives (a `.mcp.json` that is a link is followed),
 * and one that is absent or cannot be understood simply answers no. The answer is
 * workspaceSetup.mcpJsonRegistersDispatch's — the reading item 4 and the dashboard use too
 * (either name, value a JSON object) — so the nag, the chip and the list never disagree.
 */
function mcpRegisteredIn(folder: vscode.WorkspaceFolder): boolean {
  const read = readTextSafe(path.join(folder.uri.fsPath, '.mcp.json'), MCP_JSON_MAX_BYTES);
  return read.ok && mcpJsonRegistersDispatch(read.text);
}

/**
 * Add the dispatch server to the workspace's `.mcp.json` (creating the file when there is
 * none), and say whether that happened. Every other key of the file and every other server
 * keeps its value; the pre-rename server key is removed. Returns undefined once the file is
 * written — only then may anything say "registered" — and otherwise the sentence to show,
 * after which the file is exactly as it was.
 *
 * `nodeCommand` is resolveNodeCommand's answer. The caller awaits it BEFORE calling this, so
 * that nothing waits between this function's read of the file and its write.
 */
function registerMcp(folder: vscode.WorkspaceFolder, serverPath: string, nodeCommand: string): string | undefined {
  const mcpFile = path.join(folder.uri.fsPath, '.mcp.json');
  const read = readMcpJson(mcpFile);
  if (!read.ok) {
    return read.message;
  }
  const servers: Record<string, unknown> = {
    ...(isPlainObject(read.json.mcpServers) ? read.json.mcpServers : {}),
    [MCP_SERVER_NAME]: { command: nodeCommand, args: [serverPath] },
  };
  delete servers[LEGACY_MCP_SERVER_NAME];
  const next = JSON.stringify({ ...read.json, mcpServers: servers }, null, 2) + '\n';
  if (next === read.text) {
    // Already says exactly this: registered, and there is nothing to write.
    return undefined;
  }
  const failed = writeFileAtomic(mcpFile, next, read.stat);
  if (failed === undefined) {
    return undefined;
  }
  return failed === 'changed'
    ? vscode.l10n.t(
        'The MCP server was not registered: {0} changed while it was being updated. Nothing was written — run the command again.',
        mcpFile,
      )
    : vscode.l10n.t(
        'The MCP server was not registered: {0} could not be written ({1}). The file is as it was.',
        mcpFile,
        failed,
      );
}

/** `CLAUDE.md` is read up to this size; a larger one is not rewritten. */
const POLICY_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * May the owner of the file `stat` describes write it? A file without the owner's write bit
 * is one its owner marked "do not change"; replacing it by name would go around that mark (a
 * rename needs only the directory), so the installers below refuse it. Mode bits are what the
 * platform reports — on win32, the read-only attribute.
 */
function ownerCanWrite(stat: fs.Stats): boolean {
  return (stat.mode & 0o200) !== 0;
}

/**
 * THE POLICY INSTALLER: look, ask, write — and nothing reaches CLAUDE.md except through
 * `installDispatchPolicy`, which does the three in that order.
 *
 * The file is rewritten whole, so it is rewritten only after it was READ, and read LOSSLESSLY:
 * "no file" is the one case that starts from nothing; a file that could not be read (no
 * permission, too large, not a regular file, a failing disk), one whose bytes are not valid
 * UTF-8 (a Latin-1, EUC-KR or UTF-16 document — its text would be written back as another
 * file), and one its owner cannot write are left alone, byte for byte. A CLAUDE.md that is a
 * link to another file of the same workspace is written through, as an editor would — the
 * file the link names gets the new text, and the link stays; one that leads outside the
 * workspace folder is not.
 *
 * The file is replaced in one step (writeFileAtomic), and only while it is still the file that
 * was read: it is never opened for writing, so a pipe or a link put at the name after the
 * read is neither waited on nor written through, and a file that changed in between is not
 * covered. Replacing by name has two stated limits: another hard link to the old file keeps
 * the old text, and extended attributes of the old file are not carried over.
 */

/**
 * What the workspace's CLAUDE.md holds, as the policy installer found it: the file that would
 * be replaced (`target` — CLAUDE.md itself, or what a link at its name leads to inside the
 * folder), its text (`''` for a file that is not there), what was at the target before it was
 * read, and what the text holds of the policy block (prompts.policyState). Or `problem`: the
 * sentence for a file that must not be rewritten — one that could not be read losslessly, one
 * its owner cannot write, or a link that leads out of the folder.
 */
type PolicyLook =
  | { ok: false; problem: string }
  | { ok: true; state: PolicyState; file: string; target: string; text: string; stat: fs.Stats | undefined };

function lookAtDispatchPolicy(folder: vscode.WorkspaceFolder): PolicyLook {
  const file = path.join(folder.uri.fsPath, 'CLAUDE.md');
  let linked = false;
  try {
    linked = fs.lstatSync(file).isSymbolicLink();
  } catch {
    // nothing there, or nothing that can be examined: the read below says which
  }
  // The file that is read and replaced: CLAUDE.md itself, or what a link at its name leads to.
  let target = file;
  if (linked) {
    let inside = false;
    try {
      target = fs.realpathSync(file);
      inside = staysInsideFolder(folder.uri.fsPath, target);
    } catch {
      inside = false;
    }
    if (!inside) {
      return {
        ok: false,
        problem: vscode.l10n.t(
          'The dispatch policy was not written: {0} is a symbolic link that leads outside this workspace folder, or nowhere. Nothing was changed.',
          file,
        ),
      };
    }
  }
  // What is at the target BEFORE it is read: the write goes through only while this still holds.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch {
    // nothing there, or nothing that can be examined: the read below says which
  }
  if (stat !== undefined && stat.isFile() && !ownerCanWrite(stat)) {
    return {
      ok: false,
      problem: vscode.l10n.t(
        'The dispatch policy was not written: {0} is read-only (its owner has no write permission), and this extension does not replace a file its owner cannot write. Nothing was changed.',
        file,
      ),
    };
  }
  const read = readTextSafe(target, POLICY_FILE_MAX_BYTES, { noFollow: true, strictUtf8: true });
  if (!read.ok && read.reason === 'not-utf8') {
    return {
      ok: false,
      problem: vscode.l10n.t(
        'The dispatch policy was not written: {0} is not valid UTF-8 text, and a file that cannot be read and written back byte for byte is not rewritten. Nothing was changed.',
        file,
      ),
    };
  }
  if (!read.ok && read.reason !== 'absent') {
    return {
      ok: false,
      problem: vscode.l10n.t(
        'The dispatch policy was not written: {0} could not be read ({1}), and a file that was not read is not rewritten. Nothing was changed.',
        file,
        read.detail,
      ),
    };
  }
  const text = read.ok ? read.text : '';
  return { ok: true, state: policyState(text), file, target, text, stat: read.ok ? stat : undefined };
}

/**
 * Put this version's policy block into the file `look` describes — in one step, and only while
 * the file is still what `look` read: one that changed since (while a question was open, say)
 * is not covered. Returns undefined once written, otherwise the sentence to show.
 */
function writeDispatchPolicyOver(look: PolicyLook & { ok: true }): string | undefined {
  const failed = writeFileAtomic(look.target, upsertPolicy(look.text), look.stat);
  if (failed === undefined) {
    return undefined;
  }
  return failed === 'changed'
    ? vscode.l10n.t(
        'The dispatch policy was not written: {0} changed while it was being updated. Nothing was written — run the command again.',
        look.file,
      )
    : vscode.l10n.t('The dispatch policy was not written: {0} could not be written ({1}).', look.file, failed);
}

/**
 * What one run of the installer came to: `written` (there was no block), `replaced` (a block
 * that differed, after the user said so), `current` (this version's block is there — nothing
 * was written), `declined` (a block that differs, and the user did not say "Replace"), or
 * `refused` with the sentence to show (nothing was changed).
 */
type PolicyInstall =
  | { outcome: 'written' | 'replaced' | 'current' | 'declined' }
  | { outcome: 'refused'; problem: string };

/**
 * The ONE writer of the policy block. Every path that ends in CLAUDE.md being written — the
 * command, the dashboard's button, the offer after "Register MCP Server" — comes through
 * here, and here the file is LOOKED AT FIRST, each time:
 *
 *  - no block: it is added;
 *  - this version's block: nothing is written;
 *  - anything else that carries the policy's markers (another version's block, an edited one,
 *    more than one, a marker with no block): a modal asks, and only its "Replace" — an answer
 *    given AFTER this look — lets the block be replaced. The write then goes through only
 *    while the file is still what this look read.
 *
 * So an answer given to some earlier question (a notification that stood open while the file
 * changed) never replaces a block nobody was asked about.
 *
 * Once it HAS written this version's block, it starts offerAllowCcoAfterPolicy (§15.12 M2) and
 * does not wait for it: the block teaches the session the cco command, and without item 3's
 * rules every cco call prompts — or, in Claude Code's sandbox, fails — while "this folder can
 * dispatch" is already true, so no nag or chip would ever point at the fix. Started here, the
 * one writer, so every path that ends in a written block gets it: the command, the dashboard and
 * onboarding buttons (which run the command), and the offers after "Register MCP Server".
 */
async function installDispatchPolicy(folder: vscode.WorkspaceFolder): Promise<PolicyInstall> {
  const look = lookAtDispatchPolicy(folder);
  if (!look.ok) {
    return { outcome: 'refused', problem: look.problem };
  }
  if (look.state === 'current') {
    return { outcome: 'current' };
  }
  if (look.state === 'differs') {
    const replaceLabel = vscode.l10n.t('Replace');
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "The dispatch policy in {0} is from another version of the extension or was edited. Replacing it discards those differences. Only the text between the policy's markers is replaced; the rest of the file is left as it is.",
        'CLAUDE.md',
      ),
      { modal: true },
      replaceLabel,
    );
    if (confirm !== replaceLabel) {
      return { outcome: 'declined' };
    }
  }
  const problem = writeDispatchPolicyOver(look);
  if (problem !== undefined) {
    return { outcome: 'refused', problem };
  }
  // Not awaited: the caller says "written" now; the offer comes once git has answered, if at all.
  void offerAllowCcoAfterPolicy(folder).catch(() => undefined);
  return { outcome: look.state === 'differs' ? 'replaced' : 'written' };
}

/** What is said once the installer has replaced a block that differed. */
function policyReplacedMessage(): string {
  return vscode.l10n.t('Dispatch policy written to CLAUDE.md — the policy block that was there was replaced.');
}

async function offerDispatchPolicy(folder: vscode.WorkspaceFolder): Promise<void> {
  const file = path.join(folder.uri.fsPath, 'CLAUDE.md');
  // Offered only where the installer would add a block: a CLAUDE.md with none (or no file),
  // that it could rewrite. What it would refuse, and a block of any kind, is not offered.
  const first = lookAtDispatchPolicy(folder);
  if (!first.ok || first.state !== 'absent') {
    return;
  }
  const addLabel = vscode.l10n.t('Add to CLAUDE.md');
  const skipLabel = vscode.l10n.t('Skip');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Add the dispatch policy to this workspace\'s CLAUDE.md? It tells the main session to delegate all implementation to workers (it only designs, integrates, and verifies), batch subtasks in parallel, and write per-task system prompts.',
    ),
    addLabel,
    skipLabel,
  );
  if (choice === addLabel) {
    // The notification may have stood for any length of time. The answer to it is an answer
    // about the file as it was THEN; the installer looks again, and asks its own question
    // about a block the file has gained since.
    const done = await installDispatchPolicy(folder);
    if (done.outcome === 'refused') {
      showFileProblem(done.problem, file);
    } else if (done.outcome === 'replaced') {
      vscode.window.showInformationMessage(policyReplacedMessage());
    }
  }
}

/**
 * What "Register MCP Server" says when the stable copy of the server is not in place: the
 * path that would be registered does not hold the server, so nothing is registered at it.
 */
function stableServerProblemMessage(server: { path: string; problem: string }): string {
  return vscode.l10n.t(
    'The MCP server was not registered: its copy at {0} could not be written ({1}), so that path does not hold the server. Nothing was changed. Remove what is in the way, then run "Register MCP Server" again.',
    server.path,
    server.problem,
  );
}

/**
 * Register the dispatch server in `folder` for a user who asked for it, and say whether that
 * happened: undefined once `.mcp.json` is written, otherwise the sentence to show and the
 * file it is about (`.mcp.json`, or nothing when the stable copy is the problem).
 *
 * The stable copy is asked for HERE, at the moment of the request: only a path that holds
 * this version's server is ever written into a workspace, and a copy that could not be made
 * at activation is tried again now that the user may have removed what was in the way.
 */
async function registerMcpFor(
  folder: vscode.WorkspaceFolder,
  stableServer: () => StableServer,
): Promise<{ message: string; file: string | undefined } | undefined> {
  const server = stableServer();
  if (!server.ok) {
    return { message: stableServerProblemMessage(server), file: undefined };
  }
  // Before the file is read: the answer can take a login shell's time to come.
  const nodeCommand = await resolveNodeCommand();
  const problem = registerMcp(folder, server.path, nodeCommand);
  return problem === undefined
    ? undefined
    : { message: problem, file: path.join(folder.uri.fsPath, '.mcp.json') };
}

/** Show why a registration did not happen, with the file to open when it is about one. */
function showRegistrationProblem(problem: { message: string; file: string | undefined }): void {
  if (problem.file !== undefined) {
    showFileProblem(problem.message, problem.file);
  } else {
    void vscode.window.showErrorMessage(problem.message);
  }
}

/**
 * "This folder can dispatch" (§15.7, Nags), as the files say it NOW: the cco launcher is in
 * place and the folder's policy block is this version's — the text that teaches the session the
 * command — or `.mcp.json` registers the dispatch server, whose tools need neither. A question
 * only: nothing is written on its answer.
 */
function folderCanDispatch(folder: vscode.WorkspaceFolder): boolean {
  const policy = lookAtDispatchPolicy(folder);
  return canDispatchFrom({
    launcherPresent: launcherPresent(ROOT_DIR),
    policy: policy.ok ? policy.state : undefined,
    mcpRegistered: mcpRegisteredIn(folder),
  });
}

/**
 * One-time-per-workspace offer to make the folder able to dispatch. Nothing waits for it: its
 * callers start it and absorb a rejection, so an offer that fails is simply not made.
 *
 * Made only where it is needed (§15.7, Nags): worker accounts exist and the folder CANNOT
 * dispatch (folderCanDispatch) — a session that already has the cco command and this version's
 * policy, or the MCP server, is asked nothing. What is offered is Update Workspace Setup, which
 * shows what it would change before it changes anything; on win32, where cco does not run in
 * this version, it is the MCP registration, exactly as before. Not made either while the stable
 * copy of the server is not in place: neither path would have anything to run.
 *
 * "Not in this workspace" is remembered per folder AND per offer: the setup offer has a key of
 * its own, so an answer once given to the registration offer does not silence another question.
 */
async function maybeOfferDispatchSetup(
  context: vscode.ExtensionContext,
  stableServer: () => StableServer,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || readRegistry().workers.length === 0 || folderCanDispatch(folder)) {
    return;
  }
  if (process.platform !== 'win32') {
    const setupDismissKey = `claudeCodeOrchestrator.setupOfferDismissed:${folder.uri.fsPath}`;
    if (context.workspaceState.get<boolean>(setupDismissKey) || !stableServer().ok) {
      return;
    }
    const updateLabel = vscode.l10n.t('Update Workspace Setup');
    const notHereLabel = vscode.l10n.t('Not in this workspace');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Claude Code Orchestrator: worker accounts are configured, but the Claude Code session in this workspace cannot dispatch yet. "Update Workspace Setup" shows what it would add — the dispatch policy that teaches the session the cco command, and the permission rules for that command — and changes only what you check.',
      ),
      updateLabel,
      notHereLabel,
    );
    if (answer === updateLabel) {
      await vscode.commands.executeCommand('claudeCodeOrchestrator.updateWorkspaceSetup', folder.uri);
    } else if (answer === notHereLabel) {
      await context.workspaceState.update(setupDismissKey, true);
    }
    return;
  }
  const dismissKey = `claudeCodeOrchestrator.mcpOfferDismissed:${folder.uri.fsPath}`;
  if (context.workspaceState.get<boolean>(dismissKey) || !stableServer().ok) {
    return;
  }
  const registerLabel = vscode.l10n.t('Register');
  const dismissLabel = vscode.l10n.t('Not in this workspace');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Claude Code Orchestrator: worker accounts are configured, but the dispatch MCP server is not registered in this workspace. Register it so your Claude Code session can dispatch tasks?',
    ),
    registerLabel,
    dismissLabel,
  );
  if (choice === registerLabel) {
    const problem = await registerMcpFor(folder, stableServer);
    if (problem !== undefined) {
      showRegistrationProblem(problem);
      return;
    }
    vscode.window.showInformationMessage(
      vscode.l10n.t('Registered. Restart the Claude Code session here and approve the project MCP server.'),
    );
    await offerDispatchPolicy(folder);
  } else if (choice === dismissLabel) {
    await context.workspaceState.update(dismissKey, true);
  }
}

/* ------------------------------------------------------------------------- *
 * Update Workspace Setup (§15.7): look, show what would change, apply what was checked
 * ------------------------------------------------------------------------- */

/*
 * The user's "re-modify the existing prompts": a workspace set up under an earlier version has
 * an earlier policy block and team agent, and maybe the MCP registration they taught. This
 * command LOOKS at all of it first, shows ONE multi-select list whose descriptions are the states
 * it found, and then applies only the checked items — in the order 1, 2, 3, 4, each through the
 * guarded writer the installers above use, each write going through only while its file is still
 * what the look saw. The decisions are workspaceSetup's (plain Node); the words and the writes
 * are here.
 *
 * Answering the list IS the confirmation: it is given after the look, about the states it
 * shows, and a file that changed since is not written (writeFileAtomic's unchanged-since check),
 * so the per-file "Replace?" dialogs of the single-item commands are not asked again.
 */

/** Item 3's and item 4's JSON files are read up to this size; a larger one is not rewritten. */
const SETUP_JSON_MAX_BYTES = 1024 * 1024;

/**
 * A JSON file Update Workspace Setup may rewrite, as it was found: the name (`file`), the file
 * that would be replaced (`target` — the file itself, or what a link at its name leads to inside
 * the root), its text (undefined: there is no file) and what was at the target when it was read —
 * the write goes through only while that still holds. Or `problem`: the sentence for a file that
 * must not be rewritten.
 */
type JsonFileLook =
  | { ok: true; file: string; target: string; text: string | undefined; stat: fs.Stats | undefined }
  | { ok: false; file: string; problem: string };

/**
 * Look at a JSON file under `root` for the purpose of rewriting it, changing nothing — the
 * reader the policy installer has (lookAtDispatchPolicy), for a file of settings:
 *
 *  - a link at the name is followed only while it leads to a file inside `root`: the file it
 *    names is what is replaced, and the link stays. One that leads outside, or nowhere, is refused;
 *  - a directory on the way that is a link leading out of `root` is refused, file or no file;
 *  - the file must be a regular file of at most 1 MiB that its owner may write — a file its
 *    owner marked read-only is not replaced by name, which would go around that mark — and its
 *    bytes valid UTF-8: the read is LOSSLESS (readTextSafe strictUtf8, through no link), because
 *    what is read is what is written back.
 *
 * No file at all is `ok` with no text: there is nothing to lose, and the write creates it.
 */
function lookAtJsonFile(file: string, root: string): JsonFileLook {
  const refuse = (problem: string): JsonFileLook => ({ ok: false, file, problem });
  const unreadable = (detail: string): JsonFileLook =>
    refuse(vscode.l10n.t('{0} could not be read ({1}). Nothing was changed.', file, detail));
  let atName: fs.Stats | undefined;
  try {
    atName = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return unreadable(failureText(err));
    }
  }
  let target = file;
  if (atName?.isSymbolicLink()) {
    let inside = false;
    try {
      target = fs.realpathSync(file);
      inside = staysInsideFolder(root, target);
    } catch {
      inside = false;
    }
    if (!inside) {
      return refuse(
        vscode.l10n.t(
          '{0} is a symbolic link that leads outside {1}, or nowhere, and this extension does not write through it. Nothing was changed.',
          file,
          root,
        ),
      );
    }
  } else if (!staysInsideFolder(root, path.dirname(file))) {
    return refuse(
      vscode.l10n.t('A directory on the way to {0} is a symbolic link that leads outside {1}. Nothing was changed.', file, root),
    );
  }
  // What is at the target BEFORE it is read: the write goes through only while this still holds.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return unreadable(failureText(err));
    }
  }
  if (stat === undefined) {
    return { ok: true, file, target, text: undefined, stat: undefined };
  }
  if (!stat.isFile()) {
    return refuse(vscode.l10n.t('{0} is not a regular file. Nothing was changed.', file));
  }
  if (stat.size > SETUP_JSON_MAX_BYTES) {
    return refuse(
      vscode.l10n.t('{0} is larger than 1 MiB, which is more than this extension reads. Nothing was changed.', file),
    );
  }
  if (!ownerCanWrite(stat)) {
    return refuse(
      vscode.l10n.t(
        '{0} is read-only (its owner has no write permission), and this extension does not replace a file its owner cannot write. Nothing was changed.',
        file,
      ),
    );
  }
  const read = readTextSafe(target, SETUP_JSON_MAX_BYTES, { noFollow: true, strictUtf8: true });
  if (!read.ok) {
    if (read.reason === 'absent') {
      // Gone again since the look above: the same as never having been there.
      return { ok: true, file, target, text: undefined, stat: undefined };
    }
    return read.reason === 'not-utf8'
      ? refuse(
          vscode.l10n.t(
            '{0} is not valid UTF-8 text, and a file that cannot be read and written back byte for byte is not rewritten. Nothing was changed.',
            file,
          ),
        )
      : unreadable(read.detail);
  }
  return { ok: true, file, target, text: read.text, stat };
}

/**
 * Put `text` into the file `look` found — in one step, and only while the target is still what
 * `look` saw (writeFileAtomic): a file that appeared, changed or was replaced since is not
 * covered. A file that was not there gets its directory first (`.claude/`), which is asked once
 * more, now that it exists, whether it stays inside `root`. Returns undefined once written,
 * otherwise the sentence to show; the file is then as it was.
 */
function writeJsonFileOver(look: JsonFileLook & { ok: true }, root: string, text: string): string | undefined {
  const changedSince = (): string =>
    vscode.l10n.t('{0} changed after it was looked at, so nothing was written — run the command again.', look.file);
  if (look.stat === undefined) {
    const dir = path.dirname(look.target);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return vscode.l10n.t('{0} could not be written ({1}). The file is as it was.', look.file, failureText(err));
    }
    if (!staysInsideFolder(root, dir)) {
      return changedSince();
    }
  }
  const failed = writeFileAtomic(look.target, text, look.stat);
  if (failed === undefined) {
    return undefined;
  }
  return failed === 'changed'
    ? changedSince()
    : vscode.l10n.t('{0} could not be written ({1}). The file is as it was.', look.file, failed);
}

/** The sentence for a JSON file whose content is not something this command can change. */
function jsonProblemText(file: string, problem: JsonProblem): string {
  switch (problem.code) {
    case 'not-json':
      return vscode.l10n.t(
        '{0} is not valid JSON ({1}), and a file that was not understood is not rewritten. Nothing was changed.',
        file,
        rowText(problem.detail, 200),
      );
    case 'not-object':
      return vscode.l10n.t(
        '{0} does not hold a JSON object, and a file that was not understood is not rewritten. Nothing was changed.',
        file,
      );
    case 'not-object-at':
      return vscode.l10n.t(
        '"{0}" in {1} is not a JSON object, so nothing can be added to it or removed from it. Nothing was changed.',
        problem.key,
        file,
      );
    case 'not-string-list-at':
      return vscode.l10n.t(
        '"{0}" in {1} is not a list of strings, so nothing can be added to it or removed from it. Nothing was changed.',
        problem.key,
        file,
      );
  }
}

/** Item 3's file as the look found it: where Claude Code keeps it for this folder, and what is in it. */
interface LocalSettingsLook {
  where: SettingsRoot;
  /** `<root>/.claude/settings.local.json`. */
  file: string;
  /** git tracks the file (true), does not (false), or could not say (undefined). */
  tracked: boolean | undefined;
  rules: CcoRules;
  read: JsonFileLook;
}

/** Everything one run of the command looked at, before it showed anything. */
interface SetupLook {
  folder: vscode.WorkspaceFolder;
  policy: PolicyLook;
  /** Undefined where item 2 is not offered (win32: the agent dispatches only through cco). */
  teamAgent: TeamAgentLook | undefined;
  /** Undefined where items 3 and 4 are not offered (win32). */
  settings: LocalSettingsLook | undefined;
  /** The folder's `.mcp.json`; undefined where item 4 is not offered. */
  mcp: JsonFileLook | undefined;
}

/**
 * Item 3's look on its own: where Claude Code keeps the local settings file for a session started
 * in `root` (git is asked, 5 s at most per question), whether git tracks it, the five rules, and
 * what the file holds. Nothing is changed. Update Workspace Setup and the offer that follows the
 * plain policy installer (offerAllowCcoAfterPolicy) both look through here, so the two can never
 * disagree about which file item 3 means.
 */
async function lookAtLocalSettings(root: string): Promise<LocalSettingsLook> {
  const where = await lookUpSettingsRoot(root);
  const tracked = where.inGit ? await isTrackedInGit(where.root, LOCAL_SETTINGS_FILE) : undefined;
  const file = path.join(where.root, ...LOCAL_SETTINGS_FILE.split('/'));
  return { where, file, tracked, rules: ccoRules(os.homedir()), read: lookAtJsonFile(file, where.root) };
}

/**
 * LOOK at the folder: CLAUDE.md, and — where cco runs — the team agent, where Claude Code keeps
 * the local settings file, what it holds and whether git tracks it, and `.mcp.json`. Nothing is
 * changed. The texts are looked at last, after git has answered, so that the looks their writes
 * are checked against are as recent as they can be. What is not offered is not looked at.
 */
async function lookAtWorkspaceSetup(folder: vscode.WorkspaceFolder): Promise<SetupLook> {
  const root = folder.uri.fsPath;
  let settings: LocalSettingsLook | undefined;
  let mcp: JsonFileLook | undefined;
  const offered = offeredSetupItems();
  if (offered.includes('allowCco')) {
    settings = await lookAtLocalSettings(root);
  }
  if (offered.includes('removeMcp')) {
    mcp = lookAtJsonFile(path.join(root, '.mcp.json'), root);
  }
  return {
    folder,
    policy: lookAtDispatchPolicy(folder),
    teamAgent: offered.includes('teamAgent') ? lookAtTeamAgent(root) : undefined,
    settings,
    mcp,
  };
}

/** The states the list shows, from the look — every one of them read from a file. */
function setupStatesOf(look: SetupLook): SetupItemStates {
  return {
    policy: look.policy.ok ? look.policy.state : 'unreadable',
    teamAgent:
      look.teamAgent === undefined
        ? undefined
        : look.teamAgent.outcome === 'failed'
          ? 'unreadable'
          : look.teamAgent.outcome,
    allowCco:
      look.settings === undefined
        ? undefined
        : look.settings.read.ok
          ? allowItemStateOf(look.settings.read.text, look.settings.rules)
          : 'unreadable',
    removeMcp: look.mcp === undefined ? undefined : look.mcp.ok ? mcpItemStateOf(look.mcp.text) : 'unreadable',
  };
}

/** Why item 3's file cannot be changed, or undefined when it can. */
function settingsProblemOf(settings: LocalSettingsLook): string | undefined {
  if (!settings.read.ok) {
    return settings.read.problem;
  }
  const change = withCcoRules(settings.read.text, settings.rules);
  return change.kind === 'refused' ? jsonProblemText(settings.file, change.problem) : undefined;
}

/** Why `.mcp.json` cannot be changed, or undefined when it can. */
function mcpProblemOf(mcp: JsonFileLook): string | undefined {
  if (!mcp.ok) {
    return mcp.problem;
  }
  const change = withoutMcpServers(mcp.text);
  return change.kind === 'refused' ? jsonProblemText(mcp.file, change.problem) : undefined;
}

/** The label of an item, in the list and in the report alike. */
function setupItemLabel(item: SetupItemId): string {
  switch (item) {
    case 'policy':
      return vscode.l10n.t('Dispatch policy in CLAUDE.md');
    case 'teamAgent':
      return vscode.l10n.t('Team proxy agent');
    case 'allowCco':
      return vscode.l10n.t('Allow cco without a prompt');
    case 'removeMcp':
      return vscode.l10n.t('Remove the cco-dispatch MCP server');
  }
}

/** A row of the list: which item it is, and what the look found. */
type SetupPickItem = vscode.QuickPickItem & { id: SetupItemId };

/**
 * The ONE list (§15.7): every offered item, its description the state the look found, checked
 * as checkedByDefault says. An item that cannot be changed is still listed — unchecked, with the
 * reason as its detail — because a list that silently leaves something out reads as "nothing
 * there". Paths and file contents reach the list only through pickText (no icons, one line).
 */
function setupPickItems(look: SetupLook): SetupPickItem[] {
  const states = setupStatesOf(look);
  const checked = checkedByDefault(states);
  const shown = (text: string): string => pickText(text, PICK_PATH_MAX);
  const cannot = vscode.l10n.t('cannot be changed');
  const items: SetupPickItem[] = [];

  const policy = states.policy;
  items.push({
    id: 'policy',
    label: setupItemLabel('policy'),
    description:
      policy === 'absent'
        ? vscode.l10n.t('absent')
        : policy === 'current'
          ? vscode.l10n.t('current — nothing to do')
          : policy === 'differs'
            ? vscode.l10n.t('differs')
            : cannot,
    detail:
      policy === 'absent'
        ? vscode.l10n.t('Adds the policy block that teaches the Claude Code session here the cco command.')
        : policy === 'differs'
          ? vscode.l10n.t(
              "Replaces the policy block with this version's text. Changes made inside the block are discarded; the rest of CLAUDE.md stays as it is.",
            )
          : look.policy.ok
            ? undefined
            : shown(look.policy.problem),
    picked: checked.has('policy'),
  });

  // Item 2 only where it is offered (§15.12 M1): on win32 the look has no team agent at all.
  const agent = look.teamAgent;
  if (agent !== undefined) {
    items.push({
      id: 'teamAgent',
      label: setupItemLabel('teamAgent'),
      description:
        agent.outcome === 'absent'
          ? vscode.l10n.t('absent')
          : agent.outcome === 'current'
            ? vscode.l10n.t('current — nothing to do')
            : agent.outcome === 'differs'
              ? vscode.l10n.t('differs')
              : agent.outcome === 'foreign'
                ? vscode.l10n.t('not ours')
                : cannot,
      detail:
        agent.outcome === 'differs'
          ? vscode.l10n.t("{0} is replaced with this version's; changes made to it are discarded.", TEAM_AGENT_FILE)
          : agent.outcome === 'foreign'
            ? vscode.l10n.t('{0} holds an agent of your own; it is left alone.', TEAM_AGENT_FILE)
            : agent.outcome === 'symlink'
              ? vscode.l10n.t('{0} is a symbolic link; nothing is written through one.', TEAM_AGENT_FILE)
              : agent.outcome === 'outside'
                ? vscode.l10n.t(
                    'A directory on the way to {0} is a symbolic link that leads outside this folder; nothing is written there.',
                    TEAM_AGENT_FILE,
                  )
                : agent.outcome === 'failed'
                  ? shown(vscode.l10n.t('Could not write {0}: {1}', TEAM_AGENT_FILE, agent.detail))
                  : TEAM_AGENT_FILE,
      picked: checked.has('teamAgent'),
    });
  }

  const settings = look.settings;
  const allow = states.allowCco;
  if (settings !== undefined && allow !== undefined) {
    items.push({
      id: 'allowCco',
      label: setupItemLabel('allowCco'),
      description:
        allow === 'unreadable'
          ? cannot
          : allow.missing === 0
            ? vscode.l10n.t('all 5 present')
            : vscode.l10n.t('{0} of 5 missing', allow.missing),
      detail: shown(
        (allow === 'unreadable' ? settingsProblemOf(settings) : undefined) ??
          (settings.tracked === true
            ? vscode.l10n.t('In {0} — tracked in git.', settings.file)
            : vscode.l10n.t('In {0}.', settings.file)),
      ),
      picked: checked.has('allowCco'),
    });
  }

  const mcp = look.mcp;
  const mcpState = states.removeMcp;
  if (mcp !== undefined && mcpState !== undefined) {
    items.push({
      id: 'removeMcp',
      label: setupItemLabel('removeMcp'),
      description:
        mcpState === 'present' ? vscode.l10n.t('present') : mcpState === 'absent' ? vscode.l10n.t('absent') : cannot,
      detail: shown(
        (mcpState === 'unreadable' ? mcpProblemOf(mcp) : undefined) ??
          vscode.l10n.t(
            'From {0} — applied only when the dispatch policy in CLAUDE.md is current after this run.',
            mcp.file,
          ),
      ),
      picked: checked.has('removeMcp'),
    });
  }
  return items;
}

function stepDone(text: string, notes: string[] = []): StepOutcome {
  return { kind: 'done', text, notes };
}

function stepUnchanged(text: string, notes: string[] = []): StepOutcome {
  return { kind: 'unchanged', text, notes };
}

function stepRefused(text: string, notes: string[] = []): StepOutcome {
  return { kind: 'refused', text, notes };
}

/**
 * What items 2, 3 and 4 say where they are not offered (only a caller that bypassed the list can
 * ask): each of them is about the cco command — item 2's agent dispatches only by running it.
 */
function notOfferedHere(): StepOutcome {
  return stepRefused(vscode.l10n.t('cco does not run on Windows in this version, so this is not offered here'));
}

/** Item 1: the policy block, through the policy installer's own writer, over the look the list showed. */
function applyPolicyItem(look: SetupLook): StepOutcome {
  const policy = look.policy;
  if (!policy.ok) {
    return stepRefused(policy.problem);
  }
  if (policy.state === 'current') {
    return stepUnchanged(vscode.l10n.t("the policy block is already this version's."));
  }
  const problem = writeDispatchPolicyOver(policy);
  if (problem !== undefined) {
    return stepRefused(problem);
  }
  return stepDone(
    policy.state === 'differs'
      ? vscode.l10n.t('the policy block that was there was replaced.')
      : vscode.l10n.t('the policy block was added.'),
  );
}

/** Item 2: the team proxy agent, through its installer's writer — never over an agent that is not ours. */
function applyTeamAgentItem(look: SetupLook): StepOutcome {
  const agent = look.teamAgent;
  if (agent === undefined) {
    return notOfferedHere();
  }
  switch (agent.outcome) {
    case 'current':
      return stepUnchanged(vscode.l10n.t("{0} is already this version's.", TEAM_AGENT_FILE));
    case 'foreign':
      return stepRefused(
        vscode.l10n.t(
          'A different agent already lives at {0} — it was left unchanged. Move or rename it, then run this command again.',
          TEAM_AGENT_FILE,
        ),
      );
    case 'symlink':
      return stepRefused(
        vscode.l10n.t(
          '{0} is a symbolic link, and this command does not write through one — nothing was changed. Replace the link with a regular file or remove it, then run this command again.',
          TEAM_AGENT_FILE,
        ),
      );
    case 'outside':
      return stepRefused(
        vscode.l10n.t(
          'The team proxy agent was not written: a directory on the way to {0} is a symbolic link that leads outside this workspace folder. Nothing was changed.',
          TEAM_AGENT_FILE,
        ),
      );
    case 'failed':
      return stepRefused(vscode.l10n.t('Could not write {0}: {1}', TEAM_AGENT_FILE, agent.detail));
    default: {
      const failed = writeTeamAgent(look.folder.uri.fsPath, agent);
      if (failed !== undefined) {
        return stepRefused(
          failed === 'changed'
            ? vscode.l10n.t(
                '{0} changed while it was being written, so nothing was written. Run this command again.',
                TEAM_AGENT_FILE,
              )
            : vscode.l10n.t('Could not write {0}: {1}', TEAM_AGENT_FILE, failed),
        );
      }
      return stepDone(
        agent.outcome === 'differs'
          ? vscode.l10n.t("{0} was replaced with this version's.", TEAM_AGENT_FILE)
          : vscode.l10n.t('written to {0}.', TEAM_AGENT_FILE),
      );
    }
  }
}

/** Item 3, as Update Workspace Setup runs it: applyAllowRules over the look the list showed. */
function applyAllowItem(look: SetupLook): StepOutcome {
  return applyAllowRules(look.settings);
}

/**
 * Item 3: the five rules into the local settings file Claude Code reads for this folder — each
 * only when absent (workspaceSetup.withCcoRules), through the guarded writer (writeJsonFileOver:
 * only while the file is still what `settings` read). A file that is not a settings object this
 * can add to is refused and left byte for byte as it was. THE one way item 3 is applied: Update
 * Workspace Setup and the offer after the plain policy installer (offerAllowCcoAfterPolicy) both
 * come here, so "Allow cco" does exactly what checking item 3 does. Undefined `settings`: not
 * offered on this platform.
 */
function applyAllowRules(settings: LocalSettingsLook | undefined): StepOutcome {
  if (settings === undefined) {
    return notOfferedHere();
  }
  if (!settings.read.ok) {
    return stepRefused(settings.read.problem);
  }
  const change = withCcoRules(settings.read.text, settings.rules);
  if (change.kind === 'refused') {
    return stepRefused(jsonProblemText(settings.file, change.problem));
  }
  const notes = settings.tracked === true ? [trackedInGitNote()] : [];
  if (change.kind === 'unchanged') {
    return stepUnchanged(vscode.l10n.t('all 5 rules are already in {0}.', settings.file), notes);
  }
  const problem = writeJsonFileOver(settings.read, settings.where.root, change.text);
  if (problem !== undefined) {
    return stepRefused(problem);
  }
  return stepDone(vscode.l10n.t('{0} of 5 rules added to {1}.', change.count, settings.file), notes);
}

/** The sentence §15.7 pins for a local settings file that git tracks. */
function trackedInGitNote(): string {
  return vscode.l10n.t(
    'This file is tracked in git — Claude Code applies its rules once the folder is trusted, and everyone who clones the repository gets them.',
  );
}

/**
 * Item 4 (run only once item 1 is current — runSetupPlan's rule): ONLY the dispatch server's
 * two entries leave `.mcp.json` (workspaceSetup.withoutMcpServers; the file is kept, an empty
 * `mcpServers` stays `{}`), and then the same names leave `enabledMcpjsonServers` in item 3's
 * file. That file is looked at AGAIN here, not taken from the list's look: item 3 may have
 * rewritten it a moment ago. A part that cannot be done there is said, and does not undo the
 * first part — a name left in that list for a server that is gone is harmless.
 */
function applyRemoveMcpItem(look: SetupLook): StepOutcome {
  const mcp = look.mcp;
  if (mcp === undefined) {
    return notOfferedHere();
  }
  if (!mcp.ok) {
    return stepRefused(mcp.problem);
  }
  const change = withoutMcpServers(mcp.text);
  if (change.kind === 'refused') {
    return stepRefused(jsonProblemText(mcp.file, change.problem));
  }
  if (change.kind === 'changed') {
    const problem = writeJsonFileOver(mcp, look.folder.uri.fsPath, change.text);
    if (problem !== undefined) {
      return stepRefused(problem);
    }
  }
  const mcpRemoved = change.kind === 'changed';
  const notes: string[] = [];
  let enabledRemoved = false;
  const settings = look.settings;
  if (settings !== undefined) {
    const now = lookAtJsonFile(settings.file, settings.where.root);
    let problem: string | undefined;
    if (!now.ok) {
      problem = now.problem;
    } else {
      const enabled = withoutEnabledMcpServers(now.text);
      if (enabled.kind === 'refused') {
        problem = jsonProblemText(settings.file, enabled.problem);
      } else if (enabled.kind === 'changed') {
        problem = writeJsonFileOver(now, settings.where.root, enabled.text);
        enabledRemoved = problem === undefined;
      }
    }
    if (problem !== undefined) {
      notes.push(vscode.l10n.t('"enabledMcpjsonServers" in {0} was left as it was: {1}', settings.file, problem));
    }
  }
  const settingsFile = settings?.file ?? '';
  if (!mcpRemoved && !enabledRemoved) {
    return stepUnchanged(vscode.l10n.t('{0} has no cco-dispatch entry.', mcp.file), notes);
  }
  if (mcpRemoved && enabledRemoved) {
    notes.unshift(vscode.l10n.t('It was also removed from "enabledMcpjsonServers" in {0}.', settingsFile));
  }
  notes.push(
    vscode.l10n.t('Restart the Claude Code session in this folder — the running session keeps its server until then.'),
  );
  return stepDone(
    mcpRemoved
      ? vscode.l10n.t('removed from {0}.', mcp.file)
      : vscode.l10n.t('removed from "enabledMcpjsonServers" in {0}.', settingsFile),
    notes,
  );
}

/** The writes and the refusals runSetupPlan runs, for one look. */
function setupSteps(look: SetupLook): SetupPlanSteps {
  return {
    run: (item) => {
      switch (item) {
        case 'policy':
          return applyPolicyItem(look);
        case 'teamAgent':
          return applyTeamAgentItem(look);
        case 'allowCco':
          return applyAllowItem(look);
        case 'removeMcp':
          return applyRemoveMcpItem(look);
      }
    },
    // A FRESH look: what item 4 depends on is CLAUDE.md as item 1 left it, not as the list saw it.
    policyStateNow: () => {
      const now = lookAtDispatchPolicy(look.folder);
      return now.ok ? now.state : 'unreadable';
    },
    policyNotCurrent: (state) =>
      stepRefused(
        state === 'differs'
          ? vscode.l10n.t('the policy block in CLAUDE.md still names the MCP tools — update it first')
          : state === 'absent'
            ? vscode.l10n.t(
                'CLAUDE.md has no dispatch policy block, so the Claude Code session here would be left with no way to dispatch — add the policy first',
              )
            : vscode.l10n.t('CLAUDE.md could not be checked, so the dispatch policy is not known to be current — update it first'),
      ),
    notOffered: () => notOfferedHere(),
    failed: (_item, err) => stepRefused(vscode.l10n.t('an unexpected error stopped it ({0})', failureText(err))),
  };
}

/** One line of the report: the item, what it came to, and the clause that says what or why. */
function setupLineOf(item: SetupItemId, outcome: StepOutcome): string {
  const label = setupItemLabel(item);
  switch (outcome.kind) {
    case 'done':
      return vscode.l10n.t('{0}: done — {1}', label, outcome.text);
    case 'unchanged':
      return vscode.l10n.t('{0}: unchanged — {1}', label, outcome.text);
    case 'refused':
      return vscode.l10n.t('{0}: refused — {1}', label, outcome.text);
  }
}

/**
 * The folder to update: the one a caller named (an offer passes its folder's URI), the only one,
 * or — with several — the one the user picks. Undefined when there is none, or the pick was
 * dismissed.
 */
async function setupFolderOf(arg: unknown): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
    return undefined;
  }
  if (arg instanceof vscode.Uri) {
    const named = folders.find((folder) => folder.uri.toString() === arg.toString());
    if (named !== undefined) {
      return named;
    }
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return await vscode.window.showWorkspaceFolderPick({
    placeHolder: vscode.l10n.t('The folder whose setup to look at and update'),
  });
}

/**
 * THE COMMAND "Update Workspace Setup". In this order:
 *
 *  1. the folder (setupFolderOf);
 *  2. where cco runs: the stable copies and the launcher are put in place as activation does —
 *     the command may be run precisely because the launcher is missing, and a folder whose items
 *     are all current must also be one whose session can run the command;
 *  3. LOOK (lookAtWorkspaceSetup) — nothing is changed;
 *  4. the ONE multi-select list (setupPickItems). Dismissing it changes nothing;
 *  5. runSetupPlan: only the checked items, in the order 1, 2, 3, 4, item 4 only once item 1 is
 *     current;
 *  6. ONE information message and the output channel, with per item: done / unchanged /
 *     refused, and why.
 */
async function updateWorkspaceSetup(
  arg: unknown,
  deps: { stableServer: () => StableServer; log: (line: string) => void; output: vscode.OutputChannel },
): Promise<void> {
  const folder = await setupFolderOf(arg);
  if (folder === undefined) {
    return;
  }
  const lines: string[] = [];
  if (process.platform !== 'win32') {
    deps.stableServer();
    // Before the look: the answer can take a login shell's time to come.
    const launcherProblem = ensureCcoLauncher(await resolveNodeCommand(), deps.log);
    if (launcherProblem !== undefined) {
      lines.push(
        vscode.l10n.t(
          'The cco launcher at {0} is not ready ({1}), so the cco command cannot run until it is.',
          launcherPathOf(ROOT_DIR),
          launcherProblem,
        ),
      );
    }
  }
  // git is asked up to four questions of at most 5 s each: the status bar says something is going on.
  const look = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Looking at the workspace setup…') },
    () => lookAtWorkspaceSetup(folder),
  );
  const picked = await vscode.window.showQuickPick(setupPickItems(look), {
    canPickMany: true,
    title: vscode.l10n.t('Update Workspace Setup — {0}', pickText(folder.name, 120)),
    placeHolder: vscode.l10n.t('Check what to apply; each item says what is there now. Nothing is changed before you confirm.'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked === undefined) {
    return;
  }
  const results = runSetupPlan(
    picked.map((item) => item.id),
    offeredSetupItems(),
    setupSteps(look),
  );
  if (results.length === 0) {
    lines.unshift(vscode.l10n.t('Nothing was checked, so nothing was changed.'));
  }
  for (const { item, outcome } of results) {
    lines.push(setupLineOf(item, outcome), ...outcome.notes);
  }
  for (const line of lines) {
    setupReportLine(deps.output, folder, line);
  }
  const showLabel = vscode.l10n.t('Show Output');
  void vscode.window
    .showInformationMessage(vscode.l10n.t('Update Workspace Setup in {0}: {1}', folder.name, lines.join(' ')), showLabel)
    .then(
      (choice) => {
        if (choice === showLabel) {
          deps.output.show(true);
        }
      },
      () => undefined,
    );
}

/**
 * Where Update Workspace Setup's report lines go when no command handed the channel over: the
 * extension's output channel, set by activate. The offer after the plain policy installer
 * (offerAllowCcoAfterPolicy) is started by the one policy writer, which every caller reaches
 * without the channel; it reports through this so its line lands where Update Workspace Setup's
 * would. Undefined before activation and in tests — the line is then only in the message.
 */
let setupReportChannel: vscode.OutputChannel | undefined;

/**
 * One line of Update Workspace Setup's report in the output channel, in its one format. A
 * channel that is gone (the extension being taken down) costs the line, never the caller.
 */
function setupReportLine(
  channel: vscode.OutputChannel | undefined,
  folder: vscode.WorkspaceFolder,
  line: string,
): void {
  try {
    channel?.appendLine(`[workspace setup] ${folder.uri.fsPath}: ${line}`);
  } catch {
    // the channel was disposed; the message still says it
  }
}

/**
 * §15.12 M2: after the plain policy installer wrote this version's block, ONE question — "Let the
 * Claude session run cco without permission prompts in this folder?" — with "Allow cco" and "Not
 * now", asked only where it means something:
 *
 *  - never on win32 (cco does not run there; item 3 is not offered);
 *  - only when item 3's look says rules are MISSING (`<n> of 5 missing`, n > 0). All five present
 *    is nothing to offer; a settings file that cannot be read or added to is not offered either —
 *    its rules may well be there (a read-only file the user keeps), and a button whose only
 *    outcome is a refusal is no offer. Update Workspace Setup lists such a file with the reason.
 *
 * "Allow cco" applies item 3 EXACTLY as Update Workspace Setup does — lookAtLocalSettings, then
 * applyAllowRules (the guarded writer) — over a FRESH look: the notification may have stood for
 * any length of time, and the answer is about letting cco run, not about the file as it was when
 * it was asked. The outcome is reported like Update Workspace Setup's item 3: its line (and notes,
 * such as the tracked-in-git sentence) in the output channel, and the same words in one message.
 * "Not now" (or closing the notification) changes nothing and is not remembered: the next policy
 * write asks again. "This folder can dispatch" is not changed by any of this (§15.7 Nags). An
 * Update Workspace Setup run writing the same file at the same moment is covered by the guarded
 * writer: whichever writes second finds the file changed since its look and writes nothing.
 */
async function offerAllowCcoAfterPolicy(folder: vscode.WorkspaceFolder): Promise<void> {
  if (!offeredSetupItems().includes('allowCco')) {
    return;
  }
  const root = folder.uri.fsPath;
  const first = await lookAtLocalSettings(root);
  const state = first.read.ok ? allowItemStateOf(first.read.text, first.rules) : 'unreadable';
  if (state === 'unreadable' || state.missing === 0) {
    return;
  }
  const allowLabel = vscode.l10n.t('Allow cco');
  const notNowLabel = vscode.l10n.t('Not now');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Let the Claude session run cco without permission prompts in this folder?'),
    allowLabel,
    notNowLabel,
  );
  if (choice !== allowLabel) {
    return;
  }
  let outcome: StepOutcome;
  try {
    // git is asked again (up to 5 s a question): the status bar says something is going on.
    const now = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Looking at the workspace setup…') },
      () => lookAtLocalSettings(root),
    );
    outcome = applyAllowRules(now);
  } catch (err) {
    outcome = stepRefused(vscode.l10n.t('an unexpected error stopped it ({0})', failureText(err)));
  }
  const lines = [setupLineOf('allowCco', outcome), ...outcome.notes];
  for (const line of lines) {
    setupReportLine(setupReportChannel, folder, line);
  }
  const message = lines.join(' ');
  if (outcome.kind === 'refused') {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
}

/**
 * Show-once-per-feature-version "What's New" notice. Runs on every activation
 * but self-gates via globalState: it fires only when the major.minor pair
 * advances (a feature release, not a patch bump), and never on a first install
 * (the getting-started walkthrough already onboards). A failure here must never
 * break activation.
 */
function maybeShowWhatsNew(context: vscode.ExtensionContext): void {
  try {
    const KEY = 'cco.lastNotifiedVersion';
    const current = String(context.extension.packageJSON.version);
    const prev = context.globalState.get<string>(KEY);
    if (prev === undefined) {
      // First install — record the version and stay silent; onboarding is the
      // walkthrough's job.
      void context.globalState.update(KEY, current);
      return;
    }
    if (prev === current) {
      return;
    }
    // A version change: advance the stamp unconditionally, so a patch bump goes
    // silent and the notice never repeats for the same version.
    void context.globalState.update(KEY, current);
    const featurePair = (v: string): string => {
      const [major = '0', minor = '0'] = v.split('.');
      return `${major}.${minor}`;
    };
    if (featurePair(prev) === featurePair(current)) {
      // Patch-only bump — advance silently.
      return;
    }
    void (async () => {
      const whatsNew = vscode.l10n.t('See what’s new');
      const dismiss = vscode.l10n.t('Dismiss');
      const choice = await vscode.window.showInformationMessage(
        // The version requirement is the SESSION WORKERS', and is said as theirs: everything
        // else in the extension — one-shot dispatch included — runs on older CLIs too.
        vscode.l10n.t(
          'Claude Code Orchestrator {0}: a Team view of live sessions across accounts, a redesigned dashboard, session workers your own session messages directly with SendMessage, and worker accounts on Codex, Cursor and Antigravity. Session workers need Claude Code {1} or newer.',
          current,
          MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
        ),
        whatsNew,
        dismiss,
      );
      if (choice === whatsNew) {
        void vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          'toragonite.claude-code-orchestrator#claudeCodeOrchestrator.gettingStarted',
          false,
        );
      }
    })();
  } catch {
    // a notification failure must never break activation
  }
}

/**
 * Asset packs to draw from: the extension's bundled `assets/` directory plus
 * any directories in the assetPacks setting (e.g. a private asset-repo clone).
 */
function loadAssetPacks(context: vscode.ExtensionContext, interactive: boolean): AssetPack[] {
  const sources = resolvePackSources(context);
  if (interactive) {
    for (const source of sources) {
      if (source.kind === 'setting' && !source.pack) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Asset pack directory not found: {0}', source.entry),
        );
      }
    }
  }
  return sources.flatMap((source) => (source.pack ? [source.pack] : []));
}

const ASSET_TYPE_ICONS: Record<AssetType, string> = {
  skill: 'sparkle',
  agent: 'hubot',
  command: 'terminal',
  'output-style': 'paintcan',
  hook: 'symbol-event',
};

/**
 * One-time copy of the values the USER set under the pre-rename settings namespace into the
 * current one. User-level values only: every setting is machine-scoped, so the editor refuses
 * to store one in a workspace's settings — and a value a workspace holds is not this
 * extension's to act on in the first place (`workspaceLevelSettings` reports it instead).
 * Best-effort and total: nothing here throws or rejects.
 */
async function migrateLegacySettings(): Promise<void> {
  try {
    const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);
    const current = vscode.workspace.getConfiguration(CONFIG_SECTION);
    for (const key of LEGACY_SETTING_KEYS) {
      try {
        const oldValue = legacy.inspect(key)?.globalValue;
        if (oldValue !== undefined && current.inspect(key)?.globalValue === undefined) {
          await current.update(key, oldValue, vscode.ConfigurationTarget.Global);
        }
      } catch {
        // settings migration is best-effort
      }
    }
  } catch {
    // the configuration could not even be asked: there is nothing to migrate from
  }
}

/**
 * Settings named in the workspace-level notice; past this it says how many more there are.
 * Room for every setting at one level, the pre-rename ones, and a few more from a second level.
 * 2.0 team mode added eight settings (21 now): 32 keeps that promise with room to spare.
 */
const WORKSPACE_SETTINGS_SHOWN = 32;

/**
 * Say — once, at activation — which of this extension's settings the workspace or one of its
 * folders tries to set. Such a value has no effect (see settings.userSetting); before 2.0
 * it had, so without this a setting somebody kept there would just stop applying. Names each
 * key and where it is, and offers to open the settings it was found in. Never throws.
 */
function reportWorkspaceLevelSettings(): void {
  try {
    const found = workspaceLevelSettings();
    if (found.length === 0) {
      return;
    }
    const named = found
      .slice(0, WORKSPACE_SETTINGS_SHOWN)
      .map((entry) =>
        entry.where === 'folder'
          ? vscode.l10n.t('{0} (settings of folder "{1}")', entry.key, rowText(entry.folder ?? '', 64))
          : vscode.l10n.t('{0} (workspace settings)', entry.key),
      )
      .join(', ');
    const openLabel = vscode.l10n.t('Open Workspace Settings');
    const message =
      found.length > WORKSPACE_SETTINGS_SHOWN
        ? vscode.l10n.t(
            'Claude Code Orchestrator ignores these settings because they are not in your User settings: {0}, and {1} more. Since 2.0 its settings are read from your User settings only — move them there, or remove them.',
            named,
            found.length - WORKSPACE_SETTINGS_SHOWN,
          )
        : vscode.l10n.t(
            'Claude Code Orchestrator ignores these settings because they are not in your User settings: {0}. Since 2.0 its settings are read from your User settings only — move them there, or remove them.',
            named,
          );
    // The file the first of them was read from, when one was; else the editor's own command.
    const file = found.find((entry) => entry.file !== undefined)?.file;
    void vscode.window.showWarningMessage(message, openLabel).then(
      async (choice) => {
        if (choice !== openLabel) {
          return;
        }
        try {
          if (file !== undefined) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
          } else {
            await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
          }
        } catch {
          // the notice has already named the keys
        }
      },
      () => undefined,
    );
  } catch {
    // a notice only
  }
}

/**
 * Push the session-worker ("Mesh Mode") settings into the shared registry, where the MCP
 * server reads them. The master switch maps to the 'on'/'off' toggle the server expects and
 * is on only for a literal `true` — settings.json is hand-editable, and "yes" must not arm
 * it. The two numbers go through the registry's OWN sanitizers, the same functions its read
 * side applies, so this editor can never write a value the server would read differently.
 * The values are the USER's own settings, like every value that reaches the registry.
 * Mirrors WorkerManager.syncSettings' synced-setting pattern, through the same writer
 * (updateRegistryIfChanged): a read-modify-write under the registry lock when something
 * differs, and no write and no lock at all when the registry already says it. Throws when the
 * registry could not be written — syncSettingsToRegistry is the one caller, and the one catch.
 */
function syncMeshSettings(): void {
  const meshMode = userSetting('meshMode') === true;
  const maxLive = sanitizeMeshMaxLive(userSetting('meshMaxLiveWorkers'));
  const historyLimit = sanitizeMeshHistoryLimit(userSetting('meshHistoryLimit'));
  updateRegistryIfChanged((registry) => {
    registry.meshMode = meshMode ? 'on' : 'off';
    registry.meshMaxLiveWorkers = maxLive;
    registry.meshHistoryLimit = historyLimit;
  });
}

/**
 * Push the Teammate-mode settings (team contract §7.7) into the shared registry, exactly as
 * syncMeshSettings does the session-worker ones: the three switches are 'on' only for a literal
 * `true`; the four numbers go through the registry's own sanitizer (sanitizeTeamNumberSetting),
 * the one its read side applies. The turn timeout is the user's explicit number clamped to its
 * range, or ABSENT — absent follows workerTimeoutMinutes at read time
 * (registry.teamTurnTimeoutMinutesOf), which a written default would stop doing. Throws when
 * the registry could not be written — syncSettingsToRegistry is the one caller, and the one catch.
 */
function syncTeamSettings(): void {
  const teamMode = userSetting('teamMode') === true;
  const cursorForce = userSetting('teamCursorForce') === true;
  const agySkip = userSetting('teamAgySkipPermissions') === true;
  const maxMembers = sanitizeTeamNumberSetting('teamMaxMembers', userSetting('teamMaxMembers'));
  const maxRunning = sanitizeTeamNumberSetting('teamMaxRunningTurns', userSetting('teamMaxRunningTurns'));
  const perHour = sanitizeTeamNumberSetting('teamTurnsPerMemberPerHour', userSetting('teamTurnsPerMemberPerHour'));
  const perDay = sanitizeTeamNumberSetting('teamTurnsPerDay', userSetting('teamTurnsPerDay'));
  const turnTimeout = sanitizeTeamTurnTimeoutMinutes(explicitUserSetting('teamTurnTimeoutMinutes'));
  updateRegistryIfChanged((registry) => {
    registry.teamMode = teamMode ? 'on' : 'off';
    registry.teamMaxMembers = maxMembers;
    registry.teamMaxRunningTurns = maxRunning;
    registry.teamTurnsPerMemberPerHour = perHour;
    registry.teamTurnsPerDay = perDay;
    registry.teamCursorForce = cursorForce ? 'on' : 'off';
    registry.teamAgySkipPermissions = agySkip ? 'on' : 'off';
    if (turnTimeout === undefined) {
      delete registry.teamTurnTimeoutMinutes;
    } else {
      registry.teamTurnTimeoutMinutes = turnTimeout;
    }
  });
}

/**
 * Mirror the teamMode setting into the `claudeCodeOrchestrator.teamModeOn` context key, which
 * picks the Team view's welcome text and shows the Turn On / Turn Off commands where they
 * apply. On for a literal `true` only, as syncTeamSettings reads it. Set at activation and
 * at every configuration change that touches the setting; a failed setContext only leaves the
 * previous welcome text in place, so it is not waited on.
 */
function syncTeamModeContext(): void {
  void vscode.commands.executeCommand(
    'setContext',
    'claudeCodeOrchestrator.teamModeOn',
    userSetting('teamMode') === true,
  ).then(undefined, () => undefined);
}

/* ------------------------------------------------------------------------- *
 * Settings → shared registry, when the registry may be busy
 * ------------------------------------------------------------------------- */

/**
 * After the registry refused a settings write, how long further attempts are answered with
 * that refusal instead of being made.
 *
 * The registry's lock is synchronous: a waiter that cannot get it blocks the extension host
 * for 15 seconds before it throws. One user action can ask for this sync several times within
 * milliseconds — a settings write from the dashboard asks directly and again through the
 * configuration event, and the migration of the old settings namespace fires one event per
 * key — and each of those would freeze the editor for another 15 seconds while the same
 * process still holds the same lock. Within this window the answer is already known.
 */
const SETTINGS_SYNC_BACKOFF_MS = 10_000;

/** The last refusal of a settings write, or undefined once a sync has gone through. */
let settingsSyncProblem: { message: string; at: number } | undefined;
/** The refusal the user has already been shown a message about (see the configuration event). */
let settingsSyncProblemShown: { message: string; at: number } | undefined;

/**
 * Push this editor's settings into the shared registry (the WorkerManager's and the
 * session-worker ones), and say whether that worked: undefined when the registry now holds
 * them, otherwise why not — for a registry that stayed locked, the lock's own message, which
 * names the file and the process holding it.
 *
 * NEVER THROWS, which is the point of it: it is called from `activate()`, from a configuration
 * event and from a timer, and a state file that happens to be busy must not fail an activation
 * or escape from an event handler. A failure is written to the output channel as ONE line;
 * WHO ELSE is told is the caller's decision — nobody for a background sync, the user for a
 * change they made. Nothing is retried here: the next natural trigger (a settings change, the
 * usage refresh tick) calls this again, and until one succeeds the registry simply keeps the
 * values it had, which is what the refusal promised.
 */
function syncSettingsToRegistry(workers: WorkerManager, log: vscode.OutputChannel): string | undefined {
  const now = Date.now();
  if (settingsSyncProblem !== undefined) {
    const age = now - settingsSyncProblem.at;
    if (age >= 0 && age < SETTINGS_SYNC_BACKOFF_MS) {
      return settingsSyncProblem.message;
    }
  }
  try {
    workers.syncSettings();
    // Not attempted when the first write was refused: it would wait on the same lock.
    syncMeshSettings();
    syncTeamSettings();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    settingsSyncProblem = { message, at: Date.now() };
    log.appendLine(`[settings] not written to the shared registry (dispatch keeps the previous values): ${message}`);
    return message;
  }
  if (settingsSyncProblem !== undefined) {
    settingsSyncProblem = undefined;
    log.appendLine('[settings] written to the shared registry');
  }
  return undefined;
}

/** Offer to open the registry file when `choice` is that offer. */
function openRegistryFileOn(openLabel: string): (choice: string | undefined) => void {
  return (choice) => {
    if (choice === openLabel) {
      openRegistryFile();
    }
  };
}

/**
 * Say — once, at activation — when the shared registry cannot be used as it is.
 *
 * A registry FILE this version cannot read is the serious one: every reader then sees no
 * worker accounts and default settings, and every write is refused, so without this the
 * extension would simply look empty. The notice names the file and what is wrong with it
 * (`readRegistryChecked`'s one-line problem, which holds none of the file's content) and offers
 * to open it. It also stands for the settings sync the same file has just refused.
 *
 * Otherwise, a settings sync that was refused at activation (`syncProblem`: the registry's lock
 * stayed held) is said in the lock's own words. It is retried by itself, but until then
 * dispatch runs on values that are not this editor's, and the editor has just stalled on that
 * lock — the user should not have to find that in the output channel. Never throws.
 */
function reportRegistryStateAtStartup(syncProblem: string | undefined): void {
  try {
    const { problem } = readRegistryChecked();
    if (problem !== null) {
      settingsSyncProblemShown = settingsSyncProblem;
      const openLabel = vscode.l10n.t('Open File');
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            'Claude Code Orchestrator could not read its worker registry {0}: {1}. No worker account is used and nothing can be saved until the file is fixed or deleted. The file was not changed.',
            REGISTRY_FILE,
            problem,
          ),
          openLabel,
        )
        .then(openRegistryFileOn(openLabel), () => undefined);
      return;
    }
    if (syncProblem !== undefined && settingsSyncProblem !== settingsSyncProblemShown) {
      settingsSyncProblemShown = settingsSyncProblem;
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "This editor's settings were not copied to the shared registry, so dispatch keeps using the values it holds. {0} It is tried again at the next settings change and every few minutes.",
          syncProblem,
        ),
      );
    }
  } catch {
    // a notice only
  }
}

/* ------------------------------------------------------------------------- *
 * Stale session files left by earlier versions' usage probes
 * ------------------------------------------------------------------------- */

/** globalState: epoch ms the background prune last STARTED (shared by every window). */
const LITTER_LAST_RUN_KEY = 'cco.sessionLitter.lastRunAt';
/** globalState: true once the user has been told that stale files were removed. */
const LITTER_NOTICE_KEY = 'cco.sessionLitter.noticeShown';
const LITTER_STARTUP_DELAY_MS = 15_000;

/**
 * workspaceState: a digest of the files the startup asset sync last TOLD the user it had left
 * alone in this workspace. Something that stays in the way — a link the user keeps at an
 * install path, say — is said in a notification once, and after that only in the output
 * channel and by the sync command; not at every window.
 */
const ASSETS_NOT_SYNCED_TOLD_KEY = 'cco.assets.notSyncedTold';
const LITTER_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** One prune call examines a bounded number of entries; a flooded directory needs several. */
const LITTER_MAX_PASSES = 10;

interface LitterTotals {
  scanned: number;
  removed: number;
  errors: number;
  /** A directory still had unexamined entries when the passes ended. */
  truncated: boolean;
  passes: number;
}

/** A count from a report: a finite, non-negative number or 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One account as the shell addresses it: the registry's name and directory verbatim, and the
 * agent CLI it runs on. The hosting session's own account ("main") is always Claude Code.
 */
interface ShellAccount {
  name: string;
  configDir: string;
  provider: ProviderId;
}

/**
 * Every account an action can be taken on: `main` (the directory this editor's own Claude Code
 * session runs under) first, then every registry worker of every provider. A CLAUDE CODE worker
 * whose directory IS main's is the same login and is not listed a second time. A worker on
 * another vendor's CLI is always listed as itself, even on that directory: sharing a directory
 * string does not make a Codex login the editor's Claude account, and its re-login must run
 * that vendor's command, never `claude auth login`.
 */
function shellAccounts(): ShellAccount[] {
  const mainDir = hostConfigDir();
  const accounts: ShellAccount[] = [{ name: 'main', configDir: mainDir, provider: 'claude' }];
  for (const w of readRegistry().workers) {
    const provider = workerProvider(w);
    if (provider === 'claude' && w.configDir === mainDir) {
      continue;
    }
    accounts.push({ name: w.name, configDir: w.configDir, provider });
  }
  return accounts;
}

/**
 * Config directories of the CLAUDE CODE accounts only — main, then each Claude Code worker
 * (the registry's `claudeWorkers`, the one enumeration of them). The session-file prune works
 * on a Claude Code `sessions/` directory and deletes what it recognizes there; the home
 * directory of another vendor's CLI is never handed to it, whatever that vendor happens to
 * keep under the same name.
 */
function claudeAccountDirs(): string[] {
  const mainDir = hostConfigDir();
  const dirs = [mainDir];
  for (const w of claudeWorkers(readRegistry())) {
    if (w.configDir !== mainDir) {
      dirs.push(w.configDir);
    }
  }
  return dirs.filter((dir) => typeof dir === 'string' && dir !== '');
}

/** The run in flight, if any: the startup prune and the command share it rather than race. */
let litterRun: Promise<LitterTotals> | undefined;
let litterCancelRequested = false;

/**
 * Remove the session files v1.x usage probes leaked (they were SIGKILLed, which leaves a
 * `<pid>.json` and a `.key` behind every reading) from the main account and every worker
 * account. `pruneAllSessionLitter` decides what is litter; this only drives it: one call per
 * pass, repeated for the directories that reported `truncated`, at most LITTER_MAX_PASSES
 * times. A directory whose truncated pass removed NOTHING is dropped from the next pass —
 * the same entries would be examined again with the same result. Never throws.
 */
function pruneSessionLitterNow(
  log: vscode.OutputChannel,
  onPass?: (totals: LitterTotals) => void,
): Promise<LitterTotals> {
  if (litterRun) {
    return litterRun;
  }
  litterCancelRequested = false;
  litterRun = (async (): Promise<LitterTotals> => {
    const totals: LitterTotals = { scanned: 0, removed: 0, errors: 0, truncated: false, passes: 0 };
    let dirs: string[];
    try {
      dirs = claudeAccountDirs();
    } catch {
      dirs = [];
    }
    for (let pass = 1; pass <= LITTER_MAX_PASSES && dirs.length > 0; pass++) {
      if (litterCancelRequested) {
        totals.truncated = true;
        break;
      }
      let reports: LitterReport[];
      try {
        reports = await pruneAllSessionLitter(dirs);
      } catch (err) {
        // Documented never to reject; a throw must still not escape into activation.
        log.appendLine(
          `[session files] pass ${pass} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        totals.errors += 1;
        break;
      }
      totals.passes = pass;
      const again: string[] = [];
      let stalled = false;
      for (const report of Array.isArray(reports) ? reports : []) {
        if (typeof report !== 'object' || report === null) {
          continue;
        }
        const removed = count(report.removed);
        totals.scanned += count(report.scanned);
        totals.removed += removed;
        totals.errors += count(report.errors);
        log.appendLine(
          `[session files] pass ${pass}: ${report.configDir}: examined ${count(report.scanned)}, ` +
            `removed ${removed}, errors ${count(report.errors)}${report.truncated === true ? ', more remain' : ''}`,
        );
        if (report.truncated === true) {
          if (removed > 0 && typeof report.configDir === 'string') {
            again.push(report.configDir);
          } else {
            stalled = true;
          }
        }
      }
      dirs = again;
      totals.truncated = stalled || again.length > 0;
      onPass?.(totals);
    }
    log.appendLine(
      `[session files] done: examined ${totals.scanned}, removed ${totals.removed}, errors ${totals.errors}, ` +
        `${totals.passes} pass(es)${totals.truncated ? ', more may remain' : ''}`,
    );
    return totals;
  })().finally(() => {
    litterRun = undefined;
  });
  return litterRun;
}

/**
 * The startup prune: at most once per 24 hours across all windows (the stamp lives in
 * globalState and is written BEFORE the run, so a second window opening meanwhile, or a run
 * that is interrupted, does not start another). A stamp in the future — a clock that was set
 * back — is treated as no stamp, or it would suppress the prune until the clock caught up.
 * Tells the user ONCE, the first time anything was removed; after that it works silently
 * and the totals are in the output channel.
 */
async function pruneSessionLitterInBackground(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<void> {
  try {
    const now = Date.now();
    const last = context.globalState.get<unknown>(LITTER_LAST_RUN_KEY);
    if (
      typeof last === 'number' &&
      Number.isFinite(last) &&
      last <= now &&
      now - last < LITTER_MIN_INTERVAL_MS
    ) {
      return;
    }
    await context.globalState.update(LITTER_LAST_RUN_KEY, now);
    const totals = await pruneSessionLitterNow(log);
    if (totals.removed > 0 && context.globalState.get<unknown>(LITTER_NOTICE_KEY) !== true) {
      await context.globalState.update(LITTER_NOTICE_KEY, true);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Removed {0} stale session files left by usage probes of earlier versions.',
          totals.removed,
        ),
      );
    }
  } catch {
    // housekeeping only — the next activation tries again
  }
}

/* ------------------------------------------------------------------------- *
 * Team proxy agent
 * ------------------------------------------------------------------------- */

/** Our definition is a few KiB; anything far past that at its path is not ours. */
const TEAM_AGENT_READ_MAX_BYTES = 256 * 1024;

/** What is at the team-proxy agent's path, and — for a file that was read — its `lstat`. */
type TeamAgentLook =
  | {
      /**
       * `teamAgentState`'s four answers, plus two places this command does not write to:
       * `symlink` — the path itself is a symbolic link; `outside` — a directory on the way
       * (`.claude`, `.claude/agents`) is a link that leads out of the workspace folder.
       */
      outcome: 'absent' | 'current' | 'differs' | 'foreign' | 'symlink' | 'outside';
      file: string;
      stat: fs.Stats | undefined;
    }
  | { outcome: 'failed'; file: string; detail: string };

/**
 * Look at the team-proxy agent definition's path in the workspace, without changing anything.
 * What may be written afterwards is `teamAgentState`'s decision: nothing there or a blank
 * file — write; this version's own text — nothing to do; our markers around other text — ask
 * first; anything else is the user's own agent and is left alone, as is a path occupied by
 * something that is not a regular file or by more than our definition could ever be.
 */
function lookAtTeamAgent(root: string): TeamAgentLook {
  const file = path.join(root, ...TEAM_AGENT_FILE.split('/'));
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return { outcome: 'failed', file, detail: failureText(err) };
    }
  }
  if (stat?.isSymbolicLink()) {
    // Never followed: writing through it would create or overwrite a file somewhere this
    // command was never pointed at.
    return { outcome: 'symlink', file, stat };
  }
  if (!staysInsideFolder(root, path.dirname(file))) {
    return { outcome: 'outside', file, stat };
  }
  if (stat === undefined) {
    return { outcome: 'absent', file, stat };
  }
  if (!stat.isFile()) {
    return { outcome: 'foreign', file, stat };
  }
  if (!ownerCanWrite(stat)) {
    // Its owner marked it "do not change"; a replace by name would go around that.
    return { outcome: 'failed', file, detail: 'the file is read-only (its owner has no write permission)' };
  }
  const read = readTextSafe(file, TEAM_AGENT_READ_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === 'absent') {
      // Gone again since the look above: the same as never having been there.
      return { outcome: 'absent', file, stat: undefined };
    }
    // Not knowing what is there is not a licence to replace it.
    return read.reason === 'unreadable'
      ? { outcome: 'failed', file, detail: read.detail }
      : { outcome: 'foreign', file, stat };
  }
  return { outcome: teamAgentState(read.text), file, stat };
}

/**
 * Write this version's definition where `look` found room for it: in one step (see
 * `writeFileAtomic`), creating `.claude/agents/` when needed, and only while the path is still
 * what `look` saw — a file that appeared or changed in between is not covered. Returns
 * undefined once written, else why not.
 */
function writeTeamAgent(root: string, look: { file: string; stat: fs.Stats | undefined }): string | undefined {
  const dir = path.dirname(look.file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return failureText(err);
  }
  // Asked again now that the directories exist.
  if (!staysInsideFolder(root, dir)) {
    return 'changed';
  }
  return writeFileAtomic(look.file, TEAM_AGENT_MD, look.stat);
}

/** Job ids named in the removal question; past this the list says there are more. */
const STRANDED_JOB_IDS_SHOWN = 8;

/**
 * The longest name an unsupported registry entry can have: the registry file is read up to
 * 1 MiB, so no entry in it is longer. A longer "name" did not come from a row of the tree.
 */
const UNSUPPORTED_ENTRY_NAME_MAX = 1024 * 1024;

const ACCOUNT_ACTIONS: readonly UiAccountAction[] = [
  'relogin',
  'checkLogin',
  'togglePreferred',
  'openSession',
  'setModel',
  'setPermissionMode',
  'remove',
];

/**
 * The names held by the registry entries this version cannot use. No worker carries them, and
 * they are taken all the same (`unsupportedNameMessage` says why). An entry without a name
 * holds none.
 */
function unsupportedNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of readRegistry().unsupportedWorkers) {
    if (entry.name !== '') {
      names.add(entry.name);
    }
  }
  return names;
}

/** Does `dir` exist and hold anything? Any fs error reads as "no". */
function dirHasContent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The rows of the Add Worker provider pick.
 *
 * A quick pick shows ONE line of detail and cuts it where the list ends, so each row is built
 * to be read in that line, with the fact that tells the providers apart FIRST:
 *
 *  - label: the product's name;
 *  - description: the command it runs, and in two words what kind of worker it makes;
 *  - detail: one sentence, well under the width of the list, on the one thing that differs —
 *    which dispatches reach it. Claude Code takes every dispatch that names no provider; any
 *    other CLI is used only when a dispatch names that provider or the worker.
 *
 * Everything else worth knowing (which login, where it is kept, which model) is asked in the
 * steps that follow, where it can be answered.
 *
 * Exported so that the wording can be checked without driving the whole flow.
 */
export function providerPickItems(): (vscode.QuickPickItem & { info: ProviderInfo })[] {
  return allProviders().map((info) => ({
    label: info.label,
    description: info.sessionWorkers
      ? vscode.l10n.t('{0} · attachable sessions', info.cli)
      : vscode.l10n.t('{0} · one-shot only', info.cli),
    detail:
      info.id === 'claude'
        ? vscode.l10n.t('Takes every dispatch that names no provider.')
        : vscode.l10n.t('Used only when a dispatch names {0} or the worker.', info.label),
    info,
  }));
}

/**
 * What a model picker returns: `{ model }` once a choice was made — `model: undefined` being
 * the choice "no default, let the CLI choose", which only a non-Claude worker can make — or
 * undefined when the picker was dismissed.
 */
type ModelChoice = {
  model: string | undefined;
};

/**
 * A Claude Code model as it is STORED when a person chose it: exactly (a full id is a pinned
 * model — the three v1.x tier ids included, which are models the CLI still offers), or an
 * alias. Undefined for a value that is no model. WorkerManager decides `modelPinned` from it
 * the same way: a stored full id is pinned.
 */
function chosenClaudeModel(raw: unknown): string | undefined {
  return normalizeModel(raw, { exact: true });
}

export function activate(context: vscode.ExtensionContext): void {
  const workers = new WorkerManager();
  // Housekeeping that runs with nobody watching reports here, not in notifications.
  const output = vscode.window.createOutputChannel('Claude Code Orchestrator');
  // Set first when the extension is taken down. Work that was put off until after activate()
  // returned asks it before it starts, and work that comes back later — a lookup, a sweep —
  // asks it before it writes or says anything.
  let disposed = false;
  context.subscriptions.push(
    {
      dispose: () => {
        disposed = true;
      },
    },
    workers,
    output,
  );
  // The dashboard host logs to this same channel. Left to itself it would create a second
  // channel under the same name the first time it had something to say, and the Output
  // panel would list "Claude Code Orchestrator" twice.
  setDashboardLog((line) => output.appendLine(line));
  // So does the "Allow cco" offer the policy writer starts (offerAllowCcoAfterPolicy).
  setupReportChannel = output;
  // Settings go into the shared registry here, again once the old settings namespace has been
  // migrated, on every settings change and — while a write is still owed — on the usage tick.
  // The two activation syncs are BACKGROUND work: a registry that is busy is logged, said once
  // (reportRegistryStateAtStartup) and tried again at the next of those triggers, and
  // activation carries on either way. (When the registry already holds the settings, which is
  // nearly always, no lock is taken at all.) The sync waits on no process: the one value that
  // takes a login shell to find, the path of the claude command, is looked up in the
  // background (WorkerManager.syncSettings), and its answer is written by this same sync when
  // it arrives — unless the extension has been disposed by then.
  const syncSettings = (): string | undefined =>
    disposed ? undefined : syncSettingsToRegistry(workers, output);
  workers.onClaudePathResolved(() => {
    syncSettings();
  });
  // The dashboard writes settings too and must not report "saved" for one the dispatch server
  // cannot see yet; it asks the same function.
  setDashboardSettingsSync(syncSettings);
  void migrateLegacySettings().then(syncSettings, () => undefined);
  reportRegistryStateAtStartup(syncSettings());
  reportWorkspaceLevelSettings();
  maybeShowWhatsNew(context);

  // The stable copy of the dispatch server, brought up to date and asked whether it is in
  // place (ensureStableServerCopy). Asked after activation, so that a new version reaches the
  // copy with no command run, and again whenever a path is about to be offered or registered.
  // A name that could not be written is said once in the output channel, not at every asking.
  // The cco launcher (ensureCcoLauncher) reports the same way.
  const stableCopyLines = new Set<string>();
  const stableCopyLog = (line: string): void => {
    if (!stableCopyLines.has(line)) {
      stableCopyLines.add(line);
      output.appendLine(line);
    }
  };
  const stableServer = (): StableServer => ensureStableServerCopy(context, stableCopyLog);
  // Update Workspace Setup runs one at a time: two runs interleaving their looks and writes
  // would each find the other's writes "changed since it was looked at".
  let workspaceSetupRunning = false;

  // Accounts on another vendor's CLI get their login state and usage from the bundled status
  // helper, which the usage module forks once per account. It is run from THIS extension's own
  // install directory — found the way the bundled server is found — so the helper is always the
  // one built with the code that reads its answer; the copy beside the stable server is there
  // for whatever the server starts. `polling` is read on every call, so turning the setting
  // off takes effect at the next refresh: the helper is then asked for login state only and
  // no vendor usage service is contacted. Never throws and never rejects — a helper that is
  // missing or crashes is recorded in the usage cache by the usage module itself.
  const providerHelperPath = context.asAbsolutePath(path.join(BUNDLE_DIR, PROVIDER_HELPER));
  /** `force` re-reads every account now; without it a reading that is still fresh is kept. */
  const refreshProviders = async (force = false): Promise<void> => {
    try {
      await refreshProviderUsage({
        force,
        helperPath: providerHelperPath,
        // On unless it was turned off — the same reading the dashboard shows for the toggle.
        polling: userSetting('providerUsagePolling') !== false,
      });
    } catch (err) {
      output.appendLine(
        `[provider usage] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Live-usage cache: never block activation on a probe. An initial refresh is made once
  // activation has returned (afterActivation, below), the cache is kept warm on a timer, and
  // users refresh on demand. The tree/dashboard/MCP surfaces watch the cache file this
  // writes. Both the activation refresh and the timer go through the stale-guarded variant so
  // a second editor sharing the cache doesn't re-probe readings another window just took;
  // only the explicit Refresh command below forces a real probe.
  // The other vendors' accounts are refreshed on exactly the same three triggers.
  const usageTimer = setInterval(() => {
    void refreshAllUsageIfStale().catch(() => {});
    void refreshProviders();
    // A settings write the registry refused earlier is owed until it lands; this is its
    // natural retry. So is the path of a claude command no lookup has found yet: the sync
    // asks the login shell again, in the background. With nothing owed, nothing is done.
    if (settingsSyncProblem !== undefined || workers.claudePathUnresolved()) {
      syncSettings();
    }
  }, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });

  // SELF-HEALING of the login state (Login state (CA)): when the window regains focus, or the
  // machine has just woken up (a 30-second tick that arrives far too late), every Claude Code
  // account whose login is `probeFailed` or `unconfirmed` is checked again — the network or the
  // keychain that failed a probe is often back by then. Debounced: at most one round a minute.
  let lastLoginRecheck = 0;
  const recheckDoubtfulLogins = (): void => {
    const now = Date.now();
    if (disposed || now - lastLoginRecheck < 60_000) {
      return;
    }
    lastLoginRecheck = now;
    try {
      const cache = readUsageCache();
      const due = listAccounts().filter((a) => {
        const state = computeLoginState(ownCacheEntry(cache, a.configDir), now).state;
        return state === 'probeFailed' || state === 'unconfirmed';
      });
      if (due.length > 0) {
        void refreshAllUsage(due, 3, LOGIN_LIVE_CHECK_TIMEOUT_MS).catch(() => undefined);
      }
    } catch {
      // a re-check that cannot even be planned waits for the next trigger
    }
  };
  // A host without the event (the harnesses' stand-in editors) loses only the focus trigger.
  if (typeof vscode.window.onDidChangeWindowState === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          recheckDoubtfulLogins();
        }
      }),
    );
  }
  let lastWakeTick = Date.now();
  const wakeTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastWakeTick > 90_000) {
      recheckDoubtfulLogins();
    }
    lastWakeTick = now;
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(wakeTimer) });

  // Session keepalive (opt-in): one minimal request per subscription account per
  // 24h so an idle account's OAuth session doesn't lapse into the expired state.
  // The setting is read fresh on every tick rather than captured at activation,
  // so toggling it takes effect without a window reload. The first sweep is
  // deferred ~2 minutes to keep activation and the initial usage refresh clear.
  // runKeepaliveSweep never throws and enforces the per-account 24h stamps itself. What it
  // decides NOT to do for want of a writable stamp file it says in the output channel, once.
  const keepaliveTick = (): void => {
    if (userSetting('sessionKeepalive') === true) {
      // Documented never to throw; nothing is awaiting this, so a rejection is absorbed here.
      void Promise.resolve()
        .then(() => runKeepaliveSweep(Date.now(), (line) => output.appendLine(line)))
        .catch(() => undefined);
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

  // Usage probes of earlier versions leaked two files per reading into each account's
  // sessions/ directory — tens of thousands on a long-lived install, enough to make the CLI's
  // own session listing take half a minute. Clear them out in the background, well after
  // activation, and at most once a day.
  const litterTimer = setTimeout(() => {
    void pruneSessionLitterInBackground(context, output);
  }, LITTER_STARTUP_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(litterTimer) });

  const workersProvider = new WorkersProvider(workers);
  const tasksProvider = new TasksProvider();
  const historyProvider = new WorkerHistoryProvider();
  // Teammate mode (team contract §8.1): the observer client of this workspace's dispatch hosts.
  // It connects to hosts only while teamMode is on or a team of this workspace is not ended.
  const teamClient = new TeamClient({
    dataRoot: ROOT_DIR,
    workspace: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    connectWanted: () => userSetting('teamMode') === true,
    log: (line) => output.appendLine(line),
  });
  const teamProvider = registerTeamView(context, teamClient);
  syncTeamModeContext();
  // The task tree folds a team's turns under one row and routes their Cancel to the engine (L12, M8).
  setTeamTaskHooks({
    teamName: (teamId) => teamClient.team(teamId)?.state.name,
    pauseTurn: (teamId, member, taskId) => teamClient.pauseTurn(teamId, member, taskId),
  });
  context.subscriptions.push({
    dispose: () => {
      setTeamTaskHooks(undefined);
      teamClient.dispose();
    },
  });
  for (const [id, run] of Object.entries(teamCommandHandlers(teamClient))) {
    context.subscriptions.push(guardedCommand(id, run));
  }
  teamClient.start();

  // A crashed or killed orchestrator session leaves its dispatches stuck at
  // 'running'. Reclaim them on startup — best-effort, and after activation: the sweep reads
  // the whole task log.
  // The mesh-aware liveness callback keeps SESSION-WORKER (`claude --bg`) tasks out of
  // the sweep: their events carry no pid at all, so the pid checks alone would read
  // every live one as orphaned.
  //
  // Run TWICE: once by itself, and once more when the sweep of orphaned session workers has
  // ended (stopOrphanedSessionWorkers). That sweep stops sessions whose owner is gone, and
  // only then does the task of such a session read as dead — reaped once, before the sweep,
  // it would stay `running` in every view until the next activation.
  const reclaimDeadTasks = (): void => {
    const reaped = reapDeadTasks(undefined, meshTaskAliveCheck(), meshTaskRecovery());
    if (reaped > 0) {
      // The log just grew by this sweep's own events: drawn from the index, not a rebuild.
      tasksProvider.redraw();
      workersProvider.redraw();
      historyProvider.redraw();
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Reclaimed {0} dispatched task(s) left running by a previous session.',
          reaped,
        ),
      );
    }
  };

  // The same crash leaves the MCP server's session workers running with no owner
  // process. Sweep every workspace's mesh ledger: a record whose owner is gone and
  // whose session is still alive is stopped, the rest are only marked. Deliberately
  // not awaited — the sweep spawns `claude stop` per orphan and must never delay
  // anything — and every failure is swallowed, sync throw and rejection alike. It starts once
  // a lookup of the claude command that is still in flight has ended, so that the path it is
  // handed is the one the registry holds after it.
  //
  // WHEN IT HAS ENDED — stopped something, found nothing, or failed — the dead-task sweep is
  // run once more (see reclaimDeadTasks): the tasks of the sessions it just stopped are dead
  // only now. That second run is this continuation's last step and cannot leave it: a throw
  // is one line in the output channel. Nothing of it happens once the extension is disposed.
  const stopOrphanedSessionWorkers = (): void => {
    void workers
      .whenClaudePathSettled()
      .then(() => (disposed ? undefined : reapOrphanedMeshWorkers({ claudePath: readRegistry().claudePath })))
      .then((report) => {
        if (!disposed && report !== undefined && report.stopped.length > 0) {
          vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Stopped {0} session worker(s) left running by a previous session.',
              report.stopped.length,
            ),
          );
        }
      })
      .catch(() => {
        // orphan reaping is a backstop; a failure must never break anything
      })
      .then(() => {
        if (disposed) {
          return;
        }
        try {
          reclaimDeadTasks();
        } catch (err) {
          output.appendLine(
            `[activation] dead tasks (after the session-worker sweep) failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })
      .catch(() => {
        // the output channel itself could not take the line: nothing is left to say it with
      });
  };

  // The per-task io directories (task file + result file) are cleaned up when a
  // dispatch settles, so only a killed server leaves them behind — and that server
  // may never run in this workspace again, which would strand the litter forever.
  // Run the same stale-artifact sweep from the extension host, over every workspace.
  // Wrapped so a synchronous throw inside the sweep arrives as a rejection this catch
  // absorbs: collecting litter is a backstop and must never be able to break anything.
  const sweepIoArtifacts = (): void => {
    void Promise.resolve()
      .then(() => sweepStaleIoArtifacts({}))
      .catch(() => {
        // an unreadable io root is nothing to report — the next activation retries
      });
  };

  // The first usage refresh. The Claude Code probes spawn the claude command the registry
  // names, and resolve a bare one through a login shell they WAIT for: they start once a
  // lookup of that path that is still in flight has ended and its answer is in the registry.
  const refreshUsageAtStartup = (): void => {
    void refreshProviders();
    void workers
      .whenClaudePathSettled()
      .then(() => (disposed ? undefined : refreshAllUsageIfStale()))
      .catch(() => {});
  };

  // Keep enabled assets fresh on startup: pack updates flow in automatically,
  // hand-edited files are reported but never overwritten.
  const syncAssetsAtStartup = (): void => {
    if (!userSetting('assetAutoSync')) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    try {
      const report = syncWorkspace(loadAssetPacks(context, false), folder.uri.fsPath);
      // A file sync had to leave alone — a pipe, a link, a directory or an oversized file at
      // an install path — goes to the channel every time, and into the notification as well:
      // the asset it belongs to is not what the pack ships, and nothing else tells the user.
      // A sync that changed nothing shows the notification only when what it left alone is
      // not what this workspace was last told.
      for (const blocked of report.blocked) {
        output.appendLine(
          `[assets] not synced: ${rowText(blocked.asset, 200)}${
            blocked.rel === '' ? '' : ` — ${rowText(blocked.rel, 200)}`
          }: ${blocked.reason}`,
        );
      }
      const leftAlone =
        report.blocked.length === 0
          ? undefined
          : sha256(
              report.blocked
                .map((b) => JSON.stringify([b.asset, b.rel, b.reason]))
                .sort()
                .join('\n'),
            );
      const told: unknown = context.workspaceState.get(ASSETS_NOT_SYNCED_TOLD_KEY);
      if (
        report.installed.length ||
        report.updated.length ||
        report.removed.length ||
        (leftAlone !== undefined && leftAlone !== told)
      ) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Claude assets synced: {0}.', describeSync(report)),
        );
      }
      if (leftAlone !== told) {
        // Cleared once nothing is in the way, so that the same obstacle coming back is said again.
        void context.workspaceState.update(ASSETS_NOT_SYNCED_TOLD_KEY, leftAlone).then(undefined, () => undefined);
      }
    } catch (err) {
      // a ledger that could not be understood is said, since nothing is synced for this
      // workspace until it is corrected; anything else goes to the output channel.
      if (err instanceof AssetStateUnreadableError) {
        showAssetStateProblem(err);
      } else {
        output.appendLine(
          `[assets] startup sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  // WHAT ACTIVATION OWES BUT DOES NOT WAIT FOR. Each of these reads whole files — the task log,
  // every workspace's ledger, the bundled server, the asset packs — and none of them is needed
  // for the views and commands to be there. They run one after the other, each on a later turn
  // of the event loop, so that activate() returns first and the editor gets to work between
  // two of them. A step that throws ends there and the next one still runs; none is started
  // once the extension is being disposed.
  const afterActivation: readonly (readonly [string, () => void])[] = [
    [
      'stable server copy',
      () => {
        // Brings the copy up to date; the offer asks for it again and is not made without it.
        stableServer();
        // The cco launcher (§15.8): written with the node this extension host already resolved,
        // else `node`. Activation starts NO lookup of its own — a login shell per activation is
        // what the startup rules forbid (one shell, for the claude path, and only when needed).
        // A bare `node` is found at run time on the PATH of the shell cco runs in — the Claude
        // Code Bash tool's, which is the user's own interactive one. Update Workspace Setup (a
        // user action) resolves node and rewrites the launcher with the absolute path. Before
        // the offer, which asks whether the launcher is there.
        ensureCcoLauncher(cachedNodeCommand ?? 'node', stableCopyLog);
        void maybeOfferDispatchSetup(context, stableServer).catch(() => undefined);
      },
    ],
    ['dead tasks', reclaimDeadTasks],
    ['orphaned session workers', stopOrphanedSessionWorkers],
    ['stale io artifacts', sweepIoArtifacts],
    ['usage refresh', refreshUsageAtStartup],
    ['asset sync', syncAssetsAtStartup],
  ];
  let nextStep = 0;
  const runNextStep = (): void => {
    if (disposed || nextStep >= afterActivation.length) {
      return;
    }
    const [name, step] = afterActivation[nextStep++];
    try {
      step();
    } catch (err) {
      // Housekeeping, every one of them: said here, and tried again at the next activation.
      output.appendLine(
        `[activation] ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setImmediate(runNextStep);
  };
  setImmediate(runNextStep);

  const tasksView = vscode.window.createTreeView('claudeCodeOrchestrator.tasks', {
    treeDataProvider: tasksProvider,
  });
  tasksView.description = vscode.l10n.t('this workspace');

  context.subscriptions.push(
    tasksProvider,
    workersProvider,
    historyProvider,
    tasksView,
    vscode.window.registerTreeDataProvider('claudeCodeOrchestrator.workers', workersProvider),
    vscode.window.registerTreeDataProvider(
      'claudeCodeOrchestrator.workerHistory',
      historyProvider,
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeCodeOrchestrator')) {
        return;
      }
      if (e.affectsConfiguration('claudeCodeOrchestrator.teamMode')) {
        syncTeamModeContext();
      }
      // A settings change is something the user DID, so a registry that could not take it is
      // said to them, with the lock's own words — once per refusal, not once per event of a
      // burst (the same refusal is answered from memory for a few seconds). A refusal that so
      // far only a background sync has met has not been said to anyone yet, and is said now.
      const problem = syncSettings();
      if (problem !== undefined && settingsSyncProblem !== settingsSyncProblemShown) {
        settingsSyncProblemShown = settingsSyncProblem;
        // The file is offered while it is the registry itself that cannot be read.
        const openLabel = vscode.l10n.t('Open File');
        void vscode.window
          .showWarningMessage(
            vscode.l10n.t(
              'The settings change was not saved to the shared registry, so dispatch keeps using the previous values. {0} It is tried again at the next settings change and every few minutes.',
              problem,
            ),
            ...(registryIsUnreadable() ? [openLabel] : []),
          )
          .then(openRegistryFileOn(openLabel), () => undefined);
      }
    }),
  );

  /** `separator`: a heading inside the list, which the editor never hands back as a pick. */
  type ModelItem = vscode.QuickPickItem & { choice: 'model' | 'cli' | 'other' | 'separator'; model?: string };

  /**
   * Does the frontier guard block the frontier tier right now? The dispatch server enforces
   * the shared registry's value; anything but an explicit `allow` blocks, and a registry that
   * cannot be read is read as the safe answer.
   */
  const frontierGuardBlocks = (): boolean => {
    try {
      return readRegistry().frontierWorkerDispatch !== 'allow';
    } catch {
      return true;
    }
  };

  /**
   * The choices of a Claude Code worker's default model, and the picker's title.
   *
   * WITH THE ACCOUNT'S OWN MENU (the `/model` list its CLI answered in the usage probe's
   * session, usage.claudeMenuOf): its aliases first, each saying what the CLI means by it now
   * (`opus` · "Opus 5.5") with the CLI's own line under it; then the pinned models it offers,
   * by their display names, each with its id. `default` is not a choice of its own — what the
   * CLI recommends is the title. A stored default the menu does not hold is kept, marked
   * current, and said to be unlisted: it is never swapped for something the menu does hold.
   *
   * WITHOUT ONE (a worker being added, an account not read yet, an older CLI): one item per
   * tier alias (platform's WORKER_MODELS). An alias names no model version — the account's own
   * CLI resolves it to the newest model of that family it offers — so each alias says that,
   * and adds what it LAST RAN AS when a finished task reported it: of this account, or, for an
   * account that does not exist yet, of any Claude Code account here (they all run the one
   * `claude` command).
   *
   * Everything the CLI wrote is shown as one display-safe line in which no `$(name)` opens an
   * icon (views.pickText).
   */
  const claudeModelItems = (
    current: string | undefined,
    account: { name?: string; configDir?: string } | undefined,
  ): { items: ModelItem[]; title: string | undefined } => {
    const currentMark = vscode.l10n.t('current');
    // While the frontier guard blocks the frontier tier, an account whose DEFAULT is on it
    // takes no dispatch that leaves the model to the account. Said on the item that would
    // make it so, before it is picked.
    const guardBlocks = frontierGuardBlocks();
    const guarded = (model: string, what: string): string =>
      guardBlocks && isFrontierModel(model)
        ? vscode.l10n.t(
            '{0} · frontier tier, which the frontier guard blocks: while it does, dispatches that name no model will skip an account whose default this is',
            what,
          )
        : what;
    const typeIn: ModelItem = {
      label: vscode.l10n.t('Enter a model id…'),
      // No example id here: the box that follows shows the forms a model takes, from the one
      // place that names them (platform.MODEL_FORMS_HINT).
      detail: vscode.l10n.t('A full Claude model id, typed in — the CLI decides whether it exists.'),
      choice: 'other',
    };
    const menu: ClaudeMenuModel[] | undefined =
      account?.configDir !== undefined ? claudeMenuOf(getCachedUsage(account.configDir)) : undefined;
    if (menu !== undefined) {
      const items: ModelItem[] = [];
      const mark = (value: string, rest: string | undefined): string | undefined =>
        [rest, value === current ? currentMark : undefined].filter((part): part is string => part !== undefined && part !== '').join(' · ') || undefined;
      const listed = menu.filter((m) => m.value !== 'default');
      for (const m of listed.filter((entry) => !entry.value.startsWith('claude-'))) {
        items.push({
          label: m.value,
          description: mark(m.value, pickText(m.label, 60)),
          detail: guarded(m.value, m.description !== undefined ? pickText(m.description, 120) : '') || undefined,
          choice: 'model',
          model: m.value,
        });
      }
      for (const m of listed.filter((entry) => entry.value.startsWith('claude-'))) {
        items.push({
          label: pickText(m.label, 60),
          description: mark(m.value, m.value),
          detail: guarded(m.value, m.description !== undefined ? pickText(m.description, 120) : '') || undefined,
          choice: 'model',
          model: m.value,
        });
      }
      if (current && !listed.some((m) => m.value === current)) {
        items.unshift({
          label: pickText(current, 120),
          description: currentMark,
          detail: vscode.l10n.t('Stored for this worker; the CLI did not list it.'),
          choice: 'model',
          model: current,
        });
      }
      items.push(typeIn);
      // "Opus 5.5 · Best for everyday, complex tasks": the model is the part before the first dot.
      const recommends = menu.find((m) => m.value === 'default')?.description?.split(' · ')[0]?.trim();
      return {
        items,
        title: recommends ? vscode.l10n.t("This account's CLI recommends: {0}", pickText(recommends, 60)) : undefined,
      };
    }
    const name = account?.name;
    const items: ModelItem[] = WORKER_MODELS.map((alias): ModelItem => {
      const ranAs = name !== undefined ? modelLastRanAs(name, 'claude', alias) : claudeModelLastRanAs(alias);
      const what =
        ranAs === null
          ? vscode.l10n.t("Newest {0} model this account's CLI offers", alias)
          : name !== undefined
            ? vscode.l10n.t("Newest {0} model this account's CLI offers · last ran as {1}", alias, ranAs)
            : vscode.l10n.t(
                "Newest {0} model this account's CLI offers · last ran as {1} on another account here",
                alias,
                ranAs,
              );
      return {
        label: alias,
        description: alias === current ? currentMark : undefined,
        detail: guarded(alias, what),
        choice: 'model',
        model: alias,
      };
    });
    // A stored default that is a full id is still the choice to keep.
    if (current && !(WORKER_MODELS as readonly string[]).includes(current)) {
      items.unshift({
        label: pickText(current, 120),
        description: currentMark,
        detail: vscode.l10n.t('A full model id: the CLI runs exactly this model, whatever is newest.'),
        choice: 'model',
        model: current,
      });
    }
    items.push(typeIn);
    return { items, title: undefined };
  };

  /**
   * The choices of another vendor's default model. `catalog` is what the account's CLI listed
   * (usage.listProviderModels), when there is a list; without one the built-in suggestions are
   * offered — NOT a validation list either way: these catalogs are large and change often.
   *
   * In this order: the stored default, marked, whether or not the list holds it; the
   * provider's OWN models as its CLI orders them; "let the CLI choose"; then, under a heading
   * of their own, the models of OTHER vendors that this CLI resells — each saying whose
   * account pays, because such a model spends this provider's plan on something another
   * worker account may already pay for; and last "type an id". Without a resold model there
   * is no heading.
   */
  const vendorModelItems = (
    provider: ProviderId,
    current: string | undefined,
    catalog: ProviderModelCatalog | undefined,
  ): ModelItem[] => {
    const info = providerInfo(provider);
    const currentMark = vscode.l10n.t('current');
    const billed = vscode.l10n.t(
      "Billed through this {0} account — not through that vendor's own account.",
      info.label,
    );
    const listed = catalog !== undefined && catalog.models.length > 0 ? catalog.models : undefined;
    const offered: { id: string; label: string | null; resold: boolean; default?: true; efforts?: string[] }[] =
      listed ?? info.suggestedModels.map((id) => ({ id, label: null, resold: false }));
    // Codex lists each model under a display name, says which is its default, and which
    // reasoning efforts it takes: the name is the row, the id beside it, the efforts under it.
    const byName = provider === 'codex';
    const defaultMark = vscode.l10n.t("the CLI's default");
    const effortsLine = (efforts: string[] | undefined): string | undefined =>
      efforts !== undefined && efforts.length > 0
        ? vscode.l10n.t('Reasoning efforts: {0}', efforts.join(', '))
        : undefined;
    // A label is a CLI's own text, and a quick pick draws `$(name)` in it as an icon: shown as
    // one display-safe line in which no icon opens (views.pickText).
    const named = (label: string | null): string | undefined =>
      label === null || label === '' ? undefined : pickText(label, 80);
    const items: ModelItem[] = [];
    if (current) {
      const entry = offered.find((m) => m.id === current);
      // What the list says of it, or — for an id the list does not hold — what its family says.
      const resold = entry !== undefined ? entry.resold : !isOwnModelFamily(provider, current);
      items.push({
        // `current` is a registry value; the suggestions are constants and the catalog's ids
        // have the shape of a model id (which has no `$` and no parenthesis in it).
        label: pickText(current, 120),
        description: [currentMark, named(entry?.label ?? null), entry?.default === true ? defaultMark : undefined]
          .filter((part): part is string => part !== undefined)
          .join(' · '),
        detail:
          entry === undefined && listed !== undefined
            ? vscode.l10n.t('Stored for this worker; the CLI did not list it.')
            : resold
              ? billed
              : effortsLine(entry?.efforts),
        choice: 'model',
        model: current,
      });
    }
    const rest = offered.filter((m) => m.id !== current);
    for (const m of rest.filter((entry) => !entry.resold)) {
      if (byName) {
        const name = named(m.label);
        items.push({
          label: name ?? m.id,
          description: [name !== undefined ? m.id : undefined, m.default === true ? defaultMark : undefined]
            .filter((part): part is string => part !== undefined)
            .join(' · ') || undefined,
          detail: effortsLine(m.efforts),
          choice: 'model',
          model: m.id,
        });
      } else {
        items.push({ label: m.id, description: named(m.label), choice: 'model', model: m.id });
      }
    }
    // One line of detail each, the deciding fact first (see providerPickItems).
    items.push({
      label: vscode.l10n.t('Let the CLI choose'),
      description: current ? undefined : currentMark,
      detail: vscode.l10n.t(
        "No default is stored: a dispatch that names no model runs on the `{0}` CLI's own.",
        info.cli,
      ),
      choice: 'cli',
    });
    const resoldModels = rest.filter((entry) => entry.resold);
    if (resoldModels.length > 0) {
      items.push({
        label: vscode.l10n.t("Other vendors' models offered by {0}", info.label),
        kind: vscode.QuickPickItemKind.Separator,
        choice: 'separator',
      });
      for (const m of resoldModels) {
        items.push({ label: m.id, description: named(m.label), detail: billed, choice: 'model', model: m.id });
      }
    }
    items.push({
      label: vscode.l10n.t('Enter another model id…'),
      detail: vscode.l10n.t('Any {0} model id — the CLI decides whether it exists.', info.label),
      choice: 'other',
    });
    return items;
  };

  /** What the heading of a vendor's model picker says about where its list comes from. */
  const vendorModelsTitle = (provider: ProviderId, catalog: ProviderModelCatalog | undefined): string => {
    const cli = providerInfo(provider).cli;
    if (catalog === undefined) {
      return vscode.l10n.t('Loading models from the `{0}` CLI…', cli);
    }
    if (catalog.models.length === 0) {
      return vscode.l10n.t('The `{0}` CLI could not list its models — these are built-in suggestions.', cli);
    }
    return catalog.source === 'live'
      ? vscode.l10n.t('Models the `{0}` CLI lists for this account', cli)
      : vscode.l10n.t('Models known for the `{0}` CLI — its built-in list, the CLI was not asked', cli);
  };

  /**
   * Show the model choices of another vendor's worker and return the one picked.
   *
   * The built-in suggestions are on screen at once. When the account's directory is known the
   * list its CLI gives is asked for behind them (one run of the bundled helper, at most 25
   * seconds, answered from memory for ten minutes) and takes their place when it arrives; the
   * picker is marked busy until then, and says so when the CLI could not list anything. An
   * editor whose API has no `createQuickPick` gets the choices as they are known at this
   * moment, in one `showQuickPick`, and nothing is loaded behind a list that could not change.
   */
  const pickVendorModelItem = (
    provider: ProviderId,
    placeHolder: string,
    current: string | undefined,
    configDir: string | undefined,
  ): Thenable<ModelItem | undefined> => {
    const known = configDir !== undefined ? cachedProviderModels(provider, configDir) : undefined;
    if (typeof vscode.window.createQuickPick !== 'function') {
      return vscode.window.showQuickPick(vendorModelItems(provider, current, known), {
        placeHolder,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
      });
    }
    return new Promise<ModelItem | undefined>((resolve) => {
      const pick = vscode.window.createQuickPick<ModelItem>();
      let open = true;
      let picked: ModelItem | undefined;
      pick.placeholder = placeHolder;
      pick.ignoreFocusOut = true;
      // A CLI that resells other vendors' models lists hundreds: what is typed is looked for in
      // the vendor's own name of a model and in what its row says, not only in the id.
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      const showCatalog = (catalog: ProviderModelCatalog | undefined): void => {
        // The row the user is on stays the row they are on when the list under it changes.
        const active = pick.activeItems[0];
        const items = vendorModelItems(provider, current, catalog);
        pick.items = items;
        const same =
          active === undefined
            ? undefined
            : items.find((item) => item.choice === active.choice && item.model === active.model);
        if (same !== undefined) {
          pick.activeItems = [same];
        }
      };
      pick.keepScrollPosition = true;
      showCatalog(known);
      if (configDir === undefined) {
        // No directory to ask about: the suggestions are all there is, and nothing is loading.
        pick.title = undefined;
      } else if (known !== undefined) {
        pick.title = vendorModelsTitle(provider, known);
      } else {
        pick.busy = true;
        pick.title = vendorModelsTitle(provider, undefined);
        void listProviderModels({ helperPath: providerHelperPath, provider, configDir }).then(
          (catalog) => {
            // The answer can arrive up to half a minute later — after the picker is gone, and
            // after the extension itself was taken down with its window. Nothing here may
            // throw: a disposed output channel, a picker that is no more.
            try {
              if (catalog.models.length === 0 && !disposed) {
                output.appendLine(
                  `[models] ${provider}: no model list — ${catalog.error ?? 'the CLI listed no models'}`,
                );
              }
            } catch {
              // the channel is gone; the line was a diagnostic and nothing depends on it
            }
            if (!open || disposed) {
              return;
            }
            try {
              pick.busy = false;
              pick.title = vendorModelsTitle(provider, catalog);
              showCatalog(catalog);
            } catch {
              // the picker was disposed between the test above and here
            }
          },
          () => {
            // listProviderModels never rejects; were it to, the suggestions simply stay.
            try {
              if (open && !disposed) {
                pick.busy = false;
                pick.title = undefined;
              }
            } catch {
              // as above
            }
          },
        );
      }
      pick.onDidAccept(() => {
        picked = pick.selectedItems[0] ?? pick.activeItems[0];
        pick.hide();
      });
      pick.onDidHide(() => {
        open = false;
        pick.dispose();
        resolve(picked);
      });
      pick.show();
    });
  };

  /**
   * Choose a worker's default model, by the rules of its provider.
   *
   * Claude Code: a tier alias (claudeModelItems) — which the CLI resolves to the newest model
   * of that family, so a stored default never goes stale the way a dated model id does — or a
   * full id typed in. Every other provider: one of the models its CLI lists (or, until it has
   * answered, of the built-in suggestions), "let the CLI choose", or an id typed in. A typed id
   * is accepted when it has the shape of a model id of that provider and refused otherwise.
   *
   * `account` is the worker the choice is for when it already exists: its tasks say what an
   * alias last ran as, and its directory is the one whose CLI is asked for a list. Without
   * one — a worker that is being added — no CLI is asked.
   */
  const pickModel = async (
    provider: ProviderId,
    placeHolder: string,
    current?: string,
    account?: { name?: string; configDir?: string },
  ): Promise<ModelChoice | undefined> => {
    let picked: ModelItem | undefined;
    if (provider === 'claude') {
      const claude = claudeModelItems(current, account);
      picked = await vscode.window.showQuickPick(claude.items, {
        placeHolder,
        title: claude.title,
        ignoreFocusOut: true,
        // A display name, an id, a line of the CLI's: each is something a person types to find one.
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } else {
      picked = await pickVendorModelItem(provider, placeHolder, current, account?.configDir);
    }
    if (!picked) {
      return undefined;
    }
    if (picked.choice === 'cli') {
      return { model: undefined };
    }
    if (picked.choice === 'model') {
      // The item's own value, not its label: the label of the current entry is a display form.
      return { model: picked.model };
    }
    if (picked.choice === 'separator') {
      return undefined;
    }
    const info = providerInfo(provider);
    const hint = providerModelHint(provider);
    const typed = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('{0} model id — {1}', info.label, hint),
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (normalizeProviderModel(provider, v) === undefined) {
          return vscode.l10n.t('Not a model id — use {0}.', hint);
        }
        if (provider !== 'claude' || !isLegacyTierId(v)) {
          return undefined;
        }
        // One of the three ids that also name a tier: typed, it is the model itself. Said as a
        // note, before the box is accepted, so that whoever meant the tier can type the alias.
        const alias = normalizeModel(v);
        return {
          message: vscode.l10n.t(
            '{0} is pinned exactly: the worker runs this model. The alias "{1}" would follow the newest {1} model its CLI offers.',
            v.trim().toLowerCase(),
            alias ?? '',
          ),
          severity: vscode.InputBoxValidationSeverity?.Info ?? 1,
        };
      },
    });
    if (typed === undefined) {
      return undefined;
    }
    // Checked again here: the box's validation is advice to the person typing, not a gate.
    const model = provider === 'claude' ? chosenClaudeModel(typed) : normalizeProviderModel(provider, typed);
    if (model === undefined) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Not a model this extension can store — use {0}.', hint),
      );
      return undefined;
    }
    return { model };
  };

  /** Change a worker's default model: `value` when one was supplied, else a quick pick. */
  const setDefaultModel = async (worker: WorkerProfile, value?: unknown): Promise<void> => {
    const provider = workerProvider(worker);
    const info = providerInfo(provider);
    let model: string | undefined;
    if (value !== undefined) {
      if (provider !== 'claude' && (value === null || value === '')) {
        // "No default" is a value only where the CLI can choose for itself.
        model = undefined;
      } else {
        // A value somebody named is either a model or an error — never silently the default.
        // A Claude Code model chosen on the page is taken exactly, as from the picker.
        model = provider === 'claude' ? chosenClaudeModel(value) : normalizeProviderModel(provider, value);
        if (model === undefined) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Not a model this extension can store — use {0}.',
              providerModelHint(provider),
            ),
          );
          return;
        }
      }
    } else {
      const choice = await pickModel(
        provider,
        vscode.l10n.t('Default model for "{0}"', worker.name),
        worker.model,
        worker,
      );
      if (!choice) {
        return;
      }
      model = choice.model;
    }
    try {
      if (workers.setModel(worker.name, model)) {
        vscode.window.showInformationMessage(
          provider === 'claude' && model !== undefined && isPinnedClaudeModel(model)
            ? vscode.l10n.t(
                '"{0}" now defaults to {1} for dispatches that name no model — pinned: the CLI runs exactly this model, whatever is newest.',
                worker.name,
                model,
              )
            : model !== undefined
            ? vscode.l10n.t(
                '"{0}" now defaults to {1} for dispatches that name no model.',
                worker.name,
                model,
              )
            : vscode.l10n.t(
                '"{0}" now has no default model — a dispatch that names none runs on the `{1}` CLI\'s own default.',
                worker.name,
                info.cli,
              ),
        );
      }
    } catch (err) {
      showActionFailure(err);
    }
  };

  /**
   * Change a worker's permission / sandbox mode: `value` when one was supplied, else a quick
   * pick of the modes ITS provider accepts plus "provider default". A mode of another vendor
   * is refused, never stored. Claude Code workers have no mode of their own — they all run
   * under the global setting — so for one of those this explains that and changes nothing.
   *
   * A mode that turns the provider's sandbox off is never stored on one click, whichever way
   * it was chosen: a MODAL names the account, the provider and the mode and says what the mode
   * allows, and only its confirm button stores it. This is the one gate — the dashboard
   * forwards its choice here without asking anything itself.
   */
  const setPermissionMode = async (worker: WorkerProfile, value?: unknown): Promise<void> => {
    const provider = workerProvider(worker);
    const info = providerInfo(provider);
    if (provider === 'claude') {
      // Not awaited: a notification stays up until it is closed, and nothing here waits on it.
      const openLabel = vscode.l10n.t('Open Setting');
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t(
            '"{0}" is a Claude Code worker. Claude Code workers have no permission mode of their own: all of them run under the "Worker Permission Mode" setting, so nothing was changed.',
            worker.name,
          ),
          openLabel,
        )
        .then(
          (choice) => {
            if (choice === openLabel) {
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'claudeCodeOrchestrator.workerPermissionMode',
              );
            }
          },
          () => undefined,
        );
      return;
    }
    let mode: string | null;
    if (value !== undefined) {
      if (value === null || value === '') {
        mode = null; // the provider's default
      } else if (typeof value === 'string' && info.permissionModes.includes(value)) {
        mode = value;
      } else {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Not a {0} permission mode — use one of: {1}. Nothing was changed.',
            info.label,
            info.permissionModes.join(', '),
          ),
        );
        return;
      }
    } else {
      const current = workerPermissionMode(worker);
      const stored = typeof worker.permissionMode === 'string' && current === worker.permissionMode;
      const currentMark = vscode.l10n.t('current');
      type ModeItem = vscode.QuickPickItem & { mode: string | null };
      const items: ModeItem[] = [
        {
          label: vscode.l10n.t('Provider default'),
          description: stored ? undefined : currentMark,
          detail:
            info.defaultPermissionMode !== null
              ? vscode.l10n.t(
                  'Currently {0}. The worker follows the default if a later version changes it.',
                  info.defaultPermissionMode,
                )
              : vscode.l10n.t("No mode is passed: the `{0}` CLI's own default applies.", info.cli),
          mode: null,
        },
        ...info.permissionModes.map((m): ModeItem => ({
          label: m,
          description: stored && m === current ? currentMark : undefined,
          detail: removesSandbox(provider, m)
            ? vscode.l10n.t('Turns the sandbox off — you will be asked to confirm.')
            : undefined,
          mode: m,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('{0} permission mode for "{1}"', info.label, worker.name),
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }
      mode = picked.mode;
    }
    const unsandboxed = removesSandbox(provider, mode);
    if (unsandboxed) {
      const confirmLabel = vscode.l10n.t('Run Without Sandbox');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Run worker "{0}" ({1}) in {2} mode?',
          rowText(worker.name, 64),
          info.label,
          String(mode),
        ),
        {
          modal: true,
          detail: vscode.l10n.t(
            'This turns the {0} sandbox off for "{1}": commands the model generates run on this machine without a sandbox. The mode stays in effect for every dispatch to this worker until you change it.',
            info.label,
            rowText(worker.name, 64),
          ),
        },
        confirmLabel,
      );
      if (confirm !== confirmLabel) {
        // Dismissed: nothing is stored, and nothing is reported as saved.
        return;
      }
    }
    try {
      if (workers.setPermissionMode(worker.name, mode, unsandboxed)) {
        const effective = mode ?? info.defaultPermissionMode;
        vscode.window.showInformationMessage(
          effective !== null
            ? vscode.l10n.t(
                '"{0}" now runs its dispatches in {1} mode ({2}).',
                worker.name,
                effective,
                info.label,
              )
            : vscode.l10n.t(
                '"{0}" now runs its dispatches with the `{1}` CLI\'s own default mode.',
                worker.name,
                info.cli,
              ),
        );
      }
    } catch (err) {
      showActionFailure(err);
    }
  };

  /**
   * Take the account out of the registry and say so only when that happened. A registry that
   * refused the write (its lock stayed held, or the file could not be read) is reported in the
   * registry's own words, and nothing else is claimed: the account is still listed, because it
   * is still there.
   */
  const removeFromRegistry = (worker: WorkerProfile): boolean => {
    try {
      workers.remove(worker.name);
      return true;
    } catch (err) {
      showActionFailure(err, (message) =>
        vscode.l10n.t('Worker account "{0}" was not removed. {1}', worker.name, message),
      );
      return false;
    }
  };

  /**
   * Stop the session workers a removal would strand, one after the other, through the stop
   * path every other surface uses (views.stopSession: `claude stop`, the ledger mark, the
   * `claude rm` teardown; a dispatch still running on one is recorded as cancelled). Returns
   * the ones that could NOT be stopped, each with the reason.
   */
  const stopStrandedSessionWorkers = async (
    worker: WorkerProfile,
    tracked: TrackedSessionWorker[],
  ): Promise<{ jobId: string; error: string }[]> =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Stopping the session workers of "{0}"…', worker.name),
      },
      async (progress) => {
        const failed: { jobId: string; error: string }[] = [];
        for (const [index, session] of tracked.entries()) {
          progress.report({
            message: vscode.l10n.t('{0} of {1}', index + 1, tracked.length),
          });
          // stopSession never throws; this catch is for the day that changes.
          try {
            const result = await stopSession({
              jobId: session.jobId,
              configDir: session.configDir,
              name: session.name,
              taskId: session.taskId,
            });
            if (!result.stopped) {
              failed.push({ jobId: session.jobId, error: result.error ?? vscode.l10n.t('unknown error') });
            }
          } catch (err) {
            failed.push({ jobId: session.jobId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return failed;
      },
    );

  /**
   * Remove a worker account — always behind a modal confirmation.
   *
   * A Claude Code account that still has session workers the ledgers track gets a different
   * question. Once the account is out of the registry, nothing here may run `claude` against
   * its directory any more (that is what keeps a removed account's directory from being
   * touched), so those sessions could no longer be stopped from the extension — only with
   * `claude stop <job id>` in a terminal under that account. The modal says how many there
   * are and which, and offers to stop them first.
   */
  const removeWorkerConfirmed = async (worker: WorkerProfile): Promise<void> => {
    const kept =
      workerProvider(worker) === 'claude'
        ? vscode.l10n.t(
            'Dispatches are no longer routed to it. Its config directory and login stay on disk ({0}), so it can be imported again later.',
            worker.configDir,
          )
        : vscode.l10n.t(
            'Dispatches are no longer routed to it. Its {0} login stays on disk ({1}) and is not signed out, so the account can be added again later.',
            providerInfo(workerProvider(worker)).label,
            worker.configDir,
          );
    const question = vscode.l10n.t('Remove worker account "{0}"?', worker.name);
    const tracked = sessionWorkersStrandedByRemoval(worker);
    if (tracked.length === 0) {
      const removeLabel = vscode.l10n.t('Remove Account');
      const confirm = await vscode.window.showWarningMessage(question, { modal: true, detail: kept }, removeLabel);
      if (confirm === removeLabel && removeFromRegistry(worker)) {
        teamProvider.refresh();
      }
      return;
    }
    const jobIds = tracked.map((session) => session.jobId);
    const shownIds = jobIds.slice(0, STRANDED_JOB_IDS_SHOWN).join(', ');
    const stopLabel = vscode.l10n.t('Stop them and remove');
    const anywayLabel = vscode.l10n.t('Remove anyway');
    const confirm = await vscode.window.showWarningMessage(
      question,
      {
        modal: true,
        detail: [
          jobIds.length > STRANDED_JOB_IDS_SHOWN
            ? vscode.l10n.t(
                'Session workers of this account still tracked: {0} (job ids: {1}, and more). After removal they can no longer be stopped from this extension — only from a terminal, with `claude stop <job id>` under that account.',
                tracked.length,
                shownIds,
              )
            : vscode.l10n.t(
                'Session workers of this account still tracked: {0} (job ids: {1}). After removal they can no longer be stopped from this extension — only from a terminal, with `claude stop <job id>` under that account.',
                tracked.length,
                shownIds,
              ),
          kept,
        ].join('\n\n'),
      },
      stopLabel,
      anywayLabel,
    );
    if (confirm === anywayLabel) {
      if (removeFromRegistry(worker)) {
        teamProvider.refresh();
      }
      return;
    }
    if (confirm !== stopLabel) {
      return;
    }
    const failed = await stopStrandedSessionWorkers(worker, tracked);
    tasksProvider.refresh();
    teamProvider.refresh();
    if (failed.length > 0) {
      // The stop was the condition of the removal. Removing now would strand exactly the
      // sessions that just proved hard to stop, so the account stays, and the user decides.
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Worker account "{0}" was not removed: {1} of its {2} session workers could not be stopped ({3}). Stop them from a terminal with `claude stop <job id>` under that account, or remove the account anyway.',
          worker.name,
          failed.length,
          tracked.length,
          failed.map((f) => `${f.jobId}: ${f.error.replace(/\s+/g, ' ').trim()}`).join('; '),
        ),
      );
      return;
    }
    if (removeFromRegistry(worker)) {
      teamProvider.refresh();
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Stopped {0} session worker(s) of "{1}" and removed the account.',
          tracked.length,
          worker.name,
        ),
      );
    }
  };

  /**
   * Delete a registry entry this version cannot use — always behind a modal confirmation.
   *
   * `item` is the Workers row of the entry: its position in the registry's list of such entries
   * and its name, verbatim. An argument that is not exactly that (an integer position, a
   * string no longer than a registry file can hold) is ignored without a word: no row produced
   * it. A row that no longer matches the registry — the list changed since the tree was drawn —
   * is said, before the question and again at the write (the manager checks under the
   * registry's lock), and removes nothing.
   *
   * WHAT IS TAKEN ON TRUST IS NOTHING. A row of the Workers tree that is not the row of such
   * an entry (views.isUnsupportedRow — an account, a detail row) is ignored whatever keys it
   * carries: an account's entry may hold an `index` and a `name` of its own. A position and a
   * name from anywhere else — a payload some caller built — are only a CLAIM about the
   * registry, and are treated like the row's: the entry at that position must have that name
   * now, the question names it and says why it cannot be used, and the write checks again.
   * A `kind` key is never read.
   *
   * The question names the entry and why this version cannot use it, and says what removing
   * does: the entry is deleted from the registry every editor on this machine shares — where a
   * newer version of the extension may have put it. The account's directory is not touched.
   */
  const removeUnsupportedEntryConfirmed = async (item: unknown): Promise<void> => {
    if (!isPlainObject(item) || (isWorkersTreeRow(item) && !isUnsupportedRow(item))) {
      return;
    }
    const index: unknown = item.index;
    const name: unknown = item.name;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      typeof name !== 'string' ||
      name.length > UNSUPPORTED_ENTRY_NAME_MAX
    ) {
      return;
    }
    const changedMessage = vscode.l10n.t('The registry changed — refresh and try again. Nothing was removed.');
    const entry = readRegistry().unsupportedWorkers[index];
    if (entry === undefined || entry.name !== name) {
      vscode.window.showWarningMessage(changedMessage);
      workersProvider.refresh();
      return;
    }
    const why =
      entry.reason === 'provider'
        ? vscode.l10n.t(
            'This version cannot use it: its provider "{0}" is not one this version knows.',
            rowText(entry.providerText, 40),
          )
        : entry.reason === 'duplicate-name'
          ? vscode.l10n.t('This version cannot use it: an earlier entry of the registry already has this name.')
          : vscode.l10n.t(
              'This version cannot use it: the entry is incomplete — it has no usable name or no account directory.',
            );
    const removeLabel = vscode.l10n.t('Remove Entry');
    const confirm = await vscode.window.showWarningMessage(
      name === ''
        ? vscode.l10n.t('Remove the registry entry that has no name?')
        : vscode.l10n.t('Remove the registry entry "{0}"?', rowText(name, 64)),
      {
        modal: true,
        detail: [
          why,
          vscode.l10n.t(
            'A newer version of the extension may have written it. Removing deletes the entry from the registry file shared by every editor on this machine. Its account directory and login are not touched. This cannot be undone.',
          ),
        ].join(' '),
      },
      removeLabel,
    );
    if (confirm !== removeLabel) {
      return;
    }
    try {
      workers.removeUnsupportedWorker(index, name);
    } catch (err) {
      // The manager's own refusal ("the registry changed…") is a plain sentence; the
      // registry's refusals are shown in their own words.
      if (!showStateWriteRefusal(err)) {
        vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
      }
      workersProvider.refresh();
      return;
    }
    vscode.window.showInformationMessage(
      name === ''
        ? vscode.l10n.t('The registry entry that had no name was removed.')
        : vscode.l10n.t('Registry entry "{0}" removed.', rowText(name, 64)),
    );
  };

  const togglePreferred = (worker: WorkerProfile): void => {
    let enabled: boolean;
    try {
      enabled = workers.togglePreferred(worker.name);
    } catch (err) {
      // The registry could not be written; the mark is where it was, and nothing says otherwise.
      showActionFailure(err, (message) =>
        vscode.l10n.t('The preferred worker was not changed. {0}', message),
      );
      return;
    }
    const provider = workerProvider(worker);
    vscode.window.showInformationMessage(
      enabled
        ? provider === 'claude'
          ? vscode.l10n.t(
              '"{0}" is now the preferred worker — automatic assignment favors it unless it\'s busier than the alternatives.',
              worker.name,
            )
          : vscode.l10n.t(
              '"{0}" is now the preferred {1} worker — a dispatch that asks for {1} favors it unless it\'s busier than the alternatives.',
              worker.name,
              providerInfo(provider).label,
            )
        : vscode.l10n.t('"{0}" is no longer preferred.', worker.name),
    );
  };

  /** The shell's view of a registry worker: name, directory and the CLI it runs on. */
  const accountOf = (worker: WorkerProfile): ShellAccount => ({
    name: worker.name,
    configDir: worker.configDir,
    provider: workerProvider(worker),
  });

  /**
   * Open an interactive session of the account's own CLI. A Claude Code session can be started
   * on a task; another vendor's CLI is simply opened (WorkerManager.openTerminal says why).
   */
  const openAccountSession = async (account: ShellAccount): Promise<void> => {
    if (account.provider !== 'claude') {
      workers.openTerminal(account);
      return;
    }
    const prompt = await vscode.window.showInputBox({
      prompt: vscode.l10n.t(
        'Initial task for the interactive session on "{0}" (leave empty to just open Claude Code)',
        account.name,
      ),
      ignoreFocusOut: true,
    });
    // Escape dismisses the whole action; an empty box just opens Claude Code.
    if (prompt === undefined) {
      return;
    }
    workers.openTerminal(account, prompt.trim() || undefined);
  };

  /**
   * Check Login Now (Login state (CA)): ONE live probe of a Claude Code account — its usage probe,
   * and the login check where that is ambiguous, through the CLI path its dispatches use — then the
   * result with its reason. "Re-login Account" is offered only for a CONFIRMED logout; a check that
   * could not run offers "Check Again", with the reason (a locked keychain says so).
   *
   * "Check Again" re-checks ONCE within the same run, and the answer to that re-check offers no
   * further "Check Again": a chain of re-checks awaited inside one command never ends for a
   * caller that accepts every dialog (or a probe that keeps failing), and the command must finish
   * within its bound — at most two rounds of LOGIN_CHECK_ROUND_MS. Checking again after that is
   * running Check Login Now again.
   */
  const checkLoginNow = async (account: { name: string; configDir: string }, offerAgain = true): Promise<void> => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Checking the login of {0}', account.name) },
      () => checkAllClaudeLoginsNow([account]),
    );
    workersProvider.refresh();
    const st = loginStateOf(getCachedUsage(account.configDir));
    const again = vscode.l10n.t('Check Again');
    const againItems = offerAgain ? [again] : [];
    const reloginItem = vscode.l10n.t('Re-login Account');
    let pick: string | undefined;
    if (st.state === 'ok') {
      vscode.window.showInformationMessage(vscode.l10n.t('Login of "{0}": ok — {1}.', account.name, st.reason));
      return;
    } else if (st.state === 'loggedOut') {
      pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" is logged out — {1}.', account.name, st.reason),
        reloginItem,
      );
    } else if (st.state === 'probeFailed') {
      pick = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The login of "{0}" could not be checked: {1}. That says nothing about the login itself.',
          account.name,
          st.reason,
        ),
        ...againItems,
      );
    } else if (st.lastKnown === 'out') {
      pick = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The CLI says "{0}" is not logged in. A second check in {1} seconds confirms it before it is shown as logged out.',
          account.name,
          Math.round(LOGIN_CONFIRM_GAP_MS / 1000),
        ),
        ...againItems,
      );
    } else {
      pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('The login of "{0}" is not confirmed yet: {1}.', account.name, st.reason),
        ...againItems,
      );
    }
    if (pick === again) {
      await checkLoginNow(account, false);
    } else if (pick === reloginItem) {
      relogin({ name: account.name, configDir: account.configDir, provider: 'claude' });
    }
  };

  /**
   * Show Login Diagnostics: one line per Claude Code account in the output channel — its login
   * state and its last probes (time, how CLAUDE_CONFIG_DIR was given, what answered, the result
   * and why). No address, token or keychain value is in it (usage.loginDiagnosticsLine).
   */
  const showLoginDiagnostics = (): void => {
    const cache = readUsageCache();
    output.appendLine(`[login diagnostics] ${new Date().toISOString()}`);
    for (const account of listAccounts()) {
      output.appendLine(`  ${loginDiagnosticsLine(account.name, ownCacheEntry(cache, account.configDir))}`);
    }
    output.show(true);
  };

  /**
   * Sign an account in again with its provider's own login command. A provider that has none
   * signs in somewhere else; then nothing is opened and the user is told where to go.
   */
  const relogin = (account: ShellAccount): void => {
    const info = providerInfo(account.provider);
    // Signing in again is the user saying the login is being fixed. A logged-out verdict that
    // a failed RUN left on another vendor's account is held against that CLI's own status
    // check; from here on the status check is believed again, so the sign-in shows up at the
    // next refresh rather than half an hour later. (A no-op for a Claude Code account, and
    // for an account with no such verdict.) Done for a provider with no login command as well:
    // the user is about to be sent to sign in in that vendor's app.
    if (account.provider !== 'claude') {
      clearProviderRunLoginFailure({ name: account.name, configDir: account.configDir });
    }
    if (info.loginArgs === null) {
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          '{0} has no login command: the `{1}` CLI uses the sign-in of {0}\'s own app. Sign in there, then run "Refresh Account Usage" — no terminal was opened for "{2}".',
          info.label,
          info.cli,
          account.name,
        ),
      );
      return;
    }
    if (openReloginTerminal(account.name, account.configDir, account.provider) === undefined) {
      // No terminal: the command line could not be written for this shell, and that was said.
      return;
    }
    vscode.window.showInformationMessage(
      vscode.l10n.t('Complete the login in the terminal — usage refreshes within a few minutes.'),
    );
  };

  /**
   * The existing Add Worker flow for a Claude Code account: a name, a default model, a config
   * directory derived from the name, and a first sign-in in a terminal.
   */
  const addClaudeWorker = async (): Promise<void> => {
    const unusable = unsupportedNames();
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t(
        'Worker account name (e.g. "w1") — a config directory ~/.claude-<name> will be created',
      ),
      validateInput: (v) => workerNameProblem(v.trim(), undefined, unusable),
    });
    if (!name) {
      return;
    }
    // Checked again before the name becomes part of a directory path (see addProviderWorker).
    const nameProblem = workerNameProblem(name.trim(), undefined, unusable);
    if (nameProblem !== undefined) {
      vscode.window.showWarningMessage(nameProblem);
      return;
    }
    const choice = await pickModel('claude', vscode.l10n.t('Default model for this worker'));
    if (!choice) {
      return;
    }
    // The config dir is derived from the name and KEPT across renames, so a
    // leftover ~/.claude-<name> from a since-renamed worker is a directory Claude Code
    // has already run under — and the account it was used with comes with it.
    // If that dir belongs to a REGISTERED worker, add() throws and the catch
    // below surfaces it; this modal is only for an unregistered leftover directory.
    // It says "used before", never "holds a login": the sign-in lives in the system
    // keychain, so no file here can show whether there is one or whether it still works.
    const dir = configDirForName(name.trim());
    if (dirUsedByClaudeCode(dir)) {
      const useExistingLabel = vscode.l10n.t('Use Existing Directory');
      const proceed = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The config directory {0} already exists and has been used by Claude Code before — possibly by a worker that was later renamed (a worker keeps its original directory when renamed). Adding this worker reuses that directory as it is instead of starting from a fresh one. Whether an account is signed in there is checked after adding.',
          dir,
        ),
        { modal: true },
        useExistingLabel,
      );
      if (proceed !== useExistingLabel) {
        return;
      }
    }
    try {
      const worker = workers.add(name.trim(), choice.model);
      const loginLabel = vscode.l10n.t('Open Login Terminal');
      const laterLabel = vscode.l10n.t('Later');
      const login = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Worker "{0}" added. Sign in once with the Claude account for this slot — a terminal will open running Claude Code under this worker\'s config directory.',
          worker.name,
        ),
        loginLabel,
        laterLabel,
      );
      if (login === loginLabel) {
        workers.openTerminal(worker);
      }
      void maybeOfferDispatchSetup(context, stableServer).catch(() => undefined);
    } catch (err) {
      showActionFailure(err);
    }
  };

  /**
   * Add a worker account on another vendor's CLI: a name, WHICH login it uses, a default
   * model, then the provider's own sign-in.
   *
   * Which login is the question that differs per provider. One that keeps accounts apart
   * through an environment variable can use the login already on this machine or a login of
   * its own in a new home directory; where that separation is not a verified behaviour of the
   * CLI the user is told so before anything is created. One with a single login per machine
   * can only use that login, and can have only one worker.
   *
   * A Codex login of the worker's own gets one more question — WHERE the CLI keeps it: the
   * system keychain, or Codex's default, a token file in the account folder. The choice is
   * written into that home's own `config.toml` before any sign-in (workerManager's
   * `writeCodexKeyringConfig`, which never touches an existing file); the registry records
   * nothing about it. It is never asked for the login already on this machine, whose
   * configuration is the user's, nor for any other provider.
   */
  const addProviderWorker = async (info: ProviderInfo): Promise<void> => {
    const provider = info.id;
    const existing = workers.list();
    if (info.isolation === 'none') {
      const holder = existing.find((w) => workerProvider(w) === provider);
      if (holder) {
        // Refused before a name is even asked for: there is nothing the user could answer
        // that would make a second account possible.
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            '{0} has a single login per machine — its CLI cannot keep a second account apart — so there can be only one {0} worker, and "{1}" already is it. Nothing was added.',
            info.label,
            holder.name,
          ),
        );
        return;
      }
    }
    const taken = new Set(existing.map((w) => w.name));
    const unusable = unsupportedNames();
    const typedName = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Name for the new {0} worker account (e.g. "{1}")', info.label, `${provider}1`),
      validateInput: (v) => workerNameProblem(v.trim(), taken, unusable),
      ignoreFocusOut: true,
    });
    if (!typedName) {
      return;
    }
    const name = typedName.trim();
    // Checked again: the name becomes part of a directory path below, and the box's
    // validation is advice to the person typing, not a gate.
    const nameProblem = workerNameProblem(name, taken, unusable);
    if (nameProblem !== undefined) {
      vscode.window.showWarningMessage(nameProblem);
      return;
    }

    const ambient = defaultProviderHome(provider);
    let dir = ambient;
    // Set only by the Codex "where to keep the login" step, which exists only on the
    // separate-login path below.
    let keychainLogin = false;
    if (info.isolation === 'env') {
      // The login on this machine can back ONE worker. Any worker on that directory counts,
      // whatever it runs on: readings and account keys are filed under the directory.
      const ambientHolder = existing.find((w) => path.resolve(w.configDir) === path.resolve(ambient));
      const separate = providerHomeForName(provider, name);
      type LoginItem = vscode.QuickPickItem & { login: 'ambient' | 'separate' };
      const items: LoginItem[] = [];
      if (!ambientHolder) {
        items.push({
          label: vscode.l10n.t('Use the login already on this machine'),
          description: ambient,
          detail: vscode.l10n.t(
            'The account the `{0}` CLI is signed in to right now. Nothing is created.',
            info.cli,
          ),
          login: 'ambient',
        });
      }
      items.push({
        label: vscode.l10n.t('Sign in separately, in a new home directory'),
        // A path under the user's home directory, which is named whatever it is named.
        description: pickText(separate, PICK_PATH_MAX),
        // One line: what the choice gives, or — first — that it may not give it. The full
        // caution for an unverified provider is the modal that follows this pick.
        detail: info.isolationVerified
          ? vscode.l10n.t(
              'A second account: {0} points the CLI at a home directory of its own.',
              info.homeEnv ?? '',
            )
          : vscode.l10n.t(
              '⚠ Not verified for {0}: a new home ({1}) may NOT give a second login.',
              info.label,
              info.homeEnv ?? '',
            ),
        login: 'separate',
      });
      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: ambientHolder
          ? vscode.l10n.t(
              'Worker "{0}" already uses the {1} login on this machine — "{2}" needs a login of its own',
              ambientHolder.name,
              info.label,
              name,
            )
          : vscode.l10n.t('Which {0} login does "{1}" use?', info.label, name),
        ignoreFocusOut: true,
      });
      if (!chosen) {
        return;
      }
      if (chosen.login === 'separate') {
        if (!info.isolationVerified) {
          const continueLabel = vscode.l10n.t('Continue Anyway');
          const proceed = await vscode.window.showWarningMessage(
            vscode.l10n.t('A separate {0} login is not a verified feature', info.label),
            {
              modal: true,
              detail: vscode.l10n.t(
                'The `{0}` CLI accepts {1}, but {2} is not known to keep its sign-in in that directory. A worker created this way may run as the SAME account as the login already on this machine — then both draw on one quota while looking like two accounts. Continue only if you have checked that a second login works on your setup.',
                info.cli,
                info.homeEnv ?? '',
                info.label,
              ),
            },
            continueLabel,
          );
          if (proceed !== continueLabel) {
            return;
          }
        }
        if (dirHasContent(separate)) {
          const useExistingLabel = vscode.l10n.t('Use Existing Directory');
          const proceed = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'The directory {0} already exists and is not empty — possibly from a worker that was later renamed or removed. Adding this worker will use whatever {1} login it holds rather than start a fresh sign-in.',
              separate,
              info.label,
            ),
            { modal: true },
            useExistingLabel,
          );
          if (proceed !== useExistingLabel) {
            return;
          }
        }
        dir = separate;
        // Only for a home that cannot hold a sign-in yet — nothing at the path, or a real,
        // empty directory (`isFreshAccountHome`). In a folder that already holds something
        // (a token file, perhaps) the setting would promise what it cannot deliver, and
        // through a link it would be written into somebody else's home: there the question
        // is not asked, and nothing is said about a keychain.
        if (provider === 'codex' && isFreshAccountHome(separate)) {
          // Codex is the one CLI here that keeps a sign-in in a plain token file by default,
          // and it can be told to use the OS keychain instead — per home directory, in its
          // own config. A login of the worker's own is the moment to ask: the setting has to
          // be in place BEFORE the first sign-in writes anything.
          type StoreItem = vscode.QuickPickItem & { store: 'keychain' | 'file' };
          // What each choice COSTS is the deciding fact, so it is the two words beside the
          // label; the one line under it says where the sign-in then lives.
          const storeItems: StoreItem[] = [
            {
              label: vscode.l10n.t('System keychain'),
              description: vscode.l10n.t('no plan-usage reading'),
              detail: vscode.l10n.t(
                'The sign-in is kept in the OS keychain; no token file is written to the account folder.',
              ),
              store: 'keychain',
            },
            {
              label: vscode.l10n.t("File in the account folder (Codex's default)"),
              description: vscode.l10n.t('plan usage readable'),
              detail: vscode.l10n.t(
                'The sign-in token is a plain file, auth.json, in the account folder.',
              ),
              store: 'file',
            },
          ];
          const store = await vscode.window.showQuickPick(storeItems, {
            placeHolder: vscode.l10n.t('Where should Codex keep the sign-in of "{0}"?', name),
            ignoreFocusOut: true,
          });
          if (!store) {
            return;
          }
          keychainLogin = store.store === 'keychain';
        }
      }
    }

    // No account yet, so no directory is named: the CLI is not started in a home that is still
    // being set up (its keychain setting goes in first, below), and the built-in suggestions
    // are what is offered. "Set Default Model" asks the CLI once the worker exists.
    const choice = await pickModel(
      provider,
      vscode.l10n.t('Default model for this {0} worker', info.label),
    );
    if (!choice) {
      return;
    }
    try {
      const worker = workers.add(name, choice.model, dir, provider);
      // The keychain choice goes into the home's config FIRST — before the status reading
      // requested below starts the CLI in that home, and before any sign-in.
      let storeNote = '';
      if (keychainLogin) {
        const written = writeCodexKeyringConfig(worker.configDir);
        if (written.outcome === 'written') {
          storeNote = vscode.l10n.t(
            'Its sign-in will be kept in the system keychain: {0} was created with the setting.',
            written.file,
          );
        } else {
          if (written.outcome === 'failed') {
            output.appendLine(
              `[codex keychain] ${written.file} could not be created: ${written.detail}`,
            );
          }
          // Modal, so it is read before a sign-in is started: without the setting Codex
          // writes the token to a file, which is exactly what the user chose against.
          await vscode.window.showWarningMessage(
            written.outcome === 'exists'
              ? vscode.l10n.t(
                  'The keychain setting was NOT applied for "{0}": {1} already exists and was left exactly as it is.',
                  worker.name,
                  written.file,
                )
              : written.outcome === 'not-fresh'
                ? vscode.l10n.t(
                    'The keychain setting was NOT applied for "{0}": its folder is no longer a new, empty folder of its own, so {1} was not created.',
                    worker.name,
                    written.file,
                  )
                : written.outcome === 'ambient'
                  ? vscode.l10n.t(
                      'The keychain setting was NOT applied for "{0}": {1} belongs to the Codex login already on this machine, whose configuration this extension does not change.',
                      worker.name,
                      written.file,
                    )
                  : vscode.l10n.t(
                      'The keychain setting could NOT be applied for "{0}": {1} could not be created.',
                      worker.name,
                      written.file,
                    ),
            {
              modal: true,
              detail: vscode.l10n.t(
                'Unless that file says otherwise, Codex keeps this sign-in in a token file in the account folder. To keep it in the system keychain, add this line to the file yourself BEFORE you sign in:\n\n{0}',
                CODEX_KEYRING_CONFIG_LINE,
              ),
            },
          );
        }
      }
      // The new account has no reading yet; ask for one now rather than at the next tick.
      void refreshProviders();
      const ownLogin = adapterAccountDir(provider, worker.configDir) !== undefined;
      const optInRule = vscode.l10n.t(
        'A dispatch reaches it only when it names this worker or asks for provider "{0}".',
        provider,
      );
      const optIn = storeNote === '' ? optInRule : `${optInRule} ${storeNote}`;
      if (info.loginArgs === null) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Worker "{0}" added on {1}. {1} has no login command — the `{2}` CLI uses the sign-in of {1}\'s own app, so make sure you are signed in there. {3}',
            worker.name,
            info.label,
            info.cli,
            optIn,
          ),
        );
      } else {
        const loginCommand = `${info.cli} ${info.loginArgs.join(' ')}`;
        const loginLabel = vscode.l10n.t('Open Login Terminal');
        const laterLabel = vscode.l10n.t('Later');
        const login = await vscode.window.showInformationMessage(
          ownLogin
            ? vscode.l10n.t(
                'Worker "{0}" added on {1}. Sign in once for this slot — a terminal will open running `{2}` under this worker\'s home directory. {3}',
                worker.name,
                info.label,
                loginCommand,
                optIn,
              )
            : vscode.l10n.t(
                'Worker "{0}" added on {1}, using the login already on this machine. Open a login terminal (`{2}`) only if that CLI is not signed in yet. {3}',
                worker.name,
                info.label,
                loginCommand,
                optIn,
              ),
          loginLabel,
          laterLabel,
        );
        if (login === loginLabel) {
          openReloginTerminal(worker.name, worker.configDir, provider);
        }
      }
      void maybeOfferDispatchSetup(context, stableServer).catch(() => undefined);
    } catch (err) {
      showActionFailure(err);
    }
  };

  /**
   * Wrap an asset command so that it never rejects: the workspace's asset ledger is read and
   * rewritten by every one of them, and one that could not be understood stops the command
   * with nothing changed (`AssetStateUnreadableError`) — said with the file to open; any other
   * failure is said as it is.
   */
  const assetCommand =
    (run: () => unknown) =>
    async (): Promise<void> => {
      try {
        await run();
      } catch (err) {
        if (err instanceof AssetStateUnreadableError) {
          showAssetStateProblem(err);
        } else {
          vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }
    };

  /** Run one session action on a tree row or a `{ key }` argument, then nothing more. */
  const sessionCommand =
    (action: UiSessionAction) =>
    async (arg?: unknown): Promise<void> => {
      const key = sessionKeyOf(arg);
      if (key !== undefined) {
        await runSessionAction(action, key, teamProvider);
      }
    };

  context.subscriptions.push(
    // Adding a worker starts with WHICH agent CLI it runs on; Claude Code then takes the flow
    // it always had, every other provider the one that asks which login to use.
    guardedCommand('claudeCodeOrchestrator.addWorker', async () => {
      const picked = await vscode.window.showQuickPick(providerPickItems(), {
        placeHolder: vscode.l10n.t('Which agent CLI does the new worker account run on?'),
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }
      if (picked.info.id === 'claude') {
        await addClaudeWorker();
      } else {
        await addProviderWorker(picked.info);
      }
    }),

    guardedCommand('claudeCodeOrchestrator.importWorkers', async () => {
      const discovered = workers.discoverConfigDirs();
      if (discovered.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('No unregistered Claude Code config directories (~/.claude*) found.'),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        discovered.map((d) => ({
          // A directory is called whatever somebody called it: shown as one display-safe line
          // in which no `$(name)` opens an icon.
          label: pickText(d.suggestedName, 64),
          description: pickText(d.dir, PICK_PATH_MAX),
          // What the directory shows is whether Claude Code has run there — not whether an
          // account is signed in (that is in the system keychain, and is checked after adding).
          detail: d.usedBefore
            ? vscode.l10n.t(
                'has been used by Claude Code before — whether it is signed in is checked after adding',
              )
            : vscode.l10n.t(
                'not used by Claude Code yet — it asks you to sign in when first opened',
              ),
          entry: d,
        })),
        {
          placeHolder: vscode.l10n.t('Config directories to register as workers'),
          canPickMany: true,
        },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      for (const { entry } of picked) {
        // The name. The directory suggests one, and a directory can be called anything: it is
        // used only when the name rule takes it (workerNameProblem — the rule `add` applies
        // too) and it is free. Otherwise the user is asked for one, starting from a cleaned-up
        // form of the suggestion; leaving the box skips this directory and goes on to the next.
        const taken = new Set(workers.list().map((w) => w.name));
        const unusable = unsupportedNames();
        let name = entry.suggestedName;
        const suggestionProblem = workerNameProblem(name, taken, unusable);
        if (suggestionProblem !== undefined) {
          const typed = await vscode.window.showInputBox({
            value: suggestedWorkerName(entry.suggestedName),
            prompt: vscode.l10n.t(
              'Name for the worker account in {0} — the directory\'s own name cannot be used ({1}). Press Escape to skip this directory.',
              rowText(entry.dir, 200),
              suggestionProblem,
            ),
            validateInput: (v) => workerNameProblem(v.trim(), taken, unusable),
            ignoreFocusOut: true,
          });
          if (typed === undefined) {
            continue;
          }
          name = typed.trim();
          // Checked again: the box's validation is advice to the person typing, not a gate.
          const typedProblem = workerNameProblem(name, taken, unusable);
          if (typedProblem !== undefined) {
            vscode.window.showWarningMessage(typedProblem);
            continue;
          }
        }
        // Claude Code only: the directories found are Claude Code config directories.
        const choice = await pickModel(
          'claude',
          vscode.l10n.t('Default model for "{0}" ({1})', name, rowText(entry.dir, 200)),
        );
        if (!choice) {
          continue;
        }
        try {
          workers.add(name, choice.model, entry.dir);
        } catch (err) {
          showActionFailure(err);
          // The registry REFUSED the write (its lock stayed held, or the file could not be
          // read). Every further add would wait the same 15 seconds on the same lock and be
          // refused the same way, so the rest of the selection is left for a retry.
          if (isStateWriteRefusal(err)) {
            break;
          }
        }
      }
    }),

    guardedCommand('claudeCodeOrchestrator.removeWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        await removeWorkerConfirmed(worker);
      }
    }),

    // The Workers row of a registry entry this version cannot use (hidden from the palette):
    // the argument is that row, `{ kind: 'unsupportedWorker', index, name }`.
    guardedCommand('claudeCodeOrchestrator.removeUnsupportedEntry', (item?: unknown) =>
      removeUnsupportedEntryConfirmed(item),
    ),

    guardedCommand('claudeCodeOrchestrator.togglePreferred', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        togglePreferred(worker);
      }
    }),

    guardedCommand('claudeCodeOrchestrator.setWorkerModel', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        await setDefaultModel(worker);
      }
    }),

    // Offered on the rows of non-Claude workers (the menu matches their context value); from
    // the command palette any worker can be picked, and a Claude Code one gets the explanation.
    guardedCommand(
      'claudeCodeOrchestrator.setWorkerPermissionMode',
      async (item?: unknown) => {
        const worker = await resolveWorker(workers, item);
        if (worker) {
          await setPermissionMode(worker);
        }
      },
    ),

    guardedCommand('claudeCodeOrchestrator.renameWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (!worker) {
        return;
      }
      const taken = new Set(
        workers.list().map((w) => w.name).filter((n) => n !== worker.name),
      );
      const unusable = unsupportedNames();
      const newName = await vscode.window.showInputBox({
        value: worker.name,
        prompt: vscode.l10n.t(
          'New name for this worker — the config directory and login are unchanged',
        ),
        // The same rule as Add Worker (workerNameProblem), which the manager applies again.
        validateInput: (v) => workerNameProblem(v.trim(), taken, unusable),
      });
      if (!newName || newName.trim() === worker.name) {
        return;
      }
      try {
        workers.rename(worker.name, newName.trim());
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Worker "{0}" renamed to "{1}". Its config directory and login are unchanged.',
            worker.name,
            newName.trim(),
          ),
        );
      } catch (err) {
        showActionFailure(err);
      }
    }),

    guardedCommand('claudeCodeOrchestrator.loginWorker', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (!worker) {
        return;
      }
      if (workerProvider(worker) === 'claude') {
        // Claude Code asks for the login itself when it is opened on an account without one.
        workers.openTerminal(worker);
      } else {
        relogin(accountOf(worker));
      }
    }),

    // Re-authenticate an account whose subscription login expired. Reachable from the
    // workers tree (which passes the row), from a caller that names the account's directory
    // (`{ configDir }` or the directory as a string — which covers 'main', which has no
    // WorkerProfile), and from the command palette (no argument at all).
    guardedCommand('claudeCodeOrchestrator.reloginWorker', async (item?: unknown) => {
      // Every account of every provider: each is signed in again with its own CLI's login.
      const accounts = shellAccounts();
      // Account NAMES are not unique: shellAccounts unconditionally prepends the
      // orchestrator's own dir as 'main' and a registry worker may legally carry
      // that name too. The config DIRECTORY is the account's real identity, so it
      // is matched first everywhere; a name match is only the legacy fallback.
      const byDir = (dir: string): ShellAccount | undefined => {
        const matches = accounts.filter((a) => a.configDir === dir);
        // A directory alone cannot say WHICH CLI's login is meant when accounts of two
        // providers were registered on it. The Claude Code account is the one every
        // directory-keyed surface files under that directory (the usage reading, the
        // dashboard's account key), so it is the one a bare directory names; another
        // vendor's account there is reached by its own row or the pick below.
        const claude = matches.filter((a) => a.provider === 'claude');
        const candidates = claude.length > 0 ? claude : matches;
        // Entries of ONE provider on one directory are the same login — only the LABEL
        // differs, so prefer the more informative worker name over the generic 'main'.
        // With no Claude Code account there, the first entry is the directory's owner
        // (the first-owner rule of the usage cache).
        return candidates.find((a) => a.name !== 'main') ?? candidates[0];
      };
      let target: ShellAccount | undefined;
      const asRecord =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
      if (isWorkersTreeRow(item)) {
        // A row of the Workers tree: the account that row was listed as, signed in again with
        // ITS OWN CLI. The directory on the element is not what names it — two accounts can be
        // registered on one directory, and the Claude Code one would be chosen for both.
        // A row that is no account, or whose account has gone since the tree was drawn, names
        // nobody, and nothing is opened.
        const worker = await resolveWorker(workers, item);
        if (!worker) {
          return;
        }
        target = accountOf(worker);
      } else if (asRecord && typeof asRecord.configDir === 'string') {
        target = byDir(asRecord.configDir);
        if (!target) {
          // A card rendered before the account was removed or its dir changed.
          vscode.window.showWarningMessage(
            vscode.l10n.t('Unknown account directory "{0}"', asRecord.configDir),
          );
          return;
        }
      } else if (typeof item === 'string') {
        target = byDir(item) ?? accounts.find((a) => a.name === item);
        if (!target) {
          // A card rendered before the account was removed or renamed.
          vscode.window.showWarningMessage(vscode.l10n.t('Unknown account "{0}"', item));
          return;
        }
      } else {
        // A payload that names a worker (`{ id }`, `{ name }`). Taken only when it names
        // one — resolveWorker's own quick pick would otherwise pre-empt the
        // expired-first pick below and omit 'main'.
        const rec = item as { id?: unknown; name?: unknown } | undefined;
        if (rec && (typeof rec.id === 'string' || typeof rec.name === 'string')) {
          const worker = await resolveWorker(workers, item);
          if (worker) {
            target = accountOf(worker);
          }
        }
      }
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          accounts
            // Each account's OWN reading: a worker on another vendor's CLI that shares a
            // directory with a Claude Code account must not be marked with that account's state.
            .map((a) => ({ account: a, expired: isLoginExpired(getCachedWorkerUsage(a)) }))
            // Expired accounts first — they are the reason this command exists.
            .sort((a, b) => Number(b.expired) - Number(a.expired))
            .map(({ account, expired }) => ({
              // A name and a directory out of the registry file: one display-safe line each,
              // with no icon in it. The account itself travels on the item.
              label: pickText(account.name, 64),
              description: expired
                ? vscode.l10n.t('login expired · {0}', pickText(account.configDir, PICK_PATH_MAX))
                : pickText(account.configDir, PICK_PATH_MAX),
              detail:
                account.provider === 'claude' ? undefined : providerInfo(account.provider).label,
              account,
            })),
          { placeHolder: vscode.l10n.t('Account to re-login') },
        );
        if (!picked) {
          return;
        }
        target = picked.account;
      }
      relogin(target);
    }),

    // Check Login Now: from a Workers tree row, from a caller naming the account's directory
    // (`{ configDir }`), or from the palette (a pick of the Claude Code accounts, main first).
    guardedCommand('claudeCodeOrchestrator.checkLoginNow', async (item?: unknown) => {
      const accounts = listAccounts();
      let target: { name: string; configDir: string } | undefined;
      const asRecord =
        typeof item === 'object' && item !== null && !isWorkersTreeRow(item) ? (item as Record<string, unknown>) : undefined;
      if (isWorkersTreeRow(item)) {
        const worker = await resolveWorker(workers, item);
        if (!worker || workerProvider(worker) !== 'claude') {
          return;
        }
        target = { name: worker.name, configDir: worker.configDir };
      } else if (asRecord && typeof asRecord.configDir === 'string') {
        const dir = asRecord.configDir;
        target = accounts.find((a) => sameConfigDir(a.configDir, dir));
      }
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          accounts.map((a) => ({
            label: pickText(a.name, 64),
            description: pickText(a.configDir, PICK_PATH_MAX),
            account: a,
          })),
          { placeHolder: vscode.l10n.t('Account whose login to check') },
        );
        if (!picked) {
          return;
        }
        target = picked.account;
      }
      await checkLoginNow(target);
    }),

    guardedCommand('claudeCodeOrchestrator.showLoginDiagnostics', () => {
      showLoginDiagnostics();
    }),

    guardedCommand('claudeCodeOrchestrator.openWorkerSession', async (item?: unknown) => {
      const worker = await resolveWorker(workers, item);
      if (worker) {
        await openAccountSession(accountOf(worker));
      }
    }),

    // One entry point for everything the dashboard does to an ACCOUNT. The account is named
    // by its opaque key and resolved here: a key that matches nothing (a card drawn before
    // the account was removed, or a value the page should never have sent) does nothing.
    guardedCommand('claudeCodeOrchestrator.accountAction', async (arg?: unknown) => {
      // The payload is the dashboard host's own `{ action, account, value }`. A row of the
      // Workers tree is not one, whatever keys its registry entry holds.
      const rec =
        typeof arg === 'object' && arg !== null && !isWorkersTreeRow(arg)
          ? (arg as Record<string, unknown>)
          : undefined;
      const action = rec?.action;
      if (!rec || typeof action !== 'string' || !(ACCOUNT_ACTIONS as readonly string[]).includes(action)) {
        return;
      }
      let account: ReturnType<typeof resolveAccount>;
      try {
        account = resolveAccount(rec.account);
      } catch {
        account = undefined;
      }
      if (!account) {
        return;
      }
      // The hosting session's own account ("main") is an account but not necessarily a
      // worker; name AND directory must both match a registry entry for it to be one. The
      // entry also says which CLI the account runs on. With no entry (main, or a worker the
      // registry stopped listing between the two reads) it is what the account list itself
      // said — never Claude Code by default: a Codex account's directory must not be handed
      // to `claude` because its registry entry could not be found.
      const dir = account.configDir;
      const worker = account.isWorker
        ? workers.list().find((w) => w.name === account.name && sameConfigDir(w.configDir, dir))
        : undefined;
      let provider: ProviderId;
      try {
        provider = workerProvider(worker ?? account);
      } catch {
        // An account whose CLI is not one this version knows: nothing is run against it.
        return;
      }
      const target: ShellAccount = { name: account.name, configDir: dir, provider };
      if (action === 'relogin') {
        relogin(target);
        return;
      }
      if (action === 'checkLogin') {
        // The login state is a Claude Code account's (Login state (CA)); the page offers this on those only.
        if (provider === 'claude') {
          await checkLoginNow({ name: account.name, configDir: dir });
        }
        return;
      }
      if (action === 'openSession') {
        await openAccountSession(target);
        return;
      }
      // The rest act on a registry WORKER.
      if (!worker) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('"{0}" is not a registered worker account.', account.name),
        );
        return;
      }
      if (action === 'togglePreferred') {
        togglePreferred(worker);
      } else if (action === 'setModel') {
        await setDefaultModel(worker, rec.value);
      } else if (action === 'setPermissionMode') {
        await setPermissionMode(worker, rec.value);
      } else if (action === 'remove') {
        await removeWorkerConfirmed(worker);
      }
    }),

    guardedCommand('claudeCodeOrchestrator.installMcp', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      // "Registered" is said only once the file is written; a file that was not understood
      // is left exactly as it is and named. And only a path that holds this version's server
      // is registered: when the stable copy could not be written, that is what is said.
      const problem = await registerMcpFor(folder, stableServer);
      if (problem !== undefined) {
        showRegistrationProblem(problem);
        return;
      }
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Registered "{0}" in .mcp.json. Restart the Claude Code session in this workspace and approve the project MCP server — dispatch_tasks / dispatch_task / list_workers will then be available.',
          MCP_SERVER_NAME,
        ),
      );
      await offerDispatchPolicy(folder);
    }),

    // The report of a task, opened by task ID. A Tasks row and the dashboard both name the
    // task; the file is found here (`openTaskReport`). `showTaskOutput` opens it in place — a
    // click on a row — and `openTaskOutput` beside the view that asked.
    guardedCommand('claudeCodeOrchestrator.showTaskOutput', (arg?: unknown) => openTaskReport(arg, false)),
    guardedCommand('claudeCodeOrchestrator.openTaskOutput', (arg?: unknown) => openTaskReport(arg, true)),

    guardedCommand('claudeCodeOrchestrator.clearTasks', async () => {
      let running = 0;
      try {
        running = runningTasks().length;
      } catch {
        running = 0;
      }
      const clearLabel = vscode.l10n.t('Clear History');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Clear the dispatched-task history?'),
        {
          modal: true,
          detail:
            running > 0
              ? vscode.l10n.t(
                  'Every recorded task is removed from the lists, for all workspaces — including {0} dispatch(es) still running, which can then no longer be cancelled from here. Task output files are kept.',
                  running,
                )
              : vscode.l10n.t(
                  'Every recorded task is removed from the lists, for all workspaces. Task output files are kept.',
                ),
        },
        clearLabel,
      );
      if (confirm !== clearLabel) {
        return;
      }
      try {
        clearTaskLog();
      } catch (err) {
        showActionFailure(err, (message) => vscode.l10n.t('The task history was not cleared. {0}', message));
      }
      tasksProvider.refresh();
      historyProvider.refresh();
      teamProvider.refresh();
    }),

    // Invoked with a row of the Tasks tree from its context menu (the row's `id` is the task
    // index's own: a string of the shape a task id has), { id } from the dashboard host, or no
    // argument at all from the command palette. The id only NAMES a task: what is cancelled is
    // the task the log holds under it, and only while the log says it is running.
    guardedCommand('claudeCodeOrchestrator.cancelTask', async (arg?: unknown) => {
      let id: string | undefined;
      if (arg === undefined || arg === null) {
        const running = runningTasks();
        if (running.length === 0) {
          vscode.window.showInformationMessage(vscode.l10n.t('No running dispatches.'));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          // The title and the account are stored as a caller supplied them: flattened and
          // capped before they are shown, as in the Tasks tree.
          // (A quick pick also draws `$(name)` as an icon, which the tree does not: the same
          // two caps, with the icons made inert before the cut.)
          running.map((t) => ({ label: pickText(t.title, 160), description: pickText(t.worker, 120), id: t.id })),
          {
            placeHolder: vscode.l10n.t('Running dispatch to cancel — its worker will be terminated'),
          },
        );
        id = picked?.id;
      } else {
        // An argument that names no task id (a malformed payload) cancels nothing — it must
        // not fall through to the picker as if the command had been run by hand. Nor does a
        // row of the Workers tree name one: an `id` key there is the registry file's.
        const given =
          typeof arg === 'object' && !isWorkersTreeRow(arg) ? (arg as { id?: unknown }).id : undefined;
        id = typeof given === 'string' && given !== '' ? given : undefined;
      }
      if (!id) {
        return;
      }
      try {
        // Mesh-aware: a session-worker (`claude --bg`) task is stopped by job id, a
        // one-shot worker by signal. cancelTaskMeshAware picks the path and writes
        // the same terminal event either way.
        const report: MeshCancelReport = {};
        const cancelled = await cancelTaskMeshAware(id, 'cancelled by user', report);
        tasksProvider.refresh();
        teamProvider.refresh();
        if (cancelled && report.accountNotRegistered === true) {
          // The task row is closed — that is our own record — but its session worker was NOT
          // stopped: the ledger names a directory that is no current Claude Code account's, and
          // `claude` is never run against one. Said as exactly that, with the way to stop it.
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Dispatched task cancelled here; the session itself was not stopped. {0}',
              accountNotRegisteredAdvice('stop', report.jobId ?? ''),
            ),
          );
          return;
        }
        if (cancelled && report.sessionWorker === true && report.stopError !== undefined) {
          // The task is closed in our record, and its session worker is NOT known to be
          // stopped: the stop failed, or no ledger record is this task's (a record that
          // merely carries the same worker name belongs to another task and is left alone).
          // "Cancelled" alone would say more than happened.
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Dispatched task cancelled here, but its session worker was not stopped: {0}. If it is still running, stop it from the Team view.',
              report.stopError,
            ),
          );
          return;
        }
        vscode.window.showInformationMessage(
          cancelled
            ? vscode.l10n.t('Dispatched task cancelled.')
            : vscode.l10n.t('That dispatch was no longer running — its row has been cleared.'),
        );
      } catch (err) {
        showActionFailure(err, (message) => vscode.l10n.t('Failed to cancel dispatch: {0}', message));
      }
    }),

    guardedCommand('claudeCodeOrchestrator.cancelAllTasks', async () => {
      const running = runningTasks();
      if (running.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No running dispatches.'));
        return;
      }
      const cancelLabel = vscode.l10n.t('Cancel Dispatches');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Cancel {0} running dispatch(es)? Their workers will be terminated.',
          running.length,
        ),
        { modal: true },
        cancelLabel,
      );
      if (confirm !== cancelLabel) {
        return;
      }
      // allSettled: one worker refusing to die must not strand the others.
      const reports: MeshCancelReport[] = running.map(() => ({}));
      const results = await Promise.allSettled(
        running.map((t, i) => cancelTaskMeshAware(t.id, 'cancelled by user', reports[i])),
      );
      tasksProvider.refresh();
      teamProvider.refresh();
      const cancelled = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      // A cancel that failed because the shared state refused the write (its lock stayed held)
      // would otherwise be only a number below: the first such refusal is said in its own words.
      for (const result of results) {
        if (result.status === 'rejected' && showStateWriteRefusal(result.reason)) {
          break;
        }
      }
      vscode.window.showInformationMessage(
        failed > 0
          ? vscode.l10n.t(
              'Cancelled {0} of {1} dispatch(es); {2} failed.',
              cancelled,
              running.length,
              failed,
            )
          : vscode.l10n.t('Cancelled {0} of {1} dispatch(es).', cancelled, running.length),
      );
      // Tasks closed in our own record whose session worker was deliberately left alone (its
      // recorded account directory is no current Claude Code account's): counted above as
      // cancelled, so the difference is stated, with the job ids to stop by hand.
      const untouched = reports
        .filter((r, i) => results[i].status === 'fulfilled' && r.accountNotRegistered === true)
        .map((r) => r.jobId ?? '');
      if (untouched.length > 0) {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            '{0} of those dispatch(es) are cancelled here only — their sessions were not stopped: their account is no longer registered as a Claude Code account, so each has to be stopped from a terminal with `claude stop <job id>` under that account. Job ids: {1}',
            untouched.length,
            untouched.join(', '),
          ),
        );
      }
    }),

    guardedCommand('claudeCodeOrchestrator.toggleTaskScope', () => {
      tasksProvider.scopeToWorkspace = !tasksProvider.scopeToWorkspace;
      tasksView.description = tasksProvider.scopeToWorkspace
        ? vscode.l10n.t('this workspace')
        : vscode.l10n.t('all workspaces');
      tasksProvider.refresh();
    }),

    guardedCommand('claudeCodeOrchestrator.openDashboard', () =>
      openDashboard(context),
    ),

    guardedCommand('claudeCodeOrchestrator.refreshUsage', async () => {
      // The refresh button of the Worker Accounts view: its dispatch totals are re-read from
      // the whole task log as well (WorkersProvider.refresh), not only the accounts' usage.
      workersProvider.refresh();
      try {
        await refreshAllUsage();
        // One after the other: both write the same cache file, and the message below should
        // mean that every account has been asked. Forced, like the Claude probe above: this
        // command is the one refresh that never settles for a cached reading.
        await refreshProviders(true);
        vscode.window.showInformationMessage(vscode.l10n.t('Account usage refreshed.'));
      } catch (err) {
        showActionFailure(err, (message) =>
          vscode.l10n.t('Failed to refresh account usage: {0}', message),
        );
      }
    }),

    // Add the dispatch policy block to CLAUDE.md, or bring the one there up to this version's
    // text. A block that already is this version's is left alone, and anything else that
    // carries the policy's markers (prompts.policyState: another version's block, an edited
    // one, more than one, a marker with no block) is touched only on a confirmation: an old
    // block and an edited one cannot be told apart.
    guardedCommand('claudeCodeOrchestrator.addDispatchPolicy', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const done = await installDispatchPolicy(folder);
      switch (done.outcome) {
        case 'refused':
          showFileProblem(done.problem, path.join(folder.uri.fsPath, 'CLAUDE.md'));
          return;
        case 'current':
          vscode.window.showInformationMessage(
            vscode.l10n.t('The dispatch policy in CLAUDE.md is already current. Nothing was changed.'),
          );
          return;
        case 'replaced':
          vscode.window.showInformationMessage(policyReplacedMessage());
          return;
        case 'written':
          vscode.window.showInformationMessage(vscode.l10n.t('Dispatch policy written to CLAUDE.md.'));
          return;
        default:
          // declined: the user was asked and did not say "Replace"
          return;
      }
    }),

    guardedCommand('claudeCodeOrchestrator.openAssetManager', () =>
      openAssetManager(context),
    ),

    guardedCommand('claudeCodeOrchestrator.manageAssets', assetCommand(async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const packs = loadAssetPacks(context, true);
      const assets = packs.flatMap((p) => p.assets);
      if (assets.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'No assets found. Add skills/agents/commands to the bundled pack or point "claudeCodeOrchestrator.assetPacks" at an asset directory (e.g. a private repo clone).',
          ),
        );
        return;
      }
      const ws = folder.uri.fsPath;
      const state = readAssetState(ws);
      const owners = relOwners(assets, state);
      const items = assets.map((asset) => {
        const status = assetStatus(asset, state, ws, owners);
        // A pack's name, an asset's id and its description are read from files of the pack:
        // the only icon on the row is the one put in front of the id here.
        const pack = noIcons(asset.pack);
        const description =
          status === 'customized'
            ? vscode.l10n.t('{0} · {1} · customized (sync paused)', pack, asset.type)
            : status === 'update-available'
              ? vscode.l10n.t('{0} · {1} · update available', pack, asset.type)
              : status === 'conflict'
                ? vscode.l10n.t(
                    '{0} · {1} · conflict (same install path as another enabled asset)',
                    pack,
                    asset.type,
                  )
                : `${pack} · ${asset.type}`;
        return {
          label: `$(${ASSET_TYPE_ICONS[asset.type]}) ${noIcons(asset.id)}`,
          description,
          detail: typeof asset.description === 'string' ? noIcons(asset.description) : asset.description,
          picked: state.assets[asset.key]?.enabled === true,
          asset,
        };
      });
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: vscode.l10n.t(
          "Assets to install into this workspace's .claude/ — unchecking removes files you haven't modified",
        ),
      });
      if (!picked) {
        return;
      }
      const chosen = new Set(picked.map((item) => item.asset.key));
      for (const asset of assets) {
        setAssetEnabled(ws, asset.key, chosen.has(asset.key));
      }
      const report = syncWorkspace(packs, ws);
      vscode.window.showInformationMessage(
        vscode.l10n.t('Workspace assets synced: {0}.', describeSync(report)),
      );
    })),

    guardedCommand('claudeCodeOrchestrator.syncAssets', assetCommand(() => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const report = syncWorkspace(loadAssetPacks(context, true), folder.uri.fsPath);
      vscode.window.showInformationMessage(
        vscode.l10n.t('Workspace assets synced: {0}.', describeSync(report)),
      );
    })),

    guardedCommand('claudeCodeOrchestrator.resetAsset', assetCommand(async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const ws = folder.uri.fsPath;
      const packs = loadAssetPacks(context, true);
      const state = readAssetState(ws);
      const allAssets = packs.flatMap((p) => p.assets);
      const owners = relOwners(allAssets, state);
      const customized = allAssets.filter(
        (asset) => assetStatus(asset, state, ws, owners) === 'customized',
      );
      if (customized.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('No customized assets in this workspace — nothing to reset.'),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        customized.map((asset) => ({
          label: noIcons(asset.id),
          description: `${noIcons(asset.pack)} · ${asset.type}`,
          detail: vscode.l10n.t('Overwrites your local edits with the pack version.'),
          asset,
        })),
        {
          placeHolder: vscode.l10n.t(
            'Customized asset to reset to its pack version (local edits are lost)',
          ),
        },
      );
      if (!picked) {
        return;
      }
      const report = syncWorkspace(packs, ws, new Set([picked.asset.key]));
      vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" reset: {1}.', picked.asset.id, describeSync(report)),
      );
    })),

    // Live-session actions. `sessionAction` is the single entry point: the dashboard calls
    // it with `{ action, key }`, and a Team row (which carries a key but names no action)
    // gets a quick pick. The five commands after it are the same handler with the action
    // fixed, because a menu entry cannot pass one. An unknown key does nothing.
    guardedCommand('claudeCodeOrchestrator.sessionAction', async (arg?: unknown) => {
      const key = sessionKeyOf(arg);
      if (key === undefined) {
        return;
      }
      const action = sessionActionOf(arg) ?? (await pickSessionAction(arg));
      if (action !== undefined) {
        await runSessionAction(action, key, teamProvider);
      }
    }),
    guardedCommand('claudeCodeOrchestrator.attachSession', sessionCommand('attach')),
    guardedCommand('claudeCodeOrchestrator.sessionLogs', sessionCommand('logs')),
    guardedCommand('claudeCodeOrchestrator.stopSession', sessionCommand('stop')),
    guardedCommand('claudeCodeOrchestrator.openSessionDiff', sessionCommand('openDiff')),
    guardedCommand('claudeCodeOrchestrator.copySessionName', sessionCommand('copyName')),

    guardedCommand('claudeCodeOrchestrator.refreshTeam', () => {
      // A refresh the user asked for: the task titles on the rows come from the task index,
      // which is read again from the first byte of the log.
      rebuildTaskIndex();
      teamProvider.refresh();
    }),

    // Bring what a workspace has installed up to this version in one step (§15.7): look, show
    // one list of what would change, apply only what was checked (updateWorkspaceSetup). An
    // offer passes the folder it is about as a URI; the palette and the dashboard pass nothing.
    guardedCommand('claudeCodeOrchestrator.updateWorkspaceSetup', async (arg?: unknown) => {
      if (workspaceSetupRunning) {
        // The list of the run in progress is still open (or its writes are under way).
        return;
      }
      workspaceSetupRunning = true;
      try {
        await updateWorkspaceSetup(arg, { stableServer, log: stableCopyLog, output });
      } finally {
        workspaceSetupRunning = false;
      }
    }),

    // Put the team-proxy agent definition into this workspace: a native agent-team teammate
    // (or plain subagent) that runs one task on ANOTHER account through the dispatch server.
    guardedCommand('claudeCodeOrchestrator.installTeamAgent', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const look = lookAtTeamAgent(folder.uri.fsPath);
      if (look.outcome === 'foreign') {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'A different agent already lives at {0} — it was left unchanged. Move or rename it, then run this command again.',
            TEAM_AGENT_FILE,
          ),
        );
        return;
      }
      if (look.outcome === 'symlink') {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            '{0} is a symbolic link, and this command does not write through one — nothing was changed. Replace the link with a regular file or remove it, then run this command again.',
            TEAM_AGENT_FILE,
          ),
        );
        return;
      }
      if (look.outcome === 'outside') {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'The team proxy agent was not written: a directory on the way to {0} is a symbolic link that leads outside this workspace folder. Nothing was changed.',
            TEAM_AGENT_FILE,
          ),
        );
        return;
      }
      if (look.outcome === 'failed') {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Could not write {0}: {1}', TEAM_AGENT_FILE, look.detail),
        );
        return;
      }
      if (look.outcome === 'differs') {
        // Our markers around text that is not this version's: an older or newer version's
        // definition, or one the user edited. The two cannot be told apart, so it is asked.
        const replaceLabel = vscode.l10n.t('Replace');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Replace the team proxy agent at {0}?', TEAM_AGENT_FILE),
          {
            modal: true,
            detail: vscode.l10n.t(
              "The file differs from this version's definition — it was edited or comes from another version. Replacing it discards those differences.",
            ),
          },
          replaceLabel,
        );
        if (confirm !== replaceLabel) {
          return;
        }
      }
      if (look.outcome !== 'current') {
        const failed = writeTeamAgent(folder.uri.fsPath, look);
        if (failed !== undefined) {
          vscode.window.showErrorMessage(
            failed === 'changed'
              ? vscode.l10n.t(
                  '{0} changed while it was being written, so nothing was written. Run this command again.',
                  TEAM_AGENT_FILE,
                )
              : vscode.l10n.t('Could not write {0}: {1}', TEAM_AGENT_FILE, failed),
          );
          return;
        }
      }
      const message =
        look.outcome === 'current'
          ? vscode.l10n.t('The team proxy agent at {0} is already up to date.', TEAM_AGENT_FILE)
          : vscode.l10n.t(
              'Team proxy agent written to {0}. A Claude Code session in this workspace can now use the "{1}" agent to run a task on a worker account.',
              TEAM_AGENT_FILE,
              TEAM_AGENT_NAME,
            );
      // The agent dispatches through the session's own way to dispatch — the cco command (§15.6)
      // or, where that does not run, the MCP server — so the follow-up is the folder's: said
      // only where the folder cannot dispatch (§15.7, Nags), with what makes it able to.
      if (folderCanDispatch(folder)) {
        vscode.window.showInformationMessage(message);
        return;
      }
      if (process.platform !== 'win32') {
        // Not awaited: a notification stays up until it is closed, and the command is done.
        const updateLabel = vscode.l10n.t('Update Workspace Setup');
        void vscode.window
          .showInformationMessage(
            vscode.l10n.t(
              '{0} The Claude Code session in this workspace cannot dispatch yet: "Update Workspace Setup" sets up the cco command the agent runs.',
              message,
            ),
            updateLabel,
          )
          .then(
            (choice) => {
              if (choice === updateLabel) {
                void vscode.commands.executeCommand('claudeCodeOrchestrator.updateWorkspaceSetup', folder.uri);
              }
            },
            () => undefined,
          );
        return;
      }
      // Not awaited: a notification stays up until it is closed, and the command is done.
      const registerLabel = vscode.l10n.t('Register MCP Server');
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t(
            '{0} The dispatch MCP server it calls is not registered in this workspace yet.',
            message,
          ),
          registerLabel,
        )
        .then(
          (choice) => {
            if (choice === registerLabel) {
              void vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp');
            }
          },
          () => undefined,
        );
    }),

    // The startup prune, on demand: no 24-hour gate, visible progress, totals reported.
    guardedCommand('claudeCodeOrchestrator.cleanSessionLitter', async () => {
      const totals = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Cleaning up stale session files…'),
          cancellable: true,
        },
        (progress, token) => {
          token.onCancellationRequested(() => {
            litterCancelRequested = true;
          });
          return pruneSessionLitterNow(output, (t) =>
            progress.report({
              message: vscode.l10n.t('pass {0} — {1} removed so far', t.passes, t.removed),
            }),
          );
        },
      );
      try {
        // A manual run satisfies the daily prune, and its report is the "first time" notice.
        await context.globalState.update(LITTER_LAST_RUN_KEY, Date.now());
        if (totals.removed > 0) {
          await context.globalState.update(LITTER_NOTICE_KEY, true);
        }
      } catch {
        // the stamps only spare a later background run
      }
      // A session list that was too long to read in full may be readable now.
      teamProvider.refresh();
      const sentences = [
        totals.removed > 0
          ? vscode.l10n.t(
              'Removed {0} stale session files ({1} examined).',
              totals.removed,
              totals.scanned,
            )
          : vscode.l10n.t('No stale session files were found ({0} examined).', totals.scanned),
      ];
      if (totals.truncated) {
        sentences.push(vscode.l10n.t('More may remain — run the command again.'));
      }
      if (totals.errors > 0) {
        sentences.push(
          vscode.l10n.t(
            '{0} could not be read or removed; see the "Claude Code Orchestrator" output channel.',
            totals.errors,
          ),
        );
      }
      vscode.window.showInformationMessage(sentences.join(' '));
    }),

    // Forget which model checked in as this workspace's main session — for after switching
    // the main account. The next orchestrator_briefing call registers the session again.
    // Asked for in a modal whichever way it was invoked — the dashboard runs this command too.
    guardedCommand('claudeCodeOrchestrator.resetCheckin', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first.'));
        return;
      }
      const resetLabel = vscode.l10n.t('Reset Check-in');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Reset the session check-in of this workspace?'),
        {
          modal: true,
          detail: vscode.l10n.t(
            'The record of which model checked in as the main session of this workspace is removed. Until a session calls orchestrator_briefing again, the workspace has no checked-in orchestrator.',
          ),
        },
        resetLabel,
      );
      if (confirm !== resetLabel) {
        return;
      }
      try {
        clearOrchestrator(root);
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Session check-in reset for this workspace — the next orchestrator_briefing call registers the main session again.',
          ),
        );
      } catch (err) {
        showActionFailure(err, (message) =>
          vscode.l10n.t('Could not reset the session check-in: {0}', message),
        );
      }
    }),

    guardedCommand('claudeCodeOrchestrator.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`,
      ),
    ),

    // Teammate mode's switch, from the Team view's title bar, its welcome text and the palette.
    // The setting is machine-scoped, so it is written to User settings; the configuration event
    // that write fires updates the context key and the registry (syncTeamModeContext,
    // syncTeamSettings). Nothing changes before the user confirms the modal's own button.
    guardedCommand('claudeCodeOrchestrator.teamModeTurnOn', async () => {
      if (userSetting('teamMode') === true) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Teammate mode is already on.'));
        return;
      }
      const turnOnLabel = vscode.l10n.t('Turn On');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Turn on Teammate mode? It is experimental.'),
        {
          modal: true,
          detail: vscode.l10n.t(
            'Each member of a team works in its own git worktree and branch, and nothing is merged automatically. Members that can run shell commands run as your OS user: the isolation protects against accidents, not against a process of your own user, so do not run a team on a repository whose content you do not trust. macOS is the tested platform.',
          ),
        },
        turnOnLabel,
      );
      if (confirm !== turnOnLabel) {
        return;
      }
      try {
        await vscode.workspace
          .getConfiguration('claudeCodeOrchestrator')
          .update('teamMode', true, vscode.ConfigurationTarget.Global);
      } catch (err) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Teammate mode could not be turned on: {0}',
            err instanceof Error ? err.message : String(err),
          ),
        );
        return;
      }
      const openLabel = vscode.l10n.t('Open Settings');
      const picked = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Teammate mode is on. Next, start a team from your Claude Code session with `cco team_create <team file>`.',
        ),
        openLabel,
      );
      if (picked === openLabel) {
        await vscode.commands.executeCommand('claudeCodeOrchestrator.openSettings');
      }
    }),

    guardedCommand('claudeCodeOrchestrator.teamModeTurnOff', async () => {
      if (userSetting('teamMode') !== true) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Teammate mode is already off.'));
        return;
      }
      try {
        await vscode.workspace
          .getConfiguration('claudeCodeOrchestrator')
          .update('teamMode', false, vscode.ConfigurationTarget.Global);
      } catch (err) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Teammate mode could not be turned off: {0}',
            err instanceof Error ? err.message : String(err),
          ),
        );
        return;
      }
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Teammate mode is off. A team that is already running continues; only creating a team or adding a member is refused.',
        ),
      );
    }),

    // Clear the retained records of stopped workers for this workspace, then refresh the
    // history tree (its branch marks come from those records) and the Team view (a stopped
    // worker is listed there while its worktree exists).
    guardedCommand('claudeCodeOrchestrator.clearStoppedWorkers', async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        return;
      }
      try {
        await clearStoppedWorkers(cwd);
      } catch (err) {
        // The ledger is written under a lock that can refuse; then nothing was cleared.
        showActionFailure(err, (message) =>
          vscode.l10n.t('The stopped workers were not cleared. {0}', message),
        );
      }
      historyProvider.refresh();
      teamProvider.refresh();
    }),
  );
}

/**
 * Resolve which worker a command targets.
 *
 * A ROW OF THE WORKERS TREE is what the tree made it (views.isWorkersTreeRow & co.), never
 * what a key on it says. An account row is a registry entry as read, unknown keys and all, so
 * an `id` or a `kind` on it is whatever its file holds:
 *
 *  - an account row names the worker it was LISTED AS (views.accountRowName), and that worker
 *    is looked up afresh among the registry's workers by that name — and by nothing else;
 *  - any other row of the tree — an entry this version cannot use, a detail row, a row about
 *    the registry — names no worker. No quick pick is offered in its place.
 *
 * ANYTHING ELSE is a payload its sender built: `id` (a string), else `name` (a string), names
 * the worker. A payload that says it is the row of an unsupported entry (`kind`) names none:
 * such an entry's name may be the very name of a worker (a duplicate). That one key is read
 * only to refuse.
 *
 * With nothing that names a worker — the command palette, no argument — a quick pick asks.
 */
async function resolveWorker(workers: WorkerManager, item?: unknown): Promise<WorkerProfile | undefined> {
  if (isWorkersTreeRow(item)) {
    const listedAs = isAccountRow(item) ? accountRowName(item) : undefined;
    return listedAs === undefined ? undefined : workers.get(listedAs);
  }
  const rec = item as { id?: unknown; name?: unknown; kind?: unknown } | undefined;
  if (rec && rec.kind === 'unsupportedWorker') {
    return undefined;
  }
  if (rec && typeof rec.id === 'string') {
    return workers.get(rec.id);
  }
  if (rec && typeof rec.name === 'string') {
    return workers.get(rec.name);
  }
  const picked = await vscode.window.showQuickPick(
    workers.list().map((w) => ({
      // Registry values, shown display-safe and with no icon in them; the worker is looked up
      // by its own name.
      label: pickText(w.name, 64),
      description: `${providerInfo(workerProvider(w)).label} · ${
        w.model ? pickText(w.model, 64) : vscode.l10n.t('CLI default model')
      }`,
      name: w.name,
    })),
    { placeHolder: vscode.l10n.t('Worker account') },
  );
  return picked ? workers.get(picked.name) : undefined;
}

export function deactivate(): void {}
