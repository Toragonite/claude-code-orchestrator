import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { claudeEnv, claudeShellPrefix, isFrontierModel, MODEL_ALIASES, REPORTED_MODEL_ID } from '../platform';
import {
  normalizeProviderModel,
  parseProvider,
  PROVIDER_IDS,
  providerInfo,
  providerModelHint,
  usageWindowLabel,
  type ProviderId,
} from '../providers';
import {
  appendOutputNote,
  appendTaskEvent,
  appendTerminalTaskEvent,
  clampTimeoutMinutes,
  emptyStats,
  ensureDirs,
  isStateWriteRefusal,
  latestTaskEventOf,
  readRegistry,
  readStats,
  Registry,
  runningCounts,
  sanitizeDispatchConcurrency,
  StatsFile,
  TASKS_DIR,
  TaskEvent,
  type UnsupportedWorkerEntry,
  updateStats,
  WorkerProfile,
  workerProvider,
  writeTaskFile,
} from '../registry';
import { WORKER_BASE_PROMPT } from '../prompts';
import {
  AccountUsage,
  AUTH_PROBE_TIMEOUT_MS,
  AuthStatus,
  checkClaudeLogin,
  computeLoginState,
  exhaustedWindows,
  formatRelativeReset,
  isLoginExpired,
  isLoginSuspect,
  LOGGED_OUT_FRESH_MS,
  loginOutIsOwn,
  mergeUsageCaches,
  ownsUsageReading,
  parseLoginProbes,
  readUsageCache,
  recordClaudeRunLogin,
  recordProviderRunLoginFailure,
  recordProviderRunSucceeded,
  resolveProbeCommand,
  RUN_LOGIN_FAILURE_STICKY_MS,
  runLoginFailureAt,
  USAGE_CACHE_FILE,
  UsageCache,
  UsageWindow,
} from '../usage';
import { checkDispatchArgs, type CheckedDispatchArgs } from './dispatch-args';
import { acquireDispatchSlot, type DispatchSlot } from './dispatch-gate';
import { DISPATCHED_TASK_ENV } from './host-protocol';
import {
  BoundedText,
  buildProviderPrompt,
  isQuotaError,
  ProviderAuthError,
  providerLoginRoute,
  ProviderQuotaError,
  providerStatus,
  ProviderWorkspaceError,
  runProviderWorker,
  shellQuote,
  STDERR_TAIL_BYTES,
} from './provider-runner';

/**
 * task-runner — the per-task dispatch CORE, extracted verbatim from server.ts so
 * two hosts can run the SAME logic: the in-process MCP server (default path) and,
 * later, a standalone detach supervisor (run-task.ts). Behaviour is byte-for-byte
 * the former dispatchTask body; the only difference is that the four request-scoped
 * side effects (cancellation check, id tracking, child registration, and cleanup)
 * are supplied by the host through TaskRunContext instead of reaching into the
 * server's live maps directly. This module must not import 'vscode' and must not
 * import the server (the hooks flow one way, in through the context).
 */

/** How long a timed-out worker gets to honor SIGTERM before it is SIGKILLed. */
const TIMEOUT_KILL_GRACE_MS = 10_000;
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
/**
 * Most of a `claude -p` child's RESULTS that is accumulated, in bytes: its `result` lines, and the
 * line being read when it may be one (a line that is not another event's). The CLI prints the
 * session as a stream of events, and only its results are held — a result cut anywhere is not a
 * result, so unlike the rest of the stream there is no useful part of an oversized one to keep. A
 * child whose results outgrow this is stopped (see runClaude) and its output is discarded, which
 * is what bounds this server's memory by the number of workers it runs rather than by what one of
 * them chooses to print. The stream's end is kept to the same size for diagnostics.
 */
const STDOUT_CAP_BYTES = 8 * 1024 * 1024;
/**
 * Longest line of another event (an assistant message, a tool result) that is parsed for what it
 * says about the turns of a run (ClaudeTurnLog). A longer one is dropped as it arrives, its type
 * read off its start: it is a tool's output or a long message, never what opens a turn.
 */
const EVENT_LINE_PARSE_BYTES = 1024 * 1024;

/**
 * The type of a stdout line that is an event OTHER than a result, read off its start as the CLI
 * prints it (`{"type":"assistant",…`); undefined for a result, for a line not yet long enough to
 * say, and for anything else — which is then held as a result might be.
 */
function otherEventType(line: string): string | undefined {
  const type = /^\{"type":"([a-z_]+)"/.exec(line)?.[1];
  return type !== undefined && type !== 'result' ? type : undefined;
}
/** What a run that outgrew STDOUT_CAP_BYTES fails with. Carries none of the output it discarded. */
export const OUTPUT_OVERFLOW_ERROR = `Worker output exceeded ${STDOUT_CAP_BYTES / (1024 * 1024)} MiB and was discarded`;

/**
 * Message raised (and swallowed by the host) when a dispatch is aborted after its
 * worker loop — kept identical to the server's cancel terminal-event string so the
 * two never diverge. The server imports this for its own cancelRequest event.
 */
export const CANCELLED_ERROR = 'cancelled by the orchestrator session';

/**
 * What a dispatch fails with when its request was cancelled while it was still WAITING for a
 * slot of the dispatch gate (mcp/dispatch-gate). Different words from CANCELLED_ERROR because it
 * is a different fact: nothing was started, so there is no worker to stop, no working tree to
 * inspect, and no task-log entry — the dispatch never had an id.
 */
export const CANCELLED_BEFORE_START_ERROR = 'cancelled before it started';

let rrIndex = 0;

/* ------------------------------------------------------------------------- *
 * Maps keyed by a string that came out of a FILE
 * ------------------------------------------------------------------------- */

/*
 * stats.json, the running counts and the usage cache are plain objects keyed by a worker's name
 * or its config dir — strings read from registry.json, which is hand-editable. `map[key]` on
 * such an object answers for names nobody stored: `constructor` is the Object function,
 * `toString` and `hasOwnProperty` are functions, `__proto__` is Object.prototype itself. A
 * reader then takes a function for a worker's stats, and a writer that does `map[key] ?? fresh`
 * and increments what it got puts the counters ON Object.prototype — every object in the
 * process inherits them from then on, and nothing is ever written to the file.
 *
 * The three functions below are the ONLY way this file, the server and the session-worker
 * runner index such a map. A key counts when the map itself holds it, and only when what it
 * holds is the kind of value the map is for; everything else is "absent".
 */

/** The OWN value of `map[key]`, or undefined — never something inherited. Total. */
function ownValue(map: unknown, key: string): unknown {
  return typeof map === 'object' && map !== null && Object.prototype.hasOwnProperty.call(map, key)
    ? (map as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The entry a map holds for `key` when that entry is a plain object (a worker's stats, an
 * account's usage reading); undefined when the map has no such key of its own, or holds
 * anything else there.
 */
export function ownEntry<T extends object>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  const value = ownValue(map, key);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : undefined;
}

/** The count a map holds for `key`: a finite number that is not negative, else 0. */
export function ownCount(map: Readonly<Record<string, number>> | undefined, key: string): number {
  const value = ownValue(map, key);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Store `value` under `key` as the map's OWN property, whatever the key is. A plain assignment
 * to `__proto__` replaces the map's prototype instead of storing anything; a defined property is
 * an entry like any other, and JSON.stringify writes it as one.
 */
export function setOwnEntry<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Identity of a task, enough to append a terminal event for it. `modelSource` is part of it so
 * that an event a HOST authors for the attempt (a cancellation, a shutdown) says who chose the
 * model exactly as the core's own events do.
 */
export type TaskBase = Pick<TaskEvent, 'id' | 'title' | 'worker' | 'model' | 'modelSource' | 'outputFile' | 'cwd'>;

/** Who chose an attempt's model — the three words of `TaskEvent.modelSource`. */
export type ModelSource = NonNullable<TaskEvent['modelSource']>;

/**
 * The arguments of one dispatch — the CHECKED shape (mcp/dispatch-args), and nothing looser.
 *
 * What each field means is unchanged: `model` is a tier alias or a full model id, and one that
 * is not a model REJECTS the dispatch (resolveRequestedModel); `provider` opts in to another
 * vendor's agent CLI, and the task otherwise runs on a Claude Code worker unless `worker` names
 * one (resolveDispatchTarget); `ultrathink` escalates the worker to maximum reasoning depth;
 * `timeout_minutes` is the per-task wall-clock limit, falling back to
 * registry.workerTimeoutMinutes; `detach` asks for a standalone supervisor and is read only by
 * the server, which decides in-process against detached.
 *
 * What changed is that the type no longer describes what a caller HOPES it was sent. These
 * arguments arrive as JSON — from a tool call, from a detach supervisor's spec file — and the
 * old declaration (`title?: string`, …) was a cast over whatever that JSON held: a number where
 * a string was declared threw a TypeError out of the first `.trim()`, and a title of any length
 * went into every record of the task. The checker is what makes the declaration true, so the
 * type IS the checker's result; a value that has this type without having been through it is
 * still only a cast, which is why each core checks again as its first act (the check is
 * idempotent).
 */
export type DispatchArgs = CheckedDispatchArgs;

/**
 * Terminal, structured outcome of one run — the payload a detach supervisor writes
 * to tasks/<id>.result.json (contract §5.4) and the server relays. `text` is exactly
 * the string the default in-process path would return for this task, so the server
 * relays it verbatim (done) or throws `error` (parity with the default failure).
 * Delivered through TaskRunContext.onResult; the default path leaves onResult unset,
 * so producing it costs the in-process path nothing.
 */
export interface TaskResult {
  id: string;
  status: 'done' | 'error';
  text: string;
  worker: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  overageWarning?: string;
  error?: string;
}

/**
 * Request-scoped hooks the host wires into one run. The in-process server backs
 * these with its live maps (abortedRequests, taskBases, childrenByTask); a
 * standalone supervisor supplies no-ops. Threading them explicitly keeps the core
 * free of hidden globals — the default path still registers each worker child, so
 * stdin-close shutdown (D4) and request cancel (D5) keep working unchanged.
 */
export interface TaskRunContext {
  /**
   * True when the owning request has been cancelled / the server is shutting down. Asked at the
   * core's checkpoints, and on a timer for as long as the dispatch waits for a slot of the
   * dispatch gate (acquireDispatchSlotFor) — so it must be cheap and must not throw.
   */
  shouldAbort(): boolean;
  /** Claim the task id before the child exists — a cancel in that window still lands. */
  onTrack(base: TaskBase): void;
  /**
   * The worker child was just spawned — make it killable from outside this run. Called only for
   * a child that exists (it has a pid): a spawn that failed is reported as the attempt's
   * failure and never reaches this hook.
   */
  onSpawn(taskId: string, child: ChildProcess): void;
  /**
   * onSpawn's counterpart for a worker on ANOTHER VENDOR'S CLI (mcp/provider-runner), whose
   * child this core never holds: it is started inside the vendor adapter, through the runner's
   * process seam. What the host gets instead is `kill` — the runner's own stop for that run's
   * whole process group (SIGTERM, then SIGKILL after its grace; a second call is the SIGKILL at
   * once) — and the child's `pid`, which on POSIX is also its group id. The host registers
   * `kill` exactly where it registers a `claude -p` child, so a cancelled request and a server
   * going down reach it the same way.
   *
   * Optional, like onResult: a host that supplies neither hook still runs the task; it just
   * cannot stop it from outside.
   */
  onProviderSpawn?(taskId: string, kill: () => void, pid: number | undefined): void;
  /**
   * That run is over — its child, and anything else it started, is gone. Called exactly once
   * for every onProviderSpawn, with the same `kill`, so the host can drop its registration (and
   * a host that is waiting for its children before exiting can stop waiting for this one).
   */
  onProviderExit?(taskId: string, kill: () => void): void;
  /**
   * Terminal cleanup for this task id — runs in a finally after the dispatch settles. Not called
   * for a dispatch that never had an id: one refused for its arguments, or cancelled while it
   * was still waiting for a slot.
   */
  onSettle(taskId: string): void;
  /**
   * Pre-assigned task id. A detach supervisor sets this so the server (which chose
   * the id and is waiting on tasks/<id>.result.json) and the supervisor agree on it.
   * The server sets it too: for a task it continues under the id an earlier attempt announced
   * (the untrusted-workspace fallback), and in host mode for every task, whose id it minted and
   * announced to the `cco` client before the task was queued (contract §15.5). Unset on the
   * default stdio path, where the core allocates its own id exactly as before.
   */
  preassignedId?: string;
  /**
   * PID of the detach supervisor host (its own process.pid), stamped onto this task's
   * running/interim events so the reaper can treat the task as alive while the
   * supervisor lives even when no worker pid is currently running (contract §5.5, R8).
   * Unset on the default in-process path — those events carry no supervisorPid.
   */
  supervisorPid?: number;
  /**
   * Deliver the terminal structured result to the host — the detach supervisor uses
   * it to author result.json. Called once, at the single success return and just
   * before the final failure throw (never on a cancel-abort). Unset on the default
   * path, so the in-process host is unaffected.
   */
  onResult?(result: TaskResult): void;
}

export interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The model id the CLI reported it ran (reportedModel); absent when it reported none. */
  modelUsed?: string;
}

/**
 * Exported for the `--bg` dispatch runner (mcp/bg-runner.ts), which must classify a
 * spawn failure exactly as this path does — a quota failure fails over, anything else
 * surfaces. The DEFINITION sits in mcp/provider-runner.ts: the non-Claude runner classifies
 * vendor failures with this same function and this module imports that runner, so it is
 * re-exported here under the name its importers have always used — one classifier, no import
 * cycle. What it reads, and why it would rather miss than guess, is said there.
 */
export { isQuotaError };

/**
 * A run that hit its wall-clock limit. Carried as a distinct type because a
 * timeout message embeds the worker's own stdout, which may itself talk about
 * quotas or state a status code — classifying it by its text would put a
 * healthy worker on a cooldown and fail the task over to another one, which
 * would then burn the same wall clock on the same too-large task.
 */
class WorkerTimeoutError extends Error {}

/**
 * A run whose child died from a termination signal this server never sent — in
 * practice the extension's own Cancel button (it signals the recorded pid/pgid
 * directly, so the server is never told and isAborted() stays false), an OS
 * kill, or the OOM killer. Carried as a distinct type for the same reason as
 * WorkerTimeoutError: the message embeds the worker's captured output, so a
 * regex would read the dead worker's own words as a quota failure. Such a death
 * is never a quota problem and must never fail over to another worker — the
 * replacement would run a task the user has already cancelled.
 */
class WorkerKilledError extends Error {}

/**
 * A run that wrote more to stdout than is kept (STDOUT_CAP_BYTES) and was stopped for it.
 * A distinct type for the reason the two above are: it is this server's own decision about the
 * worker's OUTPUT, so it says nothing about the account — never a quota failure, never a reason
 * to run the task again on the next one, which would print the same thing.
 */
class WorkerOutputOverflowError extends Error {}

/**
 * What the `claude` CLI itself reported as the failure of a run: its non-zero exit with what it
 * printed, or the `is_error` result it returned. The ONLY failure of a one-shot run that is read
 * for a quota verdict (isClaudeQuotaFailure). Everything else that can go wrong around a run is
 * this server's wording or the operating system's — a missing binary, a kill, a timeout, a cap —
 * and may quote a path or the worker's own output, neither of which is the CLI's account of why
 * it stopped.
 */
class WorkerCliFailure extends Error {}

/**
 * Whether a failed attempt on a Claude Code worker is the ACCOUNT's quota or rate limit — the
 * verdict that starts a cooldown and moves the task to the next account. By the failure's type
 * first, and only then by what the CLI said.
 */
function isClaudeQuotaFailure(err: unknown): boolean {
  return err instanceof WorkerCliFailure && isQuotaError(err.message);
}

/**
 * Team mode (team contract §3.3, M14): the sentences with which the `claude` CLI says an account is
 * not logged in. A FAILED team turn of a Claude member whose failure text holds one of them
 * (case-insensitive substring) TRIGGERS the live login probe pickWorkerLive runs
 * (LIVE_RECHECK_PROBE_TIMEOUT_MS); the PROBE's verdict decides — logged out → the turn is `auth`,
 * filed as dispatch files it (recordTurnBookkeeping); logged in → `error`. The text alone never
 * files a verdict: this path has no Claude login-failure TEXT rule (the Claude verdict comes from
 * the usage cache and the live probe — usage.isLoginExpired), and a transient line in a turn's
 * output must not mark the user's main account logged out for every dispatch (P118).
 *
 * Read only for a turn that FAILED, never for activity text (a task may be ABOUT logging in).
 */
export const CLAUDE_LOGIN_TRIGGER_TEXTS: readonly string[] = [
  // RP-23 (2026-10-16, Claude Code 2.1.299, a fresh logged-out config dir): `is_error: true`,
  // result "Not logged in · Please run /login". A match only TRIGGERS the live probe; the probe's
  // verdict is what is filed.
  'Not logged in',
  'Please run /login',
];

/** Does a failed Claude run's error text hold one of the CLI's not-logged-in sentences? */
function isClaudeLoginFailureText(text: string): boolean {
  const lower = text.toLowerCase();
  return CLAUDE_LOGIN_TRIGGER_TEXTS.some((t) => lower.includes(t.toLowerCase()));
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

/**
 * A plan window's label as every text of the dispatch server prints it: the reading's own, except
 * that the bare `primary` / `secondary` an adapter reports for a window its vendor gives no name
 * read "Primary limit" / "Secondary limit" (providers.usageWindowLabel — the words the views
 * use). The label comes out of the usage cache, a file, so one that is not a string is printed as
 * it always was rather than handed to a function that expects text.
 */
export function windowLabel(label: unknown): string {
  return typeof label === 'string' ? usageWindowLabel(label) : String(label);
}

/** '<label> <percent>% (resets <when>)' for a quota-exhausted window — error text and list_workers. */
export function formatExhaustedWindow(w: UsageWindow): string {
  return `${windowLabel(w.label)} ${Math.round(w.percent)}% (resets ${formatRelativeReset(w.resetsAt)})`;
}

/**
 * Overage ("extra usage") billing is ON for this account: exhausting a plan
 * window BILLS money against a monthly cap instead of blocking work (see the
 * ExtraUsage doc comment in usage.ts). Defensive — the usage cache is an
 * untrusted JSON file, so anything that is not a proper non-array object with
 * `enabled === true` reads as OFF. On a money surface we never assume billing.
 */
export function overageEnabled(usage: AccountUsage | undefined): boolean {
  const eu = usage?.extraUsage;
  return typeof eu === 'object' && eu !== null && !Array.isArray(eu) && eu.enabled === true;
}

/** Caveat appended ONCE per message that prints a reloginCommand — the syntax is POSIX-only. */
export const RELOGIN_SHELL_CAVEAT = 'POSIX shell; on Windows set the env var first';

/**
 * Shell command that re-authenticates one account — the recovery step for an expired login.
 *
 * The prefix comes from platform.claudeShellPrefix, not from a hand-written
 * `CLAUDE_CONFIG_DIR=<dir>`: for the CLI's default directory, exporting the path is NOT the same
 * as leaving the variable unset — the CLI then keys its credential store to the directory, so a
 * login made by the printed command would be one the account's ordinary sessions cannot see.
 * For that directory the command is a plain `claude auth login` (with an explicit `env -u` only
 * when this process itself has the variable exported); for every other one it is unchanged.
 */
export function reloginCommand(configDir: string): string {
  return `${claudeShellPrefix(configDir, shellQuote)}claude auth login`;
}

/**
 * How ONE worker's account is logged back in, whatever CLI it runs on: a shell command, or —
 * for a provider that signs in elsewhere (Antigravity: its desktop app) — the sentence that
 * says where. A Claude Code worker gets reloginCommand, unchanged.
 *
 * Another vendor's route is provider-runner's providerLoginRoute — the one definition, which
 * the failure message of a run that hit a dead login prints too, so a refusal here and a failure
 * there can never name two different commands for the same account.
 */
function reloginRoute(worker: Pick<WorkerProfile, 'configDir' | 'provider'>): { command: string } | { manual: string } {
  const provider = workerProvider(worker);
  return provider === 'claude'
    ? { command: reloginCommand(worker.configDir) }
    : providerLoginRoute(provider, worker.configDir);
}

/** reloginRoute as one string — the command itself, or the sentence — for a status line. */
export function workerReloginHint(worker: Pick<WorkerProfile, 'configDir' | 'provider'>): string {
  const route = reloginRoute(worker);
  return 'command' in route ? route.command : route.manual;
}

/**
 * The recovery routes for a set of logged-out workers, as the phrase that follows "or " in a
 * refusal: `shell: <command>[, <command>…] — <caveat>`, each distinct command once (workers may
 * share an account), then any sign-in that is not a shell command. For Claude Code workers this
 * is exactly the text these refusals have always carried.
 */
function reloginRoutesText(workers: Pick<WorkerProfile, 'configDir' | 'provider'>[]): string {
  const routes = workers.map(reloginRoute);
  const commands = [...new Set(routes.flatMap((route) => ('command' in route ? [route.command] : [])))];
  const manual = [...new Set(routes.flatMap((route) => ('manual' in route ? [route.manual] : [])))];
  const parts = commands.length > 0 ? [`shell: ${commands.join(', ')} — ${RELOGIN_SHELL_CAVEAT}`] : [];
  return [...parts, ...manual].join('; or ');
}

/**
 * Refusal text for a worker whose subscription OAuth session has expired. Unlike
 * quota exhaustion there is no billing escape hatch and no reset to wait for: the
 * dispatch would die on "Failed to authenticate", so the only recovery is a
 * re-login. Both recovery routes are spelled out because the reader is an
 * orchestrating session that cannot see the VS Code UI.
 *
 * "retry" is a real instruction, not a platitude: the next dispatch re-probes this
 * account's login live (see liveRecheckExpiredLogins), so a completed re-login is
 * picked up immediately rather than waiting for a usage refresh.
 */
function expiredLoginRefusal(worker: WorkerProfile): string {
  return (
    `Worker "${worker.name}" login is expired/logged out; a dispatch would fail to authenticate. ` +
    'Re-login this account first (VSCode: "Re-login Account" on the worker, or ' +
    `${reloginRoutesText([worker])}) and retry.`
  );
}

/**
 * The cached expired-login verdict is the ONLY thing blocking this pick, and a live
 * auth probe could clear it. Thrown instead of a bare Error so dispatchTask can
 * re-probe the named accounts and retry the selection once — without it, a cached
 * "logged out" reading would survive a successful re-login and refuse the very
 * retry the refusal text asks for, forever (the cache is read once per dispatch and
 * only the list_workers path refreshes it).
 *
 * `candidates` are exactly the workers whose ONLY disqualifier is that verdict, so
 * flipping it is guaranteed to change the outcome. `message` is the refusal to
 * raise if the re-probe confirms the logout, unchanged from the pre-existing text.
 */
class ExpiredLoginBlock extends Error {
  constructor(
    message: string,
    readonly candidates: WorkerProfile[],
    readonly kind: 'named' | 'auto',
  ) {
    super(message);
    this.name = 'ExpiredLoginBlock';
  }
}

/** Outcome of one round of live auth re-probes. */
interface LiveRecheckResult {
  /** At least one probed account is logged back IN — the selection is worth retrying. */
  recovered: boolean;
  /** Sentence(s) to append to the refusal when nothing recovered. '' when there is nothing to add. */
  note: string;
}

/**
 * Persist a refreshed `auth` reading for one account. Mirrors usage.ts's own
 * writeUsageCache: re-read the disk cache, merge, then tmp+rename so a concurrent
 * reader never sees a torn file. `fetchedAt` is deliberately NOT bumped — this is
 * an auth reading, not a usage reading, and faking usage freshness would suppress
 * the next real refresh. A consequence of leaving it: if another process wrote a
 * strictly newer reading for this account since we loaded the cache, mergeUsageCaches
 * keeps theirs — correct, since that reading carries its own fresher auth.
 *
 * Best effort. The in-memory update is what unblocks THIS dispatch; persisting only
 * saves the NEXT one a probe.
 */
function persistAuthReading(configDir: string, entry: AccountUsage): void {
  try {
    ensureDirs();
    const merged = mergeUsageCaches(readUsageCache(), { [configDir]: entry });
    const tmp = `${USAGE_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, USAGE_CACHE_FILE);
  } catch {
    // disk full / read-only / racing writer — the dispatch proceeds on the in-memory verdict
  }
}

/**
 * Per-probe timeout for the live re-check, deliberately tighter than the full
 * AUTH_PROBE_TIMEOUT_MS: this probe runs INSIDE a dispatch the caller is waiting on,
 * so it is budgeted like the refresh path's own server budget (5s) rather than like a
 * background refresh. A hung claude binary costs 5s here, not 10s.
 */
const LIVE_RECHECK_PROBE_TIMEOUT_MS = 5_000;

/**
 * Most distinct config dirs live-probed per DISPATCH (probedDirs is per-dispatch and
 * only grows when a probe actually runs, so it doubles as the budget counter).
 *
 * Worst-case added latency before a refusal: 3 dirs × 5s = 15s — well clear of the
 * ~60s MCP client timeout that an uncapped 10s-per-logged-out-account walk could
 * approach (5 accounts × 10s = 50s, which presented as a hung tool call). Dirs beyond
 * the cap keep their cached verdict and are refused as before; the refusal says so.
 */
const LIVE_RECHECK_MAX_DIRS = 3;

/**
 * Re-probe the login of every candidate account whose cached verdict says expired,
 * and fold a positive result back into `cache` so isLoginExpired() flips.
 *
 * Only `auth` is replaced; `available` stays false until the next usage refresh
 * re-reads plan limits. That is exactly what isLoginExpired needs (available!==true
 * AND auth.loggedIn===false), and it keeps this function out of the quota semantics.
 *
 * Probes run sequentially, at most one per DISTINCT config dir (workers may share a
 * dir) and at most once per dir per dispatch — `probedDirs` carries that across the
 * failover attempts of one dispatchTask call, so the added latency is bounded by the
 * number of logged-out accounts, not by the number of attempts.
 *
 * That bound alone still scaled with the account count, so it is capped absolutely at
 * LIVE_RECHECK_MAX_DIRS probes per dispatch. Truncation is reported back so the
 * refusal can admit which accounts were judged from cache rather than re-checked —
 * the alternative, silently implying every logout was re-confirmed, would send the
 * caller off to re-login an account that may already be fine.
 *
 * An undefined probe result (CLI hung, missing, unparseable) is NOT evidence of
 * anything: the cached verdict stands, and the caller says so rather than implying
 * the logout was re-confirmed.
 *
 * A VERDICT THAT A RUN PRODUCED IS NOT RE-CHECKED WITH A STATUS COMMAND. On another vendor's
 * account the cached "logged out" may be one a failed RUN filed (usage.runLoginFailureAt), and
 * for as long as that verdict is in force the vendor's own status command is the weaker witness:
 * Cursor's answers "logged in" for an account whose every run then fails to authenticate. Asking
 * it here would clear the verdict on its word, so each dispatch that found no other account
 * would start the dead one again, watch it fail, and file the verdict once more. So:
 *
 *  - on the automatic path such an account is not probed and stays out of the selection. It
 *    uses none of the probe budget, and the refusal says why and what ends it;
 *  - a dispatch that NAMES the account still asks — naming a worker is how a caller says "try
 *    this one", exactly as it is for a worker on a cooldown, and it is the one route by which a
 *    login repaired outside the editor is picked up before the verdict lapses. But the answer
 *    is believed for THAT dispatch only: it is not written to the cache, where the run's verdict
 *    stays until a run says otherwise — the attempt that follows either succeeds, which clears
 *    it, or fails on login again, which renews it.
 */
async function liveRecheckExpiredLogins(
  candidates: WorkerProfile[],
  kind: 'named' | 'auto',
  cache: UsageCache,
  probedDirs: Set<string>,
  believed: Set<string>,
): Promise<LiveRecheckResult> {
  // One probe per ACCOUNT. For a Claude Code worker that is its config dir, and the key is the
  // bare directory string exactly as before; another vendor's account is keyed with its
  // provider, because its login is asked of a different CLI even when the directory matches.
  const byAccount = new Map<string, { configDir: string; provider: ProviderId; names: string[] }>();
  for (const w of candidates) {
    const provider = workerProvider(w);
    const key = provider === 'claude' ? w.configDir : `${provider}\0${w.configDir}`;
    const account = byAccount.get(key);
    if (account === undefined) {
      byAccount.set(key, { configDir: w.configDir, provider, names: [w.name] });
    } else {
      account.names.push(w.name);
    }
  }
  let recovered = false;
  const confirmed: string[] = [];
  const unknown: string[] = [];
  const heldByRun: string[] = [];
  let truncated = false;
  for (const [key, { configDir, provider, names }] of byAccount) {
    // Already probed this dispatch: skipped at zero latency, so it consumes no budget.
    if (probedDirs.has(key)) {
      // A caller that marks every account probed (team routing's `cached` mode, M15) asks for no
      // check at all. A Claude Code account held back only by a "not logged in" that THIS process
      // did not see (an older version's reading, another process's, one past the floor) is then
      // believed for this pick: such a reading is never a refusal (Login state (CA)). One this
      // process saw itself — a live check of this very dispatch included — still holds it back.
      const entry = ownEntry(cache, configDir) as AccountUsage | undefined;
      if (provider === 'claude' && !isLoginExpired(entry) && isLoginSuspect(entry) && !loginOutIsOwn(entry)) {
        believed.add(configDir);
        recovered = true;
      }
      continue;
    }
    // Claude Code accounts never carry a run-produced verdict; the test is spelled for the
    // other vendors only so that nothing about a Claude account's re-check can change by it.
    const runProved =
      provider !== 'claude' && runLoginFailureAt(ownEntry(cache, configDir) as AccountUsage | undefined) !== undefined;
    if (runProved && kind === 'auto') {
      heldByRun.push(...names);
      continue;
    }
    // A Claude Code account CONFIRMED logged out by a probe of the last LOGGED_OUT_FRESH_MS is
    // refused on that confirmation without asking again (Login state (CA)); it costs no budget.
    if (provider === 'claude' && freshLoggedOut(ownEntry(cache, configDir) as AccountUsage | undefined)) {
      confirmed.push(...names);
      continue;
    }
    // Budget check, auto path only. The named path probes exactly one dir (the worker
    // the caller asked for), which is always within budget and must never be the probe
    // the cap drops — refusing a named worker on a cached verdict we chose not to
    // re-check is precisely the false-blocked failure this whole path exists to avoid.
    if (kind === 'auto' && probedDirs.size >= LIVE_RECHECK_MAX_DIRS) {
      truncated = true;
      break;
    }
    probedDirs.add(key);
    if (provider === 'claude') {
      // The live check through the dispatch's own CLI path, filed as a login probe of the account
      // (usage.checkClaudeLogin). What the account's state is AFTER it decides: a "logged in" or
      // a failed probe after an unconfirmed "not logged in" clears the hold (a failed probe says
      // nothing, and the run itself is the next witness); a "not logged in" holds it; a failed
      // probe after a CONFIRMED logout leaves that verdict standing — said as such.
      const { auth: live, entry } = await checkClaudeLogin(
        { name: names[0], configDir },
        Math.min(AUTH_PROBE_TIMEOUT_MS, LIVE_RECHECK_PROBE_TIMEOUT_MS),
      );
      setOwnEntry(cache, configDir, entry);
      if (!isLoginExpired(entry) && !isLoginSuspect(entry)) {
        recovered = true;
      } else if (live === undefined) {
        unknown.push(...names);
      } else {
        confirmed.push(...names);
      }
      continue;
    }
    const auth = await providerAuthReading(provider, configDir);
    if (auth === undefined) {
      unknown.push(...names);
      continue;
    }
    if (runProved) {
      // The named path, over a verdict a run produced: in memory, for this dispatch, and only
      // when it is good news. Nothing is written — see the note above.
      if (auth.loggedIn) {
        const believed: AccountUsage = { ...(ownEntry(cache, configDir) as AccountUsage), auth };
        setOwnEntry(cache, configDir, believed);
        recovered = true;
      } else {
        confirmed.push(...names);
      }
      continue;
    }
    applyAuthReading(cache, configDir, auth);
    if (auth.loggedIn) {
      recovered = true;
    } else {
      confirmed.push(...names);
    }
  }
  return {
    recovered,
    note: recheckNote(kind, confirmed, unknown, truncated ? probedDirs.size : 0, heldByRun),
  };
}

/**
 * The live login check of a NON-Claude account, in the shape the Claude one answers in — or
 * undefined when it could not decide. `claude auth status` knows nothing about another vendor's
 * login, so the question goes to that vendor's own CLI through its adapter (providerStatus,
 * login only: a re-check never asks for a usage reading). "Unknown" there is not evidence of
 * anything, exactly like a probe that never answered here.
 */
async function providerAuthReading(provider: ProviderId, configDir: string): Promise<AuthStatus | undefined> {
  const status = await providerStatus(
    { provider, configDir },
    { quota: false, timeoutMs: LIVE_RECHECK_PROBE_TIMEOUT_MS },
  );
  return status.loggedIn === null
    ? undefined
    : { loggedIn: status.loggedIn, method: status.mode, email: null, checkedAt: Date.now() };
}

/**
 * A Claude Code account's reading is `loggedOut` and its newest "not logged in" probe is younger
 * than LOGGED_OUT_FRESH_MS — the one case a gate refuses on without a live check of its own.
 */
function freshLoggedOut(entry: AccountUsage | undefined): boolean {
  if (entry === undefined || computeLoginState(entry).state !== 'loggedOut') {
    return false;
  }
  const lastOut = parseLoginProbes(entry.loginProbes)
    .filter((p) => p.result === 'out')
    .pop();
  const age = lastOut === undefined ? Infinity : Date.now() - lastOut.at;
  return age >= 0 && age < LOGGED_OUT_FRESH_MS;
}

/** Fold a fresh auth reading into the in-memory cache entry, and persist it. */
function applyAuthReading(cache: UsageCache, configDir: string, auth: AuthStatus): void {
  const updated: AccountUsage = { ...(ownEntry(cache, configDir) as AccountUsage), auth };
  setOwnEntry(cache, configDir, updated);
  persistAuthReading(configDir, updated);
}

/**
 * What to add to a refusal after a re-probe failed to clear it. Says only what was
 * actually observed: a confirmed logout, a probe that never answered, and an account
 * never probed at all because the latency cap ran out are three different facts, and
 * claiming a stronger one would send the caller off to re-login an account that may
 * already be fine.
 *
 * `probedCount` is 0 unless LIVE_RECHECK_MAX_DIRS actually truncated the walk; when it
 * did, it is how many accounts were live-probed before the budget ran out.
 *
 * `heldByRun` are the accounts that were NOT probed because their logged-out verdict is one a
 * failed run produced (automatic path only). The sentence names both ways out, because the
 * refusal's own advice — re-login and retry — is not enough here by itself: a login repaired
 * from a terminal is not seen by an automatic dispatch until the verdict lapses.
 */
function recheckNote(
  kind: 'named' | 'auto',
  confirmed: string[],
  unknown: string[],
  probedCount: number,
  heldByRun: string[] = [],
): string {
  if (kind === 'named') {
    // The named path probes its single dir unconditionally, so it never truncates.
    // Confirmed: the pre-existing refusal already says everything true and useful.
    return unknown.length > 0
      ? ' (The live re-check of this login could not run — the auth probe did not answer — so this ' +
          'verdict comes from the cached reading.)'
      : '';
  }
  const parts: string[] = [];
  if (confirmed.length > 0) {
    parts.push(`A live re-check confirmed the expired login(s): ${confirmed.join(', ')}.`);
  }
  if (unknown.length > 0) {
    parts.push(
      `The live re-check could not run for ${unknown.join(', ')} — the auth probe did not answer.`,
    );
  }
  if (probedCount > 0) {
    parts.push(
      `Live re-check was limited to ${probedCount} account(s) this call; the remaining logged-out ` +
        'account(s) were judged from cache — re-login them and retry, or call list_workers to refresh.',
    );
  }
  if (heldByRun.length > 0) {
    parts.push(
      `The last run on ${heldByRun.map((name) => sliceOneLine(flattenOneLine(name), INVALID_MODEL_ECHO_MAX)).join(', ')} ` +
        `failed because the account was not logged in. That stands for up to ${RUN_LOGIN_FAILURE_STICKY_MS / 60_000} ` +
        "minutes against the CLI's own status check, which was therefore not asked: re-login from VS Code " +
        '("Re-login Account"), or name the worker explicitly to try it once.',
    );
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** A worker name as it is quoted in a refusal: one line, at most 80 characters. */
function echoedName(name: unknown): string {
  return sliceOneLine(flattenOneLine(name), INVALID_MODEL_ECHO_MAX);
}

/**
 * The refusal for a dispatch that NAMES a registry entry this version cannot use
 * (registry.UnsupportedWorkerEntry), or undefined when `name` is not one — in which case it is
 * simply a name nobody registered, and the caller says that.
 *
 * Such an entry is in no list of workers, so without this a dispatch naming it was answered
 * "Unknown worker", beside a list of registered workers that the entry — visible in the editor
 * and in registry.json — is missing from. The reason is the registry reader's own: a provider
 * this version does not know (quoted as the reader flattened and cut it), an entry without the
 * directory that is the account, or a second entry under a name already in use.
 *
 * Reads the registry itself unless it is handed the entries, and only on this path — a named
 * worker that selection did not find — so that every core that selects through pickWorker gives
 * the same answer without being handed the list. A registry that cannot be read answers
 * undefined: the unknown-worker refusal is then the true one as far as this process can tell.
 */
export function unsupportedWorkerRefusal(
  name: string,
  entries?: readonly UnsupportedWorkerEntry[],
): string | undefined {
  let entry: UnsupportedWorkerEntry | undefined;
  try {
    entry = (entries ?? readRegistry().unsupportedWorkers ?? []).find((e) => e.name === name);
  } catch {
    return undefined;
  }
  if (entry === undefined) {
    return undefined;
  }
  return `worker "${echoedName(name)}" is a registry entry this version cannot use (${unsupportedWorkerReason(entry)})`;
}

/**
 * The refusal for a dispatch that names a worker which is not among the usable `workers`: the
 * unsupported-entry refusal when the registry holds the name as an entry this version cannot
 * use — telling the caller it does not exist would send them to register an account that is
 * already there — and otherwise "Unknown worker", with the names that do exist. ONE wording,
 * wherever the name is found missing; exported so that a core with its own pre-flight can give
 * it before anything exists for the dispatch, as the one-shot core does (planDispatch).
 */
export function namedWorkerNotFoundRefusal(
  name: string,
  workers: readonly WorkerProfile[],
  unsupported?: readonly UnsupportedWorkerEntry[],
): string {
  return (
    unsupportedWorkerRefusal(name, unsupported) ??
    `Unknown worker "${echoedName(name)}". Registered workers: ${workers.map((w) => echoedName(w.name)).join(', ')}.`
  );
}

/**
 * WHY a registry entry cannot be used, in the few words every surface that names such an entry
 * gives: `unknown provider "<as the registry reader shows it>"`, `incomplete entry`, or
 * `duplicate name`. Exported so that the refusal above and the server's listing of these
 * entries cannot word the same reason two ways.
 */
export function unsupportedWorkerReason(entry: Pick<UnsupportedWorkerEntry, 'reason' | 'providerText'>): string {
  return entry.reason === 'provider'
    ? `unknown provider "${echoedName(entry.providerText)}"`
    : entry.reason === 'duplicate-name'
      ? 'duplicate name'
      : 'incomplete entry';
}

/**
 * Pick a worker for a dispatch: not already attempted, not on cooldown, not
 * logged out, and not live-quota-exhausted for the model this dispatch would
 * actually run.
 *
 * `requestedModel` is the caller-validated `args.model` (undefined => each worker
 * runs its own default), so the candidate model is `requestedModel ?? worker.model`.
 * `cache` is the usage cache read ONCE by the caller — pickWorker never spawns.
 *
 * A worker is EXHAUSTED for a candidate model when exhaustedWindows() reports a
 * window that APPLIES to that model: session/weekly_all always apply; the
 * Fable-only weekly_scoped window applies ONLY to a frontier candidate — a
 * saturated Fable window must never block an opus/sonnet dispatch.
 *
 * Returns the chosen worker plus `billableOverage` — true when the chosen worker
 * IS exhausted for the candidate model but has overage billing enabled, so the
 * dispatch is allowed and will BILL money rather than be blocked. An exhausted
 * worker WITHOUT overage is refused (explicit path) or skipped (auto path) as
 * before; overage-enabled workers are used only as a fallback when no
 * non-exhausted worker is available.
 *
 * `overageAllowed` is the operator's billing guard, resolved ONCE per dispatch by
 * the caller from registry.overageWorkerDispatch === 'allow'. When it is false,
 * `billableOverage: true` is unreachable from every branch below: the explicit
 * path refuses an exhausted overage worker instead of billing it, and the tier-2
 * fallback pool is never consulted at all. Nothing else about selection changes,
 * so the free paths keep their exact previous behavior.
 *
 * A LOGGED-OUT worker (isLoginExpired) is handled one step earlier and more
 * bluntly than exhaustion: it is dropped from the eligible pool outright and
 * refused when named. Overage cannot rescue it and no window reset will fix it —
 * the dispatch would fail to authenticate no matter which model it asks for.
 *
 * That verdict comes from a cache this function never refreshes, so it is raised as
 * an ExpiredLoginBlock rather than a plain Error whenever a live re-probe could
 * still change the answer. The caller re-probes and calls pickWorker again; only
 * the second verdict is final. See ExpiredLoginBlock for why that matters.
 *
 * `frontierGuardBlocks` is the operator's OTHER billing guard as it applies to these workers
 * (the caller resolves it: Claude Code workers, and the guard not set to `allow`). While it
 * blocks, an account whose DEFAULT model is on the frontier tier cannot take a dispatch that
 * names no model — that dispatch would run the default. Such an account is NOT ELIGIBLE for
 * automatic assignment of such a dispatch: it is passed over like an account in cooldown and
 * the next one is picked, whose default is another model. Before this rule the account was
 * picked and the whole dispatch refused, so with one such account among three every third
 * dispatch that named no model failed for nothing. The rule does not touch a dispatch that
 * names a model (the named model runs on any account, and a named frontier model is refused by
 * the caller, for every account alike) nor one that names the worker (the caller refuses that
 * with a message whose advice fits it). The overage guard already has this shape: an exhausted
 * account that could only run by billing is passed over while that guard blocks (tier 2).
 */
function pickWorker(
  workers: WorkerProfile[],
  preferred: string | undefined,
  attempted: Set<string>,
  requestedModel: string | undefined,
  cache: UsageCache,
  overageAllowed: boolean,
  frontierGuardBlocks: boolean,
  believed: ReadonlySet<string> = new Set(),
): { worker: WorkerProfile; billableOverage: boolean } {
  // The reading that is THIS worker's own, or undefined. The cache holds one reading per
  // directory and that reading has one owner (usage.ownsUsageReading): a worker on another
  // vendor's CLI registered on a directory whose reading belongs to somebody else — a Claude
  // Code account, or an earlier vendor worker — has none. It is then selected as an account
  // nothing is known about, instead of being refused on the owner's logged-out verdict or the
  // owner's exhausted plan window (and instead of a live re-check of ITS login being filed
  // over the owner's reading). Asked once per worker per selection: for a vendor worker the
  // answer costs a registry read.
  const owns = new Map<string, boolean>();
  const readingOf = (w: WorkerProfile): AccountUsage | undefined => {
    let own = owns.get(w.name);
    if (own === undefined) {
      own = ownsUsageReading(w);
      owns.set(w.name, own);
    }
    return own ? ownEntry(cache, w.configDir) : undefined;
  };
  // Logged out (confirmed), or last known as not logged in and not confirmed (Login state (CA)):
  // either way the account is held back here, and pickWorkerLive's live re-check decides.
  const loginBlocked = (r: AccountUsage | undefined, w: WorkerProfile): boolean =>
    isLoginExpired(r) || (isLoginSuspect(r) && !believed.has(w.configDir));
  const exhaustedFor = (w: WorkerProfile): UsageWindow[] => {
    const candidate = requestedModel ?? w.model;
    return exhaustedWindows(readingOf(w), Date.now()).filter(
      (win) =>
        win.kind === 'session' ||
        win.kind === 'weekly_all' ||
        (win.kind === 'weekly_scoped' && isFrontierModel(candidate)),
    );
  };

  if (preferred) {
    const found = workers.find((w) => w.name === preferred);
    // An unknown name is interface misuse, not a hint to auto-assign: fail loudly
    // rather than silently substitute a different account than the caller named.
    if (!found) {
      // The one-shot core has refused this before it got here (planDispatch); this is where a
      // core that selects without that pre-flight gets the same words.
      throw new Error(namedWorkerNotFoundRefusal(preferred, workers));
    }
    if (attempted.has(found.name)) {
      throw new Error(`Worker "${echoedName(preferred)}" already failed this task.`);
    }
    // Checked before exhaustion: a logged-out account cannot authenticate at all,
    // so quota headroom (or overage billing) on it is irrelevant. An account whose last known word
    // is "not logged in" without a confirmation (usage.isLoginSuspect) takes the same road: it is
    // re-checked live before anything is decided on it, never refused on the reading alone.
    if (loginBlocked(readingOf(found), found)) {
      throw new ExpiredLoginBlock(expiredLoginRefusal(found), [found], 'named');
    }
    const exhausted = exhaustedFor(found);
    if (exhausted.length > 0) {
      // Exhausted + overage ON → ALLOW, but the dispatch spends real money — and
      // only when the operator's billing guard permits it. Guard blocking turns
      // that billable run into its own refusal, distinct from the no-overage one
      // below: the account COULD run, the operator has forbidden the spend.
      // Exhausted + overage off/unknown → keep the refusal (guaranteed quota failure).
      if (overageEnabled(readingOf(found))) {
        if (overageAllowed) {
          return { worker: found, billableOverage: true };
        }
        throw new Error(
          `Worker "${found.name}" is quota-exhausted and dispatching to it would bill overage ` +
            '(extra usage), which is blocked by the operator ' +
            '("claudeCodeOrchestrator.overageWorkerDispatch"). Wait for the reset, pick another ' +
            'worker, or enable overage dispatch to accept the cost.',
        );
      }
      const candidate = requestedModel ?? found.model;
      throw new Error(
        `Worker "${found.name}" is quota-exhausted for ${candidate} per live plan usage: ` +
          `${exhausted.map(formatExhaustedWindow).join(' · ')}. Refused this dispatch to avoid a ` +
          'guaranteed quota failure (this account has no overage billing enabled to bill past the window). ' +
          'Either dispatch to a different worker, wait for the window above to reset, or — if you believe ' +
          'this usage reading is stale — ask the operator to run "Claude Code Orchestrator: Refresh Account ' +
          'Usage" in VS Code.',
      );
    }
    // Cooldown is deliberately NOT checked here: an explicitly named worker runs
    // even while cooling down. The asymmetry is intentional — cooldown is a
    // blanket 30-min penalty inferred from ONE observed error, whereas the
    // live-exhausted refusal above is current positive evidence from plan usage.
    return { worker: found, billableOverage: false };
  }
  const stats = readStats();
  const now = Date.now();
  // A worker's cooldown end, 0 when it has none: what stats.json holds, or a cooldown this
  // process could not write there (workerCooldownUntil).
  const cooldownUntil = (w: WorkerProfile): number => workerCooldownUntil(stats, w.name);
  const loginExpired = (w: WorkerProfile): boolean => loginBlocked(readingOf(w), w);
  // The frontier guard, for a dispatch that names no model: an account whose default is on the
  // blocked tier would run exactly that. Passed over here, with cooldown and login, so that it
  // stays out of every pool below as well.
  const defaultBlocked = (w: WorkerProfile): boolean =>
    frontierGuardBlocks && requestedModel === undefined && isFrontierModel(w.model);
  // Logged out === undispatchable: excluded here (not at the tier filters) so it
  // composes with cooldown and stays out of the overage fallback pool too.
  const loggedOut = workers.filter(loginExpired);
  const eligible = workers.filter(
    (w) => !attempted.has(w.name) && cooldownUntil(w) <= now && !loginExpired(w) && !defaultBlocked(w),
  );
  if (eligible.length === 0) {
    const cooling = workers
      .filter((w) => cooldownUntil(w) > now)
      .map((w) => `${w.name} (until ${new Date(cooldownUntil(w)).toLocaleTimeString()})`);
    const reasons: string[] = [];
    if (cooling.length > 0) {
      reasons.push(`cooling down after quota errors — ${cooling.join(', ')}`);
    }
    if (loggedOut.length > 0) {
      reasons.push(`login expired/logged out — ${loggedOut.map((w) => w.name).join(', ')}`);
    }
    // One reason per blocked default (two accounts may default to different frontier ids).
    const frontierBlocked = workers.filter(defaultBlocked);
    for (const model of new Set(frontierBlocked.map((w) => w.model))) {
      reasons.push(
        `default model ${model} is on the frontier tier, which the frontier guard blocks — ` +
          frontierBlocked
            .filter((w) => w.model === model)
            .map((w) => w.name)
            .join(', '),
      );
    }
    // Every worker was already attempted for this task and nothing else applies:
    // there is genuinely nothing to say beyond the bare fact.
    if (reasons.length === 0) {
      throw new Error('No eligible worker available.');
    }
    // Naming a logged-out worker explicitly is refused too, so its ONLY recovery
    // is the re-login command — never leave the caller without it.
    const relogin =
      loggedOut.length > 0
        ? ' Re-login the logged-out account(s) first (VSCode: "Re-login Account" on the worker, or ' +
          // Workers may share a config dir — one account, one re-login command.
          `${reloginRoutesText(loggedOut)}).`
        : '';
    const cooldownAdvice =
      cooling.length > 0
        ? ' Wait for the cooldown, or retry with an explicit "worker" — an explicitly named worker ' +
          'runs even while cooling down.'
        : '';
    // What gets a dispatch past a blocked DEFAULT is naming a model: the named model runs on
    // these accounts too. (Naming the worker would not — its default is still the blocked one.)
    const frontierAdvice =
      frontierBlocked.length > 0
        ? ' A dispatch that names a model off the frontier tier (for example model opus) runs on ' +
          'such an account; the operator can also allow the tier ' +
          '("claudeCodeOrchestrator.frontierWorkerDispatch").'
        : '';
    const message =
      `No eligible worker: ${reasons.join('; ')}.${relogin}${cooldownAdvice}${frontierAdvice} ` +
      'Add another worker account if this keeps blocking dispatches.';
    // Workers whose ONLY disqualifier is the cached expired-login verdict: not
    // attempted, not cooling down, just logged out. Flipping that verdict is the
    // one thing that could make this selection succeed, so it is worth a live
    // probe. Anything else here (all attempted, all cooling down) no probe can fix.
    const recoverable = workers.filter(
      (w) => !attempted.has(w.name) && cooldownUntil(w) <= now && loginExpired(w) && !defaultBlocked(w),
    );
    if (recoverable.length > 0) {
      throw new ExpiredLoginBlock(message, recoverable, 'auto');
    }
    throw new Error(message);
  }
  // Preferred worker (usually the main session's own account) wins when it isn't
  // busier than the least-busy alternative — favored, never flooded. Applied to
  // whichever pool we are choosing from.
  const selectFrom = (pool: WorkerProfile[]): WorkerProfile => {
    const starred = pool.find((w) => w.preferred);
    if (starred) {
      const others = pool.filter((w) => !w.preferred);
      if (others.length === 0) {
        return starred;
      }
      const running = runningCounts();
      const minOther = Math.min(...others.map((w) => ownCount(running, w.name)));
      if (ownCount(running, starred.name) <= minOther) {
        return starred;
      }
      const worker = others[rrIndex % others.length];
      rrIndex++;
      return worker;
    }
    const worker = pool[rrIndex % pool.length];
    rrIndex++;
    return worker;
  };
  // Tier 1: workers NOT exhausted for the candidate model — the normal case.
  const pool0 = eligible.filter((w) => exhaustedFor(w).length === 0);
  if (pool0.length > 0) {
    return { worker: selectFrom(pool0), billableOverage: false };
  }
  // Tier 2: every eligible worker is exhausted, but some have overage billing
  // enabled — those still run, spending money instead of being blocked. Using
  // them only here (after pool0 is empty) honors the user's overage opt-in
  // without ever preferring a billable dispatch when a free one exists.
  const poolB = eligible.filter((w) => exhaustedFor(w).length > 0 && overageEnabled(readingOf(w)));
  // The operator's billing guard gates the WHOLE tier: when it blocks, poolB is
  // never selected from, so an empty pool0 falls straight through to the tier-3
  // refusal and no auto-assignment can ever spend extra credit.
  if (overageAllowed && poolB.length > 0) {
    return { worker: selectFrom(poolB), billableOverage: true };
  }
  // Tier 3: no worker can be dispatched for free. Two distinct causes, and the
  // caller needs to know which: either nothing here can bill past the window at
  // all, or something could and the operator has forbidden it — the latter is a
  // one-setting fix, so it names the setting instead of only offering a wait.
  // Both refusals name every exhausted window and its reset: a refusal that says
  // "wait for the reset" without saying WHEN is not actionable.
  const detail = eligible
    .map((w) => `${w.name}: ${exhaustedFor(w).map(formatExhaustedWindow).join(' · ')}`)
    .join('; ');
  if (!overageAllowed && poolB.length > 0) {
    throw new Error(
      `All eligible workers are quota-exhausted per live plan usage — ${detail}. ` +
        `${poolB.length} of them have overage billing enabled, but overage dispatch is blocked ` +
        'by the operator ("claudeCodeOrchestrator.overageWorkerDispatch") — no extra credit will ' +
        'be spent. Wait for the earliest reset above, or enable overage dispatch to bill past the ' +
        'window.',
    );
  }
  throw new Error(
    `All eligible workers are quota-exhausted per live plan usage, and none has overage billing ` +
      `enabled to bill past the window — ${detail}. Refused to dispatch to avoid a guaranteed quota ` +
      'failure. Naming one of these workers explicitly is ALSO refused while it is exhausted without ' +
      'overage. Wait for the earliest reset above, or — if you believe the usage reading is stale — ask ' +
      'the operator to run "Claude Code Orchestrator: Refresh Account Usage" in VS Code.',
  );
}

/**
 * pickWorker, plus the one thing pickWorker cannot do: refresh a stale login verdict.
 *
 * The cache is read once per dispatch and only the list_workers path ever refreshes
 * it, so without this a worker that was logged out when the reading was taken stays
 * undispatchable no matter how many times the operator re-logs in and retries — the
 * exact false-blocked failure the design forbids. Here a cached "expired" verdict
 * costs one live auth probe before it is believed, and the selection is retried once
 * with whatever recovered.
 *
 * Cost is bounded: probes happen ONLY when the cached verdict is the sole blocker,
 * at most once per config dir per dispatch (probedDirs), at most LIVE_RECHECK_MAX_DIRS
 * dirs per dispatch at LIVE_RECHECK_PROBE_TIMEOUT_MS each (3 × 5s = 15s worst case,
 * whatever the account count), and the retry never re-probes — so a second
 * ExpiredLoginBlock ends the dispatch instead of looping. The healthy path adds
 * nothing at all: no cached-expired worker, no probe.
 */
export async function pickWorkerLive(
  workers: WorkerProfile[],
  preferred: string | undefined,
  attempted: Set<string>,
  requestedModel: string | undefined,
  cache: UsageCache,
  overageAllowed: boolean,
  probedDirs: Set<string>,
  frontierGuardBlocks: boolean,
): Promise<{ worker: WorkerProfile; billableOverage: boolean }> {
  // Config dirs whose unconfirmed "not logged in" this pick believes no more (liveRecheckExpiredLogins).
  const believed = new Set<string>();
  try {
    return pickWorker(workers, preferred, attempted, requestedModel, cache, overageAllowed, frontierGuardBlocks, believed);
  } catch (err) {
    if (!(err instanceof ExpiredLoginBlock)) {
      throw err;
    }
    const recheck = await liveRecheckExpiredLogins(err.candidates, err.kind, cache, probedDirs, believed);
    if (!recheck.recovered) {
      throw new Error(err.message + recheck.note);
    }
    try {
      return pickWorker(workers, preferred, attempted, requestedModel, cache, overageAllowed, frontierGuardBlocks, believed);
    } catch (retryErr) {
      // Still blocked on a login: the accounts that recovered were not enough (they
      // may be exhausted, or other blockers remain). Carry the probe findings so the
      // caller is not told to re-login an account we just proved is fine.
      throw retryErr instanceof ExpiredLoginBlock
        ? new Error(retryErr.message + recheck.note)
        : retryErr;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Bookkeeping — written best-effort, never part of a task's outcome
 * ------------------------------------------------------------------------- */

/*
 * WHAT A TASK'S OUTCOME IS, AND WHAT IS ONLY A RECORD OF IT.
 *
 * A dispatch succeeded when its worker handed back a result, and failed with whatever its worker
 * failed with. What the cores write down afterwards is a record of that: the per-worker counters
 * in stats.json (recordSuccess / recordFailure), the quota cooldown that rides in the same
 * entry, and the terminal event in the task log. None of them can change what happened, so none
 * of them may change what the caller is told happened.
 *
 * They could. stats.json is written under the registry's file lock, and a writer that cannot
 * get that lock THROWS after 15 s (through 1.x it broke the lock and went in). Both cores made
 * these writes inside the `try` whose `catch` means "this attempt failed", so one process
 * holding the lock too long turned a finished task into a failed attempt: counted against the
 * worker; failed over to a second account whenever the lock error's text happened to hold
 * "429" (the quota classifier reads a pid or a path like any other text); or thrown out of the
 * core with no terminal event at all, once recordFailure had waited out the same lock. A real
 * failure fared no better — its own message was replaced by the lock's.
 *
 * TaskBookkeeping is the ONLY way a core writes those records. A write that throws changes
 * nothing about the task and is said three times: on stderr at once, in the task's output file,
 * and as a trailing `note:` line of the tool result.
 *
 * The same holds for three more things a core writes once an outcome exists, each of which could
 * replace that outcome with its own error when it was a bare call: the task's final OUTPUT FILE
 * (a full disk or a path that is no longer a file threw out of the DONE writer and turned a
 * finished task into a failed attempt; out of the FAILED writer it replaced the worker's failure
 * with an errno and left the task `running` in the log); the `running` event that says a task
 * is moving on to its next account; and the login state filed for another vendor's account
 * after a run proved it.
 *
 * AND A WRITE THAT CANNOT SUCCEED IS NOT RETRIED BY EVERY TASK. A stats write waits for the
 * registry's lock synchronously, for up to 15 s, with the whole server parked behind it. One
 * stuck lock used to cost that wait once per finishing task — a batch of twenty stalled the
 * server for five minutes while it learned the same thing twenty times. After ONE stats write
 * is refused because the lock could not be taken, this process makes no stats write for
 * STATS_LOCK_PAUSE_MS: each write in that time is skipped, at once, and reported exactly as a
 * lost write is — with the reason that it was skipped. A quota cooldown that is skipped is held
 * in memory like any other that could not be written.
 */

/**
 * Longest reason quoted from a record that could not be written, in UTF-16 code units. Sized to
 * the lock's own message, which is several sentences of recovery advice that END in the path of
 * the lock file — the one thing a reader needs in order to act on it — so the cap has to clear
 * the advice plus a long path, not merely a sentence.
 */
const UNRECORDED_REASON_MAX = 1000;

/**
 * Quota cooldowns this process could NOT write to stats.json: worker name → epoch-ms end.
 *
 * A cooldown is the one piece of bookkeeping with a safety role — it is what keeps automatic
 * assignment off an account that has just said it is out of quota. When the write is lost the
 * cooldown is kept here for the rest of this process's life, so THIS server at least does not
 * pick the account again; another window's server and a detached task read stats.json only and
 * still may (the tool result says so). Entries are never removed: one that has passed reads as
 * no cooldown, exactly like a passed `cooldownUntil` in the file.
 */
const unrecordedCooldowns = new Map<string, number>();

/** How long this process makes no stats write after one was refused by a lock timeout. */
const STATS_LOCK_PAUSE_MS = 60_000;

/**
 * When the stats lock was last found stuck by this process (epoch ms), 0 when it never was.
 * Process-wide on purpose: the lock is one file, and every task of this process waits on it.
 */
let statsLockStuckAt = 0;

/**
 * Whether `err` is the registry's lock giving up after its full wait — the one failure of a
 * stats write that COST the wait, and so the only one worth not repeating. Asked of the registry
 * (isStateWriteRefusal), then narrowed to the lock's own message by the prefix that module
 * documents for the purpose: its other refusal ("Could not read …") is answered at once and
 * stalls nobody.
 */
function isLockTimeout(err: unknown): boolean {
  return isStateWriteRefusal(err) && err instanceof Error && err.message.startsWith('Could not lock ');
}

/**
 * A worker's cooldown end in epoch ms, 0 when it has none: the later of what stats.json holds
 * and what this process could not write there. The one reader for selection and for
 * list_workers, so the two cannot disagree about who is cooling down.
 *
 * By OWN entry (ownEntry): a worker may be named `constructor`, and `stats.constructor` is not
 * anybody's stats.
 */
export function workerCooldownUntil(stats: StatsFile, name: string): number {
  return Math.max(ownEntry(stats, name)?.cooldownUntil ?? 0, unrecordedCooldowns.get(name) ?? 0);
}

/** Why a record could not be written: the error's own text as one bounded line. Total. */
function unrecordedReason(err: unknown): string {
  const flat = flattenOneLine(err instanceof Error ? err.message : err);
  if (flat === '') {
    return 'no reason was given';
  }
  return flat.length <= UNRECORDED_REASON_MAX ? flat : `${sliceOneLine(flat, UNRECORDED_REASON_MAX)}…`;
}

/** `reason` closed as a sentence, for when another one follows it (the lock's message ends in a path). */
function asSentence(reason: string): string {
  return /[.!?…]$/.test(reason) ? reason : `${reason}.`;
}

let stderrGuarded = false;

/**
 * One diagnostic line on stderr. The dispatch cores write nothing else there; the session-worker
 * modules report their own one-line problems the same way. Never throws.
 *
 * The guard is for a stderr nobody reads any more: a pipe whose reader has gone reports EPIPE
 * as an 'error' event on the stream, later, and an unhandled one ends the process. A diagnostic
 * about a record must not be able to do what the record itself is no longer allowed to.
 */
function warnOnStderr(line: string): void {
  try {
    if (!stderrGuarded) {
      stderrGuarded = true;
      process.stderr.on('error', () => undefined);
    }
    process.stderr.write(`${line}\n`);
  } catch {
    // no stderr to write to — the output file and the tool result still say it
  }
}

/**
 * The records ONE dispatch writes about itself, each attempted and none able to throw. See the
 * note above for what counts and why.
 *
 * How a core uses it: `recordSuccess` / `recordFailure` where it used to call the bare
 * functions; `finalOutput` for the DONE or FAILED rewrite of the output file; `terminalEvent`
 * for the task's last event and `progressEvent` for a failover note before it; `providerLogin`
 * for what a run proved about another vendor's login; `annotate` once the output file has had
 * its final rewrite (the DONE and FAILED writers replace the whole file, so a line appended any
 * earlier would be lost); `resultNote` on the end of whatever the caller is handed — the result
 * text, or the failure message.
 */
export class TaskBookkeeping {
  /** Lines for the output file that `annotate` has not appended yet. */
  private unwritten: string[] = [];
  /** Why stats could not be written — the first such reason; undefined while every write landed. */
  private statsReason: string | undefined;
  /** Why the terminal event could not be appended; undefined when it was. */
  private eventReason: string | undefined;
  /** Why the final output file could not be written; undefined when it was. */
  private fileReason: string | undefined;
  /** Why a login state could not be filed in the usage cache — the first such reason. */
  private loginReason: string | undefined;
  /**
   * How the task had ALREADY been closed in the log when this dispatch came to record its own
   * outcome (a cancel from the editor, a settle): that record's status and reason. Undefined
   * when this dispatch's terminal event is the task's.
   */
  private closedBy: { status: string; reason: string } | undefined;
  /** Quota cooldowns that exist only in this process's memory because their write was lost. */
  private readonly heldCooldowns: Array<{ worker: string; until: number }> = [];

  /**
   * `outlivesTask` is whether this process is still there to honour a cooldown it could only
   * keep in memory: true for the dispatch server, false for a detach supervisor, which exits
   * with its one task. It changes one sentence of the note and nothing else.
   */
  constructor(
    private readonly taskId: string,
    private readonly outlivesTask: boolean,
  ) {}

  /** Report one record that was not written, everywhere it is said. Returns `reason`. */
  private unrecorded(what: string, reason: string): string {
    const line = flattenOneLine(`NOT RECORDED: ${what} — ${reason}`);
    this.unwritten.push(`${line} (${new Date().toISOString()})`);
    warnOnStderr(`cco-dispatch: task ${flattenOneLine(this.taskId)}: ${line}`);
    return reason;
  }

  /** Run one write. Returns undefined when it landed, else why it did not — already reported. */
  private attempt(what: string, write: () => void): string | undefined {
    try {
      write();
      return undefined;
    } catch (err) {
      return this.unrecorded(what, unrecordedReason(err));
    }
  }

  /**
   * `attempt` for a write to stats.json, which is the one record here that waits for a lock.
   * While the lock is known to be stuck (see the note above) the write is not tried at all: it
   * is reported as skipped, with the same NOT RECORDED line a lost write gets. A write that is
   * tried and refused by the lock's timeout is what starts that pause.
   */
  private attemptStats(what: string, write: () => void): string | undefined {
    const sinceStuck = Date.now() - statsLockStuckAt;
    if (statsLockStuckAt > 0 && sinceStuck >= 0 && sinceStuck < STATS_LOCK_PAUSE_MS) {
      return this.unrecorded(
        what,
        `skipped: the stats lock was found stuck ${Math.round(sinceStuck / 1000)}s ago, and after that ` +
          `${this.outlivesTask ? 'this server' : "this task's supervisor"} writes no stats for ` +
          `${STATS_LOCK_PAUSE_MS / 1000}s, so that one stuck lock stalls it once and not once per task`,
      );
    }
    let lockTimedOut = false;
    const reason = this.attempt(what, () => {
      try {
        write();
      } catch (err) {
        lockTimedOut = isLockTimeout(err);
        throw err;
      }
    });
    if (lockTimedOut) {
      statsLockStuckAt = Date.now();
    }
    return reason;
  }

  /** Count a finished task in the worker's stats. */
  recordSuccess(worker: string, run: RunResult): void {
    const reason = this.attemptStats(`the success of this task in the stats of worker ${worker}`, () =>
      recordSuccess(worker, run),
    );
    this.statsReason = this.statsReason ?? reason;
  }

  /**
   * Count a failed attempt in the worker's stats and, for a quota failure, start its cooldown.
   * A cooldown whose write is lost — or skipped — is kept in memory (unrecordedCooldowns), after
   * ANY throw, including the lock's "removed while held" one, where the write was made but may
   * not have survived: holding a cooldown that is also on disk costs nothing.
   */
  recordFailure(worker: string, message: string, quota: boolean, cooldownMinutes: number): void {
    const reason = this.attemptStats(
      `the failure of this task${quota ? ', and the quota cooldown it starts,' : ''} in the stats of worker ${worker}`,
      () => recordFailure(worker, message, quota, cooldownMinutes),
    );
    if (reason === undefined) {
      return;
    }
    this.statsReason = this.statsReason ?? reason;
    const until = Date.now() + cooldownMinutes * 60_000;
    if (quota && Number.isFinite(until)) {
      unrecordedCooldowns.set(worker, Math.max(unrecordedCooldowns.get(worker) ?? 0, until));
      this.heldCooldowns.push({ worker, until });
    }
  }

  /**
   * Start the quota cooldown of a worker that did NOT run: another registry name of the same
   * account as the worker whose quota a team turn just hit (team contract §6.5 step 1, M3 — two
   * entries on one login are one identity, and a cooldown on only one of them would have the next
   * routing pick the other into the same wall). Nothing else of that worker's stats changes: it
   * failed nothing. A lost or skipped write is held in memory exactly as recordFailure's is. No
   * dispatch path calls this; it exists for recordTurnBookkeeping.
   */
  recordCooldown(worker: string, cooldownMinutes: number): void {
    const reason = this.attemptStats(
      `the quota cooldown of worker ${worker} (the same account as the worker that hit its limit)`,
      () => recordCooldown(worker, cooldownMinutes),
    );
    if (reason === undefined) {
      return;
    }
    this.statsReason = this.statsReason ?? reason;
    const until = Date.now() + cooldownMinutes * 60_000;
    if (Number.isFinite(until)) {
      unrecordedCooldowns.set(worker, Math.max(unrecordedCooldowns.get(worker) ?? 0, until));
      this.heldCooldowns.push({ worker, until });
    }
  }

  /**
   * Append the task's TERMINAL event. That event is the record of the outcome, not bookkeeping
   * — which is exactly why failing to write it must not rewrite the outcome: a `done` that
   * could not be appended used to be caught as a failed attempt of the task it was reporting.
   * It throws when the log refuses the write (registry.appendTaskEvent). The task log then still
   * says `running`, and the note says so in capitals rather than leaving the caller to find out.
   *
   * AT MOST ONE TERMINAL EVENT PER TASK. The append goes through
   * registry.appendTerminalTaskEvent: under the task's lock, and only when the task has none
   * yet. Another surface may have closed the task while its worker ran — a cancel from the
   * editor is recorded the moment it is asked for — and a second terminal event after that one
   * would make the log say two things about one task, with every reader left to pick. When that
   * has happened nothing is appended and the outcome is unchanged: the caller still gets the
   * result (or the failure) this dispatch produced, with a note that the log records the task
   * as it was closed first. (A lock that cannot be had does not stop the append: the registry
   * then writes without it.)
   */
  terminalEvent(event: TaskEvent): void {
    this.eventReason = this.attempt(`this task's terminal "${event.status}" event in the task log`, () => {
      const wrote = appendTerminalTaskEvent(event);
      if (!wrote.closed && wrote.final !== undefined) {
        const final = wrote.final as unknown as { status?: unknown; error?: unknown };
        this.closedBy = {
          status: typeof final.status === 'string' ? sliceOneLine(flattenOneLine(final.status), 16) : 'closed',
          reason: typeof final.error === 'string' ? sliceOneLine(flattenOneLine(final.error), 200) : '',
        };
        const line = flattenOneLine(
          `NOT RECORDED: this task's terminal "${event.status}" event — the task log already ` +
            `recorded the task as ${this.closedByText()}, and a task is closed once`,
        );
        this.unwritten.push(`${line} (${new Date().toISOString()})`);
      }
    });
  }

  /** `closedBy` in words: `error ("cancelled by user")`, `done`. */
  private closedByText(): string {
    const closed = this.closedBy;
    if (closed === undefined) {
      return '';
    }
    return closed.reason === '' ? closed.status : `${closed.status} ("${closed.reason}")`;
  }

  /**
   * Append a `running` event that says the task is moving on to its next account. The task's
   * state is unchanged by it — it was running and still is — so a log that refuses the line
   * costs a progress note and nothing else: the failover it describes goes ahead.
   */
  progressEvent(event: TaskEvent): void {
    this.attempt(`a progress note of this task in the task log ("${flattenOneLine(event.error ?? event.status)}")`, () =>
      appendTaskEvent(event),
    );
  }

  /**
   * Replace the task's output file with its FINAL text — the DONE or the FAILED form. `compose`
   * builds that text, and runs inside the same guard as the write: a file that cannot be
   * written, for whatever reason, leaves the outcome exactly what it was. The file then still
   * shows the task as running (or is missing), which the note says.
   */
  finalOutput(outputFile: string, compose: () => string): void {
    this.fileReason = this.attempt("this task's final output file", () => {
      // Written by task ID through the registry's writer, which REPLACES whatever is at the
      // report's name instead of opening it: a symbolic link or an unread FIFO put there while
      // the task ran can neither redirect this text nor block this thread (registry.writeTaskFile).
      // `outputFile` is that same report's path — the one the callers go on to annotate. A
      // refusal is thrown, so it becomes this record's "not written" note like any write error.
      const wrote = writeTaskFile(this.taskId, 'output', compose());
      if (!wrote.ok) {
        throw new Error(wrote.detail);
      }
    });
  }

  /**
   * File what a run just PROVED about the login of an account: `false` — the run failed because
   * the account is not logged in — or `true` — a run on it succeeded. On another vendor's account
   * that is its run-proved verdict and what ends one (usage.runLoginFailureAt); on a Claude Code
   * account it is a login probe of the run (usage.recordClaudeRunLogin: `ok`, or `loggedOut` at
   * once — Login state (CA)). The usage-cache writers swallow their own failures; the guard is for
   * the day one of them does not.
   */
  providerLogin(worker: Pick<WorkerProfile, 'name' | 'configDir'> & { provider?: unknown }, loggedIn: boolean): void {
    const account = { name: worker.name, configDir: worker.configDir };
    let claude: boolean;
    try {
      claude = workerProvider(worker as Pick<WorkerProfile, 'name' | 'configDir' | 'provider'>) === 'claude';
    } catch {
      claude = false;
    }
    const reason = this.attempt(
      `that the login of worker ${worker.name} ${loggedIn ? 'works' : 'failed'}, in the usage cache`,
      () =>
        claude
          ? recordClaudeRunLogin(account, loggedIn)
          : loggedIn
            ? recordProviderRunSucceeded(account)
            : recordProviderRunLoginFailure(account),
    );
    this.loginReason = this.loginReason ?? reason;
  }

  /**
   * Append what could not be recorded to the task's output file, one line per record. Call it
   * AFTER the file's final writer. Never throws; a no-op when there is nothing to say.
   */
  annotate(outputFile: string): void {
    if (this.unwritten.length === 0) {
      return;
    }
    appendOutputNote(outputFile, `\n\n---\n\n${this.unwritten.join('\n')}\n`);
    this.unwritten = [];
  }

  /**
   * What the caller's text gains: '' when every record was written, else a blank line and one
   * `note:` line per kind of record that was not — never anything in front of the result's own
   * header lines.
   */
  resultNote(): string {
    const notes: string[] = [];
    if (this.statsReason !== undefined) {
      const cooldown = this.cooldownSentence();
      notes.push(
        'note: stats for this task were not recorded — ' +
          (cooldown === '' ? this.statsReason : `${asSentence(this.statsReason)} ${cooldown}`),
      );
    }
    if (this.closedBy !== undefined) {
      notes.push(
        `note: the task log records this task as ${this.closedByText()} — it was closed there ` +
          'before this outcome was ready, and a task is closed once. This text is the outcome.',
      );
    }
    if (this.eventReason !== undefined) {
      notes.push(
        `note: the outcome of this task was NOT written to the task log — ${asSentence(this.eventReason)} ` +
          (this.fileReason === undefined
            ? 'The log still shows the task as running; this text and its output file are the record.'
            : 'The log still shows the task as running; this text is the record.'),
      );
    }
    if (this.fileReason !== undefined) {
      notes.push(
        `note: the output file of this task was NOT written — ${asSentence(this.fileReason)} ` +
          'That file is missing or still shows the task as running; this text is the record.',
      );
    }
    if (this.loginReason !== undefined) {
      notes.push(`note: the login state of the account was not recorded — ${this.loginReason}`);
    }
    return notes.length === 0 ? '' : `\n\n${notes.join('\n')}`;
  }

  /** The sentence about cooldowns that were lost with the stats, '' when none was. */
  private cooldownSentence(): string {
    if (this.heldCooldowns.length === 0) {
      return '';
    }
    const names = this.heldCooldowns
      .map((c) => `${flattenOneLine(c.worker)} (until ${new Date(c.until).toLocaleTimeString()})`)
      .join(', ');
    return this.outlivesTask
      ? `The quota cooldown of ${names} is held in this server's memory only: this server will ` +
          'not auto-assign that account until then, but other servers and detached tasks still may.'
      : `The quota cooldown of ${names} was not recorded either, so automatic assignment may ` +
          'pick that account again before its limit resets.';
  }
}

function recordSuccess(name: string, run: RunResult): void {
  // updateStats holds the stats.json advisory lock across the read-modify-write, so
  // concurrent detach supervisors never lose an increment (contract R4).
  updateStats((stats) => {
    // Read and stored as the map's OWN entry: for a worker named `__proto__` a plain
    // `stats[name]` is Object.prototype, and the increments below would land on it.
    const s = ownEntry(stats, name) ?? emptyStats();
    s.tasks++;
    s.inputTokens += run.inputTokens;
    s.outputTokens += run.outputTokens;
    s.costUsd += run.costUsd;
    s.lastUsedAt = Date.now();
    s.lastError = undefined;
    setOwnEntry(stats, name, s);
  });
}

function recordFailure(name: string, message: string, quota: boolean, cooldownMinutes: number): void {
  updateStats((stats) => {
    const s = ownEntry(stats, name) ?? emptyStats();
    s.errors++;
    s.lastUsedAt = Date.now();
    s.lastError = message.slice(0, 300);
    if (quota) {
      s.cooldownUntil = Date.now() + cooldownMinutes * 60_000;
    }
    setOwnEntry(stats, name, s);
  });
}

/** A quota cooldown alone (TaskBookkeeping.recordCooldown): never shortens one already running. */
function recordCooldown(name: string, cooldownMinutes: number): void {
  updateStats((stats) => {
    const s = ownEntry(stats, name) ?? emptyStats();
    s.cooldownUntil = Math.max(s.cooldownUntil ?? 0, Date.now() + cooldownMinutes * 60_000);
    setOwnEntry(stats, name, s);
  });
}

/** A count from a vendor's stream, by value: finite and not negative, else 0 (stats are sums). */
function turnCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Record a finished TEAM TURN exactly as dispatch records the same outcome of a one-shot run (team
 * contract §6.5 step 1, M1) — through TaskBookkeeping, so a write that cannot land changes nothing
 * about the turn and is reported instead:
 *
 *  - `ok` → recordSuccess with the turn's tokens and cost (a vendor that reports no cost: 0, as
 *    dispatch records a provider run); for a non-Claude account also "this login works"
 *    (providerLogin true), which ends a logged-out verdict a failed run filed;
 *  - `quota` → recordFailure with the quota cooldown on the worker that ran, and the cooldown
 *    alone on EVERY other registry name of its identity (`worker.identityNames`, M3);
 *  - `auth` → recordFailure without a cooldown, and the login verdict: providerLogin(worker,
 *    false) — for another vendor's account the run-proved logged-out reading; for a Claude account
 *    that call files nothing (usage refuses a Claude dir), because the verdict that decided `auth`
 *    is the live probe's, which the probe already filed (M14);
 *  - `error`, `timeout`, `crashed`, `memory`, `context`, `resume-failed` → recordFailure, no
 *    cooldown — dispatch counts its timeouts, kills and CLI failures the same way;
 *  - `interrupted` (the engine stopped it) and `cancelled` (stopped from outside the engine) →
 *    nothing: a stop is not the account's failure — dispatch's abort and closed-elsewhere paths.
 *    CONTRACT-AMBIGUITY: §6.5 spells quota, auth and ok; the other outcomes follow "exactly as
 *    dispatch records the same failure".
 *
 * `outcome` takes a team/contract TurnOutcome as it is, plus the turn's id (`{ ...outcome, turnId
 * }`), which names the turn in a NOT RECORDED line. Returns undefined when every record was
 * written, else the `note:` lines saying what was not (for the team's `store.warning`). Never
 * throws.
 */
export function recordTurnBookkeeping(
  worker: Pick<WorkerProfile, 'name' | 'configDir' | 'provider'> & {
    /** M3: every registry name of this worker's identity (team routing decides them); the worker's own may be among them. */
    identityNames?: readonly string[];
  },
  outcome: {
    turnId: string;
    outcome:
      | 'ok'
      | 'error'
      | 'quota'
      | 'auth'
      | 'timeout'
      | 'interrupted'
      | 'crashed'
      | 'cancelled'
      | 'context'
      | 'resume-failed'
      | 'memory';
    text: string;
    tokens: { in: number; out: number };
    costUsd?: number;
    modelUsed?: string;
    note?: string;
    stderrTail?: string;
  },
  cooldownMinutes: number,
): string | undefined {
  try {
    const books = new TaskBookkeeping(outcome.turnId, true);
    const provider = workerProvider(worker);
    switch (outcome.outcome) {
      case 'ok':
        books.recordSuccess(worker.name, {
          text: outcome.text,
          inputTokens: turnCount(outcome.tokens?.in),
          outputTokens: turnCount(outcome.tokens?.out),
          costUsd: turnCount(outcome.costUsd),
          modelUsed: outcome.modelUsed,
        });
        if (provider !== 'claude') {
          books.providerLogin(worker, true);
        }
        break;
      case 'interrupted':
      case 'cancelled':
        break;
      default: {
        const quota = outcome.outcome === 'quota';
        const detail = flattenOneLine(outcome.note || outcome.text || outcome.stderrTail || '');
        books.recordFailure(
          worker.name,
          `team turn ${outcome.outcome}${detail === '' ? '' : `: ${detail}`}`,
          quota,
          cooldownMinutes,
        );
        if (quota) {
          for (const name of new Set(worker.identityNames ?? [])) {
            if (name !== worker.name) {
              books.recordCooldown(name, cooldownMinutes);
            }
          }
        }
        if (outcome.outcome === 'auth') {
          books.providerLogin(worker, false);
        }
      }
    }
    const note = books.resultNote().trim();
    return note === '' ? undefined : note;
  } catch (err) {
    // TaskBookkeeping's writers do not throw; this is for the day one of them does.
    return `note: the bookkeeping of turn ${flattenOneLine(outcome.turnId)} was not recorded — ${flattenOneLine(err instanceof Error ? err.message : err)}`;
  }
}

/* ------------------------------------------------------------------------- *
 * A Claude run of SEVERAL turns — the `result` events of one stream-json run
 * ------------------------------------------------------------------------- */

/*
 * WHY A RUN CAN HAVE MORE THAN ONE RESULT. A headless `claude -p` run answers its prompt with a
 * `result` event — and then does not necessarily end. A background task the worker started (a
 * monitor, a background shell) that finishes or expires after that answer gives the session one
 * more turn, started by the CLI's notification of it, and that turn ends with a second `result`.
 * In stream-json the run reads:
 *
 *   system/init · assistant … · result (the report) · user or system (the notification) ·
 *   assistant … · result (whatever the worker said to the notification)
 *
 * The `json` output format prints only the LAST of those, so a worker that wrote a long report
 * and then one sentence to an expired monitor was recorded as that sentence (task tmveraanutqs3,
 * 2026-10-19). A one-shot worker therefore runs in stream-json and every `result` is kept; a team
 * turn (team/driver) reads the same events off its own seam. Both compose the report here.
 *
 * WHICH TURN ANSWERED THE PROMPT. The prompt is one message on stdin, so the first `result`
 * answers it — PROVIDED each later turn shows what started it, between the result before it and
 * its first `assistant` event: a `user` event that is not only tool results, or a `system` event
 * of the background-task family (BACKGROUND_TASK_SUBTYPES). A later turn that shows neither
 * cannot be told apart, and then no result is preferred over another: all of them are kept, in
 * order.
 *
 * Measured (RO2, 2026-10-19, a background `sleep` on the real CLI): between the two results the
 * CLI printed `system/task_updated`, `system/task_notification` and
 * `system/background_tasks_changed`, and no `user` event. The same stream carries other `system`
 * events — `hook_*` (a hook ran), `thinking_tokens`, `init` — that a CLI prints whether or not a
 * background task woke the session; any of them between two results says nothing about what
 * started the second turn, so only the background-task family counts. Residual: a system subtype
 * this list does not know (a later CLI's) reads as nothing, and such a run keeps every text,
 * which loses nothing.
 *
 * WHAT THE RUN COST. `usage` is per result — the second result of the measured run carried its
 * own 2 in / 8 out alone — so tokens are summed. `total_cost_usd` is the SESSION'S running total:
 * the same run's second turn cost about $0.0005 and its result said 0.00628 against the first's
 * 0.00581. Summing it would count the first turn twice, so the cost of a run is its last
 * result's. A later total below an earlier one is never expected (it would be another session's
 * count): then the largest is taken and `costNote` says so, for the caller's diagnostics.
 */

/**
 * The `system` subtypes the CLI prints when a background task changes state — what opens a turn
 * that the prompt did not start. `task_notification` is the notification itself; the other two
 * travel with it.
 */
const BACKGROUND_TASK_SUBTYPES: ReadonlySet<unknown> = new Set(['task_notification', 'task_updated', 'background_tasks_changed']);

/** One `result` of a run, and whether the turn it ends was started by a background event. */
export interface ClaudeTurnResult {
  event: Record<string, unknown>;
  background: boolean;
}

/** What a run of one or more `result` events comes to (composeClaudeTurns). */
export interface ClaudeTurnsReading {
  /** The report, composed by the rule below. */
  text: string;
  /** The result that speaks for the run: its `is_error`, `subtype`, `modelUsage`, `subagent_stats`. */
  decisive: Record<string, unknown>;
  /** Summed over every result (`usage` is per result). */
  inputTokens: number;
  outputTokens: number;
  /** The LAST result's `total_cost_usd` — the session's running total — or the largest, see costNote. */
  costUsd: number;
  /** Set when a later result's total was below an earlier one's (never expected): a diagnostic line. */
  costNote?: string;
  /** Every result was kept because the turn that answered the prompt could not be told. */
  keptAll: boolean;
}

/**
 * The `result` events of one Claude run, in order, each with what started its turn. Fed one parsed
 * event at a time (take) or, for a line too long to parse, its type alone (takeType). Never throws.
 */
export class ClaudeTurnLog {
  readonly results: ClaudeTurnResult[] = [];
  /**
   * Between a result and the next turn's first `assistant` event: `open` while nothing has said
   * what started that turn, `background` once something has; `closed` otherwise.
   */
  private window: 'open' | 'background' | 'closed' = 'closed';

  /**
   * One parsed stdout line. An object without a `type` is the document of the `json` output
   * format — a CLI (or a stand-in) that printed one — and counts as a result.
   */
  take(event: unknown): void {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      return;
    }
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type === 'result' || type === undefined) {
      this.results.push({ event: record, background: this.window === 'background' });
      this.window = 'open';
      return;
    }
    if (this.window !== 'open') {
      return;
    }
    if (type === 'assistant') {
      this.window = 'closed';
    } else if ((type === 'system' && BACKGROUND_TASK_SUBTYPES.has(record.subtype)) || (type === 'user' && !onlyToolResults(record))) {
      this.window = 'background';
    }
  }

  /** A line that was not parsed (too long to keep): only an `assistant` one says anything here. */
  takeType(type: string): void {
    if (this.window === 'open' && type === 'assistant') {
      this.window = 'closed';
    }
  }
}

/** A `user` event whose message is nothing but tool results — the continuation of a turn, not a new one. */
function onlyToolResults(event: Record<string, unknown>): boolean {
  const message = event.message;
  const content = typeof message === 'object' && message !== null ? (message as Record<string, unknown>).content : undefined;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result')
  );
}

/** A token count or a cost of a result, by value: finite and not negative, else 0. */
function resultAmount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** What `result` says as text; '' when it is not a string. */
function resultText(event: Record<string, unknown>): string {
  return typeof event.result === 'string' ? event.result : '';
}

/**
 * THE RULE for a run of several results — the report a task, its `.md` file and dispatch_status
 * carry, and the report of a Claude team turn:
 *  - one result: its text, as always;
 *  - several, every later turn started by a background event: the text of the FIRST result (the
 *    one that answered the prompt), then, for each later result whose text is not empty and not
 *    that same text, a blank line and `[after a background task finished: <text>]`;
 *  - several, and a later turn that cannot be told: every non-empty text, in order, separated by
 *    blank lines — never the last alone.
 * Tokens are summed over every result; the cost is the last result's running total (the largest,
 * with a costNote, if a later one is lower). The result that speaks for the run's status is
 * the first in the second case and the last in the third (what a single document always was).
 * Undefined when there is no result at all. Never throws.
 */
export function composeClaudeTurns(results: readonly ClaudeTurnResult[]): ClaudeTurnsReading | undefined {
  if (results.length === 0) {
    return undefined;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let largestCost = 0;
  for (const { event } of results) {
    const usage = typeof event.usage === 'object' && event.usage !== null ? (event.usage as Record<string, unknown>) : {};
    inputTokens += resultAmount(usage.input_tokens);
    outputTokens += resultAmount(usage.output_tokens);
    largestCost = Math.max(largestCost, resultAmount(event.total_cost_usd));
  }
  const lastCost = resultAmount(results[results.length - 1].event.total_cost_usd);
  const sums = {
    inputTokens,
    outputTokens,
    costUsd: largestCost,
    ...(lastCost < largestCost
      ? { costNote: `claude results: the last total_cost_usd (${lastCost}) is below an earlier one (${largestCost}); the largest is taken` }
      : {}),
  };
  const texts = results.map((r) => resultText(r.event));
  if (results.length === 1) {
    return { text: texts[0], decisive: results[0].event, ...sums, keptAll: false };
  }
  if (results.slice(1).every((r) => r.background)) {
    const answer = texts[0];
    const later = texts
      .slice(1)
      .map((t) => t.trim())
      .filter((t) => t !== '' && t !== answer.trim())
      .map((t) => `[after a background task finished: ${t}]`);
    const text = [answer, ...later].filter((part) => part !== '').join('\n\n');
    return { text, decisive: results[0].event, ...sums, keptAll: false };
  }
  return {
    text: texts.filter((t) => t.trim() !== '').join('\n\n'),
    decisive: results[results.length - 1].event,
    ...sums,
    keptAll: true,
  };
}

/* ------------------------------------------------------------------------- *
 * The model a run REPORTS
 * ------------------------------------------------------------------------- */

/** How many entries of a result document's `modelUsage` are looked at. A run names a handful. */
const MODEL_USAGE_SCAN_MAX = 64;

/** A cost or a token count of a `modelUsage` entry, by value: finite and not negative, else 0. */
function usageAmount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** One entry of a `modelUsage` table that can be the answer: its id and what it is ranked by. */
interface UsageCandidate {
  id: string;
  cost: number;
  output: number;
}

/** The dearest of `candidates`; a tie goes to the one with more output tokens, then to the first. */
function dearest(candidates: readonly UsageCandidate[]): string | undefined {
  let best: UsageCandidate | undefined;
  for (const candidate of candidates) {
    // Strictly greater, so the entry listed first keeps a tie in both.
    if (
      best === undefined ||
      candidate.cost > best.cost ||
      (candidate.cost === best.cost && candidate.output > best.output)
    ) {
      best = candidate;
    }
  }
  return best?.id;
}

/** A model id without the context-window suffix a CLI may print after it, in lower case. */
function familyForm(id: string): string {
  return id.toLowerCase().replace(/\[1m\]$/, '');
}

/**
 * Whether a reported id belongs to the FAMILY of the model that was asked for — or undefined
 * when what was asked for names no family this code can recognise.
 *
 *  - asked for an alias (`opus`, `haiku`, …): the ids of that tier, `claude-<alias>` followed by
 *    `-`, `[` or nothing — `claude-haiku-4-5-20251001` for `haiku`, never `claude-haikuish-1`;
 *  - asked for a full Claude id: that id, or that id with more after a `-` (a dated release of
 *    it), the `[1m]` suffix aside on both sides.
 * Letter case aside throughout: an id is compared as the CLI printed it only where it is shown.
 */
function sameFamily(asked: unknown): ((reportedId: string) => boolean) | undefined {
  if (typeof asked !== 'string') {
    return undefined;
  }
  const wanted = asked.trim().toLowerCase();
  if ((MODEL_ALIASES as readonly string[]).includes(wanted)) {
    const stem = `claude-${wanted}`;
    return (id) => {
      const lower = id.toLowerCase();
      return lower.startsWith(stem) && (lower.length === stem.length || '-['.includes(lower[stem.length]));
    };
  }
  if (wanted.startsWith('claude-')) {
    const base = familyForm(wanted);
    return (id) => {
      const form = familyForm(id);
      return form === base || form.startsWith(`${base}-`);
    };
  }
  return undefined;
}

/**
 * The model id a `claude -p` run REPORTS as its MAIN model, read from the
 * result document's `modelUsage` — or undefined when it reports none this code can name.
 *
 * WHY THIS IS THE ONLY SOURCE. A dispatch asks for an alias (`opus`, `haiku`) and the worker's
 * own CLI resolves it to the newest model of that family IT knows, so which model ran depends on
 * the CLI version installed for that account — not on this product, and not on the request.
 * `modelUsage` is the CLI's own account of the run, keyed by the full id of every model it
 * called (measured on Claude Code 2.1.283: `haiku` → `claude-haiku-4-5-20251001`, `sonnet` →
 * `claude-sonnet-5`, `opus` → `claude-opus-5-5`). What is returned is therefore something the
 * CLI SAID; when it said nothing that can be told apart the answer is "unknown", never the
 * request repeated and never a guess.
 *
 * WHICH ENTRY — the main model, which is NOT the dearest one. The table lists every model the
 * run called: the main one, a small `claude-haiku-…` helper call on any run that is not haiku
 * (about 900 input and 10 output tokens), and the model of every SUBAGENT the run started. A
 * `haiku` run whose one subagent ran on sonnet lists `claude-haiku-4-5-20251001` at a cost of
 * 0.048 and `claude-sonnet-5` at 0.095 (a real document) — "the entry that cost the most" would
 * say that `haiku` ran as sonnet, and show it as what that account's default resolves to. So:
 *
 *  1. the candidates are the table's entries (see BY VALUE);
 *  2. those of the FAMILY that was asked for (sameFamily) are the main model's: among them the
 *     dearest, then the one with more output tokens, then the first — two can be there, the
 *     plain id and its `[1m]` form;
 *  3. when none is of that family and the run started NO subagent (`subagentsSpawned`, the
 *     document's `subagent_stats.spawned`, is the number 0), the CLI ran another family than it
 *     was asked for, which is worth showing: the dearest of all the candidates;
 *  4. otherwise nothing is reported. An entry of another family beside subagents may be a
 *     subagent's; a document that does not say how many it started (an older CLI) cannot rule
 *     that out either.
 *
 * `asked` is the model the CLI was handed as `--model`.
 *
 * BY VALUE, because this is JSON a child process printed. `modelUsage` must be a plain object.
 * Only its OWN keys shaped like a reported model id count (platform.REPORTED_MODEL_ID — which a
 * key of control characters, a key of kilobytes and `__proto__` all fail), and only when what
 * the key holds is itself a plain object: a key mapped to a number or a string is not a usage
 * entry. A cost or a count is taken only when it is a finite number that is not negative, and
 * reads as 0 otherwise — so `"1e9"` is not a billion and cannot outrank a real figure. The
 * subagent count is a count only when it is a finite number.
 *
 * TOTAL OVER ANYTHING `JSON.parse` CAN RETURN, which is its only input (runClaude hands it
 * fields of the parsed result document, and a model string of its own): for every such value it
 * returns an id or undefined and does not throw. It is NOT total over arbitrary JavaScript
 * values — it lists an object's keys and reads its properties, so a Proxy whose `ownKeys`
 * throws, or an object with a getter that throws, would throw out of it. Neither can come out
 * of a JSON parse.
 */
export function reportedModel(
  modelUsage: unknown,
  asked: unknown,
  subagentsSpawned: unknown,
): string | undefined {
  if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) {
    return undefined;
  }
  const candidates: UsageCandidate[] = [];
  let scanned = 0;
  for (const id of Object.keys(modelUsage)) {
    if (scanned++ >= MODEL_USAGE_SCAN_MAX) {
      break;
    }
    if (!REPORTED_MODEL_ID.test(id)) {
      continue;
    }
    const entry: unknown = (modelUsage as Record<string, unknown>)[id];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const fields = entry as Record<string, unknown>;
    candidates.push({
      id,
      cost: usageAmount(ownValue(fields, 'costUSD')),
      output: usageAmount(ownValue(fields, 'outputTokens')),
    });
  }
  const inFamily = sameFamily(asked);
  const family = inFamily === undefined ? [] : candidates.filter((candidate) => inFamily(candidate.id));
  if (family.length > 0) {
    return dearest(family);
  }
  const noSubagents =
    typeof subagentsSpawned === 'number' && Number.isFinite(subagentsSpawned) && subagentsSpawned === 0;
  return noSubagents ? dearest(candidates) : undefined;
}

/**
 * Run one worker session as a `claude -p` child.
 *
 * The command comes from resolveProbeCommand() rather than registry.claudePath:
 * this server is spawned by the CLI and routinely runs without the login-shell
 * PATH, so a bare `claude` in the registry — or an absolute path whose binary
 * moved — kills EVERY dispatch with ENOENT until some editor happens to re-sync
 * the registry. Resolving at spawn time makes dispatch independent of when the
 * last successful settings sync ran, exactly as the usage probes already are;
 * without it a self-healed usage panel would sit next to a dispatch path that
 * still fails, which is the harder failure to diagnose.
 *
 * WHAT "TIMED OUT" MEANS HERE: that this function's kill is what ended the child — never merely
 * that the limit's timer ran. The two used to be the same statement, and they are not: a timer
 * runs when the process gets to it, and a process that was stopped past the limit (SIGSTOP, a
 * debugger, a machine that stalled or slept) gets to its expired timer BEFORE it gets to the
 * news that the child exited long ago. A worker that had finished, with its whole result on the
 * pipe, was then recorded as "timed out … and was terminated" and its result thrown away. So:
 *  - the timer does not act on the spot. It lets the event loop go round once, which is where a
 *    pending exit is delivered, and only then asks whether the child is still there;
 *  - and a child that exits 0, by itself, with a complete successful result is a success even
 *    when the kill had been sent — it finished at the limit, and the CLI prints each result as
 *    ONE line, so a result that parses is a whole result.
 *
 * WHAT THE RESULT IS. The run is read in stream-json and every `result` event is kept; the text,
 * the token counts and the cost handed back are composeClaudeTurns' — the report that answered
 * the prompt, with what a turn started by a background task said after it (see "A Claude run of
 * SEVERAL turns"). A stand-in that prints one `json` document is read as a run of one result.
 *
 * Exported for the verification harness, which drives it with a limit of seconds (the dispatch
 * arguments cannot ask for less than a minute). Production code reaches it through the core.
 *
 * `taskId` is the dispatched task's id: the worker gets it in its environment as
 * DISPATCHED_TASK_ENV (contract §15.5), so a worker that reads the workspace's CLAUDE.md and
 * tries to dispatch in turn is refused — by `cco`, and by a cco-dispatch server it starts. The
 * core always passes it; a caller that does not (the harness) starts a worker without the marker.
 */
export function runClaude(
  registry: Registry,
  configDir: string,
  model: string,
  prompt: string,
  timeoutMinutes: number,
  systemPrompt?: string,
  onSpawn?: (child: ChildProcess) => void,
  taskId?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // stream-json, so every `result` of the run is seen (see "A Claude run of SEVERAL turns"); the
    // CLI refuses it under -p without --verbose. Spelled as ONE argument: the stand-in CLIs of the
    // verification harnesses tell the usage probe from a worker by a separate `stream-json`
    // argument, and the CLI's option parser reads both spellings alike.
    let args = ['-p', '--output-format=stream-json', '--verbose', '--model', model, '--permission-mode', registry.permissionMode];
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
    const claudePath = resolveProbeCommand();
    // claudeEnv, never an environment assembled by hand at this call site. It leaves the
    // config-dir variable UNSET for the CLI's default directory (exporting that path makes
    // the account read as logged out), and it strips the identity variables the
    // orchestrator's own session injected into this process — a worker is a different
    // session, usually a different account, and must not inherit that session's entrypoint,
    // messaging socket or token. `configDir` is the registry's string, passed verbatim.
    // The dispatched-worker marker goes on top of it, after the scrub: it is deliberately not a
    // session-identity variable, and nothing between here and the worker removes it.
    const env = claudeEnv(configDir);
    if (taskId !== undefined) {
      env[DISPATCHED_TASK_ENV] = taskId;
    }
    const child = spawn(claudePath, args, {
      cwd: process.cwd(),
      env,
      shell: useShell,
      detached: process.platform !== 'win32',
    });
    // Only a child that EXISTS is handed to the host. A spawn that failed (a missing binary)
    // still returns an object, with no pid and an 'error' event on its way: there is nothing in
    // it to stop, and a host that registered it would be holding — and announcing, through the
    // pid-carrying `running` event — a worker that never was.
    if (typeof child.pid === 'number') {
      onSpawn?.(child);
    }
    // Decoded by the streams, so a multi-byte character split across two pipe reads is never
    // torn, and both bounded. stdout: everything up to STDOUT_CAP_BYTES, then nothing (see the
    // 'data' handler). stderr: its end only — a diagnostic is the last thing a CLI says.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // stdout is an event stream read line by line (takeChunk below). What is held: the `result`
    // lines and the line being read when it may be one — those count against STDOUT_CAP_BYTES —
    // any other event line up to EVENT_LINE_PARSE_BYTES, long enough to be parsed and let go, and
    // the stream's end (`stdoutTail`) for the diagnostics and for a run that printed no result.
    const turns = new ClaudeTurnLog();
    let stdoutTail = new BoundedText(STDOUT_CAP_BYTES, 0);
    let keptBytes = 0;
    let line = '';
    let lineBytes = 0;
    // The line being read is another event too long to parse: dropped up to its newline.
    let skipping = false;
    const stderrKept = new BoundedText(STDERR_TAIL_BYTES, 0);
    let timedOut = false;
    // The child wrote more to stdout than is kept. Nothing further is accumulated.
    let overflowed = false;
    // The kill sequence below has begun — by the wall clock or by the output cap.
    let terminating = false;
    // Exit status captured by the 'exit' handler. The drain and reap timers
    // settle after 'exit' has fired (or, for reap, may fire before it), so they
    // rely on this rather than the 'close' event's code — 'close' may never come.
    let exitCode: number | null = null;
    // The signal that killed the child, from the same 'exit' event as exitCode.
    // 'exit' always precedes 'close', so it is populated on both settle paths.
    let exitSignal: NodeJS.Signals | null = null;
    // All timers are cleared by finish(); declared before it so the closure can
    // reach them. clearTimeout(undefined) is a legal no-op, so unarmed ones are
    // safe to clear.
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    // The limit's second look (see the timer below). Cleared with the timers.
    let limitCheck: NodeJS.Immediate | undefined;

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
      clearImmediate(limitCheck);
      fn();
    };

    // One complete stdout line. A line that is not JSON is not an event and is let go (it is in
    // stdoutTail); a `result` line stays in `turns`, so its bytes stay counted against the cap.
    const takeLine = (text: string, bytes: number): void => {
      if (text.trim() === '') {
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      const before = turns.results.length;
      turns.take(event);
      if (turns.results.length > before) {
        keptBytes += bytes;
      }
    };

    const takeChunk = (chunk: string): void => {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', start);
        const piece = nl === -1 ? chunk.slice(start) : chunk.slice(start, nl);
        if (!skipping) {
          line += piece;
          lineBytes += Buffer.byteLength(piece);
          if (lineBytes > EVENT_LINE_PARSE_BYTES && otherEventType(line) !== undefined) {
            turns.takeType(otherEventType(line) as string);
            skipping = true;
            line = '';
            lineBytes = 0;
          }
        }
        if (nl === -1) {
          return;
        }
        if (!skipping) {
          takeLine(line, lineBytes);
        }
        line = '';
        lineBytes = 0;
        skipping = false;
        start = nl + 1;
      }
    };

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
        const stderr = stderrKept.text();
        const stdout = stdoutTail.text();
        // The last line, when the stream did not end with a newline (a document printed whole).
        if (!overflowed && !skipping) {
          takeLine(line, lineBytes);
          line = '';
          lineBytes = 0;
        }
        const reading = overflowed ? undefined : composeClaudeTurns(turns.results);
        if (reading?.costNote !== undefined) {
          warnOnStderr(`runClaude: ${reading.costNote}`);
        }
        const parsed = reading?.decisive;
        // The child left by itself, cleanly, with a whole successful result: exit code 0, no
        // signal, and a result event of the CLI saying so. That is a success whatever this
        // function had decided about it in the meantime — see the note above.
        const finishedByItself =
          code === 0 && exitSignal === null && parsed !== undefined && parsed.is_error !== true && typeof parsed.result === 'string';
        if (timedOut && !finishedByItself) {
          // Before the exit-code check: a SIGKILLed child reports code null,
          // so a killed worker must produce the timeout message, not
          // "exited with code null".
          reject(new WorkerTimeoutError(timeoutMessage(timeoutMinutes, stdout, stderr)));
          return;
        }
        if (overflowed) {
          // Before the exit-code check for the same reason: this server stopped the child, and
          // a death by its SIGTERM must not read as a kill from outside. The message is a
          // literal — what was printed is gone, and none of it is quoted. A clean exit does not
          // change this one: what the cap refuses is the output, however the child ended.
          reject(new WorkerOutputOverflowError(OUTPUT_OVERFLOW_ERROR));
          return;
        }
        const usage = {
          inputTokens: reading?.inputTokens ?? 0,
          outputTokens: reading?.outputTokens ?? 0,
          costUsd: reading?.costUsd ?? 0,
        };
        if (code !== 0) {
          // Only SIGTERM/SIGKILL: those are the signals a cancel or an OS kill
          // sends. A SIGSEGV/SIGABRT death is a genuine worker fault and must
          // keep failing over and recording as before. The timedOut branch
          // above already claimed the kills this server sent itself.
          if (exitSignal === 'SIGTERM' || exitSignal === 'SIGKILL') {
            reject(
              new WorkerKilledError(
                `Worker was terminated externally (SIGTERM/SIGKILL) — most likely cancelled from the ` +
                  `editor UI or killed by the OS — after ${stdout.length}/${stderr.length} chars of ` +
                  `output. Not a worker fault; not retried.\n\n` +
                  `${streamSection('stdout', stdout)}\n${streamSection('stderr', stderr)}`,
              ),
            );
            return;
          }
          // The result events, as the CLI printed them, rather than the head of the stream: what
          // the CLI said about its failure (a login or a plan limit) is in them.
          const said = turns.results.length > 0 ? turns.results.map((r) => JSON.stringify(r.event)).join('\n') : stdout;
          reject(new WorkerCliFailure(`Worker exited with code ${code}: ${(stderr || said).slice(0, 2000)}`));
          return;
        }
        if (parsed?.is_error) {
          reject(
            new WorkerCliFailure(`Worker error (${String(parsed.subtype ?? 'unknown')}): ${resultText(parsed)}`.slice(0, 2000)),
          );
          return;
        }
        // Only here, on the success path: the model a run reports is read from the result
        // document of a run that finished, and a run that failed has none to speak of. The key
        // is left off entirely when nothing was reported, so a result reads as it always did.
        // `model` is what this function handed the CLI as `--model`; the subagent count is
        // taken by value from wherever the document keeps it, or is not a count at all.
        const delegated: unknown = parsed?.subagent_stats;
        const subagentsSpawned: unknown =
          typeof delegated === 'object' && delegated !== null && !Array.isArray(delegated)
            ? ownValue(delegated, 'spawned')
            : undefined;
        const modelUsed = reportedModel(parsed?.modelUsage, model, subagentsSpawned);
        resolve({
          // A run with no result string (a stream with no result event, a document without one)
          // hands back what it printed, as a document without a result always did.
          text: reading !== undefined && typeof parsed?.result === 'string' ? reading.text : stdout.trim(),
          ...usage,
          ...(modelUsed !== undefined ? { modelUsed } : {}),
        });
      });
    };

    // THE kill sequence of a worker this server decides to stop — one, for both of its reasons
    // (the wall clock and the output cap), so the two can never stop a worker differently. It
    // never settles the Promise directly: it kills the child and lets 'close' / 'exit' build
    // the rejection. Bound: SIGTERM → (10 s KILL_GRACE) SIGKILL → (5 s REAP_GRACE) forced
    // settle, so a stopped dispatch returns at most 15 s after the decision. Idempotent: the
    // reason that came first is the one the run fails with, and the second starts nothing.
    const terminateTree = (): void => {
      if (terminating) {
        return;
      }
      terminating = true;
      // Whole tree, not the direct child: a worker runs its own dispatch
      // server and may have sub-workers, and signalling the parent alone
      // leaves them orphaned and burning quota — unreachable afterwards,
      // because signalTree() short-circuits once the child itself has exited.
      signalTree(child, 'SIGTERM');
      // A tree that ignores or is slow to handle SIGTERM would otherwise
      // survive as orphans while this server has moved on.
      killTimer = setTimeout(() => {
        signalTree(child, 'SIGKILL');
        // Last-resort guarantee: if neither 'close' nor 'exit' settles us
        // (e.g. the child is wedged uninterruptibly), force the rejection so
        // the dispatch always returns.
        reapTimer = setTimeout(() => settle(exitCode, true), REAP_GRACE_MS);
      }, TIMEOUT_KILL_GRACE_MS);
    };

    // The wall clock. The stdout accumulated up to the kill reaches the error message, which
    // is why this only starts the sequence. A dispatch that timed out returns at most 15 s
    // after its deadline.
    timer = setTimeout(
      () => {
        // NOT YET. An expired timer says the limit has passed; it does not say the child is
        // still running — after a stall this callback runs before the loop has delivered an
        // exit that happened long ago. One turn of the loop delivers it, so the question is
        // asked after that turn, of what is true then.
        limitCheck = setImmediate(() => {
          if (settled || terminating) {
            // Settled; or already being stopped for its output, which is what it fails with.
            return;
          }
          if (exitCode !== null || exitSignal !== null || child.exitCode !== null || child.signalCode !== null) {
            // The child has exited by itself. Nothing is killed, and nothing "timed out":
            // the exit that is on its way to 'close' says what the run was.
            return;
          }
          timedOut = true;
          terminateTree();
        });
      },
      // clamped upstream, so always inside setTimeout's 32-bit delay range
      timeoutMinutes * 60_000,
    );

    child.stdout.on('data', (chunk: string) => {
      if (overflowed) {
        // Still read, and dropped: a child blocked on a full pipe could not act on SIGTERM.
        return;
      }
      stdoutTail.push(chunk);
      takeChunk(chunk);
      if (skipping || keptBytes + lineBytes <= STDOUT_CAP_BYTES) {
        return;
      }
      overflowed = true;
      if (!terminating) {
        // The output cap. What was accumulated is let go of at once — it cannot be a result
        // any more — and the worker is stopped rather than left to finish: it is still
        // billing, and nothing it goes on to print will be read.
        stdoutTail = new BoundedText(0, 0);
        turns.results.length = 0;
        line = '';
        terminateTree();
      }
      // Otherwise the wall clock got there first: the run fails as a timeout, with what was
      // captured up to here.
    });
    child.stderr.on('data', (chunk: string) => stderrKept.push(chunk));
    child.on('error', (err) => {
      finish(() => reject(new Error(`Failed to start "${claudePath}": ${err.message}`)));
    });
    // 'exit' fires when the process itself dies, regardless of who still holds
    // its stdio pipes. It is the event that actually tells us the worker is
    // gone. 'close' is preferred (below) because it guarantees stdout is
    // complete, but a grandchild that inherited the stdout pipe can hold it
    // open forever, so 'close' may never arrive. Arm a short drain: if 'close'
    // beats it, finish's guard makes this a no-op; if not, we settle with
    // whatever stdout accumulated.
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
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

/**
 * Signal a worker's entire process tree — the timeout path's own kill helper,
 * mirroring the server's signalTree. A worker inherits the workspace `.mcp.json`,
 * so it spawns its own dispatch server and may delegate further: signalling the
 * child alone leaves the grandchildren alive as orphans (PPID 1), burning quota.
 * Children are spawned `detached`, so on POSIX the child is its own process-group
 * leader and `-pid` reaches every process below it. Never throws.
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

/* ------------------------------------------------------------------------- *
 * Output-file HEADER composition — a summary for HUMANS, and nothing else
 * ------------------------------------------------------------------------- */

/*
 * WHAT `tasks/<id>.md` IS, AND WHAT IT IS NOT.
 *
 * The file the writers below compose is a human-readable record of one dispatch: a `# <title>`
 * line, a short block of `- <key>: <value>` summary lines, a `---` rule, then the quoted body
 * (the dispatched prompt, the worker's report, any note appended later).
 *
 * NOTHING MACHINE-READABLE MAY EVER BE INFERRED FROM THIS FILE AGAIN — not completion, not
 * usage, not status, not identity. The reason is one sentence: the file quotes arbitrary text,
 * so every shape a parser could key on (a `- key: value` line, a `---` rule, a token count) can
 * equally be written by a dispatched prompt or a worker's report — both copied in verbatim,
 * newlines and all — or, on the title line, by an operator's title, and no parser can tell the
 * writer's bytes from the quoted ones. Machine evidence lives in records
 * this process owns end to end — `tasks/<id>.result.json` and the mesh channel of record — and
 * the reconciler's ladder is exactly those, then the recovery hook, then `orphaned`. Four
 * hostile review rounds produced four separate forged-completion defects against the older
 * belief that this file was evidence; the reader that held that belief has been deleted.
 *
 * WHY THERE IS NO HEADER MARKER ANY MORE. This block used to open with a versioned token
 * (`- header: writer/1`) whose entire job was to let `registry.completedOutputUsage` say "these
 * lines were composed by the writers". That reader is gone and the token was left reading to
 * nobody. It has been REMOVED rather than kept, because an unread token is not inert: it
 * advertises a machine contract, and the next maintainer who wants one will find it, assume it
 * still means something, and rebuild the deleted heuristic on top of it — which is precisely the
 * mistake this file's history is made of. Its absence forces that maintainer to ask where the
 * evidence actually lives.
 *
 * IF A MACHINE READER IS EVER GENUINELY NEEDED HERE, the marker alone is not what would have to
 * come back — all of it would: (1) the token itself, emitted as the FIRST `- ` line, a position
 * no interpolated value can reach; (2) a written bump discipline for its version suffix, so a
 * changed header shape is distinguishable rather than silently assumed; (3) the guarantee
 * headerText() still happens to provide — no interpolated value contains a line terminator or a
 * control character, so none can open a second line or form a `\n\n---\n` rule — restated as a
 * contract a reader depends on, and tested as one, rather than as hygiene; (4) a bounded read window with HEADER_TEXT_MAX sized to it, so a
 * long value cannot push the rule out of view; and (5) the FAILED writer's deliberate refusal to
 * emit the token, because a run that never completed has no block to vouch for. The honest
 * answer is not to do any of that: add the field to `result.json`, which this process writes
 * whole and which quotes nothing.
 *
 * WHAT THE HELPERS BELOW ARE FOR NOW. headerText() and headerNumber() are DISPLAY hygiene, not a
 * parser boundary. They serve the human reading the markdown and every surface that echoes a
 * header value back: the dashboard webview, the task-tree label, `mesh_status` text, and the
 * whole-file body `dispatch_status` hands back as a JSON string. What they guarantee to those
 * readers is narrow and total — whatever a caller supplies, the value lands as ONE line of
 * well-formed, left-to-right, control-free text of bounded length, and composing it never
 * throws. What they do not guarantee is anything about the value's MEANING.
 */

/**
 * Longest interpolated header value, in UTF-16 code units. 300 matches the promptPreview and
 * lastError caps used elsewhere in this file. The bound is READABILITY, not safety: a summary
 * line is a line, and a title long enough to bury the rest of the block — or to arrive as one
 * unbroken row in a tree label or a webview cell — has stopped summarising anything. At most six
 * interpolated values appear in one block (the `--bg` DONE writer's: title, account, model,
 * worker name, worktree, branch), so bounding each of them keeps the whole thing scannable at a
 * glance. It is load-bearing for no parser, because there is none; see the note above.
 */
const HEADER_TEXT_MAX = 300;

/**
 * Longest `TaskEvent.promptPreview`, in UTF-16 code units — the field's ONE length policy, for
 * both dispatch paths (`bg-runner` imports it rather than respelling the literal). The value is
 * unchanged from the two separate `300`s it replaces, so the field means exactly what it did.
 *
 * The preview is a HEAD of the prompt, not a summary of it, so unlike a header value it gets no
 * truncation marker: the surfaces that show it (a tree tooltip in views.ts and history-view.ts,
 * a `title=` attribute in the dashboard webview) are answering "what is this task running", and
 * the full prompt is one click away in the output file — and, for `--bg` tasks, verbatim in the
 * `<id>.prompt.txt` that `promptFile` points at.
 *
 * WHAT CHANGED AROUND IT: the preview is built from the dispatched prompt, which is entirely
 * caller-controlled, and it used to be collapsed with `\s+` alone. That let a raw ESC, a NUL,
 * a bidi override and a lone surrogate all through into a tooltip and an HTML attribute —
 * measured, all four. It now goes through the same `flattenOneLine` as every header value.
 */
export const PROMPT_PREVIEW_MAX = 300;

/**
 * WHERE THE CHARACTER RULE LIVES NOW — `../displayText`, not here.
 *
 * The classes this helper flattens (C0/C1 controls and the non-`\n` line separators; every
 * Unicode bidi control; unpaired UTF-16 surrogates) are not a property of markdown headers.
 * They are the hygiene EVERY one-line surface fed by caller-supplied text needs, and this file
 * was simply where the need was noticed first. Two siblings — `registry.recoveredErrorLabel`
 * (the one-line `TaskEvent.error` label) and `promptPreview` below — render the same untrusted
 * text and had each drifted to a weaker spelling of the same idea, because each had its own
 * copy. `registry.ts` cannot import from this module (task-runner imports registry; that edge
 * is a cycle), so the rule now lives in a leaf that imports nothing and that all three call.
 *
 * Read `displayText.flattenOneLine` for the full rationale of each class — including why
 * `\p{Cf}` is deliberately NOT stripped, which is what keeps emoji ZWJ sequences and variation
 * selectors intact. Do not re-spell any of it here; re-spelling is what produced the drift.
 */

/** Stand-in for a value that sanitises away to nothing, so a header line is never left bare. */
const HEADER_EMPTY_VALUE = '-';

/**
 * One caller-supplied value, rendered so that it CANNOT be anything other than part of the
 * single header line it was interpolated into — and so that every surface echoing it back shows
 * the same string a human reads in the file.
 *
 * Total by construction — it never throws, whatever it is handed, because it runs on a write
 * path and losing the output file over a hostile title would only trade one failure for another.
 * A hostile value is neutralised, never rejected.
 *
 * The character rule is `displayText.flattenOneLine` — SHARED, not this module's own; the note
 * above says why it moved and where to read its rationale. What this function adds on top is
 * the header's LENGTH policy (HEADER_TEXT_MAX and the appended `…`) and the `-` placeholder for
 * a value that flattens away to nothing. Net effect, unchanged from when the rule lived here: a
 * legitimate title survives LEGIBLE (`"Fix the parser\r\nand its tests"` → `"Fix the parser and
 * its tests"`, with emoji, ZWJ sequences and variation selectors untouched) while a hostile one
 * survives INERT — one line, read left-to-right in the order it is stored, well-formed UTF-8
 * once written.
 *
 * What it does NOT claim — anything about the value's MEANING, and nothing that would let a
 * reader tell a writer's line from a quoted one. A value that flattens to the exact text
 * `- worker: someone-else` is an ordinary title and is written as one, on the title line, where
 * it does no harm because nothing parses this file.
 */
export function headerText(raw: unknown): string {
  // The character rule — and the totality that makes a hostile value survivable on a write path
  // — comes from the leaf; what stays here is this surface's own LENGTH policy.
  const flat = flattenOneLine(raw);
  if (flat === '') {
    return HEADER_EMPTY_VALUE;
  }
  if (flat.length <= HEADER_TEXT_MAX) {
    return flat;
  }
  // The `…` is APPENDED to a full-width cut rather than fitted inside the budget: a header line
  // has no competing prefix to make room for, unlike recoveredErrorLabel's label. sliceOneLine
  // is what keeps the cut from orphaning a surrogate half.
  return `${sliceOneLine(flat, HEADER_TEXT_MAX)}…`;
}

/**
 * A numeric header value, clamped to a form that can be written at all and read once written.
 *
 * `run.inputTokens` and its siblings come from JSON.parse of the worker CLI's stdout — declared
 * `number` by the type, never checked at runtime — so they carry exactly the provenance of any
 * other untrusted input. Two things follow from that, and only one of them is about looks.
 *
 * The hard one: `.toFixed` THROWS on a non-number, and this is a write path, where a throw costs
 * the entire output file. Clamping first is what makes that impossible.
 *
 * The display one: `${n}` of a string interpolates arbitrary text — line terminators included —
 * into the middle of a summary line, which is the defect headerText() exists for, arriving
 * through the one field that bypasses it. And a legitimate but extreme count formats as `1e+21`,
 * which tells a reader nothing about how much was spent. Non-finite, negative and non-numeric
 * all record as 0; the upper clamp keeps `${n}` and `toFixed` in plain decimal.
 */
function headerNumber(raw: unknown): number {
  if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(raw, Number.MAX_SAFE_INTEGER);
}

/**
 * The `model` value of a result's bracketed FIRST LINE: what was asked for and, only when the
 * CLI reported a model that is not that same string, ` → <what ran>` after it — `haiku →
 * claude-haiku-4-5-20251001`. With nothing reported, or a full id that ran as itself, it is the
 * requested value alone and the line is byte for byte what it always was.
 *
 * That is the ONLY way this line grows. An orchestrating model, the harnesses and the team proxy
 * agent find it by its `[worker: ` prefix, so nothing in it moves and nothing is added around it.
 * One implementation for every composer of that line, so two dispatch paths cannot spell the
 * arrow differently.
 *
 * WHAT A READER OF THE LINE MAY RELY ON. `modelUsed` has the shape of a reported id
 * (REPORTED_MODEL_ID): one token, with no space, no comma and no line break in it. It CAN hold
 * square brackets — a CLI reports ids such as `claude-opus-5-5[1m]`, and a requested model may
 * carry `[1m]` as well — so the line can read `[worker: w, model: opus → claude-opus-5-5[1m]]`.
 * The bracket that closes the line is therefore its LAST character, not the first `]` in it: a
 * reader anchors on the end of the line (as the harnesses' own pattern does), never on the first
 * closing bracket.
 *
 * The comparison is of the two strings as they are. A reported id that differs from the request
 * in anything, letter case included, is shown: what follows the arrow is what the CLI said.
 */
export function resultModelText(model: string, modelUsed: string | undefined): string {
  return modelUsed !== undefined && modelUsed !== model ? `${model} → ${modelUsed}` : model;
}

/**
 * `TaskEvent.modelSource` in the words a report's header uses. A Map, not an object: the key is
 * a string, and a table that is looked up by a string must have no entries but its own (an
 * object answers `constructor` with a function).
 */
const MODEL_SOURCE_WORDS: ReadonlyMap<string, string> = new Map<ModelSource, string>([
  ['dispatch', 'dispatch'],
  ['worker', 'worker default'],
  ['cli', 'CLI default'],
]);

/**
 * The summary lines a report's header carries directly under its `- model:` line: `- model ran:
 * <id>` when the CLI reported what ran — absent otherwise, never a placeholder that could read
 * as a model — and `- model source: dispatch | worker default | CLI default`. For a human, like
 * the rest of the block (see the note opening this section): the same facts are on the task's
 * events as `modelUsed` and `modelSource`, which is where a machine reads them.
 *
 * Shared by every writer of a header that has a `- model:` line — the one-shot core's RUNNING
 * and DONE files, a vendor run's, a session worker's — so the lines are the same everywhere.
 */
export function modelHeaderLines(source: ModelSource, modelUsed?: string): string {
  return (
    (modelUsed !== undefined ? `\n- model ran: ${headerText(modelUsed)}` : '') +
    `\n- model source: ${MODEL_SOURCE_WORDS.get(source) ?? HEADER_EMPTY_VALUE}`
  );
}

/** Longest echo of a rejected model value in the rejection text, in UTF-16 code units. */
const INVALID_MODEL_ECHO_MAX = 80;

/**
 * The model a dispatch EXPLICITLY asked for, normalized (`OPUS` and the v1.x tier ids read as
 * their alias) — or undefined when it named none, in which case each worker runs its own
 * default. "Named none" is exactly: absent, null, or the empty string.
 *
 * A value that is present and is NOT a model THROWS. It is never read as "use the default":
 * through v1.x an unlisted model was silently replaced by whatever the picked worker defaulted
 * to, so a typo ran — and billed — as a different model, and the result header was the only
 * place that said so. Callers must therefore call this BEFORE picking a worker, minting an id
 * or spawning anything, so that the rejection costs nothing and is recorded against nobody.
 *
 * `provider` is the provider of the workers this dispatch can land on (resolveDispatchTarget),
 * because what a model IS depends on it: a Claude Code alias or full id by default — the rule
 * and the words are then exactly what they were — and otherwise that vendor's own id, checked
 * for shape only (providers.normalizeProviderModel: whether the id exists is the vendor CLI's
 * to say, with its own message).
 *
 * The echo of the rejected value is flattened and capped: it is caller-supplied text of any
 * type and length going into an error message that reaches a tool result.
 *
 * Exported so every dispatch path rejects the same values with the same words.
 */
export function resolveRequestedModel(raw: unknown, provider: ProviderId = 'claude'): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const model = normalizeProviderModel(provider, raw);
  if (model === undefined) {
    const shown = sliceOneLine(flattenOneLine(raw), INVALID_MODEL_ECHO_MAX);
    throw new Error(`invalid model ${JSON.stringify(shown)} — use ${providerModelHint(provider)}`);
  }
  return model;
}

/** What one attempt runs as, and who chose it. */
export interface AttemptModel {
  /** The model to ask the worker's CLI for; '' = pass none, so the CLI's own default runs. */
  requested: string;
  /** What the task's records say was asked for: `requested`, or `-` when there is none. */
  model: string;
  /** Who chose it — `TaskEvent.modelSource`. */
  source: ModelSource;
}

/**
 * THE decision of an attempt's model, for both dispatch cores: the model the dispatch named
 * (`requestedModel`, already validated by resolveRequestedModel) when it named one, else the
 * picked worker's stored default, else nothing at all — and which of the three it was.
 *
 * Decided here ONCE per attempt, from the two values it depends on, and carried from there onto
 * every event of that attempt: the source is a fact about how the attempt was set up, and a
 * reader that re-derived it later would be deriving it from a registry that may have changed.
 * It is per ATTEMPT, not per dispatch — a failover lands on another account, whose default may
 * be a different model or none.
 *
 * `cli` can only come out for a worker on another vendor's CLI: a Claude Code account always has
 * a default (the registry reads an unreadable one as the fallback alias).
 */
export function attemptModel(requestedModel: string | undefined, worker: Pick<WorkerProfile, 'model'>): AttemptModel {
  const requested = requestedModel ?? worker.model;
  return {
    requested,
    model: requested !== '' ? requested : '-',
    source: requestedModel !== undefined ? 'dispatch' : worker.model !== '' ? 'worker' : 'cli',
  };
}

/**
 * How a task was closed in the log by somebody other than the dispatch that is running it — the
 * recorded reason — or undefined while its final event is still `running`, when it has no event
 * at all, or when the log cannot be read.
 *
 * Asked of the LOG because it is a question across processes: the editor's cancel command and
 * the sweep that settles a dead task both end a task by writing its terminal event, with no way
 * to tell the process whose worker it is. A read failure reads as "nobody did": the question
 * exists to keep a second record from being written, and holding back a real failure because
 * the log was briefly unreadable would lose the only record of it.
 */
export function taskClosedElsewhere(taskId: string): string | undefined {
  // The reader closeTaskOnce decides by, so that this answer and the close agree.
  const final = latestTaskEventOf(taskId);
  if (typeof final === 'string' || final.status === 'running') {
    return undefined;
  }
  // `error` is where a cancel records its reason. Without one the event still closes the task,
  // and a sentence stands in for the blank a caller would otherwise be handed.
  const recorded = typeof final.error === 'string' ? final.error.trim() : '';
  if (recorded !== '') {
    return recorded;
  }
  return final.status === 'done'
    ? `task ${taskId} was already recorded as done by another surface (cancel or reap)`
    : `task ${taskId} was already recorded as failed by another surface (cancel or reap)`;
}

/** Refusal of a `worker` argument that is present and is not a string. */
export const INVALID_WORKER_MESSAGE = 'invalid worker — expected the name of a registered worker';

/**
 * The worker a dispatch NAMED, or undefined when it named none (absent, null, or the empty
 * string — automatic assignment).
 *
 * A value that is present and is not a string THROWS, and callers call this before anything is
 * recorded. The argument arrives as JSON, so it can be an object, an array or a number; such a
 * value is truthy, used to be taken for "a worker was named", matched nobody, and was then
 * written into the failure's task event and result record AS the worker — a non-string in a
 * field every reader of the log treats as a name. The message is a literal on purpose: the
 * rejected value is not echoed anywhere.
 */
export function requestedWorkerName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error(INVALID_WORKER_MESSAGE);
  }
  return raw;
}

/**
 * The provider a dispatch ASKED for, or undefined when it asked for none (absent, null, '').
 * A value that is present and is not a provider id THROWS — it is never read as "not asked",
 * which would send a task meant for another vendor to a Claude Code worker instead.
 */
function requestedProvider(raw: unknown): ProviderId | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const provider = parseProvider(raw);
  if (provider === undefined) {
    const shown = sliceOneLine(flattenOneLine(raw), INVALID_MODEL_ECHO_MAX);
    throw new Error(`unknown provider ${JSON.stringify(shown)} — use one of: ${PROVIDER_IDS.join(', ')}`);
  }
  return provider;
}

/** Where a dispatch may land, decided from its `worker` and `provider` arguments alone. */
export interface DispatchTarget {
  /** The worker it named, or undefined for automatic assignment. Always a string when set. */
  workerName: string | undefined;
  /**
   * The ONE provider every candidate of this dispatch runs on: the named worker's; else the
   * provider asked for; else Claude Code. A task never lands on another vendor's CLI unless the
   * caller asked for it, by one of those two arguments.
   */
  provider: ProviderId;
}

/**
 * Validate a dispatch's `worker` and `provider` arguments and say which provider it targets.
 * Throws — before anything exists for the dispatch — for a `worker` that is not a string, a
 * `provider` that is not one, and a `provider` that contradicts the named worker's own.
 *
 * A named worker that is not registered is NOT this function's error: the core's pre-flight
 * (planDispatch) reports that, with the list of names, and selection does for a core without
 * one. Until then the dispatch is treated as targeting the provider it asked for (Claude Code
 * when it asked for none).
 *
 * Exported because the SERVER needs the answer before the core runs: a dispatch that targets
 * another vendor's CLI takes the one-shot core whatever Mesh Mode says, and the session-worker
 * core must never be handed one.
 */
export function resolveDispatchTarget(
  args: { worker?: unknown; provider?: unknown },
  workers: readonly WorkerProfile[],
): DispatchTarget {
  const workerName = requestedWorkerName(args.worker);
  const asked = requestedProvider(args.provider);
  const named = workerName === undefined ? undefined : workers.find((w) => w.name === workerName);
  if (named === undefined) {
    return { workerName, provider: asked ?? 'claude' };
  }
  const own = workerProvider(named);
  if (asked !== undefined && asked !== own) {
    throw new Error(
      `worker ${sliceOneLine(flattenOneLine(named.name), INVALID_MODEL_ECHO_MAX)} runs on ` +
        `${providerInfo(own).label}, not ${providerInfo(asked).label}`,
    );
  }
  return { workerName, provider: own };
}

/**
 * The workers a dispatch may be assigned to. A NAMED dispatch keeps the whole registry: selection
 * looks the name up itself, and its "unknown worker" answer lists every registered name. An
 * automatic one gets the target provider's workers only.
 */
export function dispatchCandidates(target: DispatchTarget, workers: WorkerProfile[]): WorkerProfile[] {
  return target.workerName !== undefined
    ? workers
    : workers.filter((w) => workerProvider(w) === target.provider);
}

/**
 * Refusal for an automatic dispatch whose provider has no worker at all. Says which provider,
 * and — because the commonest way here is a registry holding only other vendors' accounts —
 * what is registered instead and how to reach it.
 */
export function noWorkerForProviderMessage(provider: ProviderId, workers: readonly WorkerProfile[]): string {
  const label = providerInfo(provider).label;
  const others = workers
    .filter((w) => workerProvider(w) !== provider)
    .map((w) => `${sliceOneLine(flattenOneLine(w.name), INVALID_MODEL_ECHO_MAX)} (${providerInfo(workerProvider(w)).label})`);
  const registered = others.length > 0 ? ` Registered: ${others.join(', ')}.` : '';
  return provider === 'claude'
    ? `No ${label} worker account is registered, and a dispatch that names no worker and no ` +
        `provider only ever runs on a ${label} worker.${registered} Name one of them with ` +
        '"worker", or its vendor with "provider", to run this task there.'
    : `No ${label} worker account is registered, so "provider": "${provider}" has nothing to run ` +
        `on.${registered} Add one in VS Code ("Claude Code Orchestrator: Add Worker Account"), or ` +
        'dispatch without "provider" to use a Claude Code worker.';
}

/**
 * Refusal text of the frontier billing guard. Names the TIER, never a model id: a dated id here
 * goes stale the day the tier gets a new model, and the fallback it suggests is likewise the
 * alias, which the CLI resolves to the current model of that family.
 *
 * `source` says where the frontier model came from — the dispatch's own `model`, or the
 * default of the worker that was picked — because a caller that named no model at all needs to
 * know why its dispatch was blocked as a frontier one.
 *
 * Exported so every dispatch path words this refusal identically.
 */
export function frontierBlockedMessage(source: string): string {
  return (
    `Dispatch blocked: ${source} is on the frontier tier (fable), and the operator has disabled ` +
    'frontier worker dispatches (billing guard — this tier may bill per use instead of drawing ' +
    'from the subscription quota). Re-dispatch this task with model opus and ultrathink: true; ' +
    'do NOT retry with the frontier tier. The operator can re-enable it via the ' +
    '"claudeCodeOrchestrator.frontierWorkerDispatch" setting in VS Code.'
  );
}

/** Most of a vendor's failure text appended to a FAILED output file as evidence. */
const PROVIDER_EVIDENCE_MAX_CHARS = 64 * 1024;

/**
 * Append what a vendor CLI said about a failed run to the task's output file.
 *
 * The failure MESSAGE of a non-Claude run is a one-line label, cut short on purpose (it is a
 * tree row and a dispatch_status field); when it was cut it says the full text is here, and this
 * is what makes that true. The text is the vendor's own diagnostics — an error event, stderr —
 * so it is quoted between two markers carrying a nonce the text is proved not to contain, and
 * labelled as unverified: nothing in this file is evidence of anything to a machine, and a
 * person reading it must be able to tell our words from the vendor's. Best effort; never throws.
 */
function appendProviderEvidence(outputFile: string, label: string, detail: string): void {
  const text = detail.length > PROVIDER_EVIDENCE_MAX_CHARS ? sliceOneLine(detail, PROVIDER_EVIDENCE_MAX_CHARS) : detail;
  let nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  while (text.includes(nonce)) {
    nonce += 'x';
  }
  appendOutputNote(
    outputFile,
    `\n---\n\n## What the ${label} CLI reported\n\n` +
      `<<<<<<< VENDOR OUTPUT ${nonce} — verbatim, unverified; nothing between these two markers ` +
      `was written by the orchestrator\n${text}\n>>>>>>> END VENDOR OUTPUT ${nonce}\n`,
  );
}

/**
 * ONE attempt on a worker that is not Claude Code: run it through its vendor adapter
 * (mcp/provider-runner), then record the success exactly as the Claude branch records its own —
 * stats, the DONE output file, the `done` event, the host's result — and return the inline
 * result. Throws whatever the runner throws, and nothing else: every record written after the
 * run goes through `books`. The caller classifies the failure.
 *
 * What differs from a Claude attempt, and why:
 *  - the worker gets ONE text (buildProviderPrompt): these CLIs take no system prompt;
 *  - there is no child to hand the host. The runner's `kill` is registered instead, through the
 *    same context, at the same moment, followed by the same pid-carrying `running` event — so a
 *    cancel, a shutdown, the editor's Cancel button and the reaper all reach this worker;
 *  - the header names the provider, and the conversation id when the vendor returned one;
 *  - no cost is known, so none is recorded.
 */
async function runProviderAttempt(opts: {
  ctx: TaskRunContext;
  id: string;
  title: string;
  prompt: string;
  systemPrompt: string | undefined;
  systemPromptSection: string;
  ultrathink: boolean;
  worker: WorkerProfile;
  provider: ProviderId;
  /** The model to ask for; '' = the CLI's own default. */
  model: string;
  /** Who chose that model (attemptModel) — for the report's header; the events have it on `base`. */
  modelSource: ModelSource;
  timeoutMinutes: number;
  outputFile: string;
  /** This attempt's event identity — spread into every event, exactly as the Claude branch does. */
  base: TaskBase;
  /** The dispatch's record writer: nothing recorded after the run may fail it (TaskBookkeeping). */
  books: TaskBookkeeping;
}): Promise<string> {
  const { ctx, id, worker, base, outputFile, books } = opts;
  const info = providerInfo(opts.provider);
  const registered: { kill?: () => void } = {};
  let outcome;
  try {
    outcome = await runProviderWorker({
      worker,
      model: opts.model === '' ? undefined : opts.model,
      prompt: buildProviderPrompt({
        prompt: opts.prompt,
        systemPrompt: opts.systemPrompt,
        ultrathink: opts.ultrathink,
      }),
      cwd: process.cwd(),
      // clamped upstream, so always inside setTimeout's 32-bit delay range
      timeoutMs: opts.timeoutMinutes * 60_000,
      // The vendor child's DISPATCHED_TASK_ENV (contract §15.5): this task's id.
      taskId: id,
      onChild: (kill, pid) => {
        registered.kill = kill;
        ctx.onProviderSpawn?.(id, kill, pid);
        try {
          // The second 'running' event, carrying the pid — same event, same reason, as the
          // Claude branch's: it makes the worker killable from outside this process. The child
          // is spawned detached, so on POSIX its pid is also its group id.
          appendTaskEvent({
            ...base,
            ts: Date.now(),
            status: 'running',
            pid,
            pgid: process.platform === 'win32' ? undefined : pid,
          });
        } catch {
          // the kill is registered — a log write must not fail the run
        }
        // A `claude -p` child is spawned in the same tick its request was last checked. This one
        // is not: the adapter may await (a login file read) before it starts the process, and a
        // cancellation landing in that gap found nothing registered to stop. Stop it now.
        if (ctx.shouldAbort()) {
          kill();
        }
      },
    });
  } finally {
    if (registered.kill !== undefined) {
      ctx.onProviderExit?.(id, registered.kill);
    }
  }

  // The worker has succeeded. Nothing recorded about that from here on can undo it.
  books.recordSuccess(worker.name, {
    text: outcome.text,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    costUsd: 0,
  });
  // A run that worked is the strongest evidence there is that this account is logged in: it
  // ends a logged-out verdict the cache may still hold for it (one a failed run filed, which
  // the vendor's own status command is not allowed to clear). Nothing is written when the
  // cache holds no such verdict.
  books.providerLogin(worker, true);
  books.finalOutput(
    outputFile,
    () =>
      `# ${headerText(opts.title)}\n\n- worker: ${headerText(worker.name)}\n- model: ${headerText(outcome.model)}${modelHeaderLines(opts.modelSource, outcome.modelUsed)}\n- provider: ${opts.provider}` +
      (opts.ultrathink ? '\n- ultrathink: true' : '') +
      (outcome.conversationId !== '' ? `\n- conversation: ${headerText(outcome.conversationId)}` : '') +
      (outcome.note !== undefined ? `\n- note: ${headerText(outcome.note)}` : '') +
      `\n- tokens: ${outcome.inputTokens} in / ${outcome.outputTokens} out` +
      `\n\n---\n\n## Prompt\n\n${opts.prompt}${opts.systemPromptSection}\n\n## Result\n\n${outcome.text}\n`,
  );
  books.terminalEvent({
    ...base,
    // The model that was asked for — or, when none was, what the vendor said ran, which it may
    // only say at the end (a worker with no default model runs its CLI's own, and the running
    // events could only say `-`).
    model: outcome.model,
    // What the vendor REPORTED, when that is an observation (provider-runner.reportedProviderModel
    // says when it is not). The key is absent otherwise.
    ...(outcome.modelUsed !== undefined ? { modelUsed: outcome.modelUsed } : {}),
    ts: Date.now(),
    status: 'done',
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    costUsd: 0,
  });
  // After the DONE writer above, which replaces the whole file.
  books.annotate(outputFile);
  // The header of a non-Claude result: the provider on line 1, then the task line every result
  // has, then the vendor's conversation id when it returned one. A blank line, the worker's
  // text — and, after it, the adapter's note when there is one, so the header stays three lines.
  // Last of all, what could not be recorded about this task, when anything could not.
  const resultText =
    `[worker: ${worker.name}, model: ${resultModelText(outcome.model, outcome.modelUsed)}, provider: ${opts.provider}]\n` +
    `task: ${id} · output: ${outputFile}\n` +
    (outcome.conversationId !== '' ? `conversation: ${outcome.conversationId}\n` : '') +
    `\n${outcome.text}` +
    (outcome.note !== undefined ? `\n\n[note from the ${info.label} adapter: ${outcome.note}]` : '') +
    books.resultNote();
  ctx.onResult?.({
    id,
    status: 'done',
    text: resultText,
    worker: worker.name,
    model: outcome.model,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    costUsd: 0,
  });
  return resultText;
}

/* ------------------------------------------------------------------------- *
 * The dispatch gate, as a core takes it
 * ------------------------------------------------------------------------- */

/** How often a dispatch waiting for a slot asks its host whether it has been cancelled. */
const GATE_CANCEL_POLL_MS = 100;

/**
 * The operator's ceiling on concurrent dispatches, read NOW — a dispatch that starts waiting
 * after the setting changed waits under the new value. A registry that cannot be read is no
 * reason to refuse a dispatch and no licence to run without a ceiling: it reads as the default.
 */
function dispatchConcurrencyLimit(): number {
  try {
    return sanitizeDispatchConcurrency(readRegistry().maxConcurrentDispatches);
  } catch {
    return sanitizeDispatchConcurrency(undefined);
  }
}

/**
 * Take one slot of this server's dispatch gate (mcp/dispatch-gate) for a dispatch whose host
 * can be asked whether it was cancelled, waiting for as long as it takes.
 *
 * The gate ends a wait through an AbortSignal; a host has only the question (`shouldAbort`). So
 * the question is asked on a timer for as long as the wait lasts, and a "yes" aborts it: the
 * dispatch then fails with CANCELLED_BEFORE_START_ERROR, having started nothing and written
 * nothing. A dispatch that gets a slot at once never sees the timer fire. A hook that throws is
 * taken as "not cancelled" — the wait must not end on a host's defect.
 *
 * The caller owns the slot from the moment this resolves and MUST release it on every path
 * (`try { … } finally { slot.release(); }`). Exported for the server, which takes a slot of the
 * same gate for a detached dispatch before it starts that dispatch's supervisor.
 */
export async function acquireDispatchSlotFor(shouldAbort: () => boolean): Promise<DispatchSlot> {
  const cancel = new AbortController();
  const poll = setInterval(() => {
    let cancelled = false;
    try {
      cancelled = shouldAbort() === true;
    } catch {
      cancelled = false;
    }
    if (cancelled) {
      cancel.abort();
    }
  }, GATE_CANCEL_POLL_MS);
  try {
    return await acquireDispatchSlot({ limit: dispatchConcurrencyLimit(), signal: cancel.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(CANCELLED_BEFORE_START_ERROR);
    }
    throw err;
  } finally {
    clearInterval(poll);
  }
}

/* ------------------------------------------------------------------------- *
 * The one-shot dispatch core
 * ------------------------------------------------------------------------- */

/** Everything about a dispatch that is settled from its arguments and the registry alone. */
interface DispatchPlan {
  registry: Registry;
  target: DispatchTarget;
  /** The ONE provider every candidate runs on (resolveDispatchTarget). */
  provider: ProviderId;
  candidates: WorkerProfile[];
  /** The model the dispatch asked for, normalized; undefined = each worker's own default. */
  requestedModel: string | undefined;
  timeoutMinutes: number;
}

/**
 * Read the registry and settle where a dispatch may land and with what — or THROW the refusal.
 *
 * Every check of a dispatch that needs the registry sits here, and nothing here leaves a trace:
 * no worker is picked, no id is minted, no event is appended, nothing is spawned. So a rejected
 * request costs nothing and is recorded against nobody.
 *
 * First where the task may land: a `provider` that is not one, and a `provider` that contradicts
 * the named worker's, are refused by resolveDispatchTarget; a named worker that is not a usable
 * entry is refused next. Then the model, which is a model of THAT provider.
 */
function planDispatch(task: CheckedDispatchArgs): DispatchPlan {
  const registry = readRegistry();
  if (registry.workers.length === 0) {
    // Not "none registered" when the worker that was named IS registered, as an entry this
    // version cannot use: that sentence would send the caller to add an account they have.
    const unusable =
      task.worker === undefined ? undefined : unsupportedWorkerRefusal(task.worker, registry.unsupportedWorkers);
    throw new Error(
      unusable ?? 'No worker accounts registered. In VS Code, run "Claude Code Orchestrator: Add Worker Account".',
    );
  }
  const target = resolveDispatchTarget(task, registry.workers);
  // A worker that was NAMED and is not one of the usable entries: a name nobody registered, or
  // an entry this version cannot use. An unknown name is interface misuse, not a hint to
  // auto-assign, and it is refused HERE with every other refusal — it used to be discovered by
  // selection, inside the attempt loop, after the task had been announced, so a typo left a
  // FAILED output file and an `error` event behind and took a slot of the gate to do it.
  if (target.workerName !== undefined && !registry.workers.some((w) => w.name === target.workerName)) {
    throw new Error(namedWorkerNotFoundRefusal(target.workerName, registry.workers, registry.unsupportedWorkers));
  }
  const provider = target.provider;
  const candidates = dispatchCandidates(target, registry.workers);
  if (candidates.length === 0) {
    throw new Error(noWorkerForProviderMessage(provider, registry.workers));
  }
  // Undefined means the caller named none and each worker runs its own default.
  const requestedModel = resolveRequestedModel(task.model, provider);
  const timeoutMinutes = clampTimeoutMinutes(task.timeout_minutes ?? registry.workerTimeoutMinutes);
  return { registry, target, provider, candidates, requestedModel, timeoutMinutes };
}

/**
 * Whether a failed attempt says its ACCOUNT is out of quota — the verdict that starts a cooldown
 * and moves the task to the next account. By TYPE on every path: a non-Claude run is classified
 * by its runner, which read the vendor's own error channel with the shared classifier before it
 * composed a message, so its message is never put through that classifier a second time; a
 * Claude Code run is read only when the failure is the CLI's own (isClaudeQuotaFailure). A
 * timeout, a kill, a missing binary and an output cap are therefore never quota failures,
 * whatever their text — or the worker output some of them quote — happens to say.
 */
function isAttemptQuotaFailure(provider: ProviderId, err: unknown): boolean {
  return provider !== 'claude' ? err instanceof ProviderQuotaError : isClaudeQuotaFailure(err);
}

/**
 * The per-task dispatch core. Picks a worker (with quota-aware failover), runs the
 * `claude -p` child, records success/failure and events, writes the RUNNING and
 * DONE/FAILED output file, and returns the inline result string. The host supplies
 * cancellation and child-tracking through `ctx`.
 *
 * It is also the ONLY core that runs a worker on another vendor's CLI. Which provider a
 * dispatch targets is settled from its arguments before anything else (resolveDispatchTarget);
 * selection, cooldown, login-expiry handling and failover then run across that provider's
 * workers exactly as they do across Claude Code's, and the single attempt in the middle is
 * runProviderAttempt instead of runClaude. Two things are Claude-only by construction: the
 * frontier guard (a vendor's model id is not a Claude tier, whatever it is called) and overage
 * billing (no other account carries that state).
 *
 * IN THREE STEPS, each of which can end the dispatch, and only the last of which leaves a trace:
 *
 *  1. THE ARGUMENTS are checked (dispatch-args.checkDispatchArgs — shape and size, by the one
 *     rule every entry uses), then judged against the registry (planDispatch). A refusal is a
 *     thrown message: nothing was spawned and nothing was logged. From here on only the CHECKED
 *     arguments exist — the bounded one-line title is the one in every record of the task.
 *  2. A SLOT of the dispatch gate is waited for (acquireDispatchSlotFor). While the dispatch
 *     waits it has no id, no event and no output file; cancelled there, it fails with
 *     CANCELLED_BEFORE_START_ERROR and has still left nothing behind. The slot is held for the
 *     whole attempt loop, failover attempts included, and released on every way out of it.
 *  3. THE DISPATCH RUNS (runAdmittedDispatch). A worker's wall-clock limit starts when its
 *     process is spawned there — time spent waiting in step 2 is not charged to the task.
 */
export async function runDispatchTask(args: DispatchArgs, ctx: TaskRunContext): Promise<string> {
  const checked = checkDispatchArgs(args);
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const task = checked.args;
  // Judged against the registry BEFORE the wait as well as after it: a request that can never
  // run must be told so at once, not when its turn comes.
  planDispatch(task);
  const slot = await acquireDispatchSlotFor(() => ctx.shouldAbort());
  try {
    return await runAdmittedDispatch(task, ctx);
  } finally {
    slot.release();
  }
}

/**
 * Step 3 of runDispatchTask: the dispatch holds its slot, and runs.
 *
 * The registry is read AGAIN here, and everything the run depends on is taken from this reading:
 * the dispatch may have waited for its slot, and what it runs under — which accounts exist, the
 * billing guards, the cooldown length, the default timeout — must be what holds when it starts,
 * not what held when it was queued. A guard the operator switched to "block" while a batch was
 * waiting applies to every task of that batch that had not started. A refusal raised by this
 * second reading is still a refusal that left no trace.
 */
async function runAdmittedDispatch(task: CheckedDispatchArgs, ctx: TaskRunContext): Promise<string> {
  const { registry, target, provider, candidates, requestedModel, timeoutMinutes } = planDispatch(task);
  const { title, prompt, ultrathink } = task;

  ensureDirs();
  // A detach supervisor pre-assigns the id (the server picked it and is awaiting
  // tasks/<id>.result.json), and so does a dispatch host (it announced the id to its client
  // before the task was queued); the default path allocates its own, exactly as before.
  const id = ctx.preassignedId ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const attempted = new Set<string>();
  // Explicit worker → single attempt; otherwise fail over across the candidates on quota errors.
  const maxAttempts = target.workerName !== undefined ? 1 : candidates.length;
  let lastError: Error | undefined;
  // Whether `lastError` is a failed ATTEMPT that was a quota failure (isAttemptQuotaFailure).
  // False while it is a selection refusal: that is this server's own sentence, not a verdict.
  let lastErrorQuota = false;
  // The model the attempt made last asked its CLI for, and who chose it — what the dispatch's
  // failure event says, as that attempt's own `running` events did. Until an attempt exists
  // only a model the dispatch named is known: `-` otherwise, and then with no source at all.
  let lastModel: string = requestedModel ?? '-';
  let lastModelSource: ModelSource | undefined = requestedModel !== undefined ? 'dispatch' : undefined;
  // The frontier guard as it applies to this dispatch's workers (see pickWorker).
  const frontierGuardBlocks = provider === 'claude' && registry.frontierWorkerDispatch !== 'allow';
  // Flattened prompt head carried on every TaskEvent so surfaces can show WHAT a task is
  // running without opening its output file. See PROMPT_PREVIEW_MAX for why the flattening is
  // the shared rule and not the whitespace collapse this line used to be.
  const promptPreview = sliceOneLine(flattenOneLine(prompt), PROMPT_PREVIEW_MAX);
  // Task-specific system prompt (if any), and its reusable output-file section.
  const systemPrompt = task.system_prompt;
  const systemPromptSection = systemPrompt ? `\n\n## Task system prompt\n\n${systemPrompt}` : '';
  // A single usage-cache read, passed (with the model request validated above) into every
  // pickWorker attempt.
  const usageCache = readUsageCache();
  // Operator billing guard, resolved once for the whole dispatch (including every
  // failover attempt) so a mid-dispatch settings change cannot make one attempt
  // billable and the next not. Defensive like the frontier guard: anything that is
  // not the literal 'allow' reads as blocked — on a money surface, an unreadable
  // or unexpected value must never be taken as consent to spend.
  const overageAllowed = registry.overageWorkerDispatch === 'allow';
  // Config dirs whose login was already re-probed live for THIS dispatch. Workers
  // can share a dir, and a dispatch can run pickWorker once per failover attempt —
  // neither may turn into a second probe of the same account.
  const probedDirs = new Set<string>();
  // `provider` on this task's events and in its output file: the id for another vendor's
  // worker, and NOTHING for Claude Code — JSON.stringify drops the undefined key and the header
  // line is empty, so a Claude task writes the bytes it always wrote.
  const eventProvider = provider === 'claude' ? undefined : provider;
  const providerHeaderLine = eventProvider === undefined ? '' : `\n- provider: ${eventProvider}`;
  // Every record this dispatch writes about itself goes through here, so that none of them can
  // change its outcome (TaskBookkeeping). A detach supervisor is this core in a process that
  // ends with the task, and so cannot keep a cooldown it failed to write.
  const books = new TaskBookkeeping(id, ctx.supervisorPid === undefined);

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ctx.shouldAbort()) {
        break;
      }
      let worker: WorkerProfile;
      let billableOverage: boolean;
      try {
        const picked = await pickWorkerLive(
          candidates,
          target.workerName,
          attempted,
          requestedModel,
          usageCache,
          overageAllowed,
          probedDirs,
          frontierGuardBlocks,
        );
        worker = picked.worker;
        billableOverage = picked.billableOverage;
      } catch (err) {
        lastError = lastError ?? (err as Error);
        break;
      }
      // Selection can now await live auth probes, so a cancellation can land after
      // the loop-top check and before this task is trackable. Re-check here: past
      // this point the child is spawned and cancelRequest could no longer reach it.
      if (ctx.shouldAbort()) {
        break;
      }
      attempted.add(worker.name);
      // A non-Claude worker may have NO default model (''): its CLI then runs its own, and
      // until the run reports which, the task's records say `-`. Who chose the model is settled
      // in the same step and for THIS attempt: the next account's default may be another one.
      const { requested, model, source: modelSource } = attemptModel(requestedModel, worker);
      // Billing guard: frontier models may bill per use rather than draw from the subscription
      // quota. Two dispatches reach this refusal, and neither has another account to go to: one
      // that NAMED a frontier model (the same model would be asked of every account), and one
      // that named this WORKER and no model (a named worker is the only attempt there is). A
      // dispatch that named neither never arrives here with a blocked default — selection passed
      // that account over (pickWorker). Claude Code workers only: another vendor's model id is
      // not a Claude tier, even when it resells one. Refused before the attempt is recorded
      // anywhere, so it leaves no trace.
      if (provider === 'claude' && isFrontierModel(model) && frontierGuardBlocks) {
        throw new Error(
          frontierBlockedMessage(
            requestedModel !== undefined
              ? 'the requested model'
              : `the default model of worker "${worker.name}"`,
          ),
        );
      }
      // From here on this is an attempt the task's records speak of.
      lastModelSource = modelSource;
      lastModel = model;
      // supervisorPid is set only on the detach path (the supervisor passes its own
      // pid); JSON.stringify drops it on the default path, so those events are byte-
      // identical. Carried on base so every event for the task inherits it.
      const base = {
        id,
        title,
        worker: worker.name,
        model,
        // On `base`, so every event of this attempt carries it — the core's own, and the ones a
        // host authors from the base it was handed (a cancellation, a detach supervisor's stamp).
        modelSource,
        provider: eventProvider,
        outputFile,
        cwd: process.cwd(),
        promptPreview,
        supervisorPid: ctx.supervisorPid,
      };
      appendTaskEvent({ ...base, ts: Date.now(), status: 'running' });
      // Claim the id before spawning: a cancellation landing in the window
      // between here and the spawn must still mark this task cancelled.
      ctx.onTrack(base);
      // Make the task inspectable WHILE RUNNING: write the output file now with a
      // RUNNING header plus the prompt, so a reader can see what a live worker was
      // handed before any result exists. A write failure must not fail the dispatch.
      try {
        // By task id, replacing whatever is at the name (registry.writeTaskFile).
        writeTaskFile(
          id,
          'output',
          // Every caller-supplied value goes through headerText — one line each, no controls,
          // no reordering — because all of them are displayed, here and in every surface that
          // echoes them. The block is a summary for a human; nothing reads it back. See the note
          // opening the header-composition section for why that is now the whole contract.
          `# ${headerText(title)}\n\n- status: RUNNING (started ${new Date().toISOString()})\n- worker: ${headerText(worker.name)}\n- model: ${headerText(model)}${modelHeaderLines(modelSource)}${providerHeaderLine}${ultrathink ? '\n- ultrathink: true' : ''}${billableOverage ? '\n- overage: billing past plan window' : ''}\n\n---\n\n## Prompt\n\n${prompt}${systemPromptSection}\n`,
        );
      } catch {
        // best effort — the task still runs and the DONE/FAILED writer overwrites this
      }

      // The harness scans the user message for thinking keywords; for a
      // headless worker the dispatched prompt IS the user message, so
      // appending the keyword mechanically raises its reasoning budget.
      const workerPrompt = ultrathink ? `${prompt}\n\nultrathink` : prompt;

      try {
        if (provider !== 'claude') {
          return await runProviderAttempt({
            ctx,
            id,
            title,
            prompt,
            systemPrompt,
            systemPromptSection,
            ultrathink,
            worker,
            provider,
            model: requested,
            modelSource,
            timeoutMinutes,
            outputFile,
            base,
            books,
          });
        }
        const run = await runClaude(
          registry,
          worker.configDir,
          model,
          workerPrompt,
          timeoutMinutes,
          systemPrompt,
          (child) => {
            ctx.onSpawn(id, child);
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
          // The worker's DISPATCHED_TASK_ENV (contract §15.5): this task's id.
          id,
        );
        // The worker has succeeded. Nothing recorded about that from here on can undo it.
        books.recordSuccess(worker.name, run);
        // Real work is evidence: the account's login is `ok` (Login state (CA)).
        books.providerLogin(worker, true);
        // Through the record writer, like every record of an outcome that already exists: a
        // disk that refuses this file must not turn a finished task into a failed attempt.
        books.finalOutput(outputFile, () => {
          // Numbers for a line a person reads, pinned to a shape that can be written at all:
          // whole non-negative counts, a finite cost, never exponent notation. The clamp is
          // also what keeps `.toFixed` from throwing — see headerNumber.
          const headerInputTokens = Math.trunc(headerNumber(run.inputTokens));
          const headerOutputTokens = Math.trunc(headerNumber(run.outputTokens));
          const headerCostUsd = headerNumber(run.costUsd);
          return (
            `# ${headerText(title)}\n\n- worker: ${headerText(worker.name)}\n- model: ${headerText(model)}${modelHeaderLines(modelSource, run.modelUsed)}${ultrathink ? '\n- ultrathink: true' : ''}${billableOverage ? '\n- overage: billing past plan window' : ''}\n- tokens: ${headerInputTokens} in / ${headerOutputTokens} out` +
            (headerCostUsd ? ` (~$${headerCostUsd.toFixed(4)})` : '') +
            `\n\n---\n\n## Prompt\n\n${prompt}${systemPromptSection}\n\n## Result\n\n${run.text}\n`
          );
        });
        books.terminalEvent({
          ...base,
          // What the CLI reported it ran, on this event only; the key is absent when it
          // reported nothing, so such a task's `done` event is what it always was.
          ...(run.modelUsed !== undefined ? { modelUsed: run.modelUsed } : {}),
          ts: Date.now(),
          status: 'done',
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
        });
        // After the DONE writer above, which replaces the whole file.
        books.annotate(outputFile);
        // When the dispatch went to an exhausted-but-overage-enabled worker, warn
        // loudly (before the [worker: …] line) that it spent real money.
        const overageWarning = billableOverage
          ? `⚠ ${worker.name} is past a plan window; overage billing applies — this dispatch bills real money against the account's monthly cap.\n`
          : '';
        // Two header lines, then a blank line, then the worker's text. The first names what was
        // asked for and, after an arrow, what the CLI says ran when it said so and it differs
        // (resultModelText). The second names the
        // task and the file holding this same result, so the caller can come back to either —
        // dispatch_status by id, the full record by path — without having to find the id in a
        // list. `outputFile` is absolute: TASKS_DIR is rooted at the home directory. After the
        // text, and only when a record of this task could not be written, a line saying which.
        const resultText =
          `${overageWarning}[worker: ${worker.name}, model: ${resultModelText(model, run.modelUsed)}]\n` +
          `task: ${id} · output: ${outputFile}\n\n${run.text}${books.resultNote()}`;
        // Detach supervisor authors result.json from this; default path leaves onResult
        // unset, so the returned string below is the only observable output as before.
        ctx.onResult?.({
          id,
          status: 'done',
          text: resultText,
          worker: worker.name,
          model,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
          overageWarning: overageWarning || undefined,
        });
        return resultText;
      } catch (err) {
        if (ctx.shouldAbort()) {
          // We killed this child ourselves. A cancellation is not a quota error
          // and not a worker failure: no recordFailure (it would inflate the
          // error count and could cool the worker down), and no failover. The
          // terminal CANCELLED note in the output file is appended by
          // cancelRequest/shutdown (the terminal-event sites), not here, so it is
          // written exactly once even though both paths can fire for this task.
          break;
        }
        // Closed by ANOTHER surface while this attempt ran — the editor's cancel records the
        // cancellation and then stops the worker (registry.cancelRunningTask), so from here its
        // work looks like a worker killed from outside. The task is over and the log already
        // says how: nothing is counted against the account (a user's cancel is not a worker's
        // failure), the report is not rewritten over the note that surface left in it, no
        // second terminal event is written, and no other account is tried. Thrown, not broken
        // out of: the tail below is exactly the FAILED file and the terminal event that must
        // not happen a second time. A host that needs a record of its own (a detach
        // supervisor's result.json) builds it from this message.
        const closedElsewhere = taskClosedElsewhere(id);
        if (closedElsewhere !== undefined) {
          throw new Error(closedElsewhere);
        }
        const message = err instanceof Error ? err.message : String(err);
        // A quota failure is decided by the failure's TYPE (isAttemptQuotaFailure). A timeout,
        // an external kill and a run stopped for its output are never one, whatever their
        // embedded partial output says; all three fall through to the break below: no cooldown,
        // and no replacement worker for a task nobody still wants — or that would only print
        // the same thing again.
        const quota = isAttemptQuotaFailure(provider, err);
        // The account is not logged in. Like a quota failure it says "this ACCOUNT cannot do
        // the work", so the task moves to the next one — but with no cooldown: nothing resets
        // by waiting, and the reading filed below is what keeps selection away from it.
        //
        // On a Claude Code account the CLI's words (CLAUDE_LOGIN_TRIGGER_TEXTS) in a FAILED run's
        // error only TRIGGER a live login check through the same CLI path (P118: a transient line
        // must not take the account out of rotation): "logged in" — this is an ordinary failure;
        // "not logged in", or a check that could not decide — the run's own failure is the
        // evidence, the account is `loggedOut` at once (Login state (CA)) and the task fails over.
        let loggedOut = err instanceof ProviderAuthError;
        if (!loggedOut && !quota && provider === 'claude' && err instanceof WorkerCliFailure && isClaudeLoginFailureText(message)) {
          const { auth: live } = await checkClaudeLogin(
            { name: worker.name, configDir: worker.configDir },
            Math.min(AUTH_PROBE_TIMEOUT_MS, LIVE_RECHECK_PROBE_TIMEOUT_MS),
          );
          loggedOut = live?.loggedIn !== true;
        }
        // A workspace the vendor CLI refuses (Codex outside a git repository) is nobody's
        // failure but the directory's: every account of that provider would be refused the same
        // way, so nothing is filed against this one — no error count, no last error — and, being
        // neither a quota nor a login failure, it ends the dispatch right below.
        if (!(err instanceof ProviderWorkspaceError)) {
          books.recordFailure(worker.name, message, quota, registry.cooldownMinutes);
        }
        lastError = err as Error;
        lastErrorQuota = quota;
        if (loggedOut) {
          // The reading "this account is not logged in", filed in the usage cache WITH ITS
          // PROVENANCE — a run proved it. That is what makes the failure stick to the account
          // rather than to the one dispatch: selection skips an account the cache says is
          // logged out, and a verdict a run produced is not overwritten by the vendor CLI's own
          // status command, which can answer "logged in" for an account whose runs it refuses
          // (usage.runLoginFailureAt says what ends it). The failover this dispatch is about to
          // do does not depend on the write.
          books.providerLogin(worker, false);
        }
        if (!quota && !loggedOut) {
          // Real failures (bad CLI, login expired, crash) don't fail over — surface them.
          break;
        }
        // A note in the log, not a state: a log that refuses it must not stop the failover.
        books.progressEvent({
          ...base,
          ts: Date.now(),
          status: 'running',
          error: quota
            ? `quota error on ${worker.name} — failing over`
            : `login expired on ${worker.name} — failing over`,
        });
      }
    }

    if (ctx.shouldAbort()) {
      // cancelRequest already killed the child and appended the terminal event.
      // No output file, no failure record — the caller gets no response either.
      throw new Error(CANCELLED_ERROR);
    }

    const message = lastError?.message ?? 'unknown error';
    // How many accounts this dispatch could have failed over across: the target provider's.
    const poolSize = registry.workers.filter((w) => workerProvider(w) === provider).length;
    const singleWorkerHint =
      poolSize === 1 && lastErrorQuota
        ? registry.workers.length === 1
          ? ' Only one worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another worker account.'
          : ` Only one ${providerInfo(provider).label} worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another ${providerInfo(provider).label} worker account.`
        : '';
    // Through the record writer: the dispatch has FAILED, with `message`, and a file that
    // cannot be written must neither replace that failure with an errno nor keep the terminal
    // event below from being appended.
    books.finalOutput(
      outputFile,
      // A FAILED file gets no summary block and no `---` rule: there is nothing to summarise,
      // and a rule would only suggest a structure this file does not have. The title still goes
      // through headerText for the reason every displayed value does — it reaches a tree label,
      // a webview cell and `dispatch_status` output, and it must render as what it says. The
      // `message` deliberately keeps its full text: it is body, and body is quoted material.
      () => `# ${headerText(title)}\n\nFAILED: ${message}\n\n## Prompt\n\n${prompt}${systemPromptSection}\n`,
    );
    // AFTER the rewrite above, which replaces the whole file. Only a non-Claude run carries
    // this: its message is a short label, and the vendor's full text is the evidence behind it.
    const vendorDetail = (lastError as { detail?: unknown } | undefined)?.detail;
    if (provider !== 'claude' && typeof vendorDetail === 'string' && vendorDetail !== '') {
      appendProviderEvidence(outputFile, providerInfo(provider).label, vendorDetail);
    }
    // Through the record writer for the same reason the `done` event is: an event that cannot
    // be appended must not replace the failure this dispatch is about to report with its own.
    books.terminalEvent({
      id,
      title,
      worker: [...attempted].join(',') || (target.workerName ?? '-'),
      // What the last attempt asked its CLI for — the worker's default when the dispatch named
      // none — exactly as that attempt's `running` events say it, with who chose it. A failure
      // that never reached an attempt has the requested model, or `-` and then no source. Never
      // `modelUsed`: a run that failed left no result document to read one from.
      model: lastModel,
      modelSource: lastModelSource,
      provider: eventProvider,
      outputFile,
      cwd: process.cwd(),
      promptPreview,
      supervisorPid: ctx.supervisorPid,
      ts: Date.now(),
      status: 'error',
      error: message,
    });
    // After the FAILED writer above, which replaces the whole file.
    books.annotate(outputFile);
    // A failed non-Claude dispatch also says where its record is: the message above may have
    // been cut, and unlike a result there is no header line to carry the task id. Last, what
    // could not be recorded about the task — the failure itself is unchanged by it.
    const whereRecorded = provider !== 'claude' ? ` (task ${id} · output: ${outputFile})` : '';
    const finalMessage = message + singleWorkerHint + whereRecorded + books.resultNote();
    // Same string the throw carries, so a detach supervisor's result.json relays a
    // byte-identical failure. onResult is unset on the default path (no effect).
    ctx.onResult?.({
      id,
      status: 'error',
      text: finalMessage,
      worker: [...attempted].join(',') || (target.workerName ?? '-'),
      model: lastModel,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: finalMessage,
    });
    throw new Error(finalMessage);
  } finally {
    ctx.onSettle(id);
  }
}
