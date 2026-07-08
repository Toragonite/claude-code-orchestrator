import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import {
  appendTaskEvent,
  clampTimeoutMinutes,
  emptyStats,
  ensureDirs,
  readRegistry,
  readStats,
  recordOrchestrator,
  Registry,
  runningCounts,
  touchOrchestrator,
  TASKS_DIR,
  WORKER_MODELS,
  WorkerProfile,
  writeStats,
} from '../registry';
import { isFrontierTier, orchestratorBriefing, WORKER_BASE_PROMPT } from '../prompts';

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

const SERVER_INFO = { name: 'cco-dispatch', version: '0.4.0' };
/** How long a timed-out worker gets to honor SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 10_000;
/**
 * After 'exit' fires, how long we wait for 'close' before settling anyway.
 * 'exit' means the process is dead; any stdout still buffered in flight is
 * delivered within a few milliseconds because nothing more can be written.
 * If a grandchild inherited the stdout pipe, 'close' never fires — this drain
 * is what turns that hang into a settle.
 */
const DRAIN_GRACE_MS = 250;
/**
 * Last-resort settle on the timeout path: even 'exit' can be delayed if the
 * child is wedged uninterruptibly. Armed after SIGKILL; if it fires we settle
 * regardless of process state, so a dispatch is always guaranteed to return.
 */
const REAP_GRACE_MS = 5_000;
/** Per-stream cap on the partial output attached to a timeout error. */
const TIMEOUT_TAIL_CHARS = 2000;

let rrIndex = 0;

interface DispatchArgs {
  title?: string;
  prompt?: string;
  model?: string;
  worker?: string;
  system_prompt?: string;
  /** Escalate the worker to maximum reasoning depth via the thinking keyword. */
  ultrathink?: boolean;
  /** Per-task wall-clock limit; falls back to registry.workerTimeoutMinutes. */
  timeout_minutes?: number;
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

/**
 * A run that hit its wall-clock limit. Carried as a distinct type because a
 * timeout message embeds the worker's own stdout, which may itself talk about
 * quotas or contain the digits 429/529 — classifying it by regex would put a
 * healthy worker on a cooldown and fail the task over to another one, which
 * would then burn the same wall clock on the same too-large task.
 */
class WorkerTimeoutError extends Error {}

/**
 * Signal a child, tolerating one that has already exited (kill() on a reaped
 * pid can throw). Deliberately not guarded on `child.killed`: that flag is set
 * by the SIGTERM we just sent, so it would suppress the SIGKILL escalation.
 * On Windows every signal maps to TerminateProcess, so the escalation is a
 * harmless no-op there.
 */
function killWorker(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function streamSection(label: string, text: string): string {
  if (!text) {
    return `--- ${label} was empty ---`;
  }
  return text.length > TIMEOUT_TAIL_CHARS
    ? `--- last ${TIMEOUT_TAIL_CHARS} chars of ${label} ---\n${text.slice(-TIMEOUT_TAIL_CHARS)}`
    : `--- ${label} (${text.length} chars) ---\n${text}`;
}

/**
 * The leading prose is deliberately longer than 300 characters and carries no
 * captured output: recordFailure() slices lastError to 300 chars for the tree
 * view and dashboard, and that slice has to be the human-readable part.
 */
function timeoutMessage(minutes: number, stdout: string, stderr: string): string {
  const header =
    `Worker timed out after ${minutes} minutes and was terminated. ` +
    'Whatever it had not yet written to disk is gone, but it may already have written files to ' +
    'the workspace, so inspect the working tree before re-dispatching. If the task legitimately ' +
    'needs longer, re-dispatch it with a larger timeout_minutes. Captured before the kill: ' +
    `${stdout.length} chars of stdout, ${stderr.length} chars of stderr.`;
  if (!stdout && !stderr) {
    return `${header}\n\nThe worker wrote nothing to stdout or stderr before it was terminated.`;
  }
  return `${header}\n\n${streamSection('stdout', stdout)}\n${streamSection('stderr', stderr)}`;
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
  timeoutMinutes: number,
  systemPrompt?: string,
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
    const child = spawn(registry.claudePath, args, {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      shell: useShell,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Exit status captured by the 'exit' handler. The drain and reap timers
    // settle after 'exit' has fired (or, for reap, may fire before it), so they
    // rely on this rather than the 'close' event's code — 'close' may never come.
    let exitCode: number | null = null;
    // All timers are cleared by finish(); declared before it so the closure can
    // reach them. clearTimeout(undefined) is a legal no-op, so unarmed ones are
    // safe to clear.
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    // Single settle gate. Every resolve()/reject() in this Promise passes
    // through finish, so the Promise settles exactly once: the first caller
    // wins and every later one (a drain timer firing after 'close', a reap
    // timer firing after 'exit', etc.) is a guarded no-op. This is the guard
    // that makes double-settle impossible.
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      clearTimeout(drainTimer);
      fn();
    };

    interface CliResult {
      result?: string;
      is_error?: boolean;
      subtype?: string;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
    }

    // The one place resolution/rejection is built, shared verbatim by the
    // 'close' handler and the drain/reap timers so the two paths can never
    // diverge. `forced` is true when 'close' did NOT fire (drain- or reap-timer
    // path): the stdio streams are still open, so we destroy them and unref the
    // child, otherwise a grandchild-held pipe keeps the Node event loop — and
    // thus the MCP server — alive after we have already settled.
    const settle = (code: number | null, forced: boolean): void => {
      finish(() => {
        if (forced) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          child.unref();
        }
        if (timedOut) {
          // Before the exit-code check: a SIGKILLed child reports code null,
          // so a killed worker must produce the timeout message, not
          // "exited with code null".
          reject(new WorkerTimeoutError(timeoutMessage(timeoutMinutes, stdout, stderr)));
          return;
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
    };

    // The timeout never settles the Promise directly: it kills the child and
    // lets 'close' / 'exit' build the rejection so the stdout accumulated up to
    // the kill reaches the error message. Timeout path bound: fire at N min →
    // SIGTERM → (10 s KILL_GRACE) SIGKILL → (5 s REAP_GRACE) forced settle, so
    // a timed-out dispatch returns at most 15 s after its deadline.
    timer = setTimeout(
      () => {
        timedOut = true;
        killWorker(child, 'SIGTERM');
        // A CLI that ignores or is slow to handle SIGTERM would otherwise
        // survive as an orphan while this server has moved on.
        killTimer = setTimeout(() => {
          killWorker(child, 'SIGKILL');
          // Last-resort guarantee: if neither 'close' nor 'exit' settles us
          // (e.g. the child is wedged uninterruptibly), force the timeout
          // rejection so the dispatch always returns.
          reapTimer = setTimeout(() => settle(exitCode, true), REAP_GRACE_MS);
        }, KILL_GRACE_MS);
      },
      // clamped upstream, so always inside setTimeout's 32-bit delay range
      timeoutMinutes * 60_000,
    );

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      finish(() => reject(new Error(`Failed to start "${registry.claudePath}": ${err.message}`)));
    });
    // 'exit' fires when the process itself dies, regardless of who still holds
    // its stdio pipes. It is the event that actually tells us the worker is
    // gone. 'close' is preferred (below) because it guarantees stdout is
    // complete, but a grandchild that inherited the stdout pipe can hold it
    // open forever, so 'close' may never arrive. Arm a short drain: if 'close'
    // beats it, finish's guard makes this a no-op; if not, we settle with
    // whatever stdout accumulated.
    child.on('exit', (code) => {
      exitCode = code;
      drainTimer = setTimeout(() => settle(exitCode, true), DRAIN_GRACE_MS);
    });
    // Preferred settle path: every stdio stream has reached EOF, so stdout is
    // complete and the normal (non-timeout) JSON parse sees the whole result.
    child.on('close', (code) => settle(code, false));
    // Prompt goes over stdin to avoid shell-quoting issues.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function dispatchTask(args: DispatchArgs): Promise<string> {
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
  // Explicit worker → single attempt; otherwise fail over across workers on quota errors.
  const maxAttempts = args.worker ? 1 : registry.workers.length;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        timeoutMinutes,
        args.system_prompt?.trim() || undefined,
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
      const message = err instanceof Error ? err.message : String(err);
      // A timeout is never a quota error, whatever its embedded partial output says.
      const quota = !(err instanceof WorkerTimeoutError) && isQuotaError(message);
      recordFailure(worker.name, message, quota, registry.cooldownMinutes);
      lastError = err as Error;
      if (!quota) {
        // Real failures (bad CLI, login expired, crash, timeout) don't fail over — surface them.
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

  const message = lastError?.message ?? 'unknown error';
  const singleWorkerHint =
    registry.workers.length === 1 && !(lastError instanceof WorkerTimeoutError) && isQuotaError(message)
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
}

async function dispatchTasksParallel(args: BatchArgs): Promise<string> {
  const tasks = args.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('dispatch_tasks requires a non-empty "tasks" array.');
  }
  const results = await Promise.allSettled(tasks.map((t) => dispatchTask(t)));
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

function listWorkers(): string {
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    return 'No worker accounts registered.';
  }
  const stats = readStats();
  const now = Date.now();
  const guard =
    registry.frontierWorkerDispatch !== 'allow'
      ? '\n\nFrontier worker dispatch (claude-fable-5) is DISABLED by the operator (billing guard) — ' +
        'for design consults and adversarial reviews use claude-opus-4-8 with ultrathink: true instead.'
      : '';
  return registry.workers
    .map((w) => {
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
      return line;
    })
    .join('\n') + guard;
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
  timeout_minutes: {
    type: 'number',
    description:
      "Optional per-task wall-clock limit in minutes (1–480). Defaults to the operator's " +
      'workerTimeoutMinutes setting (45). Raise it for long implementation or adversarial-review ' +
      'dispatches; a worker killed by this limit loses whatever it had not yet written to disk.',
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
      '(tasks, tokens, cost) and availability (cooldowns after quota errors). Check this before ' +
      'large fan-outs to pick models/workers deliberately.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type JsonRpcId = string | number | null;

/** In-flight tools/call count — lets us drain before exiting on stdin close. */
let pending = 0;
let stdinClosed = false;

function maybeExit(): void {
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
  // Notifications (no id) need no response.
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
      pending++;
      try {
        let text: string;
        if (name === 'dispatch_task') {
          text = await dispatchTask(args);
        } else if (name === 'dispatch_tasks') {
          text = await dispatchTasksParallel(args);
        } else if (name === 'orchestrator_briefing') {
          const model = ((args as { model?: string }).model ?? '').trim();
          if (!model) {
            throw new Error('orchestrator_briefing requires "model".');
          }
          recordOrchestrator(process.cwd(), model);
          text = orchestratorBriefing(model);
        } else if (name === 'list_workers') {
          text = listWorkers();
        } else {
          sendError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        });
      } finally {
        pending--;
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
    stdinClosed = true;
    maybeExit();
  });
}

main();
