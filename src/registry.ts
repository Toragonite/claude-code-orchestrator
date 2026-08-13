import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Shared state between the VS Code extension and the standalone MCP dispatch
 * server (which runs in a separate process, spawned by the Claude Code CLI).
 * Everything lives under ~/.claude-code-orchestrator. This module must not import
 * 'vscode'.
 */

// claude-fable-5 requires the account's plan to include Fable access and
// draws its separate weekly quota — reserve it for design-consult and
// adversarial-review dispatches.
export const WORKER_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5'] as const;
export type WorkerModel = (typeof WORKER_MODELS)[number];

export interface WorkerProfile {
  name: string;
  /** Claude Code config directory holding this account's login (CLAUDE_CONFIG_DIR). */
  configDir: string;
  /** Default model when a dispatch doesn't specify one. */
  model: WorkerModel;
  /**
   * Preferred worker (typically the same account as the main session): wins
   * automatic assignment whenever it isn't busier than the least-busy
   * alternative, so it's favored without being flooded.
   */
  preferred?: boolean;
}

export interface Registry {
  workers: WorkerProfile[];
  /** --permission-mode passed to dispatched workers. */
  permissionMode: string;
  /** Path or name of the claude executable. */
  claudePath: string;
  /** Minutes a worker sits out after a quota/rate-limit error. */
  cooldownMinutes: number;
  /** Minutes a dispatched worker may run before it is terminated. */
  workerTimeoutMinutes: number;
  /**
   * Billing guard over WHICH MODEL may be dispatched: 'block' rejects dispatches
   * of the frontier model (claude-fable-5) at the server with a fall-back hint.
   * Defaults to 'block' because that model may bill per use instead of drawing
   * from the subscription quota.
   *
   * This guard says NOTHING about overage: it does not stop a non-frontier model
   * from billing real money past an exhausted plan window. That is
   * `overageWorkerDispatch`, which is entirely independent of this field.
   */
  frontierWorkerDispatch: 'allow' | 'block';
  /**
   * appName (vscode.env.appName) of the editor whose EXPLICIT setting produced
   * the current `frontierWorkerDispatch` value. Undefined when no editor has
   * explicitly opted in. Used to reconcile the billing guard across editors that
   * share this one registry file — see applyFrontierGuard.
   */
  frontierGuardSetBy?: string;
  /**
   * Billing guard over WHETHER ANY DISPATCH MAY PROCEED past an exhausted plan
   * window: 'block' stops the server assigning work to a quota-exhausted worker
   * even when that account has extra usage (overage) enabled, so dispatch never
   * spends money past a plan window. 'allow' lets such a worker be used as a
   * last resort — those dispatches BILL REAL MONEY against the account's
   * monthly cap. Applies to EVERY model, not just the frontier one, and defaults
   * to 'block'.
   *
   * Independent of `frontierWorkerDispatch`, which only governs which model may
   * be dispatched.
   */
  overageWorkerDispatch: 'allow' | 'block';
  /**
   * appName (vscode.env.appName) of the editor whose EXPLICIT setting produced
   * the current `overageWorkerDispatch` value. Undefined when no editor has
   * explicitly opted in. Used to reconcile the overage guard across editors that
   * share this one registry file — see applyOverageGuard.
   */
  overageGuardSetBy?: string;
  /**
   * Experimental master switch for the v1.4.0 session mesh (the mesh_* MCP tools).
   * 'off' disables every mesh tool; 'on' arms them behind a per-workspace owner lock.
   * Default 'off' — the mesh is an experimental same-machine layer over Claude Code
   * cross-session messaging and must be opted into explicitly. Any value other than the
   * literal 'on' — absent, null, misspelled, hand-edited — reads as the safe 'off'.
   */
  meshMode: 'on' | 'off';
  /**
   * Minutes an attachable worker may sit idle — no in-flight dispatch, no messages, no
   * keep-alive mark — before the server stops it. 0 DISABLES the sweep and is a valid,
   * deliberate value, not an error: the backstop is optional, the cap is not. Default 15,
   * capped at 1440 (a day); a negative or non-numeric value reads as the default rather
   * than as "off", because "-5 minutes" expresses no intention we can honor.
   */
  meshWorkerIdleTimeoutMin: number;
  /**
   * Hard ceiling on simultaneously live attachable workers. A dispatch past the cap is
   * REFUSED, never queued: queueing a batch larger than the cap deadlocks, since the
   * workers that would free the slots are the ones still waiting. Default 8, clamped to
   * 1..64 (0 is clamped up, not treated as "unlimited" — an unlimited cap is the failure
   * mode this setting exists to prevent).
   */
  meshMaxLiveWorkers: number;
  /**
   * Model alias the mesh gateway relay runs under (the gateway does trivial relay turns
   * only, so a small model is the right default). The default duplicates the contract
   * constant MESH_GATEWAY_MODEL_DEFAULT's literal 'haiku' ON PURPOSE: registry.ts must
   * NOT import src/mesh/contract.ts, which already imports ROOT_DIR and WorkerModel from
   * here — importing it back would create a module cycle. A non-string or empty value
   * coerces to that default.
   */
  meshGatewayModel: string;
}

/** Cumulative per-worker usage, tracked from CLI JSON results. */
export interface WorkerStats {
  tasks: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastUsedAt?: number;
  /** Epoch ms until which this worker is skipped (set on quota errors). */
  cooldownUntil?: number;
  lastError?: string;
}

export type StatsFile = Record<string, WorkerStats>;

export interface TaskEvent {
  ts: number;
  id: string;
  status: 'running' | 'done' | 'error';
  title: string;
  worker: string;
  model: string;
  /** Markdown file holding the worker's output. */
  outputFile: string;
  error?: string;
  /** Usage of this run — set on 'done' events; feeds per-window quota views. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Workspace the dispatch ran in (server cwd) — enables per-workspace views. */
  cwd?: string;
  /**
   * First ~300 chars of the dispatched prompt (whitespace-collapsed), so surfaces
   * can show WHAT a task is running without opening its output file. Set on the
   * initial 'running' event and carried on every later event for the task.
   */
  promptPreview?: string;
  /** PID of the worker `claude -p` child. Set on a second 'running' event emitted after spawn. */
  pid?: number;
  /** Process-group id of the worker, recorded only when it was spawned as its own group leader (detached). Present => the whole tree can be signalled with -pgid. */
  pgid?: number;
  /**
   * PID of the detach SUPERVISOR process (out/mcp/run-task.js) that owns this task.
   * Set on a detach task's running/interim events (contract §5.5). The reaper treats
   * the task as alive while EITHER the worker pid OR this supervisor pid is alive-and-
   * ours, which closes the failover-gap window where a detach task briefly has no live
   * worker between attempts. Absent on default (in-process) tasks.
   */
  supervisorPid?: number;
  /**
   * Name of the attachable `claude --bg` worker running this task (Mesh Mode). Such a
   * worker is NOT our child process, so these events deliberately carry no pid/pgid —
   * every signal-based path (cancel, reap, isOurWorker) must no-op on them, and liveness
   * is answered from the mesh ledger instead (see reapDeadTasks' isAliveExternally).
   */
  meshWorker?: string;
}

/** Pre-rename data directory — migrated to ROOT_DIR on first load. */
export const LEGACY_ROOT_DIR = path.join(os.homedir(), '.fable-orchestrator');
export const ROOT_DIR = path.join(os.homedir(), '.claude-code-orchestrator');
try {
  if (!fs.existsSync(ROOT_DIR) && fs.existsSync(LEGACY_ROOT_DIR)) {
    fs.renameSync(LEGACY_ROOT_DIR, ROOT_DIR);
  }
} catch {
  // migration is best-effort; a fresh ROOT_DIR is created on demand
}
export const REGISTRY_FILE = path.join(ROOT_DIR, 'registry.json');
export const TASKS_LOG_FILE = path.join(ROOT_DIR, 'tasks.jsonl');
export const TASKS_DIR = path.join(ROOT_DIR, 'tasks');
export const STATS_FILE = path.join(ROOT_DIR, 'stats.json');
export const ORCHESTRATORS_FILE = path.join(ROOT_DIR, 'orchestrators.json');

/** Self-reported main-session model per workspace (via orchestrator_briefing). */
export interface OrchestratorCheckin {
  model: string;
  ts: number;
  /** Last MCP tool call from this workspace's main session (any tool). */
  lastSeen?: number;
}

export type OrchestratorsFile = Record<string, OrchestratorCheckin>;

export function readOrchestrators(): OrchestratorsFile {
  try {
    return JSON.parse(fs.readFileSync(ORCHESTRATORS_FILE, 'utf8')) as OrchestratorsFile;
  } catch {
    return {};
  }
}

export function recordOrchestrator(cwd: string, model: string): void {
  ensureDirs();
  const all = readOrchestrators();
  const now = Date.now();
  all[cwd] = { model, ts: now, lastSeen: now };
  fs.writeFileSync(ORCHESTRATORS_FILE, JSON.stringify(all, null, 2));
}

/**
 * Mark the workspace's main session alive on any dispatch-server tool call.
 * Keeps the dashboard's session indicator fresh even before the session has
 * (re-)briefed — e.g. right after the main account was switched.
 */
export function touchOrchestrator(cwd: string): void {
  ensureDirs();
  const all = readOrchestrators();
  const entry = all[cwd] ?? { model: '', ts: 0 };
  entry.lastSeen = Date.now();
  all[cwd] = entry;
  fs.writeFileSync(ORCHESTRATORS_FILE, JSON.stringify(all, null, 2));
}

/** Drop a workspace's check-in (dashboard reset after switching accounts). */
export function clearOrchestrator(cwd: string): void {
  ensureDirs();
  const all = readOrchestrators();
  delete all[cwd];
  fs.writeFileSync(ORCHESTRATORS_FILE, JSON.stringify(all, null, 2));
}

/** Range and default of claudeCodeOrchestrator.workerTimeoutMinutes in package.json. */
export const TIMEOUT_MINUTES_MIN = 1;
export const TIMEOUT_MINUTES_MAX = 480;
export const TIMEOUT_MINUTES_DEFAULT = 45;

/**
 * Clamp to the range package.json declares; input that is not a number falls
 * back to the default. Both the extension host (writing the registry) and the
 * dispatch server (reading it) go through this, so a hand-edited registry.json
 * can neither produce an instantly-expiring timer (0, -5) nor a delay above
 * setTimeout's 32-bit ceiling, where Node silently coerces the overflow to 1 ms
 * and the "long" timeout fires immediately.
 */
export function clampTimeoutMinutes(value: unknown): number {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (Number.isNaN(raw)) {
    return TIMEOUT_MINUTES_DEFAULT;
  }
  // Math.round (not trunc) so 44.6 → 45; ±Infinity survives to the clamp.
  return Math.min(TIMEOUT_MINUTES_MAX, Math.max(TIMEOUT_MINUTES_MIN, Math.round(raw)));
}

/**
 * Bounds and defaults of the two attachable-worker lifecycle settings. package.json's
 * setting declarations mirror these numbers, and the extension clamps with the same
 * helpers before writing, so the UI, the registry file and the server cannot drift.
 */
export const MESH_IDLE_TIMEOUT_DEFAULT = 15;
export const MESH_IDLE_TIMEOUT_MAX = 1440;
export const MESH_MAX_LIVE_DEFAULT = 8;
export const MESH_MAX_LIVE_MIN = 1;
export const MESH_MAX_LIVE_MAX = 64;

/**
 * Numeric reading of a hand-editable setting. A numeric STRING is accepted (the registry
 * file is edited by hand and by other tools, where "15" is an ordinary way to write 15);
 * anything else reads as NaN and each caller decides what its own absent/invalid case is.
 */
function numericSetting(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return NaN;
}

/**
 * Idle auto-stop window in minutes. ZERO IS A VALUE, NOT AN ERROR — it means "never
 * auto-stop", which is a legitimate choice for someone who manages workers by hand. A
 * negative or unreadable value expresses no honorable intention and reads as the default,
 * because silently turning the backstop off is the one outcome a typo must not produce.
 */
export function sanitizeMeshIdleTimeout(value: unknown): number {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw) || raw < 0) {
    return MESH_IDLE_TIMEOUT_DEFAULT;
  }
  return Math.min(MESH_IDLE_TIMEOUT_MAX, Math.round(raw));
}

/**
 * Live-worker ceiling. Clamped rather than defaulted at the edges: 0 or a negative number
 * means "as few as possible", which is 1 — never "no limit", the exact failure this cap
 * exists to prevent. Only an unreadable value falls back to the default.
 */
export function sanitizeMeshMaxLive(value: unknown): number {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return MESH_MAX_LIVE_DEFAULT;
  }
  return Math.min(MESH_MAX_LIVE_MAX, Math.max(MESH_MAX_LIVE_MIN, Math.round(raw)));
}

const DEFAULTS: Registry = {
  workers: [],
  permissionMode: 'acceptEdits',
  claudePath: 'claude',
  cooldownMinutes: 30,
  workerTimeoutMinutes: TIMEOUT_MINUTES_DEFAULT,
  frontierWorkerDispatch: 'block',
  overageWorkerDispatch: 'block',
  meshMode: 'off',
  meshWorkerIdleTimeoutMin: MESH_IDLE_TIMEOUT_DEFAULT,
  meshMaxLiveWorkers: MESH_MAX_LIVE_DEFAULT,
  // Duplicates the contract's MESH_GATEWAY_MODEL_DEFAULT literal — registry.ts must not
  // import src/mesh/contract.ts (that module imports ROOT_DIR/WorkerModel from here, so
  // importing it back would cycle).
  meshGatewayModel: 'haiku',
};

export function ensureDirs(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

export function readRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
    return {
      ...DEFAULTS,
      ...raw,
      workers: raw.workers ?? [],
      // Every registry file written before this guard existed lacks the field, and
      // the file is hand-editable. Anything that is not exactly 'allow' — absent,
      // null, misspelled — must read as the safe 'block': money is only ever spent
      // past a plan window when an editor explicitly opted in.
      overageWorkerDispatch: raw.overageWorkerDispatch === 'allow' ? 'allow' : 'block',
      // The experimental mesh switch is opt-in and the file is hand-editable: anything
      // that is not exactly 'on' — absent, null, misspelled — reads as the safe 'off'.
      meshMode: raw.meshMode === 'on' ? 'on' : 'off',
      // Worker-lifecycle numbers are sanitized by VALUE, not by presence: an absent field
      // and a garbage one both land on the default, while a meaningful 0 (idle sweep off)
      // survives untouched. See the two helpers for why the edges differ.
      meshWorkerIdleTimeoutMin: sanitizeMeshIdleTimeout(raw.meshWorkerIdleTimeoutMin),
      meshMaxLiveWorkers: sanitizeMeshMaxLive(raw.meshMaxLiveWorkers),
      // Free-form gateway model alias; a non-string or empty value coerces to the
      // default (contract MESH_GATEWAY_MODEL_DEFAULT, duplicated here as 'haiku').
      meshGatewayModel:
        typeof raw.meshGatewayModel === 'string' && raw.meshGatewayModel.trim() !== ''
          ? raw.meshGatewayModel.trim()
          : 'haiku',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Write a file so concurrent readers (the MCP dispatch server runs in a
 * separate process and reads these files) never observe a torn or truncated
 * result: write to a pid-scoped temp file, then atomically rename it into place.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * How long a lock holder is presumed alive before its lock is treated as stale. A
 * protected critical section here is a single JSON read + tmp+rename write —
 * milliseconds — so any lock older than this belongs to a process that crashed
 * while holding it (or one whose pid we could not read), and breaking it is safe.
 */
const LOCK_STALE_MS = 30_000;
/** Give up WAITING for a contended lock after this long, then break + take it (deadlock backstop). */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
/** Poll interval while a lock is held by a live, non-stale holder. */
const LOCK_SPIN_MS = 15;

/**
 * Block the calling thread for `ms` WITHOUT a busy-loop. Atomics.wait on a private
 * SharedArrayBuffer parks the thread (no CPU burn) and needs no async plumbing, so
 * the synchronous read-modify-write helpers below can spin-wait for a contended
 * lock without turning into async functions and rippling through every caller.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

/**
 * Whether the advisory lock at `lockPath` is abandoned: its file is older than
 * LOCK_STALE_MS, or it names a pid that is no longer alive. A vanished lock (the
 * holder released it between our EEXIST and this check) is NOT stale — returning
 * false there simply sends the caller back to retry the exclusive create, which now
 * succeeds. Best-effort: any read error reads as "not stale" so we keep waiting
 * rather than stomp a lock we could not inspect.
 */
function lockIsStale(lockPath: string): boolean {
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      return true;
    }
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) && pid > 0 && !isPidAlive(pid);
  } catch {
    return false;
  }
}

/** The exact bytes stored in a lock file, or undefined if it cannot be read. */
function readLockToken(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Break an abandoned lock ATOMICALLY: rename it to a unique side-name and then remove
 * that side file. rename(2) is atomic, so of several waiters that all judged the same
 * lock stale, exactly ONE wins the rename — the source link vanishes for everyone else,
 * whose rename fails ENOENT and simply sends them back to retry the exclusive create.
 * A blind `unlinkSync(lockPath)` here was the F1 double-entry: two waiters each deleted
 * the file and each then won a fresh `wx` create, entering the critical section together.
 * Best-effort; a failure only leaves the lock name occupied, which the caller retries past.
 */
function breakLock(lockPath: string): void {
  const sidePath = `${lockPath}.break.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, sidePath);
  } catch {
    // another waiter already broke or re-took it — retry the create
    return;
  }
  try {
    fs.unlinkSync(sidePath);
  } catch {
    // best effort — the lock name is already free, which is all the caller needs
  }
}

/**
 * Run `fn` while holding an advisory exclusive lock on `targetFile` (a sibling
 * `<targetFile>.lock`), so concurrent read-modify-write of registry.json / stats.json
 * across the server and N detach supervisors never loses an update (contract R4).
 * The lock is acquired by an exclusive create (`wx`) that only one process can win;
 * losers spin (parked, not busy) until it frees, breaking a lock that a crashed
 * holder left behind (stale by age or dead pid). NOT reentrant — `fn` must not call
 * back into a helper that locks the SAME file. The lock is always released, even if
 * `fn` throws. Reads never take the lock: tmp+rename makes every write atomic, so a
 * lock-free reader can only ever see a complete old or new file.
 *
 * Acquisition and release are IDENTITY-SAFE (contract F1). Each holder stamps a unique
 * token (pid first — lockIsStale reads it — then time + randomness) and, after winning
 * the exclusive create, RE-READS the lock and confirms the token is still its own before
 * entering `fn`: a concurrent stale-break or the deadline backstop could have removed and
 * re-taken the file in the window between the create and the stamp, and only the re-read
 * proves we still hold it. On release we unlink ONLY when a re-read still shows OUR token,
 * so a lock a successor has since taken (after we were force-broken while slow) is never
 * deleted out from under it — which is what let a third waiter enter alongside the second.
 */
function withFileLock<T>(targetFile: string, fn: () => T): T {
  const lockPath = `${targetFile}.lock`;
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  // -1 is never closed: the loop only breaks once we have created AND re-confirmed a
  // lock carrying our own token.
  let fd = -1;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      // Won the exclusive create. Stamp our token, then re-read: if the bytes are ours
      // we own the section; if a stale-breaker or the deadline backstop stomped us in
      // between, drop this fd and start over.
      try {
        fs.writeSync(fd, token);
      } catch {
        // ownership is decided by the re-read below, not by whether the stamp wrote
      }
      if (readLockToken(lockPath) === token) {
        break;
      }
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fd = -1;
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      // Held by someone else. Break it only when it is genuinely abandoned, or when
      // we have waited past the deadline (a backstop against a wedged holder that
      // never cleared its lock). The break is a single atomic rename so at most one
      // waiter can claim it — either way, retry the create on the next loop.
      if (lockIsStale(lockPath) || Date.now() - started > LOCK_ACQUIRE_TIMEOUT_MS) {
        breakLock(lockPath);
        continue;
      }
      sleepSync(LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    // Release ONLY our own lock. If we were force-broken while slow and a successor now
    // holds the file, its token differs from ours — unlinking it would free a lock still
    // in use and let a third waiter enter alongside the successor.
    if (readLockToken(lockPath) === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already removed (e.g. a stale-breaker) — nothing to do
      }
    }
  }
}

export function writeRegistry(registry: Registry): void {
  ensureDirs();
  withFileLock(REGISTRY_FILE, () => atomicWrite(REGISTRY_FILE, JSON.stringify(registry, null, 2)));
}

/**
 * Read-modify-write registry.json under the advisory lock (contract R4): the whole
 * read → mutate → atomic write runs while the lock is held, so a concurrent updater
 * can neither interleave nor lose an edit. `mutate` receives the freshly re-read
 * registry (defaults applied) and mutates it in place.
 */
export function updateRegistry(mutate: (registry: Registry) => void): void {
  ensureDirs();
  withFileLock(REGISTRY_FILE, () => {
    const registry = readRegistry();
    mutate(registry);
    atomicWrite(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  });
}

/**
 * Standard install locations for a bare command name, in probe order. Order is
 * preference, not likelihood: a user-level npm prefix or native install beats a
 * package manager's shared bin, which beats a version manager's per-version bin.
 * Callers must already have proved `command` matches /^[A-Za-z0-9._-]+$/ AND is
 * neither '.' nor '..', so it carries no separator and can never escape the
 * directory it is joined to. The dot-name exclusion is what makes that true: the
 * pattern alone admits '..', and path.join(dir, '..') NORMALIZES away to dir's
 * parent — a directory, not a command.
 */
function wellKnownLocations(command: string): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.npm-global', 'bin', command),
    // default target of the claude native installer
    path.join(home, '.local', 'bin', command),
    path.join('/opt/homebrew/bin', command),
    path.join('/usr/local/bin', command),
  ];
  // nvm keeps one bin dir per node version; newest first. The 'v18.20.1'-style
  // names must be compared numerically per segment — a plain string sort ranks
  // v9 above v18 and would hand back a long-abandoned node.
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(nvmRoot);
  } catch {
    // nvm simply isn't installed (the usual case) — contributes no candidates
  }
  const segments = (name: string): number[] =>
    name.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  versions.sort((a, b) => {
    const left = segments(a);
    const right = segments(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  });
  for (const version of versions) {
    candidates.push(path.join(nvmRoot, version, 'bin', command));
  }
  candidates.push(path.join(home, 'n', 'bin', command));
  return candidates;
}

/**
 * Whether `p` is something spawn can actually execute: a regular FILE carrying
 * the execute bit for this process.
 *
 * fs.existsSync is not that test: it is equally true for a directory and for a
 * mode-644 file, neither of which spawn can run. statSync follows symlinks here,
 * so only a LIVE link target passes — a dangling link is correctly "not found".
 * The distinction is the whole incident this release fixes: during a reinstall the
 * file exists for a moment BEFORE its exec bit is set, and an existence check
 * records that window as a SUCCESS with no retry path, so every later spawn fails
 * and nothing ever re-resolves. That window must read as "not found" so resolution
 * keeps retrying.
 *
 * On win32 accessSync treats X_OK as F_OK (there is no exec bit), so this
 * degrades to an existence check there — acceptable: the isFile() check still
 * screens out directories, which is the failure mode that actually bites.
 */
export function isSpawnableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name to an absolute path via the user's login shell.
 * The MCP server (and the workers and probes it spawns) may run without the shell
 * PATH that nvm/homebrew set up, so bare names can fail there with ENOENT.
 *
 * The command is interpolated into `$SHELL -lc "command -v <value>"`, and its
 * value reaches us from a workspace-level VS Code setting or the hand-editable
 * registry file — so anything that is not a plain bare command name
 * (/^[A-Za-z0-9._-]+$/, and neither '.' nor '..') is returned untouched WITHOUT
 * invoking a shell: shell metacharacters must never reach that interpolation, and
 * only bare names are worth resolving in the first place. The two dot names are
 * excluded explicitly because the pattern admits them while they name a DIRECTORY:
 * `command -v ..` fails, and the candidate path.join(home, '.npm-global', 'bin',
 * '..') normalizes to '.npm-global' — a directory that an existence check would
 * have accepted and handed back as an authoritative absolute path.
 *
 * A leading/trailing-whitespace value (' claude', a hand-edit typo) is TRIMMED
 * rather than rejected: it is non-empty, so it passes every emptiness check, but
 * untrimmed it fails the bare-name guard on the space and then fails every
 * downstream lookup — a value class that used to resolve would become permanently
 * unresolvable. Absolute paths need no resolution, and win32 has no login shell
 * to ask.
 *
 * When the login-shell lookup comes back empty — it errors, times out, or names
 * a file that does not exist — a fixed list of standard install locations
 * (wellKnownLocations) is probed before giving up. A NON-INTERACTIVE login shell
 * does not source ~/.zshrc, and that is exactly where version managers and npm
 * prefixes edit PATH, so a genuinely clean process (GUI-launched, no inherited
 * shell PATH) cannot see an installed binary at all: `env -i HOME=$HOME zsh -lc
 * 'command -v claude'` exits 1 while the binary sits in ~/.npm-global/bin. An
 * INTERACTIVE shell (-ilc) would see it, and was deliberately rejected: prompt
 * frameworks can block on startup and hang the lookup. A deterministic candidate
 * list covers the same installs and cannot hang.
 *
 * Every failure path — non-string input, shell error, timeout, output naming
 * something that is not an executable file, no candidate being spawnable —
 * returns the (trimmed) `command` unchanged rather than throwing.
 */
export function resolveViaLoginShell(command: string): string {
  if (typeof command !== 'string') {
    return 'claude';
  }
  command = command.trim();
  if (command === '') {
    return 'claude';
  }
  if (process.platform === 'win32' || path.isAbsolute(command)) {
    return command;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(command) || command === '.' || command === '..') {
    return command;
  }
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const out = execFileSync(shell, ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .split('\n')
      .pop();
    if (out && isSpawnableFile(out)) {
      return out;
    }
  } catch {
    // fall through
  }
  for (const candidate of wellKnownLocations(command)) {
    if (isSpawnableFile(candidate)) {
      return candidate;
    }
  }
  return command;
}

/**
 * Resolve the configured claude command, keeping the last known good absolute
 * path when resolution transiently fails.
 *
 * Incident this exists for: while the binary was mid-reinstall, a sync resolved
 * nothing and overwrote the stored absolute path with the bare name 'claude'.
 * Every process that lacks the login-shell PATH — the bundled MCP server, the
 * extension host's probes — then failed with `spawn claude ENOENT` for hours,
 * until some later sync happened to succeed. A resolution failure says nothing
 * about the path we already proved good, so it must not destroy it.
 *
 * `previous` is only reused when it is an absolute path that is still a spawnable
 * executable file (isSpawnableFile, NOT mere existence — a half-installed binary
 * without its exec bit is not a last-known-good) AND still names the configured
 * command (basename, optionally minus a Windows .exe/.cmd/.bat/.ps1 suffix).
 * Without that name check, changing the configured command would silently keep
 * pinning the OLD command's path against the user's intent.
 *
 * `configured` is trimmed before use: a hand-edited ' claude' is non-empty, so it
 * survives every emptiness check, yet untrimmed it resolves nowhere at all.
 *
 * An absolute `configured` is authoritative and returned verbatim even when it
 * does not currently exist: the user may be mid-install, and second-guessing an
 * explicit setting would silently pin a stale binary.
 */
export function resolveClaudePathPreserving(configured: unknown, previous: unknown): string {
  const command = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'claude';
  if (path.isAbsolute(command)) {
    return command;
  }
  const resolved = resolveViaLoginShell(command);
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  if (typeof previous === 'string' && path.isAbsolute(previous) && isSpawnableFile(previous)) {
    const base = path.basename(previous);
    const stripped = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (base === command || stripped === command) {
      return previous;
    }
  }
  return resolved;
}

/**
 * Reconcile the frontier billing guard across editors that share this one
 * registry file. Every editor with the extension writes its settings here, so a
 * blind overwrite let an editor where the guard is UNSET clobber another editor's
 * explicit `allow` back to the default `block` (and vice versa). This function is
 * called on each sync with THIS editor's own explicit setting:
 *
 *  - `explicit` set (any editor)  -> take it, and record that editor as the owner.
 *  - `explicit` unset, owner is a DIFFERENT editor -> leave the value alone (an
 *    editor that never opted in must not override the one that did — the bug).
 *  - `explicit` unset, owner is THIS editor -> the opt-in was revoked; revert to
 *    the safe default `block` and clear the owner.
 *
 * Fail-safe: the default and any non-'allow' explicit value resolve to `block`,
 * so frontier billing is only ever enabled by an editor that explicitly asks for it.
 * Pure and side-effect-free apart from mutating the passed registry; unit-tested.
 */
export function applyFrontierGuard(
  registry: Registry,
  editor: string,
  explicit: string | undefined,
): Registry {
  if (explicit !== undefined) {
    registry.frontierWorkerDispatch = explicit === 'allow' ? 'allow' : 'block';
    registry.frontierGuardSetBy = editor;
  } else if (registry.frontierGuardSetBy === editor) {
    registry.frontierWorkerDispatch = 'block';
    registry.frontierGuardSetBy = undefined;
  }
  return registry;
}

/**
 * Reconcile the overage billing guard across editors that share this one
 * registry file. Semantics are IDENTICAL to applyFrontierGuard — see its doc
 * comment for why the reconciliation exists (a blind overwrite let an editor
 * where the setting is UNSET clobber another editor's explicit choice). What
 * differs is only what the guard governs: applyFrontierGuard controls WHICH
 * MODEL may be dispatched (claude-fable-5), this one controls WHETHER ANY
 * dispatch may proceed past an exhausted plan window and bill real money.
 *
 *  - `explicit` set (any editor)  -> take it, and record that editor as the owner.
 *  - `explicit` unset, owner is a DIFFERENT editor -> leave the value alone (an
 *    editor that never opted in must not override the one that did — the bug).
 *  - `explicit` unset, owner is THIS editor -> the opt-in was revoked; revert to
 *    the safe default `block` and clear the owner.
 *
 * Fail-safe: the default and any non-'allow' explicit value resolve to `block`,
 * so overage spending is only ever enabled by an editor that explicitly asks for it.
 * Pure and side-effect-free apart from mutating the passed registry.
 */
export function applyOverageGuard(
  registry: Registry,
  editor: string,
  explicit: string | undefined,
): Registry {
  if (explicit !== undefined) {
    registry.overageWorkerDispatch = explicit === 'allow' ? 'allow' : 'block';
    registry.overageGuardSetBy = editor;
  } else if (registry.overageGuardSetBy === editor) {
    registry.overageWorkerDispatch = 'block';
    registry.overageGuardSetBy = undefined;
  }
  return registry;
}

/**
 * The registered worker (if any) whose configDir names the same path as `dir`.
 * Compared via path.resolve on both sides; symlinks are NOT resolved. Used to
 * refuse creating a second worker bound to an existing worker's directory —
 * a worker's dir is derived from its name at creation and KEPT across renames,
 * so re-adding a previously-used name would silently share that login.
 */
export function findWorkerByConfigDir(
  workers: WorkerProfile[],
  dir: string,
): WorkerProfile | undefined {
  const target = path.resolve(dir);
  return workers.find(
    (w) => typeof w.configDir === 'string' && path.resolve(w.configDir) === target,
  );
}

export function appendTaskEvent(event: TaskEvent): void {
  ensureDirs();
  fs.appendFileSync(TASKS_LOG_FILE, JSON.stringify(event) + '\n');
}

/**
 * Best-effort append of a trailing note to a task's output file. The dispatch
 * server writes the output file when an attempt starts, so terminal paths that
 * bypass the server's own done/failed writers must annotate the file or it keeps
 * claiming RUNNING forever. Never throws; a no-op when outputFile is empty.
 */
export function appendOutputNote(outputFile: string | undefined, note: string): void {
  if (typeof outputFile !== 'string' || outputFile === '') {
    return;
  }
  try {
    fs.appendFileSync(outputFile, note);
  } catch {
    // annotating the output file is best-effort — never break the caller
  }
}

export function readTaskEvents(): TaskEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(TASKS_LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  // Skip unparseable lines individually. appendTaskEvent is a plain append, so a
  // crash mid-write can leave one truncated line; discarding the whole log for it
  // would blank the task view, zero windowUsage, and silently defeat the
  // running-dispatch guard in renameWorker.
  const events: TaskEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as TaskEvent);
    } catch {
      // truncated or hand-edited line — ignore it, keep the rest
    }
  }
  return events;
}

export function clearTaskLog(): void {
  try {
    fs.writeFileSync(TASKS_LOG_FILE, '');
  } catch {
    // nothing to clear
  }
}

/** Currently-running dispatch count per worker (latest event per task id). */
export function runningCounts(): Record<string, number> {
  const latest = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    latest.set(e.id, e);
  }
  const counts: Record<string, number> = {};
  for (const e of latest.values()) {
    if (e.status === 'running') {
      counts[e.worker] = (counts[e.worker] ?? 0) + 1;
    }
  }
  return counts;
}

/** Latest event per task id, in the order runningCounts observes them. */
function latestById(): Map<string, TaskEvent> {
  const latest = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    latest.set(e.id, e);
  }
  return latest;
}

/** Latest event recorded for one task id, or undefined if the id has none. */
export function latestEventById(id: string): TaskEvent | undefined {
  let latest: TaskEvent | undefined;
  for (const e of readTaskEvents()) {
    if (e.id === id) {
      latest = e;
    }
  }
  return latest;
}

/**
 * Latest event for each requested id, reading the log ONCE. Ids with no event are
 * simply absent from the returned map (the caller reports them as not-found).
 * Read-only — used by the dispatch_status retrieval tool.
 */
export function latestEventsByIds(ids: string[]): Map<string, TaskEvent> {
  const want = new Set(ids);
  const out = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    if (want.has(e.id)) {
      out.set(e.id, e);
    }
  }
  return out;
}

/** Tasks whose latest event is still 'running' (mirrors runningCounts' latest-per-id logic). */
export function runningTasks(): TaskEvent[] {
  const running: TaskEvent[] = [];
  for (const e of latestById().values()) {
    if (e.status === 'running') {
      running.push(e);
    }
  }
  return running;
}

/**
 * Whether `pid` names a live process. `process.kill(pid, 0)` sends no signal; it
 * only probes. EPERM means the process exists but is owned by another user (still
 * alive); ESRCH means no such process. A non-finite or non-positive pid is never
 * a real process.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * CRITICAL SAFETY GATE. A 'running' event can be stale, and the OS may have
 * recycled its pid for a completely unrelated process. Never signal a pid without
 * first confirming it is still one of our workers by reading its command line.
 * Our workers are spawned as `claude -p --output-format json …`, so the command
 * line must contain both `claude` and ` -p`. Any error, empty output, or
 * non-matching command line is treated as "not ours" → not signalled. On win32
 * there is no `ps`, so we degrade to "treat as dead" and never signal.
 */
function isOurWorker(pid: number): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    if (!args) {
      return false;
    }
    return args.includes('claude') && args.includes(' -p');
  } catch {
    return false;
  }
}

/**
 * Companion to isOurWorker for the DETACH SUPERVISOR process. A supervisor is spawned
 * `node <…>/run-task.js <…>/tasks/<id>.spec.json` (see dispatchDetached in server.ts).
 * Same safety rationale as isOurWorker — a 'running' event's supervisorPid can be stale
 * and the OS may have recycled it — but the bar is TWO anchored tokens, like isOurWorker's
 * `claude`+` -p` (contract F4): the command line must contain BOTH the `run-task.js`
 * entrypoint AND THIS task's unique `tasks/<id>.spec.json` argument. The loose lone
 * `run-task` substring matched a recycled pid, an editor with the file open, an unrelated
 * `run-task-fake.mjs`, or a DIFFERENT task's supervisor — any of which would have wrongly
 * kept a dead task `running` forever (a false-negative reap). Pairing the entrypoint with
 * the per-task spec path (unique to this id, and still on the argv even after the supervisor
 * unlinks the spec file) makes such a false match effectively impossible.
 * On win32 there is no `ps`, so this degrades to "not ours" (the declared R9 gap).
 */
function isOurSupervisor(pid: number, id: string): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    // -ww: never truncate to terminal width. The spec argument is the LAST token on a
    // long `node <abs>/run-task.js <abs>/tasks/<id>.spec.json` command line, and a
    // width-truncated `ps` would drop it — a false-negative supervisor match that would
    // let a live supervisor's task be wrongly orphaned. isOurWorker's tokens sit early
    // in the argv so it does not need this; here the second anchor is at the tail.
    const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    if (!args) {
      return false;
    }
    return args.includes('run-task.js') && args.includes(`${id}.spec.json`);
  } catch {
    return false;
  }
}

/**
 * Send `sig` to a worker's ENTIRE process tree when we safely can, else to the
 * single worker process. Callers MUST have already confirmed `event.pid` is a
 * positive finite number and that both isPidAlive(event.pid) and
 * isOurWorker(event.pid) hold; this is re-asserted here as a guard.
 *
 * A group signal is sent ONLY when the event explicitly recorded `pgid` (the
 * worker was spawned detached as its own group leader, so PGID === PID and the
 * group is exclusively ours). We NEVER derive a group id from the pid: a worker
 * from an older build is not a group leader, and `-pid` would then signal the
 * server's group — a group we do not own. On win32 negative pids are meaningless,
 * so we use `taskkill /T` to kill the tree by pid. Never throws.
 */
function signalWorker(event: TaskEvent, sig: NodeJS.Signals): void {
  const pid = event.pid;
  if (typeof pid !== 'number' || !isPidAlive(pid) || !isOurWorker(pid)) {
    return;
  }
  if (process.platform === 'win32') {
    // taskkill kills the whole tree by pid; negative pids are never used here.
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // process may already be gone, or taskkill unavailable — nothing to do
    }
    return;
  }
  if (typeof event.pgid === 'number' && event.pgid > 0) {
    try {
      // -pgid signals the whole group; only reached when the event recorded it.
      process.kill(-event.pgid, sig);
    } catch {
      // group already gone (ESRCH) or otherwise unsignalable — fall back to the
      // single worker process so cancellation still lands on the parent.
      try {
        process.kill(pid, sig);
      } catch {
        // the worker exited between the checks above and this signal
      }
    }
    return;
  }
  // No recorded group => older event; signal only the single worker process.
  try {
    process.kill(pid, sig);
  } catch {
    // the worker exited between the checks above and this signal
  }
}

/**
 * Terminate the worker behind a running task and record a terminal 'error' event.
 * Returns false (no-op) when the task is absent or its latest event is not
 * 'running' — which makes a second call idempotent, since the first call's
 * terminal event supersedes the 'running' one. A signal is sent ONLY when the
 * recorded pid is present, alive, and still matches our worker's command line
 * (see isOurWorker); a missing, dead, or recycled pid is never signalled. Stats
 * are left untouched — a cancellation is not a worker error.
 */
export async function cancelRunningTask(id: string, reason: string, graceMs = 3000): Promise<boolean> {
  const latest = latestById().get(id);
  if (!latest || latest.status !== 'running') {
    return false;
  }
  const pid = latest.pid;
  if (typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid)) {
    // signalWorker reaches the worker's whole process tree when the event
    // recorded a pgid, else the single process; it re-asserts the same gate.
    signalWorker(latest, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    // Re-confirm the pid is still alive AND still our worker before escalating:
    // if the process exited during the grace period its pid may have been
    // recycled, and SIGKILL to a recycled pid would kill an unrelated process.
    if (isPidAlive(pid) && isOurWorker(pid)) {
      signalWorker(latest, 'SIGKILL');
    }
  }
  appendTaskEvent({ ...latest, ts: Date.now(), status: 'error', error: reason });
  appendOutputNote(
    latest.outputFile,
    `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n`,
  );
  return true;
}

/**
 * Signal the WORKER of a detach task by its recorded pgid/pid — the server's half of
 * a detach cancel (contract §7 R7). Unlike cancelRunningTask this appends NO terminal
 * event: for a detach task the supervisor is the sole author of terminal events
 * (§5.3), and it writes the `cancelled` record itself once the dropped `.cancel`
 * marker makes its worker die. The server cannot reach the worker through
 * childrenByTask (a detach worker was spawned by the supervisor, not the server), so
 * it signals the recorded group directly here — SIGTERM, then SIGKILL after the grace
 * if it is still alive-and-ours. A no-op when the task is not running or its worker
 * pid is dead/absent (e.g. cancelled between attempts, where the marker alone
 * suffices). Never throws.
 */
export async function terminateDetachWorker(id: string, graceMs = 3000): Promise<void> {
  const latest = latestById().get(id);
  if (!latest || latest.status !== 'running') {
    return;
  }
  const pid = latest.pid;
  // On win32 isOurWorker returns false unconditionally (no `ps`), so this whole function
  // no-ops there: detach cancel of a RUNNING worker is marker-only on Windows (declared R9
  // gap) — the taskkill /T branch in signalWorker is unreachable from this path, not a claim
  // that a running Windows worker gets signalled.
  if (typeof pid !== 'number' || !isPidAlive(pid) || !isOurWorker(pid)) {
    return;
  }
  signalWorker(latest, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  // Re-confirm alive AND still ours before escalating: if it exited during the grace
  // its pid may have been recycled, and SIGKILL to a recycled pid would hit a stranger.
  if (isPidAlive(pid) && isOurWorker(pid)) {
    signalWorker(latest, 'SIGKILL');
  }
}

/**
 * Fields the reaper reads from a detach task's tasks/<id>.result.json to reconcile a
 * completed-but-unrecorded run (contract §7 R8). A structural subset of run-task.ts's
 * TaskResult; declared locally so registry.ts stays free of any mcp/ import. Read-only.
 */
export interface ResultRecord {
  id?: string;
  status?: 'done' | 'error';
  text?: string;
  worker?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

/** Parse tasks/<id>.result.json, or undefined if it is absent or unreadable. Read-only. */
export function readResultJson(id: string): ResultRecord | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(TASKS_DIR, `${id}.result.json`), 'utf8'),
    ) as ResultRecord;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Whether a task's DONE output file (tasks/<id>.md) shows a completed run: the DONE
 * writer emits a `## Result` section and a `- tokens: N in / M out` line, neither of
 * which a RUNNING header or a FAILED body carries. Used as the reconcile fallback
 * when result.json is absent but the output file proves the run finished.
 */
function outputFileLooksDone(outputFile: string | undefined): boolean {
  if (typeof outputFile !== 'string' || outputFile === '') {
    return false;
  }
  try {
    const body = fs.readFileSync(outputFile, 'utf8');
    return body.includes('\n## Result') && /\n- tokens: \d+ in \/ \d+ out/.test(body);
  } catch {
    return false;
  }
}

/** Best-effort parse of the '- tokens: N in / M out (~$C)' line from a DONE output file. */
function parseUsageFromOutput(outputFile: string | undefined): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const zero = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (typeof outputFile !== 'string' || outputFile === '') {
    return zero;
  }
  try {
    const body = fs.readFileSync(outputFile, 'utf8');
    const tok = body.match(/\n- tokens: (\d+) in \/ (\d+) out(?: \(~\$([\d.]+)\))?/);
    if (!tok) {
      return zero;
    }
    return {
      inputTokens: parseInt(tok[1], 10) || 0,
      outputTokens: parseInt(tok[2], 10) || 0,
      costUsd: tok[3] ? parseFloat(tok[3]) || 0 : 0,
    };
  } catch {
    return zero;
  }
}

/**
 * Reconcile every running task whose owner is gone. A task is left running while
 * EITHER its worker pid is alive-and-ours OR — for a detach task — its supervisorPid
 * is alive-and-ours (contract §7 R8): a detach task briefly has no live worker
 * between failover attempts, and orphaning it in that window would be a false
 * orphan. Only when BOTH are dead is the task terminal, and then:
 *
 *  - a completed result.json (status done) → record `done` from its usage fields;
 *  - a result.json that recorded an error → record that error faithfully;
 *  - no result.json but a DONE-shaped output file → record `done` (usage parsed
 *    from the file, best-effort);
 *  - otherwise → `orphaned`, exactly as before.
 *
 * Never signals anything — reconciling only records terminal events. Returns the
 * number reconciled; never throws, and a failed append does not abort the sweep.
 *
 * `onlyIds`, when given, scopes the sweep to those task ids — the bounded reconcile the
 * MCP server runs opportunistically from dispatch_status so a crashed supervisor's ledger
 * is healed even in a headless/CLI deployment with no VS Code extension host (contract F2 /
 * R8). Omitted (the extension's startup sweep) reconciles every running task, as before.
 *
 * `isAliveExternally`, when given, adds a THIRD way for a task to count as alive: a task
 * whose worker is not a process of ours at all. An attachable (`--bg`) dispatch task
 * records no pid, so both pid checks above see nothing and every such task in flight would
 * be orphaned the moment this sweep ran. Callers pass a mesh-aware callback
 * (mesh/reaper.meshTaskAliveCheck) that answers from the mesh ledger; registry.ts stays
 * free of any mesh import. Omitted, the behavior is byte-identical to before this hook
 * existed. A callback that throws is treated as "cannot prove it alive" — the task then
 * reconciles exactly as it would have with no callback at all, since a reconcile only ever
 * records a terminal event and never signals anything.
 */
export function reapDeadTasks(
  onlyIds?: Iterable<string>,
  isAliveExternally?: (t: TaskEvent) => boolean,
): number {
  const wanted = onlyIds ? new Set(onlyIds) : undefined;
  let reaped = 0;
  for (const task of runningTasks()) {
    if (wanted && !wanted.has(task.id)) {
      continue;
    }
    const pid = task.pid;
    const workerAlive = typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid);
    const sup = task.supervisorPid;
    const supervisorAlive = typeof sup === 'number' && isPidAlive(sup) && isOurSupervisor(sup, task.id);
    let externallyAlive = false;
    if (!workerAlive && !supervisorAlive && isAliveExternally !== undefined) {
      try {
        externallyAlive = isAliveExternally(task) === true;
      } catch {
        externallyAlive = false;
      }
    }
    if (workerAlive || supervisorAlive || externallyAlive) {
      continue;
    }
    try {
      const reconciled = reconcileTerminalEvent(task);
      appendTaskEvent(reconciled.event);
      appendOutputNote(task.outputFile, reconciled.note);
      reaped++;
    } catch {
      // a failed append must not abort the sweep of the remaining tasks
    }
  }
  return reaped;
}

/**
 * Build the terminal event + output-file note for a running task whose worker and
 * supervisor are both gone. See reapDeadTasks for the reconcile precedence.
 */
function reconcileTerminalEvent(task: TaskEvent): { event: TaskEvent; note: string } {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const result = readResultJson(task.id);
  if (result && result.status === 'done') {
    return {
      event: {
        ...task,
        ts: now,
        status: 'done',
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        costUsd: result.costUsd ?? 0,
        error: undefined,
      },
      note: `\n\n---\n\nRECONCILED: supervisor completed; recorded done from result.json (${iso})\n`,
    };
  }
  if (result && result.status === 'error') {
    const message = result.error ?? result.text ?? 'failed';
    return {
      event: { ...task, ts: now, status: 'error', error: message },
      note: `\n\n---\n\nRECONCILED: supervisor completed with error from result.json (${iso})\n`,
    };
  }
  if (outputFileLooksDone(task.outputFile)) {
    const usage = parseUsageFromOutput(task.outputFile);
    return {
      event: { ...task, ts: now, status: 'done', ...usage, error: undefined },
      note: `\n\n---\n\nRECONCILED: recorded done from a completed output file (${iso})\n`,
    };
  }
  return {
    event: {
      ...task,
      ts: now,
      status: 'error',
      error: 'orphaned — worker process is no longer running',
    },
    note: `\n\n---\n\nORPHANED: worker process is no longer running (${iso})\n`,
  };
}

/** Dispatch usage for one worker within a trailing time window. */
export function windowUsage(worker: string, windowMs: number) {
  const since = Date.now() - windowMs;
  let tasks = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const e of readTaskEvents()) {
    if (e.worker === worker && e.status === 'done' && e.ts >= since) {
      tasks++;
      inputTokens += e.inputTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      costUsd += e.costUsd ?? 0;
    }
  }
  return { tasks, inputTokens, outputTokens, costUsd };
}

export function emptyStats(): WorkerStats {
  return { tasks: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function readStats(): StatsFile {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) as StatsFile;
  } catch {
    return {};
  }
}

export function writeStats(stats: StatsFile): void {
  ensureDirs();
  withFileLock(STATS_FILE, () => atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2)));
}

/**
 * Read-modify-write stats.json under the advisory lock (contract R4). This is the
 * hot concurrent path: the server and every detach supervisor call it through
 * recordSuccess / recordFailure, so without the lock two processes could read the
 * same stats, each add one task, and one increment would be lost. Holding the lock
 * across the fresh re-read → mutate → atomic write makes the update atomic. `mutate`
 * receives the freshly re-read stats and mutates it in place.
 */
export function updateStats(mutate: (stats: StatsFile) => void): void {
  ensureDirs();
  withFileLock(STATS_FILE, () => {
    const stats = readStats();
    mutate(stats);
    atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2));
  });
}

/**
 * Rename a worker everywhere its name is used as a key. The config directory — and
 * therefore the account's login — is NOT touched; only the label changes.
 * Retry-safe: each step is skipped when its source is already migrated.
 */
export function renameWorker(oldName: string, newName: string): void {
  newName = newName.trim();
  if (!/^[\w-]+$/.test(newName)) {
    throw new Error(`Invalid worker name "${newName}" — use letters, digits, - or _.`);
  }
  if (newName === oldName) {
    return;
  }

  const registry = readRegistry();
  const worker = registry.workers.find((w) => w.name === oldName);
  if (!worker) {
    throw new Error(`No worker named "${oldName}".`);
  }
  if (registry.workers.some((w) => w.name === newName)) {
    throw new Error(`A worker named "${newName}" already exists.`);
  }
  if (Object.keys(runningCounts()).length > 0) {
    throw new Error(
      'Cannot rename while dispatches are running — the dispatch server appends to the task log. Wait for them to finish.',
    );
  }

  // a. tasks.jsonl — remap the `worker` field of every event, whole-token only.
  if (fs.existsSync(TASKS_LOG_FILE)) {
    const migrated = fs
      .readFileSync(TASKS_LOG_FILE, 'utf8')
      .split('\n')
      .map((line) => {
        if (!line.trim()) {
          return line; // blank/trailing segment — preserve as-is
        }
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          return line; // unparseable — never drop data, preserve verbatim
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.worker === 'string') {
          const tokens: string[] = (parsed.worker as string).split(',');
          parsed.worker = tokens.map((t) => (t === oldName ? newName : t)).join(',');
        }
        return JSON.stringify(parsed);
      })
      .join('\n');
    atomicWrite(TASKS_LOG_FILE, migrated);
  }

  // b. stats.json — move the entry to the new key (skip if already migrated). The
  //    read-modify-write runs under the stats lock so it cannot race a concurrent
  //    recordSuccess/recordFailure (contract R4).
  updateStats((stats) => {
    if (oldName in stats) {
      if (!(newName in stats)) {
        stats[newName] = stats[oldName];
      }
      delete stats[oldName];
    }
  });

  // c. registry.json — the authoritative identity; written last so a crash
  //    before this point leaves oldName as the retry marker.
  worker.name = newName;
  writeRegistry(registry);
}
