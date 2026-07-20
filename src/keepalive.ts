import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDirs, readRegistry, runningTasks, ROOT_DIR } from './registry';
import { exhaustedWindows, listAccounts, readUsageCache, resolveProbeCommand } from './usage';

/**
 * Session keepalive: keep each account's OAuth credentials alive by making one
 * real, minimal API round-trip per account per day.
 *
 * Claude Code rotates a config dir's OAuth token when it is actually used. An
 * account that sits idle for long enough — a worker account the user rarely
 * dispatches to — eventually has its refresh window lapse and the login expires,
 * which is what surfaces as the `rate_limits_available:false` ambiguity this
 * module's sibling code in usage.ts disambiguates. A single cheap haiku prompt is
 * enough to trigger the rotation and reset the clock.
 *
 * COORDINATION IS THE HARD PART. Concurrent token rotations on one config dir are
 * the suspected cause of the very expiry this module exists to prevent, so a naive
 * sweep can CAUSE the failure it guards against. Four mechanisms keep that from
 * happening, and none of them is optional:
 *
 *  - In-flight guard: one sweep at a time per process, released in a finally.
 *  - Claim before ping: the attempt stamp is written BEFORE the child is spawned,
 *    not after it succeeds, and the stamp file is re-read immediately before each
 *    claim. Several editor hosts share one stamp file, so a host that claims an
 *    account is visible to the others before its ping is anywhere near finished.
 *  - Skip busy accounts: an account with a live dispatch is already authenticating
 *    under that config dir. Pinging it is precisely the concurrent-rotation hazard.
 *  - Sequential pings: the sweep never fans out across accounts.
 *
 * Failed pings are throttled separately from successful ones
 * (KEEPALIVE_ATTEMPT_INTERVAL_MS), so an account that cannot be pinged at all
 * retries a few times a day rather than on every hourly tick forever.
 *
 * Must not import 'vscode': this module is unit-tested standalone and shares the
 * esbuild bundle with the MCP dispatch server. Node + registry/usage only.
 */

/**
 * Minimum gap between SUCCESSFUL pings for a single account. One round-trip per day
 * is far inside any plausible refresh window while costing a negligible number of
 * tokens.
 */
export const KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between ATTEMPTS for a single account, successful or not. Without a
 * separate attempt gate an account whose ping always fails (offline, revoked
 * credentials, a broken claudePath) would be retried on every hourly tick forever,
 * spawning a doomed child each time; the success stamp never advances, so the 24h
 * gate never closes. Six hours still gives a transient failure several chances a day.
 */
export const KEEPALIVE_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often the caller (extension.ts wires the setInterval and the
 * `sessionKeepalive` setting) should run a sweep. Sweeping hourly rather than
 * daily means an editor that is only open for part of the day still gets a chance
 * to service an account whose 24h gap elapsed while it was closed — the per-account
 * intervals above are what actually rate-limit the pings.
 */
export const KEEPALIVE_TICK_MS = 60 * 60 * 1000;

/** Per-config-dir ping stamps, epoch ms. Lives beside the registry. */
export const KEEPALIVE_FILE = path.join(ROOT_DIR, 'keepalive.json');

/**
 * Attempt and success timestamps for one config dir, epoch ms.
 *
 * They are tracked separately because they gate different things: `lastSuccessAt`
 * answers "has this account been kept alive recently", while `lastAttemptAt`
 * answers "is another host already pinging it / has this one failed too recently to
 * be worth retrying". A field is NaN when the stamp file carries no usable value
 * for it, which every gate reads as "no evidence" and therefore as due.
 */
export interface KeepaliveStamp {
  lastAttemptAt: number;
  lastSuccessAt: number;
}

export type KeepaliveStamps = Record<string, KeepaliveStamp>;

/** Finite numbers pass through; everything else becomes NaN ("no evidence"). */
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : NaN);

/**
 * Read the stamp file, degrading to {} for anything unreadable.
 *
 * Two on-disk shapes are accepted. A v1 entry is a bare number — the old
 * last-successful-ping stamp — and is read as both attempt and success at that
 * instant, which is exactly what it meant. A v2 entry is an object carrying the two
 * fields; each is read defensively and degrades to NaN on its own, and an entry
 * where NEITHER field survives is dropped as malformed.
 *
 * Dropping rather than passing through matters because the file is hand-editable
 * and written by other editor hosts: a bogus stamp must not be able to masquerade
 * as a recent ping and suppress the keepalive forever. A dropped entry simply reads
 * as "never pinged", whose only cost is one extra cheap round-trip.
 */
export function readKeepaliveStamps(): KeepaliveStamps {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(KEEPALIVE_FILE, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: KeepaliveStamps = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number') {
      // v1: a bare number was the last SUCCESSFUL ping, which was also an attempt.
      const at = num(value);
      if (!isNaN(at)) {
        out[key] = { lastAttemptAt: at, lastSuccessAt: at };
      }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const o = value as Record<string, unknown>;
    const stamp: KeepaliveStamp = {
      lastAttemptAt: num(o.lastAttemptAt),
      lastSuccessAt: num(o.lastSuccessAt),
    };
    if (isNaN(stamp.lastAttemptAt) && isNaN(stamp.lastSuccessAt)) {
      continue; // malformed — treated as absent
    }
    out[key] = stamp;
  }
  return out;
}

/**
 * Merge two stamp snapshots, newest value per FIELD per config dir wins. Pure
 * (exported for tests). Per-field rather than per-entry because the two fields are
 * written at different moments and by different processes: a claim writes only
 * `lastAttemptAt` and a success writes only `lastSuccessAt`, so merging whole
 * entries would let either write erase the other's field. A NaN field carries no
 * information and therefore never displaces a real value.
 *
 * Keys present only in `disk` are KEPT — another editor process may track accounts
 * this one does not, and dropping them would make that process re-ping accounts it
 * already serviced.
 */
export function mergeKeepaliveStamps(disk: KeepaliveStamps, fresh: KeepaliveStamps): KeepaliveStamps {
  const newest = (a: number | undefined, b: number | undefined): number => {
    const av = num(a);
    const bv = num(b);
    if (isNaN(av)) {
      return bv;
    }
    if (isNaN(bv)) {
      return av;
    }
    return av >= bv ? av : bv;
  };
  const out: KeepaliveStamps = { ...disk };
  for (const [key, value] of Object.entries(fresh)) {
    const existing = out[key];
    out[key] = {
      lastAttemptAt: newest(value.lastAttemptAt, existing?.lastAttemptAt),
      lastSuccessAt: newest(value.lastSuccessAt, existing?.lastSuccessAt),
    };
  }
  return out;
}

/**
 * Write one config dir's stamp fields. Re-reads the on-disk file and merges
 * immediately before writing, then writes via tmp+rename: several editor hosts
 * share this one file, so a blind overwrite would drop another process's stamps and
 * the atomic rename keeps a concurrent reader from seeing a torn file. Pass NaN for
 * a field this write is not claiming — the merge leaves whatever is already on disk.
 *
 * Best-effort — a failed write only costs a redundant ping next sweep, so it is
 * never raised to the caller.
 */
function recordStamp(configDir: string, stamp: KeepaliveStamp): void {
  try {
    ensureDirs();
    const merged = mergeKeepaliveStamps(readKeepaliveStamps(), { [configDir]: stamp });
    const tmp = `${KEEPALIVE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, KEEPALIVE_FILE);
  } catch {
    // disk full / read-only — the stamp is a throttle, not state we depend on
  }
}

/**
 * Whether an account is due for a ping. Pure (exported for tests).
 *
 * BOTH gates must pass: it has been at least KEEPALIVE_INTERVAL_MS since the last
 * success AND at least KEEPALIVE_ATTEMPT_INTERVAL_MS since the last attempt. The
 * success gate is what the keepalive is for; the attempt gate is what stops a
 * failing account from being retried every tick and what makes another host's
 * in-progress claim visible — that host writes `lastAttemptAt` before it spawns.
 *
 * Within each gate, an absent, NaN or non-finite stamp counts as due — we have no
 * evidence of a recent ping. A stamp in the FUTURE also counts as due, matching
 * isCacheFresh's treatment of clock skew: a timestamp we cannot verify must not be
 * able to suppress the keepalive indefinitely, and one wasted round-trip is far
 * cheaper than a silently expired login.
 */
export function shouldPing(stamp: KeepaliveStamp | undefined, nowMs: number): boolean {
  if (stamp === undefined) {
    return true;
  }
  const due = (at: number, intervalMs: number): boolean => {
    if (typeof at !== 'number' || !isFinite(at)) {
      return true;
    }
    if (at > nowMs) {
      return true;
    }
    return nowMs - at >= intervalMs;
  };
  return (
    due(stamp.lastSuccessAt, KEEPALIVE_INTERVAL_MS) &&
    due(stamp.lastAttemptAt, KEEPALIVE_ATTEMPT_INTERVAL_MS)
  );
}

/**
 * Make one real API round-trip under `configDir`, purely so the CLI rotates that
 * account's OAuth token. The prompt is trivial and the model is the cheapest
 * available, because the response is discarded — only the fact that the request
 * completed matters.
 *
 * Resolves true iff the process exited 0; resolves false on spawn error, non-zero
 * exit, or timeout. Never rejects. stdio is fully ignored so no pipe can fill and
 * stall the child. A neutral cwd (os.tmpdir()) is REQUIRED so no project
 * `.mcp.json` is loaded, which would spawn this extension's own dispatch server.
 */
export function pingAccount(claudePath: string, configDir: string, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(claudePath, ['-p', 'Reply with exactly: OK', '--model', 'haiku'], {
        cwd: os.tmpdir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdio: 'ignore',
      });
    } catch {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve(false);
      return;
    }

    let settled = false;
    const done = (ok: boolean) => {
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
      resolve(ok);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Config dirs with a dispatch running right now. A running worker session is
 * already authenticating under its config dir, so a keepalive ping there is exactly
 * the concurrent token rotation this module must not cause.
 *
 * The task log's `worker` field can hold several comma-joined names (renameWorker
 * remaps them token-wise), so each token is mapped to a config dir independently.
 * Best-effort: an unreadable registry or task log yields an empty set, which only
 * means the busy check does not fire — the other guards still apply.
 */
function busyConfigDirs(): Set<string> {
  const dirs = new Set<string>();
  try {
    const byName = new Map<string, string>();
    for (const w of readRegistry().workers) {
      if (typeof w.name === 'string' && typeof w.configDir === 'string') {
        byName.set(w.name, w.configDir);
      }
    }
    for (const task of runningTasks()) {
      if (typeof task.worker !== 'string') {
        continue;
      }
      for (const token of task.worker.split(',')) {
        const dir = byName.get(token.trim());
        if (dir !== undefined) {
          dirs.add(dir);
        }
      }
    }
  } catch {
    // registry / task log unreadable — no busy accounts known
  }
  return dirs;
}

/**
 * True while a sweep is running in THIS process. Sweeps are started by an hourly
 * timer and by a startup timer, and a sweep can outlive its tick (each ping allows
 * up to two minutes), so overlapping runs are a real possibility — and two
 * overlapping sweeps would ping the same account twice concurrently.
 */
let sweepInFlight = false;

/**
 * Ping every account that is both due and worth pinging. Never throws.
 *
 * An account is eligible only when its cached usage reading proves it is a healthy
 * subscription login — the entry exists, the probe did not error, plan limits are
 * exposed, and no window is currently exhausted — and its stamps say it is due.
 * Each exclusion is deliberate:
 *
 *  - no entry / probe error: we know nothing about the account, so we do not spend
 *    a request guessing.
 *  - available !== true: an expired login cannot be revived by a ping (it would
 *    just fail), and a token account has no OAuth token to rotate. Both are noise.
 *  - an exhausted window: the account is at its plan limit, where a request may be
 *    billed as overage. A keepalive must never be the thing that spends money.
 *  - a running dispatch on that config dir: the worker session is authenticating
 *    under it already, and a simultaneous ping is the concurrent rotation that
 *    causes the expiry this module is meant to prevent.
 *  - the 'main' account, ALWAYS: the orchestrator's own login is the one the user
 *    actually works with all day, so its token is kept fresh by real usage. A ping
 *    adds rotation risk — the user's own session may be mid-request — for no
 *    benefit whatsoever.
 *
 * Registry workers may share a config dir, so the sweep iterates UNIQUE config dirs
 * (first account naming a dir wins); pinging one account twice under two labels
 * would be the same double rotation.
 *
 * Pings run STRICTLY SEQUENTIALLY, and the stamp file is re-read immediately before
 * each account rather than snapshotted once, so a claim another host wrote while
 * this sweep was mid-ping is honored. The attempt stamp is written BEFORE the ping
 * is spawned — a host that only stamped afterwards would leave a window minutes
 * wide in which every other host sees the account as untouched and pings it too.
 * The success stamp is written only after a SUCCESSFUL ping, so a failure retries
 * on the attempt interval rather than silently counting as done.
 */
export async function runKeepaliveSweep(nowMs = Date.now()): Promise<void> {
  if (sweepInFlight) {
    return;
  }
  sweepInFlight = true;
  try {
    const claudePath = resolveProbeCommand(nowMs);

    const cache = readUsageCache();
    const busy = busyConfigDirs();
    const seen = new Set<string>();

    for (const account of listAccounts()) {
      try {
        if (seen.has(account.configDir)) {
          continue; // another account already covered this config dir
        }
        seen.add(account.configDir);
        if (account.name === 'main') {
          continue;
        }
        if (busy.has(account.configDir)) {
          continue;
        }
        const entry = cache[account.configDir];
        if (
          entry === undefined ||
          entry.error !== undefined ||
          entry.available !== true ||
          exhaustedWindows(entry, nowMs).length > 0
        ) {
          continue;
        }
        // Re-read per account: an earlier ping in this same sweep took minutes, and
        // another host may have claimed this account in the meantime.
        if (!shouldPing(readKeepaliveStamps()[account.configDir], nowMs)) {
          continue;
        }
        // Claim first, spawn second.
        recordStamp(account.configDir, { lastAttemptAt: Date.now(), lastSuccessAt: NaN });
        if (await pingAccount(claudePath, account.configDir)) {
          recordStamp(account.configDir, { lastAttemptAt: NaN, lastSuccessAt: Date.now() });
        }
      } catch {
        // one bad account must not abort the sweep of the remaining ones
      }
    }
  } catch {
    // listAccounts / cache read failed — a skipped sweep is retried next tick
  } finally {
    sweepInFlight = false;
  }
}
