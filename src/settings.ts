import * as path from 'path';
import * as vscode from 'vscode';
import { flattenOneLine, sliceOneLine } from './displayText';
import { isAcceptableClaudePath } from './platform';
import { readTextSafe } from './safeFs';

/* ------------------------------------------------------------------------- *
 * Settings — the user's own values, and nothing a workspace says
 * ------------------------------------------------------------------------- */

/** The section every setting of this extension lives under. */
export const CONFIG_SECTION = 'claudeCodeOrchestrator';

/** The section the same settings lived under before the rename; read only to migrate and to warn. */
export const LEGACY_CONFIG_SECTION = 'fableOrchestrator';

/** The settings that existed under the old section name. */
export const LEGACY_SETTING_KEYS = [
  'workerPermissionMode',
  'claudePath',
  'quotaCooldownMinutes',
  'frontierWorkerDispatch',
] as const;

/**
 * Every setting this extension contributes, with the default `package.json` declares for it.
 * The table is what makes the reader below total: it says which KIND of value each setting
 * holds (the kind of its default), and it is the value used when the editor reports no default
 * at all.
 */
const SETTING_DEFAULTS = {
  workerPermissionMode: 'acceptEdits',
  claudePath: 'claude',
  quotaCooldownMinutes: 30,
  workerTimeoutMinutes: 45,
  assetPacks: [] as readonly string[],
  assetAutoSync: true,
  frontierWorkerDispatch: 'block',
  overageWorkerDispatch: 'block',
  sessionKeepalive: false,
  providerUsagePolling: true,
  meshMode: false,
  meshMaxLiveWorkers: 8,
  meshHistoryLimit: 50,
  // Teammate mode (team contract §7.7). Ranges and the registry's reading: team/contract
  // TEAM_NUMBER_SETTINGS and the registry's sanitizers.
  teamMode: false,
  teamMaxMembers: 6,
  teamMaxRunningTurns: 4,
  // package.json declares no number here (its default is null): unset follows
  // workerTimeoutMinutes, which a default written down once would stop doing. Read it with
  // explicitUserSetting — this 0 only gives the reader the setting's kind.
  teamTurnTimeoutMinutes: 0,
  teamTurnsPerMemberPerHour: 20,
  teamTurnsPerDay: 300,
  teamCursorForce: false,
  teamAgySkipPermissions: false,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

type Widened<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : string[];
export type SettingValue<K extends SettingKey> = Widened<(typeof SETTING_DEFAULTS)[K]>;

/** Entries an `assetPacks` value is read up to; a list longer than this is cut, not refused. */
const ASSET_PACKS_MAX = 64;

/**
 * `raw` as a value of the same kind as `like`, or undefined when it is not one. A list setting
 * keeps its string entries and drops the rest: each entry is independent, and one bad entry
 * must not discard the others.
 */
function asKindOf(raw: unknown, like: unknown): unknown {
  if (Array.isArray(like)) {
    return Array.isArray(raw)
      ? raw
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '' && !entry.includes('\u0000'))
          .slice(0, ASSET_PACKS_MAX)
      : undefined;
  }
  if (typeof like === 'number') {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }
  return typeof raw === typeof like ? raw : undefined;
}

function inspectSetting(section: string, key: string, scope?: vscode.Uri): ReturnType<vscode.WorkspaceConfiguration['inspect']> {
  try {
    return vscode.workspace.getConfiguration(section, scope).inspect<unknown>(key);
  } catch {
    return undefined;
  }
}

/**
 * The value the USER gave a setting in their own (User) settings, or undefined when they gave
 * none — or gave one of the wrong kind, which reads as not set. This is what tells "the user
 * chose the default" from "the user chose nothing", which the billing guards need: an editor
 * where a guard is unset must not overwrite the choice of another editor sharing the registry.
 */
export function explicitUserSetting<K extends SettingKey>(key: K): SettingValue<K> | undefined {
  return asKindOf(inspectSetting(CONFIG_SECTION, key)?.globalValue, SETTING_DEFAULTS[key]) as
    | SettingValue<K>
    | undefined;
}

/**
 * A setting as this extension ACTS on it: the user's own value, else the default. Every read
 * of a setting in the extension host goes through here.
 *
 * NEVER the merged value an editor's `get()` returns, and never a workspace or folder value.
 * These settings choose which executable is started, what a worker may do unattended, whether
 * money may be spent and which directories files are copied from — and they are pushed into a
 * registry shared by every editor and workspace on the machine. A workspace is a folder that
 * was cloned, or that an agent is editing right now: what its settings file says must not
 * decide any of that. `package.json` declares every setting machine-scoped, which makes
 * current VS Code drop a workspace value by itself; reading only the user's value here keeps
 * the rule true in an editor that does not honour the scope.
 *
 * The value is checked by KIND against the setting's default, because `settings.json` is
 * hand-editable: a text setting that holds a number reads as its default. Ranges and allowed
 * names are the caller's to enforce (each has its own normalizer). Never throws.
 */
export function userSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const builtIn = SETTING_DEFAULTS[key];
  const scopes = inspectSetting(CONFIG_SECTION, key);
  const value =
    asKindOf(scopes?.globalValue, builtIn) ??
    asKindOf(scopes?.defaultValue, builtIn) ??
    (Array.isArray(builtIn) ? [...builtIn] : builtIn);
  return value as SettingValue<K>;
}

/** Bad `claudePath` values the user has been told about, so each is said once and not per sync. */
const refusedClaudePaths = new Set<string>();
const REFUSED_CLAUDE_PATHS_MAX = 32;

/**
 * The `claude` command as the user configured it: the user-level `claudePath` when it is a
 * bare command name or an absolute path (`isAcceptableClaudePath`), trimmed; otherwise the
 * default `claude`. This is the value a terminal line starts with, and the value the registry's
 * resolved path is derived from.
 *
 * A value that is set but not acceptable — a relative path, one with a control character, a
 * number — is not used, and the user is told why, ONCE per distinct value: this is read on
 * every settings sync and before every terminal line. A blank value is simply "not set".
 */
export function userClaudePath(): string {
  const raw: unknown = inspectSetting(CONFIG_SECTION, 'claudePath')?.globalValue;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return SETTING_DEFAULTS.claudePath;
  }
  if (isAcceptableClaudePath(raw)) {
    return raw.trim();
  }
  let seen: string;
  try {
    seen = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? typeof raw);
  } catch {
    seen = typeof raw;
  }
  if (!refusedClaudePaths.has(seen)) {
    if (refusedClaudePaths.size >= REFUSED_CLAUDE_PATHS_MAX) {
      refusedClaudePaths.clear();
    }
    refusedClaudePaths.add(seen);
    const openLabel = vscode.l10n.t('Open Setting');
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t(
          'The "Claude Path" setting is not used: it must be a command name such as "claude" or an absolute path, and it is set to "{0}". The default "claude" is used instead.',
          sliceOneLine(flattenOneLine(seen), 120),
        ),
        openLabel,
      )
      .then(
        (choice) => {
          if (choice === openLabel) {
            void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.claudePath`);
          }
        },
        () => undefined,
      );
  }
  return SETTING_DEFAULTS.claudePath;
}

/* ---- settings a workspace tries to set ---- */

/** One of this extension's settings found at workspace or folder level, where it has no effect. */
export interface WorkspaceLevelSetting {
  /** The full key, e.g. `claudeCodeOrchestrator.claudePath`. */
  key: string;
  where: 'workspace' | 'folder';
  /** The folder's name, for a folder-level value. */
  folder?: string;
  /** The settings file the key was read from, when it was found by reading one. */
  file?: string;
}

const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
/** Folders of a multi-root workspace whose settings are looked at. */
const SETTINGS_FOLDERS_MAX = 32;

function knownFullKeys(): string[] {
  return [
    ...SETTING_KEYS.map((key) => `${CONFIG_SECTION}.${key}`),
    ...LEGACY_SETTING_KEYS.map((key) => `${LEGACY_CONFIG_SECTION}.${key}`),
  ];
}

/**
 * The property names in a settings file (JSON with comments), in order of appearance: every
 * string that is followed by a colon. Comments and string VALUES are skipped, so a key that is
 * only mentioned in a comment or in a value is not reported. It is a scan, not a parse — a file
 * that is not well-formed yields whatever names can still be recognized. Linear in the text.
 */
function settingsFilePropertyNames(text: string): string[] {
  const names: string[] = [];
  const length = text.length;
  const skipBlank = (from: number): number => {
    let at = from;
    for (;;) {
      while (at < length && /\s/.test(text[at])) {
        at++;
      }
      if (text[at] === '/' && text[at + 1] === '/') {
        const end = text.indexOf('\n', at);
        at = end === -1 ? length : end + 1;
      } else if (text[at] === '/' && text[at + 1] === '*') {
        const end = text.indexOf('*/', at + 2);
        at = end === -1 ? length : end + 2;
      } else {
        return at;
      }
    }
  };
  let at = skipBlank(0);
  while (at < length) {
    if (text[at] !== '"') {
      at = skipBlank(at + 1);
      continue;
    }
    let end = at + 1;
    while (end < length && text[end] !== '"') {
      end += text[end] === '\\' ? 2 : 1;
    }
    const body = text.slice(at + 1, Math.min(end, length));
    at = skipBlank(end + 1);
    if (text[at] === ':') {
      try {
        const name: unknown = JSON.parse(`"${body}"`);
        if (typeof name === 'string') {
          names.push(name);
        }
      } catch {
        // not a well-formed string — not a name we could match anyway
      }
    }
  }
  return names;
}

/** Which of this extension's settings a settings FILE names. Absent or unreadable: none. */
function settingsFileKeys(file: string): string[] {
  const read = readTextSafe(file, SETTINGS_FILE_MAX_BYTES);
  if (!read.ok) {
    return [];
  }
  const known = new Set(knownFullKeys());
  return [...new Set(settingsFilePropertyNames(read.text).filter((name) => known.has(name)))];
}

/**
 * Every setting of this extension that is given a value at workspace or folder level — in the
 * workspace's or a folder's `.vscode/settings.json`, or in a `.code-workspace` file — under the
 * current section name or the one before the rename. Those values are never used (see
 * `userSetting`); this is how the user finds out, instead of a setting silently not applying.
 *
 * Looked for in two ways, because neither alone sees everything. The editor is asked
 * (`inspect`): that covers a remote workspace and an editor that still reports such values.
 * And the settings files are read directly: current VS Code removes a machine-scoped setting
 * from what it parsed out of a workspace file, so for those `inspect` reports nothing at all.
 * Only a key that is actually written there is reported — never one that merely has a default.
 * Read-only, bounded, and never throws.
 */
export function workspaceLevelSettings(): WorkspaceLevelSetting[] {
  const found = new Map<string, WorkspaceLevelSetting>();
  const add = (entry: WorkspaceLevelSetting): void => {
    const id = `${entry.where}\u0000${entry.folder ?? ''}\u0000${entry.key}`;
    const earlier = found.get(id);
    if (earlier === undefined) {
      found.set(id, entry);
    } else if (earlier.file === undefined && entry.file !== undefined) {
      earlier.file = entry.file;
    }
  };
  try {
    const folders = (vscode.workspace.workspaceFolders ?? []).slice(0, SETTINGS_FOLDERS_MAX);
    const workspaceFile = vscode.workspace.workspaceFile;
    // A window on ONE folder has no workspace file: that folder's settings ARE the workspace's.
    const multiRoot = workspaceFile !== undefined;
    const sections: [string, readonly string[]][] = [
      [CONFIG_SECTION, SETTING_KEYS],
      [LEGACY_CONFIG_SECTION, LEGACY_SETTING_KEYS],
    ];
    for (const [section, keys] of sections) {
      for (const key of keys) {
        if (inspectSetting(section, key)?.workspaceValue !== undefined) {
          add({ key: `${section}.${key}`, where: 'workspace' });
        }
        if (!multiRoot) {
          continue;
        }
        for (const folder of folders) {
          if (inspectSetting(section, key, folder.uri)?.workspaceFolderValue !== undefined) {
            add({ key: `${section}.${key}`, where: 'folder', folder: folder.name });
          }
        }
      }
    }
    // Only where the extension host can open the file itself: a local path, or a remote one
    // when this host runs on that remote. An unsaved or virtual workspace has no such file.
    const onDisk = (uri: vscode.Uri): boolean => uri.scheme === 'file' || uri.scheme === 'vscode-remote';
    if (workspaceFile !== undefined && onDisk(workspaceFile)) {
      for (const key of settingsFileKeys(workspaceFile.fsPath)) {
        add({ key, where: 'workspace', file: workspaceFile.fsPath });
      }
    }
    for (const folder of folders) {
      if (!onDisk(folder.uri)) {
        continue;
      }
      const file = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
      for (const key of settingsFileKeys(file)) {
        add(multiRoot ? { key, where: 'folder', folder: folder.name, file } : { key, where: 'workspace', file });
      }
    }
  } catch {
    // a notice only — whatever was found before the failure is still worth saying
  }
  return [...found.values()];
}

/* ---- values that widen what a worker may do or spend ---- */

/**
 * The question to put to the user before `value` is stored for `key`, or undefined when
 * storing it widens nothing. Asked for: the permission mode that skips every permission check,
 * either billing guard being switched off, and a `claudePath` other than the default — the
 * program this extension and every dispatch then start.
 */
function wideningQuestion(key: string, value: unknown): { message: string; detail: string; confirm: string } | undefined {
  if (key === 'workerPermissionMode' && value === 'bypassPermissions') {
    return {
      message: vscode.l10n.t('Let every Claude Code worker skip permission checks?'),
      detail: vscode.l10n.t(
        'In bypassPermissions mode a dispatched one-shot worker runs any command and changes any file on this machine without asking, and nobody is watching it. The mode applies to every Claude Code worker account, in every workspace, until you change it.',
      ),
      confirm: vscode.l10n.t('Skip Permission Checks'),
    };
  }
  if (key === 'frontierWorkerDispatch' && value === 'allow') {
    return {
      message: vscode.l10n.t('Allow dispatches to frontier-tier models?'),
      detail: vscode.l10n.t(
        'Frontier-tier models draw on a scarce separate quota or are billed per use, depending on the plan. With this guard off, an unattended dispatch can ask for one and spend that quota or money without asking you. The setting applies to every workspace on this machine until you change it.',
      ),
      confirm: vscode.l10n.t('Allow Frontier Dispatches'),
    };
  }
  if (key === 'overageWorkerDispatch' && value === 'allow') {
    return {
      message: vscode.l10n.t('Allow dispatches that bill past a used-up plan window?'),
      detail: vscode.l10n.t(
        'With this guard off, a worker account that has used up its plan window is still given work when it has extra usage enabled, and those dispatches bill real money against the account\'s monthly cap — without asking you. The setting applies to every workspace on this machine until you change it.',
      ),
      confirm: vscode.l10n.t('Allow Extra-Usage Billing'),
    };
  }
  if (key === 'claudePath' && typeof value === 'string' && value.trim() !== SETTING_DEFAULTS.claudePath) {
    return {
      message: vscode.l10n.t('Run "{0}" as the Claude Code CLI?', sliceOneLine(flattenOneLine(value.trim()), 160)),
      detail: vscode.l10n.t(
        'This extension starts that program itself (to read versions, logins and usage), and every dispatch on this machine runs it with the task and with access to your files. Confirm only a program you trust.',
      ),
      confirm: vscode.l10n.t('Use This Program'),
    };
  }
  return undefined;
}

/**
 * Does storing `value` for `key` need the user's confirmation first? True for a value that
 * widens what an unattended worker may do or spend (`wideningQuestion`) — unless the user's own
 * settings already hold exactly that value, in which case storing it changes nothing.
 */
export function needsWideningConfirmation(key: SettingKey, value: unknown): boolean {
  if (wideningQuestion(key, value) === undefined) {
    return false;
  }
  const stored: unknown = explicitUserSetting(key);
  return !(
    stored === value ||
    (typeof stored === 'string' && typeof value === 'string' && stored.trim() === value.trim())
  );
}

/**
 * The gate in front of every place this extension STORES a setting on somebody's behalf (a
 * page message, a command): true when `value` may be stored for `key`. A value that needs it
 * (`needsWideningConfirmation`) is put to the user in a modal that states the consequence, and
 * only its confirm button answers true — Cancel, Escape and closing the dialog all answer
 * false. A change the user types into the Settings editor is their own act and never comes
 * through here.
 */
export async function confirmWideningSetting(key: SettingKey, value: unknown): Promise<boolean> {
  const question = needsWideningConfirmation(key, value) ? wideningQuestion(key, value) : undefined;
  if (question === undefined) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    question.message,
    { modal: true, detail: question.detail },
    question.confirm,
  );
  return choice === question.confirm;
}
