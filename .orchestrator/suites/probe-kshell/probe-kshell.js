// probe-kshell — see the banner below. The harness is ../lib/host-harness.js.
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
/* ======================================================================================
 * K-SHELL (wave 4) probe body. The harness above this line is ext-probe2.js's own (sandbox HOME,
 * fake `claude`, spawn allowlist, stub `vscode`, module stand-ins) — see make-probe-kshell.py.
 * What follows probes only what this task changed, one section per item of the brief:
 *
 *   N  K15  the token-count helper
 *   O  K12  own-property reads of the usage cache (and the lookups keyed by data in the views)
 *   P  K8   Worker History / Tasks tooltip / Team rows / dashboard tasks join a task to its
 *           ledger record by TASK ID — two records with the SAME worker name
 *   Q  K9   no tree label, description or tooltip of views.ts / history-view.ts carries English
 *           outside vscode.l10n.t (a marker stub wraps every translated string)
 *   R  K10  the add-worker quick picks
 *   S  K11  a run-recorded logout outlives an optimistic status check; the three events end it
 *   V  K15  window labels, what's-new text, a stopped worker's actions
 *   U  K14  removing an account that still has session workers
 *   T  K13  the registry lock held by a live process: activation, a settings change, user actions
 *
 * Usage: node probe-kshell.js <compiled out dir> <repo root> [<compiled out dir of the tree BEFORE this task>]
 * ====================================================================================== */
(async () => {
  const BASE_OUT = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      check(`${name} — section crashed`, false, e && e.stack);
    }
  };
  const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
  const contract = require(path.join(OUT, 'mesh', 'contract.js'));
  const realTeam = require(path.join(OUT, 'team.js')); // the REAL collector (the shell's own import is the stand-in)
  const providersMod = require(path.join(OUT, 'providers.js'));
  const wmMod = require(path.join(OUT, 'workerManager.js'));
  const dashboardMod = require(path.join(OUT, 'dashboard.js')); // the REAL host module, for its string table

  /* ------------------------------------------------------------------ activation */
  const EXT_DIR = path.join(SANDBOX, 'ext');
  const BUNDLE = path.join(EXT_DIR, 'out', 'mcp');
  fs.mkdirSync(BUNDLE, { recursive: true });
  for (const f of ['server.js', 'run-task.js', 'provider-cli.js']) fs.writeFileSync(path.join(BUNDLE, f), '// stand-in\n');
  const newContext = (version, globals) => {
    const c = {
      subscriptions: [], globalState: memento(), workspaceState: memento(),
      extension: { id: EXTENSION_ID, packageJSON: { version } },
      asAbsolutePath: (p) => path.join(EXT_DIR, p),
    };
    for (const [k, v] of Object.entries(globals || {})) c.globalState._m.set(k, v);
    return c;
  };
  const activate = (context) => {
    captureTimers(true);
    let error;
    try { ext.activate(context); } catch (e) { error = e; }
    captureTimers(false);
    return error;
  };
  const context = newContext('2.0.0');
  const activateError = activate(context);
  await sleep(50);
  check('A0 activate() returns without throwing', activateError === undefined, activateError && activateError.stack);

  const W1 = path.join(HOME, '.claude-w1');
  const W2 = path.join(HOME, '.claude-w2');
  for (const d of [W1, W2]) fs.mkdirSync(d, { recursive: true });
  const CODEX_DEFAULT = providersMod.defaultProviderHome('codex');
  const CURSOR_DEFAULT = providersMod.defaultProviderHome('cursor');
  const AGY_DEFAULT = providersMod.defaultProviderHome('gemini');
  const workersProvider = () => rec.providers['claudeCodeOrchestrator.workers'];
  const tasksProvider = () => rec.treeViews['claudeCodeOrchestrator.tasks'].opts.treeDataProvider;
  const historyProvider = () => rec.providers['claudeCodeOrchestrator.workerHistory'];
  const teamProvider = () => rec.treeViews['claudeCodeOrchestrator.team'].opts.treeDataProvider;
  const LEDGER = contract.meshStateFile(WS);
  const writeLedger = (workers) => {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers }));
  };
  const writeTasks = (events) => {
    fs.mkdirSync(path.dirname(registry.TASKS_LOG_FILE), { recursive: true });
    fs.writeFileSync(registry.TASKS_LOG_FILE, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  };
  const writeUsage = (entries) => fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify(entries, null, 2));
  const readUsage = () => JSON.parse(fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8'));
  const tipText = (tooltip) => (tooltip && typeof tooltip === 'object' && Array.isArray(tooltip.segments) ? tooltip.segments.map((s) => s.value).join('') : String(tooltip ?? ''));
  const setWorkers = (workers) => registry.updateRegistry((r) => { r.workers = workers; });

  /* ================================================================ N. the number helper (K15) */
  await section('N', async () => {
    const f = usage.formatTokenCount;
    const got = { zero: f(0), below: f(9999), at: f(10000), k: f(642812), m: f(17891555), nan: f(NaN), neg: f(-5), negBig: f(-17891555) };
    check('N1 0 → "0"; 9999 → exact (digit grouping only); 10000 → "10.0k"; 642812 → "642.8k"; 17891555 → "17.9M"',
      got.zero === '0' && /^9[,.  \s']?999$/.test(got.below) && got.at === '10.0k' && got.k === '642.8k' && got.m === '17.9M', JSON.stringify(got));
    check('N2 NaN → "0"; a negative count → "0" (never "NaN", never a minus sign)', got.nan === '0' && got.neg === '0' && got.negBig === '0', JSON.stringify([got.nan, got.neg, got.negBig]));
    const edges = { justUnderK: f(999949), rollsToM: f(999950), million: f(1000000), justUnderB: f(999949999), rollsToB: f(999950000), big: f(1.5e12), inf: f(Infinity), str: f('17891555'), nul: f(null), frac: f(1234.6), obj: f({}) };
    check('N3 the unit is chosen from the ROUNDED figure: 999949 → "999.9k", 999950 → "1.0M" (never "1000.0k"); the same step at a billion; 1.5e12 → "1.5T"',
      edges.justUnderK === '999.9k' && edges.rollsToM === '1.0M' && edges.million === '1.0M' && edges.justUnderB === '999.9M' && edges.rollsToB === '1.0B' && edges.big === '1.5T', JSON.stringify(edges));
    check('N4 Infinity, a numeric string, null and an object are "0"; a fraction is rounded', edges.inf === '0' && edges.str === '0' && edges.nul === '0' && edges.obj === '0' && /^1[,.  \s']?235$/.test(edges.frac), JSON.stringify([edges.inf, edges.str, edges.nul, edges.obj, edges.frac]));
    const sweep = [0, 1, 9999, 10000, 99999, 642812, 999949, 999950, 17891555, 999949999999, 999950000000, 1e15, Number.MAX_SAFE_INTEGER];
    for (let e = 0; e <= 15.9; e += 0.01) sweep.push(Math.floor(10 ** e));
    const never = sweep.map(f);
    check(`N5 no input prints four digits before the decimal point of a unit (the "17891.6k" shape): ${sweep.length} values from 0 to Number.MAX_SAFE_INTEGER, which reads "9.0Q"`,
      never.every((s) => /^(\d{1,3}\.\d[kMBTQ]|[\d,.\u00a0\u202f\s']{1,6})$/.test(s)) && f(Number.MAX_SAFE_INTEGER) === '9.0Q' && f(1e15) === '1.0Q' && f(999950000000) === '1.0T',
      never.filter((s) => !/^(\d{1,3}\.\d[kMBTQ]|[\d,.\u00a0\u202f\s']{1,6})$/.test(s)).slice(0, 5).join(' ') || `${never.slice(0, 13).join(' ')}`);
    check('N5b a "count" past Number.MAX_SAFE_INTEGER (2^53, 1e300) is not a count: "0", as in the dashboard model', f(2 ** 53) === '0' && f(1e300) === '0', `${f(2 ** 53)} ${f(1e300)}`);

    // ...and it is what the Workers tree prints.
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }]);
    fs.writeFileSync(registry.STATS_FILE, JSON.stringify({ w1: { tasks: 44, inputTokens: 17891555, outputTokens: 642812, costUsd: 12.5, errors: 0 } }));
    const now = Date.now();
    writeTasks([{ ts: now - 60_000, id: 'tnum000001', status: 'done', title: 'x', worker: 'w1', model: 'opus', cwd: WS, inputTokens: 17891555, outputTokens: 9999 }]);
    const wp = workersProvider();
    const rows = wp.getChildren(wp.getChildren()[0]).map((n) => wp.getTreeItem(n));
    const allTime = rows.find((r) => r.label === 'Dispatch · All time');
    const session = rows.find((r) => r.label === 'Dispatch · Session (5h)');
    check('N6 the Workers tree: all-time row "44 tasks · 17.9M in / 642.8k out · ~$12.50"; the 5-hour row prints 17.9M and the exact 9,999',
      allTime && allTime.description === '44 tasks · 17.9M in / 642.8k out · ~$12.50' && session && /^1 tasks · 17\.9M in \/ 9.?999 out$/.test(session.description),
      `${allTime && allTime.description} || ${session && session.description}`);
    fs.writeFileSync(registry.STATS_FILE, JSON.stringify({ w1: { tasks: 'many', inputTokens: 'lots', outputTokens: -3, costUsd: 'free', errors: 0 } }));
    const hostile = wp.getChildren(wp.getChildren()[0]).map((n) => wp.getTreeItem(n)).find((r) => r.label === 'Dispatch · All time');
    check('N7 a hand-edited stats file (strings, a negative count) prints zeroes and no cost — never "NaN", "undefined" or a thrown row', hostile && hostile.description === '0 tasks · 0 in / 0 out', hostile && hostile.description);
    fs.rmSync(registry.STATS_FILE, { force: true });
  });

  /* ================================================================ O. own-property reads (K12) */
  await section('O', async () => {
    const good = { name: 'w1', configDir: W1, available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now() };
    writeUsage({ [W1]: good, arrayEntry: [1, 2], stringEntry: 'nope', nullEntry: null, numberEntry: 7 });
    const inherited = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'];
    const leaked = inherited.filter((k) => usage.getCachedUsage(k) !== undefined);
    check('O1 getCachedUsage("constructor" / "__proto__" / "toString" / …) is absent — no inherited member is ever a reading', leaked.length === 0, leaked.join(',') || inherited.join(','));
    check('O2 a real entry is still returned; an entry that is an array, a string, null or a number is absent',
      usage.getCachedUsage(W1) && usage.getCachedUsage(W1).subscriptionType === 'max' && ['arrayEntry', 'stringEntry', 'nullEntry', 'numberEntry'].every((k) => usage.getCachedUsage(k) === undefined),
      JSON.stringify(['arrayEntry', 'stringEntry', 'nullEntry', 'numberEntry'].map((k) => typeof usage.getCachedUsage(k))));
    check('O3 a non-string key (a number, an object, undefined) is absent and does not throw', [7, {}, undefined, null].every((k) => { try { return usage.getCachedUsage(k) === undefined; } catch { return false; } }));
    // an OWN key that happens to be called "constructor" is a plain entry like any other
    writeUsage({ constructor: { ...good, configDir: 'constructor' } });
    check('O4 an OWN entry filed under the key "constructor" is a plain entry and is returned', usage.getCachedUsage('constructor') && usage.getCachedUsage('constructor').subscriptionType === 'max');
    writeUsage({ [W1]: good });
    const acct = (dir) => [{ name: 'x', configDir: dir }];
    check('O5 isCacheFresh: an account whose directory is "constructor" / "toString" has NO entry (stale), on a cache that holds neither',
      usage.isCacheFresh(readUsage(), acct('constructor'), Date.now(), 60_000) === false && usage.isCacheFresh(readUsage(), acct('toString'), Date.now(), 60_000) === false && usage.isCacheFresh(readUsage(), acct(W1), Date.now(), 60_000) === true);
    const before = fs.statSync(usage.USAGE_CACHE_FILE).mtimeMs;
    await sleep(15);
    usage.deleteUsageEntries(['constructor', 'toString', '__proto__']);
    check('O6 deleteUsageEntries(["constructor", …]) on a cache that holds none of them rewrites nothing', fs.statSync(usage.USAGE_CACHE_FILE).mtimeMs === before && usage.getCachedUsage(W1) !== undefined);
    const merged = usage.mergeUsageCaches({}, { constructor: { ...good, fetchedAt: 5 } });
    check('O7 mergeUsageCaches keeps a fresh entry keyed "constructor" (it is not compared with Object)', Object.prototype.hasOwnProperty.call(merged, 'constructor') && merged.constructor.fetchedAt === 5);
    const stamps = keepalive.mergeKeepaliveStamps({}, { constructor: { lastAttemptAt: 5, lastSuccessAt: NaN }, toString: { lastAttemptAt: NaN, lastSuccessAt: 9 } });
    check('O8 keepalive stamps: an entry keyed "constructor" / "toString" merges as an own entry', Object.prototype.hasOwnProperty.call(stamps, 'constructor') && stamps.constructor.lastAttemptAt === 5 && stamps.toString.lastSuccessAt === 9);

    if (BASE_OUT) {
      const baseUsage = require(path.join(BASE_OUT, 'usage.js'));
      const got = inherited.filter((k) => baseUsage.getCachedUsage(k) !== undefined);
      check('O8b [the defect, on the tree before this task] the same lookups returned inherited members for most of those keys', got.includes('constructor') && got.includes('toString') && got.includes('__proto__'), got.join(','));
    } else {
      skip('O8b [the defect, on the tree before this task] the same lookups returned inherited members for most of those keys', NO_BASE_BUILD);
    }

    // a window whose KIND is a member every object has: the row shows its label, never a function's source
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }]);
    writeUsage({ [W1]: { ...good, windows: [{ kind: 'constructor', label: 'odd window', percent: 12, severity: 'normal', resetsAt: null }, { kind: 'toString', label: 'second', percent: 3, severity: 'normal', resetsAt: null }] } });
    const wp = workersProvider();
    const row = wp.getTreeItem(wp.getChildren()[0]);
    const kids = wp.getChildren(wp.getChildren()[0]).map((n) => wp.getTreeItem(n));
    check('O9 a usage window whose kind is "constructor" / "toString" is drawn under its own label — no "function" text anywhere on the row or its children',
      /odd window 12%/.test(row.description) && /second 3%/.test(row.description) && ![row.description, tipText(row.tooltip), ...kids.map((k) => `${k.label} ${k.description} ${k.tooltip}`)].some((t) => /function|native code|\[object/.test(t)),
      row.description);
    // a worker NAMED like one, with stats under other names only
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }, { name: 'toString', configDir: W2, model: 'opus' }]);
    fs.writeFileSync(registry.STATS_FILE, JSON.stringify({ w1: { tasks: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, errors: 0 } }));
    const odd = wp.getChildren().find((w) => w.name === 'toString');
    const oddRows = wp.getChildren(odd).map((n) => wp.getTreeItem(n));
    check('O10 a worker named "toString" with no stats of its own reads "no dispatches yet" and "available"', oddRows.some((r) => r.description === 'no dispatches yet') && oddRows.some((r) => r.description === 'available'), oddRows.map((r) => r.description).join(' | '));
    fs.rmSync(registry.STATS_FILE, { force: true });
    writeUsage({});
  });

  /* ================================================================ P. the join is the task id (K8) */
  await section('P', async () => {
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }]);
    const WT = (id) => `.claude/worktrees/cco-${id}`;
    const BR = (id) => `worktree-cco-${id}`;
    const rec0 = (over) => ({ name: 'cco-w-1', account: 'w1', configDir: W1, model: 'opus', role: 'dispatch', ...over });
    // THREE records, ONE worker name. Two belong to two different tasks; the third names no task at all.
    const ledger = [
      rec0({ jobId: 'aaaa1111', spawnedAt: 1000, stoppedAt: 1500, taskId: 'told00001', worktree: WT('told00001'), branch: BR('told00001') }),
      rec0({ jobId: 'bbbb2222', spawnedAt: 2000, stoppedAt: 2500, taskId: 'tnew00001', worktree: WT('tnew00001'), branch: BR('tnew00001') }),
      rec0({ jobId: 'cccc3333', spawnedAt: 3000, stoppedAt: 3500, role: 'adopted', worktree: WT('stray'), branch: 'worktree-stray' }),
    ];
    writeLedger(ledger);
    const now = Date.now();
    const ev = (id, ts, over) => ({ ts, id, status: 'done', title: `title of ${id}`, worker: 'w1', model: 'opus', cwd: WS, meshWorker: 'cco-w-1', outputFile: path.join(SANDBOX, `${id}.md`), ...over });
    writeTasks([
      ev('told00001', now - 3_600_000, { status: 'running' }), ev('told00001', now - 3_000_000),
      ev('tnew00001', now - 600_000, { status: 'running' }), ev('tnew00001', now - 300_000),
      // a third task that ran under the SAME name and whose record is gone from the ledger
      ev('tnone0001', now - 200_000, { status: 'running' }), ev('tnone0001', now - 100_000),
    ]);
    const mk = (id) => fs.mkdirSync(path.join(WS, WT(id)), { recursive: true });
    const rm = (id) => fs.rmSync(path.join(WS, WT(id)), { recursive: true, force: true });
    for (const id of ['told00001', 'tnew00001', 'stray']) mk(id);

    const historyRows = (provider) => {
      const out = {};
      for (const e of provider.getChildren()) {
        const item = hovered(provider, e); // 2.0: the hover is built by resolveTreeItem, not when the row is drawn
        out[e.id] = { description: String(item.description), tip: tipText(item.tooltip) };
      }
      return out;
    };
    const unesc = (s) => s.replace(/\\([\\`*_{}[\]()#+\-!~])/g, '$1');

    // --- variant 1: both tasks' worktrees are on disk
    let h = historyRows(historyProvider());
    check('P1 Worker History, both worktrees on disk: the OLDER row shows ITS branch and the NEWER row shows ITS branch — each flagged unmerged, neither showing the other\'s',
      h.told00001.description === `w1 · opus · ⚠ unmerged branch ${BR('told00001')}` && h.tnew00001.description === `w1 · opus · ⚠ unmerged branch ${BR('tnew00001')}`,
      `${h.told00001.description} || ${h.tnew00001.description}`);
    check('P2 a task that ran under the same name but has NO record carrying its task id shows no branch at all (not the stray record\'s, not a namesake\'s)',
      h.tnone0001.description === 'w1 · opus' && !/Branch/.test(h.tnone0001.tip), `${h.tnone0001.description} | ${unesc(h.tnone0001.tip).replace(/\n+/g, ' / ')}`);
    check('P3 the hovers say the same: each its own "Branch … (unmerged — worktree on disk)"',
      unesc(h.told00001.tip).includes(`Branch ${BR('told00001')} (unmerged — worktree on disk)`) && !unesc(h.told00001.tip).includes(BR('tnew00001'))
      && unesc(h.tnew00001.tip).includes(`Branch ${BR('tnew00001')} (unmerged — worktree on disk)`) && !unesc(h.tnew00001.tip).includes(BR('told00001')));

    // --- variant 2: the OLDER task's worktree is gone (merged and cleaned); the newer one's is not
    rm('told00001');
    h = historyRows(historyProvider());
    check('P4 with the older task\'s worktree gone: the older row reads "branch …" WITHOUT the unmerged mark, the newer row keeps its own mark',
      h.told00001.description === `w1 · opus · branch ${BR('told00001')}` && h.tnew00001.description === `w1 · opus · ⚠ unmerged branch ${BR('tnew00001')}`
      && unesc(h.told00001.tip).includes(`Branch ${BR('told00001')}`) && !/unmerged/.test(h.told00001.tip),
      `${h.told00001.description} || ${h.tnew00001.description}`);
    // --- variant 3: the other way round
    mk('told00001'); rm('tnew00001');
    h = historyRows(historyProvider());
    check('P5 with the NEWER task\'s worktree gone instead: the marks swap — the mark follows the task, not the name',
      h.told00001.description === `w1 · opus · ⚠ unmerged branch ${BR('told00001')}` && h.tnew00001.description === `w1 · opus · branch ${BR('tnew00001')}`,
      `${h.told00001.description} || ${h.tnew00001.description}`);
    mk('tnew00001'); rm('told00001'); // back to variant 2 for the rest

    if (BASE_OUT) {
      // The tree as it was before this task, loaded beside the new one (same sandbox, same files).
      const baseHistory = require(path.join(BASE_OUT, 'history-view.js'));
      const baseProvider = new baseHistory.WorkerHistoryProvider();
      const b = historyRows(baseProvider);
      baseProvider.dispose();
      check('P6 [the defect, on the tree before this task] the same ledger gave BOTH rows one record\'s branch — the name-keyed join',
        b.told00001.description === b.tnew00001.description && b.tnone0001.description === b.tnew00001.description && !b.told00001.description.includes(BR('told00001')),
        `base: ${b.told00001.description} || ${b.tnew00001.description} || ${b.tnone0001.description}`);
    } else {
      skip("P6 [the defect, on the tree before this task] the same ledger gave BOTH rows one record's branch — the name-keyed join", NO_BASE_BUILD);
    }

    // --- Tasks tree tooltips
    const tp = tasksProvider();
    const tips = {};
    for (const e of tp.getChildren()) tips[e.id] = unesc(tipText(hovered(tp, e).tooltip)); // 2.0: built on hover
    check('P7 Tasks tree hover: each session-worker task names ITS worktree and branch',
      tips.told00001.includes(`worktree ${WT('told00001')} (branch ${BR('told00001')})`) && !tips.told00001.includes('tnew00001')
      && tips.tnew00001.includes(`worktree ${WT('tnew00001')} (branch ${BR('tnew00001')})`) && !tips.tnew00001.includes('told00001'),
      [tips.told00001, tips.tnew00001].map((t) => (t.split('\n').find((l) => /^cwd /.test(l)) || '').replace(WS, '<ws>')).join(' || '));
    check('P8 Tasks tree hover of the task with no record of its own: the cwd line, and no worktree from a namesake', /\ncwd [^\n]*\n/.test(`${tips.tnone0001}\n`) && !/worktree/.test(tips.tnone0001), (tips.tnone0001.split('\n').find((l) => /^cwd /.test(l)) || '').replace(WS, '<ws>'));

    // --- Team rows (the REAL collector) and the dashboard model built from them
    realTeam.invalidateTeamCache();
    const sessions = realTeam.collectSessions({ workspaceRoot: WS, scope: 'workspace', maxAgeMs: 0 });
    const byKey = Object.fromEntries(sessions.map((s) => [s.key, s]));
    check('P9 Team rows are keyed by JOB ID: three records of one name are told apart — the older worker (worktree gone) is history, the newer one and the stray one are listed, each with its own task, branch and unmerged state',
      byKey['worker:aaaa1111'] === undefined && byKey['worker:bbbb2222'] && byKey['worker:bbbb2222'].taskId === 'tnew00001' && byKey['worker:bbbb2222'].branch === BR('tnew00001') && byKey['worker:bbbb2222'].unmerged === true
      && byKey['worker:bbbb2222'].taskTitle === 'title of tnew00001' && byKey['worker:cccc3333'] && byKey['worker:cccc3333'].taskId === null && byKey['worker:cccc3333'].taskTitle === null && byKey['worker:cccc3333'].branch === 'worktree-stray',
      JSON.stringify(sessions.map((s) => [s.key, s.name, s.taskId, s.branch, s.unmerged])));
    const model = uiModel.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: {}, health: {}, sessions });
    const task = Object.fromEntries(model.tasks.map((t) => [t.id, t]));
    check('P10 dashboard tasks: the newer task carries ITS branch and unmerged:true; the older task (worktree gone) carries none and unmerged:false — not its namesake\'s; the record-less task carries none',
      task.tnew00001.branch === BR('tnew00001') && task.tnew00001.unmerged === true && task.told00001.branch === null && task.told00001.unmerged === false && task.tnone0001.branch === null && task.tnone0001.unmerged === false
      && [task.told00001, task.tnew00001, task.tnone0001].every((t) => t.sessionWorker === 'cco-w-1' && t.mode === 'session'),
      JSON.stringify(model.tasks.map((t) => [t.id, t.sessionWorker, t.branch, t.unmerged])));
    mk('told00001');
    realTeam.invalidateTeamCache();
    const both = realTeam.collectSessions({ workspaceRoot: WS, scope: 'workspace', maxAgeMs: 0 });
    const model2 = uiModel.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: {}, health: {}, sessions: both });
    const task2 = Object.fromEntries(model2.tasks.map((t) => [t.id, t]));
    check('P11 with both worktrees on disk: both workers are Team rows, and each dashboard task shows its OWN branch, unmerged',
      both.some((s) => s.key === 'worker:aaaa1111' && s.taskId === 'told00001' && s.branch === BR('told00001')) && task2.told00001.branch === BR('told00001') && task2.told00001.unmerged === true
      && task2.tnew00001.branch === BR('tnew00001') && task2.tnew00001.unmerged === true && task2.tnone0001.branch === null,
      JSON.stringify(model2.tasks.map((t) => [t.id, t.branch, t.unmerged])));

    // --- the join helper itself
    const j = views.ledgerRecordForTask;
    const failover = [rec0({ jobId: 'f1', spawnedAt: 1, taskId: 'tfail0001', name: 'cco-w-1' }), rec0({ jobId: 'f2', spawnedAt: 2, taskId: 'tfail0001', name: 'cco-w-2' })];
    check('P12 ledgerRecordForTask: no task id → nothing; a record with no task id is never returned; among records of ONE task (a failover) the event\'s worker name chooses, else the newest',
      j(ledger, undefined, 'cco-w-1') === undefined && j(ledger, '', 'cco-w-1') === undefined && j(ledger, 'tnone0001', 'cco-w-1') === undefined && j(ledger, 'told00001', 'someone-else').jobId === 'aaaa1111'
      && j(failover, 'tfail0001', 'cco-w-1').jobId === 'f1' && j(failover, 'tfail0001', 'cco-w-2').jobId === 'f2' && j(failover, 'tfail0001', 'gone').jobId === 'f2' && j(failover, 'tfail0001').jobId === 'f2');
    check('P13 worktreeOnDisk contains the recorded path: an absolute path, "..", the workspace root itself and a missing directory are all "no"',
      views.worktreeOnDisk(WS, { worktree: WT('tnew00001') }) === true && views.worktreeOnDisk(WS, { worktree: HOME }) === false && views.worktreeOnDisk(WS, { worktree: '..' }) === false
      && views.worktreeOnDisk(WS, { worktree: '.' }) === false && views.worktreeOnDisk(WS, { worktree: WT('nope') }) === false && views.worktreeOnDisk(undefined, { worktree: WT('tnew00001') }) === false && views.worktreeOnDisk(WS, { worktree: 7 }) === false);
    for (const id of ['told00001', 'tnew00001', 'stray']) rm(id);
  });

  /* ================================================================ V. details a person notices (K15) */
  await section('V', async () => {
    // --- a stopped worker: no Attach, no Logs, still Diff while its worktree exists
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }]);
    fs.mkdirSync(path.join(WS, '.claude/worktrees/cco-tstop0001'), { recursive: true });
    fs.mkdirSync(path.join(W1, 'sessions'), { recursive: true });
    // a LIVE worker beside it: a session entry of this very process (alive by construction)
    fs.writeFileSync(path.join(W1, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'eeee5555-0000-4000-8000-000000000000', jobId: 'eeee5555', name: 'cco-w-2', kind: 'bg', status: 'idle', cwd: WS, messagingSocketPath: '/tmp/x.sock', updatedAt: Date.now() }));
    writeLedger([
      { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'dddd4444', model: 'opus', role: 'dispatch', spawnedAt: 1000, stoppedAt: 2000, taskId: 'tstop0001', worktree: '.claude/worktrees/cco-tstop0001', branch: 'worktree-cco-tstop0001' },
      { name: 'cco-w-2', account: 'w1', configDir: W1, jobId: 'eeee5555', model: 'opus', role: 'dispatch', spawnedAt: Date.now() - 60_000, settledAt: Date.now() - 30_000, taskId: 'tlive0001', worktree: '.claude/worktrees/cco-tlive0001', branch: 'worktree-cco-tlive0001' },
    ]);
    writeTasks([]);
    realTeam.invalidateTeamCache();
    const rows = realTeam.collectSessions({ workspaceRoot: WS, scope: 'workspace', maxAgeMs: 0 });
    const stopped = rows.find((s) => s.key === 'worker:dddd4444');
    const live = rows.find((s) => s.key === 'worker:eeee5555');
    check('V1 a STOPPED session worker whose worktree exists: canAttach false, canStop false, and it keeps its branch (unmerged)', stopped && stopped.status === 'stopped' && stopped.canAttach === false && stopped.canStop === false && stopped.branch === 'worktree-cco-tstop0001' && stopped.unmerged === true,
      JSON.stringify(stopped && [stopped.status, stopped.canAttach, stopped.canStop, stopped.branch, stopped.unmerged]));
    check('V2 a LIVE (parked) session worker beside it is still attachable and stoppable', live && live.status === 'idle' && live.canAttach === true && live.canStop === true, JSON.stringify(live && [live.status, live.canAttach, live.canStop]));
    // the Team view built from those rows
    team.sessions = rows;
    const tv = teamProvider();
    const items = Object.fromEntries(tv.getChildren().flatMap((g) => tv.getChildren(g)).map((s) => [s.key, tv.getTreeItem(s)]));
    check('V3 Team view: the stopped row\'s context value offers the branch diff and neither attach/logs nor stop; the live row offers all of them',
      items['worker:dddd4444'].contextValue === 'session.worker.branch' && items['worker:eeee5555'].contextValue === 'session.worker.attachable.stoppable.branch',
      `${items['worker:dddd4444'].contextValue} | ${items['worker:eeee5555'].contextValue}`);
    reset();
    await teamView.pickSessionAction(stopped);
    const offered = rec.quickPicks[0].items.map((i) => i.action);
    check('V4 the action pick of the stopped row: Diff and Copy Name only — no Attach, no Logs, no Stop', JSON.stringify(offered) === JSON.stringify(['openDiff', 'copyName']), offered.join(','));
    const model = uiModel.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: {}, health: {}, sessions: rows });
    const ms = model.sessions.find((s) => s.key === 'worker:dddd4444');
    check('V5 the dashboard model carries the same: canAttach false, canStop false, branch kept (the page shows Attach / Logs from canAttach and Diff from the branch)', ms && ms.canAttach === false && ms.canStop === false && ms.branch === 'worktree-cco-tstop0001' && ms.source === 'worker');
    const page = fs.readFileSync(path.join(REPO, 'media', 'dashboard', 'dashboard.js'), 'utf8');
    check('V6 the page draws Attach and Logs from canAttach and Diff from the branch (source read)', page.includes('show(attach, s.canAttach && usable);') && page.includes('show(logs, s.canAttach && usable);') && page.includes("show(diff, s.source === 'worker' && s.branch !== null && usable);"));
    team.sessions = [];
    fs.rmSync(path.join(W1, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true });
    writeLedger([]);

    // --- usage-window labels
    const CX = path.join(HOME, '.codex-vx');
    setWorkers([{ name: 'vx', configDir: CX, model: '', provider: 'codex' }]);
    const win = (label, percent) => ({ kind: 'session', label, percent, severity: 'normal', resetsAt: new Date(Date.now() + 125 * 60_000).toISOString() });
    writeUsage({ [CX]: { name: 'vx', configDir: CX, available: true, subscriptionType: 'chatgpt', windows: [win('primary', 34), win('secondary', 81), win('Weekly limit', 5), win(' PRIMARY ', 9)], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now(), auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: Date.now() } } });
    const wp = workersProvider();
    const row = wp.getTreeItem(wp.getChildren()[0]);
    const kids = wp.getChildren(wp.getChildren()[0]).map((n) => wp.getTreeItem(n));
    const usageRows = kids.filter((k) => /^Usage · /.test(k.label)).map((k) => k.label);
    check('V7 Workers tree: a bare "primary" / "secondary" window reads "Primary limit" / "Secondary limit" (whatever its case or padding); any other label is kept as given',
      JSON.stringify(usageRows) === JSON.stringify(['Usage · Primary limit', 'Usage · Secondary limit', 'Usage · Weekly limit', 'Usage · Primary limit'])
      && /Primary limit 34% · Secondary limit 81% · Weekly limit 5%/.test(row.description) && !/\bprimary\b|\bsecondary\b/.test(row.description), `${usageRows.join(' | ')} || ${row.description}`);
    const first = kids.find((k) => k.label === 'Usage · Primary limit');
    check('V8 its reset is a whole phrase from the timestamp ("in 2h 5m"), on the row and in the hover', first.description === '34% · resets in 2h 5m' && /Primary limit: 34%, resets in 2h 5m\.$/.test(first.tooltip), `${first.description} | ${first.tooltip}`);
    const strings = dashboardMod.dashboardStrings();
    check('V9 dashboard: the string table carries the two names, and the page maps exactly those two bare words to them (source read)',
      strings.winPrimary === 'Primary limit' && strings.winSecondary === 'Secondary limit'
      && page.includes("return bare === 'primary' ? t('winPrimary') : bare === 'secondary' ? t('winSecondary') : w.label;") && page.includes("class: 'meter-label', text: windowLabel(w)"));
    writeUsage({});

    // --- the localized time phrases
    const t0 = 1_800_000_000_000;
    const ago = (ms) => views.agoText(t0 - ms, t0);
    const until = (ms) => views.untilText(new Date(t0 + ms).toISOString(), t0);
    check('V10 agoText: "just now" under a minute (and for a future instant), then whole minutes, hours, days; "—" for no timestamp',
      ago(0) === 'just now' && ago(59_000) === 'just now' && ago(-5_000) === 'just now' && ago(60_000) === '1m ago' && ago(59 * 60_000) === '59m ago' && ago(60 * 60_000) === '1h ago' && ago(23.9 * 3_600_000) === '23h ago' && ago(49 * 3_600_000) === '2d ago'
      && views.agoText(undefined) === '—' && views.agoText(NaN) === '—' && views.agoText('1700000000000') === '—', [ago(0), ago(60_000), ago(3_600_000), ago(49 * 3_600_000)].join(' | '));
    check('V11 untilText: "now" once passed, "in 12m", "in 2h 5m", "in 3d 4h"; "—" for an absent or unparseable time',
      until(0) === 'now' && until(-60_000) === 'now' && until(20_000) === 'in 1m' && until(12 * 60_000) === 'in 12m' && until(125 * 60_000) === 'in 2h 5m' && until((3 * 24 + 4) * 3_600_000) === 'in 3d 4h'
      && views.untilText(null) === '—' && views.untilText('tomorrow') === '—' && views.untilText(12345) === '—', [until(12 * 60_000), until(125 * 60_000), until((3 * 24 + 4) * 3_600_000)].join(' | '));

    // --- the "what's new" notice
    reset();
    const upgraded = newContext('2.0.0', { 'cco.lastNotifiedVersion': '1.6.0' });
    // (also looked at across this second activation: the stable server copies, which the first one wrote from the
    // same bundle — second review, §9.1)
    const STABLE_DIR = path.join(registry.ROOT_DIR, 'mcp');
    const stableState = () => ['server.js', 'run-task.js', 'provider-cli.js'].map((f) => { const st = fs.lstatSync(path.join(STABLE_DIR, f), { bigint: true }); return `${f}:${st.isFile()}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`; }).join(' ');
    const stableBefore = stableState();
    const upgradeError = activate(upgraded);
    await sleep(30);
    check('V13 a second activation over the same bundle does not rewrite the stable server copies: each is the same file as before — inode, size, modification and change time — and nothing else is in that directory',
      stableState() === stableBefore && fs.readdirSync(STABLE_DIR).sort().join(',') === 'provider-cli.js,run-task.js,server.js' && fs.readFileSync(path.join(STABLE_DIR, 'server.js'), 'utf8') === '// stand-in\n',
      fs.readdirSync(STABLE_DIR).sort().join(','));
    const whatsNew = rec.messages.find((m) => /Claude Code Orchestrator 2\.0\.0:/.test(m.msg));
    check('V12 the "what\'s new" notice says the CLI version is needed FOR SESSION WORKERS — "Session workers need Claude Code 2.1.283 or newer." — and no longer "Needs Claude Code …"',
      upgradeError === undefined && whatsNew && /Session workers need Claude Code 2\.1\.283 or newer\.$/.test(whatsNew.msg) && !/\. Needs Claude Code/.test(whatsNew.msg) && platform.MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS === '2.1.283',
      whatsNew && whatsNew.msg.slice(-90));
  });

  /* ================================================================ R. the add-worker quick picks (K10) */
  await section('R', async () => {
    const items = ext.providerPickItems();
    const details = items.map((i) => i.detail);
    check('R1 the provider pick: label = the product name; description = the CLI command and two words of status',
      JSON.stringify(items.map((i) => i.label)) === JSON.stringify(['Claude Code', 'Codex', 'Cursor', 'Antigravity'])
      && JSON.stringify(items.map((i) => i.description)) === JSON.stringify(['claude · attachable sessions', 'codex · one-shot only', 'cursor-agent · one-shot only', 'agy · one-shot only']),
      items.map((i) => `${i.label} — ${i.description}`).join(' | '));
    check('R2 every detail is ONE sentence of at most 90 characters', details.every((d) => d.length <= 90 && (d.match(/[.!?](\s|$)/g) || []).length === 1), details.map((d) => `${d.length}: ${d}`).join(' | '));
    const heads = details.map((d) => d.slice(0, 40));
    check('R3 the four details differ within their first 40 characters — what tells the providers apart is not cut off', new Set(heads).size === 4, heads.join(' | '));
    check('R4 Claude Code: takes every dispatch that names no provider; the others: used only when a dispatch names the provider or the worker',
      /^Takes every dispatch that names no provider\.$/.test(details[0]) && ['Codex', 'Cursor', 'Antigravity'].every((label, i) => details[i + 1] === `Used only when a dispatch names ${label} or the worker.`), details.join(' | '));

    // every other pick of the add flow, as actually shown
    setWorkers([]);
    const shown = [];
    const drive = async (picks, name) => {
      reset();
      answers.quickPick.push(...picks);
      if (name) answers.input.push(name);
      answers.message.push(() => undefined, () => undefined, () => undefined);
      await run('addWorker');
      shown.push(...rec.quickPicks.slice(1).flatMap((q) => q.items.map((i) => ({ flow: name, label: i.label, description: i.description, detail: i.detail }))));
    };
    const pickLabel = (label) => (list) => list.find((i) => i.label === label);
    const pickLogin = (login) => (list) => list.find((i) => i.login === login);
    const pickStore = (store) => (list) => list.find((i) => i.store === store);
    await drive([pickLabel('Codex'), pickLogin('separate'), pickStore('keychain'), pickLabel('Let the CLI choose')], 'rcx');
    await drive([pickLabel('Antigravity'), pickLogin('separate')], 'rag'); // the modal is dismissed: nothing is added
    await drive([pickLabel('Cursor'), pickLabel('auto')], 'rcu');
    const withDetail = shown.filter((i) => typeof i.detail === 'string');
    const tooLong = withDetail.filter((i) => i.detail.length > 90);
    check(`R5 login choice, Codex login storage and model picks (${withDetail.length} items with a detail line): none is longer than 90 characters`, withDetail.length >= 8 && tooLong.length === 0,
      tooLong.map((i) => `${i.detail.length}: ${i.detail}`).join(' | ') || `longest ${Math.max(...withDetail.map((i) => i.detail.length))}`);
    const find = (label) => shown.find((i) => i.label === label);
    const sep = shown.filter((i) => i.label === 'Sign in separately, in a new home directory');
    check('R6 login choice: the separate login says what it gives (Codex: a second account, by CODEX_HOME) or — first — that it may not (Antigravity: "⚠ Not verified …")',
      sep.length === 2 && /^A second account: CODEX_HOME /.test(sep[0].detail) && /^⚠ Not verified for Antigravity: /.test(sep[1].detail) && /AGY_HOME/.test(sep[1].detail), sep.map((i) => i.detail).join(' | '));
    check('R7 Codex login storage: the trade-off is the two words beside each label; the line under it says where the sign-in lives',
      find('System keychain').description === 'no plan-usage reading' && /keychain/.test(find('System keychain').detail)
      && find("File in the account folder (Codex's default)").description === 'plan usage readable' && /auth\.json/.test(find("File in the account folder (Codex's default)").detail),
      `${find('System keychain').description} / ${find('System keychain').detail}`);
    check('R8 model pick: "Let the CLI choose" and "Enter another model id…" each make their point in one line', /^No default is stored: /.test(find('Let the CLI choose').detail) && /^Any Codex model id — /.test(find('Enter another model id…').detail),
      `${find('Let the CLI choose').detail} | ${find('Enter another model id…').detail}`);
    setWorkers([]);
    for (const d of ['.codex-rcx', '.agy-rag']) fs.rmSync(path.join(HOME, d), { recursive: true, force: true });
    writeUsage({});
  });

  /* ================================================================ S. a run-recorded logout (K11) */
  await section('S', async () => {
    const cur = { name: 'cur', configDir: CURSOR_DEFAULT };
    const cx = { name: 'cx', configDir: path.join(HOME, '.codex-s') };
    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }, { name: 'cur', configDir: CURSOR_DEFAULT, model: '', provider: 'cursor' }, { name: 'cx', configDir: cx.configDir, model: '', provider: 'codex' }, { name: 'ag', configDir: AGY_DEFAULT, model: '', provider: 'gemini' }]);
    writeUsage({});
    const OUT_ST = { cliFound: true, loggedIn: false, mode: null, quota: null, error: null };
    const IN_ST = { cliFound: true, loggedIn: true, mode: 'cursor', quota: null, error: null };
    const entry = (w) => usage.getCachedUsage(w.configDir);
    const auth = (w) => usage.parseAuth(entry(w) && entry(w).auth);
    const MIN = 60_000;
    const T0 = Date.now() - 20 * MIN;

    usage.recordProviderStatus(cur, OUT_ST, T0, { fromRun: true });
    check('S1 a logout recorded BECAUSE A RUN FAILED carries its provenance in the stored entry: auth.fromRun === true and auth.fromRunAt = the time of the run',
      auth(cur) && auth(cur).loggedIn === false && auth(cur).fromRun === true && auth(cur).fromRunAt === T0 && readUsage()[CURSOR_DEFAULT].auth.fromRun === true && usage.isLoginExpired(entry(cur)) && usage.runLoginFailureAt(entry(cur), T0 + MIN) === T0,
      JSON.stringify(readUsage()[CURSOR_DEFAULT].auth));

    {
      // the named form of the same call: what the dispatch server calls where a run fails on login
      const probe = { name: 'cx', configDir: cx.configDir };
      usage.recordProviderRunLoginFailure(probe, T0);
      const viaName = JSON.stringify(readUsage()[cx.configDir]);
      writeUsage({ [CURSOR_DEFAULT]: readUsage()[CURSOR_DEFAULT] });
      usage.recordProviderStatus(probe, OUT_ST, T0, { fromRun: true });
      check('S1b recordProviderRunLoginFailure(worker, now) files exactly the entry recordProviderStatus(worker, <logged out>, now, { fromRun: true }) files', viaName === JSON.stringify(readUsage()[cx.configDir]) && JSON.parse(viaName).auth.fromRun === true && JSON.parse(viaName).auth.fromRunAt === T0, viaName);
      writeUsage({ [CURSOR_DEFAULT]: readUsage()[CURSOR_DEFAULT] });
    }

    // the optimistic status check, a minute later
    usage.recordProviderStatus(cur, IN_ST, T0 + MIN);
    check('S2 a status refresh that says "logged in" does NOT clear it: still logged out, still marked, still expired for dispatch — and the reading counts as taken at the refresh (fetchedAt advances)',
      auth(cur).loggedIn === false && auth(cur).fromRun === true && auth(cur).fromRunAt === T0 && usage.isLoginExpired(entry(cur)) && entry(cur).fetchedAt === T0 + MIN && entry(cur).available === false && entry(cur).error === undefined,
      JSON.stringify([auth(cur), entry(cur).fetchedAt - T0]));
    usage.recordProviderStatus(cur, { ...IN_ST, quota: { allowed: true, windows: [{ label: 'primary', usedPercent: 10, resetAt: null }] } }, T0 + 2 * MIN);
    usage.recordProviderStatus(cur, { cliFound: true, loggedIn: null, mode: null, quota: null, error: 'status timed out' }, T0 + 3 * MIN);
    usage.recordProviderStatus(cur, { cliFound: false, loggedIn: null, mode: null, quota: null, error: null }, T0 + 4 * MIN);
    usage.recordProviderStatus(cur, 'not a status at all', T0 + 5 * MIN);
    check('S3 nor does any other reading that did not come from a run: one WITH a usage snapshot, an unknown login with an error, "CLI not found", a malformed status — the verdict stands, with no windows and no error attached',
      auth(cur).loggedIn === false && auth(cur).fromRunAt === T0 && usage.isLoginExpired(entry(cur)) && entry(cur).windows.length === 0 && entry(cur).error === undefined && entry(cur).fetchedAt === T0 + 5 * MIN,
      JSON.stringify([auth(cur), entry(cur).windows.length, entry(cur).error]));
    {
      // the extension's own refresh driver, with the helper missing: the failure entry is held back too
      const usagePath = require.resolve(path.join(OUT, 'usage.js'));
      const patched = require.cache[usagePath];
      delete require.cache[usagePath];
      const fresh = require(usagePath); // a second instance of the module, whose refresh driver is the real one
      require.cache[usagePath] = patched;
      await fresh.refreshProviderUsage({ helperPath: path.join(SANDBOX, 'no-such', 'provider-cli.js'), polling: true, force: true });
      check('S4 a refresh whose helper could not run at all leaves the verdict in force for that account — and still files its failure for an account with no such verdict',
        auth(cur).loggedIn === false && auth(cur).fromRun === true && entry(cur).error === undefined && /provider helper/.test(String(entry(cx) && entry(cx).error)), JSON.stringify([auth(cur), entry(cx) && entry(cx).error]));
    }

    // what the UI says meanwhile
    const wp = workersProvider();
    const node = wp.getChildren().find((w) => w.name === 'cur');
    const item = wp.getTreeItem(node);
    const loginRow = wp.getChildren(node).map((n) => wp.getTreeItem(n)).find((r) => r.label === 'Login');
    check('S5 Workers tree: the account is shown LOGGED OUT, with the detail that the last run failed on login — on the row, on its Login row, and explained in the hover',
      /logged out — the last run failed on login/.test(item.description) && loginRow.description === 'logged out — the last run failed on login' && loginRow.iconPath.id === 'warning'
      && /The last dispatch to this account failed on login \(\d+m ago\)\./.test(loginRow.tooltip) && /cursor-agent/.test(loginRow.tooltip) && /30 minutes/.test(loginRow.tooltip), `${item.description} || ${loginRow.tooltip}`);
    const model = uiModel.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: {}, health: {}, sessions: [] });
    const acct = model.accounts.find((a) => a.name === 'cur');
    check('S6 dashboard model: login "expired" with loginDetail = the run-failure marker; the page shows its own text for exactly that marker',
      acct && acct.login === 'expired' && acct.loginDetail === uiModel.RUN_LOGIN_FAILURE_DETAIL && acct.loginDetail === 'the last run failed on login'
      && fs.readFileSync(path.join(REPO, 'media', 'dashboard', 'dashboard.js'), 'utf8').includes("const RUN_LOGIN_FAILURE_DETAIL = 'the last run failed on login';")
      && typeof dashboardMod.dashboardStrings().acctExpiredBodyRun === 'string', JSON.stringify(acct && [acct.login, acct.loginDetail]));

    // (from here on the readings are taken "now": S4's refresh filed its entries at the real time,
    // and the cache keeps the NEWEST reading of an account, as it must)
    // (a) a run for the account succeeds
    usage.recordProviderRunSucceeded(cur);
    check('S7 (a) a successful RUN clears it: the account reads logged in, the mark is gone, it is no longer expired for dispatch',
      auth(cur).loggedIn === true && auth(cur).fromRun === undefined && !('fromRun' in readUsage()[CURSOR_DEFAULT].auth) && !usage.isLoginExpired(entry(cur)) && usage.runLoginFailureAt(entry(cur)) === undefined, JSON.stringify(readUsage()[CURSOR_DEFAULT].auth));
    const afterSuccess = fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8');
    usage.recordProviderRunSucceeded(cur);
    usage.recordProviderRunSucceeded({ name: 'main', configDir: platform.hostConfigDir() });
    usage.recordProviderRunSucceeded({ name: 'w1', configDir: W1 });
    usage.recordProviderRunSucceeded({ name: 'nobody', configDir: path.join(HOME, '.codex-none') });
    usage.recordProviderRunSucceeded(undefined);
    check('S8 recordProviderRunSucceeded with nothing to correct writes NOTHING (an account already logged in, an unknown account, a Claude Code account\'s directory, no worker at all)', fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8') === afterSuccess);

    // (b) the user re-logs in from the extension
    usage.recordProviderStatus(cur, OUT_ST, undefined, { fromRun: true });
    usage.recordProviderStatus(cur, IN_ST);
    const heldBeforeRelogin = auth(cur).fromRun === true && auth(cur).loggedIn === false;
    reset();
    await run('reloginWorker', { configDir: CURSOR_DEFAULT });
    const afterRelogin = auth(cur);
    usage.recordProviderStatus(cur, IN_ST);
    check('S9 (b) the re-login command clears the MARK (the account still reads logged out until a reading says otherwise), opens `cursor-agent login`, and the next status reading is believed',
      heldBeforeRelogin && afterRelogin.loggedIn === false && afterRelogin.fromRun === undefined && rec.terminals.length === 1 && rec.terminals[0].sent.join('|') === 'cursor-agent login' && auth(cur).loggedIn === true,
      JSON.stringify([afterRelogin, rec.terminals.map((t) => t.sent), auth(cur)]));
    // ...also for a provider with no login command (the user is sent to its app), and from the tree's Login command
    const ag = { name: 'ag', configDir: AGY_DEFAULT };
    usage.recordProviderStatus(ag, OUT_ST, undefined, { fromRun: true });
    reset();
    await run('reloginWorker', { configDir: AGY_DEFAULT });
    const agCleared = auth(ag).fromRun === undefined && auth(ag).loggedIn === false && rec.terminals.length === 0 && rec.messages.some((m) => /has no login command/.test(m.msg));
    usage.recordProviderStatus(cx, OUT_ST, undefined, { fromRun: true });
    reset();
    await run('loginWorker', { name: 'cx' });
    check('S10 the same for a provider that signs in through its app (no terminal, the mark still cleared) and for the tree\'s Login command', agCleared && auth(cx).fromRun === undefined && rec.terminals.length === 1 && rec.terminals[0].sent.join('|') === 'codex login',
      JSON.stringify([agCleared, auth(cx), rec.terminals.map((t) => t.sent)]));

    // (c) thirty minutes
    const T1 = Date.now() - 31 * MIN;
    writeUsage({});
    usage.recordProviderStatus(cur, OUT_ST, T1, { fromRun: true });
    usage.recordProviderStatus(cur, IN_ST, T1 + 29 * MIN);
    const heldAt29 = auth(cur).loggedIn === false && auth(cur).fromRun === true;
    const inForceAt = [usage.runLoginFailureAt(entry(cur), T1 + 30 * MIN), usage.runLoginFailureAt(entry(cur), T1 + 30 * MIN + 1), usage.runLoginFailureAt(entry(cur), T1 - 1)];
    usage.recordProviderStatus(cur, IN_ST, T1 + 30 * MIN + 1000);
    check('S11 (c) after 30 minutes a status reading replaces it: held at +29 min, in force up to +30 min exactly, gone at +30 min 1 s — and a mark dated in the FUTURE is never in force',
      heldAt29 && inForceAt[0] === T1 && inForceAt[1] === undefined && inForceAt[2] === undefined && auth(cur).loggedIn === true && auth(cur).fromRun === undefined && usage.RUN_LOGIN_FAILURE_STICKY_MS === 30 * MIN,
      JSON.stringify([heldAt29, inForceAt, auth(cur)]));

    // edges of the flag
    writeUsage({});
    usage.recordProviderStatus(cur, IN_ST, T0, { fromRun: true });
    const flagOnLoggedIn = auth(cur);
    usage.recordProviderStatus(cur, OUT_ST, T0 + MIN);
    const statusLogout = auth(cur);
    usage.recordProviderStatus(cur, IN_ST, T0 + 2 * MIN);
    check('S12 the flag is believed only beside a status that says logged OUT; and a logout the STATUS CHECK reported (no flag) is not sticky — the next "logged in" replaces it at once',
      flagOnLoggedIn.loggedIn === true && flagOnLoggedIn.fromRun === undefined && statusLogout.loggedIn === false && statusLogout.fromRun === undefined && auth(cur).loggedIn === true, JSON.stringify([flagOnLoggedIn, statusLogout, auth(cur)]));
    usage.recordProviderStatus({ name: 'w1', configDir: W1 }, OUT_ST, T0, { fromRun: true });
    usage.recordProviderStatus({ name: 'main', configDir: platform.hostConfigDir() }, OUT_ST, T0, { fromRun: true });
    check('S13 a Claude Code account\'s directory is still refused: no vendor verdict, from a run or not, is ever filed there', entry({ configDir: W1 }) === undefined && entry({ configDir: platform.hostConfigDir() }) === undefined);
    writeUsage({ [CURSOR_DEFAULT]: { name: 'cur', configDir: CURSOR_DEFAULT, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now(), auth: { loggedIn: true, method: null, email: null, checkedAt: 1, fromRun: true, fromRunAt: Date.now() } } });
    const forged1 = usage.parseAuth(entry(cur).auth);
    writeUsage({ [CURSOR_DEFAULT]: { name: 'cur', configDir: CURSOR_DEFAULT, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now(), auth: { loggedIn: false, method: null, email: null, checkedAt: 1, fromRun: 'yes', fromRunAt: 'now' } } });
    const forged2 = usage.parseAuth(entry(cur).auth);
    check('S14 a hand-edited mark is read only in the shape it is written in: beside loggedIn:false, as the literal true, with a finite time — otherwise the two keys are absent from the parsed reading',
      !('fromRun' in forged1) && !('fromRunAt' in forged1) && !('fromRun' in forged2) && !('fromRunAt' in forged2) && usage.runLoginFailureAt(entry(cur)) === undefined, JSON.stringify([forged1, forged2]));
    check('S15 the two-argument and three-argument calls every existing caller makes are unchanged (the fourth parameter is optional)', usage.recordProviderStatus.length <= 3 && usage.recordProviderRunSucceeded.length <= 2);
    if (BASE_OUT) {
      const baseUsage = require(path.join(BASE_OUT, 'usage.js'));
      writeUsage({});
      baseUsage.recordProviderStatus(cur, OUT_ST, T0); // what the dispatch server files when a run fails on login
      const baseOut = baseUsage.isLoginExpired(baseUsage.getCachedUsage(CURSOR_DEFAULT));
      baseUsage.recordProviderStatus(cur, IN_ST, T0 + MIN); // the optimistic status check, a minute later
      check('S16 [the defect, on the tree before this task] the same two readings: the run\'s logout was simply overwritten by the status check\'s "logged in"',
        baseOut === true && baseUsage.isLoginExpired(baseUsage.getCachedUsage(CURSOR_DEFAULT)) === false && baseUsage.parseAuth(baseUsage.getCachedUsage(CURSOR_DEFAULT).auth).loggedIn === true);
    } else {
      skip('S16 [the defect, on the tree before this task] the run\'s logout was simply overwritten by the status check\'s "logged in"', NO_BASE_BUILD);
    }
    writeUsage({});
    setWorkers([]);
  });

  /* ================================================================ Q. nothing bypasses vscode.l10n.t (K9) */
  await section('Q', async () => {
    const plainT = vscode.l10n.t;
    vscode.l10n.t = (msg, ...args) => `⟦${String(msg).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]))}⟧`;
    try {
      const now = Date.now();
      const iso = (ms) => new Date(now + ms).toISOString();
      const C = (n) => path.join(HOME, `.claude-q${n}`);
      const X = (n) => path.join(HOME, `.codex-q${n}`);
      // Every free-text value below is a DATA_… token, a number, a path, or one of a short list of
      // product words — so whatever ELSE has letters in a row came from the code.
      const workers = [
        { name: 'DATA_C1', configDir: C(1), model: 'opus', preferred: true },
        ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ name: `DATA_C${n}`, configDir: C(n), model: 'sonnet' })),
        { name: 'DATA_X1', configDir: X(1), model: 'gpt-5.5', provider: 'codex', preferred: true, permissionMode: 'read-only' },
        { name: 'DATA_X2', configDir: CODEX_DEFAULT, model: '', provider: 'codex' },
        { name: 'DATA_X3', configDir: X(3), model: '', provider: 'codex' },
        { name: 'DATA_X4', configDir: X(4), model: '', provider: 'codex' },
        { name: 'DATA_X5', configDir: X(5), model: '', provider: 'codex' },
        { name: 'DATA_X6', configDir: C(2), model: '', provider: 'codex' }, // on a Claude Code account's directory: owns no reading
        { name: 'DATA_X7', configDir: X(7), model: '', provider: 'codex' },
        { name: 'DATA_U1', configDir: CURSOR_DEFAULT, model: '', provider: 'cursor' },
        { name: 'DATA_G1', configDir: path.join(HOME, '.agy-q1'), model: '', provider: 'gemini' },
        { name: 'DATA_G2', configDir: AGY_DEFAULT, model: '', provider: 'gemini' },
      ];
      setWorkers(workers);
      const base = (n, dir, over) => ({ name: n, configDir: dir, available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: now, ...over });
      const w = (kind, label, percent, severity, resetsAt) => ({ kind, label, percent, severity, resetsAt });
      const three = [w('session', 'Session (5hr)', 12, 'normal', iso(2 * 3_600_000)), w('weekly_all', 'Weekly (7 day)', 81, 'warning', iso(3 * 86_400_000)), w('weekly_scoped', 'Weekly Fable', 100, 'critical', iso(-5000))];
      const authIn = { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now };
      const authOut = { loggedIn: false, method: null, email: null, checkedAt: now };
      // [CA: a Claude Code reading with no login probes is `unconfirmed` (contract-2.0-fixes "Login state (CA)").]
      // DATA_C1 carries the probe this version's refresh files with its reading, so the busiest row reads as
      // before (Q5); DATA_C4 is logged out the CA way — two "not logged in" probes 20 s apart through its
      // own binding, the newer one in this process — so "login expired — re-login needed" is still reached
      // (Q1). The other Claude Code entries stay probe-less, and so also show "login not confirmed".
      const probe = (dir, at, result) => ({ at, path: usage.loginProbePath(dir), result, via: result === 'in' ? 'usage' : 'status', reason: result === 'in' ? 'plan usage read (max)' : 'claude auth status said not logged in' });
      writeUsage({
        [C(1)]: base('DATA_C1', C(1), { windows: three, windowsStale: true, windowsFetchedAt: now - 7 * 60_000, lastGoodWindowsAt: now - 7 * 60_000, extraUsage: { enabled: true, percent: 40, spendLabel: '$20.00 / $50.00' }, loginProbes: [probe(C(1), now, 'in')] }),
        // DATA_C2: no entry at all (refreshing)
        [C(3)]: base('DATA_C3', C(3), { available: false, error: 'DATA_PROBE_ERROR' }),
        [C(4)]: base('DATA_C4', C(4), { available: false, subscriptionType: null, auth: authOut, loginProbes: [probe(C(4), now - 20_000, 'out'), probe(C(4), now, 'out')] }),
        [C(5)]: base('DATA_C5', C(5), { available: false, subscriptionType: null, auth: { ...authIn, method: 'DATA_METHOD' } }),
        [C(6)]: base('DATA_C6', C(6), { lastGoodWindowsAt: now - 3 * 3_600_000 }),
        [C(7)]: base('DATA_C7', C(7), {}),
        [C(8)]: base('DATA_C8', C(8), { subscriptionType: null, windows: [w('DATA_KIND', 'DATA_WINDOW', 55, 'DATA_SEVERITY', null), w('session', 'ignored', 5, 'critical', 'not a date')], extraUsage: { enabled: false, percent: null, spendLabel: null } }),
        [C(9)]: base('DATA_C9', C(9), { windows: [three[0]], extraUsage: { enabled: true, percent: null, spendLabel: '$1.00' } }),
        [C(10)]: base('DATA_C10', C(10), { windows: [three[0]], extraUsage: { enabled: true, percent: 9, spendLabel: null } }),
        [C(11)]: base('DATA_C11', C(11), { windows: [three[0]], extraUsage: { enabled: true, percent: null, spendLabel: null } }),
        [X(1)]: base('DATA_X1', X(1), { subscriptionType: 'chatgpt', auth: authIn, windows: [w('session', 'primary', 34, 'normal', iso(125 * 60_000)), w('weekly_all', 'secondary', 95, 'critical', null), w('weekly_scoped', 'DATA_WINDOW', 3, 'normal', iso(-1))], windowsStale: true, windowsFetchedAt: now - 26 * 3_600_000 }),
        [CODEX_DEFAULT]: base('DATA_X2', CODEX_DEFAULT, { available: false, subscriptionType: 'chatgpt', auth: authIn }),
        [X(3)]: base('DATA_X3', X(3), { available: false, subscriptionType: null, error: 'DATA_STATUS_ERROR' }),
        [X(4)]: base('DATA_X4', X(4), { available: false, subscriptionType: null }),
        // DATA_X5: no entry (not checked yet); DATA_X6: no reading of its own
        [X(7)]: base('DATA_X7', X(7), { available: false, subscriptionType: null, auth: { ...authIn, method: null }, error: 'DATA_USAGE_ERROR' }),
        [CURSOR_DEFAULT]: base('DATA_U1', CURSOR_DEFAULT, { available: false, subscriptionType: null, auth: { ...authOut, fromRun: true, fromRunAt: now - 4 * 60_000 } }),
        [path.join(HOME, '.agy-q1')]: base('DATA_G1', path.join(HOME, '.agy-q1'), { available: false, subscriptionType: null, auth: authOut }),
        [AGY_DEFAULT]: base('DATA_G2', AGY_DEFAULT, { available: false, subscriptionType: null, error: 'CLI not found: DATA_DETAIL' }),
      });
      fs.writeFileSync(registry.STATS_FILE, JSON.stringify({
        DATA_C1: { tasks: 44, inputTokens: 17891555, outputTokens: 642812, costUsd: 12.5, errors: 2, lastError: 'DATA_LAST_ERROR', cooldownUntil: now + 20 * 60_000 },
        DATA_C3: { tasks: 3, inputTokens: 9999, outputTokens: 10000, costUsd: 0, errors: 1 },
        DATA_X1: { tasks: 1, inputTokens: 5, outputTokens: 6, costUsd: 0, errors: 0, cooldownUntil: now + 60_000 },
      }));
      const T = (id, over) => ({ ts: now - 60_000, id, status: 'done', title: `DATA_TITLE_${id}`, worker: 'DATA_C1', model: 'opus', cwd: WS, outputFile: path.join(SANDBOX, `${id}.md`), promptPreview: 'DATA_PROMPT', ...over });
      const promptFile = path.join(SANDBOX, 'q-prompt.txt');
      fs.writeFileSync(promptFile, 'DATA_FULL_PROMPT');
      // 2.0: the prompt a hover shows is the file the task's id names, not the path its log line records
      fs.mkdirSync(registry.TASKS_DIR, { recursive: true });
      fs.writeFileSync(path.join(registry.TASKS_DIR, 'tqdet00001.prompt.txt'), 'DATA_FULL_PROMPT');
      fs.mkdirSync(path.join(WS, '.claude/worktrees/cco-tqmesh0001'), { recursive: true });
      writeLedger([
        { name: 'cco-w-1', account: 'DATA_C1', configDir: C(1), jobId: 'aaaa1111', model: 'opus', role: 'dispatch', spawnedAt: 1, stoppedAt: 2, taskId: 'tqmesh0001', worktree: '.claude/worktrees/cco-tqmesh0001', branch: 'DATA-BRANCH-1' },
        { name: 'cco-w-1', account: 'DATA_C1', configDir: C(1), jobId: 'bbbb2222', model: 'opus', role: 'dispatch', spawnedAt: 3, stoppedAt: 4, taskId: 'tqmesh0002', worktree: '.claude/worktrees/cco-tqmesh0002', branch: 'DATA-BRANCH-2' },
        { name: 'cco-w-1', account: 'DATA_C1', configDir: C(1), jobId: 'cccc3333', model: 'opus', role: 'dispatch', spawnedAt: 5, stoppedAt: 6, taskId: 'tqmesh0003', worktree: '.claude/worktrees/cco-tqmesh0003' },
      ]);
      writeTasks([
        T('tqrun00001', { status: 'running', pgid: 4242, pid: 4242, ts: now - 5 * 60_000 }),
        T('tqdet00001', { status: 'running', supervisorPid: 77, ts: now - 9 * 60_000 }), T('tqdet00001', { ts: now - 8 * 60_000, promptFile }),
        T('tqmesh0001', { meshWorker: 'cco-w-1', inputTokens: 17891555, outputTokens: 642812 }),
        T('tqmesh0002', { meshWorker: 'cco-w-1', status: 'error', error: 'DATA_ERROR_TEXT' }),
        T('tqmesh0003', { meshWorker: 'cco-w-1' }),
        T('tqmesh0004', { meshWorker: 'cco-w-1', status: 'running' }),
        T('tqcan00001', { status: 'error', error: 'cancelled DATA_REASON' }),
        T('tqorp00001', { status: 'error', error: 'orphaned DATA_REASON' }),
        T('tqerr00001', { status: 'error', error: 'DATA_ERROR_TEXT' }),
        T('tqunk00001', { status: 'DATA_STATUS' }),
        T('tqcdx00001', { provider: 'codex', worker: 'DATA_X1', model: 'gpt-5.5' }),
        T('tqcdx00002', { provider: 'codex', worker: 'DATA_X1', model: 'gpt-5.5', status: 'running', supervisorPid: 78, ts: now - 4 * 60_000 }), T('tqcdx00002', { provider: 'codex', worker: 'DATA_X1', model: 'gpt-5.5' }),
        T('tqprv00001', { provider: 'DATA_PROVIDER' }),
        T('tqbad00001', { title: 7, worker: {}, model: null, promptPreview: 9 }),
      ]);

      // ---- walk every row of the three trees
      const walk = (wp, tp, hp) => {
        const texts = [];
        const add = (where, what, value) => { if (value !== undefined && value !== null && value !== '') texts.push({ where, what, value: tipText(value) }); };
        const accountsShown = wp.getChildren();
        for (const node of accountsShown) {
          const item = wp.getTreeItem(node);
          add(`workers/${node.name}`, 'label', item.label); add(`workers/${node.name}`, 'description', item.description); add(`workers/${node.name}`, 'tooltip', item.tooltip);
          for (const child of wp.getChildren(node)) {
            const row = wp.getTreeItem(child);
            add(`workers/${node.name}/${child.seq}`, 'label', row.label); add(`workers/${node.name}/${child.seq}`, 'description', row.description); add(`workers/${node.name}/${child.seq}`, 'tooltip', row.tooltip);
          }
        }
        const taskRows = tp.getChildren();
        for (const e of taskRows) {
          const item = hovered(tp, e); // 2.0: with its hover, which is built on demand
          add(`tasks/${e.id}`, 'label', item.label); add(`tasks/${e.id}`, 'description', item.description); add(`tasks/${e.id}`, 'tooltip', item.tooltip);
        }
        const historyRows = hp.getChildren();
        for (const e of historyRows) {
          const item = hovered(hp, e); // 2.0: with its hover, which is built on demand
          add(`history/${e.id}`, 'label', item.label); add(`history/${e.id}`, 'description', item.description); add(`history/${e.id}`, 'tooltip', item.tooltip);
        }
        return { texts, accountsShown, taskRows, historyRows };
      };
      const { texts, accountsShown, taskRows, historyRows } = walk(workersProvider(), tasksProvider(), historyProvider());

      // ---- what is left of a text once everything translated and everything that is data is taken out
      const outsideMarkers = (s) => { let depth = 0; let out = ''; for (const ch of s) { if (ch === '⟦') depth++; else if (ch === '⟧') depth = Math.max(0, depth - 1); else if (depth === 0) out += ch; } return out; };
      const DATA_WORDS = ['Claude Code', 'Codex', 'Cursor', 'Antigravity', 'opus', 'sonnet', 'gpt-5.5', 'max', 'chatgpt', 'read-only', 'cco-w-1', 'CLI not found: DATA_DETAIL', 'cancelled DATA_REASON', 'orphaned DATA_REASON'];
      const residue = (s) => {
        let r = outsideMarkers(s);
        // a whole path under the sandbox, to the next space or bracket
        r = r.replace(new RegExp(`${SANDBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s)]*`, 'g'), ' ');
        for (const word of DATA_WORDS) r = r.split(word).join(' ');
        return r
          .replace(/DATA[-_A-Za-z0-9.]*/g, ' ')                     // fixture free text
          .replace(/\bt(?=[a-z0-9]*\d)[a-z0-9]{6,24}\b/g, ' ')      // task ids (they carry digits; an English word does not)
          .replace(/\d[\d.,:]*\s?(AM|PM|[kMBT]\b)?/g, ' ')         // numbers, clock times, token counts
          .replace(/\\/g, '');                                     // markdown escapes
      };
      const offenders = texts.map((t) => ({ ...t, left: residue(t.value) })).filter((t) => /[A-Za-z]{2,}/.test(t.left));
      const states = ['usage: — (refreshing)', 'usage unavailable', 'login expired — re-login needed', 'no plan limits (token/non-subscription login)', 'plan usage unavailable (last', 'no rate-limit windows reported', '⚠overage', '⏱ plan usage', 'preferred', '⏸ cooldown',
        'Plan · Extra usage', 'Plan · (stale)', 'temporarily unavailable — last good reading', 'Dispatch · Session (5h)', 'Dispatch · Weekly (7d)', 'Dispatch · All time', 'no dispatches yet', 'logged out — the last run failed on login', 'login not confirmed', 'CLI not found', 'status unavailable', 'login state unknown', 'not checked yet',
        'Mesh — attachable claude --bg (worker', 'Detached (supervised)', 'One-shot (claude -p)', 'One-shot — ', 'Detached (supervised) — ', 'Started ', 'Ended ', 'Status: ', 'Prompt', 'Error', 'Model ', 'Task ', 'cwd ', '⚠ unmerged branch', 'branch ', 'Branch ', 'Completed ', 'cancelled', 'orphaned', 'running', 'error', 'done'];
      const everything = texts.map((t) => t.value).join('\n');
      const unseen = states.filter((s) => !everything.includes(`⟦${s}`));
      check(`Q1 the fixture reaches every state the rows can be in (${accountsShown.length} accounts, ${taskRows.length} tasks, ${historyRows.length} history rows; ${texts.length} labels, descriptions and tooltips; ${states.length} distinct strings looked for)`,
        // [2.0: was 14 task rows.] tqunk00001 carries a status no writer emits ("DATA_STATUS"); the trees show the tasks
        // of the shared index, and by its one rule (uiModel.acceptEvent) such a record is not a task on any surface.
        accountsShown.length === workers.length && taskRows.length === 13 && !taskRows.some((e) => e.id === 'tqunk00001') && historyRows.length === 3 && unseen.length === 0, unseen.join(' | ') || `${texts.length} texts`);
      check('Q2 with vscode.l10n.t wrapping every translated string in ⟦…⟧, NOTHING human-readable is left outside the markers in any label, description or tooltip of views.ts / history-view.ts — only names, numbers, paths and punctuation',
        offenders.length === 0, offenders.slice(0, 12).map((o) => `${o.where} ${o.what}: «${o.left.replace(/\s+/g, ' ').trim().slice(0, 90)}» in «${o.value.replace(/\s+/g, ' ').slice(0, 160)}»`).join('\n      ') || `${texts.length} texts clean`);
      const rowsWithFragments = texts.filter((t) => /[A-Za-z]{2,}⟦|⟧[A-Za-z]{2,}/.test(t.value.replace(/DATA[-_A-Za-z0-9.]*/g, '')));
      check('Q3 no translated string has a word glued onto either side of it (a sentence assembled from a translated piece and a literal one)', rowsWithFragments.length === 0, rowsWithFragments.slice(0, 5).map((t) => `${t.where}: ${t.value.slice(0, 120)}`).join(' | '));
      const phrases = texts.filter((t) => /⟦[^⟦⟧]*⟦(just now|\d+[mhd] ago|now|in \d+m|in \d+h \d+m|in \d+d \d+h)⟧/.test(t.value));
      check('Q4 a time set into a sentence is itself a whole translated phrase from a timestamp ("7m ago", "in 2h 0m", "now"), never an English fragment', phrases.length >= 8 && !texts.some((t) => /\bin \d+\.\d[hd]\b|\d+\.\dh ago/.test(t.value)),
        `${phrases.length} sentences carry a time phrase, e.g. ${phrases[0] && phrases[0].value.replace(/\s+/g, ' ').slice(0, 110)}`);
      if (BASE_OUT) {
        // The same walk, the same fixture, the same marker stub — over the tree as it was before this task.
        const baseViews = require(path.join(BASE_OUT, 'views.js'));
        const baseWm = require(path.join(BASE_OUT, 'workerManager.js'));
        const baseHistory = require(path.join(BASE_OUT, 'history-view.js'));
        const bw = new baseViews.WorkersProvider(new baseWm.WorkerManager());
        const bt = new baseViews.TasksProvider();
        const bh = new baseHistory.WorkerHistoryProvider();
        const base = walk(bw, bt, bh);
        for (const provider of [bw, bt, bh]) provider.dispose();
        const baseOffenders = base.texts.map((t) => ({ ...t, left: residue(t.value) })).filter((t) => /[A-Za-z]{2,}/.test(t.left));
        const found = (re) => baseOffenders.some((o) => re.test(o.left));
        check(`Q2b [the defect, on the tree before this task] the same walk finds English outside the markers in ${baseOffenders.length} of ${base.texts.length} texts — the plan-quota rows, the dispatch rows, "preferred", "cooldown", "overage", the task hover's headings, "Model … · Account …", "Completed …"`,
          baseOffenders.length > 100 && found(/Plan quota|Plan ·/) && found(/Dispatch · Session/) && found(/preferred/) && found(/cooldown/) && found(/overage/) && found(/One-shot|Detached|Mesh/) && found(/Model .* Account/) && found(/Completed/) && found(/Prompt/) && found(/ago|in \.h/),
          baseOffenders.slice(0, 3).map((o) => `${o.where} ${o.what}: «${o.left.replace(/\s+/g, ' ').trim().slice(0, 70)}»`).join(' ; '));
      } else {
        skip('Q2b [the defect, on the tree before this task] the same walk finds English outside the markers', NO_BASE_BUILD);
      }
      const sample = texts.find((t) => t.where === 'workers/DATA_C1' && t.what === 'description');
      check('Q5 (shown for the record) the collapsed row of the busiest account', /^Claude Code · opus · ⟦preferred⟧ · ⟦⏸ cooldown⟧ · ⟦5h⟧ 12% · ⚠⟦7d⟧ 81% · ⚠⟦Fable⟧ 100% · ⟦⚠overage⟧ · ⟦⏱ plan usage ⟦7m ago⟧⟧$/.test(sample.value), sample.value);
    } finally {
      vscode.l10n.t = plainT;
      fs.rmSync(registry.STATS_FILE, { force: true });
      fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true });
      writeUsage({});
      writeTasks([]);
      writeLedger([]);
      setWorkers([]);
    }
  });

  /* ================================================================ U. removing an account with session workers (K14) */
  await section('U', async () => {
    const reg = () => readWorkers().map((w) => w.name).join(',');
    const ledger = () => [
      { name: 'cco-w-1', account: 'w1', configDir: W1, jobId: 'aaaa1111', model: 'opus', role: 'dispatch', spawnedAt: 10, taskId: 'tkeep0001' },
      { name: 'cco-w-2', account: 'w1', configDir: `${W1}${path.sep}`, jobId: 'bbbb2222', model: 'opus', role: 'dispatch', spawnedAt: 20, settledAt: 30, taskId: 'tkeep0002' },
      { name: 'cco-w-0', account: 'w1', configDir: W1, jobId: 'dead0000', model: 'opus', role: 'dispatch', spawnedAt: 1, stoppedAt: 5, taskId: 'told00009' }, // stopped: not counted
      { name: 'cco-w-9', account: 'w2', configDir: W2, jobId: 'ffff9999', model: 'opus', role: 'dispatch', spawnedAt: 40 }, // another account's
      { name: 'cco-w-8', account: 'w1', configDir: W1, jobId: '--help', model: 'opus', role: 'dispatch', spawnedAt: 50 }, // not a job id: nothing could ever be run for it
    ];
    const setup = () => {
      setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }, { name: 'w2', configDir: W2, model: 'sonnet' }, { name: 'cx', configDir: path.join(HOME, '.codex-u'), model: '', provider: 'codex' }]);
      writeLedger(ledger());
      writeTasks([]);
      fs.rmSync(FAKE_MODE, { force: true });
      ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
      reset();
    };
    const stops = (from) => fakeCalls().slice(from).map((c) => c.argv.join(' '));

    setup();
    const tracked = views.sessionWorkersStrandedByRemoval({ name: 'w1', configDir: W1, model: 'opus' });
    check('U0 the records a removal would strand: the account\'s own (also under another spelling of its directory), not marked stopped, with a real job id — two of the five',
      JSON.stringify(tracked.map((t) => [t.jobId, t.name, t.taskId])) === JSON.stringify([['aaaa1111', 'cco-w-1', 'tkeep0001'], ['bbbb2222', 'cco-w-2', 'tkeep0002']]), JSON.stringify(tracked));

    // Cancel
    let before = fakeCalls().length;
    await run('removeWorker', { name: 'w1' });
    const modal = rec.messages[0];
    check('U1 the confirmation is MODAL, says how many session workers of the account are still tracked (2) and which, that after removal they cannot be stopped from the extension — only with `claude stop <job id>` in a terminal under that account — and offers "Stop them and remove" next to "Remove anyway"',
      rec.messages.length === 1 && modal.modal === true && modal.level === 'warning' && /Remove worker account "w1"\?/.test(modal.msg) && /still tracked: 2 \(job ids: aaaa1111, bbbb2222\)/.test(modal.detail)
      && /can no longer be stopped from this extension/.test(modal.detail) && /`claude stop <job id>` under that account/.test(modal.detail) && JSON.stringify(modal.items) === JSON.stringify(['Stop them and remove', 'Remove anyway']),
      JSON.stringify([modal.msg, modal.detail, modal.items]));
    check('U2 dismissing it (Cancel) stops nothing and removes nothing', stops(before).length === 0 && reg() === 'w1,w2,cx' && ledgerCalls.marked.length === 0);

    // Stop them and remove
    setup();
    before = fakeCalls().length;
    answers.message.push((items) => items.find((i) => i === 'Stop them and remove'));
    await run('removeWorker', { name: 'w1' });
    const calls = fakeCalls().slice(before);
    check('U3 "Stop them and remove" runs `claude stop` for BOTH through the fake CLI, as that account (CLAUDE_CONFIG_DIR = its directory, no session identity), one after the other',
      JSON.stringify(calls.map((c) => c.argv.join(' '))) === JSON.stringify(['stop aaaa1111', 'stop bbbb2222']) && calls.every((c) => path.resolve(c.env.CLAUDE_CONFIG_DIR) === W1 && !('CLAUDECODE' in c.env) && !('CLAUDE_CODE_MESSAGING_TOKEN' in c.env)),
      JSON.stringify(calls.map((c) => [c.argv, c.env.CLAUDE_CONFIG_DIR])));
    check('U4 …through the EXISTING stop path: each gets the ledger mark by job id and the `claude rm` teardown (and the stops ran while the account was still registered — the stop path refuses any other directory)',
      JSON.stringify(ledgerCalls.marked.map((m) => m.jobId)) === JSON.stringify(['aaaa1111', 'bbbb2222']) && JSON.stringify(ledgerCalls.removed.map((r) => r.jobId)) === JSON.stringify(['aaaa1111', 'bbbb2222']), JSON.stringify(ledgerCalls));
    check('U5 THEN the account is removed, and the user is told both things', reg() === 'w2,cx' && rec.messages.some((m) => m.level === 'info' && /Stopped 2 session worker\(s\) of "w1" and removed the account\./.test(m.msg)) && rec.progress.length === 1 && /Stopping the session workers of "w1"/.test(rec.progress[0].title),
      JSON.stringify([reg(), rec.messages.map((m) => m.msg)]));

    // Remove anyway
    setup();
    before = fakeCalls().length;
    answers.message.push((items) => items.find((i) => i === 'Remove anyway'));
    await run('removeWorker', { name: 'w1' });
    check('U6 "Remove anyway" removes the account and stops nothing', reg() === 'w2,cx' && stops(before).length === 0 && ledgerCalls.marked.length === 0);

    // a stop that fails: the account stays
    setup();
    fs.writeFileSync(FAKE_MODE, 'fail');
    before = fakeCalls().length;
    answers.message.push((items) => items.find((i) => i === 'Stop them and remove'));
    await run('removeWorker', { name: 'w1' });
    const failure = rec.messages[rec.messages.length - 1];
    check('U7 when a session worker cannot be stopped, the account is NOT removed and the user is told which could not be stopped and why (the CLI\'s words flattened)',
      reg() === 'w1,w2,cx' && stops(before).length === 2 && ledgerCalls.marked.length === 0 && failure.level === 'warning' && /was not removed: 2 of its 2 session workers could not be stopped \(aaaa1111: /.test(failure.msg) && !/[\u001b‮\n]/.test(failure.msg),
      JSON.stringify([reg(), failure.msg.slice(0, 260)]));
    fs.rmSync(FAKE_MODE, { force: true });

    // the dashboard's remove goes through the same question
    setup();
    accounts.set('0123456789abcdef', { name: 'w1', configDir: W1, isMain: false, isWorker: true, provider: 'claude' });
    await run('accountAction', { action: 'remove', account: '0123456789abcdef' });
    check('U8 the dashboard\'s "Remove account…" asks the same question', rec.messages.length === 1 && rec.messages[0].modal === true && /still tracked: 2/.test(rec.messages[0].detail) && reg() === 'w1,w2,cx');
    accounts.clear();

    // no stranded sessions: the plain question, as before
    setup();
    answers.message.push((items) => items.find((i) => i === 'Remove Account'));
    await run('removeWorker', { name: 'w2' });
    const plain = rec.messages[0];
    check('U9 another account with ONE tracked session worker of its own is asked the same question with ITS count and job id (and a button the modal does not offer removes nothing)', plain.modal === true && /still tracked: 1 \(job ids: ffff9999\)/.test(plain.detail) && reg() === 'w1,w2,cx', JSON.stringify([plain.detail, plain.items]));
    setup();
    writeLedger(ledger().filter((r) => r.configDir === W2 ? false : true));
    answers.message.push((items) => items.find((i) => i === 'Remove Account'));
    await run('removeWorker', { name: 'w2' });
    check('U10 an account with no tracked session worker: the plain one-button confirmation, removed on confirm', rec.messages[0].modal === true && JSON.stringify(rec.messages[0].items) === JSON.stringify(['Remove Account']) && !/still tracked/.test(rec.messages[0].detail) && reg() === 'w1,cx',
      JSON.stringify([rec.messages[0].items, reg()]));
    setup();
    answers.message.push((items) => items.find((i) => i === 'Remove Account'));
    await run('removeWorker', { name: 'cx' });
    check('U11 an account on another vendor\'s CLI has no session workers: the plain confirmation', JSON.stringify(rec.messages[0].items) === JSON.stringify(['Remove Account']) && reg() === 'w1,w2');
    // a worker on the HOSTING account's own directory: its sessions stay addressable through "main"
    setup();
    const MAIN = platform.hostConfigDir();
    setWorkers([{ name: 'mainw', configDir: MAIN, model: 'opus' }]);
    writeLedger([{ name: 'cco-w-1', account: 'mainw', configDir: MAIN, jobId: 'aaaa1111', model: 'opus', role: 'dispatch', spawnedAt: 10 }]);
    check('U12 a worker registered on the hosting session\'s own directory strands nothing: that directory stays a Claude Code account\'s without it', views.sessionWorkersStrandedByRemoval({ name: 'mainw', configDir: MAIN, model: 'opus' }).length === 0);
    setWorkers([]);
    writeLedger([]);
  });

  /* ================================================================ T. the registry lock can refuse (K13) */
  await section('T', async () => {
    const LOCK = `${registry.REGISTRY_FILE}.lock`;
    const HOLDER = path.join(__dirname, 'lock-holder.js');
    const holders = [];
    const hold = async (ms) => {
      const ready = path.join(SANDBOX, `lock-ready-${holders.length}`);
      const child = realSpawn(process.execPath, [HOLDER, OUT, String(ms), ready], { env: { ...process.env, HOME }, stdio: 'ignore' });
      holders.push(child);
      const started = Date.now();
      while (!fs.existsSync(ready)) {
        if (Date.now() - started > 10_000) throw new Error('the lock holder did not take the lock');
        await sleep(25);
      }
      const gone = new Promise((resolve) => child.once('exit', resolve));
      return { pid: child.pid, at: Date.now(), gone };
    };
    const lockHeld = () => { try { fs.lstatSync(LOCK); return true; } catch { return false; } };
    const channel = () => rec.channels[rec.channels.length - 1];
    const settingsLines = (ch) => ch.lines.filter((l) => l.startsWith('[settings]'));

    setWorkers([{ name: 'w1', configDir: W1, model: 'opus' }, { name: 'w2', configDir: W2, model: 'sonnet' }]);
    Object.assign(settings, { quotaCooldownMinutes: 30, workerTimeoutMinutes: 45, meshMode: false, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, workerPermissionMode: 'acceptEdits' });
    fireConfigChange();
    const inSync = fs.readFileSync(registry.REGISTRY_FILE, 'utf8');

    // --- 0. nothing to write: the lock is never touched
    let h = await hold(6_000);
    let t = Date.now();
    let threw;
    try { new wmMod.WorkerManager().syncSettings(); fireConfigChange(); } catch (e) { threw = e; }
    const quick = Date.now() - t;
    check('T1 with the registry lock HELD by a live process and nothing to write, a settings sync (direct, and through the configuration event) returns at once, throws nothing and waits on nothing',
      lockHeld() && threw === undefined && quick < 1_000 && fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === inSync, `${quick} ms, lock held: ${lockHeld()}, file unchanged: ${fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === inSync}${threw ? `, threw ${threw.message}` : ''}`);
    reset();
    const freshOutput0 = rec.channels.length;
    t = Date.now();
    const idleError = activate(newContext('2.0.0'));
    check('T2 …and so does a whole activation: an editor that merely starts up never waits on the lock', idleError === undefined && Date.now() - t < 2_000 && settingsLines(rec.channels[freshOutput0]).length === 0, `${Date.now() - t} ms`);
    await h.gone;

    // --- 1. something to write, the lock held for 20 s: activation
    settings.quotaCooldownMinutes = 77;
    settings.meshMaxLiveWorkers = 3;
    h = await hold(20_000);
    reset();
    const channelsBefore = rec.channels.length;
    const commandsBefore = commands.size;
    t = Date.now();
    const lockedError = activate(newContext('2.0.0'));
    const activationMs = Date.now() - t;
    await sleep(30); // the post-migration sync runs in a microtask
    const out = rec.channels[channelsBefore];
    const lines = settingsLines(out);
    const startupSaid = rec.messages.map((m) => ({ level: m.level, modal: m.modal, msg: m.msg }));
    check('T3 with the registry lock held by a live helper process for 20 s and a setting to write, activate() COMPLETES: it returns without throwing after the lock\'s own 15 s wait',
      lockedError === undefined && activationMs >= 14_000 && activationMs < 19_000, `${activationMs} ms; ${lockedError && lockedError.stack}`);
    check('T4 it logs ONE line to the extension\'s output channel, carrying the lock\'s own message — the file, the holder\'s pid, "Nothing was changed"',
      lines.length === 1 && /^\[settings\] not written to the shared registry/.test(lines[0]) && lines[0].includes('Could not lock registry.json') && lines[0].includes(`process ${h.pid}`) && /Nothing was changed/.test(lines[0]) && lines[0].includes(LOCK),
      lines.join(' ## ').slice(0, 420));
    check('T5 activation did not half-complete: every command is registered, the four views have providers, and the timers of a normal activation are armed',
      commands.size === commandsBefore && ['claudeCodeOrchestrator.workers', 'claudeCodeOrchestrator.workerHistory'].every((id) => rec.providers[id]) && ['claudeCodeOrchestrator.tasks', 'claudeCodeOrchestrator.team'].every((id) => rec.treeViews[id])
      && timers.filter((x) => x.kind === 'interval' && x.ms === 5 * 60 * 1000).length >= 1, `${commands.size} commands`);
    let renderError;
    let rendered = 0;
    try {
      const wp = workersProvider();
      for (const node of wp.getChildren()) { wp.getTreeItem(node); rendered++; for (const c of wp.getChildren(node)) { wp.getTreeItem(c); rendered++; } }
      for (const e of tasksProvider().getChildren()) { tasksProvider().getTreeItem(e); rendered++; }
      for (const e of historyProvider().getChildren()) { historyProvider().getTreeItem(e); rendered++; }
      for (const g of teamProvider().getChildren()) { teamProvider().getTreeItem(g); rendered++; }
    } catch (e) { renderError = e; }
    check('T6 the views render while the lock is still held', lockHeld() && renderError === undefined && rendered >= 8, `${rendered} items; ${renderError && renderError.stack}`);
    check('T7 nothing was written: the registry still holds the previous values', fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === inSync && readReg().cooldownMinutes === 30);

    // [NEW: 2.0] A sync refused at activation used to be written to the output channel only; the editor has just
    // stalled on that lock, so it is now SAID too — once, in the lock's own words.
    check('T4b …and the user is told at startup: ONE warning (not modal) that this editor\'s settings were not copied to the shared registry, carrying the lock\'s own message — the file, the holder',
      startupSaid.filter((m) => /registry/.test(m.msg)).length === 1 && startupSaid.some((m) => m.level === 'warning' && m.modal === false && /^This editor's settings were not copied to the shared registry, so dispatch keeps using the values it holds\. Could not lock registry\.json/.test(m.msg) && m.msg.includes(`process ${h.pid}`) && /It is tried again at the next settings change and every few minutes\.$/.test(m.msg)),
      startupSaid.map((m) => `${m.level}: ${m.msg.slice(0, 140)}`).join(' | '));

    // --- 2. a setting change while the lock is still held
    reset();
    t = Date.now();
    let handlerError;
    try { fireConfigChange(); fireConfigChange(); fireConfigChange(); } catch (e) { handlerError = e; }
    const changeMs = Date.now() - t;
    const warnings = rec.messages.filter((m) => m.level === 'warning');
    // [2.0: was "a setting change REPORTS that it could not be saved — one warning, with the lock's own message".]
    // A refusal is said ONCE: this one was said at startup a moment ago (T4b), and a settings change that meets
    // the very same refusal (answered from memory) does not say it again. The case the old check was about — a
    // settings change that is the FIRST to meet a refusal — is T8b, further down, where one is.
    check('T8 a setting change that meets the refusal already said at startup does not say it a second time — no message at all for a burst of three events — and nothing throws out of the event handler',
      lockHeld() && handlerError === undefined && warnings.length === 0 && rec.messages.length === 0,
      `${rec.messages.length} message(s) in ${changeMs} ms; ${handlerError && handlerError.stack}; ${rec.messages[0] && rec.messages[0].msg.slice(0, 200)}`);
    check('T9 …without freezing the editor again: the refusal of a moment ago is answered from memory (no second 15 s wait), and the registry is unchanged', changeMs < 1_000 && fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === inSync, `${changeMs} ms`);
    const dashSync = dashboardSettingsSyncs[dashboardSettingsSyncs.length - 1];
    const dashAnswer = dashSync();
    check('T10 the dashboard\'s settings-sync step answers with the same refusal (so a control there says "Not saved: …", never "Saved")', typeof dashAnswer === 'string' && dashAnswer.includes('Could not lock registry.json') && dashAnswer.includes(`process ${h.pid}`), String(dashAnswer).slice(0, 160));

    // --- 3. once the holder is gone: the next natural trigger writes it
    await h.gone;
    await sleep(Math.max(0, 10_500 - (Date.now() - (t - 0)))); // past the 10 s in which the refusal is answered from memory
    reset();
    const tick = timers.filter((x) => x.kind === 'interval' && x.ms === 5 * 60 * 1000).pop();
    tick.fn(); // the usage-refresh tick: the natural retry of an owed write
    await sleep(30);
    check('T11 the next natural trigger (the usage-refresh tick) writes the settings; one more line says so; nobody is told anything',
      readReg().cooldownMinutes === 77 && readReg().meshMaxLiveWorkers === 3 && settingsLines(out).length === 2 && settingsLines(out)[1] === '[settings] written to the shared registry' && rec.messages.length === 0 && dashSync() === undefined,
      JSON.stringify([readReg().cooldownMinutes, readReg().meshMaxLiveWorkers, settingsLines(out).slice(1)]));

    // --- 4. user-initiated registry writes while the lock is held: told, and nothing claimed
    h = await hold(52_000);
    const before = fs.readFileSync(registry.REGISTRY_FILE, 'utf8');
    {
      // T8b — the old T8, in the situation it is about: the lock was taken AFTER this editor started, so the
      // settings change is the first to meet the refusal. It is said once for the burst.
      settings.quotaCooldownMinutes = 78;
      reset();
      let burstError;
      t = Date.now();
      try { fireConfigChange(); fireConfigChange(); fireConfigChange(); } catch (e) { burstError = e; }
      const burstMs = Date.now() - t;
      const said = rec.messages.filter((m) => m.level === 'warning');
      check('T8b a setting change that is the FIRST to meet a held lock REPORTS that it could not be saved — after the lock\'s own wait, ONE warning for a burst of three events, with the lock\'s own message (the file and the holder) — and nothing throws out of the event handler',
        lockHeld() && burstError === undefined && burstMs >= 14_000 && burstMs < 19_000 && rec.messages.length === 1 && said.length === 1 && said[0].modal === false
        && /^The settings change was not saved to the shared registry, so dispatch keeps using the previous values\. Could not lock registry\.json/.test(said[0].msg) && said[0].msg.includes(`process ${h.pid}`) && fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === before,
        `${rec.messages.length} message(s) in ${burstMs} ms; ${burstError && burstError.stack}; ${said[0] && said[0].msg.slice(0, 200)}`);
      settings.quotaCooldownMinutes = 77; // as it was: nothing is owed to the registry once the lock is free
    }
    reset();
    let actionError;
    t = Date.now();
    try { await run('togglePreferred', { name: 'w1' }); } catch (e) { actionError = e; }
    const toggleMs = Date.now() - t;
    // [2.0: was ONE *error* message, "The preferred worker was not changed. Could not lock registry.json…".] A refusal
    // of the shared state is a warning in the registry's own words, whole: that sentence already says what happened,
    // that nothing was changed, and what to do.
    check('T12 "Set as preferred" with the lock held: after the wait, ONE warning that is the lock\'s own message from its first word — and no "is now the preferred worker" claim; the registry and the tree are unchanged',
      actionError === undefined && toggleMs >= 14_000 && rec.messages.length === 1 && rec.messages[0].level === 'warning' && rec.messages[0].modal === false && /^Could not lock registry\.json: process \d+ \(node\) has held its lock for more than 15s\. Nothing was changed\./.test(rec.messages[0].msg) && rec.messages[0].msg.includes(`process ${h.pid}`) && !/is now the preferred worker/.test(rec.messages[0].msg)
      && fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === before && !workersProvider().getTreeItem(workersProvider().getChildren()[0]).label.startsWith('★'),
      `${toggleMs} ms; ${rec.messages.map((m) => `${m.level}: ${m.msg.slice(0, 130)}`).join(' | ')}; ${actionError && actionError.stack}`);
    reset();
    writeLedger([]);
    answers.message.push((items) => items.find((i) => i === 'Remove Account'));
    actionError = undefined;
    try { await run('removeWorker', { name: 'w2' }); } catch (e) { actionError = e; }
    const said = rec.messages[rec.messages.length - 1];
    check('T13 "Remove Account" with the lock held: the account is NOT removed, the user is told so with the lock\'s own text, and it is still listed',
      // [2.0: was level 'error', "Worker account "w2" was not removed. Could not lock registry.json…"] — the same rule as T12
      actionError === undefined && said.level === 'warning' && /^Could not lock registry\.json: process \d+ \(node\) has held its lock for more than 15s\. Nothing was changed\./.test(said.msg) && said.msg.includes(`process ${h.pid}`)
      && !rec.messages.some((m) => /\bremoved\b/.test(m.msg) && !/not removed/.test(m.msg) && m !== rec.messages[0]) && fs.readFileSync(registry.REGISTRY_FILE, 'utf8') === before && workersProvider().getChildren().map((w) => w.name).join(',') === 'w1,w2',
      `${said.level}: ${said.msg.slice(0, 150)}; ${actionError && actionError.stack}`);
    for (const child of holders) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    await h.gone;
    await sleep(100);
    // a lock left by a killed holder is abandoned, and the next write clears it and goes through
    reset();
    await run('togglePreferred', { name: 'w1' });
    check('T14 with the holder gone the same action goes through at once', readReg().workers.find((w) => w.name === 'w1').preferred === true && rec.messages.length === 1 && rec.messages[0].level === 'info' && /is now the preferred worker/.test(rec.messages[0].msg), rec.messages.map((m) => m.msg.slice(0, 80)).join(' | '));
    setWorkers([]);
  });

  /* ------------------------------------------------------------------ the sandbox held */
  const realCalls = fakeCalls().filter((c) => !['stop', 'rm'].includes(c.argv[0]));
  check('Z1 the fake claude was only ever asked to `stop`', realCalls.length === 0, JSON.stringify(realCalls.map((c) => c.argv)));
  const ranOther = blockedSpawns.filter((b) => !/"which"|command -v/.test(b));
  check('Z2 no program outside the allowlist was started — no real claude, codex, cursor-agent or agy', ranOther.length === 0, ranOther.join(' ; ') || 'none attempted');
  check('Z3 nothing was written to the real home directory by this probe', os.homedir() === HOME && REAL_HOME !== HOME && registry.ROOT_DIR.startsWith(HOME) && usage.USAGE_CACHE_FILE.startsWith(HOME) && LEDGER.startsWith(HOME));

  console.log(`\n${H.passes} passed, ${H.failures} failed${H.skips ? `, ${H.skips} skipped` : ''}`);
  process.exit(H.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`FAIL — probe crashed: ${e && e.stack}`);
  process.exit(1);
});
