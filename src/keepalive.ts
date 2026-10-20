import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeEnv, hostConfigDir } from './platform';
import { claudeWorkers, ensureDirs, readRegistry, runningTasksChecked, ROOT_DIR } from './registry';
import { readTextSafe } from './safeFs';
import {
  exhaustedWindows,
  onChildExit,
  ownCacheEntry,
  readUsageCache,
  resolveProbeCommand,
  terminateChild,
} from './usage';

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
 *    The claim is then READ BACK through the same reader, and only a claim that is
 *    on disk as this host wrote it is followed by a request (recordStamp). A stamp
 *    file that cannot take a claim — a directory at its name, a data directory
 *    that is not writable, a full disk — therefore means NO request at all, said
 *    once in the caller's log, rather than a request every hour from every window
 *    that none of the others can see.
 *  - Skip busy accounts: an account with a live dispatch is already authenticating
 *    under that config dir. Pinging it is precisely the concurrent-rotation hazard.
 *  - Sequential pings: the sweep never fans out across accounts.
 *
 * Failed pings are throttled separately from successful ones
 * (KEEPALIVE_ATTEMPT_INTERVAL_MS), so an account that cannot be pinged at all
 * retries a few times a day rather than on every hourly tick forever. Both
 * throttles are the stamp file: they hold only while it can be written, which is
 * the second reason nothing is sent when it cannot.
 *
 * CLAUDE CODE ACCOUNTS ONLY. A ping is a `claude -p` run with CLAUDE_CONFIG_DIR naming
 * the account's directory, and that CLI creates its config files in whatever directory
 * it is given. A registry worker can be an account on another vendor's CLI, whose
 * `configDir` is that vendor's home — pinging it would leave Claude config files inside
 * `~/.codex`, hourly and silently, and rotate nothing. So the sweep's account list is
 * built from registry.claudeWorkers (keepaliveAccounts) and such a worker is never in it.
 *
 * Must not import 'vscode': this module is unit-tested standalone and shares the
 * esbuild bundle with the MCP dispatch server. Node + registry/usage/platform/safeFs only.
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

/** Read ceiling for the stamp file: two numbers per account, so a megabyte is thousands of them. */
const KEEPALIVE_FILE_MAX_BYTES = 1024 * 1024;

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

/**
 * The stamp filed under one config dir, or undefined. An OWN entry only: the stamps are a plain
 * object indexed by a directory string out of the registry, and `stamps['constructor']` on a
 * plain object is an inherited function, not a record of any ping.
 */
function ownStamp(stamps: KeepaliveStamps, configDir: string): KeepaliveStamp | undefined {
  return Object.prototype.hasOwnProperty.call(stamps, configDir) ? stamps[configDir] : undefined;
}

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
  // Through the guarded reader: the file sits in a directory every dispatched worker knows,
  // and a plain read of a pipe put at this name would block the hourly sweep for good — with
  // the in-flight guard held. A symbolic link is not followed either: the stamp file is this
  // module's own, under a name it builds itself.
  const read = readTextSafe(KEEPALIVE_FILE, KEEPALIVE_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
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
    const existing = ownStamp(out, key);
    out[key] = {
      lastAttemptAt: newest(value.lastAttemptAt, existing?.lastAttemptAt),
      lastSuccessAt: newest(value.lastSuccessAt, existing?.lastSuccessAt),
    };
  }
  return out;
}

/**
 * Open flags for the TEMP FILE of the stamp file's atomic write: write-only, create, truncate,
 * NON-BLOCKING, no controlling terminal, NO-FOLLOW.
 *
 * THE FULL RATIONALE FOR EVERY FLAG, FOR THE ABSENCE OF O_EXCL, AND FOR WHY THIS GUARD IS LOCAL
 * RATHER THAN IN safeFs LIVES IN src/registry.ts, ON `TMP_WRITE_GUARDED` AND
 * `writeTempFileGuarded`. Read it there before changing anything here; the one-line version is
 * that safeFs deliberately has no truncating write, because its discipline is "prove it is a
 * regular file BEFORE you touch it" and an O_TRUNC open cannot honour that ordering — truncation
 * happens in the open. The copy is local rather than imported because those two are private to
 * registry.ts and this module must not grow its surface for a four-line helper.
 *
 * WHY THIS SITE IS WORTH GUARDING despite being best-effort: `keepalive.json` sits in ROOT_DIR,
 * whose location every worker is told, and the temp name adds only the writing process's pid. The
 * sweep that reaches this line runs on the extension host's hourly timer, and a blocking open here
 * would hang that timer's callback — and with it the in-flight guard it holds — permanently.
 */
const TMP_WRITE_GUARDED =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

/** What the thing at a temp path actually is, for a refusal reason. Literals only. */
function tempPathKind(st: fs.Stats): string {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  if (st.isCharacterDevice()) {
    return 'a character device';
  }
  if (st.isBlockDevice()) {
    return 'a block device';
  }
  return 'something other than a regular file';
}

/**
 * Write `data` to the stamp file's temp path. Returns undefined on success, or a short reason on
 * refusal. NEVER THROWS and never blocks. Mirror of `registry.writeTempFileGuarded` — see that
 * function for why the fstat is on the fd we opened rather than on the name, why a refusal clears
 * the temp name, and what residual the separate rename syscall leaves.
 */
function writeTempFileGuarded(tmp: string, data: string): string | undefined {
  let fd = -1;
  // Initialised to the generic reason so no path below can fall through as a silent success.
  let reason: string | undefined = 'the temp file could not be opened or written';
  try {
    // 0o666, umask-masked by the kernel — exactly the mode `writeFileSync` created with.
    fd = fs.openSync(tmp, TMP_WRITE_GUARDED, 0o666);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      reason = `the temp path is ${tempPathKind(st)}`;
    } else {
      const buf = Buffer.from(data, 'utf8');
      let written = 0;
      // Loop on short writes: a single-call writer truncates the payload silently, which here
      // means a half stamp file renamed into place and every account reading as never pinged.
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) {
          break;
        }
        written += n;
      }
      reason =
        written < buf.length
          ? `only ${written} of ${buf.length} bytes could be written`
          : undefined;
    }
  } catch (e) {
    // Only a shape-checked errno code is quoted — a caught value's `code` can be free text that
    // quotes the path (measured: "Unknown system error -102" on macOS for a unix socket).
    const code: unknown = (e as { code?: unknown } | null | undefined)?.code;
    reason =
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
        ? `the temp file could not be opened or written (${code})`
        : 'the temp file could not be opened or written';
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — and a failing close cannot lose bytes written with writeSync
      }
    }
    if (reason !== undefined) {
      // Clear the squatter so the NEXT write self-heals. `unlink` covers a file, a FIFO, a socket,
      // a device node and a symlink; a DIRECTORY needs `rmdir`, and without that fallback a
      // planted directory would be a PERMANENT refusal where a planted FIFO is a one-shot one —
      // measured, not assumed. Both are swallowed and neither is load-bearing: a squatter we
      // cannot remove is still refused, just not self-healed, and a failed cleanup must never
      // replace the real reason with a worse one.
      try {
        fs.unlinkSync(tmp);
      } catch {
        try {
          fs.rmdirSync(tmp);
        } catch {
          // a non-empty directory, or a path this process may not modify — refused either way
        }
      }
    }
  }
  return reason;
}

/** What became of one write of the stamp file (recordStamp). */
type StampWrite =
  /** On disk, and read back with the value this call wrote. */
  | { state: 'recorded' }
  /**
   * Another host got there first: the file as this call found it already held a claim that
   * makes the account not due, or what it holds for the field after this call's write is
   * another value. The file is in order — the account is simply somebody else's this time.
   */
  | { state: 'superseded' }
  /** Not on disk. `reason` is composed of literals and an errno code: no path, no file content. */
  | { state: 'failed'; reason: string };

/** A short, quotable reason for a caught value: its errno code when it has the shape of one. */
function failureReason(err: unknown, what: string): string {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? `${what} (${code})` : what;
}

/** The field of a stamp a write is about: the one it carries a real number for. */
function writtenField(stamp: KeepaliveStamp): 'lastAttemptAt' | 'lastSuccessAt' {
  return isNaN(num(stamp.lastAttemptAt)) ? 'lastSuccessAt' : 'lastAttemptAt';
}

/**
 * Write one config dir's stamp fields, and say whether they are ON DISK afterwards.
 *
 * Re-reads the on-disk file and merges immediately before writing, then writes via tmp+rename:
 * several editor hosts share this one file, so a blind overwrite would drop another process's
 * stamps and the atomic rename keeps a concurrent reader from seeing a torn file. Pass NaN for
 * a field this write is not claiming — the merge leaves whatever is already on disk.
 *
 * The ONE field this call writes is written as given, whatever the file held for it. The
 * merge keeps the newest value per field, which is right between hosts and wrong for a value
 * that lies in the future (a clock that was set back, a hand edit): shouldPing reads such a
 * stamp as "due", so kept, it would have the account pinged on every tick for as long as the
 * file held it. Written over, it is gone after the first ping.
 *
 * THE RESULT IS READ BACK, through readKeepaliveStamps — the reader every host's sweep uses —
 * and that is what the answer is: `recorded` only when the file now holds, for this config
 * dir, the value this call wrote. A write that looked fine and left nothing a reader can see
 * (the rename replaced nothing, the name is not a file this module reads) is `failed`, exactly
 * like one that threw. The caller sends a request only on `recorded`: the stamp is a claim the
 * other hosts must be able to see and a throttle the next tick must be able to read, and a
 * stamp that is not on disk is neither.
 *
 * `stillDue`, given for a CLAIM, is asked about the stamp this call itself has just read from
 * disk, before anything is written: when another host's claim is already there, nothing is
 * written over it and the answer is `superseded`. That puts the check and the write on one
 * reading of the file.
 *
 * NOT A LOCK. Two hosts that both read the file before either has renamed its own copy into
 * place each write a claim (the later rename replaces the earlier), and the later one reads
 * back its own; if the earlier one read back before that, both send a request. The window is
 * one host's read-to-rename, a few file operations long; closing it would take a lock around
 * the claim, which this file does not have.
 *
 * A refused temp write leaves no file behind (writeTempFileGuarded clears the temp name), and
 * a rename that failed removes the temp file it could not move. A DIRECTORY at the stamp
 * file's own name is not removed: nothing here made it, and it is reported instead. Never
 * throws.
 */
function recordStamp(
  configDir: string,
  stamp: KeepaliveStamp,
  stillDue?: (onDisk: KeepaliveStamp | undefined) => boolean,
): StampWrite {
  const tmp = `${KEEPALIVE_FILE}.${process.pid}.tmp`;
  const field = writtenField(stamp);
  const wrote = num(stamp[field]);
  if (isNaN(wrote)) {
    return { state: 'failed', reason: 'the stamp to write holds no time' };
  }
  try {
    ensureDirs();
    const disk = readKeepaliveStamps();
    if (stillDue !== undefined && !stillDue(ownStamp(disk, configDir))) {
      return { state: 'superseded' };
    }
    const merged = mergeKeepaliveStamps(disk, { [configDir]: stamp });
    merged[configDir] = { ...merged[configDir], [field]: wrote };
    // The rename is made only after a temp write that succeeded: `rename` moves whatever the
    // temp NAME refers to, so renaming after a refused write could put a pipe at
    // `keepalive.json`, which no reader of it would ever read again.
    const refused = writeTempFileGuarded(tmp, JSON.stringify(merged, null, 2));
    if (refused !== undefined) {
      return { state: 'failed', reason: refused };
    }
    try {
      fs.renameSync(tmp, KEEPALIVE_FILE);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ours, and harmless: the next write truncates it
      }
      let isDirectory = false;
      try {
        isDirectory = fs.lstatSync(KEEPALIVE_FILE).isDirectory();
      } catch {
        // whatever is there cannot be examined; the errno below says what the rename met
      }
      return {
        state: 'failed',
        reason: failureReason(
          err,
          isDirectory
            ? 'a directory is at the stamp file\'s name and was left as it is'
            : 'the stamp file could not be replaced',
        ),
      };
    }
  } catch (err) {
    return { state: 'failed', reason: failureReason(err, 'the stamp file could not be written') };
  }
  const onDisk = num(ownStamp(readKeepaliveStamps(), configDir)?.[field]);
  if (onDisk === wrote) {
    return { state: 'recorded' };
  }
  // Some other value is there: another host's write, made after ours. No value at all means
  // the file a reader finds at this name is not the one that was just written.
  return !isNaN(onDisk)
    ? { state: 'superseded' }
    : { state: 'failed', reason: 'the stamp was written but could not be read back' };
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
 *
 * A ping that overruns its timeout is ENDED, not killed: SIGTERM first, SIGKILL only if it
 * is still there two seconds later (usage.terminateChild). A SIGKILLed `claude -p` leaves its
 * session files behind in `<configDir>/sessions/`, and this module pings the accounts that
 * are otherwise idle — exactly the directories nobody would notice filling up. The promise
 * resolves false at the timeout itself and does not wait for the child to finish leaving.
 */
export function pingAccount(claudePath: string, configDir: string, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(claudePath, ['-p', 'Reply with exactly: OK', '--model', 'haiku'], {
        cwd: os.tmpdir(),
        env: claudeEnv(configDir),
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
      resolve(ok);
      // A no-op when the child exited by itself, which is every path but the timeout.
      terminateChild(child, 'signal');
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    child.on('error', () => done(false));
    // Settled on 'exit' like every other `claude` child (usage.onChildExit). With stdio ignored
    // there is no pipe to drain, so the exit code is acted on at once.
    onChildExit(child, (code) => done(code === 0));
  });
}

/** One account a sweep may ping: a registry name and the config dir its login lives in. */
interface KeepaliveAccount {
  name: string;
  configDir: string;
}

/**
 * The accounts a sweep considers: this installation's CLAUDE CODE worker accounts, in
 * registry order. THE one enumeration in this module — the ping loop and the busy-dir map
 * below are both fed from the list this returns, so neither can see an account the other
 * cannot.
 *
 * Through registry.claudeWorkers, which is the single definition of "a Claude Code
 * account": a worker on another vendor's CLI is not skipped ping by ping, it is never
 * listed (see the module header for what a ping would do to its directory).
 *
 * Two kinds of Claude Code entry are left out as well, and both are the hosting account
 * under another label: a worker whose config dir IS the host's (the same login the
 * orchestrator session runs under), and an entry named 'main' (a reserved name; only a
 * hand-edited registry holds one). The hosting account is never pinged — see
 * runKeepaliveSweep — so neither is a worker pointing at it.
 *
 * `configDir` is the registry's own string, VERBATIM: it is the key the usage cache and the
 * stamp file are filed under, and what platform.claudeEnv derives the child's environment
 * from.
 */
function keepaliveAccounts(): KeepaliveAccount[] {
  const hostDir = hostConfigDir();
  return claudeWorkers(readRegistry())
    .filter((w) => w.name !== 'main' && w.configDir !== hostDir)
    .map((w) => ({ name: w.name, configDir: w.configDir }));
}

/**
 * Config dirs, among `accounts`, with a dispatch running right now. A running worker
 * session is already authenticating under its config dir, so a keepalive ping there is
 * exactly the concurrent token rotation this module must not cause.
 *
 * The task log's `worker` field can hold several comma-joined names (renameWorker
 * remaps them token-wise), so each token is mapped to a config dir independently — and so is
 * the WHOLE value: a registry written before names were checked can hold an account whose
 * name has a comma in it, and for that account the value is one name. Which of the two a
 * given line means cannot be told, so both readings count as busy; that is the side on which
 * no ping is sent. A name that is not one of `accounts` maps to nothing: a task running on
 * another vendor's worker says nothing about any Claude login, and its directory is none of
 * this module's business.
 *
 * UNDEFINED WHEN THE TASK LOG COULD NOT BE READ. An empty set means "nothing is running", and
 * a log that could not be read establishes no such thing: which accounts are busy is then
 * unknown, and the caller must not ping on the strength of it (runKeepaliveSweep skips the
 * sweep). A log that does not exist is a different answer — nothing was ever dispatched — and
 * reads as the empty set.
 */
function busyConfigDirs(accounts: readonly KeepaliveAccount[]): Set<string> | undefined {
  const dirs = new Set<string>();
  try {
    const byName = new Map<string, string>();
    for (const account of accounts) {
      byName.set(account.name, account.configDir);
    }
    const running = runningTasksChecked();
    if (running.unreadable) {
      return undefined;
    }
    for (const task of running.tasks) {
      if (typeof task.worker !== 'string') {
        continue;
      }
      for (const name of [task.worker, ...task.worker.split(',').map((token) => token.trim())]) {
        const dir = byName.get(name);
        if (dir !== undefined) {
          dirs.add(dir);
        }
      }
    }
  } catch {
    // the reader is documented never to throw; if it did, what is running is not known either
    return undefined;
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
 * Why the stamp file could not be written, while it cannot — the reason of the failing streak
 * that is running, undefined otherwise. It is what makes the explanation a line per STREAK:
 * the sweep runs every hour, and a stamp file that stays unwritable would otherwise say so
 * every hour for as long as the editor is open.
 */
let stampFailure: string | undefined;

/** Where a sweep reports what it did not do. One line per call; never throws into the sweep. */
export type KeepaliveLog = (line: string) => void;

/** Hand `line` to the caller's log, whatever that log does with it. */
function say(log: KeepaliveLog | undefined, line: string): void {
  if (typeof log !== 'function') {
    return;
  }
  try {
    log(line);
  } catch {
    // a log that cannot take a line must not end the sweep
  }
}

/**
 * Note that the stamp file took a write, or did not, and say so when that is NEWS: the first
 * failure of a streak, with its reason, and the first success after one.
 */
function noteStampWrite(written: StampWrite, log: KeepaliveLog | undefined): void {
  if (written.state !== 'failed') {
    if (stampFailure !== undefined) {
      stampFailure = undefined;
      say(log, `[keep-alive] ${KEEPALIVE_FILE} can be written again; keep-alive requests resume.`);
    }
    return;
  }
  if (stampFailure === undefined) {
    say(
      log,
      `[keep-alive] no keep-alive request is sent: ${KEEPALIVE_FILE} could not take the claim ` +
        `(${written.reason}). The claim is what tells other editor windows that an account is ` +
        'being pinged, and what stops a request from being repeated every hour, so nothing is ' +
        'sent without it. It is tried again at every hourly check; this is said once.',
    );
  }
  stampFailure = written.reason;
}

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
 *    causes the expiry this module is meant to prevent. When the task log cannot be
 *    read, which accounts have one is unknown, and the whole sweep is skipped.
 *  - the 'main' account, ALWAYS: the orchestrator's own login is the one the user
 *    actually works with all day, so its token is kept fresh by real usage. A ping
 *    adds rotation risk — the user's own session may be mid-request — for no
 *    benefit whatsoever. It is not in the account list at all (keepaliveAccounts).
 *  - an account on another vendor's CLI, ALWAYS: it has no Claude login to keep alive,
 *    and `claude` must never be run against its directory. Not in the list either.
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
 *
 * NO CLAIM, NO PING. The attempt stamp has to be on disk as this host wrote it
 * (recordStamp reads it back) before the request is sent. When it is another host's
 * newer claim that is there, the account is theirs and is skipped. When the stamp
 * file could not be written at all, the sweep ENDS: no account can be claimed
 * through a file that takes no claim, so none is pinged, and the reason goes to
 * `log` once per failing streak (noteStampWrite). The next tick tries again.
 */
export async function runKeepaliveSweep(nowMs = Date.now(), log?: KeepaliveLog): Promise<void> {
  if (sweepInFlight) {
    return;
  }
  sweepInFlight = true;
  try {
    const claudePath = resolveProbeCommand(nowMs);

    const cache = readUsageCache();
    // ONE list — Claude Code worker accounts only — feeding both the loop and the busy map.
    const accounts = keepaliveAccounts();
    const busy = busyConfigDirs(accounts);
    if (busy === undefined) {
      // The task log could not be read, so no account is known to be idle. Nothing is pinged:
      // a ping beside a running dispatch is the concurrent rotation this module must not
      // cause, and a skipped sweep is simply tried again at the next tick.
      return;
    }
    const seen = new Set<string>();

    for (const account of accounts) {
      try {
        if (seen.has(account.configDir)) {
          continue; // another account already covered this config dir
        }
        seen.add(account.configDir);
        if (busy.has(account.configDir)) {
          continue;
        }
        // By OWN entry, in both files: a directory named like a member every object has
        // (`constructor`, `__proto__`) must read as "no reading" and "never pinged".
        const entry = ownCacheEntry(cache, account.configDir);
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
        if (!shouldPing(ownStamp(readKeepaliveStamps(), account.configDir), nowMs)) {
          continue;
        }
        // Claim first, spawn second — and only on a claim that is on disk as ours. The claim
        // is made on its own reading of the file: one another host wrote since the look above
        // is seen there, and left standing.
        const claim = recordStamp(
          account.configDir,
          { lastAttemptAt: Date.now(), lastSuccessAt: NaN },
          (onDisk) => shouldPing(onDisk, nowMs),
        );
        noteStampWrite(claim, log);
        if (claim.state === 'failed') {
          break;
        }
        if (claim.state !== 'recorded') {
          continue; // another host claimed this account in the same instant
        }
        if (await pingAccount(claudePath, account.configDir)) {
          // A success that cannot be recorded is not lost for long: the attempt stamp above
          // holds the account back for KEEPALIVE_ATTEMPT_INTERVAL_MS, and it is pinged again then.
          noteStampWrite(
            recordStamp(account.configDir, { lastAttemptAt: NaN, lastSuccessAt: Date.now() }),
            log,
          );
        }
      } catch {
        // one bad account must not abort the sweep of the remaining ones
      }
    }
  } catch {
    // account list / cache read failed — a skipped sweep is retried next tick
  } finally {
    sweepInFlight = false;
  }
}
