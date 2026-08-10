import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import {
  appendTaskEvent,
  clampTimeoutMinutes,
  ensureDirs,
  isPidAlive,
  latestEventsByIds,
  readRegistry,
  readResultJson,
  readStats,
  reapDeadTasks,
  recordOrchestrator,
  TASKS_DIR,
  terminateDetachWorker,
  touchOrchestrator,
  WORKER_MODELS,
} from '../registry';
import { orchestratorBriefing } from '../prompts';
import {
  exhaustedWindows,
  ExtraUsage,
  formatAge,
  formatRelativeReset,
  getCachedUsage,
  isElevated,
  isLoginExpired,
  listAccounts,
  refreshAllUsageIfStale,
  resolveProbeCommand,
  UsageWindow,
} from '../usage';
import {
  CANCELLED_ERROR,
  DispatchArgs,
  formatExhaustedWindow,
  overageEnabled,
  RELOGIN_SHELL_CAVEAT,
  reloginCommand,
  runDispatchTask,
  TaskBase,
} from './task-runner';
import { GatewayManager } from '../mesh/gateway';
import { WorkerPool } from '../mesh/pool';
import { Bridge } from '../mesh/bridge';
import {
  IBridge,
  IGatewayManager,
  IWorkerPool,
  meshError,
  meshGatewayName,
  meshPlatformSupported,
  meshStateFile,
  MeshState,
  MESH_TOOLS,
  RECEIVE_MESSAGES_DEFAULT,
  RECEIVE_MESSAGES_MAX,
  RECEIVE_WAIT_DEFAULT_S,
  RECEIVE_WAIT_MAX_S,
  renderInboundMessage,
  validateSendInput,
  WorkerSpawnSpec,
} from '../mesh/contract';

/**
 * cco-dispatch — a minimal MCP stdio server the Claude Code panel connects
 * to. It exposes dispatch tools so the main session (e.g. Fable 5) can fan
 * work out to other Claude accounts. Each worker run is a Claude Code session
 * under that account's CLAUDE_CONFIG_DIR, in the same workspace cwd.
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

const SERVER_INFO = { name: 'cco-dispatch', version: '0.5.0' };
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

function isAborted(requestId: string | number | null): boolean {
  return requestId !== null && abortedRequests.has(requestId);
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

/**
 * Best-effort terminal note appended to a task's output file so a cancelled or
 * shut-down task does not sit at "status: RUNNING" forever. APPENDS ONLY — the
 * RUNNING header and the prompt above it stay readable; the file is never
 * rewritten. Called from the terminal-EVENT sites (cancelRequest / shutdown) and
 * NOT from dispatchTask's aborted short-circuit, so the note is written once per
 * task. Never throws.
 */
function appendCancelledNote(base: TaskBase, reason: string): void {
  if (!base.outputFile) {
    return;
  }
  try {
    fs.appendFileSync(
      base.outputFile,
      `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n`,
    );
  } catch {
    // best effort — the terminal task event is already recorded
  }
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
      try {
        appendTaskEvent({ ...base, ts: Date.now(), status: 'error', error: CANCELLED_ERROR });
      } catch {
        // a task-log write failure must not leave the child alive
      }
      appendCancelledNote(base, CANCELLED_ERROR);
    }
    const child = childrenByTask.get(taskId);
    if (child !== undefined) {
      killChild(child, KILL_GRACE_MS);
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
  try {
    fs.writeFileSync(path.join(TASKS_DIR, `${taskId}.cancel`), String(Date.now()));
  } catch {
    // even without the marker the signal below still kills the worker; the supervisor
    // classifies the death as a WorkerKilledError (no failover) as a fallback
  }
  // Fire-and-forget: terminateDetachWorker escalates SIGTERM→SIGKILL over a grace and
  // appends no events. cancelRequest is synchronous, so we do not await it.
  void terminateDetachWorker(taskId, KILL_GRACE_MS);
}

/**
 * Tear the server down without orphaning workers. Signals the children first
 * (they burn quota every second they live), records the tasks as failed, and
 * only exits once the SIGKILL grace has elapsed. Safe to call from a signal
 * handler: it never throws and is idempotent.
 */
function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // Mark every in-flight request aborted BEFORE killing any child. When our own
  // SIGTERM makes a worker's child die, dispatchTask's catch takes the
  // isAborted() short-circuit — exactly as it does for a client cancellation:
  // no recordFailure (a shutdown we caused must not inflate the worker's error
  // count or cool it down) and no competing terminal event. Shutdown's own
  // { status:'error', error: reason } event below stays the last word per task.
  for (const id of inFlightRequests) {
    abortedRequests.add(id);
  }
  // Tear down the mesh before exit: stop the bridge (prune its mirrors) and the gateway
  // (kill the relay child — it is not in childrenByTask, so the sweep below never reaches
  // it), and release the owner lock. The `--bg` mesh workers are deliberately left running.
  stopMesh();
  const children = [...childrenByTask.values()];
  for (const child of children) {
    signalTree(child, 'SIGTERM');
  }
  for (const base of [...taskBases.values()]) {
    try {
      appendTaskEvent({ ...base, ts: Date.now(), status: 'error', error: reason });
    } catch {
      // best effort — exiting regardless
    }
    appendCancelledNote(base, reason);
  }
  taskBases.clear();

  let exited = false;
  const finish = (): void => {
    if (exited) {
      return;
    }
    exited = true;
    process.exit(0);
  };

  // Exit as soon as every child has actually gone rather than always waiting
  // the full grace period: count the still-live children and decrement as each
  // one closes. The grace timer below is only a backstop for a child that
  // ignores SIGTERM.
  let live = 0;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      live++;
      child.once('close', () => {
        live--;
        if (live === 0 && shuttingDown) {
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
          }
          finish();
        }
      });
    }
  }
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
    finish();
  }, SHUTDOWN_GRACE_MS);
}

interface BatchArgs {
  tasks?: DispatchArgs[];
}

/**
 * In-process default dispatch: build the request-scoped context — cancellation
 * check, id tracking, child registration, and cleanup, all backed by this
 * server's live maps — and run the shared per-task core. The default path still
 * registers each worker child in childrenByTask via onSpawn, so stdin-close
 * shutdown (D4) and request cancel (D5) keep signalling in-flight workers exactly
 * as before.
 */
function dispatchTask(args: DispatchArgs, requestId: string | number | null): Promise<string> {
  // Opt-in ownership/survival: hand the whole run to a standalone supervisor and
  // relay its result. Everything about blocking and the return string is unchanged
  // (contract §3) — only the host process differs.
  if (args.detach === true) {
    return dispatchDetached(args, requestId);
  }
  return runDispatchTask(args, {
    shouldAbort: () => isAborted(requestId),
    onTrack: (base) => trackTask(requestId, base),
    onSpawn: (taskId, child) => registerChild(taskId, child),
    onSettle: (taskId) => {
      taskBases.delete(taskId);
    },
  });
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

/** The subset of tasks/<id>.result.json the server reads to relay (contract §5.4). */
interface ResultJson {
  status: 'done' | 'error';
  text: string;
  error?: string;
}

/**
 * Detached dispatch. The server picks the task id, writes a task spec, spawns the
 * supervisor (out/mcp/run-task.js) as its own detached, unref'd process — and,
 * crucially, does NOT register it in childrenByTask / taskBases / tasksByRequest.
 * That single omission is the whole shutdown-exclusion mechanism: shutdown() and
 * cancelRequest() only ever touch those maps, so neither signals the supervisor nor
 * writes a terminal event for it (contract §5.3 — the supervisor is sole author).
 *
 * The server then waits for tasks/<id>.result.json, bounded by the same worker-
 * timeout ceiling as the default path plus a write grace, and relays the identical
 * inline string (done) or throws the identical error (parity with the default
 * failure). If the session dies while waiting, process exit abandons the wait; the
 * supervisor is a separate process group and completes regardless.
 */
function dispatchDetached(args: DispatchArgs, requestId: string | number | null): Promise<string> {
  ensureDirs();
  const registry = readRegistry();
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cwd = process.cwd();
  const specPath = path.join(TASKS_DIR, `${id}.spec.json`);
  const resultPath = path.join(TASKS_DIR, `${id}.result.json`);
  fs.writeFileSync(specPath, JSON.stringify({ id, cwd, args }));

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

  // __dirname is the bundle's own dir (out/mcp) — run-task.js is emitted beside
  // server.js and installed beside it. Same node binary, so the supervisor is
  // version-locked to this server.
  const runTaskJs = path.join(__dirname, 'run-task.js');
  const child = spawn(process.execPath, [runTaskJs, specPath], {
    cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  // Let this process exit without waiting on the supervisor: survival is the point.
  child.unref();

  // Ceiling sized to the supervisor's TRUE worst case, not one attempt: an unnamed
  // dispatch fails over across every worker, each attempt getting its own full timer,
  // so the wall clock can be maxAttempts × (timeout + kill/reap grace) + a write grace.
  // The single-attempt ceiling used before made a legitimately-slow failover relay a
  // spurious "did not produce a result" while the default path would have returned the
  // real result (the F3 §3 parity break). The liveness-aware wait below normally settles
  // long before this — the moment result.json lands or the supervisor exits — so this is
  // only a last-resort backstop for a supervisor that is alive but never writes.
  const maxAttempts = args.worker ? 1 : Math.max(1, registry.workers.length);
  const perAttemptMs =
    clampTimeoutMinutes(args.timeout_minutes ?? registry.workerTimeoutMinutes) * 60_000 +
    ATTEMPT_KILL_REAP_GRACE_MS;
  const timeoutMs = maxAttempts * perAttemptMs + RESULT_WAIT_GRACE_MS;

  return new Promise<string>((resolve, reject) => {
    let done = false;
    // A spawn failure (e.g. the run-task bundle is missing) would otherwise hang the
    // wait to its ceiling — surface it immediately instead, and unlink the spec the
    // supervisor (which never ran) would have cleaned up, so the verbatim prompt does
    // not linger on disk (F6).
    child.on('error', (err) => {
      if (done) {
        return;
      }
      done = true;
      try {
        fs.unlinkSync(specPath);
      } catch {
        // best effort — the id is unique, so a leftover spec is litter, not a hazard
      }
      reject(new Error(`Failed to launch the detached task supervisor: ${err.message}`));
    });
    waitForResultFile(resultPath, timeoutMs, child).then(
      (result) => {
        if (done) {
          return;
        }
        done = true;
        if (result.status === 'error') {
          reject(new Error(result.error ?? result.text));
        } else {
          resolve(result.text);
        }
      },
      (err) => {
        if (done) {
          return;
        }
        done = true;
        reject(err);
      },
    );
  }).finally(untrack);
}

/** Grace after the supervisor exits to let its just-renamed result.json become visible. */
const EXIT_READ_GRACE_MS = 150;

/**
 * Resolve when tasks/<id>.result.json exists and parses, settle early when the supervisor
 * process exits, else reject at the ceiling. fs.watch on TASKS_DIR is the fast path; a
 * 200ms poll is the fallback for platforms or filesystems where directory watch events are
 * unreliable. The final name only ever appears via atomic rename, so a successful read is
 * never torn (the JSON.parse guard is belt-and-suspenders).
 *
 * `supervisor`, when supplied, makes the wait LIVENESS-AWARE (contract F3): the supervisor
 * writes result.json (atomic rename) BEFORE it exits, so its 'exit' means the result either
 * exists now or never will. On exit we read once more after a short grace; still absent →
 * it crashed / was killed before writing (R6) → reject immediately rather than waiting out
 * the whole ceiling. This is what lets a long, legitimate multi-attempt failover run relay
 * inline: while the supervisor is alive and working, no fixed single-attempt clock fires.
 * Never leaves a timer, watcher, or exit listener armed after it settles.
 */
function waitForResultFile(
  resultPath: string,
  timeoutMs: number,
  supervisor?: ChildProcess,
): Promise<ResultJson> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      settled = true;
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      if (ceilingTimer !== undefined) {
        clearTimeout(ceilingTimer);
      }
      if (exitGraceTimer !== undefined) {
        clearTimeout(exitGraceTimer);
      }
      if (supervisor !== undefined) {
        supervisor.removeListener('exit', onExit);
      }
    };
    const tryRead = (): void => {
      if (settled) {
        return;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ResultJson;
        cleanup();
        resolve(parsed);
      } catch {
        // Not written yet (ENOENT), or — never expected under atomic rename — a torn
        // read: either way wait for the next watch event / poll tick. cleanup/resolve
        // do not throw, so this only ever swallows the read/parse.
      }
    };
    function onExit(): void {
      if (settled) {
        return;
      }
      // The supervisor renames result.json into place before exiting; if exit and that
      // rename race, one more read after a short grace catches it. Still absent → the
      // supervisor died before writing.
      exitGraceTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        tryRead();
        if (settled) {
          return;
        }
        cleanup();
        reject(
          new Error(
            'The detached task supervisor exited without recording a result — it likely crashed or ' +
              'was killed. Check the task list for its reconciled status (a reaper records its final state).',
          ),
        );
      }, EXIT_READ_GRACE_MS);
    }
    try {
      watcher = fs.watch(TASKS_DIR, (_event, filename) => {
        if (filename === path.basename(resultPath)) {
          tryRead();
        }
      });
    } catch {
      // directory watch unsupported here — the poll below still finds the file
    }
    pollTimer = setInterval(tryRead, 200);
    if (supervisor !== undefined) {
      supervisor.on('exit', onExit);
    }
    ceilingTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      cleanup();
      // R6: the supervisor is alive but never produced a result within even the failover
      // worst case. Surface a timeout error — the same shape of failure a default dispatch
      // would surface, so the caller is not left waiting forever.
      reject(
        new Error(
          'Detached task did not produce a result within the worker-timeout window. It may still ' +
            'be running in the background — check the task list for its recorded result.',
        ),
      );
    }, timeoutMs);
    // The file can already exist (a very fast supervisor) before either watcher or
    // poll is armed.
    tryRead();
  });
}

async function dispatchTasksParallel(args: BatchArgs, requestId: string | number | null): Promise<string> {
  const tasks = args.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('dispatch_tasks requires a non-empty "tasks" array.');
  }
  // Every task in the batch runs under this one request id, so cancelling the
  // request cancels the whole batch.
  const results = await Promise.allSettled(tasks.map((t) => dispatchTask(t, requestId)));
  const parts = results.map((r, i) => {
    const title = tasks[i].title ?? `task ${i + 1}`;
    return r.status === 'fulfilled'
      ? `===== Task ${i + 1}: ${title} =====\n${r.value}`
      : `===== Task ${i + 1}: ${title} =====\nFAILED: ${r.reason instanceof Error ? r.reason.message : r.reason}`;
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
  status: 'running' | 'done' | 'error' | 'not_found';
  title?: string;
  worker?: string;
  model?: string;
  ts?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The terminal result text (from result.json, else the output file) — set when terminal. */
  result?: string;
}

/** Read a task's output-file body, or undefined if it cannot be read. */
function readOutputBody(outputFile: string | undefined): string | undefined {
  if (typeof outputFile !== 'string' || outputFile === '') {
    return undefined;
  }
  try {
    return fs.readFileSync(outputFile, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * dispatch_status — retrieval of one or more dispatched tasks by id (contract §6).
 * Reads the latest tasks.jsonl event per id and, when the task is terminal, attaches its
 * result text (preferring the exact tasks/<id>.result.json string a detach task recorded,
 * falling back to the tasks/<id>.md body). Returns a JSON object `{ tasks: [...] }` the
 * orchestrator can parse.
 *
 * Spawns nothing, but is NOT purely read-only: it first runs a BOUNDED reaper reconcile
 * over the requested ids (contract F2 / R8). The reaper is otherwise only wired to VS Code
 * extension startup, so in a headless/CLI deployment — exactly the "session was interrupted,
 * retrieve later" case this tool serves — a crashed supervisor's task would sit `running`
 * forever. Reconciling just the ids being asked about heals that here, writing nothing the
 * reaper would not have written and touching no unrelated task.
 */
function dispatchStatus(args: { id?: unknown; ids?: unknown }): string {
  const ids: string[] = [];
  if (typeof args.id === 'string' && args.id.trim()) {
    ids.push(args.id.trim());
  }
  if (Array.isArray(args.ids)) {
    for (const x of args.ids) {
      if (typeof x === 'string' && x.trim()) {
        ids.push(x.trim());
      }
    }
  }
  if (ids.length === 0) {
    throw new Error('dispatch_status requires "id" (a task id string) or "ids" (an array of task id strings).');
  }
  const unique = [...new Set(ids)];
  // Headless reconcile of just these ids before reading their status, so a dead
  // supervisor's ledger is healed even with no VS Code host (F2). Never throws.
  try {
    reapDeadTasks(unique);
  } catch {
    // reconcile is best-effort — a failed sweep must not fail the status read
  }
  const latest = latestEventsByIds(unique);
  const tasks: StatusRecord[] = unique.map((id) => {
    const ev = latest.get(id);
    if (ev === undefined) {
      return { id, found: false, status: 'not_found' };
    }
    const rec: StatusRecord = {
      id,
      found: true,
      status: ev.status,
      title: ev.title,
      worker: ev.worker,
      model: ev.model,
      ts: ev.ts,
    };
    if (ev.status === 'error') {
      rec.error = ev.error;
    }
    if (ev.status === 'done') {
      rec.inputTokens = ev.inputTokens ?? 0;
      rec.outputTokens = ev.outputTokens ?? 0;
      rec.costUsd = ev.costUsd ?? 0;
    }
    // Terminal → attach the result body. Prefer the exact result.json text (what a
    // detach task recorded and the server would have relayed); fall back to the
    // output file for a default task, which has no result.json.
    if (ev.status !== 'running') {
      const rj = readResultJson(id);
      rec.result = typeof rj?.text === 'string' ? rj.text : readOutputBody(ev.outputFile);
    }
    return rec;
  });
  return JSON.stringify({ tasks }, null, 2);
}

/**
 * Refresh the usage cache before a list_workers render when it is stale, bounding
 * spawns so repeated calls inside the window reuse the cache. Delegates the
 * staleness decision to refreshAllUsageIfStale, which skips probing only when
 * EVERY account's cached reading is within 120s — per-account freshness, so a
 * newly added worker (no cache entry) triggers a refresh even when the others are
 * fresh. Never throws — a failed refresh just leaves the previous (or absent) readings.
 */
async function refreshUsageIfStale(): Promise<void> {
  try {
    // Short 5s per-probe timeout on this path: list_workers awaits the full
    // refresh, so one hung/misauthenticated account must not pin a whole
    // concurrency wave for the default 20s and block the tool call ~40s.
    await refreshAllUsageIfStale(120_000, undefined, 3, 5000);
  } catch {
    // Probe or cache-write failure degrades to whatever the cache already holds.
  }
}

function renderWindow(w: UsageWindow): string {
  const percent = typeof w.percent === 'number' && isFinite(w.percent) ? Math.round(w.percent) : 0;
  const severity = typeof w.severity === 'string' && w.severity ? w.severity : 'normal';
  const resetsAt = typeof w.resetsAt === 'string' ? w.resetsAt : null;
  const marker = isElevated(severity) ? ` ⚠${severity}` : '';
  return `${w.label} ${percent}%${marker} (resets ${formatRelativeReset(resetsAt)})`;
}

/**
 * One live-usage line for an account. `available:false` with no error is
 * ambiguous: it is either a non-subscription login that genuinely has no plan
 * limits, or a subscription whose OAuth session expired. isLoginExpired() is the
 * single source of truth that separates the two (it only says yes on a fresh
 * loggedIn:false probe), so the server and the extension can never disagree.
 */
function usageLine(configDir: string): string {
  const usage = getCachedUsage(configDir);
  if (usage === undefined) {
    return 'usage: — (refreshing)';
  }
  if (usage.error !== undefined) {
    return `usage unavailable: ${usage.error}`;
  }
  if (usage.available !== true) {
    if (isLoginExpired(usage)) {
      return (
        `login expired / logged out — re-login needed (${reloginCommand(configDir)}) — ` +
        'automatic assignment skips this worker'
      );
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

async function listWorkers(): Promise<string> {
  await refreshUsageIfStale();
  const registry = readRegistry();
  // listAccounts() is 'main' + every distinct worker config dir. Workers sharing
  // the main config dir read the same 'main' entry, which is the right answer.
  const main = listAccounts().find((a) => a.name === 'main');
  const mainBlock = main ? `main (this session)\n  ${usageLine(main.configDir)}` : '';
  const overageDirs = [
    ...(main ? [main.configDir] : []),
    ...registry.workers.map((w) => w.configDir),
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
      ['No worker accounts registered.', mainBlock].filter(Boolean).join('\n\n') + moneyFooter
    );
  }
  const stats = readStats();
  const now = Date.now();
  const guard =
    registry.frontierWorkerDispatch !== 'allow'
      ? '\n\nFrontier worker dispatch (claude-fable-5) is DISABLED by the operator (billing guard) — ' +
        'for design consults and adversarial reviews use claude-opus-4-8 with ultrathink: true instead.'
      : '';
  const workerBlocks = registry.workers.map((w) => {
    const s = stats[w.name];
    let line = `- ${w.name}${w.preferred ? ' ★preferred' : ''}: default model ${w.model}`;
    if (s && s.tasks + s.errors > 0) {
      line += ` — ${s.tasks} tasks done, ${s.errors} errors, ${s.inputTokens} in / ${s.outputTokens} out tokens`;
      if (s.costUsd) {
        line += ` (~$${s.costUsd.toFixed(2)})`;
      }
    }
    const usageForWorker = getCachedUsage(w.configDir);
    // A logged-out account outranks cooldown as a status: cooldown expires on its
    // own, an expired login never does. Saying "available" here would be a lie.
    if (isLoginExpired(usageForWorker)) {
      line += ' — LOGGED OUT (re-login needed)';
    } else if (s?.cooldownUntil && s.cooldownUntil > now) {
      line += ` — COOLING DOWN until ${new Date(s.cooldownUntil).toLocaleTimeString()} (quota error)`;
    } else {
      line += ' — available';
    }
    // Live-usage exhaustion marker. session/weekly_all block all automatic
    // assignment; a lone weekly_scoped (Fable) window only refuses claude-fable-5.
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
    } else if (scoped.length > 0) {
      exhaustedLine = `\n  ⛔ Weekly Fable exhausted (resets ${formatRelativeReset(
        scoped[0].resetsAt,
      )}) — claude-fable-5 dispatches to this worker are refused`;
    }
    return `${line}\n  ${usageLine(w.configDir)}${exhaustedLine}`;
  });
  const loggedOutNames = registry.workers
    .filter((w) => isLoginExpired(getCachedUsage(w.configDir)))
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
    moneyFooter
  );
}

/* ------------------------------------------------------------------------- *
 * Mesh Mode (experimental, v1.4.0) — mesh_* tools wired over the gateway (P9),
 * the `claude --bg` worker pool (P10) and the cross-account bridge (P11). The
 * frozen contract lives in ../mesh/contract; the three subsystems are built by
 * sibling tasks in ../mesh/{gateway,pool,bridge}. See docs/session-messaging-spike.md
 * for why each mechanism behaves as it does.
 * ------------------------------------------------------------------------- */

/**
 * Lazily-initialized mesh runtime for THIS server process — one mesh per workspace,
 * held behind the owner lock in the mesh state file. `gateway` being set is the
 * initialized flag: it is assigned only after a fully successful ensureMesh(), so a
 * partial failure (e.g. gateway start) leaves the runtime uninitialized and the next
 * mesh tool call retries from scratch. `ownerLocked`/`state` let shutdown release the
 * lock (rewrite ownerPid 0) so a next session can take over instantly.
 */
interface MeshRuntime {
  gateway?: IGatewayManager;
  pool?: IWorkerPool;
  bridge?: IBridge;
  state?: MeshState;
  ownerLocked: boolean;
  /** Path of the atomic claim marker (M1) we created; used by stopMesh to release it. */
  lockFile?: string;
}
const mesh: MeshRuntime = { ownerLocked: false };
/** Single in-flight init latch: concurrent first callers await the same ensureMesh(). */
let meshInit: Promise<void> | undefined;

/**
 * The main (orchestrator) account's config dir — the account this server runs under,
 * and the gateway's and pool's default account. The test override comes first so the
 * suite can point the whole mesh at a scratch dir; otherwise the CLAUDE_CONFIG_DIR the
 * server inherited, else ~/.claude (the CLI default).
 */
function meshMainConfigDir(): string {
  return (
    process.env.CLAUDE_CODE_ORCHESTRATOR_TEST_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude')
  );
}

/** Parse the mesh state file, or undefined if absent/unreadable/malformed. Read-only. */
function readMeshState(file: string): MeshState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MeshState;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ownerPid !== 'number') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write the mesh state file atomically (tmp+rename, same pattern as run-task.ts's
 * result writes) so the extension UI — a concurrent reader in another process — never
 * observes a torn file. The state dir (ROOT_DIR/mesh) may not exist yet.
 */
function writeMeshState(file: string, state: MeshState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function dedupe(dirs: string[]): string[] {
  return [...new Set(dirs)];
}

/**
 * The cross-process claim lock for a workspace mesh (adversarial finding M1): a dedicated
 * marker file next to the state file, keyed to the same workspace hash. Distinct from the
 * state file so acquiring the claim never races the state-file writes the extension UI reads.
 */
function meshLockFile(cwd: string): string {
  return `${meshStateFile(cwd)}.lock`;
}

interface MeshLockRecord {
  ownerPid: number;
  /** Owner's process start marker — a sanity token against a recycled pid (M2). */
  startedAt: number;
}

/** Parse the lock marker's owner record, or undefined if absent/unreadable/malformed. Read-only. */
function readMeshLock(lockFile: string): MeshLockRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as MeshLockRecord;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ownerPid !== 'number') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Atomically claim the workspace mesh owner lock (adversarial finding M1). Uses the classic
 * write-tmp-then-hardlink idiom: writeFileSync fills a per-pid temp with our full record, then
 * fs.linkSync(tmp, lockFile) publishes it — link is atomic and fails with EEXIST if the marker
 * already exists, so of two servers starting together exactly one wins the claim and the caller's
 * state-file read-modify-write runs in a true cross-process critical section. Linking from an
 * already-written temp means the visible marker is never empty, so a racing taker never observes a
 * half-written lock. A marker left by a dead/released owner is stale: its recorded pid is not alive,
 * so we break it (unlink) and retry the link once. A marker held by a LIVE foreign pid ⇒ mesh_busy.
 *
 * Residual pid-reuse risk (adversarial finding M2): if a dead owner's pid was recycled by an
 * unrelated live process, isPidAlive() reports it alive and we would refuse a takeover that should
 * succeed. Node has no portable API to read another pid's real start time, so the recorded startedAt
 * is only a presence sanity token, not a full guard — this narrow window is documented rather than
 * closed. stopMesh writes ownerPid 0 AND drops this marker on clean shutdown, so the common path
 * (graceful restart) is reuse-proof; the window is confined to an owner that died without shutdown.
 */
function acquireMeshLock(lockFile: string): void {
  const record = JSON.stringify({ ownerPid: process.pid, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${lockFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, record);
    try {
      fs.linkSync(tmp, lockFile); // atomic publish; EEXIST if already held
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      const holder = readMeshLock(lockFile);
      if (holder && holder.ownerPid === process.pid) {
        return; // already ours (a retry after a later init step failed) — nothing to reclaim
      }
      if (holder && isPidAlive(holder.ownerPid)) {
        throw new Error(
          meshError(
            'mesh_busy',
            `another orchestrator session owns the mesh for this workspace (pid ${holder.ownerPid}).`,
          ),
        );
      }
      // Stale marker (owner dead / released / unreadable): break it and retry once.
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // already removed by a racing taker — the retry's linkSync decides the winner
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // tmp already consumed by linkSync, or never created
      }
    }
  }
  throw new Error(
    meshError('mesh_busy', 'could not claim the mesh owner lock for this workspace (contended startup).'),
  );
}

/** Release the claim marker, but only if it still records OUR pid (never remove a peer's lock). */
function releaseMeshLock(lockFile: string): void {
  try {
    const holder = readMeshLock(lockFile);
    if (holder && holder.ownerPid === process.pid) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // best effort — a marker left behind is broken by the staleness check on next start
  }
}

/**
 * Initialize the mesh runtime on the FIRST mesh tool call, guarded by a single
 * in-flight promise so concurrent first callers await the same init. The registry is
 * re-read on every call UNTIL initialized; after init, toggling meshMode off only
 * takes effect on the next server start (there is no live teardown path).
 */
async function ensureMesh(): Promise<void> {
  // M5: re-check the master switch on EVERY mesh tool call, even after init. The
  // initialized short-circuit below otherwise pins meshMode to its value at first init,
  // so an operator toggling meshMode off mid-session would leave mesh_send/spawn/receive
  // running while only mesh_status reported OFF. Gate here so a toggle-off refuses new
  // tool actions immediately. NOTE: this is a GATE only — it does not tear down the
  // already-running gateway/bridge/workers; a full mid-session teardown on toggle-off is
  // future work. mesh_status keeps its own meshMode check and does not call ensureMesh
  // while off, so it still renders the static OFF text without hitting this throw.
  if (readRegistry().meshMode !== 'on') {
    throw new Error(
      meshError('mesh_off', 'enable claudeCodeOrchestrator.meshMode (experimental) in the extension settings.'),
    );
  }
  if (mesh.gateway) {
    return;
  }
  if (!meshInit) {
    // A failed init clears the latch and rethrows, so the next call retries (a
    // transient mesh_busy, or a gateway that failed to reach READY, is recoverable).
    meshInit = doEnsureMesh().catch((err) => {
      meshInit = undefined;
      throw err;
    });
  }
  return meshInit;
}

/** The ordered init steps (a–f of the task contract). Assigns to `mesh` only on full success. */
async function doEnsureMesh(): Promise<void> {
  // a. master switch
  const registry = readRegistry();
  if (registry.meshMode !== 'on') {
    throw new Error(
      meshError('mesh_off', 'enable claudeCodeOrchestrator.meshMode (experimental) in the extension settings.'),
    );
  }
  // b. platform (unix sockets only — mesh is a same-machine feature)
  if (!meshPlatformSupported()) {
    throw new Error(
      meshError('unsupported_platform', `mesh mode needs macOS or Linux; this platform is ${process.platform}.`),
    );
  }
  const cwd = process.cwd();
  const mainConfigDir = meshMainConfigDir();
  // Resolve the claude executable exactly as dispatch does at spawn time (usage.ts's
  // resolveProbeCommand), so the mesh is independent of when the registry was last synced.
  const claudePath = resolveProbeCommand();

  // c. owner lock: one mesh per workspace, claimed ATOMICALLY (adversarial finding M1).
  // The old read-liveness-then-write was a cross-process TOCTOU: two servers starting
  // together could both pass the liveness test and both init. The protocol is now:
  //   1. Fast reject — a live foreign owner already recorded ⇒ mesh_busy, no lock churn.
  //   2. acquireMeshLock — atomic hardlink claim of a dedicated marker, so the read-modify-
  //      write of the state file below runs in a true cross-process critical section; a
  //      stale marker from a dead/released owner is broken and re-taken inside there.
  //   3. Write our claim (ownerPid = us), then RE-READ and confirm ownerPid === our pid
  //      before proceeding — a defensive backstop that also fails us out if the marker was
  //      wrongly broken. A dead owner's worker ledger is preserved so takeover re-adopts.
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
  // Re-read the ledger UNDER the lock so a concurrent takeover cannot cost us a worker record.
  const ledger = readMeshState(stateFile);
  const state: MeshState = {
    ownerPid: process.pid,
    cwd,
    gatewayName: meshGatewayName(cwd),
    startedAt: Date.now(),
    workers: ledger?.workers ?? [],
  };
  writeMeshState(stateFile, state);
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

  // d. worker pool + one adopt() to re-claim any workers a previous owner left running.
  const pool = new WorkerPool({ claudePath, cwd: process.cwd(), mainConfigDir });
  pool.adopt();

  // e. gateway — must reach READY. A start failure propagates its capability_failed and
  // leaves the mesh uninitialized (nothing assigned below), so the next call retries.
  const gateway = new GatewayManager({
    claudePath,
    cwd,
    model: registry.meshGatewayModel,
    configDir: mainConfigDir,
  });
  await gateway.start();

  // f. cross-account bridge (experimental²) — only when double-opted-in.
  let bridge: IBridge | undefined;
  if (registry.meshCrossAccountBridge === 'on') {
    const participants = dedupe([mainConfigDir, ...registry.workers.map((w) => w.configDir)]);
    bridge = new Bridge({ participants });
    bridge.start();
  }

  // Assign last: `mesh.gateway` set is exactly what "initialized" means.
  mesh.pool = pool;
  mesh.gateway = gateway;
  mesh.bridge = bridge;
}

/** Clamp an optional numeric tool arg to [min, max] (rounded), falling back to a default. */
function clampMeshNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * mesh_status — the mesh diagnostic. NEVER throws mesh_off: with meshMode off it returns
 * a static explanation and does NOT initialize. With meshMode on it triggers ensureMesh
 * so the report reflects live reality; if init fails (busy, unsupported, gateway down)
 * the failure is folded into the readable text rather than surfaced as a tool error,
 * because a status tool must report a broken mesh, not error on it.
 */
async function meshStatus(): Promise<string> {
  const registry = readRegistry();
  const platform = meshPlatformSupported()
    ? `platform: supported (${process.platform})`
    : `platform: UNSUPPORTED (${process.platform}) — mesh needs macOS or Linux`;
  if (registry.meshMode !== 'on') {
    return [
      'Mesh mode: OFF (experimental).',
      'Enable "claudeCodeOrchestrator.meshMode" in the extension settings to arm the session mesh.',
      platform,
      'The mesh is not initialized while mesh mode is off.',
    ].join('\n');
  }
  let initError: string | undefined;
  try {
    await ensureMesh();
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }
  const lines: string[] = ['Mesh mode: ON (experimental).', platform];
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
  }
  lines.push(mesh.gateway ? `gateway: ${mesh.gateway.name} (${mesh.gateway.state})` : 'gateway: not initialized');
  if (registry.meshCrossAccountBridge !== 'on') {
    lines.push('bridge: off');
  } else if (mesh.bridge) {
    const s = mesh.bridge.status();
    lines.push(
      `bridge: ${s.enabled ? 'on' : 'off'} — ${s.participants} participant(s), ${s.mirrors} mirror(s)` +
        (s.degraded ? ` (degraded: ${s.degraded})` : ''),
    );
  } else {
    lines.push('bridge: enabled but not initialized');
  }
  const workers = mesh.pool?.list() ?? [];
  if (workers.length === 0) {
    lines.push('workers: none');
  } else {
    lines.push(`workers (${workers.length}):`);
    for (const w of workers) {
      const health = w.alive ? 'alive' : 'dead';
      const reg = w.registryStatus ? `/${w.registryStatus}` : '';
      const exhausted = w.accountExhausted ? ' ⚠account-exhausted' : '';
      lines.push(
        `  - ${w.name} [${w.account}] ${w.model} — ${health}${reg}${exhausted}\n      attach: ${w.attachCommand}`,
      );
    }
  }
  return lines.join('\n');
}

/** mesh_spawn_workers — spawn one or more `claude --bg` mesh workers (quota-aware placement). */
async function meshSpawnWorkers(args: unknown): Promise<string> {
  await ensureMesh();
  const workers = (args as { workers?: unknown } | null)?.workers;
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error(meshError('invalid_input', '"workers" must be a non-empty array of { role, brief }.'));
  }
  const results = await mesh.pool!.spawn(workers as WorkerSpawnSpec[]);
  const lines = results.map((r) =>
    r.ok
      ? `ok: ${r.name} — account ${r.account}, job ${r.jobId}, model ${r.model}` +
        (r.note ? ` (note: ${r.note})` : '')
      : `fail: ${r.error}`,
  );
  const ok = results.filter((r) => r.ok).length;
  return [
    `Spawned ${ok}/${results.length} mesh worker(s).`,
    ...lines,
    'Workers reply over the mesh — poll mesh_receive for their STATUS / RESULT / QUESTION lines.',
  ].join('\n');
}

/** mesh_send — relay a live message to a peer through the gateway; reports actual delivery state. */
async function meshSend(args: unknown): Promise<string> {
  await ensureMesh();
  const a = (args ?? {}) as { to?: unknown; message?: unknown; summary?: unknown };
  const invalid = validateSendInput(a.to, a.message, a.summary);
  if (invalid) {
    throw new Error(meshError('invalid_input', invalid));
  }
  // validateSendInput proved these are the right types. The upstream SendMessage tool
  // REQUIRES a summary for plain-text messages ("RELAY JSON missing required summary
  // field" otherwise — scenario-B probe H5), so an omitted summary is defaulted to the
  // message's first line rather than surfacing that transport error to the caller.
  const message = a.message as string;
  const summary =
    (a.summary as string | undefined) ?? message.split('\n', 1)[0].slice(0, 60);
  const result = await mesh.gateway!.send({
    to: a.to as string,
    summary,
    message,
  });
  // A delivered:false RESULT is a normal outcome carrying the upstream transport error.
  // gateway_down / relay_timeout are REJECTIONS from send() — they propagate to the tool
  // catch as `mesh error [code]: …` instead of reaching here.
  return result.delivered
    ? `delivered to ${a.to} (msg_id ${result.msgId ?? 'unknown'})`
    : `NOT delivered: ${result.error ?? 'unknown transport error'}`;
}

/** mesh_receive — long-poll the gateway inbox; renders each message as worker-supplied DATA. */
async function meshReceive(args: unknown): Promise<string> {
  await ensureMesh();
  const a = (args ?? {}) as { max_wait_seconds?: unknown; max_messages?: unknown };
  const waitS = clampMeshNumber(a.max_wait_seconds, 0, RECEIVE_WAIT_MAX_S, RECEIVE_WAIT_DEFAULT_S);
  const maxMessages = clampMeshNumber(a.max_messages, 1, RECEIVE_MESSAGES_MAX, RECEIVE_MESSAGES_DEFAULT);
  const messages = await mesh.gateway!.receive(waitS * 1000, maxMessages);
  if (messages.length === 0) {
    const alive = (mesh.pool?.list() ?? []).filter((w) => w.alive).length;
    return `no mesh messages (waited ${waitS}s). ${alive} workers alive.`;
  }
  const blocks = messages.map(renderInboundMessage).join('\n\n');
  return `${messages.length} mesh message(s):\n\n${blocks}`;
}

/** mesh_stop_worker — run `claude stop` for one worker under its account (force falls back to SIGKILL). */
async function meshStopWorker(args: unknown): Promise<string> {
  await ensureMesh();
  const a = (args ?? {}) as { name?: unknown; force?: unknown };
  if (typeof a.name !== 'string' || a.name.trim() === '') {
    throw new Error(meshError('invalid_input', '"name" must be a worker name from mesh_status.'));
  }
  const target = a.name.trim();
  const result = await mesh.pool!.stop(target, { force: a.force === true });
  if (result.ok) {
    return `stopped ${target}.`;
  }
  // pool.stop reports its own mesh-formatted error (e.g. unknown_worker); surface it
  // verbatim when it already carries the wire format, else wrap it as unknown_worker.
  throw new Error(
    result.error && /^mesh error \[/.test(result.error)
      ? result.error
      : meshError('unknown_worker', result.error ?? `could not stop worker "${target}".`),
  );
}

/**
 * Stop the mesh subsystems on server shutdown, WITHOUT touching the `--bg` workers —
 * they survive by design (owned by the CLI's background service, not this process).
 * Stops the bridge (prunes the registry mirrors it wrote) and the gateway (kills the
 * relay child; it was never registered in childrenByTask because it is not a task, so
 * shutdown's worker sweep never reaches it), then releases the owner lock by rewriting
 * ownerPid 0 so the next session takes over instantly. Re-reads the state file first so
 * the pool's latest worker ledger is preserved, and only releases a lock we still hold.
 * Never throws (called from shutdown, itself called from signal handlers).
 */
function stopMesh(): void {
  try {
    mesh.bridge?.stop();
  } catch {
    // best effort — exiting regardless
  }
  try {
    // stop() delivers the kill signal synchronously before its promise settles, so
    // voiding it still tears the relay child down before this process exits.
    void mesh.gateway?.stop();
  } catch {
    // best effort — exiting regardless
  }
  if (mesh.ownerLocked) {
    try {
      const file = meshStateFile(process.cwd());
      const current = readMeshState(file) ?? mesh.state;
      if (current && current.ownerPid === process.pid) {
        writeMeshState(file, { ...current, ownerPid: 0 });
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

const TASK_PROPERTIES = {
  title: { type: 'string', description: 'Short label for the task list UI.' },
  prompt: {
    type: 'string',
    description: 'Complete, self-contained instructions for the worker, with all needed context.',
  },
  model: {
    type: 'string',
    enum: [...WORKER_MODELS],
    description:
      'claude-opus-4-8 for hard reasoning/coding subtasks; claude-sonnet-5 for simpler or ' +
      'high-volume ones; claude-fable-5 ONLY for the highest-leverage dispatches — contract ' +
      'design/consult and adversarial review — and only when list_workers shows frontier ' +
      'dispatch enabled: it is the most expensive resource here (separate scarce quota, or ' +
      'pay-per-use billing on some plans) and the server rejects it when the operator has it ' +
      "blocked. Defaults to the worker's configured model.",
  },
  worker: {
    type: 'string',
    description:
      'Optional worker account name (see list_workers). Omit for automatic assignment with quota-aware ' +
      'failover. Workers whose live plan usage shows an exhausted window (>=99% and not yet reset) are ' +
      'skipped by automatic assignment and refused when named explicitly. Workers whose login has ' +
      'expired (shown as LOGGED OUT by list_workers) are skipped and refused the same way until ' +
      'the account is re-logged in — a completed re-login is detected automatically on the next ' +
      'dispatch, so retrying after re-logging in is enough.',
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
      'for the default, where a task is cancelled if the session ends before it finishes.',
  },
};

const TOOLS = [
  {
    name: 'dispatch_tasks',
    description:
      'Dispatch MULTIPLE independent tasks to worker Claude accounts in ONE call — they run in ' +
      'parallel across accounts (quota-aware round-robin). ALWAYS prefer this over several ' +
      'dispatch_task calls when you have more than one subtask; it guarantees true parallel ' +
      'execution. Each worker is a full Claude Code session with file and shell access to this ' +
      'workspace, but it does NOT see this conversation — every prompt must be complete and ' +
      'self-contained. Give each task a strong system_prompt (role, quality bar, output format). ' +
      'Do the integration, judgment, and final synthesis yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
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
      'the task automatically fails over to another worker when one is available.',
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
      'or error) and, for a finished task, its full result text. Pass a single "id", or "ids" for ' +
      'several at once.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A single dispatched-task id to inspect.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several dispatched-task ids to inspect in one call.',
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
          description: 'Exact model ID of this (main/orchestrator) session, e.g. from your system prompt.',
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
      'fan-outs to pick models/workers deliberately and avoid accounts near a limit.',
    inputSchema: { type: 'object', properties: {} },
  },
  // Experimental Mesh Mode tools (v1.4.0): the frozen schemas from the mesh contract,
  // spread in verbatim so the extension and server can never disagree on their shape.
  ...MESH_TOOLS,
];

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
  if (stdinClosed && pending === 0) {
    process.exit(0);
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ id, error: { code, message } });
}

async function handleRequest(msg: {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  const { id, method, params } = msg;
  if (method === undefined) {
    return;
  }
  // The client cancels an in-flight tools/call with this notification. It is the
  // only notification we act on, and — like every notification — it gets no response.
  if (method === 'notifications/cancelled') {
    const requestId = params?.requestId;
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      // Unknown or already-settled ids are ignored silently by cancelRequest.
      cancelRequest(requestId);
    }
    return;
  }
  // Any other notification (no id) needs no response.
  if (id === undefined) {
    return;
  }
  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as DispatchArgs & BatchArgs;
      // Only the workspace's main session talks to this server, so any tool
      // call proves it is alive — surfaces activity in the dashboard even
      // before the session has (re-)briefed.
      try {
        touchOrchestrator(process.cwd());
      } catch {
        // best-effort liveness marker only
      }
      // Only a string/number id can be named by notifications/cancelled.
      const reqId: string | number | null = typeof id === 'string' || typeof id === 'number' ? id : null;
      pending++;
      if (reqId !== null) {
        inFlightRequests.add(reqId);
      }
      try {
        let text: string;
        if (name === 'dispatch_task') {
          text = await dispatchTask(args, reqId);
        } else if (name === 'dispatch_tasks') {
          text = await dispatchTasksParallel(args, reqId);
        } else if (name === 'dispatch_status') {
          text = dispatchStatus(args as { id?: unknown; ids?: unknown });
        } else if (name === 'orchestrator_briefing') {
          const model = ((args as { model?: string }).model ?? '').trim();
          if (!model) {
            throw new Error('orchestrator_briefing requires "model".');
          }
          recordOrchestrator(process.cwd(), model);
          // Mesh doctrine is injected only when Mesh Mode is on, so the orchestrator
          // learns when to reach for the mesh_* tools instead of always dispatching.
          let meshOn = false;
          try {
            meshOn = readRegistry().meshMode === 'on';
          } catch {
            meshOn = false;
          }
          text = orchestratorBriefing(model, meshOn);
        } else if (name === 'list_workers') {
          text = await listWorkers();
        } else if (name === 'mesh_status') {
          text = await meshStatus();
        } else if (name === 'mesh_spawn_workers') {
          text = await meshSpawnWorkers(args);
        } else if (name === 'mesh_send') {
          text = await meshSend(args);
        } else if (name === 'mesh_receive') {
          text = await meshReceive(args);
        } else if (name === 'mesh_stop_worker') {
          text = await meshStopWorker(args);
        } else {
          sendError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        // A cancelled request gets no response at all — the client is no longer
        // waiting on this id and a late result would be a protocol violation.
        if (!isAborted(reqId)) {
          sendResult(id, { content: [{ type: 'text', text }] });
        }
      } catch (err) {
        if (!isAborted(reqId)) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          });
        }
      } finally {
        pending--;
        if (reqId !== null) {
          inFlightRequests.delete(reqId);
          abortedRequests.delete(reqId);
          tasksByRequest.delete(reqId);
          detachTasksByRequest.delete(reqId);
        }
        maybeExit();
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    try {
      const msg = JSON.parse(line);
      void handleRequest(msg);
    } catch {
      // Ignore malformed lines rather than crashing the transport.
    }
  });
  rl.on('close', () => {
    // stdin EOF means the client is gone: nobody will ever read our responses,
    // so there is nothing to drain. Waiting for `pending` here is what let
    // workers orphan and burn quota for the full worker timeout window.
    stdinClosed = true;
    shutdown(SHUTDOWN_REASON);
  });
  // Signal handlers must never throw; shutdown() is already total and idempotent.
  const onSignal = (signal: string) => () => {
    try {
      shutdown(`${SHUTDOWN_REASON} (${signal})`);
    } catch {
      process.exit(0);
    }
  };
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
}

main();
