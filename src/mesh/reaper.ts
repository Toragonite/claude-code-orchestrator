import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  BG_RESULT_FILE_MAX_BYTES,
  ENTRY_APPEAR_GRACE_MS,
  MESH_STATE_DIR,
  bgIoRoot,
  bgResultFile,
  bgTokenRefusal,
  meshError,
  meshWorkspaceHash,
  parseMeshWorkerName,
  sessionsDir,
  type MeshWorkerRecord,
  type SessionEntry,
} from './contract';
import {
  DIR_SCAN_MAX_ENTRIES,
  MESH_STATE_FILE_MAX_BYTES,
  MESH_STOP_TIMEOUT_MS,
  claudeAccountDirCheck,
  claudeAccounts,
  claudeCommandFor,
  describeProcFailure,
  listDirCapped,
  logMeshProblem,
  entryPidIsWorker,
  manualStopAdvice,
  mutateMeshWorkers,
  readMeshWorkerRecords,
  readSessionEntries,
  removeWorkerJob,
  runMeshProcess,
  shellToken,
  spawnVettedConfigDir,
  unconfirmedPidRefusal,
  type ClaudeAccountCheck,
  type LedgerReadNote,
} from './pool';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { hasRecordedIoToken, ioTokenProves, type RecordedIoToken } from '../ioToken';
import { claudeEnv, hostConfigDir } from '../platform';
import { readTextSafe, statFileSafe } from '../safeFs';
import { probeBgLiveness } from './bg-liveness';
import { readWorkerTranscript, sessionModelOf, type TranscriptRead } from './transcript';
import {
  REGISTRY_FILE,
  TIMEOUT_MINUTES_MAX,
  TIMEOUT_MINUTES_MIN,
  claudeWorkers,
  firstRecordedIoToken,
  isPidAlive,
  isTaskFileId,
  processStartedAt,
  readRegistry,
  readRegistryChecked,
  readTaskEventsChecked,
  reapDeadTasks,
  type Registry,
  type TaskEvent,
  type TaskRecovery,
} from '../registry';

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
 * The rule, and it is deliberately conservative in one direction only. For a record that is
 * NOT yet marked stopped:
 *   - owner ALIVE                       → leave it alone (a live session owns it);
 *   - owner dead/absent + worker PROVEN dead  → mark the record stopped (bookkeeping only);
 *   - owner dead/absent + worker PROVEN ALIVE → orphan: stop it, finish with `claude rm <jobId>`
 *     so its worktree is cleaned up when clean and KEPT when it holds uncommitted work
 *     (A11), then mark it;
 *   - owner dead/absent + liveness UNKNOWN    → leave the record completely alone.
 * And for a record that IS already marked stopped — the class this module used to skip outright,
 * which is where its third ghost source lived (below). This class is REPORT ONLY: every such
 * record is EXAMINED against whatever this sweep already learned, nothing about it is signalled,
 * marked or pruned, and it never causes a listing to be spawned on its own account (see the
 * probe gate in reapWorkspace — a listing WRITES to the account it targets, and this class has
 * no action to fund with that write):
 *   - worker PROVEN ALIVE   → the stop that wrote that mark never landed. REPORT it apart
 *     (`ghostsFound`) and leave it running. The automatic stop this branch used to perform is
 *     gone (see the loop itself for why), so the record's ghost keeps burning quota until a
 *     human stops it — reporting is the whole of what happens here;
 *   - worker PROVEN absent  → correctly stopped; it is history, and history is not re-stopped;
 *   - liveness UNKNOWN      → leave the record exactly as it is, as before this class existed.
 * Nothing is ever signalled without first re-reading the session registry and confirming
 * the entry still belongs to OUR job id and is still alive. A reaper that kills the wrong pid
 * is far worse than one that leaks a session, so every uncertain case leaves the worker
 * running and says so in the report.
 *
 * WHERE LIVENESS COMES FROM, and why it is not what it used to be. Until this rework the
 * liveness of a `--bg` worker was read off the session registry by an entry looked up BY
 * NAME, then `isPidAlive(entry.pid)`. The name was the fault: worker NAMES are REUSED across
 * generations, so a name lookup can resolve to a different session entirely — a previous
 * generation's dead entry, or another live worker's. The result was the defect this module
 * now exists to prevent: a LIVE worker whose owner had died was judged "gone", stamped with
 * `stoppedAt`, and then skipped by every later sweep (the loop opens on
 * `stoppedAt !== undefined`) — a ghost, running forever, invisible and unreapable.
 * Liveness here is `mesh/bg-liveness.probeBgLiveness` — the CLI's own listing, taken under
 * the worker's account and keyed on the record's `jobId` — and the NAME is never an identity
 * anywhere in this module's reaping paths. (The dispatching session answers the same question
 * for its OWN pending tasks from the session registry BY JOB ID, pool.sessionStatus; a sweep
 * that may STOP a worker nobody owns any more keeps the CLI's own listing as its evidence.)
 *
 * WHY A STOPPED RECORD IS RE-EXAMINED AT ALL — the third ghost source, and the most common
 * one. `fireAndForgetStopOwned` runs from a signal handler: it spawns a detached `claude stop`
 * per owned worker and marks every one of those records stopped WITHOUT being able to await a
 * single exit, because the process is dying. A stop that silently fails therefore leaves a LIVE
 * worker behind a record that says stopped — and the ownerless-orphan branch below opens on
 * `stoppedAt === undefined`, so that record was never looked at again. Same ghost, same
 * consequence (a session running forever, invisible to every surface and unreapable), reached
 * on every clean shutdown rather than on a crash. So a marked record is revisited — but ONLY to
 * be SEEN, and only on `=== true`. What revisiting buys is now exactly one thing: the anomaly is
 * NAMED in the report instead of being invisible. It is not closed here; nothing this module
 * does stops such a worker (the stop was removed — see the loop), so the honest description of
 * this class is "a ghost detector", not "a ghost reaper". The `=== true` strictness is still the
 * whole safety of even looking: on this class UNKNOWN is the ordinary state of every history row
 * on a machine whose accounts cannot be listed.
 *
 * THE BINDING SAFETY RULE. A record may be marked stopped, or removed, ONLY on POSITIVE
 * evidence that its worker is NOT live. The probe reports the config dirs it could not read;
 * a record whose dir is in that list — or whose dir we were never allowed to ask about, or
 * whose job id cannot be matched against a listing — is UNKNOWN, and unknown leaves the record
 * completely alone: not marked, not stopped, not pruned. Under-reaping costs quota and a
 * cluttered ledger; over-reaping destroys somebody's running work — and only one of those is
 * recoverable.
 *
 * THE CHANNEL OF RECORD, AND THE ONE PLACE `done` MAY COME FROM. A `--bg` dispatch worker
 * reports completion by WRITING `bgResultFile(cwd, taskId)` — `<ROOT_DIR>/bg-io/<wsHash>/
 * <taskId>/result.json` — which contract.ts calls the channel of record and which the live
 * in-session path (mcp/bg-runner) settles every dispatch from. That file used to be read by
 * NOBODY outside the dispatching session: the cross-session recovery ladder's first rung reads
 * `registry.readResultJson(id)`, a DIFFERENT path (`<ROOT_DIR>/tasks/<id>.result.json`, the
 * detach task's file), so a worker that finished at minute 30 of a 45-minute dispatch, wrote a
 * complete report, and then parked on a later turn that asked a question was settled
 * `error: orphaned`
 * at the next activation, had its open question published as "the last thing the worker said",
 * and had the real report deleted by the 24h artifact sweep. `meshTaskRecovery` therefore reads
 * the bg result file FIRST, before any transcript.
 *
 * Why `done` is legitimate from that file and illegitimate from a transcript, since the two
 * look superficially alike (both are "something the worker left behind"):
 *   - the RESULT FILE is a DELIBERATE ACT OF REPORTING COMPLETION. The worker was told exactly
 *     one way to finish its dispatch, it wrote a JSON object whose `status` it chose, into its
 *     own granted directory, carrying the per-task result token it read off its task file. The
 *     worker cannot write that file by accident or by continuing to think out loud.
 *     A valid one IS the deliverable, so recovering it as `done` recovers exactly what the live
 *     path would have recorded — and NOT recovering it throws somebody's finished work away.
 *   - a TURN BOUNDARY is merely the model STOPPING TALKING, and turns are PLURAL per dispatch
 *     (measured: 6 of 35 background transcripts carried more than one `end_turn` row, up to 4;
 *     17 carried none). A worker parks at a turn boundary when it stops to ask instead of
 *     acting, or to answer a steering message — so `turn: 'ended'` is evidence about the
 *     conversation, never a claim about the task. The transcript rung therefore stays exactly what it was: EVIDENCE,
 *     delivered through `unresolved`, never `done`.
 * The result file is validated BY VALUE to the same standard the live path applies — size cap,
 * parse, the per-task result TOKEN, the embedded taskId, the status and report shapes — because
 * it is written by another process into a directory a worker was granted. What the token is
 * checked against here is what the TASK LOG recorded when the task was dispatched: the SHA-256
 * of the token (or, from an earlier build, the token itself), taken from the FIRST event of the
 * task that carries one (registry.firstRecordedIoToken) and decided by ioToken.ioTokenProves.
 * A history that recorded nothing checkable refuses the file — the task file beside the result
 * is never consulted for an expectation: it sits in the same directory, and a pair of files
 * that agree with each other proves only that one hand wrote both. What the gate stops and what
 * it cannot is stated once, at contract.BG_IO_TOKEN_HEADER_PREFIX. A file that is present and
 * FAILS that validation is never silently ignored: "a result file was present and refused" and
 * "no result file existed" are different operational facts, so the refusal is stated in the
 * unresolved text — and a refusal whose reason is consistent with a write still in progress does
 * not settle the task at all (see BgResultRecovery).
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
  /**
   * Workers found RUNNING behind a record that already said stopped — OBSERVED, never stopped.
   *
   * Deliberately NOT folded into `stopped`. Those two lists mean opposite things about the
   * health of the system: `stopped` is the reaper doing its ordinary job on a worker nobody
   * had claimed to stop, while every name in here is proof that an EARLIER stop reported
   * success it never achieved — a clean shutdown whose detached `claude stop` died with the
   * process, a UI cancel whose stop failed silently. That is the failure this class exists to
   * surface, and a count that mixed the two would hide it inside a number an operator reads as
   * routine. Emptiness of this list is the healthy state, and it is worth being able to see.
   *
   * READ IT AS AN ALARM, NOT AS A RECEIPT. A name here is a session STILL RUNNING at the moment
   * this report was produced: this sweep only looked at it (the automatic stop was removed —
   * see the loop in reapWorkspace), so its quota stays in use until a human stops it with
   * `claude stop <jobId>` under its own account.
   */
  ghostsFound: string[];
  /** Records whose stoppedAt this sweep wrote — the stopped ones plus dead-record bookkeeping. */
  marked: number;
  /** Human-readable failures; a sweep never throws, it reports. */
  errors: string[];
  /**
   * Ownerless records this sweep deliberately did NOT touch because their liveness could not
   * be established, one line each with the reason. Kept apart from `errors` on purpose: this
   * is the conservative outcome working as designed, not a failure — but it is also the only
   * way an operator learns that a record (and the quota slot behind it) is being left alone,
   * so it must never be swallowed.
   */
  unknownLiveness: string[];
  /**
   * The dispatch task ids of every OWNERLESS, unstopped record this sweep examined — whatever
   * it then did with the record (stopped its worker, marked it, or left it alone). These are
   * the tasks whose fate the sweep may just have changed and that have no dispatcher left to
   * record it, so a caller hands them to the task reap straight away instead of leaving the
   * settle to whoever asks about one of them next. No duplicates; a record that names no task
   * contributes nothing.
   */
  orphanTaskIds: string[];
  /**
   * Records this sweep REMOVED from a ledger because nothing could ever look at them again and
   * their time is long over (see the last block of reapWorkspace). Names only; nothing was
   * signalled and no command was run for any of them.
   */
  dropped: string[];
}

/**
 * Tri-state liveness for one ledger record, ALREADY OBTAINED by the caller:
 *   true      — the worker is proven live;
 *   false     — the worker is proven NOT live (its account's listing was read and it is absent);
 *   undefined — UNKNOWN, which is not the same fact and must never be treated as `false`.
 *
 * Deliberately synchronous and deliberately not a bare `Set<jobId>`: the callers that need it
 * most run inside `mutateMeshWorkers`' synchronous read-modify-write and cannot await, and a
 * set alone cannot express the difference between "absent from a listing we read" and "we
 * never got to read that listing" — which is the whole difference between reaping and
 * destroying somebody's running work.
 */
export type WorkerLiveness = (rec: MeshWorkerRecord) => boolean | undefined;

/** The verdict when nothing was probed: every record is UNKNOWN, so nothing may be touched. */
const UNKNOWN_LIVENESS: WorkerLiveness = () => undefined;

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

/* ------------------------------------------------------------------------- *
 * Liveness — the probe input that replaced the name/pid guesswork (defect 1)
 * ------------------------------------------------------------------------- */

/**
 * A job id we are willing to match against a `claude agents --json` listing.
 *
 * The listing's `row.id` is the first 8 hex characters of the session UUID, which is exactly
 * what the ledger's `jobId` holds — but `adopt()` writes `jobId: ''` for a worker that carried
 * none, and the file is hand-editable. An unmatched job id would come back "absent from the
 * listing", i.e. PROVEN DEAD, for a worker that may be running right now; that is the ghost
 * this rework exists to stop. So anything that is not at least 8 lowercase hex characters
 * (optionally continuing into a full session UUID) yields no verdict at all.
 */
const PROBEABLE_JOB_ID_RE = /^[0-9a-f]{8}[0-9a-f-]*$/;

/** The record's job id when it can be matched against a listing, else undefined (= UNKNOWN). */
function probeableJobId(rec: MeshWorkerRecord): string | undefined {
  const jobId = rec.jobId;
  return typeof jobId === 'string' && PROBEABLE_JOB_ID_RE.test(jobId) ? jobId : undefined;
}

/**
 * Whether `jobId` names one of the ids a listing proved live.
 *
 * Exact match first. The prefix arms exist because the two sides can hold different-length
 * prefixes OF THE SAME session UUID — the CLI prints an 8-character job id, a ledger may have
 * captured a longer form — and a length mismatch that fell through to "absent" would report a
 * LIVE worker as dead. Both sides are at least 8 hex characters by the guard above, so a
 * prefix agreement is an identity, not a coincidence, and the residual errs toward "live",
 * which is the direction that cannot destroy work.
 */
function matchesLiveId(jobId: string, live: Set<string>): boolean {
  if (live.has(jobId)) {
    return true;
  }
  for (const id of live) {
    if (id.length >= 8 && (id.startsWith(jobId) || jobId.startsWith(id))) {
      return true;
    }
  }
  return false;
}

/** A record's config dir as an absolute resolved path, or undefined when it names none. */
function recordConfigDir(rec: MeshWorkerRecord): string | undefined {
  const dir = rec.configDir;
  if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) {
    // A relative or `~`-prefixed value would resolve against whatever cwd this process holds
    // — a different directory in the extension host than in the MCP server — so it identifies
    // nothing and is never repaired into something probeable.
    return undefined;
  }
  return path.resolve(dir);
}

/**
 * The config dirs a SWEEP may aim anything Claude-specific at: the OPERATOR's own CLAUDE CODE
 * accounts. The liveness probe's targets, every verdict built from them (and so the orphan
 * stop, the ghost report and history retention, which act on verdicts alone) and the
 * transcript lookup all decide "may this record's dir be touched" by membership in the map
 * this returns. (The session-end stop does not ask it of a worker its own process started —
 * see fireAndForgetStopOwned — and asks the pool's form of the same question of any other.)
 *
 * `claude agents --json` WRITES to the dir it targets — it rewrites that dir's `.claude.json`
 * and creates a `backups/` directory beside it — so the target may never come from a ledger.
 * A ledger is data: hand-editable, copied between machines, and written by a process that may
 * have been anything. This set therefore comes from the registry's Claude Code worker accounts
 * plus this process's own host config dir, and a record whose configDir is not in it gets NO
 * verdict at all rather than a probe.
 *
 * CLAUDE CODE accounts, through registry.claudeWorkers and nothing else. Since 2.0 a registry
 * worker can be an account on another vendor's CLI, and its `configDir` is then THAT vendor's
 * home (`~/.codex`, …): registered by the operator, and still not a directory `claude` may be
 * run against — the CLI would create its own config files inside it — nor one whose
 * `sessions/` or `projects/` mean what Claude's do. Such a worker is not skipped probe by
 * probe; it is never in the set, so to every consumer its dir is exactly as untrusted as one
 * no account ever had. The same goes for a ledger record that still names it.
 *
 * A MAP, because a directory has two spellings here and each is the right one for one job.
 * The KEY is the resolved absolute path: the identity a ledger record's configDir is matched
 * against, so `/a/b` and `/a/b/` are one account. The VALUE is the string exactly as the
 * operator's registry (or the host environment) spelled it, and that is what a probe is
 * handed: platform.claudeEnv derives the child's environment from the string, and the CLI
 * keys an account's stored login to it — a "tidied" path is a different, logged-out account.
 */
function trustedConfigDirs(): Map<string, string> {
  let registry: Registry | undefined;
  try {
    registry = readRegistry();
  } catch {
    // an unreadable registry can only ever make this set SMALLER, never wider
  }
  return trustedConfigDirsOf(registry);
}

/** trustedConfigDirs over a registry the caller already read (none ⇒ the host account alone). */
function trustedConfigDirsOf(registry: Registry | undefined): Map<string, string> {
  const dirs = new Map<string, string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) {
      return;
    }
    const key = path.resolve(value);
    if (!dirs.has(key)) {
      dirs.set(key, value); // first spelling wins: registry order, then the host
    }
  };
  try {
    for (const worker of registry === undefined ? [] : claudeWorkers(registry)) {
      add(worker?.configDir);
    }
  } catch {
    // a registry that cannot be walked contributes nothing: smaller, never wider
  }
  try {
    // The host account, derived the way every other surface derives it (platform): the
    // environment this process was started in, falling back to the CLI's default dir.
    add(hostConfigDir());
  } catch {
    // no home directory in a stripped environment — one fewer dir, never a wrong one
  }
  return dirs;
}

/**
 * A record's config dir when it is one of the trusted ones (resolved — the key of that map),
 * else undefined. THE test a ledger record has to pass before its dir is handed to anything
 * Claude-specific: a `claude` child run with CLAUDE_CONFIG_DIR naming it, a read of its
 * `sessions/` as a session registry, a lookup under its `projects/`.
 *
 * A record's `configDir` is DATA. It was a Claude Code account's dir when the record was
 * written; since then the account may have been removed, the file edited, or the directory
 * may have become the home of a worker on another vendor's CLI. Whichever it is, the record is
 * left exactly as found and reported as one that could not be checked — never repaired into
 * something addressable, and never acted on because some OTHER evidence (a job id that turned
 * up in another account's listing, an owner pid that matches ours) vouched for it.
 */
function trustedRecordDir(rec: MeshWorkerRecord, trusted: ReadonlyMap<string, string>): string | undefined {
  const dir = recordConfigDir(rec);
  return dir !== undefined && trusted.has(dir) ? dir : undefined;
}

/**
 * Why a record failed trustedRecordDir, as a clause that follows "worker X: …".
 *
 * It says what was not done and why, and then the one thing that is true of every such record
 * and that a reader most needs: NOBODY LOOKED, so the worker may still be running, and here is
 * how a person stops it (pool.manualStopAdvice). A record that reaches this text is UNKNOWN —
 * it is never worded as gone, and nothing that quotes this may treat it as gone.
 *
 * "Not an account" and "could not find out" are kept apart. The trusted set comes from the
 * registry, and an unreadable registry reads as one with no workers at all — every worker
 * account's dir then fails the test for a reason that has nothing to do with the record. So
 * the registry is asked once more whether it could be read (wording only: the decision was
 * made on the set, and an unreadable registry only ever made that set smaller).
 */
function untrustedDirReason(rec: MeshWorkerRecord): string {
  const dir = recordConfigDir(rec);
  if (dir === undefined) {
    return `its config dir is not an absolute path, so it names no account we can list — ${manualStopAdvice(rec)}`;
  }
  let registryProblem: string | null = null;
  try {
    registryProblem = readRegistryChecked().problem;
  } catch {
    registryProblem = null;
  }
  if (registryProblem !== null) {
    return (
      `whether its config dir ${dir} is a Claude Code account of this installation could not ` +
      `be checked, because the registry could not be read (${registryProblem}), and nothing ` +
      `Claude-specific is aimed at a dir taken from a ledger without that check: a \`claude\` ` +
      `command WRITES its config files into the dir it targets — ${manualStopAdvice(rec)}`
    );
  }
  return (
    `its config dir ${dir} is not a Claude Code account of this installation (neither this ` +
    `session's own nor a registered Claude Code worker's), and nothing Claude-specific is ever ` +
    `aimed at a dir taken from a ledger: a \`claude\` command WRITES its config files into the ` +
    `dir it targets — ${manualStopAdvice(rec)}`
  );
}

/** A liveness prober whose per-config-dir results are shared across a whole sweep. */
interface LivenessProber {
  /**
   * Verdicts covering `records`, probing any trusted config dir this prober has not asked
   * about yet. Never throws; a dir that cannot be read simply yields UNKNOWN verdicts.
   */
  verdicts(records: MeshWorkerRecord[], spawnDir: string): Promise<WorkerLiveness>;
  /** Why `verdicts(...)` returned undefined for this record — for the report, never a decision. */
  reason(rec: MeshWorkerRecord): string;
  /**
   * The sweep has just ENDED this record's session itself (a `claude stop` that succeeded, or
   * a kill of the process confirmed to be the worker). The listing that proved it live is from
   * before that, so the job leaves the live set and what is published is published again —
   * otherwise this process would go on believing its own stale listing for as long as a
   * listing is believed, and report a task as running whose worker it had stopped itself.
   */
  stopped(rec: MeshWorkerRecord): void;
}

/**
 * One prober per sweep, so a config dir is listed ONCE however many workspaces reference it.
 *
 * Extension activation sweeps every workspace's ledger, and every probe is a `claude` spawn
 * that writes to the account it targets; without this cache a machine with a handful of mesh
 * workspaces would pay (and write) that cost per workspace. A probe only ever ADDS to the
 * accumulated sets, so an oracle handed out early stays correct as later dirs come in. The
 * one thing that takes a job OUT of the live set is the sweep's own stop of it (`stopped`):
 * that is not a listing being contradicted, it is the world having been changed by the caller
 * after the listing was read.
 */
function createLivenessProber(claudePath: string): LivenessProber {
  const trusted = trustedConfigDirs();
  /** jobIds proven live, unioned across every dir read so far. */
  const live = new Set<string>();
  /** Dirs whose listing was actually READ — the only dirs whose silence is evidence. */
  const checked = new Set<string>();
  /** Dirs already handed to a probe, checked or not, so none is spawned against twice. */
  const attempted = new Set<string>();
  /** jobIds whose session the sweep using this prober ended itself, after listing them live. */
  const stoppedHere = new Set<string>();
  /**
   * When this prober's FIRST probe was issued — the age stamped on anything it publishes.
   * The oldest contributing probe, not the newest, because the published sets are a UNION
   * across every dir this prober read and a snapshot may only ever claim the freshness of its
   * stalest member. A sweep takes seconds, so the difference is small; the direction is not.
   */
  let firstProbeAt: number | undefined;

  const oracle: WorkerLiveness = (rec) => {
    const jobId = probeableJobId(rec);
    if (jobId === undefined) {
      return undefined;
    }
    // NO VERDICT AT ALL — not even `true` — FOR A RECORD WHOSE DIR IS NOT TRUSTED. `live` is a
    // UNION across every dir this prober read, so a record naming an untrusted dir (another
    // vendor's home, a removed account, an edited ledger) whose job id happens to be running
    // under a DIFFERENT, trusted account used to come back `true` here — and `true` is the one
    // verdict that licenses an ACTION: the orphan branch then ran `claude stop` with
    // CLAUDE_CONFIG_DIR set to the record's own dir, i.e. aimed a writing `claude` child at
    // exactly the directory the probe had refused to touch. A listing is evidence about a
    // record only when it is the listing of the account the record names.
    const dir = trustedRecordDir(rec, trusted);
    if (dir === undefined) {
      return undefined;
    }
    if (matchesLiveId(jobId, live)) {
      return true;
    }
    // ABSENCE IS ONLY EVIDENCE FROM A LISTING WE READ. `checked` is what separates "this
    // account's live sessions were enumerated and this job is not among them" from "we never
    // got an answer" — folding the second into `false` is precisely how a live worker gets
    // stamped stopped and becomes unreapable.
    return checked.has(dir) ? false : undefined;
  };

  return {
    async verdicts(records, spawnDir) {
      const pending: string[] = [];
      for (const rec of records) {
        const dir = trustedRecordDir(rec, trusted);
        if (dir === undefined || attempted.has(dir) || pending.includes(dir)) {
          continue;
        }
        pending.push(dir); // caller order is preserved: the probe's own cap slices the TAIL
      }
      if (pending.length === 0) {
        return oracle;
      }
      for (const dir of pending) {
        attempted.add(dir);
      }
      const issuedAt = Date.now();
      firstProbeAt = firstProbeAt ?? issuedAt;
      // Handed to the probe in the OPERATOR'S spelling (see trustedConfigDirs), one string
      // per resolved dir, and matched back through that same string: the probe reports a
      // dir it could not read under exactly what it was given.
      const spelled = pending.map((dir) => trusted.get(dir) ?? dir);
      let probe: Awaited<ReturnType<typeof probeBgLiveness>>;
      try {
        probe = await probeBgLiveness({ claudePath, configDirs: spelled, spawnCwd: spawnDir });
      } catch {
        // probeBgLiveness is documented never to reject; belt and braces, because a change
        // over there must not be able to turn a sweep into a thrown activation error.
        return oracle;
      }
      const unchecked = new Set(probe.unchecked.map((u) => u.configDir));
      pending.forEach((dir, i) => {
        if (!unchecked.has(spelled[i])) {
          checked.add(dir);
        }
      });
      for (const id of probe.live) {
        live.add(id);
      }
      // A session this sweep already ended does not come back because a later listing — of
      // another dir, or one that was being read while the stop ran — still shows its id.
      for (const id of stoppedHere) {
        dropLiveId(id, live);
      }
      // Everything this prober learned is published for the SYNCHRONOUS callers that cannot
      // await a probe of their own (see publishBgLivenessSnapshot).
      publishBgLivenessSnapshot(live, checked, stoppedHere, firstProbeAt);
      return oracle;
    },
    reason(rec) {
      if (probeableJobId(rec) === undefined) {
        return 'it records no usable job id, so no session listing can be asked about it';
      }
      const dir = trustedRecordDir(rec, trusted);
      if (dir === undefined) {
        return untrustedDirReason(rec);
      }
      if (!checked.has(dir)) {
        return `its account config dir ${dir} could not be listed on this sweep`;
      }
      return 'no verdict was available on this sweep';
    },
    stopped(rec) {
      const jobId = probeableJobId(rec);
      if (jobId === undefined) {
        return; // never matched against a listing, so there is nothing of it to withdraw
      }
      dropLiveId(jobId, live);
      stoppedHere.add(jobId);
      // `firstProbeAt` is set whenever anything was published; a stop can only follow a `true`
      // verdict, which only a probe produces. Guarded all the same: nothing was published,
      // nothing to correct.
      if (firstProbeAt !== undefined) {
        publishBgLivenessSnapshot(live, checked, stoppedHere, firstProbeAt);
      }
    },
  };
}

/**
 * Take one job out of a live set — by the same identity matchesLiveId answers with (exact, or
 * either side a prefix of the other's session UUID), so an id the listing printed in another
 * length cannot stay behind and keep answering "live" for the job that was just stopped.
 */
function dropLiveId(jobId: string, live: Set<string>): void {
  for (const id of [...live]) {
    if (id === jobId || (id.length >= 8 && (id.startsWith(jobId) || jobId.startsWith(id)))) {
      live.delete(id);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The SYNCHRONOUS side of liveness — a published snapshot, never a fresh spawn
 * ------------------------------------------------------------------------- */

/**
 * How long a published probe result may be believed, in EITHER direction.
 *
 * Liveness decays: a worker proven live ten minutes ago may have finished since, and believing
 * a stale `live` keeps a finished task sitting at 'running' — the P6 hang this release exists
 * to end. Absence decays more slowly but it does decay: this product can ATTACH to a worker,
 * and a session that was absent from a listing can be resumed into a live one. So one TTL
 * covers both, and past it every record is UNKNOWN again — which for the deadline gate below
 * means "settle at the deadline".
 *
 * WHAT THE TTL DOES NOT COVER, because inside it the two directions are not alike. A stale
 * "absent" can only bring a settle forward. A stale "live" HOLDS ONE OFF: while a snapshot
 * says a job is running, its task is reported running whatever its deadline says, for as long
 * as the snapshot is believed. So a `live` that has stopped being true is the expensive error,
 * and the one way it is known to happen at once is a STOP made after the listing was read —
 * above all the sweep's own, which lists the orphans and then ends them. Two rules keep a
 * listing from outliving such a stop: the sweep withdraws each job it ends and republishes
 * (LivenessProber.stopped), and a reader does not believe a snapshot about a record that was
 * stamped stopped after the snapshot was taken (snapshotVerdict) — which is what covers a stop
 * made by ANOTHER process, whose sweep cannot reach into this one's snapshot.
 */
const BG_LIVENESS_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/** One published `claude agents --json` result, shared across this process. */
interface BgLivenessSnapshot {
  /** jobIds the listing PROVED live (present with a live pid). */
  live: Set<string>;
  /** Config dirs whose listing was actually read — the only dirs whose silence is evidence. */
  checkedDirs: Set<string>;
  /**
   * jobIds whose session the publishing sweep ENDED ITSELF after listing them live. First-hand
   * knowledge, and the strongest "not running" this module ever holds: it did the stopping.
   */
  stoppedHere: Set<string>;
  /** When the OLDEST contributing probe was issued (see the prober's firstProbeAt). */
  takenAt: number;
}

/**
 * The most recent probe result, published by whichever prober ran last.
 *
 * MODULE STATE, DELIBERATELY. `probeBgLiveness` is async and it
 * SPAWNS — it runs `claude agents --json`, which rewrites the target account's `.claude.json`
 * and creates a `backups/` directory beside it. The registry's task sweep, by contrast, hands
 * this module a SYNCHRONOUS callback (`meshTaskAliveCheck`) that is called from
 * `dispatch_status`, i.e. from a POLL: a poll may neither await nor spawn a child that writes
 * into a user's config dirs. Those two facts cannot both be satisfied by probing on demand, so
 * the probe stays where it legitimately belongs — the reaper sweep, which already runs one at
 * extension activation and at MCP mesh init — and its result is published here for the
 * synchronous readers.
 *
 * THE COST OF THAT CHOICE, written down rather than hidden: a synchronous caller running before
 * any sweep in this process, or more than the TTL after one, gets UNKNOWN for every record. It
 * never gets a WRONG answer, and UNKNOWN before a task's deadline means "leave it running",
 * which is the direction that cannot fabricate a terminal verdict.
 */
let bgLivenessSnapshot: BgLivenessSnapshot | undefined;

/** Publish a prober's accumulated knowledge for the synchronous readers. Never throws. */
function publishBgLivenessSnapshot(
  live: Set<string>,
  checkedDirs: Set<string>,
  stoppedHere: Set<string>,
  takenAt: number,
): void {
  // Copied, not aliased: the prober keeps mutating its own sets for the rest of the sweep, and
  // a snapshot that changed under a reader would make one task's verdict depend on when in the
  // sweep it happened to be asked.
  bgLivenessSnapshot = {
    live: new Set(live),
    checkedDirs: new Set(checkedDirs),
    stoppedHere: new Set(stoppedHere),
    takenAt,
  };
}

/** Test seam: forget the published snapshot (a fresh process starts with none). */
export function resetBgLivenessSnapshot(): void {
  bgLivenessSnapshot = undefined;
}

/**
 * What the published snapshot says about ONE ledger record, and ON WHAT GROUNDS — no spawn, no
 * await, no session-registry entry, no pid, no `state` string, and above all no NAME.
 *
 *   live, `listed`            — this record's jobId was in a listing that proved it running,
 *                               and nothing has ended it since;
 *   not live, `stopped-here`  — the sweep that published the snapshot ended this session
 *                               itself, after listing it;
 *   not live, `stopped-since` — the record was stamped stopped AFTER the snapshot was taken;
 *   not live, `absent`        — its account's listing WAS read, after the worker would have
 *                               had to appear in it, and the job was not there;
 *   undefined                 — UNKNOWN: no snapshot, a stale one, an unusable job id, a dir
 *                               nobody listed, or a listing taken before this worker could
 *                               have shown up in it.
 *
 * THE TWO `stopped` ARMS COME FIRST, ahead of the listing, and the order is the point. A
 * listing is a reading of one moment; a stop made after it is a later fact about the same
 * session, and the later fact wins. With the listing first, a job the sweep listed and then
 * stopped stays "proven running" here for the whole life of the snapshot, and its task is
 * reported running — past its deadline, with its finished result on disk — until the snapshot
 * expires.
 *   - `stopped-here` is this process's own act: it ran the stop and saw it succeed.
 *   - `stopped-since` is the ledger's word, and a stop mark is a claim rather than a proof
 *     everywhere else in this module. It is believed HERE for one reason: the only thing it is
 *     weighed against is a listing OLDER than itself, which cannot contradict it. A mark OLDER
 *     than the listing is not believed on these grounds at all — a listing that still shows
 *     the job after its record was stamped is the ghost this module reports, and it reads
 *     `listed`, as before. Nothing is ever signalled, marked or pruned on this arm: its one
 *     consumer decides whether a TASK may be settled, and a task whose worker was stopped is
 *     over.
 *
 * The `spawnedAt` guard on the `absent` arm is the one that is easy to leave out and fatal to
 * leave out: a snapshot taken at MCP init says nothing about a worker dispatched ten minutes
 * later, and reading that silence as "absent" would hand a terminal verdict to every task the
 * server started after its own sweep. A listing is evidence about a worker only once the worker
 * has had ENTRY_APPEAR_GRACE_MS to appear in it.
 */
type SnapshotVerdict =
  | { live: true; because: 'listed' }
  | { live: false; because: 'stopped-here' | 'stopped-since' | 'absent' };

function snapshotVerdict(rec: MeshWorkerRecord): SnapshotVerdict | undefined {
  const snap = bgLivenessSnapshot;
  if (snap === undefined) {
    return undefined;
  }
  const age = Date.now() - snap.takenAt;
  // A snapshot stamped in the future (clock change) dates nothing and is not believed either.
  if (!Number.isFinite(age) || age < 0 || age > BG_LIVENESS_SNAPSHOT_TTL_MS) {
    return undefined;
  }
  const jobId = probeableJobId(rec);
  if (jobId === undefined) {
    return undefined;
  }
  if (matchesLiveId(jobId, snap.stoppedHere)) {
    return { live: false, because: 'stopped-here' };
  }
  const stoppedAt = rec.stoppedAt;
  if (typeof stoppedAt === 'number' && Number.isFinite(stoppedAt) && stoppedAt > snap.takenAt) {
    return { live: false, because: 'stopped-since' };
  }
  if (matchesLiveId(jobId, snap.live)) {
    return { live: true, because: 'listed' };
  }
  const dir = recordConfigDir(rec);
  if (dir === undefined || !snap.checkedDirs.has(dir)) {
    return undefined;
  }
  const spawnedAt = rec.spawnedAt;
  if (typeof spawnedAt !== 'number' || !Number.isFinite(spawnedAt)) {
    return undefined; // no spawn time ⇒ the listing cannot be dated against this worker
  }
  return snap.takenAt - spawnedAt > ENTRY_APPEAR_GRACE_MS ? { live: false, because: 'absent' } : undefined;
}

/** Tri-state liveness for one ledger record from the published snapshot (snapshotVerdict). */
function snapshotLiveness(rec: MeshWorkerRecord): boolean | undefined {
  return snapshotVerdict(rec)?.live;
}

/**
 * Why the snapshot said what it said, in a sentence a human reads in a task's note.
 *
 * Takes the MATCH SET rather than a record, because a task can be claimed by more than one ledger
 * record (a quota-stall failover leaves the stopped first generation beside the live second) and
 * a note that could only describe the unique case simply said nothing at all in the case an
 * operator most needs described. The verdict reported is the same one the liveness gate acts on
 * (aggregateSnapshotLiveness), so the note can never disagree with the decision it explains.
 *
 * `deadline` rides the UNKNOWN branch because that branch is the one sanctioned terminal verdict
 * on unknown liveness — the task was settled because a CLOCK ran out, and a reader must be able
 * to tell whether that clock was the dispatch's own recorded budget or the conservative stand-in
 * for an event that carried none (M6). Passing `undefined` states that no deadline existed.
 */
function describeSnapshotLiveness(matches: MeshWorkerRecord[], deadline?: TaskDeadline): string {
  if (matches.length === 0) {
    // No caller reaches this today (every one holds at least one match), and a note that
    // described a worker there is no record of would be a claim, not a description.
    return `No ledger record claims this task, so nothing could be established about a worker's liveness.${describeDeadlineBasis(deadline)}`;
  }
  const jobs = matches.map((rec) => rec.jobId || '<none>').join(', ');
  const subject = matches.length === 1 ? `Its worker (job ${jobs})` : `Its ${matches.length} claimed worker sessions (jobs ${jobs})`;
  const verdict = aggregateSnapshotLiveness(matches);
  if (verdict === true) {
    return matches.length === 1
      ? `${subject} was PROVEN RUNNING by the last background-session listing.`
      : `${subject} include one PROVEN RUNNING by the last background-session listing.`;
  }
  if (verdict === false) {
    // WHY each one is not running, in the words of the ground it was decided on: "its listing
    // was read and it was not there" is not what happened to a worker that was listed and then
    // stopped, and a note that said so would describe evidence nobody had.
    const grounds = [...new Set(matches.map((rec) => snapshotVerdict(rec)?.because))];
    if (grounds.length === 1 && grounds[0] === 'absent') {
      return matches.length === 1
        ? `${subject} was PROVEN ABSENT: its account's background-session listing was read and the job was not in it.`
        : `${subject} were EVERY ONE PROVEN ABSENT: each account's background-session listing was read and none of the jobs was in it.`;
    }
    const said = grounds.map((because) =>
      because === 'stopped-here'
        ? `STOPPED BY THIS PROCESS'S OWN ORPHAN SWEEP after the last background-session listing was ` +
          `taken (its dispatching process was no longer running)`
        : because === 'stopped-since'
          ? `RECORDED AS STOPPED after the last background-session listing was taken, so whatever ` +
            `that listing showed is older than the stop`
          : `PROVEN ABSENT (its account's background-session listing was read and the job was not in it)`,
    );
    return matches.length === 1
      ? `${subject} was ${said.join('; ')}.`
      : `${subject} are EVERY ONE NOT RUNNING — ${said.join('; ')}.`;
  }
  // One reason per distinct cause, deduplicated: several records on one unlistable account would
  // otherwise repeat the same clause once per row.
  const why = [...new Set(matches.map((rec) => snapshotUnknownReason(rec)))].join('; ');
  return (
    `${
      matches.length === 1
        ? "Its worker's LIVENESS"
        : `The LIVENESS of its ${matches.length} claimed worker sessions (jobs ${jobs})`
    } COULD NOT BE ESTABLISHED (${why}), so this task was settled on its ` +
    `dispatch deadline alone — the worker may still be running.${describeDeadlineBasis(deadline)}`
  );
}

/** The reason ONE record produced no liveness verdict — for a note, never for a decision. */
function snapshotUnknownReason(rec: MeshWorkerRecord): string {
  const snap = bgLivenessSnapshot;
  if (snap === undefined) {
    return 'no background-session listing has been taken in this process';
  }
  if (Date.now() - snap.takenAt > BG_LIVENESS_SNAPSHOT_TTL_MS) {
    return 'the last background-session listing is too old to be believed';
  }
  if (probeableJobId(rec) === undefined) {
    return 'the record carries no usable job id';
  }
  return 'its account could not be listed';
}

/** The clock a deadline-only settle ran out on, named for the human reading the note (M6). */
function describeDeadlineBasis(deadline: TaskDeadline | undefined): string {
  if (deadline === undefined) {
    return ' No deadline could be derived for it at all.';
  }
  if (deadline.recorded) {
    return (
      ` That deadline (${isoOrRaw(deadline.at)}) was the one its dispatcher recorded on the ` +
      `worker's ledger record at spawn.`
    );
  }
  if (!deadline.fallback) {
    return ` That deadline was its OWN recorded budget of ${deadline.minutes} minutes.`;
  }
  return (
    ` That deadline was a FALLBACK, not this dispatch's own budget: its event records no ` +
    `timeout (it was written by a build that predates the field), so a conservative ` +
    `${deadline.minutes}-minute grace stood in for a number nothing on disk knows.`
  );
}

/* ------------------------------------------------------------------------- *
 * Durable dispatch deadlines — the timer that died with the dispatching session
 * ------------------------------------------------------------------------- */

/**
 * A dispatch's timeout in minutes, taken from the event and sanitized BY VALUE.
 *
 * `TaskEvent.timeoutMinutes` is written by the dispatcher and read from a hand-editable
 * append-only log, so its declared type proves nothing: a non-number, a NaN, an Infinity or a
 * negative is not a timeout. Out-of-range values are clamped to the same window the dispatcher
 * itself clamps to rather than rejected, because a 10000-minute entry is a corrupted number,
 * not a licence to never settle the task.
 */
function eventTimeoutMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(TIMEOUT_MINUTES_MAX, Math.max(TIMEOUT_MINUTES_MIN, value));
}

/**
 * One dispatch's durable deadline, and WHICH number it was built from.
 *
 * The provenance is part of the answer rather than a detail: a task settled on its OWN recorded
 * budget and a task settled on a stand-in are different events to a human reading why their
 * work was declared over, and only the first is a statement about this dispatch.
 */
interface TaskDeadline {
  /** Epoch ms at which the dispatch's budget is spent. */
  at: number;
  /** True when the EVENT carried no usable timeout and the conservative stand-in was used. */
  fallback: boolean;
  /** The minutes `at` was built from — for the note only, never a decision. */
  minutes: number;
  /**
   * True when `at` is the deadline the DISPATCHER itself wrote on the worker's ledger record
   * (`deadlineAt`) rather than one re-derived from the task event. `minutes` is then only an
   * approximation for the note (record deadline minus record spawn time).
   */
  recorded?: boolean;
}

/**
 * The stand-in budget for a dispatch event that records no timeout of its own.
 *
 * DELIBERATELY LONGER THAN ANY REAL DISPATCH, which is the whole correction here (M6). An event
 * without `timeoutMinutes` was written by a build that predates the field, so its real budget is
 * unknowable — it is NOT "the current workspace default". Twice the current clamp, because the
 * clamp itself is a constant of THIS build and an older one may have allowed longer; a fallback
 * deadline that can be shorter than a legitimately long dispatch is exactly the failure below.
 * The cost of erring long is a dead task sitting 'running' for a few more hours; the cost of
 * erring short is a terminal verdict written over a worker that is still working.
 */
const FALLBACK_DEADLINE_MINUTES = TIMEOUT_MINUTES_MAX * 2;

/**
 * The DURABLE deadline of one dispatch, or undefined when none can be derived.
 *
 * This is the replacement for the timer that died with the dispatching session. A dispatch's
 * timeout lived in ONE place — an in-memory `await` in the session that issued it — so when
 * that session was killed nothing was left to tell a task that is merely slow from one that
 * blew its budget an hour ago, and a `--bg` task (whose event carries no pid at all) sat at 'running'
 * forever. `TaskEvent.timeoutMinutes` was added so the number survives the session; this is the
 * only place in the codebase that reads it.
 *
 * WHAT AN ABSENT `timeoutMinutes` MEANS, corrected. This function used to fall back to the
 * workspace-wide `workerTimeoutMinutes`, and its doc claimed "if BOTH are unusable there is no
 * deadline". That second half was unreachable: `readRegistry()` always supplies that setting
 * (default 45), so the fallback ALWAYS fired and every mesh task always carried a 45-minute
 * deadline — including tasks whose events were written by a process that predates the field.
 * The realistic trigger is an update: an MCP server started before it keeps writing events
 * without the number while a freshly-activated new extension host reaps everything, so every
 * long dispatch in flight across that update was settled TERMINALLY at 45 minutes with its
 * worker still running and its eventual result left with nowhere to land. A missing timeout is
 * an UNKNOWN budget, never a known short one, so the absent case now uses
 * FALLBACK_DEADLINE_MINUTES — a grace no legitimate dispatch can outlive — and says so
 * (`fallback: true`) wherever the settle is explained.
 *
 * `fallbackMinutes` (the sanitized workspace setting) still participates only as a FLOOR, so a
 * workspace configured beyond the current clamp cannot make the stand-in shorter than its own
 * default. There is genuinely no deadline only when the event carries no usable `ts` — an
 * unknowable deadline must never become an expired one.
 */
function taskDeadline(task: TaskEvent, fallbackMinutes: number | undefined): TaskDeadline | undefined {
  const ts = task?.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return undefined; // nothing to anchor a deadline to
  }
  const own = eventTimeoutMinutes(task.timeoutMinutes);
  if (own !== undefined) {
    return { at: ts + own * 60_000, fallback: false, minutes: own };
  }
  const minutes = Math.max(FALLBACK_DEADLINE_MINUTES, fallbackMinutes ?? 0);
  return { at: ts + minutes * 60_000, fallback: true, minutes };
}

/**
 * How far a record's `deadlineAt` may sit BEFORE its `spawnedAt` and still be believed. The
 * dispatcher computes the deadline just before the spawn and the pool stamps `spawnedAt` just
 * after it, so the deadline is normally a whole timeout LATER; a small negative difference
 * can only come from a clock step in between, and anything beyond that is not a deadline.
 */
const RECORD_DEADLINE_SLACK_MS = 60_000;

/**
 * The deadline a worker's LEDGER RECORD carries, when it is one a dispatcher could have
 * written — sanitized BY VALUE, exactly as eventTimeoutMinutes sanitizes the event's number.
 *
 * The ledger is a hand-editable file, and this number can end a task: once it has passed,
 * a task whose worker's liveness is unknown is settled TERMINALLY. So a `deadlineAt` is used
 * only when it is finite and lies where `spawn time + a legal timeout` can lie — no earlier
 * than the record's own spawn (less a clock-step slack) and no later than the longest timeout
 * the registry allows after it. A value outside that window is not clamped into a deadline:
 * it is ignored, and the caller falls back to the event-derived one, which is what every
 * record written before the field existed gets anyway.
 */
function recordDeadlineAt(rec: MeshWorkerRecord): number | undefined {
  const at = rec.deadlineAt;
  const spawnedAt = rec.spawnedAt;
  if (
    typeof at !== 'number' ||
    !Number.isFinite(at) ||
    typeof spawnedAt !== 'number' ||
    !Number.isFinite(spawnedAt)
  ) {
    return undefined;
  }
  const span = at - spawnedAt;
  if (span < -RECORD_DEADLINE_SLACK_MS || span > TIMEOUT_MINUTES_MAX * 60_000) {
    return undefined;
  }
  return at;
}

/**
 * The durable deadline of the dispatch behind `task`, PREFERRING the one its dispatcher
 * recorded.
 *
 * `MeshWorkerRecord.deadlineAt` is the dispatcher's own clock — `spawn time + the dispatch's
 * timeout`, the very number its in-memory timer runs to — written once at spawn. When any
 * record claiming the task carries a usable one, that is the deadline, and the event-derived
 * reconstruction (taskDeadline: event `ts` + event `timeoutMinutes`) is not consulted: two
 * derivations of one number can only disagree, and the recorded one is the original.
 *
 * SEVERAL RECORDS, ONE TASK is the ordinary shape a failover leaves (a stopped first
 * generation beside the live second), and each attempt recorded its own deadline. The LATEST
 * is taken: it belongs to the attempt that is still running, and it is the only choice that
 * cannot call a dispatch overdue while its dispatcher's timer is still counting.
 *
 * No usable recorded deadline — records from before the field existed, a hand-edited value,
 * no records at all — falls back to taskDeadline unchanged.
 */
function dispatchDeadline(
  task: TaskEvent,
  matches: MeshWorkerRecord[],
  fallbackMinutes: number | undefined,
): TaskDeadline | undefined {
  let latest: { at: number; spawnedAt: number } | undefined;
  for (const rec of matches) {
    const at = recordDeadlineAt(rec);
    if (at !== undefined && (latest === undefined || at > latest.at)) {
      latest = { at, spawnedAt: rec.spawnedAt };
    }
  }
  if (latest !== undefined) {
    return {
      at: latest.at,
      fallback: false,
      minutes: Math.max(0, Math.round((latest.at - latest.spawnedAt) / 60_000)),
      recorded: true,
    };
  }
  return taskDeadline(task, fallbackMinutes);
}

/** The workspace default, read once per sweep closure and sanitized the same way. */
function registryTimeoutMinutes(): number | undefined {
  try {
    return eventTimeoutMinutes(readRegistry().workerTimeoutMinutes);
  } catch {
    return undefined; // an unreadable registry leaves older events with no deadline, not a wrong one
  }
}

/* ------------------------------------------------------------------------- *
 * The task↔ledger join guard for history retention (defect: retention before settle)
 * ------------------------------------------------------------------------- */

/** How long one scan of the task log is reused. A sweep is far shorter than this. */
const RUNNING_TASK_IDS_TTL_MS = 5_000;

/**
 * What one scan of the append-only task log establishes about the tasks this module protects
 * things for: which are still open, and WHEN each of the rest closed.
 *
 * The settle stamps exist because "still running" is not the only state in which a task's
 * artifacts are still somebody's only copy of an answer — see protectedIoTaskId.
 */
interface TaskStateIndex {
  /** Ids whose latest event still says 'running'. */
  running: Set<string>;
  /** Id → `ts` of the latest event, for ids whose latest event is TERMINAL and datable. */
  settledAt: Map<string, number>;
}
/**
 * The last scan and WHEN it was taken. `index: undefined` memoizes IGNORANCE — a log this
 * process could not read — and is deliberately cached like any other answer: every caller
 * treats it as "protect everything", so a cached unknown can only ever keep a record or an
 * artifact directory alive for another TTL. Re-reading an unreadable file once per record
 * under the very fd/permission pressure that made it unreadable buys nothing.
 */
let taskStateCache: { index: TaskStateIndex | undefined; at: number } | undefined;

/**
 * One memoized latest-event-per-id scan of the task log, or undefined when it could not be read.
 *
 * Memoized because `removable()` is called once PER RECORD, twice per prune (a pre-check and
 * then again inside the locked read-modify-write), and the io sweep asks once per artifact
 * directory — each miss would re-read and re-parse the whole append-only task log. The TTL is
 * short enough that a task settling mid-sweep is only ever seen LATE, which keeps its record and
 * its artifacts one sweep longer: the harmless direction in both cases.
 *
 * `undefined` is not paranoia dressing: it is the difference between "no task is running" and
 * "we could not find out", and only the first may permit a deletion.
 *
 * WHY THIS READS `readTaskEventsChecked` AND NOT `readTaskEvents` — the defect that made the
 * paragraph above a LIE for two releases. `readTaskEvents()` swallows every read error and
 * returns `[]`, so an unreadable log arrived here as an EMPTY log: no id running, no id settled,
 * i.e. the exact verdict "nothing depends on any of this" that licenses deletion. The
 * `undefined` branch below was therefore DEAD CODE, reachable only if the loop itself threw.
 * Reproduced: a task 'running' with a valid token-matched `result.json` in an io directory older
 * than 24h is KEPT while the log is readable and `rmSync(recursive, force)`'d the moment it is
 * not — the worker's unread report destroyed — and the same hole let retention prune the ledger
 * record that is the only route from a taskId to a `configDir`+`jobId`. No adversary is needed:
 * EMFILE/ENFILE under fd pressure, an EIO, a permission change, or the file being swapped
 * mid-read all produce it, and `sweepStaleIoArtifacts` runs at activation AND every 60 seconds.
 *
 * `readTaskEventsChecked` separates the two facts at the source: `unreadable` is true only when
 * the read or parse of the log FILE failed. A legitimately ABSENT log (a fresh install) is
 * `false` — that is knowledge, not ignorance, and it correctly permits collecting litter left by
 * a `clearTaskLog()`.
 *
 * The flag is consumed BY VALUE and in the paranoid direction: only an explicit `unreadable ===
 * false` licenses building an index. A supplier that returns some other shape (an older build, a
 * hand-rolled stub) is IGNORANCE, never a silent readable-log verdict — the whole point of this
 * fix is that the absence of a positive "I read it" must not read as one.
 */
function taskStateIndex(): TaskStateIndex | undefined {
  const now = Date.now();
  const cached = taskStateCache;
  if (cached !== undefined && now - cached.at >= 0 && now - cached.at < RUNNING_TASK_IDS_TTL_MS) {
    return cached.index;
  }
  try {
    const read: unknown = readTaskEventsChecked();
    if (typeof read !== 'object' || read === null) {
      return rememberTaskState(undefined, now);
    }
    const checked = read as { events?: unknown; unreadable?: unknown };
    if (checked.unreadable !== false || !Array.isArray(checked.events)) {
      // UNREADABLE (or a shape that cannot prove it was read) ⇒ UNKNOWN. Nothing downstream may
      // delete anything on this answer; it is not "the log is empty".
      return rememberTaskState(undefined, now);
    }
    // Last write per id wins, exactly as registry.latestEventById resolves it — the log is
    // append-only and file order IS the order.
    const latest = new Map<string, TaskEvent>();
    for (const event of checked.events as TaskEvent[]) {
      const id = event?.id;
      if (typeof id === 'string' && id !== '') {
        latest.set(id, event);
      }
    }
    const index: TaskStateIndex = { running: new Set(), settledAt: new Map() };
    for (const [id, event] of latest) {
      if (event.status === 'running') {
        index.running.add(id);
        continue;
      }
      const ts = event.ts;
      // An un-datable terminal event starts no clock. It is deliberately NOT treated as
      // "settled long ago" (which would expose the artifacts immediately) nor as "settled now"
      // (which would protect them forever); it simply contributes nothing, and the artifacts
      // fall back to the age rule they had before this index existed.
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        index.settledAt.set(id, ts);
      }
    }
    return rememberTaskState(index, now);
  } catch {
    // A throw out of the reader or the scan proves nothing about what is running, so it is the
    // same UNKNOWN the unreadable flag produces — never an empty index.
    return rememberTaskState(undefined, now);
  }
}

/** Memoize one scan (or one failure to scan) and hand it straight back to the caller. */
function rememberTaskState(index: TaskStateIndex | undefined, at: number): TaskStateIndex | undefined {
  taskStateCache = { index, at };
  return index;
}

/**
 * The ids of every task whose latest event still says 'running', or undefined when that
 * could not be established.
 */
function runningTaskIds(): ReadonlySet<string> | undefined {
  return taskStateIndex()?.running;
}

/** Test seam: forget the memoized task-log scan. */
export function resetRunningTaskIdsCache(): void {
  taskStateCache = undefined;
}

/**
 * Whether this record is the ONLY remaining route to an unsettled task's outcome (defect:
 * retention destroys the join before the task is settled).
 *
 * A mesh record is not just history — while its task is still 'running' it is the join that
 * turns a task id into a `configDir` + `jobId`, and that pair is the only way anything can find
 * the worker's session transcript. Delete the record and the task's recoverable report becomes
 * unreachable FOREVER: the next sweep can only say `no mesh ledger record claims task …`, and
 * a report the worker actually wrote is lost. Reproduced with a stopped, proven-dead record
 * whose complete report was sitting in the transcript and whose task the cap-prune had just
 * un-joined.
 *
 * So a record whose taskId names a still-running task is NOT removable, whatever the retention
 * cap or a "clear stopped workers" command says. A record naming no task at all is unaffected —
 * there is no join to protect.
 */
function joinsUnsettledTask(rec: MeshWorkerRecord): boolean {
  const taskId = rec.taskId;
  if (typeof taskId !== 'string' || taskId === '') {
    return false; // adopted / v1.4 records join no task, so nothing depends on them
  }
  const running = runningTaskIds();
  // Cannot establish it ⇒ treat the join as live. Under-pruning is a longer history list;
  // over-pruning is somebody's recoverable report deleted with no way back. Like
  // protectedIoTaskId's twin guard, this arm was UNREACHABLE while the index was built on
  // `readTaskEvents()` (an unreadable log came back as an empty one, i.e. "no task is running"),
  // so an fd-starved sweep could prune the record that is the only route from this taskId to a
  // `configDir` + `jobId`. See taskStateIndex.
  return running === undefined || running.has(taskId);
}

/**
 * The session-registry entry for a job id, used ONLY as the pid source for a forced kill.
 *
 * Keyed on the JOB ID, never the name: names are reused across generations, so a name lookup
 * can hand back a stale namesake's entry or — far worse — a different LIVE worker's, and this
 * pid is about to be SIGKILLed. The name is still read, but only as a VETO: an entry whose job
 * id is ours while its name is somebody else's is an inconsistency we refuse to kill on.
 * A real entry beats a bridge mirror for the same reason findSessionEntry prefers one — a
 * mirror's pid belongs to a foreign account's process.
 */
function findSessionEntryByJobId(dir: string, jobId: string, name: string): SessionEntry | undefined {
  if (typeof jobId !== 'string' || jobId === '') {
    return undefined;
  }
  let mirror: SessionEntry | undefined;
  for (const entry of readSessionEntries(dir)) {
    const entryJob = typeof entry.jobId === 'string' && entry.jobId !== '' ? entry.jobId : undefined;
    // Either the entry states the job id, or its sessionId begins with it — a jobId is the
    // leading hex of the session UUID, so the prefix IS the identity.
    const matches = entryJob === jobId || (typeof entry.sessionId === 'string' && entry.sessionId.startsWith(jobId));
    if (!matches) {
      continue;
    }
    if (typeof entry.name === 'string' && entry.name !== name) {
      continue; // the veto, not a lookup key
    }
    if (entry.ccoMirror !== true) {
      return entry;
    }
    mirror = mirror ?? entry;
  }
  return mirror;
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
  const listing = listDirCapped(MESH_STATE_DIR);
  if (!listing.ok) {
    if (!listing.absent) {
      // The dir EXISTS and we were refused it. Saying nothing here would report a clean sweep
      // of zero workspaces, which is the same sentence a machine with no mesh state produces.
      errors.push(
        `the mesh state directory ${MESH_STATE_DIR} could not be listed (${listing.detail}), ` +
          `so NO workspace ledger was swept — this is not the same as there being none.`,
      );
    }
    return []; // absent: no mesh state has ever been written on this machine
  }
  if (listing.truncated) {
    errors.push(
      `the mesh state directory ${MESH_STATE_DIR} holds more than ${DIR_SCAN_MAX_ENTRIES} ` +
        `entries; only the first ${DIR_SCAN_MAX_ENTRIES} were considered, so some workspaces ` +
        `were not swept.`,
    );
  }
  const out: string[] = [];
  for (const file of listing.names) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const stateFile = path.join(MESH_STATE_DIR, file);
    // noFollow: a ledger is a regular file this product renames into place in its own data
    // directory; a link at that name is not one, and is not read as one.
    const read = readTextSafe(stateFile, MESH_STATE_FILE_MAX_BYTES, { noFollow: true });
    if (!read.ok) {
      if (read.reason !== 'absent') {
        // 'absent' = it vanished between the listing and the read, which is a workspace whose
        // state was deleted under us and is honestly nothing to sweep. Everything else is a
        // file that IS there and could not be read, and a sweep that silently skips it would
        // report "no orphans in this workspace" about a workspace it never opened.
        errors.push(
          `mesh state file ${file} could not be READ (${read.reason} — ${read.detail}) — ` +
            `skipped, and its workspace was NOT swept.`,
        );
      }
      continue;
    }
    let workspace: unknown;
    try {
      const raw = JSON.parse(read.text);
      workspace = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).cwd : undefined;
    } catch {
      errors.push(`mesh state file ${file} is corrupt (unparseable JSON) — skipped.`);
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
 * `worktreeVerdicts` (A11) rides the same write: record identity → true when `claude rm` KEPT
 * the worktree because it holds uncommitted work, false when the removal was confirmed. A
 * record absent from the map keeps whatever it already said, because "we did not find out" and
 * "there is nothing there" are different facts about somebody's unmerged work.
 *
 * NEITHER TARGET IS A NAME, and that is a correctness fix, not a style preference. This
 * function used to take `names: string[]` and stamp every unstopped record whose NAME was in
 * the set. Worker names are REUSED across generations, so a ledger routinely holds several
 * records sharing one name — and the callers above hand in only the records they PROVED dead,
 * having deliberately left their namesakes alone because those were alive or UNKNOWN. The write
 * then stamped the namesakes too: reproduced with two same-name records, one proven dead and
 * one alive holding a worktree, which came back `marked: 2` with the LIVE one stamped stopped.
 * That is a freshly manufactured ghost — a running session behind a record that says stopped,
 * which every later sweep opens on and skips — created by the very write that was supposed to
 * be bookkeeping. Targets are therefore matched on (name, jobId), the same record identity
 * pool.ts's `isSameWorkerRecord` uses, re-found inside the write because the ledger is re-read
 * there and the object identities are new.
 *
 * A verdict alone is enough to justify the write, with no names to stamp at all. That case is
 * real, not theoretical: a sweep whose only action was stopping a worker found alive behind an
 * ALREADY-stopped record has nothing to mark (the mark is what was wrong in the first place)
 * but has just run `claude rm` and learned whether that worker's worktree survived. Returning
 * early there would drop the one new fact of the whole sweep on the floor. The "never rewrite
 * a ledger we merely inspected" guarantee is untouched: a verdict exists only where a teardown
 * actually ran.
 *
 * A SKIPPED WRITE MARKS NOTHING, and nothing here tries again. mutateMeshWorkers skips when the
 * ledger's write lock cannot be taken — which since 2.0 includes "another process held it for
 * the whole 15 s wait", where the old lock broke in — or when the state file cannot be read. The
 * call returns 0 and, when `errors` is given, says why. Whether anything marks the record LATER
 * depends on the caller, and each of the three is different:
 *   - the orphan sweep re-derives its targets from the ledger on every run, so the next sweep
 *     (the next editor window to activate, the next server to start) finds the same unstopped
 *     record with the same dead owner and marks it then;
 *   - fireAndForgetStopOwned has no next run — the process is exiting — and needs none: the
 *     records it could not stamp keep naming an owner that is about to be dead, which makes
 *     them that same sweep's orphans;
 *   - markWorkerStopped hands the reason back to the editor's cancel, which shows it.
 *
 * `contested` is the other thing a write can have to say (LedgerWrite): the marks reached the
 * file, but the lock was taken away mid-write and re-applying them did not settle the matter.
 * The sweep collects it with its errors and logs it, the shutdown path logs it; the editor's
 * cancel is not told — to it, a mark that reached the file is a mark made.
 *
 * WHICH THROW POLICY THIS IS: every caller of this function is bookkeeping about a stop that
 * has already been performed (or, at shutdown, fired), so a lock that could not be taken never
 * changes what the caller does next — it is reported in one line and the caller carries on.
 */
function markStopped(
  cwd: string,
  targets: MeshWorkerRecord[],
  worktreeVerdicts?: Map<string, boolean>,
  errors?: string[],
  contested?: string[],
): number {
  if (targets.length === 0 && (worktreeVerdicts === undefined || worktreeVerdicts.size === 0)) {
    return 0; // never create or rewrite a ledger we merely inspected
  }
  const wanted = new Set(targets.map(recordKey));
  const now = Date.now();
  let marked = 0;
  // The mutator may be run TWICE (mutateMeshWorkers re-applies a write whose lock was taken
  // away while it was made), each time against a fresh read. The count is therefore rebuilt on
  // every run, and on a second run a record that already carries THIS call's stamp is one this
  // call marked — it is the first run's write, still in the file.
  let ranBefore = false;
  // A SKIPPED write returns 0 marked, which reads identically to "somebody else got there
  // first" — so when the caller has an error channel, the skip is spoken aloud instead. The
  // difference matters: a mark that never landed leaves a stopped session behind a record that
  // still says live, which is the ghost every later sweep re-opens.
  const onSkip =
    errors === undefined
      ? undefined
      : (reason: string): void => {
          errors.push(`${cwd}: ${reason} Nothing was marked stopped in this ledger.`);
        };
  const wrote = mutateMeshWorkers(
    cwd,
    (workers) => {
      marked = 0;
      for (const rec of workers) {
        const key = recordKey(rec);
        // Re-checked inside the write, because the ledger is re-read there: this is the
        // only place the decision and the write see the same snapshot.
        if (wanted.has(key)) {
          if (rec.stoppedAt === undefined) {
            rec.stoppedAt = now;
            marked++;
          } else if (ranBefore && rec.stoppedAt === now) {
            marked++;
          }
        }
        const verdict = worktreeVerdicts?.get(key);
        // Recorded regardless of who stamped stoppedAt: the worktree fact is ours either way.
        if (verdict !== undefined && typeof rec.worktree === 'string') {
          rec.worktreeKept = verdict;
        }
      }
      ranBefore = true;
    },
    onSkip === undefined ? undefined : { onSkip },
  );
  if (wrote.contested !== undefined) {
    // The marks reached the file, but the write lock was taken away from this process while
    // it wrote and re-applying them did not settle whether they are still there (pool.ts,
    // runLedgerWrite): something outside the 2.0 lock protocol was writing the same ledger.
    // Nothing more can be done from here; it is said, where there is somewhere to say it. A
    // channel of its own, because `errors` means "nothing was marked" to markWorkerStopped,
    // and this is not that fact.
    contested?.push(`${cwd}: ${wrote.contested}`);
  }
  return marked;
}

/**
 * A ledger record's IDENTITY as a map key: its (name, jobId) pair, exactly the identity
 * pool.ts's `isSameWorkerRecord` compares.
 *
 * The NUL separator is not decoration — a name and a job id are both free-form strings out of a
 * hand-editable file, and any printable separator can be forged inside one of them to make two
 * different records collide on one key (which, for markStopped, means stamping a record nobody
 * targeted). NUL cannot appear in either value on any path that writes them.
 *
 * The residual: two records genuinely sharing BOTH a name and a job id are one key, so both are
 * stamped. That is a duplicated row in a corrupted ledger, and duplicates of a record we proved
 * dead are the one case where stamping "extra" is harmless — they describe the same session.
 */
function recordKey(rec: MeshWorkerRecord): string {
  const name = typeof rec.name === 'string' ? rec.name : '';
  const jobId = typeof rec.jobId === 'string' ? rec.jobId : '';
  return `${name}\u0000${jobId}`;
}

/**
 * Whether a record still owns a git worktree ON DISK, and so must survive history prune/clear
 * (INV-3). Disk existence is the SOLE signal — the `worktreeKept` flag is NOT trusted. A worktree
 * removed AFTER that flag was written (a stop, a manual `git worktree remove`, `claude rm`) leaves
 * the flag stale, which made removed-worktree records permanently un-clearable and showed false
 * "uncommitted branch" warnings in the history view (observed in real 1.5.1 use). Under auto-commit
 * at settle the work is a durable COMMIT on the branch anyway, so pruning a record whose worktree
 * is gone can never lose work; an on-disk worktree simply means "there is un-integrated work here".
 *
 * The path stored on a record is WORKSPACE-RELATIVE (e.g. `.claude/worktrees/cco-<taskId>`), so it
 * is resolved against the ledger's own workspace `cwd` (passed in — the record carries no
 * workspace, and a sweep runs with an unrelated process.cwd()). Empty / absolute / `..`-escaping
 * values name no worktree this workspace owns and are rejected before existsSync.
 */
export function keptWorktree(rec: MeshWorkerRecord, cwd: string): boolean {
  const worktree = rec.worktree;
  if (typeof worktree !== 'string' || worktree === '') {
    return false;
  }
  const resolved = path.resolve(cwd, worktree);
  if (resolved === cwd || !resolved.startsWith(cwd + path.sep)) {
    return false;
  }
  return fs.existsSync(resolved);
}

/*
 * THE GHOST CLASS BUYS NO PROBE OF ITS OWN — the decision, and why it changed.
 *
 * There used to be a `boughtGhostProbe(rec)` gate here: a record marked stopped within the last
 * fifteen minutes was allowed to fund a `claude agents --json` — a subprocess that REWRITES the
 * target account's `.claude.json` and creates a `backups/` directory beside it — so a stop that
 * silently failed could be caught in the same sitting. That purchase was justified while the
 * finding it produced led to an ACTION: the sweep stopped the ghost it found.
 *
 * It no longer does. The ghost branch is REPORT ONLY, and the report it writes is
 * `ReapReport.ghostsFound`, which no caller in this codebase reads: the extension shows only
 * `report.stopped.length` and the MCP server's mesh init discards the report entirely. So the
 * purchase had become a write into every configured account — the operator's own `~/.claude`
 * included — on every activation within fifteen minutes of a CLEAN SHUTDOWN (the ordinary state:
 * `fireAndForgetStopOwned` marks every owned record stopped on the way out), to produce a string
 * that is pushed onto an array and dropped. A side effect on somebody's account config is not a
 * reasonable price for an unread line.
 *
 * WHAT IS KEPT. The ghost class is still EXAMINED on every sweep, and still reported when a
 * listing exists — it rides for free on any probe bought for an ownerless orphan or for
 * retention, and those are the sweeps that matter: a CRASH (the case where a live worker has no
 * owner at all) leaves records UNMARKED, so they are ownerless orphans and fund their own probe
 * on the other arm entirely. What is given up is only the clean-shutdown case, where a stop
 * failed silently and no other reason to list exists — and giving it up costs nothing today,
 * because finding that ghost would not have stopped it either.
 *
 * WHEN TO PUT IT BACK: the moment `ghostsFound` reaches a surface a human reads, or the moment
 * the automatic stop returns to that branch. Then a fresh stop mark is again worth a listing,
 * and the fifteen-minute window (a `claude stop` lands within seconds or never, so only a mark
 * from this sitting is worth spending on) is the shape to restore.
 */

/**
 * Whether a record may be dropped from the ledger by history retention (B2 cap-prune and B3
 * clear).
 *
 * The safety FLOOR: the record must be stopped, must own no
 * surviving worktree (INV-3 — a record still owning a worktree on disk is NEVER removed,
 * because that would orphan a git branch that may hold uncommitted work), and must not be the
 * live task↔transcript join of a task that has not settled yet (joinsUnsettledTask).
 *
 * The floor alone is not enough. It reads the stopped MARK as a
 * proxy for "not live" — which is exactly the proxy a ghost falsifies, and a ghost is what
 * the old name/pid liveness manufactured. A ghost arrives here with
 * the floor already satisfied; cap-prune and the "clear stopped workers" command then deleted
 * the ledger records of workers that were still RUNNING, after which nothing could ever find
 * them again.
 *
 * So removal now also requires POSITIVE evidence that the worker is not live. `liveness` is
 * supplied by the caller because this function is called from inside `mutateMeshWorkers`'
 * synchronous read-modify-write and cannot await a probe; the caller obtains the verdicts
 * first and hands them in. WITH NO ORACLE, OR AN UNKNOWN VERDICT, NOTHING IS REMOVABLE — the
 * default is the safe one, so a caller that forgets to pass liveness under-prunes (a longer
 * history list) instead of deleting a live worker's only record.
 */
export function removable(rec: MeshWorkerRecord, cwd: string, liveness?: WorkerLiveness): boolean {
  if (rec.stoppedAt === undefined || keptWorktree(rec, cwd)) {
    return false;
  }
  // The floor's newest clause, and the one the floor was missing entirely: a record whose task
  // is still UNSETTLED is the only route left to that task's outcome (see joinsUnsettledTask).
  // Checked before liveness on purpose — it is the cheaper test and it does not care whether
  // the worker is alive: a stopped, PROVEN-DEAD worker whose report is sitting in its
  // transcript is exactly the case this clause exists for.
  if (joinsUnsettledTask(rec)) {
    return false;
  }
  let live: boolean | undefined;
  try {
    live = liveness?.(rec);
  } catch {
    live = undefined; // a caller-supplied oracle that throws proves nothing
  }
  // Strictly `=== false`: `undefined` is UNKNOWN, and unknown never removes anything.
  return live === false;
}

/* ------------------------------------------------------------------------- *
 * A record nothing can ever look at again — and when it stops being kept
 * ------------------------------------------------------------------------- */

/**
 * How long past its own clock a record whose account is not configured is kept.
 *
 * Its clock is the dispatch's recorded deadline, or — for a record that carries none — its
 * spawn time plus the registry's worker timeout. Until that clock has run out the record is a
 * dispatch that may be in progress; for a day after it the record is still the only thing that
 * tells a person a session may be running under an account they removed, and how to stop it.
 * A day is long enough for that to have been read on every surface that shows it, and for a
 * registry that lost the account by accident to have got it back.
 */
const UNCHECKABLE_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * What one sweep needs in order to decide that a record's account is NOT CONFIGURED: the
 * trusted dirs of a registry that was actually read, and that registry's worker timeout.
 */
interface UncheckableRecordRule {
  /** trustedConfigDirsOf the registry as read for this sweep. */
  trusted: ReadonlyMap<string, string>;
  /** The registry's worker timeout, for a record that carries no deadline of its own. */
  timeoutMs: number;
}

/** The registry file is read up to this size when only its presence is being established. */
const REGISTRY_PRESENCE_MAX_BYTES = 1_048_576;

/** Is there a registry FILE with something in it right now? (Not: can it be understood.) */
function registryFileHoldsSomething(): boolean {
  const read = readTextSafe(REGISTRY_FILE, REGISTRY_PRESENCE_MAX_BYTES);
  return read.ok && read.text.replace(/^\uFEFF/, '').trim() !== '';
}

/**
 * The rule for this sweep, or undefined when the registry COULD NOT BE READ.
 *
 * "This dir is not an account" is a statement about the registry's contents, and an unreadable
 * registry has none to state: it reads as a registry with no workers at all, under which every
 * worker account's records would look abandoned at once. Only a read that succeeded and does not
 * list a dir counts — so with no rule nothing is ever dropped, and the records are looked at
 * again by the next sweep.
 *
 * A registry file that is MISSING or EMPTY is no such read either. The registry's own reader
 * calls that a first run and answers "no workers, nothing wrong", which is right for a machine
 * that has never dispatched — but a ledger with records in it says this is not that machine,
 * and a file that was deleted or is about to be rewritten must not make every account's records
 * look abandoned. The file is looked for before the read and again after it, so a file that
 * goes missing around the read yields no rule.
 */
function uncheckableRecordRule(): UncheckableRecordRule | undefined {
  try {
    if (!registryFileHoldsSomething()) {
      return undefined;
    }
    const read = readRegistryChecked();
    if (read.problem !== null || !registryFileHoldsSomething()) {
      return undefined;
    }
    // The registry's own number, sanitized as every other use of it is; one that is not usable
    // stands in as the LONGEST timeout there is, which only ever keeps a record longer.
    const minutes = eventTimeoutMinutes(read.registry.workerTimeoutMinutes) ?? TIMEOUT_MINUTES_MAX;
    return { trusted: trustedConfigDirsOf(read.registry), timeoutMs: minutes * 60_000 };
  } catch {
    return undefined;
  }
}

/**
 * When a record's own clock ran out: the deadline its dispatcher recorded (sanitized by value,
 * recordDeadlineAt), else its spawn time plus the registry's worker timeout. Undefined when the
 * record carries no usable time at all — such a record is never judged expired.
 */
function recordClockEnd(rec: MeshWorkerRecord, rule: UncheckableRecordRule): number | undefined {
  const deadline = recordDeadlineAt(rec);
  if (deadline !== undefined) {
    return deadline;
  }
  const spawnedAt = rec.spawnedAt;
  return typeof spawnedAt === 'number' && Number.isFinite(spawnedAt) ? spawnedAt + rule.timeoutMs : undefined;
}

/**
 * Whether a record is one NOTHING HERE CAN EVER LOOK AT AGAIN and whose time is long over — the
 * one class this module removes from a ledger without positive evidence about its worker.
 *
 * Every other removal demands proof that the worker is not live (removable), and proof comes
 * from a listing of the record's account. A record whose account is no longer configured has no
 * account to list — by design, since no `claude` command is ever aimed at a dir that is not a
 * configured account — so it can never be proven anything: never stopped, never marked, never
 * pruned. Left at that, it would stay in the ledger and on every status surface for good.
 *
 * So it is kept exactly as long as it can still matter, and each clause is one way it can:
 *   - its account IS configured (again) in the registry as read for this sweep → an ordinary
 *     record, with a listing to ask; nothing here applies;
 *   - it does not carry a name this workspace mints → never touched, like every other class;
 *   - it is unstopped and a process that owns it is still running → that process answers for
 *     it, and stops it itself at the latest when it ends;
 *   - it still owns a worktree on disk → it is the pointer to work nobody has merged, and that
 *     outranks tidiness here as it does for every other removal (INV-3);
 *   - its own clock ran out less than UNCHECKABLE_RECORD_GRACE_MS ago, or it has no clock.
 * The join to an unsettled task is deliberately NOT a clause: the caller settles that task
 * first and re-checks, because here the record is about to go and the task must not be left
 * pointing at nothing.
 */
function expiredUncheckableRecord(
  rec: MeshWorkerRecord,
  cwd: string,
  rule: UncheckableRecordRule,
  now: number,
): boolean {
  if (trustedRecordDir(rec, rule.trusted) !== undefined) {
    return false;
  }
  if (!parseMeshWorkerName(rec.name, cwd)) {
    return false;
  }
  if (rec.stoppedAt === undefined && ownerAlive(rec)) {
    return false;
  }
  if (keptWorktree(rec, cwd)) {
    return false;
  }
  const end = recordClockEnd(rec, rule);
  return end !== undefined && Number.isFinite(now) && now > end + UNCHECKABLE_RECORD_GRACE_MS;
}

/** One workspace's sweep. Accumulates into `report`; never throws for a single worker. */
async function reapWorkspace(
  cwd: string,
  claudePath: string,
  prober: LivenessProber,
  report: ReapReport,
  uncheckable: UncheckableRecordRule | undefined,
): Promise<void> {
  /** The RECORDS this sweep proved may be stamped stopped — never their names (see markStopped). */
  const toMark: MeshWorkerRecord[] = [];
  /**
   * Orphans this sweep left alone because their liveness could not be established, each with
   * the line that says so. Held until the end of the sweep rather than said on the spot: a
   * record that the last block below REMOVES is not one that was "left running and unmarked",
   * and it gets that block's line instead of this one — one line per record per sweep.
   */
  const leftUnknown: Array<{ rec: MeshWorkerRecord; line: string }> = [];
  /**
   * Worktree verdicts from the `claude rm` that finishes each stop this sweep performs (A11),
   * keyed on RECORD IDENTITY for the same reason the marks are: a namesake generation's record
   * must not inherit a teardown verdict about a different session's worktree.
   */
  const worktreeVerdicts = new Map<string, boolean>();
  /**
   * Finish one teardown: `claude rm <jobId>` after the session is down, so a clean worktree is
   * removed and a dirty one is KEPT and recorded (never force-removed, never touched by path).
   * Deliberately runs ONLY where this sweep actually STOPPED a live worker — either class of
   * them: the mark-only and leave-alone branches below stop nothing, and paying a bounded
   * subprocess per stale record would turn extension activation into a serial parade of
   * `claude` spawns.
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
        worktreeVerdicts.set(recordKey(record), removal.kept);
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
  /**
   * THE stop policy, applied to ONE record the probe proved LIVE: clean `claude stop <jobId>`
   * under the worker's OWN account, then a pid-confirmed forced kill, then the `claude rm`
   * teardown. Returns true when the session is down, false when it is still running and the
   * reason has been reported.
   *
   * REACHED FROM EXACTLY ONE CLASS: an OWNERLESS ORPHAN whose record does not say stopped. It
   * used to be shared with the already-stopped (ghost) class and carried an `alreadyMarked` flag
   * to word its failures for both; that class is report-only now, so the flag described a call
   * that could not happen and the parameter is gone with the branch. Everything reaching this
   * function therefore has a record that is UNMARKED, which is what the failure text below may
   * assume. If the ghost stop ever returns, this is the policy to call — do not write a second
   * copy of a procedure that ends in SIGKILL — but its failure wording ("its record already
   * lies") has to come back with it.
   */
  const stopLiveWorker = async (rec: MeshWorkerRecord): Promise<boolean> => {
    // `rec.configDir` IS A TRUSTED DIR HERE, by construction and not by luck: this function is
    // reached only on a `true` verdict, and the prober gives a record whose dir is not one of
    // the operator's Claude Code accounts no verdict at all (createLivenessProber's oracle).
    // Everything below — the stop, the session-registry read, the `claude rm` — leans on that.
    //
    // Clean path first: `claude stop <jobId>` under the worker's OWN account, since the job id
    // is meaningless to any other config dir. runMeshProcess never rejects; a spawn failure, a
    // timeout and a non-zero exit all come back as an outcome to classify.
    const outcome = await runMeshProcess(
      claudePath,
      ['stop', rec.jobId],
      spawnCwd(cwd),
      claudeEnv(rec.configDir),
      MESH_STOP_TIMEOUT_MS,
    );
    if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
      await finishTeardown(rec);
      return true;
    }
    // Forced path. The pid is re-derived from a FRESH read of the session registry, keyed on
    // the JOB ID, and re-confirmed to still be alive: the recorded pid may be minutes old, and
    // the OS recycles pids. That finds the right FILE; whether the process behind its pid is
    // still the worker is asked separately, immediately before the signal (below).
    const fresh = findSessionEntryByJobId(sessionsDir(rec.configDir), rec.jobId, rec.name);
    if (!fresh || !isPidAlive(fresh.pid)) {
      // No pid we may signal. The old code marked the record stopped here on the theory that a
      // missing entry means a dead worker — but this lookup is a capped scan of a directory that
      // may hold tens of thousands of files, so the absence proves nothing, and the probe proved
      // this one LIVE moments ago.
      // Marking it would be exactly the ghost-manufacturing write this rework removes: stamped
      // stopped, skipped by every later sweep, running forever. Report and leave it alone.
      report.errors.push(
        `${rec.name}: claude stop failed (${describeProcFailure(outcome)}) and no signalable session ` +
          `entry for job ${rec.jobId} could be found. The worker was listed as LIVE, so its record ` +
          `is left untouched rather than marked stopped — stop it manually with ` +
          `${claudeCommandFor(rec.configDir, `stop ${shellToken(rec.jobId)}`)}.`,
      );
      return false;
    }
    // THE IDENTITY GATE, in the same turn as the signal (pool.ts, "Process identity"). The entry
    // is this record's by job id and its pid is alive — and neither says whose process that is
    // NOW: a session that was killed leaves its entry behind and the OS hands the pid on. The
    // process must be running the Claude Code CLI at this instant, and must not have started
    // after the entry says its session did, or nothing is signalled.
    if (!entryPidIsWorker(fresh, claudePath)) {
      const line =
        `${rec.name}: claude stop failed (${describeProcFailure(outcome)}) — ${unconfirmedPidRefusal(fresh.pid)} ` +
        `(the process holding the pid its session entry names is not running the Claude Code CLI, or ` +
        `started after that entry says the session did, or one of the two could not be established), so ` +
        `nothing was signalled and its record is left untouched. If the worker is still running, stop it ` +
        `with ${claudeCommandFor(rec.configDir, `stop ${shellToken(rec.jobId)}`)}.`;
      report.errors.push(line);
      // Said on stderr too: a forced stop that was withheld is not something to learn only from
      // a report nobody reads.
      logMeshProblem(line);
      return false;
    }
    try {
      process.kill(fresh.pid, 'SIGKILL');
    } catch (e) {
      report.errors.push(
        `${rec.name}: claude stop failed (${describeProcFailure(outcome)}) and SIGKILL of pid ${fresh.pid} ` +
          `failed: ${(e as Error).message}. The worker is still running — stop it manually.`,
      );
      return false;
    }
    // Outside the try on purpose: only process.kill can throw here, and a teardown problem
    // must never be reported as a failed SIGKILL.
    await finishTeardown(rec);
    return true;
  };
  const records = readMeshWorkerRecords(cwd);
  // P5.2: only names that parse as OURS for THIS workspace. A record naming a foreign
  // workspace's worker (a hand-edited ledger, a copied state file) is never touched — the name
  // is the only proof we have that the session belongs to us. Note what the name is used for
  // HERE and nowhere else: a workspace-boundary test, never an identity for liveness or a kill.
  const orphanCandidates = records.filter(
    (rec) => rec.stoppedAt === undefined && Boolean(parseMeshWorkerName(rec.name, cwd)) && !ownerAlive(rec),
  );
  // The second class: records that ALREADY say stopped. Almost all of them are honest history
  // and this sweep will do nothing to them — but a stop that silently failed lives in here too,
  // and it is the only place it can live (see the header's third ghost source). No owner test:
  // the mark is somebody's recorded intent that this session be gone, and whether the process
  // that recorded it is still running says nothing about whether the stop landed — a UI cancel
  // fails silently under a perfectly healthy server. The P5.2 name check DOES apply, exactly as
  // above: a record naming a foreign workspace's worker is never signalled, whatever it says
  // about itself.
  const stoppedOurs = records.filter(
    (rec) => rec.stoppedAt !== undefined && Boolean(parseMeshWorkerName(rec.name, cwd)),
  );
  // THE PROBE GATE (M8), split from the class it used to be welded to — because "which records
  // are worth EXAMINING" and "which records may BUY a subprocess" are different questions, and
  // conflating them is what made the ordinary post-shutdown state pay a `claude agents --json`
  // per account on every activation. A probe REWRITES the target account's `.claude.json` and
  // creates a `backups/` directory beside it, and the trusted set includes the operator's OWN
  // main `~/.claude`.
  //
  // NOTHING IN `stoppedOurs` BUYS ONE ANY MORE. That class is report-only and its report is read
  // by nobody (see "THE GHOST CLASS BUYS NO PROBE OF ITS OWN" above), so it funds no write to an
  // account. It still rides FOR FREE: the loop below runs over every record in it and the oracle
  // answers UNKNOWN for any account this sweep did not list, so a ghost is still reported
  // whenever a listing was bought for some other reason (an ownerless orphan, a retention prune)
  // and happened to cover its account. Zero extra spawns by construction — these records are
  // deliberately NOT in the list handed to `prober.verdicts`, which is the only thing that
  // decides which config dirs get written to.
  // The history-retention floor, computed WITHOUT liveness (it needs none): only records that
  // clear it could ever be pruned, so only those are worth spending a probe on. It mirrors
  // `removable`'s floor exactly, INCLUDING the unsettled-task join — a record the join clause
  // protects can never be pruned, so counting it toward the cap would keep this workspace
  // permanently "over limit" and buy a probe on every activation for a prune that cannot happen.
  const limit = readRegistry().meshHistoryLimit;
  const pruneFloor = records.filter(
    (rec) => rec.stoppedAt !== undefined && !keptWorktree(rec, cwd) && !joinsUnsettledTask(rec),
  );
  // ONE probe per workspace, and only when a decision actually depends on it: a workspace whose
  // ledger holds nothing to decide about spawns nothing and writes to no config dir. It stays
  // bounded: the prober lists each config dir at most once per SWEEP, however many workspaces
  // and records name it.
  // Order is priority, because the probe's per-call cap slices the TAIL: live orphans first
  // (a worker nobody is even trying to stop), then history retention, which only deletes rows.
  // Note which class is NOT here at all: `stoppedOurs`. It may be examined against whatever this
  // sweep already learned, but it may not cause a single additional spawn or config-dir write.
  const liveness =
    orphanCandidates.length > 0 || pruneFloor.length > limit
      ? await prober.verdicts([...orphanCandidates, ...pruneFloor], spawnCwd(cwd))
      : UNKNOWN_LIVENESS;

  for (const rec of orphanCandidates) {
    // Its task has no dispatcher left, and this loop is about to decide what becomes of its
    // worker: named in the report so the caller can have the task settled now.
    if (typeof rec.taskId === 'string' && rec.taskId !== '' && !report.orphanTaskIds.includes(rec.taskId)) {
      report.orphanTaskIds.push(rec.taskId);
    }
    const live = liveness(rec);
    if (live === undefined) {
      // UNKNOWN. Not marked, not stopped, not pruned — the record is left exactly as found.
      // Under-reaping costs quota and a cluttered ledger; over-reaping destroys somebody's
      // running work, and only one of those is recoverable.
      //
      // Said on stderr as well as in the report, one line per record (at the end of this
      // sweep — see leftUnknown): this is a worker with no owner left that this sweep would
      // have stopped had it been able to look, and neither caller of the sweep reads the
      // report's list. A record whose account stays uncheckable (the account was removed) is
      // found again by every later sweep and said again each time — it is still there, still
      // unstopped, and still nobody's — until the sweep that drops it.
      leftUnknown.push({ rec, line: `${rec.name}: left running and unmarked — ${prober.reason(rec)}.` });
      continue;
    }
    if (!live) {
      // Owner gone and the worker PROVEN absent from its own account's listing: nothing to
      // stop, the record is just stale.
      toMark.push(rec);
      continue;
    }
    // A live worker whose owner is gone — the orphan this module exists for.
    if (await stopLiveWorker(rec)) {
      // The listing that called it live is now wrong about it, and this process is the one
      // that made it wrong: withdrawn and republished at once, in the same turn as the stop
      // returning, so no status call in between is told the worker is still running.
      prober.stopped(rec);
      report.stopped.push(rec.name);
      toMark.push(rec);
    }
  }

  // The already-marked class. Nothing here has a "mark it" or a "prune it" branch: this loop
  // has exactly one action, and it fires on exactly one verdict.
  for (const rec of stoppedOurs) {
    // STRICTLY `=== true`. `undefined` is UNKNOWN and `false` is proven-absent history, and
    // BOTH mean the record is left precisely as it was found — this is the entire safety of
    // revisiting a stopped record, so it is written as an identity test against `true` rather
    // than as a truthiness test that a future edit could widen by accident. Note what is NOT
    // here: no unknownLiveness line either. That list exists to tell an operator about a live
    // worker burning quota unnoticed; on this class UNKNOWN is the normal state of every
    // history row whose account cannot be listed, and one line per row would bury the orphan
    // lines that actually need reading.
    if (liveness(rec) !== true) {
      continue;
    }
    // REPORT ONLY — this sweep does NOT stop a ghost, deliberately.
    //
    // Everything reaching this line is a session PROVEN RUNNING behind a record that says
    // stopped, i.e. a ghost. A GHOST IS A GHOST: there is no mark that exempts one any more
    // (v1.x split these by a keep-alive flag; that flag is gone, and with it the second
    // report list). What has not changed is the reason the sweep only reports: nothing in the
    // ledger can say whether a human is attached to that session right now, so an automatic
    // `claude stop` + SIGKILL here could end an interactive session in front of the person
    // typing into it, with no way for anyone to say "not this one".
    //
    // So the anomaly is REPORTED and the session is left running. That is not a loss of the
    // fix this class exists for: the liveness repair that stops ghosts being MINTED is intact,
    // mesh_status surfaces them, and the orchestrator doctrine says what to do about one.
    // Reporting a live worker costs quota; killing an attached session costs the work in it,
    // and only one of those is recoverable. Note the ledger is not touched — un-marking a
    // record would be a claim about a stop we did not perform.
    report.ghostsFound.push(rec.name);
    // Deliberately NOT added to `toMark`: the record already carries stoppedAt and markStopped
    // would refuse to restamp it anyway (its own re-check inside the write), but more to the
    // point, restamping would be wrong — the moment the stop was INTENDED is the honest one,
    // and overwriting it with "now" would erase the only trace of how long this ran unnoticed.
    // The ledger's one new fact is the worktree verdict from the teardown, and that rides the
    // write below on its own.
  }
  // What the ledger could not take goes into the report AND onto stderr (one line each): the
  // report is this sweep's answer, but neither caller of the sweep reads its error list.
  const unwritten: string[] = [];
  report.marked += markStopped(cwd, toMark, worktreeVerdicts, unwritten, unwritten);
  for (const line of unwritten) {
    report.errors.push(line);
    logMeshProblem(line);
  }

  // B2 — cap-prune stopped HISTORY (F5b history retention). Runs AFTER the orphan sweep
  // above so a record this sweep just marked stopped is a candidate in the same activation
  // (and it is covered by the probe, because the orphan candidates were part of it).
  // Of the removable records (stopped, no surviving worktree — INV-3, and
  // PROVEN not live), keep the newest `limit` by stoppedAt and delete the rest; records that
  // are NOT removable are never counted toward the cap and never dropped. `liveness` is
  // resolved before the lock and handed in, because the mutator below is synchronous and
  // cannot await — and with an UNKNOWN verdict `removable` refuses, so a record we could not
  // ask about is neither counted nor deleted. A worker this sweep REPORTED as a ghost is covered
  // by that same refusal: the oracle says `true` for it, so its record is not counted toward the
  // cap and not deleted. That is exactly right — deleting the record of a session we have just
  // proven to be RUNNING would remove the last route anything has to find it, and this sweep no
  // longer even attempts to stop it. The field, its default and its clamp are Task
  // D's (registry.meshHistoryLimit); this reads it the same way the cap read
  // meshMaxLiveWorkers — off a fresh readRegistry().
  //
  // The pre-check keeps a workspace we merely inspected from getting an empty ledger written
  // under it (mutateMeshWorkers creates the file when absent), and every deletion happens
  // INSIDE the locked read-modify-write (INV-2), re-derived from the freshest bytes there.
  if (readMeshWorkerRecords(cwd).filter((rec) => removable(rec, cwd, liveness)).length > limit) {
    mutateMeshWorkers(
      cwd,
      (workers) => {
        const removableRecs = workers.filter((rec) => removable(rec, cwd, liveness));
        if (removableRecs.length <= limit) {
          return; // another writer pruned in the window between the pre-check and this lock
        }
        // Newest first (largest stoppedAt = newest); the first `limit` are kept, the tail dropped.
        removableRecs.sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0));
        const doomed = new Set(removableRecs.slice(limit));
        for (let i = workers.length - 1; i >= 0; i--) {
          if (doomed.has(workers[i])) {
            workers.splice(i, 1);
          }
        }
      },
      {
        // A skipped prune deletes nothing, and the history simply stays over its cap until the
        // next sweep's pre-check finds it there again. Said, so a ledger that keeps growing
        // has a line that explains it.
        onSkip: (reason) => {
          const line = `${cwd}: ${reason} Its stopped-worker history was not pruned.`;
          report.errors.push(line);
          logMeshProblem(line);
        },
      },
    );
  }

  // THE RECORDS NOTHING CAN EVER LOOK AT AGAIN (expiredUncheckableRecord). Every branch above
  // leaves a record whose account is not configured exactly as it found it — that is the rule
  // — which also means no branch above can ever finish with one. This block does, a day after
  // the record's own clock ran out: it removes the RECORD and nothing else. No `claude`
  // command is run and nothing is signalled, because nothing was learned about the worker; the
  // session may still be running, and the line written for each record says so and how a
  // person stops it. Skipped whole when the registry could not be read for this sweep.
  /** Identity of every record this block removed (recordKey). */
  const droppedKeys = new Set<string>();
  if (uncheckable !== undefined) {
    try {
      for (const rec of dropExpiredUncheckableRecords(cwd, uncheckable, report)) {
        droppedKeys.add(recordKey(rec));
        report.dropped.push(rec.name);
        logMeshProblem(droppedRecordLine(rec, uncheckable));
      }
    } catch (e) {
      // Nothing above is expected to throw; if something does, no record was reported dropped
      // that was not, and the sweep still says what it left alone.
      const line = `${cwd}: checking for records whose account is no longer configured failed (${stopMarkValue((e as Error)?.message)}); none was dropped by this sweep.`;
      report.errors.push(line);
      logMeshProblem(line);
    }
  }
  for (const { rec, line } of leftUnknown) {
    if (!droppedKeys.has(recordKey(rec))) {
      report.unknownLiveness.push(line);
      logMeshProblem(line);
    }
  }
}

/**
 * Remove from one workspace's ledger every record that is expiredUncheckableRecord, settling
 * the task of each first. Returns the records that were actually removed (none when the ledger
 * skipped the write). Signals nothing and runs no command.
 *
 * THE TASK FIRST. A record is the only route from its task to an account and a job id, and a
 * task whose record is gone can only ever be settled as "no ledger record claims it". So a task
 * that is still open is settled NOW, through the same gate and the same ladder every other
 * settle goes through (which is what makes it happen exactly once): its deadline is more than a
 * day past, so with nothing known about the worker it settles as orphaned, and the note says
 * that the account is not configured and that the worker may still be running — or, if the
 * worker's report is on disk, it settles with the report. A task the gate declines to settle
 * (its result file is being written into, another process holds its settle, the task log
 * cannot be read) keeps its record for this sweep; the next one tries again.
 */
function dropExpiredUncheckableRecords(cwd: string, rule: UncheckableRecordRule, report: ReapReport): MeshWorkerRecord[] {
  const now = Date.now();
  const expired = readMeshWorkerRecords(cwd).filter((rec) => expiredUncheckableRecord(rec, cwd, rule, now));
  if (expired.length === 0) {
    return [];
  }
  const open = runningTaskIds();
  const toSettle =
    open === undefined
      ? []
      : [...new Set(expired.map((rec) => rec.taskId).filter((id): id is string => typeof id === 'string' && open.has(id)))];
  if (toSettle.length > 0) {
    try {
      reapDeadTasks(toSettle, meshTaskAliveCheck(), meshTaskRecovery());
    } catch (e) {
      const line = `${cwd}: the tasks of ${toSettle.length} record(s) due to be dropped could not be settled (${stopMarkValue((e as Error)?.message)}); those records are kept.`;
      report.errors.push(line);
      logMeshProblem(line);
    }
    // The scan of the task log this sweep has been reusing predates those settles.
    resetRunningTaskIdsCache();
  }
  const doomed = new Set(expired.filter((rec) => !joinsUnsettledTask(rec)).map(recordKey));
  if (doomed.size === 0) {
    return [];
  }
  const dropped: MeshWorkerRecord[] = [];
  mutateMeshWorkers(
    cwd,
    (workers) => {
      // Rebuilt on every run: the mutator may be applied twice (pool.runLedgerWrite), each time
      // to a fresh read, and every condition is re-derived on those bytes — a record another
      // process marked, re-homed or re-owned in the meantime is judged as it is now.
      dropped.length = 0;
      for (let i = workers.length - 1; i >= 0; i--) {
        const rec = workers[i];
        if (rec && doomed.has(recordKey(rec)) && expiredUncheckableRecord(rec, cwd, rule, now) && !joinsUnsettledTask(rec)) {
          dropped.push(rec);
          workers.splice(i, 1);
        }
      }
    },
    {
      onSkip: (reason) => {
        dropped.length = 0;
        const line = `${cwd}: ${reason} No record was dropped from this ledger.`;
        report.errors.push(line);
        logMeshProblem(line);
      },
    },
  );
  return dropped;
}

/**
 * The stderr line for a record the sweep removed as one nothing can ever look at again. One
 * line; every ledger value in it is projected for one line (stopMarkValue).
 *
 * It names the worker and its job, says WHY the record went — which account dir is not
 * configured, and when the record's time ran out — states what was NOT done (no command, no
 * signal: the session was not looked at, so it is not known to have ended), and ends with what
 * a person can still do about it.
 */
function droppedRecordLine(rec: MeshWorkerRecord, rule: UncheckableRecordRule): string {
  const who = `${stopMarkValue(rec.name)} (job ${stopMarkValue(rec.jobId) || 'none recorded'})`;
  const dir = recordConfigDir(rec);
  const end = recordClockEnd(rec, rule);
  return (
    `${who}: its record was dropped from this workspace's ledger — ` +
    (dir === undefined
      ? 'the config dir it names is not an absolute path, so it names no account'
      : `its config dir ${stopMarkValue(dir, DIR_VALUE_MAX_CHARS)} is not a Claude Code account of this installation`) +
    `, and its time ran out more than ${Math.round(UNCHECKABLE_RECORD_GRACE_MS / 3_600_000)} hours ago` +
    (end === undefined ? '' : ` (${isoOrRaw(end)})`) +
    `, so nothing here could ever look at it. No \`claude\` command was run and nothing was ` +
    `signalled — ${manualStopAdvice(rec)}.`
  );
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
  const report: ReapReport = {
    stopped: [],
    ghostsFound: [],
    marked: 0,
    errors: [],
    unknownLiveness: [],
    orphanTaskIds: [],
    dropped: [],
  };
  // One prober for the whole sweep: a config dir is listed at most once however many
  // workspaces reference it, and every probe writes to the account it targets.
  const prober = createLivenessProber(opts.claudePath);
  // Read once for the whole sweep, and only a registry that could actually be READ yields one.
  const uncheckable = uncheckableRecordRule();
  for (const workspace of ledgerWorkspaces(opts.cwd, report.errors)) {
    try {
      await reapWorkspace(workspace, opts.claudePath, prober, report, uncheckable);
    } catch (e) {
      report.errors.push(`sweep of ${workspace} failed: ${(e as Error).message}`);
    }
  }
  return report;
}

/**
 * B3 — clear ALL stopped history for one workspace (the UI "clear history" command Task D
 * wires to this export). Removes every removable record — stopped, no
 * surviving worktree, and PROVEN not live — with no cap, the difference from B2's cap-prune.
 * It honours the SAME safety floor: live workers and records still
 * owning a worktree on disk are left untouched (INV-3).
 *
 * Why this awaits. "Stopped" is a MARK, and a mark is not evidence — the whole point of this
 * release is that the mark could be written over a worker that was still running. Deleting a
 * live worker's record is unrecoverable: nothing can find that worker again. So the command
 * establishes liveness first (one `claude agents --json` per account that a candidate record
 * actually names, and none at all when nothing clears the floor) and hands the verdicts into
 * the synchronous mutator, which cannot await. A caller that already holds verdicts passes
 * them in and no probe runs. If liveness cannot be established the record simply stays —
 * a history row that will not go away is a nuisance; a deleted record for a running worker is
 * a lost session.
 *
 * One locked read-modify-write (INV-2), through mutateMeshWorkers like every other ledger
 * write. The pre-check skips the call when nothing is removable, so a workspace with no
 * clearable history does not get an empty ledger created under it.
 */
export async function clearStoppedWorkers(cwd: string, liveness?: WorkerLiveness): Promise<void> {
  let records: MeshWorkerRecord[];
  // The note is what makes the line below TRUE. readMeshWorkerRecords does not throw — an
  // unreadable ledger came back as `[]`, which reached the candidate filter as "nothing to
  // clear" and only looked like the intended refusal by accident. Now the refusal is the
  // refusal: a ledger whose bytes we could not read is never deleted from.
  const note: LedgerReadNote = {};
  try {
    records = readMeshWorkerRecords(cwd, note);
  } catch {
    return; // an unreadable ledger is never repaired by deleting from it
  }
  if (note.unreadable !== undefined) {
    return; // same rule, now actually reachable
  }
  // The floor first, and it needs no liveness: a record that fails it can never be removed, so
  // it is not worth a probe. Nothing clears the floor ⇒ zero spawns, zero writes.
  const candidates = records.filter(
    (rec) => rec.stoppedAt !== undefined && !keptWorktree(rec, cwd) && !joinsUnsettledTask(rec),
  );
  if (candidates.length === 0) {
    return;
  }
  let oracle = liveness;
  if (oracle === undefined) {
    let claudePath = '';
    try {
      claudePath = readRegistry().claudePath;
    } catch {
      // no registry: probeBgLiveness reports every dir unchecked WITHOUT spawning anything,
      // so every record stays UNKNOWN and nothing is deleted — the safe direction.
    }
    oracle = await createLivenessProber(claudePath).verdicts(candidates, spawnCwd(cwd));
  }
  const decided = oracle;
  if (!records.some((rec) => removable(rec, cwd, decided))) {
    return;
  }
  // A SKIPPED write clears nothing, and this function has no way to tell its caller: it
  // resolves to nothing by contract, and its one caller refreshes the views either way. The
  // rows are then simply still there, which is what the person who asked sees — asking again
  // is the retry — and the reason goes to stderr in one line. (Skips are the ledger's write
  // lock held by another process for its whole wait, or a state file that cannot be read: see
  // pool.ts mutateMeshWorkers.)
  mutateMeshWorkers(
    cwd,
    (workers) => {
      for (let i = workers.length - 1; i >= 0; i--) {
        const rec = workers[i];
        if (rec && removable(rec, cwd, decided)) {
          workers.splice(i, 1);
        }
      }
    },
    { onSkip: (reason) => logMeshProblem(`${cwd}: its stopped-worker history was not cleared — ${reason}`) },
  );
}

/**
 * Clean-shutdown teardown (P4.9): stop every worker THIS process owns, without waiting.
 *
 * Fire-and-forget by necessity — this is called from the server's shutdown path, which
 * runs inside signal handlers and cannot await a `claude stop` per worker before the
 * process dies. Each stop is spawned detached and unref'd so it survives us long enough to
 * do its job, and the records are marked stopped immediately, without any evidence that a
 * single stop landed. That mark is a claim, not a fact.
 *
 * WHAT CATCHES A STOP THAT SILENTLY FAILS — and the honest answer is NOTHING AUTOMATIC, so this
 * function no longer makes a no-leak claim at all. Two earlier versions of this paragraph did.
 * The first said the next sweep would "find a live worker with a dead owner and finish the job";
 * it would not, because the sweep's ownerless-orphan branch opens on `stoppedAt === undefined`
 * and the line below has just stamped every one of these records. The second said the sweep's
 * already-stopped class would stop it "with the same policy and tear it down the same way";
 * that branch is REPORT ONLY today (`// REPORT ONLY` in reapWorkspace), so what actually happens
 * to such a record is: a later sweep that can list its account NAMES it in
 * `ReapReport.ghostsFound`, and the session keeps running. Nothing signals it, nothing tears its
 * worktree down, and no caller in this codebase even reads that list.
 *
 * SO THE MARK BELOW IS A CLAIM WITH NO BACKSTOP: every record this function stamps is stopped
 * only as far as a detached spawn we could not await got to run. The residual leak is real and
 * it is bounded by nothing in this module — a `claude stop` that never lands leaves a live
 * `--bg` session that outlives the shutdown, keeps using quota, and is stopped only when a
 * human runs `claude stop <jobId>` under its account. That is the price of a
 * shutdown path that cannot await, and it is written down here rather than papered over with a
 * guarantee that was removed elsewhere.
 *
 * EVERY unstopped record this process owns is stopped — settled and parked workers included.
 * A parked worker stays attachable for as long as its session lives, and that is the bound:
 * the guarantee that no worker outlives its owning session outranks the convenience, and a
 * user who wants a session to survive can start one themselves.
 *
 * WHICH DIRS A STOP IS AIMED AT. A worker THIS PROCESS STARTED is stopped under the dir it
 * was started under, and the registry is not read for it at all (pool.spawnVettedConfigDir):
 * the pool checked that dir against the registry before it ran `claude --bg` there, and what
 * the registry says at shutdown is not evidence about a session that is already running.
 * Asking it here would cost exactly the workers this function exists for: with an account
 * removed while its dispatch ran, or a registry that cannot be read as the session ends (which
 * reads as "no workers at all"), the owned worker would be skipped — and the next session's
 * sweep cannot look at that dir either, for the same reason, so nothing would ever stop it.
 *
 * ONE EXCEPTION, and it is a refusal rather than a courtesy: a record that names this process
 * as its owner but that this process did NOT start — an `ownerPid` is a field in a file; an
 * earlier process may have worn this pid, and the ledger is hand-editable. Its dir has to be a
 * Claude Code account of this installation as the registry reads now (the pool's check),
 * because `claude` creates its config files in whatever dir it is pointed at. One that is not,
 * or that cannot be checked because the registry cannot be read, gets no command and no mark.
 *
 * NOTHING IS WITHHELD SILENTLY. Every owned record this function does not aim a stop at is
 * named on stderr with the reason, one line each (logMeshProblem), and so is a ledger that
 * could not be read at all: the process is exiting, and that line is the only trace there
 * will be of a session left running.
 *
 * The `claude rm` finisher (A11) is CHAINED on each stop's exit rather than skipped: it is
 * the only ordering available without a shell, and it is strictly best effort — if this
 * process exits before the stop child closes, the removal simply never runs and the
 * worktree stays on disk, which is the harmless direction. Nothing is ever force-removed.
 */
export function fireAndForgetStopOwned(cwd: string, ownerPid: number, claudePath: string): void {
  const owned: MeshWorkerRecord[] = [];
  try {
    // The registry's answer, for a record this process did NOT start. Built on first need and
    // at most once: a shutdown whose owned workers were all started here — every ordinary one
    // — never opens the registry at all.
    let registryAnswer: { isAccount: ClaudeAccountCheck; problem: string | null } | undefined;
    const askRegistry = (): { isAccount: ClaudeAccountCheck; problem: string | null } => {
      if (registryAnswer === undefined) {
        let hostDir = '';
        try {
          hostDir = hostConfigDir();
        } catch {
          // no home directory in a stripped environment: 'main' is then simply not an account
          // here (an empty dir matches nothing) — one fewer dir, never a wrong one
        }
        // THE POOL'S OWN CHECK, not this module's absolute-only map (trustedConfigDirs): the
        // question is the one the pool asks before it starts a session under a dir, so the two
        // cannot disagree about a record one of them wrote and the other is to stop. Read
        // CHECKED, because "the registry lists no such account" and "the registry could not be
        // read" withhold the same stop for different reasons, and the line below says which.
        const read = readRegistryChecked();
        registryAnswer = {
          isAccount: claudeAccountDirCheck(claudeAccounts(read.registry, hostDir)),
          problem: read.problem,
        };
      }
      return registryAnswer;
    };
    const note: LedgerReadNote = {};
    const records = readMeshWorkerRecords(cwd, note);
    if (note.unreadable !== undefined) {
      // Not "this session owns no workers": the file that says which it owns could not be
      // read, so none of them is stopped here. Said, because nothing else will say it.
      logMeshProblem(
        `${cwd}: the mesh ledger could not be read at session end (${note.unreadable}), so no ` +
          `session worker of this session was stopped. One that is still running keeps running ` +
          `until it is stopped with \`claude stop <job>\` under its account.`,
      );
    }
    for (const rec of records) {
      if (rec.stoppedAt !== undefined || rec.ownerPid !== ownerPid) {
        continue;
      }
      if (!spawnVettedConfigDir(rec.configDir)) {
        // Owned on the ledger's word, and not started by this process: the registry decides.
        // A dir that fails gets NO command — and NO MARK either: nothing was stopped, and
        // stamping `stoppedAt` over a stop that was never attempted would mint the very ghost
        // this module exists to prevent. Left unmarked with an owner that is about to be gone,
        // it is what the next sweep meets as an orphan — stopped then if its account can be
        // listed, and reported as one whose liveness is unknown if it cannot.
        const registry = askRegistry();
        if (!registry.isAccount(rec.configDir)) {
          logMeshProblem(withheldSessionEndStop(rec, registry.problem));
          continue;
        }
      }
      try {
        const child = spawn(claudePath, ['stop', rec.jobId], {
          cwd: spawnCwd(cwd),
          env: claudeEnv(rec.configDir),
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
              env: claudeEnv(rec.configDir),
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
      } catch (e) {
        // Could not even spawn the stop, so this worker is certainly still running. The record
        // is still marked below (the caller's intent is unchanged, and an unmarked record here
        // would leave the ledger claiming a worker this process no longer owns) — which means
        // this worker lands in exactly the leaked state the header describes: a later sweep can
        // REPORT it as a ghost if it manages to list the account, and nobody stops it but a
        // human. Same outcome as a stop that spawns and then fails silently — except that this
        // one is known here and now, so it is said.
        logMeshProblem(
          `${stopMarkValue(rec.name)} (job ${stopMarkValue(rec.jobId) || 'none recorded'}): \`claude stop\` could ` +
            `not be started for it at session end (${stopMarkValue((e as Error)?.message)}), and its record ` +
            `is marked stopped all the same — ${manualStopAdvice(rec)}.`,
        );
      }
      // The RECORD, not its name: this process owns THIS generation of the worker, and a
      // namesake record from an earlier one must not be stamped by our shutdown.
      owned.push(rec);
    }
    // Nothing reads a return value here and the process is about to exit, so a mark that
    // could not be written is said on stderr (one line) and that is all. The records it would
    // have stamped then still name this process as their owner — which, once it is gone, is
    // exactly what makes them the next sweep's orphans.
    const unsaid: string[] = [];
    markStopped(cwd, owned, undefined, unsaid, unsaid);
    for (const line of unsaid) {
      logMeshProblem(line);
    }
  } catch (e) {
    // Shutdown must never throw — and must not go quiet either: whatever was not reached
    // above was not stopped.
    logMeshProblem(
      `${cwd}: the session-end stop of this session's workers did not finish ` +
        `(${stopMarkValue((e as Error)?.message)}); one that is still running keeps running until ` +
        `it is stopped with \`claude stop <job>\` under its account.`,
    );
  }
}

/**
 * The stderr line for an owned record the session-end stop was NOT aimed at, one line, with
 * every ledger value in it projected for one line (stopMarkValue).
 *
 * It names the worker and its job, says that this process did not start it — the only kind of
 * record this can happen to — and then which of the two reasons applies, because they call for
 * different repairs: `registryProblem` set means the registry could not be READ, so the check
 * was never made (repair the file); null means the registry was read and does not list that
 * dir as a Claude Code account (the account was removed, or the record is not what it seems).
 */
function withheldSessionEndStop(rec: MeshWorkerRecord, registryProblem: string | null): string {
  const who = `${stopMarkValue(rec.name)} (job ${stopMarkValue(rec.jobId) || 'none recorded'})`;
  const dir = stopMarkValue(rec.configDir, DIR_VALUE_MAX_CHARS);
  const why =
    registryProblem !== null
      ? `whether its config dir ${dir} is a Claude Code account of this installation could not be ` +
        `checked, because the registry could not be read (${stopMarkValue(registryProblem)})`
      : `its config dir ${dir} is not a Claude Code account of this installation as the registry ` +
        `reads now`;
  return (
    `${who} was NOT stopped at session end: this process did not start it, and ${why}. No ` +
    `\`claude\` command was aimed at it and its record is unchanged — ${manualStopAdvice(rec)}.`
  );
}

/** Per-workspace ledger reads, memoized for the life of one sweep closure. */
interface LedgerCache {
  forWorkspace(cwd: string): MeshWorkerRecord[];
  all(): MeshWorkerRecord[];
  /**
   * The workspace whose ledger a record was read from, or undefined for a record this cache
   * never handed out.
   *
   * A record does NOT carry its own workspace, and the io channel of record is addressed by
   * (workspace, taskId) — so without this, a record found through `all()` (a task event that
   * predates `TaskEvent.cwd`) could name no result file at all. Keyed on object IDENTITY, never
   * on (name, jobId): two workspaces may hold records that compare equal, and picking the wrong
   * one would aim a read at another workspace's io directory.
   */
  workspaceOf(rec: MeshWorkerRecord): string | undefined;
}

/**
 * One sweep's ledger reads, shared by every callback that needs them.
 *
 * A sweep runs over hundreds of task events; without this, each one re-reads (and re-parses)
 * the same state files. An unreadable ledger memoizes as an EMPTY record list rather than
 * propagating: both callers treat "no record" as "no evidence", which is the safe answer, and
 * a throw out of a registry callback would be a failure the recovery paths exist to clean up.
 */
function createLedgerCache(): LedgerCache {
  const ledgers = new Map<string, MeshWorkerRecord[]>();
  /** record object → the workspace whose ledger it came out of (see LedgerCache.workspaceOf). */
  const origin = new WeakMap<MeshWorkerRecord, string>();
  let everyLedger: MeshWorkerRecord[] | undefined;

  const forWorkspace = (cwd: string): MeshWorkerRecord[] => {
    let records = ledgers.get(cwd);
    if (!records) {
      try {
        records = readMeshWorkerRecords(cwd);
      } catch {
        records = [];
      }
      for (const rec of records) {
        if (rec !== null && typeof rec === 'object') {
          origin.set(rec, cwd);
        }
      }
      ledgers.set(cwd, records);
    }
    return records;
  };
  return {
    forWorkspace,
    workspaceOf: (rec: MeshWorkerRecord): string | undefined =>
      rec !== null && typeof rec === 'object' ? origin.get(rec) : undefined,
    all: (): MeshWorkerRecord[] => {
      if (!everyLedger) {
        const all: MeshWorkerRecord[] = [];
        for (const workspace of ledgerWorkspaces(undefined, [])) {
          all.push(...forWorkspace(workspace));
        }
        everyLedger = all;
      }
      return everyLedger;
    },
  };
}

/**
 * The mesh-aware liveness callback for registry.reapDeadTasks (contract §6 P6.1) — the GATE in
 * front of every terminal verdict a sweep can write about an attachable task.
 *
 * A `--bg` dispatch task's EVENT records no pid (its worker is not our child), so the registry's own pid
 * checks see nothing alive and would orphan every in-flight attachable task the moment a sweep
 * ran. This closure is what stands between such a task and a reconcile — and because the
 * reconcile is TERMINAL (it appends a done/error event and a note to the output file, and the
 * task never returns to 'running'), a wrong answer here is not a missed optimisation. It is a
 * finished verdict written over somebody's running work.
 *
 * WHAT THIS USED TO BE, AND WHY IT WAS THE SAME DEFECT THIS RELEASE REMOVED EVERYWHERE ELSE.
 * The old oracle looked up an UNSTOPPED record BY NAME, then read a session-registry entry BY
 * NAME and tested its pid, with a spawn-grace window as the only other way to answer "alive".
 * The name was the fault: worker names are REUSED across generations, so a name lookup can
 * resolve to a different session entirely and its entry is then evidence about the wrong
 * worker. Worse, the result was
 * TWO-STATE: `false` meant both "proven dead" and "we could not look". Two triggers were
 * reproduced with the worker genuinely running:
 *   (a) a GHOST record — `stoppedAt` stamped by the shutdown path with no evidence the stop
 *       landed — makes the `stoppedAt === undefined` find miss, so the answer is `false`;
 *   (b) an unstopped record whose account's `sessions/` dir is unreadable or empty and whose
 *       `spawnedAt` is older than the grace window, so the answer is `false`.
 * Neither consulted `probeBgLiveness`, which lives one import away and would have said `true`.
 *
 * WHAT IT IS NOW. The join is by `taskId` (never a name), liveness is `probeBgLiveness` keyed on
 * `jobId` — read from the snapshot the reaper's own prober publishes, because this runs inside
 * `dispatch_status` and a POLL may not spawn a child that rewrites the user's config dirs — and
 * the answer is TRI-STATE, resolved against the dispatch's DURABLE DEADLINE:
 *
 *   dispatching process GONE and a     → not alive, AT ONCE, whatever the deadline and whatever
 *   result file the channel ACCEPTS      the listing says: the worker reported completion in the
 *                                        one channel it was given, and the only process that
 *                                        would have collected that report no longer exists. The
 *                                        deadline bounds a task with NO result; it was never a
 *                                        reason to sit on a finished one (resultOfGoneOwnerSettles).
 *   dispatching process still ALIVE     → ALIVE, until the deadline plus a bounded grace. That
 *                                        process owns this task's own timeout/death paths, and
 *                                        this sweep cleans up after owners that are GONE (M10).
 *   worker PROVEN LIVE                 → ALIVE. It is genuinely still working; skip the task.
 *   liveness UNKNOWN, deadline unpassed → ALIVE. Unknown is not death. Guessing here writes a
 *                                        terminal verdict over a worker that may be mid-report.
 *   liveness UNKNOWN, deadline PASSED   → not alive, so the task settles — and the recovery hook
 *                                        then says PLAINLY that liveness could not be
 *                                        established (describeSnapshotLiveness). This is the one
 *                                        sanctioned terminal verdict on unknown liveness, and it
 *                                        is what keeps a dead session's task from sitting at
 *                                        'running' forever now that its in-memory timer is gone.
 *                                        ONE exception, and it is the same rule applied to the
 *                                        channel instead of the session: if the task's own
 *                                        result file is being WRITTEN INTO as we look
 *                                        (midWriteResultDefersSettle), the settle is declined
 *                                        and a later sweep takes it. A torn read is UNKNOWN, and
 *                                        UNKNOWN is never a verdict.
 *   worker PROVEN ABSENT               → not alive.
 *   no mesh ledger record at all       → today's non-mesh behaviour, untouched.
 *
 * Note the ghost case (a) is closed by the join alone: the record is found by `taskId`
 * REGARDLESS of `stoppedAt`, because a mark is a claim about a stop, not evidence about a
 * session — and this module's whole premise is that the claim is sometimes false.
 *
 * Results are memoized for the life of the returned closure, so a sweep over hundreds of task
 * events reads each ledger once. Create a fresh closure per sweep.
 */
export function meshTaskAliveCheck(): (t: TaskEvent) => boolean {
  const cache = createLedgerCache();
  const verdicts = new Map<string, boolean>();
  // Read once per sweep, not once per task: the fallback for events written before
  // TaskEvent.timeoutMinutes existed.
  let fallbackMinutes: number | undefined;
  let fallbackRead = false;
  // What the task log recorded for a task's result token. Reads the log at most once per
  // sweep, and only if some task reaches the one question that needs it (a result file sitting
  // in the channel of a task that is about to be settled on its deadline).
  const recordedToken = createRecordedTokenLookup();

  return (t: TaskEvent): boolean => {
    try {
      const name = t?.meshWorker;
      if (typeof name !== 'string' || name === '') {
        return false; // not an attachable task — the caller's normal pid rules decide
      }
      const id = typeof t.id === 'string' ? t.id : '';
      const key = `${typeof t.cwd === 'string' ? t.cwd : ''}::${id}::${name}`;
      const cached = verdicts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      if (!fallbackRead) {
        fallbackMinutes = registryTimeoutMinutes();
        fallbackRead = true;
      }
      const alive = meshTaskIsAlive(t, id, cache, fallbackMinutes, recordedToken);
      verdicts.set(key, alive);
      return alive;
    } catch {
      // An unreadable ledger or a hostile event shape cannot prove the task alive, and this
      // callback may never throw into the sweep: the caller then reconciles the task exactly
      // as it would have with no callback at all.
      return false;
    }
  };
}

/* ------------------------------------------------------------------------- *
 * ONE TASK, SEVERAL LEDGER RECORDS — what a duplicate may and may not withdraw
 * ------------------------------------------------------------------------- */

/**
 * The workspace whose io root holds this task's channel of record, from whatever is available.
 *
 * THE CHANNEL NEEDS NO LEDGER RECORD. `bgResultFile(workspace, taskId)` is addressed by
 * (workspace, taskId) alone: the record contributes nothing to locating it except, for an event
 * written before `TaskEvent.cwd` existed, the workspace its own ledger was read from. That is why
 * this resolution is shared by the liveness side and the recovery side, and why it is happy with
 * a MATCH SET rather than a single record — duplicates that came out of one ledger name one
 * workspace, and nothing about their number changes which directory the file is in.
 *
 * Order: the records' own ledger origin first (it is the directory the dispatching MCP server was
 * running in, i.e. the one whose hash names the io root), then the event's `cwd`. Those two can
 * only ever disagree when the records were found through the all-ledgers path, which is taken
 * precisely when the event carries no usable cwd — so in practice they agree or only one exists.
 * Records from GENUINELY different workspaces resolve to no workspace at all rather than to a
 * guess: reading another workspace's io directory for this task id is exactly the misdirected
 * read the token gate exists to catch, and it is cheaper not to make it.
 */
function ioWorkspaceFor(task: TaskEvent, matches: MeshWorkerRecord[], cache: LedgerCache): string | undefined {
  const origins = new Set<string>();
  for (const rec of matches) {
    const origin = cache.workspaceOf(rec);
    if (typeof origin === 'string' && origin !== '') {
      origins.add(origin);
    }
  }
  if (origins.size === 1) {
    for (const origin of origins) {
      return origin;
    }
  }
  return typeof task.cwd === 'string' && task.cwd !== '' ? task.cwd : undefined;
}

/**
 * The liveness of a task that several ledger records claim, resolved in the ONE direction this
 * module is allowed to resolve anything: toward "still running".
 *
 * TWO RECORDS FOR ONE taskId IS NOT A CORRUPT LEDGER — it is what a mesh QUOTA-STALL FAILOVER
 * produces. The first worker is spawned and recorded, the dispatch fails over, a second record is
 * pushed carrying the same taskId, and the first is only MARKED stopped and kept for days by
 * history retention. So the duplicate case is an ordinary operational state, and whatever it does
 * must be defensible on a dispatch that is working correctly.
 *
 * The rule, and why each arm is the safe one:
 *   - ANY record PROVEN LIVE ⇒ LIVE. One live session doing this task's work is enough; the other
 *     records describe generations that are over.
 *   - EVERY record PROVEN ABSENT ⇒ not live. Absence is only ever read off a listing that was
 *     actually enumerated (snapshotLiveness), so this is the same positive evidence the
 *     single-record case settles on, required of every candidate rather than of one. It is
 *     STRICTLY STRONGER than the single-record rule, never weaker.
 *   - ANYTHING ELSE (one record unknown, or records that disagree) ⇒ UNKNOWN. Unknown is not
 *     death: it means "alive until the deadline" downstream, never a terminal verdict.
 *
 * WHAT THIS REPLACES. The old code took `matches.length === 1 ? matches[0] : undefined` and fed
 * the `undefined` to `snapshotLiveness`, which is the same UNKNOWN this returns — but it did the
 * same thing to the OWNER test (see anyOwnerAlive), and that one is not symmetric: a duplicate
 * silently WITHDREW the dispatcher-alive grace, so a failed-over dispatch could be settled
 * `orphaned` by a foreign sweep while its own process was still inside its bounded timeout path.
 */
function aggregateSnapshotLiveness(matches: MeshWorkerRecord[]): boolean | undefined {
  let allAbsent = matches.length > 0;
  for (const rec of matches) {
    const verdict = snapshotLiveness(rec);
    if (verdict === true) {
      return true;
    }
    if (verdict !== false) {
      allAbsent = false;
    }
  }
  return allAbsent ? false : undefined;
}

/**
 * Whether ANY record claiming this task has a live owning process (M10's grace, made
 * duplicate-proof).
 *
 * The grace exists because a LIVE OWNER SETTLES ITS OWN TASK: while that MCP server process is
 * running it holds this dispatch's timeout path, death path and result watcher, and this sweep
 * exists to clean up after owners that are GONE. A failover leaves a stopped first record whose
 * owner is the SAME live server as the second record's — so demanding a unique record before the
 * grace applies withdrew it in exactly the case it was written for. Any live owner is a live
 * owner, and the residual is the one this module lives with everywhere: a recycled pid makes us
 * wait out the grace on a task we could have settled at its deadline.
 */
function anyOwnerAlive(matches: MeshWorkerRecord[]): boolean {
  return matches.some((rec) => ownerAlive(rec));
}

/** One attachable task's liveness decision. Split out only so the memo above stays readable. */
function meshTaskIsAlive(
  t: TaskEvent,
  id: string,
  cache: LedgerCache,
  fallbackMinutes: number | undefined,
  recordedToken: RecordedTokenLookup,
): boolean {
  if (id === '') {
    return false; // nothing to join on — the caller's normal rules decide
  }
  // An event with no cwd (older builds) still has to be answerable, so fall back to every
  // workspace's ledger — a taskId is minted by the server and unique across them.
  const records = typeof t.cwd === 'string' && t.cwd !== '' ? cache.forWorkspace(t.cwd) : cache.all();
  const matches = records.filter((rec) => rec.taskId === id);
  if (matches.length === 0) {
    // No mesh ledger record claims this task. Nothing here can say anything about it — there is
    // no jobId to key a listing on and no configDir to aim one at — so the answer is the one
    // this callback gave before it existed, and the registry's own ladder takes it from there.
    return false;
  }
  // Liveness is keyed on a jobId, and several records claiming one task offer several. They are
  // NOT resolved by picking one — they are resolved in the safe direction only (any proven live ⇒
  // live, every one proven absent ⇒ absent, anything else ⇒ UNKNOWN, which below means "alive
  // until the deadline"). See aggregateSnapshotLiveness for why a duplicate is an ordinary
  // failover artifact rather than a corrupt ledger.
  const live = aggregateSnapshotLiveness(matches);
  // The dispatcher's own recorded deadline when a record carries one (dispatchDeadline), else
  // the one re-derived from the event.
  const deadline = dispatchDeadline(t, matches, fallbackMinutes);
  // THE DEADLINE RACE, AND THIS SIDE DELIBERATELY LOSES IT (M10). Both deadlines are wall-clock
  // and fire within milliseconds of each other: the dispatching process's own timeout path takes
  // ~30-60s of bounded steps (stop the worker, probe, one last read of the result file, commit
  // the worktree) during which its task is still 'running' — and an activation-time reap landing
  // inside that window writes `orphaned — worker process is no longer running` FIRST. The
  // in-session catch then sees a foreign terminal event, reports that text, and skips
  // `recordFailure`, so the account's timeout accounting and cooldown never record the dispatch
  // and the orchestrator is told "orphaned" instead of "timed out after N minutes".
  //
  // The rule that removes the race from this side is the module's own orphan rule, applied one
  // level up: A LIVE OWNER SETTLES ITS OWN TASK. `ownerPid` on the ledger record is the MCP
  // server process that dispatched this worker and owns its whole lifetime; while that process
  // is alive it holds the timeout path, the death path and the result watcher for this task, and
  // this sweep exists to clean up after owners that are GONE. So a task whose owner is still
  // running is reported alive — and it stays bounded, because a wedged owner may not pin a task
  // at 'running' forever: past the deadline plus DISPATCHER_SETTLE_GRACE_MS the reaper settles it
  // anyway, and the recovery note then says the dispatcher was still alive (describeDispatcherState).
  //
  // This is only ever MORE conservative than before: it can turn a terminal verdict into "still
  // running", never the reverse, so no unknown-liveness rule is loosened by it. The residual is
  // the documented one this module lives with everywhere — a recycled `ownerPid` makes us wait
  // out the grace on a task we could have settled at the deadline.
  //
  // DUPLICATES DO NOT WITHDRAW THIS GRACE (see anyOwnerAlive). It used to require a UNIQUE record,
  // which quietly disarmed it on the one ledger shape a quota-stall failover always produces: two
  // records for one taskId, the stopped first generation and the live second, both owned by the
  // same running server. A foreign sweep then settled that task `orphaned` one minute past its
  // deadline while the process that owns it was still inside its bounded timeout path.
  //
  // ONE THING COMES BEFORE THAT GRACE, and before the listing and the deadline too: a FINISHED
  // REPORT WITH NOBODY LEFT TO COLLECT IT. When every process that owned this dispatch is gone
  // and the task's own result file passes every gate the live path applies, the task is over —
  // by the worker's own deliberate act — and it settles now (resultOfGoneOwnerSettles). The
  // rule cannot take a task away from a LIVE owner: it asks first that every claimed owner be
  // proven gone, and an owner that is running is exactly the case the grace below is for.
  if (resultOfGoneOwnerSettles(t, id, matches, cache, recordedToken)) {
    return false;
  }
  if (anyOwnerAlive(matches) && (deadline === undefined || Date.now() <= deadline.at + DISPATCHER_SETTLE_GRACE_MS)) {
    return true;
  }
  if (live !== undefined) {
    return live;
  }
  // No derivable deadline ⇒ it has not passed. An unknowable budget must never read as a spent
  // one: the failure mode of the other choice is a terminal verdict on every mesh task in a
  // workspace whose registry could not be read.
  if (deadline === undefined || Date.now() <= deadline.at) {
    return true;
  }
  // UNKNOWN LIVENESS AND THE DEADLINE PASSED — the one sanctioned terminal verdict in this
  // module, and the only place a task settles without anyone having established that its worker
  // is gone. Before handing it over, ONE last question, and it is the question the recovery hook
  // used to answer wrongly: is the channel of record being WRITTEN INTO right now?
  //
  // `readBgResultForRecovery` classifies its refusals: a torn parse, a file that grew under the
  // read, a read that failed, an empty file — each on a file something touched moments ago — is
  // `transient`, i.e. indistinguishable from a worker that is mid-report. Under this release's
  // invariant that state is UNKNOWN, and UNKNOWN is never a verdict, so the task stays 'running'
  // and a later sweep reads the finished file. The refusal that CAN'T be a mid-write (a token
  // that does not match, a foreign taskId, a shape no worker writes) is `permanent` and settles
  // here exactly as before.
  //
  // THIS FILE CANNOT DECLINE A SETTLE BY ITSELF: it has no write access to the task log and the
  // recovery hook's vocabulary (done/error/unresolved) has no "not yet" in it. Declining is done
  // by RETURNING TRUE HERE — `registry.taskLooksAlive` is the sole gate in front of a settle, and
  // it is consulted twice: once in `reapDeadTasks`' loop and again inside `settleDeadTask` under
  // the task's reconcile lock, immediately before the terminal event is appended. True at either
  // point abandons the settle with the task untouched.
  //
  // Bounded by construction: `transient` requires a file touched within RESULT_MID_WRITE_GRACE_MS,
  // so a file nothing is writing settles on the very next sweep. Cost is one stat + one bounded
  // read, and only for a task that was about to be settled — never on the ordinary poll path.
  return midWriteResultDefersSettle(t, id, matches, cache, recordedToken);
}

/**
 * How much later than the record's own times a process may read as having started and still be
 * taken for the record's owner. registry.processStartedAt is good to about a second and is read
 * with a `ps` in between; the rest is room for two processes stamping one moment.
 */
const OWNER_START_SLACK_MS = 5_000;

/**
 * What the process table says about the owner ONE record names — by pid alone, no subprocess:
 *   `none`     the record names no process (no `ownerPid`, or a value that is not a pid);
 *   `gone`     no process holds that pid;
 *   `ours`     it is this very process;
 *   `running`  some process holds it. Whether that is still the owner is a separate question
 *              (ownerPidPassedOn), asked only where the answer changes something.
 */
function ownerPidState(rec: MeshWorkerRecord): 'none' | 'gone' | 'ours' | 'running' {
  const pid = rec.ownerPid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return 'none';
  }
  if (pid === process.pid) {
    return 'ours';
  }
  return isPidAlive(pid) ? 'running' : 'gone';
}

/**
 * Has the pid a record names as its owner PASSED TO ANOTHER PROCESS? Asked of a pid that is
 * alive and is not this process's.
 *
 * A dead owner's pid is handed on by the OS, and from then on `isPidAlive` answers for a
 * stranger. The one thing the record can be checked against is time: its owner was running
 * when it wrote the record — at `spawnedAt`, and at `ownerStartedAt` before that — so a process
 * that STARTED after the later of the two, by more than the slack, cannot be that owner.
 *
 * ONE-SIDED, and only "yes" is ever acted on: a start time that could not be read (no `ps`,
 * win32), a record with no usable time, or a process old enough to be the owner all answer
 * "no", and the pid then counts as a live owner exactly as it always did. The reading is taken
 * from the wall clock as it stands now (registry.processStartedAt), so on a platform where a
 * process's age is measured on a clock the wall clock can be stepped against, a step FORWARD
 * made while the owner runs moves the answer later by as much — a live owner could then read
 * as a later holder if the step exceeds the time it had already been running at the spawn,
 * plus the slack. The only decision resting on this is the one below, which is taken with the
 * worker's own valid report in hand; such an owner would have recorded the same report a
 * moment later.
 */
function ownerPidPassedOn(rec: MeshWorkerRecord): boolean {
  const pid = rec.ownerPid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  let lastKnownRunning: number | undefined;
  for (const at of [rec.ownerStartedAt, rec.spawnedAt]) {
    if (typeof at === 'number' && Number.isFinite(at) && (lastKnownRunning === undefined || at > lastKnownRunning)) {
      lastKnownRunning = at;
    }
  }
  if (lastKnownRunning === undefined) {
    return false;
  }
  let startedAt: number | undefined;
  try {
    startedAt = processStartedAt(pid);
  } catch {
    startedAt = undefined;
  }
  return startedAt !== undefined && startedAt > lastKnownRunning + OWNER_START_SLACK_MS;
}

/**
 * How long a result accepted by the liveness gate is kept for the recovery hook of the same
 * settle (rememberAcceptedResult). The two run back to back inside one registry call, so this
 * is generous by four orders of magnitude; it only has to be short enough that a reading is
 * never carried into a later, unrelated sweep.
 */
const ACCEPTED_RESULT_MEMO_MS = 60_000;

/** The `result` arm of BgResultRecovery. */
type AcceptedBgResult = Extract<BgResultRecovery, { kind: 'result' }>;

/**
 * Results the liveness gate accepted a moment ago, by (workspace, task id), for the recovery
 * hook that settles the same task.
 *
 * MODULE STATE, like the liveness snapshot and for the same kind of reason: the gate and the
 * hook are two closures the registry is handed separately (meshTaskAliveCheck /
 * meshTaskRecovery), and when the gate lets a task settle BEFORE ITS DEADLINE because a valid
 * result is on disk, the hook must record THAT result. It reads the file again, and a file can
 * change between two reads — a worker that rewrites its report in place leaves it empty for an
 * instant — and without this the task would be settled as a failure, early, on the strength of
 * a report the second read did not see. One reading decides, and the same reading is recorded.
 * Bounded: an entry is dropped when it is used, when it is superseded, and when it is older
 * than the window, and the map is pruned on every insert.
 */
const acceptedResults = new Map<string, { at: number; result: AcceptedBgResult }>();

function acceptedResultKey(workspace: string, taskId: string): string {
  return `${workspace}\u0000${taskId}`;
}

function rememberAcceptedResult(workspace: string, taskId: string, result: AcceptedBgResult): void {
  const now = Date.now();
  for (const [key, entry] of acceptedResults) {
    if (!(now - entry.at >= 0 && now - entry.at <= ACCEPTED_RESULT_MEMO_MS)) {
      acceptedResults.delete(key);
    }
  }
  acceptedResults.set(acceptedResultKey(workspace, taskId), { at: now, result });
}

/** The reading the gate accepted for this task within the window, taken out of the memo. */
function takeAcceptedResult(workspace: string, taskId: string): AcceptedBgResult | undefined {
  const key = acceptedResultKey(workspace, taskId);
  const entry = acceptedResults.get(key);
  if (entry === undefined) {
    return undefined;
  }
  acceptedResults.delete(key);
  const age = Date.now() - entry.at;
  return age >= 0 && age <= ACCEPTED_RESULT_MEMO_MS ? entry.result : undefined;
}

/** Test seam: forget every remembered reading (a fresh process starts with none). */
export function resetAcceptedResultMemo(): void {
  acceptedResults.clear();
}

/**
 * Whether this task is OVER BY ITS WORKER'S OWN REPORT with nobody left to collect it: every
 * process that owned the dispatch is gone, and the task's result file is one the channel
 * accepts. True means "not alive — settle it now", whatever the deadline and whatever a listing
 * says about the worker (a worker that has reported and parked is still running, and its task is
 * finished all the same; the live path settles in exactly that state).
 *
 * WHY THIS IS NOT LEFT TO THE DEADLINE. The deadline is what stands in for an owner's timer once
 * the owner is gone, and until it passes an unknown liveness reads as "still running". For a
 * dispatch made by a build that recorded no timeout the stand-in is the 16-hour fallback
 * (FALLBACK_DEADLINE_MINUTES), so on the deadline alone a task whose worker finished in its
 * first minute — report on disk, token valid — sits at 'running' for the rest of the day,
 * across exactly the update that orphaned it. The other use of the result file on this side,
 * midWriteResultDefersSettle, can only DEFER a settle. A finished report is stronger evidence
 * than an unknown budget, so it is allowed to make one.
 *
 * WHAT "THE OWNER IS GONE" MEANS HERE, precisely, since settling a live owner's task from under
 * it is the one thing this must not do:
 *   - EVERY record claiming the task must NAME an owner (`ownerPid`, a real pid). A record that
 *     names none proves nothing about whether a process is still waiting on this dispatch, and
 *     the rule does not apply — the deadline decides, as before.
 *   - none of those pids may be THIS process: it is running, and it settles its own tasks.
 *   - each must be a pid no process holds, or one that has demonstrably passed to a process
 *     that started after the record was written (ownerPidPassedOn). A pid that is merely
 *     alive, with nothing to show it changed hands, is a live owner.
 * A failover's two records normally name one owner; any live owner among several is a live
 * owner (anyOwnerAlive), so every one of them has to be gone.
 *
 * WHAT IS NOT CHANGED. A file that is present and mid-write is not an accepted result: nothing
 * settles here, and at the deadline it defers the settle as before. No file at all keeps the
 * deadline. A file that is refused for good is not a report and does not bring a settle forward
 * either — it is stated in the note whenever the task does settle.
 *
 * Order of the questions is by cost, since this is asked on every status poll of a task whose
 * worker has not been proven anything: the pid tests cost nothing; the file is opened only for
 * a task none of whose owners is this process (one failed open when there is no file); and the
 * process table is read only for an owner pid that is alive while an accepted result is
 * actually on disk. Total: any surprise answers "no", and the task is judged as it always was.
 */
function resultOfGoneOwnerSettles(
  task: TaskEvent,
  id: string,
  matches: MeshWorkerRecord[],
  cache: LedgerCache,
  recordedToken: RecordedTokenLookup,
): boolean {
  try {
    const owners = matches.map((rec) => ownerPidState(rec));
    if (owners.length === 0 || owners.some((state) => state === 'none' || state === 'ours')) {
      return false;
    }
    const workspace = ioWorkspaceFor(task, matches, cache);
    if (workspace === undefined) {
      return false;
    }
    const channel = readBgResultForRecovery(workspace, id, recordedToken);
    if (channel.kind !== 'result') {
      return false;
    }
    for (let i = 0; i < matches.length; i++) {
      if (owners[i] === 'running' && !ownerPidPassedOn(matches[i])) {
        return false;
      }
    }
    rememberAcceptedResult(workspace, id, channel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the task's own result file is in a state that says "a writer is still writing", which
 * is the one thing that may hold off the deadline-only settle above.
 *
 * Deliberately NOT a claim that the worker is alive — nothing here proves that, and this module
 * never manufactures liveness. It is the narrower, checkable fact that the CHANNEL is in motion,
 * and the reason it outranks the deadline is the asymmetry the whole recovery ladder is built
 * on: settling early publishes `error: orphaned` over a report that is landing as we read, and
 * `settleDeadTask` never revisits a settled task; waiting costs one more sweep.
 *
 * Total: every path inside the reader is guarded, and any surprise here answers "do not defer",
 * because a bug in a safety check must not become a way to pin tasks at 'running'.
 */
function midWriteResultDefersSettle(
  task: TaskEvent,
  id: string,
  matches: MeshWorkerRecord[],
  cache: LedgerCache,
  recordedToken: RecordedTokenLookup,
): boolean {
  // The io channel is addressed by (workspace, taskId): the ledger the records came out of, or
  // the event's own cwd for records found through the all-ledgers path. With neither, there is
  // no file to look at and nothing to defer for. Note what is NOT required — a single ledger
  // record: this function already resolved the workspace without one, which is the proof that the
  // recovery hook's ambiguity guard never needed to stand in front of the result file either.
  const workspace = ioWorkspaceFor(task, matches, cache);
  if (workspace === undefined) {
    return false;
  }
  try {
    const channel = readBgResultForRecovery(workspace, id, recordedToken);
    return channel.kind === 'refused' && channel.bucket === 'transient';
  } catch {
    return false;
  }
}

/**
 * How long past its deadline a task whose DISPATCHING PROCESS is still alive is left alone, so
 * that process's own bounded timeout path wins the settle and records it properly (M10).
 *
 * Five minutes against a path measured in tens of seconds: an order of magnitude of headroom for
 * a loaded machine, and still short enough that a dispatcher which is alive but wedged cannot
 * strand a task at 'running'. It is a grace on the REAP, never on the worker — nothing is left
 * running by it that would otherwise have been stopped.
 */
const DISPATCHER_SETTLE_GRACE_MS = 5 * 60 * 1000;

/**
 * The dispatching process's state, when it is worth saying (M10).
 *
 * Reached only where the reaper settled a task ANYWAY — past the deadline and past the grace
 * above — so a live owner here is an anomaly worth writing down: that process still holds this
 * task's own timeout path, and whatever it eventually records (including the `recordFailure`
 * that feeds account cooldowns) will land after this verdict. Silent when the owner is gone,
 * which is the ordinary case this whole module exists for.
 *
 * Takes the MATCH SET for the same reason describeSnapshotLiveness does: a failover leaves two
 * records for one task, and ANY of them naming a live owner is the anomaly worth reporting.
 */
function describeDispatcherState(matches: MeshWorkerRecord[]): string {
  // Deduplicated: a failover's two records for one task normally name the SAME owning server, and
  // "pid 4242, 4242" reads as two dispatchers where there is one.
  const pids = [...new Set(matches.filter((rec) => ownerAlive(rec)).map((rec) => rec.ownerPid))];
  if (pids.length === 0) {
    return '';
  }
  return (
    ` Note: its DISPATCHING PROCESS (pid ${pids.join(', ')}) was still running when this task was ` +
    `settled here, well past its deadline — that process owns this dispatch's own timeout path, ` +
    `so check for a later event from it before treating this verdict as the whole story.`
  );
}

/* ------------------------------------------------------------------------- *
 * The mesh CHANNEL OF RECORD — a finished worker's own result file
 * ------------------------------------------------------------------------- */

/**
 * What ONE cross-session look at a dispatch's `result.json` produced.
 *
 * Three outcomes, and the split between the last two is the point (see the module header):
 *   - `none` — no file was ever written there. Silence, and the honest thing to do with it is
 *     nothing at all: the transcript rung takes over and says what it can.
 *   - `result` — a file that passed every gate the LIVE path applies. This is the worker's own
 *     act of reporting completion, so it settles the task: `done` when it says done, `error`
 *     when it says error.
 *   - `refused` — a file EXISTS and was not accepted. Never silently dropped: "a result file
 *     was present and refused" is a completely different operational fact from "no result file
 *     existed" (a forged or misdirected write, a torn file, a report past the read cap, a task
 *     whose log records no token to check it against), and it is the only clue a human gets before the
 *     24h artifact sweep removes the evidence. The note travels into the task's output file.
 *
 * EVERY REFUSAL CARRIES ITS BUCKET, and the split is the correction a hostile review forced.
 * A refusal used to be a single class, which quietly asserted that every unusable file is a
 * FINAL artifact — and that assertion is false on the one arm that reaches this reader most
 * often. `meshTaskIsAlive` settles a task on UNKNOWN liveness plus a passed deadline, and the
 * note it emits for that arm says in so many words "the worker may still be running": a torn
 * read taken at that moment is not evidence of a corrupt file, it is evidence of a WRITE IN
 * PROGRESS. Refusing it terminally is a verdict built on an UNKNOWN, and it is irreversible —
 * `settleDeadTask` re-reads the task's status under its lock and never revisits a task that is
 * no longer 'running'. So:
 *   - `transient` — the state is consistent with a writer that is still writing (a torn parse,
 *     a file that grew under the read, a read that failed, a created-but-empty file), AND the
 *     file was touched recently enough for that to be more than a theory (see
 *     RESULT_MID_WRITE_GRACE_MS). It must not settle the task while liveness is UNKNOWN; the
 *     caller declines and a later sweep looks again. One more refusal is transient for a
 *     reason of its own: the task log could not be read just now, so what this task recorded
 *     for its token is not known — which says nothing about the file.
 *   - `permanent` — no writer produces this by being mid-write: a token that does not match, an
 *     embedded taskId naming a different task, a shape no worker writes, a file past the read
 *     cap, a non-file, or any of the transient shapes on a file nothing has touched for the
 *     grace above. It is a stated refusal and it may settle.
 */
type BgResultRecovery =
  | { kind: 'none' }
  | { kind: 'result'; status: 'done' | 'error'; report: string; file: string }
  | { kind: 'refused'; note: string; bucket: 'transient' | 'permanent' };

const NO_BG_RESULT: BgResultRecovery = { kind: 'none' };

/**
 * Wrap a refusal reason as the outcome, so every rejection path reads identically.
 *
 * The bucket is a REQUIRED argument on purpose: a default would decide the most consequential
 * property of a refusal by omission, and the two directions are not symmetric — a wrongly
 * `permanent` refusal writes a terminal verdict over a running worker, a wrongly `transient` one
 * leaves a task at 'running' for another sweep.
 */
function refuseBgResult(note: string, bucket: 'transient' | 'permanent'): BgResultRecovery {
  return { kind: 'refused', note, bucket };
}

/**
 * Stand-in for a well-formed result whose report is BLANK.
 *
 * The live path substitutes its own note for the same case, and here there is a second reason:
 * `registry.consultRecovery` discards a `done` whose text is empty, so returning the blank
 * verbatim would throw away not just the report but the whole answer — the task would settle as
 * a bare orphan and the fact that the worker reported completion would vanish with it.
 */
const EMPTY_RECOVERED_REPORT =
  'The worker reported COMPLETION through its result file but left the report EMPTY, so this ' +
  'dispatch is settled with no deliverable to hand on. Inspect its worktree/branch before ' +
  're-dispatching — the work may exist even though the report does not.';

/**
 * WHAT THE TASK LOG RECORDED for one task's result token — the expectation a result file found
 * by a later session is checked against — or `undefined` when the log could not be read.
 *
 * WHY THE HISTORY AND NOT THE EVENT IN HAND. The recovery hooks are handed one event of the task
 * (the latest), and this log is a file any process of the user can append a line to. An
 * expectation read off the latest event is therefore one a later line can replace; the rule
 * that cannot be moved is "the FIRST event of the task that carries a well-formed value fixes
 * it" (registry.firstRecordedIoToken, which is the one implementation of that rule). So the log
 * is read here — once per sweep closure, lazily, and only when a result file is actually there
 * to be judged — and the events are kept for the life of the closure so every task of the sweep
 * is resolved from one snapshot.
 *
 * UNREADABLE IS NOT "NOTHING RECORDED". `undefined` is returned only when the read itself failed
 * (or returned a shape that cannot prove it was read); the caller then says so and does not
 * treat the file as unvalidatable for good. A log that was read and holds no token field for the
 * task answers `{}`, which is a different fact and a different refusal.
 */
type RecordedTokenLookup = (taskId: string) => RecordedIoToken | undefined;

function createRecordedTokenLookup(): RecordedTokenLookup {
  /** undefined = not read yet; null = could not be read. */
  let events: TaskEvent[] | null | undefined;
  const found = new Map<string, RecordedIoToken>();
  return (taskId) => {
    if (events === undefined) {
      events = null;
      try {
        const read: unknown = readTaskEventsChecked();
        if (typeof read === 'object' && read !== null) {
          const checked = read as { events?: unknown; unreadable?: unknown };
          // Consumed BY VALUE and in the paranoid direction, as taskStateIndex does: only an
          // explicit `unreadable === false` is a log that was read.
          if (checked.unreadable === false && Array.isArray(checked.events)) {
            events = checked.events as TaskEvent[];
          }
        }
      } catch {
        // a throw out of the reader proves nothing about what was recorded: unreadable
      }
    }
    if (events === null) {
      return undefined;
    }
    let recorded = found.get(taskId);
    if (recorded === undefined) {
      recorded = firstRecordedIoToken(events, taskId, 'session');
      found.set(taskId, recorded);
    }
    return recorded;
  };
}

/**
 * WHAT SHAPE an unusable recorded value had, for the refusal note — never the value.
 *
 * The distinction a reader needs is between "the log line lost this field's contents" (empty or
 * null: a truncated write, a hand edit, a placeholder) and "something wrote a value of the wrong
 * kind there", because those point at different things to go and look at. The VALUE is never
 * printed even when it is manifestly not a token: a legacy event holds the token itself in this
 * position, and the describer must not become the one place that prints the field on the day a
 * real one takes an unexpected route through here. A length is enough to tell a truncated value
 * from a stray sentence.
 */
function describeUnusableRecordedToken(recorded: RecordedIoToken): string {
  const value = recorded.sha256 !== undefined ? recorded.sha256 : recorded.legacy;
  if (value === null) {
    return 'null';
  }
  if (value === '') {
    return 'an EMPTY string — the field is present but its contents are gone';
  }
  if (typeof value !== 'string') {
    return `a ${Array.isArray(value) ? 'array' : typeof value} rather than a string`;
  }
  return `a ${value.length}-character string that is neither a token nor a token digest by value`;
}

/**
 * How long after its last write a result file may still be treated as a WRITE IN PROGRESS.
 *
 * This is the number that keeps "a torn read is UNKNOWN" from turning into "a torn read hangs
 * the task forever". A worker writes its result in one go, so the torn window is milliseconds;
 * two minutes is generous against a slow disk, a network mount or a machine under load, and
 * short enough that a genuinely truncated file left by a SIGKILLed worker settles on the next
 * sweep instead of pinning its task at 'running'.
 *
 * THE RESIDUAL, stated: a writer that keeps touching its result file keeps its task unsettled.
 * That is the correct answer — something IS writing there — and a worker that wants to hang its
 * own task has cheaper ways (never writing at all just moves the settle to the deadline).
 */
const RESULT_MID_WRITE_GRACE_MS = 2 * 60 * 1000;

/**
 * Read one dispatch's `result.json` from the mesh channel of record, applying the SAME
 * validation the live in-session path applies (mcp/bg-runner.readResultFile), because it is the
 * same file written by the same untrusted-ish writer: a worker session that was granted its own
 * io directory. Every gate below exists in that function too, and the order is the same —
 * cheapest and most structural first, the token before anything in the payload is believed.
 *
 * `recordedToken` answers what the task log recorded for this task's token (see
 * createRecordedTokenLookup). It is a lookup rather than a value so that the log is read only
 * when a file is actually there to be judged — and at most once per sweep, however many tasks
 * that sweep judges.
 *
 * THE TOKEN GATE HERE HAS ONE SOURCE. A presented token is accepted when, and only when,
 * ioToken.ioTokenProves says it matches what the task's FIRST token-carrying event recorded —
 * the SHA-256 this build writes, or the plain value an earlier build wrote. A history that
 * recorded nothing checkable (no token field on any event of the task, or one whose value is
 * not usable) REFUSES the file. There is no second source to fall back on: the task file
 * beside the result holds the token too, and reading the expectation from there would accept
 * any pair of files written by one hand.
 *
 * THE DIVERGENCE FROM THE LIVE PATH, CORRECTED. This header used to justify refusing every
 * unusable file terminally with "the dispatching process is gone and the file is final". The
 * second half is false on the arm that reaches this reader: `meshTaskIsAlive` settles a task on
 * UNKNOWN liveness plus a passed deadline, and says so in the same note ("the worker may still
 * be running"). So the live path's mitigation for a torn read — come back next tick — is not
 * dropped here, it is re-expressed: a refusal whose reason is consistent with a writer still
 * writing comes back TRANSIENT, the caller declines to settle, and a later sweep reads the
 * finished file. Only a reason no mid-write can produce is `permanent` and may settle.
 */
function readBgResultForRecovery(
  workspace: string,
  taskId: string,
  recordedToken: RecordedTokenLookup,
): BgResultRecovery {
  // The one rule for an id that becomes part of a path (registry.isTaskFileId): the value
  // reaches us out of a hand-editable event log rather than from the server that minted it.
  if (!isTaskFileId(taskId)) {
    return refuseBgResult(
      `Task id ${JSON.stringify(taskId)} is not a usable path segment, so the mesh channel of ` +
        `record was never located or read for it.`,
      // No later sweep repairs a task id: this is the same refusal every time it is asked.
      'permanent',
    );
  }
  const file = bgResultFile(workspace, taskId);
  /**
   * The mid-write clock, and NOTHING else. This directory is granted to the worker itself, so
   * every touch of it goes through safeFs: statFileSafe answers only for a REGULAR file (a
   * FIFO, a directory or a symlink to a device is `undefined` here and is refused by the read
   * below on its own terms), and the size/existence VERDICTS come from the read, not from
   * this stat — a stat cannot tell "absent" from "not a file" and this reader must.
   */
  const stat = statFileSafe(file);
  /**
   * A refusal whose REASON is consistent with a writer that is still writing. Whether it is
   * actually transient is not decided by the reason alone — a torn file that nothing has touched
   * for RESULT_MID_WRITE_GRACE_MS was demonstrably not being written when we looked, and
   * deferring on it forever would re-create the stuck-at-'running' hang this release exists to
   * end. The stamp comes from the same stat that sized the read, so it dates the file we read.
   */
  const refuseMidWrite = (note: string): BgResultRecovery => {
    if (stat === undefined) {
      // Same conclusion as a stamp we cannot date, and for the same reason: nothing here
      // demonstrates an in-flight write, and deferring forever on a file we cannot date is the
      // stuck-at-'running' hang this release exists to end. The file is still kept for a human
      // (protectedIoTaskId's post-settle grace), so this is recoverable.
      return refuseBgResult(
        `${note} Its last-write time could not be read, so nothing shows this was a read taken ` +
          `mid-write: it is treated as what the worker left behind.`,
        'permanent',
      );
    }
    const sinceTouched = Date.now() - stat.mtimeMs;
    // |age|, not age: a stamp in the FUTURE (a clock step, a hostile `touch`) cannot demonstrate
    // an in-flight write, and believing it would pin the task at 'running' on a number nothing
    // can check. An un-datable file is therefore treated as final, which is recoverable — the
    // file itself is kept for a human (protectedIoTaskId's post-settle grace).
    const fresh =
      Number.isFinite(sinceTouched) && Math.abs(sinceTouched) <= RESULT_MID_WRITE_GRACE_MS;
    if (fresh) {
      return refuseBgResult(
        `${note} It was last written to moments ago, so this is a read that may have landed ` +
          `MID-WRITE rather than a final artifact: this reader does not treat it as the worker's ` +
          `answer, and a later sweep reads the file again.`,
        'transient',
      );
    }
    return refuseBgResult(
      `${note} Nothing has written to it ` +
        `${sinceTouched >= 0 ? `for ${humanAge(sinceTouched)}` : 'since a time this machine\'s clock cannot date'}` +
        `, so it is not a read taken mid-write: the file is what the worker left behind.`,
      'permanent',
    );
  };
  /**
   * ONE guarded read, which is also the structural gate ladder — same order, same verdicts.
   * safeFs opens O_RDONLY|O_NONBLOCK and fstats that fd, so it answers in milliseconds for the
   * FIFO a worker can plant in its own io directory, refuses a symlink to /dev/zero before
   * reading it, and refuses an oversize file rather than truncating it (the property the old
   * `size + 1` read existed to get: nothing is ever truncated-then-parsed).
   *
   * THE ORDER THAT CHANGED, stated: the bytes now enter memory BEFORE the token gate rather
   * than after it. Bounded by the same cap the old code enforced, and nothing in the payload is
   * BELIEVED any earlier — the token is still checked before a single field of the parsed
   * object is read, which is what that gate is for.
   */
  // `noFollow`: the worker controls this path, and the channel reads the file AT that name. A
  // symbolic link there is refused by the open itself — even one pointing at a well-formed result
  // of this very task — because a name that resolves to some other file (another task's result,
  // any JSON this user can read) is not "the file the worker wrote into its own directory".
  const read = readTextSafe(file, BG_RESULT_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    if (read.reason === 'absent') {
      // The ordinary case for a worker that never finished: nothing was ever written here, and
      // silence is not an event worth narrating.
      return NO_BG_RESULT;
    }
    if (read.reason === 'not-a-file') {
      return refuseBgResult(
        `What is at the mesh channel of record ${file} is not a regular file (${read.detail}), so ` +
          `no result was read from it — a result is read from the file at that name, never ` +
          `through a link — and nothing was settled from that channel.`,
        // No write in progress turns a directory, a FIFO or a device into a result file.
        'permanent',
      );
    }
    if (read.reason === 'too-large') {
      return refuseBgResult(
        `A result file exists at ${file} but is ${stat === undefined ? 'larger than the' : `${stat.size} bytes — past the`} ` +
          `${BG_RESULT_FILE_MAX_BYTES}-byte read cap — so it was NOT read (never ` +
          `truncated-then-parsed) and settles nothing. The worker itself did finish; read that ` +
          `file directly before the 24h artifact sweep removes it, and inspect the worktree for ` +
          `what it produced.`,
        // Not transient even if it is still growing: no later sweep will read past the cap
        // either, so waiting would only delay a verdict this reader is already certain of.
        'permanent',
      );
    }
    // 'unreadable' — a lock, a descriptor limit, a permission change, the settle path removing
    // the directory under us. Never a statement about the worker, so it keeps the mid-write
    // clock exactly as the old post-stat read failure did.
    return refuseMidWrite(
      `A result file exists at ${file} but could not be read (${read.detail}), so it settles nothing.`,
    );
  }
  if (read.bytes === 0) {
    // The live path's "created-but-not-yet-written: come back next tick", with a clock on it.
    return refuseMidWrite(
      `A result file exists at ${file} but is EMPTY (0 bytes): the worker created its channel ` +
        `of record and never wrote a report into it, so it settles nothing.`,
    );
  }
  const recorded = recordedToken(taskId);
  if (recorded === undefined) {
    return refuseBgResult(
      `A result file exists at ${file}, but the task log could not be read just now, so what ` +
        `task ${taskId} recorded for its result token is not known and the file could not be ` +
        `validated. That says nothing about the file itself.`,
      // The one transient refusal that is not about a write in progress: the log was readable
      // a moment ago (the sweep that got here found this task in it), so a later sweep can look
      // the expectation up. "Could not read" must never be taken for "nothing was recorded".
      'transient',
    );
  }
  if (!hasRecordedIoToken(recorded)) {
    const nothingAtAll = recorded.sha256 === undefined && recorded.legacy === undefined;
    return refuseBgResult(
      `A result file exists at ${file} but it could not be validated: ` +
        (nothingAtAll
          ? `no event of task ${taskId} in the task log records a result token or its digest ` +
            `(a dispatch made by a build older than those records, or a log that lost its lines)`
          : `the task log records a result token for task ${taskId} whose value is not usable — ` +
            `it is ${describeUnusableRecordedToken(recorded)} (the value itself is not quoted here)`) +
        `. The file was REFUSED rather than believed: with nothing recorded to check its token ` +
        `against, accepting it would accept any file anything put there, and the task file beside ` +
        `it is not consulted — two files in one directory prove only that one hand wrote both. ` +
        `Read it by hand if you need what it says.`,
      // The log is append-only and its first token-carrying event fixes the expectation: no
      // later sweep finds a better one.
      'permanent',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    // THE CASE THE REVIEW WAS ABOUT. A truncated write and a file that GREW between the stat and
    // the read (the deliberate size + 1) both land here, and both are exactly what an in-flight
    // write looks like — so this refusal is only final once the file has stopped changing.
    return refuseMidWrite(
      `A result file exists at ${file} but is NOT PARSEABLE JSON — a torn, truncated or ` +
        `hand-edited write — so it settles nothing.`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuseBgResult(
      `A result file exists at ${file} but does not hold a JSON object, so it settles nothing.`,
      // A partial write of the object a worker was told to write never PARSES; producing a valid
      // array, null or scalar takes a complete write of something else entirely.
      'permanent',
    );
  }
  const rec = raw as Record<string, unknown>;
  // Gate 1 (F2.1): the per-task token, checked BEFORE any of the payload is trusted. The
  // `--add-dir` grant already names only this task's own directory, but that grant is a platform
  // behavior probed once, and a cross-session reader is even further from the spawn that made it.
  // The sentence is the live reader's own (contract.bgTokenRefusal) — literals only: nothing out
  // of the file is quoted, and nothing of what was recorded.
  if (!ioTokenProves(recorded, rec.token)) {
    return refuseBgResult(
      `A result file was found at ${file} and REFUSED: ${bgTokenRefusal(rec.token)}. It settles ` +
        `nothing. This is NOT the same as no result file existing, and it is worth finding out ` +
        `who wrote it.`,
      // Never transient, whatever the file's mtime says: a worker writing its own result does not
      // pass through a state where it echoes somebody else's token.
      'permanent',
    );
  }
  // Gate 2: the embedded id must match the DIRECTORY the file was found in, so a worker that
  // writes a neighbour's id can never settle either task.
  if (rec.taskId !== taskId) {
    return refuseBgResult(
      `A result file was found at ${file} and REFUSED: the task id inside it is not ${taskId}, ` +
        `although it sits in that task's own io directory and carried its token, so it settles ` +
        `nothing.`,
      'permanent', // a mid-write does not misname the task; a misdirected write does
    );
  }
  if (rec.status !== 'done' && rec.status !== 'error') {
    return refuseBgResult(
      `A result file was found at ${file} and REFUSED: its "status" is ${JSON.stringify(rec.status)}, ` +
        `which is neither "done" nor "error", so it settles nothing.`,
      // The live path calls this "come back next tick" because it has ticks to spare; here the
      // file parsed as a complete JSON object and carries this task's own secret, so it is a
      // finished write of a shape the dispatch protocol does not define.
      'permanent',
    );
  }
  if (typeof rec.report !== 'string') {
    return refuseBgResult(
      `A result file was found at ${file} and REFUSED: it carries no string "report" field, so ` +
        `there is nothing in it to record.`,
      'permanent', // same reasoning as the status shape above
    );
  }
  return {
    kind: 'result',
    status: rec.status,
    // Not reshaped, not truncated, not summarized — it is the worker's report, and the module
    // that recovers it is not the one that gets to edit it.
    report: rec.report.trim() === '' ? EMPTY_RECOVERED_REPORT : rec.report,
    file,
  };
}

/* ------------------------------------------------------------------------- *
 * Transcript-based task recovery — the capability registry.ts cannot reach
 * ------------------------------------------------------------------------- */

/**
 * What a recovery attempt can say about one dead task — derived FROM `registry.TaskRecovery`
 * rather than re-spelled, so the two can never drift apart:
 *
 *   { status: 'done' }  — a completed deliverable was recovered. Produced from EXACTLY ONE
 *                         source: a valid, token-matched `result.json` in the mesh channel of
 *                         record, which is the worker's own deliberate act of reporting
 *                         completion. NEVER from a transcript — the reasoning is pinned in
 *                         recoverTaskOutcome so nobody re-adds it there. It carries the
 *                         `modelUsed` the session transcript names, when it names one: a record
 *                         of what ran beside the outcome, never what decided it.
 *   { status: 'error' } — a recorded failure was recovered, from that same channel: the worker
 *                         itself wrote `"status":"error"`. Never produced from a transcript,
 *                         which cannot distinguish a failure from a pause. The prose is NOT
 *                         lost: the registry now writes the worker's full failure text into the
 *                         task's output file, nonce-fenced, and puts only a bounded single-line
 *                         excerpt in the event's `error` label — which is all a label can hold.
 *   { unresolved }      — no settling outcome, plus everything that WAS learned, in prose. The
 *                         registry writes it into the task's output file where a human is
 *                         already looking, and the task settles as `error` on the ladder's own
 *                         terms. This is the channel every transcript-derived answer uses.
 *   undefined           — no opinion at all; the registry's own ladder decides, unchanged.
 *                         Reserved for tasks that are NOT mesh dispatches.
 *
 * The hook is INJECTED into registry.ts rather than implemented there because every
 * `src/mesh/*` imports `../registry`, so the reverse edge would close an import cycle — which
 * is why the transcript-reading capability has to arrive from this side of the boundary.
 */
export type MeshTaskRecoveryResult = ReturnType<TaskRecovery>;

/**
 * The mesh-aware recovery hook for the registry's task sweep (contract §6 P6.2) — the twin of
 * meshTaskAliveCheck, answering the question that follows "is it alive?" with "then what
 * happened to it?".
 *
 * A `--bg` worker outlives the session that dispatched it, so when the orchestrator dies
 * mid-flight nothing settles its tasks: the result file the worker was told to write may never
 * have been written, and no surface can shell out to `claude` to ask. What survives
 * unconditionally is the CLI's own session transcript, which the worker appends to as it goes.
 * This closure joins a task to its mesh ledger record by `taskId`, then reads that record's
 * transcript from its `configDir` + `jobId` coordinates (mesh/transcript, which is pure and
 * never throws) and reports one of four things.
 *
 * The `unresolved` cases are as important as the recovered ones and are worded for a HUMAN:
 * "the worker died mid-turn" and "there is no transcript" are different facts about somebody's
 * unfinished work, and collapsing either into a bare "orphaned" is what made the previous
 * release's P6 hangs undiagnosable.
 *
 * AMBIGUITY IS NEVER RESOLVED BY PICKING — AND IT IS NEVER WIDENED PAST WHAT IT ACTUALLY
 * OBSCURES. Two transcripts matching one job id, or two ledger records claiming one task, leave
 * the TRANSCRIPT unread: settling a task from the wrong generation's transcript would write a
 * stranger's report into somebody's task history, and that is worse than leaving the task
 * unexplained. But that guard is about the transcript join, which needs a single `configDir` +
 * `jobId`. It says nothing about the CHANNEL OF RECORD, which is addressed by (workspace, taskId)
 * and validated against what the task log recorded for the task's token — so the result file is
 * read FIRST, before the ledger is consulted for anything, and a duplicate ledger record can no
 * longer discard a finished deliverable (see recoverTaskOutcome).
 *
 * TOTAL BY ITSELF. The registry wraps this, but it must not rely on that: every path is inside
 * one try/catch and any unexpected throw becomes `undefined` (no opinion), so a recovery hook
 * can never re-create the failure it exists to clean up. Results are memoized for the life of
 * the closure; create a fresh one per sweep.
 */
export function meshTaskRecovery(): TaskRecovery {
  const cache = createLedgerCache();
  const verdicts = new Map<string, MeshTaskRecoveryResult>();
  // Read once per sweep, not once per task — the same fallback meshTaskAliveCheck resolves, and
  // for the same reason: this hook has to be able to SAY which clock a settle ran out on.
  let fallbackMinutes: number | undefined;
  let fallbackRead = false;
  // The dirs a transcript may be looked for under — the same set a sweep may probe — read at
  // most once per sweep, and only when a task actually reaches the transcript rung.
  let trusted: Map<string, string> | undefined;
  const trustedDirs = (): Map<string, string> => (trusted = trusted ?? trustedConfigDirs());
  // What the task log recorded for a task's result token — read at most once per sweep, and
  // only when a result file is there to be checked against it.
  const recordedToken = createRecordedTokenLookup();

  return (task: TaskEvent): MeshTaskRecoveryResult => {
    try {
      const id = task?.id;
      if (typeof id !== 'string' || id === '') {
        return undefined; // nothing to join on — not our kind of task
      }
      const key = `${typeof task.cwd === 'string' ? task.cwd : ''}::${id}`;
      if (verdicts.has(key)) {
        return verdicts.get(key);
      }
      if (!fallbackRead) {
        fallbackMinutes = registryTimeoutMinutes();
        fallbackRead = true;
      }
      const verdict = recoverTaskOutcome(task, id, cache, fallbackMinutes, trustedDirs, recordedToken);
      verdicts.set(key, verdict);
      return verdict;
    } catch {
      // Total on its own: an unexpected throw is "no opinion", never a thrown sweep.
      return undefined;
    }
  };
}

/**
 * One task's recovery attempt: the mesh CHANNEL OF RECORD first, the transcript only after it.
 * Split out only so the memo/guard above stays readable.
 *
 * RUNG 1 — THE RESULT FILE, and why `done` is legitimate from it (HIGH 1). A `--bg` worker
 * reports completion by writing `bgResultFile(workspace, taskId)`, and until this rung existed
 * NOTHING outside the dispatching session ever read it: the registry ladder's own first rung
 * reads `tasks/<id>.result.json`, a different file belonging to the detach path. So a worker
 * that finished, wrote a full report and then parked on a later turn that asked a question was settled
 * `error: orphaned`, had its question published as its "last words", and had the real report
 * deleted 24 hours later by the artifact sweep. This rung reads that file, validates it exactly
 * as the live path does (token included), and settles the task from it — `done` for a reported
 * success, `error` for a reported failure. That is not a guess about a conversation; it is the
 * worker's own deliberate act of reporting completion, in the only channel it was told to use.
 *
 * WHY THE TRANSCRIPT RUNG BELOW STILL NEVER RECORDS `done`, pinned here because the temptation
 * to widen it is real and the code that did it looked correct.
 *
 * 1. THE PRECONDITION SAYS THE OPPOSITE. The registry's ladder reaches this hook only after it
 *    has proved there is no detach `result.json` and no done-shaped output file, and rung 1
 *    above has just proved there is no usable mesh result file either — i.e. the worker did NOT
 *    complete its dispatch protocol in any channel. Recording `done` from the transcript asserts
 *    exactly what every path that got us here disproved.
 * 2. A TURN BOUNDARY IS NOT TASK COMPLETION. `turn: 'ended'` means the last non-sidechain row
 *    was an assistant row with stop_reason `end_turn`, and turns are PLURAL: measured across the
 *    background transcripts on one working machine, 6 of 35 carried more than one such row (up
 *    to 4 in a single dispatch) and 17 carried none at all. A worker parks at a turn boundary
 *    when it stops to ask instead of acting, or after answering a steering message — and it can
 *    then be stopped, which makes it provably absent while its last turn is a question. Recording
 *    that as `done` publishes the worker's open question as the task's finished deliverable, which
 *    is precisely what a hostile review reproduced. The result file cannot fail this way: a worker
 *    does not write `{"status":"done"}` into its channel of record by pausing.
 * 3. THE TWO ERRORS ARE NOT SYMMETRIC. An orchestrator that reads a false `error` wastes one
 *    re-dispatch. An orchestrator that reads a false `done` ships a question as a result and
 *    builds on it. Only one of those is recoverable, so the settled status is `error` and the
 *    recovered prose is attached as EVIDENCE, labelled for what it is: the last thing the
 *    worker said, with the protocol not completed.
 *
 * Everything the transcript actually established — the turn state, the staleness, the worker's
 * last words — is still delivered, now with the liveness verdict, the deadline the settle
 * actually ran out on, whether a result file was PRESENT AND REFUSED, and whether the
 * dispatching process is somehow still alive beside it.
 */
function recoverTaskOutcome(
  task: TaskEvent,
  id: string,
  cache: LedgerCache,
  fallbackMinutes: number | undefined,
  trustedDirs: () => ReadonlyMap<string, string>,
  recordedToken: RecordedTokenLookup,
): MeshTaskRecoveryResult {
  // Scoped to the task's own workspace when it records one; otherwise every ledger, exactly as
  // the liveness callback falls back — a taskId is minted by the server and unique across them.
  const records =
    typeof task.cwd === 'string' && task.cwd !== '' ? cache.forWorkspace(task.cwd) : cache.all();
  const matches = records.filter((rec) => rec.taskId === id);
  const meshWorker = typeof task?.meshWorker === 'string' ? task.meshWorker : '';
  if (matches.length === 0 && meshWorker === '') {
    // IS THIS EVEN A MESH DISPATCH? With Mesh Mode off the default dispatch is a one-shot
    // `claude -p` child, which has no ledger record because it never had a mesh worker — and
    // the `unresolved` channel REPLACES the ladder's accurate orphan line with whatever we say
    // here. Answering "no mesh ledger record claims task …" about a task that never had one is
    // a mesh-flavoured non-answer written over a correct one, on every non-mesh orphan on the
    // machine. So we take NO OPINION unless something positively identifies this as a mesh
    // dispatch, and there is exactly one such fact available with no record to read:
    // `TaskEvent.meshWorker`, which the dispatcher sets only for an attachable worker. Absent,
    // the ladder's own wording stands, unchanged. This is the ONLY test that runs before the
    // channel of record is read, and it is not a ledger test — it is the test for whether this
    // module has any business answering at all.
    return undefined;
  }
  // RUNG 1: THE CHANNEL OF RECORD, BEFORE THE TRANSCRIPT IS OPENED *AND BEFORE THE LEDGER MAY
  // VETO ANYTHING* (HIGH 1, corrected). The io directory is addressed by (workspace, taskId): the
  // workspace is the ledger the records were read from — the same directory the MCP server that
  // dispatched it was running in, and therefore the one whose hash names the io root — falling
  // back to the event's own `cwd` for records obtained through the all-ledgers path.
  //
  // THE AMBIGUITY GUARD USED TO STAND IN FRONT OF THIS READ, AND IT COST DELIVERABLES. Two ledger
  // records claiming one taskId is not an exotic corruption: it is exactly what a mesh
  // QUOTA-STALL FAILOVER produces — the first worker is spawned and recorded, the dispatch fails
  // over, a second record carrying the same taskId is pushed, and the first is only MARKED
  // stopped and then kept for days by history retention. With the guard in front, such a task
  // came back `2 mesh ledger records claim task … none was read`, and the worker's complete,
  // token-validated `result.json` sitting on disk was never opened — the note did not even
  // mention that a result file existed, and the 24h artifact sweep took it from there.
  //
  // The guard is not wrong, it was merely applied to the wrong thing. What ambiguity in the
  // LEDGER actually costs is the TRANSCRIPT JOIN, which needs a single `configDir` + `jobId` and
  // genuinely cannot be resolved by picking. The channel of record needs neither: it is addressed
  // by (workspace, taskId) and validated against what the TASK LOG recorded for this task's
  // token, to which no ledger record contributes anything. `midWriteResultDefersSettle`
  // has resolved that same workspace with no record at all since the day it was written, which is
  // the proof this read never depended on the ledger being unambiguous. So the read happens
  // FIRST, and the ambiguity guard now governs only the rungs that are genuinely ambiguous.
  const workspace = ioWorkspaceFor(task, matches, cache);
  const channel =
    workspace === undefined
      ? refuseBgResult(
          `No workspace could be established for task ${id} — neither its dispatch event nor any ` +
            `mesh ledger record claiming it names one — so the mesh channel of record (its ` +
            `result.json) was never located or read.`,
          // Nothing a later sweep does gives this task a workspace; the event and ledger are
          // append-only history and are what they are.
          'permanent',
        )
      : readBgResultForRecovery(workspace, id, recordedToken);
  // THE READING THAT DECIDED THE SETTLE IS THE ONE THAT IS RECORDED. When the liveness gate let
  // this task settle because a valid result was on disk (resultOfGoneOwnerSettles), it kept
  // what it read; taken out here whatever this read found, so it is never carried further. It
  // is used only when this read did NOT come back with a result — the file changed in between —
  // because a task that was settled early on a report must not be recorded as a failure for
  // want of the report it was settled on.
  const remembered = workspace === undefined ? undefined : takeAcceptedResult(workspace, id);
  const accepted: AcceptedBgResult | undefined = channel.kind === 'result' ? channel : remembered;
  if (accepted !== undefined) {
    // WHAT IT WAS CHECKED AGAINST IS PART OF THE PROVENANCE, not a footnote. `how` is the one
    // line the registry writes into the task's output file to say where a recovered outcome
    // came from. It states the check that was made and claims nothing beyond it: the writer
    // knew this task's token, which is what the task log's record lets a later session verify
    // (what that does and does not rule out: contract.BG_IO_TOKEN_HEADER_PREFIX).
    const how =
      `the worker's own dispatch result file ${accepted.file} (the mesh channel of record), whose ` +
      `token was checked against what the task log recorded when this task was dispatched` +
      (channel.kind === 'result'
        ? ''
        : ` — as it read when this task was judged finished, a moment before it was recorded; ` +
          `the file has been written to since`);
    // `done` is CORRECT from here and only from here: the worker wrote this file deliberately,
    // into its own granted directory, carrying the token from its task file, to say the
    // dispatch was over. See this function's header for why the transcript may never do this.
    if (accepted.status !== 'done') {
      return { status: 'error', error: accepted.report, how };
    }
    // What ran, as a live dispatch records it (bg-runner): off the session transcript, which
    // decides nothing here — the result file did. Only for ONE ledger record under a Claude Code
    // account's dir, for the reasons the transcript rungs below give: the join needs one account
    // and one job id, and an untrusted dir is never opened.
    const only = matches.length === 1 ? matches[0] : undefined;
    const modelUsed =
      only !== undefined && only.jobId !== '' && trustedRecordDir(only, trustedDirs()) !== undefined
        ? sessionModelOf(only.configDir, only.jobId)
        : undefined;
    return { status: 'done', text: accepted.report, how, ...(modelUsed !== undefined ? { modelUsed } : {}) };
  }
  // WHAT THE CHANNEL SAID RIDES EVERY ANSWER BELOW, whatever the ledger turns out to look like.
  // "A result file was present and REFUSED" and "no result file existed" are different
  // operational facts, and the refused one is the only clue a human gets before the artifact
  // sweep removes the evidence. Silence stays silent: `none` narrates nothing.
  const channelNote = channel.kind === 'refused' ? `${channel.note} ` : '';
  // The SAME deadline the liveness gate judged this task by (meshTaskIsAlive), so the note can
  // never name a different clock from the one the settle actually ran out on.
  const deadline = dispatchDeadline(task, matches, fallbackMinutes);
  if (matches.length === 0) {
    // A mesh dispatch (its event names an attachable worker) with no ledger record left. There is
    // no `configDir` + `jobId` to locate a transcript with — but the channel of record above was
    // read anyway, because it never needed one, and whatever it found is reported here.
    return {
      unresolved:
        `${channelNote}no mesh ledger record claims task ${id} (dispatched to attachable worker ` +
        `${meshWorker}), so its worker's session transcript could not be located and nothing was ` +
        `recovered from it.`,
    };
  }
  if (matches.length > 1) {
    // THE AMBIGUITY GUARD, NOW SCOPED TO WHAT IS ACTUALLY AMBIGUOUS. The transcript join needs
    // ONE `configDir` + `jobId`, and picking one would settle the task from whichever generation
    // happened to sort first — the ledger-level twin of the transcript module's own 'ambiguous'.
    // What it no longer does is suppress the read of the channel of record, which happened above
    // and needed no record at all; if that file held the worker's report this function has
    // already returned it.
    return {
      unresolved:
        `${channelNote}${matches.length} mesh ledger records claim task ${id} (job ids ` +
        `${matches.map((rec) => rec.jobId || '<none>').join(', ')}) — the shape a quota-stall ` +
        `failover leaves behind — so NO SESSION TRANSCRIPT was read for it: that join needs one ` +
        `account and one job id, and an ambiguous match is never resolved by picking one. The ` +
        `mesh channel of record was NOT skipped for this reason; it is addressed by (workspace, ` +
        `task id) and was read first, above. ${describeSnapshotLiveness(matches, deadline)}` +
        `${describeDispatcherState(matches)}`,
    };
  }
  const rec = matches[0];
  // The liveness sentence rides EVERY answer below, because the caller that got us here may have
  // settled this task on its deadline alone (meshTaskAliveCheck's UNKNOWN + deadline-passed
  // arm). A terminal verdict reached that way must state that liveness was never established —
  // otherwise a reader has no way to tell "we watched it die" from "we stopped waiting". The
  // deadline rides with it (M6) so a settle on a FALLBACK grace is never mistaken for a settle
  // on this dispatch's own budget, and so does the dispatcher's own state (M10).
  const liveness = `${channelNote}${describeSnapshotLiveness(matches, deadline)}${describeDispatcherState(matches)}`;
  // THE TRANSCRIPT IS LOOKED FOR ONLY UNDER A CLAUDE CODE ACCOUNT'S DIR. The lookup walks
  // `<configDir>/projects/*` for a file named for the job id, and `configDir` here is a ledger
  // value: a record that names another vendor's home (or any dir that is no longer one of the
  // operator's Claude Code accounts) would have this module list THAT vendor's `projects/` —
  // some of them keep one — and, on a name collision, publish a stranger's file as "the last
  // thing the worker said". So an untrusted dir is not opened at all, and the note says the
  // transcript was never looked for, which is a different fact from "none was found". The
  // channel of record above was still read: it is addressed by (workspace, task id), not by
  // anything in an account's dir.
  if (trustedRecordDir(rec, trustedDirs()) === undefined) {
    return {
      unresolved:
        `the session transcript of job ${rec.jobId || '<none>'} (worker ${rec.name}) was NOT LOOKED ` +
        `FOR, which is not the same as none being found: ${untrustedDirReason(rec)}. ${liveness}`,
    };
  }
  const read = readWorkerTranscript(rec.configDir, rec.jobId);
  if (read.problem !== undefined) {
    return { unresolved: `${transcriptProblemText(rec, read)} ${liveness}` };
  }
  if (read.turn === 'ended') {
    const text = typeof read.finalText === 'string' ? read.finalText.trim() : '';
    if (text !== '') {
      // NOT `status: 'done'` — see this function's header. The prose is delivered through the
      // `unresolved` channel because that is the one the registry writes into the task's output
      // file verbatim, and it is framed as evidence rather than as a deliverable.
      return { unresolved: recoveredLastWordsText(rec, read, text, liveness) };
    }
    // The turn ended but the worker never emitted a single text block (thinking blocks do not
    // count — a report made of nothing is not a report). Nothing to attach, but the fact is
    // still worth stating: a completed turn with no text is a different failure from a worker
    // killed mid-sentence, and the ladder's bare "worker process is no longer running" hides it.
    return {
      unresolved:
        `worker ${rec.name}'s session transcript for job ${rec.jobId} ends at a completed TURN` +
        `${ageSuffix(read.lastRowAt)} but carries no text from the worker at all (thinking blocks ` +
        `do not count), and the dispatch protocol did not complete — no result.json and no ` +
        `completed output file — so there was nothing to recover. ${liveness}`,
    };
  }
  if (read.turn === 'mid-turn') {
    return {
      unresolved:
        `worker ${rec.name}'s session transcript for job ${rec.jobId} stops MID-TURN` +
        `${ageSuffix(read.lastRowAt)} — it died mid-turn or was killed, so it never produced a ` +
        `final report to recover. ${liveness}`,
    };
  }
  // 'unknown' with no problem set: a shape mesh/transcript does not currently produce. Nothing
  // is claimed about the outcome; only what was and was not established is reported.
  return {
    unresolved:
      `worker ${rec.name}'s session transcript for job ${rec.jobId} could not be classified ` +
      `(turn state "${String(read.turn)}" with no problem reported), so nothing was recovered ` +
      `from it. ${liveness}`,
  };
}

/**
 * The worker's last words, framed as EVIDENCE rather than as a deliverable.
 *
 * Every clause here is load-bearing, because this text is what an orchestrator (and a human)
 * reads instead of a result:
 *   - it names the precondition that got us here (no usable result.json in ANY channel, no
 *     completed output file), so the reader knows the protocol did not complete;
 *   - it says a turn boundary is not completion, and names the stopped-to-ask state
 *     that produces the most misleading case;
 *   - it labels the excerpt as the LAST THING THE WORKER SAID, not as an answer;
 *   - it carries the transcript's staleness and the liveness verdict;
 *   - it delimits the excerpt, because the worker's own prose is arbitrary text arriving in the
 *     middle of a note and an undelimited blob reads as though the system wrote it.
 *
 * The excerpt is NOT reshaped, truncated or summarized: it is somebody's work, and the module
 * that recovers it is not the one that gets to edit it.
 */
function recoveredLastWordsText(
  rec: MeshWorkerRecord,
  read: TranscriptRead,
  text: string,
  liveness: string,
): string {
  return (
    `worker ${rec.name}'s session transcript for job ${rec.jobId} ends at a completed TURN` +
    `${ageSuffix(read.lastRowAt)}, but the dispatch protocol did NOT complete: this rung is ` +
    `reached only after the sweep found no USABLE result.json in any channel (the mesh channel ` +
    `of record included — a file found there and refused is reported below) and no completed ` +
    `output file. A turn ` +
    `boundary is not task completion — a worker also ends a turn when it stops to ask a ` +
    `question instead of finishing — so the text below is recorded as EVIDENCE, NOT AS A ` +
    `RESULT: it is the LAST THING THE WORKER SAID, recovered verbatim from its session ` +
    `transcript, and it may be a question rather than a deliverable. Read it before re-dispatching; ` +
    `do not hand it on as a finished result. ${liveness}\n\n` +
    `--- worker's last transcript text (verbatim; NOT a completed result) ---\n` +
    `${text}\n` +
    `--- end of recovered transcript text ---`
  );
}

/** The `problem` a transcript read reported, named VERBATIM so the reason is diagnosable. */
function transcriptProblemText(rec: MeshWorkerRecord, read: TranscriptRead): string {
  const where = `job ${rec.jobId || '<none>'} (worker ${rec.name})`;
  switch (read.problem) {
    case 'ambiguous':
      return (
        `more than one session transcript matches ${where} — transcript problem "ambiguous" — so NONE ` +
        `was read. An ambiguous match is never resolved by picking a transcript.`
      );
    case 'not-found':
      return (
        `no session transcript was found for ${where} — transcript problem "not-found". A finished ` +
        `worker does not always leave one behind, so this is absence of evidence, not evidence of failure.`
      );
    case 'unreadable':
      return `the session transcript for ${where} could not be read — transcript problem "unreadable".`;
    case 'empty':
      return (
        `the session transcript for ${where} holds no turns — transcript problem "empty"` +
        `${ageSuffix(read.lastRowAt)}. The session registered and died before its first message.`
      );
    default:
      return `the session transcript for ${where} reported the problem "${String(read.problem)}".`;
  }
}

/** ` — its last transcript row is 3h old`, or nothing when there is no usable stamp. */
function ageSuffix(lastRowAt: number | undefined): string {
  if (typeof lastRowAt !== 'number' || !Number.isFinite(lastRowAt)) {
    return '';
  }
  const ms = Date.now() - lastRowAt;
  if (ms < 0) {
    return ''; // a transcript stamped in the future (clock skew) dates nothing
  }
  return ` (its last transcript row is ${humanAge(ms)} old)`;
}

/** A coarse age for a human reading a reason string; never a value anything decides on. */
function humanAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** An epoch-ms stamp as ISO, or the raw number when it is not a representable date. */
function isoOrRaw(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

/** Chars of a job id or a worker name kept when markWorkerStopped quotes it in a refusal. */
const STOP_MARK_VALUE_MAX_CHARS = 80;

/**
 * A job id or a worker name, projected for one line of a markWorkerStopped refusal.
 *
 * Both values are foreign here: the job id is whatever the caller holds, and a name comes out
 * of a ledger FILE any process can write. The refusal is shown to the user who just cancelled
 * something, so a line break or an invisible control in either must not be able to restyle or
 * extend it. The character rule is displayText's, shared with every other one-line surface;
 * only the length is local, sized for a value quoted mid-sentence.
 */
function stopMarkValue(value: unknown, max: number = STOP_MARK_VALUE_MAX_CHARS): string {
  const flat = flattenOneLine(value);
  return flat.length > max ? `${sliceOneLine(flat, max)}…` : flat;
}

/**
 * The cap for a config dir quoted in a line of this module: a path is the one value whose END
 * is the part a reader needs (the account's own directory name), so it gets room to be whole.
 */
const DIR_VALUE_MAX_CHARS = 400;

/**
 * PROCESS-BOUNDARY stop mark (F3c).
 *
 * The pool lives in the MCP server process, so the extension host — which cancels a mesh
 * dispatch from its UI by running `claude stop` itself — has no pool instance to call.
 * Before this helper existed, that path stopped the session and left the ledger untouched —
 * the record kept saying the worker was live, so mesh_status advertised a dead session and
 * the cap counted a slot nobody could free. One ledger write closes both.
 *
 * A name we do not hold, or a record ALREADY carrying stoppedAt, is refused with the live
 * worker names rather than silently succeeding — the caller is about to tell a user what it
 * did. The one asymmetry is deliberate: when another writer stamps the record between our
 * read and our write, we report SUCCESS, because the caller's intent (this record is stopped)
 * is exactly the state on disk. A benign race must not surface as a failed cancel.
 *
 * `jobId` IS THE ADDRESS; `name` ALONE IS NOT ONE. Worker names are reused across generations
 * (`cco-w-<hash>-<account>-<n>` recurs as soon as the earlier holder is stopped), so a ledger
 * routinely holds several records under one name, and a lookup by name returns whichever comes
 * FIRST in the file — usually the oldest. Addressed that way, a cancel of the running
 * generation either stamped an earlier namesake or, when that namesake was already stopped,
 * was refused as "already stopped" while the record of the session that had just been killed
 * stayed live: counted against the in-flight cap and re-stopped by every later sweep. A job id
 * is minted once per spawn and never recurs (MeshWorkerRecord.jobId), so with it given the
 * record carrying THAT job id is the one marked, and `name` is demoted to a cross-check: a
 * job id held under a different name marks nothing, exactly as a job id nobody holds marks
 * nothing. Both are refusals rather than fallbacks to the name — a caller that supplied an
 * identity and was wrong about it must not have a different record stamped on its behalf.
 *
 * Without `jobId` the lookup is the name-only one above, unchanged, so a caller that has not
 * been handed the id yet keeps the behaviour it had. New callers pass it.
 */
export function markWorkerStopped(
  cwd: string,
  name: string,
  jobId?: string,
): { ok: boolean; error?: string } {
  let records: MeshWorkerRecord[];
  // An unreadable ledger is NOT an empty one, and this function's refusal is quoted to a user
  // who just cancelled something: "no attachable worker named X" would be a claim we cannot
  // make about a file we could not open.
  const note: LedgerReadNote = {};
  try {
    records = readMeshWorkerRecords(cwd, note);
  } catch {
    records = [];
  }
  if (note.unreadable !== undefined) {
    return {
      ok: false,
      error: meshError(
        'capability_failed',
        `this workspace's mesh ledger could not be READ (${note.unreadable}), so the stop could ` +
          `not be recorded and whether a worker named "${name}" exists is unknown.`,
      ),
    };
  }
  let record: MeshWorkerRecord | undefined;
  if (jobId !== undefined) {
    // "Given" is `!== undefined`, never truthiness: an empty or non-string job id is a caller
    // that TRIED to name a record and named none, and reading it as "not given" would send
    // that call down the name-only lookup this parameter exists to replace.
    if (typeof jobId !== 'string' || jobId === '') {
      // The declared type promises a string; a caller compiled against nothing (the extension
      // host passes whatever a ledger record held) can still hand in anything.
      const given: unknown = jobId;
      const shape = given === '' ? 'an empty string' : given === null ? 'null' : `of type ${typeof given}`;
      return {
        ok: false,
        error: meshError(
          'invalid_input',
          `the job id given for worker "${stopMarkValue(name)}" is not a job id (it is ` +
            `${shape}), so it identifies no record and nothing was marked stopped.`,
        ),
      };
    }
    const holders = records.filter((r) => r.jobId === jobId);
    if (holders.length === 0) {
      return {
        ok: false,
        error: meshError(
          'unknown_worker',
          `no worker with job id "${stopMarkValue(jobId)}" in this workspace, so nothing was ` +
            `marked stopped.`,
        ),
      };
    }
    // An unstopped holder is preferred over a stopped one. Two records agreeing on BOTH fields
    // are a duplicated row of one session (recordKey), and markStopped stamps every unstopped
    // one of them — so opening on a stopped duplicate would refuse the mark the other needs.
    record =
      holders.find((r) => r.name === name && r.stoppedAt === undefined) ??
      holders.find((r) => r.name === name);
    if (!record) {
      return {
        ok: false,
        error: meshError(
          'unknown_worker',
          `job id "${stopMarkValue(jobId)}" belongs to worker "${stopMarkValue(holders[0].name)}", ` +
            `not to "${stopMarkValue(name)}", so nothing was marked stopped.`,
        ),
      };
    }
  } else {
    record = records.find((r) => r.name === name);
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
    // there first, which is the state we wanted anyway. The RECORD is handed in rather than
    // the name, so a namesake generation in the same ledger is not stamped along with it.
    const skips: string[] = [];
    markStopped(cwd, [record], undefined, skips);
    if (skips.length > 0) {
      // The write was skipped, not merely raced: reporting success here would tell the caller
      // the ledger says stopped when it still says live.
      return { ok: false, error: `could not update the mesh ledger — ${skips.join(' ')}` };
    }
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
 *
 * AGE ALONE IS NO LONGER THE WHOLE GATE, and the reason is the channel of record. That argument
 * covers a task that is still LIVE; it says nothing about a task that is still UNSETTLED, which
 * is a different set entirely — a dispatch whose session was killed leaves its task at 'running'
 * with nobody to settle it, and its `result.json` is exactly what `meshTaskRecovery` now reads
 * to recover the report. Sweeping that file on age alone destroys the deliverable this release
 * exists to recover, permanently and silently (the same defect class as pruning a ledger record
 * that still joins an unsettled task — see joinsUnsettledTask). So an artifact directory whose
 * task is still 'running' is kept regardless of age.
 *
 * AND THE SAME CONSTANT IS THE POST-SETTLE GRACE, measured from the terminal event rather than
 * from the artifacts' own mtimes (protectedIoTaskId). One number, two clocks, deliberately: the
 * refusal notes this module writes at settle time tell a human to read the file "before the 24h
 * artifact sweep removes it", and that sentence is only true if the 24 hours start when the note
 * is written. Started at the worker's last write instead, it had routinely already expired.
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
      // lstat: an entry is dated by itself. A link a worker left in its io directory must not
      // lend the directory the age of whatever it points at.
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    } catch {
      // vanished mid-sweep or unreadable — the other entries still date the directory
    }
  }
  return newest;
}

/**
 * Whether an io artifact named for this task id must SURVIVE the age sweep: its task is still
 * open, or it settled recently enough that the artifacts are still the evidence a reader was
 * pointed at (see IO_ARTIFACT_MAX_AGE_MS).
 *
 * THE PROMISE THIS KEEPS, and it did not keep it before. Half the refusal notes in this module
 * end with some form of "read that file directly before the 24h artifact sweep removes it" —
 * and those notes are written AT THE SETTLE, while protection used to end at exactly that
 * instant and the 24h clock ran on the artifacts' OWN mtimes, which started when the worker last
 * wrote. Reproduced: io directories aged 30h whose tasks had just settled were removed by the
 * very next sweep — including a torn-write case a human was told to go and read, and one where
 * the worker wrote a valid report AFTER a deadline-only settle. The note pointed at a file that
 * was already gone, or would be minutes later.
 *
 * So the clock now starts at the SETTLE, not at the worker's last write: a settled task's
 * artifacts live for IO_ARTIFACT_MAX_AGE_MS past the terminal event, which is the window the
 * notes actually promise. The litter is still collected — this shifts the deadline, it does not
 * remove it — and a task with no event at all (a cleared log) is unaffected, falling back to the
 * age rule alone.
 *
 * `undefined` from the index — the task log could not be read at all — protects everything: it
 * is the difference between "no task is running" and "we could not find out", and only the first
 * may license deleting somebody's unrecovered report. The cost is bounded and self-healing: the
 * litter waits for a sweep that can read the log.
 *
 * THAT BRANCH IS ONLY NOW REAL. It was written against `readTaskEvents()`, which swallows every
 * read error and returns `[]` — so an unreadable log produced an EMPTY index ("no task is
 * running"), never `undefined`, and this guard could not fire however hard the filesystem
 * failed. Deleting the io directory of a RUNNING task whose worker had already written a valid
 * result.json was therefore one EMFILE away, on a sweep that runs at activation and every 60
 * seconds. See taskStateIndex for the fix and for the reproduction.
 */
function protectedIoTaskId(taskId: string, now: number): boolean {
  if (taskId === '') {
    return false; // names no task, so no task's outcome depends on it
  }
  const index = taskStateIndex();
  if (index === undefined) {
    return true; // could not find out — never delete on a guess
  }
  if (index.running.has(taskId)) {
    return true; // unsettled: these artifacts are still the answer's only home, at any age
  }
  const settledAt = index.settledAt.get(taskId);
  if (settledAt === undefined) {
    return false; // no datable settle (or no event at all) — the age rule decides, as before
  }
  const sinceSettle = now - settledAt;
  // ABSOLUTE value, so a settle stamped in the FUTURE (a clock step, a hand-edited log) buys a
  // bounded grace instead of an eternal one: `now - settledAt` would stay negative forever and
  // pin the directory on disk for the life of the machine.
  return Number.isFinite(sinceSettle) && Math.abs(sinceSettle) <= IO_ARTIFACT_MAX_AGE_MS;
}

/**
 * Remove stale dispatch io artifacts and report how many were removed (F5b).
 *
 * The io channel lives OUTSIDE every checkout (A10), so nothing in the workspace ever
 * collects it: the settle path unlinks a task's directory on every normal outcome, and this
 * sweep is the backstop for the abnormal ones — a crashed server, a SIGKILLed worker, a
 * machine that went down mid-dispatch. It used to live inside the MCP server, which meant
 * litter was only ever collected while a mesh server was running; it lives here so BOTH the
 * server's periodic sweep and extension activation can call it (a workspace whose mesh mode was
 * turned off still gets cleaned).
 *
 * With `cwd` given only that workspace's io root is swept; omitted, every workspace's is —
 * the roots are hash-named, so the parent directory is enumerated directly rather than
 * derived from a list of workspaces we would have to know about. A whole task subdirectory
 * goes at once (the unit of ownership is the task, and half a task's artifacts are worse
 * than none) — unless that task is still UNSETTLED, in which case nothing of it is touched at
 * any age, or settled within the last IO_ARTIFACT_MAX_AGE_MS, in which case it is kept for the
 * human its settle note pointed at it (protectedIoTaskId).
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
          if (protectedIoTaskId(entry.name, now)) {
            continue; // unsettled, or inside its post-settle grace — see protectedIoTaskId
          }
          // recursive+force: the directory holds at most a task file and a result file, and
          // `force` makes a race with a concurrent settle-time unlink a no-op instead of a throw.
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          continue;
        }
        const legacy = LEGACY_FLAT_IO_SUFFIXES.find((suffix) => entry.name.endsWith(suffix));
        if (legacy === undefined) {
          continue; // not ours: never "delete everything old" in a directory
        }
        if (protectedIoTaskId(entry.name.slice(0, entry.name.length - legacy.length), now)) {
          continue; // same protection, for a task whose artifacts predate the per-task layout
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
