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
   * Billing guard for frontier worker models (claude-fable-5): 'block'
   * rejects such dispatches at the server with a fall-back hint. Defaults to
   * 'block' because frontier models may bill per use instead of drawing from
   * the subscription quota.
   */
  frontierWorkerDispatch: 'allow' | 'block';
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
};

export function ensureDirs(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

export function readRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
    return { ...DEFAULTS, ...raw, workers: raw.workers ?? [] };
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

export function appendTaskEvent(event: TaskEvent): void {
  ensureDirs();
  fs.appendFileSync(TASKS_LOG_FILE, JSON.stringify(event) + '\n');
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
