import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ChildProcess, spawn } from 'child_process';
import {
  appendTaskEvent,
  emptyStats,
  ensureDirs,
  readRegistry,
  readStats,
  recordOrchestrator,
  Registry,
  runningCounts,
  TASKS_DIR,
  TaskEvent,
  WORKER_MODELS,
  WorkerProfile,
  writeStats,
} from '../registry';
import { isFrontierTier, orchestratorBriefing, WORKER_BASE_PROMPT } from '../prompts';
import {
  ExtraUsage,
  formatAge,
  formatRelativeReset,
  getCachedUsage,
  isElevated,
  listAccounts,
  readUsageCache,
  refreshAllUsage,
  UsageWindow,
} from '../usage';

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
 * The wire protocol is newline-delimited JSON-RPC (MCP stdio transport),
 * implemented directly to keep the server dependency-free.
 */

const SERVER_INFO = { name: 'cco-dispatch', version: '0.4.0' };
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL when cancelling a single request's workers. */
const KILL_GRACE_MS = 3000;
/** Grace between SIGTERM and SIGKILL while the whole server is going down. */
const SHUTDOWN_GRACE_MS = 2500;
const CANCELLED_ERROR = 'cancelled by the orchestrator session';
const SHUTDOWN_REASON = 'cancelled — orchestrator session ended';

let rrIndex = 0;

/**
 * Process lifecycle. A worker is a `claude -p` child that bills real quota, so
 * it must never outlive the request that asked for it, and never outlive this
 * server. Cancellation arrives as an MCP `notifications/cancelled` for a
 * request id; a dead orchestrator session arrives as stdin EOF or a signal.
 */

/** Identity of a task, enough to append a terminal event for it. */
type TaskBase = Pick<TaskEvent, 'id' | 'title' | 'worker' | 'model' | 'outputFile' | 'cwd'>;

/** Live worker children, by task id. Present only while the child is running. */
const childrenByTask = new Map<string, ChildProcess>();
/** JSON-RPC request id → the task ids it spawned. dispatch_tasks maps one id to N tasks. */
const tasksByRequest = new Map<string | number, Set<string>>();
/** Non-terminal tasks, by task id — the tasks a cancellation must mark as errored. */
const taskBases = new Map<string, TaskBase>();
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
 * Cancel one request: kill its workers and record them as cancelled. The
 * request's own `tools/call` sees the aborted flag and sends no response.
 * Unknown or already-settled request ids are ignored silently.
 */
function cancelRequest(requestId: string | number): void {
  if (!inFlightRequests.has(requestId)) {
    return;
  }
  abortedRequests.add(requestId);
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
    }
    const child = childrenByTask.get(taskId);
    if (child !== undefined) {
      killChild(child, KILL_GRACE_MS);
    }
  }
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

interface DispatchArgs {
  title?: string;
  prompt?: string;
  model?: string;
  worker?: string;
  system_prompt?: string;
  /** Escalate the worker to maximum reasoning depth via the thinking keyword. */
  ultrathink?: boolean;
}

interface BatchArgs {
  tasks?: DispatchArgs[];
}

interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function isQuotaError(message: string): boolean {
  return /quota|usage limit|rate.?limit|limit (reached|exceeded)|too many requests|overloaded|429|529/i.test(
    message,
  );
}

/** Workers not on cooldown and not already attempted, in round-robin order. */
function pickWorker(
  workers: WorkerProfile[],
  preferred: string | undefined,
  attempted: Set<string>,
): WorkerProfile {
  if (preferred) {
    const found = workers.find((w) => w.name === preferred);
    if (found && !attempted.has(found.name)) {
      // Explicitly requested worker is honored even during cooldown.
      return found;
    }
    if (found) {
      throw new Error(`Worker "${preferred}" already failed this task.`);
    }
  }
  const stats = readStats();
  const now = Date.now();
  const eligible = workers.filter(
    (w) => !attempted.has(w.name) && (stats[w.name]?.cooldownUntil ?? 0) <= now,
  );
  if (eligible.length === 0) {
    const cooling = workers
      .filter((w) => (stats[w.name]?.cooldownUntil ?? 0) > now)
      .map((w) => `${w.name} (until ${new Date(stats[w.name]!.cooldownUntil!).toLocaleTimeString()})`);
    throw new Error(
      cooling.length > 0
        ? `No eligible worker: cooling down after quota errors — ${cooling.join(', ')}. ` +
          'Wait for the cooldown, add another worker account, or retry with an explicit "worker".'
        : 'No eligible worker available.',
    );
  }
  // Preferred worker (usually the main session's own account) wins when it
  // isn't busier than the least-busy alternative — favored, never flooded.
  const starred = eligible.find((w) => w.preferred);
  if (starred) {
    const others = eligible.filter((w) => !w.preferred);
    if (others.length === 0) {
      return starred;
    }
    const running = runningCounts();
    const minOther = Math.min(...others.map((w) => running[w.name] ?? 0));
    if ((running[starred.name] ?? 0) <= minOther) {
      return starred;
    }
    const worker = others[rrIndex % others.length];
    rrIndex++;
    return worker;
  }
  const worker = eligible[rrIndex % eligible.length];
  rrIndex++;
  return worker;
}

function recordSuccess(name: string, run: RunResult): void {
  const stats = readStats();
  const s = stats[name] ?? emptyStats();
  s.tasks++;
  s.inputTokens += run.inputTokens;
  s.outputTokens += run.outputTokens;
  s.costUsd += run.costUsd;
  s.lastUsedAt = Date.now();
  s.lastError = undefined;
  stats[name] = s;
  writeStats(stats);
}

function recordFailure(name: string, message: string, quota: boolean, cooldownMinutes: number): void {
  const stats = readStats();
  const s = stats[name] ?? emptyStats();
  s.errors++;
  s.lastUsedAt = Date.now();
  s.lastError = message.slice(0, 300);
  if (quota) {
    s.cooldownUntil = Date.now() + cooldownMinutes * 60_000;
  }
  stats[name] = s;
  writeStats(stats);
}

function runClaude(
  registry: Registry,
  configDir: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  onSpawn?: (child: ChildProcess) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let args = ['-p', '--output-format', 'json', '--model', model, '--permission-mode', registry.permissionMode];
    // Every worker gets the base engineering prompt; task-specific guidance
    // from the orchestrator (if any) is appended after it.
    const combinedSystemPrompt = [WORKER_BASE_PROMPT, systemPrompt].filter(Boolean).join('\n\n---\n\n');
    args.push('--append-system-prompt', combinedSystemPrompt);
    const useShell = process.platform === 'win32';
    if (useShell) {
      args = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
    }
    // detached: on POSIX the child leads its own process group (pgid === pid), so
    // signalTree() can take down the worker's own dispatch server and anything it
    // delegated to. stdio stays implicit ('pipe' × 3): detached does not change it,
    // and naming it here would drop the ChildProcessWithoutNullStreams overload.
    // Deliberately NOT unref()'d — the 'close' event is how a run completes.
    // POSIX only: on Windows `detached` gives the child its own console and lets
    // it OUTLIVE this process — the opposite of what we want. There the tree is
    // taken down with `taskkill /T` instead, and no pgid is recorded.
    const child = spawn(registry.claudePath, args, {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      shell: useShell,
      detached: process.platform !== 'win32',
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      signalTree(child, 'SIGTERM');
      reject(new Error(`Worker timed out after ${WORKER_TIMEOUT_MS / 60000} minutes.`));
    }, WORKER_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start "${registry.claudePath}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      interface CliResult {
        result?: string;
        is_error?: boolean;
        subtype?: string;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      }
      let parsed: CliResult | undefined;
      try {
        parsed = JSON.parse(stdout) as CliResult;
      } catch {
        // non-JSON output — handled below
      }
      const usage = {
        inputTokens: parsed?.usage?.input_tokens ?? 0,
        outputTokens: parsed?.usage?.output_tokens ?? 0,
        costUsd: parsed?.total_cost_usd ?? 0,
      };
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
        return;
      }
      if (parsed?.is_error) {
        reject(new Error(`Worker error (${parsed.subtype ?? 'unknown'}): ${parsed.result ?? ''}`.slice(0, 2000)));
        return;
      }
      resolve({ text: parsed?.result ?? stdout.trim(), ...usage });
    });
    // Prompt goes over stdin to avoid shell-quoting issues.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function dispatchTask(args: DispatchArgs, requestId: string | number | null): Promise<string> {
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

  ensureDirs();
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const attempted = new Set<string>();
  // Explicit worker → single attempt; otherwise fail over across workers on quota errors.
  const maxAttempts = args.worker ? 1 : registry.workers.length;
  let lastError: Error | undefined;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isAborted(requestId)) {
        break;
      }
      let worker: WorkerProfile;
      try {
        worker = pickWorker(registry.workers, args.worker, attempted);
      } catch (err) {
        lastError = lastError ?? (err as Error);
        break;
      }
      attempted.add(worker.name);
      const model =
        args.model && (WORKER_MODELS as readonly string[]).includes(args.model) ? args.model : worker.model;
      // Billing guard: frontier models may bill per use rather than draw from
      // the subscription quota. The same model would be blocked on every
      // worker, so this aborts instead of failing over.
      if (isFrontierTier(model) && registry.frontierWorkerDispatch !== 'allow') {
        throw new Error(
          `Dispatch to ${model} is blocked: the operator has disabled frontier worker dispatches ` +
            '(billing guard — this model may bill per use instead of drawing from the subscription ' +
            'quota). Re-dispatch this task with model claude-opus-4-8 and ultrathink: true; do NOT ' +
            'retry with the frontier model. The operator can re-enable it via the ' +
            '"claudeCodeOrchestrator.frontierWorkerDispatch" setting in VS Code.',
        );
      }
      const base = { id, title, worker: worker.name, model, outputFile, cwd: process.cwd() };
      appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });
      // Claim the id before spawning: a cancellation landing in the window
      // between here and the spawn must still mark this task cancelled.
      trackTask(requestId, base);

      // The harness scans the user message for thinking keywords; for a
      // headless worker the dispatched prompt IS the user message, so
      // appending the keyword mechanically raises its reasoning budget.
      const workerPrompt = args.ultrathink ? `${prompt}\n\nultrathink` : prompt;

      try {
        const run = await runClaude(
          registry,
          worker.configDir,
          model,
          workerPrompt,
          args.system_prompt?.trim() || undefined,
          (child) => {
            registerChild(id, child);
            try {
              // A second 'running' event, carrying the pid: readers take the
              // latest event per task id, so this supersedes the one above and
              // makes the worker killable from outside this process. It is
              // spawned detached, so on POSIX its pid is also its group id and
              // an outside killer can take the whole tree. Windows has no POSIX
              // group: leave pgid unset so the extension falls back to taskkill /T.
              appendTaskEvent({
                ...base,
                ts: Date.now(),
                status: 'running',
                pid: child.pid,
                pgid: process.platform === 'win32' ? undefined : child.pid,
              });
            } catch {
              // the child is registered and killable — a log write must not fail the run
            }
          },
        );
        recordSuccess(worker.name, run);
        fs.writeFileSync(
          outputFile,
          `# ${title}\n\n- worker: ${worker.name}\n- model: ${model}${args.ultrathink ? '\n- ultrathink: true' : ''}\n- tokens: ${run.inputTokens} in / ${run.outputTokens} out` +
            (run.costUsd ? ` (~$${run.costUsd.toFixed(4)})` : '') +
            `\n\n---\n\n## Prompt\n\n${prompt}\n\n## Result\n\n${run.text}\n`,
        );
        appendTaskEvent({
          ...base,
          ts: Date.now(),
          status: 'done',
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
        });
        return `[worker: ${worker.name}, model: ${model}]\n\n${run.text}`;
      } catch (err) {
        if (isAborted(requestId)) {
          // We killed this child ourselves. A cancellation is not a quota error
          // and not a worker failure: no recordFailure (it would inflate the
          // error count and could cool the worker down), and no failover.
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        const quota = isQuotaError(message);
        recordFailure(worker.name, message, quota, registry.cooldownMinutes);
        lastError = err as Error;
        if (!quota) {
          // Real failures (bad CLI, login expired, crash) don't fail over — surface them.
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

    if (isAborted(requestId)) {
      // cancelRequest already killed the child and appended the terminal event.
      // No output file, no failure record — the caller gets no response either.
      throw new Error(CANCELLED_ERROR);
    }

    const message = lastError?.message ?? 'unknown error';
    const singleWorkerHint =
      registry.workers.length === 1 && isQuotaError(message)
        ? ' Only one worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another worker account.'
        : '';
    fs.writeFileSync(outputFile, `# ${title}\n\nFAILED: ${message}\n\n## Prompt\n\n${prompt}\n`);
    appendTaskEvent({
      id,
      title,
      worker: [...attempted].join(',') || (args.worker ?? '-'),
      model: args.model ?? '-',
      outputFile,
      cwd: process.cwd(),
      ts: Date.now(),
      status: 'error',
      error: message,
    });
    throw new Error(message + singleWorkerHint);
  } finally {
    taskBases.delete(id);
  }
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

/** Live usage older than this triggers a refresh, which spawns one claude probe per account. */
const USAGE_MAX_AGE_MS = 120_000;

/**
 * Refresh the usage cache when it holds nothing or its newest reading is stale.
 * Bounds spawns: repeated list_workers calls inside the window reuse the cache.
 * Never throws — a failed refresh just leaves the previous (or absent) readings.
 */
async function refreshUsageIfStale(): Promise<void> {
  try {
    const now = Date.now();
    const entries = Object.values(readUsageCache());
    const newest = entries.reduce(
      (max, u) => (typeof u?.fetchedAt === 'number' && u.fetchedAt > max ? u.fetchedAt : max),
      -Infinity,
    );
    // Fresh only when the newest reading sits in the recent past. A fetchedAt IN
    // THE FUTURE (clock skew, tampering, a reading from a fast-clock machine)
    // makes `now - newest` negative, and a missing/NaN newest leaves it at
    // -Infinity so `now - newest` is +Infinity — both fall outside this range
    // and count as stale, so a poisoned timestamp can no longer suppress the
    // refresh indefinitely in headless CLI-only mode.
    const age = now - newest;
    if (entries.length === 0 || !(age >= 0 && age <= USAGE_MAX_AGE_MS)) {
      // Short 5s per-probe timeout on this path: list_workers awaits the full
      // refresh, so one hung/misauthenticated account must not pin a whole
      // concurrency wave for the default 20s and block the tool call ~40s.
      await refreshAllUsage(undefined, 3, 5000);
    }
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
 * One live-usage line for an account. `available:false` with no error is a valid
 * state — a non-subscription login that simply has no plan limits — never a failure.
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
    return 'no plan limits (login is a token / non-subscription)';
  }
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const overage = overageSegment(usage.extraUsage);
  if (windows.length === 0) {
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
  const overageEnabled = overageDirs.some(
    (dir) => getCachedUsage(dir)?.extraUsage?.enabled === true,
  );
  const moneyFooter = overageEnabled
    ? "\n\nOverage billing is ENABLED on one or more accounts: dispatching past a plan window bills money against that account's monthly cap instead of being blocked. Prefer accounts with headroom, and treat a window near 100% as a spend risk, not just a wait."
    : '';
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
    if (s?.cooldownUntil && s.cooldownUntil > now) {
      line += ` — COOLING DOWN until ${new Date(s.cooldownUntil).toLocaleTimeString()} (quota error)`;
    } else {
      line += ' — available';
    }
    return `${line}\n  ${usageLine(w.configDir)}`;
  });
  return [mainBlock, workerBlocks.join('\n')].filter(Boolean).join('\n\n') + guard + moneyFooter;
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
      'Optional worker account name (see list_workers). Omit for automatic assignment with quota-aware failover.',
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
        } else if (name === 'orchestrator_briefing') {
          const model = ((args as { model?: string }).model ?? '').trim();
          if (!model) {
            throw new Error('orchestrator_briefing requires "model".');
          }
          recordOrchestrator(process.cwd(), model);
          text = orchestratorBriefing(model);
        } else if (name === 'list_workers') {
          text = await listWorkers();
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
    // workers orphan and burn quota for the full WORKER_TIMEOUT_MS.
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
