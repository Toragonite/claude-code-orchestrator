// A stand-in for the `vscode` module, enough to load and drive the compiled extension host
// (out/*.js) offline. Built on the reviewer's stub (/private/tmp/cco-review-r2/stub.cjs) and
// extended for the SHELL-A fix wave: workspace / folder setting values, machine-scoped
// settings as real VS Code treats them, a legacy settings section, `env.shell`, and a guard
// that keeps every agent CLI this process (or the modules under test) starts on the fakes.
//
// Usage:  const { install } = require('./shell-a-stub.cjs');
//         const h = install({ out, repo, home, workspace, ... });
// MUST be called before any module under test is required: it redirects HOME first.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const childProcess = require('child_process');

const AGENT_CLIS = ['claude', 'codex', 'cursor-agent', 'agy'];

function install(opts = {}) {
  const repo = opts.repo;
  const out = opts.out;
  if (!repo || !out) throw new Error('install({ repo, out }) are required');
  const home = opts.home;
  if (!home) throw new Error('install({ home }) is required — a fresh scratch directory');
  fs.mkdirSync(home, { recursive: true });

  // ---- isolate the process: no real account, no real CLI ----
  const fakebin = path.join(home, 'fakebin');
  fs.mkdirSync(fakebin, { recursive: true });
  const callLog = path.join(home, 'cli-calls.log');
  for (const cli of AGENT_CLIS) {
    const f = path.join(fakebin, cli);
    fs.writeFileSync(
      f,
      `#!/bin/sh\necho "${cli} $* | CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR-<unset>} CODEX_HOME=\${CODEX_HOME-<unset>}" >> "${callLog}"\ncase "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0;; esac\nexit 1\n`,
    );
    fs.chmodSync(f, 0o755);
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = `${fakebin}:/usr/bin:/bin:${path.dirname(process.execPath)}`;
  process.env.SHELL = '/bin/sh';
  for (const k of Object.keys(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|CODEX|CURSOR|AGY)/.test(k)) delete process.env[k];
  }
  if (os.homedir() !== home) throw new Error('HOME redirect failed');
  // Every Node child the modules under test fork (the provider status helper) gets the
  // providers harness's network guard: no request can leave the machine. And the keychain
  // guard, with AGENT_CLI_CREDENTIAL_STORE=memory: no adapter reads a keychain or a login file.
  const netGuard = path.join(repo, '.orchestrator', 'providers', 'net-guard.cjs');
  const keychainGuard = require('./keychain-guard.cjs');
  process.env.NODE_OPTIONS = keychainGuard.nodeOptionsWith(fs.existsSync(netGuard) ? `--require ${netGuard}` : '');
  process.env.AGENT_CLI_CREDENTIAL_STORE = 'memory';

  // Whatever path a module under test resolved for an agent CLI, the process that actually
  // starts is the fake of that name. Nothing here can run a real claude / codex / cursor-agent
  // / agy, whatever is installed on the machine running the test.
  const redirected = [];
  const guard = (command) => {
    if (typeof command !== 'string') return command;
    const base = path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (AGENT_CLIS.includes(base) && path.dirname(path.resolve(command)) !== fakebin && command !== base) {
      redirected.push(command);
      return path.join(fakebin, base);
    }
    return command;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const real = childProcess[name];
    childProcess[name] = function (command, ...rest) {
      return real.call(this, guard(command), ...rest);
    };
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  const defaults = {};
  const scopes = {};
  for (const [k, v] of Object.entries(props)) {
    defaults[k] = v.default;
    scopes[k] = v.scope;
  }

  // Full keys ("section.key") → value, per level. `folders` is keyed by folder name.
  const store = {
    global: { ...(opts.globalSettings ?? {}) },
    workspace: { ...(opts.workspaceSettings ?? {}) },
    folders: {},
  };
  for (const [name, values] of Object.entries(opts.folderSettings ?? {})) store.folders[name] = { ...values };

  // How the editor treats a workspace / folder value of a setting that is registered with
  // scope "machine" (every setting of this extension is):
  //   'filters' — real VS Code (verified in the 1.138.0 bundle): the value is dropped when the
  //               workspace file is parsed, so neither get() nor inspect() ever shows it;
  //   'reports' — an editor that does not honour the scope: get() returns the workspace value
  //               (the merged read) and inspect() reports it. This is the hostile case.
  const inspectMode = opts.inspectMode ?? 'reports';
  const filtered = (fullKey) => inspectMode === 'filters' && scopes[fullKey] === 'machine';

  const log = { messages: [], commandsExecuted: [], terminals: [], configUpdates: [], opened: [], clipboard: [], panels: [], output: [], quickPicks: [], inputBoxes: [], status: [], statusItems: [], rejections: [] };
  const answers = { message: opts.answerMessage ?? (() => undefined), quickPick: opts.answerQuickPick ?? (() => undefined), inputBox: opts.answerInputBox ?? (() => undefined) };
  process.on('unhandledRejection', (e) => log.rejections.push(String((e && e.stack) || e)));
  process.on('uncaughtException', (e) => log.rejections.push('uncaught: ' + String((e && e.stack) || e)));

  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(v) { for (const l of [...this.listeners]) l(v); }
    dispose() { this.listeners.clear(); }
  }
  const cfgChanged = new EventEmitter();
  const foldersChanged = new EventEmitter();
  // Team mode (team contract §8.1) subscribes to terminal closes at activation (the take-over
  // terminals' release); a test fires it with h.terminalClosed.fire(terminal).
  const terminalClosed = new EventEmitter();

  class Uri {
    constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.fsPath = p; this.query = query; }
    static file(p) { return new Uri('file', p); }
    static joinPath(base, ...parts) { return new Uri(base.scheme, path.join(base.path, ...parts)); }
    static from(o) { return new Uri(o.scheme, o.path ?? '', o.query ?? ''); }
    static parse(s) { return new Uri('x', s); }
    toString() { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`; }
    with(o) { return new Uri(o.scheme ?? this.scheme, o.path ?? this.path, o.query ?? this.query); }
  }

  const folderList = opts.workspaceFolders ?? (opts.workspace ? [opts.workspace] : []);
  const workspaceFolders = folderList.map((p, index) => ({ uri: Uri.file(p), name: path.basename(p), index }));
  const folderOf = (scope) => (scope && scope.fsPath ? workspaceFolders.find((f) => f.uri.fsPath === scope.fsPath) : undefined);

  function getConfiguration(section, scope) {
    const full = (k) => (section ? `${section}.${k}` : k);
    const folder = folderOf(scope);
    return {
      get(k, fallback) {
        const f = full(k);
        if (!filtered(f)) {
          if (folder && store.folders[folder.name] && f in store.folders[folder.name]) return store.folders[folder.name][f];
          if (f in store.workspace) return store.workspace[f];
        }
        if (f in store.global) return store.global[f];
        if (f in defaults && defaults[f] !== undefined) return defaults[f];
        return fallback;
      },
      inspect(k) {
        const f = full(k);
        return {
          key: f,
          defaultValue: defaults[f],
          globalValue: store.global[f],
          workspaceValue: filtered(f) ? undefined : store.workspace[f],
          workspaceFolderValue: filtered(f) || !folder ? undefined : store.folders[folder.name]?.[f],
        };
      },
      async update(k, value, target) {
        const f = full(k);
        // Real VS Code refuses to write a machine-scoped setting anywhere but User settings
        // ("Unable to write {0} to Workspace Settings. This setting can be written only into
        // User settings." — its own message table). Modelled in BOTH inspect modes.
        if (target !== 1 && scopes[f] === 'machine') {
          log.configUpdates.push({ key: f, value, target, rejected: true });
          throw new Error(`Unable to write ${f} to Workspace Settings. This setting can be written only into User settings.`);
        }
        log.configUpdates.push({ key: f, value, target });
        const where = target === 1 ? store.global : target === 2 ? store.workspace : (store.folders[folder?.name ?? ''] ??= {});
        if (value === undefined) delete where[f]; else where[f] = value;
        cfgChanged.fire({ affectsConfiguration: (s) => f.startsWith(s) });
      },
      has(k) { return full(k) in defaults; },
    };
  }

  class MarkdownString {
    constructor(value = '') { this.value = value; this.isTrusted = undefined; this.supportHtml = undefined; }
    appendMarkdown(v) { this.value += v; return this; }
    appendText(v) {
      this.value += String(v).replace(/[\\`*_{}[\]()#+\-!~]/g, '\\$&').replace(/([ \t]+)/g, (_m, g1) => '&nbsp;'.repeat(g1.length)).replace(/>/gm, '\\>').replace(/\n/g, '\n\n');
      return this;
    }
  }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  class ThemeColor { constructor(id) { this.id = id; } }

  const registered = new Map();
  const commands = {
    registerCommand(id, fn) { registered.set(id, fn); return { dispose: () => registered.delete(id) }; },
    async executeCommand(id, ...args) {
      log.commandsExecuted.push({ id, args });
      const fn = registered.get(id);
      if (fn) return fn(...args);
      if (id.startsWith('workbench.') || id.startsWith('setContext') || id === 'revealFileInOS' || id === 'vscode.diff') return undefined;
      throw new Error(`command '${id}' not found`);
    },
  };

  const show = (level) => async (message, ...rest) => {
    let options; let items = rest;
    if (rest.length && typeof rest[0] === 'object' && rest[0] !== null && ('modal' in rest[0] || 'detail' in rest[0])) {
      options = rest[0]; items = rest.slice(1);
    }
    const rec = { level, message, modal: options?.modal === true, detail: options?.detail, items };
    log.messages.push(rec);
    return answers.message(rec);
  };

  const h = {};
  const window = {
    createOutputChannel(name) { return { name, appendLine: (l) => log.output.push(l), append: () => {}, show: () => {}, dispose: () => {} }; },
    showInformationMessage: show('info'),
    showWarningMessage: show('warning'),
    showErrorMessage: show('error'),
    setStatusBarMessage(text) { log.status.push(text); return { dispose() {} }; },
    // Team mode's status bar item (§8.1): what it shows is kept on the item, every item in log.statusItems.
    createStatusBarItem(alignment, priority) {
      const item = { alignment, priority, text: '', tooltip: undefined, command: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.visible = false; } };
      log.statusItems.push(item);
      return item;
    },
    onDidCloseTerminal: terminalClosed.event,
    async showQuickPick(items, options) { const list = await items; log.quickPicks.push({ items: list, options }); return answers.quickPick(list, options); },
    async showInputBox(options) { log.inputBoxes.push(options); return answers.inputBox(options); },
    async showOpenDialog() { return undefined; },
    createTerminal(options) {
      const t = { options, name: options.name, env: options.env, sent: [], show() {}, sendText(text) { this.sent.push(text); }, dispose() {} };
      log.terminals.push(t);
      return t;
    },
    createTreeView(id, o) { const vis = new EventEmitter(); const exp = new EventEmitter(); return { id, visible: opts.viewsVisible === true, description: '', onDidChangeVisibility: vis.event, _vis: vis, onDidExpandElement: exp.event, _exp: exp, dispose() {}, provider: o.treeDataProvider }; },
    registerTreeDataProvider(id, provider) { h.providers[id] = provider; return { dispose() {} }; },
    createWebviewPanel(viewType, title, column, options) {
      const recv = new EventEmitter(); const disp = new EventEmitter(); const vs = new EventEmitter();
      const panel = {
        viewType, title, options, visible: true, posted: [],
        webview: {
          cspSource: 'vscode-webview://stub', html: '',
          asWebviewUri: (u) => new Uri('vscode-webview', u.path),
          postMessage: async (m) => { panel.posted.push(m); return true; },
          onDidReceiveMessage: recv.event,
        },
        onDidDispose: disp.event, onDidChangeViewState: vs.event,
        reveal() { panel.revealed = (panel.revealed ?? 0) + 1; },
        dispose() { disp.fire(); },
        _recv: recv, _vs: vs,
      };
      log.panels.push(panel);
      return panel;
    },
    async withProgress(_o, task) { const src = { onCancellationRequested: () => ({ dispose() {} }) }; return task({ report() {} }, src); },
    async showTextDocument(doc) { log.opened.push({ shown: doc.uri?.fsPath ?? String(doc) }); },
    activeTextEditor: undefined,
  };
  const workspace = {
    getConfiguration,
    onDidChangeConfiguration: cfgChanged.event,
    onDidChangeWorkspaceFolders: foldersChanged.event,
    workspaceFolders: workspaceFolders.length ? workspaceFolders : undefined,
    workspaceFile: opts.workspaceFile ? Uri.file(opts.workspaceFile) : undefined,
    async openTextDocument(uri) { log.opened.push({ opened: uri.fsPath ?? String(uri) }); return { uri }; },
    registerTextDocumentContentProvider() { return { dispose() {} }; },
    fs: {},
  };
  const vscode = {
    EventEmitter, MarkdownString, Uri, TreeItem, ThemeIcon, ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15, Window: 10 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    window, workspace, commands,
    env: { appName: opts.appName ?? 'StubCode', language: opts.language ?? 'en', shell: 'shell' in opts ? opts.shell : '/bin/zsh', clipboard: { writeText: async (t) => { log.clipboard.push(t); } } },
    l10n: { t: (msg, ...args) => String(msg).replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)])) },
    extensions: { getExtension: () => undefined },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return origLoad.call(this, request, parent, isMain);
  };

  const mkState = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()], _m: m }; };
  // `out/...` comes from the build under test; everything else (assets/, media/) from the repo.
  const asAbsolutePath = (p) => (p === 'out' || p.startsWith(`out${path.sep}`) || p.startsWith('out/') ? path.join(out, p.slice(4)) : path.join(repo, p));
  const context = {
    subscriptions: [],
    globalState: mkState(),
    workspaceState: mkState(),
    extensionUri: Uri.file(repo),
    extensionPath: repo,
    asAbsolutePath,
    extension: { id: 'toragonite.claude-code-orchestrator', packageJSON: pkg },
  };
  Object.assign(h, {
    vscode, context, log, store, home, fakebin, callLog, registered, providers: {}, cfgChanged, terminalClosed, defaults, scopes, redirected, answers,
    req: (m) => require(path.join(out, m)),
    fireConfig: () => cfgChanged.fire({ affectsConfiguration: () => true }),
    root: path.join(home, '.claude-code-orchestrator'),
    dispose: () => { for (const s of context.subscriptions) { try { s.dispose(); } catch { /* best effort */ } } },
  });
  return h;
}
module.exports = { install, AGENT_CLIS };
