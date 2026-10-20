// The shared harness of the three extension-shell suites (ext-probe2, probe-shellfix, probe-kshell):
// an offline stand-in for the extension host. Required first by each of them; it
//   - points HOME at a fresh sandbox under the temp directory and PATH at a fake `claude` that only
//     records how it was called,
//   - installs a hard allowlist on child_process (the fake CLI, git, ps, mkfifo — anything else throws
//     and is listed in `blockedSpawns`),
//   - installs a stand-in for the `vscode` module and stand-ins for the modules that would spawn
//     real probes, then loads the compiled extension (argv[2]) against them.
// What the suites exercise is the shell's own logic — command argument validation, confirmations,
// terminal environments, the trees, the litter-prune driver — not VS Code's rendering of it.
//
// argv: <compiled out dir> <repo root>   (the suites' own arguments; this module reads them)
'use strict';
require('./staged.js');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.resolve(process.argv[2]);
const REPO = path.resolve(process.argv[3]);

/* ----------------------------------------------------------------- sandbox */
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-ext-probe-')));
const HOME = path.join(SANDBOX, 'home');
const BIN = path.join(SANDBOX, 'bin');
const WS = path.join(SANDBOX, 'ws');
const FAKE_LOG = path.join(SANDBOX, 'fake-claude.log');
for (const d of [HOME, BIN, WS]) fs.mkdirSync(d, { recursive: true });
const REAL_HOME = os.homedir();
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
// Session-identity variables a real Claude Code session would have injected into this process.
process.env.CLAUDECODE = '1';
process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'secret-token';
process.env.CLAUDE_CODE_SESSION_ID = 'host-session';
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const FAKE_CLAUDE = path.join(BIN, 'claude');
const FAKE_MODE = path.join(SANDBOX, 'fake-mode');
fs.writeFileSync(
  FAKE_CLAUDE,
  `#!${process.execPath}\n` +
    `const fs = require('fs');\n` +
    `fs.appendFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');\n` +
    `const mode = fs.existsSync(${JSON.stringify(FAKE_MODE)}) ? fs.readFileSync(${JSON.stringify(FAKE_MODE)}, 'utf8') : '';\n` +
    // 'fail': the CLI refuses, with control characters in what it prints.
    `if (mode === 'fail') { process.stderr.write('No such job\\u001b[31m abcd1234\\n\\u202e gnp.exe\\n'); process.exit(1); }\n` +
    // 'hold': a grandchild keeps the stdio pipes open after this process exits (a background service).
    `if (mode === 'hold') { require('child_process').spawn('/bin/sleep', ['6'], { stdio: 'inherit', detached: true }).unref(); process.stdout.write('stopped\\n'); process.exit(0); }\n`,
  { mode: 0o755 },
);
if (os.homedir() !== HOME) throw new Error('sandbox HOME not in effect');

// Hard guard, installed before any extension module loads: the only programs this process may
// start are the fake CLI, git, ps and mkfifo. Anything else — above all a real \`claude\` —
// throws instead of running, and is listed at the end.
const cp = require('child_process');
const realSpawnSync = cp.spawnSync;
const realSpawn = cp.spawn; // probe-kshell section T starts its own lock-holder process
const PARTIAL = process.env.CCO_PROBE_MODE === 'partial-bundle';
const blockedSpawns = [];
const mayRun = (cmd) => cmd === FAKE_CLAUDE || cmd === 'git' || cmd === 'ps' || cmd === '/usr/bin/mkfifo';
// (the fake CLI itself may start /bin/sleep in its own process; that is outside this guard by design)
for (const fn of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[fn];
  cp[fn] = function (cmd, ...rest) {
    if (!mayRun(cmd)) {
      blockedSpawns.push(`${fn}(${JSON.stringify(cmd)}${Array.isArray(rest[0]) ? ` ${JSON.stringify(rest[0])}` : ''})`);
      throw new Error(`probe sandbox: refused to run ${cmd}`);
    }
    return orig.call(this, cmd, ...rest);
  };
}

const fakeCalls = () =>
  fs.existsSync(FAKE_LOG)
    ? fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

/* ------------------------------------------------------------- vscode stub */
const rec = {
  messages: [], terminals: [], quickPicks: [], inputs: [], progress: [], progressReports: [],
  treeViews: {}, providers: {}, status: [], shownDocs: [], openedDocs: [], clipboard: [],
  contentProviders: {}, executed: [], channels: [], settingWrites: [], statusItems: [],
};
const answers = { message: [], quickPick: [], input: [] };
const settingsBySection = { claudeCodeOrchestrator: { assetAutoSync: false } };
const settings = settingsBySection.claudeCodeOrchestrator;
const commands = new Map();
const configListeners = [];
const fireConfigChange = () => { for (const l of configListeners) l({ affectsConfiguration: (section) => section === 'claudeCodeOrchestrator' || section.startsWith('claudeCodeOrchestrator.') }); };

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.fired = 0;
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l); } };
    };
  }
  fire(v) { this.fired++; for (const l of [...this.listeners]) l(v); }
  dispose() { this.listeners = []; }
}
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
// The escaping VS Code's MarkdownString.appendText applies — ALL of it: markdown punctuation gets a
// backslash, every space and tab becomes `&nbsp;`, `>` gets a backslash, a line feed becomes a paragraph
// break. (Until the suites moved into the repository this stand-in did only the first and the last, so
// `.value` read like the text; a check for the ABSENCE of two words would then have passed on a real
// editor's value whatever the hover said. Compare what a person reads with `shown()` below.)
const escapeMd = (v) => String(v)
  .replace(/[\\`*_{}[\]()#+\-!~]/g, '\\$&')
  .replace(/([ \t]+)/g, (_m, g1) => '&nbsp;'.repeat(g1.length))
  .replace(/>/gm, '\\>')
  .replace(/\n/g, '\n\n');
class MarkdownString {
  constructor(value = '') { this.value = value; this.isTrusted = undefined; this.supportHtml = undefined; this.segments = value ? [{ kind: 'md', value }] : []; }
  appendText(v) { this.segments.push({ kind: 'text', value: String(v) }); this.value += escapeMd(v); return this; }
  appendMarkdown(v) { this.segments.push({ kind: 'md', value: String(v) }); this.value += v; return this; }
}
/** A hover as a person reads it: the escapes of appendText taken out again (markdown syntax stays). */
const shown = (md) => String(md !== null && typeof md === 'object' ? md.value : md)
  .replace(/&nbsp;/g, ' ')
  .replace(/\\([\\`*_{}[\]()#+\-!~>])/g, '$1');
// The extension's manifest: its id (`publisher.name`, as the editor forms it) and the settings it declares,
// as the editor knows them — default value and scope.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const settingProps = manifest.contributes.configuration.properties;
class Uri {
  constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.fsPath = p; this.query = query; }
  static file(p) { return new Uri('file', p); }
  static joinPath(base, ...parts) { return new Uri(base.scheme, path.join(base.path, ...parts)); }
  static from(o) { return new Uri(o.scheme, o.path ?? '', o.query ?? ''); }
  static parse(text) { return new Uri('x', text); }
  toString() { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`; }
  with(o) { return new Uri(o.scheme ?? this.scheme, o.path ?? this.path, o.query ?? this.query); }
}
function ui(level, msg, rest) {
  let options;
  let items = rest;
  // the first argument after the message is the options object only when it is one (modal / detail);
  // any other object there is an item
  if (rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null && ('modal' in rest[0] || 'detail' in rest[0])) {
    options = rest[0];
    items = rest.slice(1);
  }
  rec.messages.push({ level, msg, modal: options?.modal === true, detail: options?.detail, items });
  const a = answers.message.shift();
  return Promise.resolve(typeof a === 'function' ? a(items, msg) : a);
}
// Teammate mode (team contract §8.1) subscribes to terminal closes at activation (the take-over terminals' release).
const terminalClosed = new EventEmitter();
const vscode = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri,
  l10n: { t: (msg, ...args) => String(msg).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) },
  env: { appName: 'ProbeHost', language: 'en', shell: '/bin/zsh', clipboard: { writeText: async (t) => { rec.clipboard.push(t); } } },
  extensions: { getExtension: () => undefined },
  window: {
    createOutputChannel: (name) => {
      const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, dispose() {} };
      rec.channels.push(ch);
      return ch;
    },
    createTerminal: (opts) => {
      const t = { opts, sent: [], shown: false, show() { this.shown = true; }, sendText(x) { this.sent.push(x); } };
      rec.terminals.push(t);
      return t;
    },
    showInformationMessage: (msg, ...rest) => ui('info', msg, rest),
    showWarningMessage: (msg, ...rest) => ui('warning', msg, rest),
    showErrorMessage: (msg, ...rest) => ui('error', msg, rest),
    showQuickPick: async (items, opts) => {
      const list = await items;
      rec.quickPicks.push({ items: list, opts });
      const a = answers.quickPick.shift();
      return typeof a === 'function' ? a(list) : a;
    },
    showInputBox: async (opts) => {
      rec.inputs.push(opts);
      return answers.input.length > 0 ? answers.input.shift() : undefined;
    },
    withProgress: async (opts, task) => {
      rec.progress.push(opts);
      return task(
        { report: (x) => rec.progressReports.push(x) },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      );
    },
    createTreeView: (id, opts) => {
      const emitter = new EventEmitter();
      const expanded = new EventEmitter();
      const v = { id, opts, visible: false, description: undefined, onDidChangeVisibility: emitter.event, _vis: emitter, onDidExpandElement: expanded.event, _exp: expanded, dispose() {} };
      rec.treeViews[id] = v;
      return v;
    },
    registerTreeDataProvider: (id, provider) => { rec.providers[id] = provider; return { dispose() {} }; },
    setStatusBarMessage: (m) => { rec.status.push(m); return { dispose() {} }; },
    // Team mode's status bar item (§8.1): what it shows is kept on the item, every item in rec.statusItems.
    createStatusBarItem: (alignment, priority) => {
      const item = { alignment, priority, text: '', tooltip: undefined, command: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.visible = false; } };
      rec.statusItems.push(item);
      return item;
    },
    onDidCloseTerminal: terminalClosed.event,
    showTextDocument: async (doc, opts) => { rec.shownDocs.push({ doc, opts }); },
    showOpenDialog: async () => undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(WS), name: path.basename(WS), index: 0 }],
    workspaceFile: undefined,
    // The store holds USER settings (what a suite assigns to `settings`). Like the editor, an unset key reads
    // as the default the manifest declares — never as the caller's fallback while the manifest has one — and
    // inspect() reports that default; a machine-scoped setting (every setting of this extension) can be
    // written into User settings only.
    getConfiguration: (section) => {
      const store = (settingsBySection[section] ??= {});
      const full = (k) => (section ? `${section}.${k}` : k);
      const declared = (k) => settingProps[full(k)];
      return {
        get: (k, d) => (k in store ? store[k] : declared(k) !== undefined && declared(k).default !== undefined ? declared(k).default : d),
        inspect: (k) => ({ key: full(k), defaultValue: declared(k) !== undefined ? declared(k).default : undefined, globalValue: store[k], workspaceValue: undefined, workspaceFolderValue: undefined }),
        update: async (k, v, target) => {
          const toUser = target === 1 || target === true;
          if (!toUser && declared(k) !== undefined && declared(k).scope === 'machine') {
            rec.settingWrites.push({ key: full(k), value: v, target, rejected: true });
            throw new Error(`Unable to write ${full(k)} to Workspace Settings. This setting can be written only into User settings.`);
          }
          rec.settingWrites.push({ key: full(k), value: v, target });
          if (v === undefined) delete store[k]; else store[k] = v;
        },
        has: (k) => declared(k) !== undefined,
      };
    },
    onDidChangeConfiguration: (listener) => { configListeners.push(listener); return { dispose() {} }; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: (scheme, provider) => { rec.contentProviders[scheme] = provider; return { dispose() {} }; },
    openTextDocument: async (uri) => { rec.openedDocs.push(uri); return { uri }; },
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    // As the editor: a command nobody registered is an error, not a silent nothing. (The built-ins the shell
    // uses are known here by name.)
    executeCommand: async (id, ...args) => {
      rec.executed.push({ id, args });
      if (commands.has(id)) return commands.get(id)(...args);
      if (id.startsWith('workbench.') || id === 'setContext' || id === 'vscode.open' || id === 'vscode.diff' || id === 'revealFileInOS') return undefined;
      throw new Error(`command '${id}' not found`);
    },
  },
};

/* ------------------------------------------------- module stubs + loading */
const team = { sessions: [], resolved: new Map(), invalidations: 0, collectThrows: false, lastOpts: undefined };
const teamStub = {
  collectSessions: (opts) => {
    team.lastOpts = opts;
    if (team.collectThrows) throw new Error('collector exploded');
    return team.sessions;
  },
  resolveSession: (key) => (typeof key === 'string' ? team.resolved.get(key) : undefined),
  invalidateTeamCache: () => { team.invalidations++; },
};
const dashboardCalls = [];
const dashboardLogSinks = [];
const dashboardSettingsSyncs = []; // K-SHELL (K13): the settings-sync step the shell hands the dashboard host
const stubByFile = new Map([
  [path.join(OUT, 'team'), teamStub],
  // WAVE2 (F9): the shell hands the dashboard host its own output channel.
  [path.join(OUT, 'dashboard'), { openDashboard: (...a) => { dashboardCalls.push(a); }, setDashboardLog: (sink) => { dashboardLogSinks.push(sink); }, setDashboardSettingsSync: (sync) => { dashboardSettingsSyncs.push(sync); } }],
  [path.join(OUT, 'assetManager'), { openAssetManager: () => {} }],
]);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request.startsWith('.') && parent && parent.filename) {
    const target = path.resolve(path.dirname(parent.filename), request);
    if (stubByFile.has(target)) return stubByFile.get(target);
  }
  return origLoad.call(this, request, parent, isMain);
};

// Capture timers and file watchers instead of arming them.
const timers = [];
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
const captureTimers = (on) => {
  global.setTimeout = on ? (fn, ms) => { const t = { kind: 'timeout', fn, ms }; timers.push(t); return t; } : realSetTimeout;
  global.setInterval = on ? (fn, ms) => { const t = { kind: 'interval', fn, ms }; timers.push(t); return t; } : realSetInterval;
};
const realClearTimeout = global.clearTimeout;
const realClearInterval = global.clearInterval;
global.clearTimeout = (t) => (t && t.kind ? (t.cleared = true) : realClearTimeout(t));
global.clearInterval = (t) => (t && t.kind ? (t.cleared = true) : realClearInterval(t));
const watched = [];
fs.watchFile = (file, _opts, listener) => { watched.push({ file, listener }); };
fs.unwatchFile = (file, listener) => {
  const i = watched.findIndex((w) => w.file === file && w.listener === listener);
  if (i >= 0) watched.splice(i, 1);
};

const registry = require(path.join(OUT, 'registry.js'));
const usage = require(path.join(OUT, 'usage.js'));
const keepalive = require(path.join(OUT, 'keepalive.js'));
const reaper = require(path.join(OUT, 'mesh', 'reaper.js'));
const pool = require(path.join(OUT, 'mesh', 'pool.js'));
const litter = require(path.join(OUT, 'sessionLitter.js'));
const uiModel = require(path.join(OUT, 'uiModel.js'));
const platform = require(path.join(OUT, 'platform.js'));
const teamAgent = require(path.join(OUT, 'teamAgent.js'));
if (!registry.ROOT_DIR.startsWith(HOME)) throw new Error(`registry root escaped the sandbox: ${registry.ROOT_DIR}`);

// Nothing here may reach a real CLI or a real account.
const spawnGuards = { usageRefresh: 0, keepalive: 0, orphanReap: 0 };
usage.refreshAllUsageIfStale = async () => { spawnGuards.usageRefresh++; };
usage.refreshAllUsage = async () => { spawnGuards.usageRefresh++; };
const providerRefresh = { calls: [], fail: false };
usage.refreshProviderUsage = (opts) => { providerRefresh.calls.push({ ...opts }); if (providerRefresh.fail) throw new Error('helper exploded'); return Promise.resolve(); };
keepalive.runKeepaliveSweep = async () => { spawnGuards.keepalive++; };
reaper.reapOrphanedMeshWorkers = async () => { spawnGuards.orphanReap++; return { stopped: [] }; };
reaper.sweepStaleIoArtifacts = () => 0;
registry.resolveClaudePathPreserving = () => FAKE_CLAUDE;
// The same answer from the asynchronous lookup (the form activation uses once the second review's fixes are
// in: the login-shell lookup no longer runs on the activation path, and its result arrives a moment later).
// The real one would run a login shell, which the allowlist above refuses.
if (typeof registry.resolveClaudePathPreservingAsync === 'function') registry.resolveClaudePathPreservingAsync = async () => FAKE_CLAUDE;
const ledgerCalls = { marked: [], removed: [], cleared: [] };
reaper.markWorkerStopped = (cwd, name, jobId) => { ledgerCalls.marked.push({ cwd, name, jobId }); return { ok: true }; };
reaper.clearStoppedWorkers = async (cwd) => { ledgerCalls.cleared.push(cwd); };
pool.removeWorkerJob = async (opts) => { ledgerCalls.removed.push(opts); return { removed: false, kept: true }; };
const litterScript = { calls: [], next: () => [] };
litter.pruneAllSessionLitter = async (dirs) => { litterScript.calls.push([...dirs]); return litterScript.next(dirs, litterScript.calls.length); };
const accounts = new Map();
const realResolveAccount = uiModel.resolveAccount; // probe-shellfix section X and probe-kshell use the real one
uiModel.resolveAccount = (key) => (typeof key === 'string' ? accounts.get(key) : undefined);
const outputs = new Map();
uiModel.resolveTaskOutput = (id) => (typeof id === 'string' ? outputs.get(id) : undefined);

const ext = require(path.join(OUT, 'extension.js'));
const views = require(path.join(OUT, 'views.js'));
const teamView = require(path.join(OUT, 'teamView.js'));

/* --------------------------------------------------------------- reporting */
let failures = 0;
let passes = 0;
const check = (name, ok, observed) => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${observed !== undefined ? `: ${observed}` : ''}`);
};
// A check that cannot run here, said out loud: it is neither a pass nor a failure, and run.sh counts it.
let skips = 0;
const skip = (name, why) => {
  skips++;
  console.log(`SKIP — ${name}: ${why}`);
};
// Two of these suites compare the tree under test with a build of the tree as it was BEFORE the fix they
// were written for. That older build is not something the repository can rebuild, so run.sh passes it only
// when the caller names one (CCO_SUITES_BASE_SHELLFIX / CCO_SUITES_BASE_KSHELL); without it those
// comparisons are skipped, each by name.
const NO_BASE_BUILD = 'needs a compiled copy of the tree as it was before that fix, which the repository cannot rebuild (run.sh passes one when CCO_SUITES_BASE_SHELLFIX / CCO_SUITES_BASE_KSHELL names it)';
const reset = () => {
  for (const k of ['messages', 'terminals', 'quickPicks', 'inputs', 'progress', 'progressReports', 'status', 'shownDocs', 'openedDocs', 'clipboard', 'executed', 'settingWrites']) rec[k].length = 0;
  answers.message.length = 0; answers.quickPick.length = 0; answers.input.length = 0;
};
const run = (id, ...args) => commands.get(`claudeCodeOrchestrator.${id}`)(...args);
// A row as the editor shows it when the pointer is on it: getTreeItem, then — for a provider that has
// one — resolveTreeItem, which is where the Tasks and Worker History trees build their hovers since 2.0.
const NOT_CANCELLED = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const hovered = (provider, element) => {
  const item = provider.getTreeItem(element);
  if (typeof provider.resolveTreeItem !== 'function') return item;
  const resolved = provider.resolveTreeItem(item, element, NOT_CANCELLED);
  return resolved === undefined || resolved === null ? item : resolved;
};
const readReg = () => JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8'));
// Every worker entry of the registry FILE, in the order the registry reads them: the Claude Code accounts
// under `workers`, then the other vendors' accounts under `vendorWorkers` (2.0; until then one array held all).
const readWorkers = () => {
  const file = readReg();
  return [...(Array.isArray(file.workers) ? file.workers : []), ...(Array.isArray(file.vendorWorkers) ? file.vendorWorkers : [])];
};
const memento = () => {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); }, _m: m };
};

module.exports = {
  Module, fs, os, path, execFileSync, OUT, REPO, SANDBOX,
  HOME, BIN, WS, FAKE_LOG, REAL_HOME, FAKE_CLAUDE, FAKE_MODE, cp,
  realSpawnSync, realSpawn, PARTIAL, blockedSpawns, mayRun, fakeCalls, rec, answers,
  settingsBySection, settings, commands, configListeners, fireConfigChange, terminalClosed, EventEmitter, TreeItem, ThemeIcon,
  ThemeColor, escapeMd, MarkdownString, vscode, team, teamStub, dashboardCalls, dashboardLogSinks,
  dashboardSettingsSyncs, stubByFile, timers, realSetTimeout, realSetInterval, captureTimers, realClearTimeout, realClearInterval,
  watched, registry, usage, keepalive, reaper, pool, litter, uiModel,
  platform, teamAgent, spawnGuards, providerRefresh, ledgerCalls, litterScript, accounts, outputs,
  realResolveAccount, ext, views, teamView, check, reset, run, readReg,
  memento, hovered, readWorkers, skip, NO_BASE_BUILD, shown, Uri, EXTENSION_ID,
  // the counters `check` and `skip` move
  get passes() { return passes; },
  get failures() { return failures; },
  get skips() { return skips; },
};
