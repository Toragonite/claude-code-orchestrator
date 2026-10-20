// W7-UI (2.0 fix wave 7): the model that ran, seen in the editor — the task index and the page
// model (modelUsed / modelSource / modelRanAs), the two model pickers (Claude Code aliases; the
// live catalog of another vendor's CLI through the bundled helper), the Workers tree and the
// task hovers, the Accounts heading of the dashboard page, the Errors row, and the dispatch
// policy's freshness (health, chip, command). Also: the rewrites of files the extension did not
// create (lossless reads only), text that is not ours in every surface that draws icons, the
// two readers of "last ran as" (the real server bundle against the host), and a cancel from the
// Tasks tree racing the task's own completion (T1 / T2: one terminal event, told truthfully).
//
//   node .orchestrator/fixes/ui7.cjs [outDir] [--media <dir>] [--only I1,K,...] [--jobs N]
//
// Loads the COMPILED extension-host modules from `outDir` (default: <repo>/out) against the
// `vscode` stand-in of shell-b-stub.cjs, to which this file adds `createQuickPick` and
// `QuickPickItemKind` (the stand-in is required as it is, not edited). Every case runs in a
// child process of its own with HOME / USERPROFILE redirected to a fresh temp directory before
// any module loads and PATH cut down to a directory of fake CLIs. No real claude / codex /
// cursor-agent / agy is started and no real ~/.claude* is touched. The vendor model catalog is
// answered by a stand-in helper this file writes into its scratch directory.
//
// `--media` names the directory holding the dashboard page (default <repo>/media/dashboard).
// The page case copies it, fills the copy's fixtures.js with the string table the build under
// test hands the page (as the string-table check's --write does), and drives preview.html in a
// private headless Chrome; without a browser it prints `SKIP P1-page …`. The browser is started
// ONLY through startChrome of shell-b-page.cjs (which passes --use-mock-keychain: under a
// redirected HOME a Chrome without it makes macOS show a keychain dialog), and the case
// refuses to start one if that function does not pass the flag.
// Prints `PASS <name>` / `FAIL <name> — <why>` and a tally; exit 0 only when everything passed.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-ui7', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const OUT = path.resolve(positional[0] ?? path.join(REPO, 'out'));
const MEDIA = path.resolve(flag('--media') ?? path.join(REPO, 'media', 'dashboard'));

const HOST_CASES = ['I1-index-model', 'I2-index-memory', 'U1-catalog', 'K1-claude-picker', 'K2-vendor-picker', 'V1-views', 'C1-policy-command', 'M1-rewrites', 'Q1-quick-picks', 'H1-dashboard-host', 'X1-two-readers', 'T1-cancel-race', 'T2-cancel-command', 'W1-window-names', 'A1-claude-probe', 'A2-claude-menu', 'A3-codex-models', 'A4-same-account'];
const PAGE_CASES = ['P1-page', 'P2-window-names', 'P3-same-account'];
const CASES = [...HOST_CASES, ...PAGE_CASES];

/* ------------------------------------------------------------------------- *
 * Parent: one child per case
 * ------------------------------------------------------------------------- */

if (flag('--case') === undefined) {
  const only = flag('--only');
  const wanted = only === undefined ? CASES : CASES.filter((c) => only.split(',').some((sel) => c === sel || c.startsWith(sel)));
  const jobs = Math.max(1, Math.min(4, Number(flag('--jobs') ?? 3) || 3));
  const tally = { pass: 0, fail: 0, skip: 0 };
  console.log(`ui7: build under test = ${OUT}`);
  console.log(`ui7: dashboard page   = ${MEDIA}`);

  const runCase = (name) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--expose-gc', __filename, OUT, '--media', MEDIA, '--case', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = out.split('\n').filter((l) => /^(PASS|FAIL|SKIP|NOTE) /.test(l));
        for (const line of lines) {
          console.log(line);
          if (line.startsWith('PASS ')) tally.pass++;
          else if (line.startsWith('FAIL ')) tally.fail++;
          else if (line.startsWith('SKIP ')) tally.skip++;
        }
        if (code !== 0 || lines.length === 0) {
          tally.fail++;
          const tail = err.trim().split('\n').slice(-6).join(' | ');
          console.log(`FAIL ${name}: the case did not run to its end — exit ${code}${signal ? ` (${signal})` : ''}: ${tail || out.trim().split('\n').slice(-3).join(' | ')}`);
        }
        resolve();
      });
    });

  (async () => {
    const queue = wanted.filter((c) => HOST_CASES.includes(c));
    const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        await runCase(next);
      }
    });
    await Promise.all(workers);
    for (const name of wanted.filter((c) => PAGE_CASES.includes(c))) {
      await runCase(name);
    }
    console.log(`\nui7: ${tally.pass} passed, ${tally.fail} failed${tally.skip ? `, ${tally.skip} skipped` : ''}`);
    process.exit(tally.fail === 0 ? 0 : 1);
  })();
  return;
}

/* ------------------------------------------------------------------------- *
 * Child: one case
 * ------------------------------------------------------------------------- */

const { install } = require('./shell-b-stub.cjs');
const CASE = flag('--case');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return text === undefined ? String(v) : text.length > 900 ? `${text.slice(0, 900)}…` : text;
  } catch {
    return String(v);
  }
};
/** CA: the login probes of a CONFIRMED logout (usage.computeLoginState `loggedOut`) of a non-default config dir. */
function confirmedOut(now) {
  return [
    { at: now - 20_000, path: 'explicit', result: 'out', via: 'status', reason: 'claude auth status said not logged in' },
    { at: now, path: 'explicit', result: 'out', via: 'status', reason: 'claude auth status said not logged in' },
  ];
}

function check(name, ok, observed) {
  console.log(ok ? `PASS ${CASE}: ${name}` : `FAIL ${CASE}: ${name} — ${show(observed)}`);
}
const note = (text) => console.log(`NOTE ${CASE}: ${text}`);
/** A check whose subject may not exist in the build under test: a throw is a failure, not a crash. */
function guarded(name, fn) {
  try {
    const r = fn();
    check(name, r[0] === true, r[1]);
  } catch (e) {
    check(name, false, `threw: ${String((e && e.message) || e)}`);
  }
}
const P = 'claudeCodeOrchestrator.';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const until = async (fn, ms = 5000, step = 20) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
};
/** A hover as a person reads it: the escapes of MarkdownString.appendText taken out again. */
const shown = (md) => String(md !== null && typeof md === 'object' ? md.value : md).replace(/&nbsp;/g, ' ').replace(/\\([\\`*_{}[\]()#+\-!~>])/g, '$1');

function boot(opts = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-ui7-')));
  const home = path.join(scratch, 'home');
  const ws = opts.noWorkspace ? undefined : path.join(scratch, 'ws');
  if (ws) fs.mkdirSync(ws, { recursive: true });
  const h = install({ repo: REPO, out: OUT, home, ...opts, workspace: ws });
  h.scratch = scratch;
  h.ws = ws;
  fs.mkdirSync(path.join(h.root, 'tasks'), { recursive: true });
  addQuickPick(h);
  return h;
}

/**
 * `window.createQuickPick` and `QuickPickItemKind`, which the stand-in lacks. A picker records
 * every assignment of its items (with the busy flag and the title at that moment), so a check
 * can say what was on screen when. The test drives it: `_accept(item)` / `hide()`.
 */
function addQuickPick(h) {
  const { EventEmitter } = h.vscode;
  h.log.pickers = [];
  h.vscode.QuickPickItemKind = { Separator: -1, Default: 0 };
  h.vscode.window.createQuickPick = () => {
    const accept = new EventEmitter();
    const hidden = new EventEmitter();
    let items = [];
    const qp = {
      createdAt: Date.now(), shownAt: undefined, timeline: [], busy: false, title: undefined, placeholder: undefined, value: '',
      activeItems: [], selectedItems: [], isHidden: false, disposed: false,
      get items() { return items; },
      set items(next) { items = next; this.timeline.push({ at: Date.now(), busy: this.busy, title: this.title, labels: next.map((i) => i.label) }); },
      onDidAccept: accept.event, onDidHide: hidden.event,
      show() { this.shownAt = Date.now(); h.log.pickers.push(this); },
      hide() { if (!this.isHidden) { this.isHidden = true; hidden.fire(); } },
      dispose() { this.disposed = true; },
      _accept(item) { this.selectedItems = item ? [item] : []; accept.fire(); },
    };
    return qp;
  };
}

async function activate(h, wait = 600) {
  let threw = '';
  try {
    h.req('extension.js').activate(h.context);
  } catch (e) {
    threw = String((e && e.stack) || e);
  }
  await sleep(wait);
  return threw;
}
const exec = async (h, id, ...args) => {
  let threw = '';
  let value;
  try {
    value = await h.vscode.commands.executeCommand(P + id, ...args);
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  return { threw, value };
};
const brief = (h) => h.log.messages.map((m) => [m.level, m.modal ? 'modal' : '', String(m.message).slice(0, 160), m.items]);
function finish(h) {
  check('no unhandled rejection or uncaught exception', h.log.rejections.length === 0, h.log.rejections.slice(0, 2));
  try { h.dispose(); } catch { /* best effort */ }
  try { fs.rmSync(h.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}

/* ---- fixture files ---- */

const dirOf = (h, name) => path.join(h.home, `.acct-${name}`);
/** Write the registry: Claude Code accounts under `workers`, the other vendors' under `vendorWorkers`. */
function writeRegistry(h, claude, vendor = []) {
  const registry = h.req('registry.js');
  for (const w of [...claude, ...vendor]) fs.mkdirSync(dirOf(h, w.name), { recursive: true });
  fs.mkdirSync(h.root, { recursive: true });
  const file = {
    workers: claude.map((w) => ({ name: w.name, configDir: dirOf(h, w.name), model: w.model, ...(w.preferred ? { preferred: true } : {}) })),
    vendorWorkers: vendor.map((w) => ({ name: w.name, configDir: dirOf(h, w.name), model: w.model ?? '', provider: w.provider })),
  };
  fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(file, null, 2));
  // A rewrite inside one millisecond with the same size is the same file to a stat-keyed cache.
  const at = new Date(Date.now() + (writeRegistry.bump = (writeRegistry.bump ?? 0) + 1000));
  fs.utimesSync(registry.REGISTRY_FILE, at, at);
}
let idSeq = 0;
const taskId = () => `t${(1000000 + ++idSeq).toString(36)}ui7`;
let tsSeq = Date.now() - 3_600_000;
/** One event of the task log; `ts` rises with every call. */
const ev = (id, status, worker, model, extra = {}) => ({ id, status, ts: (tsSeq += 1000), title: `task ${id}`, worker, model, ...extra });
function appendLog(h, events) {
  const registry = h.req('registry.js');
  fs.mkdirSync(h.root, { recursive: true });
  fs.appendFileSync(registry.TASKS_LOG_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
/** A finished task that asked for `model`; `used` is what the CLI reported (undefined: nothing). */
function doneTask(worker, model, source, used, extra = {}) {
  const id = taskId();
  const src = source === undefined ? {} : { modelSource: source };
  return {
    id,
    events: [ev(id, 'running', worker, model, { ...src, ...extra }), ev(id, 'done', worker, model, { ...src, ...(used === undefined ? {} : { modelUsed: used }), ...extra })],
  };
}
const buildModel = (h, extra = {}) =>
  h.req('uiModel.js').buildDashboardModel({ workspaceRoot: h.ws, scope: 'all', settings: {}, health: {}, sessions: [], ...extra });

/* ---- the stand-in for the bundled helper ---- */

/**
 * `provider-cli.js` as a file of this test's own. It appends its arguments and its pid to
 * `<file>.calls`, answers `status` with a refusal, and for `models` does what `<file>.mode`
 * says: {"kind":"print","text":"…","exit":0,"delayMs":0} | {"kind":"big"} | {"kind":"hang"}.
 */
function writeHelper(h) {
  const file = path.join(h.scratch, 'stand-in-provider-cli.js');
  fs.writeFileSync(
    file,
    `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(__filename + '.calls', JSON.stringify({ args, pid: process.pid }) + '\\n');
if (args[0] !== 'models') { process.stdout.write(JSON.stringify({ error: 'stand-in: no status' }) + '\\n'); process.exit(0); }
let mode = { kind: 'print', text: '', exit: 0 };
try { mode = JSON.parse(fs.readFileSync(__filename + '.mode', 'utf8')); } catch { /* the default */ }
if (mode.kind === 'hang') { setInterval(() => {}, 1000); }
else if (mode.kind === 'big') { const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 80; i++) process.stdout.write(chunk); process.stdout.write('\\n'); }
else { setTimeout(() => { process.stdout.write(mode.text); process.exitCode = mode.exit || 0; }, mode.delayMs || 0); }
`,
  );
  const calls = () => (fs.existsSync(`${file}.calls`) ? fs.readFileSync(`${file}.calls`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    file,
    set: (mode) => fs.writeFileSync(`${file}.mode`, JSON.stringify(mode)),
    answer: (obj, extra = {}) => fs.writeFileSync(`${file}.mode`, JSON.stringify({ kind: 'print', text: `${JSON.stringify(obj)}\n`, exit: 0, ...extra })),
    calls,
    modelCalls: () => calls().filter((c) => c.args[0] === 'models'),
  };
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/**
 * A catalog of the size and shape of a real `cursor-agent models` listing: 259 models in one
 * mixed order, 17 of them Cursor's own and 242 another vendor's (`resold: true`), with labels
 * of the shapes that CLI prints.
 */
function cursorCatalog() {
  const own = ['auto', ...Array.from({ length: 8 }, (_, i) => `composer-${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `cursor-small-${i + 1}`)];
  const ownLabels = ['Auto (default)', 'Composer 2.5'];
  const resold = Array.from({ length: 242 }, (_, i) => [`claude-opus-5-${i}-thinking`, `gpt-5.${i}-codex-low`, `grok-4.${i}-fast`, `gemini-3.${i}-flash-high`][i % 4]);
  const resoldLabels = ['Claude Opus 5 1M Thinking', 'Codex 5.3 Low', 'Grok 4.5 Fast', 'Gemini 3.8 Flash (High)'];
  const models = [];
  let o = 0;
  resold.forEach((id, i) => {
    if (i % 14 === 0 && o < own.length) {
      models.push(ownLabels[o] ? { id: own[o], label: ownLabels[o] } : { id: own[o] });
      o++;
    }
    models.push({ id, label: resoldLabels[i % 4], resold: true });
  });
  return { catalog: { models, source: 'live', error: null }, own, resold };
}

/* ========================================================================= *
 * I1 — the index and the page model
 * ========================================================================= */

async function i1IndexModel() {
  const h = boot({});
  const ui = h.req('uiModel.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'sonnet' }, { name: 'w3', model: 'claude-opus-4-8' }], [{ name: 'cx', provider: 'codex' }]);

  const a = doneTask('w1', 'opus', 'worker', 'claude-opus-5-5');
  const b = doneTask('w1', 'sonnet', 'dispatch', 'claude-sonnet-5');
  const c = doneTask('w1', 'opus', undefined, undefined); // a log entry of an earlier version
  const big = doneTask('w1', 'opus', 'worker', `claude-${'x'.repeat(10 * 1024)}`);
  const ctl = doneTask('w1', 'opus', 'worker', 'claude-\u0007opus‮-5');
  const proto = doneTask('w1', 'opus', '__proto__', '__proto__');
  const num = doneTask('w1', 'opus', 7, 42);
  const obj = doneTask('w1', 'opus', { toString: 'x' }, { id: 'claude-opus-5-5' });
  const spaced = doneTask('w1', 'opus', 'Worker', 'claude opus 5');
  const runId = taskId();
  const running = { id: runId, events: [ev(runId, 'running', 'w1', 'opus', { modelSource: 'worker', modelUsed: 'claude-opus-5-5' })] };
  const failId = taskId();
  const failed = { id: failId, events: [ev(failId, 'running', 'w1', 'haiku', { modelSource: 'dispatch' }), ev(failId, 'error', 'w1', 'haiku', { modelSource: 'dispatch', modelUsed: 'claude-haiku-4-5-20251001', error: 'boom' })] };
  const keepId = taskId();
  const kept = { id: keepId, events: [ev(keepId, 'running', 'cx', '', { modelSource: 'cli', provider: 'codex' }), ev(keepId, 'done', 'cx', '', { modelUsed: 'gpt-5.6-sol', provider: 'codex' })] };
  // The same run as the product writes it: the source is on the final event too.
  const cliRun = doneTask('cx', '-', 'cli', 'gpt-5.6-sol', { provider: 'codex' });
  // An id that is not of the minted shape but is one every reader of the log admits.
  const oddId = { id: 'Odd_id-1', events: [ev('Odd_id-1', 'done', 'w1', 'claude-opus-4-7', { modelSource: 'dispatch', modelUsed: 'claude-opus-4-7' })] };
  const all = [a, b, c, big, ctl, proto, num, obj, spaced, running, failed, cliRun, kept, oddId];
  appendLog(h, all.flatMap((t) => t.events));

  let model;
  try {
    model = buildModel(h);
  } catch (e) {
    check('buildDashboardModel does not throw on these events', false, String(e));
    return finish(h);
  }
  const task = (t) => model.tasks.find((x) => x.id === t.id) ?? {};
  const pair = (t) => [task(t).modelUsed, task(t).modelSource];
  check('every listed task carries BOTH fields (null, never absent)', model.tasks.length === all.length && model.tasks.every((t) => 'modelUsed' in t && 'modelSource' in t), model.tasks.filter((t) => !('modelUsed' in t && 'modelSource' in t)).length);
  check('a finished task: modelUsed and modelSource as recorded', same(pair(a), ['claude-opus-5-5', 'worker']) && same(pair(b), ['claude-sonnet-5', 'dispatch']), [pair(a), pair(b)]);
  check('an entry of an earlier version (neither field): null / null', same(pair(c), [null, null]), pair(c));
  check('a 10 kB modelUsed is not shown', task(big).modelUsed === null && task(big).modelSource === 'worker', pair(big));
  check('a modelUsed with control and bidi characters is not shown (not repaired into an id)', task(ctl).modelUsed === null, pair(ctl));
  check('"__proto__" as modelUsed and as modelSource: null / null', same(pair(proto), [null, null]), pair(proto));
  check('a number, and an object, in either field: null / null', same(pair(num), [null, null]) && same(pair(obj), [null, null]), [pair(num), pair(obj)]);
  check('a value that only resembles one (spaces; another letter case of the source): null / null', same(pair(spaced), [null, null]), pair(spaced));
  check('a RUNNING event that carries modelUsed: nothing has run to its end, so null', task(running).modelUsed === null && task(running).modelSource === 'worker', pair(running));
  check('a failed run whose terminal event carries modelUsed shows it', same(pair(failed), ['claude-haiku-4-5-20251001', 'dispatch']), pair(failed));
  check('modelSource is kept ON THE TASK past a terminal event that does not repeat it', same(pair(kept), ['gpt-5.6-sol', 'cli']), pair(kept));
  check('a task whose id is not of the minted shape, but is one every reader admits (letters, digits, _ and -), is listed like any other', same(pair(oddId), ['claude-opus-4-7', 'dispatch']), pair(oddId));
  check('no modelUsed is longer than 64 characters or holds a character outside a reported id', model.tasks.every((t) => t.modelUsed === null || /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/.test(t.modelUsed)), model.tasks.map((t) => t.modelUsed));

  const acct = (m, name) => m.accounts.find((x) => x.name === name) ?? {};
  check('every account carries modelRanAs (null, never absent)', model.accounts.length === 5 && model.accounts.every((x) => 'modelRanAs' in x), model.accounts.map((x) => [x.name, 'modelRanAs' in x]));
  check('w1 (default opus): what its newest finished opus task with a reported model ran as', acct(model, 'w1').modelRanAs === 'claude-opus-5-5', acct(model, 'w1').modelRanAs);
  check('w2 (default sonnet) has no task of its own: null — w1\'s sonnet task is not its', acct(model, 'w2').modelRanAs === null, acct(model, 'w2').modelRanAs);
  check('a worker with no default (the CLI chooses): what its newest task on the CLI default ran as', acct(model, 'cx').defaultModel === null && acct(model, 'cx').modelRanAs === 'gpt-5.6-sol', [acct(model, 'cx').defaultModel, acct(model, 'cx').modelRanAs]);
  guarded('…by the task\'s FINAL event alone: a run whose `cli` source is only on its running event says nothing (the one rule, ranAs.ranAsOf)', () => {
    // `kept` is the newest cx task and its final event names no source; without `cliRun` nothing would be shown.
    const only = h.req('ranAs.js').ranAsOf({ status: 'done', worker: 'cx', provider: 'codex', model: '', modelUsed: 'gpt-5.6-sol' }, { name: 'cx', provider: 'codex', defaultModel: null });
    return [only === undefined, only];
  });
  check('the hosting account (not a worker): null', acct(model, 'main').isWorker === false && acct(model, 'main').modelRanAs === null, acct(model, 'main'));

  // Newer tasks: file order decides, a task without a report changes nothing, a failed one does not count.
  const newer = doneTask('w1', 'opus', 'worker', 'claude-opus-5-6');
  const silent = doneTask('w1', 'opus', 'worker', undefined);
  const lateId = taskId();
  const lateFail = { id: lateId, events: [ev(lateId, 'error', 'w1', 'opus', { modelSource: 'worker', modelUsed: 'claude-opus-9-9', error: 'boom' })] };
  const w2other = doneTask('w2', 'opus', 'dispatch', 'claude-opus-5-6');
  appendLog(h, [...newer.events, ...silent.events, ...lateFail.events, ...w2other.events]);
  model = buildModel(h);
  check('a newer finished task moves it; a later one that reported nothing, and a later FAILED one, do not', acct(model, 'w1').modelRanAs === 'claude-opus-5-6', acct(model, 'w1').modelRanAs);
  check('a task of w2 that asked for ANOTHER model than its default does not count', acct(model, 'w2').modelRanAs === null, acct(model, 'w2').modelRanAs);
  const w2own = doneTask('w2', 'sonnet', 'worker', 'claude-sonnet-5');
  // A dated tier id of v1.x in an old log line is the alias it stood for — on both sides.
  const w3old = doneTask('w3', 'claude-opus-4-8', 'worker', 'claude-opus-4-8');
  appendLog(h, [...w2own.events, ...w3old.events]);
  model = buildModel(h);
  check('two accounts, each with its own answer', acct(model, 'w1').modelRanAs === 'claude-opus-5-6' && acct(model, 'w2').modelRanAs === 'claude-sonnet-5', [acct(model, 'w1').modelRanAs, acct(model, 'w2').modelRanAs]);
  check('a stored v1.x tier id reads as its alias, and a task recorded under that id counts for it', acct(model, 'w3').defaultModel === 'opus' && acct(model, 'w3').modelRanAs === 'claude-opus-4-8', [acct(model, 'w3').defaultModel, acct(model, 'w3').modelRanAs]);

  // The default changes after the tasks ran.
  writeRegistry(h, [{ name: 'w1', model: 'haiku' }, { name: 'w2', model: 'sonnet' }, { name: 'w3', model: 'opus' }], [{ name: 'cx', provider: 'codex', model: 'gpt-5.5' }]);
  model = buildModel(h);
  check('the default changed after the task ran: the old task no longer counts (null)', acct(model, 'w1').defaultModel === 'haiku' && acct(model, 'w1').modelRanAs === null, [acct(model, 'w1').defaultModel, acct(model, 'w1').modelRanAs]);
  check('…and a vendor worker given a default no longer shows what the CLI\'s own default ran as', acct(model, 'cx').defaultModel === 'gpt-5.5' && acct(model, 'cx').modelRanAs === null, [acct(model, 'cx').defaultModel, acct(model, 'cx').modelRanAs]);
  writeRegistry(h, [{ name: 'w1', model: 'sonnet' }, { name: 'w2', model: 'sonnet' }, { name: 'w3', model: 'opus' }], [{ name: 'cx', provider: 'codex' }]);
  model = buildModel(h);
  check('changed to a default an earlier task DID use: that task counts', acct(model, 'w1').modelRanAs === 'claude-sonnet-5' && acct(model, 'cx').modelRanAs === 'gpt-5.6-sol', [acct(model, 'w1').modelRanAs, acct(model, 'cx').modelRanAs]);

  // The one rule (ranAs.ranAsOf) is asked of each task's FINAL event, and of nothing else.
  writeRegistry(h, [{ name: 'wk', model: 'haiku' }, { name: 'wd', model: 'haiku' }, { name: 'we', model: 'haiku' }], [{ name: 'w2', provider: 'cursor' }, { name: 'w3', provider: 'cursor', model: 'opus' }, { name: 'cy', provider: 'codex', model: 'gpt-5.5-' + 'x'.repeat(60) + '-AAAA' }]);
  const cancelId = taskId();
  const dupId = taskId();
  appendLog(h, [
    // a cancel that lands after the work finished: running, done, then error — the task ended cancelled
    ev(cancelId, 'running', 'wk', 'haiku', { modelSource: 'worker', pid: 4242 }),
    ev(cancelId, 'done', 'wk', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }),
    ev(cancelId, 'error', 'wk', 'haiku', { modelSource: 'worker', pid: 4242, error: 'cancelled by user' }),
    // one id whose terminal events name two accounts: the task came to the second
    ev(dupId, 'done', 'wd', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-A' }),
    ev(dupId, 'done', 'we', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-B' }),
    // an account removed and its NAME reused on another CLI: a Codex run of "w2", a Claude Code run of "w3"
    ...doneTask('w2', 'gpt-5.5', 'cli', 'gpt-5.5', { provider: 'codex' }).events,
    ...doneTask('w3', 'opus', 'worker', 'claude-opus-5-5').events,
    // two vendor ids that share their first 64 characters
    ...doneTask('cy', 'gpt-5.5-' + 'x'.repeat(60) + '-BBBB', 'dispatch', 'gpt-other', { provider: 'codex' }).events,
  ]);
  model = buildModel(h);
  check('a task that finished and was THEN recorded cancelled (running, done, error) says nothing: its final event is not `done`', acct(model, 'wk').modelRanAs === null && ui.modelLastRanAs('wk', 'claude', 'haiku') === null, [acct(model, 'wk').modelRanAs, ui.modelLastRanAs('wk', 'claude', 'haiku')]);
  check('one task id with `done` events of two accounts: only the account of the FINAL event is told anything', acct(model, 'wd').modelRanAs === null && acct(model, 'we').modelRanAs === 'claude-haiku-B', [acct(model, 'wd').modelRanAs, acct(model, 'we').modelRanAs]);
  check('a name reused by an account on ANOTHER CLI inherits nothing: neither a Codex run under a Cursor account\'s name, nor a Claude Code run under one whose default is the same word', acct(model, 'w2').modelRanAs === null && acct(model, 'w3').modelRanAs === null && ui.modelLastRanAs('w2', 'cursor', null) === null && ui.modelLastRanAs('w2', 'codex', null) === 'gpt-5.5' && ui.modelLastRanAs('w3', 'cursor', 'opus') === null && ui.modelLastRanAs('w3', 'claude', 'opus') === 'claude-opus-5-5', [acct(model, 'w2').modelRanAs, acct(model, 'w3').modelRanAs, ui.modelLastRanAs('w2', 'codex', null), ui.modelLastRanAs('w3', 'claude', 'opus')]);
  check('two vendor model ids that share their first 64 characters are two models (the asked model is compared whole, never as it is displayed)', acct(model, 'cy').modelRanAs === null, acct(model, 'cy').modelRanAs);
  writeRegistry(h, [{ name: 'w1', model: 'sonnet' }, { name: 'w2', model: 'sonnet' }, { name: 'w3', model: 'opus' }], [{ name: 'cx', provider: 'codex' }]);
  buildModel(h);

  guarded('modelLastRanAs: by account, provider and model; null for an unknown account, a hostile name, a model that is not one', () => {
    const got = [ui.modelLastRanAs('w1', 'claude', 'opus'), ui.modelLastRanAs('w1', 'claude', 'fable'), ui.modelLastRanAs('nobody', 'claude', 'opus'), ui.modelLastRanAs('__proto__', 'claude', 'opus'), ui.modelLastRanAs('constructor', 'claude', 'opus'), ui.modelLastRanAs('w1', 'claude', 'rm -rf /'), ui.modelLastRanAs(7, 'claude', 'opus'), ui.modelLastRanAs('cx', 'codex', null), ui.modelLastRanAs('w1', 'claude', null)];
    return [same(got, ['claude-opus-5-6', null, null, null, null, null, null, 'gpt-5.6-sol', null]), got];
  });
  guarded('claudeModelLastRanAs: over every Claude Code task, never another vendor\'s', () => {
    const got = [ui.claudeModelLastRanAs('opus'), ui.claudeModelLastRanAs('sonnet'), ui.claudeModelLastRanAs('fable')];
    return [same(got, ['claude-opus-5-5', 'claude-sonnet-5', null]), got];
  });
  finish(h);
}

/* ========================================================================= *
 * I2 — what the two fields cost per task
 * ========================================================================= */

async function i2IndexMemory() {
  const h = boot({});
  const ui = h.req('uiModel.js');
  const registry = h.req('registry.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'sonnet' }]);
  const N = 50_000;
  const USED = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const SOURCES = ['dispatch', 'worker', 'cli'];
  const writeLog = (withFields) => {
    const fd = fs.openSync(registry.TASKS_LOG_FILE, 'w');
    const t0 = Date.now() - N * 2000 - 60_000;
    let chunk = [];
    for (let i = 0; i < N; i++) {
      const id = `t${(36 ** 7 + i).toString(36)}`;
      const base = { id, title: `task number ${i}`, worker: i % 2 ? 'w1' : 'w2', model: ['opus', 'sonnet', 'haiku'][i % 3], cwd: '/work/project' };
      const src = withFields ? { modelSource: SOURCES[i % 3] } : {};
      chunk.push(JSON.stringify({ ...base, status: 'running', ts: t0 + i * 2000, ...src }));
      chunk.push(JSON.stringify({ ...base, status: 'done', ts: t0 + i * 2000 + 900, inputTokens: 10, outputTokens: 5, costUsd: 0, ...src, ...(withFields ? { modelUsed: USED[i % 3] } : {}) }));
      if (chunk.length >= 4000) { fs.writeSync(fd, chunk.join('\n') + '\n'); chunk = []; }
    }
    if (chunk.length) fs.writeSync(fd, chunk.join('\n') + '\n');
    fs.closeSync(fd);
  };
  const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
  if (typeof global.gc !== 'function') {
    check('the case runs with --expose-gc', false, 'global.gc is not available');
    return finish(h);
  }
  const measure = (withFields) => {
    // The log is absent while the baseline is taken, so the index is empty then.
    fs.rmSync(registry.TASKS_LOG_FILE, { force: true });
    ui.rebuildTaskIndex();
    ui.listTasks({ root: undefined, limit: 1 });
    const base = heap();
    writeLog(withFields);
    ui.rebuildTaskIndex();
    const t0 = Date.now();
    const list = ui.listTasks({ root: undefined, limit: 1 });
    const ms = Date.now() - t0;
    return { bytes: heap() - base, total: list.total, ms };
  };
  measure(true); // warm-up: code and the shared strings are in place before anything is measured
  const without = measure(false);
  const withBoth = measure(true);
  const perWithout = without.bytes / N;
  const perWith = withBoth.bytes / N;
  const growth = perWith - perWithout;
  note(`index heap for ${N} tasks (two events each): ${Math.round(perWithout)} B/task without the fields, ${Math.round(perWith)} B/task with modelSource on both events and modelUsed on the terminal one — growth ${growth.toFixed(1)} B/task (first index of the log: ${withBoth.ms} ms)`);
  check('both logs index all 50,000 tasks', without.total === N && withBoth.total === N, [without.total, withBoth.total]);
  check('carrying both fields on every task grows the index by at most 24 bytes per task (they are shared strings, not copies)', growth <= 24, `${growth.toFixed(1)} B/task`);
  check('the index holds a task in at most 400 bytes', perWith <= 400, `${Math.round(perWith)} B/task`);
  const t1 = Date.now();
  const model = buildModel(h);
  const buildMs = Date.now() - t1;
  const t2 = Date.now();
  buildModel(h);
  const againMs = Date.now() - t2;
  note(`page model over that index: first build ${buildMs} ms, the next (nothing changed) ${againMs} ms`);
  const newest = model.tasks[0] ?? {};
  check('the newest task of that log shows its fields, and the accounts what their default ran as', USED.includes(newest.modelUsed) && SOURCES.includes(newest.modelSource) && model.accounts.find((x) => x.name === 'w1')?.modelRanAs === 'claude-opus-5-5' && model.accounts.find((x) => x.name === 'w2')?.modelRanAs === 'claude-sonnet-5', [newest.modelUsed, newest.modelSource, model.accounts.map((x) => [x.name, x.modelRanAs])]);
  // What an account's default ran as is kept per state of the log: asking again is a stat and
  // two map reads, not another pass over 50,000 rows.
  const t3 = Date.now();
  let answers = 0;
  for (let i = 0; i < 2000; i++) if (ui.modelLastRanAs(i % 2 ? 'w1' : 'w2', 'claude', i % 2 ? 'opus' : 'sonnet') !== null) answers++;
  const askMs = Date.now() - t3;
  note(`2,000 lookups of "what did this default last run as" on the unchanged log: ${askMs} ms`);
  check('with the log unchanged, that question does not walk the index again (2,000 lookups in under a second)', answers === 2000 && askMs < 1000, [answers, `${askMs} ms`]);
  finish(h);
}

/* ========================================================================= *
 * U1 — the catalog reader (usage.listProviderModels)
 * ========================================================================= */

async function u1Catalog() {
  const h = boot({});
  const usage = h.req('usage.js');
  const helper = writeHelper(h);
  if (typeof usage.listProviderModels !== 'function') {
    check('usage.listProviderModels exists', false, typeof usage.listProviderModels);
    return finish(h);
  }
  const dir = dirOf(h, 'cx');
  fs.mkdirSync(dir, { recursive: true });
  const ask = (extra = {}) => usage.listProviderModels({ helperPath: helper.file, provider: 'codex', configDir: dir, ...extra });
  const fresh = async (mode, extra) => {
    usage.resetProviderModelsForTest();
    if (mode !== undefined) helper.set(mode);
    const before = helper.modelCalls().length;
    const t0 = Date.now();
    const catalog = await ask(extra);
    return { catalog, ms: Date.now() - t0, spawned: helper.modelCalls().length - before };
  };
  const printed = (obj, extra = {}) => ({ kind: 'print', text: `${JSON.stringify(obj)}\n`, exit: 0, ...extra });
  const LIVE = { models: [{ id: 'gpt-9-live-a', label: 'GPT 9 A' }, { id: 'gpt-9-live-b' }], source: 'live', error: null };

  let r = await fresh(printed(LIVE));
  check('a live answer: the ids in the CLI\'s order, a label or null, source "live", no error', same(r.catalog.models, [{ id: 'gpt-9-live-a', label: 'GPT 9 A', resold: false }, { id: 'gpt-9-live-b', label: null, resold: false }]) && r.catalog.source === 'live' && r.catalog.error === null && r.spawned === 1, r);
  const call = helper.modelCalls().pop();
  check('the helper is run as `models <provider> <configDir> --budget-ms=<n>` — the budget LAST, 25 s unless the caller gives another', same(call.args, ['models', 'codex', dir, '--budget-ms=25000']), call.args);
  const before = helper.modelCalls().length;
  const again = await ask();
  check('a second question inside ten minutes starts nothing and gets the same list', helper.modelCalls().length === before && same(again.models, r.catalog.models), [helper.modelCalls().length - before, again]);
  check('…and the list can be read from memory: for the directory, and as the provider\'s newest', usage.cachedProviderModels('codex', dir)?.models.length === 2 && usage.freshProviderModels('codex')?.models.length === 2 && usage.cachedProviderModels('cursor', dir) === undefined && usage.freshProviderModels('cursor') === undefined, [usage.cachedProviderModels('codex', dir), usage.freshProviderModels('cursor')]);
  check('…until ten minutes have passed', usage.cachedProviderModels('codex', dir, Date.now() + 9 * 60_000) !== undefined && usage.cachedProviderModels('codex', dir, Date.now() + 10 * 60_000 + 1000) === undefined && usage.cachedProviderModels('codex', dir, Date.now() - 60_000) === undefined, 'ttl');
  usage.resetProviderModelsForTest();
  helper.set(printed(LIVE, { delayMs: 300 }));
  const n0 = helper.modelCalls().length;
  const [x, y] = await Promise.all([ask(), ask()]);
  check('two questions at once share one helper process', helper.modelCalls().length - n0 === 1 && same(x.models, y.models) && x.models.length === 2, helper.modelCalls().length - n0);

  r = await fresh(printed({ models: [{ id: 'gpt-8-static' }], source: 'static', error: null }));
  check('the adapter\'s built-in catalog: source "static"', r.catalog.source === 'static' && r.catalog.models.length === 1, r.catalog);
  r = await fresh(printed({ models: [], source: 'live', error: 'not signed in' }));
  check('an answer that carries an error: no list, the error in one line', r.catalog.source === 'none' && r.catalog.models.length === 0 && r.catalog.error === 'not signed in', r.catalog);
  const afterError = helper.modelCalls().length;
  await ask();
  check('…and "no list" is not asked again at once (kept for a minute, then asked again)', helper.modelCalls().length === afterError && usage.cachedProviderModels('codex', dir, Date.now() + 61_000) === undefined, helper.modelCalls().length - afterError);
  r = await fresh(printed({ models: [], source: 'live', error: null }));
  check('an EMPTY list is no list: source "none" with a sentence — never a "live" catalog of nothing', r.catalog.source === 'none' && r.catalog.models.length === 0 && typeof r.catalog.error === 'string' && r.catalog.error !== '', r.catalog);
  check('…and it is held like every other "no list": a minute, not ten', usage.cachedProviderModels('codex', dir, Date.now() + 30_000) !== undefined && usage.cachedProviderModels('codex', dir, Date.now() + 61_000) === undefined, 'ttl');
  r = await fresh(printed({ models: [{ id: 'has space' }, { id: '$(trash)' }, { id: 7 }, null, { id: 'x'.repeat(129) }], source: 'static', error: null }));
  check('a list whose every entry is refused is no list either', r.catalog.source === 'none' && r.catalog.models.length === 0 && typeof r.catalog.error === 'string', r.catalog);

  const none = (c) => c.source === 'none' && c.models.length === 0 && typeof c.error === 'string' && c.error !== '' && !/[\n\r]/.test(c.error) && c.error.length <= 200;
  r = await fresh({ kind: 'print', text: '<<< not json >>>\n', exit: 0 });
  check('garbage on stdout: no list', none(r.catalog), r.catalog);
  r = await fresh({ kind: 'print', text: '', exit: 0 });
  check('nothing on stdout: no list', none(r.catalog), r.catalog);
  r = await fresh({ kind: 'print', text: `a notice\n${JSON.stringify(LIVE)}\n`, exit: 0 });
  check('two lines where one is the contract: no list', none(r.catalog), r.catalog);
  r = await fresh(printed(LIVE, { exit: 3 }));
  check('a list from a process that exits non-zero: no list', none(r.catalog) && /code 3/.test(r.catalog.error), r.catalog);
  for (const [what, body] of [['an array', [1, 2]], ['a string', 'models'], ['null', null], ['models that is not an array', { models: 'x', source: 'live', error: null }], ['a source this code does not know', { models: [{ id: 'a' }], source: 'guess', error: null }], ['no source', { models: [{ id: 'a' }], error: null }]]) {
    r = await fresh(printed(body));
    check(`wrong shape (${what}): no list`, none(r.catalog), r.catalog);
  }
  r = await fresh({ kind: 'big' });
  check('5 MB of output: the helper is ended at the cap and there is no list — in well under the time budget', none(r.catalog) && /too large/.test(r.catalog.error) && r.ms < 5000, [r.catalog, r.ms]);
  // The budget is the HELPER's: it is handed over as the last argument, and the helper is ended
  // from here only five seconds past it — an orderly helper ends first, with what it started.
  r = await fresh({ kind: 'hang' }, { timeoutMs: 1000 });
  const hung = helper.modelCalls().pop();
  check('a helper that never answers: it is told its budget (1000 ms), and "no list" comes five seconds past it — not at it', none(r.catalog) && /timeout/.test(r.catalog.error) && hung.args[3] === '--budget-ms=1000' && r.ms >= 5900 && r.ms < 9000, [r.catalog, hung.args, r.ms]);
  await until(() => !alive(hung.pid), 8000, 100);
  check('…and the process is ended, not left behind', !alive(hung.pid), hung.pid);
  r = await fresh(printed(LIVE, { delayMs: 2500 }), { timeoutMs: 1000 });
  check('a helper that answers inside those five seconds (2.5 s into a 1 s budget) is ANSWERED, not cut off', r.catalog.source === 'live' && r.catalog.models.length === 2 && r.ms >= 2400, [r.catalog.source, r.catalog.error, r.ms]);
  const budgets = [];
  for (const wish of [10 * 60_000, 25_000, 300, 1, 1500.6, 0, -5, NaN, '3000']) {
    r = await fresh(printed(LIVE), { timeoutMs: wish });
    budgets.push(helper.modelCalls().pop().args[3]);
  }
  check('the budget handed over is always one the helper takes: 1000 to 25000 ms, a whole number; a wish that is not a time is the default', same(budgets, ['--budget-ms=25000', '--budget-ms=25000', '--budget-ms=1000', '--budget-ms=1000', '--budget-ms=1501', '--budget-ms=25000', '--budget-ms=25000', '--budget-ms=25000', '--budget-ms=25000']), budgets);
  // Callers that overlap share a child only when they gave it the same time.
  usage.resetProviderModelsForTest();
  helper.set(printed(LIVE, { delayMs: 1500 }));
  let before2 = helper.modelCalls().length;
  const tA = Date.now();
  const [short, long] = await Promise.all([ask({ timeoutMs: 1000 }), ask()]);
  const started = helper.modelCalls().slice(before2).map((c) => c.args[3]).sort();
  check('caller A (budget 1 s) and caller B (default 25 s) at once: TWO children, each with its own budget — and B is answered, not handed A\'s patience', same(started, ['--budget-ms=1000', '--budget-ms=25000']) && long.source === 'live' && long.models.length === 2 && short.source === 'live', { started, short: [short.source, short.error], long: [long.source, long.error], ms: Date.now() - tA });
  usage.resetProviderModelsForTest();
  before2 = helper.modelCalls().length;
  await Promise.all([ask({ timeoutMs: 4000 }), ask({ timeoutMs: 4000 }), ask({ timeoutMs: 4000.2 })]);
  check('three callers with the same budget share ONE child', helper.modelCalls().length - before2 === 1, helper.modelCalls().length - before2);

  // Bounds and hostile entries.
  const many = Array.from({ length: 700 }, (_, i) => ({ id: `m-${i}` }));
  r = await fresh(printed({ models: many, source: 'live', error: null }));
  check('700 entries: the first 600', r.catalog.models.length === 600 && r.catalog.models[599].id === 'm-599', r.catalog.models.length);
  const real = cursorCatalog();
  r = await fresh(printed(real.catalog));
  check('a listing the size of a real one (259 models, 17 own and 242 resold) is taken whole, in its order', r.catalog.models.length === 259 && same(r.catalog.models.filter((m) => !m.resold).map((m) => m.id), real.own) && same(r.catalog.models.filter((m) => m.resold).map((m) => m.id), real.resold) && same(r.catalog.models.map((m) => m.id), real.catalog.models.map((m) => m.id)) && r.catalog.models[0].label === 'Auto (default)', [r.catalog.models.length, r.catalog.models.filter((m) => !m.resold).length, r.catalog.error]);
  const hostile = [
    { id: 'ok-1', label: `L${'x'.repeat(10_000)}` }, { id: 'x'.repeat(129) }, { id: 'has space' }, { id: '$(rm -rf /)' }, { id: '__proto__' }, { id: 7 }, 'ok-string', null, [],
    { id: 'ok-1' }, { id: 'ok-2', label: 'bi‮di \u0007ctl\nline' }, { id: 'ok-3', label: 42 }, { id: 'ok-4', resold: true }, { id: 'ok-5', resold: 'yes' }, { id: 'ok-6', resold: 1 }, { id: 'ok-7', resold: null }, { id: ' ok-8 ' },
  ];
  r = await fresh(printed({ models: hostile, source: 'live', error: null, __proto__: { polluted: true } }));
  const ids = r.catalog.models.map((m) => m.id);
  check('ids that are not model ids (over 128 chars, a space, shell syntax, "__proto__", a number, not an object) are left out; a repeated id is listed once; a padded one is trimmed', same(ids, ['ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5', 'ok-6', 'ok-7', 'ok-8']), ids);
  const byId = Object.fromEntries(r.catalog.models.map((m) => [m.id, m]));
  check('a 10 kB label is cut to 80 characters; control and bidi characters are gone; a label that is not text is null', byId['ok-1']?.label.length <= 80 && !/[\u0000-\u001f‮]/.test(byId['ok-2']?.label ?? '\u0000') && byId['ok-3']?.label === null, [byId['ok-1']?.label.length, byId['ok-2']?.label, byId['ok-3']?.label]);
  check('`resold` counts only when it is exactly true (a string, a number, null and a missing key are "its own")', same([4, 5, 6, 7, 1].map((n) => byId[`ok-${n}`]?.resold), [true, false, false, false, false]), r.catalog.models.map((m) => [m.id, m.resold]));
  check('nothing reached Object.prototype', ({}).polluted === undefined, ({}).polluted);
  r = await fresh(printed({ models: [], source: 'live', error: `e${'r'.repeat(5000)}\nsecond line` }));
  check('an error text is one line of at most 200 characters', none(r.catalog), [r.catalog.error.length, r.catalog.error.slice(0, 40)]);

  // A reading filed under a directory called `__proto__` is an entry like any other.
  guarded('mergeUsageCaches: a reading under the key `__proto__` (a string a hand-edited registry can hold as a directory) becomes an OWN entry — no prototype is changed, and no reading is lost', () => {
    // The key is new to the copy on disk: a plain assignment under it would set the prototype instead.
    const merged = usage.mergeUsageCaches(JSON.parse('{"/a":{"name":"a","fetchedAt":1}}'), JSON.parse('{"__proto__":{"name":"new","fetchedAt":9},"/b":{"name":"b","fetchedAt":2}}'));
    const own = Object.prototype.hasOwnProperty.call(merged, '__proto__') ? Object.getOwnPropertyDescriptor(merged, '__proto__').value : undefined;
    const again = usage.mergeUsageCaches(merged, JSON.parse('{"__proto__":{"name":"newer","fetchedAt":12}}'));
    const ownAgain = Object.prototype.hasOwnProperty.call(again, '__proto__') ? Object.getOwnPropertyDescriptor(again, '__proto__').value : undefined;
    const round = JSON.parse(JSON.stringify(merged));
    return [Object.getPrototypeOf(merged) === Object.prototype && own !== undefined && own.name === 'new' && ownAgain !== undefined && ownAgain.name === 'newer' && round['/a'].name === 'a' && round['/b'].name === 'b' && Object.keys(merged).length === 3 && ({}).name === undefined, { proto: Object.getPrototypeOf(merged) === Object.prototype, own, keys: Object.keys(merged) }];
  });

  // The real helper of the tree under test, bundled now. Reported, not judged: until the helper
  // takes `--budget-ms=` it answers that argument as a bad invocation.
  try {
    const { spawnSync } = require('child_process');
    const bundled = path.join(h.scratch, 'real-provider-cli.js');
    const built = spawnSync(path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'), ['src/mcp/provider-cli.ts', '--bundle', '--platform=node', '--target=node18', '--log-level=error', `--outfile=${bundled}`], { cwd: REPO, encoding: 'utf8' });
    if (built.status !== 0) {
      note(`the real helper could not be bundled (${String(built.stderr).trim().split('\n')[0]}) — not run`);
    } else {
      usage.resetProviderModelsForTest();
      const t0 = Date.now();
      const real = await usage.listProviderModels({ helperPath: bundled, provider: 'codex', configDir: dir, timeoutMs: 3000 });
      note(`the real provider-cli.js (bundled from this tree), asked \`models codex <dir> --budget-ms=3000\` with only a fake \`codex\` on PATH: source ${real.source}, ${real.models.length} model(s), error ${JSON.stringify(real.error)} — after ${Date.now() - t0} ms`);
    }
  } catch (e) {
    note(`the real helper row did not run: ${String((e && e.message) || e)}`);
  }

  // What is never asked.
  usage.resetProviderModelsForTest();
  const c0 = helper.calls().length;
  const rel = await usage.listProviderModels({ helperPath: helper.file, provider: 'codex', configDir: '--quota' });
  const gone = await usage.listProviderModels({ helperPath: path.join(h.scratch, 'no-such-helper.js'), provider: 'codex', configDir: dir });
  const relHelper = await usage.listProviderModels({ helperPath: 'provider-cli.js', provider: 'codex', configDir: dir });
  const junk = await Promise.all([undefined, null, 7, 'x', {}, { provider: 7 }].map((o) => usage.listProviderModels(o)));
  check('a directory that is not an absolute path, a helper that is not there, and arguments that are no arguments: no list, no process, no throw', [rel, gone, relHelper, ...junk].every(none) && helper.calls().length === c0, [rel.error, gone.error, relHelper.error, junk.map((j) => j.error)]);
  finish(h);
}

/* ========================================================================= *
 * K1 — the Claude Code model picker
 * ========================================================================= */

async function k1ClaudePicker() {
  const h = boot({});
  const registry = h.req('registry.js');
  const platform = h.req('platform.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'claude-opus-4-7' }]);
  appendLog(h, [
    ...doneTask('w1', 'opus', 'worker', 'claude-opus-5-5').events,
    ...doneTask('w1', 'sonnet', 'dispatch', 'claude-sonnet-5').events,
    ...doneTask('w2', 'haiku', 'dispatch', 'claude-haiku-4-5-20251001').events,
  ]);
  await activate(h, 700);
  const modelOf = (name) => registry.readRegistry().workers.find((w) => w.name === name)?.model;
  /** The entry as the FILE holds it: what was written, whatever a reader of this build makes of it. */
  const rawEntry = (name) => {
    try {
      return JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8')).workers.find((w) => w.name === name);
    } catch {
      return undefined;
    }
  };
  const run = async (name, answers = {}) => {
    h.log.messages.length = 0; h.log.quickPicks.length = 0; h.log.inputBoxes.length = 0;
    h.answers.quickPick = answers.quickPick ?? (() => undefined);
    h.answers.inputBox = answers.inputBox ?? (() => undefined);
    const r = await exec(h, 'setWorkerModel', { name });
    await sleep(30);
    return { ...r, items: h.log.quickPicks[0]?.items ?? [], options: h.log.quickPicks[0]?.options };
  };
  const ENTER = 'Enter a model id…';
  // What the fable item adds while the frontier guard blocks the tier — which is the guard's default.
  const FRONTIER = 'frontier tier, which the frontier guard blocks: while it does, dispatches that name no model will skip an account whose default this is';

  let r = await run('w1');
  const labels = r.items.map((i) => i.label);
  check('"Set Default Model" of a Claude Code worker: one item per WORKER_MODELS alias, then "Enter a model id…"', r.threw === '' && same(labels, [...platform.WORKER_MODELS, ENTER]), labels);
  check('…the aliases are opus, sonnet, haiku, fable — haiku among them', same([...platform.WORKER_MODELS], ['opus', 'sonnet', 'haiku', 'fable']), platform.WORKER_MODELS);
  const item = (label) => r.items.find((i) => i.label === label) ?? {};
  check('every alias says what an alias is: "Newest <alias> model this account\'s CLI offers"', platform.WORKER_MODELS.every((m) => String(item(m).detail).startsWith(`Newest ${m} model this account's CLI offers`)), r.items.map((i) => i.detail));
  check('the current one is marked, and only it', item('opus').description === 'current' && r.items.filter((i) => i.description === 'current').length === 1, r.items.map((i) => [i.label, i.description]));
  check('an alias this account has run says what it last ran as', item('opus').detail === "Newest opus model this account's CLI offers · last ran as claude-opus-5-5" && item('sonnet').detail === "Newest sonnet model this account's CLI offers · last ran as claude-sonnet-5", [item('opus').detail, item('sonnet').detail]);
  check('an alias only ANOTHER account has run, and one nobody has, say nothing more (never a guess)', item('haiku').detail === "Newest haiku model this account's CLI offers" && item('fable').detail === `Newest fable model this account's CLI offers · ${FRONTIER}`, [item('haiku').detail, item('fable').detail]);
  check('dismissed: nothing changes and nothing is said', modelOf('w1') === 'opus' && h.log.messages.length === 0, brief(h));

  r = await run('w1', { quickPick: (list) => list.find((i) => i.label === 'haiku') });
  check('picking haiku stores haiku', modelOf('w1') === 'haiku' && h.log.messages.some((m) => /now defaults to haiku/.test(String(m.message))), [modelOf('w1'), brief(h)]);

  r = await run('w2');
  check('a stored default that is a full id is the first item, marked as the current one', r.items[0]?.label === 'claude-opus-4-7' && r.items[0]?.description === 'current' && same(r.items.slice(1).map((i) => i.label), [...platform.WORKER_MODELS, ENTER]) && r.items.filter((i) => i.description === 'current').length === 1, r.items.map((i) => [i.label, i.description]));
  check('…and w2\'s own haiku task shows on ITS haiku item', r.items.find((i) => i.label === 'haiku')?.detail === "Newest haiku model this account's CLI offers · last ran as claude-haiku-4-5-20251001", r.items.find((i) => i.label === 'haiku')?.detail);

  // A typed id.
  let validation;
  r = await run('w2', { quickPick: (list) => list.find((i) => i.label === ENTER), inputBox: (o) => { validation = [o.validateInput('claude-opus-5-5'), o.validateInput('not a model'), o.prompt]; return '  Claude-Opus-5-5 '; } });
  check('"Enter a model id…": the box accepts a full id and refuses free text with the existing hint', validation && validation[0] === undefined && typeof validation[1] === 'string' && validation[1].includes(platform.MODEL_FORMS_HINT) && String(validation[2]).includes(platform.MODEL_FORMS_HINT), validation);
  check('…a typed id is stored as platform.normalizeModel gives it', modelOf('w2') === 'claude-opus-5-5', modelOf('w2'));
  r = await run('w2', { quickPick: (list) => list.find((i) => i.label === ENTER), inputBox: () => 'fable' });
  check('…an alias typed there is an alias', modelOf('w2') === 'fable', modelOf('w2'));
  const refused = [];
  for (const bad of ['rm -rf /', '', 'gpt-5.5', 'claude-', `claude-${'x'.repeat(200)}`, 'claude-opus-5-5; echo']) {
    r = await run('w2', { quickPick: (list) => list.find((i) => i.label === ENTER), inputBox: () => bad });
    refused.push([bad.slice(0, 20), modelOf('w2'), h.log.messages.filter((m) => m.level === 'warning' && /Not a model this extension can store/.test(String(m.message))).length]);
  }
  check('…a value that got past the box and is not a model is refused with the existing sentence, and nothing is stored', refused.every((x) => x[1] === 'fable' && x[2] === 1), refused);
  r = await run('w2', { quickPick: (list) => list.find((i) => i.label === ENTER), inputBox: () => undefined });
  check('…a box left with Escape changes nothing', modelOf('w2') === 'fable' && h.log.messages.length === 0, brief(h));

  // The three v1.x tier ids, TYPED, are those models: pinned exactly, with a note before the box
  // is accepted that the alias is the way to follow the newest.
  let told;
  const typeIt = (text) => run('w2', { quickPick: (list) => list.find((i) => i.label === ENTER), inputBox: (o) => { told = o.validateInput(text); return text; } });
  r = await typeIt('claude-sonnet-5');
  const sonnetTold = told;
  check('typing claude-sonnet-5: the box says, BEFORE it is accepted, that the id is pinned exactly and that the alias "sonnet" would follow the newest — as a note (Info), which does not refuse the value', told !== null && typeof told === 'object' && told.message === 'claude-sonnet-5 is pinned exactly: the worker runs this model. The alias "sonnet" would follow the newest sonnet model its CLI offers.' && told.severity === 1, told);
  check('…the file holds the id itself, pinned (`modelPinned: true`), and the confirmation says it is pinned', rawEntry('w2')?.model === 'claude-sonnet-5' && rawEntry('w2')?.modelPinned === true && h.log.messages.some((m) => m.level === 'info' && String(m.message) === '"w2" now defaults to claude-sonnet-5 for dispatches that name no model — pinned: the CLI runs exactly this model, whatever is newest.'), [rawEntry('w2'), brief(h)]);
  r = await typeIt('  CLAUDE-SONNET-5 ');
  check('typed in capitals and padded: the same note as the lowercase id', told && sonnetTold && told.message === sonnetTold.message && told.severity === sonnetTold.severity, told);
  const others = [];
  for (const [id, alias] of [['claude-opus-4-8', 'opus'], ['claude-fable-5', 'fable']]) {
    r = await typeIt(id);
    others.push([told && told.message, rawEntry('w2')?.model === id && rawEntry('w2')?.modelPinned === true, alias]);
  }
  check('the same for claude-opus-4-8 and claude-fable-5: each pinned as itself', others.every(([m, stored, alias], i) => m === `${['claude-opus-4-8', 'claude-fable-5'][i]} is pinned exactly: the worker runs this model. The alias "${alias}" would follow the newest ${alias} model its CLI offers.` && stored), others);
  r = await typeIt('claude-opus-5-5');
  check('a full id that names no tier gets no note, and is stored pinned with the pinned confirmation', told === undefined && rawEntry('w2')?.model === 'claude-opus-5-5' && rawEntry('w2')?.modelPinned === true && h.log.messages.some((m) => String(m.message) === '"w2" now defaults to claude-opus-5-5 for dispatches that name no model — pinned: the CLI runs exactly this model, whatever is newest.'), [told, rawEntry('w2'), brief(h)]);
  r = await run('w2', { quickPick: (list) => list.find((i) => i.label === 'sonnet') });
  check('choosing an alias stores the alias and takes `modelPinned` away', rawEntry('w2')?.model === 'sonnet' && !('modelPinned' in (rawEntry('w2') ?? {})) && h.log.messages.some((m) => String(m.message) === '"w2" now defaults to sonnet for dispatches that name no model.'), [rawEntry('w2'), brief(h)]);
  r = await typeIt('claude-opus-5-5');
  const protoNames = [];
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    r = await typeIt(bad);
    protoNames.push([bad, typeof told, modelOf('w2'), h.log.messages.filter((m) => m.level === 'warning' && /Not a model this extension can store/.test(String(m.message))).length]);
  }
  check('"constructor", "__proto__" and the like are not models: the box says so while typing, and nothing is stored', protoNames.every((x) => x[1] === 'string' && x[2] === 'claude-opus-5-5' && x[3] === 1), protoNames);

  // The frontier guard: an account whose default is on the tier takes no dispatch that names no model.
  r = await run('w1');
  const detailOf = (label) => r.items.find((i) => i.label === label)?.detail;
  check('while the frontier guard blocks the tier (its default), the fable item says what choosing it means — after what an alias is', detailOf('fable') === `Newest fable model this account's CLI offers · ${FRONTIER}` && !['opus', 'sonnet', 'haiku'].some((m) => String(detailOf(m)).includes('frontier')), r.items.map((i) => [i.label, i.detail]));
  h.store.global['claudeCodeOrchestrator.frontierWorkerDispatch'] = 'allow';
  h.fireConfig();
  await sleep(150);
  r = await run('w1');
  check('…and with the guard set to Allow it says nothing of the kind', registry.readRegistry().frontierWorkerDispatch === 'allow' && detailOf('fable') === "Newest fable model this account's CLI offers", [registry.readRegistry().frontierWorkerDispatch, detailOf('fable')]);
  delete h.store.global['claudeCodeOrchestrator.frontierWorkerDispatch'];
  h.fireConfig();
  await sleep(150);

  // A worker that does not exist yet (Add Worker): what the alias last ran as on this machine.
  h.log.messages.length = 0; h.log.quickPicks.length = 0;
  let seen;
  h.answers.inputBox = () => 'brandnew';
  h.answers.quickPick = (list) => {
    const claude = list.find((i) => i.info && i.info.id === 'claude');
    if (claude) return claude;
    seen = list;
    return undefined;
  };
  const add = await exec(h, 'addWorker');
  await sleep(30);
  const detail = (label) => (seen ?? []).find((i) => i.label === label)?.detail;
  check('Add Worker (no account yet): the same items, with no item marked current', add.threw === '' && same((seen ?? []).map((i) => i.label), [...platform.WORKER_MODELS, ENTER]) && (seen ?? []).every((i) => i.description === undefined), (seen ?? []).map((i) => [i.label, i.description]));
  // A typed v1.x tier id in Add Worker: stored as typed, pinned.
  h.log.messages.length = 0;
  let boxes = 0;
  h.answers.inputBox = (o) => (boxes++ === 0 ? 'brandnew2' : 'claude-opus-4-8');
  h.answers.quickPick = (list) => list.find((i) => i.info && i.info.id === 'claude') ?? list.find((i) => i.label === ENTER);
  h.answers.message = () => undefined;
  await exec(h, 'addWorker');
  await sleep(60);
  check('…a typed claude-opus-4-8 there is that model: the new worker holds it pinned, and nothing says it was read as a tier', rawEntry('brandnew2')?.model === 'claude-opus-4-8' && rawEntry('brandnew2')?.modelPinned === true && !h.log.messages.some((m) => /read as the alias/.test(String(m.message))), [rawEntry('brandnew2'), brief(h)]);
  h.answers.inputBox = () => 'brandnew';
  check('…an alias says what it last ran as ON ANOTHER ACCOUNT here, in those words', detail('opus') === "Newest opus model this account's CLI offers · last ran as claude-opus-5-5 on another account here" && detail('haiku') === "Newest haiku model this account's CLI offers · last ran as claude-haiku-4-5-20251001 on another account here" && detail('fable') === `Newest fable model this account's CLI offers · ${FRONTIER}`, [detail('opus'), detail('haiku'), detail('fable')]);
  check('…and dismissing the model step adds no worker', !registry.readRegistry().workers.some((w) => w.name === 'brandnew') && !fs.existsSync(path.join(h.home, '.claude-brandnew')), registry.readRegistry().workers.map((w) => w.name));
  finish(h);
}

/* ========================================================================= *
 * K2 — the model picker of another vendor's worker
 * ========================================================================= */

async function k2VendorPicker() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const providers = h.req('providers.js');
  const helper = writeHelper(h);
  // The extension asks its context for the helper's path; here that is the stand-in.
  const baseAbs = h.context.asAbsolutePath;
  h.context.asAbsolutePath = (p) => (/provider-cli\.js$/.test(p) ? helper.file : baseAbs(p));
  // The extension's output channel, with a switch that makes it behave like a disposed one.
  const baseChannel = h.vscode.window.createOutputChannel;
  h.vscode.window.createOutputChannel = (name) => {
    const channel = baseChannel(name);
    const append = channel.appendLine;
    channel.appendLine = (line) => {
      if (h.channelThrows) throw new Error('Channel has been closed');
      return append(line);
    };
    return channel;
  };
  writeRegistry(h, [{ name: 'w1', model: 'opus' }], [
    { name: 'cx', provider: 'codex', model: 'gpt-5.5' },
    { name: 'cx2', provider: 'codex', model: 'my-own-model-x' },
    { name: 'cx3', provider: 'codex' },
    { name: 'cur', provider: 'cursor', model: 'claude-opus-5-5-high' },
    { name: 'ag', provider: 'gemini', model: 'kimi-k2' },
  ]);
  // Fresh readings, so that activation does not ask the helper for a status behind the checks.
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify(Object.fromEntries(['cx', 'cx2', 'cx3', 'cur', 'ag'].map((n) => [dirOf(h, n), { name: n, available: false, auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: Date.now() }, fetchedAt: Date.now(), windows: [] }]))));
  await activate(h, 700);
  if (typeof usage.listProviderModels !== 'function') {
    check('usage.listProviderModels exists', false, typeof usage.listProviderModels);
    return finish(h);
  }
  const modelOf = (name) => registry.readRegistry().workers.find((w) => w.name === name)?.model;
  /** The entry as the FILE holds it: what was written, whatever a reader of this build makes of it. */
  const rawEntry = (name) => {
    try {
      return JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8')).workers.find((w) => w.name === name);
    } catch {
      return undefined;
    }
  };
  const SUGGESTED = [...providers.providerInfo('codex').suggestedModels];
  const CLI = 'Let the CLI choose';
  const OTHER = 'Enter another model id…';
  const LIVE = { models: [{ id: 'gpt-9-live-a', label: 'GPT 9 A' }, { id: 'gpt-9-live-b' }], source: 'live', error: null };
  /** Open the picker of `name`; resolves once it is on screen. `done` settles when the command has ended. */
  const open = async (name) => {
    h.log.messages.length = 0;
    const before = h.log.pickers.length;
    const t0 = Date.now();
    const done = exec(h, 'setWorkerModel', { name });
    await until(() => h.log.pickers.length > before, 3000, 5);
    const qp = h.log.pickers[before];
    return { qp, done, shownMs: Date.now() - t0 };
  };
  const labels = (qp) => qp.items.map((i) => i.label);
  const settled = (qp) => until(() => qp.busy === false, 8000, 20);
  const close = async (o, item) => {
    if (item === undefined) o.qp.hide(); else o.qp._accept(item);
    const r = await o.done;
    await sleep(20);
    return r;
  };

  // --- live, with a helper that takes a moment
  helper.answer(LIVE, { delayMs: 600 });
  let o = await open('cx');
  if (o.qp === undefined) {
    check('"Set Default Model" of a vendor worker shows a picker that can change while it is open (createQuickPick)', false, [h.log.quickPicks.length, brief(h)]);
    return finish(h);
  }
  check('the built-in suggestions are on screen at once — the stored default first, marked — while the CLI is asked', o.shownMs < 400 && same(labels(o.qp), ['gpt-5.5', ...SUGGESTED.filter((m) => m !== 'gpt-5.5'), CLI, OTHER]) && o.qp.items[0].description === 'current', [o.shownMs, labels(o.qp), o.qp.items[0]?.description]);
  check('…and the picker is busy and says it is loading', o.qp.busy === true && o.qp.title === 'Loading models from the `codex` CLI…' && /"cx"/.test(String(o.qp.placeholder)), [o.qp.busy, o.qp.title, o.qp.placeholder]);
  await settled(o.qp);
  check('when the answer arrives the list is the CLI\'s, in its order — by the display name where it gave one, the id beside it; the stored default it does not list stays first, marked, and says so', same(labels(o.qp), ['gpt-5.5', 'GPT 9 A', 'gpt-9-live-b', CLI, OTHER]) && o.qp.items[0].description === 'current' && o.qp.items[0].detail === 'Stored for this worker; the CLI did not list it.' && o.qp.items[1].description === 'gpt-9-live-a' && o.qp.items[1].model === 'gpt-9-live-a', o.qp.items.map((i) => [i.label, i.description, i.detail]));
  check('…the picker is no longer busy and says where the list came from', o.qp.busy === false && o.qp.title === 'Models the `codex` CLI lists for this account', [o.qp.busy, o.qp.title]);
  let r = await close(o, o.qp.items.find((i) => i.model === 'gpt-9-live-a'));
  check('picking a listed model stores it', r.threw === '' && modelOf('cx') === 'gpt-9-live-a' && o.qp.disposed === true, [modelOf('cx'), brief(h)]);

  // --- the cache
  const spawned = helper.modelCalls().length;
  o = await open('cx');
  check('a second open inside ten minutes starts no helper: the list is there at once and nothing is loading', helper.modelCalls().length === spawned && o.qp.busy === false && same(labels(o.qp), ['gpt-9-live-a', 'gpt-9-live-b', CLI, OTHER]) && o.qp.items[0].description === 'current · GPT 9 A' && o.qp.title === 'Models the `codex` CLI lists for this account', [helper.modelCalls().length - spawned, o.qp.busy, labels(o.qp), o.qp.items[0]?.description]);
  r = await close(o, undefined);
  check('dismissed: nothing is stored and nothing is said', modelOf('cx') === 'gpt-9-live-a' && h.log.messages.length === 0, brief(h));
  o = await open('cx2');
  await settled(o.qp);
  check('another account of the same CLI is asked for itself (its own directory)', helper.modelCalls().length === spawned + 1 && helper.modelCalls().pop().args[2] === dirOf(h, 'cx2'), helper.modelCalls().map((c) => c.args));
  check('a stored default the catalog does not list is still offered, first and marked — never dropped', o.qp.items[0].label === 'my-own-model-x' && o.qp.items[0].description === 'current' && o.qp.items[0].model === 'my-own-model-x', o.qp.items[0]);
  r = await close(o, o.qp.items[0]);
  check('…and choosing it keeps it', modelOf('cx2') === 'my-own-model-x', modelOf('cx2'));
  o = await open('cx3');
  await settled(o.qp);
  check('a worker with no default: "Let the CLI choose" is the one marked current', o.qp.items.find((i) => i.label === CLI)?.description === 'current' && o.qp.items.filter((i) => /current/.test(String(i.description))).length === 1, o.qp.items.map((i) => [i.label, i.description]));
  await close(o, undefined);

  // --- every way of not getting a list
  const fallback = async (what, mode, wrapTimeout) => {
    usage.resetProviderModelsForTest();
    helper.set(mode);
    const real = usage.listProviderModels;
    if (wrapTimeout) usage.listProviderModels = (opts) => real({ ...opts, timeoutMs: wrapTimeout });
    const lines = h.log.output.length;
    const t0 = Date.now();
    const p = await open('cx');
    const first = { labels: labels(p.qp), busy: p.qp.busy, shownMs: p.shownMs };
    await settled(p.qp);
    const ms = Date.now() - t0;
    usage.listProviderModels = real;
    const ok = first.busy === true && first.shownMs < 400 && first.labels.length === SUGGESTED.length + 3 && p.qp.busy === false &&
      same(labels(p.qp), ['gpt-9-live-a', ...SUGGESTED, CLI, OTHER]) && p.qp.items[0].description === 'current' &&
      p.qp.title === 'The `codex` CLI could not list its models — these are built-in suggestions.' &&
      h.log.output.slice(lines).some((l) => /^\[models\] codex: no model list — /.test(l));
    check(`${what}: the suggestions stay (the stored default first), with one line that says the CLI could not list its models`, ok, { first, after: labels(p.qp), title: p.qp.title, ms, log: h.log.output.slice(lines) });
    await close(p, undefined);
    return ms;
  };
  await fallback('the helper answers with an error', { kind: 'print', text: `${JSON.stringify({ models: [], source: 'live', error: 'not signed in' })}\n`, exit: 0 });
  await fallback('the helper answers an empty list', { kind: 'print', text: `${JSON.stringify({ models: [], source: 'live', error: null })}\n`, exit: 0 });
  await fallback('the helper prints garbage', { kind: 'print', text: 'Usage: provider-cli status <provider> <dir>\n', exit: 2 });
  const bigMs = await fallback('the helper prints 5 MB', { kind: 'big' });
  check('…and the 5 MB case is over long before the 25-second budget', bigMs < 6000, bigMs);
  // The 25-second budget is an option of usage.listProviderModels (`timeoutMs`); the shell passes
  // none. Here the function is wrapped for one call so that the same path runs on a 1 s budget.
  const hangMs = await fallback('the helper hangs (budget set to 1 s for this call)', { kind: 'hang' }, 1000);
  check('…it gives up five seconds past the budget — the helper gets that long to end what it started', hangMs >= 5900 && hangMs < 10000, hangMs);
  // The user does not have to wait for any of it.
  usage.resetProviderModelsForTest();
  helper.set({ kind: 'hang' });
  const real = usage.listProviderModels;
  usage.listProviderModels = (opts) => real({ ...opts, timeoutMs: 1000 });
  o = await open('cx');
  const t0 = Date.now();
  r = await close(o, o.qp.items.find((i) => i.label === 'gpt-5.6-sol'));
  check('a suggestion can be picked WHILE the CLI is still being asked: stored at once', Date.now() - t0 < 500 && modelOf('cx') === 'gpt-5.6-sol' && o.qp.busy === true, [Date.now() - t0, modelOf('cx')]);
  await sleep(6600);
  usage.listProviderModels = real;
  check('…and the late answer touches nothing of a picker that is gone', o.qp.timeline.length === 1 && h.log.rejections.length === 0, o.qp.timeline.length);

  usage.resetProviderModelsForTest();
  helper.answer({ models: [{ id: 'gpt-8-static' }], source: 'static', error: null });
  o = await open('cx');
  await settled(o.qp);
  check('the adapter\'s built-in catalog: listed, and said to be that — the CLI was not asked', same(labels(o.qp), ['gpt-5.6-sol', 'gpt-8-static', CLI, OTHER]) && o.qp.title === 'Models known for the `codex` CLI — its built-in list, the CLI was not asked', [labels(o.qp), o.qp.title]);
  // "Enter another model id…" and "Let the CLI choose" still work from this picker.
  h.answers.inputBox = () => 'gpt-typed-1';
  r = await close(o, o.qp.items.find((i) => i.label === OTHER));
  check('"Enter another model id…" still asks for an id and stores it', modelOf('cx') === 'gpt-typed-1', [modelOf('cx'), brief(h)]);
  o = await open('cx');
  r = await close(o, o.qp.items.find((i) => i.label === CLI));
  check('"Let the CLI choose" still stores no default', !modelOf('cx'), [modelOf('cx'), brief(h)]);
  h.answers.inputBox = () => undefined;

  // --- another vendor's models that the CLI resells
  const SEP = "Other vendors' models offered by Cursor";
  const BILLED = "Billed through this Cursor account — not through that vendor's own account.";
  usage.resetProviderModelsForTest();
  helper.answer({
    models: [
      { id: 'claude-sonnet-5-high', label: 'Sonnet', resold: true },
      { id: 'auto' },
      { id: 'claude-opus-5-5-high', label: 'Opus ‮high\u0007', resold: true },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'gpt-5.3-codex', resold: true },
      { id: 'grok-4.7-high', resold: 'yes' },
      { id: 'gemini-3.7-flash-high', resold: 1 },
    ],
    source: 'live',
    error: null,
  });
  o = await open('cur');
  await settled(o.qp);
  check('own + resold: the stored value first; the CLI\'s OWN models in its order; "Let the CLI choose"; a heading; the resold ones; "Enter another model id…" last', same(labels(o.qp), ['claude-opus-5-5-high', 'auto', 'composer-2.5', 'grok-4.7-high', 'gemini-3.7-flash-high', CLI, SEP, 'claude-sonnet-5-high', 'gpt-5.3-codex', OTHER]), labels(o.qp));
  const sep = o.qp.items.find((i) => i.label === SEP) ?? {};
  check('the heading is a separator, not a choice', sep.kind === h.vscode.QuickPickItemKind.Separator && sep.model === undefined, sep);
  check('every resold model says whose account pays', ['claude-sonnet-5-high', 'gpt-5.3-codex'].every((id) => o.qp.items.find((i) => i.label === id)?.detail === BILLED) && ['auto', 'composer-2.5'].every((id) => o.qp.items.find((i) => i.label === id)?.detail === undefined), o.qp.items.map((i) => [i.label, i.detail]));
  check('a stored current value that is a resold id: first, marked, saying whose account pays, and not repeated under the heading', o.qp.items[0].label === 'claude-opus-5-5-high' && /^current · Opus/.test(o.qp.items[0].description) && o.qp.items[0].detail === BILLED && labels(o.qp).filter((l) => l === 'claude-opus-5-5-high').length === 1, o.qp.items[0]);
  check('a `resold` that is not a boolean ("yes", 1) is not taken as true: those models are listed as the CLI\'s own', labels(o.qp).indexOf('grok-4.7-high') < labels(o.qp).indexOf(SEP) && labels(o.qp).indexOf('gemini-3.7-flash-high') < labels(o.qp).indexOf(SEP), labels(o.qp));
  check('a label is shown display-safe (no bidi override, no control character)', !/[\u0000-\u001f‮]/.test(o.qp.items.map((i) => `${i.description ?? ''}${i.detail ?? ''}`).join('')), o.qp.items.map((i) => i.description));
  r = await close(o, o.qp.items.find((i) => i.label === 'gpt-5.3-codex'));
  check('a resold model can be chosen', modelOf('cur') === 'gpt-5.3-codex', modelOf('cur'));
  o = await open('cur');
  check('…and is then the current value, first, with the same sentence (from memory, nothing asked)', o.qp.items[0].label === 'gpt-5.3-codex' && o.qp.items[0].description === 'current' && o.qp.items[0].detail === BILLED && o.qp.busy === false, o.qp.items[0]);
  await close(o, undefined);
  usage.resetProviderModelsForTest();
  helper.answer({ models: [{ id: 'auto' }, { id: 'composer-2.5' }], source: 'live', error: null });
  o = await open('cur');
  await settled(o.qp);
  check('only own entries: no heading; the stored resold id the CLI does not list stays first and says it was not listed', same(labels(o.qp), ['gpt-5.3-codex', 'auto', 'composer-2.5', CLI, OTHER]) && !o.qp.items.some((i) => i.kind === h.vscode.QuickPickItemKind.Separator) && o.qp.items[0].detail === 'Stored for this worker; the CLI did not list it.', o.qp.items.map((i) => [i.label, i.detail]));
  await close(o, undefined);
  usage.resetProviderModelsForTest();
  helper.set({ kind: 'print', text: 'nope\n', exit: 1 });
  o = await open('cur');
  await settled(o.qp);
  check('no list at all: a stored id of another vendor\'s family still says whose account pays', o.qp.items[0].label === 'gpt-5.3-codex' && o.qp.items[0].detail === BILLED && !o.qp.items.some((i) => i.kind === h.vscode.QuickPickItemKind.Separator), o.qp.items.map((i) => [i.label, i.detail]));
  // Under Cursor everything but `auto`, `composer*` and `cursor-*` is another vendor's, whatever
  // its family; under the other CLIs an id of an unknown family is their own.
  h.answers.inputBox = () => 'kimi-k2';
  await close(o, o.qp.items.find((i) => i.label === OTHER));
  h.answers.inputBox = () => undefined;
  o = await open('cur');
  check('a stored id of an UNKNOWN family under Cursor (kimi-k2) is resold: it says whose account pays', modelOf('cur') === 'kimi-k2' && o.qp.items[0].label === 'kimi-k2' && o.qp.items[0].description === 'current' && o.qp.items[0].detail === BILLED, [modelOf('cur'), o.qp.items[0]]);
  await close(o, undefined);
  o = await open('ag');
  await settled(o.qp);
  check('the same id under Antigravity is its own: no such sentence', o.qp.items[0].label === 'kimi-k2' && o.qp.items[0].description === 'current' && o.qp.items[0].detail === undefined && providers.isOwnModelFamily('gemini', 'kimi-k2') === true && providers.isOwnModelFamily('cursor', 'kimi-k2') === false && providers.isOwnModelFamily('cursor', 'composer-3') === true, [o.qp.items[0], providers.isOwnModelFamily('gemini', 'kimi-k2'), providers.isOwnModelFamily('cursor', 'kimi-k2')]);
  await close(o, undefined);

  // --- a listing the size of a real one: 17 own + 242 resold
  const listing = cursorCatalog();
  usage.resetProviderModelsForTest();
  helper.answer(listing.catalog);
  o = await open('cur');
  await settled(o.qp);
  check('259 models (17 own, 242 resold): ALL are listed — the stored value, the 17 own in the CLI\'s order, "Let the CLI choose", the heading, the 242 resold in the CLI\'s order, "Enter another model id…"', same(labels(o.qp), ['kimi-k2', ...listing.own, CLI, "Other vendors' models offered by Cursor", ...listing.resold, OTHER]) && o.qp.items.length === 263, [o.qp.items.length, labels(o.qp).slice(0, 22)]);
  check('…what is typed is matched against the description and the detail too, so "opus" finds the Claude rows by their name', o.qp.matchOnDescription === true && o.qp.matchOnDetail === true && o.qp.items.filter((i) => /opus/i.test(`${i.label} ${i.description ?? ''}`)).length >= 60 && o.qp.items.find((i) => i.label === 'auto')?.description === 'Auto (default)' && o.qp.items.find((i) => i.label === 'gemini-3.3-flash-high')?.description === 'Gemini 3.8 Flash (High)', [o.qp.matchOnDescription, o.qp.matchOnDetail, o.qp.items.find((i) => i.label === 'auto')]);
  check('…and every one of the 242 says whose account pays, while none of the 17 does', listing.resold.every((id) => o.qp.items.find((i) => i.label === id)?.detail === BILLED) && listing.own.every((id) => o.qp.items.find((i) => i.label === id)?.detail === undefined), 'details');
  r = await close(o, o.qp.items.find((i) => i.label === 'composer-3'));
  check('…one of them can be picked', modelOf('cur') === 'composer-3', modelOf('cur'));

  // --- a display name is a CLI's own text, and a quick pick draws `$(name)` as an icon
  usage.resetProviderModelsForTest();
  helper.answer({ models: [{ id: 'auto', label: '$(error) Auto $(sync~spin)' }, { id: 'composer-2', label: '$(check) current' }, { id: 'composer-4', label: '$('.repeat(80) }, { id: 'claude-x-high', label: '$(zap)$(', resold: true }], source: 'live', error: null });
  o = await open('cur');
  await settled(o.qp);
  const shownTexts = o.qp.items.flatMap((i) => [i.label, i.description, i.detail]).filter((t) => typeof t === 'string');
  check('no label, description or detail of the picker holds "$(": a display name such as "$(error) Auto $(sync~spin)" is inert text', shownTexts.every((t) => !t.includes('$(')) && o.qp.items.find((i) => i.label === 'auto')?.description === '$ (error) Auto $ (sync~spin)' && o.qp.items.find((i) => i.label === 'composer-2')?.description === '$ (check) current', o.qp.items.map((i) => [i.label, i.description]));
  check('…and 80 × "$(" is still at most 80 characters', (o.qp.items.find((i) => i.label === 'composer-4')?.description ?? '').length <= 80 && (o.qp.items.find((i) => i.label === 'composer-4')?.description ?? '').length >= 70, o.qp.items.find((i) => i.label === 'composer-4')?.description);
  await close(o, undefined);

  // --- a worker that is being added: no CLI is started in a home that is still being set up
  usage.resetProviderModelsForTest();
  helper.answer(LIVE);
  const n0 = helper.modelCalls().length;
  const p0 = h.log.pickers.length;
  h.answers.inputBox = () => 'cxnew';
  h.answers.quickPick = (list) => list.find((i) => i.info && i.info.id === 'codex') ?? list.find((i) => i.login === 'separate') ?? list.find((i) => i.store === 'file');
  const adding = exec(h, 'addWorker');
  await until(() => h.log.pickers.length > p0, 3000, 10);
  const addPick = h.log.pickers[p0];
  check('Add Worker (another vendor): the suggestions, nothing loading, and no helper run', addPick !== undefined && addPick.busy === false && same(labels(addPick), [...SUGGESTED, CLI, OTHER]) && helper.modelCalls().length === n0, addPick && [addPick.busy, labels(addPick), helper.modelCalls().length - n0]);
  if (addPick) addPick.hide();
  await adding;
  h.answers.quickPick = () => undefined;
  h.answers.inputBox = () => undefined;

  // --- an answer that arrives after the window is gone never throws
  usage.resetProviderModelsForTest();
  helper.answer({ models: [], source: 'live', error: 'not signed in' }, { delayMs: 900 });
  o = await open('cx');
  o.qp.hide();
  await o.done;
  const rejectionsBefore = h.log.rejections.length;
  h.channelThrows = true; // from here on the output channel is a disposed one: every appendLine throws
  await sleep(1700);
  h.channelThrows = false;
  check('a listing that ends after its picker is gone, into an output channel that throws: no unhandled rejection, no uncaught exception', h.log.rejections.length === rejectionsBefore, h.log.rejections.slice(rejectionsBefore, rejectionsBefore + 2));

  // --- a host whose API has no createQuickPick
  delete h.vscode.window.createQuickPick;
  usage.resetProviderModelsForTest();
  const n1 = helper.modelCalls().length;
  h.log.quickPicks.length = 0;
  h.answers.quickPick = (list) => list.find((i) => i.label === SUGGESTED[1]);
  r = await exec(h, 'setWorkerModel', { name: 'cx' });
  check('without createQuickPick: one showQuickPick with the suggestions, no helper run, and the pick is stored', r.threw === '' && h.log.quickPicks.length === 1 && same(h.log.quickPicks[0].items.map((i) => i.label), [...SUGGESTED, CLI, OTHER]) && helper.modelCalls().length === n1 && modelOf('cx') === SUGGESTED[1], [h.log.quickPicks.map((q) => q.items.map((i) => i.label)), modelOf('cx')]);
  finish(h);
}

/* ========================================================================= *
 * V1 — the Workers tree, the task hovers, the Errors row
 * ========================================================================= */

async function v1Views() {
  const h = boot({});
  const registry = h.req('registry.js');
  const views = h.req('views.js');
  const wm = h.req('workerManager.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'sonnet' }], [{ name: 'cx', provider: 'codex' }, { name: 'cx2', provider: 'codex', model: 'gpt-5.5' }, { name: 'cx3', provider: 'codex' }]);
  const cwd = { cwd: h.ws };
  const ran = doneTask('w1', 'opus', 'worker', 'claude-opus-5-5', cwd);
  const named = doneTask('w1', 'sonnet', 'dispatch', undefined, cwd);
  const cli = doneTask('cx', 'default', 'cli', 'gpt-5.6-sol', { ...cwd, provider: 'codex' });
  // A run that NAMED a model on a vendor worker reports none (the adapter only echoes the request).
  const vendorNamed = doneTask('cx2', 'gpt-5.5', 'worker', undefined, { ...cwd, provider: 'codex' });
  const equal = doneTask('w1', 'claude-opus-5-5', 'dispatch', 'claude-opus-5-5', cwd);
  const old = doneTask('w1', 'opus', undefined, undefined, cwd);
  const session = doneTask('w1', 'opus', 'worker', undefined, { ...cwd, meshWorker: 'bg-1' });
  const noModelId = taskId();
  const noModel = { id: noModelId, events: [ev(noModelId, 'running', 'w1', 'haiku', { ...cwd, modelSource: 'worker' }), ev(noModelId, 'error', 'w1', '-', { ...cwd, modelSource: 'worker', error: 'boom' })] };
  appendLog(h, [ran, named, cli, vendorNamed, equal, old, session, noModel].flatMap((t) => t.events));
  const LAST_ERROR = 'worker reported failure: 3 tests failed in services/orders/test_checkout.py';
  fs.writeFileSync(registry.STATS_FILE, JSON.stringify({ w1: { tasks: 5, inputTokens: 10, outputTokens: 5, costUsd: 0, errors: 1, lastError: LAST_ERROR }, w2: { tasks: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, errors: 2, lastError: 'short one' } }));

  const wp = new views.WorkersProvider(new wm.WorkerManager());
  const roots = Object.fromEntries(wp.getChildren().map((n) => [n.name, n]));
  const rows = (name) => wp.getChildren(roots[name]).map((n) => wp.getTreeItem(n));
  const rowOf = (name, label) => rows(name).find((r) => r.label === label) ?? {};
  check('an account whose default has run: its "Default model" row says "<alias> · last ran <id>"', rowOf('w1', 'Default model').description === 'opus · last ran claude-opus-5-5', rowOf('w1', 'Default model').description);
  check('…one whose default has not: the alias alone — nothing is guessed', rowOf('w2', 'Default model').description === 'sonnet', rowOf('w2', 'Default model').description);
  check('…a worker with no default: "CLI default · last ran <id>" once a task that left the model to the CLI reported one; "CLI default" alone before', rowOf('cx', 'Default model').description === 'CLI default · last ran gpt-5.6-sol' && rowOf('cx3', 'Default model').description === 'CLI default', [rowOf('cx', 'Default model').description, rowOf('cx3', 'Default model').description]);
  check('…a vendor worker WITH a default whose runs reported nothing: the default alone, no placeholder', rowOf('cx2', 'Default model').description === 'gpt-5.5', rowOf('cx2', 'Default model').description);
  check('the row comes right after Status, and its hover says what an alias is and where "last ran" comes from', rows('w1')[0].label === 'Status' && rows('w1')[1].label === 'Default model' && /resolved by the `claude` CLI/.test(rowOf('w1', 'Default model').tooltip) && /ran claude-opus-5-5 — the id its CLI reported/.test(rowOf('w1', 'Default model').tooltip) && /No finished task of this account has reported/.test(rowOf('w2', 'Default model').tooltip), [rows('w1').map((r) => r.label), rowOf('w1', 'Default model').tooltip, rowOf('w2', 'Default model').tooltip]);
  const ids = rows('w1').map((r) => r.id);
  check('every detail row keeps a tree id of its own', new Set(ids).size === ids.length, ids);
  const item1 = wp.getTreeItem(roots.w1);
  const item2 = wp.getTreeItem(roots.w2);
  check('the account row itself reads as before (provider, alias, …)', String(item1.description).startsWith('Claude Code · opus') && String(item2.description).startsWith('Claude Code · sonnet') && String(wp.getTreeItem(roots.cx).description).startsWith('Codex · CLI default model'), [item1.description, item2.description, wp.getTreeItem(roots.cx).description]);
  check('…and its hover adds the line only when it is known', /Default model opus — last ran claude-opus-5-5/.test(shown(item1.tooltip)) && !/last ran/.test(shown(item2.tooltip)) && /No default model \(the CLI chooses\) — last ran gpt-5.6-sol/.test(shown(wp.getTreeItem(roots.cx).tooltip)), [shown(item1.tooltip).slice(0, 200), shown(item2.tooltip).slice(0, 120)]);

  // The Errors row.
  const errors = rowOf('w1', 'Errors');
  check('the Errors row: a cut ends with "…", the count stays in front, and the hover keeps the whole text', errors.description === '1 · last: worker reported failure: 3 tests failed in services/orders/…' && errors.tooltip === LAST_ERROR, [errors.description, errors.tooltip]);
  check('…a text that fits is left as it is', rowOf('w2', 'Errors').description === '2 · last: short one', rowOf('w2', 'Errors').description);
  guarded('rowTextCut: the cases', () => {
    const cut = views.rowTextCut;
    const words = Array.from({ length: 11 }, (_, i) => String.fromCharCode(97 + i).repeat(4)).join(' '); // 54 chars
    const midWord = `${words} llllmmmmnnnnoooo pppp`;
    const atBoundary = `${'a'.repeat(29)} ${'b'.repeat(29)} cccc dddd`;
    const noSpace = 'x'.repeat(100);
    const emoji = `${'a'.repeat(58)}\u{1F600} tail of the text`;
    const emojiWords = `${'word '.repeat(10)}aaaaaaa\u{1F600}\u{1F600} tail`;
    const exactly = 'y'.repeat(60);
    const got = {
      midWord: cut(midWord, 60), atBoundary: cut(atBoundary, 60), noSpace: cut(noSpace, 60), short: cut('all of it', 60), exactly: cut(exactly, 60),
      emoji: cut(emoji, 60), emojiWords: cut(emojiWords, 60), farSpace: cut(`aaaa ${'b'.repeat(80)}`, 60), none: [cut('', 60), cut(undefined, 60), cut(42, 60), cut({}, 60)],
      hostile: cut(`bad‮\u0007 text\nsecond line ${'z'.repeat(80)}`, 60), huge: cut('q'.repeat(5_000_000), 60),
      blank: [cut(' '.repeat(5000), 60), cut('\u200b'.repeat(6000), 60), cut(`${' \n\t'.repeat(3000)}`, 60), cut(`${' '.repeat(5000)}tail`, 60), cut('   ', 60)],
      blankPlain: [views.rowText(' '.repeat(5000), 60), views.rowText('\u200b'.repeat(6000), 60), views.rowText(`${' \n\t'.repeat(3000)}`, 60), views.rowText(`${' '.repeat(5000)}tail`, 60), views.rowText('   ', 60)],
    };
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const ok =
      got.midWord === `${words}…` && // the space is inside the last 12 before the limit: the half word goes
      got.atBoundary === `${'a'.repeat(29)} ${'b'.repeat(29)}…` && // the limit falls between two words: the whole word stays
      got.noSpace === `${'x'.repeat(59)}…` &&
      got.short === 'all of it' && got.exactly === exactly &&
      got.emoji === `${'a'.repeat(58)}…` && !loneSurrogate.test(got.emoji) && !loneSurrogate.test(got.emojiWords) && got.emojiWords.endsWith('…') &&
      got.farSpace === `aaaa ${'b'.repeat(54)}…` && // the only space is far from the limit: a hard cut
      same(got.none, ['-', '-', '-', '-']) &&
      !/[\u0000-\u001f‮]/.test(got.hostile) && got.hostile.endsWith('…') && got.huge === `${'q'.repeat(59)}…` &&
      // a value with no visible text is "-" however long it is — what rowText says of it
      same(got.blank, got.blankPlain) && got.blank.every((v) => v === '-') &&
      Object.values(got).flat().every((v) => v.length <= 60);
    return [ok, got];
  });

  // The frontier guard, on the row that shows the default.
  writeRegistry(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'sonnet' }, { name: 'wf', model: 'fable' }], [{ name: 'cx', provider: 'codex' }, { name: 'cx2', provider: 'codex', model: 'gpt-5.5' }, { name: 'cx3', provider: 'codex' }]);
  const rootsF = Object.fromEntries(wp.getChildren().map((n) => [n.name, n]));
  const tipOf = (name) => wp.getChildren(rootsF[name]).map((n) => wp.getTreeItem(n)).find((r) => r.label === 'Default model')?.tooltip ?? '';
  const GUARD = 'The frontier guard blocks this tier: while it does, dispatches that name no model skip this account.';
  check('an account whose default is fable, while the frontier guard blocks the tier: its "Default model" row says that dispatches naming no model skip it — and no other account\'s row does', tipOf('wf').endsWith(GUARD) && !tipOf('w1').includes('frontier') && !tipOf('cx2').includes('frontier'), [tipOf('wf'), tipOf('w1')]);
  {
    const file = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8'));
    file.frontierWorkerDispatch = 'allow';
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(file, null, 2));
    const at = new Date(Date.now() + 90_000);
    fs.utimesSync(registry.REGISTRY_FILE, at, at);
  }
  const rootsA = Object.fromEntries(wp.getChildren().map((n) => [n.name, n]));
  const tipAllowed = wp.getChildren(rootsA.wf).map((n) => wp.getTreeItem(n)).find((r) => r.label === 'Default model')?.tooltip ?? '';
  check('…and not once the guard allows the tier', tipAllowed !== '' && !tipAllowed.includes('frontier'), tipAllowed);

  // Text that is not ours, where the editor draws `$(name)` as an icon.
  guarded('pickText / noIcons: "$(" is inert ("$ ("), the line is display-safe, and the bound holds after the change', () => {
    const got = {
      spin: views.pickText('$(sync~spin)$(', 80), mark: views.pickText('$(check) current', 80), many: views.pickText('$('.repeat(80), 80),
      hidden: views.pickText('a$\u200b(b) $\u202e(c)', 40), cutAtDollar: views.pickText(`${'x'.repeat(79)}$(`, 80), none: [views.pickText('', 9), views.pickText(undefined, 9), views.pickText(7, 9), views.pickText('  \n ', 9)],
      plain: views.pickText('gpt-5.6 (preview)', 80), no: views.noIcons('$(a)$$(b) $ (c) $'),
    };
    const ok = got.spin === '$ (sync~spin)$ (' && got.mark === '$ (check) current' && got.many.length <= 80 && !got.many.includes('$(') && !got.hidden.includes('$(') && !got.cutAtDollar.includes('$(') && got.cutAtDollar.length <= 80 &&
      same(got.none, ['-', '-', '-', '-']) && got.plain === 'gpt-5.6 (preview)' && got.no === '$ (a)$$ (b) $ (c) $';
    return [ok, got];
  });

  // Task hovers.
  const tp = new views.TasksProvider();
  tp.scopeToWorkspace = false;
  const nodes = tp.getChildren();
  const hover = (t) => {
    const node = nodes.find((n) => n.id === t.id);
    if (!node) return '(no row)';
    return shown(tp.resolveTreeItem(tp.getTreeItem(node), node).tooltip);
  };
  check('hover, model from the worker default and a reported model: "Model opus → claude-opus-5-5 · Account w1" and the source in words', /Model opus → claude-opus-5-5 · Account w1/.test(hover(ran)) && /Model source: worker default/.test(hover(ran)), hover(ran).slice(0, 260));
  check('hover, named by the dispatch, nothing reported: the requested model alone, no arrow', /Model sonnet · Account w1/.test(hover(named)) && !/→/.test(hover(named)) && /Model source: named by the dispatch/.test(hover(named)), hover(named).slice(0, 260));
  check('hover, CLI default on another vendor\'s worker', /Model default → gpt-5\.6-sol · Account cx/.test(hover(cli)) && /Model source: CLI default/.test(hover(cli)), hover(cli).slice(0, 260));
  check('hover, the reported model is the requested text: said once', /Model claude-opus-5-5 · Account w1/.test(hover(equal)) && !/→/.test(hover(equal)), hover(equal).slice(0, 200));
  check('hover of an entry of an earlier version: the line as it always was, and no source line', /Model opus · Account w1/.test(hover(old)) && !/Model source/.test(hover(old)) && !/→/.test(hover(old)), hover(old).slice(0, 200));
  check('a failed dispatch recorded with model "-" and the source "worker default": the hover never says that "-" was asked for — the source line stands alone', /Model source: worker default/.test(hover(noModel)) && !/[Aa]sked for/.test(hover(noModel)) && !/→/.test(hover(noModel)), hover(noModel).slice(0, 240));
  const row = tp.getTreeItem(nodes.find((n) => n.id === ran.id));
  check('the task row itself is unchanged (account · model · status)', row.description === 'w1 · opus · done' && row.tooltip === undefined, [row.description, row.tooltip]);
  const hp = new (h.req('history-view.js').WorkerHistoryProvider)();
  const hnodes = hp.getChildren();
  const hnode = hnodes.find((n) => n.id === session.id);
  const htip = hnode ? shown(hp.resolveTreeItem(hp.getTreeItem(hnode), hnode).tooltip) : '(no row)';
  check('the Worker History hover says the same two lines (a session worker reports no model: no arrow)', /Model opus · Account w1/.test(htip) && /Model source: worker default/.test(htip) && !/→/.test(htip), htip.slice(0, 240));
  wp.dispose(); tp.dispose(); hp.dispose();
  finish(h);
}

/* ========================================================================= *
 * C1 — "Add Dispatch Policy" / "Update Dispatch Policy"
 * ========================================================================= */

async function c1PolicyCommand() {
  const h = boot({});
  const prompts = h.req('prompts.js');
  await activate(h, 500);
  const file = path.join(h.ws, 'CLAUDE.md');
  const BLOCK = prompts.DISPATCH_POLICY_MD;
  const OLD = BLOCK.replace('## Language', '## Language (as an earlier version wrote it)');
  const state = (f = file) => (typeof prompts.policyState === 'function' ? prompts.policyState(fs.readFileSync(f, 'utf8')) : '(no policyState)');
  const bytes = (f = file) => fs.readFileSync(f).toString('base64');
  // Wave 11b (contract §15.12 M2): after a write, the installer ALSO offers "Allow cco" — once git
  // has answered where the folder's local settings live, so it can land after the write's own
  // sentence, even in the NEXT run's window. That offer is kept apart (`offers`) from what the
  // command itself said (`plain`); each run first waits for the previous run's offer to settle.
  const OFFER = /^Let the Claude session run cco without permission prompts in this folder\?$/;
  const run = async (answer) => {
    await sleep(400);
    h.log.messages.length = 0;
    h.answers.message = answer ?? (() => undefined);
    const r = await exec(h, 'addDispatchPolicy');
    await sleep(30);
    h.answers.message = () => undefined;
    const isOffer = (m) => OFFER.test(String(m.message));
    return {
      threw: r.threw,
      modals: h.log.messages.filter((m) => m.modal),
      plain: h.log.messages.filter((m) => !m.modal && !isOffer(m)),
      offers: h.log.messages.filter((m) => !m.modal && isOffer(m)),
    };
  };
  const said = (r, re) => r.plain.filter((m) => re.test(String(m.message)));
  const confirm = (rec) => (rec.modal ? 'Replace' : undefined);

  // absent
  let r = await run();
  check('no CLAUDE.md: written, no question, and the sentence says "written"', r.threw === '' && r.modals.length === 0 && state() === 'current' && said(r, /^Dispatch policy written to CLAUDE\.md\.$/).length === 1, [state(), brief(h)]);
  // current
  let before = bytes();
  const mtime = fs.statSync(file).mtimeMs;
  r = await run(confirm);
  check('a block that is this version\'s: "already current", no question, and the file is not written at all', r.modals.length === 0 && said(r, /already current/).length === 1 && said(r, /^Dispatch policy written/).length === 0 && bytes() === before && fs.statSync(file).mtimeMs === mtime, [brief(h), fs.statSync(file).mtimeMs === mtime]);
  fs.writeFileSync(file, `# top\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}\r\n\r\ntail\r\n`);
  before = bytes();
  r = await run(confirm);
  check('…the same with CRLF line endings: current, byte-identical afterwards', r.modals.length === 0 && said(r, /already current/).length === 1 && bytes() === before, brief(h));
  // no block, other text
  fs.writeFileSync(file, '# mine\n\nrules\n');
  r = await run();
  check('a file with no block: the block is added after its text, no question', r.modals.length === 0 && fs.readFileSync(file, 'utf8').startsWith('# mine\n\nrules\n') && state() === 'current' && said(r, /^Dispatch policy written to CLAUDE\.md\.$/).length === 1, [fs.readFileSync(file, 'utf8').slice(0, 30), brief(h)]);

  // differs
  const DIFFERS = `# head\n\n${OLD}\n\n## after\ntext after\n`;
  fs.writeFileSync(file, DIFFERS);
  before = bytes();
  r = await run(() => undefined);
  const modal = r.modals[0];
  check('a block that differs: ONE modal, before anything is written', r.threw === '' && r.modals.length === 1 && bytes() === before, brief(h));
  check('…it names the file, says the block is from another version or was edited, that replacing discards the differences, and that only the text between the markers is replaced', modal && String(modal.message) === "The dispatch policy in CLAUDE.md is from another version of the extension or was edited. Replacing it discards those differences. Only the text between the policy's markers is replaced; the rest of the file is left as it is.", modal && modal.message);
  check('…its one action is "Replace" (Cancel is the dialog\'s own, and the default)', modal && same(modal.items, ['Replace']), modal && modal.items);
  check('dismissed: byte-identical, and nothing else is said', bytes() === before && r.plain.length === 0 && state() === 'differs', brief(h));
  r = await run((rec) => (rec.modal ? 'Cancel' : undefined));
  check('an answer that is not "Replace": byte-identical', bytes() === before && r.plain.length === 0, brief(h));
  r = await run(confirm);
  check('confirmed: the block is replaced in place — the text before and after it is kept, byte for byte', fs.readFileSync(file, 'utf8') === `# head\n\n${BLOCK}\n\n## after\ntext after\n` && state() === 'current', fs.readFileSync(file, 'utf8').slice(0, 60));
  check('…and the sentence says a block was replaced', said(r, /^Dispatch policy written to CLAUDE\.md — the policy block that was there was replaced\.$/).length === 1 && r.modals.length === 1, brief(h));
  // an edited block of THIS version is the same case
  fs.writeFileSync(file, `${BLOCK.replace('## Parallelism', '## Parallelism (my note)')}\n`);
  before = bytes();
  r = await run(() => undefined);
  check('an EDITED block of this version is asked about in the same way, and kept when the answer is no', r.modals.length === 1 && bytes() === before, brief(h));

  // two blocks, and a marker with no block: both read "differs", and both are asked about
  const START = BLOCK.split('\n')[0];
  const END = BLOCK.split('\n').pop();
  const TWO = `# head\n\n${OLD}\n\ntext between the two blocks\n\n${BLOCK}\n\ntail\n`;
  fs.writeFileSync(file, TWO);
  before = bytes();
  r = await run(() => undefined);
  check('a file with TWO blocks reads "differs": asked, and byte-identical on "no"', state() === 'differs' && r.modals.length === 1 && r.plain.length === 0 && bytes() === before, [state(), brief(h)]);
  r = await run(confirm);
  let text = fs.readFileSync(file, 'utf8');
  check('…on "Replace": ONE block (this version\'s), and the text between the two is still there, as is the text around them', state() === 'current' && text.split(START).length === 2 && text.split(END).length === 2 && text.includes(BLOCK) && text.startsWith('# head\n\n') && text.includes('\n\ntext between the two blocks\n\n') && text.endsWith('tail\n'), text.replace(BLOCK, '<BLOCK>'));
  const LONE = `# head\n\n${START}\nwhat the user wrote after a marker that opens nothing\n\nmore of their text\n`;
  fs.writeFileSync(file, LONE);
  before = bytes();
  r = await run(() => undefined);
  check('a lone start marker followed by the user\'s own text reads "differs": asked, and byte-identical on "no"', state() === 'differs' && r.modals.length === 1 && r.plain.length === 0 && bytes() === before, [state(), brief(h)]);
  r = await run(confirm);
  text = fs.readFileSync(file, 'utf8');
  check('…on "Replace": the marker that opened nothing is gone (its line alone), every line the user wrote is still there in order, one block was added, and the file reads "current"', state() === 'current' && text.startsWith('# head\n\nwhat the user wrote after a marker that opens nothing\n\nmore of their text\n') && text.split(START).length === 2 && text.split(END).length === 2 && text.includes(BLOCK) && said(r, /^Dispatch policy written/).length === 1, [state(), text.replace(BLOCK, '<BLOCK>')]);
  const mtimeNow = fs.statSync(file).mtimeMs;
  r = await run(confirm);
  check('…and the command run again finds it current and writes nothing', r.modals.length === 0 && said(r, /already current/).length === 1 && fs.statSync(file).mtimeMs === mtimeNow, brief(h));
  const LONE_THEN_BLOCK = `${START}\nthe user\'s own text\n\n${OLD}\n`;
  fs.writeFileSync(file, LONE_THEN_BLOCK);
  before = bytes();
  r = await run(() => undefined);
  const cancelled = bytes() === before;
  r = await run(confirm);
  text = fs.readFileSync(file, 'utf8');
  check('a lone start marker, the user\'s text, then an old block: kept on "no"; on "Replace" the block becomes this version\'s where it stands, the lone marker line goes, and the user\'s text is not deleted', cancelled && state() === 'current' && text === `the user\'s own text\n\n${BLOCK}\n`, text.replace(BLOCK, '<BLOCK>'));

  // a CRLF file keeps its line ending through the update
  fs.writeFileSync(file, `# head\r\n\r\n${OLD.replace(/\n/g, '\r\n')}\r\n\r\ntail\r\n`);
  r = await run(confirm);
  text = fs.readFileSync(file, 'utf8');
  check('a file whose every line break is CRLF: after "Replace" it still is — the block is written in the file\'s line ending', state() === 'current' && !/(^|[^\r])\n/.test(text) && text.startsWith('# head\r\n\r\n') && text.endsWith('\r\ntail\r\n'), JSON.stringify(text.slice(0, 80)));

  // a file that is not valid UTF-8 is never rewritten: decoding it would change the user's own text
  const NOT_UTF8 = [
    ['ISO-8859-1 text, no block', Buffer.from('# Notes du projet\n\nLe caf\xe9 est pr\xeat.\n', 'latin1')],
    ['UTF-16 LE with a byte-order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# \ud504\ub85c\uc81d\ud2b8 \uba54\ubaa8\n\ud55c\uad6d\uc5b4\n', 'utf16le')])],
    ['EUC-KR text around an OLD block', Buffer.concat([Buffer.from('# '), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from(`\n\n${OLD}\n\n`), Buffer.from([0xb3, 0xa1, 0x0a])])],
    ['one stray byte in an otherwise UTF-8 file with this version\'s block', Buffer.concat([Buffer.from(`# ok\n\n${BLOCK}\n\ncaf`), Buffer.from([0xe9, 0x0a])])],
  ];
  for (const [label, body] of NOT_UTF8) {
    fs.writeFileSync(file, body);
    const hexBefore = fs.readFileSync(file).toString('hex');
    const inode = fs.statSync(file).ino;
    r = await run(confirm);
    const refusal = said(r, /is not valid UTF-8 text/)[0];
    check(`${label}: refused — no question, byte-identical, the same file, and a sentence that names it and says nothing was changed`, r.threw === '' && r.modals.length === 0 && fs.readFileSync(file).toString('hex') === hexBefore && fs.statSync(file).ino === inode && refusal !== undefined && String(refusal.message).includes(file) && /Nothing was changed\.$/.test(String(refusal.message)) && said(r, /^Dispatch policy written|already current/).length === 0, [brief(h), fs.readFileSync(file).toString('hex') === hexBefore]);
  }
  // …while valid UTF-8 with a byte-order mark, a NUL and an emoji is read and written as before
  const LOSSLESS = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# with a BOM\n\nnul:\u0000 caf\u00e9 \u{1F600}\n')]);
  fs.writeFileSync(file, LOSSLESS);
  r = await run();
  check('valid UTF-8 with a byte-order mark, a NUL byte and an emoji: the block is added, and every byte that was there is still there, in front of it', r.modals.length === 0 && fs.readFileSync(file).subarray(0, LOSSLESS.length).equals(LOSSLESS) && state() === 'current' && said(r, /^Dispatch policy written to CLAUDE\.md\.$/).length === 1, [brief(h), fs.readFileSync(file).subarray(0, 12).toString('hex')]);

  // a file its owner cannot write is not replaced
  if (process.getuid && process.getuid() === 0) {
    console.log(`SKIP ${CASE}: a read-only CLAUDE.md (running as root)`);
  } else {
    for (const [label, body] of [['no block', '# mine, and read-only\n'], ['a block that differs', DIFFERS]]) {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o444);
      const inode = fs.statSync(file).ino;
      r = await run(confirm);
      const refusal = said(r, /is read-only \(its owner has no write permission\)/)[0];
      check(`a CLAUDE.md without the owner's write bit (0444), ${label}: refused — no question, byte-identical, still the same file and still 0444`, r.modals.length === 0 && fs.readFileSync(file, 'utf8') === body && fs.statSync(file).ino === inode && (fs.statSync(file).mode & 0o777) === 0o444 && refusal !== undefined && String(refusal.message).includes(file) && /Nothing was changed\.$/.test(String(refusal.message)), [brief(h), (fs.statSync(file).mode & 0o777).toString(8)]);
      fs.chmodSync(file, 0o644);
    }
  }

  // the file changes while the question is open
  fs.writeFileSync(file, DIFFERS);
  const theirs = `${DIFFERS}\nsomebody else wrote this line meanwhile\n`;
  r = await run((rec) => {
    if (!rec.modal) return undefined;
    fs.writeFileSync(file, theirs);
    return 'Replace';
  });
  check('the file changed while the dialog was open: nothing is written over it, and that is said', fs.readFileSync(file, 'utf8') === theirs && said(r, /changed while it was being updated/).length === 1 && said(r, /^Dispatch policy written/).length === 0, brief(h));

  // unreadable
  if (process.getuid && process.getuid() === 0) {
    console.log(`SKIP ${CASE}: an unreadable CLAUDE.md (running as root, which reads every file)`);
  } else {
    fs.writeFileSync(file, DIFFERS);
    before = bytes();
    fs.chmodSync(file, 0o200);
    r = await run(confirm);
    fs.chmodSync(file, 0o600);
    check('a CLAUDE.md that cannot be read is refused as before: no question, not rewritten', r.modals.length === 0 && said(r, /could not be read/).length === 1 && bytes() === before, brief(h));
  }
  // symlinks
  fs.rmSync(file);
  const outside = path.join(h.scratch, 'outside.md');
  fs.writeFileSync(outside, DIFFERS);
  fs.symlinkSync(outside, file);
  r = await run(confirm);
  check('a link that leads out of the workspace is refused as before: no question, the target byte-identical', r.modals.length === 0 && said(r, /symbolic link that leads outside/).length === 1 && fs.readFileSync(outside, 'utf8') === DIFFERS && fs.lstatSync(file).isSymbolicLink(), brief(h));
  fs.rmSync(file);
  const inside = path.join(h.ws, 'AGENTS.md');
  fs.writeFileSync(inside, DIFFERS);
  fs.symlinkSync('AGENTS.md', file);
  r = await run(() => undefined);
  check('a link to a file inside the workspace whose block differs: asked, and left alone on "no"', r.modals.length === 1 && fs.readFileSync(inside, 'utf8') === DIFFERS, brief(h));
  r = await run(confirm);
  check('…replaced in the file the link names on "Replace", and the link stays a link', state(inside) === 'current' && fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(inside, 'utf8').endsWith('## after\ntext after\n'), [state(inside), brief(h)]);
  fs.rmSync(file);
  require('child_process').execFileSync('/usr/bin/mkfifo', [file]);
  const t0 = Date.now();
  r = await run(confirm);
  check('a pipe at the name is refused at once, as before', r.modals.length === 0 && Date.now() - t0 < 3000 && fs.lstatSync(file).isFIFO() && said(r, /was not written/).length === 1, [Date.now() - t0, brief(h)]);
  fs.rmSync(file);
  finish(h);
}

/* ========================================================================= *
 * M1 — files this extension rewrites: only from a lossless read, never one
 *      its owner cannot write, and the policy only through its one writer
 * ========================================================================= */

async function m1Rewrites() {
  const h = boot({});
  const prompts = h.req('prompts.js');
  const safeFs = h.req('safeFs.js');
  await activate(h, 500);
  const claudeMd = path.join(h.ws, 'CLAUDE.md');
  const mcp = path.join(h.ws, '.mcp.json');
  const BLOCK = prompts.DISPATCH_POLICY_MD;
  const START = BLOCK.split('\n')[0];
  const END = BLOCK.split('\n').pop();
  const EDITED = `${START}\nMY EDITED POLICY\n${END}`;
  const hex = (f) => fs.readFileSync(f).toString('hex');
  const run = async (command, answer) => {
    h.log.messages.length = 0;
    h.answers.message = answer ?? (() => undefined);
    const r = await exec(h, command);
    await sleep(60);
    h.answers.message = () => undefined;
    return { threw: r.threw, modals: h.log.messages.filter((m) => m.modal), plain: h.log.messages.filter((m) => !m.modal) };
  };
  const said = (r, re) => r.plain.filter((m) => re.test(String(m.message)));
  const root = Boolean(process.getuid && process.getuid() === 0);

  /* ---- safeFs.readTextSafe, strict ---- */
  const probe = path.join(h.scratch, 'probe.txt');
  const LATIN1 = Buffer.from('# Notes du projet\n\nLe caf\xe9 est pr\xeat.\n', 'latin1');
  const UTF16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 프로젝트\n', 'utf16le')]);
  const VALID = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom, nul \u0000, café, \u{1F600}, � itself\n')]);
  const strictOf = (body) => { fs.writeFileSync(probe, body); return [safeFs.readTextSafe(probe, 1 << 20, { strictUtf8: true }), safeFs.readTextSafe(probe, 1 << 20)]; };
  let [strict, plain] = strictOf(LATIN1);
  check('readTextSafe, strict: bytes that are not UTF-8 are `not-utf8`, with a detail — and the read every other caller has is what it was (text, with replacement characters)', strict.ok === false && strict.reason === 'not-utf8' && typeof strict.detail === 'string' && plain.ok === true && plain.text.includes('�') && plain.bytes === LATIN1.length, [strict, plain.ok]);
  [strict, plain] = strictOf(UTF16);
  check('…UTF-16 too', strict.ok === false && strict.reason === 'not-utf8' && plain.ok === true, strict);
  [strict, plain] = strictOf(VALID);
  check('…valid UTF-8 — a byte-order mark, a NUL, an emoji, a literal U+FFFD — is text that encodes back to the same bytes', strict.ok === true && Buffer.from(strict.text, 'utf8').equals(VALID) && plain.ok === true && plain.text === strict.text, strict.ok);
  [strict] = strictOf(Buffer.alloc(0));
  const junkOptions = ['strictUtf8', 1, null, { strictUtf8: 'true' }, { strictUtf8: 1 }].map((o) => { fs.writeFileSync(probe, LATIN1); return safeFs.readTextSafe(probe, 1 << 20, o).ok; });
  check('…an empty file is text; an absent one is still `absent`; and only the literal `true` asks for the strict read', strict.ok === true && strict.text === '' && safeFs.readTextSafe(path.join(h.scratch, 'none'), 9, { strictUtf8: true }).reason === 'absent' && junkOptions.every((ok) => ok === true), junkOptions);

  /* ---- .mcp.json ---- */
  const NOT_UTF8_JSON = Buffer.from('{"mcpServers":{"mine":{"command":"caf\xe9"}},"note":"\xfcber"}', 'latin1');
  fs.writeFileSync(mcp, NOT_UTF8_JSON);
  let before = hex(mcp);
  let r = await run('installMcp');
  let refusal = said(r, /is not valid UTF-8 text/)[0];
  check('.mcp.json in ISO-8859-1: "Register MCP Server" refuses — byte-identical, a sentence that names the file and says nothing was changed, and "Registered" is not said', r.threw === '' && hex(mcp) === before && refusal !== undefined && String(refusal.message).includes(mcp) && /Nothing was changed\.$/.test(String(refusal.message)) && said(r, /^Registered/).length === 0, brief(h));
  fs.writeFileSync(mcp, '{"mcpServers":{"mine":{"command":"café \u{1F600}"}},"note":"über"}');
  r = await run('installMcp');
  let parsed = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  check('…the same file in UTF-8 is registered, and the user\'s own values come back exactly', said(r, /^Registered/).length === 1 && parsed.mcpServers.mine.command === 'café \u{1F600}' && parsed.note === 'über' && Boolean(parsed.mcpServers['cco-dispatch']), brief(h));
  if (root) {
    console.log(`SKIP ${CASE}: read-only files (running as root)`);
  } else {
    fs.writeFileSync(mcp, '{"mcpServers":{}}');
    fs.chmodSync(mcp, 0o444);
    before = hex(mcp);
    const inode = fs.statSync(mcp).ino;
    r = await run('installMcp');
    check('a .mcp.json without the owner\'s write bit: refused, byte-identical, the same file', hex(mcp) === before && fs.statSync(mcp).ino === inode && said(r, /is read-only \(its owner has no write permission\)/).length === 1 && said(r, /^Registered/).length === 0, brief(h));
    fs.chmodSync(mcp, 0o644);
    // The team agent's file: replaced whole after a question — but not when its owner cannot write it.
    const agent = h.req('teamAgent.js');
    const agentFile = path.join(h.ws, ...agent.TEAM_AGENT_FILE.split('/'));
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, agent.TEAM_AGENT_MD.replace(/\n([^\n]*)$/, '\nedited by hand\n$1'));
    const differs = agent.teamAgentState(fs.readFileSync(agentFile, 'utf8')) === 'differs';
    fs.chmodSync(agentFile, 0o444);
    before = hex(agentFile);
    r = await run('installTeamAgent', (rec) => (rec.modal ? 'Replace' : undefined));
    check('a team agent file that differs and is read-only: not replaced, no question, and the message says why', differs && hex(agentFile) === before && r.modals.length === 0 && said(r, /Could not write .*read-only/).length === 1, [differs, brief(h)]);
    fs.chmodSync(agentFile, 0o644);
  }

  /* ---- the offer after "Register MCP Server": the policy's one guarded writer ---- */
  const OFFER = /^Add the dispatch policy to this workspace's CLAUDE\.md\?/;
  /** Run installMcp on a fresh `.mcp.json`; when the offer comes up, do `meanwhile()` and press "Add to CLAUDE.md". */
  const registerThenAdd = async (startText, meanwhile, modalAnswer) => {
    fs.rmSync(mcp, { force: true });
    fs.rmSync(claudeMd, { force: true });
    if (startText !== undefined) fs.writeFileSync(claudeMd, startText);
    let offered = 0;
    const r2 = await run('installMcp', (rec) => {
      if (rec.modal) return modalAnswer;
      if (OFFER.test(String(rec.message))) {
        offered++;
        meanwhile();
        return 'Add to CLAUDE.md';
      }
      return undefined;
    });
    return { ...r2, offered };
  };
  r = await registerThenAdd('# Mine\n', () => {}, 'Replace');
  check('the offer on a CLAUDE.md with no block, answered "Add": the block is added after the user\'s text, with no question', r.offered === 1 && r.modals.length === 0 && fs.readFileSync(claudeMd, 'utf8').startsWith('# Mine\n') && prompts.policyState(fs.readFileSync(claudeMd, 'utf8')) === 'current', [r.offered, brief(h)]);
  const GAINED = `# Mine\n\n${EDITED}\n\nand more\n`;
  r = await registerThenAdd('# Mine\n', () => fs.writeFileSync(claudeMd, GAINED), undefined);
  check('the file gains an EDITED block while the offer is up, then "Add" is pressed: the installer looks again and ASKS (one modal) — and on "no" the file is byte-identical', r.offered === 1 && r.modals.length === 1 && /from another version of the extension or was edited/.test(String(r.modals[0].message)) && fs.readFileSync(claudeMd, 'utf8') === GAINED, [r.offered, brief(h), fs.readFileSync(claudeMd, 'utf8').slice(0, 60)]);
  r = await registerThenAdd('# Mine\n', () => fs.writeFileSync(claudeMd, GAINED), 'Replace');
  check('…and on "Replace" — an answer given AFTER that look — the block is replaced in place and that is said', r.modals.length === 1 && fs.readFileSync(claudeMd, 'utf8') === `# Mine\n\n${BLOCK}\n\nand more\n` && said(r, /the policy block that was there was replaced/).length === 1, [brief(h), fs.readFileSync(claudeMd, 'utf8').replace(BLOCK, '<BLOCK>')]);
  const NOW_CURRENT = `# Mine\n\n${BLOCK}\n`;
  let mtime = 0;
  r = await registerThenAdd('# Mine\n', () => { fs.writeFileSync(claudeMd, NOW_CURRENT); mtime = fs.statSync(claudeMd).mtimeMs; }, 'Replace');
  check('the file gains THIS version\'s block meanwhile: nothing is asked, nothing is written, nothing is said about the policy', r.offered === 1 && r.modals.length === 0 && fs.readFileSync(claudeMd, 'utf8') === NOW_CURRENT && fs.statSync(claudeMd).mtimeMs === mtime && said(r, /[Dd]ispatch policy (written|in CLAUDE)/).length === 0, [brief(h)]);
  r = await registerThenAdd('# Mine\n', () => fs.writeFileSync(claudeMd, LATIN1), 'Replace');
  check('the file becomes one that is not UTF-8 meanwhile: refused with the sentence, byte-identical', r.modals.length === 0 && fs.readFileSync(claudeMd).equals(LATIN1) && said(r, /is not valid UTF-8 text/).length === 1, brief(h));
  const notOffered = [];
  for (const [label, body] of [['a block that differs', GAINED], ['this version\'s block', NOW_CURRENT], ['a file that is not UTF-8', LATIN1]]) {
    r = await registerThenAdd(body, () => {}, 'Replace');
    notOffered.push([label, r.offered, r.modals.length, fs.readFileSync(claudeMd).equals(Buffer.from(body))]);
  }
  check('the offer is made only where the installer would ADD a block: not for a block of any kind, and not for a file it would refuse', notOffered.every((x) => x[1] === 0 && x[2] === 0 && x[3] === true), notOffered);
  r = await registerThenAdd(undefined, () => {}, 'Replace');
  check('…and with no CLAUDE.md at all the offer creates one', r.offered === 1 && prompts.policyState(fs.readFileSync(claudeMd, 'utf8')) === 'current', [r.offered, brief(h)]);
  finish(h);
}

/* ========================================================================= *
 * Q1 — text that is not ours, where the editor draws `$(name)` as an icon
 * ========================================================================= */

async function q1QuickPicks() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const EVIL = '$(error) evil $(sync~spin)$(';
  const evilDir = path.join(h.home, '.acct-$(flame)');
  fs.mkdirSync(evilDir, { recursive: true });
  // A directory whose path is longer than any cut a row of text gets: a path is shown whole.
  const longDir = path.join(h.home, '.acct-' + 'd'.repeat(240));
  fs.mkdirSync(longDir, { recursive: true });
  fs.mkdirSync(dirOf(h, 'w1'), { recursive: true });
  fs.mkdirSync(h.root, { recursive: true });
  // A registry somebody edited by hand: a name and a directory nobody could type into the input boxes.
  fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify({
    workers: [{ name: 'w1', configDir: dirOf(h, 'w1'), model: 'opus' }, { name: EVIL, configDir: evilDir, model: 'sonnet' }, { name: 'long', configDir: longDir, model: 'opus' }],
    vendorWorkers: [],
  }, null, 2));
  // Fresh readings (one of them logged out), so that nothing asks a CLI and the re-login picker has a marked row.
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({
    [path.join(h.home, '.claude')]: { name: 'main', available: true, windows: [], fetchedAt: Date.now() },
    [dirOf(h, 'w1')]: { name: 'w1', available: true, windows: [], fetchedAt: Date.now() },
    [evilDir]: { name: EVIL, configDir: evilDir, available: false, windows: [], fetchedAt: Date.now(), auth: { loggedIn: false, method: null, email: null, checkedAt: Date.now() }, loginProbes: confirmedOut(Date.now()) },
    [longDir]: { name: 'long', available: true, windows: [], fetchedAt: Date.now() },
  }));
  // A config directory to import, named like an icon.
  const importDir = path.join(h.home, '.claude-$(zap)x');
  fs.mkdirSync(path.join(importDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(importDir, '.claude.json'), '{}');
  const importLong = path.join(h.home, '.claude-' + 'l'.repeat(230));
  fs.mkdirSync(path.join(importLong, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(importLong, '.claude.json'), '{}');
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  await activate(h, 900);
  // A running task whose title and account are a worker's own words — written once the sweep of
  // tasks left behind by an earlier session has been through the log.
  const runId = taskId();
  appendLog(h, [ev(runId, 'running', EVIL, 'opus', { title: '$(sync~spin) deploy $(check) current', pid: process.pid, pgid: process.pid, cwd: h.ws })]);

  const texts = (items) => (items ?? []).flatMap((i) => [i.label, i.description, i.detail]).filter((t) => typeof t === 'string');
  const pickOf = async (command, ...args) => {
    let seen;
    h.log.messages.length = 0;
    h.answers.quickPick = (list) => { if (seen === undefined) seen = list; return undefined; };
    const r = await exec(h, command, ...args);
    await sleep(40);
    h.answers.quickPick = () => undefined;
    return { threw: r.threw, items: seen };
  };
  const inert = (items) => Array.isArray(items) && items.length > 0 && texts(items).every((t) => !t.includes('$('));

  let p = await pickOf('setWorkerModel');
  check('the worker picker of the command palette: a worker named "$(error) evil $(sync~spin)$(" is listed as inert text', p.threw === '' && inert(p.items) && p.items.some((i) => i.label === '$ (error) evil $ (sync~spin)$ (' && i.name === EVIL), p.items && p.items.map((i) => [i.label, i.description]));
  p = await pickOf('reloginWorker');
  check('the re-login picker: no name and no directory opens an icon — and the row still carries the account itself', p.threw === '' && inert(p.items) && p.items.some((i) => i.label === '$ (error) evil $ (sync~spin)$ (' && /login expired · .*\.acct-\$ \(flame\)$/.test(String(i.description)) && i.account && i.account.name === EVIL && i.account.configDir === evilDir), p.items && p.items.map((i) => [i.label, i.description]));
  const longRow = (p.items ?? []).find((i) => i.account && i.account.name === 'long');
  check(`the re-login picker: a directory path of ${longDir.length} characters is shown whole`, longRow !== undefined && longRow.description === longDir, longRow && [String(longRow.description).length, String(longRow.description).slice(-24)]);
  p = await pickOf('cancelTask');
  check('the running-task picker: a title "$(sync~spin) deploy $(check) current" and its account are inert text; the task is still named by its id', p.threw === '' && inert(p.items) && p.items.length === 1 && p.items[0].label === '$ (sync~spin) deploy $ (check) current' && p.items[0].description === '$ (error) evil $ (sync~spin)$ (' && p.items[0].id === runId, p.items);
  p = await pickOf('importWorkers');
  const imp = (p.items ?? []).find((i) => i.entry && i.entry.dir === importDir);
  check('the import picker: a directory named ".claude-$(zap)x" is offered as inert text, and the entry still holds the real directory', p.threw === '' && inert(p.items) && imp !== undefined && imp.label === '$ (zap)x' && String(imp.description).endsWith('.claude-$ (zap)x'), p.items && p.items.map((i) => [i.label, i.description]));
  const impLong = (p.items ?? []).find((i) => i.entry && i.entry.dir === importLong);
  check(`the import picker: a directory path of ${importLong.length} characters is shown whole`, impLong !== undefined && impLong.description === importLong, impLong && [String(impLong.description).length, String(impLong.description).slice(-24)]);

  // The Claude model picker of that worker: the labels are ours, the stored value is the registry's.
  p = await pickOf('setWorkerModel', { name: EVIL });
  check('the model picker of that worker: nothing in it opens an icon', p.threw === '' && inert(p.items), p.items && texts(p.items));

  // The status bar draws icons too.
  const team = h.req('team.js');
  const realResolve = team.resolveSession;
  team.resolveSession = (key) => (key === 'k1' ? { key: 'k1', name: '$(bell) bg-$(sync~spin)1', configDir: dirOf(h, 'w1'), source: 'worker', canAttach: false, canStop: false } : undefined);
  h.log.status.length = 0;
  let threw = '';
  try {
    await h.req('teamView.js').runSessionAction('copyName', 'k1', undefined);
  } catch (e) {
    threw = String(e);
  }
  team.resolveSession = realResolve;
  check('"Copy Session Name": the clipboard gets the name as it is, the status bar a text in which no icon opens', threw === '' && h.log.clipboard.pop() === '$(bell) bg-$(sync~spin)1' && h.log.status.length === 1 && !String(h.log.status[0]).includes('$(') && String(h.log.status[0]).includes('$ (bell) bg-$ (sync~spin)1'), [threw, h.log.status]);
  finish(h);
}

/* ========================================================================= *
 * X1 — two readers of one fact: `list_workers` of the real dispatch server
 *      and the extension host's model, on the same registry and task log
 * ========================================================================= */

/** The 23 logs of the third review (`two-readers.cjs`), as data: accounts and events. */
function reviewScenarios() {
  let ts = Date.now() - 7_200_000;
  const e = (id, status, worker, model, extra = {}) => ({ id, status, ts: (ts += 1000), title: `task ${id}`, worker, model, ...extra });
  let n = 0;
  const tid = () => `t${(2000000 + ++n).toString(36)}r5`;
  const done = (worker, model, source, used, extra = {}) => {
    const id = tid();
    const src = source === undefined ? {} : { modelSource: source };
    return [e(id, 'running', worker, model, { ...src, ...extra }), e(id, 'done', worker, model, { ...src, ...(used === undefined ? {} : { modelUsed: used }), ...extra })];
  };
  const stem = `gpt-5.5-${'x'.repeat(60)}`;
  const one = (f) => { const id = tid(); return f(id); };
  return {
    'baseline': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: done('wa', 'haiku', 'worker', 'claude-haiku-4-5-20251001') },
    'done-then-cancel-error': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: one((id) => [e(id, 'running', 'wa', 'haiku', { modelSource: 'worker', pid: 4242 }), e(id, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }), e(id, 'error', 'wa', 'haiku', { modelSource: 'worker', pid: 4242, error: 'cancelled by user' })]) },
    'done-then-running': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: one((id) => [e(id, 'running', 'wa', 'haiku', { modelSource: 'worker' }), e(id, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }), e(id, 'running', 'wa', 'haiku', { modelSource: 'worker', pid: 4242 })]) },
    'duplicate-id-two-workers': { claude: [{ name: 'wa', model: 'haiku' }, { name: 'wb', model: 'haiku' }], vendor: [], events: one((id) => [e(id, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-A' }), e(id, 'done', 'wb', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-B' })]) },
    'vendor-cli-source-on-running-only': { claude: [], vendor: [{ name: 'cx', provider: 'codex' }], events: one((id) => [e(id, 'running', 'cx', '-', { modelSource: 'cli', provider: 'codex' }), e(id, 'done', 'cx', 'gpt-5.5', { modelUsed: 'gpt-5.5', provider: 'codex' })]) },
    'model-legacy-id': { claude: [{ name: 'wa', model: 'opus' }], vendor: [], events: done('wa', 'claude-opus-4-8', 'worker', 'claude-opus-4-8') },
    'model-other-case': { claude: [{ name: 'wa', model: 'opus' }], vendor: [], events: done('wa', 'OPUS', 'dispatch', 'claude-opus-5-5') },
    'model-padded': { claude: [{ name: 'wa', model: 'opus' }], vendor: [], events: done('wa', ' opus ', 'dispatch', 'claude-opus-5-5') },
    'registry-legacy-default': { claude: [{ name: 'wa', model: 'claude-opus-4-8' }], vendor: [], events: done('wa', 'opus', 'worker', 'claude-opus-5-5') },
    'registry-default-other-case': { claude: [{ name: 'wa', model: 'Opus' }], vendor: [], events: done('wa', 'opus', 'worker', 'claude-opus-5-5') },
    'name-reused-other-provider': { claude: [], vendor: [{ name: 'w2', provider: 'cursor' }], events: done('w2', 'gpt-5.5', 'cli', 'gpt-5.5', { provider: 'codex' }) },
    'name-reused-claude-to-vendor-same-default': { claude: [], vendor: [{ name: 'w3', provider: 'cursor', model: 'opus' }], events: done('w3', 'opus', 'worker', 'claude-opus-5-5') },
    'default-changed': { claude: [{ name: 'wa', model: 'sonnet' }], vendor: [], events: done('wa', 'haiku', 'worker', 'claude-haiku-4-5-20251001') },
    'vendor-default-64-prefix': { claude: [], vendor: [{ name: 'cx', provider: 'codex', model: `${stem}-AAAA` }], events: done('cx', `${stem}-BBBB`, 'dispatch', 'gpt-other', { provider: 'codex' }) },
    'vendor-default-set-after-cli-run': { claude: [], vendor: [{ name: 'cx', provider: 'codex', model: 'gpt-5.5-codex' }], events: done('cx', 'gpt-5.5', 'cli', 'gpt-5.5', { provider: 'codex' }) },
    'vendor-no-default-newest-named': { claude: [], vendor: [{ name: 'cx', provider: 'codex' }], events: [...done('cx', 'gpt-5.5', 'cli', 'gpt-5.5', { provider: 'codex' }), ...done('cx', 'gpt-5.5-codex', 'dispatch', 'gpt-9', { provider: 'codex' })] },
    'older-done-newer-done-without-report': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: [...done('wa', 'haiku', 'worker', 'claude-haiku-4-5-20251001'), ...done('wa', 'haiku', 'worker', undefined)] },
    'worker-named-constructor': { claude: [{ name: 'constructor', model: 'haiku' }], vendor: [], events: done('constructor', 'haiku', 'worker', 'claude-haiku-4-5-20251001') },
    'worker-padded-in-log': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: done('wa ', 'haiku', 'worker', 'claude-haiku-4-5-20251001') },
    'done-with-error-field': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: one((id) => [e(id, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001', error: 'cancelled: something' })]) },
    'odd-task-id': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: [{ id: '../../x', status: 'done', ts: Date.now() - 5000, title: 't', worker: 'wa', model: 'haiku', modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }] },
    'numeric-task-id': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: [{ id: 12345, status: 'done', ts: Date.now() - 5000, title: 't', worker: 'wa', model: 'haiku', modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }] },
    'no-ts': { claude: [{ name: 'wa', model: 'haiku' }], vendor: [], events: [{ id: tid(), status: 'done', title: 't', worker: 'wa', model: 'haiku', modelSource: 'worker', modelUsed: 'claude-haiku-4-5-20251001' }] },
  };
}

/**
 * The log the PRODUCT wrote in the third review's probe (`server-cancel.out`): a dispatch on
 * `wa`, cancelled from the editor while the worker was finishing. Its four events, with their
 * fields as they stand in that log (the two paths shortened).
 */
function productCancelLog() {
  const base = { id: 'tmv7jr7wy3k08', title: 'finishing', worker: 'wa', model: 'haiku', modelSource: 'worker', outputFile: '/x/tasks/tmv7jr7wy3k08.md', cwd: '/x/ws', promptPreview: 'say ok' };
  return {
    claude: [{ name: 'wa', model: 'haiku' }],
    vendor: [],
    events: [
      { ...base, ts: 1791948308435, status: 'running' },
      { ...base, ts: 1791948308437, status: 'running', pid: 65296, pgid: 65296 },
      { ...base, modelUsed: 'claude-haiku-4-5-20251001', ts: 1791948310187, status: 'done', inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
      { ...base, ts: 1791948312288, status: 'error', pid: 65296, pgid: 65296, error: 'cancelled by user' },
    ],
  };
}

/** `count` random registries + logs: every way an event can be shaped that either reader might read differently. */
function randomScenarios(count, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const CLAUDE_DEFAULTS = ['opus', 'sonnet', 'haiku', 'claude-opus-4-8', 'Opus', 'claude-opus-5-5'];
  const VENDOR = [['codex', ['', 'gpt-5.5', 'gpt-5.5-codex']], ['cursor', ['', 'auto', 'opus']], ['gemini', ['', 'gemini-3.8-flash-high']]];
  const NAMES = ['wa', 'wb', 'cx', 'w2', 'constructor'];
  const IDS = ['tabc0001', 'tabc0002', 'tabc0003', 'tabc0004', 'Odd_id-1', 'x', '../../x', 12345, '', 't' + 'z'.repeat(140)];
  const STATUS = ['running', 'done', 'done', 'done', 'error', 'weird'];
  const WORKERS = [...NAMES, ...NAMES, 'wa ', 'nobody', '', 7];
  const PROVIDERS = [undefined, undefined, undefined, null, 'codex', 'cursor', 'gemini', 'Codex', 'agy', 'martian', 42, ''];
  const MODELS = ['opus', 'OPUS', ' opus ', 'sonnet', 'haiku', 'claude-opus-4-8', 'claude-opus-5-5', 'gpt-5.5', 'gpt-5.5-codex', 'auto', 'gemini-3.8-flash-high', '-', '', 123, undefined, 'x'.repeat(300), 'op\u0000us'];
  const SOURCES = ['dispatch', 'worker', 'cli', 'cli', 'CLI', undefined, 7];
  const USED = ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.5', 'gpt-9', 'bad id!', '', 42, undefined, 'y'.repeat(70), '__proto__'];
  const TS = () => (rnd() < 0.9 ? Date.now() - Math.floor(rnd() * 5_000_000) - 1000 : pick([0, -1, 'now', undefined, 9e15, Date.now() + 9_000_000]));
  const out = [];
  for (let i = 0; i < count; i++) {
    const names = NAMES.filter(() => rnd() < 0.6);
    if (names.length === 0) names.push('wa');
    const claude = [];
    const vendor = [];
    for (const name of names) {
      if (rnd() < 0.55) claude.push({ name, model: pick(CLAUDE_DEFAULTS) });
      else { const [provider, defaults] = pick(VENDOR); vendor.push({ name, provider, model: pick(defaults) }); }
    }
    const events = [];
    const lines = 1 + Math.floor(rnd() * 14);
    const accounts = [...claude.map((w) => ({ ...w, provider: 'claude' })), ...vendor];
    // The spellings of a model that mean an account's default to the one rule, and near misses.
    const spelled = (model) => (rnd() < 0.7 ? model : pick([model.toUpperCase(), ` ${model} `, `${model}x`, model.slice(0, -1)]));
    for (let k = 0; k < lines; k++) {
      const roll = rnd();
      if (roll < 0.04) { events.push(pick([null, [], 'a string', 7, { id: 'tabc0001' }, { status: 'done' }])); continue; }
      const event = { id: pick(IDS), status: pick(STATUS), ts: TS(), title: 't' };
      const set = (key, value) => { if (value !== undefined) event[key] = value; };
      if (roll < 0.6) {
        // An event as the product writes one for an account of this registry — with one thing or
        // another off, now and then: these are the logs on which the rule has something to say.
        const account = pick(accounts);
        event.id = pick(IDS.slice(0, 6));
        event.status = rnd() < 0.7 ? 'done' : pick(STATUS);
        event.ts = Date.now() - Math.floor(rnd() * 5_000_000) - 1000;
        set('worker', rnd() < 0.9 ? account.name : pick(WORKERS));
        set('provider', rnd() < 0.85 ? (account.provider === 'claude' ? undefined : account.provider) : pick(PROVIDERS));
        set('model', account.model ? (rnd() < 0.8 ? spelled(account.model) : pick(MODELS)) : pick(['-', '', undefined, 'gpt-5.5']));
        set('modelSource', account.model ? pick(['worker', 'dispatch', 'dispatch', undefined]) : (rnd() < 0.75 ? 'cli' : pick(SOURCES)));
        set('modelUsed', rnd() < 0.8 ? pick(USED.slice(0, 5)) : pick(USED));
      } else {
        set('worker', pick(WORKERS));
        set('provider', pick(PROVIDERS));
        set('model', pick(MODELS));
        set('modelSource', pick(SOURCES));
        set('modelUsed', pick(USED));
      }
      events.push(event);
    }
    out.push({ claude, vendor, events });
  }
  return out;
}

async function x1TwoReaders() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const ui = h.req('uiModel.js');
  const { spawn, spawnSync } = require('child_process');
  // The dispatch server of THIS tree, bundled now — what is compared is the code as it stands.
  const serverJs = path.join(h.scratch, 'server.js');
  const built = spawnSync(path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'), ['src/mcp/server.ts', '--bundle', '--platform=node', '--target=node18', '--log-level=error', `--outfile=${serverJs}`], { cwd: REPO, encoding: 'utf8' });
  if (built.status !== 0 || !fs.existsSync(serverJs)) {
    check('the dispatch server of this tree bundles', false, String(built.stderr || built.error).split('\n').slice(0, 4).join(' | '));
    return finish(h);
  }

  /** One server, asked again and again: `call()` is one `list_workers`. */
  const child = spawn(process.execPath, [serverJs], { cwd: h.scratch, env: { ...process.env, NODE_OPTIONS: require('./keychain-guard.cjs').nodeOptionsWith('') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let errText = '';
  const waiting = new Map();
  child.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: `no answer in 30 s (stderr: ${errText.slice(-200)})` } }); }, 30_000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui7', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listWorkers = async () => {
    const msg = await rpc('tools/call', { name: 'list_workers', arguments: {} });
    return msg.error ? `RPC ERROR ${msg.error.message}` : (msg.result.content || []).map((c) => c.text).join('\n');
  };
  if (init.error) {
    check('the dispatch server starts and answers `initialize`', false, init.error);
    child.kill('SIGKILL');
    return finish(h);
  }

  const dirFor = (name) => path.join(h.home, `.acct-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`);
  let bump = 0;
  /** Put one scenario on disk — each file replaced by rename and given a time of its own, so no reader mistakes it for the one before. */
  const putOnDisk = (sc) => {
    const accounts = [...sc.claude.map((w) => ({ ...w, provider: 'claude' })), ...sc.vendor];
    for (const w of accounts) fs.mkdirSync(dirFor(w.name), { recursive: true });
    const put = (file, text) => {
      const tmp = `${file}.next`;
      fs.writeFileSync(tmp, text);
      const at = new Date(Date.now() - 600_000 + (bump += 1500));
      fs.utimesSync(tmp, at, at);
      fs.renameSync(tmp, file);
    };
    put(registry.REGISTRY_FILE, JSON.stringify({
      claudePath: path.join(h.fakebin, 'claude'),
      workers: sc.claude.map((w) => ({ name: w.name, configDir: dirFor(w.name), model: w.model })),
      vendorWorkers: sc.vendor.map((w) => ({ name: w.name, configDir: dirFor(w.name), model: w.model ?? '', provider: w.provider })),
    }, null, 2));
    put(registry.TASKS_LOG_FILE, sc.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // A fresh reading for every account: neither reader has a reason to ask a CLI.
    put(usage.USAGE_CACHE_FILE, JSON.stringify(Object.fromEntries(accounts.map((w) => [dirFor(w.name), { name: w.name, available: false, windows: [], fetchedAt: Date.now(), auth: { loggedIn: true, method: 'x', email: null, checkedAt: Date.now() } }]))));
    return accounts;
  };
  /** Both readers on what is on disk now: per account, what each says its default last ran as. */
  const readBoth = async (accounts) => {
    const text = await listWorkers();
    const model = ui.buildDashboardModel({ workspaceRoot: undefined, scope: 'all', settings: {}, health: {}, sessions: [] });
    return accounts.map((w) => {
      const line = text.split('\n').find((l) => l.startsWith(`- ${w.name}:`) || l.startsWith(`- ${w.name} [`)) ?? null;
      const m = line === null ? null : /\(last ran as ([^)]+)\)/.exec(line);
      const card = model.accounts.find((x) => x.isWorker && x.name === w.name);
      return {
        name: w.name,
        server: line === null ? '(no line)' : m ? m[1] : null,
        ui: card ? card.modelRanAs : '(no card)',
        picker: ui.modelLastRanAs(w.name, w.provider, w.model ? w.model : null),
        line: line === null ? text.slice(0, 160) : line.slice(0, 140),
      };
    });
  };
  // An account NEITHER reader lists (the registry's reader set the entry aside) is not a
  // disagreement; one that only one of them lists is.
  const absent = (x) => x.server === '(no line)' && x.ui === '(no card)';
  const disagreements = (rows) => rows.filter((x) => !absent(x) && (x.server !== x.ui || x.ui !== x.picker));

  // 1. The reviewer's 23 logs.
  const scenarios = reviewScenarios();
  const bad = [];
  const answers = {};
  for (const [name, sc] of Object.entries(scenarios)) {
    const rows = await readBoth(putOnDisk(sc));
    answers[name] = rows.map((x) => x.ui);
    for (const x of disagreements(rows)) bad.push({ log: name, account: x.name, list_workers: x.server, dashboard: x.ui, picker: x.picker });
  }
  check(`the third review's ${Object.keys(scenarios).length} logs: \`list_workers\` and the extension host say the same of every account`, Object.keys(scenarios).length === 23 && bad.length === 0, bad);
  // What the one rule says of them, pinned on the extension host's side (whatever the server says today).
  const EXPECTED = {
    'baseline': ['claude-haiku-4-5-20251001'], 'done-then-cancel-error': [null], 'done-then-running': [null], 'duplicate-id-two-workers': [null, 'claude-haiku-B'],
    'vendor-cli-source-on-running-only': [null], 'model-legacy-id': ['claude-opus-4-8'], 'model-other-case': ['claude-opus-5-5'], 'model-padded': ['claude-opus-5-5'],
    'registry-legacy-default': ['claude-opus-5-5'], 'registry-default-other-case': ['claude-opus-5-5'], 'name-reused-other-provider': [null], 'name-reused-claude-to-vendor-same-default': [null],
    'default-changed': [null], 'vendor-default-64-prefix': [null], 'vendor-default-set-after-cli-run': [null], 'vendor-no-default-newest-named': ['gpt-5.5'],
    'older-done-newer-done-without-report': ['claude-haiku-4-5-20251001'], 'worker-named-constructor': ['claude-haiku-4-5-20251001'], 'worker-padded-in-log': [null], 'done-with-error-field': ['claude-haiku-4-5-20251001'],
    'odd-task-id': [null], 'numeric-task-id': [null], 'no-ts': [null],
  };
  const wrong = Object.keys(EXPECTED).filter((k) => !same(answers[k], EXPECTED[k])).map((k) => [k, answers[k], EXPECTED[k]]);
  check('…and on each of them the extension host gives the answer of the one rule (the task\'s FINAL event; this account\'s name AND CLI; the default as the registry reads it)', wrong.length === 0, wrong);

  // 2. The log the product itself wrote: a cancel that landed while the worker was finishing.
  let rows = await readBoth(putOnDisk(productCancelLog()));
  check('the product-written cancel log (running, running, done, error "cancelled by user"): the two say the same — nothing, the task ended cancelled', disagreements(rows).length === 0 && rows[0].ui === null, rows);

  // 3. 2,000 random registries and logs.
  const random = randomScenarios(2000, 20261014);
  const differing = [];
  let told = 0;
  let silent = 0;
  let failedCalls = 0;
  const t0 = Date.now();
  for (let i = 0; i < random.length; i++) {
    rows = await readBoth(putOnDisk(random[i]));
    for (const x of rows) {
      if (absent(x)) continue;
      if (x.server === '(no line)' || x.ui === '(no card)' || String(x.server).startsWith('RPC ERROR')) failedCalls++;
      if (x.ui === null) silent++; else told++;
    }
    const d = disagreements(rows);
    if (d.length > 0 && differing.length < 400) differing.push({ log: i, accounts: d.map((x) => ({ account: x.name, list_workers: x.server, dashboard: x.ui, picker: x.picker })), events: random[i].events, registry: { claude: random[i].claude, vendor: random[i].vendor } });
  }
  note(`2,000 random logs through both readers in ${Date.now() - t0} ms: ${told} account answers that name a model, ${silent} that name none, ${differing.length} logs on which the readers differ`);
  check('the random logs exercise both answers: hundreds of accounts that are told a model, and hundreds that are told none', told >= 300 && silent >= 300 && failedCalls === 0, { told, silent, failedCalls });
  check('2,000 random logs: `list_workers` and the extension host never disagree', differing.length === 0, { logs: differing.length, first: differing.slice(0, 3) });
  if (differing.length > 0) {
    fs.writeFileSync(path.join(os.tmpdir(), 'ui7-two-readers-disagreements.json'), JSON.stringify({ review: bad, random: differing }, null, 1));
    note(`every disagreement is written to ${path.join(os.tmpdir(), 'ui7-two-readers-disagreements.json')}`);
  }
  try { child.stdin.end(); } catch { /* already closed */ }
  child.kill('SIGTERM');
  await sleep(200);
  finish(h);
}

/* ========================================================================= *
 * H1 — the dashboard host: policy freshness and the per-provider model list
 * ========================================================================= */

/** Open the dashboard, send `ready`, return the panel and the newest model. */
async function openDashboard(h) {
  await h.vscode.commands.executeCommand(`${P}openDashboard`);
  const panel = h.log.panels.find((p) => p.viewType === 'ccOrchestratorDashboard');
  const model = () => panel.posted.filter((p) => p.type === 'model').pop()?.model;
  const ready = async () => {
    const n = panel.posted.filter((p) => p.type === 'model').length;
    panel._recv.fire({ type: 'ready' });
    await until(() => panel.posted.filter((p) => p.type === 'model').length > n, 5000, 50);
    return model();
  };
  const send = async (msg, wait = 150) => { panel._recv.fire(msg); await sleep(wait); };
  await ready();
  return { panel, model, ready, send };
}

async function h1DashboardHost() {
  const h = boot({});
  const prompts = h.req('prompts.js');
  const usage = h.req('usage.js');
  const helper = writeHelper(h);
  const baseAbs = h.context.asAbsolutePath;
  h.context.asAbsolutePath = (p) => (/provider-cli\.js$/.test(p) ? helper.file : baseAbs(p));
  writeRegistry(h, [{ name: 'w1', model: 'opus' }], [{ name: 'cx', provider: 'codex', model: 'gpt-5.5' }, { name: 'cur', provider: 'cursor', model: 'claude-opus-5-5-high' }]);
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify(Object.fromEntries(['cx', 'cur'].map((n) => [dirOf(h, n), { name: n, available: false, auth: { loggedIn: true, method: 'x', email: null, checkedAt: Date.now() }, fetchedAt: Date.now(), windows: [] }]))));
  appendLog(h, doneTask('w1', 'opus', 'worker', 'claude-opus-5-5', { cwd: h.ws }).events);
  await activate(h, 700);
  const file = path.join(h.ws, 'CLAUDE.md');
  const BLOCK = prompts.DISPATCH_POLICY_MD;
  const d = await openDashboard(h);
  const health = async () => { const m = await d.ready(); return [m.health.policyInstalled, m.health.policyOutdated]; };
  let m = d.model();
  check('the first model carries policyOutdated, and with no CLAUDE.md it is null beside policyInstalled false', 'policyOutdated' in m.health && m.health.policyInstalled === false && m.health.policyOutdated === null, m.health);
  check('…and the tasks and accounts of that model carry the model fields', m.tasks[0]?.modelUsed === 'claude-opus-5-5' && m.tasks[0]?.modelSource === 'worker' && m.accounts.find((a) => a.name === 'w1')?.modelRanAs === 'claude-opus-5-5', [m.tasks[0], m.accounts.map((a) => [a.name, a.modelRanAs])]);
  fs.writeFileSync(file, `# x\n\n${BLOCK}\n`);
  check('this version\'s block: installed, not outdated', same(await health(), [true, false]), d.model().health);
  fs.writeFileSync(file, `# x\n\n${BLOCK.replace(/\n/g, '\r\n')}\r\n`);
  check('…also with CRLF line endings', same(await health(), [true, false]), d.model().health);
  fs.writeFileSync(file, `# x\n\n${BLOCK.replace('## Language', '## Language!')}\n\nmore text so that the size differs\n`);
  check('a block that differs (another version\'s, or edited): installed AND outdated', same(await health(), [true, true]), d.model().health);
  fs.writeFileSync(file, '# no block here at all, only some text of the project\n');
  check('a CLAUDE.md with no block: not installed, outdated null', same(await health(), [false, null]), d.model().health);

  // The page's command: the same command id, which asks before it replaces.
  const DIFFERS = `${BLOCK.replace('## Language', '## Language!')}\n`;
  fs.writeFileSync(file, DIFFERS);
  h.log.messages.length = 0;
  h.answers.message = () => undefined;
  await d.send({ type: 'command', id: 'addDispatchPolicy' }, 300);
  check('the page\'s "Update Dispatch Policy" runs the command, which ASKS (one modal) and writes nothing on "no"', h.log.messages.filter((x) => x.modal).length === 1 && fs.readFileSync(file, 'utf8') === DIFFERS, brief(h));
  await sleep(1100); // the page lane admits one such action a second
  h.answers.message = (rec) => (rec.modal ? 'Replace' : undefined);
  await d.send({ type: 'command', id: 'addDispatchPolicy' }, 400);
  h.answers.message = () => undefined;
  check('…and replaces the block on "Replace", after which the model says it is current', fs.readFileSync(file, 'utf8') === `${BLOCK}\n` && same(await health(), [true, false]), [fs.readFileSync(file, 'utf8').slice(0, 50), d.model().health]);

  // The per-provider model list.
  const providers = h.req('providers.js');
  const modelsOf = (model, id) => model.settings.providers.find((p) => p.id === id)?.models;
  m = await d.ready();
  check('with no catalog in memory the page is offered the built-in suggestions', same(modelsOf(m, 'codex'), [...providers.providerInfo('codex').suggestedModels]) && same(modelsOf(m, 'cursor'), [...providers.providerInfo('cursor').suggestedModels]), [modelsOf(m, 'codex'), modelsOf(m, 'cursor')]);
  const n0 = helper.modelCalls().length;
  for (const msg of [{ type: 'ready' }, { type: 'setScope', scope: 'all' }, { type: 'setScope', scope: 'workspace' }, { type: 'command', id: 'refreshUsage' }, { type: 'account', action: 'togglePreferred', account: m.accounts.find((a) => a.name === 'cx')?.key }]) {
    await d.send(msg, 200);
  }
  check('messages from the page (ready, scope, refresh, an account action) never start a `models` run', helper.modelCalls().length === n0, helper.modelCalls().length - n0);
  if (typeof usage.listProviderModels === 'function') {
    helper.answer({ models: [{ id: 'auto' }, { id: 'claude-opus-5-5-high', resold: true }, { id: 'composer-3' }, { id: 'gpt-5.3-codex', resold: true }], source: 'live', error: null });
    await usage.listProviderModels({ helperPath: helper.file, provider: 'cursor', configDir: dirOf(h, 'cur') });
    m = await d.ready();
    check('once a picker has asked a CLI, the page is offered that list — its OWN models only, never the resold ones', same(modelsOf(m, 'cursor'), ['auto', 'composer-3']) && same(modelsOf(m, 'codex'), [...providers.providerInfo('codex').suggestedModels]), [modelsOf(m, 'cursor'), modelsOf(m, 'codex')]);
    check('…a stored default that is a resold id is still the account\'s current value', m.accounts.find((a) => a.name === 'cur')?.defaultModel === 'claude-opus-5-5-high', m.accounts.find((a) => a.name === 'cur'));
    check('…and Claude Code\'s list is its four aliases whatever is in memory', same(modelsOf(m, 'claude'), ['opus', 'sonnet', 'haiku', 'fable']) && same(m.settings.workerModels, ['opus', 'sonnet', 'haiku', 'fable']), [modelsOf(m, 'claude'), m.settings.workerModels]);
    const real = cursorCatalog();
    usage.resetProviderModelsForTest();
    helper.answer(real.catalog);
    await usage.listProviderModels({ helperPath: helper.file, provider: 'cursor', configDir: dirOf(h, 'cur') });
    helper.answer({ models: Array.from({ length: 40 }, (_, i) => ({ id: `gpt-own-${i}` })), source: 'live', error: null });
    await usage.listProviderModels({ helperPath: helper.file, provider: 'codex', configDir: dirOf(h, 'cx') });
    m = await d.ready();
    check('a listing of 259 (17 own): the page is offered the 17 own, in the CLI\'s order, and none of the 242', same(modelsOf(m, 'cursor'), real.own), [modelsOf(m, 'cursor')?.length, modelsOf(m, 'cursor')?.slice(0, 5)]);
    check('…and never more than 24 of a CLI\'s own models (here 40 are listed)', same(modelsOf(m, 'codex'), Array.from({ length: 24 }, (_, i) => `gpt-own-${i}`)), modelsOf(m, 'codex')?.length);

    // "Other…" (setModel with NO value) opens the picker, which can start the helper: it is
    // bounded on a lane of its own. A row of the page's list (setModel WITH a value) is a write.
    const registry = h.req('registry.js');
    const cxKey = m.accounts.find((a) => a.name === 'cx')?.key;
    const modelOfCx = () => registry.readRegistry().workers.find((w) => w.name === 'cx')?.model;
    usage.resetProviderModelsForTest();
    helper.answer({ models: [{ id: 'gpt-9-a' }, { id: 'gpt-9-b' }], source: 'live', error: null }, { delayMs: 300 });
    await sleep(1100);
    h.log.messages.length = 0;
    let pickers0 = h.log.pickers.length;
    let calls0 = helper.modelCalls().length;
    let posted0 = d.panel.posted.length;
    let t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      d.panel._recv.fire({ type: 'account', action: 'setModel', account: cxKey });
      await sleep(15);
    }
    const burstMs = Date.now() - t0;
    await sleep(900);
    const opened = h.log.pickers.slice(pickers0);
    const bursts = d.panel.posted.slice(posted0).filter((x) => x.type === 'notice' && /several actions at once/.test(String(x.text)));
    check('five setModel WITHOUT a value inside the lane\'s one-second interval: ONE picker opens, the other four are dropped, and the page is told once', burstMs < 1000 && opened.length === 1 && bursts.length === 1 && bursts[0].level === 'warning', { burstMs, pickers: opened.length, notices: bursts.length });
    check('…and at most one helper child was started for it', helper.modelCalls().length - calls0 <= 1 && helper.modelCalls().length - calls0 === 1 && same(helper.modelCalls().pop().args, ['models', 'codex', dirOf(h, 'cx'), '--budget-ms=25000']), helper.modelCalls().slice(calls0).map((c) => c.args));
    check('…the one picker is the model picker of that account, with the list the CLI gave', opened[0] && /"cx"/.test(String(opened[0].placeholder)) && opened[0].items.some((i) => i.label === 'gpt-9-a') && modelOfCx() === 'gpt-5.5', opened[0] && [opened[0].placeholder, opened[0].items.map((i) => i.label), modelOfCx()]);
    if (opened[0]) opened[0].hide();
    await sleep(60);
    // After the interval the lane is open again — and the list is answered from memory.
    await sleep(1100);
    pickers0 = h.log.pickers.length;
    calls0 = helper.modelCalls().length;
    await d.send({ type: 'account', action: 'setModel', account: cxKey }, 200);
    check('a second later "Other…" opens the picker again, and starts no second helper (the list is in memory)', h.log.pickers.length - pickers0 === 1 && helper.modelCalls().length === calls0 && h.log.pickers[pickers0].busy === false, [h.log.pickers.length - pickers0, helper.modelCalls().length - calls0]);
    if (h.log.pickers[pickers0]) h.log.pickers[pickers0].hide();
    await sleep(60);

    h.log.messages.length = 0;
    pickers0 = h.log.pickers.length;
    posted0 = d.panel.posted.length;
    const values = ['gpt-w-1', 'gpt-w-2', 'gpt-w-3', 'gpt-w-4', 'gpt-w-5'];
    t0 = Date.now();
    for (const value of values) {
      d.panel._recv.fire({ type: 'account', action: 'setModel', account: cxKey, value });
      await sleep(15);
    }
    const writesMs = Date.now() - t0;
    await sleep(500);
    const wrote = h.log.messages.filter((x) => /"cx" now defaults to gpt-w-\d /.test(String(x.message))).map((x) => String(x.message).match(/gpt-w-\d/)[0]);
    check('five setModel WITH a value inside the lane\'s one-second interval: five writes, in order, none dropped — and no picker, no helper, no "several actions" notice', writesMs < 1000 && same(wrote, values) && modelOfCx() === 'gpt-w-5' && h.log.pickers.length === pickers0 && helper.modelCalls().length === calls0 && !d.panel.posted.slice(posted0).some((x) => x.type === 'notice' && /several actions at once/.test(String(x.text))), { writesMs, wrote, model: modelOfCx(), pickers: h.log.pickers.length - pickers0 });
  } else {
    check('usage.listProviderModels exists', false, typeof usage.listProviderModels);
  }
  finish(h);
}

/* ========================================================================= *
 * T1 / T2 — a task ends once: a cancel from the Tasks tree and the task's
 *           own completion, arriving together
 * ========================================================================= */

/** The terminal events (`done` / `error`) the log holds for `id`, read straight from the file. */
function terminalsOf(h, id) {
  const registry = h.req('registry.js');
  const out = [];
  for (const line of fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n')) {
    if (!line.includes(id)) continue;
    try {
      const e = JSON.parse(line);
      if (e.id === id && (e.status === 'done' || e.status === 'error')) out.push(e);
    } catch {
      // a line that is no event
    }
  }
  return out;
}
const terminalWords = (events) => events.map((e) => (e.status === 'done' ? 'done' : `error: ${e.error}`));
const readJsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A script that writes a task's completion the way a dispatch writes it now — through
 * registry.appendTerminalTaskEvent of the build under test — at the instants its plan names,
 * and records what each write did. It runs as a process of its own, with HOME set to the
 * case's home BEFORE the registry loads (the data directory is derived from it then).
 *   node complete.cjs <plan.json> <results.jsonl> [<key>]   — only the plan entries of <key>
 */
function writeCompleter(h) {
  const file = path.join(h.scratch, 'complete.cjs');
  fs.writeFileSync(file, `'use strict';
const fs = require('fs');
const os = require('os');
process.env.HOME = ${JSON.stringify(h.home)};
process.env.USERPROFILE = ${JSON.stringify(h.home)};
if (os.homedir() !== ${JSON.stringify(h.home)}) process.exit(3);
const registry = require(${JSON.stringify(path.join(OUT, 'registry.js'))});
const [planFile, resultFile, only] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')).filter((p) => only === undefined || p.key === only);
(async () => {
  for (const p of plan) {
    while (Date.now() < p.at - 4) await new Promise((r) => setTimeout(r, 2));
    while (Date.now() < p.at) { /* the last milliseconds are spun, not slept */ }
    let closed = null;
    let error = null;
    try {
      closed = registry.appendTerminalTaskEvent({ ...p.event, ts: Date.now() }).closed;
    } catch (e) {
      error = String((e && e.message) || e);
    }
    fs.appendFileSync(resultFile, JSON.stringify({ id: p.event.id, closed, error, at: Date.now() }) + '\\n');
  }
})();
`);
  return file;
}

async function t1CancelRace() {
  const h = boot({});
  const registry = h.req('registry.js');
  const views = h.req('views.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }]);
  if (typeof registry.appendTerminalTaskEvent !== 'function') {
    check('registry.appendTerminalTaskEvent exists', false, typeof registry.appendTerminalTaskEvent);
    finish(h);
  }
  // A log long enough that ONE read of it takes a while: the windows in which a cancel and a
  // completion can overlap are then wide, and each race below lands inside one by design.
  const now0 = Date.now();
  const filler = [];
  for (let i = 0; i < 40000; i++) {
    filler.push(JSON.stringify({ id: `f${(1e6 + i).toString(36)}fill`, status: 'done', ts: now0 - 7_200_000 + i, title: `filler ${i} ${'x'.repeat(160)}`, worker: 'w1', model: 'opus' }));
  }
  fs.appendFileSync(registry.TASKS_LOG_FILE, filler.join('\n') + '\n');
  let readMs = 1;
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    registry.latestEventByIdChecked('tnone0000');
    readMs = Math.max(readMs, Date.now() - t);
  }
  // Session-worker tasks (they carry `meshWorker`), with no ledger record: the cancel runs no
  // `claude stop`, and the race is the cancel's record against the completion's.
  const N = 12;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const id = taskId();
    tasks.push(id);
    appendLog(h, [{ id, status: 'running', ts: now0 - 60_000 + i, title: `racing ${i}`, worker: 'w1', model: 'opus', meshWorker: `cco-w-aaaaaa-w1-${i + 1}` }]);
  }
  const gap = 4 * readMs + 250;
  const t0 = Date.now() + 1500;
  // The completion of task i is written from 0.3 reads BEFORE its cancel starts to 2.5 reads after.
  const offset = (i) => Math.round(-0.3 * readMs + (i / (N - 1)) * 2.8 * readMs);
  const plan = tasks.map((id, i) => ({ at: t0 + i * gap + offset(i), event: { id, status: 'done', title: `racing ${i}`, worker: 'w1', model: 'opus', meshWorker: `cco-w-aaaaaa-w1-${i + 1}` } }));
  const planFile = path.join(h.scratch, 'plan.json');
  const results = path.join(h.scratch, 'results.jsonl');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const child = spawn(process.execPath, [writeCompleter(h), planFile, results], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d; });
  const childExit = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const cancels = [];
  for (let i = 0; i < N; i++) {
    const at = t0 + i * gap;
    while (Date.now() < at - 4) await sleep(2);
    while (Date.now() < at) { /* spun */ }
    let value;
    let threw = '';
    try {
      value = await views.cancelTaskMeshAware(tasks[i], 'cancelled by user', {});
    } catch (e) {
      threw = String((e && e.message) || e);
    }
    cancels.push({ value, threw });
  }
  const code = await childExit;
  const wrote = readJsonLines(results);
  check('the completing process made every write of its plan', code === 0 && wrote.length === N && wrote.every((w) => w.error === null), { code, wrote: wrote.length, err: childErr.slice(0, 300), errors: wrote.filter((w) => w.error).slice(0, 2) });
  const per = tasks.map((id, i) => {
    const mine = wrote.find((w) => w.id === id);
    return { i, offsetMs: offset(i), terminals: terminalWords(terminalsOf(h, id)), cancel: cancels[i].value, threw: cancels[i].threw, completion: mine ? mine.closed : null };
  });
  check(
    `${N} cancels from the tree, each with its task's completion written in the same instant (from ${-offset(0)} ms before the cancel to ${offset(N - 1)} ms after it; one read of the log takes ${readMs} ms): every task has exactly ONE terminal event`,
    per.every((p) => p.terminals.length === 1),
    per.filter((p) => p.terminals.length !== 1),
  );
  check(
    '…and each side is told the truth: the cancel says it cancelled exactly when the log holds its record, the completion says it wrote exactly when the log holds its',
    per.every((p) => p.threw === '' && p.terminals.length === 1 && (p.cancel === true) === (p.terminals[0] === 'error: cancelled by user') && (p.completion === true) === (p.terminals[0] === 'done')),
    per.filter((p) => !(p.threw === '' && p.terminals.length === 1 && (p.cancel === true) === (p.terminals[0] === 'error: cancelled by user') && (p.completion === true) === (p.terminals[0] === 'done'))),
  );
  note(`of ${N} races the cancel was recorded first ${per.filter((p) => p.terminals[0] === 'error: cancelled by user').length} time(s), the completion ${per.filter((p) => p.terminals[0] === 'done').length} time(s) (one read of a ${filler.length + N}-line log: ${readMs} ms)`);
  finish(h);
}

async function t2CancelCommand() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const contract = h.req('mesh/contract.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }]);
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({ [dirOf(h, 'w1')]: { name: 'w1', available: true, windows: [], fetchedAt: Date.now() } }));
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  // The `claude` of this case: `stop <job>` ends the session — and the dispatch, seeing its
  // worker end, records the task's completion through the build's own writer; `rm` succeeds.
  const planFile = path.join(h.scratch, 'plan.json');
  const results = path.join(h.scratch, 'results.jsonl');
  const calls = path.join(h.scratch, 'claude-calls.log');
  const completer = writeCompleter(h);
  const fake = path.join(h.fakebin, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${shq(calls)}\ncase "$1" in\n  --version) echo "2.1.283 (Claude Code)"; exit 0;;\n  stop) ${shq(process.execPath)} ${shq(completer)} ${shq(planFile)} ${shq(results)} "$2"; exit 0;;\n  rm) exit 0;;\nesac\nexit 1\n`);
  fs.chmodSync(fake, 0o755);
  await activate(h, 900);
  const stops = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('stop ')) : []);
  const said = () => h.log.messages.map((m) => String(m.message));
  const toldFor = (terminals) => (terminals.length === 1 && terminals[0] === 'done' ? 'That dispatch was no longer running — its row has been cleared.' : 'Dispatched task cancelled.');

  // A — the cancel is asked for while the task runs; its stop ends the worker, and the
  // completion the dispatch then writes arrives at a task that is already closed.
  const A = taskId();
  const B = taskId();
  const running = (id, name) => ({ id, status: 'running', ts: Date.now() - 30_000, title: `session task ${id}`, worker: 'w1', model: 'opus', meshWorker: name });
  const record = (id, name, jobId) => ({ name, account: 'w1', configDir: dirOf(h, 'w1'), jobId, model: 'opus', role: 'worker', spawnedAt: Date.now() - 30_000, taskId: id });
  fs.mkdirSync(contract.MESH_STATE_DIR, { recursive: true });
  fs.writeFileSync(contract.meshStateFile(h.ws), JSON.stringify({ cwd: h.ws, workers: [record(A, 'cco-w-aaaaaa-w1-1', 'jobaaaa01'), record(B, 'cco-w-aaaaaa-w1-2', 'jobbbbb02')] }));
  fs.writeFileSync(planFile, JSON.stringify([{ key: 'jobaaaa01', at: 0, event: { ...running(A, 'cco-w-aaaaaa-w1-1'), status: 'done' } }]));
  appendLog(h, [running(A, 'cco-w-aaaaaa-w1-1')]);
  h.log.messages.length = 0;
  let r = await exec(h, 'cancelTask', { id: A });
  const termsA = terminalWords(terminalsOf(h, A));
  const wroteA = readJsonLines(results);
  check('"Cancel Dispatch" on a running session task whose stop ends the worker — the dispatch then writing the completion — leaves ONE terminal event: the cancel', r.threw === '' && same(termsA, ['error: cancelled by user']), { threw: r.threw, terminals: termsA });
  check('…the session was stopped once, and the completion that came after the cancel wrote nothing', same(stops(), ['stop jobaaaa01']) && wroteA.length === 1 && wroteA[0].closed === false, { stops: stops(), wrote: wroteA });
  check('…and what the user is told is what the log says', same(said(), [toldFor(termsA)]) && same(said(), ['Dispatched task cancelled.']), { said: said(), terminals: termsA });

  // B — the completion is in the log by the time the cancel arrives.
  appendLog(h, [running(B, 'cco-w-aaaaaa-w1-2')]);
  registry.appendTerminalTaskEvent({ ...running(B, 'cco-w-aaaaaa-w1-2'), ts: Date.now(), status: 'done' });
  h.log.messages.length = 0;
  r = await exec(h, 'cancelTask', { id: B });
  const termsB = terminalWords(terminalsOf(h, B));
  check('"Cancel Dispatch" that arrives just after the completion: the completion stands, nothing is stopped, and the user is told "That dispatch was no longer running — its row has been cleared."', r.threw === '' && same(termsB, ['done']) && same(stops(), ['stop jobaaaa01']) && same(said(), ['That dispatch was no longer running — its row has been cleared.']), { threw: r.threw, terminals: termsB, stops: stops(), said: said() });
  finish(h);
}

/* ========================================================================= *
 * P1 — the dashboard page, in a browser
 * ========================================================================= */

/** The string block of fixtures.js as the string-table check generates it, from a table. */
function stringBlock(table) {
  const asciiJson = (v) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return `/* <strings:begin> */\n  const STRINGS = {\n${Object.entries(table).map(([k, v]) => `    ${k}: ${asciiJson(v)},`).join('\n')}\n  };\n  /* <strings:end> */`;
}

// Runs inside the page: everything a check needs, as plain data.
const PAGE_AUDIT = `(() => {
  const app = document.getElementById('app');
  const text = (el) => (el ? el.textContent.trim() : null);
  const w = window.innerWidth;
  const wide = [];
  if (document.documentElement.scrollWidth > w) app.querySelectorAll('.page *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > w + 0.5 && wide.length < 5 && !el.closest('.vh') && !el.classList.contains('vh')) wide.push(el.className + ' right=' + Math.round(r.right));
  });
  const tags = new Set();
  app.querySelectorAll('img, script, iframe, object, embed').forEach((el) => tags.add(el.tagName));
  return {
    mounted: !!app.querySelector('.page'),
    missing: document.getElementById('pv-missing').textContent,
    xss: !!window.__CCO_XSS__,
    foreign: Array.from(tags),
    overflow: { innerWidth: w, scrollWidth: document.documentElement.scrollWidth, offenders: wide },
    count: text(app.querySelector('.sec-accounts .sec-count')),
    summary: text(app.querySelector('.sec-accounts .sec-summary')),
    cards: Array.from(app.querySelectorAll('.acct')).map((c) => ({ name: text(c.querySelector('.acct-name')), state: c.getAttribute('data-state'), word: text(c.querySelector('.acct-state-text')), facts: text(c.querySelector('.acct-facts')), factsTitle: c.querySelector('.acct-facts').getAttribute('title'), noread: !!c.querySelector('.noread') && !c.querySelector('.noread').hidden })),
    tasks: Array.from(app.querySelectorAll('.task')).map((t) => ({ title: text(t.querySelector('.task-titlebox')), model: text(t.querySelector('.cell-model .cell-value')), tip: t.querySelector('.cell-model .cell-value').getAttribute('title'), detail: Array.from(t.querySelectorAll('.task-detail .detail-row')).map((r) => [text(r.querySelector('dt')), text(r.querySelector('dd'))]) })),
    chips: Array.from(app.querySelectorAll('.health .chip-btn')).map((c) => ({ text: text(c), title: c.getAttribute('title') })),
    setup: Array.from(app.querySelectorAll('.setup-row')).map((r) => ({ label: text(r.querySelector('.setup-label')), state: r.getAttribute('data-state'), word: text(r.querySelector('.setup-state')), button: text(r.querySelector('button')), primary: r.querySelector('button').classList.contains('btn-primary') })),
    posted: (window.__CCO_POSTED__ || []).slice(),
  };
})()`;

async function p1Page() {
  let startChrome;
  try {
    ({ startChrome } = require('./shell-b-page.cjs'));
  } catch (e) {
    check('the page driver of shell-b-page.cjs loads', false, String(e));
    process.exit(0);
  }
  // This case runs under a redirected HOME, where macOS finds no default keychain: a Chrome
  // started without --use-mock-keychain makes the system put a "Keychain Not Found" dialog on
  // the user's screen. The browser is started through startChrome and nowhere else, and not at
  // all unless that function passes the flag.
  if (!fs.readFileSync(require.resolve('./shell-b-page.cjs'), 'utf8').includes("'--use-mock-keychain'")) {
    check('the browser driver starts Chrome with --use-mock-keychain (no browser was started, and no page check ran)', false, 'startChrome of shell-b-page.cjs does not pass the flag');
    process.exit(0);
  }
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const prompts = h.req('prompts.js');
  const now = Date.now();
  const CLAUDE = ['w-ready', 'w-out', 'w-limit', 'w-cool', 'w-error', 'w-check'];
  writeRegistry(h, CLAUDE.map((name) => ({ name, model: name === 'w-limit' ? 'haiku' : 'opus' })), [{ name: 'cx-noread', provider: 'codex' }, { name: 'cx-cool', provider: 'codex', model: 'gpt-5.5' }]);
  const win = (percent, severity) => [{ kind: 'session', label: 'Session (5hr)', percent, severity, resetsAt: new Date(now + 2 * 3600_000).toISOString() }];
  const ok = (name, windows) => ({ name, available: true, subscriptionType: 'max', windows, fetchedAt: now, auth: { loggedIn: true, method: 'oauth', email: null, checkedAt: now } });
  const loggedIn = (name) => ({ name, available: false, windows: [], fetchedAt: now, auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now } });
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({
    [path.join(h.home, '.claude')]: ok('main', win(8, 'normal')),
    [dirOf(h, 'w-ready')]: ok('w-ready', win(12, 'normal')),
    // CA (Login state): "logged out" is a CONFIRMED logout — two "not logged in" probes of this
    // version at least N apart, the newer in this process's lifetime.
    [dirOf(h, 'w-out')]: { name: 'w-out', configDir: dirOf(h, 'w-out'), available: false, windows: [], fetchedAt: now, auth: { loggedIn: false, method: null, email: null, checkedAt: now }, loginProbes: confirmedOut(now) },
    [dirOf(h, 'w-limit')]: ok('w-limit', win(100, 'critical')),
    [dirOf(h, 'w-cool')]: ok('w-cool', win(40, 'normal')),
    [dirOf(h, 'w-error')]: { name: 'w-error', error: 'the usage probe timed out', fetchedAt: now },
    // w-check has no reading at all: it is still being checked.
    [dirOf(h, 'cx-noread')]: loggedIn('cx-noread'),
    [dirOf(h, 'cx-cool')]: loggedIn('cx-cool'),
  }));
  fs.writeFileSync(registry.STATS_FILE, JSON.stringify({
    'w-cool': { tasks: 2, inputTokens: 10, outputTokens: 5, costUsd: 0, errors: 0, cooldownUntil: now + 20 * 60_000 },
    'cx-cool': { tasks: 2, inputTokens: 10, outputTokens: 5, costUsd: 0, errors: 0, cooldownUntil: now + 20 * 60_000 },
    'w-ready': { tasks: 3, inputTokens: 10, outputTokens: 5, costUsd: 0, errors: 0 },
  }));
  const cwd = { cwd: h.ws };
  const tRan = doneTask('w-ready', 'opus', 'worker', 'claude-opus-5-5', cwd);
  const tNamed = doneTask('w-limit', 'haiku', 'dispatch', 'claude-haiku-4-5-20251001', cwd);
  const tCli = doneTask('cx-noread', 'default', 'cli', 'gpt-5.6-sol', { ...cwd, provider: 'codex' });
  const tOld = doneTask('w-cool', 'opus', undefined, undefined, cwd);
  const tSame = doneTask('w-ready', 'claude-opus-5-5', 'dispatch', 'claude-opus-5-5', cwd);
  // A failed dispatch as an earlier server recorded it: the model "-" beside a source.
  const dashW = taskId();
  const dashD = taskId();
  const tDashWorker = { id: dashW, events: [ev(dashW, 'running', 'w-ready', 'opus', { ...cwd, modelSource: 'worker' }), ev(dashW, 'error', 'w-ready', '-', { ...cwd, modelSource: 'worker', error: 'the run failed' })] };
  const tDashDispatch = { id: dashD, events: [ev(dashD, 'error', 'w-ready', '-', { ...cwd, modelSource: 'dispatch', error: 'the run failed' })] };
  for (const t of [tRan, tNamed, tCli, tOld, tSame, tDashWorker, tDashDispatch]) for (const e of t.events) e.title = { [tRan.id]: 'ran on the worker default', [tNamed.id]: 'named by the dispatch', [tCli.id]: 'left to the CLI', [tOld.id]: 'an older entry', [tSame.id]: 'asked for a full id', [dashW]: 'no model on record, worker default', [dashD]: 'no model on record, dispatch' }[t.id];
  appendLog(h, [tRan, tNamed, tCli, tOld, tSame, tDashWorker, tDashDispatch].flatMap((t) => t.events));
  fs.writeFileSync(path.join(h.ws, 'CLAUDE.md'), `${prompts.DISPATCH_POLICY_MD.replace('## Language', '## Language (edited)')}\n`);
  fs.writeFileSync(path.join(h.ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'cco-dispatch': { command: 'node', args: ['x'] } } }));
  // The readings above are the fixture: activation must not ask the (fake) CLIs for new ones,
  // which would file a failed probe over every account that has none.
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  await activate(h, 700);
  const d = await openDashboard(h);
  const model = d.model();
  const states = Object.fromEntries(model.accounts.map((a) => [a.name, a.login]));
  check('the host model under the page holds every account state (ready, logged in without a reading, cooling, logged out, at a limit, check failed, still checking)', model.accounts.length === 9 && states.main === 'ok' && states['w-out'] === 'expired' && states['w-error'] === 'error' && states['w-check'] === 'refreshing' && states['cx-noread'] === 'no-plan-limits' && states['cx-cool'] === 'no-plan-limits' && model.accounts.find((a) => a.name === 'w-cool').cooldownUntil > now && model.health.policyOutdated === true, [states, model.health]);

  // The page of the tree under test, with the string table the build under test hands it.
  const media = path.join(h.scratch, 'media');
  fs.cpSync(MEDIA, media, { recursive: true });
  const table = h.req('dashboard.js').dashboardStrings();
  const fixturesFile = path.join(media, 'fixtures.js');
  const fixtures = fs.readFileSync(fixturesFile, 'utf8');
  const a = fixtures.indexOf('/* <strings:begin> */');
  const b = fixtures.indexOf('/* <strings:end> */');
  fs.writeFileSync(fixturesFile, fixtures.slice(0, a) + stringBlock(table) + fixtures.slice(b + '/* <strings:end> */'.length));

  let browser;
  try {
    browser = await startChrome(h.scratch);
  } catch (e) {
    check('headless Chrome starts', false, String(e && e.message));
    return finish(h);
  }
  if (!browser) {
    console.log(`SKIP ${CASE}: headless Chrome not found — the page checks did not run (set CHROME_BIN to a Chromium-family browser)`);
    return finish(h);
  }
  const EXPECTED_SUMMARY = '3 ready · 1 logged out · 1 at a limit · 2 cooling down · 1 check failed · 1 checking';
  const WORD = { ok: 'Ready', nolimits: 'Logged in', expired: 'Logged out', limit: 'At a plan limit', cooling: 'Cooling down', error: 'Account check failed', refreshing: 'Checking usage…' };
  const BUCKET = { ok: 'ready', nolimits: 'ready', expired: 'logged out', limit: 'at a limit', cooling: 'cooling down', error: 'check failed', refreshing: 'checking' };
  try {
    for (const theme of ['dark', 'light']) {
      for (const width of [1400, 480]) {
        const where = `${theme} / ${width}px`;
        await browser.open(`file://${path.join(media, 'preview.html')}?fixture=empty&theme=${theme}&bar=0`, width, 900);
        await browser.evaluate(`window.postMessage(${JSON.stringify({ type: 'model', model })}, '*'), new Promise((r) => setTimeout(r, 450))`);
        // Open every task's details, so their rows can be read.
        await browser.evaluate(`document.querySelectorAll('.task .btn-expand').forEach((b) => b.click()), new Promise((r) => setTimeout(r, 150))`);
        const s = await browser.evaluate(PAGE_AUDIT);
        check(`${where}: the page mounts with no console error, no missing string, nothing executed`, s.mounted && s.missing === '' && !s.xss && s.foreign.length === 0 && browser.events.length === 0, { missing: s.missing, events: browser.events.slice(0, 3), foreign: s.foreign });
        check(`${where}: no horizontal overflow`, s.overflow.scrollWidth <= s.overflow.innerWidth, s.overflow);
        const parts = (s.summary ?? '').split(' · ').map((p) => Number.parseInt(p, 10));
        check(`${where}: the Accounts heading says "${EXPECTED_SUMMARY}"`, s.summary === EXPECTED_SUMMARY && s.count === '9', [s.count, s.summary]);
        check(`${where}: its parts add up to the number of accounts, and no part is zero`, parts.length > 0 && parts.every((n) => Number.isInteger(n) && n > 0) && parts.reduce((x, y) => x + y, 0) === model.accounts.length && s.cards.length === model.accounts.length, parts);
        // Every card's state is counted in the part its state word belongs to.
        const perBucket = {};
        for (const c of s.cards) perBucket[BUCKET[c.state]] = (perBucket[BUCKET[c.state]] ?? 0) + 1;
        const fromCards = ['ready', 'logged out', 'at a limit', 'cooling down', 'check failed', 'checking'].filter((k) => perBucket[k]).map((k) => `${perBucket[k]} ${k}`).join(' · ');
        check(`${where}: counting the cards by their own state gives the same sentence, and each card says its state's word`, fromCards === s.summary && s.cards.every((c) => c.word === (c.state === 'nolimits' && !/^w-|^main$/.test(c.name) ? 'Logged in' : WORD[c.state])), [fromCards, s.cards.map((c) => [c.name, c.state, c.word])]);
        const card = (name) => s.cards.find((c) => c.name === name) ?? {};
        check(`${where}: logged in without a reading is ready's — and its card says there is no reading; with a cooldown it is "Cooling down"`, card('cx-noread').state === 'nolimits' && card('cx-noread').noread === true && card('cx-cool').state === 'cooling' && card('cx-cool').word === 'Cooling down' && card('cx-cool').noread === true, [card('cx-noread'), card('cx-cool')]);
        check(`${where}: an account card says "default <alias> · last ran <id>" when it is known, and only then`, /^default opus · last ran claude-opus-5-5( · |$)/.test(card('w-ready').facts) && /^default haiku · last ran claude-haiku-4-5-20251001/.test(card('w-limit').facts) && /^CLI default · last ran gpt-5\.6-sol/.test(card('cx-noread').facts) && /^default gpt-5\.5( · checked|$)/.test(card('cx-cool').facts) && /^default opus( · checked|$)/.test(card('w-out').facts) && !/last ran/.test(card('w-out').facts) && /claude-opus-5-5/.test(card('w-ready').factsTitle ?? '') && card('w-out').factsTitle === null, [card('w-ready').facts, card('w-limit').facts, card('cx-noread').facts, card('w-out').facts, card('w-ready').factsTitle]);
        const task = (title) => s.tasks.find((t) => String(t.title).startsWith(title)) ?? {};
        const detailOf = (t, label) => (t.detail ?? []).find((r) => r[0] === label)?.[1];
        check(`${where}: a task row shows the requested model and "→ <what ran>" when that is known and differs`, task('ran on the worker default').model === 'opus → claude-opus-5-5' && task('named by the dispatch').model === 'haiku → claude-haiku-4-5-20251001' && task('left to the CLI').model === 'default → gpt-5.6-sol' && task('an older entry').model === 'opus' && task('asked for a full id').model === 'claude-opus-5-5', s.tasks.map((t) => [t.title, t.model]));
        check(`${where}: …and says where the model came from, in words (the cell's tooltip and the details)`, /default of the worker account/.test(task('ran on the worker default').tip) && /reported that it ran claude-opus-5-5/.test(task('ran on the worker default').tip) && /named by the dispatch/.test(task('named by the dispatch').tip) && /CLI used its own default/.test(task('left to the CLI').tip) && task('an older entry').tip === 'opus' &&
          detailOf(task('ran on the worker default'), 'Model source') === 'worker default' && detailOf(task('named by the dispatch'), 'Model source') === 'named by the dispatch' && detailOf(task('left to the CLI'), 'Model source') === 'CLI default' && detailOf(task('an older entry'), 'Model source') === undefined &&
          detailOf(task('ran on the worker default'), 'Model that ran') === 'claude-opus-5-5' && detailOf(task('asked for a full id'), 'Model that ran') === 'claude-opus-5-5' && detailOf(task('an older entry'), 'Model that ran') === undefined, s.tasks.map((t) => [t.title, t.tip, t.detail]));
        check(`${where}: a task whose record names no model ("-") is never said to have "asked for -": the source sentence stands alone`, task('no model on record, worker default').tip === 'The default of the worker account was used.' && task('no model on record, dispatch').tip === 'The model was named by the dispatch.' && s.tasks.every((t) => !/[Aa]sked for [-\u2014]/.test(String(t.tip))) && detailOf(task('no model on record, worker default'), 'Model source') === 'worker default', s.tasks.map((t) => [t.title, t.model, t.tip]));
        // The outdated policy: the chip, and the row in the settings drawer.
        const chip = s.chips.find((c) => c.text === 'Update the dispatch policy');
        check(`${where}: an outdated policy block has its chip, which says why`, chip !== undefined && chip.title === "The dispatch policy block in CLAUDE.md is not this version's text: it is from another version of the extension, or was changed." && !s.chips.some((c) => c.text === 'Add the dispatch policy'), s.chips);
        const before = s.posted.length;
        await browser.evaluate(`Array.from(document.querySelectorAll('.health .chip-btn')).find((c) => c.textContent.trim() === 'Update the dispatch policy').click(), new Promise((r) => setTimeout(r, 150))`);
        let after = await browser.evaluate(PAGE_AUDIT);
        // Contract §15.7 (wave 11): the outdated-policy chip opens Update Workspace Setup (EXPECTATION-CHANGES §10).
        check(`${where}: …and a click on it sends the command message (Update Workspace Setup)`, same(after.posted.slice(before).filter((m) => m.type === 'command'), [{ type: 'command', id: 'updateWorkspaceSetup' }]), after.posted.slice(before));
        await browser.evaluate(`document.querySelector('.btn-settings').click(), new Promise((r) => setTimeout(r, 500))`);
        after = await browser.evaluate(PAGE_AUDIT);
        const row = after.setup.find((r) => r.label === 'Dispatch policy') ?? {};
        check(`${where}: the setup row says the block differs and offers "Update Dispatch Policy" as its main action`, row.state === 'stale' && row.word === 'Differs from this version' && row.button === 'Update Dispatch Policy' && row.primary === true && after.setup.find((r) => r.label === 'Dispatch server')?.state === 'done', after.setup);
        const n = after.posted.length;
        await browser.evaluate(`Array.from(document.querySelectorAll('.setup-row')).find((r) => r.querySelector('.setup-label').textContent.trim() === 'Dispatch policy').querySelector('button').click(), new Promise((r) => setTimeout(r, 150))`);
        after = await browser.evaluate(PAGE_AUDIT);
        check(`${where}: …which sends the same command message`, same(after.posted.slice(n).filter((m) => m.type === 'command'), [{ type: 'command', id: 'addDispatchPolicy' }]) && after.overflow.scrollWidth <= after.overflow.innerWidth, [after.posted.slice(n), after.overflow]);
      }
    }
    // A current block: no chip, and the row says "Installed".
    const current = JSON.parse(JSON.stringify(model));
    current.health.policyOutdated = false;
    await browser.open(`file://${path.join(media, 'preview.html')}?fixture=empty&theme=dark&bar=0&drawer=1`, 1400, 900);
    await browser.evaluate(`window.postMessage(${JSON.stringify({ type: 'model', model: current })}, '*'), new Promise((r) => setTimeout(r, 700))`);
    let s = await browser.evaluate(PAGE_AUDIT);
    check('a current block: no policy chip at all, and the setup row says "Installed"', !s.chips.some((c) => /dispatch policy/i.test(c.text)) && s.setup.find((r) => r.label === 'Dispatch policy')?.state === 'done' && s.setup.find((r) => r.label === 'Dispatch policy')?.word === 'Installed', [s.chips, s.setup]);
    // A model of a host that sends none of the new fields, and one that sends hostile ones.
    const bare = JSON.parse(JSON.stringify(model));
    delete bare.health.policyOutdated;
    for (const acct of bare.accounts) delete acct.modelRanAs;
    for (const task of bare.tasks) { delete task.modelUsed; delete task.modelSource; }
    bare.tasks[0].modelUsed = '<img src=x onerror="window.__CCO_XSS__=1">';
    bare.tasks[0].modelSource = '__proto__';
    bare.tasks[1].modelUsed = 42;
    bare.tasks[1].modelSource = { toString: null };
    bare.accounts[1].modelRanAs = ['x'];
    bare.accounts[2].modelRanAs = '<b>bold</b>‮';
    await browser.open(`file://${path.join(media, 'preview.html')}?fixture=empty&theme=dark&bar=0`, 1400, 900);
    await browser.evaluate(`window.postMessage(${JSON.stringify({ type: 'model', model: bare })}, '*'), new Promise((r) => setTimeout(r, 500))`);
    s = await browser.evaluate(PAGE_AUDIT);
    check('fields that are absent, or hostile (markup, a number, an object, "__proto__"): the page renders them as text or not at all, and executes nothing', s.mounted && !s.xss && s.foreign.length === 0 && browser.events.length === 0 && s.summary === EXPECTED_SUMMARY && !s.chips.some((c) => /Update the dispatch policy/.test(c.text)) && s.tasks.length === bare.tasks.length, { xss: s.xss, events: browser.events.slice(0, 3), summary: s.summary, models: s.tasks.map((t) => t.model) });
  } finally {
    await browser.close();
  }
  finish(h);
}

/* ========================================================================= *
 * W1 / P2 — the window names of a Cursor reading: three bare words
 *           (`total`, `auto`, `api`), each a share of the billing period
 * ========================================================================= */

/**
 * A Cursor account whose status came back with the three windows the adapter reports, through
 * the same recording a real status takes (usage.recordProviderStatus). Each one ends with the
 * billing period; `api` is past the warning mark. Returns the reset's ISO time.
 */
function cursorWindowsFixture(h) {
  const usage = h.req('usage.js');
  writeRegistry(h, [{ name: 'w1', model: 'opus' }], [{ name: 'cur', provider: 'cursor', model: 'auto' }]);
  const resetAt = new Date(Date.now() + 11 * 86_400_000 + 4 * 3_600_000).toISOString();
  usage.recordProviderStatus({ name: 'cur', configDir: dirOf(h, 'cur') }, {
    cliFound: true,
    loggedIn: true,
    mode: 'cursor',
    quota: { allowed: true, windows: [{ label: 'total', usedPercent: 58, resetAt }, { label: 'auto', usedPercent: 41, resetAt }, { label: 'api', usedPercent: 88, resetAt }] },
    error: null,
  });
  return resetAt;
}
const CURSOR_WINDOW_NAMES = ['Total usage', 'Auto + Composer', 'API usage'];

async function w1WindowNames() {
  const h = boot({});
  const views = h.req('views.js');
  const wm = h.req('workerManager.js');
  const usage = h.req('usage.js');
  cursorWindowsFixture(h);
  const stored = (usage.getCachedWorkerUsage({ name: 'cur', configDir: dirOf(h, 'cur'), provider: 'cursor' }) ?? {}).windows ?? [];
  check('the reading is stored as the adapter reported it: three windows labelled total / auto / api', same(stored.map((w) => [w.label, w.percent]), [['total', 58], ['auto', 41], ['api', 88]]), stored);
  const wp = new views.WorkersProvider(new wm.WorkerManager());
  const node = wp.getChildren().find((n) => n.name === 'cur');
  const row = node ? wp.getTreeItem(node) : {};
  const kids = node ? wp.getChildren(node).map((n) => wp.getTreeItem(n)) : [];
  const usageRows = kids.filter((k) => /^Usage · /.test(String(k.label)));
  check(
    'the Workers tree row of the Cursor account says "Total usage 58% · Auto + Composer 41% · ⚠API usage 88%" — no bare word',
    /Total usage 58% · Auto \+ Composer 41% · ⚠API usage 88%/.test(String(row.description)) && !/\b(total|auto|api) \d/.test(String(row.description)),
    row.description,
  );
  check(
    'expanded, its usage rows are "Usage · Total usage" / "Usage · Auto + Composer" / "Usage · API usage", and each hover names the window the same way',
    same(usageRows.map((k) => k.label), CURSOR_WINDOW_NAMES.map((n) => `Usage · ${n}`)) &&
      usageRows.every((k, i) => String(k.tooltip).startsWith(`Usage as reported for this Cursor account — ${CURSOR_WINDOW_NAMES[i]}: `)),
    usageRows.map((k) => [k.label, k.tooltip]),
  );
  check('the two bare words of a Codex reading still read "Primary limit" / "Secondary limit", and any other label is kept', views.vendorWindowLabel(' PRIMARY ') === 'Primary limit' && views.vendorWindowLabel('secondary') === 'Secondary limit' && views.vendorWindowLabel(' Auto ') === 'Auto + Composer' && views.vendorWindowLabel('Weekly limit') === 'Weekly limit' && views.vendorWindowLabel('totals') === 'totals', [views.vendorWindowLabel(' Auto '), views.vendorWindowLabel('totals')]);
  finish(h);
}

async function p2WindowNames() {
  let startChrome;
  try {
    ({ startChrome } = require('./shell-b-page.cjs'));
  } catch (e) {
    check('the page driver of shell-b-page.cjs loads', false, String(e));
    process.exit(0);
  }
  // Started through startChrome only, and only when it passes --use-mock-keychain (see P1).
  if (!fs.readFileSync(require.resolve('./shell-b-page.cjs'), 'utf8').includes("'--use-mock-keychain'")) {
    check('the browser driver starts Chrome with --use-mock-keychain (no browser was started, and no page check ran)', false, 'startChrome of shell-b-page.cjs does not pass the flag');
    process.exit(0);
  }
  const h = boot({});
  const usage = h.req('usage.js');
  cursorWindowsFixture(h);
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  await activate(h, 700);
  const d = await openDashboard(h);
  const model = d.model();
  const acct = (model.accounts ?? []).find((a) => a.name === 'cur');
  check('the host hands the page the three windows with the labels the adapter reported', acct !== undefined && same(acct.windows.map((w) => w.label), ['total', 'auto', 'api']), acct && acct.windows);
  const media = path.join(h.scratch, 'media');
  fs.cpSync(MEDIA, media, { recursive: true });
  const table = h.req('dashboard.js').dashboardStrings();
  const fixturesFile = path.join(media, 'fixtures.js');
  const fixtures = fs.readFileSync(fixturesFile, 'utf8');
  const a = fixtures.indexOf('/* <strings:begin> */');
  const b = fixtures.indexOf('/* <strings:end> */');
  fs.writeFileSync(fixturesFile, fixtures.slice(0, a) + stringBlock(table) + fixtures.slice(b + '/* <strings:end> */'.length));
  let browser;
  try {
    browser = await startChrome(h.scratch);
  } catch (e) {
    check('headless Chrome starts', false, String(e && e.message));
    return finish(h);
  }
  if (!browser) {
    console.log(`SKIP ${CASE}: headless Chrome not found — the page checks did not run (set CHROME_BIN to a Chromium-family browser)`);
    return finish(h);
  }
  try {
    await browser.open(`file://${path.join(media, 'preview.html')}?fixture=empty&theme=dark&bar=0`, 1400, 900);
    await browser.evaluate(`window.postMessage(${JSON.stringify({ type: 'model', model })}, '*'), new Promise((r) => setTimeout(r, 450))`);
    const card = await browser.evaluate(`(() => {
      const c = Array.from(document.querySelectorAll('.acct')).find((el) => (el.querySelector('.acct-name') || {}).textContent === 'cur');
      if (!c) return null;
      return {
        labels: Array.from(c.querySelectorAll('.meter-label')).map((el) => el.textContent.trim()),
        aria: Array.from(c.querySelectorAll('.meter-track')).map((el) => el.getAttribute('aria-label')),
        text: c.textContent,
      };
    })()`);
    check(
      'the page card of the Cursor account names its meters "Total usage" / "Auto + Composer" / "API usage" (and so do the meters\' accessible labels) — no bare word',
      card !== null && same(card.labels, CURSOR_WINDOW_NAMES) && card.aria.length === 3 && card.aria.every((l, i) => String(l).startsWith(`${CURSOR_WINDOW_NAMES[i]} · `)) && !/\b(total|auto|api)\b/.test(card.labels.join(' ')) && browser.events.length === 0,
      { card: card && { labels: card.labels, aria: card.aria }, events: browser.events.slice(0, 3) },
    );
  } finally {
    await browser.close();
  }
  finish(h);
}

/* ========================================================================= *
 * A1–A4 / P3 — what each account's own CLI says: its model menu and who it
 *              is signed in as (the `initialize` answer of the usage probe)
 * ========================================================================= */

/** The `/model` menu of a Claude Code 2.1.299 account, as its `initialize` answer lists it. */
const CLAUDE_MENU = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', displayName: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'fable', displayName: 'Fable 5.1', description: 'Fable 5.1 · Most capable, for the hardest tasks' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Sonnet 5.5 · Fast and capable for everyday tasks' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Haiku 5.5 · Fastest for quick answers' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Haiku 4.5 · An earlier fast model' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'claude-opus-5', displayName: 'Opus 5' },
  { value: 'claude-fable-5', displayName: 'Fable 5' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
];
/** Invented: no real address appears in a fixture of this file. */
const INVENTED_EMAIL = 'pat.example@example.test';
const INVENTED_ACCOUNT = { email: INVENTED_EMAIL, organization: 'Example Org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
/** The key contract 14.1 defines, computed here on its own. */
const keyOf = (email, org) => require('crypto').createHash('sha256').update(`${email.trim().toLowerCase()}\n${org}`, 'utf8').digest('hex').slice(0, 16);
/** The cache's form of a menu (what the probe stores): value, label, description when given. */
const cachedMenu = (menu) => menu.map((m) => (m.description ? { value: m.value, label: m.displayName, description: m.description } : { value: m.value, label: m.displayName }));

/**
 * A `claude` of this case that speaks the control channel as Claude Code 2.1.299 does: one
 * stream-json session per probe, a `control_response` per `control_request` naming its
 * `request_id` — `initialize` answered with `{ commands, agents, …, models, account }` at once,
 * `get_usage` with the usage data 40 ms later (it asks the network) — and it leaves when its
 * stdin ends. What it does is read from `<CLAUDE_CONFIG_DIR>/fake-behaviour.json`:
 * `init` / `usage`: "answer" | "error" | "silent", `initDelayMs` / `usageDelayMs`, the `models`
 * and `account` to answer, and `legacy` (a CLI of before: one answer without a request id, at
 * once, then gone). Every start and every request is logged.
 */
function writeControlFake(h) {
  const log = path.join(h.scratch, 'fake-claude.log');
  const file = path.join(h.fakebin, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const LOG = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
const say = (o) => fs.appendFileSync(LOG, JSON.stringify(Object.assign({}, o, { dir, pid: process.pid, t: Date.now() })) + '\\n');
let b = {};
try { b = JSON.parse(fs.readFileSync(path.join(dir, 'fake-behaviour.json'), 'utf8')); } catch (e) { /* the defaults */ }
say({ ev: 'start', args });
setTimeout(() => process.exit(99), 15000).unref();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') {
  out({ loggedIn: true, authMethod: 'claude.ai' });
  setTimeout(() => process.exit(0), 20);
} else if (args.includes('stream-json') && b.legacy) {
  out({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } });
  setTimeout(() => process.exit(0), 30);
} else if (args.includes('stream-json')) {
  out({ type: 'system', subtype: 'init' });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (!msg || msg.type !== 'control_request' || !msg.request) continue;
      const sub = msg.request.subtype;
      const id = msg.request_id;
      say({ ev: 'request', subtype: sub, id });
      if (sub === 'initialize') {
        const how = b.init || 'answer';
        if (how === 'silent') continue;
        setTimeout(() => out({ type: 'control_response', response: how === 'error'
          ? { subtype: 'error', request_id: id, error: 'Unsupported control request subtype: initialize' }
          : { subtype: 'success', request_id: id, response: { commands: [], agents: [], output_style: 'default', models: b.models, account: b.account, pid: process.pid, claude_code_version: '2.1.299' } } }), b.initDelayMs || 0);
      } else if (sub === 'get_usage') {
        const how = b.usage || 'answer';
        if (how === 'silent') continue;
        setTimeout(() => out({ type: 'control_response', response: how === 'error'
          ? { subtype: 'error', request_id: id, error: 'usage unavailable' }
          : { subtype: 'success', request_id: id, response: { rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 12, resets_at: '2099-01-01T00:00:00Z' }, seven_day: { utilization: 34, resets_at: '2099-01-02T00:00:00Z' } }, session: { total_cost_usd: 0 } } } }), b.usageDelayMs === undefined ? 40 : b.usageDelayMs);
      }
    }
  });
  process.stdin.on('end', () => { say({ ev: 'stdin-end' }); setTimeout(() => process.exit(0), 30); });
} else {
  process.exit(1);
}
`);
  fs.chmodSync(file, 0o755);
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const behave = (dir, b) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fake-behaviour.json'), JSON.stringify(b));
  };
  return { file, events, behave };
}

/** The registry of these cases, written whole: Claude Code workers, the fake `claude`'s path. */
function writeRegistryFile(h, claude, vendor = [], extra = {}) {
  const registry = h.req('registry.js');
  for (const w of [...claude, ...vendor]) fs.mkdirSync(dirOf(h, w.name), { recursive: true });
  fs.mkdirSync(h.root, { recursive: true });
  fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify({
    claudePath: path.join(h.fakebin, 'claude'),
    workers: claude.map((w) => ({ name: w.name, configDir: dirOf(h, w.name), model: w.model, ...(w.modelPinned ? { modelPinned: true } : {}) })),
    vendorWorkers: vendor.map((w) => ({ name: w.name, configDir: dirOf(h, w.name), model: w.model ?? '', provider: w.provider })),
    ...extra,
  }, null, 2));
  const at = new Date(Date.now() + (writeRegistry.bump = (writeRegistry.bump ?? 0) + 1000));
  fs.utimesSync(registry.REGISTRY_FILE, at, at);
}

async function a1ClaudeProbe() {
  const h = boot({});
  const usage = h.req('usage.js');
  const fake = writeControlFake(h);
  const names = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12'];
  writeRegistryFile(h, names.map((name) => ({ name, model: 'opus' })));
  if (typeof usage.resetProbeCommandMemoForTest === 'function') usage.resetProbeCommandMemoForTest();
  const d = (name) => dirOf(h, name);
  const entry = (name) => usage.readUsageCache()[d(name)];
  const refresh = (list) => usage.refreshAllUsage(list.map((name) => ({ name, configDir: d(name) })), 3, 8000);
  const canonical = { models: CLAUDE_MENU, account: INVENTED_ACCOUNT };

  // --- the answer as Claude Code gives it
  fake.behave(d('w1'), canonical);
  const t0 = Date.now();
  await refresh(['w1']);
  const e1 = entry('w1') ?? {};
  const starts = fake.events().filter((e) => e.ev === 'start' && e.dir === d('w1') && e.args.includes('stream-json'));
  const asked = fake.events().filter((e) => e.ev === 'request' && e.dir === d('w1')).map((e) => [e.subtype, e.id]);
  check('the usage probe asks BOTH in its one session: one `claude` process for the account, `get_usage` and then `initialize` on its stdin', starts.length === 1 && same(asked, [['get_usage', 'u1'], ['initialize', 'i1']]), { starts: starts.length, asked });
  check('…and the usage reading is what it always was (the 5-hour and 7-day windows, available)', e1.available === true && e1.error === undefined && Array.isArray(e1.windows) && e1.windows.length === 2 && e1.windows[0].percent === 12 && e1.windows[1].percent === 34, { available: e1.available, error: e1.error, windows: e1.windows });
  check('the account\'s `/model` menu is in its cache entry, in the CLI\'s order: value, display name as label, its line as description', same(e1.models, cachedMenu(CLAUDE_MENU)), e1.models);
  check('…with modelsFetchedAt the time of that reading', typeof e1.modelsFetchedAt === 'number' && e1.modelsFetchedAt >= t0 && e1.modelsFetchedAt <= Date.now(), e1.modelsFetchedAt);
  check('the account is filed under a 16-hex key of its address and organization, and its plan under the CLI\'s name for it', e1.accountKey === keyOf(INVENTED_EMAIL, 'Example Org') && e1.planLabel === 'Claude Max', { accountKey: e1.accountKey, planLabel: e1.planLabel });
  const cacheText = fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8');
  check('the address itself is nowhere in the cache file (not the address, not its domain, in any case)', !/example\.test|pat\.example/i.test(cacheText) && !cacheText.includes(INVENTED_EMAIL), cacheText.slice(0, 200));

  // --- a hostile menu
  const hostile = [
    { value: '__proto__', displayName: 'proto' },
    { value: 'constructor', displayName: 'ctor' },
    { value: 'Opus', displayName: 'Capitalised' },
    { value: 'opus[1m]x', displayName: 'Not a model' },
    { value: 'opus', displayName: '$(sync~spin) Opus 5.5' },
    { value: 'claude-big', displayName: 'x'.repeat(10_000), description: `line one\nline two ${'y'.repeat(10_000)}` },
    { value: 'opus', displayName: 'a second opus' },
    ...Array.from({ length: 600 }, (_, i) => ({ value: `claude-test-${i}`, displayName: `Test ${i}` })),
  ];
  fake.behave(d('w2'), { models: hostile, account: INVENTED_ACCOUNT });
  await refresh(['w2']);
  const e2 = entry('w2') ?? {};
  const m2 = Array.isArray(e2.models) ? e2.models : [];
  check('a menu of 600 entries keeps 64; `__proto__`, `constructor`, a capitalised or ill-formed value are refused; each value once', m2.length === 64 && !m2.some((m) => ['__proto__', 'constructor', 'Opus', 'opus[1m]x'].includes(m.value)) && new Set(m2.map((m) => m.value)).size === 64 && m2[0].value === 'opus' && m2[1].value === 'claude-big', { n: m2.length, first: m2.slice(0, 3).map((m) => m.value) });
  check('…a 10 kB display name is cut to 60, a 10 kB description to 120, both one line; an icon in a name is kept as text (the pickers make it inert)', m2[1] && m2[1].label.length <= 60 && m2[1].description.length <= 120 && !/[\r\n]/.test(m2[1].description) && m2[0].label === '$(sync~spin) Opus 5.5', m2.slice(0, 2));

  // --- one claude.ai account, two directories: the same key, whatever the spelling
  fake.behave(d('w3'), { models: CLAUDE_MENU, account: { ...INVENTED_ACCOUNT, email: '  PAT.Example@EXAMPLE.test ' } });
  fake.behave(d('w4'), { models: CLAUDE_MENU, account: { ...INVENTED_ACCOUNT, organization: 'Other Org' } });
  fake.behave(d('w5'), { models: CLAUDE_MENU, account: { ...INVENTED_ACCOUNT, organization: { id: 'org-7', name: 'Example Org' } } });
  await refresh(['w3', 'w4', 'w5']);
  check('an address that differs only in case and spaces is the same account (the same key)', entry('w3')?.accountKey === e1.accountKey, [entry('w3')?.accountKey, e1.accountKey]);
  check('…another organization is another account; an organization object is keyed by its id', entry('w4')?.accountKey === keyOf(INVENTED_EMAIL, 'Other Org') && entry('w4')?.accountKey !== e1.accountKey && entry('w5')?.accountKey === keyOf(INVENTED_EMAIL, 'org-7'), [entry('w4')?.accountKey, entry('w5')?.accountKey]);

  // --- an answer without an address: no key (and an earlier one goes); the plan still shown
  fake.behave(d('w6'), { models: CLAUDE_MENU, account: { organization: 'Example Org', subscriptionType: 'Claude Pro' } });
  await refresh(['w6']);
  check('an account object without an address makes no key; its plan is still kept', entry('w6') !== undefined && entry('w6').accountKey === undefined && entry('w6').planLabel === 'Claude Pro', entry('w6'));
  fake.behave(d('w3'), { models: CLAUDE_MENU, account: { subscriptionType: 'Claude Max' } });
  await refresh(['w3']);
  check('…and an account that answers again without one loses the key it had', entry('w3')?.accountKey === undefined && entry('w3')?.planLabel === 'Claude Max', entry('w3'));

  // --- a CLI that does not know `initialize`: the reading as before, the fields as they were, no wait
  fake.behave(d('w7'), canonical);
  await refresh(['w7']);
  fake.behave(d('w7'), { init: 'error' });
  let t = Date.now();
  let r = await usage.fetchAccountUsage('w7', d('w7'), 8000);
  const errTook = Date.now() - t;
  await refresh(['w7']);
  check('`initialize` answered with an error: the reading is whole and nothing waits for more (the error IS the answer)', r.error === undefined && r.available === true && errTook < 700, { error: r.error, took: errTook });
  check('…and the menu, key and plan the account had are kept as they were', same(entry('w7')?.models, cachedMenu(CLAUDE_MENU)) && entry('w7')?.accountKey === e1.accountKey && entry('w7')?.planLabel === 'Claude Max', entry('w7'));

  fake.behave(d('w8'), canonical);
  await refresh(['w8']);
  fake.behave(d('w8'), { init: 'silent' });
  t = Date.now();
  r = await usage.fetchAccountUsage('w8', d('w8'), 8000);
  const silentTook = Date.now() - t;
  await refresh(['w8']);
  check(`\`initialize\` never answered: the reading waits for it at most ${usage.INIT_ANSWER_WAIT_MS} ms, then is whole — and the fields stay as they were`, r.error === undefined && r.available === true && silentTook < 2500 && same(entry('w8')?.models, cachedMenu(CLAUDE_MENU)) && entry('w8')?.accountKey === e1.accountKey, { took: silentTook, error: r.error, models: (entry('w8')?.models ?? []).length });

  // --- `initialize` answered later than the reading: waited for, its own time and no more
  fake.behave(d('w9'), { ...canonical, initDelayMs: 340, usageDelayMs: 20 });
  t = Date.now();
  r = await usage.fetchAccountUsage('w9', d('w9'), 8000);
  const lateTook = Date.now() - t;
  check('`initialize` answered 340 ms after start (the reading at 20 ms): the reading carries what it said, and took that long, not more', r.error === undefined && same(r.models, cachedMenu(CLAUDE_MENU)) && r.accountKey === e1.accountKey && lateTook >= 330 && lateTook < 1300, { took: lateTook, models: (r.models ?? []).length });

  // --- `get_usage` fails, `initialize` answered: the reading fails as before, the facts are kept
  fake.behave(d('w10'), { ...canonical, usage: 'error' });
  r = await usage.fetchAccountUsage('w10', d('w10'), 8000);
  await refresh(['w10']);
  check('`get_usage` answered with an error after `initialize`: the reading is the error it always was — and the menu, key and plan are recorded', r.error === 'control_response error' && same(entry('w10')?.models, cachedMenu(CLAUDE_MENU)) && entry('w10')?.accountKey === e1.accountKey && entry('w10')?.error === 'control_response error', { error: r.error, cached: entry('w10') && { error: entry('w10').error, models: (entry('w10').models ?? []).length, key: entry('w10').accountKey } });

  // --- a CLI (or a stand-in) of before: one answer that names no request, then gone
  fake.behave(d('w11'), { legacy: true });
  t = Date.now();
  r = await usage.fetchAccountUsage('w11', d('w11'), 8000);
  check('an answer that names no request id is the reading\'s, as before; the child leaving ends the wait for `initialize`', r.error === undefined && r.available === false && r.models === undefined && Date.now() - t < 1500, { error: r.error, available: r.available, took: Date.now() - t });

  // --- an answer with no menu: the menu as it was, the account as answered
  fake.behave(d('w12'), canonical);
  await refresh(['w12']);
  fake.behave(d('w12'), { account: { ...INVENTED_ACCOUNT, subscriptionType: 'Claude Pro' } });
  await refresh(['w12']);
  check('an answer without `models` leaves the menu as it was, and takes the account (plan) it did name', same(entry('w12')?.models, cachedMenu(CLAUDE_MENU)) && entry('w12')?.planLabel === 'Claude Pro', entry('w12'));
  finish(h);
}

async function a2ClaudeMenu() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  writeControlFake(h);
  writeRegistryFile(h, [
    { name: 'w1', model: 'opus' },
    { name: 'w2', model: 'claude-opus-4-7', modelPinned: true },
    { name: 'w3', model: 'claude-opus-4-1', modelPinned: true },
    { name: 'w4', model: 'sonnet' },
  ]);
  const menu = cachedMenu(CLAUDE_MENU).map((m) => (m.value === 'haiku' ? { ...m, label: '$(sync~spin) Haiku 5.5' } : m));
  const reading = (name) => ({ name, configDir: dirOf(h, name), available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now(), models: menu, modelsFetchedAt: Date.now() });
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({ [dirOf(h, 'w1')]: reading('w1'), [dirOf(h, 'w2')]: reading('w2'), [dirOf(h, 'w3')]: reading('w3'), [dirOf(h, 'w4')]: { ...reading('w4'), models: undefined } }));
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  await activate(h, 700);
  const rawEntry = (name) => {
    try {
      return JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8')).workers.find((w) => w.name === name);
    } catch {
      return undefined;
    }
  };
  const run = async (name, pickWith) => {
    h.log.messages.length = 0; h.log.quickPicks.length = 0;
    h.answers.quickPick = pickWith ?? (() => undefined);
    const r = await exec(h, 'setWorkerModel', { name });
    await sleep(30);
    return { ...r, items: h.log.quickPicks[0]?.items ?? [], options: h.log.quickPicks[0]?.options ?? {} };
  };
  const ENTER = 'Enter a model id…';
  const FRONTIER = 'frontier tier, which the frontier guard blocks: while it does, dispatches that name no model will skip an account whose default this is';

  let r = await run('w1');
  const item = (label) => r.items.find((i) => i.label === label) ?? {};
  check('with the account\'s own menu: its aliases first (in its order), then its pinned models by their display names, then "Enter a model id…" — and `default` is no item', same(r.items.map((i) => i.label), ['opus', 'fable', 'sonnet', 'haiku', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6', ENTER]) && !r.items.some((i) => i.model === 'default'), r.items.map((i) => i.label));
  check('…an alias says what the CLI means by it now, and its own line; the current one is marked', item('opus').description === 'Opus 5.5 · current' && item('opus').detail === 'Opus 5.5 · Best for everyday, complex tasks' && item('sonnet').description === 'Sonnet 5.5' && item('opus').model === 'opus', [item('opus'), item('sonnet')]);
  check('…a pinned model is listed by its name with its id beside it', item('Opus 4.8').description === 'claude-opus-4-8' && item('Opus 4.8').model === 'claude-opus-4-8' && item('Haiku 4.5').detail === 'Haiku 4.5 · An earlier fast model' && item('Sonnet 5').detail === undefined, [item('Opus 4.8'), item('Haiku 4.5'), item('Sonnet 5')]);
  check('…what the CLI recommends is the title: "This account\'s CLI recommends: Opus 5.5"', r.options.title === "This account's CLI recommends: Opus 5.5" && r.options.matchOnDescription === true, r.options);
  check('…a name in which the CLI wrote `$(…)` opens no icon', item('haiku').description === '$ (sync~spin) Haiku 5.5' && r.items.every((i) => ![i.label, i.description, i.detail].some((x) => typeof x === 'string' && x.includes('$('))), item('haiku'));
  check('…while the frontier guard blocks, the frontier items say what that means for this account', item('fable').detail === `Fable 5.1 · Most capable, for the hardest tasks · ${FRONTIER}` && String(item('Fable 5').detail).endsWith(FRONTIER), [item('fable').detail, item('Fable 5').detail]);

  r = await run('w1', (list) => list.find((i) => i.label === 'Opus 4.8'));
  check('choosing a pinned model stores the id itself with `modelPinned: true`, and says it is pinned', rawEntry('w1')?.model === 'claude-opus-4-8' && rawEntry('w1')?.modelPinned === true && h.log.messages.some((m) => String(m.message) === '"w1" now defaults to claude-opus-4-8 for dispatches that name no model — pinned: the CLI runs exactly this model, whatever is newest.'), [rawEntry('w1'), brief(h)]);
  check('…and the registry reads it back exactly — the tier id is that model, not its tier', registry.readRegistry().workers.find((w) => w.name === 'w1')?.model === 'claude-opus-4-8' && buildModel(h).accounts.find((a) => a.name === 'w1')?.defaultModel === 'claude-opus-4-8', [registry.readRegistry().workers.find((w) => w.name === 'w1'), buildModel(h).accounts.find((a) => a.name === 'w1')?.defaultModel]);
  r = await run('w1', (list) => list.find((i) => i.label === 'sonnet'));
  check('choosing an alias stores the alias and takes `modelPinned` away', rawEntry('w1')?.model === 'sonnet' && !('modelPinned' in (rawEntry('w1') ?? {})), rawEntry('w1'));

  r = await run('w2');
  check('a stored pinned model the menu holds is its item, marked current, once', r.items.find((i) => i.model === 'claude-opus-4-7')?.description === 'claude-opus-4-7 · current' && r.items.filter((i) => i.model === 'claude-opus-4-7').length === 1 && r.items[0].label === 'opus', r.items.slice(0, 3).map((i) => [i.label, i.description]));
  r = await run('w3');
  check('a stored pinned model the menu does NOT hold is kept: first, marked current, said to be unlisted — never swapped for another', r.items[0]?.label === 'claude-opus-4-1' && r.items[0]?.description === 'current' && r.items[0]?.detail === 'Stored for this worker; the CLI did not list it.' && r.items[0]?.model === 'claude-opus-4-1', r.items[0]);
  r = await run('w4');
  check('no menu cached for the account: today\'s four aliases, no title', same(r.items.map((i) => i.label), ['opus', 'sonnet', 'haiku', 'fable', ENTER]) && r.options.title === undefined, [r.items.map((i) => i.label), r.options.title]);

  // The dashboard's "set model" with a value: taken exactly, as from the picker.
  const d = await openDashboard(h);
  const w4 = d.model().accounts.find((a) => a.name === 'w4');
  h.log.messages.length = 0;
  await d.send({ type: 'account', action: 'setModel', account: w4.key, value: 'claude-sonnet-5' }, 300);
  check('a full id chosen on the dashboard is pinned as itself', rawEntry('w4')?.model === 'claude-sonnet-5' && rawEntry('w4')?.modelPinned === true && buildModel(h).accounts.find((a) => a.name === 'w4')?.defaultModel === 'claude-sonnet-5', [rawEntry('w4'), brief(h)]);
  finish(h);
}

async function a3CodexModels() {
  const h = boot({});
  const registry = h.req('registry.js');
  const usage = h.req('usage.js');
  const helper = writeHelper(h);
  const baseAbs = h.context.asAbsolutePath;
  h.context.asAbsolutePath = (p) => (/provider-cli\.js$/.test(p) ? helper.file : baseAbs(p));
  writeRegistry(h, [{ name: 'w1', model: 'opus' }], [{ name: 'cx', provider: 'codex', model: 'gpt-5.6-sol' }]);
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({ [dirOf(h, 'cx')]: { name: 'cx', available: false, auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: Date.now() }, windows: [], fetchedAt: Date.now() } }));
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
  await activate(h, 700);
  // What the helper prints for `codex app-server`'s `model/list` (W10-SERVER's catalog shape).
  helper.answer({
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', default: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-astra', label: '$(sync~spin) GPT-6 Astra', efforts: ['medium', '$(bad)', 'x'.repeat(40)] },
      { id: 'gpt-5.6-sol' },
    ],
    source: 'live',
    error: null,
  });
  const before = h.log.pickers.length;
  const done = exec(h, 'setWorkerModel', { name: 'cx' });
  await until(() => h.log.pickers.length > before, 3000, 5);
  const qp = h.log.pickers[before];
  if (qp === undefined) {
    check('the Codex picker opens', false, brief(h));
    return finish(h);
  }
  await until(() => qp.busy === false, 8000, 20);
  const rows = qp.items.map((i) => [i.label, i.description ?? null, i.detail ?? null]);
  check('the Codex picker lists the CLI\'s models by their display names, the id beside each, the default marked, the reasoning efforts under it', same(rows.slice(0, 3), [
    ['gpt-5.6-sol', 'current', null],
    ['GPT-6.1 Sol', "gpt-6.1-sol · the CLI's default", 'Reasoning efforts: low, medium, high, xhigh'],
    ['$ (sync~spin) GPT-6 Astra', 'gpt-6-astra', 'Reasoning efforts: medium'],
  ]) && qp.title === 'Models the `codex` CLI lists for this account', rows);
  check('…what is kept of the listing: the default flag and the efforts, an effort that is not a word left out', same(usage.cachedProviderModels('codex', dirOf(h, 'cx'))?.models, [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', resold: false, default: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-6-astra', label: '$(sync~spin) GPT-6 Astra', resold: false, efforts: ['medium'] },
    { id: 'gpt-5.6-sol', label: null, resold: false },
  ]), usage.cachedProviderModels('codex', dirOf(h, 'cx'))?.models);
  qp._accept(qp.items.find((i) => i.label === 'GPT-6.1 Sol'));
  await done;
  await sleep(30);
  check('…and picking one by its name stores its id', registry.readRegistry().vendorWorkers?.find?.((w) => w.name === 'cx')?.model === 'gpt-6.1-sol' || registry.readRegistry().workers.find((w) => w.name === 'cx')?.model === 'gpt-6.1-sol', registry.readRegistry().workers.map((w) => [w.name, w.model]));
  finish(h);
}

/** A cache of readings for A4 / P3: main and w1 one claude.ai account, w2 and w3 another, w4 alone. */
function sameAccountFixture(h) {
  const usage = h.req('usage.js');
  writeRegistryFile(h, [{ name: 'w1', model: 'opus' }, { name: 'w2', model: 'sonnet' }, { name: 'w3', model: 'sonnet' }, { name: 'w4', model: 'haiku' }, { name: 'w5', model: 'opus' }]);
  const K1 = keyOf(INVENTED_EMAIL, 'Example Org');
  const K2 = keyOf('lee.example@example.test', '');
  const reading = (name, dir, extra) => ({ name, configDir: dir, available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now(), ...extra });
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({
    [path.join(h.home, '.claude')]: reading('main', path.join(h.home, '.claude'), { accountKey: K1, planLabel: 'Claude Max' }),
    [dirOf(h, 'w1')]: reading('w1', dirOf(h, 'w1'), { accountKey: K1, planLabel: 'Claude Max' }),
    [dirOf(h, 'w2')]: reading('w2', dirOf(h, 'w2'), { accountKey: K2 }),
    [dirOf(h, 'w3')]: reading('w3', dirOf(h, 'w3'), { accountKey: K2 }),
    [dirOf(h, 'w4')]: reading('w4', dirOf(h, 'w4'), { accountKey: keyOf('sam.example@example.test', '') }),
    // A hand-edited key that is not 16 hex characters is no key.
    [dirOf(h, 'w5')]: reading('w5', dirOf(h, 'w5'), { accountKey: 'NOT-A-KEY' }),
  }));
  usage.refreshAllUsageIfStale = async () => {};
  usage.refreshAllUsage = async () => {};
  usage.refreshProviderUsage = () => Promise.resolve();
}

async function a4SameAccount() {
  const h = boot({});
  const views = h.req('views.js');
  const wm = h.req('workerManager.js');
  sameAccountFixture(h);
  const m = buildModel(h);
  const acct = (name) => m.accounts.find((a) => a.name === name) ?? {};
  check('the page model says which accounts are one claude.ai account — the session\'s own "main" included — and only those', same(acct('main').sameAccountAs, ['w1']) && same(acct('w1').sameAccountAs, ['main']) && same(acct('w2').sameAccountAs, ['w3']) && same(acct('w3').sameAccountAs, ['w2']) && same(acct('w4').sameAccountAs, []) && same(acct('w5').sameAccountAs, []), m.accounts.map((a) => [a.name, a.sameAccountAs]));
  check('…and the plan as the CLI names it, where it did', acct('main').planLabel === 'Claude Max' && acct('w1').planLabel === 'Claude Max' && acct('w2').planLabel === null, m.accounts.map((a) => [a.name, a.planLabel]));
  const wp = new views.WorkersProvider(new wm.WorkerManager());
  const row = (name) => {
    const node = wp.getChildren().find((n) => n.name === name);
    return node ? wp.getTreeItem(node) : {};
  };
  const tip = (name) => shown(row(name).tooltip);
  check('the Workers tree row says so: "same claude.ai account as main" on w1, "… as w3" on w2, nothing on w4', /· same claude\.ai account as main( ·|$)/.test(String(row('w1').description)) && /· same claude\.ai account as w3( ·|$)/.test(String(row('w2').description)) && !/same claude\.ai account/.test(String(row('w4').description)) && !/same claude\.ai account/.test(String(row('w5').description)), [row('w1').description, row('w2').description, row('w4').description]);
  check('…and its hover in a sentence: "Same claude.ai account as main — one plan\'s limits for both."', tip('w1').includes("Same claude.ai account as main — one plan's limits for both.") && !tip('w4').includes('Same claude.ai account'), [tip('w1').slice(0, 160)]);
  // A third directory on the same account: "for all of them".
  const usage = h.req('usage.js');
  const cache = JSON.parse(fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8'));
  cache[dirOf(h, 'w4')].accountKey = cache[dirOf(h, 'w2')].accountKey;
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify(cache));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(usage.USAGE_CACHE_FILE, later, later);
  const wp2 = new views.WorkersProvider(new wm.WorkerManager());
  const node2 = wp2.getChildren().find((n) => n.name === 'w2');
  const tip2 = node2 ? shown(wp2.getTreeItem(node2).tooltip) : '';
  check('three directories on one account: "Same claude.ai account as w3, w4 — one plan\'s limits for all of them."', tip2.includes("Same claude.ai account as w3, w4 — one plan's limits for all of them.") && same(buildModel(h).accounts.find((a) => a.name === 'w2')?.sameAccountAs, ['w3', 'w4']), [tip2.slice(0, 200), buildModel(h).accounts.find((a) => a.name === 'w2')?.sameAccountAs]);
  finish(h);
}

async function p3SameAccount() {
  let startChrome;
  try {
    ({ startChrome } = require('./shell-b-page.cjs'));
  } catch (e) {
    check('the page driver of shell-b-page.cjs loads', false, String(e));
    process.exit(0);
  }
  // Started through startChrome only, and only when it passes --use-mock-keychain (see P1).
  if (!fs.readFileSync(require.resolve('./shell-b-page.cjs'), 'utf8').includes("'--use-mock-keychain'")) {
    check('the browser driver starts Chrome with --use-mock-keychain (no browser was started, and no page check ran)', false, 'startChrome of shell-b-page.cjs does not pass the flag');
    process.exit(0);
  }
  const h = boot({});
  sameAccountFixture(h);
  await activate(h, 700);
  const d = await openDashboard(h);
  const model = d.model();
  const media = path.join(h.scratch, 'media');
  fs.cpSync(MEDIA, media, { recursive: true });
  const table = h.req('dashboard.js').dashboardStrings();
  const fixturesFile = path.join(media, 'fixtures.js');
  const fixtures = fs.readFileSync(fixturesFile, 'utf8');
  const a = fixtures.indexOf('/* <strings:begin> */');
  const b = fixtures.indexOf('/* <strings:end> */');
  fs.writeFileSync(fixturesFile, fixtures.slice(0, a) + stringBlock(table) + fixtures.slice(b + '/* <strings:end> */'.length));
  let browser;
  try {
    browser = await startChrome(h.scratch);
  } catch (e) {
    check('headless Chrome starts', false, String(e && e.message));
    return finish(h);
  }
  if (!browser) {
    console.log(`SKIP ${CASE}: headless Chrome not found — the page checks did not run (set CHROME_BIN to a Chromium-family browser)`);
    return finish(h);
  }
  try {
    for (const width of [1400, 480]) {
      await browser.open(`file://${path.join(media, 'preview.html')}?fixture=empty&theme=dark&bar=0`, width, 900);
      await browser.evaluate(`window.postMessage(${JSON.stringify({ type: 'model', model })}, '*'), new Promise((r) => setTimeout(r, 450))`);
      const s = await browser.evaluate(`(() => {
        const card = (name) => Array.from(document.querySelectorAll('.acct')).find((el) => (el.querySelector('.acct-name') || {}).textContent === name);
        const line = (name) => { const c = card(name); const p = c && c.querySelector('.acct-same'); return p && !p.hidden ? p.textContent.trim() : null; };
        const plan = (name) => { const c = card(name); const p = c && c.querySelector('.plan'); return p && !p.hidden ? p.textContent.trim() : null; };
        const notices = Array.from(document.querySelectorAll('.banners .callout')).filter((el) => !el.hidden && getComputedStyle(el).display !== 'none').map((el) => el.textContent.trim());
        return { main: line('main'), w1: line('w1'), w2: line('w2'), w4: line('w4'), planMain: plan('main'), notices, overflow: document.documentElement.scrollWidth <= window.innerWidth };
      })()`);
      check(`${width}px: each card of one claude.ai account says so — "Same claude.ai account as w1 — one plan's limits for both" on main, "… as main …" on w1; none on an account of its own`, s.main === "Same claude.ai account as w1 — one plan's limits for both" && s.w1 === "Same claude.ai account as main — one plan's limits for both" && s.w2 === "Same claude.ai account as w3 — one plan's limits for both" && s.w4 === null, s);
      check(`${width}px: ONE notice for all of them, naming each group`, s.notices.filter((n) => n.includes('one claude.ai account')).length === 1 && s.notices.some((n) => n.includes('Some accounts here are one claude.ai account') && n.includes('Signed in to the same claude.ai account: main, w1 · w2, w3.') && n.includes('automatic dispatch is not changed by it')), s.notices);
      check(`${width}px: the plan badge says the CLI's name for the plan; no console error; no horizontal overflow`, s.planMain === 'Claude Max' && s.overflow && browser.events.length === 0, [s.planMain, s.overflow, browser.events.slice(0, 3)]);
    }
  } finally {
    await browser.close();
  }
  finish(h);
}

const RUN = {
  'I1-index-model': i1IndexModel,
  'I2-index-memory': i2IndexMemory,
  'U1-catalog': u1Catalog,
  'K1-claude-picker': k1ClaudePicker,
  'K2-vendor-picker': k2VendorPicker,
  'V1-views': v1Views,
  'C1-policy-command': c1PolicyCommand,
  'M1-rewrites': m1Rewrites,
  'Q1-quick-picks': q1QuickPicks,
  'H1-dashboard-host': h1DashboardHost,
  'X1-two-readers': x1TwoReaders,
  'T1-cancel-race': t1CancelRace,
  'T2-cancel-command': t2CancelCommand,
  'P1-page': p1Page,
  'W1-window-names': w1WindowNames,
  'P2-window-names': p2WindowNames,
  'A1-claude-probe': a1ClaudeProbe,
  'A2-claude-menu': a2ClaudeMenu,
  'A3-codex-models': a3CodexModels,
  'A4-same-account': a4SameAccount,
  'P3-same-account': p3SameAccount,
};
if (!RUN[CASE]) {
  console.log(`FAIL ${CASE}: no such case`);
  process.exit(1);
}
RUN[CASE]().catch((e) => {
  console.log(`FAIL ${CASE}: the case threw — ${String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')}`);
  process.exit(1);
});
