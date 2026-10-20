import * as fs from 'fs';
import * as path from 'path';
import {
  IBridge,
  BridgeStatus,
  BRIDGE_POLL_MS,
  MESH_NAME_PREFIX,
  MESH_PEER_PROTOCOL,
  isMirrorableEntry,
  parseSessionEntry,
  sessionsDir,
  type SessionEntry,
} from './contract';
import { isPidAlive } from '../registry';
import { readTextSafe } from '../safeFs';
import { flattenOneLine } from '../displayText';

/**
 * mesh/bridge — makes session workers on OTHER accounts addressable from the host session.
 *
 * Claude Code's peer discovery reads ONLY the caller's own CLAUDE_CONFIG_DIR/sessions dir,
 * so the orchestrator session cannot name a worker that runs under a different account.
 * This daemon copies each live, mesh-owned `sessions/<pid>.json` entry of a worker account
 * INTO THE HOST ACCOUNT'S dir (marked `ccoMirror:true`), so the worker appears in the
 * orchestrator's ListAgents and its own SendMessage can address it by name.
 *
 * ONE DIRECTION, ONE TARGET (v2.0). `participants[0]` is the host config dir and the only
 * directory mirrors are ever WRITTEN into. Nothing is written into a worker account's dir
 * any more: a worker never has to discover the orchestrator — it replies to the `from`
 * address of the message it was sent, which rides the machine-global socket address and
 * bypasses discovery entirely — and workers do not message each other. v1.x mirrored every
 * entry into every other participant; what that left behind in worker dirs is cleared by
 * the prune below, on the first sweep of every start.
 *
 * THE INVARIANT that everything else bends around: this daemon must NEVER delete a
 * genuine Claude Code session file. It only ever writes and deletes files carrying
 * its own `ccoMirror:true` marker; a file lacking that marker is untouchable no
 * matter how stale it looks (contract prune rule, premortem #4). The marker is what
 * lets a crash-litter sweep run without risking a real session's discovery entry.
 *
 * The bridge is plumbing the server owns, and nothing durable depends on it: results ride
 * files, and a worker the mirror has not reached yet is merely not addressable by name for
 * a poll tick (mesh_status reports that as `peerVisible: false`).
 *
 * Implements the frozen IBridge contract. vscode-free, node18 stdlib only; imports
 * restricted to ./contract, ../registry, ../safeFs, ../displayText and node builtins. (The
 * last two are leaves, so they add no edge to the dependency graph this list protects.)
 */

/**
 * fs.watch fires a burst of events for a single logical change (and is unreliable on
 * macOS — hence the poll below). Coalesce a burst into one sweep 150ms later so we do
 * not thrash the filesystem per event.
 */
const DEBOUNCE_MS = 150;

/**
 * Read cap for ONE session entry, and the number is a policy rather than a guess.
 *
 * A `sessions/<pid>.json` entry is a flat record — pid, name, socket path, status, protocol — and
 * the real ones are a few hundred bytes; 64 KiB is three orders of magnitude of slack. The cap
 * exists because the SIZE of these files is untrusted: a participant dir is an account's own
 * `<configDir>/sessions`, which is exactly the directory a dispatched worker is handed by name, so
 * it can put a multi-gigabyte file (or a /dev/zero symlink) where an entry belongs. Without a cap
 * that is an out-of-memory lever on whichever process is mirroring — the extension host or the MCP
 * server — reached from a 2s timer. And the cost is paid PER FILE across a whole directory scan,
 * not once, which is the reason the number is small rather than generous. A file past the cap is
 * REFUSED, never truncated: a prefix of a JSON document does not parse, and "corrupt" and "too
 * big" are different facts that the sweep below acts on differently.
 *
 * Matches the 64 KiB a sibling task settled on for this same file type; deliberately the same
 * number, so the two never drift into disagreeing about what a session entry may weigh.
 */
const SESSION_ENTRY_MAX_BYTES = 64 * 1024;

/**
 * Ceiling on how many directory entries ONE participant-dir scan will examine.
 *
 * PREVENTS unbounded synchronous work over an attacker-controlled directory. The scan runs on the
 * bridge's 2s timer inside the sweep's re-entrancy guard, and a worker that creates a million
 * names in its own sessions dir would otherwise hold that callback — and, through it, the whole
 * event loop of the extension host or the MCP server — for as long as the filesystem takes. The
 * budget is enforced with `opendirSync` + one `readSync` at a time BECAUSE `readdirSync`
 * materialises every name into one array before any budget could act: by the time a cap could be
 * checked, the allocation has already happened, which is the failure the cap exists to prevent.
 *
 * Hitting the budget marks the pass INCOMPLETE rather than merely truncating it — see readDir.
 * Matches the 25,000 a sibling task settled on for its equivalent scans.
 */
const DIR_ENTRY_BUDGET = 25_000;

/**
 * Open flags for the TEMP FILE of a mirror's atomic write: write-only, create, truncate,
 * NON-BLOCKING, no controlling terminal, NO-FOLLOW.
 *
 * THE FULL RATIONALE FOR EVERY FLAG, FOR THE ABSENCE OF O_EXCL, AND FOR WHY THIS GUARD IS LOCAL
 * RATHER THAN IN safeFs LIVES IN src/registry.ts, ON `TMP_WRITE_GUARDED` AND
 * `writeTempFileGuarded`. Read it there before changing anything here; the one-line version is
 * that safeFs deliberately has no truncating write, because its discipline is "prove it is a
 * regular file BEFORE you touch it" and an O_TRUNC open cannot honour that ordering — truncation
 * happens in the open. The copy is local rather than imported because those two are private to
 * registry.ts, and this module's import list is deliberately pinned to ./contract, ../registry and
 * node builtins.
 *
 * WHY THIS SITE IS WORTH GUARDING even though every failure here is already best-effort: the
 * mirror paths are `<participant sessions dir>/<pid>.json`, and a participant dir is a config dir
 * a worker is handed by name. A blocking open in this method would hang the 2s sweep timer while
 * it holds `this.sweeping`, so the bridge would never sweep again and `mesh_status` would report a
 * healthy bridge forever.
 */
const TMP_WRITE_GUARDED =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

/** What the thing at a temp path actually is, for a refusal reason. Literals only. */
function tempPathKind(st: fs.Stats): string {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  if (st.isCharacterDevice()) {
    return 'a character device';
  }
  if (st.isBlockDevice()) {
    return 'a block device';
  }
  return 'something other than a regular file';
}

/**
 * Write `data` to a mirror's temp path. Returns undefined on success, or a short reason on
 * refusal. NEVER THROWS and never blocks. Mirror of `registry.writeTempFileGuarded` — see that
 * function for why the fstat is on the fd we opened rather than on the name, why a refusal clears
 * the temp name, and what residual the separate rename syscall leaves.
 */
function writeTempFileGuarded(tmp: string, data: string): string | undefined {
  let fd = -1;
  // Initialised to the generic reason so no path below can fall through as a silent success.
  let reason: string | undefined = 'the temp file could not be opened or written';
  try {
    // 0o666, umask-masked by the kernel — exactly the mode `writeFileSync` created with.
    fd = fs.openSync(tmp, TMP_WRITE_GUARDED, 0o666);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      reason = `the temp path is ${tempPathKind(st)}`;
    } else {
      const buf = Buffer.from(data, 'utf8');
      let written = 0;
      // Loop on short writes: a single-call writer truncates the payload silently, which here
      // means a half session entry renamed into the host account's discovery dir.
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) {
          break;
        }
        written += n;
      }
      reason =
        written < buf.length
          ? `only ${written} of ${buf.length} bytes could be written`
          : undefined;
    }
  } catch (e) {
    // Only a shape-checked errno code is quoted — a caught value's `code` can be free text that
    // quotes the path (measured: "Unknown system error -102" on macOS for a unix socket).
    const code: unknown = (e as { code?: unknown } | null | undefined)?.code;
    reason =
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
        ? `the temp file could not be opened or written (${code})`
        : 'the temp file could not be opened or written';
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed — and a failing close cannot lose bytes written with writeSync
      }
    }
    if (reason !== undefined) {
      // Clear the squatter so the NEXT write self-heals. `unlink` covers a file, a FIFO, a socket,
      // a device node and a symlink; a DIRECTORY needs `rmdir`, and without that fallback a
      // planted directory would be a PERMANENT refusal where a planted FIFO is a one-shot one —
      // measured, not assumed. Both are swallowed and neither is load-bearing: a squatter we
      // cannot remove is still refused, just not self-healed, and a failed cleanup must never
      // replace the real reason with a worse one.
      try {
        fs.unlinkSync(tmp);
      } catch {
        try {
          fs.rmdirSync(tmp);
        } catch {
          // a non-empty directory, or a path this process may not modify — refused either way
        }
      }
    }
  }
  return reason;
}

/** One json file in a participant dir: its path, the raw parsed object, and the strict parse. */
interface DirFile {
  file: string;
  raw?: Record<string, unknown>;
  entry?: SessionEntry;
}

export class Bridge implements IBridge {
  /** Canonical (realpath) sessions/ dir of each participant, deduped so aliases collapse. */
  private readonly dirs: string[];
  /**
   * The ONE dir mirrors are written into: the canonical sessions dir of `participants[0]`,
   * the host account. Undefined only when no participant was given at all. Because `dirs`
   * is deduped, a worker account that IS the host account collapses into this entry and is
   * therefore never a mirror source — its sessions are natively visible there.
   */
  private readonly targetDir: string | undefined;
  /**
   * The fs.watch on each participant dir that currently has one, by dir. A dir is absent from
   * the map while it cannot be watched — it does not exist yet (an account that has never run
   * a session), or its watch failed — and every sweep tries again (attachWatchers).
   */
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private started = false;
  private lastSyncAt?: number;
  private degraded?: string;
  /** Mirror files this instance maintained on the last sweep — status.mirrors is how many still exist. */
  private mirrorPaths = new Set<string>();

  /**
   * `participants[0]` MUST be the host config dir (the orchestrator session's own account);
   * the rest are the worker accounts' config dirs, in any order, duplicates welcome.
   */
  constructor(opts: { participants: string[] }) {
    // Canonicalize every participant's sessions dir with realpathSync so two configDirs
    // that resolve to the SAME real dir (symlink, a `./` segment, case-insensitive FS)
    // collapse to ONE string, then dedupe. Without this an aliased host survives as a
    // distinct string, the sync loop's source filter fails to skip it, and the sweep
    // mirrors — then, next sweep, prunes — a session's own real entry (M3 data
    // loss; writeMirror's same-session guard is the second line behind it). realpathSync
    // throws when the dir does not exist yet; path.resolve is the best-effort fallback for
    // that case.
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const participant of opts.participants) {
      const canonical = Bridge.canonicalDir(sessionsDir(participant));
      if (seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      dirs.push(canonical);
    }
    this.dirs = dirs;
    // First IN, first OUT: dedupe keeps the first occurrence, so dirs[0] is participants[0].
    this.targetDir = dirs[0];
  }

  /** Real path of a sessions dir, or its resolved absolute path if it does not exist yet. */
  private static canonicalDir(dir: string): string {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // Full sweep first so stale mirrors are pruned from EVERY participant dir — a previous
    // run's crash litter in the host dir, and whatever a v1.x server left in the worker
    // dirs — and current workers are mirrored before anyone reads discovery (contract
    // start()).
    // The sweep ends by attaching a watch to every participant dir that can take one
    // (attachWatchers), so the first one also starts the watching.
    this.sweep();
    // fs.watch alone is unreliable on macOS (premortem #3), so a steady poll is the
    // real guarantee. unref so a pending tick never keeps the host process alive.
    const poll = setInterval(() => this.sweep(), BRIDGE_POLL_MS);
    poll.unref();
    this.pollTimer = poll;
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers.clear();
    // Delete every mirror WE would recognize as ours: a ccoMirror:true file in one of
    // our participant dirs. Non-mirror files are never touched (the invariant). If a
    // peer's own live bridge still needs a mirror we drop here, its next poll rewrites
    // it — mirrors are disposable, so this stays safe and idempotent.
    for (const dir of this.dirs) {
      for (const item of this.readDir(dir).files) {
        if (item.raw && item.raw.ccoMirror === true) {
          try {
            fs.unlinkSync(item.file);
          } catch {
            // already gone or unwritable — nothing more to do
          }
        }
      }
    }
    this.mirrorPaths.clear();
    this.started = false;
  }

  status(): BridgeStatus {
    let mirrors = 0;
    for (const p of this.mirrorPaths) {
      try {
        if (fs.existsSync(p)) {
          mirrors++;
        }
      } catch {
        // treat an unstattable path as absent
      }
    }
    return {
      enabled: this.started,
      participants: this.watchers.size,
      mirrors,
      lastSyncAt: this.lastSyncAt,
      degraded: this.degraded,
    };
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * Put an fs.watch on every participant dir that has none and can take one. Runs at the end
   * of every sweep, which is what makes `status().participants` true of NOW rather than of the
   * moment the bridge started: an account that had never run a session has no `sessions/`
   * directory to watch, and its first session — typically the first worker dispatched to it —
   * creates one. Before this, such an account was never watched and never counted, however
   * long the bridge ran; its entries were still mirrored, by the poll alone.
   *
   * A watch that fails or dies is dropped and tried again on the next sweep, for the same
   * reason: a directory that was removed and came back, or one that could not be watched for
   * a moment (a descriptor limit), is watched again once it can be. The 'error' listener is
   * not optional — an FSWatcher is an emitter, and an 'error' nobody listens for is an
   * uncaught exception in the host process. Nothing here decides what is mirrored or pruned:
   * the poll sweeps every dir regardless, and a watch only makes the next sweep sooner.
   */
  private attachWatchers(): void {
    if (!this.started) {
      return;
    }
    for (const dir of this.dirs) {
      if (this.watchers.has(dir)) {
        continue;
      }
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.scheduleSweep());
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            // already closed
          }
          if (this.watchers.get(dir) === watcher) {
            this.watchers.delete(dir);
          }
        });
        this.watchers.set(dir, watcher);
      } catch {
        // Not there yet (an account that has never run a session has no `sessions/`), or
        // unwatchable: the poll covers it either way, and the next sweep asks again. Only a
        // dir that EXISTS and cannot be read is noted degraded, and that is the sweep's finding.
      }
    }
  }

  private scheduleSweep(): void {
    if (this.debounceTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.sweep();
    }, DEBOUNCE_MS);
    timer.unref();
    this.debounceTimer = timer;
  }

  /**
   * One synchronous mirror pass over every participant dir: read once, mirror every
   * live worker-account source INTO THE HOST DIR, then prune stale mirrors everywhere.
   * Synchronous so the poll tick and a debounced watch event can never reenter each other
   * mid-pass. Every filesystem touch is individually try/caught — one unreadable dir or
   * file degrades the status message but never aborts the sweep (contract).
   */
  private sweep(): void {
    const degraded = new Set<string>();

    // Snapshot all dirs up front. Mirrors written later this pass are intentionally
    // NOT in this snapshot, so prune (which uses it) never races its own writes.
    const snapshot = this.dirs.map((dir) => {
      const { ok, files } = this.readDir(dir, degraded);
      return { dir, ok, files };
    });
    // The live-source picture is complete only when EVERY participant dir read cleanly this
    // sweep. A transient readdir failure (EMFILE, …) or a dir past the entry budget leaves
    // liveSourcePids incomplete, and "not in the live set" then proves nothing (M4) — the
    // prune below falls back to the one kind of staleness it can still prove.
    const readComplete = snapshot.every((s) => s.ok);

    // A source is a mesh-owned, protocol-1 entry with a live pid. The set of live source
    // pids is collected from EVERY dir, the host's included: it is what the prune compares
    // against, and a mirror that some other live server maintains for one of those pids
    // (a v1.x server still running in another window mirrors in every direction) must not
    // be deleted out from under it every two seconds.
    const liveSourcePids = new Set<number>();
    const sources: { entry: SessionEntry; dir: string }[] = [];
    for (const { dir, files } of snapshot) {
      for (const item of files) {
        const entry = item.entry;
        if (!entry) {
          continue;
        }
        // A mesh entry we WOULD mirror but for its protocol means the undocumented
        // format moved under us — flip degraded so the operator learns (contract pin).
        if (
          typeof entry.name === 'string' &&
          entry.name.startsWith(MESH_NAME_PREFIX) &&
          typeof entry.messagingSocketPath === 'string' &&
          entry.ccoMirror !== true &&
          entry.peerProtocol !== MESH_PEER_PROTOCOL
        ) {
          degraded.add(
            `foreign peerProtocol ${flattenOneLine(String(entry.peerProtocol))} on ` +
              `${flattenOneLine(entry.name)} — not mirrored`,
          );
          continue;
        }
        if (isMirrorableEntry(entry) && isPidAlive(entry.pid)) {
          liveSourcePids.add(entry.pid);
          // Mirrored only when it lives OUTSIDE the target: an entry already in the host
          // dir is natively visible to the host session, and mirroring it would be writing
          // a session's entry over itself. Both strings are canonical + deduped
          // (constructor), so this compare holds under symlink/case/`./` aliasing (M3).
          if (dir !== this.targetDir) {
            sources.push({ entry, dir });
          }
        }
      }
    }

    // Sync: ensure the HOST dir holds `<pid>.json` = source + ccoMirror for every source.
    // Nothing is written into any other participant dir. The pid is machine-globally
    // unique among LIVE processes, so a mirror named <sourcePid>.json cannot collide with
    // a live session's own entry there (writeMirror refuses the one case that could).
    const maintained = new Set<string>();
    const target = this.targetDir;
    if (target !== undefined) {
      for (const { entry } of sources) {
        const bytes = JSON.stringify({ ...entry, ccoMirror: true });
        const file = path.join(target, `${entry.pid}.json`);
        if (this.writeMirror(file, bytes, entry, degraded)) {
          maintained.add(file);
        }
      }
    }
    this.mirrorPaths = maintained;

    // Prune: delete OUR mirrors that no longer stand for a live source — in EVERY
    // participant dir, which is what clears the mirrors v1.x wrote into worker dirs (this
    // build writes none there, so any that remain are either stale or some other live
    // server's). The ccoMirror guard is the load-bearing safety check: only marked copies
    // are ever considered for deletion.
    //
    // WHAT "STALE" MAY MEAN DEPENDS ON WHAT WAS SEEN:
    //   - complete picture → the mirror's pid is not a live mesh source. That folds in every
    //     prune cause the contract names: dead pid, vanished source, or a source that stopped
    //     qualifying.
    //   - incomplete picture → ONLY a mirror whose process is DEAD. "Not in the live set"
    //     would delete a live worker's mirror merely because its source dir failed to read
    //     (M4); a dead pid is stale whatever we failed to read, because no source can be
    //     live under it. Without this arm a machine whose session dirs are past the entry
    //     budget — the leaked-file litter this release exists to clean up — would never
    //     prune anything at all.
    for (const { files } of snapshot) {
      for (const item of files) {
        if (!item.raw || item.raw.ccoMirror !== true) {
          continue;
        }
        const pid = typeof item.raw.pid === 'number' ? item.raw.pid : NaN;
        const stale = readComplete ? !liveSourcePids.has(pid) : !isPidAlive(pid);
        if (!stale) {
          continue;
        }
        try {
          fs.unlinkSync(item.file);
        } catch (e) {
          // BOTH halves are attacker-chosen and this string reaches `mesh_status`, which an
          // orchestrating model parses: `item.file` is a name in a sessions dir a worker can
          // write, and an errno message quotes the path it failed on. Flattened for the same
          // reason the read-site note beside it is — an invisible run here is instruction
          // injection, not a display artifact.
          degraded.add(
            `prune failed for ${flattenOneLine(item.file)}: ${flattenOneLine((e as Error).message)}`,
          );
        }
      }
    }
    if (!readComplete) {
      degraded.add(
        'prune limited this sweep: a participant dir could not be read completely, so only mirrors of dead processes were removed',
      );
    }

    this.degraded = degraded.size > 0 ? [...degraded].join('; ') : undefined;
    this.lastSyncAt = Date.now();
    // Last, and outside everything above: watching is an accelerator for the next sweep and
    // never an input to this one.
    this.attachWatchers();
  }

  /**
   * Rewrite the mirror only when its bytes actually change. Regenerating the desired
   * bytes from the current source each pass and diffing against disk is the simplest
   * rule that keeps mirror metadata (status, socket, …) fresh as the source mutates
   * WITHOUT rewriting an unchanged file every 2s (contract staleness rule). Atomic:
   * tmp in the same dir, then rename.
   *
   * Returns true when the mirror is in place after the call (already current, or written).
   */
  private writeMirror(file: string, bytes: string, source: SessionEntry, degraded: Set<string>): boolean {
    try {
      // READING THE EXISTING MIRROR IS AN OPTIMISATION AND NOTHING ELSE, and routing it through
      // safeFs preserves that exactly while removing two hazards this path had. The mirror path is
      // `<a participant's configDir>/sessions/<pid>.json` — a directory a dispatched worker is
      // handed by name — so `fs.readFileSync` there could block forever on a planted FIFO (with
      // the 2s sweep timer's re-entrancy guard held, so the bridge would never sweep again while
      // reporting itself healthy) or allocate without bound on a /dev/zero symlink or a
      // hand-placed multi-gigabyte file.
      //
      // ANY refusal — absent, not-a-file, too-large, unreadable — means the same single thing
      // here: "I do not know what is on disk", which is precisely what the old `existing =
      // undefined` meant, and it takes the same branch, a rewrite. That is the safe default in
      // both directions: rewriting an already-correct mirror costs one write, whereas skipping a
      // rewrite because the check failed would leave a stale entry in the host account's
      // discovery dir. It also REPAIRS a squatted mirror path — the rename below replaces a FIFO,
      // a device symlink or an oversize file with the correct entry. No fact is inferred from the
      // refusal and nothing downstream sees it, so the four reasons do not need to be told apart
      // at this call site (they very much do in readDir, which acts on the difference).
      // `noFollow`: a link sitting at the mirror path is never read through — it is one more
      // "I do not know what is on disk", and the rename below replaces the LINK, not its target.
      const current = readTextSafe(file, SESSION_ENTRY_MAX_BYTES, { noFollow: true });
      if (current.ok && current.text === bytes) {
        return true;
      }
      // THE ONE FILE THIS WRITE MUST NEVER REPLACE: the source session's OWN entry. It can
      // only be sitting at the mirror path if the "host" dir and the source dir are in fact
      // one directory that the constructor's canonicalization failed to collapse (it falls
      // back to a lexical resolve when the dir does not exist yet). Renaming a ccoMirror
      // copy over it would turn a live session's real entry into something the prune below
      // is entitled to delete — M3's data loss. Same session + not our marker ⇒ it is
      // already natively visible there; leave it alone. Anything else at this path is a
      // stale file whose pid the OS has since handed to this source (a dead session's
      // litter, or an old mirror) and is replaced exactly as before.
      if (current.ok && Bridge.isOwnEntryOf(current.text, source)) {
        return false;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      // A REFUSED TEMP WRITE IS REPORTED DEGRADED AND THE RENAME DOES NOT RUN — the same channel
      // and the same shape this method already used for a throwing write, so nothing here becomes
      // silent. `degraded` surfaces in BridgeStatus and therefore in `mesh_status`, which is the
      // right severity: a mirror is a cache of another dir's session entry, the sweep rebuilds it
      // every 2s, and the only cost of missing one pass is that one worker stays invisible in the
      // host account's ListAgents for a couple of seconds. Throwing instead would abort the
      // sweep mid-pass and skip the prune, and the class contract above is explicit that one
      // unreadable dir or file must never abort a sweep.
      //
      // The rename is skipped for the reason it is skipped everywhere: `rename` moves whatever the
      // temp NAME refers to, so renaming after a refused write would put a FIFO, a directory or a
      // symlink at `<participant dir>/<pid>.json` — a path this daemon reads on every sweep AND
      // that Claude Code itself reads for peer discovery. That converts a two-second cosmetic
      // failure into a wedge in someone else's process.
      const refused = writeTempFileGuarded(tmp, bytes);
      if (refused !== undefined) {
        degraded.add(`mirror write failed for ${flattenOneLine(file)}: ${flattenOneLine(refused)}`);
        return false;
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      degraded.add(
        `mirror write failed for ${flattenOneLine(file)}: ${flattenOneLine((e as Error).message)}`,
      );
      return false;
    }
  }

  /** Is `text` the genuine (non-mirror) session entry of the very session `source` describes? */
  private static isOwnEntryOf(text: string, source: SessionEntry): boolean {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
      }
      const existing = parsed as Record<string, unknown>;
      return existing.ccoMirror !== true && existing.sessionId === source.sessionId;
    } catch {
      return false; // not an entry at all — nothing genuine to protect
    }
  }

  /**
   * Read one participant dir's json files into {path, raw, strict-parse} triples.
   *
   * `ok` MEANS "THE PICTURE THIS PASS BUILT IS COMPLETE", and it is the only thing standing
   * between a read failure and DELETED DATA. The caller ANDs it across all dirs into
   * `readComplete` and prunes BY THE LIVE SET only when every dir agreed (M4). That matters because of which way
   * the prune reasons: a mirror is deleted when its source pid is NOT in `liveSourcePids`, so an
   * entry this function fails to read does not merely go unmirrored — it silently subtracts a LIVE
   * worker from the live-source set, and the sweep would then delete that worker's mirror from the
   * host account's discovery dir. An unreadable file must therefore never be allowed to read as
   * "there is no such source", which is exactly the swallowed-failure collapse this codebase has
   * paid for twice. So `ok:false` is now returned for a per-FILE refusal too, not only for a
   * dir-level one, and — unlike the dir-level case — the files that WERE read are still returned:
   * mirroring what we can see is safe, deleting on what we cannot see is not.
   *
   * FOUR OUTCOMES PER FILE, AND THEY ARE DELIBERATELY NOT THE SAME FACT:
   *
   *   - read + parsed          → a source, mirrored, counted live.
   *   - read + UNPARSEABLE     → skipped, silently, and the pass STAYS complete. This is knowledge,
   *                              not ignorance: we hold the bytes and they are not a JSON object.
   *                              A mid-write torn entry is the normal cause, it re-reads cleanly
   *                              within a sweep or two, and prune's "vanished/disqualified source"
   *                              rule is allowed to act on it exactly as it always has.
   *   - refused with `absent`  → skipped, silently, and the pass STAYS complete. The file existed
   *                              at the scan and was gone microseconds later: a session that
   *                              ended. That IS the contract's "vanished source" prune cause, and
   *                              suspending the prune for it would suspend it for the ordinary
   *                              case it was written to handle.
   *   - refused otherwise      → `not-a-file`, `too-large`, `unreadable`. We do not know what that
   *                              entry said. Noted degraded and the pass is marked INCOMPLETE.
   *
   * The degraded note names the REASON and the participant dir, never the file name: names in a
   * sessions dir are chosen by whoever can write there, and `degraded` is surfaced through
   * BridgeStatus into `mesh_status`, which an orchestrating model reads.
   *
   * `raw` is kept even when the strict parse fails, because prune needs the ccoMirror marker off
   * the raw object regardless.
   *
   * AND ONE OUTCOME FOR THE DIRECTORY ITSELF THAT IS NOT A FAILURE: a participant dir that does
   * not exist (ENOENT) is read as empty and COMPLETE, with no note — see the open below. A dir
   * that exists and cannot be opened, or cannot be read to its end, is `ok:false` as before.
   */
  private readDir(dir: string, degraded?: Set<string>): { ok: boolean; files: DirFile[] } {
    // opendirSync + one entry at a time, NOT readdirSync. readdirSync materialises every name in
    // the directory into a single array before returning, so a budget checked afterwards is a
    // budget checked after the allocation it was supposed to prevent. This loop can stop.
    let handle: fs.Dir;
    try {
      handle = fs.opendirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
        // NOT THERE IS NOT UNREADABLE. An account that has never run a session has no
        // `sessions/` directory at all — Claude Code creates it with the first session — so
        // for a freshly added worker account this is the normal state, and it is a COMPLETE
        // picture: a directory that does not exist holds no entry, live or otherwise. Reporting
        // it as unreadable made every such account "degrade" the bridge and, through
        // `readComplete`, limit the prune in every other participant's dir for as long as the
        // account stayed unused.
        //
        // ENOENT ONLY, deliberately. EACCES on the dir or on a parent, ELOOP and EMFILE are a
        // directory that may well be there with entries in it that this pass did not see; and
        // ENOTDIR — something that is not a directory sits where one belongs — is not an
        // account that has yet to run a session but a config dir that is broken, which is worth
        // the note. All of them stay on the incomplete side below.
        //
        // This holds for the HOST's own dir too (`targetDir`): its absence is not a read
        // failure. That nothing can be MIRRORED into a directory that does not exist is a
        // different fact, found and reported where it happens — writeMirror's refused temp
        // write — and only when there is a worker to mirror.
        return { ok: true, files: [] };
      }
      degraded?.add(`unreadable dir ${dir}`);
      return { ok: false, files: [] };
    }
    const out: DirFile[] = [];
    let ok = true;
    let seen = 0;
    try {
      for (;;) {
        let ent;
        try {
          ent = handle.readSync();
        } catch {
          // The directory became unreadable mid-scan. Everything after this point is unseen, so
          // the picture is incomplete for the same reason a failed open is.
          degraded?.add(`unreadable dir ${dir}`);
          ok = false;
          break;
        }
        if (!ent) {
          break;
        }
        if (++seen > DIR_ENTRY_BUDGET) {
          // INCOMPLETE, not merely truncated. Stopping the scan silently would hand the caller a
          // live-source set missing every entry past the budget, and prune would delete their
          // mirrors — a worker could weaponise that by flooding its own sessions dir.
          degraded?.add(
            `dir ${dir} holds more than ${DIR_ENTRY_BUDGET} entries — scan stopped, prune suspended`,
          );
          ok = false;
          break;
        }
        if (!ent.name.endsWith('.json')) {
          continue;
        }
        const file = path.join(dir, ent.name);
        // `noFollow`: an entry is the regular file the CLI (or this bridge) wrote at that name. A
        // symbolic link there is `not-a-file` — an entry that exists and whose contents are not
        // known, which is the incomplete-pass case below, never "the contents of its target".
        const read = readTextSafe(file, SESSION_ENTRY_MAX_BYTES, { noFollow: true });
        if (!read.ok) {
          if (read.reason !== 'absent') {
            degraded?.add(`unreadable session entry in ${dir} (${read.reason})`);
            ok = false;
          }
          continue;
        }
        let raw: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(read.text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
          }
        } catch {
          // corrupt/mid-write single file — skip it, keep sweeping the rest of the dir
        }
        out.push({ file, raw, entry: raw ? parseSessionEntry(raw) : undefined });
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // PREVENTS an fd leak on every sweep, which under a 2s timer is EMFILE within hours — and
        // EMFILE in this codebase is not a slowdown, it is the condition that makes reads fail and
        // therefore, here, the condition that suspends pruning forever.
      }
    }
    return { ok, files: out };
  }
}
