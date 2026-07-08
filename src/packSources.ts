import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AssetPack, loadPack } from './assets';

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
  const entries = vscode.workspace
    .getConfiguration('claudeCodeOrchestrator')
    .get<string[]>('assetPacks', []);
  for (const entry of entries) {
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
