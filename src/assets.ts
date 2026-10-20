import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Asset-pack engine: deploys Claude Code assets (skills, agents, commands,
 * output styles, hook scripts) from asset packs into a workspace's `.claude/`
 * directory. Packs are plain directories mirroring the `.claude/` layout — the
 * extension's bundled `assets/` directory plus any user-configured pack
 * directories (e.g. a private repo clone).
 *
 * Sync contract: a managed file is only ever written while its on-disk
 * content still matches either the pack content or the hash recorded at the
 * last sync. The moment the user edits an installed file it counts as
 * "customized" — sync reports it and leaves it alone (until the user reverts
 * it or explicitly resets the asset). Files that already existed before an
 * asset was enabled are treated the same way and never overwritten.
 *
 * How a path is touched. Every path this module works on — an install path under the
 * workspace's `.claude/`, the ledger beside them, a file of a pack — is a NAME somebody else
 * can occupy: the workspace is a repository that agents with a shell work in. So a file is
 * read through one guarded reader (readFileGuarded: bounded, non-blocking, no symbolic link
 * at the path, and only a regular file is content), and written by putting a new file beside
 * the target and renaming it over the name (replaceFile) — a name is never opened for
 * writing, so a pipe put there cannot hold the caller and a link cannot redirect the bytes.
 * What is at an install path and is not a regular file sync can read whole is NOT SYNC'S: it
 * is never hashed as content, never written and never removed, the report says which file of
 * which asset and why (`SyncReport.blocked`), and the sync goes on with the others.
 *
 * This module must not import 'vscode' (kept UI-free like registry.ts).
 */

export type AssetType = 'skill' | 'agent' | 'command' | 'output-style' | 'hook';

/** Pack subdirectory per asset type — identical to the `.claude/` layout. */
export const ASSET_TYPE_DIRS: Record<AssetType, string> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  'output-style': 'output-styles',
  hook: 'hooks',
};

export interface PackAsset {
  /** Stable identity: "<pack>:<type-dir>/<id>". */
  key: string;
  pack: string;
  type: AssetType;
  id: string;
  /** From the asset's frontmatter, when present. */
  description?: string;
  /** Install path relative to `.claude/` (posix separators) -> absolute source path. */
  files: Record<string, string>;
}

export interface AssetPack {
  name: string;
  root: string;
  assets: PackAsset[];
}

/** Per-asset install record in the workspace state file. */
export interface AssetRecord {
  enabled: boolean;
  /** rel path (under .claude/) -> sha256 of the content last written by sync. */
  files: Record<string, string>;
}

export interface AssetState {
  version: 1;
  assets: Record<string, AssetRecord>;
}

export type AssetStatus = 'not-installed' | 'synced' | 'update-available' | 'customized' | 'conflict';

export interface SyncReport {
  /** Asset keys installed for the first time. */
  installed: string[];
  /** Asset keys with at least one file refreshed from the pack. */
  updated: string[];
  /** rel paths uninstalled (asset disabled or dropped from its pack). */
  removed: string[];
  /** rel paths left untouched because the local copy was edited by hand. */
  customized: string[];
  /** Enabled asset keys whose pack is currently unavailable (files kept as-is). */
  orphaned: string[];
  /** rel paths skipped because another enabled asset owns the same install path. */
  conflicts: string[];
  /**
   * Files sync left alone because it could not safely read, write or remove them: something
   * that is not a regular file at the install path (a symbolic link, a directory, a pipe), a
   * file past the read limit, a path that could not be read or written. Each names its asset.
   */
  blocked: SyncBlocked[];
}

/** One file sync left alone, and why. */
export interface SyncBlocked {
  /** Key of the asset the file belongs to. */
  asset: string;
  /** Install path relative to `.claude/`; `''` when the asset as a whole could not be synced. */
  rel: string;
  /**
   * Why, in a few English words composed here from literals, byte counts and errno codes —
   * never a path and never a byte of a file's content.
   */
  reason: string;
}

export function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * A rel path must resolve inside `.claude/`. Pack scanning can only produce
 * safe components, but rels are also read back from the on-disk ledger, which
 * a repo or a bad edit could seed with traversal segments.
 */
export function isSafeRel(rel: string): boolean {
  return (
    rel.length > 0 &&
    rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && !seg.includes('\\') && !seg.includes(':'))
  );
}

/**
 * The largest file this module reads at a pack path or an install path. The bundled assets
 * are about a kilobyte each; this is some sixteen thousand times that — far past anything a
 * pack ships — and it is what bounds the read of a file somebody else put at an install path.
 */
const ASSET_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** Whether this platform can refuse a symbolic link in the open itself (win32 cannot). */
const HAS_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number';

/**
 * Open flags of every read here: read-only; NON-BLOCKING, so a pipe at the path is opened at
 * once instead of waiting for a writer that never comes; never a controlling terminal; and no
 * symbolic link at the path itself. (Each optional flag is tested for: a constant the platform
 * lacks would turn the whole set into NaN.)
 */
const READ_GUARDED =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

/** A shape-checked errno code of a caught value, as ` (CODE)`, or nothing. */
function errnoSuffix(e: unknown): string {
  const code: unknown = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : '';
}

/** What a thing that is not a regular file is, for a refusal reason. Literals only. */
function pathKind(st: fs.Stats): string {
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

/** Is a symbolic link at `file` right now? (`lstat`: the link itself is asked.) */
function isSymbolicLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The bytes of a regular file and its permission bits, or why there are none. */
type GuardedRead =
  | { ok: true; bytes: Buffer; mode: number }
  /** `absent`: nothing is at the path (ENOENT) — the one failure that is not a problem. */
  | { ok: false; absent: boolean; reason: string };

/**
 * Read the whole of the REGULAR FILE at `file`, or say why not. Never throws, never blocks,
 * never reads more than `maxBytes`, and never follows a symbolic link at the path.
 *
 * THE one way this module reads a path it does not control. The thing opened is asked what it
 * is (`fstat` of the descriptor, not a `stat` of the name, which can be something else a
 * moment later): a directory, a pipe, a socket or a device is a refusal, and so is a file past
 * the limit — refused, not cut short, because a prefix would be hashed as if it were the file.
 * The bytes come back as they are: assets are mostly text, but a skill or a hook directory may
 * bundle any file, and an install has to be the pack's bytes.
 */
function readFileGuarded(file: string, maxBytes: number): GuardedRead {
  const refused = (reason: string): GuardedRead => ({ ok: false, absent: false, reason });
  let fd = -1;
  try {
    if (!HAS_O_NOFOLLOW && isSymbolicLink(file)) {
      return refused('the path is a symbolic link, which is not read through');
    }
    fd = fs.openSync(file, READ_GUARDED);
  } catch (e) {
    const code: unknown = (e as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return { ok: false, absent: true, reason: 'nothing is at the path' };
    }
    // The no-follow open refuses a link with ELOOP (EMLINK on some systems). The same code is
    // also a genuine loop of links on the way, so the name is asked which it was.
    if ((code === 'ELOOP' || code === 'EMLINK') && isSymbolicLink(file)) {
      return refused('the path is a symbolic link, which is not read through');
    }
    return refused(`the path could not be opened${errnoSuffix(e)}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return refused(`the path is ${pathKind(st)}`);
    }
    if (st.size > maxBytes) {
      return refused(`the file is ${st.size} bytes, past the ${maxBytes}-byte limit`);
    }
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, bytes, read, st.size - read, read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    if (read < st.size) {
      // Shorter than its own size said: it shrank under the read, and a prefix is not the file.
      return refused('the file changed while it was being read');
    }
    return { ok: true, bytes, mode: st.mode & 0o777 };
  } catch (e) {
    return refused(`the file could not be read${errnoSuffix(e)}`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // nothing was written through this descriptor
    }
  }
}

/**
 * Open flags of the new file replaceFile writes beside its target: created EXCLUSIVELY, so the
 * open fails when anything at all already has the name — a file, a pipe, a symbolic link
 * (which an exclusive create does not follow) — rather than writing to it or through it. The
 * no-follow and non-blocking flags say the same thing once more where the platform has them.
 */
const NEW_FILE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

/**
 * Put `data` at `target` by REPLACING THE NAME, or change nothing: the bytes go into a new
 * file beside the target (created exclusively, under a name nobody can predict), and that
 * file then takes the target's name. Returns undefined once the name holds the new file, else
 * the reason. Never throws.
 *
 * THE one way this module writes a file. The target itself is never opened: a pipe at the
 * name cannot hold the caller, a symbolic link there is replaced rather than written through,
 * and a reader never sees half a file. A DIRECTORY at the name is not replaced — that is a
 * refusal. With `onlyIfAbsent` the new file is LINKED into place instead, which fails when
 * anything is at the name — for a file that must be new.
 *
 * `mode` sets the new file's permission bits exactly (on the descriptor, so the process umask
 * does not filter them); without it the file gets the default for a new one.
 */
function replaceFile(
  target: string,
  data: Buffer | string,
  options: { mode?: number; onlyIfAbsent?: boolean } = {},
): string | undefined {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = -1;
  let created = false;
  try {
    fd = fs.openSync(tmp, NEW_FILE_FLAGS, 0o666);
    created = true;
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let written = 0;
    // Loop on short writes: a single call may write less than it was given, and what would
    // then be renamed into place is the first part of a file.
    while (written < bytes.length) {
      const n = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (n <= 0) {
        break;
      }
      written += n;
    }
    if (written < bytes.length) {
      return `only ${written} of ${bytes.length} bytes could be written`;
    }
    if (options.mode !== undefined) {
      fs.fchmodSync(fd, options.mode);
    }
    fs.closeSync(fd);
    fd = -1;
    if (options.onlyIfAbsent === true) {
      try {
        fs.linkSync(tmp, target);
        // In place under its own name; the temp name is removed on the way out.
        return undefined;
      } catch (e) {
        if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
          return 'something is already at that name';
        }
        // A filesystem without hard links: a rename instead, after one more look.
        let present = true;
        try {
          fs.lstatSync(target);
        } catch {
          present = false;
        }
        if (present) {
          return 'something is already at that name';
        }
      }
    } else {
      let directory = false;
      try {
        directory = fs.lstatSync(target).isDirectory();
      } catch {
        // nothing there, or nothing that can be examined: the rename says which
      }
      if (directory) {
        return 'the path is a directory';
      }
    }
    fs.renameSync(tmp, target);
    created = false;
    return undefined;
  } catch (e) {
    return `the file could not be written${errnoSuffix(e)}`;
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    if (created) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ours, and harmless; the caller reports the real failure
      }
    }
  }
}

function walkFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(path.join(root, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** First `description:` value in the file's frontmatter block, if any. */
function readDescription(file: string): string | undefined {
  try {
    const read = readFileGuarded(file, ASSET_FILE_MAX_BYTES);
    if (!read.ok) {
      return undefined;
    }
    const text = read.bytes.toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    // [ \t]* not \s* — \s crosses newlines, so an empty `description:` would
    // capture whatever the next frontmatter line happens to be.
    const match = frontmatter && /^description:[ \t]*(.+)$/m.exec(frontmatter[1]);
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Id of a top-level hook script: the filename with a single trailing extension
 * removed, so `block-rm.sh` installs as `hooks/block-rm.sh` but shows up as the
 * asset `block-rm`. Hooks are scripts, not markdown, and the extension is an
 * implementation detail of the script's language, not part of its identity.
 */
function hookScriptId(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** `pack.json` holds a name; far past this it is not one. */
const PACK_META_MAX_BYTES = 1024 * 1024;

/**
 * Load a pack directory. Pack name comes from an optional `pack.json`
 * ({"name": ...}), then the caller's fallback, then the directory basename.
 * Returns undefined when the directory doesn't exist.
 */
export function loadPack(root: string, fallbackName?: string): AssetPack | undefined {
  if (!fs.existsSync(root)) {
    return undefined;
  }
  let name = fallbackName ?? path.basename(root);
  try {
    // Through the guarded reader like every other file here: a pack directory is listed on
    // every activation, and a pipe named `pack.json` in one must not hold that up.
    const read = readFileGuarded(path.join(root, 'pack.json'), PACK_META_MAX_BYTES);
    const meta = (read.ok ? JSON.parse(read.bytes.toString('utf8')) : undefined) as { name?: string } | undefined;
    if (typeof meta?.name === 'string' && meta.name.trim()) {
      name = meta.name.trim();
    }
  } catch {
    // pack.json is optional
  }
  const assets: PackAsset[] = [];
  const push = (type: AssetType, dir: string, id: string, files: Record<string, string>, description?: string) =>
    assets.push({ key: `${name}:${dir}/${id}`, pack: name, type, id, description, files });

  for (const [type, dir] of Object.entries(ASSET_TYPE_DIRS) as [AssetType, string][]) {
    const typeRoot = path.join(root, dir);
    if (type === 'skill') {
      // One directory per skill, each carrying a SKILL.md plus any supporting
      // files. Skill ids stay flat: the walk below only collects the skill's
      // own files, it does not turn a subdirectory into a second skill.
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(typeRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) {
          continue;
        }
        const skillRoot = path.join(typeRoot, entry.name);
        const files: Record<string, string> = {};
        for (const rel of walkFiles(skillRoot)) {
          files[`${dir}/${entry.name}/${rel}`] = path.join(skillRoot, ...rel.split('/'));
        }
        if (!files[`${dir}/${entry.name}/SKILL.md`]) {
          continue;
        }
        push(type, dir, entry.name, files, readDescription(path.join(skillRoot, 'SKILL.md')));
      }
    } else if (type === 'hook') {
      // A hook is a script Claude Code executes (`.sh`, `.py`, no extension at
      // all…), never markdown — so no frontmatter and no readDescription call.
      // A top-level file is one hook; a top-level directory is one hook that
      // bundles everything beneath it, exactly as a skill bundles its files.
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(typeRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      const visible = entries.filter((entry) => !entry.name.startsWith('.'));
      // Stripping the extension makes `fmt.sh` and `fmt.py` claim the same id.
      // Count the candidate ids first; every entry in a colliding group keeps
      // its full filename instead, which is unique within a directory.
      const idCounts = new Map<string, number>();
      for (const entry of visible) {
        if (entry.isDirectory() || entry.isFile()) {
          const candidate = entry.isDirectory() ? entry.name : hookScriptId(entry.name);
          idCounts.set(candidate, (idCounts.get(candidate) ?? 0) + 1);
        }
      }
      for (const entry of visible) {
        if (entry.isDirectory()) {
          const hookRoot = path.join(typeRoot, entry.name);
          const files: Record<string, string> = {};
          for (const rel of walkFiles(hookRoot)) {
            files[`${dir}/${entry.name}/${rel}`] = path.join(hookRoot, ...rel.split('/'));
          }
          if (Object.keys(files).length === 0) {
            continue; // an empty directory installs nothing
          }
          push(type, dir, entry.name, files);
        } else if (entry.isFile()) {
          const candidate = hookScriptId(entry.name);
          const id = (idCounts.get(candidate) ?? 0) > 1 ? entry.name : candidate;
          push(type, dir, id, { [`${dir}/${entry.name}`]: path.join(typeRoot, entry.name) });
        }
      }
    } else {
      // Commands, agents and output styles are single `.md` files, discovered
      // recursively so a subdirectory namespaces the id:
      // `commands/frontend/component.md` -> id `frontend/component`, invoked as
      // `/frontend:component`. Only commands document namespacing today, but a
      // recursive walk can only ever find more files, never fewer.
      let rels: string[];
      try {
        rels = walkFiles(typeRoot);
      } catch {
        continue;
      }
      for (const rel of rels) {
        if (!rel.endsWith('.md')) {
          continue;
        }
        const source = path.join(typeRoot, ...rel.split('/'));
        push(type, dir, rel.replace(/\.md$/, ''), { [`${dir}/${rel}`]: source }, readDescription(source));
      }
    }
  }
  return { name, root, assets };
}

export function assetStateFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'cco-assets.json');
}

/**
 * Thrown when the workspace's asset ledger EXISTS and cannot be understood: not a regular
 * file, over the read cap, unreadable, not JSON, or JSON of another shape than this version
 * writes. Nothing was changed when it is thrown — in particular the ledger is not moved aside
 * and not replaced — and `message` is a complete sentence naming the file and the reason, for
 * the caller to show together with a way to open the file.
 */
export class AssetStateUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`Could not read ${file}: ${reason}. Nothing was changed.`);
    this.name = 'AssetStateUnreadableError';
  }
}

/** A ledger lists installed files and their hashes; far past this it is not one of ours. */
const STATE_READ_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The ledger's text; undefined when there is no ledger (ENOENT). Anything else that is at
 * its path and is not a readable regular file throws — a directory, a pipe (which is not
 * waited on), a file past the limit, and a symbolic link: the ledger is this module's own
 * file under a name of its own below `.claude`, and is not read through a link any more than
 * an install path is written through one.
 */
function readStateText(file: string): string | undefined {
  const read = readFileGuarded(file, STATE_READ_MAX_BYTES);
  if (read.ok) {
    return read.bytes.toString('utf8');
  }
  if (read.absent) {
    return undefined;
  }
  throw new AssetStateUnreadableError(file, read.reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The workspace's asset ledger. No file at all is a fresh workspace: an empty ledger.
 *
 * A file that IS there is used only when it is understood: JSON (one leading byte-order mark
 * is ignored) holding an object, whose `version` — when it names one — is this version's, and
 * whose `assets` is an object of `{ enabled, files }` records. Anything else throws
 * `AssetStateUnreadableError` and changes nothing. The ledger sits inside the user's
 * repository, where it is edited, merged and checked out by other versions; every write of it
 * is a read-modify-write, so reading something half-understood as "empty" would have the next
 * sync persist an empty ledger over it and treat every installed file as unmanaged.
 *
 * Top-level keys and record fields this version does not know are kept as they are and
 * written back unchanged.
 */
export function readAssetState(workspaceRoot: string): AssetState {
  const file = assetStateFile(workspaceRoot);
  const text = readStateText(file);
  if (text === undefined) {
    return { version: 1, assets: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    const detail = e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 160) : 'parse error';
    throw new AssetStateUnreadableError(file, `the file is not valid JSON (${detail})`);
  }
  if (!isPlainObject(parsed)) {
    throw new AssetStateUnreadableError(file, 'the file does not hold a JSON object');
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new AssetStateUnreadableError(
      file,
      'the file is in a format this version of the extension does not know (its "version" is not 1)',
    );
  }
  const assets = parsed.assets ?? {};
  if (!isPlainObject(assets)) {
    throw new AssetStateUnreadableError(file, 'its "assets" is not a JSON object');
  }
  for (const record of Object.values(assets)) {
    const files = isPlainObject(record) ? record.files : undefined;
    if (
      !isPlainObject(record) ||
      typeof record.enabled !== 'boolean' ||
      !isPlainObject(files) ||
      !Object.values(files).every((hash) => typeof hash === 'string')
    ) {
      throw new AssetStateUnreadableError(
        file,
        'one of its asset records is not of the form { "enabled": true or false, "files": { path: hash } }',
      );
    }
  }
  return { ...parsed, version: 1, assets: assets as Record<string, AssetRecord> };
}

/**
 * Persist the asset ledger, by replacing the name (replaceFile): a crash mid-write never
 * leaves half a ledger, and nothing that sits at the ledger's path — or at a temp name beside
 * it — is opened, waited on or written through.
 *
 * A WRITE THAT COULD NOT BE MADE THROWS. This function persists a DECISION, never a cache:
 * `setAssetEnabled` records the user's enable/disable choice, and the sync path records which
 * managed files are installed and what their hashes were. A silent no-op would have the UI
 * show an asset enabled while the ledger says it is not — and the very next sync would then
 * treat installed files as unmanaged, or reinstall over a customization it no longer knows it
 * owns. The ledger that was there is whole and unchanged when this throws; the files a sync
 * installed before it are on disk, and the next sync finds them identical to the pack and
 * records them then.
 */
export function writeAssetState(workspaceRoot: string, state: AssetState): void {
  const file = assetStateFile(workspaceRoot);
  let refused: string | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    refused = replaceFile(file, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    refused = `its directory could not be created${errnoSuffix(e)}`;
  }
  if (refused !== undefined) {
    throw new Error(`Could not write ${file}: ${refused}. The asset ledger is as it was.`);
  }
}

/**
 * Record whether the asset `key` is enabled in this workspace (a read-modify-write of the
 * ledger; the files follow at the next sync).
 *
 * The ledger's `assets` is a plain object keyed by asset key, and a key is a string somebody
 * supplied. Only an entry the ledger itself HOLDS is updated, and a new one is defined on the
 * object rather than assigned: for a key every object answers to (`__proto__`, `constructor`)
 * a plain lookup returns something inherited, and writing `enabled` to that would change every
 * object in the process instead of one record in a file.
 */
export function setAssetEnabled(workspaceRoot: string, key: string, enabled: boolean): void {
  const state = readAssetState(workspaceRoot);
  const held = Object.prototype.hasOwnProperty.call(state.assets, key) ? state.assets[key] : undefined;
  const record = held ?? { enabled: false, files: {} };
  record.enabled = enabled;
  Object.defineProperty(state.assets, key, { value: record, enumerable: true, writable: true, configurable: true });
  writeAssetState(workspaceRoot, state);
}

function targetPath(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, '.claude', ...rel.split('/'));
}

/**
 * Why sync may NOT write or remove the install path `target`, or undefined when it may: only
 * when nothing below the workspace's `.claude` redirects it — the path itself is not a
 * symbolic link, and its directory (or, while that does not exist yet, the nearest ancestor
 * that does) resolves to a place inside `.claude`. A link there is part of the repository's
 * content, and following one would write or delete a file wherever it points; such a path is
 * left alone and reported (`SyncReport.blocked`). `.claude` itself may be a link: where a
 * workspace keeps that directory is its owner's choice, and it moves every install path
 * together. Anything that cannot be examined or resolved is not ours either.
 */
function installPathProblem(workspaceRoot: string, target: string): string | undefined {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      return 'the path is a symbolic link, which sync does not write through';
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return `the path could not be examined${errnoSuffix(e)}`;
    }
  }
  const base = path.join(workspaceRoot, '.claude');
  let at = path.dirname(target);
  for (;;) {
    let present = true;
    try {
      fs.lstatSync(at);
    } catch {
      present = false;
    }
    if (present) {
      break;
    }
    if (at === base || !at.startsWith(base + path.sep)) {
      // Not even `.claude` exists: every directory on the way will be created by sync itself.
      return undefined;
    }
    at = path.dirname(at);
  }
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(at);
    return real === realBase || real.startsWith(realBase + path.sep)
      ? undefined
      : 'a directory on the way to the path is a symbolic link that leads out of .claude';
  } catch (e) {
    return `the path could not be resolved${errnoSuffix(e)}`;
  }
}

/** What is at an install path, as far as sync is concerned. */
type InstallLook =
  /** Nothing: sync may create the file. */
  | { state: 'absent' }
  /** A regular file that was read whole: its hash, and its permission bits. */
  | { state: 'file'; hash: string; mode: number }
  /** Something sync neither reads as content, writes nor removes — and why. */
  | { state: 'blocked'; reason: string };

/**
 * Look at one install path: is it sync's to write (installPathProblem), and what does it hold
 * (readFileGuarded)? Everything that decides what sync does with a path asks here, so the
 * status a view shows, the sync and the removal of a disabled asset cannot disagree about it.
 */
function lookAtInstallPath(workspaceRoot: string, target: string): InstallLook {
  const notOurs = installPathProblem(workspaceRoot, target);
  if (notOurs !== undefined) {
    return { state: 'blocked', reason: notOurs };
  }
  const read = readFileGuarded(target, ASSET_FILE_MAX_BYTES);
  if (read.ok) {
    return { state: 'file', hash: sha256(read.bytes), mode: read.mode };
  }
  return read.absent ? { state: 'absent' } : { state: 'blocked', reason: read.reason };
}

/**
 * Put `bytes` at the install path `target`, creating its directories. Returns undefined once
 * the file is there, else the reason. Never throws.
 */
function installFile(
  workspaceRoot: string,
  target: string,
  bytes: Buffer,
  mode: number | undefined,
): string | undefined {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (e) {
    return `its directory could not be created${errnoSuffix(e)}`;
  }
  // Asked again now that the directories exist: one on the way may be a link that was not
  // there when the path was looked at.
  return installPathProblem(workspaceRoot, target) ?? replaceFile(target, bytes, { mode });
}

export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Scaffolds are skeletons, not drafts: every slot is present but empty, and
 * the guidance lives in comments so nothing reads as authored content.
 * Inside the frontmatter fences only `#` comments are legal (an HTML comment
 * there is a YAML parse error); the body uses `<!-- -->`. A hook is a script
 * rather than markdown, so its template carries `#` comments and nothing else.
 *
 * `description:` may now sit anywhere in the frontmatter: readDescription
 * anchors on `/^description:[ \t]*(.+)$/m`, and `[ \t]*` cannot cross the
 * newline that `\s*` used to, so an empty `description:` no longer swallows the
 * frontmatter line that follows it.
 *
 * The id is single-quoted: ASSET_ID_PATTERN admits ids YAML would read as
 * numbers (`9`, `1.5`, `1_000`), and it forbids quotes, so this cannot escape.
 */
const ASSET_TEMPLATES: Record<AssetType, (id: string) => string> = {
  skill: (id) => `---
name: '${id}'
# description: one line, third person, stating WHEN Claude should use this skill.
# Claude sees only name + description until the skill triggers, so this line is the trigger.
description:
# Optional keys, all omitted here — see the skills frontmatter reference:
#   when_to_use: extra trigger context, weighed alongside description.
#   allowed-tools: restrict this skill to a subset of tools.
#   disable-model-invocation: true = user-invoked only, never auto-selected.
#   context: extra files preloaded when the skill triggers.
---

<!-- The procedural instructions Claude follows once this skill triggers — the body -->
<!-- loads only then. Numbered steps, hard constraints, a worked example. -->
`,
  agent: (id) => `---
name: '${id}'
# An optional 'tools:' key restricts this agent to a subset of tools; omit it to inherit all tools.
# description: one line, third person, stating WHEN this agent should be invoked.
# Claude matches on it to auto-invoke the agent — concrete example invocations help.
description:
---

<!-- The agent's system prompt: the role it takes on, the method it must follow, -->
<!-- and the exact output format it must return. -->
<!-- Delete these comments as you fill the body in. -->
`,
  command: () => `---
# A slash command takes no 'name:' key — the filename is the command name.
# Custom commands are now merged into skills: commands/deploy.md and
# skills/deploy/SKILL.md both create /deploy and work the same way. A skill also
# supports a directory of supporting files and model-invocation control, so new
# work generally belongs in skills/; existing commands/ files keep working.
# An optional 'argument-hint:' key documents the arguments the command menu shows.
# description: one line, third person, stating what this command does.
description:
---

<!-- The body is the prompt sent to Claude when this command runs. -->
<!-- $ARGUMENTS interpolates whatever the user typed after the command name. -->
<!-- Delete these comments as you fill the body in. -->
`,
  'output-style': (id) => `---
name: '${id}'
# description: one line, third person, stating what this output style changes.
description:
---

<!-- These instructions replace Claude Code's default output-style instructions. -->
<!-- Describe the tone, structure, and formatting Claude must use while it is active. -->
<!-- Delete these comments as you fill the body in. -->
`,
  hook: (id) => `#!/usr/bin/env bash
set -euo pipefail

# Hooks are wired up in .claude/settings.json — dropping a script in .claude/hooks/
# registers nothing on its own. Add an entry shaped like:
#   "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${id}.sh" } ] } ] }
#
# The hook receives the event payload as JSON on stdin. A non-zero exit blocks the
# tool call; for PreToolUse, exit 2 is the block signal and stderr goes back to Claude.
#
# Uncomment to dump the payload while you work out what this hook should do:
# cat
`,
};

/**
 * Scaffold a new asset in a pack directory and return the absolute path of
 * its primary file. Throws when the id is invalid or the asset already exists.
 *
 * Scaffolding only ever writes into the top level of the type directory, so the
 * id stays flat and ASSET_ID_PATTERN — which forbids `/` and is the traversal
 * guard — stays exactly as strict as it is. Namespacing is a discovery-side
 * feature: create the subdirectory by hand and loadPack picks the file up under
 * a nested id, e.g. `commands/frontend/component.md` as `frontend/component`.
 */
export function createAssetTemplate(packRoot: string, type: AssetType, id: string): string {
  if (!ASSET_ID_PATTERN.test(id)) {
    throw new Error(`Invalid asset id "${id}" — use letters, digits, ".", "-" or "_".`);
  }
  const dir = ASSET_TYPE_DIRS[type];
  const file =
    type === 'skill'
      ? path.join(packRoot, dir, id, 'SKILL.md')
      : path.join(packRoot, dir, type === 'hook' ? `${id}.sh` : `${id}.md`);
  // `lstat`, so that a symbolic link at the name counts as something being there — also one
  // that leads nowhere, through which a plain write would create a file at its target.
  let taken = true;
  try {
    fs.lstatSync(type === 'skill' ? path.dirname(file) : file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      throw new Error(`Could not create asset "${id}" in ${path.join(packRoot, dir)}${errnoSuffix(e)}.`);
    }
    taken = false;
  }
  if (taken) {
    throw new Error(`Asset "${id}" already exists in ${path.join(packRoot, dir)}.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A new file or nothing: linked into place, which fails if the name was taken meanwhile.
  // Claude Code execs a hook script, so that one is made executable (set on the new file
  // itself, where the process umask does not filter it).
  const refused = replaceFile(file, ASSET_TEMPLATES[type](id), {
    onlyIfAbsent: true,
    mode: type === 'hook' ? 0o755 : undefined,
  });
  if (refused !== undefined) {
    throw new Error(`Could not create ${file}: ${refused}.`);
  }
  return file;
}

/** Sync relationship of one installed file to its pack source. */
export type FileSyncState =
  | 'in-sync' // disk matches the pack
  | 'writable' // missing or untouched since install — sync may write it
  | 'customized' // edited by hand, pre-existing, or not a file sync can use — sync never writes it
  | 'missing-source'; // pack file unreadable — not the workspace's problem

function fileSyncState(
  workspaceRoot: string,
  source: string,
  target: string,
  recordedHash: string | undefined,
): FileSyncState {
  const pack = readFileGuarded(source, ASSET_FILE_MAX_BYTES);
  if (!pack.ok) {
    return 'missing-source';
  }
  const look = lookAtInstallPath(workspaceRoot, target);
  if (look.state === 'blocked') {
    // Not a file sync reads, writes or removes (a link, a directory, a pipe, a file past the
    // limit): shown as the one state that means "sync leaves this alone".
    return 'customized';
  }
  if (look.state === 'absent') {
    return 'writable';
  }
  if (look.hash === sha256(pack.bytes)) {
    return 'in-sync';
  }
  // Untouched since sync wrote it: what sync would write over. Anything else was edited.
  return look.hash === recordedHash ? 'writable' : 'customized';
}

export interface AssetFileInfo {
  /** Install path relative to `.claude/`. */
  rel: string;
  /** Absolute pack source path. */
  source: string;
  /** Absolute installed path (may not exist yet). */
  target: string;
  installed: boolean;
  state: FileSyncState;
}

/** Per-file sync detail for one asset — feeds file lists and diff views. */
export function assetFiles(asset: PackAsset, state: AssetState, workspaceRoot: string): AssetFileInfo[] {
  const record = state.assets[asset.key];
  return Object.entries(asset.files).map(([rel, source]) => {
    const target = targetPath(workspaceRoot, rel);
    return {
      rel,
      source,
      target,
      installed: fs.existsSync(target),
      state: fileSyncState(workspaceRoot, source, target, record?.files[rel]),
    };
  });
}

/**
 * First enabled asset claiming each install path, in pack order. Two assets
 * (e.g. a bundled command and a same-id private override) can target the same
 * `.claude/` file; sync writes only the owner and reports the rest as
 * conflicts instead of mislabeling them "customized".
 */
export function relOwners(assets: PackAsset[], state: AssetState): Map<string, string> {
  const owners = new Map<string, string>();
  for (const asset of assets) {
    if (state.assets[asset.key]?.enabled) {
      for (const rel of Object.keys(asset.files)) {
        if (!owners.has(rel)) {
          owners.set(rel, asset.key);
        }
      }
    }
  }
  return owners;
}

/** Status of one asset in a workspace, for pickers and views. */
export function assetStatus(
  asset: PackAsset,
  state: AssetState,
  workspaceRoot: string,
  owners?: Map<string, string>,
): AssetStatus {
  const record = state.assets[asset.key];
  if (!record?.enabled) {
    return 'not-installed';
  }
  if (owners && Object.keys(asset.files).some((rel) => (owners.get(rel) ?? asset.key) !== asset.key)) {
    return 'conflict';
  }
  let update = false;
  let customized = false;
  for (const [rel, source] of Object.entries(asset.files)) {
    const fileState = fileSyncState(workspaceRoot, source, targetPath(workspaceRoot, rel), record.files[rel]);
    if (fileState === 'writable') {
      update = true;
    } else if (fileState === 'customized') {
      customized = true;
    }
  }
  return customized ? 'customized' : update ? 'update-available' : 'synced';
}

export interface OrphanedAsset {
  key: string;
  /** Recorded install paths (relative to `.claude/`) still tracked for this asset. */
  files: string[];
}

/** Enabled assets recorded in the workspace whose pack is not currently loaded. */
export function orphanedAssets(packs: AssetPack[], workspaceRoot: string): OrphanedAsset[] {
  const known = new Set(packs.flatMap((pack) => pack.assets.map((asset) => asset.key)));
  const state = readAssetState(workspaceRoot);
  return Object.entries(state.assets)
    .filter(([key, record]) => record.enabled && !known.has(key))
    .map(([key, record]) => ({ key, files: Object.keys(record.files) }));
}

/**
 * Reconcile every recorded asset in the workspace with the given packs.
 * `force` holds asset keys whose customized files should be overwritten with
 * the pack version (explicit whole-asset reset); `forceFiles` holds
 * `key\0rel` entries for single-file resets.
 *
 * A file that cannot be read, written or removed is skipped and named in `report.blocked`;
 * the rest of its asset and every other asset are still synced. What throws is the LEDGER:
 * one that cannot be understood (before anything is touched) or cannot be written (after).
 */
export function syncWorkspace(
  packs: AssetPack[],
  workspaceRoot: string,
  force: Set<string> = new Set(),
  forceFiles: Set<string> = new Set(),
): SyncReport {
  const state = readAssetState(workspaceRoot);
  const before = JSON.stringify(state);
  const report: SyncReport = {
    installed: [],
    updated: [],
    removed: [],
    customized: [],
    orphaned: [],
    conflicts: [],
    blocked: [],
  };
  const byKey = new Map<string, PackAsset>();
  for (const pack of packs) {
    for (const asset of pack.assets) {
      if (!byKey.has(asset.key)) {
        byKey.set(asset.key, asset);
      }
    }
  }

  // Pack renames change every asset key (keys embed the pack name). An
  // enabled record whose key vanished migrates to the single loaded asset
  // that has no record yet and ships the same install paths, instead of
  // surfacing as an orphan of a pack that is actually present.
  for (const [key, record] of Object.entries(state.assets)) {
    if (!record.enabled || byKey.has(key)) {
      continue;
    }
    const rels = Object.keys(record.files);
    if (rels.length === 0) {
      continue;
    }
    const candidates = [...byKey.values()].filter(
      (asset) => !state.assets[asset.key] && rels.some((rel) => rel in asset.files),
    );
    if (candidates.length === 1) {
      state.assets[candidates[0].key] = record;
      delete state.assets[key];
    }
  }

  const owners = relOwners([...byKey.values()], state);

  for (const [key, record] of Object.entries(state.assets)) {
    const asset = byKey.get(key);
    if (record.enabled && !asset) {
      // Pack temporarily unavailable (e.g. private pack not cloned on this
      // machine) — keep the installed files, just report it.
      report.orphaned.push(key);
      continue;
    }
    if (!record.enabled) {
      for (const rel of Object.keys(record.files)) {
        const owner = owners.get(rel);
        if (owner && owner !== key) {
          // Another enabled asset claims this path — hand the recorded hash
          // over so the new owner may overwrite the untouched copy, and keep
          // the file on disk.
          const ownerRecord = state.assets[owner];
          if (ownerRecord && ownerRecord.files[rel] === undefined) {
            ownerRecord.files[rel] = record.files[rel];
          }
          delete record.files[rel];
          continue;
        }
        removeFileIfOwned(workspaceRoot, key, record, rel, report);
      }
      if (Object.keys(record.files).length === 0) {
        delete state.assets[key];
      }
      continue;
    }
    try {
      syncAsset(asset!, record, workspaceRoot, owners, force.has(key), forceFiles, report);
    } catch (e) {
      // Every step inside reports its own failure; this is for the one nobody foresaw. One
      // asset that cannot be synced does not stop the others.
      report.blocked.push({ asset: key, rel: '', reason: `the asset could not be synced${errnoSuffix(e)}` });
    }
  }

  // Never create (or touch) the ledger when nothing is managed and nothing
  // changed — a bare workspace must stay bare after a startup auto-sync.
  const after = JSON.stringify(state);
  if (after !== before || fs.existsSync(assetStateFile(workspaceRoot))) {
    if (after !== before || Object.keys(state.assets).length > 0) {
      writeAssetState(workspaceRoot, state);
    }
  }
  return report;
}

function syncAsset(
  asset: PackAsset,
  record: AssetRecord,
  workspaceRoot: string,
  owners: Map<string, string>,
  force: boolean,
  forceFiles: Set<string>,
  report: SyncReport,
): void {
  const firstInstall = Object.keys(record.files).length === 0;
  let wrote = false;
  for (const [rel, source] of Object.entries(asset.files)) {
    if (!isSafeRel(rel)) {
      continue;
    }
    if ((owners.get(rel) ?? asset.key) !== asset.key) {
      report.conflicts.push(rel);
      continue;
    }
    const target = targetPath(workspaceRoot, rel);
    const blocked = (reason: string): void => {
      report.blocked.push({ asset: asset.key, rel, reason });
    };
    const look = lookAtInstallPath(workspaceRoot, target);
    if (look.state === 'blocked') {
      // A link at the path or on the way to it, a directory, a pipe, a file past the limit:
      // never read as content and never written — not even by a reset.
      blocked(look.reason);
      continue;
    }
    const pack = readFileGuarded(source, ASSET_FILE_MAX_BYTES);
    if (!pack.ok) {
      if (!pack.absent) {
        blocked(`its pack file could not be used: ${pack.reason}`);
      }
      continue; // pack file vanished between scan and sync
    }
    const sourceHash = sha256(pack.bytes);
    if (look.state === 'file' && look.hash === sourceHash) {
      record.files[rel] = sourceHash;
      continue;
    }
    // Safe to write only onto nothing or onto our own unmodified copy.
    const safe = look.state === 'absent' || look.hash === record.files[rel];
    if (!safe && !force && !forceFiles.has(`${asset.key}\0${rel}`)) {
      report.customized.push(rel);
      continue;
    }
    // A hook script takes the pack file's permission bits: one that lands without `+x`
    // never runs. Any other file keeps the bits of the copy it replaces, when there is one.
    const mode = asset.type === 'hook' ? pack.mode : look.state === 'file' ? look.mode : undefined;
    const failed = installFile(workspaceRoot, target, pack.bytes, mode);
    if (failed !== undefined) {
      blocked(failed);
      continue;
    }
    record.files[rel] = sourceHash;
    wrote = true;
  }
  // Files we installed earlier that the pack no longer ships.
  for (const rel of Object.keys(record.files)) {
    if (!(rel in asset.files)) {
      removeFileIfOwned(workspaceRoot, asset.key, record, rel, report);
    }
  }
  if (wrote) {
    (firstInstall ? report.installed : report.updated).push(asset.key);
  }
}

/**
 * Delete an installed file only while it still matches the recorded hash. What is at the path
 * and is not a file sync can read whole (lookAtInstallPath) is not a file sync installed: it
 * is reported and left, with its record — so is a file that could not be removed.
 */
function removeFileIfOwned(
  workspaceRoot: string,
  key: string,
  record: AssetRecord,
  rel: string,
  report: SyncReport,
): void {
  if (!isSafeRel(rel)) {
    // A traversal rel can only come from a tampered/corrupt ledger — drop
    // the record without touching the disk.
    delete record.files[rel];
    return;
  }
  const target = targetPath(workspaceRoot, rel);
  const look = lookAtInstallPath(workspaceRoot, target);
  if (look.state === 'blocked') {
    report.blocked.push({ asset: key, rel, reason: look.reason });
    return;
  }
  if (look.state === 'file' && look.hash !== record.files[rel]) {
    report.customized.push(rel);
    return;
  }
  try {
    if (look.state === 'file') {
      // The name is removed, whatever holds it by now: an unlink follows no link.
      fs.unlinkSync(target);
      pruneEmptyDirs(path.dirname(target), path.join(workspaceRoot, '.claude'));
      report.removed.push(rel);
    }
    delete record.files[rel];
  } catch (e) {
    // The record stays, so a later sync tries the removal again.
    report.blocked.push({ asset: key, rel, reason: `the file could not be removed${errnoSuffix(e)}` });
  }
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  while (dir.startsWith(stopAt + path.sep)) {
    try {
      if (fs.readdirSync(dir).length > 0) {
        return;
      }
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
