/**
 * The agent CLIs a worker account can run on, and everything the rest of the codebase needs
 * to know about each WITHOUT importing a vendor adapter.
 *
 * Leaf module: imports only `os`, `path` and `./platform`. The extension host (plain tsc
 * output, no bundler) may import it freely; the actual vendor adapters
 * (`@toragonite/agent-mesh-*`) are imported only by the esbuild-bundled entry points under
 * `src/mcp/`.
 *
 * Facts below were read from each CLI's own `--help` on 2026-10-13 (codex-cli 0.145.0,
 * cursor-agent 2026.09.18, agy 1.1.12) and from the adapter documentation. Claude Code is
 * the only provider with session workers (`claude --bg`), a plan-usage control request and a
 * frontier guard; every other provider is dispatched one-shot through its adapter.
 */
import * as os from 'os';
import * as path from 'path';
import { normalizeModel, MODEL_FORMS_HINT, WORKER_MODELS, WORKER_PERMISSION_MODES } from './platform';

export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The provider of a worker whose registry entry names none (every v1.x worker). */
export const DEFAULT_PROVIDER: ProviderId = 'claude';

export interface ProviderInfo {
  id: ProviderId;
  /** Product name for UI and tool text. */
  label: string;
  /** Default executable name, resolved on PATH. */
  cli: string;
  /** Can run as a persistent, attachable, steerable session worker (`claude --bg`). */
  sessionWorkers: boolean;
  /**
   * How one login is kept apart from another:
   *  - `env`: an environment variable names the account's home directory (`homeEnv`);
   *  - `none`: the CLI has a single ambient login — one account per machine.
   */
  isolation: 'env' | 'none';
  /** Variable carrying the account home when `isolation === 'env'`. */
  homeEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'AGY_HOME' | null;
  /**
   * Whether `homeEnv` isolation is a verified, supported behaviour. Antigravity accepts
   * `AGY_HOME` but its credentials live in the desktop app's data directory, so a second
   * home is NOT known to give a second login.
   */
  isolationVerified: boolean;
  /** Arguments (after the CLI name) that start an interactive login, or null when the
   *  provider signs in elsewhere (Antigravity: the desktop app). */
  loginArgs: readonly string[] | null;
  /** Values accepted as this provider's permission / sandbox mode, in UI order. */
  permissionModes: readonly string[];
  /** Mode used when a worker names none. `null` = pass no mode flag (the CLI's default). */
  defaultPermissionMode: string | null;
  /** Models offered as a worker default in the UI. NOT a validation list. */
  suggestedModels: readonly string[];
}

const INFO: Readonly<Record<ProviderId, ProviderInfo>> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cli: 'claude',
    sessionWorkers: true,
    isolation: 'env',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    isolationVerified: true,
    loginArgs: ['auth', 'login'],
    permissionModes: WORKER_PERMISSION_MODES,
    defaultPermissionMode: 'acceptEdits',
    suggestedModels: WORKER_MODELS,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cli: 'codex',
    sessionWorkers: false,
    isolation: 'env',
    homeEnv: 'CODEX_HOME',
    isolationVerified: true,
    loginArgs: ['login'],
    // `codex exec --sandbox`. A dispatched task edits files, so read-only is not the default.
    permissionModes: ['workspace-write', 'read-only', 'danger-full-access'],
    defaultPermissionMode: 'workspace-write',
    // What `codex app-server` `model/list` offered a ChatGPT login on 2026-10-14 (newest first).
    // Only a fallback: the picker asks the CLI for its current list.
    suggestedModels: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    cli: 'cursor-agent',
    sessionWorkers: false,
    isolation: 'none',
    homeEnv: null,
    isolationVerified: false,
    loginArgs: ['login'],
    // `cursor-agent --sandbox`. Print mode already has write and shell access by default.
    permissionModes: ['enabled', 'disabled'],
    defaultPermissionMode: null,
    suggestedModels: ['auto', 'composer-2.5'],
  },
  gemini: {
    id: 'gemini',
    label: 'Antigravity',
    cli: 'agy',
    sessionWorkers: false,
    isolation: 'env',
    homeEnv: 'AGY_HOME',
    isolationVerified: false,
    loginArgs: null,
    // `agy --mode`.
    permissionModes: ['accept-edits', 'plan'],
    defaultPermissionMode: 'accept-edits',
    suggestedModels: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
  },
};

export function providerInfo(id: ProviderId): ProviderInfo {
  return INFO[id];
}

/** Every provider, in display order. */
export function allProviders(): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => INFO[id]);
}

/** A stored or requested provider id, or undefined when it is not one we know. */
export function parseProvider(raw: unknown): ProviderId | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  // `antigravity` and `agy` are what a person calls the `gemini` adapter's product and CLI.
  const alias = v === 'antigravity' || v === 'agy' ? 'gemini' : v === 'claude-code' ? 'claude' : v;
  return (PROVIDER_IDS as readonly string[]).includes(alias) ? (alias as ProviderId) : undefined;
}

/**
 * The provider of a REGISTRY entry, from its raw `provider` value.
 *  - absent (`undefined` or `null`) is Claude Code: every entry written before 2.0 has none;
 *  - a value naming a provider, or one of its aliases, is that provider;
 *  - ANYTHING ELSE returns undefined: an entry this version does not support. The caller must
 *    keep such an entry out of every enumeration and must never treat it as any provider — it
 *    names another vendor's home directory, and whatever would be run against a Claude account
 *    would be run against that directory.
 */
export function storedProvider(raw: unknown): ProviderId | undefined {
  if (raw === undefined || raw === null) {
    return DEFAULT_PROVIDER;
  }
  return parseProvider(raw);
}

/**
 * The home directory an account of this provider uses when it is the machine's ordinary
 * ("ambient") login. For Cursor, which has no isolation, this is only an identity label.
 */
export function defaultProviderHome(id: ProviderId): string {
  const home = os.homedir();
  switch (id) {
    case 'claude':
      return path.join(home, '.claude');
    case 'codex':
      return path.join(home, '.codex');
    case 'cursor':
      return path.join(home, '.cursor');
    case 'gemini':
      return path.join(home, '.agy');
  }
}

/**
 * The `configDir` to hand a vendor adapter's `Account` for a worker stored with `configDir`:
 * undefined (= use the ambient login) when the provider has no isolation or the stored dir
 * IS the provider's default home; otherwise the stored string verbatim.
 */
export function adapterAccountDir(id: ProviderId, configDir: string): string | undefined {
  if (INFO[id].isolation !== 'env') {
    return undefined;
  }
  return path.resolve(configDir) === path.resolve(defaultProviderHome(id)) ? undefined : configDir;
}

/** A non-Claude model id: one token, no whitespace or shell metacharacters, ≤ 120 chars.
 *  Brackets, `=`, `,` and `:` are allowed because Cursor's parameterized ids use them. */
const FOREIGN_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/=,\[\]-]{0,119}$/;

/**
 * Normalize a model value FOR A GIVEN PROVIDER.
 *  - Claude Code: `normalizeModel` (aliases, v1.x tier ids, full ids).
 *  - others: the trimmed string when it has the shape of a model id; these catalogs are
 *    large and change often, so the adapter — not this function — decides whether the id
 *    exists (an id outside its catalog still runs, with a note on the result).
 * undefined for anything else. An EXPLICITLY supplied model that normalizes to undefined is
 * an error for the caller, never "use the default".
 */
export function normalizeProviderModel(id: ProviderId, raw: unknown): string | undefined {
  if (id === 'claude') {
    return normalizeModel(raw);
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const v = raw.trim();
  return FOREIGN_MODEL.test(v) ? v : undefined;
}

/** One line for an error message: what `normalizeProviderModel` accepts for this provider. */
export function providerModelHint(id: ProviderId): string {
  return id === 'claude'
    ? MODEL_FORMS_HINT
    : `${/^[aeiou]/i.test(INFO[id].label) ? 'an' : 'a'} ${INFO[id].label} model id such as ${INFO[id].suggestedModels[0]}`;
}

/**
 * Is `modelId`, as provider `id` lists or accepts it, one of that provider's OWN models — as
 * opposed to another vendor's model that the provider resells through its plan?
 *
 * Why it matters: a resold model spends THIS account's plan on a model another worker account
 * may already pay for at its source, so pickers list own models first and say so for the rest.
 *
 * The rule is positive wherever the answer is known, and never a guess:
 *  - Cursor's own models are a closed, named set — `auto`, `composer*`, `cursor-*` — and
 *    everything else its CLI lists is another vendor's (the bundled adapter draws the same
 *    line), whatever family it is;
 *  - for the other providers, a model is another vendor's only when it carries another
 *    vendor's family prefix (`claude`; `gpt` / `o1` / `o3` / `o4` / `codex`; `gemini`; `grok`).
 *    An id of a family this code does not know is NOT called resold.
 */
export function isOwnModelFamily(id: ProviderId, modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  const family = (prefix: string): boolean => m === prefix || m.startsWith(`${prefix}-`);
  const anthropic = family('claude');
  const openai = family('gpt') || family('o1') || family('o3') || family('o4') || family('codex');
  const google = family('gemini');
  const xai = family('grok');
  switch (id) {
    case 'claude':
      return !(openai || google || xai);
    case 'codex':
      return !(anthropic || google || xai);
    case 'gemini':
      return !(anthropic || openai || xai);
    case 'cursor':
      return m === 'auto' || m.startsWith('composer') || family('cursor');
  }
}

/** Bare window names an adapter reports (Codex, Cursor, Antigravity bucket ids), in the words every surface uses (the views localize them). */
const USAGE_WINDOW_LABELS: ReadonlyMap<string, string> = new Map([
  // Codex: two rolling windows the vendor does not name.
  ['primary', 'Primary limit'],
  ['secondary', 'Secondary limit'],
  // Cursor: three percentages of the billing period — all usage, Auto + Composer, other models.
  ['total', 'Total usage'],
  ['auto', 'Auto + Composer'],
  ['api', 'API usage'],
  // Antigravity: the Gemini models' weekly and five-hour limits, and those of the "Claude and
  // GPT models" (third-party) bucket. The adapter reports the bucket id as the label.
  ['gemini-weekly', 'Gemini weekly'],
  ['gemini-5h', 'Gemini 5-hour'],
  ['3p-weekly', 'Claude + GPT weekly'],
  ['3p-5h', 'Claude + GPT 5-hour'],
]);

/**
 * The English label of a plan-usage window as an adapter names it. Adapters report bare names
 * (`primary` / `secondary` for Codex, `total` / `auto` / `api` for Cursor, `gemini-weekly` /
 * `gemini-5h` / `3p-weekly` / `3p-5h` for Antigravity) for windows the vendor gives no name; every surface shows them in the words of USAGE_WINDOW_LABELS. Any
 * other label is the vendor's own and is returned as given.
 */
export function usageWindowLabel(raw: string): string {
  return USAGE_WINDOW_LABELS.get(raw.trim().toLowerCase()) ?? raw;
}

/**
 * A worker's permission mode for its provider: the stored value when the provider accepts
 * it, else the provider default (which may be `null` = pass no flag).
 */
export function normalizeProviderPermissionMode(id: ProviderId, raw: unknown): string | null {
  const info = INFO[id];
  return typeof raw === 'string' && info.permissionModes.includes(raw) ? raw : info.defaultPermissionMode;
}

/**
 * What is known about one non-Claude account right now — the single shape shared by the
 * bundled helper (`out/mcp/provider-cli.js status …`, which prints it as one line of JSON),
 * the dispatch server (which computes it in-process) and the usage cache writer.
 *
 * Every field is "unknown" rather than a guess when it could not be determined: `loggedIn:
 * null` is NOT "logged out", and `quota: null` is "no usage reading", never "no usage".
 * No token, e-mail or raw vendor payload ever appears in it.
 */
export interface ProviderStatus {
  /** false only when the CLI itself could not be started (not installed / not on PATH). */
  cliFound: boolean;
  loggedIn: boolean | null;
  /** Vendor auth mode as the adapter reports it (e.g. "chatgpt", "api-key", "cursor"), ≤ 32 chars. */
  mode: string | null;
  quota: {
    /** Whether the vendor currently permits new work. */
    allowed: boolean;
    windows: Array<{ label: string; usedPercent: number; resetAt: string | null }>;
  } | null;
  /** Why the reading is incomplete, flattened, ≤ 200 chars; null when nothing went wrong. */
  error: string | null;
}
