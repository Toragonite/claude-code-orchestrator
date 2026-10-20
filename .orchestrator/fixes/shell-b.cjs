// SHELL-B (2.0 fix wave 5): the command layer and the two pages — unsupported registry entries,
// refusals of the shared registry, task output by id, the settings module, an empty .mcp.json,
// the dashboard page's notices and settings pipeline, and the Asset Manager page.
//
//   node .orchestrator/fixes/shell-b.cjs [outDir] [--media <dir>] [--only U1,L,...] [--jobs N]
//
// Loads the COMPILED extension-host modules from `outDir` (default: <repo>/out) against the
// `vscode` stand-in in shell-b-stub.cjs (shell-a-stub.cjs plus a few recorders). Every case runs
// in a child process of its own with HOME / USERPROFILE redirected to a fresh temp directory
// before any module loads, PATH cut down to a directory of fake CLIs, and a guard that reroutes
// any agent CLI to its fake. No real claude / codex / cursor-agent / agy is started and no real
// ~/.claude* is touched. `--media` names the directory holding the dashboard page
// (preview.html, fixtures.js, dashboard.js, dashboard.css; default <repo>/media/dashboard).
//
// The host cases run up to `--jobs` at a time (default 3: several of them sit out the
// registry lock's 15-second wait behind a helper process). The page case runs alone, in a
// private headless Chrome; without one it fails with a line that says so.
// Prints `PASS <name>` / `FAIL <name> — <why>` and a tally; exit 0 only when everything passed.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-shell-b', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const OUT = path.resolve(positional[0] ?? path.join(REPO, 'out'));
const MEDIA = path.resolve(flag('--media') ?? path.join(REPO, 'media', 'dashboard'));

/* ------------------------------------------------------------------------- *
 * Parent: one child per case
 * ------------------------------------------------------------------------- */

const HOST_CASES = [
  'U1-remove-unsupported',
  'U2-names-realpath',
  'R1-unreadable-activation-sync',
  'R1-unreadable-activation-quiet',
  'R2-unreadable-every-command',
  'R3-unreadable-worker-writes',
  'R4-unreadable-dashboard',
  'L1-lock-activation',
  'L2-lock-add',
  'L3-lock-remove',
  'L4-lock-set-model',
  'L5-lock-toggle-preferred',
  'L6-lock-dashboard-setting',
  'T1-task-output',
  'M1-mcp-empty',
  'S1-settings-module',
  'D1-dashboard-messages',
  'A1-asset-html',
  'A2-asset-messages',
];
const PAGE_CASES = ['P1-page'];
const CASES = [...HOST_CASES, ...PAGE_CASES];

if (flag('--case') === undefined) {
  const only = flag('--only');
  // `--only U1,L`: a whole case name, or a prefix of one.
  const wanted = only === undefined ? CASES : CASES.filter((c) => only.split(',').some((sel) => c === sel || c.startsWith(sel)));
  const jobs = Math.max(1, Math.min(4, Number(flag('--jobs') ?? 3) || 3));
  const tally = { pass: 0, fail: 0 };
  console.log(`shell-b: build under test = ${OUT}`);
  console.log(`shell-b: dashboard page   = ${MEDIA}`);

  const runCase = (name) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, OUT, '--media', MEDIA, '--case', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = out.split('\n').filter((l) => l.startsWith('PASS ') || l.startsWith('FAIL '));
        for (const line of lines) {
          console.log(line);
          if (line.startsWith('PASS ')) tally.pass++;
          else tally.fail++;
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
    console.log(`\nshell-b: ${tally.pass} passed, ${tally.fail} failed`);
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
    return text.length > 900 ? `${text.slice(0, 900)}…` : text;
  } catch {
    return String(v);
  }
};
function check(name, ok, observed) {
  console.log(ok ? `PASS ${CASE}: ${name}` : `FAIL ${CASE}: ${name} — ${show(observed)}`);
}

const S = 'claudeCodeOrchestrator';
const P = `${S}.`;
const full = (obj, section = S) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${section}.${k}`, v]));

function boot(opts = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-sb-')));
  const home = path.join(scratch, 'home');
  const ws = opts.noWorkspace ? undefined : path.join(scratch, 'ws');
  if (ws) fs.mkdirSync(ws, { recursive: true });
  const h = install({ repo: REPO, out: OUT, home, ...opts, workspace: ws });
  h.scratch = scratch;
  h.ws = ws;
  fs.mkdirSync(path.join(h.root, 'tasks'), { recursive: true });
  return h;
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
const said = (h, re) => h.log.messages.filter((m) => re.test(String(m.message)));
const levelOf = (h, level) => h.log.messages.filter((m) => m.level === level && !m.modal);
const brief = (h) => h.log.messages.map((m) => [m.level, m.modal ? 'modal' : '', String(m.message).slice(0, 150), m.items]);
function finish(h) {
  check('no unhandled rejection or uncaught exception', h.log.rejections.length === 0, h.log.rejections.slice(0, 2));
  try { h.dispose(); } catch { /* best effort */ }
  try { fs.rmSync(h.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
/** Open the dashboard, send `ready`, return the panel and the first model. */
async function openDashboard(h) {
  await h.vscode.commands.executeCommand(`${P}openDashboard`);
  const panel = h.log.panels.find((p) => p.viewType === 'ccOrchestratorDashboard');
  panel._recv.fire({ type: 'ready' });
  for (let i = 0; i < 40 && !panel.posted.some((p) => p.type === 'model'); i++) await sleep(100);
  const send = async (msg, wait = 80) => { panel._recv.fire(msg); await sleep(wait); };
  const model = () => panel.posted.filter((p) => p.type === 'model').pop()?.model;
  return { panel, model, send };
}

/* ---- the registry these cases start from ---- */

/** A registry with usable Claude and vendor workers and four entries this version cannot use. */
function seedObject(h) {
  return {
    workers: [
      { name: 'w1', configDir: path.join(h.home, '.claude-w1'), model: 'opus' },
      { name: 'w2', configDir: path.join(h.home, '.claude-w2'), model: 'sonnet', preferred: true },
      // same name as an earlier usable entry: kept, unusable (duplicate-name)
      { name: 'w1', configDir: path.join(h.home, '.claude-w1-second'), model: 'opus', note: 'second w1' },
      // no account directory: unusable (shape)
      { name: 'broken', model: 'opus' },
      // not an entry at all: unusable, nameless
      42,
    ],
    vendorWorkers: [
      { name: 'cx', configDir: path.join(h.home, '.codex-cx'), model: '', provider: 'codex' },
      // a provider this version does not know: unusable (provider)
      { name: 'oc', configDir: '~/.opencode', provider: 'opencode', model: 'big-pickle', permissionMode: 'full-auto', extra: { keep: [1, 2, 3] } },
    ],
    custom: { keep: true, list: [1, 'two'] },
  };
}
function seed(h, mutate) {
  const obj = seedObject(h);
  if (mutate) mutate(obj);
  for (const dir of ['.claude-w1', '.claude-w2', '.codex-cx']) fs.mkdirSync(path.join(h.home, dir), { recursive: true });
  fs.mkdirSync(h.root, { recursive: true });
  fs.writeFileSync(h.registryFile, JSON.stringify(obj, null, 2));
  return obj;
}
const bytes = (h) => (fs.existsSync(h.registryFile) ? fs.readFileSync(h.registryFile).toString('base64') : 'absent');
/** The registry as text that does not parse: its last brace gets a comma in front of it. */
const damaged = (text) => text.replace(/\}\s*$/, ',\n}');
const REFUSAL_UNREADABLE = /Could not read .*registry\.json: .*nothing was changed/;
const REFUSAL_LOCK = /^Could not lock /;

/** The state a removal must leave alone: usable workers, unsupported entries, every other key. */
function registryState(h) {
  const registry = h.req('registry.js');
  const r = registry.readRegistry();
  const file = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  const rest = Object.fromEntries(Object.entries(file).filter(([k]) => k !== 'workers' && k !== 'vendorWorkers'));
  return {
    workers: JSON.parse(JSON.stringify(r.workers)),
    unsupported: r.unsupportedWorkers.map((e) => ({ name: e.name, reason: e.reason, raw: JSON.parse(JSON.stringify(e.raw)) })),
    rest,
  };
}
const unsupportedNode = (h, name) => {
  const list = h.req('registry.js').readRegistry().unsupportedWorkers;
  // The duplicate-name entry shares its name with a usable worker; among the unsupported ones a name is unique here.
  return { kind: 'unsupportedWorker', index: list.findIndex((e) => e.name === name), name };
};

/* ---- U1: remove an entry this version cannot use ---- */

async function u1RemoveUnsupported() {
  const h = boot({});
  seed(h);
  await activate(h, 700);
  const run = async (arg, answer) => {
    h.log.messages.length = 0;
    h.answers.message = answer ?? (() => undefined);
    const r = await exec(h, 'removeUnsupportedEntry', arg);
    await sleep(40);
    h.answers.message = () => undefined;
    return { threw: r.threw, modals: h.log.messages.filter((m) => m.modal), plain: h.log.messages.filter((m) => !m.modal) };
  };
  const names = h.req('registry.js').readRegistry().unsupportedWorkers.map((e) => `${e.name}:${e.reason}`);
  check('the registry reads four unusable entries: oc (provider), w1 (duplicate-name), broken (shape) and a nameless one', names.length === 4 && ['oc:provider', 'w1:duplicate-name', 'broken:shape', ':shape'].every((n) => names.includes(n)), names);

  // Cancel, and dismiss: nothing is removed.
  let before = bytes(h);
  let r = await run(unsupportedNode(h, 'oc'), () => undefined);
  const modal = r.modals[0];
  check('the command asks first, in ONE modal', r.threw === '' && r.modals.length === 1, [r.threw, brief(h)]);
  check('the modal names the entry', modal && /"oc"/.test(String(modal.message)), modal && modal.message);
  check('…says why this version cannot use it (the provider it names)', modal && /cannot use/.test(String(modal.detail)) && /opencode/.test(String(modal.detail)), modal && modal.detail);
  check('…says it is deleted from the registry every editor on this machine shares, and that a newer version may have written it', modal && /shared by every editor on this machine/.test(String(modal.detail)) && /newer version/.test(String(modal.detail)), modal && modal.detail);
  check('…and its one action is a specific label, not "OK"', modal && JSON.stringify(modal.items) === JSON.stringify(['Remove Entry']), modal && modal.items);
  check('dismissed: the registry file is byte-identical and nothing is said', bytes(h) === before && r.plain.length === 0, brief(h));
  r = await run(unsupportedNode(h, 'oc'), () => 'Cancel');
  check('an answer that is not the confirm label: byte-identical', bytes(h) === before && r.modals.length === 1, brief(h));

  // Arguments that are not a row of the tree: nothing happens, quietly.
  const big = 'n'.repeat(10 * 1024 * 1024);
  const hostile = [undefined, null, 'oc', 42, true, [], [0, 'oc'], {}, { index: -1, name: 'oc' }, { index: 1.5, name: 'oc' }, { index: '0', name: 'oc' }, { index: NaN, name: 'oc' }, { index: Infinity, name: 'oc' }, { index: 0 }, { name: 'oc' }, { index: 0, name: 7 }, { index: 0, name: null }, { index: 0, name: big }, { kind: 'unsupportedWorker', index: 2 ** 53, name: big }];
  let quiet = true;
  const noisy = [];
  for (const arg of hostile) {
    r = await run(arg, () => 'Remove Entry');
    // A well-shaped argument that matches nothing is SAID (below); every other one is silent.
    const wellShaped = arg && typeof arg === 'object' && !Array.isArray(arg) && Number.isInteger(arg.index) && arg.index >= 0 && typeof arg.name === 'string' && arg.name.length <= 1024 * 1024;
    if (r.threw !== '' || r.modals.length !== 0 || (!wellShaped && r.plain.length !== 0)) {
      quiet = false;
      noisy.push([show(arg).slice(0, 60), r.threw, brief(h)]);
    }
  }
  check(`${hostile.length} hostile arguments (null, a string, negative / fractional / text / NaN indexes, a missing field, a 10 MB name): no dialog, nothing thrown, nothing said`, quiet, noisy.slice(0, 3));
  check('…and the registry file is byte-identical', bytes(h) === before, 'changed');

  // A row that no longer matches the registry.
  r = await run({ kind: 'unsupportedWorker', index: 99, name: 'oc' }, () => 'Remove Entry');
  check('a wrong index: no dialog, "the registry changed — refresh and try again", byte-identical', r.modals.length === 0 && r.plain.length === 1 && /registry changed — refresh and try again/.test(String(r.plain[0].message)) && bytes(h) === before, brief(h));
  const ocIndex = unsupportedNode(h, 'oc').index;
  r = await run({ kind: 'unsupportedWorker', index: ocIndex, name: 'somebody-else' }, () => 'Remove Entry');
  check('the right index with another name: no dialog, the same sentence, byte-identical', r.modals.length === 0 && r.plain.length === 1 && /registry changed — refresh and try again/.test(String(r.plain[0].message)) && bytes(h) === before, brief(h));

  // The registry changes while the dialog is open: another editor takes the entry in front of ours away.
  const goodText = fs.readFileSync(h.registryFile, 'utf8');
  let rewritten = '';
  r = await run(unsupportedNode(h, 'oc'), (rec) => {
    if (!rec.modal) return undefined;
    const file = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
    // Dropping the nameless and the incomplete entry shifts every position in the unsupported list.
    file.workers = file.workers.filter((w) => !(typeof w !== 'object' || w === null || w.name === 'broken'));
    file.vendorWorkers = [file.vendorWorkers.find((w) => w.name === 'oc'), ...file.vendorWorkers.filter((w) => w.name !== 'oc')];
    rewritten = JSON.stringify(file, null, 2);
    fs.writeFileSync(h.registryFile, rewritten);
    return 'Remove Entry';
  });
  const nowAtIndex = h.req('registry.js').readRegistry().unsupportedWorkers[ocIndex];
  if (nowAtIndex === undefined || nowAtIndex.name !== 'oc') {
    check('the registry changed between the question and the confirm: nothing is removed, and the file is the other editor\'s, byte for byte', r.threw === '' && r.modals.length === 1 && r.plain.length === 1 && /registry changed — refresh and try again/.test(String(r.plain[0].message)) && fs.readFileSync(h.registryFile, 'utf8') === rewritten, [r.threw, brief(h)]);
  } else {
    check('the registry changed between the question and the confirm (the fixture did not move the entry — fix the test)', false, h.req('registry.js').readRegistry().unsupportedWorkers.map((e) => e.name));
  }
  fs.writeFileSync(h.registryFile, goodText);

  // The usable worker that shares a name with an unusable entry is not what that row removes — or what any worker command finds.
  h.log.messages.length = 0;
  h.answers.message = () => undefined;
  await exec(h, 'removeWorker', unsupportedNode(h, 'w1'));
  await sleep(30);
  check('"Remove Worker" handed the row of the duplicate-name entry does not offer to remove the worker of that name', h.log.messages.length === 0, brief(h));

  // Confirmed.
  const state0 = registryState(h);
  r = await run(unsupportedNode(h, 'oc'), () => 'Remove Entry');
  let state1 = registryState(h);
  check('confirmed: the entry is gone and the removal is said', r.threw === '' && !state1.unsupported.some((e) => e.name === 'oc') && r.plain.length === 1 && r.plain[0].level === 'info' && /"oc"/.test(String(r.plain[0].message)), [r.threw, brief(h), state1.unsupported.map((e) => e.name)]);
  check('…every other unusable entry is deep-equal to before', JSON.stringify(state1.unsupported) === JSON.stringify(state0.unsupported.filter((e) => e.name !== 'oc')), [state1.unsupported, state0.unsupported]);
  check('…every usable worker is deep-equal to before', JSON.stringify(state1.workers) === JSON.stringify(state0.workers), [state1.workers, state0.workers]);
  check('…and so is every other key of the file', JSON.stringify(state1.rest) === JSON.stringify(state0.rest), [state1.rest, state0.rest]);

  r = await run(unsupportedNode(h, 'w1'), () => 'Remove Entry');
  let state2 = registryState(h);
  check('the duplicate-name entry is removed, the usable worker of that name stays', !state2.unsupported.some((e) => e.name === 'w1') && state2.workers.filter((w) => w.name === 'w1').length === 1 && JSON.stringify(state2.workers) === JSON.stringify(state0.workers) && /earlier entry|already has this name/.test(String(r.modals[0]?.detail)), [state2, r.modals[0]?.detail]);

  r = await run(unsupportedNode(h, ''), () => 'Remove Entry');
  state2 = registryState(h);
  check('the nameless entry: the question says it has no name, and it is removed', r.modals.length === 1 && /no name/.test(String(r.modals[0].message)) && !state2.unsupported.some((e) => e.name === '') && state2.unsupported.length === 1 && state2.unsupported[0].name === 'broken', [r.modals[0]?.message, state2.unsupported]);
  check('…with the usable workers and the other keys still as they were', JSON.stringify(state2.workers) === JSON.stringify(state0.workers) && JSON.stringify(state2.rest) === JSON.stringify(state0.rest), state2);

  // The manager on its own.
  const wm = h.req('workerManager.js');
  const mgr = new wm.WorkerManager();
  before = bytes(h);
  const thrown = [];
  for (const [index, name] of [[0, 'not-broken'], [5, 'broken'], [-1, 'broken'], [0.5, 'broken'], ['0', 'broken'], [0, undefined]]) {
    try { mgr.removeUnsupportedWorker(index, name); thrown.push('no throw'); } catch (e) { thrown.push(String(e.message)); }
  }
  check('WorkerManager.removeUnsupportedWorker refuses a position / name that does not match, and changes nothing', typeof mgr.removeUnsupportedWorker === 'function' && thrown.every((t) => /registry changed — refresh and try again/.test(t)) && bytes(h) === before, thrown);
  finish(h);
}

/* ---- U2: names an unusable entry holds, and directories that are one directory ---- */

async function u2NamesRealpath() {
  const h = boot({});
  seed(h);
  await activate(h, 700);
  const wm = h.req('workerManager.js');
  const mgr = new wm.WorkerManager();
  const registry = h.req('registry.js');
  const tryAdd = (...args) => { try { mgr.add(...args); return ''; } catch (e) { return String(e.message); } };
  const workerNames = () => registry.readRegistry().workers.map((w) => w.name);

  // Add: the manager.
  let before = bytes(h);
  let message = tryAdd('oc', 'opus');
  check('WorkerManager.add refuses a name an unusable entry holds', /"oc"/.test(message) && /cannot use/.test(message) && bytes(h) === before, [message, workerNames()]);
  check('…and creates no directory for it', !fs.existsSync(path.join(h.home, '.claude-oc')), fs.readdirSync(h.home));
  message = tryAdd('broken', 'opus');
  check('…the same for the incomplete entry\'s name', /cannot use/.test(message) && bytes(h) === before, message);

  // Add: the command — the input box says so while typing, and the name is refused again after it.
  let validation;
  h.answers.quickPick = (list) => list.find((i) => i.info && i.info.id === 'claude') ?? list.find((i) => i.label === 'opus');
  h.answers.inputBox = (options) => { validation = options.validateInput ? options.validateInput('oc') : undefined; return 'oc'; };
  h.log.messages.length = 0;
  let r = await exec(h, 'addWorker');
  await sleep(40);
  check('Add Worker: the name box refuses the name with a sentence that says why', typeof validation === 'string' && /cannot use/.test(validation), validation);
  check('…and a name that got past the box is refused before anything is created', r.threw === '' && bytes(h) === before && said(h, /cannot use/).length === 1 && !fs.existsSync(path.join(h.home, '.claude-oc')), brief(h));

  // Rename: the box, then the registry's own refusal in its own words.
  h.answers.inputBox = (options) => { validation = options.validateInput ? options.validateInput('oc') : undefined; return 'oc'; };
  h.log.messages.length = 0;
  r = await exec(h, 'renameWorker', { name: 'w2' });
  await sleep(40);
  check('Rename Worker: the name box refuses the name', typeof validation === 'string' && /cannot use/.test(validation), validation);
  check('…and the registry refuses the rename itself, in its own words, with nothing changed', r.threw === '' && bytes(h) === before && h.log.messages.length === 1 && /already holds an entry named "oc"/.test(String(h.log.messages[0].message)), brief(h));
  let renameThrew = '';
  try { mgr.rename('w2', 'oc'); } catch (e) { renameThrew = String(e.message); }
  check('WorkerManager.rename throws the registry\'s message', /already holds an entry named "oc"/.test(renameThrew) && bytes(h) === before, renameThrew);
  h.answers.inputBox = () => undefined;
  h.answers.quickPick = () => undefined;

  // The same directory under another path.
  const w1 = path.join(h.home, '.claude-w1');
  const alias = path.join(h.home, '.claude-alias');
  fs.symlinkSync(w1, alias);
  before = bytes(h);
  message = tryAdd('alias', 'opus');
  check('a name whose derived directory is a LINK to another Claude worker\'s directory is refused', /already belongs to worker "w1"/.test(message) && bytes(h) === before, [message, workerNames()]);
  message = tryAdd('other', 'opus', alias);
  check('…and so is that link given as the directory', /already belongs to worker "w1"/.test(message) && bytes(h) === before, message);
  const linkedHome = path.join(h.scratch, 'home-link');
  fs.symlinkSync(h.home, linkedHome);
  message = tryAdd('viaparent', 'opus', path.join(linkedHome, '.claude-w1'));
  check('…and a path that reaches it through a linked parent directory', /already belongs to worker "w1"/.test(message) && bytes(h) === before, message);
  message = tryAdd('w1b', 'opus', `${w1}${path.sep}`);
  check('the lexical check still refuses another spelling of the same path', /already belongs to worker "w1"/.test(message) && bytes(h) === before, message);
  const cxAlias = path.join(h.home, '.codex-alias');
  fs.symlinkSync(path.join(h.home, '.codex-cx'), cxAlias);
  message = tryAdd('cx2', undefined, cxAlias, 'codex');
  check('the same rule for another provider: a link to a Codex worker\'s home is refused for a Codex worker', /already belongs to worker "cx"/.test(message) && bytes(h) === before, message);

  // What is NOT the same login.
  message = tryAdd('cxonclaude', undefined, alias, 'codex');
  check('a worker of ANOTHER provider on a link to that directory is not refused by this rule', message === '' && workerNames().includes('cxonclaude'), [message, workerNames()]);
  message = tryAdd('fresh', 'opus');
  check('a directory that does not exist yet aliases nothing: added, and created', message === '' && workerNames().includes('fresh') && fs.statSync(path.join(h.home, '.claude-fresh')).isDirectory(), [message, workerNames()]);
  const state = registryState(h);
  check('the unusable entries are all still in the file after those two adds', state.unsupported.length === 4 && JSON.stringify(state.rest.custom) === JSON.stringify({ keep: true, list: [1, 'two'] }), state.unsupported.map((e) => e.name));
  finish(h);
}

/* ---- R1: activation over a registry that cannot be read ---- */

async function r1UnreadableActivation(withSettingsToSync) {
  const h = boot(withSettingsToSync ? { globalSettings: full({ quotaCooldownMinutes: 60, meshMode: true }) } : {});
  const text = damaged(JSON.stringify(seedObject(h), null, 2));
  fs.mkdirSync(h.root, { recursive: true });
  fs.writeFileSync(h.registryFile, text);
  const before = bytes(h);
  h.answers.message = (rec) => (rec.items.includes('Open File') && /registry/.test(String(rec.message)) ? 'Open File' : undefined);
  const threw = await activate(h, 900);
  check('activate() returns without throwing', threw === '', threw);
  const notices = h.log.messages.filter((m) => /registry/i.test(String(m.message)));
  check('exactly ONE message about the registry, a warning', notices.length === 1 && notices[0].level === 'warning' && !notices[0].modal, brief(h));
  const message = String(notices[0]?.message ?? '');
  check('…it names the file and what is wrong with it, and says the file was not changed', message.includes(h.registryFile) && /not valid JSON/.test(message) && /not changed/.test(message), message);
  check('…it holds none of the file\'s content', !/opencode|big-pickle|claude-w1/.test(message), message);
  check('…and offers "Open File", which opens the registry file', JSON.stringify(notices[0]?.items) === JSON.stringify(['Open File']) && JSON.stringify(h.log.vscodeOpen) === JSON.stringify([h.registryFile]), [notices[0]?.items, h.log.vscodeOpen]);
  check('the registry file is byte-identical, and no lock or temp file is left beside it', bytes(h) === before && fs.readdirSync(h.root).every((f) => !/\.lock$|\.tmp$/.test(f)), fs.readdirSync(h.root));
  if (withSettingsToSync) {
    check('the refused settings sync is in the output channel, in the registry\'s own words', h.log.output.some((l) => /\[settings\] not written/.test(l) && REFUSAL_UNREADABLE.test(l)), h.log.output.filter((l) => /settings/.test(l)));
  }
  // A settings change the user makes now: said, with the refusal and the file to open.
  h.log.messages.length = 0;
  h.log.vscodeOpen.length = 0;
  h.answers.message = () => undefined;
  await sleep(10_200); // past the sync's own back-off, so the change is really attempted
  h.store.global[`${S}.quotaCooldownMinutes`] = 90;
  h.fireConfig();
  await sleep(100);
  const change = said(h, /not saved to the shared registry/);
  check('a settings change over the unreadable registry: ONE warning carrying the refusal, with "Open File"', change.length === 1 && change[0].level === 'warning' && REFUSAL_UNREADABLE.test(String(change[0].message)) && JSON.stringify(change[0].items) === JSON.stringify(['Open File']), brief(h));
  check('…and the file is still byte-identical', bytes(h) === before, 'changed');
  finish(h);
}

/* ---- R2: every command, over a registry that cannot be read ---- */

async function r2UnreadableEveryCommand() {
  const h = boot({});
  const good = JSON.stringify(seedObject(h), null, 2);
  seed(h);
  // A directory "Import Workers" can find.
  fs.mkdirSync(path.join(h.home, '.claude-imp'), { recursive: true });
  fs.writeFileSync(path.join(h.home, '.claude-imp', '.claude.json'), '{}');
  await activate(h, 700);
  fs.writeFileSync(h.registryFile, damaged(good));
  const before = bytes(h);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const ids = pkg.contributes.commands.map((c) => c.command).filter((c) => c.startsWith(P)).map((c) => c.slice(P.length));
  const registered = ids.filter((id) => h.registered.has(P + id));
  check(`every one of the ${ids.length} contributed commands is registered`, registered.length === ids.length, ids.filter((id) => !h.registered.has(P + id)));

  // 1. No argument, every dialog dismissed.
  const threw = [];
  for (const id of registered) {
    const r = await exec(h, id);
    if (r.threw) threw.push([id, r.threw]);
  }
  await sleep(300);
  check('each command run with no argument and every dialog dismissed: nothing thrown', threw.length === 0, threw.slice(0, 4));
  check('…the registry file is byte-identical', bytes(h) === before, 'changed');

  // 2. Arguments no caller should pass.
  const hostile = [null, 42, 'x', [], {}, { name: 5, id: {} }, { id: '../../etc/passwd' }, { kind: 'unsupportedWorker', index: 0, name: 'oc' }, { action: 'remove', account: '__proto__', key: 'constructor' }];
  for (const id of registered) {
    for (const arg of hostile) {
      const r = await exec(h, id, arg);
      if (r.threw) threw.push([id, show(arg).slice(0, 40), r.threw]);
    }
  }
  await sleep(300);
  check(`each command × ${hostile.length} hostile arguments: nothing thrown`, threw.length === 0, threw.slice(0, 4));
  check('…the registry file is byte-identical', bytes(h) === before, 'changed');

  // 3. Every dialog ANSWERED: first action, first item, a name.
  h.log.messages.length = 0;
  h.answers.message = (rec) => (rec.items && rec.items.length ? rec.items[0] : undefined);
  h.answers.quickPick = (list, options) => (options && options.canPickMany ? list.slice(0, 1) : list[0]);
  h.answers.inputBox = () => 'zz9';
  for (const id of registered) {
    const r = await exec(h, id);
    if (r.threw) threw.push([id, 'accepting', r.threw]);
  }
  await sleep(500);
  check('each command run with every dialog accepted: nothing thrown', threw.length === 0, threw.slice(0, 4));
  check('…the registry file is byte-identical', bytes(h) === before, 'changed');
  // TM: accepting Turn On Teammate Mode really changes a setting; with the registry unreadable its sync
  // is refused in its own words too ("The settings change was not saved to the shared registry …").
  const refusals = h.log.messages.filter((m) => REFUSAL_UNREADABLE.test(String(m.message)));
  check('the adds that got as far as the registry were refused in its own words — as warnings, each offering "Open File"', refusals.length >= 2 && refusals.every((m) => m.level === 'warning' && (String(m.message).startsWith('Could not read ') || String(m.message).startsWith('The settings change was not saved to the shared registry')) && JSON.stringify(m.items) === JSON.stringify(['Open File'])), brief(h).filter((m) => /Could not/.test(m[2])));
  check('no error-level message carries a refusal', levelOf(h, 'error').every((m) => !/Could not read|Could not lock/.test(String(m.message))), levelOf(h, 'error').map((m) => String(m.message).slice(0, 200)));
  check('Add Worker created no directory for the account it could not register', !fs.existsSync(path.join(h.home, '.claude-zz9')), fs.readdirSync(h.home));
  check('no lock or temp file is left beside the registry', fs.readdirSync(h.root).every((f) => !/registry\.json\.(lock|.*tmp)/.test(f)), fs.readdirSync(h.root));
  finish(h);
}

/* ---- R3: the registry goes bad between a command's look and its write ---- */

async function r3UnreadableWorkerWrites() {
  const h = boot({});
  seed(h);
  await activate(h, 700);
  // What activation left there (it adds the resolved settings): the good text every step starts from.
  const good = fs.readFileSync(h.registryFile, 'utf8');
  const bad = damaged(good);
  const { model } = await openDashboard(h);
  const keyOf = (name) => (model()?.accounts ?? []).find((a) => a.name === name)?.key;
  const codexModes = h.req('providers.js').providerInfo('codex').permissionModes;

  const steps = [
    ['Remove Worker', () => exec(h, 'removeWorker', { name: 'w2' }), { message: (rec) => (rec.modal ? 'Remove Account' : undefined) }],
    ['Toggle Preferred', () => exec(h, 'togglePreferred', { name: 'w1' }), {}],
    ['Set Worker Model', () => exec(h, 'setWorkerModel', { name: 'w1' }), { quickPick: (list) => list.find((i) => i.label === 'sonnet') }],
    ['Set Worker Permission Mode', () => exec(h, 'setWorkerPermissionMode', { name: 'cx' }), { quickPick: (list) => list.find((i) => i.mode === 'read-only') }],
    ['Rename Worker', () => exec(h, 'renameWorker', { name: 'w2' }), { inputBox: () => 'w7' }],
    ['Remove Registry Entry', () => exec(h, 'removeUnsupportedEntry', unsupportedNode(h, 'oc')), { message: (rec) => (rec.modal ? 'Remove Entry' : undefined) }],
    ['Add Worker (Claude Code)', () => exec(h, 'addWorker'), { quickPick: (list) => list.find((i) => i.info && i.info.id === 'claude') ?? list.find((i) => i.label === 'opus'), inputBox: () => 'w9' }],
    ['Add Worker (Codex, a login of its own)', () => exec(h, 'addWorker'), { quickPick: (list) => list.find((i) => i.info && i.info.id === 'codex') ?? list.find((i) => i.login === 'separate') ?? list.find((i) => i.store === 'file') ?? list.find((i) => i.choice === 'cli'), inputBox: () => 'cx9' }],
    ['dashboard: prefer this account', () => exec(h, 'accountAction', { action: 'togglePreferred', account: keyOf('w1') }), {}],
    ['dashboard: default model', () => exec(h, 'accountAction', { action: 'setModel', account: keyOf('w1'), value: 'sonnet' }), {}],
    ['dashboard: permission mode', () => exec(h, 'accountAction', { action: 'setPermissionMode', account: keyOf('cx'), value: 'read-only' }), {}],
    ['dashboard: remove account', () => exec(h, 'accountAction', { action: 'remove', account: keyOf('w2') }), { message: (rec) => (rec.modal ? 'Remove Account' : undefined) }],
  ];
  check('the fixture: Codex offers a read-only mode, and the dashboard model has keys for w1, w2 and cx', codexModes.includes('read-only') && [keyOf('w1'), keyOf('w2'), keyOf('cx')].every((k) => typeof k === 'string'), [codexModes, keyOf('w1'), keyOf('w2'), keyOf('cx')]);

  for (const [label, run, answers] of steps) {
    fs.writeFileSync(h.registryFile, good);
    h.log.messages.length = 0;
    h.log.vscodeOpen.length = 0;
    const firedBefore = h.log.corruptedAtWrite ?? 0;
    h.answers.message = (rec) => {
      // The refusal's own "Open File" is taken, so that what it opens can be seen.
      if (!rec.modal && rec.items.includes('Open File') && /Could not read/.test(String(rec.message))) return 'Open File';
      return answers.message ? answers.message(rec) : undefined;
    };
    h.answers.quickPick = answers.quickPick ?? (() => undefined);
    h.answers.inputBox = answers.inputBox ?? (() => undefined);
    h.corruptAtNextWrite(bad);
    const r = await run();
    await sleep(40);
    h.corruptAtNextWrite(null);
    const reached = (h.log.corruptedAtWrite ?? 0) === firedBefore + 1;
    const refusals = h.log.messages.filter((m) => !m.modal && REFUSAL_UNREADABLE.test(String(m.message)));
    const ok =
      r.threw === '' &&
      reached &&
      refusals.length === 1 &&
      refusals[0].level === 'warning' &&
      String(refusals[0].message).startsWith('Could not read ') &&
      JSON.stringify(refusals[0].items) === JSON.stringify(['Open File']) &&
      levelOf(h, 'error').length === 0 &&
      levelOf(h, 'info').length === 0 &&
      JSON.stringify(h.log.vscodeOpen) === JSON.stringify([h.registryFile]) &&
      fs.readFileSync(h.registryFile, 'utf8') === bad;
    check(`${label}: the write is refused — ONE warning in the registry's own words with "Open File" (which opens the registry file), no success message, nothing thrown, the file untouched`, ok, { threw: r.threw, reachedTheWrite: reached, messages: brief(h), opened: h.log.vscodeOpen, fileIsTheDamagedOne: fs.readFileSync(h.registryFile, 'utf8') === bad });
  }
  check('Add Worker created no directory for either account it could not register', !fs.existsSync(path.join(h.home, '.claude-w9')) && !fs.existsSync(path.join(h.home, '.codex-cx9')), fs.readdirSync(h.home));
  finish(h);
}

/* ---- R4: the dashboard over a registry that cannot be read ---- */

async function r4UnreadableDashboard() {
  const h = boot({});
  seed(h);
  await activate(h, 700);
  const good = fs.readFileSync(h.registryFile, 'utf8');
  const { panel, send } = await openDashboard(h);
  fs.writeFileSync(h.registryFile, damaged(good));
  const before = bytes(h);
  h.log.messages.length = 0;

  await send({ type: 'setSetting', key: 'quotaCooldownMinutes', value: 77 }, 300);
  const result = panel.posted.filter((p) => p.type === 'settingResult').pop();
  check('setSetting: the page is answered ok:false with the refusal in the registry\'s own words', result && result.ok === false && REFUSAL_UNREADABLE.test(String(result.error)), result);
  const warned = said(h, /Could not read/);
  check('…the editor shows ONE warning carrying the refusal, with "Open File"', warned.length === 1 && warned[0].level === 'warning' && JSON.stringify(warned[0].items) === JSON.stringify(['Open File']), brief(h));
  check('…and the registry file is byte-identical', bytes(h) === before, 'changed');

  // "Open File" from the page: the host decides which file.
  h.log.vscodeOpen.length = 0;
  await sleep(1100);
  for (let i = 0; i < 200; i++) panel._recv.fire({ type: 'openRegistryFile' });
  await sleep(200);
  check('200 × openRegistryFile in one tick: the registry file is opened once', JSON.stringify(h.log.vscodeOpen) === JSON.stringify([h.registryFile]), h.log.vscodeOpen.length);
  await sleep(1100);
  h.log.vscodeOpen.length = 0;
  await send({ type: 'openRegistryFile', path: '/etc/hosts', file: '/etc/hosts', uri: 'file:///etc/hosts', id: '../../etc/hosts' }, 150);
  check('a message that names a file of its own: the registry file is what opens', JSON.stringify(h.log.vscodeOpen) === JSON.stringify([h.registryFile]) && h.log.opened.every((o) => !/etc\/hosts/.test(JSON.stringify(o))), [h.log.vscodeOpen, h.log.opened]);
  fs.writeFileSync(h.registryFile, good);
  await sleep(1100);
  h.log.vscodeOpen.length = 0;
  await send({ type: 'openRegistryFile' }, 150);
  check('once the registry is readable again, the message opens nothing', h.log.vscodeOpen.length === 0, h.log.vscodeOpen);
  finish(h);
}

/* ---- L: the registry's lock is held by another live process ---- */

async function holdRegistryLock(h) {
  const ready = path.join(h.scratch, `lock-ready-${Date.now()}`);
  const release = path.join(h.scratch, `lock-release-${Date.now()}`);
  const child = spawn(process.execPath, [path.join(__dirname, 'shell-b-hold.cjs'), OUT, ready, release, '60000'], {
    env: { ...process.env, HOME: h.home, USERPROFILE: h.home, NODE_OPTIONS: require('./keychain-guard.cjs').nodeOptionsWith('') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await sleep(50);
  if (!fs.existsSync(ready)) {
    child.kill('SIGKILL');
    throw new Error('the lock holder did not take the lock');
  }
  return {
    pid: child.pid,
    release: async () => {
      fs.writeFileSync(release, '1');
      await new Promise((resolve) => { child.on('close', resolve); setTimeout(resolve, 3000); });
    },
  };
}

async function lockCase(which) {
  const settings = which === 'activation' ? full({ quotaCooldownMinutes: 60 }) : {};
  const h = boot({ globalSettings: settings });
  seed(h);
  let holder;
  let threw = '';
  let startedAt;
  let before;
  let dashboard;
  if (which === 'activation') {
    before = bytes(h);
    holder = await holdRegistryLock(h);
    startedAt = Date.now();
    threw = await activate(h, 300);
  } else {
    await activate(h, 700);
    if (which === 'dashboard-setting') dashboard = await openDashboard(h);
    before = bytes(h);
    holder = await holdRegistryLock(h);
    h.log.messages.length = 0;
    startedAt = Date.now();
    const pickClaude = (list) => list.find((i) => i.info && i.info.id === 'claude') ?? list.find((i) => i.label === 'opus');
    if (which === 'add') {
      h.answers.quickPick = pickClaude;
      h.answers.inputBox = () => 'w9';
      threw = (await exec(h, 'addWorker')).threw;
    } else if (which === 'remove') {
      h.answers.message = (rec) => (rec.modal ? 'Remove Account' : undefined);
      threw = (await exec(h, 'removeWorker', { name: 'w2' })).threw;
    } else if (which === 'set-model') {
      h.answers.quickPick = (list) => list.find((i) => i.label === 'sonnet');
      threw = (await exec(h, 'setWorkerModel', { name: 'w1' })).threw;
    } else if (which === 'toggle-preferred') {
      threw = (await exec(h, 'togglePreferred', { name: 'w1' })).threw;
    } else if (which === 'dashboard-setting') {
      dashboard.panel._recv.fire({ type: 'setSetting', key: 'quotaCooldownMinutes', value: 77 });
      for (let i = 0; i < 400 && !dashboard.panel.posted.some((p) => p.type === 'settingResult'); i++) await sleep(50);
    }
    await sleep(100);
  }
  const waited = Date.now() - startedAt;
  const lockStillHeld = (() => { try { return fs.lstatSync(h.registryLock) !== undefined; } catch { return false; } })();
  check('nothing was thrown', threw === '', threw);
  check('the command waited out the lock (about 15 s) while the helper process held it', waited >= 13_000 && waited < 60_000 && lockStillHeld, { waitedMs: waited, lockStillHeld });
  const refusals = h.log.messages.filter((m) => !m.modal && /Could not lock /.test(String(m.message)));
  if (which === 'dashboard-setting') {
    const result = dashboard.panel.posted.filter((p) => p.type === 'settingResult').pop();
    check('the page is answered ok:false with the lock\'s own message', result && result.ok === false && /Could not lock /.test(String(result.error)), result);
    check('the editor shows ONE warning carrying the lock\'s message, without "Open File" (the file itself is fine)', refusals.length === 1 && refusals[0].level === 'warning' && refusals[0].items.length === 0, brief(h));
  } else if (which === 'activation') {
    check('ONE warning carries the lock\'s own message — it names the registry file — and offers no "Open File"', refusals.length === 1 && refusals[0].level === 'warning' && String(refusals[0].message).includes('registry.json') && refusals[0].items.length === 0, brief(h));
    check('the output channel has the refusal too', h.log.output.some((l) => /\[settings\] not written/.test(l) && /Could not lock /.test(l)), h.log.output.filter((l) => /settings/.test(l)));
  } else {
    check('ONE warning, the lock\'s own message as it stands, no "Open File", and no success or error message beside it', refusals.length === 1 && refusals[0].level === 'warning' && REFUSAL_LOCK.test(String(refusals[0].message)) && refusals[0].items.length === 0 && levelOf(h, 'error').length === 0 && levelOf(h, 'info').length === 0, brief(h));
  }
  check('the registry file is byte-identical', bytes(h) === before, 'changed');
  if (which === 'add') check('no directory was created for the account that was not registered', !fs.existsSync(path.join(h.home, '.claude-w9')), fs.readdirSync(h.home));
  await holder.release();
  finish(h);
}

/* ---- T1: a task's output is opened by id ---- */

async function t1TaskOutput() {
  const h = boot({});
  await activate(h, 500);
  const tasks = path.join(h.root, 'tasks');
  const outside = path.join(h.scratch, 'outside-secret.md');
  fs.writeFileSync(outside, '# not a task report\n');
  fs.writeFileSync(path.join(tasks, 'tgood0001.md'), '# report\n');
  fs.writeFileSync(path.join(tasks, 'With_Under-score9.md'), '# report 2\n');
  fs.symlinkSync(outside, path.join(tasks, 'tlinked01.md'));
  fs.mkdirSync(path.join(tasks, 'tdir00001.md'));
  fs.writeFileSync(path.join(tasks, 'tprompt01.prompt.txt'), 'prompt only');
  const run = async (command, arg) => {
    h.log.messages.length = 0;
    h.log.opened.length = 0;
    h.log.shown.length = 0;
    h.log.status.length = 0;
    const r = await exec(h, command, arg);
    await sleep(20);
    return { threw: r.threw, opened: h.log.opened.filter((o) => o.opened !== undefined).map((o) => o.opened), shown: h.log.shown.slice(), messages: h.log.messages.slice() };
  };
  const good = path.join(tasks, 'tgood0001.md');
  for (const command of ['showTaskOutput', 'openTaskOutput']) {
    let r = await run(command, 'tgood0001');
    check(`${command}: a task id whose report exists opens exactly <tasks>/<id>.md`, r.threw === '' && JSON.stringify(r.opened) === JSON.stringify([good]) && r.shown.length === 1 && r.shown[0].file === good && r.messages.length === 0, [r.threw, r.opened, r.shown, brief(h)]);
    check(`${command}: …${command === 'openTaskOutput' ? 'beside the view that asked' : 'in the active editor group'}`, command === 'openTaskOutput' ? r.shown[0]?.options?.viewColumn === h.vscode.ViewColumn.Beside : r.shown[0]?.options?.viewColumn === undefined, r.shown[0]?.options);
    r = await run(command, { id: 'With_Under-score9' });
    check(`${command}: an object carrying the id (a tree row, the dashboard's { id }) opens that task's report`, JSON.stringify(r.opened) === JSON.stringify([path.join(tasks, 'With_Under-score9.md')]), [r.opened, brief(h)]);

    const nothing = [
      ['an id without a report', 'tabsent01'],
      ['an id that only has a prompt file', 'tprompt01'],
      ['the PATH of an existing report (what a row passed before)', good],
      ['the path of a file outside the data directory', outside],
      ['/etc/hosts', '/etc/hosts'],
      ['../x', '../x'],
      ['an id with a traversal inside', 'tgood0001/../tgood0001'],
      ['the id with its extension', 'tgood0001.md'],
      ['an id whose report is a symbolic link', 'tlinked01'],
      ['an id whose report is a directory', 'tdir00001'],
      ['the empty string', ''],
      ['a 10 MB string', 'a'.repeat(10 * 1024 * 1024)],
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an array', ['tgood0001']],
      ['an empty object', {}],
      ['{ id: 42 }', { id: 42 }],
      ['{ id: <a path> }', { id: good }],
      ['{ outputFile: <a path> } (a task event)', { outputFile: good, id: '../tgood0001' }],
    ];
    const wrong = [];
    for (const [label, arg] of nothing) {
      r = await run(command, arg);
      const one = r.messages.length === 1 && r.messages[0].level === 'warning' && /output of that task could not be found/.test(String(r.messages[0].message));
      if (r.threw !== '' || r.opened.length !== 0 || r.shown.length !== 0 || !one) wrong.push([label, r.threw, r.opened, r.messages.map((m) => String(m.message).slice(0, 80))]);
    }
    check(`${command}: ${nothing.length} arguments that are not the id of a task with a report (a path, ../x, a link, a directory, non-strings, 10 MB): nothing is opened, and each is told "the output of that task could not be found"`, wrong.length === 0, wrong.slice(0, 4));
  }
  finish(h);
}

/* ---- M1: an empty .mcp.json is a new file ---- */

async function m1McpEmpty() {
  const h = boot({});
  await activate(h, 500);
  const file = path.join(h.ws, '.mcp.json');
  const run = async (content) => {
    fs.rmSync(file, { recursive: true, force: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    const before = content === undefined ? undefined : fs.readFileSync(file).toString('base64');
    h.log.messages.length = 0;
    const r = await exec(h, 'installMcp');
    await sleep(20);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = undefined; }
    return { threw: r.threw, parsed, unchanged: before !== undefined && fs.readFileSync(file).toString('base64') === before, registered: said(h, /^Registered/).length, errors: levelOf(h, 'error') };
  };
  for (const [label, content] of [['an empty file', ''], ['spaces and line breaks only', '  \n\t \r\n'], ['a byte-order mark and nothing else', '﻿'], ['a byte-order mark and white space', '﻿ \n']]) {
    const r = await run(content);
    const ours = r.parsed?.mcpServers?.['cco-dispatch'];
    check(`${label}: treated as a new file — our server is written, "Registered" is said, no error`, r.threw === '' && ours && Array.isArray(ours.args) && Object.keys(r.parsed).length === 1 && Object.keys(r.parsed.mcpServers).length === 1 && r.registered === 1 && r.errors.length === 0, [r.threw, r.parsed, brief(h)]);
    check(`${label}: no temp file is left`, fs.readdirSync(h.ws).every((f) => !f.endsWith('.tmp')), fs.readdirSync(h.ws));
  }
  for (const [label, content] of [['a trailing comma', '{"mcpServers": {"a": {"command": "x"}},}'], ['a // comment', '// mine\n{}'], ['merge-conflict markers', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n'], ['[]', '[]'], ['null', 'null'], ['a word', 'servers'], ['white space around a comment', '  /* later */  '], ['a NUL byte', '\u0000'], ['{"mcpServers": []}', '{"mcpServers": []}']]) {
    const r = await run(content);
    check(`${label}: still refused — the file is unchanged, an error names it and offers "Open File", "Registered" is not said`, r.threw === '' && r.unchanged && r.registered === 0 && r.errors.length === 1 && String(r.errors[0].message).includes(file) && JSON.stringify(r.errors[0].items) === JSON.stringify(['Open File']), [r.threw, r.unchanged, brief(h)]);
  }
  finish(h);
}

/* ---- S1: the settings module ---- */

async function s1SettingsModule() {
  const h = boot({ globalSettings: full({ quotaCooldownMinutes: 55 }) });
  let settings;
  let loadError = '';
  try { settings = h.req('settings.js'); } catch (e) { loadError = String(e.message).split('\n')[0]; }
  const expected = ['CONFIG_SECTION', 'LEGACY_CONFIG_SECTION', 'LEGACY_SETTING_KEYS', 'SETTING_KEYS', 'confirmWideningSetting', 'explicitUserSetting', 'needsWideningConfirmation', 'userClaudePath', 'userSetting', 'workspaceLevelSettings'];
  check('out/settings.js exists and exports the settings helper', settings !== undefined && expected.every((k) => k in settings), loadError || (settings && expected.filter((k) => !(k in settings))));
  const packs = h.req('packSources.js');
  const own = ['resolvePackSources', 'loadedPacks'];
  const moved = ['CONFIG_SECTION', 'LEGACY_CONFIG_SECTION', 'LEGACY_SETTING_KEYS', 'SETTING_KEYS', 'confirmWideningSetting', 'needsWideningConfirmation'];
  check('out/packSources.js keeps its own two functions and no longer defines the settings table or the widening gate', own.every((k) => typeof packs[k] === 'function') && moved.every((k) => !(k in packs)), Object.keys(packs));
  check('the setting readers behave as before the move', settings && settings.userSetting('quotaCooldownMinutes') === 55 && settings.explicitUserSetting('meshMode') === undefined && settings.userSetting('claudePath') === 'claude' && settings.needsWideningConfirmation('frontierWorkerDispatch', 'allow') === true && settings.needsWideningConfirmation('frontierWorkerDispatch', 'block') === false, settings && [settings.userSetting('quotaCooldownMinutes'), settings.explicitUserSetting('meshMode')]);
  const source = fs.readFileSync(path.join(REPO, 'src', 'packSources.ts'), 'utf8');
  check('src/packSources.ts no longer contains the settings code (no `inspect(`, no `l10n.t(`)', !/\.inspect</.test(source) && !/l10n\.t\(/.test(source) && source.split('\n').length < 80, source.split('\n').length);
  finish(h);
}

/* ---- D1: dashboard messages ---- */

async function d1DashboardMessages() {
  const h = boot({});
  seed(h);
  const registry = h.req('registry.js');
  const tasks = path.join(h.root, 'tasks');
  const outside = path.join(h.scratch, 'outside-secret.md');
  fs.writeFileSync(outside, '# not a task report\n');
  fs.writeFileSync(path.join(tasks, 'tdone0001.md'), '# report\n');
  registry.appendTaskEvent({ id: 'tdone0001', ts: Date.now() - 5000, status: 'done', title: 'a finished task', worker: 'w1', model: 'opus', cwd: h.ws, outputFile: path.join(tasks, 'tdone0001.md') });
  // A log line that names a file outside the data directory as this task's output.
  registry.appendTaskEvent({ id: 'tforged01', ts: Date.now() - 4000, status: 'done', title: 'a forged line', worker: 'w1', model: 'opus', cwd: h.ws, outputFile: outside });
  await activate(h, 700);
  const { panel, model, send } = await openDashboard(h);
  const ids = (model()?.tasks ?? []).map((t) => t.id);
  check('the dashboard model lists both tasks', ids.includes('tdone0001') && ids.includes('tforged01'), ids);

  // openTask: by id, from the tasks directory, never the path a log line names.
  h.log.shown.length = 0;
  h.log.opened.length = 0;
  await send({ type: 'openTask', id: 'tdone0001' }, 150);
  check('openTask: opens <tasks>/<id>.md beside the dashboard', h.log.shown.length === 1 && h.log.shown[0].file === path.join(tasks, 'tdone0001.md') && h.log.shown[0].options?.viewColumn === h.vscode.ViewColumn.Beside, h.log.shown);
  h.log.shown.length = 0;
  h.log.opened.length = 0;
  const noticesBefore = panel.posted.filter((p) => p.type === 'notice').length;
  await send({ type: 'openTask', id: 'tforged01' }, 150);
  check('openTask for a task whose log line names a file outside the data directory: nothing is opened, the page gets a notice', h.log.shown.length === 0 && h.log.opened.length === 0 && panel.posted.filter((p) => p.type === 'notice').length === noticesBefore + 1, [h.log.shown, h.log.opened]);

  // A setting the host confirms in a dialog: the page is told at once, and answered when the dialog closes.
  const posted = () => panel.posted.filter((p) => p.type === 'settingPending' || p.type === 'settingResult');
  let dialogOpen;
  let closeDialog;
  h.answers.message = (rec) => (rec.modal ? new Promise((resolve) => { dialogOpen = rec; closeDialog = resolve; }) : undefined);
  let n = posted().length;
  panel._recv.fire({ type: 'setSetting', key: 'frontierWorkerDispatch', value: 'allow' });
  await sleep(250);
  let since = posted().slice(n);
  check('a widening value: while the dialog is open the page has been sent settingPending for that key, and no settingResult yet', dialogOpen !== undefined && since.length === 1 && since[0].type === 'settingPending' && since[0].key === 'frontierWorkerDispatch' && Object.keys(since[0]).sort().join() === 'key,type', since);
  // A second widening message while the first dialog is open: refused at once, with no dialog and no "pending" of its own.
  panel._recv.fire({ type: 'setSetting', key: 'overageWorkerDispatch', value: 'allow' });
  await sleep(150);
  since = posted().slice(n);
  check('a second one while the dialog is open: answered ok:false at once, without settingPending and without a second dialog', since.length === 2 && since[1].type === 'settingResult' && since[1].key === 'overageWorkerDispatch' && since[1].ok === false && since[1].value === 'block' && h.log.messages.filter((m) => m.modal).length === 1, [since, h.log.messages.filter((m) => m.modal).length]);
  closeDialog(undefined);
  await sleep(200);
  since = posted().slice(n);
  check('the dialog is dismissed: ONE settingResult for the first key — ok:false, the value still in effect', since.length === 3 && since[2].type === 'settingResult' && since[2].key === 'frontierWorkerDispatch' && since[2].ok === false && since[2].value === 'block' && h.store.global[`${S}.frontierWorkerDispatch`] === undefined, since);

  await sleep(1100);
  n = posted().length;
  h.answers.message = (rec) => (rec.modal ? new Promise((resolve) => { setTimeout(() => resolve(rec.items[0]), 300); }) : undefined);
  panel._recv.fire({ type: 'setSetting', key: 'frontierWorkerDispatch', value: 'allow' });
  await sleep(120);
  const early = posted().slice(n);
  await sleep(700);
  since = posted().slice(n);
  check('confirmed: settingPending first, then settingResult ok:true with the new value', early.length === 1 && early[0].type === 'settingPending' && since.length === 2 && since[1].type === 'settingResult' && since[1].ok === true && since[1].value === 'allow', [early, since]);

  n = posted().length;
  h.answers.message = () => undefined;
  await send({ type: 'setSetting', key: 'quotaCooldownMinutes', value: 45 }, 250);
  since = posted().slice(n);
  check('a setting that needs no confirmation gets no settingPending, only its result', since.length === 1 && since[0].type === 'settingResult' && since[0].ok === true && since[0].value === 45, since);

  // The dialog cannot be shown at all: the page is still answered.
  await sleep(1100);
  n = posted().length;
  h.answers.message = (rec) => { if (rec.modal) throw new Error('the window is closing'); return undefined; };
  await send({ type: 'setSetting', key: 'overageWorkerDispatch', value: 'allow' }, 300);
  since = posted().slice(n);
  check('a dialog that fails to open: settingPending, then settingResult ok:false — the page is never left waiting', since.length === 2 && since[0].type === 'settingPending' && since[1].type === 'settingResult' && since[1].ok === false && since[1].value === 'block', since);
  h.answers.message = () => undefined;

  // The string table the page gets.
  const strings = h.req('dashboard.js').dashboardStrings();
  const needed = ['registryTitle', 'registryBody', 'registryOpen', 'unsupportedTitle', 'unsupportedBody', 'unsupportedUnnamed', 'saveConfirming'];
  const gone = ['dangerResetCheckinConfirm', 'sessStopConfirm'];
  check('the string table has the new entries and no longer the two "confirm again" labels', needed.every((k) => typeof strings[k] === 'string' && strings[k] !== '') && gone.every((k) => !(k in strings)) && strings.unsupportedUnnamed === '(unnamed entry)', [needed.filter((k) => typeof strings[k] !== 'string'), gone.filter((k) => k in strings)]);
  finish(h);
}

/* ---- A1: the Asset Manager document ---- */

function assetHtml(h) {
  const am = h.req('assetManager.js');
  const strings = am.assetManagerStrings();
  return { am, strings, html: (nonce) => am.assetManagerHtml(strings, nonce) };
}
const scriptOf = (html) => (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) ?? [])[1] ?? '';
/** The policy as the browser reads it out of the document: the attribute's value, entities decoded. */
const policyOf = (html) =>
  ((html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) ?? [])[1] ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function a1AssetHtml() {
  const h = boot({});
  const { html } = assetHtml(h);
  const nonce = 'abcdef0123456789abcdef0123456789';
  const doc = html(nonce);
  const csp = policyOf(doc);
  const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '');
  check('the policy starts from default-src \'none\'', /default-src 'none'/.test(csp), csp);
  check('script-src is this render\'s nonce and nothing else — no \'unsafe-inline\', no \'unsafe-eval\'', directive('script-src') === `script-src 'nonce-${nonce}'`, directive('script-src'));
  check('style-src has no \'unsafe-inline\' either', directive('style-src') !== '' && !/unsafe/.test(directive('style-src')), directive('style-src'));
  const scripts = doc.match(/<script[^>]*>/g) ?? [];
  check('there is ONE script, and it carries the nonce', scripts.length === 1 && scripts[0] === `<script nonce="${nonce}">`, scripts);
  const script = scriptOf(doc);
  const forbidden = ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'createContextualFragment', 'DOMParser', '.setAttribute(\'on', 'setAttribute("on', '.onclick', '.onchange'];
  check('the script uses no markup-string or code-from-text API', forbidden.every((f) => !script.includes(f)), forbidden.filter((f) => script.includes(f)));
  const body = doc.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  check('the static document has no inline event handler and no style attribute', !/\son[a-z]+\s*=/i.test(body) && !/\sstyle\s*=/i.test(body), (body.match(/\s(on[a-z]+|style)\s*=[^>]*/gi) ?? []).slice(0, 4));
  const other = html('fedcba9876543210fedcba9876543210');
  check('the nonce is the caller\'s, per render: another nonce, another document', other !== doc && other.includes('nonce-fedcba9876543210fedcba9876543210') && !other.includes(nonce), 'same document');
  const odd = html('x" onload="alert(1)');
  check('a nonce that is not a plain token is not written into the document', !odd.includes('onload="alert(1)') && /script-src 'nonce-[A-Za-z0-9]{16,}'/.test(policyOf(odd)), policyOf(odd));
  // The panel as the extension opens it.
  await activate(h, 500);
  await exec(h, 'openAssetManager');
  const panel = h.log.panels.find((p) => p.viewType === 'ccoAssetManager');
  const live = panel?.webview.html ?? '';
  const liveNonce = (policyOf(live).match(/script-src 'nonce-([A-Za-z0-9]+)'/) ?? [])[1];
  check('the opened panel\'s document has a fresh nonce on its script and in its policy', typeof liveNonce === 'string' && liveNonce.length >= 16 && live.includes(`<script nonce="${liveNonce}">`) && !/unsafe-inline/.test(live), policyOf(live));
  finish(h);
}

/* ---- A2: messages from the Asset Manager page ---- */

async function a2AssetMessages() {
  const pre = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-sb-pack-')));
  const pack = path.join(pre, 'pack');
  fs.mkdirSync(path.join(pack, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  fs.writeFileSync(path.join(pack, 'commands', 'other.md'), '---\ndescription: other\n---\nother\n');
  const never = path.join(pre, 'never-listed');
  fs.mkdirSync(never);
  const h = boot({ globalSettings: full({ assetPacks: [pack], assetAutoSync: false }) });
  await activate(h, 500);
  // A file under .claude/ that no asset installs.
  fs.mkdirSync(path.join(h.ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h.ws, '.claude', 'settings.local.json'), '{"private": true}');
  await exec(h, 'openAssetManager');
  await sleep(150);
  const panel = h.log.panels.find((p) => p.viewType === 'ccoAssetManager');
  const send = async (msg, wait = 60) => { panel._recv.fire(msg); await sleep(wait); };
  const KEY = 'pack:commands/hello';
  const ledgerFile = path.join(h.ws, '.claude', 'cco-assets.json');
  const ledger = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : 'absent');
  const installed = (name) => fs.existsSync(path.join(h.ws, '.claude', 'commands', name));
  const data = () => panel.posted.filter((p) => p.type === 'data').pop();

  // What the page legitimately does still works.
  await send({ type: 'toggle', key: KEY, enabled: true }, 150);
  check('toggle on a listed asset installs it', installed('hello.md') && JSON.parse(ledger()).assets[KEY]?.enabled === true, [ledger(), data()?.assets?.map((a) => a.key)]);
  h.log.opened.length = 0;
  await send({ type: 'openSource', key: KEY, rel: 'commands/hello.md' }, 100);
  check('openSource on a listed file opens the pack file', h.log.opened.some((o) => o.opened === path.join(pack, 'commands', 'hello.md')), h.log.opened);
  await send({ type: 'revealPack', root: pack }, 100);
  check('revealPack on a listed pack directory starts the file manager', h.log.commandsExecuted.filter((c) => c.id === 'revealFileInOS').length === 1, h.log.commandsExecuted.map((c) => c.id));

  // Hostile messages.
  const ledgerBefore = ledger();
  h.log.messages.length = 0;
  h.log.opened.length = 0;
  h.log.shown.length = 0;
  h.log.configUpdates.length = 0;
  const revealsBefore = h.log.commandsExecuted.filter((c) => c.id === 'revealFileInOS').length;
  const diffsBefore = h.log.commandsExecuted.filter((c) => c.id === 'vscode.diff').length;
  const big = 'k'.repeat(10 * 1024 * 1024);
  const hostile = [
    null, undefined, 42, 'toggle', [], [{ type: 'toggle', key: KEY, enabled: false }], {}, { type: 5 }, { type: 'toString' }, { type: '__proto__' }, { type: 'constructor', key: KEY }, { type: 'nope', key: KEY },
    // a flag that is not a boolean must not read as "off"
    { type: 'toggle', key: KEY }, { type: 'toggle', key: KEY, enabled: 'false' }, { type: 'toggle', key: KEY, enabled: 0 }, { type: 'toggle', key: KEY, enabled: null }, { type: 'toggle', key: KEY, enabled: 'yes' },
    // keys the host never listed, prototype names among them
    { type: 'toggle', key: '__proto__', enabled: true }, { type: 'toggle', key: 'constructor', enabled: true }, { type: 'toggle', key: 'pack:commands/nope', enabled: true }, { type: 'toggle', key: 123, enabled: true }, { type: 'toggle', key: { toString: KEY }, enabled: true }, { type: 'toggle', key: big, enabled: true }, { type: 'toggle', key: '', enabled: false },
    { type: 'reset', key: '__proto__' }, { type: 'reset', key: 'pack:commands/nope' }, { type: 'reset', key: big }, { type: 'reset' },
    { type: 'disableOrphan', key: KEY }, { type: 'disableOrphan', key: '__proto__' }, { type: 'disableOrphan', key: 'gone:commands/x' },
    // files the host never listed
    { type: 'resetFile', key: KEY, rel: 'commands/other.md' }, { type: 'resetFile', key: KEY, rel: '../../etc/passwd' }, { type: 'resetFile', key: KEY, rel: 'constructor' }, { type: 'resetFile', key: KEY },
    { type: 'openInstalled', rel: 'settings.local.json' }, { type: 'openInstalled', rel: '../../../etc/hosts' }, { type: 'openInstalled', rel: '/etc/hosts' }, { type: 'openInstalled', rel: '__proto__' }, { type: 'openInstalled', rel: big }, { type: 'openInstalled', rel: 7 },
    { type: 'openSource', key: KEY, rel: 'constructor' }, { type: 'openSource', key: KEY, rel: '__proto__' }, { type: 'openSource', key: KEY, rel: 'toString' }, { type: 'openSource', key: KEY, rel: 'commands/../../hello.md' }, { type: 'openSource', key: '__proto__', rel: 'commands/hello.md' },
    { type: 'diff', key: KEY, rel: 'hasOwnProperty' }, { type: 'diff', key: KEY, rel: 'settings.local.json' }, { type: 'diff', key: 'constructor', rel: 'commands/hello.md' },
    // directories the host never listed
    { type: 'revealPack', root: never }, { type: 'revealPack', root: '/' }, { type: 'revealPack', root: `${pack}/` }, { type: 'revealPack', root: big }, { type: 'revealPack', root: { fsPath: pack } }, { type: 'revealPack' },
    { type: 'removePack', entry: never }, { type: 'removePack', entry: '' }, { type: 'removePack', entry: 7 }, { type: 'removePack', entry: big }, { type: 'removePack', root: pack },
    { type: 'setAutoSync', value: 'true' }, { type: 'setAutoSync', value: 1 }, { type: 'setAutoSync' }, { type: 'setAutoSync', value: null },
  ];
  let threw = '';
  const started = Date.now();
  for (const msg of hostile) {
    try { panel._recv.fire(msg); } catch (e) { threw = String(e && e.stack); }
    await sleep(15);
    // The dialog lane admits one a second; give each message that could reach a dialog its turn.
    if (msg && typeof msg === 'object' && ['reset', 'resetFile', 'disableOrphan'].includes(msg.type)) await sleep(1050);
  }
  await sleep(300);
  const took = Date.now() - started;
  check(`${hostile.length} hostile messages (wrong types, prototype keys, a directory and files the host never listed, flags that are not booleans, 10 MB strings): nothing thrown`, threw === '', threw);
  check('…the asset that was enabled is still enabled and installed (no message read as "off")', installed('hello.md') && !installed('other.md') && ledger() === ledgerBefore, [installed('hello.md'), installed('other.md'), ledger()]);
  check('…Object.prototype is as it was', ({}).enabled === undefined && ({}).files === undefined && Object.keys(Object.prototype).length === 0, Object.keys(Object.prototype));
  check('…no dialog, no error message', h.log.messages.length === 0, brief(h));
  check('…nothing was opened or shown', h.log.opened.length === 0 && h.log.shown.length === 0, [h.log.opened, h.log.shown]);
  check('…the file manager and the diff editor were not started', h.log.commandsExecuted.filter((c) => c.id === 'revealFileInOS').length === revealsBefore && h.log.commandsExecuted.filter((c) => c.id === 'vscode.diff').length === diffsBefore, h.log.commandsExecuted.map((c) => c.id).slice(-5));
  check('…no setting was written', h.log.configUpdates.length === 0, h.log.configUpdates);
  check('…and the 10 MB messages cost no time to speak of', took < hostile.length * 15 + 11 * 1050 + 3000, took);
  fs.rmSync(pre, { recursive: true, force: true });
  finish(h);
}

/* ---- P1: the two pages in a real browser engine ---- */

async function p1Page() {
  const h = boot({});
  const { html } = assetHtml(h);
  const assetDoc = html('abcdef0123456789abcdef0123456789');
  const assetFile = path.join(h.scratch, 'asset-manager.html');
  fs.writeFileSync(assetFile, assetDoc);
  const page = require('./shell-b-page.cjs');
  try {
    await page.run({ media: MEDIA, assetFile, scratch: h.scratch, check });
  } catch (e) {
    check('the page checks ran to their end', false, String((e && e.stack) || e));
  }
  finish(h);
}

/* ---- dispatch ---- */

const TABLE = {
  'U1-remove-unsupported': u1RemoveUnsupported,
  'U2-names-realpath': u2NamesRealpath,
  'R1-unreadable-activation-sync': () => r1UnreadableActivation(true),
  'R1-unreadable-activation-quiet': () => r1UnreadableActivation(false),
  'R2-unreadable-every-command': r2UnreadableEveryCommand,
  'R3-unreadable-worker-writes': r3UnreadableWorkerWrites,
  'R4-unreadable-dashboard': r4UnreadableDashboard,
  'L1-lock-activation': () => lockCase('activation'),
  'L2-lock-add': () => lockCase('add'),
  'L3-lock-remove': () => lockCase('remove'),
  'L4-lock-set-model': () => lockCase('set-model'),
  'L5-lock-toggle-preferred': () => lockCase('toggle-preferred'),
  'L6-lock-dashboard-setting': () => lockCase('dashboard-setting'),
  'T1-task-output': t1TaskOutput,
  'M1-mcp-empty': m1McpEmpty,
  'S1-settings-module': s1SettingsModule,
  'D1-dashboard-messages': d1DashboardMessages,
  'A1-asset-html': a1AssetHtml,
  'A2-asset-messages': a2AssetMessages,
  'P1-page': p1Page,
};

(async () => {
  const fn = TABLE[CASE];
  if (!fn) {
    console.log(`FAIL ${CASE}: unknown case`);
    process.exit(1);
  }
  try {
    await fn();
  } catch (err) {
    console.log(`FAIL ${CASE}: the case threw — ${String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ')}`);
    process.exit(1);
  }
})();
