import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDirs, isSpawnableFile, readRegistry, resolveViaLoginShell, ROOT_DIR } from './registry';

/**
 * Live account usage via the Claude Code control protocol `get_usage` request.
 *
 * A short-lived `claude` process is spawned in stream-json mode under a target
 * CLAUDE_CONFIG_DIR; a single control_request {subtype:"get_usage"} returns the
 * same structured /usage data the interactive `/usage` command shows — session
 * cost totals plus claude.ai plan rate-limit utilization/reset "when available".
 * No credentials are read or handled here: Claude Code authenticates itself
 * under the given config dir (mirrors how workers are dispatched).
 *
 * UPSTREAM IS EXPERIMENTAL. The get_usage response is documented as "the
 * response shape may change", so every field is read defensively and any parse
 * gap degrades to `available:false` rather than throwing. This module never
 * rejects and never throws to its callers — every path resolves an AccountUsage.
 *
 * Must not import 'vscode': src/mcp/server.ts imports this module and is bundled
 * (esbuild) into the standalone dispatch server. Node + registry only.
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
   * affordance recovers the address from `<configDir>/.claude.json` itself, via
   * readOauthEmail, on the user-initiated terminal path. This field is NOT a
   * fallback source and deliberately does no disk I/O: it is populated on the hot
   * refresh path, which must not read a multi-megabyte file per account.
   */
  email: string | null;
  /** Epoch ms when this auth reading was taken. */
  checkedAt: number;
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
   * Read it through parseAuth (the cache file is hand-editable).
   */
  auth?: AuthStatus;
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

/** The accounts a usage view covers: the orchestrator's own dir ('main') plus every worker. */
export function listAccounts(): { name: string; configDir: string }[] {
  const mainDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const accounts = [{ name: 'main', configDir: mainDir }];
  for (const w of readRegistry().workers) {
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
 * Probe one account. Resolves an AccountUsage in every case — never rejects.
 * A neutral cwd (os.tmpdir()) is REQUIRED so no project `.mcp.json` is loaded,
 * which would otherwise spawn this extension's own dispatch server per probe.
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
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
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

    const done = (result: AccountUsage) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve({ ...result, fetchedAt: Date.now() });
    };

    const timer = setTimeout(() => done({ ...base, error: 'timeout' }), timeoutMs);

    const sendRequest = () => {
      if (sent) {
        return;
      }
      sent = true;
      try {
        child.stdin.write(
          JSON.stringify({ type: 'control_request', request_id: 'u1', request: { subtype: 'get_usage' } }) + '\n',
        );
      } catch {
        // stdin closed — the close handler will settle with an error
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
      const resp = (msg.response ?? {}) as Record<string, unknown>;
      if (resp.subtype !== 'success') {
        done({ ...base, error: `control_response ${String(resp.subtype ?? 'error')}` });
        return;
      }
      const data = (resp.response ?? {}) as Record<string, unknown>;
      const session = (data.session ?? {}) as Record<string, unknown>;
      done({
        ...base,
        available: data.rate_limits_available === true,
        subscriptionType: typeof data.subscription_type === 'string' ? data.subscription_type : null,
        windows: parseWindows(data),
        sessionCostUsd: typeof session.total_cost_usd === 'number' ? session.total_cost_usd : null,
        extraUsage: parseExtraUsage(data),
      });
    };

    child.stdout.on('data', (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(sendTimer);
      done({ ...base, error: `spawn failed: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(sendTimer);
      done({ ...base, error: stderr.trim() ? `claude exited: ${stderr.slice(0, 200)}` : 'no response' });
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
 * from `<configDir>/.claude.json`, a hand-editable file, and callers interpolate it
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
 * Upper bound on the .claude.json we are willing to read. Real files hold project
 * history and reach a few MB legitimately, so 8MB clears any genuine file with room
 * to spare; a pathological (or hand-crafted) one must not be slurped into memory
 * just to recover an email, so anything past this ceiling degrades to null like any
 * other unreadable file.
 */
const OAUTH_ACCOUNT_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Recover the account email from `<configDir>/.claude.json`'s
 * `oauthAccount.emailAddress`. This is the ONLY place the email survives an
 * expired login: `claude auth status --json` drops the field entirely once
 * `loggedIn` goes false, which is exactly when we need it to tell the user which
 * account to sign back in to.
 *
 * Called ONLY from the user-initiated re-login path, never from the periodic usage
 * refresh: it is synchronous disk I/O on a file that can reach megabytes, which the
 * extension host's main thread must not do once per account every few minutes.
 *
 * The file is hand-editable and may be missing, huge, truncated or hold any shape
 * at all, so every step degrades to null and nothing throws. The result is passed
 * through sanitizeEmailForShell, so a caller can interpolate it safely.
 */
export function readOauthEmail(configDir: string): string | null {
  try {
    const file = path.join(configDir, '.claude.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > OAUTH_ACCOUNT_FILE_MAX_BYTES) {
      return null;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const account = (raw as Record<string, unknown>).oauthAccount;
    if (!account || typeof account !== 'object') {
      return null;
    }
    const email = (account as Record<string, unknown>).emailAddress;
    return typeof email === 'string' ? sanitizeEmailForShell(email) : null;
  } catch {
    // missing dir/file, unreadable, or not JSON — the email is simply unknown
    return null;
  }
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
  return new Promise((resolve) => {
    const claudePath = resolveProbeCommand();

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(claudePath, ['auth', 'status', '--json'], {
        cwd: os.tmpdir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve(undefined);
      return;
    }

    let settled = false;
    let out = '';

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
      // the address itself via readOauthEmail when the user actually asks for it.
      return {
        loggedIn: o.loggedIn,
        method: typeof o.authMethod === 'string' ? o.authMethod : null,
        email: typeof o.email === 'string' && o.email !== '' ? o.email : null,
        checkedAt: Date.now(),
      };
    };

    const done = (status: AuthStatus | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(status);
    };

    // A CLI that hangs after printing its JSON still gives us a usable answer, so
    // the timeout parses what arrived rather than discarding it outright.
    const timer = setTimeout(() => done(parseCollected()), timeoutMs);

    // Decode as UTF-8 on the stream itself: concatenating raw Buffers would let a
    // multi-byte character straddling two chunks decode into replacement chars and
    // corrupt the JSON. Capping after the append keeps `out` bounded even when one
    // chunk alone exceeds the ceiling.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out = (out + d).slice(0, AUTH_STDOUT_MAX_CHARS);
    });
    // stderr must be drained or a chatty CLI blocks on a full pipe; its content is
    // irrelevant here since an unparseable probe is already "unknown".
    child.stderr.on('data', () => undefined);
    child.on('error', () => done(undefined));
    child.on('close', () => done(parseCollected()));
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
  return {
    loggedIn: o.loggedIn,
    method: typeof o.method === 'string' ? o.method : null,
    email: typeof o.email === 'string' ? o.email : null,
    checkedAt: typeof o.checkedAt === 'number' && isFinite(o.checkedAt) ? o.checkedAt : 0,
  };
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
 * THE single source of truth for "this account's claude.ai login has expired",
 * shared by the extension UI and the MCP dispatch server so they can never disagree.
 *
 * True only when all of: a reading exists, the probe itself did not fail, the
 * account exposes no plan limits, and the auth probe positively reported
 * `loggedIn:false`. Every other case — no reading, probe error, plan limits
 * present, missing or malformed `auth` — is false, which falls back to today's
 * "no plan limits" behavior. The bias is deliberate: a FALSE "expired" verdict
 * would wrongly block dispatches on a perfectly good account, so an unproven
 * expiry must never be asserted.
 */
export function isLoginExpired(usage: AccountUsage | undefined): boolean {
  return (
    usage !== undefined &&
    usage.error === undefined &&
    usage.available !== true &&
    parseAuth(usage.auth)?.loggedIn === false
  );
}

export type UsageCache = Record<string, AccountUsage>;

export function readUsageCache(): UsageCache {
  try {
    return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')) as UsageCache;
  } catch {
    return {};
  }
}

/** Cached reading for one config dir, if present. Surfaces read this — they never spawn on render. */
export function getCachedUsage(configDir: string): AccountUsage | undefined {
  return readUsageCache()[configDir];
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
    const d = out[key];
    if (d === undefined || at(f) >= at(d)) {
      out[key] = f;
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
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
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
      if (dir in cache) {
        delete cache[dir];
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    ensureDirs();
    const tmp = `${USAGE_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
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
      if (r.error === undefined && r.available !== true) {
        const prevAuth = prev[a.configDir]?.auth;
        if (shouldReuseAuth(prevAuth, Date.now())) {
          r.auth = parseAuth(prevAuth);
        } else {
          const auth = await fetchAuthStatus(a.configDir, Math.min(AUTH_PROBE_TIMEOUT_MS, timeoutMs));
          if (auth !== undefined) {
            r.auth = auth;
          }
        }
      }
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, runner));
  const merged = results.map((r) => mergeStaleWindows(r, prev[r.configDir]));
  const cache: UsageCache = {};
  for (const r of merged) {
    cache[r.configDir] = r;
  }
  try {
    writeUsageCache(cache);
  } catch {
    // disk full / read-only — return the readings anyway; never reject.
  }
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
    const entry = cache[a.configDir];
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
 * Refresh all accounts ONLY when the shared cache is stale, else return null
 * without probing. This is the cross-process throttle: multiple editor extension
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
  if (isCacheFresh(cache, accounts, Date.now(), maxAgeMs)) {
    return null;
  }
  return refreshAllUsage(accounts, concurrency, timeoutMs);
}
