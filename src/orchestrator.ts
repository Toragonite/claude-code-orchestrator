import Anthropic from '@anthropic-ai/sdk';
import { AccountManager } from './accounts';
import { WorkerPool } from './workers';
import { TaskRegistry } from './tasks';
import { config, REFUSAL_FALLBACK_MODEL, SERVER_SIDE_FALLBACK_BETA, WORKER_MODELS } from './models';
import { CLAUDE_CODE_IDENTITY, OAUTH_BETA } from './oauth';

const DISPATCH_TOOL_NAME = 'dispatch_task';

const MAX_ROUNDS = 25;

export interface OrchestratorEvents {
  onText: (chunk: string) => void;
  onStatus: (line: string) => void;
}

function dispatchTool(workerNames: string[]): Anthropic.Beta.BetaTool {
  return {
    name: DISPATCH_TOOL_NAME,
    description:
      'Dispatch a self-contained task to a worker account running Claude Opus or Claude Sonnet. ' +
      'Call this when a subtask is independent and can be described completely in a single prompt — ' +
      'research on a distinct topic, drafting a section, generating code for a well-specified module, ' +
      'or reviewing an artifact. You may call this tool multiple times in one turn to fan out work in ' +
      'parallel. Do the integration, judgment, and final synthesis yourself; dispatch the legwork. ' +
      'The worker has no access to this conversation, so the prompt must contain all necessary context.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short human-readable label for the subtask (shown in the task list).',
        },
        prompt: {
          type: 'string',
          description:
            'The complete, self-contained prompt for the worker, including all context it needs.',
        },
        model: {
          type: 'string',
          enum: [...WORKER_MODELS],
          description:
            'Worker model. Use claude-opus-4-8 for hard reasoning/coding subtasks, claude-sonnet-5 for high-volume or simpler subtasks.',
        },
        account: {
          type: 'string',
          enum: workerNames.length > 0 ? workerNames : undefined,
          description: 'Optional: a specific worker account to run this on. Omit for automatic assignment.',
        },
      },
      required: ['title', 'prompt', 'model'],
    },
  };
}

function systemBlocks(
  workerSummary: string,
  oauth: boolean,
): Anthropic.Beta.BetaTextBlockParam[] {
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  if (oauth) {
    // Subscription OAuth tokens require this exact identity as the first block.
    blocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY });
  }
  blocks.push({ type: 'text', text: orchestratorPrompt(workerSummary) });
  return blocks;
}

function orchestratorPrompt(workerSummary: string): string {
  return [
    'You are the orchestrator in a multi-account setup inside a VS Code extension.',
    'You run on the main account. One or more worker accounts run Claude Opus / Claude Sonnet, and you can',
    `delegate to them with the ${DISPATCH_TOOL_NAME} tool. Available workers:\n${workerSummary}`,
    '',
    'Guidelines:',
    '- Answer simple requests directly; do not dispatch for work you can finish faster yourself.',
    '- For larger requests, break the work into independent, self-contained subtasks and dispatch them',
    '  in parallel (multiple tool calls in one turn), then integrate the results into one coherent answer.',
    '- Workers see only the prompt you send — include every piece of context they need.',
    '- After results return, verify them against the user request before presenting the final answer.',
  ].join('\n');
}

interface DispatchInput {
  title: string;
  prompt: string;
  model?: string;
  account?: string;
}

/**
 * The Fable 5 agentic loop: stream the orchestrator's response; when it calls
 * dispatch_task, fan the calls out to worker accounts in parallel, return all
 * tool_results in a single user message, and continue until end_turn.
 */
export async function runOrchestratedTask(
  userRequest: string,
  accounts: AccountManager,
  pool: WorkerPool,
  tasks: TaskRegistry,
  events: OrchestratorEvents,
): Promise<void> {
  const main = accounts.main();
  if (!main) {
    throw new Error('No main (Fable) account configured. Add a main account first.');
  }
  const cfg = config();

  const workers = accounts.workers();
  const workerSummary =
    workers.length > 0
      ? workers.map((w) => `- ${w.name} (default model: ${w.model ?? cfg.defaultWorkerModel})`).join('\n')
      : '- (none configured — answer everything yourself)';
  const tools = workers.length > 0 ? [dispatchTool(workers.map((w) => w.name))] : [];

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userRequest }];

  // OAuth bearer tokens need the oauth beta on every request; pass it in the
  // betas param too so it survives the SDK's beta-header computation.
  const isOAuth = main.auth === 'oauth';
  const betas: string[] = [];
  if (isOAuth) {
    betas.push(OAUTH_BETA);
  }
  if (cfg.enableRefusalFallback) {
    betas.push(SERVER_SIDE_FALLBACK_BETA);
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // A fresh client per round keeps the OAuth access token current across
    // long orchestrations (AccountManager refreshes near expiry).
    const client = await accounts.client(main);
    // Fable 5: thinking is always on — omit the `thinking` param entirely.
    // Opt into server-side refusal fallbacks so a benign false positive is
    // transparently re-served by Opus 4.8 in the same call.
    const stream = client.beta.messages.stream({
      model: cfg.mainModel,
      max_tokens: cfg.maxOutputTokens,
      ...(betas.length > 0 ? { betas } : {}),
      ...(cfg.enableRefusalFallback ? { fallbacks: [{ model: REFUSAL_FALLBACK_MODEL }] } : {}),
      system: systemBlocks(workerSummary, isOAuth),
      tools,
      messages,
    });
    stream.on('text', events.onText);
    const response = await stream.finalMessage();

    const fallbackRan = (response.usage.iterations ?? []).some(
      (entry: { type?: string }) => entry.type === 'fallback_message',
    );
    if (fallbackRan && response.stop_reason !== 'refusal') {
      events.onStatus(`(request was re-served by fallback model ${response.model})`);
    }
    if (response.stop_reason === 'refusal') {
      const detail = response.stop_details?.explanation ?? 'no explanation provided';
      throw new Error(`The orchestrator declined this request (refusal: ${detail}).`);
    }

    // Echo full content (including thinking blocks) back exactly as received.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') {
      continue;
    }
    if (response.stop_reason !== 'tool_use') {
      return; // end_turn — done
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === DISPATCH_TOOL_NAME,
    );

    // Fan out all dispatches in parallel; return every tool_result in ONE user message.
    const results = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const input = tu.input as unknown as DispatchInput;
        let record;
        try {
          const account = pool.pick(input.account);
          const model = pool.resolveModel(account, input.model);
          record = tasks.create('dispatch', input.title, account.name, model);
          events.onStatus(`→ dispatched "${input.title}" to ${account.name} (${model})`);
          const result = await pool.run(account, model, input.prompt, (chunk) =>
            tasks.append(record!.id, chunk),
          );
          tasks.finish(record.id, 'done');
          events.onStatus(
            `✓ "${input.title}" finished on ${account.name} ` +
              `(${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)`,
          );
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `[worker: ${account.name}, model: ${model}]\n\n${result.text}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (record) {
            tasks.finish(record.id, 'error', message);
          }
          events.onStatus(`✗ "${input.title}" failed: ${message}`);
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Error: ${message}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: 'user', content: results });
  }
  throw new Error(`Orchestration exceeded ${MAX_ROUNDS} rounds without finishing.`);
}
