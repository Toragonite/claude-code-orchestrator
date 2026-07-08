import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AssetType,
  assetFiles,
  assetStatus,
  createAssetTemplate,
  describeSyncReport,
  orphanedAssets,
  PackAsset,
  readAssetState,
  relOwners,
  setAssetEnabled,
  syncWorkspace,
} from './assets';
import { PackSource, resolvePackSources } from './packSources';

/**
 * Asset Manager — a dedicated webview panel for managing which Claude assets
 * (skills, agents, commands, output styles) are installed in the current
 * workspace's .claude/. Shows pack sources, per-asset sync status, per-file
 * detail with diff for customized copies, and pack-source administration.
 * Follows the dashboard's conventions: 2s data push, theme-var styling.
 */

const ASSET_TYPES: AssetType[] = ['skill', 'agent', 'command', 'output-style'];

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
  panel = vscode.window.createWebviewPanel('ccoAssetManager', 'Claude Assets', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = assetManagerHtml();

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
          noteReport(msg.enabled === true ? 'enabled' : 'disabled', describeSyncReport(syncWorkspace(packs(), ws)));
          break;
        }
        case 'syncNow': {
          if (!ws) {
            break;
          }
          noteReport('sync', describeSyncReport(syncWorkspace(packs(), ws)));
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
          const choice = await vscode.window.showWarningMessage(
            `Overwrite your local edits of "${key}" with the pack version? This cannot be undone.`,
            {
              modal: true,
              detail: customized.length ? `Files to overwrite:\n${customized.join('\n')}` : undefined,
            },
            'Overwrite',
          );
          if (choice === 'Overwrite') {
            noteReport('reset', describeSyncReport(syncWorkspace(packs(), ws, new Set([key]))));
          }
          break;
        }
        case 'resetFile': {
          if (!ws || !key || !rel) {
            break;
          }
          const choice = await vscode.window.showWarningMessage(
            `Overwrite your local edits of "${rel}" with the pack version? This cannot be undone.`,
            { modal: true },
            'Overwrite',
          );
          if (choice === 'Overwrite') {
            noteReport(
              'reset file',
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
          const choice = await vscode.window.showWarningMessage(
            `Disable "${key}" and delete its ${count} unmodified installed file(s)? Files you edited are kept. ` +
              'If the pack is only missing on this machine, re-add its directory instead — nothing is lost by waiting.',
            { modal: true },
            'Disable & clean',
          );
          if (choice !== 'Disable & clean') {
            break;
          }
          setAssetEnabled(ws, key, false);
          noteReport('cleaned orphan', describeSyncReport(syncWorkspace(packs(), ws)));
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
              `${rel} — pack ↔ installed`,
            );
          }
          break;
        }
        case 'addPack': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Use as asset pack',
            title: 'Select an asset-pack directory (mirrors .claude/ layout)',
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
      'No writable asset pack configured. Add a pack directory first (e.g. your private claude-assets clone) — ' +
        'the bundled pack cannot be edited because it is replaced on every extension update.',
    );
    return;
  }
  const packPick =
    writable.length === 1
      ? { source: writable[0] }
      : await vscode.window.showQuickPick(
          writable.map((source) => ({ label: source.pack!.name, description: source.root, source })),
          { placeHolder: 'Pack to create the asset in' },
        );
  if (!packPick) {
    return;
  }
  const typePick = await vscode.window.showQuickPick(
    ASSET_TYPES.map((t) => ({ label: t })),
    { placeHolder: 'Asset type' },
  );
  if (!typePick) {
    return;
  }
  const id = await vscode.window.showInputBox({
    prompt: `Name for the new ${typePick.label} (letters, digits, ".", "-", "_")`,
    validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim()) ? undefined : 'Invalid name'),
  });
  if (!id) {
    return;
  }
  const file = createAssetTemplate(packPick.source.root, typePick.label as AssetType, id.trim());
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

/** Exported for headless rendering tests. */
export function assetManagerHtml(): string {
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
  <h1>Claude Assets</h1>
  <p id="meta"></p>

  <div class="toolbar">
    <button class="primary" data-act="syncNow">Sync now</button>
    <button data-act="newAsset">New asset…</button>
    <button data-act="addPack">Add pack directory…</button>
    <label class="inline"><input type="checkbox" id="autosync"> auto-sync on startup</label>
    <span class="spacer"></span>
    <input type="text" id="filter" placeholder="filter assets…" spellcheck="false">
  </div>

  <div class="card">
    <h2>Pack sources</h2>
    <div id="sources"></div>
  </div>

  <div class="card">
    <h2>Assets in this workspace<span id="summary" style="font-weight:400;text-transform:none;letter-spacing:0"></span></h2>
    <table id="assets"><thead><tr>
      <th title="checked = installed into this workspace's .claude/">on</th><th>asset</th><th>pack</th><th>type</th><th>status</th><th>actions</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="card" id="orphans-card" style="display:none">
    <h2>Orphaned assets (enabled here, but their pack is unavailable)</h2>
    <p class="muted" style="font-size:0.85em;margin:0 0 6px">
      Most often the pack just isn't on this machine yet (e.g. a private asset repo that isn't cloned here).
      Re-adding its directory restores these rows — installed files stay untouched meanwhile.
      "Disable &amp; clean" removes the unmodified installed files after a confirmation.
    </p>
    <div id="orphans"></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
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
    'synced': ['synced', 'synced'],
    'update-available': ['update', 'update available'],
    'customized': ['customized', 'customized'],
    'not-installed': ['off', 'not installed'],
    'conflict': ['orphan', 'conflict'],
  };
  const FILE_STATE_LABEL = { 'in-sync': '', 'writable': 'update pending', 'customized': 'customized', 'missing-source': 'source unreadable' };

  function render() {
    if (!data) return;
    document.getElementById('meta').textContent =
      (data.workspace ? 'workspace: ' + data.workspace : 'no workspace open — open a folder to manage its assets') +
      (data.lastReport ? '   |   ' + data.lastReport : '');
    document.getElementById('autosync').checked = data.autoSync;

    document.getElementById('sources').innerHTML = data.sources.map((s) => {
      const status = s.ok
        ? '<span class="badge synced">' + s.assetCount + ' asset' + (s.assetCount === 1 ? '' : 's') + '</span>'
        : '<span class="badge orphan">directory missing</span>';
      const remove = s.kind === 'setting'
        ? '<a class="action" data-remove="' + esc(s.entry) + '">remove</a>' : '';
      const reveal = s.ok ? '<a class="action" data-reveal="' + esc(s.root) + '">reveal</a>' : '';
      return '<div class="file-row" style="margin-left:0">' +
        '<b>' + esc(s.name ?? s.entry) + '</b>' +
        '<span class="src-path muted">' + esc(s.kind === 'bundled' ? 'bundled with the extension' : s.root) + '</span>' +
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
        '<span class="muted">' + o.files.length + ' installed file(s) kept</span>' +
        '<a class="action" data-orphan="' + esc(o.key) + '">disable &amp; clean</a></div>'
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
      ? ' — ' + counts.enabled + ' enabled of ' + data.assets.length +
        (counts.update ? ' · ' + counts.update + ' update available' : '') +
        (counts.customized ? ' · ' + counts.customized + ' customized' : '') +
        (counts.conflict ? ' · ' + counts.conflict + ' conflict' : '')
      : '';

    const openKeys = new Set([...document.querySelectorAll('#assets details[open]')].map((d) => d.dataset.key));
    const q = document.getElementById('filter').value.trim().toLowerCase();
    const rows = data.assets.filter((a) =>
      !q || (a.id + ' ' + a.pack + ' ' + a.type + ' ' + (a.description || '') + ' ' + a.status + ' ' +
        (STATUS_BADGE[a.status] || ['', ''])[1] + (a.enabled ? ' enabled installed' : ' disabled')).toLowerCase().includes(q));
    document.querySelector('#assets tbody').innerHTML = rows.map((a) => {
      const [cls, label] = STATUS_BADGE[a.status] || ['off', esc(a.status)];
      const files = a.files.map((f) => {
        const state = FILE_STATE_LABEL[f.state] || '';
        const links =
          (f.installed ? '<a class="action" data-open="' + esc(f.rel) + '">open</a>' : '') +
          '<a class="action" data-src="' + esc(a.key) + '|' + esc(f.rel) + '">pack version</a>' +
          (f.installed && f.state !== 'in-sync' ? '<a class="action" data-diff="' + esc(a.key) + '|' + esc(f.rel) + '">diff</a>' : '') +
          (f.installed && f.state === 'customized' ? '<a class="action" data-resetfile="' + esc(a.key) + '|' + esc(f.rel) + '">reset</a>' : '');
        return '<div class="file-row"><span class="src-path">' + esc(f.rel) + '</span>' +
          (state ? '<span class="file-state ' + esc(f.state) + '">' + state + '</span>' : '') + links + '</div>';
      }).join('');
      const details = '<details data-key="' + esc(a.key) + '"' + (openKeys.has(a.key) ? ' open' : '') + '><summary>' +
        a.files.length + ' file' + (a.files.length === 1 ? '' : 's') + '</summary>' + files + '</details>';
      const reset = a.status === 'customized'
        ? '<a class="action" data-reset="' + esc(a.key) + '">reset to pack</a>' : '';
      const conflictNote = a.status === 'conflict' && a.conflictWith
        ? '<div class="desc" style="color:var(--err)">same install path as ' + esc(a.conflictWith) + ' — disable one of the two</div>'
        : '';
      return '<tr>' +
        '<td><input type="checkbox" title="install into this workspace" data-toggle="' + esc(a.key) + '"' + (a.enabled ? ' checked' : '') + '></td>' +
        '<td><span class="asset-name">' + esc(a.id) + '</span>' +
          (a.description ? '<div class="desc">' + esc(a.description) + '</div>' : '') + conflictNote + details + '</td>' +
        '<td class="muted">' + esc(a.pack) + '</td>' +
        '<td><span class="type">' + esc(a.type) + '</span></td>' +
        '<td><span class="badge ' + cls + '">' + label + '</span></td>' +
        '<td>' + reset + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">' +
      (data.assets.length ? 'no assets match the filter' :
        (data.workspace ? 'no assets found — add a pack directory or create one with “New asset…”' : 'open a workspace folder first')) +
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
