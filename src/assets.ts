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

export type AssetStatus = 'not-installed' | 'synced' | 'update-available' | 'customized';

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
}

export function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
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
    const match = frontmatter && /^description:\s*(.+)$/m.exec(frontmatter[1]);
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
  try {
    const raw = JSON.parse(fs.readFileSync(assetStateFile(workspaceRoot), 'utf8')) as Partial<AssetState>;
    return { version: 1, assets: raw.assets ?? {} };
  } catch {
    return { version: 1, assets: {} };
  }
}

export function writeAssetState(workspaceRoot: string, state: AssetState): void {
  const file = assetStateFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
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

/** Status of one asset in a workspace, for pickers and views. */
export function assetStatus(asset: PackAsset, state: AssetState, workspaceRoot: string): AssetStatus {
  const record = state.assets[asset.key];
  if (!record?.enabled) {
    return 'not-installed';
  }
  let update = false;
  let customized = false;
  for (const [rel, source] of Object.entries(asset.files)) {
    const sourceHash = tryHashFile(source);
    const diskHash = tryHashFile(targetPath(workspaceRoot, rel));
    if (sourceHash === undefined || diskHash === sourceHash) {
      continue; // unreadable pack file is not the workspace's problem; equal = in sync
    }
    if (diskHash === undefined || diskHash === record.files[rel]) {
      update = true; // missing or untouched since install — sync may write it
    } else {
      customized = true;
    }
  }
  return customized ? 'customized' : update ? 'update-available' : 'synced';
}

/**
 * Reconcile every recorded asset in the workspace with the given packs.
 * Pass keys in `force` to overwrite customized files of those assets with the
 * pack version (explicit reset).
 */
export function syncWorkspace(
  packs: AssetPack[],
  workspaceRoot: string,
  force: Set<string> = new Set(),
): SyncReport {
  const state = readAssetState(workspaceRoot);
  const report: SyncReport = { installed: [], updated: [], removed: [], customized: [], orphaned: [] };
  const byKey = new Map<string, PackAsset>();
  for (const pack of packs) {
    for (const asset of pack.assets) {
      if (!byKey.has(asset.key)) {
        byKey.set(asset.key, asset);
      }
    }
  }
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
        removeFileIfOwned(workspaceRoot, record, rel, report);
      }
      if (Object.keys(record.files).length === 0) {
        delete state.assets[key];
      }
      continue;
    }
    syncAsset(asset!, record, workspaceRoot, force.has(key), report);
  }
  writeAssetState(workspaceRoot, state);
  return report;
}

function syncAsset(
  asset: PackAsset,
  record: AssetRecord,
  workspaceRoot: string,
  force: boolean,
  report: SyncReport,
): void {
  const firstInstall = Object.keys(record.files).length === 0;
  let wrote = false;
  for (const [rel, source] of Object.entries(asset.files)) {
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
    if (!safe && !force) {
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
