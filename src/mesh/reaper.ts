import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ENTRY_APPEAR_GRACE_MS,
  MESH_STATE_DIR,
  bgIoRoot,
  meshError,
  meshWorkspaceHash,
  parseMeshWorkerName,
  sessionsDir,
  type MeshWorkerRecord,
} from './contract';
import {
  MESH_STOP_TIMEOUT_MS,
  describeProcFailure,
  findSessionEntry,
  mutateMeshWorkers,
  readMeshWorkerRecords,
  removeWorkerJob,
  runMeshProcess,
  setKeepAliveInLedger,
} from './pool';
import { isPidAlive, type TaskEvent } from '../registry';

/**
 * mesh/reaper — the guarantee that no `claude --bg` worker outlives its owning session
 * unnoticed (contract §5).
 *
 * A `--bg` session belongs to the CLI's background service, not to the process that
 * spawned it: killing the MCP server does not kill its workers, so without this module a
 * crashed server leaks a live Claude Code session per dispatch — burning quota, holding a
 * cap slot, and invisible to every surface. The ownership ledger exists to make that
 * recoverable: each record names the process that owns its lifetime, so ANY later process
 * can decide whether a live worker still has an owner.
 *
 * The rule, and it is deliberately conservative in one direction only:
 *   - owner ALIVE           → leave it alone (a live session owns it);
 *   - owner dead/absent + worker dead  → mark the record stopped (bookkeeping only);
 *   - owner dead/absent + worker ALIVE → orphan: stop it, finish with `claude rm <jobId>`
 *     so its worktree is cleaned up when clean and KEPT when it holds uncommitted work
 *     (A11), then mark it.
 * Nothing is ever signalled without first re-reading the session registry and confirming
 * the entry still names OUR worker and is still alive. A reaper that kills the wrong pid
 * is far worse than one that leaks a session, so every uncertain case leaves the worker
 * running and says so in the report.
 *
 * Runs in two places (P5.3): extension activation, sweeping every workspace's ledger, and
 * MCP server mesh init, sweeping only its own workspace after taking the owner lock. It
 * therefore executes in a process with NO pool instance, which is why the ledger's
 * read-modify-write helpers live at module level in pool.ts and are imported here rather
 * than re-implemented — one atomic-write discipline, no divergence.
 *
 * vscode-free, node18 stdlib only.
 */

export interface ReapReport {
  /** Workers this sweep actually stopped (a live orphan we shut down). */
  stopped: string[];
  /** Records whose stoppedAt this sweep wrote — the stopped ones plus dead-record bookkeeping. */
  marked: number;
  /** Human-readable failures; a sweep never throws, it reports. */
  errors: string[];
}

/**
 * Whether a record's owner is still running.
 *
 * A record with NO ownerPid counts as owner-ABSENT. That is the whole point: v1.4 records
 * and `adopt()`ed workers have no owning process, so nothing was ever going to stop them —
 * exactly the leak this rework closes.
 *
 * `ownerStartedAt` is carried but cannot be verified portably: isPidAlive cannot tell the
 * original owner from an unrelated process that recycled its pid. The residual is the
 * documented M2-style one (the same the owner lock lives with) and it fails SAFE — a
 * recycled pid makes us skip a worker we could have reaped, never kill one we should not.
 */
function ownerAlive(rec: MeshWorkerRecord): boolean {
  return typeof rec.ownerPid === 'number' && rec.ownerPid > 0 && isPidAlive(rec.ownerPid);
}

/**
 * A directory `claude stop` can be spawned in. The workspace is preferred (the CLI derives
 * project context from cwd), but a reaper often runs long after a project directory was
 * deleted or unmounted, and spawning into a missing cwd fails with ENOENT before the
 * command ever runs — so a live orphan would survive because its folder is gone.
 */
function spawnCwd(workspace: string): string {
  try {
    if (fs.statSync(workspace).isDirectory()) {
      return workspace;
    }
  } catch {
    // gone or unreadable — fall through to this process's own cwd
  }
  return process.cwd();
}

/**
 * The workspace directories whose ledgers this sweep covers. With `cwd` given it is that
 * one; otherwise every state file under MESH_STATE_DIR.
 *
 * A state file is only usable when it records its own workspace `cwd` AND that cwd hashes
 * to the file's own name: the workspace path is what P5.2's name check is evaluated
 * against, so a file we cannot tie to a workspace cannot be swept safely. A mismatch means
 * a hand-copied or corrupted ledger — reported, never acted on.
 */
function ledgerWorkspaces(cwd: string | undefined, errors: string[]): string[] {
  if (typeof cwd === 'string' && cwd !== '') {
    return [cwd];
  }
  let files: string[];
  try {
    files = fs.readdirSync(MESH_STATE_DIR);
  } catch {
    return []; // no mesh state has ever been written on this machine
  }
  const out: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    let workspace: unknown;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(MESH_STATE_DIR, file), 'utf8'));
      workspace = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).cwd : undefined;
    } catch {
      errors.push(`mesh state file ${file} is unreadable or corrupt — skipped.`);
      continue;
    }
    if (typeof workspace !== 'string' || workspace === '') {
      errors.push(`mesh state file ${file} records no workspace path — skipped.`);
      continue;
    }
    if (`${meshWorkspaceHash(workspace)}.json` !== file) {
      errors.push(`mesh state file ${file} does not belong to workspace ${workspace} — skipped.`);
      continue;
    }
    out.push(workspace);
  }
  return out;
}

/**
 * Mark records stopped in ONE read-modify-write, and only when there is something to mark.
 * Returns how many records this write actually stamped — records another process stopped
 * in the meantime keep their own (earlier) timestamp and are not counted.
 *
 * `worktreeVerdicts` (A11) rides the same write: name → true when `claude rm` KEPT the
 * worktree because it holds uncommitted work, false when the removal was confirmed. A name
 * absent from the map keeps whatever the record already said, because "we did not find out"
 * and "there is nothing there" are different facts about somebody's unmerged work.
 */
function markStopped(
  cwd: string,
  names: string[],
  worktreeVerdicts?: Map<string, boolean>,
): number {
  if (names.length === 0) {
    return 0; // never create or rewrite a ledger we merely inspected
  }
  const wanted = new Set(names);
  const now = Date.now();
  let marked = 0;
  mutateMeshWorkers(cwd, (workers) => {
    for (const rec of workers) {
      // Re-checked inside the write, because the ledger is re-read there: this is the
      // only place the decision and the write see the same snapshot.
      if (wanted.has(rec.name) && rec.stoppedAt === undefined) {
        rec.stoppedAt = now;
        rec.keepAlive = false;
        marked++;
      }
      const verdict = worktreeVerdicts?.get(rec.name);
      // Recorded regardless of who stamped stoppedAt: the worktree fact is ours either way.
      if (verdict !== undefined && typeof rec.worktree === 'string') {
        rec.worktreeKept = verdict;
      }
    }
  });
  return marked;
}

/** One workspace's sweep. Accumulates into `report`; never throws for a single worker. */
async function reapWorkspace(cwd: string, claudePath: string, report: ReapReport): Promise<void> {
  const toMark: string[] = [];
  /** Worktree verdicts from the `claude rm` that finishes each orphan stop (A11). */
  const worktreeVerdicts = new Map<string, boolean>();
  /**
   * Finish one orphan teardown: `claude rm <jobId>` after the session is down, so a clean
   * worktree is removed and a dirty one is KEPT and recorded (never force-removed, never
   * touched by path). Deliberately runs ONLY where this sweep actually stopped a live
   * orphan: the mark-only branches below stop nothing, and paying a bounded subprocess per
   * stale record would turn extension activation into a serial parade of `claude` spawns.
   */
  const finishTeardown = async (record: MeshWorkerRecord): Promise<void> => {
    try {
      const removal = await removeWorkerJob({
        claudePath,
        cwd: spawnCwd(cwd),
        configDir: record.configDir,
        jobId: record.jobId,
      });
      if (removal.removed || removal.kept) {
        worktreeVerdicts.set(record.name, removal.kept);
      } else if (removal.error !== undefined && typeof record.worktree === 'string') {
        report.errors.push(
          `${record.name}: stopped, but its worktree ${record.worktree} could not be cleaned up ` +
            `(${removal.error}). Inspect it before removing it — it may hold uncommitted work.`,
        );
      }
    } catch {
      // a teardown problem is never a reason to fail the sweep for other workers
    }
  };
  for (const rec of readMeshWorkerRecords(cwd)) {
    if (rec.stoppedAt !== undefined) {
      continue;
    }
    // P5.2: only names that parse as OURS for THIS workspace. A record naming a foreign
    // workspace's worker (a hand-edited ledger, a copied state file) is never touched —
    // the name is the only proof we have that the session belongs to us.
    if (!parseMeshWorkerName(rec.name, cwd)) {
      continue;
    }
    if (ownerAlive(rec)) {
      continue;
    }
    const dir = sessionsDir(rec.configDir);
    const entry = findSessionEntry(dir, rec.name);
    if (!entry || !isPidAlive(entry.pid)) {
      // Owner gone and worker gone: nothing to stop, the record is just stale.
      toMark.push(rec.name);
      continue;
    }
    // A live worker whose owner is gone — the orphan this module exists for. Clean path
    // first: `claude stop <jobId>` under the worker's OWN account, since the job id is
    // meaningless to any other config dir. runMeshProcess never rejects; a spawn failure,
    // a timeout and a non-zero exit all come back as an outcome to classify.
    const outcome = await runMeshProcess(
      claudePath,
      ['stop', rec.jobId],
      spawnCwd(cwd),
      { ...process.env, CLAUDE_CONFIG_DIR: rec.configDir },
      MESH_STOP_TIMEOUT_MS,
    );
    if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
      report.stopped.push(rec.name);
      toMark.push(rec.name);
      await finishTeardown(rec);
      continue;
    }
    // Forced path. The pid is re-derived from a FRESH read of the session registry and
    // re-confirmed to still name this worker and still be alive: the recorded pid may be
    // minutes old, and the OS recycles pids. This gate is the difference between killing
    // our orphan and killing a stranger's process.
    const fresh = findSessionEntry(dir, rec.name);
    if (!fresh || !isPidAlive(fresh.pid)) {
      // It exited on its own while `claude stop` was failing — nothing left to signal.
      toMark.push(rec.name);
      continue;
    }
    try {
      process.kill(fresh.pid, 'SIGKILL');
    } catch (e) {
      report.errors.push(
        `${rec.name}: claude stop failed (${describeProcFailure(outcome)}) and SIGKILL of pid ${fresh.pid} ` +
          `failed: ${(e as Error).message}. The worker is still running — stop it manually.`,
      );
      continue;
    }
    // Outside the try on purpose: only process.kill can throw here, and a teardown problem
    // must never be reported as a failed SIGKILL.
    report.stopped.push(rec.name);
    toMark.push(rec.name);
    await finishTeardown(rec);
  }
  report.marked += markStopped(cwd, toMark, worktreeVerdicts);
}

/**
 * Stop every attachable worker whose owning session is gone (contract §5 P5.1).
 *
 * Never throws: a sweep that fails on one workspace still covers the rest, and every
 * failure is reported rather than raised — this runs on extension activation and during
 * server init, neither of which may be blocked by a reaping problem.
 */
export async function reapOrphanedMeshWorkers(opts: {
  claudePath: string;
  cwd?: string;
}): Promise<ReapReport> {
  const report: ReapReport = { stopped: [], marked: 0, errors: [] };
  for (const workspace of ledgerWorkspaces(opts.cwd, report.errors)) {
    try {
      await reapWorkspace(workspace, opts.claudePath, report);
    } catch (e) {
      report.errors.push(`sweep of ${workspace} failed: ${(e as Error).message}`);
    }
  }
  return report;
}

/**
 * Clean-shutdown teardown (P4.9): stop every worker THIS process owns, without waiting.
 *
 * Fire-and-forget by necessity — this is called from the server's shutdown path, which
 * runs inside signal handlers and cannot await a `claude stop` per worker before the
 * process dies. Each stop is spawned detached and unref'd so it survives us long enough to
 * do its job, and the records are marked stopped immediately: if a stop silently fails,
 * the next reaper sweep finds a live worker with a dead owner and finishes the job.
 *
 * keepAlive is deliberately ignored here. The mark suppresses the IDLE sweep only; the
 * guarantee that no worker outlives its session outranks it, and a user who wants a
 * session to survive can start one themselves.
 *
 * The `claude rm` finisher (A11) is CHAINED on each stop's exit rather than skipped: it is
 * the only ordering available without a shell, and it is strictly best effort — if this
 * process exits before the stop child closes, the removal simply never runs and the
 * worktree stays on disk, which is the harmless direction. Nothing is ever force-removed.
 */
export function fireAndForgetStopOwned(cwd: string, ownerPid: number, claudePath: string): void {
  const ownedNames: string[] = [];
  try {
    for (const rec of readMeshWorkerRecords(cwd)) {
      if (rec.stoppedAt !== undefined || rec.ownerPid !== ownerPid) {
        continue;
      }
      try {
        const child = spawn(claudePath, ['stop', rec.jobId], {
          cwd: spawnCwd(cwd),
          env: { ...process.env, CLAUDE_CONFIG_DIR: rec.configDir },
          detached: true,
          stdio: 'ignore',
        });
        // An 'error' event with no listener THROWS, and a claudePath that no longer
        // resolves would then take down the shutdown path itself.
        child.on('error', () => undefined);
        child.on('exit', () => {
          try {
            const rm = spawn(claudePath, ['rm', rec.jobId], {
              cwd: spawnCwd(cwd),
              env: { ...process.env, CLAUDE_CONFIG_DIR: rec.configDir },
              detached: true,
              stdio: 'ignore',
            });
            rm.on('error', () => undefined);
            rm.unref();
          } catch {
            // the worktree simply stays; a dirty one would have been kept anyway
          }
        });
        child.unref();
      } catch {
        // could not even spawn the stop — the record is still marked below so the next
        // reaper sweep sees an ownerless live worker and stops it properly
      }
      ownedNames.push(rec.name);
    }
    markStopped(cwd, ownedNames);
  } catch {
    // shutdown must never throw
  }
}

/**
 * The mesh-aware liveness callback for registry.reapDeadTasks (contract §6 P6.1).
 *
 * A `--bg` dispatch task records NO pid (its worker is not our child), so the reaper's
 * normal pid checks see nothing alive and would orphan every in-flight attachable task the
 * moment the extension activated. This closure answers the only question that matters for
 * such a task: does this workspace's ledger still hold a live worker of that name?
 *
 * A worker younger than ENTRY_APPEAR_GRACE_MS counts as alive even without a session entry
 * — `claude --bg` returns before its entry is written, and a task dispatched seconds ago
 * must not be declared orphaned during that window. This is the same formula the pool's
 * cap accounting uses, and it errs only toward leaving a task running: the dispatch's own
 * timeout and death detection still settle it.
 *
 * Results are memoized for the life of the returned closure, so a sweep over hundreds of
 * task events reads each ledger and session dir once. Create a fresh closure per sweep.
 */
export function meshTaskAliveCheck(): (t: TaskEvent) => boolean {
  const ledgers = new Map<string, MeshWorkerRecord[]>();
  const verdicts = new Map<string, boolean>();
  let everyLedger: MeshWorkerRecord[] | undefined;

  const ledgerFor = (cwd: string): MeshWorkerRecord[] => {
    let records = ledgers.get(cwd);
    if (!records) {
      records = readMeshWorkerRecords(cwd);
      ledgers.set(cwd, records);
    }
    return records;
  };
  // An event with no cwd (older builds) still has to be answerable, so fall back to every
  // workspace's ledger — the worker NAME is workspace-scoped, so a match is unambiguous.
  const allLedgers = (): MeshWorkerRecord[] => {
    if (!everyLedger) {
      const all: MeshWorkerRecord[] = [];
      for (const workspace of ledgerWorkspaces(undefined, [])) {
        all.push(...ledgerFor(workspace));
      }
      everyLedger = all;
    }
    return everyLedger;
  };

  return (t: TaskEvent): boolean => {
    const name = t.meshWorker;
    if (typeof name !== 'string' || name === '') {
      return false; // not an attachable task — the caller's normal pid rules decide
    }
    const key = `${typeof t.cwd === 'string' ? t.cwd : ''}::${name}`;
    const cached = verdicts.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let alive = false;
    try {
      const records = typeof t.cwd === 'string' && t.cwd !== '' ? ledgerFor(t.cwd) : allLedgers();
      const rec = records.find((r) => r.name === name && r.stoppedAt === undefined);
      if (rec) {
        const entry = findSessionEntry(sessionsDir(rec.configDir), rec.name);
        alive =
          (entry !== undefined && isPidAlive(entry.pid)) ||
          Date.now() - rec.spawnedAt < ENTRY_APPEAR_GRACE_MS;
      }
    } catch {
      // an unreadable ledger means we cannot prove the task is alive; the caller then
      // reconciles it exactly as it would have without this callback
      alive = false;
    }
    verdicts.set(key, alive);
    return alive;
  };
}

/**
 * PROCESS-BOUNDARY keep-alive write (contract §5 seam pin).
 *
 * The pool lives in the MCP server process, so the extension host — which owns the Attach
 * tree action — has no pool instance to call. It writes the ledger directly through this
 * helper instead, using the exact same read-modify-write the reaper uses. The UI must set
 * the mark BEFORE opening a terminal on a worker, or the idle sweep can stop a session the
 * user is sitting inside.
 *
 * `pool.setKeepAlive` remains the server-side path for the mesh_keep_worker tool; both
 * call one implementation, so the two can never disagree about what the mark means.
 */
export function setWorkerKeepAlive(
  cwd: string,
  name: string,
  keep: boolean,
): { ok: boolean; error?: string } {
  return setKeepAliveInLedger(cwd, name, keep);
}

/** An epoch-ms stamp as ISO, or the raw number when it is not a representable date. */
function isoOrRaw(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

/**
 * PROCESS-BOUNDARY stop mark (F3c) — the twin of setWorkerKeepAlive above.
 *
 * The extension host cancels a mesh dispatch from the task tree: it runs `claude stop`
 * itself, because it has no pool instance to call. Before this helper existed, that path
 * stopped the session and left the ledger untouched — the record kept saying the worker was
 * live, so mesh_status advertised a dead session, the idle sweep kept re-issuing a stop that
 * could never succeed, and the cap counted a slot nobody could free. One ledger write closes
 * all three.
 *
 * Refusal semantics mirror the keep-alive helper exactly, and for the same reason: a name we
 * do not hold, or a record ALREADY carrying stoppedAt, is refused with the live worker names
 * rather than silently succeeding — the caller is about to tell a user what it did. The one
 * asymmetry is deliberate: when another writer stamps the record between our read and our
 * write, we report SUCCESS, because the caller's intent (this record is stopped) is exactly
 * the state on disk. A benign race must not surface as a failed cancel.
 *
 * keepAlive is cleared with the mark, as everywhere else: the flag only ever suppresses the
 * idle sweep for a LIVE worker, so leaving it set on a stopped record outlives its meaning.
 */
export function markWorkerStopped(cwd: string, name: string): { ok: boolean; error?: string } {
  let records: MeshWorkerRecord[];
  try {
    records = readMeshWorkerRecords(cwd);
  } catch {
    records = [];
  }
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
        `worker "${name}" was already stopped at ${isoOrRaw(record.stoppedAt)}.`,
      ),
    };
  }
  try {
    // markStopped re-checks stoppedAt INSIDE the locked read-modify-write, so a concurrent
    // stop cannot be overwritten with a later timestamp; 0 marked means somebody else got
    // there first, which is the state we wanted anyway.
    markStopped(cwd, [name]);
  } catch (e) {
    return { ok: false, error: `could not update the mesh ledger: ${(e as Error).message}` };
  }
  return { ok: true };
}

/**
 * How long an io artifact directory may sit untouched before a sweep removes it (F5b).
 *
 * 24 hours is safe against a LIVE task by construction, not by luck: a dispatch timeout is
 * clamped to at most 480 minutes (registry TIMEOUT_MINUTES_MAX), so a pending task's newest
 * artifact — its task file, written at spawn — can never be more than 8 hours old while the
 * task still exists. That is what lets this sweep run from the extension host, which has no
 * view of what is pending.
 */
const IO_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pre-rev-5 io artifact names: before per-task subdirectories, one workspace's io root held
 * flat `<taskId>.task.md` / `<taskId>.result.json` files. Hard-coded here on purpose — the
 * layout no longer exists in the contract, so these are HISTORY, not shared vocabulary — and
 * matched exactly, because nothing else will ever look at those files again: without this,
 * every workspace that ran a mesh dispatch before the upgrade keeps its litter forever.
 */
const LEGACY_FLAT_IO_SUFFIXES = ['.task.md', '.result.json'];

/**
 * The newest mtime anywhere in one task's io directory, as epoch ms.
 *
 * The DIRECTORY's own mtime is included, not just its children's: an empty artifact dir (a
 * spawn that failed before the task file landed, a worker that removed its own files) has no
 * children to date it, and treating that as age zero would keep it forever. An entry we
 * cannot stat contributes nothing rather than aborting the whole judgement — but if we could
 * not stat the DIRECTORY either, we return now, so an unreadable path is never removed on
 * the strength of a guess.
 */
function newestArtifactMtime(dir: string): number {
  // Initialized rather than left to definite-assignment analysis: the value is only ever
  // read after the try below has assigned it, and 0 is never returned to a caller.
  let newest = 0;
  try {
    newest = fs.statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return newest;
  }
  for (const name of names) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // vanished mid-sweep or unreadable — the other entries still date the directory
    }
  }
  return newest;
}

/**
 * Remove stale dispatch io artifacts and report how many were removed (F5b).
 *
 * The io channel lives OUTSIDE every checkout (A10), so nothing in the workspace ever
 * collects it: the settle path unlinks a task's directory on every normal outcome, and this
 * sweep is the backstop for the abnormal ones — a crashed server, a SIGKILLed worker, a
 * machine that went down mid-dispatch. It used to live inside the MCP server, which meant
 * litter was only ever collected while a mesh server was running; it lives here so BOTH the
 * server's idle sweep and extension activation can call it (a workspace whose mesh mode was
 * turned off still gets cleaned).
 *
 * With `cwd` given only that workspace's io root is swept; omitted, every workspace's is —
 * the roots are hash-named, so the parent directory is enumerated directly rather than
 * derived from a list of workspaces we would have to know about. A whole task subdirectory
 * goes at once (the unit of ownership is the task, and half a task's artifacts are worse
 * than none).
 *
 * TOTAL: called from activation and from a 60s interval, so nothing here throws — an
 * unreadable root, a vanished directory and a permission error each cost one skipped entry.
 */
export function sweepStaleIoArtifacts(opts: { cwd?: string }): number {
  const roots: string[] = [];
  try {
    if (typeof opts.cwd === 'string' && opts.cwd !== '') {
      roots.push(bgIoRoot(opts.cwd));
    } else {
      // The shared parent of every workspace's io root, derived FROM the contract builder
      // rather than re-spelled here: the layout under ROOT_DIR belongs to contract.ts, and a
      // second copy of that path is a divergence waiting to happen.
      const parent = path.dirname(bgIoRoot(process.cwd()));
      for (const name of fs.readdirSync(parent)) {
        roots.push(path.join(parent, name));
      }
    }
  } catch {
    return 0; // no bg dispatch has ever run on this machine, or the root is unreadable
  }
  const now = Date.now();
  let removed = 0;
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // this workspace never dispatched, or its root vanished under us
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      try {
        if (entry.isDirectory()) {
          if (now - newestArtifactMtime(full) <= IO_ARTIFACT_MAX_AGE_MS) {
            continue;
          }
          // recursive+force: the directory holds at most a task file and a result file, and
          // `force` makes a race with a concurrent settle-time unlink a no-op instead of a throw.
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          continue;
        }
        if (!LEGACY_FLAT_IO_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
          continue; // not ours: never "delete everything old" in a directory
        }
        if (now - fs.statSync(full).mtimeMs > IO_ARTIFACT_MAX_AGE_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // vanished, unreadable, or not removable — the next sweep tries again
      }
    }
  }
  return removed;
}
