import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AssetPack, loadPack } from './assets';
import { userSetting } from './settings';

/**
 * Resolution of the configured asset-pack sources: the extension's bundled
 * `assets/` directory plus each entry of the assetPacks setting (a directory
 * path, '~' allowed — e.g. a private asset-repo clone).
 */
export interface PackSource {
  /** Raw setting entry, or 'bundled' for the built-in pack. */
  entry: string;
  /** Resolved absolute directory. */
  root: string;
  kind: 'bundled' | 'setting';
  /** Loaded pack — undefined when the directory doesn't exist. */
  pack?: AssetPack;
}

export function resolvePackSources(context: vscode.ExtensionContext): PackSource[] {
  const bundledRoot = context.asAbsolutePath('assets');
  const sources: PackSource[] = [
    { entry: 'bundled', root: bundledRoot, kind: 'bundled', pack: loadPack(bundledRoot, 'bundled') },
  ];
  // The USER's list only: a pack directory is one the host copies files out of, and a
  // workspace must not be able to add one.
  for (const entry of userSetting('assetPacks')) {
    const root = entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry;
    sources.push({ entry, root, kind: 'setting', pack: loadPack(root) });
  }
  return sources;
}

export function loadedPacks(context: vscode.ExtensionContext): AssetPack[] {
  return resolvePackSources(context)
    .map((source) => source.pack)
    .filter((pack): pack is AssetPack => Boolean(pack));
}
