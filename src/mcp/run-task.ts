import * as fs from 'fs';
import * as path from 'path';
import {
  appendOutputNote,
  appendTaskEvent,
  ensureDirs,
  latestEventById,
  TASKS_DIR,
} from '../registry';
import {
  CANCELLED_ERROR,
  runDispatchTask,
  type DispatchArgs,
  type TaskResult,
  type TaskRunContext,
} from './task-runner';

/**
 * Terminal message recorded when a detach task is cancelled via its `.cancel` marker
 * (contract §7 R7). Distinct from the default path's CANCELLED_ERROR: a detach cancel
 * is authored by the supervisor (sole author of a detach task's terminal events),
 * not by the server.
 */
const DETACH_CANCELLED_ERROR = 'cancelled — detach task cancelled by the orchestrator session';

/**
 * run-task — the standalone DETACH SUPERVISOR. The server spawns
 * `node out/mcp/run-task.js <specPath>` detached + unref'd (see dispatchDetached in
 * server.ts) so this process owns ONE dispatch task, survives the server's death,
 * and is the SOLE author of that task's terminal events, DONE/FAILED output file,
 * and tasks/<id>.result.json (contract §5.1–5.4). The server only reads result.json
 * to relay the identical inline string.
 *
 * Task-spec contract (argv[2] → a JSON file the server wrote under TASKS_DIR):
 *   { id: string, cwd: string, args: DispatchArgs }
 * where `id` is the server-assigned task id (also the result.json key) and `args`
 * is the verbatim dispatch_task arguments. `cwd` is informational — the server also
 * spawns this process with that cwd, so process.cwd() already matches and the core's
 * task events carry the same workspace as the default path. `detach` inside `args`
 * is ignored here: this IS the detached run.
 *
 * Deliberately vscode-free, like server.ts.
 */

interface TaskSpec {
  id: string;
  cwd?: string;
  args: DispatchArgs;
}

/** Read + validate the task spec from the argv/env-named JSON file. */
function readSpec(specPath: string): TaskSpec {
  const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('task spec must be a JSON object.');
  }
  const spec = parsed as Partial<TaskSpec>;
  if (typeof spec.id !== 'string' || !spec.id) {
    throw new Error('task spec must carry a string "id".');
  }
  if (typeof spec.args !== 'object' || spec.args === null || Array.isArray(spec.args)) {
    throw new Error('task spec must carry an "args" object of dispatch_task arguments.');
  }
  return { id: spec.id, cwd: spec.cwd, args: spec.args };
}

/**
 * Write result.json atomically (contract §5.4): tmp in the SAME directory, then
 * rename — an atomic replace on one filesystem, so the server (reading only the
 * final name) never sees a torn file. One supervisor owns one id, so the fixed
 * `.tmp` suffix never collides.
 */
function writeResultJson(result: TaskResult): void {
  const finalPath = path.join(TASKS_DIR, `${result.id}.result.json`);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result));
  fs.renameSync(tmpPath, finalPath);
}

async function main(): Promise<void> {
  const specPath = process.argv[2] ?? process.env.CCO_TASK_SPEC;
  if (!specPath) {
    throw new Error('run-task requires a task-spec file path as argv[2] or in CCO_TASK_SPEC.');
  }
  const { id, args } = readSpec(specPath);
  ensureDirs();

  // Cancel handling (contract §7 R7): the server drops tasks/<id>.cancel AND signals
  // the worker's group directly (the supervisor is not in the server's childrenByTask).
  // The marker makes the core's shouldAbort checkpoints break with no failover; the
  // killed worker surfaces as a WorkerKilledError that the abort short-circuit swallows.
  // On the resulting CANCELLED_ERROR this supervisor — the sole author of a detach
  // task's terminal events — records the `cancelled` event + an error result.json.
  const cancelMarker = path.join(TASKS_DIR, `${id}.cancel`);

  let captured: TaskResult | undefined;
  const ctx: TaskRunContext = {
    preassignedId: id,
    supervisorPid: process.pid,
    shouldAbort: () => {
      try {
        return fs.existsSync(cancelMarker);
      } catch {
        return false;
      }
    },
    onTrack: () => {},
    onSpawn: () => {},
    onSettle: () => {},
    onResult: (r) => {
      captured = r;
    },
  };

  try {
    await runDispatchTask(args, ctx);
  } catch (err) {
    if (captured === undefined) {
      const message = err instanceof Error ? err.message : String(err);
      // A cancel-marker abort throws CANCELLED_ERROR. The supervisor is the sole
      // author of a detach task's terminal record, so it writes the `cancelled`
      // event + an error result.json here (contract §7 R7) and does NOT fail over.
      if (message === CANCELLED_ERROR) {
        recordDetachCancelled(id, args);
        cleanupSpec(specPath);
        cleanupMarker(cancelMarker);
        return;
      }
      // A pre-terminal throw (empty prompt, no workers, frontier block) fires before
      // onResult. Synthesize an error result so the waiting server relays the same
      // failure the default path would, instead of hanging to its ceiling.
      captured = {
        id,
        status: 'error',
        text: message,
        worker: '-',
        model: args.model ?? '-',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: message,
      };
    }
  }

  if (captured !== undefined) {
    writeResultJson(captured);
  }
  cleanupSpec(specPath);
  // A cancel that arrived after the run had already settled leaves the marker behind;
  // remove it best-effort too, so a cancelled detach task never litters a permanent
  // tasks/<id>.cancel (F6). A no-op when no cancel happened (the usual case).
  cleanupMarker(cancelMarker);
}

/**
 * Author the terminal record for a cancelled detach task (contract §7 R7). Reuses
 * the task's latest running event for its worker/model/output-file identity (the core
 * threw before writing any terminal record), then appends a `cancelled` error event,
 * notes the output file, and writes an error result.json so a still-waiting server
 * relays the cancellation rather than hanging to its timeout ceiling. Best-effort on
 * each side effect; result.json is the authoritative retrieval record.
 */
function recordDetachCancelled(id: string, args: DispatchArgs): void {
  const latest = latestEventById(id);
  const outputFile = latest?.outputFile ?? path.join(TASKS_DIR, `${id}.md`);
  const worker = latest?.worker ?? args.worker ?? '-';
  const model = latest?.model ?? args.model ?? '-';
  try {
    appendTaskEvent({
      id,
      title: latest?.title ?? args.title ?? 'untitled task',
      worker,
      model,
      outputFile,
      cwd: latest?.cwd ?? process.cwd(),
      promptPreview: latest?.promptPreview,
      supervisorPid: process.pid,
      ts: Date.now(),
      status: 'error',
      error: DETACH_CANCELLED_ERROR,
    });
  } catch {
    // the result.json below is the authoritative record — a log append failure is non-fatal
  }
  appendOutputNote(
    outputFile,
    `\n\n---\n\nCANCELLED: ${DETACH_CANCELLED_ERROR} (${new Date().toISOString()})\n`,
  );
  writeResultJson({
    id,
    status: 'error',
    text: DETACH_CANCELLED_ERROR,
    worker,
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: DETACH_CANCELLED_ERROR,
  });
}

/** The spec is single-use — its data is in memory once read. Best effort. */
function cleanupSpec(specPath: string): void {
  try {
    fs.unlinkSync(specPath);
  } catch {
    // already gone / racing cleanup — the supervisor has what it needs
  }
}

/**
 * Best-effort removal of this task's tasks/<id>.cancel marker (F6). The server drops it on
 * a detach cancel and nothing else ever cleaned it up, so a cancelled task left a permanent
 * marker on disk. A no-op (ENOENT) when the task was not cancelled.
 */
function cleanupMarker(markerPath: string): void {
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // absent (no cancel happened) or already removed — nothing to do
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
