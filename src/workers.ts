import Anthropic from '@anthropic-ai/sdk';
import { Account, AccountManager } from './accounts';
import { config, WorkerModel, WORKER_MODELS } from './models';

export interface WorkerResult {
  account: Account;
  model: WorkerModel;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Runs dispatched tasks on worker accounts. Workers run Opus/Sonnet with
 * adaptive thinking and streaming; selection is round-robin unless a task
 * names a specific account.
 */
export class WorkerPool {
  private rrIndex = 0;

  constructor(private readonly accounts: AccountManager) {}

  pick(preferredAccount?: string): Account {
    const workers = this.accounts.workers();
    if (workers.length === 0) {
      throw new Error('No worker accounts configured. Add at least one worker account.');
    }
    if (preferredAccount) {
      const found = workers.find((w) => w.name === preferredAccount || w.id === preferredAccount);
      if (found) {
        return found;
      }
    }
    const account = workers[this.rrIndex % workers.length];
    this.rrIndex++;
    return account;
  }

  resolveModel(account: Account, requested?: string): WorkerModel {
    if (requested && (WORKER_MODELS as readonly string[]).includes(requested)) {
      return requested as WorkerModel;
    }
    return account.model ?? config().defaultWorkerModel;
  }

  async run(
    account: Account,
    model: WorkerModel,
    prompt: string,
    onText?: (chunk: string) => void,
  ): Promise<WorkerResult> {
    const client = await this.accounts.client(account);
    const stream = client.messages.stream({
      model,
      max_tokens: config().maxOutputTokens,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    });
    if (onText) {
      stream.on('text', onText);
    }
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error(`Worker model ${model} refused the task.`);
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (message.stop_reason === 'max_tokens') {
      return {
        account,
        model,
        text: `${text}\n\n[warning: output truncated at max_tokens]`,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    }
    return {
      account,
      model,
      text,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}
