import { execFile, execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from './displayText';
import {
  DEFAULT_WORKER_MODEL,
  normalizeModel,
  normalizePermissionMode,
  REPORTED_MODEL_ID,
  WORKER_MODELS,
} from './platform';
import {
  normalizeProviderModel,
  normalizeProviderPermissionMode,
  parseProvider,
  providerInfo,
  storedProvider,
  type ProviderId,
} from './providers';
import {
  hasRecordedIoToken,
  IO_TOKEN_DIGEST_PATTERN,
  IO_TOKEN_PATTERN,
  ioTokenProves,
  type RecordedIoToken,
} from './ioToken';
import { isCountedTaskEvent } from './ranAs';
import { appendTextSafe, readTextSafe, type SafeRead, SafeReadFailure } from './safeFs';
// The constants this module takes from the cco wire contract: the failover grace (contract §15.12
// M4) and the team id and member name shapes a task event's team fields are read by (team contract
// §7.7). That file is Node built-ins only and is loaded by both the extension and the server
// bundles already.
import { FAILOVER_GRACE_MS, MEMBER_NAME, TEAM_ID } from './mcp/host-protocol';
// The team settings' defaults and ranges (team contract §7.7). team/contract.ts is Node built-ins
// and host-protocol only at runtime — its imports of this module are type-only — so both bundles
// load it without a cycle.
import { TEAM_NUMBER_SETTINGS, TEAM_TURN_TIMEOUT_MINUTES, type TeamNumberSettingKey } from './team/contract';

/**
 * Shared state between the VS Code extension and the standalone MCP dispatch
 * server (which runs in a separate process, spawned by the Claude Code CLI).
 * Everything lives under ~/.claude-code-orchestrator. This module must not import
 * 'vscode'.
 */

// The aliases offered as a worker's DEFAULT model. platform.ts owns the list — it is the one
// module allowed to know which models the CLI has — and it is re-exported here so the modules
// that have always imported it from the registry keep working. The frontier tier (fable)
// requires the account's plan to include it and draws its own weekly quota — reserve it for
// design-consult and adversarial-review dispatches.
export { WORKER_MODELS } from './platform';

/**
 * A model value as the CLI takes it: a tier alias (`opus`) or a full model id. A plain string
 * and deliberately not a union of ids: which ids exist is the CLI's business and changes without
 * a release of ours. Every value that enters — this file's `registry.json`, a dispatch argument,
 * the UI — goes through `platform.normalizeModel`, which is where the accepted forms are defined.
 */
export type WorkerModel = string;

export interface WorkerProfile {
  name: string;
  /**
   * The agent CLI this account runs on (providers.ts). ABSENT means Claude Code — every entry
   * written before 2.0 has none. Read it through `workerProvider`, never compared raw. Set only
   * for a non-Claude worker, so a Claude entry round-trips through this module byte for byte.
   * An entry of the file whose `provider` is not one this version supports never becomes a
   * WorkerProfile at all (UnsupportedWorkerEntry).
   */
  provider?: ProviderId;
  /**
   * The account's home directory and its IDENTITY: the key its usage reading, its duplicate
   * check and its login are filed under. For a Claude Code worker it is the config directory
   * holding the login (CLAUDE_CONFIG_DIR). Kept VERBATIM, never resolved or trimmed: that CLI
   * derives its credential key from the string, so a spelling that differs from the one the
   * login was made under reads as logged out. For another provider it is the directory its own
   * home variable names (providers.adapterAccountDir decides whether a child is told), or
   * `providers.defaultProviderHome` for the machine's ordinary login.
   */
  configDir: string;
  /**
   * Default model when a dispatch doesn't specify one, normalized on read FOR THE WORKER'S
   * PROVIDER: an alias or a full id for Claude Code, that vendor's own id otherwise. A
   * non-Claude worker may have NONE — the empty string — and then runs its CLI's own default.
   */
  model: WorkerModel;
  /**
   * The user PINNED `model`: chose it from the CLI's own list of models, or typed a full id —
   * so it means that exact model, and a v1.x tier id here is read as the id it is
   * (platform.normalizeModel's `exact`), not as its tier. Only the literal `true` sets it; it is
   * kept on every rewrite of the entry and written with `model` by setWorkerModel. An older build
   * ignores the field and reads a pinned tier id as its tier — the one way the two disagree.
   */
  modelPinned?: boolean;
  /**
   * This worker's own permission / sandbox mode, in its provider's vocabulary
   * (providers.normalizeProviderPermissionMode). ABSENT means the provider's default. It is what
   * a non-Claude worker is started with; Claude Code workers are started with the registry-wide
   * `permissionMode` below, exactly as before this field existed.
   */
  permissionMode?: string;
  /**
   * Preferred worker (typically the same account as the main session): wins
   * automatic assignment whenever it isn't busier than the least-busy
   * alternative, so it's favored without being flooded.
   */
  preferred?: boolean;
}

/**
 * An element of registry.json's worker arrays that this version cannot USE: it says a provider
 * this version does not know, it lacks the directory that is the account, it repeats the name of
 * an entry already in use — or it is not an entry this version can even name. It is kept — out
 * of every enumeration, and in the file — because neither alternative is this version's to
 * choose: read as a Claude Code account, another vendor's home directory would be handed to
 * `claude`; dropped, the next write of the file would delete something a newer version sharing
 * it put there.
 */
export interface UnsupportedWorkerEntry {
  /**
   * The entry's name, verbatim — or `''` for an element that has no usable name (it is not an
   * object, or its `name` is not a string with something in it). A nameless element takes part
   * in nothing: no worker can collide with it and nothing can be asked for by it.
   */
  name: string;
  /**
   * Why it cannot be used. `provider`: its `provider` is not one this version supports. `shape`:
   * it has no usable name or no usable `configDir`, or it sits in `vendorWorkers` without naming
   * a vendor. `duplicate-name`: an earlier usable entry already has this exact name.
   */
  reason: 'provider' | 'shape' | 'duplicate-name';
  /**
   * Display form of the raw `provider`: flattened to one line, at most 40 characters; '' when it
   * is absent or null, or the element is not an object; for a value that is not a string, the
   * word for its type in parentheses — `(number)`, `(boolean)`, `(object)`, `(array)`.
   */
  providerText: string;
  /**
   * Which array of the file it is WRITTEN to. That is the array it was found in, with one
   * exception: an element that names a provider other than Claude Code is always written under
   * `vendorWorkers`, so that it never sits where a pre-2.0 editor reads it as a Claude account.
   */
  source: 'workers' | 'vendorWorkers';
  /**
   * The element exactly as parsed: an object for an entry with a name, and anything JSON can
   * hold — a number, a string, `null`, an array — for one without. NEVER modified; written back
   * as it is.
   */
  raw: unknown;
}

export interface Registry {
  /**
   * The USABLE worker accounts: the Claude Code accounts in file order, then the other vendors'
   * accounts in file order. Ask a worker's vendor through `workerProvider`.
   */
  workers: WorkerProfile[];
  /**
   * The entries this version cannot use (see UnsupportedWorkerEntry). Always an array once read.
   * In NO enumeration of workers — not counted, assigned, probed, cleaned or stopped — and
   * written back untouched: a registry object handed to a writer WITHOUT an array here keeps
   * whatever the file holds, so only an explicit array can remove one.
   */
  unsupportedWorkers: UnsupportedWorkerEntry[];
  /**
   * Ceiling on how many dispatched workers the server runs at the same moment, across every
   * dispatch call. An integer 1..64; anything else reads as DISPATCH_CONCURRENCY_DEFAULT (see
   * sanitizeDispatchConcurrency).
   */
  maxConcurrentDispatches: number;
  /**
   * --permission-mode passed to dispatched workers. Always one of platform's
   * WORKER_PERMISSION_MODES once read: a value the CLI would not accept (absent, misspelled,
   * hand-edited) reads as the default rather than reaching a spawn's argv.
   */
  permissionMode: string;
  /** Path or name of the claude executable. */
  claudePath: string;
  /** Minutes a worker sits out after a quota/rate-limit error. */
  cooldownMinutes: number;
  /** Minutes a dispatched worker may run before it is terminated. */
  workerTimeoutMinutes: number;
  /**
   * Billing guard over WHICH MODEL may be dispatched: 'block' rejects dispatches
   * to the frontier tier (fable) at the server with a fall-back hint.
   * Defaults to 'block' because that tier may bill per use instead of drawing
   * from the subscription quota.
   *
   * This guard says NOTHING about overage: it does not stop a non-frontier model
   * from billing real money past an exhausted plan window. That is
   * `overageWorkerDispatch`, which is entirely independent of this field.
   */
  frontierWorkerDispatch: 'allow' | 'block';
  /**
   * appName (vscode.env.appName) of the editor whose EXPLICIT setting produced
   * the current `frontierWorkerDispatch` value. Undefined when no editor has
   * explicitly opted in. Used to reconcile the billing guard across editors that
   * share this one registry file — see applyFrontierGuard.
   */
  frontierGuardSetBy?: string;
  /**
   * Billing guard over WHETHER ANY DISPATCH MAY PROCEED past an exhausted plan
   * window: 'block' stops the server assigning work to a quota-exhausted worker
   * even when that account has extra usage (overage) enabled, so dispatch never
   * spends money past a plan window. 'allow' lets such a worker be used as a
   * last resort — those dispatches BILL REAL MONEY against the account's
   * monthly cap. Applies to EVERY model, not just the frontier one, and defaults
   * to 'block'.
   *
   * Independent of `frontierWorkerDispatch`, which only governs which model may
   * be dispatched.
   */
  overageWorkerDispatch: 'allow' | 'block';
  /**
   * appName (vscode.env.appName) of the editor whose EXPLICIT setting produced
   * the current `overageWorkerDispatch` value. Undefined when no editor has
   * explicitly opted in. Used to reconcile the overage guard across editors that
   * share this one registry file — see applyOverageGuard.
   */
  overageGuardSetBy?: string;
  /**
   * Experimental master switch for the v1.4.0 session mesh (the mesh_* MCP tools).
   * 'off' disables every mesh tool; 'on' arms them behind a per-workspace owner lock.
   * Default 'off' — the mesh is an experimental same-machine layer over Claude Code
   * cross-session messaging and must be opted into explicitly. Any value other than the
   * literal 'on' — absent, null, misspelled, hand-edited — reads as the safe 'off'.
   */
  meshMode: 'on' | 'off';
  /**
   * Hard ceiling on session workers with a dispatch STILL IN FLIGHT — not stopped, spawned
   * for a task that has not yet recorded a terminal outcome, and not past that task's
   * deadline. It is not a count of live processes: a worker whose dispatch has settled stays
   * attachable (parked) for as long as the user wants it and holds no slot, so the cap bounds
   * concurrent WORK, which is what spends quota. The name is kept from when the two were the
   * same thing.
   *
   * A dispatch past the cap is REFUSED, never queued: queueing a batch larger than the cap
   * deadlocks, since the workers that would free the slots are the ones still waiting.
   * Default 8, clamped to 1..64 (0 is clamped up, not treated as "unlimited" — an unlimited
   * cap is the failure mode this setting exists to prevent).
   */
  meshMaxLiveWorkers: number;
  /**
   * Cap on how many stopped/finished workers the history view retains before the oldest
   * are dropped. Integer, default 50, clamped to a floor of 1 (a zero-length history is
   * never a useful choice — the view exists to keep at least the most recent).
   */
  meshHistoryLimit: number;
  /**
   * `false` when the operator has turned off reading other vendors' plan usage (the
   * `providerUsagePolling` setting): a usage reading is taken with the account's own local login
   * against the vendor's endpoint, and that is the one thing about a non-Claude worker a user may
   * not want done for them. ABSENT means allowed — the setting's default — and only the literal
   * `false` turns it off; login state is still checked either way. Read by the dispatch server's
   * list_workers, which has no other way to learn an editor setting.
   */
  providerUsagePolling?: boolean;
  /*
   * TEAMMATE MODE (team contract §7.7). Synced from VS Code's settings exactly as `meshMode` is:
   * the switches as 'on' | 'off', the numbers sanitized like `meshMaxLiveWorkers`. They are the
   * USER's limits — the lead cannot raise them (MD-22) — and the dispatch host reads them at every
   * team op and every turn start. Defaults and ranges: team/contract TEAM_NUMBER_SETTINGS.
   */
  /**
   * Experimental master switch for Teammate mode (I12): 'on' arms the cco team_* operations on a
   * dispatch host (darwin and linux). Any value but the literal 'on' — absent, null, misspelled —
   * reads as the safe 'off'. Turned off mid-team: running teams continue; only team_create and
   * team_add refuse.
   */
  teamMode: 'on' | 'off';
  /** Members per team, stopped ones included: default 6, 1..8. */
  teamMaxMembers: number;
  /** Team turns running at once per host (no dispatch slot is taken, MD-14): default 4, 1..16. */
  teamMaxRunningTurns: number;
  /**
   * A team turn's wall-clock limit in minutes, 5..240 — ABSENT when not set (or unreadable), and
   * then the same as `workerTimeoutMinutes` (clamped to 5..240). Read it through
   * teamTurnTimeoutMinutesOf, never raw: a default written into the file would stop following
   * workerTimeoutMinutes.
   */
  teamTurnTimeoutMinutes?: number;
  /** Turns one member may start per rolling hour: default 20, 1..240. */
  teamTurnsPerMemberPerHour: number;
  /** Turns per team per local day: default 300, 10..5000. */
  teamTurnsPerDay: number;
  /**
   * 'on': Cursor teammates run with `--force` — every command runs without approval (S3(b), I14).
   * Default 'off'; anything but the literal 'on' is 'off'. The roster says so when it is on.
   */
  teamCursorForce: 'on' | 'off';
  /**
   * 'on': Antigravity teammates run with `--dangerously-skip-permissions` — needed for their team
   * tools (without it they are turns-only), and every command then runs without approval (S3(b),
   * I14). Default 'off'; anything but the literal 'on' is 'off'.
   */
  teamAgySkipPermissions: 'on' | 'off';
}

/** Cumulative per-worker usage, tracked from CLI JSON results. */
export interface WorkerStats {
  tasks: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastUsedAt?: number;
  /** Epoch ms until which this worker is skipped (set on quota errors). */
  cooldownUntil?: number;
  lastError?: string;
}

export type StatsFile = Record<string, WorkerStats>;

export interface TaskEvent {
  ts: number;
  id: string;
  status: 'running' | 'done' | 'error';
  title: string;
  worker: string;
  model: string;
  /**
   * Who chose `model` for the attempt this event belongs to: `dispatch` — the dispatch named
   * it; `worker` — the worker account's stored default was used; `cli` — neither, so no model
   * was passed and the CLI ran its own default. Decided once per attempt and carried on every
   * event of it. ABSENT on events written before it was recorded, and on a failure that never
   * reached an attempt of a dispatch that named no model. Untrusted like every other field of
   * a log line: a reader takes it only when it is one of the three words.
   */
  modelSource?: 'dispatch' | 'worker' | 'cli';
  /**
   * The model id the CLI REPORTED it ran (shape: platform.REPORTED_MODEL_ID) — on the `done`
   * event of a run whose CLI said so, and nowhere else. `model` is what was asked for, often an
   * alias; this is what that resolved to. Where it is read from: a one-shot run's result
   * document; for a session worker, the last main-thread assistant row of its session
   * transcript (mesh/transcript.sessionModelOf) — when its own dispatch records the result, and
   * when a later sweep recovers it from the worker's result file (the recovery hook supplies
   * it). ABSENT when nothing was reported: a failed run, a transcript that names no model or
   * cannot be read, a CLI that names no model, an older log entry. Never guessed and never
   * copied from the request. Untrusted like every other field of a log line.
   */
  modelUsed?: string;
  /**
   * The provider id of the worker this event is about, when it is NOT Claude Code (`codex`,
   * `cursor`, `gemini`). ABSENT for a Claude Code task, so every event such a task writes is
   * byte-identical to what it was before the field existed. Two readers: the surfaces that badge
   * a task with its vendor, and isOurWorker below, which needs it to recognise the task's child
   * process — that child is not a `claude -p`. Untrusted like every other field of a log line:
   * read it through providers.parseProvider.
   */
  provider?: string;
  /** Markdown file holding the worker's output. */
  outputFile: string;
  error?: string;
  /** Usage of this run — set on 'done' events; feeds per-window quota views. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Workspace the dispatch ran in (server cwd) — enables per-workspace views. */
  cwd?: string;
  /**
   * First ~300 chars of the dispatched prompt, so surfaces can show WHAT a task is running
   * without opening its output file. Set on the initial 'running' event and carried on every
   * later event for the task.
   *
   * FLATTENED, not merely whitespace-collapsed: the prompt is caller-supplied and this field is
   * rendered as a tree tooltip (views.ts, history-view.ts) and as a dashboard `title=`
   * attribute, so it goes through `displayText.flattenOneLine` — the same one-line character
   * rule the output-file header values and the recovered-error label use. Both dispatch paths
   * (mcp/task-runner and mcp/bg-runner) build it identically, from that rule and the shared
   * PROMPT_PREVIEW_MAX cap.
   */
  promptPreview?: string;
  /** Absolute path to the file holding the full dispatched prompt, when one was written. */
  promptFile?: string;
  /** PID of the worker `claude -p` child. Set on a second 'running' event emitted after spawn. */
  pid?: number;
  /** Process-group id of the worker, recorded only when it was spawned as its own group leader (detached). Present => the whole tree can be signalled with -pgid. */
  pgid?: number;
  /**
   * PID of the detach SUPERVISOR process (out/mcp/run-task.js) that owns this task.
   * Set on a detach task's running/interim events (contract §5.5). The reaper treats
   * the task as alive while EITHER the worker pid OR this supervisor pid is alive-and-
   * ours, which closes the failover-gap window where a detach task briefly has no live
   * worker between attempts. Absent on default (in-process) tasks.
   */
  supervisorPid?: number;
  /**
   * Name of the attachable `claude --bg` worker running this task (Mesh Mode). Such a
   * worker is NOT our child process, so these events deliberately carry no pid/pgid —
   * every signal-based path (cancel, reap, isOurWorker) must no-op on them, and liveness
   * is answered from the mesh ledger instead (see reapDeadTasks' isAliveExternally).
   */
  meshWorker?: string;
  /**
   * The dispatch's OWN timeout in minutes, as clamped at dispatch time. Recorded so a
   * deadline stays derivable (this event's `ts` plus these minutes) once the dispatching
   * session is gone: that session held the only timer — an in-memory `await` — so a
   * cross-session sweep that lacks this number cannot tell a task that is merely slow from
   * one that blew its budget an hour ago, which is how a dead session's task sat 'running'
   * 90 minutes past a 30-minute timeout. Purely ADDITIVE and optional: every event written
   * before this field existed parses unchanged, and nothing in this module requires it.
   */
  timeoutMinutes?: number;
  /**
   * LEGACY: the result token of a session-worker dispatch in plain text, as events written
   * before digests were recorded carry it. Nothing writes this field any more — a writer records
   * `ioTokenSha256`. Readers still accept it: as the recorded expectation of a task whose history
   * holds no digest (firstRecordedIoToken), and as a mark that the event belongs to a
   * session-worker dispatch (isMeshDispatchEvent). Never put into text a person or a model reads.
   */
  ioToken?: string;
  /**
   * SHA-256 (64 lowercase hex) of the result token of a SESSION-WORKER dispatch, recorded so a
   * later server session can still check a result file it did not dispatch. See ioToken.ts, the
   * one place a token is minted, hashed or compared against a recorded value.
   *
   * WHAT THE TOKEN GATE DEFENDS — for this field and for `detachIoTokenSha256` alike. A result
   * file is accepted only from a writer that knew the task's token. The token is in the
   * dispatching server's memory and, for a session worker, in the first line of the task file in
   * that task's own io directory (mode 0700). It is not on a command line and not in the task
   * log (the log holds its SHA-256). This stops a result written for another task, a result
   * written by a process of another user, and a result forged from the task log. It does not
   * stop a process running as the same user that reads the task file: nothing on disk can.
   */
  ioTokenSha256?: string;
  /**
   * LEGACY: the result token of a detached one-shot dispatch in plain text, as events written
   * before digests were recorded carry it. Nothing writes this field any more — a writer records
   * `detachIoTokenSha256`. Readers still accept it as the recorded expectation of a task whose
   * history holds no digest (firstRecordedIoToken). Never put into text a person or a model
   * reads.
   */
  detachIoToken?: string;
  /**
   * SHA-256 (64 lowercase hex) of the result token of a DETACHED one-shot dispatch, which
   * `tasks/<id>.result.json` must carry the token for. What the gate defends is stated once, at
   * `ioTokenSha256` above.
   *
   * A FIELD OF ITS OWN, never merged with `ioTokenSha256`: a session-worker field on an event
   * means "this is a session-worker dispatch, and nothing may write the detached path's result
   * file for it" (isMeshDispatchEvent, readResultForTask), so a detached dispatch stamped with
   * one would have every genuine result refused.
   *
   * ON RUNNING EVENTS ONLY: every terminal event this module composes from a running one drops
   * it (withoutDetachToken). The expectation for a task is therefore resolved from its event
   * HISTORY — the FIRST event carrying a well-formed value, never the latest and never the event
   * in hand (taskLogFacts).
   */
  detachIoTokenSha256?: string;
  /**
   * Teammate mode (team contract §3.4, §7.7): the id (TEAM_ID) of the team whose member turn this
   * task is — every team turn is one task of this log (I13), so reconcile, the reaper,
   * dispatch_status, `cco recent` and the views see it as a dispatch. ABSENT on every other task,
   * whose events are byte-identical to what they were. Written only by the team engine and
   * UNTRUSTED like every field of a log line: a reader takes the three team fields only through
   * taskEventTeam, which checks their shapes.
   */
  team?: string;
  /** Teammate mode: the member (MEMBER_NAME) whose turn this task is. See `team`. */
  member?: string;
  /** Teammate mode: the member's turn number, a positive integer. See `team`. */
  turn?: number;
}

/** Pre-rename data directory — migrated to ROOT_DIR on first load. */
export const LEGACY_ROOT_DIR = path.join(os.homedir(), '.fable-orchestrator');
export const ROOT_DIR = path.join(os.homedir(), '.claude-code-orchestrator');
try {
  if (!fs.existsSync(ROOT_DIR) && fs.existsSync(LEGACY_ROOT_DIR)) {
    fs.renameSync(LEGACY_ROOT_DIR, ROOT_DIR);
  }
} catch {
  // migration is best-effort; a fresh ROOT_DIR is created on demand
}
export const REGISTRY_FILE = path.join(ROOT_DIR, 'registry.json');
export const TASKS_LOG_FILE = path.join(ROOT_DIR, 'tasks.jsonl');
export const TASKS_DIR = path.join(ROOT_DIR, 'tasks');
export const STATS_FILE = path.join(ROOT_DIR, 'stats.json');
export const ORCHESTRATORS_FILE = path.join(ROOT_DIR, 'orchestrators.json');

/* ------------------------------------------------------------------------- *
 * Reading the small JSON state files BY VALUE
 * ------------------------------------------------------------------------- */

/*
 * registry.json, stats.json and orchestrators.json sit at fixed paths in the user's home
 * directory. They are hand-editable, they are written by every editor and every extension
 * version that shares this directory, and a dispatched worker has a shell. A `JSON.parse(...)
 * as T` therefore types a value that was never checked: `null` parses, an array parses, and a
 * token count of `"<img src=x>"` parses. Two failures follow from trusting that cast, both on
 * render paths: a reader that reaches for a field of something that is not an object throws out
 * of a tree view's refresh, and a string "count" turns a `+=` total into a string that travels
 * on to a webview.
 *
 * The readers below rebuild what they return from values they have looked at. The rule is the
 * same for all three files: an entry that is not an object is SKIPPED, and a field that does not
 * hold what its name says reads as that field's own "nothing" (0 for a counter, absent for a
 * timestamp or a text). No READER ever throws: a file that could not be read or understood reads
 * as an empty one, so a render path or a dispatch never dies of it.
 *
 * WRITING IS A DIFFERENT QUESTION, and the one a reader's leniency must not be allowed to answer.
 * "Reads as empty" followed by "write back what was read" REPLACES the file: one stray byte in
 * front of registry.json — a UTF-8 byte-order mark is enough — used to cost every worker
 * account, both billing guards and every key another version had stored, at the next settings
 * change. So
 * each read also says WHAT IT ESTABLISHED (StateFileRead), and every writer asks that before it
 * writes: the registry is never written over while it cannot be understood (updateRegistry), and
 * the two machine-written caches are set aside before they are replaced (stateFileForRewrite).
 */

/** A parsed JSON value that is an object and not an array — the only shape these files key by. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * READ CAP for registry.json, stats.json and orchestrators.json. Each holds one small entry per
 * worker account (or per workspace) and is a few kilobytes on a real machine; 1 MiB is thousands
 * of entries. It bounds files that are read on render paths — every tree refresh — and on every
 * dispatch.
 */
const STATE_FILE_MAX_BYTES = 1024 * 1024;

/** Longest `problem` a state-file read reports, in UTF-16 code units. It is one line of a notice. */
const STATE_PROBLEM_MAX_CHARS = 200;

/**
 * What ONE read of a state file established. Four answers, and they are kept apart because each
 * licenses something different:
 *
 *   - `ok`:      the file parses to a JSON object — `object` is it.
 *   - `fresh`:   there is no file, or it holds nothing but whitespace. Nothing is stored, so
 *                nothing can be lost by writing: this is a first run.
 *   - `damaged`: something IS there and it is positively not a state file — text that is not
 *                JSON, JSON that is not an object, a directory or a pipe where the file should
 *                be, a file past the read cap. Whatever it holds, this version cannot say.
 *   - `unread`:  the read itself failed (EACCES, EMFILE, EIO, a file that shrank mid-read).
 *                NOTHING was learned about what the file holds — it may be perfectly good.
 *
 * `problem` is one line for a person, at most STATE_PROBLEM_MAX_CHARS, composed from this
 * module's literals plus a number or an errno code. It never carries a byte of the file: the
 * registry holds account directories and names, and this line is shown in notices and tool
 * results.
 */
type StateFileRead =
  | { state: 'ok'; object: Record<string, unknown> }
  | { state: 'fresh' }
  | { state: 'damaged'; problem: string }
  | { state: 'unread'; problem: string };

/**
 * The openings of the messages V8's JSON parser produces, as literals of OURS. A parse failure
 * is reported by the first of these the parser's message starts with, and by nothing else of that
 * message: current engines QUOTE the offending text in it (`Unexpected token '<', ..."s": [
 * <<<<<<< HE"... is not valid JSON`), which for this file means a piece of a path or an account
 * name riding out in an error. A message that starts with none of them contributes no words.
 */
const JSON_ERROR_CLASSES: readonly string[] = [
  'Unexpected end of JSON input',
  'Unexpected non-whitespace character after JSON',
  'Unexpected token',
  'Unexpected number',
  'Unexpected string',
  'Expected double-quoted property name',
  "Expected property name or '}'",
  "Expected ',' or '}' after property value",
  "Expected ',' or ']' after array element",
  "Expected ':' after property name",
  'Bad control character in string literal',
  'Bad escaped character',
  'Bad Unicode escape',
  'Unterminated string',
  'No number after minus sign',
  'Exponent part is missing a number',
  'Unterminated fractional number',
];

/**
 * ` (…)` saying what kind of JSON error `err` is and where, or '' when neither can be said
 * without quoting the file. The kind is one of JSON_ERROR_CLASSES; the place is the numbers the
 * parser's message gives — a character position, a line and column — re-spelled here from their
 * digits.
 */
function jsonErrorDetail(err: unknown): string {
  let message = '';
  try {
    const raw: unknown = (err as { message?: unknown } | null | undefined)?.message;
    message = typeof raw === 'string' ? raw : '';
  } catch {
    // a thrown value whose `message` cannot be read says nothing
  }
  const said: string[] = [];
  const kind = JSON_ERROR_CLASSES.find((known) => message.startsWith(known));
  const position = / at position (\d{1,12})\b/.exec(message);
  if (kind !== undefined) {
    said.push(position === null ? kind : `${kind} at position ${position[1]}`);
  } else if (position !== null) {
    said.push(`at position ${position[1]}`);
  }
  const place = /\(line (\d{1,9}) column (\d{1,9})\)/.exec(message);
  if (place !== null) {
    said.push(`line ${place[1]} column ${place[2]}`);
  }
  return said.length === 0 ? '' : ` (${said.join(', ')})`;
}

/**
 * Read one state file and say what the read established (StateFileRead). Never throws.
 *
 * Through the guarded reader rather than `fs.readFileSync`, for the reason every other read of a
 * fixed path in this directory goes through it: opening a FIFO for reading BLOCKS until a writer
 * appears, a hang is not catchable, and these three files are read synchronously from the
 * extension host's activate() and from the dispatch server's polled tools. readTextSafe opens
 * non-blocking and refuses whatever turns out not to be a regular file.
 *
 * One leading U+FEFF is not part of the document. Editors on Windows put a byte-order mark in
 * front of UTF-8 text and JSON.parse refuses it, so a registry saved once from such an editor
 * would otherwise be `damaged` for a character nobody typed.
 */
function readStateFile(file: string): StateFileRead {
  const read = readTextSafe(file, STATE_FILE_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === 'absent') {
      return { state: 'fresh' };
    }
    if (read.reason === 'not-a-file') {
      return { state: 'damaged', problem: 'not a regular file' };
    }
    if (read.reason === 'too-large') {
      return { state: 'damaged', problem: 'larger than 1 MiB' };
    }
    // safeFs composes `detail` from its own literals and, when the failure had one, a
    // shape-checked errno code in parentheses at the end. The code is the useful part.
    const code = /\(([A-Z][A-Z0-9_]{1,31})\)$/.exec(read.detail);
    return { state: 'unread', problem: code === null ? 'the read failed' : code[1] };
  }
  const text = read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text;
  if (text.trim() === '') {
    return { state: 'fresh' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: 'damaged',
      problem: sliceOneLine(`not valid JSON${jsonErrorDetail(err)}`, STATE_PROBLEM_MAX_CHARS),
    };
  }
  return isJsonObject(parsed)
    ? { state: 'ok', object: parsed }
    : { state: 'damaged', problem: 'not a JSON object' };
}

/**
 * The JSON object stored in `file` for a READER; `{}` for every other answer of readStateFile —
 * missing, empty, damaged, unread. A reader never throws and never needs to know which; a writer
 * must (see stateFileForRewrite and updateRegistry).
 */
function readJsonObjectFile(file: string): Record<string, unknown> {
  const read = readStateFile(file);
  return read.state === 'ok' ? read.object : {};
}

/**
 * A counter (tasks, tokens, dollars): a finite number that is not negative, else 0. JSON has no
 * NaN or Infinity, but it has strings, null and nested objects, and a counter that is any of
 * those poisons every sum it later joins. A negative count is refused with them: it is
 * well-formed and means nothing.
 */
function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Largest magnitude of epoch milliseconds a `Date` can represent (ECMA-262 time range). */
const TIMESTAMP_MAX_MS = 8.64e15;

/**
 * An epoch-ms timestamp, else undefined. Bounded to what a `Date` can hold as well as finite:
 * these values are rendered, and `new Date(1e300).toISOString()` THROWS — a number that passes
 * `isFinite` and still takes down the view that formats it is not a timestamp.
 */
function timestampValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= TIMESTAMP_MAX_MS
    ? value
    : undefined;
}

/**
 * Self-reported main-session model per workspace (via orchestrator_briefing).
 *
 * `model` and `ts` are OPTIONAL on read: an entry whose field does not hold a string / a
 * timestamp is kept (the session WAS seen) with that field absent, rather than carrying a value
 * of the wrong type under a type that promises the right one. The writers below still store
 * `model: ''` / `ts: 0` for a session that has been seen but never briefed, so a reader must
 * treat an absent and an empty model alike.
 */
export interface OrchestratorCheckin {
  model?: string;
  ts?: number;
  /** Last MCP tool call from this workspace's main session (any tool). */
  lastSeen?: number;
}

export type OrchestratorsFile = Record<string, OrchestratorCheckin>;

/**
 * A map keyed by NAMES THAT COME FROM DATA — worker names out of stats.json and the task log —
 * built so that every name is an ordinary key: an object with NO prototype.
 *
 * A plain `{}` answers to `constructor`, `toString`, `hasOwnProperty` and `__proto__` before
 * anything is put in it, and a worker name is free text that somebody typed (or that a file
 * written by another version holds). On a plain object `counts[name] ?? 0` for a worker called
 * `constructor` is a FUNCTION, not 0, and adds up to a string; `name in stats` is true for a
 * worker that has no stats; and assigning under `__proto__` swaps the object's prototype and
 * stores nothing. With no prototype there is nothing to inherit and no setter to trip: a read of
 * a missing name is `undefined`, `in` means "has an entry", and `__proto__` is a key like any
 * other — for this module's writes into the map as well as its reads.
 *
 * What a caller gives up is calling `Object.prototype` methods ON the map (`map.hasOwnProperty`,
 * `String(map)`); `Object.keys`, `Object.entries`, `in`, `JSON.stringify`, spread and
 * `Object.prototype.hasOwnProperty.call(map, key)` all behave as on any object.
 */
function nameKeyed<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [name, value] of entries) {
    out[name] = value;
  }
  return out;
}

/**
 * The object a MACHINE-WRITTEN state file (stats.json, orchestrators.json) holds, for a caller
 * about to REPLACE that file — `{}` when it holds nothing.
 *
 * These two files are caches this product alone writes, so unlike the registry a DAMAGED one
 * (StateFileRead) is still replaced: nobody is going to repair a counter file by hand, and
 * refusing would stop every task's bookkeeping for good. But it is first renamed to
 * `<file>.damaged`, so what it held is not destroyed by a write that could not read it. One
 * slot: a later damaged file replaces the copy.
 *
 * A file that could NOT BE READ is something else, and is refused (the same error a refused
 * registry write throws). Nothing is known about it — a momentary EMFILE reads exactly like
 * this — and setting aside a good file because one read of it failed would reset every counter
 * and cooldown on the strength of not knowing.
 */
function stateFileForRewrite(file: string): Record<string, unknown> {
  const read = readStateFile(file);
  if (read.state === 'ok') {
    return read.object;
  }
  if (read.state === 'unread') {
    throw stateFileUnreadable(file, read.problem);
  }
  if (read.state === 'damaged') {
    setAsideDamaged(file);
  }
  return {};
}

/**
 * Rename the damaged state file at `file` to its `.damaged` slot. Returns once `file` is out of
 * the way — renamed, or already gone (another process set it aside first). THROWS when it could
 * not be moved: the caller is about to write over it, and that write must not happen then.
 *
 * A plain rename replaces an earlier copy in the slot. It fails only when the slot holds
 * something a rename cannot replace with THIS kind of thing (a directory in the slot and a file
 * to move, or the reverse); then the slot's old occupant is removed and the rename tried once
 * more. `rmSync` does not follow a symbolic link, so what is removed is only ever the slot.
 */
function setAsideDamaged(file: string): void {
  const slot = `${file}.damaged`;
  const errno = (err: unknown): string => {
    const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'unknown error';
  };
  try {
    fs.renameSync(file, slot);
    return;
  } catch (err) {
    if (errno(err) === 'ENOENT') {
      return;
    }
  }
  try {
    fs.rmSync(slot, { recursive: true, force: true });
    fs.renameSync(file, slot);
  } catch (err) {
    if (errno(err) === 'ENOENT') {
      return;
    }
    throw new Error(
      `Could not write ${file}: what is there now is damaged and could not be set aside as ` +
        `${path.basename(slot)} (${errno(err)}). It was not replaced.`,
    );
  }
}

/** The check-ins in a parsed orchestrators.json object, read by value (see the note above). */
function orchestratorsFrom(object: Record<string, unknown>): OrchestratorsFile {
  const entries: Array<[string, OrchestratorCheckin]> = [];
  for (const [cwd, raw] of Object.entries(object)) {
    if (!isJsonObject(raw)) {
      continue;
    }
    const checkin: OrchestratorCheckin = {};
    if (typeof raw.model === 'string') {
      checkin.model = raw.model;
    }
    const ts = timestampValue(raw.ts);
    if (ts !== undefined) {
      checkin.ts = ts;
    }
    const lastSeen = timestampValue(raw.lastSeen);
    if (lastSeen !== undefined) {
      checkin.lastSeen = lastSeen;
    }
    entries.push([cwd, checkin]);
  }
  // No prototype (nameKeyed), like the stats map and for the same reason: the writers below index
  // THIS object by a directory a caller hands them — `all[cwd] ?? …`, `all[cwd] = …`, `delete
  // all[cwd]` — and on an object with a prototype a key such as `constructor` reads as a built-in
  // (touchOrchestrator would then stamp `lastSeen` onto the Object function itself). A real
  // working directory is an absolute path and cannot be such a name; the map does not depend on
  // that. JSON.stringify writes it exactly as it would a plain object.
  return nameKeyed(entries);
}

/** Every recorded check-in, read by value (see the note above). Never throws. */
export function readOrchestrators(): OrchestratorsFile {
  return orchestratorsFrom(readJsonObjectFile(ORCHESTRATORS_FILE));
}

/**
 * Read orchestrators.json, apply `change` to the check-ins, write the file back. Throws when the
 * file could not be read (stateFileForRewrite) or the write was refused (atomicWrite); a damaged
 * file is set aside first.
 *
 * Written through atomicWrite, like the other two state files: a plain truncate-and-write lets
 * a reader in another process see the file half written, and a writer that reads it then would
 * take a good file for a damaged one. No lock — two sessions checking in at the same instant
 * can still lose one of the two `lastSeen` stamps, which the next tool call rewrites.
 */
function rewriteOrchestrators(change: (all: OrchestratorsFile) => void): void {
  ensureDirs();
  const all = orchestratorsFrom(stateFileForRewrite(ORCHESTRATORS_FILE));
  change(all);
  atomicWrite(ORCHESTRATORS_FILE, JSON.stringify(all, null, 2));
}

export function recordOrchestrator(cwd: string, model: string): void {
  rewriteOrchestrators((all) => {
    const now = Date.now();
    all[cwd] = { model, ts: now, lastSeen: now };
  });
}

/**
 * Mark the workspace's main session alive on any dispatch-server tool call.
 * Keeps the dashboard's session indicator fresh even before the session has
 * (re-)briefed — e.g. right after the main account was switched.
 */
export function touchOrchestrator(cwd: string): void {
  rewriteOrchestrators((all) => {
    const entry = all[cwd] ?? { model: '', ts: 0 };
    entry.lastSeen = Date.now();
    all[cwd] = entry;
  });
}

/** Drop a workspace's check-in (dashboard reset after switching accounts). */
export function clearOrchestrator(cwd: string): void {
  rewriteOrchestrators((all) => {
    delete all[cwd];
  });
}

/** Range and default of claudeCodeOrchestrator.workerTimeoutMinutes in package.json. */
export const TIMEOUT_MINUTES_MIN = 1;
export const TIMEOUT_MINUTES_MAX = 480;
export const TIMEOUT_MINUTES_DEFAULT = 45;

/**
 * Clamp to the range package.json declares; input that is not a number falls
 * back to the default. Both the extension host (writing the registry) and the
 * dispatch server (reading it) go through this, so a hand-edited registry.json
 * can neither produce an instantly-expiring timer (0, -5) nor a delay above
 * setTimeout's 32-bit ceiling, where Node silently coerces the overflow to 1 ms
 * and the "long" timeout fires immediately.
 */
export function clampTimeoutMinutes(value: unknown): number {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (Number.isNaN(raw)) {
    return TIMEOUT_MINUTES_DEFAULT;
  }
  // Math.round (not trunc) so 44.6 → 45; ±Infinity survives to the clamp.
  return Math.min(TIMEOUT_MINUTES_MAX, Math.max(TIMEOUT_MINUTES_MIN, Math.round(raw)));
}

/**
 * Bounds and defaults of the session-worker settings (the in-flight cap and the history
 * retention count). package.json's setting declarations mirror these numbers, and the
 * extension clamps with the same helpers before writing, so the UI, the registry file and
 * the server cannot drift.
 */
export const MESH_MAX_LIVE_DEFAULT = 8;
export const MESH_MAX_LIVE_MIN = 1;
export const MESH_MAX_LIVE_MAX = 64;
export const MESH_HISTORY_LIMIT_DEFAULT = 50;
export const MESH_HISTORY_LIMIT_MIN = 1;
export const MESH_HISTORY_LIMIT_MAX = 1000;

/**
 * Numeric reading of a hand-editable setting. A numeric STRING is accepted (the registry
 * file is edited by hand and by other tools, where "15" is an ordinary way to write 15);
 * anything else reads as NaN and each caller decides what its own absent/invalid case is.
 */
function numericSetting(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return NaN;
}

/**
 * In-flight session-worker ceiling (Registry.meshMaxLiveWorkers). Clamped rather than
 * defaulted at the edges: 0 or a negative number means "as few as possible", which is 1 —
 * never "no limit", the exact failure this cap exists to prevent. Only an unreadable value
 * falls back to the default.
 */
export function sanitizeMeshMaxLive(value: unknown): number {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return MESH_MAX_LIVE_DEFAULT;
  }
  return Math.min(MESH_MAX_LIVE_MAX, Math.max(MESH_MAX_LIVE_MIN, Math.round(raw)));
}

/**
 * History retention count. Clamped to a floor of 1 rather than defaulted at the edge: 0 or
 * a negative number means "keep as few as possible", which is 1 — a zero-length history is
 * never a useful choice. Only an unreadable value falls back to the default.
 */
export function sanitizeMeshHistoryLimit(value: unknown): number {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return MESH_HISTORY_LIMIT_DEFAULT;
  }
  return Math.min(MESH_HISTORY_LIMIT_MAX, Math.max(MESH_HISTORY_LIMIT_MIN, Math.round(raw)));
}

/**
 * A numeric team setting (team contract §7.7) — teamMaxMembers, teamMaxRunningTurns,
 * teamTurnsPerMemberPerHour, teamTurnsPerDay — sanitized exactly like meshMaxLiveWorkers: a value
 * that does not read as a finite number (absent, null, garbage) is the setting's default; one
 * outside its range is clamped — 0 is "as few as possible", never "no limit" — and every value is
 * rounded to an integer. The extension writes with this and the server reads with it, so the UI,
 * the file and the engine cannot drift. Defaults and ranges: team/contract TEAM_NUMBER_SETTINGS.
 */
export function sanitizeTeamNumberSetting(key: TeamNumberSettingKey, value: unknown): number {
  const { default: fallback, min, max } = TEAM_NUMBER_SETTINGS[key];
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * teamTurnTimeoutMinutes AS STORED: an explicit value clamped to 5..240 and rounded, or undefined
 * for anything that does not read as a finite number — "not set", which means the same as
 * workerTimeoutMinutes and is kept out of the file (see teamTurnTimeoutMinutesOf).
 */
export function sanitizeTeamTurnTimeoutMinutes(value: unknown): number | undefined {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(TEAM_TURN_TIMEOUT_MINUTES.max, Math.max(TEAM_TURN_TIMEOUT_MINUTES.min, Math.round(raw)));
}

/**
 * The team turn timeout in minutes the engine uses (team contract §7.7, §12): the explicit setting
 * when there is one, else workerTimeoutMinutes — both clamped to 5..240.
 */
export function teamTurnTimeoutMinutesOf(
  registry: Pick<Registry, 'teamTurnTimeoutMinutes' | 'workerTimeoutMinutes'>,
): number {
  const explicit = sanitizeTeamTurnTimeoutMinutes(registry.teamTurnTimeoutMinutes);
  if (explicit !== undefined) {
    return explicit;
  }
  return Math.min(
    TEAM_TURN_TIMEOUT_MINUTES.max,
    Math.max(TEAM_TURN_TIMEOUT_MINUTES.min, clampTimeoutMinutes(registry.workerTimeoutMinutes)),
  );
}

/** Default of Registry.maxConcurrentDispatches, and what every value outside 1..64 reads as. */
export const DISPATCH_CONCURRENCY_DEFAULT = 8;
const DISPATCH_CONCURRENCY_MIN = 1;
const DISPATCH_CONCURRENCY_MAX = 64;

/**
 * How many dispatched workers the server runs at once (Registry.maxConcurrentDispatches): an
 * INTEGER from 1 to 64, and anything else — absent, NaN, an infinity, a fraction, 0, a negative
 * number, a number above the range, a numeric string, any other type — reads as the default.
 *
 * DEFAULTED at the edges, where its two neighbours above clamp, and strict about type where they
 * accept a numeric string. This number is a ceiling on how much runs — and bills — at the same
 * moment, so a value this reader cannot take at its word must not be bent into a neighbouring
 * one: 1e9 clamped to 64 is "as many as allowed" chosen by a typo, 0 clamped to 1 serializes a
 * batch nobody asked to serialize, and 2.5 has no reading that is what its author meant. A value
 * that does not say a count in the range says nothing, and nothing is the default.
 */
export function sanitizeDispatchConcurrency(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= DISPATCH_CONCURRENCY_MIN &&
    value <= DISPATCH_CONCURRENCY_MAX
    ? value
    : DISPATCH_CONCURRENCY_DEFAULT;
}

/** Fallbacks for the two settings that have no sanitizer constant of their own. */
const CLAUDE_PATH_DEFAULT = 'claude';
const COOLDOWN_MINUTES_DEFAULT = 30;

/**
 * Quota cooldown in minutes. An unreadable value reads as the default; a negative one reads as
 * 0, which is what it already amounted to (a cooldown that ended before it began). No upper
 * bound is imposed here: the range belongs to whoever writes the setting, and a long cooldown
 * is a legitimate choice this reader has no reason to second-guess.
 */
function sanitizeCooldownMinutes(value: unknown): number {
  const raw = numericSetting(value);
  if (!Number.isFinite(raw)) {
    return COOLDOWN_MINUTES_DEFAULT;
  }
  return Math.max(0, raw);
}

/** An optional free-text field (a guard's owning editor): the string, or absent. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/*
 * WORKER ENTRIES LIVE UNDER TWO TOP-LEVEL KEYS of registry.json:
 *
 *   - `workers`        Claude Code accounts. An entry carries NO `provider` key, exactly as every
 *                      entry written before 2.0.
 *   - `vendorWorkers`  accounts of every other agent CLI. Each entry carries its `provider`. The
 *                      key is absent from the file while there are none.
 *
 * Two keys because this file is shared with editors still running a pre-2.0 version, and such a
 * version reads EVERY element of `workers` as a Claude account: it would start `claude` with
 * CLAUDE_CONFIG_DIR pointed at another vendor's home directory, which creates Claude's files
 * inside it. That version carries top-level keys it does not know through its own writes
 * untouched, so a second key is somewhere it never looks and never damages. Hence the rule the
 * writer keeps for every file it produces (workerArrayFor): NO ELEMENT THAT NAMES A PROVIDER
 * OTHER THAN CLAUDE CODE IS EVER WRITTEN UNDER `workers` — usable or not, known vendor or not.
 *
 * AN ELEMENT READS AS ONE OF TWO THINGS (readWorkerEntry), and one of those is then sometimes
 * dropped (readWorkerArrays):
 *
 *   usable       a worker of a provider this version runs — it joins `registry.workers`;
 *   unsupported  anything else: an entry this version cannot use, or an element that is not an
 *                entry at all. It joins `registry.unsupportedWorkers`, is in no enumeration of
 *                workers, and is written back exactly as it was read (UnsupportedWorkerEntry).
 *
 * The ONE thing that is read and not written back is a usable-looking entry for an ACCOUNT
 * another usable entry already serves. That is de-duplication of something this version fully
 * understands, not a loss of something it does not.
 */

/** The two arrays of registry.json that hold worker entries, in the order they are read. */
const WORKER_SOURCES = ['workers', 'vendorWorkers'] as const;
type WorkerSource = (typeof WORKER_SOURCES)[number];

/** Longest UnsupportedWorkerEntry.providerText, in UTF-16 code units. */
const UNSUPPORTED_PROVIDER_TEXT_MAX = 40;

/**
 * UnsupportedWorkerEntry.providerText for a raw `provider` value. A string is shown as itself —
 * flattened to one line and cut, because it is text out of a hand-editable file on its way into
 * a tree row and a tool result. Anything else has no text worth showing, so the word for its
 * type stands in: a person told `(number)` knows what to look for in the file.
 */
function unsupportedProviderText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return sliceOneLine(flattenOneLine(value), UNSUPPORTED_PROVIDER_TEXT_MAX);
  }
  return `(${Array.isArray(value) ? 'array' : typeof value})`;
}

/**
 * The array an element is WRITTEN under, given the array it was `found` in.
 *
 * An element that names a provider other than Claude Code goes under `vendorWorkers`, wherever
 * it was found and whatever else is true of it — a vendor this version runs or one it has never
 * heard of, a complete entry or one with no directory or no name. `workers` is the array a
 * pre-2.0 editor runs `claude` against, and what it would be handed is this element's
 * directory. Everything else stays in the array it was found in: an element that names no
 * provider at all (absent, null, or Claude Code by name), and anything that is not an object
 * and so names nothing. Nothing is ever moved INTO `workers`.
 */
function workerArrayFor(found: WorkerSource, raw: unknown): WorkerSource {
  if (found === 'vendorWorkers') {
    return 'vendorWorkers';
  }
  const namesAnotherProvider = isJsonObject(raw) && storedProvider(raw.provider) !== 'claude';
  return namesAnotherProvider ? 'vendorWorkers' : 'workers';
}

/** What one element of `workers` / `vendorWorkers` reads as. See the note above. */
type WorkerEntryRead =
  | { kind: 'unsupported'; entry: UnsupportedWorkerEntry }
  | {
      kind: 'usable';
      worker: WorkerProfile;
      provider: ProviderId;
      source: WorkerSource;
      raw: Record<string, unknown>;
    };

/**
 * One element of `workers` or `vendorWorkers`, read by value — on its own, before it is compared
 * with any other entry (readWorkerArrays does that). `found` is the array it is in.
 *
 * NAME FIRST. An element that is not an object, or whose `name` is not a string with something
 * in it, is unsupported (`shape`) under the name `''`: it is not an entry this version can
 * address, show by name or collide with, and it is still not this version's to delete — a
 * newer version may key its entries by something this one does not read.
 *
 * THEN THE PROVIDER, read with storedProvider: absent is Claude Code; a provider id or one of its
 * aliases is that provider; ANYTHING ELSE is a provider this version does not support, and the
 * entry is unsupported for that reason. It is not read as Claude Code. A misspelt or newer
 * provider's entry names that vendor's home directory, and everything this product does to a
 * Claude account — a `claude` child with CLAUDE_CONFIG_DIR set to it, a clean-up of its
 * `sessions/` directory — would be done to that directory instead.
 *
 * THEN WHICH ARRAY IT IS IN. A Claude Code entry in `vendorWorkers` is unsupported (`shape`): no
 * version writes one there, and guessing what was meant is how an account ends up run as the
 * wrong vendor. A vendor entry in `workers` IS accepted — 2.0 development builds wrote them
 * there — and the next write of the file moves it to `vendorWorkers`.
 *
 * THEN THE DIRECTORY. `configDir` is the account; an entry without a usable one is unsupported
 * (`shape`), because it may be an entry whose account a newer version stores under a field this
 * one does not read.
 *
 * `source` — of an unsupported entry and of a usable one alike — is where the element is
 * WRITTEN (workerArrayFor), which for an element naming another provider is `vendorWorkers`
 * even when it was found in `workers`.
 *
 * A usable entry is normalized. `name` and `configDir` are kept VERBATIM (the blank test trims;
 * the value does not): the name must keep matching the stats and task-log entries filed under
 * it, and the CLI derives an account's credential key from the config-dir STRING. `provider` is
 * kept on the profile only when it is NOT Claude Code, which is what leaves a pre-2.0 entry
 * unchanged on a rewrite.
 *
 * `model` is normalized FOR THAT PROVIDER. A Claude Code worker's goes through normalizeModel,
 * so the dated tier ids every registry written before 2.0 holds read as their alias and the
 * worker's default stops going stale — unless the entry says `modelPinned: true`, when the value
 * is read exactly (it was chosen as that model, and those ids are real models the CLI still
 * offers); a value that is not a model at all reads as the default
 * tier — this is a stored DEFAULT, not a model someone just asked for, so there is nobody to
 * report the error to and a worker that cannot run is worse. Another provider's worker has no
 * tier to fall back to: a value that is not the shape of a model id reads as NO default (the
 * empty string), and the worker then runs whatever its own CLI defaults to.
 *
 * `permissionMode` is the worker's own, in its provider's vocabulary, and is dropped when it is
 * that provider's default or not a mode the provider accepts — so "absent" always means "the
 * default" and a stale value can never reach an argv.
 * `preferred` and `modelPinned` are flags: only the literal `true` sets either.
 */
function readWorkerEntry(raw: unknown, found: WorkerSource): WorkerEntryRead {
  const source = workerArrayFor(found, raw);
  const fields = isJsonObject(raw) ? raw : undefined;
  const name =
    fields !== undefined && typeof fields.name === 'string' && fields.name.trim() !== ''
      ? fields.name
      : '';
  const unsupported = (reason: UnsupportedWorkerEntry['reason']): WorkerEntryRead => ({
    kind: 'unsupported',
    entry: { name, reason, providerText: unsupportedProviderText(fields?.provider), source, raw },
  });
  if (fields === undefined || name === '') {
    return unsupported('shape');
  }
  const provider = storedProvider(fields.provider);
  if (provider === undefined) {
    return unsupported('provider');
  }
  if (found === 'vendorWorkers' && provider === 'claude') {
    return unsupported('shape');
  }
  const { configDir } = fields;
  if (typeof configDir !== 'string' || configDir.trim() === '') {
    return unsupported('shape');
  }
  const permissionMode = normalizeProviderPermissionMode(provider, fields.permissionMode);
  const worker: WorkerProfile = {
    // Keys this version does not know travel on untouched, as they do at the top level.
    ...fields,
    name,
    configDir,
    provider: provider === 'claude' ? undefined : provider,
    model:
      provider === 'claude'
        ? normalizeModel(fields.model, { exact: fields.modelPinned === true }) ?? DEFAULT_WORKER_MODEL
        : normalizeProviderModel(provider, fields.model) ?? '',
    modelPinned: fields.modelPinned === true ? true : undefined,
    permissionMode:
      permissionMode !== null && permissionMode !== providerInfo(provider).defaultPermissionMode
        ? permissionMode
        : undefined,
    preferred: fields.preferred === true ? true : undefined,
  };
  return { kind: 'usable', worker, provider, source, raw: fields };
}

/**
 * The provider a worker runs on. The ONE way to ask: `provider` is absent on every Claude Code
 * worker.
 *
 * PRECONDITION: the profile came out of readRegistry, or was built with a typed `provider`. A
 * `provider` that is present and is not a provider id is reachable only through a cast, and it
 * THROWS here rather than reading as some provider: every caller goes on to aim one vendor's
 * machinery — a CLI, a home-directory variable, a clean-up — at the profile's directory, so any
 * answer this function gave for a value it does not know would be the wrong vendor's.
 */
export function workerProvider(worker: { provider?: unknown }): ProviderId {
  const provider = storedProvider(worker.provider);
  if (provider === undefined) {
    throw new TypeError('workerProvider: unknown provider — not a registry worker');
  }
  return provider;
}

/**
 * The workers that are Claude Code accounts — THE enumeration for everything that treats a
 * worker's `configDir` as a Claude config directory: the session-worker bridge's participants,
 * a `claude agents` probe and the directories it may be aimed at, a session-registry scan, the
 * overage reading, any `claude` spawn.
 *
 * It exists because that is not a harmless thing to get wrong for another vendor's account. A
 * real `~/.codex` has a `sessions/` directory of its own, which a session-registry scan then
 * reads as Claude's; and a `claude` process started with CLAUDE_CONFIG_DIR pointed at a vendor
 * home CREATES Claude config files inside it. One helper, so no call site decides for itself
 * what "a Claude account" means.
 */
export function claudeWorkers(registry: { workers: readonly WorkerProfile[] }): WorkerProfile[] {
  return registry.workers.filter((worker) => workerProvider(worker) === 'claude');
}

/**
 * An ACCOUNT: one provider on one resolved directory. The directory is compared resolved
 * (lexically — no filesystem access), so `~/x` and `~/x/` are one account; the provider is part
 * of the key because two vendors' CLIs keep unrelated logins and may legitimately be pointed at
 * the same directory.
 */
function accountKeyOf(provider: ProviderId, configDir: string): string {
  return `${provider}\0${path.resolve(configDir)}`;
}

/**
 * Both worker arrays of a parsed registry, read into the usable workers and the unsupported
 * entries. `workers` is read first, then `vendorWorkers`, each in file order; a key that holds
 * no array holds no entries (readRegistryChecked reports one that holds something else).
 *
 * Each element is read on its own first (readWorkerEntry). The usable ones are then put in the
 * order they are RETURNED and WRITTEN in — Claude Code accounts, then the other vendors', each
 * group in file order — and compared with one another in that order:
 *
 *   - an entry for the ACCOUNT of an earlier usable entry is DROPPED. Two entries naming one
 *     account are one login counted twice: automatic assignment would treat them as two places
 *     to put work, and a quota failover from one to the "other" would send the task straight
 *     back to the account that just refused it. The first entry wins.
 *   - an entry with the exact NAME of an earlier usable entry is UNSUPPORTED (`duplicate-name`).
 *     A name is what a dispatch asks for and what stats and task events are filed under, so two
 *     usable workers cannot share one; but the second is a different account, and an account is
 *     not dropped because of what it is called.
 *
 * "Earlier" means earlier in THAT order, not in the file's, and a duplicate name that turns out
 * to be an account some usable entry serves — whichever came first — is dropped, not kept. Both
 * are what reading the file again after this version wrote it would decide anyway: the writer
 * moves vendor entries to their own array and puts unsupported entries after the usable ones.
 * Deciding it in one read is what makes a write of what was read leave the same bytes the next
 * time, instead of one that settles on the second pass with a different winner for a name.
 *
 * `unsupported` comes back in the order it is WRITTEN in (registryFileText), for the same
 * reason: the entries written under `workers`, then those under `vendorWorkers`; within each,
 * the ones with a name before the ones without; and otherwise in file order. An index into it
 * therefore names the same entry before and after this version rewrites the file.
 */
function readWorkerArrays(raw: Record<string, unknown>): {
  workers: WorkerProfile[];
  unsupported: UnsupportedWorkerEntry[];
} {
  interface Candidate {
    at: number;
    source: WorkerSource;
    worker: WorkerProfile;
    account: string;
    raw: Record<string, unknown>;
  }
  const claude: Candidate[] = [];
  const vendor: Candidate[] = [];
  const unsupported: Array<{ at: number; entry: UnsupportedWorkerEntry }> = [];
  let at = 0;
  for (const found of WORKER_SOURCES) {
    const list: unknown = raw[found];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const element of list) {
      at++;
      const read = readWorkerEntry(element, found);
      if (read.kind === 'unsupported') {
        unsupported.push({ at, entry: read.entry });
      } else {
        (read.provider === 'claude' ? claude : vendor).push({
          at,
          source: read.source,
          worker: read.worker,
          account: accountKeyOf(read.provider, read.worker.configDir),
          raw: read.raw,
        });
      }
    }
  }
  const workers: WorkerProfile[] = [];
  const accounts = new Set<string>();
  const names = new Set<string>();
  const sameName: Candidate[] = [];
  for (const candidate of [...claude, ...vendor]) {
    if (accounts.has(candidate.account)) {
      continue;
    }
    if (names.has(candidate.worker.name)) {
      sameName.push(candidate);
      continue;
    }
    accounts.add(candidate.account);
    names.add(candidate.worker.name);
    workers.push(candidate.worker);
  }
  for (const candidate of sameName) {
    if (accounts.has(candidate.account)) {
      continue;
    }
    unsupported.push({
      at: candidate.at,
      entry: {
        name: candidate.worker.name,
        reason: 'duplicate-name',
        providerText: unsupportedProviderText(candidate.raw.provider),
        source: candidate.source,
        raw: candidate.raw,
      },
    });
  }
  const rank = (found: { at: number; entry: UnsupportedWorkerEntry }): number =>
    (found.entry.source === 'workers' ? 0 : 2) + (found.entry.name === '' ? 1 : 0);
  unsupported.sort((a, b) => rank(a) - rank(b) || a.at - b.at);
  return { workers, unsupported: unsupported.map((found) => found.entry) };
}

/**
 * Modes of what this module creates under ROOT_DIR: directories for their owner alone, files for
 * their owner alone. The directory holds the worker accounts' names and directories, every
 * dispatched prompt and report, and the task log; on a shared machine none of that is another
 * user's to read. Neither number means anything on win32, where Node ignores a create mode.
 */
const DATA_DIR_MODE = 0o700;
const DATA_FILE_MODE = 0o600;

/** Set once this process has looked at ROOT_DIR's own mode (closeDataDir). */
let dataDirClosed = false;

/**
 * Make sure the data directory and its tasks directory exist — and, the first time this process
 * asks, that the data directory is closed to other users.
 *
 * A directory created here is created DATA_DIR_MODE. One that already exists was created by an
 * earlier version with the process umask, which on most machines leaves it listable and readable
 * by everyone; closeDataDir tightens that one directory, once per process. Closing the top is
 * what counts: nothing beneath a directory other users cannot enter is reachable by them,
 * whatever the modes down there are.
 */
export function ensureDirs(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true, mode: DATA_DIR_MODE });
  if (!dataDirClosed) {
    dataDirClosed = true;
    closeDataDir();
  }
}

/**
 * Take group and other access off ROOT_DIR — only when it is a REAL directory owned by this
 * user, and only when it grants them anything. Best effort: every failure is ignored, because
 * the callers are the write paths of the whole product and none of them may fail over a mode.
 *
 * Opened without following a link and asked what it is through that descriptor, so the thing
 * checked and the thing changed are one object. A symbolic link at ROOT_DIR is LEFT ALONE: a
 * person who points this directory somewhere else chose that somewhere, and its mode is theirs.
 * No-op on win32, which has neither the modes nor the flags.
 */
function closeDataDir(): void {
  const { O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    typeof O_DIRECTORY !== 'number' ||
    typeof O_NOFOLLOW !== 'number'
  ) {
    return;
  }
  let fd = -1;
  try {
    fd = fs.openSync(ROOT_DIR, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) !== 0) {
      fs.fchmodSync(fd, DATA_DIR_MODE);
    }
  } catch {
    // a symbolic link (ELOOP), a directory this user may not open, a filesystem without modes
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
 * A Registry built BY VALUE from a parsed registry.json object (`{}` for none): each known field
 * is re-read from what the object holds rather than trusted to be the type its name implies.
 * Always a fresh object, `workers` and `unsupportedWorkers` included.
 */
function registryFrom(raw: Record<string, unknown>): Registry {
  const { workers, unsupported } = readWorkerArrays(raw);
  // Settings of features removed in 2.0 (the relay gateway's model, the idle auto-stop). Deleted
  // from what was read, so a registry.json that still carries them is not an error, nothing can
  // read them back, and the next write of this object drops them from the file.
  delete raw.meshGatewayModel;
  delete raw.meshWorkerIdleTimeoutMin;
  // `vendorWorkers` is a key of the FILE. In memory its entries are in `workers` and
  // `unsupportedWorkers`, and a copy left on the object would be a second, stale answer.
  delete raw.vendorWorkers;
  return {
    // Keys this version does not know (a newer editor sharing this file may have written them)
    // travel on untouched. Every key this version DOES know is listed below and wins.
    ...raw,
    workers,
    unsupportedWorkers: unsupported,
    maxConcurrentDispatches: sanitizeDispatchConcurrency(raw.maxConcurrentDispatches),
    permissionMode: normalizePermissionMode(raw.permissionMode),
    // Verbatim when usable: resolveClaudePathPreserving and resolveProbeCommand own trimming
    // and resolution, and both already treat a blank as "use the bare command".
    claudePath:
      typeof raw.claudePath === 'string' && raw.claudePath.trim() !== ''
        ? raw.claudePath
        : CLAUDE_PATH_DEFAULT,
    cooldownMinutes: sanitizeCooldownMinutes(raw.cooldownMinutes),
    workerTimeoutMinutes: clampTimeoutMinutes(raw.workerTimeoutMinutes),
    // Both billing guards read the same way. Every registry file written before a guard
    // existed lacks its field, and the file is hand-editable. Anything that is not exactly
    // 'allow' — absent, null, misspelled — must read as the safe 'block': money is only ever
    // spent on the frontier tier, or past a plan window, when an editor explicitly opted in.
    frontierWorkerDispatch: raw.frontierWorkerDispatch === 'allow' ? 'allow' : 'block',
    frontierGuardSetBy: optionalString(raw.frontierGuardSetBy),
    overageWorkerDispatch: raw.overageWorkerDispatch === 'allow' ? 'allow' : 'block',
    overageGuardSetBy: optionalString(raw.overageGuardSetBy),
    // The experimental mesh switch is opt-in and the file is hand-editable: anything
    // that is not exactly 'on' — absent, null, misspelled — reads as the safe 'off'.
    meshMode: raw.meshMode === 'on' ? 'on' : 'off',
    // Sanitized by VALUE, not by presence: an absent field and a garbage one both land on
    // the default, and an out-of-range one is clamped. See the two helpers for the edges.
    meshMaxLiveWorkers: sanitizeMeshMaxLive(raw.meshMaxLiveWorkers),
    meshHistoryLimit: sanitizeMeshHistoryLimit(raw.meshHistoryLimit),
    // An opt-OUT: only the literal `false` is one. Anything else reads as the default (allowed)
    // and is dropped, so the field exists in the file only while it says something.
    providerUsagePolling: raw.providerUsagePolling === false ? false : undefined,
    // Teammate mode (team contract §7.7), read like the mesh switch and its numbers: the three
    // switches are 'on' only for the literal 'on'; the numbers by value, defaulted or clamped.
    // The turn timeout is the one that stays ABSENT when unset (its default is another setting's
    // value), so it is dropped from the file rather than written as a number that would stop
    // following workerTimeoutMinutes.
    teamMode: raw.teamMode === 'on' ? 'on' : 'off',
    teamMaxMembers: sanitizeTeamNumberSetting('teamMaxMembers', raw.teamMaxMembers),
    teamMaxRunningTurns: sanitizeTeamNumberSetting('teamMaxRunningTurns', raw.teamMaxRunningTurns),
    teamTurnTimeoutMinutes: sanitizeTeamTurnTimeoutMinutes(raw.teamTurnTimeoutMinutes),
    teamTurnsPerMemberPerHour: sanitizeTeamNumberSetting('teamTurnsPerMemberPerHour', raw.teamTurnsPerMemberPerHour),
    teamTurnsPerDay: sanitizeTeamNumberSetting('teamTurnsPerDay', raw.teamTurnsPerDay),
    teamCursorForce: raw.teamCursorForce === 'on' ? 'on' : 'off',
    teamAgySkipPermissions: raw.teamAgySkipPermissions === 'on' ? 'on' : 'off',
  };
}

/**
 * The shared registry, read BY VALUE, together with WHETHER THE FILE COULD BE UNDERSTOOD.
 *
 * `problem` is null when there is nothing wrong to report: the file parses to an object whose
 * worker arrays are arrays, or there is no file, or it is empty — a first run. Otherwise it is
 * one line saying what is wrong with the file (StateFileRead's `problem`: `not valid JSON (…)`,
 * `not a JSON object`, `larger than 1 MiB`, `not a regular file`, an errno code; or
 * workerListProblem's `its "workers" value is not a list`), and `registry` is then the DEFAULT
 * registry — no workers, every setting at its default — which is NOT what the file holds.
 *
 * So a caller that is about to say "no workers are registered", or to pick, count or list
 * workers for a decision, must look at `problem` first: with a problem the true answer is "the
 * registry could not be read". Never throws.
 */
export function readRegistryChecked(): { registry: Registry; problem: string | null } {
  const read = readStateFile(REGISTRY_FILE);
  if (read.state !== 'ok') {
    return {
      registry: registryFrom({}),
      problem: read.state === 'fresh' ? null : read.problem,
    };
  }
  const problem = workerListProblem(read.object);
  return { registry: registryFrom(problem === null ? read.object : {}), problem };
}

/**
 * What is wrong with the worker arrays of a parsed registry, or null. `workers` and
 * `vendorWorkers` each hold a list, or nothing — the key absent, or `null`, which a file may
 * legitimately have and which both mean "no entries". A value that is PRESENT and is something
 * else (an object, a string, a number) is where the accounts would be, in a form this version
 * cannot read: treating it as "no workers" and writing the file back would replace it with an
 * empty list. So it is a problem like any other, and the writers refuse.
 */
function workerListProblem(raw: Record<string, unknown>): string | null {
  for (const key of WORKER_SOURCES) {
    const value = raw[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      return `its "${key}" value is not a list`;
    }
  }
  return null;
}

/**
 * The shared registry, read BY VALUE (see "Reading the small JSON state files" above). Never
 * throws: a file that is missing, or that could not be read or understood, reads as an empty
 * registry with every setting at its default. That is right for a render path and wrong for a
 * decision — see readRegistryChecked, which this is the `registry` half of.
 */
export function readRegistry(): Registry {
  return readRegistryChecked().registry;
}

/**
 * Open flags for the TEMP FILE of an atomic write: write-only, create, truncate, NON-BLOCKING, no
 * controlling terminal, and NO-FOLLOW.
 *
 * DELIBERATELY SEPARATE FROM `WRITE_TRUNC_NONBLOCK` below, which serves clearTaskLog. That path is
 * a user-visible log a person may legitimately keep at a symlink, so it must keep following
 * symlinks exactly as `writeFileSync` did, and its doc comment says so. A `.tmp` scratch name that
 * this module creates and consumes inside a single call has no such user, so it gets the stricter
 * set. Merging the two constants would silently take the log's symlink support away.
 *
 * WHY EACH FLAG IS LOAD-BEARING. The temp path is not a private name: it is a file name this
 * module hard-codes plus the writing process's pid, so a dispatched worker — which runs Bash under
 * `bypassPermissions` and is told the directories these files live in — can derive it to within a
 * few hundred guesses and pre-create every candidate.
 *
 *  - O_NONBLOCK: opening a FIFO for WRITING blocks until a READER appears, and none ever does.
 *    That is the measured brick. `fs.writeFileSync` on a worker-planted FIFO hangs forever, inside
 *    a call reached synchronously from the extension host's `activate()` and from the MCP server's
 *    polled tools — and a hang is not catchable, so the try/catch those callers already have saves
 *    nothing. With the flag the open fails ENXIO immediately instead.
 *  - O_NOFOLLOW: the flag the READ side does not need and this side does, because what follows a
 *    successful write here is a RENAME. A symlink at the temp path passes an fstat whenever it
 *    points at a regular file, and `rename` moves the LINK, not its target — so registry.json,
 *    stats.json or tasks.jsonl would BECOME a symlink to a path of the worker's choosing, and
 *    every later read of them would return that worker's bytes. Refusing the symlink outright
 *    (ELOOP) is the only way to close that, and it costs nothing: nobody legitimately symlinks a
 *    scratch file whose whole life is one call.
 *  - O_NOCTTY: a character device at the path must not become this process's controlling terminal
 *    merely by being opened.
 *
 * O_EXCL IS DELIBERATELY ABSENT, and that is a decision rather than an omission. It looks like the
 * obvious answer to "something is already at my temp path" and it is wrong twice: a temp file left
 * behind by a writer that crashed between its write and its rename would then block every later
 * write FOREVER (pids are reused, and assets.ts's temp name is not even pid-scoped), and a worker
 * could manufacture that same permanent outage on purpose with one `touch`. O_TRUNC plus the fstat
 * below is the combination that is both hang-proof and litter-proof: a stale REGULAR temp file is
 * truncated and reused, exactly as `writeFileSync` always did, and anything that is not a regular
 * file is refused.
 *
 * Written as explicit `typeof` tests rather than `?? 0` because win32 defines none of the three,
 * and an undefined constant folded into a bitwise OR becomes NaN — an unopenable flag set, i.e. a
 * self-inflicted total outage. Windows therefore degrades to plain create+truncate, where the
 * fstat below still refuses a directory or a device, and where the FIFO attack has no spelling
 * (named pipes live in the \\.\pipe\ namespace and cannot be created inside these directories).
 */
const TMP_WRITE_GUARDED =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

/** What the thing at a temp path actually is, for a refusal reason. Literals only. */
function tempPathKind(st: fs.Stats): string {
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

/**
 * Write `data` to the temp path of an atomic write. Returns undefined on success, or a short
 * reason on refusal. NEVER THROWS and never blocks.
 *
 * GUARDED LOCALLY RATHER THAN IN safeFs, AND IT MUST STAY THAT WAY — read this before
 * "consolidating" it. safeFs owns reading and appending and offers NO truncating write, on
 * purpose: its entire discipline is "prove it is a regular file BEFORE you touch it", and an
 * O_TRUNC open cannot honour that ordering, because the truncation happens IN the open. Moving
 * this function there would either break that promise for its existing callers or give safeFs a
 * second, weaker contract inside the one module whose value is that it has exactly one. So the
 * same standard is met here in the only order this operation allows — open non-blocking, then
 * fstat the fd we opened, then refuse — and it is met identically at the four atomic-write sites
 * in this repo (`atomicWrite` here, `assets.writeAssetState`, `keepalive.recordStamp`,
 * `mesh/bridge.writeMirror`), each of the other three carrying a pointer back to this comment.
 * Truncating first costs nothing: the only thing ever at a temp path is our own litter or a
 * squatter, and neither holds bytes anyone may read.
 *
 * FSTAT THE SAME fd, never stat-then-open. Between a `statSync` and an `openSync` the name can be
 * swapped, and the process doing the swapping can retry it in a loop until it lands: the check
 * would describe the decoy and the write would land in the replacement. An fstat asks the OPEN
 * FILE what it is, so the thing measured and the thing written are one object.
 *
 * ON REFUSAL THE TEMP NAME IS CLEARED, best effort, in the finally. Without it a single planted
 * FIFO would turn a permanent HANG into a permanent REFUSAL — better, but still an outage, since
 * the pid in the name is fixed for the life of the process and assets.ts's temp name has no pid in
 * it at all. The unlink can only ever remove the `.tmp` name this function was handed, a name this
 * codebase owns by construction, and it is swallowed because a failed cleanup must never replace
 * the real reason with a worse one. It also does the right thing on ENOSPC: the partial temp goes
 * away instead of holding the disk space that caused the failure.
 *
 * RESIDUAL, STATED RATHER THAN IMPLIED: the rename that follows a successful return is a separate
 * syscall, so a worker that replaces the temp file in the microseconds between the two gets its
 * replacement renamed into place. Node exposes neither `renameat2` nor `linkat`, so write-then-
 * rename cannot be made one operation here. What is closed is the hang, the /dev/zero crash and
 * the symlink hijack — the three that survive an unlucky schedule rather than needing one.
 */
function writeTempFileGuarded(tmp: string, data: string): string | undefined {
  let fd = -1;
  // Initialised to the generic reason so no path below can fall through as a silent success.
  let reason: string | undefined = 'the temp file could not be opened or written';
  try {
    // Created DATA_FILE_MODE. The rename that follows gives the destination this file's mode, so
    // this is the mode registry.json, stats.json and the rest end up with.
    fd = fs.openSync(tmp, TMP_WRITE_GUARDED, DATA_FILE_MODE);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      reason = `the temp path is ${tempPathKind(st)}`;
    } else {
      // An EXISTING temp file keeps the mode it was made with — litter of an earlier version, or
      // something put there — and the create mode above does not apply to it. Set on the
      // descriptor, so it is this file and no other; best effort, because a file whose mode
      // cannot be changed can still be written and a mode must not cost the write.
      if (process.platform !== 'win32' && (st.mode & 0o777) !== DATA_FILE_MODE) {
        try {
          fs.fchmodSync(fd, DATA_FILE_MODE);
        } catch {
          // not ours to change — written with the mode it has
        }
      }
      const buf = Buffer.from(data, 'utf8');
      let written = 0;
      // LOOP ON SHORT WRITES. `writeSync` may write fewer bytes than it was given, and a
      // single-call writer truncates the payload silently — which for these callers means half a
      // JSON document renamed into place as though it were whole, i.e. precisely the tearing the
      // tmp+rename dance exists to prevent.
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) {
          break;
        }
        written += n;
      }
      reason =
        written < buf.length
          ? `only ${written} of ${buf.length} bytes could be written`
          : undefined;
    }
  } catch (e) {
    // Only a shape-checked errno code is quoted. `err.code` is whatever the throwing object
    // carries, and a caught value here can be one this module did not create — opening a unix
    // socket on macOS throws with a `code` of "Unknown system error -102" and a message that
    // quotes the PATH, which must not ride out into an error string a model may parse.
    const code: unknown = (e as { code?: unknown } | null | undefined)?.code;
    reason =
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
        ? `the temp file could not be opened or written (${code})`
        : 'the temp file could not be opened or written';
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — and a failing close cannot lose bytes written with writeSync
      }
    }
    if (reason !== undefined) {
      // Clear the squatter so the NEXT write self-heals. `unlink` covers a file, a FIFO, a socket,
      // a device node and a symlink; a DIRECTORY needs `rmdir`, and without that fallback a
      // planted directory would be a PERMANENT refusal where a planted FIFO is a one-shot one —
      // measured, not assumed. Both are swallowed and neither is load-bearing: a squatter we
      // cannot remove is still refused, just not self-healed, and a failed cleanup must never
      // replace the real reason with a worse one.
      try {
        fs.unlinkSync(tmp);
      } catch {
        try {
          fs.rmdirSync(tmp);
        } catch {
          // a non-empty directory, or a path this process may not modify — refused either way
        }
      }
    }
  }
  return reason;
}

/**
 * Write a file so concurrent readers (the MCP dispatch server runs in a
 * separate process and reads these files) never observe a torn or truncated
 * result: write to a pid-scoped temp file, then atomically rename it into place.
 *
 * A REFUSED TEMP WRITE THROWS, AND THE RENAME DOES NOT RUN. Both halves are the decision.
 *
 * The rename half is not negotiable. `rename` moves whatever the temp NAME refers to, so renaming
 * after a refused write is how a FIFO becomes registry.json (every later read of it then blocks
 * forever) and how a planted directory becomes stats.json (nothing can ever be written there
 * again). Skipping it leaves the destination exactly as it was — a whole, valid, previous
 * generation — which is the same state a crash between the two lines has always produced and the
 * state every reader of these files already tolerates.
 *
 * The throw half is chosen for the callers, all four of which persist a DECISION rather than a
 * cache: `writeRegistry` and `updateRegistry` (a worker added, removed, renamed, a setting
 * flipped), `writeStats` and `updateStats`, and `renameWorker`'s tasks.jsonl migration. A silent
 * no-op there is the failure mode this codebase has already shipped twice: the UI reports the
 * worker added, the ledger says otherwise, and nothing anywhere names the moment it diverged.
 * `renameWorker` is the sharpest case — it is a three-step migration whose own comment already
 * establishes that a refusal must throw, because a skipped step leaves the ledger naming the old
 * worker while registry.json names the new one.
 *
 * Throwing is also the EXISTING contract, not a new one: `fs.writeFileSync` and `fs.renameSync`
 * both throw here today on ENOSPC, EACCES, EROFS and EDQUOT, so every caller of `atomicWrite`
 * already has a path for it — including the two that reach it from `activate()`, which catch. The
 * thing that was never catchable, and is what this guard actually changes, is the hang.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const refused = writeTempFileGuarded(tmp, data);
  if (refused !== undefined) {
    throw new Error(`Could not write ${file}: ${refused}. Nothing was changed.`);
  }
  fs.renameSync(tmp, file);
}

/**
 * The age past which a lock's AGE is consulted at all — and it is never, on its own, a reason to
 * break one. A lock is broken only when its holder is PROVEN gone (see lockClaimantGone); age is
 * not proof, because a holder that is alive and merely slow — a hung `ps`, a SIGSTOP, a debugger —
 * has an old lock too, and breaking that one puts two processes in the section together. Two
 * things still use this number:
 *   - a live pid whose claim is older than this is probed for its start time AT ONCE rather than
 *     after LOCK_PROBE_AFTER_MS of watching, so a lock that survived a reboot under a recycled
 *     pid costs the first waiter one `ps` and no wait;
 *   - on win32, which offers no way to ask when another process started, it is the declared
 *     fallback: a live pid that has not restamped its lock for this long is treated as gone.
 *     That is the old heuristic, kept on the one platform with nothing better. See the WINDOWS
 *     note on withLockAt.
 */
const LOCK_STALE_MS = 30_000;
/**
 * Give up WAITING for a lock after this long and THROW. A waiter never takes a lock by force:
 * the "break it anyway" backstop that used to fire here evicted holders that were alive, which
 * is the lost update this lock exists to prevent.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
/** Poll interval while a lock is held by a live holder. */
const LOCK_SPIN_MS = 15;
/**
 * Slack allowed when comparing a live pid's process START TIME against the moment its lock was
 * claimed. `ps` reports elapsed run time truncated to whole SECONDS, so a start time computed
 * from it lands up to a second LATE, and a wall-clock step between the claim and the probe moves
 * the two readings against each other. A holder is therefore called recycled only when its
 * process started this much AFTER its own lock stamp — a gap no such artifact can produce.
 */
const LOCK_HOLDER_START_SLACK_MS = 5_000;
/**
 * How long ONE waiter must have watched the SAME claim by a live pid before it spends a `ps` on
 * asking whether that pid is still the process that made it. Sections here are milliseconds
 * long, so a claim that has not changed hands in this long is already unusual — and without the
 * probe the waiter can only time out. Never reached on the hot path, where the token changes
 * with every handover.
 */
const LOCK_PROBE_AFTER_MS = 2_000;
/**
 * How long a regular file that carries NO usable token must have sat at the lock path before it
 * is treated as nobody's. This module publishes its locks whole (see publishLock), so such a
 * file is not one of them — but a pre-2.0 process, and this one where symbolic links are
 * unavailable, creates the file first and stamps it second, and for those few microseconds its
 * lock IS an empty file. The grace covers that window with three orders of magnitude to spare,
 * and it is a grace for an UNSTAMPED file only: a lock with a token in it is judged by its
 * holder, never by its age.
 */
const LOCK_UNSTAMPED_GRACE_MS = 2_000;
/**
 * Read ceiling for a lock TOKEN kept in a regular file (the pre-2.0 form, and this module's
 * fallback). A token is `<pid> <ms> <base36> <ms> <ticks>` — under 80 bytes — so 4 KiB is a
 * whole page of slack over any conceivable future format while still refusing the one thing
 * that matters: the lock path is a name a dispatched worker can create (TASKS_DIR
 * is world-writable to it, and `<id>.reconcile.lock` is derived from an id the worker knows), so
 * its SIZE is untrusted. Without a cap, `readFileSync` on a hand-placed multi-gigabyte file at
 * that path is an out-of-memory lever on a path that runs from the extension host's activate().
 * A file past the cap is REFUSED, and a refusal reads as "no token" — which is exactly what a
 * token we cannot parse has always meant.
 */
const LOCK_TOKEN_MAX_BYTES = 4096;
/**
 * How many names one breaker election will read out of `<lock>.breakers/`. The directory is a
 * name an untrusted process can fill, and a listing materializes every name it is asked for; an
 * election has one entry per process contending to clear ONE abandoned lock, so a directory past
 * this is not an election. Past the cap nobody is elected and the waiter keeps waiting.
 */
const LOCK_ELECTION_MAX_ENTRIES = 256;

/**
 * Open flags for the two reads this file still performs by hand (taskLogTail's last-byte
 * probe): read-only, and NON-BLOCKING where the platform has the flag. See the FIFO note in
 * readResultFile for why the second half is load-bearing. Written as an explicit `typeof` test
 * rather than `?? 0` because win32 does not define O_NONBLOCK at all, and a `number | undefined`
 * folded into a bitwise OR becomes NaN, i.e. an unopenable flag set. Declared here, above its
 * first use, rather than beside the result-file constants where it began.
 */
const READ_ONLY_NONBLOCK =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0);

/**
 * Open flags for clearTaskLog's truncate: write-only, create, truncate, and NON-BLOCKING on the
 * platforms that have the flag. The non-blocking half is the whole point on the WRITE side too,
 * and it is a different hazard from the read side: opening a FIFO for WRITING blocks until a
 * READER appears, so `writeFileSync(TASKS_LOG_FILE, '')` against a worker-planted FIFO hangs the
 * Clear command forever. With O_NONBLOCK that open fails ENXIO immediately instead.
 */
const WRITE_TRUNC_NONBLOCK =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0);

/**
 * Block the calling thread for `ms` WITHOUT a busy-loop. Atomics.wait on a private
 * SharedArrayBuffer parks the thread (no CPU burn) and needs no async plumbing, so
 * the synchronous read-modify-write helpers below can spin-wait for a contended
 * lock without turning into async functions and rippling through every caller.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

/**
 * What `ps` can say about the process `pid`: whether it is a zombie, and the epoch ms at which
 * it started. Undefined when nothing could be established at all.
 *
 * Node exposes no portable API for another process's start time — which is exactly why the mesh
 * owner lock records its own `startedAt` next to its `ownerPid` and then documents that field as
 * a SANITY TOKEN rather than a guard (src/mcp/server.ts, finding M2): the recorded value proves
 * the record's shape, not the identity of whoever wears that pid now. This module can answer the
 * question outright instead of documenting a residual, because it already trusts `ps` for the
 * neighbouring pid-identity question — isOurWorker and isOurSupervisor exist for precisely the
 * same hazard and read `ps -o args=` to close it. Here the fields are `stat` and `etime`, the
 * process's elapsed run time as `[[DD-]HH:]MM:SS`: locale-independent (unlike `lstart`, whose
 * format follows LC_TIME) and a plain subtraction away from a start time. Each is asked for with
 * its own `-o`, because procps reads `-o stat=,etime=` as ONE column whose header is `,etime=`.
 *
 * The ZOMBIE answer is a second proof the start time cannot give. A process that was killed is a
 * zombie until its parent reaps it, and `kill(pid, 0)` succeeds on a zombie — so a lock whose
 * holder died under a parent that is itself stopped, or simply busy, names a "live" pid for as
 * long as that lasts. A zombie runs no code, so it holds nothing.
 *
 * The clock is read BEFORE the probe on purpose. The spawn costs milliseconds, and taking `now`
 * first makes the computed start time EARLIER than the truth — the direction that cannot accuse
 * a genuine holder of being somebody else.
 *
 * Every failure — win32 (no `ps`, the same declared gap isOurWorker lives with), a `ps` that is
 * missing (BusyBox has no `-p`), fails or times out, output in a shape this does not recognize —
 * answers undefined, i.e. NO EVIDENCE, and no evidence never breaks a lock. Never throws.
 */
function probeProcess(pid: number): { zombie: boolean; startedAt: number | undefined } | undefined {
  if (process.platform === 'win32' || !Number.isFinite(pid) || pid <= 0) {
    return undefined;
  }
  const before = Date.now();
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'stat=', '-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
  const columns = /^(\S+)(?:\s+(\S+))?$/.exec(out);
  if (columns === null) {
    return undefined;
  }
  const zombie = columns[1].startsWith('Z');
  // Anchored at both ends: a shape this does not recognize is no evidence, never a guess.
  const parts = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(columns[2] ?? '');
  if (parts === null) {
    return zombie ? { zombie, startedAt: undefined } : undefined;
  }
  const days = parts[1] === undefined ? 0 : parseInt(parts[1], 10);
  const hours = parts[2] === undefined ? 0 : parseInt(parts[2], 10);
  const minutes = parseInt(parts[3], 10);
  const seconds = parseInt(parts[4], 10);
  const elapsedMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return zombie ? { zombie, startedAt: undefined } : undefined;
  }
  return { zombie, startedAt: before - elapsedMs };
}

/**
 * What Linux's procfs says about the process `pid`: the kernel's own record of when it started
 * (field 22 of `/proc/<pid>/stat`, in clock ticks since boot, kept as the string it is so no
 * precision is lost) and whether it is a zombie. Undefined off Linux and whenever the file
 * cannot be read or parsed.
 *
 * This is the EXACT process identity, and the reason it is used wherever it exists: two
 * processes that wear the same pid at different times cannot share a start tick, the value
 * never moves when the wall clock is stepped, and reading it spawns nothing — it works in a
 * BusyBox container, where `ps -p` does not exist and pids are recycled on every restart. The
 * fields are taken after the LAST `)`: field 2 is the command name in parentheses and may itself
 * contain spaces and parentheses.
 */
function linuxProcessStat(pid: number): { start: string; zombie: boolean } | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    if (start === undefined || !/^\d{1,20}$/.test(start)) {
      return undefined;
    }
    return { start, zombie: fields[0] === 'Z' || fields[0] === 'X' };
  } catch {
    return undefined;
  }
}

/**
 * This process's own start identity, as it stamps it into every lock it takes. Computed once.
 *
 *   - `procStart` is `performance.timeOrigin`: the wall clock AS IT READ WHEN THIS PROCESS BEGAN,
 *     fixed from then on. That is the property wanted. The obvious alternative,
 *     `Date.now() - process.uptime()`, is recomputed against today's clock and against a
 *     monotonic timer that stops while the machine sleeps, so it drifts away from what `ps`
 *     reports by exactly the amounts that matter (a clock step, a night with the lid shut).
 *     0 means "unknown" and is treated as a field that is not there.
 *   - `kernelStart` is the procfs start tick, on Linux only.
 */
let lockSelfCache: { procStart: number; kernelStart: string | undefined } | undefined;
function lockSelf(): { procStart: number; kernelStart: string | undefined } {
  if (lockSelfCache === undefined) {
    const origin = Math.floor(performance.timeOrigin);
    lockSelfCache = {
      procStart: Number.isFinite(origin) && origin > 0 ? origin : 0,
      kernelStart: linuxProcessStat(process.pid)?.start,
    };
  }
  return lockSelfCache;
}

/**
 * Who made a claim — a lock token, or a breaker-election entry — as read back from its text.
 * `key` is that exact text: the memo key, and the identity of the claim itself, since every
 * claim this module writes carries fresh randomness.
 */
interface LockClaim {
  key: string;
  pid: number;
  /** Epoch ms the claim was stamped, 0 when it does not say. */
  claimedAt: number;
  /** The claimant's own `procStart`, undefined when the claim predates the field. */
  procStart: number | undefined;
  /** The claimant's own procfs start tick, undefined off Linux and on older claims. */
  kernelStart: string | undefined;
}

/**
 * A fresh claim for THIS process, its five fields joined by `separator` (a space in a lock file,
 * a dot in an election entry's file name):
 *
 *     <pid> <claimed ms> <base36 nonce> <procStart ms> <kernel start tick | ->
 *
 * The first three are the pre-2.0 token verbatim and in its order, and that is load-bearing: an
 * older process sharing this directory reads field 1 as the pid and field 2 as the claim time,
 * and must keep finding them there. Fields 4 and 5 are what let a reader tell this process from
 * a later one wearing its pid; a reader that does not know them ignores them.
 */
function newLockClaim(separator: string): string {
  const self = lockSelf();
  const nonce = Math.random().toString(36).slice(2) || '0';
  return [process.pid, Date.now(), nonce, self.procStart, self.kernelStart ?? '-'].join(separator);
}

/** A whole number of at most 16 digits, or 0. Field 2 and field 4 of a claim. */
function claimNumber(field: string | undefined): number {
  return field !== undefined && /^\d{1,16}$/.test(field) ? Number(field) : 0;
}

/**
 * Read a claim back from its fields, or undefined when field 1 is not a pid. STRICT about the
 * pid and lenient about everything after it: a pid that is not a plain positive 31-bit integer
 * makes the whole text "not a token" (`parseInt` would have read `12abc` as 12, and a number
 * past 2^31 makes `process.kill` throw a TypeError that no rule here could interpret), while a
 * missing or malformed later field only removes the evidence that field would have carried —
 * the two-field `<pid> <ms>` and three-field pre-2.0 shapes are real tokens and must stay so.
 */
function parseLockClaim(key: string, fields: string[]): LockClaim | undefined {
  const pidText = fields[0];
  if (pidText === undefined || !/^[1-9]\d{0,9}$/.test(pidText)) {
    return undefined;
  }
  const pid = Number(pidText);
  if (pid > 0x7fffffff) {
    return undefined;
  }
  const kernelStart = fields[4];
  return {
    key,
    pid,
    claimedAt: claimNumber(fields[1]),
    procStart: claimNumber(fields[3]) || undefined,
    kernelStart: kernelStart !== undefined && /^\d{1,20}$/.test(kernelStart) ? kernelStart : undefined,
  };
}

/**
 * Whether `pid` names NO process. Stricter than `!isPidAlive` in the one direction a proof
 * needs: ONLY `ESRCH` is "gone". `EPERM` is a process that exists — another user's, or one a
 * sandbox will not let this process signal, which is why it is not read as anything more — and
 * any other failure of the probe is ignorance, which is never a proof.
 */
function lockPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Linux only: the epoch ms at which the process with procfs start tick `tick` began, worked out
 * from THIS process's own two records of its own start — its tick and its `procStart` — and the
 * distance between the ticks. Undefined when this process could not read its own tick.
 *
 * Deliberately not `/proc/uptime`, which is what `ps` uses: inside an LXC container lxcfs
 * rewrites that file to the CONTAINER's uptime while start ticks stay relative to the HOST's
 * boot, so every start time derived from the pair lands late by however long the host had been
 * up — late being the direction that accuses a live holder. Two ticks subtract cleanly wherever
 * they are read. A tick is 10 ms: USER_HZ is 100 on every architecture Node runs on.
 *
 * The result runs LATE by the few milliseconds between this process's kernel start and its
 * `procStart`, which LOCK_HOLDER_START_SLACK_MS exists to absorb.
 */
function linuxStartedAt(tick: string): number | undefined {
  const self = lockSelf();
  if (self.kernelStart === undefined || self.procStart === 0) {
    return undefined;
  }
  try {
    const ms = self.procStart + Number((BigInt(tick) - BigInt(self.kernelStart)) * 10n);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One waiter's memory, for the life of ONE acquisition (withLockAt), of the claims it has seen
 * made by live pids: since when it has been watching each, and what `ps` said once it asked.
 *
 * The probe spawns a process and the wait loop asks every LOCK_SPIN_MS, so without a memo a full
 * wait would spawn hundreds. Keyed by the claim's exact text: the verdict is a statement about
 * "the process that stamped these bytes", which cannot change while the bytes do not, and the
 * next holder writes different bytes. Liveness itself is deliberately NOT memoized — it is
 * re-asked on every pass, so a holder that exits mid-wait is noticed on the next one.
 */
type LockProbeMemo = Map<string, { since: number; gone?: boolean }>;

/**
 * Whether a process that started at `startedAt` started AFTER `claim` was made, and so cannot
 * be the process that made it. A genuine claimant was already running when it stamped its claim;
 * a process that inherited the number started later, and after a reboot later than every lock
 * file that survived it.
 *
 * "After" is tested against BOTH records the claim holds — its stamp, and the claimant's own
 * `procStart` when it carries one — because the two fail in opposite directions when the wall
 * clock is stepped. Stepped BACK between a process's start and its claim, the stamp reads
 * earlier than the start time macOS reports for that same process (which is the kernel's
 * timestamp from before the step): the `procStart` test, taken on the old side of the step like
 * the kernel's, refuses that accusation. Stepped FORWARD, a procps start time (now minus elapsed)
 * reads later than `procStart`: the stamp test refuses that one unless the step fell inside the
 * claim's own short life.
 */
function startedAfterClaim(claim: LockClaim, startedAt: number): boolean {
  const after = (ms: number): boolean => startedAt > ms + LOCK_HOLDER_START_SLACK_MS;
  return after(claim.claimedAt) && (claim.procStart === undefined || after(claim.procStart));
}

/**
 * Whether the process that made `claim` is PROVEN gone. This is the only thing that can make a
 * lock breakable, so every rung is a proof and everything short of one answers false.
 *
 *   1. The pid does not exist (`ESRCH`). The process that wrote the claim is gone.
 *   2. Linux, from procfs, at once and with no subprocess: the process wearing the pid now is a
 *      zombie; or the claim carries its claimant's start tick and this process has a DIFFERENT
 *      one (exact and clock-free — and when the ticks MATCH it is the same process, and the
 *      answer is "not gone", full stop); or, for a claim without a tick, it started after the
 *      claim was made (startedAfterClaim, on linuxStartedAt).
 *   3. Elsewhere, asked of `ps` — at most once per claim, and only once the claim has been
 *      watched for LOCK_PROBE_AFTER_MS or is older than LOCK_STALE_MS, so never on the hot path:
 *      the pid is a zombie, or its process started after the claim was made.
 *
 * WHAT IS DELIBERATELY NOT A PROOF:
 *   - AGE. A holder frozen in a debugger for an hour is alive and its lock is old.
 *   - No evidence. `ps` missing, failing, timing out, or answering in an unknown shape leaves
 *     the claimant "not proven gone" for the rest of this acquisition.
 *   - A pid that belongs to another user. It is tempting — a lock file this user owns cannot
 *     have been written by root's process — but a file's owner is whatever the filesystem
 *     reports (squashed and id-mapped mounts report one uid for everything), and `EPERM` is
 *     also what a sandboxed process gets for a neighbour it may not signal.
 *   - A live process that was ALREADY RUNNING when the claim was stamped. Nothing distinguishes
 *     a lock it really holds from a file somebody wrote by hand naming it — pid 1 included — so
 *     both are held, and a waiter times out with an error that names the pid and the file.
 *
 * ASSUMES one pid namespace: every process that takes these locks can see every other one's
 * pid. A holder on another host (a home directory on NFS) or in another container sharing this
 * directory reads as a dead or unrelated pid. That was equally true of every earlier version.
 * AND, for the start-time rungs only, a wall clock that has not been stepped back by more than
 * the slack between two of the readings compared (see startedAfterClaim for which steps are
 * covered); the tick comparison assumes nothing.
 *
 * win32 has neither rung 2 nor rung 3. See LOCK_STALE_MS for what it does instead.
 */
function lockClaimantGone(claim: LockClaim, memo: LockProbeMemo): boolean {
  if (lockPidGone(claim.pid)) {
    return true;
  }
  const current = linuxProcessStat(claim.pid);
  if (current !== undefined) {
    if (current.zombie) {
      return true;
    }
    if (claim.kernelStart !== undefined) {
      return current.start !== claim.kernelStart;
    }
    const startedAt = linuxStartedAt(current.start);
    if (startedAt !== undefined) {
      return startedAfterClaim(claim, startedAt);
    }
  }
  const now = Date.now();
  let seen = memo.get(claim.key);
  if (seen === undefined) {
    if (memo.size >= 64) {
      // Under heavy contention the token changes with every handover; only the claims still
      // being watched matter, and forgetting one merely restarts its LOCK_PROBE_AFTER_MS.
      memo.clear();
    }
    seen = { since: now };
    memo.set(claim.key, seen);
  }
  if (seen.gone !== undefined) {
    return seen.gone;
  }
  if (now - claim.claimedAt <= LOCK_STALE_MS && now - seen.since < LOCK_PROBE_AFTER_MS) {
    return false;
  }
  const probe = probeProcess(claim.pid);
  if (probe === undefined) {
    if (process.platform === 'win32') {
      // Not memoized: the age moves, and LockGuard.touch moves it back.
      return now - claim.claimedAt > LOCK_STALE_MS;
    }
    seen.gone = false;
    return false;
  }
  seen.gone =
    probe.zombie || (probe.startedAt !== undefined && startedAfterClaim(claim, probe.startedAt));
  return seen.gone;
}

/**
 * What is at a lock path right now.
 *   - `absent`    — nothing. The caller goes back to the exclusive create.
 *   - `held`      — something that may be a live holder's lock, or that could not be inspected.
 *                   The caller waits. `pid` is the holder's, when the lock names one.
 *   - `abandoned` — something NOBODY holds: a claim whose claimant is proven gone, or a thing
 *                   that is not a lock at all. Only this may be removed, and only by
 *                   clearAbandonedLock.
 */
type LockVerdict = { state: 'absent' } | { state: 'held'; pid?: number } | { state: 'abandoned' };

/**
 * One look at a lock path: what kind of thing is there and, for the two kinds a lock can be,
 * the text it carries.
 *   - `absent`  — nothing.
 *   - `unknown` — something that could not be inspected, or that changed while being looked at.
 *   - `other`   — a FIFO, a directory, a socket, a device.
 *   - `link`    — a symbolic link; `text` is its target.
 *   - `file`    — a regular file; `text` is its content, or undefined when the bytes were
 *                 refused for a reason that proves they are not a token (see sightLock).
 * `mtimeMs` is taken AFTER the text, so it can only belong to the thing whose text this is or to
 * something that replaced it since — and a replacement is younger, which is the direction that
 * keeps a lock.
 */
type LockSighting =
  | { kind: 'absent' }
  | { kind: 'unknown' }
  | { kind: 'other' }
  | { kind: 'link' | 'file'; text: string | undefined; mtimeMs: number };

/**
 * Look at a lock path. Never throws, never blocks.
 *
 * `lstat` FIRST, and the three things it can find are three different cases:
 *
 *   A SYMBOLIC LINK is what a lock IS (publishLock): the token is the link's target text, read
 *   with `readlink`, which never follows the link, never blocks and cannot return more than a
 *   path's worth of bytes.
 *
 *   A REGULAR FILE is a lock made the old way, create-then-stamp: by a pre-2.0 process, or by
 *   this module where symbolic links are unavailable. THE READ IS GUARDED, not `readFileSync` —
 *   this path is a NAME AN UNTRUSTED PROCESS CAN OCCUPY (a dispatched worker has a shell,
 *   TASKS_DIR is writable to it, and `<id>.reconcile.lock` is derived from an id it knows).
 *   readTextSafe opens O_RDONLY|O_NONBLOCK, fstats that same fd and refuses anything that is not
 *   a regular file within the cap, so a FIFO swapped in after the lstat still cannot block this
 *   and an oversized file still cannot be read into memory.
 *     - too large, or unreadable BY ITS MODE -> a file with no token in it (`text` undefined).
 *       Nothing that takes these locks writes one that big, or creates one without the owner's
 *       read bit; and a `chmod 000` squatter must not be a permanent wall.
 *     - unreadable for any other reason (EMFILE, EIO, …) -> `unknown`. That is ignorance about a
 *       file that may be a live lock, and the old rule that aged it out broke a slow holder's
 *       lock whenever this process ran out of file descriptors.
 *
 *   ANYTHING ELSE — a FIFO, a directory, a socket, a device — is `other`.
 */
function sightLock(lockPath: string): LockSighting {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(lockPath);
  } catch (err) {
    return { kind: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
  }
  let kind: 'link' | 'file';
  let text: string | undefined;
  if (st.isSymbolicLink()) {
    kind = 'link';
    try {
      text = fs.readlinkSync(lockPath);
    } catch (err) {
      // ENOENT: released between the two calls. Anything else: the name changed hands.
      return { kind: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
    }
  } else if (st.isFile()) {
    kind = 'file';
    const read = readTextSafe(lockPath, LOCK_TOKEN_MAX_BYTES);
    if (read.ok) {
      text = read.text;
    } else if (read.reason === 'absent') {
      return { kind: 'absent' };
    } else if (
      read.reason !== 'too-large' &&
      !(read.reason === 'unreadable' && (st.mode & 0o400) === 0)
    ) {
      // `not-a-file` here means the name changed hands between the two calls.
      return { kind: 'unknown' };
    }
  } else {
    return { kind: 'other' };
  }
  let after: fs.Stats;
  try {
    after = fs.lstatSync(lockPath);
  } catch (err) {
    return { kind: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
  }
  if ((kind === 'link') !== after.isSymbolicLink() || (kind === 'file') !== after.isFile()) {
    return { kind: 'unknown' };
  }
  return { kind, text, mtimeMs: after.mtimeMs };
}

/**
 * The verdict one sighting supports, taken on its own.
 *
 *   - A link or file carrying a CLAIM is judged by its claimant and by nothing else
 *     (lockClaimantGone).
 *   - A LINK whose text is not a claim — a path to a decoy file, to /dev/zero, to nowhere — is
 *     not a lock: `symlink` creates the link with its text in one step, so there is no moment at
 *     which a real lock reads as anything but its token, and therefore no grace to give.
 *   - A FILE with no claim in it is abandoned once it has sat there for
 *     LOCK_UNSTAMPED_GRACE_MS and held until then (see that constant for who the grace is for).
 *     The age is a DISTANCE from now, so an mtime planted in the far future does not make an
 *     immortal lock.
 *   - Anything else that exists is not a lock anybody holds, and nothing that takes these locks
 *     ever creates one: abandoned, with no grace.
 */
function judgeSighting(seen: LockSighting, memo: LockProbeMemo): LockVerdict {
  if (seen.kind === 'absent') {
    return { state: 'absent' };
  }
  if (seen.kind === 'unknown') {
    return { state: 'held' };
  }
  if (seen.kind === 'other') {
    return { state: 'abandoned' };
  }
  const claim =
    seen.text === undefined ? undefined : parseLockClaim(seen.text, seen.text.trim().split(/\s+/));
  if (claim === undefined) {
    return seen.kind === 'link' || Math.abs(Date.now() - seen.mtimeMs) > LOCK_UNSTAMPED_GRACE_MS
      ? { state: 'abandoned' }
      : { state: 'held' };
  }
  // WHEN the lock was claimed, taken as the LATER of the two records of it: the holder's own
  // stamp and the lock's mtime, which the holder refreshes while it works (LockGuard.touch).
  // Later is the conservative direction for both things the time is used for.
  claim.claimedAt = Math.max(claim.claimedAt, seen.mtimeMs);
  return lockClaimantGone(claim, memo) ? { state: 'abandoned' } : { state: 'held', pid: claim.pid };
}

/**
 * Judge the lock at `lockPath`. Never throws, never blocks, and NEVER calls a lock abandoned
 * because it could not be seen: every failure to inspect answers `held`, and a path that turns
 * out to hold nothing answers `absent`.
 *
 * THE VANISHED LOCK IS `absent`, AT EVERY STEP, and that sentence is one of the fixes this
 * function carries. Its predecessor read the token, then stat'ed the path, and took a stat that
 * found nothing to mean "not a regular file, so stale" — reasoning that the break which followed
 * would fail harmlessly on a missing file. It does not fail when another waiter has re-created
 * the lock in between: the break then removed that waiter's LIVE lock, with ordinary contention
 * and no crashed process anywhere (measured: 3 runs in 30 lost increments that way).
 *
 * `abandoned` IS ONLY EVER ANSWERED ABOUT A LOCK SEEN TWICE — once before the proof and once
 * after it — and the second look is the other fix, found the hard way. "The claimant of the
 * token I read is dead" does not mean "that token is still at the path": a holder can finish,
 * RELEASE, and EXIT in the gap between a waiter reading its token and asking whether its pid is
 * alive. The pid is then truly gone, the proof is sound — and the name already holds the NEXT
 * holder's live lock, which a removal by name would take. That gap is microseconds wide when the
 * machine is idle and whole scheduler slices wide when it is not (measured: 2 runs in 200 at a
 * load average over 200, 24 writers, every one of them exiting right after its last write). So
 * the order is PROVE, THEN LOOK AGAIN: only if the path still shows the very same text after the
 * claimant was proven gone is the lock abandoned. That closes it, because a dead claimant
 * cannot release, and every claim carries fresh randomness, so the same text cannot be a
 * different lock. The second sighting is judged in full as well, which is what makes an
 * unstamped file old on BOTH looks rather than old once and replaced since.
 *
 * What this function establishes is true at the moment of its second look. It stays true until
 * the removal only for a caller that is the one elected breaker — see clearAbandonedLock.
 */
function judgeLock(lockPath: string, memo: LockProbeMemo): LockVerdict {
  const seen = sightLock(lockPath);
  const verdict = judgeSighting(seen, memo);
  if (verdict.state !== 'abandoned') {
    return verdict;
  }
  const again = sightLock(lockPath);
  const textOf = (s: LockSighting): string | undefined =>
    s.kind === 'link' || s.kind === 'file' ? s.text : undefined;
  if (again.kind !== seen.kind || textOf(again) !== textOf(seen)) {
    // Something else is there now (or nothing). Whatever it is, it has not been judged.
    return again.kind === 'absent' ? { state: 'absent' } : { state: 'held' };
  }
  return judgeSighting(again, memo);
}

/**
 * The token at a lock path — the target text of the symbolic link there, or the bytes of the
 * regular file there — or undefined when there is none to read. Never throws, never blocks.
 *
 * This is the function that decides OWNERSHIP: withLockAt compares its answer with the token
 * it published before it enters the section, LockGuard.stillOurs does immediately before every
 * not-undoable append, and the release does before it unlinks. Undefined never equals a token,
 * so every failure here makes the caller decline — to enter, to write, to unlink — which is the
 * safe direction at all three.
 *
 * For a symbolic link the read is a `readlink`: no file descriptor (so it still answers when
 * the process has none left, which matters to a holder that must be able to release), no
 * following, nothing to block on. Only when the path is not a link at all is the guarded file
 * read used, for the same reason as in sightLock — a blocking read here would stall a holder
 * INSIDE its critical section, with the lock still held by a live pid.
 */
function readLockToken(lockPath: string): string | undefined {
  try {
    return fs.readlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    // EINVAL and its platform spellings: something is there and it is not a link.
  }
  const read = readTextSafe(lockPath, LOCK_TOKEN_MAX_BYTES);
  return read.ok ? read.text : undefined;
}

/** Write all of `text` to `fd`, looping on short writes. Whether every byte landed. May throw. */
function writeLockBytes(fd: number, text: string): boolean {
  const buf = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buf.length) {
    const n = fs.writeSync(fd, buf, written, buf.length - written);
    if (n <= 0) {
      return false;
    }
    written += n;
  }
  return true;
}

/** Remove whatever sits at a name this module owns: a file, a FIFO, a link — or an empty directory. */
function removeLockLitter(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    try {
      fs.rmdirSync(file);
    } catch {
      // nothing there, or something this process cannot remove — the caller copes either way
    }
  }
}

/**
 * Take the lock name if it is free. Returns whether `lockPath` now carries OUR token. THROWS
 * exactly what the exclusive create it replaces threw — any failure of that create other than
 * "the name is taken" (a missing directory, EACCES, EROFS).
 *
 * THE LOCK IS A SYMBOLIC LINK WHOSE TARGET TEXT IS THE TOKEN, and the reason is that `symlink`
 * is the one call that is exclusive AND publishes its content in the same step: it fails with
 * EEXIST when anything is at the name, exactly as the exclusive file create did, and when it
 * succeeds the name appears with every byte of the token already readable. The link points
 * nowhere and is never followed; it is a 60-byte string stored under a name.
 *
 * That removes a state the old create-then-stamp had and every reader had to guess about: a
 * lock that exists and is EMPTY, which is what a waiter saw if it looked between the two calls
 * — and what a creator killed between them left behind for good. A lock this function published
 * is never seen with half a token, so "no token" can only mean "not one of ours". It is also
 * still one create and one unlink per uncontended acquisition, with no temp file to leave
 * behind and no file descriptor needed to read the lock back.
 *
 * A PRE-2.0 PROCESS sharing the directory still excludes on it: its own exclusive create fails
 * on a symbolic link as on a file. It cannot READ it — it follows the link, finds nothing, and
 * takes that for "not stale" — so it waits its own 15 s and then breaks by deadline, whoever
 * holds the lock. See clearAbandonedLock for what that means.
 *
 * THE FALLBACK is the old create-then-stamp of a regular file, for where a symbolic link cannot
 * be made: win32 (creating one needs a privilege most accounts lack, so it is not attempted)
 * and filesystems without them (FAT, exFAT). It is also what keeps the errors identical to
 * before: whatever stopped the `symlink` — a missing directory, a read-only mount — stops this
 * create too, and THIS is the call whose error the caller sees. On that path the empty-file
 * window is back, and LOCK_UNSTAMPED_GRACE_MS is what keeps a waiter from clearing a lock
 * inside it. A stamp that fails there (ENOSPC) now removes the file and throws, where it used to
 * leave an empty lock and retry forever.
 *
 * The result is read back rather than inferred from the call's return, on both paths: success
 * is worth nothing if the bytes at the name are not ours a moment later.
 */
function publishLock(lockPath: string, token: string): boolean {
  const symlinks = process.platform !== 'win32';
  if (symlinks) {
    try {
      fs.symlinkSync(token, lockPath);
      return readLockToken(lockPath) === token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      // No symbolic links here, or the directory itself is unusable: the create below decides.
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
  let stamped = false;
  let failure: unknown;
  try {
    stamped = writeLockBytes(fd, token);
    if (!stamped) {
      failure = new Error(`Could not write the lock file ${lockPath}. Nothing was changed.`);
    }
  } catch (err) {
    failure = err;
  }
  if (!stamped) {
    // Our own file, created a moment ago and never stamped. Left behind it would be an
    // unstamped squatter for every other process to wait out — but it is removed only while the
    // name still leads to the inode behind OUR open descriptor, which cannot be anybody else's
    // file for as long as the descriptor is open.
    try {
      const ours = fs.fstatSync(fd, { bigint: true });
      const there = fs.lstatSync(lockPath, { bigint: true });
      if (there.dev === ours.dev && there.ino === ours.ino) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // already gone, or not ours to remove
    }
  }
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
  if (!stamped) {
    throw failure;
  }
  return readLockToken(lockPath) === token;
}

/**
 * Free a lock name that holds something nobody holds. Called ONLY by the elected breaker,
 * immediately after it has judged the path itself. `unlink` covers a file, a FIFO, a socket, a
 * device and a symbolic link (the link, never its target); a directory needs `rmdir`; and a
 * directory with something in it can only be moved aside, which leaves it as litter under a
 * `.break.` name but frees the lock — the alternative is a planted directory that fails every
 * write for good.
 */
function removeAbandonedLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
  }
  try {
    fs.rmdirSync(lockPath);
    return;
  } catch {
    // not an empty directory
  }
  try {
    fs.renameSync(lockPath, `${lockPath}.break.${process.pid}.${Date.now()}`);
  } catch {
    // The name stays occupied and the waiter times out, loudly, which is the honest outcome.
  }
}

/** Shape of a breaker-election entry's file name: a claim (newLockClaim) joined by dots. */
const LOCK_ELECTION_ENTRY = /^[1-9]\d{0,9}\.\d{1,16}\.[0-9a-z]{1,24}\.\d{1,16}\.(?:\d{1,20}|-)$/;

/**
 * Put this process's entry into the election directory, creating the directory if need be.
 * Whether the entry now exists. Never throws.
 *
 * A thing at the directory's name that is NOT a directory is removed and replaced. `unlink`
 * cannot remove a directory, so that removal can never discard an election in progress, whatever
 * races it. `lstat`, so a symbolic link planted there is removed as the link it is rather than
 * followed into somebody else's directory. The loop is for the one benign race: a breaker that
 * finishes removes the directory if it is empty, and may do so between this function's mkdir
 * and its create.
 */
function enterBreakerElection(dir: string, entry: string): boolean {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      try {
        if (!fs.lstatSync(dir).isDirectory()) {
          fs.unlinkSync(dir);
          continue;
        }
      } catch {
        continue; // it vanished between the two calls — make it again
      }
    }
    try {
      fs.closeSync(fs.openSync(entry, 'wx'));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return false;
      }
    }
  }
  return false;
}

/**
 * Whether this process is the ONLY live breaker in the election directory, having already put
 * its own entry there. Dead breakers' entries, and anything that is not an entry, are removed on
 * the way — AFTER the listing is complete, never during it, because removing names from a
 * directory while it is being read is how a listing comes to skip a name that was there all
 * along, and a skipped rival is a second breaker.
 *
 * A name that is not shaped like an entry is not a contender (every contender writes its own,
 * well-formed) and is ignored for the decision. An entry carrying THIS pid that is not the
 * current one is this process's own leftover from an earlier attempt whose cleanup failed: the
 * lock is taken synchronously on one thread, so it cannot be in use.
 */
function soleBreaker(dir: string, mine: string, memo: LockProbeMemo): boolean {
  const names: string[] = [];
  let overflow = false;
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) {
        break;
      }
      if (names.length >= LOCK_ELECTION_MAX_ENTRIES) {
        overflow = true;
        break;
      }
      names.push(entry.name);
    }
  } catch {
    return false;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // already closed
    }
  }
  // Our own entry must be in what we read. If it is not, this is not the directory we entered.
  let sole = !overflow && names.includes(mine);
  for (const name of names) {
    if (name === mine) {
      continue;
    }
    const file = path.join(dir, name);
    const claim = LOCK_ELECTION_ENTRY.test(name) ? parseLockClaim(`breaker:${name}`, name.split('.')) : undefined;
    if (claim === undefined || claim.pid === process.pid) {
      removeLockLitter(file);
      continue;
    }
    if (lockClaimantGone(claim, memo)) {
      removeLockLitter(file);
    } else {
      sole = false;
    }
  }
  return sole;
}

/**
 * Clear the abandoned lock at `lockPath`, if this process can become the one breaker allowed to.
 * Returns true when the name is free afterwards as far as this call can tell (it removed the
 * lock, or found nothing there), false when it did nothing — a rival breaker is alive, or the
 * path no longer holds anything abandoned. Never throws. Either way the caller goes back round
 * its loop: clearing a lock confers no right to it.
 *
 * WHY THIS IS NOT A RENAME. The predecessor judged the path stale and then renamed whatever was
 * at the path aside. Those are two looks at a NAME, and the name can hold a different lock by
 * the second one: waiters A and B both judge the dead holder's lock; A breaks it and takes the
 * lock, or C does; B's rename then removes a LIVE lock, and a fourth process walks in beside its
 * holder. Renaming to a unique name makes the break atomic among breakers of the SAME file and
 * does nothing about a different file having arrived (measured: 10 of 30 runs lost increments,
 * every one of them with a live lock broken). There is no way back from it either — once a live
 * lock has been moved off its name the name is free, and linking it back is a race against
 * whoever takes it first.
 *
 * So nothing is removed until the remover is known to be the only one, and has looked again:
 *
 *   1. ELECTION. Each would-be breaker creates an entry with a unique name in
 *      `<lock>.breakers/`, then lists the directory. It proceeds only if every OTHER entry
 *      belongs to a breaker proven gone (the same proof as for a lock holder — the entry's name
 *      IS a claim); otherwise it withdraws its entry and returns false.
 *   2. RE-JUDGE. The elected breaker judges the lock path again, from nothing — which is itself
 *      two looks with the proof between them (judgeLock).
 *   3. REMOVE, if and only if that fresh verdict is `abandoned`.
 *   4. Withdraw the entry; remove the directory if that leaves it empty.
 *
 * WHY AT MOST ONE BREAKER IS EVER BETWEEN STEPS 2 AND 4. Take two, P and Q, and say P created
 * its entry first. Q lists after creating its own, so after P's entry existed. Either P's entry
 * is still there, and Q sees a live rival and withdraws; or it is gone, and then P has finished
 * step 4 — a breaker removes its own entry only on the way out, and nobody else may remove the
 * entry of a breaker that is alive. Nothing here is a lock that could itself go stale and need
 * breaking, which is what a "breaker lock file" would have been: an entry is never waited on,
 * only read, and a dead breaker's entry is removed by its unique name, which can never be the
 * name of anybody else's.
 *
 * WHY STEP 3 REMOVES WHAT STEP 2 JUDGED. A lock at the path can stop being there in exactly two
 * ways: its holder releases it, or a breaker removes it. Step 2 saw the lock at the path AFTER
 * its holder was proven gone (or saw, twice, a thing with no holder), so the first cannot happen
 * any more; this process is the only breaker, so the second cannot either; and nobody can put a
 * NEW lock there while the old one still occupies the name, because publishing is exclusive. The
 * name therefore holds the same thing at step 3 as at step 2.
 *
 * THE INTERLEAVINGS THIS WAS CHECKED AGAINST, each with the reason it is safe:
 *   - A and B judge one dead lock; A clears it and C takes the lock; B acts. B must first be
 *     elected, and then re-judges: the path holds C's live lock, the verdict is `held`, nothing
 *     is removed.
 *   - A and B enter the election together. Each lists after creating, so each sees the other;
 *     both withdraw and come back after different sleeps. Two withdrawals cost a few
 *     milliseconds; two removals cost an update.
 *   - The elected breaker is FROZEN (SIGSTOP, a debugger) between steps 2 and 3. Its entry stays
 *     and names a live process, so no other breaker is ever elected and the lock it judged stays
 *     exactly where it was; when it resumes it removes that same lock. Waiters time out
 *     meanwhile — they do not go round it.
 *   - The elected breaker is KILLED anywhere in 1–4. Its entry names a dead pid; the next
 *     breaker removes it and carries on. The lock is either still there, still abandoned, or
 *     already gone. Nothing is left that anyone waits on.
 *   - A breaker finishing step 4 removes the directory just as another is entering. `rmdir`
 *     only removes an EMPTY directory, so it cannot take a live entry with it; the newcomer's
 *     create fails ENOENT and it makes the directory again (enterBreakerElection).
 *   - The holder releases between a waiter's judgment and the waiter's election. Step 2 finds
 *     nothing (`absent`) or the next holder's lock (`held`).
 *   - The holder finishes, releases and EXITS between a breaker reading its token and asking
 *     whether its pid is alive, and somebody else takes the lock. The pid really is gone, so the
 *     first look says abandoned; the second look, taken after the proof, shows a different
 *     token, and nothing is removed (judgeLock). This one was not reasoned out in advance — a
 *     stress run at a load average over 200 found it.
 *   - The pid of a dead breaker, or of the dead holder, has been taken by an unrelated live
 *     process. lockClaimantGone's start-identity rungs see through it; where they cannot (no
 *     `ps`), the claim stays "not gone" and waiters time out rather than guess.
 *
 * ASSUMES, beyond lockClaimantGone's one-pid-namespace: that a directory listing returns every
 * name that was present for the whole of the listing (POSIX guarantees it; an election is a
 * handful of short names and is read in one or two system calls), and that every process
 * clearing locks here follows this protocol. A PRE-2.0 PROCESS DOES NOT — it breaks, with a
 * rename, any lock it has waited 15 s for, and does not look at the election — so while one is
 * running against the same directory it can still evict a slow holder of either version. That
 * is detected, not prevented: see the release check in withLockAt.
 */
function clearAbandonedLock(lockPath: string, memo: LockProbeMemo): boolean {
  const dir = `${lockPath}.breakers`;
  const mine = newLockClaim('.');
  const entry = path.join(dir, mine);
  try {
    // Inside the try, so an entry that was created and then failed to close is still withdrawn.
    if (!enterBreakerElection(dir, entry) || !soleBreaker(dir, mine, memo)) {
      return false;
    }
    const verdict = judgeLock(lockPath, memo);
    if (verdict.state !== 'abandoned') {
      return verdict.state === 'absent';
    }
    removeAbandonedLock(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    removeLockLitter(entry);
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty: another breaker has entered, and removes it in its turn
    }
  }
}

/**
 * What a critical section may ask about the lock it is running under. withLockAt hands one to
 * the function it runs. Nothing that follows this module's protocol removes a live holder's
 * lock any more, so for most sections these answer the obvious thing; they stay because the
 * protocol is not the only actor — a pre-2.0 process sharing the directory still breaks locks by
 * deadline, a person can delete a file, and win32 still ages locks out — and a holder about to
 * commit a write it cannot take back must be able to find out.
 */
interface LockGuard {
  /**
   * Whether the lock file still carries OUR token, i.e. nothing has removed and re-taken it while
   * we worked. False means we were evicted and a successor may be running this very section
   * right now; a holder about to make a not-undoable write (an append to an append-only log)
   * must abandon it and let the successor be the one that writes. Any read failure answers
   * false, the safe direction: the only cost of a false negative is that this pass declines to
   * write and a later pass redoes the work.
   */
  stillOurs(): boolean;
  /**
   * Restamp the lock's mtime for a holder that is legitimately still working. It keeps the lock
   * young for the one reader that still breaks by age: win32's fallback (LOCK_STALE_MS). It is
   * a mitigation there, not a guarantee — the section is synchronous, so nothing can refresh the
   * lock while a single step of it is blocked — and for a waiter on macOS or Linux it changes
   * nothing that matters: that waiter breaks a lock only when its holder is proven gone, however
   * old the lock is.
   * No-op unless the lock still carries our token: refreshing a successor's lock is not ours to
   * do.
   */
  touch(): void;
}

/**
 * The command name of the process `pid`, for the one sentence that tells a person which process
 * a lock belongs to — or '' when it cannot be learned. Asked ONLY while composing the timeout
 * error, never while waiting.
 *
 * It is another process's text, so it is treated as untrusted: only the last path segment is
 * kept (macOS reports the executable's full path, which says more about the machine than the
 * reader needs), it is flattened to one line of visible characters, and it is cut to 60 — the
 * error is printed to users and may be read by a model. Linux reads the name from the same
 * procfs file the identity check reads (between the first `(` and the last `)`); elsewhere it is
 * one `ps`; win32 has neither and answers ''.
 */
function lockHolderName(pid: number): string {
  let raw = '';
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      raw = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    } else if (process.platform !== 'win32') {
      raw = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
  } catch {
    return '';
  }
  const lastSegment = raw.trim().split('/').pop() ?? '';
  return sliceOneLine(flattenOneLine(lastSegment), 60);
}

/**
 * The error a waiter throws when it gives up. ONE LINE, and written for the person it is shown
 * to: what happened, that nothing was changed, what to do — and the lock's path LAST, so that a
 * caller which truncates the message loses the end of a path and not the instruction. Everything
 * before the path is about 330 characters plus two bounded names (the file's, 48; the holder's
 * command, 60); `targetFile` appears by its file name only, because the full path is the last
 * thing in the sentence anyway.
 *
 * The instruction is deliberately conditional. A waiter that timed out could not PROVE the
 * holder gone, and neither can this message: the process may be an orchestrator window in the
 * middle of a slow write, or frozen in a debugger. So it says when deleting the lock is safe —
 * once that process is confirmed idle or gone — rather than saying to delete it.
 *
 * Composed from this module's own paths, a parsed pid and lockHolderName's bounded, flattened
 * command name: no byte of the lock's own content rides out in it. Callers that match on it
 * match the prefix `Could not lock `.
 */
function lockWaitError(targetFile: string, lockPath: string, verdict: LockVerdict): Error {
  const seconds = Math.round(LOCK_ACQUIRE_TIMEOUT_MS / 1000);
  const what = sliceOneLine(flattenOneLine(path.basename(targetFile)), 48);
  let said: string;
  if (verdict.state === 'held' && verdict.pid !== undefined) {
    const name = lockHolderName(verdict.pid);
    const who = name === '' ? `process ${verdict.pid}` : `process ${verdict.pid} (${name})`;
    said =
      `${who} has held its lock for more than ${seconds}s. Nothing was changed. If it is busy, ` +
      `try again later. If it is idle, stuck, or not an orchestrator window, server or task, ` +
      `the lock is stale: deleting the lock file is safe once that process is confirmed idle ` +
      `or gone. The lock belongs to process ${verdict.pid} and is the file ${lockPath}`;
  } else if (verdict.state === 'held') {
    said =
      `its lock could not be inspected for more than ${seconds}s. Nothing was changed. Deleting ` +
      `the lock file is safe once no orchestrator window, server or task is running. The lock ` +
      `is the file ${lockPath}`;
  } else if (verdict.state === 'abandoned') {
    said =
      `its lock was left behind by a process that is gone and could not be cleared within ` +
      `${seconds}s. Nothing was changed. Deleting the lock file, and the folder beside it whose ` +
      `name ends in .breakers, is safe. The lock is the file ${lockPath}`;
  } else {
    said =
      `its lock stayed busy for more than ${seconds}s. Nothing was changed. Try again. The lock ` +
      `is the file ${lockPath}`;
  }
  return new Error(`Could not lock ${what}: ${said}`);
}

/**
 * Run `fn` while holding the advisory exclusive lock at `lockPath`, taken on behalf of
 * `targetFile` (the name errors speak of: the data file for withFileLock, which locks the sibling
 * `<targetFile>.lock`, or the lock path itself for withPathLock). It is what makes a concurrent
 * read-modify-write of registry.json / stats.json
 * across every editor window, every server and N detach supervisors never loses an update
 * (contract R4). NOT reentrant — `fn` must not call back into a helper that locks the SAME
 * file; it would wait for itself and time out. Reads never take the lock: tmp+rename makes
 * every write atomic, so a lock-free reader can only ever see a complete old or new file.
 *
 * THE GUARANTEE: at most one process is inside `fn` for a given file at a time, under any
 * interleaving of processes that follow this protocol. It rests on three rules, and each one
 * replaced a rule that lost updates.
 *
 *   1. ONLY THE HOLDER RELEASES. The lock is released by unlinking it, and only after reading it
 *      back as our own (readLockToken).
 *   2. ONLY A LOCK WHOSE HOLDER IS PROVEN GONE IS EVER REMOVED BY ANYONE ELSE — never one that
 *      is old, never one whose waiter has run out of patience (lockClaimantGone). A waiter that
 *      cannot prove it WAITS, and after LOCK_ACQUIRE_TIMEOUT_MS it THROWS. It used to break the
 *      lock and walk in, which is two processes in the section whenever a holder is merely
 *      slow.
 *   3. REMOVING AN ABANDONED LOCK IS ITSELF EXCLUSIVE AND RE-CHECKED (clearAbandonedLock), so
 *      the lock removed is the one judged and not whatever took its name since.
 *
 * PROGRESS: a holder that died never blocks anyone for longer than the proof takes — at once
 * for a pid that no longer exists, LOCK_PROBE_AFTER_MS for a pid that was recycled or is a
 * zombie. A holder that is alive blocks each waiter for LOCK_ACQUIRE_TIMEOUT_MS and no longer.
 *
 * WHAT A CALLER SEES. Three throws, all of which leave `fn` either not run or run to completion:
 *   - whatever the exclusive create throws for a reason other than "taken" — unchanged;
 *   - lockWaitError, when the lock stayed held, or stayed unclearable, for the whole wait. `fn`
 *     was not run. NEW: this used to be a forced entry, not an error;
 *   - the release check below, when `fn` returned and the lock was no longer ours.
 * And whatever `fn` throws, after the lock is released.
 *
 * THE RELEASE CHECK IS AN ASSERTION. Under rules 1–3 a holder's lock is still its own when it
 * finishes; if it is not, something outside the protocol removed it (see LockGuard) and another
 * process may have run this section at the same moment. Nothing can be undone at that point, so
 * the holder leaves whatever is at the path alone — it is somebody else's — and says so with a
 * throw rather than returning as though the section had been exclusive. An error from `fn`
 * itself is never replaced by this one.
 *
 * CRASH SAFETY. A process killed at any point leaves, at worst: its lock, whole (cleared as
 * abandoned by the next waiter), or its election entry (removed by the next breaker). Neither is
 * ever waited on by a rule that needs the dead process to act, and there is no temp file.
 *
 * WINDOWS. No `ps`, so no way to ask when a process started: a live pid whose lock has not been
 * restamped for LOCK_STALE_MS is treated as gone there — the pre-2.0 heuristic, and the one
 * place a live-but-frozen holder can still be evicted. The alternative was worse on a platform
 * that recycles pids as fast as win32 does: a lock left by a crash would stand for as long as
 * any process wore that number. Locks there are regular files made by create-then-stamp
 * (publishLock's fallback), so the unstamped window and its grace apply to every acquisition;
 * the mode test of judgeLock is silent, since win32 reports no owner read bit; and the FIFO
 * defence is safeFs's declared gap, not this function's.
 */
function withLockAt<T>(lockPath: string, targetFile: string, fn: (lock: LockGuard) => T): T {
  const token = newLockClaim(' ');
  const started = Date.now();
  const memo: LockProbeMemo = new Map();
  // Whether this pass tries the exclusive create before looking. A pass that follows a sleep
  // looks first, and creates only once the name has been seen free.
  let create = true;
  // Set once a pass has been allowed to carry on after the deadline. See below.
  let overtime = false;
  for (;;) {
    if (create && publishLock(lockPath, token)) {
      break;
    }
    // THE DEADLINE. Every path round this loop passes through these lines, so nothing below can
    // spin past it — not even something that re-plants an abandoned lock as fast as it is
    // cleared. A waiter whose time is up still gets ONE more create when this very pass frees
    // the name (`overtime`): throwing "could not lock" at a lock that has just come free would
    // be a failure for nothing.
    const expired = Date.now() - started > LOCK_ACQUIRE_TIMEOUT_MS;
    const verdict = judgeLock(lockPath, memo);
    if (expired && overtime) {
      throw lockWaitError(targetFile, lockPath, verdict);
    }
    if (
      (verdict.state === 'abandoned' && clearAbandonedLock(lockPath, memo)) ||
      // Released since the last look: straight to the create.
      (verdict.state === 'absent' && !create)
    ) {
      create = true;
      overtime = expired;
      continue;
    }
    if (expired) {
      throw lockWaitError(targetFile, lockPath, verdict);
    }
    // Held; or abandoned with a rival breaker at work; or released and re-taken between our
    // create and our look. Parked, never busy — with a random share of the interval when the
    // wait is on other waiters rather than on a holder, so two breakers that withdrew for each
    // other do not come back together.
    sleepSync(
      verdict.state === 'held' ? LOCK_SPIN_MS : 1 + Math.floor(Math.random() * LOCK_SPIN_MS),
    );
    create = verdict.state === 'absent';
  }
  // Handed to the section so it can prove it still owns the lock before it writes, and keep its
  // lock file young while it works. See LockGuard.
  const guard: LockGuard = {
    stillOurs: () => readLockToken(lockPath) === token,
    touch: () => {
      try {
        if (readLockToken(lockPath) === token) {
          // `lutimes`: the lock is a link that points nowhere, and it is the LINK being stamped.
          const stamp = new Date();
          fs.lutimesSync(lockPath, stamp, stamp);
        }
      } catch {
        // best-effort: see LockGuard.touch for who still reads the age
      }
    },
  };
  const release = (): boolean => {
    if (readLockToken(lockPath) !== token) {
      return false;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already removed — nothing to do
    }
    return true;
  };
  let result: T;
  try {
    result = fn(guard);
  } catch (err) {
    release();
    throw err;
  }
  if (!release()) {
    throw new Error(
      `The lock on ${targetFile} was removed by another process while this one held it. ` +
        'What this process wrote stands, but a write made by that process at the same moment ' +
        'may have been lost.',
    );
  }
  return result;
}

/**
 * withLockAt for a data file: the lock is the sibling `<targetFile>.lock`. This is the form every
 * read-modify-write in this module uses.
 */
function withFileLock<T>(targetFile: string, fn: (lock: LockGuard) => T): T {
  return withLockAt(`${targetFile}.lock`, targetFile, fn);
}

/**
 * Run `fn` while holding the advisory exclusive lock AT `lockPath` — the same lock as
 * withFileLock, with the same guarantee, the same three throws and the same
 * LOCK_ACQUIRE_TIMEOUT_MS wait (see withLockAt), for a caller that owns its lock's NAME rather
 * than deriving it from a data file: the mesh ledger's `<state>.write.lock`, an account's
 * `.cco.lock`. Everything else the lock creates is derived from that name as it is for
 * withFileLock — the breaker election lives in `<lockPath>.breakers/` — so the directory holding
 * `lockPath` must exist and be writable, and `lockPath` must not be a name anything else uses:
 * a thing found there that is not a lock is removed.
 *
 * NOT reentrant, and synchronous: `fn` must not lock the same path again, and should be short —
 * every other process wanting this lock is parked while it runs.
 */
export function withPathLock<T>(lockPath: string, fn: () => T): T {
  return withLockAt(lockPath, lockPath, () => fn());
}

/**
 * The error a write throws when the state file it would replace could not be read or understood.
 * A class of its own so that isStateWriteRefusal recognises the error by what it IS; nothing
 * outside this module constructs or names it.
 */
class StateFileUnreadableError extends Error {}

/**
 * The refusal for `file`, whose read reported `problem`. One sentence for the person at the
 * keyboard: what could not be read and why, that nothing was changed, and what to do. `problem`
 * is a StateFileRead problem, so no byte of the file is in it.
 */
function stateFileUnreadable(file: string, problem: string): Error {
  return new StateFileUnreadableError(
    `Could not read ${file}: ${problem} — nothing was changed. Fix the file or delete it.`,
  );
}

/**
 * Whether `err` is this module REFUSING to write a state file — as opposed to a write that was
 * attempted and failed. Two refusals exist, and both leave every file exactly as it was: the
 * lock could not be taken (lockWaitError, `Could not lock …`), and the file on disk could not be
 * read or understood, so writing would have replaced something this version cannot account for
 * (`Could not read …`). Their messages are complete sentences written for the person at the
 * keyboard — what happened, that nothing was changed, what to do — so a caller that learns it
 * holds one can show the message as it stands.
 *
 * Callers ask this rather than matching text. Never throws.
 */
export function isStateWriteRefusal(err: unknown): boolean {
  if (err instanceof StateFileUnreadableError) {
    return true;
  }
  try {
    return (
      err instanceof Error &&
      typeof err.message === 'string' &&
      err.message.startsWith('Could not lock ')
    );
  } catch {
    return false;
  }
}

/**
 * The text of registry.json for `registry` — the ONE spelling of the file, for every writer.
 *
 * Every top-level key of the object is stored as it is, in the object's own order, except the
 * three that describe worker entries:
 *
 *   - `workers`        the usable Claude Code workers, in `registry.workers` order; then the
 *                      unsupported entries written here that have a name; then the ones that
 *                      have none — each its `raw`, untouched;
 *   - `vendorWorkers`  directly after it: the other usable workers, then the unsupported entries
 *                      written here, named before nameless. Omitted when that is nothing, so a
 *                      registry of Claude Code accounts is the file it was before 2.0.
 *   - `unsupportedWorkers` is a key of the object and never of the file.
 *
 * WHICH ARRAY an unsupported entry is written under is its `source` — and, whatever its
 * `source` says, `vendorWorkers` when its `raw` names a provider other than Claude Code
 * (workerArrayFor). The reader already sets `source` by that rule; the writer applies it again
 * because it is a property every file this version produces must have, not one a caller's
 * object should be able to waive: a pre-2.0 editor runs `claude` against each element of
 * `workers`.
 *
 * ABSENCE NEVER DELETES. The unsupported entries written are the object's own when it has an
 * ARRAY at `unsupportedWorkers`; an object without one — built by hand, or by code that predates
 * the key — says nothing about them, and `inFile` (the entries the file holds right now, read
 * under the lock by the caller) is written back instead. Only an explicit array with an entry
 * removed removes an entry.
 *
 * THROWS, before anything is written, for an object that is not a registry by value: `workers`
 * that is not an array, a worker whose provider is unknown (workerProvider), an unsupported
 * entry without a `raw` or without its source. Writing around such a value would be a guess
 * about which array an account belongs in.
 */
function registryFileText(registry: Registry, inFile: readonly UnsupportedWorkerEntry[]): string {
  const usable: unknown = registry.workers;
  if (!Array.isArray(usable)) {
    throw new TypeError('registry.workers is not an array — nothing was written');
  }
  const handed: unknown = registry.unsupportedWorkers;
  const unsupported: readonly unknown[] = Array.isArray(handed) ? handed : inFile;
  const claude: unknown[] = [];
  const vendor: unknown[] = [];
  for (const worker of usable as WorkerProfile[]) {
    const provider = workerProvider(worker);
    if (provider === 'claude') {
      // No `provider` key on a Claude Code entry, whatever the profile was built with.
      claude.push({ ...worker, provider: undefined });
    } else {
      vendor.push({ ...worker, provider });
    }
  }
  // Named entries before nameless ones, in each array — the order the reader returns them in,
  // kept here too so that an array a caller re-ordered still writes a file that reads back the
  // same.
  const nameless: Record<WorkerSource, unknown[]> = { workers: [], vendorWorkers: [] };
  for (const entry of unsupported) {
    const candidate = isJsonObject(entry) ? (entry as Partial<UnsupportedWorkerEntry>) : undefined;
    const source = candidate?.source;
    // `raw` may be any JSON value, `null` included; `undefined` is not one, and is what a
    // hand-built entry without the field has.
    if (
      candidate === undefined ||
      candidate.raw === undefined ||
      (source !== 'workers' && source !== 'vendorWorkers')
    ) {
      throw new TypeError(
        'registry.unsupportedWorkers holds a malformed entry — nothing was written',
      );
    }
    const array = workerArrayFor(source, candidate.raw);
    if (typeof candidate.name === 'string' && candidate.name !== '') {
      (array === 'workers' ? claude : vendor).push(candidate.raw);
    } else {
      nameless[array].push(candidate.raw);
    }
  }
  claude.push(...nameless.workers);
  vendor.push(...nameless.vendorWorkers);
  // Collected as entries and built with fromEntries, which DEFINES each key: assigning
  // `stored[key] = …` would run Object.prototype's `__proto__` setter for a key of that name —
  // one a file can hold — and store nothing.
  const stored: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(registry)) {
    if (key === 'vendorWorkers' || key === 'unsupportedWorkers') {
      continue;
    }
    if (key !== 'workers') {
      stored.push([key, value]);
      continue;
    }
    stored.push(['workers', claude]);
    if (vendor.length > 0) {
      stored.push(['vendorWorkers', vendor]);
    }
  }
  return JSON.stringify(Object.fromEntries(stored), null, 2);
}

/**
 * The registry as it is on disk, for a caller ABOUT TO WRITE IT — which is the only time the
 * difference between "empty" and "could not be read" costs anything. Throws the refusal
 * (stateFileUnreadable) when the file is there and could not be read or understood: every write
 * of this file REPLACES it, so writing then would trade whatever it holds — the worker accounts,
 * the billing guards, another version's keys — for this process's idea of an empty registry.
 *
 * Call it INSIDE the registry lock, and write from what it returned: the check and the write
 * are then about one generation of the file, with no window in which another writer following
 * the lock protocol could have put a different one there.
 */
function registryForRewrite(): Registry {
  const { registry, problem } = readRegistryChecked();
  if (problem !== null) {
    throw stateFileUnreadable(REGISTRY_FILE, problem);
  }
  return registry;
}

/**
 * Replace registry.json with `registry`, under the advisory lock.
 *
 * REFUSES — throws, and writes nothing — when the file on disk could not be read or understood
 * (registryForRewrite; isStateWriteRefusal recognises the error). The unsupported entries the
 * file holds are kept unless `registry` carries its own array of them (registryFileText).
 *
 * This writes the object it is handed over whatever the file holds, so a caller that read the
 * registry earlier and mutated its copy overwrites any change made in between. updateRegistry
 * is the form that cannot.
 */
export function writeRegistry(registry: Registry): void {
  ensureDirs();
  withFileLock(REGISTRY_FILE, () => {
    const onDisk = registryForRewrite();
    atomicWrite(REGISTRY_FILE, registryFileText(registry, onDisk.unsupportedWorkers));
  });
}

/**
 * Read-modify-write registry.json under the advisory lock (contract R4): the whole
 * read → mutate → atomic write runs while the lock is held, so a concurrent updater
 * can neither interleave nor lose an edit. `mutate` receives the freshly re-read
 * registry (defaults applied) and mutates it in place.
 *
 * REFUSES — throws before `mutate` runs, and writes nothing — when the file on disk could not be
 * read or understood (registryForRewrite; isStateWriteRefusal recognises the error): `mutate`
 * would be handed an empty registry that is not what the file holds, and the write would
 * replace the file with it.
 */
export function updateRegistry(mutate: (registry: Registry) => void): void {
  ensureDirs();
  withFileLock(REGISTRY_FILE, () => {
    const registry = registryForRewrite();
    // Kept apart from the object `mutate` is about to be handed: if it comes back without an
    // array at `unsupportedWorkers`, these are the entries that are written.
    const inFile = [...registry.unsupportedWorkers];
    mutate(registry);
    atomicWrite(REGISTRY_FILE, registryFileText(registry, inFile));
  });
}

/**
 * Store worker `name`'s default model and whether it is pinned, together, in one
 * read-modify-write of registry.json under its lock (updateRegistry, and its refusals). Returns
 * whether a worker of that name on `provider` was found and written; false — nothing written —
 * when there is none, including a name that now belongs to a worker on another CLI.
 *
 * `model` is judged FOR `provider` before the lock is asked for, and THROWS when it is not a
 * model there (the message is literals; the value is not echoed):
 *   - Claude Code: platform.normalizeModel, exactly when `pinned` (a v1.x tier id is then kept as
 *     the id it is, otherwise it is stored as its tier's alias). `modelPinned: true` is stored
 *     only for a pinned FULL id: an alias already means "the newest of that tier", so an alias
 *     is stored unpinned whatever `pinned` says, and the key is removed;
 *   - another provider: `''` is "no default — the CLI chooses", anything else must be an id that
 *     provider's rule accepts (providers.normalizeProviderModel). Its ids have no tiers, so the
 *     entry carries no `modelPinned`.
 */
export function setWorkerModel(
  name: string,
  provider: ProviderId,
  model: string,
  pinned: boolean,
): boolean {
  let stored: string;
  let pin = false;
  if (provider === 'claude') {
    const normalized = normalizeModel(model, { exact: pinned === true });
    if (normalized === undefined) {
      throw new Error('setWorkerModel: not a Claude Code model — an alias or a full model id');
    }
    stored = normalized;
    pin = pinned === true && !(WORKER_MODELS as readonly string[]).includes(normalized);
  } else if (model === '') {
    stored = '';
  } else {
    const normalized = normalizeProviderModel(provider, model);
    if (normalized === undefined) {
      throw new Error(`setWorkerModel: not a model id the ${providerInfo(provider).label} rule accepts`);
    }
    stored = normalized;
  }
  let found = false;
  updateRegistry((registry) => {
    const worker = registry.workers.find((w) => w.name === name);
    if (worker === undefined || workerProvider(worker) !== provider) {
      return;
    }
    worker.model = stored;
    if (pin) {
      worker.modelPinned = true;
    } else {
      delete worker.modelPinned;
    }
    found = true;
  });
  return found;
}

/**
 * Standard install locations for a bare command name, in probe order. Order is
 * preference, not likelihood: a user-level npm prefix or native install beats a
 * package manager's shared bin, which beats a version manager's per-version bin.
 * Callers must already have proved `command` matches /^[A-Za-z0-9._-]+$/ AND is
 * neither '.' nor '..', so it carries no separator and can never escape the
 * directory it is joined to. The dot-name exclusion is what makes that true: the
 * pattern alone admits '..', and path.join(dir, '..') NORMALIZES away to dir's
 * parent — a directory, not a command.
 */
function wellKnownLocations(command: string): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.npm-global', 'bin', command),
    // default target of the claude native installer
    path.join(home, '.local', 'bin', command),
    path.join('/opt/homebrew/bin', command),
    path.join('/usr/local/bin', command),
  ];
  // nvm keeps one bin dir per node version; newest first. The 'v18.20.1'-style
  // names must be compared numerically per segment — a plain string sort ranks
  // v9 above v18 and would hand back a long-abandoned node.
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(nvmRoot);
  } catch {
    // nvm simply isn't installed (the usual case) — contributes no candidates
  }
  const segments = (name: string): number[] =>
    name.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  versions.sort((a, b) => {
    const left = segments(a);
    const right = segments(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  });
  for (const version of versions) {
    candidates.push(path.join(nvmRoot, version, 'bin', command));
  }
  candidates.push(path.join(home, 'n', 'bin', command));
  return candidates;
}

/**
 * Whether `p` is something spawn can actually execute: a regular FILE carrying
 * the execute bit for this process.
 *
 * fs.existsSync is not that test: it is equally true for a directory and for a
 * mode-644 file, neither of which spawn can run. statSync follows symlinks here,
 * so only a LIVE link target passes — a dangling link is correctly "not found".
 * The distinction is the whole incident this release fixes: during a reinstall the
 * file exists for a moment BEFORE its exec bit is set, and an existence check
 * records that window as a SUCCESS with no retry path, so every later spawn fails
 * and nothing ever re-resolves. That window must read as "not found" so resolution
 * keeps retrying.
 *
 * On win32 accessSync treats X_OK as F_OK (there is no exec bit), so this
 * degrades to an existence check there — acceptable: the isFile() check still
 * screens out directories, which is the failure mode that actually bites.
 */
export function isSpawnableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** How long one login-shell lookup may take — in its synchronous form and its asynchronous one. */
const LOGIN_SHELL_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * What stands between a command and the login shell: the ONE gate both forms of the lookup go
 * through (resolveViaLoginShell and resolveViaLoginShellAsync). `lookup` is a name the shell
 * may be asked about — trimmed, a plain bare command name, neither dot name. Everything else
 * is its own `answer`, and no shell is started for it. resolveViaLoginShell says why each rule
 * is there.
 */
function loginShellQuestion(command: unknown): { lookup: string } | { answer: string } {
  if (typeof command !== 'string') {
    return { answer: 'claude' };
  }
  const name = command.trim();
  if (name === '') {
    return { answer: 'claude' };
  }
  if (process.platform === 'win32' || path.isAbsolute(name)) {
    return { answer: name };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return { answer: name };
  }
  return { lookup: name };
}

/** The last line of what `command -v` printed, when that line names a spawnable file. */
function spawnableFromLookup(stdout: string): string | undefined {
  const out = stdout.trim().split('\n').pop();
  return out && isSpawnableFile(out) ? out : undefined;
}

/** The first standard install location holding a spawnable `command`, else the name itself. */
function wellKnownOrBare(command: string): string {
  for (const candidate of wellKnownLocations(command)) {
    if (isSpawnableFile(candidate)) {
      return candidate;
    }
  }
  return command;
}

/**
 * Resolve a bare command name to an absolute path via the user's login shell.
 * The MCP server (and the workers and probes it spawns) may run without the shell
 * PATH that nvm/homebrew set up, so bare names can fail there with ENOENT.
 *
 * The command is interpolated into `$SHELL -lc "command -v <value>"`, and its
 * value reaches us from a workspace-level VS Code setting or the hand-editable
 * registry file — so anything that is not a plain bare command name
 * (/^[A-Za-z0-9._-]+$/, and neither '.' nor '..') is returned untouched WITHOUT
 * invoking a shell: shell metacharacters must never reach that interpolation, and
 * only bare names are worth resolving in the first place. The two dot names are
 * excluded explicitly because the pattern admits them while they name a DIRECTORY:
 * `command -v ..` fails, and the candidate path.join(home, '.npm-global', 'bin',
 * '..') normalizes to '.npm-global' — a directory that an existence check would
 * have accepted and handed back as an authoritative absolute path.
 *
 * A leading/trailing-whitespace value (' claude', a hand-edit typo) is TRIMMED
 * rather than rejected: it is non-empty, so it passes every emptiness check, but
 * untrimmed it fails the bare-name guard on the space and then fails every
 * downstream lookup — a value class that used to resolve would become permanently
 * unresolvable. Absolute paths need no resolution, and win32 has no login shell
 * to ask.
 *
 * When the login-shell lookup comes back empty — it errors, times out, or names
 * a file that does not exist — a fixed list of standard install locations
 * (wellKnownLocations) is probed before giving up. A NON-INTERACTIVE login shell
 * does not source ~/.zshrc, and that is exactly where version managers and npm
 * prefixes edit PATH, so a genuinely clean process (GUI-launched, no inherited
 * shell PATH) cannot see an installed binary at all: `env -i HOME=$HOME zsh -lc
 * 'command -v claude'` exits 1 while the binary sits in ~/.npm-global/bin. An
 * INTERACTIVE shell (-ilc) would see it, and was deliberately rejected: prompt
 * frameworks can block on startup and hang the lookup. A deterministic candidate
 * list covers the same installs and cannot hang.
 *
 * Every failure path — non-string input, shell error, timeout, output naming
 * something that is not an executable file, no candidate being spawnable —
 * returns the (trimmed) `command` unchanged rather than throwing.
 */
export function resolveViaLoginShell(command: string): string {
  const question = loginShellQuestion(command);
  if ('answer' in question) {
    return question.answer;
  }
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const found = spawnableFromLookup(
      execFileSync(shell, ['-lc', `command -v ${question.lookup}`], {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_LOOKUP_TIMEOUT_MS,
      }),
    );
    if (found !== undefined) {
      return found;
    }
  } catch {
    // fall through
  }
  return wellKnownOrBare(question.lookup);
}

/**
 * resolveViaLoginShell without the wait: the same question to the same shell, asked through a
 * child process the caller does not sit on. For the extension host, whose one thread a login
 * profile that takes seconds (nvm, conda, `brew shellenv`) would otherwise hold for as long.
 *
 * The rules are resolveViaLoginShell's own, through the same helpers — loginShellQuestion
 * decides whether a shell is asked at all, so nothing but a plain bare command name is ever
 * interpolated; the same time limit; the same reading of the answer; the same list of standard
 * locations when the shell finds nothing. The child's stdin is closed at once, which is what
 * the synchronous form's child gets: a profile that reads from it sees end-of-file.
 *
 * `signal` ends the lookup early (the shell is killed). An aborted lookup answers like any
 * failed one. Never rejects.
 */
function resolveViaLoginShellAsync(command: unknown, signal?: AbortSignal): Promise<string> {
  const question = loginShellQuestion(command);
  if ('answer' in question) {
    return Promise.resolve(question.answer);
  }
  const name = question.lookup;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stdout: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      let answer = name;
      try {
        answer = (typeof stdout === 'string' ? spawnableFromLookup(stdout) : undefined) ?? wellKnownOrBare(name);
      } catch {
        // the bare name stands
      }
      resolve(answer);
    };
    try {
      const shell = process.env.SHELL || '/bin/sh';
      const child = execFile(
        shell,
        ['-lc', `command -v ${name}`],
        { encoding: 'utf8', timeout: LOGIN_SHELL_LOOKUP_TIMEOUT_MS, signal },
        (err, stdout) => finish(err ? undefined : stdout),
      );
      // Closing the stdin of a shell that never started (or has already gone) raises an error
      // on that stream, and one with no listener would be thrown; the callback reports the
      // lookup's own outcome either way.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end();
    } catch {
      finish(undefined);
    }
  });
}

/** The configured command as every resolver below reads it: trimmed, or `claude` when there is none. */
function configuredClaudeCommand(configured: unknown): string {
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'claude';
}

/**
 * Is `previous` a last known good path for `command`: an absolute path that is still a
 * spawnable file AND still names the configured command (its basename, optionally minus a
 * Windows .exe/.cmd/.bat/.ps1 suffix)? The one statement of the rule resolveClaudePathPreserving
 * documents, shared by its three forms.
 */
function isLastKnownGoodPath(command: string, previous: unknown): previous is string {
  if (typeof previous !== 'string' || !path.isAbsolute(previous) || !isSpawnableFile(previous)) {
    return false;
  }
  const base = path.basename(previous);
  return base === command || base.replace(/\.(exe|cmd|bat|ps1)$/i, '') === command;
}

/**
 * Resolve the configured claude command, keeping the last known good absolute
 * path when resolution transiently fails.
 *
 * Incident this exists for: while the binary was mid-reinstall, a sync resolved
 * nothing and overwrote the stored absolute path with the bare name 'claude'.
 * Every process that lacks the login-shell PATH — the bundled MCP server, the
 * extension host's probes — then failed with `spawn claude ENOENT` for hours,
 * until some later sync happened to succeed. A resolution failure says nothing
 * about the path we already proved good, so it must not destroy it.
 *
 * `previous` is only reused when it is an absolute path that is still a spawnable
 * executable file (isSpawnableFile, NOT mere existence — a half-installed binary
 * without its exec bit is not a last-known-good) AND still names the configured
 * command (basename, optionally minus a Windows .exe/.cmd/.bat/.ps1 suffix).
 * Without that name check, changing the configured command would silently keep
 * pinning the OLD command's path against the user's intent.
 *
 * `configured` is trimmed before use: a hand-edited ' claude' is non-empty, so it
 * survives every emptiness check, yet untrimmed it resolves nowhere at all.
 *
 * An absolute `configured` is authoritative and returned verbatim even when it
 * does not currently exist: the user may be mid-install, and second-guessing an
 * explicit setting would silently pin a stale binary.
 */
export function resolveClaudePathPreserving(configured: unknown, previous: unknown): string {
  const command = configuredClaudeCommand(configured);
  if (path.isAbsolute(command)) {
    return command;
  }
  const resolved = resolveViaLoginShell(command);
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  return isLastKnownGoodPath(command, previous) ? previous : resolved;
}

/**
 * What the registry may hold for the configured claude command RIGHT NOW, with no shell asked,
 * and whether the login shell still has to be asked — the first half of
 * resolveClaudePathPreserving for a caller that must not wait (the extension host):
 *
 *  - an absolute `configured` is authoritative: itself, no lookup;
 *  - a `previous` that is a last known good path for the command (isLastKnownGoodPath) is kept
 *    as it is: no lookup;
 *  - otherwise the bare command, which every spawner of it tolerates, and `needsLookup` says
 *    whether a login shell would be asked about it at all (loginShellQuestion: never on win32,
 *    never for anything but a plain command name).
 *
 * Unlike the waiting form, a `previous` that still serves is not second-guessed by a fresh
 * lookup. The caller asks for one (resolveClaudePathPreservingAsync) when the user changed the
 * setting, and whenever `needsLookup` is true.
 */
export function resolveClaudePathWithoutLookup(
  configured: unknown,
  previous: unknown,
): { path: string; needsLookup: boolean } {
  const command = configuredClaudeCommand(configured);
  if (path.isAbsolute(command)) {
    return { path: command, needsLookup: false };
  }
  if (isLastKnownGoodPath(command, previous)) {
    return { path: previous, needsLookup: false };
  }
  return { path: command, needsLookup: 'lookup' in loginShellQuestion(command) };
}

/**
 * resolveClaudePathPreserving for a caller that must not wait: the same answer by the same
 * rules — an absolute `configured` verbatim, else the login shell's answer, else the standard
 * install locations, else `previous` while it is a last known good path, else the bare command
 * — with the shell asked through resolveViaLoginShellAsync instead of a blocking call.
 *
 * `options.signal` ends the lookup early; an aborted lookup answers like a failed one. Never
 * rejects, and never throws.
 */
export function resolveClaudePathPreservingAsync(
  configured: unknown,
  previous: unknown,
  options?: { signal?: AbortSignal },
): Promise<string> {
  let command: string;
  try {
    command = configuredClaudeCommand(configured);
    if (path.isAbsolute(command)) {
      return Promise.resolve(command);
    }
  } catch {
    return Promise.resolve('claude');
  }
  const bare = command;
  return resolveViaLoginShellAsync(bare, options?.signal).then(
    (resolved) => {
      try {
        return path.isAbsolute(resolved) || !isLastKnownGoodPath(bare, previous) ? resolved : previous;
      } catch {
        return resolved;
      }
    },
    () => bare,
  );
}

/**
 * Reconcile the frontier billing guard across editors that share this one
 * registry file. Every editor with the extension writes its settings here, so a
 * blind overwrite let an editor where the guard is UNSET clobber another editor's
 * explicit `allow` back to the default `block` (and vice versa). This function is
 * called on each sync with THIS editor's own explicit setting:
 *
 *  - `explicit` set (any editor)  -> take it, and record that editor as the owner.
 *  - `explicit` unset, owner is a DIFFERENT editor -> leave the value alone (an
 *    editor that never opted in must not override the one that did — the bug).
 *  - `explicit` unset, owner is THIS editor -> the opt-in was revoked; revert to
 *    the safe default `block` and clear the owner.
 *
 * Fail-safe: the default and any non-'allow' explicit value resolve to `block`,
 * so frontier billing is only ever enabled by an editor that explicitly asks for it.
 * Pure and side-effect-free apart from mutating the passed registry; unit-tested.
 */
export function applyFrontierGuard(
  registry: Registry,
  editor: string,
  explicit: string | undefined,
): Registry {
  if (explicit !== undefined) {
    registry.frontierWorkerDispatch = explicit === 'allow' ? 'allow' : 'block';
    registry.frontierGuardSetBy = editor;
  } else if (registry.frontierGuardSetBy === editor) {
    registry.frontierWorkerDispatch = 'block';
    registry.frontierGuardSetBy = undefined;
  }
  return registry;
}

/**
 * Reconcile the overage billing guard across editors that share this one
 * registry file. Semantics are IDENTICAL to applyFrontierGuard — see its doc
 * comment for why the reconciliation exists (a blind overwrite let an editor
 * where the setting is UNSET clobber another editor's explicit choice). What
 * differs is only what the guard governs: applyFrontierGuard controls WHICH
 * MODEL may be dispatched (the frontier tier), this one controls WHETHER ANY
 * dispatch may proceed past an exhausted plan window and bill real money.
 *
 *  - `explicit` set (any editor)  -> take it, and record that editor as the owner.
 *  - `explicit` unset, owner is a DIFFERENT editor -> leave the value alone (an
 *    editor that never opted in must not override the one that did — the bug).
 *  - `explicit` unset, owner is THIS editor -> the opt-in was revoked; revert to
 *    the safe default `block` and clear the owner.
 *
 * Fail-safe: the default and any non-'allow' explicit value resolve to `block`,
 * so overage spending is only ever enabled by an editor that explicitly asks for it.
 * Pure and side-effect-free apart from mutating the passed registry.
 */
export function applyOverageGuard(
  registry: Registry,
  editor: string,
  explicit: string | undefined,
): Registry {
  if (explicit !== undefined) {
    registry.overageWorkerDispatch = explicit === 'allow' ? 'allow' : 'block';
    registry.overageGuardSetBy = editor;
  } else if (registry.overageGuardSetBy === editor) {
    registry.overageWorkerDispatch = 'block';
    registry.overageGuardSetBy = undefined;
  }
  return registry;
}

/**
 * The registered worker (if any) whose configDir names the same path as `dir`.
 * Compared via path.resolve on both sides; symlinks are NOT resolved. Used to
 * refuse creating a second worker bound to an existing worker's directory —
 * a worker's dir is derived from its name at creation and KEPT across renames,
 * so re-adding a previously-used name would silently share that login.
 */
export function findWorkerByConfigDir(
  workers: WorkerProfile[],
  dir: string,
): WorkerProfile | undefined {
  const target = path.resolve(dir);
  return workers.find(
    (w) => typeof w.configDir === 'string' && path.resolve(w.configDir) === target,
  );
}

/**
 * Read ceiling for the task log. Unlike a result file or a lock token, this log is LEGITIMATELY
 * LARGE: it is the append-only ledger of every dispatch this install has ever made, it is only
 * ever truncated by an explicit Clear, and every read of it is a whole-file read. So the cap is
 * not a "this should be small" assertion — it is the line past which a file at this path is
 * certainly not a log we wrote, chosen against three real ceilings:
 *
 *  - a record is a few hundred bytes to ~1 KiB (promptPreview alone is capped at ~300 chars) and
 *    never more than TASK_EVENT_MAX_BYTES, so 64 MiB is on the order of 100,000 dispatches —
 *    orders of magnitude past any real history;
 *  - V8's maximum string is ~512 MiB, so a file past that cannot be decoded to a string AT ALL:
 *    the utf8 decode throws, and a throw from inside the activate() sweep is the failure mode
 *    this whole change exists to remove. The cap must be safely under it, not near it;
 *  - the log is APPEND-writable by any dispatched worker (its path is fixed and known), so its
 *    size is untrusted in exactly the way a result file's is. `truncate -s 8G` on it is one line.
 *
 * A log past the cap is REFUSED, never truncated — a truncated ledger is a WRONG ledger, and the
 * callers that matter (readTaskEventsChecked, renameWorker) are the ones that must never mistake
 * a partial read for the whole file. Refusal maps to `unreadable: true`, i.e. ignorance.
 */
const TASK_LOG_MAX_BYTES = 67_108_864;

/**
 * What the END of the task log looks like to a writer about to append:
 *   - `absent`: there is no log (ENOENT) — the append will create it;
 *   - `torn`:   its last byte is something other than a newline, i.e. its final line is a
 *               partial record: a process was killed part-way through an append;
 *   - `whole`:  everything else, INCLUDING "could not find out" — which is exactly the
 *               plain-append behavior.
 * Never throws.
 *
 * GUARDED LOCALLY rather than through safeFs, and the reason is that safeFs offers no primitive
 * for this: readTextSafe reads a WHOLE file, and this function must read ONE BYTE at a known
 * offset of a file that is legitimately tens of megabytes — pulling the log into memory to look
 * at its last byte, on the hot path in front of every append, is not a trade worth making. So it
 * is guarded to the same standard by hand, which is the standard readResultFile already
 * established in this file: open O_RDONLY|O_NONBLOCK (a writer-less FIFO returns instead of
 * blocking), fstat the SAME fd so the thing measured is the thing opened, and refuse anything
 * that is not a regular file. Without those two lines a worker's `mkfifo ~/.claude-code-
 * orchestrator/tasks.jsonl` blocks the very next appendTaskEvent forever.
 */
function taskLogTail(): 'absent' | 'torn' | 'whole' {
  let fd = -1;
  try {
    fd = fs.openSync(TASKS_LOG_FILE, READ_ONLY_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return 'whole';
    }
    const size = stat.size;
    if (size === 0) {
      return 'whole';
    }
    const last = Buffer.alloc(1);
    return fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a ? 'torn' : 'whole';
  } catch (err) {
    return (err as { code?: unknown } | null | undefined)?.code === 'ENOENT' ? 'absent' : 'whole';
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
 * Create `file` empty and DATA_FILE_MODE if nothing is at that name; otherwise do nothing. Never
 * throws and never blocks.
 *
 * For the task log, which this module appends to through safeFs, whose own create mode is the
 * wider 0o666 that module documents: created here first, the append that follows finds a file
 * that already has the right mode. The create is EXCLUSIVE, so it can only ever make a new empty
 * file — it opens nothing that exists (a symbolic link at the name counts as existing), and a
 * failure of any kind simply leaves the question to that append, which has its own guard.
 */
function createPrivateFile(file: string): void {
  let fd = -1;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0),
      DATA_FILE_MODE,
    );
  } catch {
    // something is there now, or nothing can be created there — the append decides
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
 * THE SIZE OF ONE EVENT. One line of the task log is at most TASK_EVENT_MAX_BYTES, its newline
 * included, WHATEVER the caller passes — appendTaskEvent is the one writer and so the one gate.
 *
 * It has to be a property of the writer because the log is read WHOLE and refused past
 * TASK_LOG_MAX_BYTES: a field that grows with its input is a way to make every dispatch this
 * install has ever recorded unreadable. A `title` used to be written at whatever length it
 * arrived, and seven dispatches with a 10 MB title put the log at 210 MiB — after which every
 * task read as unknown. At 32 KiB a line the cap is still thousands of the largest events.
 */
const TASK_EVENT_MAX_BYTES = 32 * 1024;
/** Longest `title` written, in UTF-16 code units — it is one line of a tree row and a header. */
const TASK_EVENT_TITLE_MAX_CHARS = 200;
/** Longest any OTHER string of an oversize event is left at, and what marks the cut. */
const TASK_EVENT_STRING_MAX_CHARS = 2_000;
const TASK_EVENT_STRING_CUT = '…[truncated]';
/** The reduced event's own limits (reducedTaskEvent), and what it says became of the rest. */
const TASK_EVENT_REDUCED_CWD_MAX_CHARS = 1_000;
const TASK_EVENT_REDUCED_NAME_MAX_CHARS = 256;
const TASK_EVENT_REDUCED_NOTE = 'event too large — other fields dropped';

/**
 * The fields of an event that are written as they are or not at all — never cut. `id`, `ts` and
 * `status` are what the event IS: a cut id names another task. The digest fields are compared
 * for equality, and a cut digest is a digest of nothing.
 */
const TASK_EVENT_VERBATIM_KEYS: ReadonlySet<string> = new Set([
  'id',
  'ts',
  'status',
  'ioTokenSha256',
  'detachIoTokenSha256',
]);

/** Whether `json` plus its newline fits one line of the log. */
function fitsTaskLogLine(json: string): boolean {
  const limit = TASK_EVENT_MAX_BYTES - 1;
  // A UTF-16 code unit is at most 3 bytes of UTF-8, so a short string is not measured at all —
  // which is every ordinary event.
  return json.length * 3 <= limit || Buffer.byteLength(json, 'utf8') <= limit;
}

/**
 * `value` with every string longer than TASK_EVENT_STRING_MAX_CHARS cut to that length and
 * marked, at any depth. Pure: it builds new containers and leaves its argument alone. The cut
 * leaves no half of a surrogate pair behind (sliceOneLine); the string is otherwise unchanged —
 * a multi-line value stays multi-line.
 */
function cutLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > TASK_EVENT_STRING_MAX_CHARS
      ? `${sliceOneLine(value, TASK_EVENT_STRING_MAX_CHARS)}${TASK_EVENT_STRING_CUT}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(cutLongStrings);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, cutLongStrings(inner)]),
    );
  }
  return value;
}

/**
 * The reduced form of an event that is still too large with its strings cut: what the event is,
 * who ran it and where — and a note that the rest is gone. Built from a parsed copy, so every
 * value here is plain JSON data.
 *
 * `worker`, `model`, `modelSource`, `modelUsed`, `provider`, `title` and `cwd` are kept only as
 * strings, each cut to a
 * length a real one never reaches: without that the "small" event has no bound of its own, since
 * a string of control characters is six bytes a character once it is JSON. A digest field is
 * kept verbatim when it is no larger than a digest can be, and dropped otherwise.
 */
function reducedTaskEvent(event: Record<string, unknown>): Record<string, unknown> {
  const kept: Array<[string, unknown]> = [];
  for (const key of ['id', 'ts', 'status'] as const) {
    if (event[key] !== undefined) {
      kept.push([key, event[key]]);
    }
  }
  const text = (key: string, max: number): void => {
    const value = event[key];
    if (typeof value === 'string') {
      kept.push([key, sliceOneLine(value, max)]);
    }
  };
  text('worker', TASK_EVENT_REDUCED_NAME_MAX_CHARS);
  text('model', TASK_EVENT_REDUCED_NAME_MAX_CHARS);
  text('modelSource', TASK_EVENT_REDUCED_NAME_MAX_CHARS);
  text('modelUsed', TASK_EVENT_REDUCED_NAME_MAX_CHARS);
  text('provider', TASK_EVENT_REDUCED_NAME_MAX_CHARS);
  text('title', TASK_EVENT_TITLE_MAX_CHARS);
  text('cwd', TASK_EVENT_REDUCED_CWD_MAX_CHARS);
  for (const key of ['ioTokenSha256', 'detachIoTokenSha256'] as const) {
    const value = event[key];
    if (value !== undefined && (JSON.stringify(value) ?? '').length <= 128) {
      kept.push([key, value]);
    }
  }
  // A team turn stays a team turn in its reduced form (team contract §7.7, L12): without these the
  // event would fall out of its team's grouping and into the plain `recent` listing. Kept only
  // when they have their shapes (taskEventTeam) — each is a few dozen bytes at most then. No other
  // event carries them, so every other reduced form is what it always was.
  const team = taskEventTeam(event);
  if (team !== undefined) {
    kept.push(['team', team.team]);
    if (team.member !== undefined) {
      kept.push(['member', team.member]);
    }
    if (team.turn !== undefined) {
      kept.push(['turn', team.turn]);
    }
  }
  kept.push(['error', TASK_EVENT_REDUCED_NOTE]);
  return Object.fromEntries(kept);
}

/**
 * The team fields of a task-log event (team contract §7.7), read BY VALUE — the one reader of
 * them: `team` only when it is a TEAM_ID, `member` only when it is a MEMBER_NAME, `turn` only when
 * it is a positive integer, and nothing at all when `team` is not usable (a member or a turn
 * without a team is no team turn). `cco recent --team`, the views' `Team <name> turns` grouping and
 * the Cancel routing (L12, M8) take the fields through this and nowhere else. Total.
 */
export function taskEventTeam(event: unknown): { team: string; member?: string; turn?: number } | undefined {
  if (!isJsonObject(event)) {
    return undefined;
  }
  const team: unknown = event.team;
  if (typeof team !== 'string' || !TEAM_ID.test(team)) {
    return undefined;
  }
  const member: unknown = event.member;
  const turn: unknown = event.turn;
  return {
    team,
    ...(typeof member === 'string' && MEMBER_NAME.test(member) ? { member } : {}),
    ...(typeof turn === 'number' && Number.isInteger(turn) && turn > 0 ? { turn } : {}),
  };
}

/**
 * The one line of JSON `event` is written as — at most TASK_EVENT_MAX_BYTES with its newline.
 *
 *   1. `title` is flattened to one line and cut to TASK_EVENT_TITLE_MAX_CHARS, always. It is
 *      caller-supplied text that every surface renders as a row.
 *   2. An event that fits is written as it is. This is every ordinary event, and it costs one
 *      serialization and one comparison.
 *   3. One that does not has every long string in it cut (cutLongStrings) — everywhere except
 *      the TASK_EVENT_VERBATIM_KEYS.
 *   4. One that STILL does not — hundreds of fields, deep nesting — is written in its reduced
 *      form (reducedTaskEvent).
 *
 * It does not throw for size, with one exception that is not about size: an event whose `id`,
 * `ts` and `status` alone do not fit a line is not an event of any task, and cutting its id to
 * make it fit would file it under a different one. That is refused.
 *
 * And it throws, before any of the above, for an event whose `id` is not a task file id
 * (isTaskFileId): nothing is written for it. Both refusals reach a dispatch through its record
 * writer (mcp/task-runner TaskBookkeeping), which reports them without changing the outcome.
 * `idIsFromTheLog` is for the one writer that does not choose its id — see appendSettledTaskEvent.
 */
function taskEventLine(event: TaskEvent, idIsFromTheLog = false): string {
  if (!isJsonObject(event)) {
    throw new TypeError('task log append refused: the value is not an event');
  }
  // THE ID RULE, at the place every event enters the log. A task's id is what its files are
  // named by (the report, the prompt, the result record, the reconcile lock), and every reader
  // that builds such a name asks isTaskFileId first — so an event under any other id is an
  // event of a task that can have no files, which no dispatcher of this product writes: each of
  // them mints `t<base36>` (task-runner, bg-runner, the server for a detached dispatch), and
  // everything else re-appends an id it read from this log. Refusing it HERE is what keeps a
  // task from being OPENED under such an id by anything that calls this module; refusing it
  // only at the readers left that to each caller. The message is literals: the id is the thing
  // refused, and it is not echoed.
  if (!idIsFromTheLog && !isTaskFileId(event.id)) {
    throw new Error(
      'task log append refused: the id of the event is not a task id — 1 to 128 letters, digits, ' +
        '"_" or "-" — so it could not name the files of any task',
    );
  }
  const title: unknown = event.title;
  const bounded =
    typeof title === 'string'
      ? sliceOneLine(flattenOneLine(title), TASK_EVENT_TITLE_MAX_CHARS)
      : title;
  const json = JSON.stringify(bounded === title ? event : { ...event, title: bounded });
  if (fitsTaskLogLine(json)) {
    return json;
  }
  let reduced: string;
  try {
    // From a PARSED copy of what would have been written: plain data, with everything
    // serialization does to a value (dropped `undefined`s, `toJSON`) already done to it.
    const parsed: unknown = JSON.parse(json);
    if (!isJsonObject(parsed)) {
      throw new TypeError('not an object once serialized');
    }
    const cut = JSON.stringify(
      Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
          key,
          TASK_EVENT_VERBATIM_KEYS.has(key) ? value : cutLongStrings(value),
        ]),
      ),
    );
    if (fitsTaskLogLine(cut)) {
      return cut;
    }
    reduced = JSON.stringify(reducedTaskEvent(parsed));
  } catch {
    // Too deep to walk, or not plain data once serialized. What the reduced form needs is at
    // the top level of the event itself.
    reduced = JSON.stringify(reducedTaskEvent(event as unknown as Record<string, unknown>));
  }
  if (!fitsTaskLogLine(reduced)) {
    throw new Error(
      'task log append refused: the id, ts and status of the event do not fit one log line — ' +
        'it is not an event of any task',
    );
  }
  return reduced;
}

/**
 * Append one event to the task log. Still strictly append-only — existing bytes are never
 * rewritten — but the record is separated from a PARTIAL final line first.
 *
 * readTaskEvents already tolerates a truncated line by skipping it, which made a torn tail look
 * harmless. It is not, because a torn tail has no trailing newline: the next append lands on the
 * SAME line and makes that record unparseable too, so a settle that really did happen reads as
 * though it never did, and the next sweep settles the task a second time — a second reconcile
 * note in the output file, from a hole no lock can see (measured: 2 notes, and settle-once held
 * again the moment the same truncated line ended in a newline). One byte in front of the record
 * confines the damage to the record that was actually torn.
 *
 * Two processes appending at once can both prepend, leaving a blank line; readTaskEvents skips
 * blank lines, so the extra byte is inert. The check itself never throws.
 *
 * WHAT IS WRITTEN is taskEventLine's bounded form of the event, not the object as handed in: a
 * line is at most TASK_EVENT_MAX_BYTES whatever a caller passes.
 */
export function appendTaskEvent(event: TaskEvent): void {
  appendTaskLogLine(taskEventLine(event));
}

/**
 * appendTaskEvent for the ONE writer that does not choose the id it writes under: the sweep,
 * closing a task whose `running` line is ALREADY in the log (settleDeadTask). A line that some
 * other hand put there — an edited log, a build with another id alphabet — can stand under an id
 * that is no task file id, and it still has to be closed: left `running` it would count against
 * its worker in every selection and sit in every list for as long as the log lives. Closing it
 * repeats an id the log already holds and touches no file (every file name is still asked of
 * isTaskFileId, which is why such a task has no report, no result record and no note). Nothing
 * else may use this: a writer that chooses its id goes through appendTaskEvent and its rule.
 */
function appendSettledTaskEvent(event: TaskEvent): void {
  appendTaskLogLine(taskEventLine(event, true));
}

/** The append itself, for one line taskEventLine built. appendTaskEvent says what it guarantees. */
function appendTaskLogLine(line: string): void {
  ensureDirs();
  const tail = taskLogTail();
  if (tail === 'absent') {
    createPrivateFile(TASKS_LOG_FILE);
  }
  const separator = tail === 'torn' ? '\n' : '';
  // appendTextSafe, not appendFileSync — same hazard as the read side and the same fix: the log's
  // path is fixed and known to every dispatched worker, so a `mkfifo` there turned this line into
  // an unbounded block, and the block lands wherever the append lands (a dispatch, a cancel, the
  // reconcile sweep inside activate()). The guard preserves APPEND-ONLY discipline exactly: the
  // module opens O_WRONLY|O_APPEND|O_CREAT and writes at the end, so existing bytes are never
  // rewritten, and the one-byte separator above still runs in front of a torn tail.
  const wrote = appendTextSafe(TASKS_LOG_FILE, separator + line + '\n');
  if (!wrote.ok) {
    // STILL A THROW, deliberately, and it is the one place in this change where a guarded failure
    // must NOT be softened into a return value. A caller of this function treats its return as
    // "the record is durable": settleDeadTask appends the terminal event and then annotates the
    // output file, and mcp/run-task appends and then writes result.json. If a failed append were
    // to answer quietly, the settle would write its ORPHANED note into a file whose task the log
    // still calls `running`, the next sweep would settle it again, and the double note this
    // module spent three releases eliminating would be back — from a hole no lock can see. Every
    // caller that can continue without the record already wraps this in try/catch and says so
    // (run-task, reapDeadTasks); the throw is what those catches are for. What CHANGED is only
    // that the failure is now bounded and reported instead of being an infinite block.
    //
    // The message is composed from our literals plus safeFs's own reason/detail. The event is
    // NOT interpolated: an event from an earlier build can carry a result token in plain text
    // (TaskEvent.ioToken, detachIoToken), and no field of an event belongs in a thrown string.
    throw new Error(
      `task log append refused (${wrote.reason ?? 'unreadable'}): ${wrote.detail ?? 'no detail'}`,
    );
  }
}

/**
 * What an output-file note append actually did. `ok: false` carries safeFs's own reason word, so
 * a caller can tell "the path is a FIFO / a directory / a device" from "the disk is full".
 *
 * This function used to return `void` and swallow every failure, which is the exact mistake this
 * codebase has now made twice: a guarded failure that reads to its caller as success. The type is
 * additive — every existing caller ignores the value and behaves as it always did.
 */
export interface OutputNoteAppend {
  ok: boolean;
  reason?: SafeReadFailure;
  detail?: string;
}

/**
 * Whether this platform can refuse a symbolic link IN THE OPEN ITSELF. win32 defines no
 * O_NOFOLLOW; there the report's name is looked at first (appendToReport), the same fallback
 * safeFs.readTextSafe uses for its `noFollow` read — a check, not a guarantee.
 */
const REPORT_HAS_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number';

/**
 * Open flags for appending a note to a task's REPORT: write-only, append-only, create-if-absent,
 * NON-BLOCKING, no controlling terminal — and NO-FOLLOW.
 *
 *  - O_APPEND: each write lands at the end as one operation, so two processes annotating one
 *    report interleave whole notes instead of overwriting each other.
 *  - O_NONBLOCK: a FIFO at the name with no reader fails the open at once (ENXIO) instead of
 *    blocking it forever — the brick described at appendOutputNote.
 *  - O_NOFOLLOW: a symbolic link at the name is REFUSED by the kernel (ELOOP), in the same call
 *    that would have opened it. A report is a file this product creates under a name it builds;
 *    a link there is a pointer somebody put in its place, and following it appends this note —
 *    and, with O_CREAT, creates a file — wherever the link says. A dangling link is refused the
 *    same way, so nothing is created at its target.
 *  - O_CREAT: a report that does not exist yet is created (appendToReport says why that is
 *    kept), with DATA_FILE_MODE.
 *
 * Each optional flag is probed, because an undefined constant folded into a bitwise OR is NaN —
 * an unopenable flag set.
 */
const REPORT_APPEND_NOFOLLOW =
  fs.constants.O_WRONLY |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (REPORT_HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

/**
 * WHAT IS AT A REPORT'S NAME when it is not a regular file, for a refusal — or undefined when a
 * regular file is there, or nothing can be learned. `lstat`, so a symbolic link is seen as a
 * link and not as whatever it points at. Literals only.
 */
function reportObstacle(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) {
      return 'a symbolic link';
    }
    return st.isFile() ? undefined : tempPathKind(st);
  } catch {
    return undefined;
  }
}

/**
 * Append `text` to the task report at `file`, creating the report if there is none. Never
 * throws and never blocks; says what happened.
 *
 * GUARDED LOCALLY, like the other writes of this module that safeFs has no primitive for: its
 * append follows a symbolic link, by design, because the one caller that must not lose that is
 * the task log — a file a person may keep at a link. A report is not such a file.
 *
 * ONLY A REGULAR FILE IS APPENDED TO, AND NEVER THROUGH A LINK. The name is opened no-follow
 * and non-blocking (REPORT_APPEND_NOFOLLOW) and the DESCRIPTOR is then asked what it is, so the
 * thing checked is the thing written to. Everything else at the name is a refusal with nothing
 * written and nothing created: a symbolic link (dangling or not — its target is never touched),
 * a directory, a FIFO with or without a reader, a socket, a device. Where the platform has no
 * O_NOFOLLOW (win32) the name is `lstat`ed before the open instead; that leaves the moment
 * between the two, which is the declared gap of that platform here as in safeFs.
 *
 * A MISSING REPORT IS CREATED, and the note becomes its only content. That is what this append
 * has always done, and it is kept on purpose: a task whose report was never written — its
 * dispatcher died first — would otherwise have no file to say what became of it. It is created
 * DATA_FILE_MODE. A missing DIRECTORY is not created: that is `absent`.
 *
 * The refusal's `reason` is one of safeFs's four words, so a caller that already tells them
 * apart keeps doing so; `detail` is composed from this module's literals and a shape-checked
 * errno code — never the path, never a byte of any file.
 */
function appendToReport(file: string, text: string): OutputNoteAppend {
  if (file.includes('\u0000')) {
    return { ok: false, reason: 'unreadable', detail: 'the report path holds a NUL byte' };
  }
  if (typeof text !== 'string') {
    return { ok: false, reason: 'unreadable', detail: 'the note is not a string' };
  }
  let fd = -1;
  try {
    if (!REPORT_HAS_O_NOFOLLOW && reportObstacle(file) === 'a symbolic link') {
      return { ok: false, reason: 'not-a-file', detail: 'the report is a symbolic link' };
    }
    fd = fs.openSync(file, REPORT_APPEND_NOFOLLOW, DATA_FILE_MODE);
    // FSTAT THE SAME fd: the open can succeed on things that are not files (a FIFO somebody is
    // reading, a device), and only the descriptor says what was actually opened.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, reason: 'not-a-file', detail: `the report is ${tempPathKind(st)}` };
    }
    const buf = Buffer.from(text, 'utf8');
    let written = 0;
    // LOOP ON SHORT WRITES: `writeSync` may write less than it was given, and a note cut in the
    // middle is a report that ends mid-sentence with nothing to say so.
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) {
        break;
      }
      written += n;
    }
    return written < buf.length
      ? {
          ok: false,
          reason: 'unreadable',
          detail: `only ${written} of ${buf.length} bytes of the note could be appended`,
        }
      : { ok: true };
  } catch (err) {
    const raw: unknown = (err as { code?: unknown } | null | undefined)?.code;
    const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(raw) ? raw : undefined;
    // ENOENT with O_CREAT is the DIRECTORY missing; the report itself would have been created.
    if (code === 'ENOENT') {
      return { ok: false, reason: 'absent', detail: 'the directory of the report does not exist' };
    }
    // The errno alphabet is not portable (a link is ELOOP here and EMLINK there, a socket has
    // no name at all on macOS), so the name is asked what it is rather than the code what it
    // means: anything there that is not a regular file is the reason the open failed.
    const obstacle = reportObstacle(file);
    if (obstacle !== undefined) {
      return { ok: false, reason: 'not-a-file', detail: `the report is ${obstacle}` };
    }
    return {
      ok: false,
      reason: 'unreadable',
      detail: code === undefined ? 'the append failed' : `the append failed (${code})`,
    };
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // a failing close cannot lose bytes written with writeSync
      }
    }
  }
}

/**
 * Best-effort append of a trailing note to a task's output file. The dispatch
 * server writes the output file when an attempt starts, so terminal paths that
 * bypass the server's own done/failed writers must annotate the file or it keeps
 * claiming RUNNING forever. Never throws; a no-op when outputFile is empty.
 *
 * THE VERIFIED BRICK LIVED ON THIS LINE. `tasks/<id>.md` is the one path in this module a
 * dispatched worker is EXPECTED to touch — it is that worker's own report file — so it is the
 * path most easily replaced with something that is not a file. `fs.appendFileSync` to a FIFO
 * with no reader blocks FOREVER; this function is called from the reconcile sweep, which runs
 * synchronously from the extension's activate(), so one such file bricked editor activation
 * permanently. Worse, it hung AFTER the terminal event had been appended and while the
 * per-task reconcile lock was still held by a very much live pid, so no staleness rule and no
 * acquire deadline could ever recover it. appendToReport is non-blocking, follows no link and
 * fstats what it opened, so a FIFO, a directory and a symbolic link — to another file, to
 * /dev/zero, to nothing — all return a refusal instead, with nothing written anywhere.
 *
 * "Best-effort" now means ATTEMPTED AND REPORTED, not attempted and forgotten: the verdict is
 * returned. `ok: true` for an empty `outputFile` is not a lie — a dispatch that recorded no
 * output file has no destination for the note and never had one; nothing was lost.
 */
export function appendOutputNote(outputFile: string | undefined, note: string): OutputNoteAppend {
  if (typeof outputFile !== 'string' || outputFile === '') {
    return { ok: true };
  }
  return appendToReport(outputFile, note);
}

/** Like readTaskEvents(), but distinguishes "the log could not be read" from "the log is empty". */
export function readTaskEventsChecked(): { events: TaskEvent[]; unreadable: boolean } {
  const read = readTextSafe(TASKS_LOG_FILE, TASK_LOG_MAX_BYTES);
  if (!read.ok) {
    // ENOENT IS KNOWLEDGE, NOT IGNORANCE, and it is the whole reason this distinction has to be
    // drawn by CODE instead of by the caller. A fresh install has never dispatched anything, so
    // its log does not exist and nothing is running — an empty answer there is the true one. A
    // read that failed for any OTHER reason (EACCES on a log someone chmod'ed, EMFILE under fd
    // pressure, EIO on a failing disk, EISDIR where the log should be) establishes NOTHING about
    // what is running, and a caller that cannot tell the two apart reads the second as the first.
    // A hostile review turned exactly that into a destructive act: the reaper's io-artifact sweep
    // spares a task it believes running, so a momentary EMFILE made every task look not-running
    // and deleted a live task's unread deliverable. ENOTDIR and every other code stay on the
    // unreadable side deliberately — a broken path to the log is a broken install, not a machine
    // with nothing to do.
    //
    // HOW THE GUARD'S REFUSALS MAP, because the guard invented two facts errno never reported and
    // getting either of them onto the wrong side would reintroduce that destructive act verbatim:
    //   - 'absent'     is ENOENT and NOTHING ELSE. Knowledge. unreadable: false, as before.
    //   - 'not-a-file' is a FIFO, a directory or a device sitting where the log should be. That
    //     establishes nothing whatever about what is running — it is the loudest possible signal
    //     that this install's state is not where we think it is. Ignorance. (Note it also covers
    //     what used to arrive as EISDIR, which this comment already placed on the unreadable
    //     side.)
    //   - 'too-large'  is a log past TASK_LOG_MAX_BYTES. The bytes were NOT read, so we know
    //     nothing about the tasks in them; a partial read would be worse still, since a prefix of
    //     an append-only ledger is precisely the shape that makes a finished task look running
    //     and a running task look absent. Ignorance.
    //   - 'unreadable' is every errno the old catch called ignorance. Unchanged.
    // Which is the whole rule: absent is the ONLY reason that answers false.
    return { events: [], unreadable: read.reason !== 'absent' };
  }
  return { events: taskEventsIn(read.text), unreadable: false };
}

/**
 * The events in the text of a task log: one per line that parses to a JSON object, in file
 * order. Every other line is skipped and the rest of the log is kept. Never throws.
 */
function taskEventsIn(raw: string): TaskEvent[] {
  // Skip unparseable lines individually, and DO NOT let them raise `unreadable`. appendTaskEvent
  // is a plain append, so a crash mid-write can leave one truncated line; discarding the whole
  // log for it would blank the task view, zero windowUsage, and silently defeat the
  // running-dispatch guard in renameWorker. The bytes that DID parse are knowledge, so a log with
  // one torn line is not a log we failed to read — it is a log we read, minus one record. (There
  // is no whole-FILE parse step to fail separately: the log is line-delimited JSON and the utf8
  // decode substitutes replacement characters rather than throwing, so a decode accident
  // shows up as unparseable lines, which is the case this paragraph already covers.)
  const events: TaskEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      // A LINE THAT PARSES IS NOT YET A RECORD, and the difference is a crash rather than a
      // curiosity. `JSON.parse` happily returns null, a number, a string or an array, and every
      // reader below this one reaches straight for a FIELD of what it is handed —
      // `latestById`/`latestEventsByIds`/`runningCounts` take `e.id`, `windowUsage` takes
      // `e.worker`. So ONE line reading `null` in this file threw a TypeError out of the reconcile
      // sweep, out of dispatch_status' bounded reconcile, out of the account-selection usage
      // totals, and out of the extension host's activate() — measured, all five, from a log line
      // one `echo` puts there: the log's path is fixed, it lives in the user's home directory, and
      // a dispatched worker has a shell.
      //
      // Skipped HERE rather than guarded at each reader, because the readers are the call sites
      // this repo keeps fixing one at a time. The rule this function already states covers it
      // exactly — a line that is not a record is skipped and the rest of the log is kept — and an
      // array is refused with the primitives: `[]` has no `id` either, and nothing in this module
      // has ever written one.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as TaskEvent);
      }
    } catch {
      // truncated or hand-edited line — ignore it, keep the rest
    }
  }
  return events;
}

/**
 * Every event in the task log, with an unreadable log reported as an empty one.
 *
 * Kept verbatim in behavior for the callers that legitimately cannot act on the difference —
 * views, the dashboard, windowUsage — where an unreadable log renders as an empty list either
 * way. Any caller whose next step is DESTRUCTIVE, or that treats "nothing is running" as a
 * licence, must use readTaskEventsChecked instead and refuse to act on `unreadable: true`.
 */
export function readTaskEvents(): TaskEvent[] {
  return readTaskEventsChecked().events;
}

/**
 * Truncate the task log to nothing (the Clear command). Never throws.
 *
 * GUARDED LOCALLY, because safeFs owns reading and appending and offers no truncating write —
 * and a truncate is not something it should offer: `readTextSafe`'s discipline is "prove it is a
 * regular file BEFORE you touch it", which an O_TRUNC open cannot honor, since the truncation
 * happens in the open itself. So the same standard is met in the only order this operation
 * allows: open non-blocking (WRITE_TRUNC_NONBLOCK — a FIFO with no reader fails ENXIO instead of
 * blocking, which is what `writeFileSync` did here against a worker-planted FIFO), then fstat the
 * SAME fd and refuse anything that is not a regular file. Truncating first costs nothing on a
 * path that turns out to be a FIFO or a device — there are no bytes there to lose, and this
 * function writes none either way; its entire effect IS the truncation.
 *
 * A symlink is still followed, exactly as `writeFileSync` followed it: someone who keeps their
 * log at a symlinked path is doing something legitimate, and O_NOFOLLOW would break them. The
 * fstat is what makes that safe — a symlink to /dev/zero resolves to a character device and is
 * refused on the same line as a FIFO.
 */
export function clearTaskLog(): void {
  let fd = -1;
  try {
    // A log this call CREATES gets the mode every file of this directory is created with; one
    // that exists keeps its own.
    fd = fs.openSync(TASKS_LOG_FILE, WRITE_TRUNC_NONBLOCK, DATA_FILE_MODE);
    if (!fs.fstatSync(fd).isFile()) {
      // Not a log — nothing here was ours to clear, and nothing was written into it.
      return;
    }
  } catch {
    // nothing to clear
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

/*
 * THE QUESTIONS BELOW COME IN TWO FORMS, and which one a caller needs is decided by what it does
 * with an EMPTY answer.
 *
 * Each reads the whole log, and a log that could not be read — past its cap, unreadable, a
 * directory where the file should be — yields no events. The plain form (`runningCounts`,
 * `latestEventById`, `latestEventsByIds`, `runningTasks`) reports that as nothing found, which
 * is right where nothing follows from it: a tree row, a count on a badge. The `…Checked` form
 * returns the same answer beside `unreadable`, for a caller about to CONCLUDE something from
 * absence — "no such task", "nothing is running", "nothing to recover". With `unreadable: true`
 * that caller knows nothing, and must say so rather than say "none".
 */

/**
 * Currently-running dispatch count per worker (latest event per task id), and whether the log
 * could be read at all. `counts` has no prototype (nameKeyed): a worker absent from it reads as
 * `undefined` whatever it is called, so `counts[name] ?? 0` is right for `constructor` and
 * `__proto__` too.
 */
export function runningCountsChecked(): { counts: Record<string, number>; unreadable: boolean } {
  const { events, unreadable } = readTaskEventsChecked();
  return { counts: runningCountsOf(events), unreadable };
}

/** Running dispatches per worker among `events` — the latest event of each task id decides. */
function runningCountsOf(events: readonly TaskEvent[]): Record<string, number> {
  // Counted in a Map and only then laid out as an object: the worker name is a string out of the
  // log, and a Map has no names of its own for it to collide with.
  const counts = new Map<string, number>();
  for (const e of latestOf(events).values()) {
    if (e.status === 'running' && typeof e.worker === 'string') {
      counts.set(e.worker, (counts.get(e.worker) ?? 0) + 1);
    }
  }
  return nameKeyed(counts);
}

/** runningCountsChecked's `counts`, with an unreadable log reported as nothing running. */
export function runningCounts(): Record<string, number> {
  return runningCountsChecked().counts;
}

/** Latest event per task id, in the order runningCounts observes them. */
function latestOf(events: readonly TaskEvent[]): Map<string, TaskEvent> {
  const latest = new Map<string, TaskEvent>();
  for (const e of events) {
    latest.set(e.id, e);
  }
  return latest;
}

/** latestOf the log as it is now; an unreadable log is an empty map. */
function latestById(): Map<string, TaskEvent> {
  return latestOf(readTaskEvents());
}

/**
 * Latest event recorded for one task id — `event` is undefined if the id has none — and whether
 * the log could be read at all.
 */
export function latestEventByIdChecked(id: string): {
  event: TaskEvent | undefined;
  unreadable: boolean;
} {
  const { events, unreadable } = readTaskEventsChecked();
  let event: TaskEvent | undefined;
  for (const e of events) {
    if (e.id === id) {
      event = e;
    }
  }
  return { event, unreadable };
}

/** Latest event recorded for one task id; undefined if the id has none OR the log is unreadable. */
export function latestEventById(id: string): TaskEvent | undefined {
  return latestEventByIdChecked(id).event;
}

/** How much of the task log latestTaskEventOf reads at a time, walking back from its end. */
const TASK_LOG_SCAN_CHUNK_BYTES = 64 * 1024;
/** The longest line the writer puts in the task log, its newline aside (taskEventLine). */
const TASK_LOG_LINE_MAX_BYTES = TASK_EVENT_MAX_BYTES - 1;
/** Open flags for latestTaskEventOf: readTextSafe's own — read-only, non-blocking, no tty. */
const TASK_LOG_SCAN_FLAGS =
  READ_ONLY_NONBLOCK |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);
/** What a JSON string escape of any character starts with. */
const JSON_UNICODE_ESCAPE = Buffer.from('\\u', 'latin1');

/**
 * The final event of task `id` in the log — the LAST line, in file order, that parses to an
 * event ranAs.isCountedTaskEvent admits whose `id` is `id` — or 'none' when the log has no such
 * line (no log at all included), or 'unreadable' when the log cannot be read. Never throws.
 *
 * WHY IT READS FROM THE END. Every terminal event is written behind this question
 * (closeTaskOnce), so it is asked once per dispatch at least, under a lock, of a log that is
 * legitimately tens of megabytes. The whole-log reader answers it by decoding and parsing every
 * line ever written; the task being closed is nearly always among the last of them. So the log
 * is read backwards in TASK_LOG_SCAN_CHUNK_BYTES pieces and the walk stops at the first line
 * from the end that answers — and only a line that names the id, or that holds a `\u` escape
 * through which a name can be spelled, is decoded or parsed at all. What it costs is the bytes
 * after the task's final event plus one piece, and memory for one piece and one line, however
 * long the log is. An id with no event in the log is read to the start: the price of a "no".
 *
 * THE SAME ANSWER AS THE WHOLE-LOG READER, over the same rule: the lines are those between line
 * feeds, an unterminated last line included; a line that is not an admitted event does not
 * exist, as for every reader of the counted events; and the log is refused under the same
 * conditions — something other than a regular file at the path, a size past
 * TASK_LOG_MAX_BYTES, a read that fails, or a file that shrinks while it is read. Absent is the
 * one failure that means 'none'. A line is decoded on its own, which is the same text: a line
 * feed is never part of a multi-byte UTF-8 sequence. The one difference is the line clamp. A line
 * longer than the writer ever writes (TASK_LOG_LINE_MAX_BYTES) is skipped without being put
 * together, which is what keeps the memory bounded: a 5 MiB line somebody else appended is walked
 * past at the cost of its bytes, never held.
 */
export function latestTaskEventOf(id: string): TaskEvent | 'none' | 'unreadable' {
  let fd = -1;
  try {
    fd = fs.openSync(TASKS_LOG_FILE, TASK_LOG_SCAN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return 'unreadable';
    }
    const size = stat.size;
    if (!Number.isFinite(size) || size < 0 || size > TASK_LOG_MAX_BYTES) {
      return 'unreadable';
    }
    // An id no admitted event can carry is answered once the log is known to be readable.
    if (typeof id !== 'string' || !isCountedTaskEvent({ id, status: 'done', ts: 1 })) {
      return 'none';
    }
    const name = Buffer.from(id, 'latin1');
    const eventOf = (line: Buffer): TaskEvent | undefined => {
      if (line.length === 0 || (line.indexOf(name) === -1 && line.indexOf(JSON_UNICODE_ESCAPE) === -1)) {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString('utf8'));
      } catch {
        return undefined;
      }
      return isCountedTaskEvent(parsed) && (parsed as TaskEvent).id === id
        ? (parsed as TaskEvent)
        : undefined;
    };
    const chunk = Buffer.alloc(Math.min(TASK_LOG_SCAN_CHUNK_BYTES, size));
    // The part of the current line already read, kept at the END of `held`: it began in a piece
    // not yet read. `long` once the line has passed the clamp — its bytes are no longer kept.
    const held = Buffer.alloc(TASK_LOG_LINE_MAX_BYTES);
    let heldBytes = 0;
    let long = false;
    const hold = (piece: Buffer): void => {
      if (long || heldBytes + piece.length > TASK_LOG_LINE_MAX_BYTES) {
        long = true;
        heldBytes = 0;
        return;
      }
      piece.copy(held, TASK_LOG_LINE_MAX_BYTES - heldBytes - piece.length);
      heldBytes += piece.length;
    };
    const heldLine = (): Buffer => held.subarray(TASK_LOG_LINE_MAX_BYTES - heldBytes);
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - TASK_LOG_SCAN_CHUNK_BYTES);
      const want = pos - start;
      for (let got = 0; got < want; ) {
        const n = fs.readSync(fd, chunk, got, want - got, start + got);
        if (n <= 0) {
          // The file shrank under the read (a clear): what is left is no longer that log.
          return 'unreadable';
        }
        got += n;
      }
      let end = want;
      for (;;) {
        const feed = end === 0 ? -1 : chunk.lastIndexOf(0x0a, end - 1);
        const piece = chunk.subarray(feed + 1, end);
        if (feed === -1) {
          // The line goes on in the piece before this one, or this is the log's first line.
          hold(piece);
          break;
        }
        let found: TaskEvent | undefined;
        if (heldBytes === 0 && !long) {
          found = piece.length > TASK_LOG_LINE_MAX_BYTES ? undefined : eventOf(piece);
        } else {
          hold(piece);
          found = long ? undefined : eventOf(heldLine());
        }
        if (found !== undefined) {
          return found;
        }
        heldBytes = 0;
        long = false;
        end = feed;
      }
      pos = start;
    }
    const first = long ? undefined : eventOf(heldLine());
    return first ?? 'none';
  } catch (err) {
    return fd === -1 && (err as { code?: unknown } | null | undefined)?.code === 'ENOENT'
      ? 'none'
      : 'unreadable';
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
 * Latest event for each requested id, reading the log ONCE, and whether the log could be read
 * at all. Ids with no event are simply absent from `events` — which means "not found" only when
 * `unreadable` is false; otherwise it means nothing.
 */
export function latestEventsByIdsChecked(ids: string[]): {
  events: Map<string, TaskEvent>;
  unreadable: boolean;
} {
  const want = new Set(ids);
  const read = readTaskEventsChecked();
  const events = new Map<string, TaskEvent>();
  for (const e of read.events) {
    if (want.has(e.id)) {
      events.set(e.id, e);
    }
  }
  return { events, unreadable: read.unreadable };
}

/**
 * latestEventsByIdsChecked's `events`, with an unreadable log reported as no event for any id.
 * A caller that answers "not found" from this must use the checked form.
 */
export function latestEventsByIds(ids: string[]): Map<string, TaskEvent> {
  return latestEventsByIdsChecked(ids).events;
}

/**
 * Tasks whose latest event is still 'running' (mirrors runningCounts' latest-per-id logic), and
 * whether the log could be read at all.
 */
export function runningTasksChecked(): { tasks: TaskEvent[]; unreadable: boolean } {
  const { events, unreadable } = readTaskEventsChecked();
  const tasks: TaskEvent[] = [];
  for (const e of latestOf(events).values()) {
    if (e.status === 'running') {
      tasks.push(e);
    }
  }
  return { tasks, unreadable };
}

/** runningTasksChecked's `tasks`, with an unreadable log reported as nothing running. */
export function runningTasks(): TaskEvent[] {
  return runningTasksChecked().tasks;
}

/*
 * A TASK'S FILES ARE FOUND BY ITS ID, never by a path stored in the log.
 *
 * Every event carries `outputFile`, and some carry `promptFile`: absolute paths, written by the
 * dispatcher, in a log any process running as this user can append a line to. A reader that
 * opens the path an event names therefore opens whatever a line SAYS — measured: a forged event
 * naming a file outside the data directory had that file's contents returned as the task's
 * output. The writers always put these files at `<TASKS_DIR>/<id>.md` and
 * `<TASKS_DIR>/<id>.prompt.txt`, so the id is all a reader needs, and the path fields of an
 * event are information for a person, not something to open.
 */

/** The task ids that can be part of a file name. See isTaskFileId. */
const TASK_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether `id` can be turned into the name of a file in TASKS_DIR: a string of 1–128 letters,
 * digits, `_` and `-`. THE one rule for that question — every path this module builds from a
 * task id (the report, the prompt file, the result record, the reconcile lock) asks it first.
 *
 * What it guarantees is about the NAME, and it is the whole safety property: no separator and
 * no dot, so `<id>.<suffix>` is exactly one entry of that one directory and the id can be
 * neither `.` nor `..`; and a bound, so the name always fits a file system's. It does NOT ask
 * whether this product minted the id — an id is a string out of a log line, and what matters
 * to a path is where it can point, not who wrote it.
 */
export function isTaskFileId(id: unknown): id is string {
  return typeof id === 'string' && TASK_FILE_ID.test(id);
}

/**
 * Where the file of `kind` for task `id` WOULD be — `<TASKS_DIR>/<id>.md` for its report
 * (`output`), `<TASKS_DIR>/<id>.prompt.txt` for the full prompt it was dispatched with
 * (`prompt`) — or undefined when `id` is not a task file id (isTaskFileId) or `kind` is not one
 * of the two kinds. Says nothing about what is there.
 *
 * An id that passes cannot name another directory; the directory is checked all the same.
 */
function taskFilePath(id: unknown, kind: 'output' | 'prompt'): string | undefined {
  if (!isTaskFileId(id)) {
    return undefined;
  }
  const suffix = kind === 'output' ? '.md' : kind === 'prompt' ? '.prompt.txt' : undefined;
  if (suffix === undefined) {
    return undefined;
  }
  const file = path.join(TASKS_DIR, `${id}${suffix}`);
  return path.dirname(file) === TASKS_DIR ? file : undefined;
}

/**
 * The file a reader may open for task `id`: its report (`output`, `<id>.md`) or the full prompt
 * it was dispatched with (`prompt`, `<id>.prompt.txt`). The absolute path, or undefined.
 *
 * A path comes back only when ALL of this holds:
 *   - `id` is a task file id and `kind` is one of the two kinds — the name is then the one the
 *     writers use for it, in exactly TASKS_DIR (taskFilePath);
 *   - `lstat` says a REGULAR FILE is there. A symbolic link is refused — it is how a name in
 *     this directory would be made to mean a file somewhere else — and so is a directory, a
 *     pipe or anything else.
 *
 * The answer describes the name at the moment it was asked. To READ the file use readTaskFile,
 * which finds it the same way and has the kernel refuse a link in the open itself. Never
 * throws, whatever it is handed.
 */
export function resolveTaskFile(id: unknown, kind: 'output' | 'prompt'): string | undefined {
  const file = taskFilePath(id, kind);
  if (file === undefined) {
    return undefined;
  }
  try {
    return fs.lstatSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of task `id`'s report or prompt file, found BY ID (taskFilePath) and read whole, up
 * to `maxBytes`. Never throws; every failure is one of safeFs's four named facts:
 *
 *   - `absent`:     there is no such file — or `id` is not a task file id, which has no files;
 *   - `not-a-file`: something other than a regular file is at the name — a directory, a pipe,
 *                   or a symbolic link, which is never followed;
 *   - `too-large`:  a regular file past `maxBytes`. Refused, never truncated;
 *   - `unreadable`: it could not be read. NOT the same as absent.
 *
 * The read is safeFs's with `noFollow`: non-blocking, bounded, the open itself refusing a link
 * at the name, and the opened descriptor then asked whether it is a regular file. So the file
 * read is the one AT this name in TASKS_DIR, with no moment between a look at the name and the
 * open in which the name could be made to mean another file.
 */
export function readTaskFile(id: unknown, kind: 'output' | 'prompt', maxBytes: number): SafeRead {
  const file = taskFilePath(id, kind);
  if (file === undefined) {
    return { ok: false, reason: 'absent', detail: 'the id is not a task file id' };
  }
  return readTextSafe(file, maxBytes, { noFollow: true });
}

/**
 * Why writeTaskFile did not write. Four facts:
 *   - `not-a-task-file`: `id` is not a task file id, `kind` is not one of the two kinds, or the
 *                        text is not a string. Nothing was attempted.
 *   - `absent`:          the tasks directory does not exist.
 *   - `not-a-file`:      a DIRECTORY is at the file's name — the one thing a rename cannot
 *                        replace. It was left exactly as it was.
 *   - `unwritable`:      everything else: no temporary file could be created or written (no
 *                        permission, no space), or the rename failed for another reason.
 */
export type TaskFileWriteRefusal = 'not-a-task-file' | 'absent' | 'not-a-file' | 'unwritable';

/** What writeTaskFile did. A refusal's `detail` is one line composed from literals. */
export type TaskFileWrite =
  | { ok: true }
  | { ok: false; reason: TaskFileWriteRefusal; detail: string };

/**
 * Open flags for the temporary file of writeTaskFile: write-only, and created EXCLUSIVELY — the
 * open fails if anything at all is at the name, a symbolic link included, so it can only ever
 * yield a new regular file of this process's own. No-follow and non-blocking say the same thing
 * twice over for the cases an exclusive create already refuses; they are here so that the
 * property does not rest on one flag. Each optional flag is probed (win32 defines none).
 */
const TASK_FILE_TEMP_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

/** How many temporary names writeTaskFile tries before it gives up on finding a free one. */
const TASK_FILE_TEMP_TRIES = 4;

/**
 * Write the WHOLE of task `id`'s report (`output`, `<id>.md`) or prompt file (`prompt`,
 * `<id>.prompt.txt`) — the one way a task file is written in full. Never throws and never
 * blocks; says what happened (TaskFileWrite).
 *
 * THE NAME IS REPLACED, NEVER OPENED. The text goes into a new temporary file beside it, and
 * that file is then RENAMED over the name. So whatever is at the name is never written INTO:
 *
 *   - a symbolic link there is replaced by the file; the link's target is not touched. A
 *     whole-file write that opens the name instead writes over whatever the link points at —
 *     and a dispatched worker has a shell and knows this directory;
 *   - a FIFO there is replaced by the file, without ever being opened. Opening one for writing
 *     blocks until something reads it, and these files are written synchronously by the
 *     dispatch server when a task ends: one unread FIFO at a report's name used to be enough
 *     to stop that server's only thread, and every other dispatch with it, for good;
 *   - a regular file there is replaced atomically — a reader sees the old report or the new
 *     one, never half of each;
 *   - a DIRECTORY there cannot be replaced by a rename, and is not removed to make room: that
 *     is the `not-a-file` refusal, with the directory and everything in it left alone.
 *
 * The id goes through isTaskFileId, the name is the one resolveTaskFile uses for the kind, and
 * the directory is exactly TASKS_DIR (taskFilePath). The file is created DATA_FILE_MODE.
 *
 * THE TEMPORARY FILE cannot be turned into a way around any of that. Its name carries 96 random
 * bits, so it cannot be put there in advance; it is created exclusively, so if something IS at
 * the name the create fails rather than opening it, and another name is tried
 * (TASK_FILE_TEMP_TRIES); and it is removed again on every path that does not end in the
 * rename. What a kill between the create and the rename leaves behind is one small file whose
 * name ends in `.tmp`.
 *
 * `detail` is composed from this module's literals and a shape-checked errno code: never the
 * path, never a byte of the text.
 */
export function writeTaskFile(id: unknown, kind: 'output' | 'prompt', text: string): TaskFileWrite {
  const file = taskFilePath(id, kind);
  if (file === undefined) {
    return {
      ok: false,
      reason: 'not-a-task-file',
      detail: 'the id is not a task file id, or the kind is not a task file',
    };
  }
  if (typeof text !== 'string') {
    return { ok: false, reason: 'not-a-task-file', detail: 'the text to write is not a string' };
  }
  const errno = (err: unknown): string | undefined => {
    const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
  };
  const failed = (what: string, err: unknown): TaskFileWrite => {
    const code = errno(err);
    const detail = code === undefined ? what : `${what} (${code})`;
    return { ok: false, reason: 'unwritable', detail };
  };
  let tmp = '';
  let fd = -1;
  try {
    for (let attempt = 0; fd === -1; attempt++) {
      const candidate = `${file}.${randomBytes(12).toString('hex')}.tmp`;
      try {
        fd = fs.openSync(candidate, TASK_FILE_TEMP_FLAGS, DATA_FILE_MODE);
        tmp = candidate;
      } catch (err) {
        const code = errno(err);
        if (code === 'ENOENT') {
          return { ok: false, reason: 'absent', detail: 'the tasks directory does not exist' };
        }
        // Something is at that name already. It is not opened, not removed — another name.
        if (code !== 'EEXIST' && code !== 'ELOOP' && code !== 'EMLINK') {
          return failed('a temporary file could not be created in the tasks directory', err);
        }
        if (attempt + 1 >= TASK_FILE_TEMP_TRIES) {
          return {
            ok: false,
            reason: 'unwritable',
            detail: 'no free name for a temporary file in the tasks directory',
          };
        }
      }
    }
    // Created exclusively, so this can only be a regular file of ours; asked all the same,
    // of the descriptor, before a byte is written to it.
    if (!fs.fstatSync(fd).isFile()) {
      return {
        ok: false,
        reason: 'unwritable',
        detail: 'the temporary file is not a regular file',
      };
    }
    const buf = Buffer.from(text, 'utf8');
    let written = 0;
    // LOOP ON SHORT WRITES: a report renamed into place must be the whole report.
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) {
        break;
      }
      written += n;
    }
    if (written < buf.length) {
      return {
        ok: false,
        reason: 'unwritable',
        detail: `only ${written} of ${buf.length} bytes could be written`,
      };
    }
    fs.closeSync(fd);
    fd = -1;
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      // The one thing a rename of a file cannot replace is a directory. Asked of the name
      // itself (`lstat`), because the errno for it differs between platforms.
      let directory = false;
      try {
        directory = fs.lstatSync(file).isDirectory();
      } catch {
        // gone again, or not ours to look at — reported as the rename's own failure
      }
      return directory
        ? { ok: false, reason: 'not-a-file', detail: 'a directory is at the name of the task file' }
        : failed('the file could not be renamed into place', err);
    }
    tmp = '';
    return { ok: true };
  } catch (err) {
    return failed('the task file could not be written', err);
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    if (tmp !== '') {
      // Every path that did not end in the rename: the temporary file is ours and goes.
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already gone, or not removable — it is litter with an unguessable name either way
      }
    }
  }
}

/**
 * Where a note about `task` is appended — its report, `<TASKS_DIR>/<id>.md` — or undefined when
 * it has none: the event recorded no output file at all, or its id is not a task file id.
 *
 * Derived from the ID. The event's own `outputFile` is consulted only for whether the dispatch
 * recorded one; the path it names is never the destination, because a line of the log is not an
 * authority on which file of this machine gets a paragraph appended to it.
 */
function taskReportFile(task: TaskEvent): string | undefined {
  if (typeof task.outputFile !== 'string' || task.outputFile === '') {
    return undefined;
  }
  return taskFilePath(task.id, 'output');
}

/**
 * appendOutputNote for a task FOUND IN THE LOG: the note goes to taskReportFile — the report
 * the task's id names — under appendToReport's rule: appended to a REGULAR file at that name,
 * never through a symbolic link (which resolveTaskFile and readTaskFile refuse as well, so the
 * file a note lands in is one a reader will be shown), and a report that does not exist yet is
 * created. This is the form for any caller whose `task` came out of the log; appendOutputNote
 * itself is for a dispatcher annotating the file it has just created and still holds the path
 * of. Never throws; `ok: true` when the task has no report to annotate, `ok: false` with a
 * reason when there is one and the note could not be written to it.
 */
export function appendTaskNote(task: TaskEvent, note: string): OutputNoteAppend {
  return appendOutputNote(taskReportFile(task), note);
}

/**
 * Whether `pid` names a live process. `process.kill(pid, 0)` sends no signal; it
 * only probes. EPERM means the process exists but is owned by another user (still
 * alive); ESRCH means no such process. A non-finite or non-positive pid is never
 * a real process.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The headless-mode switch each non-Claude CLI is started with — `codex exec`, `cursor-agent -p`,
 * `agy -p` — as it appears on a command line. It is the second anchor isOurWorker needs for such
 * a worker, and the one that tells a dispatched child from the same CLI open interactively in
 * somebody's terminal, which has the name and not the switch.
 */
const PROVIDER_WORKER_SWITCH: Readonly<Record<Exclude<ProviderId, 'claude'>, string>> = {
  codex: ' exec',
  cursor: ' -p',
  gemini: ' -p',
};

/**
 * Read ceiling for one `ps` line of a non-Claude worker. Those CLIs take the whole prompt as a
 * command-line argument, so the line is as long as the prompt; past execFileSync's 1 MiB default
 * the read throws, which would report a live worker as "not ours".
 */
const PROVIDER_PS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Does this command line run `cli` — as a bare command, as the last component of a path, or as a
 * directory on the way to the script a launcher exec'd (`…/cursor-agent/versions/…/index.js`)?
 * Delimited on both sides: a three-letter name such as `agy` must not match inside another word.
 */
function commandLineNamesCli(args: string, cli: string): boolean {
  const name = cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s/])${name}([\\s/.]|$)`).test(args);
}

/**
 * The command line of process `pid` as `ps` reports it, untruncated (`-ww`), or undefined when it
 * cannot be learned: win32 (no `ps`), a pid that is not a positive integer, a `ps` that failed
 * (it exits non-zero for a pid that names no process), or one that printed nothing. Never throws.
 */
function processCommandLine(pid: number): string | undefined {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const line = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      maxBuffer: PROVIDER_PS_MAX_BYTES,
    });
    return line.trim() === '' ? undefined : line;
  } catch {
    return undefined;
  }
}

/**
 * Whether process `pid` is running the agent CLI named `cli` — the identity question a caller
 * must ask before it signals a pid it merely REMEMBERS (out of a ledger, a session file, an
 * earlier listing): the process that had that number may be gone and the number handed to
 * something unrelated.
 *
 * THREE answers, and the third is not the second. `true`: the command line names `cli` as a
 * command (commandLineNamesCli — bare, the last component of a path, or a directory on the way to
 * the script). `false`: a command line was read and it does not. `undefined`: it could NOT be
 * determined — win32, a `ps` that failed, empty output, a pid that is not a positive integer, a
 * blank `cli`. A caller deciding whether to signal treats `undefined` exactly as `false` (nothing
 * proves the process is the one it means); a caller deciding whether something is GONE must not
 * (nothing proves that either).
 *
 * It says nothing about whose process it is or what that CLI is doing — a second anchor (a
 * switch, a directory, a session id) is the caller's to add. Never throws.
 */
export function processRunsCli(pid: number, cli: string): boolean | undefined {
  if (typeof cli !== 'string' || cli.trim() === '') {
    return undefined;
  }
  const line = processCommandLine(pid);
  return line === undefined ? undefined : commandLineNamesCli(line, cli);
}

/**
 * When process `pid` started, in epoch milliseconds — the second identity question a caller can
 * ask before it signals a pid it merely REMEMBERS (processRunsCli is the first). A pid that has
 * changed hands belongs to a process that started AFTER the record it was found under was
 * written; the process that record describes cannot have. So a start time later than the
 * record's own says "this is not the process the record is about", whatever its command line
 * says.
 *
 * `undefined` when it cannot be determined: win32 (no `ps`), a pid that is not a positive
 * integer, a `ps` that failed or timed out (it exits non-zero for a pid that names no process),
 * or an elapsed-time field in a shape this does not recognise. A caller deciding whether to
 * signal treats that as "not confirmed". Never throws.
 *
 * The reading is the file lock's own (probeProcess: `ps -o stat= -o etime=`), so it has that
 * reading's precision and no more: `etime` is whole seconds, which puts the answer up to one
 * second LATER than the truth, and the clock is read before `ps` is started, which puts it
 * earlier by however long that took. A caller comparing it with a time some other process
 * wrote down leaves room for both — and for the fact that it is derived from the wall clock as
 * it reads NOW: where `etime` is measured on a clock the wall clock can be stepped against, a
 * step made since the process started moves the answer by as much.
 */
export function processStartedAt(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return probeProcess(pid)?.startedAt;
}

/**
 * CRITICAL SAFETY GATE. A 'running' event can be stale, and the OS may have
 * recycled its pid for a completely unrelated process. Never signal a pid without
 * first confirming it is still one of our workers by reading its command line.
 * Our workers are spawned as `claude -p --output-format json …`, so the command
 * line must contain both `claude` and ` -p`. Any error, empty output, or
 * non-matching command line is treated as "not ours" → not signalled. On win32
 * there is no `ps`, so we degrade to "treat as dead" and never signal.
 *
 * `provider` is the task event's own `provider` field. Absent, or anything that is not a
 * non-Claude provider id, takes the rule above unchanged. A worker on another vendor's CLI is
 * not a `claude -p`: judged by that rule it would read as "not ours" for its whole life — its
 * task reaped as orphaned while it runs, and a cancel recorded without ever signalling it. So
 * it gets the same two-anchor test in its own terms: the CLI's name, and that CLI's headless
 * switch. `-ww` because the switch can sit behind a long model id, and a width-truncated line
 * would drop it.
 *
 * BOTH branches read the command line the same way (processCommandLine: `-ww`, an 8 MiB read
 * ceiling). The Claude branch gained `-ww` for team mode (team contract L1): a teammate's `claude`
 * argv puts ` -p` some 500 characters in, behind the session id, the brief and MCP config files and
 * the allowed tools, and a width-truncated line (Linux procps without `-ww`) would drop it — the
 * live turn would then read as "not ours" to every reconcile and to the orphan sweep. Exported
 * for the team engine (M1), which fences every signal it sends after a host restart with it (I7).
 */
export function isOurWorker(pid: number, provider?: unknown): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const id = parseProvider(provider);
  // The same read processRunsCli makes, asked once for both anchors.
  const line = processCommandLine(pid);
  if (id !== undefined && id !== 'claude') {
    return (
      line !== undefined &&
      commandLineNamesCli(line, providerInfo(id).cli) &&
      line.includes(PROVIDER_WORKER_SWITCH[id])
    );
  }
  return line !== undefined && line.includes('claude') && line.includes(' -p');
}

/**
 * Companion to isOurWorker for the DETACH SUPERVISOR process. A supervisor is spawned
 * `node <…>/run-task.js <…>/tasks/<id>.spec.json` (see dispatchDetached in server.ts).
 * Same safety rationale as isOurWorker — a 'running' event's supervisorPid can be stale
 * and the OS may have recycled it — but the bar is TWO anchored tokens, like isOurWorker's
 * `claude`+` -p` (contract F4): the command line must contain BOTH the `run-task.js`
 * entrypoint AND THIS task's unique `tasks/<id>.spec.json` argument. The loose lone
 * `run-task` substring matched a recycled pid, an editor with the file open, an unrelated
 * `run-task-fake.mjs`, or a DIFFERENT task's supervisor — any of which would have wrongly
 * kept a dead task `running` forever (a false-negative reap). Pairing the entrypoint with
 * the per-task spec path (unique to this id, and still on the argv even after the supervisor
 * unlinks the spec file) makes such a false match effectively impossible.
 * On win32 there is no `ps`, so this degrades to "not ours" (the declared R9 gap).
 */
function isOurSupervisor(pid: number, id: string): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    // -ww: never truncate to terminal width. The spec argument is the LAST token on a
    // long `node <abs>/run-task.js <abs>/tasks/<id>.spec.json` command line, and a
    // width-truncated `ps` would drop it — a false-negative supervisor match that would
    // let a live supervisor's task be wrongly orphaned. isOurWorker's tokens sit early
    // in the argv so it does not need this; here the second anchor is at the tail.
    const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    if (!args) {
      return false;
    }
    return args.includes('run-task.js') && args.includes(`${id}.spec.json`);
  } catch {
    return false;
  }
}

/**
 * Send `sig` to a worker's ENTIRE process tree when we safely can, else to the
 * single worker process. Callers MUST have already confirmed `event.pid` is a
 * positive finite number and that both isPidAlive(event.pid) and
 * isOurWorker(event.pid) hold; this is re-asserted here as a guard.
 *
 * A group signal is sent ONLY when the event recorded a `pgid` AND that `pgid` IS
 * the event's `pid`. A worker spawned detached leads its own process group, so for
 * it the two are one number — and the pid is the one number whose process has just
 * been identified as ours. `pid` and `pgid` are two separate fields of a log line,
 * and nothing makes them agree: a `pgid` that names anything but the checked pid is
 * a group nobody identified, so it is never signalled — only the pid is. Nor is a
 * group id ever derived from a pid that recorded none: a worker from an older
 * build is not a group leader, and `-pid` would then signal the server's group — a
 * group we do not own. On win32 negative pids are meaningless, so we use
 * `taskkill /T` to kill the tree by pid. Never throws.
 *
 * Exported for the team engine (team contract M1): a team turn's task-log events carry the same
 * `pid`/`pgid`/`provider`, so after a host restart the orphan sweep signals an orphaned turn
 * through exactly this gate (I7) — never through a pid of its own reading.
 */
export function signalWorker(event: TaskEvent, sig: NodeJS.Signals): void {
  const pid = event.pid;
  if (typeof pid !== 'number' || !isPidAlive(pid) || !isOurWorker(pid, event.provider)) {
    return;
  }
  if (process.platform === 'win32') {
    // taskkill kills the whole tree by pid; negative pids are never used here.
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // process may already be gone, or taskkill unavailable — nothing to do
    }
    return;
  }
  if (event.pgid === pid) {
    try {
      // The recorded group id IS the checked pid: `-pid` signals the group this worker leads.
      process.kill(-pid, sig);
    } catch {
      // group already gone (ESRCH) or otherwise unsignalable — fall back to the
      // single worker process so cancellation still lands on the parent.
      try {
        process.kill(pid, sig);
      } catch {
        // the worker exited between the checks above and this signal
      }
    }
    return;
  }
  // No recorded group (an older event), or one that is not this worker's own: only the
  // single worker process is signalled.
  try {
    process.kill(pid, sig);
  } catch {
    // the worker exited between the checks above and this signal
  }
}

/** What closeTaskOnce did. */
export type TaskClose =
  /** The terminal event was appended; `superseded` is the task's event before it, when it had one. */
  | { closed: true; superseded: TaskEvent | undefined }
  /** The task already had a terminal event — `final` — and nothing was appended. */
  | { closed: false; final: TaskEvent | undefined };

/**
 * Close a task in the log AT MOST ONCE: under the task's reconcile lock, re-read its final event
 * (latestTaskEventOf, from the end of the log), hand it to `decide`, and append the terminal
 * event `decide` returns — unless the task is already closed, or `decide` returns nothing.
 *
 * WHY EVERY WRITER OF A TERMINAL EVENT COMES THROUGH HERE. A task ends once, but several hands
 * can end it: its own dispatch core (the worker finished, or failed), a cancel from the editor,
 * a cancel of the request, a server going down, the sweep that settles a task whose owner died.
 * Each of them used to read "the task is running", do its work — which for a cancel is a signal
 * and a wait of seconds — and then append, without looking again. A worker that finished while a
 * cancel was waiting out its grace was recorded `running, running, done, error`: success for the
 * dispatch's caller, a cancellation in the log, and two readers of the log answering differently
 * about one task. The lock is the one the sweep already settles under (settleDeadTask), so the
 * sweep, a cancel and a completion exclude each other: whichever gets there first closes the
 * task, and the others find it closed.
 *
 * `decide` is given the final event as it is NOW, under the lock — undefined when the task has
 * no event, or when the log could not be read (`unreadable`). A log that cannot be read says
 * nothing either way; what to do then is the caller's, which is why it is told.
 *
 * WHEN THE LOCK CANNOT BE HAD. withFileLock throws after its wait when a live process keeps the
 * lock (a sweep stuck in a `ps`). A terminal event is the record that a task ended at all, and
 * not writing it leaves the task `running` for the sweep to call orphaned — so the close then
 * goes ahead WITHOUT the lock, re-read and all: what is lost is the exclusion from that one
 * stuck holder, not the record. An error from the append itself is thrown as it always was.
 */
function closeTaskOnce(
  id: string,
  decide: (final: TaskEvent | undefined, unreadable: boolean) => TaskEvent | undefined,
): TaskClose {
  let entered = false;
  let result: TaskClose | undefined;
  const once = (): void => {
    entered = true;
    const latest = latestTaskEventOf(id);
    const unreadable = latest === 'unreadable';
    const final = typeof latest === 'string' ? undefined : latest;
    if (final !== undefined && final.status !== 'running') {
      result = { closed: false, final };
      return;
    }
    const terminal = decide(final, unreadable);
    if (terminal === undefined) {
      result = { closed: false, final };
      return;
    }
    appendTaskEvent(terminal);
    result = { closed: true, superseded: final };
  };
  try {
    // The lock files live in TASKS_DIR; without it every acquisition fails for nothing.
    ensureDirs();
    withFileLock(reconcileLockTarget(id), () => once());
  } catch (err) {
    if (result !== undefined) {
      // The section ran to its end; only the lock's release had something to say.
      return result;
    }
    if (entered) {
      // The read or the append threw: the caller's to hear, as from a bare append.
      throw err;
    }
    once();
  }
  // `once` either sets it or throws.
  return result as unknown as TaskClose;
}

/**
 * Append the TERMINAL event `event` unless its task already has one (closeTaskOnce). For a
 * writer that knows what its task came to — a dispatch core recording a result or a failure, a
 * server recording a cancelled request or its own shutdown. A task with no event at all, and a
 * log that could not be read, are both written to: the writer's own knowledge of the outcome is
 * the best there is, and withholding it would lose the only record that the task ended.
 *
 * Throws what appendTaskEvent throws (an id that is no task id, a log that refuses the write).
 */
export function appendTerminalTaskEvent(event: TaskEvent): TaskClose {
  return closeTaskOnce(event.id, () => event);
}

/**
 * Terminate the worker behind a running task and record a terminal 'error' event. Returns
 * whether THIS call cancelled the task: false — and nothing written, nothing signalled — when
 * the task is absent or its final event is not 'running', which is what a caller is told of a
 * task that had already finished, and what makes a second call a no-op.
 *
 * RECORDED FIRST, THEN STOPPED. The cancellation is appended under the task's reconcile lock,
 * after re-reading the task's final event there (closeTaskOnce); only then is the worker
 * signalled and its grace waited out. The order used to be the reverse — signal, wait three
 * seconds, append without looking again — and both halves of that were wrong. A worker that
 * FINISHED inside the grace had its `done` overwritten by `error: cancelled`. And a worker that
 * died of the signal had its death recorded by its own dispatch core within milliseconds, as a
 * failure of the worker, seconds before the cancellation was written after it. Now whichever
 * closes the task first is the record: a task that finished before the cancel is left as it
 * finished, and a cancel that got there first is what the dispatch core finds when its worker
 * dies — it then records nothing of its own (appendTerminalTaskEvent).
 *
 * A signal is sent ONLY when the recorded pid is present, alive, and still matches our worker's
 * command line (see isOurWorker); a missing, dead, or recycled pid is never signalled. Stats
 * are left untouched — a cancellation is not a worker error.
 */
export async function cancelRunningTask(id: string, reason: string, graceMs = 3000): Promise<boolean> {
  // Stripped for the same reason the reconcile ladder strips it: this is a TERMINAL event built
  // by spreading a RUNNING one, and the detach io token lives only on running events. (A detach
  // task's terminal record is authored by its supervisor, not here — but this function is reached
  // by task id from the extension's cancel command, so it must not be the one place the rule
  // does not hold.)
  const close = closeTaskOnce(id, (final, unreadable) =>
    // Nothing is known of a task that has no event, or whose log could not be read: there is no
    // worker to stop and no record to supersede, exactly as before.
    final === undefined || unreadable
      ? undefined
      : { ...withoutDetachToken(final), ts: Date.now(), status: 'error', error: reason },
  );
  if (!close.closed || close.superseded === undefined) {
    return false;
  }
  const latest = close.superseded;
  appendTaskNote(latest, `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n`);
  const pid = latest.pid;
  if (typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid, latest.provider)) {
    // signalWorker reaches the worker's whole process tree when the event's
    // recorded pgid is this pid, else the single process; it re-asserts the same gate.
    signalWorker(latest, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    // Re-confirm the pid is still alive AND still our worker before escalating:
    // if the process exited during the grace period its pid may have been
    // recycled, and SIGKILL to a recycled pid would kill an unrelated process.
    if (isPidAlive(pid) && isOurWorker(pid, latest.provider)) {
      signalWorker(latest, 'SIGKILL');
    }
  }
  return true;
}

/**
 * Signal the WORKER of a detach task by its recorded pgid/pid — the server's half of
 * a detach cancel (contract §7 R7). Unlike cancelRunningTask this appends NO terminal
 * event: for a detach task the supervisor is the sole author of terminal events
 * (§5.3), and it writes the `cancelled` record itself once the dropped `.cancel`
 * marker makes its worker die. The server cannot reach the worker through
 * childrenByTask (a detach worker was spawned by the supervisor, not the server), so
 * it signals the recorded group directly here — SIGTERM, then SIGKILL after the grace
 * if it is still alive-and-ours. A no-op when the task is not running or its worker
 * pid is dead/absent (e.g. cancelled between attempts, where the marker alone
 * suffices). Never throws.
 */
export async function terminateDetachWorker(id: string, graceMs = 3000): Promise<void> {
  const latest = latestById().get(id);
  if (!latest || latest.status !== 'running') {
    return;
  }
  const pid = latest.pid;
  // On win32 isOurWorker returns false unconditionally (no `ps`), so this whole function
  // no-ops there: detach cancel of a RUNNING worker is marker-only on Windows (declared R9
  // gap) — the taskkill /T branch in signalWorker is unreachable from this path, not a claim
  // that a running Windows worker gets signalled.
  if (typeof pid !== 'number' || !isPidAlive(pid) || !isOurWorker(pid, latest.provider)) {
    return;
  }
  signalWorker(latest, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  // Re-confirm alive AND still ours before escalating: if it exited during the grace
  // its pid may have been recycled, and SIGKILL to a recycled pid would hit a stranger.
  if (isPidAlive(pid) && isOurWorker(pid, latest.provider)) {
    signalWorker(latest, 'SIGKILL');
  }
}

/**
 * Fields the reaper reads from a detach task's tasks/<id>.result.json to reconcile a
 * completed-but-unrecorded run (contract §7 R8). A structural subset of run-task.ts's
 * TaskResult; declared locally so registry.ts stays free of any mcp/ import. Read-only.
 */
export interface ResultRecord {
  id?: string;
  status?: 'done' | 'error';
  text?: string;
  worker?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

/**
 * WHO CAN WRITE tasks/<id>.result.json, AND WHAT VALIDATING IT DOES AND DOES NOT PROVE.
 *
 * The INTENDED writer is the detach supervisor (mcp/run-task.ts): one process, one task id, an
 * atomic tmp+rename of `JSON.stringify(TaskResult)`. That is why this rung sits ABOVE the
 * injected recovery hook in reconcileTerminalEvent's ladder — and the comment there used to say
 * the rung was credible because "a worker cannot author the thing that makes it credible". THAT
 * CLAIM WAS FALSE, and it is stated here plainly rather than quietly removed:
 *
 *   - the path is FIXED and UNGUARDED. A dispatched worker knows its own task id (its bootstrap
 *     prompt carries it and its io directory is named after it), a `-p` worker runs with Bash,
 *     and ROOT_DIR is a stable path in the user's home directory. Writing this file is one
 *     redirect.
 *   - THE PATH IS TOKEN-GATED. The dispatcher mints a token per detached dispatch
 *     (server.dispatchDetached, ioToken.newIoToken) and hands it to the supervisor in a spec file
 *     the supervisor unlinks the instant it has read it — before any worker process exists. The
 *     supervisor records the token's SHA-256 on the task's RUNNING events
 *     (`detachIoTokenSha256`) and writes the token itself into this file as `token`. A record
 *     whose `token` does not hash to the recorded value is refused before any of its payload is
 *     read (readResultFile's gate; readResultForTask resolves the expectation from the task's
 *     history — the first well-formed value recorded, never a later one).
 *   - WHAT THAT GATE IS WORTH is stated once, at TaskEvent.ioTokenSha256 (WHAT THE TOKEN GATE
 *     DEFENDS), and nothing in this header may be read as a claim past it. One more limit belongs
 *     to this LOG rather than to the token: any process running as this user can append a line
 *     to it. The first-wins rule (taskLogFacts) is what keeps a later line from replacing a
 *     dispatch's expectation; a line for an id nobody dispatched is, for that id, the first.
 *
 * SO WHAT THE VALIDATION BELOW IS FOR. For a dispatch that recorded a token it answers "did the
 * writer of this file know this task's token?". For one that recorded none — a dispatch that
 * predates the field — it answers only the smaller questions, which are still the ones the
 * measured failures came through:
 *
 *   PROVED — the record is a JSON object of bounded size that names THIS task; its `status` is
 *   one of the two values the ladder switches on; every field the ladder consumes has the type
 *   the ladder assumes, so nothing of a foreign type can reach a `TaskEvent` (an object `error`
 *   crashed views.getTreeItem's `.trim()`; a string `inputTokens` string-CONCATENATED into
 *   windowUsage's account-selection totals); the usage numbers are finite, non-negative, whole
 *   (counts) and under a sanity ceiling, so no single record can dominate a quota window; the
 *   error text is one bounded line that cannot choose its own classification (resultErrorLabel).
 *
 *   PROVED FOR A TOKEN-BEARING DISPATCH — THAT THE WRITER KNEW THIS DISPATCH'S TOKEN. The record
 *   must carry a value whose SHA-256 the supervisor recorded before the worker existed, checked
 *   before any payload field is trusted, with a missing `token` refused exactly as a wrong one
 *   is (omitting the field would otherwise be the whole bypass). Read that as written — "knew
 *   the token" — and NOT as "the supervisor wrote it": WHAT THE TOKEN GATE DEFENDS, at
 *   TaskEvent.ioTokenSha256, says what that stops and what it cannot.
 *
 *   NOT PROVED FOR A DISPATCH THAT RECORDED NO TOKEN — WHO WROTE IT. A worker that writes a
 *   well-formed record naming its own task, with `status:"done"` and plausible usage numbers, is
 *   indistinguishable from its supervisor here, and no amount of shape checking changes that.
 *   Two things bound the damage: the numbers it can claim are bounded and must be numbers, and
 *   the prose it can claim cannot seize the `cancelled`/`orphaned` classes. This is the residual
 *   the token closes going forward, and it shrinks to nothing as pre-token dispatches age out;
 *   it is NOT a fallback anything can select, because a dispatch that recorded a token can only
 *   reach it by having its own log line corrupted, and that is a refusal rather than a downgrade
 *   (detachTokenGate).
 *
 *   ALSO PROVED, FOR EVERY DISPATCH — THAT SOMEONE WAS ENTITLED TO WRITE HERE AT ALL. Exactly
 *   one thing in this system writes this path (mcp/run-task.writeResultJson, reached only from a
 *   detach supervisor's own process), and exactly one thing records `supervisorPid` on an event
 *   (that same supervisor, on every event of its task). So a dispatch whose history records no
 *   supervisor anywhere has no legitimate writer of this path, and a file found there is refused
 *   on that durable discriminator without any of it being read. See readResultForTask.
 *
 *   REFUSED IS NOT ABSENT. "A result file was present and failed validation" and "no result file
 *   existed" are different operational facts about a task, and the ladder says which one it saw
 *   (see ResultFileRead and reconcileTerminalEvent's refusal note) instead of falling through as
 *   though the disk were empty. Same discipline the mesh recovery already applies to its own
 *   channel of record.
 */

/**
 * Read ceiling for one result.json. The file is writable by a party that may not be the
 * supervisor, so its SIZE is untrusted too: an unbounded readFileSync on this path is a
 * one-line out-of-memory lever. 1 MiB is far above any real record — the largest field is the
 * worker's final report, and the mesh channel of record caps its equivalent at 256 KiB — and a
 * record past it is REFUSED rather than read, with the report still in the output file where a
 * human reads it. Enforced against the fstat of the SAME open fd that is then read, so the file
 * cannot be swapped for a larger one between the check and the read.
 */
const RESULT_FILE_MAX_BYTES = 1_048_576;

/**
 * Sanity ceiling on one dispatch's token counts. This is NOT an authenticity check — nothing
 * here can tell a forged 4,000,000 from a real one — it is the bound that stops a single record
 * from dominating the trailing-window totals windowUsage feeds into account selection. 1e8
 * tokens is orders of magnitude above any real dispatch (a long agentic run with cache reads
 * counted lands in the millions), so it rejects only values that were never a token count.
 */
const RESULT_TOKENS_MAX = 100_000_000;

/** Sanity ceiling on one dispatch's cost, in USD. Same reasoning and same non-claim as above. */
const RESULT_COST_USD_MAX = 10_000;

/**
 * What reading tasks/<id>.result.json actually produced. THREE outcomes, not two, because
 * "absent" and "refused" are different facts and the caller records them differently.
 * `why` is composed entirely from the literals below — never from the record's own bytes,
 * which are the untrusted thing being described.
 */
export type ResultFileRead =
  | { kind: 'ok'; record: ResultRecord }
  | { kind: 'absent' }
  | { kind: 'refused'; why: string };

const REFUSED_NOT_A_FILE = 'the path is not a regular file';
const REFUSED_TOO_LARGE = `the file is larger than the ${RESULT_FILE_MAX_BYTES}-byte read cap`;
const REFUSED_UNREADABLE = 'the file could not be read';
const REFUSED_UNPARSEABLE = 'the file is not parseable as a result record';
const REFUSED_NOT_OBJECT = 'the record is not a JSON object';
const REFUSED_ID = 'the record does not name this task';
const REFUSED_STATUS = 'the record carries no "done"/"error" status';
const REFUSED_TEXT_FIELD = 'a text field of the record is not a string';
const REFUSED_USAGE_FIELD = 'a usage field of the record is not a usable count';
const REFUSED_NOT_DETACH = 'this dispatch has no detach supervisor, so nothing may write it';
/**
 * ONE literal for BOTH a wrong token and a missing one, deliberately. "Absent" is not a weaker
 * failure than "wrong" here — it is the bypass the gate exists to close, since a forger that
 * cannot produce the value would otherwise simply omit the field — so the two must not be
 * distinguishable, either in what is recorded or in what a prober can read back off this surface.
 */
const REFUSED_TOKEN = "the record does not carry this dispatch's result token";
/**
 * Opens the refusal for a dispatch whose OWN recorded token is not a token by value. Completed
 * with a description of that field's SHAPE (describeUnusableDetachToken) and never its value.
 */
const REFUSED_TOKEN_UNUSABLE = "this dispatch's recorded result token is unusable — it is ";
/**
 * The plain-path discriminator's refusal. Distinct wording from REFUSED_NOT_DETACH so an operator
 * can tell WHICH arm refused: that one means "this is a mesh dispatch", this one means "no event
 * of this dispatch ever recorded a supervisor at all".
 */
const REFUSED_NO_SUPERVISOR =
  'no event of this dispatch records a detach supervisor, so nothing may write it';

/**
 * One usage field, validated BY VALUE. Absent is legitimate and means "not stated" (the caller
 * records 0, exactly as before); anything present must be a real count. A present-but-invalid
 * value is NOT coerced to 0 or to the ceiling — it invalidates the whole record, because the
 * writer this rung is meant to be reading always emits three numbers, so a non-number here is
 * evidence about the WRITER, not a field to be repaired.
 *
 * `whole` is set for token counts: a fractional token count is not a token count. Cost is money
 * and stays fractional. NaN and ±Infinity cannot survive JSON at all, and are excluded anyway
 * because `Number.isFinite` is the check that makes the comparisons below mean anything.
 */
function usageValue(raw: unknown, max: number, whole: boolean): { ok: boolean; value?: number } {
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) {
    return { ok: false };
  }
  if (whole && !Number.isInteger(raw)) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

/**
 * WHAT SHAPE an unusable recorded result token had, for a refusal reason — never its value.
 *
 * Mirrors mesh/reaper's describeUnusableEventToken, and for its reasons: the distinction a reader
 * needs is between "the log line lost this field's contents" (empty or null: a truncated write, a
 * hand edit, a placeholder) and "something wrote a value of the wrong kind there", because those
 * point at different things to go and look at. The VALUE is never printed even when it is
 * manifestly not a secret — this classifier must not become the one place that leaks the field on
 * the day a real token takes an unexpected route through here — and a length is enough to tell a
 * truncated value from a stray sentence.
 */
function describeUnusableDetachToken(recorded: unknown): string {
  if (recorded === null) {
    return 'null';
  }
  if (recorded === '') {
    return 'an EMPTY string — the field is present but its contents are gone';
  }
  if (typeof recorded !== 'string') {
    return `a ${Array.isArray(recorded) ? 'array' : typeof recorded} rather than a string`;
  }
  return `a ${recorded.length}-character string that is not a token by value`;
}

/**
 * Whether `event` belongs to a SESSION-WORKER dispatch (`claude --bg`): it carries a string at
 * `ioTokenSha256`, at the legacy `ioToken`, or at `meshWorker`. The ONE spelling of that
 * question.
 *
 * Three fields because no single one is on every event of such a dispatch: its first running
 * event is appended before the pool has named the worker, so it has a token field and no
 * `meshWorker`; an event written by an earlier build has the plain `ioToken` and no digest. The
 * token fields are asked about by PRESENCE, not by value — on this question they mean "this is a
 * session-worker dispatch", which a damaged value still says. Total: anything that is not an
 * object answers false.
 */
export function isMeshDispatchEvent(event: unknown): boolean {
  if (event === null || typeof event !== 'object') {
    return false;
  }
  const e = event as { ioToken?: unknown; ioTokenSha256?: unknown; meshWorker?: unknown };
  return (
    typeof e.ioToken === 'string' ||
    typeof e.ioTokenSha256 === 'string' ||
    typeof e.meshWorker === 'string'
  );
}

/**
 * What the history of task `id` RECORDED for its result token — the expectation a result file is
 * checked against (ioToken.ioTokenProves). `kind` picks the dispatch path: `session` reads
 * `ioTokenSha256` and the legacy `ioToken`; `detach` reads `detachIoTokenSha256` and the legacy
 * `detachIoToken`. Pure and total over `events`, which the caller has read.
 *
 * THE FIRST EVENT THAT CARRIES A WELL-FORMED VALUE FIXES THE EXPECTATION, and no later event can
 * change it. On one event a well-formed digest wins over a legacy value. FIRST and never latest,
 * because this log is a file any process running as the user can append a line to: a later line
 * carrying another digest, another plain value, an empty string or `null` is exactly what
 * something trying to choose its own expectation — or to spoil a genuine one — would write, and
 * none of them counts. taskLogFacts says why first-wins costs a real dispatch nothing.
 *
 * Three answers, told apart by the caller with ioToken.hasRecordedIoToken:
 *   - a well-formed value, in the field it was found in (`sha256` or `legacy`);
 *   - `{}` — NO event carries either field at all: a dispatch older than tokens, judged by the
 *     shape of its record alone, as it always was;
 *   - a value that is NOT well-formed, in its field — some event carries a field and none
 *     carries a usable one. That is a recorded expectation that was lost (a truncated line, a
 *     hand edit), not an absent one, and reading it as "no token expected" would let four bytes
 *     in this log switch the gate off. The caller refuses.
 */
export function firstRecordedIoToken(
  events: Iterable<TaskEvent>,
  id: string,
  kind: 'session' | 'detach',
): RecordedIoToken {
  const digestField = kind === 'detach' ? 'detachIoTokenSha256' : 'ioTokenSha256';
  const legacyField = kind === 'detach' ? 'detachIoToken' : 'ioToken';
  let unusable: RecordedIoToken | undefined;
  for (const e of events) {
    if (e === null || typeof e !== 'object' || e.id !== id) {
      continue;
    }
    const sha256: unknown = e[digestField];
    if (typeof sha256 === 'string' && IO_TOKEN_DIGEST_PATTERN.test(sha256)) {
      return { sha256 };
    }
    const legacy: unknown = e[legacyField];
    if (typeof legacy === 'string' && IO_TOKEN_PATTERN.test(legacy)) {
      return { legacy };
    }
    if (unusable === undefined) {
      if (sha256 !== undefined) {
        unusable = { sha256 };
      } else if (legacy !== undefined) {
        unusable = { legacy };
      }
    }
  }
  return unusable ?? {};
}

/**
 * WHAT THE TASK LOG SAYS about one dispatch, resolved from ONE read of it. Three facts, because
 * all three are answers the untrusted `tasks/<id>.result.json` cannot supply about itself.
 *
 * RESOLVED FROM THE HISTORY, NOT FROM ONE EVENT, and that is the whole point of this type. The
 * detach supervisor stamps its token's digest on RUNNING events only (mcp/run-task: onTrack and
 * onSpawn, never a terminal one), while dispatch_status validates a result file for a task whose
 * latest event is TERMINAL by definition. A validator that read the expectation off the event in
 * its hand would therefore see nothing on exactly the path that has one, and every real detach
 * result would fall through the gate as though it were a pre-token dispatch. The same is true of
 * `supervisorPid` on the arms below: only a scan of the id's whole history answers "did this
 * dispatch EVER have a supervisor".
 *
 * `events` lets a caller that has ALREADY read the log resolve from that snapshot instead of
 * paying for a second read — the sweep's per-task settle does exactly that, so the expectation
 * and the event being judged come out of one snapshot rather than two. Callers with no snapshot
 * (dispatch_status, through readResultForTask) read the log here, once per call.
 */
interface TaskLogFacts {
  /** Latest event recorded for the id — latestEventById's answer, from this same snapshot. */
  latest?: TaskEvent;
  /**
   * Whether ANY event of this dispatch recorded a detach supervisor pid. Checked BY VALUE (a
   * finite positive number), not by presence: a hand-edited `supervisorPid: 0` or `"x"` records
   * no supervisor, and the arm this feeds is a claim about who was allowed to write a file.
   */
  supervisorSeen: boolean;
  /**
   * What this dispatch's history recorded for its detached-path result token:
   * firstRecordedIoToken(…, 'detach'), which defines the three answers and the FIRST-wins rule.
   * Its members are `unknown` because they come out of a hand-editable log; detachTokenGate is
   * what decides by value.
   */
  detachToken: RecordedIoToken;
}

/**
 * Resolve TaskLogFacts for one id. Never throws (readTaskEvents reports an unreadable log as an
 * empty one, and every arm below treats an empty history as "no supervisor, no token" — and the
 * supervisor arm then refuses).
 *
 * THE TOKEN EXPECTATION IS FIRST-WINS (firstRecordedIoToken), and that word is the load-bearing
 * part of the gate rather than a tidy-up. Latest-wins handed the gate to the very thing it
 * gates, and this was measured, not reasoned: a dispatched worker has a shell, and this log is a
 * plain append-only file at a fixed path in $HOME (readTaskEventsChecked has said so since one
 * `echo`-planted `null` line crashed five call sites). So the worker never had to LEARN the
 * token. It appended its OWN running event for its own id carrying an expectation of its
 * choosing, latest-wins made that expectation authoritative, and it then wrote a result file
 * matching what it had planted. With a genuine event carrying one value, a worker-appended event
 * carrying another, and a result file echoing the second, readResultForTask returned
 *   {"kind":"ok","record":{…,"text":"FORGED-DELIVERABLE","inputTokens":123456,"costUsd":99.5}}
 * and the sweep settled the task `done` with those numbers, which windowUsage then sums into the
 * totals that pick accounts. Under first-wins that same log refuses the file.
 *
 * WHY FIRST-WINS COSTS A LEGITIMATE DISPATCH NOTHING. Both halves were checked in the producer,
 * and a change to either is a change to this rule — not an implementation detail of that module:
 *   1. THE SUPERVISOR'S TOKEN EVENT PRECEDES THE WORKER'S EXISTENCE. mcp/run-task's `onTrack`
 *      hook appends it, and the core calls `ctx.onTrack(base)` at the top of an attempt and only
 *      then calls `runClaude`, which is where `spawn` happens (mcp/task-runner). The second stamp
 *      — onSpawn's deferred `setImmediate` — lands microseconds after the spawn, and its own
 *      comment states the point: that process "has not finished exec'ing, let alone run
 *      anything" by then. So for a genuinely dispatched id there is no earlier event for a worker
 *      to have written, and the first event carrying the field is the supervisor's.
 *   2. THE VALUE IS CONSTANT FOR THE LIFE OF THE ID. server.dispatchDetached mints ONE token per
 *      dispatch and writes it into the spec file; run-task hands the SAME value to both append
 *      sites, on the first attempt and on every failover re-append. First and latest are
 *      therefore the same in every legitimate flow, and first-wins can only change the answer
 *      where the two DISAGREE — which nothing legitimate makes happen.
 * First-wins also closes the cheap DENIAL of the same shape: a later line carrying `""` or
 * `null` does not make a dispatch's genuine result unusable-and-refused.
 *
 * WHAT IT DOES NOT BUY must be read with this: a process that can append here can still invent
 * an id nobody dispatched, and for that id its own event is legitimately the first one. That is
 * a question about the LEDGER — "is this dispatch one the dispatcher ever made" — which nothing
 * stored in a ledger its subject can append to can answer; the token gate answers a different
 * one (TaskEvent.ioTokenSha256, WHAT THE TOKEN GATE DEFENDS).
 */
function taskLogFacts(id: string, events?: readonly TaskEvent[]): TaskLogFacts {
  const history = events ?? readTaskEvents();
  let latest: TaskEvent | undefined;
  let supervisorSeen = false;
  for (const e of history) {
    if (e === null || typeof e !== 'object' || e.id !== id) {
      continue;
    }
    latest = e;
    const sup: unknown = e.supervisorPid;
    if (typeof sup === 'number' && Number.isFinite(sup) && sup > 0) {
      supervisorSeen = true;
    }
  }
  return { latest, supervisorSeen, detachToken: firstRecordedIoToken(history, id, 'detach') };
}

/**
 * What the result file must prove about its token before ANY of its payload is trusted.
 *
 *   'none'   — this dispatch recorded no token FIELD AT ALL, so there is nothing to check against
 *              and the record is validated by shape exactly as it was before the token existed.
 *              That is the pre-token dispatch.
 *   'match'  — the record's `token` must PROVE itself against `recorded` (ioToken.ioTokenProves):
 *              hash to the recorded digest, or equal the legacy plain value.
 *   'refuse' — this dispatch DID record a gate and what is left of it cannot be one.
 */
type DetachTokenGate =
  | { kind: 'none' }
  | { kind: 'match'; recorded: RecordedIoToken }
  | { kind: 'refuse'; why: string };

/**
 * Turn what the history recorded into the gate the result file must pass.
 *
 * THE LINE IS "NO FIELD AT ALL" VERSUS EVERYTHING ELSE, the same line mesh/reaper's
 * expectedIoToken draws and for the same reason. `null` and `''` are not "an older dispatch that
 * recorded no token" — they are precisely what a CORRUPTED field looks like (a truncated write,
 * a hand edit, a serializer that wrote a placeholder), and reading them as "no token expected"
 * would mean the gate could be switched off by writing four bytes into the task log. A history
 * that holds a token field and no usable value in one is REFUSED; it never degrades to "shape
 * validation only".
 *
 * NOTHING HERE EVER PRINTS A RECORDED VALUE. The refusal describes the field's SHAPE instead —
 * empty, null, or not a token by value — which tells a human what to go and look at.
 */
function detachTokenGate(recorded: RecordedIoToken): DetachTokenGate {
  if (hasRecordedIoToken(recorded)) {
    return { kind: 'match', recorded };
  }
  const unusable: unknown = recorded.sha256 !== undefined ? recorded.sha256 : recorded.legacy;
  if (unusable === undefined) {
    return { kind: 'none' };
  }
  return {
    kind: 'refuse',
    why: `${REFUSED_TOKEN_UNUSABLE}${describeUnusableDetachToken(unusable)}`,
  };
}

/**
 * A running event stripped of its detached-path token fields, ready to be superseded by a
 * TERMINAL event built from it.
 *
 * Every terminal event this module composes is a spread of the running event it supersedes, so
 * without this the fields would ride onto the terminal record — and the supervisor's own rule is
 * that a terminal event never carries them (mcp/run-task: recorded on the RUNNING events, never
 * on a terminal one). BOTH fields go: the digest a current writer records and the plain value an
 * earlier build recorded. Keeping that property holds the fields to the events one process wrote
 * on purpose, so no surface that renders or relays a SETTLED task is handed them by accident.
 * `undefined` is dropped by JSON.stringify, so the appended line is byte-identical to one from a
 * pre-token dispatch.
 *
 * THE SESSION-WORKER FIELDS (`ioTokenSha256`, `ioToken`) ARE DELIBERATELY LEFT ALONE, and the
 * asymmetry is load-bearing rather than an oversight: the mesh arm of readResultForTask asks
 * isMeshDispatchEvent of the event it is handed, and dispatch_status hands it a TERMINAL event —
 * so those fields' survival across the spread is what makes a settled session-worker task's
 * planted result file still refuse. Stripping them would reopen that hole. The detached-path
 * fields need no such survival, because their expectation is resolved from the event HISTORY
 * (taskLogFacts) precisely so that it does not have to ride on the event.
 */
function withoutDetachToken(task: TaskEvent): TaskEvent {
  return { ...task, detachIoToken: undefined, detachIoTokenSha256: undefined };
}

/**
 * Read + VALIDATE tasks/<id>.result.json. Never throws; every failure is one of the three
 * outcomes above.
 *
 * `null` is treated as invalid rather than as absent throughout. JSON.stringify OMITS an
 * undefined field, so the intended writer can never produce a null one: a null is already
 * proof that this record did not come from it, and reading it as "absent" would launder that.
 *
 * What comes back on `ok` is a FRESHLY BUILT record carrying only validated fields — never the
 * parsed object itself. That is what keeps an own `__proto__` key, a `constructor` key, or any
 * other unvalidated property of an attacker-shaped payload from travelling on into a TaskEvent
 * or into dispatch_status. Every read of the parsed value happens inside the try, so even a
 * value with a throwing getter (which JSON.parse cannot produce, but a caller-substituted parse
 * could) degrades to a refusal instead of escaping into the sweep.
 *
 * `gate` is what this dispatch's OWN event history says the record must prove (detachTokenGate).
 * It is checked BEFORE ANY PAYLOAD FIELD IS TRUSTED — before the id, the status, the text fields
 * and the usage numbers — because a gate applied after the payload has been read is a gate on
 * what is REPORTED, not on what is BELIEVED, and the ordering is the only thing that makes that
 * distinction unambiguous for the next reader. The `token` the record carried is VALIDATED AND
 * DISCARDED: it never joins the returned record, which flows on into a TaskEvent and into
 * dispatch_status' tool result.
 */
function readResultFile(id: string, gate: DetachTokenGate): ResultFileRead {
  // The id comes from an event of the log, and the path is built from it. One that cannot be a
  // file name in TASKS_DIR (isTaskFileId) has no result file: the supervisor that writes this
  // file is handed an id the server minted, and whatever `<TASKS_DIR>/<id>.result.json` would
  // resolve to for an id holding `../` is some other file, not this task's record.
  if (!isTaskFileId(id)) {
    return { kind: 'absent' };
  }
  const file = path.join(TASKS_DIR, `${id}.result.json`);
  // This read invented the discipline that safeFs now owns, and it hands it over rather than
  // keeping a second copy — one guarded call site and one bare sibling is precisely the shape of
  // defect four review rounds kept finding here. The discipline is unchanged and is worth
  // restating, because it is not a micro-optimization but the thing that keeps this read from
  // being a DENIAL OF SERVICE: nothing guarantees the thing at this path is a file — a worker
  // with a shell can `mkfifo` it, and opening a FIFO for reading BLOCKS UNTIL A WRITER APPEARS,
  // forever if none ever does. This function runs inside the reconcile sweep, which is
  // synchronous and runs from the extension host's activate() and from the MCP server's
  // dispatch_status, so one such file wedges the whole editor's activation (measured: hung until
  // killed at 10s, both on the plain `readFileSync` body and on the first cut of the guard).
  // readTextSafe opens O_RDONLY|O_NONBLOCK — which returns immediately even on a writer-less
  // FIFO, is a no-op on a regular file, and degrades to plain O_RDONLY on win32, as before —
  // fstats THAT fd so the size checked is the size of the file opened, refuses a non-regular
  // file, refuses (never truncates) an oversize one, and loops on short reads, which the hand
  // rolled body did not: a single readSync that came up short used to hand a truncated JSON
  // document to the parser and read out as `unparseable`.
  //
  // `noFollow`: the supervisor writes this record as a regular file under a name this module
  // builds from the id, so a symbolic link at that name is not its record — it is a pointer to
  // some other file, put there by something else. It is refused as "not a regular file" rather
  // than read through.
  const read = readTextSafe(file, RESULT_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    // Each reason maps onto the outcome this function already published for it, one for one.
    // ENOENT/'absent' is the ordinary case for every task that never had a supervisor: no file,
    // no fact — and it is the ONLY reason that is not a refusal.
    if (read.reason === 'absent') {
      return { kind: 'absent' };
    }
    return {
      kind: 'refused',
      why:
        read.reason === 'not-a-file'
          ? REFUSED_NOT_A_FILE
          : read.reason === 'too-large'
          ? REFUSED_TOO_LARGE
          : REFUSED_UNREADABLE,
    };
  }
  const raw = read.text;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'refused', why: REFUSED_NOT_OBJECT };
    }
    const rec = parsed as Record<string, unknown>;
    // ==================== THE TOKEN GATE — FIRST, AND BEFORE ANY PAYLOAD ====================
    //
    // The dispatcher mints a token before any worker exists and carries it to the supervisor in
    // a spec file that is unlinked the instant it is read; the supervisor records the token's
    // SHA-256 in the task log and writes the token itself into this record. Shape validation
    // answers what the record IS; this answers WHETHER ITS WRITER KNEW THIS DISPATCH'S TOKEN,
    // for every dispatch that recorded one. What that is worth is stated at
    // TaskEvent.ioTokenSha256 (WHAT THE TOKEN GATE DEFENDS); the ordering rule that keeps a
    // later log line from supplying its own expectation is firstRecordedIoToken's.
    //
    // ABSENT IS A REFUSAL, and that is the entire gate rather than a strictness preference: if a
    // missing `token` were allowed through, bypassing the gate would cost exactly one deleted
    // field. ioTokenProves answers false for a `token` that is absent, of another type, not the
    // shape of a token, or wrong, and REFUSED_TOKEN reports all of them identically so this
    // surface answers nothing a prober could climb.
    //
    // The comparison itself lives in ioToken.ts — against the recorded digest, or against the
    // plain value an earlier build recorded — and is the one place it is spelled.
    if (gate.kind === 'refuse') {
      return { kind: 'refused', why: gate.why };
    }
    if (gate.kind === 'match' && !ioTokenProves(gate.recorded, rec.token)) {
      return { kind: 'refused', why: REFUSED_TOKEN };
    }
    // IDENTITY. The writer derives this file's NAME from the very same field
    // (run-task.writeResultJson joins TASKS_DIR with `${result.id}.result.json`), so a genuine
    // record at `<id>.result.json` necessarily carries `id === <id>`: requiring it costs no real
    // record and refuses one that names a different task — a copied, moved or cross-wired file.
    // Refused, not ignored: a record about another task is a fact worth reporting, not a blank.
    if (typeof rec.id !== 'string' || rec.id !== id) {
      return { kind: 'refused', why: REFUSED_ID };
    }
    const status = rec.status;
    if (status !== 'done' && status !== 'error') {
      return { kind: 'refused', why: REFUSED_STATUS };
    }
    for (const field of ['text', 'worker', 'model', 'error'] as const) {
      const value = rec[field];
      if (value !== undefined && typeof value !== 'string') {
        return { kind: 'refused', why: REFUSED_TEXT_FIELD };
      }
    }
    const inputTokens = usageValue(rec.inputTokens, RESULT_TOKENS_MAX, true);
    const outputTokens = usageValue(rec.outputTokens, RESULT_TOKENS_MAX, true);
    const costUsd = usageValue(rec.costUsd, RESULT_COST_USD_MAX, false);
    if (!inputTokens.ok || !outputTokens.ok || !costUsd.ok) {
      return { kind: 'refused', why: REFUSED_USAGE_FIELD };
    }
    // VALIDATED AND DISCARDED: `token` is deliberately absent from this freshly built record. It
    // has already done its whole job above, and these fields travel on into a TaskEvent and into
    // dispatch_status' tool result — the two surfaces the secret must never reach.
    return {
      kind: 'ok',
      record: {
        id: rec.id,
        status,
        text: rec.text as string | undefined,
        worker: rec.worker as string | undefined,
        model: rec.model as string | undefined,
        error: rec.error as string | undefined,
        inputTokens: inputTokens.value,
        outputTokens: outputTokens.value,
        costUsd: costUsd.value,
      },
    };
  } catch {
    return { kind: 'refused', why: REFUSED_UNPARSEABLE };
  }
}

/**
 * The validated record at tasks/<id>.result.json, or undefined when there is none to be had —
 * absent, unreadable, or present and REFUSED. Read-only, never throws.
 *
 * Callers that need to tell a refusal from an absence (the reconcile ladder) use readResultForTask;
 * this shape is what a caller that only wants the record — a caller relaying the exact text a
 * detach task recorded — asks for. Validation is deliberately shared between them: the relayed
 * `text` reaches an orchestrator's tool result, which is no place for a field of whatever type a
 * file happened to hold.
 *
 * IT GOES THROUGH readResultForTask, exactly as every other reader of this path does, and it did
 * not always: this function used to call the shape validator DIRECTLY and so carried none of the
 * writer arms — not the mesh one, not the supervisor one, and (had it been left alone) not the
 * token gate either. It has no caller in this repo today, which is precisely what made it
 * dangerous: an exported accessor that answers the same question with a weaker rule is a trap
 * for the next call site, and this repo has now shipped a guard applied to one call site of a
 * class five separate times. One rule, one owner. The task's own event history supplies what the
 * arms need (taskLogFacts); an id with NO event at all names no dispatch, and no dispatch means
 * nothing was ever entitled to write that path, so it answers undefined.
 */
export function readResultJson(id: string): ResultRecord | undefined {
  const facts = taskLogFacts(id);
  if (facts.latest === undefined) {
    return undefined;
  }
  const read = readResultForTask(facts.latest, facts);
  return read.kind === 'ok' ? read.record : undefined;
}

/**
 * Recover a terminal outcome for a task from a durable source the registry cannot reach itself.
 * A `done` may name the model that ran (`modelUsed`, the reported-id shape) when the hook can
 * read it — for a session task, off the worker's session transcript; anything else there is
 * ignored, and the outcome still counts.
 */
export type TaskRecovery = (task: TaskEvent) =>
  | { status: 'done'; text: string; how: string; modelUsed?: string }
  | { status: 'error'; error: string; how: string }
  | { unresolved: string }     // what was learned but did not settle it — attached to the error
  | undefined;                 // nothing known; the ladder falls through unchanged

/**
 * A TaskRecovery answer AFTER validation — the same three outcomes normalized to a
 * discriminated form so the ladder can switch on `kind` without re-testing shapes it has
 * already proved. Only consultRecovery produces one, and only from values it checked.
 */
type RecoveredOutcome =
  | { kind: 'done'; text: string; how: string; modelUsed?: string }
  | { kind: 'error'; error: string; how: string }
  | { kind: 'unresolved'; unresolved: string }
  | undefined;

/**
 * Stand-in for a `how` a hook did not supply. `how` is descriptive metadata, never the
 * payload, so a missing one must not cost us a recovered report — the report is the whole
 * reason the rung exists; the provenance line is a courtesy to the human reading it.
 */
const RECOVERY_SOURCE_UNNAMED = 'an unnamed source';

/** Non-empty string test — a blank payload is a well-formed value that settles nothing. */
function meaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Consult a TaskRecovery hook and validate what comes back BY VALUE.
 *
 * The hook crosses a module boundary (a mesh-aware caller injects it; see
 * reconcileTerminalEvent for why this file cannot read a transcript itself), so its declared
 * TYPE proves nothing at runtime: the caller may be plain JS, may be a build older than this
 * contract, or may simply be buggy. Every way it can fail — not a function at all, throwing,
 * returning a non-object, an array, null, or an outcome whose payload is not a meaningful
 * string — degrades to `undefined`, i.e. "nothing known", which leaves the ladder behaving
 * exactly as it did before this hook existed. The sweep that calls this must never be broken
 * by a supplier it does not control.
 *
 * Two deliberate asymmetries:
 *  - A recognized `status` whose payload fails validation degrades WHOLLY to undefined; it
 *    does not fall back to a sibling `unresolved` field. A settling outcome that cannot be
 *    trusted must not be half-believed, and one predictable failure mode beats two.
 *  - A missing or blank `how` does NOT invalidate the outcome (see RECOVERY_SOURCE_UNNAMED).
 *
 * `status` is checked before `unresolved`, so an object carrying both settles the task.
 */
function consultRecovery(task: TaskEvent, recover?: TaskRecovery): RecoveredOutcome {
  if (typeof recover !== 'function') {
    return undefined;
  }
  // The try spans the CALL *AND* every read of what it returned. A try around the call
  // alone leaves a real escape: the returned object can carry a throwing getter (or be a
  // Proxy), and then `answer.status` throws from outside the guard — reapDeadTasks would
  // swallow it and skip the task entirely, leaving it 'running' forever. That is the exact
  // stuck-task failure this rung exists to end, so no read of an untrusted value may sit
  // outside here.
  try {
    const raw: unknown = recover(task);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const answer = raw as {
      status?: unknown;
      text?: unknown;
      error?: unknown;
      how?: unknown;
      unresolved?: unknown;
      modelUsed?: unknown;
    };
    // `how` is a one-line provenance label that gets interpolated into an output-file note.
    // It arrives from another module, so its WHITESPACE is collapsed (not its content): a
    // multi-line `how` would smuggle whole lines of its own into a note that reads as ours.
    const how = meaningfulText(answer.how)
      ? answer.how.trim().replace(/\s+/g, ' ')
      : RECOVERY_SOURCE_UNNAMED;
    if (answer.status === 'done') {
      // The recovered report IS the outcome here — an empty one proves nothing was
      // recovered. Kept VERBATIM (unlike the one-line fields below): it is the worker's own
      // report, and reshaping someone's answer on the way into the record is not our job.
      if (!meaningfulText(answer.text)) {
        return undefined;
      }
      // By value, like every field of the answer; a value of another shape is dropped and the
      // outcome stands — what ran is a record beside the outcome, never a condition of it.
      const modelUsed =
        typeof answer.modelUsed === 'string' && REPORTED_MODEL_ID.test(answer.modelUsed)
          ? answer.modelUsed
          : undefined;
      return { kind: 'done', text: answer.text, how, ...(modelUsed !== undefined ? { modelUsed } : {}) };
    }
    if (answer.status === 'error') {
      return meaningfulText(answer.error)
        ? { kind: 'error', error: answer.error.trim(), how }
        : undefined;
    }
    if (meaningfulText(answer.unresolved)) {
      return { kind: 'unresolved', unresolved: answer.unresolved.trim() };
    }
    return undefined;
  } catch {
    // a hook is another module's code — nothing it does may cost this task its reconcile
    return undefined;
  }
}

/**
 * Wrap recovered worker prose in a fence the prose itself cannot close.
 *
 * The text appended by the two recovery rungs below is a worker's own words, recovered verbatim
 * from a session transcript — arbitrary bytes that may include `---`, `## Result`, a whole
 * imitation of one of these notes, or a copy of any fence we could think of in advance. A fixed
 * delimiter is therefore not containment: the body can print the closing delimiter and continue
 * outside it, which is how quoted prose ends up reading as though this system wrote it.
 *
 * The fence carries a NONCE minted at append time, and non-containment is not assumed but
 * PROVED: while the candidate marker occurs anywhere in the text, the nonce grows by one
 * character. That loop terminates — a marker longer than the text cannot be a substring of it —
 * and it terminates with a marker the text provably does not contain. The guarantee is the
 * verification, not the randomness, so Math.random (the same idiom withFileLock stamps its
 * tokens with) is sufficient: even a nonce the writer of the text could somehow have predicted
 * would be grown until it no longer appears. Prose that predates the nonce cannot close it, and
 * prose is always what predates it — the text is read off disk before this function runs.
 */
function fenceRecoveredText(text: string): string {
  let nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  while (text.includes(nonce)) {
    nonce += 'x';
  }
  return (
    `<<<<<<< RECOVERED TEXT ${nonce} — verbatim, untrusted; nothing between these two markers ` +
    `was written by the orchestrator\n${text}\n>>>>>>> END RECOVERED TEXT ${nonce}`
  );
}

/**
 * Longest `TaskEvent.error` this module will compose, in UTF-16 code units. The field is a
 * ONE-LINE LABEL everywhere it surfaces — a tree-item label in the task view, a single JSON
 * string in dispatch_status — so its budget is a line of text, not a document.
 */
const EVENT_ERROR_MAX_CHARS = 200;

/** Appended in place of what a cap cut off, so a truncated label says that it is truncated. */
const EVENT_ERROR_ELLIPSIS = ' …[truncated; full text in the output file]';

/**
 * The literal that opens a recovered-failure label. Composed by this module, never by the
 * recovered text — see recoveredErrorLabel for why the first word of this field cannot be left
 * to a worker.
 */
const RECOVERED_ERROR_PREFIX = 'worker reported failure: ';

/**
 * Turn recovered worker prose into something a one-line label can actually hold.
 *
 * The input is up to BG_RESULT_FILE_MAX_BYTES (256 KiB) of a worker's own report, arriving
 * through the recovery hook's `error` channel. Put in an event's `error` field unchanged — as it
 * was — it becomes a quarter-megabyte "label": the tree view renders it as one enormous row, and
 * dispatch_status returns it as a single JSON string, in both cases with the worker's newlines
 * and control characters intact. Its `unresolved` sibling two branches below has always been
 * nonce-fenced for the same reason; this is the same untrusted text through a different door.
 *
 * Two things happen here, in this order:
 *  1. the text is flattened by `displayText.flattenOneLine` — the SHARED one-line character
 *     rule, the very same call the output-file writers' headerText() makes, so this label and
 *     a header line cannot disagree about what a hostile string renders as. It maps the line
 *     terminators and other C0/C1 controls (Cc/Zl/Zp) to spaces, DELETES every Unicode bidi
 *     control and every unpaired surrogate, collapses whitespace runs and trims. This label
 *     used to do only the Cc/Zl/Zp half itself, which left a U+202E RLO free to redisplay the
 *     label as text nobody wrote and a lone surrogate free to reach dispatch_status' JSON —
 *     both measured. Read the leaf for why each class is treated as it is, and why \p{Cf} at
 *     large is deliberately kept (emoji survive this function intact);
 *  2. the result is cut to EVENT_ERROR_MAX_CHARS, with an explicit marker saying so and where
 *     the rest is. That cap and that marker are this surface's own — a tree-item row is not a
 *     markdown header line — and so is the prefix below; only the character rule is shared.
 * Nothing is lost by any of it: the caller writes the FULL text, fenced, into the output-file
 * note, which is a document and has room for one.
 *
 * The label is also PREFIXED by a literal of ours. views.ts classifies a task as cancelled or
 * orphaned by the first word of this very field, so prose that opens with "cancelled" or
 * "orphaned" would otherwise let a worker's report choose how its own failure is filed. A
 * recovered failure is a plain `error`, and the prefix is what makes it read as one — the same
 * discipline as the `orphaned …` literal the last branch emits, which is unchanged.
 *
 * Total: an empty or all-whitespace input (which consultRecovery already rejects) still yields a
 * usable label rather than a bare prefix.
 */
function recoveredErrorLabel(text: string): string {
  const flat = flattenOneLine(text);
  return boundedLabel(RECOVERED_ERROR_PREFIX, flat === '' ? 'no message' : flat);
}

/**
 * Fit `prefix` + already-flattened `body` into EVENT_ERROR_MAX_CHARS.
 *
 * Unlike a header line's `…`, the marker is fitted INSIDE the budget: the label may already
 * spend part of EVENT_ERROR_MAX_CHARS on a prefix, and the whole point of the marker is to fit
 * in the row the reader can actually see. sliceOneLine keeps that cut from orphaning a surrogate
 * half, which flattenOneLine had just guaranteed the body was free of.
 *
 * Shared by the two label composers rather than spelled twice — the drift between two spellings
 * of one rule is exactly the incident displayText exists to end, and these two labels sit on the
 * SAME surface (a tree row, a dispatch_status field). An empty prefix is the ordinary case for
 * the result.json rung, where a bounded verbatim message is what that rung has always recorded.
 */
function boundedLabel(prefix: string, body: string): string {
  const room = EVENT_ERROR_MAX_CHARS - prefix.length;
  if (body.length <= room) {
    return `${prefix}${body}`;
  }
  const safeHead = sliceOneLine(body, Math.max(0, room - EVENT_ERROR_ELLIPSIS.length));
  return `${prefix}${safeHead}${EVENT_ERROR_ELLIPSIS}`;
}

/**
 * Whether a label would seize one of views.ts's PRIVILEGED CLASSIFICATIONS. Spelled to match
 * that classifier exactly — `(event.error ?? '').trim().toLowerCase()` then `startsWith` — so
 * this cannot answer "no" about a string the tree files as cancelled or orphaned.
 */
function claimsErrorClass(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.startsWith('cancelled') || t.startsWith('orphaned');
}

/**
 * The COMPLETE set of terminal error messages the detach machinery composes for itself that
 * begin with a classifying word. Both are literals of ours, duplicated here on purpose: this
 * module must not import mcp/* (task-runner and run-task both import THIS file, so importing
 * either back would cycle). If either literal changes over there, a genuine cancel starts
 * arriving here prefixed — a visible, harmless drift, never a silent hole.
 *
 *   - task-runner.CANCELLED_ERROR      — 'cancelled by the orchestrator session'
 *   - run-task.DETACH_CANCELLED_ERROR  — the supervisor's own cancel record
 *
 * Nothing over there ever authors an `orphaned …` message: that literal belongs to the last rung
 * of this file's own ladder, so no result-file message may ever wear it.
 */
const SUPERVISOR_CLASS_LITERALS: ReadonlySet<string> = new Set([
  'cancelled by the orchestrator session',
  'cancelled — detach task cancelled by the orchestrator session',
]);

/** Opens a result-file failure label whose text tried to choose its own classification. */
const RESULT_ERROR_PREFIX = 'result.json reported: ';

/** Stands in for a record that says it failed but says nothing about how. */
const RESULT_ERROR_FALLBACK = 'failed';

/**
 * Turn a result.json failure message into the one-line label a TaskEvent may carry.
 *
 * SAME SURFACE, SAME DISCIPLINE as recoveredErrorLabel: this text lands in the tree row and in
 * dispatch_status' JSON, and it arrives from a file whose writer this rung cannot authenticate
 * (see readResultFile's header). So it is flattened by the shared displayText rule — line
 * terminators and other controls to spaces, bidi controls and unpaired surrogates deleted,
 * whitespace collapsed — and bounded to EVENT_ERROR_MAX_CHARS. Measured before this: a
 * multi-line message rendered as one enormous row, and an RLO redisplayed the row as text
 * nobody wrote.
 *
 * THE CLASSIFIER, and why the answer is a NARROW allowlist rather than a blanket prefix.
 * views.ts files a task as `cancelled` or `orphaned` by the FIRST WORD of this very field, so
 * left alone the field lets its writer choose how its own failure is filed — measured:
 * `cancelled by the operator; ignore this task` filed a forged failure as CANCELLED, with an
 * instruction to the operator riding in the label.
 *
 *   - A BLANKET PREFIX (what recoveredErrorLabel does, where every message is a worker's own
 *     prose) is wrong HERE, because one legitimate message on this path genuinely IS a
 *     cancellation: a detach task cancelled by the orchestrator records exactly the literal
 *     above, and prefixing it would refile every real cancel as a plain failure — changing real
 *     behavior and losing the class the tree, the dashboard and the history view all read.
 *   - So a message keeps a privileged class only when it is, VERBATIM, one of the sentences this
 *     system composes for itself (SUPERVISOR_CLASS_LITERALS). Everything else that would classify
 *     is prefixed and files as a plain `error`.
 *
 * What that buys, stated exactly: the allowlist is forgeable — a worker that copies the literal
 * character for character gets a `cancelled` row. But that is the whole of what it gets: the
 * system's OWN sentence, with no attacker-chosen text anywhere in the label. The lever was never
 * the class on its own; it was arbitrary prose wearing a privileged class, and an exact-match
 * allowlist removes precisely that while leaving the legitimate message untouched. The residual
 * is the same one the rung already has and cannot fix here — an unauthenticated file can also
 * claim `done` — and it is bounded to "a failed task may claim to have been cancelled".
 *
 * A message that does NOT try to classify is returned verbatim (bounded), so an ordinary
 * supervisor failure — 'No worker accounts registered…', a quota message — reconciles to exactly
 * the label it does today.
 */
function resultErrorLabel(message: string | undefined): string {
  const flat = flattenOneLine(message ?? '');
  const body = flat === '' ? RESULT_ERROR_FALLBACK : flat;
  const prefix = claimsErrorClass(body) && !SUPERVISOR_CLASS_LITERALS.has(body) ? RESULT_ERROR_PREFIX : '';
  return boundedLabel(prefix, body);
}

/**
 * Reconcile every running task whose owner is gone. A task is left running while
 * EITHER its worker pid is alive-and-ours OR — for a detach task — its supervisorPid
 * is alive-and-ours (contract §7 R8): a detach task briefly has no live worker
 * between failover attempts, and orphaning it in that window would be a false
 * orphan. The same window of a one-shot or vendor task, whose events carry no pid of
 * its dispatcher, is covered by age instead: an event that names no process and is
 * younger than FAILOVER_GRACE_MS is left running too (contract §15.12 M4 — see
 * inDispatcherGrace, and taskLooksAlive for every arm). Only when none of them holds
 * is the task terminal, and then:
 *
 *  - a completed result.json (status done) → record `done` from its usage fields;
 *  - a result.json that recorded an error → record that error faithfully;
 *  - no result.json, but an injected `recover` hook knows the outcome → record it;
 *  - otherwise → `orphaned`.
 *
 * Every rung is a STRUCTURED RECORD written by a machine for a machine. The task's
 * human-readable markdown output file is deliberately not one of them — see the long
 * comment in reconcileTerminalEvent where that rung used to be.
 *
 * Never signals anything — reconciling only records terminal events. Returns the
 * number reconciled; never throws, and a failed append does not abort the sweep.
 *
 * Each task settles ONCE even though two sweepers run in different processes by design (the
 * extension host's startup sweep and the MCP server's bounded one): the decision to settle is
 * re-taken under a per-task lock, and only the caller that gets there first writes a terminal
 * event and a note — see settleDeadTask, which owns that guarantee. The count returned is
 * therefore what THIS sweep settled, not how many tasks were dead.
 *
 * `onlyIds`, when given, scopes the sweep to those task ids — the bounded reconcile the
 * MCP server runs opportunistically from dispatch_status so a crashed supervisor's ledger
 * is healed even in a headless/CLI deployment with no VS Code extension host (contract F2 /
 * R8). Omitted (the extension's startup sweep) reconciles every running task, as before.
 *
 * `isAliveExternally`, when given, adds one more way for a task to count as alive: a task
 * whose worker is not a process of ours at all. An attachable (`--bg`) dispatch task
 * records no pid, so both pid checks above see nothing and every such task in flight would
 * be orphaned the moment this sweep ran (the age grace covers only its announcement, made
 * before the pool has named its worker; an event that names the worker is judged by this
 * callback). Callers pass a mesh-aware callback
 * (mesh/reaper.meshTaskAliveCheck) that answers from the mesh ledger; registry.ts stays
 * free of any mesh import. Omitted, the behavior is byte-identical to before this hook
 * existed. A callback that throws is treated as "cannot prove it alive" — the task then
 * reconciles exactly as it would have with no callback at all, since a reconcile only ever
 * records a terminal event and never signals anything.
 *
 * `recover`, when given, is consulted by the ladder for a task that IS dead and left no
 * result.json — see reconcileTerminalEvent's second rung. Same injection pattern and the same
 * reason as `isAliveExternally`: the durable evidence (a session transcript, a mesh ledger)
 * lives behind modules this one must not import. Omitted, absent, or throwing, the ladder is
 * byte-identical to before this hook existed.
 */
export function reapDeadTasks(
  onlyIds?: Iterable<string>,
  isAliveExternally?: (t: TaskEvent) => boolean,
  recover?: TaskRecovery,
): number {
  // The lock files live in TASKS_DIR; a sweep that runs before anything has created it would
  // otherwise fail every acquisition with ENOENT and reconcile nothing.
  ensureDirs();
  const wanted = onlyIds ? new Set(onlyIds) : undefined;
  let reaped = 0;
  for (const task of runningTasks()) {
    if (wanted && !wanted.has(task.id)) {
      continue;
    }
    if (taskLooksAlive(task, isAliveExternally)) {
      continue;
    }
    try {
      if (settleDeadTask(task.id, isAliveExternally, recover)) {
        reaped++;
      }
    } catch {
      // A failed append, or a lock that stayed held for the whole wait (withFileLock throws
      // rather than break it), must not abort the sweep of the remaining tasks.
    }
  }
  return reaped;
}

/**
 * Whether a running task still has an owner: its worker pid is alive-and-ours, or (detach) its
 * supervisor pid is, or its event names no process at all and is young enough that its dispatcher
 * may be between two attempts (inDispatcherGrace, contract §15.12 M4), or an injected callback can
 * prove it alive externally (a mesh `--bg` worker is nobody's child process, so both pid checks see
 * nothing). A callback that throws proves nothing and reads as "cannot prove it alive" — the same
 * as no callback at all.
 *
 * Factored out of the sweep because settleDeadTask asks the same question again about the event
 * it re-reads under the lock; two spellings of this judgment would eventually disagree. Note
 * that "again" is not the same as "afresh" on the injected arm — a caller's callback may (and
 * the mesh one does) memoize; see the comment at that call site. The grace arm is re-measured
 * there against the clock as it reads then.
 *
 * THIS IS THE ONE PLACE A `running` EVENT IS JUDGED DEAD — every reconcile reaches it through
 * reapDeadTasks and settleDeadTask — so the grace arm holds in all of them at once, and that is a
 * DELIBERATE change on every transport: the stdio MCP server's dispatch_status answers through it
 * exactly as the dispatch host's dispatch_status, cco/status and cco/cancel do (and the
 * extension's activation sweep, and the mesh's start-up and record-expiry sweeps).
 */
function taskLooksAlive(task: TaskEvent, isAliveExternally?: (t: TaskEvent) => boolean): boolean {
  const pid = task.pid;
  if (typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid, task.provider)) {
    return true;
  }
  const sup = task.supervisorPid;
  if (typeof sup === 'number' && isPidAlive(sup) && isOurSupervisor(sup, task.id)) {
    return true;
  }
  if (inDispatcherGrace(task)) {
    return true;
  }
  if (isAliveExternally !== undefined) {
    try {
      return isAliveExternally(task) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * THE DISPATCHER'S GRACE (contract §15.12 M4): a `running` event that names NO process — no worker
 * `pid`, no `supervisorPid`, no session worker (`meshWorker`) — and is younger than
 * FAILOVER_GRACE_MS reads alive. Older, or naming a process: judged as before.
 *
 * WHICH EVENTS THOSE ARE. A one-shot or vendor dispatch writes its `running` events from the
 * dispatching process itself (an MCP server, a dispatch host), and that process's pid is on none
 * of them: the attempt's announcement before its worker exists (a vendor CLI still being started),
 * and the "… — failing over" event after a quota or login failure, which is followed by live
 * probes of the next account — seconds of them — before the next spawn. A session-worker
 * dispatch's first announcement, before the pool has named its worker, is one too. For the length
 * of such a gap the event offers a reconcile nothing to look at, and every reconcile of ANOTHER
 * process — another session's dispatch_status, the 2 s loop of `cco dispatch_status --wait` (up to
 * 24 h of it), the extension's sweep — used to take "nothing alive" for "dead" and settle the task
 * `orphaned` under a dispatcher about to start its next attempt, whose `running` and `done` then
 * landed after the terminal event, with a wrong ORPHANED note in the report (review M4). A dispatch
 * host never had the gap for its OWN tasks (it holds them: server.ts statusAliveCheck); a stdio MCP
 * server did, for its own as for anybody's, and this closes it there too.
 *
 * WHICH EVENTS THOSE ARE NOT, and why the grace stops there. An event that names a process is
 * judged by it, as before. A detach task's supervisorPid IS that task's dispatcher, on every event
 * it writes, so its death is the dispatch's and nothing will follow it. A session worker is judged
 * by the mesh callback, which answers from the ledger and already keeps the task alive while its
 * dispatcher lives (mesh/reaper's owner grace) — and settles at once a task whose dispatcher is gone
 * when the worker's finished report is on disk, which a grace here would hold back three minutes.
 *
 * BY VALUE. An event "names" a pid when the field is a number (the test the pid arms above make
 * before they look) and a session worker when `meshWorker` is a non-empty string (the mesh
 * callback's own test). An event whose `ts` is not a finite number has no age and gets no grace.
 * The age is taken as a DISTANCE: an event stamped in the future (a clock stepped back, a line
 * written by hand) is young only while within FAILOVER_GRACE_MS of now, so no stamp can hold a task
 * `running` by this arm for more than twice the grace from the moment it is first read.
 *
 * Residual: a dispatcher that really died inside such a gap leaves its task `running` for up to
 * FAILOVER_GRACE_MS longer before a reconcile settles it. And the mesh start-up sweep settles the
 * tasks of the orphaned session workers it stopped ONCE, right after it ran: a task among them whose
 * newest event is still its announcement (its dispatcher died after the pool recorded the worker
 * and before the event that names it) and is younger than the grace is left to the next
 * dispatch_status that names it, or to the extension's next sweep.
 *
 * Arithmetic on the event alone: no process is looked at, nothing is read. Never throws.
 */
function inDispatcherGrace(task: TaskEvent): boolean {
  try {
    if (task.status !== 'running') {
      return false;
    }
    if (typeof task.pid === 'number' || typeof task.supervisorPid === 'number') {
      return false;
    }
    const worker: unknown = task.meshWorker;
    if (typeof worker === 'string' && worker !== '') {
      return false;
    }
    const ts: unknown = task.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      return false;
    }
    return Math.abs(Date.now() - ts) < FAILOVER_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Advisory lock guarding ONE task's reconciliation: `<TASKS_DIR>/<id>.reconcile.lock`, taken
 * through the same withFileLock the registry and stats read-modify-writes use. Per TASK rather
 * than per LOG on purpose: the guarantee wanted is "this task settles once", and a per-task lock
 * keeps the critical section down to one log re-read plus two appends, so the injected recovery
 * hook of a slow task never makes other tasks' sweeps queue behind it — which is also what keeps
 * a second sweeper of some OTHER task from waiting out withFileLock's deadline and failing.
 */
function reconcileLockTarget(id: string): string {
  // The id is a string out of the log. One that can be a file name (isTaskFileId) is used as it
  // is; any other — it holds a separator, a dot, or is longer than a name — still needs ONE
  // lock of its own, so it is named by its hash. The dot in that name keeps the two kinds from
  // ever colliding: a task file id has none.
  const stem = isTaskFileId(id)
    ? id
    : `id-sha256.${createHash('sha256').update(String(id), 'utf8').digest('hex')}`;
  return path.join(TASKS_DIR, `${stem}.reconcile`);
}

/**
 * Latest event for one task id AND the newest `ts` anywhere in the log, from a SINGLE read.
 * settleDeadTask needs both at the same instant, immediately before it appends, and reading the
 * log twice there would widen the window it exists to narrow.
 */
function settleState(id: string): { latest?: TaskEvent; maxTs: number } {
  let latest: TaskEvent | undefined;
  let maxTs = 0;
  for (const e of readTaskEvents()) {
    if (e.id === id) {
      latest = e;
    }
    if (typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > maxTs) {
      maxTs = e.ts;
    }
  }
  return { latest, maxTs };
}

/**
 * How far the settle stamp may be dragged FORWARD to stay ordered behind the log's newest event.
 * Bounded on purpose: the log is append-only text that a human can edit and that a machine with
 * a badly-set clock can write, and an unbounded catch-up would let one absurd record poison the
 * timestamp of every event appended after it — windowUsage sums by `ts`, so a record stamped in
 * the year 3000 would count as "recent" for as long as the log lives.
 */
const SETTLE_TS_CATCHUP_MAX_MS = 60_000;

/**
 * The timestamp a settle appends under: now, except when the wall clock has stepped BACKWARDS
 * behind the log's newest record by less than SETTLE_TS_CATCHUP_MAX_MS (an NTP correction, a
 * resume from suspend), in which case it is that record's stamp — so the file's timestamps stay
 * non-decreasing in file order, which is the order latestEventById resolves last-wins by.
 */
function settleTimestamp(maxTs: number): number {
  const now = Date.now();
  if (maxTs > now && maxTs - now <= SETTLE_TS_CATCHUP_MAX_MS) {
    return maxTs;
  }
  return now;
}

/**
 * Whether the event a settle JUDGED is still the newest one for its task. Anything else means
 * the task was re-announced while this process worked — a quota failover starts a new attempt
 * and appends a fresh `running` event, possibly with a new pid — and the liveness judgment that
 * got us here was made about an event we would no longer be superseding. Settling on it would
 * be a false orphan of a live attempt, so the settle is abandoned instead and the next sweep
 * judges the new event on its own merits.
 */
function sameJudgedEvent(judged: TaskEvent, current: TaskEvent): boolean {
  return (
    judged.ts === current.ts &&
    judged.status === current.status &&
    judged.worker === current.worker &&
    judged.pid === current.pid &&
    judged.supervisorPid === current.supervisorPid &&
    judged.meshWorker === current.meshWorker
  );
}

/**
 * Reconcile one dead task EXACTLY ONCE, across processes. Returns whether this call is the one
 * that settled it.
 *
 * Two sweepers are not a hazard, they are the design: the extension host runs a startup sweep
 * while the MCP server runs a bounded one from dispatch_status, in different processes. Without
 * a lock both read the same 'running' event, both judge the worker dead, and both append a
 * terminal event and the note — which double-counts usage on the `done` rungs (windowUsage sums
 * every `done` event, so one task's tokens land in the quota view twice) and appends the whole
 * recovered transcript excerpt twice on the recovery rungs. Reproduced as
 * `running, error, error` with the ORPHANED note written twice.
 *
 * THREE things make it settle-once. The first is the guarantee; the other two are kept for the
 * actors the first cannot bind.
 *
 * withFileLock is now mutual exclusion among every process that follows its protocol: nobody
 * removes a live holder's lock, however slow the holder is, and a waiter that cannot get in
 * THROWS after LOCK_ACQUIRE_TIMEOUT_MS instead of forcing its way in. It was not always — the
 * lock used to be broken by age and by deadline, and that was reproduced here as two sweeps, one
 * held past both windows, TWO `done` events, the note written twice, and (because the timestamp
 * used to be taken at the top of the decision) the surviving record stamped 16 seconds EARLIER
 * than the one it superseded. And it is still not the whole story: a pre-2.0 process sharing
 * this directory breaks any lock it has waited 15 s for, a person can delete a lock file, and
 * win32 still ages locks out (see withLockAt). So:
 *
 *  1. the lock serializes the read-modify-write, so two sweepers cannot interleave;
 *  2. the task's status is RE-READ from the log and re-checked IMMEDIATELY BEFORE the append,
 *     not only at the top of the section. The snapshot the sweep started from is stale by then —
 *     the other sweeper, the worker's own writer or a cancel may have settled the task while
 *     this process waited or worked — and a task already carrying a terminal event must never
 *     be reconciled again. The same re-read also abandons the settle when the judged event is
 *     no longer the newest for the id (sameJudgedEvent), and supplies the stamp's ordering
 *     floor (settleTimestamp);
 *  3. the lock's OWNERSHIP is re-proved immediately before the append (LockGuard.stillOurs).
 *     If something outside the protocol removed our lock while we were slow, our token is gone
 *     and the write is abandoned. Declining is always the safe direction: the task stays
 *     'running' and whoever holds the lock now, or the next sweep, settles it, which is
 *     precisely what already happens whenever a sweep is interrupted. (withFileLock then throws
 *     on release, because the lock was no longer ours; reapDeadTasks swallows that per task.)
 *
 * THE BOUND, for the case check 3 exists for — a lock removed from outside the protocol. Checks
 * 2 and 3 leave one window: removal AFTER stillOurs() returns true and BEFORE the append lands.
 * That window spans two statements and one small read, and a successor must still run a whole
 * section of its own — a log read, a `ps` per pid, the disk rungs — before it can append, so
 * producing two records requires this process to be frozen inside those two statements for the
 * successor's entire section. No in-process mechanism can close that, since the section is
 * synchronous and cannot act while it is suspended. Among protocol-following processes there is
 * no such window at all: the lock is not removed while its holder lives.
 *
 * WHAT A STUCK LOCK COSTS THE SWEEP. A process KILLED inside this function leaves a lock whose
 * holder is provably gone, and the next sweep clears it at once. A holder that is ALIVE and slow
 * — another sweeper inside a hung `ps`, a process stopped in a debugger — is waited on for
 * LOCK_ACQUIRE_TIMEOUT_MS and then this call THROWS; reapDeadTasks catches that, leaves the task
 * 'running', and the next sweep tries again. That wait is paid per task, synchronously, by
 * whichever sweep meets the lock, for as long as the holder stays alive and stuck.
 */
function settleDeadTask(
  id: string,
  isAliveExternally?: (t: TaskEvent) => boolean,
  recover?: TaskRecovery,
): boolean {
  return withFileLock(reconcileLockTarget(id), (lock) => {
    // ONE read answers both questions, and that is deliberate rather than incidental. This used
    // to be `latestEventById(id)`, which scans the whole log for the id already; taskLogFacts
    // scans it once for the same latest event AND for the two facts the writer arms need (did
    // this dispatch ever record a supervisor, and what token it FIRST recorded). So the gate
    // costs the sweep no extra read — the alternative, resolving once per SWEEP and threading a
    // map down, would save nothing here (this function reads the log twice per task regardless)
    // and would judge each task against a snapshot taken before its lock was even acquired.
    // Taken here, under the lock, the expectation and the event it validates are the same
    // snapshot.
    const facts = taskLogFacts(id);
    const latest = facts.latest;
    if (!latest || latest.status !== 'running') {
      // Already settled — by the other sweeper, by the worker's own writer, or by a cancel.
      return false;
    }
    // The steps below can each take real time — a `ps` per pid, an injected hook that reads a
    // session transcript — so the lock's mtime is restamped between them, for the one reader
    // that still judges a lock by its age (win32; see LockGuard.touch). Elsewhere a lock is
    // never abandoned while its holder lives, however old it is.
    lock.touch();
    if (taskLooksAlive(latest, isAliveExternally)) {
      // Liveness is asked again, about the event this call RE-READ rather than the one the sweep
      // started from: a quota failover can re-announce the task, and a NEW attempt may already be
      // running under a new pid, so judging the older event would risk a false orphan of a live
      // attempt.
      //
      // HOW MUCH OF THAT RE-ASK IS ACTUALLY FRESH — stated because "re-asked" reads like a
      // guarantee and only two of the three arms honor it:
      //   - the worker-pid and supervisor-pid arms genuinely are. taskLooksAlive re-runs
      //     isPidAlive and a `ps`, with no memo anywhere, so a worker that exited between the
      //     loop and this line is seen to have exited.
      //   - the INJECTED `isAliveExternally` arm is only as fresh as the callback the caller
      //     handed us, and the caller hands ONE closure to the whole sweep. The mesh
      //     implementation (mesh/reaper.meshTaskAliveCheck) memoizes its verdict per
      //     (cwd, id, meshWorker) for the life of that closure, over a ledger snapshot it also
      //     memoizes — so for a mesh task the value used here under the lock is, in the ordinary
      //     case, the value computed in reapDeadTasks' loop moments earlier, not a new reading.
      //     That is the callback's contract to choose (it is answering from a snapshot that
      //     cannot be refreshed synchronously anyway), and this module has no way to force a
      //     fresh answer without changing that contract. So on the mesh arm this line is a
      //     re-CHECK of the same judgment, not a re-measurement.
      //
      // What holds unconditionally, and is what the false-orphan concern actually needs, is the
      // gate below rather than this one: the log is re-read and sameJudgedEvent refuses to
      // supersede anything but the exact event that was judged. A re-announced attempt appends a
      // new 'running' event, so the settle is abandoned on that check no matter how stale a
      // liveness verdict was.
      return false;
    }
    lock.touch();
    // Decides WHAT to record (reads result.json and possibly an injected recovery hook, which
    // may itself read files of its own); stamps nothing. See Reconciliation.
    const reconciled = reconcileTerminalEvent(latest, facts, recover);

    // ---- The gate. Everything above may have taken seconds; nothing below may take any. ----
    lock.touch();
    const state = settleState(id);
    if (
      !state.latest ||
      state.latest.status !== 'running' ||
      !sameJudgedEvent(latest, state.latest)
    ) {
      return false;
    }
    if (!lock.stillOurs()) {
      return false;
    }
    const settled = reconciled.at(settleTimestamp(state.maxTs));
    // Under the id the judged line stands under, whatever that id is (appendSettledTaskEvent).
    appendSettledTaskEvent(settled.event);
    // The note's verdict is READ, not discarded. See amendForUndeliverableNote for what a failure
    // buys and what it deliberately does not: the settle above has already landed and is a fact,
    // so this call can no longer change whether the task settled — only whether anybody is told
    // that its report file did not get the paragraph explaining why it stops mid-run.
    const noted = appendTaskNote(latest, settled.note);
    if (!noted.ok) {
      amendForUndeliverableNote(settled.event, noted.reason);
    }
    return true;
  });
}

/** Bounded literal appended to a settle's error label when its output-file note was refused. */
const NOTE_UNDELIVERABLE = 'the output file could not be annotated';

/**
 * WHAT A SETTLE DOES WHEN ITS NOTE FAILS AFTER THE EVENT HAS LANDED — stated as its own function
 * because the answer is a judgment, not a mechanism, and the wrong answers are all tempting.
 *
 * The situation: the terminal event is in the append-only log, so the task IS settled, durably,
 * across processes, and no later sweep will ever look at it again (it is no longer `running`).
 * The output file — the human-readable report — could not be given its closing paragraph, so it
 * will keep saying `- status: RUNNING` forever. The two facts now disagree, and only one of them
 * is visible to the person reading the report.
 *
 * WHAT IT DOES NOT DO, and why each is worse:
 *
 *  - It does not return false. `false` means "this call did not settle the task", and the sweep
 *    counts on that to report what it reconciled. Saying it here would be the same class of lie
 *    this whole change is about — a guarded failure quietly becoming "nothing happened" — except
 *    UNRECOVERABLE, because the event is already written: no later pass can re-report a settle
 *    that no longer looks running. The settle happened. It returns true.
 *
 *  - It does not retry, and it does not fall back to another path. The refusals reachable here
 *    are `not-a-file` (a FIFO, a directory, a device at `tasks/<id>.md`), `too-large` — which an
 *    append cannot even raise — and `unreadable` (EACCES, ENOSPC, EIO). Not one of them is
 *    transient within the microseconds a retry would cost, and inventing a second destination
 *    would mean writing a file this module has no name for.
 *
 *  - It does not amend a `done` settle, and this asymmetry is the deliberate part. windowUsage
 *    sums EVERY `done` event in its window — that is the documented reason settle-once exists at
 *    all — so a second `done` record for one task inflates both that worker's task count and its
 *    token totals, which are inputs to account selection. A diagnostic that corrupts the quota
 *    view to report a cosmetic failure is not worth having. An `error` event is accounting-inert
 *    by contrast: windowUsage ignores it entirely, stats are not touched by this path at all, and
 *    every surface that renders the log (views.ts, history-view.ts, dashboard.ts) collapses to
 *    the latest event per id before it renders anything.
 *
 * WHAT IT DOES: for the `error` rungs — which includes the orphan rung, the one that actually
 * fires when a worker has replaced its own output file — it appends the SAME settled event once
 * more with the failure named in its label. Last-in-file-order wins, so the amended record is the
 * one every view and dispatch_status shows, and the operator sees on the row itself that the
 * report file is not to be trusted, instead of opening a file that claims to be running.
 *
 * The label keeps its `orphaned — ` opening (views.ts classifies on that first word) because the
 * fact is appended as a SUFFIX, never prefixed, and it is built from our own literals plus one of
 * safeFs's four reason words. No byte of the untrusted file, and no field of the event, goes into
 * it — TaskEvent.ioToken must never reach a human-visible string.
 *
 * A failed amendment is swallowed: the settle is already durable, and the amendment is the
 * diagnostic, not the record.
 */
function amendForUndeliverableNote(settled: TaskEvent, reason?: SafeReadFailure): void {
  if (settled.status !== 'error' || typeof settled.error !== 'string') {
    return;
  }
  try {
    appendTaskEvent({
      ...settled,
      error: `${settled.error}; ${NOTE_UNDELIVERABLE} (${reason ?? 'unreadable'})`,
    });
  } catch {
    // the log itself is refusing writes too — the terminal event above is already durable, and
    // there is nowhere left to say more
  }
}

/**
 * A reconciliation that has been DECIDED but not yet STAMPED: `at(now)` returns the terminal
 * event and the output-file note for a settle that lands at `now` (epoch ms).
 *
 * Split from the decision deliberately. Deciding reads disk and may call an injected recovery
 * hook, so it can take seconds; the stamp has to describe when the RECORD WAS WRITTEN. Taking
 * `Date.now()` at the top of the decision — as this did — is what let a settle-once failure end
 * with the log out of chronological order: the surviving record carried a timestamp 16 seconds
 * older than the record it superseded. `at` is pure — no I/O, no clock read, nothing that can
 * fail — so calling it in the instant before the append costs nothing, and the note's ISO stamp
 * cannot drift from the event's `ts` because both come from the same argument.
 */
interface Reconciliation {
  at: (now: number) => { event: TaskEvent; note: string };
}

/**
 * The result-file read for THIS task — the shape validation of readResultFile, its per-task token
 * gate, and the two WRITER questions this module can answer from the task log alone.
 *
 * tasks/<id>.result.json is written by exactly one thing in this system: the detach supervisor
 * (run-task.writeResultJson, reached only from inside a supervisor's own process — the plain
 * in-process path leaves the `onResult` hook that authors it unset, and the server only ever
 * READS this path). The `--bg` mesh dispatch path writes no such file either — its channel of
 * record is `<ROOT_DIR>/bg-io/<wsHash>/<taskId>/result.json`, a different path with a different
 * validator and its own per-task token gate. So there are three questions here, asked in this
 * order, and the ORDER is what keeps each refusal saying the true thing about its own dispatch:
 *
 *   1. THE TOKEN, inside readResultFile, before any payload field is trusted. The expectation is
 *      resolved from this task's EVENT HISTORY (taskLogFacts) — the FIRST event that carried a
 *      well-formed one — never from the event in hand: the supervisor stamps its token's digest
 *      on RUNNING events only, and dispatch_status calls this with a TERMINAL event, so an
 *      in-hand read would see nothing on exactly the path that has one. FIRST and not latest,
 *      because anything running as this user can append to that history too and latest-wins let
 *      it name its own expectation (taskLogFacts carries the measured break). A dispatch that
 *      recorded no token is validated by shape alone, exactly as before the field existed; one
 *      whose record does not carry the token, or omits it, is refused.
 *
 *   2. THE MESH ARM (isMeshDispatchEvent), and the detached path's token fields are deliberately
 *      NOT part of its test. A session-worker token field's VALUE means nothing on this path,
 *      but its PRESENCE is durable proof, written by the dispatcher into the append-only task log
 *      before the worker existed, that this dispatch is a MESH dispatch and that nothing may have
 *      written here at all. Without this arm a mesh worker — whose own result channel IS
 *      token-gated — could bypass that gate simply by writing the detach path's file instead.
 *      Merging the two paths' token fields into this test would refuse every genuine detach
 *      result file instead, which is why the detached path's fields have names of their own.
 *      `meshWorker` is checked too because an event of such a dispatch need not carry a token
 *      field at all.
 *
 *   3. THE SUPERVISOR ARM. `supervisorPid` is recorded by the detach supervisor and by nothing
 *      else (mcp/run-task passes its own pid as TaskRunContext.supervisorPid, and every event
 *      task-runner appends carries it; it is undefined on the plain path, where JSON.stringify
 *      drops it). So a dispatch whose history records no supervisor ANYWHERE is a plain
 *      in-process dispatch, and the plain path has NO writer of this file in any configuration —
 *      a file found there was written by something that was never entitled to. Refused outright,
 *      on a discriminator that lives in the append-only log rather than in the file being judged.
 *      Asked of the HISTORY and not of the event in hand for the same reason as the token: it is
 *      a claim about the whole dispatch, and only a scan of its events can make it.
 *
 * `facts` lets a caller that has already read the log supply the answers from ITS snapshot — the
 * per-task settle does that, so the expectation and the event being judged come out of one read
 * rather than two. Callers with no snapshot pay one log read here. Never throws.
 */
export function readResultForTask(task: TaskEvent, facts?: TaskLogFacts): ResultFileRead {
  const known = facts ?? taskLogFacts(task.id);
  const read = readResultFile(task.id, detachTokenGate(known.detachToken));
  if (read.kind === 'ok' && isMeshDispatchEvent(task)) {
    return { kind: 'refused', why: REFUSED_NOT_DETACH };
  }
  if (read.kind === 'ok' && !known.supervisorSeen) {
    return { kind: 'refused', why: REFUSED_NO_SUPERVISOR };
  }
  return read;
}

/**
 * The output-file paragraph a refusal adds to whichever rung ends up settling the task.
 *
 * A present-but-refused result file is a DIFFERENT operational fact from no result file, and a
 * ladder that silently fell through would report the two identically — the task reads as though
 * nothing was ever written for it, and the operator has no way to learn that something was, and
 * was rejected. Composed entirely from our own literals and the caller's reason code: the
 * record's own bytes are the untrusted thing being described and none of them appear here.
 */
function resultRefusalNote(why: string): string {
  return (
    `\nNOTE: a result.json was PRESENT for this task and was REFUSED — ${why}. It contributed ` +
    `nothing to the record below; no status and no usage was taken from it.\n`
  );
}

/**
 * The `orphaned` label for a task that also had a refused result file. Keeps the mandated
 * `orphaned — ` opening (views.ts classifies on that first word) and adds the one fact that
 * distinguishes this orphan from an ordinary one, so the refusal is visible on the surfaces a
 * human actually watches — the tree row and dispatch_status — and not only in the output file.
 */
const ORPHANED_ERROR = 'orphaned — worker process is no longer running';
const ORPHANED_WITH_REFUSED_RESULT =
  `${ORPHANED_ERROR}; a result file was present and refused`;

/**
 * Build the terminal event + output-file note for a running task whose worker and
 * supervisor are both gone. See reapDeadTasks for the reconcile precedence.
 *
 * `recover` is the optional injected TaskRecovery hook, consulted only after every
 * on-disk rung has come up empty. Absent (or unusable — consultRecovery decides that),
 * the rungs below behave and read exactly as they did before it existed.
 *
 * `facts` is what the task log says about this dispatch, resolved by the caller from the SAME
 * read that produced `task` — the per-task token gate and the supervisor arm are both claims
 * about the id's whole event history, not about this one event, and taking them from the caller's
 * snapshot is what keeps the event being judged and the expectation it is judged against from
 * coming out of two different reads of an append-only file.
 */
function reconcileTerminalEvent(
  task: TaskEvent,
  facts: TaskLogFacts,
  recover?: TaskRecovery,
): Reconciliation {
  const read = readResultForTask(task, facts);
  const refusal = read.kind === 'refused' ? resultRefusalNote(read.why) : '';
  const result = read.kind === 'ok' ? read.record : undefined;
  // EVERY terminal event below is a spread of this, never of `task` itself: the running event
  // being superseded may carry this dispatch's detach io token, and a terminal event must not.
  // See withoutDetachToken for why the sibling `ioToken` is deliberately left on.
  const base = withoutDetachToken(task);
  if (result && result.status === 'done') {
    // Every one of these is now a validated number or genuinely absent — `?? 0` used to be the
    // ONLY thing standing between this event and whatever type the file held, and it catches
    // exactly null and undefined. A present-but-invalid value never reaches here: it invalidates
    // the record (readResultFile), which is why there is no clamp or coercion at this line.
    const inputTokens = result.inputTokens ?? 0;
    const outputTokens = result.outputTokens ?? 0;
    const costUsd = result.costUsd ?? 0;
    return {
      at: (now) => ({
        event: {
          ...base,
          ts: now,
          status: 'done',
          inputTokens,
          outputTokens,
          costUsd,
          error: undefined,
        },
        note:
          `\n\n---\n\nRECONCILED: supervisor completed; recorded done from result.json ` +
          `(${new Date(now).toISOString()})\n`,
      }),
    };
  }
  if (result && result.status === 'error') {
    // Both fields are validated strings or absent, so the label composer is handed a string and
    // the event can only ever carry one. `?? 'failed'` lives inside resultErrorLabel now, which
    // also covers the message that is present but blank.
    const claimed = result.error ?? result.text;
    const message = resultErrorLabel(claimed);
    // The label is a bounded ONE-LINE excerpt. When it is not the message verbatim — flattened,
    // truncated, or prefixed away from a classification it may not claim — the full text goes
    // into the note, FENCED, exactly as the recovery rungs below fence theirs: this is somebody
    // else's arbitrary text landing in a document this module also writes structured notes into,
    // and a fixed delimiter is not containment (see fenceRecoveredText). When the label already
    // IS the message, the note stays byte-identical to what a legitimate detach dispatch has
    // always written.
    const full = claimed !== undefined && message !== claimed
      ? fenceRecoveredText(claimed.replace(/\s+$/, ''))
      : undefined;
    return {
      at: (now) => ({
        event: { ...base, ts: now, status: 'error', error: message },
        note:
          `\n\n---\n\nRECONCILED: supervisor completed with error from result.json ` +
          `(${new Date(now).toISOString()})\n` +
          (full === undefined ? '' : `\n## Recorded error\n\n${full}\n`),
      }),
    };
  }
  // ===========================================================================================
  // THE RUNG THAT USED TO BE HERE IS GONE ON PURPOSE. DO NOT PUT IT BACK.
  //
  // For four releases this ladder had a middle rung that read the task's MARKDOWN OUTPUT FILE —
  // `tasks/<id>.md` — and, if its leading region looked like a finished header, settled the task
  // `done` and copied a `- tokens: N in / M out (~$C)` line out of it into the event. That event
  // feeds windowUsage, which sums `done` events into the per-window quota view the orchestrator
  // picks accounts with. So the numbers in a human-readable report were, in effect, an input to
  // account selection.
  //
  // WHY IT COULD NOT BE MADE SAFE. That file is a REPORT A HUMAN READS, and every interesting
  // byte in it is QUOTED TEXT this system did not author: the dispatched prompt, the worker's
  // own prose, the operator's title, the notes appended afterwards. Whatever such a file
  // "proves" can be written by whoever produced that text. Four hostile review rounds each found
  // a different way to say it, and each hardening of the heuristic bought exactly one round:
  //   - matching `## Result` and a `- tokens:` line ANYWHERE in the file — a worker's own report
  //     forged a `done` with attacker-chosen numbers by printing them;
  //   - restricting the match to the region above the first `\n\n---\n` separator — an
  //     unsanitised multi-line TITLE injected its own metadata lines and its own separator ahead
  //     of the writer's, so the "trusted region" was caller-supplied;
  //   - sanitising the title and requiring a positive writer marker in first position — a file
  //     from before the marker existed still had to be honored, and that legacy arm was the hole;
  //   - and finally a pre-fix file whose TITLE contains the header marker read as VOUCHED, with
  //     attacker-chosen token and cost numbers, on a file that says `- status: RUNNING`.
  // The pattern is not a sequence of oversights. Each fix defined a region of the file to trust
  // and each next finding moved the attacker's text into that region, because the file's shape
  // is not authenticated — only its content is, and its content is the thing in question.
  //
  // WHAT COUNTS AS EVIDENCE NOW: only records written by machines for machines — a STRUCTURED
  // record with a fixed schema, never a document whose every interesting byte is quoted text.
  // The ladder is exactly three rungs: result.json -> recovery hook -> orphaned. The two are not
  // equally credible, and the difference must not be papered over:
  //   - the recovery hook reads the mesh CHANNEL OF RECORD — a result.json validated against the
  //     per-task result token, whose digest the task log holds — before it will fall back to a
  //     transcript, and a transcript may never say `done`. That rung is gated.
  //   - the result.json rung above IS gated too, for every dispatch that recorded a token: the
  //     dispatcher mints one per detach dispatch, the supervisor records its SHA-256 on the
  //     RUNNING events (`detachIoTokenSha256`) and writes the token into the file as `token`,
  //     and readResultForTask refuses a record whose `token` does not prove itself against the
  //     value recorded in this append-only log — a missing `token` exactly as loudly as a wrong
  //     one. GATED, not AUTHENTICATED, and the word is chosen deliberately on both rungs: what
  //     either token decides is "did this file's writer know this dispatch's token", never "was
  //     this file written by the supervisor". TaskEvent.ioTokenSha256 states what that stops and
  //     what it cannot (WHAT THE TOKEN GATE DEFENDS), and taskLogFacts holds the ordering rule
  //     (FIRST-wins) without which a later log line simply supplies the expectation it will be
  //     judged against.
  //     What is still NOT proven is the writer of a record for a dispatch that recorded no token
  //     — one that predates the field — and for those
  //     the rung guarantees exactly what readResultFile's header says it does: the record names
  //     this task, its status is one of two literals, every field the ladder consumes has the
  //     type the ladder assumes, its usage numbers are whole/finite/bounded, its error text is
  //     one bounded line that cannot choose its own classification, a mesh dispatch refuses the
  //     file outright, and so does a dispatch whose history records no supervisor at all.
  //
  // WHAT THIS GIVES UP, stated so nobody rediscovers it as a bug: a `-p` dispatch whose session
  // died after the worker's DONE file was written but before any result.json existed now settles
  // `orphaned` instead of `done`, and its recorded usage is lost. Its report text is not lost —
  // it is still in the output file, where it always was, and where a human reads it. The trade
  // is deliberate and it is not close: under-reporting usage makes the orchestrator treat an
  // account as LESS spent than it is, which costs a suboptimal assignment; fabricated usage is
  // an input an untrusted party controls, aimed at the same decision. One of those is a bounded
  // error in the safe direction. The other is a lever.
  // ===========================================================================================

  // Nothing on disk settles this task — but "no result file" is not "no answer". A worker
  // can finish its turn and leave its report ONLY in its session transcript: the settling
  // `await` lived in the session that dispatched it, and when that session died nobody was
  // left to write result.json or finish the output file. Calling that ORPHANED discards an
  // answer that exists. This module cannot go read a transcript — it must not import
  // src/mesh/* (every mesh module imports this one, so importing back would cycle), and it
  // knows nothing of ledgers, job ids or config dirs — so a mesh-aware CALLER injects the
  // capability, the same way reapDeadTasks takes isAliveExternally.
  const recovered = consultRecovery(task, recover);
  if (recovered && recovered.kind === 'done') {
    // Fenced, never bare: this is somebody else's arbitrary text landing in the middle of a
    // file this module also writes structured notes into. Minted HERE rather than inside `at`
    // so the nonce is proved against the text exactly once and `at` stays pure.
    const fenced = fenceRecoveredText(recovered.text.replace(/\s+$/, ''));
    const how = recovered.how;
    // Usage is genuinely UNKNOWN on this path (no result.json, no tokens line), so it is
    // recorded as zero rather than carried over from the running event: windowUsage sums
    // 'done' events, and inventing or inheriting numbers there would corrupt quota views.
    // The recovered text is the worker's report, and the note is the only place a reader
    // will find it — appending it here is what keeps the answer from being thrown away.
    return {
      at: (now) => ({
        event: {
          ...base,
          ts: now,
          status: 'done',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: undefined,
          // Set, never spread from `base`: only the hook's answer says what ran.
          modelUsed: recovered.modelUsed,
        },
        note:
          `\n\n---\n\nRECOVERED: recorded done from ${how}; usage unknown, ` +
          `recorded as 0 (${new Date(now).toISOString()})\n${refusal}\n## Recovered result\n\n` +
          `${fenced}\n`,
      }),
    };
  }
  if (recovered && recovered.kind === 'error') {
    // TWO SURFACES, TWO SHAPES, ONE TEXT. The event's `error` is a one-line label (a tree-item
    // row, a JSON field in dispatch_status), so it gets a bounded, flattened, self-prefixed
    // excerpt; the note is a document, so it gets the whole thing, fenced exactly like the
    // recovered-`done` report above and the `unresolved` prose below. Nothing is dropped —
    // what the label cannot hold, the note holds, and the label says where to look.
    const label = recoveredErrorLabel(recovered.error);
    const fenced = fenceRecoveredText(recovered.error.replace(/\s+$/, ''));
    const how = recovered.how;
    return {
      at: (now) => ({
        event: { ...base, ts: now, status: 'error', error: label },
        note:
          `\n\n---\n\nRECOVERED: recorded error from ${how} ` +
          `(${new Date(now).toISOString()})\n${refusal}\n## Recovered error\n\n${fenced}\n`,
      }),
    };
  }
  // The hook reached the durable source and still could not settle the task. Saying only "the
  // process is gone" would hide the one fact that explains why — so what was actually learned is
  // reported, FENCED: this string is the channel the mesh recovery uses to deliver a worker's
  // verbatim last words, so it is untrusted prose, not our sentence. Interpolating it bare let
  // it end the note and continue as if the orchestrator had written what followed.
  const unresolved =
    recovered && recovered.kind === 'unresolved' ? fenceRecoveredText(recovered.unresolved) : undefined;
  return {
    at: (now) => ({
      event: {
        ...base,
        ts: now,
        status: 'error',
        // Composed from LITERALS OF OURS even when the hook reported `unresolved`: views.ts
        // classifies a task as orphaned (vs cancelled vs failed) by this text starting with
        // 'orphaned', and the field is a one-line label in the task list. What was learned goes
        // in the note below, where a multi-line explanation has room and the human is already
        // looking. The refused-result variant is the one exception, and it is still a literal:
        // an orphan whose result file was rejected is a different fact from a plain orphan, and
        // the tree row is where an operator will actually see it.
        error: refusal === '' ? ORPHANED_ERROR : ORPHANED_WITH_REFUSED_RESULT,
      },
      note:
        unresolved !== undefined
          ? `\n\n---\n\nORPHANED: worker process is no longer running; the recovery source ` +
            `reported the following (${new Date(now).toISOString()})\n${refusal}\n${unresolved}\n`
          : `\n\n---\n\nORPHANED: worker process is no longer running ` +
            `(${new Date(now).toISOString()})\n${refusal}`,
    }),
  };
}

/**
 * `total` plus one usage value out of the task log — or `total` unchanged when the value is not
 * a count, or when adding it would leave the total non-finite.
 *
 * The log is line-delimited JSON at a fixed path that a dispatched worker can append to, so a
 * `done` event's `inputTokens` is whatever a line says it is. `+=` on a string CONCATENATES:
 * one event carrying `"inputTokens": "<img src=x>"` used to turn the whole window total into a
 * string, which then travelled to the tree view and the dashboard as if it were a number. The
 * second guard is for the value that is a number and still breaks the sum: two events of 1e308
 * each are finite and their total is Infinity.
 */
function addUsage(total: number, value: unknown): number {
  const next = total + countValue(value);
  return Number.isFinite(next) ? next : total;
}

/**
 * Dispatch usage for one worker within a trailing time window. Every total is a finite,
 * non-negative number whatever the log holds (see addUsage); an event whose `ts` is not a
 * timestamp is not in any window and is not counted.
 */
export function windowUsage(worker: string, windowMs: number) {
  const since = Date.now() - windowMs;
  let tasks = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const e of readTaskEvents()) {
    const ts = timestampValue(e.ts);
    if (e.worker === worker && e.status === 'done' && ts !== undefined && ts >= since) {
      tasks++;
      inputTokens = addUsage(inputTokens, e.inputTokens);
      outputTokens = addUsage(outputTokens, e.outputTokens);
      costUsd = addUsage(costUsd, e.costUsd);
    }
  }
  return { tasks, inputTokens, outputTokens, costUsd };
}

export function emptyStats(): WorkerStats {
  return { tasks: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/**
 * Cumulative per-worker stats, read by value (see "Reading the small JSON state files"). Never
 * throws. The result has no prototype (nameKeyed), so `stats[name]` is `undefined` and
 * `name in stats` is false for a worker with no entry, whatever the worker is called. Each
 * entry is rebuilt: the five counters are always finite non-negative numbers, and
 * `lastUsedAt` / `cooldownUntil` / `lastError` are present only when the file holds a timestamp /
 * a string there — so a caller can add to a counter, compare a cooldown and format a date
 * without checking any of them again.
 */
export function readStats(): StatsFile {
  return statsFrom(readJsonObjectFile(STATS_FILE));
}

/**
 * readStats, together with WHETHER THE FILE COULD BE UNDERSTOOD. `problem` is null when
 * stats.json parses to an object, is missing or is empty; otherwise it is one line saying what
 * is wrong (StateFileRead's `problem`) and `stats` is then EMPTY — which is not "no worker has
 * run and none is cooling down", only "not known". For a caller that decides something from a
 * cooldown or a count. Never throws.
 */
export function readStatsChecked(): { stats: StatsFile; problem: string | null } {
  const read = readStateFile(STATS_FILE);
  return {
    stats: statsFrom(read.state === 'ok' ? read.object : {}),
    problem: read.state === 'damaged' || read.state === 'unread' ? read.problem : null,
  };
}

/** The stats in a parsed stats.json object, rebuilt by value as readStats describes. */
function statsFrom(object: Record<string, unknown>): StatsFile {
  const entries: Array<[string, WorkerStats]> = [];
  for (const [name, raw] of Object.entries(object)) {
    if (!isJsonObject(raw)) {
      continue;
    }
    const stats: WorkerStats = {
      tasks: countValue(raw.tasks),
      errors: countValue(raw.errors),
      inputTokens: countValue(raw.inputTokens),
      outputTokens: countValue(raw.outputTokens),
      costUsd: countValue(raw.costUsd),
    };
    const lastUsedAt = timestampValue(raw.lastUsedAt);
    if (lastUsedAt !== undefined) {
      stats.lastUsedAt = lastUsedAt;
    }
    const cooldownUntil = timestampValue(raw.cooldownUntil);
    if (cooldownUntil !== undefined) {
      stats.cooldownUntil = cooldownUntil;
    }
    if (typeof raw.lastError === 'string') {
      stats.lastError = raw.lastError;
    }
    entries.push([name, stats]);
  }
  // No prototype, so every worker name is an ordinary key for the readers AND for the writers
  // that mutate this very object under the lock (updateStats's callers, renameWorker): see
  // nameKeyed. JSON.stringify writes it exactly as it would a plain object.
  return nameKeyed(entries);
}

/**
 * Replace stats.json with `stats`, under the advisory lock. A damaged file there is set aside
 * first, and a file that could not be read refuses the write (stateFileForRewrite).
 */
export function writeStats(stats: StatsFile): void {
  ensureDirs();
  withFileLock(STATS_FILE, () => {
    stateFileForRewrite(STATS_FILE);
    atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2));
  });
}

/**
 * Read-modify-write stats.json under the advisory lock (contract R4). This is the
 * hot concurrent path: the server and every detach supervisor call it through
 * recordSuccess / recordFailure, so without the lock two processes could read the
 * same stats, each add one task, and one increment would be lost. Holding the lock
 * across the fresh re-read → mutate → atomic write makes the update atomic. `mutate`
 * receives the freshly re-read stats and mutates it in place.
 *
 * The re-read is stateFileForRewrite's: a stats.json that is damaged is set aside as
 * `stats.json.damaged` and `mutate` starts from empty stats; one that could not be READ throws
 * before `mutate` runs and nothing is written (isStateWriteRefusal recognises the error), so a
 * failed read never turns into counters and cooldowns reset to nothing.
 */
export function updateStats(mutate: (stats: StatsFile) => void): void {
  ensureDirs();
  withFileLock(STATS_FILE, () => {
    const stats = statsFrom(stateFileForRewrite(STATS_FILE));
    mutate(stats);
    atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2));
  });
}

/**
 * The text of a task log with every event filed under worker `oldName` re-filed under `newName`,
 * and whether any line changed. Whole-token only: `worker` can be a comma-separated list (a task
 * that failed over), and a name is replaced where it is one of the tokens, never inside another.
 *
 * ONLY A LINE THAT CHANGES IS RE-WRITTEN. Every other line — one that names other workers, one
 * that does not parse, a blank one — is carried over byte for byte, so nothing in the log is
 * re-spelled by a rename that was not about it.
 */
function taskLogRenamed(
  text: string,
  oldName: string,
  newName: string,
): { text: string; changed: boolean } {
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) {
      return line;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // unparseable — never drop data, preserve verbatim
    }
    if (!isJsonObject(parsed) || typeof parsed.worker !== 'string') {
      return line;
    }
    const tokens = parsed.worker.split(',');
    if (!tokens.includes(oldName)) {
      return line;
    }
    changed = true;
    const worker = tokens.map((t) => (t === oldName ? newName : t)).join(',');
    return JSON.stringify({ ...parsed, worker });
  });
  return { text: lines.join('\n'), changed };
}

/**
 * Put the task log back to `original` after it was rewritten as `renamed` — for a rename that
 * failed further on. Returns whether the log now reads as it did before.
 *
 * Exact when it can be: a log that still IS `renamed` gets `original` back, and one that has
 * only GROWN since (something appended) gets `original` followed by what was appended. A log
 * that is anything else was changed by somebody in a way this cannot account for, and is left
 * as it is. Never throws.
 */
function restoreTaskLog(original: string, renamed: string): boolean {
  try {
    const now = readTextSafe(TASKS_LOG_FILE, TASK_LOG_MAX_BYTES);
    if (!now.ok || !now.text.startsWith(renamed)) {
      return false;
    }
    atomicWrite(TASKS_LOG_FILE, original + now.text.slice(renamed.length));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename a worker everywhere its name is used as a key: the events filed under it in the task
 * log, its entry in stats.json, and its entry in the registry. The config directory — and
 * therefore the account's login — is NOT touched; only the label changes.
 *
 * ALL OR NOTHING, AS FAR AS THREE FILES ALLOW. The three are separate files and no rename moves
 * three at once, so this is arranged so that a refusal comes BEFORE the first write, and a
 * failure after it is undone and reported:
 *
 *   1. BOTH LOCKS FIRST — the registry's, then the stats file's — held until the end. A lock
 *      that cannot be taken throws here, with nothing touched.
 *   2. EVERYTHING THAT CAN REFUSE IS ASKED NEXT, still before any write: the registry must be
 *      readable (registryForRewrite) and hold the worker; the new name must be free — among the
 *      usable workers AND among the entries this version cannot use, which hold their names too;
 *      stats.json must be readable; the task log must be readable, must show no running
 *      dispatch, and must not have changed since it was read. All three new texts are computed
 *      in memory first, so a value that cannot be serialized fails here as well.
 *   3. THEN THE THREE WRITES: the task log, stats.json, the registry — the registry LAST, because
 *      it is the authoritative identity: a process killed before that write leaves the worker
 *      registered under the old name, and running the rename again finishes it (each step is a
 *      no-op where its file is already migrated).
 *   4. A WRITE THAT FAILS (a full disk, a directory that became read-only) UNDOES THE ONES BEFORE
 *      IT — stats.json gets the text it had, the task log gets its lines back (restoreTaskLog) —
 *      and the error says, file by file, which name each one is under now.
 *
 * WHAT IS STILL NOT ATOMIC, and cannot be made so here:
 *   - a process KILLED between two of the writes leaves the files it reached renamed and the
 *     rest not. The registry still says the old name then; run the rename again.
 *   - the task log has no lock — it is appended to by every dispatch — so an event appended in
 *     the instant between this function's last look at the log and its rename of the rewritten
 *     copy into place is lost. That is why a rename is refused while a dispatch is running, why
 *     a log no line of which changes is not rewritten at all, and why the log's size is checked
 *     again immediately before the write; the window that remains is the write itself.
 *   - an undo is a write, and can fail like one. The error then names the file left behind.
 *   - a process that does not follow the lock protocol (a pre-2.0 editor, a person with a text
 *     editor) can change a file between the check and the write.
 *
 * Throws, always with nothing renamed unless the message says otherwise: for an invalid or
 * taken name, for an unknown worker, for running dispatches, and with the refusals
 * isStateWriteRefusal recognises (a lock that could not be taken, a registry or stats file that
 * could not be read).
 */
export function renameWorker(oldName: string, newName: string): void {
  newName = newName.trim();
  if (!/^[\w-]+$/.test(newName)) {
    throw new Error(`Invalid worker name "${newName}" — use letters, digits, - or _.`);
  }
  if (newName === oldName) {
    return;
  }
  ensureDirs();
  withFileLock(REGISTRY_FILE, (registryLock) =>
    withFileLock(STATS_FILE, (statsLock) => {
      // ---- 2. everything that can refuse, before any write --------------------------------
      const registry = registryForRewrite();
      const unsupportedInFile = [...registry.unsupportedWorkers];
      const worker = registry.workers.find((w) => w.name === oldName);
      if (!worker) {
        throw new Error(`No worker named "${oldName}".`);
      }
      if (registry.workers.some((w) => w.name === newName)) {
        throw new Error(`A worker named "${newName}" already exists.`);
      }
      if (unsupportedInFile.some((entry) => entry.name === newName)) {
        throw new Error(
          `The registry already holds an entry named "${newName}" — one this version cannot use. ` +
            'Choose another name.',
        );
      }

      // Read without setting a damaged file aside, as a stats UPDATE would: a damaged stats.json
      // holds no entry this can move, so the rename has nothing to write there and leaves it for
      // the next update to deal with. One that could not be read at all is refused — it may well
      // hold the entry.
      const statsRead = readStateFile(STATS_FILE);
      if (statsRead.state === 'unread') {
        throw stateFileUnreadable(STATS_FILE, statsRead.problem);
      }
      const stats = statsFrom(statsRead.state === 'ok' ? statsRead.object : {});
      const statsBefore = JSON.stringify(stats, null, 2);
      if (oldName in stats) {
        if (!(newName in stats)) {
          stats[newName] = stats[oldName];
        }
        delete stats[oldName];
      }
      const statsAfter = JSON.stringify(stats, null, 2);

      // Guarded, and the refusal is a THROW rather than a skip: skipping the log because it
      // could not be read would leave the ledger naming the OLD worker while registry.json names
      // the new one — silently, on exactly the input (a FIFO, a directory, an oversize file at
      // the log path) where silence is least warranted. `absent` is the one answer that is not
      // an error: no log, nothing to migrate. Read ONCE, so the dispatches judged running and
      // the lines rewritten are the same bytes.
      const log = readTextSafe(TASKS_LOG_FILE, TASK_LOG_MAX_BYTES);
      if (!log.ok && log.reason !== 'absent') {
        throw new Error(
          `Cannot rename: the task log could not be read (${log.reason}) — ${log.detail}. ` +
            'Nothing was changed.',
        );
      }
      const logBefore = log.ok ? log.text : '';
      if (Object.keys(runningCountsOf(taskEventsIn(logBefore))).length > 0) {
        throw new Error(
          'Cannot rename while dispatches are running — the dispatch server appends to the task log. Wait for them to finish.',
        );
      }
      const logRenamed = taskLogRenamed(logBefore, oldName, newName);

      worker.name = newName;
      const registryAfter = registryFileText(registry, unsupportedInFile);

      if (!registryLock.stillOurs() || !statsLock.stillOurs()) {
        throw new Error(
          `Cannot rename "${oldName}": a lock this process held was removed by another process. ` +
            'Nothing was changed. Try again.',
        );
      }
      if (logRenamed.changed) {
        // The log is appended to without any lock. If it is not the size that was read, something
        // was appended while this function worked, and the copy about to replace it lacks that.
        let sizeNow = -1;
        try {
          sizeNow = fs.statSync(TASKS_LOG_FILE).size;
        } catch {
          // gone or unreadable now — not the file that was read
        }
        if (!log.ok || sizeNow !== log.bytes) {
          throw new Error(
            'Cannot rename: the task log changed while it was being read — a dispatch has started. ' +
              'Nothing was changed. Try again when it has finished.',
          );
        }
      }

      // ---- 3. the three writes; 4. undo on failure -----------------------------------------
      let logWritten = false;
      let statsWritten = false;
      try {
        if (logRenamed.changed) {
          atomicWrite(TASKS_LOG_FILE, logRenamed.text);
          logWritten = true;
        }
        if (statsAfter !== statsBefore) {
          atomicWrite(STATS_FILE, statsAfter);
          statsWritten = true;
        }
        atomicWrite(REGISTRY_FILE, registryAfter);
      } catch (err) {
        let statsRestored = !statsWritten;
        if (statsWritten) {
          try {
            atomicWrite(STATS_FILE, statsBefore);
            statsRestored = true;
          } catch {
            // reported below as still under the new name
          }
        }
        const logRestored = !logWritten || restoreTaskLog(logBefore, logRenamed.text);
        const said = (err instanceof Error ? err.message : 'a write failed').replace(
          /\s*Nothing was changed\.\s*$/,
          '',
        );
        const cause = /[.!?]$/.test(said) ? said : `${said}.`;
        // The registry is under the old name whichever write failed: its own is the last one, and
        // a failed atomicWrite leaves its destination as it was.
        const stillOld = ['the registry'];
        const alreadyNew: string[] = [];
        (statsRestored ? stillOld : alreadyNew).push('stats');
        (logRestored ? stillOld : alreadyNew).push('the task log');
        throw new Error(
          `Could not rename worker "${oldName}" to "${newName}": ${cause} ` +
            (alreadyNew.length === 0
              ? 'Every change was undone: the task log, stats and the registry all still use the old name.'
              : `Still under the OLD name: ${stillOld.join(', ')}. Already under the NEW name, and ` +
                `could not be changed back: ${alreadyNew.join(', ')}. Run the rename again to finish it.`),
        );
      }
    }),
  );
}
