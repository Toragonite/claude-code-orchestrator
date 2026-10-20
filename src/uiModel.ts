import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from './displayText';
import {
  DEFAULT_WORKER_MODEL,
  MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
  REPORTED_MODEL_ID,
  WORKER_MODELS,
  WORKER_PERMISSION_MODES,
  claudeEnv,
  hostConfigDir,
  isAcceptableClaudePath,
  isFrontierModel,
  normalizeModel,
  normalizePermissionMode,
  parseClaudeVersion,
  sameConfigDir,
} from './platform';
import {
  allProviders,
  normalizeProviderModel,
  normalizeProviderPermissionMode,
  parseProvider,
  providerInfo,
  storedProvider,
  type ProviderId,
} from './providers';
import { isCountedTaskEvent, ranAsOf, type FinalTaskFacts, type RanAsAccount } from './ranAs';
import {
  ORCHESTRATORS_FILE,
  REGISTRY_FILE,
  STATS_FILE,
  TASKS_LOG_FILE,
  clampTimeoutMinutes,
  readOrchestrators,
  readRegistryChecked,
  readStats,
  resolveTaskFile,
  sanitizeMeshHistoryLimit,
  sanitizeMeshMaxLive,
  workerProvider,
  type UnsupportedWorkerEntry,
} from './registry';
import { statFileSafe } from './safeFs';
import {
  PROVIDER_CLI_NOT_FOUND,
  USAGE_CACHE_FILE,
  freshProviderModels,
  accountKeyOf,
  isLoginCheckInFlight,
  isLoginExpiredFor,
  isLoginSuspectFor,
  loginStateOf,
  isProviderCliMissing,
  parseAuth,
  planLabelOf,
  readUsageCache,
  runLoginFailureAt,
  type AccountUsage,
} from './usage';
import type {
  AccountKey,
  DashboardModel,
  LoginState,
  UiAccount,
  UiLoginCheck,
  UiDailyBucket,
  UiDispatchMode,
  UiGuardSetting,
  UiHealth,
  UiOrchestrator,
  UiProvider,
  UiSession,
  UiSessionSource,
  UiSessionStatus,
  UiSettingKey,
  UiSettings,
  UiTask,
  UiTaskStatus,
  UiTokenStats,
  UiUnsupportedAccount,
  UiUsageWindow,
} from './uiTypes';
import { RUN_LOGIN_FAILURE_DETAIL } from './uiTypes';

/**
 * uiModel — the host-side DATA LAYER of the UI: one cached, validated, display-safe model for
 * the dashboard, the index of the task log that every tree view shares with it, and the three
 * resolvers that turn what a webview posts back (an account key, a task id, a setting) into
 * something the host may act on.
 *
 * Why it exists. Through v1.x every UI surface re-read and re-parsed whole files on the
 * extension host (the task log `2 + 2W` times per 2-second tick), handed loosely typed values
 * to a page that wrote them with `innerHTML`, and trusted a file path the page posted back.
 * This module replaces all three habits:
 *
 *  - ONE PARSE PER CHANGE. Every small file is cached under the `(size, mtimeMs)` pair of
 *    `statFileSafe`; the task log is read once and afterwards only where it GREW (see "The
 *    task index"). A build with nothing changed performs `stat` calls and nothing else.
 *  - PROJECTION, NEVER PASS-THROUGH. Nothing read from disk reaches the model except through
 *    a field-by-field projection: strings through `flattenOneLine` + `sliceOneLine` at the cap
 *    `uiTypes.ts` documents, numbers finite-checked, secrets (`ioToken`, `detachIoToken`) and
 *    addressable values (paths, config dirs, e-mail) never copied at all. A field added to a
 *    source file tomorrow is invisible here until someone names it.
 *  - THE PAGE NAMES THINGS BY OPAQUE KEY. `resolveAccount`, `resolveTaskOutput` and
 *    `validateSetting` are the trust boundary: a key, id or value that does not match exactly
 *    resolves to nothing, and nothing here coerces a near-miss into a hit.
 *
 * Total by construction: no export throws on any file content or argument. Must not import
 * `vscode` (the Team tree view and headless tests share it).
 */

/* ------------------------------------------------------------------------- *
 * Value helpers — the three rules of uiTypes.ts, in one place
 * ------------------------------------------------------------------------- */

/** Largest epoch-ms a `Date` can hold; a timestamp past it renders as "Invalid Date". */
const MAX_EPOCH_MS = 8.64e15;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An OWN property, or undefined. Used wherever the key itself comes from a file or from the
 * page (a worker name, a config dir, a workspace path): a plain `obj[key]` answers
 * `Object.prototype.constructor` for a worker somebody named "constructor".
 */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** How much longer than its result a source string must be before the result is copied out. */
const DETACH_SLACK = 256;

/**
 * One value → display-safe text of at most `max` UTF-16 units, or `''` when there is none.
 *
 * Only a STRING is text. `flattenOneLine` would happily render `null` as "null" and an object
 * as "[object Object]", and a title that reads "[object Object]" is a lie about the source
 * file; a field of the wrong type is absent, and each caller decides what absent reads as.
 *
 * The input is cut to a window BEFORE flattening because the flattener is several regex
 * passes over the whole value and the source is a file a dispatched worker can append to: a
 * 60 MiB "title" must cost what a title costs. A cut through a surrogate pair is harmless —
 * the flattener deletes the orphan. The trailing trim keeps the result a fixed point of
 * `flattenOneLine` (a cut can land right after a space).
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export function displayString(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw === '') {
    return '';
  }
  const window = Math.max(4096, max * 16);
  const bounded = raw.length > window ? raw.slice(0, window) : raw;
  const shown = sliceOneLine(flattenOneLine(bounded), max).trimEnd();
  // A substring of a long string can be a VIEW that keeps the whole original alive. These
  // values sit in a cache for the life of the editor, so a short piece cut from a long
  // source (a 240-char label from a 50 KB error text) is copied out and the source let go.
  return raw.length > shown.length + DETACH_SLACK ? Buffer.from(shown, 'utf16le').toString('utf16le') : shown;
}

/** `displayString`, with `null` for "no visible text" — the optional-field spelling. */
function displayOrNull(raw: unknown, max: number): string | null {
  const text = displayString(raw, max);
  return text === '' ? null : text;
}

/**
 * A value with the SHAPE of an epoch-milliseconds timestamp, or null: positive and inside the
 * range a `Date` can hold, so `new Date(ts)` can never be invalid. That is all it says. A
 * value centuries ahead passes, so this alone keeps nothing from the top of a list or out of
 * a time window — whether a recorded value is a time something happened at is `recordedTime`.
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export function epochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_EPOCH_MS
    ? value
    : null;
}

/** How far past the reader's clock a recorded timestamp may lie and still be taken as a time. */
const CLOCK_SLACK_MS = 5 * 60_000;

/**
 * A timestamp out of a file as the TIME something happened, or null when it is not one.
 *
 * Nothing that was recorded happened later than it is read. A value more than five minutes
 * past `now` — clocks of one machine, before and after a correction, differ by less — is
 * therefore not a late time but no time at all: whatever a writer put in the field. It is
 * read as NO TIME rather than moved to some other instant, because any instant chosen for it
 * (the reader's own clock, most of all) would be the newest one there is, and the value
 * would then head every newest-first list and sit inside every "last N hours" sum each time
 * the file is read again.
 *
 * THE ONE RULE for every timestamp this layer orders by, sums over or prints an age from:
 *
 *  - the task index (`now` is the clock of the read that parsed the event): a task whose
 *    latest event has no time is still a task — its status counts, it can be opened and
 *    cancelled — but it is listed after every task that has one (so past the newest
 *    TASK_LIST_MAX it is among the tasks a list only counts), is in no 5-hour / 7-day sum and
 *    no daily bucket, and shows no time;
 *  - team.ts, for the start and update times of sessions and the order of ledger records;
 *  - views.agoText, which prints no age for one.
 *
 * A value that does not even have the shape of a timestamp (`epochMs`) is no time either.
 *
 * Shared with team.ts and views.ts (same owner); not part of the §6.1 surface.
 */
export function recordedTime(value: unknown, now: number): number | null {
  const at = epochMs(value);
  return at === null || at > now + CLOCK_SLACK_MS ? null : at;
}

/**
 * A token count or a cost: finite, non-negative and at most MAX_SAFE_INTEGER, else null.
 *
 * The upper bound is what keeps SUMS finite. `1e308 + 1e308` is `Infinity`, and one such
 * line in the task log would otherwise put a non-finite number in the model; with every
 * addend bounded here, no log the read cap admits can overflow a total.
 */
function amount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function clampPercent(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

/** Case-fold for path comparison where the filesystem itself is case-insensitive by rule. */
function foldPath(p: string): string {
  // win32 only: VS Code reports a workspace as `c:\…` while Node's `process.cwd()` in the
  // dispatch server reports `C:\…`, so an exact comparison scopes every task out of its own
  // workspace there. macOS is left exact — its paths arrive with consistent case.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Is `child` the directory `root` or something inside it? A PATH-BOUNDARY test on two
 * already-resolved absolute paths: `/a/proj-2` is not inside `/a/proj`, which a bare
 * `startsWith(root)` gets wrong, and `path.sep` rather than `'/'` so it holds on win32.
 * `strict` excludes `root` itself.
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export function pathWithin(child: string, root: string, strict = false): boolean {
  const c = foldPath(child);
  const r = foldPath(root);
  if (c === r) {
    return !strict;
  }
  // A filesystem root already ends in the separator; doubling it would match nothing.
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** A caller-supplied path as an absolute, resolved path — or undefined when it is not one. */
function absolutePath(raw: unknown): string | undefined {
  // Relative values are refused, not resolved: `path.resolve('.')` is the extension host's
  // own working directory, and a log line saying `cwd: "."` must not scope itself into
  // whatever folder that happens to be.
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096 || raw.includes('\u0000')) {
    return undefined;
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : undefined;
}

/* ------------------------------------------------------------------------- *
 * Stat-keyed file caches
 * ------------------------------------------------------------------------- */

type FileState =
  | { kind: 'file'; size: number; key: string }
  | { kind: 'absent' | 'not-a-file' | 'unreadable'; key: string };

/**
 * What is at `file` right now, as a cache key. `stat` calls only — this is the whole cost of
 * a rebuild in which nothing changed.
 *
 * `statFileSafe` deliberately collapses "nothing there", "not a regular file" and "could not
 * be stat'ed" into one undefined. The task log needs them apart (an absent log is an empty
 * history; a FIFO sitting at its path is a problem the page must show), so the undefined
 * case is classified with one more `stat`, which — unlike an `open` — cannot block on a FIFO.
 */
function fileState(file: string): FileState {
  const st = statFileSafe(file);
  if (st !== undefined) {
    return { kind: 'file', size: st.size, key: `file:${st.size}:${st.mtimeMs}` };
  }
  try {
    // The file TYPE is part of the key so that a directory replaced by a FIFO is a change.
    const type = fs.statSync(file).mode & fs.constants.S_IFMT;
    return { kind: 'not-a-file', key: `not-a-file:${type}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT'
      ? { kind: 'absent', key: 'absent' }
      : { kind: 'unreadable', key: `unreadable:${typeof code === 'string' ? code : ''}` };
  }
}

/** Size past which a small JSON state file is not read at all (each is a few KB in practice). */
const SMALL_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * One small JSON state file, re-read only when its `(size, mtimeMs)` changes.
 *
 * `load` is the OWNING module's reader (`readStats`, `readUsageCache`, …), so the file format
 * has one definition. The reader is called only when the stat just said "a regular file of a
 * sane size": nothing else holds a reading, and a FIFO planted at `stats.json` is classified
 * `not-a-file` here without being opened on a render path. Whatever the reader returns is
 * reduced to a plain object, because every consumer below indexes into the result.
 */
class StatCached<T> {
  private key: string | undefined;
  private value: T | undefined;

  constructor(
    private readonly file: string,
    private readonly load: () => unknown,
    private readonly shape: (raw: Record<string, unknown>) => T,
  ) {}

  get(): T {
    const state = fileState(this.file);
    if (this.value === undefined || state.key !== this.key) {
      this.key = state.key;
      let raw: unknown;
      if (state.kind === 'file' && state.size <= SMALL_FILE_MAX_BYTES) {
        try {
          raw = this.load();
        } catch {
          raw = undefined;
        }
      }
      this.value = this.shape(isRecord(raw) ? raw : {});
    }
    return this.value;
  }
}

const identity = (raw: Record<string, unknown>): Record<string, unknown> => raw;

/** What the registry file holds, as this module reads it. */
interface RegistryReading {
  /** The registry as an untyped object: each field is re-read by `typeof` where it is used. */
  registry: Record<string, unknown>;
  /** Why the file could not be understood (registry.readRegistryChecked), or null. */
  problem: string | null;
}

/** Cap of `UiHealth.registryProblem`. */
const REGISTRY_PROBLEM_MAX = 200;

let registryKey: string | undefined;
let registryReading: RegistryReading = { registry: {}, problem: null };

/**
 * The shared registry, re-read only when the stat of its file changes — through the CHECKED
 * reader, in every state the path can be in. The plain reader answers "no workers" for a file
 * it could not understand, and a surface that showed that would be telling the user their
 * accounts are gone; with `problem` set the true answer is "the registry could not be read".
 *
 * Unlike the caches above this one calls its reader whatever the stat said: the registry's
 * reader is the guarded one (it opens non-blocking and refuses whatever is not a regular file
 * of at most 1 MiB), and what it says about a directory, a pipe or an oversized file at this
 * path is exactly the `problem` this module must pass on.
 */
function registryRead(): RegistryReading {
  const state = fileState(REGISTRY_FILE);
  if (registryKey !== state.key) {
    registryKey = state.key;
    try {
      const read = readRegistryChecked();
      registryReading = {
        registry: isRecord(read.registry) ? (read.registry as unknown as Record<string, unknown>) : {},
        problem: displayOrNull(read.problem, REGISTRY_PROBLEM_MAX),
      };
    } catch {
      // The reader is documented never to throw; a defect there must still not read as "fine".
      registryReading = { registry: {}, problem: 'the read failed' };
    }
  }
  return registryReading;
}

const statsCache = new StatCached(STATS_FILE, readStats, identity);
const orchestratorsCache = new StatCached(ORCHESTRATORS_FILE, readOrchestrators, indexByDirectory);
const usageCache = new StatCached(USAGE_CACHE_FILE, readUsageCache, indexUsage);

/* ------------------------------------------------------------------------- *
 * The task index — tasks.jsonl, read once and then only where it grew
 * ------------------------------------------------------------------------- */

/**
 * Shape of a task id as every reader of the task log admits it (ranAs.isCountedTaskEvent, and
 * the registry's own rule for an id that can name a file). Ids this product mints are `t` +
 * base36 time + a random tail, which is inside it.
 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Read ceiling for the task log. The same number as registry.ts's private
 * `TASK_LOG_MAX_BYTES`, for the same reasons (the log is legitimately large, append-writable
 * by any worker, and must stay far under V8's maximum string). Past it the log is REFUSED,
 * never truncated: a prefix of an append-only ledger makes finished tasks look running.
 */
const TASK_LOG_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How much of the log one read call takes. The log is walked in pieces of this size, so a
 * first read of a log at its ceiling holds one piece of its bytes at a time — never the whole
 * file, and never the whole file again as one string.
 */
const TASK_LOG_CHUNK_BYTES = 4 * 1024 * 1024;

/** Longest raw `worker` string that can be an account name (names are short `[\w-]+`). */
const WORKER_NAME_MAX = 256;

/** How many tasks a surface LISTS (the dashboard, the Tasks tree); the rest are counted. */
export const TASK_LIST_MAX = 300;
const DAILY_BUCKETS = 14;

/** Cap for a provider value this version does not know, shown as written (views.ts). */
const PROVIDER_TEXT_MAX = 32;

/** Where a task's model came from (`UiTask.modelSource`). */
export type UiModelSource = 'dispatch' | 'worker' | 'cli';

/**
 * Three values of one event, reduced to what `ranAs.ranAsOf` reads of them and to nothing it
 * would read differently:
 *
 *  - `model`: the event's `model`, trimmed, when it is a string that can still be a model
 *    (at most 128 characters trimmed — every form `normalizeProviderModel` accepts is shorter,
 *    and it trims first); else undefined. NOT the display form: a cut or flattened id is
 *    another id.
 *  - `provider`: the CLI the event names (`storedProvider`: none named is Claude Code), or
 *    null when it names one this build does not know — which matches no account.
 *  - `source`: the event's own `modelSource`, when it is one of the three words.
 */
interface FinalAsk {
  model: string | undefined;
  provider: ProviderId | null;
  source: UiModelSource | null;
}

/**
 * One task of the log, as every surface reads it: the projection of its LATEST event, plus
 * what its earlier events established (when it started, whether a supervisor ran it, which
 * CLI ran it). Everything display-bound is flattened and capped.
 *
 * It is deliberately small, because there is one per task ever logged: the strings with few
 * distinct values (account, model, reported model, workspace) are shared between rows — the
 * model's source is one of three constants — and the bulky fields a
 * surface shows for a handful of rows only — the prompt preview, the error text, the token
 * counts — are not here at all. They are read back from the log on demand, by the position of
 * the task's latest event (`at`, `len`; see taskDetail).
 *
 * A row is never modified: a task's next event produces a new row, so a surface may key a
 * cache on the object.
 */
export interface TaskRow {
  id: string;
  status: UiTaskStatus;
  mode: UiDispatchMode;
  /** ≤ 160 chars; `-` when the log holds none. */
  title: string;
  /** ≤ 120 chars; `-` when the log holds none. */
  worker: string;
  /** The model the task ASKED for, ≤ 64 chars; `-` when the log holds none. */
  model: string;
  /**
   * The model id the task's CLI REPORTED it ran, from the task's terminal event — kept only
   * when it has the shape of a reported id (platform.REPORTED_MODEL_ID, ≤ 64 chars). A session
   * worker's comes from its transcript (mesh/transcript.sessionModelOf). Null when the event
   * carries none: a failed run, a log entry of an earlier version. Never derived from `model`.
   */
  modelUsed: string | null;
  /**
   * Where the task's model came from, as its events record it: named by the dispatch, the
   * worker account's default, or left to the CLI. Null when no event of the task says.
   */
  modelSource: UiModelSource | null;
  /**
   * What the task's FINAL event alone says of the model it asked for (FinalAsk). For the one
   * question that is asked of the final event and nothing else — what an account's default
   * last ran as (ranAs.ranAsOf). Host-side only; one object shared by every row that says the
   * same.
   */
  asked: FinalAsk;
  /** Time of the task's first event when that event is its start and its `ts` is a time, else null. */
  startedAt: number | null;
  /** Time of the task's latest event; null when its `ts` is not a time (recordedTime). */
  lastTs: number | null;
  /** Name of the session worker that ran it, ≤ 80 chars, else null. */
  sessionWorker: string | null;
  /** `ProviderId` of the CLI that ran it when that is not Claude Code, else null. */
  provider: string | null;
  /**
   * What the log names as the task's CLI when it is NOT a provider this version knows:
   * display-safe, ≤ 32 chars. Null otherwise. For the tree rows, which show such a value as
   * written rather than claim Claude Code ran the task; never sent to the page.
   */
  providerText: string | null;
  /** RAW `worker` value, for the exact-name joins. Host-side only; never sent. */
  workerName: string | undefined;
  /** Resolved absolute workspace of the dispatch. Host-side only; never sent. */
  cwd: string | undefined;
  /** Some event of the task carries a supervisor pid. Host-side only. */
  detached: boolean;
  /** Byte offset of the task's latest event in the log. Host-side only. */
  at: number;
  /** Byte length of that line, without its terminator. Host-side only. */
  len: number;
}

/**
 * Every `done` event of the log that has a time, reduced to what the 5-hour / 7-day sums
 * need: five parallel columns, entry `i` of each being one event. Columns rather than an
 * object per event because there is one per finished task, and a column of numbers is the
 * numbers and nothing else. Ascending by `ts`. An event whose `ts` is not a time
 * (recordedTime) is in no window, so it is not here at all.
 */
interface DoneEvents {
  ts: number[];
  /** RAW worker name. */
  worker: string[];
  inputTokens: number[];
  outputTokens: number[];
  costUsd: number[];
}

function noDoneEvents(): DoneEvents {
  return { ts: [], worker: [], inputTokens: [], outputTokens: [], costUsd: [] };
}

/** Put the columns back in ascending `ts` order; events of one instant keep their file order. */
function sortDoneEvents(done: DoneEvents): void {
  const order = done.ts.map((_, i) => i).sort((a, b) => done.ts[a] - done.ts[b] || a - b);
  done.ts = order.map((i) => done.ts[i]);
  done.worker = order.map((i) => done.worker[i]);
  done.inputTokens = order.map((i) => done.inputTokens[i]);
  done.outputTokens = order.map((i) => done.outputTokens[i]);
  done.costUsd = order.map((i) => done.costUsd[i]);
}

interface TaskIndex {
  /** Why the log could not be read (≤ 120 chars), or null. Never set for an absent log. */
  problem: string | null;
  /** Changes whenever the index does: what a surface keys its own cache on. */
  generation: number;
  byId: Map<string, TaskRow>;
  /** Newest first. */
  sorted: TaskRow[];
  done: DoneEvents;
  /** Running tasks per RAW worker name, all workspaces. */
  runningByWorker: Map<string, number>;
  /** Ids whose output file has been seen on disk during this generation of the index. */
  outputSeen: Set<string>;
}

let indexGeneration = 0;

function emptyIndex(problem: string | null): TaskIndex {
  return {
    problem,
    generation: ++indexGeneration,
    byId: new Map(),
    sorted: [],
    done: noDoneEvents(),
    runningByWorker: new Map(),
    outputSeen: new Set(),
  };
}

/**
 * A parsed log line → an event we are willing to index, or undefined.
 *
 * A line that parses is not yet a record: `JSON.parse` returns `null`, numbers and arrays
 * too. And a record is only OURS when its three load-bearing fields mean something — an id
 * of the shape a task id has, one of the three statuses the writers emit, and a `ts` with the
 * shape of a timestamp (`epochMs`). Anything else is skipped exactly like a torn line, so a
 * garbage line carrying a real task's id can neither hide that task nor flip what it shows.
 *
 * Whether that `ts` is a TIME is a second question, asked where the event is filed
 * (recordedTime): a record dated in the future is still a record of its task — the registry's
 * own readers take its status — and is indexed with no time.
 *
 * ONE rule for every surface AND every reader: the dashboard, the Tasks tree, the Worker
 * History tree, the per-account dispatch windows — and `list_workers` in the dispatch server —
 * count the events `ranAs.isCountedTaskEvent` admits, and no others. A line that fails it does
 * not exist for any of them.
 */
function acceptEvent(parsed: unknown): Record<string, unknown> | undefined {
  return isCountedTaskEvent(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

/** `cancelled` or `orphaned` as the first word of an error text, in any case. */
const ERROR_CLASS = /^\s*(cancelled|orphaned)/i;

/**
 * The status every surface shows for a task recorded as `error`. Cancelled and orphaned tasks
 * are recorded that way too, told apart only by the first word of the error text their
 * writers use (`cancelled by …`, `orphaned — …`); everything else that failed is `failed`.
 *
 * Decided on the text AS RECORDED — leading whitespace skipped, case ignored, nothing else
 * removed. That is exactly the test the registry applies before it lets a result file's own
 * message keep one of these two words (registry.claimsErrorClass), so a message that was
 * prefixed there to stop it choosing its own class cannot regain it here through a character
 * a display rule would have deleted.
 */
function terminalStatus(error: unknown): UiTaskStatus {
  const found = typeof error === 'string' ? ERROR_CLASS.exec(error) : null;
  if (found === null) {
    return 'failed';
  }
  return found[1].toLowerCase() === 'cancelled' ? 'cancelled' : 'orphaned';
}

/** Is this event the mark of a supervised detach: a `supervisorPid` that is a real number? */
function hasSupervisor(event: Record<string, unknown>): boolean {
  return typeof event.supervisorPid === 'number' && Number.isFinite(event.supervisorPid);
}

/** The CLI an event names: a known provider other than Claude Code, or a value shown as written. */
interface EventProvider {
  id: string | null;
  text: string | null;
}

const NO_PROVIDER: EventProvider = { id: null, text: null };

/**
 * The provider an event records. Dispatch writes the field only for another vendor's CLI, so
 * absent, blank and `"claude"` are one answer: none. A known `ProviderId` is that id — the
 * only form the page is ever given. Any other text names a CLI this version does not know; it
 * is kept display-safe for the tree rows and never reaches the page as if it were an id.
 */
function eventProvider(raw: string): EventProvider {
  const id = parseProvider(raw);
  if (id === 'claude') {
    return NO_PROVIDER;
  }
  if (id !== undefined) {
    return { id, text: null };
  }
  const text = displayString(raw, PROVIDER_TEXT_MAX);
  return text === '' ? NO_PROVIDER : { id: null, text };
}

/** Longest value a Memo keeps under its own text; a longer one is projected each time. */
const MEMO_KEY_MAX = 512;
const MEMO_ENTRIES_MAX = 4096;

/**
 * A projection of a field that has few distinct values across a log (an account, a model, a
 * workspace, a provider): each distinct value is projected once, and the result is ONE value
 * shared by every task that carries it rather than a copy per task. Bounded — a log that has
 * more distinct values than MEMO_ENTRIES_MAX simply stops sharing them.
 */
class Memo<T> {
  private readonly seen = new Map<string, T>();

  constructor(private readonly project: (raw: string) => T) {}

  of(raw: string): T {
    if (raw.length > MEMO_KEY_MAX) {
      return this.project(raw);
    }
    let out = this.seen.get(raw);
    if (out === undefined && !this.seen.has(raw)) {
      if (this.seen.size >= MEMO_ENTRIES_MAX) {
        this.seen.clear();
      }
      out = this.project(raw);
      this.seen.set(raw, out);
    }
    return out as T;
  }
}

const workerText = new Memo((raw) => displayString(raw, 120) || '-');
const modelText = new Memo((raw) => displayString(raw, 64) || '-');
/** A reported model id, or null for a value that does not have the shape of one. */
const reportedModel = new Memo((raw): string | null => (REPORTED_MODEL_ID.test(raw) ? raw : null));
const workspacePath = new Memo((raw) => absolutePath(raw));

/** Longest trimmed `model` that can still be one (see FinalAsk). */
const ASKED_MODEL_MAX = 128;
const NO_ASK: FinalAsk = { model: undefined, provider: 'claude', source: null };
const finalAsks = new Map<string, FinalAsk>();

/**
 * The FinalAsk of one event — one shared object per distinct answer, since a log holds a
 * handful of them (model × CLI × source) however many tasks it has.
 */
function finalAskOf(event: Record<string, unknown>): FinalAsk {
  const trimmed = typeof event.model === 'string' ? event.model.trim() : '';
  // A model longer than any model is kept out by length alone, before it becomes a map key.
  const model = trimmed !== '' && trimmed.length <= ASKED_MODEL_MAX ? trimmed : undefined;
  const provider = storedProvider(event.provider) ?? null;
  const source = eventModelSource(event.modelSource);
  if (model === undefined && provider === 'claude' && source === null) {
    return NO_ASK;
  }
  const key = `${provider ?? ''}\u0000${source ?? ''}\u0000${model ?? '\u0001'}`;
  let ask = finalAsks.get(key);
  if (ask === undefined) {
    if (finalAsks.size >= MEMO_ENTRIES_MAX) {
      finalAsks.clear();
    }
    ask = { model, provider, source };
    finalAsks.set(key, ask);
  }
  return ask;
}
const providerOf = new Memo(eventProvider);
/** The raw account name itself, so that every row of one account holds the same string. */
const workerNames = new Memo((raw) => raw);

function textOf<T>(memo: Memo<T>, raw: unknown, otherwise: T): T {
  return typeof raw === 'string' && raw !== '' ? memo.of(raw) : otherwise;
}

/** The model source an event records: one of the three words the dispatch server writes, else null. */
function eventModelSource(raw: unknown): UiModelSource | null {
  return raw === 'dispatch' || raw === 'worker' || raw === 'cli' ? raw : null;
}

/**
 * How the task was run (contract §6.1): a session worker records its name on the task's
 * latest event; a detach supervisor records its `supervisorPid` — on ANY event of the task,
 * since the terminal event of a detached task is not required to repeat it; anything else is
 * a one-shot.
 *
 * `pgid` is deliberately NOT read. Every in-process one-shot records one while it runs (it
 * leads its own process group so the whole tree can be signalled), so treating it as a detach
 * marker showed every running one-shot as "detached".
 */
function dispatchMode(sessionWorker: string, detached: boolean): UiDispatchMode {
  if (sessionWorker !== '') {
    return 'session';
  }
  return detached ? 'detached' : 'oneshot';
}

/** What a task's events established before, or beside, the one being projected. */
interface TaskFacts {
  /** `ts` of the task's first event when that event is its start, else null. */
  startedAt: number | null;
  /** Some event of the task carries a numeric `supervisorPid`. */
  detached: boolean;
  /** The provider the latest event that names one names. */
  provider: EventProvider;
  /** The model source the latest event that records one records. */
  modelSource: UiModelSource | null;
}

function projectTask(
  event: Record<string, unknown>,
  facts: TaskFacts,
  lastTs: number | null,
  at: number,
  len: number,
): TaskRow {
  const sessionWorker = displayString(event.meshWorker, 80);
  const status: UiTaskStatus =
    event.status === 'running' ? 'running' : event.status === 'done' ? 'done' : terminalStatus(event.error);
  return {
    id: event.id as string,
    status,
    mode: dispatchMode(sessionWorker, facts.detached),
    title: displayString(event.title, 160) || '-',
    worker: textOf(workerText, event.worker, '-'),
    model: textOf(modelText, event.model, '-'),
    // What RAN is known once the run has ended, and only from a value with the shape of a
    // reported id: the log is a file any process of this user can append a line to.
    modelUsed: event.status === 'running' ? null : textOf(reportedModel, event.modelUsed, null),
    modelSource: facts.modelSource,
    asked: finalAskOf(event),
    // The first event in the log is the start only when it IS a start. A log cleared mid-run
    // begins with the task's terminal event, and reporting that as the start would show a
    // zero-second run; null says "the log no longer holds it".
    startedAt: facts.startedAt,
    lastTs,
    sessionWorker: sessionWorker === '' ? null : sessionWorker,
    provider: facts.provider.id,
    providerText: facts.provider.text,
    workerName:
      typeof event.worker === 'string' && event.worker !== '' && event.worker.length <= WORKER_NAME_MAX
        ? workerNames.of(event.worker)
        : undefined,
    cwd: textOf(workspacePath, event.cwd, undefined),
    detached: facts.detached,
    at,
    len,
  };
}

/**
 * `endedAt ?? startedAt`: when a task ended, or — while it runs — when it started. A task
 * with no time (recordedTime) has a key below every real one — 1 while it runs, 0 once it has
 * ended — so it cannot take a place in a newest-first list from a task that is dated, and of
 * the tasks with no time the ones still running come first.
 */
function sortKeyOf(row: TaskRow): number {
  const at = row.status === 'running' ? (row.startedAt ?? row.lastTs) : row.lastTs;
  return at ?? (row.status === 'running' ? 1 : 0);
}

/**
 * Newest first by sortKeyOf; the id breaks ties so that two builds of the same log always
 * agree (the dashboard posts a model only when its JSON differs from the last one). A TOTAL
 * order — no two tasks compare equal — which is what lets a row be found again by bisection.
 */
function byNewest(a: TaskRow, b: TaskRow): number {
  return sortKeyOf(b) - sortKeyOf(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** The position in `sorted` where `row` is, or where it belongs. */
function positionOf(sorted: readonly TaskRow[], row: TaskRow): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (byNewest(sorted[mid], row) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function countRunning(running: Map<string, number>, row: TaskRow, by: 1 | -1): void {
  if (row.status !== 'running' || row.workerName === undefined) {
    return;
  }
  const next = (running.get(row.workerName) ?? 0) + by;
  if (next > 0) {
    running.set(row.workerName, next);
  } else {
    running.delete(row.workerName);
  }
}

/** What one read of the log has seen of one task. */
interface Touched {
  /** The task's first event, when this read is where the task appeared. `ts`: its time, or null. */
  first: { ts: number | null; running: boolean } | undefined;
  last: Record<string, unknown>;
  /** The time of `last`, or null when its `ts` is not one. */
  lastTs: number | null;
  at: number;
  len: number;
  detached: boolean;
  provider: EventProvider | undefined;
  /** The model source of the latest event of this read that records one. */
  modelSource: UiModelSource | undefined;
}

/** A line with anything but whitespace in it — the lines `String.prototype.trim` leaves non-empty. */
const NON_BLANK = /\S/;

/**
 * One read of the log applied to an index: every complete line it is handed, in file order.
 *
 * Per task id: the first event gives the start, the LAST event gives status and fields (file
 * order — the log is append-only and every reader in this codebase takes the last line per
 * id). Only the last event a read sees of each task is projected, so the flattening cost is
 * per task, not per event. Three facts are gathered over EVERY event instead: whether a
 * supervisor was ever recorded, the provider and the source of the model — for each of the
 * last two the latest event that names one decides, so a task keeps it past a terminal event
 * that does not.
 *
 * The same code serves a read from the start of the file and a read of what was appended
 * since: a task the index already holds keeps the facts its row carries.
 */
class LogPass {
  private readonly touched = new Map<string, Touched>();
  /** Each task this read changed → the row it had before (undefined: it is new). */
  private readonly before = new Map<string, TaskRow | undefined>();
  private doneOutOfOrder = false;
  /** This read was handed at least one event. */
  private changed = false;

  constructor(
    private readonly index: TaskIndex,
    /** The index was empty when this read began: nothing in it needs keeping in step. */
    private readonly fromStart: boolean,
    /** The clock when this read began: what an event's `ts` is held against (recordedTime). */
    private readonly readAt: number,
  ) {}

  /** One line of the log (without its terminator), found at byte `at` and `len` bytes long. */
  line(text: string, at: number, len: number): void {
    // The registry's own tolerance, line for line (registry.taskEventsIn): a blank line is
    // nothing, a line that does not parse is skipped and the rest of the log is kept.
    if (!NON_BLANK.test(text)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const event = acceptEvent(parsed);
    if (event !== undefined) {
      this.event(event, at, len);
    }
  }

  private event(event: Record<string, unknown>, at: number, len: number): void {
    const id = event.id as string;
    const ts = recordedTime(event.ts, this.readAt);
    this.changed = true;
    let seen = this.touched.get(id);
    if (seen === undefined) {
      seen = {
        first: this.index.byId.has(id) ? undefined : { ts, running: event.status === 'running' },
        last: event,
        lastTs: ts,
        at,
        len,
        detached: false,
        provider: undefined,
        modelSource: undefined,
      };
      this.touched.set(id, seen);
    } else {
      seen.last = event;
      seen.lastTs = ts;
      seen.at = at;
      seen.len = len;
    }
    if (hasSupervisor(event)) {
      seen.detached = true;
    }
    if (typeof event.provider === 'string') {
      seen.provider = providerOf.of(event.provider);
    }
    const modelSource = eventModelSource(event.modelSource);
    if (modelSource !== null) {
      seen.modelSource = modelSource;
    }
    if (
      event.status === 'done' &&
      ts !== null &&
      typeof event.worker === 'string' &&
      event.worker !== '' &&
      event.worker.length <= WORKER_NAME_MAX
    ) {
      // The session transport reports no usage (its `done` event carries literal zeros), so
      // such an event counts as a task and adds nothing to the sums.
      const session = displayString(event.meshWorker, 80) !== '';
      const done = this.index.done;
      if (done.ts.length > 0 && done.ts[done.ts.length - 1] > ts) {
        this.doneOutOfOrder = true;
      }
      done.ts.push(ts);
      done.worker.push(workerNames.of(event.worker));
      done.inputTokens.push(session ? 0 : (amount(event.inputTokens) ?? 0));
      done.outputTokens.push(session ? 0 : (amount(event.outputTokens) ?? 0));
      done.costUsd.push(session ? 0 : (amount(event.costUsd) ?? 0));
    }
  }

  /**
   * Project what has been seen so far and let the parsed events go. Called between pieces of
   * the file, so that a read of the whole log never holds more parsed events than one piece
   * of it contains.
   */
  flush(): void {
    const { byId } = this.index;
    for (const [id, seen] of this.touched) {
      const held = byId.get(id);
      if (!this.fromStart && !this.before.has(id)) {
        this.before.set(id, held);
      }
      byId.set(
        id,
        projectTask(
          seen.last,
          {
            startedAt:
              held !== undefined ? held.startedAt : seen.first?.running === true ? seen.first.ts : null,
            detached: seen.detached || held?.detached === true,
            provider:
              seen.provider ??
              (held === undefined || (held.provider === null && held.providerText === null)
                ? NO_PROVIDER
                : { id: held.provider, text: held.providerText }),
            modelSource: seen.modelSource ?? held?.modelSource ?? null,
          },
          seen.lastTs,
          seen.at,
          seen.len,
        ),
      );
    }
    this.touched.clear();
  }

  /** Bring the order and the per-account counts in step with the rows. */
  finish(): void {
    this.flush();
    const index = this.index;
    if (!this.fromStart && !this.changed) {
      // Nothing this read saw was an event: the index is what it was, and so is everything a
      // surface derived from it.
      return;
    }
    if (this.doneOutOfOrder) {
      sortDoneEvents(index.done);
    }
    // A few changed tasks are moved one by one — each is found and placed by bisection. Past
    // that (a first read, a burst) sorting everything once is the cheaper way.
    let inStep = !this.fromStart && this.before.size <= RESORT_ABOVE;
    if (inStep) {
      for (const [id, old] of this.before) {
        if (old !== undefined) {
          const at = positionOf(index.sorted, old);
          if (index.sorted[at] !== old) {
            inStep = false;
            break;
          }
          index.sorted.splice(at, 1);
          countRunning(index.runningByWorker, old, -1);
        }
        const row = index.byId.get(id);
        if (row !== undefined) {
          index.sorted.splice(positionOf(index.sorted, row), 0, row);
          countRunning(index.runningByWorker, row, 1);
        }
      }
    }
    if (!inStep) {
      index.sorted = [...index.byId.values()].sort(byNewest);
      index.runningByWorker.clear();
      for (const row of index.sorted) {
        countRunning(index.runningByWorker, row, 1);
      }
    }
    index.generation = ++indexGeneration;
  }
}

/** Changed tasks past which the order is rebuilt by one sort instead of task by task. */
const RESORT_ABOVE = 256;

/**
 * Open flags for the log: read-only, non-blocking where the platform has the flag, and never
 * a controlling terminal — the flags safeFs opens every file with, for its reasons (a FIFO at
 * the path must not block the extension host). A symbolic link is followed, as the registry's
 * own read of this file follows one: a person may keep their log at a linked path.
 */
const LOG_READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/** How much of the start of the log is remembered, to recognise the same log when it has grown. */
const LOG_HEAD_BYTES = 256;
/** How much of the log just before the read position is remembered, for the same purpose. */
const LOG_TAIL_BYTES = 64;

/** Where the index stands in the file it was read from. */
interface LogCursor {
  dev: bigint;
  ino: bigint;
  /** The file's size and mtime when it was last read. */
  size: number;
  mtimeNs: bigint;
  /** Every byte before this one is in the index. */
  offset: number;
  /** The line that ends at `offset` had no terminator when it was read (see readTaskLog). */
  openEnded: boolean;
  /** The first bytes of the file, as they were read. */
  head: Buffer;
  /** The bytes just before `offset`, as they were read. */
  tail: Buffer;
}

class LogReadError extends Error {}

/** Read exactly `length` bytes at `position`, or throw: a short read means the file shrank. */
function readExactly(fd: number, target: Buffer, length: number, position: number): void {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, target, got, length - got, position + got);
    if (n <= 0) {
      throw new LogReadError('unreadable: the file shrank while it was being read');
    }
    got += n;
  }
}

function bytesAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  readExactly(fd, out, length, position);
  return out;
}

/**
 * Is the open file the log `cursor` was reading, with more appended? True when everything the
 * index already consumed is still what it was: the same first bytes, the same bytes before
 * the read position, and — when the last line read had no terminator — a terminator now where
 * that line ended.
 *
 * The inode alone does not say it. `clearTaskLog` truncates the file in place, and a log that
 * was cleared and has since outgrown its old size is the same inode with a larger size: read
 * on from the old position it would yield the middle of unrelated lines on top of the tasks
 * of the cleared log. Its first line is another task's, so its first bytes differ.
 *
 * WHAT THIS CANNOT SEE: bytes rewritten in place anywhere but in the first 256 bytes and the
 * 64 before the read position, in a file that has the same inode and has GROWN since it was
 * last read — whatever its modification time says. Such a file passes this test, and the
 * index keeps what it read of those bytes before. Nothing of this product writes the log that
 * way (it appends, truncates, or replaces the file). What the index holds is next compared
 * with the file as a whole when it is rebuilt from the first byte: when the file shrinks, is
 * replaced, or changes without growing; when a command the user runs refreshes a task view
 * (rebuildTaskIndex); and, at the latest, the first time the log changes more than ten
 * minutes after the last such rebuild (LOG_FULL_REBUILD_MS). Until then a row can show what
 * its line used to say.
 */
function continues(fd: number, cursor: LogCursor): boolean {
  if (cursor.head.length > 0 && !bytesAt(fd, 0, cursor.head.length).equals(cursor.head)) {
    return false;
  }
  if (
    cursor.tail.length > 0 &&
    !bytesAt(fd, cursor.offset - cursor.tail.length, cursor.tail.length).equals(cursor.tail)
  ) {
    return false;
  }
  return !cursor.openEnded || bytesAt(fd, cursor.offset, 1)[0] === 0x0a;
}

/**
 * Feed `pass` every line of the file between `from` and `to`, and say where the next read
 * begins.
 *
 * A line is the bytes up to a line feed, decoded on their own: a line feed is never part of
 * a multi-byte UTF-8 sequence, so this yields exactly the lines the registry gets by decoding
 * the whole file and splitting it.
 *
 * THE LAST LINE MAY NOT BE FINISHED. A writer appends a record and its line feed in one
 * write, but nothing makes that write whole, and a reader can arrive between two halves of
 * it. So bytes after the last line feed are consumed only when they already are a record —
 * they parse as a JSON object, which half a record never does — and are then remembered as
 * `openEnded`, so that the next read can check that nothing was added to that line. Anything
 * else stays unread until its line feed arrives.
 */
function readLines(
  fd: number,
  pass: LogPass,
  from: number,
  to: number,
): { offset: number; openEnded: boolean } {
  const chunk = Buffer.allocUnsafe(Math.min(TASK_LOG_CHUNK_BYTES, Math.max(1, to - from)));
  /** The bytes of a line that began in an earlier piece. */
  let carried: Buffer[] = [];
  let lineStart = from;
  let position = from;
  while (position < to) {
    const length = Math.min(chunk.length, to - position);
    readExactly(fd, chunk, length, position);
    const piece = length === chunk.length ? chunk : chunk.subarray(0, length);
    let begin = 0;
    for (;;) {
      const feed = piece.indexOf(0x0a, begin);
      if (feed === -1) {
        break;
      }
      const end = position + feed;
      if (carried.length === 0) {
        pass.line(piece.toString('utf8', begin, feed), lineStart, end - lineStart);
      } else {
        carried.push(piece.subarray(begin, feed));
        pass.line(Buffer.concat(carried).toString('utf8'), lineStart, end - lineStart);
        carried = [];
      }
      begin = feed + 1;
      lineStart = end + 1;
    }
    if (begin < length) {
      // Copied: the piece is about to be overwritten by the next read.
      carried.push(Buffer.from(piece.subarray(begin, length)));
    }
    position += length;
    pass.flush();
  }
  if (carried.length > 0) {
    const text = Buffer.concat(carried).toString('utf8');
    let whole = false;
    try {
      whole = NON_BLANK.test(text) && isRecord(JSON.parse(text));
    } catch {
      whole = false;
    }
    if (!whole) {
      return { offset: lineStart, openEnded: false };
    }
    pass.line(text, lineStart, to - lineStart);
    return { offset: to, openEnded: true };
  }
  return { offset: to, openEnded: false };
}

/** An errno code we are willing to quote (safeFs's own shape check, for its own reason). */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

function errnoOf(err: unknown): string | undefined {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERRNO_CODE.test(code) ? code : undefined;
}

/** What a thing that is not a regular file is, in safeFs's words. Literals only. */
function fileKindOf(st: fs.BigIntStats): string {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  if (st.isCharacterDevice()) {
    return 'a character device';
  }
  if (st.isBlockDevice()) {
    return 'a block device';
  }
  return 'something other than a regular file';
}

function tooLarge(size: number): string {
  return (
    `too-large: the file is ${size} bytes, past the ${TASK_LOG_MAX_BYTES}-byte read cap, and was ` +
    'refused rather than truncated'
  );
}

let taskLog: TaskIndex = emptyIndex(null);
let taskLogCursor: LogCursor | undefined;
/** What was at the log's path when it was last NOT a readable file: `absent`, or the problem. */
let taskLogState: string | undefined = 'absent';
/** The file a read failed on, and when — so that a failure is retried, but not on every call. */
let taskLogFailure: { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; at: number } | undefined;

/** How long a failed read of an unchanged log stands before it is tried again. */
const LOG_RETRY_MS = 2_000;

/**
 * How long reads of the log may go on extending the index in place. Past it, the next read is
 * made from the first byte: reading only what was appended cannot notice bytes that were
 * rewritten in place (see `continues`), and this bounds for how long the index can go on
 * showing them as they were. It costs one whole parse of the log, at most once per interval
 * and only when the log changed — an unchanged log is never read again, however old the index.
 */
const LOG_FULL_REBUILD_MS = 10 * 60_000;
/** When the index was last read from the first byte of the log (the wall clock), if it was. */
let taskLogReadFromStartAt: number | undefined;

function setTaskLog(index: TaskIndex, cursor: LogCursor | undefined, state: string | undefined): void {
  taskLog = index;
  taskLogCursor = cursor;
  taskLogState = state;
}

/** The log is not a file this module can read: an empty index that says why. */
function taskLogUnreadable(problem: string): void {
  setTaskLog(emptyIndex(displayString(problem, 120) || 'unreadable'), undefined, `problem:${problem}`);
}

/**
 * Bring the index up to date with a log whose stat has changed.
 *
 * WHEN THE SAME FILE HAS GROWN, only the new bytes are read. The log is append-only, so a
 * larger file with the same inode, the same first bytes and the same bytes before the read
 * position (continues) holds everything the index already has, and the index is extended in
 * place — for at most LOG_FULL_REBUILD_MS after the last read from the first byte.
 * EVERYTHING ELSE IS A NEW LOG and is read from its first byte into a new index: a
 * different inode (`renameWorker` rewrites the log through a temp file and a rename), a file
 * that shrank (`clearTaskLog` truncates it), a file of the same size with another mtime, an
 * index a user command asked to have rebuilt (rebuildTaskIndex), and a log that grew when the
 * last read from its first byte is more than ten minutes old.
 *
 * The file is opened once, and what is read is the file that was opened: its type and size
 * come from an `fstat` of that descriptor, never from a `stat` of the name.
 */
function readTaskLog(): void {
  let fd = -1;
  try {
    fd = fs.openSync(TASKS_LOG_FILE, LOG_READ_FLAGS);
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) {
      taskLogUnreadable(`not-a-file: the path is ${fileKindOf(st)}`);
      return;
    }
    const size = Number(st.size);
    if (!(size >= 0) || size > TASK_LOG_MAX_BYTES) {
      taskLogUnreadable(tooLarge(size));
      return;
    }
    const readAt = Date.now();
    const held = taskLogCursor;
    // A clock that went backwards gives a negative age: read from the start rather than trust it.
    const sinceStart = taskLogReadFromStartAt === undefined ? -1 : readAt - taskLogReadFromStartAt;
    const grown =
      held !== undefined &&
      st.dev === held.dev &&
      st.ino === held.ino &&
      size > held.size &&
      sinceStart >= 0 &&
      sinceStart < LOG_FULL_REBUILD_MS &&
      continues(fd, held);
    const index = grown ? taskLog : emptyIndex(null);
    const from = grown ? held.offset : 0;
    if (!grown) {
      taskLogReadFromStartAt = readAt;
    }
    const pass = new LogPass(index, !grown, readAt);
    const read = readLines(fd, pass, from, size);
    pass.finish();
    const headLength = Math.min(LOG_HEAD_BYTES, size);
    const tailLength = Math.min(LOG_TAIL_BYTES, read.offset);
    setTaskLog(
      index,
      {
        dev: st.dev,
        ino: st.ino,
        size,
        mtimeNs: st.mtimeNs,
        offset: read.offset,
        openEnded: read.openEnded,
        head: grown && held.head.length === headLength ? held.head : bytesAt(fd, 0, headLength),
        tail: bytesAt(fd, read.offset - tailLength, tailLength),
      },
      undefined,
    );
    taskLogFailure = undefined;
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') {
      // Gone between the stat and the open: an absent log, which is an empty history.
      setTaskLog(emptyIndex(null), undefined, 'absent');
      return;
    }
    // A read that failed part-way may have extended the index in place; none of it is kept.
    const code = errnoOf(err);
    taskLogUnreadable(
      err instanceof LogReadError
        ? err.message
        : code !== undefined
          ? `unreadable: the operation failed (${code})`
          : 'unreadable: the task log could not be indexed',
    );
    // Not keyed like a problem the stat can see: the file may be perfectly readable a moment
    // from now (EMFILE, a file that shrank mid-read), so it is tried again — see taskIndex.
    taskLogState = undefined;
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — nothing to do
      }
    }
  }
}

/**
 * The current task index. With an unchanged log this is one `stat` and nothing else: no open,
 * no read, no parse, and no allocation that grows with the log.
 *
 * The log is recognised by (device, inode, size, mtime). `absent` is the ONLY state that
 * means "no tasks". Every other one — a FIFO or directory at the path, a log past the cap,
 * EACCES, EMFILE — establishes nothing about what was dispatched, so it yields an EMPTY index
 * that carries a `problem`, and every surface says the log is unreadable instead of "no tasks
 * yet". These are the registry's own answers for the same file (registry.readTaskEventsChecked:
 * the same cap, the same four reasons, `absent` alone reading as empty), and the problem text
 * is composed from literals and numbers — never the path, never a byte of the file.
 */
function taskIndex(): TaskIndex {
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(TASKS_LOG_FILE, { bigint: true });
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') {
      if (taskLogState !== 'absent') {
        setTaskLog(emptyIndex(null), undefined, 'absent');
      }
    } else {
      const problem =
        code !== undefined ? `unreadable: the operation failed (${code})` : 'unreadable: the operation failed';
      if (taskLogState !== `problem:${problem}`) {
        taskLogUnreadable(problem);
      }
    }
    return taskLog;
  }
  // The file TYPE is part of the problem text, so a directory replaced by a FIFO is a change.
  const problem = !st.isFile()
    ? `not-a-file: the path is ${fileKindOf(st)}`
    : st.size > BigInt(TASK_LOG_MAX_BYTES)
      ? tooLarge(Number(st.size))
      : undefined;
  if (problem !== undefined) {
    if (taskLogState !== `problem:${problem}`) {
      taskLogUnreadable(problem);
    }
    return taskLog;
  }
  const size = Number(st.size);
  const held = taskLogCursor;
  if (
    held !== undefined &&
    st.dev === held.dev &&
    st.ino === held.ino &&
    size === held.size &&
    st.mtimeNs === held.mtimeNs
  ) {
    return taskLog;
  }
  const failed = taskLogFailure;
  if (
    held === undefined &&
    failed !== undefined &&
    st.dev === failed.dev &&
    st.ino === failed.ino &&
    size === failed.size &&
    st.mtimeNs === failed.mtimeNs &&
    Math.abs(Date.now() - failed.at) < LOG_RETRY_MS
  ) {
    return taskLog;
  }
  readTaskLog();
  taskLogFailure =
    taskLogCursor === undefined && taskLog.problem !== null
      ? { dev: st.dev, ino: st.ino, size, mtimeNs: st.mtimeNs, at: Date.now() }
      : undefined;
  return taskLog;
}

/**
 * Have the index read again from the first byte of the log, the next time anything asks for
 * it — whatever the file's stat says. For a command the USER runs to refresh a view of the
 * tasks: it is how a log that was rewritten in place (see `continues`) is seen again as it
 * is. Costs one whole parse of the log, so nothing that runs by itself (a timer, a file
 * watcher, a redraw) may call it.
 *
 * Shared with views.ts and history-view.ts (same owner); not part of the §6.1 surface.
 */
export function rebuildTaskIndex(): void {
  taskLogCursor = undefined;
  taskLogFailure = undefined;
}

/**
 * Why the task log cannot be read (≤ 120 chars, composed from literals), or null when it can
 * — or when there is none yet. While it is set the log reads as empty and a surface must say
 * so rather than show "no tasks".
 */
export function taskLogProblem(): string | null {
  return taskIndex().problem;
}

/** The task with this id, or undefined. */
function taskRow(id: unknown): TaskRow | undefined {
  return typeof id === 'string' && TASK_ID_RE.test(id) ? taskIndex().byId.get(id) : undefined;
}

/**
 * Title and status of one task, from the index — so the Team view can label a worker with its
 * task without reading the log a second time.
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export function taskBrief(id: unknown): { title: string; status: UiTaskStatus } | undefined {
  const row = taskRow(id);
  return row === undefined ? undefined : { title: row.title, status: row.status };
}

/** Which tasks a list is of. */
export interface TaskListQuery {
  /** Only tasks dispatched from this directory or below; undefined lists every workspace's. */
  root: string | undefined;
  /**
   * `finished-session`: only tasks a session worker ran that have ended — what the Worker
   * History tree shows. Default: every task.
   */
  only?: 'finished-session';
  /** How many rows to return; the rest are counted in `total`. */
  limit: number;
}

/** The newest tasks a query matches, and how many match in all. */
export interface TaskList {
  rows: TaskRow[];
  total: number;
  /** See taskLogProblem. */
  problem: string | null;
}

const taskLists = new Map<string, { generation: number; list: TaskList }>();
const TASK_LISTS_MAX = 8;

/**
 * The newest `limit` tasks matching `query`, newest first, with the count of all that match.
 *
 * What the tree views build their rows from. The answer for one query is kept until the log
 * changes, so a redraw with nothing new is a `stat` and a map read; when the log did change
 * the cost is one pass over the index, in which a workspace test is made once per distinct
 * directory rather than once per task.
 */
export function listTasks(query: TaskListQuery): TaskList {
  const index = taskIndex();
  const root = query.root === undefined ? undefined : absolutePath(query.root);
  const limit = Number.isFinite(query.limit) && query.limit > 0 ? Math.floor(query.limit) : 0;
  const only = query.only === 'finished-session' ? query.only : 'all';
  if (query.root !== undefined && root === undefined) {
    // A root that is not an absolute path contains nothing.
    return { rows: [], total: 0, problem: index.problem };
  }
  const key = `${only}\u0000${limit}\u0000${root ?? ''}`;
  const kept = taskLists.get(key);
  if (kept !== undefined && kept.generation === index.generation) {
    return kept.list;
  }
  const inside = new Map<string | undefined, boolean>();
  const rows: TaskRow[] = [];
  let total = 0;
  for (const row of index.sorted) {
    if (only === 'finished-session' && (row.mode !== 'session' || row.status === 'running')) {
      continue;
    }
    if (root !== undefined) {
      let within = inside.get(row.cwd);
      if (within === undefined) {
        within = row.cwd !== undefined && pathWithin(row.cwd, root);
        inside.set(row.cwd, within);
      }
      if (!within) {
        continue;
      }
    }
    total += 1;
    if (rows.length < limit) {
      rows.push(row);
    }
  }
  const list: TaskList = { rows, total, problem: index.problem };
  taskLists.delete(key);
  taskLists.set(key, { generation: index.generation, list });
  // Insertion order is age order; the oldest query goes first.
  while (taskLists.size > TASK_LISTS_MAX) {
    const oldest = taskLists.keys().next();
    if (oldest.done) {
      break;
    }
    taskLists.delete(oldest.value);
  }
  return list;
}

/* ------------------------------------------------------------------------- *
 * Task details — read back from the log for the rows a surface shows
 * ------------------------------------------------------------------------- */

/** Longest event line read back for its details; a longer one is not a line this product wrote. */
const DETAIL_LINE_MAX_BYTES = 256 * 1024;

/** Cap of the error text a hover shows in full. */
const DETAIL_ERROR_TEXT_MAX = 16 * 1024;

/**
 * The parts of a task's latest event that only a row on screen needs. Display-bound values
 * are flattened and capped as `UiTask` documents them.
 */
export interface TaskDetail {
  /** null when the transport does not report usage (session workers), or it is not known. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Failure text of a task that did not end `done`, ≤ 240 chars, else null. */
  error: string | null;
  /**
   * The error text as recorded, line breaks kept, cut to 16 KiB; `''` when there is none. NOT
   * display-safe: for a hover, which escapes it (`MarkdownString.appendText`). Never sent to
   * a page.
   */
  errorText: string;
  /** ≤ 300 chars. */
  promptPreview: string | null;
}

const NO_DETAIL: TaskDetail = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  error: null,
  errorText: '',
  promptPreview: null,
};

const taskDetails = new WeakMap<TaskRow, TaskDetail>();

function projectDetail(row: TaskRow, event: Record<string, unknown>): TaskDetail {
  // The session transport reports no usage (its `done` event carries literal zeros), so a
  // number here would be a made-up one: always null, and the page says "n/a".
  const usage = row.mode !== 'session';
  const failed = row.status !== 'running' && row.status !== 'done';
  const errorText = typeof event.error === 'string' ? event.error : '';
  return {
    inputTokens: usage ? amount(event.inputTokens) : null,
    outputTokens: usage ? amount(event.outputTokens) : null,
    costUsd: usage ? amount(event.costUsd) : null,
    error: failed ? displayOrNull(errorText, 240) : null,
    errorText:
      errorText.length > DETAIL_ERROR_TEXT_MAX
        ? Buffer.from(sliceOneLine(errorText, DETAIL_ERROR_TEXT_MAX), 'utf16le').toString('utf16le')
        : errorText,
    promptPreview: displayOrNull(event.promptPreview, 300),
  };
}

/**
 * Read the details of `rows` that are not yet known, opening the log once for all of them.
 *
 * Each is the task's latest event, read back from where the index found it. The read is
 * believed only when it is of the SAME log the index describes (the descriptor's device and
 * inode) and the line there is the same event (its id and timestamp): a log replaced or
 * cleared a moment ago yields no details, which every caller shows as absent values, and the
 * next look at the index — the file's stat has changed — brings rows the details can be read
 * for.
 *
 * ONLY AN ANSWER IS KEPT. A read that could not be made — the log would not open, it is not
 * the file the index read, the line is not where it was — leaves the row unknown, to be tried
 * again the next time it is asked for: a finished task gets no new row, so a failure
 * remembered for its row would be remembered for good. The cost of not remembering is one
 * open per call while the log stays unreadable.
 */
function loadDetails(rows: readonly TaskRow[]): void {
  const wanted: TaskRow[] = [];
  for (const row of rows) {
    if (taskDetails.has(row)) {
      continue;
    }
    if (row.len > DETAIL_LINE_MAX_BYTES) {
      // Longer than any line this product writes: never read back, and that is an answer.
      taskDetails.set(row, NO_DETAIL);
    } else {
      wanted.push(row);
    }
  }
  const cursor = taskLogCursor;
  if (wanted.length === 0 || cursor === undefined) {
    return;
  }
  let fd = -1;
  try {
    fd = fs.openSync(TASKS_LOG_FILE, LOG_READ_FLAGS);
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== cursor.dev || st.ino !== cursor.ino) {
      return;
    }
    const size = Number(st.size);
    for (const row of wanted) {
      if (row.len <= 0 || row.at + row.len > size) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(bytesAt(fd, row.at, row.len).toString('utf8'));
      } catch {
        continue; // not the line the index read
      }
      if (!isRecord(event) || event.id !== row.id) {
        continue;
      }
      // The same event: its id and its timestamp. A row with no time was read from a line
      // whose `ts` is not one (recordedTime), so of that line only the shape can be asked.
      if (row.lastTs === null ? epochMs(event.ts) !== null : event.ts === row.lastTs) {
        taskDetails.set(row, projectDetail(row, event));
      }
    }
  } catch {
    // the log could not be opened or read: nothing is known, and nothing is remembered
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — nothing to do
      }
    }
  }
}

/**
 * The details of one task (see TaskDetail), read from the log the first time they are asked
 * for and then kept for as long as the row is. Never throws; every value is absent when the
 * event could not be read back.
 */
export function taskDetail(row: TaskRow): TaskDetail {
  loadDetails([row]);
  return taskDetails.get(row) ?? NO_DETAIL;
}

/**
 * The file the host may open for a task id, or undefined.
 *
 * THIS IS A TRUST BOUNDARY. Through v1.x the page posted a PATH and the host opened it; the
 * path came from the task log, which any dispatched worker can append to. Now a surface can
 * only name a task, and the answer is the registry's (registry.resolveTaskFile): the report
 * the task's ID names — `<id>.md` in the tasks directory, for an id that can be a file name —
 * and only when a regular file is there. A symbolic link is refused. The `outputFile` an
 * event records is never consulted, let alone opened.
 */
export function resolveTaskOutput(id: unknown): string | undefined {
  return resolveTaskFile(id, 'output');
}

/**
 * Does the task have an output file on disk? Asked for at most TASK_LIST_MAX rows per build;
 * a hit is remembered for the life of the index (an output file is written once and kept), so
 * a rebuild with nothing changed re-checks only the rows that had none.
 */
function hasOutputFile(index: TaskIndex, row: TaskRow): boolean {
  if (index.outputSeen.has(row.id)) {
    return true;
  }
  if (resolveTaskFile(row.id, 'output') === undefined) {
    return false;
  }
  index.outputSeen.add(row.id);
  return true;
}

/* ------------------------------------------------------------------------- *
 * Accounts
 * ------------------------------------------------------------------------- */

const ACCOUNT_KEY_RE = /^[0-9a-f]{16}$/;

/** Registry workers past this count are not listed (a hand-grown registry, not a real one). */
const WORKERS_MAX = 200;

/**
 * Opaque, stable id of an account: the first 16 hex of sha256 over the RESOLVED config dir.
 * Derived from the directory because that — not the name — is an account's identity (names
 * are not unique: `main` is implicit and a worker may share its directory), and hashed so
 * the page never holds a path it could echo back as a target.
 */
export function accountKeyFor(configDir: string): AccountKey {
  const dir = typeof configDir === 'string' ? path.resolve(configDir) : '';
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

/**
 * One account as the HOST knows it. `name` and `configDir` are the registry's values
 * verbatim (they key registry operations and the credential store); `label` is the same
 * name made display-safe.
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export interface KnownAccount {
  key: AccountKey;
  name: string;
  label: string;
  configDir: string;
  isMain: boolean;
  isWorker: boolean;
  /** The agent CLI the account runs on. `main` is always Claude Code. */
  provider: ProviderId;
}

interface AccountIdentity extends KnownAccount {
  preferred: boolean;
  defaultModel: string | null;
  /** See `UiAccount.permissionMode`. */
  permissionMode: string | null;
}

/**
 * ONE list of accounts: `main` (the config dir this editor's own Claude session runs under)
 * first, then registry workers in registry order.
 *
 *  - A CLAUDE CODE worker whose directory IS the host directory is the same account, so it is
 *    merged into the main row (`isMain && isWorker`, carrying the worker's name and the
 *    registry's directory string) instead of being listed twice or dropped. A worker on
 *    another vendor's CLI is never merged: sharing a directory string does not make a Codex
 *    login the editor's Claude account.
 *  - A later worker naming a directory already listed is skipped: two rows with one key
 *    would make every page action ambiguous. For two Claude workers they are one login
 *    anyway; for workers of DIFFERENT providers the registry allows the pair, but the usage
 *    cache holds one reading per directory, so only its owner can be shown truthfully.
 *    The owner is decided as usage.listProviderAccounts decides it: a directory that is a
 *    CLAUDE CODE account's — main's, or any Claude worker's — is that account's WHEREVER the
 *    other vendor's worker sits in the list (the reading filed there is the Claude account's,
 *    and a Codex row drawn from it would show one account's plan usage as another's); among
 *    workers of other vendors the first one owns it.
 *  - An entry that is not an object, or whose name / directory is not a non-blank string,
 *    is not an account (`registry.json` is hand-editable).
 *
 * Per provider: an entry that names no provider is a Claude Code account, and the registry's
 * `workerProvider` is the one way to ask. An entry naming a provider this version does not
 * know is NOT here: the registry's reader keeps it out of `workers` altogether — read as a
 * Claude Code account, another vendor's home directory would be handed to `claude` — and it
 * is listed under `unsupportedAccounts` instead (see unsupportedAccounts). The default model
 * is read with the provider's rule, and for another vendor's worker `null` means what the
 * registry means by it: no default, the CLI chooses. The permission mode of a Claude worker
 * is the registry-wide one (Claude dispatches have no per-worker mode); another vendor's
 * worker has its own, read with `normalizeProviderPermissionMode`, where `null` is "pass no
 * flag".
 */
function accountIdentities(): AccountIdentity[] {
  const hostDir = hostConfigDir();
  const main: AccountIdentity = {
    key: accountKeyFor(hostDir),
    name: 'main',
    label: 'main',
    configDir: hostDir,
    isMain: true,
    isWorker: false,
    provider: 'claude',
    preferred: false,
    defaultModel: null,
    // Not a dispatch target until a worker is registered on it, so it has no mode to show.
    permissionMode: null,
  };
  const out: AccountIdentity[] = [main];
  const seen = new Set<string>([main.key]);
  const { registry } = registryRead();
  const workers = registry.workers;
  if (!Array.isArray(workers)) {
    return out;
  }
  const claudePermissionMode = normalizePermissionMode(registry.permissionMode);
  // First the entries that are accounts at all, each with the CLI it runs on and its key; then
  // the directories Claude Code accounts hold, which no other vendor's worker may be listed on.
  const listed: {
    entry: Record<string, unknown>;
    name: string;
    configDir: string;
    provider: ProviderId;
    key: AccountKey;
  }[] = [];
  for (const entry of workers.slice(0, WORKERS_MAX)) {
    if (!isRecord(entry)) {
      continue;
    }
    const { name, configDir } = entry;
    if (
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof configDir !== 'string' ||
      configDir.trim() === '' ||
      configDir.includes('\u0000')
    ) {
      continue;
    }
    let provider: ProviderId;
    try {
      provider = workerProvider(entry);
    } catch {
      // Unreachable for what the registry's reader returns; an entry whose provider is not one
      // is no account of any vendor, and is not guessed to be one.
      continue;
    }
    listed.push({ entry, name, configDir, provider, key: accountKeyFor(configDir) });
  }
  const claudeDirs = new Set<string>([main.key]);
  for (const { provider, key } of listed) {
    if (provider === 'claude') {
      claudeDirs.add(key);
    }
  }
  for (const { entry, name, configDir, provider, key } of listed) {
    const worker = {
      name,
      label: displayString(name, 64) || '-',
      configDir,
      isWorker: true,
      provider,
      preferred: entry.preferred === true,
      // Read through normalizeModel so a registry written by v1.x (dated tier ids) shows the
      // alias the dispatcher will actually use; an unreadable value is the default, as there.
      // A PINNED entry (`modelPinned: true`, a model a person chose by its id) is read exactly:
      // one of those ids is then the model itself, not its tier.
      // Its output is an alias or a `claude-…` id of a fixed lowercase alphabet, so it is
      // display-safe as it stands — and it is NOT cut: a shortened id is a different model.
      // Another vendor's id is one token of a fixed ASCII alphabet (normalizeProviderModel),
      // equally safe and equally uncut; there, no usable value means NO default.
      defaultModel:
        provider === 'claude'
          ? (normalizeModel(entry.model, { exact: entry.modelPinned === true }) ?? DEFAULT_WORKER_MODEL)
          : (normalizeProviderModel(provider, entry.model) ?? null),
      // Both branches yield a member of a fixed list of short ASCII words, or null.
      permissionMode:
        provider === 'claude'
          ? claudePermissionMode
          : normalizeProviderPermissionMode(provider, entry.permissionMode),
    };
    if (provider === 'claude' && !main.isWorker && sameConfigDir(configDir, hostDir)) {
      Object.assign(main, worker);
      continue;
    }
    if (seen.has(key) || (provider !== 'claude' && claudeDirs.has(key))) {
      continue;
    }
    seen.add(key);
    out.push({ key, isMain: false, ...worker });
  }
  return out;
}

/**
 * Every known account, main first. Fresh by stat on each call.
 *
 * Shared with team.ts (same owner); not part of the §6.1 surface.
 */
export function knownAccounts(): KnownAccount[] {
  return accountIdentities().map(({ key, name, label, configDir, isMain, isWorker, provider }) => ({
    key,
    name,
    label,
    configDir,
    isMain,
    isWorker,
    provider,
  }));
}

/**
 * The account behind a key the page posted, or undefined. Exact match against the CURRENT
 * account list only: a key of another shape, a key of a removed worker and a non-string all
 * resolve to nothing. `name` is the registry name (what `WorkerManager` takes) and
 * `configDir` the registry's string verbatim — never a value the page supplied. `provider`
 * is the CLI the account runs on, so the host can pick that provider's models, permission
 * modes and login command without a second registry lookup.
 */
export function resolveAccount(
  key: unknown,
):
  | { name: string; configDir: string; isMain: boolean; isWorker: boolean; provider: ProviderId }
  | undefined {
  if (typeof key !== 'string' || !ACCOUNT_KEY_RE.test(key)) {
    return undefined;
  }
  const hit = accountIdentities().find((a) => a.key === key);
  return hit === undefined
    ? undefined
    : {
        name: hit.name,
        configDir: hit.configDir,
        isMain: hit.isMain,
        isWorker: hit.isWorker,
        provider: hit.provider,
      };
}

/** Entries past this count are ignored (one per account / per workspace in a real file). */
const DIRECTORY_ENTRIES_MAX = 2000;

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A file keyed by DIRECTORY STRING (`usage.json` by config dir, `orchestrators.json` by
 * workspace), re-keyed once per change by the resolved path, so a lookup is one map read
 * however many keys the file holds. Each writer keys by the string it happened to hold, and
 * two spellings of one directory (a trailing slash, the host's own `CLAUDE_CONFIG_DIR` text)
 * are one directory everywhere else in this codebase (`sameConfigDir`). Entries that are not
 * objects and keys that are not absolute paths are not entries. `newer` breaks a collision.
 */
function indexDirectories(
  raw: Record<string, unknown>,
  newer: (candidate: Record<string, unknown>, held: Record<string, unknown>) => boolean,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const dir of Object.keys(raw).slice(0, DIRECTORY_ENTRIES_MAX)) {
    const entry = raw[dir];
    if (!isRecord(entry) || !path.isAbsolute(dir)) {
      continue;
    }
    const resolved = foldPath(path.resolve(dir));
    const held = out.get(resolved);
    if (held === undefined || newer(entry, held)) {
      out.set(resolved, entry);
    }
  }
  return out;
}

/** `usage.json`: when two spellings of one config dir are present, the newest reading wins. */
function indexUsage(raw: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return indexDirectories(raw, (a, b) => finiteOrZero(a.fetchedAt) >= finiteOrZero(b.fetchedAt));
}

/** `orchestrators.json`: the check-in most recently seen wins. */
function indexByDirectory(raw: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return indexDirectories(raw, (a, b) => finiteOrZero(a.lastSeen) >= finiteOrZero(b.lastSeen));
}

const WINDOW_KINDS = ['session', 'weekly_all', 'weekly_scoped'] as const;
const SEVERITIES = ['normal', 'warning', 'critical'] as const;

/** More windows than upstream has ever reported; bounds a hand-grown cache entry. */
const WINDOWS_MAX = 8;

function projectWindows(raw: unknown): UiUsageWindow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: UiUsageWindow[] = [];
  // The scan itself is bounded, not only the result: this runs per account on every build.
  for (const w of raw.slice(0, WINDOWS_MAX * 4)) {
    if (!isRecord(w)) {
      continue;
    }
    const kind = (WINDOW_KINDS as readonly unknown[]).includes(w.kind)
      ? (w.kind as UiUsageWindow['kind'])
      : 'other';
    const resetsAt = typeof w.resetsAt === 'string' ? epochMs(Date.parse(w.resetsAt)) : null;
    out.push({
      kind,
      label: displayString(w.label, 40) || '-',
      percent: clampPercent(w.percent),
      severity: (SEVERITIES as readonly unknown[]).includes(w.severity)
        ? (w.severity as UiUsageWindow['severity'])
        : 'normal',
      resetsAt,
    });
    if (out.length >= WINDOWS_MAX) {
      break;
    }
  }
  return out;
}

function projectOverage(raw: unknown): UiAccount['overage'] {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    enabled: raw.enabled === true,
    percent:
      typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? clampPercent(raw.percent) : null,
    spendLabel: displayOrNull(raw.spendLabel, 40),
  };
}

type UsageFields = Pick<
  UiAccount,
  | 'login'
  | 'loginDetail'
  | 'loginCheck'
  | 'plan'
  | 'windows'
  | 'windowsStaleSince'
  | 'lastGoodWindowsAt'
  | 'usageFetchedAt'
  | 'overage'
>;

/**
 * `loginDetail` for a reading that says the account's CLI could not be started. It always
 * begins with the stable prefix, so a surface can recognize the state without parsing prose.
 * The reading's own text is shown when it carries a detail (the status reader names the
 * executable itself); a bare prefix is completed here with the executable to install.
 */
function cliMissingDetail(provider: ProviderId, error: unknown): string | null {
  const stored = displayString(error, 200);
  return stored.length > PROVIDER_CLI_NOT_FOUND.length
    ? stored
    : `${PROVIDER_CLI_NOT_FOUND} — ${providerInfo(provider).cli} is not installed or not on PATH`;
}

/**
 * `loginDetail` of an account that is `expired` BECAUSE A RUN FAILED ON LOGIN and whose verdict
 * is still in force (usage.runLoginFailureAt) — uiTypes' marker, re-exported here for the
 * readers that have always taken it from this module (one literal, in uiTypes.ts).
 */
export { RUN_LOGIN_FAILURE_DETAIL };

/**
 * One cached usage reading → the account's login state and meters.
 *
 * The state ladder is the one every surface has always used, and "expired" is decided ONLY
 * by `isLoginExpired` — the single source of truth the dispatch server shares, biased so an
 * unproven expiry is never asserted.
 *
 * Two rungs differ for an account on another vendor's CLI, because its reading can say two
 * things a Claude reading cannot:
 *  - THE CLI IS MISSING (`isProviderCliMissing`) → `error`, with a `loginDetail` that names
 *    the executable instead of repeating a probe's raw text.
 *  - THE LOGIN IS UNKNOWN — a clean reading with no plan limits and no login verdict. For a
 *    Claude account that is the token / API-key login and reads `no-plan-limits`. Here it
 *    means the adapter could not tell whether anyone is signed in, and calling that "logged
 *    in" would be a guess: it is `error` with a detail that says exactly that. A reading that
 *    positively says "logged in" and carries no usage is `no-plan-limits`.
 * `refreshing` stays what it always was: no reading at all.
 *
 * `expired` carries a `loginDetail` in one case: the verdict was recorded because a RUN failed
 * on login and is still in force. The account is then shown logged out whatever its CLI's
 * status check says, and the detail (RUN_LOGIN_FAILURE_DETAIL) is how a surface can say why.
 */
function projectUsage(
  entry: Record<string, unknown> | undefined,
  provider: ProviderId,
  now: number,
  configDir?: string,
): UsageFields {
  const loginCheck = provider === 'claude' ? projectLoginCheck(entry, now, configDir) : null;
  if (entry === undefined) {
    return {
      login: 'refreshing',
      loginDetail: null,
      loginCheck,
      plan: null,
      windows: [],
      windowsStaleSince: null,
      lastGoodWindowsAt: null,
      usageFetchedAt: null,
      overage: null,
    };
  }
  let login: LoginState;
  let loginDetail: string | null = null;
  const reading = entry as unknown as AccountUsage;
  if (entry.error !== undefined) {
    login = 'error';
    loginDetail =
      provider !== 'claude' && isProviderCliMissing(reading)
        ? cliMissingDetail(provider, entry.error)
        : displayOrNull(entry.error, 200);
  } else if (provider === 'claude' && isLoginExpiredFor(reading, true, now)) {
    // Before the plan limits: a dispatch that failed on login makes the account `loggedOut`
    // whatever windows its last usage reading carried.
    login = 'expired';
  } else if (entry.available === true) {
    login = 'ok';
  } else if (provider === 'claude' && isLoginSuspectFor(reading, true, now)) {
    // The last word was "not logged in" and nobody here confirmed it (Login state (CA)): a check
    // is due or running, which is what `refreshing` means — never `expired` on such a reading.
    login = 'refreshing';
    loginDetail = displayOrNull(`login not confirmed — ${loginCheck?.reason ?? ''}`, 200);
  } else if (isLoginExpiredFor(reading, provider === 'claude', now)) {
    login = 'expired';
    if (runLoginFailureAt(reading, now) !== undefined) {
      loginDetail = RUN_LOGIN_FAILURE_DETAIL;
    }
  } else if (provider === 'claude' || parseAuth(entry.auth)?.loggedIn === true) {
    login = 'no-plan-limits';
  } else {
    login = 'error';
    loginDetail = displayOrNull(
      `login state unknown — ${providerInfo(provider).label} did not report whether this account is signed in`,
      200,
    );
  }
  // When a reading was taken: a time, or nothing (recordedTime) — the page prints an age from each.
  const lastGoodWindowsAt = recordedTime(entry.lastGoodWindowsAt, now);
  return {
    login,
    loginDetail,
    loginCheck,
    plan: displayOrNull(entry.subscriptionType, 24),
    windows: projectWindows(entry.windows),
    windowsStaleSince:
      entry.windowsStale === true ? (recordedTime(entry.windowsFetchedAt, now) ?? lastGoodWindowsAt) : null,
    lastGoodWindowsAt,
    usageFetchedAt: recordedTime(entry.fetchedAt, now),
    overage: projectOverage(entry.extraUsage),
  };
}

/** A Claude Code account's login state (usage.loginStateOf) as UiAccount.loginCheck carries it. */
function projectLoginCheck(entry: Record<string, unknown> | undefined, now: number, configDir: string | undefined): UiLoginCheck {
  const st = loginStateOf(entry as unknown as AccountUsage | undefined, now);
  const checking = entry === undefined && configDir !== undefined && isLoginCheckInFlight(configDir);
  return {
    state: checking ? 'checking' : st.state,
    since: recordedTime(st.since, now),
    checkedAt: recordedTime(st.checkedAt, now),
    reason: displayString(st.reason, 200),
  };
}

function emptyTokenStats(): UiTokenStats {
  return { tasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addDone(into: UiTokenStats, done: DoneEvents, i: number): void {
  into.tasks += 1;
  into.inputTokens += done.inputTokens[i];
  into.outputTokens += done.outputTokens[i];
  into.costUsd += done.costUsd[i];
}

/**
 * 5-hour and 7-day dispatch totals per RAW worker name: `done` events only, exact name —
 * the rule of registry.windowUsage, computed for every worker in one pass over the cached
 * events instead of two whole-log reads per worker. The windows slide with `now`, so the
 * sums are per build; only the events are cached.
 */
function windowTotals(
  done: DoneEvents,
  now: number,
): Map<string, { session5h: UiTokenStats; week: UiTokenStats }> {
  const out = new Map<string, { session5h: UiTokenStats; week: UiTokenStats }>();
  const weekStart = now - WEEK_MS;
  const sessionStart = now - FIVE_HOURS_MS;
  // `done` is ascending: binary-search the first event inside the week, walk the tail.
  let lo = 0;
  let hi = done.ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (done.ts[mid] < weekStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  for (let i = lo; i < done.ts.length; i++) {
    const worker = done.worker[i];
    let totals = out.get(worker);
    if (totals === undefined) {
      totals = { session5h: emptyTokenStats(), week: emptyTokenStats() };
      out.set(worker, totals);
    }
    addDone(totals.week, done, i);
    if (done.ts[i] >= sessionStart) {
      addDone(totals.session5h, done, i);
    }
  }
  return out;
}

/**
 * The 5-hour and 7-day dispatch totals of ONE account, by exact name — what the Workers tree
 * shows under an account, from the same events and by the same rule as the dashboard's card
 * for it. `problem` is taskLogProblem: while it is set the totals are zero because the log
 * could not be read, not because nothing was dispatched, and the caller must say which.
 */
export function dispatchWindows(
  worker: string,
  now: number = Date.now(),
): { session5h: UiTokenStats; week: UiTokenStats; problem: string | null } {
  const index = taskIndex();
  const totals = typeof worker === 'string' ? windowTotals(index.done, now).get(worker) : undefined;
  return {
    session5h: totals?.session5h ?? emptyTokenStats(),
    week: totals?.week ?? emptyTokenStats(),
    problem: index.problem,
  };
}

/** Entries of the registry this version cannot use that the page is told about. */
const UNSUPPORTED_ACCOUNTS_MAX = 20;

/**
 * WHY a registry entry cannot be used, in the few words every surface gives:
 * `unknown provider "<as the registry reader shows it>"`, `incomplete entry` or `duplicate
 * name`. The dispatch server words the same three reasons in
 * mcp/task-runner.unsupportedWorkerReason, and the two must read alike — a person meets one in
 * the editor and the other in a dispatch refusal. It is spelled here rather than imported
 * because that module is the dispatch core, which the extension host otherwise never loads.
 */
export function unsupportedEntryDetail(entry: Pick<UnsupportedWorkerEntry, 'reason' | 'providerText'>): string {
  return entry.reason === 'provider'
    ? `unknown provider "${sliceOneLine(flattenOneLine(entry.providerText), 80)}"`
    : entry.reason === 'duplicate-name'
      ? 'duplicate name'
      : 'incomplete entry';
}

/**
 * The registry entries this version cannot use (registry.UnsupportedWorkerEntry), as the page
 * is told about them: a display-safe name — `''` for an entry that has none — and why. They
 * are in no other part of the model: not an account, not counted, not a target of any action.
 * Each entry is read by `typeof`, like everything else that comes out of the registry file.
 */
function unsupportedAccounts(): UiUnsupportedAccount[] {
  const entries = registryRead().registry.unsupportedWorkers;
  if (!Array.isArray(entries)) {
    return [];
  }
  const out: UiUnsupportedAccount[] = [];
  for (const entry of entries.slice(0, UNSUPPORTED_ACCOUNTS_MAX)) {
    if (!isRecord(entry)) {
      continue;
    }
    const reason = entry.reason === 'provider' || entry.reason === 'duplicate-name' ? entry.reason : 'shape';
    out.push({
      name: displayString(entry.name, 64),
      detail: displayString(
        unsupportedEntryDetail({
          reason,
          providerText: typeof entry.providerText === 'string' ? entry.providerText : '',
        }),
        80,
      ),
    });
  }
  return out;
}

/** A finished task that reported what it ran, as `ranAs.ranAsOf` is asked about it. */
interface RanTask {
  /** Where in the log the task's final event stands: file order is what "newest" means. */
  at: number;
  facts: FinalTaskFacts;
}

interface RanAsIndex {
  generation: number;
  /** RAW worker name → that worker's candidates, the newest final event first. */
  byWorker: Map<string, RanTask[]>;
}

let ranAsKept: RanAsIndex | undefined;

/**
 * The tasks `ranAs.ranAsOf` can say anything about — FINAL event `done`, with a reported model —
 * per account name, newest final event first (file order: the log is append-only, and a line
 * with a wrong clock in it must not outrank the newest one).
 *
 * Of the tasks that would be told apart by nothing the rule reads — the same account, the same
 * final ask — only the newest is kept: for any account the rule answers all of them alike, and
 * the newest is the one that would be taken. So the list holds one entry per distinct
 * (account, model, CLI, source), not one per task. Built in one pass over the index and kept
 * until the log changes.
 */
function ranAsIndex(index: TaskIndex): RanAsIndex {
  if (ranAsKept !== undefined && ranAsKept.generation === index.generation) {
    return ranAsKept;
  }
  const newest = new Map<string, Map<FinalAsk, TaskRow>>();
  for (const row of index.sorted) {
    if (row.status !== 'done' || row.modelUsed === null || row.workerName === undefined) {
      continue;
    }
    let own = newest.get(row.workerName);
    if (own === undefined) {
      own = new Map();
      newest.set(row.workerName, own);
    }
    const held = own.get(row.asked);
    if (held === undefined || row.at > held.at) {
      own.set(row.asked, row);
    }
  }
  const byWorker = new Map<string, RanTask[]>();
  for (const [worker, rows] of newest) {
    byWorker.set(
      worker,
      [...rows.values()]
        .sort((x, y) => y.at - x.at)
        .map((row) => ({
          at: row.at,
          // Every field is the FINAL event's. `provider`: a value `storedProvider` reads as
          // the row's own answer — the id itself, or (for a CLI this build does not know)
          // something that is no provider at all.
          facts: {
            status: 'done',
            worker: row.workerName,
            provider: row.asked.provider === null ? false : row.asked.provider === 'claude' ? undefined : row.asked.provider,
            model: row.asked.model,
            modelSource: row.asked.source,
            modelUsed: row.modelUsed,
          },
        })),
    );
  }
  ranAsKept = { generation: index.generation, byWorker };
  return ranAsKept;
}

/** The first answer of the one rule, asked of `tasks` from the newest final event backwards. */
function firstRanAs(tasks: readonly RanTask[] | undefined, account: RanAsAccount): RanTask | undefined {
  if (tasks === undefined) {
    return undefined;
  }
  for (const task of tasks) {
    if (ranAsOf(task.facts, account) !== undefined) {
      return task;
    }
  }
  return undefined;
}

/** What `account`'s default last ran as, by `ranAs.ranAsOf` — or null when no task says. */
function ranAsFor(ran: RanAsIndex, account: RanAsAccount): string | null {
  const task = firstRanAs(ran.byWorker.get(account.name), account);
  return task === undefined ? null : (ranAsOf(task.facts, account) ?? null);
}

/**
 * The model id the CLI of the account named `worker` REPORTED for its newest finished task
 * that ran `model` there — the one rule, `ranAs.ranAsOf`, asked as if `model` were the
 * account's default (an alias or an id; `null`: no default, the CLI's own choice). Null when
 * no task says. Exact account name AND the CLI the account runs on (`provider`): a name that
 * is reused by an account on another CLI inherits nothing. With an unchanged log this is a
 * `stat` and a walk over a handful of entries.
 *
 * Shared with views.ts and the model pickers (same owner); not part of the §6.1 surface.
 */
export function modelLastRanAs(worker: string, provider: ProviderId, model: string | null | undefined): string | null {
  if (typeof worker !== 'string') {
    return null;
  }
  return ranAsFor(ranAsIndex(taskIndex()), { name: worker, provider, defaultModel: model ?? null });
}

/**
 * The same over every account's Claude Code tasks on this machine: what a Claude Code alias
 * last resolved to here. For an account that has no task of its own yet — every Claude Code
 * account runs the one `claude` command, and an alias is resolved by it. Each account is
 * asked by the one rule; the newest answer among them is given.
 */
export function claudeModelLastRanAs(model: string): string | null {
  let best: RanTask | undefined;
  for (const [worker, tasks] of ranAsIndex(taskIndex()).byWorker) {
    const task = firstRanAs(tasks, { name: worker, provider: 'claude', defaultModel: model });
    if (task !== undefined && (best === undefined || task.at > best.at)) {
      best = task;
    }
  }
  return best === undefined ? null : (best.facts.modelUsed as string);
}

/** Most names a card says it shares its claude.ai account with. */
const SAME_ACCOUNT_NAMES_MAX = 8;

/**
 * For each Claude Code account (the hosting session's own included) the OTHER accounts shown
 * here that are signed in to the same claude.ai account — the same `accountKey` in their usage
 * readings — by display name, in list order. One plan's limits are then drawn on by all of
 * them; nothing else about them changes (dispatch does not read this). An account with no key
 * is the same as nobody.
 */
function sameClaudeAccounts(
  accounts: readonly AccountIdentity[],
  usage: ReadonlyMap<string, unknown>,
): Map<AccountKey, string[]> {
  const byKey = new Map<string, AccountIdentity[]>();
  for (const account of accounts) {
    if (account.provider !== 'claude') {
      continue;
    }
    const key = accountKeyOf(usage.get(foldPath(path.resolve(account.configDir))));
    if (key === undefined) {
      continue;
    }
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, [account]);
    } else {
      group.push(account);
    }
  }
  const out = new Map<AccountKey, string[]>();
  for (const group of byKey.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const account of group) {
      out.set(
        account.key,
        group.filter((other) => other !== account).map((other) => other.label).slice(0, SAME_ACCOUNT_NAMES_MAX),
      );
    }
  }
  return out;
}

/**
 * The accounts at `now`. `cooldownOf` (the dispatch server's, for list_workers' snapshot only) is
 * a cooldown end in epoch ms by REGISTRY NAME that stats.json may not hold — one the server could
 * not write there and keeps in memory (task-runner.workerCooldownUntil); the later of the two is
 * shown, so the snapshot says what the server's text and its selection act on. The dashboard
 * passes none: another process's memory is not its to know.
 */
function buildAccounts(index: TaskIndex, now: number, cooldownOf?: (worker: string) => number): UiAccount[] {
  // A registry that could not be read holds accounts this module cannot see. Listing the
  // hosting account alone would read as "you have no workers"; the page is given no accounts
  // and `health.registryProblem`, and says the registry is unreadable.
  if (registryRead().problem !== null) {
    return [];
  }
  const stats = statsCache.get();
  const usage = usageCache.get();
  const totals = windowTotals(index.done, now);
  const ranAs = ranAsIndex(index);
  const accounts = accountIdentities();
  const sameAs = sameClaudeAccounts(accounts, usage);
  return accounts.map((account): UiAccount => {
    // Name-keyed facts exist only for a REGISTERED worker. The implicit main row is named
    // "main" by us, and must not pick up the stats of a worker somebody else named "main".
    const entry = account.isWorker ? own(stats, account.name) : undefined;
    const s = isRecord(entry) ? entry : {};
    const windows = account.isWorker ? totals.get(account.name) : undefined;
    const cooldownUntil = Math.max(
      epochMs(s.cooldownUntil) ?? 0,
      account.isWorker && cooldownOf !== undefined ? (epochMs(cooldownOf(account.name)) ?? 0) : 0,
    );
    return {
      key: account.key,
      name: account.label,
      isMain: account.isMain,
      isWorker: account.isWorker,
      preferred: account.preferred,
      defaultModel: account.defaultModel,
      provider: account.provider,
      providerLabel: displayString(providerInfo(account.provider).label, 32) || '-',
      sessionWorkers: providerInfo(account.provider).sessionWorkers,
      permissionMode: displayOrNull(account.permissionMode, 32),
      // Name-keyed, like the totals: only a registered worker has tasks of its own.
      modelRanAs: account.isWorker
        ? ranAsFor(ranAs, { name: account.name, provider: account.provider, defaultModel: account.defaultModel })
        : null,
      ...projectUsage(usage.get(foldPath(path.resolve(account.configDir))), account.provider, now, account.configDir),
      sameAccountAs: sameAs.get(account.key) ?? [],
      planLabel:
        account.provider === 'claude'
          ? displayOrNull(planLabelOf(usage.get(foldPath(path.resolve(account.configDir)))), 40)
          : null,
      cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
      session5h: windows?.session5h ?? emptyTokenStats(),
      week: windows?.week ?? emptyTokenStats(),
      allTime: {
        tasks: amount(s.tasks) ?? 0,
        inputTokens: amount(s.inputTokens) ?? 0,
        outputTokens: amount(s.outputTokens) ?? 0,
        costUsd: amount(s.costUsd) ?? 0,
        errors: amount(s.errors) ?? 0,
      },
      lastError: displayOrNull(s.lastError, 200),
      running: account.isWorker ? (index.runningByWorker.get(account.name) ?? 0) : 0,
    };
  });
}

/**
 * The accounts and the unusable registry entries as `DashboardModel.accounts` and
 * `DashboardModel.unsupportedAccounts` hold them at `now` — the same builders, from the same
 * cached readings — for a surface that is not the dashboard: the dispatch server's
 * `list_workers` answers them as `WorkersSnapshot` (host-protocol.ts), so the text, the
 * dashboard and another front end never disagree about one account at one moment.
 *
 * Two differences from the dashboard, both the snapshot's contract (host-protocol, list_workers'
 * RULES): `cooldownOf` adds the cooldowns the dispatch server holds in memory because it could not
 * write them to stats.json (see buildAccounts) — its text and its selection already act on them;
 * and the accounts are cut to the snapshot's caps (capSnapshotAccounts), which a registry within
 * this module's own limits meets except in the number of accounts (`main` + WORKERS_MAX workers).
 *
 * `undefined` when there is no truthful answer: the registry could not be read (buildAccounts
 * would give `[]`, which reads as "no workers"), or the build failed — a defect, which the
 * dashboard's own fallback also answers with no accounts rather than a partial list. Never
 * throws.
 */
export function buildAccountsSnapshot(
  now: number = Date.now(),
  cooldownOf?: (worker: string) => number,
): { accounts: UiAccount[]; unsupportedAccounts: UiUnsupportedAccount[] } | undefined {
  try {
    if (registryRead().problem !== null) {
      return undefined;
    }
    return {
      accounts: capSnapshotAccounts(buildAccounts(taskIndex(), now, cooldownOf)),
      unsupportedAccounts: unsupportedAccounts(),
    };
  } catch {
    return undefined;
  }
}

/** The snapshot's caps beyond UiAccount's own (host-protocol, "Answers to a front end's questions"). */
const SNAPSHOT_KEY_MAX = 128;
const SNAPSHOT_SPEND_LABEL_MAX = 40;
const SNAPSHOT_SAME_ACCOUNT_NAME_MAX = 64;
const SNAPSHOT_SAME_ACCOUNT_NAMES_MAX = 8;
const SNAPSHOT_WINDOWS_MAX = 8;
const SNAPSHOT_ACCOUNTS_MAX = 200;

/**
 * `accounts` within list_workers' snapshot caps, cut in the contract's order: each `key` to 128
 * characters, `overage.spendLabel` to 40, each `sameAccountAs` name to 64 and the list to 8 names,
 * `windows` to 8, then the list to 200 accounts (the first ones — `main` first, as listed). A
 * value already within its cap is the same value; nothing is reordered, and an account is never
 * dropped for a long field. Strings are cut on a code-point boundary (sliceOneLine), never
 * flattened again: they already were. Pure and total for what buildAccounts returns.
 *
 * Exported for the offline checks, which hand it values no registry can produce (a 16-hex key is
 * never long; the builder's own caps already hold the rest).
 */
export function capSnapshotAccounts(accounts: readonly UiAccount[]): UiAccount[] {
  const cut = (text: string, max: number): string => (text.length > max ? sliceOneLine(text, max) : text);
  return accounts.slice(0, SNAPSHOT_ACCOUNTS_MAX).map((account) => ({
    ...account,
    key: cut(account.key, SNAPSHOT_KEY_MAX),
    overage:
      account.overage === null
        ? null
        : {
            ...account.overage,
            spendLabel:
              account.overage.spendLabel === null ? null : cut(account.overage.spendLabel, SNAPSHOT_SPEND_LABEL_MAX),
          },
    sameAccountAs: account.sameAccountAs
      .slice(0, SNAPSHOT_SAME_ACCOUNT_NAMES_MAX)
      .map((name) => cut(name, SNAPSHOT_SAME_ACCOUNT_NAME_MAX)),
    windows: account.windows.slice(0, SNAPSHOT_WINDOWS_MAX),
  }));
}

/**
 * Every account's login state at `now` as the snapshot shows it — `login` and `loginDetail` by
 * account key, from the same reading and the same projection as buildAccounts (projectUsage) —
 * as one string that changes exactly when one of them does. Part of the dispatch server's
 * generation of its list_workers observer cache (host-protocol: "a login change" invalidates
 * it): a stat of the usage cache and of the registry when nothing changed. A run's login verdict
 * that lapses with time (runLoginFailureAt) is a change at `now` too.
 *
 * Never throws: a build that fails answers a string no other call answers, so the cache is never
 * believed on a reading this function could not make.
 */
export function accountsLoginSignature(now: number = Date.now()): string {
  try {
    const { problem } = registryRead();
    if (problem !== null) {
      return `registry-problem\u0000${problem}`;
    }
    const usage = usageCache.get();
    return accountIdentities()
      .map((account) => {
        const shown = projectUsage(usage.get(foldPath(path.resolve(account.configDir))), account.provider, now, account.configDir);
        return `${account.key}\u0000${account.provider}\u0000${shown.login}\u0000${shown.loginDetail ?? ''}\u0000${shown.loginCheck?.state ?? ''}`;
      })
      .join('\n');
  } catch {
    return `failed\u0000${now}\u0000${Math.random()}`;
  }
}

/* ------------------------------------------------------------------------- *
 * Settings — validation of what the page posts, projection of what it is shown
 * ------------------------------------------------------------------------- */

const CLAUDE_PATH_MAX = 1024;

/** NUL and every character a shell, a terminal or a config file reads as a line break. */
const PATH_FORBIDDEN = /[\u0000\n\r\u2028\u2029]/;

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate one `setSetting` from the page: VALUE SEMANTICS, not shape, and never a coercion.
 *
 * The page sends real numbers and booleans, so `"5"` for a minutes setting is not "close
 * enough" — it is a value this function was not sent by our page, and it is rejected rather
 * than converted. Ranges are the ones `package.json` declares. An unknown key is a refusal,
 * never a write. Error text is ours plus, for an unknown key, that key made display-safe.
 *
 * `claudePath` is returned TRIMMED: surrounding whitespace is never part of a command, and
 * `' claude'` resolves nowhere. Line breaks and NUL are checked on the raw value first, so a
 * trailing newline is refused instead of being trimmed into acceptance. What is left must be
 * a bare command name or an absolute path, with no control character in it: a relative path
 * names a different file for the dispatch server, the extension host and a terminal, and the
 * value is typed into a terminal line.
 */
export function validateSetting(
  key: unknown,
  value: unknown,
):
  | { ok: true; key: UiSettingKey; value: string | number | boolean }
  | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (typeof key !== 'string') {
    return fail('unknown setting');
  }
  switch (key) {
    case 'workerPermissionMode':
      return typeof value === 'string' && (WORKER_PERMISSION_MODES as readonly string[]).includes(value)
        ? { ok: true, key, value }
        : fail(`workerPermissionMode must be one of: ${WORKER_PERMISSION_MODES.join(', ')}`);
    case 'claudePath': {
      if (typeof value !== 'string' || PATH_FORBIDDEN.test(value)) {
        return fail('claudePath must be a single line of text');
      }
      const trimmed = value.trim();
      if (trimmed.length < 1 || trimmed.length > CLAUDE_PATH_MAX) {
        return fail(`claudePath must be 1 to ${CLAUDE_PATH_MAX} characters`);
      }
      // The one rule for what this setting may hold (platform.isAcceptableClaudePath), shared
      // with the settings reader of the host: a value refused there must not be storable here.
      return isAcceptableClaudePath(trimmed)
        ? { ok: true, key, value: trimmed }
        : fail('claudePath must be a command name or an absolute path');
    }
    case 'quotaCooldownMinutes':
      return integerIn(value, 1, 1440)
        ? { ok: true, key, value }
        : fail('quotaCooldownMinutes must be a whole number from 1 to 1440');
    case 'workerTimeoutMinutes':
      return integerIn(value, 1, 480)
        ? { ok: true, key, value }
        : fail('workerTimeoutMinutes must be a whole number from 1 to 480');
    case 'frontierWorkerDispatch':
    case 'overageWorkerDispatch':
      return value === 'block' || value === 'allow'
        ? { ok: true, key, value }
        : fail(`${key} must be "block" or "allow"`);
    case 'meshMode':
    case 'sessionKeepalive':
    case 'providerUsagePolling':
      return typeof value === 'boolean' ? { ok: true, key, value } : fail(`${key} must be true or false`);
    case 'meshMaxLiveWorkers':
      return integerIn(value, 1, 64)
        ? { ok: true, key, value }
        : fail('meshMaxLiveWorkers must be a whole number from 1 to 64');
    case 'meshHistoryLimit':
      return integerIn(value, 1, 1000)
        ? { ok: true, key, value }
        : fail('meshHistoryLimit must be a whole number from 1 to 1000');
    default:
      return fail(`unknown setting "${displayString(key, 40)}"`);
  }
}

function stringList(raw: unknown, max: number, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }
  const out: string[] = [];
  for (const item of raw.slice(0, 32)) {
    const text = displayString(item, max);
    if (text !== '' && !out.includes(text)) {
      out.push(text);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

function projectGuard(raw: unknown): UiGuardSetting {
  const g = isRecord(raw) ? raw : {};
  // Anything that is not exactly 'allow' reads as the safe 'block' — the registry's own rule
  // for both billing guards.
  return {
    value: g.value === 'allow' ? 'allow' : 'block',
    effective: g.effective === 'allow' ? 'allow' : 'block',
    setBy: displayOrNull(g.setBy, 64),
  };
}

/** Models listed per provider on the page (it shows no more in a card menu). */
const PROVIDER_MODELS_SHOWN_MAX = 24;

/**
 * The models a provider's menu offers: the provider's OWN models from the list its CLI gave
 * the last time a model picker asked (usage.freshProviderModels — memory only, so building a
 * model never starts a process), while that answer is fresh; otherwise the built-in
 * suggestions. Another vendor's models that the CLI resells are left to the picker, which has
 * room to say what choosing one means; a stored default of that kind is still shown on the
 * account as its current value. Claude Code's are its tier aliases always. Each id is one the
 * registry stores as it stands.
 */
function offeredModels(id: ProviderId, suggested: readonly string[]): string[] {
  if (id === 'claude') {
    return [...suggested];
  }
  const catalog = attempt(() => freshProviderModels(id), undefined);
  const own = catalog === undefined ? [] : catalog.models.filter((model) => model.resold !== true);
  return own.length === 0 ? [...suggested] : own.slice(0, PROVIDER_MODELS_SHOWN_MAX).map((model) => model.id);
}

/**
 * Every provider a worker can run on, with what its pickers offer. Built from `providers.ts`
 * and the model catalogs this process holds — never from the caller's input — so the page can
 * only ever offer a model list or a permission mode the host itself would accept back.
 */
function projectProviders(): UiProvider[] {
  return allProviders().map((info) => ({
    id: info.id,
    label: displayString(info.label, 32) || '-',
    models: offeredModels(info.id, info.suggestedModels),
    permissionModes: [...info.permissionModes],
    isolation: info.isolation,
    isolationVerified: info.isolationVerified,
    sessionWorkers: info.sessionWorkers,
  }));
}

/**
 * The caller reads settings from the editor's configuration, where a hand-edited
 * `settings.json` can hold anything. They cross into the webview through the same projection
 * as everything else, using the registry's OWN readers for the numbers, so what the page
 * shows is the value the dispatcher will enforce.
 */
function projectSettings(raw: unknown): UiSettings {
  const s = isRecord(raw) ? raw : {};
  const cooldown = s.quotaCooldownMinutes;
  return {
    workerPermissionMode: normalizePermissionMode(s.workerPermissionMode),
    permissionModes: stringList(s.permissionModes, 40, WORKER_PERMISSION_MODES),
    claudePath: displayString(s.claudePath, CLAUDE_PATH_MAX),
    quotaCooldownMinutes:
      typeof cooldown === 'number' && Number.isFinite(cooldown)
        ? Math.min(1440, Math.max(1, Math.round(cooldown)))
        : 30,
    workerTimeoutMinutes: clampTimeoutMinutes(s.workerTimeoutMinutes),
    frontierWorkerDispatch: projectGuard(s.frontierWorkerDispatch),
    overageWorkerDispatch: projectGuard(s.overageWorkerDispatch),
    meshMode: s.meshMode === true,
    meshMaxLiveWorkers: sanitizeMeshMaxLive(s.meshMaxLiveWorkers),
    meshHistoryLimit: sanitizeMeshHistoryLimit(s.meshHistoryLimit),
    sessionKeepalive: s.sessionKeepalive === true,
    workerModels: stringList(s.workerModels, 64, WORKER_MODELS),
    // On by default (`package.json`): only an explicit `false` reads as off, which is also
    // how usage.refreshProviderUsage reads the same setting.
    providerUsagePolling: s.providerUsagePolling !== false,
    providers: projectProviders(),
  };
}

function triState(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function projectHealth(
  raw: unknown,
  hasWorkspace: boolean,
  logProblem: string | null,
  registryProblem: string | null,
): UiHealth {
  const h = isRecord(raw) ? raw : {};
  return {
    claudeVersion: displayOrNull(h.claudeVersion, 40),
    sessionWorkersSupported: triState(h.sessionWorkersSupported),
    sessionWorkersMinVersion:
      displayString(h.sessionWorkersMinVersion, 24) || MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
    // This module owns the field: only it reads the log. A caller's own note survives when
    // the log itself is fine.
    taskLogProblem: logProblem ?? displayOrNull(h.taskLogProblem, 120),
    mcpInstalled: hasWorkspace ? triState(h.mcpInstalled) : null,
    policyInstalled: hasWorkspace ? triState(h.policyInstalled) : null,
    // Only a block that is there can be out of date.
    policyOutdated: hasWorkspace && h.policyInstalled === true ? triState(h.policyOutdated) : null,
    teamAgentInstalled: hasWorkspace ? triState(h.teamAgentInstalled) : null,
    canDispatch: hasWorkspace ? triState(h.canDispatch) : null,
    // Two values only; anything else is the command that runs everywhere cco does.
    dispatchFix: h.dispatchFix === 'installMcp' ? 'installMcp' : 'updateWorkspaceSetup',
    // Owned here as well, and never taken from the caller: it is what the registry's own
    // reader said about the file, or null.
    registryProblem,
  };
}

/* ------------------------------------------------------------------------- *
 * Sessions — re-projected on the way through
 * ------------------------------------------------------------------------- */

const SESSION_SOURCES: readonly UiSessionSource[] = ['worker', 'teammate', 'peer'];
const SESSION_STATUSES: readonly UiSessionStatus[] = ['busy', 'waiting', 'idle', 'stopped', 'unknown'];
const SESSION_KINDS: readonly UiSession['kind'][] = ['background', 'interactive', 'teammate'];
const SESSION_KEY_MAX = 160;
const SESSIONS_MAX = 500;

/** A label that could be echoed back as a filesystem target is not a label. */
function relativeLabel(raw: unknown, max: number): string | null {
  const text = displayString(raw, max);
  return text === '' || path.posix.isAbsolute(text) || path.win32.isAbsolute(text) ? null : text;
}

/**
 * Session rows come from `team.ts`, which already produces safe values. They are projected
 * again here because THIS function is what the webview's model is made by: a row assembled
 * by hand in some caller must not be the one place a raw string crosses. A row whose key or
 * source is unusable is dropped — the key is the only handle the page can send back, and a
 * key that had to be altered to be displayed would no longer resolve.
 */
function projectSessions(raw: unknown): UiSession[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: UiSession[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const { key, source } = item;
    if (
      typeof key !== 'string' ||
      key === '' ||
      key.length > SESSION_KEY_MAX ||
      displayString(key, SESSION_KEY_MAX) !== key ||
      seen.has(key) ||
      !(SESSION_SOURCES as readonly unknown[]).includes(source)
    ) {
      continue;
    }
    seen.add(key);
    out.push({
      key,
      source: source as UiSessionSource,
      name: displayString(item.name, 80) || '-',
      accountKey:
        typeof item.accountKey === 'string' && ACCOUNT_KEY_RE.test(item.accountKey) ? item.accountKey : null,
      accountName: displayString(item.accountName, 64) || '-',
      kind: (SESSION_KINDS as readonly unknown[]).includes(item.kind)
        ? (item.kind as UiSession['kind'])
        : source === 'teammate'
          ? 'teammate'
          : 'interactive',
      status: (SESSION_STATUSES as readonly unknown[]).includes(item.status)
        ? (item.status as UiSessionStatus)
        : 'unknown',
      detail: displayOrNull(item.detail, 160),
      taskId: typeof item.taskId === 'string' && TASK_ID_RE.test(item.taskId) ? item.taskId : null,
      taskTitle: displayOrNull(item.taskTitle, 160),
      model: displayOrNull(item.model, 64),
      startedAt: epochMs(item.startedAt),
      updatedAt: epochMs(item.updatedAt),
      location: relativeLabel(item.location, 120),
      branch: displayOrNull(item.branch, 120),
      unmerged: item.unmerged === true,
      settled: item.settled === true,
      inWorkspace: item.inWorkspace === true,
      canAttach: item.canAttach === true,
      canStop: item.canStop === true,
      team: displayOrNull(item.team, 64),
      role: displayOrNull(item.role, 64),
    });
    if (out.length >= SESSIONS_MAX) {
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * The model
 * ------------------------------------------------------------------------- */

export interface ModelInputs {
  workspaceRoot: string | undefined;
  scope: 'workspace' | 'all';
  /** Read from the editor configuration by the caller. */
  settings: UiSettings;
  /** Assembled by the caller (see probeClaudeVersion); `taskLogProblem` is set here. */
  health: UiHealth;
  /** From `team.collectSessions`. */
  sessions: UiSession[];
  now?: number;
}

/** The 14 local days ending today, as 15 boundaries: each day's midnight, then tomorrow's. */
function dayBoundaries(now: number): number[] {
  const today = new Date(now);
  const out: number[] = [];
  // Built from calendar fields, not by subtracting 24 h: a day is 23 or 25 hours long twice
  // a year, and a bucket must start at LOCAL midnight on both sides of that.
  for (let back = DAILY_BUCKETS - 1; back >= -1; back--) {
    out.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime());
  }
  return out;
}

function emptyDaily(bounds: number[]): UiDailyBucket[] {
  return bounds.slice(0, DAILY_BUCKETS).map((day) => ({ day, done: 0, failed: 0, cancelled: 0 }));
}

function countDaily(daily: UiDailyBucket[], bounds: number[], row: TaskRow): void {
  // A task with no time ended on no day.
  const at = row.lastTs;
  if (row.status === 'running' || at === null || at < bounds[0] || at >= bounds[DAILY_BUCKETS]) {
    return;
  }
  let i = DAILY_BUCKETS - 1;
  while (i > 0 && at < bounds[i]) {
    i--;
  }
  if (row.status === 'done') {
    daily[i].done += 1;
  } else if (row.status === 'cancelled') {
    daily[i].cancelled += 1;
  } else {
    // failed and orphaned: both are dispatches that did not deliver.
    daily[i].failed += 1;
  }
}

/**
 * The briefing check-in of the main session in this workspace, or null when there is none.
 * The file is keyed by the dispatch server's own `process.cwd()`; it is matched as a
 * directory, not as a string (see indexDirectories).
 */
function projectOrchestrator(root: string | undefined, now: number): UiOrchestrator | null {
  const entry = root === undefined ? undefined : orchestratorsCache.get().get(foldPath(root));
  if (entry === undefined) {
    return null;
  }
  // `model: ''` is how a session that was seen but never briefed is recorded.
  const model = displayOrNull(entry.model, 64);
  return {
    model,
    calibrated: model !== null && !isFrontierModel(model),
    briefedAt: model !== null ? recordedTime(entry.ts, now) : null,
    lastSeenAt: recordedTime(entry.lastSeen, now),
  };
}

function toUiTask(
  index: TaskIndex,
  row: TaskRow,
  inWorkspace: boolean,
  worktrees: Map<string, { branch: string | null; unmerged: boolean }>,
): UiTask {
  // Branch and "unmerged" come from the session rows the caller collected for this same
  // scope: team.ts already read the ledger and checked the worktree on disk, and a second
  // reader of both here would be one more thing to keep in agreement with it.
  const worktree = row.mode === 'session' ? worktrees.get(row.id) : undefined;
  const detail = taskDetails.get(row) ?? NO_DETAIL;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    mode: row.mode,
    worker: row.worker,
    model: row.model,
    startedAt: row.startedAt,
    endedAt: row.status === 'running' ? null : row.lastTs,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    costUsd: detail.costUsd,
    error: detail.error,
    promptPreview: detail.promptPreview,
    inWorkspace,
    hasOutput: hasOutputFile(index, row),
    sessionWorker: row.sessionWorker,
    branch: worktree?.branch ?? null,
    unmerged: worktree?.unmerged ?? false,
    provider: row.provider,
    modelUsed: row.modelUsed,
    modelSource: row.modelSource,
  };
}

/** The six inputs, each read exactly once (see `field`). */
interface GivenInputs {
  workspaceRoot: unknown;
  scope: unknown;
  settings: unknown;
  health: unknown;
  sessions: unknown;
}

/**
 * One property of a caller-supplied value, or undefined. Property access is the one thing a
 * caller's object can make throw before any guard of ours runs (a getter, a revoked Proxy);
 * a field that cannot be read is an absent field.
 */
function field(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function attempt<T>(run: () => T, otherwise: T): T {
  try {
    return run();
  } catch {
    return otherwise;
  }
}

/** What one pass over the index establishes for one scope of one workspace on one day. */
interface ScopeSummary {
  /** The newest TASK_LIST_MAX tasks of the scope. */
  listed: { row: TaskRow; inWorkspace: boolean }[];
  taskTotal: number;
  running: { workspace: number; all: number };
  daily: UiDailyBucket[];
}

let scopeSummaryKey: string | undefined;
let scopeSummaryKept: ScopeSummary | undefined;

/**
 * The tasks of a scope: which are listed, how many there are, how many are running and how
 * they fall into the 14 days. One pass over the index — and none at all while the index, the
 * scope and the day are what they were at the last build, which is what a dashboard that
 * rebuilds on a timer asks for nearly every time.
 */
function scopeSummary(
  index: TaskIndex,
  root: string | undefined,
  scope: 'workspace' | 'all',
  bounds: number[],
): ScopeSummary {
  const key = `${index.generation}\u0000${scope}\u0000${root ?? ''}\u0000${bounds[0]}\u0000${bounds[DAILY_BUCKETS]}`;
  if (scopeSummaryKept !== undefined && scopeSummaryKey === key) {
    return scopeSummaryKept;
  }
  const daily = emptyDaily(bounds);
  const listed: { row: TaskRow; inWorkspace: boolean }[] = [];
  const running = { workspace: 0, all: 0 };
  let taskTotal = 0;
  // The workspace test is made once per distinct directory, not once per task.
  const inside = new Map<string | undefined, boolean>();
  for (const row of index.sorted) {
    let inWorkspace = inside.get(row.cwd);
    if (inWorkspace === undefined) {
      inWorkspace = root !== undefined && row.cwd !== undefined && pathWithin(row.cwd, root);
      inside.set(row.cwd, inWorkspace);
    }
    if (row.status === 'running') {
      running.all += 1;
      if (inWorkspace) {
        running.workspace += 1;
      }
    }
    if (scope === 'workspace' && !inWorkspace) {
      continue;
    }
    taskTotal += 1;
    countDaily(daily, bounds, row);
    if (listed.length < TASK_LIST_MAX) {
      listed.push({ row, inWorkspace });
    }
  }
  scopeSummaryKey = key;
  scopeSummaryKept = { listed, taskTotal, running, daily };
  return scopeSummaryKept;
}

function assemble(inputs: GivenInputs, now: number): DashboardModel {
  const root = absolutePath(inputs.workspaceRoot);
  const scope = inputs.scope === 'all' ? 'all' : 'workspace';
  const index = taskIndex();
  const sessions = projectSessions(inputs.sessions);

  const worktrees = new Map<string, { branch: string | null; unmerged: boolean }>();
  for (const session of sessions) {
    if (session.source === 'worker' && session.taskId !== null && !worktrees.has(session.taskId)) {
      worktrees.set(session.taskId, { branch: session.branch, unmerged: session.unmerged });
    }
  }

  const { listed, taskTotal, running, daily } = scopeSummary(index, root, scope, dayBoundaries(now));
  // The listed rows are the only ones whose details the page is shown: read back from the
  // log in one go, and only for the rows not asked for before.
  loadDetails(listed.map((entry) => entry.row));
  const tasks = listed.map(({ row, inWorkspace }) => toUiTask(index, row, inWorkspace, worktrees));
  const registry = registryRead();

  return {
    schema: 2,
    generatedAt: now,
    // The folder NAME only. A workspace at a filesystem root has no name; it still is one.
    workspace: root === undefined ? null : displayString(path.basename(root), 80) || '-',
    scope,
    orchestrator: projectOrchestrator(root, now),
    health: projectHealth(inputs.health, root !== undefined, index.problem, registry.problem),
    accounts: buildAccounts(index, now),
    unsupportedAccounts: unsupportedAccounts(),
    tasks,
    taskTotal,
    // Copies: the summary they come from is kept for the next build.
    running: { ...running },
    daily: daily.map((bucket) => ({ ...bucket })),
    sessions,
    settings: projectSettings(inputs.settings),
  };
}

/**
 * Build the dashboard's model. Never throws; with no file changed since the last call it
 * performs `stat` calls only.
 *
 * Should the assembly itself fail — a defect here, not a property of any file — the page
 * still gets a well-formed model, and the failure is VISIBLE in `health.taskLogProblem`
 * rather than rendered as an empty, healthy-looking dashboard.
 */
export function buildDashboardModel(inputs: ModelInputs): DashboardModel {
  const given: GivenInputs = {
    workspaceRoot: field(inputs, 'workspaceRoot'),
    scope: field(inputs, 'scope'),
    settings: field(inputs, 'settings'),
    health: field(inputs, 'health'),
    sessions: field(inputs, 'sessions'),
  };
  const now = epochMs(field(inputs, 'now')) ?? Date.now();
  try {
    return assemble(given, now);
  } catch (err) {
    const root = absolutePath(given.workspaceRoot);
    const reason = attempt(() => displayString(err instanceof Error ? err.message : '', 60), '');
    const problem = displayString(
      `the dashboard data could not be assembled${reason === '' ? '' : `: ${reason}`}`,
      120,
    );
    const registryProblem = attempt(() => registryRead().problem, null);
    // The caller's own objects may be what failed, so each is projected under its own guard
    // and replaced by the empty projection when it cannot be.
    return {
      schema: 2,
      generatedAt: now,
      workspace: root === undefined ? null : displayString(path.basename(root), 80) || '-',
      scope: given.scope === 'all' ? 'all' : 'workspace',
      orchestrator: null,
      health: attempt(
        () => projectHealth(given.health, root !== undefined, problem, registryProblem),
        projectHealth(undefined, root !== undefined, problem, registryProblem),
      ),
      accounts: [],
      unsupportedAccounts: attempt(unsupportedAccounts, []),
      tasks: [],
      taskTotal: 0,
      running: { workspace: 0, all: 0 },
      daily: emptyDaily(dayBoundaries(now)),
      sessions: [],
      settings: attempt(() => projectSettings(given.settings), projectSettings(undefined)),
    };
  }
}

/* ------------------------------------------------------------------------- *
 * `claude --version` — the only process this module ever starts
 * ------------------------------------------------------------------------- */

const VERSION_TIMEOUT_MS = 8_000;
const VERSION_OK_TTL_MS = 10 * 60_000;
/** A failure is retried sooner: the usual cause (binary mid-reinstall, PATH) fixes itself. */
const VERSION_FAIL_TTL_MS = 60_000;
/** After 'exit', how long trailing stdout may still arrive before we settle anyway. */
const VERSION_DRAIN_MS = 250;
const VERSION_KILL_GRACE_MS = 2_000;
const VERSION_OUTPUT_MAX = 4096;
/** Output past which the probed command is ended (the cap usage.ts puts on its probes). */
const VERSION_STREAM_MAX_BYTES = 1024 * 1024;
const VERSION_CACHE_MAX = 16;

const versionCache = new Map<string, { at: number; value: string | null }>();
const versionProbes = new Map<string, Promise<string | null>>();

function rememberVersion(command: string, value: string | null): void {
  versionCache.delete(command);
  versionCache.set(command, { at: Date.now(), value });
  // The key is a setting the page can change on every keystroke; the cache must not grow
  // with it. Map iteration is insertion order, so the first key is the oldest.
  while (versionCache.size > VERSION_CACHE_MAX) {
    const oldest = versionCache.keys().next();
    if (oldest.done) {
      break;
    }
    versionCache.delete(oldest.value);
  }
}

function runVersionProbe(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let output = '';
    let child: ChildProcess | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      // A child that started a background service can leave the pipe open for ever (P16);
      // drop our end so it holds neither the event loop nor a descriptor.
      try {
        child?.stdout?.destroy();
      } catch {
        // already destroyed
      }
      resolve(value);
    };
    const reading = (): string | null => {
      if (exitCode !== 0) {
        return null;
      }
      const text = displayString(output, 40);
      // Only output that actually carries a version is a reading: a wrapper that prints a
      // banner and exits 0 has told us nothing, and "unknown" is the honest answer.
      return text !== '' && parseClaudeVersion(text) !== undefined ? text : null;
    };

    try {
      child = spawn(command, ['--version'], {
        cwd: os.tmpdir(),
        env: claudeEnv(hostConfigDir()),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      // spawn throws synchronously on a value it will not accept as a command at all
      resolve(null);
      return;
    }
    const proc = child;

    /** Answer "unknown" and end the child: it ran out of time, or it would not stop printing. */
    const giveUp = (): void => {
      finish(null);
      if (killTimer !== undefined || exited) {
        return;
      }
      // SIGTERM first, SIGKILL only if it is ignored: a killed CLI can leave files behind
      // that a terminated one cleans up (P3). Unref'd — the answer is already delivered.
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        if (!exited) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, VERSION_KILL_GRACE_MS);
      killTimer.unref();
    };
    timeout = setTimeout(giveUp, VERSION_TIMEOUT_MS);

    let received = 0;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (output.length < VERSION_OUTPUT_MAX) {
        output += String(chunk).slice(0, VERSION_OUTPUT_MAX - output.length);
      }
      // A version is one short line. A command that keeps printing is not `claude --version`,
      // and it is ended rather than drained until the timeout.
      received += Buffer.byteLength(String(chunk));
      if (received > VERSION_STREAM_MAX_BYTES) {
        giveUp();
      }
    });
    proc.stdout?.on('error', () => undefined);
    proc.stdout?.on('end', () => {
      if (exited) {
        finish(reading());
      }
    });
    proc.on('error', () => finish(null));
    // Settle on 'exit', never 'close': 'close' waits for every holder of the stdio pipes,
    // and a grandchild that inherited them can keep it from ever firing (P16). The short
    // drain is for output still in the pipe when the process itself is already gone.
    proc.on('exit', (code) => {
      exited = true;
      exitCode = code;
      clearTimeout(killTimer);
      if (settled) {
        return;
      }
      if (proc.stdout === null || proc.stdout.readableEnded) {
        finish(reading());
      } else {
        drain = setTimeout(() => finish(reading()), VERSION_DRAIN_MS);
      }
    });
  });
}

/**
 * `claude --version` of the CLI at `claudePath`, as display-safe text of at most 40 chars
 * (observed: `2.1.283 (Claude Code)`), or null when it could not be read. Feed the result to
 * `claudeVersionAtLeast` for the session-worker gate.
 *
 * Never rejects. A reading is cached for 10 minutes and a failure for 1, per command;
 * concurrent callers share one child. The child runs with `claudeEnv(hostConfigDir())`,
 * settles on its 'exit' event, and is given 8 seconds.
 *
 * `claudePath` is spawned as given (trimmed), with no shell and no PATH resolution of its
 * own — pass the command the dispatcher itself would spawn.
 */
export function probeClaudeVersion(claudePath: string): Promise<string | null> {
  const command = typeof claudePath === 'string' ? claudePath.trim() : '';
  if (command === '' || command.length > 4096 || command.includes('\u0000')) {
    return Promise.resolve(null);
  }
  const hit = versionCache.get(command);
  if (hit !== undefined) {
    // A negative age is a clock that jumped backwards; treat it as expired so a stale
    // verdict can never be held indefinitely.
    const age = Date.now() - hit.at;
    if (age >= 0 && age < (hit.value === null ? VERSION_FAIL_TTL_MS : VERSION_OK_TTL_MS)) {
      return Promise.resolve(hit.value);
    }
  }
  const pending = versionProbes.get(command);
  if (pending !== undefined) {
    return pending;
  }
  const probe = runVersionProbe(command)
    .catch(() => null)
    .then((value) => {
      versionProbes.delete(command);
      rememberVersion(command, value);
      return value;
    });
  versionProbes.set(command, probe);
  return probe;
}
