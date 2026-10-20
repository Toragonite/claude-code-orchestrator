/**
 * The single owner of every assumption this extension makes about the Claude Code CLI.
 *
 * Leaf module: imports only `os` and `path`, never `vscode`, so the extension host, the
 * bundled MCP server and the detach supervisor all share it. Each fact below was probed live
 * on Claude Code 2.1.283 (2026-10-13); the evidence is in `.orchestrator/VERIFICATION-2.0.md`
 * (section "Platform probes"). When the CLI changes, this is the file to re-verify — nothing
 * else in `src/` may hard-code a model id, a minimum version, or the environment a `claude`
 * child runs under.
 */
import * as os from 'os';
import * as path from 'path';

/* ------------------------------------------------------------------------- *
 * Versions
 * ------------------------------------------------------------------------- */

/**
 * Oldest CLI on which session workers (`claude --bg`) are supported. It is the version the
 * behaviour was VERIFIED on, not the version a feature first appeared in: the IDE panel
 * session is a full messaging peer, a `--bg` worktree can be based on HEAD, and `claude rm`
 * never discards unpushed work without an explicit flag.
 */
export const MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS = '2.1.283';

export type ClaudeVersion = readonly [major: number, minor: number, patch: number];

/**
 * Parse the output of `claude --version` (observed: `2.1.283 (Claude Code)`). Returns the
 * FIRST `d.d.d` triple in the text, or undefined when there is none or a component is not a
 * safe integer. Total: never throws, whatever it is handed.
 */
export function parseClaudeVersion(text: unknown): ClaudeVersion | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const m = /(?:^|[^\d.])(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?![\d])/.exec(text);
  if (!m) {
    return undefined;
  }
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : undefined;
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

/**
 * Does `versionText` (raw `claude --version` output) satisfy `minimum` (a `d.d.d` string)?
 * An unparseable version on EITHER side is `false`: a capability that cannot be proven is
 * not assumed.
 */
export function claudeVersionAtLeast(versionText: unknown, minimum: string): boolean {
  const have = parseClaudeVersion(versionText);
  const need = parseClaudeVersion(minimum);
  return have !== undefined && need !== undefined && compareClaudeVersions(have, need) >= 0;
}

/* ------------------------------------------------------------------------- *
 * Config directories and the environment of a `claude` child
 * ------------------------------------------------------------------------- */

/** The CLI's built-in config directory, used when `CLAUDE_CONFIG_DIR` is unset. */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** A set, non-blank `CLAUDE_CONFIG_DIR` from `env`, else undefined. Returned verbatim. */
function explicitConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.CLAUDE_CONFIG_DIR;
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** The config dir of the process described by `env` ("main" for the hosting session). */
export function hostConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return explicitConfigDir(env) ?? defaultConfigDir();
}

/** Do two config-dir strings name the same directory? Lexical only — no filesystem access. */
export function sameConfigDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Variables a Claude Code session injects into its children to identify ITSELF. A `claude`
 * child we spawn is a different session — usually a different account — and must not
 * inherit them: observed leaks are `CLAUDE_CODE_ENTRYPOINT=claude-vscode` stamped onto
 * headless probes, and `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, which would hand a worker
 * the orchestrator session's own child-messaging credentials.
 *
 * This is a DENY list on purpose. User configuration that also starts with `CLAUDE_CODE_`
 * (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, proxies, …) must keep flowing
 * through, so only names known to carry session identity are removed.
 */
export const SESSION_IDENTITY_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
] as const;

/**
 * A copy of `base` with the session-identity variables removed and NOTHING else changed —
 * the base environment for a child that is not a Claude Code account at all (another
 * vendor's CLI, a helper process). Never mutates `base`.
 */
export function scrubSessionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SESSION_IDENTITY_ENV) {
    delete env[name];
  }
  return env;
}

/**
 * Variables that must never be handed to ANOTHER vendor's agent CLI, listed by name for the
 * cases worth naming. They authenticate or configure Anthropic's CLI and API and are of no
 * use to a third-party binary; a third-party CLI (or anything it launches) reading
 * `ANTHROPIC_API_KEY` out of its environment is a credential disclosure the user did not ask
 * for. The actual rule is the PREFIX test in `isAnthropicScopedEnv` — this list exists so
 * the most important names are greppable and are removed from a terminal even when the
 * host process happens not to have them set.
 */
export const ANTHROPIC_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CONFIG_DIR',
] as const;

/**
 * Is this variable scoped to Anthropic's own CLI / API? Everything named `ANTHROPIC_*`,
 * `CLAUDE_*` or `CLAUDECODE`. A deny-by-PREFIX rule on purpose: an adversarial review
 * showed the first version (four names) let `ANTHROPIC_CUSTOM_HEADERS`,
 * `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and others through, and
 * the next credential variable Anthropic adds must not need a release of this extension to
 * be withheld. No other vendor's CLI has a use for any variable under these prefixes.
 */
export function isAnthropicScopedEnv(name: string): boolean {
  return /^(ANTHROPIC_|CLAUDE_)/.test(name) || name === 'CLAUDECODE';
}

/**
 * The base environment for a child that runs ANOTHER vendor's agent CLI (Codex, Cursor,
 * Antigravity) or a helper that drives one: every Anthropic-scoped variable is removed
 * (`isAnthropicScopedEnv` — this covers the session-identity variables too). Everything
 * else — `OPENAI_API_KEY`, `CURSOR_API_KEY`, cloud-provider credentials, proxies, PATH —
 * passes through untouched. Never mutates `base`.
 */
export function vendorChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isAnthropicScopedEnv(name)) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * The same decision for `vscode.window.createTerminal({ env })` (a `null` removes an
 * inherited variable): every Anthropic-scoped variable present in `base`, plus the named
 * ones whether present or not, is removed from a terminal that runs another vendor's CLI.
 */
export function vendorTerminalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const name of SESSION_IDENTITY_ENV) {
    env[name] = null;
  }
  for (const name of ANTHROPIC_CREDENTIAL_ENV) {
    env[name] = null;
  }
  for (const name of Object.keys(base)) {
    if (isAnthropicScopedEnv(name)) {
      env[name] = null;
    }
  }
  return env;
}

/**
 * How `CLAUDE_CONFIG_DIR` must be presented to a child that should run as the account
 * living in `configDir`:
 *
 *   - `{ set: value }`  — export exactly `value`.
 *   - `{ unset: true }` — the variable must be ABSENT.
 *
 * Rules, in order (all probed on macOS, 2.1.283):
 *  1. The host itself runs with an explicit `CLAUDE_CONFIG_DIR` naming this same directory
 *     → pass the HOST'S OWN STRING through untouched. That is the exact environment the
 *     account's login was created under.
 *  2. `configDir` is the built-in default (`~/.claude`) → UNSET. Exporting the default path
 *     explicitly is NOT equivalent to leaving it unset: the CLI then keys its credential
 *     store (macOS Keychain entry) and its `.claude.json` to the directory, and a login made
 *     without the variable reads as logged out.
 *  3. Anything else → set it to `configDir` VERBATIM. The credential key is derived from the
 *     string, so it is never normalized, resolved or given a trailing slash here.
 */
export function configDirBinding(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): { set: string } | { unset: true } {
  const host = explicitConfigDir(base);
  if (host !== undefined && sameConfigDir(host, configDir)) {
    return { set: host };
  }
  if (sameConfigDir(configDir, defaultConfigDir())) {
    return { unset: true };
  }
  return { set: configDir };
}

/**
 * The environment for ANY `claude` child process that must run as the account in
 * `configDir`. Every spawn site in the codebase goes through this function; nothing else
 * may build `{ ...process.env, CLAUDE_CONFIG_DIR }` by hand.
 *
 * Returns a fresh object (never mutates `base`):
 *  - session-identity variables are removed (see SESSION_IDENTITY_ENV);
 *  - `CLAUDE_CODE_OAUTH_TOKEN` is removed when the target is a DIFFERENT account than the
 *    host's. That token outranks a stored login in the CLI's credential precedence, so a
 *    token inherited from the host would make every other account silently run — and bill —
 *    as the host account;
 *  - `CLAUDE_CONFIG_DIR` is set or removed per configDirBinding.
 *
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and provider selectors are deliberately left
 * alone: they select a provider/key for the whole machine, not an account, and a user who
 * exports them has opted every session into them.
 */
export function claudeEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SESSION_IDENTITY_ENV) {
    delete env[name];
  }
  if (!sameConfigDir(configDir, hostConfigDir(base))) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const binding = configDirBinding(configDir, base);
  if ('set' in binding) {
    env.CLAUDE_CONFIG_DIR = binding.set;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

/**
 * The same decision expressed for `vscode.window.createTerminal({ env })`, where a `null`
 * value REMOVES an inherited variable. Used for login / attach / logs terminals.
 */
export function claudeTerminalEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const name of SESSION_IDENTITY_ENV) {
    env[name] = null;
  }
  if (!sameConfigDir(configDir, hostConfigDir(base))) {
    env.CLAUDE_CODE_OAUTH_TOKEN = null;
  }
  const binding = configDirBinding(configDir, base);
  env.CLAUDE_CONFIG_DIR = 'set' in binding ? binding.set : null;
  return env;
}

/**
 * A copy-pasteable shell prefix that reproduces configDirBinding for a command shown to the
 * user (attach hints, re-login hints). `quote` is the caller's shell-quoting function. The
 * result ends with a space, or is empty when nothing needs to be said.
 */
export function claudeShellPrefix(
  configDir: string,
  quote: (s: string) => string,
  base: NodeJS.ProcessEnv = process.env,
): string {
  const binding = configDirBinding(configDir, base);
  if ('set' in binding) {
    return `CLAUDE_CONFIG_DIR=${quote(binding.set)} `;
  }
  // Only spell out the unset when the surrounding shell might actually have it exported.
  return explicitConfigDir(base) !== undefined ? 'env -u CLAUDE_CONFIG_DIR ' : '';
}

/**
 * Where the CLI keeps the account-level config (`.claude.json`: project trust, MCP-server
 * decisions) for the account in `configDir`: `<dir>/.claude.json` when the child runs with
 * the variable set, the HOME-level `~/.claude.json` when it runs with it unset.
 *
 * `homeLevel` is true for the second case. Callers that WRITE this file must refuse when it
 * is true: that file is the user's primary config, rewritten whole by every live session,
 * and a read-modify-write from outside the CLI can lose their updates.
 */
export function accountConfigFile(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): { file: string; homeLevel: boolean } {
  const binding = configDirBinding(configDir, base);
  return 'set' in binding
    ? { file: path.join(binding.set, '.claude.json'), homeLevel: false }
    : { file: path.join(os.homedir(), '.claude.json'), homeLevel: true };
}

/* ------------------------------------------------------------------------- *
 * Models
 * ------------------------------------------------------------------------- */

/**
 * Tier aliases the CLI resolves to the newest model of each family (probed: `opus` →
 * claude-opus-5-5, `fable` → claude-fable-5-1, `haiku` → claude-haiku-4-5). Storing the
 * alias instead of a dated id is what keeps a worker's default model from going stale.
 */
export const MODEL_ALIASES = ['opus', 'sonnet', 'fable', 'haiku'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/**
 * Aliases offered as a worker's DEFAULT model in the UI, in display order. Every tier alias:
 * an alias is resolved by the worker's own CLI to the newest model of that family it knows,
 * so this list never names a model version and cannot go stale.
 */
export const WORKER_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * Shape of a model id as a CLI REPORTS it after a run (`modelUsage` keys of `claude -p
 * --output-format json`, an adapter's `RunResult.model`): what is stored as a task's
 * `modelUsed` and shown beside the alias that was asked for. Wider than FULL_MODEL_ID on
 * purpose — other vendors' ids are reported through the same field.
 */
export const REPORTED_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/;

/** Fallback when a stored or requested default cannot be read at all. */
export const DEFAULT_WORKER_MODEL: ModelAlias = 'opus';

/**
 * The three ids that were the ONLY accepted model values through v1.x. They were tier
 * choices, never deliberate version pins, so they are read as their tier alias everywhere —
 * including in workspaces whose dispatch policy still names them.
 */
const LEGACY_TIER_IDS: ReadonlyMap<string, ModelAlias> = new Map([
  ['claude-opus-4-8', 'opus'],
  ['claude-sonnet-5', 'sonnet'],
  ['claude-fable-5', 'fable'],
]);

const FULL_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{1,62}[a-z0-9](\[1m\])?$/;

/**
 * Normalize a model value from a dispatch argument, the registry, or the UI.
 *
 *  - an alias (any case, surrounding whitespace ignored) → the lowercase alias;
 *  - a v1.x tier id → its alias — unless `opts.exact` (below);
 *  - any other well-formed full id (`claude-…`, optional `[1m]`) → that id, lowercased;
 *  - everything else (non-string, empty, free text, shell metacharacters, over-long) →
 *    undefined. Callers must treat undefined for an EXPLICITLY supplied model as an error,
 *    never as "use the default": silently swapping a model the caller named hides a typo
 *    behind a different bill.
 *
 * `opts.exact`: the value was PINNED by the user — picked from the CLI's own model list or typed
 * as a full id — and means that exact model. The three v1.x tier ids are real models the CLI
 * still offers (`claude-opus-4-8` is "Opus 4.8"), and reading a pinned one as its tier would run
 * another model than the one chosen. Without it (a dispatch argument, a 1.x registry entry)
 * they keep meaning their tier, as they always did.
 */
export function normalizeModel(raw: unknown, opts: { exact?: boolean } = {}): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if ((MODEL_ALIASES as readonly string[]).includes(v)) {
    return v;
  }
  // A Map, not an object: `constructor` and `__proto__` are keys of every plain object, and a
  // lookup by a caller's string returned `Object` for them — a "model" that then reached the CLI.
  const legacy = opts.exact === true ? undefined : LEGACY_TIER_IDS.get(v);
  if (legacy !== undefined) {
    return legacy;
  }
  return FULL_MODEL_ID.test(v) ? v : undefined;
}

/** Is `raw` one of the three v1.x tier ids (which read as their alias unless pinned)? */
export function isLegacyTierId(raw: unknown): boolean {
  return typeof raw === 'string' && LEGACY_TIER_IDS.has(raw.trim().toLowerCase());
}

/** One line for an error message: what `normalizeModel` accepts. */
export const MODEL_FORMS_HINT =
  'an alias (opus, sonnet, fable, haiku) or a full model id such as claude-opus-5-5';

/**
 * Is this the frontier tier (the scarce / separately billed one the frontier guard gates)?
 * Works on aliases and full ids alike. A non-string is not frontier.
 */
export function isFrontierModel(model: unknown): boolean {
  return typeof model === 'string' && /fable|mythos/i.test(model);
}

/* ------------------------------------------------------------------------- *
 * Permission modes
 * ------------------------------------------------------------------------- */

/**
 * `--permission-mode` values accepted for dispatched workers, in UI order. `default` is still
 * accepted by the CLI (it is the legacy spelling of `manual`). All of these except
 * `bypassPermissions` report the same cross-session "permission class", which is what lets
 * an orchestrator's SendMessage reach a worker without being held for approval.
 */
export const WORKER_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'dontAsk',
  'plan',
  'default',
  'bypassPermissions',
] as const;
export type WorkerPermissionMode = (typeof WORKER_PERMISSION_MODES)[number];

export const DEFAULT_WORKER_PERMISSION_MODE: WorkerPermissionMode = 'acceptEdits';

/** A stored permission mode, or the default when the value is not one the CLI accepts. */
export function normalizePermissionMode(raw: unknown): WorkerPermissionMode {
  return typeof raw === 'string' && (WORKER_PERMISSION_MODES as readonly string[]).includes(raw)
    ? (raw as WorkerPermissionMode)
    : DEFAULT_WORKER_PERMISSION_MODE;
}

/* ------------------------------------------------------------------------- *
 * Session workers (`claude --bg`)
 * ------------------------------------------------------------------------- */

/**
 * `--settings` payload for a `--bg -w` worker. Without it the worktree branches from the
 * REMOTE DEFAULT BRANCH (`worktree.baseRef: "fresh"`, the CLI default), so a worker would
 * not see the commits of the branch the orchestrator is actually on. `"head"` branches from
 * the local HEAD instead. Uncommitted changes are never carried either way.
 */
export const SESSION_WORKER_SETTINGS_JSON = '{"worktree":{"baseRef":"head"}}';

/** Substring of the CLI's refusal when the account has not trusted the workspace root. */
export const WORKSPACE_NOT_TRUSTED_MARKER = 'Workspace not trusted';

/** Substring of the CLI's refusal to start a `--bg` session in bypassPermissions mode. */
export const BYPASS_DISCLAIMER_MARKER = 'requires accepting the disclaimer';

/**
 * Words in `claude rm` output that mean "the worktree was KEPT because it holds work"
 * (observed: `kept <id> — its worktree is still at …`, exit 1). A plain `claude rm` never
 * discards uncommitted or unpushed work; only an explicit `--discard-unpushed <token>`
 * does, and this codebase never passes it.
 */
export const WORKTREE_KEPT_MARKERS = ['kept', 'uncommitted', 'unpushed'] as const;

/* ------------------------------------------------------------------------- *
 * MCP
 * ------------------------------------------------------------------------- */

/**
 * MCP protocol revisions this server actually implements (tools only; it uses nothing that
 * differs between them). Newest last.
 */
export const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;

/**
 * The `protocolVersion` to answer an `initialize` with: the client's own when we implement
 * it, otherwise OUR newest — never an echo of a revision we do not know (per the MCP
 * lifecycle rules the client then decides whether it can speak ours).
 */
export function negotiateMcpProtocol(requested: unknown): string {
  const known = MCP_PROTOCOL_VERSIONS as readonly string[];
  return typeof requested === 'string' && known.includes(requested)
    ? requested
    : known[known.length - 1];
}

/* ------------------------------------------------------------------------- *
 * Terminal command lines
 * ------------------------------------------------------------------------- */

/**
 * Quoting dialect of the shell a terminal line is typed into. `posix` covers sh, bash, zsh,
 * dash, ksh and fish (all of which read `'it'\''s'` the same way).
 */
export type TerminalShell = 'posix' | 'powershell' | 'cmd';

/**
 * The dialect of the user's terminal shell, from its executable path (`vscode.env.shell`).
 * An unknown shell is `posix` — except on Windows, where an EMPTY path means the platform
 * default (PowerShell).
 */
export function terminalShell(
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): TerminalShell {
  const base = (shellPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') {
    return 'powershell';
  }
  if (base === 'cmd') {
    return 'cmd';
  }
  return base === '' && platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * A command NAME with nothing a shell could interpret: letters, digits, `.`, `_`, `-`, and
 * not `.` or `..`. It is typed unquoted, so the user's aliases and shell functions for it
 * still apply (quoting a command word switches alias expansion off).
 */
export function isBareCommandName(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command) && command !== '.' && command !== '..';
}

/** C0 controls and DEL: nothing that is typed into a terminal may contain one. */
const TERMINAL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Is `raw` a value the `claudePath` setting may hold? Either a bare command name or an
 * ABSOLUTE path (for this platform), at most 1024 characters, with no control character.
 * A relative or `~` path is refused: the dispatch server, the extension host and a terminal
 * each have a different working directory, so it would name three different files.
 * Surrounding whitespace is ignored, exactly as the resolver ignores it.
 */
export function isAcceptableClaudePath(raw: unknown): raw is string {
  if (typeof raw !== 'string') {
    return false;
  }
  const value = raw.trim();
  if (value === '' || value.length > 1024 || TERMINAL_CONTROL_CHARS.test(value)) {
    return false;
  }
  return isBareCommandName(value) || path.isAbsolute(value);
}

/** An argument every dialect reads as itself, so it can be typed without quotes. */
const PLAIN_TERMINAL_ARG = /^[A-Za-z0-9_.\/-][A-Za-z0-9_.\/=-]*$/;

function quoteTerminalWord(shell: TerminalShell, word: string): string | undefined {
  if (TERMINAL_CONTROL_CHARS.test(word)) {
    return undefined;
  }
  if (shell === 'posix') {
    return `'${word.replace(/'/g, `'\\''`)}'`;
  }
  if (word === '') {
    // Windows PowerShell 5 drops an empty argument to a native command, and cmd has no
    // spelling of one that every program's own parser agrees on.
    return undefined;
  }
  if (shell === 'powershell') {
    // A double quote does not survive PowerShell's argument passing to a native command
    // (before 7.3 it is silently removed), so there is no safe spelling of one.
    return word.includes('"') ? undefined : `'${word.replace(/'/g, "''")}'`;
  }
  // cmd: inside double quotes everything is literal except `"` itself, `%VAR%` expansion
  // and (when enabled) `!VAR!` expansion — none of which can be escaped reliably.
  if (/["%!]/.test(word)) {
    return undefined;
  }
  // A backslash run before the closing quote would escape it for the program's own parser.
  return `"${word.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * THE way a command line for the user's terminal is spelled — every `terminal.sendText` of
 * this extension goes through it, and nothing assembles one by hand. Returns undefined when
 * some part cannot be written safely in that shell (a control character anywhere; on
 * PowerShell a `"` or an empty argument; on cmd a `"`, `%`, `!` or an empty argument): the
 * caller types NOTHING and tells the user, rather than typing an approximation.
 *
 *  - `command`: a bare name is typed as is; anything else is quoted as a path (PowerShell
 *    needs the call operator in front of a quoted command, which this adds).
 *  - `args`: each one is a single argument. One that is made only of letters, digits and
 *    `_ . / - =` is typed as is; every other one is quoted, so `$`, backticks, `;`, `!`,
 *    spaces, globs and quotes inside it reach the program as literal text.
 */
export function terminalCommandLine(
  shell: TerminalShell,
  command: string,
  args: readonly string[] = [],
): string | undefined {
  const words: string[] = [];
  if (isBareCommandName(command)) {
    words.push(command);
  } else {
    const quoted = command === '' ? undefined : quoteTerminalWord(shell, command);
    if (quoted === undefined) {
      return undefined;
    }
    words.push(shell === 'powershell' ? `& ${quoted}` : quoted);
  }
  for (const arg of args) {
    if (PLAIN_TERMINAL_ARG.test(arg)) {
      words.push(arg);
      continue;
    }
    const quoted = quoteTerminalWord(shell, arg);
    if (quoted === undefined) {
      return undefined;
    }
    words.push(quoted);
  }
  return words.join(' ');
}
