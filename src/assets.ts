import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Asset-pack engine: deploys Claude Code assets (skills, agents, commands,
 * output styles) from asset packs into a workspace's `.claude/` directory.
 * Packs are plain directories mirroring the `.claude/` layout — the
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
 * This module must not import 'vscode' (kept UI-free like registry.ts).
 */

export type AssetType = 'skill' | 'agent' | 'command' | 'output-style';

/** Pack subdirectory per asset type — identical to the `.claude/` layout. */
export const ASSET_TYPE_DIRS: Record<AssetType, string> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  'output-style': 'output-styles',
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

function tryHashFile(file: string): string | undefined {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return undefined;
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
    const text = fs.readFileSync(file, 'utf8');
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
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8')) as { name?: string };
    if (typeof meta?.name === 'string' && meta.name.trim()) {
      name = meta.name.trim();
    }
  } catch {
    // pack.json is optional
  }
  const assets: PackAsset[] = [];
  for (const [type, dir] of Object.entries(ASSET_TYPE_DIRS) as [AssetType, string][]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (type === 'skill') {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillRoot = path.join(root, dir, entry.name);
        const files: Record<string, string> = {};
        for (const rel of walkFiles(skillRoot)) {
          files[`${dir}/${entry.name}/${rel}`] = path.join(skillRoot, ...rel.split('/'));
        }
        if (!files[`${dir}/${entry.name}/SKILL.md`]) {
          continue;
        }
        assets.push({
          key: `${name}:${dir}/${entry.name}`,
          pack: name,
          type,
          id: entry.name,
          description: readDescription(path.join(skillRoot, 'SKILL.md')),
          files,
        });
      } else {
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }
        const id = entry.name.replace(/\.md$/, '');
        const source = path.join(root, dir, entry.name);
        assets.push({
          key: `${name}:${dir}/${id}`,
          pack: name,
          type,
          id,
          description: readDescription(source),
          files: { [`${dir}/${entry.name}`]: source },
        });
      }
    }
  }
  return { name, root, assets };
}

export function assetStateFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'cco-assets.json');
}

export function readAssetState(workspaceRoot: string): AssetState {
  const file = assetStateFile(workspaceRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { version: 1, assets: {} }; // no ledger yet — fresh workspace
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AssetState>;
    return { version: 1, assets: parsed.assets ?? {} };
  } catch {
    // Unparseable ledger: move it aside instead of letting the next write
    // silently persist an empty one over it. Installed files degrade to
    // 'customized' (protected), and the backup allows manual recovery.
    try {
      fs.renameSync(file, file + '.corrupt');
    } catch {
      // best effort — worst case we behave like the old silent-empty path
    }
    return { version: 1, assets: {} };
  }
}

export function writeAssetState(workspaceRoot: string, state: AssetState): void {
  const file = assetStateFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replace — a crash mid-write must never leave a half ledger.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function setAssetEnabled(workspaceRoot: string, key: string, enabled: boolean): void {
  const state = readAssetState(workspaceRoot);
  const record = state.assets[key] ?? { enabled: false, files: {} };
  record.enabled = enabled;
  state.assets[key] = record;
  writeAssetState(workspaceRoot, state);
}

function targetPath(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, '.claude', ...rel.split('/'));
}

export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Scaffolds are skeletons, not drafts: every slot is present but empty, and
 * the guidance lives in comments so nothing reads as authored content.
 * Inside the frontmatter fences only `#` comments are legal (an HTML comment
 * there is a YAML parse error); the body uses `<!-- -->`.
 *
 * `description:` must stay the LAST line of the frontmatter — readDescription's
 * `/^description:\s*(.+)$/m` lets `\s*` cross the newline, so any line after it
 * would be captured as the description.
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
---

<!-- Instructions Claude follows once this skill triggers. -->
<!-- Keep it procedural: numbered steps, hard constraints, a worked example. -->
<!-- Delete these comments as you fill the body in. -->
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
# An optional 'argument-hint:' key documents the arguments shown in the command menu.
# description: one line, third person, stating what this command does.
description:
---

<!-- The prompt sent to Claude when this command runs. -->
<!-- $ARGUMENTS is replaced with whatever the user typed after the command name. -->
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
};

/**
 * Scaffold a new asset in a pack directory and return the absolute path of
 * its primary file. Throws when the id is invalid or the asset already exists.
 */
export function createAssetTemplate(packRoot: string, type: AssetType, id: string): string {
  if (!ASSET_ID_PATTERN.test(id)) {
    throw new Error(`Invalid asset id "${id}" — use letters, digits, ".", "-" or "_".`);
  }
  const dir = ASSET_TYPE_DIRS[type];
  const file =
    type === 'skill' ? path.join(packRoot, dir, id, 'SKILL.md') : path.join(packRoot, dir, `${id}.md`);
  if (fs.existsSync(type === 'skill' ? path.dirname(file) : file)) {
    throw new Error(`Asset "${id}" already exists in ${path.join(packRoot, dir)}.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ASSET_TEMPLATES[type](id));
  return file;
}

/** Sync relationship of one installed file to its pack source. */
export type FileSyncState =
  | 'in-sync' // disk matches the pack
  | 'writable' // missing or untouched since install — sync may write it
  | 'customized' // edited by hand (or pre-existing) — sync never writes it
  | 'missing-source'; // pack file unreadable — not the workspace's problem

function fileSyncState(source: string, target: string, recordedHash: string | undefined): FileSyncState {
  const sourceHash = tryHashFile(source);
  if (sourceHash === undefined) {
    return 'missing-source';
  }
  const diskHash = tryHashFile(target);
  if (diskHash === sourceHash) {
    return 'in-sync';
  }
  if (diskHash === undefined || diskHash === recordedHash) {
    return 'writable';
  }
  return 'customized';
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
      state: fileSyncState(source, target, record?.files[rel]),
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
    const fileState = fileSyncState(source, targetPath(workspaceRoot, rel), record.files[rel]);
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
        removeFileIfOwned(workspaceRoot, record, rel, report);
      }
      if (Object.keys(record.files).length === 0) {
        delete state.assets[key];
      }
      continue;
    }
    syncAsset(asset!, record, workspaceRoot, owners, force.has(key), forceFiles, report);
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
    let content: Buffer;
    try {
      content = fs.readFileSync(source);
    } catch {
      continue; // pack file vanished between scan and sync
    }
    const sourceHash = sha256(content);
    const target = targetPath(workspaceRoot, rel);
    const diskHash = tryHashFile(target);
    if (diskHash === sourceHash) {
      record.files[rel] = sourceHash;
      continue;
    }
    // Safe to write only onto nothing or onto our own unmodified copy.
    const safe = diskHash === undefined || diskHash === record.files[rel];
    if (!safe && !force && !forceFiles.has(`${asset.key}\0${rel}`)) {
      report.customized.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    record.files[rel] = sourceHash;
    wrote = true;
  }
  // Files we installed earlier that the pack no longer ships.
  for (const rel of Object.keys(record.files)) {
    if (!(rel in asset.files)) {
      removeFileIfOwned(workspaceRoot, record, rel, report);
    }
  }
  if (wrote) {
    (firstInstall ? report.installed : report.updated).push(asset.key);
  }
}

/** Delete an installed file only while it still matches the recorded hash. */
function removeFileIfOwned(
  workspaceRoot: string,
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
  const diskHash = tryHashFile(target);
  if (diskHash !== undefined && diskHash !== record.files[rel]) {
    report.customized.push(rel);
    return;
  }
  try {
    if (diskHash !== undefined) {
      fs.rmSync(target);
      pruneEmptyDirs(path.dirname(target), path.join(workspaceRoot, '.claude'));
      report.removed.push(rel);
    }
    delete record.files[rel];
  } catch {
    // leave the record so a later sync retries the removal
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
