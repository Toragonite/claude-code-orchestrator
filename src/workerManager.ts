import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyFrontierGuard,
  applyOverageGuard,
  clampTimeoutMinutes,
  findWorkerByConfigDir,
  isStateWriteRefusal,
  readRegistry,
  readRegistryChecked,
  Registry,
  REGISTRY_FILE,
  renameWorker,
  resolveClaudePathPreservingAsync,
  resolveClaudePathWithoutLookup,
  ROOT_DIR,
  setWorkerModel,
  updateRegistry,
  WorkerProfile,
  workerProvider,
} from './registry';
import { readTextSafe, statFileSafe } from './safeFs';
import { deleteUsageEntries, ownsUsageReading, sanitizeEmailForShell } from './usage';
import {
  accountConfigFile,
  claudeTerminalEnv,
  MODEL_FORMS_HINT,
  normalizeModel,
  normalizePermissionMode,
  terminalCommandLine,
  terminalShell,
  TerminalShell,
  vendorTerminalEnv,
} from './platform';
import {
  adapterAccountDir,
  DEFAULT_PROVIDER,
  defaultProviderHome,
  normalizeProviderModel,
  normalizeProviderPermissionMode,
  ProviderId,
  providerInfo,
  providerModelHint,
} from './providers';
import { flattenOneLine, sliceOneLine } from './displayText';
import { explicitUserSetting, userClaudePath, userSetting } from './settings';

/* ------------------------------------------------------------------------- *
 * Terminals — the one place a command line is typed
 * ------------------------------------------------------------------------- */

/** What a shell dialect is called in a message. Product names, not translated. */
const SHELL_NAMES: Readonly<Record<TerminalShell, string>> = {
  posix: 'sh / bash / zsh',
  powershell: 'PowerShell',
  cmd: 'cmd.exe',
};

/** A value as it is quoted back in a message: one display-safe line, capped. */
function shownValue(value: string): string {
  return sliceOneLine(flattenOneLine(value), 80);
}

/**
 * The line that runs `command` with `args` in the user's terminal — each argument reaching the
 * program as exactly one argument — spelled by `platform.terminalCommandLine` for the shell the
 * editor starts there (`vscode.env.shell`). Nothing in this extension assembles such a line by
 * hand.
 *
 * Returns undefined when some part has no safe spelling in that shell (a control character
 * anywhere; on PowerShell and cmd also a few characters those shells cannot be made to pass
 * through). The caller then types NOTHING: the user has already been told here which part it
 * was, and an approximation of a command is a command they never asked for.
 */
export function terminalLine(command: string, args: readonly string[] = []): string | undefined {
  const shell = terminalShell(vscode.env.shell);
  const line = terminalCommandLine(shell, command, args);
  if (line !== undefined) {
    return line;
  }
  if (terminalCommandLine(shell, command) === undefined) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Nothing was typed into the terminal: the command "{0}" cannot be written safely for this shell ({1}).',
        shownValue(command),
        SHELL_NAMES[shell],
      ),
    );
    return undefined;
  }
  const culprit = args.find((arg) => terminalCommandLine(shell, 'x', [arg]) === undefined) ?? '';
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'Nothing was typed into the terminal: the argument "{0}" cannot be written safely for this shell ({1}).',
      shownValue(culprit),
      SHELL_NAMES[shell],
    ),
  );
  return undefined;
}

/**
 * Open an integrated terminal and run `command args…` in it — THE way this extension starts
 * anything in a terminal, and the only caller of `sendText`. The line is built first
 * (`terminalLine`): when it cannot be written for the user's shell, no terminal is opened at
 * all and undefined is returned.
 *
 * `name` is a tab title built from a registry or session name: it is shown as one display-safe
 * line. `env` is handed over as it is — an environment value is never read by a shell.
 */
export function openCommandTerminal(
  options: { name: string; env: Record<string, string | null> },
  command: string,
  args: readonly string[] = [],
): vscode.Terminal | undefined {
  const line = terminalLine(command, args);
  if (line === undefined) {
    return undefined;
  }
  const terminal = vscode.window.createTerminal({
    name: sliceOneLine(flattenOneLine(options.name), 80),
    env: options.env,
  });
  terminal.show();
  terminal.sendText(line);
  return terminal;
}

/**
 * An initial prompt as ONE line: every run of line breaks and tabs becomes a single space. The
 * prompt is typed into a terminal as one argument, and a line break inside a typed line would
 * submit it half-way.
 */
function promptAsOneLine(prompt: string): string {
  return prompt.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ').trim();
}

/** The account-level config (`.claude.json`) is read up to this size for the sign-in address. */
const ACCOUNT_CONFIG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The address the account in `configDir` was last signed in with, to pre-fill a re-login — or
 * undefined when it is not known. It is read from the file the CLI itself uses for that account
 * (`platform.accountConfigFile`): the home-level `~/.claude.json` for the default directory,
 * `<dir>/.claude.json` for every other one. A `.claude.json` INSIDE the default directory is
 * what a login made with the directory exported explicitly left behind, and may name another
 * account.
 *
 * The file is hand-editable, so the value is used only when it has the shape of an address
 * (`sanitizeEmailForShell`: one `@`, no whitespace, a conservative alphabet, no leading `-`,
 * at most 254 characters); anything else is "not known". Never throws.
 */
export function accountLoginEmail(configDir: string): string | undefined {
  const read = readTextSafe(accountConfigFile(configDir).file, ACCOUNT_CONFIG_MAX_BYTES);
  if (!read.ok) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(read.text.replace(/^\uFEFF/, ''));
    const account: unknown =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).oauthAccount : undefined;
    const email: unknown =
      typeof account === 'object' && account !== null
        ? (account as Record<string, unknown>).emailAddress
        : undefined;
    return typeof email === 'string' ? (sanitizeEmailForShell(email) ?? undefined) : undefined;
  } catch {
    // not JSON — the address is simply not known
    return undefined;
  }
}

/** Bounds of the quota-cooldown setting — the same range the dashboard's setting check accepts. */
const COOLDOWN_MINUTES_DEFAULT = 30;
const COOLDOWN_MINUTES_MIN = 1;
const COOLDOWN_MINUTES_MAX = 1440;

/**
 * The cooldown the registry receives. settings.json is hand-editable, and the dispatch server
 * adds this number to a timestamp: a string would concatenate and NaN would make every
 * cooldown end immediately, so anything that is not a finite number falls back to the default
 * and the rest is clamped to the declared range.
 */
function clampCooldownMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return COOLDOWN_MINUTES_DEFAULT;
  }
  return Math.min(COOLDOWN_MINUTES_MAX, Math.max(COOLDOWN_MINUTES_MIN, Math.round(value)));
}

/**
 * Apply `mutate` to the shared registry — as ONE read-modify-write under the registry's lock —
 * unless the registry ALREADY SAYS everything `mutate` would make it say, in which case nothing
 * is written and THE LOCK IS NEVER TAKEN. Returns whether a write happened.
 *
 * This is how settings are pushed into the registry (WorkerManager.syncSettings, and the
 * session-worker settings in extension.ts). Both run at every activation of every editor
 * window and on every change of any setting of this extension, and nearly always have nothing
 * to say. The lock they would take is synchronous and can REFUSE: a waiter blocks the extension
 * host for up to 15 seconds and then throws. Writing only when there is something to write
 * means an editor that merely starts up never waits on a lock, and never fails on one.
 *
 * "Already says" is decided on the registry AS READ — the same normalized object every reader
 * of the file gets — before and after applying `mutate` to it, compared as JSON. It is
 * deliberately not a comparison with the file's bytes: how a registry is spelled on disk is
 * registry.ts's own business (it keeps keys in memory that it does not write), and a rule here
 * that depended on it would silently stop holding the day that spelling changed. The one thing
 * given up is that a sync alone no longer re-spells a file somebody hand-edited into an
 * equivalent form; every reader normalizes what it reads, and the next real write re-spells it.
 * A registry file that is not there at all is written, so the first activation still creates it.
 *
 * `mutate` runs twice when a write happens (once on a copy to decide, once under the lock on a
 * fresh read), so it must only assign: no lookups that take time, no side effects.
 *
 * Throws whatever `updateRegistry` throws — notably a refusal (`isStateWriteRefusal`: the lock
 * stayed held, or the file could not be read), after which nothing was changed. The callers
 * decide who needs to be told.
 */
export function updateRegistryIfChanged(mutate: (registry: Registry) => void): boolean {
  const preview = readRegistry();
  const before = JSON.stringify(preview);
  mutate(preview);
  if (JSON.stringify(preview) === before && statFileSafe(REGISTRY_FILE) !== undefined) {
    return false;
  }
  updateRegistry(mutate);
  return true;
}

/**
 * Open the shared registry file in an editor — the file the host itself reads and writes, never
 * a path somebody handed over. Never throws and never rejects: it follows a message that has
 * already named the file.
 */
export function openRegistryFile(): void {
  try {
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(REGISTRY_FILE)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // the message that offered this already names the file
  }
}

/** Is the registry file, as it is right now, one this version cannot read? Never throws. */
export function registryIsUnreadable(): boolean {
  try {
    return readRegistryChecked().problem !== null;
  } catch {
    return false;
  }
}

/**
 * When `err` is the registry REFUSING a write (`isStateWriteRefusal`: its lock stayed held, or
 * a state file could not be read), say so and return true; otherwise return false and leave the
 * failure to the caller's own error path.
 *
 * A refusal is shown as a warning in the registry's own words, unchanged: they name the file
 * and, for a lock, the process holding it, say that nothing was changed and what to do. While
 * the registry file itself is the one that cannot be read, the message offers to open it —
 * asked of the file as it is now, not read off the message's text. Never throws.
 */
export function showStateWriteRefusal(err: unknown): boolean {
  if (!isStateWriteRefusal(err)) {
    return false;
  }
  const message = err instanceof Error ? err.message : String(err);
  const openLabel = vscode.l10n.t('Open File');
  const actions = registryIsUnreadable() ? [openLabel] : [];
  try {
    void vscode.window.showWarningMessage(message, ...actions).then(
      (choice) => {
        if (choice === openLabel) {
          openRegistryFile();
        }
      },
      () => undefined,
    );
  } catch {
    // a notification that cannot be shown must not turn a refusal into a throw
  }
  return true;
}

/**
 * A worker's default model as it is stored: an alias or a full model id, normalized. A value
 * `normalizeModel` rejects is an ERROR here, never a silent swap to the default — the caller
 * named a model, and storing a different one would hide a typo behind a different bill.
 *
 * Read EXACTLY: what reaches this module is a model a person chose (a picker, a typed id, the
 * dashboard), so a full id is the model itself — the three v1.x tier ids included, which are
 * models the CLI still offers — and is stored pinned (isPinnedClaudeModel).
 */
function requireModel(model: unknown): string {
  const normalized = normalizeModel(model, { exact: true });
  if (normalized === undefined) {
    throw new Error(
      vscode.l10n.t('Not a model this extension can store — use {0}.', MODEL_FORMS_HINT),
    );
  }
  return normalized;
}

/**
 * Is a Claude Code default model, as this module stores it, PINNED — one exact model rather
 * than a tier alias the CLI resolves to its newest? Every full id is: it was chosen as that
 * model. The registry entry then carries `modelPinned: true`, which is what makes a reader take
 * the id exactly (`normalizeModel(model, { exact: true })`) instead of as its tier.
 */
export function isPinnedClaudeModel(model: string): boolean {
  return model.startsWith('claude-');
}

/**
 * A non-Claude worker's permission / sandbox mode as it takes effect: the stored value when its
 * provider accepts it, otherwise the provider's default — which may be `null`, meaning no mode
 * flag is passed at all. Claude Code workers have no per-worker mode (the global setting applies).
 * Which CLI a worker runs on is always asked through the registry's `workerProvider`.
 */
export function workerPermissionMode(worker: WorkerProfile): string | null {
  return normalizeProviderPermissionMode(workerProvider(worker), worker.permissionMode);
}

/**
 * Permission modes that turn a provider's sandbox OFF — the ONE list of them. With such a mode,
 * commands the model generates run on this machine with no sandbox around them, and a worker
 * keeps its mode for every later dispatch. So one of these is never stored on a single click:
 * the shell asks for a modal confirmation first (extension.ts, the only place a mode is chosen
 * — the dashboard forwards its choice there unconfirmed), and `setPermissionMode` below refuses
 * to store one unless the caller states that the confirmation was given.
 *
 * Keyed by provider because a mode name means something only in its own CLI's vocabulary
 * (Codex `--sandbox danger-full-access`, Cursor `--sandbox disabled`). A mode that keeps or
 * tightens the sandbox is not listed, and neither is "provider default" (no mode stored).
 * Claude Code workers have no per-worker mode at all; Antigravity's two modes both keep its
 * sandbox. A provider that gains such a mode must be added HERE.
 */
const UNSANDBOXED_MODES: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: [],
  codex: ['danger-full-access'],
  cursor: ['disabled'],
  gemini: [],
};

/** Does `mode` turn off the sandbox of `provider`'s CLI (see UNSANDBOXED_MODES)? */
export function removesSandbox(provider: ProviderId, mode: unknown): boolean {
  return typeof mode === 'string' && UNSANDBOXED_MODES[provider].includes(mode);
}

/**
 * A worker's default model as it is stored FOR ITS PROVIDER.
 *
 *  - Claude Code: `requireModel` — there is always a default, and it is an alias or a full id.
 *  - every other provider: the model id when it has the shape of one, or `''` for "no default —
 *    let the CLI choose". Only the absence of a value means that (`undefined`, `null`, `''`); a
 *    value somebody named that is not a model id is an ERROR, exactly as for Claude Code.
 */
function storedModelFor(provider: ProviderId, model: unknown): string {
  if (provider === 'claude') {
    return requireModel(model);
  }
  if (model === undefined || model === null || model === '') {
    return '';
  }
  const normalized = normalizeProviderModel(provider, model);
  if (normalized === undefined) {
    throw new Error(
      vscode.l10n.t(
        'Not a model id this extension can store for {0} — use {1}, or leave the choice to the CLI.',
        providerInfo(provider).label,
        providerModelHint(provider),
      ),
    );
  }
  return normalized;
}

/**
 * Is `name` one of the names every plain object already answers to (`constructor`, `toString`,
 * `__proto__`, `hasOwnProperty`, …)? A worker name is used as a KEY — of the stats file, of
 * usage totals, of lookups in more than one process — and a key like that reads as "present"
 * in an object that holds nothing under it. Such a name passes the letters-digits-dash rule,
 * so it is refused by name here: at the input boxes, and again in add() and rename().
 */
export function isObjectKeyName(name: string): boolean {
  return name in Object.prototype;
}

/** The refusal for `isObjectKeyName`, shared by the input boxes and the manager. */
export function objectKeyNameMessage(name: string): string {
  return vscode.l10n.t('"{0}" cannot be used as a worker name — choose another.', name);
}

/**
 * The longest worker name: as much of one as a row shows (the tree and the dashboard cut a
 * name there), so two names can never read as the same account.
 */
export const WORKER_NAME_MAX = 64;

/**
 * THE rule for a worker name, in one place: `name` as it would be STORED — nothing is trimmed
 * here — is either acceptable (undefined) or refused, with the sentence that says why.
 *
 * Every writer of a name goes through it: the Add and Rename input boxes (on what was typed,
 * trimmed), `WorkerManager.add` and `WorkerManager.rename` themselves, and the import of
 * existing directories, where the name comes from a directory. A name is a KEY — of the stats
 * file, of the task log (which also writes a failover as names joined by commas), of tree
 * ids, of a `~/.claude-<name>` directory — so it is:
 *
 *  - letters, digits, `-` and `_` only, and at least one of them;
 *  - at most WORKER_NAME_MAX characters;
 *  - not `main`, which is how the orchestrator's own account is listed everywhere;
 *  - not a name every object already answers to (`isObjectKeyName`).
 *
 * `taken` holds the names already in use (omit it where a duplicate is reported later, under
 * the registry's lock); `unusable` the names of registry entries this version cannot use.
 *
 * A name ALREADY in the registry is not judged by this: an entry written before the rule, or
 * by hand, stays the user's worker under the name it has.
 */
export function workerNameProblem(
  name: unknown,
  taken?: ReadonlySet<string>,
  unusable?: ReadonlySet<string>,
): string | undefined {
  if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) {
    return vscode.l10n.t('Use letters, digits, - or _');
  }
  if (name.length > WORKER_NAME_MAX) {
    return vscode.l10n.t('Use at most {0} characters.', WORKER_NAME_MAX);
  }
  // 'main' is how the orchestrator's own account is listed everywhere; a
  // worker sharing that name makes the two indistinguishable by name.
  if (name === 'main') {
    return vscode.l10n.t('"main" is reserved for the orchestrator session\'s own account.');
  }
  // A name every plain object already answers to ("constructor", "toString", …) passes the
  // pattern above and then reads as present wherever worker names are used as keys.
  if (isObjectKeyName(name)) {
    return objectKeyNameMessage(name);
  }
  if (taken?.has(name)) {
    return vscode.l10n.t('A worker named "{0}" already exists.', name);
  }
  return unusable?.has(name) ? unsupportedNameMessage(name) : undefined;
}

/**
 * A name the rule accepts, made from text that is not one (a directory name): every run of
 * other characters becomes one `-`, the ends are trimmed, the length is cut. A SUGGESTION for
 * an input box, nothing more — it may still be taken, and `worker` stands in when nothing
 * usable is left.
 */
export function suggestedWorkerName(raw: string): string {
  const cleaned = raw
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, WORKER_NAME_MAX)
    .replace(/-+$/, '');
  return workerNameProblem(cleaned) === undefined ? cleaned : 'worker';
}

/**
 * The refusal for a worker name that an entry of the registry this version cannot use already
 * holds. Such an entry is kept in the file and is in no list of workers, but its name is taken
 * all the same: a usable worker under it would be the one a dispatch reaches by that name while
 * the entry a newer version wrote sits beside it. Shared by the input boxes and the manager;
 * the registry's own rename refuses the same names in its own words.
 */
export function unsupportedNameMessage(name: string): string {
  return vscode.l10n.t(
    'The registry already holds an entry named "{0}" that this version cannot use. Choose another name, or remove that entry in the Worker Accounts view first.',
    name,
  );
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
 * The home directory a worker of `provider` gets when it is given a login of its OWN (as opposed
 * to the login already on this machine, which lives in `defaultProviderHome`): `~/.<cli>-<name>`.
 * For Claude Code that is `configDirForName`.
 */
export function providerHomeForName(provider: ProviderId, name: string): string {
  return provider === 'claude'
    ? configDirForName(name)
    : path.join(os.homedir(), `.${providerInfo(provider).cli}-${name}`);
}

/**
 * The environment of an integrated terminal that must run `provider`'s CLI as the account in
 * `configDir` (a `null` value REMOVES an inherited variable).
 *
 *  - Claude Code: `claudeTerminalEnv`, unchanged.
 *  - every other provider: `vendorTerminalEnv` (the terminal twin of `vendorChildEnv`) — this
 *    editor's own session-identity variables are removed, and so are the Anthropic credential
 *    variables and `CLAUDE_CONFIG_DIR`: they authenticate Claude Code and are never handed to
 *    another vendor's CLI. Then the provider's home variable is set to the directory — except
 *    when the directory is the provider's default home or the provider has no isolation, where
 *    NO home variable is set at all: that account is "whatever login the CLI finds on this
 *    machine", and it must be found the same way the user's own shell finds it.
 *    `adapterAccountDir` makes that decision, so a terminal and a dispatch of the same worker
 *    can never disagree about which login they mean.
 */
export function accountTerminalEnv(
  provider: ProviderId,
  configDir: string,
): Record<string, string | null> {
  if (provider === 'claude') {
    return claudeTerminalEnv(configDir);
  }
  const env = vendorTerminalEnv();
  const info = providerInfo(provider);
  const home = adapterAccountDir(provider, configDir);
  if (home !== undefined && info.homeEnv !== null) {
    env[info.homeEnv] = home;
  }
  return env;
}

/** The command word that starts `provider`'s CLI in a terminal (see `terminalLine`). */
export function terminalProviderCommand(provider: ProviderId): string {
  // Only Claude Code has a path setting. The other CLIs are named as their vendor installs
  // them and resolved by the terminal's own shell, which has the user's PATH.
  return provider === 'claude' ? userClaudePath() : providerInfo(provider).cli;
}

/**
 * Has `dir` been USED by Claude Code before? True when it holds a `.claude.json` (the CLI's
 * account-level config, written the first time it runs under the directory) or a legacy
 * `.credentials.json` (where old CLI versions kept the sign-in).
 *
 * It says NOTHING about a login, and no caller may word it as one. Current CLI versions keep
 * every account's sign-in in the system keychain, so neither file shows whether a login exists
 * or is still valid: a used directory may be signed out, and the one way to know is the login
 * check that runs after the account is added (the usage reading). Only the EXISTENCE of the two
 * names is asked — neither file is opened, and the keychain is never consulted. Any fs error
 * (missing / unreadable dir) reads as "not used".
 */
export function dirUsedByClaudeCode(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, '.claude.json')) ||
      fs.existsSync(path.join(dir, '.credentials.json'))
    );
  } catch {
    return false;
  }
}

/** The one line of Codex's `config.toml` that keeps a login in the OS keychain, not a file. */
export const CODEX_KEYRING_CONFIG_LINE = 'cli_auth_credentials_store = "keyring"';

/** Codex's own config file, directly inside the account's home directory (`CODEX_HOME`). */
const CODEX_CONFIG_FILE = 'config.toml';

/**
 * Do two paths lead to the same directory ON DISK (symlinks followed)? `adapterAccountDir`
 * compares the strings; this catches a home that is a link to the machine's own. A path that
 * does not exist is the same as nothing.
 */
function isSameDirOnDisk(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/** Where `dir` really is once symbolic links are followed, or undefined while nothing is there. */
function realDirOrUndefined(dir: string): string | undefined {
  try {
    return fs.realpathSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * Is `dir` a home directory no login can be in yet — nothing at the path at all, or a REAL
 * directory (`lstat`: not a symbolic link) that holds nothing? Anything else is not: a
 * directory with a file in it may already hold a sign-in, and a link leads to a directory
 * that is somebody else's — another worker's home, or the machine's own login. A path that
 * cannot be examined is not fresh either: not knowing is not a licence to write.
 */
export function isFreshAccountHome(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && fs.readdirSync(dir).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
  }
}

/** What `writeCodexKeyringConfig` did; `file` is the config path it was about. */
export type CodexKeyringConfigResult =
  | { outcome: 'written'; file: string }
  /** Something is already at that path. It was neither read nor changed. */
  | { outcome: 'exists'; file: string }
  /** `home` is the machine's ordinary Codex login, whose config is never ours to write. */
  | { outcome: 'ambient'; file: string }
  /** `home` is a link, or already holds something: not a folder this flow created empty. */
  | { outcome: 'not-fresh'; file: string }
  | { outcome: 'failed'; file: string; detail: string };

/**
 * Ask Codex to keep the login of the account in `home` in the operating system's keychain
 * instead of its default token file (`auth.json` in the home), by CREATING `<home>/config.toml`
 * with the single line that says so. The CLI's own config is the source of truth for the
 * choice — nothing about it is stored in the registry.
 *
 * Narrow on purpose:
 *  - only a home that is a worker's OWN. The login already on this machine (`adapterAccountDir`
 *    says a directory is that one; a link that leads to it counts too) belongs to the user's
 *    own Codex setup: `ambient`, untouched.
 *  - only a home that is a real directory holding NOTHING at the moment of the write
 *    (`isFreshAccountHome`; the directory itself was created just before by `add`). In a home
 *    that already holds a file a sign-in may exist — as a token file the setting would not
 *    move — and through a link the line would land in another account's home: `not-fresh`,
 *    untouched, and the caller must not say the sign-in will be kept in the keychain.
 *  - only a file that does not exist yet. The open is exclusive (`wx` — O_CREAT | O_EXCL), so
 *    anything already at the path — a config the user wrote, a symlink, a directory — fails
 *    with EEXIST before a byte is written: `exists`, and the caller tells the user which line
 *    to add themselves. An existing config is never read, merged or rewritten.
 *  - created readable by the owner only (0600, further narrowed by the umask).
 *
 * Never throws. A file this call created but could not finish writing is removed again, so a
 * half-written config is never left for the CLI to read.
 */
export function writeCodexKeyringConfig(home: string): CodexKeyringConfigResult {
  const file = path.join(home, CODEX_CONFIG_FILE);
  if (adapterAccountDir('codex', home) === undefined || isSameDirOnDisk(home, defaultProviderHome('codex'))) {
    return { outcome: 'ambient', file };
  }
  // Asked again HERE, on the directory as it is now: the question that led to this call was
  // answered some dialogs ago.
  let exists = false;
  try {
    fs.lstatSync(home);
    exists = true;
  } catch {
    // nothing there: the open below fails and is reported as that
  }
  if (exists && !isFreshAccountHome(home)) {
    // An existing config is still reported as exactly that (`lstat`: a dangling link counts).
    let configPresent = false;
    try {
      fs.lstatSync(file);
      configPresent = true;
    } catch {
      // no config there
    }
    return { outcome: configPresent ? 'exists' : 'not-fresh', file };
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(fd, `${CODEX_KEYRING_CONFIG_LINE}\n`);
    fs.closeSync(fd);
    return { outcome: 'written', file };
  } catch (err) {
    if (fd === undefined && (err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      return { outcome: 'exists', file };
    }
    if (fd !== undefined) {
      // Ours, and incomplete: close it and take it away again.
      try {
        fs.closeSync(fd);
      } catch {
        // already closed (the failure was the close itself)
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // reported below either way
      }
    }
    return { outcome: 'failed', file, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Is a REAL directory at `dir` — the thing itself, not a symbolic link to one (`lstat`)? */
function isRealDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Does the directory `dir` look like one Claude Code has run under: does it hold the CLI's
 * account-level config (`.claude.json`) or its legacy sign-in file (`.credentials.json`) as a
 * regular file, or a `sessions/` or `projects/` directory of its own? `lstat` throughout — the
 * names are asked, nothing is opened and no link is followed.
 *
 * What the import of existing directories offers. A name that merely starts with `.claude`
 * is not enough: other tools keep directories under such names (`~/.claude-mem`), and a
 * worker registered on one would be an account that never signs in. `~/.claude` itself
 * qualifies by its `projects/` — its `.claude.json` lives beside it, in the home directory.
 */
export function looksLikeClaudeConfigDir(dir: string): boolean {
  const has = (name: string, kind: 'file' | 'directory'): boolean => {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      return kind === 'file' ? st.isFile() : st.isDirectory();
    } catch {
      return false;
    }
  };
  return (
    has('.claude.json', 'file') ||
    has('.credentials.json', 'file') ||
    has('sessions', 'directory') ||
    has('projects', 'directory')
  );
}

/**
 * After a login-shell lookup of the claude command found nothing that can be spawned, how long
 * before the same command is looked up again. The lookup starts the user's login shell, and a
 * machine without the CLI would otherwise start one on every settings sync.
 */
const CLAUDE_LOOKUP_RETRY_MS = 60_000;

/**
 * Extension-side management of worker accounts. A worker account is a login of one agent CLI:
 * for Claude Code a config directory (CLAUDE_CONFIG_DIR), for another vendor's CLI either that
 * CLI's own home directory or the login already on this machine. No tokens are copied or
 * stored by this extension. The registry file is shared with the MCP dispatch server.
 */
export class WorkerManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** Set by dispose(): nothing is started, and no lookup's answer is acted on, afterwards. */
  private disposed = false;
  /** The claude command of the last settings sync, to notice the USER changing it. */
  private lastClaudeCommand: string | undefined;
  /** The command the user changed the setting to, until a lookup has been made for it. */
  private claudeLookupOwedFor: string | undefined;
  /**
   * The last finished login-shell lookup: the command it was for, its answer, whether that
   * answer could be spawned when it came, and when it came.
   */
  private claudeLookup: { command: string; path: string; served: boolean; at: number } | undefined;
  /** The lookup in flight — there is never more than one. */
  private claudeLookupRunning: { abort: AbortController; done: Promise<void> } | undefined;
  private claudePathListener: (() => void) | undefined;

  /**
   * Stop: a lookup in flight is ended (its shell is killed), and whatever it answers is
   * dropped — nothing is written after this.
   */
  dispose(): void {
    this.disposed = true;
    this.claudePathListener = undefined;
    try {
      this.claudeLookupRunning?.abort.abort();
    } catch {
      // the lookup ends by itself at its time limit
    }
    this._onDidChange.dispose();
  }

  list(): WorkerProfile[] {
    return readRegistry().workers;
  }

  get(name: string): WorkerProfile | undefined {
    return this.list().find((w) => w.name === name);
  }

  /**
   * Register a worker account.
   *
   * `provider` defaults to Claude Code, whose entry is written exactly as it always was —
   * `{ name, configDir, model }`, no `provider` key — so a registry holding only Claude Code
   * workers stays readable by every earlier version. `configDir` defaults to the directory
   * derived from the name for Claude Code and to the login already on this machine
   * (`defaultProviderHome`) for every other provider; `model` may be absent only for those
   * (no default model: the CLI chooses).
   *
   * Throws — with the registry unchanged and no directory created — for a name the name rule
   * refuses (workerNameProblem), for a name that is taken (by a worker, or by an entry this
   * version cannot use), for a directory that is another worker's (as written, or once
   * symbolic links are followed for a worker of the same provider), and when the registry
   * refuses the write.
   */
  add(
    name: string,
    model: string | undefined,
    configDir?: string,
    provider: ProviderId = DEFAULT_PROVIDER,
  ): WorkerProfile {
    const info = providerInfo(provider);
    const storedModel = storedModelFor(provider, model);
    // The one rule for a name (workerNameProblem), applied where the name is STORED: the
    // input boxes apply it to what is typed, and this is what holds for every other way a
    // name arrives — the import of existing directories, a direct call.
    const nameProblem = workerNameProblem(name);
    if (nameProblem !== undefined) {
      throw new Error(nameProblem);
    }
    const ambient = defaultProviderHome(provider);
    const dir = configDir ?? (provider === 'claude' ? configDirForName(name) : ambient);
    const worker: WorkerProfile =
      provider === 'claude'
        ? { name, configDir: dir, model: storedModel }
        : { name, configDir: dir, model: storedModel, provider };
    // A full id a person chose is that model: the entry says so, and is read exactly.
    if (provider === 'claude' && isPinnedClaudeModel(storedModel)) {
      worker.modelPinned = true;
    }
    // ONE read-modify-write under the registry's lock. Every check below is made on the
    // registry as it is at the moment of the write, so a worker another editor added a moment
    // ago is seen; and a registry that refuses (it could not be read, or its lock stayed held)
    // throws before any of this runs — in particular before a directory is created.
    updateRegistry((registry) => {
      if (registry.workers.some((w) => w.name === name)) {
        throw new Error(vscode.l10n.t('A worker named "{0}" already exists.', name));
      }
      if (registry.unsupportedWorkers.some((entry) => entry.name === name)) {
        throw new Error(unsupportedNameMessage(name));
      }
      if (info.isolation === 'none') {
        // One login per machine: nothing can keep a second account apart from the first, so a
        // second worker would be the same login under another name — twice the dispatches drawn
        // from one quota, with the registry claiming otherwise.
        const holder = registry.workers.find((w) => workerProvider(w) === provider);
        if (holder) {
          throw new Error(
            vscode.l10n.t(
              '{0} has a single login per machine — its CLI cannot keep a second account apart — and worker "{1}" already uses it. Remove or rename "{1}" instead of adding another {0} worker.',
              info.label,
              holder.name,
            ),
          );
        }
        if (path.resolve(dir) !== path.resolve(ambient)) {
          throw new Error(
            vscode.l10n.t(
              '{0} has no separate logins: a {0} worker always uses the login already on this machine.',
              info.label,
            ),
          );
        }
      }
      // A worker keeps its original directory when renamed, so a previously-used
      // name (or an explicit dir) can already belong to another worker. Adding a
      // second worker on that dir would silently share its login — refuse it here.
      // Checked across providers: the usage cache and every account key are filed under the
      // directory alone, so two workers on one directory would overwrite each other's readings
      // whatever CLI each runs on.
      const owner = findWorkerByConfigDir(registry.workers, dir);
      if (owner) {
        throw new Error(
          provider === 'claude'
            ? vscode.l10n.t(
                'Config directory {0} already belongs to worker "{1}". A worker keeps its original directory when renamed, so this name would silently share that worker\'s login. Pick a different name, or remove/rename "{1}" first.',
                dir,
                owner.name,
              )
            : vscode.l10n.t(
                'The directory {0} already belongs to worker "{1}" — a second worker there would share that login. Choose a separate login, or remove "{1}" first.',
                dir,
                owner.name,
              ),
        );
      }
      // The same question once symbolic links are followed: a directory that is a link to
      // another worker's home IS that worker's login for the same CLI, under a path the
      // comparison above cannot see through. Asked only among workers of this provider — two
      // CLIs keep unrelated logins in one directory — and only of directories that exist: a
      // path with nothing at it yet cannot be another name for anything.
      const real = realDirOrUndefined(dir);
      const alias =
        real === undefined
          ? undefined
          : registry.workers.find(
              (w) => workerProvider(w) === provider && realDirOrUndefined(w.configDir) === real,
            );
      if (alias) {
        throw new Error(
          vscode.l10n.t(
            'The directory {0} leads to {1}, which already belongs to worker "{2}" — a second worker there would share that login. Choose a separate directory, or remove "{2}" first.',
            dir,
            alias.configDir,
            alias.name,
          ),
        );
      }
      // Only a directory that is this worker's OWN is created. The login already on the machine
      // lives in a directory its CLI owns: if it is not there, creating an empty one would not
      // make a login, and it is not ours to create.
      if (provider === 'claude' || adapterAccountDir(provider, dir) !== undefined) {
        fs.mkdirSync(dir, { recursive: true });
      }
      registry.workers.push(worker);
    });
    this._onDidChange.fire();
    return worker;
  }

  /**
   * Take a worker out of the registry. Its directory and login stay on disk. Throws — with
   * nothing changed — when the registry refuses the write.
   */
  remove(name: string): void {
    const removed = readRegistry().workers.find((w) => w.name === name);
    // Asked BEFORE the registry is rewritten (the answer is read from it): is the reading
    // filed under this worker's directory its own? A worker on another vendor's CLI that was
    // registered on a Claude Code account's directory never had one there — the entry is that
    // Claude account's, and removing the worker must not take it away.
    const ownedReading = removed !== undefined && ownsUsageReading(removed);
    // The workers that remain, as the write left them: taken from the registry read under the
    // lock, so the entries this version cannot use and anything another editor changed since
    // the read above are written back as they are.
    let remaining: WorkerProfile[] = [];
    updateRegistry((registry) => {
      registry.workers = registry.workers.filter((w) => w.name !== name);
      remaining = registry.workers;
    });
    // Drop the removed worker's usage-cache entry so a re-registered name/dir
    // doesn't inherit a stale quota-exhausted verdict — but only when no
    // remaining worker still uses that directory. A Claude Code worker on the
    // main session's own directory shares that entry with it, so removing one
    // deletes it too; the background refresher re-creates the main entry within
    // minutes, so that transient loss is acceptable.
    if (removed && ownedReading && !findWorkerByConfigDir(remaining, removed.configDir)) {
      deleteUsageEntries([removed.configDir]);
    }
    this._onDidChange.fire();
  }

  /**
   * Delete one entry of the registry that this version cannot use (`unsupportedWorkers`) —
   * the only way such an entry ever leaves the file from here, and only at the user's explicit
   * request: it may be an account a newer version of the extension registered.
   *
   * The entry is named by its position in the list AND its name, as the caller was shown them,
   * and is removed only when the list read under the registry's lock still has an entry of that
   * name at that position. Anything else — the list changed since it was shown, or the
   * arguments are not a position and a name at all — throws and changes nothing. Every other
   * entry, and every usable worker, is written back exactly as it was read.
   */
  removeUnsupportedWorker(index: number, name: string): void {
    const changed = (): Error =>
      new Error(vscode.l10n.t('The registry changed — refresh and try again. Nothing was removed.'));
    // Not a position and a name: refused before the lock is even asked for.
    if (!Number.isInteger(index) || index < 0 || typeof name !== 'string') {
      throw changed();
    }
    updateRegistry((registry) => {
      const entry = registry.unsupportedWorkers[index];
      if (entry === undefined || entry.name !== name) {
        throw changed();
      }
      registry.unsupportedWorkers = registry.unsupportedWorkers.filter((_, at) => at !== index);
    });
    this._onDidChange.fire();
  }

  /**
   * Relabel a worker; its config directory and login are untouched. The new name is held to
   * the same rule as a name being added (workerNameProblem), and the registry's own rename
   * checks it once more in its own words.
   *
   * REFUSED when another worker's name holds `oldName` between commas (`w1` beside a worker
   * named `w1,w2` — possible only for an entry written before names were checked). The task
   * log writes a failover from one worker to the next as their names joined by commas, and
   * the registry's rename re-files every event that lists the old name that way: it would
   * take that other worker's events for a failover and rewrite them. Nothing is renamed, and
   * the message names the worker to rename first.
   */
  rename(oldName: string, newName: string): void {
    const nameProblem = workerNameProblem(newName);
    if (nameProblem !== undefined) {
      throw new Error(nameProblem);
    }
    const lookalike = this.list().find(
      (w) => w.name !== oldName && w.name.includes(',') && w.name.split(',').includes(oldName),
    );
    if (lookalike !== undefined) {
      throw new Error(
        vscode.l10n.t(
          'Worker "{0}" was not renamed: the registry also holds a worker named "{1}", and the task log writes a failover from one worker to another as names joined by commas — renaming "{0}" would rewrite the tasks of "{1}" as well. Rename "{1}" to a name without a comma first.',
          oldName,
          shownValue(lookalike.name),
        ),
      );
    }
    renameWorker(oldName, newName);
    this._onDidChange.fire();
  }

  /**
   * Mark one worker as preferred. The flag is cleared on every other worker OF THE SAME
   * PROVIDER and on no one else: a dispatch only ever chooses among one provider's workers, so
   * "preferred" is a choice within that set, and favouring a Codex account must not quietly
   * take the mark off the Claude Code account that had it.
   */
  togglePreferred(name: string): boolean {
    if (this.get(name) === undefined) {
      return false;
    }
    let enabling = false;
    updateRegistry((registry) => {
      const target = registry.workers.find((w) => w.name === name);
      if (!target) {
        // Removed by another editor since the look above: nothing to mark.
        return;
      }
      enabling = !target.preferred;
      const provider = workerProvider(target);
      for (const w of registry.workers) {
        if (workerProvider(w) === provider) {
          w.preferred = false;
        }
      }
      target.preferred = enabling;
    });
    this._onDidChange.fire();
    return enabling;
  }

  /**
   * Change a worker's default model (the one a dispatch that names none runs on), by the rules
   * of the worker's own provider. `undefined` means "no default — the CLI chooses", which only
   * a non-Claude worker can have. Throws for a value that is not a model at all; returns false
   * when no worker carries that name.
   */
  setModel(name: string, model: string | undefined): boolean {
    const known = this.get(name);
    if (!known) {
      return false;
    }
    // Judged before the lock is asked for: a value that is not a model is an error whatever
    // the registry holds — and in this module's words.
    const provider = workerProvider(known);
    const stored = storedModelFor(provider, model);
    // The registry's one writer of a model: under its lock, only for the same worker on the
    // same CLI (one removed and re-added on another CLI in between is not given a model of the
    // first one's vocabulary), with `modelPinned` set for a pinned id and removed for an alias.
    const found = setWorkerModel(name, provider, stored, provider === 'claude' && isPinnedClaudeModel(stored));
    this._onDidChange.fire();
    return found;
  }

  /**
   * Change a non-Claude worker's permission / sandbox mode. `null` means the provider's
   * default, and so does naming the default itself: either way the entry carries NO
   * `permissionMode`, so a later change of the provider default reaches the worker.
   *
   * Throws for a mode the worker's provider does not accept — the value becomes an argument
   * of that vendor's CLI, and a mode of another vendor must never be stored as if it applied —
   * and for a Claude Code worker, whose mode is the global setting. Returns false when no
   * worker carries that name.
   *
   * A mode that turns the sandbox off (`removesSandbox`) is stored only when
   * `unsandboxedConfirmed` is true, i.e. when the caller has put the choice in front of the
   * user in a modal and the user confirmed it. Without that it throws and stores nothing, so
   * no caller can write such a mode by forgetting to ask.
   */
  setPermissionMode(name: string, mode: string | null, unsandboxedConfirmed = false): boolean {
    const known = this.get(name);
    if (!known) {
      return false;
    }
    const provider = workerProvider(known);
    const info = providerInfo(provider);
    if (provider === 'claude') {
      throw new Error(
        vscode.l10n.t(
          'Claude Code workers have no permission mode of their own — they all use the "Worker Permission Mode" setting.',
        ),
      );
    }
    if (mode !== null && (typeof mode !== 'string' || !info.permissionModes.includes(mode))) {
      throw new Error(
        vscode.l10n.t(
          '"{0}" is not a {1} permission mode — use one of: {2}.',
          // The refused value is quoted back; it may be anything a caller sent.
          sliceOneLine(flattenOneLine(mode), 40),
          info.label,
          info.permissionModes.join(', '),
        ),
      );
    }
    if (removesSandbox(provider, mode) && unsandboxedConfirmed !== true) {
      throw new Error(
        vscode.l10n.t(
          '{0} mode turns the {1} sandbox off and was not confirmed — nothing was changed.',
          String(mode),
          info.label,
        ),
      );
    }
    let found = false;
    updateRegistry((registry) => {
      const worker = registry.workers.find((w) => w.name === name);
      // The same worker still: the mode was judged in `provider`'s vocabulary.
      if (!worker || workerProvider(worker) !== provider) {
        return;
      }
      if (mode === null || mode === info.defaultPermissionMode) {
        delete worker.permissionMode;
      } else {
        worker.permissionMode = mode;
      }
      found = true;
    });
    this._onDidChange.fire();
    return found;
  }

  /**
   * Push extension settings the MCP server needs into the shared registry.
   *
   * Everything that reads the editor is done FIRST, outside the registry's lock; what runs
   * under the lock only assigns (updateRegistryIfChanged). When the registry already says all
   * of it, nothing is written and no lock is taken. Throws when the registry could not be
   * written — the lock's own message when it stayed held — and has then changed nothing.
   *
   * Nothing here waits on a process. The one value that takes a login shell to find — the
   * absolute path of the claude command — is taken as far as it is known, and looked up in the
   * background when it is not (claudePathForRegistry).
   */
  syncSettings(): void {
    // Every value below is the USER's own setting (settings.userSetting): the registry is
    // shared by every editor and workspace on this machine, and nothing a workspace's settings
    // file says may reach it.
    // Normalized here as well as on the read side: the value becomes a `--permission-mode`
    // argument, and a hand-edited setting can hold anything.
    const permissionMode = normalizePermissionMode(userSetting('workerPermissionMode'));
    // What the registry may hold for the claude command right now. No shell is asked here:
    // this runs inside activate() and on every settings event (claudePathForRegistry).
    const claudePath = this.claudePathForRegistry();
    const cooldownMinutes = clampCooldownMinutes(userSetting('quotaCooldownMinutes'));
    const workerTimeoutMinutes = clampTimeoutMinutes(userSetting('workerTimeoutMinutes'));
    // The opt-out of other vendors' usage readings. The dispatch server refreshes those accounts
    // itself (for list_workers) and has no other way to learn an editor setting. Only the
    // literal `false` turns the readings off — the same reading of the setting the extension's
    // own refresh and the dashboard's toggle use — and "on" is stored as ABSENT, which is what
    // a registry written before the setting existed says too.
    const pollingOff = userSetting('providerUsagePolling') === false;
    // Billing guards: reconcile across editors that share this registry. The EXPLICIT user
    // value (not the value with its default filled in), so an editor where the setting is
    // UNSET is distinguished from one that explicitly chose the default — an unset editor
    // must not clobber another editor's explicit `allow` back to `block`. The two
    // guards are independent: frontier governs WHICH MODEL may be dispatched,
    // overage governs whether ANY dispatch may bill past an exhausted plan window.
    const explicit = explicitUserSetting('frontierWorkerDispatch');
    const overageExplicit = explicitUserSetting('overageWorkerDispatch');
    const editor = vscode.env.appName;
    updateRegistryIfChanged((registry) => {
      registry.permissionMode = permissionMode;
      registry.claudePath = claudePath;
      registry.cooldownMinutes = cooldownMinutes;
      registry.workerTimeoutMinutes = workerTimeoutMinutes;
      if (pollingOff) {
        registry.providerUsagePolling = false;
      } else {
        delete registry.providerUsagePolling;
      }
      // Reconciled against the registry as it is UNDER THE LOCK: which editor owns a guard is
      // exactly the kind of fact another window may have changed a moment ago.
      applyFrontierGuard(registry, editor, explicit);
      applyOverageGuard(registry, editor, overageExplicit);
    });
  }

  /**
   * Call `listener` when a background lookup of the claude command has an answer that the
   * registry should get: the caller runs its settings sync, which asks syncSettings again.
   * One listener; never called after dispose().
   */
  onClaudePathResolved(listener: () => void): void {
    this.claudePathListener = listener;
  }

  /** Resolves once no lookup of the claude command is in flight (at once when none is). */
  whenClaudePathSettled(): Promise<void> {
    return this.claudeLookupRunning?.done ?? Promise.resolve();
  }

  /**
   * Is the registry still without a spawnable path for a claude command that a login shell
   * could be asked about? While it is, the caller's periodic settings sync asks again — a CLI
   * installed (or reinstalled) after the last lookup is then found without a settings change.
   * Reads the registry; starts nothing.
   */
  claudePathUnresolved(): boolean {
    const configured = userClaudePath();
    return (
      resolveClaudePathWithoutLookup(configured, undefined).needsLookup &&
      resolveClaudePathWithoutLookup(configured, readRegistry().claudePath).needsLookup
    );
  }

  /**
   * The value `registry.claudePath` should hold as of now — decided WITHOUT asking a shell —
   * and, when a login shell has to be asked, the start of that lookup in the background.
   *
   * The registry holds the ABSOLUTE path of the configured command where one is known: the
   * dispatch server and the usage probes run without the login shell's PATH. Finding it means
   * starting the user's login shell, whose profile can take seconds, and this runs inside
   * `activate()` and on every settings event — so the shell is never waited for here:
   *
   *  - an absolute setting is the value, as it always was;
   *  - the path the registry already holds is kept while it still serves the configured
   *    command (registry.resolveClaudePathWithoutLookup: a spawnable file of that name);
   *  - so is the answer of the last lookup for this command, while it still serves;
   *  - otherwise the value is the bare command for now — every spawner of it tolerates that —
   *    and a lookup is started (lookUpClaudePath). When it ends, the listener runs the
   *    settings sync again, and this function hands out its answer.
   *
   * A lookup is made when the path held does not serve, and once when the USER changed the
   * setting to another command name (the path held may serve the name and still not be the
   * binary the shell finds for it). A settings change of any other key starts none. A lookup
   * that found nothing is not repeated for CLAUDE_LOOKUP_RETRY_MS.
   */
  private claudePathForRegistry(): string {
    const configured = userClaudePath();
    const asConfigured = resolveClaudePathWithoutLookup(configured, undefined);
    const command = asConfigured.path;
    if (this.lastClaudeCommand !== undefined && this.lastClaudeCommand !== command) {
      this.claudeLookupOwedFor = command;
    }
    this.lastClaudeCommand = command;
    const stored = readRegistry().claudePath;
    if (!asConfigured.needsLookup) {
      // An absolute path, or a command no shell is asked about (any command on Windows): the
      // waiting resolver's answer for it needs no shell either — the path held while it still
      // serves, else the command.
      return resolveClaudePathWithoutLookup(configured, stored).path;
    }
    const last = this.claudeLookup?.command === command ? this.claudeLookup : undefined;
    if (last !== undefined) {
      const again = resolveClaudePathWithoutLookup(command, last.path);
      if (!again.needsLookup) {
        return again.path;
      }
    }
    const held = resolveClaudePathWithoutLookup(command, stored);
    if (!held.needsLookup && this.claudeLookupOwedFor !== command) {
      return held.path;
    }
    // A lookup that just came back empty stands for a while; a clock that went backwards
    // (a negative age) does not extend it.
    const age = last === undefined ? -1 : Date.now() - last.at;
    if (last === undefined || last.served || age < 0 || age >= CLAUDE_LOOKUP_RETRY_MS) {
      this.lookUpClaudePath(command, stored);
    }
    return held.path;
  }

  /**
   * Ask the login shell where `command` is, without waiting (registry's asynchronous resolver:
   * the same rules as the waiting one). At most one lookup runs at a time; a second request
   * while one is running is dropped — when the running one ends, the settings sync it triggers
   * asks again if the answer is not for the command configured by then.
   */
  private lookUpClaudePath(command: string, stored: unknown): void {
    if (this.disposed || this.claudeLookupRunning !== undefined) {
      return;
    }
    const abort = new AbortController();
    const done = resolveClaudePathPreservingAsync(command, stored, { signal: abort.signal }).then(
      (answer) => {
        this.claudeLookupRunning = undefined;
        if (this.disposed) {
          return;
        }
        this.claudeLookup = {
          command,
          path: answer,
          served: !resolveClaudePathWithoutLookup(command, answer).needsLookup,
          at: Date.now(),
        };
        if (this.claudeLookupOwedFor === command) {
          this.claudeLookupOwedFor = undefined;
        }
        try {
          this.claudePathListener?.();
        } catch {
          // the listener is the never-throwing settings sync; a defect there ends here
        }
      },
      () => {
        // The resolver is documented never to reject.
        this.claudeLookupRunning = undefined;
      },
    );
    this.claudeLookupRunning = { abort, done };
  }

  /**
   * Claude Code config directories on disk that aren't registered yet. Claude Code only: the
   * home directory of another vendor's CLI is never offered for import (a worker on one is
   * added through Add Worker, which asks which login it uses).
   *
   * Offered is a REAL directory (`lstat` — a symbolic link is not: it is another name for a
   * directory that is offered, or registered, under its own) in the home directory whose name
   * starts with `.claude` AND that looks like Claude Code has run under it
   * (looksLikeClaudeConfigDir). Another tool's `~/.claude-something` is not an account.
   *
   * `suggestedName` is derived from the directory's name and is ONLY a suggestion: a directory
   * can be called anything, so the caller holds it to the name rule (workerNameProblem) and
   * asks for another name when it fails. `usedBefore` is `dirUsedByClaudeCode` — whether the
   * CLI's own account files are there. It is not a login state: that is only known once the
   * account is added and checked.
   */
  discoverConfigDirs(): { dir: string; suggestedName: string; usedBefore: boolean }[] {
    const home = os.homedir();
    const registered = new Set(this.list().map((w) => w.configDir));
    const found: { dir: string; suggestedName: string; usedBefore: boolean }[] = [];
    try {
      for (const name of fs.readdirSync(home)) {
        if (!name.startsWith('.claude')) {
          continue;
        }
        const dir = path.join(home, name);
        // This extension's own data directory also starts with ".claude" and is nobody's login.
        if (registered.has(dir) || path.resolve(dir) === path.resolve(ROOT_DIR)) {
          continue;
        }
        if (!isRealDirectory(dir) || !looksLikeClaudeConfigDir(dir)) {
          continue;
        }
        const usedBefore = dirUsedByClaudeCode(dir);
        const suggestedName = name === '.claude' ? 'default' : name.replace(/^\.claude-?/, '') || name;
        found.push({ dir, suggestedName, usedBefore });
      }
    } catch {
      // home unreadable
    }
    return found;
  }

  /**
   * Open an interactive session of the account's own CLI in an integrated terminal. If the
   * account isn't logged in yet, the CLI prompts for login right there.
   *
   * Takes `{ name, configDir, provider }` rather than a WorkerProfile because the hosting
   * session's own account ("main") is not in the registry and is opened the same way; an
   * account naming no provider is a Claude Code one (the registry's `workerProvider` rule).
   * The terminal's environment comes from `accountTerminalEnv`: for Claude Code that decides
   * whether CLAUDE_CONFIG_DIR is set or must be ABSENT (the default directory logs in without
   * it), for every provider it keeps this editor's own session-identity variables out of the
   * new session, and for another vendor's CLI the Anthropic credentials as well.
   *
   * `initialPrompt` starts a Claude Code session on a task: it is passed as the CLI's one
   * positional argument, flattened to a single line first. It is NOT passed to another
   * vendor's CLI: how each of them takes a first prompt on the command line is that CLI's
   * business, and a guess typed into a terminal is a command the user never asked for.
   *
   * Returns undefined, with no terminal opened, when the command line could not be written
   * for the user's shell (`openCommandTerminal` has said why).
   */
  openTerminal(
    account: { name: string; configDir: string; provider?: ProviderId },
    initialPrompt?: string,
  ): vscode.Terminal | undefined {
    const provider = workerProvider(account);
    const prompt = provider === 'claude' && initialPrompt ? promptAsOneLine(initialPrompt) : '';
    return openCommandTerminal(
      {
        name: `${providerInfo(provider).cli}: ${account.name}`,
        env: accountTerminalEnv(provider, account.configDir),
      },
      terminalProviderCommand(provider),
      prompt === '' ? [] : [prompt],
    );
  }
}

/**
 * Open a terminal running the provider's own login command against `configDir` (`claude auth
 * login` for Claude Code), to sign in a new account or recover an expired or logged-out one.
 * Standalone rather than a WorkerManager method because the 'main' account is not in the
 * registry and so has no WorkerProfile — it is addressed by (label, configDir) alone, exactly
 * like every worker.
 *
 * Returns undefined, and opens nothing, for a provider that has no login command (it signs in
 * somewhere else — the caller knows from `providerInfo(provider).loginArgs` and says where),
 * and when the command line could not be written for the user's shell (`openCommandTerminal`
 * has said why).
 */
export function openReloginTerminal(
  label: string,
  configDir: string,
  provider: ProviderId = DEFAULT_PROVIDER,
): vscode.Terminal | undefined {
  const info = providerInfo(provider);
  if (info.loginArgs === null) {
    return undefined;
  }
  // accountTerminalEnv, not a hand-built variable. For Claude Code: a login made with
  // CLAUDE_CONFIG_DIR exported as the DEFAULT directory is stored under a different credential
  // key than the one a plain `claude` reads, so re-logging "main" that way would leave it
  // reading as logged out. For the others: the login must land in the home a dispatch of this
  // worker will read, and the default home is addressed by setting nothing.
  const options = { name: `login: ${label}`, env: accountTerminalEnv(provider, configDir) };
  if (provider !== 'claude') {
    // `loginArgs` are constants of providers.ts, never account data.
    return openCommandTerminal(options, terminalProviderCommand(provider), info.loginArgs);
  }
  // The stored OAuth address pre-fills the login so the user re-authenticates the
  // account this directory already belongs to, not whichever one their browser is
  // signed into. `accountLoginEmail` returns it only when it has the shape of an address;
  // otherwise the flag is dropped entirely. It is still passed as an argument like any other,
  // so the terminal line quotes whatever the shell would read.
  const email = accountLoginEmail(configDir);
  return openCommandTerminal(options, terminalProviderCommand(provider), [
    ...info.loginArgs,
    ...(email !== undefined ? ['--email', email] : []),
  ]);
}
