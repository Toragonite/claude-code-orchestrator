import * as os from 'os';
import * as path from 'path';
import { runMeshProcess, type ProcOutcome } from './pool';
import { claudeEnv } from '../platform';
import { isPidAlive } from '../registry';

/**
 * mesh/bg-liveness — the reusable answer to ONE question: which `claude --bg` job ids are
 * PROVABLY RUNNING right now, and which config dirs could not be asked at all.
 *
 * WHY A LISTING AND NOT THE PROCESS TREE. A `--bg` session belongs to the CLI's background
 * service, not to the process that spawned it: it is not our child, and it outlives the
 * session that dispatched it. There is no parent/child edge to walk and no handle to wait on,
 * so the only truth available is `claude agents --json` taken under the worker's OWN account
 * config dir. Everything below is what that listing was empirically observed to do, not what
 * it looks like it should do — each rule is written next to the failure it prevents.
 *
 *  - RUN WITHOUT `--all`. With `--all` the listing also carries FINISHED sessions, so every
 *    completed worker in a workspace's history would answer "alive".
 *
 *  - `kind === "background"` IS A CORRECTNESS FILTER, NOT A RELEVANCE FILTER. Both kinds of
 *    row are read out of `<configDir>/sessions/`, and THIS CODEBASE's own bridge MIRRORS
 *    worker entries into the host account's sessions dir (`ccoMirror: true` copies of
 *    another account's entries; a v1.x server mirrored into every account). Enumerating
 *    several config dirs without the filter therefore reports the same session once per dir,
 *    and a row mirrored out of account A would vouch for a job that belongs to account B.
 *    This function has no mirror guard anywhere else — the kind filter IS the guard.
 *
 *  - PRESENCE IN THE LISTING IS NOT LIVENESS, even without `--all`. Verified against the
 *    shipped CLI binary: a background row is emitted when a live process record exists OR when
 *    the PERSISTED state merely classifies as working/blocked. A worker killed abruptly —
 *    reboot, OOM, `pkill`, battery death — leaves exactly that persisted "working" behind, so
 *    a presence test reports every victim of a crash as a running worker. Acting on that
 *    answer means trying to stop sessions that do not exist, or worse, believing a dead
 *    generation is alive.
 *
 *  - THE `pid` IS THE PROOF, and the only one the listing offers: a LIVE background row
 *    carries `pid` and `status`, a stopped one carries neither (probed on 2.1.283). Liveness
 *    here is therefore exactly `kind === 'background' && typeof row.pid === 'number' &&
 *    isPidAlive(row.pid)`; a row without `pid` is GONE.
 *
 *  - `state` IS NEVER MATCHED. It is a class the MODEL writes about its own work (`working`,
 *    `blocked`, `done`) and is derived from persisted data rather than from the process —
 *    so a string test there is a guess dressed as a check. `status` (`busy` | `idle`) is
 *    the mechanical truth, and it is REPORTED per live job (`statuses`) but never used to
 *    decide liveness: a worker parked at `idle` is exactly as alive as a busy one.
 *
 *  - IDENTITY IS `row.id === jobId`, NEVER THE NAME. `row.id` is the first 8 hex characters of
 *    the session UUID and equals the ledger's `jobId`. Worker NAMES are reused across
 *    generations, so a name match can resolve to a dead namesake (reporting a corpse as live)
 *    or to a DIFFERENT live worker (reporting somebody else's healthy session as ours to
 *    stop). This module never sees a name at all, which is the strongest form of that rule.
 *
 * WHY `configDirs` IS THE PARAMETER IT IS — READ THIS BEFORE CHANGING THE SIGNATURE.
 * `claude agents --json` WRITES to the config dir it is aimed at: it REWRITES that dir's
 * `.claude.json` (reproduced against a dir that already held one) and CREATES a `backups/`
 * directory beside it. No property of an untrusted path can make aiming a writing child at it
 * safe — the old "is this an initialized config dir?" test passed `$HOME` itself. So this
 * function takes ALREADY-TRUSTED, ABSOLUTE dirs from its caller and deliberately
 * does NOT read the registry, the ledger, or any other file to obtain them: the trust decision
 * belongs to the caller that knows which accounts the OPERATOR configured, and a second
 * implementation of that decision in here would be one more place for it to drift. Each dir
 * is used VERBATIM — it is what platform.claudeEnv derives the child's environment from, and
 * the CLI keys an account's credentials to the exact string — so the caller passes the
 * registry's own spelling and gets its results back under that same spelling. Values that
 * are not absolute are reported unchecked and never probed (a relative or `~`-prefixed value
 * resolved against a spawn cwd would create `.claude.json` and `backups/` inside a user's
 * repo). Nothing here stats or opens a caller-supplied path, so a dir naming a hung network
 * mount can only ever be a string.
 *
 * AN EMPTY `live` SET IS NOT "NOTHING IS ALIVE" WHEN `unchecked` IS NON-EMPTY. It is UNKNOWN,
 * and the distinction is the difference between leaving a running worker alone and destroying
 * its work. Every config dir that was not successfully read lands in `unchecked` with a human
 * reason — a dir that timed out, exited non-zero, printed noise, or was skipped by a cap is
 * NEVER folded into an empty listing. Callers that treat `live.size === 0` as permission to
 * reap MUST check `unchecked.length === 0` first.
 *
 * TWO RESIDUALS, written down rather than left implicit:
 *  - `live` is a UNION across the dirs probed, so it answers "is this job id alive under ANY
 *    of the dirs you gave me", not "under its own account". With the background filter above
 *    that is sound for the intended use (job ids are session-unique), but a caller that must
 *    attribute liveness to a SPECIFIC account should call this once per config dir and keep
 *    the sets apart.
 *  - PID RECYCLING is not fixed here. The OS may hand a dead worker's pid to an unrelated
 *    process, which makes that row look live — the OVER-reporting direction. It is bounded by
 *    the pid coming from the CLI's own live-process record FOR THIS JOB ID (so it can only be
 *    wrong between that record going stale and the row disappearing), and this module signals
 *    nothing itself. A caller that intends to KILL what this reports owes it a command-line
 *    confirmation first.
 *
 * This module answers liveness and nothing else: no workspace-boundary test on the row's
 * `cwd`, no ownership judgement, no writes to any state we own, and no global state.
 * vscode-free; node18 stdlib plus ./pool, ../platform and ../registry.
 */

/** Per-config-dir bound on one `claude agents --json` probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/**
 * Wall-clock cap across ALL probes. Each probe is already bounded on its own —
 * runMeshProcess settles on the child's 'exit' (never on 'close', which a grandchild
 * holding the inherited stdout pipe can delay for as long as it likes) and SIGKILLs at the
 * per-dir timeout — so this is the bound on the SUM: several slow accounts probed together
 * must still answer a caller that is waiting on all of them. Probes still out when it fires
 * are reported UNCHECKED — never as an empty listing.
 */
const DEFAULT_PROBE_BUDGET_MS = 10_000;
/**
 * Ceiling on the number of config dirs actually probed, i.e. on the subprocesses ONE call may
 * spawn. Callers poll this, and the dir count comes from a file that can hold anything, so
 * without a cap a large or hostile input turns every poll into a spawn storm. Dirs past the cap
 * are REPORTED as unchecked: silent truncation is the failure to avoid, because a short list
 * that reads as "everything was covered" is the one answer that lets a live worker pass
 * unnoticed.
 */
const DEFAULT_MAX_CONFIG_DIRS = 8;
/**
 * A listing longer than this is not one we recognise, so the DIR is reported unchecked rather
 * than half-parsed. Bounds the work one hostile `claude` stand-in on PATH can impose per dir.
 */
const MAX_ROWS_PER_LISTING = 1_000;
/** A row `status` longer than this is not a status token and is not reported. */
const MAX_STATUS_CHARS = 32;

export interface BgLiveness {
  /** jobIds proven ALIVE: present in the non---all listing WITH a live pid. */
  live: Set<string>;
  /**
   * The listing's `status` for each LIVE job id that carried one as a string (`busy` or
   * `idle` on 2.1.283) — what lets a caller tell a worker mid-turn from one that is parked.
   * A key here is always also in `live`; a live job the listing gave no status for is
   * simply absent. Never an input to liveness.
   */
  statuses: Map<string, string>;
  /** configDirs that could not be checked, with a human reason — reported, never swallowed. */
  unchecked: Array<{ configDir: string; reason: string }>;
}

/** One live background row: its job id and, when the listing stated one, its status. */
interface LiveRow {
  id: string;
  status?: string;
}

/** One config dir's outcome: exactly one of `rows` / `reason` is ever set. */
interface DirProbe {
  configDir: string;
  /** The jobs this dir's listing proved alive (possibly none — that is a real answer). */
  rows?: LiveRow[];
  /** Why this dir contributed no answer at all. Present ⇒ the dir is UNKNOWN, not clean. */
  reason?: string;
}

/** Where probe children are spawned, and whether that is the caller's dir or a fallback. */
interface SpawnDir {
  cwd: string;
  /** True when the caller supplied no usable cwd and we had to pick one, so a spawn error can
   *  still be told apart from a bad hand-off in the reason we print. */
  fellBack: boolean;
}

/**
 * Probe `claude agents --json` under each TRUSTED config dir. Never throws.
 *
 * `configDirs` MUST already be trusted and absolute — the probe WRITES to the dir it targets
 * (see the header). Nothing here resolves or normalizes them: the string is the account's
 * identity to the CLI (platform.claudeEnv), and it is also the key `unchecked` reports a dir
 * under, so the caller matches results back through exactly what it passed in.
 *
 * Totality is the contract, in both directions:
 *  - NEVER THROWS, for any outcome — missing binary, spawn failure, non-zero exit, timeout,
 *    empty output, non-JSON, non-array, malformed rows, a listing longer than the row cap.
 *  - EVERY dir that was not successfully read is named in `unchecked` with a reason. An empty
 *    `live` with a non-empty `unchecked` means UNKNOWN and must never be read as "nothing is
 *    alive" (header).
 *  - Degradation is PER DIR: one dir timing out cannot discard a healthy sibling's rows, and a
 *    single malformed ROW is skipped while the rest of that listing still counts.
 *  - `claudePath === undefined` (or empty) ⇒ every valid dir unchecked, ZERO spawns. Resolving
 *    an executable here could spawn a login shell, which a status poll may not do.
 *  - An empty `configDirs` ⇒ empty result, ZERO spawns, no error.
 *
 * Options are validated by VALUE, not presence, because they reach us from settings files and
 * untyped callers: a non-number, non-finite or negative `timeoutMs`/`budgetMs`/`maxConfigDirs`
 * falls back to its default. `maxConfigDirs: 0` is honoured as an explicit "probe nothing" —
 * every dir then lands unchecked, which is the honest, spawn-free answer rather than a
 * clean-looking empty one.
 *
 * Cap order: dirs are probed in the order the CALLER supplied them and the cap slices off the
 * TAIL, so the caller decides priority (ledger append order puts the OLDEST records first —
 * a caller that cares about the newest worker must sort before calling). Duplicates are folded
 * into a single probe of that dir: two spawns aimed at one WRITING target would be two writes
 * and two cap slots for one answer, and the single outcome is still reported under that dir.
 */
export async function probeBgLiveness(opts: {
  claudePath: string | undefined;
  configDirs: string[]; // caller supplies ALREADY-TRUSTED, absolute dirs, spelled as the registry spells them
  spawnCwd: string;
  timeoutMs?: number; // per dir, default 5_000
  budgetMs?: number; // overall, default 10_000
  maxConfigDirs?: number; // default 8
}): Promise<BgLiveness> {
  const live = new Set<string>();
  const statuses = new Map<string, string>();
  const unchecked: Array<{ configDir: string; reason: string }> = [];
  // Every option is read defensively: this is called from a status poll that must answer even
  // when the object it was handed is not what the type says.
  const given = Array.isArray(opts?.configDirs) ? opts.configDirs : [];
  if (given.length === 0) {
    // Zero dirs is a complete answer, not a degraded one: nothing was asked, so nothing is
    // unchecked, and no child is spawned.
    return { live, statuses, unchecked };
  }

  // Validate and dedupe BEFORE the cap. An invalid dir spawns nothing, so it must not consume
  // a cap slot — otherwise a handful of junk entries push every real dir past the cap and the
  // whole probe comes back "skipped", which is this feature defeated for the price of a few
  // ledger lines.
  const targets: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < given.length; i++) {
    const raw = given[i];
    if (typeof raw !== 'string') {
      // Named by INDEX, never by String(raw): a hostile or exotic value's own toString could
      // throw out of a function that is documented never to throw.
      unchecked.push({
        configDir: `<non-string entry at index ${i}>`,
        reason: 'is not a string, so it was not probed',
      });
      continue;
    }
    if (raw === '') {
      // An empty CLAUDE_CONFIG_DIR is not "no dir": it is the CLI's AMBIENT account, so probing
      // it would answer a question about a different account than the caller asked about.
      unchecked.push({ configDir: raw, reason: 'is empty, so it was not probed' });
      continue;
    }
    if (!path.isAbsolute(raw)) {
      unchecked.push({
        configDir: raw,
        reason: 'is not an absolute path, so it was not probed — a probe WRITES to the config dir it targets',
      });
      continue;
    }
    if (seen.has(raw)) {
      continue; // folded into that dir's single probe; its outcome is still reported once
    }
    seen.add(raw);
    targets.push(raw);
  }

  const claudePath = typeof opts.claudePath === 'string' && opts.claudePath !== '' ? opts.claudePath : undefined;
  if (claudePath === undefined) {
    for (const configDir of targets) {
      unchecked.push({ configDir, reason: 'no claude executable was supplied, so nothing was probed' });
    }
    return { live, statuses, unchecked };
  }

  const maxConfigDirs = intOption(opts.maxConfigDirs, DEFAULT_MAX_CONFIG_DIRS, 0);
  const timeoutMs = intOption(opts.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 1);
  const budgetMs = intOption(opts.budgetMs, DEFAULT_PROBE_BUDGET_MS, 1);
  for (const configDir of targets.slice(maxConfigDirs)) {
    unchecked.push({
      configDir,
      reason: `skipped: only ${maxConfigDirs} config dir(s) are probed per call, in the order they were supplied`,
    });
  }
  const probeTargets = targets.slice(0, maxConfigDirs);
  if (probeTargets.length === 0) {
    return { live, statuses, unchecked };
  }

  const spawnDir = usableSpawnDir(opts.spawnCwd);
  // The overall budget is ONE timer shared by every probe, raced against each of them. A probe
  // that loses the race is abandoned (its child is still bounded by its own timeout) and
  // reported unchecked — the one thing it may never become is an empty listing.
  let budgetTimer: NodeJS.Timeout | undefined;
  const budgetExhausted = new Promise<'budget'>((resolve) => {
    budgetTimer = setTimeout(() => resolve('budget'), budgetMs);
  });
  let results: DirProbe[];
  try {
    results = await Promise.all(
      probeTargets.map(async (configDir): Promise<DirProbe> => {
        const outcome = await Promise.race([
          probeOneConfigDir(claudePath, configDir, spawnDir, timeoutMs),
          budgetExhausted,
        ]);
        return outcome === 'budget'
          ? { configDir, reason: `did not answer within the ${budgetMs}ms overall probe budget` }
          : outcome;
      }),
    );
  } finally {
    // Always cleared: a live timer would keep the event loop (and a CLI process) alive for the
    // rest of the budget after the answer is already in hand.
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  }

  for (const result of results) {
    if (result.rows === undefined) {
      unchecked.push({ configDir: result.configDir, reason: result.reason ?? 'was not checked' });
      continue;
    }
    for (const row of result.rows) {
      live.add(row.id);
      // First listing wins for a job two dirs both report: `live` is a union (see the
      // header's residuals), and a status has no better tie-break than arrival order.
      if (row.status !== undefined && !statuses.has(row.id)) {
        statuses.set(row.id, row.status);
      }
    }
  }
  return { live, statuses, unchecked };
}

/**
 * One config dir's listing, classified. Never rejects, and NEVER parses the output of a run
 * that did not cleanly succeed — a failed `claude` invocation's buffer is a diagnostic, not
 * data, and treating it as data is how a warning message becomes an empty listing.
 */
async function probeOneConfigDir(
  claudePath: string,
  configDir: string,
  spawnDir: SpawnDir,
  timeoutMs: number,
): Promise<DirProbe> {
  let outcome: ProcOutcome;
  try {
    outcome = await runMeshProcess(
      claudePath,
      // NO `--all`: with it the listing carries finished sessions too, and every completed
      // worker would answer "alive". The dir is targeted through the environment only —
      // and that environment is platform.claudeEnv's, never a hand-built one: for the
      // default account the variable must be ABSENT, not set to the default path.
      ['agents', '--json'],
      spawnDir.cwd,
      claudeEnv(configDir),
      timeoutMs,
    );
  } catch (err) {
    // runMeshProcess is documented never to reject; this is belt and braces so that a change
    // over there can never turn this function into one that throws.
    return { configDir, reason: `the probe failed unexpectedly: ${errorText(err)}` };
  }
  if (outcome.timedOut) {
    return { configDir, reason: `did not exit within ${timeoutMs}ms` };
  }
  if (outcome.spawnError) {
    return {
      configDir,
      reason: spawnDir.fellBack
        ? 'the claude executable could not be run from the fallback directory (no usable spawn cwd was supplied)'
        : 'the claude executable could not be run',
    };
  }
  if (outcome.code !== 0) {
    return { configDir, reason: `claude agents exited with code ${outcome.code}` };
  }
  if (outcome.truncated) {
    // A listing cut at the output cap is a JSON prefix: it would fail to parse anyway, and
    // saying WHY keeps "too big to read" from being reported as "printed noise".
    return { configDir, reason: 'printed more than the output cap, so the listing was not read' };
  }
  return liveRowsFromListing(configDir, outcome.output);
}

/**
 * The jobs one listing proves ALIVE, each with the status the listing gave it.
 *
 * Anything that is not unambiguously a listing comes back UNCHECKED rather than as an empty
 * id list, because "we could not look" and "nothing is running there" must never collapse into
 * one answer — the second reads as permission to stop worrying. A single malformed ROW is the
 * opposite case and is merely skipped: dropping a whole listing over one bad entry would hide
 * the live workers around it.
 */
function liveRowsFromListing(configDir: string, output: string): DirProbe {
  const text = output.trim();
  if (text === '') {
    return { configDir, reason: 'printed nothing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // stdout and stderr share one buffer, so a CLI warning line lands in here too. Fishing a
    // JSON substring out of the noise would mean guessing which run produced which bytes.
    return { configDir, reason: 'printed something that is not JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { configDir, reason: 'printed JSON that is not a session listing' };
  }
  if (parsed.length > MAX_ROWS_PER_LISTING) {
    return { configDir, reason: `listed more than ${MAX_ROWS_PER_LISTING} sessions` };
  }
  const rows: LiveRow[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const r = row as { id?: unknown; kind?: unknown; pid?: unknown; status?: unknown };
    if (typeof r.id !== 'string' || r.id === '' || typeof r.kind !== 'string') {
      // A row without a usable identity cannot be matched to anything. An EMPTY id is dropped
      // on purpose: the ledger writes `jobId: ''` for adopted workers that carried none, so an
      // empty-id row would hand every one of them a liveness verdict it never earned.
      continue;
    }
    if (r.kind !== 'background') {
      continue; // correctness, not relevance — see the header on bridge mirrors
    }
    // THE liveness test, and the whole reason this module exists: the row itself survives on a
    // persisted working/blocked state that an abruptly killed worker leaves behind, while `pid`
    // is only present on a row with a LIVE process record. No pid ⇒ not running. `state` is
    // never consulted, and the name is never even read.
    if (typeof r.pid !== 'number' || !isPidAlive(r.pid)) {
      continue;
    }
    // Reported, never decided on: a status that is not a short string is simply not one.
    const status =
      typeof r.status === 'string' && r.status !== '' && r.status.length <= MAX_STATUS_CHARS
        ? r.status
        : undefined;
    rows.push(status === undefined ? { id: r.id } : { id: r.id, status });
  }
  return { configDir, rows };
}

/**
 * A finite, non-negative integer from an untrusted option, or `fallback`.
 *
 * Values below `min` fall back rather than clamp, and the difference matters: clamping a
 * negative `timeoutMs` to 0 would SIGKILL every child before it could answer and report the
 * whole world as timed out, which looks like a working probe finding nothing.
 */
function intOption(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const n = Math.floor(value);
  return n < min ? fallback : n;
}

/**
 * A directory a probe child can actually be spawned in. Spawning into a missing or empty cwd
 * fails with ENOENT BEFORE the command ever runs, so every dir would come back "the claude
 * executable could not be run" — a wrong diagnosis in a function whose whole value is the
 * accuracy of its reasons. The caller is expected to supply a live directory; when it does not,
 * we fall back and SAY SO through `fellBack` rather than silently mislabelling the failure.
 */
function usableSpawnDir(value: unknown): SpawnDir {
  if (typeof value === 'string' && value !== '') {
    return { cwd: value, fellBack: false };
  }
  try {
    const own = process.cwd();
    if (own !== '') {
      return { cwd: own, fellBack: true };
    }
  } catch {
    // uv_cwd throws outright once our own directory is unlinked or unmounted
  }
  try {
    return { cwd: os.homedir(), fellBack: true };
  } catch {
    // no home either (a stripped environment): let the spawn fail and be reported as such
    return { cwd: '.', fellBack: true };
  }
}

/** A message from an unknown throw value, without ever calling a hostile toString. */
function errorText(err: unknown): string {
  return err instanceof Error && typeof err.message === 'string' ? err.message : 'unknown error';
}
