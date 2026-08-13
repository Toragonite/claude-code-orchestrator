import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  appendTaskEvent,
  clampTimeoutMinutes,
  emptyStats,
  ensureDirs,
  readRegistry,
  readStats,
  Registry,
  runningCounts,
  TASKS_DIR,
  TaskEvent,
  updateStats,
  WORKER_MODELS,
  WorkerProfile,
} from '../registry';
import { isFrontierTier, WORKER_BASE_PROMPT } from '../prompts';
import {
  AccountUsage,
  AUTH_PROBE_TIMEOUT_MS,
  AuthStatus,
  exhaustedWindows,
  fetchAuthStatus,
  formatRelativeReset,
  isLoginExpired,
  mergeUsageCaches,
  readUsageCache,
  resolveProbeCommand,
  USAGE_CACHE_FILE,
  UsageCache,
  UsageWindow,
} from '../usage';

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
 * Message raised (and swallowed by the host) when a dispatch is aborted after its
 * worker loop — kept identical to the server's cancel terminal-event string so the
 * two never diverge. The server imports this for its own cancelRequest event.
 */
export const CANCELLED_ERROR = 'cancelled by the orchestrator session';

let rrIndex = 0;

/** Identity of a task, enough to append a terminal event for it. */
export type TaskBase = Pick<TaskEvent, 'id' | 'title' | 'worker' | 'model' | 'outputFile' | 'cwd'>;

export interface DispatchArgs {
  title?: string;
  prompt?: string;
  model?: string;
  worker?: string;
  system_prompt?: string;
  /** Escalate the worker to maximum reasoning depth via the thinking keyword. */
  ultrathink?: boolean;
  /** Per-task wall-clock limit; falls back to registry.workerTimeoutMinutes. */
  timeout_minutes?: number;
  /**
   * Opt in to survival: the server runs this task in a standalone supervisor that
   * owns it, records its result, and survives the session ending. Read ONLY by the
   * server (which decides in-process vs detached); the core never inspects it.
   */
  detach?: boolean;
}

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
  /** True when the owning request has been cancelled / the server is shutting down. */
  shouldAbort(): boolean;
  /** Claim the task id before the child exists — a cancel in that window still lands. */
  onTrack(base: TaskBase): void;
  /** The worker child was just spawned — make it killable from outside this run. */
  onSpawn(taskId: string, child: ChildProcess): void;
  /** Terminal cleanup for this task id — runs in a finally after the dispatch settles. */
  onSettle(taskId: string): void;
  /**
   * Pre-assigned task id. A detach supervisor sets this so the server (which chose
   * the id and is waiting on tasks/<id>.result.json) and the supervisor agree on it.
   * Unset on the default path, where the core allocates its own id exactly as before.
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
}

/**
 * Exported for the `--bg` dispatch runner (mcp/bg-runner.ts), which must classify a
 * spawn failure exactly as this path does — a quota failure fails over, anything else
 * surfaces. Behavior is unchanged; only the visibility of the symbol is.
 */
export function isQuotaError(message: string): boolean {
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

/** '<label> <percent>% (resets <when>)' for a quota-exhausted window — error text and list_workers. */
export function formatExhaustedWindow(w: UsageWindow): string {
  return `${w.label} ${Math.round(w.percent)}% (resets ${formatRelativeReset(w.resetsAt)})`;
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

/**
 * Wrap a value in POSIX single quotes so it survives the shell verbatim. Config
 * dirs routinely contain spaces ("/Users/x/Library/Application Support/…"), which
 * an unquoted assignment would split into a command. Inside single quotes nothing
 * is special except the closing quote itself, so the only escape needed is the
 * standard '\'' idiom: close, emit a literal quote, reopen.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Caveat appended ONCE per message that prints a reloginCommand — the syntax is POSIX-only. */
export const RELOGIN_SHELL_CAVEAT = 'POSIX shell; on Windows set the env var first';

/** Shell command that re-authenticates one account — the recovery step for an expired login. */
export function reloginCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude auth login`;
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
function expiredLoginRefusal(name: string, configDir: string): string {
  return (
    `Worker "${name}" login is expired/logged out; a dispatch would fail to authenticate. ` +
    'Re-login this account first (VSCode: "Re-login Account" on the worker, or shell: ' +
    `${reloginCommand(configDir)} — ${RELOGIN_SHELL_CAVEAT}) and retry.`
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
 */
async function liveRecheckExpiredLogins(
  candidates: WorkerProfile[],
  kind: 'named' | 'auto',
  cache: UsageCache,
  probedDirs: Set<string>,
): Promise<LiveRecheckResult> {
  const byDir = new Map<string, string[]>();
  for (const w of candidates) {
    const names = byDir.get(w.configDir);
    if (names === undefined) {
      byDir.set(w.configDir, [w.name]);
    } else {
      names.push(w.name);
    }
  }
  let recovered = false;
  const confirmed: string[] = [];
  const unknown: string[] = [];
  let truncated = false;
  for (const [configDir, names] of byDir) {
    // Already probed this dispatch: skipped at zero latency, so it consumes no budget.
    if (probedDirs.has(configDir)) {
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
    probedDirs.add(configDir);
    const auth = await fetchAuthStatus(
      configDir,
      Math.min(AUTH_PROBE_TIMEOUT_MS, LIVE_RECHECK_PROBE_TIMEOUT_MS),
    );
    if (auth === undefined) {
      unknown.push(...names);
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
    note: recheckNote(kind, confirmed, unknown, truncated ? probedDirs.size : 0),
  };
}

/** Fold a fresh auth reading into the in-memory cache entry, and persist it. */
function applyAuthReading(cache: UsageCache, configDir: string, auth: AuthStatus): void {
  const updated: AccountUsage = { ...cache[configDir], auth };
  cache[configDir] = updated;
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
 */
function recheckNote(
  kind: 'named' | 'auto',
  confirmed: string[],
  unknown: string[],
  probedCount: number,
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
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
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
 */
function pickWorker(
  workers: WorkerProfile[],
  preferred: string | undefined,
  attempted: Set<string>,
  requestedModel: string | undefined,
  cache: UsageCache,
  overageAllowed: boolean,
): { worker: WorkerProfile; billableOverage: boolean } {
  const exhaustedFor = (w: WorkerProfile): UsageWindow[] => {
    const candidate = requestedModel ?? w.model;
    return exhaustedWindows(cache[w.configDir], Date.now()).filter(
      (win) =>
        win.kind === 'session' ||
        win.kind === 'weekly_all' ||
        (win.kind === 'weekly_scoped' && isFrontierTier(candidate)),
    );
  };

  if (preferred) {
    const found = workers.find((w) => w.name === preferred);
    // An unknown name is interface misuse, not a hint to auto-assign: fail loudly
    // rather than silently substitute a different account than the caller named.
    if (!found) {
      throw new Error(
        `Unknown worker "${preferred}". Registered workers: ${workers.map((w) => w.name).join(', ')}.`,
      );
    }
    if (attempted.has(found.name)) {
      throw new Error(`Worker "${preferred}" already failed this task.`);
    }
    // Checked before exhaustion: a logged-out account cannot authenticate at all,
    // so quota headroom (or overage billing) on it is irrelevant.
    if (isLoginExpired(cache[found.configDir])) {
      throw new ExpiredLoginBlock(expiredLoginRefusal(found.name, found.configDir), [found], 'named');
    }
    const exhausted = exhaustedFor(found);
    if (exhausted.length > 0) {
      // Exhausted + overage ON → ALLOW, but the dispatch spends real money — and
      // only when the operator's billing guard permits it. Guard blocking turns
      // that billable run into its own refusal, distinct from the no-overage one
      // below: the account COULD run, the operator has forbidden the spend.
      // Exhausted + overage off/unknown → keep the refusal (guaranteed quota failure).
      if (overageEnabled(cache[found.configDir])) {
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
  // Logged out === undispatchable: excluded here (not at the tier filters) so it
  // composes with cooldown and stays out of the overage fallback pool too.
  const loggedOut = workers.filter((w) => isLoginExpired(cache[w.configDir]));
  const eligible = workers.filter(
    (w) =>
      !attempted.has(w.name) &&
      (stats[w.name]?.cooldownUntil ?? 0) <= now &&
      !isLoginExpired(cache[w.configDir]),
  );
  if (eligible.length === 0) {
    const cooling = workers
      .filter((w) => (stats[w.name]?.cooldownUntil ?? 0) > now)
      .map((w) => `${w.name} (until ${new Date(stats[w.name]!.cooldownUntil!).toLocaleTimeString()})`);
    const reasons: string[] = [];
    if (cooling.length > 0) {
      reasons.push(`cooling down after quota errors — ${cooling.join(', ')}`);
    }
    if (loggedOut.length > 0) {
      reasons.push(`login expired/logged out — ${loggedOut.map((w) => w.name).join(', ')}`);
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
          `shell: ${[...new Set(loggedOut.map((w) => reloginCommand(w.configDir)))].join(', ')} — ` +
          `${RELOGIN_SHELL_CAVEAT}).`
        : '';
    const cooldownAdvice =
      cooling.length > 0
        ? ' Wait for the cooldown, or retry with an explicit "worker" — an explicitly named worker ' +
          'runs even while cooling down.'
        : '';
    const message =
      `No eligible worker: ${reasons.join('; ')}.${relogin}${cooldownAdvice} ` +
      'Add another worker account if this keeps blocking dispatches.';
    // Workers whose ONLY disqualifier is the cached expired-login verdict: not
    // attempted, not cooling down, just logged out. Flipping that verdict is the
    // one thing that could make this selection succeed, so it is worth a live
    // probe. Anything else here (all attempted, all cooling down) no probe can fix.
    const recoverable = workers.filter(
      (w) =>
        !attempted.has(w.name) &&
        (stats[w.name]?.cooldownUntil ?? 0) <= now &&
        isLoginExpired(cache[w.configDir]),
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
      const minOther = Math.min(...others.map((w) => running[w.name] ?? 0));
      if ((running[starred.name] ?? 0) <= minOther) {
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
  const poolB = eligible.filter(
    (w) => exhaustedFor(w).length > 0 && overageEnabled(cache[w.configDir]),
  );
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
): Promise<{ worker: WorkerProfile; billableOverage: boolean }> {
  try {
    return pickWorker(workers, preferred, attempted, requestedModel, cache, overageAllowed);
  } catch (err) {
    if (!(err instanceof ExpiredLoginBlock)) {
      throw err;
    }
    const recheck = await liveRecheckExpiredLogins(err.candidates, err.kind, cache, probedDirs);
    if (!recheck.recovered) {
      throw new Error(err.message + recheck.note);
    }
    try {
      return pickWorker(workers, preferred, attempted, requestedModel, cache, overageAllowed);
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

export function recordSuccess(name: string, run: RunResult): void {
  // updateStats holds the stats.json advisory lock across the read-modify-write, so
  // concurrent detach supervisors never lose an increment (contract R4).
  updateStats((stats) => {
    const s = stats[name] ?? emptyStats();
    s.tasks++;
    s.inputTokens += run.inputTokens;
    s.outputTokens += run.outputTokens;
    s.costUsd += run.costUsd;
    s.lastUsedAt = Date.now();
    s.lastError = undefined;
    stats[name] = s;
  });
}

export function recordFailure(name: string, message: string, quota: boolean, cooldownMinutes: number): void {
  updateStats((stats) => {
    const s = stats[name] ?? emptyStats();
    s.errors++;
    s.lastUsedAt = Date.now();
    s.lastError = message.slice(0, 300);
    if (quota) {
      s.cooldownUntil = Date.now() + cooldownMinutes * 60_000;
    }
    stats[name] = s;
  });
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
 */
function runClaude(
  registry: Registry,
  configDir: string,
  model: string,
  prompt: string,
  timeoutMinutes: number,
  systemPrompt?: string,
  onSpawn?: (child: ChildProcess) => void,
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
    // detached: on POSIX the child leads its own process group (pgid === pid), so
    // signalTree() can take down the worker's own dispatch server and anything it
    // delegated to. stdio stays implicit ('pipe' × 3): detached does not change it,
    // and naming it here would drop the ChildProcessWithoutNullStreams overload.
    // Deliberately NOT unref()'d — the 'close' event is how a run completes.
    // POSIX only: on Windows `detached` gives the child its own console and lets
    // it OUTLIVE this process — the opposite of what we want. There the tree is
    // taken down with `taskkill /T` instead, and no pgid is recorded.
    const claudePath = resolveProbeCommand();
    const child = spawn(claudePath, args, {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      shell: useShell,
      detached: process.platform !== 'win32',
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
          // (e.g. the child is wedged uninterruptibly), force the timeout
          // rejection so the dispatch always returns.
          reapTimer = setTimeout(() => settle(exitCode, true), REAP_GRACE_MS);
        }, TIMEOUT_KILL_GRACE_MS);
      },
      // clamped upstream, so always inside setTimeout's 32-bit delay range
      timeoutMinutes * 60_000,
    );

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
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

/**
 * The per-task dispatch core. Picks a worker (with quota-aware failover), runs the
 * `claude -p` child, records success/failure and events, writes the RUNNING and
 * DONE/FAILED output file, and returns the inline result string. The host supplies
 * cancellation and child-tracking through `ctx`; everything else is identical to the
 * former in-process dispatchTask body.
 */
export async function runDispatchTask(args: DispatchArgs, ctx: TaskRunContext): Promise<string> {
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
  // A detach supervisor pre-assigns the id (the server picked it and is awaiting
  // tasks/<id>.result.json); the default path allocates its own, exactly as before.
  const id = ctx.preassignedId ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = path.join(TASKS_DIR, `${id}.md`);
  const attempted = new Set<string>();
  // Explicit worker → single attempt; otherwise fail over across workers on quota errors.
  const maxAttempts = args.worker ? 1 : registry.workers.length;
  let lastError: Error | undefined;
  // Whitespace-collapsed prompt head carried on every TaskEvent so surfaces can
  // show WHAT a task is running without opening its output file.
  const promptPreview = prompt.replace(/\s+/g, ' ').trim().slice(0, 300);
  // Task-specific system prompt (if any), and its reusable output-file section.
  const systemPrompt = args.system_prompt?.trim();
  const systemPromptSection = systemPrompt ? `\n\n## Task system prompt\n\n${systemPrompt}` : '';
  // Caller-validated model request (else each worker runs its own default) and a
  // single usage-cache read, both passed into every pickWorker attempt.
  const requestedModel =
    args.model && (WORKER_MODELS as readonly string[]).includes(args.model) ? args.model : undefined;
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

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ctx.shouldAbort()) {
        break;
      }
      let worker: WorkerProfile;
      let billableOverage: boolean;
      try {
        const picked = await pickWorkerLive(
          registry.workers,
          args.worker,
          attempted,
          requestedModel,
          usageCache,
          overageAllowed,
          probedDirs,
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
      const model = requestedModel ?? worker.model;
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
      // supervisorPid is set only on the detach path (the supervisor passes its own
      // pid); JSON.stringify drops it on the default path, so those events are byte-
      // identical. Carried on base so every event for the task inherits it.
      const base = {
        id,
        title,
        worker: worker.name,
        model,
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
        fs.writeFileSync(
          outputFile,
          `# ${title}\n\n- status: RUNNING (started ${new Date().toISOString()})\n- worker: ${worker.name}\n- model: ${model}${args.ultrathink ? '\n- ultrathink: true' : ''}${billableOverage ? '\n- overage: billing past plan window' : ''}\n\n---\n\n## Prompt\n\n${prompt}${systemPromptSection}\n`,
        );
      } catch {
        // best effort — the task still runs and the DONE/FAILED writer overwrites this
      }

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
          systemPrompt || undefined,
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
        );
        recordSuccess(worker.name, run);
        fs.writeFileSync(
          outputFile,
          `# ${title}\n\n- worker: ${worker.name}\n- model: ${model}${args.ultrathink ? '\n- ultrathink: true' : ''}${billableOverage ? '\n- overage: billing past plan window' : ''}\n- tokens: ${run.inputTokens} in / ${run.outputTokens} out` +
            (run.costUsd ? ` (~$${run.costUsd.toFixed(4)})` : '') +
            `\n\n---\n\n## Prompt\n\n${prompt}${systemPromptSection}\n\n## Result\n\n${run.text}\n`,
        );
        appendTaskEvent({
          ...base,
          ts: Date.now(),
          status: 'done',
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
        });
        // When the dispatch went to an exhausted-but-overage-enabled worker, warn
        // loudly (before the [worker: …] line) that it spent real money.
        const overageWarning = billableOverage
          ? `⚠ ${worker.name} is past a plan window; overage billing applies — this dispatch bills real money against the account's monthly cap.\n`
          : '';
        const resultText = `${overageWarning}[worker: ${worker.name}, model: ${model}]\n\n${run.text}`;
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
        const message = err instanceof Error ? err.message : String(err);
        // A timeout and an external kill are never quota errors, whatever their
        // embedded partial output says. Both fall through to the break below:
        // no cooldown, and no replacement worker for a task nobody still wants.
        const quota =
          !(err instanceof WorkerTimeoutError) && !(err instanceof WorkerKilledError) && isQuotaError(message);
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

    if (ctx.shouldAbort()) {
      // cancelRequest already killed the child and appended the terminal event.
      // No output file, no failure record — the caller gets no response either.
      throw new Error(CANCELLED_ERROR);
    }

    const message = lastError?.message ?? 'unknown error';
    const singleWorkerHint =
      registry.workers.length === 1 &&
      !(lastError instanceof WorkerTimeoutError) &&
      !(lastError instanceof WorkerKilledError) &&
      isQuotaError(message)
        ? ' Only one worker account is registered, so there is nothing to fail over to — wait for its limit to reset or add another worker account.'
        : '';
    fs.writeFileSync(
      outputFile,
      `# ${title}\n\nFAILED: ${message}\n\n## Prompt\n\n${prompt}${systemPromptSection}\n`,
    );
    appendTaskEvent({
      id,
      title,
      worker: [...attempted].join(',') || (args.worker ?? '-'),
      model: args.model ?? '-',
      outputFile,
      cwd: process.cwd(),
      promptPreview,
      supervisorPid: ctx.supervisorPid,
      ts: Date.now(),
      status: 'error',
      error: message,
    });
    const finalMessage = message + singleWorkerHint;
    // Same string the throw carries, so a detach supervisor's result.json relays a
    // byte-identical failure. onResult is unset on the default path (no effect).
    ctx.onResult?.({
      id,
      status: 'error',
      text: finalMessage,
      worker: [...attempted].join(',') || (args.worker ?? '-'),
      model: args.model ?? '-',
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
