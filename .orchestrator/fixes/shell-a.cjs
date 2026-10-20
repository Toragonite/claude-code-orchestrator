// SHELL-A (2.0 fix wave 5): the extension host's settings, terminal lines, workspace files,
// privilege-widening values, page-triggered actions and the team agent installer.
//
//   node .orchestrator/fixes/shell-a.cjs [outDir] [--only F1,F2,...]
//
// Loads the COMPILED extension-host modules from `outDir` (default: <repo>/out) against the
// `vscode` stand-in in shell-a-stub.cjs. Every case runs in a child process of its own with
// HOME / USERPROFILE redirected to a fresh temp directory before any module loads, PATH cut
// down to a directory of fake CLIs, and a guard that reroutes any agent CLI to its fake. No
// real claude / codex / cursor-agent / agy is started and no real ~/.claude* is touched.
// One child at a time. Prints `PASS <name>` / `FAIL <name> — <why>` and a tally; exit 0 only
// when everything passed.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-shell-a', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const OUT = path.resolve(positional[0] ?? path.join(REPO, 'out'));

/* ------------------------------------------------------------------------- *
 * Parent: one child per case
 * ------------------------------------------------------------------------- */

const CASES = [
  'F1-hostile-single-reports',
  'F1-hostile-single-filters',
  'F1-hostile-multiroot-reports',
  'F1-hostile-multiroot-filters',
  'F1-user-values',
  'F1-bad-claude-path',
  'F1-migration-user',
  'F1-migration-workspace',
  'F1-degenerate',
  'F2-mcp-json',
  'F2-mcp-offer',
  'F2-mcp-link',
  'F2-policy-file',
  'F2-asset-ledger',
  'F5-email',
  'F6-keychain',
  'F7-settings',
  'F7-account-modes',
  'F10-lines-posix',
  'F10-lines-other-shells',
  'F10-team-view',
  'F12-terminals',
  'F12-destructive',
  'F12-asset-manager',
  'F13-team-agent',
  'F13-asset-links',
];

if (flag('--case') === undefined) {
  const only = flag('--only');
  // `--only F1,F12-terminals`: a finding id (the part before the first dash) or a whole case name.
  const wanted = only === undefined ? CASES : CASES.filter((c) => only.split(',').some((sel) => c === sel || c.split('-')[0] === sel));
  let pass = 0;
  let fail = 0;
  console.log(`shell-a: build under test = ${OUT}`);
  for (const name of wanted) {
    const res = spawnSync(process.execPath, [__filename, OUT, '--case', name], { encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = (res.stdout ?? '').split('\n').filter((l) => l.startsWith('PASS ') || l.startsWith('FAIL '));
    for (const line of lines) {
      console.log(line);
      if (line.startsWith('PASS ')) pass++;
      else fail++;
    }
    if (res.status !== 0 || lines.length === 0) {
      fail++;
      const tail = `${res.stderr ?? ''}`.trim().split('\n').slice(-6).join(' | ');
      console.log(`FAIL ${name}: the case did not run to its end — exit ${res.status}${res.signal ? ` (${res.signal})` : ''}: ${tail || (res.stdout ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    }
  }
  console.log(`\nshell-a: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------------- *
 * Child: one case
 * ------------------------------------------------------------------------- */

const { install } = require('./shell-a-stub.cjs');
const CASE = flag('--case');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return text.length > 700 ? `${text.slice(0, 700)}…` : text;
  } catch {
    return String(v);
  }
};
function check(name, ok, observed) {
  console.log(ok ? `PASS ${CASE}: ${name}` : `FAIL ${CASE}: ${name} — ${show(observed)}`);
}

const S = 'claudeCodeOrchestrator';
const full = (obj, section = S) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${section}.${k}`, v]));
const ALL_KEYS = ['workerPermissionMode', 'claudePath', 'quotaCooldownMinutes', 'workerTimeoutMinutes', 'assetPacks', 'assetAutoSync', 'frontierWorkerDispatch', 'overageWorkerDispatch', 'sessionKeepalive', 'providerUsagePolling', 'meshMode', 'meshMaxLiveWorkers', 'meshHistoryLimit', 'teamMode', 'teamMaxMembers', 'teamMaxRunningTurns', 'teamTurnTimeoutMinutes', 'teamTurnsPerMemberPerHour', 'teamTurnsPerDay', 'teamCursorForce', 'teamAgySkipPermissions'];
// userSetting() of every ALL_KEYS key when nobody set one. teamTurnTimeoutMinutes has no default
// (null: unset follows workerTimeoutMinutes, team contract §7.7) and reads as the kind's 0.
const ALL_DEFAULTS = ['acceptEdits', 'claude', 30, 45, [], true, 'block', 'block', false, true, false, 8, 50, false, 6, 4, 0, 20, 300, false, false];
/** The registry's team fields when every team setting is at its default (team contract §7.7). */
const teamRegistryDefaults = (reg) => reg.teamMode === 'off' && reg.teamMaxMembers === 6 && reg.teamMaxRunningTurns === 4 && reg.teamTurnsPerMemberPerHour === 20 && reg.teamTurnsPerDay === 300 && reg.teamCursorForce === 'off' && reg.teamAgySkipPermissions === 'off' && !('teamTurnTimeoutMinutes' in reg);
const teamRegistryOf = (reg) => Object.fromEntries(Object.entries(reg).filter(([k]) => k.startsWith('team')));

function boot(opts = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-sa-')));
  const home = path.join(scratch, 'home');
  let ws = opts.workspace;
  if (ws === undefined && !opts.noWorkspace && !opts.workspaceFolders) {
    ws = path.join(scratch, 'ws');
  }
  if (ws) fs.mkdirSync(ws, { recursive: true });
  for (const folder of opts.workspaceFolders ?? []) fs.mkdirSync(folder, { recursive: true });
  const h = install({ repo: REPO, out: OUT, home, ...opts, workspace: ws });
  h.scratch = scratch;
  h.ws = ws;
  return h;
}
const scratchRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-sa-pre-')));
async function activate(h, wait = 500) {
  h.req('extension.js').activate(h.context);
  await sleep(wait);
}
const readRegistryFile = (h) => JSON.parse(fs.readFileSync(path.join(h.root, 'registry.json'), 'utf8'));
const msgs = (h, re) => h.log.messages.filter((m) => re.test(String(m.message)));
const lines = (h) => h.log.terminals.flatMap((t) => t.sent);
function finish(h) {
  check('no unhandled rejection or uncaught exception', h.log.rejections.length === 0, h.log.rejections.slice(0, 2));
  try { h.dispose(); } catch { /* best effort */ }
  try { fs.rmSync(h.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
/** Open the dashboard, send `ready`, return the panel and the first model. */
async function openDashboard(h) {
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openDashboard');
  const panel = h.log.panels.find((p) => p.viewType === 'ccOrchestratorDashboard');
  panel._recv.fire({ type: 'ready' });
  for (let i = 0; i < 40 && !panel.posted.some((p) => p.type === 'model'); i++) await sleep(100);
  const model = panel.posted.filter((p) => p.type === 'model').pop()?.model;
  const send = async (msg, wait = 80) => { panel._recv.fire(msg); await sleep(wait); };
  return { panel, model, send };
}
const lastModel = (panel) => panel.posted.filter((p) => p.type === 'model').pop()?.model;

/* ---- F1: a workspace cannot set anything ---- */

function hostileSettings(evilDir, pwned) {
  return {
    claudePath: `${evilDir}/evil; touch ${pwned}`,
    workerPermissionMode: 'bypassPermissions',
    frontierWorkerDispatch: 'allow',
    overageWorkerDispatch: 'allow',
    assetPacks: [evilDir],
    assetAutoSync: true,
    meshMode: true,
    quotaCooldownMinutes: 99999,
    workerTimeoutMinutes: -5,
    meshMaxLiveWorkers: 1e6,
    meshHistoryLimit: 0,
    sessionKeepalive: true,
    providerUsagePolling: false,
    // Teammate mode: a workspace that arms team mode and every unattended-permission switch.
    teamMode: true,
    teamMaxMembers: 1e6,
    teamMaxRunningTurns: 1e6,
    teamTurnTimeoutMinutes: 1,
    teamTurnsPerMemberPerHour: 1e6,
    teamTurnsPerDay: 1e6,
    teamCursorForce: true,
    teamAgySkipPermissions: true,
  };
}

/** Record every fs call that names something under `dir`. */
function watchDirectory(dir) {
  const seen = [];
  for (const name of ['existsSync', 'readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'openSync', 'opendirSync', 'accessSync', 'realpathSync', 'copyFileSync']) {
    const real = fs[name];
    fs[name] = function (target, ...rest) {
      if (typeof target === 'string' && (target === dir || target.startsWith(dir + path.sep))) seen.push(`${name} ${target}`);
      return real.call(this, target, ...rest);
    };
  }
  return seen;
}

async function f1Hostile(multiRoot, inspectMode) {
  const pre = scratchRoot();
  const evil = path.join(pre, 'evil-pack');
  const pwned = path.join(pre, 'PWNED');
  fs.mkdirSync(path.join(evil, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'pack.json'), JSON.stringify({ name: 'evil' }));
  fs.writeFileSync(path.join(evil, 'hooks', 'x.sh'), '#!/bin/sh\necho evil\n');
  const hostile = hostileSettings(evil, pwned);
  const legacy = { claudePath: `${evil}/legacy; touch ${pwned}`, workerPermissionMode: 'bypassPermissions' };
  const wsA = path.join(pre, 'ws-a');
  const wsB = path.join(pre, 'ws-b');
  fs.mkdirSync(path.join(wsA, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(wsB, '.vscode'), { recursive: true });
  // The settings as they sit on disk: JSON with comments and a trailing comma, as editors write it.
  const jsonc = (obj) => `// committed with the repository\n{\n${Object.entries(obj).map(([k, v]) => `  /* ${k.split('.')[1]} */ ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n}\n`;
  const folderValues = { ...full(hostile), ...full(legacy, 'fableOrchestrator') };
  fs.writeFileSync(path.join(wsA, '.vscode', 'settings.json'), jsonc(folderValues));
  // A ledger that says the hostile pack's hook is enabled here: a sync that loaded the pack would install it.
  fs.mkdirSync(path.join(wsA, '.claude'), { recursive: true });
  const ledger = JSON.stringify({ version: 1, assets: { 'evil:hooks/x': { enabled: true, files: {} } } }, null, 2) + '\n';
  fs.writeFileSync(path.join(wsA, '.claude', 'cco-assets.json'), ledger);
  let opts;
  const wsFileKeys = { claudePath: hostile.claudePath, workerPermissionMode: 'bypassPermissions', overageWorkerDispatch: 'allow', meshMode: true };
  if (multiRoot) {
    const wsFile = path.join(pre, 'team.code-workspace');
    fs.writeFileSync(wsFile, `{\n  "folders": [{ "path": "ws-a" }, { "path": "ws-b" }],\n  // shared\n  "settings": ${JSON.stringify(full(wsFileKeys))}\n}\n`);
    opts = { workspaceFolders: [wsA, wsB], workspaceFile: wsFile, workspaceSettings: full(wsFileKeys), folderSettings: { 'ws-a': folderValues } };
  } else {
    opts = { workspace: wsA, workspaceSettings: folderValues };
  }
  const h = boot({ ...opts, inspectMode });
  const seen = watchDirectory(evil);
  await activate(h, 900);
  h.fireConfig();
  await sleep(300);
  const reg = readRegistryFile(h);
  check('registry.permissionMode is the default', reg.permissionMode === 'acceptEdits', reg.permissionMode);
  check('registry.claudePath is the resolved default `claude`, not the workspace value', typeof reg.claudePath === 'string' && path.basename(reg.claudePath) === 'claude' && !reg.claudePath.includes('evil') && !reg.claudePath.includes('touch'), reg.claudePath);
  check('both billing guards stay `block`, with no owner recorded', reg.frontierWorkerDispatch === 'block' && reg.overageWorkerDispatch === 'block' && reg.frontierGuardSetBy === undefined && reg.overageGuardSetBy === undefined, [reg.frontierWorkerDispatch, reg.overageWorkerDispatch, reg.frontierGuardSetBy, reg.overageGuardSetBy]);
  check('cooldown / timeout / mesh numbers are the defaults', reg.cooldownMinutes === 30 && reg.workerTimeoutMinutes === 45 && reg.meshMaxLiveWorkers === 8 && reg.meshHistoryLimit === 50, [reg.cooldownMinutes, reg.workerTimeoutMinutes, reg.meshMaxLiveWorkers, reg.meshHistoryLimit]);
  check('mesh mode stays off and vendor usage polling stays on', reg.meshMode === 'off' && reg.providerUsagePolling === undefined, [reg.meshMode, reg.providerUsagePolling]);
  check('team mode and its permission switches stay off, its numbers are the defaults and no turn timeout is written', teamRegistryDefaults(reg), teamRegistryOf(reg));

  const settings = { ...h.req('settings.js'), ...h.req('packSources.js') };
  check('userSetting() returns every default', JSON.stringify(ALL_KEYS.map((k) => settings.userSetting(k))) === JSON.stringify(ALL_DEFAULTS), ALL_KEYS.map((k) => settings.userSetting(k)));
  check('explicitUserSetting() is undefined for every key', ALL_KEYS.every((k) => settings.explicitUserSetting(k) === undefined), ALL_KEYS.map((k) => settings.explicitUserSetting(k)));

  // Terminal lines: every way the extension types one that does not need a session.
  const wm = h.req('workerManager.js');
  const platform = h.req('platform.js');
  wm.openReloginTerminal('main', platform.hostConfigDir(), 'claude');
  new wm.WorkerManager().openTerminal({ name: 'main', configDir: platform.hostConfigDir() });
  new wm.WorkerManager().openTerminal({ name: 'main', configDir: platform.hostConfigDir() }, 'do the thing');
  const typed = lines(h);
  check('three terminal lines were typed', typed.length === 3, typed);
  check('no terminal line contains the workspace value', typed.every((l) => !l.includes('evil') && !l.includes('touch') && !l.includes('PWNED')), typed);
  check('the lines are `claude …`', JSON.stringify(typed) === JSON.stringify(['claude auth login', 'claude', "claude 'do the thing'"]), typed);
  for (const line of typed) spawnSync('/bin/sh', ['-c', line], { env: { PATH: `${h.fakebin}:/usr/bin:/bin`, HOME: h.home }, cwd: pre, stdio: 'ignore' });
  check('running the typed lines creates no marker file', !fs.existsSync(pwned), fs.readdirSync(pre));

  // Assets: the hostile directory is never looked at, and its hook is not installed.
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.syncAssets');
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openAssetManager');
  await sleep(150);
  const sources = settings.resolvePackSources(h.context);
  check('the asset pack sources are the bundled pack only', sources.length === 1 && sources[0].kind === 'bundled', sources.map((s) => s.root));
  check('nothing under the hostile pack directory was opened by the host', seen.length === 0, seen.slice(0, 5));
  check('the hostile hook was not installed', !fs.existsSync(path.join(wsA, '.claude', 'hooks', 'x.sh')), fs.existsSync(path.join(wsA, '.claude', 'hooks')) ? fs.readdirSync(path.join(wsA, '.claude', 'hooks')) : []);
  check('the workspace ledger is byte-identical', fs.readFileSync(path.join(wsA, '.claude', 'cco-assets.json'), 'utf8') === ledger, fs.readFileSync(path.join(wsA, '.claude', 'cco-assets.json'), 'utf8'));

  // The dashboard shows what is in effect, and saves do not report an override.
  const { model } = await openDashboard(h);
  const st = model?.settings;
  check('the dashboard model shows the defaults', st && st.workerPermissionMode === 'acceptEdits' && st.claudePath === 'claude' && st.frontierWorkerDispatch.value === 'block' && st.overageWorkerDispatch.value === 'block' && st.meshMode === false && st.quotaCooldownMinutes === 30 && st.meshMaxLiveWorkers === 8 && st.providerUsagePolling === true, st && [st.workerPermissionMode, st.claudePath, st.frontierWorkerDispatch, st.overageWorkerDispatch, st.meshMode, st.quotaCooldownMinutes, st.meshMaxLiveWorkers, st.providerUsagePolling]);

  const notices = msgs(h, /ignores these settings/);
  check('exactly ONE warning about workspace-level settings', notices.length === 1 && notices[0].level === 'warning', h.log.messages.map((m) => String(m.message).slice(0, 90)));
  const text = String(notices[0]?.message ?? '');
  const whereOf = multiRoot ? 'settings of folder "ws-a"' : 'workspace settings';
  check(`the warning names all ${ALL_KEYS.length} keys with where they were found (${whereOf})`, ALL_KEYS.every((k) => text.includes(`${S}.${k} (${whereOf})`)), text);
  check('the warning names the legacy keys too', text.includes('fableOrchestrator.claudePath (') && text.includes('fableOrchestrator.workerPermissionMode ('), text);
  if (multiRoot) {
    check('the warning names the workspace-file keys as workspace settings', Object.keys(wsFileKeys).every((k) => text.includes(`${S}.${k} (workspace settings)`)), text);
    check('nothing is reported for the folder that sets nothing', !text.includes('ws-b'), text);
  }
  check('the warning offers "Open Workspace Settings"', JSON.stringify(notices[0]?.items) === JSON.stringify(['Open Workspace Settings']), notices[0]?.items);
  check('it does not name a key that is not set there', !/meshHistoryLimitX|\(settings of folder ""\)/.test(text), text);
  check('no setting was written anywhere', h.log.configUpdates.length === 0, h.log.configUpdates);
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

async function f1UserValues() {
  const pre = scratchRoot();
  const pack = path.join(pre, 'my-pack');
  fs.mkdirSync(path.join(pack, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  const user = {
    claudePath: '/opt/tools/claude',
    workerPermissionMode: 'plan',
    frontierWorkerDispatch: 'allow',
    overageWorkerDispatch: 'allow',
    assetPacks: [pack],
    assetAutoSync: false,
    meshMode: true,
    quotaCooldownMinutes: 60,
    workerTimeoutMinutes: 90,
    meshMaxLiveWorkers: 4,
    meshHistoryLimit: 100,
    sessionKeepalive: true,
    providerUsagePolling: false,
    teamMode: true,
    teamMaxMembers: 3,
    teamMaxRunningTurns: 2,
    teamTurnTimeoutMinutes: 30,
    teamTurnsPerMemberPerHour: 10,
    teamTurnsPerDay: 100,
    teamCursorForce: true,
    teamAgySkipPermissions: true,
  };
  const h = boot({ globalSettings: full(user) });
  await activate(h, 900);
  const reg = readRegistryFile(h);
  check('the registry holds the user values', reg.permissionMode === 'plan' && reg.claudePath === '/opt/tools/claude' && reg.cooldownMinutes === 60 && reg.workerTimeoutMinutes === 90 && reg.meshMode === 'on' && reg.meshMaxLiveWorkers === 4 && reg.meshHistoryLimit === 100 && reg.providerUsagePolling === false, reg);
  check('the registry holds the team values', reg.teamMode === 'on' && reg.teamMaxMembers === 3 && reg.teamMaxRunningTurns === 2 && reg.teamTurnTimeoutMinutes === 30 && reg.teamTurnsPerMemberPerHour === 10 && reg.teamTurnsPerDay === 100 && reg.teamCursorForce === 'on' && reg.teamAgySkipPermissions === 'on', teamRegistryOf(reg));
  check('both guards are `allow`, owned by this editor', reg.frontierWorkerDispatch === 'allow' && reg.overageWorkerDispatch === 'allow' && reg.frontierGuardSetBy === 'StubCode' && reg.overageGuardSetBy === 'StubCode', reg);
  const settings = { ...h.req('settings.js'), ...h.req('packSources.js') };
  check('userSetting() returns each user value', JSON.stringify(ALL_KEYS.map((k) => settings.userSetting(k))) === JSON.stringify(ALL_KEYS.map((k) => user[k])), ALL_KEYS.map((k) => settings.userSetting(k)));
  const sources = settings.resolvePackSources(h.context);
  check("the user's asset pack is loaded", sources.length === 2 && sources[1].root === pack && sources[1].pack?.assets.length === 1, sources.map((s) => [s.root, s.pack?.assets.length]));
  const wm = h.req('workerManager.js');
  wm.openReloginTerminal('main', h.req('platform.js').hostConfigDir(), 'claude');
  check('a terminal line starts with the configured path (quoted as a path)', lines(h)[0] === "'/opt/tools/claude' auth login" && lines(h)[0] === h.req('platform.js').terminalCommandLine('posix', '/opt/tools/claude', ['auth', 'login']), lines(h));
  check('no warning about workspace-level settings, and none about the Claude path', msgs(h, /ignores these settings|is not used/).length === 0, h.log.messages.map((m) => m.message));
  check('a setting the user typed into their settings needs no modal', h.log.messages.every((m) => !m.modal), h.log.messages.filter((m) => m.modal));
  const { model } = await openDashboard(h);
  const st = model?.settings;
  check('the dashboard shows the user values', st && st.workerPermissionMode === 'plan' && st.claudePath === '/opt/tools/claude' && st.frontierWorkerDispatch.value === 'allow' && st.meshMode === true && st.quotaCooldownMinutes === 60 && st.sessionKeepalive === true && st.providerUsagePolling === false, st);

  // A value of the wrong kind reads as the default (and an out-of-range one is clamped by its own rule).
  Object.assign(h.store.global, full({ quotaCooldownMinutes: '5', meshMode: 'yes', workerPermissionMode: 7, assetPacks: 'not-a-list', meshMaxLiveWorkers: 1e6, frontierWorkerDispatch: true }));
  h.fireConfig();
  await sleep(300);
  const reg2 = readRegistryFile(h);
  check('wrong-kind user values read as their defaults', settings.userSetting('quotaCooldownMinutes') === 30 && settings.userSetting('meshMode') === false && settings.userSetting('workerPermissionMode') === 'acceptEdits' && JSON.stringify(settings.userSetting('assetPacks')) === '[]' && settings.userSetting('frontierWorkerDispatch') === 'block', ALL_KEYS.map((k) => settings.userSetting(k)));
  check('…and reach the registry as defaults / clamped', reg2.cooldownMinutes === 30 && reg2.meshMode === 'off' && reg2.permissionMode === 'acceptEdits' && reg2.meshMaxLiveWorkers === 64 && reg2.frontierWorkerDispatch === 'block', reg2);
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

async function f1BadClaudePath() {
  const h = boot({ globalSettings: full({ claudePath: 'tools/claude' }), workspaceSettings: {} });
  await activate(h, 700);
  for (let i = 0; i < 4; i++) { h.fireConfig(); await sleep(60); }
  const wm = h.req('workerManager.js');
  wm.openReloginTerminal('main', h.req('platform.js').hostConfigDir(), 'claude');
  const reg = readRegistryFile(h);
  const said = msgs(h, /is not used/);
  check('a relative claudePath is not used: the registry holds the resolved default', path.basename(reg.claudePath) === 'claude' && !reg.claudePath.includes('tools'), reg.claudePath);
  check('…the terminal line is `claude auth login`', lines(h)[0] === 'claude auth login', lines(h));
  check('…and the user is told ONCE, naming the value, across five syncs and a terminal', said.length === 1 && said[0].level === 'warning' && String(said[0].message).includes('"tools/claude"'), said.map((m) => m.message));
  for (const [value, label] of [["claude\u001b[31m", 'a control character'], [42, 'a number'], ['~/bin/claude', 'a ~ path']]) {
    const before = msgs(h, /is not used/).length;
    h.store.global[`${S}.claudePath`] = value;
    h.fireConfig(); await sleep(60); h.fireConfig(); await sleep(60);
    const now = msgs(h, /is not used/);
    check(`${label} is refused and said once`, now.length === before + 1 && path.basename(readRegistryFile(h).claudePath) === 'claude' && !/[\u0000-\u001f]/.test(String(now.at(-1).message)), now.map((m) => m.message));
  }
  const before = msgs(h, /is not used/).length;
  h.store.global[`${S}.claudePath`] = '   ';
  h.fireConfig(); await sleep(60);
  check('a blank value is "not set": the default, and nothing is said', msgs(h, /is not used/).length === before && path.basename(readRegistryFile(h).claudePath) === 'claude', msgs(h, /is not used/).length);
  finish(h);
}

async function f1MigrationUser() {
  const legacyUser = { workerPermissionMode: 'plan', claudePath: '/opt/legacy/claude', quotaCooldownMinutes: 77, frontierWorkerDispatch: 'allow' };
  const h = boot({ globalSettings: { ...full(legacyUser, 'fableOrchestrator'), [`${S}.quotaCooldownMinutes`]: 12 } });
  await activate(h, 900);
  const g = h.store.global;
  check('user-level legacy values are copied to the current section', g[`${S}.workerPermissionMode`] === 'plan' && g[`${S}.claudePath`] === '/opt/legacy/claude' && g[`${S}.frontierWorkerDispatch`] === 'allow', g);
  check('a current user value is not overwritten', g[`${S}.quotaCooldownMinutes`] === 12, g[`${S}.quotaCooldownMinutes`]);
  check('every write went to User settings', h.log.configUpdates.length === 3 && h.log.configUpdates.every((u) => u.target === 1 && !u.rejected), h.log.configUpdates);
  const reg = readRegistryFile(h);
  check('the migrated values reach the registry', reg.permissionMode === 'plan' && reg.claudePath === '/opt/legacy/claude' && reg.frontierWorkerDispatch === 'allow' && reg.cooldownMinutes === 12, reg);
  check('no workspace-level warning for user-level legacy values', msgs(h, /ignores these settings/).length === 0, h.log.messages.map((m) => m.message));
  finish(h);
}

async function f1MigrationWorkspace() {
  const legacyWs = { workerPermissionMode: 'bypassPermissions', claudePath: '/tmp/legacy-evil', quotaCooldownMinutes: 1, frontierWorkerDispatch: 'allow' };
  const h = boot({ workspaceSettings: full(legacyWs, 'fableOrchestrator') });
  await activate(h, 900);
  check('workspace-level legacy values are written NOWHERE (not even attempted)', h.log.configUpdates.length === 0, h.log.configUpdates);
  check('…the user settings are untouched', Object.keys(h.store.global).length === 0, h.store.global);
  const reg = readRegistryFile(h);
  check('…the registry holds the defaults', reg.permissionMode === 'acceptEdits' && path.basename(reg.claudePath) === 'claude' && reg.frontierWorkerDispatch === 'block' && reg.cooldownMinutes === 30, reg);
  const notices = msgs(h, /ignores these settings/);
  check('…and one warning names the four legacy keys', notices.length === 1 && Object.keys(legacyWs).every((k) => String(notices[0].message).includes(`fableOrchestrator.${k} (workspace settings)`)), notices.map((m) => m.message));
  finish(h);
}

async function f1Degenerate() {
  // No folder open, no shell reported, and then an editor whose configuration API fails outright.
  const h = boot({ noWorkspace: true, shell: undefined });
  await activate(h, 700);
  const reg = readRegistryFile(h);
  check('no workspace folder: activation completes with the defaults and no notice', reg.permissionMode === 'acceptEdits' && reg.frontierWorkerDispatch === 'block' && msgs(h, /ignores these settings/).length === 0, [reg, h.log.messages.map((m) => m.message)]);
  const settings = { ...h.req('settings.js'), ...h.req('packSources.js') };
  const wm = h.req('workerManager.js');
  const real = h.vscode.workspace.getConfiguration;
  h.vscode.workspace.getConfiguration = () => { throw new Error('the configuration service is gone'); };
  let threw = '';
  let values;
  try { values = ALL_KEYS.map((k) => settings.userSetting(k)); h.fireConfig(); } catch (e) { threw = String(e && e.message); }
  check('a configuration API that throws: every setting reads as its built-in default, the Claude path is `claude`, nothing is reported and nothing throws', threw === '' && JSON.stringify(values) === JSON.stringify(ALL_DEFAULTS) && settings.userClaudePath() === 'claude' && settings.workspaceLevelSettings().length === 0 && ALL_KEYS.every((k) => settings.explicitUserSetting(k) === undefined), [threw, values]);
  // An editor that reports no defaults at all (inspect() without defaultValue).
  h.vscode.workspace.getConfiguration = (section) => ({ ...real(section), inspect: () => ({}) });
  check('an editor that reports no default values: the built-in defaults are used', JSON.stringify(ALL_KEYS.map((k) => settings.userSetting(k))) === JSON.stringify(ALL_DEFAULTS), ALL_KEYS.map((k) => settings.userSetting(k)));
  h.vscode.workspace.getConfiguration = real;
  wm.openReloginTerminal('main', h.req('platform.js').hostConfigDir(), 'claude');
  check('with no shell reported the POSIX spelling is used', JSON.stringify(lines(h)) === JSON.stringify(['claude auth login']), lines(h));
  // The list a caller receives is its own: changing it does not change the next read.
  settings.userSetting('assetPacks').push('/x');
  check('userSetting returns a fresh list each time', JSON.stringify(settings.userSetting('assetPacks')) === '[]', settings.userSetting('assetPacks'));
  finish(h);
}

/* ---- F2: user-owned files are not rewritten unless understood ---- */

async function f2McpJson() {
  const h = boot({});
  await activate(h, 500);
  const file = path.join(h.ws, '.mcp.json');
  const elsewhere = path.join(h.scratch, 'elsewhere.json');
  const mine = { $schema: 'https://example.com/mcp.schema.json', mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { TOKEN: 'ghp_x' } }, postgres: { command: 'npx', args: ['pg-mcp', 'postgres://localhost/app'] }, 'fable-dispatch': { command: 'node', args: ['/old/server.js'] }, constructor: { command: 'c' } }, inputs: [{ id: 'k', type: 'promptString' }], note: 'keep me' };
  const good = JSON.stringify(mine, null, 2);
  const big = JSON.stringify({ mcpServers: { a: { command: 'x' } }, pad: 'p'.repeat(2 * 1024 * 1024) });
  const REFUSE = 'refuse';
  const cases = [
    ['a BOM in front of valid JSON', () => fs.writeFileSync(file, '\uFEFF' + good), 'accept'],
    ['a trailing comma', () => fs.writeFileSync(file, good.replace(/\n}\s*$/, ',\n}')), REFUSE],
    ['a // comment', () => fs.writeFileSync(file, '// my servers\n' + good), REFUSE],
    ['merge-conflict markers', () => fs.writeFileSync(file, `<<<<<<< HEAD\n${good}\n=======\n${good}\n>>>>>>> feature\n`), REFUSE],
    ['a truncated file', () => fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2))), REFUSE],
    // An empty file holds nothing that could be lost: it is treated as a new file.
    ['an empty file', () => fs.writeFileSync(file, ''), 'accept'],
    ['a file of whitespace only', () => fs.writeFileSync(file, ' \n\t\n'), 'accept'],
    ['[]', () => fs.writeFileSync(file, '[]'), REFUSE],
    ['null', () => fs.writeFileSync(file, 'null'), REFUSE],
    ['"x"', () => fs.writeFileSync(file, '"x"'), REFUSE],
    ['{"mcpServers": []}', () => fs.writeFileSync(file, '{"mcpServers": []}'), REFUSE],
    ['{"mcpServers": null}', () => fs.writeFileSync(file, '{"mcpServers": null}'), REFUSE],
    ['{"mcpServers": "x"}', () => fs.writeFileSync(file, '{"mcpServers": "x"}'), REFUSE],
    ['a symbolic link to a valid file', () => { fs.writeFileSync(elsewhere, good); fs.symlinkSync(elsewhere, file); }, REFUSE],
    ['a dangling symbolic link', () => fs.symlinkSync(path.join(h.scratch, 'nowhere.json'), file), REFUSE],
    ['a directory', () => fs.mkdirSync(file), REFUSE],
    ['a 2 MiB file', () => fs.writeFileSync(file, big), REFUSE],
    ['a valid file with three other servers and unknown top-level keys', () => fs.writeFileSync(file, good), 'accept'],
    ['a valid file with no mcpServers key', () => fs.writeFileSync(file, '{"note": 1}'), 'accept'],
    ['no file at all', () => {}, 'accept'],
  ];
  const snapshot = () => {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return 'absent';
    if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    if (st.isDirectory()) return `dir:${fs.readdirSync(file).join(',')}`;
    return `file:${fs.readFileSync(file).toString('base64')}`;
  };
  for (const [label, arrange, expected] of cases) {
    fs.rmSync(file, { recursive: true, force: true });
    fs.rmSync(elsewhere, { force: true });
    arrange();
    const before = snapshot();
    const elsewhereBefore = fs.existsSync(elsewhere) ? fs.readFileSync(elsewhere, 'utf8') : null;
    h.log.messages.length = 0;
    let threw = '';
    try { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp'); } catch (e) { threw = String(e && e.message); }
    await sleep(20);
    const after = snapshot();
    const registered = msgs(h, /^Registered/);
    const errors = h.log.messages.filter((m) => m.level === 'error');
    if (expected === REFUSE) {
      check(`${label}: the file is unchanged`, after === before && threw === '', threw || 'the file changed');
      check(`${label}: an error names the file and offers "Open File"; "Registered" is not said`, registered.length === 0 && errors.length === 1 && String(errors[0].message).includes(file) && /Nothing was changed/.test(String(errors[0].message)) && JSON.stringify(errors[0].items) === JSON.stringify(['Open File']), h.log.messages.map((m) => [m.level, String(m.message).slice(0, 160), m.items]));
      if (elsewhereBefore !== null) check(`${label}: the link's target is unchanged`, fs.readFileSync(elsewhere, 'utf8') === elsewhereBefore, 'target rewritten');
    } else {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { parsed = undefined; }
      const ours = parsed?.mcpServers?.['cco-dispatch'];
      check(`${label}: our server is written, and "Registered" is said (after the write)`, threw === '' && ours && Array.isArray(ours.args) && typeof ours.command === 'string' && registered.length === 1 && errors.length === 0, [threw, ours, h.log.messages.map((m) => [m.level, String(m.message).slice(0, 80)])]);
      // Everything else byte-for-value, in the same order: remove ours, compare with the input minus the legacy key.
      let original = {};
      if (before.startsWith('file:')) {
        const originalText = Buffer.from(before.slice(5), 'base64').toString('utf8').replace(/^\uFEFF/, '');
        // An empty or whitespace-only file is a new file: there was nothing in it to keep.
        original = originalText.trim() === '' ? {} : JSON.parse(originalText);
      }
      const expectedRest = JSON.parse(JSON.stringify(original));
      if (expectedRest.mcpServers) delete expectedRest.mcpServers['fable-dispatch'];
      const rest = JSON.parse(JSON.stringify(parsed ?? {}));
      if (rest.mcpServers) delete rest.mcpServers['cco-dispatch'];
      if (!expectedRest.mcpServers) expectedRest.mcpServers = {};
      check(`${label}: every other key and server keeps its value and order`, JSON.stringify(rest) === JSON.stringify(expectedRest), [JSON.stringify(rest).slice(0, 300), JSON.stringify(expectedRest).slice(0, 300)]);
      check(`${label}: the pre-rename server key is gone, and no temp file is left`, parsed?.mcpServers?.['fable-dispatch'] === undefined && fs.readdirSync(h.ws).every((f) => !f.endsWith('.tmp')), fs.readdirSync(h.ws));
    }
  }
  // Registering twice changes nothing more.
  const once = fs.readFileSync(file, 'utf8');
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp');
  check('registering again leaves the file byte-identical', fs.readFileSync(file, 'utf8') === once, 'changed');
  // The file's mode survives the rewrite.
  fs.chmodSync(file, 0o600);
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp');
  check('the rewritten file keeps its mode', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  finish(h);
}

async function f2McpOffer() {
  // Wave 11 (contract §15.7 Nags; EXPECTATION-CHANGES §10): on macOS/Linux the activation offer
  // points a folder that cannot dispatch at Update Workspace Setup — never at MCP registration —
  // and the offer itself touches no file. "Register MCP Server", run on a `.mcp.json` it does not
  // understand, still refuses and leaves the file as it was.
  const h = boot({ answerMessage: () => undefined });
  const wm = h.req('workerManager.js');
  new wm.WorkerManager().add('w1', 'opus');
  const file = path.join(h.ws, '.mcp.json');
  const body = '// mine\n{"mcpServers":{"github":{"command":"npx"}}}';
  fs.writeFileSync(file, body);
  await activate(h, 900);
  check('the offer is made for a folder that cannot dispatch — Update Workspace Setup, not MCP registration — and .mcp.json is untouched', msgs(h, /cannot dispatch/).length === 1 && msgs(h, /not registered in this workspace/).length === 0 && fs.readFileSync(file, 'utf8') === body, h.log.messages.map((m) => String(m.message).slice(0, 100)));
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp');
  await sleep(30);
  check('"Register MCP Server" on a file that is not understood leaves it unchanged, says why, and never says "Registered"', fs.readFileSync(file, 'utf8') === body && msgs(h, /^Registered/).length === 0 && msgs(h, /was not registered/).length === 1, h.log.messages.map((m) => [m.level, String(m.message).slice(0, 120)]));
  finish(h);
}

async function f2McpLink() {
  // A `.mcp.json` that is a link: never written through, but still READ to answer "is it registered?".
  const h = boot({ answerMessage: () => undefined });
  const wm = h.req('workerManager.js');
  new wm.WorkerManager().add('w1', 'opus');
  const real = path.join(h.ws, 'config', 'mcp.json');
  fs.mkdirSync(path.dirname(real));
  const body = JSON.stringify({ mcpServers: { 'cco-dispatch': { command: 'node', args: ['/x/server.js'] }, mine: { command: 'm' } } }, null, 2) + '\n';
  fs.writeFileSync(real, body);
  fs.symlinkSync(path.join('config', 'mcp.json'), path.join(h.ws, '.mcp.json'));
  await activate(h, 900);
  check('a linked .mcp.json that registers the server: no registration offer at activation', msgs(h, /not registered in this workspace/).length === 0, h.log.messages.map((m) => String(m.message).slice(0, 90)));
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installTeamAgent');
  await sleep(30);
  check('…and the team agent installer does not claim the server is missing', msgs(h, /Team proxy agent written/).length === 1 && msgs(h, /not registered in this workspace yet/).length === 0, h.log.messages.map((m) => String(m.message).slice(0, 120)));
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installMcp');
  await sleep(30);
  check('…while "Register MCP Server" still refuses to write through the link, and the target is byte-identical', fs.readFileSync(real, 'utf8') === body && fs.lstatSync(path.join(h.ws, '.mcp.json')).isSymbolicLink() && msgs(h, /is a symbolic link/).length === 1 && msgs(h, /^Registered/).length === 0, h.log.messages.map((m) => String(m.message).slice(0, 120)));
  finish(h);
}

async function f2PolicyFile() {
  const h = boot({});
  await activate(h, 500);
  const file = path.join(h.ws, 'CLAUDE.md');
  const body = '# My project\n\nRules I wrote by hand.\n';
  const run = async () => { h.log.messages.length = 0; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.addDispatchPolicy'); await sleep(20); };
  // Unreadable but writable: the read fails, and the file must not be replaced by the policy alone.
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o200);
  await run();
  fs.chmodSync(file, 0o600);
  check('a CLAUDE.md that cannot be READ is not rewritten', fs.readFileSync(file, 'utf8') === body && msgs(h, /was not written/).length === 1 && msgs(h, /^Dispatch policy written/).length === 0, [fs.readFileSync(file, 'utf8').slice(0, 80), h.log.messages.map((m) => m.message)]);
  await run();
  const written = fs.readFileSync(file, 'utf8');
  check('a readable one keeps its text and gains the policy block', written.startsWith(body.trimEnd()) && written.length > body.length + 200 && msgs(h, /^Dispatch policy written/).length === 1, written.slice(0, 120));
  // A link out of the workspace is not written through; one inside it is.
  const outside = path.join(h.scratch, 'outside.md');
  fs.writeFileSync(outside, 'not yours\n');
  fs.rmSync(file);
  fs.symlinkSync(outside, file);
  await run();
  check('a CLAUDE.md that links OUT of the workspace is not written through', fs.readFileSync(outside, 'utf8') === 'not yours\n' && msgs(h, /leads outside this workspace folder/).length === 1, [fs.readFileSync(outside, 'utf8').slice(0, 60), h.log.messages.map((m) => m.message)]);
  fs.rmSync(file);
  fs.symlinkSync(path.join(h.scratch, 'missing.md'), file);
  await run();
  check('a dangling link creates nothing outside', !fs.existsSync(path.join(h.scratch, 'missing.md')) && msgs(h, /was not written/).length === 1, h.log.messages.map((m) => m.message));
  fs.rmSync(file);
  const inside = path.join(h.ws, 'AGENTS.md');
  fs.writeFileSync(inside, '# agents\n');
  fs.symlinkSync('AGENTS.md', file);
  await run();
  check('a link to a file INSIDE the workspace is written through, and stays a link', fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(inside, 'utf8').startsWith('# agents') && fs.readFileSync(inside, 'utf8').length > 200, fs.readFileSync(inside, 'utf8').slice(0, 80));
  fs.rmSync(file);
  fs.mkdirSync(file);
  await run();
  check('a directory at CLAUDE.md is reported, not thrown', msgs(h, /was not written/).length === 1 && fs.statSync(file).isDirectory(), h.log.messages.map((m) => m.message));
  finish(h);
}

async function f2AssetLedger() {
  const pre = scratchRoot();
  const pack = path.join(pre, 'pack');
  fs.mkdirSync(path.join(pack, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'mine' }));
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  const h = boot({ globalSettings: full({ assetPacks: [pack] }) });
  const ledgerFile = path.join(h.ws, '.claude', 'cco-assets.json');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const good = JSON.stringify({ version: 1, assets: { 'mine:commands/hello': { enabled: true, files: {} } }, teamNote: 'shared' }, null, 2) + '\n';
  const conflicted = `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> theirs\n`;
  fs.writeFileSync(ledgerFile, conflicted);
  await activate(h, 700);
  const dirNow = () => fs.readdirSync(path.dirname(ledgerFile)).sort();
  check('activation with a conflicted ledger: the file is byte-identical and nothing is moved aside', fs.readFileSync(ledgerFile, 'utf8') === conflicted && JSON.stringify(dirNow()) === JSON.stringify(['cco-assets.json']), dirNow());
  check('…and the user is told once, with the file named and "Open File"', msgs(h, /assets were not changed/).length === 1 && String(msgs(h, /assets were not changed/)[0].message).includes(ledgerFile) && JSON.stringify(msgs(h, /assets were not changed/)[0].items) === JSON.stringify(['Open File']), h.log.messages.map((m) => [String(m.message).slice(0, 200), m.items]));
  for (const command of ['syncAssets', 'manageAssets', 'resetAsset']) {
    h.log.messages.length = 0;
    let threw = '';
    try { await h.vscode.commands.executeCommand(`claudeCodeOrchestrator.${command}`); } catch (e) { threw = String(e && e.message); }
    await sleep(20);
    check(`${command}: refuses with the same message, changes nothing, does not reject`, threw === '' && fs.readFileSync(ledgerFile, 'utf8') === conflicted && JSON.stringify(dirNow()) === JSON.stringify(['cco-assets.json']) && msgs(h, /assets were not changed/).length === 1, [threw, dirNow(), h.log.messages.map((m) => String(m.message).slice(0, 120))]);
  }
  // The Asset Manager shows it and keeps running; a toggle from its page changes nothing.
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openAssetManager');
  await sleep(100);
  const panel = h.log.panels.find((p) => p.viewType === 'ccoAssetManager');
  const data = panel.posted.filter((p) => p.type === 'data').pop();
  check('the Asset Manager still renders, and says why nothing is shown as installed', data && Array.isArray(data.assets) && /Could not read/.test(String(data.lastReport)) && msgs(h, /assets were not changed/).length === 1, [data && data.lastReport, h.log.messages.map((m) => String(m.message).slice(0, 80))]);
  panel._recv.fire({ type: 'toggle', key: 'mine:commands/hello', enabled: false });
  await sleep(100);
  check('a toggle from its page leaves the ledger byte-identical', fs.readFileSync(ledgerFile, 'utf8') === conflicted, 'changed');
  for (const hostile of [null, 7, 'toggle', [], { type: 5 }, { type: 'toString' }, { type: '__proto__' }]) panel._recv.fire(hostile);
  await sleep(50);
  // Other shapes that are not a ledger this version writes.
  for (const [label, body] of [['[]', '[]'], ['null', 'null'], ['{"assets": []}', '{"assets": []}'], ['a record without files', '{"version":1,"assets":{"k":{"enabled":true}}}'], ['version 2', '{"version":2,"assets":{}}'], ['a truncated file', good.slice(0, 40)]]) {
    fs.writeFileSync(ledgerFile, body);
    h.log.messages.length = 0;
    await h.vscode.commands.executeCommand('claudeCodeOrchestrator.syncAssets');
    await sleep(20);
    check(`ledger ${label}: refused, byte-identical`, fs.readFileSync(ledgerFile, 'utf8') === body && msgs(h, /assets were not changed/).length === 1, [fs.readFileSync(ledgerFile, 'utf8').slice(0, 60), h.log.messages.map((m) => String(m.message).slice(0, 100))]);
  }
  // Understood (with a BOM and a key this version does not know): synced, and the unknown key survives.
  fs.writeFileSync(ledgerFile, '\uFEFF' + good);
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.syncAssets');
  await sleep(20);
  const after = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  check('a ledger with a BOM is understood: the asset is installed and the unknown top-level key is kept', fs.existsSync(path.join(h.ws, '.claude', 'commands', 'hello.md')) && after.teamNote === 'shared' && typeof after.assets['mine:commands/hello'].files['commands/hello.md'] === 'string', after);
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

/* ---- F5: the re-login e-mail ---- */

async function f5Email() {
  const h = boot({});
  const wm = h.req('workerManager.js');
  const platform = h.req('platform.js');
  const mainDir = platform.hostConfigDir();
  fs.mkdirSync(mainDir, { recursive: true });
  const homeLevel = path.join(h.home, '.claude.json');
  const dirLevel = path.join(mainDir, '.claude.json');
  const line = (label, dir) => { h.log.terminals.length = 0; wm.openReloginTerminal(label, dir, 'claude'); return lines(h); };
  const withEmail = (address) => platform.terminalCommandLine('posix', 'claude', ['auth', 'login', '--email', address]);
  check('accountConfigFile(main) is the home-level file', platform.accountConfigFile(mainDir).file === homeLevel && platform.accountConfigFile(mainDir).homeLevel === true, platform.accountConfigFile(mainDir));
  fs.writeFileSync(dirLevel, JSON.stringify({ oauthAccount: { emailAddress: 'stale-other@example.com' } }));
  check('only <configDir>/.claude.json exists: no address is offered for the default account', JSON.stringify(line('main', mainDir)) === JSON.stringify(['claude auth login']), lines(h));
  fs.writeFileSync(homeLevel, JSON.stringify({ oauthAccount: { emailAddress: 'real-main@example.com' } }));
  check('both exist: the address comes from the home-level file', JSON.stringify(line('main', mainDir)) === JSON.stringify([withEmail('real-main@example.com')]) && lines(h)[0] === "claude auth login --email 'real-main@example.com'", lines(h));
  check('the login terminal leaves CLAUDE_CONFIG_DIR unset for the default account', h.log.terminals[0].env.CLAUDE_CONFIG_DIR === null, h.log.terminals[0].env.CLAUDE_CONFIG_DIR);
  const w1 = path.join(h.home, '.claude-w1');
  fs.mkdirSync(w1);
  fs.writeFileSync(path.join(w1, '.claude.json'), '\uFEFF' + JSON.stringify({ oauthAccount: { emailAddress: 'w1+tag@example.co.uk' } }));
  check('a worker directory reads its own <dir>/.claude.json (BOM tolerated)', JSON.stringify(line('w1', w1)) === JSON.stringify([withEmail('w1+tag@example.co.uk')]) && lines(h)[0] === "claude auth login --email 'w1+tag@example.co.uk'" && h.log.terminals[0].env.CLAUDE_CONFIG_DIR === w1, [lines(h), h.log.terminals[0].env.CLAUDE_CONFIG_DIR]);
  const hostile = ['a@b.c; rm -rf ~', '$(id)@x.yz', 'a@b.cd\nrm -rf ~', `${'a'.repeat(300)}@example.com`, 'a@b@c.de', '-x@example.com', 'a b@example.com', '`id`@example.com', "a'b@example.com", 'a@-example.com', 'a%PATH%@example.com', '', 42, null, { a: 1 }];
  for (const value of hostile) {
    fs.writeFileSync(homeLevel, JSON.stringify({ oauthAccount: { emailAddress: value } }));
    const typed = line('main', mainDir);
    check(`hostile address ${JSON.stringify(value).slice(0, 34)} is never typed`, JSON.stringify(typed) === JSON.stringify(['claude auth login']), typed);
  }
  for (const [label, body] of [['not JSON', '{oops'], ['an array', '[]'], ['null', 'null'], ['oauthAccount is a string', '{"oauthAccount":"x@y.zz"}']]) {
    fs.writeFileSync(homeLevel, body);
    check(`account file that is ${label}: no address, no throw`, JSON.stringify(line('main', mainDir)) === JSON.stringify(['claude auth login']), lines(h));
  }
  // Through the command the dashboard and the tree use.
  fs.writeFileSync(homeLevel, JSON.stringify({ oauthAccount: { emailAddress: 'real-main@example.com' } }));
  await activate(h, 500);
  h.log.terminals.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.reloginWorker', { configDir: mainDir });
  check('the Re-login command types the same line', JSON.stringify(lines(h)) === JSON.stringify([withEmail('real-main@example.com')]), lines(h));
  finish(h);
}

/* ---- F6: the Codex keychain option ---- */

async function f6Keychain() {
  let name = 'cx0';
  let sideEffect = null;
  const h = boot({
    globalSettings: full({ providerUsagePolling: false }),
    answerQuickPick: (items, options) => {
      const ph = String(options?.placeHolder ?? '');
      if (/Which agent CLI/.test(ph)) return items.find((i) => i.label === 'Codex');
      if (/login does|needs a login of its own/.test(ph)) return items.find((i) => i.login === 'separate');
      if (/Where should Codex keep/.test(ph)) return items.find((i) => i.store === 'keychain');
      if (/Default model/.test(ph)) { if (sideEffect) sideEffect(); return items.find((i) => i.choice === 'cli'); }
      return undefined;
    },
    answerInputBox: () => name,
    answerMessage: (rec) => (rec.items ?? []).find((i) => i === 'Use Existing Directory' || i === 'Later'),
  });
  await activate(h, 500);
  const wm = h.req('workerManager.js');
  const LINE = wm.CODEX_KEYRING_CONFIG_LINE;
  const tree = (dir) => {
    if (!fs.existsSync(dir)) return 'absent';
    return fs.readdirSync(dir).sort().map((f) => `${f}=${JSON.stringify(fs.readFileSync(path.join(dir, f), 'utf8'))}`).join(';');
  };
  const run = async (workerName) => {
    name = workerName;
    h.log.messages.length = 0;
    h.log.quickPicks.length = 0;
    await h.vscode.commands.executeCommand('claudeCodeOrchestrator.addWorker');
    await sleep(120);
    const offered = h.log.quickPicks.some((q) => /Where should Codex keep/.test(String(q.options?.placeHolder ?? '')));
    const claims = h.log.messages.filter((m) => /keychain/i.test(String(m.message)));
    const added = new wm.WorkerManager().get(workerName) !== undefined;
    return { offered, claims: claims.map((m) => String(m.message)), added };
  };
  const homeOf = (n) => path.join(h.home, `.codex-${n}`);
  const other = homeOf('other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'auth.json'), '{"tokens":"OTHER"}');

  let r = await run('absent1');
  check('folder absent: the option is offered, config.toml is created (0600) with the one line, and the claim is made', r.offered && r.added && tree(homeOf('absent1')) === `config.toml=${JSON.stringify(LINE + '\n')}` && (fs.statSync(path.join(homeOf('absent1'), 'config.toml')).mode & 0o777) === 0o600 && r.claims.length === 1 && /will be kept in the system keychain/.test(r.claims[0]), [r, tree(homeOf('absent1'))]);

  fs.mkdirSync(homeOf('empty1'));
  r = await run('empty1');
  check('empty real directory: offered, written', r.offered && r.added && tree(homeOf('empty1')) === `config.toml=${JSON.stringify(LINE + '\n')}` && r.claims.length === 1, [r, tree(homeOf('empty1'))]);

  fs.mkdirSync(homeOf('auth1'));
  fs.writeFileSync(path.join(homeOf('auth1'), 'auth.json'), '{"tokens":"PLAINTEXT"}');
  let beforeTree = tree(homeOf('auth1'));
  r = await run('auth1');
  check('directory with auth.json: NOT offered, nothing written, nothing claims a keychain', !r.offered && r.added && tree(homeOf('auth1')) === beforeTree && r.claims.length === 0, [r, tree(homeOf('auth1'))]);

  fs.mkdirSync(homeOf('other1'));
  fs.writeFileSync(path.join(homeOf('other1'), 'notes.txt'), 'x');
  beforeTree = tree(homeOf('other1'));
  r = await run('other1');
  check('directory with an unrelated file: NOT offered, unchanged, no claim', !r.offered && r.added && tree(homeOf('other1')) === beforeTree && r.claims.length === 0, [r, tree(homeOf('other1'))]);

  const emptyTarget = path.join(h.scratch, 'empty-target');
  fs.mkdirSync(emptyTarget);
  fs.symlinkSync(emptyTarget, homeOf('link1'));
  r = await run('link1');
  check('symlink to an empty directory: NOT offered, the target stays empty, no claim', !r.offered && tree(emptyTarget) === '' && r.claims.length === 0 && fs.lstatSync(homeOf('link1')).isSymbolicLink(), [r, tree(emptyTarget)]);

  fs.symlinkSync(other, homeOf('alias1'));
  const otherBefore = tree(other);
  r = await run('alias1');
  check("symlink to another worker's home: NOT offered, that home is unchanged, no claim", !r.offered && tree(other) === otherBefore && r.claims.length === 0, [r, tree(other)]);

  fs.mkdirSync(homeOf('cfg1'));
  fs.writeFileSync(path.join(homeOf('cfg1'), 'config.toml'), 'model = "mine"\n');
  r = await run('cfg1');
  check('existing config.toml: NOT offered, the file is byte-identical, no claim', !r.offered && tree(homeOf('cfg1')) === `config.toml=${JSON.stringify('model = "mine"\n')}` && r.claims.length === 0, [r, tree(homeOf('cfg1'))]);

  // The folder stops being empty between the question and the write.
  sideEffect = () => { fs.mkdirSync(homeOf('race1'), { recursive: true }); fs.writeFileSync(path.join(homeOf('race1'), 'auth.json'), '{"tokens":"LATE"}'); };
  r = await run('race1');
  sideEffect = null;
  check('a sign-in file that appears after the question: the line is NOT written, and a modal says the setting was not applied', r.offered && tree(homeOf('race1')) === `auth.json=${JSON.stringify('{"tokens":"LATE"}')}` && r.claims.length === 1 && /was NOT applied/.test(r.claims[0]) && h.log.messages.some((m) => m.modal && /was NOT applied/.test(String(m.message))), [r, tree(homeOf('race1'))]);

  // The writer on its own.
  const ambient = path.join(h.home, '.codex');
  fs.mkdirSync(ambient);
  const direct = [
    ['a non-empty home', homeOf('auth1'), 'not-fresh'],
    ['a home that is a symlink to an empty directory', homeOf('link1'), 'not-fresh'],
    ["a symlink to another worker's home", homeOf('alias1'), 'not-fresh'],
    ['a home with a config.toml', homeOf('cfg1'), 'exists'],
    ["the machine's own ~/.codex", ambient, 'ambient'],
    ['a home that does not exist', homeOf('missing'), 'failed'],
  ];
  for (const [label, dir, expected] of direct) {
    const beforeDir = tree(fs.existsSync(dir) ? fs.realpathSync(dir) : dir);
    const out = wm.writeCodexKeyringConfig(dir);
    check(`writeCodexKeyringConfig(${label}) → ${expected}, nothing written`, out.outcome === expected && tree(fs.existsSync(dir) ? fs.realpathSync(dir) : dir) === beforeDir, [out, beforeDir]);
  }
  check('isFreshAccountHome: absent and empty real directory only', wm.isFreshAccountHome(homeOf('nope')) && !wm.isFreshAccountHome(homeOf('auth1')) && !wm.isFreshAccountHome(homeOf('link1')) && !wm.isFreshAccountHome(path.join(homeOf('auth1'), 'auth.json')), [wm.isFreshAccountHome(homeOf('nope')), wm.isFreshAccountHome(homeOf('link1'))]);
  finish(h);
}

/* ---- F7: privilege-widening values ask first ---- */

const ANSWERS = {
  confirm: (rec) => (rec.modal ? rec.items[0] : undefined),
  cancel: () => undefined,
  // Something that is not the confirm button: only the confirm button may store.
  dismiss: (rec) => (rec.modal ? 'Cancel' : undefined),
};

async function f7Settings() {
  const h = boot({});
  await activate(h, 500);
  const { panel, send } = await openDashboard(h);
  const results = () => panel.posted.filter((p) => p.type === 'settingResult');
  const cases = [
    ['workerPermissionMode', 'bypassPermissions', 'acceptEdits', (r) => r.permissionMode],
    ['frontierWorkerDispatch', 'allow', 'block', (r) => r.frontierWorkerDispatch],
    ['overageWorkerDispatch', 'allow', 'block', (r) => r.overageWorkerDispatch],
    ['claudePath', '/opt/other/claude', 'claude', (r) => r.claudePath],
  ];
  for (const [key, value, def, inRegistry] of cases) {
    for (const answer of ['cancel', 'dismiss', 'confirm']) {
      delete h.store.global[`${S}.${key}`];
      h.fireConfig();
      await sleep(1100); // past the limiter's one-per-second for the modal lane
      h.answers.message = ANSWERS[answer];
      h.log.messages.length = 0;
      const n = results().length;
      await send({ type: 'setSetting', key, value }, 150);
      const modal = h.log.messages.filter((m) => m.modal);
      const res = results().slice(n);
      const stored = h.store.global[`${S}.${key}`];
      const reg = inRegistry(readRegistryFile(h));
      const label = `setSetting ${key}=${value} / ${answer}`;
      check(`${label}: ONE modal, with a detail and a specific confirm button`, modal.length === 1 && modal[0].level === 'warning' && typeof modal[0].detail === 'string' && modal[0].detail.length > 60 && modal[0].items.length === 1 && !/^(ok|yes|confirm|continue)$/i.test(modal[0].items[0]), modal.map((m) => [m.message, m.items]));
      if (answer === 'confirm') {
        check(`${label}: stored for the user, in the registry, and the page is told ok`, stored === value && reg === value && res.length === 1 && res[0].ok === true && res[0].value === value && res[0].error === null, [stored, reg, res]);
      } else {
        check(`${label}: nothing stored, registry unchanged, and the page is told ok:false with the value still in effect`, stored === undefined && (key === 'claudePath' ? path.basename(reg) === 'claude' : reg === def) && res.length === 1 && res[0].ok === false && res[0].value === def && typeof res[0].error === 'string' && res[0].error.length > 0, [stored, reg, res]);
      }
    }
    // Already the user's value: nothing widens, nothing is asked.
    h.answers.message = ANSWERS.cancel;
    h.log.messages.length = 0;
    const n = results().length;
    await send({ type: 'setSetting', key, value }, 150);
    check(`setSetting ${key}=${value} when it already is the user's value: no modal, ok`, h.log.messages.filter((m) => m.modal).length === 0 && results().slice(n)[0]?.ok === true, [h.log.messages, results().slice(n)]);
    // Narrowing back never asks.
    h.log.messages.length = 0;
    const n2 = results().length;
    await send({ type: 'setSetting', key, value: def }, 150);
    check(`setSetting ${key}=${def} (narrowing): no modal, stored`, h.log.messages.filter((m) => m.modal).length === 0 && h.store.global[`${S}.${key}`] === def && results().slice(n2)[0]?.ok === true, [h.log.messages, results().slice(n2)]);
  }
  // A Claude path this extension would not use is not stored at all.
  for (const bad of ['tools/claude', '~/bin/claude', './claude']) {
    delete h.store.global[`${S}.claudePath`];
    h.log.messages.length = 0;
    const n = results().length;
    await send({ type: 'setSetting', key: 'claudePath', value: bad }, 120);
    check(`setSetting claudePath=${bad}: refused before any modal, nothing stored`, h.store.global[`${S}.claudePath`] === undefined && h.log.messages.filter((m) => m.modal).length === 0 && results().slice(n)[0]?.ok === false, [h.store.global[`${S}.claudePath`], results().slice(n)]);
  }
  // 200 widening messages at once: one modal, every message answered, nothing stored.
  delete h.store.global[`${S}.frontierWorkerDispatch`];
  h.fireConfig();
  await sleep(1100);
  h.answers.message = ANSWERS.cancel;
  h.log.messages.length = 0;
  const n = results().length;
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: 'setSetting', key: 'frontierWorkerDispatch', value: 'allow' });
  await sleep(400);
  check('200 widening messages in one tick: ONE modal, 200 answers (all ok:false), nothing stored', h.log.messages.filter((m) => m.modal).length === 1 && results().slice(n).length === 200 && results().slice(n).every((r) => r.ok === false && r.value === 'block') && h.store.global[`${S}.frontierWorkerDispatch`] === undefined, [h.log.messages.filter((m) => m.modal).length, results().slice(n).length]);
  finish(h);
}

async function f7AccountModes() {
  const h = boot({ globalSettings: full({ providerUsagePolling: false }) });
  const wm = h.req('workerManager.js');
  const manager = new wm.WorkerManager();
  const cx = path.join(h.home, '.codex-cx');
  manager.add('w1', 'opus');
  manager.add('cx', undefined, cx, 'codex');
  manager.add('cur', undefined, undefined, 'cursor');
  await activate(h, 700);
  const { panel, model, send } = await openDashboard(h);
  const key = Object.fromEntries((model?.accounts ?? []).map((a) => [a.name, a.key]));
  check('the model lists the three workers', typeof key.cx === 'string' && typeof key.cur === 'string' && typeof key.w1 === 'string', model?.accounts?.map((a) => a.name));
  const modeOf = (name) => manager.get(name)?.permissionMode;
  const entries = [
    ['dashboard message', 'cx', 'danger-full-access', async () => send({ type: 'account', action: 'setPermissionMode', account: key.cx, value: 'danger-full-access' }, 200)],
    ['dashboard message', 'cur', 'disabled', async () => send({ type: 'account', action: 'setPermissionMode', account: key.cur, value: 'disabled' }, 200)],
    ['accountAction command', 'cx', 'danger-full-access', async () => { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.accountAction', { action: 'setPermissionMode', account: key.cx, value: 'danger-full-access' }); }],
    ['Set Permission Mode quick pick', 'cx', 'danger-full-access', async () => { h.answers.quickPick = (items) => items.find((i) => i.mode === 'danger-full-access'); await h.vscode.commands.executeCommand('claudeCodeOrchestrator.setWorkerPermissionMode', { name: 'cx' }); }],
  ];
  for (const [entry, worker, mode, act] of entries) {
    for (const answer of ['cancel', 'dismiss', 'confirm']) {
      manager.setPermissionMode(worker, null);
      await sleep(1100);
      h.answers.message = ANSWERS[answer];
      h.log.messages.length = 0;
      await act();
      await sleep(80);
      const modal = h.log.messages.filter((m) => m.modal);
      const label = `${entry}: ${worker} → ${mode} / ${answer}`;
      check(`${label}: one modal with a specific confirm button`, modal.length === 1 && modal[0].items.length === 1 && modal[0].items[0] === 'Run Without Sandbox' && typeof modal[0].detail === 'string', modal.map((m) => [m.message, m.items]));
      check(`${label}: ${answer === 'confirm' ? 'stored' : 'NOT stored'}`, answer === 'confirm' ? modeOf(worker) === mode : modeOf(worker) === undefined, modeOf(worker));
    }
  }
  manager.setPermissionMode('cx', null);
  let threw = '';
  try { manager.setPermissionMode('cx', 'danger-full-access'); } catch (e) { threw = String(e.message); }
  check('WorkerManager.setPermissionMode refuses a sandbox-off mode that was not confirmed', /was not confirmed/.test(threw) && modeOf('cx') === undefined, [threw, modeOf('cx')]);
  // A mode that keeps the sandbox is stored without a question.
  h.log.messages.length = 0;
  await sleep(1100);
  await send({ type: 'account', action: 'setPermissionMode', account: key.cx, value: 'read-only' }, 200);
  check('a mode that keeps the sandbox: no modal, stored', h.log.messages.filter((m) => m.modal).length === 0 && modeOf('cx') === 'read-only', [h.log.messages.map((m) => m.message), modeOf('cx')]);
  // A Claude Code worker has no mode of its own: explained, nothing stored, and the command does not wait on the notice.
  h.log.messages.length = 0;
  let settled = false;
  h.answers.message = () => new Promise(() => {}); // a notification nobody closes
  void h.vscode.commands.executeCommand('claudeCodeOrchestrator.setWorkerPermissionMode', { name: 'w1' }).then(() => { settled = true; });
  await sleep(150);
  check('Set Permission Mode on a Claude Code worker: explained, and the command settles while the notice is still up', settled && msgs(h, /have no permission mode of their own/).length === 1 && modeOf('w1') === undefined, [settled, h.log.messages.map((m) => m.message)]);
  h.answers.message = ANSWERS.cancel;
  finish(h);
}

/* ---- F10 / O-2: every line typed into a terminal ---- */

/** A directory of programs that print their argv, NUL-separated, under each agent CLI's name. */
function echoBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['claude', 'codex', 'cursor-agent', 'agy']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\0' "${name}"\nfor a in "$@"; do printf '%s\\0' "$a"; done\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}
/** Run a typed line in a real shell with only the echo programs on PATH; return the argv that arrived. */
function roundTrip(shell, line, binDir, cwd) {
  const res = spawnSync(shell, ['-c', line], { env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: cwd }, cwd, timeout: 10_000 });
  const text = res.stdout ? res.stdout.toString('utf8') : '';
  return text.split('\0').slice(0, -1);
}
const POSIX_SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((s) => fs.existsSync(s));
const flatten = (p) => p.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ').trim();

async function f10Posix() {
  const pre = scratchRoot();
  const marker = path.join(pre, 'PWNED');
  const bin = echoBin(path.join(pre, 'bin'));
  // A user-level claudePath that is an absolute path full of things a shell reads.
  const oddDir = path.join(pre, `my tools; touch ${path.basename(marker)} #`, `it's "odd" $(touch ${path.basename(marker)}) \`id\``);
  echoBin(oddDir);
  const oddClaude = path.join(oddDir, 'claude');
  const h = boot({ globalSettings: full({ providerUsagePolling: false }), shell: '/bin/zsh' });
  const wm = h.req('workerManager.js');
  const platform = h.req('platform.js');
  const manager = new wm.WorkerManager();
  const w1 = path.join(h.home, '.claude-w1');
  manager.add('w1', 'opus');
  manager.add('cx', undefined, path.join(h.home, '.codex-cx'), 'codex');
  manager.add('cur', undefined, undefined, 'cursor');
  fs.writeFileSync(path.join(w1, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w1+x@example.com' } }));
  let promptAnswer;
  h.answers.inputBox = () => promptAnswer;
  await activate(h, 700);
  const builder = (command, args) => platform.terminalCommandLine(platform.terminalShell(h.vscode.env.shell), command, args);

  const prompts = [
    'fix the bug',
    'say "hi" & echo $HOME; rm -rf ~ | cat `id` $(id) \'single\' !! !history \\ back\\slash * ? [a] {b} ~ # > <',
    `line one\nline two\r\n\tindented\ttabbed\u2028separator`,
    `'; touch ${marker}; '`,
    `"; touch ${marker}; "`,
    `$(touch ${marker})`,
    `\`touch ${marker}\``,
    '--dangerously-skip-permissions',
    'unicode ✓ 한글 مرحبا 😀',
    `${'long '.repeat(2000)}end`,
  ];
  const scenarios = [];
  for (const claudePath of ['claude', oddClaude]) {
    if (claudePath === 'claude') delete h.store.global[`${S}.claudePath`];
    else h.store.global[`${S}.claudePath`] = claudePath;
    for (const prompt of prompts) {
      scenarios.push({ label: `open session on w1 with prompt ${JSON.stringify(prompt).slice(0, 44)} [claudePath ${claudePath === 'claude' ? 'default' : 'odd absolute'}]`, claudePath, act: async () => { promptAnswer = prompt; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openWorkerSession', { name: 'w1' }); }, argv: [claudePath, flatten(prompt)], name: 'claude: w1' });
    }
    scenarios.push({ label: `open session on w1, empty prompt [${claudePath === 'claude' ? 'default' : 'odd absolute'}]`, claudePath, act: async () => { promptAnswer = '   '; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openWorkerSession', { name: 'w1' }); }, argv: [claudePath], name: 'claude: w1' });
    scenarios.push({ label: `login w1 (Claude Code opens itself) [${claudePath === 'claude' ? 'default' : 'odd absolute'}]`, claudePath, act: async () => { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.loginWorker', { name: 'w1' }); }, argv: [claudePath], name: 'claude: w1' });
    scenarios.push({ label: `re-login w1 with its address [${claudePath === 'claude' ? 'default' : 'odd absolute'}]`, claudePath, act: async () => { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.reloginWorker', { configDir: w1 }); }, argv: [claudePath, 'auth', 'login', '--email', 'w1+x@example.com'], name: 'login: w1' });
  }
  scenarios.push({ label: 'open session on a Codex worker (no prompt is passed to another CLI)', claudePath: oddClaude, act: async () => { promptAnswer = 'ignored'; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openWorkerSession', { name: 'cx' }); }, argv: ['codex'], name: 'codex: cx' });
  scenarios.push({ label: 'login a Codex worker', claudePath: oddClaude, act: async () => { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.loginWorker', { name: 'cx' }); }, argv: ['codex', 'login'], name: 'login: cx' });
  scenarios.push({ label: 'login a Cursor worker', claudePath: oddClaude, act: async () => { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.loginWorker', { name: 'cur' }); }, argv: ['cursor-agent', 'login'], name: 'login: cur' });

  let typedCount = 0;
  for (const sc of scenarios) {
    if (sc.claudePath === 'claude') delete h.store.global[`${S}.claudePath`];
    else h.store.global[`${S}.claudePath`] = sc.claudePath;
    h.log.terminals.length = 0;
    await sc.act();
    const terminals = h.log.terminals;
    const expected = builder(sc.argv[0], sc.argv.slice(1));
    const line = terminals[0]?.sent[0];
    check(`${sc.label}: one terminal ("${sc.name}"), one line, exactly what terminalCommandLine spells`, terminals.length === 1 && terminals[0].sent.length === 1 && line === expected && terminals[0].name === sc.name, [terminals.length, line, expected, terminals[0]?.name]);
    if (typeof line !== 'string') continue;
    typedCount++;
    for (const shell of POSIX_SHELLS) {
      const arrived = roundTrip(shell, line, bin, pre);
      // The echo program prints its own name first; a path is compared by its last component.
      const want = [path.basename(sc.argv[0]), ...sc.argv.slice(1)];
      check(`${sc.label}: argv arrives intact through ${shell}`, JSON.stringify(arrived) === JSON.stringify(want), [arrived.map((a) => a.slice(0, 80)), want.map((a) => a.slice(0, 80))]);
    }
  }
  const strays = [pre, oddDir, path.dirname(oddDir), h.ws].flatMap((d) => fs.readdirSync(d).filter((f) => f === path.basename(marker)).map((f) => path.join(d, f)));
  check('no typed line created the marker file in any shell', !fs.existsSync(marker) && strays.length === 0, strays);
  check(`${typedCount} lines were typed and round-tripped in ${POSIX_SHELLS.join(', ')}`, typedCount === scenarios.length, typedCount);

  // A part with no safe spelling: nothing is typed, no terminal opens, and the user is told which part.
  delete h.store.global[`${S}.claudePath`];
  h.log.terminals.length = 0;
  h.log.messages.length = 0;
  promptAnswer = 'bell \u0007 and escape \u001b[31m';
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openWorkerSession', { name: 'w1' });
  check('a prompt with a control character: NO terminal, and an error names the argument', h.log.terminals.length === 0 && msgs(h, /Nothing was typed into the terminal: the argument/).length === 1 && !/[\u0000-\u001f]/.test(String(msgs(h, /Nothing was typed/)[0].message)), [h.log.terminals.length, h.log.messages.map((m) => m.message)]);

  // A tab title built from a name somebody else wrote is one display-safe line.
  h.log.terminals.length = 0;
  manager.openTerminal({ name: 'evil\u001b]0;pwn\u0007\nsecond line\u202Ertl', configDir: w1 });
  wm.openCommandTerminal({ name: 'x'.repeat(500), env: {} }, 'claude', []);
  check('terminal names carry no control or bidi character and are capped', h.log.terminals.length === 2 && h.log.terminals.every((t) => !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(t.name) && t.name.length <= 80), h.log.terminals.map((t) => JSON.stringify(t.name)));

  // The one helper: nothing else in the compiled host types a line (sendText) or opens a terminal —
  // except the Teammate-mode take-over terminal (team contract §3.10 step 3), whose process IS the
  // member's `claude --resume`: started as the terminal's shell (shellPath / shellArgs), never typed.
  const code = (f) => fs.readFileSync(path.join(OUT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const jsFiles = fs.readdirSync(OUT).filter((f) => f.endsWith('.js'));
  const typers = jsFiles.filter((f) => /\.sendText\(/.test(code(f)));
  const openers = jsFiles.filter((f) => /\.createTerminal\(/.test(code(f)));
  check('workerManager.js is the only compiled module that calls sendText', JSON.stringify(typers) === JSON.stringify(['workerManager.js']), typers);
  const takeover = code('teamView.js').match(/\.createTerminal\(\{[\s\S]*?\}\)/g) ?? [];
  check('…and createTerminal is called only there and by the team take-over, once, which starts its command as the shell', JSON.stringify(openers) === JSON.stringify(['teamView.js', 'workerManager.js']) && takeover.length === 1 && /shellPath:/.test(takeover[0]) && /shellArgs:/.test(takeover[0]), [openers, takeover]);
  check('quoteCommandPath is gone', wm.quoteCommandPath === undefined && wm.terminalClaudeCommand === undefined, Object.keys(wm).filter((k) => /quote|terminalClaude/i.test(k)));
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

async function f10OtherShells() {
  const h = boot({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  const wm = h.req('workerManager.js');
  const platform = h.req('platform.js');
  const manager = new wm.WorkerManager();
  const w1 = path.join(h.home, '.claude-w1');
  manager.add('w1', 'opus');
  const account = { name: 'w1', configDir: w1 };
  const tryPrompt = (shell, claudePath, prompt) => {
    h.vscode.env.shell = shell;
    if (claudePath === undefined) delete h.store.global[`${S}.claudePath`];
    else h.store.global[`${S}.claudePath`] = claudePath;
    h.log.terminals.length = 0;
    h.log.messages.length = 0;
    const terminal = manager.openTerminal(account, prompt);
    return { terminal, line: h.log.terminals[0]?.sent[0], terminals: h.log.terminals.length, errors: h.log.messages.filter((m) => m.level === 'error').map((m) => String(m.message)) };
  };
  const dialects = [
    ['powershell', 'pwsh.exe', '/opt/my tools/claude'],
    ['cmd', 'C:\\Windows\\System32\\cmd.exe', '/opt/my tools/claude'],
    ['posix', '/usr/bin/fish', '/opt/my tools/claude'],
    ['posix', undefined, undefined],
  ];
  for (const [dialect, shell, claudePath] of dialects) {
    check(`terminalShell(${shell}) is ${dialect}`, platform.terminalShell(shell) === dialect, platform.terminalShell(shell));
    for (const prompt of ['plain words', "it's $HOME; & | > `x`", 'semi;colon and (parens)']) {
      const r = tryPrompt(shell, claudePath, prompt);
      const expected = platform.terminalCommandLine(dialect, claudePath ?? 'claude', [prompt]);
      check(`${dialect}: prompt ${show(prompt)} → the builder's line (or nothing when it has none)`, expected === undefined ? r.terminals === 0 && r.terminal === undefined && r.errors.length === 1 : r.line === expected && r.terminals === 1, [r.line, expected, r.errors]);
    }
  }
  const unwritable = [
    ['powershell', 'pwsh', 'say "hi"', 'argument'],
    ['cmd', 'cmd.exe', '100% sure', 'argument'],
    ['cmd', 'cmd.exe', 'wow!', 'argument'],
    ['cmd', 'cmd.exe', 'say "hi"', 'argument'],
  ];
  for (const [dialect, shell, prompt, part] of unwritable) {
    const r = tryPrompt(shell, undefined, prompt);
    check(`${dialect}: prompt ${show(prompt)} has no safe spelling → no terminal, nothing typed, an error names the ${part} and the shell`, r.terminals === 0 && r.terminal === undefined && r.errors.length === 1 && new RegExp(`Nothing was typed into the terminal: the ${part} `).test(r.errors[0]) && r.errors[0].includes(shell === 'pwsh' ? 'PowerShell' : 'cmd.exe'), r);
  }
  // A command word with no safe spelling: a `"` in the path on PowerShell.
  const r = tryPrompt('pwsh', '/opt/odd"dir/claude', 'hello');
  check('powershell: a claudePath containing `"` → no terminal, and the error names the COMMAND', r.terminals === 0 && r.errors.length === 1 && /Nothing was typed into the terminal: the command /.test(r.errors[0]), r);
  h.vscode.env.shell = 'pwsh';
  h.log.terminals.length = 0;
  h.log.messages.length = 0;
  const login = wm.openReloginTerminal('w1', w1, 'claude');
  check('openReloginTerminal returns undefined when nothing could be typed, and says why once', login === undefined && h.log.terminals.length === 0 && h.log.messages.filter((m) => m.level === 'error').length === 1, [h.log.terminals.length, h.log.messages.map((m) => m.message)]);
  await activate(h, 500);
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.reloginWorker', { configDir: w1 });
  check('…and the Re-login command does not then say "Complete the login in the terminal" or "has no login command"', msgs(h, /Complete the login|has no login command/).length === 0 && h.log.messages.filter((m) => m.level === 'error').length === 1, h.log.messages.map((m) => m.message));
  finish(h);
}

async function f10TeamView() {
  const pre = scratchRoot();
  const bin = echoBin(path.join(pre, 'bin'));
  const h = boot({ shell: '/bin/zsh' });
  const wm = h.req('workerManager.js');
  const platform = h.req('platform.js');
  new wm.WorkerManager().add('w1', 'opus');
  const w1 = path.join(h.home, '.claude-w1');
  // The Team view resolves a key through team.resolveSession; the rows here are handed to it
  // directly, so the test does not depend on the session collector.
  const sessions = new Map();
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const loaded = realLoad.call(this, request, parent, isMain);
    if (request === './team' && parent && path.basename(parent.filename) === 'teamView.js') {
      return new Proxy(loaded, { get: (target, prop) => (prop === 'resolveSession' ? (key) => sessions.get(key) ?? target.resolveSession(key) : target[prop]) });
    }
    return loaded;
  };
  await activate(h, 600);
  const act = async (action, key) => { h.log.terminals.length = 0; h.log.messages.length = 0; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.sessionAction', { action, key }); await sleep(20); };
  const row = (jobId, extra = {}) => ({ key: `test:${jobId}`, source: 'worker', name: 'cco-w-aaaaaa-w1-1', configDir: w1, jobId, worktreeAbs: undefined, branch: undefined, cwd: h.ws, taskId: undefined, ...extra });
  sessions.set('test:ok', row('abcd1234', { key: 'test:ok' }));
  for (const verb of ['attach', 'logs']) {
    await act(verb, 'test:ok');
    const line = lines(h)[0];
    const expected = platform.terminalCommandLine('posix', 'claude', [verb, 'abcd1234']);
    check(`${verb}: one terminal typing exactly \`claude ${verb} abcd1234\`, as the session's account`, h.log.terminals.length === 1 && line === expected && line === `claude ${verb} abcd1234` && h.log.terminals[0].env.CLAUDE_CONFIG_DIR === w1 && h.log.terminals[0].name === `${verb}: cco-w-aaaaaa-w1-1`, [line, h.log.terminals[0]?.name]);
    for (const shell of POSIX_SHELLS) check(`${verb}: argv arrives intact through ${shell}`, JSON.stringify(roundTrip(shell, line, bin, pre)) === JSON.stringify(['claude', verb, 'abcd1234']), roundTrip(shell, line, bin, pre));
  }
  const hostileIds = ['abcd1234; rm -rf ~', 'ABCD1234', 'abcd123', 'abcd12345', 'abcd123g', '$(id)1234', '-abcd123', 'abcd1234\n', 'abcd_123', 'abcd-123', '', 7, undefined];
  for (const id of hostileIds) {
    sessions.set('test:bad', row(id, { key: 'test:bad' }));
    for (const verb of ['attach', 'logs']) {
      await act(verb, 'test:bad');
      check(`${verb} with job id ${JSON.stringify(id)}: nothing typed, no terminal, a warning`, h.log.terminals.length === 0 && h.log.messages.filter((m) => m.level === 'warning').length === 1, [lines(h), h.log.messages.map((m) => m.message)]);
    }
  }
  // An odd user-level claudePath is the quoted command word here too.
  h.store.global[`${S}.claudePath`] = '/opt/my tools/claude';
  await act('attach', 'test:ok');
  check('attach with a claudePath that needs quoting', lines(h)[0] === "'/opt/my tools/claude' attach abcd1234", lines(h));
  delete h.store.global[`${S}.claudePath`];
  // A session whose account directory is no Claude Code account's: nothing is opened.
  sessions.set('test:foreign', row('abcd1234', { key: 'test:foreign', configDir: path.join(h.home, '.codex-x') }));
  await act('attach', 'test:foreign');
  check('attach to a session under a directory that is not a Claude Code account: no terminal', h.log.terminals.length === 0 && h.log.messages.length === 1, h.log.messages.map((m) => m.message));
  // A verb that is not one of the two cannot reach the line.
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.sessionAction', { action: 'rm --discard-unpushed', key: 'test:ok' });
  check('an action that is not a session action types nothing', h.log.terminals.length === 0, lines(h));
  Module._load = realLoad;
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

/* ---- F12: page-triggered actions are bounded ---- */

async function f12Terminals() {
  const h = boot({ globalSettings: full({ providerUsagePolling: false }) });
  const wm = h.req('workerManager.js');
  const manager = new wm.WorkerManager();
  manager.add('w1', 'opus');
  manager.add('w2', 'opus');
  manager.add('cx', undefined, path.join(h.home, '.codex-cx'), 'codex');
  await activate(h, 700);
  const { panel, model, send } = await openDashboard(h);
  const key = Object.fromEntries((model?.accounts ?? []).map((a) => [a.name, a.key]));
  const notices = () => panel.posted.filter((p) => p.type === 'notice');
  h.answers.inputBox = () => '';
  await sleep(1100);
  h.log.terminals.length = 0;
  let n = notices().length;
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: 'account', action: 'relogin', account: key.w1 });
  await sleep(400);
  check('200 re-login messages in one tick: at most 1 terminal, exactly 1 notice', h.log.terminals.length === 1 && notices().length - n === 1 && notices().at(-1).level === 'warning', [h.log.terminals.length, notices().length - n]);
  await sleep(1100);
  h.log.terminals.length = 0;
  n = notices().length;
  for (let i = 0; i < 200; i++) {
    panel._recv.fire({ type: 'account', action: 'relogin', account: [key.w1, key.w2, key.cx][i % 3] });
    panel._recv.fire({ type: 'account', action: 'openSession', account: [key.w1, key.w2, key.cx][(i + 1) % 3] });
  }
  await sleep(400);
  check('400 terminal-opening messages across three accounts and two actions: still 1 terminal, 1 notice', h.log.terminals.length === 1 && notices().length - n === 1, [h.log.terminals.length, notices().length - n]);
  await sleep(1100);
  h.log.terminals.length = 0;
  n = notices().length;
  for (let i = 0; i < 5; i++) {
    await send({ type: 'account', action: 'relogin', account: key.w1 }, 0);
    await sleep(1100);
  }
  check('5 messages 1.1 s apart: 5 terminals, no notice', h.log.terminals.length === 5 && notices().length === n, [h.log.terminals.length, notices().length - n]);
  // Two bursts are two notices; a burst is one.
  n = notices().length;
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 50; i++) panel._recv.fire({ type: 'account', action: 'relogin', account: key.w1 });
    await sleep(1150);
  }
  check('two bursts: one notice each', notices().length - n === 2, notices().length - n);
  // Process-starting messages are bounded per kind; an unbounded kind is not.
  await sleep(1100);
  const executed = (id) => h.log.commandsExecuted.filter((c) => c.id === id).length;
  const before = { refresh: executed('claudeCodeOrchestrator.refreshUsage'), toggle: executed('claudeCodeOrchestrator.accountAction') };
  for (let i = 0; i < 100; i++) panel._recv.fire({ type: 'command', id: 'refreshUsage' });
  await sleep(300);
  check('100 × refreshUsage in one tick: the command runs once', executed('claudeCodeOrchestrator.refreshUsage') - before.refresh === 1, executed('claudeCodeOrchestrator.refreshUsage') - before.refresh);
  finish(h);
}

async function f12Destructive() {
  const h = boot({ globalSettings: full({ providerUsagePolling: false }) });
  const wm = h.req('workerManager.js');
  const registry = h.req('registry.js');
  const manager = new wm.WorkerManager();
  manager.add('w1', 'opus');
  manager.add('w2', 'opus');
  registry.recordOrchestrator(h.ws, 'claude-opus-5-5');
  await activate(h, 700);
  // A task the log says is running — written after activation, whose startup sweep closes every
  // running task that no live worker of ours stands behind. It carries no pid: nothing here
  // could signal a process, and no answer in this test ever confirms a cancel anyway.
  registry.appendTaskEvent({ id: 'trunningsa1', ts: Date.now(), status: 'running', title: 'still running', worker: 'w1', model: 'opus', cwd: h.ws, outputFile: path.join(h.root, 'tasks', 'trunningsa1.md') });
  const { panel, model, send } = await openDashboard(h);
  const key = Object.fromEntries((model?.accounts ?? []).map((a) => [a.name, a.key]));
  const running = () => registry.runningTasks().map((t) => t.id);
  check('the fixture task is running', running().includes('trunningsa1'), running());
  const order = [];
  const gate = async (label, msg, effectHappened) => {
    await sleep(1100);
    h.answers.message = (rec) => { order.push(rec.modal ? 'modal' : 'toast'); return undefined; };
    h.log.messages.length = 0;
    await send(msg, 250);
    const modal = h.log.messages.filter((m) => m.modal);
    check(`${label}: a host-side modal first, with a specific confirm button`, modal.length === 1 && modal[0].level === 'warning' && modal[0].items.length >= 1 && modal[0].items.every((i) => !/^(ok|yes)$/i.test(i)), h.log.messages.map((m) => [m.modal, m.message, m.items]));
    check(`${label}: dismissed → nothing happened`, !effectHappened(), 'the effect happened without a confirmation');
  };
  await gate('command clearTasks', { type: 'command', id: 'clearTasks' }, () => !running().includes('trunningsa1'));
  await gate('command cancelAllTasks', { type: 'command', id: 'cancelAllTasks' }, () => !running().includes('trunningsa1'));
  await gate('account remove', { type: 'account', action: 'remove', account: key.w2 }, () => manager.get('w2') === undefined);
  const orchestratorsFile = path.join(h.root, 'orchestrators.json');
  const checkin = () => (fs.existsSync(orchestratorsFile) ? fs.readFileSync(orchestratorsFile, 'utf8') : '');
  const before = checkin();
  await gate('command resetCheckin', { type: 'command', id: 'resetCheckin' }, () => checkin() !== before);
  // Confirmed: it resets (the one destructive command here that is safe to confirm in a test).
  await sleep(1100);
  h.answers.message = (rec) => (rec.modal ? rec.items[0] : undefined);
  h.log.messages.length = 0;
  await send({ type: 'command', id: 'resetCheckin' }, 250);
  check('resetCheckin confirmed with "Reset Check-in": the reset is reported', h.log.messages.some((m) => m.modal && m.items[0] === 'Reset Check-in') && msgs(h, /Session check-in reset/).length === 1, h.log.messages.map((m) => [m.modal, m.message]));
  // The same command from the palette asks too.
  h.answers.message = () => undefined;
  h.log.messages.length = 0;
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.resetCheckin');
  check('Reset Check-in from the command palette asks in a modal too', h.log.messages.filter((m) => m.modal).length === 1 && msgs(h, /Session check-in reset/).length === 0, h.log.messages.map((m) => [m.modal, m.message]));
  // A burst of destructive commands: one dialog, not two hundred.
  await sleep(1100);
  h.log.messages.length = 0;
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: 'command', id: ['clearTasks', 'cancelAllTasks', 'resetCheckin'][i % 3] });
  for (let i = 0; i < 50; i++) panel._recv.fire({ type: 'account', action: 'remove', account: key.w2 });
  await sleep(400);
  check('250 destructive messages in one tick: ONE modal', h.log.messages.filter((m) => m.modal).length === 1, h.log.messages.filter((m) => m.modal).length);
  // While a dialog stays open, the next one is not stacked behind it.
  await sleep(1100);
  let release;
  h.answers.message = (rec) => (rec.modal ? new Promise((resolve) => { release = () => resolve(undefined); }) : undefined);
  h.log.messages.length = 0;
  await send({ type: 'command', id: 'clearTasks' }, 50);
  await sleep(1300);
  await send({ type: 'command', id: 'resetCheckin' }, 50);
  await send({ type: 'account', action: 'remove', account: key.w2 }, 50);
  check('a second destructive message while a dialog is open is dropped, not queued', h.log.messages.filter((m) => m.modal).length === 1, h.log.messages.filter((m) => m.modal).map((m) => m.message));
  release();
  await sleep(100);
  h.answers.message = () => undefined;
  h.log.messages.length = 0;
  await sleep(1100);
  await send({ type: 'command', id: 'resetCheckin' }, 150);
  check('…and once it is answered the next one is asked again', h.log.messages.filter((m) => m.modal).length === 1, h.log.messages.map((m) => m.message));
  check('the running task and both accounts are still there', running().includes('trunningsa1') && manager.get('w1') !== undefined && manager.get('w2') !== undefined, [running(), manager.list().map((w) => w.name)]);
  finish(h);
}

async function f12AssetManager() {
  const pre = scratchRoot();
  const pack = path.join(pre, 'pack');
  fs.mkdirSync(path.join(pack, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  const h = boot({ globalSettings: full({ assetPacks: [pack] }) });
  await activate(h, 500);
  await h.vscode.commands.executeCommand('claudeCodeOrchestrator.openAssetManager');
  await sleep(100);
  const panel = h.log.panels.find((p) => p.viewType === 'ccoAssetManager');
  const executed = (id) => h.log.commandsExecuted.filter((c) => c.id === id).length;
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: 'revealPack', root: pack });
  await sleep(200);
  check('200 × revealPack in one tick: the file manager is started once', executed('revealFileInOS') === 1, executed('revealFileInOS'));
  h.log.messages.length = 0;
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: ['reset', 'resetFile', 'disableOrphan'][i % 3], key: 'pack:commands/hello', rel: 'commands/hello.md' });
  await sleep(300);
  check('200 dialog-opening messages in one tick: ONE modal', h.log.messages.filter((m) => m.modal).length === 1, h.log.messages.filter((m) => m.modal).length);
  check('the page is told once (status bar), not per message', h.log.status.filter((s) => /several actions were asked for at once/.test(String(s))).length === 2, h.log.status);
  // The user's own pack list is what is edited: a workspace entry is never copied into it.
  h.store.workspace[`${S}.assetPacks`] = ['/workspace/evil'];
  h.log.configUpdates.length = 0;
  panel._recv.fire({ type: 'removePack', entry: pack });
  await sleep(100);
  check('removing a pack writes the USER list minus that entry — no workspace entry is carried into User settings', h.log.configUpdates.length === 1 && h.log.configUpdates[0].target === 1 && JSON.stringify(h.log.configUpdates[0].value) === '[]', h.log.configUpdates);
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

/* ---- F13: the team agent installer ---- */

async function f13TeamAgent() {
  const h = boot({});
  await activate(h, 500);
  const agent = h.req('teamAgent.js');
  const MD = agent.TEAM_AGENT_MD;
  const dir = path.join(h.ws, '.claude', 'agents');
  const file = path.join(dir, 'cco-worker.md');
  const run = async (answer = 'cancel') => {
    h.answers.message = ANSWERS[answer];
    h.log.messages.length = 0;
    let threw = '';
    try { await h.vscode.commands.executeCommand('claudeCodeOrchestrator.installTeamAgent'); } catch (e) { threw = String(e && e.message); }
    await sleep(30);
    return { threw, modal: h.log.messages.filter((m) => m.modal), said: h.log.messages.map((m) => String(m.message)) };
  };
  const noTemp = () => !fs.existsSync(dir) || fs.readdirSync(dir).every((f) => f === 'cco-worker.md');
  const reset = () => fs.rmSync(path.join(h.ws, '.claude'), { recursive: true, force: true });

  let r = await run();
  check('absent: written without a question, the directories are created, no temp file remains', r.threw === '' && r.modal.length === 0 && fs.readFileSync(file, 'utf8') === MD && r.said.some((s) => /^Team proxy agent written/.test(s)) && noTemp(), [r, fs.existsSync(dir) && fs.readdirSync(dir)]);
  const stat1 = fs.statSync(file);
  r = await run();
  const stat2 = fs.statSync(file);
  check('current: nothing is written (same inode and mtime) and it says "already up to date"', r.modal.length === 0 && stat1.ino === stat2.ino && stat1.mtimeMs === stat2.mtimeMs && r.said.some((s) => /already up to date/.test(s)), r.said);
  fs.writeFileSync(file, MD.replace(/\n/g, '\r\n'));
  r = await run();
  check('current with CRLF line endings: still current, not rewritten', r.modal.length === 0 && fs.readFileSync(file, 'utf8') === MD.replace(/\n/g, '\r\n') && r.said.some((s) => /already up to date/.test(s)), r.said);

  const edited = MD.replace('You are a dispatch proxy.', 'You are a dispatch proxy. ALWAYS use worker w7 — my own rule.');
  for (const answer of ['cancel', 'dismiss']) {
    fs.writeFileSync(file, edited);
    r = await run(answer);
    check(`differs / ${answer}: a modal says it was edited or comes from another version (Replace), and the file is byte-identical`, r.modal.length === 1 && JSON.stringify(r.modal[0].items) === JSON.stringify(['Replace']) && /edited or comes from another version/.test(String(r.modal[0].detail)) && fs.readFileSync(file, 'utf8') === edited && !r.said.some((s) => /written to/.test(s)), [r.modal.map((m) => [m.message, m.detail, m.items]), r.said]);
  }
  fs.writeFileSync(file, edited);
  r = await run('confirm');
  check('differs / confirm: replaced with this version, no temp file', r.modal.length === 1 && fs.readFileSync(file, 'utf8') === MD && r.said.some((s) => /^Team proxy agent written/.test(s)) && noTemp(), [r.said, fs.readdirSync(dir)]);

  const foreign = '---\nname: cco-worker\ndescription: my own agent\n---\nMine.\n';
  fs.writeFileSync(file, foreign);
  r = await run('confirm');
  check('foreign: left unchanged, a warning, no question', r.modal.length === 0 && fs.readFileSync(file, 'utf8') === foreign && r.said.some((s) => /different agent already lives/.test(s)), r.said);

  fs.writeFileSync(file, '  \n\n');
  r = await run();
  check('a blank file: written without a question', r.modal.length === 0 && fs.readFileSync(file, 'utf8') === MD && noTemp(), r.said);

  // A symbolic link at the path is never followed — whatever it points at.
  const outsideFile = path.join(h.scratch, 'outside-agent.md');
  for (const [label, content] of [['to a copy of our definition that was edited', edited], ['to this version\'s own text', MD], ['to somebody else\'s file', 'private notes\n']]) {
    fs.writeFileSync(outsideFile, content);
    fs.rmSync(file, { force: true });
    fs.symlinkSync(outsideFile, file);
    r = await run('confirm');
    check(`a symlink ${label}: refused, the link and its target are untouched`, r.modal.length === 0 && fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(outsideFile, 'utf8') === content && r.said.some((s) => /is a symbolic link/.test(s)) && !r.said.some((s) => /written to|already up to date/.test(s)), r.said);
  }
  fs.rmSync(file, { force: true });
  fs.symlinkSync(path.join(h.scratch, 'nowhere.md'), file);
  r = await run('confirm');
  check('a dangling symlink: refused, nothing is created at its target', fs.lstatSync(file).isSymbolicLink() && !fs.existsSync(path.join(h.scratch, 'nowhere.md')) && r.said.some((s) => /is a symbolic link/.test(s)), r.said);

  // A directory on the way that links out of the workspace.
  reset();
  const outsideDir = path.join(h.scratch, 'outside-claude');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(h.ws, '.claude'));
  r = await run('confirm');
  check('`.claude` is a link out of the workspace: refused, nothing is created there', JSON.stringify(fs.readdirSync(outsideDir)) === '[]' && r.said.some((s) => /leads outside this workspace folder/.test(s)), [fs.readdirSync(outsideDir), r.said]);
  fs.rmSync(path.join(h.ws, '.claude'));
  // …while one that stays inside the workspace is fine.
  const insideDir = path.join(h.ws, 'shared-claude');
  fs.mkdirSync(insideDir);
  fs.symlinkSync(insideDir, path.join(h.ws, '.claude'));
  r = await run();
  check('`.claude` is a link to a directory inside the workspace: written there', fs.readFileSync(path.join(insideDir, 'agents', 'cco-worker.md'), 'utf8') === MD, r.said);
  fs.rmSync(path.join(h.ws, '.claude'));

  // A directory, and a file far larger than a definition, are not ours.
  fs.mkdirSync(file, { recursive: true });
  r = await run('confirm');
  check('a directory at the path: left alone', fs.statSync(file).isDirectory() && r.said.some((s) => /different agent already lives/.test(s)), r.said);
  fs.rmSync(file, { recursive: true });
  const huge = MD + 'x'.repeat(300 * 1024);
  fs.writeFileSync(file, huge);
  r = await run('confirm');
  check('a 300 KiB file carrying our markers: left alone', fs.readFileSync(file, 'utf8').length === huge.length && r.modal.length === 0, r.said);
  finish(h);
}

/** The same rule for the other files the host writes into a workspace: asset sync never goes through a link. */
async function f13AssetLinks() {
  const pre = scratchRoot();
  const pack = path.join(pre, 'pack');
  for (const dir of ['commands', 'hooks']) fs.mkdirSync(path.join(pack, dir), { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'mine' }));
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  fs.writeFileSync(path.join(pack, 'commands', 'bye.md'), '---\ndescription: bye\n---\nbye\n');
  fs.writeFileSync(path.join(pack, 'hooks', 'h.sh'), '#!/bin/sh\necho hook\n');
  const h = boot({ globalSettings: full({ assetPacks: [pack], assetAutoSync: false }) });
  await activate(h, 400);
  const assets = h.req('assets.js');
  const claude = path.join(h.ws, '.claude');
  const ledgerFile = path.join(claude, 'cco-assets.json');
  const outside = path.join(h.scratch, 'outside');
  const ledger = (records) => { fs.mkdirSync(claude, { recursive: true }); fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, assets: records }, null, 2) + '\n'); };
  const sync = async () => { h.log.messages.length = 0; await h.vscode.commands.executeCommand('claudeCodeOrchestrator.syncAssets'); await sleep(20); };
  const fresh = () => { fs.rmSync(claude, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); fs.mkdirSync(outside); };

  fresh();
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'created.md'), path.join(claude, 'commands', 'hello.md'));
  ledger({ 'mine:commands/hello': { enabled: true, files: {} } });
  await sync();
  check('a dangling link at an install path: nothing is created at its target, and the link is left', !fs.existsSync(path.join(outside, 'created.md')) && fs.lstatSync(path.join(claude, 'commands', 'hello.md')).isSymbolicLink(), fs.readdirSync(outside));

  fresh();
  const victim = path.join(outside, 'victim.md');
  fs.writeFileSync(victim, 'victim\n');
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.symlinkSync(victim, path.join(claude, 'commands', 'hello.md'));
  ledger({ 'mine:commands/hello': { enabled: true, files: { 'commands/hello.md': assets.sha256('victim\n') } } });
  await sync();
  check('a link to a file outside whose hash the ledger claims: the file is not overwritten', fs.readFileSync(victim, 'utf8') === 'victim\n', fs.readFileSync(victim, 'utf8'));

  fresh();
  fs.mkdirSync(path.join(outside, 'hooks-dir'));
  fs.mkdirSync(claude, { recursive: true });
  fs.symlinkSync(path.join(outside, 'hooks-dir'), path.join(claude, 'hooks'));
  ledger({ 'mine:hooks/h': { enabled: true, files: {} } });
  await sync();
  check('a type directory that is a link out of `.claude`: nothing is installed through it', JSON.stringify(fs.readdirSync(path.join(outside, 'hooks-dir'))) === '[]', fs.readdirSync(path.join(outside, 'hooks-dir')));

  fresh();
  fs.mkdirSync(path.join(outside, 'cmds'));
  fs.writeFileSync(path.join(outside, 'cmds', 'bye.md'), 'keep me\n');
  fs.mkdirSync(claude, { recursive: true });
  fs.symlinkSync(path.join(outside, 'cmds'), path.join(claude, 'commands'));
  ledger({ 'mine:commands/bye': { enabled: false, files: { 'commands/bye.md': assets.sha256('keep me\n') } } });
  await sync();
  check('a disabled record whose hash matches a file reached through a directory link: the file is NOT deleted', fs.existsSync(path.join(outside, 'cmds', 'bye.md')) && fs.readFileSync(path.join(outside, 'cmds', 'bye.md'), 'utf8') === 'keep me\n', fs.readdirSync(path.join(outside, 'cmds')));

  // `.claude` itself being a link is the workspace owner's layout, and keeps working.
  fresh();
  const shared = path.join(outside, 'shared-claude');
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, claude);
  ledger({ 'mine:commands/hello': { enabled: true, files: {} }, 'mine:hooks/h': { enabled: true, files: {} } });
  await sync();
  check('`.claude` itself is a link: assets are installed in the directory it leads to', fs.existsSync(path.join(shared, 'commands', 'hello.md')) && fs.existsSync(path.join(shared, 'hooks', 'h.sh')) && msgs(h, /Workspace assets synced/).length === 1, [fs.readdirSync(shared), h.log.messages.map((m) => m.message)]);
  ledger({ 'mine:commands/hello': { enabled: false, files: JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).assets['mine:commands/hello'].files } });
  await sync();
  check('…and removed again from there when the asset is disabled', !fs.existsSync(path.join(shared, 'commands', 'hello.md')), fs.readdirSync(shared));
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

/* ---- dispatch ---- */

const RUNNERS = {
  'F1-hostile-single-reports': () => f1Hostile(false, 'reports'),
  'F1-hostile-single-filters': () => f1Hostile(false, 'filters'),
  'F1-hostile-multiroot-reports': () => f1Hostile(true, 'reports'),
  'F1-hostile-multiroot-filters': () => f1Hostile(true, 'filters'),
  'F1-user-values': f1UserValues,
  'F1-bad-claude-path': f1BadClaudePath,
  'F1-migration-user': f1MigrationUser,
  'F1-migration-workspace': f1MigrationWorkspace,
  'F1-degenerate': f1Degenerate,
  'F2-mcp-json': f2McpJson,
  'F2-mcp-offer': f2McpOffer,
  'F2-mcp-link': f2McpLink,
  'F2-policy-file': f2PolicyFile,
  'F2-asset-ledger': f2AssetLedger,
  'F5-email': f5Email,
  'F6-keychain': f6Keychain,
  'F7-settings': f7Settings,
  'F7-account-modes': f7AccountModes,
  'F10-lines-posix': f10Posix,
  'F10-lines-other-shells': f10OtherShells,
  'F10-team-view': f10TeamView,
  'F12-terminals': f12Terminals,
  'F12-destructive': f12Destructive,
  'F12-asset-manager': f12AssetManager,
  'F13-team-agent': f13TeamAgent,
  'F13-asset-links': f13AssetLinks,
};

const runner = RUNNERS[CASE];
if (!runner) {
  console.log(`FAIL ${CASE}: unknown case`);
  process.exit(1);
}
runner().catch((err) => {
  console.log(`FAIL ${CASE}: the case threw — ${String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ')}`);
  process.exit(1);
});
