import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  DispatchSpawnOpts,
  ENTRY_APPEAR_GRACE_MS,
  IWorkerPool,
  MeshWorkerRecord,
  MeshWorkerStatus,
  WorkerSpawnResult,
  MESH_STATE_DIR,
  accountConfigFile,
  applyProjectMcpTrust,
  bgIoTaskDir,
  bgWorktreeBranch,
  bgWorktreeName,
  bgWorktreePath,
  isGitWorkspace,
  meshError,
  meshStateFile,
  meshWorkerName,
  parseMeshWorkerName,
  parseSessionEntry,
  sanitizeAccountForName,
  sessionsDir,
  type SessionEntry,
} from './contract';
import { isPidAlive, readRegistry, type Registry } from '../registry';
import { exhaustedWindows, readUsageCache } from '../usage';

/**
 * mesh/pool — the `claude --bg` worker lifecycle for one workspace, plus the OWNERSHIP
 * LEDGER every teardown path reads. Implements the frozen IWorkerPool contract in
 * contract.ts. The pool OWNS only the `workers` array of the mesh state file; every
 * other field belongs to the server/gateway, so every mutation is a read-modify-write of
 * the WHOLE object that touches nothing but `workers` (contract MeshState).
 *
 * The mirror-image writer lives here too (mutateMeshOwnerFields): the SERVER's fields
 * (ownerPid, cwd, gatewayName, startedAt) are edited by a helper that cannot reach
 * `workers` at all. Both writers are in this file for one reason — they must take the SAME
 * lock, and a second lock implementation in the server would be a lock in name only.
 *
 * Three hard rules drive the design:
 *   - Placement is NOT here. The caller (bg-runner) picks the account with the same
 *     guards `-p` dispatch uses and owns the failover loop; a second placement
 *     implementation that must agree with the first is a bug factory.
 *   - Spawning is shell-free. The bootstrap prompt and every flag are passed as an argv
 *     array to child_process.spawn, so there is no interpolation surface.
 *   - A spawned worker is recorded BEFORE the spawn call returns to the caller, with the
 *     owning process stamped on it. A `--bg` session outlives this process by design, so
 *     an unrecorded worker is one nothing can ever find, stop, or reap.
 *
 * The ledger read/write helpers are module-level and exported, because the reaper writes
 * the same file from processes that have no pool instance (the extension host). One
 * read-modify-write implementation, one atomic-write discipline, no divergence.
 *
 * vscode-free, node18 stdlib only; imports restricted to ./contract, ../registry,
 * ../usage and node builtins (contract).
 */

/** How long a `claude --bg` spawn may take to exit 0 before we treat it as failed. */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * How long `claude stop <jobId>` may run before we give up on the clean path. Exported
 * because the reaper runs the same command against orphans (contract §5 P5.1).
 */
export const MESH_STOP_TIMEOUT_MS = 15_000;

/**
 * How long `claude rm <jobId>` may run. Same order as a stop: it removes a background job
 * and its worktree, both local filesystem work.
 */
export const MESH_RM_TIMEOUT_MS = 15_000;

/**
 * How the CLI reports a worktree it declined to remove because it holds uncommitted
 * changes ("kept — uncommitted changes", observed on 2.1.227 alongside a non-zero exit).
 * Matched case-insensitively on the combined output, and only as a REFUSAL classifier —
 * we never parse it for a path, and we never remove a worktree ourselves.
 */
const WORKTREE_KEPT_MARKERS = ['kept', 'uncommitted'];

/** Chars of captured output attached to a spawn/stop failure so the caller can see why. */
const OUTPUT_TAIL_CHARS = 600;

/**
 * Substring the CLI prints when `--bg` refuses bypassPermissions without the one-time
 * interactive disclaimer. Its presence on a non-zero exit is the ONLY trigger for the
 * single acceptEdits retry in spawnDispatchWorker (verified live, 2026-08-10).
 */
const DISCLAIMER_MARKER = 'requires accepting the disclaimer';

/** How long prepareAccount spins for its exclusive `.cco.lock` before skipping the seed (H1). */
const PREPARE_LOCK_TIMEOUT_MS = 2_000;
/** Poll interval while prepareAccount's `.cco.lock` is held by another cooperating writer. */
const PREPARE_LOCK_SPIN_MS = 25;

/**
 * How long a ledger lock holder is presumed alive before its lock is treated as abandoned
 * (F1). The protected section is one JSON read + a tmp+rename write — milliseconds — so a
 * lock older than this belongs to a process that died holding it. Same value and same
 * reasoning as registry.ts's LOCK_STALE_MS; the two files are locked by the same discipline.
 */
const LEDGER_LOCK_STALE_MS = 30_000;
/** Give up WAITING for a contended ledger lock after this long, then break + take it. */
const LEDGER_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
/** Poll interval while the ledger lock is held by a live, non-stale holder. */
const LEDGER_LOCK_SPIN_MS = 15;

/**
 * How long a STOPPED worker record is kept before every ledger write drops it (F5a).
 *
 * Seven days, because the record's only remaining readers after a stop are humans and the
 * status surfaces: mesh_status lists a stopped worker's surviving (dirty) worktree so
 * unmerged work is never silently lost, and a week is long enough to cover a weekend plus a
 * few working days before someone comes back to it. The ledger is rewritten by every
 * activity mark, so without a bound it grows without limit for the lifetime of a workspace.
 *
 * The pruning rule is deliberately one-sided: ONLY records that carry a finite stoppedAt
 * older than this are dropped. A record with no stoppedAt names a worker that may still be
 * alive, and dropping it would erase the only thing that can ever find, stop or reap that
 * session — the exact leak the ownership ledger exists to prevent.
 */
const LEDGER_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An account the pool may address: a registry worker account or the implicit 'main'
 * account. Placement no longer happens here, so a candidate is just an identity — the
 * set of dirs to scan for names and live entries.
 */
interface Candidate {
  name: string;
  configDir: string;
}

export interface ProcOutcome {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError: boolean;
}

/**
 * The `--bg` line reports the job id between two U+00B7 middle dots:
 * `backgrounded · <jobId> · <name>` (P10). · is written explicitly so the
 * pattern cannot silently rot to an ASCII '·' look-alike in an editor.
 */
const JOB_ID_RE = /backgrounded\s+·\s+([0-9a-f]+)\s+·\s+/;

/** Last `n` non-blank chars of `s`, ellipsized — enough context for a failure without a flood. */
function tail(s: string, n: number = OUTPUT_TAIL_CHARS): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `…${trimmed.slice(-n)}` : trimmed;
}

/**
 * Park the calling thread for `ms` WITHOUT a busy-loop — Atomics.wait on a private
 * SharedArrayBuffer parks with no CPU burn and needs no async plumbing, so the
 * synchronous prepareAccount lock spin (H1) can wait for a contended lock without
 * turning into an async function. Mirrors registry.ts's sleepSync.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

/**
 * Run a child process to completion, collecting stdout+stderr into one buffer.
 * Never rejects: a synchronous spawn throw, an async 'error', a non-zero exit and a
 * timeout all resolve a ProcOutcome the caller classifies. On timeout the child is
 * SIGKILLed and we settle from the subsequent 'close'. No shell — argv only.
 *
 * Exported for the reaper, which runs `claude stop` against orphaned workers and must
 * classify failure the same way (timeout vs spawn error vs non-zero exit).
 */
export function runMeshProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const done = (o: ProcOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (e) {
      resolve({ code: null, output: `spawn threw: ${(e as Error).message}`, timedOut: false, spawnError: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone — 'close' will still settle us
      }
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      output += d.toString();
    });
    child.stderr?.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', (e) => done({ code: null, output: `${output}\nspawn error: ${e.message}`, timedOut, spawnError: true }));
    child.on('close', (code) => done({ code, output, timedOut, spawnError: false }));
  });
}

/** What `claude rm <jobId>` did to a worker's background job and its worktree (A11). */
export interface JobRemoval {
  /** The job was removed; any worktree it owned was clean and is gone. */
  removed: boolean;
  /**
   * The platform REFUSED to remove the worktree because it holds uncommitted changes. This
   * is a SUCCESS path for us, not a failure: the worktree survives with work in it, and the
   * refusal is exactly the never-destroy-unmerged-work guarantee we rely on.
   */
  kept: boolean;
  /** Neither happened — the removal could not be carried out at all (best-effort teardown). */
  error?: string;
}

/**
 * Finish a teardown with `claude rm <jobId>` under the worker's OWN account (A11).
 *
 * Run AFTER the stop, never instead of it, and never with a force flag: the platform's
 * refusal to remove a dirty worktree is the only thing standing between an automatic
 * backstop and destroyed work. We also never touch a worktree by path — `git worktree
 * remove` from here would bypass exactly that protection.
 *
 * Safe by construction for the common case: a dispatch worker runs without Bash, so it
 * cannot commit, so any real edit leaves the worktree DIRTY and the platform keeps it. A
 * worktree that is clean at teardown is one that either produced nothing or has already
 * been merged and cleaned by the orchestrator.
 *
 * Never rejects — every outcome is classified for the caller.
 */
export async function removeWorkerJob(opts: {
  claudePath: string;
  cwd: string;
  configDir: string;
  jobId: string;
}): Promise<JobRemoval> {
  if (typeof opts.jobId !== 'string' || opts.jobId === '') {
    // An adopted worker may carry no job id at all; there is nothing to address.
    return { removed: false, kept: false, error: 'no job id recorded for this worker' };
  }
  const outcome = await runMeshProcess(
    opts.claudePath,
    ['rm', opts.jobId],
    opts.cwd,
    { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
    MESH_RM_TIMEOUT_MS,
  );
  if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
    return { removed: true, kept: false };
  }
  // A dirty worktree exits NON-ZERO and says so. Classified loosely (any marker, not all of
  // them) because this is the common teardown outcome — workers cannot commit, so nearly
  // every worktree is dirty — and a wording drift that pushed it into the error branch would
  // mislabel the normal case. The cost of a false "kept" is a status line pointing at a
  // worktree that is already gone; the cost of a false "error" is a lost warning.
  if (!outcome.timedOut && !outcome.spawnError && isWorktreeKeptOutput(outcome.output)) {
    return { removed: false, kept: true };
  }
  return {
    removed: false,
    kept: false,
    error: `claude rm ${opts.jobId} ${describeProcFailure(outcome)}: ${tail(outcome.output)}`,
  };
}

/** Does this `claude rm` output say the worktree was kept rather than removed? */
function isWorktreeKeptOutput(output: string): boolean {
  const lower = output.toLowerCase();
  return WORKTREE_KEPT_MARKERS.some((marker) => lower.includes(marker));
}

/** One-line cause of a non-successful ProcOutcome for an error message. */
export function describeProcFailure(o: ProcOutcome): string {
  if (o.timedOut) {
    return 'did not exit within the timeout';
  }
  if (o.spawnError) {
    return 'spawn error';
  }
  if (o.code !== 0) {
    return `exited with code ${o.code}`;
  }
  return 'no job id in output';
}

/** An epoch-ms stamp as ISO, or the raw number when it is not a representable date. */
function isoOrRaw(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

/* ------------------------------------------------------------------------- *
 * The workspace ledger — module-level, because the reaper writes the same file
 * from a process that has no pool instance (contract §5 seam pin)
 * ------------------------------------------------------------------------- */

/** Parse one workspace's state file as an opaque object, tolerating missing/corrupt. */
function readRawMeshState(cwd: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(meshStateFile(cwd), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // missing or corrupt — an empty object is the empty-state the contract asks for
  }
  return {};
}

/**
 * The well-formed worker records in a raw state object.
 *
 * Records survive across versions and the file is hand-editable, so this validates VALUES,
 * not just presence: a record missing any required field is dropped entirely, and an
 * optional field carrying the wrong type is dropped FROM the record (rather than dropping
 * the record, which would orphan a live worker). Unknown keys ride through untouched so a
 * newer writer's fields are not silently erased by an older reader's rewrite.
 */
function parseWorkerRecords(raw: Record<string, unknown>): MeshWorkerRecord[] {
  const arr = raw.workers;
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: MeshWorkerRecord[] = [];
  for (const item of arr) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as MeshWorkerRecord).name === 'string' &&
      typeof (item as MeshWorkerRecord).account === 'string' &&
      typeof (item as MeshWorkerRecord).configDir === 'string' &&
      typeof (item as MeshWorkerRecord).jobId === 'string' &&
      typeof (item as MeshWorkerRecord).model === 'string' &&
      typeof (item as MeshWorkerRecord).role === 'string' &&
      typeof (item as MeshWorkerRecord).spawnedAt === 'number' &&
      Number.isFinite((item as MeshWorkerRecord).spawnedAt)
    ) {
      // Cleared to undefined rather than deleted: JSON.stringify drops undefined values,
      // so a rewrite of this record heals the file, and every reader sees "absent".
      const bag = item as unknown as Record<string, unknown>;
      for (const field of ['pid', 'stoppedAt', 'ownerPid', 'ownerStartedAt', 'lastActivityAt']) {
        const v = bag[field];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
          bag[field] = undefined;
        }
      }
      for (const field of ['keepAlive', 'worktreeKept']) {
        if (bag[field] !== undefined && typeof bag[field] !== 'boolean') {
          bag[field] = undefined;
        }
      }
      for (const field of ['taskId', 'worktree', 'branch']) {
        if (bag[field] !== undefined && typeof bag[field] !== 'string') {
          bag[field] = undefined;
        }
      }
      out.push(item as MeshWorkerRecord);
    }
  }
  return out;
}

/** Every well-formed worker record in one workspace's ledger (missing file → none). */
export function readMeshWorkerRecords(cwd: string): MeshWorkerRecord[] {
  return parseWorkerRecords(readRawMeshState(cwd));
}

/* --- the ledger write lock (F1) ----------------------------------------- *
 * The state file is read-modify-written by BOTH processes: the MCP server (spawn records,
 * activity marks, stop marks, worktree verdicts) and the extension host (UI keep-alive, UI
 * cancel, the activation reaper). tmp+rename makes every write ATOMIC, so a reader can only
 * see a whole old or a whole new file — but atomicity does not prevent a LOST UPDATE: two
 * writers that both read the same snapshot and both rename produce a file missing one of the
 * edits. Observed consequence class: an activity mark or a keep-alive flag silently
 * evaporating, which is enough for the idle sweep to stop a worker a user is attached to.
 *
 * So every WRITE runs under an exclusive lock file beside the state file, and every READ
 * stays lock-free (a lock-free reader is already safe, and locking reads would serialize the
 * status surfaces against every mark). The acquire/release below is registry.ts's
 * withFileLock discipline, re-implemented here rather than imported because registry.ts's
 * copy is private and this module may not grow a dependency on registry internals.
 *
 * NAME COLLISION, and it is load-bearing: `<stateFile>.lock` is ALREADY TAKEN — server.ts's
 * meshLockFile() uses exactly that path for the workspace OWNER CLAIM marker, a long-lived
 * file (held for a whole server lifetime, published by hardlink, carrying a JSON owner
 * record) with completely different semantics from a millisecond-scale write lock. Taking it
 * here would be a disaster in both directions: our `wx` create would fight a claim that is
 * legitimately held for hours, and our stale-break — which judges by mtime and a leading pid
 * — would rename a LIVE owner's claim aside and hand the workspace to a second orchestrator.
 * So the write lock is a SIBLING file with its own suffix, `<stateFile>.write.lock`, and the
 * two never interact.
 * ------------------------------------------------------------------------ */

/** The exact bytes stored in a lock file, or undefined when it cannot be read. */
function readLedgerLockToken(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether the lock at `lockPath` is abandoned: older than LEDGER_LOCK_STALE_MS, or naming a
 * pid that is gone. A vanished lock is NOT stale — false there sends the caller back to the
 * exclusive create, which now succeeds. Any read error also reads as "not stale": waiting on
 * a lock we could not inspect is always safer than stomping one a live holder still owns.
 */
function ledgerLockIsStale(lockPath: string): boolean {
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > LEDGER_LOCK_STALE_MS) {
      return true;
    }
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) && pid > 0 && !isPidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Break an abandoned lock ATOMICALLY: rename it aside, then remove the side file. rename(2)
 * is atomic, so of several waiters that all judged one lock stale exactly ONE wins — the
 * losers' renames fail ENOENT and they simply retry the exclusive create. A blind unlink
 * here is the classic double-entry bug: two waiters each delete the file and each then win a
 * fresh `wx` create, entering the critical section together.
 */
function breakLedgerLock(lockPath: string): void {
  const sidePath = `${lockPath}.break.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, sidePath);
  } catch {
    return; // somebody else already broke or re-took it — retry the create
  }
  try {
    fs.unlinkSync(sidePath);
  } catch {
    // best effort — the lock NAME is free again, which is all the caller needs
  }
}

/**
 * The ledger WRITE lock's path. Never `${targetFile}.lock` — that name is the mesh owner
 * claim marker (server.ts meshLockFile), see the section note above.
 */
function ledgerLockPath(targetFile: string): string {
  return `${targetFile}.write.lock`;
}

/**
 * Run `fn` while holding the exclusive write lock beside `targetFile`. THROWS when it cannot be
 * created for a reason other than "already held" (permissions, missing parent dir); the
 * caller treats that as "skip this mutation".
 *
 * Identity-safe in both directions, exactly as registry.withFileLock:
 *   - after winning the `wx` create we stamp a unique token (pid FIRST, because
 *     ledgerLockIsStale reads it) and RE-READ the file; only our own bytes coming back prove
 *     we still hold it, because a concurrent stale-break could have removed and re-taken the
 *     name in the window between the create and the stamp;
 *   - on release we unlink ONLY while the token is still ours, so a lock a successor took
 *     after force-breaking a slow holder is never freed out from under it.
 * NOT reentrant: `fn` must never call back into anything that locks the SAME file.
 */
function withLedgerLock<T>(targetFile: string, fn: () => T): T {
  const lockPath = ledgerLockPath(targetFile);
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  // -1 is never closed: the loop only breaks once we hold a lock carrying our own token.
  let fd = -1;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, token);
      } catch {
        // ownership is decided by the re-read below, not by whether the stamp landed
      }
      if (readLedgerLockToken(lockPath) === token) {
        break;
      }
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fd = -1;
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      // Held by someone else. Break it only when it is genuinely abandoned, or when we have
      // waited past the deadline — a backstop against a wedged holder that never released.
      if (ledgerLockIsStale(lockPath) || Date.now() - started > LEDGER_LOCK_ACQUIRE_TIMEOUT_MS) {
        breakLedgerLock(lockPath);
        continue;
      }
      sleepSync(LEDGER_LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    if (readLedgerLockToken(lockPath) === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already removed (a stale-breaker got there first) — nothing to do
      }
    }
  }
}

/**
 * Drop worker records that have been STOPPED for longer than LEDGER_PRUNE_MS (F5a), in
 * place. Called on every ledger write, which is the only moment the file is rewritten
 * anyway, so the bound costs one pass over a short array and no extra io.
 *
 * The guard is on the VALUE, not the presence, of stoppedAt: a record whose stoppedAt is
 * absent, non-numeric or non-finite is a LIVE worker as far as anything here can tell and is
 * always kept. A future timestamp (clock skew, a hand-edited ledger) yields a negative age
 * and is likewise kept — the only records this can ever remove are provably-old dead ones.
 */
function pruneStoppedRecords(workers: MeshWorkerRecord[], now: number): void {
  for (let i = workers.length - 1; i >= 0; i--) {
    const stoppedAt = workers[i]?.stoppedAt;
    if (typeof stoppedAt === 'number' && Number.isFinite(stoppedAt) && now - stoppedAt > LEDGER_PRUNE_MS) {
      workers.splice(i, 1);
    }
  }
}

/**
 * Read-modify-write the WHOLE state object for one workspace, mutating only `workers`.
 * The read happens under the lock and immediately before the write, so the server-owned
 * fields (ownerPid, gatewayName, startedAt) are re-serialized from the freshest bytes on
 * disk, and unmodeled keys ride through untouched (contract: do not clobber fields we do not
 * own). The write is atomic — tmp file in the SAME dir, then rename (run-task.ts).
 *
 * Callers that may have nothing to change must check FIRST and skip the call: this
 * function creates the state file when it is absent, and a reaper sweep must never leave
 * an empty ledger behind for a workspace it merely looked at.
 *
 * F1: the whole read → mutate → write runs under the exclusive `<stateFile>.write.lock`
 * (NOT `<stateFile>.lock`, which is the owner claim marker — see the lock section), and the
 * state is RE-READ inside the lock, so two writers can no longer lose each other's edits.
 * This is the ONLY writer of the `workers` array in either process — the server's pool, the
 * reaper and the extension host's standalone helpers all funnel through here — so one lock
 * here covers every writer that exists. F5a: each write also prunes long-stopped records.
 *
 * TOTAL by construction. This runs inside drain loops, idle sweeps, activation sweeps and
 * shutdown handlers, none of which may die from a ledger problem, so an unusable lock (a
 * read-only mesh dir, a permission error) SKIPS the mutation instead of throwing or writing
 * unlocked: a skipped mark is a stale timestamp, whereas an unlocked write is a lost update
 * we would never detect. Write failures after the lock is held still propagate, exactly as
 * before this change — the callers that care already wrap their writes.
 */
export function mutateMeshWorkers(cwd: string, fn: (workers: MeshWorkerRecord[]) => void): void {
  const finalPath = meshStateFile(cwd);
  // Before the lock, because the lock file is a SIBLING of the state file: with the mesh dir
  // absent, the exclusive create would fail ENOENT and every mutation would be skipped.
  try {
    fs.mkdirSync(MESH_STATE_DIR, { recursive: true });
  } catch {
    // unwritable — withLedgerLock throws below and the mutation is skipped, as documented
  }
  // Distinguishes the two failure classes below: a throw from INSIDE the critical section
  // (the write failed, or the caller's mutator threw) is the caller's problem and is
  // re-raised unchanged; never having reached it means the lock was unusable, which is the
  // case we swallow.
  let entered = false;
  try {
    withLedgerLock(finalPath, () => {
      entered = true;
      // Re-read INSIDE the lock: a snapshot the caller took before calling us is not what we
      // serialize. Every field we do not own rides through untouched.
      const raw = readRawMeshState(cwd);
      const workers = parseWorkerRecords(raw);
      fn(workers);
      pruneStoppedRecords(workers, Date.now());
      raw.workers = workers;
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2));
      fs.renameSync(tmpPath, finalPath);
    });
  } catch (err) {
    if (entered) {
      throw err;
    }
    // Lock unusable (permissions, an unwritable mesh dir): skip this mutation rather than
    // write unlocked. The next mark/sweep retries, and every teardown path is idempotent.
  }
}

/**
 * The mesh state file's SERVER-owned fields: contract `MeshState` MINUS `workers`.
 *
 * The subtraction is the point. This type is what a mutator passed to
 * mutateMeshOwnerFields receives, so "the server never writes the workers array" is a
 * property of the SHAPE (there is no such field to assign, and assigning one is a compile
 * error) rather than a convention every future edit has to remember. The runtime half of
 * the same guarantee is in mutateMeshOwnerFields: only these four keys are ever copied back
 * onto the state object, so even an untyped caller cannot smuggle a `workers` through.
 */
export interface MeshOwnerFields {
  ownerPid: number;
  cwd: string;
  gatewayName: string;
  startedAt: number;
}

/**
 * A finite number, or 0. Zero is the RIGHT default for both owner-field numbers: it is
 * exactly what a clean shutdown writes into `ownerPid` to mean "nobody owns this
 * workspace", and every reader already draws that conclusion from it (a pid of 0 is never
 * alive, and `startedAt` 0 fails the M2 start-marker test), so an absent, non-numeric,
 * NaN or Infinite field degrades to "unowned" instead of to a value JSON cannot even
 * represent (JSON.stringify turns NaN/Infinity into `null`, which would make the file
 * unreadable to its own reader).
 */
function ownerNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A string, or ''. An absent or wrongly-typed cwd/gatewayName is not a usable one. */
function ownerString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The server-owned fields as they currently stand in a raw state object. */
function ownerFieldsFromRaw(raw: Record<string, unknown>): MeshOwnerFields {
  return {
    ownerPid: ownerNumber(raw.ownerPid),
    cwd: ownerString(raw.cwd),
    gatewayName: ownerString(raw.gatewayName),
    startedAt: ownerNumber(raw.startedAt),
  };
}

/**
 * Read-modify-write the SERVER-owned fields of one workspace's state file, under the SAME
 * exclusive write lock mutateMeshWorkers takes, touching `workers` never (F1 completeness).
 *
 * WHY this exists rather than a whole-object write in the server: the server used to write
 * the whole state file at two points — the owner claim at init and the release at shutdown —
 * each re-serializing a `workers` array it had read moments earlier. Both are the classic
 * lost update: the extension host can edit the ledger (a keep-alive mark, the tree cancel's
 * stopped mark, the activation reaper) between that read and that write, and the write puts
 * the stale array back. It is not theoretical — a keepAlive mark vanished in two of three
 * runs of the two-process hammer. Locking mutateMeshWorkers alone could never fix it,
 * because these writers did not go through it. Now nobody outside this file writes the
 * state file at all: the pool/reaper/extension write `workers` here, the server writes its
 * own fields here, and one lock covers both.
 *
 * The mutator receives the fields as they stand ON DISK, read inside the lock, so a
 * decision it makes about the current value (shutdown's "release only a lock that still
 * names me") is made against the freshest bytes rather than against a snapshot the caller
 * took before some await. Whatever it leaves behind is re-validated and copied back onto
 * the parsed state object; `workers` and every unmodeled key ride through UNTOUCHED — not
 * even re-parsed, so a record this module's own parser would have dropped as malformed
 * survives an owner-field write intact, and the F5a prune deliberately does not run here
 * (pruning is an edit to `workers`, and every write that owns that array already prunes).
 *
 * Writes NOTHING when the mutator changed no field. That is what makes a no-op call safe on
 * a workspace with no state file (shutdown when the record does not name us must not
 * resurrect a file somebody deleted), and it is why this function does not inherit
 * mutateMeshWorkers' "check first or you will create the file" caveat.
 *
 * Returns true when the on-disk owner fields reflect the mutation (including the "nothing
 * changed, nothing written" case) and FALSE when the lock was unusable and the mutation was
 * skipped — the same total behavior mutateMeshWorkers documents (never write unlocked,
 * never throw for a lock we could not take), reported rather than swallowed because the
 * owner CLAIM is not a best-effort mark: a claim that never reached disk must not be
 * mistaken for one that did. A throw from INSIDE the critical section (the write failed, or
 * the mutator threw) still propagates unchanged.
 *
 * NOT reentrant, and one lock ORDER exists in this system: the server holds its long-lived
 * claim marker (`<stateFile>.lock`) across a call to this function, which takes the
 * millisecond-scale write lock (`<stateFile>.write.lock`) inside it. Nothing anywhere takes
 * the claim marker while holding the write lock, so the two cannot deadlock — and a mutator
 * passed here must never call back into anything that locks the same file.
 */
export function mutateMeshOwnerFields(cwd: string, fn: (owner: MeshOwnerFields) => void): boolean {
  const finalPath = meshStateFile(cwd);
  // Before the lock, for the same reason as in mutateMeshWorkers: the lock file is a SIBLING
  // of the state file, so a missing mesh dir would fail every exclusive create.
  try {
    fs.mkdirSync(MESH_STATE_DIR, { recursive: true });
  } catch {
    // unwritable — withLedgerLock throws below and the mutation is skipped, as documented
  }
  let entered = false;
  try {
    withLedgerLock(finalPath, () => {
      entered = true;
      const raw = readRawMeshState(cwd);
      const before = ownerFieldsFromRaw(raw);
      const owner: MeshOwnerFields = { ...before };
      fn(owner);
      // Re-validated on the way out exactly as on the way in: a mutator reached from
      // untyped JS (or one that computed a NaN) must not be able to write a state file
      // that this module's own reader would reject.
      const next: MeshOwnerFields = {
        ownerPid: ownerNumber(owner.ownerPid),
        cwd: ownerString(owner.cwd),
        gatewayName: ownerString(owner.gatewayName),
        startedAt: ownerNumber(owner.startedAt),
      };
      if (
        next.ownerPid === before.ownerPid &&
        next.cwd === before.cwd &&
        next.gatewayName === before.gatewayName &&
        next.startedAt === before.startedAt
      ) {
        return; // nothing to say — and therefore no file to create and no bytes to churn
      }
      // The write-back WHITELIST — the runtime half of "cannot touch workers". Four named
      // keys, assigned onto the object read from disk; `raw.workers` is never on the left
      // of an assignment in this function.
      raw.ownerPid = next.ownerPid;
      raw.cwd = next.cwd;
      raw.gatewayName = next.gatewayName;
      raw.startedAt = next.startedAt;
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2));
      fs.renameSync(tmpPath, finalPath);
    });
  } catch (err) {
    if (entered) {
      throw err;
    }
    // Lock unusable: skip, and TELL the caller (see the doc comment) rather than reporting
    // a claim that was never recorded.
    return false;
  }
  return true;
}

/** Every parseable session entry in one dir; a missing dir or bad file is skipped, never fatal. */
export function readSessionEntries(dir: string): SessionEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) {
      continue;
    }
    try {
      const entry = parseSessionEntry(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (entry) {
        out.push(entry);
      }
    } catch {
      // a single unreadable/corrupt entry must not blind us to the rest of the dir
    }
  }
  return out;
}

/**
 * The session-registry entry naming `name` in one account's sessions dir. A REAL entry
 * always wins a bridge mirror of the same name: the mirror is a copy in a foreign account
 * whose pid we must never treat as that account's process — liveness and any kill must
 * follow the genuine entry.
 */
export function findSessionEntry(dir: string, name: string): SessionEntry | undefined {
  let mirror: SessionEntry | undefined;
  for (const e of readSessionEntries(dir)) {
    if (e.name !== name) {
      continue;
    }
    if (e.ccoMirror !== true) {
      return e;
    }
    mirror = mirror ?? e;
  }
  return mirror;
}

/**
 * Set or clear a worker's keep-alive mark in one workspace's ledger. The single
 * implementation behind BOTH mesh_keep_worker (through pool.setKeepAlive, in the server
 * process) and the extension's Attach action (through reaper.setWorkerKeepAlive, in the
 * extension host, which has no pool).
 *
 * A name we do not hold, or a record already stopped, is refused with the live worker
 * names — silently succeeding on a worker that does not exist is how an orchestrator ends
 * up believing a session it is about to hand the user is protected from the idle sweep.
 * Liveness is judged from the LEDGER (stoppedAt), not from session entries: a worker
 * spawned seconds ago has no entry yet, and refusing to protect it would invert the rule.
 */
export function setKeepAliveInLedger(
  cwd: string,
  name: string,
  keep: boolean,
): { ok: boolean; error?: string } {
  const records = readMeshWorkerRecords(cwd);
  const record = records.find((r) => r.name === name);
  if (!record) {
    const live = records.filter((r) => r.stoppedAt === undefined).map((r) => r.name);
    return {
      ok: false,
      error: meshError(
        'unknown_worker',
        `no attachable worker named "${name}" in this workspace; ` +
          (live.length > 0 ? `live workers: ${live.join(', ')}.` : 'no workers are live.'),
      ),
    };
  }
  if (record.stoppedAt !== undefined) {
    return {
      ok: false,
      error: meshError(
        'unknown_worker',
        `worker "${name}" was stopped at ${isoOrRaw(record.stoppedAt)}; keep-alive applies to live workers only.`,
      ),
    };
  }
  mutateMeshWorkers(cwd, (workers) => {
    const target = workers.find((r) => r.name === name);
    // Re-checked inside the read-modify-write: the worker may have been stopped between
    // the read above and this write, and marking a stopped worker keep-alive is a lie.
    if (target && target.stoppedAt === undefined) {
      target.keepAlive = keep;
    }
  });
  return { ok: true };
}

export class WorkerPool implements IWorkerPool {
  private readonly claudePath: string;
  private readonly cwd: string;
  private readonly mainConfigDir: string;
  /**
   * The project's `.mcp.json` server names, computed once and cached (undefined until
   * first read). A `claude --bg` worker halts at boot on the un-answerable MCP-trust
   * prompt for any server the project declares, so prepareAccount pre-seeds a decision
   * for each. A missing/unparseable `.mcp.json` caches [] — pre-seed then only records
   * folder trust. Never throws.
   */
  private mcpServerNames?: string[];
  /** Config dirs already pre-seeded this instance — a repeat spawn skips the read+write entirely. */
  private readonly preparedConfigDirs = new Set<string>();

  constructor(opts: { claudePath: string; cwd: string; mainConfigDir: string }) {
    this.claudePath = opts.claudePath;
    this.cwd = opts.cwd;
    this.mainConfigDir = opts.mainConfigDir;
  }

  /**
   * Spawn ONE attachable dispatch worker on the account the caller already chose, and
   * record it in the ledger before returning (contract §3 P3.1/P3.2).
   *
   * The sequence number is computed fresh here — 1 + the highest seq already used for this
   * account's sanitized token across the state file AND every candidate account's live
   * session registry — so back-to-back spawns never collide on a name.
   *
   * Permission-mode fallback (scenario-B lesson, 2026-08-10): `claude --bg` under
   * bypassPermissions demands a one-time INTERACTIVE disclaimer, so every headless spawn
   * on such a registry exits non-zero with DISCLAIMER_MARKER in its output. When that
   * exact failure is seen, the SAME attempt is retried ONCE with acceptEdits (only
   * --permission-mode differs). The first attempt never wrote a state record (that only
   * happens on success, below) nor a session entry (it exits before starting), so the
   * name/seq is reused unchanged and exactly one record is appended per successful spawn.
   * Each attempt carries its own SPAWN_TIMEOUT_MS window (runMeshProcess per call).
   */
  async spawnDispatchWorker(opts: DispatchSpawnOpts): Promise<WorkerSpawnResult> {
    // Every candidate account's session dir feeds nextSeq (M6): with the state file lost
    // or corrupt, a worker name must still be globally unique per sanitized token, even
    // across two accounts whose names sanitize to the same token. The spawning account's
    // own dir is appended explicitly — the caller may legitimately name an account this
    // registry snapshot no longer lists.
    const configDirs = [
      ...this.buildCandidates(readRegistry()).map((c) => c.configDir),
      opts.configDir,
    ];
    const seq = this.nextSeq(opts.account, configDirs);
    const name = meshWorkerName(this.cwd, opts.account, seq);

    // Pre-seed the chosen account's `.claude.json` ONCE (memoized) before spawning, so the
    // `--bg` worker boots without halting on the project's MCP-trust prompt. Runs before
    // the first attempt so both permission-mode attempts share one prepared account.
    // Safe/idempotent/atomic — see prepareAccount.
    this.prepareAccount(opts.configDir);

    // A10: the io dir is OUTSIDE the checkout, so it must be granted explicitly with
    // --add-dir. The runner has already created it (it wrote the task file there) — this
    // is belt and braces for the case where it has not, because --add-dir on a path that
    // does not exist is a spawn we would rather not risk.
    //
    // F2: the grant names THIS TASK's own subdirectory, never the shared workspace io root.
    // With the flat layout every concurrent worker held write access to every sibling's
    // result file, so one confused or hostile worker could settle another task's dispatch
    // with a forged report. Per-task grants make that an OS-level impossibility, and the
    // token check in the runner is the independent second gate behind it.
    const ioDir = bgIoTaskDir(this.cwd, opts.taskId);
    try {
      fs.mkdirSync(ioDir, { recursive: true });
    } catch {
      // unwritable io root: the spawn still runs and the dispatch fails visibly through
      // its own channels rather than being blocked here
    }
    // A11: in a git workspace every edit belongs in this task's own worktree. Detection is
    // the shared `.git`-exists check (contract isGitWorkspace) — no shell, no `git`
    // subprocess on the spawn path. A non-git workspace gets no -w at all: there is no
    // checkout to isolate, and the platform's write gate does not apply.
    const worktree = isGitWorkspace(this.cwd)
      ? {
          name: bgWorktreeName(opts.taskId),
          path: bgWorktreePath(opts.taskId),
          branch: bgWorktreeBranch(opts.taskId),
        }
      : undefined;

    // One attempt against a given permission mode; the retry reuses this verbatim with
    // only the mode swapped, so there is a single spawn code path (no duplication).
    const attempt = (permissionMode: string): Promise<ProcOutcome> => {
      // ARGV ORDER IS LOAD-BEARING: --allowedTools is a VARIADIC option ("comma or
      // space-separated list"), so a positional placed right after its value is
      // swallowed into the tool list. That exact footgun shipped once: the prompt
      // vanished, workers booted promptless and exited instantly with no transcript
      // (scenario-B re-run, 2026-08-10). A bounded option pair (--name) must sit
      // between --allowedTools and the positional prompt.
      const args = [
        '--bg',
        '--model',
        opts.model,
        '--permission-mode',
        permissionMode,
        // Both of these are bounded option PAIRS placed BEFORE --allowedTools on purpose:
        // the variadic-swallowing footgun below only threatens whatever follows the tool
        // list, so nothing but the --name pair may sit between it and the prompt.
        '--add-dir',
        ioDir,
        ...(worktree ? ['-w', worktree.name] : []),
        // NO Bash. `--bg` cannot use bypassPermissions (it demands a one-time interactive
        // disclaimer), so these workers run under acceptEdits — which auto-approves file
        // edits but NOT Bash. A worker with Bash in its tool list blocks at boot on the
        // first shell permission prompt it can never display (state 'blocked', verified
        // 2026-08-10). This matches the standing project rule that workers author files
        // and the orchestrator runs builds/tests/shell.
        '--allowedTools',
        'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep',
        '--name',
        name,
        opts.prompt,
      ];
      return runMeshProcess(
        this.claudePath,
        args,
        this.cwd,
        { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
        SPAWN_TIMEOUT_MS,
      );
    };

    let outcome = await attempt(opts.permissionMode);
    let note: string | undefined;
    // Retry ONLY the disclaimer failure: a genuine non-zero exit (not a timeout or a
    // spawn error) whose combined output names the interactive disclaimer. Every other
    // failure is left on the plain spawn_failed path below, unretried.
    if (
      !outcome.timedOut &&
      !outcome.spawnError &&
      outcome.code !== 0 &&
      outcome.output.includes(DISCLAIMER_MARKER)
    ) {
      outcome = await attempt('acceptEdits');
      note = 'permission mode downgraded to acceptEdits (bypassPermissions needs an interactive disclaimer)';
    }
    const jobId = JOB_ID_RE.exec(outcome.output)?.[1];
    // Success requires BOTH a parsed job id AND a clean exit-0 within the window; a
    // hang, an error, or a non-zero exit is a spawn failure with the output for triage.
    // The caller decides whether that failure is a quota error worth failing over.
    if (outcome.timedOut || outcome.spawnError || outcome.code !== 0 || !jobId) {
      // F9: the launcher failing does NOT prove no session started. `claude --bg` registers
      // the job before it prints the line we parse, so a launcher killed (or timed out)
      // after registration leaves a LIVE session that no ledger row names — invisible to
      // mesh_status, to the idle sweep, to the reaper and to the cap, forever. The name is
      // minted here and is unique per workspace+account+seq, so an entry carrying it can
      // only be the session this failed spawn started. Bounded and best-effort.
      const strandedNote = await this.stopStrandedSession(name, opts.configDir);
      return {
        ok: false,
        name,
        account: opts.account,
        model: opts.model,
        error: meshError(
          'spawn_failed',
          `worker ${name}: ${describeProcFailure(outcome)}. output: ${tail(outcome.output)}` +
            (strandedNote ? ` [${strandedNote}]` : ''),
        ),
      };
    }
    // Record the pid from the fresh session-registry entry when it already exists;
    // `--bg` returns before the entry is guaranteed written, so a missing pid is
    // tolerated (list()/workerLiveness() recover it live later).
    const entry = findSessionEntry(sessionsDir(opts.configDir), name);
    const now = Date.now();
    this.mutateWorkers((workers) => {
      workers.push({
        name,
        account: opts.account,
        configDir: opts.configDir,
        jobId,
        pid: entry?.pid,
        model: opts.model,
        role: 'dispatch',
        spawnedAt: now,
        taskId: opts.taskId,
        ownerPid: opts.ownerPid,
        ownerStartedAt: opts.ownerStartedAt,
        lastActivityAt: now,
        // Recorded even though it is derivable from the task id: the ledger is what the
        // reaper, the UI and mesh_status read, and a worktree holding unmerged work must be
        // findable from the record alone, long after this process is gone.
        ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
      });
    });
    return {
      ok: true,
      name,
      jobId,
      account: opts.account,
      model: opts.model,
      ...(note ? { note } : {}),
      ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
    };
  }

  /**
   * Stamp fresh activity on a worker (spawn, inbound message, dispatch settle) — the idle
   * sweep's clock. Deliberately a no-op when the name is not ours: an inbound message
   * naming an unknown worker must never create or rewrite this workspace's ledger.
   */
  markActivity(name: string): void {
    if (!readMeshWorkerRecords(this.cwd).some((r) => r.name === name)) {
      return;
    }
    const now = Date.now();
    this.mutateWorkers((workers) => {
      const rec = workers.find((r) => r.name === name);
      if (rec) {
        rec.lastActivityAt = now;
      }
    });
  }

  /** mesh_keep_worker's server-side path; the extension host uses reaper.setWorkerKeepAlive. */
  setKeepAlive(name: string, keep: boolean): { ok: boolean; error?: string } {
    return setKeepAliveInLedger(this.cwd, name, keep);
  }

  /**
   * How many attachable workers this workspace currently holds — the number the
   * meshMaxLiveWorkers cap is compared against (contract §3, session-B F4).
   *
   * A record counts when it has no stoppedAt AND (its session entry is alive OR it is
   * younger than ENTRY_APPEAR_GRACE_MS). Both halves are load-bearing. Counting only live
   * ENTRIES would let a fast batch overshoot the cap, because `claude --bg` returns before
   * the entry is written — every worker in the batch would look absent and every slot
   * free. Counting only RECORDS would let one stale record left by a crashed session brick
   * dispatch forever, since nothing would ever clear it.
   */
  liveOwnedCount(): number {
    const entries = this.liveEntriesByName();
    const now = Date.now();
    let live = 0;
    for (const rec of this.readWorkers()) {
      if (rec.stoppedAt !== undefined) {
        continue;
      }
      const entry = entries.get(rec.name);
      if ((entry !== undefined && isPidAlive(entry.pid)) || now - rec.spawnedAt < ENTRY_APPEAR_GRACE_MS) {
        live++;
      }
    }
    return live;
  }

  /**
   * Liveness of ONE worker, read from its OWN account's session dir (contract P3.4).
   * `entrySeen` is what separates "died" from "has not booted yet": a worker with no entry
   * at all may still be starting, while one whose entry exists with a dead pid is gone.
   */
  workerLiveness(name: string): { entrySeen: boolean; alive: boolean; pid?: number } {
    const record = this.readWorkers().find((r) => r.name === name);
    if (!record) {
      return { entrySeen: false, alive: false };
    }
    const entry = findSessionEntry(sessionsDir(record.configDir), name);
    if (!entry) {
      return { entrySeen: false, alive: false };
    }
    return { entrySeen: true, alive: isPidAlive(entry.pid), pid: entry.pid };
  }

  /**
   * Stop one worker: `claude stop <jobId>` under its OWN account, with a forced SIGKILL
   * fallback. Also CLEARS keepAlive — a stopped worker still carrying a keep-alive mark
   * would suppress nothing and mislead every later reader of the ledger.
   *
   * Every successful stop FINISHES with `claude rm <jobId>` (A11), so a worker's worktree
   * is cleaned up the moment it is clean and is otherwise KEPT and flagged. That is why
   * this is the single teardown door for every caller (mesh_stop_worker, the dispatch
   * timeout, the quota-stall path, the cancel hook, the idle sweep): duplicating the
   * finisher at six call sites is how one of them ends up forgetting it.
   *
   * The return type is widened past IWorkerPool's with an optional `note` (F3a) so a caller
   * holding the concrete pool can tell "we stopped it" from "it was already gone"; through
   * the interface the extra field is simply invisible.
   */
  async stop(
    name: string,
    opts?: { force?: boolean },
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    const record = this.readWorkers().find((r) => r.name === name);
    if (!record) {
      return { ok: false, error: meshError('unknown_worker', `no mesh worker named "${name}" in this workspace.`) };
    }
    // Clean path: `claude stop <jobId>` under the worker's OWN account — the job id
    // is only meaningful to the config dir that spawned it.
    const outcome = await runMeshProcess(
      this.claudePath,
      ['stop', record.jobId],
      this.cwd,
      { ...process.env, CLAUDE_CONFIG_DIR: record.configDir },
      MESH_STOP_TIMEOUT_MS,
    );
    if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
      // Marked BEFORE the removal: stoppedAt records that the session is down, and it must
      // land even if `claude rm` hangs out its whole timeout or fails outright.
      this.markStopped(name);
      await this.finishTeardown(record);
      return { ok: true };
    }
    // F3a — CONVERGENCE. `claude stop` fails for a session that is already gone (the user
    // stopped it from a terminal, the CLI reaped it, the machine restarted), and until this
    // branch existed nothing ever wrote stoppedAt for such a record: the idle sweep re-ran
    // the same doomed stop every 60 seconds forever, and mesh_status kept advertising a
    // worker that does not exist. A stop whose target is provably gone has ACHIEVED its
    // purpose, so it reports success and finishes the teardown like any other.
    //
    // "Provably gone" is deliberately stricter than `!alive`: a record younger than
    // ENTRY_APPEAR_GRACE_MS that has NEVER shown a session entry may simply still be booting
    // (`claude --bg` returns before its entry is written, and the cancel path stops workers
    // in exactly that window). Marking such a record stopped would hide a LIVE session from
    // the orphan reaper, which skips stopped records — a permanent leak, the one outcome
    // this whole module exists to prevent. In that window we fall through and report the
    // failure, and the caller retries.
    const liveness = this.workerLiveness(name);
    const stillBooting = !liveness.entrySeen && Date.now() - record.spawnedAt < ENTRY_APPEAR_GRACE_MS;
    if (!liveness.alive && !stillBooting) {
      this.markStopped(name);
      await this.finishTeardown(record);
      return { ok: true, note: 'session was already gone' };
    }
    // Forced path: `claude stop` failed and the caller accepts a hard kill. Signal the
    // pid the worker's OWN session-registry entry advertises, after confirming it is
    // that entry and still alive — never a bare recorded pid the OS may have recycled.
    if (opts?.force) {
      const entry = findSessionEntry(sessionsDir(record.configDir), name);
      if (entry && isPidAlive(entry.pid)) {
        try {
          process.kill(entry.pid, 'SIGKILL');
          this.markStopped(name);
          await this.finishTeardown(record);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `SIGKILL of pid ${entry.pid} failed: ${(e as Error).message}` };
        }
      }
      return {
        ok: false,
        error: `claude stop failed (${describeProcFailure(outcome)}) and no live registry pid was found to kill.`,
      };
    }
    return { ok: false, error: `claude stop failed: ${describeProcFailure(outcome)}` };
  }

  list(): MeshWorkerStatus[] {
    const cache = readUsageCache();
    const byName = this.liveEntriesByName();
    const now = Date.now();
    return this.readWorkers().map((rec) => {
      const entry = byName.get(rec.name);
      return {
        ...rec,
        alive: entry !== undefined && isPidAlive(entry.pid),
        registryStatus: typeof entry?.status === 'string' ? entry.status : undefined,
        registryUpdatedAt:
          typeof entry?.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : undefined,
        accountExhausted: exhaustedWindows(cache[rec.configDir], now).length > 0,
        // Single-quote the dir so a path with spaces stays one shell token when a
        // human pastes this into a terminal.
        attachCommand: `CLAUDE_CONFIG_DIR='${rec.configDir}' claude attach ${rec.jobId}`,
      };
    });
  }

  adopt(): number {
    const registry = readRegistry();
    const existing = new Set(this.readWorkers().map((r) => r.name));
    const now = Date.now();
    const adopted: MeshWorkerRecord[] = [];
    for (const c of this.buildCandidates(registry)) {
      for (const e of readSessionEntries(sessionsDir(c.configDir))) {
        // Adopt only REAL entries (skip bridge mirrors — their true account is
        // another config dir, and adopting one here would stop it under the wrong
        // account), whose name parses as ours for THIS workspace, whose process is
        // alive, and which the state file does not already track.
        if (e.ccoMirror === true || typeof e.name !== 'string') {
          continue;
        }
        if (!parseMeshWorkerName(e.name, this.cwd) || existing.has(e.name) || !isPidAlive(e.pid)) {
          continue;
        }
        existing.add(e.name);
        adopted.push({
          name: e.name,
          account: c.name,
          configDir: c.configDir,
          jobId: typeof e.jobId === 'string' ? e.jobId : '',
          pid: e.pid,
          model: '-',
          role: 'adopted',
          spawnedAt: typeof e.startedAt === 'number' && isFinite(e.startedAt) ? e.startedAt : now,
        });
      }
    }
    if (adopted.length > 0) {
      this.mutateWorkers((workers) => {
        for (const rec of adopted) {
          workers.push(rec);
        }
      });
    }
    return adopted.length;
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * Pre-seed one spawning account's `.claude.json` so a `claude --bg` worker boots
   * without halting on this project's MCP-trust prompt (contract applyProjectMcpTrust,
   * verified 2026-08-10). Runs once per account before any spawn on it.
   *
   * Every step is guarded so this can never corrupt the user's primary Claude Code
   * config nor throw out of spawn:
   *   - memoized per configDir → a repeat spawn on the same account does no work;
   *   - missing config → return without creating it (a never-logged-in account has no
   *     config to seed; the spawn fails later for its own reasons);
   *   - unreadable/unparseable/non-object config → return WITHOUT writing (never
   *     overwrite a config we could not parse);
   *   - applyProjectMcpTrust reports changed === false (decision already recorded) →
   *     no write (idempotent);
   *   - a genuine change is written ATOMICALLY: JSON to a tmp file in the SAME
   *     directory (so rename is atomic on one filesystem), then fs.renameSync over the
   *     original — a reader never sees a torn file, and the whole object is preserved
   *     (applyProjectMcpTrust mutates in place, so unknown fields ride through);
   *   - any error is swallowed → the spawn proceeds and either works or fails visibly,
   *     which is strictly better than a corrupted config.
   *
   * LOST-UPDATE GUARD (H1). This account's `.claude.json` is ALSO written by the
   * long-lived gateway `claude -p` child running under the same configDir (it rewrites
   * the file on OAuth token refresh). The atomic tmp+rename above prevents a torn READ
   * but NOT a lost UPDATE: a gateway write landing between our read and our rename would
   * be clobbered — potentially dropping a freshly refreshed token and logging the account
   * out. So the whole read-modify-write runs under an exclusive `${configPath}.cco.lock`
   * (fs.openSync 'wx' / O_EXCL), and the config is RE-READ inside the lock immediately
   * before the write — we never serialize a stale snapshot. If the lock cannot be taken
   * within PREPARE_LOCK_TIMEOUT_MS we SKIP seeding this pass (not memoized, so the next
   * spawn retries): a worker that boot-blocks on the MCP-trust prompt is visible, whereas
   * a clobbered config is silent corruption. The lock fd + file are ALWAYS released in a
   * finally.
   *
   * RESIDUAL, documented deliberately: this lock only excludes OTHER cooperating lock
   * users (another WorkerPool instance / this method). The gateway is a plain CLI and
   * does NOT take this lock, so it can still write between our in-lock re-read and our
   * rename. Re-reading directly before the write shrinks that window to the few
   * synchronous statements between them; it cannot close it entirely.
   */
  private prepareAccount(configDir: string): void {
    if (this.preparedConfigDirs.has(configDir)) {
      return;
    }
    try {
      const configPath = accountConfigFile(configDir);
      // Fast bail before taking a lock: a never-logged-in account has no config to seed,
      // and we must never CREATE one (re-checked under the lock below).
      if (!fs.existsSync(configPath)) {
        return;
      }
      const lockPath = `${configPath}.cco.lock`;
      let fd: number;
      try {
        fd = this.acquirePrepareLock(lockPath);
      } catch {
        // could not acquire within the budget (contended or unlockable) — skip seeding
        // THIS pass rather than risk a lost update. Not memoized: a later spawn retries.
        return;
      }
      try {
        // Re-read INSIDE the lock, immediately before writing: never serialize a stale
        // snapshot. A gateway token-refresh that landed between the existsSync above and
        // here is now part of what we read back, so our write cannot drop it.
        if (!fs.existsSync(configPath)) {
          // vanished under us (never re-create it)
          return;
        }
        let config: Record<string, unknown>;
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return;
          }
          config = parsed as Record<string, unknown>;
        } catch {
          // unparseable — never overwrite a config we could not read
          return;
        }
        const { changed } = applyProjectMcpTrust(config, this.cwd, this.projectMcpServerNames());
        if (!changed) {
          this.preparedConfigDirs.add(configDir);
          return;
        }
        const tmpPath = `${configPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        fs.renameSync(tmpPath, configPath);
        this.preparedConfigDirs.add(configDir);
      } finally {
        // ALWAYS release the lock: close the fd, then unlink the lock file. Both are
        // best-effort — a failure here cannot corrupt the config, only leave a stale
        // lock name (the next pass then skips until it is cleared).
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      }
    } catch {
      // any seed failure degrades to "worker may block", never a throw out of spawn
    }
  }

  /**
   * Acquire prepareAccount's exclusive advisory lock (H1) by an O_EXCL create ('wx')
   * that only one holder can win; on EEXIST spin (parked, not busy) up to
   * PREPARE_LOCK_TIMEOUT_MS. Returns the open fd on success; THROWS when the budget is
   * exhausted or the create fails for any non-EEXIST reason (permissions, missing parent
   * dir) — the caller treats a throw as "skip seeding this pass". Deliberately does NOT
   * break a lingering lock: the critical section is a millisecond-scale read+write, so
   * skipping (a visible boot-block) is the safe response to a stuck lock, never stomping
   * a lock a live cooperating writer may still hold.
   */
  private acquirePrepareLock(lockPath: string): number {
    const deadline = Date.now() + PREPARE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return fs.openSync(lockPath, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
          throw err;
        }
        sleepSync(PREPARE_LOCK_SPIN_MS);
      }
    }
  }

  /**
   * The project's `.mcp.json` server names, read once and cached. A missing or
   * unparseable file (or one without an object `mcpServers`) yields [] — prepareAccount
   * then only records folder trust. Wrapped so a bad `.mcp.json` never throws.
   */
  private projectMcpServerNames(): string[] {
    if (this.mcpServerNames !== undefined) {
      return this.mcpServerNames;
    }
    let names: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.cwd, '.mcp.json'), 'utf8'));
      const servers =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).mcpServers
          : undefined;
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        names = Object.keys(servers as Record<string, unknown>);
      }
    } catch {
      // missing or unparseable .mcp.json — no project servers to pre-decide
    }
    this.mcpServerNames = names;
    return names;
  }

  /** Registry workers plus the implicit 'main' account (contract account model). */
  private buildCandidates(registry: Registry): Candidate[] {
    const list: Candidate[] = registry.workers.map((w) => ({
      name: w.name,
      configDir: w.configDir,
    }));
    list.push({ name: 'main', configDir: this.mainConfigDir });
    return list;
  }

  /**
   * Every candidate account's live session entries indexed by name. A real (non-mirror)
   * entry always wins a bridge mirror of the same name, so liveness reflects the genuine
   * process rather than a copy written into a foreign account's dir.
   */
  private liveEntriesByName(): Map<string, SessionEntry> {
    const byName = new Map<string, SessionEntry>();
    for (const c of this.buildCandidates(readRegistry())) {
      for (const e of readSessionEntries(sessionsDir(c.configDir))) {
        if (typeof e.name !== 'string') {
          continue;
        }
        const existing = byName.get(e.name);
        if (!existing || (existing.ccoMirror === true && e.ccoMirror !== true)) {
          byName.set(e.name, e);
        }
      }
    }
    return byName;
  }

  /**
   * 1 + the highest sequence already used for this account's SANITIZED token, across
   * BOTH the state file and the live session registry of EVERY candidate account (M6).
   * The name embeds only the sanitized token, so two account names can sanitize to one
   * token — the name, not the account label, is what must stay unique. Scanning only the
   * chosen account's own session dir left a hole: with the shared state file lost or
   * corrupt, two same-token accounts could each compute the same seq and collide on a
   * name, so the scan sweeps every candidate's session dir (deduped, since a configDir
   * may repeat — e.g. 'main' pointing at a worker's dir).
   */
  private nextSeq(account: string, candidateConfigDirs: string[]): number {
    const token = sanitizeAccountForName(account);
    let max = 0;
    const consider = (nm: string | undefined): void => {
      if (typeof nm !== 'string') {
        return;
      }
      const parsed = parseMeshWorkerName(nm, this.cwd);
      if (parsed && parsed.account === token) {
        max = Math.max(max, parsed.seq);
      }
    };
    for (const rec of this.readWorkers()) {
      consider(rec.name);
    }
    for (const dir of new Set(candidateConfigDirs)) {
      for (const e of readSessionEntries(sessionsDir(dir))) {
        consider(e.name);
      }
    }
    return max + 1;
  }

  /**
   * The teardown finisher that runs after a stop (A11): `claude rm <jobId>`, then one
   * ledger write recording what became of the worktree.
   *
   * Three outcomes, three ledger states, and the distinction is the point:
   *   - removed  → worktreeKept = false: nothing survives, mesh_status stops advertising it;
   *   - kept     → worktreeKept = true : uncommitted work survives in the worktree and must
   *                be surfaced until a human or the orchestrator deals with it;
   *   - unknown  → the flag is LEFT ABSENT. A timed-out or failed `claude rm` proves
   *                nothing, and writing either verdict there would be a guess about
   *                somebody's unmerged work.
   * Total by construction: a teardown problem may never turn a successful stop into a
   * failed one, so nothing in here throws out to the caller.
   */
  private async finishTeardown(record: MeshWorkerRecord): Promise<void> {
    let removal: JobRemoval;
    try {
      removal = await removeWorkerJob({
        claudePath: this.claudePath,
        cwd: this.cwd,
        configDir: record.configDir,
        jobId: record.jobId,
      });
    } catch {
      return; // removeWorkerJob is documented never to reject; this is belt and braces
    }
    if (typeof record.worktree !== 'string' || (!removal.removed && !removal.kept)) {
      // No worktree to report on (non-git workspace, or a pre-A11 record), or no verdict.
      return;
    }
    const kept = removal.kept;
    try {
      this.mutateWorkers((workers) => {
        const rec = workers.find((r) => r.name === record.name);
        if (rec) {
          rec.worktreeKept = kept;
        }
      });
    } catch {
      // an unwritable ledger costs a status marker, never the stop itself
    }
  }

  /**
   * Stop a session a FAILED spawn may have left behind (F9), and describe what happened.
   *
   * Called only from the spawn-failure return path, where no ledger record was ever written:
   * this is the one moment a live `--bg` session can exist that nothing will ever find
   * again. The session registry is the only place it can be seen, and the minted name is the
   * only proof it is ours — so the entry is matched by EXACT name, and the pid is signalled
   * only after a FRESH read still shows that name alive (the same gate stop(force) uses;
   * pids are recycled).
   *
   * Bounded (one `claude stop` under the spawning account, one SIGKILL at most) and TOTAL:
   * every failure path returns a note or undefined, never a throw — this runs while we are
   * already reporting a spawn failure, and a cleanup problem must not replace that report.
   * Deliberately does NOT run `claude rm`: with no record we know nothing about a worktree
   * this session may have created, and the never-destroy-unmerged-work rule outranks tidiness.
   */
  private async stopStrandedSession(name: string, configDir: string): Promise<string | undefined> {
    try {
      const dir = sessionsDir(configDir);
      const entry = findSessionEntry(dir, name);
      if (!entry || !isPidAlive(entry.pid)) {
        return undefined; // the usual case: the launcher failed before anything started
      }
      const jobId = typeof entry.jobId === 'string' ? entry.jobId : '';
      if (jobId !== '') {
        const outcome = await runMeshProcess(
          this.claudePath,
          ['stop', jobId],
          this.cwd,
          { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          MESH_STOP_TIMEOUT_MS,
        );
        if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
          return `a session named ${name} had already started and was stopped`;
        }
      }
      const fresh = findSessionEntry(dir, name);
      if (!fresh || !isPidAlive(fresh.pid)) {
        return `a session named ${name} had started and has since exited`;
      }
      try {
        process.kill(fresh.pid, 'SIGKILL');
        return `a session named ${name} had already started and was killed (pid ${fresh.pid})`;
      } catch (e) {
        return (
          `a session named ${name} is still running (pid ${fresh.pid}) and could not be stopped: ` +
          `${(e as Error).message} — stop it manually`
        );
      }
    } catch {
      // the spawn failure is what the caller must see; this cleanup is strictly extra
      return undefined;
    }
  }

  /**
   * Set stoppedAt on a worker record and clear its keep-alive mark (a no-op if it
   * vanished between calls). The two always move together: keepAlive only ever suppresses
   * the idle sweep for a LIVE worker, so leaving it set on a stopped record would outlive
   * its meaning and mislead anything that later re-reads the ledger.
   */
  private markStopped(name: string): void {
    this.mutateWorkers((workers) => {
      const rec = workers.find((r) => r.name === name);
      if (rec) {
        rec.stoppedAt = Date.now();
        rec.keepAlive = false;
      }
    });
  }

  /* --- mesh state file (pool owns only `workers`) ------------------------ */

  /** This workspace's worker records (module-level helper, bound to our cwd). */
  private readWorkers(): MeshWorkerRecord[] {
    return readMeshWorkerRecords(this.cwd);
  }

  /** Read-modify-write this workspace's `workers` array (module-level helper, our cwd). */
  private mutateWorkers(fn: (workers: MeshWorkerRecord[]) => void): void {
    mutateMeshWorkers(this.cwd, fn);
  }
}
