/*
 * Preview fixtures for the dashboard page. NOT loaded by the extension (and excluded from the
 * package): only media/dashboard/preview.html uses this file, to render the page in a plain
 * browser with no extension host.
 *
 * It defines two globals:
 *   window.__CCO_STRINGS__   the English string table - a copy of what dashboardStrings() in
 *                            src/dashboard.ts builds. The preview bar reports every key the
 *                            page asks for that is missing here, so drift is visible.
 *   window.__CCO_FIXTURES__  name -> function returning a fresh model (or a special marker).
 *
 * Every model is built relative to "now", so countdowns and ages look alive when it loads.
 * `rich` mixes accounts of all four CLIs and shows every usage state side by side - gauges on
 * a Codex account, no reading on a Cursor account, a logged-out Antigravity account, a CLI
 * that is not installed. It is a catalogue of states, not one consistent machine (a CLI
 * cannot be both missing and reporting). `claude-only` is the same page with Claude Code
 * accounts alone, where the provider marks have to stay out of the way.
 * Both carry what the host knows about models: tasks say where their model came from and -
 * where a CLI reported it - what ran (an alias that ran as an id, an id that ran as itself, a
 * task left to the CLI's own default, and older tasks that say neither), and accounts say
 * what their default last ran as, among them one with no default at all. One account is
 * still being checked, and one is logged in with no reading and in a cooldown.
 * `old-cli-and-broken-log` is the one fixture whose policy block is not this version's.
 * The `hostile` fixture deliberately violates the data contract in every way a damaged or
 * malicious data file could: markup-looking strings, bidi controls, 5,000-character titles,
 * numbers supplied as strings, NaN, Infinity, negative values, wrong container types,
 * duplicate and missing keys. The page must render all of it as inert text.
 */
(function () {
  'use strict';

  /* <strings:begin> */
  const STRINGS = {
    panelTitle: "Orchestrator Dashboard",
    appName: "Claude Code Orchestrator",
    loading: "Loading the dashboard\u2026",
    loadingLate: "Still waiting for data from the extension. If nothing appears, close this tab and open the dashboard again.",
    schemaTitle: "This dashboard is out of date",
    schemaBody: "The extension sent data this page cannot read. Run \"Developer: Reload Window\" to load the matching version.",
    sep: " \u00b7 ",
    nameSep: ", ",
    pct: "{0}%",
    on: "On",
    off: "Off",
    today: "Today",
    dateTime: "{0}, {1}",
    justNow: "just now",
    ago: "{0} ago",
    unitS: "{0}s",
    unitM: "{0}m",
    unitH: "{0}h",
    unitD: "{0}d",
    unitMS: "{0}m {1}s",
    unitHM: "{0}h {1}m",
    unitDH: "{0}d {1}h",
    versionUnknown: "an unreadable version",
    showAllWorkspaces: "Show all workspaces",
    otherWorkspace: "other workspace",
    otherWorkspaceTip: "This belongs to a different workspace folder.",
    unmerged: "unmerged",
    unmergedTip: "The worktree holding this work still exists. Merge or discard its branch to clear it.",
    noticesLabel: "Notifications",
    noticeDismiss: "Dismiss",
    provHome: "Claude Code",
    provRunsOn: "Runs on {0}",
    provLegendLabel: "Accounts by CLI",
    noWorkspaceName: "No folder open",
    scopeLabel: "Which workspaces to show",
    scopeWorkspace: "This workspace",
    scopeAll: "All workspaces",
    scopeWorkspaceTip: "Show the sessions and tasks of the folder open in this window.",
    scopeAllTip: "Show the sessions and tasks of every workspace on this machine.",
    scopeNoteWorkspace: "this workspace",
    scopeNoteAll: "all workspaces",
    scopeNoteMachine: "this machine",
    refreshUsage: "Refresh usage",
    refreshingUsage: "Refreshing\u2026",
    refreshUsageTip: "Ask every account for its current plan usage now.",
    settings: "Settings",
    orchNone: "Orchestrator not checked in",
    orchNoneTip: "No Claude Code session in this workspace has asked for its briefing yet.",
    orchPending: "Orchestrator seen, briefing pending",
    orchPendingTip: "A session connected but has not reported its model yet.",
    orchModel: "Orchestrator {0}",
    orchModelTip: "The model of the Claude Code session that dispatches from this workspace.",
    orchCalibrated: "Calibration brief active",
    orchCalibratedTip: "This model received the operating brief that calibrates it for orchestration.",
    orchFrontier: "Frontier tier",
    orchFrontierTip: "Frontier-tier models run without the calibration brief.",
    orchBriefed: "briefed {0}",
    orchSeen: "seen {0}",
    runningHere: "Running here: {0}",
    runningAll: "Running on this machine: {0}",
    runningHereAndElsewhere: "Running here: {0} \u00b7 in other workspaces: {1}",
    healthLabel: "Things that need attention",
    chipExpired: "Login expired: {0}",
    chipExpiredTip: "Go to the first account that needs a new login.",
    chipTaskLog: "Task log unreadable",
    registryTitle: "The worker registry could not be read",
    registryBody: "Reason: {0}. No worker account is shown and no change can be saved until the file is fixed or deleted. This is not an empty registry.",
    registryOpen: "Open File",
    chipCliUnknown: "Claude CLI not found or unreadable",
    chipCliUnknownTip: "Check the Claude CLI path in Settings.",
    chipCliOld: "Session workers need Claude Code {0} or newer",
    chipUsageError: "Account check failed: {0}",
    chipLimit: "At a plan limit: {0}",
    chipLimitTip: "Go to the first account that has used up a plan window.",
    chipCooling: "Cooling down: {0}",
    chipCoolingTip: "Accounts that automatic selection is skipping after a quota error.",
    chipMcp: "Set up dispatch here",
    chipMcpTip: "The Claude Code session in this workspace cannot dispatch: it has neither the cco command with this version's dispatch policy nor a cco-dispatch entry in .mcp.json.",
    chipPolicy: "Add the dispatch policy",
    chipPolicyTip: "CLAUDE.md in this workspace has no dispatch policy block.",
    chipPolicyOutdated: "Update the dispatch policy",
    chipPolicyOutdatedTip: "The dispatch policy block in CLAUDE.md is not this version's text: it is from another version of the extension, or was changed.",
    allExpiredTitle: "No worker account is logged in",
    allExpiredBody: "Every dispatch will fail until at least one worker logs in again. Use Re-login on a card below.",
    sameAccountTitle: "Some accounts here are one claude.ai account",
    sameAccountBody: "Signed in to the same claude.ai account: {0}. Each group draws on one plan's limits; automatic dispatch is not changed by it.",
    noWorkspaceTitle: "No folder is open in this window",
    noWorkspaceBody: "Sessions and tasks are tracked per workspace folder. Open a folder, or look across every workspace on this machine.",
    noWorkspaceBodyAll: "Showing every workspace on this machine. Open a folder to set up dispatch for it.",
    accountsTitle: "Accounts",
    accountsReady: "{0} ready",
    accountsExpired: "{0} logged out",
    accountsLimit: "{0} at a limit",
    accountsCooling: "{0} cooling down",
    accountsError: "{0} check failed",
    accountsChecking: "{0} checking",
    accountsUnknown: "{0} state unknown",
    addWorker: "Add worker account",
    importWorkers: "Import existing logins",
    tagMain: "main",
    tagMainTip: "The account the Claude session of this editor runs as.",
    tagPreferred: "preferred",
    tagPreferredTip: "Automatic selection tries this account first.",
    acctRunning: "{0} running",
    acctPlanTip: "Subscription plan: {0}",
    acctSameAccountOne: "Same claude.ai account as {0} \u2014 one plan's limits for both",
    acctSameAccountMany: "Same claude.ai account as {0} \u2014 one plan's limits for all of them",
    acctStateOk: "Ready",
    acctStateExpired: "Logged out",
    acctStateError: "Account check failed",
    acctStateRefreshing: "Checking usage\u2026",
    acctStateNoLimits: "Logged in, no plan limits",
    acctStateLoggedIn: "Logged in",
    acctStateUnknown: "State unknown",
    acctStateCooling: "Cooling down",
    acctStateLimit: "At a plan limit",
    acctDefaultModel: "default {0}",
    acctModelCli: "model chosen by the CLI",
    acctModelCliDefault: "CLI default",
    acctLastRan: "last ran {0}",
    acctLastRanTip: "{0} is the model id the CLI of this account reported for its newest finished task that used the default.",
    acctChecked: "checked {0}",
    acctLoginOk: "Login ok \u00b7 checked {0}",
    acctLoginUnconfirmed: "Login not confirmed \u00b7 checking",
    acctLoginChecking: "Checking login",
    acctLoginProbeFailed: "Couldn't check the login \u2014 retrying",
    acctExpiredTitle: "Login expired",
    acctExpiredBody: "Dispatches to this account fail until you log in again.",
    acctExpiredBodyMain: "Plan usage cannot be read until you log in again.",
    acctExpiredBodyRun: "The last dispatch to this account failed on login. Dispatches skip it until one succeeds or you log in again.",
    acctErrorTitle: "The account check failed",
    acctErrorBody: "The CLI gave no reason.",
    acctNoLimitsBody: "This login is a token or API key, not a subscription, so there is no plan quota to show.",
    acctNoWindows: "No rate-limit windows were reported.",
    acctUsageLabel: "Plan usage",
    winPrimary: "Primary limit",
    winSecondary: "Secondary limit",
    winTotal: "Total usage",
    winAuto: "Auto + Composer",
    winApi: "API usage",
    winGeminiWeekly: "Gemini weekly",
    winGemini5h: "Gemini 5-hour",
    win3pWeekly: "Claude + GPT weekly",
    win3p5h: "Claude + GPT 5-hour",
    acctNoReading: "no reading",
    acctNoReadingBody: "No plan-usage reading for {0}. Dispatches run as usual.",
    acctNoReadingOff: "Usage readings for other providers are turned off in Settings.",
    acctOneShot: "one-shot only",
    acctOneShotTip: "{0} has no session workers. Dispatches to this account run one-shot and edit the working tree in place.",
    acctTempUnavailable: "Plan usage is temporarily unavailable. Last reading: {0}.",
    acctStale: "Showing the last reading, from {0}. The latest check returned no data.",
    acctCooldown: "Cooling down \u00b7 {0} left",
    acctCooldownTip: "Automatic selection skips this account until {0}, after a quota error.",
    acctOverageOn: "Extra usage on",
    acctOverageCap: "{0}% of cap",
    acctOverageTip: "This account bills real money once a plan window is used up.",
    stat5h: "Last 5 h",
    stat7d: "Last 7 d",
    statAll: "All time",
    statTasks: "{0} tasks",
    statTokens: "{0} tokens",
    statTokensTip: "Input {0} \u00b7 output {1}",
    statTokensNA: "tokens n/a",
    statTokensNATip: "No token counts were reported for these dispatches.",
    statCostTip: "Estimated cost the CLI reported for these dispatches.",
    statsTip: "Counts only work dispatched through this extension. The meters above show the real plan quota of the account.",
    acctNoDispatches: "No dispatches yet.",
    acctNotWorker: "Not a dispatch target. This is the account your editor session runs as.",
    acctFailures: "Failures: {0}",
    acctLastError: "Last failure: {0}",
    relogin: "Re-login",
    openSession: "Open session",
    openSessionTip: "Open a terminal running {0} as this account.",
    checkAgain: "Check again",
    checkLoginNow: "Check login now",
    moreActions: "More actions",
    moreActionsFor: "More actions for {0}",
    menuPrefer: "Prefer this account",
    menuUnprefer: "Stop preferring this account",
    menuDefaultModel: "Default model",
    menuModelCli: "Let the CLI choose",
    menuModelOther: "Other\u2026",
    menuPermission: "Permission / sandbox mode",
    menuPermCli: "CLI default",
    menuPermShared: "{0} \u00b7 change in Settings\u2026",
    menuPermSharedTip: "Every {0} worker uses the same permission mode. It is a setting, not a per-account choice.",
    menuRelogin: "Re-login\u2026",
    menuCheckLogin: "Check Login Now",
    menuRemove: "Remove account\u2026",
    meterPaceTip: "How far through this window the clock is. Usage ahead of the mark is being spent faster than the window refills.",
    resetsIn: "resets in {0}",
    resetsNow: "resetting now",
    severityWarning: "high",
    severityCritical: "at the limit",
    unsupportedTitle: "Registry entries this version cannot use: {0}",
    unsupportedBody: "This version of the extension cannot use these entries and leaves them in the registry untouched. A newer version may have written them. To delete one, use \"Remove Registry Entry\u2026\" on its row in the Worker Accounts view.",
    unsupportedUnnamed: "(unnamed entry)",
    onboardTitle: "Add your first worker account",
    onboardBody: "A worker is another account this session can hand tasks to. Each one brings its own plan quota.",
    onboardClis: "Supported CLIs: {0}.",
    onboardStepWorker: "Add or import a worker account",
    onboardStepMcp: "Set up dispatch in this workspace",
    onboardStepPolicy: "Add the dispatch policy to CLAUDE.md",
    teamTitle: "Team",
    teamWorking: "{0} working",
    teamWaiting: "{0} waiting",
    teamParked: "{0} parked",
    laneWorking: "Working",
    laneWaiting: "Waiting on you",
    laneParked: "Parked",
    laneWorkingEmpty: "Nothing is working right now.",
    laneWaitingEmpty: "Nothing is waiting on you.",
    laneParkedEmpty: "No parked sessions.",
    teamOffTitle: "Session workers are off",
    teamOffBody: "A session worker keeps a dispatched task running as a live Claude Code session in its own git worktree. You can attach to it, read its log and steer it with SendMessage while it works.",
    teamEnable: "Turn on session workers",
    teamEmptyTitle: "No live sessions in this workspace",
    teamEmptyTitleAll: "No live sessions on this machine",
    teamEmptyBody: "Session workers, native teammates and other Claude Code sessions appear here while they are alive.",
    teamUnsupportedTitle: "Session workers need Claude Code {0} or newer",
    teamUnsupportedBody: "This machine runs {0}. Dispatches still run as one-shot workers; update Claude Code to get live sessions.",
    sessCopyTip: "Copy {0}. It is the address SendMessage takes.",
    sessCopied: "Copied {0}",
    sessBusy: "working",
    sessBusyFor: "working {0}",
    sessWaiting: "waiting",
    sessWaitingFor: "waiting {0}",
    sessIdle: "idle",
    sessIdleFor: "idle {0}",
    sessStopped: "stopped",
    sessUnknown: "status unknown",
    sessNoTask: "No task recorded",
    sessTeammateNoTask: "Native teammate",
    sessPeerNoTask: "Claude Code session",
    sessWaitingOn: "Waiting for: {0}",
    srcWorker: "Session worker",
    srcWorkerTip: "A session this extension dispatched.",
    srcTeammate: "Teammate",
    srcTeammateRole: "Teammate \u00b7 {0}",
    srcTeammateOf: "{0} in {1}",
    srcTeammateTip: "A member of a native Claude Code agent team. Its team lead manages it.",
    srcPeer: "Peer session",
    srcPeerBackground: "Peer session \u00b7 background",
    srcPeerTip: "Another live Claude Code session here. No dispatch started it.",
    sessAccountTip: "Runs as the account {0}.",
    sessSettled: "result recorded",
    sessSettledTip: "The dispatch that started this session has finished and its result was recorded.",
    sessBranchTip: "Branch {0} in {1}",
    sessAttach: "Attach",
    sessAttachTip: "Open a terminal attached to this session.",
    sessLogs: "Logs",
    sessLogsTip: "Open a terminal showing the log of this session.",
    sessDiff: "Diff",
    sessDiffTip: "Show what the branch of this session changed.",
    sessStop: "Stop",
    sessStopTip: "Stop this session. A worktree that still holds work is kept. Asks first.",
    activityTitle: "Activity",
    activityRunning: "{0} running",
    rateLabel: "Success \u00b7 14 days",
    rateNone: "No finished tasks yet",
    rateNote: "{0} of {1} finished tasks succeeded",
    stripLabel: "Tasks per day",
    stripAria: "Last 14 days: {0} done, {1} failed, {2} cancelled",
    stripDayTip: "{0}: {1} done, {2} failed, {3} cancelled",
    filterStatusLabel: "Filter tasks by status",
    filterAll: "All",
    filterPlaceholder: "Filter by title, account, model\u2026",
    filterTextLabel: "Filter tasks by text",
    filterResult: "{0} of {1} match",
    filterClear: "Clear filters",
    filterProviderLabel: "Filter tasks by CLI",
    filterProviderHead: "CLI",
    statusRunning: "Running",
    statusDone: "Done",
    statusFailed: "Failed",
    statusCancelled: "Cancelled",
    statusOrphaned: "Orphaned",
    statusUnknown: "Unknown",
    modeOneshot: "one-shot",
    modeOneshotTip: "Ran as a single headless {0} run.",
    modeDetached: "detached",
    modeDetachedTip: "A one-shot run that keeps going after the dispatching session ends.",
    modeSession: "session",
    modeSessionTip: "Ran as a live session worker.",
    colStatus: "Status",
    colTask: "Task",
    colMode: "Mode",
    colAccount: "Account",
    colModel: "Model",
    colStarted: "Started",
    colDuration: "Duration",
    colTokens: "Tokens",
    tokensInOut: "{0} / {1}",
    tokensNA: "n/a",
    tokensNATip: "Session workers do not report token usage.",
    taskOpenTip: "Open the output of this task.",
    taskProviderTip: "Ran on {0}.",
    taskModelRan: "{0} \u2192 {1}",
    taskModelTipDispatch: "Asked for {0}, named by the dispatch.",
    taskModelTipWorker: "Asked for {0}, the default of the worker account.",
    taskModelTipCli: "No model was named, so the CLI used its own default.",
    taskModelTipDispatchAlone: "The model was named by the dispatch.",
    taskModelTipWorkerAlone: "The default of the worker account was used.",
    taskModelTipRan: "The CLI reported that it ran {0}.",
    taskCancel: "Cancel",
    taskCancelConfirm: "Cancel task?",
    taskDetails: "Details",
    detailError: "Error",
    detailPrompt: "Prompt",
    detailProvider: "CLI",
    detailModelRan: "Model that ran",
    detailModelSource: "Model source",
    modelSourceDispatch: "named by the dispatch",
    modelSourceWorker: "worker default",
    modelSourceCli: "CLI default",
    detailSession: "Session",
    detailBranch: "Branch",
    detailBranchUnmerged: "{0} (unmerged)",
    detailEnded: "Ended",
    detailTokens: "Tokens",
    detailTokensValue: "input {0} \u00b7 output {1}",
    detailCost: "Est. cost",
    detailId: "Task id",
    tasksEmptyTitle: "No dispatches in this workspace yet",
    tasksEmptyTitleAll: "No dispatches on this machine yet",
    tasksEmptyBody: "When your Claude Code session dispatches a task to a worker, it appears here with its status, duration and result.",
    tasksNoMatchTitle: "No task matches these filters",
    tasksNoMatchBody: "Try another filter, or clear them.",
    tasksShowMore: "Show {0} more \u00b7 {1} not shown",
    tasksCapped: "Showing the newest {0} of {1} tasks.",
    taskLogTitle: "The task log could not be read",
    taskLogBody: "Reason: {0}. Activity is hidden until the log is readable. This is not an empty history.",
    drawerClose: "Close settings",
    groupDispatch: "Dispatch",
    groupGuards: "Billing guards",
    groupGuardsNote: "Enforced by the dispatch server and shared by every editor on this machine.",
    groupSession: "Session workers",
    groupSessionNote: "Changes take effect at the next dispatch.",
    groupProviders: "Other providers",
    groupProvidersNote: "Worker accounts on the CLI of another vendor. A task goes to one only when the dispatch names that provider or worker.",
    groupSetup: "Setup",
    groupDanger: "Danger zone",
    setPermission: "Permission mode of Claude Code workers",
    setPermissionHint: "Workers cannot answer permission prompts, so a mode that asks stalls on the first edit. Workers on another CLI set theirs per account, in the menu of their card.",
    setPermissionBypassNote: "Session workers never start in bypassPermissions. They run with acceptEdits instead.",
    setClaudePath: "Claude CLI path",
    setClaudePathHint: "The claude executable every worker runs.",
    setClaudePathVersion: "Found: {0}",
    setClaudePathUnreadable: "No version could be read from this path.",
    setTaskTimeout: "Worker timeout (minutes)",
    setTaskTimeoutHint: "How long a dispatched worker may run before it is stopped. A single task can override this.",
    setCooldown: "Quota cooldown (minutes)",
    setCooldownHint: "How long an account sits out after a quota or rate-limit error.",
    setKeepalive: "Keep logins fresh",
    setKeepaliveHint: "Send one minimal request per subscription account each day so logins do not expire. Uses a negligible amount of plan quota.",
    setFrontier: "Frontier model dispatch",
    setFrontierHint: "Block rejects dispatches that ask for the frontier tier (fable), which may bill per use or draw a separate quota.",
    setOverage: "Overage dispatch",
    setOverageHint: "Block never sends work to an account that has used up its plan, even when extra usage is enabled there.",
    guardBlock: "Block",
    guardAllow: "Allow",
    guardInEffect: "In effect: {0}",
    guardMismatch: "In effect: {0}. Another editor set this. Choose a value here to take over.",
    guardMismatchBy: "In effect: {0}, set in {1}. Choose a value here to take over.",
    setMesh: "Run dispatches as session workers",
    setMeshHint: "Each task runs in its own git worktree as a live session you can attach to and steer. Detached tasks stay one-shot.",
    setMeshUnsupported: "Needs Claude Code {0} or newer; this machine runs {1}. Dispatches fall back to one-shot workers.",
    setMeshCap: "Session workers in flight",
    setMeshCapHint: "The most session workers that may have a dispatch still running. Dispatches past it are refused, not queued.",
    setMeshHistory: "Worker history limit",
    setMeshHistoryHint: "How many finished session workers the Worker History view keeps.",
    setProviderPolling: "Read usage from other providers",
    setProviderPollingHint: "On the usage refresh schedule, asks the CLI or usage service of each vendor for a plan-usage reading. Off, those accounts show their login state only.",
    provTableCaption: "What each CLI supports",
    provColProvider: "CLI",
    provColLogins: "Separate logins",
    provColSessions: "Session workers",
    provYes: "Yes",
    provNo: "No",
    provUnverified: "Not verified",
    provLoginsYesTip: "Each worker account can have its own login.",
    provLoginsUnverifiedTip: "A separate home directory is accepted, but a second login there is not confirmed to work.",
    provLoginsNoTip: "One login per machine, so one worker account.",
    provSessionsYesTip: "Dispatches can run as live sessions you attach to and steer.",
    provSessionsNoTip: "Dispatches run one-shot and edit the working tree in place.",
    addWorkerOther: "Add a worker on another CLI",
    setupMcp: "Dispatch server",
    setupMcpHint: "Adds cco-dispatch to .mcp.json so the Claude session here can dispatch.",
    setupPolicy: "Dispatch policy",
    setupPolicyHint: "Adds the orchestration policy block to CLAUDE.md.",
    setupAgent: "Team proxy agent",
    setupAgentHint: "Installs the cco-worker agent, which puts a worker account into a native agent team.",
    setupDone: "Installed",
    setupMissing: "Not installed",
    setupOutdated: "Differs from this version",
    setupPolicyUpdate: "Update Dispatch Policy",
    setupNoWorkspace: "Open a folder first",
    setupRegister: "Register",
    setupRegisterAgain: "Register again",
    setupAdd: "Add",
    setupUpdate: "Update",
    setupInstall: "Install",
    setupWorkspace: "Update Workspace Setup",
    setupWorkspaceTip: "Look at what this workspace has installed \u2014 the dispatch policy, the team proxy agent, the permission rules for the cco command, the MCP registration \u2014 and update what you check.",
    manageAssets: "Manage assets",
    cleanLitter: "Clean up stale session files",
    cleanLitterTip: "Remove the session files that usage probes of earlier versions left behind.",
    openSettings: "All extension settings",
    dangerCancelAll: "Cancel all running",
    dangerCancelAllHint: "Stops every running task in every workspace. Asks first.",
    dangerClearTasks: "Clear task history",
    dangerClearTasksHint: "Empties the task log on this machine. Asks first.",
    dangerResetCheckin: "Reset check-in",
    dangerResetCheckinHint: "Forgets which model orchestrates this workspace. Use it after switching the main account. Asks first.",
    saving: "Saving\u2026",
    saveConfirming: "Waiting for your answer in the dialog\u2026",
    saved: "Saved",
    saveFailed: "Not saved: {0}",
    saveFailedUnknown: "the editor gave no reason",
    saveNoAnswer: "Not saved: the editor did not answer.",
    fieldIntRange: "Enter a whole number from {0} to {1}.",
    fieldTextEmpty: "Enter a path.",
  };
  /* <strings:end> */

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /** Deterministic pseudo-random numbers, so two loads of a fixture look the same. */
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function stats(tasks, inputTokens, outputTokens, costUsd) {
    return { tasks: tasks, inputTokens: inputTokens, outputTokens: outputTokens, costUsd: costUsd };
  }

  /** A copy of what src/providers.ts says about each CLI, in the shape the model carries. */
  const PROVIDERS = [
    { id: 'claude', label: 'Claude Code', models: ['opus', 'sonnet', 'haiku', 'fable'], permissionModes: ['acceptEdits', 'auto', 'dontAsk', 'plan', 'default', 'bypassPermissions'], isolation: 'env', isolationVerified: true, sessionWorkers: true },
    { id: 'codex', label: 'Codex', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], permissionModes: ['workspace-write', 'read-only', 'danger-full-access'], isolation: 'env', isolationVerified: true, sessionWorkers: false },
    { id: 'cursor', label: 'Cursor', models: ['auto', 'composer-2.5'], permissionModes: ['enabled', 'disabled'], isolation: 'none', isolationVerified: false, sessionWorkers: false },
    { id: 'gemini', label: 'Antigravity', models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'], permissionModes: ['accept-edits', 'plan'], isolation: 'env', isolationVerified: false, sessionWorkers: false },
  ];
  function providers() {
    return JSON.parse(JSON.stringify(PROVIDERS));
  }

  function account(over) {
    const base = {
      key: 'k-' + over.name,
      name: over.name,
      isMain: false,
      isWorker: true,
      preferred: false,
      defaultModel: 'opus',
      provider: 'claude',
      providerLabel: 'Claude Code',
      sessionWorkers: true,
      permissionMode: null,
      // What the default last ran as; null until a finished task of the account reported it.
      modelRanAs: null,
      login: 'ok',
      loginDetail: null,
      plan: 'max',
      planLabel: null,
      sameAccountAs: [],
      windows: [],
      windowsStaleSince: null,
      lastGoodWindowsAt: null,
      usageFetchedAt: Date.now() - 2 * MIN,
      overage: null,
      cooldownUntil: null,
      session5h: stats(0, 0, 0, 0),
      week: stats(0, 0, 0, 0),
      allTime: Object.assign(stats(0, 0, 0, 0), { errors: 0 }),
      lastError: null,
      running: 0,
    };
    return Object.assign(base, over);
  }

  /** An account on another vendor's CLI: one-shot only, with that CLI's own model and mode. */
  function providerAccount(id, over) {
    const info = PROVIDERS.filter(function (p) { return p.id === id; })[0];
    return account(Object.assign({ provider: id, providerLabel: info.label, sessionWorkers: false, defaultModel: null, plan: null }, over));
  }

  function win(kind, label, percent, severity, resetsInMs) {
    return { kind: kind, label: label, percent: percent, severity: severity, resetsAt: resetsInMs === null ? null : Date.now() + resetsInMs };
  }

  function session(over) {
    const base = {
      key: 'worker:' + over.name,
      source: 'worker',
      name: over.name,
      accountKey: 'k-atlas',
      accountName: 'atlas',
      kind: 'background',
      status: 'busy',
      detail: null,
      taskId: null,
      taskTitle: null,
      model: 'opus',
      startedAt: Date.now() - 10 * MIN,
      updatedAt: Date.now() - 20 * 1000,
      location: null,
      branch: null,
      unmerged: false,
      settled: false,
      inWorkspace: true,
      canAttach: true,
      canStop: true,
      team: null,
      role: null,
    };
    return Object.assign(base, over);
  }

  function settings(over) {
    const base = {
      workerPermissionMode: 'acceptEdits',
      permissionModes: ['acceptEdits', 'auto', 'dontAsk', 'plan', 'default', 'bypassPermissions'],
      claudePath: 'claude',
      quotaCooldownMinutes: 30,
      workerTimeoutMinutes: 45,
      frontierWorkerDispatch: { value: 'block', effective: 'block', setBy: null },
      overageWorkerDispatch: { value: 'block', effective: 'block', setBy: null },
      meshMode: true,
      meshMaxLiveWorkers: 8,
      meshHistoryLimit: 50,
      sessionKeepalive: false,
      workerModels: ['opus', 'sonnet', 'haiku', 'fable'],
      providerUsagePolling: true,
      providers: providers(),
    };
    return Object.assign(base, over || {});
  }

  function health(over) {
    const base = {
      claudeVersion: '2.1.283 (Claude Code)',
      sessionWorkersSupported: true,
      sessionWorkersMinVersion: '2.1.283',
      taskLogProblem: null,
      registryProblem: null,
      mcpInstalled: true,
      policyInstalled: true,
      // A block is there and is this version's. Where a fixture has no block (or no folder)
      // it says null, as the host does: only a block that is there can be out of date.
      policyOutdated: false,
      teamAgentInstalled: true,
      // The session here can dispatch (cco with this version's policy, or the MCP server); a
      // fixture that cannot says false, and the fix is the command the host names.
      canDispatch: true,
      dispatchFix: 'updateWorkspaceSetup',
    };
    return Object.assign(base, over || {});
  }

  function emptyDaily() {
    const today = startOfDay(Date.now());
    const out = [];
    for (let i = 13; i >= 0; i--) {
      out.push({ day: today - i * DAY, done: 0, failed: 0, cancelled: 0 });
    }
    return out;
  }

  const TITLES = [
    'Implement the settings drawer focus trap',
    'Adversarial review: registry reconcile path',
    'Port usage probe to graceful termination',
    'Write contract tests for validateSetting',
    'Fix flaky transcript tail test',
    'Draft CHANGELOG for 2.0.0',
    'Refactor mesh pool liveness to job ids',
    'Document the team proxy agent',
    'Add path-boundary scoping for Windows',
    'Design consult: dashboard data contract',
    'Translate package.nls to Korean and Simplified Chinese',
    'Prune leaked session files in batches',
    'Review: one-shot fallback messaging',
    'Benchmark task-log parse cache',
    'Wire Team view refresh to ledger changes',
    'Harden the MCP protocol negotiation',
  ];
  const WORKERS = ['atlas', 'borealis', 'cascade', 'delta-api', 'atlas', 'atlas', 'borealis', 'atlas, borealis'];
  const MODELS = ['opus', 'opus', 'sonnet', 'opus', 'fable', 'sonnet'];
  const FAILURES = [
    'worker reported failure: 3 tests failed in src/mesh/pool.test.ts (expected inFlightCount 1, got 2)',
    'timeout after 45 minutes - the worker was stopped',
    'worker ended its turn without writing the result file - attach with: claude attach 3fa9c2d1',
    'claude exited: Workspace not trusted. Run `claude` in the workspace once and accept the trust prompt, then retry.',
  ];

  /**
   * Workers on other CLIs: one-shot or detached only, and each reports what its CLI reports.
   * `-` is a task that named no model: `cliDefault` is what that CLI then reported it ran.
   */
  const FOREIGN = [
    { worker: 'codex-main', provider: 'codex', models: ['gpt-5.6-sol', 'gpt-5.6-terra'], tokens: true },
    { worker: 'cursor', provider: 'cursor', models: ['composer-2.5', '-'], tokens: false, cliDefault: 'composer-2.5' },
    { worker: 'agy-lab', provider: 'gemini', models: ['gemini-3.8-flash-high'], tokens: true },
  ];

  /** The default model of each fixture worker, as the accounts of `rich` carry it. */
  const DEFAULTS = { atlas: 'opus', borealis: 'sonnet', cascade: 'opus', 'delta-api': 'opus', 'codex-main': 'gpt-5.6-sol', 'agy-lab': 'gemini-3.8-flash-high' };
  /** What the Claude Code CLI of these fixtures resolves an alias to. */
  const RAN_AS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };

  /**
   * Where a task's model came from and what ran, as the host reports them. The source is the
   * worker's default when the task asked for exactly that, the CLI when it named none, else
   * the dispatch. What RAN is known only for a finished run whose CLI reported it: never for a
   * session worker, and never for a run on another CLI that named its model (those adapters
   * echo the request). The oldest fifth of a list was logged before either was recorded.
   */
  function modelFacts(i, count, task, foreign) {
    if (i >= count * 0.8) {
      return { modelUsed: null, modelSource: null };
    }
    const finished = task.status === 'done';
    if (foreign) {
      const named = task.model !== '-';
      return {
        modelSource: !named ? 'cli' : task.model === DEFAULTS[task.worker] ? 'worker' : 'dispatch',
        modelUsed: !named && finished && foreign.cliDefault ? foreign.cliDefault : null,
      };
    }
    return {
      modelSource: task.model === DEFAULTS[task.worker] ? 'worker' : 'dispatch',
      modelUsed: finished && task.mode !== 'session' && RAN_AS[task.model] ? RAN_AS[task.model] : null,
    };
  }

  /**
   * `count` tasks, newest first, with a believable mix of statuses, modes and ages. `mixed`
   * hands roughly one task in seven to a worker on another CLI.
   */
  function makeTasks(count, seed, mixed) {
    const rnd = prng(seed);
    const now = Date.now();
    const tasks = [];
    let cursor = now - 4 * MIN;
    for (let i = 0; i < count; i++) {
      const roll = rnd();
      let status = 'done';
      if (i < 3) {
        status = 'running';
      } else if (roll < 0.07) {
        status = 'failed';
      } else if (roll < 0.1) {
        status = 'cancelled';
      } else if (roll < 0.115) {
        status = 'orphaned';
      }
      // The pick is drawn for every task so that both variants walk the same random sequence.
      const foreignRoll = rnd();
      const foreignPick = FOREIGN[Math.floor(rnd() * FOREIGN.length)];
      const foreign = mixed && (i === 2 || i === 4 || i === 6 || foreignRoll < 0.14) ? (i === 2 ? FOREIGN[0] : foreignPick) : null;
      let mode = i === 2 ? 'detached' : rnd() < 0.55 ? 'session' : rnd() < 0.85 ? 'oneshot' : 'detached';
      if (foreign && mode === 'session') {
        mode = 'oneshot';
      }
      const lasted = Math.round((2 + rnd() * 34) * MIN);
      const endedAt = status === 'running' ? null : cursor;
      const startedAt = status === 'running' ? now - Math.round((1 + i * 5.5) * MIN + rnd() * 40000) : cursor - lasted;
      const claudeWorker = WORKERS[Math.floor(rnd() * WORKERS.length)];
      const worker = foreign ? foreign.worker : claudeWorker;
      const session = mode === 'session';
      const reports = !session && status !== 'running' && (!foreign || foreign.tokens);
      const id = 't' + (1000000 + i * 7919).toString(36) + 'abcd';
      tasks.push({
        id: id,
        title: TITLES[i % TITLES.length] + (i >= TITLES.length ? ' (' + (Math.floor(i / TITLES.length) + 1) + ')' : ''),
        status: status,
        mode: mode,
        worker: worker,
        model: foreign ? foreign.models[i % foreign.models.length] : MODELS[Math.floor(rnd() * MODELS.length)],
        startedAt: startedAt,
        endedAt: endedAt,
        inputTokens: reports ? Math.round(40000 + rnd() * 900000) : null,
        outputTokens: reports ? Math.round(4000 + rnd() * 60000) : null,
        costUsd: reports && !foreign ? Math.round(rnd() * 400) / 100 : null,
        error:
          status === 'failed'
            ? FAILURES[Math.floor(rnd() * FAILURES.length)]
            : status === 'cancelled'
              ? 'cancelled by user'
              : status === 'orphaned'
                ? 'orphaned - worker process is no longer running'
                : null,
        promptPreview: 'You are a senior engineer implementing one task of a multi-worker build. Read the contract first, then: ' + TITLES[i % TITLES.length].toLowerCase() + '. Own exactly the files listed; report outcome first.',
        inWorkspace: true,
        hasOutput: status !== 'running',
        sessionWorker: session ? 'cco-w-3fa9-' + worker.split(',')[0] + '-' + ((i % 4) + 1) : null,
        branch: session ? 'worktree-cco-' + id : null,
        unmerged: session && status === 'done' && rnd() < 0.2,
        provider: foreign ? foreign.provider : null,
      });
      Object.assign(tasks[i], modelFacts(i, count, tasks[i], foreign));
      if (status !== 'running') {
        // Older and older: a few per hour at first, then spread over two weeks.
        cursor -= Math.round((i < 30 ? 9 + rnd() * 40 : 30 + rnd() * 110) * MIN);
      }
    }
    // Two cases the draw above never produces, on the newest finished one-shot runs of Claude
    // Code: an alias of the cheapest tier, and a full id - which ran as itself.
    const plain = tasks.filter(function (t) { return t.status === 'done' && t.mode !== 'session' && t.provider === null && t.modelSource !== null; });
    if (plain.length > 3) {
      Object.assign(plain[1], { model: 'haiku', modelSource: 'dispatch', modelUsed: RAN_AS.haiku });
      Object.assign(plain[3], { model: RAN_AS.opus, modelSource: 'dispatch', modelUsed: RAN_AS.opus });
    }
    return tasks;
  }

  function dailyFrom(tasks) {
    const buckets = emptyDaily();
    const first = buckets[0].day;
    tasks.forEach(function (t) {
      if (t.endedAt === null) {
        return;
      }
      const at = Math.floor((startOfDay(t.endedAt) - first) / DAY);
      if (at < 0 || at >= buckets.length) {
        return;
      }
      if (t.status === 'done') {
        buckets[at].done += 1;
      } else if (t.status === 'cancelled') {
        buckets[at].cancelled += 1;
      } else {
        buckets[at].failed += 1;
      }
    });
    return buckets;
  }

  /* ---------------------------------------------------------------- rich */

  /**
   * `mixed` adds the accounts and tasks of the other three CLIs. They are listed BETWEEN the
   * Claude Code workers, the way a registry that grew over time would hold them, so the
   * page's own ordering (main, then one CLI after another) is what the preview shows.
   */
  function rich(mixed) {
    const now = Date.now();
    const tasks = makeTasks(300, 20261013, mixed);
    const model = {
      schema: 2,
      generatedAt: now,
      workspace: 'fable-orchestrator',
      scope: 'workspace',
      orchestrator: { model: 'claude-opus-5-5', calibrated: true, briefedAt: now - 12 * MIN, lastSeenAt: now - 20 * 1000 },
      health: health({ policyInstalled: false, policyOutdated: null, teamAgentInstalled: false }),
      accounts: [
        account({
          name: 'main',
          isMain: true,
          isWorker: false,
          defaultModel: null,
          // The plan as the CLI names it, in place of the reading's word.
          planLabel: 'Claude Max',
          windows: [
            win('session', 'Session (5hr)', 41, 'normal', 2 * HOUR + 10 * MIN),
            win('weekly_all', 'Weekly (7 day)', 63, 'normal', 3 * DAY + 4 * HOUR),
            win('weekly_scoped', 'Weekly Fable', 12, 'normal', 3 * DAY + 4 * HOUR),
          ],
        }),
        account({
          name: 'atlas',
          preferred: true,
          running: 2,
          modelRanAs: RAN_AS.opus,
          windows: [
            win('session', 'Session (5hr)', 72, 'warning', 1 * HOUR + 5 * MIN),
            win('weekly_all', 'Weekly (7 day)', 38, 'normal', 5 * DAY + 2 * HOUR),
            win('weekly_scoped', 'Weekly Fable', 4, 'normal', 5 * DAY + 2 * HOUR),
          ],
          session5h: stats(3, 181200, 42100, 2.4),
          week: stats(41, 2140000, 482000, 31.6),
          allTime: Object.assign(stats(310, 18400000, 4100000, 212.4), { errors: 4 }),
          lastError: 'worker reported failure: 3 tests failed in src/mesh/pool.test.ts',
          sameAccountAs: ['atlas-2'],
        }),
        // A second directory signed in to the same claude.ai account as atlas: the same plan,
        // the same windows - each card says so, and the page has one notice for the pair.
        account({
          name: 'atlas-2',
          defaultModel: 'sonnet',
          windows: [
            win('session', 'Session (5hr)', 72, 'warning', 1 * HOUR + 5 * MIN),
            win('weekly_all', 'Weekly (7 day)', 38, 'normal', 5 * DAY + 2 * HOUR),
            win('weekly_scoped', 'Weekly Fable', 4, 'normal', 5 * DAY + 2 * HOUR),
          ],
          week: stats(4, 120000, 31000, 1.9),
          allTime: Object.assign(stats(11, 610000, 140000, 8.2), { errors: 0 }),
          sameAccountAs: ['atlas'],
        }),
        account({
          name: 'borealis',
          defaultModel: 'sonnet',
          modelRanAs: RAN_AS.sonnet,
          plan: 'pro',
          windows: [
            win('session', 'Session (5hr)', 100, 'critical', 38 * MIN),
            win('weekly_all', 'Weekly (7 day)', 91, 'warning', 1 * DAY + 6 * HOUR),
          ],
          cooldownUntil: now + 12 * MIN + 30 * 1000,
          overage: { enabled: true, percent: 6, spendLabel: '$3.20 / $50.00' },
          session5h: stats(9, 912000, 120400, 8.1),
          week: stats(58, 4020000, 733000, 44.9),
          allTime: Object.assign(stats(122, 9100000, 1700000, 96.02), { errors: 11 }),
          lastError: 'rate limit reached - 5-hour window exhausted',
        }),
        account({
          name: 'cascade',
          login: 'expired',
          modelRanAs: RAN_AS.opus,
          lastGoodWindowsAt: now - 3 * HOUR,
          usageFetchedAt: now - 4 * MIN,
          week: stats(12, 640000, 88000, 6.3),
          allTime: Object.assign(stats(57, 3300000, 512000, 38.75), { errors: 2 }),
        }),
        // Logged in with no reading (a token login) AND in a cooldown: the card says
        // "Cooling down", and the heading counts it there, not under "ready".
        account({
          name: 'delta-api',
          login: 'no-plan-limits',
          plan: null,
          modelRanAs: RAN_AS.opus,
          cooldownUntil: now + 7 * MIN + 15 * 1000,
          session5h: stats(1, 22000, 3100, 0.31),
          week: stats(6, 310000, 41000, 4.2),
          allTime: Object.assign(stats(19, 1010000, 150000, 13.9), { errors: 0 }),
        }),
        account({
          name: 'echo',
          defaultModel: 'fable',
          windows: [win('session', 'Session (5hr)', 22, 'normal', 3 * HOUR + 40 * MIN), win('weekly_all', 'Weekly (7 day)', 54, 'normal', 2 * DAY + 9 * HOUR)],
          windowsStaleSince: now - 9 * MIN,
          lastGoodWindowsAt: now - 9 * MIN,
          usageFetchedAt: now - 1 * MIN,
          allTime: Object.assign(stats(8, 400000, 51000, 5.1), { errors: 0 }),
        }),
        account({ name: 'foxtrot', login: 'error', loginDetail: 'timeout', plan: null, usageFetchedAt: now - 40 * 1000 }),
        // No reading yet: still being checked, and counted as that.
        account({ name: 'golf', login: 'refreshing', plan: null, usageFetchedAt: null }),
      ],
      tasks: tasks,
      taskTotal: 1284,
      running: { workspace: 3, all: 5 },
      daily: dailyFrom(tasks),
      sessions: [
        session({
          name: 'cco-w-3fa9-atlas-2',
          taskId: tasks[0].id,
          taskTitle: 'Implement the settings drawer focus trap',
          startedAt: now - 12 * MIN - 4000,
          location: '.claude/worktrees/cco-tm4k2x9q',
          branch: 'worktree-cco-tm4k2x9q',
          unmerged: true,
        }),
        session({
          name: 'cco-w-3fa9-atlas-3',
          taskId: tasks[1].id,
          taskTitle: 'Adversarial review: registry reconcile path',
          model: 'fable',
          startedAt: now - 3 * MIN - 21000,
          location: '.claude/worktrees/cco-tq81mmd0',
          branch: 'worktree-cco-tq81mmd0',
          unmerged: true,
        }),
        session({
          key: 'teammate:researcher',
          source: 'teammate',
          name: 'researcher',
          accountKey: 'k-main',
          accountName: 'main',
          kind: 'teammate',
          taskTitle: null,
          model: 'sonnet',
          startedAt: now - 31 * MIN,
          canAttach: false,
          canStop: false,
          team: 'release-2-0',
          role: 'general-purpose',
        }),
        session({
          name: 'cco-w-3fa9-borealis-1',
          accountKey: 'k-borealis',
          accountName: 'borealis',
          status: 'waiting',
          detail: 'permission to run `npm test`',
          taskTitle: 'Fix flaky transcript tail test',
          model: 'sonnet',
          updatedAt: now - 4 * MIN - 10000,
          location: '.claude/worktrees/cco-t9z0aa31',
          branch: 'worktree-cco-t9z0aa31',
          unmerged: true,
        }),
        session({
          name: 'cco-w-3fa9-atlas-1',
          status: 'idle',
          settled: true,
          taskTitle: 'Draft CHANGELOG for 2.0.0',
          updatedAt: now - 25 * MIN,
          location: '.claude/worktrees/cco-t3c77k2p',
          branch: 'worktree-cco-t3c77k2p',
          unmerged: true,
        }),
        session({
          name: 'cco-w-3fa9-cascade-4',
          accountKey: 'k-cascade',
          accountName: 'cascade',
          status: 'stopped',
          settled: true,
          taskTitle: 'Port usage probe to graceful termination',
          updatedAt: now - 3 * HOUR,
          branch: 'worktree-cco-t1b55x0e',
          unmerged: true,
          canAttach: false,
          canStop: false,
        }),
        session({
          key: 'teammate:cco-worker',
          source: 'teammate',
          name: 'cco-worker',
          accountKey: 'k-main',
          accountName: 'main',
          kind: 'teammate',
          status: 'idle',
          model: 'haiku',
          updatedAt: now - 6 * MIN,
          canAttach: false,
          canStop: false,
          team: 'release-2-0',
          role: 'cco-worker',
        }),
        session({
          key: 'peer:main:4411:9c0d2e11',
          source: 'peer',
          name: 'vscode-panel',
          accountKey: 'k-main',
          accountName: 'main',
          kind: 'interactive',
          status: 'idle',
          model: null,
          updatedAt: now - 50 * 1000,
          location: 'fable-orchestrator',
          canAttach: false,
          canStop: false,
        }),
      ],
      settings: settings({ frontierWorkerDispatch: { value: 'block', effective: 'allow', setBy: 'Cursor' } }),
    };
    if (!mixed) {
      return model;
    }
    const foreign = [
      // A reading WITH windows from another CLI: the same gauges as a Claude Code account.
      // The labels are what the Codex adapter really reports - two bare technical words, which
      // the page shows as "Primary limit" / "Secondary limit".
      [
        2,
        providerAccount('codex', {
          name: 'codex-main',
          defaultModel: 'gpt-5.6-sol',
          permissionMode: 'workspace-write',
          plan: 'chatgpt',
          running: 1,
          windows: [win('session', 'primary', 34, 'normal', 3 * HOUR + 12 * MIN), win('weekly_all', 'secondary', 81, 'warning', 2 * DAY + 5 * HOUR)],
          session5h: stats(2, 96400, 15200, 0),
          week: stats(17, 1210000, 204000, 0),
          allTime: Object.assign(stats(44, 3320000, 571000, 0), { errors: 1 }),
        }),
      ],
      // Logged in, and no reading at all: no gauges, no zeroes - and ready all the same. It
      // has no default model, so what is known is what the CLI's own default last ran as.
      [
        4,
        providerAccount('cursor', {
          name: 'cursor',
          login: 'no-plan-limits',
          plan: 'cursor',
          modelRanAs: 'composer-2.5',
          week: stats(9, 0, 0, 0),
          allTime: Object.assign(stats(23, 0, 0, 0), { errors: 2 }),
          lastError: 'cursor-agent exited 1: The model composer-9 is not available on your plan',
        }),
      ],
      // A Cursor reading WITH windows: the adapter reports three bare words, each a percentage
      // of the billing period ending at the same reset - all usage, Auto + Composer, the other
      // models - and the page shows them as "Total usage" / "Auto + Composer" / "API usage".
      [
        5,
        providerAccount('cursor', {
          name: 'cursor-team',
          defaultModel: 'auto',
          permissionMode: 'enabled',
          plan: 'cursor',
          windows: [win('session', 'total', 58, 'normal', 11 * DAY + 4 * HOUR), win('weekly_all', 'auto', 41, 'normal', 11 * DAY + 4 * HOUR), win('weekly_scoped', 'api', 88, 'warning', 11 * DAY + 4 * HOUR)],
          week: stats(6, 0, 0, 0),
          allTime: Object.assign(stats(31, 0, 0, 0), { errors: 0 }),
        }),
      ],
      // Logged out: as loud as a logged-out Claude Code account. This one was found out by a
      // RUN that failed on login (the host's marker in loginDetail), and the card says so.
      [
        6,
        providerAccount('gemini', {
          name: 'agy-lab',
          login: 'expired',
          loginDetail: 'the last run failed on login',
          defaultModel: 'gemini-3.8-flash-high',
          permissionMode: 'accept-edits',
          usageFetchedAt: now - 6 * MIN,
          allTime: Object.assign(stats(12, 804000, 96000, 0), { errors: 3 }),
          lastError: 'agy: not signed in - open Antigravity and sign in',
        }),
      ],
      // The CLI itself is missing: the status check fails and says so.
      [
        7,
        providerAccount('codex', {
          name: 'codex-ci',
          login: 'error',
          loginDetail: 'CLI not found \u2014 codex is not installed or not on PATH',
          permissionMode: 'read-only',
          usageFetchedAt: now - 50 * 1000,
        }),
      ],
    ];
    // Highest index first, so each insert lands where its number says.
    foreign.reverse().forEach(function (pair) {
      model.accounts.splice(pair[0], 0, pair[1]);
    });
    return model;
  }

  /* --------------------------------------------------------------- empty */

  function empty() {
    const now = Date.now();
    return {
      schema: 2,
      generatedAt: now,
      workspace: 'new-project',
      scope: 'workspace',
      orchestrator: null,
      health: health({ mcpInstalled: false, policyInstalled: false, policyOutdated: null, teamAgentInstalled: false, canDispatch: false }),
      accounts: [
        account({
          name: 'main',
          isMain: true,
          isWorker: false,
          defaultModel: null,
          windows: [win('session', 'Session (5hr)', 8, 'normal', 4 * HOUR + 20 * MIN), win('weekly_all', 'Weekly (7 day)', 17, 'normal', 6 * DAY)],
        }),
      ],
      tasks: [],
      taskTotal: 0,
      running: { workspace: 0, all: 0 },
      daily: emptyDaily(),
      sessions: [],
      settings: settings({ meshMode: false }),
    };
  }

  /* ------------------------------------------------- all logins expired */

  function allExpired() {
    const now = Date.now();
    const tasks = makeTasks(9, 77).map(function (t, i) {
      if (i < 5) {
        t.status = 'failed';
        t.endedAt = now - (i + 1) * 9 * MIN;
        t.startedAt = t.endedAt - 20000;
        t.mode = 'oneshot';
        t.sessionWorker = null;
        t.branch = null;
        t.unmerged = false;
        t.inputTokens = null;
        t.outputTokens = null;
        t.costUsd = null;
        t.hasOutput = true;
        t.error = 'claude exited: Invalid API key - Please run /login';
        // A run that failed on login reported no model.
        t.modelUsed = null;
      }
      return t;
    });
    const dead = function (name, over) {
      return account(Object.assign({ name: name, login: 'expired', usageFetchedAt: now - 3 * MIN, lastGoodWindowsAt: now - 26 * HOUR }, over || {}));
    };
    return {
      schema: 2,
      generatedAt: now,
      workspace: 'fable-orchestrator',
      scope: 'workspace',
      orchestrator: { model: 'claude-fable-5-1', calibrated: false, briefedAt: now - 2 * HOUR, lastSeenAt: now - 9 * MIN },
      health: health(),
      accounts: [
        dead('main', { isMain: true, isWorker: false, defaultModel: null }),
        dead('atlas', { preferred: true, allTime: Object.assign(stats(310, 18400000, 4100000, 212.4), { errors: 9 }), lastError: 'claude exited: Invalid API key - Please run /login' }),
        dead('borealis', { defaultModel: 'sonnet', plan: 'pro', allTime: Object.assign(stats(122, 9100000, 1700000, 96.02), { errors: 14 }) }),
        dead('cascade', { allTime: Object.assign(stats(57, 3300000, 512000, 38.75), { errors: 3 }) }),
      ],
      tasks: tasks,
      taskTotal: tasks.length,
      running: { workspace: 0, all: 0 },
      daily: dailyFrom(tasks),
      sessions: [
        session({
          name: 'cco-w-3fa9-atlas-7',
          status: 'waiting',
          detail: 'blocked - Login expired',
          taskTitle: 'Benchmark task-log parse cache',
          updatedAt: now - 14 * MIN,
          branch: 'worktree-cco-tz81aa02',
          unmerged: true,
        }),
      ],
      settings: settings(),
    };
  }

  /* --------------------------------------------------------- no workspace */

  function noWorkspace() {
    const model = empty();
    model.workspace = null;
    model.health = health({ mcpInstalled: null, policyInstalled: null, policyOutdated: null, teamAgentInstalled: null, canDispatch: null });
    model.accounts.push(
      account({
        name: 'atlas',
        windows: [win('session', 'Session (5hr)', 30, 'normal', 2 * HOUR), win('weekly_all', 'Weekly (7 day)', 44, 'normal', 4 * DAY)],
        allTime: Object.assign(stats(310, 18400000, 4100000, 212.4), { errors: 4 }),
      }),
    );
    model.settings = settings();
    return model;
  }

  /* ----------------------------- old CLI + unreadable task log (failure paths) */

  function degraded() {
    const model = rich(true);
    model.health = health({
      claudeVersion: '2.1.200 (Claude Code)',
      sessionWorkersSupported: false,
      taskLogProblem: 'too-large: tasks.jsonl is 71 MiB, over the 64 MiB read cap',
      // The one fixture with a policy block that is another version's, or was edited.
      policyOutdated: true,
    });
    model.tasks = [];
    model.taskTotal = 0;
    model.daily = emptyDaily();
    model.sessions = [];
    model.running = { workspace: 0, all: 0 };
    return model;
  }

  /* -------------------------------------------------------------- hostile */

  function hostile() {
    const now = Date.now();
    const RLO = String.fromCharCode(0x202e);
    const LRI = String.fromCharCode(0x2066);
    const PDI = String.fromCharCode(0x2069);
    const PDF = String.fromCharCode(0x202c);
    const ZWSP = String.fromCharCode(0x200b);
    const NUL = String.fromCharCode(0);
    const LSEP = String.fromCharCode(0x2028);
    // Each payload, if it ever became markup or script, would set this flag; the preview bar
    // reads it back and says so.
    const IMG = '<img src=x onerror="window.__CCO_XSS__=1">';
    const SCRIPT = '<script>window.__CCO_XSS__=1</script>';
    const SVG = '"><svg onload=window.__CCO_XSS__=1>';
    const ATTR = '\' autofocus onfocus=window.__CCO_XSS__=1 x=\'';
    const LONG = 'A'.repeat(5000);
    const LONG_WORDS = new Array(700).join('lorem <b>ipsum</b> ');
    const BIDI = 'invoice' + RLO + 'fdp.exe' + PDF + ' ' + LRI + 'isolated' + PDI + ZWSP + NUL + LSEP + 'end';

    return {
      schema: 2,
      generatedAt: 'now',
      workspace: IMG + ' ' + LONG,
      scope: 'everything',
      orchestrator: { model: SCRIPT, calibrated: 'yes', briefedAt: NaN, lastSeenAt: -5 },
      health: {
        claudeVersion: SVG,
        sessionWorkersSupported: 'true',
        sessionWorkersMinVersion: IMG,
        taskLogProblem: null,
        registryProblem: IMG + ' ' + BIDI + ' ' + LONG,
        mcpInstalled: 1,
        policyInstalled: 'false',
        policyOutdated: IMG,
        teamAgentInstalled: { installed: true },
        canDispatch: 'false',
        dispatchFix: IMG,
      },
      unsupportedAccounts: [
        null,
        'an entry',
        7,
        [],
        { name: IMG, detail: SCRIPT },
        { name: SVG + ATTR, detail: 'unsupported provider "' + IMG + '"' },
        { name: LONG, detail: LONG_WORDS },
        { name: BIDI, detail: 9 },
        { name: '', detail: 'incomplete entry' },
        { name: null, detail: null },
        { name: { toString: 'x' }, detail: ['duplicate name'] },
        {},
        { name: '__proto__', detail: 'duplicate name' },
      ].concat(
        // Far more than the 20 the host ever sends: the page shows a bounded number.
        new Array(40).join('x').split('').map(function (_x, i) {
          return { name: 'flood-entry-' + i, detail: 'incomplete entry' };
        }),
      ),
      accounts: [
        null,
        'an account',
        42,
        account({
          key: IMG,
          name: IMG,
          plan: SCRIPT,
          defaultModel: SVG,
          provider: IMG,
          providerLabel: SCRIPT,
          sessionWorkers: 'yes',
          permissionMode: SVG,
          loginDetail: SCRIPT,
          windows: [
            { kind: 'session', label: IMG, percent: '72', severity: 'critical', resetsAt: 'tomorrow' },
            { kind: 'weekly_all', label: BIDI, percent: NaN, severity: SCRIPT, resetsAt: NaN },
            { kind: 'weekly_scoped', label: LONG, percent: 250, severity: 'warning', resetsAt: -1 },
            { kind: SCRIPT, label: 'negative', percent: -40, severity: 'normal', resetsAt: 8.7e15 },
            null,
            'window',
          ],
          overage: { enabled: true, percent: '6', spendLabel: IMG },
          cooldownUntil: Infinity,
          session5h: stats('3', IMG, NaN, -2),
          week: stats(-41, Infinity, -1, 'free'),
          allTime: { tasks: NaN, inputTokens: '18400000', outputTokens: null, costUsd: -212.4, errors: IMG },
          lastError: SCRIPT + ' ' + LONG,
          running: '2',
          modelRanAs: IMG,
        }),
        account({
          key: 'dup',
          name: BIDI,
          provider: '__proto__',
          providerLabel: BIDI,
          sessionWorkers: 0,
          login: 'expired',
          plan: BIDI,
          preferred: 'yes',
          isMain: 1,
          usageFetchedAt: '2026-10-13T00:00:00Z',
          lastGoodWindowsAt: -100,
          allTime: 'lots',
          modelRanAs: 42,
        }),
        account({ key: 'dup', name: LONG, login: SCRIPT, windows: { length: 2 }, overage: 'on', cooldownUntil: now + 5 * MIN, running: -3, provider: 7, providerLabel: LONG, permissionMode: 42 }),
        account({ key: null, name: 12345, login: 'error', loginDetail: ATTR, defaultModel: ['opus'], provider: 'constructor', providerLabel: null, sessionWorkers: 'no' }),
        account({ key: 'dup', name: '', login: 'ok', windows: [], lastGoodWindowsAt: now - HOUR, provider: '', providerLabel: '' }),
        // Logged in on CLIs nobody listed, with no reading: the "no reading" state under hostile names.
        account({ key: 'k-evil-1', name: 'no reading, hostile CLI', login: 'no-plan-limits', plan: null, provider: SVG, providerLabel: IMG, sessionWorkers: false, defaultModel: null, permissionMode: ATTR, modelRanAs: SCRIPT + LONG }),
        account({ key: 'k-evil-2', name: 'no reading, toString CLI', login: 'ok', plan: null, provider: 'toString', providerLabel: BIDI + LONG, sessionWorkers: false, defaultModel: LONG, permissionMode: 'plan', modelRanAs: '__proto__' }),
        // A CLI that reports windows nobody expected: they are drawn like any others.
        account({ key: 'k-evil-3', name: 'gauges from a listed hostile CLI', login: 'no-plan-limits', provider: IMG, providerLabel: 'x', windows: [{ kind: 'session', label: SVG, percent: 12, severity: 'normal', resetsAt: now + HOUR }] }),
      ],
      tasks: [
        null,
        'task',
        { id: 'tabc1234', title: IMG, status: 'done', mode: 'oneshot', worker: SCRIPT, model: SVG, startedAt: now - HOUR, endedAt: now - 30 * MIN, inputTokens: '<b>12</b>', outputTokens: IMG, costUsd: '1.20', error: null, promptPreview: SCRIPT, inWorkspace: 'true', hasOutput: true, sessionWorker: IMG, branch: SVG, unmerged: 1, modelUsed: IMG, modelSource: SCRIPT },
        { id: 'tabc1234', title: LONG, status: 'failed', mode: 'session', worker: LONG, model: LONG, startedAt: now - 2 * HOUR, endedAt: now - 3 * HOUR, inputTokens: NaN, outputTokens: -5, costUsd: Infinity, error: IMG + ' ' + LONG_WORDS, promptPreview: LONG_WORDS, inWorkspace: false, hasOutput: true, sessionWorker: LONG, branch: LONG, unmerged: true, modelUsed: 42, modelSource: 7 },
        { id: '../../etc/passwd', title: BIDI, status: 'running', mode: 'detached', worker: BIDI, model: BIDI, startedAt: -1, endedAt: null, inputTokens: 1e21, outputTokens: 0, costUsd: 0, error: BIDI, promptPreview: null, inWorkspace: true, hasOutput: true, sessionWorker: null, branch: null, unmerged: false, modelUsed: '__proto__', modelSource: '__proto__' },
        { id: IMG, title: ATTR, status: SCRIPT, mode: IMG, worker: 7, model: null, startedAt: 'yesterday', endedAt: {}, inputTokens: [], outputTokens: true, costUsd: -1, error: 404, promptPreview: 404, inWorkspace: null, hasOutput: 'yes', sessionWorker: 9, branch: false, unmerged: 'no' },
        { title: 'no id at all', status: 'orphaned', mode: 'oneshot', worker: 'atlas', model: 'opus', startedAt: now - 9 * DAY, endedAt: now - 9 * DAY + 1, error: 'orphaned - worker process is no longer running', hasOutput: false },
        { id: 'tprov00001', title: 'ran on a CLI named like markup', status: 'done', mode: 'oneshot', worker: 'evil', model: 'm', startedAt: now - 20 * MIN, endedAt: now - 19 * MIN, hasOutput: true, inWorkspace: true, provider: IMG },
        { id: 'tprov00002', title: 'ran on __proto__', status: 'done', mode: 'oneshot', worker: 'evil', model: 'm', startedAt: now - 22 * MIN, endedAt: now - 21 * MIN, hasOutput: true, inWorkspace: true, provider: '__proto__' },
        { id: 'tprov00003', title: 'ran on constructor', status: 'failed', mode: 'detached', worker: 'evil', model: 'm', startedAt: now - 24 * MIN, endedAt: now - 23 * MIN, error: SCRIPT, hasOutput: true, inWorkspace: true, provider: 'constructor' },
        { id: 'tprov00004', title: 'provider is a number', status: 'done', mode: 'oneshot', worker: 'evil', model: 'm', startedAt: now - 26 * MIN, endedAt: now - 25 * MIN, hasOutput: true, inWorkspace: true, provider: 42 },
        { id: 'tprov00005', title: 'provider is five thousand characters', status: 'done', mode: 'oneshot', worker: 'evil', model: 'm', startedAt: now - 28 * MIN, endedAt: now - 27 * MIN, hasOutput: true, inWorkspace: true, provider: LONG },
        { id: 'tprov00006', title: 'provider with bidi controls', status: 'cancelled', mode: 'oneshot', worker: 'evil', model: 'm', startedAt: now - 30 * MIN, endedAt: now - 29 * MIN, error: 'cancelled by user', hasOutput: true, inWorkspace: true, provider: BIDI },
        { id: 'tcancel001', title: 'cancelled with numeric junk', status: 'cancelled', mode: 'oneshot', worker: 'atlas', model: 'opus', startedAt: now - 5 * MIN, endedAt: now - 4 * MIN, inputTokens: 1234567890123, outputTokens: 0.5, costUsd: 1e9, error: 'cancelled by user', hasOutput: true, inWorkspace: true, modelUsed: LONG, modelSource: 'constructor' },
        { id: 'tmodel0001', title: 'ran as five thousand characters of bidi', status: 'done', mode: 'oneshot', worker: 'atlas', model: 'opus', startedAt: now - 7 * MIN, endedAt: now - 6 * MIN, hasOutput: true, inWorkspace: true, modelUsed: BIDI + LONG_WORDS, modelSource: ['worker'] },
        { id: 'tmodel0002', title: 'model source is an object, what ran is an array', status: 'done', mode: 'oneshot', worker: 'atlas', model: 'opus', startedAt: now - 9 * MIN, endedAt: now - 8 * MIN, hasOutput: true, inWorkspace: true, modelUsed: ['claude-opus-5-5'], modelSource: { toString: null } },
        { id: 'trun0000001', title: 'running, started in the future', status: 'running', mode: 'session', worker: 'atlas', model: 'opus', startedAt: now + DAY, endedAt: null, hasOutput: false, inWorkspace: true },
      ],
      taskTotal: '9000',
      running: { workspace: -1, all: 'many' },
      daily: [
        null,
        { day: 'monday', done: '5', failed: NaN, cancelled: -3 },
        { day: now - 2 * DAY, done: 1e12, failed: 3, cancelled: 1 },
        { day: now - DAY, done: 4, failed: Infinity, cancelled: IMG },
        { day: startOfDay(now), done: 2, failed: 1, cancelled: 1 },
      ],
      sessions: [
        null,
        session({ key: IMG, name: IMG, accountName: SCRIPT, taskTitle: IMG + LONG, detail: SVG, model: SCRIPT, location: '/etc/' + IMG, branch: IMG, status: 'waiting', team: IMG, role: SCRIPT, unmerged: 'yes', startedAt: 'now', updatedAt: NaN }),
        session({ key: 'dup', name: BIDI, source: 'evil', kind: SCRIPT, status: 'exploding', accountName: BIDI, taskTitle: BIDI, canAttach: 'true', canStop: 1 }),
        session({ key: 'dup', name: LONG, source: 'teammate', status: 'busy', accountName: LONG, taskTitle: LONG, model: LONG, location: LONG, branch: LONG, team: LONG, role: LONG, startedAt: -9 }),
        session({ key: null, name: null, source: 'peer', status: 'idle', accountName: null, updatedAt: now + DAY }),
      ],
      settings: {
        workerPermissionMode: IMG,
        permissionModes: [IMG, SCRIPT, 7, null, 'acceptEdits'],
        claudePath: IMG + RLO + LONG,
        quotaCooldownMinutes: '30',
        workerTimeoutMinutes: NaN,
        frontierWorkerDispatch: { value: 'maybe', effective: IMG, setBy: SCRIPT },
        overageWorkerDispatch: 'block',
        meshMode: 'on',
        meshMaxLiveWorkers: -8,
        meshHistoryLimit: Infinity,
        sessionKeepalive: 0,
        workerModels: [IMG, 'opus', { model: 'sonnet' }],
        providerUsagePolling: 'off',
        providers: [
          null,
          'codex',
          9,
          { id: IMG, label: SCRIPT, models: [IMG, 7, LONG, null, ' padded ', 'ok-model', 'line\nbreak', BIDI], permissionModes: [SCRIPT, 'plan', {}, LONG, ATTR], isolation: SVG, isolationVerified: 'yes', sessionWorkers: 1 },
          { id: '__proto__', label: BIDI, models: 'all of them', permissionModes: null, isolation: 'none', isolationVerified: true, sessionWorkers: false },
          { id: IMG, label: 'a second entry with the same id', models: ['must-not-appear'], permissionModes: ['must-not-appear'], isolation: 'env', isolationVerified: true, sessionWorkers: true },
          { label: 'an entry with no id', models: ['x'], permissionModes: ['x'] },
          { id: 'constructor', label: LONG, models: [], permissionModes: [], isolation: 'env', isolationVerified: true, sessionWorkers: true },
          { id: SVG, label: null, models: [ATTR], permissionModes: [ATTR, 'plan'], isolation: 'env', isolationVerified: false, sessionWorkers: false },
        ].concat(
          // Far more CLIs than exist: the page shows a bounded number of them.
          new Array(40).join('x').split('').map(function (_x, i) {
            return { id: 'flood-' + i, label: 'Flood ' + i, models: ['m' + i], permissionModes: ['p' + i], isolation: 'none', isolationVerified: false, sessionWorkers: false };
          }),
        ),
      },
    };
  }

  /* ---------------------------- registry entries this version cannot use */

  /** The rich page plus three unusable registry entries: named, unnamed, and a hostile name. */
  function unsupportedEntries() {
    const model = rich(true);
    const RLO = String.fromCharCode(0x202e);
    model.unsupportedAccounts = [
      { name: 'oc', detail: 'unsupported provider "opencode"' },
      { name: '', detail: 'incomplete entry' },
      { name: '<img src=x onerror="window.__CCO_XSS__=1">' + RLO + 'gnp.exe "quoted" \'single\'', detail: 'duplicate name' },
    ];
    return model;
  }

  /* -------------------------------------------- the registry is unreadable */

  /** No accounts at all, because the registry file could not be read - not an empty registry. */
  function registryUnreadable() {
    const model = empty();
    model.accounts = [];
    model.unsupportedAccounts = [];
    model.health = health({ registryProblem: 'not valid JSON (unexpected character at line 14, column 3)' });
    return model;
  }

  window.__CCO_STRINGS__ = STRINGS;
  /** Order here is the order of the picker. A string value is a special mode, not a model. */
  window.__CCO_FIXTURES__ = {
    rich: function () {
      return rich(true);
    },
    'claude-only': function () {
      return rich(false);
    },
    empty: empty,
    'all-logins-expired': allExpired,
    hostile: hostile,
    'no-workspace': noWorkspace,
    'old-cli-and-broken-log': degraded,
    'unsupported-entries': unsupportedEntries,
    'registry-unreadable': registryUnreadable,
    'first-load': function () {
      return 'never';
    },
    'unknown-schema': function () {
      return { schema: 3, generatedAt: Date.now() };
    },
  };
})();
