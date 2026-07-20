import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Shared state between the VS Code extension and the standalone MCP dispatch
 * server (which runs in a separate process, spawned by the Claude Code CLI).
 * Everything lives under ~/.claude-code-orchestrator. This module must not import
 * 'vscode'.
 */

// claude-fable-5 requires the account's plan to include Fable access and
// draws its separate weekly quota — reserve it for design-consult and
// adversarial-review dispatches.
export const WORKER_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5'] as const;
export type WorkerModel = (typeof WORKER_MODELS)[number];

export interface WorkerProfile {
  name: string;
  /** Claude Code config directory holding this account's login (CLAUDE_CONFIG_DIR). */
  configDir: string;
  /** Default model when a dispatch doesn't specify one. */
  model: WorkerModel;
  /**
   * Preferred worker (typically the same account as the main session): wins
   * automatic assignment whenever it isn't busier than the least-busy
   * alternative, so it's favored without being flooded.
   */
  preferred?: boolean;
}

export interface Registry {
  workers: WorkerProfile[];
  /** --permission-mode passed to dispatched workers. */
  permissionMode: string;
  /** Path or name of the claude executable. */
  claudePath: string;
  /** Minutes a worker sits out after a quota/rate-limit error. */
  cooldownMinutes: number;
  /**
   * Billing guard over WHICH MODEL may be dispatched: 'block' rejects dispatches
   * of the frontier model (claude-fable-5) at the server with a fall-back hint.
   * Defaults to 'block' because that model may bill per use instead of drawing
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
   * First ~300 chars of the dispatched prompt (whitespace-collapsed), so surfaces
   * can show WHAT a task is running without opening its output file. Set on the
   * initial 'running' event and carried on every later event for the task.
   */
  promptPreview?: string;
  /** PID of the worker `claude -p` child. Set on a second 'running' event emitted after spawn. */
  pid?: number;
  /** Process-group id of the worker, recorded only when it was spawned as its own group leader (detached). Present => the whole tree can be signalled with -pgid. */
  pgid?: number;
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

/** Self-reported main-session model per workspace (via orchestrator_briefing). */
export interface OrchestratorCheckin {
  model: string;
  ts: number;
}

export type OrchestratorsFile = Record<string, OrchestratorCheckin>;

export function readOrchestrators(): OrchestratorsFile {
  try {
    return JSON.parse(fs.readFileSync(ORCHESTRATORS_FILE, 'utf8')) as OrchestratorsFile;
  } catch {
    return {};
  }
}

export function recordOrchestrator(cwd: string, model: string): void {
  ensureDirs();
  const all = readOrchestrators();
  all[cwd] = { model, ts: Date.now() };
  fs.writeFileSync(ORCHESTRATORS_FILE, JSON.stringify(all, null, 2));
}

const DEFAULTS: Registry = {
  workers: [],
  permissionMode: 'acceptEdits',
  claudePath: 'claude',
  cooldownMinutes: 30,
  frontierWorkerDispatch: 'block',
  overageWorkerDispatch: 'block',
};

export function ensureDirs(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

export function readRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
    return {
      ...DEFAULTS,
      ...raw,
      workers: raw.workers ?? [],
      // Every registry file written before this guard existed lacks the field, and
      // the file is hand-editable. Anything that is not exactly 'allow' — absent,
      // null, misspelled — must read as the safe 'block': money is only ever spent
      // past a plan window when an editor explicitly opted in.
      overageWorkerDispatch: raw.overageWorkerDispatch === 'allow' ? 'allow' : 'block',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Write a file so concurrent readers (the MCP dispatch server runs in a
 * separate process and reads these files) never observe a torn or truncated
 * result: write to a pid-scoped temp file, then atomically rename it into place.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeRegistry(registry: Registry): void {
  ensureDirs();
  atomicWrite(REGISTRY_FILE, JSON.stringify(registry, null, 2));
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
  if (typeof command !== 'string') {
    return 'claude';
  }
  command = command.trim();
  if (command === '') {
    return 'claude';
  }
  if (process.platform === 'win32' || path.isAbsolute(command)) {
    return command;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(command) || command === '.' || command === '..') {
    return command;
  }
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const out = execFileSync(shell, ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .split('\n')
      .pop();
    if (out && isSpawnableFile(out)) {
      return out;
    }
  } catch {
    // fall through
  }
  for (const candidate of wellKnownLocations(command)) {
    if (isSpawnableFile(candidate)) {
      return candidate;
    }
  }
  return command;
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
  const command = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'claude';
  if (path.isAbsolute(command)) {
    return command;
  }
  const resolved = resolveViaLoginShell(command);
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  if (typeof previous === 'string' && path.isAbsolute(previous) && isSpawnableFile(previous)) {
    const base = path.basename(previous);
    const stripped = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (base === command || stripped === command) {
      return previous;
    }
  }
  return resolved;
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
 * MODEL may be dispatched (claude-fable-5), this one controls WHETHER ANY
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

export function appendTaskEvent(event: TaskEvent): void {
  ensureDirs();
  fs.appendFileSync(TASKS_LOG_FILE, JSON.stringify(event) + '\n');
}

/**
 * Best-effort append of a trailing note to a task's output file. The dispatch
 * server writes the output file when an attempt starts, so terminal paths that
 * bypass the server's own done/failed writers must annotate the file or it keeps
 * claiming RUNNING forever. Never throws; a no-op when outputFile is empty.
 */
export function appendOutputNote(outputFile: string | undefined, note: string): void {
  if (typeof outputFile !== 'string' || outputFile === '') {
    return;
  }
  try {
    fs.appendFileSync(outputFile, note);
  } catch {
    // annotating the output file is best-effort — never break the caller
  }
}

export function readTaskEvents(): TaskEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(TASKS_LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  // Skip unparseable lines individually. appendTaskEvent is a plain append, so a
  // crash mid-write can leave one truncated line; discarding the whole log for it
  // would blank the task view, zero windowUsage, and silently defeat the
  // running-dispatch guard in renameWorker.
  const events: TaskEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as TaskEvent);
    } catch {
      // truncated or hand-edited line — ignore it, keep the rest
    }
  }
  return events;
}

export function clearTaskLog(): void {
  try {
    fs.writeFileSync(TASKS_LOG_FILE, '');
  } catch {
    // nothing to clear
  }
}

/** Currently-running dispatch count per worker (latest event per task id). */
export function runningCounts(): Record<string, number> {
  const latest = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    latest.set(e.id, e);
  }
  const counts: Record<string, number> = {};
  for (const e of latest.values()) {
    if (e.status === 'running') {
      counts[e.worker] = (counts[e.worker] ?? 0) + 1;
    }
  }
  return counts;
}

/** Latest event per task id, in the order runningCounts observes them. */
function latestById(): Map<string, TaskEvent> {
  const latest = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    latest.set(e.id, e);
  }
  return latest;
}

/** Tasks whose latest event is still 'running' (mirrors runningCounts' latest-per-id logic). */
export function runningTasks(): TaskEvent[] {
  const running: TaskEvent[] = [];
  for (const e of latestById().values()) {
    if (e.status === 'running') {
      running.push(e);
    }
  }
  return running;
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
 * CRITICAL SAFETY GATE. A 'running' event can be stale, and the OS may have
 * recycled its pid for a completely unrelated process. Never signal a pid without
 * first confirming it is still one of our workers by reading its command line.
 * Our workers are spawned as `claude -p --output-format json …`, so the command
 * line must contain both `claude` and ` -p`. Any error, empty output, or
 * non-matching command line is treated as "not ours" → not signalled. On win32
 * there is no `ps`, so we degrade to "treat as dead" and never signal.
 */
function isOurWorker(pid: number): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    if (!args) {
      return false;
    }
    return args.includes('claude') && args.includes(' -p');
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
 * A group signal is sent ONLY when the event explicitly recorded `pgid` (the
 * worker was spawned detached as its own group leader, so PGID === PID and the
 * group is exclusively ours). We NEVER derive a group id from the pid: a worker
 * from an older build is not a group leader, and `-pid` would then signal the
 * server's group — a group we do not own. On win32 negative pids are meaningless,
 * so we use `taskkill /T` to kill the tree by pid. Never throws.
 */
function signalWorker(event: TaskEvent, sig: NodeJS.Signals): void {
  const pid = event.pid;
  if (typeof pid !== 'number' || !isPidAlive(pid) || !isOurWorker(pid)) {
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
  if (typeof event.pgid === 'number' && event.pgid > 0) {
    try {
      // -pgid signals the whole group; only reached when the event recorded it.
      process.kill(-event.pgid, sig);
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
  // No recorded group => older event; signal only the single worker process.
  try {
    process.kill(pid, sig);
  } catch {
    // the worker exited between the checks above and this signal
  }
}

/**
 * Terminate the worker behind a running task and record a terminal 'error' event.
 * Returns false (no-op) when the task is absent or its latest event is not
 * 'running' — which makes a second call idempotent, since the first call's
 * terminal event supersedes the 'running' one. A signal is sent ONLY when the
 * recorded pid is present, alive, and still matches our worker's command line
 * (see isOurWorker); a missing, dead, or recycled pid is never signalled. Stats
 * are left untouched — a cancellation is not a worker error.
 */
export async function cancelRunningTask(id: string, reason: string, graceMs = 3000): Promise<boolean> {
  const latest = latestById().get(id);
  if (!latest || latest.status !== 'running') {
    return false;
  }
  const pid = latest.pid;
  if (typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid)) {
    // signalWorker reaches the worker's whole process tree when the event
    // recorded a pgid, else the single process; it re-asserts the same gate.
    signalWorker(latest, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    // Re-confirm the pid is still alive AND still our worker before escalating:
    // if the process exited during the grace period its pid may have been
    // recycled, and SIGKILL to a recycled pid would kill an unrelated process.
    if (isPidAlive(pid) && isOurWorker(pid)) {
      signalWorker(latest, 'SIGKILL');
    }
  }
  appendTaskEvent({ ...latest, ts: Date.now(), status: 'error', error: reason });
  appendOutputNote(
    latest.outputFile,
    `\n\n---\n\nCANCELLED: ${reason} (${new Date().toISOString()})\n`,
  );
  return true;
}

/**
 * Mark every running task whose worker is gone as orphaned. A task is reaped when
 * it has no pid (older builds), a dead pid, or a pid that no longer matches our
 * worker's command line. Never signals anything — reaping only records terminal
 * events. A task whose pid is alive and still ours is left running. Returns the
 * number reaped; never throws, and a failed append does not abort the sweep.
 */
export function reapDeadTasks(): number {
  let reaped = 0;
  for (const task of runningTasks()) {
    const pid = task.pid;
    if (typeof pid === 'number' && isPidAlive(pid) && isOurWorker(pid)) {
      continue;
    }
    try {
      appendTaskEvent({
        ...task,
        ts: Date.now(),
        status: 'error',
        error: 'orphaned — worker process is no longer running',
      });
      appendOutputNote(
        task.outputFile,
        `\n\n---\n\nORPHANED: worker process is no longer running (${new Date().toISOString()})\n`,
      );
      reaped++;
    } catch {
      // a failed append must not abort the sweep of the remaining tasks
    }
  }
  return reaped;
}

/** Dispatch usage for one worker within a trailing time window. */
export function windowUsage(worker: string, windowMs: number) {
  const since = Date.now() - windowMs;
  let tasks = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const e of readTaskEvents()) {
    if (e.worker === worker && e.status === 'done' && e.ts >= since) {
      tasks++;
      inputTokens += e.inputTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      costUsd += e.costUsd ?? 0;
    }
  }
  return { tasks, inputTokens, outputTokens, costUsd };
}

export function emptyStats(): WorkerStats {
  return { tasks: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function readStats(): StatsFile {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) as StatsFile;
  } catch {
    return {};
  }
}

export function writeStats(stats: StatsFile): void {
  ensureDirs();
  atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2));
}

/**
 * Rename a worker everywhere its name is used as a key. The config directory — and
 * therefore the account's login — is NOT touched; only the label changes.
 * Retry-safe: each step is skipped when its source is already migrated.
 */
export function renameWorker(oldName: string, newName: string): void {
  newName = newName.trim();
  if (!/^[\w-]+$/.test(newName)) {
    throw new Error(`Invalid worker name "${newName}" — use letters, digits, - or _.`);
  }
  if (newName === oldName) {
    return;
  }

  const registry = readRegistry();
  const worker = registry.workers.find((w) => w.name === oldName);
  if (!worker) {
    throw new Error(`No worker named "${oldName}".`);
  }
  if (registry.workers.some((w) => w.name === newName)) {
    throw new Error(`A worker named "${newName}" already exists.`);
  }
  if (Object.keys(runningCounts()).length > 0) {
    throw new Error(
      'Cannot rename while dispatches are running — the dispatch server appends to the task log. Wait for them to finish.',
    );
  }

  // a. tasks.jsonl — remap the `worker` field of every event, whole-token only.
  if (fs.existsSync(TASKS_LOG_FILE)) {
    const migrated = fs
      .readFileSync(TASKS_LOG_FILE, 'utf8')
      .split('\n')
      .map((line) => {
        if (!line.trim()) {
          return line; // blank/trailing segment — preserve as-is
        }
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          return line; // unparseable — never drop data, preserve verbatim
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.worker === 'string') {
          const tokens: string[] = (parsed.worker as string).split(',');
          parsed.worker = tokens.map((t) => (t === oldName ? newName : t)).join(',');
        }
        return JSON.stringify(parsed);
      })
      .join('\n');
    atomicWrite(TASKS_LOG_FILE, migrated);
  }

  // b. stats.json — move the entry to the new key (skip if already migrated).
  const stats = readStats();
  if (oldName in stats) {
    if (!(newName in stats)) {
      stats[newName] = stats[oldName];
    }
    delete stats[oldName];
    writeStats(stats);
  }

  // c. registry.json — the authoritative identity; written last so a crash
  //    before this point leaves oldName as the retry marker.
  worker.name = newName;
  writeRegistry(registry);
}
