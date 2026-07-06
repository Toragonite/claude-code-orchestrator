import * as vscode from 'vscode';

/** Main (orchestrator) model — Anthropic's most capable model. */
export const FABLE_MODEL = 'claude-fable-5';

/** Fallback model re-served on a Fable 5 safety refusal (server-side fallbacks beta). */
export const REFUSAL_FALLBACK_MODEL = 'claude-opus-4-8';

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-06-01';

/** Models a worker account can run. */
export const WORKER_MODELS = ['claude-opus-4-8', 'claude-sonnet-5'] as const;
export type WorkerModel = (typeof WORKER_MODELS)[number];

export function config() {
  const cfg = vscode.workspace.getConfiguration('fableOrchestrator');
  return {
    mainModel: cfg.get<string>('mainModel', FABLE_MODEL),
    defaultWorkerModel: cfg.get<WorkerModel>('defaultWorkerModel', 'claude-opus-4-8'),
    maxOutputTokens: cfg.get<number>('maxOutputTokens', 64000),
    enableRefusalFallback: cfg.get<boolean>('enableRefusalFallback', true),
  };
}
