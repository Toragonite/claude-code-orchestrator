// Black-box probes of the dashboard HOST (compiled src/dashboard.ts) against a fake `vscode`
// and stubbed data modules. No real ~/.claude* or ~/.claude-code-orchestrator access: the
// registry, uiModel and team modules are replaced.
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const out = path.resolve(process.argv[2]); // K-SHELL: the tree under test, compiled by the caller

const results = [];
const check = (name, ok, observed) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + ': ' + (typeof observed === 'string' ? observed : JSON.stringify(observed))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// W5 SHELL-A: see quiet() — the clock the page-action limiter reads.
let clockSkew = 0; const realNow = Date.now; Date.now = () => realNow() + clockSkew;
const modals = [];

/* ---- fake workspace on disk (temp dir) ---- */
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-dash-host-'));
fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'cco-dispatch': { command: 'node' } } }));
fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# project\n');

/* ---- fake vscode ---- */
const cfgStore = { workerPermissionMode: 'acceptEdits', claudePath: 'claude', quotaCooldownMinutes: 30, workerTimeoutMinutes: 45, frontierWorkerDispatch: 'block', overageWorkerDispatch: 'block', meshMode: false, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, sessionKeepalive: false };
const cfgWorkspace = {};
const updates = [];
let updateThrows = false;
// The settings and commands the extension declares, read from its manifest: the stand-in answers an unset
// setting with the declared default, refuses to write a machine-scoped setting anywhere but User settings,
// and refuses a command nobody declared — as the editor does. (get() still lets a workspace value win: the
// stand-in of an editor that does not honour the scope, which is the hostile case for the host.)
const manifest = JSON.parse(fs.readFileSync(path.join(process.argv[3], 'package.json'), 'utf8'));
const settingProps = manifest.contributes.configuration.properties;
const declaredSetting = (k) => settingProps['claudeCodeOrchestrator.' + k];
const declaredCommands = new Set(manifest.contributes.commands.map((c) => c.command));
const cfg = {
  get: (k) => (k in cfgWorkspace ? cfgWorkspace[k] : k in cfgStore ? cfgStore[k] : declaredSetting(k) && declaredSetting(k).default),
  inspect: (k) => ({ key: 'claudeCodeOrchestrator.' + k, defaultValue: declaredSetting(k) && declaredSetting(k).default, globalValue: cfgStore[k], workspaceValue: cfgWorkspace[k], workspaceFolderValue: undefined }),
  update: async (k, v, target) => {
    if (updateThrows) throw new Error('settings.json is not writable');
    updates.push([k, v, target]);
    if (target !== 1 && target !== true && declaredSetting(k) && declaredSetting(k).scope === 'machine') throw new Error('Unable to write claudeCodeOrchestrator.' + k + ' to Workspace Settings. This setting can be written only into User settings.');
    cfgStore[k] = v;
  },
};
const commands = [];
let commandThrows = null;
const panels = [];
const channels = [];
let intervalFn = null; let intervalCleared = false;
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => { if (ms === 2000) { intervalFn = fn; return 'TICK'; } return realSetInterval(fn, ms); };
const realClearInterval = global.clearInterval;
global.clearInterval = (h) => { if (h === 'TICK') { intervalCleared = true; return; } return realClearInterval(h); };
const opened = [];
function makePanel() {
  const p = {
    visible: true, revealed: 0, posted: [], html: '', disposeFns: [], msgFn: null, viewFns: [], options: null,
    reveal() { p.revealed++; },
    onDidDispose(fn) { p.disposeFns.push(fn); return { dispose() {} }; },
    onDidChangeViewState(fn) { p.viewFns.push(fn); return { dispose() {} }; },
    webview: {
      cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
      asWebviewUri: (u) => ({ toString: () => 'https://file+.vscode-resource.vscode-cdn.net' + u.path }),
      postMessage: async (m) => { p.posted.push(JSON.parse(JSON.stringify(m))); return true; },
      onDidReceiveMessage(fn) { p.msgFn = fn; return { dispose() {} }; },
      set html(v) { p.html = v; }, get html() { return p.html; },
    },
  };
  panels.push(p);
  return p;
}
const vscode = {
  l10n: { t: (s, ...a) => s.replace(/\{(\d+)\}/g, (m, i) => (a[i] === undefined ? m : String(a[i]))) },
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  Uri: { joinPath: (base, ...parts) => ({ path: base.path + '/' + parts.join('/') }), file: (f) => ({ fsPath: f }) },
  env: { language: 'ko' },
  window: {
    createWebviewPanel: (type, title, col, options) => { const p = makePanel(); p.options = options; p.title = title; return p; },
    createOutputChannel: (name) => { const c = { name, lines: [], appendLine(l) { c.lines.push(l); }, dispose() {} }; channels.push(c); return c; },
    showTextDocument: async (doc, opts) => { opened.push(['show', doc.file, opts]); },
    showWarningMessage: async (msg, options, ...items) => { modals.push([msg, options && options.modal === true, items]); return options && options.modal === true ? items[0] : undefined; },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }],
    getConfiguration: () => cfg,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    openTextDocument: async (uri) => ({ file: uri.fsPath }),
  },
  commands: {
    executeCommand: async (id, ...args) => {
      if (commandThrows) throw new Error(commandThrows);
      commands.push([id, ...args]);
      if (!declaredCommands.has(id) && !id.startsWith('workbench.') && !['setContext', 'vscode.open', 'vscode.diff', 'revealFileInOS'].includes(id)) throw new Error("command '" + id + "' not found");
    },
  },
};

/* ---- stubbed data modules ---- */
let builds = 0; let modelRev = 1; let buildThrows = false; let lastInputs = null;
// The accounts the stubbed model carries. Mutable: a probe removes one to move "the model last built".
let stubAccounts = [
  { key: 'acct0123456789ab', name: 'atlas', provider: 'claude' },
  { key: 'acctcodex0000001', name: 'codex-main', provider: 'codex' },
  { key: 'acctcursor000001', name: 'cursor', provider: 'cursor' },
  { key: 'acctgemini000001', name: 'agy-lab', provider: 'gemini' },
  { key: 'acctmartian00001', name: 'martian', provider: 'martian' },
  { key: 'acctproto0000001', name: 'proto', provider: '__proto__' },
  { key: 'acctnoprov000001', name: 'noprov' },
];
let stubSettings = null; // when set, replaces what the host read (a hostile / damaged model)
const RESOLVABLE = new Set(['acct0123456789ab', 'acctcodex0000001', 'acctcursor000001', 'acctgemini000001', 'acctmartian00001', 'acctproto0000001', 'acctnoprov000001', 'acctnotinmodel01']);
const uiModel = {
  buildDashboardModel: (inputs) => { builds++; lastInputs = inputs; if (buildThrows) throw new Error('boom <img src=x>'); return { schema: 2, generatedAt: Date.now() + builds, workspace: 'ws', scope: inputs.scope, orchestrator: null, health: inputs.health, accounts: stubAccounts, tasks: [{ id: 'tknowntask1' }, { id: 'tnooutput01' }], taskTotal: 2, running: { workspace: 0, all: 0 }, daily: [], sessions: inputs.sessions, settings: stubSettings === null ? inputs.settings : stubSettings, rev: modelRev }; },
  validateSetting: (key, value) => {
    const ints = { quotaCooldownMinutes: [1, 1440], workerTimeoutMinutes: [1, 480], meshMaxLiveWorkers: [1, 64], meshHistoryLimit: [1, 1000] };
    if (ints[key]) return Number.isInteger(value) && value >= ints[key][0] && value <= ints[key][1] ? { ok: true, key, value } : { ok: false, error: 'must be an integer in range‮<b>' };
    if (key === 'meshMode' || key === 'sessionKeepalive' || key === 'providerUsagePolling') return typeof value === 'boolean' ? { ok: true, key, value } : { ok: false, error: 'must be a boolean' };
    if (key === 'frontierWorkerDispatch' || key === 'overageWorkerDispatch') return value === 'block' || value === 'allow' ? { ok: true, key, value } : { ok: false, error: 'block or allow' };
    if (key === 'claudePath') return typeof value === 'string' && value.trim() ? { ok: true, key, value: value.trim() } : { ok: false, error: 'bad path' };
    if (key === 'workerPermissionMode') return ['acceptEdits', 'auto', 'dontAsk', 'plan', 'default', 'bypassPermissions'].includes(value) ? { ok: true, key, value } : { ok: false, error: 'unknown mode' };
    return { ok: false, error: 'unknown key' };
  },
  // What the page model's own resolver would answer. Since 2.0 the host does not ask it: a report is the file
  // the registry says the task's id names (the stand-in below). A path from here must never be opened.
  resolveTaskOutput: () => '/wrong/answered-by-the-page-model.md',
  resolveAccount: (key) => (typeof key === 'string' && RESOLVABLE.has(key) ? { name: 'n-' + key, configDir: '/x', isMain: false, isWorker: true } : undefined),
  probeClaudeVersion: async () => '2.1.283 (Claude Code)',
};
let teamInvalidated = 0;
const team = { collectSessions: () => [], resolveSession: (key) => (key === 'worker:abc12345' ? { key } : undefined), invalidateTeamCache: () => { teamInvalidated++; } };
// What the HOST reads of the registry is stood in for: the registry's guard values, and which report a
// task id names. Everything else of the module is the real one — since 2.0 the host (and the modules it
// now imports: settings, workerManager, usage) use more of it than a two-line object can stand in for,
// and they all run under the scratch HOME run.sh made. The stand-in is what dashboard.js alone is given.
const resolved = []; // every (id, kind) the host asked the registry to resolve
let registry = null;
const registryFor = (real) => (registry ??= {
  ...real,
  readRegistry: () => ({ claudePath: '/usr/local/bin/claude', frontierWorkerDispatch: 'allow', frontierGuardSetBy: 'Cursor', overageWorkerDispatch: 'block' }),
  resolveTaskFile: (id, kind) => { resolved.push([id, kind]); return id === 'tknowntask1' && kind === 'output' ? '/tasks/tknowntask1.md' : undefined; },
});

const realLoad = Module._load;
const DASHBOARD_JS = path.join(out, 'dashboard.js');
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (parent && parent.filename && parent.filename.startsWith(out)) {
    if (request === './uiModel') return uiModel;
    if (request === './team') return team;
    if (request === './registry' && parent.filename === DASHBOARD_JS) return registryFor(realLoad.call(this, request, parent, isMain));
  }
  return realLoad.call(this, request, parent, isMain);
};

(async () => {
  const dash = require(path.join(out, 'dashboard.js'));
  const context = { extensionUri: { path: '/ext' }, extension: { id: 'pub.cco' }, subscriptions: [], workspaceState: { store: {}, get(k) { return this.store[k]; }, async update(k, v) { this.store[k] = v; } } };

  dash.openDashboard(context);
  dash.openDashboard(context);
  const p = panels[0];
  check('H1 singleton: a second open reveals, it does not create', panels.length === 1 && p.revealed === 1, { panels: panels.length, revealed: p.revealed });
  check('H2 panel options', p.options.enableScripts === true && p.options.retainContextWhenHidden === true && p.options.localResourceRoots.length === 1 && p.options.localResourceRoots[0].path === '/ext/media/dashboard', p.options);

  const html = p.html;
  const nonce = (/script-src &#39;nonce-([0-9a-f]{32})&#39;/.exec(html) || [])[1];
  const scripts = html.match(/<script[^>]*>/g) || [];
  check('H3 CSP is the contract policy, with a 128-bit nonce', !!nonce && html.includes(`default-src &#39;none&#39;; img-src ${p.webview.cspSource} data:; style-src ${p.webview.cspSource}; script-src &#39;nonce-${nonce}&#39;; font-src ${p.webview.cspSource};`), (/content="([^"]+)"/.exec(html) || [])[1]);
  check('H4 exactly two scripts, both nonced; one stylesheet; no inline style or handler', scripts.length === 2 && scripts.every((s) => s.includes(`nonce="${nonce}"`)) && (html.match(/<link rel="stylesheet"/g) || []).length === 1 && !/style="/.test(html) && !/\son[a-z]+=/.test(html) && !/<style/.test(html), scripts);
  check('H5 inline script only assigns the string table, escaped for a script block', /<script nonce="[0-9a-f]+">window\.__CCO_STRINGS__ = \{.*\};<\/script>/.test(html) && html.includes('lang="ko"'), html.split('\n').find((l) => l.includes('__CCO_STRINGS__')).slice(0, 90));

  await sleep(50);
  check('H6 nothing is posted before the page says ready', p.posted.length === 0 && builds === 0, { posted: p.posted.length, builds });
  intervalFn();
  check('H7 a tick before ready builds nothing', builds === 0, { builds });

  p.msgFn({ type: 'ready' });
  await sleep(120);
  const first = p.posted[0];
  check('H8 ready -> one model, with settings and health assembled by the host', p.posted.length === 1 && first.type === 'model' && first.model.settings.frontierWorkerDispatch.effective === 'allow' && first.model.settings.frontierWorkerDispatch.setBy === 'Cursor' && first.model.health.mcpInstalled === true && first.model.health.policyInstalled === false && first.model.health.teamAgentInstalled === false && first.model.health.claudeVersion === '2.1.283 (Claude Code)' && first.model.health.sessionWorkersSupported === true, { n: p.posted.length, guard: first.model.settings.frontierWorkerDispatch, health: first.model.health });

  let before = p.posted.length; const buildsBefore = builds;
  intervalFn(); intervalFn(); await sleep(20);
  check('H9 unchanged model (only generatedAt differs) is built but NOT posted', p.posted.length === before && builds === buildsBefore + 2, { posted: p.posted.length - before, builds: builds - buildsBefore });
  modelRev = 2; intervalFn(); await sleep(20);
  check('H10 a changed model is posted', p.posted.length === before + 1, { posted: p.posted.length - before });

  p.visible = false; modelRev = 3; let b2 = builds; before = p.posted.length;
  intervalFn(); intervalFn(); await sleep(20);
  check('H11 hidden: no build, no post', builds === b2 && p.posted.length === before, { builds: builds - b2, posted: p.posted.length - before });
  p.visible = true; p.viewFns.forEach((f) => f()); await sleep(20);
  check('H12 becoming visible refreshes at once', p.posted.length === before + 1, { posted: p.posted.length - before });

  /* ---- inbound validation ---- */
  const quiet = async (msg) => { const c = commands.length, u = updates.length, n = p.posted.length; let threw = null; clockSkew += 2000; try { p.msgFn(msg); } catch (e) { threw = String(e); } await sleep(25); return { commands: commands.length - c, updates: updates.length - u, posted: p.posted.slice(n), threw }; };
  const junk = [null, undefined, 7, 'ready', [], { }, { type: 5 }, { type: 'nope' }, { type: '__proto__' }, { type: 'setSetting', key: '__proto__', value: 1 }, { type: 'setSetting', key: 'toString', value: 1 }, { type: 'setSetting', key: 'assetPacks', value: [] }, { type: 'command', id: 'removeWorker' }, { type: 'command', id: 'constructor' }, { type: 'command' }, { type: 'setScope', scope: 'everything' }, { type: 'openTask', id: '../../etc/passwd' }, { type: 'openTask', id: 42 }, { type: 'openTask', file: '/etc/passwd' }, { type: 'cancelTask', id: 'tunknown0001' }, { type: 'session', action: 'rm -rf', key: 'worker:abc12345' }, { type: 'session', action: 'stop', key: 'worker:nope' }, { type: 'session', action: 'stop', key: { toString() { return 'worker:abc12345'; } } }, { type: 'account', action: 'remove', account: 'nope' }, { type: 'account', action: 'eval', account: 'acct0123456789ab' }, { type: 'account', action: 'relogin', account: ['acct0123456789ab'] }, { type: 'setSetting', key: 'providers', value: [] }, { type: 'setSetting', key: 'workerModels', value: ['x'] }, { type: 'account', action: 'setPermissionMode', account: 'nope', value: null }, { type: 'account', action: 'setPermissionMode' }, { type: 'account', action: 'setProvider', account: 'acctcodex0000001', value: 'claude' }];
  let sideEffects = 0; let threw = 0;
  for (const j of junk) { const r = await quiet(j); sideEffects += r.commands + r.updates; if (r.threw) threw++; if (r.posted.some((m) => m.type !== 'model')) sideEffects++; }
  check('H13 ' + junk.length + ' malformed / unknown messages: no command, no setting write, no reply, no throw', sideEffects === 0 && threw === 0, { sideEffects, threw });
  const logLines = channels.length ? channels[0].lines : [];
  const dupBefore = logLines.length; await quiet({ type: 'nope' }); await quiet({ type: 'nope' });
  check('H14 ignored messages are logged, each distinct one once', logLines.length > 5 && logLines.length === dupBefore && logLines.every((l) => l.startsWith('[dashboard] ignored ')), { lines: logLines.length, sample: logLines.slice(0, 3) });

  let r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: '60' });
  let sr = r.posted.find((m) => m.type === 'settingResult');
  check('H15 numeric string for an integer setting: rejected, answered with the value still in effect, error flattened', r.updates === 0 && sr && sr.ok === false && sr.value === 45 && sr.key === 'workerTimeoutMinutes' && typeof sr.error === 'string' && !/[‪-‮]/.test(sr.error), sr);
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 100000 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('H16 out-of-range value: not applied', r.updates === 0 && sr && sr.ok === false && sr.value === 45, sr);
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 60 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('H17 valid value: written to Global, answered with the value read back', r.updates === 1 && updates[updates.length - 1][2] === 1 && sr && sr.ok === true && sr.value === 60 && sr.error === null, { update: updates[updates.length - 1], sr });
  cfgWorkspace.meshMaxLiveWorkers = 4;
  r = await quiet({ type: 'setSetting', key: 'meshMaxLiveWorkers', value: 16 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('H18 [UPDATED for W5 SHELL-A] a workspace value shadows nothing: ok, the value in effect is the one just saved for the user, no caveat', sr && sr.ok === true && sr.value === 16 && sr.error === null, sr);
  updateThrows = true;
  r = await quiet({ type: 'setSetting', key: 'meshMode', value: true });
  sr = r.posted.find((m) => m.type === 'settingResult'); updateThrows = false;
  check('H19 the settings write itself fails: ok false with the reason, value unchanged', sr && sr.ok === false && sr.value === false && /not writable/.test(sr.error), sr);
  r = await quiet({ type: 'setSetting', key: 'frontierWorkerDispatch', value: 'allow' });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('H20 guard setting answers with the plain value, not the guard object', sr && sr.ok === true && sr.value === 'allow', sr);
  check('H20b [NEW for W5 SHELL-A] …and it was stored only after ONE modal with a specific confirm button', modals.length === 1 && modals[0][1] === true && modals[0][2].length === 1 && modals[0][2][0] === 'Allow Frontier Dispatches', modals);

  r = await quiet({ type: 'command', id: 'installMcp' });
  check('H21 known command -> extension command, no argument from the page', r.commands === 1 && commands[commands.length - 1].length === 1 && commands[commands.length - 1][0] === 'claudeCodeOrchestrator.installMcp', commands[commands.length - 1]);
  r = await quiet({ type: 'command', id: 'openSettings', extra: 'x' });
  check('H22 openSettings -> the editor settings filtered to this extension', commands[commands.length - 1][0] === 'workbench.action.openSettings' && commands[commands.length - 1][1] === '@ext:pub.cco', commands[commands.length - 1]);

  r = await quiet({ type: 'openTask', id: 'tknowntask1', file: '/etc/passwd' });
  // [2.0: "the host resolver" was uiModel.resolveTaskOutput] — it is registry.resolveTaskFile(id, 'output') now
  check('H23 openTask: the file comes from the host resolver — the registry, asked for the report of that id — never from the message and never from the page model',
    opened.length === 1 && opened[0][1] === '/tasks/tknowntask1.md' && JSON.stringify(resolved[resolved.length - 1]) === JSON.stringify(['tknowntask1', 'output']) && !resolved.some((r) => r[0] !== 'tknowntask1' && r[0] !== 'tnooutput01'), { opened, resolved });
  r = await quiet({ type: 'openTask', id: 'tnooutput01' });
  check('H24 openTask for a shown task with no output: a notice, nothing opened', opened.length === 1 && r.posted.some((m) => m.type === 'notice' && m.level === 'warning') && JSON.stringify(resolved[resolved.length - 1]) === JSON.stringify(['tnooutput01', 'output']), r.posted.filter((m) => m.type === 'notice'));
  r = await quiet({ type: 'cancelTask', id: 'tknowntask1' });
  check('H25 cancelTask for a shown id -> cancelTask {id}', r.commands === 1 && JSON.stringify(commands[commands.length - 1]) === JSON.stringify(['claudeCodeOrchestrator.cancelTask', { id: 'tknowntask1' }]), commands[commands.length - 1]);
  r = await quiet({ type: 'session', action: 'stop', key: 'worker:abc12345', path: '/tmp/x' });
  check('H26 session action for a resolvable key -> sessionAction {action,key} only', r.commands === 1 && JSON.stringify(commands[commands.length - 1]) === JSON.stringify(['claudeCodeOrchestrator.sessionAction', { action: 'stop', key: 'worker:abc12345' }]) && teamInvalidated > 0, commands[commands.length - 1]);
  r = await quiet({ type: 'account', action: 'setModel', account: 'acct0123456789ab', value: 'gpt-4; rm -rf /' });
  check('H27 setModel with a value that is not a model: refused with a notice, no command', r.commands === 0 && r.posted.some((m) => m.type === 'notice' && m.level === 'error'), r.posted.filter((m) => m.type === 'notice'));
  r = await quiet({ type: 'account', action: 'setModel', account: 'acct0123456789ab', value: ' Claude-Opus-4-8 ' });
  // [UPDATED wave 10: the page's value is normalized but a v1.x tier id is kept exact (it is stored pinned)]
  check('H28 setModel passes the NORMALIZED model', r.commands === 1 && commands[commands.length - 1][1].value === 'claude-opus-4-8', commands[commands.length - 1]);
  r = await quiet({ type: 'account', action: 'remove', account: 'acct0123456789ab', value: 'ignored' });
  check('H29 other account actions carry no value', r.commands === 1 && JSON.stringify(commands[commands.length - 1][1]) === JSON.stringify({ action: 'remove', account: 'acct0123456789ab' }), commands[commands.length - 1]);

  commandThrows = "command 'claudeCodeOrchestrator.addWorker' not found";
  r = await quiet({ type: 'command', id: 'addWorker' }); commandThrows = null;
  check('H30 a throwing handler becomes a notice, not an exception', r.threw === null && r.posted.some((m) => m.type === 'notice' && m.level === 'error' && /not found/.test(m.text)), r.posted.filter((m) => m.type === 'notice'));

  r = await quiet({ type: 'setScope', scope: 'all' });
  check('H31 setScope: remembered per workspace and reflected in the next model', context.workspaceState.store['dashboard.scope'] === 'all' && lastInputs.scope === 'all' && r.posted.some((m) => m.type === 'model' && m.model.scope === 'all'), { stored: context.workspaceState.store, scope: lastInputs.scope });

  buildThrows = true; before = p.posted.length; intervalFn(); intervalFn(); intervalFn(); await sleep(20); buildThrows = false;
  const notices = p.posted.slice(before).filter((m) => m.type === 'notice');
  check('H32 a throwing model build: ONE notice for three ticks, text flattened, no model', notices.length === 1 && p.posted.slice(before).every((m) => m.type !== 'model'), notices);

  /* ---- wave 2: providers ---- */
  const lastCmd = () => commands[commands.length - 1];
  const fresh = p.posted.filter((m) => m.type === 'model').pop().model;
  const prov = fresh.settings.providers;
  check('P1 the model carries the four CLIs from providers.ts, in order, with their own modes and capabilities',
    Array.isArray(prov) && prov.map((x) => x.id).join() === 'claude,codex,cursor,gemini' && prov[0].sessionWorkers === true && prov.slice(1).every((x) => x.sessionWorkers === false)
    && prov[1].isolation === 'env' && prov[1].isolationVerified === true && prov[2].isolation === 'none' && prov[3].isolation === 'env' && prov[3].isolationVerified === false
    && prov[1].permissionModes.join() === 'workspace-write,read-only,danger-full-access' && prov[2].permissionModes.join() === 'enabled,disabled' && prov[3].permissionModes.join() === 'accept-edits,plan'
    && prov.every((x) => typeof x.label === 'string' && x.label.length > 0 && x.label.length <= 32 && Array.isArray(x.models) && x.models.length > 0),
    prov.map((x) => [x.id, x.label, x.isolation, x.isolationVerified, x.sessionWorkers, x.permissionModes.length, x.models.length]));
  check('P2 providerUsagePolling is ON when the setting was never written', fresh.settings.providerUsagePolling === true, fresh.settings.providerUsagePolling);

  r = await quiet({ type: 'setSetting', key: 'providerUsagePolling', value: 'false' });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('P3 providerUsagePolling as the STRING "false": rejected, answered with the value in effect (true)', r.updates === 0 && sr && sr.ok === false && sr.value === true && sr.key === 'providerUsagePolling', sr);
  r = await quiet({ type: 'setSetting', key: 'providerUsagePolling', value: 0 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('P4 providerUsagePolling as the number 0: rejected', r.updates === 0 && sr && sr.ok === false && sr.value === true, sr);
  r = await quiet({ type: 'setSetting', key: 'providerUsagePolling', value: false });
  sr = r.posted.find((m) => m.type === 'settingResult');
  let after = r.posted.filter((m) => m.type === 'model').pop();
  check('P5 providerUsagePolling false: written to Global, answered false, and the next model says false', r.updates === 1 && JSON.stringify(updates[updates.length - 1]) === JSON.stringify(['providerUsagePolling', false, 1]) && sr && sr.ok === true && sr.value === false && after && after.model.settings.providerUsagePolling === false, { update: updates[updates.length - 1], sr });
  cfgStore.providerUsagePolling = 'no'; intervalFn(); await sleep(20);
  after = p.posted.filter((m) => m.type === 'model').pop();
  check('P6 a hand-edited non-boolean value does not switch the readings off', after.model.settings.providerUsagePolling === true, after.model.settings.providerUsagePolling);
  cfgStore.providerUsagePolling = true; intervalFn(); await sleep(20);

  const ACTION = 'claudeCodeOrchestrator.accountAction';
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'read-only', extra: 'x' });
  check('P7 setPermissionMode with a mode of that CLI -> accountAction {action, account, value} and nothing else', r.commands === 1 && JSON.stringify(lastCmd()) === JSON.stringify([ACTION, { action: 'setPermissionMode', account: 'acctcodex0000001', value: 'read-only' }]), lastCmd());
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: null });
  check('P8 setPermissionMode null (the default of the CLI) is passed as null', r.commands === 1 && lastCmd()[1].value === null && 'value' in lastCmd()[1], lastCmd());
  const linesBefore = logLines.length;
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'plan' });
  const r2 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'plan' });
  check('P9 a mode of ANOTHER CLI ("plan" on a Codex account): no command, no reply, logged once for two attempts', r.commands === 0 && r2.commands === 0 && r.posted.every((m) => m.type === 'model') && logLines.length === linesBefore + 1 && /ignored permission mode: plan/.test(logLines[logLines.length - 1]), { commands: r.commands + r2.commands, newLines: logLines.slice(linesBefore) });
  const badModes = ['READ-ONLY', ' read-only', 'read-only ', 'read-only\n', '', 7, true, undefined, ['read-only'], { toString() { return 'read-only'; } }, '__proto__', 'constructor', 'length', 'includes', 'workspace-write,read-only', '<img src=x onerror=alert(1)>', 'x'.repeat(5000)];
  let leaked = 0; let noticed = 0;
  for (const value of badModes) { const q = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value }); leaked += q.commands; noticed += q.posted.filter((m) => m.type !== 'model').length; }
  const q0 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001' });
  check('P10 ' + (badModes.length + 1) + ' values that are not a mode of the CLI (case, spaces, types, absent, prototype names, 5,000 chars): none reaches a command, none is answered', leaked === 0 && noticed === 0 && q0.commands === 0, { leaked, noticed, absent: q0.commands, longLine: Math.max(...logLines.map((l) => l.length)) });
  check('P11 every log line stays short and single-line whatever was sent', logLines.every((l) => l.length < 200 && !/[\r\n\u202e]/.test(l)), { longest: Math.max(...logLines.map((l) => l.length)) });
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcursor000001', value: 'enabled' });
  const g = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctgemini000001', value: 'plan' });
  const c1 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acct0123456789ab', value: 'plan' });
  const c2 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acct0123456789ab', value: 'workspace-write' });
  const cu = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcursor000001', value: 'accept-edits' });
  check('P12 membership is per CLI: Cursor enabled yes, Antigravity plan yes, Claude Code plan yes, Claude Code workspace-write no, Cursor accept-edits no', r.commands === 1 && g.commands === 1 && c1.commands === 1 && c2.commands === 0 && cu.commands === 0, [r.commands, g.commands, c1.commands, c2.commands, cu.commands]);
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctnotinmodel01', value: null });
  const nm = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctnotinmodel01', value: 'read-only' });
  check('P13 an account the registry knows but the last model did not carry: ignored, even for null', r.commands === 0 && nm.commands === 0 && logLines.some((l) => /not in the last model/.test(l)), logLines.filter((l) => /not in the last model/.test(l)));
  const m1 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctmartian00001', value: 'plan' });
  const m2 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctproto0000001', value: 'plan' });
  const m3 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctproto0000001', value: 'hasOwnProperty' });
  const m4 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctnoprov000001', value: null });
  check('P14 an account on a CLI the model does not list (an unknown id, "__proto__", no id): no string is accepted', m1.commands === 0 && m2.commands === 0 && m3.commands === 0 && m4.commands === 0, [m1.commands, m2.commands, m3.commands, m4.commands]);

  // The check follows the model LAST BUILT, not the first one.
  stubAccounts = stubAccounts.filter((a) => a.key !== 'acctgemini000001'); intervalFn(); await sleep(20);
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctgemini000001', value: 'plan' });
  check('P15 once a later model no longer carries the account, its mode is no longer accepted', r.commands === 0, { commands: r.commands });
  stubAccounts = stubAccounts.concat([{ key: 'acctgemini000001', name: 'agy-lab', provider: 'gemini' }]);
  stubSettings = { providers: [{ id: 'codex', permissionModes: ['only-this'] }, { id: 'codex', permissionModes: ['read-only', 'second-entry'] }, null, 'x', { id: 7, permissionModes: ['n'] }, { id: 'cursor', permissionModes: 'enabled' }, { id: 'gemini', permissionModes: [1, null, 'plan', {}] }] };
  intervalFn(); await sleep(20);
  const s1 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'only-this' });
  const s2 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'read-only' });
  const s3 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: 'second-entry' });
  const s4 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcursor000001', value: 'enabled' });
  const s5 = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctgemini000001', value: 'plan' });
  check('P16 the offered modes are the last model\'s: a changed list is honoured, a repeated id cannot widen it, a non-array offers nothing, non-strings are dropped', s1.commands === 1 && s2.commands === 0 && s3.commands === 0 && s4.commands === 0 && s5.commands === 1, [s1.commands, s2.commands, s3.commands, s4.commands, s5.commands]);
  stubSettings = { providers: 'none' }; stubAccounts = null; let threwOnDamaged = null;
  try { intervalFn(); } catch (e) { threwOnDamaged = String(e); }
  await sleep(20);
  r = await quiet({ type: 'account', action: 'setPermissionMode', account: 'acctcodex0000001', value: null });
  check('P17 a model with no account list and no provider list: recording it does not throw, and then nothing is accepted', threwOnDamaged === null && r.commands === 0 && r.threw === null, { threwOnDamaged, commands: r.commands });
  stubSettings = null;
  stubAccounts = [
    { key: 'acct0123456789ab', name: 'atlas', provider: 'claude' }, { key: 'acctcodex0000001', name: 'codex-main', provider: 'codex' }, { key: 'acctcursor000001', name: 'cursor', provider: 'cursor' },
    { key: 'acctgemini000001', name: 'agy-lab', provider: 'gemini' }, { key: 'acctmartian00001', name: 'martian', provider: 'martian' }, { key: 'acctnoprov000001', name: 'noprov' },
  ];
  intervalFn(); await sleep(20);

  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001' });
  check('P18 setModel with NO value ("Other…"): the command is run without a value, so it asks', r.commands === 1 && JSON.stringify(lastCmd()) === JSON.stringify([ACTION, { action: 'setModel', account: 'acctcodex0000001' }]) && !('value' in lastCmd()[1]), lastCmd());
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001', value: '  gpt-5.6-terra ' });
  check('P19 a Codex model id is accepted for a Codex account, trimmed', r.commands === 1 && lastCmd()[1].value === 'gpt-5.6-terra', lastCmd());
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcursor000001', value: 'claude-4.6-sonnet[thinking=true,effort=high]' });
  check('P20 a parameterized Cursor id (brackets, =, comma) is accepted for a Cursor account', r.commands === 1 && lastCmd()[1].value === 'claude-4.6-sonnet[thinking=true,effort=high]', lastCmd());
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001', value: null });
  check('P21 setModel null on a non-Claude account ("let the CLI choose") is passed as null', r.commands === 1 && lastCmd()[1].value === null && 'value' in lastCmd()[1], lastCmd());
  r = await quiet({ type: 'account', action: 'setModel', account: 'acct0123456789ab', value: null });
  check('P22 setModel null on a Claude Code account: refused with a notice, no command', r.commands === 0 && r.posted.some((m) => m.type === 'notice' && m.level === 'error'), r.posted.filter((m) => m.type === 'notice'));
  const badModels = ['opus sonnet', 'gpt-5; rm -rf /', '$(id)', '`id`', 'a|b', '-rf', '', '   ', 'x'.repeat(121), 'model\nname', '<img src=x>', 42, true, {}, ['gpt-5.5']];
  let ranBad = 0; let saidBad = 0;
  for (const value of badModels) { const q = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001', value }); ranBad += q.commands; saidBad += q.posted.filter((m) => m.type === 'notice' && m.level === 'error').length; }
  check('P23 ' + badModels.length + ' values that are not a model id for a Codex account: each refused WITH a notice, none run', ranBad === 0 && saidBad === badModels.length, { ranBad, saidBad });
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001', value: 'opus sonnet' });
  const hint = (r.posted.find((m) => m.type === 'notice') || {}).text;
  check('P24 the refusal names what that CLI takes (a Codex id), not the Claude aliases', typeof hint === 'string' && /Codex model id/.test(hint) && !/opus, sonnet/.test(hint), hint);
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctcodex0000001', value: 'opus' });
  check('P25 "opus" for a Codex account has the SHAPE of an id, so it is passed on (the CLI rejects it, contract 10.5)', r.commands === 1 && lastCmd()[1].value === 'opus', lastCmd());
  const u1 = await quiet({ type: 'account', action: 'setModel', account: 'acctmartian00001', value: 'x-1' });
  const u2 = await quiet({ type: 'account', action: 'setModel', account: 'acctnoprov000001', value: 'opus' });
  const u3 = await quiet({ type: 'account', action: 'setModel', account: 'acctnotinmodel01', value: 'opus' });
  const u4 = await quiet({ type: 'account', action: 'setModel', account: 'acctnotinmodel01', value: null });
  check('P26 a model VALUE for an account whose CLI the last model does not name (unknown id, none, not in the model): ignored and logged', u1.commands + u2.commands + u3.commands + u4.commands === 0 && logLines.some((l) => /model choice/.test(l)), { ran: u1.commands + u2.commands + u3.commands + u4.commands, lines: logLines.filter((l) => /model choice/.test(l)).length });
  r = await quiet({ type: 'account', action: 'setModel', account: 'acctnotinmodel01' });
  check('P27 "Other…" needs no CLI on this side: it is run for any resolvable account, and the command decides', r.commands === 1 && !('value' in lastCmd()[1]), lastCmd());
  r = await quiet({ type: 'account', action: 'togglePreferred', account: 'acctcodex0000001', value: 'danger-full-access' });
  check('P28 an action that takes no value never carries one, whatever the page attached', r.commands === 1 && JSON.stringify(lastCmd()[1]) === JSON.stringify({ action: 'togglePreferred', account: 'acctcodex0000001' }), lastCmd());

  const table = dash.dashboardStrings();
  const wanted = ['provHome', 'provRunsOn', 'provLegendLabel', 'acctStateLoggedIn', 'acctUsageLabel', 'acctNoReading', 'acctNoReadingBody', 'acctNoReadingOff', 'acctModelCli', 'acctOneShot', 'acctOneShotTip', 'statTokensNA', 'statTokensNATip', 'menuModelCli', 'menuModelOther', 'menuPermission', 'menuPermCli', 'menuPermShared', 'menuPermSharedTip', 'onboardClis', 'filterProviderLabel', 'filterProviderHead', 'taskProviderTip', 'detailProvider', 'groupProviders', 'groupProvidersNote', 'setProviderPolling', 'setProviderPollingHint', 'provTableCaption', 'provColProvider', 'provColLogins', 'provColSessions', 'provYes', 'provNo', 'provUnverified', 'provLoginsYesTip', 'provLoginsUnverifiedTip', 'provLoginsNoTip', 'provSessionsYesTip', 'provSessionsNoTip', 'addWorkerOther'];
  const absent = wanted.filter((k) => typeof table[k] !== 'string' || table[k] === '');
  check('P29 the string table carries every new key, and every value in it is a non-empty string', absent.length === 0 && Object.values(table).every((v) => typeof v === 'string' && v !== ''), { keys: Object.keys(table).length, absent });

  /* ---- K-SHELL (K13): a setting the shared registry could not take ---- */
  const LOCK_MSG = 'Could not lock registry.json: process 4242 (node) has held its lock for more than 15s. Nothing was changed. If it is busy, try again later. If it is idle, stuck, or not an orchestrator window, server or task, the lock is stale: deleting the lock file is safe once that process is confirmed idle or gone. The lock belongs to process 4242 and is the file /home/u/.claude-code-orchestrator/registry.json.lock';
  let syncCalls = 0; let syncAnswer; let syncThrows = false;
  dash.setDashboardSettingsSync(() => { syncCalls++; if (syncThrows) throw new Error('sync exploded'); return syncAnswer; });
  syncAnswer = undefined;
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 61 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('K1 with the registry step answering "written": the setting is stored, the step was asked once, and the control is told saved', r.updates === 1 && syncCalls === 1 && sr && sr.ok === true && sr.value === 61 && sr.error === null, { syncCalls, sr });
  syncAnswer = LOCK_MSG;
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 62 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('K2 the registry REFUSED the write (its lock stayed held): the answer is ok:false — never "saved" — and carries the lock\'s own message whole: the file, the holder, what to do, the lock\'s path',
    r.updates === 1 && sr && sr.ok === false && sr.key === 'workerTimeoutMinutes' && /shared registry could not be written/.test(sr.error) && sr.error.includes('Could not lock registry.json: process 4242 (node)') && sr.error.includes('Nothing was changed') && sr.error.endsWith('registry.json.lock') && r.threw === null,
    { ok: sr && sr.ok, value: sr && sr.value, error: sr && sr.error.slice(0, 150), length: sr && sr.error.length });
  check('K3 …and it says what the editor now holds (the value it stored), so the control is not left showing a value nobody has', sr && sr.value === 62, sr && sr.value);
  const callsBefore = syncCalls;
  r = await quiet({ type: 'setSetting', key: 'sessionKeepalive', value: true });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('K4 a setting only the EDITOR reads (sessionKeepalive) is saved whatever the registry is doing — the step is not even asked', sr && sr.ok === true && sr.value === true && syncCalls === callsBefore, { sr, asked: syncCalls - callsBefore });
  for (const key of ['workerPermissionMode', 'claudePath', 'quotaCooldownMinutes', 'frontierWorkerDispatch', 'overageWorkerDispatch', 'meshMode', 'meshMaxLiveWorkers', 'meshHistoryLimit', 'providerUsagePolling']) {
    const value = { workerPermissionMode: 'auto', claudePath: '/opt/claude', quotaCooldownMinutes: 31, frontierWorkerDispatch: 'block', overageWorkerDispatch: 'allow', meshMode: true, meshMaxLiveWorkers: 9, meshHistoryLimit: 51, providerUsagePolling: false }[key];
    r = await quiet({ type: 'setSetting', key, value });
    sr = r.posted.find((m) => m.type === 'settingResult');
    if (!(sr && sr.ok === false && sr.error.includes('Could not lock registry.json'))) check('K5 ' + key + ' is a registry setting and is answered not saved while the registry refuses', false, sr);
  }
  check('K5 every other dashboard setting is one the dispatch server reads from the registry: each of the nine is answered ok:false while the registry refuses', true);
  syncThrows = true;
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 63 });
  sr = r.posted.find((m) => m.type === 'settingResult'); syncThrows = false;
  check('K6 a registry step that THROWS is also "not saved", with what it threw — nothing escapes the message handler', r.threw === null && sr && sr.ok === false && /sync exploded/.test(sr.error) && !r.posted.some((m) => m.type === 'notice'), sr);
  syncAnswer = undefined;
  r = await quiet({ type: 'setSetting', key: 'workerTimeoutMinutes', value: 64 });
  sr = r.posted.find((m) => m.type === 'settingResult');
  check('K7 once the registry takes the write again, the same control is told saved', sr && sr.ok === true && sr.value === 64 && sr.error === null, sr);
  const page = fs.readFileSync(path.join(process.argv[3], 'media', 'dashboard', 'dashboard.js'), 'utf8');
  check('K8 the page keeps 700 characters of a save error (the lock\'s message is ~450 and ends with the path of the lock)', page.includes('const note = str(msg.error, 700);') && LOCK_MSG.length < 700 - 90, { lockMessage: LOCK_MSG.length });
  const t2 = dash.dashboardStrings();
  check('K9 the string table carries the three keys this task added, each a non-empty string', ['winPrimary', 'winSecondary', 'acctExpiredBodyRun'].every((k) => typeof t2[k] === 'string' && t2[k] !== ''), [t2.winPrimary, t2.winSecondary, t2.acctExpiredBodyRun]);

  p.disposeFns.forEach((f) => f());
  check('H33 dispose clears the timer', intervalCleared === true, { intervalCleared });
  before = p.posted.length; modelRev = 99; intervalFn && intervalFn(); await sleep(20);
  check('H34 nothing is built or posted after dispose', p.posted.length === before, { posted: p.posted.length - before });
  dash.openDashboard(context);
  check('H35 after dispose a new open creates a new panel', panels.length === 2, { panels: panels.length });
  panels[1].disposeFns.forEach((f) => f());

  fs.rmSync(ws, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
