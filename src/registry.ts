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

export function writeRegistry(registry: Registry): void {
  ensureDirs();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

export function appendTaskEvent(event: TaskEvent): void {
  ensureDirs();
  fs.appendFileSync(TASKS_LOG_FILE, JSON.stringify(event) + '\n');
}

export function readTaskEvents(): TaskEvent[] {
  try {
    return fs
      .readFileSync(TASKS_LOG_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TaskEvent);
  } catch {
    return [];
  }
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
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}
