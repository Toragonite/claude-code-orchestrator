/**
 * The ARGUMENT contract of `dispatch_task` / `dispatch_tasks`, as code.
 *
 * One checker, used at every entry (the server's tool handlers, the detach supervisor reading
 * its spec, and each dispatch core), so that an argument is judged once, by one rule, before
 * anything runs — and so that nothing downstream ever calls a string method on a value that is
 * not a string. Checking is idempotent: the checked arguments pass the check unchanged.
 *
 * What is checked here is SHAPE and SIZE. Whether a model, a worker or a provider exists is
 * decided later by the code that owns those questions; a name that passes here can still be
 * refused there.
 *
 * Never throws. An error message names the field and what was expected; it never contains
 * prompt text, and it echoes at most 80 characters of any other value, flattened to one line.
 */

import { flattenOneLine, sliceOneLine } from '../displayText';

/** A task title is one line of at most this many UTF-16 units. Longer is CUT, not refused. */
export const DISPATCH_TITLE_MAX_CHARS = 200;
/** Largest `prompt`, in UTF-8 bytes. */
export const DISPATCH_PROMPT_MAX_BYTES = 1_048_576;
/** Largest `system_prompt`, in UTF-8 bytes. */
export const DISPATCH_SYSTEM_PROMPT_MAX_BYTES = 262_144;
/** Longest `model`, `worker` or `provider`, in UTF-16 units. */
export const DISPATCH_NAME_MAX_CHARS = 200;
/** Most tasks one `dispatch_tasks` call may carry. */
export const DISPATCH_BATCH_MAX_TASKS = 100;
/** What a task without a usable title is called. */
export const UNTITLED_TASK = 'untitled task';

const ECHO_MAX = 80;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** `dispatch_task` arguments after the check: every field has the type its name promises. */
export interface CheckedDispatchArgs {
  /** One line, 1–200 characters; `UNTITLED_TASK` when none was given. */
  title: string;
  /** Trimmed and non-empty; at most DISPATCH_PROMPT_MAX_BYTES; no NUL. */
  prompt: string;
  /** Trimmed, single-line and non-empty when present. */
  model?: string;
  worker?: string;
  provider?: string;
  /** Trimmed and non-empty when present; at most DISPATCH_SYSTEM_PROMPT_MAX_BYTES; no NUL. */
  system_prompt?: string;
  ultrathink: boolean;
  detach: boolean;
  /** As given (registry.clampTimeoutMinutes owns its meaning); absent when not given. */
  timeout_minutes?: number | string;
}

export type DispatchArgsCheck =
  | { ok: true; args: CheckedDispatchArgs }
  | { ok: false; error: string };

export type DispatchBatchCheck =
  | { ok: true; tasks: CheckedDispatchArgs[] }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function echo(value: string): string {
  return sliceOneLine(flattenOneLine(value), ECHO_MAX);
}

type Field<T> = { ok: true; value: T } | { ok: false; error: string };

/** An optional one-line name (model, worker, provider): absent, null and blank are "not given". */
function nameField(raw: Record<string, unknown>, key: string): Field<string | undefined> {
  const value = raw[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `invalid ${key} — expected a string, got ${kindOf(value)}` };
  }
  const text = value.trim();
  if (text === '') {
    return { ok: true, value: undefined };
  }
  if (text.length > DISPATCH_NAME_MAX_CHARS) {
    return {
      ok: false,
      error: `invalid ${key} — ${text.length} characters; the limit is ${DISPATCH_NAME_MAX_CHARS}`,
    };
  }
  if (CONTROL_CHARS.test(text)) {
    return { ok: false, error: `invalid ${key} — expected a single line of text, got "${echo(text)}"` };
  }
  return { ok: true, value: text };
}

/** Prompt-like text: a string under a byte limit with no NUL. Its content is never echoed. */
function textField(
  raw: Record<string, unknown>,
  key: string,
  maxBytes: number,
  required: boolean,
): Field<string | undefined> {
  const value = raw[key];
  if (value === undefined || value === null) {
    return required
      ? { ok: false, error: `invalid ${key} — expected a non-empty string` }
      : { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `invalid ${key} — expected a string, got ${kindOf(value)}` };
  }
  const text = value.trim();
  if (text === '') {
    return required
      ? { ok: false, error: `invalid ${key} — expected a non-empty string` }
      : { ok: true, value: undefined };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, error: `invalid ${key} — ${bytes} bytes; the limit is ${maxBytes}` };
  }
  if (text.includes('\u0000')) {
    return { ok: false, error: `invalid ${key} — must not contain NUL characters` };
  }
  return { ok: true, value: text };
}

/** A switch: only a real boolean is one. `"true"`, 1 and "yes" are refused, not ignored. */
function flagField(raw: Record<string, unknown>, key: string): Field<boolean> {
  const value = raw[key];
  if (value === undefined || value === null) {
    return { ok: true, value: false };
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: `invalid ${key} — expected true or false, got ${kindOf(value)}` };
  }
  return { ok: true, value };
}

/**
 * Check one task's arguments. `where` prefixes an error (`tasks[2]: …`) for a batch member.
 */
export function checkDispatchArgs(raw: unknown, where = ''): DispatchArgsCheck {
  const fail = (error: string): DispatchArgsCheck => ({
    ok: false,
    error: where === '' ? error : `${where}: ${error}`,
  });
  if (!isPlainObject(raw)) {
    return fail(`invalid arguments — expected an object, got ${kindOf(raw)}`);
  }

  const rawTitle = raw.title;
  if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== 'string') {
    return fail(`invalid title — expected a string, got ${kindOf(rawTitle)}`);
  }
  const title =
    sliceOneLine(flattenOneLine(rawTitle ?? ''), DISPATCH_TITLE_MAX_CHARS).trim() || UNTITLED_TASK;

  const prompt = textField(raw, 'prompt', DISPATCH_PROMPT_MAX_BYTES, true);
  if (!prompt.ok) {
    return fail(prompt.error);
  }
  const systemPrompt = textField(raw, 'system_prompt', DISPATCH_SYSTEM_PROMPT_MAX_BYTES, false);
  if (!systemPrompt.ok) {
    return fail(systemPrompt.error);
  }
  const model = nameField(raw, 'model');
  if (!model.ok) {
    return fail(model.error);
  }
  const worker = nameField(raw, 'worker');
  if (!worker.ok) {
    return fail(worker.error);
  }
  const provider = nameField(raw, 'provider');
  if (!provider.ok) {
    return fail(provider.error);
  }
  const ultrathink = flagField(raw, 'ultrathink');
  if (!ultrathink.ok) {
    return fail(ultrathink.error);
  }
  const detach = flagField(raw, 'detach');
  if (!detach.ok) {
    return fail(detach.error);
  }
  const timeout = raw.timeout_minutes;
  if (timeout !== undefined && timeout !== null && typeof timeout !== 'number' && typeof timeout !== 'string') {
    return fail(`invalid timeout_minutes — expected a number, got ${kindOf(timeout)}`);
  }

  const args: CheckedDispatchArgs = {
    title,
    prompt: prompt.value as string,
    ultrathink: ultrathink.value,
    detach: detach.value,
  };
  if (model.value !== undefined) {
    args.model = model.value;
  }
  if (worker.value !== undefined) {
    args.worker = worker.value;
  }
  if (provider.value !== undefined) {
    args.provider = provider.value;
  }
  if (systemPrompt.value !== undefined) {
    args.system_prompt = systemPrompt.value;
  }
  if (timeout !== undefined && timeout !== null) {
    args.timeout_minutes = timeout;
  }
  return { ok: true, args };
}

/**
 * Check the `tasks` argument of `dispatch_tasks`. ALL of it is checked before any task runs:
 * the first member that fails the check refuses the whole call, so a malformed batch has no
 * partial effect.
 */
export function checkDispatchBatch(raw: unknown): DispatchBatchCheck {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `invalid tasks — expected an array, got ${kindOf(raw)}` };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'invalid tasks — expected at least one task' };
  }
  if (raw.length > DISPATCH_BATCH_MAX_TASKS) {
    return {
      ok: false,
      error: `invalid tasks — ${raw.length} tasks; the limit is ${DISPATCH_BATCH_MAX_TASKS} per call`,
    };
  }
  const tasks: CheckedDispatchArgs[] = [];
  for (let i = 0; i < raw.length; i++) {
    const checked = checkDispatchArgs(raw[i], `tasks[${i}]`);
    if (!checked.ok) {
      return checked;
    }
    tasks.push(checked.args);
  }
  return { ok: true, tasks };
}
