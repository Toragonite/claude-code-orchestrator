/**
 * The data contract between the extension host and its UI surfaces (the dashboard webview and
 * the Team tree view). Types only — no imports, and no runtime code except ONE shared constant
 * (RUN_LOGIN_FAILURE_DETAIL), exported here so a vendoring front end can localize it.
 *
 * Three rules every producer of these shapes must hold, because a webview renders them:
 *
 *  1. VALUES ARE ALREADY SAFE TO DISPLAY. Every `string` has been passed through
 *     `flattenOneLine` (bidi/invisible/control characters removed) and cut with
 *     `sliceOneLine` to the cap noted on the field. Every `number` is finite; a value that
 *     was not a finite number in its source file is `null` (or 0 where the field is a
 *     count), never a string and never NaN. Every timestamp is epoch milliseconds.
 *  2. NOTHING SECRET OR ADDRESSABLE CROSSES. No io tokens, no filesystem paths that the page
 *     could echo back as a target, no account e-mail. The page refers to things by the
 *     opaque keys below and the HOST resolves them; an unknown key is ignored.
 *  3. RAW VALUES, NOT SENTENCES. Durations, ages and "resets in" text are formatted by the
 *     page from timestamps so they can be localized and can tick without a refresh.
 */

/** Opaque, stable id of an account (derived from its config dir; not the path itself). */
export type AccountKey = string;

/** Opaque, stable id of a live session row. */
export type SessionKey = string;

export type LoginState =
  | 'ok' // plan limits readable
  | 'expired' // the CLI reports the account logged out — the user must re-login
  | 'no-plan-limits' // logged in, but not a subscription login (token / API key)
  | 'error' // the usage probe itself failed; `loginDetail` says how
  | 'refreshing'; // no reading yet

export interface UiUsageWindow {
  kind: 'session' | 'weekly_all' | 'weekly_scoped' | 'other';
  /** Upstream label, ≤ 40 chars, e.g. "Session (5hr)", "Weekly Fable". */
  label: string;
  /** 0–100, clamped. */
  percent: number;
  severity: 'normal' | 'warning' | 'critical';
  /** When the window resets, or null when upstream did not say. */
  resetsAt: number | null;
}

/** UiAccount.loginCheck. */
export interface UiLoginCheck {
  state: 'ok' | 'unconfirmed' | 'checking' | 'loggedOut' | 'probeFailed';
  since: number | null;
  checkedAt: number | null;
  reason: string;
}

export interface UiTokenStats {
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UiAccount {
  key: AccountKey;
  /** Worker name, or "main" for the hosting session's own account. ≤ 64 chars. */
  name: string;
  /** The account the editor's own Claude session runs as. */
  isMain: boolean;
  /** Registered as a dispatch target. An account can be both main and a worker. */
  isWorker: boolean;
  preferred: boolean;
  /** Default model alias/id for dispatches that name none; null when not a worker or when
   *  the worker leaves the choice to its CLI. */
  defaultModel: string | null;
  /** Which agent CLI the account runs on: a `ProviderId` ("claude", "codex", "cursor", "gemini"). */
  provider: string;
  /** Product name of that CLI for display, ≤ 32 chars (e.g. "Claude Code", "Antigravity"). */
  providerLabel: string;
  /** The account can run attachable, steerable session workers (Claude Code only). */
  sessionWorkers: boolean;
  /** The account's permission / sandbox mode for dispatches, ≤ 32 chars; null = the CLI's default. */
  permissionMode: string | null;
  /**
   * The model id this account's DEFAULT last ran as (≤ 64 chars), as its CLI reported it — from
   * its newest finished task that used the stored default, or, for an account with no stored
   * default, its newest finished task that left the model to the CLI. Null when none has
   * reported one (a vendor run that NAMED a model never does: an echo of the request is not a
   * report).
   */
  modelRanAs: string | null;
  login: LoginState;
  /**
   * Why `login` is what it is, ≤ 200 chars, or null. Set for `error` (how the probe failed) and
   * for an `expired` account whose verdict came from a failed RUN rather than from a status
   * check — then it is exactly the marker the model module exports for that case, which a
   * surface replaces with its own localized sentence.
   */
    loginDetail: string | null;
  /**
   * A CLAUDE CODE account's login state (contract-2.0-fixes.md "Login state (CA)"); null for an
   * account on another vendor's CLI. ADDITIVE to `login`, which keeps its five values: `login` is
   * `expired` exactly when this is `loggedOut`, and an unconfirmed "not logged in" is `login:
   * refreshing` with a `loginDetail` that says so.
   *  - `state`: `ok` (a login probe of this version said logged in, within its floor) ·
   *    `unconfirmed` (a cached or older reading, or one "not logged in" awaiting its second check;
   *    a check is due) · `checking` (a probe is running) · `loggedOut` (confirmed twice, or by a
   *    failed dispatch — the only state a surface calls "logged out") · `probeFailed` (the check
   *    itself failed — says nothing about the login; a surface offers "Check Again", never "Re-login").
   *  - `since` / `checkedAt`: epoch ms or null. `reason`: one line, ≤ 200 chars, the probe's own.
   */
  loginCheck: UiLoginCheck | null;
  /** Subscription plan as reported upstream (e.g. "max"), ≤ 24 chars, or null. */
  plan: string | null;
  /**
   * The plan as the account's CLI names it ("Claude Max"), ≤ 40 chars, or null — Claude Code
   * accounts only (usage cache `planLabel`). Shown in place of `plan` when there is one.
   */
  planLabel: string | null;
  /**
   * The OTHER accounts shown here (≤ 8 names, in list order) that are signed in to the same
   * claude.ai account as this one — the same `accountKey` in their usage readings — and so
   * draw on one plan's limits with it. Empty when there are none or it is not known. Claude
   * Code accounts only; information, which no dispatch reads.
   */
  sameAccountAs: string[];
  windows: UiUsageWindow[];
  /** Set when `windows` are a carried-forward reading: when they were actually observed. */
  windowsStaleSince: number | null;
  /** Last time real windows were seen, even if none are shown now. */
  lastGoodWindowsAt: number | null;
  usageFetchedAt: number | null;
  overage: { enabled: boolean; percent: number | null; spendLabel: string | null } | null;
  /** Epoch ms until which automatic selection skips this worker; null when not cooling down. */
  cooldownUntil: number | null;
  session5h: UiTokenStats;
  week: UiTokenStats;
  allTime: UiTokenStats & { errors: number };
  /** Most recent failure recorded for this worker, ≤ 200 chars. */
  lastError: string | null;
  /** Dispatches currently running on this account (all workspaces). */
  running: number;
}

/**
 * `UiAccount.loginDetail` of an account that is `expired` BECAUSE A RUN FAILED ON LOGIN (as
 * opposed to one its CLI's own status check reported). A fixed marker, not a sentence for
 * display: a surface recognizes exactly this value and shows its own localized text for it. It
 * is readable as it stands, so a surface that does not know it still says something true.
 *
 * The one runtime value of this file, and here rather than in the model module so that a front
 * end vendoring this file (host-protocol, list_workers' structured answer) can localize it
 * without copying a literal. media/dashboard/dashboard.js, which cannot import, holds the same
 * literal.
 */
export const RUN_LOGIN_FAILURE_DETAIL = 'the last run failed on login';

export type UiTaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'orphaned';

/** How the task was run: a one-shot `claude -p`, a detached one-shot, or a `--bg` session. */
export type UiDispatchMode = 'oneshot' | 'detached' | 'session';

export interface UiTask {
  /** Task id — the only handle the page sends back (open output, cancel). */
  id: string;
  /** ≤ 160 chars. */
  title: string;
  status: UiTaskStatus;
  mode: UiDispatchMode;
  /** Account name(s) as recorded; several when the dispatch failed over. ≤ 120 chars. */
  worker: string;
  /** ≤ 64 chars. */
  model: string;
  /** First event of the task; null when the log no longer holds it. */
  startedAt: number | null;
  /** Terminal event time; null while running. */
  endedAt: number | null;
  /** null when the transport does not report usage (session workers). */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Failure text for a non-`done` terminal task, ≤ 240 chars. */
  error: string | null;
  /** ≤ 300 chars. */
  promptPreview: string | null;
  inWorkspace: boolean;
  /** The host has an output file it can open for this id. */
  hasOutput: boolean;
  /** Name of the `--bg` worker that ran it (also its SendMessage address); null otherwise. */
  sessionWorker: string | null;
  /** Result branch of a session-worker task, ≤ 120 chars. */
  branch: string | null;
  /** That branch's worktree still exists on disk, i.e. the work is not merged/cleaned yet. */
  unmerged: boolean;
  /** `ProviderId` of the CLI that ran it when that is not Claude Code; null for Claude Code. */
  provider: string | null;
  /**
   * The model id the CLI reported it actually ran (≤ 64 chars), or null when it reported none
   * — a session worker, an older log entry, a failed run.
   */
  modelUsed: string | null;
  /**
   * Where the task's model came from: named by the dispatch, the worker account's default, or
   * left to the CLI's own default. Null for log entries written before this was recorded.
   */
  modelSource: 'dispatch' | 'worker' | 'cli' | null;
}

/**
 * Where a live-session row comes from:
 *  - `worker`   a `--bg` session this extension dispatched (joined with its ledger record);
 *  - `teammate` a member of a native Claude Code agent team (read from the team config);
 *  - `peer`     any other live Claude Code session of a known account in this workspace.
 */
export type UiSessionSource = 'worker' | 'teammate' | 'peer';

export type UiSessionStatus =
  | 'busy' // mid-turn
  | 'waiting' // turn ended and it is asking for input / blocked on something
  | 'idle' // turn ended, nothing pending
  | 'stopped' // no live process (kept only while its result branch is unmerged)
  | 'unknown';

export interface UiSession {
  key: SessionKey;
  source: UiSessionSource;
  /** Session / teammate name — what `SendMessage` takes. ≤ 80 chars. */
  name: string;
  accountKey: AccountKey | null;
  /** ≤ 64 chars; "main" for the hosting account. */
  accountName: string;
  kind: 'background' | 'interactive' | 'teammate';
  status: UiSessionStatus;
  /** One line on what it is doing or waiting for, ≤ 160 chars; null when unknown. */
  detail: string | null;
  taskId: string | null;
  /** ≤ 160 chars. */
  taskTitle: string | null;
  /** ≤ 64 chars. */
  model: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  /** Workspace-relative worktree, or a short folder label, ≤ 120 chars. Never absolute. */
  location: string | null;
  /** ≤ 120 chars. */
  branch: string | null;
  /** A worktree holding this session's work still exists on disk. */
  unmerged: boolean;
  /** The dispatch that created it has been recorded as finished. */
  settled: boolean;
  inWorkspace: boolean;
  /**
   * `claude attach` / `claude logs` can be offered: a job id and an account are known AND the
   * worker has not been stopped (a stopped worker keeps its row and its branch, nothing more).
   */
  canAttach: boolean;
  canStop: boolean;
  /** Native team name for teammates, ≤ 64 chars. */
  team: string | null;
  /** Agent type / role, ≤ 64 chars. */
  role: string | null;
}

export interface UiDailyBucket {
  /** Local midnight that starts the day. */
  day: number;
  done: number;
  failed: number;
  cancelled: number;
}

/** Setting keys the dashboard may write (suffix of `claudeCodeOrchestrator.*`). */
export type UiSettingKey =
  | 'workerPermissionMode'
  | 'claudePath'
  | 'quotaCooldownMinutes'
  | 'workerTimeoutMinutes'
  | 'frontierWorkerDispatch'
  | 'overageWorkerDispatch'
  | 'meshMode'
  | 'meshMaxLiveWorkers'
  | 'meshHistoryLimit'
  | 'sessionKeepalive'
  | 'providerUsagePolling';

export interface UiGuardSetting {
  /** This editor's own setting. */
  value: 'block' | 'allow';
  /** What the shared registry currently enforces. */
  effective: 'block' | 'allow';
  /** Editor that set the effective value when it differs, ≤ 64 chars. */
  setBy: string | null;
}

export interface UiSettings {
  workerPermissionMode: string;
  /** Every value the host accepts for workerPermissionMode, in display order. */
  permissionModes: string[];
  claudePath: string;
  quotaCooldownMinutes: number;
  workerTimeoutMinutes: number;
  frontierWorkerDispatch: UiGuardSetting;
  overageWorkerDispatch: UiGuardSetting;
  /** Session workers ("Mesh Mode") on/off. */
  meshMode: boolean;
  /** Max session workers with a dispatch still in flight (1–64). */
  meshMaxLiveWorkers: number;
  meshHistoryLimit: number;
  sessionKeepalive: boolean;
  /** Model values offered for a Claude Code worker's default, in display order. */
  workerModels: string[];
  /** Ask other vendors' CLIs for a plan-usage reading on the usage refresh schedule. */
  providerUsagePolling: boolean;
  /** Every provider a worker can run on, in display order, with what its pickers offer. */
  providers: UiProvider[];
}

export interface UiProvider {
  /** `ProviderId`. */
  id: string;
  /** ≤ 32 chars. */
  label: string;
  /** Suggested default models (not a validation list). */
  models: string[];
  /** Accepted permission / sandbox modes, in display order. */
  permissionModes: string[];
  /** Whether a second, separate login is possible, and whether that is a verified behaviour. */
  isolation: 'env' | 'none';
  isolationVerified: boolean;
  sessionWorkers: boolean;
}

export interface UiHealth {
  /** `claude --version` as last observed, ≤ 40 chars; null when not probed / failed. */
  claudeVersion: string | null;
  /** null = unknown (version not readable). */
  sessionWorkersSupported: boolean | null;
  /** Minimum CLI version session workers need, for the message when unsupported. */
  sessionWorkersMinVersion: string;
  /** The task log could not be read; the page must say so instead of showing "no tasks". */
  taskLogProblem: string | null;
  /** Workspace setup state; null when there is no workspace folder. */
  mcpInstalled: boolean | null;
  policyInstalled: boolean | null;
  teamAgentInstalled: boolean | null;
  /**
   * Can the Claude Code session of this workspace dispatch (contract §15.7)? True when the cco
   * launcher is in place and the folder's policy block is this version's, or when `.mcp.json`
   * has the cco-dispatch entry. Null when there is no workspace folder. The page offers
   * `dispatchFix` only while this is false.
   */
  canDispatch: boolean | null;
  /**
   * The command that makes a workspace that cannot dispatch able to: Update Workspace Setup —
   * or, on Windows, where cco does not run in this version, Register MCP Server.
   */
  dispatchFix: 'updateWorkspaceSetup' | 'installMcp';
  /**
   * The workspace's CLAUDE.md holds policy markers but not exactly one block of this version's
   * text (prompts.policyState `differs`: an earlier version's or a changed block, more than one
   * block, a marker without a block). Null when there is no workspace or no marker at all.
   */
  policyOutdated: boolean | null;
  /**
   * The shared worker registry could not be read (≤ 200 chars, one line, never any of the
   * file's content); null when it is fine. While set there are no accounts to show and every
   * write to the registry is refused — the page must say so, not show "no workers yet".
   */
  registryProblem: string | null;
}

/**
 * A registry entry this version of the extension cannot use (an unknown provider, an
 * incomplete entry, a duplicate name). It is kept in the file untouched and takes part in
 * nothing; the page only says that it is there.
 */
export interface UiUnsupportedAccount {
  /** The entry's name as a display string, ≤ 64 chars; '' for an entry that has none. */
  name: string;
  /** Why it cannot be used, ≤ 80 chars: `unknown provider "x"`, `incomplete entry`, `duplicate name`. */
  detail: string;
}

export interface UiOrchestrator {
  /** ≤ 64 chars; null when the session was seen but never briefed. */
  model: string | null;
  /** false = frontier tier (no calibration brief). */
  calibrated: boolean;
  briefedAt: number | null;
  lastSeenAt: number | null;
}

export interface DashboardModel {
  /** Bumped whenever the shape changes incompatibly; the page refuses a model it does not know. */
  schema: 2;
  generatedAt: number;
  /** Folder name of the workspace (never the absolute path), ≤ 80 chars; null without one. */
  workspace: string | null;
  scope: 'workspace' | 'all';
  orchestrator: UiOrchestrator | null;
  health: UiHealth;
  accounts: UiAccount[];
  /** Entries of the registry this version cannot use; at most 20, empty when there are none. */
  unsupportedAccounts: UiUnsupportedAccount[];
  /** Newest first, already filtered by `scope`, capped at 300. */
  tasks: UiTask[];
  /** How many tasks matched `scope` before the cap. */
  taskTotal: number;
  /** Tasks running right now, by scope. */
  running: { workspace: number; all: number };
  /** Oldest first, exactly 14 buckets, by `scope`. */
  daily: UiDailyBucket[];
  sessions: UiSession[];
  settings: UiSettings;
}

/* ----------------------------- message protocol ----------------------------- */

export type HostToWebview =
  | { type: 'model'; model: DashboardModel }
  /** Outcome of the page's `setSetting`; `value` is what is now in effect. */
  | { type: 'settingResult'; key: UiSettingKey; ok: boolean; value: unknown; error: string | null }
  /**
   * The host is asking the user to confirm this setting in a dialog of its own. The page stops
   * its "no answer" timer for the key and waits; a `settingResult` follows when the dialog
   * closes, whatever the answer.
   */
  | { type: 'settingPending'; key: UiSettingKey }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string };

export type UiCommandId =
  | 'installMcp'
  | 'addDispatchPolicy'
  | 'installTeamAgent'
  | 'updateWorkspaceSetup'
  | 'addWorker'
  | 'importWorkers'
  | 'openAssetManager'
  | 'refreshUsage'
  | 'clearTasks'
  | 'cancelAllTasks'
  | 'resetCheckin'
  | 'cleanSessionLitter'
  | 'openSettings';

export type UiSessionAction = 'attach' | 'logs' | 'stop' | 'copyName' | 'openDiff';

export type UiAccountAction =
  | 'relogin'
  /** Check Login Now — one live login probe of a Claude Code account (Login state (CA)). */
  | 'checkLogin'
  | 'togglePreferred'
  | 'openSession'
  | 'setModel'
  | 'setPermissionMode'
  | 'remove';

export type WebviewToHost =
  /** Sent once when the page script has booted; the host answers with the first `model`. */
  | { type: 'ready' }
  | { type: 'setScope'; scope: 'workspace' | 'all' }
  | { type: 'setSetting'; key: UiSettingKey; value: unknown }
  | { type: 'command'; id: UiCommandId }
  | { type: 'openTask'; id: string }
  | { type: 'cancelTask'; id: string }
  | { type: 'session'; action: UiSessionAction; key: SessionKey }
  | { type: 'account'; action: UiAccountAction; account: AccountKey; value?: unknown }
  /**
   * Open the worker registry file in the editor. Carries NO path: the host knows which file,
   * and acts only while `health.registryProblem` is set.
   */
  | { type: 'openRegistryFile' };
