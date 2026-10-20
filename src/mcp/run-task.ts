import * as fs from 'fs';
import * as path from 'path';
import { sliceOneLine } from '../displayText';
import { IO_TOKEN_PATTERN, ioTokenDigest } from '../ioToken';
import { normalizeModel } from '../platform';
import {
  appendTaskEvent,
  appendTaskNote,
  appendTerminalTaskEvent,
  ensureDirs,
  isTaskFileId,
  TASKS_DIR,
  type TaskEvent,
} from '../registry';
import { readTextSafe } from '../safeFs';
import { checkDispatchArgs, type CheckedDispatchArgs } from './dispatch-args';
import {
  CANCELLED_ERROR,
  runDispatchTask,
  type TaskBase,
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
 *   { id: string, cwd: string, args: <dispatch_task arguments>, ioToken?: string }
 * where `id` is the server-assigned task id (also the result.json key) and `args` is what the
 * server's argument check produced — checked AGAIN here (mcp/dispatch-args; the check is
 * idempotent), because what this process holds is a file's contents, not a typed value.
 * `ioToken` is this dispatch's per-task result token, minted by the dispatcher: this
 * supervisor records its SHA-256 on the RUNNING events it appends and writes the token itself
 * as `token` inside result.json, which is what proves that record to a reader — the waiting
 * server compares it with the value it minted, and a reconciler in a later session with the
 * digest in the log. It is a SECRET and goes nowhere else — see TaskSpec.ioToken. The spec
 * file is unlinked as soon as it is read, so the token is off disk before any worker exists.
 * `cwd` is informational — the server also spawns this process with that cwd, so process.cwd()
 * already matches and the core's task events carry the same workspace as the default path.
 * `detach` inside `args` is ignored here: this IS the detached run.
 *
 * THE ORDER OF WHAT THIS PROCESS LEAVES, which every reader of it may rely on: the task's final
 * output file, then its terminal event, then result.json — and only then does the process exit.
 * result.json is the LAST record, the hand-over to the waiting server: when it is there, the
 * log already says how the task ended and the output file is final, so everything the
 * orchestrator can ask about the task after the relay agrees with what it was just handed.
 * What follows for a reader that starts from the LOG: a terminal event does not promise that
 * result.json is there yet — it is written a moment later, and never at all if this process is
 * killed in between. Such a reader has the output file, which is final by then; the record
 * exists once this process has exited, or never. (The core fixes the first half of that order:
 * it appends the terminal event before it hands this process the result, and the text it hands
 * over says whether that append worked.)
 *
 * Deliberately vscode-free, like server.ts.
 */

/**
 * Read ceiling for the spec file: the largest prompt and system prompt the argument check
 * admits, each JSON-escaped at the worst rate there is (six bytes for a control character),
 * with room for the rest of the record.
 */
const SPEC_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Largest tasks/<id>.result.json this process writes, in bytes. It is the read cap of that
 * file's readers — the waiting server and the registry's reconcile ladder both refuse a larger
 * one rather than read it — so a record past it would be a result nobody can take. A result
 * whose record would not fit has its text cut to fit, with a last line saying where all of it
 * is (fitResultRecord): the output file holds the whole report either way.
 */
const RESULT_RECORD_MAX_BYTES = 1_048_576;

interface TaskSpec {
  id: string;
  cwd?: string;
  /** As read from the file — NOT yet the checked arguments (main checks them). */
  args: unknown;
  /**
   * This dispatch's per-task result token, minted by the dispatcher (server.dispatchDetached)
   * before this process existed.
   *
   * SECRET. A result file is believed only from a writer that knew it, so this supervisor puts
   * the token itself in exactly one place: the `token` field of the tasks/<id>.result.json it
   * writes. The task log gets its SHA-256 (ioToken.ioTokenDigest), on RUNNING events only — a
   * reader of the log can check a record against it and cannot produce one from it. Never a
   * terminal event, never the output file, never an error message, never stderr, never a
   * TaskResult that something else might render.
   *
   * OPTIONAL, and its absence is a first-class case rather than an error: a spec written by a
   * dispatcher that predates the token carries none (an older server still running after the
   * files beside it were replaced), and this supervisor then behaves exactly as it did before
   * the token existed — nothing about it on its events, none in its record. The dispatcher of
   * THIS version never writes such a spec: it refuses the dispatch when it cannot mint one.
   */
  ioToken?: string;
}

/**
 * Append one RUNNING event carrying the DIGEST of this dispatch's io token.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. The core (task-runner) authors the running events, and it
 * has no hook that carries a token: it appends its OWN running event immediately after each of
 * the two callbacks this supervisor can reach. So the supervisor re-appends the same identity
 * with the digest attached. A reader resolves a task's expectation from the FIRST event of its
 * history that carries one (registry.firstRecordedIoToken), and the first of these is appended
 * before the worker process exists. Duplicate running events are the norm on this path already
 * — the core appends two or three per attempt — so nothing downstream is surprised by another.
 *
 * `base` is spread, so the runtime fields the core puts on it that its TaskBase type does not
 * name (promptPreview above all) travel onto this event too and the surfaces that render a
 * running task lose nothing by this event superseding the core's.
 *
 * NEVER THROWS: appendTaskEvent throws when the log refuses a write, and the run must not die
 * because a gate could not be recorded. The waiting server is unaffected — it checks the record
 * against the token it holds — and a later reconcile of this task then judges the record as it
 * would one from a dispatch older than tokens.
 */
function appendTokenRunningEvent(base: TaskBase, ioTokenSha256: string, workerPid?: number): void {
  try {
    const event: TaskEvent = {
      ...base,
      ts: Date.now(),
      status: 'running',
      supervisorPid: process.pid,
      ...(workerPid === undefined
        ? {}
        : // Mirrors the core's own pid event: on POSIX the worker is spawned detached, so its
          // pid is also its group id and an outside killer can take the whole tree; Windows has
          // no POSIX group, so pgid stays unset and the extension falls back to taskkill /T.
          { pid: workerPid, pgid: process.platform === 'win32' ? undefined : workerPid }),
      detachIoTokenSha256: ioTokenSha256,
    };
    appendTaskEvent(event);
  } catch {
    // the log is refusing writes — the dispatch itself is unaffected
  }
}

/**
 * The `model` this supervisor writes into a terminal record it has to author ITSELF, because
 * the core threw before recording anything: the dispatch's requested model in the same
 * normalized form the core's own events use, or `-` when it named none or named something that
 * is not a model. Always a string, whatever the spec held.
 */
function recordedModel(raw: unknown): string {
  return normalizeModel(raw) ?? '-';
}

/**
 * Read + validate the task spec from the argv/env-named JSON file.
 *
 * Through safeFs, without following a link: the path is a name in the tasks directory, which
 * anything running as this user can replace, and a plain read of a FIFO put there would park
 * this process for ever with the server waiting on it. A spec that is not the regular file the
 * server wrote is a spec that could not be read.
 */
function readSpec(specPath: string): TaskSpec {
  const read = readTextSafe(specPath, SPEC_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    throw new Error(`task spec could not be read (${read.reason} — ${read.detail}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    // Our own words: the parser's message quotes the text it could not read, and this text
    // holds the dispatch's token and its prompt.
    throw new Error('task spec is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('task spec must be a JSON object.');
  }
  const spec = parsed as Partial<TaskSpec>;
  // The id becomes file names in the tasks directory (the result record, the cancel marker,
  // the report), so it has to be one that can only ever name files there.
  if (!isTaskFileId(spec.id)) {
    throw new Error('task spec must carry an "id" that is a task id.');
  }
  if (typeof spec.args !== 'object' || spec.args === null || Array.isArray(spec.args)) {
    throw new Error('task spec must carry an "args" object of dispatch_task arguments.');
  }
  // Validated BY VALUE, and never a reason to fail the dispatch. Absent (an older dispatcher)
  // and present-but-not-a-token (a truncated or hand-edited spec) both read as "this dispatch
  // has no token" rather than propagating a value no result could ever be checked against.
  const ioToken =
    typeof spec.ioToken === 'string' && IO_TOKEN_PATTERN.test(spec.ioToken) ? spec.ioToken : undefined;
  return { id: spec.id, cwd: typeof spec.cwd === 'string' ? spec.cwd : undefined, args: spec.args, ioToken };
}

/** Where the whole report of task `id` is: its output file, by the id. */
function reportFile(id: string): string {
  return path.join(TASKS_DIR, `${id}.md`);
}

/**
 * The line a cut text ends with. The same words the server puts under a result it had to cut
 * for a tool result (server.relayText), so that a reader meets one form of this notice.
 */
function truncationNotice(id: string): string {
  return `\n…[truncated — the full report is in ${reportFile(id)}]`;
}

/**
 * The JSON text of the record for `result`, at most RESULT_RECORD_MAX_BYTES.
 *
 * A record that fits is written whole — every ordinary result. One that does not has its `text`
 * cut to the longest head that fits, never through a character, followed by the notice above;
 * an `error` that repeats the text (a failed task's record carries its message in both) is
 * replaced by the same cut text, and any other long `error` is cut on its own.
 *
 * The limit is on the BYTES OF THE FILE, so the cut is found against the serialized record: a
 * report's JSON form can be several times its length (a control character costs six bytes).
 * Nothing is lost by the cut — the output file was written, whole, before this record.
 */
function fitResultRecord(result: TaskResult, ioToken: string | undefined): string {
  // THE ECHO. `token` is the field name the session-worker channel of record already uses for
  // the same job (bg-runner's readResultFile compares `rec.token`), reused deliberately so the
  // validator on the other side never needs two spellings for one concept.
  //
  // Attached HERE, at serialization, and never set on the TaskResult itself: that object is the
  // one the core hands out through onResult and the one a future caller is most likely to log,
  // relay or render, and a secret that rides a shared field eventually rides it everywhere.
  //
  // `undefined` is dropped by JSON.stringify, so a dispatch that carries no token writes the
  // record without the field.
  const serialize = (text: string, error: string | undefined): string =>
    JSON.stringify({ ...result, text, error, token: ioToken });
  const whole = serialize(result.text, result.error);
  if (Buffer.byteLength(whole, 'utf8') <= RESULT_RECORD_MAX_BYTES) {
    return whole;
  }
  const notice = truncationNotice(result.id);
  const errorRepeatsText = result.error !== undefined && result.error === result.text;
  const otherError =
    result.error === undefined || errorRepeatsText
      ? result.error
      : result.error.length > 2000
        ? `${sliceOneLine(result.error, 2000)}…`
        : result.error;
  const withHead = (units: number): string => {
    const text = `${sliceOneLine(result.text, units)}${notice}`;
    return serialize(text, errorRepeatsText ? text : otherError);
  };
  // The longest head, in UTF-16 units, whose record fits. Every unit costs at least one byte
  // of the file, so no head longer than the limit can.
  let fits = 0;
  let tooLong = Math.min(result.text.length, RESULT_RECORD_MAX_BYTES) + 1;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (Buffer.byteLength(withHead(middle), 'utf8') <= RESULT_RECORD_MAX_BYTES) {
      fits = middle;
    } else {
      tooLong = middle;
    }
  }
  return withHead(fits);
}

/**
 * Write result.json atomically (contract §5.4): tmp in the SAME directory, then
 * rename — an atomic replace on one filesystem, so the server (reading only the
 * final name) never sees a torn file. One supervisor owns one id, so the fixed
 * `.tmp` suffix never collides.
 */
function writeResultJson(result: TaskResult, ioToken: string | undefined): void {
  const finalPath = path.join(TASKS_DIR, `${result.id}.result.json`);
  const tmpPath = `${finalPath}.tmp`;
  const record = fitResultRecord(result, ioToken);
  // BOTH NAMES ARE THIS SUPERVISOR'S ALONE — nothing else is entitled to put anything at either
  // — and both sit in a directory a dispatched worker can write, so what is found at them is
  // cleared, never written through and never allowed to stop the record:
  //
  //   - the temp name is created EXCLUSIVELY (`wx`), owner-only. A plain write would follow a
  //     symbolic link left at that name and put the record — which holds the token — into
  //     whatever file the link names;
  //   - the rename replaces a file, a link or a pipe at the final name by itself, but not a
  //     directory: one planted there would leave a finished task with no record, and the server
  //     waiting on it would report a supervisor that died. It is removed (`rmSync` takes a link
  //     itself, never what it points at) and the rename is made again.
  //
  // Three rounds, for something that puts its thing back between the two steps; after that the
  // error stands, and the run ends without a record.
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(tmpPath, { recursive: true, force: true });
      fs.writeFileSync(tmpPath, record, { mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch {
        fs.rmSync(finalPath, { recursive: true, force: true });
        fs.renameSync(tmpPath, finalPath);
      }
      return;
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

/** The record of a dispatch that ended with `message` before the core recorded anything. */
function refusedResult(id: string, message: string, model: string): TaskResult {
  return {
    id,
    status: 'error',
    text: message,
    worker: '-',
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: message,
  };
}

async function main(): Promise<void> {
  const specPath = process.argv[2] ?? process.env.CCO_TASK_SPEC;
  if (!specPath) {
    throw new Error('run-task requires a task-spec file path as argv[2] or in CCO_TASK_SPEC.');
  }
  // The spec carries this dispatch's SECRET io token, so it is unlinked the instant its bytes
  // are in memory — in a `finally`, so a malformed spec does not leave the token on disk either
  // — instead of at the end of the run as before. That moves its lifetime on disk from "the
  // whole dispatch, alongside the very directory the worker writes its result into" to a few
  // milliseconds at process start, before any worker process exists. Nothing needs it later:
  // registry's isOurSupervisor anchors on the spec path as it appears in this process's ARGV,
  // which survives the unlink, and the server's own spawn-failure cleanup swallows an ENOENT.
  let spec: TaskSpec;
  try {
    spec = readSpec(specPath);
  } finally {
    cleanupSpec(specPath);
  }
  const { id, ioToken } = spec;
  ensureDirs();
  // The arguments, by the one rule every entry uses. The server checked them before it wrote
  // the spec, so a refusal here means the file is not what the server wrote; it is relayed like
  // any other refusal — an error record, nothing started, nothing logged.
  const checked = checkDispatchArgs(spec.args);
  if (!checked.ok) {
    writeResultJson(refusedResult(id, checked.error, '-'), ioToken);
    return;
  }
  const args = checked.args;
  // What the task log gets instead of the token. Hashed once: every stamp of this dispatch
  // carries the same value.
  const ioTokenSha256 = ioToken === undefined ? undefined : ioTokenDigest(ioToken);

  // Cancel handling (contract §7 R7): the server drops tasks/<id>.cancel AND signals
  // the worker's group directly (the supervisor is not in the server's childrenByTask).
  // The marker makes the core's shouldAbort checkpoints break with no failover; the
  // killed worker surfaces as a WorkerKilledError that the abort short-circuit swallows.
  // On the resulting CANCELLED_ERROR this supervisor — the sole author of a detach
  // task's terminal events — records the `cancelled` event + an error result.json.
  const cancelMarker = path.join(TASKS_DIR, `${id}.cancel`);

  let captured: TaskResult | undefined;
  // The identity of the attempt currently running, captured from the core's onTrack so the
  // post-spawn stamp below can re-append the SAME task identity with the digest on it, and so
  // a cancellation can be recorded against the attempt it interrupted. Reset on every failover
  // attempt, because each attempt has its own worker and model.
  let currentBase: TaskBase | undefined;
  /**
   * Re-append the running event with the worker's pid AND the token digest, one tick from now.
   *
   * setImmediate, not a direct call: the core appends its own pid-carrying running event
   * SYNCHRONOUSLY after the hook that calls this returns, so a direct call would be superseded
   * by an event without the digest. Deferring by one tick puts this one last. The callback
   * cannot throw (appendTokenRunningEvent), so nothing here can end the process from a tick
   * nobody awaits.
   *
   * One body for both spawn hooks: a `claude -p` child and another vendor's CLI are the same
   * thing to this stamp — a pid the latest running event must carry together with the digest.
   */
  const stampWorkerPid = (workerPid: number | undefined): void => {
    const base = currentBase;
    if (ioTokenSha256 === undefined || base === undefined) {
      return;
    }
    setImmediate(() => appendTokenRunningEvent(base, ioTokenSha256, workerPid));
  };
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
    // WHERE THE DIGEST IS RECORDED — on the RUNNING events, never on a terminal one.
    //
    // The core appends a running event immediately BEFORE this hook (the identity event) and
    // another immediately AFTER onSpawn (the pid event), and neither carries the digest. These
    // two stamps bracket them: this one lands right after the identity event — before the
    // worker process exists, which is what makes it the FIRST event of the task to carry one —
    // and the onSpawn one is deferred to the next tick so it lands right after the pid event.
    onTrack: (base) => {
      currentBase = base;
      if (ioTokenSha256 !== undefined) {
        appendTokenRunningEvent(base, ioTokenSha256);
      }
    },
    onSpawn: (_taskId, child) => stampWorkerPid(child.pid),
    // A worker on another vendor's CLI. Its `kill` is not kept: this supervisor stops a worker
    // the way it always has — the server drops the cancel marker and signals the group recorded
    // on the task's running event, which is the event stamped here.
    onProviderSpawn: (_taskId, _kill, pid) => stampWorkerPid(pid),
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
        recordDetachCancelled(id, args, currentBase, ioToken);
        cleanupMarker(cancelMarker);
        return;
      }
      // A pre-terminal throw (unrecognized model, no workers, frontier block) fires before
      // onResult. Synthesize an error result so the waiting server relays the same failure the
      // default path would, instead of hanging to its ceiling. The model goes through
      // normalizeModel, never the argument as given: this path is exactly where an unrecognized
      // one lands, and a record's `model` must be a model or `-`.
      captured = refusedResult(id, message, recordedModel(args.model));
    }
  }

  if (captured !== undefined) {
    writeResultJson(captured, ioToken);
  }
  // A cancel that arrived after the run had already settled leaves the marker behind;
  // remove it best-effort too, so a cancelled detach task never litters a permanent
  // tasks/<id>.cancel (F6). A no-op when no cancel happened (the usual case).
  cleanupMarker(cancelMarker);
}

/**
 * Author the terminal record for a cancelled detach task (contract §7 R7): a `cancelled` error
 * event, a note in the output file, and an error result.json so a still-waiting server relays
 * the cancellation rather than hanging to its timeout ceiling — in that order, the order of
 * every outcome this process records (see the header). Best-effort on the first two;
 * result.json is the authoritative retrieval record.
 *
 * The identity of the record comes from what this process HOLDS, never from a read of the task
 * log: the title is the checked argument, the worker and model are those of the attempt the
 * cancellation interrupted (`attempt`, the base the core handed to onTrack) or, when it came
 * before any attempt, what the dispatch asked for; and the output file is the one the task's id
 * names. The log is a file anything running as this user can append to, and a line of it is not
 * an authority on what this task was or which file gets a note.
 */
function recordDetachCancelled(
  id: string,
  args: CheckedDispatchArgs,
  attempt: TaskBase | undefined,
  ioToken: string | undefined,
): void {
  // The core puts more on the base than its TaskBase type names; each is taken by value.
  const extra = (attempt ?? {}) as { provider?: unknown; promptPreview?: unknown };
  const worker = attempt?.worker ?? args.worker ?? '-';
  const model = attempt?.model ?? recordedModel(args.model);
  // Who chose that model: what the core decided for the attempt the cancellation interrupted,
  // by value like everything else read off the base. Before any attempt, a model this record
  // names can only have come from the dispatch; one it does not name (`-`) has no source.
  const decided = attempt?.modelSource;
  const modelSource: TaskEvent['modelSource'] =
    decided === 'dispatch' || decided === 'worker' || decided === 'cli'
      ? decided
      : attempt === undefined && model !== '-'
        ? 'dispatch'
        : undefined;
  const event: TaskEvent = {
    id,
    title: args.title,
    worker,
    model,
    modelSource,
    // Carried over so a cancelled task on another vendor's worker keeps its vendor on the
    // event every surface reads last. Absent for a Claude Code task, as on every other event.
    provider: typeof extra.provider === 'string' ? extra.provider : undefined,
    outputFile: reportFile(id),
    cwd: process.cwd(),
    promptPreview: typeof extra.promptPreview === 'string' ? extra.promptPreview : undefined,
    supervisorPid: process.pid,
    ts: Date.now(),
    status: 'error',
    error: DETACH_CANCELLED_ERROR,
  };
  // At most one terminal event per task (registry.appendTerminalTaskEvent): a task the log
  // already records as ended — another surface closed it first — gets neither a second event
  // nor a second note. The result.json below is written either way.
  let closed = true;
  try {
    closed = appendTerminalTaskEvent(event).closed;
  } catch {
    // the result.json below is the authoritative record — a log append failure is non-fatal
  }
  if (closed) {
    appendTaskNote(event, `\n\n---\n\nCANCELLED: ${DETACH_CANCELLED_ERROR} (${new Date().toISOString()})\n`);
  }
  writeResultJson(
    {
      id,
      status: 'error',
      text: DETACH_CANCELLED_ERROR,
      worker,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: DETACH_CANCELLED_ERROR,
    },
    ioToken,
  );
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
    try {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // no stderr to write to — the exit code still says the run failed
    }
    process.exit(1);
  },
);
