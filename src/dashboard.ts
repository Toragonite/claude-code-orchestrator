/**
 * The dashboard panel — extension-host side.
 *
 * The page (media/dashboard/dashboard.js + dashboard.css) is a pure renderer of ONE object,
 * `DashboardModel`, and speaks ONE protocol, `HostToWebview` / `WebviewToHost` (src/uiTypes.ts).
 * This file owns everything the page must not be trusted with:
 *
 *  - the document it runs in: a strict Content-Security-Policy with a per-render nonce, one
 *    external stylesheet, one external script, and one inline nonce'd script that assigns the
 *    localized string table and nothing else;
 *  - every inbound message: checked by shape AND by value before it has any effect. The page
 *    names things by opaque keys (task id, session key, account key); this side resolves them,
 *    and an id it cannot resolve does nothing;
 *  - the refresh loop: the model is built only while the panel is visible and posted only when
 *    it differs from the last one posted.
 *
 * The data itself is assembled by `uiModel.ts` / `team.ts`, which do not import `vscode`.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { flattenChars, flattenOneLine, sliceOneLine } from './displayText';
import {
  CONFIG_SECTION,
  confirmWideningSetting,
  needsWideningConfirmation,
  userClaudePath,
  userSetting,
} from './settings';
import {
  claudeVersionAtLeast,
  isAcceptableClaudePath,
  MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
  normalizeModel,
  normalizePermissionMode,
  WORKER_MODELS,
  WORKER_PERMISSION_MODES,
} from './platform';
import { policyState, type PolicyState } from './prompts';
import { allProviders, normalizeProviderModel, parseProvider, providerModelHint } from './providers';
import { isStateWriteRefusal, isTaskFileId, readRegistry, resolveTaskFile, ROOT_DIR } from './registry';
import { readTextSafe, statFileSafe } from './safeFs';
import { collectSessions, invalidateTeamCache, resolveSession } from './team';
import { hasTeamAgent, TEAM_AGENT_FILE } from './teamAgent';
import { buildDashboardModel, probeClaudeVersion, resolveAccount, validateSetting } from './uiModel';
import type {
  DashboardModel,
  HostToWebview,
  UiAccountAction,
  UiCommandId,
  UiGuardSetting,
  UiHealth,
  UiProvider,
  UiSessionAction,
  UiSettingKey,
  UiSettings,
} from './uiTypes';
import { createPageActionLimiter, escapeHtml, jsonForScript, makeNonce } from './webviewUtil';
import { openRegistryFile, registryIsUnreadable } from './workerManager';
// mcpJsonRegistersDispatch: whether a workspace's `.mcp.json` registers the dispatch server — the
// one reading the extension's nag and Update Workspace Setup's item 4 use as well.
import { canDispatchFrom, launcherPresent, mcpJsonRegistersDispatch } from './workspaceSetup';

const VIEW_TYPE = 'ccOrchestratorDashboard';
const COMMAND_PREFIX = 'claudeCodeOrchestrator.';
/** `workspaceState` key the scope switch is remembered under, per workspace. */
const SCOPE_STATE_KEY = 'dashboard.scope';

/**
 * Everything this side posts: the protocol's messages, plus `settingPending` — "the setting you
 * asked to save is waiting for the user's answer in a dialog of the editor". The page then
 * stops expecting a prompt `settingResult` for that key (which would otherwise read as "the
 * editor did not answer") and waits for the real one, however long the dialog stays open.
 */
type HostMessage = HostToWebview | { type: 'settingPending'; key: UiSettingKey };

const REFRESH_MS = 2_000;
/** How often to ask `probeClaudeVersion` again; it caches for ten minutes on its own. */
const VERSION_RECHECK_MS = 60_000;
/** Longest the first model waits for the first version reading (see `whenFirstReading`). */
const FIRST_VERSION_WAIT_MS = 1_200;

/** Read caps for the three workspace files the setup checks look at. */
const MCP_JSON_MAX_BYTES = 1024 * 1024;
const POLICY_FILE_MAX_BYTES = 4 * 1024 * 1024;
const TEAM_AGENT_MAX_BYTES = 256 * 1024;

/**
 * How a message from the page is bounded before it has an effect outside the page (see
 * `createPageActionLimiter`; one limiter per panel, one action per second per lane):
 *
 *  - `terminal`: it opens a terminal. ONE lane for all of them, so a page gets one terminal a
 *    second whatever it asks for and on whichever account or session;
 *  - `modal`: it ends in a modal dialog. One lane, and nothing more is admitted while the
 *    action that opened a dialog is still running;
 *  - `own`: it starts a process or opens other UI. A lane of its own per kind of message, so
 *    two different buttons pressed one after the other do not get in each other's way;
 *  - `null`: none of those — not bounded.
 */
type PageLane = 'terminal' | 'modal' | 'own' | null;

/** Shortest time between two actions of one lane (see PageLane). */
const PAGE_ACTION_INTERVAL_MS = 1_000;

/*
 * The four unions the page may name, as lookup tables. `Record<Union, …>` makes the
 * compiler reject a table that lacks a member, so adding a command to `UiCommandId` without
 * deciding here whether the page may invoke it — and how it is bounded — is a build error,
 * not a silent "ignored".
 */
const SETTING_KEYS: Record<UiSettingKey, true> = {
  workerPermissionMode: true,
  claudePath: true,
  quotaCooldownMinutes: true,
  workerTimeoutMinutes: true,
  frontierWorkerDispatch: true,
  overageWorkerDispatch: true,
  meshMode: true,
  meshMaxLiveWorkers: true,
  meshHistoryLimit: true,
  sessionKeepalive: true,
  providerUsagePolling: true,
};
const COMMAND_IDS: Record<UiCommandId, PageLane> = {
  installMcp: 'own',
  // Each asks before it replaces a block or a definition that differs from this version's.
  addDispatchPolicy: 'modal',
  installTeamAgent: 'modal',
  // Its list stays open for as long as the user looks at it, and its writes follow the answer:
  // nothing else that ends in a question is admitted meanwhile.
  updateWorkspaceSetup: 'modal',
  addWorker: 'own',
  importWorkers: 'own',
  openAssetManager: 'own',
  refreshUsage: 'own',
  clearTasks: 'modal',
  cancelAllTasks: 'modal',
  resetCheckin: 'modal',
  cleanSessionLitter: 'own',
  openSettings: 'own',
};
const SESSION_ACTIONS: Record<UiSessionAction, PageLane> = {
  attach: 'terminal',
  logs: 'terminal',
  stop: 'modal',
  copyName: null,
  // Runs git.
  openDiff: 'own',
};
const ACCOUNT_ACTIONS: Record<UiAccountAction, PageLane> = {
  relogin: 'terminal',
  // One live login probe, a few seconds at most.
  checkLogin: 'own',
  openSession: 'terminal',
  togglePreferred: null,
  // The lane of a `setModel` that carries NO value (the menu's "Other…"): it opens the model
  // picker, which can start the helper that asks the account's CLI for its models. A
  // `setModel` WITH a value — a row of the page's own list — is one registry write and is not
  // bounded at all; the table holds one lane per action, so that distinction is made where
  // the message is handled (`case 'account'`).
  setModel: 'own',
  // A mode that turns a sandbox off is confirmed in a modal.
  setPermissionMode: 'modal',
  remove: 'modal',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Is `value` one of the keys of `table`? An OWN-key test, so `toString` is not a setting. */
function isMember<T extends string>(table: Record<T, unknown>, value: unknown): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);
}

/** One display-safe line from anything (an Error, a string from a file, a page message). */
function safeLine(value: unknown, max: number): string {
  const text = value instanceof Error ? value.message : value;
  return sliceOneLine(flattenOneLine(text), max);
}

/* ------------------------------------------------------------------------- *
 * Output channel
 * ------------------------------------------------------------------------- */

let logSink: ((line: string) => void) | undefined;
let ownChannel: vscode.OutputChannel | undefined;

/**
 * Route the dashboard's diagnostics into the extension's own output channel. Optional: when
 * nobody calls this, the first diagnostic lazily creates a channel instead, so a message the
 * page should never have sent is recorded either way.
 */
export function setDashboardLog(sink: (line: string) => void): void {
  logSink = sink;
}

/**
 * Settings the dispatch SERVER acts on. It reads them from the shared registry, where the
 * extension copies them after every change — so for these, a write to the editor's settings is
 * only half of "saved". `sessionKeepalive` is the one setting the editor alone reads.
 * `Record<UiSettingKey, boolean>` so that a new key cannot be added without deciding this.
 */
const REGISTRY_SETTING: Record<UiSettingKey, boolean> = {
  workerPermissionMode: true,
  claudePath: true,
  quotaCooldownMinutes: true,
  workerTimeoutMinutes: true,
  frontierWorkerDispatch: true,
  overageWorkerDispatch: true,
  meshMode: true,
  meshMaxLiveWorkers: true,
  meshHistoryLimit: true,
  sessionKeepalive: false,
  providerUsagePolling: true,
};

/** Room for the registry lock's own message, which names a file and a process and says what to do. */
const SETTINGS_SYNC_ERROR_MAX = 600;

let settingsSync: (() => string | undefined) | undefined;

/**
 * Give the dashboard the extension's "copy the settings into the shared registry" step: a
 * function that does it (or knows it was just refused) and returns undefined when the registry
 * holds the settings, else why it does not — for a registry whose lock stayed held, the lock's
 * own message. It must not throw. Optional: without it a setting is reported saved once the
 * editor has stored it, as before.
 *
 * Why the dashboard asks at all: "Saved" on a control must mean dispatch will use the value.
 * The registry is written under a lock that can refuse, and a setting the server cannot see
 * yet is not in effect, whatever settings.json says.
 */
export function setDashboardSettingsSync(sync: () => string | undefined): void {
  settingsSync = sync;
}

function log(context: vscode.ExtensionContext, line: string): void {
  const stamped = `[dashboard] ${line}`;
  if (logSink) {
    logSink(stamped);
    return;
  }
  if (!ownChannel) {
    ownChannel = vscode.window.createOutputChannel('Claude Code Orchestrator');
    context.subscriptions.push(ownChannel);
  }
  ownChannel.appendLine(stamped);
}

/* ------------------------------------------------------------------------- *
 * Settings and health — the two model inputs this file assembles
 * ------------------------------------------------------------------------- */

/**
 * A whole-number setting as it is in effect: the USER's value (`userSetting` — never a
 * workspace's, and a value that is not a finite number reads as the default), rounded and
 * clamped to the range the dispatch side enforces. The page must show what will actually be
 * used.
 */
function intSetting(
  key: 'quotaCooldownMinutes' | 'workerTimeoutMinutes' | 'meshMaxLiveWorkers' | 'meshHistoryLimit',
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, Math.round(userSetting(key))));
}

/**
 * A billing guard as three facts: what THIS editor is set to, what the shared registry
 * enforces, and — only when they differ — which editor set the enforced value. Several
 * editors share one registry file, so "my dropdown says block" and "dispatch is blocked" are
 * different statements and the page shows both.
 */
function guardSetting(own: unknown, enforced: unknown, setBy: unknown): UiGuardSetting {
  const value = own === 'allow' ? 'allow' : 'block';
  const effective = enforced === undefined ? value : enforced === 'allow' ? 'allow' : 'block';
  const by = effective !== value && typeof setBy === 'string' ? sliceOneLine(flattenOneLine(setBy), 64) : '';
  return { value, effective, setBy: by === '' ? null : by };
}

/**
 * Every CLI a worker can run on, as the page's pickers need it. The facts are `providers.ts`'s
 * own; this only copies them into the wire shape, so a provider added there appears in the
 * card menus and in the drawer's list with no change here or in the page.
 */
function readProviders(): UiProvider[] {
  return allProviders().map((info) => ({
    id: info.id,
    label: sliceOneLine(flattenOneLine(info.label), 32),
    models: [...info.suggestedModels],
    permissionModes: [...info.permissionModes],
    isolation: info.isolation,
    isolationVerified: info.isolationVerified,
    sessionWorkers: info.sessionWorkers,
  }));
}

function readSettings(): UiSettings {
  // Every value is the user's own setting (`userSetting`): the page shows, and edits, what
  // this extension acts on, and a workspace's settings file is no part of that.
  // The dispatch server enforces the SHARED registry's guards, which another editor may have
  // set. A read failure degrades to "in effect = this editor's value", never to a throw.
  let registry: { frontierWorkerDispatch?: unknown; frontierGuardSetBy?: unknown; overageWorkerDispatch?: unknown; overageGuardSetBy?: unknown } | undefined;
  try {
    registry = readRegistry();
  } catch {
    registry = undefined;
  }
  return {
    workerPermissionMode: normalizePermissionMode(userSetting('workerPermissionMode')),
    permissionModes: [...WORKER_PERMISSION_MODES],
    // The value as the user stored it, so that one this extension does not use (see
    // `userClaudePath`) can be seen and corrected in its box.
    // flattenChars, not flattenOneLine: a path is shown in an editable box, so its own
    // whitespace must survive — only invisible, bidi and control characters are removed.
    claudePath: sliceOneLine(flattenChars(userSetting('claudePath')), 1024),
    quotaCooldownMinutes: intSetting('quotaCooldownMinutes', 1, 1440),
    workerTimeoutMinutes: intSetting('workerTimeoutMinutes', 1, 480),
    frontierWorkerDispatch: guardSetting(userSetting('frontierWorkerDispatch'), registry?.frontierWorkerDispatch, registry?.frontierGuardSetBy),
    overageWorkerDispatch: guardSetting(userSetting('overageWorkerDispatch'), registry?.overageWorkerDispatch, registry?.overageGuardSetBy),
    meshMode: userSetting('meshMode') === true,
    meshMaxLiveWorkers: intSetting('meshMaxLiveWorkers', 1, 64),
    meshHistoryLimit: intSetting('meshHistoryLimit', 1, 1000),
    sessionKeepalive: userSetting('sessionKeepalive') === true,
    workerModels: [...WORKER_MODELS],
    // On unless it was turned off: the contributed default is true, and a hand-edited value
    // that is not a boolean must not silently stop the readings.
    providerUsagePolling: userSetting('providerUsagePolling') !== false,
    providers: readProviders(),
  };
}

/** What a setting is right now, as the plain value its control holds. */
function effectiveSetting(key: UiSettingKey): string | number | boolean {
  const value = readSettings()[key];
  return typeof value === 'object' ? value.value : value;
}

/** The `claude` executable dispatch actually runs: the registry's resolved path. */
function dispatchClaudePath(): string {
  try {
    const fromRegistry: unknown = readRegistry().claudePath;
    if (typeof fromRegistry === 'string' && fromRegistry.trim() !== '') {
      return fromRegistry;
    }
  } catch {
    /* fall through to the setting */
  }
  return userClaudePath();
}

/**
 * "What does this workspace file hold of X?", answered from a cache keyed by (size, mtime) so
 * the 2-second refresh costs three `stat` calls, not three reads. A file that is absent, not a
 * regular file, over its cap or unreadable answers `otherwise` — "nothing of it": the setup
 * step is offered again, which is the safe direction.
 */
const fileChecks = new Map<string, { size: number; mtimeMs: number; answer: unknown }>();

function fileAnswer<T>(file: string, maxBytes: number, test: (text: string) => T, otherwise: T): T {
  const stat = statFileSafe(file);
  if (!stat) {
    fileChecks.delete(file);
    return otherwise;
  }
  const cached = fileChecks.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.answer as T;
  }
  const read = readTextSafe(file, maxBytes);
  let answer = otherwise;
  if (read.ok) {
    try {
      answer = test(read.text);
    } catch {
      answer = otherwise;
    }
  }
  // Only this window's three files are ever asked about; the bound is a backstop against a
  // session that walks through many workspace folders.
  if (fileChecks.size > 64) {
    fileChecks.clear();
  }
  fileChecks.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, answer });
  return answer;
}

/** "Does this workspace file contain X?" — `fileAnswer` for a yes / no question. */
function fileSays(file: string, maxBytes: number, test: (text: string) => boolean): boolean {
  return fileAnswer(file, maxBytes, (text) => test(text) === true, false);
}

function readHealth(root: string | undefined, claudeVersion: string | null): UiHealth {
  // One read of CLAUDE.md answers both policy questions: is a block there, and is it this
  // version's text (prompts.policyState). A block that differs is an earlier version's or an
  // edited one — the two cannot be told apart, and the page says exactly that.
  const policy: PolicyState | undefined =
    root === undefined ? undefined : fileAnswer(path.join(root, 'CLAUDE.md'), POLICY_FILE_MAX_BYTES, policyState, 'absent');
  // The registration is read by THE one rule (workspaceSetup.mcpJsonRegistersDispatch: either
  // name, value a JSON object) that "can dispatch" in the extension and item 4 of Update
  // Workspace Setup use too — the chip must not say "cannot dispatch" where the list says
  // "present", nor the reverse.
  const mcpInstalled =
    root === undefined ? null : fileSays(path.join(root, '.mcp.json'), MCP_JSON_MAX_BYTES, mcpJsonRegistersDispatch);
  return {
    claudeVersion,
    // A version that could not be read proves nothing either way: unknown, not "unsupported".
    sessionWorkersSupported: claudeVersion === null ? null : claudeVersionAtLeast(claudeVersion, MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS),
    sessionWorkersMinVersion: MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS,
    // Set by buildDashboardModel when the task log cannot be read.
    taskLogProblem: null,
    // Set by buildDashboardModel from the checked read of the registry.
    registryProblem: null,
    mcpInstalled,
    // "This folder can dispatch" (§15.7): the cco launcher (one stat a refresh) and this
    // version's policy block, or the MCP registration. The chip that offers a fix is shown
    // only when this is false.
    canDispatch:
      root === undefined
        ? null
        : canDispatchFrom({ launcherPresent: launcherPresent(ROOT_DIR), policy, mcpRegistered: mcpInstalled === true }),
    // Where cco does not run in this version, the MCP server is the way to dispatch.
    dispatchFix: process.platform === 'win32' ? 'installMcp' : 'updateWorkspaceSetup',
    policyInstalled: policy === undefined ? null : policy !== 'absent',
    policyOutdated: policy === undefined || policy === 'absent' ? null : policy === 'differs',
    teamAgentInstalled: root === undefined ? null : fileSays(path.join(root, ...TEAM_AGENT_FILE.split('/')), TEAM_AGENT_MAX_BYTES, hasTeamAgent),
  };
}

/* ------------------------------------------------------------------------- *
 * The panel
 * ------------------------------------------------------------------------- */

/** The one live panel. A second "open" reveals it instead of starting a second refresh loop. */
let current: vscode.WebviewPanel | undefined;

export function openDashboard(context: vscode.ExtensionContext): void {
  if (current) {
    current.reveal();
    return;
  }

  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard');
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, vscode.l10n.t('Orchestrator Dashboard'), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaRoot],
  });
  current = panel;

  let disposed = false;
  /** The page has booted and asked for data; nothing is posted before that. */
  let ready = false;
  let scope: 'workspace' | 'all' = context.workspaceState.get<unknown>(SCOPE_STATE_KEY) === 'all' ? 'all' : 'workspace';
  /** JSON of the last model posted, `generatedAt` excluded: the change detector. */
  let lastSignature = '';
  /** Task ids the page has been shown — the only ids it may name back. */
  let shownTaskIds = new Set<string>();
  /**
   * From the model LAST BUILT: which CLI each account runs on, and which permission modes
   * each CLI offers. An account action that carries a value (a model, a permission mode) is
   * checked against these — the value has to be a choice that model could have offered for
   * that account, not merely a well-formed string.
   */
  let builtAccountProviders = new Map<string, string>();
  let builtPermissionModes = new Map<string, readonly string[]>();
  let lastBuildFailure = '';
  const loggedOnce = new Set<string>();

  let claudeVersion: string | null = null;
  let versionAskedFor: string | undefined;
  let versionAskedAt = 0;
  let versionInFlight: Promise<void> | undefined;

  const workspaceRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const post = (message: HostMessage): Thenable<boolean> => panel.webview.postMessage(message);

  const notice = (level: 'info' | 'warning' | 'error', text: string): void => {
    if (!disposed) {
      void post({ type: 'notice', level, text: sliceOneLine(flattenOneLine(text), 400) });
    }
  };

  /** Record something the page should never have sent — once per distinct thing. */
  const logOnce = (what: string, detail: unknown): void => {
    let shown: string;
    try {
      shown = typeof detail === 'string' ? detail : (JSON.stringify(detail) ?? typeof detail);
    } catch {
      // A structured-clone value JSON cannot express (a BigInt, a cycle): its type will do.
      shown = typeof detail;
    }
    const line = `ignored ${what}: ${safeLine(shown, 120)}`;
    if (loggedOnce.has(line) || loggedOnce.size >= 64) {
      return;
    }
    loggedOnce.add(line);
    log(context, line);
  };

  /**
   * Keep `claudeVersion` current without ever blocking a refresh on a child process. The
   * reading belongs to the path it was asked for: a result that arrives after the path
   * changed is dropped rather than shown against the new path.
   */
  const refreshVersion = (): Promise<void> => {
    const claudePath = dispatchClaudePath();
    if (versionAskedFor === claudePath) {
      if (versionInFlight) {
        return versionInFlight;
      }
      if (Date.now() - versionAskedAt < VERSION_RECHECK_MS) {
        return Promise.resolve();
      }
    }
    versionAskedFor = claudePath;
    versionAskedAt = Date.now();
    // Called inside a promise executor so that even a synchronous throw from the probe
    // becomes "no reading" instead of escaping into the refresh that asked for it.
    const asked: Promise<void> = new Promise<string | null>((resolve) => resolve(probeClaudeVersion(claudePath)))
      .then(
        (value) => value,
        () => null,
      )
      .then((value) => {
        if (versionInFlight === asked) {
          versionInFlight = undefined;
        }
        if (disposed || versionAskedFor !== claudePath) {
          return;
        }
        const next = typeof value === 'string' ? sliceOneLine(flattenOneLine(value), 40) : '';
        const reading = next === '' ? null : next;
        if (reading !== claudeVersion) {
          claudeVersion = reading;
          refresh();
        }
      });
    versionInFlight = asked;
    return asked;
  };

  /** Record what `builtAccountProviders` / `builtPermissionModes` describe. Never throws. */
  const rememberBuilt = (model: DashboardModel): void => {
    const accounts = new Map<string, string>();
    const accountList: unknown = model.accounts;
    for (const account of Array.isArray(accountList) ? accountList : []) {
      if (isRecord(account) && typeof account.key === 'string' && typeof account.provider === 'string') {
        accounts.set(account.key, account.provider);
      }
    }
    const modes = new Map<string, readonly string[]>();
    const providerList: unknown = isRecord(model.settings) ? model.settings.providers : undefined;
    for (const provider of Array.isArray(providerList) ? providerList : []) {
      // First entry wins, as it does on the page: a repeated id cannot widen what is accepted.
      if (isRecord(provider) && typeof provider.id === 'string' && !modes.has(provider.id)) {
        const offered: unknown = provider.permissionModes;
        modes.set(provider.id, Array.isArray(offered) ? offered.filter((mode): mode is string => typeof mode === 'string') : []);
      }
    }
    builtAccountProviders = accounts;
    builtPermissionModes = modes;
  };

  const buildModel = (): DashboardModel => {
    const root = workspaceRoot();
    return buildDashboardModel({
      workspaceRoot: root,
      scope,
      settings: readSettings(),
      health: readHealth(root, claudeVersion),
      sessions: collectSessions({ workspaceRoot: root, scope }),
    });
  };

  /**
   * Build the model and post it IF it changed. Does nothing while the panel is hidden: the
   * page keeps its last state (`retainContextWhenHidden`) and gets a fresh model the moment
   * it is shown again.
   */
  function refresh(force = false): void {
    if (disposed || !ready || !panel.visible) {
      return;
    }
    void refreshVersion();
    let model: DashboardModel;
    try {
      model = buildModel();
    } catch (err) {
      // The builders are written never to throw; if one does, say so once per distinct
      // failure instead of once per tick, and keep the page on its last good model.
      const text = safeLine(err, 200);
      if (text !== lastBuildFailure) {
        lastBuildFailure = text;
        log(context, `model build failed: ${text}`);
        notice('error', vscode.l10n.t('The dashboard data could not be built: {0}', text));
      }
      return;
    }
    lastBuildFailure = '';
    rememberBuilt(model);
    const signature = JSON.stringify({ ...model, generatedAt: 0 });
    if (!force && signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    shownTaskIds = new Set(model.tasks.map((task) => task.id));
    void post({ type: 'model', model }).then(
      (delivered) => {
        if (!delivered) {
          lastSignature = '';
        }
      },
      () => {
        lastSignature = '';
      },
    );
  }

  /**
   * The first model waits briefly for the first `claude --version` reading. Without that, a
   * healthy install would open with a "CLI not found" chip that vanishes a moment later —
   * `claudeVersion: null` cannot tell "not asked yet" from "asked and failed".
   */
  const whenFirstReading = (): Promise<void> =>
    Promise.race([refreshVersion(), new Promise<void>((resolve) => setTimeout(resolve, FIRST_VERSION_WAIT_MS))]);

  const run = (command: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(command, ...args);

  const limiter = createPageActionLimiter({
    intervalMs: PAGE_ACTION_INTERVAL_MS,
    onBurst: () =>
      notice(
        'warning',
        vscode.l10n.t('The dashboard asked for several actions at once. Only the first was carried out — wait a moment, then try again.'),
      ),
  });

  /**
   * Carry out `action` when the page may have one more of its kind now (see PageLane); a
   * message that arrives too soon is dropped, and the page is told once per burst. `own` is the
   * lane's name for a message kind that has a lane of its own.
   */
  const bounded = async (lane: PageLane, own: string, action: () => Thenable<unknown>): Promise<void> => {
    if (lane === null) {
      await action();
      return;
    }
    const finished = limiter.admit(lane === 'own' ? own : lane, lane === 'modal');
    if (finished === undefined) {
      return;
    }
    try {
      await action();
    } finally {
      finished();
    }
  };

  const answerSetting = (key: UiSettingKey, ok: boolean, error: string | null): void => {
    void post({ type: 'settingResult', key, ok, value: effectiveSetting(key), error });
  };

  /**
   * Store one validated setting for the user and answer the page. Called only after the value
   * was confirmed where it needed to be.
   */
  const storeSetting = async (key: UiSettingKey, value: string | number | boolean): Promise<void> => {
    try {
      // Global, always: a dispatch setting belongs to the machine's accounts, not to one
      // folder — and only the user's own value is ever read back (`userSetting`).
      await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
    } catch (err) {
      answerSetting(key, false, safeLine(err, 200));
      return;
    }
    // Stored in the editor. For a setting the dispatch server reads, the registry has to
    // take it too, and that write can be refused (the registry's lock stayed held). Then
    // the control must not say "Saved": the answer is the refusal, in the lock's own words,
    // and the model's "in effect" keeps showing what dispatch really uses. The editor's
    // setting is not rolled back — the extension writes the registry again at its next
    // settings change or usage refresh, and the value is then in effect.
    if (REGISTRY_SETTING[key] && settingsSync !== undefined) {
      let problem: string | undefined;
      try {
        problem = settingsSync();
      } catch (err) {
        problem = safeLine(err, SETTINGS_SYNC_ERROR_MAX);
      }
      if (problem !== undefined) {
        answerSetting(
          key,
          false,
          // Shown after the page's own "Not saved: ".
          vscode.l10n.t(
            'the shared registry could not be written, so dispatch keeps the previous value. {0}',
            safeLine(problem, SETTINGS_SYNC_ERROR_MAX),
          ),
        );
        return;
      }
    }
    answerSetting(key, true, null);
  };

  async function handle(raw: unknown): Promise<void> {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      logOnce('message without a type', raw);
      return;
    }
    switch (raw.type) {
      case 'ready': {
        // Also sent again if the page is ever reloaded inside the same panel: every `ready`
        // gets a full model, whatever was posted before.
        ready = true;
        lastSignature = '';
        await whenFirstReading();
        refresh(true);
        return;
      }

      case 'setScope': {
        if (raw.scope !== 'workspace' && raw.scope !== 'all') {
          logOnce('scope', raw.scope);
          return;
        }
        scope = raw.scope;
        await context.workspaceState.update(SCOPE_STATE_KEY, scope);
        return;
      }

      case 'setSetting': {
        if (!isMember(SETTING_KEYS, raw.key)) {
          logOnce('setting key', raw.key);
          return;
        }
        const checked = validateSetting(raw.key, raw.value);
        if (!checked.ok) {
          answerSetting(raw.key, false, safeLine(checked.error, 200));
          return;
        }
        const key = checked.key;
        const value = checked.value;
        if (key === 'claudePath' && !isAcceptableClaudePath(value)) {
          // The same rule the extension reads the setting by: a value it would not use is not
          // stored as if it had been accepted.
          answerSetting(
            key,
            false,
            // Shown after the page's own "Not saved: ".
            vscode.l10n.t('the Claude path must be a command name such as "claude" or an absolute path.'),
          );
          return;
        }
        if (!needsWideningConfirmation(key, value)) {
          await storeSetting(key, value);
          return;
        }
        // A value that widens what a worker may do or spend is stored only on the user's own
        // confirmation, in a modal on this side: a message from the page is not that. Through
        // the limiter, so the page cannot stack dialogs either.
        let asked = false;
        await bounded('modal', '', async () => {
          asked = true;
          // The dialog may stay open for as long as the user likes. The page is told that the
          // answer is theirs to give, so the control does not report a host that went silent;
          // whatever happens next, exactly one `settingResult` follows.
          void post({ type: 'settingPending', key });
          let confirmed = false;
          try {
            confirmed = await confirmWideningSetting(key, value);
          } catch (err) {
            // The dialog could not be shown: nothing was confirmed, so nothing is stored.
            answerSetting(key, false, safeLine(err, 200));
            return;
          }
          if (confirmed) {
            await storeSetting(key, value);
          } else {
            answerSetting(
              key,
              false,
              // Shown after the page's own "Not saved: ".
              vscode.l10n.t('the change was not confirmed, so the previous value stays in effect.'),
            );
          }
        });
        if (!asked) {
          // Dropped by the limiter: the control still has to go back to the value in effect.
          answerSetting(
            key,
            false,
            // Shown after the page's own "Not saved: ".
            vscode.l10n.t('too many confirmations were asked for at once — wait a moment, then try again.'),
          );
        }
        return;
      }

      case 'command': {
        if (!isMember(COMMAND_IDS, raw.id)) {
          logOnce('command', raw.id);
          return;
        }
        const id = raw.id;
        await bounded(COMMAND_IDS[id], `command:${id}`, () =>
          id === 'openSettings'
            ? run('workbench.action.openSettings', `@ext:${context.extension.id}`)
            : run(COMMAND_PREFIX + id),
        );
        return;
      }

      case 'openTask': {
        if (typeof raw.id !== 'string' || !shownTaskIds.has(raw.id)) {
          logOnce('task id (open)', raw.id);
          return;
        }
        // The page sends an id, never a path: the file is the report that id names in the
        // tasks directory (`resolveTaskFile` — a regular file there, never a link), found on
        // this side. No path from the page or from the task log is opened.
        const file = isTaskFileId(raw.id) ? resolveTaskFile(raw.id, 'output') : undefined;
        if (file === undefined) {
          notice('warning', vscode.l10n.t('The output of that task is no longer available.'));
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return;
      }

      case 'openRegistryFile': {
        // The message carries nothing: WHICH file is this side's knowledge (the registry this
        // extension reads), and it is opened only while that file is the problem the page was
        // shown. Otherwise the refresh that follows every message takes the notice away.
        if (!registryIsUnreadable()) {
          return;
        }
        await bounded('own', 'openRegistryFile', async () => {
          openRegistryFile();
        });
        return;
      }

      case 'cancelTask': {
        if (typeof raw.id !== 'string' || !shownTaskIds.has(raw.id)) {
          logOnce('task id (cancel)', raw.id);
          return;
        }
        const id = raw.id;
        // Stops a worker process: bounded like every message that starts or ends one.
        await bounded('own', 'cancelTask', () => run(`${COMMAND_PREFIX}cancelTask`, { id }));
        // A cancelled session task changes the Team lanes too; do not wait out the session cache.
        invalidateTeamCache();
        return;
      }

      case 'session': {
        if (!isMember(SESSION_ACTIONS, raw.action)) {
          logOnce('session action', raw.action);
          return;
        }
        if (typeof raw.key !== 'string' || resolveSession(raw.key) === undefined) {
          logOnce('session key', raw.key);
          return;
        }
        const action = raw.action;
        const key = raw.key;
        await bounded(SESSION_ACTIONS[action], `session:${action}`, () =>
          run(`${COMMAND_PREFIX}sessionAction`, { action, key }),
        );
        // So the refresh that follows this message shows the result of a stop at once,
        // rather than the session list cached a moment before it.
        invalidateTeamCache();
        return;
      }

      case 'account': {
        if (!isMember(ACCOUNT_ACTIONS, raw.action)) {
          logOnce('account action', raw.action);
          return;
        }
        if (typeof raw.account !== 'string' || resolveAccount(raw.account) === undefined) {
          logOnce('account key', raw.account);
          return;
        }
        const accountAction = `${COMMAND_PREFIX}accountAction`;
        if (raw.action === 'setModel') {
          // No value at all is the menu's "Other…": the command asks for the model itself, in
          // a picker that may start a process — so it is bounded, on a lane of its own. Every
          // branch below carries a value and is a write the page may make as often as it likes.
          if (raw.value === undefined) {
            const account = raw.account;
            await bounded(ACCOUNT_ACTIONS.setModel, 'account:setModel', () =>
              run(accountAction, { action: 'setModel', account }),
            );
            return;
          }
          // A value is judged for the CLI this account runs on, as the last model named it.
          const provider = parseProvider(builtAccountProviders.get(raw.account));
          if (provider === undefined) {
            logOnce('account for a model choice (not in the last model)', raw.account);
            return;
          }
          // `null` is "let the CLI choose". A Claude Code worker always has a default model,
          // so there it is one more value that is not a model.
          if (raw.value === null && provider !== 'claude') {
            await run(accountAction, { action: raw.action, account: raw.account, value: null });
            return;
          }
          // An explicitly chosen model that does not normalize is an error to show, never a
          // silent fall-back to some other model. A Claude Code model is taken exactly, as the
          // picker takes it: a full id chosen here is that model (it is stored pinned).
          const model = provider === 'claude' ? normalizeModel(raw.value, { exact: true }) : normalizeProviderModel(provider, raw.value);
          if (model === undefined) {
            notice('error', vscode.l10n.t('That is not a model name this extension accepts. Use {0}.', providerModelHint(provider)));
            return;
          }
          await run(accountAction, { action: raw.action, account: raw.account, value: model });
          return;
        }
        if (raw.action === 'setPermissionMode') {
          // `null` is "the default of that CLI". A string must be one of the modes the last
          // model offered for THIS account's CLI: `plan` is a mode of two CLIs and means
          // something different in each, so membership is checked per provider, never against
          // the union. Anything else is not a choice the page could have shown.
          const providerId = builtAccountProviders.get(raw.account);
          if (providerId === undefined) {
            logOnce('account for a permission mode (not in the last model)', raw.account);
            return;
          }
          const value: unknown = raw.value;
          const offered = builtPermissionModes.get(providerId);
          if (value !== null && !(typeof value === 'string' && offered !== undefined && offered.includes(value))) {
            logOnce('permission mode', value);
            return;
          }
          const account = raw.account;
          await bounded(ACCOUNT_ACTIONS.setPermissionMode, '', () =>
            run(accountAction, { action: 'setPermissionMode', account, value }),
          );
          return;
        }
        const action = raw.action;
        const account = raw.account;
        await bounded(ACCOUNT_ACTIONS[action], `account:${action}`, () => run(accountAction, { action, account }));
        return;
      }

      default:
        logOnce('message type', raw.type);
    }
  }

  const subscriptions: vscode.Disposable[] = [
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // One wrapper for every path: a throw anywhere below (a command that is not registered,
      // a settings write that fails, a document that will not open) becomes a notice on the
      // page, and the page is brought up to date either way.
      handle(raw)
        .catch((err: unknown) => {
          if (isStateWriteRefusal(err)) {
            // The registry refused a write: said in its own words, which name the file (and
            // the process holding its lock) and say that nothing was changed.
            notice('warning', safeLine(err, SETTINGS_SYNC_ERROR_MAX));
            return;
          }
          const text = safeLine(err, 200);
          log(context, `message handler failed: ${text}`);
          notice('error', vscode.l10n.t('The dashboard could not complete that action: {0}', text));
        })
        .then(() => refresh());
    }),
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
  ];
  const timer = setInterval(() => refresh(), REFRESH_MS);

  panel.onDidDispose(() => {
    disposed = true;
    clearInterval(timer);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    if (current === panel) {
      current = undefined;
    }
  });

  panel.webview.html = dashboardHtml({
    cspSource: panel.webview.cspSource,
    nonce: makeNonce(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css')).toString(),
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.js')).toString(),
    language: vscode.env.language,
    strings: dashboardStrings(),
  });
  // Start the version reading now so it has usually arrived by the time the page is ready.
  void refreshVersion();
}

/* ------------------------------------------------------------------------- *
 * The document
 * ------------------------------------------------------------------------- */

export interface DashboardHtmlParts {
  /** `webview.cspSource` — the only origin the page may load style, script and images from. */
  cspSource: string;
  nonce: string;
  styleUri: string;
  scriptUri: string;
  /** UI language tag (`vscode.env.language`); the page formats numbers and dates with it. */
  language: string;
  strings: DashboardStrings;
}

/**
 * Pure: same parts in, same document out. The body is an empty mount point — the page script
 * builds everything — plus a one-line placeholder for the instant before the script runs.
 *
 * The policy allows exactly: the stylesheet and images from the extension's own resource
 * origin, and script carrying this render's nonce. No inline style, no inline handler and no
 * network: a string that reaches the page can only ever be text.
 */
export function dashboardHtml(parts: DashboardHtmlParts): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${parts.cspSource} data:`,
    `style-src ${parts.cspSource}`,
    `script-src 'nonce-${parts.nonce}'`,
    `font-src ${parts.cspSource}`,
  ].join('; ');
  const language = /^[A-Za-z0-9-]{1,35}$/.test(parts.language) ? parts.language : 'en';
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(parts.strings.panelTitle)}</title>
<link rel="stylesheet" href="${escapeHtml(parts.styleUri)}">
</head>
<body>
<div id="app" aria-busy="true"><p class="boot">${escapeHtml(parts.strings.loading)}</p></div>
<script nonce="${parts.nonce}">window.__CCO_STRINGS__ = ${jsonForScript(parts.strings)};</script>
<script nonce="${parts.nonce}" src="${escapeHtml(parts.scriptUri)}"></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------------- *
 * Localized string table
 * ------------------------------------------------------------------------- */

export type DashboardStrings = ReturnType<typeof dashboardStrings>;

/**
 * Every piece of text the page shows. The page script holds no English of its own: it looks
 * keys up in this table and fills `{0}`-style placeholders, so one `vscode.l10n.t` literal
 * here is the single place a string is written and translated. Must run in the extension
 * host. Each call is spelled `vscode.l10n.t('literal')` in full — never through an alias —
 * because that exact shape is what the l10n bundle extraction looks for.
 *
 * Counts are written "label: {0}" / "{0} label" on purpose — no string depends on singular
 * vs plural, which do not translate one-to-one.
 */
export function dashboardStrings() {
  return {
    /* general */
    panelTitle: vscode.l10n.t('Orchestrator Dashboard'),
    appName: vscode.l10n.t('Claude Code Orchestrator'),
    loading: vscode.l10n.t('Loading the dashboard…'),
    loadingLate: vscode.l10n.t('Still waiting for data from the extension. If nothing appears, close this tab and open the dashboard again.'),
    schemaTitle: vscode.l10n.t('This dashboard is out of date'),
    schemaBody: vscode.l10n.t('The extension sent data this page cannot read. Run "Developer: Reload Window" to load the matching version.'),
    sep: ' · ',
    nameSep: ', ',
    pct: vscode.l10n.t('{0}%'),
    on: vscode.l10n.t('On'),
    off: vscode.l10n.t('Off'),
    today: vscode.l10n.t('Today'),
    dateTime: vscode.l10n.t('{0}, {1}'),
    justNow: vscode.l10n.t('just now'),
    ago: vscode.l10n.t('{0} ago'),
    unitS: vscode.l10n.t('{0}s'),
    unitM: vscode.l10n.t('{0}m'),
    unitH: vscode.l10n.t('{0}h'),
    unitD: vscode.l10n.t('{0}d'),
    unitMS: vscode.l10n.t('{0}m {1}s'),
    unitHM: vscode.l10n.t('{0}h {1}m'),
    unitDH: vscode.l10n.t('{0}d {1}h'),
    versionUnknown: vscode.l10n.t('an unreadable version'),
    showAllWorkspaces: vscode.l10n.t('Show all workspaces'),
    otherWorkspace: vscode.l10n.t('other workspace'),
    otherWorkspaceTip: vscode.l10n.t('This belongs to a different workspace folder.'),
    unmerged: vscode.l10n.t('unmerged'),
    unmergedTip: vscode.l10n.t('The worktree holding this work still exists. Merge or discard its branch to clear it.'),
    noticesLabel: vscode.l10n.t('Notifications'),
    noticeDismiss: vscode.l10n.t('Dismiss'),

    /* providers: the CLI an account or a task runs on */
    provHome: vscode.l10n.t('Claude Code'),
    provRunsOn: vscode.l10n.t('Runs on {0}'),
    provLegendLabel: vscode.l10n.t('Accounts by CLI'),

    /* header */
    noWorkspaceName: vscode.l10n.t('No folder open'),
    scopeLabel: vscode.l10n.t('Which workspaces to show'),
    scopeWorkspace: vscode.l10n.t('This workspace'),
    scopeAll: vscode.l10n.t('All workspaces'),
    scopeWorkspaceTip: vscode.l10n.t('Show the sessions and tasks of the folder open in this window.'),
    scopeAllTip: vscode.l10n.t('Show the sessions and tasks of every workspace on this machine.'),
    scopeNoteWorkspace: vscode.l10n.t('this workspace'),
    scopeNoteAll: vscode.l10n.t('all workspaces'),
    scopeNoteMachine: vscode.l10n.t('this machine'),
    refreshUsage: vscode.l10n.t('Refresh usage'),
    refreshingUsage: vscode.l10n.t('Refreshing…'),
    refreshUsageTip: vscode.l10n.t('Ask every account for its current plan usage now.'),
    settings: vscode.l10n.t('Settings'),
    orchNone: vscode.l10n.t('Orchestrator not checked in'),
    orchNoneTip: vscode.l10n.t('No Claude Code session in this workspace has asked for its briefing yet.'),
    orchPending: vscode.l10n.t('Orchestrator seen, briefing pending'),
    orchPendingTip: vscode.l10n.t('A session connected but has not reported its model yet.'),
    orchModel: vscode.l10n.t('Orchestrator {0}'),
    orchModelTip: vscode.l10n.t('The model of the Claude Code session that dispatches from this workspace.'),
    orchCalibrated: vscode.l10n.t('Calibration brief active'),
    orchCalibratedTip: vscode.l10n.t('This model received the operating brief that calibrates it for orchestration.'),
    orchFrontier: vscode.l10n.t('Frontier tier'),
    orchFrontierTip: vscode.l10n.t('Frontier-tier models run without the calibration brief.'),
    orchBriefed: vscode.l10n.t('briefed {0}'),
    orchSeen: vscode.l10n.t('seen {0}'),
    runningHere: vscode.l10n.t('Running here: {0}'),
    runningAll: vscode.l10n.t('Running on this machine: {0}'),
    runningHereAndElsewhere: vscode.l10n.t('Running here: {0} · in other workspaces: {1}'),

    /* health chips and page banners */
    healthLabel: vscode.l10n.t('Things that need attention'),
    chipExpired: vscode.l10n.t('Login expired: {0}'),
    chipExpiredTip: vscode.l10n.t('Go to the first account that needs a new login.'),
    chipTaskLog: vscode.l10n.t('Task log unreadable'),
    registryTitle: vscode.l10n.t('The worker registry could not be read'),
    registryBody: vscode.l10n.t('Reason: {0}. No worker account is shown and no change can be saved until the file is fixed or deleted. This is not an empty registry.'),
    registryOpen: vscode.l10n.t('Open File'),
    chipCliUnknown: vscode.l10n.t('Claude CLI not found or unreadable'),
    chipCliUnknownTip: vscode.l10n.t('Check the Claude CLI path in Settings.'),
    chipCliOld: vscode.l10n.t('Session workers need Claude Code {0} or newer'),
    chipUsageError: vscode.l10n.t('Account check failed: {0}'),
    chipLimit: vscode.l10n.t('At a plan limit: {0}'),
    chipLimitTip: vscode.l10n.t('Go to the first account that has used up a plan window.'),
    chipCooling: vscode.l10n.t('Cooling down: {0}'),
    chipCoolingTip: vscode.l10n.t('Accounts that automatic selection is skipping after a quota error.'),
    chipMcp: vscode.l10n.t('Set up dispatch here'),
    chipMcpTip: vscode.l10n.t(
      'The Claude Code session in this workspace cannot dispatch: it has neither the cco command with this version\'s dispatch policy nor a cco-dispatch entry in .mcp.json.',
    ),
    chipPolicy: vscode.l10n.t('Add the dispatch policy'),
    chipPolicyTip: vscode.l10n.t('CLAUDE.md in this workspace has no dispatch policy block.'),
    chipPolicyOutdated: vscode.l10n.t('Update the dispatch policy'),
    chipPolicyOutdatedTip: vscode.l10n.t('The dispatch policy block in CLAUDE.md is not this version\'s text: it is from another version of the extension, or was changed.'),
    allExpiredTitle: vscode.l10n.t('No worker account is logged in'),
    allExpiredBody: vscode.l10n.t('Every dispatch will fail until at least one worker logs in again. Use Re-login on a card below.'),
    sameAccountTitle: vscode.l10n.t('Some accounts here are one claude.ai account'),
    sameAccountBody: vscode.l10n.t(
      "Signed in to the same claude.ai account: {0}. Each group draws on one plan's limits; automatic dispatch is not changed by it.",
    ),
    noWorkspaceTitle: vscode.l10n.t('No folder is open in this window'),
    noWorkspaceBody: vscode.l10n.t('Sessions and tasks are tracked per workspace folder. Open a folder, or look across every workspace on this machine.'),
    noWorkspaceBodyAll: vscode.l10n.t('Showing every workspace on this machine. Open a folder to set up dispatch for it.'),

    /* accounts */
    accountsTitle: vscode.l10n.t('Accounts'),
    accountsReady: vscode.l10n.t('{0} ready'),
    accountsExpired: vscode.l10n.t('{0} logged out'),
    accountsLimit: vscode.l10n.t('{0} at a limit'),
    accountsCooling: vscode.l10n.t('{0} cooling down'),
    accountsError: vscode.l10n.t('{0} check failed'),
    accountsChecking: vscode.l10n.t('{0} checking'),
    accountsUnknown: vscode.l10n.t('{0} state unknown'),
    addWorker: vscode.l10n.t('Add worker account'),
    importWorkers: vscode.l10n.t('Import existing logins'),
    tagMain: vscode.l10n.t('main'),
    tagMainTip: vscode.l10n.t('The account the Claude session of this editor runs as.'),
    tagPreferred: vscode.l10n.t('preferred'),
    tagPreferredTip: vscode.l10n.t('Automatic selection tries this account first.'),
    acctRunning: vscode.l10n.t('{0} running'),
    acctPlanTip: vscode.l10n.t('Subscription plan: {0}'),
    acctSameAccountOne: vscode.l10n.t("Same claude.ai account as {0} — one plan's limits for both"),
    acctSameAccountMany: vscode.l10n.t("Same claude.ai account as {0} — one plan's limits for all of them"),
    acctStateOk: vscode.l10n.t('Ready'),
    acctStateExpired: vscode.l10n.t('Logged out'),
    acctStateError: vscode.l10n.t('Account check failed'),
    acctStateRefreshing: vscode.l10n.t('Checking usage…'),
    acctStateNoLimits: vscode.l10n.t('Logged in, no plan limits'),
    acctStateLoggedIn: vscode.l10n.t('Logged in'),
    acctStateUnknown: vscode.l10n.t('State unknown'),
    acctStateCooling: vscode.l10n.t('Cooling down'),
    acctStateLimit: vscode.l10n.t('At a plan limit'),
    acctDefaultModel: vscode.l10n.t('default {0}'),
    acctModelCli: vscode.l10n.t('model chosen by the CLI'),
    acctModelCliDefault: vscode.l10n.t('CLI default'),
    acctLastRan: vscode.l10n.t('last ran {0}'),
    acctLastRanTip: vscode.l10n.t('{0} is the model id the CLI of this account reported for its newest finished task that used the default.'),
    acctChecked: vscode.l10n.t('checked {0}'),
    acctLoginOk: vscode.l10n.t('Login ok · checked {0}'),
    acctLoginUnconfirmed: vscode.l10n.t('Login not confirmed · checking'),
    acctLoginChecking: vscode.l10n.t('Checking login'),
    acctLoginProbeFailed: vscode.l10n.t("Couldn't check the login — retrying"),
    acctExpiredTitle: vscode.l10n.t('Login expired'),
    acctExpiredBody: vscode.l10n.t('Dispatches to this account fail until you log in again.'),
    acctExpiredBodyMain: vscode.l10n.t('Plan usage cannot be read until you log in again.'),
    acctExpiredBodyRun: vscode.l10n.t('The last dispatch to this account failed on login. Dispatches skip it until one succeeds or you log in again.'),
    acctErrorTitle: vscode.l10n.t('The account check failed'),
    acctErrorBody: vscode.l10n.t('The CLI gave no reason.'),
    acctNoLimitsBody: vscode.l10n.t('This login is a token or API key, not a subscription, so there is no plan quota to show.'),
    acctNoWindows: vscode.l10n.t('No rate-limit windows were reported.'),
    acctUsageLabel: vscode.l10n.t('Plan usage'),
    winPrimary: vscode.l10n.t('Primary limit'),
    winSecondary: vscode.l10n.t('Secondary limit'),
    winTotal: vscode.l10n.t('Total usage'),
    winAuto: vscode.l10n.t('Auto + Composer'),
    winApi: vscode.l10n.t('API usage'),
    winGeminiWeekly: vscode.l10n.t('Gemini weekly'),
    winGemini5h: vscode.l10n.t('Gemini 5-hour'),
    win3pWeekly: vscode.l10n.t('Claude + GPT weekly'),
    win3p5h: vscode.l10n.t('Claude + GPT 5-hour'),
    acctNoReading: vscode.l10n.t('no reading'),
    acctNoReadingBody: vscode.l10n.t('No plan-usage reading for {0}. Dispatches run as usual.'),
    acctNoReadingOff: vscode.l10n.t('Usage readings for other providers are turned off in Settings.'),
    acctOneShot: vscode.l10n.t('one-shot only'),
    acctOneShotTip: vscode.l10n.t('{0} has no session workers. Dispatches to this account run one-shot and edit the working tree in place.'),
    acctTempUnavailable: vscode.l10n.t('Plan usage is temporarily unavailable. Last reading: {0}.'),
    acctStale: vscode.l10n.t('Showing the last reading, from {0}. The latest check returned no data.'),
    acctCooldown: vscode.l10n.t('Cooling down · {0} left'),
    acctCooldownTip: vscode.l10n.t('Automatic selection skips this account until {0}, after a quota error.'),
    acctOverageOn: vscode.l10n.t('Extra usage on'),
    acctOverageCap: vscode.l10n.t('{0}% of cap'),
    acctOverageTip: vscode.l10n.t('This account bills real money once a plan window is used up.'),
    stat5h: vscode.l10n.t('Last 5 h'),
    stat7d: vscode.l10n.t('Last 7 d'),
    statAll: vscode.l10n.t('All time'),
    statTasks: vscode.l10n.t('{0} tasks'),
    statTokens: vscode.l10n.t('{0} tokens'),
    statTokensTip: vscode.l10n.t('Input {0} · output {1}'),
    statTokensNA: vscode.l10n.t('tokens n/a'),
    statTokensNATip: vscode.l10n.t('No token counts were reported for these dispatches.'),
    statCostTip: vscode.l10n.t('Estimated cost the CLI reported for these dispatches.'),
    statsTip: vscode.l10n.t('Counts only work dispatched through this extension. The meters above show the real plan quota of the account.'),
    acctNoDispatches: vscode.l10n.t('No dispatches yet.'),
    acctNotWorker: vscode.l10n.t('Not a dispatch target. This is the account your editor session runs as.'),
    acctFailures: vscode.l10n.t('Failures: {0}'),
    acctLastError: vscode.l10n.t('Last failure: {0}'),
    relogin: vscode.l10n.t('Re-login'),
    openSession: vscode.l10n.t('Open session'),
    openSessionTip: vscode.l10n.t('Open a terminal running {0} as this account.'),
    checkAgain: vscode.l10n.t('Check again'),
    checkLoginNow: vscode.l10n.t('Check login now'),
    moreActions: vscode.l10n.t('More actions'),
    moreActionsFor: vscode.l10n.t('More actions for {0}'),
    menuPrefer: vscode.l10n.t('Prefer this account'),
    menuUnprefer: vscode.l10n.t('Stop preferring this account'),
    menuDefaultModel: vscode.l10n.t('Default model'),
    menuModelCli: vscode.l10n.t('Let the CLI choose'),
    menuModelOther: vscode.l10n.t('Other…'),
    menuPermission: vscode.l10n.t('Permission / sandbox mode'),
    menuPermCli: vscode.l10n.t('CLI default'),
    menuPermShared: vscode.l10n.t('{0} · change in Settings…'),
    menuPermSharedTip: vscode.l10n.t('Every {0} worker uses the same permission mode. It is a setting, not a per-account choice.'),
    menuRelogin: vscode.l10n.t('Re-login…'),
    menuCheckLogin: vscode.l10n.t('Check Login Now'),
    menuRemove: vscode.l10n.t('Remove account…'),
    meterPaceTip: vscode.l10n.t('How far through this window the clock is. Usage ahead of the mark is being spent faster than the window refills.'),
    resetsIn: vscode.l10n.t('resets in {0}'),
    resetsNow: vscode.l10n.t('resetting now'),
    severityWarning: vscode.l10n.t('high'),
    severityCritical: vscode.l10n.t('at the limit'),
    unsupportedTitle: vscode.l10n.t('Registry entries this version cannot use: {0}'),
    unsupportedBody: vscode.l10n.t('This version of the extension cannot use these entries and leaves them in the registry untouched. A newer version may have written them. To delete one, use "Remove Registry Entry…" on its row in the Worker Accounts view.'),
    unsupportedUnnamed: vscode.l10n.t('(unnamed entry)'),
    onboardTitle: vscode.l10n.t('Add your first worker account'),
    onboardBody: vscode.l10n.t('A worker is another account this session can hand tasks to. Each one brings its own plan quota.'),
    onboardClis: vscode.l10n.t('Supported CLIs: {0}.'),
    onboardStepWorker: vscode.l10n.t('Add or import a worker account'),
    onboardStepMcp: vscode.l10n.t('Set up dispatch in this workspace'),
    onboardStepPolicy: vscode.l10n.t('Add the dispatch policy to CLAUDE.md'),

    /* team */
    teamTitle: vscode.l10n.t('Team'),
    teamWorking: vscode.l10n.t('{0} working'),
    teamWaiting: vscode.l10n.t('{0} waiting'),
    teamParked: vscode.l10n.t('{0} parked'),
    laneWorking: vscode.l10n.t('Working'),
    laneWaiting: vscode.l10n.t('Waiting on you'),
    laneParked: vscode.l10n.t('Parked'),
    laneWorkingEmpty: vscode.l10n.t('Nothing is working right now.'),
    laneWaitingEmpty: vscode.l10n.t('Nothing is waiting on you.'),
    laneParkedEmpty: vscode.l10n.t('No parked sessions.'),
    teamOffTitle: vscode.l10n.t('Session workers are off'),
    teamOffBody: vscode.l10n.t('A session worker keeps a dispatched task running as a live Claude Code session in its own git worktree. You can attach to it, read its log and steer it with SendMessage while it works.'),
    teamEnable: vscode.l10n.t('Turn on session workers'),
    teamEmptyTitle: vscode.l10n.t('No live sessions in this workspace'),
    teamEmptyTitleAll: vscode.l10n.t('No live sessions on this machine'),
    teamEmptyBody: vscode.l10n.t('Session workers, native teammates and other Claude Code sessions appear here while they are alive.'),
    teamUnsupportedTitle: vscode.l10n.t('Session workers need Claude Code {0} or newer'),
    teamUnsupportedBody: vscode.l10n.t('This machine runs {0}. Dispatches still run as one-shot workers; update Claude Code to get live sessions.'),
    sessCopyTip: vscode.l10n.t('Copy {0}. It is the address SendMessage takes.'),
    sessCopied: vscode.l10n.t('Copied {0}'),
    sessBusy: vscode.l10n.t('working'),
    sessBusyFor: vscode.l10n.t('working {0}'),
    sessWaiting: vscode.l10n.t('waiting'),
    sessWaitingFor: vscode.l10n.t('waiting {0}'),
    sessIdle: vscode.l10n.t('idle'),
    sessIdleFor: vscode.l10n.t('idle {0}'),
    sessStopped: vscode.l10n.t('stopped'),
    sessUnknown: vscode.l10n.t('status unknown'),
    sessNoTask: vscode.l10n.t('No task recorded'),
    sessTeammateNoTask: vscode.l10n.t('Native teammate'),
    sessPeerNoTask: vscode.l10n.t('Claude Code session'),
    sessWaitingOn: vscode.l10n.t('Waiting for: {0}'),
    srcWorker: vscode.l10n.t('Session worker'),
    srcWorkerTip: vscode.l10n.t('A session this extension dispatched.'),
    srcTeammate: vscode.l10n.t('Teammate'),
    srcTeammateRole: vscode.l10n.t('Teammate · {0}'),
    srcTeammateOf: vscode.l10n.t('{0} in {1}'),
    srcTeammateTip: vscode.l10n.t('A member of a native Claude Code agent team. Its team lead manages it.'),
    srcPeer: vscode.l10n.t('Peer session'),
    srcPeerBackground: vscode.l10n.t('Peer session · background'),
    srcPeerTip: vscode.l10n.t('Another live Claude Code session here. No dispatch started it.'),
    sessAccountTip: vscode.l10n.t('Runs as the account {0}.'),
    sessSettled: vscode.l10n.t('result recorded'),
    sessSettledTip: vscode.l10n.t('The dispatch that started this session has finished and its result was recorded.'),
    sessBranchTip: vscode.l10n.t('Branch {0} in {1}'),
    sessAttach: vscode.l10n.t('Attach'),
    sessAttachTip: vscode.l10n.t('Open a terminal attached to this session.'),
    sessLogs: vscode.l10n.t('Logs'),
    sessLogsTip: vscode.l10n.t('Open a terminal showing the log of this session.'),
    sessDiff: vscode.l10n.t('Diff'),
    sessDiffTip: vscode.l10n.t('Show what the branch of this session changed.'),
    sessStop: vscode.l10n.t('Stop'),
    sessStopTip: vscode.l10n.t('Stop this session. A worktree that still holds work is kept. Asks first.'),

    /* activity */
    activityTitle: vscode.l10n.t('Activity'),
    activityRunning: vscode.l10n.t('{0} running'),
    rateLabel: vscode.l10n.t('Success · 14 days'),
    rateNone: vscode.l10n.t('No finished tasks yet'),
    rateNote: vscode.l10n.t('{0} of {1} finished tasks succeeded'),
    stripLabel: vscode.l10n.t('Tasks per day'),
    stripAria: vscode.l10n.t('Last 14 days: {0} done, {1} failed, {2} cancelled'),
    stripDayTip: vscode.l10n.t('{0}: {1} done, {2} failed, {3} cancelled'),
    filterStatusLabel: vscode.l10n.t('Filter tasks by status'),
    filterAll: vscode.l10n.t('All'),
    filterPlaceholder: vscode.l10n.t('Filter by title, account, model…'),
    filterTextLabel: vscode.l10n.t('Filter tasks by text'),
    filterResult: vscode.l10n.t('{0} of {1} match'),
    filterClear: vscode.l10n.t('Clear filters'),
    filterProviderLabel: vscode.l10n.t('Filter tasks by CLI'),
    filterProviderHead: vscode.l10n.t('CLI'),
    statusRunning: vscode.l10n.t('Running'),
    statusDone: vscode.l10n.t('Done'),
    statusFailed: vscode.l10n.t('Failed'),
    statusCancelled: vscode.l10n.t('Cancelled'),
    statusOrphaned: vscode.l10n.t('Orphaned'),
    statusUnknown: vscode.l10n.t('Unknown'),
    modeOneshot: vscode.l10n.t('one-shot'),
    modeOneshotTip: vscode.l10n.t('Ran as a single headless {0} run.'),
    modeDetached: vscode.l10n.t('detached'),
    modeDetachedTip: vscode.l10n.t('A one-shot run that keeps going after the dispatching session ends.'),
    modeSession: vscode.l10n.t('session'),
    modeSessionTip: vscode.l10n.t('Ran as a live session worker.'),
    colStatus: vscode.l10n.t('Status'),
    colTask: vscode.l10n.t('Task'),
    colMode: vscode.l10n.t('Mode'),
    colAccount: vscode.l10n.t('Account'),
    colModel: vscode.l10n.t('Model'),
    colStarted: vscode.l10n.t('Started'),
    colDuration: vscode.l10n.t('Duration'),
    colTokens: vscode.l10n.t('Tokens'),
    tokensInOut: vscode.l10n.t('{0} / {1}'),
    tokensNA: vscode.l10n.t('n/a'),
    tokensNATip: vscode.l10n.t('Session workers do not report token usage.'),
    taskOpenTip: vscode.l10n.t('Open the output of this task.'),
    taskProviderTip: vscode.l10n.t('Ran on {0}.'),
    taskModelRan: vscode.l10n.t('{0} → {1}'),
    taskModelTipDispatch: vscode.l10n.t('Asked for {0}, named by the dispatch.'),
    taskModelTipWorker: vscode.l10n.t('Asked for {0}, the default of the worker account.'),
    taskModelTipCli: vscode.l10n.t('No model was named, so the CLI used its own default.'),
    taskModelTipDispatchAlone: vscode.l10n.t('The model was named by the dispatch.'),
    taskModelTipWorkerAlone: vscode.l10n.t('The default of the worker account was used.'),
    taskModelTipRan: vscode.l10n.t('The CLI reported that it ran {0}.'),
    taskCancel: vscode.l10n.t('Cancel'),
    taskCancelConfirm: vscode.l10n.t('Cancel task?'),
    taskDetails: vscode.l10n.t('Details'),
    detailError: vscode.l10n.t('Error'),
    detailPrompt: vscode.l10n.t('Prompt'),
    detailProvider: vscode.l10n.t('CLI'),
    detailModelRan: vscode.l10n.t('Model that ran'),
    detailModelSource: vscode.l10n.t('Model source'),
    modelSourceDispatch: vscode.l10n.t('named by the dispatch'),
    modelSourceWorker: vscode.l10n.t('worker default'),
    modelSourceCli: vscode.l10n.t('CLI default'),
    detailSession: vscode.l10n.t('Session'),
    detailBranch: vscode.l10n.t('Branch'),
    detailBranchUnmerged: vscode.l10n.t('{0} (unmerged)'),
    detailEnded: vscode.l10n.t('Ended'),
    detailTokens: vscode.l10n.t('Tokens'),
    detailTokensValue: vscode.l10n.t('input {0} · output {1}'),
    detailCost: vscode.l10n.t('Est. cost'),
    detailId: vscode.l10n.t('Task id'),
    tasksEmptyTitle: vscode.l10n.t('No dispatches in this workspace yet'),
    tasksEmptyTitleAll: vscode.l10n.t('No dispatches on this machine yet'),
    tasksEmptyBody: vscode.l10n.t('When your Claude Code session dispatches a task to a worker, it appears here with its status, duration and result.'),
    tasksNoMatchTitle: vscode.l10n.t('No task matches these filters'),
    tasksNoMatchBody: vscode.l10n.t('Try another filter, or clear them.'),
    tasksShowMore: vscode.l10n.t('Show {0} more · {1} not shown'),
    tasksCapped: vscode.l10n.t('Showing the newest {0} of {1} tasks.'),
    taskLogTitle: vscode.l10n.t('The task log could not be read'),
    taskLogBody: vscode.l10n.t('Reason: {0}. Activity is hidden until the log is readable. This is not an empty history.'),

    /* settings drawer */
    drawerClose: vscode.l10n.t('Close settings'),
    groupDispatch: vscode.l10n.t('Dispatch'),
    groupGuards: vscode.l10n.t('Billing guards'),
    groupGuardsNote: vscode.l10n.t('Enforced by the dispatch server and shared by every editor on this machine.'),
    groupSession: vscode.l10n.t('Session workers'),
    groupSessionNote: vscode.l10n.t('Changes take effect at the next dispatch.'),
    groupProviders: vscode.l10n.t('Other providers'),
    groupProvidersNote: vscode.l10n.t('Worker accounts on the CLI of another vendor. A task goes to one only when the dispatch names that provider or worker.'),
    groupSetup: vscode.l10n.t('Setup'),
    groupDanger: vscode.l10n.t('Danger zone'),
    setPermission: vscode.l10n.t('Permission mode of Claude Code workers'),
    setPermissionHint: vscode.l10n.t('Workers cannot answer permission prompts, so a mode that asks stalls on the first edit. Workers on another CLI set theirs per account, in the menu of their card.'),
    setPermissionBypassNote: vscode.l10n.t('Session workers never start in bypassPermissions. They run with acceptEdits instead.'),
    setClaudePath: vscode.l10n.t('Claude CLI path'),
    setClaudePathHint: vscode.l10n.t('The claude executable every worker runs.'),
    setClaudePathVersion: vscode.l10n.t('Found: {0}'),
    setClaudePathUnreadable: vscode.l10n.t('No version could be read from this path.'),
    setTaskTimeout: vscode.l10n.t('Worker timeout (minutes)'),
    setTaskTimeoutHint: vscode.l10n.t('How long a dispatched worker may run before it is stopped. A single task can override this.'),
    setCooldown: vscode.l10n.t('Quota cooldown (minutes)'),
    setCooldownHint: vscode.l10n.t('How long an account sits out after a quota or rate-limit error.'),
    setKeepalive: vscode.l10n.t('Keep logins fresh'),
    setKeepaliveHint: vscode.l10n.t('Send one minimal request per subscription account each day so logins do not expire. Uses a negligible amount of plan quota.'),
    setFrontier: vscode.l10n.t('Frontier model dispatch'),
    setFrontierHint: vscode.l10n.t('Block rejects dispatches that ask for the frontier tier (fable), which may bill per use or draw a separate quota.'),
    setOverage: vscode.l10n.t('Overage dispatch'),
    setOverageHint: vscode.l10n.t('Block never sends work to an account that has used up its plan, even when extra usage is enabled there.'),
    guardBlock: vscode.l10n.t('Block'),
    guardAllow: vscode.l10n.t('Allow'),
    guardInEffect: vscode.l10n.t('In effect: {0}'),
    guardMismatch: vscode.l10n.t('In effect: {0}. Another editor set this. Choose a value here to take over.'),
    guardMismatchBy: vscode.l10n.t('In effect: {0}, set in {1}. Choose a value here to take over.'),
    setMesh: vscode.l10n.t('Run dispatches as session workers'),
    setMeshHint: vscode.l10n.t('Each task runs in its own git worktree as a live session you can attach to and steer. Detached tasks stay one-shot.'),
    setMeshUnsupported: vscode.l10n.t('Needs Claude Code {0} or newer; this machine runs {1}. Dispatches fall back to one-shot workers.'),
    setMeshCap: vscode.l10n.t('Session workers in flight'),
    setMeshCapHint: vscode.l10n.t('The most session workers that may have a dispatch still running. Dispatches past it are refused, not queued.'),
    setMeshHistory: vscode.l10n.t('Worker history limit'),
    setMeshHistoryHint: vscode.l10n.t('How many finished session workers the Worker History view keeps.'),
    setProviderPolling: vscode.l10n.t('Read usage from other providers'),
    setProviderPollingHint: vscode.l10n.t('On the usage refresh schedule, asks the CLI or usage service of each vendor for a plan-usage reading. Off, those accounts show their login state only.'),
    provTableCaption: vscode.l10n.t('What each CLI supports'),
    provColProvider: vscode.l10n.t('CLI'),
    provColLogins: vscode.l10n.t('Separate logins'),
    provColSessions: vscode.l10n.t('Session workers'),
    provYes: vscode.l10n.t('Yes'),
    provNo: vscode.l10n.t('No'),
    provUnverified: vscode.l10n.t('Not verified'),
    provLoginsYesTip: vscode.l10n.t('Each worker account can have its own login.'),
    provLoginsUnverifiedTip: vscode.l10n.t('A separate home directory is accepted, but a second login there is not confirmed to work.'),
    provLoginsNoTip: vscode.l10n.t('One login per machine, so one worker account.'),
    provSessionsYesTip: vscode.l10n.t('Dispatches can run as live sessions you attach to and steer.'),
    provSessionsNoTip: vscode.l10n.t('Dispatches run one-shot and edit the working tree in place.'),
    addWorkerOther: vscode.l10n.t('Add a worker on another CLI'),
    setupMcp: vscode.l10n.t('Dispatch server'),
    setupMcpHint: vscode.l10n.t('Adds cco-dispatch to .mcp.json so the Claude session here can dispatch.'),
    setupPolicy: vscode.l10n.t('Dispatch policy'),
    setupPolicyHint: vscode.l10n.t('Adds the orchestration policy block to CLAUDE.md.'),
    setupAgent: vscode.l10n.t('Team proxy agent'),
    setupAgentHint: vscode.l10n.t('Installs the cco-worker agent, which puts a worker account into a native agent team.'),
    setupDone: vscode.l10n.t('Installed'),
    setupMissing: vscode.l10n.t('Not installed'),
    setupOutdated: vscode.l10n.t('Differs from this version'),
    setupPolicyUpdate: vscode.l10n.t('Update Dispatch Policy'),
    setupNoWorkspace: vscode.l10n.t('Open a folder first'),
    setupRegister: vscode.l10n.t('Register'),
    setupRegisterAgain: vscode.l10n.t('Register again'),
    setupAdd: vscode.l10n.t('Add'),
    setupUpdate: vscode.l10n.t('Update'),
    setupInstall: vscode.l10n.t('Install'),
    setupWorkspace: vscode.l10n.t('Update Workspace Setup'),
    setupWorkspaceTip: vscode.l10n.t(
      'Look at what this workspace has installed — the dispatch policy, the team proxy agent, the permission rules for the cco command, the MCP registration — and update what you check.',
    ),
    manageAssets: vscode.l10n.t('Manage assets'),
    cleanLitter: vscode.l10n.t('Clean up stale session files'),
    cleanLitterTip: vscode.l10n.t('Remove the session files that usage probes of earlier versions left behind.'),
    openSettings: vscode.l10n.t('All extension settings'),
    dangerCancelAll: vscode.l10n.t('Cancel all running'),
    dangerCancelAllHint: vscode.l10n.t('Stops every running task in every workspace. Asks first.'),
    dangerClearTasks: vscode.l10n.t('Clear task history'),
    dangerClearTasksHint: vscode.l10n.t('Empties the task log on this machine. Asks first.'),
    dangerResetCheckin: vscode.l10n.t('Reset check-in'),
    dangerResetCheckinHint: vscode.l10n.t('Forgets which model orchestrates this workspace. Use it after switching the main account. Asks first.'),
    saving: vscode.l10n.t('Saving…'),
    saveConfirming: vscode.l10n.t('Waiting for your answer in the dialog…'),
    saved: vscode.l10n.t('Saved'),
    saveFailed: vscode.l10n.t('Not saved: {0}'),
    saveFailedUnknown: vscode.l10n.t('the editor gave no reason'),
    saveNoAnswer: vscode.l10n.t('Not saved: the editor did not answer.'),
    fieldIntRange: vscode.l10n.t('Enter a whole number from {0} to {1}.'),
    fieldTextEmpty: vscode.l10n.t('Enter a path.'),
  } satisfies Record<string, string>;
}
