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

/**
 * mesh/bridge — the experimental² cross-account registry mirror (P11). Claude Code's
 * peer discovery reads ONLY the caller's own CLAUDE_CONFIG_DIR/sessions dir, so
 * workers on different accounts cannot see each other. This daemon copies each live,
 * mesh-owned `sessions/<pid>.json` entry into every OTHER participant's dir (marked
 * `ccoMirror:true`) so a worker on account A appears in account B's ListAgents. Only
 * the request direction needs mirroring — replies ride the machine-global `uds:`
 * socket address and bypass discovery entirely (P11).
 *
 * THE INVARIANT that everything else bends around: this daemon must NEVER delete a
 * genuine Claude Code session file. It only ever writes and deletes files carrying
 * its own `ccoMirror:true` marker; a file lacking that marker is untouchable no
 * matter how stale it looks (contract prune rule, premortem #4). The marker is what
 * lets a crash-litter sweep run without risking a real session's discovery entry.
 *
 * BEHAVIOR IS UNCHANGED by the attachable-dispatch rework; only its gating moved. The
 * `meshCrossAccountBridge` registry setting that used to double-opt-in to this daemon is
 * gone, so the bridge is now plain plumbing the server owns: attachable dispatch does not
 * depend on cross-account discovery (results ride files and the workspace's own gateway),
 * and this mirror only widens who can SEE whom. Everything below — the ccoMirror-only
 * deletion invariant above all — still holds exactly as written.
 *
 * Implements the frozen IBridge contract. vscode-free, node18 stdlib only; imports
 * restricted to ./contract, ../registry and node builtins.
 */

/**
 * fs.watch fires a burst of events for a single logical change (and is unreliable on
 * macOS — hence the poll below). Coalesce a burst into one sweep 150ms later so we do
 * not thrash the filesystem per event.
 */
const DEBOUNCE_MS = 150;

/** One json file in a participant dir: its path, the raw parsed object, and the strict parse. */
interface DirFile {
  file: string;
  raw?: Record<string, unknown>;
  entry?: SessionEntry;
}

export class Bridge implements IBridge {
  /** Canonical (realpath) sessions/ dir of each participant, deduped so aliases collapse. */
  private readonly dirs: string[];
  private watchers: fs.FSWatcher[] = [];
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private started = false;
  private lastSyncAt?: number;
  private degraded?: string;
  /** Dirs we successfully attached an fs.watch to — status.participants. */
  private watchedCount = 0;
  /** Mirror files this instance maintained on the last sweep — status.mirrors is how many still exist. */
  private mirrorPaths = new Set<string>();

  constructor(opts: { participants: string[] }) {
    // Canonicalize every participant's sessions dir with realpathSync so two configDirs
    // that resolve to the SAME real dir (symlink, a `./` segment, case-insensitive FS)
    // collapse to ONE string, then dedupe. Without this an aliased self survives as a
    // distinct string, the sync loop's `target === dir` fails to skip it, and the sweep
    // mirrors — then, next sweep, prunes — the source's own real session entry (M3 data
    // loss). realpathSync throws when the dir does not exist yet; path.resolve is the
    // best-effort fallback for that case.
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
    // Full sweep first so a previous run's crash litter (stale mirrors) is pruned and
    // current peers are mirrored before anyone reads discovery (contract start()).
    this.sweep();
    for (const dir of this.dirs) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.scheduleSweep());
        this.watchers.push(watcher);
        this.watchedCount++;
      } catch {
        // dir absent/unwatchable — the poll below still covers it; sweep notes it degraded
      }
    }
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
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    this.watchedCount = 0;
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
      participants: this.watchedCount,
      mirrors,
      lastSyncAt: this.lastSyncAt,
      degraded: this.degraded,
    };
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

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
   * live source into the other dirs, then prune dead mirrors. Synchronous so the poll
   * tick and a debounced watch event can never reenter each other mid-pass. Every
   * filesystem touch is individually try/caught — one unreadable dir or file degrades
   * the status message but never aborts the sweep (contract).
   */
  private sweep(): void {
    const degraded = new Set<string>();

    // Snapshot all dirs up front. Mirrors written later this pass are intentionally
    // NOT in this snapshot, so prune (which uses it) never races its own writes.
    const snapshot = this.dirs.map((dir) => {
      const { ok, files } = this.readDir(dir, degraded);
      return { dir, ok, files };
    });
    // Prune only when EVERY participant dir read cleanly this sweep. A transient readdir
    // failure (EMFILE, …) leaves liveSourcePids incomplete, so pruning could delete a
    // live worker's mirror in another dir just because its source dir happened to fail to
    // read (M4). When incomplete we skip all pruning and leave mirrors in place one extra
    // cycle — safe, since sync rewrites them and a later clean sweep prunes the dead ones.
    const readComplete = snapshot.every((s) => s.ok);

    // A source is a mesh-owned, protocol-1 entry with a live pid. Collect the set of
    // live source pids too — prune keeps only mirrors whose pid is in it.
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
          degraded.add(`foreign peerProtocol ${entry.peerProtocol} on ${entry.name} — not mirrored`);
          continue;
        }
        if (isMirrorableEntry(entry) && isPidAlive(entry.pid)) {
          liveSourcePids.add(entry.pid);
          sources.push({ entry, dir });
        }
      }
    }

    // Sync: ensure every OTHER participant dir holds `<pid>.json` = source + ccoMirror.
    // The pid is machine-globally unique, so a mirror named <sourcePid>.json can only
    // ever be our copy in a foreign dir, never a collision with that dir's own entry.
    const maintained = new Set<string>();
    for (const { entry, dir } of sources) {
      const bytes = JSON.stringify({ ...entry, ccoMirror: true });
      for (const target of this.dirs) {
        // Both are canonical + deduped (constructor), so this string compare reliably
        // skips the source's OWN dir even under symlink/case/`./` aliasing (M3).
        if (target === dir) {
          continue;
        }
        const file = path.join(target, `${entry.pid}.json`);
        maintained.add(file);
        this.writeMirror(file, bytes, degraded);
      }
    }
    this.mirrorPaths = maintained;

    // Prune: delete OUR mirrors whose source is no longer a live mesh source. Regenerating
    // liveSourcePids from `isMirrorableEntry + pid alive` folds in every prune cause the
    // contract names — dead pid, vanished source, or a source that stopped qualifying.
    // The ccoMirror guard is the load-bearing safety check: only marked copies are ever
    // considered for deletion.
    if (readComplete) {
      for (const { files } of snapshot) {
        for (const item of files) {
          if (!item.raw || item.raw.ccoMirror !== true) {
            continue;
          }
          const pid = typeof item.raw.pid === 'number' ? item.raw.pid : NaN;
          if (!liveSourcePids.has(pid)) {
            try {
              fs.unlinkSync(item.file);
            } catch (e) {
              degraded.add(`prune failed for ${item.file}: ${(e as Error).message}`);
            }
          }
        }
      }
    } else {
      degraded.add('prune skipped this sweep: a participant dir failed to read (incomplete live-source picture)');
    }

    this.degraded = degraded.size > 0 ? [...degraded].join('; ') : undefined;
    this.lastSyncAt = Date.now();
  }

  /**
   * Rewrite the mirror only when its bytes actually change. Regenerating the desired
   * bytes from the current source each pass and diffing against disk is the simplest
   * rule that keeps mirror metadata (status, socket, …) fresh as the source mutates
   * WITHOUT rewriting an unchanged file every 2s (contract staleness rule). Atomic:
   * tmp in the same dir, then rename.
   */
  private writeMirror(file: string, bytes: string, degraded: Set<string>): void {
    try {
      let existing: string | undefined;
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {
        existing = undefined;
      }
      if (existing === bytes) {
        return;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
    } catch (e) {
      degraded.add(`mirror write failed for ${file}: ${(e as Error).message}`);
    }
  }

  /**
   * Read one participant dir's json files into {path, raw, strict-parse} triples. A
   * missing/unreadable dir is noted degraded (when a set is given) and yields `ok:false`
   * with no files; a single corrupt file is silently skipped (the dir read still `ok`).
   * `raw` is kept even when the strict parse fails, because prune needs the ccoMirror
   * marker off the raw object regardless. `ok` lets the caller detect a transient dir
   * read failure and suspend pruning while the live-source picture is incomplete (M4).
   */
  private readDir(dir: string, degraded?: Set<string>): { ok: boolean; files: DirFile[] } {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      degraded?.add(`unreadable dir ${dir}`);
      return { ok: false, files: [] };
    }
    const out: DirFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(dir, name);
      let raw: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        }
      } catch {
        // corrupt/mid-write single file — skip it, keep sweeping the rest of the dir
      }
      out.push({ file, raw, entry: raw ? parseSessionEntry(raw) : undefined });
    }
    return { ok: true, files: out };
  }
}
