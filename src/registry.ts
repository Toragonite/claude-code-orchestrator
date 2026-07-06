import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Shared state between the VS Code extension and the standalone MCP dispatch
 * server (which runs in a separate process, spawned by the Claude Code CLI).
 * Everything lives under ~/.fable-orchestrator. This module must not import
 * 'vscode'.
 */

export const WORKER_MODELS = ['claude-opus-4-8', 'claude-sonnet-5'] as const;
export type WorkerModel = (typeof WORKER_MODELS)[number];

export interface WorkerProfile {
  name: string;
  /** Claude Code config directory holding this account's login (CLAUDE_CONFIG_DIR). */
  configDir: string;
  /** Default model when a dispatch doesn't specify one. */
  model: WorkerModel;
}

export interface Registry {
  workers: WorkerProfile[];
  /** --permission-mode passed to dispatched workers. */
  permissionMode: string;
  /** Path or name of the claude executable. */
  claudePath: string;
  /** Minutes a worker sits out after a quota/rate-limit error. */
  cooldownMinutes: number;
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
}

export const ROOT_DIR = path.join(os.homedir(), '.fable-orchestrator');
export const REGISTRY_FILE = path.join(ROOT_DIR, 'registry.json');
export const TASKS_LOG_FILE = path.join(ROOT_DIR, 'tasks.jsonl');
export const TASKS_DIR = path.join(ROOT_DIR, 'tasks');
export const STATS_FILE = path.join(ROOT_DIR, 'stats.json');

const DEFAULTS: Registry = {
  workers: [],
  permissionMode: 'acceptEdits',
  claudePath: 'claude',
  cooldownMinutes: 30,
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
