import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { meshWorkspaceHash } from '../mesh/contract';
import { SESSION_IDENTITY_ENV } from '../platform';
import type { ProviderId } from '../providers';
import { readTextSafe } from '../safeFs';
import {
  CHECKPOINT_DIFF_PATHS_MAX,
  CHECKPOINT_EXCLUDES,
  CHECKPOINT_FILE_MAX,
  CHECKPOINT_IDENTITY,
  CHECKPOINT_SKIPPED_MAX,
  CHECKPOINT_TOUCHED_MAX,
  CLAUDE_PROJECT_MCP_FILE,
  FEED_TEXT_MAX_BYTES,
  GIT_ENV,
  GIT_NO_HOOKS,
  GIT_TIMEOUTS_MS,
  INDEX_LOCK_STALE_MS,
  isCheckpointSkipName,
  pathsOverlap,
  TEAM_DIR_MODE,
  TEAM_FILE_MODE,
  TEAM_MEMBER_ENV,
  TEAM_NOTICE,
  TEAM_TEXT,
  VENDOR_MCP_FILES,
  type CheckpointOutcome,
  type CreateTeamWorktrees,
  type RepositoryFacts,
  type TeamMcpConfig,
  type TeamRuntime,
  type TeamWorktrees,
  type WorktreeFailureCode,
  type WorktreePlan,
  type WorktreeResult,
} from './contract';

/**
 * team/worktree — the git half of the team engine (contract-team-mode-v2 §9, H5, H6, M18, M23, L5,
 * L6, T0 A5): each member's own worktree, created in two hook-free phases and recovered in place
 * when a creation was cut short; the two vendor MCP files the engine writes into a worktree, with
 * their merge / skip-worktree / delete / restore rules; the checkpoint commit after every turn; and
 * the facts the views, the hand-off packet and the overlap check read.
 *
 * EVERY GIT CALL goes through `git()` below: `child_process` with an argv (never a shell), its own
 * process group (so a timeout or an abort ends git AND what it started — a smudge filter, an LFS
 * download), stdin ignored unless a commit message is piped, stdout/stderr read bounded, the
 * GIT_TIMEOUTS_MS budget of its kind. Every call carries GIT_NO_HOOKS (`-c
 * core.hooksPath=/dev/null`, M18 — read-only calls run no hook anyway, and one rule cannot be
 * forgotten at one call site) and `-c core.fsmonitor=false` (a configured command git would run
 * when it reads the index). The environment is the host's without the variables that point git at
 * another repository, plus GIT_ENV, GIT_OPTIONAL_LOCKS=0 and LC_ALL=C (git's own sentences are
 * matched, so they must not be translated).
 *
 * I8 — WHAT IT NEVER DOES: `--force`, `reset`, `clean`, delete a branch, remove a worktree, merge.
 * The two stated rewrites are populate's re-population of a planned-never-ready worktree
 * (`read-tree --reset -u HEAD`, exception a) and restoreVendorMcp (exception b). The one
 * `worktree prune --expire now` (T11 A22) is restore()'s, and only when git still registers the
 * very path being restored with no directory behind it: prune removes REGISTRATIONS of missing
 * directories (any member's — stated), never a file or a branch.
 *
 * SYMBOLIC LINKS (T11 A17). A member owns its worktree and can plant a link anywhere in it — at a
 * file's name or at any DIRECTORY on the way to it (`.cursor -> ~/.cursor`). Every file the engine
 * writes, deletes or has git restore inside a worktree is reached only through real directories:
 * each component from the worktree root down to the file's parent is `lstat`'d and must be a
 * directory, not a link (dirDescent); otherwise nothing is done and the answer names the link. The
 * write itself goes to an `O_EXCL | O_NOFOLLOW` temp file beside the name, renamed over it (a
 * rename replaces a link at the name, it never writes through it). Residual, stated: the walk and
 * the write are two steps — a process of the member that survived its turn's reap could swap a
 * directory for a link between them; the engine calls these only between turns.
 *
 * Every method is total: an expected failure is a WorktreeResult, never a throw.
 */

/* ------------------------------------------------------------------------- *
 * Tunables
 * ------------------------------------------------------------------------- */

/** A git call's stdout read limit, by default (diff/status of a monorepo stay well under it). */
const GIT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
/** A git call's stderr read limit — only its first line is ever quoted. */
const GIT_STDERR_MAX_BYTES = 64 * 1024;
/** After a timeout or an abort, SIGTERM → this → SIGKILL to git's group. */
const GIT_KILL_GRACE_MS = 2_000;
/** A tracked vendor MCP file's index version, read for the merge. */
const MCP_FILE_MAX_BYTES = 1024 * 1024;
/** A hand-off packet fact is capped by prompts.ts; this only bounds the read. */
const PACKET_FACT_MAX_BYTES = 1024 * 1024;
/** `.gitattributes` read for an LFS filter. */
const GITATTRIBUTES_MAX_BYTES = 1024 * 1024;
/** Variables that would point git at ANOTHER repository than the one asked about. */
const FOREIGN_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
] as const;

/* ------------------------------------------------------------------------- *
 * Running git
 * ------------------------------------------------------------------------- */

interface GitRun {
  /** Exit code; null after a signal, a timeout, an abort or a failed spawn. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** errno of a spawn failure (git missing). */
  spawnError?: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FOREIGN_GIT_ENV) {
    delete env[key];
  }
  return { ...env, ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

/** Signal a child's group (POSIX), else the child. Never throws. */
function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

/**
 * One git call in `dir` (`git -C <dir> <GIT_NO_HOOKS> -c core.fsmonitor=false <args>`). Never
 * rejects. A timeout or an abort SIGTERMs git's group, SIGKILLs it GIT_KILL_GRACE_MS later.
 */
function git(
  dir: string,
  args: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal; stdin?: string; maxStdout?: number },
): Promise<GitRun> {
  return new Promise((resolve) => {
    const run: GitRun = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false };
    if (opts.signal?.aborted === true) {
      run.aborted = true;
      resolve(run);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', dir, ...GIT_NO_HOOKS, '-c', 'core.fsmonitor=false', ...args], {
        env: gitEnv(),
        shell: false,
        detached: process.platform !== 'win32',
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      run.spawnError = (err as NodeJS.ErrnoException).code ?? 'EINVAL';
      resolve(run);
      return;
    }
    const maxStdout = opts.maxStdout ?? GIT_STDOUT_MAX_BYTES;
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      killGroup(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), GIT_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      run.timedOut = true;
      stop();
    }, Math.max(1, opts.timeoutMs));
    const onAbort = (): void => {
      run.aborted = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(run);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (outBytes < maxStdout) {
        run.stdout += chunk;
        outBytes += Buffer.byteLength(chunk);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (errBytes < GIT_STDERR_MAX_BYTES) {
        run.stderr += chunk;
        errBytes += Buffer.byteLength(chunk);
      }
    });
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      if (child.pid === undefined) {
        run.spawnError = (err as NodeJS.ErrnoException).code ?? 'EINVAL';
        settle();
      }
    });
    child.on('exit', (code) => {
      run.code = run.timedOut || run.aborted ? null : code;
      // A grandchild that holds a pipe must not hold the answer: settle shortly after the exit.
      setTimeout(settle, 250);
    });
    child.on('close', settle);
    if (opts.stdin !== undefined) {
      try {
        child.stdin?.end(opts.stdin);
      } catch {
        // the exit settles it
      }
    }
  });
}

/**
 * The ONE line that says why a git call failed, or how it ended (T11 A22): git's first `fatal:` /
 * `error:` line (stderr, then stdout), else its first non-empty line. git prints progress before
 * the reason (`Preparing worktree (checking out …)` then `fatal: … is a missing but already
 * registered worktree`), so the first line alone would quote the progress and drop the reason.
 */
function firstLine(run: GitRun): string {
  if (run.spawnError !== undefined) {
    return `git could not be started (${run.spawnError})`;
  }
  if (run.aborted) {
    return 'stopped (the lead session ended)';
  }
  if (run.timedOut) {
    return 'git timed out';
  }
  const lines = [run.stderr, run.stdout].flatMap((t) => t.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const said = lines.find((l) => /^(?:fatal|error):/i.test(l)) ?? lines[0];
  return sliceOneLine(flattenOneLine(said ?? `git exited with code ${run.code ?? 'null'}`), 300);
}

function fail<T>(code: WorktreeFailureCode, text: string): WorktreeResult<T> {
  return { ok: false, code, text: sliceOneLine(flattenOneLine(text), 300) };
}

/** The failure of a git step: `aborted` for an abort, else `code` with git's line, prefixed. */
function stepFail<T>(code: WorktreeFailureCode, step: string, run: GitRun): WorktreeResult<T> {
  return run.aborted ? fail('aborted', `${step}: ${firstLine(run)}`) : fail(code, `${step}: ${firstLine(run)}`);
}

function ok<T>(value: T): WorktreeResult<T> {
  return { ok: true, value };
}

/** NUL-separated output → its non-empty entries. */
function zList(out: string): string[] {
  return out.split('\0').filter((p) => p !== '');
}

/** A path as git's pathspec takes it LITERALLY, excluded. */
function literalExclude(rel: string): string {
  return `:(exclude,literal)${rel}`;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/* ------------------------------------------------------------------------- *
 * Files the engine writes into a worktree (H5)
 * ------------------------------------------------------------------------- */

/** Why a path inside a worktree may not be touched (A17): the component, relative to the root ('.' = the root). */
type Descent = { ok: true } | { ok: false; at: string; why: 'is a symbolic link' | 'is not a directory' | 'is missing' };

/**
 * A17: walk from the worktree `root` down to the PARENT of `rel` (`/`-separated, relative), each
 * component `lstat`'d — every one must be a real directory, never a symbolic link (the root itself
 * included: it is the engine's, a link there would redirect everything below it). `create`: a
 * missing component below the root is created (0700) and then `lstat`'d like the others. Never throws.
 */
function dirDescent(root: string, rel: string, create: boolean): Descent {
  const parent = path.posix.dirname(rel);
  const parts = parent === '.' ? [] : parent.split('/');
  let at = root;
  for (let i = -1; i < parts.length; i++) {
    const label = i < 0 ? '.' : parts.slice(0, i + 1).join('/');
    if (i >= 0) {
      at = path.join(at, parts[i]);
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch (err) {
      if (!create || i < 0 || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, at: label, why: 'is missing' };
      }
      try {
        fs.mkdirSync(at, { mode: TEAM_DIR_MODE });
        st = fs.lstatSync(at);
      } catch {
        return { ok: false, at: label, why: 'is missing' };
      }
    }
    if (st.isSymbolicLink()) {
      return { ok: false, at: label, why: 'is a symbolic link' };
    }
    if (!st.isDirectory()) {
      return { ok: false, at: label, why: 'is not a directory' };
    }
  }
  return { ok: true };
}

/** `text` at `file` (0600), atomically: a fresh `O_EXCL | O_NOFOLLOW` temp file beside it, renamed over the name. Throws with an errno. */
function writeFileAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.cco-${randomBytes(6).toString('hex')}.tmp`);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
  const fd = fs.openSync(tmp, flags, TEAM_FILE_MODE);
  try {
    fs.writeFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left behind to remove
    }
    throw err;
  }
}

/**
 * Write `text` at `<root>/<rel>` (0600) without ever following a symbolic link a member may have
 * planted (A17): every directory on the way is a real one (dirDescent, missing ones created 0700),
 * then writeFileAtomic. Answers why it did not write — one phrase naming the link — or undefined.
 */
function writeFileInWorktree(root: string, rel: string, text: string): string | undefined {
  const descent = dirDescent(root, rel, true);
  if (!descent.ok) {
    return `${descent.at} ${descent.why}`;
  }
  try {
    writeFileAtomic(path.join(root, rel), text);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'EIO';
  }
}

/* ------------------------------------------------------------------------- *
 * index.lock (L5)
 * ------------------------------------------------------------------------- */

/** Who holds `file` open: `lsof -t` (darwin) / `fuser` (linux). `unknown` when it cannot be told. */
function lockHolder(file: string): Promise<'held' | 'none' | 'unknown'> {
  const tools =
    process.platform === 'darwin'
      ? [['lsof', '-t'], ['/usr/sbin/lsof', '-t']]
      : process.platform === 'linux'
        ? [['fuser'], ['/usr/bin/fuser'], ['/bin/fuser']]
        : [];
  const attempt = (i: number): Promise<'held' | 'none' | 'unknown'> => {
    if (i >= tools.length) {
      return Promise.resolve('unknown');
    }
    const [cmd, ...args] = tools[i];
    return new Promise((resolve) => {
      try {
        execFile(cmd, [...args, file], { timeout: GIT_TIMEOUTS_MS.lockHolder, encoding: 'utf8' }, (err, stdout) => {
          if (err === null) {
            resolve(stdout.trim() !== '' ? 'held' : 'none');
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
          if (e.code === 'ENOENT') {
            resolve(attempt(i + 1));
          } else if (typeof e.code === 'number' && e.code === 1 && !e.killed && stdout.trim() === '') {
            // Both tools exit 1 when no process has the file open.
            resolve('none');
          } else {
            resolve('unknown');
          }
        });
      } catch {
        resolve('unknown');
      }
    });
  };
  return attempt(0);
}

/**
 * L5: the worktree's `index.lock` is stale — older than INDEX_LOCK_STALE_MS AND held by no process
 * — and was removed: `removed`. Present but not provably stale: `held` (undeterminable counts as
 * held). Absent: `absent`.
 */
async function clearStaleLock(wt: string): Promise<'removed' | 'held' | 'absent'> {
  const gd = await git(wt, ['rev-parse', '--absolute-git-dir'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
  if (gd.code !== 0) {
    return 'held';
  }
  const lock = path.join(gd.stdout.trim(), 'index.lock');
  let mtimeMs: number;
  try {
    mtimeMs = fs.lstatSync(lock).mtimeMs;
  } catch {
    return 'absent';
  }
  if (Date.now() - mtimeMs <= INDEX_LOCK_STALE_MS) {
    return 'held';
  }
  if ((await lockHolder(lock)) !== 'none') {
    return 'held';
  }
  try {
    fs.unlinkSync(lock);
    return 'removed';
  } catch {
    return 'held';
  }
}

/** A failed git step that was refused for an `index.lock`. */
function lockedOut(run: GitRun): boolean {
  return run.code !== 0 && /index\.lock/.test(run.stderr);
}

/* ------------------------------------------------------------------------- *
 * The worktrees
 * ------------------------------------------------------------------------- */

/** One `git worktree list --porcelain` entry. */
interface ListedWorktree {
  path: string;
  head?: string;
  branch?: string;
}

function parseWorktreeList(out: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let entry: ListedWorktree | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      entry = { path: line.slice('worktree '.length) };
      entries.push(entry);
    } else if (entry !== undefined && line.startsWith('HEAD ')) {
      entry.head = line.slice('HEAD '.length).trim();
    } else if (entry !== undefined && line.startsWith('branch ')) {
      entry.branch = line.slice('branch '.length).trim();
    }
  }
  return entries;
}

/** Whether `p` is absent, or an empty directory (git's own `worktree add` accepts that). */
function pathFree(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && fs.readdirSync(p).length === 0;
  } catch {
    return true;
  }
}

/** A path as git records it, compared: realpath'd, or — for a path that is gone — its parent realpath'd plus its name. */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.join(realOrResolved(path.dirname(p)), path.basename(p));
  }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Implements TeamWorktrees (contract.ts) — every method as its doc comment there says. */
export const createTeamWorktrees: CreateTeamWorktrees = (runtime: TeamRuntime): TeamWorktrees => {
  void runtime;

  /** The dirty test (§9.2): `status --porcelain -- . <excludes>` — true when anything is listed. */
  const dirty = async (wt: string, extra: readonly string[] = [], signal?: AbortSignal): Promise<GitRun & { dirty: boolean }> => {
    const run = await git(wt, ['status', '--porcelain', '--', '.', ...CHECKPOINT_EXCLUDES, ...extra], {
      timeoutMs: GIT_TIMEOUTS_MS.quick,
      ...(signal !== undefined ? { signal } : {}),
    });
    return { ...run, dirty: run.stdout.trim() !== '' };
  };

  /**
   * Where `wt`'s HEAD is, against the member's `branch` (check() and, T11 A21, checkpoint()'s first
   * step): on the branch, with a commit → ok; otherwise `branch-moved` whose text names what HEAD
   * is — `detached at <sha7>`, `on <other branch>`, or on the branch with no commit (unborn: the
   * member deleted it) — so the lead can be told the exact remedy; `git` when it cannot be told.
   */
  const headOn = async (wt: string, branch: string, signal?: AbortSignal): Promise<WorktreeResult<void>> => {
    const opts = { timeoutMs: GIT_TIMEOUTS_MS.quick, ...(signal !== undefined ? { signal } : {}) };
    const sym = await git(wt, ['symbolic-ref', '-q', 'HEAD'], opts);
    if (sym.aborted) {
      return stepFail('aborted', 'symbolic-ref', sym);
    }
    if (sym.code !== 0 && sym.code !== 1) {
      return stepFail('git', 'symbolic-ref', sym);
    }
    const tip = await git(wt, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], opts);
    if (tip.code !== 0 && tip.code !== 1) {
      return tip.aborted ? stepFail('aborted', 'rev-parse HEAD', tip) : stepFail('git', 'rev-parse HEAD', tip);
    }
    const sha7 = tip.code === 0 ? tip.stdout.trim().slice(0, 7) : undefined;
    const ref = sym.stdout.trim();
    if (sym.code === 1) {
      return fail('branch-moved', `HEAD is detached at ${sha7 ?? 'no commit'}, not on ${branch}`);
    }
    if (ref !== `refs/heads/${branch}`) {
      return fail('branch-moved', `HEAD is on ${ref.replace(/^refs\/heads\//, '')}, not ${branch}`);
    }
    return sha7 !== undefined ? ok(undefined) : fail('branch-moved', `HEAD is on ${branch}, which has no commit (the branch was deleted)`);
  };

  /** `git diff --name-only -z <base>...HEAD` → at most CHECKPOINT_DIFF_PATHS_MAX paths. */
  const changedPaths = async (wt: string, baseCommit: string): Promise<string[] | undefined> => {
    const run = await git(wt, ['diff', '--name-only', '-z', `${baseCommit}...HEAD`, '--'], {
      timeoutMs: GIT_TIMEOUTS_MS.diffNames,
    });
    return run.code === 0 ? zList(run.stdout).slice(0, CHECKPOINT_DIFF_PATHS_MAX) : undefined;
  };

  /** Steps 3–4 of §9.1 in `plan.path`: sparse patterns, phase 2 (A5), LFS. */
  const fill = async (
    plan: WorktreePlan,
    recovered: boolean,
    deadline: number,
    signal: AbortSignal,
  ): Promise<WorktreeResult<{ recovered: boolean; sparse: boolean; lfs: 'none' | 'checked-out' | 'pointers' }>> => {
    const left = (): number => Math.max(1, deadline - Date.now());
    // Sparse: the main checkout's patterns, applied the same way (cone or not).
    const list = await git(plan.repoRoot, ['sparse-checkout', 'list'], { timeoutMs: GIT_TIMEOUTS_MS.quick, signal });
    if (list.aborted) {
      return stepFail('aborted', 'sparse', list);
    }
    const patterns = list.code === 0 ? list.stdout.split('\n').filter((l) => l.trim() !== '') : [];
    const sparse = patterns.length > 0;
    if (sparse) {
      const cone = await git(plan.repoRoot, ['config', '--bool', 'core.sparseCheckoutCone'], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
        signal,
      });
      const mode = cone.stdout.trim() === 'true' ? '--cone' : '--no-cone';
      const set = await git(plan.path, ['sparse-checkout', 'set', mode, '--stdin'], {
        timeoutMs: left(),
        signal,
        stdin: `${patterns.join('\n')}\n`,
      });
      if (set.code !== 0) {
        return stepFail('sparse', 'sparse-checkout set', set);
      }
    }
    if (recovered) {
      // A read-tree cut short leaves its lock behind; ours, when nothing holds it (L5's rule).
      await clearStaleLock(plan.path);
    }
    // Phase 2 (A5): read-tree honours the sparse patterns; checkout-index would not. Recovery
    // re-populates in place (I8 exception a): CONTRACT-QUESTION — `read-tree -mu` refuses to
    // overwrite the untracked files a cut-short attempt already wrote, so the recovery runs
    // `read-tree --reset -u HEAD` (the same tree, overwriting them) instead.
    const phase2 = await git(plan.path, recovered ? ['read-tree', '--reset', '-u', 'HEAD'] : ['read-tree', '-mu', 'HEAD'], {
      timeoutMs: left(),
      signal,
    });
    if (phase2.code !== 0) {
      return stepFail('phase2', 'read-tree', phase2);
    }
    // LFS: when .gitattributes names the filter.
    let lfs: 'none' | 'checked-out' | 'pointers' = 'none';
    const attrs = readTextSafe(path.join(plan.path, '.gitattributes'), GITATTRIBUTES_MAX_BYTES, { noFollow: true });
    if (attrs.ok && /filter=lfs/.test(attrs.text)) {
      const version = await git(plan.path, ['lfs', 'version'], { timeoutMs: GIT_TIMEOUTS_MS.quick, signal });
      if (version.aborted) {
        return stepFail('aborted', 'lfs', version);
      }
      if (version.code === 0) {
        const checkout = await git(plan.path, ['lfs', 'checkout'], { timeoutMs: left(), signal });
        if (checkout.code !== 0) {
          return stepFail('lfs', 'git lfs checkout', checkout);
        }
        lfs = 'checked-out';
      } else {
        lfs = 'pointers';
      }
    }
    return ok({ recovered, sparse, lfs });
  };

  const api: TeamWorktrees = {
    async repository(workspace: string): Promise<WorktreeResult<RepositoryFacts>> {
      const top = await git(workspace, ['rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (top.code !== 0 || top.stdout.trim() === '') {
        return fail('not-git', TEAM_TEXT.notGit(workspace, firstLine(top)));
      }
      const toplevel = realOrResolved(top.stdout.trim());
      const common = await git(workspace, ['rev-parse', '--git-common-dir'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (common.code !== 0 || common.stdout.trim() === '') {
        return stepFail('git', 'rev-parse --git-common-dir', common);
      }
      const said = common.stdout.trim();
      // A relative answer is relative to the directory asked in (or, on old gits, the top level).
      let commonDir = path.isAbsolute(said) ? said : path.resolve(workspace, said);
      if (!fs.existsSync(commonDir) && !path.isAbsolute(said)) {
        commonDir = path.resolve(toplevel, said);
      }
      commonDir = realOrResolved(commonDir);
      const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : toplevel;
      const rel = path.relative(toplevel, realOrResolved(workspace));
      const leadRel = rel === '' || rel.startsWith('..') ? '' : rel.split(path.sep).join('/');
      const status = await git(workspace, ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (status.code !== 0) {
        return stepFail('git', 'status', status);
      }
      return ok({
        repoRoot,
        commonDir,
        leadRel,
        repoHash: meshWorkspaceHash(repoRoot),
        dirtyFiles: status.stdout.split('\n').filter((l) => l.trim() !== '').length,
      });
    },

    // T11 A19: in `cwd` — the lead's workspace (team_create) or its recorded checkout (team_add) —
    // never repoRoot: a lead in a linked worktree has its OWN HEAD, which the members must start from.
    async resolveBase(cwd: string, ref: string): Promise<WorktreeResult<string>> {
      if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-')) {
        return fail('bad-base', `not a commit: ${String(ref)}`);
      }
      const run = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
      });
      const sha = run.stdout.trim();
      return run.code === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)
        ? ok(sha)
        : fail('bad-base', `${ref} names no commit${run.stderr.trim() !== '' ? `: ${firstLine(run)}` : ''}`);
    },

    async freeBytes(dir: string): Promise<number | undefined> {
      let at = path.resolve(dir);
      for (;;) {
        try {
          const st = await fs.promises.statfs(at);
          const free = Number(st.bavail) * Number(st.bsize);
          return Number.isFinite(free) ? free : undefined;
        } catch (err) {
          const parent = path.dirname(at);
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === at) {
            return undefined;
          }
          at = parent;
        }
      }
    },

    async populate(plan, opts) {
      const deadline = Date.now() + opts.timeoutMs;
      const { signal } = opts;
      if (signal.aborted) {
        return fail('aborted', 'stopped before the worktree was created');
      }
      // Recovery first (H6): a worktree registered for the branch at this path, tip still the base.
      const listed = await git(plan.repoRoot, ['worktree', 'list', '--porcelain'], { timeoutMs: GIT_TIMEOUTS_MS.quick, signal });
      if (listed.code !== 0) {
        return stepFail('git', 'worktree list', listed);
      }
      const ref = `refs/heads/${plan.branch}`;
      const registered = parseWorktreeList(listed.stdout).find((w) => w.branch === ref);
      const tip = await git(plan.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
        signal,
      });
      if (tip.aborted) {
        return stepFail('aborted', 'rev-parse', tip);
      }
      if (registered !== undefined) {
        const samePath = realOrResolved(registered.path) === realOrResolved(plan.path);
        if (samePath && tip.code === 0 && tip.stdout.trim() === plan.baseCommit) {
          return fill(plan, true, deadline, signal);
        }
        return fail(
          'worktree_exists',
          samePath
            ? `worktree_exists: ${plan.path} is registered for ${plan.branch}, whose tip moved off ${plan.baseCommit.slice(0, 10)}`
            : `worktree_exists: ${plan.branch} is checked out in another worktree (${registered.path})`,
        );
      }
      if (tip.code === 0) {
        return fail('branch_exists', `branch_exists: ${plan.branch} exists and no worktree is registered for it`);
      }
      if (!pathFree(plan.path)) {
        return fail('worktree_exists', `worktree_exists: ${plan.path} exists and is not a worktree of ${plan.branch}`);
      }
      // Phase 1: register the worktree and the branch, nothing checked out (fast).
      try {
        fs.mkdirSync(path.dirname(plan.path), { recursive: true, mode: TEAM_DIR_MODE });
      } catch (err) {
        return fail('phase1', `worktree add: cannot create ${path.dirname(plan.path)} (${(err as NodeJS.ErrnoException).code ?? 'EIO'})`);
      }
      const phase1 = await git(
        plan.repoRoot,
        ['worktree', 'add', '--no-checkout', '-b', plan.branch, plan.path, plan.baseCommit],
        { timeoutMs: Math.min(GIT_TIMEOUTS_MS.worktreePhase1, Math.max(1, deadline - Date.now())), signal },
      );
      if (phase1.code !== 0) {
        return stepFail('phase1', 'worktree add', phase1);
      }
      return fill(plan, false, deadline, signal);
    },

    runSetup(dir, setup, opts) {
      return new Promise((resolve) => {
        const minutes = Math.round(setup.timeoutMs / 60_000);
        const failed = (exit: number, line: string): void =>
          resolve(fail('setup', TEAM_NOTICE.setupFailed(exit, sliceOneLine(flattenOneLine(line), 200))));
        if (opts.signal.aborted) {
          resolve(fail('aborted', 'setup: stopped before it started'));
          return;
        }
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of SESSION_IDENTITY_ENV) {
          delete env[name];
        }
        env[TEAM_MEMBER_ENV] = setup.teamMemberEnv;
        const [cmd, ...args] = setup.argv;
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cmd, args, {
            cwd: dir,
            env,
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          failed(-1, (err as Error).message);
          return;
        }
        let lastLine = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const stop = (): void => {
          killGroup(child.pid, 'SIGTERM');
          killTimer ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), GIT_KILL_GRACE_MS);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, Math.max(1, setup.timeoutMs));
        const onAbort = (): void => {
          aborted = true;
          stop();
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        const partial = { out: '', err: '' };
        const emit = (line: string): void => {
          const flat = flattenOneLine(line);
          if (flat === '') {
            return;
          }
          lastLine = flat;
          try {
            opts.onLine(Buffer.from(flat, 'utf8').subarray(0, FEED_TEXT_MAX_BYTES).toString('utf8').replace(/�$/, ''));
          } catch {
            // the engine's feed must not fail the setup
          }
        };
        const reader = (key: 'out' | 'err') => (chunk: string) => {
          const pieces = (partial[key] + chunk).split('\n');
          partial[key] = pieces.pop() ?? '';
          if (Buffer.byteLength(partial[key]) > FEED_TEXT_MAX_BYTES) {
            emit(partial[key]);
            partial[key] = '';
          }
          pieces.forEach(emit);
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', reader('out'));
        child.stderr?.on('data', reader('err'));
        const settle = (code: number | null, spawnError?: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          opts.signal.removeEventListener('abort', onAbort);
          emit(partial.out);
          emit(partial.err);
          if (aborted) {
            resolve(fail('aborted', 'setup: stopped (the lead session ended)'));
          } else if (spawnError !== undefined) {
            failed(-1, spawnError);
          } else if (timedOut) {
            failed(-1, `timed out after ${minutes} minutes`);
          } else if (code !== 0) {
            failed(code ?? -1, lastLine === '' ? '(no output)' : lastLine);
          } else {
            resolve(ok(undefined));
          }
        };
        child.on('error', (err) => {
          if (child.pid === undefined) {
            settle(null, `${cmd}: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
          }
        });
        child.on('exit', (code) => setTimeout(() => settle(code), 250));
        child.on('close', (code: number | null) => settle(code));
      });
    },

    async check(wt) {
      try {
        if (!fs.statSync(wt.path).isDirectory()) {
          return fail('missing', `${wt.path} is not a directory`);
        }
      } catch {
        return fail('missing', `${wt.path} does not exist`);
      }
      const top = await git(wt.path, ['rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (top.code !== 0) {
        return /not a git repository/i.test(top.stderr)
          ? fail('missing', `${wt.path} is no longer a registered worktree: ${firstLine(top)}`)
          : stepFail('git', 'rev-parse', top);
      }
      if (realOrResolved(top.stdout.trim()) !== realOrResolved(wt.path)) {
        return fail('missing', `${wt.path} is no longer a worktree of its own`);
      }
      return headOn(wt.path, wt.branch);
    },

    async restore(wt) {
      const tip = await git(wt.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}^{commit}`], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
      });
      if (tip.code !== 0) {
        return fail('git', `branch ${wt.branch} does not exist; the worktree cannot be recreated`);
      }
      try {
        fs.mkdirSync(path.dirname(wt.path), { recursive: true, mode: TEAM_DIR_MODE });
      } catch (err) {
        return fail('git', `cannot create ${path.dirname(wt.path)} (${(err as NodeJS.ErrnoException).code ?? 'EIO'})`);
      }
      const addOnce = (): Promise<GitRun> =>
        git(wt.repoRoot, ['worktree', 'add', wt.path, wt.branch], { timeoutMs: GIT_TIMEOUTS_MS.worktreePhase1 });
      let add = await addOnce();
      if (add.code !== 0 && !add.timedOut && !fs.existsSync(wt.path)) {
        // T11 A22: a worktree the user deleted without `git worktree prune` stays registered, and
        // git refuses the add ("missing but already registered worktree"). When git registers
        // EXACTLY this path and no directory is there, `prune --expire now` drops the registrations
        // of missing directories (no file, no branch — within I8) and the add is tried once more.
        const listed = await git(wt.repoRoot, ['worktree', 'list', '--porcelain'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
        const target = canonicalPath(wt.path);
        if (listed.code === 0 && parseWorktreeList(listed.stdout).some((w) => canonicalPath(w.path) === target)) {
          const prune = await git(wt.repoRoot, ['worktree', 'prune', '--expire', 'now'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
          if (prune.code !== 0) {
            return stepFail('git', 'worktree prune', prune);
          }
          add = await addOnce();
        }
      }
      return add.code === 0 ? ok(undefined) : stepFail('git', 'worktree add', add);
    },

    // T11 A18 (I14): the project's `.mcp.json` as it is at the BASE commit, never the worktree copy
    // (a member could write servers there and have its CLI start them). `ls-tree` tells "absent at
    // the base" (ok, undefined) from a git failure; `cat-file` reads the blob it names.
    // `--no-replace-objects`: a `refs/replace/` object a member created in the shared repository must
    // not substitute the base's content. Not a blob (a link, a directory), not UTF-8 JSON of an
    // object → ok with undefined and no file; over MCP_FILE_MAX_BYTES → `git` (the engine says so).
    async projectMcpFile(wt: { path: string; baseCommit: string; outFile: string }): Promise<WorktreeResult<string | undefined>> {
      const rel = CLAUDE_PROJECT_MCP_FILE;
      const drop = (): void => {
        try {
          fs.unlinkSync(wt.outFile);
        } catch {
          // absent already
        }
      };
      if (!SHA_RE.test(wt.baseCommit)) {
        return fail('git', `${rel}: not a commit: ${String(wt.baseCommit)}`);
      }
      const at = wt.baseCommit.slice(0, 7);
      const listed = await git(wt.path, ['--no-replace-objects', 'ls-tree', '-l', '-z', wt.baseCommit, '--', rel], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
      });
      if (listed.code !== 0) {
        return stepFail('git', `ls-tree ${at} ${rel}`, listed);
      }
      const entry = zList(listed.stdout)[0];
      // `<mode> SP <type> SP <object> SP+ <size> TAB <path>`
      const m = entry === undefined ? null : /^(\d{6}) (\w+) ([0-9a-f]+)\s+(\d+|-)\t/.exec(entry);
      if (m === null || m[2] !== 'blob' || m[1] === '120000') {
        drop();
        return ok(undefined);
      }
      if (Number(m[4]) > MCP_FILE_MAX_BYTES) {
        drop();
        return fail('git', `${rel} at ${at} is over ${MCP_FILE_MAX_BYTES} bytes; not passed`);
      }
      const shown = await git(wt.path, ['--no-replace-objects', 'cat-file', 'blob', m[3]], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
        maxStdout: MCP_FILE_MAX_BYTES,
      });
      if (shown.code !== 0) {
        return stepFail('git', `cat-file ${at}:${rel}`, shown);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(shown.stdout);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        drop();
        return ok(undefined);
      }
      try {
        writeFileAtomic(wt.outFile, shown.stdout);
      } catch (err) {
        return fail('git', `cannot write ${wt.outFile}: ${(err as NodeJS.ErrnoException).code ?? 'EIO'}`);
      }
      return ok(wt.outFile);
    },

    async writeVendorMcp(dir: string, provider: ProviderId, config: TeamMcpConfig) {
      const rel = VENDOR_MCP_FILES[provider];
      if (rel === undefined) {
        return ok(undefined);
      }
      const file = path.join(dir, rel);
      const tracked = await git(dir, ['ls-files', '-z', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (tracked.code !== 0) {
        return stepFail('git', 'ls-files', tracked);
      }
      if (zList(tracked.stdout).length > 0) {
        // TRACKED: the merge of the INDEX version (so repeated writes never compound) and ours.
        const shown = await git(dir, ['show', `:${rel}`], { timeoutMs: GIT_TIMEOUTS_MS.quick, maxStdout: MCP_FILE_MAX_BYTES });
        if (shown.code !== 0) {
          return stepFail('git', `show :${rel}`, shown);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(shown.stdout);
        } catch {
          parsed = undefined;
        }
        const servers = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          typeof servers !== 'object' ||
          servers === null ||
          Array.isArray(servers)
        ) {
          return fail('mcp-merge', `cannot merge ${rel}: not an mcpServers file`);
        }
        const merged = {
          ...(parsed as Record<string, unknown>),
          mcpServers: { ...(servers as Record<string, unknown>), cco_team: config.mcpServers.cco_team },
        };
        const refused = writeFileInWorktree(dir, rel, `${JSON.stringify(merged, null, 2)}\n`);
        if (refused !== undefined) {
          return fail('mcp-merge', `cannot write ${rel}: ${refused}`);
        }
        // A SPARSE worktree (A5): git (≥ 2.37) clears the skip-worktree bit of every file present on
        // disk at its next index read unless sparse.expectFilesOutsideOfPatterns is true — measured
        // 2026-10-16 (git 2.39): `S` turned back into `H` at once and the file read modified. Set
        // in the member's OWN worktree config (`config --worktree`: <git-dir>/worktrees/<id>/
        // config.worktree; `sparse-checkout set` already turned extensions.worktreeConfig on), so
        // the main checkout and the other members are untouched. Not sparse → nothing to do.
        const sparse = await git(dir, ['config', '--bool', 'core.sparseCheckout'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
        if (sparse.code === 0 && sparse.stdout.trim() === 'true') {
          const keep = await git(dir, ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
          if (keep.code !== 0) {
            return stepFail('git', 'config --worktree sparse.expectFilesOutsideOfPatterns', keep);
          }
        }
        const skip = await git(dir, ['update-index', '--skip-worktree', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
        if (skip.code !== 0) {
          return stepFail('git', 'update-index --skip-worktree', skip);
        }
        return ok({ file, tracked: true });
      }
      const refused = writeFileInWorktree(dir, rel, `${JSON.stringify(config, null, 2)}\n`);
      if (refused !== undefined) {
        return fail('mcp-merge', `cannot write ${rel}: ${refused}`);
      }
      return ok({ file, tracked: false });
    },

    async removeVendorMcp(dir: string, provider: ProviderId) {
      const rel = VENDOR_MCP_FILES[provider];
      if (rel === undefined) {
        return ok(undefined);
      }
      const tracked = await git(dir, ['ls-files', '-z', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (tracked.code !== 0) {
        return stepFail('git', 'ls-files', tracked);
      }
      if (zList(tracked.stdout).length > 0) {
        return ok(undefined);
      }
      // A17: only through real directories — `.cursor` replaced by a link to the user's own
      // `.cursor` (or another member's) would otherwise delete THAT directory's mcp.json.
      const descent = dirDescent(dir, rel, false);
      if (!descent.ok) {
        return descent.why === 'is missing' ? ok(undefined) : fail('git', `${rel} was not deleted: ${descent.at} ${descent.why}`);
      }
      try {
        const st = fs.lstatSync(path.join(dir, rel));
        if (st.isDirectory()) {
          return fail('git', `${rel} is a directory; it was left as it is`);
        }
        // A link AT the name is removed itself (unlink never follows it).
        fs.unlinkSync(path.join(dir, rel));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return fail('git', `cannot delete ${rel}: ${(err as NodeJS.ErrnoException).code ?? 'EIO'}`);
        }
      }
      return ok(undefined);
    },

    async restoreVendorMcp(dir: string, provider: ProviderId) {
      const rel = VENDOR_MCP_FILES[provider];
      if (rel === undefined) {
        return ok(false);
      }
      const listed = await git(dir, ['ls-files', '-v', '-z', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (listed.code !== 0) {
        return stepFail('git', 'ls-files -v', listed);
      }
      const entry = zList(listed.stdout)[0];
      if (entry === undefined || !/^[Ss] /.test(entry)) {
        return ok(false);
      }
      // A17: git writes the file back — only through real directories. Measured 2026-10-16 (git
      // 2.39): `checkout -- .cursor/mcp.json` with `.cursor` a planted link answers success, so git's
      // own handling is not relied on. Refused before anything changes: the skip bit stays set.
      const descent = dirDescent(dir, rel, false);
      if (!descent.ok && descent.why !== 'is missing') {
        return fail('git', `${rel} was not restored: ${descent.at} ${descent.why}`);
      }
      const unskip = await git(dir, ['update-index', '--no-skip-worktree', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (unskip.code !== 0) {
        return stepFail('git', 'update-index --no-skip-worktree', unskip);
      }
      const checkout = await git(dir, ['checkout', '--', rel], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      return checkout.code === 0 ? ok(true) : stepFail('git', `checkout -- ${rel}`, checkout);
    },

    async checkpoint(input): Promise<WorktreeResult<CheckpointOutcome>> {
      const { signal } = input;
      const wt = input.path;
      // T11 A21, FIRST: HEAD must be the member's branch. A member that checked out another branch
      // or detached HEAD would otherwise get its turn committed THERE — the branch the lead merges
      // does not move and a detached commit dangles. Nothing is added or committed; the files stay.
      const where = await headOn(wt, input.branch, signal);
      if (!where.ok) {
        return where.code === 'branch-moved' ? fail('branch-moved', `${where.text}; nothing was committed`) : where;
      }
      const first = await dirty(wt, [], signal);
      if (first.code !== 0) {
        return stepFail('git', 'status', first);
      }
      if (!first.dirty) {
        return ok({ committed: false, skipped: [] });
      }
      // M23: untracked files too large (unless LFS-tracked) or secret-like stay out. T11 A32: so does
      // an untracked directory holding a `.git` (a repository the member cloned or init'ed): `add`
      // would record it as a gitlink with no `.gitmodules` — a dangling submodule in the lead's
      // merge. git lists such a directory as one `?? <dir>/` entry even with --untracked-files=all.
      const all = await git(wt, ['status', '--porcelain', '-z', '--untracked-files=all'], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (all.code !== 0) {
        return stepFail('git', 'status', all);
      }
      const skips: string[] = [];
      const large: string[] = [];
      for (const entry of zList(all.stdout)) {
        if (!entry.startsWith('?? ')) {
          continue;
        }
        const rel = entry.slice(3);
        if (rel.endsWith('/')) {
          try {
            fs.lstatSync(path.join(wt, rel, '.git'));
            skips.push(rel);
          } catch {
            // no repository inside: git expands every other untracked directory into its files
          }
          continue;
        }
        if (isCheckpointSkipName(path.posix.basename(rel))) {
          skips.push(rel);
          continue;
        }
        try {
          if (fs.lstatSync(path.join(wt, rel)).size > CHECKPOINT_FILE_MAX) {
            large.push(rel);
          }
        } catch {
          // gone meanwhile
        }
      }
      if (large.length > 0) {
        const attr = await git(wt, ['check-attr', '-z', 'filter', '--', ...large], { timeoutMs: GIT_TIMEOUTS_MS.quick });
        const lfs = new Set<string>();
        if (attr.code === 0) {
          const f = zList(attr.stdout);
          for (let i = 0; i + 2 < f.length; i += 3) {
            if (f[i + 2] === 'lfs') {
              lfs.add(f[i]);
            }
          }
        }
        skips.push(...large.filter((p) => !lfs.has(p)));
      }
      skips.sort();
      // A directory's pathspec is its name without the trailing `/` (it then covers what is under it).
      const skipSpecs = skips.map((p) => literalExclude(p.replace(/\/$/, '')));
      const skipped = skips.slice(0, CHECKPOINT_SKIPPED_MAX);
      if (skips.length > 0) {
        const again = await dirty(wt, skipSpecs, signal);
        if (again.code !== 0) {
          return stepFail('git', 'status', again);
        }
        if (!again.dirty) {
          return ok({ committed: false, skipped });
        }
      }

      // add, then commit — each retried ONCE after a stale index.lock was removed (L5).
      const withLock = async (step: string, args: readonly string[], stdin?: string): Promise<WorktreeResult<GitRun>> => {
        for (let attempt = 0; ; attempt++) {
          const run = await git(wt, args, {
            timeoutMs: GIT_TIMEOUTS_MS.checkpoint,
            ...(signal !== undefined ? { signal } : {}),
            ...(stdin !== undefined ? { stdin } : {}),
          });
          if (run.code === 0 || run.aborted) {
            return run.code === 0 ? ok(run) : stepFail('aborted', step, run);
          }
          if (!lockedOut(run)) {
            return ok(run);
          }
          if (attempt > 0 || (await clearStaleLock(wt)) !== 'removed') {
            return fail('lock', `${step}: ${firstLine(run)}`);
          }
        }
      };
      const add = await withLock('add', ['add', '-A', '--', '.', ...CHECKPOINT_EXCLUDES, ...skipSpecs]);
      if (!add.ok) {
        return add;
      }
      if (add.value.code !== 0) {
        return stepFail('git', 'add', add.value);
      }
      const commit = await withLock(
        'commit',
        [
          '-c',
          `user.name=${CHECKPOINT_IDENTITY.name}`,
          '-c',
          `user.email=${CHECKPOINT_IDENTITY.email}`,
          'commit',
          '--no-verify',
          '--no-gpg-sign',
          '-q',
          '-F',
          '-',
        ],
        input.message,
      );
      if (!commit.ok) {
        return commit;
      }
      if (commit.value.code !== 0) {
        if (/nothing (added )?to commit/.test(commit.value.stdout + commit.value.stderr)) {
          return ok({ committed: false, skipped });
        }
        return stepFail('git', 'commit', commit.value);
      }
      const head = await git(wt, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      const sha = head.stdout.trim();
      if (head.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
        return stepFail('git', 'rev-parse HEAD', head);
      }
      // The commit stands even when the names cannot be read: an empty touched list then.
      const names = (await changedPaths(wt, input.baseCommit)) ?? [];
      const touched = names.slice(0, CHECKPOINT_TOUCHED_MAX);
      const outsideOwnership =
        input.ownedPaths.length === 0 ? [] : touched.filter((p) => !input.ownedPaths.some((own) => pathsOverlap(own, p)));
      return ok({ committed: true, sha, filesChanged: names.length, touched, outsideOwnership, skipped });
    },

    async readStash(repoRoot: string) {
      const has = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/stash'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (has.code === 1) {
        return ok('');
      }
      if (has.code !== 0) {
        return stepFail('git', 'rev-parse refs/stash', has);
      }
      const log = await git(repoRoot, ['reflog', 'show', '--format=%H', 'refs/stash', '--'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      return log.code === 0 ? ok(log.stdout.trim()) : stepFail('git', 'reflog refs/stash', log);
    },

    async facts(wt) {
      const head = await git(wt.path, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      const headSha = head.stdout.trim();
      if (head.code !== 0 || headSha === '') {
        return stepFail('git', 'rev-parse HEAD', head);
      }
      const ahead = await git(wt.path, ['rev-list', '--count', `${wt.baseCommit}..HEAD`], { timeoutMs: GIT_TIMEOUTS_MS.quick });
      if (ahead.code !== 0) {
        return stepFail('git', 'rev-list --count', ahead);
      }
      const names = await changedPaths(wt.path, wt.baseCommit);
      if (names === undefined) {
        return fail('git', 'diff --name-only failed');
      }
      const d = await dirty(wt.path);
      if (d.code !== 0) {
        return stepFail('git', 'status', d);
      }
      const merged = await git(wt.leadCheckout, ['merge-base', '--is-ancestor', headSha, 'HEAD'], {
        timeoutMs: GIT_TIMEOUTS_MS.quick,
      });
      if (merged.code !== 0 && merged.code !== 1) {
        return stepFail('git', 'merge-base --is-ancestor', merged);
      }
      return ok({
        headSha,
        ahead: Number.parseInt(ahead.stdout.trim(), 10) || 0,
        filesChanged: names.length,
        dirty: d.dirty,
        merged: merged.code === 0,
      });
    },

    async handoffFacts(wt) {
      const fact = async (args: readonly string[]): Promise<string | { unavailable: string }> => {
        const run = await git(wt.path, args, { timeoutMs: GIT_TIMEOUTS_MS.packetFact, maxStdout: PACKET_FACT_MAX_BYTES });
        return run.code === 0 ? run.stdout.replace(/\s+$/, '') : { unavailable: firstLine(run) };
      };
      const [commits, uncommitted, diffStat] = await Promise.all([
        fact(['log', '--oneline', '--no-decorate', `${wt.baseCommit}..HEAD`, '--']),
        fact(['status', '--porcelain']),
        fact(['diff', '--stat', `${wt.baseCommit}..HEAD`, '--']),
      ]);
      return { commits, uncommitted, diffStat };
    },

    overlapOf(touched) {
      const byPath = new Map<string, Set<string>>();
      for (const [member, paths] of Object.entries(touched)) {
        for (const p of paths) {
          const set = byPath.get(p) ?? new Set<string>();
          set.add(member);
          byPath.set(p, set);
        }
      }
      const paths = [...byPath.entries()].filter(([, members]) => members.size > 1).map(([p]) => p).sort();
      if (paths.length === 0) {
        return undefined;
      }
      const members = new Set<string>();
      for (const p of paths) {
        for (const m of byPath.get(p) ?? []) {
          members.add(m);
        }
      }
      return { members: [...members].sort(), paths };
    },
  };
  return api;
};
