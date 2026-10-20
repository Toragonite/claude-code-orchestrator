import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import {
  DispatchSpawnOpts,
  ENTRY_APPEAR_GRACE_MS,
  IWorkerPool,
  MESH_WORKER_SEQ_MAX,
  MeshWorkerRecord,
  MeshWorkerStatus,
  WorkerSessionStatus,
  WorkerSpawnResult,
  MESH_STATE_DIR,
  applyProjectMcpTrust,
  bgIoTaskDir,
  bgWorktreeBranch,
  bgWorktreeName,
  bgWorktreePath,
  ensureBgIoTaskDir,
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
import { flattenOneLine, sliceOneLine } from '../displayText';
import {
  SESSION_WORKER_SETTINGS_JSON,
  WORKSPACE_NOT_TRUSTED_MARKER,
  WORKTREE_KEPT_MARKERS,
  accountConfigFile,
  claudeEnv,
  claudeShellPrefix,
  normalizePermissionMode,
  sameConfigDir,
} from '../platform';
import { readTextSafe, type SafeReadFailure } from '../safeFs';
import {
  claudeWorkers,
  isPidAlive,
  processRunsCli,
  processStartedAt,
  readRegistry,
  withPathLock,
  type Registry,
} from '../registry';
import { exhaustedWindows, readUsageCache } from '../usage';

/**
 * mesh/pool — the `claude --bg` worker lifecycle for one workspace, plus the OWNERSHIP
 * LEDGER every teardown path reads. Implements the frozen IWorkerPool contract in
 * contract.ts. The pool OWNS only the `workers` array of the mesh state file; every
 * other field belongs to the server, so every mutation is a read-modify-write of
 * the WHOLE object that touches nothing but `workers` (contract MeshState).
 *
 * The mirror-image writer lives here too (mutateMeshOwnerFields): the SERVER's fields
 * (ownerPid, cwd, startedAt) are edited by a helper that cannot reach
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
 * WHAT THIS MODULE NO LONGER DOES (v2.0). There is no keep-alive mark and no activity
 * clock: the idle sweep they fed is gone, so a worker lives until it is stopped, its
 * session ends, or Claude Code retires it. And a worker's NAME is no longer evidence of
 * anything about its session — every liveness question in here is answered by JOB ID
 * (see the session-status section).
 *
 * vscode-free, node18 stdlib only; imports restricted to ./contract, ../platform,
 * ../registry, ../usage, the two leaf helpers (../safeFs, ../displayText) and node builtins.
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

/** Chars of captured output attached to a spawn/stop failure so the caller can see why. */
const OUTPUT_TAIL_CHARS = 600;

/**
 * Combined stdout+stderr one child may hand back through runMeshProcess. Every command
 * run through it prints a line or a small JSON listing; 1 MiB is far past any of them, and
 * the cap exists because the bytes are buffered in THIS process — a `claude` stand-in on
 * PATH (or a CLI gone wrong) that prints without end would otherwise grow the MCP server
 * or the extension host until it died. Excess is DISCARDED (the pipes keep draining, so
 * the child never blocks on a full one) and the outcome says so with `truncated: true`.
 */
export const MESH_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * How long after a child's 'exit' its pipes may keep delivering before runMeshProcess
 * settles without them. The exit code is already known at that point; this window only
 * lets output the kernel still holds reach us. It is short because the case it bounds is
 * a pipe that will NOT close — one inherited by a process that outlives the child.
 */
const EXIT_DRAIN_MS = 250;

/**
 * How long after the timeout's SIGKILL an 'exit' is still awaited. SIGKILL cannot be
 * caught, so the event normally follows within milliseconds; this backstop covers a kill
 * that failed outright (EPERM on a pid we do not own any more), so that a timeout can
 * never turn into a promise that does not settle.
 */
const POST_KILL_SETTLE_MS = 2_000;

/**
 * How long a record with no recorded deadline keeps counting as a dispatch in flight
 * (inFlightCount). Eight hours is the longest dispatch timeout the registry allows
 * (TIMEOUT_MINUTES_MAX), so no dispatch that is genuinely still running can be older.
 */
const FALLBACK_INFLIGHT_MS = 8 * 60 * 60 * 1000;

/**
 * How long past its deadline a dispatch still counts as in flight: the dispatcher's own
 * timeout path (stop the worker, last reads, settle) runs AFTER the deadline, and the slot
 * is not free until that path has recorded the outcome. Matches the reaper's grace for a
 * live dispatcher (DISPATCHER_SETTLE_GRACE_MS).
 */
const INFLIGHT_DEADLINE_GRACE_MS = 5 * 60 * 1000;

/** Chars of a session entry's `waitingFor` kept when it is reported (WorkerSessionStatus). */
const WAITING_FOR_MAX_CHARS = 80;

/**
 * The pauses before the further attempts of a ledger write that a LATER DECISION DEPENDS ON —
 * the spawn record, a stop mark, a settle mark — when the write was skipped (see
 * mutateMeshWorkers for the three ways that happens; the one this exists for is the write lock
 * staying held by a live process for registry.ts's whole 15 s wait).
 *
 * WHY RETRY AT ALL, when the lock already waited 15 s: because that wait is measured on the
 * wall clock, and the wall clock can jump. A machine that sleeps while one process holds the
 * lock and another waits for it wakes both at once — the holder a few milliseconds from done,
 * the waiter already "15 s" late and giving up on its next look. The same goes for a clock
 * stepped forward. A second attempt half a second later finds that lock gone.
 *
 * ONE further attempt, and the reason it is not more: each attempt parks this process's only
 * thread for up to that same 15 s, and the MCP server answers nothing while it is parked. A
 * holder that is still there after two waits is stuck rather than slow, and what happens then
 * is each caller's own decision — the spawn is undone and fails with the lock's own message,
 * the stop and the settle say what they could not record (writeDurably's callers).
 */
const LEDGER_WRITE_RETRY_PAUSES_MS: readonly number[] = [500];

/**
 * How long a STOPPED worker record is kept before every ledger write drops it (F5a).
 *
 * Seven days, because the record's only remaining readers after a stop are humans and the
 * status surfaces: mesh_status lists a stopped worker's surviving (dirty) worktree so
 * unmerged work is never silently lost, and a week is long enough to cover a weekend plus a
 * few working days before someone comes back to it. Every spawn appends a record, so
 * without a bound the ledger grows without limit for the lifetime of a workspace.
 *
 * The pruning rule is deliberately one-sided: ONLY records that carry a finite stoppedAt
 * older than this are dropped. A record with no stoppedAt names a worker that may still be
 * alive, and dropping it would erase the only thing that can ever find, stop or reap that
 * session — the exact leak the ownership ledger exists to prevent.
 */
const LEDGER_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * READ CAP for one workspace's state file (safeFs.readTextSafe).
 *
 * The ledger is a JSON array of worker records under a handful of scalar owner fields. A
 * pretty-printed record — name, account, an absolute configDir, jobId, model, role and its
 * timestamps — runs 400-700 bytes, the LIVE population is capped at
 * `meshMaxLiveWorkers` (max 64) and F5a drops a stopped record after seven days, so the
 * ceiling on a legitimate file is roughly one week of spawn churn: the largest observed real
 * ledger on this machine is under 10 KB, and 4 MiB is ~6,000 records — an order of magnitude
 * past the busiest plausible week. Past that the file is REFUSED rather than parsed, which
 * matters more here than anywhere else in this module: a state file nothing can read is a
 * state file nothing may REWRITE (see readMeshStateFile), because the records we cannot see
 * are the ones that name live sessions.
 */
export const MESH_STATE_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * READ CAP for one session-registry entry (`<configDir>/sessions/<id>.json`).
 *
 * Written by Claude Code itself and holding a name, a session id, a pid, a cwd and a few
 * flags — a few hundred bytes in practice. This cap is deliberately small because the cap is
 * paid PER FILE over a whole directory scan: 64 KiB is ~100x any real entry and still bounds a
 * hostile sessions dir to something a synchronous sweep can survive.
 */
export const SESSION_ENTRY_MAX_BYTES = 64 * 1024;

/**
 * HOW a session-registry entry is read: without following a symbolic link at its name.
 *
 * The CLI writes `sessions/<pid>.json` as a regular file, and liveness verdicts and forced stops
 * hang on what such a file says — a job id, a pid, a status. A link at that name would make
 * those the contents of some other file. It reads as `not-a-file`, which every reader here
 * already treats as "an entry that EXISTS and could not be read": the scan is incomplete, and
 * nothing is concluded from the entry's absence.
 */
const SESSION_ENTRY_READ = { noFollow: true } as const;

/**
 * READ CAP for an account's `<configDir>/.claude.json`, matched to usage.ts's cap on the same
 * file: real ones carry project history and reach a few MB legitimately, so 8 MiB clears any
 * genuine file with room to spare and refuses a hand-grown one. Read inside the prepareAccount
 * lock on the SPAWN path, which is exactly why it may not block.
 */
const ACCOUNT_CONFIG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * READ CAP for the workspace's `.mcp.json` — a hand-written server list, kilobytes at most.
 */
const PROJECT_MCP_FILE_MAX_BYTES = 1024 * 1024;

/**
 * How many directory entries ONE scan will look at (listDirCapped).
 *
 * A directory a worker can write to is unbounded work on a synchronous path: a sweep that
 * calls `readdirSync` on it materializes every name at once (millions of strings on the
 * extension host's main thread) and then opens one file per name. Both halves are bounded
 * here — the listing is streamed through `opendirSync`/`readSync` so nothing bigger than the
 * cap is ever allocated, and the scan STOPS at the cap and SAYS it stopped, because a
 * silently short listing of a session registry is indistinguishable from "that worker is
 * gone" and that mistake marks a live worker stopped. 25,000 is far past any real sessions
 * dir (one file per Claude Code session) or the mesh state dir (one file per workspace).
 */
export const DIR_SCAN_MAX_ENTRIES = 25_000;

/**
 * A bounded, streaming directory listing that never throws.
 *
 * `ok:false` splits the two failures a caller must not confuse: `absent` (ENOENT/ENOTDIR — the
 * directory is not there, which is an honest empty) versus everything else (a permission
 * error, an io error — the directory IS there and we could not see it). Collapsing those is
 * how "unreadable" becomes "empty", which is the bug class this pass exists to remove.
 * `truncated` says the listing hit the cap or was cut short: the names returned are real, but
 * ABSENCE from them proves nothing.
 */
export type DirScan =
  | { ok: true; names: string[]; truncated: boolean }
  | { ok: false; absent: boolean; detail: string };

export function listDirCapped(dir: string, cap: number = DIR_SCAN_MAX_ENTRIES): DirScan {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      absent: code === 'ENOENT' || code === 'ENOTDIR',
      detail: code ?? (err as Error).message,
    };
  }
  const names: string[] = [];
  let truncated = false;
  try {
    for (;;) {
      let ent;
      try {
        ent = handle.readSync();
      } catch {
        // The listing died part way through: what we have is real, what is missing is unknown.
        truncated = true;
        break;
      }
      if (!ent) {
        break;
      }
      if (names.length >= cap) {
        truncated = true;
        break;
      }
      names.push(ent.name);
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // already closed
    }
  }
  return { ok: true, names, truncated };
}

/**
 * A CLAUDE CODE account of this installation: a registry worker whose provider is Claude
 * Code, or the implicit 'main' account. Placement does not happen in this module, so an
 * account here is just an identity — and the list of them (claudeAccounts) is the set of
 * directories anything in the mesh will treat as a Claude config dir at all: scan for names
 * and live entries, start a session under, aim a `claude` command at.
 */
export interface ClaudeAccount {
  name: string;
  configDir: string;
}

/**
 * The Claude Code accounts of this installation: every registry worker whose provider is
 * Claude Code (registry.claudeWorkers — the one definition of that), in registry order, then
 * 'main' — `hostDir`, the config dir the orchestrator session itself runs under.
 *
 * THE SOURCE of everything in the pool that treats a directory as a Claude config dir, and
 * nothing builds a second one: the worker-name sequence scan and adopt() read these
 * accounts' `sessions/`, and the account check (claudeAccountDirCheck) — which decides
 * whether a spawn may run under a dir and whether a LEDGER RECORD's dir may be scanned or
 * handed to `claude stop` / `claude rm` — is membership in it. A worker on another vendor's
 * CLI is therefore not filtered out use by use; it was never in the list. Its `configDir` is
 * THAT vendor's home: it has a `sessions/` of its own with another meaning, and a `claude`
 * process pointed at it creates Claude config files inside it.
 *
 * Exported for the one caller outside the pool that tears down, from a process with no pool
 * instance in reach, a record the pool of THAT process did not start (reaper.
 * fireAndForgetStopOwned — what the process did start it stops on spawnVettedConfigDir alone).
 */
export function claudeAccounts(registry: Registry, hostDir: string): ClaudeAccount[] {
  const list: ClaudeAccount[] = claudeWorkers(registry).map((w) => ({
    name: w.name,
    configDir: w.configDir,
  }));
  list.push({ name: 'main', configDir: hostDir });
  return list;
}

/** Is this config dir one of a list of Claude Code accounts? Never throws. */
export type ClaudeAccountCheck = (configDir: unknown) => boolean;

/**
 * Membership in a list of accounts, by DIRECTORY: the same lexical comparison
 * platform.sameConfigDir makes (no filesystem access), so `/a/b` and `/a/b/` are one account
 * and a symlinked alias is — deliberately — not. Total: a value that is not a non-empty
 * string, or one that cannot be resolved, is simply not an account.
 *
 * WHAT IT IS FOR. A ledger record's `configDir` was a Claude Code account's dir when the
 * record was written and is plain DATA afterwards: the account may have been removed, the
 * file edited, or the directory may now belong to a worker on another vendor's CLI. None of
 * those is repaired or guessed at. A record that fails this check is reported as one that
 * could not be checked, and nothing is read from or run against its dir.
 */
export function claudeAccountDirCheck(accounts: readonly ClaudeAccount[]): ClaudeAccountCheck {
  const dirs = new Set<string>();
  for (const account of accounts) {
    try {
      if (typeof account.configDir === 'string' && account.configDir !== '') {
        dirs.add(path.resolve(account.configDir));
      }
    } catch {
      // path.resolve consults the cwd for a relative value and throws once that directory is
      // gone; one fewer account, never a wider set
    }
  }
  return (configDir) => {
    if (typeof configDir !== 'string' || configDir === '') {
      return false;
    }
    try {
      return dirs.has(path.resolve(configDir));
    } catch {
      return false;
    }
  };
}

/**
 * The config dirs THIS PROCESS has started a session worker under: each passed the spawn gate
 * (spawnDispatchWorker) — it was a Claude Code account of this installation at that moment —
 * and `claude --bg` was then run against it. Resolved paths, in memory only, only ever added
 * to, and gone with the process.
 *
 * WHY IT IS KEPT. Whether a LEDGER RECORD's dir may have anything Claude-specific aimed at it
 * is otherwise asked of the registry as it reads at that later moment (claudeAccountDirCheck),
 * and for a record this process wrote itself that is the wrong question twice over. The
 * registry can change under a running dispatch — the account is removed, or the file is
 * unreadable for a while, which reads as "no workers at all" — and on the registry's answer
 * alone each of those turns the worker this process started into one it will neither look at
 * nor stop: not when its dispatch times out, not when asked to, and not at session end, which
 * is the one moment nothing else gets. The reason for the question does not apply either: it
 * exists because a `claude` command creates its config files in whatever dir it is pointed
 * at, and this process has already run one against that dir, on the registry's own word.
 *
 * So for the life of the process a dir in this set stays one this process may read the session
 * registry of and aim `claude stop` / `claude rm` at — for a record whose dir it is. It never
 * widens what a NEW session may be started under: the spawn gate asks the registry as it
 * stands, every time.
 */
const spawnVettedDirs = new Set<string>();

/** Record that the spawn gate passed `configDir` in this process. Never throws. */
function rememberSpawnVettedDir(configDir: string): void {
  try {
    spawnVettedDirs.add(path.resolve(configDir));
  } catch {
    // unresolvable now (the cwd is gone): the dir is simply not remembered, and a record
    // naming it is asked of the registry like any other
  }
}

/**
 * Did the spawn gate of THIS process pass this dir (spawnVettedDirs)? Total: anything that is
 * not a non-empty string, or cannot be resolved, was not.
 *
 * Exported for the session-end stop (reaper.fireAndForgetStopOwned), which runs with no pool
 * instance in reach and must not ask the registry about what this process started.
 */
export function spawnVettedConfigDir(configDir: unknown): boolean {
  if (typeof configDir !== 'string' || configDir === '') {
    return false;
  }
  try {
    return spawnVettedDirs.has(path.resolve(configDir));
  } catch {
    return false;
  }
}

/** Test seam: forget what this process has spawned under (a fresh process starts with none). */
export function resetSpawnVettedConfigDirs(): void {
  spawnVettedDirs.clear();
}

export interface ProcOutcome {
  code: number | null;
  /** stdout and stderr, interleaved as they arrived, capped at MESH_PROCESS_OUTPUT_MAX_BYTES. */
  output: string;
  timedOut: boolean;
  spawnError: boolean;
  /** True when the child printed more than the cap and the excess was discarded. */
  truncated: boolean;
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
 * POSIX single-quoting for a value inside a command a HUMAN pastes into a shell (attach and
 * stop hints). Nothing in this codebase executes the result — every spawn is an argv array.
 * Exported so the reaper prints its hints with the same quoting.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A value as ONE shell word: bare when it is a plain token (a job id is), quoted otherwise. */
export function shellToken(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * A copy-pasteable `claude <args>` for the account in `configDir`, with the environment
 * prefix platform.claudeShellPrefix decides (which is NOT always `CLAUDE_CONFIG_DIR=…`: for
 * the default account the variable must be absent). `args` is appended as given — callers
 * pass a subcommand and a job id, never free text.
 */
export function claudeCommandFor(configDir: string, args: string): string {
  return `${claudeShellPrefix(configDir, shellQuote)}claude ${args}`;
}

/**
 * Run a child process to completion, collecting stdout+stderr into one buffer.
 * Never rejects: a synchronous spawn throw, an async 'error', a non-zero exit and a
 * timeout all resolve a ProcOutcome the caller classifies. No shell — argv only.
 *
 * SETTLES ON 'exit', NEVER ON 'close'. 'close' waits for every holder of the child's
 * stdio pipes to let go, and a `claude` invocation that starts the CLI's background
 * service hands those pipes to a process that outlives it — so a wrapper waiting for
 * 'close' can wait forever on a command that finished in a second. The exit code is the
 * answer; after it arrives the pipes get EXIT_DRAIN_MS to deliver what is already in
 * flight, and are then DESTROYED so they pin neither this promise nor the event loop.
 * (Closing our read end early costs the survivor nothing it was not going to lose anyway:
 * this process is itself shorter-lived than a background service.)
 *
 * On timeout the child is SIGKILLed and we settle from the resulting 'exit' — or, if that
 * never comes, after POST_KILL_SETTLE_MS, flagged `timedOut` either way.
 *
 * Output is capped at MESH_PROCESS_OUTPUT_MAX_BYTES (see there); past the cap the pipes
 * are still read, just not kept.
 *
 * Exported for the reaper and the server, which run `claude` subcommands and must
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
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killBackstop: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    // One decoder PER STREAM: a multi-byte character split across two chunks of one pipe
    // must be reassembled from that pipe's bytes, not from whatever the other pipe delivered
    // in between.
    const collector = (): ((chunk: unknown) => void) => {
      const decoder = new StringDecoder('utf8');
      return (chunk) => {
        if (settled) {
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const room = MESH_PROCESS_OUTPUT_MAX_BYTES - bytes;
        if (buf.length > room) {
          truncated = true;
        }
        if (room <= 0) {
          return; // over the cap: keep draining the pipe, keep nothing
        }
        const kept = buf.length > room ? buf.subarray(0, room) : buf;
        bytes += kept.length;
        output += decoder.write(kept);
      };
    };
    const done = (o: Omit<ProcOutcome, 'truncated'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const t of [timer, drainTimer, killBackstop]) {
        if (t !== undefined) {
          clearTimeout(t);
        }
      }
      // Destroyed AFTER the answer is fixed: nothing read from here on is kept, and an open
      // pipe handle would otherwise hold this process's event loop for as long as some
      // grandchild holds the other end.
      for (const stream of [child?.stdout, child?.stderr, child?.stdin]) {
        try {
          stream?.destroy();
        } catch {
          // already destroyed
        }
      }
      resolve({ ...o, truncated });
    };
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (e) {
      done({ code: null, output: `spawn threw: ${(e as Error).message}`, timedOut: false, spawnError: true });
      return;
    }
    const proc = child;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone — 'exit' (or the backstop below) still settles us
      }
      killBackstop = setTimeout(
        () => done({ code: null, output, timedOut: true, spawnError: false }),
        POST_KILL_SETTLE_MS,
      );
    }, timeoutMs);
    proc.stdout?.on('data', collector());
    proc.stderr?.on('data', collector());
    // A pipe error (EPIPE on stdin, a read error) with no listener would be an uncaught
    // exception in the host process; none of them changes the outcome, which is the exit code.
    for (const stream of [proc.stdout, proc.stderr, proc.stdin]) {
      stream?.on('error', () => undefined);
    }
    proc.on('error', (e) =>
      done({ code: null, output: `${output}\nspawn error: ${e.message}`, timedOut, spawnError: true }),
    );
    let exited = false;
    let exitCode: number | null = null;
    const finish = (): void => done({ code: exitCode, output, timedOut, spawnError: false });
    proc.on('exit', (code) => {
      exited = true;
      exitCode = code;
      drainTimer = setTimeout(finish, EXIT_DRAIN_MS);
    });
    // The ordinary case: every pipe closed with the process, so there is nothing to wait
    // for. 'close' is only ever a way to settle EARLY — it is never required.
    proc.on('close', (code) => {
      if (!exited) {
        exitCode = code;
      }
      finish();
    });
  });
}

/** What `claude rm <jobId>` did to a worker's background job and its worktree (A11). */
export interface JobRemoval {
  /** The job was removed; any worktree it owned was clean and is gone, branch included. */
  removed: boolean;
  /**
   * The platform KEPT the worktree because it holds uncommitted changes or unpushed
   * commits. This is a SUCCESS path for us, not a failure — and for a worker whose work
   * was auto-committed at settle it is the CORRECT FINAL STATE: the worktree is what holds
   * the result branch until the orchestrator merges it.
   */
  kept: boolean;
  /** Neither happened — the removal could not be carried out at all (best-effort teardown). */
  error?: string;
}

/**
 * Finish a teardown with `claude rm <jobId>` under the worker's OWN account (A11).
 *
 * Run AFTER the stop, never instead of it, never retried and never with a flag: a plain
 * `claude rm` does not discard work — it removes a worktree only when that loses nothing,
 * and otherwise exits non-zero saying `kept <id> — its worktree is still at …`. Discarding
 * needs an explicit `--discard-unpushed <commit>@<worktree-id>`, which this codebase never
 * passes. We also never touch a worktree by path — `git worktree remove` from here would
 * bypass exactly that protection.
 *
 * So `kept` is not a failure to work around: a worktree holding uncommitted edits, or the
 * commit the dispatch made at settle, is somebody's unmerged result, and leaving it in
 * place IS the teardown's correct outcome. A worktree that is removed is one that produced
 * nothing or has already been merged.
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
    claudeEnv(opts.configDir),
    MESH_RM_TIMEOUT_MS,
  );
  if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
    return { removed: true, kept: false };
  }
  // A kept worktree exits NON-ZERO and says so. Classified loosely (any of
  // platform.WORKTREE_KEPT_MARKERS, not all of them) because this is the common teardown
  // outcome — nearly every worker leaves work behind — and a wording drift that pushed it
  // into the error branch would mislabel the normal case. The cost of a false "kept" is a
  // status line pointing at a worktree that is already gone; the cost of a false "error" is
  // a lost warning.
  if (!outcome.timedOut && !outcome.spawnError && isWorktreeKeptOutput(outcome.output)) {
    return { removed: false, kept: true };
  }
  return {
    removed: false,
    kept: false,
    error: `claude rm ${opts.jobId} ${describeProcFailure(outcome)}: ${tail(outcome.output)}`,
  };
}

/**
 * Does this `claude rm` output say the worktree was kept rather than removed? Matched
 * case-insensitively on the combined output, and only as a classifier — the text is never
 * parsed for a path, and we never remove a worktree ourselves.
 */
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

/* ------------------------------------------------------------------------- *
 * Process identity — the check in front of every signal sent to a pid we did
 * not start
 * ------------------------------------------------------------------------- *
 * The pids this module and the reaper may have to SIGKILL do not come from a process handle:
 * they come out of a session-registry entry (`<configDir>/sessions/<pid>.json`). An entry is
 * found by the worker's JOB ID, which proves the FILE is that worker's — and says nothing about
 * the process that holds the pid today. A session that is killed leaves its entry behind, the
 * OS hands the number to whatever starts next, and `kill(pid, 0)` answers "alive" for that
 * stranger exactly as it would for the worker. So a job-id match plus a live pid is where to
 * look, never what to kill.
 *
 * The rule, for every signal to such a pid (entryPidIsWorker), has TWO anchors, both asked AT
 * THAT INSTANT and in the same synchronous turn as the signal, with nothing awaited between the
 * check and the kill:
 *   1. WHAT it is running: the Claude Code CLI (registry.processRunsCli reads its command
 *      line). A stranger that is not the CLI stops here.
 *   2. WHEN it started: no later than the entry says its session did (registry.
 *      processStartedAt, against the entry's `startedAt`, with ENTRY_START_SLACK_MS between
 *      them). A pid that changed hands belongs to a process that started AFTER the entry was
 *      written; the worker cannot have. This is what stops the stranger that IS a `claude` —
 *      another session of the same user that happened to be given the pid.
 * A pid that fails either — or whose start time could not be read when the entry gives one to
 * compare — is not signalled, and the caller says so (unconfirmedPidRefusal). An entry that
 * states no usable `startedAt` leaves the first anchor to decide alone, as it did before the
 * second existed. The one pid exempt from all of it is a child this process spawned and still
 * holds the ChildProcess for (runMeshProcess): the handle is the proof.
 *
 * WHAT REMAINS, stated: an entry without a usable `startedAt` whose pid went to another Claude
 * Code session; and a process that both runs the CLI and started within the slack of the dead
 * worker's entry. Each needs the worker to have been killed with its entry left behind,
 * `claude stop` to have failed and a forced stop to be asked for, on top of the coincidence.
 * ------------------------------------------------------------------------- */

/**
 * The command names a session worker's process can be running under: the basename of the
 * configured `claudePath` (without a Windows `.exe` / `.cmd` suffix), then `claude`.
 *
 * Both, because they answer for different installations: the configured path is usually a
 * launcher or a link called `claude`, and then there is one name; when it is something else (a
 * wrapper script, a versioned binary) the session it starts may run under either. The
 * configured name is first because each name asked costs one `ps`, and it is the likelier one.
 */
export function workerCliNames(claudePath: string): string[] {
  const names: string[] = [];
  const base =
    typeof claudePath === 'string'
      ? (claudePath.trim().split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd)$/i, '')
      : '';
  if (base !== '') {
    names.push(base);
  }
  if (!names.includes('claude')) {
    names.push('claude');
  }
  return names;
}

/**
 * Is the process holding `pid` running the Claude Code CLI right now? THE gate in front of a
 * signal (see the section note): SYNCHRONOUS, so a caller can check and signal in one turn.
 *
 * Only a positive answer counts. processRunsCli's `false` (a command line was read and names
 * something else) and its `undefined` (it could not be read: win32, a failed `ps`, a pid that
 * is not one) are the same thing to a caller about to signal — nothing proves this is the
 * worker — and both answer false here.
 */
export function pidRunsWorkerCli(pid: number, claudePath: string): boolean {
  return workerCliNames(claudePath).some((name) => processRunsCli(pid, name) === true);
}

/**
 * How much later than its entry's `startedAt` a worker's process may appear to have started.
 *
 * Not zero, for three reasons that add up: the entry's stamp may be taken by whatever launches
 * the session, a moment BEFORE the session's process exists (the stand-in CLI of this
 * repository's harness does exactly that); processStartedAt can read up to a second late (`ps`
 * reports elapsed time in whole seconds); and a machine under load starts a process slowly.
 * Five seconds covers all three with room. What it lets through is a pid that died and was
 * handed on within five seconds of its session's start — a worker that lived that long and
 * whose number was reused at once.
 */
const ENTRY_START_SLACK_MS = 5_000;

/**
 * How the start of the process holding an entry's pid compares with when the entry says its
 * session started:
 *   - `consistent` — it started no later than that (plus the slack): it can be the session;
 *   - `after`      — it started later: the pid has changed hands since the entry was written;
 *   - `unread`     — the entry says when, and the process's start time could not be read
 *                    (win32, a failed `ps`): nothing is established either way;
 *   - `unanchored` — the entry states no usable `startedAt` (it is not a finite positive
 *                    number), so there is nothing to compare with.
 * One `ps`, and none for an unanchored entry. Never throws.
 */
export type EntryStartOrder = 'consistent' | 'after' | 'unread' | 'unanchored';

export function entryStartOrder(entry: SessionEntry): EntryStartOrder {
  const said: unknown = entry.startedAt;
  if (typeof said !== 'number' || !Number.isFinite(said) || said <= 0) {
    return 'unanchored';
  }
  const started = processStartedAt(entry.pid);
  if (started === undefined) {
    return 'unread';
  }
  return started > said + ENTRY_START_SLACK_MS ? 'after' : 'consistent';
}

/**
 * May the pid this session entry names be SIGNALLED as the worker the entry describes? THE gate
 * in front of every signal to a pid out of a session entry — both anchors of the section note,
 * asked now. Synchronous, so the caller checks and signals in one turn.
 *
 * True only when the process runs the Claude Code CLI AND its start is `consistent` with the
 * entry, or the entry is `unanchored` (then the command line decides alone). `after` and
 * `unread` are both "not confirmed": no signal.
 */
export function entryPidIsWorker(entry: SessionEntry, claudePath: string): boolean {
  if (!pidRunsWorkerCli(entry.pid, claudePath)) {
    return false;
  }
  const order = entryStartOrder(entry);
  return order === 'consistent' || order === 'unanchored';
}

/** What a stop says when that gate kept it from signalling `pid`. */
export function unconfirmedPidRefusal(pid: number): string {
  return `not stopped: could not confirm pid ${pid} is the worker`;
}

/** Why, as a clause in brackets after that sentence. */
const UNCONFIRMED_PID_WHY =
  'the process holding that pid is not running the Claude Code CLI, or started after its ' +
  'session entry says the session did, or one of the two could not be established';

/* ------------------------------------------------------------------------- *
 * Temp files of writers that died mid-write
 * ------------------------------------------------------------------------- */

/** How old a dead writer's temp file must be before it is removed. */
const DEAD_WRITER_TMP_MIN_AGE_MS = 60_000;

/** The largest pid an operating system this runs on can hand out (Linux's ceiling, 2^22). */
const PID_MAX = 4_194_304;

/**
 * Remove the temp files that writers which have since DIED left beside `file`, and return how
 * many went. Every atomic write in this module goes through `<file>.<pid>.tmp` and a rename;
 * a writer killed between the two leaves the temp file behind for good, because nothing else
 * ever uses that name — its pid does not come back as the same writer. For the ledger that is
 * litter; for an account's `.claude.json` it is a second copy of the account's config at rest.
 *
 * A file is removed only when ALL of this holds, and anything short of it is left alone:
 *   - it is in the SAME directory as `file` and is named exactly `<basename of file>.<pid>.tmp`,
 *     the pid written in canonical decimal (no sign, no leading zero, nothing else) and in the
 *     range a pid can have;
 *   - that pid is not this process's, and `kill(pid, 0)` throws ESRCH — positive evidence that
 *     no such process exists. Success or EPERM (it exists, whoever owns it) keeps the file: a
 *     live writer's temp file is a write in progress;
 *   - `lstat` says a REGULAR file (a link, a directory or a pipe sitting at such a name is not
 *     something this module wrote) whose last write is more than a minute old.
 * Nothing else in the directory is looked at twice, and nothing is followed.
 *
 * Called by a writer, inside the same lock its own write holds, after that write has been
 * renamed into place — so "whoever next writes the file tidies up", no reader ever deletes, and
 * no temp file of a writer still at work can be met (that writer would hold the lock). Total:
 * a directory that cannot be listed and a file that cannot be removed cost nothing.
 */
export function removeDeadWritersTempFiles(file: string): number {
  let removed = 0;
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    const suffix = '.tmp';
    const listing = listDirCapped(dir);
    if (!listing.ok) {
      return 0;
    }
    const now = Date.now();
    for (const name of listing.names) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
        continue;
      }
      const digits = name.slice(prefix.length, name.length - suffix.length);
      if (!/^[1-9]\d{0,6}$/.test(digits)) {
        continue;
      }
      const pid = Number(digits);
      if (pid < 2 || pid > PID_MAX || pid === process.pid) {
        continue;
      }
      try {
        process.kill(pid, 0);
        continue; // a process holds that pid: its temp file is not ours to judge
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          continue; // EPERM: it exists and is somebody else's
        }
      }
      const full = path.join(dir, name);
      try {
        const st = fs.lstatSync(full);
        if (!st.isFile() || !(now - st.mtimeMs > DEAD_WRITER_TMP_MIN_AGE_MS)) {
          continue;
        }
        fs.unlinkSync(full);
        removed++;
      } catch {
        // gone already, or not removable: it is litter either way, and stays for the next writer
      }
    }
  } catch {
    // tidying up after somebody else's crash is never a reason for this write to fail
  }
  return removed;
}

/* ------------------------------------------------------------------------- *
 * The workspace ledger — module-level, because the reaper writes the same file
 * from a process that has no pool instance (contract §5 seam pin)
 * ------------------------------------------------------------------------- */

/**
 * One workspace's state file, read through safeFs and CLASSIFIED into the two outcomes a
 * WRITER has to tell apart.
 *
 * `ok:true` means "this is the state, and it is complete": the file is absent (an empty
 * object IS the empty state the contract asks for), or it was read whole. A file that was
 * read whole and does not parse — or parses to an array/scalar — also lands here as `{}`,
 * deliberately and unchanged from the behavior mcp/server.ts documents against: a corrupt
 * ledger has no records to preserve, and the next write heals the file.
 *
 * `ok:false` is the case that used to be indistinguishable from an empty ledger, and it is a
 * completely different fact: BYTES EXIST AND WE COULD NOT SEE THEM (a permission error, a
 * FIFO or directory sitting at the path, a file past the read cap). Every read-only caller
 * still degrades to "no records", which is the conservative direction — nothing acts on a
 * worker it cannot see. Every WRITER must skip instead, because `raw.workers = ours` over a
 * ledger we could not read deletes the records that name live sessions; that is exactly how
 * "an unreadable ledger read as no records" has bitten this file before.
 */
type MeshStateRead =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; reason: SafeReadFailure; detail: string };

/*
 * NOTE FOR READERS COMING FROM `readRawMeshState`: that helper is GONE, deliberately. It
 * returned `{}` for every failure, which is the collapse this file was rewritten to remove —
 * keeping it around as a convenience wrapper would leave a one-call-away route back to the
 * clobber (two comments in mcp/server.ts still describe it by name and are now stale).
 */
function readMeshStateFile(cwd: string): MeshStateRead {
  const file = meshStateFile(cwd);
  // noFollow: the state file is a regular file this module renames into place in the product's
  // own data directory. A symbolic link at that name is not a ledger — it is `not-a-file`, which
  // is the "bytes we could not see" answer below: read as no records, and never written over.
  const read = readTextSafe(file, MESH_STATE_FILE_MAX_BYTES, { noFollow: true });
  if (!read.ok) {
    if (read.reason === 'absent') {
      return { ok: true, raw: {} };
    }
    return { ok: false, reason: read.reason, detail: `${file}: ${read.detail}` };
  }
  try {
    const raw = JSON.parse(read.text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { ok: true, raw: raw as Record<string, unknown> };
    }
  } catch {
    // read whole, does not parse — corrupt, and an empty object is the contract's empty state
  }
  return { ok: true, raw: {} };
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
      for (const field of [
        'pid',
        'stoppedAt',
        'ownerPid',
        'ownerStartedAt',
        'lastActivityAt',
        'settledAt',
        'deadlineAt',
      ]) {
        const v = bag[field];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
          bag[field] = undefined;
        }
      }
      if (bag.worktreeKept !== undefined && typeof bag.worktreeKept !== 'boolean') {
        bag.worktreeKept = undefined;
      }
      for (const field of ['taskId', 'worktree', 'branch', 'permissionMode']) {
        if (bag[field] !== undefined && typeof bag[field] !== 'string') {
          bag[field] = undefined;
        }
      }
      // RETIRED KEY, and the one exception to "unknown keys ride through": `keepAlive` was
      // this module's own field until v2.0, and it suppressed an idle sweep that no longer
      // exists. Whatever an old file says there is ignored, and clearing it here is what
      // makes the next write of this ledger drop it instead of carrying a mark that means
      // nothing forward for ever.
      delete bag.keepAlive;
      out.push(item as MeshWorkerRecord);
    }
  }
  return out;
}

/**
 * An out-parameter for the ONE thing an empty record list cannot say for itself.
 *
 * `unreadable` is set only when the state file exists and its bytes could not be read
 * (readMeshStateFile's `ok:false`); a missing file and a corrupt one both leave it undefined,
 * because both genuinely mean "no records". Optional so every existing caller is untouched:
 * a caller that does not ask still gets today's `[]`.
 */
export interface LedgerReadNote {
  unreadable?: string;
}

/**
 * Every well-formed worker record in one workspace's ledger (missing file → none).
 *
 * An UNREADABLE ledger also comes back as `[]` — every reader here degrades to "nothing to
 * act on", which is the safe direction for a sweep — but a caller that is about to TELL a
 * human "there is no such worker" can pass `note` and say the truthful thing instead.
 */
export function readMeshWorkerRecords(cwd: string, note?: LedgerReadNote): MeshWorkerRecord[] {
  const read = readMeshStateFile(cwd);
  if (!read.ok) {
    if (note) {
      note.unreadable = `${read.reason} — ${read.detail}`;
    }
    return [];
  }
  return parseWorkerRecords(read.raw);
}

/**
 * The open flags for the temp half of an atomic write, spelled the way safeFs spells its own:
 * every optional POSIX flag is probed rather than assumed, so a platform that does not define
 * one contributes 0 instead of NaN.
 *
 *   - O_NONBLOCK — a FIFO opened O_WRONLY without a reader fails ENXIO instead of BLOCKING
 *     FOREVER. That is the whole attack: the temp path is `<file>.<pid>.tmp`, a name a worker
 *     can derive and pre-create, and a wedge here is not merely a lost write — for the ledger
 *     it happens while the write lock is HELD, so it wedges every other process too.
 *   - O_NOFOLLOW — a symlink at the temp path fails ELOOP at the open, BEFORE O_TRUNC can act.
 *     Without it, `<file>.<pid>.tmp` pointing at any file this process can write is a remote
 *     truncation primitive, and the fstat below would arrive far too late to prevent it.
 *   - O_TRUNC is why this cannot be a safeFs call, and the reason is structural rather than an
 *     omission: safeFs's discipline is "prove it is a regular file BEFORE you touch it", and
 *     truncation happens inside the open itself, so no fstat can precede it. What is proven
 *     before the open is instead the NAME: it is this process's own pid-scoped temp path, which
 *     nothing else may legitimately hold, and O_NOFOLLOW makes truncating it local.
 */
const TMP_WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * Write `text` to a temp path that an untrusted process may have occupied first, and REPORT
 * rather than throw. Never blocks, never follows a symlink, never writes into anything that is
 * not a regular file, and never half-writes silently.
 *
 * Local rather than shared because safeFs is frozen and offers no truncating write (see
 * TMP_WRITE_FLAGS for why it cannot), and because the other module that needs this shape sits
 * on the far side of an import edge — a shared helper would have to live in a new file, which
 * this change may not add. The two copies are identical and are commented as such.
 *
 * THE RENAME IS THE CALLER'S, AND IT MUST NOT RUN ON `ok:false`. A tmp+rename whose temp write
 * was refused would publish a stale or truncated temp file over the real one; every caller
 * below therefore branches before renaming, and none of them treats a refusal as "written".
 */
function writeTempFileGuarded(file: string, text: string): { ok: true } | { ok: false; detail: string } {
  const buf = Buffer.from(text, 'utf8');
  const why = (err: unknown): string =>
    (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'unknown error';
  /**
   * Open the temp path and PROVE it is a regular file, or close and say why. Both halves live
   * here so the retry below is one call: a descriptor that failed the fstat is closed before
   * the name is reclaimed, never leaked into it.
   */
  const closeQuietly = (fd: number): void => {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  };
  const openProven = (): { ok: true; fd: number } | { ok: false; detail: string } => {
    let fd: number;
    try {
      fd = fs.openSync(file, TMP_WRITE_FLAGS, 0o600);
    } catch (err) {
      // ENXIO = a reader-less FIFO; ELOOP = a symlink; anything else is an ordinary failure.
      return { ok: false, detail: why(err) };
    }
    // Every failure below CLOSES the fd before returning — a descriptor handed to nobody is a
    // descriptor leaked, and the reclaim/retry that follows a refusal would otherwise pile one
    // up per attempt. Only the success path hands it back, still open, to the writer.
    try {
      if (!fs.fstatSync(fd).isFile()) {
        // A FIFO with a live reader, a device, a socket. NOTHING HAS BEEN WRITTEN YET.
        closeQuietly(fd);
        return { ok: false, detail: 'the temp path is not a regular file' };
      }
    } catch (err) {
      closeQuietly(fd);
      return { ok: false, detail: why(err) };
    }
    return { ok: true, fd };
  };
  /**
   * RECLAIM THE NAME ONCE, then give up. Without this the guard would trade a hang for a
   * PERMANENT write failure: the temp path embeds this process's pid, which never changes, so
   * one planted FIFO or symlink there would refuse every write for the life of the process —
   * and a ledger that can no longer be written is a ledger whose stop marks never land. The
   * removal is deliberately narrow: `unlinkSync` (a file, FIFO, socket, device, or the SYMLINK
   * ITSELF rather than its target), then `rmdirSync`, which removes only an EMPTY directory.
   * Nothing recursive, nothing that follows a link, and only ever at `<file>.<pid>.tmp` — a
   * name this process owns and whose contents this call is about to replace anyway. A
   * non-empty planted directory survives and the write is refused, which is the safe end.
   */
  const reclaim = (): void => {
    try {
      fs.unlinkSync(file);
      return;
    } catch {
      // not unlinkable — try the one remaining shape
    }
    try {
      fs.rmdirSync(file);
    } catch {
      // occupied by something we will not remove; the second open refuses again
    }
  };
  let opened = openProven();
  if (!opened.ok) {
    const first = opened.detail;
    reclaim();
    opened = openProven();
    if (!opened.ok) {
      return { ok: false, detail: `${first} (and ${opened.detail} after reclaiming the name)` };
    }
  }
  const fd = opened.fd;
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) {
        break;
      }
      off += n;
    }
    if (off < buf.length) {
      // A partial write must never be renamed over the real file: that IS the torn file the
      // tmp+rename pattern exists to make impossible.
      return { ok: false, detail: `short write (${off} of ${buf.length} bytes)` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: why(err) };
  } finally {
    closeQuietly(fd);
  }
}

/* --- the ledger write lock (F1) ----------------------------------------- *
 * The state file is read-modify-written by SEVERAL processes: every MCP server (spawn records,
 * settle marks, stop marks, worktree verdicts, the owner claim) and every editor window's
 * extension host (UI cancel, the activation reaper, history clearing). tmp+rename makes every
 * write ATOMIC, so a reader can only see a whole old or a whole new file — but atomicity does
 * not prevent a LOST UPDATE: two writers that both read the same snapshot and both rename
 * produce a file missing one of the edits. Consequence class: a stop mark or a settle mark
 * silently evaporating — a record that says live for a worker somebody stopped, or a cap slot
 * nothing ever frees.
 *
 * So every WRITE runs under an exclusive lock beside the state file, and every READ stays
 * lock-free (a lock-free reader is already safe, and locking reads would serialize the status
 * surfaces against every mark).
 *
 * THE LOCK IS registry.ts's (withPathLock), NOT A SECOND IMPLEMENTATION OF IT. This file used to
 * carry its own copy of an earlier version of that discipline, and it lost updates in exactly
 * the ways registry.ts's had been found to: it removed a lock BY NAME after judging it (two
 * waiters that judged one dead holder's lock could each remove a lock, the second one a live
 * one), it read the token before probing the pid (a holder that released and exited in between
 * was taken for a dead holder of whatever lock had the name by then), and it broke a LIVE
 * holder's lock on age and on a waiter's deadline. Measured before the change: 8 processes × 20
 * appends behind an abandoned lock ended short of 160 records in 28 runs of 100. What the lock
 * guarantees instead, and why, is written once, there: only the holder releases; a lock is
 * removed by anyone else only when its holder is PROVEN gone, and then by one elected breaker
 * that looks again first; a waiter that can prove nothing waits 15 s and then THROWS.
 *
 * NAME COLLISION, and it is load-bearing: `<stateFile>.lock` is ALREADY TAKEN — server.ts's
 * meshLockFile() uses exactly that path for the workspace OWNER CLAIM marker, a long-lived
 * file (held for a whole server lifetime, published by hardlink, carrying a JSON owner
 * record) with completely different semantics from a millisecond-scale write lock. Taking it
 * here would be a disaster in both directions: our exclusive create would fight a claim that is
 * legitimately held for hours, and the lock's own clearing rule — a thing at a lock's path that
 * is not a lock is litter, and is removed — would take a LIVE owner's claim away and hand the
 * workspace to a second orchestrator. So the write lock is a SIBLING with its own suffix,
 * `<stateFile>.write.lock`, and the two never interact. (That is why registry.ts exports the
 * form that takes the lock's own path: its usual form derives `<file>.lock` from the data file.)
 *
 * THE PATH IS THE ONE 1.x USED, ON PURPOSE, so that every process agrees which name is the
 * lock. What is AT the path changed — a symbolic link whose target text is the token, where 1.x
 * wrote a regular file — and a 1.x process sharing the directory (an editor window that has not
 * been updated yet) meets it like this:
 *   - it still EXCLUDES on a 2.0 lock: its exclusive create fails on a link as on a file;
 *   - it cannot READ one (it follows the link and finds nothing), so it never calls a 2.0 lock
 *     stale by pid or by age — but it still takes ANY lock by force once it has waited 15 s, so
 *     a 2.0 holder slower than that (a frozen process, a starved machine) can be walked in on.
 *     That is not prevented. It is DETECTED: the 2.0 holder finds at release that the lock is no
 *     longer its own, and withPathLock throws — see runLedgerWrite for what becomes of that;
 *   - a 2.0 process reads a 1.x lock (a regular file holding `<pid> <ms> <nonce>`) as what it
 *     is, and clears it only when that pid is proven gone.
 * Mixed operation is reasoned here, not measured: no 1.x process was run against this lock.
 * ------------------------------------------------------------------------ */

/**
 * The ledger WRITE lock's path. Never `${targetFile}.lock` — that name is the mesh owner
 * claim marker (server.ts meshLockFile), see the section note above.
 */
function ledgerLockPath(targetFile: string): string {
  return `${targetFile}.write.lock`;
}

/**
 * What became of ONE attempt to run a section under the ledger write lock.
 *
 *   - `entered: false` — the lock was not taken and the section DID NOT RUN. `reason` is
 *     withPathLock's own message, untouched: the lock stayed held by a live process (or stayed
 *     unclearable) for the whole 15 s wait — that one begins `Could not lock ` and says how to
 *     recover — or it could not be created at all (a missing or read-only mesh dir, a
 *     permission error).
 *   - `entered: true`  — the section ran to completion and returned `value`. `evicted` is set
 *     in the one case where that is not the whole story: the lock was no longer ours at release.
 */
type LedgerSection<T> =
  | { entered: false; reason: string }
  | { entered: true; value: T; evicted?: string };

/**
 * Run `section` while holding the exclusive write lock beside `targetFile`, and CLASSIFY what
 * withPathLock did instead of letting its throws through. NOT reentrant: `section` must never
 * call back into anything that locks the same file.
 *
 * withPathLock throws in three situations, and the two ledger writers below must not treat them
 * alike — which is the whole reason this wrapper exists:
 *
 *   1. BEFORE the section ran: the create failed, or the wait timed out. Nothing happened, so
 *      this is a skip the caller can report and retry (`entered: false`). A waiter never takes
 *      the lock by force any more; the 1.x lock did after 15 s, and that forced entry is one of
 *      the ways it lost records.
 *   2. The SECTION threw (a refused temp write, a failed rename, the caller's own mutator).
 *      Re-raised unchanged, as it always was: it is the caller's failure, not the lock's.
 *   3. AFTER the section returned: the release check found something else at the lock's path.
 *      Under the 2.0 protocol that cannot happen, so it means something outside it took the lock
 *      away mid-section — a 1.x process breaking by deadline (see the section note), or a person
 *      deleting the file. The section's own write is ALREADY ON DISK, but it may not be durable:
 *      whoever took the lock may have read the file before that write and put its own version
 *      back over it afterwards. So this is neither "written" nor "failed"; it is returned as
 *      `evicted`, and runLedgerWrite decides what to do about it.
 */
function underLedgerLock<T>(targetFile: string, section: () => T): LedgerSection<T> {
  const ran: { entered: boolean; returned: boolean; value?: T } = { entered: false, returned: false };
  try {
    withPathLock(ledgerLockPath(targetFile), () => {
      ran.entered = true;
      ran.value = section();
      ran.returned = true;
    });
  } catch (err) {
    if (ran.entered && !ran.returned) {
      throw err;
    }
    const said = (err as Error)?.message ?? 'unknown error';
    return ran.entered ? { entered: true, value: ran.value as T, evicted: said } : { entered: false, reason: said };
  }
  return { entered: true, value: ran.value as T };
}

/**
 * What became of one ledger write, after everything this module does about the lock.
 *   - `skipped`   — nothing was written, and `reason` says why.
 *   - `written`   — the section's write is on disk and was made under a lock that was still
 *                   ours when it finished.
 *   - `contested` — the write reached disk, the lock was taken away while it was being made,
 *                   and re-applying it did not settle the matter (`note` says why). Whether the
 *                   file still holds this write is not known.
 */
type LedgerRun =
  | { state: 'skipped'; reason: string }
  | { state: 'written' }
  | { state: 'contested'; note: string };

/**
 * One ledger write, start to finish: run `section` under the write lock and, when the lock was
 * taken away while it ran, RUN IT ONCE MORE. Both writers of the state file go through here.
 *
 * `section` reads the state file, edits it and renames the result into place; it answers with
 * the reason it wrote NOTHING, or undefined once it has written (or found nothing to change).
 * `lockNotTaken` turns withPathLock's message into this writer's sentence for a skip — the
 * message itself is kept whole inside it.
 *
 * WHY A SECOND RUN, AND WHY IT IS SAFE. An evicted write may have been replaced (underLedgerLock,
 * case 3), and no caller can find that out for itself: the mark it asked for would simply not be
 * there later. Run again — under the lock, against a FRESH read — the section either finds its
 * own edit still in the file and changes nothing, or finds it gone and makes it again. That is
 * only true of an edit that is IDEMPOTENT, so that is what both writers require of the mutator
 * they are given (each says so), and every mutator in this codebase is: marks are set only where
 * absent, appends skip a record already present, deletions are re-derived from what is read.
 *
 * ONCE, not until it sticks: a second eviction means something is breaking this lock as fast
 * as it is taken, and a loop against that is a loop. The outcome is then `contested`, as it is
 * when the second run could not take the lock, could not read the file, or failed — a throw
 * from the SECOND run is reported that way rather than re-raised, because the first run's write
 * did happen and "this write failed" would no longer be a true thing to say. (A throw from the
 * first run is the caller's, unchanged.)
 */
function runLedgerWrite(
  finalPath: string,
  section: () => string | undefined,
  lockNotTaken: (reason: string) => string,
): LedgerRun {
  const first = underLedgerLock(finalPath, section);
  if (!first.entered) {
    return { state: 'skipped', reason: lockNotTaken(first.reason) };
  }
  if (first.value !== undefined) {
    return { state: 'skipped', reason: first.value };
  }
  if (first.evicted === undefined) {
    return { state: 'written' };
  }
  let unsettled: string;
  try {
    const again = underLedgerLock(finalPath, section);
    if (again.entered && again.value === undefined && again.evicted === undefined) {
      return { state: 'written' };
    }
    unsettled = !again.entered
      ? `could not be re-applied (${again.reason})`
      : again.value !== undefined
        ? `could not be re-applied (${again.value})`
        : `had its lock removed again while it was re-applied (${again.evicted})`;
  } catch (err) {
    unsettled = `failed when it was re-applied (${(err as Error)?.message ?? 'unknown error'})`;
  }
  return {
    state: 'contested',
    note:
      `the write lock beside ${finalPath} was removed by another process while this ledger ` +
      `write held it (${first.evicted}) — most likely an editor window still running a pre-2.0 ` +
      `version of the extension — and the write then ${unsettled}. It reached the file, but it ` +
      `and a write that process made at the same moment may have replaced one another.`,
  };
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
 * What became of one ledger write (mutateMeshWorkers).
 *
 * `written` is the fact a caller acts on: true when the mutator ran and what it left reached
 * the state file. At most one of the two notes accompanies it:
 *   - `skipped` (with `written: false`) — why the write did not happen, as a sentence. The
 *     mutator was not run: the file is as it was. When the cause is the write lock, the lock's
 *     own message is inside the sentence, whole — it names the process holding the lock and
 *     the lock file, and says when deleting that file is safe.
 *   - `contested` (with `written: true`) — the write reached the file, but the write lock was
 *     taken away from this process while it wrote, and re-applying the write did not settle
 *     whether it is still there (runLedgerWrite). Rare twice over; a caller with somewhere to
 *     say so says so.
 */
export interface LedgerWrite {
  written: boolean;
  skipped?: string;
  contested?: string;
}

/**
 * Read-modify-write the WHOLE state object for one workspace, mutating only `workers`.
 * The read happens under the lock and immediately before the write, so the server-owned
 * fields (ownerPid, cwd, startedAt) are re-serialized from the freshest bytes on
 * disk, and unmodeled keys ride through untouched (contract: do not clobber fields we do not
 * own) — with the one exception of the RETIRED `gatewayName` (see dropRetiredStateKeys).
 * The write is atomic — tmp file in the SAME dir, then rename (run-task.ts).
 *
 * Callers that may have nothing to change must check FIRST and skip the call: this
 * function creates the state file when it is absent, and a reaper sweep must never leave
 * an empty ledger behind for a workspace it merely looked at.
 *
 * F1: the whole read → mutate → write runs under the exclusive `<stateFile>.write.lock`
 * (NOT `<stateFile>.lock`, which is the owner claim marker — see the lock section), and the
 * state is RE-READ inside the lock, so two writers can no longer lose each other's edits.
 * This is the ONLY writer of the `workers` array in any process — the server's pool, the
 * reaper and the extension host's standalone helpers all funnel through here — so one lock
 * here covers every writer that exists. F5a: each write also prunes long-stopped records.
 *
 * TOTAL by construction, FOR THE LOCK. This runs inside settle paths, activation sweeps and
 * shutdown handlers, none of which may die from a ledger problem, so a write lock that cannot
 * be taken SKIPS the mutation instead of throwing or writing unlocked: a skipped mark is a
 * stale timestamp, whereas an unlocked write is a lost update we would never detect. "Cannot be
 * taken" now has two causes and both are the same skip:
 *   - the lock cannot be created at all (a read-only mesh dir, a permission error) — at once;
 *   - the lock stayed held by a LIVE process for the whole 15 s wait. NEW in 2.0: the old lock
 *     broke in at that point and wrote, which is how a slow holder's write and the breaker's came
 *     to overwrite one another. This call has then PARKED ITS THREAD for those 15 s — as the old
 *     one did before breaking in — and the reason names the holder's pid and the lock file.
 * Write failures after the lock is held still propagate, exactly as before — the callers that
 * care already wrap their writes.
 *
 * AN UNREADABLE LEDGER IS A THIRD SKIP, and it is the one that matters most. The re-read
 * inside the lock is what this function serializes back to disk, so a read that could not see
 * the file's bytes and degraded to `{}` would rewrite the ledger as nothing but this caller's
 * own edit — deleting, in one atomic rename, every record that names a live `--bg` session.
 * That is the leak this whole module exists to prevent, manufactured by the bookkeeping write
 * itself, and it is reachable by anything that can plant a FIFO, a directory or an oversized
 * file at the state path. readMeshStateFile draws the line: absent and corrupt are states we
 * may rewrite, unreadable is not.
 *
 * A SKIP IS REPORTED TWICE OVER, because "did not write" must never read as "wrote": in the
 * return value (`written: false`, with the reason), and through `opts.onSkip` for a caller that
 * narrates it. The reporter is called AFTER the lock is released and its own throw is
 * swallowed, so it can never become a new failure mode inside the critical section. Nothing in
 * here retries a skip: a skipped write is skipped until its caller calls again. WHAT EACH
 * CALLER DOES WITH ONE — there are two policies, and which applies is decided by what the
 * write is for:
 *   - THE SPAWN RECORD decides a dispatch's outcome, so its skip becomes that dispatch's
 *     error, with the reason whole: tried once more (WorkerPool.writeDurably), then the
 *     session is stopped again and the spawn fails;
 *   - EVERY OTHER WRITE IS BOOKKEEPING about something that has already happened, and a skip
 *     never changes what happened — it is said in one line, wherever that caller can say it,
 *     and the work goes on: WorkerPool.stop tries its mark once more and then puts the reason
 *     in its note (the stop succeeded); the settle mark is tried once more and then logged;
 *     the reaper's marks go to ReapReport.errors and are re-derived by the next sweep, which
 *     finds the same record in the same state; markWorkerStopped (the editor's cancel)
 *     returns the reason to its caller, which shows it; a worktree verdict, a history prune, a
 *     history clear and an adopt() are logged (logMeshProblem) and not retried — each leaves
 *     the ledger saying what it said before, a state every reader already handles ("unknown",
 *     "still listed", "not tracked yet").
 *
 * THE MUTATOR MUST BE IDEMPOTENT: it may be run TWICE in one call, the second time against a
 * fresh read of the file, when the write lock was taken away while the first run was writing
 * (runLedgerWrite). Set a mark only where it is absent, append a record only if it is not
 * already there, derive a deletion from the array you are handed — and rebuild any count you
 * keep on each run.
 */
export function mutateMeshWorkers(
  cwd: string,
  fn: (workers: MeshWorkerRecord[]) => void,
  opts?: { onSkip?: (reason: string) => void },
): LedgerWrite {
  const finalPath = meshStateFile(cwd);
  // Before the lock, because the lock is a SIBLING of the state file: with the mesh dir
  // absent, the exclusive create would fail ENOENT and every mutation would be skipped.
  try {
    fs.mkdirSync(MESH_STATE_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // unwritable — the lock cannot be created below and the mutation is skipped, as documented
  }
  // The section answers with the reason it wrote NOTHING, or undefined once the rename is done.
  // A throw out of it (the write failed, or the caller's mutator threw) is the caller's problem
  // and comes through unchanged.
  const section = (): string | undefined => {
    // Re-read INSIDE the lock: a snapshot the caller took before calling us is not what we
    // serialize. Every field we do not own rides through untouched.
    const read = readMeshStateFile(cwd);
    if (!read.ok) {
      return (
        `the mesh state file could not be READ (${read.reason} — ${read.detail}), so this ` +
        `ledger write was skipped rather than rewriting the file from a state we could not ` +
        `see: the records we cannot read are the ones that name live workers.`
      );
    }
    const raw = read.raw;
    const workers = parseWorkerRecords(raw);
    fn(workers);
    pruneStoppedRecords(workers, Date.now());
    raw.workers = workers;
    dropRetiredStateKeys(raw);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    const wrote = writeTempFileGuarded(tmpPath, JSON.stringify(raw, null, 2));
    if (!wrote.ok) {
      // THROWN, not skipped, and the difference is deliberate: this is a failure INSIDE the
      // critical section, which this function has always propagated ("write failures after
      // the lock is held still propagate"). fs.writeFileSync threw here before; a refusal
      // that returned quietly would be a lost mark reported as a successful one. The rename
      // is below this line and therefore never runs.
      throw new Error(
        `the mesh ledger's temp file ${tmpPath} could not be written (${wrote.detail}), so ` +
          `nothing was renamed over ${finalPath} and this ledger write did not happen.`,
      );
    }
    fs.renameSync(tmpPath, finalPath);
    // The write is in place. A writer killed between its temp write and its rename left
    // `<state>.<pid>.tmp` behind; this one, still holding the lock, takes those away.
    removeDeadWritersTempFiles(finalPath);
    return undefined;
  };
  // Lock not taken (unusable, or held for the whole wait): skip this mutation rather than write
  // unlocked. Every teardown path is idempotent, and the doc comment says who calls again.
  const ran = runLedgerWrite(
    finalPath,
    section,
    (reason) =>
      `the ledger write lock beside ${finalPath} could not be taken (${reason}), so this ` +
      `ledger write was skipped rather than written unlocked.`,
  );
  if (ran.state === 'skipped') {
    if (opts?.onSkip) {
      try {
        opts.onSkip(ran.reason);
      } catch {
        // a reporter that throws must not become the failure mode of a bookkeeping write
      }
    }
    return { written: false, skipped: ran.reason };
  }
  return ran.state === 'contested' ? { written: true, contested: ran.note } : { written: true };
}

/** Chars of one logMeshProblem line: room for the lock's whole message and two paths. */
const MESH_LOG_MAX_CHARS = 1_600;

/** Whether logMeshProblem has put its 'error' listener on stderr yet (once per process). */
let meshLogGuarded = false;

/**
 * One diagnostic line on stderr, for a piece of best-effort bookkeeping that could not be done
 * and whose caller goes on regardless: a ledger mark that was skipped (a stop mark, a settle
 * mark, a worktree verdict, an adoption, a history prune or clear, the marks made on the way
 * out at shutdown), an account pre-seed that was skipped. Flattened to a single bounded line —
 * the reason quotes file paths — and never throws.
 *
 * It is IN ADDITION to whatever the caller can tell its own caller (a stop's note, the sweep's
 * report), because most of those are not read by anyone: the dispatch path discards a stop's
 * result, and nothing consumes the sweep's error list.
 *
 * stderr because it is the one channel both processes that write the ledger have: for the MCP
 * server it is the log its client keeps (stdout is the protocol), for the extension host it is
 * the host's own log. The 'error' listener is for a stderr nobody reads any more: a closed pipe
 * reports EPIPE as an event on the stream, later, and an unhandled one ends the process — a
 * note about a mark must not be able to do that. (The dispatch server guards its own stderr
 * line the same way, in mcp/task-runner.ts; this module cannot import from there.)
 */
export function logMeshProblem(what: string): void {
  try {
    if (!meshLogGuarded) {
      meshLogGuarded = true;
      process.stderr.on('error', () => undefined);
    }
    const flat = flattenOneLine(`mesh: ${what}`);
    const line = flat.length > MESH_LOG_MAX_CHARS ? `${sliceOneLine(flat, MESH_LOG_MAX_CHARS)}…` : flat;
    process.stderr.write(`${line}\n`);
  } catch {
    // no stderr to write to — the bookkeeping was skipped either way
  }
}

/**
 * Remove the state-file keys v2.0 RETIRED, in place, on the way to a write.
 *
 * `gatewayName` named the relay session a v1.x server ran; nothing reads it any more and
 * nothing may write it (contract MeshState). A file that still carries it parses fine, and
 * the first write of that file — by EITHER writer below, which is why both call this —
 * drops it, so a ledger never goes on advertising a session that does not exist.
 */
function dropRetiredStateKeys(raw: Record<string, unknown>): void {
  delete raw.gatewayName;
}

/**
 * The mesh state file's SERVER-owned fields: contract `MeshState` MINUS `workers` (and
 * minus the retired `gatewayName`).
 *
 * The subtraction is the point. This type is what a mutator passed to
 * mutateMeshOwnerFields receives, so "the server never writes the workers array" is a
 * property of the SHAPE (there is no such field to assign, and assigning one is a compile
 * error) rather than a convention every future edit has to remember. The runtime half of
 * the same guarantee is in mutateMeshOwnerFields: only these three keys are ever copied back
 * onto the state object, so even an untyped caller cannot smuggle a `workers` through.
 */
export interface MeshOwnerFields {
  ownerPid: number;
  cwd: string;
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

/** A string, or ''. An absent or wrongly-typed cwd is not a usable one. */
function ownerString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The server-owned fields as they currently stand in a raw state object. */
function ownerFieldsFromRaw(raw: Record<string, unknown>): MeshOwnerFields {
  return {
    ownerPid: ownerNumber(raw.ownerPid),
    cwd: ownerString(raw.cwd),
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
 * lost update: the extension host can edit the ledger (the tree cancel's stopped mark, the
 * activation reaper) between that read and that write, and the write puts the stale array
 * back. It is not theoretical — a ledger mark vanished in two of three runs of the
 * two-process hammer. Locking mutateMeshWorkers alone could never fix it,
 * because these writers did not go through it. Now nobody outside this file writes the
 * state file at all: the pool/reaper/extension write `workers` here, the server writes its
 * own fields here, and one lock covers both.
 *
 * The mutator receives the fields as they stand ON DISK, read inside the lock, so a
 * decision it makes about the current value (shutdown's "release only a lock that still
 * names me") is made against the freshest bytes rather than against a snapshot the caller
 * took before some await. Whatever it leaves behind is re-validated and copied back onto
 * the parsed state object; `workers` and every unmodeled key ride through UNTOUCHED (the
 * retired `gatewayName` alone is dropped — dropRetiredStateKeys) — not
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
 * changed, nothing written" case) and FALSE when the write lock could not be taken and the
 * mutation was skipped — the same total behavior mutateMeshWorkers documents (never write
 * unlocked, never throw for a lock we could not take), reported rather than swallowed because
 * the owner CLAIM is not a best-effort mark: a claim that never reached disk must not be
 * mistaken for one that did. FALSE also covers a state file whose bytes could not be read at
 * all, for the reason spelled out at the read below: this function serializes the whole
 * object, so writing over a state we could not see would take `workers` with it. A throw
 * from INSIDE the critical section (the write failed, or the mutator threw) still propagates
 * unchanged.
 *
 * "COULD NOT BE TAKEN" INCLUDES A LOCK HELD FOR THE WHOLE WAIT, since 2.0: where the old lock
 * broke in after 15 s, this one gives up after 15 s and the call returns false, having parked
 * the thread that long. The boolean cannot say which of the causes it was, so `opts.onSkip`
 * receives the sentence — for a held lock it carries the lock's own message whole, which names
 * the holder's pid and the lock file — and a caller that tells a person "the claim was not
 * recorded" should pass that on rather than guess at a cause. Both callers get the contract
 * they already had: the claim at init refuses the mesh and is retried by the next mesh call;
 * the release at shutdown leaves the owner field naming a process that is about to be gone,
 * which every reader already resolves by liveness. (The reporter runs after the lock is
 * released, and a throw from it is swallowed.)
 *
 * THE MUTATOR MUST BE IDEMPOTENT, as for mutateMeshWorkers and for the same reason: when the
 * write lock is taken away while the write is being made, the write is re-applied once against
 * a fresh read (runLedgerWrite). Both callers' are — "these are my fields", "0 if it still
 * names me". If even that does not settle whether the fields are on disk, the answer is FALSE
 * and the reporter is told why: a claim that cannot be vouched for is not reported as made.
 *
 * NOT reentrant, and one lock ORDER exists in this system: the server holds its long-lived
 * claim marker (`<stateFile>.lock`) across a call to this function, which takes the
 * millisecond-scale write lock (`<stateFile>.write.lock`) inside it. Nothing anywhere takes
 * the claim marker while holding the write lock, so the two cannot deadlock — and a mutator
 * passed here must never call back into anything that locks the same file.
 */
export function mutateMeshOwnerFields(
  cwd: string,
  fn: (owner: MeshOwnerFields) => void,
  opts?: { onSkip?: (reason: string) => void },
): boolean {
  const finalPath = meshStateFile(cwd);
  // Before the lock, for the same reason as in mutateMeshWorkers: the lock is a SIBLING of the
  // state file, so a missing mesh dir would fail every exclusive create.
  try {
    fs.mkdirSync(MESH_STATE_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // unwritable — the lock cannot be created below and the mutation is skipped, as documented
  }
  // As in mutateMeshWorkers, the section answers with the reason it wrote nothing — which here
  // is only ever an unreadable state file. Same rule, and the stakes are identical: this
  // function writes the WHOLE parsed object back, so `workers` rides through it. A read that
  // degraded to `{}` because the file's bytes were unreadable would therefore erase the ledger
  // through the owner-claim path — the one writer that is explicitly forbidden to touch
  // `workers` at all.
  const section = (): string | undefined => {
    const read = readMeshStateFile(cwd);
    if (!read.ok) {
      return (
        `the mesh state file could not be READ (${read.reason} — ${read.detail}), so its owner ` +
        `fields were not written.`
      );
    }
    const raw = read.raw;
    const before = ownerFieldsFromRaw(raw);
    const owner: MeshOwnerFields = { ...before };
    fn(owner);
    // Re-validated on the way out exactly as on the way in: a mutator reached from
    // untyped JS (or one that computed a NaN) must not be able to write a state file
    // that this module's own reader would reject.
    const next: MeshOwnerFields = {
      ownerPid: ownerNumber(owner.ownerPid),
      cwd: ownerString(owner.cwd),
      startedAt: ownerNumber(owner.startedAt),
    };
    if (
      next.ownerPid === before.ownerPid &&
      next.cwd === before.cwd &&
      next.startedAt === before.startedAt
    ) {
      return undefined; // nothing to say — and therefore no file to create and no bytes to churn
    }
    // The write-back WHITELIST — the runtime half of "cannot touch workers". Three named
    // keys, assigned onto the object read from disk; `raw.workers` is never on the left
    // of an assignment in this function.
    raw.ownerPid = next.ownerPid;
    raw.cwd = next.cwd;
    raw.startedAt = next.startedAt;
    dropRetiredStateKeys(raw);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    const wrote = writeTempFileGuarded(tmpPath, JSON.stringify(raw, null, 2));
    if (!wrote.ok) {
      // Same rule as mutateMeshWorkers, and it matters more here: the return value of this
      // function is a CLAIM that the owner fields reached disk. A refusal must reach the
      // caller as a failure, never as a silent no-op that returns true.
      throw new Error(
        `the mesh state file's temp file ${tmpPath} could not be written (${wrote.detail}), ` +
          `so nothing was renamed over ${finalPath} and the owner claim did not land.`,
      );
    }
    fs.renameSync(tmpPath, finalPath);
    removeDeadWritersTempFiles(finalPath); // as in mutateMeshWorkers: the next writer tidies up
    return undefined;
  };
  // Lock not taken, state file unreadable, or a write nothing can vouch for: FALSE each time,
  // and the caller is TOLD (see the doc comment) rather than handed a claim that may not exist.
  const ran = runLedgerWrite(
    finalPath,
    section,
    (reason) =>
      `the ledger write lock beside ${finalPath} could not be taken (${reason}), so the owner ` +
      `fields were not written.`,
  );
  if (ran.state === 'written') {
    return true;
  }
  if (opts?.onSkip) {
    try {
      opts.onSkip(ran.state === 'skipped' ? ran.reason : ran.note);
    } catch {
      // a reporter that throws must not turn a skipped write into a thrown one
    }
  }
  return false;
}

/**
 * What a session-directory scan could NOT see, for the callers that draw a negative
 * conclusion from an empty result.
 *
 * `complete:false` means the listing was cut short (the cap, an io error mid-listing), or the
 * directory itself could not be opened for a reason other than not existing, or at least one
 * `.json` entry's BYTES could not be read. In every one of those cases the entries returned
 * are real and absence proves nothing — which is precisely the difference between "no session
 * carries that name" and "we could not finish looking". A parse failure is NOT incompleteness:
 * a file we read whole and that does not hold a session entry is a file that positively is not
 * one, and it has always been skipped.
 */
export interface SessionScan {
  complete: boolean;
}

/**
 * Every parseable session entry in one dir; a missing dir or bad file is skipped, never fatal.
 *
 * Both halves are guarded now, because a session directory lives inside a worker's OWN config
 * dir: the listing is streamed and capped (listDirCapped) so a flooded dir cannot allocate the
 * extension host out of memory, and each entry goes through safeFs so a FIFO planted at
 * `sessions/x.json` cannot block a sweep forever. `scan` is an optional out-parameter: pass it
 * when an EMPTY result would license an action (see locateSession), leave it off
 * when the result only feeds a listing.
 */
export function readSessionEntries(dir: string, scan?: SessionScan): SessionEntry[] {
  const listing = listDirCapped(dir);
  if (!listing.ok) {
    // A directory that is not there is an honest empty; one we were refused is not.
    if (scan && !listing.absent) {
      scan.complete = false;
    }
    return [];
  }
  if (scan && listing.truncated) {
    scan.complete = false;
  }
  const out: SessionEntry[] = [];
  for (const f of listing.names) {
    if (!f.endsWith('.json')) {
      continue;
    }
    const read = readTextSafe(path.join(dir, f), SESSION_ENTRY_MAX_BYTES, SESSION_ENTRY_READ);
    if (!read.ok) {
      // 'absent' is a file that vanished between the listing and the read — a session that
      // ended, which is exactly what an absent entry means. Anything else is an entry that
      // EXISTS and might be the live worker somebody is about to conclude is gone.
      if (scan && read.reason !== 'absent') {
        scan.complete = false;
      }
      continue;
    }
    try {
      const entry = parseSessionEntry(JSON.parse(read.text));
      if (entry) {
        out.push(entry);
      }
    } catch {
      // a single corrupt entry must not blind us to the rest of the dir
    }
  }
  return out;
}

/**
 * The session-registry entry naming `name` in one account's sessions dir. A REAL entry
 * always wins a bridge mirror of the same name: the mirror is a copy of another account's
 * entry, and a kill must follow the genuine one.
 *
 * NOT A LIVENESS SOURCE, and nothing may use it as one: names are REUSED across
 * generations, so a name can resolve to a previous worker's stale entry or to a different
 * live worker. Every liveness question goes through the job-id lookup in the
 * session-status section below. The one remaining caller is the failed-spawn cleanup
 * (stopStrandedSession), which holds a freshly minted name and — by definition — no job id.
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
 * Which ledger key a `stop()` caller is naming its target by.
 *
 * The distinction exists because exactly ONE of these keys identifies a record. A job id is
 * minted per SPAWN and is unique across the ledger; a worker NAME is REUSED across generations
 * — nextSeq() only counts the names the ledger and the live session dirs still hold, and
 * LEDGER_PRUNE_MS drops a stopped record after a week, so seq restarts. A ledger holding a
 * retained stopped record and a live worker of the same name is the observed state that made
 * "stop it" a coin flip decided by array order, and the losing side of that flip is somebody's
 * running worker.
 *
 *  - 'name'   — the DEFAULT, and what the internal callers pass: the dispatch timeout, the
 *               quota-stall path and the cancel hook. An unambiguous name resolves exactly
 *               as it always did.
 *  - 'jobId'  — the exact record, for a caller that read one off mesh_status.
 *  - 'either' — the tool surface (mesh_stop_worker), where a caller may pass either key.
 */
export type StopTargetKey = 'name' | 'jobId' | 'either';

/** What resolving a stop target against the ledger produced: one record, or the reason it did not. */
type StopTargetResolution =
  | { ok: true; record: MeshWorkerRecord; note?: string }
  | { ok: false; error: string };

/**
 * Is `candidate` the same ledger record as `target`?
 *
 * Identity is the (name, jobId) PAIR, never the name alone. Every ledger write a stop performs
 * — markStopped, the worktree verdict — re-reads the file under the lock and has to find the
 * record again, and finding it by NAME is the same first-match-wins lookup that made stopping
 * ambiguous in the first place: stopping a ghost by its job id would then stamp `stoppedAt` on
 * its LIVE namesake, hiding a running worker from every sweep and from the reaper, which is the
 * exact leak this module exists to prevent. Two records agreeing on both fields are
 * indistinguishable to every other reader of the ledger anyway.
 */
function isSameWorkerRecord(candidate: MeshWorkerRecord, target: MeshWorkerRecord): boolean {
  return candidate.name === target.name && candidate.jobId === target.jobId;
}

/** Chars of a foreign value kept when it is quoted back inside a mesh error message. */
const ERROR_VALUE_MAX_CHARS = 80;

/**
 * Project a foreign value (a ledger job id or name, a caller-supplied target) for interpolation
 * into an error message.
 *
 * The mesh state file is a FILE: any process on this machine can write it, and nothing validates
 * a name or a job id on the way in. The mesh wire format is `mesh error [<code>]: <detail>` with
 * the detail read as one line, so a value carrying a newline or an escape introducer would forge
 * a second line inside a message an orchestrator acts on — and that message does not stop at a
 * human: `mesh_stop_worker` and `mesh_send_worker` return these strings as JSON to the
 * orchestrating MODEL, which reads every code point in them whether or not any of them render.
 *
 * THE CHARACTER RULE IS `displayText.flattenOneLine`, NOT THIS MODULE'S OWN. The first version of
 * this function open-coded a control-and-line-separator class — a fourth spelling of a rule the
 * codebase had just finished consolidating, and the weakest of the set: it kept every bidi control
 * (so U+202E RLO could reverse the rest of the detail line) and every zero-width invisible (so a
 * sentence written in tag characters could ride inside a quoted job id, invisible to the human and
 * perfectly legible to the model). Its comment said it lived here "because pool.ts may not import
 * it" — true of `server.ts`, which imports THIS module, and beside the point: `displayText` is a
 * leaf that imports nothing, and exists so that every one-line surface can share one rule. Read
 * that file for the class-by-class reasoning, including why emoji survive it intact.
 *
 * THE LENGTH POLICY STAYS LOCAL, because it legitimately differs from every other caller's: 80
 * characters and a `…`, sized for a value quoted mid-sentence rather than for a header line. The
 * cut goes through `sliceOneLine` rather than `String.slice` — a raw slice at a fixed count can
 * land between the halves of a surrogate pair, and a value whose 80th and 81st code units were the
 * two halves of one emoji came out of the old code ILL-FORMED, into JSON an orchestrator parses.
 */
function errorValue(value: string): string {
  const flat = flattenOneLine(value);
  return flat.length > ERROR_VALUE_MAX_CHARS
    ? `${sliceOneLine(flat, ERROR_VALUE_MAX_CHARS)}\u2026`
    : flat;
}

/**
 * How one candidate record is named back to a caller that has to choose between several. The
 * job id is what it leads with, because that is the key the caller must come back with.
 */
function describeCandidate(rec: MeshWorkerRecord): string {
  const job = rec.jobId === '' ? 'no job id recorded' : `job ${errorValue(rec.jobId)}`;
  return `${job}${rec.stoppedAt === undefined ? '' : ' (already marked stopped)'}`;
}

/**
 * Why a ledger record is left alone: the directory it names is not a Claude Code account of
 * this installation. A clause that follows "worker X …" or "its …", for an error detail and
 * for WorkerSessionStatus's `unknown` reason alike, so the two surfaces say the same thing.
 *
 * It names the ACCOUNT LABEL the record carries and the directory, both projected for one
 * line: the label is what an operator recognizes ("that is my Codex worker", "I removed that
 * account"), and the directory is the fact the decision was made on.
 */
function notClaudeAccountReason(record: MeshWorkerRecord): string {
  return (
    `its record names the config dir ${errorValue(record.configDir)} (account ` +
    `"${errorValue(record.account)}"), which is not a Claude Code account of this installation ` +
    '— neither the dir this session runs under nor a registered Claude Code worker — so no ' +
    '`claude` command is aimed at it and its session registry is not read'
  );
}

/**
 * MeshWorkerStatus.attachCommand for a record whose dir is not a Claude Code account. The
 * field is a string by contract and is printed after `attach:`, so it reads as the answer to
 * "how do I attach" — there is no command, and why. Plain ASCII, single spaces, no shell
 * syntax: it must survive a one-line renderer unchanged and can never be mistaken for a
 * command to paste.
 */
const NO_ATTACH_COMMAND =
  '(none: the config dir this record names is not a Claude Code account of this ' +
  'installation, so no claude command is offered for it)';

/** A job id that can be printed inside a command a person is invited to type. */
const PRINTABLE_JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What is left to do about a worker nothing here can stop: the one sentence that says it may
 * be running and how a person ends it. A clause, no capital and no full stop, so it follows a
 * reason.
 *
 * The command is the bare `claude stop <job>` with "under that account" in words, never a
 * line with the record's dir spliced in: the dir is the very thing that could not be vouched
 * for, and a ready-made `CLAUDE_CONFIG_DIR=<that dir> claude …` is the command this module
 * refuses to run, handed to somebody else to run (NO_ATTACH_COMMAND). The job id is printed
 * only in the shape the platform mints — it is a ledger value going into a command — and is
 * otherwise named instead of quoted.
 */
export function manualStopAdvice(record: { jobId?: unknown }): string {
  const job = typeof record.jobId === 'string' && PRINTABLE_JOB_ID_RE.test(record.jobId) ? record.jobId : undefined;
  return (
    'it may still be running; stop it with ' +
    (job === undefined ? '`claude stop` and its job id' : `\`claude stop ${job}\``) +
    ' under that account'
  );
}

/**
 * How a record READS when its account cannot be checked — its config dir is not a Claude Code
 * account of this installation, so its session registry is not opened and no command is aimed
 * at it (WorkerPool.locate). The state of such a record is UNKNOWN on every surface that shows
 * one, and this is the sentence that goes with the word.
 *
 * Never "dead", "gone" or "stopped": nobody looked. The worker was started under an account
 * that existed then; whether its session is still running is exactly what cannot be found out
 * from here, and it holds its slot and its task stays open until a clock or a person says
 * otherwise.
 */
export function uncheckedAccountReading(record: { jobId?: unknown }): string {
  return `its account is not configured in this version — ${manualStopAdvice(record)}`;
}

/* ------------------------------------------------------------------------- *
 * Session status — what the platform's registry says about a worker, BY JOB ID
 * ------------------------------------------------------------------------- *
 * A `--bg` worker registers `<configDir>/sessions/<pid>.json` carrying its `jobId`, its
 * `pid` and a mechanical `status` (`busy` | `idle` | `waiting`). That entry, found by JOB
 * ID, is the one liveness source in this module: spawn records, the status the dispatch
 * loop polls, list(), stop() and adopt() all go through locateSession below.
 *
 * WHY NOT THE NAME. Until v2.0 the entry was looked up by the worker's NAME, and names are
 * reused across generations (nextSeq only counts names the ledger and the live dirs still
 * hold). A stale entry left by an earlier namesake then answered for the worker — a dead
 * one "proving" a healthy worker gone, or a live one "proving" a finished worker running,
 * which is how a stop killed the wrong generation. A job id is minted once per spawn.
 *
 * ABSENCE IS ONLY EVIDENCE FROM A DIRECTORY THAT WAS READ WHOLE. These directories hold
 * tens of thousands of leaked files on real machines, so the scan is bounded
 * (scanSessionsForLiveness — built so that it still FINDS a running worker there) — and a
 * scan that did not read everything says nothing about whether a worker it did not return
 * exists. Every lookup therefore carries `complete`, and "not found" in an incomplete scan
 * is UNKNOWN, never gone.
 * ------------------------------------------------------------------------- */

/** A job id that may be compared by PREFIX: at least 8 hex, optionally the rest of a session UUID. */
const HEX_JOB_ID_RE = /^[0-9a-f]{8}[0-9a-f-]*$/;

/**
 * Is `entry` the session-registry entry of background job `jobId`?
 *
 * Equality of the entry's own `jobId` is the rule. The two tolerances exist because a job
 * id is the leading hex of the session UUID and the two sides can legitimately hold
 * different amounts of it: a longer/shorter prefix of the SAME id still matches, and an
 * entry that states no job id at all is matched through its `sessionId`. Both apply only
 * to a well-formed hex id (so a hand-written '' or 'x' can never prefix-match anything),
 * and an entry whose own job id DISAGREES is a different session whatever its sessionId
 * says. The residual errs toward "this is the worker", which is the direction that cannot
 * declare a running worker dead.
 */
function entryIsJob(entry: SessionEntry, jobId: string): boolean {
  if (jobId === '') {
    return false; // adopt() writes '' for an entry that carried none — a value many records share
  }
  const own = typeof entry.jobId === 'string' ? entry.jobId : '';
  if (own === jobId) {
    return true;
  }
  if (!HEX_JOB_ID_RE.test(jobId)) {
    return false;
  }
  if (own !== '') {
    return HEX_JOB_ID_RE.test(own) && (own.startsWith(jobId) || jobId.startsWith(own));
  }
  return typeof entry.sessionId === 'string' && entry.sessionId.startsWith(jobId);
}

/** One sessions dir as a single liveness scan saw it. */
interface SessionDirScan {
  /** The entries read (see scanSessionsForLiveness for WHICH files a scan opens). */
  entries: SessionEntry[];
  /** false when the scan could not rule out a session entry it did not return. */
  complete: boolean;
}

/**
 * How many directory NAMES one liveness scan will look at. Looking at a name is a readdir
 * step and, at most, one `kill(pid, 0)` — no file is opened — so this bound can sit far
 * above DIR_SCAN_MAX_ENTRIES (which bounds a scan that opens every file) and still be a
 * fraction of a second. It exists so a directory somebody floods cannot hold the caller.
 */
const LIVENESS_SCAN_MAX_NAMES = 500_000;

/**
 * How many entry FILES one liveness scan will open. A real account has a handful of running
 * sessions, so in a healthy directory this is simply "all of them"; in a littered one the
 * allowance absorbs dead sessions' files whose pid the OS has since handed to an unrelated
 * process, and files not named for a pid at all.
 */
const LIVENESS_SCAN_MAX_READS = 2_000;

/** `<pid>.json` — how Claude Code names a session's registry entry. */
const PID_ENTRY_NAME_RE = /^(\d{1,10})\.json$/;

/** Could this entry file describe a RUNNING session? Only a `<pid>.json` of a dead pid cannot. */
function couldBeRunningEntry(name: string): boolean {
  const pidNamed = PID_ENTRY_NAME_RE.exec(name);
  return pidNamed === null || isPidAlive(Number(pidNamed[1]));
}

/**
 * Scan one account's sessions dir for a liveness lookup.
 *
 * WHY THIS IS NOT readSessionEntries. That function opens every `.json` under the generic
 * scan cap, which is right for a caller that needs every entry — and useless for liveness on
 * the machines this runs on: an account's sessions dir can hold tens of thousands of entry
 * files leaked by killed probe sessions, far past the cap. A capped read-everything scan
 * there is slow (measured: 1.5s over 76,000 files) and comes back truncated having seen
 * whichever slice the filesystem listed first — so a RUNNING worker's entry is found or
 * missed by luck, and the dispatch that depends on its status never learns it parked.
 *
 * TWO REGIMES, and the first is the ordinary one:
 *   - the directory holds no more `.json` files than one scan opens → EVERY one is read.
 *     Nothing is inferred from a file's name, and `complete` means the whole directory was
 *     seen, exactly as it does for readSessionEntries.
 *   - it holds more → only the files that COULD describe a running session are read: an
 *     entry is named `<pid>.json` for the process it describes, so one named for a dead pid
 *     is skipped unopened, and what is left is the running sessions' entries (plus recycled
 *     pids and names that are not a pid, which are opened and judged like any other). That
 *     finds a live worker in a directory the generic scan cannot get through.
 *     The result is reported INCOMPLETE all the same: files were skipped on the strength of
 *     a naming convention, and that is enough to FIND a session but not to prove one absent
 *     — "not in `entries`" stays UNKNOWN, never gone.
 *
 * `complete` is also false when the directory could not be opened or listed to the end, a
 * bound above was hit, or a file's bytes could not be read. An absent directory is a
 * complete, empty answer.
 */
function scanSessionsForLiveness(dir: string): SessionDirScan {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir, { bufferSize: 1024 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { entries: [], complete: code === 'ENOENT' || code === 'ENOTDIR' };
  }
  let complete = true;
  let names = 0;
  /** The `.json` files to open: all of them, until there are too many to open (`selective`). */
  let toRead: string[] = [];
  let selective = false;
  try {
    for (;;) {
      let ent;
      try {
        ent = handle.readSync();
      } catch {
        complete = false; // the listing died part way: what follows is unseen
        break;
      }
      if (!ent) {
        break;
      }
      if (++names > LIVENESS_SCAN_MAX_NAMES) {
        complete = false;
        break;
      }
      const name = ent.name;
      if (!name.endsWith('.json')) {
        continue;
      }
      if (!selective) {
        toRead.push(name);
        if (toRead.length > LIVENESS_SCAN_MAX_READS) {
          selective = true;
          complete = false; // from here on files are skipped by name — see the header
          toRead = toRead.filter(couldBeRunningEntry);
        }
        continue;
      }
      if (toRead.length < LIVENESS_SCAN_MAX_READS && couldBeRunningEntry(name)) {
        toRead.push(name);
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // already closed
    }
  }
  const entries: SessionEntry[] = [];
  for (const name of toRead) {
    const read = readTextSafe(path.join(dir, name), SESSION_ENTRY_MAX_BYTES, SESSION_ENTRY_READ);
    if (!read.ok) {
      // 'absent' = it vanished between the listing and the read: a session that ended.
      if (read.reason !== 'absent') {
        complete = false;
      }
      continue;
    }
    try {
      const entry = parseSessionEntry(JSON.parse(read.text));
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // read whole and not an entry (a zero-byte leak, a torn write): positively not one
    }
  }
  return { entries, complete };
}

/** Scans a sessions dir at most once per scanner: one list() never scans a dir twice. */
type SessionDirScanner = (dir: string) => SessionDirScan;

function createSessionDirScanner(): SessionDirScanner {
  const scans = new Map<string, SessionDirScan>();
  return (dir) => {
    let hit = scans.get(dir);
    if (hit === undefined) {
      hit = scanSessionsForLiveness(dir);
      scans.set(dir, hit);
    }
    return hit;
  };
}

/**
 * `<dir>/<pid>.json`, read directly — the O(1) path that keeps a status check from scanning
 * a directory of tens of thousands of files. `problem` is true when a file IS there and its
 * bytes could not be read (so "not this worker's entry" was not established).
 */
function readSessionEntryFile(dir: string, pid: number): { entry?: SessionEntry; problem: boolean } {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { problem: false };
  }
  const read = readTextSafe(path.join(dir, `${pid}.json`), SESSION_ENTRY_MAX_BYTES, SESSION_ENTRY_READ);
  if (!read.ok) {
    return { problem: read.reason !== 'absent' };
  }
  try {
    return { entry: parseSessionEntry(JSON.parse(read.text)), problem: false };
  } catch {
    return { problem: false }; // read whole and not an entry: positively not this worker's
  }
}

/** What looking for ONE worker's session entry produced. */
interface LocatedSession {
  /** The entry proven to be this worker's. When several are, one with a running process wins. */
  entry?: SessionEntry;
  /** `entry` exists and its process is running. */
  alive: boolean;
  /**
   * false when the answer rests on a directory that could not be read whole (or on an
   * ambiguity): no entry / a dead entry then proves nothing, and nothing destructive or
   * terminal may be concluded from it.
   */
  complete: boolean;
  /** Set when a record with NO job id matched several unkeyed entries by name (legacy only). */
  ambiguous?: number;
  /**
   * Set when NOTHING WAS READ, with the reason as a clause that follows "worker X …": the
   * record's config dir is not a Claude Code account of this installation, so its `sessions/`
   * is not a Claude session registry this module may open (WorkerPool.locate). Always with
   * `complete: false` — a directory nobody looked into proves nothing about a worker.
   */
  unchecked?: string;
}

/** The newer of two entries by `updatedAt` (an entry without one is older than one with). */
function fresherEntry(a: SessionEntry, b: SessionEntry): SessionEntry {
  const at = typeof a.updatedAt === 'number' && Number.isFinite(a.updatedAt) ? a.updatedAt : -Infinity;
  const bt = typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : -Infinity;
  return bt > at ? b : a;
}

/**
 * Is the process a session entry names RUNNING AS THAT SESSION? Asked of an entry already
 * proven to be the worker's own (by job id).
 *
 * The plain answer is `isPidAlive(entry.pid)`, and it is the default. It is wrong in one
 * direction: an entry outlives a session that was killed, the OS hands the pid on, and from
 * then on the entry reads as a running worker for as long as the stranger lives — `busy`
 * until the dispatch's deadline. WorkerPool passes a stricter answer (entryRunsWorker).
 */
type EntryRuns = (entry: SessionEntry) => boolean;

const entryPidAlive: EntryRuns = (entry) => isPidAlive(entry.pid);

/**
 * Find the session entry of job `jobId` in one account's sessions dir.
 *
 * `pidHints` are tried FIRST, each as a direct read of `<pid>.json` whose job id is then
 * VERIFIED — a pid is where to look, never proof (the OS recycles pids, and a recycled one
 * can only ever name some other session's entry, which fails the job-id check). A verified
 * hit with a running process is final. Anything else falls back to ONE bounded scan
 * (scanSessionsForLiveness): the session may have re-registered under a new pid, and a dead
 * hit must not hide a live entry.
 *
 * `runs` decides "a running process" for an entry that passed the job-id check (EntryRuns).
 *
 * Bridge mirrors are never candidates: a mirror is a copy of another account's entry, and
 * this lookup is always aimed at the worker's own account.
 */
function locateSession(
  dir: string,
  jobId: string,
  pidHints: number[],
  scanDir: SessionDirScanner,
  runs: EntryRuns = entryPidAlive,
): LocatedSession {
  let dead: SessionEntry | undefined;
  for (const pid of pidHints) {
    const { entry } = readSessionEntryFile(dir, pid);
    if (entry === undefined || entry.ccoMirror === true || !entryIsJob(entry, jobId)) {
      continue;
    }
    if (runs(entry)) {
      return { entry, alive: true, complete: true };
    }
    dead = dead ?? entry;
  }
  const scan = scanDir(dir);
  let live: SessionEntry | undefined;
  for (const entry of scan.entries) {
    if (entry.ccoMirror === true || !entryIsJob(entry, jobId)) {
      continue;
    }
    if (runs(entry)) {
      live = live === undefined ? entry : fresherEntry(live, entry);
    } else {
      dead = dead ?? entry;
    }
  }
  if (live !== undefined) {
    return { entry: live, alive: true, complete: true };
  }
  return { entry: dead, alive: false, complete: scan.complete };
}

/**
 * The session entry of one LEDGER RECORD.
 *
 * A record with a job id is located by it and by nothing else. A record WITHOUT one —
 * only `adopt()` writes those, for an entry that itself carried no job id — has no key but
 * its name, so it keeps the one narrow rule the pre-job-id code had: among REAL entries
 * that carry its name and state no job id of their own, a SINGLE one is this record's. An
 * entry that does state a job id belongs to whichever record holds that id, never to this
 * one; and several unkeyed namesakes cannot be told apart, so none is chosen — when one of
 * them is running the result is reported incomplete, which blocks every destructive
 * conclusion (no convergence to stopped, no kill).
 */
function locateRecordSession(
  record: MeshWorkerRecord,
  pidHints: number[],
  scanDir: SessionDirScanner,
  runs?: EntryRuns,
): LocatedSession {
  const dir = sessionsDir(record.configDir);
  if (record.jobId !== '') {
    return locateSession(dir, record.jobId, pidHints, scanDir, runs);
  }
  const scan = scanDir(dir);
  const unkeyed = scan.entries.filter(
    (e) => e.ccoMirror !== true && e.name === record.name && (typeof e.jobId !== 'string' || e.jobId === ''),
  );
  if (unkeyed.length === 1) {
    const alive = isPidAlive(unkeyed[0].pid);
    return { entry: unkeyed[0], alive, complete: alive || scan.complete };
  }
  if (unkeyed.length > 1 && unkeyed.some((e) => isPidAlive(e.pid))) {
    return { alive: false, complete: false, ambiguous: unkeyed.length };
  }
  return { alive: false, complete: scan.complete };
}

/** A session entry's `waitingFor`, one line and capped, or undefined when it says nothing. */
function waitingForText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const flat = flattenOneLine(value);
  return flat === '' ? undefined : sliceOneLine(flat, WAITING_FOR_MAX_CHARS);
}

/**
 * Map what a lookup found onto WorkerSessionStatus (contract).
 *
 *   running process, status busy            → busy
 *   running process, status idle | waiting  → parked (+ waitingFor)
 *   running process, any other / no status  → unknown — a state this build does not know is
 *                                             not evidence the turn ended
 *   an entry whose process is dead          → gone   (when the lookup was complete)
 *   no entry                                → gone   (when the lookup was complete AND the
 *                                             record is past ENTRY_APPEAR_GRACE_MS)
 *   no entry, record younger than the grace → unknown: `claude --bg` returns before the
 *                                             session registers, so absence is latency
 *   lookup incomplete, no running entry     → unknown
 *   nothing read (not a Claude account dir) → unknown, with the reason the lookup gave
 */
function sessionStatusFrom(located: LocatedSession, record: MeshWorkerRecord, now: number): WorkerSessionStatus {
  if (located.unchecked !== undefined) {
    return { kind: 'unknown', reason: located.unchecked };
  }
  const entry = located.entry;
  if (entry !== undefined && located.alive) {
    const status: unknown = entry.status;
    if (status === 'busy') {
      return { kind: 'busy' };
    }
    if (status === 'idle' || status === 'waiting') {
      const waitingFor = waitingForText(entry.waitingFor);
      return waitingFor === undefined ? { kind: 'parked' } : { kind: 'parked', waitingFor };
    }
    return {
      kind: 'unknown',
      reason:
        typeof status === 'string'
          ? `its session entry reports the status "${errorValue(status)}", which this build does not know`
          : 'its session entry reports no status',
    };
  }
  if (!located.complete) {
    return {
      kind: 'unknown',
      reason:
        located.ambiguous !== undefined
          ? `${located.ambiguous} session entries carry its name and none states a job id, ` +
            'so its own entry could not be identified'
          : entry !== undefined
            ? 'the only session entry found for it names a process that is gone, but its ' +
              "account's session registry could not be read completely, so a live entry " +
              'could not be ruled out'
            : "its account's session registry could not be read completely and no entry for " +
              'it was in the part that was',
    };
  }
  if (entry !== undefined) {
    return { kind: 'gone' };
  }
  if (now - record.spawnedAt < ENTRY_APPEAR_GRACE_MS) {
    return {
      kind: 'unknown',
      reason:
        `it was spawned less than ${Math.round(ENTRY_APPEAR_GRACE_MS / 1000)}s ago and has ` +
        'not registered a session yet',
    };
  }
  return { kind: 'gone' };
}

/**
 * MeshWorkerStatus.livenessUnknown for one record: undefined when the lookup ANSWERED — a
 * running process, or positive evidence that there is none (sessionStatusFrom's `gone`) — and
 * otherwise why it did not, as a clause that follows "worker X: …".
 *
 * This is what keeps `alive: false` from being read as "dead". The flag is false for a worker
 * proven gone and equally for one nobody could look at — a dir that is not a Claude Code
 * account, a session registry that could not be read whole, a worker spawned seconds ago that
 * has not registered yet — and only the first of those is a finding. A record already marked
 * stopped has none: its state is the mark.
 */
function livenessUnknownReading(located: LocatedSession, record: MeshWorkerRecord, now: number): string | undefined {
  if (located.alive || record.stoppedAt !== undefined) {
    return undefined;
  }
  if (located.unchecked !== undefined) {
    return uncheckedAccountReading(record);
  }
  const status = sessionStatusFrom(located, record, now);
  return status.kind === 'unknown' ? status.reason : undefined;
}

/** Chars of the CLI's own instruction quoted inside a workspace_untrusted detail. */
const UNTRUSTED_INSTRUCTION_MAX_CHARS = 300;

/**
 * The `--permission-mode` a session worker is STARTED in, and a note when that is not the
 * mode it was asked for (contract IWorkerPool, "PERMISSION MODE").
 *
 * bypassPermissions is never used for a session worker, for three independent reasons: a
 * bypass session is in a different cross-session permission class from a prompting
 * orchestrator, so the orchestrator's SendMessage to it is HELD for approval instead of
 * delivered — the worker could not be steered at all; `claude --bg` refuses to start in it
 * until a disclaimer has been accepted interactively; and with the no-Bash tool list these
 * workers run with, bypass would grant nothing acceptEdits does not.
 *
 * A value the CLI does not accept at all is normalized the same way the registry reader
 * does it (platform.normalizePermissionMode) and reported, rather than handed to the CLI to
 * fail the spawn on.
 */
function sessionWorkerMode(requested: unknown): { mode: string; note?: string } {
  const normalized = normalizePermissionMode(requested);
  if (normalized === 'bypassPermissions') {
    return {
      mode: 'acceptEdits',
      note:
        'permission mode downgraded to acceptEdits (session workers never run in ' +
        'bypassPermissions: messages between a bypass session and a prompting orchestrator ' +
        'are held for approval, and `--bg` refuses it without an interactive disclaimer)',
    };
  }
  if (normalized !== requested) {
    return {
      mode: normalized,
      note: `permission mode ${normalized} used (the requested mode is not one the CLI accepts)`,
    };
  }
  return { mode: normalized };
}

/**
 * The CLI's own instruction out of a "Workspace not trusted" refusal, ready to follow a dash
 * in a one-line error detail. Observed form: `Workspace not trusted. Run \`claude\` in <dir>
 * once and accept the trust prompt, then retry.` — everything after the marker on that line
 * is quoted (flattened to one line and capped; it is the CLI's text, not ours), with the
 * trailing full stop dropped so the caller's own punctuation reads right.
 *
 * The CLI's sentence does not say WHICH account to run `claude` as, and for a worker
 * account that is the whole difficulty — a plain `claude` trusts the workspace for the
 * user's default account. So the exact command for this account is appended.
 */
function untrustedInstruction(output: string, configDir: string): string {
  const at = output.indexOf(WORKSPACE_NOT_TRUSTED_MARKER);
  const rest = at === -1 ? '' : output.slice(at + WORKSPACE_NOT_TRUSTED_MARKER.length);
  const line = rest.split(/\r?\n/, 1)[0] ?? '';
  let said = flattenOneLine(line)
    .replace(/^[\s.:—-]+/, '')
    .replace(/[\s.]+$/, '');
  if (said.length > UNTRUSTED_INSTRUCTION_MAX_CHARS) {
    said = `${sliceOneLine(said, UNTRUSTED_INSTRUCTION_MAX_CHARS)}…`;
  }
  if (said === '') {
    said = 'run `claude` in this workspace once and accept the trust prompt, then retry';
  }
  const prefix = claudeShellPrefix(configDir, shellQuote);
  return prefix === '' ? said : `${said} (to run it as that account: \`${prefix}claude\`)`;
}

export class WorkerPool implements IWorkerPool {
  private readonly claudePath: string;
  private readonly cwd: string;
  /** The HOST config dir: the orchestrator session's own account ('main'). */
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
  /**
   * job id → the pid its session entry was last seen under, with a RUNNING process. Only a
   * hint for the direct `<pid>.json` read (locateSession verifies the job id every time),
   * kept so a worker whose entry appeared after its spawn record was written costs one
   * directory scan in this process instead of one per status check. In memory only: a
   * status QUERY must not become a ledger write.
   */
  private readonly sessionPids = new Map<string, number>();
  /**
   * `<job id>:<pid>` of every session entry whose process this pool has SEEN running the
   * Claude Code CLI — what entryRunsWorker needs to tell "this pid was the worker and has
   * since gone to another process" from "this pid never looked like the CLI to us". In memory
   * only, and only ever added to: one short string per session a worker registered.
   */
  private readonly confirmedWorkerPids = new Set<string>();

  constructor(opts: { claudePath: string; cwd: string; mainConfigDir: string }) {
    this.claudePath = opts.claudePath;
    this.cwd = opts.cwd;
    this.mainConfigDir = opts.mainConfigDir;
  }

  /**
   * Spawn ONE attachable dispatch worker on the account the caller already chose, and
   * record it in the ledger before returning (contract IWorkerPool).
   *
   * The sequence number is computed fresh here — 1 + the highest seq already used for this
   * account's sanitized token across the state file AND every candidate account's live
   * session registry — so back-to-back spawns never collide on a name.
   *
   * ONE spawn, no retry. The permission mode is decided BEFORE it (sessionWorkerMode), so
   * the old "try bypassPermissions, read the disclaimer refusal, try again" round trip is
   * gone along with the reason for it.
   */
  async spawnDispatchWorker(opts: DispatchSpawnOpts): Promise<WorkerSpawnResult> {
    const candidates = this.buildCandidates(readRegistry());
    // THE SPAWN GATE. The caller chooses the account, but everything below treats
    // `opts.configDir` as a Claude config dir: its `sessions/` is scanned, its `.claude.json`
    // may be rewritten (prepareAccount) and `claude --bg` runs with CLAUDE_CONFIG_DIR naming
    // it — and that CLI creates its config files in whatever directory it is given. So the
    // dir has to be one of the candidates, i.e. a Claude Code account of this installation
    // as the registry stands NOW. A worker on another vendor's CLI (its dir is that vendor's
    // home) and an account removed since the caller looked are both refused here, before
    // anything is read or run. The detail names the account and NOT the directory: the
    // caller classifies a spawn failure's text, and a path is not something to classify.
    if (!claudeAccountDirCheck(candidates)(opts.configDir)) {
      return {
        ok: false,
        failedAt: 'gate',
        account: opts.account,
        model: opts.model,
        error: meshError(
          'spawn_failed',
          `${errorValue(opts.account)} is not a Claude Code account of this installation ` +
            '(its config dir is neither the one this session runs under nor a registered ' +
            "Claude Code worker's), so no session worker was started under it: a session " +
            'worker is a `claude --bg` session, and `claude` is never run against any other ' +
            'directory.',
        ),
      };
    }
    // The gate passed: from here on this process is one that started a session under this
    // dir, and it stays able to observe and stop that session whatever the registry says
    // later (spawnVettedDirs). Remembered before the spawn rather than after it, because a
    // spawn that fails half-way can still leave a session behind for the cleanup to stop.
    rememberSpawnVettedDir(opts.configDir);
    // Every candidate account's session dir feeds nextSeq (M6): with the state file lost
    // or corrupt, a worker name must still be globally unique per sanitized token, even
    // across two accounts whose names sanitize to the same token. The spawning account's
    // own dir is one of them — the gate above just established that.
    const seq = this.nextSeq(
      opts.account,
      candidates.map((c) => c.configDir),
    );
    const name = meshWorkerName(this.cwd, opts.account, seq);

    // Pre-seed the chosen account's `.claude.json` ONCE (memoized) before spawning, so the
    // `--bg` worker boots without halting on the project's MCP-trust prompt.
    // Safe/idempotent/atomic, and a no-op for the home-level config — see prepareAccount.
    this.prepareAccount(opts.configDir);

    // A10: the io dir is OUTSIDE the checkout, so it must be granted explicitly with
    // --add-dir. The runner has already created it (it wrote the task file there) — this
    // is belt and braces for the case where it has not, because --add-dir on a path that
    // does not exist is a spawn we would rather not risk.
    //
    // F2: the grant names THIS TASK's own subdirectory, never the shared workspace io root.
    // With the flat layout every concurrent worker held write access to every sibling's
    // result file, so one confused or hostile worker could settle another task's dispatch
    // with a forged report. A per-task grant keeps a sibling out of this directory, and the
    // runner accepts a result only from a writer that knew this task's token, which rests in
    // this directory's task file — so the directory is created for this user alone
    // (contract.ensureBgIoTaskDir, the one place an io directory is made).
    const ioDir = bgIoTaskDir(this.cwd, opts.taskId);
    try {
      ensureBgIoTaskDir(this.cwd, opts.taskId);
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

    const mode = sessionWorkerMode(opts.permissionMode);
    // ARGV ORDER IS LOAD-BEARING: --allowedTools is a VARIADIC option ("comma or
    // space-separated list"), so a positional placed right after its value is swallowed
    // into the tool list. That exact footgun shipped once: the prompt vanished and workers
    // booted promptless. A bounded option pair (--name) must sit between --allowedTools
    // and the positional prompt.
    const args = [
      '--bg',
      '--model',
      opts.model,
      '--permission-mode',
      mode.mode,
      // Every pair below is a bounded option PAIR placed BEFORE --allowedTools on purpose:
      // the variadic-swallowing footgun only threatens whatever follows the tool list, so
      // nothing but the --name pair may sit between it and the prompt.
      '--add-dir',
      ioDir,
      // --settings rides with -w and ONLY with it: without `worktree.baseRef: "head"` the
      // platform branches a `-w` worktree from the REMOTE DEFAULT BRANCH, and the worker
      // would not see a single commit of the branch the orchestrator is actually on.
      ...(worktree ? ['-w', worktree.name, '--settings', SESSION_WORKER_SETTINGS_JSON] : []),
      // NO Bash. These workers never run in bypassPermissions (sessionWorkerMode), and the
      // prompting modes do not auto-approve a shell: a worker with Bash in its tool list
      // blocks on the first shell permission prompt it can never display. This matches the
      // standing project rule that workers author files and the orchestrator runs
      // builds/tests/shell.
      '--allowedTools',
      'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep',
      '--name',
      name,
      opts.prompt,
    ];
    const outcome = await runMeshProcess(
      this.claudePath,
      args,
      this.cwd,
      { ...claudeEnv(opts.configDir), ...(opts.extraEnv ?? {}) },
      SPAWN_TIMEOUT_MS,
    );
    const jobId = JOB_ID_RE.exec(outcome.output)?.[1];
    // Success requires BOTH a parsed job id AND a clean exit-0 within the window; a
    // hang, an error, or a non-zero exit is a spawn failure with the output for triage.
    // The caller decides whether that failure is a quota error worth failing over.
    if (outcome.timedOut || outcome.spawnError || outcome.code !== 0 || !jobId) {
      // The one failure with its own code: the ACCOUNT has not trusted this workspace root,
      // which the CLI checks before it starts anything. It is not a broken account — the
      // caller runs this task as a one-shot on the same account instead — so the detail is
      // written to be shown as-is: it names the account and carries the CLI's own
      // instruction. Nothing started, so there is no stranded session to look for.
      if (
        !outcome.timedOut &&
        !outcome.spawnError &&
        outcome.code !== 0 &&
        outcome.output.includes(WORKSPACE_NOT_TRUSTED_MARKER)
      ) {
        return {
          ok: false,
          failedAt: 'launch',
          name,
          account: opts.account,
          model: opts.model,
          error: meshError(
            'workspace_untrusted',
            `${errorValue(opts.account)} has not trusted this workspace for background sessions — ` +
              untrustedInstruction(outcome.output, opts.configDir),
          ),
        };
      }
      // F9: the launcher failing does NOT prove no session started. `claude --bg` registers
      // the job before it prints the line we parse, so a launcher killed (or timed out)
      // after registration leaves a LIVE session that no ledger row names — invisible to
      // mesh_status, to the reaper and to the cap, forever. The name is minted here and is
      // unique per workspace+account+seq, so an entry carrying it can only be the session
      // this failed spawn started. Bounded and best-effort.
      const strandedNote = await this.stopStrandedSession(name, opts.configDir);
      // `cliOutput` is what the CLI printed and NOTHING of ours: the caller reads a quota
      // verdict out of it, and the error text around it carries a worker name built from the
      // account's own name and a note that can quote a pid.
      const cliOutput = tail(outcome.output);
      return {
        ok: false,
        failedAt: 'launch',
        cliOutput,
        name,
        account: opts.account,
        model: opts.model,
        error: meshError(
          'spawn_failed',
          `worker ${name}: ${describeProcFailure(outcome)}. output: ${cliOutput}` +
            (strandedNote ? ` [${strandedNote}]` : ''),
        ),
      };
    }
    // Record the pid from the fresh session-registry entry when it already exists — found
    // by the JOB ID the CLI just printed, never by name. `--bg` returns before the entry is
    // guaranteed written, so a missing pid is the common case and is tolerated (the first
    // status check finds the entry and remembers where).
    const located = locateSession(sessionsDir(opts.configDir), jobId, [], createSessionDirScanner());
    const now = Date.now();
    // Validated by VALUE: the field decides when a cap slot frees and when a cross-session
    // sweep may call the dispatch overdue, so a NaN from an untyped caller is recorded as
    // "no deadline" (the 8h fallback) rather than as a number that compares false to everything.
    const deadlineAt =
      typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : undefined;
    const record: MeshWorkerRecord = {
      name,
      account: opts.account,
      configDir: opts.configDir,
      jobId,
      pid: located.entry?.pid,
      model: opts.model,
      role: 'dispatch',
      spawnedAt: now,
      taskId: opts.taskId,
      ownerPid: opts.ownerPid,
      ownerStartedAt: opts.ownerStartedAt,
      // "Spawned at", written once (contract MeshWorkerRecord). Nothing updates it.
      lastActivityAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      permissionMode: mode.mode,
      // Recorded even though it is derivable from the task id: the ledger is what the
      // reaper, the UI and mesh_status read, and a worktree holding unmerged work must be
      // findable from the record alone, long after this process is gone.
      ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
    };
    // THE RECORD IS PART OF THE SPAWN, not bookkeeping after it (hard rule 3 of this module):
    // everything that will ever find this session again — the cap, a stop by name, the
    // dispatch's own liveness reads, the reaper once this process is gone — starts from the
    // ledger. So this is the one ledger write whose failure DECIDES A DISPATCH'S OUTCOME, and
    // the one that is not caught-and-carried-on-from. The write is tried again (writeDurably);
    // if the ledger still cannot take it — its write lock held by a process that is stuck, its
    // file unreadable, its directory unwritable, the write itself refused — the session is
    // stopped again and this spawn FAILS. A spawn that returned ok over a missing record
    // would be a session nothing can stop: `stop` would answer "no such worker" for a worker
    // that is running.
    //
    // The ledger's reason rides in the error WHOLE. For a held lock that is registry.ts's own
    // message, written for the person who has to act on it: it names the process holding the
    // lock and the lock file, and says when deleting that file is safe.
    //
    // The mutator appends only when the record is not already there: a write that is
    // re-applied (mutateMeshWorkers) must not list one worker twice.
    let unrecorded: string | undefined;
    try {
      const wrote = await this.writeDurably((workers) => {
        if (!workers.some((r) => isSameWorkerRecord(r, record))) {
          workers.push(record);
        }
      });
      unrecorded = wrote.written ? undefined : (wrote.skipped ?? 'the ledger write did not happen.');
      // "Written, but contested" is the one outcome that does not say whether the record is
      // still in the file (its lock was taken away mid-write and re-applying did not settle
      // it). For any other write that is a note; for THIS one the question has to be answered,
      // and it can be: look. A record that is not there — or a ledger that cannot be read to
      // find out — is an unrecorded worker like any other.
      if (wrote.written && wrote.contested !== undefined && !this.readWorkers().some((r) => isSameWorkerRecord(r, record))) {
        unrecorded = wrote.contested;
      }
    } catch (err) {
      unrecorded = (err as Error)?.message ?? 'the ledger write failed.';
    }
    if (unrecorded !== undefined) {
      const undone = await this.stopUnrecordedSession(record);
      return {
        ok: false,
        failedAt: 'record',
        name,
        account: opts.account,
        model: opts.model,
        error: meshError(
          'spawn_failed',
          `worker ${name} was started but could not be recorded in this workspace's mesh ` +
            `ledger, and a session worker the ledger does not record is one nothing could find ` +
            `or stop later — so ${undone}. Why it could not be recorded: ${unrecorded}`,
        ),
      };
    }
    if (located.entry !== undefined && located.alive) {
      this.sessionPids.set(jobId, located.entry.pid);
    }
    return {
      ok: true,
      name,
      jobId,
      account: opts.account,
      model: opts.model,
      ...(mode.note ? { note: mode.note } : {}),
      ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
    };
  }

  /**
   * How many session workers of this workspace still have a dispatch IN FLIGHT — the number
   * the meshMaxLiveWorkers cap is compared against (contract IWorkerPool).
   *
   * LEDGER ARITHMETIC ONLY, and each omission is deliberate:
   *   - no pid or session read. `claude --bg` returns before the session registers, so a
   *     batch counted by live entries would see every slot free and overshoot the cap; and
   *     a count that reads tens of thousands of session files has no place inside the
   *     serialized spawn section;
   *   - no owner filter. The cap bounds what this WORKSPACE holds, whichever session
   *     dispatched it.
   * A record stops counting when it is stopped, when its dispatch SETTLES (markSettled — a
   * parked worker is attachable but holds no slot), or when its clock runs out: five
   * minutes past its recorded deadline, or eight hours after spawn for a record that has
   * none. That last clause is what keeps a record left behind by a crashed session from
   * holding a slot forever — every record expires by the clock, whatever else happens.
   *
   * Two guards keep that last sentence true of a ledger somebody edited by hand, and neither
   * changes the count for a record the dispatcher wrote: the deadline is capped at spawn +
   * 8h (the longest timeout a dispatch can have — a real deadline is never later), and a
   * record dated in the FUTURE beyond a clock-step allowance is not counted at all (it
   * would otherwise still be "younger than 8h" at every later moment, for ever).
   */
  inFlightCount(now?: number): number {
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    let inFlight = 0;
    for (const rec of this.readWorkers()) {
      if (rec.stoppedAt !== undefined || rec.settledAt !== undefined) {
        continue;
      }
      if (rec.spawnedAt - at > INFLIGHT_DEADLINE_GRACE_MS) {
        continue; // not a dispatch that can be in flight now, whatever else it says
      }
      const fallbackHorizon = rec.spawnedAt + FALLBACK_INFLIGHT_MS;
      const horizon =
        rec.deadlineAt === undefined
          ? fallbackHorizon
          : Math.min(rec.deadlineAt, fallbackHorizon) + INFLIGHT_DEADLINE_GRACE_MS;
      if (at < horizon) {
        inFlight++;
      }
    }
    return inFlight;
  }

  /**
   * Record that the dispatch owning this worker reached a TERMINAL outcome: stamp
   * `settledAt` on the record with that job id. From then on the worker is parked — still
   * attachable, no longer in flight (inFlightCount).
   *
   * Never rejects and never throws: a settle must not fail because its bookkeeping did. The
   * write itself is synchronous and — unless the ledger could not take it — finished by the
   * time this returns, so a caller that dispatches again straight after a settle sees the freed
   * slot. An unknown job id is a no-op and creates no ledger. The FIRST stamp wins: a second
   * call does not move the time the dispatch actually settled.
   *
   * A write the ledger SKIPPED (its write lock held by another process for the whole wait, the
   * file unreadable) is tried once more after a short pause, off the caller's turn. If that is
   * skipped too the mark is lost — said in one line on stderr (logMeshProblem), since this
   * method answers nobody — and what that costs is bounded by the record itself: the worker
   * keeps counting against the in-flight cap until five minutes past its recorded deadline
   * (inFlightCount), and the status surfaces go on showing it as working until then or until it
   * is stopped.
   */
  async markSettled(target: { jobId: string }): Promise<void> {
    try {
      const jobId = target?.jobId;
      if (typeof jobId !== 'string' || jobId === '') {
        return;
      }
      // Checked first, because mutateMeshWorkers creates the state file when it is absent:
      // a settle naming a job this workspace never recorded must leave nothing behind.
      if (!this.readWorkers().some((r) => r.jobId === jobId && r.settledAt === undefined)) {
        return;
      }
      // Taken ONCE: a mark that lands on the second attempt still says when the dispatch
      // actually settled.
      const now = Date.now();
      // The first attempt is synchronous (an async function runs up to its first await in the
      // caller's own turn), which is what keeps the sentence above true. Only a SKIPPED write
      // is tried again, after a pause — nobody retries this mark from outside: the dispatch
      // path fires it once and does not look at the outcome.
      const wrote = await this.writeDurably((workers) => {
        for (const rec of workers) {
          if (rec.jobId === jobId && rec.settledAt === undefined) {
            rec.settledAt = now;
          }
        }
      });
      const unsaid = wrote.skipped ?? wrote.contested;
      if (unsaid !== undefined) {
        // Bookkeeping about a dispatch that is already over: said in one line, and the
        // settle stands. This method has nobody else to tell.
        logMeshProblem(
          `the settle mark for job ${jobId} ${wrote.written ? 'may not have lasted' : 'was not recorded'}, ` +
            `so its worker may count as in flight until its deadline passes — ${unsaid}`,
        );
      }
    } catch (err) {
      // best effort — the cost of a lost mark is a cap slot held until the record's clock
      // runs out (five minutes past its deadline), never a failed settle.
      logMeshProblem(`a settle mark was not recorded — ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  /**
   * What the platform's session registry says about ONE worker right now (contract
   * WorkerSessionStatus), found as: the ledger record with that job id → its config dir →
   * the entry carrying that job id. Never throws; everything that could not be established
   * is `unknown` with the reason.
   */
  sessionStatus(target: { jobId: string }): WorkerSessionStatus {
    try {
      const jobId = target?.jobId;
      if (typeof jobId !== 'string' || jobId === '') {
        return { kind: 'unknown', reason: 'no job id was given' };
      }
      const note: LedgerReadNote = {};
      const matches = readMeshWorkerRecords(this.cwd, note).filter((r) => r.jobId === jobId);
      if (note.unreadable !== undefined) {
        return { kind: 'unknown', reason: `this workspace's mesh ledger could not be read (${note.unreadable})` };
      }
      if (matches.length === 0) {
        // Without the record there is no account to look in. Not `gone`: that would be a
        // claim about a session, and all that is known is that a ledger row is missing.
        return {
          kind: 'unknown',
          reason: `no record with job id "${errorValue(jobId)}" is in this workspace's mesh ledger`,
        };
      }
      if (matches.some((r) => r.configDir !== matches[0].configDir)) {
        // A job id is minted once per spawn; two records carrying it under different
        // accounts is a hand-edited ledger, and picking one would aim the lookup by array order.
        return {
          kind: 'unknown',
          reason: `job id "${errorValue(jobId)}" is recorded under more than one account in this workspace's mesh ledger`,
        };
      }
      const record = matches[0];
      return sessionStatusFrom(this.locate(record, createSessionDirScanner()), record, Date.now());
    } catch (e) {
      const why = errorValue((e as Error)?.message ?? 'unknown error');
      return { kind: 'unknown', reason: `the session registry could not be read (${why})` };
    }
  }

  /**
   * Liveness of ONE worker for a caller that holds only its NAME (contract IWorkerPool).
   *
   * The name is used to pick a ledger RECORD and for nothing else: the single record of
   * that name not marked stopped, else the most recently spawned. Liveness is then that
   * record's JOB ID in its own account's session registry, exactly as sessionStatus reads
   * it. `entrySeen` is what separates "died" from "has not booted yet": false while no
   * entry has been found, true once one exists whether or not its process still runs.
   */
  workerLiveness(name: string): { entrySeen: boolean; alive: boolean; pid?: number } {
    try {
      const named = this.readWorkers().filter((r) => r.name === name);
      if (named.length === 0) {
        return { entrySeen: false, alive: false };
      }
      const live = named.filter((r) => r.stoppedAt === undefined);
      const record =
        live.length === 1 ? live[0] : named.reduce((a, b) => (b.spawnedAt > a.spawnedAt ? b : a));
      const located = this.locate(record, createSessionDirScanner());
      if (located.entry === undefined) {
        return { entrySeen: false, alive: false };
      }
      return { entrySeen: true, alive: located.alive, pid: located.entry.pid };
    } catch {
      return { entrySeen: false, alive: false };
    }
  }

  /**
   * Resolve a stop target to EXACTLY ONE ledger record of THIS workspace, or say why it cannot.
   *
   * THE DEFECT THIS CLOSES: stop() used to resolve with `readWorkers().find(r => r.name === name)`
   * — FIRST MATCH WINS — while worker names are reused across generations (see StopTargetKey). A
   * ledger holding a retained stopped record and a live worker of one name therefore let "stop the
   * finished one" kill the running one, decided by nothing but array order. mesh_status names every
   * worker by JOB ID for exactly this reason, and until now no tool accepted that key.
   *
   * AMBIGUITY IS REPORTED, NEVER BROKEN BY ORDER. One narrowing is allowed, and it is SEMANTIC
   * rather than positional: when a name matches several records, the ones already carrying
   * `stoppedAt` drop out of the candidate set, because a record marked stopped has no session left
   * for a stop to act on and every internal caller means the one that is still running (the
   * timeout, quota-stall and cancel paths mean the worker they just spawned). If that leaves
   * exactly one, it is the target and the
   * narrowing is REPORTED in the note rather than performed silently. Anything else — several live
   * namesakes, or only stopped ones — is an invalid_input naming every job id it matched, so the
   * caller can come back with the one it meant.
   *
   * THE WORKSPACE SCOPE IS THE READ ITSELF: candidates come from this.readWorkers(), which is this
   * workspace's ledger and nothing else, so no key of any kind can reach another workspace's worker.
   *
   * An EMPTY job id never matches anything: adopt() writes `jobId: ''` for a session entry that
   * carried none, so '' is a value many records share, and matching it would turn the one unique
   * key into the least unique one.
   */
  private resolveStopTarget(target: string, by: StopTargetKey): StopTargetResolution {
    const records = this.readWorkers();
    const quoted = errorValue(target);
    const byJobId = target === '' ? [] : records.filter((r) => r.jobId === target);
    if (by !== 'name') {
      if (byJobId.length > 1) {
        // Only a hand-edited or forged ledger can carry one job id twice (the CLI mints it per
        // spawn), and there is no ordering that makes picking one of them right.
        return {
          ok: false,
          error: meshError(
            'invalid_input',
            `job id "${quoted}" matches ${byJobId.length} records in this workspace's ledger, which ` +
              'cannot happen for a key minted once per spawn — the ledger is inconsistent and nothing ' +
              `was stopped. Records: ${byJobId.map((r) => errorValue(r.name)).join(', ')}.`,
          ),
        };
      }
      if (byJobId.length === 1) {
        // A value that is a job id HERE and a name THERE identifies nothing, and preferring either
        // key would silently stop a record the caller may not have meant — the class of bug this
        // resolver exists to remove. A minted name (`cco-w-<6hex>-<account>-<seq>`) can never be a
        // bare job id, so reaching this needs a hand-written ledger; it is reported, not guessed.
        const clash =
          by === 'either'
            ? records.filter((r) => r.name === target && !isSameWorkerRecord(r, byJobId[0]))
            : [];
        if (clash.length > 0) {
          return {
            ok: false,
            error: meshError(
              'invalid_input',
              `"${quoted}" is the job id of one record in this workspace and the NAME of ` +
                `${clash.length} other(s), so it does not identify a target and nothing was stopped. ` +
                `The records carrying it as a name: ${clash.map(describeCandidate).join('; ')}.`,
            ),
          };
        }
        return { ok: true, record: byJobId[0] };
      }
      if (by === 'jobId') {
        return {
          ok: false,
          error: meshError('unknown_worker', `no mesh worker with job id "${quoted}" in this workspace.`),
        };
      }
    }
    const named = records.filter((r) => r.name === target);
    if (named.length === 0) {
      return {
        ok: false,
        error: meshError(
          'unknown_worker',
          by === 'either'
            ? `no mesh worker with the name or job id "${quoted}" in this workspace.`
            : `no mesh worker named "${quoted}" in this workspace.`,
        ),
      };
    }
    if (named.length === 1) {
      return { ok: true, record: named[0] };
    }
    const live = named.filter((r) => r.stoppedAt === undefined);
    if (live.length === 1) {
      return {
        ok: true,
        record: live[0],
        note:
          `the name "${quoted}" matches ${named.length} ledger records, so this stop targeted ` +
          `${describeCandidate(live[0])} — the only one not already marked stopped`,
      };
    }
    return {
      ok: false,
      error: meshError(
        'invalid_input',
        `"${quoted}" matches ${named.length} worker records in this workspace ` +
          `(${named.map(describeCandidate).join('; ')}) and worker names are reused across ` +
          'generations, so it does not say which one to stop and nothing was stopped. Re-run with ' +
          'the JOB ID of the record you mean: it is unique per spawn and mesh_status prints it.',
      ),
    };
  }

  /**
   * Stop one worker: `claude stop <jobId>` under its OWN account, with a forced SIGKILL
   * fallback.
   *
   * `target` is a worker NAME by default (every internal caller has one and nothing else) and a
   * job id — the only key unique per spawn — when the caller says so with `by`. resolveStopTarget
   * has the full rule; the part that matters here is that a target which cannot be resolved to ONE
   * record fails loudly instead of acting on whichever record the ledger happened to list first.
   *
   * Every successful stop FINISHES with `claude rm <jobId>` (A11), so a worker's worktree
   * is cleaned up the moment it is clean and is otherwise KEPT and flagged. That is why
   * this is the single teardown door for every caller (mesh_stop_worker, the dispatch
   * timeout, the quota-stall path, the cancel hook): duplicating the
   * finisher at each call site is how one of them ends up forgetting it.
   *
   * The return type is widened past IWorkerPool's with an optional `note` (F3a) so a caller
   * holding the concrete pool can tell "we stopped it" from "it was already gone" — and now also
   * WHICH record a colliding name resolved to; through the interface the extra field is invisible.
   */
  async stop(
    target: string,
    opts?: { force?: boolean; by?: StopTargetKey },
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    const resolved = this.resolveStopTarget(target, opts?.by ?? 'name');
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const record = resolved.record;
    // Every success carries the resolution note forward: a caller whose name matched several
    // records is TOLD which one was acted on rather than left to assume there was only one.
    const settled = (note?: string): { ok: true; note?: string } => {
      const merged = [resolved.note, note].filter((n) => n !== undefined).join('; ');
      return { ok: true, ...(merged === '' ? {} : { note: merged }) };
    };
    // THE TARGET GATE, before any command. A record's `configDir` is DATA — written at spawn,
    // hand-editable since, and not re-validated when the registry changes — while every step
    // below aims something Claude-specific at it: `claude stop` and `claude rm` run with
    // CLAUDE_CONFIG_DIR naming it (and that CLI creates its config files wherever it is
    // pointed), and its `sessions/` is read as a Claude session registry. So it has to be a
    // dir this process itself started a session under, or a Claude Code account of this
    // installation as the registry stands now (claudeAccountCheck). One that is neither — the
    // record of an earlier process whose account has since been removed, an edited ledger, a
    // directory that today is another vendor's home — is refused untouched: nothing is run,
    // nothing is read, and above all the record is NOT marked stopped, because no stop was
    // performed and a mark with no stop behind it is a ghost in the making. The reason says
    // the stop was not attempted, which is a different fact from "it failed".
    const isClaudeAccount = this.claudeAccountCheck();
    if (!isClaudeAccount(record.configDir)) {
      return {
        ok: false,
        error: meshError(
          'capability_failed',
          `worker ${errorValue(record.name)} (${describeCandidate(record)}) was NOT stopped and ` +
            `nothing was attempted: ${notClaudeAccountReason(record)}. Its record is unchanged.`,
        ),
      };
    }
    // How a failure below names its target: every one of them is a coded `stop_failed` — a
    // stop that was attempted on a worker this workspace DOES record and that did not end its
    // session — so a caller can tell it from "no such worker" by the code alone.
    const who = `worker ${errorValue(record.name)} (${describeCandidate(record)})`;
    // Clean path: `claude stop <jobId>` under the worker's OWN account — the job id
    // is only meaningful to the config dir that spawned it.
    const outcome = await runMeshProcess(
      this.claudePath,
      ['stop', record.jobId],
      this.cwd,
      claudeEnv(record.configDir),
      MESH_STOP_TIMEOUT_MS,
    );
    if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
      // Marked BEFORE the removal: stoppedAt records that the session is down, and it must
      // land even if `claude rm` hangs out its whole timeout or fails outright.
      const unmarked = await this.markStopped(record);
      await this.finishTeardown(record);
      return settled(unmarked);
    }
    // F3a — CONVERGENCE. `claude stop` fails for a session that is already gone (the user
    // stopped it from a terminal, the CLI retired it, the machine restarted), and until this
    // branch existed nothing ever wrote stoppedAt for such a record: every later stop
    // re-ran the same doomed command, and mesh_status kept advertising a worker that does
    // not exist. A stop whose target is provably gone has ACHIEVED its
    // purpose, so it reports success and finishes the teardown like any other.
    //
    // "Provably gone" is deliberately stricter than `!alive`: a record younger than
    // ENTRY_APPEAR_GRACE_MS that has NEVER shown a session entry may simply still be booting
    // (`claude --bg` returns before its entry is written, and the cancel path stops workers
    // in exactly that window). Marking such a record stopped would hide a LIVE session from
    // the orphan reaper, which skips stopped records — a permanent leak, the one outcome
    // this whole module exists to prevent. In that window we fall through and report the
    // failure, and the caller retries.
    //
    // Liveness here is the record's own session entry, found by JOB ID (locate): the one
    // entry that IS this worker, whatever else in that directory shares its name. The bias
    // has to point one way — failing to mark costs the caller a retry, while marking a
    // record whose session is actually up hides a live worker from every sweep, which is
    // the leak — and it does:
    //   - a lookup that could not FINISH (`seen.complete` false: the sessions dir could not
    //     be listed, was cut short at the scan cap, or held an entry whose bytes could not
    //     be read) proves nothing by coming back empty, so it blocks the convergence exactly
    //     as a running entry does, and the caller retries;
    //   - a record still inside the boot grace with no entry is "not registered yet".
    const seen = this.locate(record, createSessionDirScanner(), isClaudeAccount);
    const stillBooting = seen.entry === undefined && Date.now() - record.spawnedAt < ENTRY_APPEAR_GRACE_MS;
    if (!seen.alive && !stillBooting && seen.complete) {
      const unmarked = await this.markStopped(record);
      await this.finishTeardown(record);
      return settled(['session was already gone', unmarked].filter((n) => n !== undefined).join('; '));
    }
    // Forced path: `claude stop` failed and the caller accepts a hard kill. Signal the pid the
    // worker's OWN session-registry entry advertises, after a FRESH read still shows it alive —
    // never a bare recorded pid the OS may have recycled.
    //
    // The entry must be PROVEN to be this record's — the job-id match locate performs — and
    // never merely one carrying the same name: names are reused, so a name match can be a
    // different generation's session, and killing that pid is the very outcome this module
    // exists to prevent. When no entry can be identified, nothing is killed and the reason
    // says so.
    if (opts?.force) {
      const fresh = this.locate(record, createSessionDirScanner(), isClaudeAccount);
      const entry = fresh.alive ? fresh.entry : undefined;
      if (entry && isPidAlive(entry.pid)) {
        // THE IDENTITY GATE, in the same turn as the signal (section note, "Process identity").
        // The entry is this record's by job id; the process holding its pid is checked here and
        // now, because the entry outlives a session that was killed and the pid does not stay
        // the worker's. Nothing is awaited between this test and the kill below.
        if (!entryPidIsWorker(entry, this.claudePath)) {
          return {
            ok: false,
            error: meshError(
              'stop_failed',
              `${who} — ${unconfirmedPidRefusal(entry.pid)}. claude stop failed ` +
                `(${describeProcFailure(outcome)}), and ${UNCONFIRMED_PID_WHY}, so nothing was ` +
                'signalled: a session that is killed leaves its entry behind, and the pid goes ' +
                'to another process. Its record is unchanged.',
            ),
          };
        }
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch (e) {
          return {
            ok: false,
            error: meshError(
              'stop_failed',
              `${who} was NOT stopped: claude stop failed (${describeProcFailure(outcome)}) and ` +
                `SIGKILL of pid ${entry.pid} failed (${errorValue((e as Error)?.message ?? 'unknown error')}). ` +
                'Its record is unchanged.',
            ),
          };
        }
        // Outside the try on purpose: the kill has happened, and nothing after it may turn
        // "killed" into "the kill failed".
        const unmarked = await this.markStopped(record);
        await this.finishTeardown(record);
        return settled(unmarked);
      }
      const job = record.jobId === '' ? '(none recorded)' : errorValue(record.jobId);
      const why =
        fresh.ambiguous !== undefined
          ? `${fresh.ambiguous} session-registry entries carry its name and none states a job id, ` +
            'so killing one by name alone could have killed a different worker generation'
          : !fresh.complete
            ? "its account's session registry could not be read completely, so no entry could be " +
              'ruled out and nothing was killed'
            : fresh.entry === undefined
              ? `no session-registry entry carries job id ${job}`
              : 'the entry it names is no longer running';
      return {
        ok: false,
        error: meshError(
          'stop_failed',
          `${who} was NOT stopped: claude stop failed (${describeProcFailure(outcome)}) and no ` +
            `live registry pid was found to kill: ${why}. Its record is unchanged.`,
        ),
      };
    }
    return {
      ok: false,
      error: meshError(
        'stop_failed',
        `${who} was NOT stopped: claude stop failed (${describeProcFailure(outcome)}), and no ` +
          'forced stop was asked for. Its record is unchanged; force:true falls back to killing ' +
          'the process when that fails.',
      ),
    };
  }

  /**
   * Every ledger record of this workspace with what the session registry says about it —
   * by job id, one directory scan per account at most for the whole call.
   */
  list(): MeshWorkerStatus[] {
    const cache = readUsageCache();
    const scanDir = createSessionDirScanner();
    // One registry read for the whole call, shared by every record's lookup.
    const isClaudeAccount = this.claudeAccountCheck();
    const now = Date.now();
    return this.readWorkers().map((rec) => {
      const located = this.locate(rec, scanDir, isClaudeAccount);
      const entry = located.entry;
      return {
        ...rec,
        alive: located.alive,
        livenessUnknown: livenessUnknownReading(located, rec, now),
        registryStatus: typeof entry?.status === 'string' ? entry.status : undefined,
        registryUpdatedAt:
          typeof entry?.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : undefined,
        accountExhausted: exhaustedWindows(cache[rec.configDir], now).length > 0,
        peerVisible: this.peerVisible(rec, located, now),
        // A command a human — or an orchestrating model — is invited to paste. For a record
        // whose dir is not a Claude Code account it would be `CLAUDE_CONFIG_DIR=<that dir>
        // claude attach …`: the very command this module refuses to run, handed to somebody
        // else to run. The field is a string by contract, so it carries the reason instead.
        attachCommand: isClaudeAccount(rec.configDir)
          ? claudeCommandFor(rec.configDir, `attach ${shellToken(rec.jobId)}`)
          : NO_ATTACH_COMMAND,
      };
    });
  }

  /**
   * Claim live workers of this workspace that the ledger does not track (a previous server
   * died before recording them, or the state file was lost).
   *
   * "Does not track" is decided by JOB ID: a live entry whose job id no record holds is
   * untracked even when an older record carries the same NAME — that is a different
   * generation, and skipping it by name would leave a running session nothing can find.
   * Only an entry that states no job id at all falls back to the name, because then the
   * name is the only key there is.
   *
   * The directories looked into are the CANDIDATES' — Claude Code accounts only
   * (buildCandidates). Another vendor's home is never opened here: a real `~/.codex` keeps a
   * `sessions/` of its own, and reading that as Claude's session registry could at worst
   * adopt something out of it, writing that vendor's dir into the ledger as a `claude` target.
   */
  adopt(): number {
    const registry = readRegistry();
    const tracked = this.readWorkers();
    const trackedNames = new Set(tracked.map((r) => r.name));
    const now = Date.now();
    const adopted: MeshWorkerRecord[] = [];
    for (const c of this.buildCandidates(registry)) {
      // The liveness scan, not the read-everything one: only RUNNING sessions are adoptable,
      // and it is the scan that still finds them in a directory full of dead sessions' files.
      // (The isPidAlive test below is not redundant with it: a small directory is read whole.)
      for (const e of scanSessionsForLiveness(sessionsDir(c.configDir)).entries) {
        // Adopt only REAL entries (skip bridge mirrors — their true account is
        // another config dir, and adopting one here would stop it under the wrong
        // account), whose name parses as ours for THIS workspace and whose process is
        // alive.
        if (e.ccoMirror === true || typeof e.name !== 'string') {
          continue;
        }
        if (!parseMeshWorkerName(e.name, this.cwd) || !isPidAlive(e.pid)) {
          continue;
        }
        const jobId = typeof e.jobId === 'string' ? e.jobId : '';
        const known =
          jobId !== ''
            ? [...tracked, ...adopted].some((r) => entryIsJob(e, r.jobId))
            : trackedNames.has(e.name);
        if (known) {
          continue;
        }
        trackedNames.add(e.name);
        adopted.push({
          name: e.name,
          account: c.name,
          configDir: c.configDir,
          jobId,
          pid: e.pid,
          model: '-',
          role: 'adopted',
          spawnedAt: typeof e.startedAt === 'number' && isFinite(e.startedAt) ? e.startedAt : now,
        });
      }
    }
    if (adopted.length === 0) {
      return 0;
    }
    // A skipped write adopted nothing: the count is of records that are in the ledger now.
    // Not retried — this runs inside server init, and an untracked worker is exactly what the
    // next init's adopt() looks for again. (Appended only where absent: the mutator may be run
    // twice — mutateMeshWorkers.)
    const wrote = this.mutateWorkers((workers) => {
      for (const rec of adopted) {
        if (!workers.some((r) => isSameWorkerRecord(r, rec))) {
          workers.push(rec);
        }
      }
    });
    const unsaid = wrote.skipped ?? wrote.contested;
    if (unsaid !== undefined) {
      logMeshProblem(
        `${adopted.length} running session worker(s) of this workspace that the ledger does not ` +
          `track ${wrote.written ? 'were adopted, but that may not have lasted' : 'could not be adopted'} — ${unsaid}`,
      );
    }
    return wrote.written ? adopted.length : 0;
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * Pre-seed one spawning account's `.claude.json` so a `claude --bg` worker boots
   * without halting on this project's MCP-trust prompt (contract applyProjectMcpTrust,
   * verified 2026-08-10). Runs once per account before any spawn on it.
   *
   * THE HOME-LEVEL CONFIG IS NEVER WRITTEN. Which file an account's config lives in is
   * platform.accountConfigFile's decision: `<configDir>/.claude.json` for an account the
   * child runs with CLAUDE_CONFIG_DIR set, and `~/.claude.json` — `homeLevel` — for the
   * default account, which runs with the variable ABSENT. That second file is the user's
   * primary Claude Code config, rewritten whole by every live session they have open; a
   * read-modify-write from outside the CLI can lose their updates, and no lock of ours
   * excludes the CLI. So for a home-level account this does NOTHING — no read, no lock
   * file, no temp file — and the spawn then either works (the user already trusted this
   * workspace) or is refused with the CLI's "Workspace not trusted" instruction, which
   * spawnDispatchWorker reports as `workspace_untrusted` for the caller to act on.
   *
   * For a dedicated worker account every step is still guarded so this can never corrupt
   * that account's config nor throw out of spawn:
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
   * LOST-UPDATE GUARD (H1). The account's `.claude.json` is ALSO written by every live
   * session running under that config dir (the CLI rewrites it on OAuth token refresh, and
   * session workers are exactly such sessions). The atomic tmp+rename above prevents a torn
   * READ but NOT a lost UPDATE: a CLI write landing between our read and our rename would
   * be clobbered — potentially dropping a freshly refreshed token and logging the account
   * out. So the whole read-modify-write runs under an exclusive `${configPath}.cco.lock`,
   * and the config is RE-READ inside the lock immediately before the write — we never
   * serialize a stale snapshot. If the lock cannot be taken we SKIP seeding this pass (not
   * memoized, so the next spawn retries): a worker that boot-blocks on the MCP-trust prompt
   * is visible, whereas a clobbered config is silent corruption.
   *
   * THAT LOCK IS registry.ts's (withPathLock), at the path this method has always used. It
   * was an exclusive create of an empty file that NOTHING EVER BROKE — "skipping is the safe
   * response to a stuck lock" — which made one crash inside these few lines permanent: the
   * file outlived the process, every later spawn under that account waited its two seconds
   * and skipped, and the account's workers boot-blocked on the trust prompt until somebody
   * found and deleted a file they had never heard of. The section is one synchronous
   * read-modify-write, so a function-scoped lock fits it exactly, and the registry lock
   * brings the one thing that was missing: a lock is cleared when its holder is PROVEN gone
   * (its pid no longer exists, is a zombie, or belongs to a process that started after the
   * lock was claimed) and never because it is old. What that changes here:
   *   - a lock left by a crash is cleared by the next spawn instead of standing for ever —
   *     including the EMPTY file an earlier build left: a regular file with no token in it is
   *     nobody's once it has sat there for two seconds (registry.ts,
   *     LOCK_UNSTAMPED_GRACE_MS). That same rule is the one mixed-version hazard: an earlier
   *     build still running in another window holds its lock AS such an empty file, so if it
   *     is frozen inside the section for more than two seconds this build takes the file for
   *     litter. Both then seed the same account; the worst outcome is one of the two trust
   *     edits replacing the other, and that account's next worker asking the trust question;
   *   - a lock held by a LIVE process is waited on for registry.ts's 15 s rather than the 2 s
   *     this method allowed, with this thread parked — on the spawn path. Reaching it takes
   *     another orchestrator frozen inside these same few lines; the result is the old one,
   *     later: this pass is skipped and the next spawn tries again.
   *
   * RESIDUAL, documented deliberately: this lock only excludes OTHER cooperating lock
   * users (another WorkerPool instance / this method). The CLI does NOT take it, so a
   * session can still write between our in-lock re-read and our rename. Re-reading
   * directly before the write shrinks that window to the few synchronous statements
   * between them; it cannot close it entirely — which is the reason the home-level file,
   * where the cost of losing that race is the user's own primary config, is not written
   * at all.
   */
  private prepareAccount(configDir: string): void {
    if (this.preparedConfigDirs.has(configDir)) {
      return;
    }
    try {
      const { file: configPath, homeLevel } = accountConfigFile(configDir);
      if (homeLevel) {
        // Nothing to do, now or later: memoized so the decision is not recomputed per spawn.
        this.preparedConfigDirs.add(configDir);
        return;
      }
      // Fast bail before taking a lock: a never-logged-in account has no config to seed,
      // and we must never CREATE one (re-checked under the lock below).
      if (!fs.existsSync(configPath)) {
        return;
      }
      // BEST-EFFORT BY POLICY: nothing here decides whether the spawn happens, so no way the
      // lock can fail changes that. withPathLock throws when the lock could not be created
      // (permissions) or stayed held for its whole wait — the section did not run, and this
      // pass is skipped, not memoized, so a later spawn tries again — and it throws AFTER the
      // section returned when the lock was no longer ours at release. That last one means the
      // write may not have lasted (whoever took the lock may have put an older copy of the
      // config back), and the section is idempotent, so it is run ONCE more: it re-reads the
      // config and writes only if the decision is not in it.
      const lockPath = `${configPath}.cco.lock`;
      for (let pass = 0; pass < 2; pass++) {
        let finished = false;
        try {
          const seeded = withPathLock(lockPath, () => {
            const holds = this.seedAccountConfig(configPath);
            finished = true;
            return holds;
          });
          if (seeded) {
            this.preparedConfigDirs.add(configDir);
          }
          return;
        } catch (err) {
          if (!finished) {
            // The lock was not taken, or the section itself failed: skip this pass. Said in one
            // line, because the spawn that follows cannot say it — a worker that is then
            // refused as untrusted names the trust prompt, not the lock that kept this from
            // answering it — and a held lock costs every later spawn the same wait.
            logMeshProblem(
              `this workspace's trust decision was not pre-seeded for the account at ${configDir} ` +
                `on this spawn — ${(err as Error)?.message ?? 'unknown error'}`,
            );
            return;
          }
          if (pass === 1) {
            // Taken away twice running. Whatever was written may not have lasted; the next
            // spawn looks again, since nothing was memoized.
            logMeshProblem(
              `this workspace's trust decision for the account at ${configDir} was written, but ` +
                `its lock was removed by another process both times, so it may not have lasted — ` +
                `${(err as Error)?.message ?? 'unknown error'}`,
            );
          }
        }
      }
    } catch {
      // any seed failure degrades to "worker may block", never a throw out of spawn
    }
  }

  /**
   * prepareAccount's critical section: read the account's config, record this workspace's
   * trust decisions in it, write it back. Runs with the account's `.cco.lock` HELD, so it is
   * synchronous and never blocks. Returns true when the config now holds the decisions
   * (already there, or written by this call) and false when this pass did nothing — the
   * caller memoizes only a true. May throw (the rename); the caller treats that as a false.
   */
  private seedAccountConfig(configPath: string): boolean {
    // Re-read INSIDE the lock, immediately before writing: never serialize a stale
    // snapshot. A token refresh that landed between the caller's existsSync and here is
    // now part of what we read back, so our write cannot drop it.
    if (!fs.existsSync(configPath)) {
      // vanished under us (never re-create it)
      return false;
    }
    let config: Record<string, unknown>;
    // BEYOND THE ENUMERATED SITE LIST, and the same class as every site in it: this is a
    // file inside a directory the worker is TOLD the name of, read SYNCHRONOUSLY while this
    // process holds the prepareAccount lock — so a FIFO here would wedge the spawn path and
    // the lock together. The existing rule is preserved exactly and now covers one more
    // reason: a config we could not READ is never overwritten, just like one we could not
    // PARSE.
    // A link is FOLLOWED here (the default), on purpose: `.claude.json` is the user's own file,
    // and a user who keeps it elsewhere behind a link has a config like any other.
    const read = readTextSafe(configPath, ACCOUNT_CONFIG_MAX_BYTES);
    if (!read.ok) {
      return false;
    }
    try {
      const parsed = JSON.parse(read.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      // unparseable — never overwrite a config we could not read
      return false;
    }
    const { changed } = applyProjectMcpTrust(config, this.cwd, this.projectMcpServerNames());
    if (!changed) {
      return true;
    }
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    const wrote = writeTempFileGuarded(tmpPath, JSON.stringify(config, null, 2));
    if (!wrote.ok) {
      // NEITHER the rename NOR the memo. `preparedConfigDirs` is the "this account is
      // seeded, do not look again" cache, so answering true here would turn one refused write
      // into a permanent one for the life of the process — a refusal recorded as a
      // success. Answering false leaves the next spawn to retry, which is what every other
      // failure on this path already does.
      return false;
    }
    fs.renameSync(tmpPath, configPath);
    // A copy of this account's config that a spawn killed between its temp write and its rename
    // left here is taken away by the next spawn that writes — it holds everything the config
    // holds, and nothing will ever read it.
    removeDeadWritersTempFiles(configPath);
    return true;
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
    // Guarded for the same reason, one layer out: this runs on the spawn path too, and a
    // workspace root is not a trusted directory when a worker has a worktree inside it. Every
    // failure still yields [], which is this function's documented answer.
    // Followed when it is a link (the default), like `.claude.json` above: the project's file.
    const read = readTextSafe(path.join(this.cwd, '.mcp.json'), PROJECT_MCP_FILE_MAX_BYTES);
    if (!read.ok) {
      this.mcpServerNames = names;
      return names;
    }
    try {
      const raw = JSON.parse(read.text);
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

  /** This installation's Claude Code accounts, 'main' being this pool's host dir (claudeAccounts). */
  private buildCandidates(registry: Registry): ClaudeAccount[] {
    return claudeAccounts(registry, this.mainConfigDir);
  }

  /**
   * "May this pool treat a LEDGER RECORD's dir as a Claude config dir?" — yes when this
   * process started a session under it (spawnVettedDirs: no registry read at all, so nothing
   * the registry does later can take a worker away from the process that started it), and
   * otherwise when it is a Claude Code account of this installation RIGHT NOW, over a fresh
   * read of the registry taken on first need and then kept for the life of the returned
   * function (one mesh_status call asks it once per record). Never throws: readRegistry is
   * total, and an unreadable registry leaves only 'main' plus what this process spawned
   * under, which is the narrowing direction.
   */
  private claudeAccountCheck(): ClaudeAccountCheck {
    let check: ClaudeAccountCheck | undefined;
    return (configDir) => {
      if (spawnVettedConfigDir(configDir)) {
        return true;
      }
      check = check ?? claudeAccountDirCheck(this.buildCandidates(readRegistry()));
      return check(configDir);
    };
  }

  /**
   * Find ONE record's session entry (locateRecordSession), trying the pids this process has
   * seen for it first, and remember where a running one was found. Every liveness read in
   * this class goes through here — which makes it the one place the record's dir is checked
   * before its `sessions/` is opened (claudeAccountCheck): a dir that is neither one this
   * process started a session under nor a Claude Code account now is not read at all, and the
   * answer says so (`unchecked`) with `complete: false`, so no caller can turn "nobody looked"
   * into "gone" or into a kill.
   */
  private locate(
    record: MeshWorkerRecord,
    scanDir: SessionDirScanner,
    isClaudeAccount: ClaudeAccountCheck = this.claudeAccountCheck(),
  ): LocatedSession {
    if (!isClaudeAccount(record.configDir)) {
      return { alive: false, complete: false, unchecked: notClaudeAccountReason(record) };
    }
    const hints: number[] = [];
    const remembered = record.jobId === '' ? undefined : this.sessionPids.get(record.jobId);
    if (remembered !== undefined) {
      hints.push(remembered);
    }
    if (typeof record.pid === 'number' && record.pid !== remembered) {
      hints.push(record.pid);
    }
    const located = locateRecordSession(record, hints, scanDir, (entry) =>
      this.entryRunsWorker(record.jobId, entry),
    );
    if (record.jobId !== '') {
      if (located.entry !== undefined && located.alive) {
        this.sessionPids.set(record.jobId, located.entry.pid);
      } else {
        this.sessionPids.delete(record.jobId);
      }
    }
    return located;
  }

  /**
   * Is the process this worker's session entry names still the worker? (EntryRuns, for every
   * liveness read of this class.)
   *
   * A dead pid is not, and that is the whole of the old rule. The addition is for a pid that
   * is alive and is SOMEBODY ELSE: a worker killed outright leaves `<pid>.json` behind, the OS
   * hands the number to the next process that starts, and the entry then reads `busy` — or
   * whatever status it was left with — until the dispatch's deadline, which is the only thing
   * left to end the wait.
   *
   * So the process's command line is read (one `ps`, about 2 ms; the liveness tick asks every
   * 15 s per dispatch in flight). The verdict is deliberately one-sided:
   *   - it names the CLI → the worker, and the pair (job, pid) is remembered as CONFIRMED;
   *   - it could not be read → no evidence; the pid is alive, so the entry counts as running;
   *   - it names something else, and this pair was confirmed before → the pid has changed
   *     hands since this pool last looked: NOT running, and the lookup goes on to the scan as
   *     it does for a dead pid (the session may have re-registered under another pid);
   *   - it names something else, this pair was NEVER confirmed, and the process STARTED AFTER
   *     the entry says its session did (entryStartOrder `after`) → NOT running either: a
   *     process that is not the CLI and is younger than the session whose entry names its pid
   *     is the pid's next owner. This is the worker whose pid changed hands before this pool
   *     ever looked at it;
   *   - it names something else, never confirmed, and its start is consistent with the entry,
   *     could not be read, or has nothing to be compared with → the entry counts as running,
   *     as it always did. A worker this pool never once saw under the CLI's name may be
   *     running from an installation whose command line this build does not recognise, and
   *     calling such a worker gone would fail a healthy dispatch as "the worker died".
   * A process that DOES name the CLI is never read as gone on its start time: the start time
   * is derived from the wall clock as it reads now, which on some platforms a clock step can
   * move, and a wrong "gone" here costs a healthy dispatch. (The gate in front of a SIGNAL
   * does apply the start time to such a process — there a wrong "no" costs nothing but a
   * refusal.) So a pid that went to ANOTHER Claude Code session still reads as running until
   * the deadline.
   * What the third case cannot be told apart from is a worker that changes ITS OWN command
   * line, from one that names the CLI to one that does not, after it was first seen. A process
   * can do that (it can overwrite its title); no Claude Code process observed does — each keeps
   * the command line it was started with — and such a worker would read as gone.
   *
   * This is a LIVENESS reading and never a licence to signal: the gate in front of a signal is
   * pidRunsWorkerCli, asked again at that moment, and it counts only a positive answer.
   */
  private entryRunsWorker(jobId: string, entry: SessionEntry): boolean {
    if (!isPidAlive(entry.pid)) {
      return false;
    }
    const key = `${jobId}:${entry.pid}`;
    for (const name of workerCliNames(this.claudePath)) {
      const verdict = processRunsCli(entry.pid, name);
      if (verdict === true) {
        this.confirmedWorkerPids.add(key);
        return true;
      }
      if (verdict === undefined) {
        return true;
      }
    }
    // A command line was read, and it names something else.
    if (this.confirmedWorkerPids.has(key)) {
      return false;
    }
    return entryStartOrder(entry) !== 'after';
  }

  /**
   * Can the orchestrator's own SendMessage address this worker by name? That takes a session
   * entry for it in the HOST config dir (contract MeshWorkerStatus.peerVisible):
   *   - a worker on the host's own account is there natively — its real entry IS that dir's;
   *   - a worker on another account is there once the bridge has mirrored it, and a mirror
   *     is always `<host sessions>/<pid>.json`, so ONE direct read answers (no scan of what
   *     is usually the most cluttered directory on the machine).
   * `false` is a looked-and-absent; `undefined` is "could not tell" — the worker itself was
   * not located, or the host file is there and unreadable. A worker that is positively gone
   * is `false`: nothing addressable is left.
   */
  private peerVisible(record: MeshWorkerRecord, located: LocatedSession, now: number): boolean | undefined {
    const entry = located.entry;
    if (entry === undefined || !located.alive) {
      return sessionStatusFrom(located, record, now).kind === 'gone' ? false : undefined;
    }
    if (sameConfigDir(record.configDir, this.mainConfigDir)) {
      return true;
    }
    const host = readSessionEntryFile(sessionsDir(this.mainConfigDir), entry.pid);
    if (host.problem) {
      return undefined;
    }
    if (host.entry === undefined) {
      return false;
    }
    // Real or mirrored, but it has to be THIS job's: a pid-named file left by some other
    // session is not a way to reach this worker.
    return record.jobId === '' ? host.entry.name === record.name : entryIsJob(host.entry, record.jobId);
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
   *
   * NEVER PAST WHAT THE PARSER READS (contract.MESH_WORKER_SEQ_MAX): the name minted from this
   * number has to parse, or the worker it names is one the orphan sweep and adopt() take for
   * somebody else's session. So when the highest number in use is already the largest a name
   * can carry — which takes a hand-written name, not a billion spawns — the answer is the
   * LOWEST number no name of this token is using instead. Either way the name is one that
   * nothing in the ledger or in a live session registry carries now.
   */
  private nextSeq(account: string, candidateConfigDirs: string[]): number {
    const token = sanitizeAccountForName(account);
    let max = 0;
    const used = new Set<number>();
    const consider = (nm: string | undefined): void => {
      if (typeof nm !== 'string') {
        return;
      }
      const parsed = parseMeshWorkerName(nm, this.cwd);
      if (parsed && parsed.account === token) {
        max = Math.max(max, parsed.seq);
        used.add(parsed.seq);
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
    if (max < MESH_WORKER_SEQ_MAX) {
      return max + 1;
    }
    // At most `used.size + 1` steps: that many numbers cannot all be taken by `used.size` names.
    let free = 1;
    while (used.has(free)) {
      free++;
    }
    return free;
  }

  /**
   * The teardown finisher that runs after a stop (A11): `claude rm <jobId>`, then one
   * ledger write recording what became of the worktree.
   *
   * Three outcomes, three ledger states, and the distinction is the point:
   *   - removed  → worktreeKept = false: nothing survives, mesh_status stops advertising it;
   *   - kept     → worktreeKept = true : work survives in the worktree (uncommitted edits, or
   *                the commit made at settle) and must be surfaced until it is merged;
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
      const wrote = this.mutateWorkers((workers) => {
        // (name, jobId), like markStopped: a worktree verdict written onto a namesake would
        // advertise one record's unmerged work under another's — or erase the KEPT flag that is
        // the only thing keeping a dirty worktree visible.
        const rec = workers.find((r) => isSameWorkerRecord(r, record));
        if (rec) {
          rec.worktreeKept = kept;
        }
      });
      // A write the ledger SKIPPED costs a status marker and is not retried: the flag stays
      // absent, which is the "unknown" state described above, and whether a worktree is still
      // there is answered from the disk by the readers that act on it (reaper.keptWorktree).
      const unsaid = wrote.skipped ?? wrote.contested;
      if (unsaid !== undefined) {
        logMeshProblem(
          `whether the worktree of ${record.name} was ${kept ? 'kept' : 'removed'} ` +
            `${wrote.written ? 'may not have stayed recorded' : 'was not recorded'} — ${unsaid}`,
        );
      }
    } catch (err) {
      // an unwritable ledger costs a status marker, never the stop itself
      logMeshProblem(
        `whether the worktree of ${record.name} was kept was not recorded — ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Stop a session a FAILED spawn may have left behind (F9), and describe what happened.
   *
   * Called only from the spawn-failure return path, where no ledger record was ever written:
   * this is the one moment a live `--bg` session can exist that nothing will ever find
   * again. The session registry is the only place it can be seen, and the minted name is the
   * only proof it is ours — there is no job id, the launcher failed before printing one — so
   * this is the ONE place an entry is matched by name: EXACTLY, a name minted moments ago
   * that nextSeq just proved no ledger record and no session entry was using. The pid is
   * signalled only after a FRESH read still shows that name alive (pids are recycled).
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
          claudeEnv(configDir),
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
      // The identity gate, in the same turn as the signal: the entry carries the name minted
      // for this spawn, and the process holding its pid must be the CLI and must not have
      // started after the entry says the session did.
      if (!entryPidIsWorker(fresh, this.claudePath)) {
        return (
          `a session named ${name} registered under pid ${fresh.pid} — ${unconfirmedPidRefusal(fresh.pid)} ` +
          `(${UNCONFIRMED_PID_WHY}), so nothing was signalled`
        );
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
   * Stop a session whose spawn SUCCEEDED but whose ledger record could not be written, and say
   * what happened as a clause for the spawn failure ("…, so <clause>").
   *
   * The counterpart of stopStrandedSession for the opposite half of the same problem: there
   * the launcher failed and a session may exist that has no job id; here the launcher
   * succeeded, the job id is known, and it is the LEDGER that failed. Either way a live
   * session with no record is the one thing this module must never leave behind, and this is
   * the last moment anything knows it exists.
   *
   * `claude stop <jobId>` under the spawning account first. When that fails, the session's own
   * entry is looked up BY JOB ID and its pid killed — never a name match, never a recorded pid.
   * A session that cannot be stopped either way is reported as still running, with the command
   * that stops it: the caller's error is the only place left that will ever say so. After a
   * stop that worked, `claude rm` removes the job and its (untouched) worktree; a plain `rm`
   * never discards work, and its outcome changes nothing here.
   *
   * Bounded and TOTAL: no path throws, because this runs while a spawn failure is being
   * reported and a cleanup problem must not replace that report.
   */
  private async stopUnrecordedSession(record: MeshWorkerRecord): Promise<string> {
    const stopped = 'it was stopped again and this dispatch did not start';
    const byHand =
      `stop it by hand with \`${claudeCommandFor(record.configDir, `stop ${shellToken(record.jobId)}`)}\``;
    try {
      const outcome = await runMeshProcess(
        this.claudePath,
        ['stop', record.jobId],
        this.cwd,
        claudeEnv(record.configDir),
        MESH_STOP_TIMEOUT_MS,
      );
      if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
        await removeWorkerJob({
          claudePath: this.claudePath,
          cwd: this.cwd,
          configDir: record.configDir,
          jobId: record.jobId,
        });
        return stopped;
      }
      const located = locateSession(sessionsDir(record.configDir), record.jobId, [], createSessionDirScanner());
      const entry = located.alive ? located.entry : undefined;
      if (entry !== undefined && isPidAlive(entry.pid)) {
        // The identity gate, in the same turn as the signal. This session was started moments
        // ago, so a stranger behind its pid is as unlikely as it gets — and it is still asked,
        // because the rule has no exceptions for a pid that came out of a file.
        if (!entryPidIsWorker(entry, this.claudePath)) {
          return (
            `it should have been stopped again, but \`claude stop\` ${describeProcFailure(outcome)} and ` +
            `${unconfirmedPidRefusal(entry.pid)} (${UNCONFIRMED_PID_WHY}), so nothing was ` +
            `signalled: IT MAY STILL BE RUNNING and nothing records it — ${byHand}`
          );
        }
        try {
          process.kill(entry.pid, 'SIGKILL');
          return `it was killed (\`claude stop\` ${describeProcFailure(outcome)}) and this dispatch did not start`;
        } catch (e) {
          return (
            `it should have been stopped again, but \`claude stop\` ${describeProcFailure(outcome)} and ` +
            `killing pid ${entry.pid} failed (${(e as Error).message}): IT IS STILL RUNNING and ` +
            `nothing records it — ${byHand}`
          );
        }
      }
      return (
        `it should have been stopped again, but \`claude stop\` ${describeProcFailure(outcome)} and no ` +
        `running session entry carries that job id yet, so nothing could be killed: IT MAY STILL ` +
        `BE RUNNING and nothing records it — ${byHand}`
      );
    } catch (e) {
      return (
        `it should have been stopped again, but that failed (${(e as Error)?.message ?? 'unknown error'}): ` +
        `IT MAY STILL BE RUNNING and nothing records it — ${byHand}`
      );
    }
  }

  /**
   * Set stoppedAt on a worker record (a no-op if it vanished between calls). Resolves to
   * undefined once the ledger holds the mark, and otherwise to a NOTE for the caller's reply —
   * never a rejection: the stop this follows has already happened, and a bookkeeping failure
   * must not turn it into a failed stop.
   *
   * Takes the RECORD, not its name, and re-finds it by (name, jobId): stopping a target that was
   * resolved by job id must stamp THAT record, and a name lookup inside this write would stamp
   * whichever namesake the ledger lists first — the first-match bug moved one layer down, where
   * its result is a live worker marked stopped and hidden from every sweep.
   *
   * A mark the ledger skipped is tried once more (writeDurably). When it still has not landed
   * the session is down and its record says live, so the note says exactly that and what
   * mends it — measured, not assumed: a stop repeated straight away does NOT (inside
   * ENTRY_APPEAR_GRACE_MS of the spawn, stop cannot tell a session that is gone from one that
   * has not registered yet, and refuses to mark). What does is a stop made after that window
   * (its convergence branch finds the session gone and marks the record), and, at the latest,
   * the end of this session, which marks every unstopped record this process owns. Until then
   * the record still counts against the in-flight cap unless its dispatch has settled.
   */
  private async markStopped(record: MeshWorkerRecord): Promise<string | undefined> {
    let why: string | undefined;
    try {
      const at = Date.now();
      const wrote = await this.writeDurably((workers) => {
        const rec = workers.find((r) => isSameWorkerRecord(r, record));
        if (rec) {
          rec.stoppedAt = at;
        }
      });
      why = wrote.skipped ?? wrote.contested;
      if (wrote.written && wrote.contested === undefined) {
        return undefined;
      }
      if (wrote.written) {
        logMeshProblem(`worker ${record.name}: the stop was recorded, but ${why}`);
        return `the stop was recorded, but ${why}`;
      }
    } catch (err) {
      why = (err as Error)?.message ?? 'the ledger write failed';
    }
    const note =
      'the session is stopped, but the mesh ledger could NOT be updated, so its record still ' +
      'reads as live. It is marked when this orchestrator session ends, or by a later stop of ' +
      `this worker made more than ${Math.round(ENTRY_APPEAR_GRACE_MS / 1000)} s after it was ` +
      'spawned (before that, a session that is gone cannot be told from one still starting) — ' +
      why;
    // Logged as well as returned: the dispatch path's own stops (a timeout, a cancel, a quota
    // stall) do not look at what a stop answers.
    logMeshProblem(`worker ${record.name}: ${note}`);
    return note;
  }

  /* --- mesh state file (pool owns only `workers`) ------------------------ */

  /** This workspace's worker records (module-level helper, bound to our cwd). */
  private readWorkers(): MeshWorkerRecord[] {
    return readMeshWorkerRecords(this.cwd);
  }

  /** Read-modify-write this workspace's `workers` array (module-level helper, our cwd). */
  private mutateWorkers(fn: (workers: MeshWorkerRecord[]) => void): LedgerWrite {
    return mutateMeshWorkers(this.cwd, fn);
  }

  /**
   * mutateWorkers for a write a LATER DECISION depends on — the spawn record, a stop mark, a
   * settle mark — which therefore may not simply evaporate when the ledger skips it.
   *
   * The first attempt runs synchronously, in the caller's own turn. Only a SKIPPED write is
   * tried again, after each pause in LEDGER_WRITE_RETRY_PAUSES_MS: a skip means the mutator did
   * not touch the file (mutateMeshWorkers), and the mutator is idempotent in any case. A write
   * that THREW is not retried — it failed inside the critical section, for a reason a second
   * attempt would meet again — and the throw comes straight through.
   *
   * The outcome of the last attempt is returned, and what a still-skipped write MEANS is the
   * caller's to decide; this helper only makes sure "skipped once" is not the end of it.
   */
  private async writeDurably(fn: (workers: MeshWorkerRecord[]) => void): Promise<LedgerWrite> {
    let outcome = this.mutateWorkers(fn);
    for (const pause of LEDGER_WRITE_RETRY_PAUSES_MS) {
      if (outcome.written) {
        break;
      }
      // Not unref'd: a caller that awaits this must get its answer even when nothing else is
      // keeping the process alive, and half a second cannot hold a shutdown up.
      await new Promise<void>((resolve) => setTimeout(resolve, pause));
      outcome = this.mutateWorkers(fn);
    }
    return outcome;
  }
}
