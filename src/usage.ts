import { ChildProcess, ChildProcessByStdio, fork, spawn } from 'child_process';
import { createHash } from 'crypto';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from './displayText';
import { claudeEnv, configDirBinding, hostConfigDir, normalizeModel, vendorChildEnv } from './platform';
import { normalizeProviderModel, type ProviderId, type ProviderStatus } from './providers';
import {
  claudeWorkers,
  ensureDirs,
  isSpawnableFile,
  readRegistry,
  resolveViaLoginShell,
  ROOT_DIR,
  workerProvider,
  type Registry,
} from './registry';
import { readTextSafe, statFileSafe } from './safeFs';

/**
 * Live account usage via the Claude Code control protocol `get_usage` request.
 *
 * A short-lived `claude` process is spawned in stream-json mode as the account
 * living in a target config dir (platform.claudeEnv decides how that directory is
 * presented to the child); a single control_request {subtype:"get_usage"} returns the
 * same structured /usage data the interactive `/usage` command shows — session
 * cost totals plus claude.ai plan rate-limit utilization/reset "when available".
 * The same session is also asked `initialize`, whose answer carries the account's own `/model`
 * menu and who it is signed in as; what of that is kept is in AccountUsage (`models`,
 * `accountKey`, `planLabel`) — never the e-mail address itself.
 * No credentials are read or handled here: Claude Code authenticates itself
 * under the given config dir (mirrors how workers are dispatched).
 *
 * THE CHILD IS ENDED GRACEFULLY, NEVER KILLED OUTRIGHT (see terminateChild). A `claude -p`
 * process that is SIGKILLed leaves two files behind in `<configDir>/sessions/`, and this
 * probe runs every few minutes per account for as long as an editor is open.
 *
 * UPSTREAM IS EXPERIMENTAL. The get_usage response is documented as "the
 * response shape may change", so every field is read defensively and any parse
 * gap degrades to `available:false` rather than throwing. This module never
 * rejects and never throws to its callers — every path resolves an AccountUsage.
 *
 * OTHER VENDORS' ACCOUNTS (Codex, Cursor, Antigravity) share the same cache file and the same
 * entry shape, but are never probed with the `claude` CLI: their readings arrive as a
 * `ProviderStatus` (see "Other vendors' accounts" at the end of this file) and are merged in
 * by recordProviderStatus.
 *
 * Must not import 'vscode': src/mcp/server.ts imports this module and is bundled
 * (esbuild) into the standalone dispatch server. Node + registry, platform, providers,
 * displayText and safeFs only — and never a vendor adapter package: the extension host loads
 * this file unbundled.
 */

/** Rate-limit windows we surface. Upstream `limits[].kind` may carry others; we ignore the rest. */
export type UsageWindowKind = 'session' | 'weekly_all' | 'weekly_scoped';

/** Human label matching the `/usage` UI, per confirmed mapping. */
const WINDOW_LABELS: Record<UsageWindowKind, string> = {
  session: 'Session (5hr)',
  weekly_all: 'Weekly (7 day)',
  weekly_scoped: 'Weekly Fable',
};

const WINDOW_ORDER: UsageWindowKind[] = ['session', 'weekly_all', 'weekly_scoped'];

export interface UsageWindow {
  kind: UsageWindowKind;
  /** Display label ('Session (5hr)' | 'Weekly (7 day)' | 'Weekly Fable'). */
  label: string;
  /** 0-100, clamped. */
  percent: number;
  /** Raw upstream severity ('normal' | 'warning' | 'critical' | unknown); 'normal' when absent. */
  severity: string;
  /** ISO-8601 reset timestamp, or null when absent/invalid. */
  resetsAt: string | null;
}

/**
 * Overage ("extra usage") billing state. While `enabled` is false, exhausting a
 * plan window BLOCKS further work — dispatches spend quota, never money. Once it
 * is enabled, work past a plan limit is billed against a monthly cap instead, so
 * a dispatch that overruns the window starts spending real money.
 */
export interface ExtraUsage {
  enabled: boolean;
  /** Percent of the monthly overage cap consumed (0-100), or null when not reported. */
  percent: number | null;
  /** Formatted spend against the cap, e.g. "$0.00 / $50.00". null when not reported. */
  spendLabel: string | null;
}

/**
 * Result of a `claude auth status --json` probe, used to DISAMBIGUATE the two very
 * different accounts that both report `rate_limits_available:false`:
 *
 *  - a genuine token / non-subscription login (still usable — it just has no
 *    claude.ai plan windows to show), and
 *  - a claude.ai subscription login whose credentials have EXPIRED (unusable until
 *    the user logs in again).
 *
 * Without this probe both collapse into "no plan limits", so the UI mislabels an
 * expired login as a token account and the user never learns they must re-login.
 */
export interface AuthStatus {
  /** Verbatim `loggedIn` from the CLI. false is the expired/logged-out signal. */
  loggedIn: boolean;
  /** Verbatim `authMethod` ('claude.ai', 'none', …), or null when absent/non-string. */
  method: string | null;
  /**
   * The email the CLI itself reported, or null when it reported none. The CLI
   * omits `email` entirely once the login has expired, so this is null in exactly
   * the expired case — which is fine: nothing reads it. The "re-login as <email>"
   * affordance recovers the address itself, from the account's own config file
   * (platform.accountConfigFile), on the user-initiated terminal path. This field is
   * NOT a fallback source and deliberately does no disk I/O: it is populated on the
   * hot refresh path, which must not read a multi-megabyte file per account.
   */
  email: string | null;
  /** Epoch ms when this auth reading was taken. */
  checkedAt: number;
  /**
   * PROVENANCE of a logged-out verdict on another vendor's account: present, and `true`, only
   * when the reading was recorded BECAUSE A RUN FAILED ON LOGIN (recordProviderStatus with
   * `fromRun`) rather than read from the CLI's own status command. Never present beside
   * `loggedIn: true`.
   *
   * It exists because the two sources disagree and the run is the one that is right: a vendor
   * CLI's status command can answer "logged in" for an account its own run has just refused to
   * work for (Cursor's does), and the next status refresh would then overwrite the only true
   * reading there is. A verdict carrying this mark is held against status readings for
   * RUN_LOGIN_FAILURE_STICKY_MS — see runLoginFailureAt for the three things that end it.
   */
  fromRun?: true;
  /** Epoch ms of the run that failed on login. Present exactly when `fromRun` is. */
  fromRunAt?: number;
}

export interface AccountUsage {
  /** 'main' for the orchestrator's own config dir, else the worker name. */
  name: string;
  configDir: string;
  /** True only when the account exposes claude.ai plan rate limits (rate_limits_available). */
  available: boolean;
  /** claude.ai plan ('max', 'pro', …) or null when not exposed. */
  subscriptionType: string | null;
  /** Ordered session/weekly_all/weekly_scoped; empty when unavailable or on error. */
  windows: UsageWindow[];
  /** Current session accumulated cost, or null. */
  sessionCostUsd: number | null;
  /** Overage billing state, or null when the account reports none. */
  extraUsage: ExtraUsage | null;
  /** Epoch ms when this reading was taken. */
  fetchedAt: number;
  /**
   * Epoch ms when the `windows` were actually observed fresh from upstream. Equals
   * `fetchedAt` for a fresh reading; older when the windows were carried over
   * because a later probe returned none. Absent when there are no windows.
   */
  windowsFetchedAt?: number;
  /**
   * True when `windows` are carried over from an earlier reading because the
   * latest get_usage returned `rate_limits: null` (an intermittent upstream
   * state). The values are real but not current; surfaces should mark them.
   */
  windowsStale?: boolean;
  /**
   * Epoch ms of the most recent reading that actually CONTAINED windows. Unlike
   * `windowsFetchedAt` (which is cleared once the 30-min stale carry expires and
   * the windows go empty), this survives indefinitely across empty readings, so a
   * UI can say "temporarily unavailable (last good reading X ago)" instead of a
   * generic empty state. Absent only when no windows have ever been observed.
   */
  lastGoodWindowsAt?: number;
  /**
   * Set ONLY when the probe itself failed (timeout, spawn error, non-success
   * control_response, unparseable output). Distinct from available:false, which
   * is a valid state meaning "this account has no plan rate limits" (e.g. a
   * setup-token / non-subscription login). Callers must treat
   * error===undefined && available===false as "no limits", NOT as a failure.
   */
  error?: string;
  /**
   * Auth reading taken ONLY for the ambiguous case (no probe error, but
   * available!==true) to tell an expired login apart from a token account.
   *
   * CRITICAL, and asymmetric by design: a `loggedIn:false` reading is NEVER carried
   * forward from a previous cache entry. Every refresh cycle re-probes a suspected
   * logged-out account, so a recovery is detected within one cycle and a stale
   * "expired" verdict can never be resurrected. That is what makes the state
   * self-heal: once an account is re-logged-in and reports available:true we stop
   * probing, the fresh entry simply has no `auth`, and the verdict disappears on its
   * own.
   *
   * A `loggedIn:true` reading IS deliberately memoized for up to AUTH_MEMO_TTL_MS —
   * see shouldReuseAuth, applied in refreshAllUsage. Such accounts (genuine
   * token/API-key logins) are permanently ambiguous upstream: they report
   * rate_limits_available:false forever and answer `loggedIn:true` every time, so
   * re-spawning `claude auth status` every refresh cycle bought an answer that never
   * changes. mergeStaleWindows itself still never touches `auth`; the reuse happens
   * only in refreshAllUsage, before the merge, and only for that benign verdict.
   *
   * All of the above is about CLAUDE CODE accounts, whose verdict comes from a probe that can
   * be repeated. On another vendor's account there is one deliberate, bounded exception: a
   * logged-out verdict that a failed RUN produced (`auth.fromRun`) is held against that
   * vendor's status command for RUN_LOGIN_FAILURE_STICKY_MS — see runLoginFailureAt.
   *
   * Read it through parseAuth (the cache file is hand-editable).
   */
  auth?: AuthStatus;
  /*
   * What the account's CLI answered `initialize` with, in the usage probe's own session. These
   * four are written only for a CLAUDE CODE account, and kept from the previous entry when a
   * reading brings none (an older CLI, a failed probe). Every reader checks them by value —
   * the file is hand-editable — through claudeMenuOf / accountKeyOf / planLabelOf; a missing
   * field means "not known", never an error.
   */
  /**
   * The account's `/model` menu, in the CLI's order, at most CLAUDE_MENU_MAX entries: `value`
   * is `default` or a model `normalizeModel(value, { exact: true })` returns unchanged (an
   * alias or a full id); `label` (the CLI's display name) and `description` are display-safe
   * single lines. Absent when no answer had one.
   */
  models?: ClaudeMenuModel[];
  /** Epoch ms when `models` was read. */
  modelsFetchedAt?: number;
  /**
   * Who the account is signed in as, without saying it: the first 16 hex characters of
   * SHA-256 over the lowercased, trimmed e-mail address, a line feed, and the organization's id
   * (else its name, else nothing) — see accountKeyFor. Two accounts with one key are one
   * claude.ai account and draw on one plan's limits. The address itself is never stored.
   * Absent when the answer named no address.
   */
  accountKey?: string;
  /** The plan as the CLI names it (`Claude Max`), one display-safe line ≤ 40 chars. */
  planLabel?: string;
  /**
   * The last LOGIN_PROBES_KEPT login probes of a CLAUDE CODE account, oldest first — what the
   * login state (loginStateOf, contract-2.0-fixes.md "Login state (CA)") is computed from.
   * Written by this version's probes only (refreshAllUsage, checkClaudeLogin, recordClaudeRunLogin),
   * so an entry without it was written by something else — an older version, a hand edit — and
   * its login is "not confirmed", whatever its `auth` says. Never present on another vendor's
   * entry. Read it through parseLoginProbes (the file is hand-editable).
   */
  loginProbes?: LoginProbe[];
}

/** One entry of a Claude Code account's `/model` menu (AccountUsage.models). */
export interface ClaudeMenuModel {
  /** `default`, an alias (`opus`) or a full model id, as the CLI lists it. */
  value: string;
  /** The CLI's display name for it (`Opus 5.5`), ≤ 60 chars; the value when it gave none. */
  label: string;
  /** The CLI's one line about it, ≤ 120 chars; absent when it gave none. */
  description?: string;
}

export const USAGE_CACHE_FILE = path.join(ROOT_DIR, 'usage.json');

/** Default probe timeout. get_usage returns in ~1-2s; 20s is a generous ceiling. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * CEILING for the `claude auth status --json` probe. It is a local credential
 * check that returns in well under a second, so 10s is already generous.
 *
 * This is a ceiling, not a fixed budget: refreshAllUsage narrows it to
 * min(AUTH_PROBE_TIMEOUT_MS, its own timeoutMs) so the probe SHARES the caller's
 * per-account latency budget rather than adding to it. Callers that pass a tight
 * timeout (the MCP server uses 5s to bound list_workers) would otherwise wait
 * timeoutMs + 10s per ambiguous account, since the probe fires exactly for those.
 */
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

const clampPercent = (n: unknown): number => {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 100 ? 100 : v;
};

const validIso = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s) {
    return null;
  }
  return isNaN(Date.parse(s)) ? null : s;
};

/** True when a window's severity is not the benign 'normal'. UI coloring helper. */
export function isElevated(severity: string): boolean {
  return severity !== 'normal' && severity !== '';
}

/** Render how long ago an epoch-ms instant was, e.g. "6m ago" / "1.2h ago" / "just now". Guards NaN. */
export function formatAge(epochMs: number | undefined): string {
  if (typeof epochMs !== 'number' || !isFinite(epochMs)) {
    return '';
  }
  const ms = Date.now() - epochMs;
  if (ms < 60_000) {
    return 'just now';
  }
  const min = ms / 60_000;
  return min < 60 ? `${Math.round(min)}m ago` : `${(min / 60).toFixed(1)}h ago`;
}

/** Render a reset timestamp relative to now, e.g. "in 3.9h" / "in 3.7d" / "now". Guards bad dates. */
export function formatRelativeReset(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const ms = Date.parse(iso) - Date.now();
  if (isNaN(ms)) {
    return '—';
  }
  if (ms <= 0) {
    return 'now';
  }
  const hours = ms / 3_600_000;
  return hours < 24 ? `in ${hours.toFixed(1)}h` : `in ${(hours / 24).toFixed(1)}d`;
}

/**
 * formatAge and formatRelativeReset above return ENGLISH and are for text this module's
 * server-side callers compose in English (list_workers, refusal messages). A surface of the
 * extension host must not embed them in a localized sentence: it has its own formatter, built
 * on vscode.l10n (views.ts: agoText / untilText).
 */

/** Suffixes of formatTokenCount, a thousand apart. The last covers everything a count can be. */
const COUNT_UNITS = ['k', 'M', 'B', 'T', 'Q'] as const;

/**
 * A token count as a row shows it: exact below 10,000 (`9,999`), then one decimal and a unit —
 * `10.0k`, `642.8k`, `17.9M`, `1.2B`. THE one helper for it: the unit is chosen from the ROUNDED
 * figure, so a count just under a boundary reads `1.0M`, never `1000.0k`, and nothing ever
 * prints `17891.6k`.
 *
 * A count is a non-negative whole number no larger than Number.MAX_SAFE_INTEGER — the bound the
 * dashboard model puts on every count it reads (uiModel `amount`). Anything else — NaN, an
 * infinity, a string, a negative number, `1e300` out of a hand-edited file — is not a count and
 * reads `0`, as it does there (`uiTypes.ts` rule 1); a fraction is rounded. With that bound the
 * largest figure there is prints `9.0Q`, so no input at all has four digits before its unit.
 * Language-neutral apart from the digit grouping below 10,000, which is the runtime's own.
 */
export function formatTokenCount(value: unknown): string {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    return '0';
  }
  const count = Math.round(value);
  if (count < 10_000) {
    return count.toLocaleString();
  }
  let scaled = count / 1000;
  let unit = 0;
  // 999,950 is 999.95k, which one decimal prints as "1000.0k": step up while the PRINTED
  // figure would reach 1000 and there is a larger unit to step to.
  while (unit < COUNT_UNITS.length - 1 && Number(scaled.toFixed(1)) >= 1000) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled.toFixed(1)}${COUNT_UNITS[unit]}`;
}

/**
 * The CLAUDE CODE accounts a usage view covers: the orchestrator's own dir ('main') plus every
 * Claude Code worker.
 *
 * 'main' is platform.hostConfigDir() — the directory THIS process's own session runs under —
 * so the one definition of "the host's account" is shared with claudeEnv, which is what
 * decides whether a child for that directory gets CLAUDE_CONFIG_DIR at all.
 *
 * A worker on another vendor's CLI is NOT in this list, and that is the point of it: the
 * callers hand these directories to the `claude` binary — the usage probe and the auth probe
 * (refreshAllUsage / refreshAllUsageIfStale, whose default account list this is) — or treat
 * them as Claude Code config dirs (isClaudeAccountDir below; the dispatch server's read of
 * main's overage state), and a Codex or Cursor home is not one. Those accounts are
 * listProviderAccounts(). Which workers are Claude Code accounts is the registry's
 * `claudeWorkers` — the one enumeration of them.
 */
export function listAccounts(): { name: string; configDir: string }[] {
  const mainDir = hostConfigDir();
  const accounts = [{ name: 'main', configDir: mainDir }];
  for (const w of claudeWorkers(readRegistry())) {
    if (w.configDir !== mainDir) {
      accounts.push({ name: w.name, configDir: w.configDir });
    }
  }
  return accounts;
}

/** Map the get_usage response payload to our normalized windows. Defensive: never throws. */
function parseWindows(data: Record<string, unknown>): UsageWindow[] {
  const rl = (data.rate_limits ?? {}) as Record<string, unknown>;
  const out: Partial<Record<UsageWindowKind, UsageWindow>> = {};

  // Preferred source: the normalized limits[] array (only place weekly_scoped/Fable appears).
  const limits = Array.isArray(rl.limits) ? (rl.limits as Record<string, unknown>[]) : [];
  for (const l of limits) {
    const kind = l.kind as string;
    if (kind === 'session' || kind === 'weekly_all' || kind === 'weekly_scoped') {
      out[kind] = {
        kind,
        label: WINDOW_LABELS[kind],
        percent: clampPercent(l.percent),
        severity: typeof l.severity === 'string' && l.severity ? l.severity : 'normal',
        resetsAt: validIso(l.resets_at),
      };
    }
  }

  // Fallback for builds that only populate the top-level window objects.
  const fromTop = (kind: UsageWindowKind, key: string) => {
    if (out[kind]) {
      return;
    }
    const w = rl[key] as Record<string, unknown> | undefined;
    if (w && typeof w.utilization === 'number') {
      out[kind] = {
        kind,
        label: WINDOW_LABELS[kind],
        percent: clampPercent(w.utilization),
        severity: 'normal',
        resetsAt: validIso(w.resets_at),
      };
    }
  };
  fromTop('session', 'five_hour');
  fromTop('weekly_all', 'seven_day');

  return WINDOW_ORDER.map((k) => out[k]).filter((w): w is UsageWindow => w !== undefined);
}

/**
 * Read `rate_limits.extra_usage`. Upstream is Experimental and every field may be
 * null, so anything unreadable degrades to null rather than a misleading zero.
 * Amounts arrive in minor units: `used_credits: 0, monthly_limit: 5000,
 * decimal_places: 2` means $0.00 spent of a $50.00 cap.
 */
function parseExtraUsage(data: Record<string, unknown>): ExtraUsage | null {
  const rl = (data.rate_limits ?? {}) as Record<string, unknown>;
  const eu = rl.extra_usage as Record<string, unknown> | undefined | null;
  if (!eu || typeof eu !== 'object') {
    return null;
  }
  const percent =
    typeof eu.utilization === 'number' && isFinite(eu.utilization) ? clampPercent(eu.utilization) : null;
  const dp =
    typeof eu.decimal_places === 'number' && eu.decimal_places >= 0 && eu.decimal_places <= 6
      ? eu.decimal_places
      : 2;
  const money = (v: unknown): string | null => {
    if (typeof v !== 'number' || !isFinite(v)) {
      return null;
    }
    const amount = (v / Math.pow(10, dp)).toFixed(dp);
    return typeof eu.currency === 'string' && eu.currency && eu.currency !== 'USD'
      ? `${amount} ${eu.currency}`
      : `$${amount}`;
  };
  const used = money(eu.used_credits);
  const cap = money(eu.monthly_limit);
  return {
    enabled: eu.is_enabled === true,
    percent,
    spendLabel: used !== null && cap !== null ? `${used} / ${cap}` : used,
  };
}

/**
 * How long a FAILED probe-command resolution is trusted before another login-shell
 * attempt is made. Resolution costs a synchronous shell spawn of up to 10s, and a
 * broken environment fails it every time — paying that per probe would stall the
 * extension host and the dispatch server. One attempt per window is enough for
 * recovery to land within a minute of the binary coming back.
 */
export const PROBE_RESOLVE_RETRY_MS = 60_000;

/**
 * Last login-shell resolution attempt: the command it was RESOLVING (`base`), its
 * result (absolute on success, the bare base name on failure), and when it was
 * made.
 *
 * `base` is part of the memo because the resolution target can change within a
 * process lifetime, and a memo that ignores it answers for the wrong command
 * forever: renaming the configured command (say to a wrapper script) would keep
 * handing back the old binary's path, and after an nvm node upgrade the previous
 * version's bin dir still exists, so its path would stay both spawnable and
 * memoized indefinitely. A memo whose `base` differs from the current target is
 * treated exactly like no memo at all.
 */
let probeCommandMemo: { base: string; value: string; at: number } | null = null;

/**
 * The command to spawn for a usage/auth probe, resolved to an absolute path when
 * the registry's value cannot be spawned as-is.
 *
 * Probes run in processes that do NOT have the login-shell PATH (the bundled MCP
 * server, and extension hosts launched from the Dock), so a bare `claude` — or an
 * absolute path whose binary was moved or is mid-reinstall — fails with ENOENT on
 * every probe until the extension happens to re-sync the registry. Resolving here,
 * at spawn time, makes the probe independent of when that sync last ran.
 *
 * On win32 the raw value is returned untouched, because login-shell resolution has
 * no meaning there — there is no login shell to ask. Resolving a bare name on
 * win32 is OUT OF SCOPE for this helper: whatever the platform's own spawn
 * semantics do with it is what happens, exactly as before this helper existed.
 *
 * The registry value is trimmed first: ' claude' is non-empty, so it passes every
 * emptiness check, yet untrimmed it matches no guard and resolves nowhere.
 *
 * Failures are memoized as well as successes: a failed attempt suppresses further
 * shell spawns for PROBE_RESOLVE_RETRY_MS and the raw value is returned so spawn
 * produces its own ENOENT. A clock that jumped backwards yields a negative age,
 * which counts as expired — recovery must never be deferred indefinitely. The
 * memo answers only for the command it actually resolved (see probeCommandMemo),
 * and a memoized absolute path is re-checked on disk each call — as an EXECUTABLE
 * FILE, not merely as an existing name — so a binary that disappears, becomes a
 * directory, or loses its exec bit mid-reinstall is re-resolved rather than
 * trusted.
 */
export function resolveProbeCommand(nowMs: number = Date.now()): string {
  let raw = 'claude';
  try {
    const configured = readRegistry().claudePath;
    if (typeof configured === 'string' && configured.trim() !== '') {
      raw = configured.trim();
    }
  } catch {
    // registry unreadable — fall back to bare command
  }
  if (process.platform === 'win32') {
    return raw;
  }
  if (path.isAbsolute(raw) && isSpawnableFile(raw)) {
    return raw;
  }
  const base = path.isAbsolute(raw) ? path.basename(raw) : raw;
  // A memo for a DIFFERENT base answers for a command we are no longer resolving.
  const memo = probeCommandMemo && probeCommandMemo.base === base ? probeCommandMemo : null;
  if (memo) {
    if (path.isAbsolute(memo.value) && isSpawnableFile(memo.value)) {
      return memo.value;
    }
    const age = nowMs - memo.at;
    if (!path.isAbsolute(memo.value) && age >= 0 && age < PROBE_RESOLVE_RETRY_MS) {
      return raw;
    }
  }
  const result = resolveViaLoginShell(base);
  probeCommandMemo = { base, value: result, at: nowMs };
  return path.isAbsolute(result) ? result : raw;
}

/** Clear the probe-command memo. Exists for tests/verification only. */
export function resetProbeCommandMemoForTest(): void {
  probeCommandMemo = null;
}

/**
 * How long a child whose stdin was just ended is given to leave by itself before it is
 * signalled. A `claude -p` stream-json session exits about 1.6s after its stdin ends.
 */
export const CHILD_STDIN_GRACE_MS = 3_000;

/** How long a child that was sent SIGTERM is given before SIGKILL. Observed exit: ~1.4s. */
export const CHILD_SIGTERM_GRACE_MS = 2_000;

/**
 * Ceiling on how long onChildExit waits, after 'exit', for output that was still in the pipe.
 * 'exit' can be emitted before the last stdout chunk has been delivered, so settling on it
 * with no drain at all would discard an answer the child did write.
 */
export const CHILD_EXIT_DRAIN_MS = 250;

/** Children whose ladder is already running — a second call must not stack timers on the first. */
const terminating = new WeakSet<ChildProcess>();

/**
 * End a `claude` child WITHOUT leaking its session files, escalating only as far as needed.
 *
 * WHY THIS IS NOT `child.kill('SIGKILL')`. A SIGKILLed `claude -p` cannot run its own
 * cleanup and leaves `<pid>.json` and `<pid>.<hex>.key` in `<configDir>/sessions/`. The usage
 * probe used to do exactly that after every reading, and accounts accumulated tens of
 * thousands of such files — enough to make `claude agents --json` under that directory take
 * more than 30 seconds. Ending stdin, or SIGTERM, lets the CLI remove both files itself.
 *
 * The ladder:
 *  - `'end-stdin'` (a child driven over a stdin protocol): end its stdin; SIGTERM if it has not
 *    exited CHILD_STDIN_GRACE_MS later; SIGKILL CHILD_SIGTERM_GRACE_MS after that.
 *  - `'signal'` (no stdin protocol to end): SIGTERM now; SIGKILL CHILD_SIGTERM_GRACE_MS later.
 *
 * SIGKILL stays as the last rung on purpose: a child that ignores both gentler requests must
 * still not be left running forever, and two leaked files are the smaller harm.
 *
 * FIRE AND FORGET. This returns immediately and the caller's promise is already resolved —
 * a reading is never held back while its process winds down. Both timers are unref'd, so the
 * ladder alone never keeps this process alive, and both are cleared on the child's 'exit'.
 * "Has it exited" is read from the ChildProcess itself (`exitCode` / `signalCode`), and a
 * child that never spawned (`pid` undefined after a spawn error) is skipped outright: no
 * 'exit' is coming for it, so a ladder armed there would have nothing to clear it.
 *
 * Never throws. `kill` on a process that is already gone is the expected race, not an error.
 */
export function terminateChild(child: ChildProcess, how: 'end-stdin' | 'signal'): void {
  try {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (terminating.has(child)) {
      return;
    }
    terminating.add(child);

    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const send = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    const escalate = (): void => {
      send('SIGTERM');
      killTimer = setTimeout(() => send('SIGKILL'), CHILD_SIGTERM_GRACE_MS);
      killTimer.unref();
    };
    child.once('exit', () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    });

    if (how === 'end-stdin' && child.stdin) {
      try {
        child.stdin.end();
      } catch {
        // stdin already closed — the timer below still covers a child that stays up
      }
      termTimer = setTimeout(escalate, CHILD_STDIN_GRACE_MS);
      termTimer.unref();
    } else {
      escalate();
    }
  } catch {
    // a ChildProcess in a state nobody anticipated — ending it is best-effort, never a throw
  }
}

/**
 * Call `cb` once the child has EXITED — on 'exit', not on 'close'.
 *
 * 'close' waits for every stdio pipe to reach EOF, and a `claude` child that started the
 * background service hands those pipes to a process that outlives it: 'close' then never
 * comes and a wrapper waiting for it never settles. 'exit' is the process's own death and
 * always arrives. Because it can arrive before the last output chunk has been read, `cb` is
 * held until 'close' or CHILD_EXIT_DRAIN_MS, whichever is first; a child with no pipes at
 * all (stdio 'ignore') has nothing to drain and settles at once.
 *
 * When the drain ends with the pipes STILL OPEN they are left open and flowing, on purpose:
 * whatever holds the other end is a live process, and destroying our end would hand it an
 * EPIPE on its next write. They are only unref'd, so they cannot keep this process alive.
 * The caller's 'data' listeners therefore keep firing after `cb`, and must discard what
 * arrives once they have settled rather than accumulate it.
 *
 * The drain timer is deliberately NOT unref'd: it is the only thing guaranteeing `cb` runs
 * when 'close' never does.
 */
export function onChildExit(
  child: ChildProcess,
  cb: (code: number | null, signal: NodeJS.Signals | null) => void,
): void {
  child.once('exit', (code, signal) => {
    let fired = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const fire = (pipesClosed: boolean): void => {
      if (fired) {
        return;
      }
      fired = true;
      clearTimeout(drainTimer);
      if (!pipesClosed) {
        for (const pipe of [child.stdout, child.stderr]) {
          try {
            (pipe as { unref?: () => void } | null)?.unref?.();
          } catch {
            // a stream that cannot be unref'd simply stays ref'd
          }
        }
      }
      cb(code, signal);
    };
    if (!child.stdout && !child.stderr) {
      fire(true);
      return;
    }
    child.once('close', () => fire(true));
    drainTimer = setTimeout(() => fire(false), CHILD_EXIT_DRAIN_MS);
  });
}

/* ------------------------------------------------------------------------- *
 * The `initialize` answer: the account's model menu, and who it is signed in as
 * ------------------------------------------------------------------------- */

/** Most entries of a `/model` menu that are kept. A real menu has about fourteen. */
export const CLAUDE_MENU_MAX = 64;
/** Most entries of an answer's `models` that are looked at, so a huge one costs a bounded scan. */
const CLAUDE_MENU_SCAN_MAX = 1024;
const MENU_LABEL_MAX = 60;
const MENU_DESCRIPTION_MAX = 120;
const PLAN_LABEL_MAX = 40;
/** Longest e-mail address there is (RFC 5321); anything longer is no address and makes no key. */
const ACCOUNT_EMAIL_MAX = 254;
const ACCOUNT_KEY = /^[0-9a-f]{16}$/;

/**
 * How long a reading whose `get_usage` answer is in waits for the `initialize` answer, at most.
 * The CLI answers the two in the order they were sent, a few milliseconds apart, so this is
 * reached only by a CLI that never answers `initialize` at all.
 */
export const INIT_ANSWER_WAIT_MS = 1_000;

/** Is `value` a menu value this extension keeps: `default`, or a model it would store as it stands? */
function isMenuValue(value: unknown): value is string {
  return typeof value === 'string' && (value === 'default' || normalizeModel(value, { exact: true }) === value);
}

/** One menu entry, display-safe, or undefined for one that is no entry. */
function menuEntry(raw: unknown): ClaudeMenuModel | undefined {
  if (!isPlainObject(raw) || !isMenuValue(raw.value)) {
    return undefined;
  }
  const label = oneLine(raw.label ?? raw.displayName, MENU_LABEL_MAX) || raw.value;
  const description = oneLine(raw.description, MENU_DESCRIPTION_MAX);
  return description === '' ? { value: raw.value, label } : { value: raw.value, label, description };
}

/**
 * A menu → the entries kept, in order: each value once, at most CLAUDE_MENU_MAX, undefined when
 * none is left. `displayName` is the answer's key; `label` the cache's — both are read, so the
 * one function validates an answer and a cached entry alike.
 */
function menuOf(raw: unknown): ClaudeMenuModel[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: ClaudeMenuModel[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, CLAUDE_MENU_SCAN_MAX)) {
    const entry = menuEntry(item);
    if (entry === undefined || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    out.push(entry);
    if (out.length >= CLAUDE_MENU_MAX) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The key of the claude.ai account an `initialize` answer's `account` names: the first 16 hex
 * characters of SHA-256 over `lowercase(trim(email))`, a line feed, and the organization's id —
 * else its name, else nothing. Undefined when there is no address. The address goes into the
 * hash and nowhere else: a key says whether two accounts are the same one, not whose they are.
 */
export function accountKeyFor(account: unknown): string | undefined {
  if (!isPlainObject(account) || typeof account.email !== 'string') {
    return undefined;
  }
  const email = account.email.trim().toLowerCase();
  if (email === '' || email.length > ACCOUNT_EMAIL_MAX) {
    return undefined;
  }
  const org = account.organization;
  const orgPart = isPlainObject(org)
    ? typeof org.id === 'string' && org.id.trim() !== ''
      ? org.id.trim()
      : typeof org.name === 'string'
        ? org.name.trim()
        : ''
    : typeof org === 'string'
      ? org.trim()
      : '';
  return createHash('sha256').update(`${email}\n${orgPart}`, 'utf8').digest('hex').slice(0, 16);
}

/** What one `initialize` answer said that this extension keeps. */
interface InitFacts {
  /** The menu, when the answer had one with an entry worth keeping. */
  models?: ClaudeMenuModel[];
  /** The answer had an `account` object: its key and plan replace the previous ones, even by none. */
  accountSeen: boolean;
  accountKey?: string;
  planLabel?: string;
}

function parseInitAnswer(data: unknown): InitFacts {
  if (!isPlainObject(data)) {
    return { accountSeen: false };
  }
  const facts: InitFacts = { accountSeen: isPlainObject(data.account) };
  const models = menuOf(data.models);
  if (models !== undefined) {
    facts.models = models;
  }
  if (isPlainObject(data.account)) {
    const key = accountKeyFor(data.account);
    if (key !== undefined) {
      facts.accountKey = key;
    }
    const plan = oneLine(data.account.subscriptionType, PLAN_LABEL_MAX);
    if (plan !== '') {
      facts.planLabel = plan;
    }
  }
  return facts;
}

/**
 * What the `initialize` answer of each reading said, by the reading: refreshAllUsage needs to
 * know whether an absent field was ANSWERED as absent (an account with no address keeps no key)
 * or not answered at all (the previous one stands) — a difference the entry's own shape cannot
 * carry, since the cache file holds only what is known.
 */
const initFactsOfReading = new WeakMap<AccountUsage, InitFacts>();

/** `reading` with what `facts` says written onto it (and remembered for refreshAllUsage). */
function withInitFacts(reading: AccountUsage, facts: InitFacts | undefined): AccountUsage {
  if (facts === undefined) {
    return reading;
  }
  const out: AccountUsage = { ...reading };
  if (facts.models !== undefined) {
    out.models = facts.models;
    out.modelsFetchedAt = out.fetchedAt;
  }
  if (facts.accountKey !== undefined) {
    out.accountKey = facts.accountKey;
  }
  if (facts.planLabel !== undefined) {
    out.planLabel = facts.planLabel;
  }
  initFactsOfReading.set(out, facts);
  return out;
}

/** A cached entry's menu, checked by value; undefined when it has none worth showing. */
export function claudeMenuOf(usage: unknown): ClaudeMenuModel[] | undefined {
  return isPlainObject(usage) ? menuOf(usage.models) : undefined;
}

/** A cached entry's account key, checked by value. */
export function accountKeyOf(usage: unknown): string | undefined {
  return isPlainObject(usage) && typeof usage.accountKey === 'string' && ACCOUNT_KEY.test(usage.accountKey)
    ? usage.accountKey
    : undefined;
}

/** A cached entry's plan label, checked by value. */
export function planLabelOf(usage: unknown): string | undefined {
  return isPlainObject(usage) ? oneLine(usage.planLabel, PLAN_LABEL_MAX) || undefined : undefined;
}

/**
 * `fresh` with the `initialize` facts its own reading did not bring taken from `prev`: the menu
 * when none was answered; key and plan when no `account` was answered. Each carried field is
 * re-read by value, so a hand-edited entry cannot pass anything else on.
 */
function carryInitFacts(fresh: AccountUsage, prev: AccountUsage | undefined, facts: InitFacts | undefined): AccountUsage {
  const out: AccountUsage = { ...fresh };
  if (facts?.models === undefined) {
    delete out.models;
    delete out.modelsFetchedAt;
    const models = claudeMenuOf(prev);
    if (models !== undefined) {
      out.models = models;
      const at = (prev as { modelsFetchedAt?: unknown }).modelsFetchedAt;
      if (typeof at === 'number' && Number.isFinite(at)) {
        out.modelsFetchedAt = at;
      }
    }
  }
  if (facts?.accountSeen !== true) {
    delete out.accountKey;
    delete out.planLabel;
    const key = accountKeyOf(prev);
    if (key !== undefined) {
      out.accountKey = key;
    }
    const plan = planLabelOf(prev);
    if (plan !== undefined) {
      out.planLabel = plan;
    }
  }
  return out;
}

/** The request ids of the probe's two control requests: the answers are told apart by them. */
const USAGE_REQUEST_ID = 'u1';
const INIT_REQUEST_ID = 'i1';

/** How much of a usage probe's stderr is kept; 200 characters of it are quoted on failure. */
const PROBE_STDERR_KEPT_CHARS = 4096;

/**
 * How much ONE output stream of a child started here may carry before the child is ended.
 *
 * Every answer these children give is small: a control response of a few kilobytes, one line
 * of JSON, a status. A megabyte on stdout or on stderr is therefore not a slow answer but a
 * command that is not what it was taken for — a wrapper that logs, a `claudePath` pointing at
 * something else — and waiting out its timeout while reading what it prints buys nothing. The
 * bound is on what the stream has DELIVERED, not on what is being kept: a child that prints
 * endless short lines costs a parse per line and is ended at the same megabyte as one that
 * never prints a line end at all.
 */
export const CHILD_STREAM_MAX_BYTES = 1024 * 1024;

/** What a probe that ended its child for printing too much reports as its error. */
export const OUTPUT_TOO_LARGE = 'output too large';

/**
 * A counter for one output stream: hand it every chunk the stream delivers, and it answers
 * `true` from the chunk that takes the total past CHILD_STREAM_MAX_BYTES on.
 */
function streamBudget(): (chunk: unknown) => boolean {
  let received = 0;
  return (chunk) => {
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : Buffer.isBuffer(chunk) ? chunk.length : 0;
    return received > CHILD_STREAM_MAX_BYTES;
  };
}

/**
 * Probe one account. Resolves an AccountUsage in every case — never rejects.
 * A neutral cwd (os.tmpdir()) is REQUIRED so no project `.mcp.json` is loaded,
 * which would otherwise spawn this extension's own dispatch server per probe.
 *
 * The promise resolves the moment the reading (or an error) is known; the child is ended
 * behind it (terminateChild, stdin first) and never delays the caller.
 *
 * A child whose stdout or stderr passes CHILD_STREAM_MAX_BYTES is not waited for: the probe
 * fails at once as OUTPUT_TOO_LARGE and the child is signalled — there is no reading to let
 * it finish, so the stdin-first courtesy is skipped.
 *
 * TWO REQUESTS, ONE SESSION. `get_usage` is sent first and `initialize` right behind it, on
 * the same stdin: the reading never waits for anything `initialize` makes the CLI do, and a
 * CLI that does not know `initialize` answers the reading as it always did. The answers are
 * told apart by their request id (an answer that names none is the reading's, as from CLIs
 * and stand-ins that predate the second request). Once the reading is in, the probe waits for
 * the `initialize` answer only while it has not come, at most INIT_ANSWER_WAIT_MS and never
 * past the timeout, and not at all once the child has left; whatever that answer said is
 * written onto the reading — a failed reading included (withInitFacts).
 */
export function fetchAccountUsage(
  name: string,
  configDir: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<AccountUsage> {
  return new Promise((resolve) => {
    const base: AccountUsage = {
      name,
      configDir,
      available: false,
      subscriptionType: null,
      windows: [],
      sessionCostUsd: null,
      extraUsage: null,
      fetchedAt: Date.now(),
    };

    const claudePath = resolveProbeCommand();

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(
        claudePath,
        ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        {
          cwd: os.tmpdir(),
          env: claudeEnv(configDir),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (e) {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve({ ...base, error: `spawn failed: ${(e as Error).message}` });
      return;
    }

    let settled = false;
    let sent = false;
    let buf = '';
    let stderr = '';
    /** The answer to `get_usage` — a reading or a failure — held while `initialize` is awaited. */
    let reading: AccountUsage | undefined;
    /** Whether `initialize` has been answered at all, and what of its answer is kept. */
    let initAnswered = false;
    let initFacts: InitFacts | undefined;
    let initWait: NodeJS.Timeout | undefined;
    const deadline = Date.now() + timeoutMs;

    // A write to a child that has already left fails ASYNCHRONOUSLY: EPIPE arrives as an
    // 'error' event on the stream, not as a throw from write() or end(), and an 'error' event
    // with no listener is an uncaught exception in the extension host / dispatch server.
    child.stdin.on('error', () => undefined);

    const done = (result: AccountUsage, how: 'end-stdin' | 'signal' = 'end-stdin') => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      clearTimeout(initWait);
      resolve(withInitFacts({ ...result, fetchedAt: Date.now() }, initFacts));
      // After the resolve, and never awaited: ending stdin is what lets the CLI delete its own
      // session files, and it takes the CLI over a second to act on it.
      terminateChild(child, how);
    };
    /** The child printed past the cap on one stream: the probe ends, and so does the child. */
    const tooMuch = (): void => done(reading ?? { ...base, error: OUTPUT_TOO_LARGE }, 'signal');

    const timer = setTimeout(() => done(reading ?? { ...base, error: 'timeout' }), timeoutMs);

    /** The `get_usage` answer is in: settle now, or once `initialize` has been answered too. */
    const readingIn = (result: AccountUsage): void => {
      reading = result;
      if (initAnswered) {
        done(result);
        return;
      }
      initWait = setTimeout(() => done(result), Math.max(0, Math.min(INIT_ANSWER_WAIT_MS, deadline - Date.now())));
    };

    const sendRequest = () => {
      if (sent) {
        return;
      }
      sent = true;
      try {
        child.stdin.write(
          JSON.stringify({ type: 'control_request', request_id: USAGE_REQUEST_ID, request: { subtype: 'get_usage' } }) +
            '\n' +
            JSON.stringify({ type: 'control_request', request_id: INIT_REQUEST_ID, request: { subtype: 'initialize' } }) +
            '\n',
        );
      } catch {
        // stdin closed — the exit handler will settle with an error
      }
    };
    // Send once the process is up: on first output line, else after a short delay.
    const sendTimer = setTimeout(sendRequest, 800);

    const handleLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      sendRequest();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type !== 'control_response') {
        return;
      }
      clearTimeout(sendTimer);
      const resp = (isPlainObject(msg.response) ? msg.response : {}) as Record<string, unknown>;
      if (resp.request_id === INIT_REQUEST_ID) {
        if (initAnswered) {
          return;
        }
        initAnswered = true;
        // An error answer (a CLI that does not know the request) keeps nothing and costs nothing.
        if (resp.subtype === 'success') {
          initFacts = parseInitAnswer(resp.response);
        }
        if (reading !== undefined) {
          done(reading);
        }
        return;
      }
      if (reading !== undefined) {
        return;
      }
      if (resp.subtype !== 'success') {
        readingIn({ ...base, error: `control_response ${String(resp.subtype ?? 'error')}` });
        return;
      }
      const data = (resp.response ?? {}) as Record<string, unknown>;
      const session = (data.session ?? {}) as Record<string, unknown>;
      readingIn({
        ...base,
        available: data.rate_limits_available === true,
        subscriptionType: typeof data.subscription_type === 'string' ? data.subscription_type : null,
        windows: parseWindows(data),
        sessionCostUsd: typeof session.total_cost_usd === 'number' ? session.total_cost_usd : null,
        extraUsage: parseExtraUsage(data),
      });
    };

    // Both pipes keep being READ after the reading is in — the child now outlives it by up to
    // the whole termination ladder, and an unread pipe would block it mid-shutdown — but
    // nothing that arrives once settled is kept. Decoded on the streams themselves, so a
    // character that straddles two chunks is not torn into replacement characters.
    const stdoutOver = streamBudget();
    const stderrOver = streamBudget();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (settled) {
        return;
      }
      if (stdoutOver(d)) {
        tooMuch();
        return;
      }
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
        if (settled) {
          return;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (settled) {
        return;
      }
      if (stderrOver(d)) {
        tooMuch();
        return;
      }
      // Only its opening words are ever quoted (the exit handler below).
      if (stderr.length < PROBE_STDERR_KEPT_CHARS) {
        stderr = (stderr + d).slice(0, PROBE_STDERR_KEPT_CHARS);
      }
    });
    child.on('error', (e) => {
      clearTimeout(sendTimer);
      done({ ...base, error: `spawn failed: ${e.message}` });
    });
    // 'exit', not 'close': see onChildExit. A child that leaves without having answered is the
    // error path; one that leaves after its reading finds `done` already settled.
    onChildExit(child, () => {
      clearTimeout(sendTimer);
      done(reading ?? { ...base, error: stderr.trim() ? `claude exited: ${stderr.slice(0, 200)}` : 'no response' });
    });
  });
}

/**
 * Maximum accepted address length. RFC 5321 caps a forward path at 254 octets, so
 * nothing longer is a real address — and an unbounded string interpolated into a
 * terminal line is a denial-of-service shape regardless of its charset.
 */
const EMAIL_MAX_CHARS = 254;

/**
 * Return `email` unchanged iff it is a plausible address that is inert in EVERY
 * shell we may hand it to, else null.
 *
 * This is a SECURITY boundary, not a validity check. The address ultimately comes
 * from the account's `.claude.json`, a hand-editable file, and callers interpolate it
 * into a terminal command (`claude auth login --email <email>`) via sendText — a
 * terminal whose shell we do not choose. Three distinct hazards are excluded:
 *
 *  - POSIX shells (sh/bash/zsh): a quote, backtick, `$`, `;`, `|`, `&`, newline or
 *    glob character would let the file's contents execute arbitrary commands. None
 *    of them are in the accepted charset.
 *  - cmd.exe and PowerShell: `%` delimits environment expansion, so `a%PATH%b@x.com`
 *    would interpolate host state into the command line. `%` is therefore rejected
 *    everywhere in the address, not merely quoted.
 *  - Argument injection in any shell: a leading `-` would make the value read as a
 *    flag rather than a value (`--email -x@example.com`), so neither the local part
 *    nor the domain may begin with `-` (it stays legal in interior positions).
 *
 * Length is capped at EMAIL_MAX_CHARS on top of the charset. Anything that passes
 * all of these is safe to interpolate verbatim. Exported so the login affordance
 * and its tests share exactly this one definition.
 */
export function sanitizeEmailForShell(email: string | null): string | null {
  if (typeof email !== 'string' || email.length > EMAIL_MAX_CHARS) {
    return null;
  }
  return /^[A-Za-z0-9._+][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$/.test(email)
    ? email
    : null;
}

/**
 * Cap on collected auth-probe stdout. The payload is a one-line JSON object of a
 * few hundred bytes; a CLI that streams unbounded output (progress spam, a broken
 * build) must not grow this buffer without limit. The cap is applied AFTER each
 * append, so a single oversized chunk cannot overshoot it. Truncation loses the
 * closing brace, so the parse fails and the probe degrades to undefined — the safe
 * verdict.
 */
const AUTH_STDOUT_MAX_CHARS = 64 * 1024;

/**
 * Probe one account's login state with `claude auth status --json`.
 *
 * Resolves undefined — never rejects, never throws — on ANY failure: synchronous
 * or asynchronous spawn error, timeout, non-JSON output, or a payload without a
 * boolean `loggedIn`. undefined means "unknown", and callers must degrade to
 * today's behavior rather than guess; a wrong "expired" verdict would wrongly block
 * dispatches, so ambiguity must never harden into a claim.
 *
 * A neutral cwd (os.tmpdir()) is REQUIRED for the same reason as fetchAccountUsage:
 * from a project directory the CLI would load that project's `.mcp.json` and spawn
 * this extension's own dispatch server once per probe.
 *
 * stdout is parsed by taking the substring from the first '{' to the last '}',
 * because the CLI may prepend update notices or other warnings to the JSON.
 */
export function fetchAuthStatus(
  configDir: string,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
): Promise<AuthStatus | undefined> {
  return fetchAuthStatusDetailed(configDir, timeoutMs).then((r) => r.auth);
}

/**
 * fetchAuthStatus, with the probe's own one-line REASON when it could not decide — what the
 * login state (Login state (CA)) shows beside `probeFailed`: a timeout, a CLI that could not be
 * started, a locked keychain, an answer that was not the status JSON. `reason` is the empty
 * string when `auth` is defined. Every reason has passed loginFailureReason, so no address and
 * nothing token-shaped is in it. Never rejects.
 */
export function fetchAuthStatusDetailed(
  configDir: string,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
): Promise<{ auth: AuthStatus | undefined; reason: string }> {
  return new Promise((resolve) => {
    const claudePath = resolveProbeCommand();

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(claudePath, ['auth', 'status', '--json'], {
        cwd: os.tmpdir(),
        env: claudeEnv(configDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve({ auth: undefined, reason: loginFailureReason(`spawn failed: ${(e as Error).message}`) });
      return;
    }

    let settled = false;
    let out = '';
    let stderr = '';

    /**
     * Parse whatever stdout arrived so far. The exit code is deliberately ignored:
     * a logged-out account is a legitimate answer that the CLI may report with a
     * non-zero status, and the JSON is what we actually need.
     */
    const parseCollected = (): AuthStatus | undefined => {
      const start = out.indexOf('{');
      const end = out.lastIndexOf('}');
      if (start < 0 || end <= start) {
        return undefined;
      }
      let data: unknown;
      try {
        data = JSON.parse(out.slice(start, end + 1));
      } catch {
        return undefined;
      }
      if (!data || typeof data !== 'object') {
        return undefined;
      }
      const o = data as Record<string, unknown>;
      if (typeof o.loggedIn !== 'boolean') {
        return undefined;
      }
      // The CLI reports `email` only while the login is healthy; once it expires the
      // field is gone and this stays null. No fallback read of .claude.json here —
      // this runs on the periodic refresh path, and the re-login affordance recovers
      // the address itself when the user actually asks for it.
      return {
        loggedIn: o.loggedIn,
        method: typeof o.authMethod === 'string' ? o.authMethod : null,
        email: typeof o.email === 'string' && o.email !== '' ? o.email : null,
        checkedAt: Date.now(),
      };
    };

    const done = (status: AuthStatus | undefined, why: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ auth: status, reason: status === undefined ? loginFailureReason(why) : '' });
      // A no-op on the ordinary path, where the child has already exited by itself. It matters
      // for the timeout: there is no stdin protocol to end here, so the ladder starts at SIGTERM.
      terminateChild(child, 'signal');
    };
    /** Why a finished child gave no verdict: its own first words on stderr, when it said any. */
    const unreadable = (): string =>
      stderr.trim() !== '' ? `claude auth status: ${stderr.trim()}` : 'claude auth status gave no readable answer';

    // A CLI that hangs after printing its JSON still gives us a usable answer, so
    // the timeout parses what arrived rather than discarding it outright.
    const timer = setTimeout(
      () => done(parseCollected(), `the login check timed out after ${Math.round(timeoutMs / 1000)} s`),
      timeoutMs,
    );

    // Decode as UTF-8 on the stream itself: concatenating raw Buffers would let a
    // multi-byte character straddling two chunks decode into replacement chars and
    // corrupt the JSON. Capping after the append keeps `out` bounded even when one
    // chunk alone exceeds the ceiling. Nothing is collected once settled: a child that
    // is being terminated is still drained, but its output no longer has a reader.
    const stdoutOver = streamBudget();
    const stderrOver = streamBudget();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (settled) {
        return;
      }
      if (stdoutOver(d)) {
        // Past CHILD_STREAM_MAX_BYTES this is not a status command: "unknown", and it is ended.
        done(undefined, OUTPUT_TOO_LARGE);
        return;
      }
      out = (out + d).slice(0, AUTH_STDOUT_MAX_CHARS);
    });
    // stderr must be drained or a chatty CLI blocks on a full pipe. Only its opening words are
    // kept — they are the reason shown when no verdict came — and its volume is bounded.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (settled) {
        return;
      }
      if (stderrOver(d)) {
        done(undefined, OUTPUT_TOO_LARGE);
        return;
      }
      if (stderr.length < PROBE_STDERR_KEPT_CHARS) {
        stderr = (stderr + d).slice(0, PROBE_STDERR_KEPT_CHARS);
      }
    });
    child.on('error', (e) => done(undefined, `spawn failed: ${e.message}`));
    // 'exit', not 'close' (see onChildExit); its drain is what lets JSON still in the pipe
    // when the process died reach parseCollected.
    onChildExit(child, () => done(parseCollected(), unreadable()));
  });
}

/**
 * Normalize a cached `auth` field, mirroring how every other cached value is read:
 * usage.json is hand-editable and written by other processes, so nothing may be
 * trusted to have the declared shape. Returns undefined unless `loggedIn` is
 * genuinely a boolean — the one field a verdict may rest on. Every consumer
 * (dashboard, isLoginExpired) goes through this rather than touching `auth` raw.
 */
export function parseAuth(raw: unknown): AuthStatus | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.loggedIn !== 'boolean') {
    return undefined;
  }
  const auth: AuthStatus = {
    loggedIn: o.loggedIn,
    method: typeof o.method === 'string' ? o.method : null,
    email: typeof o.email === 'string' ? o.email : null,
    checkedAt: typeof o.checkedAt === 'number' && isFinite(o.checkedAt) ? o.checkedAt : 0,
  };
  // The run-failure mark is read only in the one shape it is ever written in: beside a
  // logged-out verdict, as the literal `true`, with a finite time. Anything else in the file
  // is not a mark — and the two keys are then ABSENT from the result, not `undefined`.
  if (
    auth.loggedIn === false &&
    o.fromRun === true &&
    typeof o.fromRunAt === 'number' &&
    isFinite(o.fromRunAt)
  ) {
    auth.fromRun = true;
    auth.fromRunAt = o.fromRunAt;
  }
  return auth;
}

/**
 * How long a benign `loggedIn:true` auth reading may be reused before the account
 * is probed again. Six hours ≈ 4 probes/day per such account, down from ~288 on a
 * 5-minute refresh cycle. Only the benign verdict is memoized (see shouldReuseAuth).
 */
export const AUTH_MEMO_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * True iff a previously cached `auth` value may be reused instead of re-spawning
 * `claude auth status`. Pure (exported for tests).
 *
 * Requires ALL of: the cached value parses (parseAuth — usage.json is
 * hand-editable), it reports `loggedIn:true`, and its `checkedAt` is a finite
 * instant whose age falls in [0, AUTH_MEMO_TTL_MS). A future or NaN `checkedAt`
 * yields false, matching isCacheFresh's clock-skew/tamper stance: an unverifiable
 * timestamp must cost a probe, not buy one.
 *
 * The `loggedIn === true` condition is the whole safety argument. A logged-out
 * verdict is never reusable, so every refresh cycle re-probes a suspected-expired
 * account and detects recovery within one cycle; reuse can only ever prolong a
 * "this account is fine" verdict, which the very next available:true reading
 * discards anyway. What it buys back is the token/API-key account that is
 * permanently ambiguous upstream and answers identically every single time.
 */
export function shouldReuseAuth(prevAuth: unknown, nowMs: number): boolean {
  const auth = parseAuth(prevAuth);
  if (auth === undefined || auth.loggedIn !== true) {
    return false;
  }
  const age = nowMs - auth.checkedAt;
  return isFinite(age) && age >= 0 && age < AUTH_MEMO_TTL_MS;
}

/**
 * THE single source of truth for "this account's login has expired", shared by the extension UI
 * and the MCP dispatch server so they can never disagree.
 *
 * A CLAUDE CODE account (isClaudeReading) is logged out ONLY in the login state `loggedOut`
 * (computeLoginState, contract-2.0-fixes.md "Login state (CA)"): two consecutive probes at least
 * LOGIN_CONFIRM_GAP_MS apart both said "not logged in", the newer of them taken in THIS process's
 * lifetime within LOGIN_FLOOR_MS, through the CLI path the dispatch uses — or a dispatch on it
 * failed on login. A reading this process did not confirm (written by an older version or another
 * process, older than the floor, taken with the other CLAUDE_CONFIG_DIR binding) is never a
 * verdict, whatever its `auth` says: that is how a 1.x cache entry that said "logged out" for a
 * working default account was printed as current (CA root cause).
 *
 * Another vendor's account keeps the rule it always had: a reading exists, the probe itself did
 * not fail, no plan limits, and its auth positively reported `loggedIn:false` (a run-proved
 * verdict included — runLoginFailureAt).
 *
 * The bias is deliberate: a FALSE "expired" verdict would wrongly block dispatches on a perfectly
 * good account, so an unproven expiry is never asserted. The dispatch gate still re-checks an
 * account whose last known word was "not logged in" before it uses it (isLoginSuspect).
 */
export function isLoginExpired(usage: AccountUsage | undefined): boolean {
  return usage !== undefined && isLoginExpiredFor(usage, isClaudeReading(usage));
}

/**
 * isLoginExpired for a reading whose account's vendor the CALLER knows — `claude`: it is a Claude
 * Code account's. The same answer, without the registry read isClaudeReading makes for an entry
 * that carries no probes: the dashboard model (which holds the registry under its own stat-keyed
 * cache) asks this of every account on every build, and one registry read per account per build
 * ended its stat-only rebuild. An entry with probes in it is a Claude Code reading whatever
 * `claude` says, as isClaudeReading has it. Residual: another vendor's account registered on a
 * Claude Code account's directory is judged by the raw rule here, as before Login state (CA).
 * Total.
 */
export function isLoginExpiredFor(usage: AccountUsage | undefined, claude: boolean, nowMs: number = Date.now()): boolean {
  if (usage === undefined) {
    return false;
  }
  if (claude || Array.isArray(usage.loginProbes)) {
    return computeLoginState(usage, nowMs).state === 'loggedOut';
  }
  return rawLoggedOut(usage);
}

/** What a reading's own fields say, with no state model: no error, no plan limits, `auth.loggedIn === false`. */
function rawLoggedOut(usage: AccountUsage): boolean {
  return usage.error === undefined && usage.available !== true && parseAuth(usage.auth)?.loggedIn === false;
}

/**
 * How long a logged-out verdict that a RUN produced is held against what the vendor CLI's own
 * status command says. Long enough to outlive several refresh cycles of an optimistic status
 * check; short enough that an account somebody fixed outside this product (signed in from
 * their own terminal) is not kept out of rotation for the rest of the day.
 */
export const RUN_LOGIN_FAILURE_STICKY_MS = 30 * 60 * 1000;

/**
 * When `usage` is a logged-out reading recorded BECAUSE A RUN FAILED ON LOGIN and that verdict
 * is still in force: the epoch ms of the failed run. Otherwise undefined. Pure and total.
 *
 * "In force" is what makes the verdict sticky (recordProviderStatus holds it against any reading
 * that did not come from a run) and what a surface shows as "the last run failed on login".
 * Three things end it:
 *
 *  (a) a run for the account succeeds        — recordProviderRunSucceeded;
 *  (b) the user signs the account in again   — clearProviderRunLoginFailure, which the
 *      from the extension                      extension's re-login command calls;
 *  (c) RUN_LOGIN_FAILURE_STICKY_MS pass      — decided here, from `fromRunAt` alone.
 *
 * A time in the FUTURE is not in force: like every other timestamp read from this file, one
 * that cannot be verified must not be able to pin an account out of rotation indefinitely.
 */
export function runLoginFailureAt(
  usage: AccountUsage | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!isLoginExpired(usage)) {
    return undefined;
  }
  const auth = parseAuth(usage?.auth);
  if (auth?.fromRun !== true || auth.fromRunAt === undefined) {
    return undefined;
  }
  const age = nowMs - auth.fromRunAt;
  return isFinite(age) && age >= 0 && age <= RUN_LOGIN_FAILURE_STICKY_MS ? auth.fromRunAt : undefined;
}

/* ------------------------------------------------------------------------- *
 * Login state of a Claude Code account (contract-2.0-fixes.md "Login state (CA)")
 * ------------------------------------------------------------------------- */

/*
 * WHY STATES AND NOT A BOOLEAN. Through 2.0's first builds a Claude Code account was "logged out"
 * whenever ITS CACHE ENTRY said so — whoever wrote it, however, and whenever, as long as its
 * `fetchedAt` was inside the refresh window. The cache is shared by every editor window and every
 * dispatch host on the machine, and 1.x wrote the default account's reading with
 * `CLAUDE_CONFIG_DIR=~/.claude` exported, which reads as logged out for a login made without it
 * (VERIFICATION-2.0 PP-5). A host that found such an entry fresh printed it as the truth, and
 * refused work on it. One failed probe — a timeout, a locked keychain — was an error badge too.
 *
 * So a Claude Code account's login is a STATE computed from the account's last probes
 * (`loginProbes`), each of which records when it ran, how CLAUDE_CONFIG_DIR was presented to the
 * child, what it found and why:
 *
 *   ok           the newest decisive probe said logged in: a probe of this version, within
 *                LOGIN_FLOOR_MS, through the binding this process uses for the account (whichever
 *                process took it — a wrong "ok" blocks nothing, and sharing it spares the probes);
 *   unconfirmed  nothing this process can stand on: no probe of this version (an older
 *                version's or a hand-written entry), the newest probe older than the floor,
 *                taken with the other binding, a "not logged in" from before this process
 *                started, or ONE probe that said "not logged in" and waits for its confirmation;
 *   checking     a probe of the account is running in this process now;
 *   loggedOut    two consecutive probes at least LOGIN_CONFIRM_GAP_MS apart both said "not
 *                logged in" (the newer in this process's lifetime, within the floor), or a
 *                dispatch on the account failed on login — the only state any surface calls
 *                "logged out";
 *   probeFailed  the probe itself failed (timeout, CLI missing, keychain locked, network): it
 *                says NOTHING about the login. A decisive probe before it still stands.
 *
 * RESIDUALS. The probes ride in the usage entry, so a writer that rebuilds the entry without them
 * (1.x) or a write that loses a merge race (mergeUsageCaches keeps the newer `fetchedAt`) drops
 * them: the account then reads `unconfirmed` and the next refresh probes it — never "logged out".
 * A NEGATIVE verdict needs a probe taken in this process's lifetime (whoever ran it — an editor
 * window and a dispatch host share their probes): a host never says "logged out", nor refuses, on
 * another process's word. A positive one only needs this version's probe with the same binding,
 * so a new process does not probe every healthy account again.
 */

/**
 * How a probe presented CLAUDE_CONFIG_DIR to its `claude` child: `unset` (absent — the CLI's
 * built-in default directory, as a session started without the variable runs) or `explicit`
 * (exported). platform.configDirBinding decides it from the directory. The two are NOT the same
 * login for the default directory — the credential store is keyed to the string — so a reading
 * taken one way says nothing about the other.
 */
export type LoginProbePath = 'unset' | 'explicit';

/** One login probe of a Claude Code account (AccountUsage.loginProbes). */
export interface LoginProbe {
  /** Epoch ms when it was taken. */
  at: number;
  path: LoginProbePath;
  /** `failed`: the probe could not decide — never a statement about the login. */
  result: 'in' | 'out' | 'failed';
  /** What answered: the usage probe, `claude auth status`, or a dispatch's own run. */
  via: 'usage' | 'status' | 'run';
  /** One line, ≤ LOGIN_REASON_MAX (200) chars, with no address or token-shaped text in it. */
  reason: string;
}

export type AccountLoginStateName = 'ok' | 'unconfirmed' | 'checking' | 'loggedOut' | 'probeFailed';

/** A Claude Code account's login state (loginStateOf). */
export interface AccountLoginState {
  state: AccountLoginStateName;
  /** Since when the account has been in this state, as far as the probes show; null when unknown. */
  since: number | null;
  /** When the newest probe (or, with none, the reading) was taken; null when there is none. */
  checkedAt: number | null;
  /** One line saying why — the probe's own reason, or what is missing. ≤ 200 chars. */
  reason: string;
  /** What the newest DECISIVE word on the login was, whatever its age; null when there is none. */
  lastKnown: 'in' | 'out' | null;
  /** The reason of the newest probe when it FAILED after a decisive one that still stands; else absent. */
  lastFailure?: string;
}

/** How long a decisive probe stands (`ok`, `loggedOut`) before the account is `unconfirmed` again. Longer than the editor's 5-minute refresh. */
export const LOGIN_FLOOR_MS = 10 * 60_000;
/** N: the least gap between the two "not logged in" probes that make `loggedOut`. A token the CLI refreshes a second later is not a logout. */
export const LOGIN_CONFIRM_GAP_MS = 15_000;
/** A `loggedOut` whose newest probe is younger than this is refused on without probing again (the dispatch and team gates). */
export const LOGGED_OUT_FRESH_MS = 60_000;
/** How many probes an entry keeps. */
export const LOGIN_PROBES_KEPT = 5;
/** Budget of one live login check of the gates and of the focus re-check. */
export const LOGIN_LIVE_CHECK_TIMEOUT_MS = 5_000;
/** Budget of a whole round of live checks (team pre-check, `list_workers --check`). */
export const LOGIN_CHECK_ROUND_MS = 15_000;
const LOGIN_REASON_MAX = 200;
const LOGIN_STATE_REASON_MAX = 200;
/** A probe stamped this far in the future (another process's clock read) still counts as now. */
const LOGIN_CLOCK_SKEW_MS = 5_000;

/**
 * When this process started, as the login state sees it: a probe taken before it was not
 * confirmed "in this process's lifetime". Module load time — the first thing either the extension
 * host or the dispatch server does is load this module.
 */
export const PROCESS_STARTED_AT = Date.now();

/** Config dirs (resolved) whose login is being probed in THIS process right now, with a count. */
const loginChecksInFlight = new Map<string, number>();

function inFlightKey(configDir: string): string {
  return path.resolve(configDir);
}
function beginLoginCheck(configDir: string): void {
  const key = inFlightKey(configDir);
  loginChecksInFlight.set(key, (loginChecksInFlight.get(key) ?? 0) + 1);
}
function endLoginCheck(configDir: string): void {
  const key = inFlightKey(configDir);
  const n = (loginChecksInFlight.get(key) ?? 1) - 1;
  if (n <= 0) {
    loginChecksInFlight.delete(key);
  } else {
    loginChecksInFlight.set(key, n);
  }
}

/** The binding a probe of `configDir` runs with in this process (platform.configDirBinding). */
export function loginProbePath(configDir: string): LoginProbePath {
  return 'set' in configDirBinding(configDir) ? 'explicit' : 'unset';
}

/**
 * A cached `loginProbes` value → the well-formed probes in it, oldest first, at most
 * LOGIN_PROBES_KEPT. The file is hand-editable: anything that is not a probe is dropped. Total.
 */
export function parseLoginProbes(raw: unknown): LoginProbe[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LoginProbe[] = [];
  for (const p of raw.slice(-LOGIN_PROBES_KEPT * 4)) {
    if (!isPlainObject(p)) {
      continue;
    }
    const { at, path: how, result, via } = p;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > DATE_MAX_MS) {
      continue;
    }
    if ((how !== 'unset' && how !== 'explicit') || (result !== 'in' && result !== 'out' && result !== 'failed')) {
      continue;
    }
    if (via !== 'usage' && via !== 'status' && via !== 'run') {
      continue;
    }
    out.push({ at, path: how, result, via, reason: oneLine(p.reason, LOGIN_REASON_MAX) });
  }
  return out.sort((a, b) => a.at - b.at).slice(-LOGIN_PROBES_KEPT);
}

/** `probes` with `probe` added, oldest first, at most LOGIN_PROBES_KEPT. */
function appendLoginProbe(prev: unknown, probe: LoginProbe): LoginProbe[] {
  return [...parseLoginProbes(prev), probe].sort((a, b) => a.at - b.at).slice(-LOGIN_PROBES_KEPT);
}

/** Local HH:MM of an epoch ms — the clock a person compares with their own. */
export function loginClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A probe's failure text → the one line the login state shows: what a person can act on, with no
 * address and nothing token-shaped in it. A locked keychain says so and says what to do about it;
 * a CLI that could not be started says that; a timeout says that. Total.
 */
export function loginFailureReason(raw: unknown): string {
  const text = oneLine(raw, 1000)
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[A-Za-z]{2,}/g, '<address>')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_\-+/=]{40,})/g, '<redacted>');
  if (text === '') {
    return 'the check gave no reason';
  }
  if (/keychain|errSecInteractionNotAllowed|User interaction is not allowed|SecKeychain|-25308|-25293/i.test(text)) {
    return "the macOS keychain is locked or not reachable from this session (ssh, or before the first unlock) — unlock it, or check from the machine's GUI session";
  }
  if (/spawn failed: .*ENOENT|ENOENT|not found|command not found/i.test(text) && /spawn|ENOENT|claude/i.test(text)) {
    return 'the claude CLI could not be started (not installed or not on PATH)';
  }
  if (/^timeout$/i.test(text)) {
    return 'the check timed out';
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket hang up/i.test(text)) {
    return sliceOneLine(`network error: ${text}`, LOGIN_REASON_MAX).trimEnd();
  }
  return sliceOneLine(text, LOGIN_REASON_MAX).trimEnd();
}

/**
 * The reason of a "not logged in" answer. Over ssh on macOS the login keychain is often locked,
 * and a CLI that cannot read it may answer exactly that — so the reason says so, and what to do,
 * whenever this process runs in an ssh session there. Total.
 */
function notLoggedInReason(base: string): string {
  const overSsh =
    process.platform === 'darwin' &&
    (typeof process.env.SSH_CONNECTION === 'string' || typeof process.env.SSH_TTY === 'string');
  return overSsh
    ? `${base} — this runs over ssh, where a locked login keychain can read as not logged in: unlock it, or check from the machine's GUI session`
    : base;
}

/**
 * Is this reading a CLAUDE CODE account's? An entry with `loginProbes` is (only this version's
 * Claude probes write them); otherwise the directory decides (isClaudeAccountDir: main or a Claude
 * Code worker) — another vendor's entries never sit in such a directory (recordProviderStatus
 * refuses to file one there). Total.
 */
function isClaudeReading(usage: AccountUsage): boolean {
  if (Array.isArray(usage.loginProbes)) {
    return true;
  }
  try {
    return typeof usage.configDir === 'string' && isClaudeAccountDir(usage.configDir);
  } catch {
    return false;
  }
}

/** "logged in" / "not logged in" / "check failed" for a probe's result. */
function resultWords(result: LoginProbe['result']): string {
  return result === 'in' ? 'logged in' : result === 'out' ? 'not logged in' : 'check failed';
}

function loginState(
  state: AccountLoginStateName,
  since: number | null,
  checkedAt: number | null,
  reason: string,
  lastKnown: 'in' | 'out' | null,
): AccountLoginState {
  return { state, since, checkedAt, reason: sliceOneLine(flattenOneLine(reason), LOGIN_STATE_REASON_MAX).trimEnd(), lastKnown };
}

/**
 * The login state of a Claude Code account's reading at `nowMs`, IGNORING whether a probe of it
 * is running in this process (that is loginStateOf's `checking`): what the gates decide on.
 * Pure but for PROCESS_STARTED_AT and the CLAUDE_CONFIG_DIR binding of the account. Total.
 */
export function computeLoginState(usage: AccountUsage | undefined, nowMs: number = Date.now()): AccountLoginState {
  if (usage === undefined) {
    return loginState('unconfirmed', null, null, 'no reading yet', null);
  }
  const expected = typeof usage.configDir === 'string' ? loginProbePath(usage.configDir) : 'unset';
  const probes = parseLoginProbes(usage.loginProbes);
  const latest = probes.length > 0 ? probes[probes.length - 1] : undefined;
  if (latest === undefined) {
    // Written by something that is not this version's probe: an older version, a hand edit.
    const at = finiteTime(usage.fetchedAt);
    const out = rawLoggedOut(usage);
    const inn = usage.error === undefined && (usage.available === true || parseAuth(usage.auth)?.loggedIn === true);
    return loginState(
      'unconfirmed',
      at,
      at,
      `${at !== null ? `cached from ${loginClock(at)}` : 'cached reading'}${out ? ', said not logged in' : ''}`,
      out ? 'out' : inn ? 'in' : null,
    );
  }
  let lastDecisive: LoginProbe | undefined;
  for (let i = probes.length - 1; i >= 0 && lastDecisive === undefined; i--) {
    if (probes[i].result !== 'failed') {
      lastDecisive = probes[i];
    }
  }
  const lastKnown = lastDecisive === undefined ? null : lastDecisive.result === 'in' ? 'in' : 'out';
  if (latest.path !== expected) {
    return loginState(
      'unconfirmed',
      latest.at,
      latest.at,
      `last checked ${loginClock(latest.at)} with CLAUDE_CONFIG_DIR ${latest.path === 'explicit' ? 'set' : 'unset'}, not how this account runs`,
      lastKnown,
    );
  }
  const fresh = (p: LoginProbe): boolean =>
    p.path === expected && p.at <= nowMs + LOGIN_CLOCK_SKEW_MS && nowMs - p.at <= LOGIN_FLOOR_MS;
  if (!fresh(latest)) {
    return loginState('unconfirmed', latest.at, latest.at, `last checked ${loginClock(latest.at)}, ${resultWords(latest.result)}`, lastKnown);
  }
  let decisive: LoginProbe | undefined;
  let decisiveIndex = -1;
  for (let i = probes.length - 1; i >= 0; i--) {
    if (probes[i].result !== 'failed' && fresh(probes[i])) {
      decisive = probes[i];
      decisiveIndex = i;
      break;
    }
  }
  const failedAfter = latest.result === 'failed' ? latest : undefined;
  if (decisive === undefined) {
    // Only failures in this process's lifetime: since the first of the trailing run of them.
    let since = latest.at;
    for (let i = probes.length - 1; i >= 0 && probes[i].result === 'failed'; i--) {
      since = probes[i].at;
    }
    return loginState('probeFailed', since, latest.at, latest.reason, lastKnown);
  }
  const lastFailed = failedAfter !== undefined ? `; the last check failed: ${failedAfter.reason}` : '';
  const withFailure = (st: AccountLoginState): AccountLoginState =>
    failedAfter !== undefined ? { ...st, lastFailure: failedAfter.reason } : st;
  if (decisive.result === 'in') {
    let since = decisive.at;
    for (let i = decisiveIndex - 1; i >= 0 && probes[i].result === 'in' && fresh(probes[i]); i--) {
      since = probes[i].at;
    }
    return withFailure(loginState('ok', since, latest.at, `${decisive.reason}${lastFailed}`, 'in'));
  }
  // The newest decisive word is "not logged in". A verdict stands only on a probe taken in THIS
  // process's lifetime: one another process took (or one from before this process started) is
  // the last known word, re-checked before anything is said or decided on it.
  if (decisive.at < PROCESS_STARTED_AT) {
    return failedAfter !== undefined
      ? loginState('probeFailed', failedAfter.at, latest.at, `${failedAfter.reason} (an earlier check said not logged in)`, 'out')
      : loginState('unconfirmed', decisive.at, latest.at, `said not logged in at ${loginClock(decisive.at)}, before this process started`, 'out');
  }
  // Confirmed by a failed dispatch anywhere in the unbroken run of "not logged in" that ends with
  // it, or by an earlier probe of that run that is at least N older.
  let first = decisive;
  let byRun: LoginProbe | undefined = decisive.via === 'run' ? decisive : undefined;
  let confirmed = byRun !== undefined;
  for (let i = decisiveIndex - 1; i >= 0; i--) {
    const p = probes[i];
    if (p.result !== 'out' || !fresh(p)) {
      break;
    }
    first = p;
    if (p.via === 'run' && p.at >= PROCESS_STARTED_AT) {
      byRun = byRun ?? p;
      confirmed = true;
    }
    if (decisive.at - p.at >= LOGIN_CONFIRM_GAP_MS) {
      confirmed = true;
    }
  }
  if (confirmed) {
    const how =
      byRun !== undefined
        ? `a dispatch failed on login at ${loginClock(byRun.at)}`
        : `confirmed by checks at ${loginClock(first.at)} and ${loginClock(decisive.at)}`;
    return withFailure(loginState('loggedOut', first.at, latest.at, `${how}: ${decisive.reason}${lastFailed}`, 'out'));
  }
  if (failedAfter !== undefined) {
    return loginState('probeFailed', failedAfter.at, latest.at, `${failedAfter.reason} (the check before said not logged in)`, 'out');
  }
  return loginState('unconfirmed', decisive.at, latest.at, `said not logged in at ${loginClock(decisive.at)}, confirming`, 'out');
}

/**
 * The login state of a Claude Code account's reading as a SURFACE shows it: computeLoginState,
 * except that an account whose probe is running in this process right now is `checking` (with
 * the reason it had). Total.
 */
export function loginStateOf(usage: AccountUsage | undefined, nowMs: number = Date.now()): AccountLoginState {
  const base = computeLoginState(usage, nowMs);
  const dir = usage?.configDir;
  if (typeof dir === 'string' && loginChecksInFlight.has(inFlightKey(dir))) {
    return { ...base, state: 'checking' };
  }
  return base;
}

/** Is a probe of the account in `configDir` running in this process now? */
export function isLoginCheckInFlight(configDir: string): boolean {
  return loginChecksInFlight.has(inFlightKey(configDir));
}

/**
 * The dispatch gate's question about a Claude Code account that is NOT `loggedOut`: was the last
 * known word on its login "not logged in" — an unconfirmed reading, an older one, a lone probe
 * awaiting its confirmation? Such an account is re-checked live before it is used or refused
 * (task-runner.pickWorkerLive, the server's pre-check of team routing); it is never refused on the
 * reading alone. A lone "not logged in" FOLLOWED by a failed probe is not suspect: the failed
 * probe says nothing, and the run itself is the next witness. False for another vendor's reading.
 */
export function isLoginSuspect(usage: AccountUsage | undefined): boolean {
  return usage !== undefined && isLoginSuspectFor(usage, isClaudeReading(usage));
}

/** isLoginSuspect for a reading whose account's vendor the caller knows (see isLoginExpiredFor). Total. */
export function isLoginSuspectFor(usage: AccountUsage | undefined, claude: boolean, nowMs: number = Date.now()): boolean {
  if (usage === undefined || !(claude || Array.isArray(usage.loginProbes))) {
    return false;
  }
  const st = computeLoginState(usage, nowMs);
  return st.state === 'unconfirmed' && st.lastKnown === 'out';
}

/**
 * Is the newest decisive word on this Claude Code account's login a "not logged in" that THIS
 * process's lifetime saw — a probe of this version, through this binding, within the floor, taken
 * after this process started? (A lone such probe is evidence enough to hold the account back
 * where no live check may be made; anything else that says "not logged in" is not.) Total.
 */
export function loginOutIsOwn(usage: AccountUsage | undefined): boolean {
  if (usage === undefined || typeof usage.configDir !== 'string') {
    return false;
  }
  const expected = loginProbePath(usage.configDir);
  const now = Date.now();
  const decisive = parseLoginProbes(usage.loginProbes)
    .filter((p) => p.result !== 'failed')
    .pop();
  return (
    decisive !== undefined &&
    decisive.result === 'out' &&
    decisive.path === expected &&
    decisive.at >= PROCESS_STARTED_AT &&
    decisive.at <= now + LOGIN_CLOCK_SKEW_MS &&
    now - decisive.at <= LOGIN_FLOOR_MS
  );
}

/**
 * Is a probe of this Claude Code account due at `nowMs`, whatever the age of its usage reading?
 * `unconfirmed` is due — except a lone "not logged in" younger than LOGIN_CONFIRM_GAP_MS, whose
 * confirmation must wait for the gap; `probeFailed` is due once its newest probe is
 * USAGE_ERROR_FRESH_MS old; `ok` and `loggedOut` are not. No reading at all is due.
 */
export function loginCheckDue(usage: AccountUsage | undefined, nowMs: number = Date.now()): boolean {
  if (usage === undefined) {
    return true;
  }
  const st = computeLoginState(usage, nowMs);
  if (st.state === 'probeFailed') {
    return st.checkedAt === null || nowMs - st.checkedAt >= USAGE_ERROR_FRESH_MS;
  }
  if (st.state !== 'unconfirmed') {
    return false;
  }
  const latest = parseLoginProbes(usage.loginProbes).pop();
  const awaiting =
    latest !== undefined && latest.result === 'out' && latest.at >= PROCESS_STARTED_AT && nowMs - latest.at >= 0;
  return !(awaiting && latest !== undefined && nowMs - latest.at < LOGIN_CONFIRM_GAP_MS);
}

/** The probe a refresh's reading of an account amounts to (refreshAllUsage). */
function loginProbeOfReading(
  r: AccountUsage,
  auth: { status: AuthStatus | undefined; reason: string; reused: boolean } | undefined,
): LoginProbe {
  const at = finiteTime(r.fetchedAt) ?? Date.now();
  const how = loginProbePath(r.configDir);
  if (r.error !== undefined) {
    return { at, path: how, result: 'failed', via: 'usage', reason: loginFailureReason(r.error) };
  }
  if (r.available === true) {
    const plan = oneLine(r.subscriptionType, 24);
    return { at, path: how, result: 'in', via: 'usage', reason: `plan usage read${plan !== '' ? ` (${plan})` : ''}` };
  }
  if (auth?.status?.loggedIn === true) {
    return {
      at,
      path: how,
      result: 'in',
      via: 'status',
      reason: `logged in, no plan limits (token or API key)${auth.reused ? ' — remembered check' : ''}`,
    };
  }
  if (auth?.status?.loggedIn === false) {
    return { at, path: how, result: 'out', via: 'status', reason: notLoggedInReason('claude auth status said not logged in') };
  }
  return { at, path: how, result: 'failed', via: 'status', reason: auth?.reason || 'the login check did not answer' };
}

/**
 * Append one probe to the account's entry ON DISK, re-read just before the write (and `auth`
 * beside it when the probe read one; a run's evidence sets `auth` too, so that the reading's
 * own fields agree with it). `fetchedAt` is NOT bumped — this is not a usage reading, and faking
 * usage freshness would put off the next real refresh. An account with no entry gets one with no
 * usage in it and `fetchedAt: 0`, which every refresh treats as stale. Returns the entry as it
 * was written (or would have been, when the write failed). Never throws.
 */
export function recordClaudeLoginProbe(
  account: { name: string; configDir: string },
  probe: LoginProbe,
  auth?: AuthStatus,
): AccountUsage {
  let base: AccountUsage | undefined;
  try {
    base = ownCacheEntry(readUsageCache(), account.configDir);
  } catch {
    base = undefined;
  }
  const prev: AccountUsage = base ?? {
    name: account.name,
    configDir: account.configDir,
    available: false,
    subscriptionType: null,
    windows: [],
    sessionCostUsd: null,
    extraUsage: null,
    fetchedAt: 0,
  };
  const entry: AccountUsage = { ...prev, loginProbes: appendLoginProbe(prev.loginProbes, probe) };
  const prevAuth = parseAuth(prev.auth);
  if (auth !== undefined) {
    entry.auth = auth;
  } else if (probe.via === 'run' && probe.result !== 'failed') {
    entry.auth = { loggedIn: probe.result === 'in', method: prevAuth?.method ?? null, email: null, checkedAt: probe.at };
  }
  try {
    const one: UsageCache = {};
    setCacheEntry(one, account.configDir, entry);
    writeUsageCache(one);
  } catch {
    // the in-memory entry is what the caller acts on; the next refresh re-probes anyway
  }
  return entry;
}

/**
 * ONE live login check of a Claude Code account through `claude auth status` — with the same
 * environment as its dispatches (platform.claudeEnv) — recorded on its entry. The dispatch gate's
 * re-check, the team pre-check and the focus re-check use it. Marks the account `checking` while
 * it runs. Never rejects.
 */
export async function checkClaudeLogin(
  account: { name: string; configDir: string },
  timeoutMs: number = LOGIN_LIVE_CHECK_TIMEOUT_MS,
): Promise<{ auth: AuthStatus | undefined; probe: LoginProbe; entry: AccountUsage }> {
  beginLoginCheck(account.configDir);
  try {
    const { auth, reason } = await fetchAuthStatusDetailed(account.configDir, timeoutMs);
    const probe: LoginProbe = {
      at: Date.now(),
      path: loginProbePath(account.configDir),
      result: auth === undefined ? 'failed' : auth.loggedIn ? 'in' : 'out',
      via: 'status',
      reason:
        auth === undefined
          ? reason
          : auth.loggedIn
            ? 'claude auth status said logged in'
            : notLoggedInReason('claude auth status said not logged in'),
    };
    return { auth, probe, entry: recordClaudeLoginProbe(account, probe, auth) };
  } finally {
    endLoginCheck(account.configDir);
  }
}

/**
 * What a DISPATCH just proved about a Claude Code account's login: it ran (`true` — real work is
 * evidence, the account is `ok`), or it failed because the account is not logged in (`false` —
 * `loggedOut` at once). The success is written only when the account is not already `ok` from a
 * probe of the last minute: this runs after every successful dispatch and must cost a small read.
 * Never throws.
 */
export function recordClaudeRunLogin(account: { name: string; configDir: string }, loggedIn: boolean): void {
  try {
    const now = Date.now();
    if (loggedIn) {
      const cur = ownCacheEntry(readUsageCache(), account.configDir);
      const latest = parseLoginProbes(cur?.loginProbes).pop();
      if (
        cur !== undefined &&
        computeLoginState(cur, now).state === 'ok' &&
        latest !== undefined &&
        latest.result === 'in' &&
        now - latest.at < 60_000
      ) {
        return;
      }
    }
    recordClaudeLoginProbe(account, {
      at: now,
      path: loginProbePath(account.configDir),
      result: loggedIn ? 'in' : 'out',
      via: 'run',
      reason: loggedIn ? 'a dispatch on this account ran' : 'a dispatch failed: the CLI said not logged in',
    });
  } catch {
    // best-effort, like every other write of this cache
  }
}

/** Accounts whose lone "not logged in" waits for its confirmation probe, by resolved dir → timer. */
const loginConfirmTimers = new Map<string, NodeJS.Timeout>();

/**
 * For each reading whose newest probe is a lone "not logged in" taken in this process: probe the
 * account once more when LOGIN_CONFIRM_GAP_MS have passed (refreshAllUsage of that one account),
 * so a real logout is confirmed — or a passing one cleared — without anybody asking again. At
 * most one timer per account; unref'd, so it never keeps a process alive. Never throws.
 */
function scheduleLoginConfirmations(readings: AccountUsage[]): void {
  const now = Date.now();
  for (const r of readings) {
    try {
      const st = computeLoginState(r, now);
      const latest = parseLoginProbes(r.loginProbes).pop();
      if (st.state !== 'unconfirmed' || latest === undefined || latest.result !== 'out' || latest.at < PROCESS_STARTED_AT) {
        continue;
      }
      const key = inFlightKey(r.configDir);
      if (loginConfirmTimers.has(key)) {
        continue;
      }
      const account = { name: r.name, configDir: r.configDir };
      const timer = setTimeout(
        () => {
          loginConfirmTimers.delete(key);
          void refreshAllUsage([account], 1, LOGIN_LIVE_CHECK_TIMEOUT_MS).catch(() => undefined);
        },
        Math.max(0, latest.at + LOGIN_CONFIRM_GAP_MS - now) + 250,
      );
      timer.unref?.();
      loginConfirmTimers.set(key, timer);
    } catch {
      // a reading that cannot be judged is simply not confirmed early
    }
  }
}

/**
 * The live pre-check of a ROUTING decision made from cached verdicts (team_create, team_add, a
 * member switch — team contract M15 keeps the engine itself from probing): every Claude Code
 * account that would be refused or re-routed on its login — `loggedOut` whose newest probe is
 * LOGGED_OUT_FRESH_MS or older, or isLoginSuspect — is checked live once (checkClaudeLogin), side
 * by side, the whole round bounded by `totalMs`. A check still running when the round ends keeps
 * running and files its result when it lands. Never rejects.
 */
export async function recheckClaudeLoginsForRouting(
  accounts: { name: string; configDir: string }[] = listAccounts(),
  totalMs: number = LOGIN_CHECK_ROUND_MS,
): Promise<void> {
  try {
    const cache = readUsageCache();
    const now = Date.now();
    const seen = new Set<string>();
    const due = accounts.filter((a) => {
      const key = inFlightKey(a.configDir);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      const entry = ownCacheEntry(cache, a.configDir);
      if (entry === undefined) {
        return false;
      }
      const st = computeLoginState(entry, now);
      if (st.state === 'loggedOut') {
        const latest = parseLoginProbes(entry.loginProbes).filter((p) => p.result === 'out').pop();
        return latest === undefined || now - latest.at >= LOGGED_OUT_FRESH_MS;
      }
      return isLoginSuspect(entry);
    });
    if (due.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(due.map((a) => checkClaudeLogin(a, LOGIN_LIVE_CHECK_TIMEOUT_MS))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, totalMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  } catch {
    // a pre-check that could not run leaves the cached verdicts — the engine's own rules — in place
  }
}

/**
 * `list_workers --check` and the Check Login Now of every account: re-probe the given Claude Code
 * accounts live — the full usage probe, and the login check where it is ambiguous — all side by
 * side, the round bounded by `totalMs`. Never rejects.
 */
export async function checkAllClaudeLoginsNow(
  accounts: { name: string; configDir: string }[] = listAccounts(),
  totalMs: number = LOGIN_CHECK_ROUND_MS,
): Promise<void> {
  if (accounts.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      refreshAllUsage(accounts, accounts.length, LOGIN_LIVE_CHECK_TIMEOUT_MS),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, totalMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // a refresh never rejects; this is for the day it does
  } finally {
    clearTimeout(timer);
  }
}

/** "just now", "3 min ago", "1.5 h ago" — the age a login state line carries. */
function loginAge(epochMs: number | null, nowMs: number): string {
  if (epochMs === null) {
    return 'never';
  }
  const ms = nowMs - epochMs;
  if (ms < 60_000) {
    return 'just now';
  }
  const min = ms / 60_000;
  return min < 60 ? `${Math.round(min)} min ago` : `${(min / 60).toFixed(1)} h ago`;
}

/**
 * The end of an account's line in list_workers' text (and of a dashboard / tree hover): the state
 * and its age, in the wording rules of the contract — "logged out" ONLY for `loggedOut`, and a
 * failed probe as a check that could not run, never as an error of the account. Total.
 */
export function loginStateText(st: AccountLoginState, nowMs: number = Date.now()): string {
  switch (st.state) {
    case 'ok':
      return `login ok · checked ${loginAge(st.checkedAt, nowMs)}${
        st.lastFailure !== undefined ? ` (the last check could not run: ${st.lastFailure} — retrying)` : ''
      }`;
    case 'loggedOut':
      return `logged out (${st.reason}) · since ${st.since !== null ? loginClock(st.since) : '—'}`;
    case 'probeFailed':
      return `couldn't check the login (${st.reason}) — retrying`;
    case 'checking':
      return `login checking now (${st.reason})`;
    default:
      return `login not confirmed (${st.reason}) · checking`;
  }
}

/**
 * One line per account for a support question: its state and its last LOGIN_PROBES_KEPT probes,
 * newest first — time, how CLAUDE_CONFIG_DIR was presented (env-unset / explicit dir), what
 * answered, the result and its reason. No address, no token, nothing from the keychain: reasons
 * are sanitized when a probe is recorded, and the directory itself is not printed. Total.
 */
export function loginDiagnosticsLine(name: string, usage: AccountUsage | undefined, nowMs: number = Date.now()): string {
  const st = loginStateOf(usage, nowMs);
  const probes = parseLoginProbes(usage?.loginProbes).reverse();
  const shown = probes.map((p) => {
    const d = new Date(p.at);
    const sec = String(d.getSeconds()).padStart(2, '0');
    return `${loginClock(p.at)}:${sec} ${p.path === 'unset' ? 'env-unset' : 'explicit dir'} ${p.via} → ${resultWords(p.result)} (${p.reason})`;
  });
  return `${sliceOneLine(flattenOneLine(name), 64)}: ${st.state} — ${loginStateText(st, nowMs)} · probes: ${
    shown.length > 0 ? shown.join(' | ') : 'none by this version'
  }`;
}

/**
 * The open flags for the temp half of an atomic write, spelled the way safeFs spells its own:
 * every optional POSIX flag is probed rather than assumed, so a platform that does not define
 * one contributes 0 instead of NaN.
 *
 *   - O_NONBLOCK — a FIFO opened O_WRONLY without a reader fails ENXIO instead of BLOCKING
 *     FOREVER. That is the whole attack: the temp path is `<file>.<pid>.tmp`, a name a worker
 *     can derive and pre-create, and a wedge here is not merely a lost write — for the ledger
 *     it happens while the write lock is HELD, so it wedges every other process too.
 *   - O_NOFOLLOW — a symlink at the temp path fails ELOOP at the open, BEFORE O_TRUNC can act.
 *     Without it, `<file>.<pid>.tmp` pointing at any file this process can write is a remote
 *     truncation primitive, and the fstat below would arrive far too late to prevent it.
 *   - O_TRUNC is why this cannot be a safeFs call, and the reason is structural rather than an
 *     omission: safeFs's discipline is "prove it is a regular file BEFORE you touch it", and
 *     truncation happens inside the open itself, so no fstat can precede it. What is proven
 *     before the open is instead the NAME: it is this process's own pid-scoped temp path, which
 *     nothing else may legitimately hold, and O_NOFOLLOW makes truncating it local.
 */
const TMP_WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * Write `text` to a temp path that an untrusted process may have occupied first, and REPORT
 * rather than throw. Never blocks, never follows a symlink, never writes into anything that is
 * not a regular file, and never half-writes silently.
 *
 * Local rather than shared because safeFs is frozen and offers no truncating write (see
 * TMP_WRITE_FLAGS for why it cannot), and because the other module that needs this shape sits
 * on the far side of an import edge — a shared helper would have to live in a new file, which
 * this change may not add. The two copies are identical and are commented as such; the sibling lives in mesh/pool.ts, which imports THIS module, so the edge could only ever run one way.
 *
 * THE RENAME IS THE CALLER'S, AND IT MUST NOT RUN ON `ok:false`. A tmp+rename whose temp write
 * was refused would publish a stale or truncated temp file over the real one; every caller
 * below therefore branches before renaming, and none of them treats a refusal as "written".
 */
function writeTempFileGuarded(file: string, text: string): { ok: true } | { ok: false; detail: string } {
  const buf = Buffer.from(text, 'utf8');
  const why = (err: unknown): string =>
    (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'unknown error';
  /**
   * Open the temp path and PROVE it is a regular file, or close and say why. Both halves live
   * here so the retry below is one call: a descriptor that failed the fstat is closed before
   * the name is reclaimed, never leaked into it.
   */
  const closeQuietly = (fd: number): void => {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  };
  const openProven = (): { ok: true; fd: number } | { ok: false; detail: string } => {
    let fd: number;
    try {
      fd = fs.openSync(file, TMP_WRITE_FLAGS, 0o600);
    } catch (err) {
      // ENXIO = a reader-less FIFO; ELOOP = a symlink; anything else is an ordinary failure.
      return { ok: false, detail: why(err) };
    }
    // Every failure below CLOSES the fd before returning — a descriptor handed to nobody is a
    // descriptor leaked, and the reclaim/retry that follows a refusal would otherwise pile one
    // up per attempt. Only the success path hands it back, still open, to the writer.
    try {
      if (!fs.fstatSync(fd).isFile()) {
        // A FIFO with a live reader, a device, a socket. NOTHING HAS BEEN WRITTEN YET.
        closeQuietly(fd);
        return { ok: false, detail: 'the temp path is not a regular file' };
      }
    } catch (err) {
      closeQuietly(fd);
      return { ok: false, detail: why(err) };
    }
    return { ok: true, fd };
  };
  /**
   * RECLAIM THE NAME ONCE, then give up. Without this the guard would trade a hang for a
   * PERMANENT write failure: the temp path embeds this process's pid, which never changes, so
   * one planted FIFO or symlink there would refuse every write for the life of the process —
   * and a ledger that can no longer be written is a ledger whose stop marks never land. The
   * removal is deliberately narrow: `unlinkSync` (a file, FIFO, socket, device, or the SYMLINK
   * ITSELF rather than its target), then `rmdirSync`, which removes only an EMPTY directory.
   * Nothing recursive, nothing that follows a link, and only ever at `<file>.<pid>.tmp` — a
   * name this process owns and whose contents this call is about to replace anyway. A
   * non-empty planted directory survives and the write is refused, which is the safe end.
   */
  const reclaim = (): void => {
    try {
      fs.unlinkSync(file);
      return;
    } catch {
      // not unlinkable — try the one remaining shape
    }
    try {
      fs.rmdirSync(file);
    } catch {
      // occupied by something we will not remove; the second open refuses again
    }
  };
  let opened = openProven();
  if (!opened.ok) {
    const first = opened.detail;
    reclaim();
    opened = openProven();
    if (!opened.ok) {
      return { ok: false, detail: `${first} (and ${opened.detail} after reclaiming the name)` };
    }
  }
  const fd = opened.fd;
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) {
        break;
      }
      off += n;
    }
    if (off < buf.length) {
      // A partial write must never be renamed over the real file: that IS the torn file the
      // tmp+rename pattern exists to make impossible.
      return { ok: false, detail: `short write (${off} of ${buf.length} bytes)` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: why(err) };
  } finally {
    closeQuietly(fd);
  }
}

export type UsageCache = Record<string, AccountUsage>;

/**
 * READ CAP for the usage cache.
 *
 * One entry per worker account — a reading, its windows and its timestamps — running a
 * kilobyte or two; the real file on a multi-account machine is under 2 KB. 1 MiB is several
 * hundred accounts, far past any registry a human maintains, and it bounds a file that is read
 * on RENDER paths (every tree refresh) and on the dispatch placement path.
 */
const USAGE_CACHE_MAX_BYTES = 1024 * 1024;

/**
 * The last-good usage readings, or an empty cache.
 *
 * Guarded like every other file this product reads from a directory a worker can reach: this
 * one is read synchronously by the extension host on render, by the MCP server on the dispatch
 * placement path and by the keep-alive sweep, so an unguarded read of a FIFO here stalls all
 * three at once. The shape is validated too — `as UsageCache` on a bare JSON.parse would let an
 * array or a scalar through into every consumer's property access.
 *
 * Every failure returns an empty cache, unchanged: a cache miss means "refresh it", which is
 * what every caller already does with an entry it cannot find.
 */
export function readUsageCache(): UsageCache {
  // Not followed if it is a symbolic link: the cache is a file this product writes under a
  // name of its own in its data directory, and a link there can only be something put there
  // to make that name mean a file somewhere else. It then reads as a miss, like any failure.
  const read = readTextSafe(USAGE_CACHE_FILE, USAGE_CACHE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(read.text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as UsageCache;
    }
  } catch {
    // corrupt cache — an empty one is a miss, and a miss is refreshable
  }
  return {};
}

/**
 * The entry a cache holds for one config dir, or undefined.
 *
 * AN OWN, OBJECT-VALUED ENTRY ONLY. The cache is a plain object indexed by a directory string
 * that comes from a file (`registry.json`, a ledger record): `cache['constructor']`,
 * `cache['toString']` and `cache['__proto__']` on a plain object are inherited members, which
 * read as "this account has a reading" and then have no fields in them. Anything that is not
 * a plain entry — inherited, an array, a scalar, null — is absent. Every lookup of this cache by
 * directory goes through here.
 */
export function ownCacheEntry(cache: UsageCache, configDir: string): AccountUsage | undefined {
  if (typeof configDir !== 'string' || !Object.prototype.hasOwnProperty.call(cache, configDir)) {
    return undefined;
  }
  const entry: unknown = cache[configDir];
  return isPlainObject(entry) ? (entry as unknown as AccountUsage) : undefined;
}

/**
 * File `entry` in `cache` under `configDir` as an OWN entry, whatever the directory is called.
 * A plain `cache[key] = entry` with the key `__proto__` — a string a hand-edited registry can
 * hold as a directory — would change the object's prototype instead and lose the reading.
 */
function setCacheEntry(cache: UsageCache, configDir: string, entry: AccountUsage): void {
  Object.defineProperty(cache, configDir, { value: entry, enumerable: true, writable: true, configurable: true });
}

/** Cached reading for one config dir, if present. Surfaces read this — they never spawn on render. */
export function getCachedUsage(configDir: string): AccountUsage | undefined {
  return ownCacheEntry(readUsageCache(), configDir);
}

/**
 * Merge two cache snapshots by configDir key. Pure (exported for tests). For a
 * key in both, the entry with the newest `fetchedAt` wins (a non-finite
 * fetchedAt is treated as 0, i.e. always losable). Keys present ONLY in `disk`
 * are KEPT: another process may legitimately track accounts this run does not
 * (e.g. a different main config dir), and dropping them would lose live readings.
 * On a fetchedAt tie, `fresh` wins.
 */
export function mergeUsageCaches(disk: UsageCache, fresh: UsageCache): UsageCache {
  const at = (u: AccountUsage | undefined): number => {
    const v = u?.fetchedAt;
    return typeof v === 'number' && isFinite(v) ? v : 0;
  };
  const out: UsageCache = { ...disk };
  for (const key of Object.keys(fresh)) {
    const f = fresh[key];
    // An OWN entry of the disk copy only: `out['constructor']` is not a reading to compare with.
    const d = Object.prototype.hasOwnProperty.call(out, key) ? out[key] : undefined;
    if (d === undefined || at(f) >= at(d)) {
      setCacheEntry(out, key, f);
    }
  }
  return out;
}

function writeUsageCache(cache: UsageCache): void {
  ensureDirs();
  // Re-read the on-disk cache immediately before writing and merge this run's
  // results into it. Two processes refreshing concurrently must not clobber each
  // other: mergeUsageCaches keeps the newest per-account reading and preserves
  // accounts only the other process tracks.
  let disk: UsageCache;
  try {
    disk = readUsageCache();
  } catch {
    disk = {};
  }
  const merged = mergeUsageCaches(disk, cache);
  // Atomic write: the extension host and the MCP server both refresh the same
  // file. tmp+rename prevents a concurrent reader from seeing a torn/truncated
  // file and prevents two writers from interleaving. Per-pid tmp avoids collision.
  const tmp = `${USAGE_CACHE_FILE}.${process.pid}.tmp`;
  const wrote = writeTempFileGuarded(tmp, JSON.stringify(merged, null, 2));
  if (!wrote.ok) {
    // Thrown, exactly as fs.writeFileSync threw here before: this function's callers treat a
    // return as "the cache now says this", and the one caller that cannot afford to care
    // (deleteUsageEntries) has its own catch. The rename is below and never runs.
    throw new Error(`the usage cache temp file could not be written (${wrote.detail}).`);
  }
  fs.renameSync(tmp, USAGE_CACHE_FILE);
}

/**
 * Delete cache entries for the given config dirs. Called when a worker is removed
 * so a lingering reading (possibly showing an exhausted window) cannot produce a
 * false quota verdict if the same name/directory is re-registered later. Re-reads,
 * deletes the given keys if present, and writes atomically via the same tmp+rename
 * pattern as writeUsageCache. Best-effort: a read or write failure is swallowed —
 * a stale entry is a nuisance, not fatal. Never throws.
 */
export function deleteUsageEntries(configDirs: string[]): void {
  try {
    const cache = readUsageCache();
    let changed = false;
    for (const dir of configDirs) {
      // Own entries only: `'constructor' in cache` is true of every object, and would rewrite
      // the file for a key that was never in it.
      if (Object.prototype.hasOwnProperty.call(cache, dir)) {
        delete cache[dir];
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    ensureDirs();
    const tmp = `${USAGE_CACHE_FILE}.${process.pid}.tmp`;
    const wrote = writeTempFileGuarded(tmp, JSON.stringify(cache, null, 2));
    if (!wrote.ok) {
      // Documented best-effort, so this returns rather than throws — but it returns WITHOUT
      // renaming, which is the part that matters: publishing a temp file we could not write
      // would put a truncated or foreign cache over the real one.
      return;
    }
    fs.renameSync(tmp, USAGE_CACHE_FILE);
  } catch {
    // best-effort — never throw to the caller
  }
}

/** How long a good windows reading is carried forward once upstream stops returning windows. */
const STALE_WINDOW_MAX_MS = 30 * 60 * 1000;

/**
 * get_usage intermittently returns `rate_limits: null` while `rate_limits_available`
 * stays true — a fresh but empty reading. Rather than blank the UI, carry the last
 * good windows (and the overage state that vanishes with them) forward, marked
 * stale, for up to STALE_WINDOW_MAX_MS. After that we let the account fall to the
 * honest "no windows" state rather than present very old numbers as if current.
 *
 * Every branch below returns a spread of `fresh` and only ever reaches into `prev`
 * for explicitly named fields. `auth` is deliberately NOT one of them: this merge
 * never carries any auth verdict forward, so an old "logged out" verdict can never
 * be resurrected here. (refreshAllUsage may reuse a prior `loggedIn:true` reading
 * before calling this — see shouldReuseAuth — but that decision is made upstream on
 * the fresh entry itself, and never for a logged-out verdict.)
 */
export function mergeStaleWindows(fresh: AccountUsage, prev: AccountUsage | undefined): AccountUsage {
  // Derive the last-good timestamp to carry forward. Prefer prev's own
  // lastGoodWindowsAt; otherwise migrate a pre-field cache entry by inferring it
  // from prev's windows timestamp when prev actually had windows. This ensures
  // old caches written before this field existed still light up the "last good
  // reading X ago" affordance on their first empty reading after upgrade.
  let prevLastGood: number | undefined;
  if (prev === undefined) {
    prevLastGood = undefined;
  } else if (typeof prev.lastGoodWindowsAt === 'number' && isFinite(prev.lastGoodWindowsAt)) {
    prevLastGood = prev.lastGoodWindowsAt;
  } else if (Array.isArray(prev.windows) && prev.windows.length > 0) {
    const at = prev.windowsFetchedAt ?? prev.fetchedAt;
    prevLastGood = typeof at === 'number' && isFinite(at) ? at : undefined;
  } else {
    prevLastGood = undefined;
  }

  if (fresh.windows.length > 0) {
    return {
      ...fresh,
      windowsFetchedAt: fresh.fetchedAt,
      windowsStale: false,
      lastGoodWindowsAt: fresh.fetchedAt,
    };
  }

  // No fresh windows. Whatever we return preserves lastGoodWindowsAt so the UI can
  // distinguish "temporarily unavailable" from "never observed", even once the
  // 30-min carry below expires and the windows themselves are gone.
  const base: AccountUsage = { ...fresh, lastGoodWindowsAt: prevLastGood };

  // Only paper over the specific "available but no windows, no probe error" gap.
  if (!fresh.available || fresh.error !== undefined) {
    return base;
  }
  const prevWindows = prev && Array.isArray(prev.windows) ? prev.windows : [];
  const prevAt = prev ? (prev.windowsFetchedAt ?? prev.fetchedAt) : undefined;
  const withinWindow =
    typeof prevAt === 'number' &&
    isFinite(prevAt) &&
    fresh.fetchedAt - prevAt >= 0 &&
    fresh.fetchedAt - prevAt <= STALE_WINDOW_MAX_MS;
  if (prevWindows.length > 0 && withinWindow) {
    return {
      ...base,
      windows: prevWindows,
      // extraUsage / subscriptionType disappear together with rate_limits — keep the last known.
      extraUsage: fresh.extraUsage ?? prev!.extraUsage,
      subscriptionType: fresh.subscriptionType ?? prev!.subscriptionType,
      windowsFetchedAt: prevAt,
      windowsStale: true,
    };
  }
  // Carry expired (or no prior windows): honest empty state — but lastGoodWindowsAt SURVIVES.
  return { ...base, windowsStale: false };
}

/** A plan window at/above this utilization is treated as exhausted (quota blocked). */
export const EXHAUSTED_PERCENT = 99;

/**
 * Return the windows that represent live, still-in-effect quota exhaustion.
 *
 * A window counts only when BOTH hold: (a) `percent` is a finite number
 * >= EXHAUSTED_PERCENT, and (b) its reset has NOT already passed. Rationale for
 * (b): a window whose `resetsAt` is in the past has already rolled over — the
 * cached reading is simply old — so it must NOT be reported as exhausted. We do
 * NOT need a separate staleness/age check: mergeStaleWindows clears windows once
 * they exceed the 30-min carry, so anything still present here is recent enough.
 *
 * A FALSE "exhausted" verdict is the harmful failure mode (it would wrongly block
 * dispatches), so every input is validated defensively: malformed entries
 * (non-objects, string/NaN percents) never yield exhausted. For resetsAt we bias
 * the OTHER way — null/absent/invalid-ISO counts as "not yet reset" (conservative:
 * we cannot prove it has rolled over), so a genuinely exhausted window with a
 * missing reset is still surfaced.
 */
export function exhaustedWindows(usage: AccountUsage | undefined, nowMs: number): UsageWindow[] {
  if (
    usage === undefined ||
    usage.error !== undefined ||
    usage.available !== true ||
    !Array.isArray(usage.windows)
  ) {
    return [];
  }
  const out: UsageWindow[] = [];
  for (const entry of usage.windows) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const w = entry as UsageWindow;
    if (typeof w.percent !== 'number' || !isFinite(w.percent) || w.percent < EXHAUSTED_PERCENT) {
      continue;
    }
    // Reset in the past => already rolled over => not exhausted. Missing/invalid
    // ISO cannot be proven past, so it conservatively counts as still exhausted.
    let stillInEffect: boolean;
    if (typeof w.resetsAt !== 'string' || !w.resetsAt) {
      stillInEffect = true;
    } else {
      const t = Date.parse(w.resetsAt);
      stillInEffect = isNaN(t) ? true : t > nowMs;
    }
    if (stillInEffect) {
      out.push(w);
    }
  }
  return out;
}

/**
 * Probe every account (bounded concurrency), persist results to the cache, and
 * return them. This is the only function that spawns; call it from a background
 * refresher / explicit refresh, never from a render path.
 */
export async function refreshAllUsage(
  accounts: { name: string; configDir: string }[] = listAccounts(),
  concurrency = 3,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<AccountUsage[]> {
  const prev = readUsageCache(); // last-good readings, to carry windows across an empty upstream response
  const results: AccountUsage[] = [];
  // What each reading's login check (if any) answered — the login probe it amounts to.
  const authOf = new Map<AccountUsage, { status: AuthStatus | undefined; reason: string; reused: boolean }>();
  let i = 0;
  const runner = async (): Promise<void> => {
    while (i < accounts.length) {
      const a = accounts[i++];
      const r = await fetchAccountUsage(a.name, a.configDir, timeoutMs);
      // Only the ambiguous case needs a second probe: the account answered cleanly
      // yet exposes no plan limits, which is either a token/non-subscription login
      // or an EXPIRED claude.ai one. An account that reports limits is demonstrably
      // healthy, and one whose probe errored tells us nothing — neither is probed,
      // so the extra spawn stays confined to the minority that needs it. The probe
      // SHARES the caller's latency budget: it is bounded by the smaller of its own
      // ceiling and this refresh's timeoutMs, so a caller that asked for a 5s bound
      // never waits 5s + 10s per ambiguous account. It leaves `auth` absent when it
      // cannot decide.
      //
      // Before spawning, the previous reading is consulted: a token/API-key account
      // is ambiguous FOREVER (rate_limits_available stays false) and answers
      // `loggedIn:true` every time, so shouldReuseAuth memoizes that one benign
      // verdict for AUTH_MEMO_TTL_MS — ~4 probes/day instead of ~288. A
      // `loggedIn:false` verdict is never reusable, so a suspected-expired account
      // is still re-probed every cycle and its recovery still lands within one. The
      // reused value is re-normalized through parseAuth rather than copied raw, so a
      // hand-edited usage.json cannot smuggle unknown fields into a fresh entry.
      //
      // A remembered verdict counts only when this version wrote it (the entry carries login
      // probes — Login state (CA)): one an older version left is checked once more.
      if (r.error === undefined && r.available !== true) {
        const prevEntry = ownCacheEntry(prev, a.configDir);
        const prevAuth = prevEntry?.auth;
        const remembered = parseAuth(prevAuth);
        if (shouldReuseAuth(prevAuth, Date.now()) && remembered !== undefined && Array.isArray(prevEntry?.loginProbes)) {
          r.auth = remembered;
          authOf.set(r, { status: remembered, reason: '', reused: true });
        } else {
          const { auth, reason } = await fetchAuthStatusDetailed(a.configDir, Math.min(AUTH_PROBE_TIMEOUT_MS, timeoutMs));
          if (auth !== undefined) {
            r.auth = auth;
          }
          authOf.set(r, { status: auth, reason, reused: false });
        }
      }
      results.push(r);
    }
  };
  // Every account of this refresh is `checking` (loginStateOf) until its reading is on disk.
  for (const a of accounts) {
    beginLoginCheck(a.configDir);
  }
  let merged: AccountUsage[];
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, runner));
    // The probes an account already has are taken from the file as it is NOW: a live check that
    // landed while this refresh ran is kept, not overwritten by the copy read at its start.
    const onDisk = readUsageCache();
    merged = results.map((r) => {
      const before = ownCacheEntry(prev, r.configDir);
      const entry = carryInitFacts(mergeStaleWindows(r, before), before, initFactsOfReading.get(r));
      // Every reading of this version carries the login probe it amounts to, after the account's
      // earlier ones (Login state (CA)).
      const earlier = ownCacheEntry(onDisk, r.configDir)?.loginProbes ?? before?.loginProbes;
      return { ...entry, loginProbes: appendLoginProbe(earlier, loginProbeOfReading(r, authOf.get(r))) };
    });
    const cache: UsageCache = {};
    for (const r of merged) {
      setCacheEntry(cache, r.configDir, r);
    }
    try {
      writeUsageCache(cache);
    } catch {
      // disk full / read-only — return the readings anyway; never reject.
    }
  } finally {
    for (const a of accounts) {
      endLoginCheck(a.configDir);
    }
  }
  scheduleLoginConfirmations(merged);
  return merged;
}

/** Default freshness window for the cross-process refresh throttle. */
export const USAGE_FRESH_DEFAULT_MS = 4 * 60 * 1000;

/**
 * Freshness window for a cached FAILURE, deliberately much shorter than the
 * success window — see isCacheFresh.
 */
export const USAGE_ERROR_FRESH_MS = 60_000;

/**
 * True iff the cache is fresh enough that no re-probe is warranted right now.
 * Pure (exported for tests). Requires a NON-EMPTY account list where EVERY account
 * has a cache entry with a finite `fetchedAt` in the inclusive window
 * [nowMs - effective, nowMs]. A future or NaN fetchedAt is treated as STALE
 * (clock-skew / tamper safety), and a newly added account with no cache entry
 * makes the whole cache stale — it still needs its first probe.
 *
 * An entry carrying an `error` gets the shorter `errorMaxAgeMs` instead: a cached
 * failure must not suppress re-probing for the full success window. When the
 * environment recovers (the CLI reinstalled, the network back), the next round is
 * at most errorMaxAgeMs away rather than a full maxAgeMs — while retries stay
 * throttled to one round per window so a persistently broken setup is not probed
 * in a loop. Math.min, not a plain substitution, so a caller asking for
 * tighter-than-default freshness is never loosened by this.
 *
 * Entries that are merely `available: false` WITHOUT an error — API-token
 * accounts, logged-out accounts — are stable, legitimate states, not failures, and
 * keep the normal window.
 */
export function isCacheFresh(
  cache: UsageCache,
  accounts: { name: string; configDir: string }[],
  nowMs: number,
  maxAgeMs: number,
  errorMaxAgeMs: number = USAGE_ERROR_FRESH_MS,
): boolean {
  if (accounts.length === 0) {
    return false;
  }
  for (const a of accounts) {
    const entry = ownCacheEntry(cache, a.configDir);
    if (!entry) {
      return false;
    }
    const at = entry.fetchedAt;
    if (typeof at !== 'number' || !isFinite(at)) {
      return false;
    }
    const effective = entry.error !== undefined ? Math.min(maxAgeMs, errorMaxAgeMs) : maxAgeMs;
    const age = nowMs - at;
    if (age < 0 || age > effective) {
      return false;
    }
  }
  return true;
}

/**
 * Refresh all accounts ONLY when the shared cache is stale — or when one account's login is not
 * confirmed (loginCheckDue) — else return null without probing. This is the cross-process throttle: multiple editor extension
 * hosts and the MCP server all read/write the same usage.json, so a process that
 * finds a recent-enough cache defers to whoever refreshed it, sparing the
 * per-account upstream endpoint from being over-probed. The cache read is wrapped
 * defensively — a read failure counts as stale so we still refresh. Never throws.
 */
export async function refreshAllUsageIfStale(
  maxAgeMs: number = USAGE_FRESH_DEFAULT_MS,
  accounts: { name: string; configDir: string }[] = listAccounts(),
  concurrency = 3,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<AccountUsage[] | null> {
  let cache: UsageCache;
  try {
    cache = readUsageCache();
  } catch {
    cache = {};
  }
  const now = Date.now();
  if (!isCacheFresh(cache, accounts, now, maxAgeMs)) {
    return refreshAllUsage(accounts, concurrency, timeoutMs);
  }
  // Fresh readings are not enough for an account whose reading says nothing this process can
  // stand on about its login (loginCheckDue — an older version's entry, a lone "not logged in",
  // a failed probe a minute old): a login state is only ever confirmed by a probe, so THOSE
  // accounts are probed — and only those.
  const due = accounts.filter((a) => loginCheckDue(ownCacheEntry(cache, a.configDir), now));
  return due.length === 0 ? null : refreshAllUsage(due, concurrency, timeoutMs);
}

/* ------------------------------------------------------------------------- *
 * Other vendors' accounts (Codex, Cursor, Antigravity)
 * ------------------------------------------------------------------------- */

/**
 * WHAT IS DIFFERENT ABOUT THEM. A worker on another vendor's CLI has a login and, sometimes, a
 * plan-usage reading, but neither can be asked of the `claude` binary. Both come from that
 * vendor's adapter, as one `ProviderStatus` (providers.ts). The adapters are imported only by
 * the bundled entry points under `src/mcp/`, so this module never calls one: the dispatch
 * server computes a status in-process and hands it to recordProviderStatus, and the extension
 * host forks the bundled helper (`provider-cli.js`) and hands over what it printed
 * (refreshProviderUsage).
 *
 * ONE CACHE, ONE SHAPE. A reading is stored as an ordinary `AccountUsage` under the worker's
 * config dir, so everything that already reads the cache — isLoginExpired, exhaustedWindows,
 * the dashboard model, list_workers — works on these accounts unchanged:
 *
 *   status                                   stored entry
 *   ---------------------------------------  ------------------------------------------------
 *   cliFound === false                       error: "CLI not found[: detail]"   (no `auth`)
 *   loggedIn === false                       available:false, auth.loggedIn:false, no error
 *                                            → isLoginExpired() is true
 *   quota is a snapshot                      available:true, windows, auth when loggedIn known
 *   quota null, error null                   available:false, auth when loggedIn is known
 *                                            ("logged in, no usage reading" / "login unknown")
 *   quota null, error set                    the same, plus error: <the status's error>
 *   not an object at all                     error: "provider status unreadable"
 *
 * `subscriptionType` and `auth.method` are the status's `mode`; `auth.email` is always null
 * (a status carries none); `auth` is ABSENT, not `loggedIn: null`, when the login is unknown —
 * parseAuth reads it the same either way, and "unknown" must never be mistaken for a verdict.
 *
 * NOTHING HERE HARD-CODES WHICH VENDOR HAS A QUOTA. Today only Codex's adapter returns a
 * snapshot; the others return null. That is a gap in the adapters, not in the vendors, so a
 * snapshot is stored whenever one arrives and a later adapter release lights the UI up with
 * no change in this file.
 */

/**
 * Stable prefix of `AccountUsage.error` when a provider's CLI could not be started at all (not
 * installed / not on PATH). The stored value is exactly this text, or this text followed by
 * `": "` and the status's own detail. Readable as it stands, and testable with
 * isProviderCliMissing — which is how a surface tells "install the CLI" from "the probe failed".
 */
export const PROVIDER_CLI_NOT_FOUND = 'CLI not found';

/** True iff the reading says the account's CLI is missing (see PROVIDER_CLI_NOT_FOUND). Total. */
export function isProviderCliMissing(usage: AccountUsage | undefined): boolean {
  // Read as `unknown`: the cache is a hand-editable file and `error` may hold anything.
  const error: unknown = (usage as { error?: unknown } | undefined)?.error;
  return (
    typeof error === 'string' &&
    (error === PROVIDER_CLI_NOT_FOUND || error.startsWith(`${PROVIDER_CLI_NOT_FOUND}:`))
  );
}

/** Caps of the stored strings (the same numbers `uiTypes.ts` documents for what is shown). */
const PROVIDER_ERROR_MAX = 200;
const PROVIDER_MODE_MAX = 32;
const PROVIDER_LABEL_MAX = 40;

/** Windows kept per reading — the number the dashboard model shows — and entries looked at. */
const PROVIDER_WINDOWS_MAX = 8;
const PROVIDER_WINDOWS_SCAN_MAX = 32;

/** A plan window at or above these utilizations is shown as critical / warning. */
const PROVIDER_CRITICAL_PERCENT = 90;
const PROVIDER_WARNING_PERCENT = 75;

/** Largest magnitude of epoch milliseconds a `Date` can hold. */
const DATE_MAX_MS = 8.64e15;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One value → one line of text of at most `max` UTF-16 units, or `''`. Only a string is text.
 *
 * A status is produced by our own helper from a vendor's answer, and the result is stored in
 * a file every surface reads (and that list_workers prints into a model's context), so labels
 * and error texts are flattened and cut HERE rather than trusted to be short and single-line.
 * The input is cut to a window first: the flattener is several regex passes over the value.
 */
function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw === '') {
    return '';
  }
  const window = Math.max(4096, max * 16);
  return sliceOneLine(flattenOneLine(raw.length > window ? raw.slice(0, window) : raw), max).trimEnd();
}

/** A reset timestamp → canonical ISO-8601, or null when absent, over-long or not a real date. */
function resetIso(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 64) {
    return null;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) && Math.abs(t) <= DATE_MAX_MS ? new Date(t).toISOString() : null;
}

/**
 * A status's quota windows → ours.
 *
 * `kind` is positional, by the window's place in the VENDOR'S list: the first is `session`,
 * the second `weekly_all`, and every further one `weekly_scoped` — never the first two kinds
 * again, which would present a third window as a second "session". The label is the vendor's
 * own, so what a window actually measures is always what is shown.
 *
 * A window whose `usedPercent` is not a finite number is DROPPED, not stored as 0: "0 % used"
 * is a claim, and an unreadable figure supports none. A finite one is clamped to 0–100.
 */
function providerWindows(raw: unknown): UsageWindow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: UsageWindow[] = [];
  const scan = Math.min(raw.length, PROVIDER_WINDOWS_SCAN_MAX);
  for (let i = 0; i < scan && out.length < PROVIDER_WINDOWS_MAX; i++) {
    const w: unknown = raw[i];
    if (!isPlainObject(w) || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) {
      continue;
    }
    const percent = clampPercent(w.usedPercent);
    out.push({
      kind: i === 0 ? 'session' : i === 1 ? 'weekly_all' : 'weekly_scoped',
      label: oneLine(w.label, PROVIDER_LABEL_MAX) || `Window ${i + 1}`,
      percent,
      severity:
        percent >= PROVIDER_CRITICAL_PERCENT
          ? 'critical'
          : percent >= PROVIDER_WARNING_PERCENT
            ? 'warning'
            : 'normal',
      resetsAt: resetIso(w.resetAt),
    });
  }
  return out;
}

/**
 * One `ProviderStatus` → the cache entry it means, plus whether an EARLIER quota reading may
 * stand in for the one this status lacks. Pure and total: `status` is read as `unknown`,
 * field by field, because one of its two producers is a child process's stdout.
 */
function providerEntry(
  worker: { name: string; configDir: string },
  status: unknown,
  now: number,
): { entry: AccountUsage; mayCarryWindows: boolean } {
  const base: AccountUsage = {
    name: worker.name,
    configDir: worker.configDir,
    available: false,
    subscriptionType: null,
    windows: [],
    sessionCostUsd: null,
    extraUsage: null,
    fetchedAt: now,
  };
  if (!isPlainObject(status)) {
    return { entry: { ...base, error: 'provider status unreadable' }, mayCarryWindows: false };
  }
  const detail = oneLine(status.error, PROVIDER_ERROR_MAX);
  // Only an explicit `false` says the CLI is missing. Any other value — `true`, absent, a
  // string — makes no such claim, and the rest of the status is read for what it does say.
  if (status.cliFound === false) {
    const error =
      detail === ''
        ? PROVIDER_CLI_NOT_FOUND
        : sliceOneLine(`${PROVIDER_CLI_NOT_FOUND}: ${detail}`, PROVIDER_ERROR_MAX);
    return { entry: { ...base, error }, mayCarryWindows: false };
  }
  const mode = oneLine(status.mode, PROVIDER_MODE_MAX) || null;
  const entry: AccountUsage = { ...base, subscriptionType: mode };
  if (typeof status.loggedIn === 'boolean') {
    entry.auth = { loggedIn: status.loggedIn, method: mode, email: null, checkedAt: now };
  }
  if (status.loggedIn === false) {
    // A positive "logged out" is the whole reading: no error is attached (isLoginExpired
    // refuses an entry that carries one) and a quota snapshot beside it is not believed.
    return { entry, mayCarryWindows: false };
  }
  if (isPlainObject(status.quota)) {
    entry.available = true;
    entry.windows = providerWindows(status.quota.windows);
    return { entry, mayCarryWindows: false };
  }
  // No quota in this status. With a reason it is a failed reading and is stored as one; with
  // none it is just "no usage reading" — which is NOT "no usage", so a recent earlier snapshot
  // may still be shown (see writeProviderEntry).
  if (detail !== '') {
    entry.error = detail;
    return { entry, mayCarryWindows: false };
  }
  return { entry, mayCarryWindows: true };
}

/**
 * The logged-out verdict of a failed run, re-filed as the reading of `now`: the entry that
 * stands in for a status reading while that verdict is in force (see writeProviderEntry).
 *
 * Built field by field from what the previous entry holds — it is a hand-editable file's — and
 * never by copying it: only the verdict, its provenance and the auth mode survive. `fetchedAt`
 * is the new reading's, so the account counts as freshly read and is not asked again at once;
 * `checkedAt` and `fromRunAt` stay the failed run's, because that run is still the evidence.
 */
function heldRunLoginFailure(
  worker: { name: string; configDir: string },
  prev: AccountUsage,
  failedAt: number,
  now: number,
): AccountUsage {
  const prevAuth = parseAuth(prev.auth);
  const mode = oneLine(prevAuth?.method, PROVIDER_MODE_MAX) || null;
  return {
    name: worker.name,
    configDir: worker.configDir,
    available: false,
    subscriptionType: mode,
    windows: [],
    sessionCostUsd: null,
    extraUsage: null,
    fetchedAt: now,
    auth: {
      loggedIn: false,
      method: mode,
      email: null,
      checkedAt: prevAuth !== undefined && prevAuth.checkedAt > 0 ? prevAuth.checkedAt : failedAt,
      fromRun: true,
      fromRunAt: failedAt,
    },
  };
}

/**
 * Merge one provider entry into the cache file.
 *
 * It goes through mergeStaleWindows like every Claude reading, so `windowsFetchedAt`,
 * `windowsStale` and `lastGoodWindowsAt` mean the same thing for every account.
 *
 * THE CARRY. A status without a quota is produced in two quite different situations: the
 * vendor returned none, or nobody ASKED for one (the dispatch server checking a login, usage
 * polling switched off). Neither says the account's usage went away, and the second happens
 * between two polls of the extension — storing it plainly would blank a meter that was read a
 * minute ago. So such a reading keeps the previous windows, marked stale, under exactly the
 * rule mergeStaleWindows already applies to an empty Claude reading (previous windows no older
 * than 30 minutes): the merge is simply asked the question as if the account were still
 * `available`, and its answer is used only when it did carry something.
 *
 * THE HOLD. `fromStatus` says the entry was read from the vendor CLI's status command (or is
 * the record of failing to read it), as opposed to learned from a run. While the stored
 * reading is a logged-out verdict a RUN produced and that verdict is still in force
 * (runLoginFailureAt), such an entry does not replace it — whatever it says. A status command
 * can answer "logged in" for an account its own run has just refused, and this is the one
 * place every writer of these entries passes through, so it is the one place the rule can be
 * held for the extension's refresh and the dispatch server's alike. The verdict is re-filed
 * with the new reading's time instead (heldRunLoginFailure).
 */
function writeProviderEntry(entry: AccountUsage, mayCarryWindows: boolean, fromStatus: boolean): void {
  const prev = ownCacheEntry(readUsageCache(), entry.configDir);
  if (fromStatus && prev !== undefined) {
    const failedAt = runLoginFailureAt(prev, entry.fetchedAt);
    if (failedAt !== undefined) {
      const held = heldRunLoginFailure(entry, prev, failedAt, entry.fetchedAt);
      writeUsageCache({ [entry.configDir]: mergeStaleWindows(held, prev) });
      return;
    }
  }
  let merged = mergeStaleWindows(entry, prev);
  if (mayCarryWindows && prev !== undefined && prev.available === true && prev.error === undefined) {
    const carried = mergeStaleWindows({ ...entry, available: true }, prev);
    if (carried.windowsStale === true) {
      merged = carried;
    }
  }
  writeUsageCache({ [entry.configDir]: merged });
}

/**
 * Non-Claude workers, in registry order — the accounts refreshProviderUsage covers.
 *
 * The cache is keyed by config dir, so a directory can hold ONE reading. A worker is left out
 * when its directory is already a Claude Code account's (main's or a Claude worker's), or an
 * earlier non-Claude worker's: the first owner of a directory keeps its cache key, and a later
 * one is never read at all rather than read into somebody else's entry. No registered setup
 * produces this (each provider has its own default home, and a separate login gets its own
 * directory); it takes a hand-edited registry.json.
 */
export function listProviderAccounts(): { name: string; configDir: string; provider: ProviderId }[] {
  const out: { name: string; configDir: string; provider: ProviderId }[] = [];
  let registry: Registry;
  try {
    registry = readRegistry();
  } catch {
    return out;
  }
  const taken = new Set<string>([path.resolve(hostConfigDir())]);
  for (const w of claudeWorkers(registry)) {
    taken.add(path.resolve(w.configDir));
  }
  for (const w of registry.workers) {
    const provider = workerProvider(w);
    if (provider === 'claude') {
      continue;
    }
    const dir = path.resolve(w.configDir);
    if (!taken.has(dir)) {
      taken.add(dir);
      out.push({ name: w.name, configDir: w.configDir, provider });
    }
  }
  return out;
}

/** Is `configDir` the directory of a Claude Code account (main, or a Claude worker)? */
function isClaudeAccountDir(configDir: string): boolean {
  const dir = path.resolve(configDir);
  return listAccounts().some((a) => path.resolve(a.configDir) === dir);
}

/**
 * Is the cache entry filed under `worker.configDir` this worker's OWN reading?
 *
 * The cache holds ONE reading per directory, and that reading has one owner: the Claude Code
 * account when the directory is one's (main or a Claude worker — recordProviderStatus refuses
 * to file anything else there), otherwise the first non-Claude worker registered on it
 * (listProviderAccounts). So a Claude Code account always owns its directory's entry, and a
 * worker on another vendor's CLI owns it only when listProviderAccounts names that worker.
 */
export function ownsUsageReading(worker: {
  name: string;
  configDir: string;
  provider?: unknown;
}): boolean {
  let provider: ProviderId;
  try {
    provider = workerProvider(worker);
  } catch {
    // A `provider` this version does not know. No registry worker has one (such an entry is
    // not a worker at all), and whatever was handed in owns no reading of any vendor.
    return false;
  }
  if (provider === 'claude') {
    return true;
  }
  const dir = path.resolve(worker.configDir);
  const owner = listProviderAccounts().find((a) => path.resolve(a.configDir) === dir);
  return owner !== undefined && owner.name === worker.name && owner.provider === provider;
}

/**
 * The cached reading that is `worker`'s OWN, or undefined when there is none — the way a surface
 * that lists every registry worker (the Workers tree, an account pick) reads the cache.
 *
 * A worker that does not own its directory's entry (ownsUsageReading) has no reading, and must
 * not be shown the owner's as its own: a Codex worker somebody registered on the main Claude
 * account's directory would otherwise display that account's plan windows and login state.
 */
export function getCachedWorkerUsage(worker: {
  name: string;
  configDir: string;
  provider?: unknown;
}): AccountUsage | undefined {
  return ownsUsageReading(worker) ? getCachedUsage(worker.configDir) : undefined;
}

/**
 * Merge ONE reading of a non-Claude account into the usage cache, under `worker.configDir`.
 * The mapping is the table at the top of this section. Called by the dispatch server after it
 * computed a status in-process, and by refreshProviderUsage after the helper printed one.
 *
 * Never throws and returns nothing: a status of any shape — wrong types, non-finite
 * percentages, hundreds of windows, labels full of control characters — becomes a well-formed
 * entry, and a cache that cannot be written is a reading that is simply not kept.
 *
 * Refused silently (nothing is written) when `worker` has no usable name / config dir, or when
 * the directory is a CLAUDE CODE account's: that cache key feeds the dispatch gates of the
 * Claude account (isLoginExpired, exhaustedWindows), and another vendor's "logged out" stored
 * there would take a healthy Claude account out of rotation.
 *
 * `now` is the time the reading was taken (epoch ms); a value that is not a finite number is
 * replaced by the current time.
 *
 * `opts.fromRun` — WHERE THE READING CAME FROM. Leave it out for a status read from the vendor
 * CLI's status command (the extension's refresh, the server's own refresh). Pass `true` when a
 * RUN on this account has just failed on login and `status` says so (`loggedIn: false`): the
 * stored verdict then carries its provenance (`auth.fromRun`, `auth.fromRunAt`) and, for
 * RUN_LOGIN_FAILURE_STICKY_MS, is not replaced by any reading recorded WITHOUT the flag — not
 * even one that says "logged in", which is the reading an optimistic status command gives for
 * an account its run refuses (see runLoginFailureAt for what ends it). The flag is believed
 * only beside a status that really says logged out with the CLI present; beside any other
 * status it is ignored and the reading is an ordinary one.
 */
export function recordProviderStatus(
  worker: { name: string; configDir: string },
  status: ProviderStatus,
  now: number = Date.now(),
  opts?: { fromRun?: boolean },
): void {
  try {
    const target = usableWorker(worker);
    if (target === undefined || isClaudeAccountDir(target.configDir)) {
      return;
    }
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const { entry, mayCarryWindows } = providerEntry(target, status, at);
    const auth = entry.auth;
    const runFailure =
      isPlainObject(opts) && opts.fromRun === true && auth?.loggedIn === false && entry.error === undefined;
    if (runFailure && auth !== undefined) {
      auth.fromRun = true;
      auth.fromRunAt = at;
    }
    writeProviderEntry(entry, mayCarryWindows, !runFailure);
  } catch {
    // an unwritable cache, or a `status` whose property access itself throws — never the caller's problem
  }
}

/**
 * A run on this non-Claude account has just FAILED ON LOGIN: file the logged-out verdict with
 * its provenance, so that it is held against the vendor CLI's own status check (see
 * runLoginFailureAt). The call the dispatch server makes where a run fails on authentication —
 * exactly `recordProviderStatus(worker, <logged out>, now, { fromRun: true })`, under a name
 * that says what happened. Refused silently for the same accounts; never throws.
 */
export function recordProviderRunLoginFailure(
  worker: { name: string; configDir: string },
  now: number = Date.now(),
): void {
  recordProviderStatus(
    worker,
    { cliFound: true, loggedIn: false, mode: null, quota: null, error: null },
    now,
    { fromRun: true },
  );
}

/**
 * A run on this non-Claude account has just SUCCEEDED — the strongest evidence of a working
 * login there is. Called by the dispatch server after a provider run settles as done; it is
 * event (a) of runLoginFailureAt.
 *
 * When the cache holds a logged-out verdict for the account (one a failed run produced, or one
 * a status command gave), that verdict is replaced by "logged in, no usage reading", which the
 * next status refresh fills in. When it holds anything else — the usual case — NOTHING is
 * written: this runs after every successful provider run and must cost a small read.
 *
 * Refused silently for an unusable worker and for a Claude Code account's directory, exactly
 * as recordProviderStatus is. Never throws.
 */
export function recordProviderRunSucceeded(
  worker: { name: string; configDir: string },
  now: number = Date.now(),
): void {
  try {
    const target = usableWorker(worker);
    if (target === undefined || isClaudeAccountDir(target.configDir)) {
      return;
    }
    const prev = ownCacheEntry(readUsageCache(), target.configDir);
    const prevAuth = parseAuth(prev?.auth);
    if (prev === undefined || prevAuth?.loggedIn !== false) {
      return;
    }
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const { entry, mayCarryWindows } = providerEntry(
      target,
      { cliFound: true, loggedIn: true, mode: oneLine(prevAuth.method, PROVIDER_MODE_MAX) || null, quota: null, error: null },
      at,
    );
    // Not a status reading: a run's success is exactly what ends the hold.
    writeProviderEntry(entry, mayCarryWindows, false);
  } catch {
    // best-effort, like every other write of this cache
  }
}

/**
 * The user has started signing this non-Claude account in again from the extension — event (b)
 * of runLoginFailureAt. Called by the extension's re-login command.
 *
 * A logged-out verdict that a failed run produced loses its PROVENANCE, and with it its hold:
 * the account still reads as logged out (nobody has proved otherwise yet), but the next status
 * reading is believed again, so a completed sign-in shows up at the next refresh instead of
 * after RUN_LOGIN_FAILURE_STICKY_MS. `fetchedAt` is left as it was, so that refresh is not put
 * off by this write. When the cache holds no such verdict, nothing is written. Never throws.
 */
export function clearProviderRunLoginFailure(worker: { name: string; configDir: string }): void {
  try {
    const target = usableWorker(worker);
    if (target === undefined || isClaudeAccountDir(target.configDir)) {
      return;
    }
    const prev = ownCacheEntry(readUsageCache(), target.configDir);
    const prevAuth = parseAuth(prev?.auth);
    if (prev === undefined || prevAuth?.fromRun !== true) {
      return;
    }
    const fetchedAt =
      typeof prev.fetchedAt === 'number' && Number.isFinite(prev.fetchedAt) ? prev.fetchedAt : Date.now();
    const held = heldRunLoginFailure(target, prev, prevAuth.fromRunAt ?? fetchedAt, fetchedAt);
    const auth: AuthStatus = {
      loggedIn: false,
      method: held.auth?.method ?? null,
      email: null,
      checkedAt: held.auth?.checkedAt ?? fetchedAt,
    };
    // The same time as the entry on disk: mergeUsageCaches lets the new one win a tie.
    writeUsageCache({ [target.configDir]: mergeStaleWindows({ ...held, auth }, prev) });
  } catch {
    // best-effort, like every other write of this cache
  }
}

/** `worker` reduced to the two strings an entry is made of, or undefined when either is unusable. */
function usableWorker(worker: unknown): { name: string; configDir: string } | undefined {
  if (!isPlainObject(worker)) {
    return undefined;
  }
  const { name, configDir } = worker;
  return typeof name === 'string' && typeof configDir === 'string' && configDir.trim() !== ''
    ? { name, configDir }
    : undefined;
}

/** Store a reading that could not be taken at all (no helper, no JSON, a timeout). Never throws. */
function recordProviderFailure(worker: { name: string; configDir: string }, message: string): void {
  try {
    if (isClaudeAccountDir(worker.configDir)) {
      return;
    }
    const error = oneLine(message, PROVIDER_ERROR_MAX) || 'provider status unavailable';
    // A string is not a status: providerEntry turns it into the plain error entry, and the
    // message replaces the generic text.
    const { entry } = providerEntry(worker, undefined, Date.now());
    // A reading that could not be taken says nothing about the login, so it is held back by a
    // run-proved logout exactly as a status reading is.
    writeProviderEntry({ ...entry, error }, false, true);
  } catch {
    // best-effort, like every other write of this cache
  }
}

/** How long one run of the bundled helper may take before it is ended and recorded as a timeout. */
export const PROVIDER_HELPER_TIMEOUT_MS = 25_000;

/** Helpers running at once — the same bound the Claude usage probe uses. */
const PROVIDER_REFRESH_CONCURRENCY = 3;

/** Cap on collected helper stdout. The payload is one line of JSON of a few hundred bytes. */
const PROVIDER_STDOUT_MAX_CHARS = 64 * 1024;
const PROVIDER_STDERR_MAX_CHARS = 2000;

type HelperOutcome = { status: Record<string, unknown> } | { error: string };

/**
 * What the helper printed → a status, or why there is none.
 *
 * The contract is ONE line of JSON, so the lines are tried from the last one back and the
 * first that parses as an object decides: a `ProviderStatus` (it has a boolean `cliFound`), or
 * the helper's own `{"error": "..."}` refusal of its arguments. Anything else is not a reading.
 */
function parseHelperOutput(out: string): HelperOutcome | undefined {
  const lines = out.split('\n');
  for (let i = lines.length - 1, tried = 0; i >= 0 && tried < 50; i--) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }
    tried++;
    if (!line.startsWith('{')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) {
      continue;
    }
    if (typeof parsed.cliFound === 'boolean') {
      return { status: parsed };
    }
    const refusal = oneLine(parsed.error, PROVIDER_ERROR_MAX);
    return { error: refusal === '' ? 'the provider helper printed no status' : `provider helper: ${refusal}` };
  }
  return undefined;
}

/** What one run of the bundled helper came to. */
type HelperRun =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; out: string; err: string }
  /** It did not leave within its time; `out` is what it had printed until then. */
  | { kind: 'timeout'; out: string }
  /** It could not be started, or it printed past its budget and was ended. */
  | { kind: 'failed'; error: string };

/** The bounds of one run of the helper (see runHelperProcess). */
interface HelperLimits {
  timeoutMs: number;
  /** Bytes of stdout past which the helper is not answering and is ended. */
  stdoutMaxBytes: number;
  /** How much of stdout is kept — its tail. */
  stdoutKeepChars: number;
}

/**
 * Run the bundled helper (`provider-cli.js`) once with `args`. Resolves in every case — never
 * rejects — with how the run ended; what the output MEANS is the caller's to decide.
 *
 *  - `fork`, so it runs on this process's own Node (the extension host's, which is not `node`
 *    on PATH), with `execArgv` EMPTIED: a host started with `--inspect` would otherwise hand
 *    the same debugger port to every helper.
 *  - Environment: vendorChildEnv() — the helper drives ANOTHER vendor's CLI, so neither this
 *    editor's Claude Code session identity nor an Anthropic credential (`ANTHROPIC_API_KEY`,
 *    `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) nor `CLAUDE_CONFIG_DIR` is handed to it;
 *    whatever the vendor's own CLI reads (its API key, proxies, PATH) passes through.
 *  - A neutral cwd, for the reason the Claude probes use one: no project file is picked up.
 *  - Settled on 'exit' (onChildExit), not 'close'; capped at `limits.timeoutMs`, after which
 *    the child is ended by the SIGTERM → SIGKILL ladder.
 */
function runHelperProcess(helperPath: string, args: string[], limits: HelperLimits): Promise<HelperRun> {
  return new Promise((resolve) => {
    const env = vendorChildEnv();
    if (process.versions.electron !== undefined) {
      // Under an Electron host `process.execPath` is the editor itself; this is what makes it
      // run the script as Node. Electron's own `fork` sets it too — stated here so the helper
      // does not depend on that patch seeing a caller-supplied `env`.
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    let child: ChildProcess;
    try {
      child = fork(helperPath, args, { cwd: os.tmpdir(), env, execArgv: [], silent: true });
    } catch (e) {
      resolve({
        kind: 'failed',
        error: `the provider helper could not be started: ${(e as Error)?.message ?? 'unknown error'}`,
      });
      return;
    }

    let settled = false;
    let out = '';
    let err = '';
    const done = (run: HelperRun): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(run);
      // A no-op when the helper has already left; the ladder when it has not.
      terminateChild(child, 'signal');
    };
    const timer = setTimeout(() => done({ kind: 'timeout', out }), limits.timeoutMs);

    // The helper reads nothing from stdin; ending it means nothing it starts can wait on ours.
    child.stdin?.on('error', () => undefined);
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    let stdoutBytes = 0;
    const stderrOver = streamBudget();
    /** Past its budget on one stream the helper is not answering; it is ended. */
    const tooMuch = (): void =>
      done({ kind: 'failed', error: `${OUTPUT_TOO_LARGE} — the provider helper was ended` });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (settled) {
        return;
      }
      stdoutBytes += Buffer.byteLength(d);
      if (stdoutBytes > limits.stdoutMaxBytes) {
        tooMuch();
        return;
      }
      // The TAIL is what is kept: the answer is the last thing the helper prints, so
      // whatever preceded it (a notice, a log) is what may be lost.
      out = (out + d).slice(-limits.stdoutKeepChars);
    });
    child.stdout?.on('error', () => undefined);
    // Drained whether or not it is kept: a chatty child must not block on a full pipe.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      if (settled) {
        return;
      }
      if (stderrOver(d)) {
        tooMuch();
        return;
      }
      if (err.length < PROVIDER_STDERR_MAX_CHARS) {
        err = (err + d).slice(0, PROVIDER_STDERR_MAX_CHARS);
      }
    });
    child.stderr?.on('error', () => undefined);
    child.on('error', (e) =>
      done({ kind: 'failed', error: `the provider helper could not be started: ${e.message}` }),
    );
    onChildExit(child, (code, signal) => done({ kind: 'exit', code, signal, out, err }));
  });
}

/**
 * Run the bundled helper once for one account: `status <provider> <configDir> [--quota]`.
 * Resolves in every case — never rejects.
 *
 * Capped at PROVIDER_HELPER_TIMEOUT_MS, after which what was printed so far is still parsed:
 * a helper that answered and then failed to leave has answered.
 */
async function runProviderHelper(
  helperPath: string,
  account: { configDir: string; provider: ProviderId },
  polling: boolean,
): Promise<HelperOutcome> {
  const args = ['status', account.provider, account.configDir];
  if (polling) {
    args.push('--quota');
  }
  const run = await runHelperProcess(helperPath, args, {
    timeoutMs: PROVIDER_HELPER_TIMEOUT_MS,
    stdoutMaxBytes: CHILD_STREAM_MAX_BYTES,
    stdoutKeepChars: PROVIDER_STDOUT_MAX_CHARS,
  });
  if (run.kind === 'failed') {
    return { error: run.error };
  }
  if (run.kind === 'timeout') {
    return parseHelperOutput(run.out) ?? { error: 'timeout — the provider helper did not answer in time' };
  }
  const parsed = parseHelperOutput(run.out);
  if (parsed !== undefined) {
    return parsed;
  }
  const how = run.signal !== null ? `was ended by ${run.signal}` : `exited with code ${String(run.code)}`;
  const said = run.err.trim();
  return { error: `the provider helper ${how} without a status${said === '' ? '' : `: ${said}`}` };
}

/**
 * Is this account's cached reading recent enough that the helper need not run again?
 *
 * The rule IS isCacheFresh's — four minutes for a reading, one for a failure, a future or
 * unreadable timestamp is stale — applied to one account, so each is refreshed on its own
 * clock and a second editor window (or the dispatch server) that just read an account spares
 * this one the fork. One addition: when usage is being polled, an entry whose windows are a
 * carried-forward copy (`windowsStale`) is NOT fresh. Something recorded a quota-less status
 * over a real snapshot; the snapshot is known to exist and is worth re-reading now.
 */
function isProviderEntryFresh(
  cache: UsageCache,
  account: { name: string; configDir: string },
  nowMs: number,
  polling: boolean,
): boolean {
  const entry = ownCacheEntry(cache, account.configDir);
  if (entry === undefined || (polling && entry.windowsStale === true)) {
    return false;
  }
  return isCacheFresh({ [account.configDir]: entry }, [account], nowMs, USAGE_FRESH_DEFAULT_MS);
}

async function refreshProviderUsageNow(opts: unknown): Promise<void> {
  const o = isPlainObject(opts) ? opts : {};
  // `polling` is a setting whose default is on: only an explicit `false` turns the quota off.
  const polling = o.polling !== false;
  const force = o.force === true;
  const helperPath = typeof o.helperPath === 'string' ? o.helperPath : '';

  const accounts = listProviderAccounts();
  if (accounts.length === 0) {
    return;
  }
  const cache = readUsageCache();
  const now = Date.now();
  const due = force ? accounts : accounts.filter((a) => !isProviderEntryFresh(cache, a, now, polling));
  if (due.length === 0) {
    return;
  }
  // The helper is a build product (`out/mcp/provider-cli.js`). Its absence is a state a
  // development checkout really has, and it is told to the user as a reading that failed.
  const helperProblem = !path.isAbsolute(helperPath)
    ? 'the provider helper path is not an absolute path'
    : statFileSafe(helperPath) === undefined
      ? 'the provider helper (provider-cli.js) was not found — the extension is not fully built'
      : undefined;

  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < due.length) {
      const account = due[next++];
      if (helperProblem !== undefined) {
        recordProviderFailure(account, helperProblem);
        continue;
      }
      if (!path.isAbsolute(account.configDir)) {
        // The directory becomes an ARGUMENT of the helper; one that is not a path (it could
        // read as an option) is not passed.
        recordProviderFailure(account, 'the account directory is not an absolute path');
        continue;
      }
      const outcome = await runProviderHelper(helperPath, account, polling);
      if ('status' in outcome) {
        recordProviderStatus(account, outcome.status as unknown as ProviderStatus);
      } else {
        recordProviderFailure(account, outcome.error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROVIDER_REFRESH_CONCURRENCY, due.length) }, runner));
}

/** Calls of refreshProviderUsage run one after another; see there. */
let providerRefreshTail: Promise<void> = Promise.resolve();

/**
 * Read every non-Claude worker's login state and (when `polling`) plan usage into the usage
 * cache: one run of the bundled helper per account, at most three at a time, each capped at
 * PROVIDER_HELPER_TIMEOUT_MS. The extension-side driver — call it wherever refreshAllUsage /
 * refreshAllUsageIfStale are called (the same triggers).
 *
 *  - `helperPath`: absolute path of the bundled `provider-cli.js`. A helper that is not there
 *    is an ERROR ENTRY for each account, never a throw.
 *  - `polling`: the `providerUsagePolling` setting. `--quota` is passed only when it is not
 *    `false`; with it off, login state is still read and no vendor usage endpoint is called.
 *  - `force` (optional, not part of the frozen signature): `true` re-reads every account now,
 *    for an explicit "Refresh usage". Without it an account whose reading is still fresh
 *    (isProviderEntryFresh — the Claude rule) is skipped, which is what makes this safe to
 *    call from several editor windows on a timer.
 *
 * Never rejects and never throws. Calls are SERIALIZED: one arriving while another is running
 * waits for it and then, finding the readings fresh, does nothing — so overlapping triggers
 * cannot double the number of child processes.
 */
export function refreshProviderUsage(opts: {
  helperPath: string;
  polling: boolean;
  force?: boolean;
}): Promise<void> {
  const run = providerRefreshTail.then(() => refreshProviderUsageNow(opts)).catch(() => undefined);
  providerRefreshTail = run;
  return run;
}

/* ------------------------------------------------------------------------- *
 * Other vendors' model catalogs
 * ------------------------------------------------------------------------- */

/** One model a vendor's CLI offers: the id a worker's default is stored as, and its name. */
export interface ProviderModel {
  id: string;
  /** The vendor's own name for it, ≤ 80 chars, display-safe; null when it gave none. */
  label: string | null;
  /**
   * ANOTHER vendor's model that this provider's CLI resells (a Claude or GPT model listed by
   * Cursor, say): running it spends this provider's plan. True only when the helper said
   * exactly `true`; a missing key, or any other value, is "its own".
   */
  resold: boolean;
  /** The CLI's own default model: present, and `true`, only when the listing said exactly that. */
  default?: true;
  /**
   * The reasoning efforts the CLI offers for it (Codex: `low`, `medium`, `high`, …), as listed,
   * at most PROVIDER_MODEL_EFFORTS_MAX short words; absent when the listing gave none.
   */
  efforts?: string[];
}

/** Most reasoning efforts kept per model, and the shape one must have. */
const PROVIDER_MODEL_EFFORTS_MAX = 8;
const PROVIDER_MODEL_EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

/** A listing's `efforts` → the words kept, each once, in order. */
function effortsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const value of raw.slice(0, PROVIDER_MODEL_EFFORTS_MAX * 4)) {
    if (typeof value === 'string' && PROVIDER_MODEL_EFFORT.test(value) && !out.includes(value)) {
      out.push(value);
      if (out.length >= PROVIDER_MODEL_EFFORTS_MAX) {
        break;
      }
    }
  }
  return out;
}

/**
 * What the helper's `models <provider> <configDir>` answered for one account.
 *
 *  - `live`:   the CLI was asked now and listed these models;
 *  - `static`: the adapter's built-in catalog answered;
 *  - `none`:   there is no list — the helper failed, timed out, printed something else, the
 *              CLI said why it could not list, or it listed nothing this extension can use
 *              (`error`, one line). `models` is then empty — and ONLY then: a `live` or
 *              `static` catalog always holds at least one model.
 */
export interface ProviderModelCatalog {
  models: ProviderModel[];
  source: 'live' | 'static' | 'none';
  error: string | null;
  fetchedAt: number;
}

/**
 * Bounds of one answer: the helper's own, checked again on this side of the pipe. The count
 * leaves room for a CLI that resells other vendors' models — one such listing holds some 260.
 */
const PROVIDER_MODELS_MAX = 600;
const PROVIDER_MODEL_ID_MAX = 128;
const PROVIDER_MODEL_LABEL_MAX = 80;
const PROVIDER_MODELS_STDOUT_MAX_BYTES = 256 * 1024;

/** How long a catalog is offered again without asking the CLI; a failure, like a failed reading, less. */
export const PROVIDER_MODELS_TTL_MS = 10 * 60_000;
const PROVIDER_MODELS_ERROR_TTL_MS = 60_000;
/** One entry per account directory asked about; a registry holds far fewer than this. */
const PROVIDER_MODELS_CACHE_MAX = 64;

/**
 * The budget of one listing, as the helper takes it (`--budget-ms=`): it refuses a value
 * outside these bounds, so a caller's wish is brought inside them here.
 */
const PROVIDER_MODELS_BUDGET_MIN_MS = 1000;
const PROVIDER_MODELS_BUDGET_MAX_MS = PROVIDER_HELPER_TIMEOUT_MS;
/**
 * How long past its budget the helper is left alone before it is ended from here. The helper
 * ends what it started when its own budget runs out; ending the helper first would leave the
 * vendor CLI it started running with nobody to end it.
 */
const PROVIDER_MODELS_GRACE_MS = 5_000;

const modelCatalogs = new Map<string, ProviderModelCatalog>();
/** Listings in flight, by account AND budget: callers share a child only when they gave it the same time. */
const modelCatalogRuns = new Map<string, Promise<ProviderModelCatalog>>();

function modelCatalogKey(provider: ProviderId, configDir: string): string {
  return `${provider}\u0000${path.resolve(configDir)}`;
}

function noCatalog(error: string): ProviderModelCatalog {
  return {
    models: [],
    source: 'none',
    error: oneLine(error, PROVIDER_ERROR_MAX) || 'the CLI could not list its models',
    fetchedAt: Date.now(),
  };
}

/**
 * The helper's answer → a catalog. The contract is exactly ONE line of JSON,
 * `{"models":[{"id","label"?}],"source":"live"|"static","error":null|"…"}`, from a process that
 * exited 0 (an entry may also carry `"resold": true`). Anything else — no line, two lines,
 * another shape, an `error` — is "no list".
 *
 * An id is kept only as `normalizeProviderModel` stores it (a worker's default goes into the
 * registry through that same function), once, and never past the bounds above: the answer is
 * the output of another vendor's program.
 */
function parseModelCatalog(provider: ProviderId, out: string): ProviderModelCatalog {
  const lines = out.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) {
    return noCatalog(lines.length === 0 ? 'the provider helper printed nothing' : 'the provider helper printed more than its one line');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return noCatalog('the provider helper did not print JSON');
  }
  if (!isPlainObject(parsed)) {
    return noCatalog('the provider helper did not print a model list');
  }
  if (parsed.error !== null && parsed.error !== undefined) {
    return noCatalog(oneLine(parsed.error, PROVIDER_ERROR_MAX) || 'the CLI could not list its models');
  }
  if (!Array.isArray(parsed.models) || (parsed.source !== 'live' && parsed.source !== 'static')) {
    return noCatalog('the provider helper did not print a model list');
  }
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.models.slice(0, PROVIDER_MODELS_MAX * 4)) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length > PROVIDER_MODEL_ID_MAX) {
      continue;
    }
    const id = normalizeProviderModel(provider, entry.id);
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const model: ProviderModel = {
      id,
      label: oneLine(entry.label, PROVIDER_MODEL_LABEL_MAX) || null,
      resold: entry.resold === true,
    };
    if (entry.default === true) {
      model.default = true;
    }
    const efforts = effortsOf(entry.efforts);
    if (efforts.length > 0) {
      model.efforts = efforts;
    }
    models.push(model);
    if (models.length >= PROVIDER_MODELS_MAX) {
      break;
    }
  }
  if (models.length === 0) {
    // Nothing listed, or nothing that is a model id here: not a list of no models, but no list.
    return noCatalog('the CLI listed no model this extension can use');
  }
  return { models, source: parsed.source, error: null, fetchedAt: Date.now() };
}

function isCatalogFresh(catalog: ProviderModelCatalog | undefined, nowMs: number): catalog is ProviderModelCatalog {
  if (catalog === undefined) {
    return false;
  }
  // A negative age is a clock that went backwards: stale, so a verdict is never held for ever.
  const age = nowMs - catalog.fetchedAt;
  return age >= 0 && age < (catalog.source === 'none' ? PROVIDER_MODELS_ERROR_TTL_MS : PROVIDER_MODELS_TTL_MS);
}

/**
 * The catalog last read for this account, while it is fresh — or undefined. Reads memory only:
 * safe on any path that must not start a process (a redraw, a message from a page).
 */
export function cachedProviderModels(
  provider: ProviderId,
  configDir: string,
  nowMs: number = Date.now(),
): ProviderModelCatalog | undefined {
  if (typeof configDir !== 'string' || configDir === '') {
    return undefined;
  }
  const hit = modelCatalogs.get(modelCatalogKey(provider, configDir));
  return isCatalogFresh(hit, nowMs) ? hit : undefined;
}

/**
 * The newest fresh catalog of ANY account of `provider` that holds a list, or undefined. For
 * a surface that offers models per provider rather than per account. Memory only.
 */
export function freshProviderModels(provider: ProviderId, nowMs: number = Date.now()): ProviderModelCatalog | undefined {
  let newest: ProviderModelCatalog | undefined;
  const prefix = `${provider}\u0000`;
  for (const [key, catalog] of modelCatalogs) {
    if (
      key.startsWith(prefix) &&
      catalog.models.length > 0 &&
      isCatalogFresh(catalog, nowMs) &&
      (newest === undefined || catalog.fetchedAt > newest.fetchedAt)
    ) {
      newest = catalog;
    }
  }
  return newest;
}

/** Forget every catalog. For tests, which each start from nothing. */
export function resetProviderModelsForTest(): void {
  modelCatalogs.clear();
  modelCatalogRuns.clear();
}

/**
 * Which models does this account's CLI offer? One run of the bundled helper
 * (`models <provider> <configDir> --budget-ms=<n>`), through the runner the status reading
 * uses — the same Node, the same environment, the same neutral cwd — and bounded: 256 KiB of
 * output, and a BUDGET of `timeoutMs` milliseconds (1 to 25 seconds; 25 unless the caller
 * gives another).
 *
 * The budget is the helper's, handed to it as its last argument: it gives the vendor CLI that
 * long (less its own margin) and ends what it started when the time is up. The helper itself
 * is ended from here only five seconds PAST the budget — a helper ended earlier would leave
 * the CLI it started running.
 *
 * Never rejects and never throws. EVERY way of not getting a list is one answer, `source:
 * 'none'` with the reason in `error`: a helper that is missing, exits non-zero, prints nothing
 * or something else, prints too much, lists nothing usable, or does not answer in time. Unlike
 * a status reading, output of a run that timed out is not parsed: half a list is not a list.
 *
 * The answer is kept in memory per (provider, directory): a list for ten minutes, "no list"
 * for one. A call inside that time starts nothing. Calls that overlap share one child only
 * when they asked with the SAME budget — one caller's short patience is never another's answer.
 */
export function listProviderModels(opts: {
  helperPath: string;
  provider: ProviderId;
  configDir: string;
  timeoutMs?: number;
}): Promise<ProviderModelCatalog> {
  const o: Record<string, unknown> = isPlainObject(opts) ? opts : {};
  const configDir = typeof o.configDir === 'string' ? o.configDir : '';
  const helperPath = typeof o.helperPath === 'string' ? o.helperPath : '';
  if (typeof o.provider !== 'string' || o.provider === '') {
    return Promise.resolve(noCatalog('no provider was named'));
  }
  const provider = o.provider as ProviderId;
  // The directory becomes an ARGUMENT of the helper; one that is not a path (it could read as
  // an option) is not passed. Not cached: nothing was asked.
  if (!path.isAbsolute(configDir)) {
    return Promise.resolve(noCatalog('the account directory is not an absolute path'));
  }
  if (!path.isAbsolute(helperPath) || statFileSafe(helperPath) === undefined) {
    return Promise.resolve(
      noCatalog('the provider helper (provider-cli.js) was not found — the extension is not fully built'),
    );
  }
  const key = modelCatalogKey(provider, configDir);
  const cached = modelCatalogs.get(key);
  if (isCatalogFresh(cached, Date.now())) {
    return Promise.resolve(cached);
  }
  const budgetMs =
    typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
      ? Math.min(PROVIDER_MODELS_BUDGET_MAX_MS, Math.max(PROVIDER_MODELS_BUDGET_MIN_MS, Math.round(o.timeoutMs)))
      : PROVIDER_MODELS_BUDGET_MAX_MS;
  const runKey = `${key}\u0000${budgetMs}`;
  const running = modelCatalogRuns.get(runKey);
  if (running !== undefined) {
    return running;
  }
  // The budget is the LAST argument: the helper reads it there and nowhere else.
  const run = runHelperProcess(helperPath, ['models', provider, configDir, `--budget-ms=${budgetMs}`], {
    timeoutMs: budgetMs + PROVIDER_MODELS_GRACE_MS,
    stdoutMaxBytes: PROVIDER_MODELS_STDOUT_MAX_BYTES,
    stdoutKeepChars: PROVIDER_MODELS_STDOUT_MAX_BYTES,
  })
    .then((ended): ProviderModelCatalog => {
      if (ended.kind === 'failed') {
        return noCatalog(ended.error);
      }
      if (ended.kind === 'timeout') {
        return noCatalog('timeout — the provider helper did not answer in time');
      }
      if (ended.code !== 0) {
        const how = ended.signal !== null ? `was ended by ${ended.signal}` : `exited with code ${String(ended.code)}`;
        return noCatalog(`the provider helper ${how} without a model list`);
      }
      return parseModelCatalog(provider, ended.out);
    })
    .catch((): ProviderModelCatalog => noCatalog('the provider helper could not be run'))
    .then((catalog) => {
      modelCatalogRuns.delete(runKey);
      modelCatalogs.delete(key);
      modelCatalogs.set(key, catalog);
      // Insertion order is age order; the oldest answer goes first.
      while (modelCatalogs.size > PROVIDER_MODELS_CACHE_MAX) {
        const oldest = modelCatalogs.keys().next();
        if (oldest.done) {
          break;
        }
        modelCatalogs.delete(oldest.value);
      }
      return catalog;
    });
  modelCatalogRuns.set(runKey, run);
  return run;
}
