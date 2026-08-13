import * as fs from 'fs';
import * as path from 'path';
import {
  appendTaskEvent,
  clampTimeoutMinutes,
  ensureDirs,
  latestEventById,
  readRegistry,
  TASKS_DIR,
  WORKER_MODELS,
  type Registry,
  type TaskEvent,
  type WorkerProfile,
} from '../registry';
import { isFrontierTier, WORKER_BASE_PROMPT } from '../prompts';
import {
  exhaustedWindows,
  readUsageCache,
  refreshAllUsageIfStale,
  type AccountUsage,
  type UsageCache,
  type UsageWindow,
} from '../usage';
import {
  CANCELLED_ERROR,
  formatExhaustedWindow,
  isQuotaError,
  pickWorkerLive,
  recordFailure,
  recordSuccess,
  type DispatchArgs,
  type TaskBase,
} from './task-runner';
import {
  BG_RESULT_FILE_MAX_BYTES,
  bgDispatchBootstrapPrompt,
  bgDispatchTaskFile,
  bgIoTaskDir,
  bgResultFile,
  bgTaskFile,
  bgWorktreePath,
  ENTRY_APPEAR_GRACE_MS,
  isGitWorkspace,
  meshError,
  newIoToken,
  parseMeshWorkerName,
  parseWorkerSignal,
  SUMMARY_MAX,
  type IGatewayManager,
  type IWorkerPool,
  type InboundMeshMessage,
  type MeshWorkerStatus,
  type RelayResult,
  type WorkerSpawnResult,
} from '../mesh/contract';
import { sweepStaleIoArtifacts } from '../mesh/reaper';

/**
 * mcp/bg-runner — dispatch over `claude --bg` (attachable dispatch), the mesh-ON half
 * of the dispatch fork. Mesh OFF never reaches this module: server.ts's dispatchTask
 * branches ONE `if` and the `-p` core (task-runner.ts) stays a closed box (contract
 * P0.1), which also keeps the detach supervisor — the core's other host — mesh-free.
 *
 * What differs from `-p`, and why:
 *   - The worker is a PERSISTENT background session, so there is no child process to
 *     read a result off. The task is delivered as a FILE (`<ioTaskDir>/task.md`, so a
 *     300 KB prompt cannot hit the argv size limit `-p` avoided by using stdin) and the
 *     result comes back as a FILE (`<ioTaskDir>/result.json`, the channel of record)
 *     plus a short wake ping over the gateway. Correctness never depends on relay
 *     fidelity: a model-mediated relay cannot guarantee a verbatim payload, a file can.
 *   - Both files live OUTSIDE the workspace, in a PER-TASK directory
 *     `<ROOT_DIR>/bg-io/<workspaceHash>/<taskId>/` (A10, isolated per task by F2). Claude
 *     Code 2.1.227 refuses a `--bg` session's Write anywhere inside the checkout until it
 *     enters a worktree — gitignored paths included — so the io channel had to leave the
 *     tree, and the spawn grants back exactly that one subdirectory with `--add-dir`. The
 *     grant is one gate; the per-task ioToken echoed inside the result JSON is the second,
 *     so a sibling's well-formed result can never settle this task even if the platform's
 *     directory grant ever regressed.
 *   - The worker's own edits land in a per-task git worktree (A11), so a dispatch is not
 *     integrated until the orchestrator has verified and merged it. Every surface that
 *     tells the orchestrator where the work is — the result string, the DONE output file,
 *     the timeout and death diagnostics — names that worktree and its branch.
 *   - The gateway is not only a wake-ping channel: the drain loop feeds a bounded LIVE
 *     FEED (A13) that mesh_receive long-polls, and mesh_send_worker sends steering back
 *     down the same relay. Results stay file-borne; the live channel is best-effort.
 *   - Every wait therefore has to be built from watchers and timers instead of process
 *     events: a per-task result-file watch + 2s poll, a 15s liveness poll for worker death, the
 *     dispatch timeout, and the cancel hook. All of them are settle-once through one
 *     gate, so ONE task produces exactly ONE result and the first valid signal wins.
 *   - A live worker is not necessarily a WORKING one. `-p` learns about a mid-run account
 *     limit from the child's own error text; over `--bg` the same event just ends the
 *     worker's turn and leaves the session sitting there, alive and idle, until the
 *     dispatch times out (observed live: a turn that ended 13s in burned an 8-minute
 *     timeout). So the liveness poll carries a recovery rung (A6): a worker that has
 *     produced nothing for the silence budget is checked against its account's plan usage
 *     — exhausted means fail the attempt QUOTA-CLASSIFIED and fail over exactly as `-p`
 *     would — and otherwise nudged through the relay to resume. The timeout stays the
 *     final backstop; the rung only stops it from being the FIRST one.
 *   - A settled worker is NOT stopped: staying attachable is the whole point. Teardown
 *     is the orchestrator's doctrine plus three backstops — the idle sweep here, the
 *     max-live cap here, and the reaper/shutdown stop in mesh/reaper.ts.
 *
 * Everything in this module is total: no timer, watcher, file read or relay message may
 * ever throw out into the server's event loop, and no failure path may leave a dispatch
 * pending forever — an undefined failure mode would hang the orchestrator's tool call.
 *
 * Must not import 'vscode'. Node stdlib + this repo's own modules only.
 */

/* ------------------------------------------------------------------------- *
 * Tunables — every one of these is pinned by the contract (§4)
 * ------------------------------------------------------------------------- */

/** Results-dir poll interval; fs.watch is the fast path, this is the guarantee. */
const RESULT_POLL_MS = 2_000;
/** After an accepted RESULT ping with no readable file, settle from the ping alone. */
const PING_GRACE_MS = 15_000;
/** After the timeout stop + final read, a last window in which a late file still settles. */
const POST_TIMEOUT_GRACE_MS = 10_000;
/** Per-pending-task liveness probe interval (P4.4). */
const LIVENESS_POLL_MS = 15_000;
// ENTRY_APPEAR_GRACE_MS (90s, the window in which a missing session entry is still
// latency rather than death) is imported from the mesh contract rather than redeclared:
// the pool's cap accounting counts a spawn as live for exactly that window, so the two
// must never drift apart.
/** Workers commonly die RIGHT AFTER success — hold a dead task this long before failing it. */
const DEATH_GRACE_MS = 10_000;
/**
 * How long a pending task's worker may be ALIVE while producing nothing at all — no result
 * file, no wake ping, no STATUS — before the liveness poll tries to recover it (A6).
 *
 * This exists because of an observed live failure: a worker's agentic turn ended 13 seconds
 * in (a mid-run account limit, or a transient completion failure) and its session then sat
 * alive-and-idle for the FULL eight-minute dispatch timeout. A one-shot `-p` worker fails
 * fast on the same event — the quota text lands on stderr, the error classifies, the account
 * cools down and the task fails over — so silence over `--bg` was a real parity gap, not a
 * cosmetic one.
 *
 * Exported because it is the number that decides how long a stalled dispatch stays invisible;
 * the effective budget is min(this, timeoutMs / 2), so a short-timeout task still gets its
 * recovery attempt before the timeout it is racing.
 */
export const NUDGE_AFTER_MS = 180_000;
/** Nudges per task. Two is a retry, three would be nagging a worker that is simply gone. */
const NUDGE_MAX = 2;
/**
 * How old the account's cached plan usage may be before a silent episode pays for ONE live
 * probe. Deliberately much tighter than USAGE_FRESH_DEFAULT_MS: a reading taken before the
 * worker fell silent cannot answer "did this worker just hit its ceiling", which is the only
 * question being asked here.
 */
const SILENCE_USAGE_MAX_AGE_MS = 60_000;
/** Ceiling for that one probe. get_usage answers in 1-2s; this bounds a wedged CLI. */
const SILENCE_USAGE_PROBE_TIMEOUT_MS = 10_000;
/** Idle-worker sweep interval (P4.8). */
const IDLE_SWEEP_MS = 60_000;
/** Unmatched inbound signals kept for diagnostics (newest wins). */
const UNMATCHED_RING_MAX = 20;
/** STATUS notes quoted in a timeout/death message. */
const STATUS_TAIL_MAX = 5;
/** Defensive cap on a worker-supplied note before it is written anywhere. */
const SIGNAL_NOTE_MAX = 300;
/** Drain-loop long-poll shape (contract P4.1: `receive(20_000, 50)`). */
const DRAIN_RECEIVE_WAIT_MS = 20_000;
const DRAIN_RECEIVE_MAX = 50;
/** Pause after an unexpected receive() throw so a broken gateway cannot hot-loop us. */
const DRAIN_ERROR_BACKOFF_MS = 1_000;

/**
 * Does a session entry's `updatedAt` count as worker activity for the idle clock?
 *
 * Build-time constant, deliberately FALSE until verification probe V2 answers the only
 * question that matters: does `updatedAt` actually move when a human attaches and
 * interacts, AND stay still while the session merely sits there? Trusting it before
 * that is the dangerous direction — a field that ticks on its own would disable the
 * idle backstop entirely, and the two attach protections that DO hold (the UI sets
 * keepAlive before opening the terminal; the doctrine orders mesh_keep_worker before an
 * attach command is surfaced) already cover the human-attached case.
 *
 * Typed `boolean` rather than left as a literal so flipping it needs no other edit.
 */
const IDLE_COUNTS_REGISTRY_UPDATED_AT: boolean = false;

/** Report substituted when a worker's result file parses but carries an empty report. */
const EMPTY_REPORT_NOTE =
  '(the worker wrote a result file with an empty report — inspect the working tree for what it ' +
  'actually produced before re-dispatching)';

/* ------------------------------------------------------------------------- *
 * Errors carried between the attempt loop and its helpers
 * ------------------------------------------------------------------------- */

/**
 * The spawn itself failed. `quota` is what fails this dispatch over to another account
 * (P4.6). Once a worker session EXISTS, only one other thing may fail over — a silent
 * worker on a demonstrably exhausted account (A6, BgQuotaStallError below) — because every
 * other post-spawn failure would hand a second account a task the first one may already
 * have half-finished.
 */
class BgSpawnFailure extends Error {
  constructor(
    message: string,
    readonly quota: boolean,
  ) {
    super(message);
    this.name = 'BgSpawnFailure';
  }
}

/**
 * A live worker went silent and its account turns out to be quota-exhausted (A6). This is
 * the `--bg` equivalent of the `-p` path's mid-run quota error: the same evidence arrives
 * through a different door (plan usage rather than a stderr string), so it must produce the
 * same consequence — a cooldown on the account and a failover to the next one. It is a
 * distinct class from BgSpawnFailure because nothing about the spawn failed: a worker
 * existed, ran, and stopped producing.
 */
class BgQuotaStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgQuotaStallError';
  }
}

/**
 * The max-live cap refused this dispatch (P4.7). Deliberately NOT a worker failure: no
 * recordFailure (the account did nothing wrong) and no failover (every account faces the
 * same cap), exactly like the frontier billing guard's refusal on the `-p` path.
 */
class BgCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgCapError';
  }
}

/** The request was cancelled. Mirrors `-p`: no recordFailure, no second terminal event. */
class BgCancelledError extends Error {
  constructor() {
    super(CANCELLED_ERROR);
    this.name = 'BgCancelledError';
  }
}

/**
 * The dispatch's wall clock ran out (P4.3) or the worker's session died before it reported
 * (P4.4). Both are carried as their own classes for ONE reason: the cancel-parity guard
 * (F3b) has to recognise them at the attempt-loop's catch, where it re-reads the task's
 * latest recorded event and steps aside if somebody else — the extension host's tree
 * cancel, the reaper — already authored a terminal one. A user cancel must never be
 * re-labelled "the worker died" and must never inflate an account's error count, and the
 * only way to know a failure came from one of those two clocks is to type it.
 *
 * They deliberately do NOT classify as quota (no cooldown, no failover): a timeout is not
 * a quota failure, and a replacement worker would redo work that may be half-done.
 */
class BgTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgTimeoutError';
  }
}

class BgWorkerDeathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgWorkerDeathError';
  }
}

/**
 * The worker itself reported a failure through its result file — a plain failure that has
 * consumed its attempt: the worker ran, decided it could not do the task, and another
 * account would decide the same. NEVER a quota failure, whatever the report says (A16 — the
 * reasoning is recorded in full on settleWorkerError, which is where the classification
 * briefly lived).
 *
 * Carried as its own type rather than a plain Error for the same reason WorkerTimeoutError
 * and WorkerKilledError exist on the `-p` path: its message is the WORKER's own prose.
 * Nothing classifies it today — that is the whole of A16 — and keeping the type is what
 * would force a future classifier to name this case explicitly instead of sweeping it in
 * with the server-authored failures.
 */
class BgWorkerReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgWorkerReportError';
  }
}

/* ------------------------------------------------------------------------- *
 * Module state — one pending map, one drain loop, one results watcher
 * ------------------------------------------------------------------------- */

/** One dispatch awaiting its result. Present only between a successful spawn and settle. */
interface BgPending {
  readonly id: string;
  readonly title: string;
  /** Registry account name the worker runs under (the `worker:` of every event). */
  readonly account: string;
  /** That account's CLAUDE_CONFIG_DIR — the key its plan usage is cached under (A6). */
  readonly configDir: string;
  /** Model this attempt runs, which decides whether a weekly_scoped window applies (A6). */
  readonly model: string;
  /** Mesh worker (session) name — the fromName a RESULT ping must carry (P4.1). */
  readonly workerName: string;
  /**
   * The per-task io token (F2.1). Minted once per DISPATCH — not per attempt — because the
   * task file that carries it to the worker is written once and reused by every failover
   * attempt. A result whose `token` field is not exactly this value never settles the task,
   * whatever else about it is well-formed.
   */
  readonly ioToken: string;
  /**
   * Workspace-relative worktree the worker edits in, and its branch (A11), when the
   * workspace is a git repo. Carried on the pending entry because every failure message
   * has to tell the reader where the half-finished work actually is — after `-w`, that is
   * never the shared checkout.
   */
  readonly worktree?: string;
  readonly branch?: string;
  readonly outputFile: string;
  readonly spawnedAt: number;
  readonly timeoutMinutes: number;
  readonly pool: IWorkerPool;
  /** The relay a silence nudge goes out through (A6); never used for results. */
  readonly gateway: IGatewayManager;
  settled: boolean;
  /** The worker's session entry was observed ALIVE at least once (P4.4). */
  entryEverSeen: boolean;
  /** Death was detected; the task is inside its death grace and still settleable. */
  deathPending: boolean;
  /** A RESULT ping was accepted and its 15s no-file grace is armed. */
  pingGraceArmed: boolean;
  /** fs.watch over THIS task's io dir; the shared 2s poll is the guarantee behind it. */
  watcher?: fs.FSWatcher;
  /**
   * `<mtimeMs>:<size>` of the last result file this task REFUSED (bad token, wrong embedded
   * id). Kept so a refused file that just sits there is reported to the unmatched ring ONCE
   * rather than every 2s poll tick for the rest of the dispatch — a ring that floods with
   * one repeated event is a ring that has lost every other event in it.
   */
  lastRejectSignature?: string;
  /**
   * Newest observed evidence that this worker is doing something (A6): its spawn, any
   * message it sent, and the mtime of a result file it has begun writing. The silence clock
   * measures from HERE, not from the spawn — a worker that reported STATUS four times and
   * then stopped is silent from the fourth STATUS, not from birth.
   */
  lastProgressAt: number;
  /** Silence budget before the recovery rung fires: min(NUDGE_AFTER_MS, timeoutMs / 2). */
  readonly nudgeAfterMs: number;
  /** Nudges sent so far (cap NUDGE_MAX), and when the last one went out. */
  nudgeCount: number;
  lastNudgeAt: number;
  /** The one bounded usage probe for the CURRENT silent episode has been spent. */
  usageProbeSpent: boolean;
  /** A recovery pass is in flight; later poll ticks must not start a second one. */
  silenceBusy: boolean;
  /** STATUS notes, newest last — quoted in timeout/death diagnostics. */
  readonly statusNotes: string[];
  /** Value of unmatchedTotal when this task started, for a per-task unmatched count. */
  readonly unmatchedAtStart: number;
  readonly timers: Set<NodeJS.Timeout>;
  livenessTimer?: NodeJS.Timeout;
  resolve(report: string): void;
  reject(err: Error): void;
}

const pending = new Map<string, BgPending>();

/**
 * Cancel hooks by task id (P4.5). The server's cancelRequest invokes one after its own
 * childrenByTask sweep; the hook stops the worker in EVERY state — booting (the runner
 * re-checks immediately after the spawn resolves), working, and idle-after-result.
 *
 * Entries deliberately OUTLIVE their task's own settle: a batch's cancel must still be
 * able to stop a worker that already reported and is now sitting idle. The server drops
 * them when the owning request finishes.
 */
export const bgWorkersByTask = new Map<string, () => void>();

/** One inbound signal that matched no pending dispatch — folded into timeout diagnostics. */
interface UnmatchedSignal {
  at: number;
  from: string;
  reason: string;
  text: string;
}
const unmatched: UnmatchedSignal[] = [];
/** Monotonic count (the ring is capped, so it cannot answer "how many since X"). */
let unmatchedTotal = 0;

/**
 * The single 2s poll over every pending task's result file; armed while at least one task
 * is pending. The fast path is one fs.watch PER TASK (on the entry, armed with it): after
 * F2 each task's result file lives in its own subdirectory, and a non-recursive watch on
 * the parent would not see writes one level down on every platform. The poll is the
 * guarantee either way — directory watch events are unreliable on macOS and on network
 * filesystems, which is why this pairing exists at all.
 */
let resultsPoll: NodeJS.Timeout | undefined;

/** Drain loop + idle sweep are started exactly once, after the gateway reaches READY. */
let loopsStarted = false;
let idleSweepTimer: NodeJS.Timeout | undefined;

/**
 * Serializer for everything that may create or destroy a worker. The cap check and the
 * spawn MUST run in one critical section (P4.7) or a batch of eight dispatches would all
 * read "7 live" and overshoot the cap by seven; the idle sweep's stops ride the same
 * chain so a stop can never interleave with the count it would have changed.
 *
 * A rejected link never poisons the chain: the stored continuation swallows outcomes.
 */
let workerChain: Promise<void> = Promise.resolve();
function serializeWorkerOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = workerChain.then(fn);
  workerChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Fire-and-forget `claude stop` for one worker. Never throws, never awaited. */
function stopWorkerBestEffort(pool: IWorkerPool, name: string, force: boolean): void {
  try {
    void pool.stop(name, { force }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // a synchronous throw out of stop() is not a reason to fail the caller
  }
}

/** Worker-supplied text, bounded and single-lined before it reaches a file or a report. */
function safeNote(note: string): string {
  return note.replace(/\s+/g, ' ').trim().slice(0, SIGNAL_NOTE_MAX);
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0].trim();
}

/**
 * Record fresh evidence of progress for one pending task (A6). Also RESETS the usage-probe
 * budget: "one bounded probe per silent episode" means a worker that speaks up and then goes
 * quiet again has earned a new episode, not a permanently spent allowance.
 */
function noteEntryProgress(entry: BgPending): void {
  entry.lastProgressAt = Date.now();
  entry.usageProbeSpent = false;
}

/**
 * Any message from a worker is progress for the task that worker is running. Keyed by name
 * rather than by task id on purpose: a malformed signal, an unparseable line or a message
 * for an unknown task still proves the session is awake, and proving that is precisely what
 * the silence clock needs. Unknown names cost one comparison per pending task.
 */
function markPendingProgress(workerName: string): void {
  if (workerName === '') {
    return;
  }
  for (const entry of pending.values()) {
    if (entry.workerName === workerName && !entry.settled) {
      noteEntryProgress(entry);
    }
  }
}

/**
 * A result file exists for a pending task: the worker is writing. Its MTIME is used rather
 * than "now" deliberately — a torn, oversize or otherwise unparseable file that just sits
 * there would otherwise look like fresh activity on every 2s poll and suppress the silence
 * recovery forever, which is exactly the stall A6 exists to break. A future mtime (clock
 * skew, a hand-touched file) is clamped to now so it cannot push the clock past the present.
 */
function noteResultFileProgress(entry: BgPending, file: string): void {
  let at: number;
  try {
    at = Math.min(fs.statSync(file).mtimeMs, Date.now());
  } catch {
    return;
  }
  if (isFinite(at) && at > entry.lastProgressAt) {
    entry.lastProgressAt = at;
    entry.usageProbeSpent = false;
  }
}

/* ------------------------------------------------------------------------- *
 * Io-channel artifacts (P4.12 / A10) — task file in, result file back, both
 * OUTSIDE the workspace because a `--bg` session may not write inside it
 * ------------------------------------------------------------------------- */

/**
 * This workspace, resolved once. process.cwd() is fixed for the life of the MCP server (it
 * is spawned in the workspace and never chdir's), so caching it costs nothing and keeps
 * every io path in this module derived from one place — the same place the pool derives the
 * `--add-dir` grant from, which is what makes the grant and the watch the same directory.
 */
let ioCwd: string | undefined;
function ioWorkspace(): string {
  if (ioCwd === undefined) {
    ioCwd = process.cwd();
  }
  return ioCwd;
}

/** This task's PRIVATE io directory (F2) — the unit of granting, watching and cleanup. */
function bgIoTaskDirPath(taskId: string): string {
  return bgIoTaskDir(ioWorkspace(), taskId);
}

function bgTaskFilePath(taskId: string): string {
  return bgTaskFile(ioWorkspace(), taskId);
}

function bgResultFilePath(taskId: string): string {
  return bgResultFile(ioWorkspace(), taskId);
}

/**
 * Write the worker's complete task to `<ioTaskDir>/task.md` BEFORE the spawn. This is the
 * only place the task text exists for the worker: `--bg` has no stdin, and an argv prompt
 * is size-bounded (E2BIG), so the bootstrap prompt stays fixed-size and points here
 * instead. Throws on failure — a worker with no task file has nothing to do.
 *
 * Creating the directory is part of this call rather than an ordering assumption: it is the
 * task's own subdirectory (F2), and it must exist before the spawn both because the task
 * file goes into it and because it is the exact path the pool grants with `--add-dir`.
 */
function writeBgTaskFile(
  taskId: string,
  opts: { ioToken: string; basePrompt: string; systemPrompt?: string; taskPrompt: string },
): void {
  fs.mkdirSync(bgIoTaskDirPath(taskId), { recursive: true });
  fs.writeFileSync(
    bgTaskFilePath(taskId),
    bgDispatchTaskFile({
      taskId,
      ioToken: opts.ioToken,
      basePrompt: opts.basePrompt,
      systemPrompt: opts.systemPrompt,
      taskPrompt: opts.taskPrompt,
    }),
  );
}

/**
 * Drop a settled task's WHOLE io directory (P4.12, F2.2). The prompt and the result are
 * already recorded in tasks/<id>.md and the task events, exactly as on the `-p` path, so
 * keeping them would only grow the io root forever — and removing the directory rather than
 * two known filenames means nothing a worker left in its own channel (a stray file, a
 * half-written temp) can survive by carrying a name this code did not anticipate.
 *
 * Best effort: `force` swallows a directory that was never created, and any other failure
 * is left to the 24h stale sweep.
 */
function removeBgIoTaskDir(taskId: string): void {
  try {
    fs.rmSync(bgIoTaskDirPath(taskId), { recursive: true, force: true });
  } catch {
    // in use, unreadable, or gone — the reaper's stale sweep is the backstop
  }
}

/* ------------------------------------------------------------------------- *
 * Result FILE channel (P4.1) — the channel of record
 * ------------------------------------------------------------------------- */

/**
 * What one look at a task's result file produced.
 *
 * Four outcomes, and the split between them is the whole of the file channel's trust model:
 *   - `absent` is every "not yet" — no file, an empty one, a mid-write torn read, a shape
 *     that has not finished arriving. It settles NOTHING and is not an error by itself,
 *     because a torn read must never fail a task that is about to succeed.
 *   - `result` is a valid, token-matched report for THIS task.
 *   - `rejected` is a file that is well-formed enough to have an opinion and is NOT this
 *     task's (F2.1): it never settles anything, and it is recorded in the unmatched ring
 *     so a forged or misdirected result is VISIBLE rather than silently ignored forever.
 *   - `unreadable` is a file we can prove we will never be able to read — today only the
 *     oversize case (F10a). It settles the task as an error, because the alternative is
 *     skipping it on every poll until the timeout reports "no result ever appeared", which
 *     is the single most misleading diagnosis available for a task that actually finished.
 */
type BgResultRead =
  | { kind: 'absent' }
  | { kind: 'result'; status: 'done' | 'error'; report: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unreadable'; message: string };

const RESULT_ABSENT: BgResultRead = { kind: 'absent' };

/** A token, as it may appear in a diagnostic line: never the expected one, never in full. */
function tokenHint(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    return '(absent)';
  }
  return `${raw.slice(0, 8)}…`;
}

/** How much of an unreadable (oversize) result file is quoted back to the orchestrator. */
const OVERSIZE_HEAD_BYTES = 2_000;

/**
 * The first bytes of a file, for a diagnostic that has to survive the file itself. Total by
 * construction — this runs while a task is being settled with a failure, and a second
 * failure here would replace a useful message with none at all.
 */
function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(OVERSIZE_HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    // A cut in the middle of a multi-byte character decodes to U+FFFD, which is the correct
    // outcome for an excerpt: it is not JSON any more and is never parsed again.
    return buf.toString('utf8', 0, read);
  } catch {
    return '(the file could not be read at all)';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Read one task's `result.json`, in the task's own io directory.
 *
 * The read is bounded by BG_RESULT_FILE_MAX_BYTES: the file is written by a worker
 * session, and while that is the same local trust domain as the rest of the workspace,
 * an unbounded readFileSync on a file that is being appended to is an easy way to turn a
 * runaway worker into an out-of-memory server.
 */
function readResultFile(file: string, taskId: string, ioToken: string): BgResultRead {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) {
      // Absent, a directory, or created-but-not-yet-written: come back next tick.
      return RESULT_ABSENT;
    }
    if (stat.size > BG_RESULT_FILE_MAX_BYTES) {
      // F10a. The file is never truncated-then-parsed (that would turn a huge report into
      // a permanent JSON error), and it is never skipped forever either: the worker DID
      // finish, so the task settles with a diagnosis naming what was found and where.
      //
      // The HEAD is quoted because settle-time cleanup removes the task's whole io directory
      // (F2.2) moments after this settles: the oversize report is the one payload that exists
      // nowhere else — it never reached tasks/<id>.md and never reached an event — so a
      // bounded excerpt is the only part of it that can be preserved at all.
      return {
        kind: 'unreadable',
        message:
          `The worker wrote its result file, but it is ${stat.size} bytes — past the ` +
          `${BG_RESULT_FILE_MAX_BYTES}-byte server read cap — so its report could not be read, ` +
          'and this dispatch is recorded as failed even though the worker itself finished. ' +
          `The file was at ${file} and is removed with the task's io directory when the ` +
          'dispatch settles, so what follows is all of it that survives. Inspect what the ' +
          'worker actually produced in the working tree, and if the work needs redoing, ' +
          're-dispatch with an explicit instruction to keep the report short and leave the ' +
          'detail in files. Not retried on another account (an oversize report is not a quota ' +
          `failure).\n\nFirst ${OVERSIZE_HEAD_BYTES} bytes of the file:\n${readHead(file)}`,
      };
    }
    const fd = fs.openSync(file, 'r');
    try {
      // size + 1 so a file that GREW between stat and read is detected as torn (the extra
      // byte makes JSON.parse fail) instead of being silently truncated into "valid" JSON.
      const buf = Buffer.allocUnsafe(stat.size + 1);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, read);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  } catch {
    return RESULT_ABSENT;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Mid-write torn read — the watcher/poll comes back for it.
    return RESULT_ABSENT;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return RESULT_ABSENT;
  }
  const rec = raw as Record<string, unknown>;
  // Gate 1 (F2.1): the token. The `--add-dir` grant already names only this task's own
  // directory, so a sibling should not be able to write here at all — but that grant is a
  // platform behavior probed once, and staking a wrong-task settle on a single probe is
  // exactly the assumption this review flagged. An unguessable per-task token is the
  // second, independent gate, and it is checked BEFORE the payload is trusted at all.
  if (rec.token !== ioToken) {
    return {
      kind: 'rejected',
      reason:
        `its "token" field is ${tokenHint(rec.token)}, which is not task ${taskId}'s io token — ` +
        'refusing it as a forged, copied or misdirected result (it settles nothing)',
    };
  }
  // Gate 2: the embedded id must match the DIRECTORY this file was found in (which is also
  // the pending key), so a worker that writes a neighbour's id can never settle either task.
  if (rec.taskId !== taskId) {
    return {
      kind: 'rejected',
      reason:
        `it carries taskId ${JSON.stringify(rec.taskId)} but was found in task ${taskId}'s own ` +
        'io directory — refusing it (it settles nothing)',
    };
  }
  if (rec.status !== 'done' && rec.status !== 'error') {
    return RESULT_ABSENT;
  }
  if (typeof rec.report !== 'string') {
    return RESULT_ABSENT;
  }
  // No truncation of a parsed report — `-p` reports are uncapped too. An EMPTY report is
  // well-formed but meaningless, so it settles the task (the work is over) carrying an
  // explanation instead of a blank result.
  return {
    kind: 'result',
    status: rec.status,
    report: rec.report.trim() === '' ? EMPTY_REPORT_NOTE : rec.report,
  };
}

/**
 * Look at ONE pending task's result file. Cheap enough to run from that task's watcher, the
 * 2s poll, a ping, the timeout and the death path alike — which is exactly how "first valid
 * wins across channels" is implemented: every channel ends here.
 *
 * After F2 a task reads only its OWN directory, so there is no directory listing and no
 * filename-to-task-id derivation left: a file that is not this task's cannot even be looked
 * at, let alone settle it.
 */
function scanEntry(entry: BgPending): void {
  if (entry.settled) {
    return;
  }
  const file = bgResultFilePath(entry.id);
  // The file's existence is itself progress (A6), whether or not it parses yet.
  noteResultFileProgress(entry, file);
  const read = readResultFile(file, entry.id, entry.ioToken);
  switch (read.kind) {
    case 'absent':
      return;
    case 'rejected':
      noteRejectedResult(entry, file, read.reason);
      return;
    case 'unreadable':
      settleFailed(entry, read.message);
      return;
    case 'result':
      if (read.status === 'done') {
        settleDone(entry, read.report);
      } else {
        settleWorkerError(entry, read.report);
      }
  }
}

/** Every pending task's file, in one pass — the shared poll's tick. */
function scanResults(): void {
  if (pending.size === 0) {
    return;
  }
  // Iterated over a COPY: settling removes the entry from the map underneath us.
  for (const entry of [...pending.values()]) {
    scanEntry(entry);
  }
}

/**
 * Record a refused result file in the unmatched ring (F2.1), once per distinct version of
 * that file. Nothing is deleted here: while the dispatch is live the file is evidence, and
 * a refusal handler that removed another writer's file would also remove the retry a worker
 * is about to make with the right token. Settle-time cleanup takes the whole directory.
 */
function noteRejectedResult(entry: BgPending, file: string, reason: string): void {
  let signature = 'unknown';
  try {
    const stat = fs.statSync(file);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // vanished between the read and now — the signature stays coarse, which at worst
    // reports the same refusal twice
  }
  if (entry.lastRejectSignature === signature) {
    return;
  }
  entry.lastRejectSignature = signature;
  pushUnmatchedEntry(`result file ${file}`, reason, '');
}

/**
 * Arm the result channel for one task: a watch on its own io directory (the fast path) plus
 * the shared 2s poll (the guarantee). The directory already exists — the task file was
 * written into it before the spawn — and is recreated defensively here so a watch is still
 * possible if something removed it in between.
 */
function armResultWatch(entry: BgPending): void {
  const dir = bgIoTaskDirPath(entry.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // cannot create it — the worker's write will fail too and the ping grace / timeout
    // paths report that honestly; watching is simply skipped
  }
  try {
    const watcher = fs.watch(dir, () => {
      try {
        scanEntry(entry);
      } catch {
        // a watch callback that throws would surface as an uncaught exception in the
        // server's event loop; the poll tick behind it retries anyway
      }
    });
    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {
        // already closed
      }
      if (entry.watcher === watcher) {
        entry.watcher = undefined;
      }
    });
    entry.watcher = watcher;
  } catch {
    // directory watch unsupported here — the poll below still finds the file
  }
  if (resultsPoll === undefined) {
    resultsPoll = setInterval(() => {
      try {
        scanResults();
      } catch {
        // a poll tick must never throw into the event loop
      }
    }, RESULT_POLL_MS);
    resultsPoll.unref?.();
  }
}

/** Release a settled task's watch, and the shared poll once nothing is pending at all. */
function disarmResultWatch(entry: BgPending): void {
  if (entry.watcher !== undefined) {
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    entry.watcher = undefined;
  }
  if (pending.size === 0 && resultsPoll !== undefined) {
    clearInterval(resultsPoll);
    resultsPoll = undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Settle gate — ONE task, ONE result, first valid wins across every channel
 * ------------------------------------------------------------------------- */

function clearEntryTimers(entry: BgPending): void {
  for (const timer of entry.timers) {
    clearTimeout(timer);
  }
  entry.timers.clear();
  if (entry.livenessTimer !== undefined) {
    clearInterval(entry.livenessTimer);
    entry.livenessTimer = undefined;
  }
}

/**
 * The single settle gate. Every terminal path (result file, ping grace, timeout, worker
 * death, cancellation) goes through it, so a later signal — a file landing after the
 * timeout, a duplicate ping, a death detected just after success — is a guarded no-op
 * rather than a double resolution.
 */
function settle(entry: BgPending, deliver: () => void): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  clearEntryTimers(entry);
  pending.delete(entry.id);
  disarmResultWatch(entry);
  deliver();
}

function settleDone(entry: BgPending, report: string): void {
  settle(entry, () => entry.resolve(report));
}

function settleFailed(entry: BgPending, message: string): void {
  settle(entry, () => entry.reject(new Error(message)));
}

/**
 * The worker reported a FAILURE through its result file. It consumes the attempt and
 * surfaces: no cooldown, no failover, no reclassification of any kind.
 *
 * A16 — WHY the report is NOT run through isQuotaError, so that nobody adds it back.
 * F10b did exactly that for one fix wave (a quota-shaped report cooled the account down and
 * failed the task over, "matching how the `-p` core classifies worker output"), and it was
 * reverted deliberately:
 *
 *   - The one-shot core does NOT regex worker prose either. It introduced typed errors
 *     (WorkerTimeoutError, WorkerKilledError) precisely so that a message embedding a
 *     worker's own output is never classified, because doing so "would put a healthy worker
 *     on a cooldown and fail the task over". A worker's authored REPORT is that same kind of
 *     text, and it is worse: the report is prose the worker chose to write.
 *   - In THIS project's domain the false positive is not exotic, it is the norm: the
 *     workers here reason about quota handling, so honest reports legitimately contain
 *     "429", "rate limit" and "usage limit reached" as the SUBJECT of the work rather than
 *     as a symptom of it.
 *   - The two errors are not symmetric. A false positive re-runs the task on a second
 *     account in the SAME worktree while the first worker may still be alive — two sessions
 *     editing one tree, plus a cooldown on an account that did nothing wrong. A false
 *     negative merely surfaces the worker's honest error to the orchestrator, which is the
 *     one who can read it.
 *   - Genuine mid-run exhaustion is already covered, and covered better: the A6 quota-stall
 *     rung reads authoritative plan usage (BgQuotaStallError) rather than prose.
 *
 * With no failover left on this path there is also nothing to clean up: the stale result
 * file that F10b had to unlink before a failover settle (the next attempt would reuse this
 * task id, this directory and this path, and settle instantly on the previous worker's
 * report) cannot strand anything, because this failure ends the dispatch. Settle-time
 * cleanup removes the whole io directory moments later.
 */
function settleWorkerError(entry: BgPending, report: string): void {
  settle(entry, () => entry.reject(new BgWorkerReportError(report)));
}

/** Arm a per-task timer that is cleared on settle and never pins the event loop. */
function armTimer(entry: BgPending, ms: number, fn: () => void): void {
  if (entry.settled) {
    return;
  }
  const timer = setTimeout(() => {
    entry.timers.delete(timer);
    fn();
  }, ms);
  timer.unref?.();
  entry.timers.add(timer);
}

/* ------------------------------------------------------------------------- *
 * MESSAGE channel (P4.1) — short signals only; the payload rides the file
 * ------------------------------------------------------------------------- */

/**
 * One worker message held for the orchestrator to read with mesh_receive (A13).
 *
 * The message is kept whole rather than pre-rendered: the renderer (renderInboundMessage,
 * plus the QUESTION marker) belongs to the tool that answers the call, and a stored string
 * could never be re-rendered differently.
 */
export interface BgFeedEntry {
  /** Monotonic id. The read cursor is what makes "unread" a fact rather than a guess. */
  seq: number;
  msg: InboundMeshMessage;
  /** The worker's own note — a STATUS note, or the first line of a plain message. */
  note: string;
  /** The note carries a `QUESTION:` marker (A13-R2): a blocked worker waiting on an answer. */
  question: boolean;
}

/** Live-feed depth. Bounded like every other buffer here; oldest dropped first. */
const FEED_MAX = 200;
/**
 * QUESTION stays a STATUS CONVENTION, never a third first-line kind (A13-R2): the signal
 * parser is unchanged, and visibility is purely render-side. `\b` so a note that merely
 * mentions "…QUESTIONS:" plural does not masquerade as one.
 */
const FEED_QUESTION_RE = /\bQUESTION:/;

const feed: BgFeedEntry[] = [];
let feedSeq = 0;
/** Highest seq already handed to mesh_receive; everything above it is unread. */
let feedCursor = 0;

/** One parked mesh_receive long-poll, resolved by the next push or by its own deadline. */
interface FeedWaiter {
  resolve(entries: BgFeedEntry[]): void;
  max: number;
  timer: NodeJS.Timeout;
}
const feedWaiters: FeedWaiter[] = [];

/** Unread entries, oldest first, up to `max`; advances the read cursor past what it returns. */
function takeFeed(max: number): BgFeedEntry[] {
  const out: BgFeedEntry[] = [];
  for (const entry of feed) {
    if (entry.seq <= feedCursor) {
      continue;
    }
    out.push(entry);
    if (out.length >= max) {
      break;
    }
  }
  if (out.length > 0) {
    feedCursor = out[out.length - 1].seq;
  }
  return out;
}

/** Hand buffered messages to parked mesh_receive calls, FIFO, each taking up to its own cap. */
function wakeFeedWaiters(): void {
  while (feedWaiters.length > 0) {
    const ready = takeFeed(feedWaiters[0].max);
    if (ready.length === 0) {
      return;
    }
    const waiter = feedWaiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(ready);
  }
}

/**
 * Append one worker message to the live feed (A13).
 *
 * Eviction moves the read cursor forward past anything it drops: an entry that fell out of
 * the ring can never be returned, so counting it as "unread" would leave mesh_status
 * advertising messages nobody can ever read.
 */
function pushFeed(msg: InboundMeshMessage, note: string): void {
  const clean = safeNote(note);
  feed.push({
    seq: ++feedSeq,
    msg,
    note: clean,
    question: FEED_QUESTION_RE.test(clean),
  });
  while (feed.length > FEED_MAX) {
    const dropped = feed.shift()!;
    if (dropped.seq > feedCursor) {
      feedCursor = dropped.seq;
    }
  }
  wakeFeedWaiters();
}

/**
 * Long-poll the live feed — mesh_receive's engine, shaped exactly like gateway.receive():
 * return what is buffered immediately, otherwise park a waiter that the next push or the
 * deadline resolves. No polling loop, and the deadline timer is unref'd so a parked call
 * can never hold the process up.
 */
export function bgReceiveFeed(maxWaitMs: number, maxMessages: number): Promise<BgFeedEntry[]> {
  const ready = takeFeed(maxMessages);
  if (ready.length > 0) {
    return Promise.resolve(ready);
  }
  if (maxWaitMs <= 0) {
    return Promise.resolve([]);
  }
  return new Promise<BgFeedEntry[]>((resolve) => {
    const waiter: FeedWaiter = {
      resolve,
      max: maxMessages,
      timer: setTimeout(() => {
        const i = feedWaiters.indexOf(waiter);
        if (i >= 0) {
          feedWaiters.splice(i, 1);
        }
        resolve([]);
      }, maxWaitMs),
    };
    waiter.timer.unref?.();
    feedWaiters.push(waiter);
  });
}

/**
 * Feed counters for the mesh_status header (A13-R3). Purely feed-derived: "unread" means
 * "not yet returned by mesh_receive", and there is deliberately no answered-state
 * bookkeeping — the line is a mechanical self-advertisement of the channel, not a task
 * tracker.
 */
export function bgFeedStatus(): {
  unread: number;
  questions: number;
  oldestQuestionFrom?: string;
  oldestQuestionAt?: number;
} {
  let unread = 0;
  let questions = 0;
  let oldest: BgFeedEntry | undefined;
  for (const entry of feed) {
    if (entry.seq <= feedCursor) {
      continue;
    }
    unread++;
    if (entry.question) {
      questions++;
      oldest = oldest ?? entry;
    }
  }
  return {
    unread,
    questions,
    oldestQuestionFrom: oldest === undefined ? undefined : (oldest.msg.fromName ?? oldest.msg.from),
    oldestQuestionAt: oldest?.msg.receivedAt,
  };
}

/**
 * THE single outbound path to a worker (A13): the mesh_send_worker tool and the A6 silence
 * nudge both call this, so there is one place where orchestrator→worker messages are built.
 *
 * A13-R1, BINDING: nothing in this function — or in any caller's path around it — may mark
 * activity. Activity is evidence that the WORKER produced something; if sending to a worker
 * counted as activity, steering a wedged, silent or dead session would reset its silence
 * clock and hide it from both the A6 recovery rung and the idle sweep, which exist precisely
 * to notice that a worker stopped working. A healthy worker marks itself alive by sending
 * its own STATUS.
 *
 * A summary is DEFAULTED rather than omitted because the upstream SendMessage tool rejects a
 * plain-text message without one ("RELAY JSON missing required summary field", scenario-B
 * probe H5) — an omitted summary would surface as a transport error nobody could act on.
 */
export function bgSendToWorker(
  gateway: IGatewayManager,
  opts: { to: string; message: string; summary?: string },
): Promise<RelayResult> {
  const fallback = firstLine(opts.message).slice(0, 60) || 'orchestrator message';
  // A blank summary counts as ABSENT, not as a value: it is well-formed and meaningless,
  // and the transport rejects it exactly as it rejects a missing one.
  const provided = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  const summary = (provided === '' ? fallback : provided).slice(0, SUMMARY_MAX);
  return gateway.send({ to: opts.to, summary, message: opts.message });
}

/**
 * One entry in the unmatched ring. `from` is deliberately not restricted to a sender name:
 * the ring holds every signal that reached us and matched no pending dispatch, and after F2
 * that includes a RESULT FILE we refused (whose "sender" is the file's path). A refused file
 * that never appeared anywhere would be a silent hole exactly where forgery would show up.
 */
function pushUnmatchedEntry(from: string, reason: string, text: string, at?: number): void {
  unmatchedTotal++;
  unmatched.push({
    // A message carries its own receipt time; a file has none, so the observation time is
    // the only honest timestamp for it.
    at: typeof at === 'number' && isFinite(at) ? at : Date.now(),
    from,
    reason,
    text,
  });
  while (unmatched.length > UNMATCHED_RING_MAX) {
    unmatched.shift();
  }
}

function pushUnmatched(msg: InboundMeshMessage, reason: string): void {
  pushUnmatchedEntry(msg.fromName ?? msg.from, reason, safeNote(msg.text), msg.receivedAt);
}

/** Record a STATUS note on the task and echo it into the live output file (best effort). */
function recordStatusNote(entry: BgPending, note: string): void {
  // Marked before the empty-note bail: a STATUS carrying nothing quotable still proves the
  // worker is awake, and it may arrive with no fromName at all (amendment A2), in which case
  // this is the only place the silence clock hears about it.
  noteEntryProgress(entry);
  const clean = safeNote(note);
  if (clean === '') {
    return;
  }
  entry.statusNotes.push(clean);
  try {
    fs.appendFileSync(entry.outputFile, `\n> [STATUS ${new Date().toISOString()}] ${clean}\n`);
  } catch {
    // the note is already kept in memory for the diagnostics tail — a write failure here
    // must never affect the dispatch
  }
}

/**
 * An accepted RESULT ping. The ping is only a WAKE: it triggers an immediate read of the
 * task's result file, and if the file still is not there after the grace it settles the
 * task on its own so a worker that could not write its io directory (permissions, a
 * revoked `--add-dir` grant) does not simply time out with no explanation.
 */
function onResultPing(entry: BgPending, status: 'done' | 'error', note: string): void {
  noteEntryProgress(entry);
  scanEntry(entry);
  if (entry.settled || entry.pingGraceArmed) {
    return;
  }
  entry.pingGraceArmed = true;
  const clean = safeNote(note);
  armTimer(entry, PING_GRACE_MS, () => {
    scanEntry(entry);
    if (entry.settled) {
      return;
    }
    // A REFUSED file is a different diagnosis from a missing one (F2.1): the worker did
    // write, and telling the reader "no result file appeared" would send them looking for a
    // permissions problem that is not there.
    const refused =
      entry.lastRejectSignature === undefined
        ? ''
        : ' A result file WAS found at that path and REFUSED — its io token or task id did not ' +
          "match this dispatch, so it settled nothing; see mesh_status's unmatched signals for " +
          'the exact mismatch.';
    const report =
      `(worker reported ${status} but no readable result file appeared — inspect ${workTreeDescription(entry)}; ` +
      `the worker may have been unable to write ${bgResultFilePath(entry.id)}.${refused})` +
      (clean === '' ? '' : `\nworker note: ${clean}`);
    if (status === 'done') {
      settleDone(entry, report);
    } else {
      settleFailed(entry, report);
    }
  });
}

/**
 * Is this sender one of THIS workspace's own dispatch workers?
 *
 * Answered from the NAME alone, with no ledger or session-dir read, because the name
 * already carries the proof: meshWorkerName embeds this workspace's hash, and
 * parseMeshWorkerName only accepts names it minted for this cwd. That matters on the drain
 * path, which sees every inbound message — a ledger read per message would put file IO in
 * the hot loop to learn something the string already says. It is deliberately broader than
 * "has a live ledger record": a worker whose record was lost is still ours, and its
 * messages still belong in the feed rather than in the stray ring.
 */
function isOurWorkerName(fromName: string): boolean {
  return fromName !== '' && parseMeshWorkerName(fromName, process.cwd()) !== undefined;
}

/**
 * Route one inbound gateway message (P4.1, extended by A13).
 *
 * Four destinations, and which one a message reaches is the whole of the routing contract:
 *   - a RESULT ping for a PENDING task from ITS OWN worker settles that task and is
 *     CONSUMED — never surfaced, because the orchestrator receives the result through the
 *     dispatch call itself and a duplicate copy in the feed would just be noise;
 *   - a STATUS note goes to the task's output file, the diagnostics tail, and the LIVE
 *     FEED, which is how a worker's progress and its `QUESTION:` lines reach the
 *     orchestrator between steps;
 *   - anything else from one of our own workers goes to the live feed (A13: the live
 *     channel is conversational, so a worker's plain reply is not a stray);
 *   - everything else — a forged or crossed RESULT, a signal for a task nobody is running,
 *     a message from a session we do not own — lands in the unmatched ring, which settles
 *     nothing and only ever shows up in diagnostics.
 */
function routeInbound(msg: InboundMeshMessage, pool: IWorkerPool): void {
  const fromName = typeof msg.fromName === 'string' ? msg.fromName.trim() : '';
  if (fromName !== '') {
    // Any message from a known worker is activity for the idle clock; markActivity is a
    // no-op for a name the ledger does not know, so unknown senders cost nothing.
    try {
      pool.markActivity(fromName);
    } catch {
      // ledger write races are not this loop's problem
    }
    // The same event, recorded on the in-process silence clock (A6). Both clocks are fed
    // from this one call site, so the idle sweep and the silence check can never disagree
    // about whether a worker has spoken. Note that INBOUND is the only feeder of either
    // clock — an outbound steering message must never touch them (A13-R1).
    markPendingProgress(fromName);
  }
  const ours = isOurWorkerName(fromName);
  const signal = parseWorkerSignal(msg.text);
  if (signal === undefined) {
    // Not a signal. From one of our workers this is exactly what the live channel is for
    // (a reply, a question in prose, a note); from anyone else it is a stray.
    if (ours) {
      pushFeed(msg, firstLine(msg.text));
    } else {
      pushUnmatched(msg, 'not a RESULT/STATUS signal, and not from a worker of this workspace');
    }
    return;
  }
  const entry = pending.get(signal.taskId);
  const pendingEntry = entry !== undefined && !entry.settled ? entry : undefined;
  if (signal.kind === 'status') {
    if (pendingEntry !== undefined) {
      recordStatusNote(pendingEntry, signal.note);
    }
    // Surfaced when it is attributable at all: STATUS is routed by task id and is NOT gated
    // on fromName (amendment A2 — cross-account inbounds may carry no fromName), so a note
    // for a task we are running counts even from an unnamed sender.
    if (ours || pendingEntry !== undefined) {
      pushFeed(msg, signal.note);
    } else {
      pushUnmatched(msg, `STATUS for task ${signal.taskId}, which no dispatch of ours is running`);
    }
    return;
  }
  if (pendingEntry === undefined) {
    pushUnmatched(msg, `no pending dispatch for task ${signal.taskId}`);
    return;
  }
  // Anti-crosstalk (P4.1): a RESULT ping is accepted only from the task's OWN worker.
  if (fromName !== pendingEntry.workerName) {
    pushUnmatched(
      msg,
      `RESULT for ${signal.taskId} from "${fromName === '' ? '(no fromName)' : fromName}", ` +
        `which is not its worker ${pendingEntry.workerName}`,
    );
    return;
  }
  onResultPing(pendingEntry, signal.status, signal.note);
}

/**
 * The single persistent inbound consumer (P4.1). One loop for the whole server: parking
 * a receive() per pending task would let a STATUS flood evict a RESULT ping from another
 * task's poll window, and would leave receive() blocked across a settle.
 *
 * The loop never fails a dispatch: a permanently down gateway only costs the ping/STATUS
 * channel, and results still settle from their files.
 */
async function drainLoop(gateway: IGatewayManager, pool: IWorkerPool): Promise<void> {
  while (gateway.state !== 'stopped') {
    let messages: InboundMeshMessage[] = [];
    try {
      messages = await gateway.receive(DRAIN_RECEIVE_WAIT_MS, DRAIN_RECEIVE_MAX);
    } catch {
      // receive() is specified never to reject; if it ever does, back off rather than
      // spin the CPU against a broken gateway.
      await delay(DRAIN_ERROR_BACKOFF_MS);
      continue;
    }
    for (const msg of messages) {
      try {
        routeInbound(msg, pool);
      } catch {
        // one malformed message must never end the drain for every other task
      }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Timeout (P4.3) and worker death (P4.4)
 * ------------------------------------------------------------------------- */

/**
 * Where this task's work actually landed, in words a failure message can use (A11). In a
 * git workspace that is the task's own worktree, NOT the shared checkout — telling a reader
 * to "inspect the working tree" after a `-w` dispatch would send them to a directory the
 * worker never touched.
 */
function workTreeDescription(entry: BgPending): string {
  return entry.worktree === undefined
    ? 'the working tree'
    : `this task's worktree ${entry.worktree}${entry.branch === undefined ? '' : ` (branch ${entry.branch})`}`;
}

/** Last STATUS notes plus the unmatched-signal count, appended to every failure message. */
function diagnosticsTail(entry: BgPending): string {
  const notes = entry.statusNotes.slice(-STATUS_TAIL_MAX);
  const statusPart =
    notes.length > 0
      ? `Last ${notes.length} STATUS note(s) from the worker:\n${notes.map((n) => `- ${n}`).join('\n')}`
      : 'The worker sent no STATUS notes.';
  const strays = Math.max(0, unmatchedTotal - entry.unmatchedAtStart);
  // The nudge count answers the first question a reader of this failure has: was the worker
  // simply never prodded, or did it ignore being prodded?
  const nudgePart =
    entry.nudgeCount === 0
      ? ''
      : `\n\nSilence nudges sent to the worker through the relay: ${entry.nudgeCount} ` +
        '(it was alive but producing nothing; delivery through the relay is best-effort).';
  // The one stray that changes what a reader should do next: a result file that EXISTED and
  // was refused means the worker reported and the report was rejected, not that it never
  // reported at all (F2.1).
  const refusedPart =
    entry.lastRejectSignature === undefined
      ? ''
      : `\n\nA result file at ${bgResultFilePath(entry.id)} was found and REFUSED: its io token ` +
        'or task id did not match this dispatch, so it could not settle the task no matter how ' +
        'well-formed it was (the exact mismatch is in mesh_status\'s unmatched signals). Something ' +
        'wrote a result for this task that this dispatch could not accept — treat that as a ' +
        'finding, not as "the worker produced nothing".';
  return (
    `${statusPart}\n\nUnmatched mesh signals while this task ran: ${strays} ` +
    '(messages whose task id, sender or shape matched no pending dispatch — see mesh_status).' +
    nudgePart +
    refusedPart
  );
}

/**
 * The wall-clock limit fired. Same clamp and default as `-p`, and the same consequence:
 * the worker is STOPPED. Unlike `-p` there is no captured stdout to attach — the report
 * travels through a file that never appeared — so the message says what to inspect
 * instead. The leading prose is deliberately longer than 300 characters and carries no
 * worker-supplied text: recordFailure slices lastError to 300 chars for the tree view.
 */
function timeoutMessage(entry: BgPending): string {
  return (
    `Persistent worker ${entry.workerName} (account ${entry.account}) did not report within ` +
    `${entry.timeoutMinutes} minutes ` +
    'and was STOPPED. Unlike a one-shot worker it wrote no stdout to capture: its report travels ' +
    `through ${bgResultFilePath(entry.id)}, which never appeared. Whatever the worker wrote ` +
    `persists in ${workTreeDescription(entry)}, so inspect that before re-dispatching; if the task ` +
    'legitimately needs longer, re-dispatch it with a larger timeout_minutes. Not retried on ' +
    'another account (a timeout is not a quota failure).\n\n' +
    diagnosticsTail(entry)
  );
}

/** The worker's session went away before it reported. `detail` is the liveness evidence. */
function deathMessage(entry: BgPending, detail: string): string {
  return (
    `Persistent worker ${entry.workerName} (account ${entry.account}) died before reporting its ` +
    `result — ${detail}. Nothing ` +
    `readable appeared at ${bgResultFilePath(entry.id)} within the ${Math.round(
      DEATH_GRACE_MS / 1000,
    )}s grace after its session disappeared, so the task is incomplete. Whatever the worker wrote ` +
    `persists in ${workTreeDescription(entry)} — inspect that before re-dispatching. Not retried on ` +
    'another account (a dead session is not a quota failure, and a replacement would redo work ' +
    'that may be half-done).\n\n' +
    diagnosticsTail(entry)
  );
}

async function onTimeout(entry: BgPending): Promise<void> {
  if (entry.settled) {
    return;
  }
  // Stop first: a worker that has blown its budget must stop burning quota even if the
  // read below turns out to settle the task successfully.
  try {
    await entry.pool.stop(entry.workerName, { force: true });
  } catch {
    // the reaper and session-end stop are the backstops for a stop that failed here
  }
  if (entry.settled) {
    return;
  }
  // ONE final read: if the worker wrote its result and simply never got a ping through,
  // the work stands and the dispatch is done even though we just stopped the session.
  scanEntry(entry);
  if (entry.settled) {
    return;
  }
  // Keep the task settleable for a last grace — a file or ping landing here still wins.
  armTimer(entry, POST_TIMEOUT_GRACE_MS, () => {
    scanEntry(entry);
    if (entry.settled) {
      return;
    }
    // Typed so the attempt loop's cancel-parity guard (F3b) can recognise it: if a tree
    // cancel or the reaper already authored this task's terminal event while the grace ran,
    // the timeout must not overwrite it or charge the account for it.
    settle(entry, () => entry.reject(new BgTimeoutError(timeoutMessage(entry))));
  });
}

/**
 * Death does NOT reject immediately: workers commonly die RIGHT AFTER success (result
 * written, then stopped or closed before the next poll tick). Read once now, then hold
 * the task for one more grace during which files and pings still settle it normally.
 */
function onDeath(entry: BgPending, detail: string): void {
  if (entry.settled || entry.deathPending) {
    return;
  }
  entry.deathPending = true;
  if (entry.livenessTimer !== undefined) {
    clearInterval(entry.livenessTimer);
    entry.livenessTimer = undefined;
  }
  scanEntry(entry);
  if (entry.settled) {
    return;
  }
  armTimer(entry, DEATH_GRACE_MS, () => {
    scanEntry(entry);
    if (entry.settled) {
      return;
    }
    // Typed for the same reason as the timeout above (F3b): a session the user cancelled
    // through the tree view is a session that "died", and reporting that as a worker death
    // would both overwrite the cancel and put a failure on the account's record.
    settle(entry, () => entry.reject(new BgWorkerDeathError(deathMessage(entry, detail))));
  });
}

/* ------------------------------------------------------------------------- *
 * Silent-worker recovery (A6) — the rung between "alive" and "timed out"
 * ------------------------------------------------------------------------- */

/**
 * The newest activity instant for this task, read from the SAME inputs the idle sweep uses.
 *
 * `lastProgressAt` covers what this process observed directly (spawn, every inbound message,
 * the result file's mtime); `bgIdleActivityAt` covers what the LEDGER records (the pool's own
 * spawn/markActivity writes, plus the session-entry touch if IDLE_COUNTS_REGISTRY_UPDATED_AT
 * is ever flipped). Taking the newest of both is what makes "A6-silent" and "idle-active"
 * impossible to hold at once: they are the same evidence, read through one helper, differing
 * only in how long a gap each tolerates.
 *
 * The ledger read is deliberately NOT done on every poll tick — see checkSilentWorker.
 */
function newestActivityAt(entry: BgPending): number {
  let at = entry.lastProgressAt;
  try {
    for (const worker of entry.pool.list()) {
      if (worker.name === entry.workerName) {
        at = Math.max(at, bgIdleActivityAt(worker));
        break;
      }
    }
  } catch {
    // Unreadable ledger: the in-process clock alone decides. It is the stricter of the two
    // (it also counts file writes), so this degrades to "recover a bit more eagerly", never
    // to "recover on a worker that is demonstrably busy".
  }
  return at;
}

/**
 * The task's wall-clock deadline has passed, so the TIMEOUT path owns it from here.
 *
 * Without this the two paths race in the last seconds of a long dispatch: a recovery pass
 * that started just before the deadline could finish just after it and settle the task as a
 * quota failover moments after the timeout had already stopped the worker. Both outcomes are
 * defensible, but only one may happen, and the deadline is the older and more predictable
 * authority — a task that has run out of time has run out of time.
 */
function pastDeadline(entry: BgPending): boolean {
  return Date.now() - entry.spawnedAt >= entry.timeoutMinutes * 60_000;
}

/**
 * Exhausted plan windows that APPLY to this task's model — pickWorker's filter, verbatim:
 * session and weekly_all always count, while the Fable-only weekly_scoped window counts only
 * for a frontier candidate. The canonical exhaustedWindows() verdict (≥ 99% and not yet
 * reset) is the ONLY definition used here: a softer percent heuristic would fail a task over
 * on an account with real headroom, and the account that triggered this amendment sat at 89%
 * — high, but genuinely not exhausted, which is why the nudge below is the primary recovery.
 */
function exhaustedForTask(entry: BgPending, cache: UsageCache): UsageWindow[] {
  return exhaustedWindows(cache[entry.configDir], Date.now()).filter(
    (win) =>
      win.kind === 'session' ||
      win.kind === 'weekly_all' ||
      (win.kind === 'weekly_scoped' && isFrontierTier(entry.model)),
  );
}

/**
 * The worker went quiet and its account has no quota left. Leading prose is deliberately
 * longer than 300 characters and carries no worker-supplied text: recordFailure slices
 * lastError to 300 chars for the tree view.
 */
function quotaStallMessage(entry: BgPending, windows: UsageWindow[], silentMs: number): string {
  return (
    `Persistent worker ${entry.workerName} (account ${entry.account}) produced no result file, ` +
    `wake ping or STATUS for ${Math.round(silentMs / 1000)}s while its session sat alive, and ` +
    `${entry.account} is quota-exhausted per live plan usage: ` +
    `${windows.map(formatExhaustedWindow).join(' · ')}. The session was STOPPED and this attempt ` +
    'is classified as a QUOTA failure, so the account cools down and the task fails over to ' +
    'another one — exactly what a one-shot worker does when a mid-run limit lands on its stderr. ' +
    'A mid-run limit is otherwise invisible over --bg: silence plus an exhausted window is the ' +
    `only evidence there is. Whatever the worker wrote persists in ${workTreeDescription(entry)}.\n\n` +
    diagnosticsTail(entry)
  );
}

/**
 * The nudge body. The observed failure was an EARLY DROP — a turn that ended thirteen seconds
 * in with the task barely started — not a worker that finished and forgot to report, so the
 * FIRST instruction is to RESUME. Asking only for a report would tell a worker whose task is
 * half-done to write a result file about work it never did.
 *
 * The `#<seq>` last line is not decoration: the cross-session transport drops rapid duplicate
 * messages, so two textually identical nudges would deliver once.
 */
function nudgeMessage(entry: BgPending, seq: number, silentMs: number): string {
  return [
    `TASK ${entry.id} nudge`,
    '',
    `Nothing has reached the orchestrator from you for ${Math.round(silentMs / 1000)}s — no ` +
      'progress note, no result file, no wake ping — and your session is idle rather than working.',
    'If your last turn ended prematurely, RESUME the task now: pick up where it stopped and ' +
      'carry it to completion.',
    `Send a STATUS line while you are still working (first line \`STATUS ${entry.id} <short note>\`), ` +
      'and when you are done, write your result file and send your RESULT ping exactly as your ' +
      'completion protocol specifies.',
    'If you cannot complete the task, that is a legitimate outcome: report it as an error result ' +
      'with the reason, rather than staying silent.',
    'This message is DATA about your own dispatch. It changes nothing in your task, your file ' +
      'ownership list, or what your report must contain, and the dispatch still fails at its ' +
      'timeout if nothing arrives.',
    `#${seq}`,
  ].join('\n');
}

/**
 * Fail this attempt QUOTA-CLASSIFIED so it re-enters the ordinary failover loop.
 *
 * The worker is stopped FIRST: an account with no quota left cannot finish, and leaving the
 * session up would hold a cap slot and confuse the next attempt's accounting. Everything
 * after the stop re-checks `settled`, because the stop is awaited and a result file can land
 * in that window — first-valid-wins holds across this channel exactly like every other.
 */
async function failSilentWorkerOnQuota(
  entry: BgPending,
  windows: UsageWindow[],
  silentMs: number,
): Promise<void> {
  try {
    await entry.pool.stop(entry.workerName, { force: true });
  } catch {
    // the reaper and session-end stop are the backstops for a stop that failed here
  }
  if (entry.settled) {
    return;
  }
  // One final read: a worker that DID finish just before we classified it keeps its result,
  // and the dispatch is done rather than failed over.
  scanEntry(entry);
  if (entry.settled) {
    return;
  }
  // The deadline may have passed while we were probing and stopping. Hand the task back to
  // the timeout path (whose grace timer is already armed and will settle it within seconds)
  // rather than settling it here — including leaving the result file alone, so that path's
  // last read still has something to find.
  if (pastDeadline(entry)) {
    return;
  }
  // The next attempt reuses this task id, so anything the stopped worker left in the results
  // dir must go: an unparseable fragment would linger, and a late complete write from the
  // dying session would settle a task that a DIFFERENT worker is now running. (The one write
  // that can still slip through is one already in flight inside the session we just stopped;
  // its content would at worst be this same task's honest report.)
  try {
    fs.unlinkSync(bgResultFilePath(entry.id));
  } catch {
    // never written, already gone — either way there is nothing to strand
  }
  settle(entry, () =>
    entry.reject(new BgQuotaStallError(quotaStallMessage(entry, windows, silentMs))),
  );
}

/**
 * Send ONE nudge to a silent worker through the relay. Strictly best effort: a rejection
 * (gateway_down, relay_timeout, a relay that never answered) is swallowed, because the nudge
 * is an optimization on top of the timeout, never a channel the dispatch depends on.
 */
async function nudgeSilentWorker(entry: BgPending, silentMs: number): Promise<void> {
  if (entry.nudgeCount >= NUDGE_MAX) {
    return;
  }
  const now = Date.now();
  if (entry.lastNudgeAt !== 0 && now - entry.lastNudgeAt < entry.nudgeAfterMs) {
    return;
  }
  const seq = entry.nudgeCount + 1;
  entry.nudgeCount = seq;
  entry.lastNudgeAt = now;
  // THE settle guard for this path, and the reason it sits exactly here: there is no `await`
  // between this check and the send() call below, so the event loop cannot settle the task in
  // between. A nudge can therefore never be addressed to a worker whose dispatch has already
  // finished, timed out, been cancelled, or failed over to another account.
  if (entry.settled) {
    return;
  }
  try {
    // Routed through the SAME send helper the mesh_send_worker tool uses (A13): one
    // outbound path, one place where the "a send never marks activity" rule (A13-R1) has
    // to hold. A nudge is outbound, so it must not reset the very silence clock that
    // decided to send it.
    await bgSendToWorker(entry.gateway, {
      to: entry.workerName,
      summary: `TASK ${entry.id} nudge`,
      message: nudgeMessage(entry, seq, silentMs),
    });
  } catch {
    // best effort by contract — the dispatch timeout remains the final backstop
  }
}

/**
 * One recovery pass over a worker that is alive and producing nothing.
 *
 * Order matters: quota is checked BEFORE the nudge, because nudging an account that has hit
 * its ceiling only burns the rest of the timeout on a worker that cannot answer. The usage
 * read is cached-first and pays for at most one live probe per silent episode, so a wedged
 * or unreachable CLI costs one bounded spawn, not one per poll tick.
 */
async function recoverSilentWorker(entry: BgPending, silentMs: number): Promise<void> {
  // An unreadable cache is "no reading", which can never produce an exhausted verdict — the
  // safe direction, since a false quota verdict would fail a healthy worker over.
  let cache: UsageCache = {};
  try {
    cache = readUsageCache();
  } catch {
    // readUsageCache already swallows its own errors; this is belt and braces
  }
  let windows = exhaustedForTask(entry, cache);
  if (windows.length === 0 && !entry.usageProbeSpent) {
    // Spent BEFORE the await: a probe that throws, times out or is still running must not
    // license a second one on the next tick.
    entry.usageProbeSpent = true;
    let probed: AccountUsage[] | null = null;
    try {
      probed = await refreshAllUsageIfStale(
        SILENCE_USAGE_MAX_AGE_MS,
        [{ name: entry.account, configDir: entry.configDir }],
        1,
        SILENCE_USAGE_PROBE_TIMEOUT_MS,
      );
    } catch {
      // documented never to reject; if it ever does, the cached verdict above stands
    }
    if (entry.settled || entry.deathPending) {
      return;
    }
    // Prefer the returned reading over a re-read: the cache write can fail (read-only tree,
    // full disk) while the probe itself succeeded, and a fresh answer must not be thrown away
    // because persisting it did not work. `null` means the cache was already fresh enough.
    const fresh = Array.isArray(probed)
      ? probed.find((usage) => usage.configDir === entry.configDir)
      : undefined;
    if (fresh !== undefined) {
      cache = { ...cache, [entry.configDir]: fresh };
    }
    windows = exhaustedForTask(entry, cache);
  }
  if (entry.settled || entry.deathPending) {
    return;
  }
  if (windows.length > 0) {
    await failSilentWorkerOnQuota(entry, windows, silentMs);
    return;
  }
  await nudgeSilentWorker(entry, silentMs);
}

/**
 * The poll-tick gate for the recovery rung (A6). Cheap check first — the in-process clock
 * alone rejects the overwhelming majority of ticks — and only a task that already looks
 * silent pays for the authoritative ledger read.
 *
 * `silenceBusy` is what keeps a slow pass (a 10s usage probe followed by a relay send that
 * can take up to RELAY_TIMEOUT_MS) from being re-entered by the next 15s tick, and the
 * recovery is fire-and-forget with BOTH settlement paths clearing the flag, so a throw can
 * never wedge the rung shut or escape into the event loop.
 */
function checkSilentWorker(entry: BgPending): void {
  if (entry.settled || entry.deathPending || entry.silenceBusy || pastDeadline(entry)) {
    return;
  }
  const now = Date.now();
  if (now - entry.lastProgressAt < entry.nudgeAfterMs) {
    return;
  }
  const silentMs = now - newestActivityAt(entry);
  if (silentMs < entry.nudgeAfterMs) {
    return;
  }
  entry.silenceBusy = true;
  void recoverSilentWorker(entry, silentMs).then(
    () => {
      entry.silenceBusy = false;
    },
    () => {
      entry.silenceBusy = false;
    },
  );
}

/**
 * One liveness probe. Death is (entry seen alive at least once, now dead) OR (no entry at
 * all within ENTRY_APPEAR_GRACE_MS of the spawn) — `--bg` returns before the session
 * registry entry is guaranteed written, so a young task with no entry is normal, not dead.
 *
 * An ALIVE worker is not automatically a working one, so the same tick carries the silence
 * check (A6): alive-and-idle is the state that used to burn a whole dispatch timeout.
 */
function onLivenessTick(entry: BgPending): void {
  if (entry.settled || entry.deathPending) {
    return;
  }
  let liveness: { entrySeen: boolean; alive: boolean; pid?: number };
  try {
    liveness = entry.pool.workerLiveness(entry.workerName);
  } catch {
    // An unreadable sessions dir is not evidence of death; wait for the next tick (and
    // ultimately the timeout, which is total).
    return;
  }
  if (liveness.alive) {
    entry.entryEverSeen = true;
    checkSilentWorker(entry);
    return;
  }
  const pidPart = typeof liveness.pid === 'number' ? ` (pid ${liveness.pid})` : '';
  if (entry.entryEverSeen) {
    onDeath(
      entry,
      liveness.entrySeen
        ? `its session-registry entry${pidPart} is no longer a running process`
        : 'its session-registry entry disappeared after having been live',
    );
    return;
  }
  if (Date.now() - entry.spawnedAt > ENTRY_APPEAR_GRACE_MS) {
    onDeath(
      entry,
      liveness.entrySeen
        ? `its session-registry entry${pidPart} was never a running process within ` +
            `${Math.round(ENTRY_APPEAR_GRACE_MS / 1000)}s of the spawn`
        : `no session-registry entry named ${entry.workerName} appeared within ` +
            `${Math.round(ENTRY_APPEAR_GRACE_MS / 1000)}s of the spawn (a Claude Code version ` +
            'whose session-entry format moved would look exactly like this)',
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Output-file rendering — the same surface a `-p` dispatch leaves behind
 * ------------------------------------------------------------------------- */

interface OutputContext {
  title: string;
  prompt: string;
  systemPromptSection: string;
  ultrathink: boolean;
  billableOverage: boolean;
  account: string;
  model: string;
  outputFile: string;
  /**
   * Filled in AFTER the spawn (A11): only the pool knows whether this workspace got a
   * worktree, so the RUNNING header is written without it and the DONE rewrite carries it.
   */
  worktree?: string;
  branch?: string;
}

function headerFlags(ctx: OutputContext): string {
  return (
    (ctx.ultrathink ? '\n- ultrathink: true' : '') +
    (ctx.billableOverage ? '\n- overage: billing past plan window' : '')
  );
}

/** RUNNING header + the prompt, written before the spawn so a live task is inspectable. */
function writeRunningOutput(ctx: OutputContext): void {
  try {
    fs.writeFileSync(
      ctx.outputFile,
      `# ${ctx.title}\n\n- status: RUNNING (started ${new Date().toISOString()})\n- worker: ${ctx.account}\n- model: ${ctx.model}${headerFlags(ctx)}\n\n---\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n`,
    );
  } catch {
    // best effort — the task still runs and the DONE/FAILED writer overwrites this
  }
}

/**
 * One line naming the task's worktree, for the surfaces that tell the orchestrator what it
 * now has to verify and merge (A11). Empty in a non-git workspace, where the worker edited
 * the tree directly and there is nothing extra to integrate.
 */
function worktreeLine(ctx: OutputContext): string {
  return ctx.worktree === undefined
    ? ''
    : `\n- worktree: ${ctx.worktree}${ctx.branch === undefined ? '' : ` (branch ${ctx.branch})`}`;
}

/**
 * DONE rewrite. Token/cost columns are zeros and labelled n/a on purpose: usage is
 * unknowable over `--bg` (there is no result JSON to read it from). Live PLAN usage is
 * unaffected — it is probed from the account itself, not accumulated here.
 */
function writeDoneOutput(ctx: OutputContext, workerName: string, report: string): void {
  try {
    fs.writeFileSync(
      ctx.outputFile,
      `# ${ctx.title}\n\n- worker: ${ctx.account}\n- model: ${ctx.model}${headerFlags(ctx)}\n- mesh: attachable worker ${workerName} (report relayed; tokens n/a)${worktreeLine(ctx)}\n- tokens: 0 in / 0 out\n\n---\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n\n## Result\n\n${report}\n`,
    );
  } catch {
    // the terminal event and the returned string already carry the result
  }
}

function writeFailedOutput(ctx: OutputContext, message: string): void {
  try {
    fs.writeFileSync(
      ctx.outputFile,
      `# ${ctx.title}\n\nFAILED: ${message}\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n`,
    );
  } catch {
    // the terminal event already records the failure
  }
}

/* ------------------------------------------------------------------------- *
 * The dispatch itself
 * ------------------------------------------------------------------------- */

/** What the server hands one `--bg` dispatch: the mesh runtime plus request scope. */
export interface BgRunContext {
  pool: IWorkerPool;
  gateway: IGatewayManager;
  /** This MCP server's pid — stamped on every worker record it owns (§2 ownership). */
  ownerPid: number;
  /** Owner start marker; a sanity token against a recycled pid, not a full guard. */
  ownerStartedAt: number;
  /** True when the owning request has been cancelled / the server is shutting down. */
  shouldAbort(): boolean;
  /** Claim the task id before the worker exists — a cancel in that window still lands. */
  onTrack(base: TaskBase): void;
  /** Terminal cleanup for this task id — runs in a finally after the dispatch settles. */
  onSettle(taskId: string): void;
}

/** Task identity carried on every event for this dispatch (never a pid — see P4.10). */
interface BgTaskBase extends TaskBase {
  promptPreview: string;
  meshWorker?: string;
}

/**
 * Identity the bootstrap prompt gives the worker.
 *
 * CONTRACT SEAM (flagged to the orchestrator): §2's bootstrap builder wants the mesh
 * worker NAME, but §3 has the pool choose that name (nextSeq/meshWorkerName) INSIDE
 * spawnDispatchWorker — and the bootstrap is that call's argv prompt, so the caller
 * cannot know it yet. A task-scoped identity is used instead: it is unique per dispatch,
 * true (the session exists only for this task), and cannot contradict the session's real
 * registry name, which is what the protocol actually keys on (the `--name` the pool
 * passes, the fromName gate, and `claude stop <jobId>`).
 */
function bootstrapIdentity(taskId: string): string {
  return `the dispatch worker for task ${taskId}`;
}

/**
 * Has somebody ELSE already authored a terminal event for this task? (F3b.)
 *
 * Returns the recorded reason when the task's latest event is terminal, and undefined when
 * the task is still `running`, has no events at all, or the log cannot be read.
 *
 * This is a cross-PROCESS question, which is why it is answered from the task log rather
 * than from anything in memory: a `--bg` worker is not this server's child, so the surfaces
 * that can end its task — the extension host's tree-view cancel, the orphan reaper — do it
 * by stopping the session and writing the terminal event themselves, with no way to tell
 * this process. From here that looks exactly like a worker death or a timeout.
 *
 * A read failure deliberately reads as "nobody else did" (undefined): the guard exists to
 * suppress a duplicate record, and suppressing a REAL failure record because the log was
 * briefly unreadable would lose the only evidence the dispatch failed at all.
 */
function foreignTerminalReason(taskId: string): string | undefined {
  let latest: TaskEvent | undefined;
  try {
    latest = latestEventById(taskId);
  } catch {
    return undefined;
  }
  if (latest === undefined || latest.status === 'running') {
    return undefined;
  }
  // `error` is where a cancel records its reason. Its absence still means terminal — the
  // event is what matters, not its text — so a fallback sentence stands in rather than an
  // empty message that would surface to the orchestrator as a blank failure.
  const recorded = typeof latest.error === 'string' ? latest.error.trim() : '';
  if (recorded !== '') {
    return recorded;
  }
  return latest.status === 'done'
    ? `task ${taskId} was already recorded as done by another surface (cancel or reap)`
    : `task ${taskId} was already recorded as failed by another surface (cancel or reap)`;
}

/**
 * Run ONE attempt: cap check, announce, spawn, then await the result. Returns the
 * worker's report; throws a quota-classified BgSpawnFailure or a BgQuotaStallError (the two
 * failover triggers), BgCapError, BgCancelledError, BgTimeoutError, BgWorkerDeathError,
 * BgWorkerReportError, or a plain Error for the remaining failure paths.
 */
async function runBgAttempt(opts: {
  id: string;
  /** Per-dispatch io token (F2.1) — told to the worker, required back in its result. */
  ioToken: string;
  ctx: BgRunContext;
  registry: Registry;
  worker: WorkerProfile;
  model: string;
  timeoutMinutes: number;
  ultrathink: boolean;
  base: BgTaskBase;
  output: OutputContext;
  onSpawned(info: { name: string; worktree?: string; branch?: string }): void;
}): Promise<string> {
  const { ctx, registry, worker, model, base, id } = opts;
  const spawned = await serializeWorkerOp(async (): Promise<WorkerSpawnResult> => {
    // P4.7: count and spawn inside ONE critical section, using the ledger formula (a
    // fresh spawn occupies its slot before its session entry lands), so a batch cannot
    // overshoot the cap. Refuse, never queue — queueing a >cap batch would deadlock
    // waiting for slots that only the caller could free.
    const cap = registry.meshMaxLiveWorkers;
    let live = 0;
    try {
      live = ctx.pool.liveOwnedCount();
    } catch {
      // an unreadable ledger must not brick dispatch; treat it as "no known live workers"
      live = 0;
    }
    if (live >= cap) {
      throw new BgCapError(
        meshError(
          'worker_cap',
          `${live} attachable workers are already live — the meshMaxLiveWorkers cap (${cap}) ` +
            'refuses new dispatch workers. Stop finished workers (mesh_stop_worker, or let idle ' +
            'auto-stop reap them) or raise "claudeCodeOrchestrator.meshMaxLiveWorkers".',
        ),
      );
    }
    // Announce only once the spawn is actually going to happen: a cap refusal must leave
    // no dangling `running` event behind (parity with the `-p` frontier-guard refusal).
    appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });
    ctx.onTrack(base);
    writeRunningOutput(opts.output);
    try {
      return await ctx.pool.spawnDispatchWorker({
        account: worker.name,
        configDir: worker.configDir,
        model,
        permissionMode: registry.permissionMode,
        // Fixed-size argv prompt: the task itself is in the file written before this call.
        prompt: bgDispatchBootstrapPrompt({
          workerName: bootstrapIdentity(id),
          taskId: id,
          gatewayName: ctx.gateway.name,
          // The workspace, not a path: the bootstrap derives the same absolute task/result
          // paths this module reads and the pool grants, from the one layout implementation.
          cwd: ioWorkspace(),
          // The worker must echo this token back inside its result JSON or the result is
          // refused (F2.1) — it rides both the argv prompt and the task file's header, so a
          // worker that lost one still has the other.
          ioToken: opts.ioToken,
          // Worktree detection is the SAME helper the pool spawns by (contract
          // isGitWorkspace), so the sentence the worker reads and the flag it actually
          // boots with cannot disagree — the bootstrap is built before the pool has run.
          worktree: isGitWorkspace(process.cwd()) ? bgWorktreePath(id) : undefined,
          ultrathink: opts.ultrathink,
        }),
        taskId: id,
        ownerPid: ctx.ownerPid,
        ownerStartedAt: ctx.ownerStartedAt,
      });
    } catch (err) {
      // The pool reports failures in its result object; a throw is unexpected, so it is
      // converted rather than allowed to break the serialization chain's contract.
      return { ok: false, error: `spawnDispatchWorker threw: ${(err as Error).message}` };
    }
  });
  if (spawned.ok !== true || typeof spawned.name !== 'string' || spawned.name === '') {
    const detail = spawned.error ?? 'the worker pool reported a failed spawn with no detail.';
    throw new BgSpawnFailure(detail, isQuotaError(detail));
  }
  const workerName = spawned.name;
  // The POOL is the authority on the worktree: it ran the git detection and it is the only
  // component that knows whether `-w` was actually passed. The bootstrap's own detection
  // above only decides what the worker is TOLD; what gets reported and merged comes from
  // here, so a disagreement can never invent a worktree that does not exist.
  const worktree = typeof spawned.worktree === 'string' ? spawned.worktree : undefined;
  const branch = typeof spawned.branch === 'string' ? spawned.branch : undefined;
  opts.onSpawned({ name: workerName, worktree, branch });
  opts.output.worktree = worktree;
  opts.output.branch = branch;
  // P4.5, booting state: a cancellation that landed while the spawn was in flight has no
  // worker to signal, so it is re-checked here — the just-spawned session must not be
  // left running for a request nobody is waiting on.
  if (ctx.shouldAbort()) {
    stopWorkerBestEffort(ctx.pool, workerName, true);
    throw new BgCancelledError();
  }
  // Re-announce with the worker name so every later event (including a terminal cancel
  // written by the server) names it. NEVER pid/pgid: the signal-based cancel paths and
  // isOurWorker must no-op on a bg task — its worker is not our child (P4.10).
  base.meshWorker = workerName;
  appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });
  ctx.onTrack(base);
  return awaitBgResult(opts.id, opts.ctx, opts.worker.name, workerName, opts.output.outputFile, {
    title: opts.output.title,
    timeoutMinutes: opts.timeoutMinutes,
    model: opts.model,
    configDir: opts.worker.configDir,
    ioToken: opts.ioToken,
    worktree,
    branch,
  });
}

/** Register the pending entry and arm every channel that can settle it. */
function awaitBgResult(
  id: string,
  ctx: BgRunContext,
  account: string,
  workerName: string,
  outputFile: string,
  meta: {
    title: string;
    timeoutMinutes: number;
    model: string;
    configDir: string;
    ioToken: string;
    worktree?: string;
    branch?: string;
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const spawnedAt = Date.now();
    const timeoutMs = meta.timeoutMinutes * 60_000;
    const entry: BgPending = {
      id,
      title: meta.title,
      account,
      configDir: meta.configDir,
      model: meta.model,
      workerName,
      ioToken: meta.ioToken,
      worktree: meta.worktree,
      branch: meta.branch,
      outputFile,
      spawnedAt,
      timeoutMinutes: meta.timeoutMinutes,
      pool: ctx.pool,
      gateway: ctx.gateway,
      settled: false,
      entryEverSeen: false,
      deathPending: false,
      pingGraceArmed: false,
      // The silence clock starts at the spawn: a worker that says nothing from birth is as
      // silent as one that fell quiet later.
      lastProgressAt: spawnedAt,
      // Never more than half the task's own budget (A6): on a short-timeout dispatch a fixed
      // three-minute wait would put the recovery attempt after the timeout it is racing.
      nudgeAfterMs: Math.min(NUDGE_AFTER_MS, Math.max(1, Math.floor(timeoutMs / 2))),
      nudgeCount: 0,
      lastNudgeAt: 0,
      usageProbeSpent: false,
      silenceBusy: false,
      statusNotes: [],
      unmatchedAtStart: unmatchedTotal,
      timers: new Set<NodeJS.Timeout>(),
      resolve,
      reject,
    };
    pending.set(id, entry);
    armResultWatch(entry);
    const liveness = setInterval(() => onLivenessTick(entry), LIVENESS_POLL_MS);
    liveness.unref?.();
    entry.livenessTimer = liveness;
    armTimer(entry, timeoutMs, () => {
      // .catch is not decoration: an unhandled rejection would take the whole server down
      // on Node 18, and this timer fires from the event loop with no caller to catch it.
      void onTimeout(entry).catch(() => undefined);
    });
    // A fast worker can write its result file before `claude --bg` even returns, so the
    // first read happens now rather than one poll tick from now.
    scanEntry(entry);
  });
}

/**
 * The `--bg` dispatch core: same contract as runDispatchTask (blocking call in, result
 * string out, identical failover/timeout/cancel semantics), with a persistent attachable
 * worker in place of a `claude -p` child. server.ts picks between the two.
 */
export async function runBgDispatchTask(args: DispatchArgs, ctx: BgRunContext): Promise<string> {
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    throw new Error(
      'No worker accounts registered. In VS Code, run "Claude Code Orchestrator: Add Worker Account".',
    );
  }
  const title = args.title?.trim() || 'untitled task';
  const prompt = args.prompt?.trim();
  if (!prompt) {
    throw new Error('dispatch_task requires a non-empty "prompt".');
  }
  const timeoutMinutes = clampTimeoutMinutes(args.timeout_minutes ?? registry.workerTimeoutMinutes);

  ensureDirs();
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const attempted = new Set<string>();
  const maxAttempts = args.worker ? 1 : registry.workers.length;
  let lastError: Error | undefined;
  let lastErrorQuota = false;
  let cancelled = false;
  // promptPreview is built from the USER's task prompt, never the bootstrap wrapper —
  // the surfaces that show it are answering "what is this task", not "how was it started".
  const promptPreview = prompt.replace(/\s+/g, ' ').trim().slice(0, 300);
  const systemPrompt = args.system_prompt?.trim();
  const systemPromptSection = systemPrompt ? `\n\n## Task system prompt\n\n${systemPrompt}` : '';
  const requestedModel =
    args.model && (WORKER_MODELS as readonly string[]).includes(args.model) ? args.model : undefined;
  const usageCache = readUsageCache();
  const overageAllowed = registry.overageWorkerDispatch === 'allow';
  const probedDirs = new Set<string>();

  // Minted once per DISPATCH, not per attempt: it travels in the task file, which every
  // failover attempt reuses, and it is what the pending entry checks every result against
  // (F2.1). Rotating it per attempt would only invalidate the file the next worker reads.
  const ioToken = newIoToken();

  // The task file is the worker's ONLY copy of the task, and every failover attempt reads
  // the same one — so it is written once, before any spawn. A failure here is fatal for
  // this dispatch: a worker that cannot read its task has nothing to do but report an error.
  try {
    writeBgTaskFile(id, {
      ioToken,
      basePrompt: WORKER_BASE_PROMPT,
      systemPrompt: systemPrompt || undefined,
      taskPrompt: prompt,
    });
  } catch (err) {
    throw new Error(
      `Could not write the background task file ${bgTaskFilePath(id)}: ` +
        `${err instanceof Error ? err.message : String(err)}. A --bg worker receives its task ` +
        'through that file, so the dispatch was not started.',
    );
  }

  /** Name of the live worker, once one exists — what the cancel hook signals. */
  let liveWorkerName: string | undefined;
  /** Worktree the live worker edits in (A11), for the result the orchestrator must merge. */
  let liveWorktree: string | undefined;
  let liveBranch: string | undefined;
  /**
   * Was this task id ever handed to the server's tracking maps? (F7.)
   *
   * The server releases a request's cancel hooks by walking the task ids IT tracked, so a
   * dispatch that fails before its first onTrack — a cap refusal, no eligible worker, the
   * frontier billing block — leaves a hook keyed by an id nothing will ever sweep, and the
   * map grows for the life of the process. Tracked ids keep the deliberate outlive-settle
   * behavior (P4.5): a batch cancel must still be able to stop a worker that already
   * reported and went idle.
   */
  let everTracked = false;
  const attemptCtx: BgRunContext = {
    pool: ctx.pool,
    gateway: ctx.gateway,
    ownerPid: ctx.ownerPid,
    ownerStartedAt: ctx.ownerStartedAt,
    shouldAbort: () => ctx.shouldAbort(),
    onTrack: (base: TaskBase): void => {
      everTracked = true;
      ctx.onTrack(base);
    },
    onSettle: (taskId: string): void => ctx.onSettle(taskId),
  };
  // Registered BEFORE the first attempt so a cancellation that lands while the worker is
  // still booting is not lost, and left in place after this task settles so a batch-wide
  // cancel can still stop a worker that is idle-after-result (P4.5). The server drops the
  // hook when the owning request finishes.
  bgWorkersByTask.set(id, () => {
    const entry = pending.get(id);
    if (entry !== undefined) {
      settle(entry, () => entry.reject(new BgCancelledError()));
    }
    if (liveWorkerName !== undefined) {
      stopWorkerBestEffort(ctx.pool, liveWorkerName, true);
    }
  });

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ctx.shouldAbort()) {
        break;
      }
      let worker: WorkerProfile;
      let billableOverage: boolean;
      try {
        const picked = await pickWorkerLive(
          registry.workers,
          args.worker,
          attempted,
          requestedModel,
          usageCache,
          overageAllowed,
          probedDirs,
        );
        worker = picked.worker;
        billableOverage = picked.billableOverage;
      } catch (err) {
        lastError = lastError ?? (err as Error);
        break;
      }
      // Selection can await live auth probes, so a cancellation can land after the
      // loop-top check and before this task is trackable.
      if (ctx.shouldAbort()) {
        break;
      }
      attempted.add(worker.name);
      const model = requestedModel ?? worker.model;
      // Billing guard, identical to the `-p` path: the same model would be blocked on
      // every worker, so this aborts the dispatch instead of failing over.
      if (isFrontierTier(model) && registry.frontierWorkerDispatch !== 'allow') {
        throw new Error(
          `Dispatch to ${model} is blocked: the operator has disabled frontier worker dispatches ` +
            '(billing guard — this model may bill per use instead of drawing from the subscription ' +
            'quota). Re-dispatch this task with model claude-opus-4-8 and ultrathink: true; do NOT ' +
            'retry with the frontier model. The operator can re-enable it via the ' +
            '"claudeCodeOrchestrator.frontierWorkerDispatch" setting in VS Code.',
        );
      }
      const base: BgTaskBase = {
        id,
        title,
        worker: worker.name,
        model,
        outputFile,
        cwd: process.cwd(),
        promptPreview,
      };
      const output: OutputContext = {
        title,
        prompt,
        systemPromptSection,
        ultrathink: args.ultrathink === true,
        billableOverage,
        account: worker.name,
        model,
        outputFile,
      };
      try {
        const report = await runBgAttempt({
          id,
          ioToken,
          // The tracking-aware context (F7): everything else is ctx, but onTrack is what
          // tells the finally below whether this id's cancel hook has an owner.
          ctx: attemptCtx,
          registry,
          worker,
          model,
          timeoutMinutes,
          ultrathink: args.ultrathink === true,
          base,
          output,
          onSpawned: (info) => {
            liveWorkerName = info.name;
            liveWorktree = info.worktree;
            liveBranch = info.branch;
          },
        });
        // Usage is unknowable over `--bg`, so the success is recorded with zero tokens and
        // zero cost rather than a guess. The worker is deliberately NOT stopped: it stays
        // attachable, and teardown belongs to the orchestrator's doctrine plus the idle,
        // cap and session-end backstops.
        recordSuccess(worker.name, { text: report, inputTokens: 0, outputTokens: 0, costUsd: 0 });
        writeDoneOutput(output, liveWorkerName ?? '-', report);
        appendTaskEvent({
          ...base,
          ts: Date.now(),
          status: 'done',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
        const overageWarning = billableOverage
          ? `⚠ ${worker.name} is past a plan window; overage billing applies — this dispatch bills real money against the account's monthly cap.\n`
          : '';
        // A11: the worktree line is part of the RESULT, not a footnote. The worker's edits
        // are not in the shared checkout, so a report handed over without it describes work
        // the reader cannot find — and the dispatch is not integrated until that worktree has
        // been verified and merged.
        const worktreeNote =
          liveWorktree === undefined
            ? ''
            : `worktree: ${liveWorktree}${liveBranch === undefined ? '' : ` (branch ${liveBranch})`} — ` +
              'the worker edited HERE, not in the shared checkout: verify this worktree (diff, ' +
              'build, test), merge what passes, then remove it and stop the worker.\n';
        return `${overageWarning}[worker: ${worker.name}, model: ${model}]\n${worktreeNote}\n${report}`;
      } catch (err) {
        // The cap refusal is a server-side resource decision, not a worker fault: no
        // failure record, no failover, and no terminal event of its own.
        if (err instanceof BgCapError) {
          throw err;
        }
        if (err instanceof BgCancelledError) {
          cancelled = true;
          break;
        }
        if (ctx.shouldAbort()) {
          // We stopped this worker ourselves. A cancellation is not a worker failure: no
          // recordFailure, no failover, and the terminal event is the server's to write.
          cancelled = true;
          break;
        }
        // F3b, the cancel-parity guard. The three clock-driven failures below are the ones
        // that can fire against a task somebody ELSE has already ended: the extension host's
        // tree cancel and the reaper both author a terminal event for a task id without this
        // process being told (a bg worker is not our child, so no signal reaches us and
        // shouldAbort stays false — that is exactly why those paths exist). Re-read the
        // task's latest recorded event before touching the account's record: if it is already
        // terminal, this dispatch is over and the recorded reason is the true one. Skipping
        // recordFailure is the point — a user cancel must never inflate a worker's error
        // count — and skipping the second terminal event keeps the cancel the last word
        // instead of letting a death message overwrite it.
        if (
          err instanceof BgTimeoutError ||
          err instanceof BgWorkerDeathError ||
          err instanceof BgQuotaStallError
        ) {
          const foreign = foreignTerminalReason(id);
          if (foreign !== undefined) {
            // Thrown, not broken out of: the tail below writes the FAILED output file and a
            // terminal error event, which is precisely what must not happen a second time.
            throw new Error(foreign);
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        // Two failures fail over, and only two. A QUOTA spawn failure (P4.6), and a live
        // worker that went silent on an account whose plan usage says it is exhausted (A6) —
        // the `--bg` face of the mid-run quota error `-p` reads off stderr. Both mean "this
        // ACCOUNT cannot do the work", which is the only condition under which handing the
        // same task to a different account is not a re-run of work already half-done. Both
        // also rest on evidence the SERVER produced: a spawn's own exit output, and
        // authoritative plan usage.
        //
        // A worker's own error REPORT is deliberately NOT a third trigger (A16, reverting
        // F10b): classifying prose the worker wrote would cool down a healthy account and
        // start a second session in the same worktree on the strength of a "429" the report
        // merely talks ABOUT — see settleWorkerError for the full record. A timeout, a
        // death, and any worker-reported error consume their attempt.
        const quota =
          (err instanceof BgSpawnFailure && err.quota) || err instanceof BgQuotaStallError;
        recordFailure(worker.name, message, quota, registry.cooldownMinutes);
        lastError = err instanceof Error ? err : new Error(message);
        lastErrorQuota = quota;
        if (!quota) {
          break;
        }
        appendTaskEvent({
          ...base,
          ts: Date.now(),
          status: 'running',
          error: `quota error on ${worker.name} — failing over`,
        });
      }
    }

    if (cancelled || ctx.shouldAbort()) {
      // cancelRequest already stopped the worker and appended the terminal event.
      throw new Error(CANCELLED_ERROR);
    }

    const message = lastError?.message ?? 'unknown error';
    const singleWorkerHint =
      registry.workers.length === 1 && lastErrorQuota
        ? ' Only one worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another worker account.'
        : '';
    const finalMessage = message + singleWorkerHint;
    writeFailedOutput(
      {
        title,
        prompt,
        systemPromptSection,
        ultrathink: args.ultrathink === true,
        billableOverage: false,
        account: [...attempted].join(',') || (args.worker ?? '-'),
        model: args.model ?? '-',
        outputFile,
      },
      finalMessage,
    );
    const failureEvent: TaskEvent = {
      id,
      title,
      worker: [...attempted].join(',') || (args.worker ?? '-'),
      model: args.model ?? '-',
      outputFile,
      cwd: process.cwd(),
      promptPreview,
      ts: Date.now(),
      status: 'error',
      error: finalMessage,
    };
    if (liveWorkerName !== undefined) {
      failureEvent.meshWorker = liveWorkerName;
    }
    appendTaskEvent(failureEvent);
    throw new Error(finalMessage);
  } finally {
    ctx.onSettle(id);
    // Belt and braces: every settle path already removes the entry, but a throw from an
    // unexpected place must never leave a pending task no channel will ever complete.
    const stale = pending.get(id);
    if (stale !== undefined) {
      settle(stale, () =>
        stale.reject(new Error('the dispatch ended before any result channel settled it')),
      );
    }
    // F7: with no tracked id there is no request-side sweep that will ever reach this hook,
    // so it would sit in the map for the life of the process (cap refusal, no eligible
    // worker, frontier block — every path that fails before the first onTrack). A tracked id
    // keeps its hook on purpose: the request's own cleanup drops it, and until then a batch
    // cancel can still stop a worker that is idle-after-result.
    if (!everTracked) {
      bgWorkersByTask.delete(id);
    }
    removeBgIoTaskDir(id);
  }
}

/* ------------------------------------------------------------------------- *
 * Server-side loops (P4.8 / P4.12) and status accessors (P4.11)
 * ------------------------------------------------------------------------- */

/**
 * Idle activity for one ledger record: the newest of its recorded activity and its spawn
 * time (a worker that has never been touched is idle from birth, not from epoch 0).
 * IDLE_COUNTS_REGISTRY_UPDATED_AT additionally trusts the session entry's own
 * `registryUpdatedAt`, which the pool surfaces for exactly this purpose — flipping the
 * constant is V2's decision, and until then that field is deliberately ignored.
 */
export function bgIdleActivityAt(worker: MeshWorkerStatus): number {
  const activity = typeof worker.lastActivityAt === 'number' ? worker.lastActivityAt : 0;
  const spawned = typeof worker.spawnedAt === 'number' ? worker.spawnedAt : 0;
  const registryTouch =
    IDLE_COUNTS_REGISTRY_UPDATED_AT &&
    typeof worker.registryUpdatedAt === 'number' &&
    isFinite(worker.registryUpdatedAt)
      ? worker.registryUpdatedAt
      : 0;
  return Math.max(activity, spawned, registryTouch);
}

/**
 * Stop workers nobody is using, and clear crash litter. The three protections against
 * reaping a session a human is inside are the keepAlive mark (set by the UI's Attach
 * action BEFORE the terminal opens, and by mesh_keep_worker per the doctrine), the
 * in-flight check below, and the operator's own timeout setting (0 disables the sweep).
 */
function sweepIdleWorkers(pool: IWorkerPool): void {
  let idleMinutes = 0;
  try {
    idleMinutes = readRegistry().meshWorkerIdleTimeoutMin;
  } catch {
    // unreadable registry — skip the stop pass this tick, still sweep artifacts below
  }
  if (idleMinutes > 0) {
    let workers: MeshWorkerStatus[] = [];
    try {
      workers = pool.list();
    } catch {
      workers = [];
    }
    const now = Date.now();
    for (const worker of workers) {
      if (worker.stoppedAt !== undefined) {
        continue;
      }
      if (typeof worker.taskId === 'string' && pending.has(worker.taskId)) {
        continue;
      }
      if (worker.keepAlive === true) {
        continue;
      }
      if (now - bgIdleActivityAt(worker) <= idleMinutes * 60_000) {
        continue;
      }
      // Serialized with the cap check so a stop cannot land between a count and its spawn.
      void serializeWorkerOp(() =>
        pool.stop(worker.name).then(
          () => undefined,
          () => undefined,
        ),
      ).catch(() => undefined);
    }
  }
  sweepStaleArtifacts();
}

/**
 * Clear the io litter a crashed server or a killed worker left behind — whole per-task
 * directories older than 24h (settle-time cleanup covers every normal path).
 *
 * DELEGATED to the reaper (F5b) rather than reimplemented here, because the extension host
 * runs the same sweep at activation and two implementations of "what is safe to delete out
 * of the io root" would be one implementation too many. This process only supplies its own
 * workspace.
 *
 * No pending-task exclusion is needed at this layer: a live dispatch's directory is at most
 * as old as its own wall clock, and the dispatch timeout is clamped to TIMEOUT_MINUTES_MAX
 * (8h) — a third of the sweep's 24h floor — so the sweep can never reach a directory a
 * running task still needs.
 */
function sweepStaleArtifacts(): void {
  try {
    sweepStaleIoArtifacts({ cwd: ioWorkspace() });
  } catch {
    // a sweep failure is litter, not a fault: the next tick and the host's own activation
    // sweep both come back for it
  }
}

/**
 * Start the two server-lifetime loops, once, after the gateway has reached READY. The
 * drain loop must exist before the first spawn can possibly report, which it does: the
 * gateway is ready before any dispatch worker is spawned.
 */
export function startBgLoops(deps: { pool: IWorkerPool; gateway: IGatewayManager }): void {
  if (loopsStarted) {
    return;
  }
  loopsStarted = true;
  void drainLoop(deps.gateway, deps.pool).catch(() => undefined);
  idleSweepTimer = setInterval(() => {
    try {
      sweepIdleWorkers(deps.pool);
    } catch {
      // a sweep must never throw into the event loop
    }
  }, IDLE_SWEEP_MS);
  idleSweepTimer.unref?.();
}

/** Number of inbound signals currently held in the unmatched ring (mesh_status). */
export function bgUnmatchedCount(): number {
  return unmatched.length;
}

/** Title of the dispatch a worker is currently running, for mesh_status. */
export function bgPendingTitle(taskId: string | undefined): string | undefined {
  if (typeof taskId !== 'string') {
    return undefined;
  }
  return pending.get(taskId)?.title;
}

/**
 * Diagnostic line for the newest unmatched signal, when there is one. `from` is a sender
 * name for a message and a file path for a refused result file (F2.1), and the trailing
 * quote is omitted when there is no text to quote — a file entry has none.
 */
export function bgLastUnmatched(): string | undefined {
  const last = unmatched[unmatched.length - 1];
  if (last === undefined) {
    return undefined;
  }
  const quoted = firstLine(last.text);
  return (
    `${new Date(last.at).toISOString()} from ${last.from}: ${last.reason}` +
    (quoted === '' ? '' : ` — ${quoted}`)
  );
}
