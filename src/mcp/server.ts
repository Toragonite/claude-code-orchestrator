import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { StringDecoder } from 'string_decoder';
import { spawn, type ChildProcess } from 'child_process';
import {
  appendTaskNote,
  appendTerminalTaskEvent,
  clampTimeoutMinutes,
  claudeWorkers,
  ensureDirs,
  isPidAlive,
  isTaskFileId,
  latestEventsByIdsChecked,
  latestTaskEventOf,
  readRegistry,
  readRegistryChecked,
  readResultForTask,
  readStats,
  readTaskEventsChecked,
  readTaskFile,
  reapDeadTasks,
  recordOrchestrator,
  REGISTRY_FILE,
  ROOT_DIR,
  sanitizeDispatchConcurrency,
  TASKS_DIR,
  TASKS_LOG_FILE,
  taskEventTeam,
  terminateDetachWorker,
  touchOrchestrator,
  withPathLock,
  workerProvider,
  type Registry,
  type TaskClose,
  type TaskEvent,
  type WorkerProfile,
} from '../registry';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { ioTokenDigest, ioTokenProves, newIoToken, type RecordedIoToken } from '../ioToken';
import {
  claudeEnv,
  claudeVersionAtLeast,
  hostConfigDir,
  isFrontierModel,
  MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
  MODEL_ALIASES,
  negotiateMcpProtocol,
  REPORTED_MODEL_ID,
  WORKER_MODELS,
} from '../platform';
import { readTextSafe } from '../safeFs';
import { orchestratorBriefing } from '../prompts';
import { parseProvider, PROVIDER_IDS, providerInfo } from '../providers';
import { isCountedTaskEvent, ranAsOf, type FinalTaskFacts } from '../ranAs';
import {
  AccountUsage,
  checkAllClaudeLoginsNow,
  exhaustedWindows,
  ExtraUsage,
  formatAge,
  formatRelativeReset,
  getCachedUsage,
  getCachedWorkerUsage,
  isCacheFresh,
  isElevated,
  isLoginExpired,
  isLoginSuspect,
  isProviderCliMissing,
  listAccounts,
  listProviderAccounts,
  loginDiagnosticsLine,
  loginStateOf,
  loginStateText,
  ownsUsageReading,
  parseAuth,
  readUsageCache,
  recheckClaudeLoginsForRouting,
  recordProviderStatus,
  refreshAllUsageIfStale,
  resolveProbeCommand,
  UsageWindow,
} from '../usage';
import {
  acquireDispatchSlotFor,
  CANCELLED_BEFORE_START_ERROR,
  CANCELLED_ERROR,
  DispatchArgs,
  formatExhaustedWindow,
  overageEnabled,
  ownEntry,
  PROMPT_PREVIEW_MAX,
  RELOGIN_SHELL_CAVEAT,
  reloginCommand,
  resolveDispatchTarget,
  resolveRequestedModel,
  runDispatchTask,
  TaskBase,
  unsupportedWorkerReason,
  windowLabel,
  workerCooldownUntil,
  workerReloginHint,
  type ModelSource,
} from './task-runner';
import {
  checkDispatchArgs,
  checkDispatchBatch,
  DISPATCH_BATCH_MAX_TASKS,
  DISPATCH_TITLE_MAX_CHARS,
} from './dispatch-args';
import { dispatchGateStats } from './dispatch-gate';
import { providerStatus } from './provider-runner';
import {
  bgCancelPending,
  bgLastRejectedResult,
  bgPendingTitle,
  bgRejectedResultCount,
  bgWorkersByTask,
  BgWorkspaceUntrustedError,
  runBgDispatchTask,
  startBgLoops,
} from './bg-runner';
import {
  COMMAND_SPELLING,
  DISPATCHED_TASK_ENV,
  HOST_ARG,
  IDS_MAX,
  METHOD,
  OUT_CAP_CHARS,
  RECENT_DEFAULT,
  RECENT_MAX,
  STATUS_WAIT_POLL_MS,
  TASK_ID,
  TEAM_MEMBER_ENV,
  TEAM_OPS,
  TEAM_SUSPEND_BUDGET_MS,
  WAIT_MAX_SECONDS,
  WORKERS_SNAPSHOT_MIN_POLL_MS,
  WORKERS_SNAPSHOT_SCHEMA,
  type WorkersSnapshot,
} from './host-protocol';
import { runHost, type HostRequestContext, type HostTeam, type HostTeamSetup, type HostTransport } from './host';
import { TEAM_TEXT, type TeamEngine, type TeamOp, type TeamRuntime } from '../team/contract';
import { createTeamCore } from '../team/engine';
import { createTeamSurface } from '../team/surface';
import { accountsLoginSignature, buildAccountsSnapshot } from '../uiModel';
import {
  MESH_STATE_FILE_MAX_BYTES,
  logMeshProblem,
  mutateMeshOwnerFields,
  runMeshProcess,
  WorkerPool,
  type MeshOwnerFields,
} from '../mesh/pool';
import { Bridge } from '../mesh/bridge';
import { fireAndForgetStopOwned, meshTaskAliveCheck, reapOrphanedMeshWorkers, meshTaskRecovery } from '../mesh/reaper';
import {
  IBridge,
  meshError,
  meshPlatformSupported,
  meshStateFile,
  MeshState,
  MESH_TOOLS,
  parseMeshWorkerName,
} from '../mesh/contract';

/**
 * cco-dispatch — a minimal MCP stdio server the Claude Code panel connects
 * to. It exposes dispatch tools so the main session (e.g. Fable 5) can fan
 * work out to other Claude accounts. Each worker run is a Claude Code session
 * under that account's CLAUDE_CONFIG_DIR, in the same workspace cwd.
 *
 * A worker account can also run on another vendor's agent CLI (Codex, Cursor,
 * Antigravity). Such a worker is opt-in per dispatch (`worker` or `provider`),
 * always runs one-shot through the same core (mcp/task-runner → mcp/provider-runner),
 * and is never handed to anything below that treats a config dir as Claude Code's.
 *
 * Quota handling: per-worker token/cost usage is accumulated in stats.json;
 * quota/rate-limit failures put the worker on a cooldown and the task fails
 * over to another eligible worker. With a single worker there is nothing to
 * fail over to — the error is surfaced immediately.
 *
 * Timeouts: each run gets a wall-clock limit — the task's timeout_minutes, else
 * the operator's workerTimeoutMinutes registry setting (45). Hitting it is a
 * plain failure, not a quota failure: no cooldown, no failover onto a second
 * worker that would burn the same wall clock on the same too-large task.
 *
 * The wire protocol is newline-delimited JSON-RPC (MCP stdio transport),
 * implemented directly to keep the server dependency-free.
 */

const SERVER_INFO = { name: 'cco-dispatch', version: '2.0.0' };
/**
 * When this server process came up. Stamped on the mesh worker records it owns as a
 * sanity token against a recycled pid (the same best-effort marker the owner lock uses);
 * the mesh state file's own startedAt is preferred when the mesh is initialized.
 */
const SERVER_STARTED_AT = Date.now();
/** Grace between SIGTERM and SIGKILL when cancelling a single request's workers. */
const KILL_GRACE_MS = 3000;
/** Grace between SIGTERM and SIGKILL while the whole server is going down. */
const SHUTDOWN_GRACE_MS = 2500;
const SHUTDOWN_REASON = 'cancelled — orchestrator session ended';

/**
 * Process lifecycle. A worker is a `claude -p` child that bills real quota, so
 * it must never outlive the request that asked for it, and never outlive this
 * server. Cancellation arrives as an MCP `notifications/cancelled` for a
 * request id; a dead orchestrator session arrives as stdin EOF or a signal.
 */

/** Live worker children, by task id. Present only while the child is running. */
const childrenByTask = new Map<string, ChildProcess>();
/**
 * Live worker children on ANOTHER VENDOR'S CLI, by task id: the `kill` the non-Claude runner
 * handed over for that run (mcp/provider-runner — SIGTERM to the child's whole process group,
 * SIGKILL after its grace, and SIGKILL at once on a second call). The same registration point
 * as childrenByTask, for a child this process holds no ChildProcess for: it is started inside
 * the vendor adapter. Present only while the run is going.
 */
const providerChildrenByTask = new Map<string, () => void>();
/** Set by shutdown() while it waits: told each time one of those runs ends. */
let onProviderChildGone: ((kill: () => void) => void) | undefined;
/** JSON-RPC request id → the task ids it spawned. dispatch_tasks maps one id to N tasks. */
const tasksByRequest = new Map<string | number, Set<string>>();
/** Non-terminal tasks, by task id — the tasks a cancellation must mark as errored. */
const taskBases = new Map<string, TaskBase>();
/**
 * JSON-RPC request id → detach task ids it spawned. Detach tasks are deliberately
 * kept OUT of childrenByTask/taskBases/tasksByRequest (that omission is the whole
 * shutdown-exclusion mechanism — see dispatchDetached). This separate map lets an
 * explicit client cancel still reach a detach task via the marker+signal path (R7)
 * without ever exposing it to shutdown()'s signal/terminal-event sweep.
 */
const detachTasksByRequest = new Map<string | number, Set<string>>();
/** tools/call requests currently being served. Bounds what a cancellation can name. */
const inFlightRequests = new Set<string | number>();
/** Requests the client cancelled: no response, no failover, no recordFailure. */
const abortedRequests = new Set<string | number>();

let shuttingDown = false;
/**
 * What this process exits with once shutdown() has finished: 0 for a session that ended, 1 after
 * failServer — an error nothing handled. Read at the moment of exit, so a fault that arrives
 * while a signal's shutdown is already under way still decides the code.
 */
let shutdownExitCode = 0;

function isAborted(requestId: string | number | null): boolean {
  return requestId !== null && abortedRequests.has(requestId);
}

/*
 * HOST MODE (contract-2.0-fixes.md §15, mcp/host.ts). `server.js --host <spec>` is this same server
 * behind a Unix socket instead of stdio, one per Claude Code session process, reached by the `cco`
 * command. What host mode ADDS lives in the state below and in the functions that read it; on
 * stdio all of it is empty or undefined, and every path that consults it does exactly what it did
 * before host mode existed.
 */

/**
 * The socket transport (mcp/host.ts) in host mode; undefined on stdio. Set once, before the host
 * listens. send() routes through it, and its presence is what "host mode" means everywhere below.
 */
let hostTransport: HostTransport | undefined;

/**
 * Run once on the way out, before process.exit (exitProcess) — the host's removal of its socket
 * and record while the record still names this process (§15.2 step 4). Undefined on stdio.
 */
let exitHook: (() => void) | undefined;

/**
 * TEAM MODE (team contract §7, H1/H2): the team engine of this host — undefined on stdio, ALWAYS
 * (§7.5: team operations exist in host mode only), and undefined in a host whose engine could not
 * be built. Built by the host's start once its spec is read (teamSide), whatever the registry's
 * `teamMode` says: a team led here keeps running when the switch is turned off (§2.5), and the
 * orphan sweep of a crashed host's team must run either way; the engine itself refuses
 * team_create and team_add while the switch is off.
 *
 * Its turns are NEVER in childrenByTask, providerChildrenByTask or taskBases (I7, H2): the engine
 * owns them. What this file asks of it: the lead's operations (handleToolCall), the turn
 * ownership questions before its own maps (cco/cancel, the alive check of dispatch_status and
 * cco/status), the suspend at shutdown, and whether a team is active (failServer's timer).
 */
let teamEngine: TeamEngine | undefined;

/** Whether this host leads an active team now. Total: an engine that throws is taken for none. */
function teamActive(): boolean {
  try {
    return teamEngine?.active() === true;
  } catch {
    return false;
  }
}

/** Whether `taskId` is a turn the team engine holds (§7.9 step 5). Total, like teamActive. */
function teamOwnsTurn(taskId: string): boolean {
  try {
    return teamEngine?.ownsTurn(taskId) === true;
  } catch {
    return false;
  }
}

/**
 * One task a dispatch_task / dispatch_tasks call over the socket was ACCEPTED with (§15.5): its id
 * was minted here and announced in cco/accepted before anything was queued or started, so this
 * id is what its events, its output file and its answer carry.
 */
interface HostTask {
  readonly id: string;
  /** The checked title (dispatch-args), as cco/accepted announced it. */
  readonly title: string;
  /** The flattened head of its prompt (task-runner.PROMPT_PREVIEW_MAX), for an event written for it before it ran. */
  readonly promptPreview: string;
  readonly acceptedAt: number;
  /** The host's id of the request it came with — what cco/settled is sent about. */
  readonly requestId: string | number;
  /**
   * This process appended the task's first event (the one-shot core's or the session worker's
   * announce, through onTrack), or handed the task to a detach supervisor it spawned. Until then
   * the task is QUEUED: it has no event at all, and a cancel ends it before it starts.
   */
  started: boolean;
  /** The detach supervisor this process spawned for it, once it has. */
  supervisor?: ChildProcess;
  /** What `cco cancel` made of it: cancelled while queued, or while running here. */
  cancelled?: 'queued' | 'running';
  /** cco/settled has been sent for it. */
  settledSent: boolean;
}

/**
 * Every accepted task of this host whose dispatch has not settled yet, in ACCEPTANCE order (a Map
 * keeps insertion order). The ones among them with no event in the task log are the queue that
 * dispatch_status, cco/status and cco/recent report (§15.5 "Queued"). Empty on stdio.
 */
const hostTasks = new Map<string, HostTask>();

/** Every task id this host has minted — the set its next id must not be in ("unique in the host"). */
const mintedTaskIds = new Set<string>();

/** The terminal reason of a task `cco cancel` ended before it started (§15.5). */
const QUEUED_CANCEL_REASON = 'cancelled before it started (cco cancel)';
/** The terminal reason of a task `cco cancel` stopped while it ran here (§15.5). */
const RUNNING_CANCEL_REASON = 'cancelled (cco cancel)';

/**
 * End the process with `code`, after the host's cleanup when there is one (exitHook). On stdio
 * there is none, and this is process.exit(code). The hook runs at most once, and a hook that
 * throws does not keep the process from ending.
 */
function exitProcess(code: number): never {
  const hook = exitHook;
  exitHook = undefined;
  if (hook !== undefined) {
    try {
      hook();
    } catch {
      // the exit is what matters now — a socket file left behind is the stale-socket rule's case
    }
  }
  return process.exit(code);
}

let stderrGuarded = false;

/**
 * One diagnostic line on stderr. Never throws.
 *
 * Guarded for a stderr nobody reads any more: a pipe whose reader has gone reports EPIPE as an
 * 'error' event on the stream, later, and an unhandled one would be a second fault raised by
 * the report of the first.
 */
function stderrLine(line: string): void {
  try {
    if (!stderrGuarded) {
      stderrGuarded = true;
      process.stderr.on('error', () => undefined);
    }
    process.stderr.write(`${line}\n`);
  } catch {
    // no stderr to write to
  }
}

/**
 * Signal a worker's entire process tree. A worker inherits the workspace
 * `.mcp.json`, so it spawns its own dispatch server and may delegate further:
 * signalling the child alone leaves the grandchildren alive as orphans (PPID 1),
 * burning quota. Children are spawned `detached`, so on POSIX the child is its
 * own process-group leader and `-pid` reaches every process below it.
 *
 * The negated pid is safe ONLY because this process spawned that child detached.
 * The single-process fallback covers a group that has already gone away.
 * Never throws.
 */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    // No POSIX process groups, and negative pids are meaningless here.
    try {
      child.kill(sig);
    } catch {
      // already exited — nothing to signal
    }
    return;
  }
  if (typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // the group is already gone — fall through to the single-process signal
    }
  }
  try {
    child.kill(sig);
  } catch {
    // already exited — nothing to signal
  }
}

/** SIGTERM now, SIGKILL after the grace if the child is still alive. Never throws. */
function killChild(child: ChildProcess, graceMs: number): void {
  signalTree(child, 'SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const timer = setTimeout(() => {
    signalTree(child, 'SIGKILL');
  }, graceMs);
  child.once('close', () => clearTimeout(timer));
}

/** Claim a task id for a request, before the child exists — a cancel in that window still lands. */
function trackTask(requestId: string | number | null, base: TaskBase): void {
  taskBases.set(base.id, base);
  if (requestId === null) {
    return;
  }
  let ids = tasksByRequest.get(requestId);
  if (ids === undefined) {
    ids = new Set<string>();
    tasksByRequest.set(requestId, ids);
  }
  ids.add(base.id);
}

function registerChild(taskId: string, child: ChildProcess): void {
  childrenByTask.set(taskId, child);
  child.on('close', () => {
    // Guard against a failover attempt's child having replaced this one.
    if (childrenByTask.get(taskId) === child) {
      childrenByTask.delete(taskId);
    }
  });
}

/** Run a non-Claude worker's `kill`. Never throws — it is called from cancel and shutdown sweeps. */
function stopProviderChild(kill: () => void): void {
  try {
    kill();
  } catch {
    // the runner's kill is total; this is belt and braces around a sweep that must finish
  }
}

/** registerChild for a worker on another vendor's CLI: its run's `kill` in place of a child. */
function registerProviderChild(taskId: string, kill: () => void): void {
  providerChildrenByTask.set(taskId, kill);
  if (shuttingDown) {
    // Started in the instant the server began going down — too late for shutdown()'s sweep and
    // its wait. Nothing will be around to escalate later, so it gets both steps now.
    stopProviderChild(kill);
    stopProviderChild(kill);
  }
}

/** That run is over. Guarded like registerChild's 'close': a failover attempt may have replaced it. */
function releaseProviderChild(taskId: string, kill: () => void): void {
  if (providerChildrenByTask.get(taskId) === kill) {
    providerChildrenByTask.delete(taskId);
  }
  onProviderChildGone?.(kill);
}

/**
 * Best-effort terminal note appended to a task's output file so a cancelled or
 * shut-down task does not sit at "status: RUNNING" forever. APPENDS ONLY — the
 * RUNNING header and the prompt above it stay readable; the file is never
 * rewritten. Called from the terminal-EVENT sites (cancelRequest / shutdown) and
 * NOT from dispatchTask's aborted short-circuit, so the note is written once per
 * task. Never throws.
 *
 * Through registry.appendTaskNote: the file is the one the task's ID names, opened without
 * blocking and written only if it is a regular file. This runs inside shutdown(), and the
 * output file is the one name in the tasks directory a worker is expected to touch — a pipe
 * put there would have parked a plain append, and with it the exit that is waiting to kill
 * the workers that ignored SIGTERM.
 */
function appendCancelledNote(base: TaskBase, reason: string): void {
  try {
    appendTaskNote(
      { ...base, ts: Date.now(), status: 'error' },
      `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n`,
    );
  } catch {
    // best effort — the terminal task event is already recorded
  }
}

/**
 * Record that THIS SERVER ended a task it was running — a cancelled request, its own shutdown —
 * as the task's terminal event, with the CANCELLED note in its report. Never throws: the callers
 * go on to stop the worker, and a log that refuses a line must not leave a worker running.
 *
 * At most one terminal event per task (registry.appendTerminalTaskEvent): when the log already
 * says how the task ended — the editor's cancel got there first, or a sweep settled it — that
 * record stands, and neither a second event nor a second note is written.
 */
function recordTaskEnded(base: TaskBase, reason: string): TaskClose | undefined {
  let close: TaskClose | undefined;
  try {
    close = appendTerminalTaskEvent({ ...base, ts: Date.now(), status: 'error', error: reason });
  } catch {
    // The log refused the line. The note still goes into the report: it is then the only
    // record, in a file, that this server ended the task.
  }
  if (close === undefined || close.closed) {
    appendCancelledNote(base, reason);
  }
  // What the log made of it, for the one caller that says so (a per-task cancel, §15.5);
  // undefined when the log refused the line.
  return close;
}

/**
 * Cancel one request: kill its workers and record them as cancelled. The
 * request's own `tools/call` sees the aborted flag and sends no response.
 * Unknown or already-settled request ids are ignored silently.
 */
function cancelRequest(requestId: string | number): void {
  if (!inFlightRequests.has(requestId)) {
    return;
  }
  abortedRequests.add(requestId);
  // Detach tasks: the server owns neither their terminal event nor their worker
  // handle. Cancel drops a tasks/<id>.cancel marker (so the supervisor records the
  // cancelled event + result.json and does not fail over) and signals the recorded
  // worker group directly (contract §7 R7). No terminal event is written here.
  const detachIds = detachTasksByRequest.get(requestId);
  if (detachIds !== undefined) {
    for (const taskId of detachIds) {
      cancelDetachTask(taskId);
    }
  }
  const taskIds = tasksByRequest.get(requestId);
  if (taskIds === undefined) {
    return;
  }
  for (const taskId of taskIds) {
    const base = taskBases.get(taskId);
    if (base !== undefined) {
      taskBases.delete(taskId);
      recordTaskEnded(base, CANCELLED_ERROR);
    }
    const child = childrenByTask.get(taskId);
    if (child !== undefined) {
      killChild(child, KILL_GRACE_MS);
    }
    // A worker on another vendor's CLI: the same step, through the kill its runner registered
    // (SIGTERM to its process group now, SIGKILL after the runner's grace).
    const stopProvider = providerChildrenByTask.get(taskId);
    if (stopProvider !== undefined) {
      stopProviderChild(stopProvider);
    }
    // Mesh (`--bg`) tasks have no child to signal: their worker is a persistent session
    // owned by the CLI's background service, so the runner leaves a hook that runs
    // `claude stop` for it (contract P4.5). Hooks outlive their task's own settle, so a
    // batch cancel also stops a worker that already reported and went idle.
    const stopBgWorker = bgWorkersByTask.get(taskId);
    if (stopBgWorker !== undefined) {
      try {
        stopBgWorker();
      } catch {
        // fire-and-forget by contract — a stop failure must not abort the cancel sweep
      }
    }
  }
}

/**
 * Cancel one detach task (contract §7 R7). Writes the tasks/<id>.cancel marker FIRST
 * — so by the time the worker dies from the signal below, the supervisor's shouldAbort
 * already sees it and breaks out without failing over — then signals the worker's
 * recorded group. The supervisor authors the terminal `cancelled` event + result.json;
 * the server writes neither. Never throws.
 */
function cancelDetachTask(taskId: string): void {
  const marker = path.join(TASKS_DIR, `${taskId}.cancel`);
  // Created EXCLUSIVELY, never written through what is already at the name: the tasks
  // directory is one a dispatched worker can write, and a plain write would follow a symbolic
  // link left there and put the timestamp into whatever file it names. A marker that already
  // exists is a marker; anything else at the name is cleared and the marker made in its place.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(marker, String(Date.now()), { flag: 'wx', mode: 0o600 });
      break;
    } catch {
      try {
        if (fs.lstatSync(marker).isFile()) {
          break;
        }
        fs.rmSync(marker, { recursive: true, force: true });
      } catch {
        // even without the marker the signal below still kills the worker; the supervisor
        // classifies the death as a WorkerKilledError (no failover) as a fallback
        break;
      }
    }
  }
  // Fire-and-forget: terminateDetachWorker escalates SIGTERM→SIGKILL over a grace and
  // appends no events. cancelRequest is synchronous, so we do not await it — and a promise
  // nobody awaits gets its rejection handled here: the marker above already tells the
  // supervisor to stop, so a signal that could not be sent is not a fault of this server.
  terminateDetachWorker(taskId, KILL_GRACE_MS).catch(() => undefined);
}

/**
 * Tear the server down without orphaning workers. Signals the children first
 * (they burn quota every second they live), records the tasks as failed, and
 * only exits once the SIGKILL grace has elapsed. Safe to call from a signal
 * handler: it never throws and is idempotent.
 *
 * TEAM MODE (team contract §7.9, H2): a host that leads an active team SUSPENDS it first. From
 * the first moment the host accepts no connection, no tools/call and no member hello (observer
 * connections stay writable until the exit — hostTransport.shuttingDown); then
 * teamEngine.suspendAll(TEAM_SUSPEND_BUDGET_MS) stops every running turn on the suspend ladder,
 * checkpoints, marks the team suspended and releases its lease — and the body below, today's
 * shutdown unchanged, runs only when that promise settles OR TEAM_SUSPEND_BUDGET_MS has passed on
 * this function's own timer, whichever is first: the timer wins, and whatever the suspend left
 * unfinished is the next host's sweep (§2.5). Team turns are in none of the maps the body sweeps,
 * so they are never SIGTERMed by it and never recorded `cancelled — orchestrator session ended`.
 * Budget (§7.9): ladder ≤ 8 s + reap 5 s, checkpoints with the rest of the 30 s, then at most
 * SHUTDOWN_GRACE_MS for the one-shot children — gone within ~33 s of the session's end. Stated:
 * during the suspend the one-shot dispatches of this host go on running (they are stopped by the
 * body, as before); a request that settles meanwhile is still answered while its connection lasts.
 */
function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // Host mode: from here the host accepts no connection and starts no request — one arriving
  // during the grace below would spawn a worker this exit then orphans. What is running already
  // is ended below exactly as on stdio.
  if (hostTransport !== undefined) {
    try {
      hostTransport.shuttingDown();
    } catch {
      // the transport's own step must not keep the workers below from being stopped
    }
  }
  const engine = teamEngine;
  if (engine === undefined || !teamActive()) {
    shutdownBody(reason);
    return;
  }
  let continued = false;
  const proceed = (): void => {
    if (continued) {
      return;
    }
    continued = true;
    clearTimeout(budgetTimer);
    shutdownBody(reason);
  };
  // Referenced on purpose: it is what keeps the process alive through the suspend, and it is the
  // bound that wins over a suspend that does not settle.
  const budgetTimer = setTimeout(proceed, TEAM_SUSPEND_BUDGET_MS);
  let suspending: Promise<void>;
  try {
    suspending = Promise.resolve(engine.suspendAll(TEAM_SUSPEND_BUDGET_MS));
  } catch (err) {
    suspending = Promise.reject(err);
  }
  suspending.then(proceed, (err: unknown) => {
    stderrLine(
      `cco-dispatch: the team could not be suspended — ${sliceOneLine(flattenOneLine(errorMessage(err)), 300)}; ` +
        "the next host's sweep finishes it",
    );
    proceed();
  });
}

/** shutdown()'s body — what it always did, after the team suspend (H2) when there was one. */
function shutdownBody(reason: string): void {
  // Mark every in-flight request aborted BEFORE killing any child. When our own
  // SIGTERM makes a worker's child die, dispatchTask's catch takes the
  // isAborted() short-circuit — exactly as it does for a client cancellation:
  // no recordFailure (a shutdown we caused must not inflate the worker's error
  // count or cool it down) and no competing terminal event. Shutdown's own
  // { status:'error', error: reason } event below stays the last word per task.
  for (const id of inFlightRequests) {
    abortedRequests.add(id);
  }
  // Tear down the mesh before exit: stop every `--bg` worker this process owns (P4.9), stop
  // the bridge (prune its mirrors), and release the owner lock.
  //
  // Those workers are NOT left running. v1.4 left them alive deliberately and that was the
  // leak this rework closes: an attachable worker outliving the session that owns it has
  // nobody left to attach to it, stop it, or account for it. Do not "restore" that behavior
  // — the session-end stop is the no-leak guarantee (see stopMesh).
  stopMesh();
  const children = [...childrenByTask.values()];
  for (const child of children) {
    signalTree(child, 'SIGTERM');
  }
  // Workers on another vendor's CLI bill the same way and get the same first step.
  const providerKills = [...providerChildrenByTask.values()];
  for (const kill of providerKills) {
    stopProviderChild(kill);
  }
  for (const base of [...taskBases.values()]) {
    recordTaskEnded(base, reason);
  }
  taskBases.clear();
  // Host mode: a task accepted over the socket and not yet started has no event at all, and the
  // only process that knew of it is about to end — left as it is, its announced id would read
  // not_found for ever. It gets the same terminal reason as the running tasks above. (A detach
  // task whose supervisor is running is not one of them: the supervisor goes on and records it.)
  for (const task of [...hostTasks.values()]) {
    if (!task.started && task.cancelled === undefined) {
      closeUnstartedHostTask(task, reason);
    }
  }

  let exited = false;
  const finish = (): void => {
    if (exited) {
      return;
    }
    exited = true;
    exitProcess(shutdownExitCode);
  };

  // Exit as soon as every child has actually gone rather than always waiting
  // the full grace period: count the still-live children and decrement as each
  // one closes. The grace timer below is only a backstop for a child that
  // ignores SIGTERM.
  let live = 0;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const oneGone = (): void => {
    live--;
    if (live === 0 && shuttingDown) {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      finish();
    }
  };
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      live++;
      child.once('close', oneGone);
    }
  }
  // A non-Claude run is "gone" when its runner settles and the core releases its kill. Only
  // the runs signalled above are waited for, each once: a release for any other must not let
  // the count reach zero while one of them is still alive.
  const waiting = new Set(providerKills);
  live += waiting.size;
  onProviderChildGone = (kill): void => {
    if (waiting.delete(kill)) {
      oneGone();
    }
  };
  if (live === 0) {
    finish();
    return;
  }
  // Left referenced on purpose: this timer is what keeps the loop alive long
  // enough to SIGKILL a child that ignored SIGTERM.
  graceTimer = setTimeout(() => {
    for (const child of children) {
      signalTree(child, 'SIGKILL');
    }
    // A second call to a runner's kill is its SIGKILL: this process is about to exit, and the
    // runner's own grace timer would die with it.
    for (const kill of waiting) {
      stopProviderChild(kill);
    }
    finish();
  }, SHUTDOWN_GRACE_MS);
}

/** Set by the first failServer: the fault has been said and the shutdown started. */
let failing = false;

/**
 * The last resort for an error NOTHING handled — a rejection no code awaited, an exception
 * thrown out of a timer or an event handler. Says so in one line on stderr and then ends the
 * process the way a signal does: the same shutdown(), so the workers this process started are
 * signalled and the session workers it owns are stopped (detached supervisors are in none of
 * the maps shutdown() sweeps and go on), and the exit code is 1.
 *
 * Without it Node ends the process by itself on either event, at once, and shutdown() never
 * runs: every `claude -p` child of an in-flight dispatch is left running with nobody to stop
 * it, to record it or to answer for it. Every handler on the dispatch path is written so that
 * this is never reached; it is here for the handler that is not.
 *
 * Safe against itself and against a signal: a fault that arrives while a shutdown is already
 * running — a signal's, or the one an earlier fault started — only makes the exit code 1; one
 * raised BY that shutdown is the same case; and a shutdown that throws or cannot get as far as
 * its own grace timer is ended by the timer armed here. Never throws.
 *
 * TEAM MODE (§7.9 step 3): while this host leads an active team the timer is
 * TEAM_SUSPEND_BUDGET_MS + SHUTDOWN_GRACE_MS + 2000 (34,500 ms, team/contract
 * TEAM_FAILSERVER_EXIT_MS), so the shutdown it starts can suspend the team first. A fault raised
 * DURING that suspend finds the shutdown already running: the suspend is abandoned at this timer,
 * the team is left `active` with a lease whose holder is dead, and the next host's sweep (§2.5)
 * finishes the job.
 */
function failServer(what: 'unhandled rejection' | 'uncaught exception', cause: unknown): void {
  try {
    shutdownExitCode = 1;
    process.exitCode = 1;
    if (failing) {
      return;
    }
    failing = true;
    let said: string;
    try {
      said = flattenOneLine(cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
    } catch {
      said = '';
    }
    stderrLine(
      `cco-dispatch: ${what}, shutting down — ${sliceOneLine(said, 300) || 'no description was given'}`,
    );
    // Not referenced: it must end a shutdown that is stuck, never keep alive one that is done.
    const hardExitMs = teamActive() ? TEAM_SUSPEND_BUDGET_MS + SHUTDOWN_GRACE_MS + 2000 : SHUTDOWN_GRACE_MS + 2000;
    setTimeout(() => exitProcess(1), hardExitMs).unref();
    shutdown(`${SHUTDOWN_REASON} (${what} in the dispatch server)`);
  } catch {
    exitProcess(1);
  }
}

/**
 * TEST-ONLY fault injection, for the offline checks of failServer (.orchestrator/fixes/server.mjs).
 * INERT unless the environment variable CCO_TEST_FAULTS is exactly `1`: nothing in the product
 * sets it, no tool description names it, and with any other value the notification below is
 * ignored like every other notification this server does not know.
 *
 * With it set, the notification `notifications/cco_test_fault` with `params.kind`
 * `unhandledRejection` or `uncaughtException` raises that fault inside this process, from a
 * place nothing awaits or catches — exactly what failServer exists for.
 */
const TEST_FAULTS_ENABLED = process.env.CCO_TEST_FAULTS === '1';
const TEST_FAULT_METHOD = 'notifications/cco_test_fault';

function injectTestFault(kind: unknown): void {
  if (kind === 'unhandledRejection') {
    void Promise.reject(new Error('CCO_TEST_FAULTS: an injected rejection nothing awaits'));
  } else if (kind === 'uncaughtException') {
    setImmediate(() => {
      throw new Error('CCO_TEST_FAULTS: an injected exception nothing catches');
    });
  }
}

/* ------------------------------------------------------------------------- *
 * What a tool result may carry
 * ------------------------------------------------------------------------- */

/**
 * Most of ONE task's result, in UTF-8 bytes, that goes into a tool result. A megabyte of prose
 * is a quarter of a million tokens of an orchestrator's context; a report longer than that is
 * read from its file, not relayed.
 */
const RELAY_TEXT_MAX_BYTES = 1_048_576;

/** The output file of task `id` — where its whole report is — or undefined when it has none. */
function taskReportPath(id: string | undefined): string | undefined {
  return isTaskFileId(id) ? path.join(TASKS_DIR, `${id}.md`) : undefined;
}

/**
 * The text of ONE task as a tool result carries it: `text` itself when it is at most
 * RELAY_TEXT_MAX_BYTES of UTF-8, else its longest head within that limit — cut between
 * characters, never through one — and a last line saying that it was cut and where all of it
 * is. `taskId` is the task the text belongs to; its output file is the one the id names.
 *
 * THE one place a task's text is bounded on its way to the client, for every path that relays
 * one: a single dispatch and each task of a batch (a result or a failure message), whichever
 * core ran it; the record a detach supervisor left; and each `result` of dispatch_status. A
 * worker's report is as long as the worker made it — the one-shot core accepts megabytes of it
 * — and the full text is always in the output file, which is why cutting loses nothing.
 *
 * A text the supervisor already cut to fit its record (run-task.fitResultRecord) ends in the
 * same line and is below the limit, so it passes through here unchanged.
 */
function relayText(text: string, taskId: string | undefined): string {
  // A UTF-16 unit is at most three UTF-8 bytes, so most texts need no measuring at all.
  if (text.length * 3 <= RELAY_TEXT_MAX_BYTES) {
    return text;
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= RELAY_TEXT_MAX_BYTES) {
    return text;
  }
  // The head ends where a character starts: step back while the first byte left out is the
  // continuation of one.
  let end = RELAY_TEXT_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  const report = taskReportPath(taskId);
  return (
    `${bytes.toString('utf8', 0, end)}\n…[truncated — ` +
    (report === undefined ? 'this task recorded no output file' : `the full report is in ${report}`) +
    ']'
  );
}

/** The message of a caught value, as one string. Total. */
function errorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string') {
    return err.message;
  }
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * The refusal for a registry file that could not be read or understood, or undefined when
 * there is none to give. `problem` is registry.readRegistryChecked's: one line built from that
 * module's own words and numbers, never from the file's bytes.
 *
 * Every tool that lists or picks workers leads with this instead of acting on the default
 * registry such a read comes with: "no workers are registered" is a statement about what the
 * file holds, and nothing is known about that.
 */
function registryProblemText(problem: string | null): string | undefined {
  return problem === null
    ? undefined
    : `The worker registry could not be read: ${problem}. Fix or delete ${REGISTRY_FILE}.`;
}

/** First line of an error message — what the mesh-unavailable prefix quotes. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0].trim();
}

/**
 * In-process default dispatch: build the request-scoped context — cancellation
 * check, id tracking, child registration, and cleanup, all backed by this
 * server's live maps — and run the shared per-task core. The default path still
 * registers each worker child in childrenByTask via onSpawn, so stdin-close
 * shutdown (D4) and request cancel (D5) keep signalling in-flight workers exactly
 * as before.
 *
 * THE MESH FORK LIVES HERE (contract P0.1–P0.4), deliberately in the server rather than
 * inside task-runner: the `-p` core is ALSO the detach supervisor's core (run-task.ts),
 * which owns no session workers and must never grow a mesh path. With Mesh Mode on, every
 * non-detach dispatch runs as a persistent, attachable `claude --bg` worker instead —
 * one `if`, and the `-p` core stays a closed box.
 *
 * `hostTask` is set in host mode only (hostDispatchTask): the task was accepted with an id this
 * host minted, which every path below runs it under, and `cco cancel` can end it alone. On stdio
 * it is absent and nothing below differs from what it always was.
 */
async function dispatchTask(
  args: DispatchArgs,
  requestId: string | number | null,
  hostTask?: HostTask,
): Promise<string> {
  // Which task this dispatch became, once it has one — what relayText needs to say where the
  // whole report is. Filled in by whichever path runs.
  const trace: DispatchTrace = {};
  try {
    return relayText(await runDispatch(args, requestId, trace, hostTask), trace.taskId);
  } catch (err) {
    // A failure is relayed under the same bound as a result: the message of a worker that
    // exited non-zero quotes what the worker printed, which can be megabytes.
    const message = errorMessage(err);
    const bounded = relayText(message, trace.taskId);
    throw bounded === message ? err : new Error(bounded);
  }
}

/** What a dispatch path tells its caller about the task it ran, beside the text. */
interface DispatchTrace {
  /** The task's id — set as soon as the dispatch has one, absent for one refused before that. */
  taskId?: string;
}

/**
 * dispatchTask without the bound on what is relayed: choose the path — detached supervisor,
 * session worker, or one-shot — and run it. `args` are the CHECKED arguments
 * (dispatch-args.checkDispatchArgs): the request handler checks them before it calls anything,
 * and nothing below reads an argument that has not been through that check.
 */
async function runDispatch(
  args: DispatchArgs,
  requestId: string | number | null,
  trace: DispatchTrace,
  hostTask?: HostTask,
): Promise<string> {
  // A registry that could not be read is REFUSED here, for every path, before anything exists
  // for the dispatch. The default registry such a read comes with holds no workers and mesh
  // off; acting on it would answer "no worker accounts registered" for a file full of them, or
  // quietly run a one-shot worker where a session worker was configured.
  const { registry, problem } = readRegistryChecked();
  const unreadable = registryProblemText(problem);
  if (unreadable !== undefined) {
    throw new Error(`${unreadable} Nothing was dispatched.`);
  }
  // WHERE THE TASK MAY LAND, settled before any fork below and before anything exists for the
  // dispatch — no supervisor, no spec file, no task id. This is where a `provider` that is not
  // one, and a `provider` that contradicts the named worker's, are refused, for every path at
  // once (in-process, detached, session worker); the cores repeat the check for the callers
  // that reach them some other way. It is the dispatch cores' own accessor, called early — not
  // a second copy of the rule.
  const target = resolveDispatchTarget(args, registry.workers);
  // Opt-in ownership/survival: hand the whole run to a standalone supervisor and
  // relay its result. Everything about blocking and the return string is unchanged
  // (contract §3) — only the host process differs.
  //
  // detach keeps the `-p` path even with mesh on (P0.2): survival is not attachability.
  // A session worker belongs to THIS process — which watches its result file and stops it
  // when the session ends — so it cannot outlive the session the way a detached task must.
  if (args.detach === true) {
    return dispatchDetached(args, requestId, trace, hostTask);
  }
  const ctx = {
    shouldAbort: abortCheck(requestId, hostTask),
    onTrack: (base: TaskBase): void => {
      trace.taskId = base.id;
      trackTask(requestId, base);
      // The task's first event is in the log (each core appends it just before this hook): from
      // here it is a running task of this host, no longer a queued one.
      if (hostTask !== undefined) {
        hostTask.started = true;
      }
    },
    onSpawn: (taskId: string, child: ChildProcess): void => registerChild(taskId, child),
    onProviderSpawn: (taskId: string, kill: () => void): void => registerProviderChild(taskId, kill),
    onProviderExit: (taskId: string, kill: () => void): void => releaseProviderChild(taskId, kill),
    onSettle: (taskId: string): void => {
      taskBases.delete(taskId);
    },
    // Host mode: the id cco/accepted announced. Undefined on stdio, where each core mints its own
    // exactly as before (and runUntrustedTaskAsOneShot sets it to the id its `--bg` attempt had).
    preassignedId: hostTask?.id,
  };
  // A task for another vendor's CLI takes the one-shot core WHATEVER Mesh Mode says, and
  // without a ⚠ line: a session worker is a Claude Code session, so for such a worker one-shot
  // is the only path there is, not a fallback from a better one.
  if (registry.meshMode !== 'on' || target.provider !== 'claude') {
    return runDispatchTask(args, ctx);
  }
  // An explicit model that is not one is refused HERE, before the mesh is initialized on its
  // behalf (owner lock, orphan sweep, a `claude --version` run): a rejected request must cost
  // nothing. It is the dispatch cores' own accessor, called early — not a second copy of the
  // rule.
  resolveRequestedModel(args.model);
  // Simple-first (P0.3): mesh on routes EVERY non-detach dispatch through `--bg`. No
  // per-task heuristics — a task the orchestrator cannot attach to is a surprise.
  let initError: string | undefined;
  try {
    await ensureMesh();
    if (!mesh.ready || !mesh.pool) {
      initError = meshError(
        'capability_failed',
        'the mesh reported initialized but its worker pool is missing.',
      );
    }
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }
  if (initError === undefined) {
    try {
      return await runBgDispatchTask(args, {
        pool: mesh.pool!,
        ownerPid: process.pid,
        ownerStartedAt: mesh.state?.startedAt ?? SERVER_STARTED_AT,
        shouldAbort: ctx.shouldAbort,
        onTrack: ctx.onTrack,
        onSettle: ctx.onSettle,
        preassignedId: hostTask?.id,
      });
    } catch (err) {
      if (!(err instanceof BgWorkspaceUntrustedError)) {
        throw err;
      }
      return runUntrustedTaskAsOneShot(args, err, requestId, ctx);
    }
  }
  // P0.4, the mesh-unavailable rule: a broken mesh (busy owner lock, unsupported platform, a
  // Claude Code too old for session workers) must NEVER fail a dispatch — it runs the unchanged
  // `-p` path. But it is never SILENT either: the caller asked for an attachable worker and
  // did not get one, so the success text says so. Failures propagate unchanged, so an error is
  // never disguised by this prefix.
  const text = await runDispatchTask(args, ctx);
  return `⚠ mesh unavailable — ran as a one-shot worker (not attachable): ${firstLine(initError)}\n${text}`;
}

/**
 * ONE task's fallback when the account chosen for it has not trusted this workspace for
 * background sessions (contract §5.2): run that task as a one-shot worker on the SAME account
 * — `claude -p` skips the trust check — and say so in front of its result. Per task, not per
 * mesh: trust is a property of one account, and the next dispatch may well land on one that
 * has it. Nothing is recorded against the account, which did nothing wrong.
 *
 * The one-shot run CONTINUES the task the `--bg` attempt announced, under the same id
 * (`preassignedId`): that attempt already wrote a `running` event and an output file for it,
 * and a second id would leave the first one `running` for ever with a twin beside it.
 *
 * Naming the account makes this a single attempt with no failover, exactly as an explicitly
 * named worker always is — that is what "on the same account" costs.
 */
async function runUntrustedTaskAsOneShot(
  args: DispatchArgs,
  untrusted: BgWorkspaceUntrustedError,
  requestId: string | number | null,
  ctx: {
    shouldAbort(): boolean;
    onTrack(base: TaskBase): void;
    onSpawn(taskId: string, child: ChildProcess): void;
    onSettle(taskId: string): void;
  },
): Promise<string> {
  const task = untrusted.task;
  // Tracked again BEFORE the core runs. The `--bg` attempt untracked the task on its way out,
  // and the core does not track it until it has picked its worker — which can await a live
  // login probe. A cancel landing in that gap would find nothing to mark, and the announced
  // `running` event would be left with nobody to end it.
  trackTask(requestId, task);
  let text: string;
  try {
    text = await runDispatchTask(
      { ...args, worker: untrusted.account },
      { ...ctx, preassignedId: task.id },
    );
  } catch (err) {
    closeHandedOffTask(task, err, requestId);
    throw err;
  } finally {
    // The core releases this itself on every path that reached its own body; this covers the
    // refusals it raises before that.
    taskBases.delete(task.id);
  }
  return (
    `⚠ ran as a one-shot worker (not attachable): ${untrusted.account} has not trusted this ` +
    `workspace for background sessions — ${untrusted.instruction}.\n${text}`
  );
}

/**
 * Make sure a task handed from the `--bg` path to the one-shot core does not stay `running`
 * after that core threw.
 *
 * The core writes a terminal event on every path that reaches its own announce. But THIS task
 * was already announced, by the `--bg` attempt, so a refusal the core raises before announcing
 * (the registry emptied or a billing guard flipped in the milliseconds between the two reads)
 * or a failure inside its own tail would leave that first event with nothing after it — a
 * task that every surface shows as running for ever. So: if the log does not say the task is
 * over, say what happened. A cancelled request is skipped, because cancelRequest and shutdown
 * author that event themselves from taskBases, where this task stayed tracked throughout.
 * Never throws.
 *
 * "Does not say the task is over" is asked through the CHECKED reader: a log that could not be
 * read says nothing either way, and appending an `error` on the strength of that would put a
 * second terminal event after one the core may already have written. Nothing is appended then;
 * the caller still receives the error, and the reconcile sweep settles a task left `running`.
 */
function closeHandedOffTask(task: TaskBase, err: unknown, requestId: string | number | null): void {
  if (isAborted(requestId)) {
    return;
  }
  try {
    const latest = latestTaskEventOf(task.id);
    if (latest === 'unreadable' || (latest !== 'none' && latest.status !== 'running')) {
      return;
    }
    // Under the task's lock and only if it is still open there (registry.appendTerminalTaskEvent):
    // the look above was taken without the lock, and the core may have closed the task since.
    appendTerminalTaskEvent({
      ...task,
      ts: Date.now(),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {
    // best effort — the caller still receives the error, and the reaper settles what is left
  }
}

/** Grace added to the worker-timeout ceiling for the supervisor to write result.json. */
const RESULT_WAIT_GRACE_MS = 30_000;
/**
 * Per-attempt kill+reap grace a supervisor's worker timer can burn BEYOND the wall clock
 * before it settles (mirrors task-runner's TIMEOUT_KILL_GRACE_MS 10s + REAP_GRACE_MS 5s).
 * Folded into the detach wait ceiling below so a multi-attempt failover run — whose true
 * worst case is maxAttempts × (timeout + this) — is never cut off before the supervisor
 * finishes, which was the F3 spurious-timeout relay divergence from the default path.
 */
const ATTEMPT_KILL_REAP_GRACE_MS = 15_000;
/** The longest delay a timer can be armed with; a longer one fires after one millisecond. */
const TIMER_MAX_MS = 2_147_483_647;

/** The part of tasks/<id>.result.json the server relays (contract §5.4) — see ownDetachResult. */
interface ResultJson {
  status: 'done' | 'error';
  text: string;
  error?: string;
}

/** How the wait for one detached dispatch's supervisor ended. */
type DetachOutcome =
  /** The supervisor's own record is in hand. */
  | { kind: 'result'; result: ResultJson }
  /** The supervisor process is gone and left no record of its own. */
  | { kind: 'exited' }
  /** The supervisor process could not be started at all. `why` is an errno code or our words. */
  | { kind: 'not-started'; why: string }
  /** The supervisor is alive, and the ceiling of the wait passed without a record. */
  | { kind: 'timeout' }
  /** A step of the wait itself threw — a defect of this server, said rather than left to end it. */
  | { kind: 'failed'; why: string };

/**
 * Detached dispatch. The server takes a slot of the dispatch gate, picks the task id, writes a
 * task spec, spawns the supervisor (out/mcp/run-task.js) as its own detached, unref'd process —
 * and, crucially, does NOT register it in childrenByTask / taskBases / tasksByRequest.
 * That single omission is the whole shutdown-exclusion mechanism: shutdown() and
 * cancelRequest() only ever touch those maps, so neither signals the supervisor nor
 * writes a terminal event for it (contract §5.3 — the supervisor is sole author).
 *
 * The server then waits for the supervisor's record in tasks/<id>.result.json, bounded by the
 * same worker-timeout ceiling as the default path plus a write grace, and relays the identical
 * inline string (done) or throws the identical error (parity with the default failure). If the
 * session dies while waiting, process exit abandons the wait; the supervisor is a separate
 * process group and completes regardless.
 *
 * ONE SLOT OF THE DISPATCH GATE, for as long as the supervisor's outcome is awaited
 * (mcp/dispatch-gate): a supervisor is a process that starts a worker, so a batch of detached
 * tasks is bounded by the operator's `maxConcurrentDispatches` exactly as a batch of plain ones
 * is. The slot is taken BEFORE anything exists for the dispatch — no token, no spec file, no
 * process, no task id — so a dispatch cancelled while it waits has left nothing behind, and
 * its failure says so (task-runner.CANCELLED_BEFORE_START_ERROR). It is given back when the
 * wait ends, however it ends. (The supervisor's own core takes a slot too, of ITS process's
 * gate, where it is the only dispatch: that one never waits.)
 *
 * In host mode (`hostTask`) the task id is the one cco/accepted announced, and a `cco cancel` of
 * the queued task ends the wait for the slot as a request cancel does. Once the supervisor is
 * spawned the task is the supervisor's: a cancel then goes through its marker (cancelDetachTask).
 */
async function dispatchDetached(
  args: DispatchArgs,
  requestId: string | number | null,
  trace: DispatchTrace,
  hostTask?: HostTask,
): Promise<string> {
  const slot = await acquireDispatchSlotFor(abortCheck(requestId, hostTask));
  try {
    return await runDetachedSupervisor(args, requestId, trace, hostTask);
  } finally {
    slot.release();
  }
}

/** dispatchDetached once it holds its slot: start the supervisor and wait for its record. */
async function runDetachedSupervisor(
  args: DispatchArgs,
  requestId: string | number | null,
  trace: DispatchTrace,
  hostTask?: HostTask,
): Promise<string> {
  // Cancelled in the instant the slot was granted: still nothing to undo.
  if (isAborted(requestId) || hostTask?.cancelled !== undefined) {
    throw new Error(CANCELLED_BEFORE_START_ERROR);
  }
  // Read NOW, not when the dispatch was queued: the ceiling below is computed from the
  // accounts and the timeout that hold when the supervisor starts, which is also when its core
  // reads them. A registry that became unreadable while this dispatch waited refuses it here,
  // with nothing started.
  const { registry, problem } = readRegistryChecked();
  const unreadable = registryProblemText(problem);
  if (unreadable !== undefined) {
    throw new Error(`${unreadable} Nothing was dispatched.`);
  }
  // THE DISPATCHER MINTS THIS TASK'S RESULT TOKEN. `tasks/<id>.result.json` is a FIXED,
  // UNGUARDED path: a dispatched worker knows its own task id, runs with Bash, and ROOT_DIR
  // is a stable path in the user's home directory — so writing a well-formed record there is
  // one redirect, and shape validation alone can never answer WHO WROTE IT. The token is the
  // independent gate: a secret this process mints before any worker exists and hands to the
  // supervisor, which writes it into its record. This process keeps only the token's SHA-256
  // (`expected`) and believes a record at that path only when the record carries a value that
  // hashes to it (ownDetachResult); the supervisor puts the same digest into the task log, so
  // a later session can make the same check (registry.readResultForTask).
  //
  // A DISPATCH WITHOUT A TOKEN IS NOT STARTED. Minting can fail only when the system's random
  // source does, and a dispatch started without one would have a record nothing could tell
  // from a forgery: the relay would have to believe any well-formed file, or none. So this is
  // a refusal — before the spec, before the supervisor — and never a weaker dispatch.
  //
  // THE SPEC IS THE ONLY CHANNEL FOR IT, and that is a choice against two worse ones: an env
  // var would be inherited by the worker itself (a `claude` child gets this process's
  // environment minus only the session-identity variables — the worker could just print it),
  // and an extra argv would sit on the supervisor's command line for its whole life, where
  // any `ps` reaches it. The spec is a file the supervisor unlinks the instant it has read it
  // (run-task.readSpec's finally), long before the first worker process exists.
  let ioToken: string;
  try {
    ioToken = newIoToken();
  } catch {
    throw new Error(
      "this detached dispatch was not started: its result token could not be created (the system's " +
        'random source failed). Retry, or dispatch without "detach".',
    );
  }
  const expected: RecordedIoToken = { sha256: ioTokenDigest(ioToken) };

  // Host mode: the id cco/accepted announced; the supervisor's core runs under it (its spec's
  // `id` becomes the core's preassignedId).
  const id = hostTask?.id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cwd = process.cwd();
  const specPath = path.join(TASKS_DIR, `${id}.spec.json`);
  const resultPath = path.join(TASKS_DIR, `${id}.result.json`);
  try {
    ensureDirs();
    // Exclusive create, owner-only: the file holds the token and the prompt, and the name is
    // one this process has just made up — anything already there is not ours to write through.
    fs.writeFileSync(specPath, JSON.stringify({ id, cwd, args, ioToken }), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    removeQuietly(specPath);
    throw new Error(
      `this detached dispatch was not started: its task spec could not be written under ${TASKS_DIR} ` +
        `(${errnoOf(err) ?? 'the write failed'}). Check that directory, or dispatch without "detach".`,
    );
  }

  // Track the id so an explicit client cancel (notifications/cancelled) can reach it
  // via cancelDetachTask. Kept ONLY here — never in the maps shutdown() sweeps — so
  // the supervisor stays excluded from shutdown (R3). Cleaned up when the wait settles.
  if (requestId !== null) {
    let ids = detachTasksByRequest.get(requestId);
    if (ids === undefined) {
      ids = new Set<string>();
      detachTasksByRequest.set(requestId, ids);
    }
    ids.add(id);
  }
  const untrack = (): void => {
    if (requestId === null) {
      return;
    }
    const ids = detachTasksByRequest.get(requestId);
    if (ids !== undefined) {
      ids.delete(id);
      if (ids.size === 0) {
        detachTasksByRequest.delete(requestId);
      }
    }
  };

  let foreignFileSeen = false;
  try {
    // __dirname is the bundle's own dir (out/mcp) — run-task.js is emitted beside
    // server.js and installed beside it. Same node binary, so the supervisor is
    // version-locked to this server.
    const runTaskJs = path.join(__dirname, 'run-task.js');
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [runTaskJs, specPath], {
        cwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      removeQuietly(specPath);
      throw new Error(supervisorNotStarted(errnoOf(err) ?? 'the spawn failed'));
    }
    // Let this process exit without waiting on the supervisor: survival is the point.
    child.unref();
    // For the whole life of the handle, not only while the wait below listens: an 'error'
    // event with no listener is thrown, and one that arrived after the wait had settled would
    // end this server over a process it does not even own any more.
    child.on('error', () => undefined);
    trace.taskId = id;
    // Host mode: the task is the supervisor's from here — it appends the task's events and its
    // terminal record, and a cancel reaches it through its marker. A child with no pid was never
    // started (its 'error' is on the way), and the task stays this host's to close.
    if (hostTask !== undefined && typeof child.pid === 'number') {
      hostTask.started = true;
      hostTask.supervisor = child;
    }

    // Ceiling sized to the supervisor's TRUE worst case, not one attempt: an unnamed
    // dispatch fails over across every worker, each attempt getting its own full timer,
    // so the wall clock can be maxAttempts × (timeout + kill/reap grace) + a write grace.
    // The single-attempt ceiling used before made a legitimately-slow failover relay a
    // spurious "did not produce a result" while the default path would have returned the
    // real result (the F3 §3 parity break). The liveness-aware wait below normally settles
    // long before this — the moment result.json lands or the supervisor exits — so this is
    // only a last-resort backstop for a supervisor that is alive but never writes.
    const maxAttempts = args.worker !== undefined ? 1 : Math.max(1, registry.workers.length);
    const perAttemptMs =
      clampTimeoutMinutes(args.timeout_minutes ?? registry.workerTimeoutMinutes) * 60_000 +
      ATTEMPT_KILL_REAP_GRACE_MS;
    const timeoutMs = Math.min(maxAttempts * perAttemptMs + RESULT_WAIT_GRACE_MS, TIMER_MAX_MS);

    // The listeners are attached inside this call, in the tick that spawned the child, so a
    // spawn failure — which arrives as an 'error' event, later — always has one.
    const end = await waitForDetachResult({ id, resultPath, expected, timeoutMs, supervisor: child });
    foreignFileSeen = end.foreignFileSeen;
    const outcome = end.outcome;
    switch (outcome.kind) {
      case 'result':
        if (outcome.result.status === 'error') {
          throw new Error(outcome.result.error ?? outcome.result.text);
        }
        return outcome.result.text;
      case 'not-started':
        // The supervisor never ran, so the spec it would have unlinked is still there — and it
        // holds the token and the verbatim prompt (F6).
        removeQuietly(specPath);
        throw new Error(supervisorNotStarted(outcome.why));
      case 'exited':
        // R6. What the task log ends up saying is the reconcile sweep's to decide, through the
        // token-gated registry.readResultForTask — the same gate, asked of the same file.
        throw new Error(
          `The supervisor of detached task ${id} exited without recording a result — it crashed or ` +
            `was killed, and its worker may still be running. Call dispatch_status with id "${id}" ` +
            'for what was recorded about the task.',
        );
      case 'timeout':
        // R6: the supervisor is alive but never produced a result within even the failover
        // worst case. Surface a timeout error — the same shape of failure a default dispatch
        // would surface, so the caller is not left waiting forever.
        throw new Error(
          `Detached task ${id} did not produce a result within the worker-timeout window. It may ` +
            `still be running in the background — call dispatch_status with id "${id}" for its ` +
            'recorded state.',
        );
      default:
        stderrLine(`cco-dispatch: the wait for detached task ${id} failed: ${sliceOneLine(flattenOneLine(outcome.why), 300)}`);
        throw new Error(
          `The wait for detached task ${id} failed inside the dispatch server — a defect in ` +
            `cco-dispatch, not in the task, which goes on. Call dispatch_status with id "${id}" for ` +
            'its recorded state.',
        );
    }
  } finally {
    untrack();
    if (foreignFileSeen) {
      noteIgnoredResultFile(id, args.title);
    }
  }
}

/** The refusal for a detached dispatch whose supervisor process could not be started. */
function supervisorNotStarted(why: string): string {
  return (
    `this detached dispatch was not started: its supervisor process could not be launched (${why}) — ` +
    'nothing ran and nothing was recorded. Retry, or dispatch without "detach".'
  );
}

/** The errno code of a caught value when it carries one (`ENOENT`, `EACCES`), else undefined. */
function errnoOf(err: unknown): string | undefined {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
}

/** Remove a file this process created, when it is still there. Never throws. */
function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone, or never created — a leftover under a unique id is litter, not a hazard
  }
}

/**
 * Say, once, in the output file of detached task `id`, that something at its result path was
 * not its supervisor's record and was ignored.
 *
 * Appended when the wait for that supervisor ENDS, not when the file was first seen: the
 * supervisor's core rewrites the whole output file when the task finishes, and a line appended
 * before that would be gone exactly when someone comes to read it. By the time the wait ends on
 * a record or on the supervisor's exit, that file has had its last write (run-task: the output
 * file, then the terminal event, then the record). Through registry.appendTaskNote, so the file
 * is the one the id names. Never throws.
 */
function noteIgnoredResultFile(id: string, title: string): void {
  try {
    appendTaskNote(
      {
        id,
        title,
        worker: '-',
        model: '-',
        outputFile: path.join(TASKS_DIR, `${id}.md`),
        ts: Date.now(),
        status: 'running',
      },
      "\n\n---\n\nNOTE: a result file that did not carry this dispatch's token was ignored.\n",
    );
  } catch {
    // best effort — the outcome relayed was never taken from that file either way
  }
}

/** Grace after the supervisor exits to let its just-renamed result.json become visible. */
const EXIT_READ_GRACE_MS = 150;

/**
 * READ CAP for one detach supervisor's tasks/<id>.result.json (safeFs.readTextSafe).
 *
 * Same value and same reasoning as registry's own cap on this exact path (RESULT_FILE_MAX_BYTES,
 * not exported), and the size the supervisor keeps its record within (run-task's
 * RESULT_RECORD_MAX_BYTES): the file is a JSON record whose largest field is one worker report,
 * cut by its writer to fit, and the path is UNGUARDED — a dispatched worker runs with Bash,
 * knows its own task id, and can write or replace anything there. Read unbounded it is a
 * one-line lever on this process's heap.
 */
const RESULT_JSON_MAX_BYTES = 1_048_576;

/**
 * THE GATE OF THE LIVE RELAY. `raw` is the text of a regular file found at the result path of
 * detached task `id`; the answer is the record to relay when that file is this dispatch's own
 * record, and undefined for anything else.
 *
 * Its own record is: a JSON object; carrying a `token` that proves itself against `expected`,
 * the digest of the token THIS process minted for the dispatch (ioToken.ioTokenProves — the
 * one place such a comparison is spelled); naming this task; with a `status` of exactly `done`
 * or `error`, a string `text`, and an `error` that is a string when there is one. The token is
 * asked FIRST: until it has answered, nothing else in the file is anybody's statement about
 * this task.
 *
 * EVERYTHING ELSE IS AS IF NO FILE WERE THERE — `null`, a number, an array, a string, text that
 * does not parse, a record without the token or with another one, a record of the right token
 * and the wrong shape. Not an error and not a result: the caller goes on waiting for the
 * supervisor, which replaces whatever is at that name with its record when it finishes. A file
 * anyone can put there must not be able to END the wait either, or planting garbage would turn
 * a running task into a failed dispatch.
 *
 * What comes back is a freshly built object holding the three validated fields and nothing
 * else of what was parsed. The token is checked and dropped: it never travels on.
 */
function ownDetachResult(raw: string, id: string, expected: RecordedIoToken): ResultJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const rec = parsed as Record<string, unknown>;
  if (!ioTokenProves(expected, rec.token)) {
    return undefined;
  }
  if (rec.id !== id) {
    return undefined;
  }
  const status = rec.status;
  if (status !== 'done' && status !== 'error') {
    return undefined;
  }
  if (typeof rec.text !== 'string') {
    return undefined;
  }
  if (rec.error !== undefined && typeof rec.error !== 'string') {
    return undefined;
  }
  return rec.error === undefined ? { status, text: rec.text } : { status, text: rec.text, error: rec.error };
}

/**
 * What is at `file` right now, as a string that changes whenever the thing there does — which
 * file it is, its size and its times — or undefined when nothing can be said (nothing there,
 * or it cannot be looked at). `lstat`: the name itself is asked, a link is not followed, and
 * no kind of thing at the name can make the call wait.
 */
function fileSignature(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    return `${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Wait for the record of ONE detached dispatch. Resolves — it never rejects — with how the wait
 * ended (DetachOutcome) and whether anything was found at the result path that was not the
 * supervisor's record.
 *
 * The record is taken only through ownDetachResult, from a read that is bounded, does not
 * block and does not follow a link (safeFs.readTextSafe with `noFollow`): the supervisor
 * writes a regular file under that name, so a link there is a pointer to some other file, put
 * there by something else. A directory, a pipe, a link, a file past the read cap and a file
 * that is not this dispatch's record are all the same thing to this wait — not the record —
 * and none of them ends it. `foreignFileSeen` is how the caller learns that one was there.
 *
 * fs.watch on TASKS_DIR is the fast path; a 200ms poll is the fallback for platforms or
 * filesystems where directory watch events are unreliable. The supervisor publishes its record
 * by atomic rename, so a read of it is never torn.
 *
 * THE WAIT IS LIVENESS-AWARE (contract F3): the supervisor writes result.json (atomic rename)
 * BEFORE it exits, so its 'exit' means the record either exists now or never will. On exit the
 * path is read once more after a short grace; still no record → it crashed or was killed
 * before writing (R6) → the wait ends there rather than at the ceiling. This is what lets a
 * long, legitimate multi-attempt failover run relay inline: while the supervisor is alive and
 * working, no fixed single-attempt clock fires.
 *
 * NOTHING HERE CAN THROW INTO NOWHERE. Every step runs from a timer, a watcher or a process
 * event — places where a throw has no caller, and would end the server with its workers still
 * running. Each is wrapped (`guarded`): a throw becomes the `failed` outcome, the wait is
 * cleaned up, and the dispatch that owns it reports it. Never leaves a timer, watcher, or
 * listener armed after it settles.
 */
function waitForDetachResult(opts: {
  id: string;
  resultPath: string;
  expected: RecordedIoToken;
  timeoutMs: number;
  supervisor: ChildProcess;
}): Promise<{ outcome: DetachOutcome; foreignFileSeen: boolean }> {
  return new Promise((resolve) => {
    const { id, resultPath, expected, supervisor } = opts;
    let settled = false;
    let foreignFileSeen = false;
    // The signature of the thing last judged NOT to be the record. While the same thing is
    // still there it is not read again: a megabyte of somebody's JSON at that name would
    // otherwise be read and parsed five times a second for as long as the task runs.
    let judgedForeign: string | undefined;
    let watcher: fs.FSWatcher | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const closeWatcher = (): void => {
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      watcher = undefined;
    };
    const settle = (outcome: DetachOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      closeWatcher();
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      if (ceilingTimer !== undefined) {
        clearTimeout(ceilingTimer);
      }
      if (exitGraceTimer !== undefined) {
        clearTimeout(exitGraceTimer);
      }
      supervisor.removeListener('exit', onExit);
      supervisor.removeListener('error', onError);
      resolve({ outcome, foreignFileSeen });
    };
    const guarded =
      <A extends unknown[]>(step: (...args: A) => void) =>
      (...args: A): void => {
        try {
          step(...args);
        } catch (err) {
          settle({ kind: 'failed', why: errorMessage(err) });
        }
      };

    const tryRead = (): void => {
      if (settled) {
        return;
      }
      const signature = fileSignature(resultPath);
      if (signature !== undefined && signature === judgedForeign) {
        return;
      }
      const read = readTextSafe(resultPath, RESULT_JSON_MAX_BYTES, { noFollow: true });
      if (!read.ok) {
        if (read.reason === 'absent' || read.reason === 'unreadable') {
          // Not written yet (the ordinary case, every tick until it is), or a read that failed
          // for a reason that says nothing about what is there: look again at the next event.
          return;
        }
        // Something that is not a regular file within the cap. The supervisor's rename replaces
        // it with the record when the task finishes; until then, it is not one.
        foreignFileSeen = true;
        judgedForeign = signature;
        return;
      }
      const result = ownDetachResult(read.text, id, expected);
      if (result === undefined) {
        foreignFileSeen = true;
        judgedForeign = signature;
        return;
      }
      settle({ kind: 'result', result });
    };
    const onExit = guarded(() => {
      if (settled || exitGraceTimer !== undefined) {
        return;
      }
      // The supervisor renames result.json into place before exiting; if exit and that
      // rename race, one more read after a short grace catches it. Still no record → the
      // supervisor died before writing one.
      exitGraceTimer = setTimeout(
        guarded(() => {
          // The last look is unconditional: whatever was judged before, read what is there now.
          judgedForeign = undefined;
          tryRead();
          settle({ kind: 'exited' });
        }),
        EXIT_READ_GRACE_MS,
      );
    });
    const onError = guarded((err: unknown) => {
      // A child that never got a pid could not be started (the run-task bundle is missing, the
      // process table is full): there will be no 'exit' and no record. An 'error' from a child
      // that IS running is about a signal or a message this process never sends; the exit
      // listener is what watches that child.
      if (typeof supervisor.pid !== 'number') {
        settle({ kind: 'not-started', why: errnoOf(err) ?? 'the spawn failed' });
      }
    });

    supervisor.on('exit', onExit);
    supervisor.on('error', onError);
    try {
      const name = path.basename(resultPath);
      watcher = fs.watch(
        TASKS_DIR,
        guarded((_event: string, filename: string | Buffer | null) => {
          // Some platforms name no file; then every event is worth one look.
          if (filename === null || String(filename) === name) {
            tryRead();
          }
        }),
      );
      // A watcher reports its own failure (the directory was removed, the watch limit was
      // reached) as an 'error' event, and one nobody listens for ends the process. The poll
      // below finds the file without it.
      watcher.on('error', closeWatcher);
    } catch {
      // directory watch unsupported here — the poll below still finds the file
      watcher = undefined;
    }
    pollTimer = setInterval(guarded(tryRead), 200);
    ceilingTimer = setTimeout(
      guarded(() => settle({ kind: 'timeout' })),
      opts.timeoutMs,
    );
    // The file can already exist (a very fast supervisor) before either watcher or
    // poll is armed; and a child that failed to start synchronously has no pid already.
    guarded(tryRead)();
  });
}

/**
 * dispatch_tasks: every task of the batch at once, each through dispatchTask, and one text with
 * a section per task. `tasks` are the CHECKED arguments of every member
 * (dispatch-args.checkDispatchBatch) — the request handler refuses the whole call when one of
 * them fails the check, so nothing here runs for a batch that is not sound as a whole.
 *
 * The section header carries the task's checked title: one line of bounded length, so a title
 * cannot open a section of its own in this text.
 *
 * `accepted` is set in host mode only: the tasks cco/accepted announced, one per member in order,
 * each run through hostDispatchTask under its own id.
 */
async function dispatchTasksParallel(
  tasks: DispatchArgs[],
  requestId: string | number | null,
  accepted?: HostTask[],
): Promise<string> {
  // Once for the batch, so a registry that cannot be read is ONE refusal of the call rather
  // than the same sentence under every task's header.
  const unreadable = registryProblemText(readRegistryChecked().problem);
  if (unreadable !== undefined) {
    throw new Error(`${unreadable} Nothing was dispatched.`);
  }
  // Every task in the batch runs under this one request id, so cancelling the
  // request cancels the whole batch.
  const results = await Promise.allSettled(
    tasks.map((t, i) => (accepted === undefined ? dispatchTask(t, requestId) : hostDispatchTask(t, requestId, accepted[i]))),
  );
  const parts = results.map((r, i) => {
    const header = `===== Task ${i + 1}: ${tasks[i].title} =====`;
    return r.status === 'fulfilled'
      ? `${header}\n${r.value}`
      : `${header}\nFAILED: ${failureText('dispatch_tasks', r.reason)}`;
  });
  const failed = results.filter((r) => r.status === 'rejected').length;
  return (
    `${tasks.length} task(s) dispatched in parallel, ${tasks.length - failed} succeeded, ${failed} failed.\n\n` +
    parts.join('\n\n')
  );
}

/** One task's status record in a dispatch_status payload. */
interface StatusRecord {
  id: string;
  found: boolean;
  /**
   * What the task's latest log record says, or `not_found` when the log — which was read —
   * holds no record of the id. `unknown` is a record whose status is none of the three this
   * version writes; it is said as that, never passed on as if it were one. `queued` (host mode
   * only) is a task this host accepted that has no record yet: it waits for a slot of the
   * dispatch gate, and `note` says where it is in the queue.
   */
  status: 'running' | 'done' | 'error' | 'not_found' | 'unknown' | 'queued';
  title?: string;
  worker?: string;
  /**
   * What the task's attempt asked its CLI for: an alias or a full id — the dispatch's own, or
   * the worker account's default when the dispatch named none. A failed dispatch says what its
   * last attempt asked for. It is `-` only when no model was passed at all: an account with no
   * default, or a dispatch that named none and failed before any attempt. (Once a run that
   * passed none has FINISHED on another vendor's CLI, it is the id that CLI said ran.)
   */
  model?: string;
  /**
   * The model id the worker's CLI reported it ran — on a `done` task whose CLI said so. Absent
   * otherwise (a failed run, a session worker, a CLI that names none): unknown, not "the same".
   */
  modelUsed?: string;
  /**
   * Who chose `model`: `dispatch` (the dispatch named it), `worker` (the worker account's
   * default), `cli` (neither — the CLI's own default ran). Absent for a task recorded before
   * this was.
   */
  modelSource?: ModelSource;
  /** The vendor id of the worker, when it was not Claude Code (`codex`, `cursor`, `gemini`). */
  provider?: string;
  ts?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The terminal result text (from result.json, else the output file) — set when terminal. */
  result?: string;
  /**
   * WHY there is no `result`, or what was rejected on the way to the one there is. Set only when
   * there is a fact to state: a result file that was PRESENT and refused, or an output file that
   * could not be read. Silence here used to cover both, and "nothing was ever written for this
   * task" is a different thing to tell an orchestrator than "something was written and this
   * server refused it" or "the body is on disk and over the read cap".
   *
   * Descriptive only, and composed exclusively from this module's literals, the registry's own
   * refusal literals and a FLATTENED path — never from the bytes of the file being described.
   */
  resultProblem?: string;
  /**
   * A `queued` task's place in this host's queue, in the contract's words (§15.5): "queued —
   * position <n> of <m>, waiting for a dispatch slot". Set on that status only.
   */
  note?: string;
}

/**
 * Read ceiling for one task output file, in bytes.
 *
 * `tasks/<id>.md` is written by the dispatch path, but nothing on disk enforces that: a
 * dispatched worker runs with Bash, is told its io directory, and can derive both the tasks
 * directory and its own task id. So its SIZE and its TYPE are untrusted. The ceiling is on what
 * this process will READ, and it sits above the largest file a dispatch writes — the prompt and
 * system prompt the argument check admits, plus the most output the one-shot core accepts from
 * a worker, plus the header — so that a real report, however long, is never refused for its
 * size. What is RELAYED of it is bounded separately and far lower, by relayText, which says
 * that it cut and where the whole text is. A file past this ceiling is refused and said so:
 * nothing this product writes is that large.
 */
const OUTPUT_BODY_MAX_BYTES = 16 * 1024 * 1024;

/** A task's output-file body, or the reason there is none. */
type OutputBodyRead = { text: string } | { problem: string };

/**
 * Read the output-file body of task `id`. Never throws.
 *
 * THE FILE IS FOUND BY THE TASK'S ID (registry.readTaskFile): `<tasks dir>/<id>.md`, and
 * nothing else. The path a log event records as its `outputFile` is not opened, here or
 * anywhere in this file — the log is a file any process running as this user can append a line
 * to, and a reader that opens what a line names hands back whatever file that line points at.
 * An id that cannot be a file name has no output file.
 *
 * THE READ IS registry.readTaskFile's: non-blocking, bounded, refusing anything that is not a
 * regular file and refusing a symbolic link in the open itself. The name is one a dispatched
 * worker can occupy, so the thing at it is whatever that worker made it — a `mkfifo` there once
 * hung the MCP server for ever on a plain read, and a link there would be a way to have some
 * other file returned as this task's report.
 *
 * Failure is REPORTED rather than swallowed: "no file", "not a file", "too big" and
 * "unreadable" are different facts, and dispatch_status says which one it met.
 */
function readOutputBody(id: string): OutputBodyRead {
  const file = taskReportPath(id);
  if (file === undefined) {
    return { problem: "this task's id cannot be the name of a file, so it has no output file to read" };
  }
  // Flattened: the path holds the home directory's name, and this string is relayed to a model.
  const where = oneLine(file);
  const read = readTaskFile(id, 'output', OUTPUT_BODY_MAX_BYTES);
  if (read.ok) {
    return { text: read.text };
  }
  switch (read.reason) {
    case 'absent':
      return { problem: `this task's output file (${where}) is not on disk` };
    case 'not-a-file':
      return {
        problem:
          `what is at this task's output path (${where}) is NOT a regular file, so nothing was ` +
          'read from it',
      };
    case 'too-large':
      return {
        problem:
          `this task's output file (${where}) is larger than the ${OUTPUT_BODY_MAX_BYTES}-byte ` +
          'read cap and was not read — the file is still on disk',
      };
    default:
      return { problem: `this task's output file (${where}) could not be read (${oneLine(read.detail)})` };
  }
}

/** The most task ids one dispatch_status call may name. */
const STATUS_MAX_IDS = 100;
/** The longest task id accepted — the longest that can name a task's files (registry.isTaskFileId). */
const STATUS_ID_MAX_CHARS = 128;

/** What a value is, in the words a refusal uses: `a number`, `an array`, `null`. */
function kindOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'nothing';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** At most 80 characters of a refused value, on one line — all a refusal ever quotes of one. */
function echoed(value: string): string {
  return sliceOneLine(flattenOneLine(value), 80);
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** One task id of a dispatch_status call: a string of 1–128 characters on one line. */
function checkTaskIdArg(value: unknown, field: string): Checked<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: `invalid ${field} — expected a task id (a string), got ${kindOf(value)}` };
  }
  const id = value.trim();
  if (id === '') {
    return { ok: false, error: `invalid ${field} — expected a task id, got an empty string` };
  }
  if (id.length > STATUS_ID_MAX_CHARS) {
    return {
      ok: false,
      error: `invalid ${field} — ${id.length} characters; a task id has at most ${STATUS_ID_MAX_CHARS}`,
    };
  }
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    return { ok: false, error: `invalid ${field} — expected a task id on a single line, got "${echoed(id)}"` };
  }
  return { ok: true, value: id };
}

/**
 * The task ids a dispatch_status call names: `id` (one) and/or `ids` (a list), each checked by
 * type and size before anything is read. Absent and null are "not given"; a call that gives
 * neither is refused, and so is one that names more than STATUS_MAX_IDS tasks — every id costs
 * a read of its files, and each terminal one puts up to a megabyte into the result.
 */
function checkStatusArgs(args: Record<string, unknown>): Checked<string[]> {
  const ids: string[] = [];
  if (args.id !== undefined && args.id !== null) {
    const one = checkTaskIdArg(args.id, 'id');
    if (!one.ok) {
      return one;
    }
    ids.push(one.value);
  }
  if (args.ids !== undefined && args.ids !== null) {
    if (!Array.isArray(args.ids)) {
      return { ok: false, error: `invalid ids — expected an array of task ids, got ${kindOf(args.ids)}` };
    }
    if (args.ids.length > STATUS_MAX_IDS) {
      return {
        ok: false,
        error: `invalid ids — ${args.ids.length} ids; the limit is ${STATUS_MAX_IDS} per call`,
      };
    }
    for (let i = 0; i < args.ids.length; i++) {
      const one = checkTaskIdArg(args.ids[i], `ids[${i}]`);
      if (!one.ok) {
        return one;
      }
      ids.push(one.value);
    }
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return {
      ok: false,
      error: 'invalid id — expected a task id in "id", or an array of task ids in "ids"',
    };
  }
  if (unique.length > STATUS_MAX_IDS) {
    return { ok: false, error: `invalid ids — ${unique.length} ids; the limit is ${STATUS_MAX_IDS} per call` };
  }
  return { ok: true, value: unique };
}

/** A text field of a log record, by value: one bounded line when it is a string, else nothing. */
function recordLine(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? sliceOneLine(flattenOneLine(value), max) : undefined;
}

/** A count or an amount of a log record, by value: a finite number that is not negative, else 0. */
function recordNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** `modelUsed` of a log record, by value: a string in the shape of a reported model id, else nothing. */
function recordModelUsed(value: unknown): string | undefined {
  return typeof value === 'string' && REPORTED_MODEL_ID.test(value) ? value : undefined;
}

/** `modelSource` of a log record, by value: one of the three words, else nothing. */
function recordModelSource(value: unknown): ModelSource | undefined {
  return value === 'dispatch' || value === 'worker' || value === 'cli' ? value : undefined;
}

/**
 * dispatch_status — retrieval of one or more dispatched tasks by id (contract §6). `ids` are the
 * checked ids of the call (checkStatusArgs), without duplicates.
 * Reads the latest tasks.jsonl event per id and, when the task is terminal, attaches its
 * result text (preferring the exact tasks/<id>.result.json string a detach task recorded,
 * falling back to the tasks/<id>.md body) — and, when either read produced a fact instead of a
 * body, a `resultProblem` saying so. Returns a JSON object `{ tasks: [...] }` the orchestrator
 * can parse.
 *
 * "NOT FOUND" IS ONLY EVER SAID OF A LOG THAT WAS READ. A task log that could not be read —
 * past its read cap, unreadable, a directory where the file should be — holds an unknown number
 * of records of the ids asked about, and answering `not_found` for each would tell an
 * orchestrator that its running tasks do not exist. The whole call fails instead, saying that
 * the status is unknown and which file to look at (registry.latestEventsByIdsChecked draws the
 * line: a log that is simply not there yet was read, and holds nothing).
 *
 * EVERY FIELD OF A RECORD IS TAKEN BY VALUE. A log line is text any process running as this
 * user can append; what goes into this result is a string where a string is expected, bounded,
 * and a number where a number is.
 *
 * Spawns nothing, but is NOT purely read-only: it first runs a BOUNDED reaper reconcile
 * over the requested ids (contract F2 / R8). The reaper is otherwise only wired to VS Code
 * extension startup, so in a headless/CLI deployment — exactly the "session was interrupted,
 * retrieve later" case this tool serves — a crashed supervisor's task would sit `running`
 * forever. Reconciling just the ids being asked about heals that here, writing nothing the
 * reaper would not have written and touching no unrelated task.
 *
 * In host mode an id this host accepted that has no record yet is answered `queued` with its
 * place in the queue (dispatchStatusRecords) instead of not_found. An id queued in ANOTHER
 * session's host reads not_found until it starts (stated residual, §15.5): that host's queue is
 * in that host's memory.
 */
function dispatchStatus(ids: string[]): string {
  return statusText(dispatchStatusRecords(ids));
}

/** The text dispatch_status answers with — and cco/status, which must say exactly the same. */
function statusText(tasks: StatusRecord[]): string {
  return JSON.stringify({ tasks }, null, 2);
}

/**
 * The liveness test of dispatch_status's reconcile. On stdio: the mesh-aware callback alone, as it
 * always was. In host mode, also every task THIS process holds in flight — a task between two
 * attempts of a failover, or whose vendor CLI is still being started, has a `running` event with
 * no live worker pid on it for a moment, and cco/status runs this reconcile every
 * STATUS_WAIT_POLL_MS: a task this process is running is alive by definition, and must never be
 * settled as orphaned under it, however long its gap lasts.
 *
 * The same gap in a task of ANOTHER process — another session's host, an MCP server — is covered
 * by the registry, under this callback, in every reconcile: a `running` event that names no
 * process and is younger than FAILOVER_GRACE_MS reads alive (registry.taskLooksAlive /
 * inDispatcherGrace, contract §15.12 M4). That rule is a DELIBERATE change for BOTH transports:
 * what dispatch_status answers on stdio changes through it too (such a task reads `running` for up
 * to three minutes where it read `error: orphaned` at once), and through nothing else here.
 *
 * Team mode: a turn the team engine holds is alive while the engine says so (teamOwnsTurn) — the
 * engine owns its process, which none of this file's maps ever holds (I7).
 */
function statusAliveCheck(): (t: TaskEvent) => boolean {
  const meshAlive = meshTaskAliveCheck();
  if (hostTransport === undefined) {
    return meshAlive;
  }
  return (t: TaskEvent): boolean => {
    const id: unknown = t?.id;
    // A team turn is asked of the engine FIRST (§7.9 step 5, H2): it is in none of this file's
    // maps, and is alive for as long as the engine holds it.
    return (
      (typeof id === 'string' && (teamOwnsTurn(id) || hostTasks.has(id) || taskBases.has(id))) || meshAlive(t)
    );
  };
}

/** dispatchStatus's records — what cco/status also needs, to say which ids are still pending. */
function dispatchStatusRecords(ids: string[]): StatusRecord[] {
  // Headless reconcile of just these ids before reading their status, so a dead
  // supervisor's ledger is healed even with no VS Code host (F2). Never throws.
  //
  // The mesh-aware liveness callback is what keeps a `--bg` dispatch from being reaped as
  // orphaned: those tasks deliberately carry no worker pid (their worker is not our
  // child), so the pid test alone would call every live attachable task dead (P6.1).
  try {
    reapDeadTasks(ids, statusAliveCheck(), meshTaskRecovery());
  } catch {
    // reconcile is best-effort — a failed sweep must not fail the status read
  }
  // Host mode: the same single read of the log answers for every task this host accepted, so the
  // queue's order and size are known — a task is queued exactly while it has no record. On stdio
  // there are none, and the read is the one it always was.
  const accepted: string[] = hostTransport === undefined ? [] : [...hostTasks.keys()];
  const { events: latest, unreadable } = latestEventsByIdsChecked(accepted.length === 0 ? ids : [...ids, ...accepted]);
  if (unreadable) {
    throw new Error(
      'The task log could not be read — task status is UNKNOWN (not "not found"). ' +
        `The log is ${oneLine(TASKS_LOG_FILE)}: it is larger than this server reads, unreadable, or ` +
        'not a regular file; ask again once that is fixed. The report of a task that wrote one is ' +
        `${oneLine(TASKS_DIR)}${path.sep}<task id>.md.`,
    );
  }
  // The queue, in acceptance order: this host's accepted tasks that have no record yet.
  const queue = accepted.filter((id) => !latest.has(id));
  const tasks: StatusRecord[] = ids.map((id): StatusRecord => {
    const ev = latest.get(id);
    if (ev === undefined) {
      const at = queue.indexOf(id);
      return at === -1 ? { id, found: false, status: 'not_found' } : queuedRecord(id, at + 1, queue.length);
    }
    const field = ev as unknown as Record<string, unknown>;
    const known = field.status === 'running' || field.status === 'done' || field.status === 'error';
    const rec: StatusRecord = {
      id,
      found: true,
      status: known ? ev.status : 'unknown',
      title: recordLine(field.title, 200),
      worker: recordLine(field.worker, 256),
      model: recordLine(field.model, 256),
      ts: typeof field.ts === 'number' && Number.isFinite(field.ts) ? field.ts : undefined,
    };
    if (!known) {
      rec.resultProblem =
        'the latest record of this task in the task log carries a status this version does not ' +
        'know, so nothing more is reported about it';
      return rec;
    }
    // By value, like every field: who chose the model, for a task in any state; what the CLI
    // reported it ran, only for one that finished — the one event a dispatch records it on.
    const modelSource = recordModelSource(field.modelSource);
    if (modelSource !== undefined) {
      rec.modelSource = modelSource;
    }
    const modelUsed = ev.status === 'done' ? recordModelUsed(field.modelUsed) : undefined;
    if (modelUsed !== undefined) {
      rec.modelUsed = modelUsed;
    }
    // By value: the field comes off a log line, and only a known non-Claude id is passed on.
    const provider = parseProvider(field.provider);
    if (provider !== undefined && provider !== 'claude') {
      rec.provider = provider;
    }
    if (ev.status === 'error' && typeof field.error === 'string') {
      rec.error = relayText(field.error, id);
    }
    if (ev.status === 'done') {
      rec.inputTokens = recordNumber(field.inputTokens);
      rec.outputTokens = recordNumber(field.outputTokens);
      rec.costUsd = recordNumber(field.costUsd);
    }
    // Terminal → attach the result body. Prefer the exact result.json text (what a
    // detach task recorded and the server would have relayed); fall back to the
    // output file for a default task, which has no result.json.
    //
    // A TERMINAL EVENT DOES NOT PROMISE THE RECORD YET. A detach supervisor writes its
    // result.json AFTER the terminal event (run-task's header gives the order and why), so a
    // call that lands between the two finds the event and no record, and reports the output
    // file — final by then — exactly as it does for a task that never had a record.
    //
    // THROUGH THE VALIDATED ACCESSOR, not the raw one, and the difference is not cosmetic.
    // `readResultJson` answers only "is there a well-formed record at tasks/<id>.result.json".
    // `readResultForTask` additionally answers the one WRITER question this system can answer:
    // a dispatch carrying an `ioToken` or a `meshWorker` has NO detach supervisor, so nothing is
    // permitted to have written that path, and a file found there is refused outright — its own
    // channel of record is the token-gated bg-io one. This surface read the raw accessor and so
    // skipped that arm entirely. Verified: for a NORMALLY COMPLETED mesh task, a file planted at
    // the unguarded detach path was handed to the orchestrating model IN PREFERENCE TO the
    // genuine token-gated report — the real deliverable discarded, a forged one served, on the
    // surface a model reads. The reconcile ladder had the guard; the tool call did not. Same
    // defect shape as every other one-call-site guard in this file's history: the fix is to use
    // the accessor that owns the rule, never to restate the rule here.
    if (ev.status !== 'running') {
      const notes: string[] = [];
      const read = readResultForTask(ev);
      if (read.kind === 'refused') {
        // Said, not swallowed. "A result file was present and was refused" and "there was no
        // result file" are different facts about a task, and silence reports the second one.
        // `why` is composed by the registry from its own literals — none of the file's bytes.
        notes.push(
          `a result.json was PRESENT at this task's detach path and was REFUSED — ${read.why}; ` +
            'nothing in this record was taken from it',
        );
      }
      if (read.kind === 'ok' && typeof read.record.text === 'string') {
        rec.result = relayText(read.record.text, id);
      } else {
        const body = readOutputBody(id);
        if ('text' in body) {
          rec.result = relayText(body.text, id);
        } else {
          notes.push(body.problem);
        }
      }
      if (notes.length > 0) {
        rec.resultProblem = notes.join('; ');
      }
    }
    return rec;
  });
  return tasks;
}

/**
 * The record of a task this host accepted that has no event yet (§15.5 "Queued"): its title, when
 * it was accepted, and its place among the host's queued tasks. Found: this host knows it, and
 * the id resolves for good once the task starts, ends, or is cancelled.
 */
function queuedRecord(id: string, position: number, of: number): StatusRecord {
  const task = hostTasks.get(id);
  return {
    id,
    found: true,
    status: 'queued',
    title: task?.title,
    ts: task?.acceptedAt,
    note: `queued — position ${position} of ${of}, waiting for a dispatch slot`,
  };
}

/**
 * Refresh the usage cache before a list_workers render when it is stale, bounding
 * spawns so repeated calls inside the window reuse the cache. Delegates the
 * staleness decision to refreshAllUsageIfStale, which skips probing only when
 * EVERY account's cached reading is within 120s — per-account freshness, so a
 * newly added worker (no cache entry) triggers a refresh even when the others are
 * fresh. Never throws — a failed refresh just leaves the previous (or absent) readings.
 *
 * SINGLE-FLIGHT (host-protocol, list_workers' RULES): while one refresh is running, every other
 * caller awaits that one — on a host, any number of connections polling list_workers start at
 * most one probe per account at a time. The staleness test alone does not give that: it reads
 * the cache before the running refresh has written it.
 */
async function refreshUsageIfStale(): Promise<void> {
  if (usageRefreshInFlight === undefined) {
    usageRefreshInFlight = (async () => {
      try {
        // Short 5s per-probe timeout on this path: list_workers awaits the full
        // refresh, so one hung/misauthenticated account must not pin a whole
        // concurrency wave for the default 20s and block the tool call ~40s.
        await refreshAllUsageIfStale(120_000, undefined, 3, 5000);
      } catch {
        // Probe or cache-write failure degrades to whatever the cache already holds.
      } finally {
        usageRefreshInFlight = undefined;
      }
    })();
  }
  return usageRefreshInFlight;
}

/** The Claude Code accounts' usage refresh in flight (refreshUsageIfStale), or undefined. */
let usageRefreshInFlight: Promise<void> | undefined;

function renderWindow(w: UsageWindow): string {
  const percent = typeof w.percent === 'number' && isFinite(w.percent) ? Math.round(w.percent) : 0;
  const severity = typeof w.severity === 'string' && w.severity ? w.severity : 'normal';
  const resetsAt = typeof w.resetsAt === 'string' ? w.resetsAt : null;
  const marker = isElevated(severity) ? ` ⚠${severity}` : '';
  // windowLabel: an adapter's bare `primary` / `secondary` read "Primary limit" / "Secondary
  // limit" here as they do in the views; every other label is the reading's own.
  return `${windowLabel(w.label)} ${percent}%${marker} (resets ${formatRelativeReset(resetsAt)})`;
}

/**
 * One live-usage line for an account. `available:false` with no error is
 * ambiguous: it is either a non-subscription login that genuinely has no plan
 * limits, or a subscription whose OAuth session expired. isLoginExpired() is the
 * single source of truth that separates the two (it only says yes on a fresh
 * loggedIn:false probe), so the server and the extension can never disagree.
 *
 * `usage` is the reading the CALLER chose for this account — the main account's by directory,
 * a registry worker's through the ownership-aware accessor (see listWorkers) — so this function
 * never decides whose reading a directory's entry is.
 */
function usageLine(usage: AccountUsage | undefined, configDir: string): string {
  // Every Claude Code account's line ends with its login state and its age (Login state (CA)).
  return `${usageLineHead(usage, configDir)} · ${loginStateText(loginStateOf(usage))}`;
}

/**
 * usageLine without the login state at its end. "Logged out" is said ONLY for a confirmed logout
 * (isLoginExpired — the state `loggedOut`); a last known "not logged in" that this process has not
 * confirmed is said as exactly that, never as a verdict and never as "no plan limits".
 */
function usageLineHead(usage: AccountUsage | undefined, configDir: string): string {
  if (usage === undefined) {
    return 'usage: — (refreshing)';
  }
  if (usage.error !== undefined) {
    return `usage unavailable: ${usage.error}`;
  }
  if (isLoginExpired(usage)) {
    return (
      `login expired / logged out — re-login needed (${reloginCommand(configDir)}) — ` +
      'automatic assignment skips this worker'
    );
  }
  if (usage.available !== true) {
    if (isLoginSuspect(usage)) {
      return 'login not confirmed — the last word on it was "not logged in"; it is checked live before a dispatch uses it or refuses it';
    }
    return 'no plan limits (login is a token / non-subscription)';
  }
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const overage = overageSegment(usage.extraUsage);
  if (windows.length === 0) {
    // Distinguish an intermittent upstream gap (we HAD windows recently but the
    // carry-forward has since expired) from an account that has simply never
    // reported windows. lastGoodWindowsAt survives stale-carry expiry, so its
    // presence marks the former — a transient outage, not a limitless account.
    if (typeof usage.lastGoodWindowsAt === 'number' && isFinite(usage.lastGoodWindowsAt)) {
      return `usage: temporarily unavailable — upstream returned no data (last good ${formatAge(usage.lastGoodWindowsAt)})${overage}`;
    }
    return `usage: no rate-limit windows reported${overage}`;
  }
  // Carried-over windows are real readings, just not current ones. Marking them
  // is the whole point: an unmarked stale number reads as a live number.
  const stale =
    usage.windowsStale === true
      ? ` (plan usage as of ${formatAge(usage.windowsFetchedAt)} — upstream returned no data)`
      : '';
  return `usage: ${windows.map(renderWindow).join(' · ')}${stale}${overage}`;
}

/**
 * Overage-billing segment appended (with a ` · ` separator) to an available
 * account's usage line. `null` extraUsage renders nothing. Never emits `null`
 * or `NaN`: each optional part is dropped when its source value is absent.
 */
function overageSegment(extra: ExtraUsage | null): string {
  // The cache is a JSON file that can be corrupt or hand-edited. Anything that
  // is not a proper object renders NOTHING: on a money surface, saying "off"
  // when we cannot actually read the state is a false reassurance.
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    return '';
  }
  if (extra.enabled !== true) {
    return ' · overage: off';
  }
  let seg = ' · overage: ON ⚠';
  if (typeof extra.spendLabel === 'string') {
    seg += ` (${extra.spendLabel})`;
  }
  if (typeof extra.percent === 'number' && isFinite(extra.percent)) {
    seg += ` ${extra.percent}% of cap`;
  }
  return seg;
}

/** How long a non-Claude account's reading counts as fresh on the list_workers path — the Claude accounts' window. */
const PROVIDER_STATUS_FRESH_MS = 120_000;
/**
 * Budget of ONE non-Claude status reading on that path (login check plus usage read). The
 * readings run side by side, so this is also what they can add to the whole call. Longer than
 * the Claude probe's 5 s because two of these vendors answer a login check with a network
 * round trip.
 */
const PROVIDER_STATUS_TIMEOUT_MS = 8_000;

/**
 * Refresh the readings of the workers on another vendor's CLI, when stale — the counterpart of
 * refreshUsageIfStale, which covers Claude Code accounts only (their probe is a `claude`
 * control request another vendor's account cannot answer).
 *
 * Each stale account is read in-process through its adapter (providerStatus) and the reading is
 * filed by usage.recordProviderStatus — the same shape, through the same writer, as the
 * extension's own refresh. A usage reading is asked for unless the operator turned that off
 * (registry.providerUsagePolling === false): for some vendors it is a request to the vendor
 * made with the account's local login. The login is checked either way. Never throws.
 *
 * Single-flight, as refreshUsageIfStale: a call while one is running awaits that one. Residual:
 * the running one reads the registry its first caller read — a registry changed in between is the
 * next refresh's.
 */
function refreshProviderWorkersIfStale(registry: Registry): Promise<void> {
  if (providerRefreshInFlight === undefined) {
    providerRefreshInFlight = refreshProviderWorkersNow(registry).finally(() => {
      providerRefreshInFlight = undefined;
    });
  }
  return providerRefreshInFlight;
}

/** The other vendors' refresh in flight (refreshProviderWorkersIfStale), or undefined. */
let providerRefreshInFlight: Promise<void> | undefined;

async function refreshProviderWorkersNow(registry: Registry): Promise<void> {
  try {
    const cache = readUsageCache();
    const now = Date.now();
    const stale = listProviderAccounts().filter(
      (account) => !isCacheFresh(cache, [account], now, PROVIDER_STATUS_FRESH_MS),
    );
    const quota = registry.providerUsagePolling !== false;
    await Promise.all(
      stale.map(async (account) => {
        const status = await providerStatus(
          { provider: account.provider, configDir: account.configDir },
          { quota, timeoutMs: PROVIDER_STATUS_TIMEOUT_MS },
        );
        recordProviderStatus({ name: account.name, configDir: account.configDir }, status);
      }),
    );
  } catch {
    // a failed refresh degrades to whatever the cache already holds
  }
}

/**
 * The status line of a worker on another vendor's CLI: its login, then its usage.
 *
 * Built from the CACHED READING and nothing else — never from which vendor it is. A window is
 * shown whenever the reading has one, and "no usage reading" is said whenever it has none:
 * which vendors can report usage is a property of the installed adapter version, and a reading
 * that starts carrying windows must show up here with no change to this code.
 *
 * `usage` is the worker's OWN reading (usage.getCachedWorkerUsage), never whatever is filed
 * under its directory: the cache holds one reading per directory, and a worker registered on a
 * directory whose reading belongs to another account — a Claude Code account's, or an earlier
 * vendor worker's — has none. That is said as such, because "no reading yet" would promise one.
 */
function providerUsageLine(worker: WorkerProfile, usage: AccountUsage | undefined): string {
  if (usage === undefined) {
    return ownsUsageReading(worker)
      ? 'login: — · usage: — (no reading yet)'
      : "login: — · usage: — (no reading: this directory's reading belongs to another account)";
  }
  if (usage.error !== undefined) {
    return `status unavailable: ${oneLine(String(usage.error))}`;
  }
  const auth = parseAuth(usage.auth);
  const login =
    auth === undefined
      ? 'login: unknown'
      : auth.loggedIn
        ? `login: logged in${auth.method ? ` (${oneLine(auth.method)})` : ''}`
        : `login: LOGGED OUT — re-login needed (${workerReloginHint(worker)}) — automatic assignment skips this worker`;
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  if (windows.length === 0) {
    return `${login} · usage: no usage reading`;
  }
  // Carried-over windows are real readings, just not current ones — marked, like a Claude one.
  const stale = usage.windowsStale === true ? ` (as of ${formatAge(usage.windowsFetchedAt)})` : '';
  return `${login} · usage: ${windows.map(renderWindow).join(' · ')}${stale}`;
}

/** `1 task`, `2 tasks`, `0 errors` — a count with its noun in the right number. */
function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A token count for a line a person reads: the exact number below 10,000, then one decimal of
 * the largest unit that keeps it under a thousand — `12.3k`, `17.9M`, `1.2B`. A total that is
 * not a count (the file is hand-editable) prints as 0, as it reads everywhere else.
 */
function compactCount(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return '0';
  }
  if (n < 10_000) {
    return String(n);
  }
  const units: Array<[string, number]> = [
    ['k', 1e3],
    ['M', 1e6],
    ['B', 1e9],
  ];
  for (const [unit, size] of units) {
    // 999.95 is where one decimal would round up to "1000.0": that value belongs to the next unit.
    if (n / size < 999.95) {
      return `${(n / size).toFixed(1)}${unit}`;
    }
  }
  return `${(n / 1e12).toFixed(1)}T`;
}

/* ------------------------------------------------------------------------- *
 * "Last ran as" — what the task log says a worker's default resolved to
 * ------------------------------------------------------------------------- */

/**
 * The most of the task log this reader takes: the registry's own read cap for the same file. A
 * log past it is one no reader of this product reads, and nothing is shown from it.
 */
const TASK_LOG_READ_MAX_BYTES = 67_108_864;
/** How much of the log is in memory at a time while it is read. */
const TASK_LOG_CHUNK_BYTES = 256 * 1024;
/** Read-only, and never parked on a pipe or made a controlling terminal by what is at the name. */
const TASK_LOG_OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/** What identifies one state of the log file: a change in any of the four is a new log. */
function taskLogKey(st: fs.Stats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
}

/** What one pass over the task log kept: final events ready for ranAs.ranAsOf, newest first. */
interface RanAsLog {
  /** The state of the log file they were taken from (taskLogKey); `absent` when there is none. */
  key: string;
  facts: FinalTaskFacts[];
}

/** The last pass, kept for as long as the file it read is the file that is there. */
let ranAsLog: RanAsLog | undefined;
/** The answers computed from `ranAsLog` for one set of accounts — what a repeated call returns. */
let ranAsAnswers: { key: string; accounts: string; answers: Map<string, string> } | undefined;

/**
 * The final events of the task log that can say what a default ran as — newest first — or
 * undefined when the log could not be read (which shows nothing extra, as an empty one does).
 *
 * ONE BOUNDED PASS, AND NOT THE PARSED LOG. The log is read through a fixed buffer, a line at a
 * time; each line is parsed, looked at and let go. What is kept per TASK is at most the six
 * fields the rule reads (ranAs.FinalTaskFacts) of its FINAL event — the last event of its id in
 * file order among those ranAs.isCountedTaskEvent admits — and only when that event could
 * answer for some account at all: it is `done` and carries a well-formed `modelUsed`. A task
 * that ended any other way is kept as a mark that it did (its earlier events no longer count).
 * Reading the whole log into an array of events for this, as it was first written, cost a
 * server 370 MiB of resident memory on a 61 MiB log, on every call.
 *
 * What is RETURNED is smaller still: for each distinct (worker, CLI, model asked for, source)
 * only the newest such final event. The rule's answer for an account depends on those four
 * fields and nothing else, so an older event with the same four can never be the answer where a
 * newer one is not.
 *
 * CACHED on the file's identity and state — device, inode, size, modification time — so a
 * repeated call costs one `stat`. A log that grew, was truncated or was replaced differs in at
 * least one of the four and is read again; one rewritten in place to the same size with its time
 * put back is not noticed, which is the limit of asking a file whether it changed.
 *
 * The file is opened without blocking and asked what it is before a byte is read: the log's
 * path is fixed and known to every dispatched worker, and a pipe or a device put there must not
 * park this server. Does not throw: whatever the file system throws ends as "could not be read".
 */
function finalRanAsFacts(): RanAsLog | undefined {
  let fd = -1;
  try {
    let seen: fs.Stats;
    try {
      seen = fs.statSync(TASKS_LOG_FILE);
    } catch (err) {
      // No log yet: nothing has run, which is an answer. Anything else is "could not be read".
      return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { key: 'absent', facts: [] } : undefined;
    }
    if (ranAsLog !== undefined && ranAsLog.key === taskLogKey(seen)) {
      return ranAsLog;
    }
    fd = fs.openSync(TASKS_LOG_FILE, TASK_LOG_OPEN_FLAGS);
    // The descriptor, not the name: what is measured is what is read.
    const st = fs.fstatSync(fd);
    if (!st.isFile() || !Number.isFinite(st.size) || st.size < 0 || st.size > TASK_LOG_READ_MAX_BYTES) {
      return undefined;
    }
    // Per task id: the facts of its final event when that event can answer, null when it cannot.
    // Re-inserted on every event of the id, so the map's order is the order of FINAL events.
    const finals = new Map<string, FinalTaskFacts | null>();
    // The few distinct strings these fields hold, shared: a log of a hundred thousand tasks
    // names a handful of workers and models.
    const shared = new Map<string, string>();
    const kept = (value: unknown): unknown => {
      if (typeof value !== 'string') {
        // Nothing but a string or "absent" means anything to the rule; one stand-in for the rest.
        return value === undefined || value === null ? undefined : false;
      }
      const known = shared.get(value);
      if (known !== undefined) {
        return known;
      }
      if (shared.size < 4096) {
        shared.set(value, value);
      }
      return value;
    };
    const take = (line: string): void => {
      if (line.length < 2) {
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return; // a torn or hand-edited line: skipped, the rest of the log is kept
      }
      if (!isCountedTaskEvent(event)) {
        return;
      }
      const e = event as Record<string, unknown>;
      const id = e.id as string;
      finals.delete(id);
      finals.set(
        id,
        e.status === 'done' && typeof e.modelUsed === 'string' && REPORTED_MODEL_ID.test(e.modelUsed)
          ? {
              status: 'done',
              worker: kept(e.worker),
              provider: kept(e.provider),
              model: kept(e.model),
              modelSource: kept(e.modelSource),
              modelUsed: kept(e.modelUsed),
            }
          : null,
      );
    };
    // A line is cut out of the chunk it ends in; the pieces of one that spans chunks are held
    // apart until its end arrives, so a long line is never re-scanned from its start.
    const decoder = new StringDecoder('utf8');
    let pieces: string[] = [];
    const feed = (text: string): void => {
      let from = 0;
      for (;;) {
        const nl = text.indexOf('\n', from);
        if (nl === -1) {
          if (from < text.length) {
            pieces.push(text.slice(from));
          }
          return;
        }
        const tail = text.slice(from, nl);
        if (pieces.length === 0) {
          take(tail);
        } else {
          pieces.push(tail);
          take(pieces.join(''));
          pieces = [];
        }
        from = nl + 1;
      }
    };
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(TASK_LOG_CHUNK_BYTES, st.size)));
    let position = 0;
    while (position < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - position), position);
      if (n <= 0) {
        // Shorter than it said it was: it changed while it was read. Nothing is concluded from
        // half of it, and nothing is cached; the next call reads the file as it is then.
        return undefined;
      }
      position += n;
      feed(decoder.write(buf.subarray(0, n)));
    }
    feed(decoder.end());
    if (pieces.length > 0) {
      take(pieces.join(''));
    }
    // The newest final event of each distinct (worker, CLI, model, source), newest first.
    const newest = new Map<string, FinalTaskFacts>();
    for (const facts of finals.values()) {
      if (facts === null) {
        continue;
      }
      const tuple = JSON.stringify([facts.worker, facts.provider, facts.model, facts.modelSource]);
      newest.delete(tuple);
      newest.set(tuple, facts);
    }
    ranAsLog = { key: taskLogKey(st), facts: [...newest.values()].reverse() };
    return ranAsLog;
  } catch {
    return undefined;
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing was written through it
      }
    }
  }
}

/**
 * For each worker, the model id its DEFAULT last RAN AS — from the task log. What list_workers
 * prints after the default, so an orchestrator (and the operator reading over its shoulder) can
 * see what an alias resolves to on that account's CLI, and that the default is applied at all.
 *
 * THE RULE IS NOT WRITTEN HERE. ranAs.ranAsOf is the one statement of it — which task counts
 * for which account — and the dashboard, the Worker Accounts tree and the model pickers ask the
 * same function, so the two sides cannot answer differently. This function only supplies what
 * the rule is asked about: each task's final event, newest first (finalRanAsFacts), and each
 * account as the registry has it — its name, its CLI and its stored default.
 *
 * A log that could not be read answers with nothing: this is one remark on a line, never a
 * reason to fail the listing. Does not throw.
 */
function defaultModelRanAs(workers: readonly WorkerProfile[]): Map<string, string> {
  try {
    if (workers.length === 0) {
      return new Map();
    }
    const log = finalRanAsFacts();
    if (log === undefined || log.facts.length === 0) {
      // Unreadable, or nothing in it that can answer: nothing extra is shown.
      return new Map();
    }
    const accounts = workers.map((w) => ({
      name: w.name,
      provider: workerProvider(w),
      defaultModel: w.model,
    }));
    const signature = JSON.stringify(accounts);
    if (ranAsAnswers !== undefined && ranAsAnswers.key === log.key && ranAsAnswers.accounts === signature) {
      return ranAsAnswers.answers;
    }
    const answers = new Map<string, string>();
    for (const account of accounts) {
      for (const task of log.facts) {
        const ran = ranAsOf(task, account);
        if (ran !== undefined) {
          answers.set(account.name, ran);
          break;
        }
      }
    }
    ranAsAnswers = { key: log.key, accounts: signature, answers };
    return answers;
  } catch {
    return new Map();
  }
}

/** How many registry entries this version cannot use list_workers names before it counts the rest. */
const LIST_MAX_UNSUPPORTED = 20;

/**
 * What list_workers ends with: one line for each registry entry this version cannot use
 * (registry.UnsupportedWorkerEntry — an unknown provider, an incomplete entry, a repeated
 * name), and one line when dispatches are waiting for a slot of the dispatch gate. '' when
 * there is neither.
 *
 * Such an entry is in no list of workers, by design, so without its line here an orchestrator
 * that is refused a dispatch naming it would find nothing in this report to explain why. The
 * reason is worded by the function the refusal itself uses.
 */
function listWorkersTail(registry: Registry): string {
  const lines: string[] = [];
  const unsupported = registry.unsupportedWorkers ?? [];
  for (const entry of unsupported.slice(0, LIST_MAX_UNSUPPORTED)) {
    // The name is whatever the file holds: one bounded line of it, like every echoed value.
    const name = echoed(typeof entry.name === 'string' ? entry.name : '') || '(unnamed entry)';
    lines.push(`Not usable by this version: ${name} (${unsupportedWorkerReason(entry)})`);
  }
  if (unsupported.length > LIST_MAX_UNSUPPORTED) {
    lines.push(
      `… and ${unsupported.length - LIST_MAX_UNSUPPORTED} more registry entries this version cannot use`,
    );
  }
  const waiting = dispatchGateStats().waiting;
  if (waiting > 0) {
    lines.push(
      `${waiting} ${waiting === 1 ? 'dispatch is' : 'dispatches are'} waiting for a free slot ` +
        `(limit ${sanitizeDispatchConcurrency(registry.maxConcurrentDispatches)})`,
    );
  }
  return lines.length === 0 ? '' : `\n\n${lines.join('\n')}`;
}

/** A Claude Code account list_workers shows: main, or a worker (`worker` is then that profile). */
interface ShownClaudeAccount {
  name: string;
  configDir: string;
  key: string | undefined;
  worker?: WorkerProfile;
}

/** A cached reading's `accountKey` (contract §14.1) BY VALUE: 16 lower-case hex digits, else unknown. */
const CACHED_ACCOUNT_KEY = /^[0-9a-f]{16}$/;
/** Longest label of a cached `/model` menu entry that is shown, and how many entries are looked at. */
const CACHED_MODEL_LABEL_MAX_CHARS = 60;
const CACHED_MODELS_SCAN_MAX = 64;

/** The `accountKey` the usage cache holds for one Claude Code account, when it holds a usable one. */
function cachedAccountKey(reading: unknown): string | undefined {
  const key: unknown =
    typeof reading === 'object' && reading !== null ? (reading as { accountKey?: unknown }).accountKey : undefined;
  return typeof key === 'string' && CACHED_ACCOUNT_KEY.test(key) ? key : undefined;
}

/**
 * What this account's CLI says its tier aliases are, from the `/model` menu the usage cache
 * holds for it (`models`, contract §14.1) — `opus = Opus 5.5 · sonnet = Sonnet 5.5 · …`, in the
 * order the pickers list the aliases — or undefined when the cache holds no such menu.
 *
 * Every entry is checked by value, as a field another process wrote: an alias the menu does not
 * name is left out, and so is one whose label is not one clean line of at most
 * CACHED_MODEL_LABEL_MAX_CHARS — it is left out, never repaired into something the CLI did not say.
 */
function cachedAliasMeanings(reading: unknown): string | undefined {
  const models: unknown =
    typeof reading === 'object' && reading !== null ? (reading as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) {
    return undefined;
  }
  const aliases: readonly string[] = WORKER_MODELS;
  const names = new Map<string, string>();
  for (const entry of models.slice(0, CACHED_MODELS_SCAN_MAX)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const { value, label } = entry as { value?: unknown; label?: unknown };
    if (typeof value !== 'string' || !aliases.includes(value) || names.has(value)) {
      continue;
    }
    if (
      typeof label === 'string' &&
      label !== '' &&
      label.length <= CACHED_MODEL_LABEL_MAX_CHARS &&
      flattenOneLine(label) === label
    ) {
      names.set(value, label);
    }
  }
  const parts = aliases.filter((alias) => names.has(alias)).map((alias) => `${alias} = ${names.get(alias)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The line saying a Claude Code account is the SAME claude.ai account as others list_workers
 * shows (main included) — by the `accountKey` the usage cache holds for each, so two config
 * directories logged in to one account share one plan's limits — or '' when it is not, or when
 * its key is unknown. An account is never compared with one of the same directory: that is one
 * account, not two. Information only: nothing about selection changes.
 */
function sameAccountLine(
  self: ShownClaudeAccount | undefined,
  accounts: readonly ShownClaudeAccount[],
): string {
  if (self === undefined || self.key === undefined) {
    return '';
  }
  const others = accounts
    .filter((other) => other !== self && other.key === self.key && other.configDir !== self.configDir)
    .map((other) => other.name);
  if (others.length === 0) {
    return '';
  }
  return (
    `\n  ⚠ same claude.ai account as ${others.join(', ')} — ` +
    `${others.length === 1 ? 'both draw' : 'all of them draw'} on one plan's limits`
  );
}

/** The aliases line of one Claude Code account's block, or ''. */
function aliasesLine(reading: unknown): string {
  const meanings = cachedAliasMeanings(reading);
  return meanings === undefined ? '' : `\n  aliases on this CLI: ${meanings}`;
}

/** A successful list_workers answer: the text, and the same facts as data (host-protocol WorkersSnapshot). */
interface WorkersAnswer {
  text: string;
  /**
   * Undefined only when the dashboard's builder found no truthful answer at the same moment (its
   * own read of the registry failed between this call's read and its, or a defect in it): the
   * text is then answered alone — absent means "no snapshot", never an empty one.
   */
  structuredContent: WorkersSnapshot | undefined;
}

/**
 * list_workers. The text is exactly what it always was (listWorkersText); the snapshot is built
 * right after it, with no await in between, by the dashboard's own builder
 * (uiModel.buildAccountsSnapshot) from the files the refreshes above just wrote — so text and data
 * describe one moment. The cooldowns this server holds in memory (a cooldown it could not write
 * to stats.json, task-runner.workerCooldownUntil) are handed to the builder, so the snapshot
 * shows what the text shows. Throws the registry refusal, as before: an unreadable registry is an
 * isError text answer and has no snapshot.
 *
 * `generation` is the generation (workersGeneration) the answer was built at, for the observer
 * cache: read once the refreshes have settled and BEFORE any file the answer is built from — so a
 * change after it can only make the answer newer than its generation (the next call then builds
 * once more), never older. The one reading taken before the refreshes is the registry's, which the
 * text is built from: when the registry changed during the refreshes, `generation` is undefined
 * and the cache does not believe the answer.
 */
/**
 * list_workers' two switches: `check` re-probes every Claude Code account live before the answer
 * (usage.checkAllClaudeLoginsNow — side by side, at most LOGIN_CHECK_ROUND_MS); `diagnostics`
 * appends one line per Claude Code account with its last login probes (Login state (CA)).
 */
interface ListWorkersOptions {
  check: boolean;
  diagnostics: boolean;
}

async function listWorkers(
  opts: ListWorkersOptions = { check: false, diagnostics: false },
): Promise<WorkersAnswer & { generation: string | undefined }> {
  const registryBefore = registryFingerprint();
  // A registry that could not be read lists nothing — and PROBES nothing: which executable a
  // usage probe runs is a setting in that same file, and the default registry such a read comes
  // with would answer "No worker accounts registered" for a file that may hold a dozen.
  const { registry, problem } = readRegistryChecked();
  const unreadable = registryProblemText(problem);
  if (unreadable !== undefined) {
    throw new Error(`${unreadable} No worker was listed and no account was probed.`);
  }
  if (opts.check) {
    // Before the refreshes below, which then find every Claude Code reading fresh and confirmed.
    await checkAllClaudeLoginsNow(listAccounts());
  }
  // Side by side: the two refreshes cover disjoint accounts, and list_workers awaits both.
  await Promise.all([refreshUsageIfStale(), refreshProviderWorkersIfStale(registry)]);
  const current = workersGeneration();
  const generation = current.registry === registryBefore ? current.key : undefined;
  // From here to the answer, no await: the text and the snapshot read the files at one moment.
  const text = listWorkersText(registry) + (opts.diagnostics ? loginDiagnosticsText(registry) : '');
  const generatedAt = Date.now();
  const stats = readStats();
  const built = buildAccountsSnapshot(generatedAt, (name) => workerCooldownUntil(stats, name));
  if (built === undefined) {
    return { text, structuredContent: undefined, generation };
  }
  return {
    text,
    structuredContent: {
      schema: WORKERS_SNAPSHOT_SCHEMA,
      generatedAt,
      accounts: built.accounts.map((account) => homeRedacted(account)),
      unsupportedAccounts: built.unsupportedAccounts.map((entry) => homeRedacted(entry)),
      servedFromCache: false,
      // The same defensive read as the dispatch path and the text: only the literal 'allow' is consent.
      guards: {
        overageWorkerDispatch: registry.overageWorkerDispatch === 'allow' ? 'allow' : 'block',
        frontierWorkerDispatch: registry.frontierWorkerDispatch === 'allow' ? 'allow' : 'block',
      },
    },
    generation,
  };
}

/** Longest registry.json registryFingerprint hashes (the registry's own reader refuses a larger one). */
const GENERATION_REGISTRY_MAX_BYTES = 1024 * 1024;

/**
 * registry.json as workersGeneration keys it: a hash of its bytes — its content, not its stat, so
 * two writes in one clock tick are two values and a `touch` is none — or why it could not be read.
 * A bounded, non-blocking read (safeFs). Never throws.
 */
function registryFingerprint(): string {
  const read = readTextSafe(REGISTRY_FILE, GENERATION_REGISTRY_MAX_BYTES);
  return read.ok ? createHash('sha256').update(read.text).digest('hex') : `unread:${read.reason}`;
}

/**
 * What list_workers' observer cache is keyed on (host-protocol, list_workers' RULES: "keyed on a
 * generation counter") — `key` changes when an answer built now could differ in what a reader acts
 * on:
 *
 *  - THE REGISTRY (`registry`, registryFingerprint): a worker added, removed or edited, a guard
 *    changed, an entry this version cannot use;
 *  - THE COOLDOWNS: each registered worker's cooldown end as selection reads it (stats.json and
 *    this server's memory, task-runner.workerCooldownUntil), or 0 once it has passed — a cooldown
 *    set, cleared or run out;
 *  - THE LOGINS: every account's login state and detail as the snapshot shows it
 *    (uiModel.accountsLoginSignature).
 *
 * A value, not a counter: a counter would have to be bumped by every writer of those files, and
 * most of them are other processes (the extension, another session's server, a detached task).
 * Read per observer call: bounded reads of registry.json and stats.json and a stat of the usage
 * cache — far cheaper than a build, and nothing is probed. Residual: an account's counts and token
 * totals (stats.json's other fields, the task log) are not in it — they change with every finished
 * task and decide nothing a reader acts on; they are at most the floor old. Never throws.
 */
function workersGeneration(): { registry: string; key: string } {
  const registryPart = registryFingerprint();
  try {
    const now = Date.now();
    const { registry } = readRegistryChecked();
    const stats = readStats();
    const cooldowns = registry.workers.map((w) => {
      const until = workerCooldownUntil(stats, w.name);
      return until > now ? until : 0;
    });
    return { registry: registryPart, key: JSON.stringify([registryPart, cooldowns, accountsLoginSignature(now)]) };
  } catch {
    // Unreachable for readers that are documented never to throw; a key no other call has means
    // "changed", so the cache is never believed on a reading that could not be made.
    return { registry: registryPart, key: `failed:${Date.now()}:${Math.random()}` };
  }
}

/**
 * The home directory as the snapshot's free text may hold it — os.homedir(), and its realpath
 * when that differs (a home under a linked directory) — longest first, so the realpath of a home
 * whose spelling is a suffix of it is replaced whole. Read on every call: HOME is the process's.
 */
function homeSpellings(): string[] {
  const out: string[] = [];
  for (const read of [() => os.homedir(), () => fs.realpathSync(os.homedir())]) {
    try {
      const home = read().replace(/[/\\]+$/, '');
      // A home of '' or '/' would turn every path into "~…": no redaction rather than a wrong one.
      if (home !== '' && !out.includes(home)) {
        out.push(home);
      }
    } catch {
      // an unreadable spelling is one fewer to replace
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * A copy of `value` with the user's home directory replaced by `~` in every string in it (the
 * snapshot only — host-protocol RULES: a front end's screenshot must not carry the user's name;
 * the dashboard's model is unchanged). A spelling is replaced only as a whole path segment run:
 * not inside a longer name (`/Users/bob` in `/Users/bobby`), not as the tail of another path.
 *
 * The builder caps its strings BEFORE this sees them, so a home path can arrive cut in the middle
 * at a string's end (`… see /Users/bo`): a tail that is the start of a home spelling (two
 * characters or more, standing as a path of its own) is replaced by `~` too. Residual: such a
 * tail that merely LOOKS like the start of the home (`/U` at the very end) is shown as `~`.
 *
 * The result is never longer than the input, so every cap of UiAccount still holds. The keys are
 * opaque hashes, never paths, and pass through untouched in practice.
 */
function homeRedacted<T>(value: T): T {
  const homes = homeSpellings();
  const boundaryBefore = (text: string, at: number): boolean => at === 0 || !/[A-Za-z0-9._/\\-]/.test(text[at - 1]);
  const patterns = homes.map(
    (home) => new RegExp(`(?<![A-Za-z0-9._/\\\\-])${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g'),
  );
  const redact = (text: string): string => {
    let out = patterns.reduce((acc, re) => acc.replace(re, '~'), text);
    for (const home of homes) {
      for (let k = Math.min(home.length - 1, out.length); k >= 2; k--) {
        if (out.endsWith(home.slice(0, k)) && boundaryBefore(out, out.length - k)) {
          out = `${out.slice(0, out.length - k)}~`;
          break;
        }
      }
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return redact(v);
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        // defineProperty: a `__proto__` key would otherwise set the copy's prototype.
        Object.defineProperty(out, k, { value: walk(inner), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * list_workers as a tools/call gets it: on stdio, a fresh answer every time, as always; through the
 * HOST, the poll floor (host-protocol, list_workers' RULES — "THE HOST ENFORCES THE POLL FLOOR"),
 * keyed on the ROLE of the connection the call came from, as host.ts hands it (HostRequestContext):
 *
 *  - an OBSERVER call within WORKERS_SNAPSHOT_MIN_POLL_MS of the last COMPLETED answer gets that
 *    answer again — text and snapshot with its original `generatedAt`, `servedFromCache: true` —
 *    and starts nothing, as long as the generation that answer was built at (workersGeneration) is
 *    still the generation now: a worker added or removed, a login or a cooldown changed, is one
 *    fresh build at once;
 *  - a SESSION call (the lead model, choosing a worker) is NEVER answered from that cache: a stale
 *    cooldown or login would mislead its choice. Its fresh answer becomes the cache;
 *  - a call while an answer is being built awaits that one, whatever its role — twenty front ends
 *    and the lead asking at once build one answer, and start at most one probe per account. That
 *    is no stale answer for a session: the build reads every file AFTER its refreshes settle, with
 *    no await between those reads and its answer, so it reads them after the call that joined it
 *    arrived;
 *  - a refusal (the registry unreadable) is never remembered: the next call reads again.
 *
 * A call whose role is unknown (none handed — stdio has none) is a session's: the floor only ever
 * holds back a caller host.ts said is an observer.
 */
async function listWorkersFloored(
  role: HostRequestContext['role'] | undefined,
  opts: ListWorkersOptions = { check: false, diagnostics: false },
): Promise<WorkersAnswer> {
  // `--check` and `--diagnostics` ask for something no cached or shared answer holds: built for
  // this call alone, never served from the cache and never kept as it.
  if (hostTransport === undefined || opts.check || opts.diagnostics) {
    return listWorkers(opts).then(({ generation, ...answer }) => {
      void generation;
      return answer;
    });
  }
  const last = workersAnswered;
  if (role === 'observer' && last !== undefined && last.generation !== undefined && last.answer.structuredContent !== undefined) {
    const age = Date.now() - last.at;
    // A clock stepped back reads as a stale answer, never as one that is fresh for longer.
    if (age >= 0 && age < WORKERS_SNAPSHOT_MIN_POLL_MS && workersGeneration().key === last.generation) {
      return { text: last.answer.text, structuredContent: { ...last.answer.structuredContent, servedFromCache: true } };
    }
  }
  if (workersInFlight === undefined) {
    workersInFlight = listWorkers()
      .then(({ generation, ...answer }) => {
        workersAnswered = { at: Date.now(), generation, answer };
        return answer;
      })
      .finally(() => {
        workersInFlight = undefined;
      });
  }
  return workersInFlight;
}

/**
 * The host's last completed list_workers answer, when it completed, and the generation it was
 * built at (undefined: something changed during its build — it is never served from the cache).
 */
let workersAnswered: { at: number; generation: string | undefined; answer: WorkersAnswer } | undefined;
/** The host's list_workers answer being built (listWorkersFloored), or undefined. */
let workersInFlight: Promise<WorkersAnswer> | undefined;

/**
 * `list_workers --diagnostics`: one line per Claude Code account (main, then the Claude Code
 * workers in registry order, one line per directory) with its login state and its last probes —
 * enough to answer a support question about a login. No address, token or keychain value is in
 * it (usage.loginDiagnosticsLine); directories are not printed.
 */
function loginDiagnosticsText(registry: Registry): string {
  const cache = readUsageCache();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const account of [...listAccounts().filter((a) => a.name === 'main'), ...claudeWorkers(registry)]) {
    const dir = path.resolve(account.configDir);
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    lines.push(`- ${loginDiagnosticsLine(account.name, ownEntry(cache, account.configDir) as AccountUsage | undefined)}`);
  }
  return (
    '\n\nLogin diagnostics (Claude Code accounts; state, then the last probes, newest first — time, ' +
    'how CLAUDE_CONFIG_DIR was given to the CLI, what answered, the result and why):\n' +
    lines.join('\n')
  );
}

/** list_workers' text, for a registry that was read, once the refreshes have settled (listWorkers). */
function listWorkersText(registry: Registry): string {
  // After the refreshes, so the count of waiting dispatches is the one at the time of the answer.
  const tail = listWorkersTail(registry);
  // listAccounts() is 'main' + every distinct worker config dir. Workers sharing
  // the main config dir read the same 'main' entry, which is the right answer.
  const main = listAccounts().find((a) => a.name === 'main');
  // Each worker's OWN cached reading, read once and used for everything below that says
  // something about a worker — its status, its usage line, the logged-out footer. Through the
  // ownership-aware accessor, never by directory: a worker on another vendor's CLI registered
  // on a Claude Code account's directory would otherwise be shown that account's plan windows
  // and login state as its own.
  const readings = new Map(registry.workers.map((w) => [w, getCachedWorkerUsage(w)] as const));
  const mainReading = main ? getCachedUsage(main.configDir) : undefined;
  // The Claude Code accounts this answer shows, each with the account key its reading holds.
  const claudeAccounts: ShownClaudeAccount[] = [
    ...(main ? [{ name: 'main', configDir: main.configDir, key: cachedAccountKey(mainReading) }] : []),
    ...claudeWorkers(registry).map((w) => ({ name: w.name, configDir: w.configDir, key: cachedAccountKey(readings.get(w)), worker: w })),
  ];
  const mainBlock = main
    ? `main (this session)\n  ${usageLine(mainReading, main.configDir)}` +
      sameAccountLine(claudeAccounts[0], claudeAccounts) +
      aliasesLine(mainReading)
    : '';
  // Claude Code accounts only: overage billing is a state of a claude.ai plan, and no other
  // vendor's account has a reading of it.
  const overageDirs = [
    ...(main ? [main.configDir] : []),
    ...claudeWorkers(registry).map((w) => w.configDir),
  ];
  const anyOverageEnabled = overageDirs.some((dir) => overageEnabled(getCachedUsage(dir)));
  // Same defensive read as the dispatch path: only the literal 'allow' is consent.
  // Overage billing being ON at the ACCOUNT means nothing if the operator's guard
  // blocks it here — saying "dispatching past a plan window bills money" in that
  // state would misreport this server's actual spending behavior.
  const overageAllowed = registry.overageWorkerDispatch === 'allow';
  const moneyFooter = !anyOverageEnabled
    ? ''
    : overageAllowed
      ? "\n\nOverage billing is ENABLED on one or more accounts: dispatching past a plan window bills money against that account's monthly cap instead of being blocked. Prefer accounts with headroom, and treat a window near 100% as a spend risk, not just a wait. Overage dispatch is ALLOWED by the operator — an exhausted worker may be auto-selected as a last resort and bill real money."
      : '\n\nOverage billing is enabled on one or more accounts, but overage dispatch is BLOCKED by the operator ("claudeCodeOrchestrator.overageWorkerDispatch") — dispatches never spend extra credit past a plan window; exhausted workers are refused/skipped instead.';
  if (registry.workers.length === 0) {
    return (
      ['No worker accounts registered.', mainBlock].filter(Boolean).join('\n\n') + moneyFooter + tail
    );
  }
  const stats = readStats();
  const now = Date.now();
  const guard =
    registry.frontierWorkerDispatch !== 'allow'
      ? '\n\nFrontier worker dispatch (the fable tier) is DISABLED by the operator (billing guard) — ' +
        'for design consults and adversarial reviews use opus with ultrathink: true instead.'
      : '';
  // Which CLI a worker runs on is said on its line ONLY when the registry holds a worker on
  // another vendor's: that is when the distinction means something (such a worker is opt-in and
  // its `model` is that vendor's). A registry of Claude Code accounts alone prints exactly the
  // lines it always did.
  const otherVendorWorkers = registry.workers.filter((w) => workerProvider(w) !== 'claude');
  const showProvider = otherVendorWorkers.length > 0;
  const ranAs = defaultModelRanAs(registry.workers);
  const workerBlocks = registry.workers.map((w) => {
    // By OWN entry (task-runner.ownEntry): for a worker named `constructor` or `__proto__` a
    // plain `stats[w.name]` is a built-in, not that worker's counters.
    const s = ownEntry(stats, w.name);
    // What stats.json holds, or a cooldown this server could not write there — the same answer
    // selection acts on (task-runner.workerCooldownUntil).
    const cooldownUntil = workerCooldownUntil(stats, w.name);
    const info = providerInfo(workerProvider(w));
    const otherVendor = info.id !== 'claude';
    const defaultModel = w.model !== '' ? w.model : `none (the ${info.cli} CLI's own default)`;
    const label = showProvider ? ` [${info.label}]` : '';
    // What that default last ran as, when a finished task of this worker reported it.
    const lastRan = ranAs.get(w.name);
    let line =
      `- ${w.name}${w.preferred ? ' ★preferred' : ''}${label}: default model ${defaultModel}` +
      (lastRan !== undefined ? ` (last ran as ${lastRan})` : '');
    if (s && s.tasks + s.errors > 0) {
      line +=
        ` — ${counted(s.tasks, 'task')} done, ${counted(s.errors, 'error')}, ` +
        `${compactCount(s.inputTokens)} in / ${compactCount(s.outputTokens)} out tokens`;
      if (s.costUsd) {
        line += ` (~$${s.costUsd.toFixed(2)})`;
      }
    }
    const usageForWorker = readings.get(w);
    // A CLI that is not there outranks everything: nothing this worker is asked to do can
    // start. Then a logged-out account, which outranks cooldown as a status: cooldown expires
    // on its own, an expired login never does. Saying "available" here would be a lie.
    if (otherVendor && isProviderCliMissing(usageForWorker)) {
      line += ` — CLI NOT FOUND (${info.cli} is not installed or not on PATH)`;
    } else if (isLoginExpired(usageForWorker)) {
      line += ' — LOGGED OUT (re-login needed)';
    } else if (!otherVendor && isLoginSuspect(usageForWorker)) {
      line += ' — login not confirmed (re-checked live before use)';
    } else if (cooldownUntil > now) {
      line += ` — COOLING DOWN until ${new Date(cooldownUntil).toLocaleTimeString()} (quota error)`;
    } else {
      line += ' — available';
    }
    // Live-usage exhaustion marker. session/weekly_all block all automatic
    // assignment; a lone weekly_scoped (Fable) window only refuses the fable tier.
    const exhausted = exhaustedWindows(usageForWorker, now);
    const broad = exhausted.filter((win) => win.kind === 'session' || win.kind === 'weekly_all');
    // Only the Fable-only weekly window. Filter kind explicitly: an exhausted
    // window of any OTHER kind (possible only with corrupt cache data) is ignored
    // for display, exactly as pickWorker ignores it — never mislabel it 'Weekly Fable'.
    const scoped = exhausted.filter((win) => win.kind === 'weekly_scoped');
    let exhaustedLine = '';
    if (broad.length > 0) {
      // An exhausted worker with overage billing enabled is NOT skipped: it bills
      // money past the window and auto-assignment falls back to it when nothing
      // else is free — say so instead of "skips this worker". But only while the
      // operator's guard actually permits it: with the guard blocking, the account
      // setting is inert and this worker is refused/skipped exactly like the rest,
      // which is what the money footer says one screen below.
      const tail = !overageEnabled(usageForWorker)
        ? '— automatic assignment skips this worker'
        : overageAllowed
          ? '— overage billing is ON: dispatches will BILL real money instead of being blocked; ' +
            'auto-assignment uses it only when no non-exhausted worker is available'
          : '— overage billing is ON for this account, but overage dispatch is blocked by the ' +
            'operator — automatic assignment skips this worker and naming it is refused';
      exhaustedLine = `\n  ⛔ quota exhausted: ${broad.map(formatExhaustedWindow).join(' · ')} ${tail}`;
    } else if (scoped.length > 0 && !otherVendor) {
      // Claude Code only: that window is the fable tier's. Another vendor's third window gates
      // nothing here, and its own label is on the usage line.
      exhaustedLine = `\n  ⛔ Weekly Fable exhausted (resets ${formatRelativeReset(
        scoped[0].resetsAt,
      )}) — fable dispatches to this worker are refused`;
    }
    // The frontier guard, for this account's DEFAULT: while it blocks the tier, a dispatch that
    // names no model would run exactly that default here, so automatic assignment passes this
    // account over for such a dispatch (task-runner.pickWorker) — said on its line, because
    // " — available" alone would read as "takes anything".
    const frontierLine =
      !otherVendor && registry.frontierWorkerDispatch !== 'allow' && isFrontierModel(w.model)
        ? `\n  ⛔ default model ${w.model} is on the frontier tier, which the frontier guard blocks — ` +
          'dispatches that name no model skip this worker; one that names a model off that tier runs here'
        : '';
    if (!otherVendor) {
      const self = claudeAccounts.find((account) => account.worker === w);
      return (
        `${line}\n  ${usageLine(usageForWorker, w.configDir)}${sameAccountLine(self, claudeAccounts)}` +
        `${exhaustedLine}${frontierLine}${aliasesLine(usageForWorker)}`
      );
    }
    return (
      `${line}\n  ${providerUsageLine(w, usageForWorker)}${exhaustedLine}` +
      `\n  models: ${info.suggestedModels.join(', ')} (suggestions — any ${info.label} model id is accepted)`
    );
  });
  const vendorFooter =
    otherVendorWorkers.length > 0
      ? `\n\nWorkers on another vendor's CLI (${otherVendorWorkers
          .map((w) => `${w.name}: ${providerInfo(workerProvider(w)).label}`)
          .join(', ')}) are OPT-IN: a dispatch runs on one only when it names that "worker" or ` +
        `passes its "provider" (${PROVIDER_IDS.filter((id) => id !== 'claude').join(', ')}); every ` +
        'other dispatch goes to a Claude Code worker. They run one-shot, edit the working tree in ' +
        "place, and take their own vendor's model ids."
      : '';
  const loggedOutNames = registry.workers
    .filter((w) => isLoginExpired(readings.get(w)))
    .map((w) => w.name);
  const loginFooter =
    loggedOutNames.length > 0
      ? `\n\nLogged-out accounts (${loggedOutNames.join(', ')}) have an expired subscription OAuth ` +
        'session: automatic assignment skips them and naming one explicitly is refused, until the ' +
        `account is re-logged in (see the re-login command on each line above — ${RELOGIN_SHELL_CAVEAT}). ` +
        'Once you have re-logged in, just dispatch: the next dispatch re-checks the login live, so a ' +
        'recovered account becomes usable immediately without waiting for a usage refresh.'
      : '';
  return (
    [mainBlock, workerBlocks.join('\n')].filter(Boolean).join('\n\n') +
    guard +
    loginFooter +
    vendorFooter +
    moneyFooter +
    tail
  );
}

/* ------------------------------------------------------------------------- *
 * Mesh Mode (experimental) — ATTACHABLE DISPATCH. There is no separate mesh work
 * path: with mesh on, dispatch_task/dispatch_tasks spawn persistent `claude --bg`
 * session workers (mcp/bg-runner.ts) instead of one-shot `claude -p` children, each in
 * its own git worktree. The mesh_* tools cover only what neither dispatch nor the
 * platform does: seeing the workers this workspace holds across accounts (mesh_status)
 * and ending one (mesh_stop_worker).
 *
 * TALKING to a worker is not this server's job any more. A session worker is a peer
 * session, and the orchestrator messages it with its own native SendMessage; v1.x hosted
 * a relay gateway and three tools for that (send, receive, keep-alive), all removed when
 * the IDE session became a messaging peer itself.
 *
 * The runtime below is the substrate that is left: the pool (`claude --bg` lifecycle +
 * the ownership ledger) and the bridge, which mirrors workers' session entries into the
 * host account's registry so a worker under another account can be addressed by name.
 * The binding contract is .orchestrator/contract-2.0.md.
 * ------------------------------------------------------------------------- */

/**
 * Lazily-initialized mesh runtime for THIS server process — one mesh per workspace,
 * held behind the owner lock in the mesh state file. `ready` is THE initialized flag: it
 * is set only at the end of a fully successful ensureMesh(), so a partial failure (a CLI
 * too old, a lost lock race) leaves the runtime uninitialized and the next call retries
 * from scratch. `ownerLocked`/`state` let shutdown release the lock (rewrite ownerPid 0)
 * so a next session can take over instantly.
 */
interface MeshRuntime {
  /** The mesh is fully initialized — the dispatch precondition, together with `pool`. */
  ready: boolean;
  /**
   * The CONCRETE pool, not IWorkerPool — the one place in this file that needs more than the
   * frozen interface. `IWorkerPool.stop(name, {force})` can only name a target by NAME, and a
   * name matches any number of records because it is reused across generations; mesh_stop_worker
   * has to be able to say "this exact record" with the job id mesh_status prints, which is
   * `WorkerPool.stop`'s `by` option. Everything downstream (startBgLoops, BgRunContext) still
   * takes IWorkerPool and is unaffected — a WorkerPool is one.
   */
  pool?: WorkerPool;
  bridge?: IBridge;
  /** Stops the server-lifetime loop startBgLoops started (the stale-io sweep). */
  stopLoops?: () => void;
  /**
   * Our OWNER record — deliberately MeshOwnerFields and not MeshState: this process holds
   * no copy of the `workers` array, because it is not this process's to hold. The ledger is
   * read from disk at the moment it is needed (the pool, the reaper, mesh_status) and
   * written only through mesh/pool's locked mutators. An in-memory snapshot here is exactly
   * what the two removed whole-file writes used to put back over the extension host's edits.
   */
  state?: MeshOwnerFields;
  ownerLocked: boolean;
  /** Path of the atomic claim marker (M1) we created; used by stopMesh to release it. */
  lockFile?: string;
  /**
   * The claude executable resolved at init. Kept so shutdown can run `claude stop` for
   * the workers this process owns (P4.9) WITHOUT re-resolving — resolveProbeCommand may
   * spawn a login shell, which is not something to do from a signal handler.
   */
  claudePath?: string;
}
const mesh: MeshRuntime = { ready: false, ownerLocked: false };
/** Single in-flight init latch: concurrent first callers await the same ensureMesh(). */
let meshInit: Promise<void> | undefined;

/** Ceiling for the one `claude --version` run of the version gate. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** After a FAILED version gate, the earliest the CLI is asked again. */
const VERSION_REPROBE_MS = 60_000;
/**
 * The version gate's verdict for this server process. A SUCCESS is kept for the life of the
 * process — the CLI under a running session does not get older. A failure is kept with its
 * time and message, so the dispatches that follow (each of which re-enters ensureMesh, since
 * a failed init is retried) cost one spawn a minute between them rather than one each.
 */
let versionGate: { ok: true } | { ok: false; at: number; error: string } | undefined;

/**
 * Refuse to bring the mesh up on a Claude Code older than the one session workers were
 * verified on (platform.MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS), or on one whose version
 * cannot be read at all — a capability that cannot be proven is not assumed.
 *
 * Runs before the owner lock is touched, so a CLI that fails the gate leaves no claim behind.
 * Throwing `capability_failed` is what routes every dispatch to the one-shot fallback with its
 * `⚠ mesh unavailable` prefix; the first line of the message is what that prefix quotes, so it
 * names both the version found and the minimum.
 */
async function ensureSessionWorkerVersion(claudePath: string, cwd: string): Promise<void> {
  if (versionGate?.ok === true) {
    return;
  }
  if (versionGate !== undefined && Date.now() - versionGate.at < VERSION_REPROBE_MS) {
    throw new Error(versionGate.error);
  }
  const outcome = await runMeshProcess(
    claudePath,
    ['--version'],
    cwd,
    claudeEnv(hostConfigDir()),
    VERSION_PROBE_TIMEOUT_MS,
  );
  const ran = !outcome.timedOut && !outcome.spawnError && outcome.code === 0;
  if (ran && claudeVersionAtLeast(outcome.output, MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS)) {
    versionGate = { ok: true };
    return;
  }
  // What the CLI printed, when it printed anything: an old version is shown as it reported
  // itself, and so is output that carries no version at all — both are what the reader needs.
  const found = ran ? sliceOneLine(flattenOneLine(outcome.output), 40) || 'unknown' : 'unknown';
  const why = ran
    ? ''
    : outcome.timedOut
      ? ` (\`${oneLine(claudePath)} --version\` did not answer within ${VERSION_PROBE_TIMEOUT_MS / 1000}s)`
      : outcome.spawnError
        ? ` (\`${oneLine(claudePath)} --version\` could not be run)`
        : ` (\`${oneLine(claudePath)} --version\` exited with code ${outcome.code})`;
  const error = meshError(
    'capability_failed',
    `session workers need Claude Code ${MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS} or newer, and ` +
      `this CLI reports version ${found}${why} — update Claude Code to get attachable workers.`,
  );
  versionGate = { ok: false, at: Date.now(), error };
  throw new Error(error);
}

/**
 * Parse the mesh state file, or undefined if absent/unreadable/malformed. Read-only.
 *
 * The read goes through safeFs under the SAME cap mesh/pool and mesh/reaper already read this
 * file with. It is a file under the orchestrator root, which a worker with a shell can replace
 * with a FIFO or grow without bound; every other reader of it was moved off a blocking,
 * unbounded readFileSync and this one was left behind. Every failure still collapses to
 * `undefined`, exactly as before — the caller's contract is unchanged.
 *
 * Without following a link: every writer of this file puts a regular file there by rename, so a
 * symbolic link at its name is not the state file but a pointer to some other one.
 */
function readMeshState(file: string): MeshState | undefined {
  const read = readTextSafe(file, MESH_STATE_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(read.text) as MeshState;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ownerPid !== 'number') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/*
 * There is deliberately NO writeMeshState here any more (F1 completeness). This process
 * wrote the whole state object at two points — the owner claim at init and the release at
 * shutdown — and each of those re-serialized a `workers` array read moments earlier, which
 * silently put back a snapshot the extension host had already edited (a lost edit,
 * empirically, in two of three hammer runs). Both now go through mesh/pool's
 * mutateMeshOwnerFields: one write lock for the whole file, and a mutator that structurally
 * cannot reach `workers`.
 */

function dedupe(dirs: string[]): string[] {
  return [...new Set(dirs)];
}

/**
 * The bridge's participants: the HOST config dir first — it is the only mirror target, the
 * account whose registry the orchestrator session's own SendMessage reads — then every
 * worker account's dir. Strings are passed VERBATIM (the bridge canonicalizes its own copies).
 */
function bridgeParticipants(workerDirs: string[]): string[] {
  return dedupe([hostConfigDir(), ...workerDirs]);
}

/**
 * The owner marker for a workspace mesh: a dedicated file next to the
 * state file, keyed to the same workspace hash, holding the pid of the server that owns the
 * mesh for as long as that server's session lasts. Distinct from the state file so acquiring
 * the claim never races the state-file writes the extension UI reads.
 *
 * A REGULAR FILE, published whole: the owner writes its record to a temp file and hard-links
 * that to this name, so what is at the name is either a complete record or not a marker at all.
 */
function meshLockFile(cwd: string): string {
  return `${meshStateFile(cwd)}.lock`;
}

/**
 * The lock a server holds for the few milliseconds in which it JUDGES the owner marker and
 * REPLACES it (acquireMeshLock) — a registry.withPathLock path of its own beside the marker.
 * Not the marker (held for a whole session) and not the ledger's write lock
 * (`<state>.write.lock`). The three are only ever taken in one order — this lock, then the
 * marker, then (this lock released) the write lock — so they cannot deadlock.
 */
function meshClaimLockFile(lockFile: string): string {
  return `${lockFile}.claim`;
}

interface MeshLockRecord {
  ownerPid: number;
  /** Owner's process start marker — a sanity token against a recycled pid (M2). */
  startedAt: number;
}

/**
 * READ CAP for the owner marker. Its content is one JSON object of two numbers; 4 KiB is
 * three orders above that and still a file this process cannot be made to swallow.
 */
const MESH_LOCK_MAX_BYTES = 4 * 1024;

/** What is at the owner marker's name, as far as a claim or a release needs to know. */
type OwnerMarker =
  /** Nothing is there. */
  | { state: 'free' }
  /** A marker naming this process. */
  | { state: 'ours' }
  /** A marker naming another process that is running. */
  | { state: 'held'; pid: number }
  /** A marker whose owner is gone — or something at the name that is not a marker at all. */
  | { state: 'stale' }
  /** Something is there and it could not be read: nothing is known about who owns the mesh. */
  | { state: 'unknown'; why: string };

/**
 * Read and judge the owner marker. Never throws.
 *
 * safeFs, without following a link: this read sits in the CLAIM path, where a blocking open on a
 * planted FIFO would wedge the claim rather than fail it, and the marker is a regular file this
 * product publishes under a name it builds — a link there is a pointer to some other file.
 *
 * COULD NOT READ IS NOT STALE. A marker that is there and could not be read (the process is out
 * of file descriptors, the disk returned an error) may name a live owner; calling it stale would
 * hand this server the mesh of a session that is still running. That is `unknown`, and a claim
 * refuses on it. What IS stale besides a dead owner's marker: anything at the name that the
 * writer could not have put there — a directory, a pipe, a link, text that is not the record —
 * because a marker is published whole or not at all.
 */
function judgeOwnerMarker(lockFile: string): OwnerMarker {
  const read = readTextSafe(lockFile, MESH_LOCK_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    if (read.reason === 'absent') {
      return { state: 'free' };
    }
    return read.reason === 'unreadable' ? { state: 'unknown', why: read.detail } : { state: 'stale' };
  }
  let ownerPid: unknown;
  try {
    const parsed: unknown = JSON.parse(read.text);
    ownerPid =
      typeof parsed === 'object' && parsed !== null ? (parsed as { ownerPid?: unknown }).ownerPid : undefined;
  } catch {
    return { state: 'stale' };
  }
  if (typeof ownerPid !== 'number') {
    return { state: 'stale' };
  }
  if (ownerPid === process.pid) {
    return { state: 'ours' };
  }
  return isPidAlive(ownerPid) ? { state: 'held', pid: ownerPid } : { state: 'stale' };
}

/** The refusal of a claim whose marker names a running session. */
function meshOwnedByOther(pid: number): Error {
  return new Error(
    meshError('mesh_busy', `another orchestrator session owns the mesh for this workspace (pid ${pid}).`),
  );
}

/**
 * Claim the workspace mesh owner marker for this process, or throw the refusal.
 *
 * THE WHOLE CLAIM — read the marker, judge it, replace it — RUNS UNDER ONE LOCK
 * (registry.withPathLock at meshClaimLockFile). Judging a stale marker and then removing it BY
 * NAME is two steps, and between them the name can come to mean something else: two servers
 * starting over a dead owner's marker both read it, both judged it stale, the first removed it
 * and published its own — and the second then removed THAT, published its own, and both were
 * owners. Under the lock the second server's read comes after the first one's publish, and
 * finds a marker naming a live process.
 *
 * Inside the lock:
 *   - a marker naming this process: already ours (a retry after a later init step failed);
 *   - a marker naming another live process ⇒ mesh_busy;
 *   - a marker that could not be read ⇒ mesh_busy, saying so — never treated as stale;
 *   - nothing there, or a stale marker ⇒ what is there is removed and ours is published by
 *     write-temp-then-hardlink: the link is atomic, so the visible marker is never empty or
 *     half written, and it fails with EEXIST if a marker appeared after the removal — which a
 *     process that does not take this lock (a pre-2.0 server sharing the workspace) can still
 *     cause. That marker is judged in turn, once.
 *
 * A LOCK THAT COULD NOT BE TAKEN REFUSES THE CLAIM, with the lock's own message: it names the
 * process holding it and the file. withPathLock waits up to its deadline for a holder that is
 * alive, and this claim is rare — once per session — so the wait is paid here and nowhere else.
 *
 * Residual pid-reuse risk (adversarial finding M2): if a dead owner's pid was recycled by an
 * unrelated live process, isPidAlive() reports it alive and we would refuse a takeover that should
 * succeed. Node has no portable API to read another pid's real start time, so the recorded startedAt
 * is only a presence sanity token, not a full guard — this narrow window is documented rather than
 * closed. stopMesh writes ownerPid 0 AND drops this marker on clean shutdown, so the common path
 * (graceful restart) is reuse-proof; the window is confined to an owner that died without shutdown.
 */
function acquireMeshLock(lockFile: string): void {
  // The claim is the FIRST thing ever written under the mesh state directory, so on an
  // installation that has never run the mesh that directory does not exist yet — and both the
  // lock and the marker need it there (nothing else creates the directory before a claim).
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let published = false;
  try {
    withPathLock(meshClaimLockFile(lockFile), () => {
      published = claimOwnerMarker(lockFile);
    });
  } catch (err) {
    // A refusal raised inside the claim is already a mesh error, and the lock was released
    // behind it. Anything else is the lock's own: it could not be taken, or it was taken away
    // while the claim ran — in which case the claim was not exclusive, and a marker this call
    // published is withdrawn rather than left standing on a claim nobody can vouch for.
    const message = errorMessage(err);
    if (/^mesh error \[/.test(message)) {
      throw err;
    }
    if (published) {
      releaseMeshLock(lockFile);
    }
    throw new Error(
      meshError(
        'mesh_busy',
        `the mesh owner claim for this workspace could not be made: ${sliceOneLine(flattenOneLine(message), 1000)}`,
      ),
    );
  }
}

/**
 * acquireMeshLock's critical section — the caller holds the claim lock. Returns true when this
 * call published the marker, false when it was already this process's; throws the refusal.
 */
function claimOwnerMarker(lockFile: string): boolean {
  const record = JSON.stringify({ ownerPid: process.pid, startedAt: Date.now() });
  const tmp = `${lockFile}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const marker = judgeOwnerMarker(lockFile);
    if (marker.state === 'ours') {
      return false;
    }
    if (marker.state === 'held') {
      throw meshOwnedByOther(marker.pid);
    }
    if (marker.state === 'unknown') {
      throw new Error(
        meshError(
          'mesh_busy',
          `the mesh owner marker for this workspace could not be read (${marker.why}), so it is not ` +
            `known whether another session owns the mesh. The marker is ${oneLine(lockFile)}.`,
        ),
      );
    }
    if (marker.state === 'stale') {
      // Whatever is at the name — a dead owner's record, or a thing that is not a marker — goes.
      // `rmSync` removes a link itself, never what it points at.
      fs.rmSync(lockFile, { recursive: true, force: true });
    }
    // Exclusive create of the temp file: a name this process alone uses, cleared first, so what
    // is written is written to a new file and never through something left at that name.
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(tmp, record, { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(tmp, lockFile); // atomic publish; EEXIST if a marker is there
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(
          meshError(
            'capability_failed',
            `the mesh owner marker ${oneLine(lockFile)} could not be written ` +
              `(${errnoOf(err) ?? 'the link failed'}) — check that the mesh state directory is writable.`,
          ),
        );
      }
      // A marker appeared between the look and the link: judge that one, once.
    } finally {
      removeQuietly(tmp);
    }
  }
  throw new Error(
    meshError('mesh_busy', 'could not claim the mesh owner marker for this workspace (contended startup).'),
  );
}

/** Release the owner marker, but only if it still records OUR pid (never remove a peer's). */
function releaseMeshLock(lockFile: string): void {
  try {
    if (judgeOwnerMarker(lockFile).state === 'ours') {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // best effort — a marker left behind is judged stale by the next claim once we are gone
  }
}

/**
 * Initialize the mesh runtime on the FIRST mesh-on dispatch or mesh tool call, guarded by a
 * single in-flight promise so concurrent first callers await the same init. The master
 * switch is re-read on every call, before and after init (see the gate below).
 */
async function ensureMesh(): Promise<void> {
  // M5: re-check the master switch on EVERY call, even after init. The initialized
  // short-circuit below otherwise pins meshMode to its value at first init, so an
  // operator toggling meshMode off mid-session would leave the mesh tools — and now the
  // dispatch fork — running while only mesh_status reported OFF. Gate here so a
  // toggle-off takes effect immediately: mesh tools refuse. (dispatchTask reads meshMode
  // itself and simply runs the unchanged one-shot path when it is off — no ⚠ prefix,
  // because nothing was promised.) NOTE: this is a GATE only —
  // it does not tear down the already-running bridge/workers; a full mid-session
  // teardown on toggle-off is future work (session end still reaps every worker).
  // mesh_status keeps its own meshMode check and does not call ensureMesh while off, so
  // it still renders the static OFF text without hitting this throw.
  requireMeshOn();
  if (mesh.ready) {
    return;
  }
  if (!meshInit) {
    // A failed init clears the latch and rethrows, so the next call retries (a
    // transient mesh_busy, or a CLI that has since been updated, is recoverable).
    meshInit = doEnsureMesh().catch((err) => {
      meshInit = undefined;
      throw err;
    });
  }
  return meshInit;
}

/**
 * The registry, for a caller that needs Mesh Mode to be ON — or the refusal. Two different
 * refusals, because they are two different facts: the switch is off (`mesh_off`, with how to
 * turn it on), or the file the switch lives in could not be read, in which case nothing is
 * known about the switch and saying "enable it" would send the reader to change a setting that
 * may already be set.
 */
function requireMeshOn(): Registry {
  const { registry, problem } = readRegistryChecked();
  const unreadable = registryProblemText(problem);
  if (unreadable !== undefined) {
    throw new Error(
      meshError('capability_failed', `${unreadable} Whether Mesh Mode is on is a setting in that file.`),
    );
  }
  if (registry.meshMode !== 'on') {
    throw new Error(
      meshError('mesh_off', 'enable claudeCodeOrchestrator.meshMode (experimental) in the extension settings.'),
    );
  }
  return registry;
}

/** The ordered init steps. `mesh.ready` is set only on full success. */
async function doEnsureMesh(): Promise<void> {
  // a. master switch
  const registry = requireMeshOn();
  // b. platform (unix sockets only — mesh is a same-machine feature)
  if (!meshPlatformSupported()) {
    throw new Error(
      meshError('unsupported_platform', `mesh mode needs macOS or Linux; this platform is ${process.platform}.`),
    );
  }
  const cwd = process.cwd();
  // Resolve the claude executable exactly as dispatch does at spawn time (usage.ts's
  // resolveProbeCommand), so the mesh is independent of when the registry was last synced.
  const claudePath = resolveProbeCommand();

  // b². version gate — BEFORE the owner lock, so a CLI that cannot run session workers
  // leaves no claim behind. Throws capability_failed; see ensureSessionWorkerVersion.
  await ensureSessionWorkerVersion(claudePath, cwd);

  // c. owner lock: one mesh per workspace, claimed ATOMICALLY (adversarial finding M1).
  // The old read-liveness-then-write was a cross-process TOCTOU: two servers starting
  // together could both pass the liveness test and both init. The protocol is now:
  //   1. Fast reject — a live foreign owner already recorded ⇒ mesh_busy, no lock churn.
  //   2. acquireMeshLock — the owner marker is judged and replaced under a lock of its own,
  //      and published by an atomic hardlink, so of two servers starting together exactly one
  //      holds the marker; a stale marker from a dead/released owner is replaced inside there.
  //   3. Write our claim (ownerPid = us) through the ledger write lock, OWNER FIELDS ONLY,
  //      then RE-READ and confirm ownerPid === our pid before proceeding — a defensive
  //      backstop that also fails us out if the marker was wrongly broken. A dead owner's
  //      worker ledger is preserved so takeover re-adopts, and after F1 that preservation is
  //      structural: the claim write cannot address `workers` at all.
  const stateFile = meshStateFile(cwd);
  const lockFile = meshLockFile(cwd);
  const existing = readMeshState(stateFile);
  // M2: a live foreign ownerPid blocks only when the record carries a start marker
  // (startedAt present and positive). isPidAlive cannot distinguish the original owner from
  // an unrelated process that recycled its pid, so startedAt is a sanity token, not a full
  // pid-reuse guard; the residual window is documented on acquireMeshLock and is narrow —
  // stopMesh writes ownerPid 0 and drops the marker on clean shutdown, so the common path
  // (graceful restart) never reaches it.
  if (
    existing &&
    existing.ownerPid !== process.pid &&
    typeof existing.startedAt === 'number' &&
    existing.startedAt > 0 &&
    isPidAlive(existing.ownerPid)
  ) {
    throw new Error(
      meshError(
        'mesh_busy',
        `another orchestrator session owns the mesh for this workspace (pid ${existing.ownerPid}).`,
      ),
    );
  }
  acquireMeshLock(lockFile);
  // The claim is written through the LEDGER WRITE LOCK, and it writes the SERVER-owned
  // fields only (F1 completeness). The old code read the ledger here and wrote it back with
  // our claim attached — "re-read under the lock so a takeover cannot cost us a worker
  // record" — but the lock it ran under is the claim marker, which the extension host does
  // not take: a stopped mark written between that read and that write
  // was silently reverted. Not carrying `workers` at all is strictly stronger than
  // re-reading it: the array we never touch cannot be the one we lose.
  //
  // Lock ORDER, and it is the only one in this system: the claim marker (`<state>.lock`,
  // held for the whole session) is taken FIRST and the write lock (`<state>.write.lock`,
  // held for milliseconds) inside it. Nothing takes the claim marker while holding the
  // write lock, so the two can never deadlock. (The lock the marker was judged and published
  // under, `<state>.lock.claim`, comes before both and was released inside acquireMeshLock,
  // before this line: it is never held together with the write lock, and nothing that holds
  // the marker or the write lock ever takes it.)
  const state: MeshOwnerFields = {
    ownerPid: process.pid,
    cwd,
    startedAt: Date.now(),
  };
  let skipped: string | undefined;
  const claimed = mutateMeshOwnerFields(
    cwd,
    (owner) => {
      // Object.assign of a MeshOwnerFields-typed record: the owner fields, and nothing
      // else exists to assign.
      Object.assign(owner, state);
    },
    {
      onSkip: (reason) => {
        skipped = reason;
      },
    },
  );
  if (!claimed) {
    // The mutation was SKIPPED (its documented total behavior), so our claim never reached
    // disk: the reaper, mesh_status and the extension would not know this process owns the
    // workers it is about to spawn. Refuse the init, and say WHY distinctly from the lost-race
    // branch below — in the words of the write that was skipped, which knows which of its
    // causes it was: the ledger's write lock held by another process for the whole wait (its
    // message names that process), a state file that could not be read, or a write that could
    // not be vouched for. Guessing "the directory is not writable" sent the reader to the one
    // thing that was usually fine.
    releaseMeshLock(lockFile);
    throw new Error(
      meshError(
        'capability_failed',
        `could not record the mesh owner claim in ${oneLine(stateFile)}: ` +
          (skipped === undefined
            ? 'the write was skipped and gave no reason.'
            : sliceOneLine(flattenOneLine(skipped), 1000)),
      ),
    );
  }
  const confirmed = readMeshState(stateFile);
  if (!confirmed || confirmed.ownerPid !== process.pid) {
    releaseMeshLock(lockFile);
    throw new Error(
      meshError(
        'mesh_busy',
        `lost the mesh owner-lock race for this workspace (owner pid ${confirmed?.ownerPid ?? 'unknown'}).`,
      ),
    );
  }
  mesh.ownerLocked = true;
  mesh.lockFile = lockFile;
  mesh.state = state;
  mesh.claudePath = claudePath;

  // c². Orphan sweep BEFORE adopt (P5.3): a previous owner that died without a clean
  // shutdown may have left `--bg` workers running with nobody to stop them. Sweeping
  // first means adopt() re-claims only what is genuinely still ours to own. Best effort —
  // the mesh must still come up when the sweep cannot (a stale `claude stop` is not a
  // reason to refuse dispatch).
  let orphanTaskIds: string[] = [];
  try {
    const swept = await reapOrphanedMeshWorkers({ claudePath, cwd });
    orphanTaskIds = Array.isArray(swept?.orphanTaskIds) ? swept.orphanTaskIds : [];
  } catch {
    // orphans stay visible in mesh_status and are swept again on the next session start
  }

  // c³. Settle the tasks of the orphans that sweep just dealt with. Their dispatcher is gone,
  // so nothing records what became of them unless a reap runs — and what the sweep knows about
  // their workers (it stopped this one, that one was not in its account's listing) is only
  // believed for as long as its listing is (mesh/reaper, the liveness snapshot): left to the
  // first dispatch_status that happens to name one of them, a task whose worker was stopped
  // here would be reported `running` again once that time is up, until its own deadline.
  //
  // The same reconcile dispatch_status runs (dispatchStatus), over exactly those task ids and
  // nothing else — and not at all when the sweep met no orphan, which is every ordinary start.
  //
  // NOT INLINE. Each task it settles re-reads the task log several times, measured at about
  // 200 ms per task on a 20 MB log, so it runs after this init has returned: the mesh is
  // usable first, and the event loop pays for the settle on its next turn. Best effort like
  // the sweep itself — a throw is one line on stderr and never a failed init.
  if (orphanTaskIds.length > 0) {
    const ids = orphanTaskIds;
    setImmediate(() => {
      try {
        reapDeadTasks(ids, meshTaskAliveCheck(), meshTaskRecovery());
      } catch (err) {
        logMeshProblem(
          `the tasks of ${ids.length} orphaned session worker(s) could not be settled after the start-up sweep ` +
            `(${oneLine(err instanceof Error ? err.message : String(err))}); each is settled when dispatch_status is asked about it.`,
        );
      }
    });
  }

  // d. worker pool + one adopt() to re-claim any workers a previous owner left running.
  const pool = new WorkerPool({ claudePath, cwd: process.cwd(), mainConfigDir: hostConfigDir() });
  pool.adopt();

  // e. cross-account registry bridge. Session entries are discovered per config dir, and
  // workers run under other accounts than the orchestrator: mirroring their entries into the
  // HOST dir is what lets the orchestrator's own SendMessage address a worker by name. Nothing
  // is mirrored the other way — a worker replies to the `from` address of a message it got.
  //
  // CLAUDE CODE ACCOUNTS ONLY (registry.claudeWorkers). A participant is a directory whose
  // `sessions/` the bridge reads as a Claude session registry, and a worker on another vendor's
  // CLI has no such thing: a real `~/.codex` keeps a `sessions/` of its own, in its own format,
  // and a vendor home without one would be reported as an unreadable participant — a bridge
  // "degraded" by an account that could never have been a session worker.
  const bridge: IBridge = new Bridge({
    participants: bridgeParticipants(claudeWorkers(registry).map((w) => w.configDir)),
  });
  bridge.start();

  mesh.pool = pool;
  mesh.bridge = bridge;
  // The one server-lifetime loop left (the stale-io sweep). There is no idle auto-stop to
  // start, and no message consumer that has to exist before the first spawn: results are files.
  mesh.stopLoops = startBgLoops({ pool });
  // Set last: `ready` is exactly what "initialized" means.
  mesh.ready = true;
}

/** "3m" / "2h 5m" — an elapsed time, for mesh_status. */
function formatElapsed(sinceMs: number): string {
  if (!isFinite(sinceMs) || sinceMs < 0) {
    return 'unknown';
  }
  const minutes = Math.floor(sinceMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The same age, phrased for a sentence — "3m ago", but never "just now ago". */
function formatAgo(sinceMs: number): string {
  const age = formatElapsed(sinceMs);
  return age === 'just now' || age === 'unknown' ? age : `${age} ago`;
}

/* ------------------------------------------------------------------------- *
 * Unowned live workers — orphan/ghost visibility for mesh_status
 *
 * A `claude --bg` worker is NOT a child of the session that spawned it: it outlives its
 * owner. When an owner dies, its workers keep running with nobody tracking them, and the
 * only trace they leave is a ledger record whose `ownerPid` names a process that is gone.
 * Nothing surfaced that, so this section does. What it prints is what a human uses to decide
 * whether to kill a session, so a plausible-but-unproven claim here costs somebody their live
 * work: under-reporting is the safe direction and is chosen deliberately at every fork below.
 *
 * THIS SURFACE IS DESCRIPTIVE. It reports what was observed and what could NOT be observed. The
 * guarantee, stated as narrowly as the strings below actually keep it (M7): it never recommends
 * STOPPING a worker or otherwise destroying its work, and it never presents a destructive action
 * as the expected next step. It is not a no-imperative surface in the literal sense and never
 * was — `Attach and find out whose work it is first.` and the worktree line's `Merge or remove it
 * yourself.` are both imperatives, both non-destructive (attaching reads; the worktree note is
 * the workers list's own verbatim wording for unmerged work), and both stay. What is excluded is
 * the destructive recommendation, and that exclusion is a deliberate contract, not an omission,
 * with two independent reasons — either sufficient on its own:
 *  - EVERY defect this feature has had was one shape: a worker reported as an orphan or a ghost
 *    when it was not alive, or was not this workspace's, or was owned by this very session. A
 *    misclassification that is merely reported is a wrong line in a report; the same
 *    misclassification carrying a DESTRUCTIVE imperative is an instruction to destroy live work.
 *    Dropping that imperative removes the leverage the whole defect class needs, and it is the
 *    only mitigation that does not depend on the classification being right.
 *  - NO UNAMBIGUOUS ACTION CAN BE EXPRESSED HERE ANYWAY. mesh_stop_worker resolves its target BY
 *    NAME, and WorkerPool.stop() takes `find(r => r.name === name)` — first match wins — while
 *    worker names are REUSED across generations. Entries here are identified by jobId, so the
 *    name printed beside one can resolve to a DIFFERENT record. Recommending an action the tool
 *    cannot perform unambiguously is itself a defect.
 * Nothing factual is given up for this: every identifying field, every attach command, and every
 * statement of what the ledger can and cannot establish stays. What is gone is only the sentence
 * that told the reader to destroy something.
 *
 * AND IT PREDICTS NOTHING (H1, third round). Entries state what was OBSERVED at render time and
 * what the code they describe does; they never assert an outcome or a timeframe for it. This is
 * not style, it is the second defect class this section has had: two successive predictive
 * sentences about the v1.x idle sweep ("nothing is tracking it", then "it will be stopped
 * within a sweep tick") were both false, for reasons that were not visible from here. That
 * sweep is gone — no timer in this process stops a worker whose dispatch is over — and the
 * rule it taught stays: an entry says what was read and what the code does, never what will happen to
 * the record, and never when.
 *
 * WHAT "READ-ONLY" MEANS HERE, stated exactly — the loose version of this claim ("stops
 * nothing, adopts nothing and writes nothing") was FALSE and is not repeated. This section
 * stops nothing, adopts nothing, and never writes the mesh ledger. It does SPAWN
 * `claude agents --json`, and THAT CHILD WRITES TO THE CONFIG DIR IT IS POINTED AT. Not
 * "only when the dir is empty" — reproduced against a dir that already held a `.claude.json`:
 * the CLI REWROTE that file (2 bytes → 309, a full migrated config) and CREATED a `backups/`
 * directory beside it. The probe is not write-free and must never be described as one.
 *
 * So the safety of this feature does NOT come from the probe being harmless, and it cannot
 * come from validating the path either. `configDir` is read out of the mesh state file, which
 * any process on this machine can write, and the old "is this an initialized config dir?"
 * test — an absolute directory already holding a `.claude.json` — passed exactly the dirs
 * whose `.claude.json` the child then rewrote. On this machine `$HOME` itself passes it
 * (`~/.claude.json` exists), so a single ledger record naming `configDir: "/Users/<user>"`
 * aimed the CLI's config-migration/backup path at the user's real top-level config, on every
 * poll of a polled surface. Validating an untrusted path was the wrong shape of answer.
 *
 * THE RULE IS A CONFIGURED SOURCE, NOT A VALIDATED PATH. The set of probe targets is built from
 * THE REGISTRY — `registry.workers[].configDir` plus this session's own host config dir
 * (platform.hostConfigDir(), the same value doEnsureMesh hands the pool and the bridge) — i.e.
 * from dirs the operator configured for this installation, and only those of them that are
 * ABSOLUTE (L5: `path.resolve('~/.claude')` is `<workspace>/~/.claude`, so anchoring a relative
 * or `~`-prefixed registry value against this server's cwd would make the probe create
 * `.claude.json` and `backups/` inside the user's repo). A ledger record is probed ONLY when its
 * `configDir`, compared after path.resolve normalization on BOTH sides, is one of those.
 * Anything else is not probed and is named in the per-config-dir unchecked list with that as its
 * reason, so a record aiming at an unconfigured path costs one honest line and never a write.
 *
 * WHAT THAT GATE IS AND IS NOT WORTH (M6). The honest claim is narrow: it bounds the probe's
 * target set to accounts the OPERATOR configured, and it eliminates the class actually observed
 * — a stale or simply wrong ledger record naming a directory this installation never configured,
 * which under the old "is this an initialized config dir?" test reached `$HOME` itself. It is
 * NOT a security boundary against an attacker: the ledger
 * (`~/.claude-code-orchestrator/mesh/<hash>.json`) and the registry
 * (`~/.claude-code-orchestrator/registry.json`) are two files in ONE state tree, both created by
 * this extension with default ownership and mode and neither protected from the other, so anyone
 * who can forge the ledger can add a registry worker in the same breath: the gate costs them one
 * extra file write. Against that adversary the mitigation is that tree's own permissions, not
 * this comparison. Do not let this gate be cited as more.
 *
 * Membership is a pure string comparison against a set built from OUR OWN registry file. That
 * costs one synchronous read of that file (readRegistry) — it is NOT filesystem-free, and was
 * twice described here as if it were — but the property that matters holds exactly: NO
 * LEDGER-SUPPLIED PATH IS EVER STATTED OR OPENED. That is what closes the second defect the old
 * gate had — its synchronous statSync/existsSync ran on ledger-supplied paths OUTSIDE every
 * timeout and budget, so a record naming a hung network mount could block the whole MCP server's
 * event loop. A hung mount named by the ledger is now only ever a string.
 *
 * Liveness comes from `claude agents --json` — from the `pid` it publishes, signal-0 tested —
 * and from nothing else, and every rule here is what that listing was empirically observed
 * to do, not what it looks like it should do:
 *  - rows are PER CONFIG DIR, BOTH KINDS OF THEM. The claim once written here — that
 *    `kind:"interactive"` rows are MACHINE-GLOBAL while background rows are per-dir — is
 *    false: an empty config dir lists `[]`, and a config dir holding nothing but a `sessions`
 *    symlink lists exactly the interactive rows. Both kinds are read out of
 *    `<configDir>/sessions/`. A session showing up under an account it does not belong to is
 *    THIS codebase's own doing: the bridge MIRRORS session entries (into the host config dir;
 *    v1.x mirrored them into every participant's). That is also the real reason
 *    `kind === "background"` is a CORRECTNESS filter and is kept — a mirror is a copy
 *    (`ccoMirror: true`) living in a FOREIGN account's sessions dir, and parseBackgroundRows
 *    has no mirror guard where the pool's own readers do, so without the filter a row
 *    mirrored out of account A could vouch for a record this section attributes to B.
 *  - PRESENCE IN THE LISTING IS NOT LIVENESS, even without `--all`. The shipped CLI's
 *    printAgentsJson (@anthropic-ai/claude-code 2.1.235) keeps a row when a live process
 *    record exists OR when the PERSISTED state merely classifies as "working"/"blocked":
 *    `if (!all && !live && state !== "working" && state !== "blocked") continue`. A worker
 *    killed abruptly — reboot, OOM, pkill, battery death — leaves exactly that persisted
 *    "working" behind, so treating presence as proof would publish every dead worker of a
 *    crash as a live ghost to stop. That crash is this section's own motivating scenario,
 *    which is where a presence test fabricates ghosts fastest.
 *  - the row's `pid` is the proof, and the only one the listing offers: the same line
 *    spreads it as `...live && { pid: live.pid }`, so a row carries `pid` IF AND ONLY IF
 *    the CLI holds a live process record for that job. Aliveness here is therefore
 *    `typeof row.pid === 'number' && isPidAlive(row.pid)`; a row without `pid` is GONE.
 *  - `state` is never tested. It is a model-written summary class (`working`, `blocked`,
 *    `done`), and the classifier above shows it is derived from PERSISTED data, not from
 *    liveness — so no code here may read a verdict out of it.
 *  - `ledger.jobId === row.id` is the ONLY identity key allowed. Matching a record to a row
 *    by NAME is forbidden: names are reused across generations, so a dead namesake would be
 *    published as a live worker — the exact false positive that, acted on, would have someone
 *    kill a healthy session belonging to a different orchestrator.
 *  - a LIVE background row's `cwd` is where the worker runs — its WORKTREE when it has one,
 *    which sits under the repo root, and otherwise the root itself. A path-boundary test
 *    against this workspace's root is therefore what makes `cwd` usable as workspace identity.
 *  - a record with no matching row is GONE, not orphaned. Absence is not evidence.
 *
 * TWO PID RESIDUALS, in OPPOSITE directions. Both come from one fact — the OS may hand a dead
 * process's pid to an unrelated one — and only one of them is harmless:
 *  - the OWNER pid (`rec.ownerPid`): recycling makes isPidAlive answer "alive", the record
 *    looks owned, and a real orphan stays HIDDEN. That is the UNDER-reporting direction, and
 *    it is accepted deliberately: nothing portable can prove otherwise, and the opposite bias
 *    would publish live workers as killable.
 *  - the WORKER pid (`row.pid`): recycling makes a dead worker's row look live, and the entry
 *    printed for it reports an unrelated process's session as one of this workspace's live
 *    workers. That is the OVER-reporting direction — a false claim about somebody else's
 *    running process — and it is NOT fixed here, so it is written down rather than left
 *    implicit. registry.ts already refuses to trust a bare pid for the strictly LESS dangerous
 *    act of signalling one (isOurWorker / isOurSupervisor confirm the command line with `ps`
 *    first), but it exports neither helper and this file may not change it. What bounds the
 *    risk meanwhile: this pid is not free-floating, it comes from the CLI's own live-process
 *    record FOR THIS JOB ID, so it can only be wrong in the window between that record going
 *    stale and the listing dropping the row; and this section signals nothing itself — it
 *    prints a line a human may act on under the doctrine, right next to the attach command
 *    that would reveal the mistake. When a command-line-confirming helper is exported,
 *    `row.pid` must go through it before any entry is printed.
 * ------------------------------------------------------------------------- */

/** Per-config-dir bound on one `claude agents --json` probe. */
const ORPHAN_PROBE_TIMEOUT_MS = 5_000;
/**
 * Wall-clock cap across ALL probes, and not redundant with the per-probe timeout: that
 * timeout SIGKILLs the child and then settles from its 'close', which a grandchild still
 * holding the inherited stdout pipe can delay for as long as it likes. This is the bound
 * that keeps mesh_status answering when that happens. Probes still out when it fires are
 * reported as UNCHECKED — never as an empty listing.
 */
const ORPHAN_PROBE_BUDGET_MS = 10_000;
/** A listing longer than this is not one we recognise; the dir is reported unchecked. */
const ORPHAN_PROBE_MAX_ROWS = 1000;
/**
 * Ceiling on the number of DISTINCT config dirs probed in one mesh_status call, i.e. on the
 * subprocesses one poll may spawn. The ledger is a file: the count of distinct config dirs
 * naming an unowned worker is unbounded, and mesh_status is a polled surface, so without a
 * cap a large or hostile ledger turns every poll into a spawn storm. Dirs past the cap are
 * reported as UNCHECKED like any other dir we could not look into — silent truncation is
 * the failure to avoid, because a short list that reads as "everything is covered" is the
 * one answer that lets a live orphan pass unnoticed.
 */
const ORPHAN_PROBE_MAX_CONFIG_DIRS = 8;
/**
 * Ceiling on the "not checkable" entries rendered in one mesh_status call.
 *
 * Every other cost in this feature is capped — 1000 rows per listing, 8 config dirs per poll,
 * a 10s wall-clock probe budget — and this list was the one that was not, even though it is
 * the CHEAPEST to fill: its entries need no liveness evidence at all, only a ledger record
 * missing a jobId or a configDir, which a large or hostile ledger supplies for free on every
 * poll. Overflow is REPORTED, never silently truncated, for the same reason the config-dir
 * cap reports its overflow: a short list that reads as complete is the failure mode.
 */
const ORPHAN_MAX_UNCHECKABLE_ENTRIES = 50;
/**
 * Ceiling on ONE rendered ledger-sourced value (see oneLine). Chosen far above any real
 * config-dir path, worktree path, job id or attach command — those run to low hundreds of
 * characters at the outside — and far below the size at which a single hostile ledger string
 * could crowd every other line out of this report. What is cut is reported, never elided.
 */
const ONE_LINE_MAX_CHARS = 512;

/** One row of a `claude agents --json` listing, reduced to what this section may use. */
interface BackgroundRow {
  /** The row's cwd, kept AS GIVEN; it is lexically resolved at the boundary test. */
  cwd: string;
  /** Present IFF the CLI holds a live process record for this job — see the header. */
  pid?: number;
}

/** One config dir's probe outcome: exactly one of `rows` / `unchecked` is ever set. */
interface OrphanProbe {
  configDir: string;
  /** job id → that row, for the `kind:"background"` rows of THIS config dir only. */
  rows?: Map<string, BackgroundRow>;
  /** Why this config dir contributed nothing, phrased for the report. */
  unchecked?: string;
}

/**
 * Index the `kind:"background"` rows of one `claude agents --json` listing by job id.
 *
 * Anything that is not unambiguously a listing comes back as UNCHECKED rather than as an
 * empty index, because "we could not look" and "nothing is running there" must never
 * collapse into the same answer: the second one reads as permission to stop worrying.
 * A single malformed ROW is different — it is skipped, and the well-formed rows around it
 * still count, since dropping a whole listing over one bad entry would hide live workers.
 */
function parseBackgroundRows(output: string): { rows?: Map<string, BackgroundRow>; unchecked?: string } {
  const text = output.trim();
  if (text === '') {
    return { unchecked: 'printed nothing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // stdout and stderr share one buffer, so a CLI warning line lands in here too. Fishing a
    // JSON substring out of the noise would mean guessing which run produced which bytes.
    return { unchecked: 'printed something that is not JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { unchecked: 'printed JSON that is not a session listing' };
  }
  if (parsed.length > ORPHAN_PROBE_MAX_ROWS) {
    return { unchecked: `listed more than ${ORPHAN_PROBE_MAX_ROWS} sessions` };
  }
  const rows = new Map<string, BackgroundRow>();
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const r = row as { id?: unknown; cwd?: unknown; kind?: unknown; pid?: unknown };
    if (r.kind !== 'background' || typeof r.id !== 'string' || r.id === '' || typeof r.cwd !== 'string') {
      continue;
    }
    if (!path.isAbsolute(r.cwd)) {
      // A relative cwd cannot be boundary-tested against this workspace, and resolving it
      // against OUR cwd would invent a workspace identity the row never claimed.
      continue;
    }
    // `pid` is CARRIED, not required: a row without one is still indexed so the aliveness
    // decision — the single place that may conclude "still running" — is the one place that
    // sees the absence. Dropping such rows here would hide, behind "no matching row", the
    // reason this section exists to distinguish: a persisted "working" record left by a
    // worker that was killed, which is not a running worker.
    rows.set(r.id, { cwd: r.cwd, ...(typeof r.pid === 'number' ? { pid: r.pid } : {}) });
  }
  return { rows };
}

/**
 * The config dirs this installation is CONFIGURED to use: this session's own host account
 * (platform.hostConfigDir() — the identical value doEnsureMesh hands the pool and the bridge)
 * plus every registered worker account's `configDir`. Returned as a map from the
 * path.resolve-normalized dir — what identifies a DIRECTORY, and what a ledger record is
 * matched through — to the string AS CONFIGURED, which is what a probe of that dir must be
 * spawned with: platform.claudeEnv decides the child's CLAUDE_CONFIG_DIR from the verbatim
 * spelling, never from a normalized one.
 *
 * This is the ENTIRE probe-target gate, and it replaces the old isInitializedConfigDir check.
 * The header has the full reasoning; the short version is that `claude agents --json` REWRITES
 * the `.claude.json` of whatever dir it is aimed at and creates a `backups/` dir beside it, so
 * no property of an untrusted path can make aiming it there safe — only the target being one
 * the operator configured can. What that buys and what it does not is in the header (M6): it
 * bounds the targets to operator-configured accounts, it is not a boundary against an attacker
 * who can already write this installation's own state directory.
 *
 * COST, stated correctly (M5): this reads OUR OWN registry file synchronously, so it is not
 * filesystem-free — the claim that it "touches the filesystem zero times" was false. The
 * property being defended is the narrower true one: NO LEDGER-SUPPLIED PATH IS STATTED OR
 * OPENED anywhere in this gate. Membership is a pure string comparison, so a record naming a
 * hung network mount can never block the event loop.
 *
 * NON-ABSOLUTE CONFIGURED VALUES ARE DROPPED, not resolved (L5). `path.resolve` anchors a
 * relative or `~`-prefixed value to THIS SERVER'S CWD — `~/.claude` becomes
 * `<workspace>/~/.claude` — and a ledger record naming the same thing would then aim a WRITING
 * probe inside the user's repo, creating `.claude.json` and a `backups/` dir there. Reaching
 * that needs an operator-entered relative config rather than an attacker, but the probe writes,
 * so a non-absolute configured value is treated as no configured value at all.
 *
 * Never throws, and every failure NARROWS the set (an unreadable registry contributes no
 * worker dirs) — the one direction that cannot turn into a write at a path we do not trust.
 */
function trustedProbeConfigDirs(): Map<string, string> {
  const trusted = new Map<string, string>();
  // Absolute-only, on BOTH sources: hostConfigDir() is an env var (CLAUDE_CONFIG_DIR) before
  // it is a homedir join, so it can be relative for exactly the same reason a registry value
  // can. The FIRST spelling of a directory wins, and the host's is added first: it is the
  // string this very session runs under.
  const addIfAbsolute = (dir: unknown): void => {
    if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) {
      return;
    }
    try {
      const resolved = path.resolve(dir);
      if (!trusted.has(resolved)) {
        trusted.set(resolved, dir);
      }
    } catch {
      // path.resolve on an absolute string does not consult the cwd, but a throw here still
      // only means one fewer trusted target — never a wider set
    }
  };
  try {
    addIfAbsolute(hostConfigDir());
  } catch {
    // only os.homedir() can fail in there; without it the host account is simply not a
    // trusted target, which costs one "not probed" line and never a write
  }
  try {
    // Claude Code accounts only. The probe is `claude agents` run with CLAUDE_CONFIG_DIR set to
    // the directory, and that CLI CREATES its config files in whatever directory it is given:
    // aimed at another vendor's home it would leave a `.claude.json` inside `~/.codex`.
    for (const worker of claudeWorkers(readRegistry())) {
      addIfAbsolute(worker.configDir);
    }
  } catch {
    // an unreadable registry narrows the trusted set; it can never widen it
  }
  return trusted;
}

/** Where a probe child is spawned, and whether that is the workspace or the fallback. */
interface ProbeSpawnDir {
  cwd: string;
  /** True when the workspace directory is gone and `cwd` is the fallback. */
  workspaceGone: boolean;
}

/**
 * A directory the probe child can actually be spawned in — the local twin of mesh/reaper's
 * `spawnCwd` (which is not exported), applied here for the same reason it exists there:
 * spawning into a missing cwd fails with ENOENT BEFORE the command ever runs.
 *
 * This server outlives a workspace that gets renamed, deleted or unmounted under it, and a
 * bare `process.cwd()` would then make EVERY probe come back as a spawn error and every dir
 * be reported as "the claude executable could not be run" — a wrong diagnosis in the one
 * section whose entire value is the accuracy of its reasons. The fallback keeps the probe
 * running, and `workspaceGone` is carried so a spawn failure can still be told apart from a
 * missing workspace in the report.
 *
 * The one statSync here is on OUR OWN cwd, once per mesh_status call — not on a ledger-supplied
 * path, and not per config dir. That distinction is the whole point of the header's note about
 * the deleted gate's synchronous stats.
 */
function probeSpawnCwd(): ProbeSpawnDir {
  let workspace: string | undefined;
  try {
    workspace = process.cwd();
  } catch {
    // uv_cwd fails outright once the directory is unlinked or unmounted
    workspace = undefined;
  }
  if (typeof workspace === 'string' && workspace !== '') {
    try {
      if (fs.statSync(workspace).isDirectory()) {
        return { cwd: workspace, workspaceGone: false };
      }
    } catch {
      // renamed out from under us, deleted, or unreadable — fall through to the fallback
    }
  }
  return { cwd: os.homedir(), workspaceGone: true };
}

/**
 * List one config dir's live background sessions. Never rejects and never parses the output
 * of a run that did not cleanly succeed — a failed `claude` invocation's buffer is a
 * diagnostic, not data. Every non-success is classified into one phrase for the report.
 *
 * `configDir` is the RESOLVED, trusted path — the key the outcome is indexed and reported
 * under. One key, because the resolved path is what identifies a DIRECTORY: keying on the raw
 * ledger spelling made `/x/.claude`, `/x/.claude/` and `/x/./.claude` three probe targets aimed
 * at one dir (L6), and a record is matched back to this outcome by resolving its own
 * `configDir` the same way. `configuredDir` is that same directory AS THE OPERATOR SPELLED IT,
 * and it is what the child runs as (platform.claudeEnv keys on the verbatim string). Callers
 * MUST have taken both from trustedProbeConfigDirs: this spawn WRITES to the dir it targets.
 */
async function probeBackgroundSessions(
  claudePath: string,
  configDir: string,
  configuredDir: string,
  spawnDir: ProbeSpawnDir,
): Promise<OrphanProbe> {
  const outcome = await runMeshProcess(
    claudePath,
    ['agents', '--json'],
    spawnDir.cwd,
    claudeEnv(configuredDir),
    ORPHAN_PROBE_TIMEOUT_MS,
  );
  if (outcome.timedOut) {
    return { configDir, unchecked: 'timed out' };
  }
  if (outcome.spawnError) {
    return {
      configDir,
      unchecked: spawnDir.workspaceGone
        ? 'this workspace directory is gone, and the claude executable could not be run from the ' +
          'fallback directory either'
        : 'the claude executable could not be run',
    };
  }
  if (outcome.code !== 0) {
    return { configDir, unchecked: `claude agents exited with code ${outcome.code}` };
  }
  return { configDir, ...parseBackgroundRows(outcome.output) };
}

/**
 * Characters a ledger-sourced value may hold and still be rendered INSIDE a shell command
 * string (M5). An allowlist, deliberately: the pool assembles `attachCommand` from a record's
 * `configDir` and `jobId` (a config-dir prefix when the account needs one, then
 * `claude attach <jobId>`), and both come out of the ledger — where a `configDir` of
 * `'; touch /tmp/PWNED; echo '` or a `jobId` of `$(…)` is one file edit away from a
 * copy-pasteable command that executes a payload. This report does not rest on how carefully
 * the pool quotes: `oneLine()` does nothing about quoting (it is a line-forgery guard, not a
 * shell guard), and this report's entries point the reader straight at that string.
 *
 * A blocklist of metacharacters would be a guess at a shell's grammar; this is the set of
 * characters that appear in real config-dir paths and real job ids and cannot terminate a
 * quote, start a substitution, separate a command, or redirect.
 *
 * Everything from U+0080 up is allowed, and that is not a hole ON ITS OWN: EVERY POSIX shell
 * metacharacter is ASCII, so a code unit above the ASCII range is an ordinary word character
 * to `sh` no matter what it renders as. Excluding them would withhold the attach command for
 * every user whose home directory holds a non-ASCII character — a real setup, silently
 * degraded, for no security gain. What such a value can still do to the DISPLAY (bidi
 * reordering, zero-width confusables) is oneLine's job — and oneLine is why this allowlist is
 * NOT the whole guard: see attachCommandWithholdReason, which pairs it with the renderer.
 */
const SHELL_RENDERABLE = /^[A-Za-z0-9._\-/@=+:,~\u0080-\uffff]+$/;

/**
 * Why this record's attach command must not be printed, or `undefined` when it may be.
 *
 * THE GUARD AND THE RENDERER RUN ON THE SAME BYTES, and that is the point of the last clause
 * (M2). The old version tested the RAW `configDir`/`jobId` and then printed the ONE-LINED
 * command, so the two disagreed about what a value was: SHELL_RENDERABLE admits everything at
 * or above U+0080, and oneLine REWRITES many of those code units — U+0085 and the other line
 * breakers become a SPACE, and every invisible and bidi control is DELETED outright — so oneLine
 * manufactured word breaks, and now also silent deletions, that the guard had just been checked
 * to exclude. Either transform breaks the invariant the same way. Verified, with U+0085 NEL
 * standing in for each space so the raw value holds no ASCII whitespace: a jobId of
 * `J1<U+0085>--mcp-config<U+0085>/tmp/x.json` passed the guard and rendered as
 * `claude attach J1 --mcp-config /tmp/x.json`. The installed CLI ignores the extra arguments
 * today, so the observed damage was misdirection — a printed command that targets a truncated
 * job id and is not this record's command — rather than flag injection; but the invariant
 * ("shell-renderable inputs ⇒ a safe printed command") was false, and it is load-bearing on
 * another program's argument handling.
 *
 * So the final clause runs the RENDERER and demands it be a no-op: `oneLine(attachCommand)`
 * is exactly the string the report prints, and requiring it to equal `attachCommand` means the
 * bytes checked here are byte-for-byte the bytes printed. That single check subsumes every
 * transform oneLine can apply — the control/bidi/invisible class, lone surrogates AND the
 * length cap, whose truncation of the composite would otherwise print a cut-off path as if it
 * were a command. `attachCommand` is not an independent ledger field: `pool.list()` recomputes
 * it on every read from the record's `configDir` and `jobId`, so checking the two source
 * fields for shell metacharacters and the composite for renderer identity covers the whole
 * printed string.
 *
 * The empty cases get their OWN reasons (L1). SHELL_RENDERABLE is anchored with `+`, so an
 * empty string fails it — and reporting that the record "holds characters that are not safe"
 * is false about a value that holds no characters at all. `adopt()` can write an empty job
 * id (the session entry it adopted carried none), so this is a real path, not a corner.
 */
function attachCommandWithholdReason(rec: {
  configDir: string;
  jobId: string;
  attachCommand: string;
}): string | undefined {
  if (
    typeof rec.configDir !== 'string' ||
    typeof rec.jobId !== 'string' ||
    typeof rec.attachCommand !== 'string'
  ) {
    return (
      'this record does not hold the fields an attach command is built from, so no command is ' +
      'printed for it'
    );
  }
  if (rec.configDir === '' && rec.jobId === '') {
    return (
      'this record names neither a config dir nor a job id, so there is no attach command to ' +
      'print for it'
    );
  }
  if (rec.jobId === '') {
    return (
      'this record names no job id, so there is nothing for an attach command to attach to and ' +
      'none is printed for it'
    );
  }
  if (rec.configDir === '') {
    return (
      'this record names no config dir, so an attach command would name no account and none is ' +
      'printed for it'
    );
  }
  if (!SHELL_RENDERABLE.test(rec.configDir) || !SHELL_RENDERABLE.test(rec.jobId)) {
    return (
      "this record's config dir or job id holds characters that are not safe to render inside a " +
      'shell command, so no command is printed for it'
    );
  }
  if (oneLine(rec.attachCommand) !== rec.attachCommand) {
    // The renderer would change the command — a space substituted for an invisible or a
    // line-breaking code unit, or the length cap cutting it — so what the reader would be
    // shown is not the string checked above, and not this record's command either.
    return (
      "this record's attach command cannot be shown exactly as it is, so no command is printed " +
      'for it'
    );
  }
  return undefined;
}

/**
 * Render one externally-sourced value on a SINGLE line.
 *
 * Every string in an entry below (name, account, model, role, taskId, jobId, configDir,
 * worktree, branch, attachCommand) is read from the mesh state file, which is a file — any
 * process on this machine can write it, and a worker name is not validated against control
 * characters anywhere on the way in. The same holds for the other foreign values this report
 * prints: a registry status read out of an account's sessions dir, and a cross-session
 * `fromName` that can reach the feed from a sender that is not one of our workers. This report
 * is line-oriented and its lines are ACTED ON: a value holding a newline forges an entry, or a
 * whole header like `ghosts (9): … still ALIVE`, inside a report a human uses to decide what
 * to kill.
 *
 * THE CHARACTER RULE IS `displayText.flattenChars` — SHARED, not this module's own. It used to
 * be spelled out here, as an enumerated range list, and that spelling was BOTH too weak and too
 * strong at once. Too weak: it enumerated `\u200b-\u200f` and stopped, so the Unicode tag block
 * U+E0000-U+E007F walked straight through it — the canonical invisible-ASCII encoding, a whole
 * legible sentence that renders as nothing, inside a report a model reads. Too strong: that same
 * range swallowed U+200C ZWNJ and U+200D ZWJ, so every multi-person emoji in a worker name came
 * apart into separate people and Persian and Indic prose lost its word separators (measured: 5
 * of 14 emoji/ZWNJ probes altered). A range cannot tell those two facts apart; only a rule about
 * what a code point DOES can, and that rule now has exactly one owner. Read
 * `displayText.flattenChars` and the classes above it for the reasoning, class by class.
 *
 * What it does, in one line: C0/C1 controls and the line/paragraph separators become SPACES (so a
 * forged value reads as one mangled field instead of two plausible ones — and the class is wider
 * than C0 on purpose, because U+0085 NEL breaks a line and U+009B is the 8-bit CSI, an escape
 * introducer that walks past any filter that only knows ESC); bidi controls, unpaired surrogates
 * and every invisible with no glyph-shaping role are DELETED. Deleted, not spaced, is a change
 * from the old spelling and the right one: these are zero-width, so a space in place of one is a
 * word break the reader never had — and a name spelled entirely in Hangul fillers now renders as
 * the empty string it always was, rather than as a run of blanks that still looks like a name.
 *
 * `flattenOneLine`, AND NOT `flattenChars` — a REVERSAL, stated as one because the reasoning
 * that moved it was wrong and the move opened a hole.
 *
 * The case for the character-only variant was that on THIS surface a run of spaces is data:
 * `/Users/x/My  Documents` is a real directory, and collapsing it would make the
 * renderer-identity clause of `attachCommandWithholdReason` withhold the attach command for
 * every user whose config dir holds two adjacent spaces. THAT JUSTIFICATION WAS VOID. The guard
 * that runs before the identity clause is `SHELL_RENDERABLE`, and ASCII space is not in it — so
 * a config dir with two adjacent spaces (or one) already fails that earlier clause and its
 * attach command is withheld regardless. The variant bought nothing, and it was never free:
 * `flattenChars` leaves every NON-ASCII separator exactly as it is, and SHELL_RENDERABLE admits
 * everything from U+0080 up. `oneLine(cmd) === cmd` therefore still held for them, and
 * `mesh_status` PRINTED an attach command carrying an invisible-as-a-space separator —
 * reproduced for U+00A0 NBSP, U+1680, U+2003, U+2007, U+202F, U+205F and U+3000, each rendering
 * as `…<separator>--dangerously-skip-permissions` in a command a human is invited to paste.
 *
 * `flattenOneLine` closes it with the rule JS already draws: `\s` covers NBSP, U+1680, the
 * U+2000–U+200A block, U+202F, U+205F, U+3000 and U+FEFF, so each becomes an ASCII space, the
 * identity check fails, and the command is WITHHELD instead of printed. A genuine attach command
 * — single ASCII spaces, no leading or trailing whitespace, both source fields already through
 * SHELL_RENDERABLE — is unchanged by the collapse and the trim, so the healthy path still prints.
 *
 * LENGTH IS CAPPED (ONE_LINE_MAX_CHARS). Values used to be left intact on the theory that a
 * truncated worktree path is a path nobody can act on — true, but the ledger is a file any
 * process can write, and one megabyte-long name would bury every other line of this report,
 * which is worse. The cap sits far above any real path, job id or attach command, and what was
 * cut is SAID rather than left looking like the whole value. The cut goes through
 * `displayText.sliceOneLine`, never a raw `String.slice`, so it cannot orphan a surrogate half,
 * and the truncation note is our own literal, appended after everything else.
 *
 * THE CAP IS APPLIED TO THE FLATTENED TEXT, WHICH IS THE TEXT THAT IS PRINTED. It used to be
 * decided on the RAW length and applied to a raw slice, so the note described a string nobody
 * saw: a 12-character worker name padded with 600 zero-width spaces flattens to 12 characters
 * and rendered as `cco-w-acct-3… [truncated from 612 characters]` — a complete value carrying a
 * note that says it is a fragment. The marker's non-forgeability survived that; the MEANING it
 * carries did not, and a reader who believes a value was cut stops treating what they see as
 * the whole of it. Now the flatten runs first and the cut is decided on its result, so the note
 * appears if and only if the printed text really is less than the value. The count it states
 * stays the RAW character count — the honest answer to "how much was this derived from".
 *
 * ONE_LINE_RAW_MAX_CHARS bounds the flatten itself, since flattening now precedes the cut and
 * would otherwise run over a value of any size the ledger happens to hold. It sits two orders
 * above the display cap, so it can only be reached by a value that is being truncated anyway —
 * which is why hitting it also forces the note on: something WAS cut, before the flatten.
 *
 * AND THE NOTE IS NOT FORGEABLE (L2). Appending our own marker while letting the same literal
 * through inside a value meant a SHORT value could carry `… [truncated from 3 characters]` and
 * read as a value this code had cut — the opposite of what the note is for, since a reader who
 * believes a value was truncated stops treating what they see as the whole of it. Any embedded
 * copy of the marker's head is therefore neutralized (its `[` becomes `(`) AFTER flattening —
 * after, because flattening can MANUFACTURE the literal out of `[truncated<U+0085>from …`. The
 * invariant that buys: the exact string `[truncated from ` appears in oneLine's output if and
 * only if oneLine appended it.
 */
const TRUNCATION_MARKER_HEAD = '[truncated from ';
const ONE_LINE_RAW_MAX_CHARS = 64 * 1024;
function oneLine(value: string): string {
  // Total by construction. The declared type says `string`, but every value this renders comes
  // out of a JSON.parse of a file, so `undefined` genuinely reaches here and the old
  // `value.length` threw out of mesh_status on it. `flattenOneLine` takes `unknown` and owns the
  // safe conversion (it survives a throwing toString and a null-prototype object), and it is
  // idempotent, so re-running it below changes nothing.
  const raw = typeof value === 'string' ? value : flattenOneLine(value);
  // Bound the work before flattening — see ONE_LINE_RAW_MAX_CHARS. Reaching this IS a cut.
  const rawCut = raw.length > ONE_LINE_RAW_MAX_CHARS;
  const flattened = flattenOneLine(rawCut ? sliceOneLine(raw, ONE_LINE_RAW_MAX_CHARS) : raw);
  const displayCut = flattened.length > ONE_LINE_MAX_CHARS;
  // Neutralize AFTER flattening and after the cut: flattening can MANUFACTURE the marker out of
  // `[truncated<U+0085>from …`, and slicing can only ever break one, never build one.
  const shown = (displayCut ? sliceOneLine(flattened, ONE_LINE_MAX_CHARS) : flattened)
    .split(TRUNCATION_MARKER_HEAD)
    .join(`(${TRUNCATION_MARKER_HEAD.slice(1)}`);
  return rawCut || displayCut ? `${shown}… ${TRUNCATION_MARKER_HEAD}${raw.length} characters]` : shown;
}

/**
 * Why a ZERO-record listing out of the pool may not mean "the ledger is empty".
 *
 * pool.list() -> readRawMeshState wraps read AND parse in `try { … } catch { }` and returns
 * `{}` for a missing file, a `chmod 000` file and a single flipped byte alike, so it cannot
 * throw and the emptiness it reports is uninterpretable on its own. That is how a corrupt
 * ledger came to render byte-identically to a clean mesh: zero records, zero candidates, early
 * return, no orphan section at all — inside a report that teaches its readers that a dir it
 * could not read gets its own line. Silence there is not neutral, it is false assurance.
 *
 * So classify the FILE. This re-reads it for CLASSIFICATION only — it yields no records, never
 * writes, and never spawns, so the healthy path's zero-cost property is untouched. Returns a
 * phrase for the report when the file is there but unusable, and `undefined` ONLY when the
 * ledger genuinely holds no worker records (no file at all, or a parsed state whose `workers`
 * is absent or empty) — the one case where saying nothing is the honest answer, and the reason
 * this is not a blanket warning that would train its readers to ignore it.
 *
 * PARTIAL unreadability is a fault too (M8), and it used to be invisible. This was consulted
 * only when ZERO records parsed, but `parseWorkerRecords` drops entries per-record and
 * silently: a ledger holding ten entries of which nine are unparseable yields one record, the
 * zero-record branch is never taken, and the report says nothing at all about the nine —
 * inside a surface whose contract is that anything unreadable gets its own line. `parsedCount`
 * is what the caller actually got back from pool.list(); when the file holds more entries than
 * that, the shortfall is reported with its count. A file that shrank between the two reads
 * cannot fabricate a fault: only a raw count STRICTLY GREATER than the parsed count is one.
 */
function ledgerReadFault(parsedCount: number): string | undefined {
  // safeFs, under the shared cap. This runs INSIDE mesh_status, which must always come back:
  // the old `fs.readFileSync` here would have blocked the tool call forever on a FIFO planted at
  // the ledger path — the surface whose whole contract is that anything unreadable gets its own
  // line, silently wedged by the thing it exists to report on. The two refusals safeFs adds are
  // faults in exactly this function's sense and get their own phrases. A symbolic link at the
  // ledger's name is one of them: the ledger is a regular file put there by rename, so a link
  // is not followed and reads as "not a regular file".
  const read = readTextSafe(meshStateFile(process.cwd()), MESH_STATE_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    if (read.reason === 'absent') {
      // Nothing was ever written for this workspace, so there is no ledger to be wrong about.
      return undefined;
    }
    if (read.reason === 'not-a-file') {
      return 'is not a regular file, so it was not read';
    }
    if (read.reason === 'too-large') {
      return `is larger than the ${MESH_STATE_FILE_MAX_BYTES}-byte read cap, so it was not read`;
    }
    return `could not be read (${oneLine(read.detail)})`;
  }
  const text = read.text;
  if (text.trim() === '') {
    // Every writer of this file writes a whole state object atomically (tmp + rename), so a
    // zero-byte one is a truncated or clobbered file, never a state.
    return 'exists but is empty';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'is not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'does not hold a mesh state object';
  }
  const workers = (parsed as { workers?: unknown }).workers;
  if (workers === undefined) {
    return undefined;
  }
  if (!Array.isArray(workers)) {
    return 'holds a "workers" field that is not a list';
  }
  if (workers.length === 0 || workers.length <= parsedCount) {
    return undefined;
  }
  const unreadable = workers.length - parsedCount;
  const entries = `${workers.length} worker entr${workers.length === 1 ? 'y' : 'ies'}`;
  if (parsedCount === 0) {
    // The file parses and holds entries, yet parseWorkerRecords accepted none of them: records
    // are present and unusable, which is emphatically not "no workers".
    return `holds ${entries} that could not be read as records`;
  }
  // Some parsed, some did not. The ones that did are reported normally above; these are the
  // records this report cannot say anything about, and their COUNT is the whole message.
  return (
    `holds ${entries}, ${unreadable} of which could not be read as record` +
    `${unreadable === 1 ? '' : 's'}`
  );
}

/**
 * The mesh_status lines for workers running under this workspace that this session does not
 * own. Returns [] when there is nothing to say. It never writes the ledger, and it CANNOT
 * throw: a status surface that errors is worse than one that degrades, because the caller then
 * has no information at all about what is still running.
 *
 * FOUR classes, reported separately because what is KNOWN about each differs — the split between
 * the first two and the third is the difference between a recorded owner proven not to be
 * running and no recorded owner at all. None of the four recommends stopping or destroying
 * anything, and none of the four predicts what this system will do next; this surface is
 * descriptive (see the two contracts in the section header):
 *  - ownerPid PRESENT + dead + no stoppedAt + alive ⇒ ADOPTABLE ORPHAN. A RECORDED owner that is
 *    not running is positive evidence that nobody is DRIVING it — the strongest claim any class
 *    here can make, and it is still only reported. The entry says what this session's code does
 *    about such a record — nothing on a timer; the orphan sweep runs when a session starts — and
 *    predicts nothing (H1).
 *  - ownerPid PRESENT + dead + stoppedAt set + alive ⇒ GHOST, and the worse of the two. The
 *    ledger believes it is dead, and every sweep starts by skipping records marked stopped, so
 *    nothing will ever reap it. `stoppedAt` therefore does NOT disqualify a record from being
 *    checked here — excluding it is exactly what kept this class invisible.
 *  - ownerPid ABSENT + alive ⇒ UNOWNED IN THE LEDGER'S TERMS, and NOT destructive. An absent
 *    ownerPid is not evidence that nobody owns it: WorkerPool.adopt() builds its records from a
 *    literal that sets no ownerPid (spawnDispatchWorker is the only writer of that field, and
 *    nothing back-fills it), and doEnsureMesh calls adopt() unconditionally at init — so a
 *    worker THIS session adopted seconds ago carries no ownerPid, and used to be published
 *    here as an orphan "whose owner session is gone", with instructions to stop it. The doctrine has orchestrators read this section AT SESSION
 *    START, i.e. moments after adopt() manufactures exactly that record — a false positive that
 *    once carried advice to destroy live work. Such records are still worth seeing, so they keep
 *    a heading of their own, and their entry says outright that this session may own it.
 *  - no jobId, or no configDir ⇒ NOT CHECKABLE, and said out loud rather than dropped. This
 *    class carries NO liveness claim in either direction, but it is NOT "nothing at all is
 *    known": it is populated by construction from records this session may well own —
 *    `WorkerPool.adopt()` writes no ownerPid, and an empty job id when the session entry it
 *    adopted carried none, so a worker THIS session adopted seconds ago at init can land here
 *    — and it applies no `stoppedAt` filter, so a record the
 *    ledger explicitly marks stopped lands here too. Both facts are stated per entry, for the
 *    same reason the ownerless class states the first one: the honest qualifier is what keeps
 *    the class from reading as a list of unknown things that might need killing.
 */
async function unownedWorkerLines(): Promise<string[]> {
  try {
    const pool = mesh.pool;
    if (pool === undefined) {
      // NOT the same as "nothing is unowned", and this is the case where the difference
      // costs the most: doEnsureMesh assigns `mesh.pool` only after the version gate and the
      // owner lock, so any init failure lands here — the mesh is unhealthy, which is exactly
      // when workers from a previous owner are most likely to still be running. `?? []` made that
      // print NOTHING, and this report teaches its readers that a dir it could not read gets
      // its own line, so silence reads as CLEAN. Say the probe did not run instead. The
      // ledger is deliberately NOT read for RECORDS as a workaround: this section's whole
      // contract is that a claim here is evidence, and a ledger with no listing to check it
      // against is a list of names, not evidence.
      return [
        '  orphan probe: NOT RUN — the mesh is not initialized in this session, so nothing was checked ' +
          'and this report says nothing about orphans or ghosts either way.',
      ];
    }
    const records = pool.list();
    // Zero records is TWO different facts wearing one face, and a SHORT record list is a third
    // (M8) — see ledgerReadFault. Ask the file before believing either. Still zero
    // subprocesses: one read of one small file, never a spawn.
    const fault = ledgerReadFault(records.length);
    if (records.length === 0) {
      return fault === undefined
        ? []
        : [
            `  orphan probe: NOT RUN — the mesh ledger ${fault}, so no record could be checked and this ` +
              'report says nothing about orphans or ghosts either way. Read this line as "unknown", never ' +
              'as "clean".',
          ];
    }
    // Some records parsed and some did not. The probe below runs normally over the ones that
    // did; this line is the only thing that will ever be said about the ones that did not, and
    // it is carried through EVERY return path below — including the early "nothing unowned"
    // one, which is exactly where a silent drop would read as a clean ledger.
    const faultLines =
      fault === undefined
        ? []
        : [
            `  ledger: ${fault}. Those entries were not checked, and this report says nothing about them ` +
              'either way — read their absence as "unknown", never as "clean".',
          ];
    const now = Date.now();
    // UNOWNED = no LIVING process is responsible for this record: not us, and not another
    // server that is still running. Note what this predicate may NOT decide on its own any
    // more — an absent ownerPid still lands here, but it can never reach the two classes below
    // that assert a RECORDED owner has died, because "the field is missing" and "the recorded
    // owner died" are different facts (see the doc comment). The owner-pid recycling residual
    // is in the header.
    const unowned = records.filter(
      (rec) => rec.ownerPid !== process.pid && (rec.ownerPid === undefined || !isPidAlive(rec.ownerPid)),
    );
    // NOT CHECKABLE, and reported rather than dropped. A record is matched to a listing row by
    // jobId alone, inside the config dir it names; without one of those there is no question we
    // can ask, and the old code silently filtered both away:
    //   - jobId === '' is not hypothetical — adopt() writes exactly that when the session entry
    //     it adopted carried none, so the silent drop deleted, with no line at all, the very
    //     population this section exists to surface ("a previous owner left this running").
    //   - configDir === '' names no account at all, so a probe for it could only answer a
    //     question about a different one. Unanswerable, so never asked — but still said.
    const uncheckable = unowned.filter((rec) => rec.jobId === '' || rec.configDir === '');
    const checkable = unowned.filter((rec) => rec.jobId !== '' && rec.configDir !== '');
    if (checkable.length === 0 && uncheckable.length === 0) {
      // The healthy case costs ZERO subprocesses: with nobody unowned there is nothing a
      // listing could tell us, and mesh_status is polled far too often to spend a spawn on it.
      return faultLines;
    }
    let probes: OrphanProbe[] = [];
    let alive: typeof checkable = [];
    // Nothing checkable ⇒ still no subprocess: the uncheckable list below needs no listing.
    if (checkable.length > 0) {
      // Probes are per DISTINCT config DIRECTORY of the checkable records — never per record,
      // and never over every configured account: a probe of an account holding no unowned
      // record could only produce rows we would have to throw away.
      //
      // DISTINCT MEANS RESOLVED (L6). The dedupe used to key on the RAW ledger spelling while
      // the trust test resolved it, so `/x/.claude`, `/x/.claude/` and `/x/./.claude` were
      // THREE targets — three spawns, three cap slots and three report lines — all aimed at ONE
      // directory. A resolved path is what identifies a directory, so it is the key of the
      // dedupe, the key of the probe outcome, and the key a record is matched back through.
      // Resolution is memoized per raw value so the matching pass below cannot disagree with
      // the target-building pass above.
      const resolvedByRaw = new Map<string, string | undefined>();
      const resolveConfigDir = (raw: string): string | undefined => {
        if (!resolvedByRaw.has(raw)) {
          try {
            resolvedByRaw.set(raw, path.resolve(raw));
          } catch {
            // path.resolve consults process.cwd() for a relative value, and uv_cwd throws once
            // this workspace is unlinked or unmounted — the one way this can fail for a string.
            resolvedByRaw.set(raw, undefined);
          }
        }
        return resolvedByRaw.get(raw);
      };
      // ORDER IS PART OF THE CAP. Dirs are ranked by the spawnedAt of their most RECENT unowned
      // record, newest first, because the cap slices off the TAIL: ledger append order puts the
      // OLDEST records at the front, so an unordered slice spent the whole probe budget on the
      // stalest dirs and skipped the newest unowned worker — the one most likely to still be
      // running, i.e. the only kind this section can report at all. Ties keep ledger order
      // (Array#sort is stable).
      const newestRecordAt = new Map<string, number>();
      const unresolvable: OrphanProbe[] = [];
      const unresolvableSeen = new Set<string>();
      for (const rec of checkable) {
        const resolved = resolveConfigDir(rec.configDir);
        if (resolved === undefined) {
          // Reported, never dropped — a dir this report cannot even name is still a dir it did
          // not look into. Keyed by the raw spelling, which is all there is for one of these.
          if (!unresolvableSeen.has(rec.configDir)) {
            unresolvableSeen.add(rec.configDir);
            unresolvable.push({
              configDir: rec.configDir,
              unchecked:
                'its config dir could not be resolved to an absolute path (this workspace directory is ' +
                'gone), so it was not probed',
            });
          }
          continue;
        }
        const at = Number.isFinite(rec.spawnedAt) ? rec.spawnedAt : 0;
        const seen = newestRecordAt.get(resolved);
        if (seen === undefined || at > seen) {
          newestRecordAt.set(resolved, at);
        }
      }
      // THE WRITE GATE (header, D1). `claude agents --json` REWRITES the `.claude.json` of the
      // dir it targets and creates a `backups/` dir beside it, so the only defensible target
      // set is one the OPERATOR configured: this installation's registered worker accounts plus
      // this session's own host config dir. Membership is a string comparison against a set built
      // from OUR OWN registry file — that costs one read of THAT file and never a stat of a
      // LEDGER-SUPPLIED path, so no record can make this block on a hung mount. A record naming
      // anything else is NOT probed and is named in the unchecked list.
      //
      // THE GATE RUNS BEFORE THE CAP, and the order is the whole of M4. Capping first ranked
      // ALL distinct dirs by spawnedAt and trust-tested only the survivors, so nine records
      // with fresh spawnedAt naming nine unconfigured dirs pushed every genuinely configured
      // dir past the cap: every real orphan came back "skipped by the cap" and was never
      // probed — the feature defeated for the price of nine ledger lines, on the surface whose
      // entire job is to surface exactly those workers. The cap exists to bound SPAWNS, and an
      // untrusted dir spawns nothing, so it must not consume a cap slot. Untrusted dirs keep
      // their own unchecked reason; they are simply not in the population the cap applies to.
      const trusted = trustedProbeConfigDirs();
      const trustedDirs: string[] = [];
      const notConfigured: OrphanProbe[] = [];
      for (const configDir of newestRecordAt.keys()) {
        if (trusted.has(configDir)) {
          trustedDirs.push(configDir);
        } else {
          notConfigured.push({
            configDir,
            unchecked:
              "its config dir is not one of this installation's configured accounts (the main account or " +
              'a registered worker), so it was not probed — a probe WRITES to the config dir it targets',
          });
        }
      }
      trustedDirs.sort((a, b) => (newestRecordAt.get(b) ?? 0) - (newestRecordAt.get(a) ?? 0));
      // …and never more than ORPHAN_PROBE_MAX_CONFIG_DIRS of them, because that count is
      // whatever the ledger file happens to hold and this runs on every mesh_status poll.
      // The overflow is not dropped: each skipped dir becomes an UNCHECKED probe below, so it
      // is named in the "could not check" list with the caveat that rides it. That keeps the
      // cap honest — a bounded poll that admits what it did not look at, rather than a short
      // clean-looking answer.
      const probeTargets = trustedDirs.slice(0, ORPHAN_PROBE_MAX_CONFIG_DIRS);
      const cappedOut: OrphanProbe[] = trustedDirs.slice(ORPHAN_PROBE_MAX_CONFIG_DIRS).map((configDir) => ({
        configDir,
        unchecked:
          `skipped: only ${ORPHAN_PROBE_MAX_CONFIG_DIRS} configured config dir(s) are probed per ` +
          'mesh_status call, newest record first',
      }));
      const claudePath = mesh.claudePath;
      if (claudePath === undefined) {
        // No resolved executable (init never got that far). Resolving one here can spawn a
        // login shell, which is not something a status poll should do — report unchecked.
        probes = probeTargets.map((configDir) => ({
          configDir,
          unchecked: 'no claude executable is resolved in this session',
        }));
      } else if (probeTargets.length > 0) {
        // Resolved ONCE per call, not per dir: it costs one statSync on our own cwd, and every
        // probe of this poll shares the same verdict about whether the workspace is still there.
        const spawnDir = probeSpawnCwd();
        let budgetTimer: NodeJS.Timeout | undefined;
        const budgetExhausted = new Promise<'budget'>((resolve) => {
          budgetTimer = setTimeout(() => resolve('budget'), ORPHAN_PROBE_BUDGET_MS);
        });
        try {
          probes = await Promise.all(
            probeTargets.map(async (configDir) => {
              const result = await Promise.race([
                probeBackgroundSessions(claudePath, configDir, trusted.get(configDir) ?? configDir, spawnDir),
                budgetExhausted,
              ]);
              return result === 'budget'
                ? {
                    configDir,
                    unchecked: `did not answer within ${ORPHAN_PROBE_BUDGET_MS / 1000}s`,
                  }
                : result;
            }),
          );
        } finally {
          if (budgetTimer !== undefined) {
            clearTimeout(budgetTimer);
          }
        }
      }
      probes = probes.concat(notConfigured, cappedOut, unresolvable);
      const byConfigDir = new Map(probes.map((probe) => [probe.configDir, probe]));
      // Lexically resolved on both sides of the boundary test below. process.cwd() is already
      // absolute, but normalizing it here keeps the two operands comparable by construction.
      const root = path.resolve(process.cwd());
      alive = checkable.filter((rec) => {
        // Matched inside the record's OWN config dir's index, through the SAME resolution the
        // targets were built with (L6) — a record naming `/x/.claude/` must find the outcome
        // filed under `/x/.claude`, or it would be read as "no matching row" and silently
        // under-reported. One global id map across dirs is still forbidden: it would let a job
        // id seen under account A vouch for a record belonging to account B.
        const dir = resolveConfigDir(rec.configDir);
        const row = dir === undefined ? undefined : byConfigDir.get(dir)?.rows?.get(rec.jobId);
        if (row === undefined) {
          // Either the dir went unchecked (unknown) or the row is absent (gone). Neither is
          // evidence of a running worker, and only evidence gets published here.
          return false;
        }
        // THE liveness test — see the header: a background row carries `pid` only when the CLI
        // holds a live process record for that job, while the row ITSELF also survives on a
        // persisted "working"/"blocked" state that a killed worker leaves behind. No pid ⇒ not
        // running ⇒ nothing is reported for this record.
        //
        // This pid is trustworthy HERE while the reaper's pid check is not, and both facts hold
        // at once: this one comes out of the CLI's own live-process record FOR THIS JOB ID,
        // matched by jobId, so it describes the process the row is about. The reaper instead
        // reads a session-registry entry looked up BY NAME, which can be stale and whose name
        // is reused across worker generations — so its pid can belong to a previous namesake.
        // Identity is what separates them, not the pid. What survives even that — recycling of
        // this very pid — is the OVER-reporting residual recorded in the header.
        if (typeof row.pid !== 'number' || !isPidAlive(row.pid)) {
          return false;
        }
        // `rowCwd.startsWith(root)` ALONE is a real bug: `/…/fable-orchestrator` is a string
        // prefix of `/…/fable-orchestrator-2`, so a neighbouring workspace's healthy workers
        // would be listed as this one's to stop. The separator is what makes this a path
        // boundary. And the boundary is only a boundary on a NORMALIZED path: path.isAbsolute
        // accepts `/a/proj/../proj2/x`, which escapes this workspace while passing a prefix
        // test against `/a/proj` — a false positive in the one check that exists as the safety
        // net. path.resolve fixes that LEXICALLY; realpathSync is deliberately not used, since
        // resolving symlinks would touch the filesystem and introduce a second notion of
        // workspace identity that nothing else in the mesh shares.
        const rowCwd = path.resolve(row.cwd);
        return rowCwd === root || rowCwd.startsWith(root + path.sep);
      });
    }
    const orphanEntries: string[] = [];
    const ghostEntries: string[] = [];
    const ownerlessEntries: string[] = [];
    for (const rec of alive) {
      // Same `worktreeKept === false` suppression the workers section uses: pointing at a
      // directory a teardown provably removed is worse than saying nothing. It is dead code
      // for an orphan (that flag is only written by a teardown, which a live orphan never
      // had) but not for a GHOST, which was marked stopped and may carry a removal verdict.
      //
      // `worktreeKept === true` carries the workers section's KEPT annotation verbatim, and
      // it is MORE load-bearing here than there: a ghost is precisely the record that has
      // been through a teardown, so it is the likeliest to hold one — and this entry is read
      // by someone weighing what to do about a session the ledger already believes is dead.
      // Printing a bare path there would drop "there is unmerged work in here" at exactly the
      // moment that judgement is made.
      const worktree =
        rec.worktree === undefined || rec.worktreeKept === false
          ? ''
          : `\n      worktree: ${oneLine(rec.worktree)}${rec.branch ? ` (branch ${oneLine(rec.branch)})` : ''}` +
            (rec.worktreeKept === true
              ? ' — KEPT: it still holds uncommitted or unpushed work, so teardown left it in place. Merge or remove it yourself.'
              : '');
      const identity =
        `  - ${oneLine(rec.name)} [${oneLine(rec.account)}] ${oneLine(rec.model)} — ` +
        `${rec.taskId ? `task ${oneLine(rec.taskId)}` : oneLine(rec.role)} — ` +
        `job ${oneLine(rec.jobId)}, alive under ${oneLine(rec.configDir)}`;
      // M5. `attachCommand` is assembled by the pool from the record's `configDir` and `jobId`,
      // so both halves come out of the ledger into a command a reader is being pointed at — and
      // a `configDir` of `'; touch /tmp/PWNED; echo '` or a `jobId` of `$(…)` is one file edit
      // away. So the command is only RENDERED when attachCommandWithholdReason passes it,
      // and otherwise WITHHELD with the reason it gave. Withholding costs a reader one manual
      // lookup; printing costs them whatever the ledger author wrote.
      //
      // The reason comes from the guard rather than being written here (M2/L1): the guard is the
      // only thing that knows WHICH of its clauses failed, and the one-size sentence this used to
      // print ("holds characters that are not safe to render") is false about an EMPTY jobId,
      // which adopt() can write and which holds no characters at all. `oneLine` still wraps the
      // rendered command; the guard's last clause is what makes that wrap a provable no-op
      // instead of a second, unchecked transform.
      const withheld = attachCommandWithholdReason(rec);
      const attach =
        withheld === undefined
          ? `      attach: ${oneLine(rec.attachCommand)}\n`
          : `      attach command WITHHELD: ${withheld}.\n`;
      // The sentences below point at that command, so they have to stop pointing when it is gone.
      const attachPointer =
        withheld === undefined
          ? 'The attach command above is the way to look at the session itself.'
          : 'No attach command could be printed for it, so this report offers no way to reach the session.';
      if (rec.ownerPid === undefined) {
        // The class the ledger knows the LEAST about, and the one whose entry has always said
        // so outright. All the ledger says about this record is "nobody is RECORDED as owning
        // it", which is not "nobody owns it" — every record adopt() writes looks precisely like
        // this, including the ones THIS session adopted at init, moments before an orchestrator
        // reads this section. The one fact still worth stating is that a stopped-marked record
        // will never be revisited by a sweep, because that holds no matter who owns it.
        const stopped =
          rec.stoppedAt === undefined
            ? ''
            : `\n      the ledger also marks this record stopped (${formatAgo(now - rec.stoppedAt)}), and ` +
              'no sweep pass will stop it: the ghost class is REPORT-ONLY';
        ownerlessEntries.push(
          `${identity}\n      owner: none recorded — which is NOT evidence that nobody owns it${stopped}` +
            `${worktree}\n${attach}` +
            '      Do NOT stop it on the strength of this line: THIS session may have adopted it at ' +
            'startup (adopt() writes records with no owner), and such a record can also be among ' +
            'the "dispatches in flight" counted above, which has no owner filter. Attach and find ' +
            'out whose work it is first.',
        );
      } else if (rec.stoppedAt === undefined) {
        // H1: this line does not predict (see the section header). It says what THIS session's
        // code does about the record — nothing on any timer: there is no idle auto-stop, and a
        // dispatch timeout only reaches the worker of a dispatch this session is itself waiting
        // on — and when the one pass that does act on a dead owner's worker runs.
        orphanEntries.push(
          `${identity}\n      owner: pid ${rec.ownerPid} not running${worktree}\n` +
            `${attach}` +
            '      This session does not own it and runs no timer that would stop it (there is no ' +
            "idle auto-stop). The orphan sweep, which stops a dead owner's worker it can prove is running, " +
            'runs when a session initializes the mesh and when the extension activates — not ' +
            `while a session is running. ${attachPointer}`,
        );
      } else {
        ghostEntries.push(
          // The age is formatAgo's, not a raw timestamp: it is total for every stoppedAt the
          // ledger can hold (a future one from clock skew degrades to "unknown"), where
          // Date#toISOString would throw on an out-of-range epoch and lose the whole section.
          //
          // What the ledger CANNOT establish is said in the line: it records nothing about
          // whether a person is attached to a session, so silence about that would read as
          // "nobody is in there".
          `${identity}\n      ledger says it was stopped (${formatAgo(now - rec.stoppedAt)}), but the ` +
            `session is still running.${worktree}\n${attach}` +
            '      No sweep pass reaps it: every pass skips a record that is already marked stopped. ' +
            'The ledger records nothing about whether anyone is attached to this session. ' +
            `${attachPointer}`,
        );
      }
    }
    const lines: string[] = [];
    if (orphanEntries.length > 0) {
      lines.push(
        `adoptable orphans (${orphanEntries.length}): workers alive under this workspace whose RECORDED ` +
          'owner session is gone.',
      );
      lines.push(...orphanEntries);
    }
    if (ghostEntries.length > 0) {
      lines.push(
        `ghosts (${ghostEntries.length}): marked stopped in the ledger but still ALIVE. The sweep ` +
          'DOES examine these — that is how they got into this report — but it deliberately stops ' +
          'nothing here, so no pass will reap them.',
      );
      lines.push(...ghostEntries);
    }
    if (ownerlessEntries.length > 0) {
      lines.push(
        `unowned in the ledger (${ownerlessEntries.length}): alive under this workspace with NO owner ` +
          'recorded — which is NOT the same as orphaned, and NOT a stop list. adopt() writes records ' +
          'without an owner and this session runs adopt() at init, so a worker THIS session adopted ' +
          'seconds ago appears here.',
      );
      lines.push(...ownerlessEntries);
    }
    if (uncheckable.length > 0) {
      // H2, then M3. The heading has now been wrong in both directions, and the current wording is
      // the one that fits the FILTER rather than the story:
      //   - it once said "no live owner" and "nothing at all is known about them". Both
      //     overclaimed: adopt() writes records with no ownerPid AND `jobId: ''`, so a worker THIS
      //     session adopted seconds ago at init is here BY CONSTRUCTION; and there is no stoppedAt
      //     filter on this class, so the ledger frequently does say something about one of these.
      //   - H2's fix then said "no RECORDED owner", which UNDER-claims (M3). This class is
      //     `unowned.filter(jobId === '' || configDir === '')`, and `unowned` keeps
      //     `ownerPid !== undefined && !isPidAlive(ownerPid)` — so a record naming a DEAD owner pid
      //     with an empty job id lands here too, under a heading asserting no owner was recorded
      //     and an adopt() story that does not describe it.
      // Both shapes are named, and the adopt() qualifier is kept for the shape it actually
      // explains, because the class must not read as a list of strangers that might need killing.
      lines.push(
        `not checkable (${uncheckable.length}): ledger records that either record NO owner or record ` +
          'an owner that is NOT RUNNING, and that cannot be matched against any listing, so this ' +
          'report cannot say whether they are running or gone. NOT a stop list, and not a list of ' +
          'strangers: the no-owner shape is what adopt() writes (no owner, empty job id) and this ' +
          'session runs adopt() at init, so a worker THIS session adopted seconds ago appears here:',
      );
      // Capped like every other cost in this feature (ORPHAN_MAX_UNCHECKABLE_ENTRIES): these
      // entries are the cheapest in the report to manufacture — no liveness evidence is needed
      // to print one, only a record missing a field — and this is a polled surface. The overflow
      // is COUNTED in a line of its own rather than truncated away.
      for (const rec of uncheckable.slice(0, ORPHAN_MAX_UNCHECKABLE_ENTRIES)) {
        const why =
          rec.jobId === ''
            ? 'no job id recorded, so no listing row can be matched to it and the ledger cannot even build ' +
              'an attach command (adopt() writes an empty job id when the session entry carried none)'
            : 'no config dir recorded, so there is no account to ask about it';
        // The ledger DOES know something about a stopped-marked record, so saying "nothing is
        // known" over the top of that would be the same overclaim the heading just dropped.
        const stopped =
          rec.stoppedAt === undefined
            ? ''
            : ` The ledger records it as stopped (${formatAgo(now - rec.stoppedAt)}), and no sweep ` +
              'revisits a record marked stopped.';
        lines.push(
          `  - ${oneLine(rec.name)} [${oneLine(rec.account)}] ${oneLine(rec.model)} — ` +
            `${rec.taskId ? `task ${oneLine(rec.taskId)}` : oneLine(rec.role)} — ${why}.${stopped}`,
        );
      }
      if (uncheckable.length > ORPHAN_MAX_UNCHECKABLE_ENTRIES) {
        lines.push(
          `  … and ${uncheckable.length - ORPHAN_MAX_UNCHECKABLE_ENTRIES} more not-checkable record(s) ` +
            `not listed: only ${ORPHAN_MAX_UNCHECKABLE_ENTRIES} are rendered per mesh_status call.`,
        );
      }
    }
    // Degradation is PER CONFIG DIR. A dir that could not be probed never suppresses the
    // real findings from the ones that could, and findings never suppress the admission that
    // part of the picture is missing — a blanket version of either is a lie in one direction.
    const unchecked = probes.filter((probe) => probe.unchecked !== undefined);
    if (unchecked.length > 0) {
      const checked = probes.length - unchecked.length;
      // L9. `found` must count EVERY class this call reported, including the not-checkable
      // entries: those are rendered directly above this head line, and counting only the three
      // probe-derived classes let the head say "nothing unowned … could be checked" immediately
      // under a list of unowned records the report had just printed. The two are one report and
      // may not contradict each other.
      const found =
        orphanEntries.length + ghostEntries.length + ownerlessEntries.length + uncheckable.length;
      const head =
        checked === 0
          ? `  orphan probe: NOT RUN — none of the ${probes.length} config dir(s) holding an unowned ` +
            'worker could be checked:'
          : found > 0
            ? `  orphan probe: checked ${checked} of ${probes.length} config dir(s); could not check:`
            : `  orphan probe: nothing unowned in the ${checked} of ${probes.length} config dir(s) that ` +
              'could be checked; could not check:';
      lines.push(
        [
          head,
          // The caveat rides on the LAST named dir so an empty list above can never be read
          // as "no orphans" — it is "no orphans WHERE WE LOOKED", and that has to be visible.
          //
          // These dirs are named by the RESOLVED path — the path a probe of that dir targets and
          // the path the trust test compared — so a line here can differ in spelling from the raw
          // ledger value an entry above prints as `alive under …`. That is deliberate: the
          // resolved path is the one that identifies the directory this report did not look into.
          // The single exception names itself, since the only dir keyed by its raw spelling is
          // the one whose reason is that it could not be resolved at all.
          ...unchecked.map(
            (probe, i) =>
              `      ${oneLine(probe.configDir)} (${probe.unchecked})` +
              (i === unchecked.length - 1 ? ' — this report may be missing workers.' : ''),
          ),
        ].join('\n'),
      );
    }
    // Last, and never conditional on anything above it: the records the ledger holds but this
    // report could not read at all (M8). It rides every return path out of this function.
    return lines.concat(faultLines);
  } catch (err) {
    // Unreachable by design — every probe outcome above is classified — and an unreadable or
    // corrupt ledger is NOT what lands here: readRawMeshState swallows its own read and parse
    // errors and answers `{}`, so pool.list() cannot throw for one (that case belongs to
    // ledgerReadFault, above). Reaching here therefore means something genuinely unexpected, a
    // fault in this code or below it, and printing nothing would be indistinguishable from
    // "nothing is unowned" — the one wrong answer. The message is one-lined like every other
    // foreign string here: it can carry a path that came straight out of the ledger.
    return [
      `  orphan probe: could not run (${oneLine(err instanceof Error ? err.message : String(err))}) — this ` +
        'report may be missing workers that are still running.',
    ];
  }
}

/**
 * mesh_status — the one place an orchestrator can see what it is holding open, across
 * accounts. NEVER throws mesh_off: with meshMode off it returns a static explanation and does
 * NOT initialize. With meshMode on it triggers ensureMesh so the report reflects live reality;
 * if init fails (busy, unsupported, a Claude Code too old for session workers) the failure is
 * folded into the readable text rather than surfaced as a tool error, because a status tool
 * must report a broken mesh, not error on it.
 */
async function meshStatus(): Promise<string> {
  const { registry, problem } = readRegistryChecked();
  const platform = meshPlatformSupported()
    ? `platform: supported (${process.platform})`
    : `platform: UNSUPPORTED (${process.platform}) — mesh needs macOS or Linux`;
  const unreadable = registryProblemText(problem);
  if (unreadable !== undefined) {
    // Still a report, not an error — but one that LEADS with what it could not learn. Whether
    // Mesh Mode is on is a setting in the file that could not be read, so "OFF" (what the
    // default registry says) would be a statement about a switch nobody looked at. Nothing is
    // initialized on the strength of a guess either way.
    return [
      unreadable,
      'Mesh mode: UNKNOWN — whether it is on is a setting in that file, so the mesh was not ' +
        'initialized by this call and nothing is reported about session workers.',
      platform,
    ].join('\n');
  }
  if (registry.meshMode !== 'on') {
    return [
      'Mesh mode: OFF (experimental).',
      'Enable "claudeCodeOrchestrator.meshMode" in the extension settings to run dispatched ' +
        'workers as persistent, attachable background sessions.',
      platform,
      'The mesh is not initialized while mesh mode is off; every dispatch runs a one-shot worker.',
    ].join('\n');
  }
  let initError: string | undefined;
  try {
    await ensureMesh();
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }
  const lines: string[] = [
    'Mesh mode: ON (experimental) — every non-detach dispatch runs as an attachable background worker.',
    platform,
  ];
  // Owner lock read straight from disk, so it shows even when init failed (e.g. busy).
  const state = readMeshState(meshStateFile(process.cwd()));
  if (state) {
    if (state.ownerPid === process.pid) {
      lines.push(`owner lock: held by THIS session (pid ${process.pid})`);
    } else if (isPidAlive(state.ownerPid)) {
      lines.push(`owner lock: held by another session (pid ${state.ownerPid})`);
    } else {
      lines.push(`owner lock: stale (pid ${state.ownerPid} not running) — takeable`);
    }
  } else {
    lines.push('owner lock: none recorded');
  }
  if (initError) {
    lines.push(`mesh not fully initialized: ${initError}`);
    lines.push('dispatches fall back to one-shot workers and say so in their result.');
  }
  const now = Date.now();
  // ONE ledger read for the count beside the cap and for the list at the bottom, so the two
  // cannot describe different moments.
  const workers = mesh.pool?.list() ?? [];
  let inFlight = 0;
  try {
    inFlight = mesh.pool?.inFlightCount() ?? 0;
  } catch {
    inFlight = 0;
  }
  // The cap counts dispatches still IN FLIGHT, not sessions. A PARKED worker — its dispatch
  // settled, its session still running — holds no slot, so it is counted beside that number
  // rather than in it: it is what the orchestrator has left attachable, and has yet to stop.
  const parked = workers.filter(
    (w) => w.stoppedAt === undefined && w.settledAt !== undefined && w.alive,
  ).length;
  lines.push(
    `dispatches in flight: ${inFlight}/${registry.meshMaxLiveWorkers} (meshMaxLiveWorkers) · ` +
      `parked workers: ${parked} (dispatch settled, still attachable; they hold no slot)`,
  );
  // Workers running under this workspace that this session does NOT own — orphans of a dead
  // owner, and ghosts the ledger already believes are stopped. Placed directly under the
  // in-flight count because the two answer DIFFERENT questions, and they can overlap: that
  // count is ledger arithmetic with no ownerPid filter at all, so an unsettled worker whose
  // owner died is counted in that line AND reported as an orphan in these. Ghosts are the one
  // class the count does exclude, and only because it skips records with stoppedAt set.
  lines.push(...(await unownedWorkerLines()));
  const rejected = bgRejectedResultCount();
  if (rejected > 0) {
    // The newest one is worth a line: it names the file and which kind of refusal it was, the
    // single most useful clue when a dispatch is not settling from a file that is there. Both
    // halves are this server's own text — a path it built and a reason composed of literals —
    // and nothing in the line is quoted from the refused file; it is one-lined like every
    // other value on this report.
    const newest = bgLastRejectedResult();
    lines.push(
      `rejected result files: ${rejected} (a session worker's result file that was refused and ` +
        'settled nothing: its token was missing, was a placeholder or a whole header line copied ' +
        "in its place, was another token, or was not a token at all; the task id inside it was not " +
        "its task's; or what is at the result path is not a regular file)" +
        (newest ? `\n      newest: ${oneLine(newest)}` : ''),
    );
  }
  if (mesh.bridge) {
    const s = mesh.bridge.status();
    lines.push(
      `bridge: ${s.participants} participant(s), ${s.mirrors} mirror(s) — mirrors the session ` +
        "entries of workers under other accounts into this session's account, which is what lets " +
        `your SendMessage address them by name${s.degraded ? ` (degraded: ${s.degraded})` : ''}`,
    );
  } else {
    lines.push('bridge: not initialized');
  }
  if (workers.length === 0) {
    lines.push('workers: none');
  } else {
    lines.push(`workers (${workers.length}):`);
    // An elapsed time read off the ledger, never a forecast. A stamp formatAgo cannot age (in
    // the future, out of range) is said to be exactly that.
    const since = (label: string, at: number): string => {
      const ago = formatAgo(now - at);
      return ago === 'unknown' ? `${label} at a time this report cannot age` : `${label} ${ago}`;
    };
    for (const w of workers) {
      // FOUR words, and `dead` is only ever a finding. `alive: false` is what the pool answers
      // for a worker proven gone AND for one nobody could look at — a record whose account is
      // not configured in this version, a session registry that could not be read whole, a
      // worker spawned moments ago that has not registered yet — and it says which by setting
      // `livenessUnknown` (MeshWorkerStatus). Such a record reads `unknown` with the pool's own
      // sentence: its session may be running right now, it still holds its slot, and its
      // dispatch is not finished on anybody's evidence.
      const unknownWhy =
        w.stoppedAt === undefined && !w.alive && typeof w.livenessUnknown === 'string' && w.livenessUnknown !== ''
          ? oneLine(w.livenessUnknown)
          : undefined;
      const health =
        w.stoppedAt !== undefined
          ? 'stopped'
          : w.alive
            ? 'alive'
            : unknownWhy !== undefined
              ? `unknown (${unknownWhy})`
              : 'dead';
      // `registryStatus` is a raw string out of a session entry in an account's sessions dir
      // — a file this process does not write and does not validate — so it is projected like
      // every other foreign value on this line.
      // Not printed beside `unknown`: the status an entry was last seen with says nothing about
      // a worker whose entry could not be established as its own running session.
      const reg = w.registryStatus && unknownWhy === undefined ? `/${oneLine(w.registryStatus)}` : '';
      const exhausted = w.accountExhausted ? ' ⚠account-exhausted' : '';
      // The mode the worker was actually STARTED in, which is what decides whether a message
      // to it is delivered or held (bypass-permissions is a different class, and session
      // workers are never started in it). Absent on records written before it was recorded.
      const mode =
        typeof w.permissionMode === 'string' && w.permissionMode !== ''
          ? ` · mode ${oneLine(w.permissionMode)}`
          : '';
      // Where the worker stands relative to its dispatch: stopped, parked after a settle, or
      // still working since its spawn.
      const phase =
        w.stoppedAt !== undefined
          ? since('stopped', w.stoppedAt)
          : w.settledAt !== undefined
            ? since('dispatch settled', w.settledAt)
            : since('spawned', w.spawnedAt);
      // Same one-line projection the orphan/ghost entries use, for the same reason and one
      // sharper vector: `title` is the DISPATCH-SUPPLIED task title, so a title carrying
      // newlines could forge a whole section header here — and now that mesh_status prints
      // adoptable-orphan and ghost sections, a forged header is a fabricated report that
      // somebody's live worker is an orphan or a ghost — the very report the doctrine's action
      // policy is read against. Sanitizing only the new sections would leave the older, more
      // reachable vector open.
      // Same withholding rule the orphan/ghost entries use, through the SAME guard, and for the
      // same reason: the attach command is assembled by the pool out of the record's config dir
      // and job id, so a ledger value carrying a quote or a shell metacharacter could turn a line
      // a human is invited to paste into a command that runs something else. Withholding it in
      // the orphan sections while still printing it verbatim here would leave the identical
      // string in the identical report. This list is also where the EMPTY-value wording earns
      // its keep (L1): adopt() can write an empty job id, those records are listed here, and
      // telling their reader the value "holds characters that are not safe" was false.
      const attachLine = (rec: { configDir: string; jobId: string; attachCommand: string }): string => {
        const reason = attachCommandWithholdReason(rec);
        return reason === undefined
          ? `attach: ${oneLine(rec.attachCommand)}`
          : `attach command WITHHELD: ${reason}.`;
      };
      // The key mesh_stop_worker resolves to exactly one worker. It was reachable before only by
      // reading it back out of the attach command — and withheld entirely whenever that command
      // was — while the name printed at the head of this line can match several ledger records,
      // because names are reused across generations. Printing it is not advice about what to do
      // with the worker: it is the identifier the acting tool accepts, next to the worker it
      // identifies. An empty job id is adopt()'s (the session entry carried none), and there is
      // nothing to print for it.
      const jobKey = w.jobId === '' ? '' : ` · job ${oneLine(w.jobId)}`;
      const title = oneLine(bgPendingTitle(w.taskId) ?? '') || undefined;
      const job = w.taskId
        ? `${oneLine(w.role)} ${oneLine(w.taskId)}${title ? ` "${title}" (in flight)` : ''}`
        : oneLine(w.role);
      // A11: the worktree line is how unmerged work stays visible. It is printed for every
      // worker that has one EXCEPT those whose worktree we watched `claude rm` remove
      // (worktreeKept === false) — pointing at a directory that is provably gone would be
      // worse than saying nothing. A KEPT worktree is the loud case: the platform refused
      // to remove it because it still holds work nobody has merged.
      const worktreeLine =
        w.worktree === undefined || w.worktreeKept === false
          ? ''
          : `\n      worktree: ${oneLine(w.worktree)}${w.branch ? ` (branch ${oneLine(w.branch)})` : ''}` +
            (w.worktreeKept === true
              ? ' — KEPT: it still holds uncommitted or unpushed work, so teardown left it in place. Merge or remove it yourself.'
              : '');
      // How to TALK to it. A live worker is a peer session, addressed by name with the
      // orchestrator's own SendMessage — but only once an entry for it exists in this
      // session's account (its own, or the bridge's mirror), which the pool reports. The name
      // is printed as an address only in the exact shape this workspace mints, because it is
      // a ledger value and this line is one a model acts on.
      const peerLine =
        w.stoppedAt !== undefined || !w.alive
          ? ''
          : w.peerVisible === false
            ? "\n      peer: not visible to this session's account yet (mirror pending)"
            : parseMeshWorkerName(w.name, process.cwd()) !== undefined
              ? `\n      peer: SendMessage(to: "${w.name}")`
              : '';
      lines.push(
        `  - ${oneLine(w.name)} [${oneLine(w.account)}] ${oneLine(w.model)}${mode} — ${job} — ` +
          `${health}${reg}${exhausted} · ${phase}${jobKey}${worktreeLine}${peerLine}\n      ${attachLine(w)}`,
      );
    }
  }
  return lines.join('\n');
}

/** The arguments of one mesh_stop_worker call, after checkMeshStopArgs. */
interface MeshStopArgs {
  /** The job id it named, trimmed; '' when it named none. */
  jobId: string;
  /** The worker name it named, trimmed; '' when it named none. */
  name: string;
  force: boolean;
}

/** The longest `job_id` or `name` accepted: far above any real one, and it is echoed in the answer. */
const MESH_STOP_KEY_MAX_CHARS = 200;

/**
 * Check the arguments of mesh_stop_worker by type and size — before the mesh is initialized on
 * the call's behalf, and before anything is looked up. `job_id` and `name` are each a single
 * line of text when given (absent, null and blank are "not given"); `force` is a real boolean.
 * Which of the two keys was given, and that it is exactly one, is meshStopWorker's to judge.
 */
function checkMeshStopArgs(args: Record<string, unknown>): Checked<MeshStopArgs> {
  const key = (field: 'job_id' | 'name'): Checked<string> => {
    const value = args[field];
    if (value === undefined || value === null) {
      return { ok: true, value: '' };
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `invalid ${field} — expected a string, got ${kindOf(value)}` };
    }
    const text = value.trim();
    if (text.length > MESH_STOP_KEY_MAX_CHARS) {
      return {
        ok: false,
        error: `invalid ${field} — ${text.length} characters; the limit is ${MESH_STOP_KEY_MAX_CHARS}`,
      };
    }
    if (/[\u0000-\u001f\u007f]/.test(text)) {
      return { ok: false, error: `invalid ${field} — expected a single line of text, got "${echoed(text)}"` };
    }
    return { ok: true, value: text };
  };
  const jobId = key('job_id');
  if (!jobId.ok) {
    return jobId;
  }
  const name = key('name');
  if (!name.ok) {
    return name;
  }
  const force = args.force;
  if (force !== undefined && force !== null && typeof force !== 'boolean') {
    return { ok: false, error: `invalid force — expected true or false, got ${kindOf(force)}` };
  }
  return { ok: true, value: { jobId: jobId.value, name: name.value, force: force === true } };
}

/**
 * mesh_stop_worker — run `claude stop` for one worker under its account (force falls back to
 * SIGKILL). `args` are the checked arguments of the call (checkMeshStopArgs).
 *
 * TWO KEYS, ONE OF WHICH ACTUALLY IDENTIFIES A WORKER. `job_id` is the job id mesh_status prints
 * for every worker it lists: it is minted per SPAWN, so it selects exactly one ledger record or
 * none. `name` is what this tool used to take alone, and a worker name is REUSED across
 * generations — a ledger holding a retained stopped record and a live worker of one name made
 * "stop it" a coin flip decided by array order, which is how an operator stopping a finished
 * worker killed a running one. `name` still works and still means what it says when it identifies
 * one record; when it identifies several, WorkerPool.stop refuses and names the job ids it
 * matched, and the caller comes back with one of them.
 *
 * Supplying both is refused rather than reconciled: two keys that disagree have no correct
 * resolution, and picking either would be the guess this tool exists to stop making. That, and
 * a call that names neither, is refused BEFORE the mesh is initialized: a request that cannot
 * name a worker must not cost an owner claim and a version probe.
 *
 * THE WORKSPACE SCOPE IS UNCHANGED and is not weakened by the second key: both are resolved
 * against THIS workspace's ledger inside the pool (readWorkers() reads one file, keyed by this
 * cwd), so neither a name nor a job id from another workspace can name a target here.
 */
async function meshStopWorker(args: MeshStopArgs): Promise<string> {
  const { jobId, name } = args;
  if (jobId !== '' && name !== '') {
    throw new Error(
      meshError(
        'invalid_input',
        'pass "job_id" OR "name", not both: they can name different records and nothing here may ' +
          'choose between them. The job id is the key that identifies exactly one worker.',
      ),
    );
  }
  if (jobId === '' && name === '') {
    throw new Error(
      meshError(
        'invalid_input',
        '"job_id" must be a job id from mesh_status (the key that identifies exactly one worker), ' +
          'or "name" a worker name from mesh_status (names are reused across generations, so a name ' +
          'that matches several records is refused rather than guessed at).',
      ),
    );
  }
  // Said as itself, ahead of the mesh's own refusal: which accounts exist, and whether Mesh
  // Mode is on, are both in the file that could not be read.
  const unreadable = registryProblemText(readRegistryChecked().problem);
  if (unreadable !== undefined) {
    throw new Error(`${unreadable} No worker was stopped.`);
  }
  await ensureMesh();
  const pool = mesh.pool;
  if (pool === undefined) {
    throw new Error(
      meshError('capability_failed', 'the mesh reported initialized but its worker pool is missing.'),
    );
  }
  // 'either' for a name, because an operator pasting a job id into the field this tool has always
  // had must not be told the worker does not exist; 'jobId' when the caller used the explicit
  // field, so that key is resolved as a job id and never as a name.
  const target = jobId !== '' ? jobId : name;
  const result = await pool.stop(target, {
    force: args.force,
    by: jobId !== '' ? 'jobId' : 'either',
  });
  if (result.ok) {
    // The pool's note says what the plain reply cannot: that the target was already gone, or which
    // of several same-named records this stop actually acted on.
    return `stopped ${target}.${result.note ? ` (${result.note})` : ''}`;
  }
  // The pool's refusals carry their own code in the wire format — `unknown_worker` when the key
  // matched no record of this workspace, `invalid_input` when it matched several,
  // `capability_failed` when the worker could not be confirmed or stopped — and are relayed as
  // they are. A failure that carries NO code is relayed under none: it is not known to be any of
  // those, and calling it `unknown_worker` would tell the caller that a worker which is right
  // there in mesh_status does not exist.
  if (typeof result.error === 'string' && /^mesh error \[/.test(result.error)) {
    throw new Error(result.error);
  }
  throw new Error(
    `mesh_stop_worker did not stop "${target}": ` +
      (typeof result.error === 'string' && result.error.trim() !== ''
        ? result.error
        : 'the worker pool gave no reason. mesh_status shows what the worker is doing now.'),
  );
}

/**
 * Stop the mesh subsystems on server shutdown. Stops every `--bg` worker this process
 * owns (P4.9), the bridge (prunes the registry mirrors it wrote) and the stale-io loop, then
 * releases the owner lock by rewriting ownerPid 0 so the next session takes over instantly.
 * That release writes ownerPid alone, under the ledger write lock — the worker ledger is
 * preserved because nothing here can address it — and only ever releases a lock that still
 * names us. Never throws (called from shutdown, itself called from signal handlers).
 *
 * Attachable workers used to be left running deliberately; that was the v1.4 leak this
 * rework closes: a worker whose owning session is gone has nobody left to attach to it from,
 * so the no-leak guarantee outranks everything else. The stops are fire-and-forget (detached,
 * unref'd `claude stop` children) because shutdown must not wait on them.
 */
function stopMesh(): void {
  try {
    if (mesh.claudePath !== undefined) {
      fireAndForgetStopOwned(process.cwd(), process.pid, mesh.claudePath);
    }
  } catch {
    // best effort — the activation-time orphan reaper is the backstop for whatever
    // survives this, and taskBases below still authors the terminal events
  }
  try {
    mesh.bridge?.stop();
  } catch {
    // best effort — exiting regardless
  }
  try {
    mesh.stopLoops?.();
  } catch {
    // best effort — the interval is unref'd and dies with the process anyway
  }
  if (mesh.ownerLocked) {
    try {
      const current = readMeshState(meshStateFile(process.cwd())) ?? mesh.state;
      if (current && current.ownerPid === process.pid) {
        // The release writes ownerPid ONLY, under the ledger write lock (F1 completeness).
        // The old `{...current, ownerPid: 0}` re-wrote the whole file, putting back a
        // `workers` array read a moment earlier — and this runs at session end, exactly
        // when the extension host's activation reaper and the tree cancel are most likely
        // to be writing stopped marks into it.
        //
        // The read above is only a "have we anything to say" test. The DECIDING check is
        // the one inside the mutator: it sees the freshest bytes under the lock, so
        // "never release a lock that no longer names me" stops being a TOCTOU. A record
        // that no longer names us (or a state file that is gone or corrupt) changes
        // nothing, and a mutation that changes nothing writes nothing — so a shutdown can
        // neither resurrect a deleted state file nor overwrite a corrupt one with this
        // process's stale in-memory idea of it.
        mutateMeshOwnerFields(process.cwd(), (owner) => {
          if (owner.ownerPid === process.pid) {
            owner.ownerPid = 0;
          }
        });
      }
    } catch {
      // best effort — a lock left with our pid is broken by liveness once we exit anyway
    }
    // Drop the atomic claim marker (M1) so the next session takes over without a stale-lock
    // break. releaseMeshLock only removes a marker that still records our pid.
    if (mesh.lockFile) {
      releaseMeshLock(mesh.lockFile);
    }
  }
}

/** The longest model id orchestrator_briefing accepts. */
const BRIEFING_MODEL_MAX_CHARS = 100;

const TASK_PROPERTIES = {
  title: {
    type: 'string',
    description: `Short label for the task list UI — one line; a longer one is cut at ${DISPATCH_TITLE_MAX_CHARS} characters.`,
  },
  prompt: {
    type: 'string',
    description: 'Complete, self-contained instructions for the worker, with all needed context.',
  },
  model: {
    type: 'string',
    description:
      `A model alias (${MODEL_ALIASES.join(', ')}) — each always means the newest model of its ` +
      'family — or a full model id to pin one. opus for hard reasoning/coding subtasks; sonnet ' +
      'for simpler or high-volume ones; fable ONLY for the highest-leverage dispatches — ' +
      'contract design/consult and adversarial review — and only when list_workers shows ' +
      'frontier dispatch enabled: it is the most expensive resource here (separate scarce quota, ' +
      'or pay-per-use billing on some plans) and the server rejects it when the operator has it ' +
      'blocked. A value that is neither an alias nor a well-formed model id is REJECTED, not ' +
      "replaced. Omit it to use the worker's configured default. For a worker on another vendor's " +
      "CLI (see `provider`) pass THAT vendor's own model id instead — list_workers suggests some; " +
      'it is checked for shape only, and the vendor CLI is what rejects an id it does not have.',
  },
  worker: {
    type: 'string',
    description:
      'Optional worker account name (see list_workers). Omit for automatic assignment with quota-aware ' +
      'failover. Workers whose live plan usage shows an exhausted window (>=99% and not yet reset) are ' +
      'skipped by automatic assignment and refused when named explicitly. Workers whose login has ' +
      'expired (shown as LOGGED OUT by list_workers) are skipped and refused the same way until ' +
      'the account is re-logged in — a completed re-login is detected automatically on the next ' +
      "dispatch, so retrying after re-logging in is enough. Naming a worker on another vendor's CLI " +
      'runs the task there (see `provider` for what that means); no `provider` is needed with it.',
  },
  provider: {
    type: 'string',
    description:
      `OPT-IN: run this task on another vendor's agent CLI. One of ${PROVIDER_IDS.join(', ')} ` +
      '(claude = Claude Code, the default; gemini = Antigravity). Omit it and the task only ever ' +
      'runs on a Claude Code worker, never on another vendor — unless `worker` names one. With a ' +
      "non-Claude provider any of that vendor's worker accounts may take the task (list_workers " +
      'shows which exist), with the usual cooldown and failover among them. A non-Claude worker ' +
      'runs ONE-SHOT even when Mesh Mode is on, edits the working tree IN PLACE (no worktree, no ' +
      "branch), is not attachable or steerable, and takes that vendor's own model ids in `model`. " +
      'An unknown value, or one that contradicts the named `worker`, is REJECTED.',
  },
  system_prompt: {
    type: 'string',
    description:
      'Optional system prompt appended to the worker session. Use it to give the worker a role, ' +
      'quality bar, constraints, and output format — a well-crafted system prompt here substantially ' +
      'improves worker output on complex tasks.',
  },
  ultrathink: {
    type: 'boolean',
    description:
      'Escalate this worker to its maximum reasoning depth. Set true for contract-critical ' +
      'implementation, subtle debugging, and adversarial reviews; leave unset for routine tasks ' +
      '(it spends substantially more thinking tokens).',
  },
  timeout_minutes: {
    type: 'number',
    description:
      "Optional per-task wall-clock limit in minutes (1–480). Defaults to the operator's " +
      'workerTimeoutMinutes setting (45). Raise it for long implementation or adversarial-review ' +
      'dispatches; a worker killed by this limit loses whatever it had not yet written to disk.',
  },
  detach: {
    type: 'boolean',
    description:
      'Opt in to survival: a background supervisor owns this task, records its result, and keeps ' +
      'running even if this session ends mid-dispatch. Blocking and the returned result are ' +
      'unchanged — while this session stays alive you get the identical inline result. Leave unset ' +
      'for the default, where a task is cancelled if the session ends before it finishes. A ' +
      'detached task always runs as a one-shot worker, even with Mesh Mode on: survival is not ' +
      'attachability (an attachable worker belongs to this session and is stopped when it ends).',
  },
};

/**
 * Appended to both dispatch tool descriptions. Static on purpose: tool descriptions are
 * read once by the client at tools/list, so a sentence that tried to report the CURRENT
 * mesh state would be a stale claim the moment the operator toggles the setting.
 */
const MESH_DISPATCH_NOTE =
  ' When Mesh Mode is on, workers run as persistent, attachable background sessions that you ' +
  'can message with your own SendMessage — the result names each one on its "peer:" line (see ' +
  'mesh_status; one-shot when off or when detach is set).';

/**
 * Appended to both dispatch tool descriptions, before the mesh note: what comes back for a long
 * report (the bound is relayText's RELAY_TEXT_MAX_BYTES). Static, like the notes around it.
 */
const RESULT_SIZE_NOTE =
  " A task's result comes back whole up to 1 MiB; a longer one is cut there and ends with a " +
  'line naming the output file that holds all of it.';

/** Appended to both dispatch tool descriptions, after the mesh note. Static for the same reason. */
const PROVIDER_DISPATCH_NOTE =
  " A task can also be sent to a worker account on another vendor's agent CLI — Codex, Cursor " +
  'or Antigravity — but only when it asks: see `provider` (and `worker`). Such a worker always ' +
  'runs one-shot and edits the working tree in place.';

const TOOLS = [
  {
    name: 'dispatch_tasks',
    description:
      'Dispatch MULTIPLE independent tasks to worker Claude accounts in ONE call — they run in ' +
      'parallel across accounts (quota-aware round-robin), as many at a time as the operator\'s ' +
      'concurrency limit allows (8 unless changed); the rest wait their turn, and list_workers ' +
      'shows how many are waiting. ALWAYS prefer this over several dispatch_task calls when you ' +
      `have more than one subtask. At most ${DISPATCH_BATCH_MAX_TASKS} tasks per call, and one malformed task ` +
      'refuses the whole call before anything runs. ' +
      'Each worker is a full Claude Code session with file and shell access to this ' +
      'workspace, but it does NOT see this conversation — every prompt must be complete and ' +
      'self-contained. Give each task a strong system_prompt (role, quality bar, output format). ' +
      'Do the integration, judgment, and final synthesis yourself.' +
      RESULT_SIZE_NOTE +
      MESH_DISPATCH_NOTE +
      PROVIDER_DISPATCH_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: DISPATCH_BATCH_MAX_TASKS,
          items: {
            type: 'object',
            properties: TASK_PROPERTIES,
            required: ['title', 'prompt'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'dispatch_task',
    description:
      'Dispatch ONE self-contained task to a worker Claude account (full Claude Code session in ' +
      'this workspace; it does NOT see this conversation, so the prompt must be complete). For ' +
      'multiple subtasks use dispatch_tasks instead — it runs them in parallel. On quota errors ' +
      'the task automatically fails over to another worker when one is available.' +
      RESULT_SIZE_NOTE +
      MESH_DISPATCH_NOTE +
      PROVIDER_DISPATCH_NOTE,
    inputSchema: {
      type: 'object',
      properties: TASK_PROPERTIES,
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'dispatch_status',
    description:
      'Inspect or retrieve the result of a dispatched task by id — including a background (detach) ' +
      'task whose session was interrupted. Read-only: it reports the latest status (running, done, ' +
      'or error) and, for a finished task, its result text — whole up to 1 MiB; a longer one is ' +
      'cut there and ends with a line naming the output file that holds all of it. Pass a single ' +
      `"id", or "ids" for up to ${STATUS_MAX_IDS} at once. A task this server has no record of is reported as ` +
      'not_found; if the task log itself cannot be read the call FAILS and says so — that is ' +
      'not the same thing, and the tasks may well exist.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A single dispatched-task id to inspect.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: STATUS_MAX_IDS,
          description: `Several dispatched-task ids to inspect in one call (at most ${STATUS_MAX_IDS}).`,
        },
      },
    },
  },
  {
    name: 'orchestrator_briefing',
    description:
      'REQUIRED once per session, BEFORE the first dispatch: register which model this ' +
      'orchestrator session is running (pass your exact model ID from your system prompt). ' +
      'Returns the operating brief for your model tier — apply the returned rules for the rest ' +
      'of the session. Also surfaces the main-session model in the orchestrator dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description:
            'Exact model ID of this (main/orchestrator) session, e.g. from your system prompt — one ' +
            `line of at most ${BRIEFING_MODEL_MAX_CHARS} characters.`,
        },
      },
      required: ['model'],
    },
  },
  {
    name: 'list_workers',
    description:
      'List registered worker Claude accounts with their default models, cumulative usage ' +
      '(tasks, tokens, cost) and availability (cooldowns after quota errors), plus LIVE claude.ai ' +
      'plan usage for this session and every worker account: session (5hr), weekly (7 day) and ' +
      'weekly Fable utilization with reset times, plus per-account overage-billing state ' +
      '(overage: off, or overage: ON ⚠ with the monthly spend/cap) so you can tell whether ' +
      'overrunning a plan window blocks work or bills real money. Check this before large ' +
      'fan-outs to pick models/workers deliberately and avoid accounts near a limit. Every worker ' +
      "is shown with the CLI it runs on; one on another vendor's CLI (Codex, Cursor, Antigravity) " +
      'also shows its login state, its usage windows whenever a reading exists, and suggested ' +
      'model ids — such workers are opt-in per dispatch (`worker` or `provider`). Every Claude Code ' +
      'account line ends with its login state and when it was checked; "logged out" is said only ' +
      'for a logout confirmed twice. check: true re-probes every Claude Code account live first ' +
      '(at most 15 s); diagnostics: true adds each account\'s last login probes.',
    inputSchema: {
      type: 'object',
      properties: {
        check: { type: 'boolean', description: 'Re-probe every Claude Code account live before answering (at most 15 s).' },
        diagnostics: { type: 'boolean', description: "Append each Claude Code account's last login probes." },
      },
    },
  },
  // Experimental Mesh Mode tools: the schemas from the mesh contract, spread in verbatim so the
  // extension and server can never disagree on their shape. Two of them — mesh_status and
  // mesh_stop_worker. Talking to a worker is the orchestrator's own SendMessage, so the send,
  // receive and keep-alive tools v1.x listed here are gone; a call to one of those names gets
  // the same unknown-tool error as any other name this server never had.
  ...MESH_TOOLS,
];

/**
 * The lead's team operations as tools (team contract §7.5): listed by tools/list and callable by
 * tools/call in HOST MODE ONLY — the stdio server never lists them, and answers a call of one with
 * TEAM_TEXT.teamOpsStdio. Their one client is `cco team_*` (cli.ts), which builds the arguments
 * from the lead's files and flags (§7.2, §7.3); the engine checks every value (TeamEngine.toolCall).
 * So the schemas say only "an object": the contract of the arguments is TeamOpArgs, not a JSON
 * schema a model would read.
 */
const TEAM_TOOLS = TEAM_OPS.map((name) => ({
  name,
  description: `Teammate mode: the lead's ${name} operation — run it as ${COMMAND_SPELLING} ${name} from the Bash tool.`,
  inputSchema: { type: 'object' },
}));

type JsonRpcId = string | number | null;

/**
 * In-flight tools/call count. Stdin close no longer drains it — a gone client
 * reads no responses — but shutdown() is the only exit path once stdin is closed.
 */
let pending = 0;
let stdinClosed = false;

function maybeExit(): void {
  // Never race shutdown()'s SIGKILL grace: exiting here would orphan any child
  // that has not yet died from SIGTERM.
  if (shuttingDown) {
    return;
  }
  // A host never ends here: it has no stdin, and its life is its session's (mcp/host.ts — the
  // session watch calls shutdown()). Its clients come and go; their leaving ends nothing.
  if (hostTransport !== undefined) {
    return;
  }
  if (stdinClosed && pending === 0) {
    process.exit(0);
  }
}

/**
 * Write one message to the client. Never throws: a client that is gone reads nothing anyway.
 *
 * On stdio: one line on stdout, exactly as always. In host mode the message goes to the
 * transport, which sends an answer to the connection its request came on under the client's own
 * id, and drops it when that connection is gone (mcp/host.ts).
 */
function send(message: Record<string, unknown>): void {
  if (hostTransport !== undefined) {
    hostTransport.send(message);
    return;
  }
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  } catch {
    // stdout is closed — the end of stdin (or the stream's own 'error') ends the session
  }
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ id, error: { code, message } });
}

/**
 * Send the result of a tools/call — THE one place a tool result is built, so that every one of
 * them has the same shape: a single text item whose `text` IS a string.
 *
 * That last part is checked here and not assumed. JSON drops a member whose value is undefined,
 * so a text that was not a string — a number relayed out of a file, a field that was not there
 * — once reached the client as `{"content":[{"type":"text"}]}`: an item with no text at all.
 * Whatever a tool hands over, what leaves is a string; one that was not is replaced by a
 * sentence saying so, as an error.
 *
 * `structured` (list_workers' WorkersSnapshot) rides along on a successful result only: an error
 * answer is text alone, and a result whose text was replaced carries none of the data either.
 */
function sendToolResult(id: JsonRpcId, text: unknown, isError: boolean, structured?: WorkersSnapshot): void {
  if (typeof text !== 'string') {
    sendResult(id, {
      content: [
        {
          type: 'text',
          text: 'Error: the tool produced no text — a defect in cco-dispatch, not in the request.',
        },
      ],
      isError: true,
    });
    return;
  }
  if (isError) {
    sendResult(id, { content: [{ type: 'text', text }], isError: true });
  } else if (structured !== undefined) {
    sendResult(id, { content: [{ type: 'text', text }], structuredContent: structured });
  } else {
    sendResult(id, { content: [{ type: 'text', text }] });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a caught value is a fault of this program rather than a refusal it raised on purpose.
 * Every refusal in the dispatch path is a plain `Error` (or a class of this codebase derived
 * from it) carrying a sentence written for the caller; what the language itself throws for a
 * mistake in the code — a TypeError, a RangeError — and anything thrown that is not an Error at
 * all, is not.
 */
function isDefect(err: unknown): boolean {
  return (
    !(err instanceof Error) ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof EvalError ||
    err instanceof URIError
  );
}

/**
 * What a failed tool call tells the caller: the refusal's own sentence when the failure IS a
 * refusal, and otherwise our words. Never the text of an exception the caller could do nothing
 * with — `args.prompt?.trim is not a function`, `ENOENT: no such file or directory, open '…'` —
 * which is said on stderr instead, in one line, for whoever maintains this server.
 */
function failureText(tool: string, err: unknown): string {
  const code = errnoOf(err);
  if (code === undefined && !isDefect(err)) {
    const message = errorMessage(err);
    if (message.trim() !== '') {
      return message;
    }
  }
  let said: string;
  try {
    said = flattenOneLine(err instanceof Error ? `${err.name}: ${err.message}` : err);
  } catch {
    said = '';
  }
  stderrLine(`cco-dispatch: ${tool} failed: ${sliceOneLine(said, 500) || 'no description was given'}`);
  return code !== undefined
    ? `the ${tool} call failed on a file or process operation of the dispatch server (${code}). ` +
        `Check that ${oneLine(TASKS_DIR)} exists, is writable and has free space, then retry.`
    : `the ${tool} call failed inside the dispatch server — a defect in cco-dispatch, not in the ` +
        "request. The details are on the server's stderr; the same call will most likely fail the same way.";
}

/** Why a record could not be written, as one bounded sentence fit for a `note:` line. */
function unrecordedReason(err: unknown): string {
  const code = errnoOf(err);
  if (code !== undefined) {
    return `the write failed (${code}).`;
  }
  if (isDefect(err)) {
    return 'the write failed inside the dispatch server.';
  }
  // The registry's own refusals (isStateWriteRefusal) are complete sentences written for the
  // person at the keyboard — what happened, that nothing was changed, what to do — and so is
  // every other plain Error this path can raise.
  const said = sliceOneLine(flattenOneLine(errorMessage(err)), 1000);
  return said === '' ? 'no reason was given.' : /[.!?…]$/.test(said) ? said : `${said}.`;
}

/**
 * The `model` of an orchestrator_briefing call: a string of 1–100 characters after trimming,
 * with no control character. It is stored in a file the dashboard renders and quoted back in the
 * brief, so it is judged before either happens — a refused value is written nowhere.
 */
function checkBriefingModel(value: unknown): Checked<string> {
  if (value === undefined || value === null) {
    return { ok: false, error: 'invalid model — expected your exact model id (a non-empty string)' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `invalid model — expected a string, got ${kindOf(value)}` };
  }
  const model = value.trim();
  if (model === '') {
    return { ok: false, error: 'invalid model — expected your exact model id (a non-empty string)' };
  }
  if (model.length > BRIEFING_MODEL_MAX_CHARS) {
    return {
      ok: false,
      error: `invalid model — ${model.length} characters; the limit is ${BRIEFING_MODEL_MAX_CHARS}`,
    };
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(model) || flattenOneLine(model) !== model) {
    return { ok: false, error: `invalid model — expected a single line of text, got "${echoed(model)}"` };
  }
  return { ok: true, value: model };
}

/**
 * orchestrator_briefing: record which model this orchestrator session runs, and return the
 * operating brief for it. `model` is the checked argument (checkBriefingModel).
 *
 * THE BRIEF IS THE TOOL'S PURPOSE; THE RECORD IS BOOKKEEPING. A check-in that cannot be written
 * — the file could not be read, is damaged beyond setting aside, the disk is full — costs the
 * dashboard its line about this session and nothing else, so the brief is returned all the same
 * and ends with one `note:` line saying what was not recorded and why. Failing the call instead
 * would withhold the rules the session is required to load before its first dispatch.
 *
 * What the brief contains depends on three settings of the registry (Mesh Mode; whether a worker
 * on another vendor's CLI is registered; Teammate mode — the team doctrine, team contract §7.8). When that file cannot be read neither is known, the
 * brief is the one for neither, and a second `note:` says so — the sections were left out
 * because nothing could be learned, not because they do not apply.
 */
function orchestratorBrief(model: string): string {
  const notes: string[] = [];
  try {
    recordOrchestrator(process.cwd(), model);
  } catch (err) {
    notes.push(
      `note: this session's check-in was not recorded — ${unrecordedReason(err)} The brief above is ` +
        'complete; only the dashboard is missing which model this session runs.',
    );
  }
  // Mesh doctrine is injected only when Mesh Mode is on: it is what tells the
  // orchestrator that its workers are peer sessions it can message and must stop.
  // The other-vendor paragraph likewise only when such a worker is registered: an
  // orchestrator that is never told these accounts exist never uses them (they are
  // opt-in), and one with none has nothing to learn about them.
  let meshOn = false;
  let otherVendorWorkers = false;
  let teamOn = false;
  try {
    const { registry, problem } = readRegistryChecked();
    const unreadable = registryProblemText(problem);
    if (unreadable !== undefined) {
      notes.push(
        `note: ${unreadable} This brief therefore leaves out what depends on that file — the Mesh ` +
          "Mode rules and the rules for workers on another vendor's CLI. Call orchestrator_briefing " +
          'again once the file can be read.',
      );
    } else {
      meshOn = registry.meshMode === 'on';
      otherVendorWorkers = registry.workers.some((w) => workerProvider(w) !== 'claude');
      teamOn = registry.teamMode === 'on';
    }
  } catch {
    meshOn = false;
    otherVendorWorkers = false;
    teamOn = false;
  }
  const brief = orchestratorBriefing(model, meshOn, otherVendorWorkers, teamOn);
  return notes.length === 0 ? brief : `${brief}\n\n${notes.join('\n')}`;
}

/** Whether the last attempt to mark this session alive failed — so the failure is said once. */
let checkinFailing = false;

/**
 * Mark the workspace's main session alive. Only that session talks to this server, so any tool
 * call proves it is alive — which surfaces activity in the dashboard even before the session
 * has (re-)briefed.
 *
 * Bookkeeping, and it never decides anything: a marker that cannot be written leaves every tool
 * call exactly as it was. It is said on stderr — once when it starts failing, not once per
 * call — because a note on every tool result would bury the results.
 */
function touchCheckin(): void {
  try {
    touchOrchestrator(process.cwd());
    checkinFailing = false;
  } catch (err) {
    if (!checkinFailing) {
      checkinFailing = true;
      stderrLine(
        `cco-dispatch: this session's activity is not being recorded for the dashboard — ` +
          `${unrecordedReason(err)} Tool calls are unaffected.`,
      );
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The dispatched-worker guard (§15.5, both transports)
 * ------------------------------------------------------------------------- */

/** The tools a dispatched worker's own server refuses: the ones that dispatch, brief or stop workers. */
const WORKER_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_task',
  'dispatch_tasks',
  'mesh_stop_worker',
  'orchestrator_briefing',
]);

/** The lead's team operations as tools/call names (§7.5): host mode only. */
const TEAM_OP_NAMES: ReadonlySet<string> = new Set(TEAM_OPS);

/**
 * The refusal of `tool` when THIS server process runs inside a dispatched worker — its
 * environment carries DISPATCHED_TASK_ENV, which every worker this code base starts is given (the
 * `claude -p` core, the detach supervisor's worker, the session worker, every vendor CLI child) —
 * or undefined. list_workers, dispatch_status and mesh_status still answer: they start nothing.
 *
 * TEAM MODE (team contract §3.9): every team turn process (and so every server a teammate starts)
 * carries TEAM_MEMBER_ENV as well, and it is asked FIRST: set — to any value, an unreadable one
 * included: the refusing direction is the safe one — the same tools answer with the teammate's
 * sentence (TEAM_TEXT.dispatchServerInTeammate). The team operations are refused under either
 * variable too: a teammate or a dispatched worker cannot lead a team (in host mode, where they
 * exist; the stdio server never has them, §7.5).
 *
 * WHY. A worker reads the workspace's CLAUDE.md, which tells an ORCHESTRATOR to dispatch and not
 * to implement. A worker that obeyed would hand its own task on to further workers — quota spent
 * on work nobody asked to have split, a worker that waits on workers instead of doing its task —
 * and would be recorded as the workspace's orchestrator and briefed to delegate. A GUARD AGAINST
 * THE ACCIDENT, NOT AGAINST A HOSTILE WORKER (stated): a process can always unset a variable of
 * its own environment, and a worker could start a server without it.
 */
function dispatchedWorkerRefusal(tool: string): string | undefined {
  if (!WORKER_REFUSED_TOOLS.has(tool) && !TEAM_OP_NAMES.has(tool)) {
    return undefined;
  }
  const member = process.env[TEAM_MEMBER_ENV];
  if (member !== undefined) {
    return TEAM_TEXT.dispatchServerInTeammate(member);
  }
  const task = process.env[DISPATCHED_TASK_ENV];
  if (typeof task !== 'string' || task === '') {
    return undefined;
  }
  return (
    `This cco-dispatch server runs inside a dispatched worker (task ${sliceOneLine(flattenOneLine(task), 128)}); ` +
    'a dispatched worker cannot dispatch, brief or stop workers. Do the task yourself.'
  );
}

/* ------------------------------------------------------------------------- *
 * Host mode: what the socket adds to a dispatch (§15.4, §15.5)
 * ------------------------------------------------------------------------- */

/**
 * The cancellation question a dispatch's paths ask (TaskRunContext.shouldAbort and the waits for a
 * slot). On stdio — and for every dispatch without a host task — exactly the request's, as always.
 * In host mode also the task's own: `cco cancel` ends ONE task of a batch and the rest go on, so
 * the task carries its own flag, read wherever the request's is — which is what keeps a cancelled
 * task from recording a failure against its worker, starting a cooldown or failing over.
 */
function abortCheck(requestId: string | number | null, hostTask: HostTask | undefined): () => boolean {
  if (hostTask === undefined) {
    return (): boolean => isAborted(requestId);
  }
  const task = hostTask;
  return (): boolean => isAborted(requestId) || task.cancelled !== undefined;
}

/**
 * A task id for an accepted task: the shape every core mints (`t<base36 ms><4 base36>`), and one
 * this host has not minted before. Across processes the shape's own randomness is what keeps ids
 * apart, as it always has between cores.
 */
function mintHostTaskId(): string {
  for (;;) {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!mintedTaskIds.has(id) && isTaskFileId(id)) {
      mintedTaskIds.add(id);
      return id;
    }
  }
}

/**
 * ACCEPT a dispatch_task / dispatch_tasks call that came over the socket and passed the argument
 * checks (§15.4, §15.5): mint the ids its tasks WILL have, put them in the queue, and tell the
 * client — cco/accepted, with the client's own request id — BEFORE any of them is queued for a
 * slot or started. So a client that is killed, moved to the background or told `--no-wait` has
 * the ids at once, and every one of them resolves: it is queued, then running, then done or error,
 * or it is cancelled — never "not found" while this host lives.
 *
 * Undefined — nothing accepted, nothing announced — on stdio, and for every other tool.
 */
function acceptHostTasks(call: ToolCall, requestId: string | number | null): HostTask[] | undefined {
  const transport = hostTransport;
  if (transport === undefined || requestId === null) {
    return undefined;
  }
  const tasks = call.tool === 'dispatch_task' ? [call.args] : call.tool === 'dispatch_tasks' ? call.tasks : undefined;
  if (tasks === undefined) {
    return undefined;
  }
  const request: string | number = requestId;
  const acceptedAt = Date.now();
  const accepted = tasks.map((args): HostTask => {
    const task: HostTask = {
      id: mintHostTaskId(),
      title: args.title,
      promptPreview: sliceOneLine(flattenOneLine(args.prompt), PROMPT_PREVIEW_MAX),
      acceptedAt,
      requestId: request,
      started: false,
      settledSent: false,
    };
    hostTasks.set(task.id, task);
    return task;
  });
  transport.notify(request, METHOD.accepted, { tasks: accepted.map((task) => ({ id: task.id, title: task.title })) });
  return accepted;
}

/**
 * Run the dispatch of an accepted call, and close what it never reached. The tasks run in
 * hostDispatchTask, which settles each one itself; what is left when the call is over is a task
 * whose dispatch never began — the batch was refused as a whole first (the registry could not be
 * read) — and it is closed here, with the refusal, so its announced id still resolves.
 */
async function runAccepted(accepted: HostTask[], run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (err) {
    settleLeftoverHostTasks(accepted, err);
    throw err;
  } finally {
    settleLeftoverHostTasks(accepted, undefined);
  }
}

/** Close and settle the accepted tasks whose own dispatch never settled them. Never throws. */
function settleLeftoverHostTasks(accepted: HostTask[], err: unknown): void {
  for (const task of accepted) {
    if (hostTasks.get(task.id) !== task) {
      continue;
    }
    closeUnstartedHostTask(task, err === undefined ? 'the dispatch ended before this task started' : unstartedFailure(err));
    finishHostTask(task, 'error');
  }
}

/**
 * ONE accepted task's dispatch: dispatchTask under the task's own id, then the host's part of the
 * end — whichever way it went.
 *
 *  - Cancelled by `cco cancel`: its answer (a batch's section, or the call's error) says so, in
 *    the words of the terminal event the cancel recorded — not as the failure of a worker.
 *  - Refused or failed BEFORE its first event (the registry changed while it waited, a cap
 *    refusal, a spawn that failed): it is closed with that failure (closeUnstartedHostTask), so
 *    its announced id resolves to an `error` saying why rather than to not_found.
 *  - Either way: it leaves the queue, and cco/settled goes to its client (finishHostTask).
 */
async function hostDispatchTask(args: DispatchArgs, requestId: string | number | null, task: HostTask): Promise<string> {
  let outcome: 'done' | 'error' = 'error';
  try {
    const text = await dispatchTask(args, requestId, task);
    outcome = 'done';
    return text;
  } catch (err) {
    if (task.cancelled !== undefined) {
      throw new Error(task.cancelled === 'queued' ? QUEUED_CANCEL_REASON : RUNNING_CANCEL_REASON);
    }
    closeUnstartedHostTask(task, unstartedFailure(err));
    throw err;
  } finally {
    finishHostTask(task, outcome);
  }
}

/** The task's dispatch is over: out of the queue, and cco/settled to its client. Never throws. */
function finishHostTask(task: HostTask, outcome: 'done' | 'error'): void {
  if (hostTasks.get(task.id) === task) {
    hostTasks.delete(task.id);
  }
  notifySettled(task, outcome);
}

/**
 * cco/settled for one task, once (§15.4): when this host appended its terminal event — at the end
 * of its dispatch, or at a cancel of it while it was queued. The status is the LOG's when the log
 * says the task is over (the first terminal event appended stands, whoever appended it); `outcome`
 * when the log cannot say. Nothing is sent while the log still says `running` — a detach task
 * whose wait here ended while its supervisor goes on is not settled. Never throws.
 */
function notifySettled(task: HostTask, outcome: 'done' | 'error'): void {
  try {
    if (task.settledSent || hostTransport === undefined) {
      return;
    }
    const final = latestTaskEventOf(task.id);
    let status: 'done' | 'error';
    if (final === 'none' || final === 'unreadable') {
      status = outcome;
    } else if (final.status === 'done' || final.status === 'error') {
      status = final.status;
    } else {
      return;
    }
    task.settledSent = true;
    hostTransport.notify(task.requestId, METHOD.settled, { id: task.id, status });
  } catch {
    // a notification that cannot be sent is one line of a client's stderr, not a fault
  }
}

/** The event this host writes for an accepted task it closes before the task ran. */
function hostTaskEvent(task: HostTask, error: string): TaskEvent {
  return {
    id: task.id,
    title: task.title,
    worker: '-',
    model: '-',
    outputFile: path.join(TASKS_DIR, `${task.id}.md`),
    cwd: process.cwd(),
    promptPreview: task.promptPreview,
    ts: Date.now(),
    status: 'error',
    error,
  };
}

/** Whether a supervisor this process spawned is still running. */
function supervisorRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Give an accepted task that never got an event ONE terminal `error` event with `reason`, so its
 * announced id resolves for good. Only a task the log has never heard of: one that started here
 * is closed by its own path (the core's, the session worker's, a cancel's, the shutdown's), and a
 * detach task whose supervisor runs is the supervisor's to record. Through
 * registry.appendTerminalTaskEvent, which re-reads under the task's lock, so this can never be a
 * second terminal event. Never throws.
 */
function closeUnstartedHostTask(task: HostTask, reason: string): void {
  if (task.started && (task.supervisor === undefined || supervisorRunning(task.supervisor))) {
    return;
  }
  try {
    if (latestTaskEventOf(task.id) !== 'none') {
      return;
    }
    appendTerminalTaskEvent(hostTaskEvent(task, reason));
  } catch {
    // the log refused the line: the call's answer still says what became of the task
  }
}

/**
 * What a task's record says of a dispatch that ended before it started: the refusal's own
 * sentence when it is one (a refusal is a plain Error written for the caller), else our words — a
 * defect's text or an errno is not a reason anybody can act on, and the call's answer carries the
 * full account (failureText).
 */
function unstartedFailure(err: unknown): string {
  const message = errorMessage(err);
  return errnoOf(err) === undefined && !isDefect(err) && message.trim() !== ''
    ? message
    : 'the dispatch failed before this task started — the answer to the dispatch call says why';
}

/**
 * The ids of a cco/status or cco/cancel call (§15.3.1): an array of 1..IDS_MAX task ids of the
 * task id shape, duplicates dropped and the order kept. Checked again here, by value — the client
 * checked them too, but a request is only ever what arrived.
 */
function checkHostIds(value: unknown): Checked<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: `"ids" must be an array of task ids, got ${kindOf(value)}` };
  }
  if (value.length === 0 || value.length > IDS_MAX) {
    return { ok: false, error: `"ids" must name 1 to ${IDS_MAX} tasks, got ${value.length}` };
  }
  const ids: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const id: unknown = value[i];
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
      return {
        ok: false,
        error: `ids[${i}] is not a task id (1 to 128 letters, digits, "_" or "-"), got ${typeof id === 'string' ? `"${echoed(id)}"` : kindOf(id)}`,
      };
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return { ok: true, value: ids };
}

/**
 * A text answer of a cco/* method (host-protocol.TextResult): `isError` always present, the text
 * always a string (the rule sendToolResult keeps for tool results), `pending` for cco/status.
 */
function textResult(text: unknown, isError: boolean, pending?: string[]): Record<string, unknown> {
  const sound = typeof text === 'string';
  return {
    content: [
      {
        type: 'text',
        text: sound ? text : 'Error: the method produced no text — a defect in cco-dispatch, not in the request.',
      },
    ],
    isError: sound ? isError : true,
    ...(pending !== undefined ? { pending } : {}),
  };
}

/** A wait that never rejects. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** What one look of cco/status sees: dispatch_status's text at this moment, and what is still pending. */
function statusLook(ids: string[]): { text: string; isError: boolean; pending: string[] } {
  try {
    const records = dispatchStatusRecords(ids);
    return {
      text: statusText(records),
      isError: false,
      pending: records.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => r.id),
    };
  } catch (err) {
    // Exactly the answer dispatch_status gives then — a log that could not be read is a status
    // nobody knows, and waiting longer is not how it becomes known.
    return { text: `Error: ${failureText('dispatch_status', err)}`, isError: true, pending: [] };
  }
}

/**
 * cco/status {ids, waitSeconds} (§15.4): answered when every id is terminal (done / error) or
 * unknown to everybody (not_found) — or when waitSeconds have passed, whichever is first. It looks
 * every STATUS_WAIT_POLL_MS with the reconcile dispatch_status runs, and its text is exactly
 * dispatch_status's text at the moment it answers, with `pending` the ids still queued or running.
 *
 * A wait whose client has gone stops looking: its answer would be dropped (§15.4), and the looks
 * — each a read of the whole log and a reconcile — are spent on nobody. Nothing else differs.
 *
 * A LOOK THAT CANNOT SEE ANYTHING NEW IS SKIPPED, and only such a look. Each look reads and parses
 * the whole task log twice (the reconcile, then the records), which on a log of tens of MiB is a
 * second of this process's time — every STATUS_WAIT_POLL_MS, for every waiting client, for as long
 * as `--wait` says. When every id still pending is a task THIS process holds in flight and the log
 * is the same file at the same size and time as at the last look, the next look would see exactly
 * the same: the reconcile never settles a task this process holds (statusAliveCheck), and every
 * change of such a task's state — started, ended, cancelled — is an append to the log. The look
 * that ANSWERS is never a skipped one: at the deadline the log is read afresh, so the text is
 * dispatch_status's text at that moment.
 */
async function answerStatusWait(id: string | number | null, ids: string[], waitSeconds: number): Promise<void> {
  const deadline = Date.now() + waitSeconds * 1000;
  let seen: { logKey: string; pending: string[] } | undefined;
  for (;;) {
    const unchanged =
      seen !== undefined &&
      Date.now() < deadline &&
      seen.pending.every((pendingId) => hostTasks.has(pendingId) || taskBases.has(pendingId)) &&
      currentTaskLogKey() === seen.logKey;
    if (!unchanged) {
      // Taken BEFORE the look: an append that lands during the look changes it for the next one.
      const logKey = currentTaskLogKey();
      const look = statusLook(ids);
      if (look.isError || look.pending.length === 0 || Date.now() >= deadline) {
        sendResult(id, textResult(look.text, look.isError, look.pending));
        return;
      }
      seen = { logKey, pending: look.pending };
    }
    if (shuttingDown || (id !== null && hostTransport !== undefined && !hostTransport.isOpen(id))) {
      return;
    }
    await sleep(Math.min(STATUS_WAIT_POLL_MS, deadline - Date.now()));
  }
}

/**
 * What identifies the task log as it is now (taskLogKey: device, inode, size, modification time)
 * — `absent` when there is none, and a key that matches nothing when it cannot be looked at, so
 * that such a moment always counts as a change. Never throws.
 */
function currentTaskLogKey(): string {
  try {
    return taskLogKey(fs.statSync(TASKS_LOG_FILE));
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'absent' : `unreadable:${Math.random()}`;
  }
}

/**
 * The final event of each of `ids` in the task log — ranAs.isCountedTaskEvent's admission, the
 * last admitted event per id in file order — from ONE read of the log, or `unreadable`.
 */
function finalEventsOf(ids: readonly string[]): Map<string, TaskEvent> | 'unreadable' {
  const want = new Set(ids);
  const read = readTaskEventsChecked();
  if (read.unreadable) {
    return 'unreadable';
  }
  const finals = new Map<string, TaskEvent>();
  for (const event of read.events) {
    if (isCountedTaskEvent(event) && want.has(event.id)) {
      finals.set(event.id, event);
    }
  }
  return finals;
}

/**
 * cco/cancel {ids} (§15.5): for each id, exactly one of the contract's cases, and one line saying
 * what THIS call did. A cancel and a settle at the same moment: the first terminal event appended
 * stands (registry.appendTerminalTaskEvent re-reads under the task's lock), and the line says
 * what the log then holds. The ids that are not live tasks of this host are reconciled first —
 * the same bounded reconcile dispatch_status runs — so a task whose owner died reads as what it
 * became rather than as somebody's running task.
 *
 * A team turn this host's engine holds is asked of the engine FIRST (§7.9 step 5, M8): its cancel
 * is TeamEngine.cancelTurn — the normal ladder, the member paused — and its line is the engine's.
 */
async function cancelHostTasks(ids: string[]): Promise<string> {
  const lines = new Map<string, string>();
  const stops: Array<Promise<void>> = [];
  const elsewhere: string[] = [];
  for (const id of ids) {
    const engine = teamEngine;
    if (engine !== undefined && teamOwnsTurn(id)) {
      let line: Promise<string>;
      try {
        line = Promise.resolve(engine.cancelTurn(id));
      } catch (err) {
        line = Promise.reject(err);
      }
      stops.push(
        line.then(
          (text) => {
            lines.set(id, typeof text === 'string' && text !== '' ? text : `${id}: team turn stopped`);
          },
          (err: unknown) => {
            lines.set(id, `${id}: the team engine could not stop it — ${sliceOneLine(flattenOneLine(errorMessage(err)), 300)}`);
          },
        ),
      );
      continue;
    }
    const own = cancelOwnTask(id);
    if (own === undefined) {
      elsewhere.push(id);
    } else if (typeof own === 'string') {
      lines.set(id, own);
    } else {
      stops.push(
        own.then((line) => {
          lines.set(id, line);
        }),
      );
    }
  }
  await Promise.all(stops);
  if (elsewhere.length > 0) {
    try {
      reapDeadTasks(elsewhere, statusAliveCheck(), meshTaskRecovery());
    } catch {
      // best effort, as in dispatch_status — the lines below then read the log as it is
    }
    const finals = finalEventsOf(elsewhere);
    for (const id of elsewhere) {
      lines.set(id, cancelRecordedTask(id, finals));
    }
  }
  return ids.map((id) => lines.get(id) ?? `${id}: not found`).join('\n');
}

/**
 * Cancel `id` when it is a live task of THIS host: its line (or, for a session worker, the
 * promise of it), or undefined when it is not one — not accepted here, already cancelled, or
 * already over here — and the log is what answers for it.
 */
function cancelOwnTask(id: string): string | Promise<string> | undefined {
  const task = hostTasks.get(id);
  if (task === undefined || task.cancelled !== undefined) {
    return undefined;
  }
  if (!task.started) {
    return cancelQueuedTask(task);
  }
  if (task.supervisor !== undefined) {
    if (!supervisorRunning(task.supervisor)) {
      // Its supervisor has finished and its record is being read here: the log says how it ended.
      return undefined;
    }
    // The supervisor is the sole author of a detach task's records: the marker first, then its
    // worker's group (contract §7 R7); it writes the terminal event when its core sees the marker.
    cancelDetachTask(id);
    return `${id}: cancel requested — its supervisor stops it`;
  }
  return cancelStartedTask(task);
}

/**
 * A task queued here never starts (§15.5): its flag makes every path that would start it stop —
 * the wait for a slot ends, a core between its slot and its first event breaks out — and ONE
 * terminal `error` event, `cancelled before it started (cco cancel)`, with its title and worker
 * `-`, resolves its id for good. That event is this host's, so cco/settled goes out now.
 */
function cancelQueuedTask(task: HostTask): string {
  task.cancelled = 'queued';
  let close: TaskClose | undefined;
  try {
    close = appendTerminalTaskEvent(hostTaskEvent(task, QUEUED_CANCEL_REASON));
  } catch {
    // The log refused the line; the task still never starts. Its answer says it was cancelled.
  }
  if (close !== undefined && !close.closed) {
    return `${task.id}: already ${close.final?.status === 'done' ? 'done' : 'error'}`;
  }
  notifySettled(task, 'error');
  return `${task.id}: cancelled before it started`;
}

/**
 * A task running here: for that ONE task what a request cancel does (cancelRequest) — its
 * terminal event `cancelled (cco cancel)` first, then its worker stopped: a one-shot or vendor
 * child gets SIGTERM, then SIGKILL after its grace (childrenByTask, providerChildrenByTask); a
 * session worker goes the mesh_stop_worker way (stopSessionWorker). Its flag is set between the
 * two, so the core that sees its worker die breaks out with no recordFailure, no cooldown and no
 * failover; the rest of its batch goes on.
 *
 * Undefined when the task is not running here after all (its core already settled it): the log
 * answers. A task the log already shows ended — it finished, or another surface closed it, in the
 * same instant — is left as it is: the line says so, and nothing is stopped.
 */
function cancelStartedTask(task: HostTask): string | Promise<string> | undefined {
  const id = task.id;
  const base = taskBases.get(id);
  if (base === undefined) {
    return undefined;
  }
  const close = recordTaskEnded(base, RUNNING_CANCEL_REASON);
  if (close !== undefined && !close.closed) {
    return `${id}: already ${close.final?.status === 'done' ? 'done' : 'error'}`;
  }
  taskBases.delete(id);
  task.cancelled = 'running';
  const child = childrenByTask.get(id);
  if (child !== undefined) {
    killChild(child, KILL_GRACE_MS);
    return `${id}: cancelled — its worker was stopped`;
  }
  const stopProvider = providerChildrenByTask.get(id);
  if (stopProvider !== undefined) {
    stopProviderChild(stopProvider);
    return `${id}: cancelled — its worker was stopped`;
  }
  if (bgWorkersByTask.has(id)) {
    return stopSessionWorker(id);
  }
  // Between two attempts, or before its child exists: the flag stops it at the core's next
  // checkpoint, and a vendor child started after this is stopped by the core as it registers.
  return `${id}: cancelled — its worker was stopped`;
}

/**
 * Stop the session worker of a task running here (§15.5): its dispatch is ended as cancelled at
 * once (bg-runner.bgCancelPending — no failure is recorded against the account), then its worker
 * is stopped by the mesh_stop_worker path — by the job id that names exactly that session, or by
 * its name when its spawn reported no job id — with `force`, as a request cancel stops one. A
 * dispatch with no live worker to name yet (its spawn still in flight, or between attempts) needs
 * no stop from here: the runner stops a worker it gets back for a cancelled dispatch, at its first
 * look after the spawn. Never rejects.
 */
async function stopSessionWorker(id: string): Promise<string> {
  const live = bgCancelPending(id);
  if (live === undefined) {
    return `${id}: its session worker was stopped`;
  }
  try {
    await meshStopWorker(
      live.jobId !== ''
        ? { jobId: live.jobId, name: '', force: true }
        : { jobId: '', name: live.workerName, force: true },
    );
    return `${id}: its session worker was stopped`;
  } catch (err) {
    return (
      `${id}: cancelled, but its session worker could not be stopped — ` +
      `${sliceOneLine(flattenOneLine(errorMessage(err)), 300)}`
    );
  }
}

/**
 * The cancel of a task that is not a live task of this host, by what the log holds of it: not
 * there; already over; a detach task — of any process — whose supervisor is told through its
 * marker; or a task running under another live process (another session's host, an MCP server),
 * which is that session's to cancel and is left alone.
 *
 * Stated: the reconcile before this keeps a task whose `running` event names no process and is
 * younger than FAILOVER_GRACE_MS running (registry's dispatcher grace, contract §15.12 M4), so such
 * a task reads as another session's even when its dispatcher died inside that gap — until the
 * grace is over, when the same call finds it settled.
 */
function cancelRecordedTask(id: string, finals: Map<string, TaskEvent> | 'unreadable'): string {
  if (finals === 'unreadable') {
    // Not one of the contract's cases: nothing is known of the task, so nothing is done to it.
    return `${id}: its status is unknown — the task log could not be read, so nothing was done`;
  }
  const final = finals.get(id);
  if (final === undefined) {
    return `${id}: not found`;
  }
  if (final.status === 'done' || final.status === 'error') {
    return `${id}: already ${final.status}`;
  }
  if (typeof final.supervisorPid === 'number') {
    cancelDetachTask(id);
    return `${id}: cancel requested — its supervisor stops it`;
  }
  return `${id}: belongs to another Claude Code session — cancel it there or from the VS Code task list`;
}

/** One line of cco/recent: `<id>  <status>  <age>  <worker or ->  <title ≤ 80>`. */
function recentLine(id: string, status: string, ageMs: number, worker: string, title: string): string {
  return `${id}  ${status}  ${formatElapsed(ageMs)}  ${worker}  ${sliceOneLine(flattenOneLine(title), 80)}`;
}

/**
 * cco/recent {limit} (§15.4): this workspace's latest tasks, newest first, at most `limit` — this
 * host's queued ids first (newest accepted first), then the tasks whose FINAL event's cwd is this
 * host's workspace, newest final event first: the task log, the final event per id among those
 * ranAs.isCountedTaskEvent admits, through the reader dispatch_status uses. How a model that lost
 * its ids (an output cut, a new session) finds them again (L1).
 *
 * TEAM MODE (team contract §7.2, L12): a team turn is a task too, and a busy team would bury the
 * dispatches. So without `team` the listing SKIPS every task whose final event carries a team
 * (registry.taskEventTeam — the field taken only when it is a TEAM_ID); with it, it lists ONLY
 * those (and none of this host's queued dispatches, which are never team turns).
 */
function recentTasks(limit: number, team = false): { text: string; isError: boolean } {
  const read = readTaskEventsChecked();
  // Re-inserted on every event of an id, so the map's order is the order of FINAL events.
  const finals = new Map<string, TaskEvent>();
  if (!read.unreadable) {
    for (const event of read.events) {
      if (isCountedTaskEvent(event)) {
        finals.delete(event.id);
        finals.set(event.id, event);
      }
    }
  }
  const now = Date.now();
  const lines: string[] = [];
  const queued = team
    ? []
    : [...hostTasks.values()].filter((task) => (read.unreadable ? !task.started : !finals.has(task.id))).reverse();
  for (const task of queued) {
    if (lines.length >= limit) {
      break;
    }
    lines.push(recentLine(task.id, 'queued', now - task.acceptedAt, '-', task.title));
  }
  const workspace = process.cwd();
  for (const event of [...finals.values()].reverse()) {
    if (lines.length >= limit) {
      break;
    }
    if (event.cwd !== workspace || (taskEventTeam(event) !== undefined) !== team) {
      continue;
    }
    const field = event as unknown as Record<string, unknown>;
    lines.push(
      recentLine(event.id, event.status, now - event.ts, recordLine(field.worker, 64) || '-', recordLine(field.title, 80) || '-'),
    );
  }
  if (read.unreadable) {
    lines.push(
      `The task log could not be read, so its tasks are not listed — it is ${oneLine(TASKS_LOG_FILE)}: ` +
        'larger than this server reads, unreadable, or not a regular file.',
    );
    return { text: lines.join('\n'), isError: true };
  }
  if (lines.length === 0) {
    return { text: team ? 'No team turns in this workspace yet.' : 'No tasks in this workspace yet.', isError: false };
  }
  return { text: lines.join('\n'), isError: false };
}

/** The methods only the socket has (host-protocol.METHOD) that are answered here. */
function isHostMethod(method: string): boolean {
  return method === METHOD.status || method === METHOD.cancel || method === METHOD.recent;
}

/**
 * cco/status, cco/cancel and cco/recent (§15.4) — host mode only; on stdio each is a method this
 * server does not have (-32601, as before). Their params are checked by value and refused with
 * -32602, as tools/call's own malformed params are; a call that passed marks the session alive
 * like a tool call does.
 */
async function handleHostMethod(
  id: string | number | null,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<void> {
  const asked: Record<string, unknown> = params ?? {};
  switch (method) {
    case METHOD.status: {
      const ids = checkHostIds(asked.ids);
      if (!ids.ok) {
        sendError(id, -32602, `Invalid params — ${ids.error}`);
        return;
      }
      const wait: unknown = asked.waitSeconds;
      if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > WAIT_MAX_SECONDS) {
        sendError(
          id,
          -32602,
          `Invalid params — "waitSeconds" must be a whole number of seconds from 0 to ${WAIT_MAX_SECONDS}`,
        );
        return;
      }
      touchCheckin();
      await answerStatusWait(id, ids.value, wait);
      return;
    }
    case METHOD.cancel: {
      const ids = checkHostIds(asked.ids);
      if (!ids.ok) {
        sendError(id, -32602, `Invalid params — ${ids.error}`);
        return;
      }
      touchCheckin();
      sendResult(id, textResult(await cancelHostTasks(ids.value), false));
      return;
    }
    case METHOD.recent: {
      const limit: unknown = asked.limit === undefined || asked.limit === null ? RECENT_DEFAULT : asked.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RECENT_MAX) {
        sendError(id, -32602, `Invalid params — "limit" must be a whole number from 1 to ${RECENT_MAX}`);
        return;
      }
      // `team` (L12): absent or false — the dispatches; true — the team turns only.
      const team: unknown = asked.team === undefined || asked.team === null ? false : asked.team;
      if (typeof team !== 'boolean') {
        sendError(id, -32602, 'Invalid params — "team" must be true or false');
        return;
      }
      touchCheckin();
      const recent = recentTasks(limit, team);
      sendResult(id, textResult(recent.text, recent.isError));
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${echoed(method)}`);
  }
}

/** One tools/call, after its arguments were checked: which tool, and what it was asked. */
type ToolCall =
  | { tool: 'dispatch_task'; args: DispatchArgs }
  | { tool: 'dispatch_tasks'; tasks: DispatchArgs[] }
  | { tool: 'dispatch_status'; ids: string[] }
  | { tool: 'orchestrator_briefing'; model: string }
  | { tool: 'list_workers'; check: boolean; diagnostics: boolean }
  | { tool: 'mesh_status' }
  | { tool: 'mesh_stop_worker'; args: MeshStopArgs };

/** The names tools/list publishes — what a tools/call may name. */
const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

/**
 * Judge the arguments of one tools/call, by the rule of the tool it names — BEFORE anything
 * runs on its behalf: no check-in is written, no registry is read, no id is minted, nothing is
 * spawned or logged for a call that is refused here. The refusal is one sentence that names the
 * field and what was expected (`invalid <field> — expected <what>`), quotes at most 80
 * characters of the value, and never the text of a prompt.
 *
 * The dispatch tools are judged by the one checker every entry uses (mcp/dispatch-args): a
 * single task, or — for a batch — every member, the first bad one refusing the whole call.
 * From here on only the CHECKED values exist: nothing below reads an argument as it arrived.
 * Returns undefined for a name that is not a tool of this server.
 */
function checkToolCall(name: string, args: Record<string, unknown>): Checked<ToolCall> | undefined {
  switch (name) {
    case 'dispatch_task': {
      const checked = checkDispatchArgs(args);
      return checked.ok ? { ok: true, value: { tool: name, args: checked.args } } : checked;
    }
    case 'dispatch_tasks': {
      const checked = checkDispatchBatch(args.tasks);
      return checked.ok ? { ok: true, value: { tool: name, tasks: checked.tasks } } : checked;
    }
    case 'dispatch_status': {
      const checked = checkStatusArgs(args);
      return checked.ok ? { ok: true, value: { tool: name, ids: checked.value } } : checked;
    }
    case 'orchestrator_briefing': {
      const checked = checkBriefingModel(args.model);
      return checked.ok ? { ok: true, value: { tool: name, model: checked.value } } : checked;
    }
    case 'list_workers':
      // Two optional switches, each on only as the literal `true` (`cco list_workers --check`,
      // `--diagnostics`); anything else sent along is not read.
      return { ok: true, value: { tool: name, check: args.check === true, diagnostics: args.diagnostics === true } };
    case 'mesh_status':
      // No arguments; whatever was sent along is not read.
      return { ok: true, value: { tool: name } };
    case 'mesh_stop_worker': {
      const checked = checkMeshStopArgs(args);
      return checked.ok ? { ok: true, value: { tool: name, args: checked.value } } : checked;
    }
    default:
      return undefined;
  }
}

/**
 * Run one checked tool call and return its text — list_workers' with its snapshot (WorkersAnswer).
 * Throws the tool's refusal. `accepted` is set in host mode for a dispatch call: the tasks
 * cco/accepted announced (acceptHostTasks). `role` is the role of the host connection the call
 * came from (HostRequestContext; undefined on stdio) — list_workers' poll floor is keyed on it.
 */
async function runTool(
  call: ToolCall,
  reqId: string | number | null,
  accepted: HostTask[] | undefined,
  role: HostRequestContext['role'] | undefined,
): Promise<string | WorkersAnswer> {
  switch (call.tool) {
    case 'dispatch_task': {
      if (accepted === undefined) {
        return dispatchTask(call.args, reqId);
      }
      const args = call.args;
      const task = accepted[0];
      return runAccepted(accepted, () => hostDispatchTask(args, reqId, task));
    }
    case 'dispatch_tasks': {
      if (accepted === undefined) {
        return dispatchTasksParallel(call.tasks, reqId);
      }
      const tasks = call.tasks;
      const batch = accepted;
      return runAccepted(batch, () => dispatchTasksParallel(tasks, reqId, batch));
    }
    case 'dispatch_status':
      return dispatchStatus(call.ids);
    case 'orchestrator_briefing':
      return orchestratorBrief(call.model);
    case 'list_workers':
      return listWorkersFloored(role, { check: call.check, diagnostics: call.diagnostics });
    case 'mesh_status':
      return meshStatus();
    case 'mesh_stop_worker':
      return meshStopWorker(call.args);
  }
}

/**
 * One tools/call request. Everything about the REQUEST is judged first, in this order, and each
 * failure is an answer — never an exception's text, and never silence:
 *
 *   - `params` that is not an object, or has no usable `name` → JSON-RPC error -32602;
 *   - a `name` that is not a tool of this server → JSON-RPC error -32602 ("Unknown tool");
 *   - a tool a dispatched worker may not call, when this server runs inside one
 *     (dispatchedWorkerRefusal, §15.5) → a tool result with `isError: true` — whatever its
 *     arguments, and before anything is written or run;
 *   - `arguments` that is present and not an object, or that the tool's own check refuses
 *     (checkToolCall) → a tool result with `isError: true` and the refusal as its text.
 *
 * Only a call that passed all of it is counted as in flight, marks the session alive, and runs.
 * In host mode a dispatch call is then ACCEPTED before it runs (acceptHostTasks): its tasks get
 * their ids, and the client is told them, before any of them is queued or started.
 */
async function handleToolCall(id: JsonRpcId, params: unknown, role: HostRequestContext['role'] | undefined): Promise<void> {
  if (!isPlainObject(params)) {
    sendError(
      id,
      -32602,
      'Invalid params — tools/call takes an object with "name" (a tool from tools/list) and "arguments" (an object).',
    );
    return;
  }
  const name = params.name;
  if (typeof name !== 'string' || name.trim() === '') {
    sendError(id, -32602, 'Invalid params — tools/call needs "name": the name of a tool from tools/list.');
    return;
  }
  if (TEAM_OP_NAMES.has(name)) {
    await handleTeamOpCall(id, name as TeamOp, params.arguments);
    return;
  }
  if (!TOOL_NAMES.has(name)) {
    sendError(id, -32602, `Unknown tool: ${echoed(name)} — tools/list names the tools of this server.`);
    return;
  }
  const refusal = dispatchedWorkerRefusal(name);
  if (refusal !== undefined) {
    sendToolResult(id, refusal, true);
    return;
  }
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
    sendToolResult(id, `Error: invalid arguments — expected an object, got ${kindOf(rawArgs)}`, true);
    return;
  }
  const call = checkToolCall(name, isPlainObject(rawArgs) ? rawArgs : {});
  if (call === undefined) {
    sendError(id, -32602, `Unknown tool: ${echoed(name)} — tools/list names the tools of this server.`);
    return;
  }
  if (!call.ok) {
    sendToolResult(id, `Error: ${call.error}`, true);
    return;
  }
  touchCheckin();
  // Only a string/number id can be named by notifications/cancelled.
  const reqId: string | number | null = typeof id === 'string' || typeof id === 'number' ? id : null;
  pending++;
  if (reqId !== null) {
    inFlightRequests.add(reqId);
  }
  try {
    // Host mode: the ids the call's tasks WILL have, told to the client before any of them is
    // queued or started (§15.4). Undefined on stdio and for every other tool.
    const accepted = acceptHostTasks(call.value, reqId);
    const answer = await runTool(call.value, reqId, accepted, role);
    // A cancelled request gets no response at all — the client is no longer
    // waiting on this id and a late result would be a protocol violation.
    if (!isAborted(reqId)) {
      if (typeof answer === 'string') {
        sendToolResult(id, answer, false);
      } else {
        sendToolResult(id, answer.text, false, answer.structuredContent);
      }
    }
  } catch (err) {
    if (!isAborted(reqId)) {
      const text = `Error: ${failureText(name, err)}`;
      // host-protocol, list_workers' answers to a front end: its isError text gets the snapshot's
      // `~` redaction — through the host only, for every role (an observer's screen and the lead's
      // context alike); stdio's text is as it always was.
      sendToolResult(id, name === 'list_workers' && hostTransport !== undefined ? homeRedacted(text) : text, true);
    }
  } finally {
    pending--;
    if (reqId !== null) {
      inFlightRequests.delete(reqId);
      abortedRequests.delete(reqId);
      // Release this request's mesh cancel hooks. They are deliberately kept past
      // each task's own settle (so a batch cancel can still stop a worker that is
      // idle-after-result, P4.5); the request completing is when they stop mattering.
      const bgIds = tasksByRequest.get(reqId);
      if (bgIds !== undefined) {
        for (const taskId of bgIds) {
          bgWorkersByTask.delete(taskId);
        }
      }
      tasksByRequest.delete(reqId);
      detachTasksByRequest.delete(reqId);
    }
    maybeExit();
  }
}

/**
 * A tools/call of one of the lead's team operations (team contract §7.2, §7.5):
 *
 *   - on stdio — and in a host whose engine could not be built — it is answered isError: on stdio
 *     with TEAM_TEXT.teamOpsStdio (team operations run through `cco`), in such a host with a
 *     sentence pointing at its log;
 *   - under the dispatched-worker guard (§3.9, §15.5) it is refused like the dispatch tools;
 *   - `arguments` that are present and not an object are refused as for every tool;
 *   - otherwise TeamEngine.toolCall answers it — every value check is the engine's (§7.3), and it
 *     never rejects; `capChars` is `arguments.capChars` read by value (team_inbox, M9).
 *
 * The answer is the engine's text, as every tool result is sent (sendToolResult). The unread
 * footer is not added here: the host adds it to every answer on a session connection (host.ts,
 * L9). A team operation is not a dispatch: it is not counted as in flight and takes no part in
 * the abort bookkeeping — a client that goes away is never a cancel (§15.4).
 */
async function handleTeamOpCall(id: JsonRpcId, name: TeamOp, rawArgs: unknown): Promise<void> {
  const engine = teamEngine;
  if (hostTransport === undefined) {
    sendToolResult(id, TEAM_TEXT.teamOpsStdio(), true);
    return;
  }
  if (engine === undefined) {
    sendToolResult(
      id,
      "This session's dispatch host could not load its team engine, so it runs no teams — its log says why; " +
        'start a new Claude Code session to try again.',
      true,
    );
    return;
  }
  const refusal = dispatchedWorkerRefusal(name);
  if (refusal !== undefined) {
    sendToolResult(id, refusal, true);
    return;
  }
  if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
    sendToolResult(id, `Error: invalid arguments — expected an object, got ${kindOf(rawArgs)}`, true);
    return;
  }
  const args: Record<string, unknown> = isPlainObject(rawArgs) ? rawArgs : {};
  const cap: unknown = args.capChars;
  const capChars = typeof cap === 'number' && Number.isInteger(cap) && cap > 0 && cap <= OUT_CAP_CHARS ? cap : undefined;
  touchCheckin();
  if (TEAM_ROUTING_OPS.has(name)) {
    // Team routing reads cached login verdicts and spawns nothing (team contract M15). So the
    // live check a refusal owes (Login state (CA): never refuse a member on a reading this host
    // did not confirm, nor on a logout older than LOGGED_OUT_FRESH_MS) is made HERE, before the
    // engine reads the cache: bounded, side by side, only for the accounts it could matter for.
    await recheckClaudeLoginsForRouting();
  }
  try {
    const result = await engine.toolCall(name, args, capChars);
    sendToolResult(id, answerTextOf(result), result?.isError === true);
  } catch (err) {
    sendToolResult(id, `Error: ${failureText(name, err)}`, true);
  }
}

/** The team operations that route a member onto an account (and so may refuse one on its login). */
const TEAM_ROUTING_OPS: ReadonlySet<string> = new Set(['team_create', 'team_add', 'team_member', 'team_resume']);

/** The text of a TextResult the engine answered with — `content[0].text` when it is a string. */
function answerTextOf(result: unknown): string | undefined {
  if (!isPlainObject(result) || !Array.isArray(result.content) || result.content.length === 0) {
    return undefined;
  }
  const item: unknown = result.content[0];
  return isPlainObject(item) && typeof item.text === 'string' ? item.text : undefined;
}

/**
 * One message from the client. `msg` is whatever a line of stdin parsed to — an object when the
 * client speaks the protocol, and anything JSON can hold when it does not — so nothing of it is
 * used before it has been looked at: a `null`, a number or an array is answered as an invalid
 * request, a `method` that is not a string likewise, and an `id` that is neither a string, a
 * number nor null is refused rather than echoed (a request that cannot be answered to, or
 * cancelled by, a proper id is not started).
 *
 * `context` comes from host.ts only (HostHooks.handleRequest): the role of the socket connection
 * the message came on, which the message itself cannot be trusted to say. Stdio passes none.
 */
async function handleRequest(msg: unknown, context?: HostRequestContext): Promise<void> {
  if (!isPlainObject(msg)) {
    sendError(null, -32600, 'Invalid Request — expected one JSON-RPC request object per line.');
    return;
  }
  const { id, method, params } = msg;
  if (method === undefined) {
    // A response, or nothing this server acts on.
    return;
  }
  if (typeof method !== 'string') {
    if (id !== undefined) {
      sendError(
        id === null || typeof id === 'string' || typeof id === 'number' ? id : null,
        -32600,
        'Invalid Request — "method" must be a string.',
      );
    }
    return;
  }
  const fields = isPlainObject(params) ? params : undefined;
  // The client cancels an in-flight tools/call with this notification. It is the
  // only notification we act on, and — like every notification — it gets no response.
  if (method === 'notifications/cancelled') {
    // On a socket it is IGNORED (§15.4): there, a client that stops waiting is never a cancel —
    // `cco cancel` is — and the requestId it would name is the client's own id, not one this
    // host's bookkeeping knows. The `cco` client never sends it.
    if (hostTransport !== undefined) {
      return;
    }
    const requestId = fields?.requestId;
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      // Unknown or already-settled ids are ignored silently by cancelRequest.
      cancelRequest(requestId);
    }
    return;
  }
  if (TEST_FAULTS_ENABLED && method === TEST_FAULT_METHOD) {
    injectTestFault(fields?.kind);
    return;
  }
  // Any other notification (no id) needs no response.
  if (id === undefined) {
    return;
  }
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
    sendError(null, -32600, 'Invalid Request — "id" must be a string or a number.');
    return;
  }
  switch (method) {
    case 'initialize':
      sendResult(id, {
        // The client's revision when this server implements it, otherwise OUR newest — never
        // an echo of one we do not know (platform.negotiateMcpProtocol).
        protocolVersion: negotiateMcpProtocol(fields?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      // The team operations only in host mode, with an engine (§7.5); stdio's list is as it always was.
      sendResult(id, { tools: hostTransport !== undefined && teamEngine !== undefined ? [...TOOLS, ...TEAM_TOOLS] : TOOLS });
      return;
    case 'tools/call':
      await handleToolCall(id, params, context?.role);
      return;
    default:
      // cco/status, cco/cancel and cco/recent exist on the socket only; on stdio they are
      // methods this server does not have, as they always were (§15.5).
      if (hostTransport !== undefined && isHostMethod(method)) {
        await handleHostMethod(id, method, fields);
        return;
      }
      sendError(id, -32601, `Method not found: ${echoed(method)}`);
  }
}

/** The fault handlers: from here on, an error nothing handled ends the server through failServer. */
function installFaultHandlers(): void {
  process.on('unhandledRejection', (reason) => failServer('unhandled rejection', reason));
  process.on('uncaughtException', (err) => failServer('uncaught exception', err));
}

/**
 * The signal handlers. They must never throw; shutdown() is already total and idempotent. SIGHUP
 * is handled with the other two: its default action ends the process on the spot, with every
 * worker of an in-flight dispatch left running.
 */
function installSignalHandlers(): void {
  const onSignal = (signal: string) => () => {
    try {
      shutdown(`${SHUTDOWN_REASON} (${signal})`);
    } catch {
      exitProcess(0);
    }
  };
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGHUP', onSignal('SIGHUP'));
}

/**
 * HOST MODE — `server.js --host <spec path>` (§15.1, §15.2): the same server, reached over a Unix
 * socket by the `cco` command and living as long as the Claude Code session process that asked for
 * it. mcp/host.ts does the start, the serving and the end; this hands it what it needs of the
 * server. Everything main() does on stdio happens here too, apart from reading stdin: the fault
 * and signal handlers come first, before anything of the start can fail.
 */
function hostMain(specPath: string | undefined): void {
  installFaultHandlers();
  installSignalHandlers();
  runHost(specPath, {
    handleRequest,
    setTransport: (transport) => {
      hostTransport = transport;
    },
    setExitHook: (hook) => {
      exitHook = hook;
    },
    shutdown,
    shutdownReason: SHUTDOWN_REASON,
    log: stderrLine,
    team: teamSide,
  });
}

/**
 * Build this host's team engine (team contract §7.1) — HOST MODE ONLY, called once by the host's
 * start (mcp/host.ts) when the spec is read and before the listen: the core (src/team/engine.ts)
 * over the runtime facts, the surface (src/team/surface.ts) over the core. What it hands back is
 * host.ts's half: the engine's TeamHostSide, the way to give it its TeamConnections, the unread
 * footer, and the start of the orphan sweep once the host listens. A throw here is host.ts's to
 * log; the host then serves without teams.
 *
 * `cliJsPath`: the cli.js beside this server.js — `<data root>/mcp/cli.js` as installed (the two
 * are always installed together, cli.ts's serverJsPath is the same rule the other way round); a
 * test bundle in a scratch directory names its own.
 */
function teamSide(setup: HostTeamSetup): HostTeam {
  const runtime: TeamRuntime = {
    dataRoot: ROOT_DIR,
    workspace: setup.workspace,
    host: { pid: process.pid, startedAt: setup.hostStartedAt },
    session: setup.session,
    socket: setup.socket,
    nodePath: process.execPath,
    cliJsPath: path.join(__dirname, 'cli.js'),
    log: stderrLine,
  };
  const surface = createTeamSurface(createTeamCore(runtime), runtime);
  const engine = surface.engine;
  return {
    hostSide: surface.hostSide,
    // The engine answers this file's questions only once it has its connections: an engine whose
    // setConnections threw is dropped by host.ts, and must not be asked anything here either.
    setConnections: (connections) => {
      surface.setConnections(connections);
      teamEngine = engine;
    },
    footer: () => engine.footer(),
    listening: () => {
      Promise.resolve()
        .then(() => engine.sweep())
        .catch((err: unknown) => {
          stderrLine(`cco-dispatch: the team sweep failed — ${sliceOneLine(flattenOneLine(errorMessage(err)), 300)}`);
        });
    },
  };
}

function main(): void {
  // The transport is picked here, once: `--host <spec>` is the socket (hostMain); anything else is
  // stdio, exactly as it always was.
  if (process.argv[2] === HOST_ARG) {
    hostMain(process.argv[3]);
    return;
  }
  // Before anything can fail: from here on, an error nothing handled ends the server in an
  // orderly way instead of on the spot (failServer).
  installFaultHandlers();

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Ignore malformed lines rather than crashing the transport.
      return;
    }
    // handleRequest answers every request itself, failures included; what could still reject
    // here is a fault in the handling of the message, and that request is told so when it can
    // be — the promise is never left without a handler.
    handleRequest(msg).catch((err) => {
      const id = isPlainObject(msg) ? msg.id : undefined;
      stderrLine(
        `cco-dispatch: a request could not be handled: ${sliceOneLine(flattenOneLine(errorMessage(err)), 300)}`,
      );
      if (typeof id === 'string' || typeof id === 'number') {
        sendError(id, -32603, 'Internal error — the request could not be handled; see the server\'s stderr.');
      }
    });
  });
  rl.on('close', () => {
    // stdin EOF means the client is gone: nobody will ever read our responses,
    // so there is nothing to drain. Waiting for `pending` here is what let
    // workers orphan and burn quota for the full worker timeout window.
    stdinClosed = true;
    shutdown(SHUTDOWN_REASON);
  });
  // A client that went away shows up on the streams too — a write to a closed stdout, a read
  // error on stdin — as 'error' events, which end the process when nobody listens for them.
  // Either one means what the end of stdin means.
  const onStreamError = (): void => {
    stdinClosed = true;
    shutdown(SHUTDOWN_REASON);
  };
  process.stdout.on('error', onStreamError);
  process.stdin.on('error', onStreamError);
  rl.on('error', onStreamError);
  installSignalHandlers();
}

main();
