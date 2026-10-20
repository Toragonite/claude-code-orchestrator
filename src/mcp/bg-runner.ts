import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { ioTokenDigest, newIoToken } from '../ioToken';
import {
  appendOutputNote,
  appendTaskEvent,
  clampTimeoutMinutes,
  claudeWorkers,
  ensureDirs,
  latestTaskEventOf,
  readRegistry,
  TASKS_DIR,
  type Registry,
  type TaskEvent,
  type WorkerProfile,
  writeTaskFile,
} from '../registry';
import { claudeShellPrefix, isFrontierModel, WORKSPACE_NOT_TRUSTED_MARKER } from '../platform';
import { providerInfo } from '../providers';
import { WORKER_BASE_PROMPT } from '../prompts';
import { readTextSafe } from '../safeFs';
import {
  exhaustedWindows,
  readUsageCache,
  refreshAllUsageIfStale,
  type AccountUsage,
  type UsageCache,
  type UsageWindow,
} from '../usage';
import {
  attemptModel,
  CANCELLED_ERROR,
  dispatchCandidates,
  formatExhaustedWindow,
  frontierBlockedMessage,
  headerText,
  isQuotaError,
  modelHeaderLines,
  noWorkerForProviderMessage,
  ownEntry,
  pickWorkerLive,
  PROMPT_PREVIEW_MAX,
  resolveDispatchTarget,
  resolveRequestedModel,
  resultModelText,
  TaskBookkeeping,
  unsupportedWorkerRefusal,
  type DispatchArgs,
  type ModelSource,
  type TaskBase,
} from './task-runner';
import { checkDispatchArgs } from './dispatch-args';
import { DISPATCHED_TASK_ENV } from './host-protocol';
import {
  BG_IO_FILE_MODE,
  BG_RESULT_FILE_MAX_BYTES,
  bgDispatchBootstrapPrompt,
  bgDispatchTaskFile,
  bgIoTaskDir,
  bgResultFile,
  bgTaskFile,
  bgTokenRefusal,
  bgWorktreeBranch,
  bgWorktreePath,
  ensureBgIoTaskDir,
  ENTRY_APPEAR_GRACE_MS,
  isGitWorkspace,
  meshError,
  type IWorkerPool,
  type WorkerSessionStatus,
  type WorkerSpawnResult,
} from '../mesh/contract';
import { sweepStaleIoArtifacts } from '../mesh/reaper';
import { readWorkerTranscript, sessionModelOf } from '../mesh/transcript';

/**
 * mcp/bg-runner — dispatch over `claude --bg` (session workers), the mesh-ON half of the
 * dispatch fork. Mesh OFF never reaches this module: server.ts's dispatchTask branches ONE
 * `if` and the `-p` core (task-runner.ts) stays a closed box (contract P0.1), which also
 * keeps the detach supervisor — the core's other host — mesh-free.
 *
 * What differs from `-p`, and why:
 *   - The worker is a PERSISTENT background session, so there is no child process to
 *     read a result off. The task is delivered as a FILE (`<ioTaskDir>/task.md`, so a
 *     300 KB prompt cannot hit the argv size limit `-p` avoided by using stdin) and the
 *     result comes back as a FILE (`<ioTaskDir>/result.json`). That file is the ONLY
 *     result channel: nothing here reads a message from a worker.
 *   - Both files live OUTSIDE the workspace, in a PER-TASK directory
 *     `<ROOT_DIR>/bg-io/<workspaceHash>/<taskId>/` (A10, isolated per task by F2). A `--bg`
 *     session may not Write inside the checkout until it enters a worktree — gitignored
 *     paths included — so the io channel had to leave the tree, and the spawn grants back
 *     exactly that one subdirectory with `--add-dir`. A result file is accepted only from a
 *     writer that knew the task's token, which the worker reads off the first line of its
 *     task file: that stops a result written for another task, by another user's process, or
 *     forged from the task log (which holds only the token's SHA-256) — and not a process of
 *     this user that reads the task file, which nothing on disk can stop. The statement in
 *     full is in mesh/contract, at BG_IO_TOKEN_HEADER_PREFIX.
 *   - The worker's own edits land in a per-task git worktree (A11), so a dispatch is not
 *     integrated until the orchestrator has verified and merged it. Every surface that
 *     tells the orchestrator where the work is — the result string, the DONE output file,
 *     the timeout, death and parked diagnostics — names that worktree and its branch.
 *   - The worker is a PEER SESSION of the orchestrator, which talks to it with its own
 *     native SendMessage. This server relays nothing and receives nothing: v1.x hosted a
 *     relay gateway here (the IDE session could not message a background session itself),
 *     and it went, with its pings, its live feed and its nudge, when the platform closed
 *     that gap.
 *   - Every wait therefore has to be built from watchers and timers instead of process
 *     events: a per-task result-file watch + 2s poll, a liveness tick that reads the
 *     platform's own session status for the worker, the dispatch timeout, and the cancel
 *     hook. All of them are settle-once through one gate, so ONE task produces exactly ONE
 *     result and the first valid signal wins.
 *   - A live worker is not necessarily a WORKING one. `-p` learns that a run is over from
 *     its child exiting; a `--bg` worker whose turn ends without a result — a mid-run
 *     account limit, an expired login, a model that asked a question instead of acting —
 *     just sits there, alive and parked, and used to burn the whole dispatch timeout. The
 *     platform records that state (its session status goes idle/waiting), so the liveness
 *     tick reads it: parked for the whole grace with the task still pending is settled as
 *     a FAILED dispatch that says how to reach the worker, or — when the account's plan
 *     usage shows an exhausted window — as a quota failure that fails over exactly as `-p`
 *     would. The timeout stays the final backstop; this only stops it being the FIRST one.
 *   - A settled worker is NOT stopped: staying attachable is the whole point. Teardown is
 *     the orchestrator's doctrine plus the session-end stop in mesh/reaper.ts; there is no
 *     idle auto-stop, so the only timer here that stops a worker is the timeout of a dispatch
 *     still in flight. What bounds concurrent WORK is the in-flight cap, checked here before
 *     every spawn.
 *
 * Everything in this module is total: no timer, watcher or file read may ever throw out
 * into the server's event loop, and no failure path may leave a dispatch pending forever —
 * an undefined failure mode would hang the orchestrator's tool call.
 *
 * Must not import 'vscode'. Node stdlib + this repo's own modules only.
 */

/* ------------------------------------------------------------------------- *
 * Tunables
 * ------------------------------------------------------------------------- */

/**
 * TEST-ONLY override for one of the two timers below that decide how long a parked worker
 * takes to be noticed. Read once at module load from the named environment variable and
 * honoured only when it is a plain integer between 50 (ms) and the production default — so it
 * can make an offline probe faster and can never make a real dispatch slower, or turn the tick
 * into a busy loop. Not a setting: nothing documents it to users and no registry field
 * carries it.
 */
function testTimerOverride(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) {
    return defaultMs;
  }
  const ms = Number(raw);
  return ms >= 50 && ms <= defaultMs ? ms : defaultMs;
}

/** Results-dir poll interval; fs.watch is the fast path, this is the guarantee. */
const RESULT_POLL_MS = 2_000;
/** After the timeout stop + final read, a last window in which a late file still settles. */
const POST_TIMEOUT_GRACE_MS = 10_000;
/**
 * Cadence of the wall-clock deadline sweep (sweepDeadlines) — the pass that settles a task
 * whose deadline has passed WITHOUT depending on that task's own timeout timer.
 *
 * Cheap by construction, which is what licenses a fixed interval: the tick is a no-op while
 * nothing is pending, and otherwise it is one Map iteration doing arithmetic — pastDeadline()
 * is a subtraction — so the pass reads no file, spawns nothing and touches no ledger. The map
 * is bounded by meshMaxLiveWorkers (default 8, hard max 64), so a full pass is tens of
 * comparisons.
 *
 * 15s deliberately matches the liveness tick's production cadence: the two backstop clocks
 * then tick together rather than at two rates a reader has to reconcile. It bounds the
 * overshoot this backstop can add to a dispatch's own deadline at 15 seconds — a quarter of the
 * SHORTEST timeout a dispatch can be clamped to (TIMEOUT_MINUTES_MIN = 1) and invisible against
 * the 45-minute default. Anything finer would spend ticks shaving seconds off a path that is
 * not supposed to be reached at all.
 */
const DEADLINE_SWEEP_MS = 15_000;
/**
 * How long after the timeout path was ENTERED the sweep stops waiting for it and settles the
 * task itself.
 *
 * The timeout path is not instantaneous: it stops the worker (`claude stop`, then `claude rm`,
 * then a ledger lock — each separately bounded at 15s), reads the result file one last time,
 * and holds the task for POST_TIMEOUT_GRACE_MS so a late file still wins. ~60s is the whole of
 * that honest budget, so 120s is comfortably past every bounded step and cannot pre-empt a
 * timeout that is merely slow. What is NOT bounded is a step that never returns at all — an
 * await that never resolves, a grace timer cleared by something other than a settle — and that
 * is the "its settle path was missed" case: without this rung the entry sits in `pending` as
 * `running` forever, which is the exact defect the sweep exists to close.
 */
const TIMEOUT_PATH_STALL_MS = 120_000;
/**
 * Per-pending-task liveness tick: how often the platform is asked what the task's worker is
 * doing (IWorkerPool.sessionStatus). Test override: CCO_TEST_LIVENESS_TICK_MS.
 */
const LIVENESS_POLL_MS = testTimerOverride('CCO_TEST_LIVENESS_TICK_MS', 15_000);
// ENTRY_APPEAR_GRACE_MS (90s, the window in which a worker with no session entry yet is
// still booting rather than gone) is imported from the mesh contract rather than redeclared:
// the pool answers `unknown` instead of `gone` for exactly that window, so the two must never
// drift apart.
/** Workers commonly die RIGHT AFTER success — hold a dead task this long before failing it. */
const DEATH_GRACE_MS = 10_000;
/**
 * How long a pending task's worker must be seen PARKED — turn ended, session alive — on
 * every liveness tick before the dispatch is settled as "ended its turn without a result".
 *
 * A turn boundary is not instantly a verdict: the platform itself re-prompts a turn that
 * ended with no visible output, and a result file can be the last thing a turn writes. 45s is
 * three production ticks — long enough for both to resolve on their own, short enough that a
 * worker which stopped to ask a question costs a minute rather than the dispatch's whole
 * timeout, which is the hang this rule exists to end. Test override: CCO_TEST_PARK_GRACE_MS.
 */
const PARK_GRACE_MS = testTimerOverride('CCO_TEST_PARK_GRACE_MS', 45_000);
/**
 * How old the account's cached plan usage may be before a parked episode pays for ONE live
 * probe. Deliberately much tighter than USAGE_FRESH_DEFAULT_MS: a reading taken before the
 * worker's turn ended cannot answer "did this worker just hit its ceiling", which is the only
 * question being asked here.
 */
const PARKED_USAGE_MAX_AGE_MS = 60_000;
/** Ceiling for that one probe. get_usage answers in seconds; this bounds a wedged CLI. */
const PARKED_USAGE_PROBE_TIMEOUT_MS = 10_000;
/** Cadence of the stale-io sweep, the one server-lifetime loop left (startBgLoops). */
const STALE_IO_SWEEP_MS = 60_000;
/** Refused result files kept for diagnostics (newest wins). */
const REJECTED_RING_MAX = 20;

/** Report substituted when a worker's result file parses but carries an empty report. */
const EMPTY_REPORT_NOTE =
  '(the worker wrote a result file with an empty report — inspect the working tree for what it ' +
  'actually produced before re-dispatching)';

/* ------------------------------------------------------------------------- *
 * Errors carried between the attempt loop and its helpers
 * ------------------------------------------------------------------------- */

/**
 * The spawn itself failed. `quota` is what fails this dispatch over to another account
 * (P4.6). Once a worker session EXISTS, only one other thing may fail over — a worker parked
 * without a result on a demonstrably exhausted account (BgQuotaStallError below) — because
 * every other post-spawn failure would hand a second account a task the first one may already
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
 * `claude --bg` refused to start because the chosen ACCOUNT has not trusted this workspace
 * root for background sessions (pool error code `workspace_untrusted`).
 *
 * Not a failure of the account and not a reason to try another one: `claude -p` skips the
 * trust check, so the server catches this and runs THIS task as a one-shot worker on the same
 * account, saying so in its result. Nothing is recorded against the account, and this module
 * writes no terminal event for the task — it is handed over still `running`, under the same
 * id, which is why the error carries the task identity the handoff continues.
 *
 * Exported because the catch lives in server.ts: the one-shot core needs the server's
 * child-tracking context, which a `--bg` dispatch never has.
 */
export class BgWorkspaceUntrustedError extends Error {
  constructor(
    /** Registry account name the spawn was refused under. */
    readonly account: string,
    /** The CLI's own instruction for granting trust — one line, no trailing period. */
    readonly instruction: string,
    /** The task this dispatch announced; the one-shot run continues it under the same id. */
    readonly task: TaskBase,
  ) {
    super(
      meshError(
        'workspace_untrusted',
        `${account} has not trusted this workspace for background sessions — ${instruction}.`,
      ),
    );
    this.name = 'BgWorkspaceUntrustedError';
  }
}

/**
 * A worker ended its turn without a result and its account turns out to be quota-exhausted.
 * This is the `--bg` equivalent of the `-p` path's mid-run quota error: the same evidence
 * arrives through a different door (plan usage rather than a stderr string), so it must
 * produce the same consequence — a cooldown on the account and a failover to the next one. It
 * is a distinct class from BgSpawnFailure because nothing about the spawn failed: a worker
 * existed, ran, and stopped producing.
 */
class BgQuotaStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgQuotaStallError';
  }
}

/**
 * The in-flight cap refused this dispatch (P4.7). Deliberately NOT a worker failure: no
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
 * The dispatch's wall clock ran out (P4.3), the worker's session died before it reported
 * (P4.4), or the worker sat parked without a result (BgParkedError below). They are carried
 * as their own classes for ONE reason: the cancel-parity guard (F3b) has to recognise them at
 * the attempt-loop's catch, where it re-reads the task's latest recorded event and steps aside
 * if somebody else — the extension host's tree cancel, the reaper — already authored a
 * terminal one. A user cancel must never be re-labelled "the worker died" and must never
 * inflate an account's error count, and the only way to know a failure came from one of these
 * clocks is to type it.
 *
 * They deliberately do NOT classify as quota (no cooldown, no failover): none of them is a
 * quota failure, and a replacement worker would redo work that may be half-done.
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
 * The worker ended its turn without writing its result file and stayed parked for the whole
 * grace (settleParkedWorker). A plain failure — it consumes the attempt — whose worker is
 * deliberately left running.
 *
 * `evidence` is the last text of the worker's session transcript, when there was any. It
 * rides on the error rather than being written at settle time because the failure tail
 * REWRITES the task's output file: the evidence has to be appended after that, by the one
 * place that knows the file is final (appendParkedEvidence).
 */
class BgParkedError extends Error {
  constructor(
    message: string,
    readonly workerName: string,
    readonly evidence: string | undefined,
  ) {
    super(message);
    this.name = 'BgParkedError';
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
 * Module state — one pending map, one results poll, one deadline sweep
 * ------------------------------------------------------------------------- */

/** One dispatch awaiting its result. Present only between a successful spawn and settle. */
interface BgPending {
  readonly id: string;
  readonly title: string;
  /** Registry account name the worker runs under (the `worker:` of every event). */
  readonly account: string;
  /**
   * That account's config dir, VERBATIM from the registry — the key its plan usage is cached
   * under, where its transcript lives, and what an attach command has to name.
   */
  readonly configDir: string;
  /** Model this attempt runs, which decides whether a weekly_scoped window applies. */
  readonly model: string;
  /**
   * This attempt was KNOWINGLY sent to an account past a plan window, under overage billing
   * (selection's `billableOverage`). Such an account shows an exhausted window by construction
   * — that is why the dispatch bills — so an exhausted window is no evidence at all about why
   * its worker parked. The parked path reads this to skip its quota rung.
   */
  readonly billableOverage: boolean;
  /** The worker's session name — what a stop addresses, and what the orchestrator messages. */
  readonly workerName: string;
  /**
   * The worker's background job id, minted by the CLI at spawn: the key the platform's session
   * status is read by and the ledger record is settled by. Names are reused across worker
   * generations; a job id never is. '' only if a spawn ever reported success without one, in
   * which case the liveness tick has no question to ask and the timeout is the backstop.
   */
  readonly jobId: string;
  /**
   * The per-task result token (F2.1), held HERE and nowhere else in this process's records:
   * the task log gets its SHA-256, the worker reads it off the first line of the task file.
   * Minted once per DISPATCH — not per attempt — because the task file that carries it to the
   * worker is written once and reused by every failover attempt. A result whose `token` field
   * is not exactly this value never settles the task, whatever else about it is well-formed.
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
  settled: boolean;
  /** The worker's session was observed running (busy or parked) at least once (P4.4). */
  seenAlive: boolean;
  /** Death was detected; the task is inside its death grace and still settleable. */
  deathPending: boolean;
  /**
   * THIS process has issued a stop for the worker (the timeout path, or the parked path's
   * quota rung) and has not settled the task yet. From then on a session that is gone is our
   * own doing, not a death: the liveness tick stands down, so the path that stopped the worker
   * is the one that names the outcome — a `claude stop` + `claude rm` can outlast the death
   * grace, and a timeout must not be recorded as "the worker died".
   */
  stopIssued: boolean;
  /**
   * When the timeout path was ENTERED (undefined until it is). Two clocks can decide this
   * dispatch has run out of time — the entry's own timer and the deadline sweep behind it —
   * and this is the latch that lets exactly one of them run onTimeout. It records the INSTANT
   * rather than a boolean because the sweep needs the second fact too: a timeout path that was
   * entered long ago and still has not settled anything is itself a stall to back stop.
   */
  timeoutEnteredAt?: number;
  /** fs.watch over THIS task's io dir; the shared 2s poll is the guarantee behind it. */
  watcher?: fs.FSWatcher;
  /**
   * `<mtimeMs>:<size>` of the last result file this task REFUSED (bad token, wrong embedded
   * id). Kept so a refused file that just sits there is reported to the rejected ring ONCE
   * rather than every 2s poll tick for the rest of the dispatch — a ring that floods with
   * one repeated event is a ring that has lost every other event in it.
   */
  lastRejectSignature?: string;
  /**
   * WHY the newest refused result file was refused, as a sentence without its full stop,
   * composed from literals (readResultFile). Quoted in this dispatch's failure message, because
   * that message is the only place the orchestrator hears that its worker DID report and what
   * was wrong with the report.
   */
  lastRejectReason?: string;
  /** The newest session status the liveness tick read — quoted in failure diagnostics. */
  lastStatus?: WorkerSessionStatus;
  /**
   * When the CURRENT parked episode began: the first tick that saw the worker parked, restarted
   * by a change to the result file and cleared by any tick that saw anything else. Undefined
   * while the worker is not parked.
   */
  parkedSince?: number;
  /** resultFileStamp() at the start of the parked episode — what "the file changed" is measured against. */
  parkedResultStamp?: string;
  /** What the platform says the parked session is waiting for, when it says. */
  waitingFor?: string;
  /** The one bounded usage probe for the CURRENT parked episode has been spent. */
  usageProbeSpent: boolean;
  /** A parked pass is in flight; later ticks must not start a second one. */
  parkBusy: boolean;
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

/** One refused result file — see pushRejectedResult. */
interface RejectedResult {
  at: number;
  file: string;
  reason: string;
}
const rejectedResults: RejectedResult[] = [];

/**
 * The single 2s poll over every pending task's result file; armed while at least one task
 * is pending. The fast path is one fs.watch PER TASK (on the entry, armed with it): after
 * F2 each task's result file lives in its own subdirectory, and a non-recursive watch on
 * the parent would not see writes one level down on every platform. The poll is the
 * guarantee either way — directory watch events are unreliable on macOS and on network
 * filesystems, which is why this pairing exists at all.
 */
let resultsPoll: NodeJS.Timeout | undefined;

/**
 * The shared wall-clock deadline sweep (sweepDeadlines), armed while at least one task is
 * pending exactly like the results poll above. Deliberately NOT per-entry: a per-entry timer
 * is precisely the thing whose loss this sweep exists to survive, so a second one would
 * inherit the failure it is supposed to cover.
 */
let deadlineSweep: NodeJS.Timeout | undefined;

/** The stale-io sweep's interval, set while startBgLoops' loop is running. */
let staleIoSweepTimer: NodeJS.Timeout | undefined;

/**
 * Serializer for the cap check and the spawn, which MUST run in one critical section (P4.7):
 * without it a batch of eight dispatches would all read "7 in flight" and overshoot the cap
 * by seven.
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

/**
 * Record on the ledger that this worker's dispatch reached a terminal outcome, so it stops
 * counting against the in-flight cap and every other surface can tell a parked worker from a
 * working one. Fire-and-forget by contract: it runs after the outcome is already recorded in
 * the task log, and it must never block or fail the settle it follows.
 */
function markSettledBestEffort(pool: IWorkerPool, jobId: string): void {
  if (jobId === '') {
    return;
  }
  try {
    void pool.markSettled({ jobId }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // a synchronous throw is no more a reason to fail the caller than a rejection is
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
 *
 * THIS FILE IS WHERE THE RESULT TOKEN RESTS — its first line, and nowhere else on disk. So the
 * directory is created for this user alone (contract.ensureBgIoTaskDir) and the file is created
 * BG_IO_FILE_MODE, EXCLUSIVELY: the task id is minted for this dispatch, so nothing can
 * legitimately be at that name already, and a create that refuses to open what is there cannot
 * be made to write the token through a link somebody planted.
 */
function writeBgTaskFile(
  taskId: string,
  opts: { ioToken: string; basePrompt: string; systemPrompt?: string; taskPrompt: string },
): void {
  ensureBgIoTaskDir(ioWorkspace(), taskId);
  fs.writeFileSync(
    bgTaskFilePath(taskId),
    bgDispatchTaskFile({
      taskId,
      ioToken: opts.ioToken,
      basePrompt: opts.basePrompt,
      systemPrompt: opts.systemPrompt,
      taskPrompt: opts.taskPrompt,
    }),
    { mode: BG_IO_FILE_MODE, flag: 'wx' },
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

/** Ceiling for the persisted full-prompt file; longer prompts are truncated (C1). */
const PROMPT_FILE_MAX_BYTES = 64 * 1024;

/**
 * Persist the FULL user task prompt (raw, whitespace uncollapsed — the collapse is only for
 * the 300-char preview) to tasks/<id>.prompt.txt, capped at 64 KiB with a truncation marker.
 *
 * Best effort: the promptPreview on the event is the guaranteed surface; this file is an
 * extra convenience, so any fs failure is swallowed and NEVER thrown into the dispatch path.
 */
function writeBgPromptFile(id: string, prompt: string): void {
  try {
    const buf = Buffer.from(prompt, 'utf8');
    const body =
      buf.length > PROMPT_FILE_MAX_BYTES
        ? buf.subarray(0, PROMPT_FILE_MAX_BYTES).toString('utf8') + '\n…[truncated]'
        : prompt;
    // By task id, replacing whatever is at the name rather than writing into it
    // (registry.writeTaskFile); a refusal is one more way of "not written".
    writeTaskFile(id, 'prompt', body);
  } catch {
    // unwritable, out of space, or gone — the preview still carries the task text
  }
}

/**
 * At settle, turn a mesh worker's still-uncommitted worktree edits into a durable commit on
 * its branch (A11), and return the commit's SHORT sha. The worker is spawned WITHOUT the Bash
 * tool and told not to run git, so at settle its branch has zero commits and its tree is
 * dirty — a "merge the branch" then finds nothing, and a later force-remove of the dirty
 * worktree DISCARDS the work. This is where that work is captured into a mergeable commit.
 *
 * Returns undefined when there is nothing to hand back: a falsy or non-directory worktree
 * path, a clean tree (git's "nothing to commit"), or any git failure whatsoever.
 *
 * STRICTLY best-effort, exactly like removeBgIoTaskDir / writeBgPromptFile: a data-safety
 * feature must never itself become a data-loss or dispatch-failure cause, so a missing git, a
 * git error, a 15s timeout — everything — is swallowed here and NEVER thrown into the settle
 * path. `stdio: 'ignore'` on the mutating calls keeps git's own chatter off the server's
 * streams; only rev-parse's stdout is captured, for the sha.
 */
function commitBgWorktree(
  worktreeAbs: string,
  workerName: string,
  taskId: string,
): string | undefined {
  if (!worktreeAbs) {
    return undefined;
  }
  try {
    if (!fs.statSync(worktreeAbs).isDirectory()) {
      return undefined;
    }
    execFileSync('git', ['-C', worktreeAbs, 'add', '-A'], { timeout: 15_000, stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-C',
        worktreeAbs,
        // Guarantee an identity (a repo/global one may be unset ⇒ commit fails silently), and
        // bypass repo commit HOOKS and GPG SIGNING — a failing pre-commit hook or a signing
        // prompt would silently defeat this durable-commit or hang it to the timeout.
        '-c',
        'user.name=Claude Code Orchestrator',
        '-c',
        'user.email=orchestrator@users.noreply.github.com',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        `mesh: ${workerName} · task ${taskId} — auto-committed at settle (review before merge)`,
      ],
      { timeout: 15_000, stdio: 'ignore' },
    );
    return execFileSync('git', ['-C', worktreeAbs, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
  } catch {
    // a clean tree ("nothing to commit"), no git on PATH, a broken worktree, or a timeout —
    // all swallowed. The auto-commit must never throw into or fail the dispatch/settle path.
    return undefined;
  }
}

/**
 * The settle-time hook for a mesh dispatch (A11): commit the worker's worktree edits and, when
 * a commit was actually made, point the orchestrator at the durable branch in the very report
 * it reads. A no-op for the non-git / one-shot fallback (no worktree). Best-effort throughout
 * — commitBgWorktree cannot throw — so this only ever augments the report, never fails it.
 */
function commitWorktreeIntoReport(entry: BgPending, report: string): string {
  // Best-effort AND never-throw: the WHOLE body is guarded. path.resolve throws on a non-string
  // or an undefined base (ioWorkspace() during shutdown/reload), and this runs inside the settle
  // deliver closure, so an unguarded throw would break the settle path — the exact invariant a
  // data-safety feature must not violate. Any failure leaves the report untouched.
  try {
    if (typeof entry.worktree !== 'string' || entry.worktree === '') {
      return report;
    }
    // entry.worktree is workspace-RELATIVE; resolve it against the io workspace base and CONTAIN
    // it strictly under that base (mirror reaper.keptWorktree). Without this an empty / `.` / `..`
    // / absolute value would resolve to (or above) the workspace ROOT and make `git add -A` commit
    // the user's ENTIRE checkout onto whatever branch it is on — destructive. A path that does not
    // contain must be a no-op, not a commit.
    const base = ioWorkspace();
    const worktreeAbs = path.resolve(base, entry.worktree);
    if (worktreeAbs === base || !worktreeAbs.startsWith(base + path.sep)) {
      return report;
    }
    const sha = commitBgWorktree(worktreeAbs, entry.workerName, entry.id);
    if (sha === undefined) {
      return report;
    }
    const branch = entry.branch ?? bgWorktreeBranch(entry.id);
    return `${report}\n· work committed to branch ${branch} (${sha}) — merge it`;
  } catch {
    return report;
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
 *     task's (F2.1): it never settles anything, and it is recorded in the rejected ring
 *     so a forged or misdirected result is VISIBLE rather than silently ignored forever.
 *     `reason` is a sentence without its full stop, composed from literals — it is quoted to
 *     the orchestrator, so no value out of the refused file is in it.
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

/** How much of an unreadable (oversize) result file is quoted back to the orchestrator. */
const OVERSIZE_HEAD_BYTES = 2_000;

/**
 * Open flags for the one read here that is not safeFs's: read-only, NON-BLOCKING (a FIFO at the
 * name returns instead of hanging the server), NO-FOLLOW (a link at the name is refused by the
 * open itself), no controlling terminal. Each optional flag is probed rather than assumed.
 */
const HEAD_READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * The first bytes of a file, for a diagnostic that has to survive the file itself. Total by
 * construction — this runs while a task is being settled with a failure, and a second
 * failure here would replace a useful message with none at all.
 *
 * safeFs refuses an oversize file rather than hand back a prefix of it, which is right for a
 * document and is exactly what this excerpt is not; so the head is read here, to the same
 * standard: the name is opened without following a link and without blocking, and the open
 * descriptor is asked whether it is a regular file before a byte is read.
 */
function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, HEAD_READ_FLAGS);
    if (!fs.fstatSync(fd).isFile()) {
      return '(what is at that path is no longer a regular file)';
    }
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

/** The size of what is at `file`, for a message only; undefined when it cannot be learned. */
function sizeForMessage(file: string): number | undefined {
  try {
    const size = fs.lstatSync(file).size;
    return Number.isFinite(size) ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a result path that holds something other than a regular file is refused. A sentence
 * without its full stop, composed from literals, like every refusal reason here.
 */
const NOT_A_REGULAR_FILE_REFUSAL =
  "the worker's result was refused because what is at the result path is not a regular file " +
  '(a symbolic link, a directory, a pipe or a device): a result is read from the file AT that ' +
  'name, never through a link to another one';

/**
 * Read one task's `result.json`, in the task's own io directory.
 *
 * THE WORKER CONTROLS THIS PATH, so the read is safeFs's with `noFollow`: bounded by
 * BG_RESULT_FILE_MAX_BYTES (an unbounded read of a file that is being appended to is an easy
 * way to turn a runaway worker into an out-of-memory server), non-blocking (a FIFO at the name
 * returns instead of hanging every dispatch of this server), and refusing a symbolic link in the
 * same call that opens the name. A link is refused even when it points at a perfectly good
 * result of this very task: "the file the worker wrote into its own directory" is what this
 * channel reads, and a name that resolves to some other file — another task's result, any JSON
 * document this user can read — is not that, whatever it contains.
 */
function readResultFile(file: string, taskId: string, ioToken: string): BgResultRead {
  const read = readTextSafe(file, BG_RESULT_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    if (read.reason === 'not-a-file') {
      // Not "come back next tick": nothing a worker does by finishing its write turns a link, a
      // directory or a pipe into a result. Refused where it can be SEEN — the rejected ring and
      // this dispatch's failure message — and it settles nothing, so a worker that replaces it
      // with a real file is still collected.
      return { kind: 'rejected', reason: NOT_A_REGULAR_FILE_REFUSAL };
    }
    if (read.reason === 'too-large') {
      // F10a. The file is never truncated-then-parsed (that would turn a huge report into
      // a permanent JSON error), and it is never skipped forever either: the worker DID
      // finish, so the task settles with a diagnosis naming what was found and where.
      //
      // The HEAD is quoted because settle-time cleanup removes the task's whole io directory
      // (F2.2) moments after this settles: the oversize report is the one payload that exists
      // nowhere else — it never reached tasks/<id>.md and never reached an event — so a
      // bounded excerpt is the only part of it that can be preserved at all.
      const size = sizeForMessage(file);
      return {
        kind: 'unreadable',
        message:
          `The worker wrote its result file, but it is ${size === undefined ? 'larger than' : `${size} bytes — past`} the ` +
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
    // Absent, or unreadable just now (a descriptor limit, a file that shrank under the read):
    // come back next tick.
    return RESULT_ABSENT;
  }
  if (read.bytes === 0) {
    // Created-but-not-yet-written: come back next tick.
    return RESULT_ABSENT;
  }
  const text = read.text;
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
  // Gate 1 (F2.1): the token, checked BEFORE the payload is trusted at all. The `--add-dir`
  // grant already names only this task's own directory, so a sibling should not be able to
  // write here — but that grant is a platform behavior probed once, and this file is accepted
  // only from a writer that knew the task's token. The expected value is the one in this
  // process's memory; what the gate does and does not stop is stated at mesh/contract's
  // BG_IO_TOKEN_HEADER_PREFIX.
  //
  // The reason says what the ORCHESTRATOR needs — that a result was refused over its token,
  // where the token is, which mistake it looks like — and quotes nothing out of the file: a
  // wrong token is most often the right one with a character changed.
  if (rec.token !== ioToken) {
    return { kind: 'rejected', reason: bgTokenRefusal(rec.token) };
  }
  // Gate 2: the embedded id must match the DIRECTORY this file was found in (which is also
  // the pending key), so a worker that writes a neighbour's id can never settle either task.
  if (rec.taskId !== taskId) {
    return {
      kind: 'rejected',
      reason:
        "the worker's result was refused because the task id inside it is not this task's " +
        `(${taskId}), although it carried this task's token and was found in this task's own io ` +
        'directory',
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
 * 2s poll, the timeout, the death path and the parked path alike — which is exactly how "first
 * valid wins across channels" is implemented: every channel ends here.
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
 * Record a refused result file in the rejected ring (F2.1), once per distinct version of
 * that file. Nothing is deleted here: while the dispatch is live the file is evidence, and
 * a refusal handler that removed another writer's file would also remove the retry a worker
 * is about to make with the right token. Settle-time cleanup takes the whole directory.
 */
function noteRejectedResult(entry: BgPending, file: string, reason: string): void {
  let signature = 'unknown';
  try {
    // lstat: the signature is of what is AT the name — for a link, the link.
    const stat = fs.lstatSync(file);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // vanished between the read and now — the signature stays coarse, which at worst
    // reports the same refusal twice
  }
  if (entry.lastRejectSignature === signature) {
    return;
  }
  entry.lastRejectSignature = signature;
  entry.lastRejectReason = reason;
  pushRejectedResult(file, reason);
}

/**
 * Keep one refused result file for diagnostics: a file that was well-formed enough to have an
 * opinion and was not this task's — a missing or wrong result token, or a task id that is not
 * the directory's. It settles nothing, and it is kept so a forged or misdirected result shows up
 * (in mesh_status, and in the failure message of the task it was found under) instead of
 * being ignored for ever.
 *
 * This ring used to hold unmatched cross-session MESSAGES too. The server no longer receives
 * any, so a refused file is the only thing left that can reach it and match nothing.
 */
function pushRejectedResult(file: string, reason: string): void {
  rejectedResults.push({ at: Date.now(), file, reason });
  while (rejectedResults.length > REJECTED_RING_MAX) {
    rejectedResults.shift();
  }
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
    ensureBgIoTaskDir(ioWorkspace(), entry.id);
  } catch {
    // cannot create it — the worker's write will fail too and the parked / timeout paths
    // report that honestly; watching is simply skipped
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
 * The single settle gate. Every terminal path (result file, parked without a result, timeout,
 * worker death, cancellation) goes through it, so a later signal — a file landing after the
 * timeout, a death detected just after success — is a guarded no-op rather than a double
 * resolution.
 */
function settle(entry: BgPending, deliver: () => void): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  clearEntryTimers(entry);
  pending.delete(entry.id);
  disarmResultWatch(entry);
  // Both shared clocks are released from the same place the entry leaves `pending`, so
  // "armed" can never outlive "there is something to sweep". A no-op while other tasks are
  // still pending, and safe to call from inside a sweep tick that is settling this entry.
  disarmDeadlineSweep();
  deliver();
}

function settleDone(entry: BgPending, report: string): void {
  // Inside the deliver closure so the commit runs exactly once — the settle gate fires it
  // once — and BEFORE resolve() hands the terminal report up, so the branch holds the work
  // and the report can name it. Best-effort: commitWorktreeIntoReport cannot throw.
  settle(entry, () => entry.resolve(commitWorktreeIntoReport(entry, report)));
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
 *   - Genuine mid-run exhaustion is already covered, and covered better: the parked path's
 *     quota rung reads authoritative plan usage (BgQuotaStallError) rather than prose.
 *
 * With no failover left on this path there is also nothing to clean up: the stale result
 * file that F10b had to unlink before a failover settle (the next attempt would reuse this
 * task id, this directory and this path, and settle instantly on the previous worker's
 * report) cannot strand anything, because this failure ends the dispatch. Settle-time
 * cleanup removes the whole io directory moments later.
 */
function settleWorkerError(entry: BgPending, report: string): void {
  // Commit on the error path too: a worker that reported a failure may still have produced
  // valuable partial edits, and force-removing its dirty worktree later would lose them.
  // Same guarantees as settleDone — once, before reject(), best-effort.
  settle(entry, () => entry.reject(new BgWorkerReportError(commitWorktreeIntoReport(entry, report))));
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

/** A session status in the words a failure message uses. */
function describeSessionStatus(status: WorkerSessionStatus | undefined): string {
  if (status === undefined) {
    return 'none — no liveness check had run yet';
  }
  switch (status.kind) {
    case 'busy':
      return 'busy (mid-turn)';
    case 'parked':
      return typeof status.waitingFor === 'string' && status.waitingFor !== ''
        ? `parked (its turn had ended; waiting for: ${sliceOneLine(flattenOneLine(status.waitingFor), 80)})`
        : 'parked (its turn had ended)';
    case 'gone':
      return 'gone (no running session)';
    default:
      return `unknown (${sliceOneLine(flattenOneLine(status.reason), 200)})`;
  }
}

/**
 * What this process observed about the task's worker, appended to every failure message: the
 * last session status the liveness tick read, and — when it happened — the one fact that
 * changes what a reader should do next.
 */
function diagnosticsTail(entry: BgPending): string {
  // A result file that EXISTED and was refused means the worker reported and the report was
  // rejected, not that it never reported at all (F2.1). The reason is readResultFile's own
  // sentence — literals only, never a value out of the refused file — followed by what to do
  // about it, because this message is the one place the orchestrator hears of the refusal.
  const refusedPart =
    entry.lastRejectSignature === undefined
      ? ''
      : `\n\nA result file at ${bgResultFilePath(entry.id)} was found and REFUSED: ` +
        `${entry.lastRejectReason ?? "the worker's result was refused"}. It settled nothing, ` +
        'however well-formed the rest of it was. So the worker DID try to report: treat this as ' +
        'a failure of the result protocol, not as "the worker produced nothing", and inspect its ' +
        'work where this message says it is. Nothing on your side needs changing before a ' +
        're-dispatch — the dispatcher puts the token on line 1 of every task file itself — and a ' +
        'refusal that repeats is a worker that is not following its completion protocol.';
  return (
    `\n\nLast session state observed for the worker: ${describeSessionStatus(entry.lastStatus)}.` +
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
    `Session worker ${entry.workerName} (account ${entry.account}) did not report within ` +
    `${entry.timeoutMinutes} minutes ` +
    'and was STOPPED. Unlike a one-shot worker it wrote no stdout to capture: its report travels ' +
    `through ${bgResultFilePath(entry.id)}, where no valid result appeared. Whatever the worker ` +
    `wrote persists in ${workTreeDescription(entry)}, so inspect that before re-dispatching; if the ` +
    'task legitimately needs longer, re-dispatch it with a larger timeout_minutes. Not retried on ' +
    'another account (a timeout is not a quota failure).' +
    diagnosticsTail(entry)
  );
}

/** The worker's session went away before it reported. `detail` is the liveness evidence. */
function deathMessage(entry: BgPending, detail: string): string {
  return (
    `Session worker ${entry.workerName} (account ${entry.account}) died before reporting its ` +
    `result — ${detail}. Nothing ` +
    `valid appeared at ${bgResultFilePath(entry.id)} within the ${Math.round(
      DEATH_GRACE_MS / 1000,
    )}s grace after its session disappeared, so the task is incomplete. Whatever the worker wrote ` +
    `persists in ${workTreeDescription(entry)} — inspect that before re-dispatching. Not retried on ` +
    'another account (a dead session is not a quota failure, and a replacement would redo work ' +
    'that may be half-done).' +
    diagnosticsTail(entry)
  );
}

async function onTimeout(entry: BgPending): Promise<void> {
  if (entry.settled) {
    return;
  }
  // Stop first: a worker that has blown its budget must stop burning quota even if the
  // read below turns out to settle the task successfully.
  entry.stopIssued = true;
  try {
    await entry.pool.stop(entry.workerName, { force: true });
  } catch {
    // the reaper and session-end stop are the backstops for a stop that failed here
  }
  if (entry.settled) {
    return;
  }
  // ONE final read: if the worker wrote its result in the moment before it was stopped, the
  // work stands and the dispatch is done even though we just stopped the session.
  scanEntry(entry);
  if (entry.settled) {
    return;
  }
  // Keep the task settleable for a last grace — a file landing here still wins.
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
 * Enter the timeout path, at most once per entry.
 *
 * Two clocks can decide this dispatch's deadline has passed: the entry's own timer, armed for
 * exactly timeoutMs, and the deadline sweep behind it. They must not BOTH run onTimeout — that
 * would stop the worker twice and arm two post-timeout graces, i.e. two settle attempts where
 * the contract allows one decision — so `timeoutEnteredAt` latches the first one in.
 *
 * The `.catch` is not decoration: an unhandled rejection would take the whole server down on
 * Node 18, and both callers fire from the event loop with no caller left to catch it.
 */
function enterTimeout(entry: BgPending): void {
  if (entry.settled || entry.timeoutEnteredAt !== undefined) {
    return;
  }
  entry.timeoutEnteredAt = Date.now();
  void onTimeout(entry).catch(() => undefined);
}

/**
 * One entry's turn in the wall-clock deadline sweep.
 *
 * WHY a second clock exists. A dispatch's timeout lives in a per-entry setTimeout owned by this
 * process, so an entry whose timer was lost, never armed, or whose settle path was missed has
 * nothing left to end it: the task stays `running` for ever and the orchestrator's tool call
 * never returns — an undefined failure mode, which this module's header forbids outright. (The
 * observed live case is the CROSS-SESSION form of the same hole: 90 minutes past a 30-minute
 * timeout, because the dispatching session died and took the timer AND the pending entry with
 * it. That half is settled from the durable task log by another process — which is why the
 * timeout is now recorded on the task's events, see BgTaskBase.timeoutMinutes. This sweep is
 * the in-session half, defence in depth.)
 *
 * It is NOT a second timeout POLICY, and that is the point of every line below:
 *   - the predicate is pastDeadline() — the same spawnedAt + timeoutMinutes arithmetic the
 *     armed timer is built from, and the same helper that already hands a past-deadline task
 *     to the timeout path in the parked path (onParkedTick, failParkedWorkerOnQuota). One definition of
 *     "out of time", read from a live source, so the sweep cannot settle a task that is not
 *     actually past its deadline — an early settle destroys a live dispatch;
 *   - the outcome is the timeout path's own: onTimeout for a task whose timer never reached
 *     it, and otherwise the BgTimeoutError + timeoutMessage() that onTimeout's grace owed. In
 *     particular it stays NON-quota, so it never cools an account down and never fails a
 *     half-done task over to a second worker;
 *   - everything terminal goes through settle(), never around it, so the sweep is simply one
 *     more racer against the result file and the original timer: the gate picks exactly one
 *     winner and the losers are guarded no-ops.
 */
function sweepEntryDeadline(entry: BgPending): void {
  if (entry.settled || !pastDeadline(entry)) {
    return;
  }
  const enteredAt = entry.timeoutEnteredAt;
  if (enteredAt === undefined) {
    // The ordinary case for this sweep: the deadline passed and the timer never fired.
    enterTimeout(entry);
    return;
  }
  if (Date.now() - enteredAt < TIMEOUT_PATH_STALL_MS) {
    return;
  }
  // The timeout path was entered and has settled nothing since, past every bounded step it
  // contains. Deliver the outcome it owed — and do NOT re-enter it: a second onTimeout on a
  // repeating tick would spawn a `claude stop` every DEADLINE_SWEEP_MS for ever.
  settle(entry, () => entry.reject(new BgTimeoutError(timeoutMessage(entry))));
}

/** One sweep tick over every pending task. Total by construction. */
function sweepDeadlines(): void {
  if (pending.size === 0) {
    // Nothing to sweep, and nothing to keep the timer armed for. Costs one Map size read.
    disarmDeadlineSweep();
    return;
  }
  // Iterated over a COPY: settling removes the entry from the map underneath us (scanResults
  // takes the same precaution, for the same reason).
  for (const entry of [...pending.values()]) {
    try {
      sweepEntryDeadline(entry);
    } catch {
      // One entry that throws must never deny every OTHER pending task its deadline, and
      // rethrowing would escape into the event loop as an uncaught exception. There is nothing
      // to report to from here — a task's failure surfaces through its own promise.
    }
  }
}

/**
 * Arm the shared deadline sweep, idempotently. Unref'd like every other timer in this module:
 * a backstop clock must never be the reason the process refuses to exit.
 */
function armDeadlineSweep(): void {
  if (deadlineSweep !== undefined) {
    return;
  }
  deadlineSweep = setInterval(() => {
    try {
      sweepDeadlines();
    } catch {
      // a sweep tick must never throw into the event loop
    }
  }, DEADLINE_SWEEP_MS);
  deadlineSweep.unref?.();
}

/** Release the sweep once nothing is pending at all (mirrors the results poll's disarm). */
function disarmDeadlineSweep(): void {
  if (pending.size === 0 && deadlineSweep !== undefined) {
    clearInterval(deadlineSweep);
    deadlineSweep = undefined;
  }
}

/**
 * Death does NOT reject immediately: workers commonly die RIGHT AFTER success (result
 * written, then stopped or closed before the next poll tick). Read once now, then hold
 * the task for one more grace during which a result file still settles it normally.
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
 * Session status — a worker PARKED without a result, and the liveness tick
 * ------------------------------------------------------------------------- */

/**
 * The task's wall-clock deadline has passed, so the TIMEOUT path owns it from here.
 *
 * Without this the two paths race in the last seconds of a long dispatch: a parked pass that
 * started just before the deadline could finish just after it and settle the task moments
 * after the timeout had already stopped the worker. Both outcomes are defensible, but only one
 * may happen, and the deadline is the older and more predictable authority — a task that has
 * run out of time has run out of time.
 */
function pastDeadline(entry: BgPending): boolean {
  return Date.now() - entry.spawnedAt >= entry.timeoutMinutes * 60_000;
}

/**
 * Exhausted plan windows that APPLY to this task's model — pickWorker's filter, verbatim:
 * session and weekly_all always count, while the frontier-only weekly_scoped window counts only
 * for a frontier candidate. The canonical exhaustedWindows() verdict (≥ 99% and not yet reset)
 * is the ONLY definition used here: a softer percent heuristic would fail a task over on an
 * account with real headroom.
 */
function exhaustedForTask(entry: BgPending, cache: UsageCache): UsageWindow[] {
  return exhaustedWindows(ownEntry(cache, entry.configDir), Date.now()).filter(
    (win) =>
      win.kind === 'session' ||
      win.kind === 'weekly_all' ||
      (win.kind === 'weekly_scoped' && isFrontierModel(entry.model)),
  );
}

/**
 * The worker's turn ended with no result and its account has no quota left. Leading prose is
 * deliberately longer than 300 characters and carries no worker-supplied text: recordFailure
 * slices lastError to 300 chars for the tree view.
 */
function quotaStallMessage(entry: BgPending, windows: UsageWindow[], parkedMs: number): string {
  return (
    `Session worker ${entry.workerName} (account ${entry.account}) ended its turn without writing ` +
    `its result file and stayed parked for ${Math.round(parkedMs / 1000)}s, and ${entry.account} ` +
    `is quota-exhausted per live plan usage: ${windows.map(formatExhaustedWindow).join(' · ')}. ` +
    'The session was STOPPED and this attempt is classified as a QUOTA failure, so the account ' +
    'cools down and the task fails over to another one — exactly what a one-shot worker does when ' +
    'a mid-run limit lands on its stderr. A mid-run limit is otherwise invisible over --bg: a turn ' +
    'that ended with no result plus an exhausted window is the only evidence there is. Whatever ' +
    `the worker wrote persists in ${workTreeDescription(entry)}.` +
    diagnosticsTail(entry)
  );
}

/**
 * Fail this attempt QUOTA-CLASSIFIED so it re-enters the ordinary failover loop.
 *
 * The worker is stopped FIRST: an account with no quota left cannot finish, and the next
 * attempt reuses this task's id, io directory and worktree name, so the session must be gone
 * before another one is started on them. Everything after the stop re-checks `settled`,
 * because the stop is awaited and a result file can land in that window — first-valid-wins
 * holds across this channel exactly like every other.
 */
async function failParkedWorkerOnQuota(
  entry: BgPending,
  windows: UsageWindow[],
  parkedMs: number,
): Promise<void> {
  entry.stopIssued = true;
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
  // the timeout path rather than settling it here — including leaving the result file alone,
  // so that path's last read still has something to find.
  if (pastDeadline(entry)) {
    return;
  }
  // The next attempt reuses this task id, so anything the stopped worker left in the io
  // directory must go: an unparseable fragment would linger, and a late complete write from the
  // dying session would settle a task that a DIFFERENT worker is now running. (The one write
  // that can still slip through is one already in flight inside the session we just stopped;
  // its content would at worst be this same task's honest report.)
  try {
    fs.unlinkSync(bgResultFilePath(entry.id));
  } catch {
    // never written, already gone — either way there is nothing to strand
  }
  settle(entry, () =>
    entry.reject(new BgQuotaStallError(quotaStallMessage(entry, windows, parkedMs))),
  );
}

/** POSIX single-quoting, for a value shown inside a command a person may paste. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that attaches a terminal to this task's worker, or undefined when there is no
 * job id to attach to.
 *
 * Built from values THIS process holds — the registry's config dir for the account it picked,
 * and the job id the CLI printed at spawn — rather than read back out of the ledger: the
 * ledger is a file, and this string is something a person is invited to paste. The job id is
 * rendered only in the shape the CLI mints (hex), since it is the one part left unquoted.
 */
function attachCommand(entry: BgPending): string | undefined {
  if (!/^[0-9a-f]+$/.test(entry.jobId)) {
    return undefined;
  }
  return `${claudeShellPrefix(entry.configDir, shellQuote)}claude attach ${entry.jobId}`;
}

/**
 * The worker ended its turn without writing its result file, and stayed that way.
 *
 * The first sentence is the contract's, verbatim, because it is what recordFailure's 300-char
 * `lastError` and every one-line surface show: what happened, what the session says it is
 * waiting for (when the platform recorded that), and how to get to it.
 */
function parkedMessage(entry: BgPending, parkedMs: number, evidence: string | undefined): string {
  const waiting =
    entry.waitingFor === undefined || entry.waitingFor === ''
      ? ''
      : ` (waiting for: ${entry.waitingFor})`;
  const attach = attachCommand(entry);
  const attachable =
    attach === undefined
      ? '. It is still running, but its spawn reported no job id, so no attach command can be given here — mesh_status lists it'
      : `. It is still attachable: ${attach}`;
  const evidencePart =
    evidence === undefined
      ? ''
      : ` The last text in its session transcript is appended to ${entry.outputFile} as UNVERIFIED ` +
        'evidence of what it was doing — it is not a result.';
  return (
    `worker ended its turn without writing the result file${waiting}${attachable}\n\n` +
    `Session worker ${entry.workerName} (account ${entry.account}) was parked — its turn over, its ` +
    `session still running — on every liveness check for ${Math.round(parkedMs / 1000)}s, and no ` +
    `valid result appeared at ${bgResultFilePath(entry.id)}. The dispatch is recorded as FAILED and ` +
    'is not retried on another account (a worker that stopped to wait is not a quota failure, and a ' +
    'replacement would redo work that may be half-done). The worker was NOT stopped: attach to see ' +
    `what it was waiting for, or message it with your own SendMessage (to: "${entry.workerName}"). ` +
    'Nothing collects a result from it any more, so if it carries on, review and commit what it ' +
    'writes yourself, and stop it with mesh_stop_worker once you are done with it. Whatever it wrote ' +
    `so far persists in ${workTreeDescription(entry)}.${evidencePart}` +
    diagnosticsTail(entry)
  );
}

/**
 * Ceiling on the transcript text copied into a parked task's output file. The text is one
 * assistant message, so this is far above anything a model normally emits; it exists so one
 * runaway message cannot push the output file past the size dispatch_status will still read.
 */
const PARKED_EVIDENCE_MAX_CHARS = 65_536;

/**
 * The last text the parked worker's own session transcript holds, when there is any.
 *
 * EVIDENCE, NEVER A RESULT — the same stance mesh/transcript and the reaper's recovery ladder
 * take: a worker that ended its turn without a result file has not reported, and its last
 * words are as likely to be a question as a deliverable. The text is only ever written under a
 * heading that says so (appendParkedEvidence); it never reaches `resolve`.
 *
 * When the text is over the ceiling the TAIL is kept: what a parked worker said last is what
 * says why it stopped.
 */
function parkedTranscriptEvidence(entry: BgPending): string | undefined {
  if (entry.jobId === '') {
    return undefined;
  }
  let text = '';
  try {
    const read = readWorkerTranscript(entry.configDir, entry.jobId);
    text =
      read.problem === undefined && typeof read.finalText === 'string' ? read.finalText.trim() : '';
  } catch {
    // documented never to throw; evidence is optional, the settle is not
    return undefined;
  }
  if (text === '') {
    return undefined;
  }
  if (text.length <= PARKED_EVIDENCE_MAX_CHARS) {
    return text;
  }
  let tail = text.slice(-PARKED_EVIDENCE_MAX_CHARS);
  // A cut can land between the halves of a surrogate pair; the orphaned low half is not a
  // character and would be written as U+FFFD.
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    tail = tail.slice(1);
  }
  return `[… ${text.length - tail.length} earlier characters omitted …]\n${tail}`;
}

/**
 * Append a parked worker's last transcript text to its task's output file, under a heading and
 * between delimiters that say what it is. Best effort (appendOutputNote never throws): the
 * terminal event and the thrown message already record the failure.
 */
function appendParkedEvidence(outputFile: string, err: BgParkedError): void {
  if (err.evidence === undefined) {
    return;
  }
  appendOutputNote(
    outputFile,
    "\n## Worker's last transcript text — UNVERIFIED, NOT A RESULT\n\n" +
      `This dispatch has NO result: worker ${headerText(err.workerName)} ended its turn without ` +
      'writing its result file. The text below is the last thing its session transcript holds, ' +
      'copied here as evidence of what it was doing or waiting for. Nothing has verified it, it ' +
      "may be a question rather than a deliverable, and it must not be handed on as this task's " +
      'result.\n\n' +
      "--- worker's last transcript text (unverified worker text; NOT a result) ---\n" +
      `${err.evidence}\n` +
      "--- end of worker's last transcript text ---\n",
  );
}

/** A parked episode is over: the next parked observation starts a new one, with a new probe. */
function endParkedEpisode(entry: BgPending): void {
  entry.parkedSince = undefined;
  entry.parkedResultStamp = undefined;
  entry.waitingFor = undefined;
  entry.usageProbeSpent = false;
}

/** Is this still the parked episode a pass started for, on a task nothing else has claimed? */
function sameParkedEpisode(entry: BgPending, episode: number): boolean {
  return (
    !entry.settled &&
    !entry.deathPending &&
    entry.timeoutEnteredAt === undefined &&
    entry.parkedSince === episode
  );
}

/** One read of the platform's verdict on this task's worker. Total: a throw is "no verdict". */
function readSessionStatus(entry: BgPending): WorkerSessionStatus {
  if (entry.jobId === '') {
    // No job id, no question to ask: the status is keyed on it. Never a reason to call a
    // worker dead — the dispatch timeout is the backstop.
    return { kind: 'unknown', reason: 'the spawn reported no job id for this worker' };
  }
  try {
    return entry.pool.sessionStatus({ jobId: entry.jobId });
  } catch (err) {
    // Specified never to throw. If it ever does, that is not evidence about the worker.
    return {
      kind: 'unknown',
      reason: `the session status could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * The worker has been PARKED — turn ended, session alive — for the whole grace while its task
 * is still pending. Decide what that is, in the contract's order:
 *
 *   1. read the result file once more — a valid one settles normally;
 *   2. the account's plan usage shows an exhausted window (cached first, then ONE bounded live
 *      probe per parked episode) → the turn ended on a limit: stop the worker and fail the
 *      attempt QUOTA-classified, which fails over. SKIPPED for a dispatch that was knowingly
 *      sent to an exhausted account under overage billing: its usage shows an exhausted window
 *      whatever the worker did, so this rung would stop a worker that merely asked a question,
 *      cool down the one account the operator chose to pay for, and hand the task to another;
 *   3. otherwise the worker stopped on its own — to ask, to wait, on an expired login — and
 *      the dispatch is settled as an ERROR that says so and says how to reach the worker. The
 *      worker is NOT stopped: someone may want to attach and look.
 *
 * This replaces the v1.x silence clock and its nudge, which measured relayed messages and so
 * measured nothing once the relay was gone. "Parked" is the platform's own statement that the
 * turn is over, so rung 3 is deterministic: it does not guess that a quiet worker is stuck.
 *
 * The probe is the only await before rung 3, and the world can change across it — the worker
 * may have been resumed by a message or by an attached human. So after it the platform is
 * asked AGAIN, and anything other than "still parked, same episode" abandons the pass; the
 * next tick starts from what is true then.
 */
async function settleParkedWorker(entry: BgPending, episode: number): Promise<void> {
  scanEntry(entry);
  if (!sameParkedEpisode(entry, episode)) {
    return;
  }
  // An unreadable cache is "no reading", which can never produce an exhausted verdict — the
  // safe direction, since a false quota verdict would fail a healthy worker over.
  let cache: UsageCache = {};
  try {
    cache = readUsageCache();
  } catch {
    // readUsageCache already swallows its own errors; this is belt and braces
  }
  // An overage dispatch has no quota rung (see above): no cached verdict, and no probe either.
  let windows = entry.billableOverage ? [] : exhaustedForTask(entry, cache);
  if (!entry.billableOverage && windows.length === 0 && !entry.usageProbeSpent) {
    // Spent BEFORE the await: a probe that throws, times out or is still running must not
    // license a second one on the next tick.
    entry.usageProbeSpent = true;
    let probed: AccountUsage[] | null = null;
    try {
      probed = await refreshAllUsageIfStale(
        PARKED_USAGE_MAX_AGE_MS,
        [{ name: entry.account, configDir: entry.configDir }],
        1,
        PARKED_USAGE_PROBE_TIMEOUT_MS,
      );
    } catch {
      // documented never to reject; if it ever does, the cached verdict above stands
    }
    if (!sameParkedEpisode(entry, episode) || pastDeadline(entry)) {
      return;
    }
    const now = readSessionStatus(entry);
    entry.lastStatus = now;
    if (now.kind !== 'parked') {
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
    // The result may have landed while the probe ran.
    scanEntry(entry);
    if (!sameParkedEpisode(entry, episode)) {
      return;
    }
  }
  const parkedMs = Date.now() - episode;
  if (windows.length > 0) {
    await failParkedWorkerOnQuota(entry, windows, parkedMs);
    return;
  }
  // Read BEFORE the settle, synchronously: nothing can interleave between here and the reject,
  // and the message has to be able to say whether there is evidence to look at.
  const evidence = parkedTranscriptEvidence(entry);
  settle(entry, () =>
    entry.reject(
      new BgParkedError(parkedMessage(entry, parkedMs, evidence), entry.workerName, evidence),
    ),
  );
}

/** `<mtimeMs>:<size>` of this task's result file, or 'absent' — what a parked episode watches. */
function resultFileStamp(taskId: string): string {
  try {
    const stat = fs.lstatSync(bgResultFilePath(taskId));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

/**
 * One PARKED observation. The episode's clock starts at the first of them and is restarted by
 * a change to the result file (a worker that is writing is not waiting), so the grace is only
 * ever spent on a worker that has demonstrably done nothing since its turn ended. Every other
 * kind of observation ends the episode outright — see onLivenessTick.
 */
function onParkedTick(entry: BgPending, waitingFor: string | undefined): void {
  const now = Date.now();
  const stamp = resultFileStamp(entry.id);
  if (entry.parkedSince === undefined || entry.parkedResultStamp !== stamp) {
    endParkedEpisode(entry);
    entry.parkedSince = now;
    entry.parkedResultStamp = stamp;
  }
  // The pool already flattens and bounds this; it is projected again because it comes out of a
  // session-registry file and goes into a message a model reads.
  entry.waitingFor =
    typeof waitingFor === 'string' ? sliceOneLine(flattenOneLine(waitingFor), 80) : undefined;
  if (entry.parkBusy || pastDeadline(entry) || now - entry.parkedSince < PARK_GRACE_MS) {
    return;
  }
  // `parkBusy` keeps a slow pass (a usage probe, then possibly a stop) from being re-entered by
  // the next tick; both settlements clear it, so a throw can never wedge the path shut or
  // escape into the event loop.
  entry.parkBusy = true;
  const done = (): void => {
    entry.parkBusy = false;
  };
  void settleParkedWorker(entry, entry.parkedSince).then(done, done);
}

/**
 * One liveness tick: ask the platform what this task's worker is doing, by JOB ID.
 *
 *   - busy    → mid-turn. Nothing to do but remember it was seen alive.
 *   - parked  → its turn ended while our task is still pending: the parked path above.
 *   - gone    → the death path — immediately when the worker had been seen alive, and
 *               otherwise only once ENTRY_APPEAR_GRACE_MS has passed since the spawn (`--bg`
 *               returns before its session is registered, so a young worker that is not
 *               there yet is normal, not dead).
 *   - unknown → no verdict, so no action. The dispatch timeout is the backstop.
 *
 * Anything but `parked` also ends a parked episode: the grace has to be parked on EVERY tick.
 * And once this process has itself stopped the worker (BgPending.stopIssued) the tick reads
 * nothing at all — what it would see is our own stop.
 */
function onLivenessTick(entry: BgPending): void {
  if (entry.settled || entry.deathPending || entry.stopIssued) {
    return;
  }
  const status = readSessionStatus(entry);
  entry.lastStatus = status;
  if (status.kind === 'parked') {
    entry.seenAlive = true;
    onParkedTick(entry, status.waitingFor);
    return;
  }
  endParkedEpisode(entry);
  if (status.kind === 'busy') {
    entry.seenAlive = true;
    return;
  }
  if (status.kind !== 'gone') {
    return;
  }
  if (entry.seenAlive) {
    onDeath(entry, 'its session had been running and is gone');
    return;
  }
  if (Date.now() - entry.spawnedAt > ENTRY_APPEAR_GRACE_MS) {
    onDeath(
      entry,
      `no running session for job ${entry.jobId} was ever seen, ` +
        `${Math.round(ENTRY_APPEAR_GRACE_MS / 1000)}s and more after the spawn (a Claude Code ` +
        'version whose session-entry format moved would look exactly like this)',
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
  /**
   * Who chose `model` for the attempt (task-runner.attemptModel) — the header's `- model source:`
   * line. Absent for the FAILED file, whose text has no summary block to put it in.
   */
  modelSource?: ModelSource;
  /**
   * The model the session's transcript says ran (sessionModelOf) — the header's `- model ran:`
   * line. Known only once the worker has reported, so the RUNNING header never has it.
   */
  modelUsed?: string;
  /**
   * The task's id — what the three writers below hand registry.writeTaskFile, which finds the
   * report by id and REPLACES whatever is at its name instead of opening it.
   */
  id: string;
  outputFile: string;
  /**
   * Filled in AFTER the spawn (A11): only the pool knows whether this workspace got a
   * worktree, so the RUNNING header is written without it and the DONE rewrite carries it.
   */
  worktree?: string;
  branch?: string;
}

/**
 * The header lines between `- model:` and the rest of the block: what ran and who chose the
 * model, then the flags. The model lines are task-runner's own (modelHeaderLines), so a session
 * worker's report says them in the words a one-shot worker's does.
 *
 * `- model ran:` comes from the session's transcript, not from the worker: a session worker
 * hands back no result document naming a model, and its own statement about which model it is
 * would be a claim. See sessionModelOf for what the transcript is taken to say.
 */
function headerFlags(ctx: OutputContext): string {
  return (
    (ctx.modelSource !== undefined ? modelHeaderLines(ctx.modelSource, ctx.modelUsed) : '') +
    (ctx.ultrathink ? '\n- ultrathink: true' : '') +
    (ctx.billableOverage ? '\n- overage: billing past plan window' : '')
  );
}

/**
 * RUNNING header + the prompt, written before the spawn so a live task is inspectable.
 *
 * Every caller-supplied value in the header goes through headerText, imported from task-runner
 * rather than reimplemented here: ONE implementation is what makes the two dispatch paths treat
 * header values identically by construction instead of by discipline, so a title that renders
 * one way in a `-p` task's file cannot render another way in a `--bg` one.
 *
 * What this block IS — a summary for a human — and what may never be inferred from it — anything
 * machine-readable, because the file quotes arbitrary prompt and worker text — are stated once,
 * at the top of task-runner's header-composition section. Do not restate them here; do not
 * contradict them anywhere.
 */
function writeRunningOutput(ctx: OutputContext): void {
  try {
    writeTaskFile(
      ctx.id,
      'output',
      `# ${headerText(ctx.title)}\n\n- status: RUNNING (started ${new Date().toISOString()})\n- worker: ${headerText(ctx.account)}\n- model: ${headerText(ctx.model)}${headerFlags(ctx)}\n\n---\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n`,
    );
  } catch {
    // best effort — the task still runs and the DONE/FAILED writer overwrites this
  }
}

/**
 * One line naming the task's worktree, for the surfaces that tell the orchestrator what it
 * now has to verify and merge (A11). Empty in a non-git workspace, where the worker edited
 * the tree directly and there is nothing extra to integrate.
 *
 * Both values go through headerText like every other header value: they are not the
 * dispatcher's own arguments but strings handed back by the worker pool, they are displayed
 * verbatim in the file and in whatever echoes it, and an undefined failure mode is not a place
 * to start trusting a string's shape.
 */
function worktreeLine(ctx: OutputContext): string {
  return ctx.worktree === undefined
    ? ''
    : `\n- worktree: ${headerText(ctx.worktree)}${
        ctx.branch === undefined ? '' : ` (branch ${headerText(ctx.branch)})`
      }`;
}

/**
 * DONE rewrite. Token/cost columns are zeros and labelled n/a on purpose: usage is
 * unknowable over `--bg` (there is no result JSON to read it from). Live PLAN usage is
 * unaffected — it is probed from the account itself, not accumulated here.
 */
function writeDoneOutput(ctx: OutputContext, workerName: string, report: string): void {
  try {
    writeTaskFile(
      ctx.id,
      'output',
      // Header values put through headerText exactly as in writeRunningOutput — the title, the
      // account, the model and the pool's own worker name. The `- tokens:` line is a literal
      // here (usage is unknowable over `--bg`), so it is the one summary number nothing can
      // influence.
      `# ${headerText(ctx.title)}\n\n- worker: ${headerText(ctx.account)}\n- model: ${headerText(ctx.model)}${headerFlags(ctx)}\n- mesh: session worker ${headerText(workerName)} (report read from its result file; tokens n/a)${worktreeLine(ctx)}\n- tokens: 0 in / 0 out\n\n---\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n\n## Result\n\n${report}\n`,
    );
  } catch {
    // the terminal event and the returned string already carry the result
  }
}

function writeFailedOutput(ctx: OutputContext, message: string): void {
  try {
    writeTaskFile(
      ctx.id,
      'output',
      // A FAILED file gets no summary block and no `---` rule: there is nothing to summarise,
      // and a rule would only suggest a structure this file does not have. The title still goes
      // through headerText for the reason every displayed value does — it reaches a tree label,
      // a webview cell and `dispatch_status` output, and it must render as what it says. The
      // `message` keeps its full text: it is body, and body is quoted material.
      `# ${headerText(ctx.title)}\n\nFAILED: ${message}\n\n## Prompt\n\n${ctx.prompt}${ctx.systemPromptSection}\n`,
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
  /**
   * Pre-assigned task id: set by a dispatch host, which minted the id and announced it to its
   * client before the task was queued (contract §15.5), so the task's events, files and answer
   * carry that one. Unset on stdio, where this core mints its own exactly as before.
   */
  preassignedId?: string;
}

/** Task identity carried on every event for this dispatch (never a pid — see P4.10). */
interface BgTaskBase extends TaskBase {
  promptPreview: string;
  promptFile?: string;
  meshWorker?: string;
  /**
   * This dispatch's own timeout, in minutes, written onto the task's events so the DEADLINE
   * outlives the process that owns the timer.
   *
   * The timer that enforces the timeout and the `pending` entry it fires against both live in
   * THIS session's memory, so when the session dies the task stays `running` in the log with
   * nothing left to time it out (observed live at 90 minutes past a 30-minute timeout). The
   * task log is the only durable record either way, so the deadline goes into it in the one
   * form another process can evaluate without knowing anything about this one: the event's own
   * `ts` plus this value.
   *
   * PURELY ADDITIVE, in both directions. Nothing here reads it back — every in-session path
   * derives the deadline from the live pending entry's spawnedAt/timeoutMinutes (pastDeadline),
   * which is the same arithmetic from a source that cannot be stale — and an event written
   * WITHOUT it must keep behaving exactly as it does today, which is why it is optional here
   * and must stay optional wherever it is ever consumed.
   *
   * Declared on THIS interface rather than left to TaskEvent alone: TaskBase is a Pick of
   * TaskEvent that does not include it, so `base` needs it here to carry it at all. It reaches
   * appendTaskEvent through the object spread, which TypeScript does not subject to
   * excess-property checking, so this compiles whether or not TaskEvent has grown its own
   * optional `timeoutMinutes` yet — and JSON.stringify writes the field either way.
   */
  timeoutMinutes?: number;
  /**
   * SHA-256 of this dispatch's result token (ioToken.ioTokenDigest), recorded on its RUNNING
   * events — and ONLY there.
   *
   * WHY ANYTHING ABOUT THE TOKEN IS IN THE LOG. In this session the expected token is in this
   * process's memory (BgPending.ioToken). A LATER session — the one that finds this task still
   * `running` after this process died — has no such memory, and still has to decide whether a
   * `result.json` it finds is this task's. The task log is the one record that outlives the
   * process and sits outside every directory a worker is granted, so the expectation is kept
   * there (mesh/reaper resolves it with registry.firstRecordedIoToken).
   *
   * WHY ONLY THE DIGEST. The log is a file every process of this user can read, and it is kept
   * for the life of the installation. With the token itself in it, reading the log was enough
   * to write a result this dispatch accepted while its worker was still working. A SHA-256
   * lets a later reader check a presented token and gives a reader of the log nothing to
   * present. The token itself rests in one place on disk, the first line of the task file,
   * inside the task's own io directory — which is removed when the dispatch settles.
   *
   * On every RUNNING event and never on a terminal one. The expectation is fixed by the FIRST
   * event of the task that carries one; the later running events carry it because its presence
   * is also how an event says "this is a session-worker dispatch" before the pool has named
   * the worker (registry.isMeshDispatchEvent).
   */
  ioTokenSha256?: string;
}

/**
 * The task base for a RUNNING event: this dispatch's identity plus the digest of its result
 * token (BgTaskBase.ioTokenSha256). NEVER the token.
 *
 * Kept apart from `base` itself rather than set on it, because `base` is spread into the
 * terminal `done` event too. Applied at each RUNNING append instead of once up front so it
 * composes with the mutation those appends straddle (`base.meshWorker` is filled in between
 * them).
 */
function runningBase(base: BgTaskBase, ioToken: string): BgTaskBase {
  return { ...base, ioTokenSha256: ioTokenDigest(ioToken) };
}

/**
 * Identity the bootstrap prompt gives the worker.
 *
 * CONTRACT SEAM (flagged to the orchestrator): §2's bootstrap builder wants the mesh
 * worker NAME, but §3 has the pool choose that name (nextSeq/meshWorkerName) INSIDE
 * spawnDispatchWorker — and the bootstrap is that call's argv prompt, so the caller
 * cannot know it yet. A task-scoped identity is used instead: it is unique per dispatch,
 * true (the session exists only for this task), and cannot contradict the session's real
 * registry name, which is what everything else keys on (the `--name` the pool passes, the
 * `peer:` line of the result, and `claude stop <jobId>`).
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
  // The reader registry.appendTerminalTaskEvent decides by, so that this answer and the close
  // agree.
  const latest = latestTaskEventOf(taskId);
  if (typeof latest === 'string' || latest.status === 'running') {
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
 * What to do about an untrusted workspace, out of the pool's `workspace_untrusted` spawn
 * error: one line, no trailing period.
 *
 * The pool writes that error's detail to be shown as it is — `<account> has not trusted this
 * workspace for background sessions — <the CLI's own instruction>`, followed by the exact
 * command for that account when one is needed — so what follows the dash is taken whole. The
 * two fallbacks cover a detail that arrives in another shape: the CLI's raw refusal (everything
 * after its marker sentence), and then the instruction spelled out here, so the reader is never
 * left with a bare "not trusted".
 */
function untrustedInstruction(detail: string): string {
  const line = detail.split('\n', 1)[0];
  const dash = line.indexOf(' — ');
  const marker = line.indexOf(WORKSPACE_NOT_TRUSTED_MARKER);
  const raw =
    dash >= 0
      ? line.slice(dash + 3)
      : marker >= 0
        ? line.slice(marker + WORKSPACE_NOT_TRUSTED_MARKER.length)
        : '';
  const said = flattenOneLine(raw)
    .replace(/^[\s.:—-]+/, '')
    .replace(/[\s.]+$/, '');
  return said !== ''
    ? said
    : `run \`claude\` in ${ioWorkspace()} once under that account and accept the trust prompt, then retry`;
}

/**
 * Is this worker's session still running, by the platform's own account of it? Evidence only:
 * `unknown` is not "live", because the `peer:` line this decides is an invitation to message
 * the worker and must not be printed for one nobody could confirm.
 */
function sessionIsLive(pool: IWorkerPool, jobId: string): boolean {
  if (jobId === '') {
    return false;
  }
  try {
    const kind = pool.sessionStatus({ jobId }).kind;
    return kind === 'busy' || kind === 'parked';
  } catch {
    return false;
  }
}

/**
 * Can the orchestrator's own SendMessage address this worker by name right now? The pool's
 * answer for the record with this job id (MeshWorkerStatus.peerVisible): `false` when it looked
 * in the host account's session registry and the worker is not there yet — a worker under
 * another account is addressable only once the bridge has mirrored its entry — and `undefined`
 * when that could not be checked. Only a positive `false` changes what the result says.
 */
function peerVisibility(pool: IWorkerPool, jobId: string): boolean | undefined {
  if (jobId === '') {
    return undefined;
  }
  try {
    return pool.list().find((worker) => worker.jobId === jobId)?.peerVisible;
  } catch {
    return undefined;
  }
}

/**
 * Run ONE attempt: cap check, announce, spawn, then await the result. Returns the
 * worker's report; throws a quota-classified BgSpawnFailure or a BgQuotaStallError (the two
 * failover triggers), BgCapError, BgWorkspaceUntrustedError, BgCancelledError, BgTimeoutError,
 * BgWorkerDeathError, BgParkedError, BgWorkerReportError, or a plain Error for the remaining
 * failure paths.
 */
async function runBgAttempt(opts: {
  id: string;
  /**
   * Per-dispatch result token (F2.1). It is already on the first line of the task file; here
   * it becomes the pending entry's expectation and, hashed, the mark on the RUNNING events.
   */
  ioToken: string;
  ctx: BgRunContext;
  registry: Registry;
  worker: WorkerProfile;
  model: string;
  timeoutMinutes: number;
  ultrathink: boolean;
  base: BgTaskBase;
  output: OutputContext;
  onSpawned(info: { name: string; jobId: string; worktree?: string; branch?: string }): void;
}): Promise<string> {
  const { ctx, registry, worker, model, base, id } = opts;
  const spawned = await serializeWorkerOp(async (): Promise<WorkerSpawnResult> => {
    // Cancelled while this attempt waited for its turn here (another dispatch's spawn held the
    // chain, which can take as long as SPAWN_TIMEOUT_MS): nothing is announced and nothing is
    // started. The check after selection, in the caller, cannot see a cancel that lands during
    // that wait, and without this one the task was announced, spawned and only then stopped —
    // with its `running` event left behind for nobody to close, the cancel having come before
    // the task was trackable. A cancel by `cco cancel` of a task still queued relies on it: that
    // task's terminal event is already written, and must stay its last (contract §15.5).
    if (ctx.shouldAbort()) {
      throw new BgCancelledError();
    }
    // P4.7: count and spawn inside ONE critical section, using the ledger formula (a
    // fresh spawn occupies its slot the moment its record is written, before its session
    // registers), so a batch cannot overshoot the cap. Refuse, never queue — queueing a >cap
    // batch would deadlock waiting for slots that only the caller could free.
    //
    // What is counted is dispatches IN FLIGHT, not live sessions: a worker whose dispatch has
    // settled stays attachable for as long as the user wants it and holds no slot, so the cap
    // bounds concurrent WORK — which is what spends quota.
    const cap = registry.meshMaxLiveWorkers;
    let inFlight = 0;
    try {
      inFlight = ctx.pool.inFlightCount();
    } catch {
      // an unreadable ledger must not brick dispatch; treat it as "nothing known to be in flight"
      inFlight = 0;
    }
    if (inFlight >= cap) {
      throw new BgCapError(
        meshError(
          'worker_cap',
          'this dispatch was refused, not queued — wait for one to settle or raise ' +
            `"claudeCodeOrchestrator.meshMaxLiveWorkers": ${inFlight} dispatch(es) already in ` +
            `flight (cap ${cap}). Parked workers do not count.`,
        ),
      );
    }
    // Announce only once the spawn is actually going to happen: a cap refusal must leave
    // no dangling `running` event behind (parity with the `-p` frontier-guard refusal).
    appendTaskEvent({ ...runningBase(base, opts.ioToken), ts: Date.now(), status: 'running' });
    ctx.onTrack(base);
    writeRunningOutput(opts.output);
    try {
      return await ctx.pool.spawnDispatchWorker({
        account: worker.name,
        configDir: worker.configDir,
        model,
        permissionMode: registry.permissionMode,
        // Fixed-size argv prompt: the task itself is in the file written before this call —
        // and so is the result token, on that file's first line. The prompt is a command-line
        // argument any local user can read, so it is not given the token at all.
        prompt: bgDispatchBootstrapPrompt({
          workerName: bootstrapIdentity(id),
          taskId: id,
          // The workspace, not a path: the bootstrap derives the same absolute task/result
          // paths this module reads and the pool grants, from the one layout implementation.
          cwd: ioWorkspace(),
          // Worktree detection is the SAME helper the pool spawns by (contract
          // isGitWorkspace), so the sentence the worker reads and the flag it actually
          // boots with cannot disagree — the bootstrap is built before the pool has run.
          worktree: isGitWorkspace(process.cwd()) ? bgWorktreePath(id) : undefined,
          ultrathink: opts.ultrathink,
        }),
        taskId: id,
        ownerPid: ctx.ownerPid,
        ownerStartedAt: ctx.ownerStartedAt,
        // The durable copy of this dispatch's deadline: the in-flight cap and every
        // cross-session reader take it from the ledger instead of re-deriving a clock.
        deadlineAt: Date.now() + opts.timeoutMinutes * 60_000,
        // The session worker's DISPATCHED_TASK_ENV (contract §15.5): every worker this code base
        // starts carries its task id. Whether the background session the launcher registers
        // inherits the launcher's environment is the CLI's to decide (stated).
        extraEnv: { [DISPATCHED_TASK_ENV]: id },
      });
    } catch (err) {
      // The pool reports failures in its result object; a throw is unexpected, so it is
      // converted rather than allowed to break the serialization chain's contract. It carries
      // no `failedAt`, which is what keeps its text away from the quota classifier below.
      return { ok: false, error: `spawnDispatchWorker threw: ${(err as Error).message}` };
    }
  });
  if (spawned.ok !== true || typeof spawned.name !== 'string' || spawned.name === '') {
    const detail = spawned.error ?? 'the worker pool reported a failed spawn with no detail.';
    // Checked BEFORE the quota classification, by the pool's own error code rather than by
    // prose: an account that has not trusted this workspace is not a failing account, and the
    // refusal text quotes a directory path that isQuotaError must never get to read.
    if (/mesh error \[workspace_untrusted\]/.test(detail)) {
      throw new BgWorkspaceUntrustedError(worker.name, untrustedInstruction(detail), { ...base });
    }
    // WHOSE WORDS ARE READ FOR A QUOTA VERDICT is decided by what the pool SAYS the failure was
    // (WorkerSpawnResult.failedAt), never by what the message happens to contain. Only a
    // `launch` failure has the account speaking — the CLI's own output, which is how a quota
    // refusal arrives — and only that output is classified (`cliOutput`), not the sentence the
    // pool wrapped around it: that carries a worker name built from the account's name. All
    // the rest is this machine speaking: the pool's gate, a ledger that could not record the
    // session (its reason names a lock's holder and two file paths), a throw out of the pool.
    // A "rate limit" or a "quota" in any of those would cool a healthy account down for half an
    // hour and start the task again on another one.
    const quota =
      spawned.failedAt === 'launch' &&
      typeof spawned.cliOutput === 'string' &&
      isQuotaError(spawned.cliOutput);
    throw new BgSpawnFailure(detail, quota);
  }
  const workerName = spawned.name;
  const jobId = typeof spawned.jobId === 'string' ? spawned.jobId : '';
  // The POOL is the authority on the worktree: it ran the git detection and it is the only
  // component that knows whether `-w` was actually passed. The bootstrap's own detection
  // above only decides what the worker is TOLD; what gets reported and merged comes from
  // here, so a disagreement can never invent a worktree that does not exist.
  const worktree = typeof spawned.worktree === 'string' ? spawned.worktree : undefined;
  const branch = typeof spawned.branch === 'string' ? spawned.branch : undefined;
  opts.onSpawned({ name: workerName, jobId, worktree, branch });
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
  appendTaskEvent({ ...runningBase(base, opts.ioToken), ts: Date.now(), status: 'running' });
  ctx.onTrack(base);
  return awaitBgResult(opts.id, opts.ctx, opts.worker.name, workerName, opts.output.outputFile, {
    jobId,
    title: opts.output.title,
    timeoutMinutes: opts.timeoutMinutes,
    model: opts.model,
    billableOverage: opts.output.billableOverage,
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
    jobId: string;
    title: string;
    timeoutMinutes: number;
    model: string;
    billableOverage: boolean;
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
      billableOverage: meta.billableOverage,
      workerName,
      jobId: meta.jobId,
      ioToken: meta.ioToken,
      worktree: meta.worktree,
      branch: meta.branch,
      outputFile,
      spawnedAt,
      timeoutMinutes: meta.timeoutMinutes,
      pool: ctx.pool,
      settled: false,
      seenAlive: false,
      deathPending: false,
      stopIssued: false,
      usageProbeSpent: false,
      parkBusy: false,
      timers: new Set<NodeJS.Timeout>(),
      resolve,
      reject,
    };
    pending.set(id, entry);
    armResultWatch(entry);
    // The wall-clock backstop behind the per-entry timer below. Armed from the same place the
    // entry enters `pending` so the two can never disagree about whether anything is pending.
    armDeadlineSweep();
    const liveness = setInterval(() => {
      try {
        onLivenessTick(entry);
      } catch {
        // a liveness tick must never throw into the event loop; the next one retries
      }
    }, LIVENESS_POLL_MS);
    liveness.unref?.();
    entry.livenessTimer = liveness;
    // The primary deadline clock. It routes through enterTimeout rather than calling onTimeout
    // directly so that it and the sweep are the same latched entry into the timeout path.
    armTimer(entry, timeoutMs, () => enterTimeout(entry));
    // A fast worker can write its result file before `claude --bg` even returns, so the
    // first read happens now rather than one poll tick from now.
    scanEntry(entry);
  });
}

/**
 * The `--bg` dispatch core: same contract as runDispatchTask (blocking call in, result
 * string out, identical failover/timeout/cancel semantics), with a persistent attachable
 * worker in place of a `claude -p` child. server.ts picks between the two.
 *
 * ITS FIRST ACT IS THE ARGUMENT CHECK (dispatch-args.checkDispatchArgs — shape and size, by the
 * one rule every entry uses), and from there on only the CHECKED arguments exist. The declared
 * type of `args` is a claim about JSON that arrived over a pipe: before this check a number
 * where a string was declared threw a TypeError out of the first `.trim()`, and a title of any
 * length — megabytes of it — went into every event of the task, the output file's header and
 * the status surfaces. A refusal is reported the way an invalid model is on this path: a thrown
 * message, with nothing spawned, no id minted and nothing appended to the task log. The check is
 * idempotent, so arguments the server already checked pass unchanged.
 */
export async function runBgDispatchTask(args: DispatchArgs, ctx: BgRunContext): Promise<string> {
  const checked = checkDispatchArgs(args);
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const task = checked.args;
  // One line of at most DISPATCH_TITLE_MAX_CHARS, and the only title this dispatch has: the one
  // in its events, in its output file's header and in mesh_status. Nothing else about a session
  // worker is derived from it — the session's name is `cco-w-<workspace>-<account>-<seq>` and its
  // worktree is `cco-<task id>`, both built from values this server mints.
  const { title, prompt, ultrathink } = task;
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    // Not "none registered" when the worker that was named IS registered, as an entry this
    // version cannot use: that sentence would send the caller to add an account they have.
    const unusable =
      task.worker === undefined ? undefined : unsupportedWorkerRefusal(task.worker, registry.unsupportedWorkers);
    throw new Error(
      unusable ?? 'No worker accounts registered. In VS Code, run "Claude Code Orchestrator: Add Worker Account".',
    );
  }
  // Before anything is created for this dispatch — no id, no files, no event. Where the task
  // may land comes first, through the one-shot core's own accessor: a `provider` that is not
  // one and a `provider` that contradicts the named worker's are refused there, with the same
  // words.
  //
  // A SESSION WORKER IS A CLAUDE CODE SESSION, so this core selects among Claude Code workers
  // and nothing else. The server never hands it a dispatch that targets another vendor's CLI —
  // that one takes the one-shot core whatever Mesh Mode says — and the refusal below is what
  // keeps that true if a caller ever does.
  const target = resolveDispatchTarget(task, registry.workers);
  if (target.provider !== 'claude') {
    throw new Error(
      `a ${providerInfo(target.provider).label} worker cannot run as a session worker — only ` +
        'Claude Code accounts can. This dispatch runs as a one-shot worker.',
    );
  }
  const candidates = dispatchCandidates(target, registry.workers);
  if (candidates.length === 0) {
    throw new Error(noWorkerForProviderMessage(target.provider, registry.workers));
  }
  // An explicit model that is not one is a REJECTED request, not a failed task, and nothing is
  // recorded against any worker for it. The rule is the one-shot core's own accessor, imported
  // rather than respelled, so the two dispatch paths reject the same values with the same words.
  const requestedModel = resolveRequestedModel(task.model);
  const timeoutMinutes = clampTimeoutMinutes(task.timeout_minutes ?? registry.workerTimeoutMinutes);

  ensureDirs();
  // A dispatch host's id when it pre-assigned one (it announced it before the task was queued);
  // else this core's own, exactly as before.
  const id = ctx.preassignedId ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const attempted = new Set<string>();
  const maxAttempts = target.workerName !== undefined ? 1 : candidates.length;
  let lastError: Error | undefined;
  let lastErrorQuota = false;
  // The model the attempt made last asked for, and who chose it — what the dispatch's failure
  // event says, as that attempt's own `running` events did. Until an attempt exists only a
  // model the dispatch named is known: `-` otherwise, and then with no source at all.
  let lastModel: string = requestedModel ?? '-';
  let lastModelSource: ModelSource | undefined = requestedModel !== undefined ? 'dispatch' : undefined;
  // The frontier guard as it applies here: this core selects among Claude Code accounts only.
  const frontierGuardBlocks = registry.frontierWorkerDispatch !== 'allow';
  let cancelled = false;
  // promptPreview is built from the USER's task prompt, never the bootstrap wrapper —
  // the surfaces that show it are answering "what is this task", not "how was it started".
  // Flattened by the SHARED one-line rule and capped by the SHARED constant, both imported
  // rather than respelled: this preview and the `-p` path's are the same field, read by the
  // same tooltip and the same webview `title=`, so a prompt carrying an ESC or a bidi override
  // must not render one way per dispatch path. See displayText.flattenOneLine.
  const promptPreview = sliceOneLine(flattenOneLine(prompt), PROMPT_PREVIEW_MAX);
  // The FULL user prompt persisted beside the preview so a surface can show the whole task,
  // not just its first 300 chars. Written here (before any settle-time cleanup) and pointed
  // at by promptFile on the events; the write is best-effort and cannot fail the dispatch.
  const promptFile = path.join(TASKS_DIR, `${id}.prompt.txt`);
  writeBgPromptFile(id, prompt);
  const systemPrompt = task.system_prompt;
  const systemPromptSection = systemPrompt ? `\n\n## Task system prompt\n\n${systemPrompt}` : '';
  const usageCache = readUsageCache();
  const overageAllowed = registry.overageWorkerDispatch === 'allow';
  const probedDirs = new Set<string>();
  // Every record this dispatch writes about itself goes through here, so that none of them can
  // change its outcome (task-runner's TaskBookkeeping — the same writer the one-shot core
  // uses). This core only ever runs inside the server, which outlives the task.
  const books = new TaskBookkeeping(id, true);

  // Minted once per DISPATCH, not per attempt: it travels in the task file, which every
  // failover attempt reuses, and it is what the pending entry checks every result against
  // (F2.1). Rotating it per attempt would only invalidate the file the next worker reads.
  // From here it goes to exactly three places: the first line of the task file, this process's
  // pending entry, and — as a SHA-256 — the task's RUNNING events.
  const ioToken = newIoToken();

  // The task file is the worker's ONLY copy of the task, and every failover attempt reads
  // the same one — so it is written once, before any spawn. A failure here is fatal for
  // this dispatch: a worker that cannot read its task has nothing to do but report an error.
  try {
    writeBgTaskFile(id, {
      ioToken,
      basePrompt: WORKER_BASE_PROMPT,
      systemPrompt,
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
  /** That worker's job id — what its session status is read by ('' if the spawn reported none). */
  let liveJobId = '';
  /** Worktree the live worker edits in (A11), for the result the orchestrator must merge. */
  let liveWorktree: string | undefined;
  let liveBranch: string | undefined;
  /**
   * Job ids of the workers this dispatch spawned whose ledger records do not yet say their
   * dispatch is over. Drained by markSettled() AFTER the outcome is in the task log — at the
   * done event, at a failover, at the failure event — and once more in the finally, which is
   * what covers a cancel and a foreign terminal event (written by somebody else, before we
   * get there).
   */
  const unsettledJobs = new Set<string>();
  const markSettled = (): void => {
    for (const jobId of unsettledJobs) {
      markSettledBestEffort(ctx.pool, jobId);
    }
    unsettledJobs.clear();
  };
  /**
   * This dispatch ended as "parked without a result", so its worker was deliberately left
   * running. Its io directory is then left in place too: the worker's whole task is the file
   * in it, and somebody who attaches to see what it was waiting for may well tell it to carry
   * on. Nothing reads a result from there any more; the 24h stale sweep removes it.
   */
  let parkedWorkerLeftRunning = false;
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
          candidates,
          target.workerName,
          attempted,
          requestedModel,
          usageCache,
          overageAllowed,
          probedDirs,
          frontierGuardBlocks,
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
      // The one-shot core's own decision (task-runner.attemptModel), so both paths settle an
      // attempt's model, and who chose it, by one rule. A Claude Code account always has a
      // default, so the source here is `dispatch` or `worker`.
      const { model, source: modelSource } = attemptModel(requestedModel, worker);
      // Billing guard, identical to the `-p` path. It refuses a dispatch that NAMED a frontier
      // model (the same model would be asked of every account) and one that named this WORKER
      // and no model (there is no other attempt). A dispatch that named neither never gets here
      // with a blocked default: selection passed that account over (task-runner.pickWorker).
      if (isFrontierModel(model) && frontierGuardBlocks) {
        throw new Error(
          frontierBlockedMessage(
            requestedModel !== undefined
              ? 'the requested model'
              : `the default model of worker "${worker.name}"`,
          ),
        );
      }
      // From here on this is an attempt the task's records speak of.
      lastModelSource = modelSource;
      lastModel = model;
      const base: BgTaskBase = {
        id,
        title,
        worker: worker.name,
        model,
        // On `base`, so every event of this attempt carries it, the server's cancel included.
        modelSource,
        outputFile,
        cwd: process.cwd(),
        promptPreview,
        promptFile,
        // The deadline, made durable. Set on `base` rather than at one call site so BOTH
        // spawn-time RUNNING events carry it — the one announced before the spawn and the one
        // re-announced with the worker name after it — and so does a failover attempt's
        // re-announce, whose fresh `ts` restarts the derived deadline exactly as the in-memory
        // clock restarts at the new attempt's spawnedAt.
        timeoutMinutes,
      };
      const output: OutputContext = {
        title,
        prompt,
        systemPromptSection,
        ultrathink,
        billableOverage,
        account: worker.name,
        model,
        modelSource,
        id,
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
          ultrathink,
          base,
          output,
          onSpawned: (info) => {
            liveWorkerName = info.name;
            liveJobId = info.jobId;
            liveWorktree = info.worktree;
            liveBranch = info.branch;
            if (info.jobId !== '') {
              unsettledJobs.add(info.jobId);
            }
          },
        });
        // What ran, as the session's own transcript records it — read now, once the worker
        // has reported, and only for a task that ends `done`, as a one-shot run's is. Absent
        // when the transcript does not say (sessionModelOf).
        const modelUsed = liveJobId !== '' ? sessionModelOf(worker.configDir, liveJobId) : undefined;
        output.modelUsed = modelUsed;
        // Usage is unknowable over `--bg`, so the success is recorded with zero tokens and
        // zero cost rather than a guess. The worker is deliberately NOT stopped: it stays
        // attachable, and teardown belongs to the orchestrator's doctrine plus the session-end
        // stop.
        //
        // The worker has reported. Nothing recorded about that from here on can undo it.
        books.recordSuccess(worker.name, { text: report, inputTokens: 0, outputTokens: 0, costUsd: 0 });
        writeDoneOutput(output, liveWorkerName ?? '-', report);
        books.terminalEvent({
          ...base,
          ts: Date.now(),
          status: 'done',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          ...(modelUsed !== undefined ? { modelUsed } : {}),
        });
        // After the DONE writer above, which replaces the whole file.
        books.annotate(outputFile);
        // The dispatch is over; the worker is now parked and no longer holds a cap slot.
        markSettled();
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
        // The worker is a peer session the orchestrator can message with its own SendMessage,
        // addressed by this name. Printed only while the platform says the session is running:
        // an invitation to steer a worker that is gone is worse than no line. And the
        // invitation itself only when the name can actually be reached: a worker the host
        // account cannot see yet gets a line that says so and where to look, because a
        // SendMessage to it now would fail and read as "the worker is gone".
        const peerNote =
          liveWorkerName === undefined || !sessionIsLive(ctx.pool, liveJobId)
            ? ''
            : peerVisibility(ctx.pool, liveJobId) === false
              ? `peer: ${liveWorkerName} — not visible to this session's account yet (mirror pending); mesh_status shows when it is\n`
              : `peer: ${liveWorkerName} — steer with SendMessage(to: "${liveWorkerName}")\n`;
        // After the report, and only when a record of this task could not be written, a line
        // saying which.
        return (
          `${overageWarning}[worker: ${worker.name}, model: ${resultModelText(model, modelUsed)}]\n` +
          `task: ${id} · output: ${outputFile}\n${peerNote}${worktreeNote}\n${report}${books.resultNote()}`
        );
      } catch (err) {
        // The cap refusal is a server-side resource decision, not a worker fault: no
        // failure record, no failover, and no terminal event of its own. An untrusted
        // workspace is the same shape for a different reason — the server re-runs this task as
        // a one-shot on the same account, under this id, so the task is not over.
        if (err instanceof BgCapError || err instanceof BgWorkspaceUntrustedError) {
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
        // F3b, the cancel-parity guard. The four clock-driven failures below are the ones
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
          err instanceof BgQuotaStallError ||
          err instanceof BgParkedError
        ) {
          const foreign = foreignTerminalReason(id);
          if (foreign !== undefined) {
            // Thrown, not broken out of: the tail below writes the FAILED output file and a
            // terminal error event, which is precisely what must not happen a second time.
            throw new Error(foreign);
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        parkedWorkerLeftRunning = err instanceof BgParkedError;
        // Two failures fail over, and only two. A QUOTA spawn failure (P4.6), and a live
        // worker that ended its turn without a result on an account whose plan usage says it
        // is exhausted — the `--bg` face of the mid-run quota error `-p` reads off stderr. Both mean "this
        // ACCOUNT cannot do the work", which is the only condition under which handing the
        // same task to a different account is not a re-run of work already half-done. Both
        // also rest on evidence the SERVER produced: a spawn's own exit output, and
        // authoritative plan usage.
        //
        // A worker's own error REPORT is deliberately NOT a third trigger (A16, reverting
        // F10b): classifying prose the worker wrote would cool down a healthy account and
        // start a second session in the same worktree on the strength of a "429" the report
        // merely talks ABOUT — see settleWorkerError for the full record. A timeout, a
        // death, a worker parked without a result, and any worker-reported error consume
        // their attempt.
        const quota =
          (err instanceof BgSpawnFailure && err.quota) || err instanceof BgQuotaStallError;
        books.recordFailure(worker.name, message, quota, registry.cooldownMinutes);
        lastError = err instanceof Error ? err : new Error(message);
        lastErrorQuota = quota;
        if (!quota) {
          break;
        }
        appendTaskEvent({
          // A failover attempt reuses the id, the io directory and the SAME token (it is minted
          // per dispatch, not per attempt), so its digest belongs on this RUNNING event too —
          // otherwise the newest running event for the task would be the one without the mark
          // that says it is a session-worker dispatch.
          ...runningBase(base, ioToken),
          ts: Date.now(),
          status: 'running',
          error: `quota error on ${worker.name} — failing over`,
        });
        // That attempt's worker (when one was spawned) is finished with, whether or not the
        // stop that preceded this reached it: it must not hold a cap slot against the attempt
        // that replaces it.
        markSettled();
      }
    }

    if (cancelled || ctx.shouldAbort()) {
      // cancelRequest already stopped the worker and appended the terminal event.
      throw new Error(CANCELLED_ERROR);
    }

    const message = lastError?.message ?? 'unknown error';
    // What there was to fail over across is the Claude Code accounts, not the whole registry:
    // another vendor's worker is never a session worker's replacement.
    const claudePool = claudeWorkers(registry).length;
    const singleWorkerHint =
      claudePool === 1 && lastErrorQuota
        ? registry.workers.length === 1
          ? ' Only one worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another worker account.'
          : ' Only one Claude Code worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another Claude Code worker account.'
        : '';
    // What the task log and the output file record: the failure itself.
    const finalMessage = message + singleWorkerHint;
    writeFailedOutput(
      {
        title,
        prompt,
        systemPromptSection,
        ultrathink,
        billableOverage: false,
        account: [...attempted].join(',') || (target.workerName ?? '-'),
        model: lastModel,
        id,
        outputFile,
      },
      finalMessage,
    );
    // AFTER the rewrite above, which replaces the whole file: this is the one place that knows
    // the FAILED file is final.
    if (lastError instanceof BgParkedError) {
      appendParkedEvidence(outputFile, lastError);
    }
    const failureEvent: TaskEvent = {
      id,
      title,
      worker: [...attempted].join(',') || (target.workerName ?? '-'),
      // What the last attempt asked for, with who chose it — as its `running` events say it.
      // With no attempt at all: the requested model, or `-` and then no source.
      model: lastModel,
      modelSource: lastModelSource,
      outputFile,
      cwd: process.cwd(),
      promptPreview,
      promptFile,
      ts: Date.now(),
      status: 'error',
      error: finalMessage,
    };
    if (liveWorkerName !== undefined) {
      failureEvent.meshWorker = liveWorkerName;
    }
    // Through the record writer for the same reason the `done` event is: an event that cannot
    // be appended must not replace the failure this dispatch is about to report with its own.
    books.terminalEvent(failureEvent);
    // After the FAILED writer (and the parked evidence), which come first in the file.
    books.annotate(outputFile);
    markSettled();
    // What the caller is told: the same failure, then what could not be recorded about it.
    throw new Error(finalMessage + books.resultNote());
  } finally {
    ctx.onSettle(id);
    // Whatever is left: a cancel (the server wrote that terminal event before invoking the
    // hook) or a terminal event some other surface authored. A no-op when already drained.
    markSettled();
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
    if (!parkedWorkerLeftRunning) {
      removeBgIoTaskDir(id);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The server-lifetime loop (stale-io sweep) and status accessors
 * ------------------------------------------------------------------------- */

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
 * Start the one server-lifetime loop this module owns — the stale-io sweep, once a minute —
 * and return the function that stops it. Idempotent: a second call starts nothing.
 *
 * It is the ONLY loop. v1.x also drained a relay gateway here and auto-stopped idle workers;
 * both are gone, because both ran on relayed messages the server no longer receives. So no
 * timer in this process stops a SETTLED worker any more: it stays attachable until it is
 * stopped, this session ends, or Claude Code retires it.
 *
 * `deps.pool` is the mesh runtime the server starts this for. The sweep itself needs only the
 * workspace, so the pool is not read here.
 */
export function startBgLoops(deps: { pool: IWorkerPool }): () => void {
  void deps;
  if (staleIoSweepTimer === undefined) {
    staleIoSweepTimer = setInterval(sweepStaleArtifacts, STALE_IO_SWEEP_MS);
    staleIoSweepTimer.unref?.();
  }
  return (): void => {
    if (staleIoSweepTimer !== undefined) {
      clearInterval(staleIoSweepTimer);
      staleIoSweepTimer = undefined;
    }
  };
}

/** Number of refused result files currently held in the ring (mesh_status). */
export function bgRejectedResultCount(): number {
  return rejectedResults.length;
}

/**
 * End ONE pending session-worker dispatch as cancelled — the server's per-task cancel (`cco
 * cancel`, contract §15.5) — and say which session it was waiting on, so the server can stop that
 * worker through the mesh_stop_worker path. The dispatch settles exactly as a cancelled request's
 * does (BgCancelledError): no failure is recorded against the account, nothing fails over, and its
 * terminal event is the server's, written before this is called. The worker itself is NOT stopped
 * here: that is the caller's next step, by job id when the spawn reported one.
 *
 * Undefined when the task has no pending entry: its spawn is still in flight (the attempt stops
 * the session it gets back, at its first look after the spawn), it is between two attempts, or it
 * is over.
 */
export function bgCancelPending(taskId: string): { jobId: string; workerName: string } | undefined {
  const entry = pending.get(taskId);
  if (entry === undefined) {
    return undefined;
  }
  const live = { jobId: entry.jobId, workerName: entry.workerName };
  settle(entry, () => entry.reject(new BgCancelledError()));
  return live;
}

/** Title of the dispatch a worker is currently running, for mesh_status. */
export function bgPendingTitle(taskId: string | undefined): string | undefined {
  if (typeof taskId !== 'string') {
    return undefined;
  }
  return pending.get(taskId)?.title;
}

/** Diagnostic line for the newest refused result file, when there is one (mesh_status). */
export function bgLastRejectedResult(): string | undefined {
  const last = rejectedResults[rejectedResults.length - 1];
  if (last === undefined) {
    return undefined;
  }
  return `${new Date(last.at).toISOString()} ${last.file}: ${last.reason}`;
}
