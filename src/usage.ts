import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDirs, readRegistry, ROOT_DIR } from './registry';

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
   * Set ONLY when the probe itself failed (timeout, spawn error, non-success
   * control_response, unparseable output). Distinct from available:false, which
   * is a valid state meaning "this account has no plan rate limits" (e.g. a
   * setup-token / non-subscription login). Callers must treat
   * error===undefined && available===false as "no limits", NOT as a failure.
   */
  error?: string;
}

export const USAGE_CACHE_FILE = path.join(ROOT_DIR, 'usage.json');

/** Default probe timeout. get_usage returns in ~1-2s; 20s is a generous ceiling. */
const PROBE_TIMEOUT_MS = 20_000;

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

    let claudePath = 'claude';
    try {
      claudePath = readRegistry().claudePath || 'claude';
    } catch {
      // registry unreadable — fall back to bare command
    }

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

function writeUsageCache(cache: UsageCache): void {
  ensureDirs();
  // Atomic write: the extension host and the MCP server both refresh the same
  // file. tmp+rename prevents a concurrent reader from seeing a torn/truncated
  // file and prevents two writers from interleaving. Per-pid tmp avoids collision.
  const tmp = `${USAGE_CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, USAGE_CACHE_FILE);
}

/** How long a good windows reading is carried forward once upstream stops returning windows. */
const STALE_WINDOW_MAX_MS = 30 * 60 * 1000;

/**
 * get_usage intermittently returns `rate_limits: null` while `rate_limits_available`
 * stays true — a fresh but empty reading. Rather than blank the UI, carry the last
 * good windows (and the overage state that vanishes with them) forward, marked
 * stale, for up to STALE_WINDOW_MAX_MS. After that we let the account fall to the
 * honest "no windows" state rather than present very old numbers as if current.
 */
export function mergeStaleWindows(fresh: AccountUsage, prev: AccountUsage | undefined): AccountUsage {
  if (fresh.windows.length > 0) {
    return { ...fresh, windowsFetchedAt: fresh.fetchedAt, windowsStale: false };
  }
  // Only paper over the specific "available but no windows, no probe error" gap.
  if (!fresh.available || fresh.error !== undefined) {
    return fresh;
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
      ...fresh,
      windows: prevWindows,
      // extraUsage / subscriptionType disappear together with rate_limits — keep the last known.
      extraUsage: fresh.extraUsage ?? prev!.extraUsage,
      subscriptionType: fresh.subscriptionType ?? prev!.subscriptionType,
      windowsFetchedAt: prevAt,
      windowsStale: true,
    };
  }
  return { ...fresh, windowsStale: false };
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
      results.push(await fetchAccountUsage(a.name, a.configDir, timeoutMs));
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
