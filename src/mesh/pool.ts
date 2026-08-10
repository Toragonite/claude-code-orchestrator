import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  IWorkerPool,
  MeshWorkerRecord,
  MeshWorkerStatus,
  WorkerSpawnResult,
  WorkerSpawnSpec,
  MESH_STATE_DIR,
  accountConfigFile,
  applyProjectMcpTrust,
  meshError,
  meshGatewayName,
  meshStateFile,
  meshWorkerName,
  meshWorkerStandingPrompt,
  parseMeshWorkerName,
  parseSessionEntry,
  sanitizeAccountForName,
  sessionsDir,
  validateSpawnSpec,
  type SessionEntry,
} from './contract';
import { isPidAlive, readRegistry, readStats, WORKER_MODELS, type Registry } from '../registry';
import { exhaustedWindows, isLoginExpired, readUsageCache, type AccountUsage, type UsageCache } from '../usage';
import { isFrontierTier } from '../prompts';

/**
 * mesh/pool — the `claude --bg` worker lifecycle for one workspace (P10). Implements
 * the frozen IWorkerPool contract in contract.ts. The pool OWNS only the `workers`
 * array of the mesh state file; every other field belongs to the server/gateway, so
 * every mutation is a read-modify-write of the WHOLE object that touches nothing but
 * `workers` (contract MeshState).
 *
 * Two hard rules drive the design:
 *   - Placement mirrors the dispatch guards (usage.ts): a worker is never spawned on
 *     a logged-out, cooling-down, or quota-exhausted account unless the operator has
 *     explicitly opted into overage billing — and even then only as a last resort.
 *   - Spawning is shell-free. The standing prompt (attacker-influenced brief text)
 *     and every flag are passed as an argv array to child_process.spawn, so there is
 *     no interpolation surface a brief could break out of.
 *
 * vscode-free, node18 stdlib only; imports restricted to ./contract, ../registry,
 * ../usage and node builtins (contract).
 */

/** The implicit 'main' account's default model when the caller gives no override. */
const FALLBACK_MODEL = 'claude-opus-4-8';

/** How long a `claude --bg` spawn may take to exit 0 before we treat it as failed. */
const SPAWN_TIMEOUT_MS = 30_000;

/** How long `claude stop <jobId>` may run before we give up on the clean path. */
const STOP_TIMEOUT_MS = 15_000;

/** Chars of captured output attached to a spawn/stop failure so the caller can see why. */
const OUTPUT_TAIL_CHARS = 600;

/**
 * Substring the CLI prints when `--bg` refuses bypassPermissions without the one-time
 * interactive disclaimer. Its presence on a non-zero exit is the ONLY trigger for the
 * single acceptEdits retry in spawnOne (verified live, 2026-08-10).
 */
const DISCLAIMER_MARKER = 'requires accepting the disclaimer';

/** How long prepareAccount spins for its exclusive `.cco.lock` before skipping the seed (H1). */
const PREPARE_LOCK_TIMEOUT_MS = 2_000;
/** Poll interval while prepareAccount's `.cco.lock` is held by another cooperating writer. */
const PREPARE_LOCK_SPIN_MS = 25;

/**
 * A placement candidate: a registry worker account or the implicit 'main' account.
 * `model` is the account's default model (used when a spec names none); `preferred`
 * only ever breaks a utilization tie, exactly as in dispatch.
 */
interface Candidate {
  name: string;
  configDir: string;
  model: string;
  preferred: boolean;
}

interface ProcOutcome {
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
 * Utilization of one plan window for ranking. A missing account reading, a missing
 * window, or a non-finite percent all sort LAST among healthy candidates (Infinity):
 * we place a worker where we can PROVE there is headroom before an account whose
 * headroom we cannot see (contract placement rule "missing usage ranks worst").
 */
function windowPercent(usage: AccountUsage | undefined, kind: string): number {
  if (!usage || !Array.isArray(usage.windows)) {
    return Infinity;
  }
  const w = usage.windows.find((x) => x && x.kind === kind);
  return w && typeof w.percent === 'number' && isFinite(w.percent) ? w.percent : Infinity;
}

/**
 * Run a child process to completion, collecting stdout+stderr into one buffer.
 * Never rejects: a synchronous spawn throw, an async 'error', a non-zero exit and a
 * timeout all resolve a ProcOutcome the caller classifies. On timeout the child is
 * SIGKILLed and we settle from the subsequent 'close'. No shell — argv only.
 */
function runProcess(
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

  async spawn(specs: WorkerSpawnSpec[]): Promise<WorkerSpawnResult[]> {
    // One snapshot each of the inputs placement reads: the registry (guards + flags),
    // the usage cache (per-account plan windows), and stats (cooldowns). Reading them
    // once keeps every spec in a batch judged against the same picture.
    const registry = readRegistry();
    const cache = readUsageCache();
    const stats = readStats();
    const now = Date.now();
    const overageAllowed = registry.overageWorkerDispatch === 'allow';
    const candidates = this.buildCandidates(registry);
    // Every candidate account's session dir feeds nextSeq (M6): with the state file lost
    // or corrupt, a worker name must still be globally unique per sanitized token, even
    // across two accounts whose names sanitize to the same token.
    const candidateConfigDirs = candidates.map((c) => c.configDir);

    // Partition candidates exactly as dispatch does: logged-out and cooling-down
    // accounts are dropped outright (never usable, not even under overage); exhausted
    // accounts are dropped too UNLESS overage is allowed, in which case they are held
    // in a separate pool used only when no healthy account exists.
    const healthy: Candidate[] = [];
    const exhausted: Candidate[] = [];
    const disqualified: string[] = [];
    for (const c of candidates) {
      const usage = cache[c.configDir];
      if (isLoginExpired(usage)) {
        disqualified.push(`${c.name} (logged out)`);
        continue;
      }
      if ((stats[c.name]?.cooldownUntil ?? 0) > now) {
        disqualified.push(`${c.name} (on cooldown)`);
        continue;
      }
      if (exhaustedWindows(usage, now).length > 0) {
        if (overageAllowed) {
          exhausted.push(c);
        } else {
          disqualified.push(`${c.name} (quota-exhausted)`);
        }
        continue;
      }
      healthy.push(c);
    }
    const rank = this.rankComparator(cache);
    healthy.sort(rank);
    exhausted.sort(rank);
    // Exhausted accounts are the auto pool ONLY when nothing healthy remains — a
    // billable placement is never preferred over a free one (contract).
    const autoPool = healthy.length > 0 ? healthy : exhausted;

    const results: WorkerSpawnResult[] = [];
    let rr = 0;
    for (const spec of specs) {
      // Value-level validation first: a malformed spec fails on its own and never
      // consumes a placement slot, so the rest of the batch still runs (contract).
      const invalid = validateSpawnSpec(spec);
      if (invalid) {
        results.push({ ok: false, error: meshError('invalid_input', invalid) });
        continue;
      }

      let chosen: Candidate | undefined;
      if (spec.account !== undefined) {
        // Explicit account: must exist, and is STILL subject to every guard — an
        // operator naming an unhealthy account gets told exactly why it was refused.
        const c = candidates.find((x) => x.name === spec.account);
        if (!c) {
          results.push({
            ok: false,
            error: meshError(
              'unknown_account',
              `no account named "${spec.account}"; known: ${candidates.map((x) => x.name).join(', ')}.`,
            ),
          });
          continue;
        }
        const usage = cache[c.configDir];
        if (isLoginExpired(usage)) {
          results.push({
            ok: false,
            error: meshError('no_account_available', `account "${c.name}" is logged out — re-login it first.`),
          });
          continue;
        }
        const cooldownUntil = stats[c.name]?.cooldownUntil ?? 0;
        if (cooldownUntil > now) {
          results.push({
            ok: false,
            error: meshError(
              'no_account_available',
              `account "${c.name}" is on cooldown until ${new Date(cooldownUntil).toISOString()}.`,
            ),
          });
          continue;
        }
        if (exhaustedWindows(usage, now).length > 0 && !overageAllowed) {
          results.push({
            ok: false,
            error: meshError(
              'overage_blocked',
              `account "${c.name}" is quota-exhausted and overage dispatch is blocked; wait for the ` +
                'reset or enable overage dispatch to bill past the plan window.',
            ),
          });
          continue;
        }
        chosen = c;
      } else {
        // Automatic placement: round-robin across the ranked pool so multiple specs
        // spread over accounts instead of stacking on the healthiest one (contract).
        if (autoPool.length === 0) {
          const detail =
            disqualified.length > 0
              ? `every candidate account is unavailable: ${disqualified.join(', ')}.`
              : 'no candidate accounts are configured.';
          results.push({ ok: false, error: meshError('no_account_available', detail) });
          continue;
        }
        chosen = autoPool[rr % autoPool.length];
        rr++;
      }

      // Model guard, identical to dispatch. Two checks on the resolved model:
      //   1. A caller-supplied model must be one the registry knows (WORKER_MODELS).
      //      Account-default models come from the registry and are already valid, so
      //      only an explicit `spec.model` override can be bogus — reject an unknown one
      //      as invalid_input rather than passing it to the CLI (the declared WorkerModel
      //      type is a boundary lie: the value arrives unvalidated over MCP JSON).
      //   2. The frontier tier bills a scarce/separate quota, so it is refused unless the
      //      operator explicitly allowed it. The tier is matched by isFrontierTier (family
      //      regex), NOT an exact 'claude-fable-5' compare — so 'fable', 'Claude-Fable-5',
      //      a dated 'claude-fable-5-20260101', or 'mythos' cannot slip past the guard.
      const model = spec.model ?? chosen.model;
      if (spec.model !== undefined && !(WORKER_MODELS as readonly string[]).includes(spec.model)) {
        results.push({
          ok: false,
          account: chosen.name,
          model,
          error: meshError('invalid_input', `unknown model "${spec.model}"; allowed: ${WORKER_MODELS.join(', ')}`),
        });
        continue;
      }
      if (isFrontierTier(model) && registry.frontierWorkerDispatch !== 'allow') {
        results.push({
          ok: false,
          account: chosen.name,
          model,
          error: meshError(
            'frontier_blocked',
            `${model} is a frontier-tier model and is blocked; enable frontier worker dispatch to spawn a frontier worker.`,
          ),
        });
        continue;
      }

      // Pre-seed the chosen account's `.claude.json` ONCE (memoized) before spawning, so
      // the `--bg` worker boots without halting on the project's MCP-trust prompt. Runs
      // here (after placement, before the first attempt) so both permission-mode attempts
      // in spawnOne share one prepared account. Safe/idempotent/atomic — see prepareAccount.
      this.prepareAccount(chosen.configDir);

      results.push(await this.spawnOne(registry, chosen, spec.role, spec.brief, model, candidateConfigDirs));
    }
    return results;
  }

  async stop(name: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const record = this.readWorkers().find((r) => r.name === name);
    if (!record) {
      return { ok: false, error: meshError('unknown_worker', `no mesh worker named "${name}" in this workspace.`) };
    }
    // Clean path: `claude stop <jobId>` under the worker's OWN account — the job id
    // is only meaningful to the config dir that spawned it.
    const outcome = await runProcess(
      this.claudePath,
      ['stop', record.jobId],
      this.cwd,
      { ...process.env, CLAUDE_CONFIG_DIR: record.configDir },
      STOP_TIMEOUT_MS,
    );
    if (!outcome.timedOut && !outcome.spawnError && outcome.code === 0) {
      this.markStopped(name);
      return { ok: true };
    }
    // Forced path: `claude stop` failed and the caller accepts a hard kill. Signal the
    // pid the worker's OWN session-registry entry advertises, after confirming it is
    // that entry and still alive — never a bare recorded pid the OS may have recycled.
    if (opts?.force) {
      const entry = this.readSessionEntries(sessionsDir(record.configDir)).find((e) => e.name === name);
      if (entry && isPidAlive(entry.pid)) {
        try {
          process.kill(entry.pid, 'SIGKILL');
          this.markStopped(name);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `SIGKILL of pid ${entry.pid} failed: ${(e as Error).message}` };
        }
      }
      return {
        ok: false,
        error: `claude stop failed (${this.describeFailure(outcome)}) and no live registry pid was found to kill.`,
      };
    }
    return { ok: false, error: `claude stop failed: ${this.describeFailure(outcome)}` };
  }

  list(): MeshWorkerStatus[] {
    const cache = readUsageCache();
    const registry = readRegistry();
    // Index every candidate account's live entries by name; a real (non-mirror)
    // entry always wins a bridge mirror of the same name so `alive` reflects the
    // genuine process, not a copy.
    const byName = new Map<string, SessionEntry>();
    for (const c of this.buildCandidates(registry)) {
      for (const e of this.readSessionEntries(sessionsDir(c.configDir))) {
        if (typeof e.name !== 'string') {
          continue;
        }
        const existing = byName.get(e.name);
        if (!existing || (existing.ccoMirror === true && e.ccoMirror !== true)) {
          byName.set(e.name, e);
        }
      }
    }
    const now = Date.now();
    return this.readWorkers().map((rec) => {
      const entry = byName.get(rec.name);
      return {
        ...rec,
        alive: entry !== undefined && isPidAlive(entry.pid),
        registryStatus: typeof entry?.status === 'string' ? entry.status : undefined,
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
      for (const e of this.readSessionEntries(sessionsDir(c.configDir))) {
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
      model: w.model,
      preferred: w.preferred === true,
    }));
    list.push({ name: 'main', configDir: this.mainConfigDir, model: FALLBACK_MODEL, preferred: false });
    return list;
  }

  /**
   * Placement order: session utilization ascending, then weekly ascending, then the
   * `preferred` flag as a tie-break (contract). Direct `<` comparisons (not
   * subtraction) so Infinity — the "no usage data" sentinel — sorts last without
   * producing NaN from Infinity − Infinity.
   */
  private rankComparator(cache: UsageCache): (a: Candidate, b: Candidate) => number {
    return (a, b) => {
      const as = windowPercent(cache[a.configDir], 'session');
      const bs = windowPercent(cache[b.configDir], 'session');
      if (as !== bs) {
        return as < bs ? -1 : 1;
      }
      const aw = windowPercent(cache[a.configDir], 'weekly_all');
      const bw = windowPercent(cache[b.configDir], 'weekly_all');
      if (aw !== bw) {
        return aw < bw ? -1 : 1;
      }
      if (a.preferred !== b.preferred) {
        return a.preferred ? -1 : 1;
      }
      return 0;
    };
  }

  /**
   * Spawn one `--bg` worker on a chosen account and record it. The name's sequence is
   * computed fresh here (1 + highest existing seq across the state file AND every
   * candidate account's live registry, including anything the previous spawn in this
   * batch just appended), so back-to-back spawns on one account never collide.
   *
   * Permission-mode fallback (scenario-B lesson, 2026-08-10): `claude --bg` under
   * bypassPermissions demands a one-time INTERACTIVE disclaimer, so every headless
   * spawn on such a registry exits non-zero with DISCLAIMER_MARKER in its output. When
   * that exact failure is seen, the SAME attempt is retried ONCE with acceptEdits (only
   * --permission-mode differs). The first attempt never wrote a state record (that only
   * happens on success, below) nor a session entry (it exits before starting), so the
   * name/seq is reused unchanged and exactly one record is appended per successful
   * spawn. Each attempt carries its own SPAWN_TIMEOUT_MS window (runProcess per call).
   */
  private async spawnOne(
    registry: Registry,
    cand: Candidate,
    role: string,
    brief: string,
    model: string,
    candidateConfigDirs: string[],
  ): Promise<WorkerSpawnResult> {
    const seq = this.nextSeq(cand, candidateConfigDirs);
    const name = meshWorkerName(this.cwd, cand.name, seq);
    // One attempt against a given permission mode; the retry reuses this verbatim with
    // only the mode swapped, so there is a single spawn code path (no duplication).
    const attempt = (permissionMode: string): Promise<ProcOutcome> => {
      // ARGV ORDER IS LOAD-BEARING: --allowedTools is a VARIADIC option ("comma or
      // space-separated list"), so a positional placed right after its value is
      // swallowed into the tool list. That exact footgun shipped once: the standing
      // prompt vanished, workers booted promptless and exited instantly with no
      // transcript (scenario-B re-run, 2026-08-10). A bounded option pair (--name)
      // must sit between --allowedTools and the positional prompt.
      const args = [
        '--bg',
        '--model',
        model,
        '--permission-mode',
        permissionMode,
        // NO Bash. `--bg` cannot use bypassPermissions (it demands a one-time interactive
        // disclaimer), so mesh workers run under acceptEdits — which auto-approves file
        // edits but NOT Bash. A worker with Bash in its tool list blocks at boot on the
        // first shell permission prompt it can never display (state 'blocked', verified
        // 2026-08-10). This matches the standing project rule that workers author files
        // and the orchestrator runs builds/tests/shell.
        '--allowedTools',
        'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep',
        '--name',
        name,
        meshWorkerStandingPrompt({ workerName: name, role, brief, gatewayName: meshGatewayName(this.cwd) }),
      ];
      return runProcess(
        this.claudePath,
        args,
        this.cwd,
        { ...process.env, CLAUDE_CONFIG_DIR: cand.configDir },
        SPAWN_TIMEOUT_MS,
      );
    };

    let outcome = await attempt(registry.permissionMode);
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
    if (outcome.timedOut || outcome.spawnError || outcome.code !== 0 || !jobId) {
      return {
        ok: false,
        name,
        account: cand.name,
        model,
        error: meshError('spawn_failed', `worker ${name}: ${this.describeFailure(outcome)}. output: ${tail(outcome.output)}`),
      };
    }
    // Record the pid from the fresh session-registry entry when it already exists;
    // `--bg` returns before the entry is guaranteed written, so a missing pid is
    // tolerated (list()/adopt() recover it live later).
    const entry = this.readSessionEntries(sessionsDir(cand.configDir)).find((e) => e.name === name);
    this.mutateWorkers((workers) => {
      workers.push({
        name,
        account: cand.name,
        configDir: cand.configDir,
        jobId,
        pid: entry?.pid,
        model,
        role,
        spawnedAt: Date.now(),
      });
    });
    return { ok: true, name, jobId, account: cand.name, model, ...(note ? { note } : {}) };
  }

  /** One-line cause of a non-successful ProcOutcome for an error message. */
  private describeFailure(o: ProcOutcome): string {
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
  private nextSeq(cand: Candidate, candidateConfigDirs: string[]): number {
    const token = sanitizeAccountForName(cand.name);
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
      for (const e of this.readSessionEntries(sessionsDir(dir))) {
        consider(e.name);
      }
    }
    return max + 1;
  }

  /** Set stoppedAt on a worker record (a no-op if it vanished between calls). */
  private markStopped(name: string): void {
    this.mutateWorkers((workers) => {
      const rec = workers.find((r) => r.name === name);
      if (rec) {
        rec.stoppedAt = Date.now();
      }
    });
  }

  /* --- mesh state file (pool owns only `workers`) ------------------------ */

  /** Parse the state file as an opaque object, tolerating missing/corrupt (contract). */
  private readRawState(): Record<string, unknown> {
    try {
      const raw = JSON.parse(fs.readFileSync(meshStateFile(this.cwd), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
    } catch {
      // missing or corrupt — an empty object is the empty-state the contract asks for
    }
    return {};
  }

  /** The well-formed worker records currently in the state file. */
  private readWorkers(): MeshWorkerRecord[] {
    return this.parseWorkers(this.readRawState());
  }

  private parseWorkers(raw: Record<string, unknown>): MeshWorkerRecord[] {
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
        typeof (item as MeshWorkerRecord).spawnedAt === 'number'
      ) {
        out.push(item as MeshWorkerRecord);
      }
    }
    return out;
  }

  /**
   * Read-modify-write the WHOLE state object, mutating only `workers`. Re-reading
   * immediately before writing keeps the clobber window for the server-owned fields
   * (ownerPid, gatewayName, startedAt) as small as a synchronous section allows, and
   * unmodeled keys ride through untouched (contract: do not clobber fields we do not
   * own). The write is atomic — tmp file in the SAME dir, then rename (run-task.ts).
   */
  private mutateWorkers(fn: (workers: MeshWorkerRecord[]) => void): void {
    const raw = this.readRawState();
    const workers = this.parseWorkers(raw);
    fn(workers);
    raw.workers = workers;
    fs.mkdirSync(MESH_STATE_DIR, { recursive: true });
    const finalPath = meshStateFile(this.cwd);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2));
    fs.renameSync(tmpPath, finalPath);
  }

  /** Every parseable session entry in one dir; a missing dir or bad file is skipped, never fatal. */
  private readSessionEntries(dir: string): SessionEntry[] {
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
}
