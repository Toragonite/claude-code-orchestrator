import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import {
  appendTaskEvent,
  ensureDirs,
  readRegistry,
  TASKS_DIR,
  WORKER_MODELS,
  WorkerProfile,
} from '../registry';

/**
 * fable-dispatch — a minimal MCP stdio server the Claude Code panel connects
 * to. It exposes dispatch_task/list_workers so the main session (e.g. Fable 5)
 * can fan work out to other Claude accounts. Each worker is a Claude Code run
 * under that account's CLAUDE_CONFIG_DIR, in the same workspace cwd.
 *
 * The wire protocol is newline-delimited JSON-RPC (MCP stdio transport),
 * implemented directly to keep the server dependency-free.
 */

const SERVER_INFO = { name: 'fable-dispatch', version: '0.2.0' };
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

let rrIndex = 0;

interface DispatchArgs {
  title?: string;
  prompt?: string;
  model?: string;
  worker?: string;
}

function pickWorker(workers: WorkerProfile[], preferred?: string): WorkerProfile {
  if (preferred) {
    const found = workers.find((w) => w.name === preferred);
    if (found) {
      return found;
    }
  }
  const worker = workers[rrIndex % workers.length];
  rrIndex++;
  return worker;
}

function runClaude(
  claudePath: string,
  configDir: string,
  model: string,
  permissionMode: string,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      claudePath,
      ['-p', '--output-format', 'json', '--model', model, '--permission-mode', permissionMode],
      {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        shell: process.platform === 'win32',
      },
    );
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
      reject(new Error(`Failed to start "${claudePath}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}: ${stderr || stdout}`.slice(0, 2000)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean; subtype?: string };
        if (parsed.is_error) {
          reject(new Error(`Worker reported an error (${parsed.subtype ?? 'unknown'}): ${parsed.result ?? ''}`));
          return;
        }
        resolve(parsed.result ?? stdout);
      } catch {
        resolve(stdout.trim());
      }
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
  const worker = pickWorker(registry.workers, args.worker);
  const model =
    args.model && (WORKER_MODELS as readonly string[]).includes(args.model)
      ? args.model
      : worker.model;

  ensureDirs();
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const base = { id, title, worker: worker.name, model, outputFile };
  appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });

  try {
    const result = await runClaude(
      registry.claudePath,
      worker.configDir,
      model,
      registry.permissionMode,
      prompt,
    );
    fs.writeFileSync(
      outputFile,
      `# ${title}\n\n- worker: ${worker.name}\n- model: ${model}\n\n---\n\n## Prompt\n\n${prompt}\n\n## Result\n\n${result}\n`,
    );
    appendTaskEvent({ ...base, ts: Date.now(), status: 'done' });
    return `[worker: ${worker.name}, model: ${model}]\n\n${result}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(outputFile, `# ${title}\n\nFAILED: ${message}\n\n## Prompt\n\n${prompt}\n`);
    appendTaskEvent({ ...base, ts: Date.now(), status: 'error', error: message });
    throw err;
  }
}

function listWorkers(): string {
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    return 'No worker accounts registered.';
  }
  return registry.workers
    .map((w) => `- ${w.name}: default model ${w.model} (config: ${w.configDir})`)
    .join('\n');
}

const TOOLS = [
  {
    name: 'dispatch_task',
    description:
      'Dispatch a self-contained task to a worker Claude account running Claude Opus or Claude Sonnet ' +
      'in this same workspace. Use it to fan out independent subtasks in parallel (call it multiple ' +
      'times in one turn): research on a distinct topic, drafting a section, implementing or reviewing ' +
      'a well-specified module. The worker is a full Claude Code session with file and shell access to ' +
      'this workspace, but it does NOT see this conversation — the prompt must be complete and ' +
      'self-contained. Do the integration, judgment, and final synthesis yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the task list UI.' },
        prompt: {
          type: 'string',
          description: 'Complete, self-contained instructions for the worker, with all needed context.',
        },
        model: {
          type: 'string',
          enum: [...WORKER_MODELS],
          description:
            'claude-opus-4-8 for hard reasoning/coding subtasks; claude-sonnet-5 for simpler or high-volume ones. Defaults to the worker\'s configured model.',
        },
        worker: {
          type: 'string',
          description: 'Optional worker account name (see list_workers). Omit for automatic assignment.',
        },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'list_workers',
    description: 'List the registered worker Claude accounts and their default models.',
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
      const args = (params?.arguments ?? {}) as DispatchArgs;
      pending++;
      try {
        let text: string;
        if (name === 'dispatch_task') {
          text = await dispatchTask(args);
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
