import { REPORTED_MODEL_ID } from './platform';
import { normalizeProviderModel, storedProvider, type ProviderId } from './providers';

/**
 * "What did this account's default model last run as?" — the ONE rule, shared by everything
 * that answers it: `list_workers` in the dispatch server, and the dashboard, the Worker
 * Accounts tree and the model pickers in the extension host. Two implementations of it
 * disagreed on a log the product itself writes (a cancel landing while a worker finishes),
 * and both gave an account the id that a removed account of ANOTHER CLI with the same name
 * had run. The rule lives here so that it cannot be written twice.
 *
 * Must not import 'vscode' or 'fs': both bundles load this.
 */

/**
 * What the rule needs to know of one task — every field taken from the task's FINAL event:
 * the last event of its id in the task log, in file order, among the events `isCountedTaskEvent`
 * admits. Nothing is taken from an earlier event of the task: a retry on a second account, a
 * cancel that lands after the work finished, a later line of any kind — the final event is
 * what the task came to.
 */
export interface FinalTaskFacts {
  status: unknown;
  worker: unknown;
  /** Absent on a Claude Code task. */
  provider?: unknown;
  /** The model that was asked for (`-` when none was). */
  model?: unknown;
  modelSource?: unknown;
  modelUsed?: unknown;
}

/** The account the question is asked about, as the registry has it. */
export interface RanAsAccount {
  name: string;
  provider: ProviderId;
  /** The stored default model; null or empty when none is stored (the CLI chooses). */
  defaultModel: string | null | undefined;
}

/**
 * Is `event` an event of a task at all? The same admission for every reader: an id of the task
 * id shape, one of the three statuses, and a time that is a real one. A line that fails this
 * does not exist — for any of them.
 */
export function isCountedTaskEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return false;
  }
  const e = event as { id?: unknown; status?: unknown; ts?: unknown };
  return (
    typeof e.id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(e.id) &&
    (e.status === 'running' || e.status === 'done' || e.status === 'error') &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    e.ts > 0 &&
    e.ts <= 8.64e15
  );
}

/**
 * The model id `task` shows that `account`'s default ran as — or undefined when this task says
 * nothing about it. All of:
 *
 *  1. the task ended `done` (its final event);
 *  2. that event carries a `modelUsed` of the reported-id shape (platform.REPORTED_MODEL_ID);
 *  3. it ran on this account: the same name AND the same CLI. An event without a `provider`
 *     is a Claude Code one; a `provider` this build does not know matches no account. The CLI
 *     is part of it because a name is reused — remove a Codex account, add a Cursor one under
 *     its name, and the name alone would hand the new account an id it never ran;
 *  4. it ran the DEFAULT:
 *      - the account stores one: the model the task asked for is that default, both read
 *        through `normalizeProviderModel` (so `OPUS`, ` opus ` and a v1.x tier id are the
 *        alias they mean). It does not matter whether the dispatch named it or left it to
 *        the account — either way this is what that model ran as there;
 *      - the account stores none: the task's `modelSource` is `cli` — the CLI chose.
 *
 * The caller asks this of tasks from the NEWEST final event backwards (file order) and takes
 * the first answer. Total over anything JSON.parse can return.
 */
export function ranAsOf(task: FinalTaskFacts, account: RanAsAccount): string | undefined {
  if (task.status !== 'done') {
    return undefined;
  }
  const used = task.modelUsed;
  if (typeof used !== 'string' || !REPORTED_MODEL_ID.test(used)) {
    return undefined;
  }
  if (task.worker !== account.name || storedProvider(task.provider) !== account.provider) {
    return undefined;
  }
  const stored = typeof account.defaultModel === 'string' ? account.defaultModel.trim() : '';
  if (stored === '') {
    return task.modelSource === 'cli' ? used : undefined;
  }
  const wanted = normalizeProviderModel(account.provider, stored);
  const asked = typeof task.model === 'string' ? normalizeProviderModel(account.provider, task.model) : undefined;
  return wanted !== undefined && asked === wanted ? used : undefined;
}
