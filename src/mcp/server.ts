import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import {
  appendTaskEvent,
  emptyStats,
  ensureDirs,
  readRegistry,
  readStats,
  Registry,
  TASKS_DIR,
  WORKER_MODELS,
  WorkerProfile,
  writeStats,
} from '../registry';

/**
 * fable-dispatch — a minimal MCP stdio server the Claude Code panel connects
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

const SERVER_INFO = { name: 'fable-dispatch', version: '0.3.0' };
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

let rrIndex = 0;

interface DispatchArgs {
  title?: string;
  prompt?: string;
  model?: string;
  worker?: string;
  system_prompt?: string;
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
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let args = ['-p', '--output-format', 'json', '--model', model, '--permission-mode', registry.permissionMode];
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }
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
    const timer = setTimeout(() => {
      child.kill();
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

async function dispatchTask(args: DispatchArgs): Promise<string> {
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    throw new Error(
      'No worker accounts registered. In VS Code, run "Fable Orchestrator: Add Worker Account".',
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
    const base = { id, title, worker: worker.name, model, outputFile };
    appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });

    try {
      const run = await runClaude(registry, worker.configDir, model, prompt, args.system_prompt?.trim() || undefined);
      recordSuccess(worker.name, run);
      fs.writeFileSync(
        outputFile,
        `# ${title}\n\n- worker: ${worker.name}\n- model: ${model}\n- tokens: ${run.inputTokens} in / ${run.outputTokens} out` +
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
  return registry.workers
    .map((w) => {
      const s = stats[w.name];
      let line = `- ${w.name}: default model ${w.model}`;
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
    .join('\n');
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
      "claude-opus-4-8 for hard reasoning/coding subtasks; claude-sonnet-5 for simpler or high-volume ones. Defaults to the worker's configured model.",
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
      pending++;
      try {
        let text: string;
        if (name === 'dispatch_task') {
          text = await dispatchTask(args);
        } else if (name === 'dispatch_tasks') {
          text = await dispatchTasksParallel(args);
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
