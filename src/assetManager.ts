import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AssetType,
  assetFiles,
  assetStatus,
  createAssetTemplate,
  orphanedAssets,
  PackAsset,
  readAssetState,
  relOwners,
  setAssetEnabled,
  syncWorkspace,
} from './assets';
import { PackSource, resolvePackSources } from './packSources';
import { describeSyncReport } from './syncReport';
import { jsonForScript } from './webviewUtil';

/**
 * Asset Manager — a dedicated webview panel for managing which Claude assets
 * (skills, agents, commands, output styles) are installed in the current
 * workspace's .claude/. Shows pack sources, per-asset sync status, per-file
 * detail with diff for customized copies, and pack-source administration.
 * Follows the dashboard's conventions: 2s data push, theme-var styling.
 */

const ASSET_TYPES: AssetType[] = ['skill', 'agent', 'command', 'output-style', 'hook'];

let panel: vscode.WebviewPanel | undefined;
let lastReport: string | null = null;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Assets across packs, first pack wins on key collisions (mirrors sync). */
function collectAssets(sources: PackSource[]): PackAsset[] {
  const byKey = new Map<string, PackAsset>();
  for (const source of sources) {
    for (const asset of source.pack?.assets ?? []) {
      if (!byKey.has(asset.key)) {
        byKey.set(asset.key, asset);
      }
    }
  }
  return [...byKey.values()];
}

/** Installed path for a rel, refusing anything that escapes .claude/. */
function safeInstalledPath(ws: string, rel: string): string | undefined {
  const base = path.join(ws, '.claude');
  const target = path.resolve(base, ...rel.split('/'));
  return target.startsWith(base + path.sep) ? target : undefined;
}

function noteReport(prefix: string, summary: string): void {
  lastReport = `${new Date().toLocaleTimeString()} · ${prefix}: ${summary}`;
}

export function openAssetManager(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('ccoAssetManager', vscode.l10n.t('Claude Assets'), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = assetManagerHtml(assetManagerStrings());

  const cfg = () => vscode.workspace.getConfiguration('claudeCodeOrchestrator');

  const send = () => {
    if (!panel) {
      return;
    }
    const ws = workspaceRoot();
    const sources = resolvePackSources(context);
    const packs = sources.flatMap((s) => (s.pack ? [s.pack] : []));
    const assets = collectAssets(sources);
    const state = ws ? readAssetState(ws) : { version: 1 as const, assets: {} };
    const owners = relOwners(assets, state);
    void panel.webview.postMessage({
      type: 'data',
      workspace: ws ?? null,
      autoSync: cfg().get<boolean>('assetAutoSync', true),
      lastReport,
      sources: sources.map((s) => ({
        entry: s.entry,
        root: s.root,
        kind: s.kind,
        ok: Boolean(s.pack),
        name: s.pack?.name ?? null,
        assetCount: s.pack?.assets.length ?? 0,
      })),
      assets: ws
        ? assets.map((asset) => ({
            key: asset.key,
            pack: asset.pack,
            type: asset.type,
            id: asset.id,
            description: asset.description ?? null,
            enabled: state.assets[asset.key]?.enabled === true,
            status: assetStatus(asset, state, ws, owners),
            conflictWith:
              Object.keys(asset.files)
                .map((rel) => owners.get(rel))
                .find((owner) => owner && owner !== asset.key) ?? null,
            files: assetFiles(asset, state, ws).map((f) => ({
              rel: f.rel,
              state: f.state,
              installed: f.installed,
            })),
          }))
        : [],
      orphans: ws ? orphanedAssets(packs, ws) : [],
    });
  };

  // Poll only while visible — every tick re-hashes pack + installed files,
  // which must not run all day for a backgrounded tab.
  const timer = setInterval(() => {
    if (panel?.visible) {
      send();
    }
  }, 2000);
  panel.onDidChangeViewState(() => {
    if (panel?.visible) {
      send();
    }
  });
  panel.onDidDispose(() => {
    clearInterval(timer);
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; [k: string]: unknown }) => {
    const ws = workspaceRoot();
    const sources = () => resolvePackSources(context);
    const packs = () => sources().flatMap((s) => (s.pack ? [s.pack] : []));
    const key = typeof msg.key === 'string' ? msg.key : '';
    const rel = typeof msg.rel === 'string' ? msg.rel : '';
    try {
      switch (msg.type) {
        case 'refresh':
          break;
        case 'toggle': {
          if (!ws || !key) {
            break;
          }
          setAssetEnabled(ws, key, msg.enabled === true);
          noteReport(
            msg.enabled === true ? vscode.l10n.t('enabled') : vscode.l10n.t('disabled'),
            describeSyncReport(syncWorkspace(packs(), ws)),
          );
          break;
        }
        case 'syncNow': {
          if (!ws) {
            break;
          }
          noteReport(vscode.l10n.t('sync'), describeSyncReport(syncWorkspace(packs(), ws)));
          break;
        }
        case 'reset': {
          if (!ws || !key) {
            break;
          }
          const asset = collectAssets(sources()).find((a) => a.key === key);
          const customized = asset
            ? assetFiles(asset, readAssetState(ws), ws)
                .filter((f) => f.state === 'customized')
                .map((f) => f.rel)
            : [];
          const overwriteLabel = vscode.l10n.t('Overwrite');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('Overwrite your local edits of "{0}" with the pack version? This cannot be undone.', key),
            {
              modal: true,
              detail: customized.length
                ? vscode.l10n.t('Files to overwrite:\n{0}', customized.join('\n'))
                : undefined,
            },
            overwriteLabel,
          );
          if (choice === overwriteLabel) {
            noteReport(vscode.l10n.t('reset'), describeSyncReport(syncWorkspace(packs(), ws, new Set([key]))));
          }
          break;
        }
        case 'resetFile': {
          if (!ws || !key || !rel) {
            break;
          }
          const overwriteLabel = vscode.l10n.t('Overwrite');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('Overwrite your local edits of "{0}" with the pack version? This cannot be undone.', rel),
            { modal: true },
            overwriteLabel,
          );
          if (choice === overwriteLabel) {
            noteReport(
              vscode.l10n.t('reset file'),
              describeSyncReport(syncWorkspace(packs(), ws, new Set(), new Set([`${key}\0${rel}`]))),
            );
          }
          break;
        }
        case 'disableOrphan': {
          if (!ws || !key) {
            break;
          }
          const record = readAssetState(ws).assets[key];
          const count = record ? Object.keys(record.files).length : 0;
          const disableCleanLabel = vscode.l10n.t('Disable & clean');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Disable "{0}" and delete its {1} unmodified installed file(s)? Files you edited are kept. If the pack is only missing on this machine, re-add its directory instead — nothing is lost by waiting.',
              key,
              count,
            ),
            { modal: true },
            disableCleanLabel,
          );
          if (choice !== disableCleanLabel) {
            break;
          }
          setAssetEnabled(ws, key, false);
          noteReport(vscode.l10n.t('cleaned orphan'), describeSyncReport(syncWorkspace(packs(), ws)));
          break;
        }
        case 'openInstalled': {
          const target = ws && rel ? safeInstalledPath(ws, rel) : undefined;
          if (target && fs.existsSync(target)) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
              preview: true,
            });
          }
          break;
        }
        case 'openSource':
        case 'diff': {
          const asset = collectAssets(sources()).find((a) => a.key === key);
          const source = asset?.files[rel];
          if (!asset || !source) {
            break;
          }
          if (msg.type === 'openSource') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), {
              preview: true,
            });
            break;
          }
          const target = ws ? safeInstalledPath(ws, rel) : undefined;
          if (target && fs.existsSync(target)) {
            await vscode.commands.executeCommand(
              'vscode.diff',
              vscode.Uri.file(source),
              vscode.Uri.file(target),
              vscode.l10n.t('{0} — pack ↔ installed', rel),
            );
          }
          break;
        }
        case 'addPack': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: vscode.l10n.t('Use as asset pack'),
            title: vscode.l10n.t('Select an asset-pack directory (mirrors .claude/ layout)'),
          });
          const dir = picked?.[0]?.fsPath;
          if (dir) {
            const current = cfg().get<string[]>('assetPacks', []);
            if (!current.includes(dir)) {
              await cfg().update('assetPacks', [...current, dir], vscode.ConfigurationTarget.Global);
            }
          }
          break;
        }
        case 'removePack': {
          const entry = typeof msg.entry === 'string' ? msg.entry : '';
          const current = cfg().get<string[]>('assetPacks', []);
          if (entry && current.includes(entry)) {
            await cfg().update(
              'assetPacks',
              current.filter((e) => e !== entry),
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
        case 'revealPack': {
          const root = typeof msg.root === 'string' ? msg.root : '';
          if (root && sources().some((s) => s.root === root)) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
          }
          break;
        }
        case 'setAutoSync': {
          await cfg().update('assetAutoSync', msg.value === true, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'newAsset': {
          await createNewAsset(sources());
          break;
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    send();
  });

  send();
}

/**
 * Guided creation of a new asset in a writable (setting) pack. The bundled
 * pack is excluded — it lives in the extension install directory and is
 * replaced on every extension update.
 */
async function createNewAsset(sources: PackSource[]): Promise<void> {
  const writable = sources.filter((s) => s.kind === 'setting' && s.pack);
  if (writable.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'No writable asset pack configured. Add a pack directory first (e.g. your private claude-assets clone) — the bundled pack cannot be edited because it is replaced on every extension update.',
      ),
    );
    return;
  }
  const packPick =
    writable.length === 1
      ? { source: writable[0] }
      : await vscode.window.showQuickPick(
          writable.map((source) => ({ label: source.pack!.name, description: source.root, source })),
          { placeHolder: vscode.l10n.t('Pack to create the asset in') },
        );
  if (!packPick) {
    return;
  }
  const typePick = await vscode.window.showQuickPick(
    ASSET_TYPES.map((t) => ({ label: t })),
    { placeHolder: vscode.l10n.t('Asset type') },
  );
  if (!typePick) {
    return;
  }
  const id = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Name for the new {0} (letters, digits, ".", "-", "_")', typePick.label),
    validateInput: (v) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim()) ? undefined : vscode.l10n.t('Invalid name'),
  });
  if (!id) {
    return;
  }
  const file = createAssetTemplate(packPick.source.root, typePick.label as AssetType, id.trim());
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

export interface AssetManagerStrings {
  title: string;
  btnSyncNow: string;
  btnNewAsset: string;
  btnAddPack: string;
  autoSyncLabel: string;
  filterPlaceholder: string;
  sourcesTitle: string;
  assetsTitle: string;
  thOnTip: string;
  thOn: string;
  thAsset: string;
  thPack: string;
  thType: string;
  thStatus: string;
  thActions: string;
  orphansTitle: string;
  orphansHelp: string;
  metaWorkspace: string;
  metaNoWorkspace: string;
  statusSynced: string;
  statusUpdateAvailable: string;
  statusCustomized: string;
  statusNotInstalled: string;
  statusConflict: string;
  fileUpdatePending: string;
  fileCustomized: string;
  fileSourceUnreadable: string;
  sourceAssetCount: string;
  dirMissing: string;
  actionRemove: string;
  actionReveal: string;
  bundledLabel: string;
  orphanFilesKept: string;
  actionDisableClean: string;
  summaryEnabled: string;
  summaryUpdate: string;
  summaryCustomized: string;
  summaryConflict: string;
  actionOpen: string;
  actionPackVersion: string;
  actionDiff: string;
  actionResetFile: string;
  detailsFiles: string;
  actionResetToPack: string;
  conflictNote: string;
  toggleTip: string;
  emptyFilter: string;
  emptyNoAssets: string;
  emptyNoWorkspace: string;
}

/** Localized strings for the page. Must be called from the extension host. */
export function assetManagerStrings(): AssetManagerStrings {
  return {
    title: vscode.l10n.t('Claude Assets'),
    btnSyncNow: vscode.l10n.t('Sync now'),
    btnNewAsset: vscode.l10n.t('New asset…'),
    btnAddPack: vscode.l10n.t('Add pack directory…'),
    autoSyncLabel: vscode.l10n.t('auto-sync on startup'),
    filterPlaceholder: vscode.l10n.t('filter assets…'),
    sourcesTitle: vscode.l10n.t('Pack sources'),
    assetsTitle: vscode.l10n.t('Assets in this workspace'),
    thOnTip: vscode.l10n.t("checked = installed into this workspace's .claude/"),
    thOn: vscode.l10n.t('on'),
    thAsset: vscode.l10n.t('asset'),
    thPack: vscode.l10n.t('pack'),
    thType: vscode.l10n.t('type'),
    thStatus: vscode.l10n.t('status'),
    thActions: vscode.l10n.t('actions'),
    orphansTitle: vscode.l10n.t('Orphaned assets (enabled here, but their pack is unavailable)'),
    orphansHelp: vscode.l10n.t(
      'Most often the pack just isn\'t on this machine yet (e.g. a private asset repo that isn\'t cloned here). Re-adding its directory restores these rows — installed files stay untouched meanwhile. "Disable & clean" removes the unmodified installed files after a confirmation.',
    ),
    metaWorkspace: vscode.l10n.t('workspace: {0}'),
    metaNoWorkspace: vscode.l10n.t('no workspace open — open a folder to manage its assets'),
    statusSynced: vscode.l10n.t('synced'),
    statusUpdateAvailable: vscode.l10n.t('update available'),
    statusCustomized: vscode.l10n.t('customized'),
    statusNotInstalled: vscode.l10n.t('not installed'),
    statusConflict: vscode.l10n.t('conflict'),
    fileUpdatePending: vscode.l10n.t('update pending'),
    fileCustomized: vscode.l10n.t('customized'),
    fileSourceUnreadable: vscode.l10n.t('source unreadable'),
    sourceAssetCount: vscode.l10n.t('{0} asset(s)'),
    dirMissing: vscode.l10n.t('directory missing'),
    actionRemove: vscode.l10n.t('remove'),
    actionReveal: vscode.l10n.t('reveal'),
    bundledLabel: vscode.l10n.t('bundled with the extension'),
    orphanFilesKept: vscode.l10n.t('{0} installed file(s) kept'),
    actionDisableClean: vscode.l10n.t('disable & clean'),
    summaryEnabled: vscode.l10n.t('{0} enabled of {1}'),
    summaryUpdate: vscode.l10n.t('{0} update available'),
    summaryCustomized: vscode.l10n.t('{0} customized'),
    summaryConflict: vscode.l10n.t('{0} conflict'),
    actionOpen: vscode.l10n.t('open'),
    actionPackVersion: vscode.l10n.t('pack version'),
    actionDiff: vscode.l10n.t('diff'),
    actionResetFile: vscode.l10n.t('reset'),
    detailsFiles: vscode.l10n.t('{0} file(s)'),
    actionResetToPack: vscode.l10n.t('reset to pack'),
    conflictNote: vscode.l10n.t('same install path as {0} — disable one of the two'),
    toggleTip: vscode.l10n.t('install into this workspace'),
    emptyFilter: vscode.l10n.t('no assets match the filter'),
    emptyNoAssets: vscode.l10n.t('no assets found — add a pack directory or create one with “New asset…”'),
    emptyNoWorkspace: vscode.l10n.t('open a workspace folder first'),
  };
}

/** HTML-escape for static-body interpolation (localized strings are untrusted). */
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]);

/** Pure: same strings in, same HTML out. Exported for headless rendering tests. */
export function assetManagerHtml(s: AssetManagerStrings): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --c-muted: var(--vscode-descriptionForeground);
    --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --border: var(--vscode-panel-border, #4444);
    --ok: var(--vscode-charts-green, #89d185);
    --warn: var(--vscode-editorWarning-foreground, #cca700);
    --err: var(--vscode-charts-red, #f14c4c);
    --info: var(--vscode-charts-blue, #3794ff);
  }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 18px 40px; }
  h1 { font-size: 1.15em; margin: 0 0 2px; }
  #meta { color: var(--c-muted); font-size: 0.88em; margin: 0 0 14px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; }
  .card h2 { font-size: 0.82em; font-weight: 600; color: var(--c-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 8px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
  .toolbar .spacer { flex: 1; }
  button { background: var(--vscode-button-secondaryBackground, var(--card-bg)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--border); border-radius: 3px; padding: 4px 10px; cursor: pointer; font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--border)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; padding: 4px 6px; font-family: inherit; min-width: 200px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  th { color: var(--c-muted); font-weight: 600; white-space: nowrap; }
  .muted { color: var(--c-muted); }
  .badge { border: 1px solid var(--border); border-radius: 8px; padding: 0 7px; font-size: 0.82em; white-space: nowrap; }
  .badge.synced { color: var(--ok); border-color: var(--ok); }
  .badge.update { color: var(--info); border-color: var(--info); }
  .badge.customized { color: var(--warn); border-color: var(--warn); }
  .badge.off { color: var(--c-muted); }
  .badge.orphan { color: var(--err); border-color: var(--err); }
  .type { font-size: 0.8em; color: var(--c-muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
  .asset-name { font-weight: 600; }
  .desc { color: var(--c-muted); font-size: 0.85em; margin-top: 1px; max-width: 60ch; }
  a.action { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; margin-right: 8px; white-space: nowrap; }
  a.action:hover { text-decoration: underline; }
  details { margin-top: 3px; }
  summary { cursor: pointer; color: var(--c-muted); font-size: 0.85em; }
  .file-row { font-size: 0.85em; margin: 2px 0 0 14px; display: flex; gap: 8px; align-items: baseline; }
  .file-state { font-size: 0.9em; }
  .file-state.customized { color: var(--warn); }
  .file-state.writable { color: var(--info); }
  .src-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
  .empty { color: var(--c-muted); padding: 14px 0; text-align: center; }
  label.inline { color: var(--c-muted); font-size: 0.85em; display: inline-flex; gap: 5px; align-items: center; }
  input[type=checkbox] { accent-color: var(--vscode-button-background); }
</style>
</head>
<body>
  <h1>${escHtml(s.title)}</h1>
  <p id="meta"></p>

  <div class="toolbar">
    <button class="primary" data-act="syncNow">${escHtml(s.btnSyncNow)}</button>
    <button data-act="newAsset">${escHtml(s.btnNewAsset)}</button>
    <button data-act="addPack">${escHtml(s.btnAddPack)}</button>
    <label class="inline"><input type="checkbox" id="autosync"> ${escHtml(s.autoSyncLabel)}</label>
    <span class="spacer"></span>
    <input type="text" id="filter" placeholder="${escHtml(s.filterPlaceholder)}" spellcheck="false">
  </div>

  <div class="card">
    <h2>${escHtml(s.sourcesTitle)}</h2>
    <div id="sources"></div>
  </div>

  <div class="card">
    <h2>${escHtml(s.assetsTitle)}<span id="summary" style="font-weight:400;text-transform:none;letter-spacing:0"></span></h2>
    <table id="assets"><thead><tr>
      <th title="${escHtml(s.thOnTip)}">${escHtml(s.thOn)}</th><th>${escHtml(s.thAsset)}</th><th>${escHtml(s.thPack)}</th><th>${escHtml(s.thType)}</th><th>${escHtml(s.thStatus)}</th><th>${escHtml(s.thActions)}</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="card" id="orphans-card" style="display:none">
    <h2>${escHtml(s.orphansTitle)}</h2>
    <p class="muted" style="font-size:0.85em;margin:0 0 6px">
      ${escHtml(s.orphansHelp)}
    </p>
    <div id="orphans"></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const S = ${jsonForScript(s)};
  const fmt = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);
  let data = null;
  let lastSig = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const post = (m) => vscode.postMessage(m);

  window.addEventListener('message', (e) => {
    if (e.data.type !== 'data') return;
    const sig = JSON.stringify(e.data);
    if (sig === lastSig) return;
    lastSig = sig;
    data = e.data;
    render();
  });

  for (const b of document.querySelectorAll('button[data-act]')) {
    b.addEventListener('click', () => post({ type: b.dataset.act }));
  }
  document.getElementById('autosync').addEventListener('change', (e) => post({ type: 'setAutoSync', value: e.target.checked }));
  document.getElementById('filter').addEventListener('input', renderAssets);

  const STATUS_BADGE = {
    'synced': ['synced', S.statusSynced],
    'update-available': ['update', S.statusUpdateAvailable],
    'customized': ['customized', S.statusCustomized],
    'not-installed': ['off', S.statusNotInstalled],
    'conflict': ['orphan', S.statusConflict],
  };
  const FILE_STATE_LABEL = { 'in-sync': '', 'writable': S.fileUpdatePending, 'customized': S.fileCustomized, 'missing-source': S.fileSourceUnreadable };

  function render() {
    if (!data) return;
    document.getElementById('meta').textContent =
      (data.workspace ? fmt(S.metaWorkspace, data.workspace) : S.metaNoWorkspace) +
      (data.lastReport ? '   |   ' + data.lastReport : '');
    document.getElementById('autosync').checked = data.autoSync;

    document.getElementById('sources').innerHTML = data.sources.map((s) => {
      const status = s.ok
        ? '<span class="badge synced">' + esc(fmt(S.sourceAssetCount, s.assetCount)) + '</span>'
        : '<span class="badge orphan">' + esc(S.dirMissing) + '</span>';
      const remove = s.kind === 'setting'
        ? '<a class="action" data-remove="' + esc(s.entry) + '">' + esc(S.actionRemove) + '</a>' : '';
      const reveal = s.ok ? '<a class="action" data-reveal="' + esc(s.root) + '">' + esc(S.actionReveal) + '</a>' : '';
      return '<div class="file-row" style="margin-left:0">' +
        '<b>' + esc(s.name ?? s.entry) + '</b>' +
        '<span class="src-path muted">' + esc(s.kind === 'bundled' ? S.bundledLabel : s.root) + '</span>' +
        status + reveal + remove + '</div>';
    }).join('');
    for (const a of document.querySelectorAll('[data-remove]')) a.onclick = () => post({ type: 'removePack', entry: a.dataset.remove });
    for (const a of document.querySelectorAll('[data-reveal]')) a.onclick = () => post({ type: 'revealPack', root: a.dataset.reveal });

    renderAssets();

    const orphansCard = document.getElementById('orphans-card');
    if (data.orphans.length) {
      orphansCard.style.display = '';
      document.getElementById('orphans').innerHTML = data.orphans.map((o) =>
        '<div class="file-row" style="margin-left:0"><b>' + esc(o.key) + '</b>' +
        '<span class="muted">' + esc(fmt(S.orphanFilesKept, o.files.length)) + '</span>' +
        '<a class="action" data-orphan="' + esc(o.key) + '">' + esc(S.actionDisableClean) + '</a></div>'
      ).join('');
      for (const a of document.querySelectorAll('[data-orphan]')) a.onclick = () => post({ type: 'disableOrphan', key: a.dataset.orphan });
    } else {
      orphansCard.style.display = 'none';
    }
  }

  function renderAssets() {
    if (!data) return;
    const counts = { enabled: 0, update: 0, customized: 0, conflict: 0 };
    for (const a of data.assets) {
      if (a.enabled) counts.enabled++;
      if (a.status === 'update-available') counts.update++;
      if (a.status === 'customized') counts.customized++;
      if (a.status === 'conflict') counts.conflict++;
    }
    document.getElementById('summary').textContent = counts.enabled || data.assets.length
      ? ' — ' + fmt(S.summaryEnabled, counts.enabled, data.assets.length) +
        (counts.update ? ' · ' + fmt(S.summaryUpdate, counts.update) : '') +
        (counts.customized ? ' · ' + fmt(S.summaryCustomized, counts.customized) : '') +
        (counts.conflict ? ' · ' + fmt(S.summaryConflict, counts.conflict) : '')
      : '';

    const openKeys = new Set([...document.querySelectorAll('#assets details[open]')].map((d) => d.dataset.key));
    const q = document.getElementById('filter').value.trim().toLowerCase();
    const rows = data.assets.filter((a) =>
      !q || (a.id + ' ' + a.pack + ' ' + a.type + ' ' + (a.description || '') + ' ' + a.status + ' ' +
        (STATUS_BADGE[a.status] || ['', ''])[1] + (a.enabled ? ' enabled installed' : ' disabled')).toLowerCase().includes(q));
    document.querySelector('#assets tbody').innerHTML = rows.map((a) => {
      const [cls, label] = STATUS_BADGE[a.status] || ['off', a.status];
      const files = a.files.map((f) => {
        const state = FILE_STATE_LABEL[f.state] || '';
        const links =
          (f.installed ? '<a class="action" data-open="' + esc(f.rel) + '">' + esc(S.actionOpen) + '</a>' : '') +
          '<a class="action" data-src="' + esc(a.key) + '|' + esc(f.rel) + '">' + esc(S.actionPackVersion) + '</a>' +
          (f.installed && f.state !== 'in-sync' ? '<a class="action" data-diff="' + esc(a.key) + '|' + esc(f.rel) + '">' + esc(S.actionDiff) + '</a>' : '') +
          (f.installed && f.state === 'customized' ? '<a class="action" data-resetfile="' + esc(a.key) + '|' + esc(f.rel) + '">' + esc(S.actionResetFile) + '</a>' : '');
        return '<div class="file-row"><span class="src-path">' + esc(f.rel) + '</span>' +
          (state ? '<span class="file-state ' + esc(f.state) + '">' + esc(state) + '</span>' : '') + links + '</div>';
      }).join('');
      const details = '<details data-key="' + esc(a.key) + '"' + (openKeys.has(a.key) ? ' open' : '') + '><summary>' +
        esc(fmt(S.detailsFiles, a.files.length)) + '</summary>' + files + '</details>';
      const reset = a.status === 'customized'
        ? '<a class="action" data-reset="' + esc(a.key) + '">' + esc(S.actionResetToPack) + '</a>' : '';
      const conflictNote = a.status === 'conflict' && a.conflictWith
        ? '<div class="desc" style="color:var(--err)">' + esc(fmt(S.conflictNote, a.conflictWith)) + '</div>'
        : '';
      return '<tr>' +
        '<td><input type="checkbox" title="' + esc(S.toggleTip) + '" data-toggle="' + esc(a.key) + '"' + (a.enabled ? ' checked' : '') + '></td>' +
        '<td><span class="asset-name">' + esc(a.id) + '</span>' +
          (a.description ? '<div class="desc">' + esc(a.description) + '</div>' : '') + conflictNote + details + '</td>' +
        '<td class="muted">' + esc(a.pack) + '</td>' +
        '<td><span class="type">' + esc(a.type) + '</span></td>' +
        '<td><span class="badge ' + cls + '">' + esc(label) + '</span></td>' +
        '<td>' + reset + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">' +
      esc(data.assets.length ? S.emptyFilter :
        (data.workspace ? S.emptyNoAssets : S.emptyNoWorkspace)) +
      '</td></tr>';

    for (const el of document.querySelectorAll('[data-toggle]'))
      el.onchange = () => post({ type: 'toggle', key: el.dataset.toggle, enabled: el.checked });
    for (const el of document.querySelectorAll('[data-reset]'))
      el.onclick = () => post({ type: 'reset', key: el.dataset.reset });
    for (const el of document.querySelectorAll('[data-open]'))
      el.onclick = () => post({ type: 'openInstalled', rel: el.dataset.open });
    for (const el of document.querySelectorAll('[data-src]')) {
      el.onclick = () => { const [key, rel] = splitOnce(el.dataset.src); post({ type: 'openSource', key, rel }); };
    }
    for (const el of document.querySelectorAll('[data-diff]')) {
      el.onclick = () => { const [key, rel] = splitOnce(el.dataset.diff); post({ type: 'diff', key, rel }); };
    }
    for (const el of document.querySelectorAll('[data-resetfile]')) {
      el.onclick = () => { const [key, rel] = splitOnce(el.dataset.resetfile); post({ type: 'resetFile', key, rel }); };
    }
  }

  // Asset keys contain no '|'; rels may, so split on the first one only.
  function splitOnce(s) {
    const i = s.indexOf('|');
    return [s.slice(0, i), s.slice(i + 1)];
  }

  post({ type: 'refresh' });
</script>
</body>
</html>`;
}
