import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AssetState,
  AssetStateUnreadableError,
  AssetType,
  assetFiles,
  assetStatus,
  createAssetTemplate,
  isSafeRel,
  orphanedAssets,
  PackAsset,
  readAssetState,
  relOwners,
  setAssetEnabled,
  SyncReport,
  syncWorkspace,
} from './assets';
import { flattenOneLine, sliceOneLine } from './displayText';
import { PackSource, resolvePackSources } from './packSources';
import { CONFIG_SECTION, userSetting } from './settings';
import { describeSyncReport } from './syncReport';
import { createPageActionLimiter, escapeHtml, jsonForScript, makeNonce } from './webviewUtil';
import { pickText } from './views';

/**
 * Asset Manager — a dedicated webview panel for managing which Claude assets
 * (skills, agents, commands, output styles) are installed in the current
 * workspace's .claude/. Shows pack sources, per-asset sync status, per-file
 * detail with diff for customized copies, and pack-source administration.
 * Follows the dashboard's conventions: 2s data push, theme-var styling, a document whose
 * policy admits one nonce'd script and one nonce'd stylesheet, a page that builds its rows
 * from elements and text — a pack's name is whatever its `pack.json` says and a file's name is
 * whatever is on disk, so neither is ever parsed as markup — and a host that checks every
 * message of the page by value before it acts on it.
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

/**
 * Tell the user that an asset action did nothing because the workspace's asset ledger could
 * not be understood (`AssetStateUnreadableError`: the file is left exactly as it is), and
 * offer to open the file. Shared with the asset commands in extension.ts.
 */
export function showAssetStateProblem(err: AssetStateUnreadableError): void {
  const openLabel = vscode.l10n.t('Open File');
  void vscode.window
    .showErrorMessage(vscode.l10n.t('The workspace assets were not changed. {0}', err.message), openLabel)
    .then(
      async (choice) => {
        if (choice === openLabel) {
          try {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(err.file)));
          } catch {
            // the message already names the file
          }
        }
      },
      () => undefined,
    );
}

/** What one kind of message from the Asset Manager page must carry, and how it is bounded. */
interface PageMessageSpec {
  /** It names an asset by `key`. */
  key?: true;
  /** It names a file by `rel`, its install path relative to `.claude/`. */
  rel?: true;
  /** It carries a true / false under this name. */
  flag?: 'enabled' | 'value';
  /** It names a pack directory under this name: an entry of the setting, or a resolved root. */
  dir?: 'entry' | 'root';
  /**
   * It ends in a dialog or starts a program: the lane it is bounded in (see
   * `createPageActionLimiter`) — one a second per lane, and for an exclusive lane nothing more
   * while a dialog this panel opened is still being answered.
   */
  bound?: { lane: string; exclusive: boolean };
}

const DIALOG = { lane: 'dialog', exclusive: true } as const;

/**
 * Every message the page may send. A message of any other type, or one that lacks a field its
 * type names here, has no effect at all. The table is asked with an own-key test, so
 * `toString` is not a message.
 */
const PAGE_MESSAGES: Readonly<Record<string, PageMessageSpec>> = {
  refresh: {},
  syncNow: {},
  toggle: { key: true, flag: 'enabled' },
  reset: { key: true, bound: DIALOG },
  resetFile: { key: true, rel: true, bound: DIALOG },
  disableOrphan: { key: true, bound: DIALOG },
  openInstalled: { rel: true },
  openSource: { key: true, rel: true },
  diff: { key: true, rel: true },
  addPack: { bound: DIALOG },
  removePack: { dir: 'entry' },
  // Starts the operating system's file manager.
  revealPack: { dir: 'root', bound: { lane: 'reveal', exclusive: false } },
  setAutoSync: { flag: 'value' },
  newAsset: { bound: DIALOG },
};

/** An asset key is `<pack>:<type-dir>/<id>`; nothing the host lists comes near this. */
const PAGE_KEY_MAX = 1024;
/** A path a message names: a pack directory, or a file's install path. */
const PAGE_PATH_MAX = 4096;

interface PageMessage {
  type: string;
  spec: PageMessageSpec;
  /** '' when the type names no asset. */
  key: string;
  /** '' when the type names no file. */
  rel: string;
  /** '' when the type names no directory. */
  dir: string;
  /** false when the type carries no flag. */
  flag: boolean;
}

/**
 * A message of the page, checked by SHAPE: an object whose `type` is one of PAGE_MESSAGES, and
 * whose fields — exactly the ones that type names — are a non-empty string within its bound, a
 * relative path that stays inside `.claude/`, or a real boolean (a missing or misspelled flag
 * is not "off": acting on it would uninstall an asset). Undefined for anything else. Whether
 * the asset, the file or the directory it names is one the host itself lists is asked later,
 * against the packs as they are then. Never throws.
 */
function checkPageMessage(raw: unknown): PageMessage | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  const type = msg.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(PAGE_MESSAGES, type)) {
    return undefined;
  }
  const spec = PAGE_MESSAGES[type];
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;
  const key = spec.key ? text(msg.key, PAGE_KEY_MAX) : '';
  const rel = spec.rel ? text(msg.rel, PAGE_PATH_MAX) : '';
  const dir = spec.dir ? text(msg[spec.dir], PAGE_PATH_MAX) : '';
  const flag: unknown = spec.flag ? msg[spec.flag] : false;
  if (key === undefined || rel === undefined || dir === undefined || typeof flag !== 'boolean') {
    return undefined;
  }
  if (spec.rel && !isSafeRel(rel)) {
    return undefined;
  }
  return { type, spec, key, rel, dir, flag };
}

/** A pack's or a file's name as a dialog shows it: one display-safe line, capped. */
function shownName(value: string): string {
  return sliceOneLine(flattenOneLine(value), 200);
}

/** Files named in one summary of a sync; past this it says how many more there are. */
const BLOCKED_FILES_SHOWN = 5;

/**
 * One-line summary of a sync run, for the user: `describeSyncReport`'s list, and — when sync
 * had to leave files alone because it could not safely read, write or remove them
 * (`SyncReport.blocked`) — how many, which file of which asset, and why. A run that left
 * files alone is never summed up as "everything up to date".
 *
 * An asset's key and a file's name come from a pack's `pack.json` and from directory names:
 * each is shown as one display-safe line. The reason is the sync engine's own English, made
 * of fixed words, byte counts and error codes.
 *
 * Shared with the asset commands in extension.ts.
 */
export function describeSync(report: SyncReport): string {
  const blocked = Array.isArray(report.blocked) ? report.blocked : [];
  if (blocked.length === 0) {
    return describeSyncReport(report);
  }
  const named = blocked
    .slice(0, BLOCKED_FILES_SHOWN)
    .map((b) => (b.rel === '' ? `${shownName(b.asset)}: ${b.reason}` : `${shownName(b.asset)} — ${shownName(b.rel)}: ${b.reason}`))
    .join('; ');
  const notSynced =
    blocked.length > BLOCKED_FILES_SHOWN
      ? vscode.l10n.t('{0} file(s) not synced ({1}; and {2} more)', blocked.length, named, blocked.length - BLOCKED_FILES_SHOWN)
      : vscode.l10n.t('{0} file(s) not synced ({1})', blocked.length, named);
  const nothingElse =
    report.installed.length +
      report.updated.length +
      report.removed.length +
      report.customized.length +
      report.orphaned.length +
      report.conflicts.length ===
    0;
  return nothingElse ? notSynced : `${describeSyncReport(report)}, ${notSynced}`;
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
  panel.webview.html = assetManagerHtml(assetManagerStrings(), makeNonce());

  // Written to the user's settings, and read back from them alone (`userSetting`).
  const cfg = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

  const limiter = createPageActionLimiter({
    intervalMs: 1_000,
    onBurst: () => {
      vscode.window.setStatusBarMessage(
        vscode.l10n.t('Claude Assets: several actions were asked for at once — only the first was carried out.'),
        5000,
      );
    },
  });

  /** The ledger problem last shown, so the 2-second refresh says it once, not every tick. */
  let stateProblemShown: string | undefined;

  /**
   * Post the current state to the page. Display only — nothing is written from here — and
   * total: it runs on a timer and after every message, where nothing catches. A failure
   * leaves the page on what it last showed, and the next tick tries again.
   */
  const send = () => {
    if (!panel) {
      return;
    }
    try {
      const ws = workspaceRoot();
      const sources = resolvePackSources(context);
      const packs = sources.flatMap((s) => (s.pack ? [s.pack] : []));
      const assets = collectAssets(sources);
      // A ledger that cannot be understood is shown as an empty one — this is display only, and
      // nothing is written from here — and said once. Every action that would write it refuses.
      let state: AssetState = { version: 1, assets: {} };
      let stateProblem: string | null = null;
      if (ws) {
        try {
          state = readAssetState(ws);
          stateProblemShown = undefined;
        } catch (err) {
          stateProblem = err instanceof Error ? err.message : String(err);
          if (err instanceof AssetStateUnreadableError && stateProblemShown !== stateProblem) {
            stateProblemShown = stateProblem;
            showAssetStateProblem(err);
          }
        }
      }
      const owners = relOwners(assets, state);
      void panel.webview.postMessage({
        type: 'data',
        workspace: ws ?? null,
        autoSync: userSetting('assetAutoSync'),
        lastReport: stateProblem ?? lastReport,
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
        orphans: ws && stateProblem === null ? orphanedAssets(packs, ws) : [],
      });
    } catch {
      // a pack directory or the ledger changed under the read; the next tick shows the result
    }
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

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    // A message is whatever the page sent. It is checked by shape before a field of it is
    // used; what it NAMES — an asset, one of its files, a pack directory — is then looked up
    // among the things this side lists right now, and a name that is not among them does
    // nothing. Nothing the page says is used as a path or shown in a dialog as it came.
    const msg = checkPageMessage(raw);
    if (msg === undefined) {
      return;
    }
    const finished =
      msg.spec.bound === undefined ? () => undefined : limiter.admit(msg.spec.bound.lane, msg.spec.bound.exclusive);
    if (finished === undefined) {
      return;
    }
    try {
      const ws = workspaceRoot();
      const sources = () => resolvePackSources(context);
      const packs = () => sources().flatMap((s) => (s.pack ? [s.pack] : []));
      /** The asset `msg.key` names, when the packs hold one of exactly that key. */
      const namedAsset = (): PackAsset | undefined =>
        msg.key === '' ? undefined : collectAssets(sources()).find((a) => a.key === msg.key);
      /** The pack file behind `msg.rel` of `asset` — an OWN entry of its file table. */
      const sourceOf = (asset: PackAsset): string | undefined =>
        Object.prototype.hasOwnProperty.call(asset.files, msg.rel) ? asset.files[msg.rel] : undefined;
      switch (msg.type) {
        case 'refresh':
          break;
        case 'toggle': {
          const asset = ws ? namedAsset() : undefined;
          if (!ws || !asset) {
            break;
          }
          setAssetEnabled(ws, asset.key, msg.flag);
          noteReport(
            msg.flag ? vscode.l10n.t('enabled') : vscode.l10n.t('disabled'),
            describeSync(syncWorkspace(packs(), ws)),
          );
          break;
        }
        case 'syncNow': {
          if (!ws) {
            break;
          }
          noteReport(vscode.l10n.t('sync'), describeSync(syncWorkspace(packs(), ws)));
          break;
        }
        case 'reset': {
          const asset = ws ? namedAsset() : undefined;
          if (!ws || !asset) {
            break;
          }
          const customized = assetFiles(asset, readAssetState(ws), ws)
            .filter((f) => f.state === 'customized')
            .map((f) => f.rel);
          const overwriteLabel = vscode.l10n.t('Overwrite');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Overwrite your local edits of "{0}" with the pack version? This cannot be undone.',
              shownName(asset.key),
            ),
            {
              modal: true,
              detail: customized.length
                ? vscode.l10n.t('Files to overwrite:\n{0}', customized.map(shownName).join('\n'))
                : undefined,
            },
            overwriteLabel,
          );
          if (choice === overwriteLabel) {
            noteReport(
              vscode.l10n.t('reset'),
              describeSync(syncWorkspace(packs(), ws, new Set([asset.key]))),
            );
          }
          break;
        }
        case 'resetFile': {
          const asset = ws ? namedAsset() : undefined;
          if (!ws || !asset || sourceOf(asset) === undefined) {
            break;
          }
          const overwriteLabel = vscode.l10n.t('Overwrite');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Overwrite your local edits of "{0}" with the pack version? This cannot be undone.',
              shownName(msg.rel),
            ),
            { modal: true },
            overwriteLabel,
          );
          if (choice === overwriteLabel) {
            noteReport(
              vscode.l10n.t('reset file'),
              describeSync(syncWorkspace(packs(), ws, new Set(), new Set([`${asset.key}\0${msg.rel}`]))),
            );
          }
          break;
        }
        case 'disableOrphan': {
          // Only an asset the ledger holds as enabled while no pack provides it.
          const orphan = ws ? orphanedAssets(packs(), ws).find((o) => o.key === msg.key) : undefined;
          if (!ws || !orphan) {
            break;
          }
          const disableCleanLabel = vscode.l10n.t('Disable & clean');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Disable "{0}" and delete its {1} unmodified installed file(s)? Files you edited are kept. If the pack is only missing on this machine, re-add its directory instead — nothing is lost by waiting.',
              shownName(orphan.key),
              orphan.files.length,
            ),
            { modal: true },
            disableCleanLabel,
          );
          if (choice !== disableCleanLabel) {
            break;
          }
          setAssetEnabled(ws, orphan.key, false);
          noteReport(vscode.l10n.t('cleaned orphan'), describeSync(syncWorkspace(packs(), ws)));
          break;
        }
        case 'openInstalled': {
          // A file some listed asset installs — not any path under `.claude/` the page names.
          const listed = collectAssets(sources()).some((a) =>
            Object.prototype.hasOwnProperty.call(a.files, msg.rel),
          );
          const target = ws && listed ? safeInstalledPath(ws, msg.rel) : undefined;
          if (target && fs.existsSync(target)) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
              preview: true,
            });
          }
          break;
        }
        case 'openSource':
        case 'diff': {
          const asset = namedAsset();
          const source = asset ? sourceOf(asset) : undefined;
          if (!asset || source === undefined) {
            break;
          }
          if (msg.type === 'openSource') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), {
              preview: true,
            });
            break;
          }
          const target = ws ? safeInstalledPath(ws, msg.rel) : undefined;
          if (target && fs.existsSync(target)) {
            await vscode.commands.executeCommand(
              'vscode.diff',
              vscode.Uri.file(source),
              vscode.Uri.file(target),
              vscode.l10n.t('{0} — pack ↔ installed', shownName(msg.rel)),
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
            // The user's own list is what is extended and written back — never the merged
            // value, which would copy a workspace's entries into the user's settings.
            const current = userSetting('assetPacks');
            if (!current.includes(dir)) {
              await cfg().update('assetPacks', [...current, dir], vscode.ConfigurationTarget.Global);
            }
          }
          break;
        }
        case 'removePack': {
          // Only an entry the user's own list holds, spelled as it is there.
          const current = userSetting('assetPacks');
          if (current.includes(msg.dir)) {
            await cfg().update(
              'assetPacks',
              current.filter((e) => e !== msg.dir),
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
        case 'revealPack': {
          // Only a directory this side itself lists as a pack source.
          const source = sources().find((s) => s.root === msg.dir);
          if (source) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(source.root));
          }
          break;
        }
        case 'setAutoSync': {
          await cfg().update('assetAutoSync', msg.flag, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'newAsset': {
          await createNewAsset(sources());
          break;
        }
      }
    } catch (err) {
      if (err instanceof AssetStateUnreadableError) {
        showAssetStateProblem(err);
      } else {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      finished();
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
          // A pack's name comes from its own manifest: inert where the picker draws `$(icon)`.
          writable.map((source) => ({ label: pickText(source.pack!.name, 80), description: pickText(source.root, 1024), source })),
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

/**
 * The Asset Manager's document. Pure: same strings and nonce in, same HTML out. Exported for
 * headless rendering tests.
 *
 * The policy allows exactly the one script and the one stylesheet below, by this render's
 * nonce: no inline handler, no `style` attribute, no network. The body is static — localized
 * strings, escaped — and everything that depends on data is built by the script from elements
 * and text (`el`): a pack's name, an asset's id or description, a file's path can hold any
 * character, and none of it is ever handed to an HTML parser.
 */
export function assetManagerHtml(s: AssetManagerStrings, nonce: string): string {
  // A nonce is written into the policy and into two attributes; anything but the plain token
  // `makeNonce` produces is replaced rather than escaped.
  const token = /^[A-Za-z0-9]{16,128}$/.test(nonce) ? nonce : makeNonce();
  const csp = [`default-src 'none'`, `style-src 'nonce-${token}'`, `script-src 'nonce-${token}'`].join('; ');
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)};">
<style nonce="${token}">
  :root {
    --c-muted: var(--vscode-descriptionForeground);
    --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --border: var(--vscode-panel-border, #4444);
    --ok: var(--vscode-charts-green, #89d185);
    --warn: var(--vscode-editorWarning-foreground, #cca700);
    --err: var(--vscode-charts-red, #f14c4c);
    --info: var(--vscode-charts-blue, #3794ff);
  }
  [hidden] { display: none !important; }
  /* Size, weight and margin are the editor's own defaults for a webview body, stated here so
     that the page reads the same whether or not the editor's default sheet applies under this
     policy. */
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); font-weight: var(--vscode-font-weight, normal); color: var(--vscode-foreground); margin: 0; padding: 14px 18px 40px; }
  h1 { font-size: 1.15em; margin: 0 0 2px; }
  #meta { color: var(--c-muted); font-size: 0.88em; margin: 0 0 14px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; }
  .card h2 { font-size: 0.82em; font-weight: 600; color: var(--c-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 8px; }
  #summary { font-weight: 400; text-transform: none; letter-spacing: 0; }
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
  .orphans-help { font-size: 0.85em; margin: 0 0 6px; }
  .badge { border: 1px solid var(--border); border-radius: 8px; padding: 0 7px; font-size: 0.82em; white-space: nowrap; }
  .badge.synced { color: var(--ok); border-color: var(--ok); }
  .badge.update { color: var(--info); border-color: var(--info); }
  .badge.customized { color: var(--warn); border-color: var(--warn); }
  .badge.off { color: var(--c-muted); }
  .badge.orphan { color: var(--err); border-color: var(--err); }
  .type { font-size: 0.8em; color: var(--c-muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
  .asset-name { font-weight: 600; }
  .desc { color: var(--c-muted); font-size: 0.85em; margin-top: 1px; max-width: 60ch; }
  .desc.conflict { color: var(--err); }
  a.action { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; margin-right: 8px; white-space: nowrap; }
  a.action:hover { text-decoration: underline; }
  details { margin-top: 3px; }
  summary { cursor: pointer; color: var(--c-muted); font-size: 0.85em; }
  .file-row { font-size: 0.85em; margin: 2px 0 0 14px; display: flex; gap: 8px; align-items: baseline; }
  .file-row.flush { margin-left: 0; }
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
  <h1>${escapeHtml(s.title)}</h1>
  <p id="meta"></p>

  <div class="toolbar">
    <button class="primary" data-act="syncNow">${escapeHtml(s.btnSyncNow)}</button>
    <button data-act="newAsset">${escapeHtml(s.btnNewAsset)}</button>
    <button data-act="addPack">${escapeHtml(s.btnAddPack)}</button>
    <label class="inline"><input type="checkbox" id="autosync"> ${escapeHtml(s.autoSyncLabel)}</label>
    <span class="spacer"></span>
    <input type="text" id="filter" placeholder="${escapeHtml(s.filterPlaceholder)}" spellcheck="false">
  </div>

  <div class="card">
    <h2>${escapeHtml(s.sourcesTitle)}</h2>
    <div id="sources"></div>
  </div>

  <div class="card">
    <h2>${escapeHtml(s.assetsTitle)}<span id="summary"></span></h2>
    <table id="assets"><thead><tr>
      <th title="${escapeHtml(s.thOnTip)}">${escapeHtml(s.thOn)}</th><th>${escapeHtml(s.thAsset)}</th><th>${escapeHtml(s.thPack)}</th><th>${escapeHtml(s.thType)}</th><th>${escapeHtml(s.thStatus)}</th><th>${escapeHtml(s.thActions)}</th>
    </tr></thead><tbody id="assets-body"></tbody></table>
  </div>

  <div class="card" id="orphans-card" hidden>
    <h2>${escapeHtml(s.orphansTitle)}</h2>
    <p class="muted orphans-help">
      ${escapeHtml(s.orphansHelp)}
    </p>
    <div id="orphans"></div>
  </div>

<script nonce="${token}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const S = ${jsonForScript(s)};
  const fmt = (template, ...args) => String(template).replace(/\\{(\\d+)\\}/g, (_m, i) => String(args[i]));
  const post = (message) => vscode.postMessage(message);
  const byId = (id) => document.getElementById(id);
  const items = (value) => (Array.isArray(value) ? value : []);
  const text = (value) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));

  // Every element that shows data is made here: a tag, a class written in this file, and TEXT.
  // Nothing that arrives in a message is ever parsed as markup or set as an attribute name.
  function el(tag, cls, content) {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (content !== undefined) {
      node.textContent = text(content);
    }
    return node;
  }
  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }
  function action(label, run) {
    const node = el('a', 'action', label);
    node.addEventListener('click', run);
    return node;
  }

  let data = null;
  let lastSig = '';
  /** Keys of the assets whose file list is unfolded; a re-render keeps them unfolded. */
  const openKeys = new Set();

  window.addEventListener('message', (event) => {
    const incoming = event.data;
    if (typeof incoming !== 'object' || incoming === null || incoming.type !== 'data') {
      return;
    }
    const sig = JSON.stringify(incoming);
    if (sig === lastSig) {
      return;
    }
    lastSig = sig;
    data = incoming;
    render();
  });

  for (const button of document.querySelectorAll('button[data-act]')) {
    button.addEventListener('click', () => post({ type: button.getAttribute('data-act') }));
  }
  byId('autosync').addEventListener('change', (event) => post({ type: 'setAutoSync', value: event.target.checked === true }));
  byId('filter').addEventListener('input', renderAssets);

  // status -> [badge class, label]; file state -> [class, label]. Maps, so a status that is
  // not one of these finds nothing rather than something inherited.
  const STATUS_BADGE = new Map([
    ['synced', ['synced', S.statusSynced]],
    ['update-available', ['update', S.statusUpdateAvailable]],
    ['customized', ['customized', S.statusCustomized]],
    ['not-installed', ['off', S.statusNotInstalled]],
    ['conflict', ['orphan', S.statusConflict]],
  ]);
  const FILE_STATE = new Map([
    ['writable', ['writable', S.fileUpdatePending]],
    ['customized', ['customized', S.fileCustomized]],
    ['missing-source', ['missing-source', S.fileSourceUnreadable]],
  ]);

  function render() {
    if (!data) {
      return;
    }
    byId('meta').textContent =
      (data.workspace ? fmt(S.metaWorkspace, data.workspace) : S.metaNoWorkspace) +
      (data.lastReport ? '   |   ' + text(data.lastReport) : '');
    byId('autosync').checked = data.autoSync === true;

    const sources = byId('sources');
    clear(sources);
    for (const source of items(data.sources)) {
      const row = el('div', 'file-row flush');
      row.appendChild(el('b', '', source.name === null || source.name === undefined ? source.entry : source.name));
      row.appendChild(el('span', 'src-path muted', source.kind === 'bundled' ? S.bundledLabel : source.root));
      row.appendChild(
        source.ok ? el('span', 'badge synced', fmt(S.sourceAssetCount, source.assetCount)) : el('span', 'badge orphan', S.dirMissing),
      );
      if (source.ok) {
        row.appendChild(action(S.actionReveal, () => post({ type: 'revealPack', root: source.root })));
      }
      if (source.kind === 'setting') {
        row.appendChild(action(S.actionRemove, () => post({ type: 'removePack', entry: source.entry })));
      }
      sources.appendChild(row);
    }

    renderAssets();

    const orphans = items(data.orphans);
    const list = byId('orphans');
    clear(list);
    for (const orphan of orphans) {
      const row = el('div', 'file-row flush');
      row.appendChild(el('b', '', orphan.key));
      row.appendChild(el('span', 'muted', fmt(S.orphanFilesKept, items(orphan.files).length)));
      row.appendChild(action(S.actionDisableClean, () => post({ type: 'disableOrphan', key: orphan.key })));
      list.appendChild(row);
    }
    byId('orphans-card').hidden = orphans.length === 0;
  }

  function fileRow(key, file) {
    const rel = text(file.rel);
    const row = el('div', 'file-row');
    row.appendChild(el('span', 'src-path', rel));
    const state = FILE_STATE.get(file.state);
    if (state) {
      row.appendChild(el('span', 'file-state ' + state[0], state[1]));
    }
    if (file.installed) {
      row.appendChild(action(S.actionOpen, () => post({ type: 'openInstalled', rel: rel })));
    }
    row.appendChild(action(S.actionPackVersion, () => post({ type: 'openSource', key: key, rel: rel })));
    if (file.installed && file.state !== 'in-sync') {
      row.appendChild(action(S.actionDiff, () => post({ type: 'diff', key: key, rel: rel })));
    }
    if (file.installed && file.state === 'customized') {
      row.appendChild(action(S.actionResetFile, () => post({ type: 'resetFile', key: key, rel: rel })));
    }
    return row;
  }

  function assetRow(asset) {
    const key = text(asset.key);
    const badge = STATUS_BADGE.get(asset.status) || ['off', text(asset.status)];
    const row = el('tr');

    const toggleCell = el('td');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.title = S.toggleTip;
    toggle.checked = asset.enabled === true;
    toggle.addEventListener('change', () => post({ type: 'toggle', key: key, enabled: toggle.checked }));
    toggleCell.appendChild(toggle);
    row.appendChild(toggleCell);

    const nameCell = el('td');
    nameCell.appendChild(el('span', 'asset-name', asset.id));
    if (asset.description) {
      nameCell.appendChild(el('div', 'desc', asset.description));
    }
    if (asset.status === 'conflict' && asset.conflictWith) {
      nameCell.appendChild(el('div', 'desc conflict', fmt(S.conflictNote, asset.conflictWith)));
    }
    const files = items(asset.files);
    const details = el('details');
    details.open = openKeys.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) {
        openKeys.add(key);
      } else {
        openKeys.delete(key);
      }
    });
    details.appendChild(el('summary', '', fmt(S.detailsFiles, files.length)));
    for (const file of files) {
      details.appendChild(fileRow(key, file));
    }
    nameCell.appendChild(details);
    row.appendChild(nameCell);

    row.appendChild(el('td', 'muted', asset.pack));
    const typeCell = el('td');
    typeCell.appendChild(el('span', 'type', asset.type));
    row.appendChild(typeCell);
    const statusCell = el('td');
    statusCell.appendChild(el('span', 'badge ' + badge[0], badge[1]));
    row.appendChild(statusCell);
    const actionsCell = el('td');
    if (asset.status === 'customized') {
      actionsCell.appendChild(action(S.actionResetToPack, () => post({ type: 'reset', key: key })));
    }
    row.appendChild(actionsCell);
    return row;
  }

  function renderAssets() {
    if (!data) {
      return;
    }
    const assets = items(data.assets);
    const counts = { enabled: 0, update: 0, customized: 0, conflict: 0 };
    for (const asset of assets) {
      if (asset.enabled) counts.enabled++;
      if (asset.status === 'update-available') counts.update++;
      if (asset.status === 'customized') counts.customized++;
      if (asset.status === 'conflict') counts.conflict++;
    }
    byId('summary').textContent = counts.enabled || assets.length
      ? ' — ' + fmt(S.summaryEnabled, counts.enabled, assets.length) +
        (counts.update ? ' · ' + fmt(S.summaryUpdate, counts.update) : '') +
        (counts.customized ? ' · ' + fmt(S.summaryCustomized, counts.customized) : '') +
        (counts.conflict ? ' · ' + fmt(S.summaryConflict, counts.conflict) : '')
      : '';

    const query = byId('filter').value.trim().toLowerCase();
    const rows = assets.filter((asset) =>
      !query || (text(asset.id) + ' ' + text(asset.pack) + ' ' + text(asset.type) + ' ' + text(asset.description) + ' ' + text(asset.status) + ' ' +
        (STATUS_BADGE.get(asset.status) || ['', ''])[1] + (asset.enabled ? ' enabled installed' : ' disabled')).toLowerCase().includes(query));
    const body = byId('assets-body');
    clear(body);
    for (const asset of rows) {
      body.appendChild(assetRow(asset));
    }
    if (rows.length === 0) {
      const row = el('tr');
      const cell = el('td', 'empty', assets.length ? S.emptyFilter : data.workspace ? S.emptyNoAssets : S.emptyNoWorkspace);
      cell.colSpan = 6;
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  post({ type: 'refresh' });
})();
</script>
</body>
</html>`;
}
