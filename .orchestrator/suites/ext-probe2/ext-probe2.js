// ext-probe2 — offline probe of the extension shell against a stand-in `vscode` module
// (the harness is ../lib/host-harness.js). Sections A-K: activation, the litter-prune driver,
// commands and their confirmations, terminals, the Tasks / Workers / Team trees, provider accounts.
//
// Usage (through run.sh): node ext-probe2.js <compiled out dir> <repo root>
'use strict';
const H = require('../lib/host-harness.js');
const {
  Module, fs, os, path, execFileSync, OUT, REPO, SANDBOX,
  HOME, BIN, WS, FAKE_LOG, REAL_HOME, FAKE_CLAUDE, FAKE_MODE, cp,
  realSpawnSync, realSpawn, PARTIAL, blockedSpawns, mayRun, fakeCalls, rec, answers,
  settingsBySection, settings, commands, configListeners, fireConfigChange, EventEmitter, TreeItem, ThemeIcon,
  ThemeColor, escapeMd, MarkdownString, vscode, team, teamStub, dashboardCalls, dashboardLogSinks,
  dashboardSettingsSyncs, stubByFile, timers, realSetTimeout, realSetInterval, captureTimers, realClearTimeout, realClearInterval,
  watched, registry, usage, keepalive, reaper, pool, litter, uiModel,
  platform, teamAgent, spawnGuards, providerRefresh, ledgerCalls, litterScript, accounts, outputs,
  realResolveAccount, ext, views, teamView, check, reset, run, readReg,
  memento, hovered, readWorkers, skip, NO_BASE_BUILD, shown, Uri, EXTENSION_ID,
} = H;
(async () => {
  /* =============================================================== A. activation */
  // Hand-edited settings, including the two that no longer exist.
  Object.assign(settings, {
    meshMode: 'yes', meshMaxLiveWorkers: 9999, meshHistoryLimit: -5,
    meshGatewayModel: 'sonnet', meshWorkerIdleTimeoutMin: 3,
    quotaCooldownMinutes: 'abc', workerPermissionMode: 'rm -rf /',
  });
  // WAVE2: a bundle directory the way `npm run bundle-server` leaves it, and a stable directory
  // that still holds the companions of an EARLIER version.
  const EXT_DIR = path.join(SANDBOX, 'ext');
  const BUNDLE = path.join(EXT_DIR, 'out', 'mcp');
  fs.mkdirSync(BUNDLE, { recursive: true });
  fs.writeFileSync(path.join(BUNDLE, 'server.js'), '// server v2\n');
  fs.writeFileSync(path.join(BUNDLE, 'run-task.js'), '// supervisor v2\n');
  if (!PARTIAL) fs.writeFileSync(path.join(BUNDLE, 'provider-cli.js'), '// helper v2\n');
  const STABLE = path.join(registry.ROOT_DIR, 'mcp');
  fs.mkdirSync(STABLE, { recursive: true });
  fs.writeFileSync(path.join(STABLE, 'run-task.js'), '// STALE supervisor v1\n');
  fs.writeFileSync(path.join(STABLE, 'provider-cli.js'), '// STALE helper v1\n');
  const context = {
    subscriptions: [], globalState: memento(), workspaceState: memento(),
    extension: { id: EXTENSION_ID, packageJSON: { version: '2.0.0' } },
    asAbsolutePath: (p) => path.join(EXT_DIR, p),
  };
  const staleInodes = ['run-task.js', 'provider-cli.js'].map((f) => fs.statSync(path.join(STABLE, f)).ino);
  captureTimers(true);
  let activateError;
  try { ext.activate(context); } catch (e) { activateError = e; }
  captureTimers(false);
  // What activation OWES but does not wait for (second review, §9.5 / §9.10): no login shell and no whole-file
  // work on the activation path. Looked at before this function gives the event loop a single turn.
  const atReturn = {
    usageRefresh: spawnGuards.usageRefresh, orphanReap: spawnGuards.orphanReap, providerRefresh: providerRefresh.calls.length,
    stable: fs.readdirSync(STABLE).sort().join(','), staleStill: fs.readFileSync(path.join(STABLE, 'run-task.js'), 'utf8'),
    blocked: blockedSpawns.length, fake: fakeCalls().length, claudePath: readReg().claudePath,
  };
  await new Promise((r) => realSetTimeout(r, 50));
  check('A1 activate() returns without throwing', activateError === undefined, activateError && activateError.stack);
  check('A1b when activate() returns, nothing it owes has run yet — no usage refresh, no orphan sweep, the stable server copy not touched — and no login shell was started: the registry holds the command as configured ("claude"), and the resolved path arrives on a later turn',
    activateError === undefined && atReturn.usageRefresh === 0 && atReturn.orphanReap === 0 && atReturn.providerRefresh === 0 && atReturn.stable === 'provider-cli.js,run-task.js' && atReturn.staleStill === '// STALE supervisor v1\n'
    && atReturn.blocked === 0 && atReturn.fake === 0 && atReturn.claudePath === 'claude' && readReg().claudePath === FAKE_CLAUDE && blockedSpawns.length === 0,
    JSON.stringify({ ...atReturn, claudePathLater: readReg().claudePath === FAKE_CLAUDE ? '<the fake CLI>' : readReg().claudePath }));

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  const registered = [...commands.keys()].sort();
  check('A2 registered commands == commands declared in package.json', JSON.stringify(declared) === JSON.stringify(registered),
    `${registered.length} registered, ${declared.length} declared`);
  const viewsUp = [...Object.keys(rec.treeViews), ...Object.keys(rec.providers)].sort();
  check('A3 the four views have providers', JSON.stringify(viewsUp) === JSON.stringify(pkg.contributes.views.claudeCodeOrchestrator.map((v) => v.id).sort()), viewsUp.join(', '));
  const reg = readReg();
  check('A4 removed settings are not synced into the registry', !('meshGatewayModel' in reg) && !('meshWorkerIdleTimeoutMin' in reg), Object.keys(reg).join(','));
  check('A5 meshMode "yes" (not a boolean) reads as off', reg.meshMode === 'off', reg.meshMode);
  check('A6 meshMaxLiveWorkers 9999 → 64, meshHistoryLimit -5 → 1', reg.meshMaxLiveWorkers === 64 && reg.meshHistoryLimit === 1, `${reg.meshMaxLiveWorkers}, ${reg.meshHistoryLimit}`);
  check('A7 quotaCooldownMinutes "abc" → 30', reg.cooldownMinutes === 30, JSON.stringify(reg.cooldownMinutes));
  check('A8 workerPermissionMode "rm -rf /" → acceptEdits', reg.permissionMode === 'acceptEdits', reg.permissionMode);
  check('A9 no real probe ran: usage refresh and orphan reap were the patched stand-ins', spawnGuards.usageRefresh >= 1 && spawnGuards.orphanReap === 1 && fakeCalls().length === 0,
    JSON.stringify(spawnGuards));
  Object.assign(settings, { meshMode: true, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, quotaCooldownMinutes: 30, workerPermissionMode: 'acceptEdits' });
  delete settings.meshGatewayModel; delete settings.meshWorkerIdleTimeoutMin;

  /* ============================================== K. wave-2 seams at activation */
  const stableFile = (f) => (fs.existsSync(path.join(STABLE, f)) ? fs.readFileSync(path.join(STABLE, f), 'utf8') : null);
  if (PARTIAL) {
    // Child run: the bundle has NO provider-cli.js. The stable server must not be left beside an older helper.
    check('K7 a companion missing from the bundle is REMOVED from the stable directory, never left stale; the others are still refreshed',
      stableFile('server.js') === '// server v2\n' && stableFile('run-task.js') === '// supervisor v2\n' && stableFile('provider-cli.js') === null,
      JSON.stringify([stableFile('server.js'), stableFile('run-task.js'), stableFile('provider-cli.js')]));
    check('K7b the helper path handed to the usage module is still the bundled one (its absence is the usage module\'s to report)',
      providerRefresh.calls.length >= 1 && providerRefresh.calls[0].helperPath === path.join(BUNDLE, 'provider-cli.js'), providerRefresh.calls[0] && providerRefresh.calls[0].helperPath);
    for (const d of context.subscriptions) { try { d.dispose(); } catch { /* stub disposables */ } }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    console.log(`\n${H.passes} passed, ${H.failures} failed`);
    process.exit(H.failures === 0 ? 0 : 1);
  }
  check('K1 the server AND its companions travel to the stable directory, replacing the stale copies of an earlier version',
    stableFile('server.js') === '// server v2\n' && stableFile('run-task.js') === '// supervisor v2\n' && stableFile('provider-cli.js') === '// helper v2\n',
    JSON.stringify([stableFile('server.js'), stableFile('run-task.js'), stableFile('provider-cli.js')]));
  check('K1b the stale copies were REPLACED, not written into (a new file under each name), and nothing else is left in the stable directory — no temp file',
    fs.statSync(path.join(STABLE, 'run-task.js')).ino !== staleInodes[0] && fs.statSync(path.join(STABLE, 'provider-cli.js')).ino !== staleInodes[1]
    && fs.readdirSync(STABLE).sort().join(',') === 'provider-cli.js,run-task.js,server.js' && ['server.js', 'run-task.js', 'provider-cli.js'].every((f) => fs.lstatSync(path.join(STABLE, f)).isFile()),
    fs.readdirSync(STABLE).sort().join(','));
  check('K2 F9: setDashboardLog was called once, and the sink writes into the extension\'s ONE output channel',
    dashboardLogSinks.length === 1 && rec.channels.length === 1 && (dashboardLogSinks[0]('[dashboard] hello'), rec.channels[0].lines.includes('[dashboard] hello')),
    `${dashboardLogSinks.length} sink(s), ${rec.channels.length} channel(s)`);
  check('K3 activation asks for provider usage with the absolute path of the BUNDLED helper and polling on (the setting is unset)',
    providerRefresh.calls.length === 1 && providerRefresh.calls[0].helperPath === path.join(BUNDLE, 'provider-cli.js') && path.isAbsolute(providerRefresh.calls[0].helperPath)
    && providerRefresh.calls[0].polling === true && providerRefresh.calls[0].force === false, JSON.stringify(providerRefresh.calls));
  const usageTimerProbe = timers.find((t) => t.kind === 'interval' && t.ms === 5 * 60 * 1000);
  settings.providerUsagePolling = false;
  const guardBefore = spawnGuards.usageRefresh;
  usageTimerProbe.fn();
  await new Promise((r) => realSetTimeout(r, 20));
  check('K4 the 5-minute timer refreshes Claude usage AND provider usage; providerUsagePolling=false is read on that tick → polling:false',
    usageTimerProbe !== undefined && spawnGuards.usageRefresh === guardBefore + 1 && providerRefresh.calls.length === 2 && providerRefresh.calls[1].polling === false && providerRefresh.calls[1].force === false,
    JSON.stringify(providerRefresh.calls.slice(1)));
  const pollingFor = async (value) => {
    if (value === undefined) delete settings.providerUsagePolling; else settings.providerUsagePolling = value;
    usageTimerProbe.fn();
    await new Promise((r) => realSetTimeout(r, 10));
    return providerRefresh.calls[providerRefresh.calls.length - 1].polling;
  };
  const pollingReadings = [];
  for (const v of [true, false, undefined, 'off', 0, null, 'false']) pollingReadings.push(`${JSON.stringify(v)}→${await pollingFor(v)}`);
  check('K5 polling is ON unless the setting is literally false (the reading the dashboard shows for the same toggle)',
    pollingReadings.join(' ') === 'true→true false→false undefined→true "off"→true 0→true null→true "false"→true', pollingReadings.join(' '));
  delete settings.providerUsagePolling;
  // The dispatch server refreshes these accounts too (list_workers) and reads the opt-out from the registry.
  const syncedFor = (value) => {
    if (value === undefined) delete settings.providerUsagePolling; else settings.providerUsagePolling = value;
    fireConfigChange();
    const reg = readReg();
    return 'providerUsagePolling' in reg ? JSON.stringify(reg.providerUsagePolling) : 'absent';
  };
  const synced = [];
  for (const v of [false, true, false, undefined, 'off', false, 0, null]) synced.push(`${JSON.stringify(v)}→${syncedFor(v)}`);
  check('K5b the opt-out is synced into the shared registry for the dispatch server: false is stored as false, everything else as ABSENT (on), and it follows each settings change',
    configListeners.length >= 1 && synced.join(' ') === 'false→false true→absent false→false undefined→absent "off"→absent false→false 0→absent null→absent', synced.join(' '));
  delete settings.providerUsagePolling;
  fireConfigChange();
  reset();
  const callsBeforeManual = providerRefresh.calls.length;
  await run('refreshUsage');
  check('K6 "Refresh Account Usage" refreshes Claude usage, then FORCES a provider reading, then reports',
    providerRefresh.calls.length === callsBeforeManual + 1 && providerRefresh.calls[callsBeforeManual].force === true && providerRefresh.calls[callsBeforeManual].polling === true
    && rec.messages.length === 1 && rec.messages[0].msg === 'Account usage refreshed.', JSON.stringify(providerRefresh.calls.slice(callsBeforeManual)));
  providerRefresh.fail = true;
  const unhandledK = [];
  const onUnhandledK = (e) => unhandledK.push(e);
  process.on('unhandledRejection', onUnhandledK);
  let timerThrew;
  try { usageTimerProbe.fn(); } catch (e) { timerThrew = e; }
  await new Promise((r) => realSetTimeout(r, 20));
  process.off('unhandledRejection', onUnhandledK);
  providerRefresh.fail = false;
  check('K8 a provider refresh that throws is logged to the output channel — never thrown out of the timer, never an unhandled rejection',
    timerThrew === undefined && unhandledK.length === 0 && rec.channels[0].lines.some((l) => l.includes('[provider usage] refresh failed: helper exploded')), rec.channels[0].lines.slice(-1)[0]);
  const partial = realSpawnSync(process.execPath, [__filename, OUT, REPO], { env: { ...process.env, HOME: REAL_HOME, USERPROFILE: REAL_HOME, CCO_PROBE_MODE: 'partial-bundle' }, encoding: 'utf8' });
  const partialLines = String(partial.stdout).split('\n').filter((l) => /^(PASS|FAIL) — K7/.test(l));
  for (const l of partialLines) console.log(`  (child run, bundle without provider-cli.js) ${l}`);
  check('K7 child run with a bundle that lacks the helper: both K7 probes pass', partial.status === 0 && partialLines.length === 2 && partialLines.every((l) => l.startsWith('PASS')), `exit ${partial.status}; ${String(partial.stderr).slice(0, 200)}`);

  /* ============================================================ B. litter prune */
  const litterTimer = timers.find((t) => t.kind === 'timeout' && t.ms === 15000);
  check('B1 the prune is armed 15 s after startup and has not run yet', litterTimer !== undefined && litterScript.calls.length === 0,
    timers.map((t) => `${t.kind}:${t.ms}`).join(' '));
  const W1 = path.join(HOME, '.claude-w1');
  const W2 = path.join(HOME, '.claude-w2');
  fs.mkdirSync(W1); fs.mkdirSync(W2);
  registry.updateRegistry((r) => { r.workers = [{ name: 'w1', configDir: W1, model: 'opus' }, { name: 'w2', configDir: W2, model: 'sonnet' }]; });
  const mainDir = platform.hostConfigDir();
  const report = (dir, removed, truncated, extra = {}) => ({ configDir: dir, scanned: 100, removed, truncated, errors: 0, ...extra });
  const fireLitter = async () => { litterTimer.fn(); for (let i = 0; i < 60; i++) await new Promise((r) => realSetTimeout(r, 5)); };

  // every pass truncated and productive → exactly 10 passes
  litterScript.calls.length = 0;
  litterScript.next = (dirs) => dirs.map((d) => report(d, 7, d === W1));
  reset();
  await fireLitter();
  check('B2 first pass covers main + every worker dir', JSON.stringify(litterScript.calls[0]) === JSON.stringify([mainDir, W1, W2]), JSON.stringify(litterScript.calls[0]));
  check('B3 a directory that stays truncated is retried, capped at 10 passes', litterScript.calls.length === 10 && litterScript.calls.slice(1).every((c) => JSON.stringify(c) === JSON.stringify([W1])),
    `${litterScript.calls.length} passes; later passes: ${JSON.stringify(litterScript.calls[1])}`);
  const NOTICE = 'stale session files left by usage probes of earlier versions.';
  const notices = () => rec.messages.filter((m) => m.msg.includes(NOTICE));
  check('B4 one information message with the totals', notices().length === 1 && notices()[0].msg === `Removed ${7 * 3 + 7 * 9} ${NOTICE}` && notices()[0].level === 'info', notices().map((m) => m.msg).join(' | '));
  check('B5 totals are logged to the output channel', rec.channels[0].lines.some((l) => /done: examined \d+, removed 84/.test(l)), rec.channels[0].lines.slice(-1)[0]);

  // within 24 h → gated
  litterScript.calls.length = 0; reset();
  await fireLitter();
  check('B6 a second run inside 24 h does nothing', litterScript.calls.length === 0, `${litterScript.calls.length} prune calls`);

  // stamp older than 24 h → runs, removes more, but the notice is not repeated
  await context.globalState.update('cco.sessionLitter.lastRunAt', Date.now() - 25 * 3600 * 1000);
  litterScript.calls.length = 0; reset();
  litterScript.next = (dirs) => dirs.map((d) => report(d, 3, false));
  await fireLitter();
  check('B7 after 24 h it runs again and the notice is NOT repeated', litterScript.calls.length === 1 && notices().length === 0, `${litterScript.calls.length} calls, ${notices().length} notices`);

  // a stamp in the future (clock set back) must not suppress the prune
  await context.globalState.update('cco.sessionLitter.lastRunAt', Date.now() + 10 * 24 * 3600 * 1000);
  litterScript.calls.length = 0;
  await fireLitter();
  check('B8 a last-run stamp in the FUTURE does not block the prune', litterScript.calls.length === 1, `${litterScript.calls.length} calls`);

  // truncated but nothing removed → no pointless repeats
  await context.globalState.update('cco.sessionLitter.lastRunAt', 0);
  litterScript.calls.length = 0;
  litterScript.next = (dirs) => dirs.map((d) => report(d, 0, true));
  await fireLitter();
  check('B9 a truncated pass that removed nothing is not repeated', litterScript.calls.length === 1, `${litterScript.calls.length} calls`);

  // hostile report shapes and a rejecting prune never throw
  await context.globalState.update('cco.sessionLitter.lastRunAt', 0);
  litterScript.calls.length = 0; reset();
  litterScript.next = () => [null, 'x', { configDir: 7, scanned: '9', removed: NaN, truncated: 'yes', errors: -3 }, report(W1, Infinity, false)];
  let threw;
  try { await fireLitter(); } catch (e) { threw = e; }
  check('B10 non-object reports and non-finite counts are tolerated (nothing counted, no notice, no throw)',
    threw === undefined && notices().length === 0 && rec.channels[0].lines.slice(-1)[0].includes('removed 0'), rec.channels[0].lines.slice(-1)[0]);
  await context.globalState.update('cco.sessionLitter.lastRunAt', 0);
  litterScript.next = () => { throw new Error('disk on fire'); };
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  await fireLitter();
  process.off('unhandledRejection', onUnhandled);
  check('B11 a prune that rejects is logged, not thrown', unhandled.length === 0 && rec.channels[0].lines.some((l) => l.includes('disk on fire')), `${unhandled.length} unhandled rejections`);

  // the command: no gate, progress, totals
  await context.globalState.update('cco.sessionLitter.lastRunAt', Date.now());
  await context.globalState.update('cco.sessionLitter.noticeShown', undefined);
  litterScript.calls.length = 0; reset();
  litterScript.next = (dirs, n) => dirs.map((d) => report(d, 5, n < 2 && d === W2, { errors: d === W2 ? 2 : 0 }));
  await run('cleanSessionLitter');
  check('B12 cleanSessionLitter runs despite the 24 h stamp, with progress', litterScript.calls.length === 2 && rec.progress.length === 1, `${litterScript.calls.length} passes, ${rec.progress.length} progress`);
  check('B13 it reports totals', rec.messages.length === 1 && rec.messages[0].msg.startsWith('Removed 20 stale session files (400 examined).') && rec.messages[0].msg.includes('4 could not be read or removed'), rec.messages[0] && rec.messages[0].msg);
  check('B14 a manual run counts as the first-time notice', context.globalState.get('cco.sessionLitter.noticeShown') === true);

  /* ========================================================== C. accountAction */
  const mainKey = 'a'.repeat(16);
  const w1Key = 'b'.repeat(16);
  accounts.set(mainKey, { name: 'main', configDir: mainDir, isMain: true, isWorker: false });
  accounts.set(w1Key, { name: 'w1', configDir: W1, isMain: false, isWorker: true });
  const quiet = () => rec.messages.length + rec.terminals.length + rec.quickPicks.length + rec.inputs.length;
  const workerNames = () => readReg().workers.map((w) => `${w.name}:${w.model}:${w.preferred === true}`).join(',');
  const before = workerNames();

  reset();
  for (const arg of [undefined, null, 7, 'remove', [], {}, { action: 'remove' }, { action: 'remove', account: 'nope' }, { action: 'remove', account: { toString: () => w1Key } },
    { action: 'remove', account: '../../etc' }, { action: 'detonate', account: w1Key }, { action: 'constructor', account: w1Key }, { action: ['remove'], account: w1Key },
    JSON.parse(`{"action":"remove","account":"${w1Key}x"}`), JSON.parse(`{"__proto__":{"action":"remove","account":"${w1Key}"}}`)]) {
    await run('accountAction', arg);
  }
  check('C1 unknown account keys, unknown actions and malformed arguments do nothing at all', quiet() === 0 && workerNames() === before, `${quiet()} UI calls; workers ${workerNames()}`);

  reset();
  await run('accountAction', { action: 'remove', account: w1Key });
  check('C2 remove asks with a MODAL first; dismissing it keeps the account', rec.messages.length === 1 && rec.messages[0].modal === true && workerNames() === before, JSON.stringify(rec.messages.map((m) => [m.level, m.modal, m.msg])));
  reset();
  answers.message.push(() => 'Cancel');
  await run('accountAction', { action: 'remove', account: w1Key });
  check('C3 any answer other than the confirm button keeps the account', workerNames() === before, workerNames());

  for (const bad of ['gpt-4', '', '   ', null, 42, 'opus; rm -rf ~', 'claude-', { toString: () => 'opus' }, 'x'.repeat(500)]) {
    reset();
    await run('accountAction', { action: 'setModel', account: w1Key, value: bad });
    if (workerNames() !== before || rec.messages.length !== 1 || rec.messages[0].level !== 'warning') {
      check(`C4 setModel rejects ${JSON.stringify(bad)}`, false, `${workerNames()} / ${JSON.stringify(rec.messages)}`);
    }
  }
  check('C4 setModel rejects every value that is not a model (9 variants) and changes nothing', workerNames() === before, workerNames());
  reset();
  await run('accountAction', { action: 'setModel', account: w1Key, value: '  SONNET ' });
  const afterAlias = readReg().workers.find((w) => w.name === 'w1').model;
  await run('accountAction', { action: 'setModel', account: w1Key, value: 'claude-opus-4-8' });
  const afterLegacy = readReg().workers.find((w) => w.name === 'w1').model;
  await run('accountAction', { action: 'setModel', account: w1Key, value: 'claude-opus-5-5' });
  const afterFull = readReg().workers.find((w) => w.name === 'w1').model;
  // [UPDATED wave 10: a v1.x tier id chosen in the editor is PINNED — `claude-opus-4-8` is a model the CLI offers ("Opus 4.8"); stored exactly, with modelPinned]
  const legacyEntry = readReg().workers.find((w) => w.name === 'w1');
  check('C5 setModel stores the normalized value', afterAlias === 'sonnet' && afterLegacy === 'claude-opus-4-8' && afterFull === 'claude-opus-5-5' && legacyEntry.modelPinned === true, `${afterAlias}, ${afterLegacy}, ${afterFull}`);
  reset();
  answers.quickPick.push((items) => items.find((i) => i.label === 'fable'));
  await run('accountAction', { action: 'setModel', account: w1Key });
  // Since wave 7 (contract §11.2) the Claude Code picker is: the stored default first when it is not an alias (w1's is
  // the full id C5 just stored), marked as the current one; one item per WORKER_MODELS alias; then "Enter a model id…".
  check('C6 [UPDATED: a stored full id leads the list, and "Enter a model id…" closes it] setModel with no value offers the current full id, platform WORKER_MODELS, and a way to type an id',
    rec.quickPicks.length === 1 && JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)) === JSON.stringify(['claude-opus-5-5', ...platform.WORKER_MODELS, 'Enter a model id…'])
    && rec.quickPicks[0].items[0].description === 'current' && rec.quickPicks[0].items.filter((i) => i.description === 'current').length === 1
    && readReg().workers.find((w) => w.name === 'w1').model === 'fable', JSON.stringify(rec.quickPicks[0] && rec.quickPicks[0].items.map((i) => `${i.label}/${i.description}`)));

  reset();
  await run('accountAction', { action: 'togglePreferred', account: mainKey });
  await run('accountAction', { action: 'remove', account: mainKey });
  await run('accountAction', { action: 'setModel', account: mainKey, value: 'opus' });
  check('C7 worker-only actions on the main (non-worker) account warn and change nothing', rec.messages.length === 3 && rec.messages.every((m) => m.level === 'warning' && !m.modal) && readReg().workers.length === 2,
    rec.messages.map((m) => m.msg).join(' | '));
  // an account key resolving to a name that exists under a DIFFERENT directory is not that worker
  accounts.set('c'.repeat(16), { name: 'w1', configDir: path.join(HOME, '.claude-elsewhere'), isMain: false, isWorker: true });
  reset();
  answers.message.push((items) => items[0]);
  await run('accountAction', { action: 'remove', account: 'c'.repeat(16) });
  check('C8 name matches but directory does not → not treated as that worker', readReg().workers.length === 2 && rec.messages[0].level === 'warning' && !rec.messages[0].modal, rec.messages.map((m) => m.msg).join(' | '));

  reset();
  await run('accountAction', { action: 'relogin', account: mainKey });
  const tMain = rec.terminals[0];
  check('C9 re-login of the default-directory account opens a terminal with CLAUDE_CONFIG_DIR REMOVED (null), not set', tMain && tMain.opts.env.CLAUDE_CONFIG_DIR === null && /^claude auth login/.test(tMain.sent[0]), tMain && JSON.stringify([tMain.opts.env.CLAUDE_CONFIG_DIR, tMain.sent]));
  check('C10 that terminal strips the session-identity variables', tMain && ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID'].every((k) => tMain.opts.env[k] === null));
  reset();
  await run('accountAction', { action: 'relogin', account: w1Key });
  check('C11 re-login of a worker sets its directory verbatim and drops an inherited OAuth token', rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR === W1 && rec.terminals[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN === null, JSON.stringify(rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR));
  reset();
  answers.input.push('fix `the` "bug" $HOME');
  await run('accountAction', { action: 'openSession', account: w1Key });
  check('C12 openSession opens a session terminal through claudeTerminalEnv with the prompt shell-quoted', rec.terminals.length === 1 && rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR === W1
    && rec.terminals[0].sent[0] === "claude 'fix `the` \"bug\" $HOME'", rec.terminals[0] && rec.terminals[0].sent[0]);
  reset();
  await run('accountAction', { action: 'openSession', account: w1Key });
  check('C13 dismissing the prompt box opens nothing', rec.terminals.length === 0 && rec.inputs.length === 1);

  // tree paths of the same actions
  // [second review, §9.3: these three handed the commands a hand-built object shaped like a row — { name, configDir, model }.]
  // A command given an element of the Workers tree takes the worker from what the TREE made of it — the name the row
  // was listed under — never from a key found on it. So the element handed over here is the tree's own row.
  const accountsTree = rec.providers['claudeCodeOrchestrator.workers'];
  const treeRow = (name) => accountsTree.getChildren().find((r) => r.name === name);
  reset();
  await run('removeWorker', treeRow('w2'));
  check('C14 the tree\'s Remove Worker Account is modal too', rec.messages.length === 1 && rec.messages[0].modal === true && /w2/.test(rec.messages[0].msg) && readReg().workers.length === 2, rec.messages.map((m) => m.msg).join(' | '));
  {
    // …by provenance: the row of w1 with every key on it changed to say "w2" still stands for w1,
    const forged = treeRow('w1');
    const kept = { name: forged.name, id: forged.id, kind: forged.kind };
    Object.assign(forged, { name: 'w2', id: 'w2', kind: 'unsupportedWorker' });
    reset();
    await run('removeWorker', forged);
    const askedAbout = rec.messages.map((m) => m.msg).join(' | ');
    for (const k of Object.keys(kept)) { if (kept[k] === undefined) delete forged[k]; else forged[k] = kept[k]; }
    // a detail row under an account names no worker, and neither does a payload that says it is an unsupported entry's row
    const detail = accountsTree.getChildren(treeRow('w1'))[0];
    const before = JSON.stringify(readReg().workers);
    const asked = { forged: rec.messages.length, forgedModal: rec.messages[0] && rec.messages[0].modal };
    reset();
    answers.message.push((items) => items[0], (items) => items[0], (items) => items[0]);
    await run('removeWorker', detail);
    await run('setWorkerModel', detail);
    await run('removeWorker', { kind: 'unsupportedWorker', name: 'w1' });
    check('C14b a tree row is what the tree made it: the row listed as w1 still means w1 when its own name / id / kind keys say otherwise (the confirmation names w1, never w2); a detail row and a payload claiming to be an unsupported entry\'s row name NO worker — nothing asked, no worker picker in their place, nothing changed',
      asked.forged === 1 && asked.forgedModal === true && /"w1"|\bw1\b/.test(askedAbout) && !/\bw2\b/.test(askedAbout)
      && detail !== undefined && rec.messages.length === 0 && rec.quickPicks.length === 0 && JSON.stringify(readReg().workers) === before && readReg().workers.length === 2,
      `asked: ${askedAbout.slice(0, 120)} || then ${rec.messages.length} message(s), ${rec.quickPicks.length} pick(s)`);
  }
  reset();
  answers.message.push((items) => items[0]);
  await run('removeWorker', treeRow('w2'));
  check('C15 confirming removes exactly that worker', readReg().workers.map((w) => w.name).join(',') === 'w1', readReg().workers.map((w) => w.name).join(','));
  reset();
  answers.quickPick.push((items) => items[0]);
  await run('setWorkerModel', treeRow('w1'));
  check('C16 Set Default Model from the tree', rec.quickPicks.length === 1 && readReg().workers[0].model === platform.WORKER_MODELS[0] && rec.quickPicks[0].items.some((i) => i.description === 'current'), readReg().workers[0].model);

  /* ========================================================== D. session actions */
  const mk = (over) => ({
    key: 'worker:abcd1234', source: 'worker', name: 'cco-w-1', accountKey: w1Key, accountName: 'w1', kind: 'background', status: 'busy', detail: null,
    taskId: 'tabc1234', taskTitle: 'Build the thing', model: 'opus', startedAt: Date.now() - 60000, updatedAt: Date.now(), location: '.claude/worktrees/cco-1',
    branch: 'worktree-cco-t1', unmerged: true, settled: false, inWorkspace: true, canAttach: true, canStop: true, team: null, role: null, ...over,
  });
  const res = (over) => ({ key: 'worker:abcd1234', source: 'worker', name: 'cco-w-1', configDir: W1, jobId: 'abcd1234', worktreeAbs: undefined, branch: 'worktree-cco-t1', cwd: WS, taskId: 'tabc1234', ...over });
  team.resolved.set('worker:abcd1234', res({}));
  team.resolved.set('worker:evil', res({ key: 'worker:evil', jobId: 'ab12; rm -rf ~' }));
  team.resolved.set('worker:dash', res({ key: 'worker:dash', jobId: '--help' }));
  team.resolved.set('worker:nodir', res({ key: 'worker:nodir', configDir: undefined }));
  team.resolved.set('teammate:x', res({ key: 'teammate:x', source: 'teammate', name: 'reviewer', configDir: undefined, jobId: undefined, branch: undefined }));
  team.resolved.set('teammate:jobbed', res({ key: 'teammate:jobbed', source: 'teammate', name: 'reviewer' }));
  team.resolved.set('peer:nojob', res({ key: 'peer:nojob', source: 'peer', name: 'panel', jobId: undefined }));
  team.resolved.set('worker:badbranch', res({ key: 'worker:badbranch', branch: '--output=/tmp/pwned' }));
  team.resolved.set('worker:dotdot', res({ key: 'worker:dotdot', branch: 'main..HEAD' }));
  team.resolved.set('worker:nobranch', res({ key: 'worker:nobranch', branch: 'worktree-cco-missing' }));

  reset();
  const callsBefore = fakeCalls().length;
  for (const arg of [undefined, null, 'worker:abcd1234', { action: 'stop' }, { action: 'stop', key: 'worker:unknown' }, { action: 'attach', key: 12 }, { action: 'attach', key: '' },
    { action: 'rm', key: 'worker:abcd1234' }, { action: 'stop', key: ['worker:abcd1234'] }, { kind: 'group', id: 'working', sessions: [] }, { action: 'toString', key: 'worker:abcd1234' }]) {
    await run('sessionAction', arg);
  }
  for (const id of ['attachSession', 'sessionLogs', 'stopSession', 'openSessionDiff', 'copySessionName']) {
    await run(id, undefined);
    await run(id, { key: 'worker:unknown' });
  }
  check('D1 unknown keys, unknown actions and malformed arguments do nothing', quiet() === 0 && fakeCalls().length === callsBefore && rec.clipboard.length === 0, `${quiet()} UI calls`);

  reset();
  await run('sessionAction', { action: 'attach', key: 'worker:abcd1234' });
  await run('sessionLogs', mk({}));
  check('D2 attach / logs open a terminal running `claude attach|logs <jobId>` under the worker\'s account', rec.terminals.length === 2 && rec.terminals[0].sent[0] === 'claude attach abcd1234'
    && rec.terminals[1].sent[0] === 'claude logs abcd1234' && rec.terminals.every((t) => t.opts.env.CLAUDE_CONFIG_DIR === W1 && t.opts.env.CLAUDECODE === null), rec.terminals.map((t) => t.sent[0]).join(' | '));
  reset();
  for (const key of ['worker:evil', 'worker:dash', 'worker:nodir', 'teammate:x', 'peer:nojob']) {
    await run('sessionAction', { action: 'attach', key });
    await run('sessionAction', { action: 'logs', key });
  }
  check('D3 a job id with shell metacharacters or a leading dash, a missing job id or a missing account → warning, NO terminal', rec.terminals.length === 0 && rec.messages.length === 10 && rec.messages.every((m) => m.level === 'warning'), `${rec.terminals.length} terminals, ${rec.messages.length} warnings`);

  reset();
  for (const key of ['teammate:x', 'teammate:jobbed', 'peer:nojob', 'worker:evil', 'worker:dash']) await run('sessionAction', { action: 'stop', key });
  check('D4 stop is refused for a teammate (even one carrying a job id), a peer without a job id and an invalid job id — no confirmation, no process', rec.messages.length === 5 && rec.messages.every((m) => m.level === 'warning' && !m.modal) && fakeCalls().length === callsBefore,
    rec.messages.map((m) => m.modal).join(','));

  // ledger record so the stop can be finished like a task cancel
  fs.mkdirSync(path.join(registry.ROOT_DIR, 'mesh'), { recursive: true });
  fs.writeFileSync(path.join(registry.ROOT_DIR, 'mesh', 'probe.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers: [
    { name: 'cco-w-0', account: 'other', configDir: W2, jobId: 'abcd1234', model: 'opus', role: 'dispatch', spawnedAt: 1 },
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'abcd1234', model: 'opus', role: 'dispatch', spawnedAt: 2, worktree: '.claude/worktrees/cco-1', branch: 'worktree-cco-t1' },
  ] }));
  if (readReg().claudePath !== FAKE_CLAUDE) throw new Error(`registry claudePath is not the fake CLI: ${readReg().claudePath}`);
  reset();
  await run('stopSession', mk({}));
  check('D5 stop asks with a MODAL; dismissing it runs nothing', rec.messages.length === 1 && rec.messages[0].modal === true && fakeCalls().length === callsBefore && ledgerCalls.marked.length === 0, JSON.stringify(rec.messages.map((m) => [m.modal, m.msg])));
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  const stopCall = fakeCalls().slice(callsBefore);
  check('D6 confirmed stop runs `claude stop <jobId>` as a child process (no terminal)', stopCall.length === 1 && JSON.stringify(stopCall[0].argv) === JSON.stringify(['stop', 'abcd1234']) && rec.terminals.length === 0, JSON.stringify(stopCall.map((c) => c.argv)));
  check('D7 that child ran as the worker\'s account with the host session\'s identity stripped', stopCall[0] && stopCall[0].env.CLAUDE_CONFIG_DIR === W1 && !('CLAUDECODE' in stopCall[0].env)
    && !('CLAUDE_CODE_MESSAGING_TOKEN' in stopCall[0].env) && !('CLAUDE_CODE_SESSION_ID' in stopCall[0].env) && !('CLAUDE_CODE_ENTRYPOINT' in stopCall[0].env),
    stopCall[0] && JSON.stringify(Object.keys(stopCall[0].env).filter((k) => k.startsWith('CLAUDE'))));
  check('D8 then the ledger mark and the `claude rm` teardown, for the record of THAT account (same job id exists under another)', ledgerCalls.marked.length === 1 && ledgerCalls.marked[0].name === 'cco-w-1' && ledgerCalls.marked[0].cwd === WS && ledgerCalls.marked[0].jobId === 'abcd1234'
    && ledgerCalls.removed.length === 1 && ledgerCalls.removed[0].jobId === 'abcd1234' && ledgerCalls.removed[0].configDir === W1, JSON.stringify(ledgerCalls));
  check('D9 a KEPT worktree is reported to the user', rec.messages.some((m) => m.level === 'info' && /KEPT/.test(m.msg)), rec.messages.map((m) => m.msg).join(' | '));

  // the CLI refuses the stop
  fs.writeFileSync(FAKE_MODE, 'fail');
  ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  const failMsg = rec.messages.find((m) => m.level === 'error');
  check('D16 a stop the CLI refuses is reported, and the ledger is NOT marked stopped (the session may still be alive)', failMsg !== undefined && /exited with code 1/.test(failMsg.msg) && /No such job/.test(failMsg.msg)
    && ledgerCalls.marked.length === 0 && ledgerCalls.removed.length === 0, failMsg && JSON.stringify(failMsg.msg));
  check('D17 the CLI\'s own words are quoted flattened: no escape or bidi-override characters reach the message', failMsg !== undefined && !/[\u001b\u202e\n]/.test(failMsg.msg));
  // a grandchild holds the pipes open after the CLI exits
  fs.writeFileSync(FAKE_MODE, 'hold');
  reset();
  answers.message.push((items) => items[0]);
  const holdStart = Date.now();
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  check('D18 a CLI whose child keeps the pipes open does not hang the stop (settles on exit)', Date.now() - holdStart < 3000 && rec.messages.some((m) => m.level === 'info' && /^Stopped session/.test(m.msg)) && ledgerCalls.marked.length === 1,
    `${Date.now() - holdStart} ms`);
  fs.rmSync(FAKE_MODE, { force: true });

  // a worker whose dispatch is STILL RUNNING: the stop must be recorded as a user cancel
  fs.mkdirSync(registry.ROOT_DIR, { recursive: true });
  // `liveOut` is the path the task's log line NAMES for its output; its report is the file its ID names,
  // <tasks dir>/tabc1234.md. Since 2.0 nothing opens the path a log line names.
  const liveOut = path.join(SANDBOX, 'inflight.md');
  fs.writeFileSync(liveOut, 'partial');
  const liveReport = path.join(registry.TASKS_DIR, 'tabc1234.md');
  fs.mkdirSync(registry.TASKS_DIR, { recursive: true });
  fs.writeFileSync(liveReport, 'partial');
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'running', title: 'Build the thing', worker: 'w1', model: 'opus', outputFile: liveOut, cwd: WS, meshWorker: 'cco-w-1' })}\n`);
  // ...and the ledger also holds an OLDER, stopped worker that reused the same name
  fs.writeFileSync(path.join(registry.ROOT_DIR, 'mesh', 'probe.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers: [
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'dead0000', model: 'opus', role: 'dispatch', spawnedAt: 1, stoppedAt: 5, taskId: 'told00001' },
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'abcd1234', model: 'opus', role: 'dispatch', spawnedAt: 9, taskId: 'tabc1234', worktree: '.claude/worktrees/cco-1', branch: 'worktree-cco-t1' },
  ] }));
  ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
  const inflightBefore = fakeCalls().length;
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  const inflightCalls = fakeCalls().slice(inflightBefore);
  const inflightEvents = fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const inflightLast = inflightEvents[inflightEvents.length - 1];
  check('D19 stopping a worker whose dispatch is still running records the task as CANCELLED BY USER (one terminal event)', inflightEvents.length === 2 && inflightLast.id === 'tabc1234' && inflightLast.status === 'error' && inflightLast.error === 'cancelled by user',
    JSON.stringify(inflightEvents.map((e) => [e.status, e.error])));
  check('D20 it stops the job of THAT task, not the older stopped worker that reused the name — exactly one `claude stop`', inflightCalls.length === 1 && inflightCalls[0].argv.join(' ') === 'stop abcd1234' && ledgerCalls.removed.length === 1 && ledgerCalls.removed[0].jobId === 'abcd1234',
    JSON.stringify(inflightCalls.map((c) => c.argv)));
  check('D21 the user is told both things, and the KEPT worktree', rec.messages.some((m) => m.level === 'info' && /recorded its running task as cancelled/.test(m.msg) && /KEPT/.test(m.msg)), rec.messages.map((m) => m.msg).join(' | '));
  // [2.0: was "noted in the task output file" = the file the log line names (liveOut)]
  check('D22 the cancellation is noted in the task\'s REPORT — the file its id names in the tasks directory — and the path its log line names is not written to',
    /^partial[\s\S]*CANCELLED: cancelled by user/.test(fs.readFileSync(liveReport, 'utf8')) && fs.readFileSync(liveOut, 'utf8') === 'partial', JSON.stringify([fs.readFileSync(liveReport, 'utf8').slice(0, 80), fs.readFileSync(liveOut, 'utf8')]));
  // in flight, but the CLI refuses: the task row is closed, the failure is still reported
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'running', title: 'Build the thing', worker: 'w1', model: 'opus', outputFile: liveOut, cwd: WS, meshWorker: 'cco-w-1' })}\n`);
  fs.writeFileSync(FAKE_MODE, 'fail');
  ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  fs.rmSync(FAKE_MODE, { force: true });
  check('D23 in flight and the CLI refuses the stop → an ERROR is shown and the ledger is not marked', rec.messages.some((m) => m.level === 'error' && /Could not stop session/.test(m.msg)) && ledgerCalls.marked.length === 0, rec.messages.map((m) => `${m.level}: ${m.msg}`).join(' | '));
  check('D24 a refused stop is not retried on the same job', fakeCalls().filter((c) => c.argv.join(' ') === 'stop abcd1234').length === fakeCalls().slice(0, inflightBefore).filter((c) => c.argv.join(' ') === 'stop abcd1234').length + 2,
    `${fakeCalls().length - inflightBefore} stop calls since the in-flight probes began (1 for D19, 1 for D23)`);
  // in flight, but the ledger no longer names the worker: the task is closed AND the session is still stopped by its job id
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'running', title: 'Build the thing', worker: 'w1', model: 'opus', outputFile: liveOut, cwd: WS, meshWorker: 'cco-w-1' })}\n`);
  fs.writeFileSync(path.join(registry.ROOT_DIR, 'mesh', 'probe.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers: [] }));
  const orphanBefore = fakeCalls().length;
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  const orphanEvents = fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('D25 in flight with no ledger record: the task is recorded cancelled and the session is still stopped by its own job id', orphanEvents[orphanEvents.length - 1].error === 'cancelled by user'
    && fakeCalls().slice(orphanBefore).map((c) => c.argv.join(' ')).join(',') === 'stop abcd1234' && rec.messages.some((m) => m.level === 'info' && /recorded its running task as cancelled/.test(m.msg)),
    JSON.stringify(fakeCalls().slice(orphanBefore).map((c) => c.argv)));
  // failover: the task is now running on a SECOND worker; stopping the first must not cancel it
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'running', title: 'Build the thing', worker: 'w1,w2', model: 'opus', outputFile: liveOut, cwd: WS, meshWorker: 'cco-w-2' })}\n`);
  reset();
  answers.message.push((items) => items[0]);
  await run('sessionAction', { action: 'stop', key: 'worker:abcd1234' });
  const failoverEvents = fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('D26 stopping a worker whose task has failed over to ANOTHER worker stops only that session; the task stays running', failoverEvents.length === 1 && failoverEvents[0].status === 'running'
    && rec.messages.some((m) => m.level === 'info' && /^Stopped session "cco-w-1"\.$/.test(m.msg)), JSON.stringify([failoverEvents.map((e) => e.status), rec.messages.map((m) => m.msg)]));
  // put the ledger back for the probes that follow
  fs.writeFileSync(path.join(registry.ROOT_DIR, 'mesh', 'probe.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers: [
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'dead0000', model: 'opus', role: 'dispatch', spawnedAt: 1, stoppedAt: 5, taskId: 'told00001' },
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'abcd1234', model: 'opus', role: 'dispatch', spawnedAt: 9, taskId: 'tabc1234', worktree: '.claude/worktrees/cco-1', branch: 'worktree-cco-t1' },
  ] }));
  fs.writeFileSync(registry.TASKS_LOG_FILE, '');

  reset();
  await run('copySessionName', mk({}));
  check('D10 copyName puts the session name on the clipboard', rec.clipboard.length === 1 && rec.clipboard[0] === 'cco-w-1');

  // openDiff against a real temp repository
  const git = (...a) => execFileSync('git', ['-C', WS, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(WS, 'a.txt'), 'one\n');
  git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'worktree-cco-t1');
  fs.writeFileSync(path.join(WS, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'work');
  git('checkout', '-q', 'main');
  reset();
  await run('openSessionDiff', mk({}));
  const diffUri = rec.openedDocs[0];
  const diffText = diffUri && rec.contentProviders[diffUri.scheme].provideTextDocumentContent(diffUri);
  check('D11 openDiff opens a read-only document holding `git diff HEAD...<branch>`', rec.openedDocs.length === 1 && diffUri.scheme === 'cco-session-diff' && /^\+two$/m.test(diffText) && /\.diff$/.test(diffUri.path), diffUri && `${diffUri.scheme}:${diffUri.path}?${diffUri.query}`);
  check('D12 the diff provider serves nothing for an id it did not issue', rec.contentProviders['cco-session-diff'].provideTextDocumentContent({ scheme: 'cco-session-diff', path: '/x.diff', query: '999' }) === ''
    && rec.contentProviders['cco-session-diff'].provideTextDocumentContent({ scheme: 'cco-session-diff', path: '/x.diff', query: '__proto__' }) === '');
  reset();
  for (const key of ['worker:badbranch', 'worker:dotdot', 'teammate:x']) await run('sessionAction', { action: 'openDiff', key });
  check('D13 a branch that looks like an option, contains "..", or is absent → refused before git runs', rec.openedDocs.length === 0 && rec.messages.length === 3 && rec.messages.every((m) => m.level === 'warning') && !fs.existsSync('/tmp/pwned'), rec.messages.map((m) => m.msg).join(' | '));
  reset();
  await run('sessionAction', { action: 'openDiff', key: 'worker:nobranch' });
  check('D14 a branch that does not exist in the repository → warning, nothing opened', rec.openedDocs.length === 0 && rec.messages.length === 1 && /was not found/.test(rec.messages[0].msg), rec.messages[0] && rec.messages[0].msg);

  reset();
  answers.quickPick.push((items) => items.find((i) => i.action === 'copyName'));
  await run('sessionAction', mk({ canStop: false, branch: null }));
  check('D15 sessionAction with a tree row and no action offers only that row\'s actions', rec.quickPicks.length === 1 && JSON.stringify(rec.quickPicks[0].items.map((i) => i.action)) === JSON.stringify(['attach', 'logs', 'copyName']) && rec.clipboard.length === 1,
    JSON.stringify(rec.quickPicks[0] && rec.quickPicks[0].items.map((i) => i.action)));

  /* ============================================================== E. Team tree */
  const provider = rec.treeViews['claudeCodeOrchestrator.team'].opts.treeDataProvider;
  team.sessions = [];
  check('E1 no sessions → no rows (VS Code then shows the welcome text)', provider.getChildren().length === 0);
  check('E2 the collector is asked for this workspace', team.lastOpts.workspaceRoot === WS && team.lastOpts.scope === 'workspace', JSON.stringify(team.lastOpts));
  const EVIL = '[click](command:workbench.action.terminal.new) ![x](http://evil/x.png) `rm` <b>**bold**</b>';
  team.sessions = [
    mk({ key: 'worker:1', status: 'idle', name: 'parked-one', settled: true }),
    mk({ key: 'teammate:1', source: 'teammate', kind: 'teammate', status: 'unknown', name: 'mate', taskTitle: null, taskId: null, role: 'reviewer', team: 'alpha', canAttach: false, canStop: false, branch: null }),
    mk({ key: 'worker:2', status: 'busy', name: EVIL, accountName: EVIL, taskTitle: EVIL, detail: EVIL, model: EVIL, location: EVIL, branch: EVIL }),
    mk({ key: 'peer:1', source: 'peer', kind: 'interactive', status: 'waiting', name: 'panel', taskTitle: null, taskId: null, canAttach: false, canStop: false, branch: null, detail: 'permission to run Bash' }),
    mk({ key: 'worker:3', status: 'stopped', name: 'gone', canAttach: false, canStop: false }),
    null, 'x', { key: 5 }, { key: 'k', name: 'n' },
  ];
  const groups = provider.getChildren();
  check('E3 groups are Working / Waiting / Parked, in that order, only when non-empty; malformed rows are dropped', groups.map((g) => `${g.id}:${g.sessions.length}`).join(' ') === 'working:1 waiting:1 parked:3', groups.map((g) => `${g.id}:${g.sessions.length}`).join(' '));
  const items = Object.fromEntries(groups.flatMap((g) => provider.getChildren(g)).map((s) => [s.key, provider.getTreeItem(s)]));
  check('E4 contextValue is session.<source> plus .attachable / .stoppable / .branch', items['worker:1'].contextValue === 'session.worker.attachable.stoppable.branch' && items['teammate:1'].contextValue === 'session.teammate'
    && items['peer:1'].contextValue === 'session.peer' && items['worker:3'].contextValue === 'session.worker.branch', Object.values(items).map((i) => i.contextValue).join(' | '));
  check('E5 description is "account · task title or role"; stopped / unknown say so', items['worker:1'].description === 'w1 · Build the thing' && items['teammate:1'].description === 'w1 · reviewer · status unknown'
    && items['worker:3'].description === 'w1 · Build the thing · stopped' && items['peer:1'].description === 'w1', Object.values(items).map((i) => i.description).join(' | '));
  const evilTip = items['worker:2'].tooltip;
  const mdWithEvil = evilTip.segments.filter((s) => s.kind === 'md' && /click|evil|rm|bold/.test(s.value));
  check('E6 hostile strings reach the tooltip only through appendText (escaped), never as markdown', mdWithEvil.length === 0 && !/\]\(command:/.test(evilTip.value) && evilTip.value.includes('\\[click\\]\\(command:'), JSON.stringify(mdWithEvil));
  check('E7 the tooltip is not marked trusted and does not enable HTML', evilTip.isTrusted !== true && evilTip.supportHtml !== true);
  check('E8 icons carry status by shape', items['worker:2'].iconPath.id === 'sync~spin' && items['peer:1'].iconPath.id === 'bell-dot' && items['worker:3'].iconPath.id === 'circle-slash' && items['teammate:1'].iconPath.id === 'question' && items['worker:1'].iconPath.id === 'server-process',
    Object.values(items).map((i) => i.iconPath.id).join(' '));
  team.collectThrows = true;
  let treeThrew;
  let afterThrow;
  try { afterThrow = provider.getChildren(); } catch (e) { treeThrew = e; }
  team.collectThrows = false;
  check('E9 a collector that throws renders as an empty view, not a tree error', treeThrew === undefined && afterThrow.length === 0);

  // refresh behaviour
  const view = rec.treeViews['claudeCodeOrchestrator.team'];
  const emitter = provider._onDidChangeTreeData;
  timers.length = 0;
  captureTimers(true);
  view._vis.fire({ visible: true });
  captureTimers(false);
  const poll = timers.find((t) => t.kind === 'interval');
  check('E10 becoming visible refreshes and starts a 5 s poll', poll !== undefined && poll.ms === 5000 && emitter.fired >= 1, `interval ${poll && poll.ms} ms`);
  provider.getChildren();
  let fired = emitter.fired;
  poll.fn(); poll.fn();
  check('E11 a poll that finds nothing visible changed does not redraw', emitter.fired === fired, `${emitter.fired - fired} extra fires`);
  team.sessions = [...team.sessions.slice(0, 5).map((s) => ({ ...s, updatedAt: Date.now() + 999 }))];
  poll.fn();
  check('E12 a heartbeat-only change (updatedAt) does not redraw', emitter.fired === fired, `${emitter.fired - fired} extra fires`);
  team.sessions = team.sessions.map((s, i) => (i === 0 ? { ...s, status: 'busy' } : s));
  poll.fn();
  check('E13 a status change redraws', emitter.fired === fired + 1, `${emitter.fired - fired} fires`);
  const ledgerWatch = watched.find((w) => w.file.startsWith(path.join(registry.ROOT_DIR, 'mesh')) && w.listener === provider.onLedgerChange);
  const taskWatch = watched.find((w) => w.file === registry.TASKS_LOG_FILE && w.listener === provider.onTasksChange);
  fired = emitter.fired;
  const inval = team.invalidations;
  ledgerWatch.listener(); taskWatch.listener();
  check('E14 a ledger or task-log change drops the collector cache and redraws', ledgerWatch !== undefined && taskWatch !== undefined && emitter.fired === fired + 2 && team.invalidations === inval + 2);
  view._vis.fire({ visible: false });
  fired = emitter.fired;
  taskWatch.listener();
  check('E15 hidden: the poll is cleared and a file change does not redraw', poll.cleared === true && emitter.fired === fired);

  /* =========================================================== F. other commands */
  fs.mkdirSync(registry.ROOT_DIR, { recursive: true });
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'done', title: 't', worker: 'w1', model: 'opus', outputFile: '/nope', cwd: WS })}\n`);
  reset();
  await run('clearTasks');
  check('F1 clearTasks asks with a MODAL; dismissing keeps the log', rec.messages.length === 1 && rec.messages[0].modal === true && fs.statSync(registry.TASKS_LOG_FILE).size > 0);
  answers.message.push((items) => items[0]);
  await run('clearTasks');
  check('F2 confirming truncates the task log', fs.statSync(registry.TASKS_LOG_FILE).size === 0);

  // Since 2.0 both commands take a task ID (bare, or as { id }) and open the report that id names in the tasks
  // directory — registry.resolveTaskFile — never a path from the caller, the log, or (as before) the page model.
  // `outFile` stays what uiModel.resolveTaskOutput (stubbed by the harness) would answer: it must not be opened.
  const outFile = path.join(SANDBOX, 'task-output.md');
  fs.writeFileSync(outFile, 'report');
  outputs.set('tabc1234', outFile);
  const REPORT = path.join(registry.TASKS_DIR, 'tabc1234.md');
  fs.mkdirSync(registry.TASKS_DIR, { recursive: true });
  fs.writeFileSync(REPORT, 'the report');
  const NOT_FOUND = 'The output of that task could not be found.';
  const refusedArgs = [undefined, null, {}, { id: '/etc/passwd' }, { id: '../../etc/passwd' }, { id: outFile }, { id: ['tabc1234'] }, { id: 'tunknown99' }, { outputFile: '/etc/passwd' }, '/etc/passwd', outFile, REPORT, 'tabc1234.md', '../tasks/tabc1234', 7, ['tabc1234']];
  reset();
  for (const arg of refusedArgs) await run('openTaskOutput', arg);
  // [2.0: was "opens nothing … rec.messages.length === 0" — silently; and the bare string 'tabc1234' was among the refused]
  check('F3 openTaskOutput opens nothing for an unknown id, a path (in an object or bare, even the report\'s own path), or a malformed argument — and SAYS so each time',
    rec.openedDocs.length === 0 && rec.shownDocs.length === 0 && rec.messages.length === refusedArgs.length && rec.messages.every((m) => m.level === 'warning' && m.msg === NOT_FOUND && m.modal === false),
    `${rec.openedDocs.length} opened, ${rec.messages.length} messages for ${refusedArgs.length} arguments: ${[...new Set(rec.messages.map((m) => m.msg))].join(' | ')}`);
  reset();
  await run('openTaskOutput', { id: 'tabc1234' });
  // [2.0: was fsPath === outFile, the path the (stubbed) page model resolved]
  check('F4 a known id opens the report its id names in the tasks directory, beside the active editor — not the path another resolver would give',
    rec.openedDocs.length === 1 && rec.openedDocs[0].fsPath === REPORT && rec.shownDocs.length === 1 && rec.shownDocs[0].opts.viewColumn === vscode.ViewColumn.Beside && rec.shownDocs[0].opts.preview === true && rec.messages.length === 0,
    JSON.stringify([rec.openedDocs.map((d) => d.fsPath), rec.shownDocs.map((d) => d.opts)]));
  reset();
  await run('openTaskOutput', 'tabc1234');
  check('F4b the bare id is the same request (a tree row hands the command its id)', rec.openedDocs.length === 1 && rec.openedDocs[0].fsPath === REPORT && rec.messages.length === 0, JSON.stringify(rec.openedDocs.map((d) => d.fsPath)));
  // a symbolic link standing where the report should be is not a report
  fs.rmSync(REPORT);
  fs.symlinkSync(outFile, REPORT);
  reset();
  await run('openTaskOutput', { id: 'tabc1234' });
  check('F4c a symbolic link at the report\'s name is refused: nothing opened, and said', rec.openedDocs.length === 0 && rec.messages.length === 1 && rec.messages[0].msg === NOT_FOUND, `${rec.openedDocs.length} opened`);
  fs.rmSync(REPORT);
  fs.writeFileSync(REPORT, 'the report');

  // installTeamAgent
  const agentFile = path.join(WS, teamAgent.TEAM_AGENT_FILE);
  reset();
  await run('installTeamAgent');
  check('F5 installTeamAgent writes the definition when nothing is there', fs.readFileSync(agentFile, 'utf8') === teamAgent.TEAM_AGENT_MD, rec.messages.map((m) => m.msg).join(' | '));
  // Contract §15.7 Nags (wave 11): a folder that cannot dispatch is pointed at Update Workspace Setup, not MCP registration (EXPECTATION-CHANGES §10).
  check('F6 and points out that this workspace cannot dispatch yet, offering Update Workspace Setup', rec.messages.length === 1 && rec.messages[0].items.length === 1 && /cannot dispatch yet/.test(rec.messages[0].msg) && rec.messages[0].items[0] === 'Update Workspace Setup');
  reset();
  await run('installTeamAgent');
  check('F7 running it again reports "already up to date"', /already up to date/.test(rec.messages[0].msg) && fs.readFileSync(agentFile, 'utf8') === teamAgent.TEAM_AGENT_MD);
  fs.writeFileSync(agentFile, teamAgent.TEAM_AGENT_MD.replace('dispatch proxy', 'older wording'));
  reset();
  await run('installTeamAgent');
  check('F8a [NEW for W5 SHELL-A] a copy of OUR definition that differs is NOT replaced on its own: a modal asks (Replace), and dismissing it leaves the file as it was',
    rec.messages.length === 1 && rec.messages[0].modal === true && JSON.stringify(rec.messages[0].items) === JSON.stringify(['Replace']) && fs.readFileSync(agentFile, 'utf8') === teamAgent.TEAM_AGENT_MD.replace('dispatch proxy', 'older wording'), JSON.stringify(rec.messages.map((m) => [m.modal, m.msg, m.items])));
  reset();
  answers.message.push((items) => items[0]);
  await run('installTeamAgent');
  check('F8 [UPDATED for W5 SHELL-A] an older copy of OUR definition is upgraded in place once the user confirms', fs.readFileSync(agentFile, 'utf8') === teamAgent.TEAM_AGENT_MD);
  const foreign = '---\nname: cco-worker\n---\nmy own agent\n';
  fs.writeFileSync(agentFile, foreign);
  reset();
  await run('installTeamAgent');
  check('F9 a DIFFERENT agent at that path is left untouched and the user is told', fs.readFileSync(agentFile, 'utf8') === foreign && rec.messages.length === 1 && rec.messages[0].level === 'warning' && /different agent/.test(rec.messages[0].msg), rec.messages[0] && rec.messages[0].msg);
  // symlink (dangling, and to a blank file elsewhere): never written through
  const outside = path.join(SANDBOX, 'outside.md');
  for (const [label, prepare] of [['dangling', () => {}], ['to a blank file', () => fs.writeFileSync(outside, '')], ['to our own definition', () => fs.writeFileSync(outside, teamAgent.TEAM_AGENT_MD.replace('dispatch proxy', 'older'))]]) {
    fs.rmSync(agentFile, { force: true }); fs.rmSync(outside, { force: true });
    prepare();
    const beforeOutside = fs.existsSync(outside) ? fs.readFileSync(outside, 'utf8') : null;
    fs.symlinkSync(outside, agentFile);
    reset();
    await run('installTeamAgent');
    const afterOutside = fs.existsSync(outside) ? fs.readFileSync(outside, 'utf8') : null;
    check(`F10 a symlink at the agent path (${label}) is never written through`, afterOutside === beforeOutside && fs.lstatSync(agentFile).isSymbolicLink() && rec.messages[0].level === 'warning', `outside: ${JSON.stringify(afterOutside && afterOutside.slice(0, 20))}`);
  }
  fs.rmSync(agentFile, { force: true });
  fs.mkdirSync(agentFile);
  reset();
  await run('installTeamAgent');
  check('F11 a directory at the agent path → nothing written, user told', fs.statSync(agentFile).isDirectory() && rec.messages[0].level === 'warning');
  fs.rmdirSync(agentFile);
  execFileSync('/usr/bin/mkfifo', [agentFile]);
  reset();
  const fifoStart = Date.now();
  await run('installTeamAgent');
  check('F12 a FIFO at the agent path does not hang the command and is left alone', Date.now() - fifoStart < 2000 && fs.lstatSync(agentFile).isFIFO() && rec.messages[0].level === 'warning', `${Date.now() - fifoStart} ms`);
  fs.rmSync(agentFile, { force: true });
  fs.writeFileSync(agentFile, 'x'.repeat(300 * 1024));
  reset();
  await run('installTeamAgent');
  check('F13 an oversized file at the agent path is not ours and is left alone', fs.statSync(agentFile).size === 300 * 1024 && rec.messages[0].level === 'warning');
  fs.rmSync(agentFile, { force: true });
  fs.writeFileSync(agentFile, '  \n');
  await run('installTeamAgent');
  check('F14 a blank file is replaced', fs.readFileSync(agentFile, 'utf8') === teamAgent.TEAM_AGENT_MD);

  reset();
  registry.recordOrchestrator(WS, 'opus');
  await run('resetCheckin');
  check('F15a [NEW for W5 SHELL-A] resetCheckin asks in a modal first, and a dismissed one keeps the check-in', (WS in registry.readOrchestrators()) && rec.messages.length === 1 && rec.messages[0].modal === true && JSON.stringify(rec.messages[0].items) === JSON.stringify(['Reset Check-in']), JSON.stringify(rec.messages.map((m) => [m.modal, m.msg, m.items])));
  reset();
  answers.message.push((items) => items[0]);
  await run('resetCheckin');
  check('F15 [UPDATED for W5 SHELL-A] resetCheckin, confirmed, drops this workspace\'s check-in', !(WS in registry.readOrchestrators()) && rec.messages[1].level === 'info');
  await run('openDashboard');
  check('F16 openDashboard passes the extension context', dashboardCalls.length === 1 && dashboardCalls[0][0] === context);
  reset();
  await run('openSettings');
  check('F17 openSettings opens the Settings UI filtered to this extension', rec.executed.some((e) => e.id === 'workbench.action.openSettings' && e.args[0] === `@ext:${EXTENSION_ID}`) && /^[a-z0-9-]+\.[a-z0-9-]+$/.test(EXTENSION_ID), JSON.stringify(rec.executed));
  reset();
  // [2.0: was "ignores a non-string argument" — nothing opened and nothing said; a STRING was a path it opened]
  const showRefused = [undefined, null, 7, {}, ['/etc/passwd'], '/etc/passwd', outFile, REPORT, { id: outFile }];
  for (const arg of showRefused) await run('showTaskOutput', arg);
  check('F18 showTaskOutput takes a task id, not a path: a non-id argument or any path opens nothing, and is said',
    rec.openedDocs.length === 0 && rec.messages.length === showRefused.length && rec.messages.every((m) => m.level === 'warning' && m.msg === NOT_FOUND), `${rec.openedDocs.length} opened, ${rec.messages.length} messages`);
  reset();
  await run('showTaskOutput', 'tabc1234');
  check('F18b showTaskOutput with a task id opens that task\'s report in the active editor group', rec.openedDocs.length === 1 && rec.openedDocs[0].fsPath === REPORT && rec.shownDocs.length === 1 && rec.shownDocs[0].opts.preview === true && !('viewColumn' in rec.shownDocs[0].opts) && rec.messages.length === 0,
    JSON.stringify([rec.openedDocs.map((d) => d.fsPath), rec.shownDocs.map((d) => d.opts)]));

  // Workers tree: accounts only, even with Mesh Mode on; config dir escaped in the tooltip
  const evilDir = path.join(HOME, '.claude-[x](command:evil)');
  registry.updateRegistry((r) => { r.workers.push({ name: 'md', configDir: evilDir, model: 'opus' }); });
  const wp = rec.providers['claudeCodeOrchestrator.workers'];
  const roots = wp.getChildren();
  check('F19 Workers tree root = registry accounts only (Mesh Mode is on)', settings.meshMode === true && roots.length === 2 && roots.every((r) => typeof r.configDir === 'string' && r.kind === undefined), roots.map((r) => r.name).join(','));
  const wtip = wp.getTreeItem(roots.find((r) => r.name === 'md')).tooltip;
  check('F20 the config dir reaches the tooltip through appendText', wtip.segments.some((s) => s.kind === 'text' && s.value.includes(evilDir)) && !wtip.segments.some((s) => s.kind === 'md' && s.value.includes('command:evil')) && !/\]\(command:evil\)/.test(wtip.value));

  // path boundary
  const root = path.join(SANDBOX, 'app');
  check('F21 isInsideDir is a path-boundary test', views.isInsideDir(root, root) && views.isInsideDir(root, path.join(root, 'src', 'x')) && views.isInsideDir(root + path.sep, path.join(root, 'a'))
    && !views.isInsideDir(root, `${root}-old`) && !views.isInsideDir(root, path.join(root, '..', 'other')) && !views.isInsideDir(root, undefined) && !views.isInsideDir(root, '') && !views.isInsideDir('', root) && !views.isInsideDir(root, 7));
  check('F22 isJobId', views.isJobId('abcd1234') && views.isJobId('A-b_9') && !views.isJobId('-abc') && !views.isJobId('a b') && !views.isJobId('a;b') && !views.isJobId('') && !views.isJobId('x'.repeat(65)) && !views.isJobId(undefined) && !views.isJobId('a\nb') && !views.isJobId('$(id)'));

  // history view: guarded prompt read
  const hp = rec.providers['claudeCodeOrchestrator.workerHistory'];
  const fifo = path.join(SANDBOX, 'prompt.fifo');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  const big = path.join(SANDBOX, 'prompt.big');
  fs.writeFileSync(big, 'B'.repeat(200 * 1024));
  const small = path.join(SANDBOX, 'prompt.small');
  fs.writeFileSync(small, 'FULL PROMPT TEXT');
  // Since 2.0 a row of this tree is a row of the shared task index (never an event handed in), its hover is
  // built on demand (resolveTreeItem), and the prompt shown is the file the task's ID names in the tasks
  // directory — `<id>.prompt.txt` — never the `promptFile` path its log line records. So each case below puts
  // its file AT that name; the three files in the sandbox stay what the log line names, and must not be read.
  const PROMPT = path.join(registry.TASKS_DIR, 'tabc1234.prompt.txt');
  const decoy = path.join(SANDBOX, 'prompt.decoy');
  fs.writeFileSync(decoy, 'DECOY: THE PATH THE LOG LINE NAMES');
  fs.writeFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'tabc1234', status: 'done', title: 't', worker: 'w1', model: 'opus', outputFile: outFile, cwd: WS, meshWorker: 'cco-w-1', promptPreview: 'PREVIEW', promptFile: decoy })}\n`);
  const histRow = () => hp.getChildren().find((r) => r.id === 'tabc1234');
  const tipText = () => hovered(hp, histRow()).tooltip.segments.filter((s) => s.kind === 'text').map((s) => s.value).join('\n');
  const atPrompt = (make) => { fs.rmSync(PROMPT, { force: true }); make(); };
  {
    const drawn = hp.getTreeItem(histRow());
    check('F22b a history row is drawn without a tooltip (the hover is built on demand) and its command carries the task ID, not a path',
      drawn.tooltip === undefined && drawn.command.command === 'claudeCodeOrchestrator.showTaskOutput' && JSON.stringify(drawn.command.arguments) === JSON.stringify(['tabc1234']), JSON.stringify(drawn.command));
  }
  atPrompt(() => undefined);
  check('F22c with no prompt file at the id\'s name the hover shows the preview — and never the file the log line names', tipText().includes('PREVIEW') && !tipText().includes('DECOY'), tipText().slice(0, 80));
  atPrompt(() => execFileSync('/usr/bin/mkfifo', [PROMPT]));
  const t0 = Date.now();
  const fifoTip = tipText();
  check('F23 history tooltip: a FIFO as the prompt file does not block and falls back to the preview', Date.now() - t0 < 2000 && fifoTip.includes('PREVIEW') && !fifoTip.includes('DECOY'), `${Date.now() - t0} ms`);
  atPrompt(() => fs.copyFileSync(big, PROMPT));
  check('F24 history tooltip: a prompt file over 128 KiB falls back to the preview', tipText().includes('PREVIEW') && !tipText().includes('BBBB'));
  atPrompt(() => fs.copyFileSync(small, PROMPT));
  check('F25 history tooltip: a normal prompt file is shown in full', tipText().includes('FULL PROMPT TEXT') && !tipText().includes('PREVIEW'));
  atPrompt(() => fs.symlinkSync(small, PROMPT));
  check('F25b history tooltip: a symbolic link at the prompt\'s name is not followed — the preview is shown', tipText().includes('PREVIEW') && !tipText().includes('FULL PROMPT TEXT'));
  atPrompt(() => undefined);
  // history / tasks scoping with a sibling-prefix workspace
  fs.writeFileSync(registry.TASKS_LOG_FILE, [
    { ts: 3, id: 'tin000001', status: 'done', title: 'in', worker: 'w1', model: 'opus', outputFile: outFile, cwd: path.join(WS, 'pkg'), meshWorker: 'a' },
    { ts: 2, id: 'tsib00001', status: 'done', title: 'sibling', worker: 'w1', model: 'opus', outputFile: outFile, cwd: `${WS}-old`, meshWorker: 'b' },
    { ts: 1, id: 'tout00001', status: 'done', title: 'out', worker: 'w1', model: 'opus', outputFile: outFile, cwd: '/elsewhere', meshWorker: 'c' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const tp = rec.treeViews['claudeCodeOrchestrator.tasks'].opts.treeDataProvider;
  check('F26 Tasks and History scope to the workspace on a path boundary (a sibling "<ws>-old" is out)', tp.getChildren().map((e) => e.title).join(',') === 'in' && hp.getChildren().map((e) => e.title).join(',') === 'in',
    `tasks: ${tp.getChildren().map((e) => e.title)}; history: ${hp.getChildren().map((e) => e.title)}`);

  await run('clearStoppedWorkers');
  check('F27 clearStoppedWorkers still clears this workspace\'s stopped records', ledgerCalls.cleared.length === 1 && ledgerCalls.cleared[0] === WS);

  // cancelTask argument handling
  reset();
  const cancelCallsBefore = fakeCalls().length;
  for (const arg of [{}, { id: 7 }, { id: '' }, { id: ['tin000001'] }, 'tin000001', 7, [], { title: 'x' }]) await run('cancelTask', arg);
  check('G1 cancelTask with an argument that names no task id cancels nothing and opens no picker', rec.quickPicks.length === 0 && rec.messages.length === 0 && fakeCalls().length === cancelCallsBefore, `${rec.quickPicks.length} pickers, ${rec.messages.length} messages`);
  reset();
  await run('cancelTask');
  check('G2 cancelTask with no argument and nothing running says so', rec.messages.length === 1 && rec.messages[0].msg === 'No running dispatches.');
  reset();
  await run('cancelTask', { id: 'tnever0001' });
  check('G3 cancelTask for an id that is not running reports that, and writes no event', rec.messages.length === 1 && /no longer running/.test(rec.messages[0].msg)
    && fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).length === 3, rec.messages[0] && rec.messages[0].msg);
  reset();
  await run('cancelAllTasks');
  check('G4 cancelAllTasks with nothing running asks nothing', rec.messages.length === 1 && !rec.messages[0].modal && rec.messages[0].msg === 'No running dispatches.');
  // a running session-worker task: cancel stops it by job id through the same child-process path
  fs.appendFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'trun000001', status: 'running', title: 'live', worker: 'w1', model: 'opus', outputFile: path.join(SANDBOX, 'live.md'), cwd: WS, meshWorker: 'cco-w-1' })}\n`);
  ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
  reset();
  await run('cancelAllTasks');
  check('G5 cancelAllTasks is modal; dismissing cancels nothing', rec.messages.length === 1 && rec.messages[0].modal === true && fakeCalls().length === cancelCallsBefore);
  reset();
  await run('cancelTask', { id: 'trun000001' });
  const cancelCall = fakeCalls().slice(cancelCallsBefore);
  const lastEvent = JSON.parse(fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).pop());
  // K-SHELL (K8): the ledger here holds a STOPPED 'cco-w-1' (task told00001) and a LIVE 'cco-w-1' whose record
  // names ANOTHER task (tabc1234). Neither is this task's worker: the name is not the join. The original G6
  // expected the live one to be stopped by name; that is the defect K8 is about, on the one path where the
  // wrong join ends somebody's session.
  check('G6 [UPDATED for K8] cancelling a running session-worker task whose name is carried only by records of OTHER tasks stops NOTHING: no `claude stop`, no ledger mark, the task recorded cancelled, and the user told the worker was not stopped',
    cancelCall.length === 0 && lastEvent.id === 'trun000001' && lastEvent.status === 'error' && /^cancelled/.test(lastEvent.error)
    && ledgerCalls.marked.length === 0 && ledgerCalls.removed.length === 0
    && rec.messages.length === 1 && rec.messages[0].level === 'warning' && /session worker was not stopped: no job id in the mesh ledger/.test(rec.messages[0].msg),
    JSON.stringify([cancelCall.map((c) => c.argv), lastEvent.status, lastEvent.error, ledgerCalls.marked, rec.messages.map((m) => [m.level, m.msg])]));
  // ...and the case the name fallback is FOR: the only live record of that name carries no task id at all
  // (an adopted worker, a ledger written before the field existed).
  fs.writeFileSync(path.join(registry.ROOT_DIR, 'mesh', 'probe.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers: [
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'dead0000', model: 'opus', role: 'dispatch', spawnedAt: 1, stoppedAt: 5, taskId: 'told00001' },
    { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'abcd1234', model: '-', role: 'adopted', spawnedAt: 9 },
  ] }));
  fs.appendFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id: 'trun000002', status: 'running', title: 'live', worker: 'w1', model: 'opus', outputFile: path.join(SANDBOX, 'live2.md'), cwd: WS, meshWorker: 'cco-w-1' })}\n`);
  ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
  const adoptedBefore = fakeCalls().length;
  reset();
  await run('cancelTask', { id: 'trun000002' });
  const adoptedCall = fakeCalls().slice(adoptedBefore);
  const adoptedEvent = JSON.parse(fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).pop());
  check('G6b [the original G6, on the case it is for] no record carries the task id, an older STOPPED worker reuses the name, and the live record names NO task: the live job is stopped with the cleaned environment and the cancellation recorded', adoptedCall.length === 1 && adoptedCall[0].argv.join(' ') === 'stop abcd1234'
    && !('CLAUDECODE' in adoptedCall[0].env) && !('CLAUDE_CODE_MESSAGING_TOKEN' in adoptedCall[0].env) && adoptedEvent.id === 'trun000002' && adoptedEvent.status === 'error' && /^cancelled/.test(adoptedEvent.error)
    && ledgerCalls.marked.length === 1 && ledgerCalls.marked[0].jobId === 'abcd1234' && ledgerCalls.removed.length === 1, JSON.stringify([adoptedCall.map((c) => c.argv), adoptedEvent.status, adoptedEvent.error, ledgerCalls.marked]));

  { // wave-2 provider probes: a block of their own, so their names cannot collide with the wave-1 probes'
  /* ===================================================== H. Add worker (providers) */
  const providersMod = require(path.join(OUT, 'providers.js'));
  const wmMod = require(path.join(OUT, 'workerManager.js'));
  const IDENTITY = [...platform.SESSION_IDENTITY_ENV];
  // SHELL-FIX (D1): CLAUDE_CONFIG_DIR is no longer "a home variable that must be absent" on another vendor's
  // terminal — it is one of the Anthropic variables that terminal must REMOVE (null), with the three credentials.
  const HOME_VARS = ['CODEX_HOME', 'AGY_HOME'];
  const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CONFIG_DIR'];
  // every Anthropic-scoped variable THIS process holds is removed from such a terminal as well
  const removedNow = () => [...new Set([...IDENTITY, ...CREDENTIALS, ...Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_)/.test(k) || k === 'CLAUDECODE')])];
  const credentialsNulled = (env) => CREDENTIALS.every((k) => env[k] === null);
  const entryOf = (name) => readWorkers().find((w) => w.name === name);
  const keysOf = (name) => Object.keys(entryOf(name) || {}).sort().join(',');
  const names = () => readWorkers().map((w) => w.name).join(',');
  const pickLabel = (label) => (items) => items.find((i) => i.label === label);
  const pickLogin = (login) => (items) => items.find((i) => i.login === login);
  // SHELL-FIX: a Codex login of the worker's own is followed by one more pick — where the CLI keeps it.
  const pickStore = (store) => (items) => items.find((i) => i.store === store);
  const identityNulled = (env) => IDENTITY.every((k) => env[k] === null);
  const CODEX_DEFAULT = path.join(HOME, '.codex');
  const CURSOR_DEFAULT = path.join(HOME, '.cursor');
  const AGY_DEFAULT = path.join(HOME, '.agy');
  check('H0 the sandbox is where the provider homes resolve (nothing below can reach a real ~/.codex, ~/.cursor or ~/.agy)',
    providersMod.defaultProviderHome('codex') === CODEX_DEFAULT && providersMod.defaultProviderHome('cursor') === CURSOR_DEFAULT && providersMod.defaultProviderHome('gemini') === AGY_DEFAULT
    && CODEX_DEFAULT.startsWith(SANDBOX), providersMod.defaultProviderHome('codex'));

  reset();
  const namesBeforeAdd = names();
  await run('addWorker');
  check('H1 Add Worker starts with a provider pick listing the four providers in display order; dismissing it asks nothing else and adds nothing',
    rec.quickPicks.length === 1 && JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)) === JSON.stringify(['Claude Code', 'Codex', 'Cursor', 'Antigravity'])
    && JSON.stringify(rec.quickPicks[0].items.map((i) => i.description)) === JSON.stringify(['claude · attachable sessions', 'codex · one-shot only', 'cursor-agent · one-shot only', 'agy · one-shot only'])
    && rec.inputs.length === 0 && names() === namesBeforeAdd, JSON.stringify(rec.quickPicks[0] && rec.quickPicks[0].items.map((i) => `${i.label}/${i.description}`)));

  // Claude Code keeps its flow, reached through the same pick.
  reset();
  answers.quickPick.push(pickLabel('Claude Code'), pickLabel('sonnet'));
  answers.input.push('c9');
  answers.message.push(() => 'Later');
  await run('addWorker');
  const C9 = path.join(HOME, '.claude-c9');
  check('H2 a Claude Code worker added through the provider pick is written exactly as before: { name, configDir, model } and NO provider key',
    keysOf('c9') === 'configDir,model,name' && entryOf('c9').configDir === C9 && entryOf('c9').model === 'sonnet' && fs.existsSync(C9) && !('provider' in entryOf('c9')) && !('permissionMode' in entryOf('c9')),
    JSON.stringify(entryOf('c9')));
  // Since wave 7 (contract §11.2) the pick ends with "Enter a model id…"; a worker that does not exist yet has no current model.
  check('H2b [UPDATED: "Enter a model id…" closes the list] its model pick offers the Claude tiers and a way to type an id, none marked current, and no login-choice step is shown',
    rec.quickPicks.length === 2 && JSON.stringify(rec.quickPicks[1].items.map((i) => i.label)) === JSON.stringify([...platform.WORKER_MODELS, 'Enter a model id…'])
    && rec.quickPicks[1].items.every((i) => i.description === undefined),
    JSON.stringify(rec.quickPicks.map((q) => q.items.map((i) => `${i.label}/${i.description}`))));

  // Codex, separate login in a new home directory.
  reset();
  const refreshBeforeCx1 = providerRefresh.calls.length;
  answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('file'), pickLabel('gpt-5.6-sol'));
  answers.input.push('cx1');
  answers.message.push((items) => items.find((i) => i === 'Open Login Terminal'));
  await run('addWorker');
  const CX1 = path.join(HOME, '.codex-cx1');
  check('H3 a Codex worker with a separate login is written with provider "codex" and the chosen home directory, which is created',
    JSON.stringify(entryOf('cx1')) === JSON.stringify({ name: 'cx1', configDir: CX1, model: 'gpt-5.6-sol', provider: 'codex' }) && fs.statSync(CX1).isDirectory(), JSON.stringify(entryOf('cx1')));
  check('H3b [UPDATED: one more pick, the login-storage step] the login choice offered both logins, the machine\'s own first', rec.quickPicks.length === 4 && JSON.stringify(rec.quickPicks[1].items.map((i) => `${i.login}:${i.description}`)) === JSON.stringify([`ambient:${CODEX_DEFAULT}`, `separate:${CX1}`]),
    JSON.stringify(rec.quickPicks[1] && rec.quickPicks[1].items.map((i) => `${i.login}:${i.description}`)));
  const cxSeparate = rec.quickPicks[1].items.find((i) => i.login === 'separate');
  check('H3c Codex isolation is verified, so its separate-login choice carries no caution and no modal is raised', !/⚠/.test(cxSeparate.detail) && /CODEX_HOME/.test(cxSeparate.detail) && !rec.messages.some((m) => m.modal));
  const tCx1 = rec.terminals[0];
  check('H4 [UPDATED for D1] its login terminal sets CODEX_HOME to that directory, nulls every session-identity variable AND every Anthropic credential variable (CLAUDE_CONFIG_DIR included), sets nothing else, and runs `codex login`',
    rec.terminals.length === 1 && tCx1.opts.env.CODEX_HOME === CX1 && identityNulled(tCx1.opts.env) && credentialsNulled(tCx1.opts.env) && tCx1.sent.join('|') === 'codex login' && tCx1.opts.name === 'login: cx1'
    && !('AGY_HOME' in tCx1.opts.env) && Object.keys(tCx1.opts.env).sort().join(',') === [...removedNow(), 'CODEX_HOME'].sort().join(','), tCx1 && JSON.stringify([tCx1.opts.env.CODEX_HOME, tCx1.sent, CREDENTIALS.map((k) => `${k}=${tCx1.opts.env[k]}`)]));
  check('H4b a reading for the new account is requested at once', providerRefresh.calls.length === refreshBeforeCx1 + 1, `${providerRefresh.calls.length - refreshBeforeCx1} refresh call(s)`);

  // Codex, the login already on this machine.
  reset();
  answers.quickPick.push(pickLabel('Codex'), pickLogin('ambient'), pickLabel('Let the CLI choose'));
  answers.input.push('cx0');
  answers.message.push((items) => items.find((i) => i === 'Open Login Terminal'));
  await run('addWorker');
  check('H5 a Codex worker on the machine\'s own login is filed under the provider\'s default home, with no default model — and that directory is NOT created',
    JSON.stringify(entryOf('cx0')) === JSON.stringify({ name: 'cx0', configDir: CODEX_DEFAULT, model: '', provider: 'codex' }) && !fs.existsSync(CODEX_DEFAULT), JSON.stringify(entryOf('cx0')));
  const tCx0 = rec.terminals[0];
  check('H6 [UPDATED for D1] its login terminal sets NO home variable at all (the default home is addressed by setting nothing), nulls the session identity and the Anthropic credential variables, and holds no other key',
    rec.terminals.length === 1 && HOME_VARS.every((k) => !(k in tCx0.opts.env)) && identityNulled(tCx0.opts.env) && credentialsNulled(tCx0.opts.env) && Object.keys(tCx0.opts.env).sort().join(',') === removedNow().sort().join(',')
    && tCx0.sent.join('|') === 'codex login', tCx0 && JSON.stringify(Object.keys(tCx0.opts.env).filter((k) => !IDENTITY.includes(k) && !CREDENTIALS.includes(k))));

  reset();
  answers.quickPick.push(pickLabel('Codex'));
  answers.input.push('cx9');
  await run('addWorker');
  check('H7 once a worker holds the machine\'s login, a further Codex worker is offered ONLY a separate login, and is told why',
    rec.quickPicks.length === 2 && JSON.stringify(rec.quickPicks[1].items.map((i) => i.login)) === '["separate"]' && /"cx0" already uses the Codex login on this machine/.test(rec.quickPicks[1].opts.placeHolder)
    && entryOf('cx9') === undefined && !fs.existsSync(path.join(HOME, '.codex-cx9')), rec.quickPicks[1] && rec.quickPicks[1].opts.placeHolder);

  // Cursor: one login per machine.
  reset();
  answers.quickPick.push(pickLabel('Cursor'), pickLabel('auto'));
  answers.input.push('cur');
  answers.message.push(() => 'Later');
  await run('addWorker');
  check('H8 a Cursor worker uses the ambient login only: no login-choice step, default home as its identity, nothing created',
    JSON.stringify(entryOf('cur')) === JSON.stringify({ name: 'cur', configDir: CURSOR_DEFAULT, model: 'auto', provider: 'cursor' }) && rec.quickPicks.length === 2 && !fs.existsSync(CURSOR_DEFAULT)
    && rec.terminals.length === 0, JSON.stringify([entryOf('cur'), rec.quickPicks.length]));
  reset();
  answers.quickPick.push(pickLabel('Cursor'), pickLabel('auto'));
  answers.input.push('cur2');
  await run('addWorker');
  check('H9 a SECOND Cursor worker is refused with the reason, before a name is even asked for',
    entryOf('cur2') === undefined && rec.inputs.length === 0 && rec.quickPicks.length === 1 && rec.messages.length === 1 && rec.messages[0].level === 'warning'
    && /single login per machine/.test(rec.messages[0].msg) && /"cur" already is it/.test(rec.messages[0].msg), rec.messages[0] && rec.messages[0].msg);
  const direct = new wmMod.WorkerManager();
  const throwsWith = (fn, re) => { try { fn(); return 'did not throw'; } catch (e) { return re.test(e.message) ? true : e.message; } };
  check('H9b WorkerManager.add refuses it too (last line of defence), and refuses a Cursor worker pointed at any other directory',
    throwsWith(() => direct.add('cur2', 'auto', undefined, 'cursor'), /single login per machine/) === true && entryOf('cur2') === undefined, String(throwsWith(() => direct.add('cur2', 'auto', undefined, 'cursor'), /single login per machine/)));

  // Antigravity: isolation is not a verified behaviour.
  reset();
  answers.quickPick.push(pickLabel('Antigravity'), pickLogin('separate'));
  answers.input.push('ag1');
  await run('addWorker');
  const AG1 = path.join(HOME, '.agy-ag1');
  const agLoginPick = rec.quickPicks[1];
  check('H10 Antigravity: the separate-login choice carries a visible caution, and choosing it raises a MODAL warning; dismissing that adds nothing and creates nothing',
    agLoginPick && /⚠ Not verified for Antigravity/.test(agLoginPick.items.find((i) => i.login === 'separate').detail) && /AGY_HOME/.test(agLoginPick.items.find((i) => i.login === 'separate').detail)
    && rec.messages.length === 1 && rec.messages[0].modal === true && rec.messages[0].level === 'warning' && /SAME account/.test(rec.messages[0].detail)
    && entryOf('ag1') === undefined && !fs.existsSync(AG1), JSON.stringify(rec.messages.map((m) => [m.level, m.modal, m.msg])));
  reset();
  answers.quickPick.push(pickLabel('Antigravity'), pickLogin('separate'), pickLabel('gemini-3.8-flash-high'));
  answers.input.push('ag1');
  answers.message.push((items) => items.find((i) => i === 'Continue Anyway'));
  await run('addWorker');
  check('H11 confirming it adds the worker with provider "gemini" and its own home; with no login command, NO terminal is offered and the user is told where to sign in',
    JSON.stringify(entryOf('ag1')) === JSON.stringify({ name: 'ag1', configDir: AG1, model: 'gemini-3.8-flash-high', provider: 'gemini' }) && fs.existsSync(AG1) && rec.terminals.length === 0
    && rec.messages.some((m) => m.level === 'info' && /has no login command/.test(m.msg) && m.items.length === 0), rec.messages.map((m) => m.msg).join(' | '));

  // Model: free text is validated by shape.
  reset();
  answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('file'), pickLabel('Enter another model id…'));
  answers.input.push('cx2', 'gpt 5; rm -rf ~');
  await run('addWorker');
  const modelBox = rec.inputs[1];
  check('H12 an invalid model string typed into the free-text box is refused: a warning, no worker, no directory',
    entryOf('cx2') === undefined && !fs.existsSync(path.join(HOME, '.codex-cx2')) && rec.messages.length === 1 && rec.messages[0].level === 'warning' && /Not a model/.test(rec.messages[0].msg),
    rec.messages.map((m) => m.msg).join(' | '));
  check('H12b the box validates as you type with normalizeProviderModel', modelBox && typeof modelBox.validateInput('gpt 5; rm -rf ~') === 'string' && typeof modelBox.validateInput('opus sonnet') === 'string'
    && typeof modelBox.validateInput('') === 'string' && typeof modelBox.validateInput('$(id)') === 'string' && modelBox.validateInput('gpt-5.5') === undefined && modelBox.validateInput(' composer-2.5[fast=true] ') === undefined);
  reset();
  answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('file'), pickLabel('Enter another model id…'));
  answers.input.push('cx2', '  o9-custom[effort=high]  ');
  answers.message.push(() => 'Later');
  await run('addWorker');
  check('H13 a well-formed id that is not among the suggestions is accepted and stored trimmed', entryOf('cx2') && entryOf('cx2').model === 'o9-custom[effort=high]' && entryOf('cx2').provider === 'codex', JSON.stringify(entryOf('cx2')));
  for (const bad of ['opus sonnet', 'gpt 5', '$(id)', '-rf', 'x'.repeat(200), '', '   ']) {
    const r = bad === '' ? 'empty means CLI default' : throwsWith(() => direct.add('cxbad', bad, path.join(HOME, '.codex-cxbad'), 'codex'), /Not a model id/);
    if (bad !== '' && r !== true) check(`H14 WorkerManager.add refuses model ${JSON.stringify(bad.slice(0, 20))} for a Codex worker`, false, String(r));
  }
  check('H14 WorkerManager.add refuses every non-model string for a Codex worker (6 variants) and creates nothing', entryOf('cxbad') === undefined && !fs.existsSync(path.join(HOME, '.codex-cxbad')));
  check('H14b and a Claude Code worker still cannot be added without a model', throwsWith(() => direct.add('nomodel', undefined), /Not a model/) === true && entryOf('nomodel') === undefined);

  // Names: the box's validation is advice; the flow checks again.
  const beforeNames = names();
  const BAD_NAMES = ['main', 'cx1', 'a b', '../../etc', 'x/y', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty'];
  for (const bad of BAD_NAMES) {
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickLabel('gpt-5.5'));
    answers.input.push(bad);
    await run('addWorker');
    if (names() !== beforeNames || rec.quickPicks.length !== 1) check(`H15 name ${JSON.stringify(bad)} is refused`, false, `${names()} / ${rec.quickPicks.length} picks`);
  }
  check(`H15 a reserved, taken, malformed or path-like name — or one every object already answers to — is refused before any login or model step (${BAD_NAMES.length} variants); nothing is added`,
    names() === beforeNames && !fs.existsSync(path.join(HOME, '.codex-..')) && !fs.existsSync(path.join(SANDBOX, 'etc')) && !fs.existsSync(path.join(HOME, '.codex-constructor')), names());
  for (const bad of ['../../etc', 'main', 'constructor', 'a b']) {
    reset();
    answers.quickPick.push(pickLabel('Claude Code'), pickLabel('opus'));
    answers.input.push(bad);
    await run('addWorker');
    if (names() !== beforeNames || rec.quickPicks.length !== 1 || rec.messages.length !== 1 || rec.messages[0].level !== 'warning') check(`H15b Claude flow refuses name ${JSON.stringify(bad)}`, false, `${names()} / ${rec.quickPicks.length} picks`);
  }
  check('H15b the Claude Code flow refuses the same names before it derives a directory from them', names() === beforeNames && !fs.existsSync(path.join(SANDBOX, 'etc')) && !fs.existsSync(path.join(HOME, '.claude-constructor')));
  check('H15c WorkerManager refuses an object-key name on add and on rename, for any provider',
    throwsWith(() => direct.add('constructor', 'opus'), /cannot be used as a worker name/) === true && throwsWith(() => direct.add('toString', 'gpt-5.5', path.join(HOME, '.codex-t'), 'codex'), /cannot be used as a worker name/) === true
    && throwsWith(() => direct.rename('c9', '__proto__'), /cannot be used as a worker name/) === true && names() === beforeNames && !fs.existsSync(path.join(HOME, '.claude-constructor')), names());

  // A leftover directory is never adopted silently.
  const OLD = path.join(HOME, '.codex-old');
  fs.mkdirSync(OLD);
  fs.writeFileSync(path.join(OLD, 'auth.json'), '{}');
  reset();
  answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickLabel('gpt-5.5'));
  answers.input.push('old');
  await run('addWorker');
  check('H16 a separate home that already exists and is not empty needs a MODAL confirmation; dismissing it adds nothing',
    entryOf('old') === undefined && rec.messages.length === 1 && rec.messages[0].modal === true && /already exists and is not empty/.test(rec.messages[0].msg), rec.messages.map((m) => m.msg).join(' | '));

  // [second review, §9.4: W2 — `.claude-w2`, an EMPTY directory — was offered for its name alone.] Import offers
  // only a real directory that looks like a Claude Code config directory: one holding `.claude.json` or
  // `.credentials.json` as a regular file, or a `sessions/` or `projects/` directory. W2 gets a sessions/.
  fs.mkdirSync(path.join(W2, 'sessions'), { recursive: true });
  const IMP = (n) => path.join(HOME, n);
  const ODD = IMP('.claude-odd name!');
  fs.mkdirSync(IMP('.claude-empty'));
  fs.mkdirSync(IMP('.claude-byjson')); fs.writeFileSync(path.join(IMP('.claude-byjson'), '.claude.json'), '{}');
  fs.mkdirSync(IMP('.claude-bycred')); fs.writeFileSync(path.join(IMP('.claude-bycred'), '.credentials.json'), '{}');
  fs.mkdirSync(path.join(IMP('.claude-byproj'), 'projects'), { recursive: true });
  fs.mkdirSync(path.join(IMP('.claude-wrongkind'), '.claude.json'), { recursive: true });       // the two files as DIRECTORIES,
  fs.mkdirSync(path.join(IMP('.claude-wrongkind'), '.credentials.json'));
  fs.writeFileSync(path.join(IMP('.claude-wrongkind'), 'sessions'), 'a file');                    // the two directories as FILES
  fs.writeFileSync(path.join(IMP('.claude-wrongkind'), 'projects'), 'a file');
  fs.symlinkSync(IMP('.claude-byjson'), IMP('.claude-link'));
  fs.writeFileSync(IMP('.claude-afile'), 'x');
  fs.mkdirSync(path.join(ODD, 'sessions'), { recursive: true });
  const offered = () => direct.discoverConfigDirs().map((d) => path.basename(d.dir)).sort();
  check('H17 "Import Existing Claude Config Directories" discovers only .claude* directories — never another vendor\'s home, and not this extension\'s own data directory',
    direct.discoverConfigDirs().every((d) => path.basename(d.dir).startsWith('.claude')) && fs.existsSync(CX1) && !direct.discoverConfigDirs().some((d) => d.dir === CX1 || d.dir === OLD || d.dir === registry.ROOT_DIR)
    && fs.existsSync(registry.ROOT_DIR) && direct.discoverConfigDirs().some((d) => d.dir === W2),
    direct.discoverConfigDirs().map((d) => path.basename(d.dir)).join(','));
  check('H17b …and of those only a REAL directory that looks like a config directory: offered when it holds .claude.json or .credentials.json (a regular file) or sessions/ or projects/ (a directory); not offered when it is empty, when those four are there as the wrong kind of thing, when it is a symbolic link to a config directory, or when it is a file',
    ['.claude-w2', '.claude-byjson', '.claude-bycred', '.claude-byproj', '.claude-odd name!'].every((n) => offered().includes(n)) && !['.claude-empty', '.claude-wrongkind', '.claude-link', '.claude-afile'].some((n) => offered().includes(n)), offered().join(','));
  // The import command itself: a directory whose own name the name rule does not take is asked for a name.
  const pickOdd = (items) => items.filter((i) => i.entry && i.entry.dir === ODD);
  const namesBeforeImport = names();
  reset();
  answers.quickPick.push(pickOdd); // …and the name box is left with Escape (no answer queued)
  await run('importWorkers');
  const nameBox = rec.inputs[0];
  // a path is shown as one display-safe line of at most 200 characters (views.rowText): its head
  const shownDir = (d) => d.slice(0, 200).trimEnd();
  check('H17c import: for a directory whose own name is not a worker name ("odd name!") a name is asked — the box starts from a sanitized suggestion, names the directory and says Escape skips it, and refuses what the name rule refuses — and Escape adds nothing and asks nothing more',
    rec.quickPicks.length === 1 && rec.quickPicks[0].opts.canPickMany === true && rec.inputs.length === 1 && nameBox.value === 'odd-name' && /Escape/.test(nameBox.prompt) && nameBox.prompt.includes(shownDir(ODD))
    && typeof nameBox.validateInput === 'function' && ['still bad!', 'main', 'toString', 'x'.repeat(65), 'w1', ''].every((v) => nameBox.validateInput(v) !== undefined) && nameBox.validateInput(' odd1 ') === undefined
    && names() === namesBeforeImport, `${rec.quickPicks.length} pick(s), ${rec.inputs.length} box(es), suggestion ${nameBox && JSON.stringify(nameBox.value)}; ${names()}`);
  reset();
  answers.quickPick.push(pickOdd, pickLabel('opus'));
  answers.input.push(' odd1 ');
  await run('importWorkers');
  check('H17d import: with a name typed the worker is added under that name (trimmed) on that directory, as a Claude Code account — under `workers`, with no provider key — and the directory is no longer offered',
    entryOf('odd1') !== undefined && entryOf('odd1').configDir === ODD && entryOf('odd1').model === 'opus' && !('provider' in entryOf('odd1')) && readReg().workers.some((w) => w.name === 'odd1') && !offered().includes('.claude-odd name!'),
    JSON.stringify(entryOf('odd1')));
  // …and the fixture is put back as it was for the sections below
  direct.remove('odd1');
  for (const n of ['.claude-empty', '.claude-byjson', '.claude-bycred', '.claude-byproj', '.claude-wrongkind', '.claude-link', '.claude-afile', '.claude-odd name!']) fs.rmSync(IMP(n), { recursive: true, force: true });

  /* ============================================= I. account actions per provider */
  const kCx1 = 'd'.repeat(16); const kCx0 = 'e'.repeat(16); const kCur = 'f'.repeat(16); const kAg1 = '1'.repeat(16); const kC9 = '2'.repeat(16);
  accounts.set(kCx1, { name: 'cx1', configDir: CX1, isMain: false, isWorker: true });
  accounts.set(kCx0, { name: 'cx0', configDir: CODEX_DEFAULT, isMain: false, isWorker: true });
  accounts.set(kCur, { name: 'cur', configDir: CURSOR_DEFAULT, isMain: false, isWorker: true });
  accounts.set(kAg1, { name: 'ag1', configDir: AG1, isMain: false, isWorker: true });
  accounts.set(kC9, { name: 'c9', configDir: C9, isMain: false, isWorker: true });
  const modeOf = (name) => (entryOf(name) || {}).permissionMode;
  // Returns the messages shown, in order; a MODAL one is marked with "!" (so "info" alone proves no modal was raised).
  const setMode = async (account, value, answer) => {
    reset();
    if (answer !== undefined) answers.message.push(answer);
    await run('accountAction', { action: 'setPermissionMode', account, value });
    return rec.messages.map((m) => `${m.level}${m.modal ? '!' : ''}`).join(',');
  };
  const confirmFirst = (items) => items[0];

  const okRO = await setMode(kCx1, 'read-only');
  const afterRO = modeOf('cx1');
  const okDefault = await setMode(kCx1, 'workspace-write');
  const afterDefault = 'permissionMode' in entryOf('cx1');
  const okRO2 = await setMode(kCx1, 'read-only');
  const okNull = await setMode(kCx1, null);
  const afterNull = 'permissionMode' in entryOf('cx1');
  check('I1 setPermissionMode on a Codex worker stores a mode that keeps the sandbox with NO modal (read-only); the provider default and null are stored as ABSENT',
    okRO === 'info' && afterRO === 'read-only' && okDefault === 'info' && afterDefault === false && okRO2 === 'info' && okNull === 'info' && afterNull === false,
    JSON.stringify([okRO, afterRO, okDefault, afterDefault, okRO2, okNull, afterNull]));
  await setMode(kCx1, 'read-only');

  // F10: a mode that turns the sandbox off is never stored on one click.
  const dismissed = await setMode(kCx1, 'danger-full-access');
  const ask = rec.messages[0];
  check('F10a Codex + danger-full-access raises a MODAL warning naming the account, the provider and the mode and saying what it allows; dismissing it stores nothing and reports nothing as saved',
    dismissed === 'warning!' && modeOf('cx1') === 'read-only' && /"cx1"/.test(ask.msg) && /Codex/.test(ask.msg) && /danger-full-access/.test(ask.msg) && /run on this machine without a sandbox/.test(ask.detail)
    && ask.items.length === 1 && ask.items[0] === 'Run Without Sandbox', JSON.stringify([dismissed, modeOf('cx1'), ask.msg, ask.items]));
  const otherAnswers = [];
  for (const answer of [() => 'Cancel', () => 'OK', () => true, () => 'run without sandbox', () => null]) otherAnswers.push(`${await setMode(kCx1, 'danger-full-access', answer)}/${modeOf('cx1')}`);
  check('F10b any answer other than the confirm button itself stores nothing', otherAnswers.every((r) => r === 'warning!/read-only'), otherAnswers.join(' '));
  const confirmed = await setMode(kCx1, 'danger-full-access', confirmFirst);
  check('F10c confirming the modal stores the mode, and only then is it reported', confirmed === 'warning!,info' && modeOf('cx1') === 'danger-full-access' && /danger-full-access mode \(Codex\)/.test(rec.messages[1].msg), JSON.stringify([confirmed, modeOf('cx1')]));
  const again = await setMode(kCx1, 'danger-full-access');
  const tighten = await setMode(kCx1, 'read-only');
  const tightened = modeOf('cx1');
  await setMode(kCx1, 'danger-full-access', confirmFirst);
  const toDefault = await setMode(kCx1, null);
  check('F10d asked every time the mode is requested; tightening the sandbox or returning to the provider default needs no confirmation',
    again === 'warning!' && tighten === 'info' && tightened === 'read-only' && toDefault === 'info' && !('permissionMode' in entryOf('cx1')), JSON.stringify([again, tighten, tightened, toDefault]));
  const curOff = await setMode(kCur, 'disabled');
  const curOffStored = modeOf('cur');
  const curOffAsk = rec.messages[0];
  const curOffOk = await setMode(kCur, 'disabled', confirmFirst);
  const curOffStored2 = modeOf('cur');
  const curOn = await setMode(kCur, 'enabled');
  const agPlanNoModal = await setMode(kAg1, 'plan');
  await setMode(kAg1, null);
  await setMode(kCur, null);
  check('F10e the same gate for Cursor `disabled`; Cursor `enabled` and Antigravity `plan` (which keep the sandbox) are stored with no modal',
    curOff === 'warning!' && curOffStored === undefined && /"cur"/.test(curOffAsk.msg) && /Cursor/.test(curOffAsk.msg) && /disabled/.test(curOffAsk.msg) && curOffOk === 'warning!,info' && curOffStored2 === 'disabled'
    && curOn === 'info' && agPlanNoModal === 'info', JSON.stringify([curOff, curOffStored, curOffOk, curOffStored2, curOn, agPlanNoModal]));
  reset();
  answers.quickPick.push(pickLabel('danger-full-access'));
  await run('setWorkerPermissionMode', { name: 'cx1' });
  const pickAsk = rec.messages.map((m) => `${m.level}${m.modal ? '!' : ''}`).join(',');
  const pickStored = 'permissionMode' in entryOf('cx1');
  reset();
  answers.quickPick.push(pickLabel('disabled'));
  answers.message.push(() => 'Cancel');
  await run('accountAction', { action: 'setPermissionMode', account: kCur });
  check('F10f the pickers go through the same gate: choosing danger-full-access (tree command) or disabled (dashboard, no value) and dismissing the modal stores nothing; the picker marks such modes',
    pickAsk === 'warning!' && pickStored === false && rec.messages.length === 1 && rec.messages[0].modal === true && !('permissionMode' in entryOf('cur'))
    && /Turns the sandbox off/.test(rec.quickPicks[0].items.find((i) => i.label === 'disabled').detail) && rec.quickPicks[0].items.find((i) => i.label === 'enabled').detail === undefined, JSON.stringify([pickAsk, pickStored, rec.messages.length]));
  check('F10g WorkerManager.setPermissionMode itself refuses an unsandboxed mode that was not confirmed, for both providers, and stores it only with the confirmation stated',
    throwsWith(() => direct.setPermissionMode('cx1', 'danger-full-access'), /was not confirmed/) === true && throwsWith(() => direct.setPermissionMode('cur', 'disabled'), /was not confirmed/) === true
    && throwsWith(() => direct.setPermissionMode('cx1', 'danger-full-access', 'yes'), /was not confirmed/) === true && !('permissionMode' in entryOf('cx1')) && !('permissionMode' in entryOf('cur'))
    && wmMod.removesSandbox('codex', 'danger-full-access') && wmMod.removesSandbox('cursor', 'disabled') && !wmMod.removesSandbox('codex', 'disabled') && !wmMod.removesSandbox('cursor', 'danger-full-access')
    && !wmMod.removesSandbox('codex', 'read-only') && !wmMod.removesSandbox('codex', 'workspace-write') && !wmMod.removesSandbox('cursor', 'enabled') && !wmMod.removesSandbox('gemini', 'plan') && !wmMod.removesSandbox('codex', null));
  await setMode(kCx1, 'read-only');
  let refused = 0;
  const foreignModes = ['acceptEdits', 'bypassPermissions', 'enabled', 'disabled', 'plan', 'accept-edits', 'READ-ONLY', 'read-only ', ' read-only', 'read-only; rm -rf ~', '--help', 7, true, {}, ['read-only'], { toString: () => 'read-only' }];
  for (const bad of foreignModes) {
    const levels = await setMode(kCx1, bad);
    if (levels === 'warning' && modeOf('cx1') === 'read-only') refused++;
    else check(`I2 Codex worker refuses mode ${JSON.stringify(bad)}`, false, `${levels} / stored ${modeOf('cx1')}`);
  }
  check(`I2 setPermissionMode accepts ONLY that provider's modes: ${foreignModes.length} values that are Claude's, Cursor's, Antigravity's, mis-cased, padded, shell text or not strings are refused with a warning and change nothing`,
    refused === foreignModes.length && modeOf('cx1') === 'read-only', `${refused}/${foreignModes.length} refused; stored ${modeOf('cx1')}`);
  const curEnabled = await setMode(kCur, 'enabled'); const curStored = modeOf('cur');
  const curForeign = await setMode(kCur, 'read-only'); const curStill = modeOf('cur');
  const agPlan = await setMode(kAg1, 'plan'); const agStored = modeOf('ag1');
  const agDefault = await setMode(kAg1, 'accept-edits'); const agAbsent = !('permissionMode' in entryOf('ag1'));
  const agForeign = await setMode(kAg1, 'acceptEdits');
  check('I3 the same holds per provider: Cursor takes enabled and refuses Codex\'s read-only; Antigravity takes plan, stores its default accept-edits as absent, and refuses Claude\'s acceptEdits',
    curEnabled === 'info' && curStored === 'enabled' && curForeign === 'warning' && curStill === 'enabled' && agPlan === 'info' && agStored === 'plan' && agDefault === 'info' && agAbsent && agForeign === 'warning',
    JSON.stringify([curEnabled, curStored, curForeign, curStill, agPlan, agStored, agDefault, agAbsent, agForeign]));
  const globalBefore = readReg().permissionMode;
  const claudeLevels = await setMode(w1Key, 'plan');
  check('I4 on a Claude Code worker the action explains that the global setting applies, and changes nothing — neither the worker nor the global mode',
    claudeLevels === 'info' && /no permission mode of their own/.test(rec.messages[0].msg) && rec.messages[0].items.length === 1 && !('permissionMode' in entryOf('w1')) && readReg().permissionMode === globalBefore,
    rec.messages[0] && rec.messages[0].msg);
  check('I4b WorkerManager.setPermissionMode refuses a Claude Code worker and a foreign mode outright', throwsWith(() => direct.setPermissionMode('w1', 'plan'), /no permission mode of their own/) === true
    && throwsWith(() => direct.setPermissionMode('cx1', 'acceptEdits'), /is not a Codex permission mode/) === true && direct.setPermissionMode('nobody', 'plan') === false && modeOf('cx1') === 'read-only');
  reset();
  answers.quickPick.push(pickLabel('danger-full-access'));
  answers.message.push(confirmFirst);
  await run('accountAction', { action: 'setPermissionMode', account: kCx1 });
  check('I5 with no value it offers "Provider default" plus exactly that provider\'s modes, marks the current one, and stores the pick (after the F10 confirmation, since this pick turns the sandbox off)',
    rec.quickPicks.length === 1 && JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)) === JSON.stringify(['Provider default', ...providersMod.providerInfo('codex').permissionModes])
    && rec.quickPicks[0].items.find((i) => i.label === 'read-only').description === 'current' && modeOf('cx1') === 'danger-full-access', JSON.stringify(rec.quickPicks[0] && rec.quickPicks[0].items.map((i) => [i.label, i.description])));
  reset();
  answers.quickPick.push(pickLabel('Provider default'));
  await run('setWorkerPermissionMode', { name: 'cur' });
  check('I6 the tree command does the same for the row it is run on (Cursor: Provider default + enabled / disabled → cleared)',
    JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)) === JSON.stringify(['Provider default', 'enabled', 'disabled']) && !('permissionMode' in entryOf('cur')), JSON.stringify(entryOf('cur')));
  reset();
  await run('accountAction', { action: 'setPermissionMode', account: mainKey, value: 'plan' });
  check('I7 setPermissionMode on the main (non-worker) account warns and changes nothing', rec.messages.length === 1 && rec.messages[0].level === 'warning' && /not a registered worker/.test(rec.messages[0].msg));

  // open session / re-login: the provider's own CLI, the same environment rule
  reset();
  await run('accountAction', { action: 'openSession', account: kCx1 });
  await run('accountAction', { action: 'openSession', account: kCx0 });
  await run('accountAction', { action: 'openSession', account: kCur });
  await run('openWorkerSession', { name: 'ag1' });
  const [sCx1, sCx0, sCur, sAg1] = rec.terminals;
  check('I8 Open Session opens the provider\'s interactive CLI (codex / cursor-agent / agy) with no task prompt asked and no argument typed',
    rec.terminals.length === 4 && rec.inputs.length === 0 && sCx1.sent.join('|') === 'codex' && sCx0.sent.join('|') === 'codex' && sCur.sent.join('|') === 'cursor-agent' && sAg1.sent.join('|') === 'agy'
    && sCx1.opts.name === 'codex: cx1' && sCur.opts.name === 'cursor-agent: cur', rec.terminals.map((t) => `${t.opts.name}=${t.sent.join('|')}`).join(' ; '));
  check('I9 [UPDATED for D1] the environment rule per account: own home → its home variable set verbatim; default home / no isolation → NO home variable; session identity AND Anthropic credential variables nulled in all four',
    sCx1.opts.env.CODEX_HOME === CX1 && HOME_VARS.every((k) => !(k in sCx0.opts.env)) && HOME_VARS.every((k) => !(k in sCur.opts.env)) && sAg1.opts.env.AGY_HOME === AG1 && !('CODEX_HOME' in sAg1.opts.env)
    && [sCx1, sCx0, sCur, sAg1].every((t) => identityNulled(t.opts.env) && credentialsNulled(t.opts.env)), JSON.stringify([sCx1, sCx0, sCur, sAg1].map((t) => [...HOME_VARS, ...CREDENTIALS].filter((k) => k in t.opts.env).map((k) => `${k}=${t.opts.env[k]}`))));
  reset();
  await run('accountAction', { action: 'relogin', account: kCx1 });
  await run('accountAction', { action: 'relogin', account: kCur });
  await run('reloginWorker', { configDir: CODEX_DEFAULT });
  await run('loginWorker', { name: 'cx1' });
  check('I10 Re-login runs the provider\'s own login command under the same environment rule (dashboard key, config dir, and both tree commands)',
    rec.terminals.length === 4 && rec.terminals.map((t) => t.sent.join('|')).join(';') === 'codex login;cursor-agent login;codex login;codex login' && rec.terminals[0].opts.env.CODEX_HOME === CX1
    && HOME_VARS.every((k) => !(k in rec.terminals[1].opts.env)) && !('CODEX_HOME' in rec.terminals[2].opts.env) && rec.terminals[3].opts.env.CODEX_HOME === CX1
    // SHELL-FIX (D1): "the same environment rule" now includes the Anthropic credential variables.
    && rec.terminals.every((t) => identityNulled(t.opts.env) && credentialsNulled(t.opts.env)), rec.terminals.map((t) => t.sent.join('|')).join(';'));
  reset();
  await run('accountAction', { action: 'relogin', account: kAg1 });
  await run('reloginWorker', { name: 'ag1' });
  check('I11 a provider with no login command (Antigravity) opens NO terminal and says where to sign in',
    rec.terminals.length === 0 && rec.messages.length === 2 && rec.messages.every((m) => m.level === 'info' && /has no login command/.test(m.msg) && /no terminal was opened for "ag1"/.test(m.msg)), rec.messages.map((m) => m.msg).join(' | '));
  reset();
  await run('accountAction', { action: 'relogin', account: kC9 });
  await run('loginWorker', { name: 'c9' });
  check('I12 a Claude Code worker still re-logs with `claude auth login` under claudeTerminalEnv, and "Re-login Worker Account" still opens Claude Code itself',
    rec.terminals.length === 2 && /^claude auth login/.test(rec.terminals[0].sent[0]) && rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR === C9 && rec.terminals[1].sent[0] === 'claude' && rec.terminals[1].opts.env.CLAUDE_CONFIG_DIR === C9
    && rec.terminals[1].opts.name === 'claude: c9', rec.terminals.map((t) => t.sent[0]).join(' ; '));
  reset();
  await run('reloginWorker');
  check('I13 the palette\'s re-login pick lists main and the workers of EVERY provider', rec.quickPicks.length === 1 && ['main', 'w1', 'c9', 'cx1', 'cx0', 'cur', 'ag1', 'cx2'].every((n) => rec.quickPicks[0].items.some((i) => i.label === n))
    && rec.quickPicks[0].items.find((i) => i.label === 'cur').detail === 'Cursor' && rec.quickPicks[0].items.find((i) => i.label === 'main').detail === undefined, rec.quickPicks[0].items.map((i) => i.label).join(','));

  // default model, provider-aware
  const setModelVia = async (account, value) => { reset(); await run('accountAction', { action: 'setModel', account, value }); return rec.messages.map((m) => m.level).join(','); };
  const m1 = await setModelVia(kCx1, ' gpt-5.5 '); const m1v = entryOf('cx1').model;
  const m2 = await setModelVia(kCx1, null); const m2v = entryOf('cx1').model;
  const m3 = await setModelVia(kCx1, 'opus'); const m3v = entryOf('cx1').model;
  check('I14 setModel on a Codex worker stores a Codex-shaped id, null means "no default" (model ""), and an id of another vendor\'s shape is stored as written (the CLI decides)',
    m1 === 'info' && m1v === 'gpt-5.5' && m2 === 'info' && m2v === '' && m3 === 'info' && m3v === 'opus', JSON.stringify([m1, m1v, m2, m2v, m3, m3v]));
  let modelRefused = 0;
  const badModels = ['opus sonnet', 'gpt 5', '$(id)', 'gpt-5.5; rm -rf ~', '-x', 'x'.repeat(200), '   ', 7, {}, ['gpt-5.5']];
  for (const bad of badModels) { if ((await setModelVia(kCx1, bad)) === 'warning' && entryOf('cx1').model === 'opus') modelRefused++; else check(`I15 Codex worker refuses model ${JSON.stringify(bad)}`, false, entryOf('cx1').model); }
  check(`I15 an invalid model string is refused for a Codex worker (${badModels.length} variants) and nothing changes`, modelRefused === badModels.length, `${modelRefused}/${badModels.length}`);
  check('I15b a Claude Code worker still cannot be given "no default" or a Codex id', (await setModelVia(kC9, null)) === 'warning' && (await setModelVia(kC9, '')) === 'warning' && (await setModelVia(kC9, 'gpt-5.5')) === 'warning' && entryOf('c9').model === 'sonnet', entryOf('c9').model);
  reset();
  answers.quickPick.push(pickLabel('Let the CLI choose'));
  await run('setWorkerModel', { name: 'cx1' });
  check('I16 the model pick of a Codex worker offers its current id, the suggested ids, "Let the CLI choose" and free text — not the Claude tiers',
    JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)) === JSON.stringify(['opus', ...providersMod.providerInfo('codex').suggestedModels, 'Let the CLI choose', 'Enter another model id…'])
    && rec.quickPicks[0].items[0].description === 'current' && entryOf('cx1').model === '', JSON.stringify(rec.quickPicks[0].items.map((i) => i.label)));

  // preferred is a choice among ONE provider's workers
  const prefs = () => readWorkers().filter((w) => w.preferred === true).map((w) => w.name).sort().join(',');
  reset();
  await run('accountAction', { action: 'togglePreferred', account: w1Key });
  await run('accountAction', { action: 'togglePreferred', account: kCx1 });
  const prefsA = prefs();
  await run('togglePreferred', { name: 'cx0' });
  const prefsB = prefs();
  await run('togglePreferred', { name: 'c9' });
  const prefsC = prefs();
  check('I17 marking a Codex worker preferred leaves the preferred Claude Code worker alone; within one provider the mark still moves',
    prefsA === 'cx1,w1' && prefsB === 'cx0,w1' && prefsC === 'c9,cx0', JSON.stringify([prefsA, prefsB, prefsC]));
  await run('togglePreferred', { name: 'c9' });

  reset();
  await run('accountAction', { action: 'remove', account: kCx0 });
  const removeAsk = rec.messages[0];
  answers.message.push((items) => items[0]);
  await run('accountAction', { action: 'remove', account: kCx0 });
  check('I18 removing a provider worker is modal, says its login stays on disk, and removes only the registry entry',
    removeAsk.modal === true && /Codex login stays on disk/.test(removeAsk.detail) && entryOf('cx0') === undefined && entryOf('cx1') !== undefined, removeAsk && removeAsk.detail);
  reset();
  answers.input.push('cx1b');
  await run('renameWorker', { name: 'cx1' });
  check('I19 renaming keeps the provider, the home directory and the mode', JSON.stringify(entryOf('cx1b')) === JSON.stringify({ name: 'cx1b', configDir: CX1, model: '', provider: 'codex', permissionMode: 'danger-full-access' }), JSON.stringify(entryOf('cx1b')));
  accounts.set(kCx1, { name: 'cx1b', configDir: CX1, isMain: false, isWorker: true });

  // the session-file prune is a Claude Code thing: no other vendor's home is ever handed to it
  await context.globalState.update('cco.sessionLitter.lastRunAt', 0);
  litterScript.calls.length = 0;
  litterScript.next = (dirs) => dirs.map((d) => ({ configDir: d, scanned: 1, removed: 0, truncated: false, errors: 0 }));
  await fireLitter();
  const pruned = litterScript.calls[0] || [];
  check('I20 the stale-session-file prune covers main and the Claude Code workers only — never ~/.codex*, ~/.cursor or ~/.agy*',
    pruned.includes(mainDir) && pruned.includes(W1) && pruned.includes(C9) && !pruned.some((d) => /\.(codex|cursor|agy)/.test(path.basename(d))), pruned.map((d) => path.basename(d)).join(','));

  /* ====================================================== J. trees with providers */
  const now = Date.now();
  const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const cacheEntry = (name, dir, over) => ({ name, configDir: dir, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: now, ...over });
  const HOSTILE_LABEL = `\u202e${'L'.repeat(5000)}\u2066x\u2069\n2nd`;
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({
    [CX1]: cacheEntry('cx1b', CX1, { available: true, subscriptionType: 'chatgpt', auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now },
      windows: [{ kind: 'session', label: '5h limit', percent: 42, severity: 'normal', resetsAt: new Date(now + 3600e3).toISOString() },
        { kind: 'weekly_all', label: '5h limit', percent: 91, severity: 'critical', resetsAt: null },
        { kind: 'weekly_scoped', label: HOSTILE_LABEL, percent: 7, severity: 'normal', resetsAt: 'not a date' }, null, 'x', { percent: 'NaN' }] }),
    [CURSOR_DEFAULT]: cacheEntry('cur', CURSOR_DEFAULT, { error: 'CLI not found: spawn cursor-agent ENOENT' }),
    [AG1]: cacheEntry('ag1', AG1, { auth: { loggedIn: false, method: null, email: null, checkedAt: now } }),
    [path.join(HOME, '.codex-cx2')]: cacheEntry('cx2', path.join(HOME, '.codex-cx2'), { subscriptionType: 'api-key', auth: { loggedIn: true, method: 'api-key', email: null, checkedAt: now }, error: `quota endpoint said\u202e no\n${'e'.repeat(900)}` }),
  }));
  const wtree = rec.providers['claudeCodeOrchestrator.workers'];
  const wroots = Object.fromEntries(wtree.getChildren().map((w) => [w.name, w]));
  const witem = (name) => wtree.getTreeItem(wroots[name]);
  const wrows = (name) => wtree.getChildren(wroots[name]).map((r) => wtree.getTreeItem(r));
  const rowOf = (name, label) => wrows(name).find((r) => r.label === label);
  check('J1 every account row names its provider first, Claude Code included', witem('w1').description.startsWith('Claude Code · ') && witem('c9').description.startsWith('Claude Code · sonnet')
    && witem('cx1b').description.startsWith('Codex · ') && witem('cur').description.startsWith('Cursor · auto') && witem('ag1').description.startsWith('Antigravity · gemini-3.8-flash-high'),
    ['w1', 'cx1b', 'cur', 'ag1'].map((n) => witem(n).description).join(' || '));
  const icons = ['w1', 'cx1b', 'cur', 'ag1'].map((n) => witem(n).iconPath.id);
  check('J2 the four providers have four different row icons', new Set(icons).size === 4 && icons[0] === 'server-process', icons.join(', '));
  check('J3 context values: worker.claude for Claude Code, worker.<provider>.permission for the rest (what the menus match on)',
    witem('w1').contextValue === 'worker.claude' && witem('cx1b').contextValue === 'worker.codex.permission' && witem('cur').contextValue === 'worker.cursor.permission' && witem('ag1').contextValue === 'worker.gemini.permission',
    ['w1', 'cx1b', 'cur', 'ag1'].map((n) => witem(n).contextValue).join(', '));
  const claudeLabels = wrows('w1').map((r) => r.label);
  const codexLabels = wrows('cx1b').map((r) => r.label);
  check('J4 plan-quota rows appear on Claude Code accounts only; a provider account shows Provider / Login / Usage / Permission mode instead',
    claudeLabels.some((l) => /^Plan/.test(l)) && !claudeLabels.some((l) => ['Provider', 'Login', 'Permission mode'].includes(l) || /^Usage/.test(l))
    && !codexLabels.some((l) => /^Plan/.test(l)) && ['Status', 'Provider', 'Login', 'Permission mode'].every((l) => codexLabels.includes(l)) && codexLabels.some((l) => /^Usage · /.test(l)),
    `claude: ${claudeLabels.join(' | ')} ;; codex: ${codexLabels.map((l) => l.slice(0, 30)).join(' | ')}`);
  check('J5 a provider account shows its login state and its usage windows from the cache, under the VENDOR\'S labels (never "5h" / "7d" / "Fable")',
    rowOf('cx1b', 'Login').description === 'logged in (chatgpt)' && /5h limit 42% · ⚠5h limit 91%/.test(witem('cx1b').description) && !/Fable|7d /.test(witem('cx1b').description)
    && wrows('cx1b').filter((r) => r.label === 'Usage · 5h limit').length === 2 && /^42% · resets in /.test(wrows('cx1b').find((r) => r.label === 'Usage · 5h limit').description), witem('cx1b').description.slice(0, 120));
  const cxRowIds = wrows('cx1b').map((r) => r.id);
  check('J6 two windows the vendor gave the same label still get distinct tree ids (a duplicate id makes VS Code refuse the tree)', new Set(cxRowIds).size === cxRowIds.length, cxRowIds.join(' | ').slice(0, 160));
  const hostileRow = wrows('cx1b').find((r) => /^Usage · L/.test(r.label));
  check('J7 a hostile window label from the cache reaches the row flattened and capped at 40; malformed windows are dropped without a throw',
    hostileRow !== undefined && hostileRow.label.length <= 'Usage · '.length + 40 && !BIDI.test(hostileRow.label) && !CONTROL.test(hostileRow.label) && wrows('cx1b').filter((r) => /^Usage · /.test(r.label)).length === 3
    && !BIDI.test(witem('cx1b').description) && !CONTROL.test(witem('cx1b').description), hostileRow && `${hostileRow.label.length} chars`);
  check('J8 "CLI not found" is shown as that — on the row, on the Login detail and in the hover — not as "logged out"',
    /Cursor · auto · CLI not found$/.test(witem('cur').description) && rowOf('cur', 'Login').description === 'CLI not found' && /not installed, or not on PATH/.test(rowOf('cur', 'Login').tooltip)
    && /could not be started/.test(shown(witem('cur').tooltip)) && rowOf('cur', 'Usage').description === 'no usage reading', witem('cur').description);
  check('J9 a positive "logged out" reads as logged out; for a provider with no login command the Login row says to sign in through its own app',
    /logged out — sign in needed$/.test(witem('ag1').description) && rowOf('ag1', 'Login').description === 'logged out — sign in needed' && /signs in through its own app/.test(rowOf('ag1', 'Login').tooltip)
    && /Logged out/.test(shown(witem('ag1').tooltip)), witem('ag1').description);
  check('J10 logged in with a failed usage half: Login says logged in, Usage says unavailable and carries the (flattened, capped) reason',
    rowOf('cx2', 'Login').description === 'logged in (api-key)' && rowOf('cx2', 'Usage').description === 'usage unavailable' && rowOf('cx2', 'Usage').tooltip.length <= 200
    && !BIDI.test(rowOf('cx2', 'Usage').tooltip) && !CONTROL.test(rowOf('cx2', 'Usage').tooltip) && /logged in \(api-key\) · usage unavailable$/.test(witem('cx2').description), witem('cx2').description);
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({ [CX1]: cacheEntry('cx1b', CX1, {}) }));
  check('J11 no reading at all is "not checked yet"; a reading that says nothing about the login is "login state unknown" — never "logged out"',
    /not checked yet$/.test(witem('cur').description) && rowOf('cur', 'Login').description === 'not checked yet' && rowOf('cx1b', 'Login').description === 'login state unknown'
    && rowOf('cx1b', 'Usage').description === 'no usage reading', `${witem('cur').description} || ${witem('cx1b').description}`);
  check('J12 the permission-mode row shows the worker\'s own mode, the provider default, or "the CLI\'s own default"',
    rowOf('cx1b', 'Permission mode').description === 'danger-full-access' && /mode danger-full-access/.test(witem('cx1b').description) && rowOf('ag1', 'Permission mode').description === 'accept-edits (provider default)'
    && rowOf('cur', 'Permission mode').description === "the CLI's own default" && !/mode /.test(witem('ag1').description), wrows('cx1b').map((r) => `${r.label}=${r.description}`).join(' | ').slice(0, 200));
  const provTip = witem('cx1b').tooltip;
  check('J13 a provider row\'s hover puts the home directory through appendText and says how it is dispatched', provTip.segments.some((s) => s.kind === 'text' && s.value.includes(CX1)) && provTip.segments.some((s) => s.kind === 'text' && /one-shot through the `codex` CLI/.test(s.value))
    && !provTip.segments.some((s) => s.kind === 'md' && s.value.includes(CX1)), provTip.segments.map((s) => `${s.kind}:${s.value.slice(0, 40)}`).join(' | '));
  // a hand-edited registry: hostile name / model on a worker row
  // …and two names made to collide in a `name:seq:label` id: a worker whose NAME is what a detail row of another was called
  registry.updateRegistry((r) => {
    r.workers.push({ name: `\u202eevil${'n'.repeat(5000)}`, configDir: path.join(HOME, '.codex-evil'), model: 'm', provider: 'codex' });
    r.workers.push({ name: 'idclash', configDir: path.join(HOME, '.claude-idclash'), model: 'opus' }, { name: 'idclash:0:Status', configDir: path.join(HOME, '.claude-idclash2'), model: 'opus' }, { name: '"idclash"', configDir: path.join(HOME, '.claude-idclash3'), model: 'opus' });
  });
  const evilWorker = wtree.getChildren().find((w) => w.name.startsWith('\u202eevil'));
  const evilItem = wtree.getTreeItem(evilWorker);
  const evilKids = wtree.getChildren(evilWorker).map((r) => wtree.getTreeItem(r));
  const allIds = wtree.getChildren().flatMap((w) => [wtree.getTreeItem(w).id, ...wtree.getChildren(w).map((r) => wtree.getTreeItem(r).id)]);
  // [second review, §9.4: was `evilItem.id === evilWorker.name` — "the row id stays the registry's own string".] An id built
  // from a name must be unambiguous whatever the name holds: the name goes into it as JSON.
  check('J14 a hostile worker NAME from a hand-edited registry is shown flattened and capped at 64, while the row id carries the registry\'s own string whole and unambiguously: account:<JSON of the name>, and detail:<JSON name>:<seq>:<label> for the rows under it — no two ids of the tree alike, even for names built to collide',
    evilItem.label.length <= 64 && !BIDI.test(evilItem.label) && evilItem.id === `account:${JSON.stringify(evilWorker.name)}`
    && evilKids.length > 0 && evilKids.every((k, i) => typeof k.id === 'string' && k.id.startsWith(`detail:${JSON.stringify(evilWorker.name)}:${i}:`))
    && allIds.includes('account:"idclash"') && allIds.includes('account:"idclash:0:Status"') && allIds.includes('account:"\\"idclash\\""') && allIds.some((id) => id.startsWith('detail:"idclash":0:'))
    && allIds.every((id) => typeof id === 'string' && /^(account|detail):"/.test(id)) && new Set(allIds).size === allIds.length,
    `${evilItem.label.length} chars; ${allIds.length} ids, ${new Set(allIds).size} distinct; ${allIds.filter((id) => id.includes('idclash')).slice(0, 4).join(' | ')}`);
  registry.updateRegistry((r) => { r.workers = r.workers.filter((w) => !w.name.startsWith('\u202eevil') && !w.name.includes('idclash')); });
  registry.updateRegistry((r) => { r.workers.push({ name: 'toString', configDir: path.join(HOME, '.claude-ts'), model: 'opus' }, { name: 'constructor', configDir: path.join(HOME, '.codex-ct'), model: '', provider: 'codex' }); });
  let keyNameErr;
  let keyNameRows = [];
  try {
    for (const w of wtree.getChildren().filter((x) => x.name === 'toString' || x.name === 'constructor')) {
      wtree.getTreeItem(w);
      keyNameRows.push(...wtree.getChildren(w).map((r) => `${w.name}/${wtree.getTreeItem(r).label}=${wtree.getTreeItem(r).description}`));
    }
  } catch (e) { keyNameErr = e; }
  check('J14b a worker in a hand-edited registry whose name is an object key ("toString", "constructor") still renders: its stats read as none, not as an inherited function',
    keyNameErr === undefined && keyNameRows.includes('toString/Dispatch · All time=no dispatches yet') && keyNameRows.includes('constructor/Dispatch · All time=no dispatches yet') && keyNameRows.includes('toString/Status=available'),
    keyNameErr ? keyNameErr.stack.slice(0, 200) : keyNameRows.filter((r) => /All time|Status/.test(r)).join(' | '));
  registry.updateRegistry((r) => { r.workers = r.workers.filter((w) => w.name !== 'toString' && w.name !== 'constructor'); });

  // Tasks tree + Worker History: F7 (flatten and cap) and F2 (dispatch mode)
  const HT = `\u202e${'T'.repeat(5000)}\u2066!\u2069\r\nsecond line`;
  const HW = `w\u200f\u202d${'W'.repeat(5000)}`;
  const HM = `m\u2067\u0007${'M'.repeat(5000)}`;
  const tev = (over) => ({ ts: now, status: 'done', title: 't', worker: 'w1', model: 'opus', outputFile: outFile, cwd: WS, ...over });
  fs.writeFileSync(registry.TASKS_LOG_FILE, [
    tev({ id: 'thost00001', ts: now - 1, title: HT, worker: HW, model: HM, meshWorker: 'cco-h-1' }),
    tev({ id: 'thrun00001', ts: now - 2, status: 'running', title: HT, worker: HW, model: HM }),
    // [2.0: this record also carried `ts: 'yesterday'`.] The trees show the tasks of the shared index, whose one
    // rule (uiModel.acceptEvent) is: a task id, one of the three statuses, and a timestamp that is a time. A
    // record whose timestamp is not a time is not a task on ANY surface — that half is the next record's now.
    tev({ id: 'ttype00001', ts: now - 12, title: 7, worker: { a: 1 }, model: null, error: 5, status: 'error' }),
    tev({ id: 'tbadts0001', ts: 'yesterday', title: 'a record whose timestamp is not a time' }),
    tev({ id: 'tpg0000001', ts: now - 3, status: 'running', pid: 4242, pgid: 4242 }),
    tev({ id: 'tdet000001', ts: now - 9, status: 'running', supervisorPid: 777, pgid: 778 }),
    tev({ id: 'tdet000001', ts: now - 4, status: 'done' }),
    tev({ id: 'tstr000001', ts: now - 5, supervisorPid: '777' }),
    tev({ id: 'tmesh00001', ts: now - 6, meshWorker: 'cco-m-1', supervisorPid: 999 }),
    tev({ id: 'tcdx000001', ts: now - 7, worker: 'cx1b', model: 'gpt-5.5', provider: 'codex' }),
    tev({ id: 'tcdx000002', ts: now - 8, status: 'running', worker: 'cx1b', model: 'gpt-5.5', provider: 'codex', supervisorPid: 4321 }),
    tev({ id: 'tunk000001', ts: now - 10, provider: `we\u202eird${'v'.repeat(500)}` }),
    tev({ id: 'tcla000001', ts: now - 11, provider: 'claude' }),
    tev({ id: 12345, title: 'numeric id' }), tev({ id: '', title: 'empty id' }), tev({ id: { x: 1 }, title: 'object id' }), tev({ id: { x: 1 }, title: 'object id 2' }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  let treeErr;
  let taskRows;
  let taskItems = {};
  let drawnWithTooltip = [];
  try {
    taskRows = tp.getChildren();
    // drawn (getTreeItem) and then hovered (resolveTreeItem), as the editor does it: since 2.0 a row is drawn
    // without its tooltip, and everything that needs a file belongs to the hover
    drawnWithTooltip = taskRows.filter((e) => tp.getTreeItem(e).tooltip !== undefined).map((e) => e.id);
    taskItems = Object.fromEntries(taskRows.map((e) => [e.id, hovered(tp, e)]));
  } catch (e) { treeErr = e; }
  check('J15 the Tasks tree renders (and hovers) a log holding wrong-typed fields without throwing, and skips records with no usable task id or no usable timestamp',
    treeErr === undefined && taskRows.length === 11 && taskRows.every((e) => typeof e.id === 'string' && e.id !== '') && !taskRows.some((e) => e.id === 'tbadts0001') && new Set(Object.values(taskItems).map((i) => i.id)).size === 11, treeErr ? treeErr.stack : `${taskRows.length} rows: ${taskRows.map((e) => e.id).join(',')}`);
  check('J15b no row of the Tasks tree is drawn with a tooltip: each hover is built when asked for (resolveTreeItem), and is a MarkdownString then',
    treeErr === undefined && drawnWithTooltip.length === 0 && Object.values(taskItems).every((i) => i.tooltip instanceof vscode.MarkdownString), drawnWithTooltip.join(',') || 'none');
  const hostItem = taskItems.thost00001;
  const hostParts = String(hostItem.description).split(' · ');
  check('J16 F7: a hostile title (bidi override, isolates, CR LF, 5,000 chars) reaches the Tasks LABEL flattened and capped at 160',
    typeof hostItem.label === 'string' && hostItem.label.length === 160 && /^T+$/.test(hostItem.label) && !BIDI.test(hostItem.label) && !CONTROL.test(hostItem.label), `${hostItem.label.length} chars: ${hostItem.label.slice(0, 12)}…`);
  check('J17 F7: hostile worker and model reach the Tasks DESCRIPTION flattened and capped at 120 / 64',
    hostParts.length === 3 && hostParts[0].length === 120 && /^wW+$/.test(hostParts[0]) && hostParts[1].length === 64 && /^m M+$/.test(hostParts[1]) && hostParts[2] === 'done' && !BIDI.test(hostItem.description) && !CONTROL.test(hostItem.description),
    hostParts.map((p) => p.length).join(' / '));
  const hostTipText = hostItem.tooltip.segments.filter((s) => s.kind === 'text').map((s) => s.value).join('\n');
  check('J18 and the same capped values are what the hover\'s "Model … · Account …" line shows', hostTipText.includes(`Model ${hostParts[1]} · Account ${hostParts[0]}`) && !/W{121}/.test(hostTipText) && !/M{65}/.test(hostTipText));
  check('J19 a title / worker / model that is not a string at all reads as "-" (never "[object Object]"), and a non-string error breaks nothing',
    taskItems.ttype00001.label === '-' && taskItems.ttype00001.description === '- · - · error' && taskItems.ttype00001.iconPath.id === 'error', `${taskItems.ttype00001.label} | ${taskItems.ttype00001.description}`);
  const histRows = hp.getChildren();
  const histHost = hp.getTreeItem(histRows.find((e) => e.id === 'thost00001'));
  const histParts = String(histHost.description).split(' · ');
  check('J20 F7 in the Worker History view: the same title / worker / model arrive flattened and capped at 160 / 120 / 64',
    histHost.label.length === 160 && !BIDI.test(histHost.label) && !CONTROL.test(histHost.label) && histParts[0].length === 120 && histParts[1].length === 64 && !BIDI.test(histHost.description) && !CONTROL.test(histHost.description),
    `${histHost.label.length} / ${histParts.map((p) => p.length).join(' / ')}`);
  const colorOf = (id) => (taskItems[id].iconPath.color ? taskItems[id].iconPath.color.id : 'none');
  // The heading is a translated sentence and goes through appendText; it is compared as a person reads it
  // (shown() takes the escapes out again — `&nbsp;` for every space included, as the editor writes them).
  const modeLine = (id) => shown(taskItems[id].tooltip).split('\n')[0];
  check('F2a a running in-process one-shot that records a pgid is NOT "detached": no colour, "One-shot (claude -p)"', colorOf('tpg0000001') === 'none' && modeLine('tpg0000001') === '**One-shot (claude -p)**' && taskItems.tpg0000001.iconPath.id === 'sync~spin',
    `${colorOf('tpg0000001')} / ${modeLine('tpg0000001')}`);
  check('F2b a task with a numeric supervisorPid on an EARLIER event is "detached" even though its latest event carries none', colorOf('tdet000001') === 'charts.purple' && modeLine('tdet000001') === '**Detached (supervised)**' && taskItems.tdet000001.iconPath.id === 'check',
    `${colorOf('tdet000001')} / ${modeLine('tdet000001')}`);
  check('F2c a supervisorPid that is not a number does not count; a session-worker task stays "mesh" whatever else its events carry', colorOf('tstr000001') === 'none' && colorOf('tmesh00001') === 'charts.blue' && /^\*\*Mesh/.test(modeLine('tmesh00001')),
    `${colorOf('tstr000001')} / ${colorOf('tmesh00001')}`);
  check('J21 a task another vendor\'s CLI ran says so: provider label first on the row, and the hover never calls it "claude -p"',
    taskItems.tcdx000001.description === 'Codex · cx1b · gpt-5.5 · done' && /^\*\*One-shot — Codex\*\*$/.test(modeLine('tcdx000001')) && !/claude\s*-p/i.test(shown(taskItems.tcdx000001.tooltip)) && /One-shot/.test(shown(taskItems.tcdx000001.tooltip))
    && /^\*\*Detached \(supervised\) — Codex\*\*$/.test(modeLine('tcdx000002')) && colorOf('tcdx000002') === 'charts.purple', `${taskItems.tcdx000001.description} / ${modeLine('tcdx000001')} / ${modeLine('tcdx000002')}`);
  const unkDesc = taskItems.tunk000001.description;
  check('J22 an unknown provider id on an event is shown as written but display-safe (≤ 32, no bidi); provider "claude" adds nothing',
    /^weird/.test(unkDesc) && unkDesc.split(' · ')[0].length <= 32 && !BIDI.test(unkDesc) && taskItems.tcla000001.description === 'w1 · opus · done', `${unkDesc.slice(0, 50)} || ${taskItems.tcla000001.description}`);
  // the cancel picker shows the same stored strings
  reset();
  await run('cancelTask');
  const cancelPick = rec.quickPicks[0];
  check('J23 the cancel picker lists running tasks with the same flattened, capped title / account', cancelPick && cancelPick.items.length === 3 && cancelPick.items.every((i) => i.label.length <= 160 && i.description.length <= 120 && !BIDI.test(i.label + i.description) && !CONTROL.test(i.label + i.description))
    && cancelPick.items.some((i) => i.id === 'thrun00001' && i.label.length === 160 && i.description.length === 120), cancelPick && cancelPick.items.map((i) => `${i.id}:${i.label.length}/${i.description.length}`).join(' ; '));
  fs.writeFileSync(registry.TASKS_LOG_FILE, '');
  }

  /* ================================================================== epilogue */
  for (const d of context.subscriptions) { try { d.dispose(); } catch { /* stub disposables */ } }
  check('Z1 dispose removes every file watcher this extension added', watched.length === 0, `${watched.length} left: ${watched.map((w) => path.basename(w.file)).join(',')}`);
  check('Z2 dispose clears the litter timer', litterTimer.cleared === true);
  const strayCalls = fakeCalls().filter((c) => c.argv[0] !== 'stop');
  check('Z3 the fake claude was only ever asked to `stop`', strayCalls.length === 0, JSON.stringify(strayCalls.map((c) => c.argv)));
  check('Z5 no program outside the allowlist was started (blocked attempts are path lookups only, never a CLI run)',
    blockedSpawns.every((b) => /-lc/.test(b) && /command -v/.test(b)), blockedSpawns.join(' ; ') || 'none attempted');
  check('Z4 nothing was written to the real home directory by this probe', os.homedir() === HOME && REAL_HOME !== HOME && registry.ROOT_DIR.startsWith(HOME));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\n${H.passes} passed, ${H.failures} failed`);
  process.exit(H.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`FAIL — probe crashed: ${e && e.stack}`);
  process.exit(1);
});
