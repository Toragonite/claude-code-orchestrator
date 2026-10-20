// VIEWS (2.0 fix wave 5): the shared task index, the three tree views, the dashboard model's
// registry problem and unsupported entries, and the output caps of the probes in usage.ts.
//
//   node .orchestrator/fixes/views.cjs [outDir] [--only IDX,F9,...] [--skip-budget]
//
// Loads the COMPILED modules from `outDir` (default: <repo>/out) against the `vscode` stand-in
// in shell-a-stub.cjs. Every case runs in a child process of its own with HOME / USERPROFILE
// redirected to a fresh directory under the system temp directory (TMPDIR) before any module
// loads, PATH cut down to a directory of fake CLIs, and a guard that reroutes any agent CLI to
// its fake. No real claude / codex / cursor-agent / agy is started and no real ~/.claude* or
// ~/.claude-code-orchestrator is touched. One child at a time. Prints `PASS <name>` /
// `FAIL <name> — <why>` / `SKIP <name> — <why>` and a tally; exit 0 only when nothing failed.
//
// The BUDGET case writes a 60 MiB task log (55,000 tasks) into its scratch directory and
// deletes it again; it skips its timing checks — loudly — when the 1-minute load average is
// above 20.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-views', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const VALUE_FLAGS = ['--only', '--case'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1])));
const OUT = path.resolve(positional[0] ?? path.join(REPO, 'out'));

/* ------------------------------------------------------------------------- *
 * Parent: one child per case
 * ------------------------------------------------------------------------- */

// name → [timeout ms, extra node flags]
const CASES = {
  'IDX-append': [120_000, []],
  'IDX-partial-line': [120_000, []],
  'IDX-rewrites': [120_000, []],
  'IDX-unreadable': [120_000, []],
  'IDX-chunks': [180_000, []],
  'IDX-idle': [120_000, []],
  'IDX-model': [120_000, []],
  'BUDGET-60mb': [600_000, ['--expose-gc']],
  'TOOLTIP-lazy': [120_000, []],
  'F9-paths': [120_000, []],
  'UNSUP-entries': [120_000, []],
  'REGPROB-registry': [120_000, []],
  'USAGE-caps': [180_000, []],
  'USAGE-helper-cap': [90_000, []],
  'KEEPALIVE-unreadable': [120_000, []],
  'KEEPALIVE-fifo': [20_000, []],
  'MISC-small': [120_000, []],
};

if (flag('--case') === undefined) {
  const only = flag('--only');
  const skipBudget = argv.includes('--skip-budget');
  const names = Object.keys(CASES).filter(
    (c) => only === undefined || only.split(',').some((sel) => c === sel || c.split('-')[0] === sel),
  );
  let pass = 0;
  let fail = 0;
  let skip = 0;
  console.log(`views: build under test = ${OUT}`);
  for (const name of names) {
    if (skipBudget && name.startsWith('BUDGET')) {
      console.log(`SKIP ${name}: not run (--skip-budget)`);
      skip++;
      continue;
    }
    const [timeout, nodeFlags] = CASES[name];
    const res = spawnSync(process.execPath, [...nodeFlags, __filename, OUT, '--case', name], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      // A build outside the repository (a scratch outDir) still finds the packages the dispatch
      // core loads; one case loads that core to compare its wording with the editor's.
      env: { ...process.env, NODE_PATH: [path.join(REPO, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
    });
    const out = (res.stdout ?? '').split('\n');
    // A case that was cut short (a timeout, a crash) leaves its scratch directory behind; it
    // announced the directory when it made it, so it is removed here.
    for (const line of out) {
      const dir = line.startsWith('SCRATCH ') ? line.slice('SCRATCH '.length) : '';
      if (path.basename(dir).startsWith('cco-views-') && fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    const lines = out.filter((l) => /^(PASS|FAIL|SKIP|INFO) /.test(l));
    for (const line of lines) {
      console.log(line);
      if (line.startsWith('PASS ')) pass++;
      else if (line.startsWith('FAIL ')) fail++;
      else if (line.startsWith('SKIP ')) skip++;
    }
    if (res.status !== 0 || !lines.some((l) => !l.startsWith('INFO '))) {
      fail++;
      const tail = `${res.stderr ?? ''}`.trim().split('\n').slice(-6).join(' | ');
      console.log(
        `FAIL ${name}: the case did not run to its end — exit ${res.status}${res.signal ? ` (${res.signal})` : ''}` +
          `${res.error ? ` [${res.error.code ?? res.error.message}]` : ''}: ${tail || out.slice(-3).join(' | ')}`,
      );
    }
  }
  console.log(`\nviews: ${pass} passed, ${fail} failed, ${skip} skipped`);
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
    return text === undefined ? String(v) : text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(v);
  }
};
function check(name, ok, observed) {
  console.log(ok ? `PASS ${CASE}: ${name}` : `FAIL ${CASE}: ${name} — ${show(observed)}`);
  return ok;
}
const info = (text) => console.log(`INFO ${CASE}: ${text}`);
const skipLine = (name, why) => console.log(`SKIP ${CASE}: ${name} — ${why}`);

function boot(opts = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-views-')));
  console.log(`SCRATCH ${scratch}`);
  const home = path.join(scratch, 'home');
  const ws = path.join(scratch, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const h = install({ repo: REPO, out: OUT, home, workspace: ws, ...opts });
  h.scratch = scratch;
  h.ws = ws;
  h.tasksDir = path.join(h.root, 'tasks');
  h.log_ = path.join(h.root, 'tasks.jsonl');
  fs.mkdirSync(h.tasksDir, { recursive: true });
  return h;
}
function finish(h) {
  check('no unhandled rejection or uncaught exception', h.log.rejections.length === 0, h.log.rejections.slice(0, 2));
  try { h.dispose(); } catch { /* best effort */ }
  try { fs.rmSync(h.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
const writeRegistry = (h, registry) => fs.writeFileSync(path.join(h.root, 'registry.json'), JSON.stringify(registry, null, 2));
const claudeWorker = (h, name) => ({ name, configDir: path.join(h.home, `.claude-${name}`), model: 'opus' });

/** Deterministic pseudo-random numbers (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const taskId = (n) => `t${(n + 1e9).toString(36)}abcd`;

/** Wrap functions of `fs` so every call is recorded as { fn, path }. Returns the record and an undo. */
function spyFs(names) {
  const calls = [];
  const originals = {};
  for (const name of names) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals[name] = original;
    fs[name] = function (...args) {
      const first = args[0];
      calls.push({ fn: name, path: typeof first === 'string' ? first : Buffer.isBuffer(first) ? first.toString() : typeof first === 'number' ? `fd:${first}` : String(first) });
      return original.apply(this, args);
    };
  }
  return { calls, restore: () => { for (const [name, original] of Object.entries(originals)) fs[name] = original; } };
}
const OPENERS = ['openSync', 'readFileSync', 'appendFileSync', 'writeFileSync', 'createReadStream', 'createWriteStream', 'readdirSync', 'opendirSync', 'truncateSync', 'copyFileSync'];
const LOOKERS = ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'readlinkSync'];

/* ------------------------------------------------------------------------- *
 * A full parse to compare the index with
 * ------------------------------------------------------------------------- */

// The task-id rule every reader shares (ranAs.isCountedTaskEvent, the same as registry.isTaskFileId).
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * What the views must show for the log as it is now — computed from scratch, from the
 * registry's own full read of the file (readTaskEventsChecked), by code that shares nothing
 * with the index but the display rule (displayText) and the provider table.
 */
function fullParse(h) {
  const reg = h.req('registry.js');
  const dt = h.req('displayText.js');
  const prov = h.req('providers.js');
  const disp = (raw, max) => {
    if (typeof raw !== 'string' || raw === '') return '';
    const window = Math.max(4096, max * 16);
    const bounded = raw.length > window ? raw.slice(0, window) : raw;
    return dt.sliceOneLine(dt.flattenOneLine(bounded), max).trimEnd();
  };
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null);
  const { events, unreadable } = reg.readTaskEventsChecked();
  const tasks = new Map();
  const done = [];
  for (const e of events) {
    if (typeof e.id !== 'string' || !TASK_ID.test(e.id)) continue;
    if (e.status !== 'running' && e.status !== 'done' && e.status !== 'error') continue;
    if (!(typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0 && e.ts <= 8.64e15)) continue;
    let t = tasks.get(e.id);
    if (t === undefined) {
      t = { first: e, last: e, detached: false, provider: undefined };
      tasks.set(e.id, t);
    }
    t.last = e;
    if (typeof e.supervisorPid === 'number' && Number.isFinite(e.supervisorPid)) t.detached = true;
    if (typeof e.provider === 'string') t.provider = e.provider;
    if (e.status === 'done' && typeof e.worker === 'string' && e.worker !== '' && e.worker.length <= 256) done.push(e);
  }
  const rows = [];
  for (const [id, t] of tasks) {
    const e = t.last;
    const sessionWorker = disp(e.meshWorker, 80);
    const errorHead = (typeof e.error === 'string' ? e.error : '').trim().toLowerCase();
    const status =
      e.status === 'running' ? 'running' : e.status === 'done' ? 'done'
        : errorHead.startsWith('cancelled') ? 'cancelled' : errorHead.startsWith('orphaned') ? 'orphaned' : 'failed';
    let provider = null;
    let providerText = null;
    if (t.provider !== undefined) {
      const known = prov.parseProvider(t.provider);
      if (known !== undefined && known !== 'claude') provider = known;
      else if (known === undefined) providerText = disp(t.provider, 32) || null;
    }
    const startedAt = t.first.status === 'running' ? t.first.ts : null;
    const session = sessionWorker !== '';
    const failed = status !== 'running' && status !== 'done';
    rows.push({
      id,
      status,
      mode: session ? 'session' : t.detached ? 'detached' : 'oneshot',
      title: disp(e.title, 160) || '-',
      worker: disp(e.worker, 120) || '-',
      model: disp(e.model, 64) || '-',
      startedAt,
      lastTs: e.ts,
      sessionWorker: session ? sessionWorker : null,
      provider,
      providerText,
      workerName: typeof e.worker === 'string' && e.worker !== '' && e.worker.length <= 256 ? e.worker : undefined,
      cwd: typeof e.cwd === 'string' && e.cwd !== '' && e.cwd.length <= 4096 && !e.cwd.includes('\u0000') && path.isAbsolute(e.cwd) ? path.resolve(e.cwd) : undefined,
      // What a surface reads back from the task's latest event. A line past 256 KiB is not one
      // this product writes (its own cap is 32 KiB) and is not read back for its details.
      detail: Buffer.byteLength(JSON.stringify(e)) > 256 * 1024
        ? { inputTokens: null, outputTokens: null, costUsd: null, error: null, errorText: '', promptPreview: null }
        : {
            inputTokens: session ? null : count(e.inputTokens),
            outputTokens: session ? null : count(e.outputTokens),
            costUsd: session ? null : count(e.costUsd),
            error: failed ? disp(e.error, 240) || null : null,
            errorText: typeof e.error === 'string' ? e.error.slice(0, 16 * 1024) : '',
            promptPreview: disp(e.promptPreview, 300) || null,
          },
      sortKey: status === 'running' ? (startedAt ?? e.ts) : e.ts,
    });
  }
  rows.sort((a, b) => b.sortKey - a.sortKey || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  done.sort((a, b) => a.ts - b.ts);
  const windows = (name, now) => {
    const out = { session5h: { tasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, week: { tasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    for (const e of done) {
      if (e.worker !== name || e.ts < now - WEEK) continue;
      const session = disp(e.meshWorker, 80) !== '';
      for (const [key, since] of [['week', now - WEEK], ['session5h', now - FIVE_HOURS]]) {
        if (e.ts < since) continue;
        out[key].tasks += 1;
        out[key].inputTokens += session ? 0 : (count(e.inputTokens) ?? 0);
        out[key].outputTokens += session ? 0 : (count(e.outputTokens) ?? 0);
        out[key].costUsd += session ? 0 : (count(e.costUsd) ?? 0);
      }
    }
    return out;
  };
  const workers = [...new Set(done.map((e) => e.worker))];
  return { unreadable, rows, windows, workers, events };
}

const ROW_FIELDS = ['id', 'status', 'mode', 'title', 'worker', 'model', 'startedAt', 'lastTs', 'sessionWorker', 'provider', 'providerText', 'workerName', 'cwd'];
const pick = (row) => Object.fromEntries(ROW_FIELDS.map((k) => [k, row[k] === undefined ? '<undefined>' : row[k]]));
const inside = (root, cwd) => cwd !== undefined && cwd !== '<undefined>' && (cwd === root || cwd.startsWith(root + path.sep));

/**
 * Compare everything the shared index answers with a full parse of the log as it is now.
 * One PASS/FAIL line; on a mismatch, the first difference.
 */
function sameAsFullParse(h, label, now = Date.now()) {
  const ui = h.req('uiModel.js');
  if (typeof ui.listTasks !== 'function') {
    return check(`${label}: the index equals a full parse`, false, 'this build has no shared task index (uiModel.listTasks)');
  }
  const want = fullParse(h);
  const all = ui.listTasks({ root: undefined, limit: 1e9 });
  const problems = [];
  const problem = ui.taskLogProblem();
  if ((problem !== null) !== want.unreadable) problems.push(`unreadable: index says ${show(problem)}, a full read says unreadable=${want.unreadable}`);
  if (all.problem !== problem) problems.push(`listTasks.problem ${show(all.problem)} ≠ taskLogProblem ${show(problem)}`);
  if (all.total !== want.rows.length || all.rows.length !== want.rows.length) problems.push(`tasks: index ${all.rows.length} (total ${all.total}), full parse ${want.rows.length}`);
  for (let i = 0; i < Math.min(all.rows.length, want.rows.length) && problems.length < 3; i++) {
    const got = JSON.stringify(pick(all.rows[i]));
    const exp = JSON.stringify(pick(want.rows[i]));
    if (got !== exp) problems.push(`row ${i}: index ${got} ≠ full parse ${exp}`);
  }
  // the lists the trees ask for
  for (const query of [
    { root: h.ws, limit: 7 },
    { root: h.ws, limit: 300 },
    { root: h.ws, only: 'finished-session', limit: 5 },
    { root: path.join(h.scratch, 'elsewhere'), limit: 300 },
    { root: undefined, limit: 3 },
  ]) {
    const got = ui.listTasks(query);
    const matching = want.rows.filter(
      (r) => (query.root === undefined || inside(query.root, r.cwd)) && (query.only === undefined || (r.mode === 'session' && r.status !== 'running')),
    );
    const exp = { ids: matching.slice(0, query.limit).map((r) => r.id), total: matching.length };
    const have = { ids: got.rows.map((r) => r.id), total: got.total };
    if (JSON.stringify(have) !== JSON.stringify(exp) && problems.length < 3) problems.push(`list ${show({ ...query, root: query.root && path.basename(query.root) })}: index ${show(have)} ≠ full parse ${show(exp)}`);
  }
  // per-account windows
  for (const name of [...want.workers, 'nobody', 'constructor', '__proto__']) {
    const got = ui.dispatchWindows(name, now);
    const exp = want.windows(name, now);
    const have = { session5h: got.session5h, week: got.week };
    if (JSON.stringify(have) !== JSON.stringify(exp) && problems.length < 3) problems.push(`windows of ${name}: index ${show(have)} ≠ full parse ${show(exp)}`);
  }
  // one task by id, and the details read back from the log
  const sample = [...all.rows.slice(0, 40), ...all.rows.slice(-10)];
  for (const row of sample) {
    const exp = want.rows.find((r) => r.id === row.id);
    if (exp === undefined) continue;
    const brief = ui.taskBrief(row.id);
    if (!brief || brief.title !== exp.title || brief.status !== exp.status) problems.push(`taskBrief(${row.id}) = ${show(brief)}`);
    const got = ui.taskDetail(row);
    if (JSON.stringify(got) !== JSON.stringify(exp.detail) && problems.length < 3) problems.push(`details of ${row.id}: index ${show(got)} ≠ full parse ${show(exp.detail)}`);
  }
  return check(`${label}: the index equals a full parse (${want.rows.length} tasks${want.unreadable ? ', log unreadable' : ''})`, problems.length === 0, problems.slice(0, 3));
}

/**
 * A mixed bag of log lines: tasks in several states and modes, and lines that are not events.
 * Returns the lines WITHOUT terminators.
 */
function mixedLines(h, rng, from, count, baseTs) {
  const lines = [];
  const workers = ['w1', 'w2', 'w3', 'w1,w2', 'constructor'];
  for (let i = 0; i < count; i++) {
    const n = from + i;
    const id = taskId(n);
    const roll = rng();
    const worker = workers[Math.floor(rng() * workers.length)];
    const base = {
      id,
      title: roll < 0.1 ? `제목 ${n} — ünïcödé 🚀 title` : `task number ${n} refactor the widget module`,
      worker,
      model: rng() < 0.5 ? 'opus' : 'sonnet',
      cwd: rng() < 0.7 ? h.ws : rng() < 0.5 ? path.join(h.scratch, 'other-ws') : 'relative/dir',
      promptPreview: `prompt preview of task ${n} ` + 'p'.repeat(Math.floor(rng() * 200)),
      outputFile: path.join(h.tasksDir, `${id}.md`),
    };
    if (rng() < 0.25) base.meshWorker = `cco-w-aaaaaa-${worker}-${n}`;
    if (rng() < 0.15) base.provider = ['codex', 'cursor', 'opencode', 'claude', ' ', 'AGY'][Math.floor(rng() * 6)];
    const ts = baseTs + n * 1000;
    lines.push(JSON.stringify({ ...base, ts, status: 'running', ...(rng() < 0.2 ? { supervisorPid: 4242 } : {}), pid: 1 }));
    const end = rng();
    if (end < 0.55) {
      lines.push(JSON.stringify({ ...base, ts: ts + 500, status: 'done', inputTokens: Math.floor(rng() * 5000), outputTokens: Math.floor(rng() * 900), costUsd: Math.round(rng() * 1000) / 1000 }));
    } else if (end < 0.8) {
      const errors = ['cancelled by user', '  Orphaned — the session ended', 'exit code 1: boom\nsecond line', '\u200bcancelled by a zero-width trick', 'x'.repeat(700) + ' END-OF-ERROR', 'worker reported: cancelled later'];
      lines.push(JSON.stringify({ ...base, ts: ts + 700, status: 'error', error: errors[Math.floor(rng() * errors.length)] }));
    }
    // lines that are not events of any task
    const junk = rng();
    if (junk < 0.04) lines.push('null');
    else if (junk < 0.08) lines.push('42');
    else if (junk < 0.12) lines.push('[1,2,3]');
    else if (junk < 0.16) lines.push('{"id":"' + id + '","ts":' + (ts + 900) + ',"status":"exploded","title":"not a status"}');
    else if (junk < 0.2) lines.push('{"id":"NOT AN ID","ts":' + ts + ',"status":"done","worker":"w1","inputTokens":7}');  // a space: refused by the shared id rule
    else if (junk < 0.24) lines.push('{"id":"' + id + '","ts":"yesterday","status":"done"}');
    else if (junk < 0.28) lines.push('{"id":"' + id + '","ts":' + ts + ',"status":"done"');
    else if (junk < 0.32) lines.push('   ');
    else if (junk < 0.36) lines.push('');
    else if (junk < 0.4) lines.push(JSON.stringify({ ...base, ts: ts + 300, status: 'done', inputTokens: '<img src=x>', outputTokens: 1e308, costUsd: -5 }) + '\r');
  }
  return lines;
}
const appendLines = (h, lines) => fs.appendFileSync(h.log_, lines.map((l) => l + '\n').join(''));

/* ------------------------------------------------------------------------- *
 * Cases
 * ------------------------------------------------------------------------- */

const cases = {};

cases['IDX-append'] = async () => {
  const h = boot();
  const rng = prng(11);
  const base = Date.now() - 3 * 3600_000;
  sameAsFullParse(h, 'no log yet');
  appendLines(h, mixedLines(h, rng, 0, 120, base));
  sameAsFullParse(h, 'first read');
  let n = 120;
  for (const size of [1, 3, 40, 1, 400, 2]) {
    appendLines(h, mixedLines(h, rng, n, size, base));
    n += size;
    sameAsFullParse(h, `after appending ${size} more tasks`);
  }
  // later events of tasks the index already holds: status, mode and provider facts must carry over
  const again = [];
  for (const k of [0, 5, 17, 121, 300]) {
    const id = taskId(k);
    again.push(JSON.stringify({ id, ts: base + 9_000_000 + k, status: 'error', error: 'cancelled by user', title: `task ${k} closed late`, worker: 'w2', model: 'opus', cwd: h.ws }));
  }
  appendLines(h, again);
  sameAsFullParse(h, 'after terminal events for five old tasks');
  // an event whose ts is OLDER than everything (a clock set back): the done list goes out of order
  appendLines(h, [JSON.stringify({ id: taskId(9000), ts: base - 86_400_000, status: 'done', title: 'from the past', worker: 'w1', model: 'opus', cwd: h.ws, inputTokens: 5, outputTokens: 6, costUsd: 0.5 })]);
  sameAsFullParse(h, 'after an event older than all others');
  // a burst larger than the one-by-one path handles
  appendLines(h, mixedLines(h, rng, 10_000, 900, base));
  sameAsFullParse(h, 'after a burst of 900 tasks');
  sameAsFullParse(h, 'windows asked for a week later', Date.now() + 6.9 * 86_400_000);
  finish(h);
};

cases['IDX-partial-line'] = async () => {
  const h = boot();
  const rng = prng(12);
  const base = Date.now() - 3600_000;
  appendLines(h, mixedLines(h, rng, 0, 30, base));
  sameAsFullParse(h, 'start');
  // `base` is an hour ago; + 500 s keeps these events in the PAST (a time more than five minutes ahead of the
  // clock is no time at all to the index, which would change what this case compares).
  const ev = (n, status, extra = {}) => JSON.stringify({ id: taskId(n), ts: base + 500_000 + n, status, title: `partial ${n}`, worker: 'w1', model: 'opus', cwd: h.ws, ...extra });
  // a record cut in the middle, then its second half
  const whole = ev(500, 'done', { inputTokens: 11, outputTokens: 12, costUsd: 0.25 });
  fs.appendFileSync(h.log_, whole.slice(0, 40));
  sameAsFullParse(h, 'half a record at the end');
  fs.appendFileSync(h.log_, whole.slice(40, 70));
  sameAsFullParse(h, 'more of it, still unfinished');
  fs.appendFileSync(h.log_, whole.slice(70) + '\n');
  sameAsFullParse(h, 'the record completed');
  // a whole record whose line feed has not arrived yet
  fs.appendFileSync(h.log_, ev(501, 'running'));
  sameAsFullParse(h, 'a complete record without its line feed');
  fs.appendFileSync(h.log_, '\n' + ev(501, 'done') + '\n');
  sameAsFullParse(h, 'its line feed, and the next record');
  // a whole record without a line feed that then turns out to be the start of a longer line
  fs.appendFileSync(h.log_, ev(502, 'done', { inputTokens: 999 }));
  sameAsFullParse(h, 'another complete record without its line feed');
  fs.appendFileSync(h.log_, ' trailing garbage on the same line\n' + ev(503, 'running') + '\n');
  sameAsFullParse(h, 'that line continued and no longer parses');
  // whitespace only, then a record
  fs.appendFileSync(h.log_, '   ');
  sameAsFullParse(h, 'spaces without a line feed');
  fs.appendFileSync(h.log_, '\n\n' + ev(504, 'error', { error: 'orphaned — gone' }) + '\n');
  sameAsFullParse(h, 'blank lines, then a record');
  // a log that is ONLY an unfinished line
  fs.writeFileSync(h.log_, whole.slice(0, 25));
  sameAsFullParse(h, 'a log that is one unfinished line');
  fs.appendFileSync(h.log_, whole.slice(25) + '\n');
  sameAsFullParse(h, 'that line completed');
  finish(h);
};

cases['IDX-rewrites'] = async () => {
  const h = boot();
  const reg = h.req('registry.js');
  const rng = prng(13);
  const base = Date.now() - 2 * 3600_000;
  // only finished tasks: renameWorker refuses while a dispatch is running
  const finished = (n, worker = 'w1') => {
    const id = taskId(n);
    const common = { id, title: `rewrite ${n}`, worker, model: 'opus', cwd: h.ws };
    return [JSON.stringify({ ...common, ts: base + n * 1000, status: 'running' }), JSON.stringify({ ...common, ts: base + n * 1000 + 400, status: 'done', inputTokens: 100 + n, outputTokens: n, costUsd: 0.01 })];
  };
  writeRegistry(h, { workers: [claudeWorker(h, 'w1'), claudeWorker(h, 'w2')] });
  let lines = [];
  for (let n = 0; n < 60; n++) lines.push(...finished(n, n % 2 ? 'w1' : 'w2'));
  appendLines(h, lines);
  sameAsFullParse(h, 'start');

  // truncation to zero (the Clear command)
  reg.clearTaskLog();
  sameAsFullParse(h, 'after clearTaskLog');
  appendLines(h, finished(100));
  sameAsFullParse(h, 'first tasks after the clear');

  // cleared and regrown PAST its old size between two looks: same inode, larger file
  lines = [];
  for (let n = 200; n < 230; n++) lines.push(...finished(n));
  appendLines(h, lines);
  sameAsFullParse(h, 'grown again');
  const sizeBefore = fs.statSync(h.log_).size;
  const inoBefore = fs.statSync(h.log_).ino;
  reg.clearTaskLog();
  lines = [];
  for (let n = 300; n < 380; n++) lines.push(...finished(n));
  appendLines(h, lines);
  const st = fs.statSync(h.log_);
  check('fixture: cleared and regrown is the same inode and a larger file', st.ino === inoBefore && st.size > sizeBefore, { inoBefore, ino: st.ino, sizeBefore, size: st.size });
  sameAsFullParse(h, 'cleared and regrown past its old size without a look in between');

  // replacement by a different file of the SAME size: a new inode (temp file + rename)
  const text = fs.readFileSync(h.log_, 'utf8');
  const swapped = text.replace(/rewrite 3(\d\d)/g, 'changed 3$1').replace(/"worker":"w1"/g, '"worker":"w2"');
  check('fixture: the replacement has the same byte size', Buffer.byteLength(swapped) === Buffer.byteLength(text) && swapped !== text, { a: Buffer.byteLength(text), b: Buffer.byteLength(swapped) });
  const tmp = `${h.log_}.swap`;
  fs.writeFileSync(tmp, swapped);
  fs.renameSync(tmp, h.log_);
  sameAsFullParse(h, 'replaced by a different file of the same size (new inode)');

  // the same, written in place: the same inode, the same size, another mtime
  const inPlace = swapped.replace(/changed 3(\d\d)/g, 'inplace 3$1');
  await sleep(20);
  const fd = fs.openSync(h.log_, 'r+');
  fs.writeSync(fd, inPlace, 0);
  fs.closeSync(fd);
  check('fixture: rewritten in place — same inode and size', fs.statSync(h.log_).ino === fs.statSync(h.log_).ino && fs.statSync(h.log_).size === Buffer.byteLength(swapped), fs.statSync(h.log_).size);
  sameAsFullParse(h, 'rewritten in place at the same size (same inode, new mtime)');

  // a rewrite that changes earlier lines: the registry's own rename of a worker
  let renamed = true;
  try {
    reg.renameWorker('w2', 'w9');
  } catch (err) {
    renamed = String(err && err.message);
  }
  check('fixture: renameWorker rewrote the log', renamed === true && fs.readFileSync(h.log_, 'utf8').includes('"worker":"w9"'), renamed);
  sameAsFullParse(h, 'after renameWorker rewrote earlier lines');
  appendLines(h, finished(900, 'w9'));
  sameAsFullParse(h, 'an append after the rename');

  // an earlier line changed by hand to another LENGTH, with more appended, same inode
  const now = fs.readFileSync(h.log_, 'utf8');
  const edited = now.replace('inplace 300', 'hand-edited title of another length 300') + finished(901, 'w9').join('\n') + '\n';
  const fd2 = fs.openSync(h.log_, 'r+');
  fs.writeSync(fd2, edited, 0);
  fs.closeSync(fd2);
  sameAsFullParse(h, 'an earlier line edited in place and the file grown');

  // the log deleted, then written anew
  fs.rmSync(h.log_);
  sameAsFullParse(h, 'the log deleted');
  appendLines(h, mixedLines(h, rng, 2000, 25, base));
  sameAsFullParse(h, 'a new log');
  finish(h);
};

cases['IDX-unreadable'] = async () => {
  const h = boot();
  const rng = prng(14);
  const ui = h.req('uiModel.js');
  const base = Date.now() - 3600_000;
  appendLines(h, mixedLines(h, rng, 0, 80, base));
  sameAsFullParse(h, 'start');
  const parked = `${h.log_}.parked`;

  // a directory where the log should be
  fs.renameSync(h.log_, parked);
  fs.mkdirSync(h.log_);
  sameAsFullParse(h, 'a directory at the path');
  if (typeof ui.taskLogProblem === 'function') {
    const problem = ui.taskLogProblem();
    check('a directory at the path is a problem that names no path and none of the file', typeof problem === 'string' && problem.length <= 120 && !problem.includes(h.home) && /directory/.test(problem), problem);
  }
  const model = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
  check('the model says the log is unreadable and lists no tasks', typeof model.health.taskLogProblem === 'string' && model.tasks.length === 0, model.health);
  fs.rmdirSync(h.log_);
  fs.renameSync(parked, h.log_);
  sameAsFullParse(h, 'readable again after the directory');

  // over the cap: a sparse file one byte past 64 MiB
  const size = fs.statSync(h.log_).size;
  fs.truncateSync(h.log_, 64 * 1024 * 1024 + 1);
  sameAsFullParse(h, 'one byte over the 64 MiB cap (sparse)');
  if (typeof ui.taskLogProblem === 'function') check('over the cap is said as too large', /too-large/.test(String(ui.taskLogProblem())), ui.taskLogProblem());
  fs.truncateSync(h.log_, size);
  sameAsFullParse(h, 'readable again after the cap');
  appendLines(h, mixedLines(h, rng, 500, 10, base));
  sameAsFullParse(h, 'and it follows appends again');

  // exactly at the cap is still read (zero bytes are blank lines to both readers)
  // — not run: it would decode 64 MiB of NULs through the registry's reader for no new fact.

  // a pipe at the path must not block, in either reader
  fs.renameSync(h.log_, parked);
  execFileSync('mkfifo', [h.log_]);
  sameAsFullParse(h, 'a FIFO at the path');
  fs.rmSync(h.log_);
  fs.renameSync(parked, h.log_);
  sameAsFullParse(h, 'readable again after the FIFO');

  // no read permission (skipped for root, which reads anything). The log has grown since the
  // index last read it, so the index has to open it — and cannot.
  if (process.getuid && process.getuid() !== 0) {
    appendLines(h, mixedLines(h, rng, 600, 5, base));
    fs.chmodSync(h.log_, 0o000);
    sameAsFullParse(h, 'a grown log without read permission');
    fs.chmodSync(h.log_, 0o600);
    // the same file, unchanged, is readable again: the index retries after a short while
    await sleep(2300);
    sameAsFullParse(h, 'readable again once the permission is back');
  }

  // a symbolic link to the log is followed, as the registry follows it
  fs.renameSync(h.log_, parked);
  fs.symlinkSync(parked, h.log_);
  sameAsFullParse(h, 'the log kept at a symbolic link');
  fs.appendFileSync(parked, mixedLines(h, rng, 700, 5, base).map((l) => l + '\n').join(''));
  sameAsFullParse(h, 'an append through the link');
  finish(h);
};

cases['IDX-chunks'] = async () => {
  const h = boot();
  const rng = prng(15);
  // Six hours back: task n is dated base + n seconds, and how many tasks it takes to fill the
  // log depends on the length of the temp path (3,450 under a long one, 4,250 under a short
  // one). One hour back put every task past n = 3,900 more than 5 minutes in the FUTURE, which
  // the index lists after the dated tasks (contract §9.7) and this file's full parse does not.
  const base = Date.now() - 6 * 3600_000;
  // ~9.5 MiB: several read pieces, multi-byte characters everywhere, and one 5 MiB line
  const fd = fs.openSync(h.log_, 'w');
  let n = 0;
  let bytes = 0;
  const write = (text) => { fs.writeSync(fd, text); bytes += Buffer.byteLength(text); };
  while (bytes < 2.2 * 1024 * 1024) {
    write(mixedLines(h, rng, n, 50, base).map((l) => l + '\n').join(''));
    n += 50;
  }
  // one valid event whose line is 5 MiB of three-byte characters: it spans read pieces
  write(JSON.stringify({ id: taskId(777_000), ts: base + 77, status: 'done', title: '긴'.repeat(1_750_000), worker: 'w1', model: 'opus', cwd: h.ws, inputTokens: 3, outputTokens: 4, costUsd: 0.5 }) + '\n');
  while (bytes < 9.5 * 1024 * 1024) {
    write(mixedLines(h, rng, n, 50, base).map((l) => l + '\n').join(''));
    n += 50;
  }
  fs.closeSync(fd);
  info(`log of ${(bytes / 1048576).toFixed(1)} MiB, ${n} generated tasks`);
  sameAsFullParse(h, 'a multi-piece log with a 5 MiB line');
  appendLines(h, mixedLines(h, rng, n, 30, base));
  sameAsFullParse(h, 'an append to it');
  // an unfinished 6 MiB line at the end, then its completion
  const long = JSON.stringify({ id: taskId(777_001), ts: base + 78, status: 'error', error: 'cancelled ' + '語'.repeat(2_000_000), title: 'long error', worker: 'w2', model: 'opus', cwd: h.ws });
  fs.appendFileSync(h.log_, long.slice(0, 1_200_000));
  sameAsFullParse(h, 'an unfinished multi-megabyte line at the end');
  fs.appendFileSync(h.log_, long.slice(1_200_000));
  sameAsFullParse(h, 'that line complete but for its line feed');
  fs.appendFileSync(h.log_, '\n');
  sameAsFullParse(h, 'and its line feed');
  finish(h);
};

cases['IDX-idle'] = async () => {
  const h = boot();
  const rng = prng(16);
  const ui = h.req('uiModel.js');
  const views = h.req('views.js');
  writeRegistry(h, { workers: [claudeWorker(h, 'w1'), claudeWorker(h, 'w2')] });
  appendLines(h, mixedLines(h, rng, 0, 500, Date.now() - 3600_000));
  const tasks = new views.TasksProvider();
  const rows = tasks.getChildren();
  for (const row of rows) tasks.getTreeItem(row);
  if (typeof ui.listTasks === 'function') {
    ui.dispatchWindows('w1');
    ui.listTasks({ root: h.ws, only: 'finished-session', limit: 50 });
  }
  const spy = spyFs(['openSync', 'readSync', 'readFileSync', 'readdirSync', 'opendirSync', 'createReadStream', 'statSync', 'lstatSync']);
  for (let i = 0; i < 1000; i++) {
    const again = tasks.getChildren();
    for (const row of again) tasks.getTreeItem(row);
    if (typeof ui.listTasks === 'function') {
      ui.dispatchWindows('w1');
      ui.dispatchWindows('w2');
      ui.listTasks({ root: h.ws, only: 'finished-session', limit: 50 });
      ui.taskBrief(taskId(3));
      ui.taskLogProblem();
    }
  }
  spy.restore();
  const reads = spy.calls.filter((c) => ['openSync', 'readSync', 'readFileSync', 'readdirSync', 'opendirSync', 'createReadStream'].includes(c.fn));
  const stats = spy.calls.filter((c) => c.fn === 'statSync' || c.fn === 'lstatSync');
  check('1,000 refreshes of an unchanged log open and read nothing', reads.length === 0, { opensAndReads: reads.length, first: reads.slice(0, 3) });
  check('…and every look at the log is one stat of it', stats.length > 0 && stats.every((c) => c.path === h.log_) && stats.length <= 1000 * 7, { stats: stats.length, other: stats.filter((c) => c.path !== h.log_).slice(0, 3) });
  check('the Tasks tree lists the newest 300 and one closing row', rows.length === 301, rows.length);
  tasks.dispose();
  finish(h);
};

cases['IDX-model'] = async () => {
  const h = boot();
  const rng = prng(17);
  const ui = h.req('uiModel.js');
  const base = Date.now() - 4 * 3600_000;
  writeRegistry(h, { workers: [claudeWorker(h, 'w1'), claudeWorker(h, 'w2'), claudeWorker(h, 'w3')] });
  appendLines(h, mixedLines(h, rng, 0, 450, base));
  const now = Date.now();
  const build = () => ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [], now });
  const compare = (label) => {
    const model = build();
    const want = fullParse(h);
    const inScope = want.rows.filter((r) => inside(h.ws, r.cwd));
    const problems = [];
    if (model.taskTotal !== inScope.length) problems.push(`taskTotal ${model.taskTotal} ≠ ${inScope.length}`);
    const expTasks = inScope.slice(0, 300);
    if (model.tasks.length !== expTasks.length) problems.push(`tasks ${model.tasks.length} ≠ ${expTasks.length}`);
    for (let i = 0; i < Math.min(model.tasks.length, expTasks.length) && problems.length < 3; i++) {
      const t = model.tasks[i];
      const e = expTasks[i];
      const got = { id: t.id, title: t.title, status: t.status, mode: t.mode, worker: t.worker, model: t.model, startedAt: t.startedAt, endedAt: t.endedAt, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd, error: t.error, promptPreview: t.promptPreview, sessionWorker: t.sessionWorker, provider: t.provider };
      const exp = { id: e.id, title: e.title, status: e.status, mode: e.mode, worker: e.worker, model: e.model, startedAt: e.startedAt, endedAt: e.status === 'running' ? null : e.lastTs, inputTokens: e.detail.inputTokens, outputTokens: e.detail.outputTokens, costUsd: e.detail.costUsd, error: e.detail.error, promptPreview: e.detail.promptPreview, sessionWorker: e.sessionWorker, provider: e.provider };
      if (JSON.stringify(got) !== JSON.stringify(exp)) problems.push(`task ${i}: model ${show(got)} ≠ full parse ${show(exp)}`);
    }
    const running = { workspace: inScope.filter((r) => r.status === 'running').length, all: want.rows.filter((r) => r.status === 'running').length };
    if (JSON.stringify(model.running) !== JSON.stringify(running)) problems.push(`running ${show(model.running)} ≠ ${show(running)}`);
    for (const account of model.accounts.filter((a) => a.isWorker)) {
      const exp = want.windows(account.name, now);
      if (JSON.stringify({ session5h: account.session5h, week: account.week }) !== JSON.stringify(exp)) problems.push(`windows of ${account.name}: ${show({ s: account.session5h, w: account.week })} ≠ ${show(exp)}`);
      const expRunning = want.rows.filter((r) => r.status === 'running' && r.workerName === account.name).length;
      if (account.running !== expRunning) problems.push(`running of ${account.name}: ${account.running} ≠ ${expRunning}`);
    }
    check(`${label}: the dashboard model equals a full parse (${inScope.length} tasks in scope)`, problems.length === 0, problems.slice(0, 3));
    return model;
  };
  const first = compare('first build');
  check('the model always carries the two seam fields', Array.isArray(first.unsupportedAccounts) && first.unsupportedAccounts.length === 0 && first.health.registryProblem === null, { unsupportedAccounts: first.unsupportedAccounts, registryProblem: first.health.registryProblem });
  appendLines(h, mixedLines(h, rng, 450, 12, base));
  compare('after an append');
  // A log that cannot be opened for a moment (its content, and so the index, unchanged): the
  // rows not shown before have no details then — and get them once it can be opened again.
  if (process.getuid && process.getuid() !== 0) {
    const everywhere = () => ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'all', settings: {}, health: {}, sessions: [], now });
    const outsideWs = (model) => model.tasks.filter((t) => !t.inWorkspace);
    fs.chmodSync(h.log_, 0o000);
    const blind = everywhere();
    fs.chmodSync(h.log_, 0o600);
    const seeing = everywhere();
    check(
      'details that could not be read are absent, not remembered as absent',
      outsideWs(blind).length > 5 && outsideWs(blind).every((t) => t.promptPreview === null) && blind.tasks.length === seeing.tasks.length && outsideWs(seeing).every((t) => typeof t.promptPreview === 'string') && blind.health.taskLogProblem === null,
      { blind: outsideWs(blind).slice(0, 2).map((t) => t.promptPreview), seeing: outsideWs(seeing).slice(0, 2).map((t) => t.promptPreview), problem: blind.health.taskLogProblem },
    );
  }
  // the details of a row come from the log; when the log is swapped under the index they are absent, not wrong
  h.req('registry.js').clearTaskLog();
  appendLines(h, mixedLines(h, rng, 5000, 40, base));
  compare('after the log was cleared and written anew');
  finish(h);
};

/* ---- the 60 MiB budget ------------------------------------------------- */

cases['BUDGET-60mb'] = async () => {
  const h = boot();
  const contract = h.req('mesh/contract.js');
  const TASKS = 55_000;
  const LINE = 572; // bytes per event line with its line feed: 55,000 tasks × 2 events = 60.0 MiB
  const workers = [1, 2, 3, 4, 5, 6].map((i) => claudeWorker(h, `w${i}`));
  writeRegistry(h, { workers, claudePath: path.join(h.fakebin, 'claude') });
  const now = Date.now();
  const fd = fs.openSync(h.log_, 'w');
  let chunk = [];
  let bytes = 0;
  const MESH_FROM = TASKS - 150; // the newest 150 tasks ran on session workers
  for (let n = 0; n < TASKS; n++) {
    const id = taskId(n);
    const base = { id, title: `task number ${n} — refactor the widget module`, worker: `w${1 + (n % 6)}`, model: 'opus', cwd: h.ws, promptFile: `/cco-fixture/tasks/${id}.prompt.txt`, outputFile: `/cco-fixture/tasks/${id}.md` };
    if (n >= MESH_FROM) base.meshWorker = `cco-w-aaaaaa-w1-${n}`;
    for (const ev of [{ ...base, ts: now - 1e6 + n * 10, status: 'running', pid: 1 }, { ...base, ts: now - 1e6 + n * 10 + 1, status: 'done', inputTokens: 1000, outputTokens: 500, costUsd: 0.01 }]) {
      const bare = Buffer.byteLength(JSON.stringify({ ...ev, promptPreview: '' }));
      const line = JSON.stringify({ ...ev, promptPreview: 'x'.repeat(Math.max(0, LINE - 1 - bare)) }) + '\n';
      chunk.push(line);
      bytes += Buffer.byteLength(line);
    }
    if (chunk.length >= 4000) { fs.writeSync(fd, chunk.join('')); chunk = []; }
  }
  fs.writeSync(fd, chunk.join(''));
  fs.closeSync(fd);
  // 200 ledgers of 20 records each in other workspaces, and this workspace's own
  for (let i = 0; i < 200; i++) {
    const cwd = path.join(h.scratch, 'other', `ws${i}`);
    const recs = [];
    for (let k = 0; k < 20; k++) recs.push({ name: `cco-w-aaaaaa-w1-${k}`, account: 'w1', configDir: workers[0].configDir, jobId: (i * 100 + k).toString(16).padStart(8, '0'), model: 'opus', role: 'worker', spawnedAt: now - 5e6, stoppedAt: now - 4e6, taskId: `tzzzzzzz${k}` });
    fs.mkdirSync(path.dirname(contract.meshStateFile(cwd)), { recursive: true });
    fs.writeFileSync(contract.meshStateFile(cwd), JSON.stringify({ cwd, workers: recs }));
  }
  const load = os.loadavg()[0];
  info(`fixture: ${(bytes / 1048576).toFixed(2)} MiB, ${TASKS} tasks, ${2 * TASKS} events, 200 ledgers; 1-minute load average ${load.toFixed(2)}, ${os.cpus().length} CPUs`);
  const busy = load > 20;
  const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
  const timed = (fn) => { const t0 = process.hrtime.bigint(); const value = fn(); return { ms: ms(t0), value }; };
  const budget = (name, measured, limit) => {
    if (busy) skipLine(`${name} ≤ ${limit} ms`, `measured ${measured.toFixed(1)} ms, not judged: the 1-minute load average is ${load.toFixed(1)} (> 20)`);
    else check(`${name} ≤ ${limit} ms (measured ${measured.toFixed(1)} ms)`, measured <= limit, `${measured.toFixed(1)} ms`);
  };
  const heap = () => { if (global.gc) { global.gc(); global.gc(); } return process.memoryUsage().heapUsed; };

  const views = h.req('views.js');
  const hist = h.req('history-view.js');
  const ui = h.req('uiModel.js');
  const { WorkerManager } = h.req('workerManager.js');
  const heapBefore = heap();
  const tasks = new views.TasksProvider();
  const spy = spyFs(['openSync', 'readFileSync', 'readdirSync', 'opendirSync']);
  const first = timed(() => tasks.getChildren());
  spy.restore();
  const heapAfter = heap();
  budget('first getChildren of the Tasks tree', first.ms, 2000);
  const rows = first.value;
  check('the Tasks tree returns 300 tasks and the closing row', rows.length === 301 && rows.slice(0, 300).every((r) => typeof r.id === 'string'), rows.length);
  const openedForRows = spy.calls.filter((c) => c.path !== h.log_);
  check('getChildren opened no prompt file and no ledger (only the log)', openedForRows.length === 0, { other: openedForRows.length, first: openedForRows.slice(0, 3) });
  const perTask = (heapAfter - heapBefore) / TASKS;
  info(`index memory: heap +${((heapAfter - heapBefore) / 1048576).toFixed(1)} MiB after the first read = ${perTask.toFixed(0)} bytes per task (${global.gc ? 'after gc' : 'no gc available — rough'}); the log is ${(bytes / 1048576).toFixed(1)} MiB`);
  check('the index is a fraction of the log, not its text', heapAfter - heapBefore < bytes / 2, `${((heapAfter - heapBefore) / 1048576).toFixed(1)} MiB`);

  let worst = 0;
  for (let i = 0; i < 50; i++) worst = Math.max(worst, timed(() => tasks.getChildren()).ms);
  budget('every later getChildren with an unchanged log (worst of 50)', worst, 50);

  const spyRows = spyFs(['openSync', 'readFileSync', 'readdirSync', 'opendirSync']);
  // The first 300 rows and whatever closes the list — on a build that returns every task ever
  // logged, still only the 300 a tree would have to draw first.
  const built = timed(() => rows.slice(0, 301).map((r) => tasks.getTreeItem(r)));
  spyRows.restore();
  budget('building 300 rows (getTreeItem)', built.ms, 300);
  check('building the rows opened nothing', spyRows.calls.length === 0, { opens: spyRows.calls.length, first: spyRows.calls.slice(0, 3) });
  check('no task row carries a tooltip before it is hovered', built.value.slice(0, 300).every((item) => item.tooltip === undefined), built.value.slice(0, 300).filter((item) => item.tooltip !== undefined).length);

  const extra = [];
  for (let i = 0; i < 10; i++) extra.push(JSON.stringify({ id: taskId(900_000 + i), ts: Date.now() + i, status: 'running', title: `one more ${i}`, worker: 'w1', model: 'opus', cwd: h.ws }) + '\n');
  fs.appendFileSync(h.log_, extra.join(''));
  const spyAppend = spyFs(['readSync']);
  const after = timed(() => tasks.getChildren());
  spyAppend.restore();
  budget('getChildren after appending 10 events', after.ms, 50);
  check('the appended tasks lead the list', after.value[0] && after.value[0].title === 'one more 9', after.value[0] && after.value[0].title);
  info(`after the append the index made ${spyAppend.calls.length} read call(s)`);

  const wp = new views.WorkersProvider(new WorkerManager());
  const accounts = wp.getChildren();
  const expanded = timed(() => accounts.map((a) => wp.getChildren(a)));
  budget(`Workers tree: expanding ${accounts.length} accounts`, expanded.ms, 300);
  const week = expanded.value[0].find((r) => /Weekly/.test(r.label));
  check('an account row shows its dispatches of the week', week && /tasks/.test(week.description), week && week.description);

  const hp = new hist.WorkerHistoryProvider();
  const history = timed(() => hp.getChildren());
  info(`Worker History getChildren: ${history.ms.toFixed(1)} ms, ${history.value.length} rows`);
  const inputs = () => ({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
  const m1 = timed(() => ui.buildDashboardModel(inputs()));
  const m2 = timed(() => ui.buildDashboardModel(inputs()));
  info(`buildDashboardModel: first ${m1.ms.toFixed(1)} ms, unchanged ${m2.ms.toFixed(1)} ms; taskTotal ${m1.value.taskTotal}`);
  if (typeof tasks.resolveTreeItem === 'function') {
    const hover = timed(() => rows.slice(0, 20).map((r) => tasks.resolveTreeItem(tasks.getTreeItem(r), r)));
    info(`20 hovers (resolveTreeItem, session rows, 200 ledgers on disk): ${hover.ms.toFixed(1)} ms`);
  }
  info(`heap after everything: +${((heap() - heapBefore) / 1048576).toFixed(1)} MiB`);
  tasks.dispose(); wp.dispose(); hp.dispose();
  fs.rmSync(h.log_, { force: true });
  check('the 60 MiB fixture is deleted', !fs.existsSync(h.log_), 'still there');
  finish(h);
};

/* ---- tooltips ------------------------------------------------------------ */

function smallWorkspace(h) {
  const contract = h.req('mesh/contract.js');
  const now = Date.now();
  const w1 = claudeWorker(h, 'w1');
  writeRegistry(h, { workers: [w1], claudePath: path.join(h.fakebin, 'claude') });
  const lines = [];
  const ev = (n, status, extra = {}) => ({ id: taskId(n), ts: now - 600_000 + n * 100 + (status === 'running' ? 0 : 50), status, title: `task ${n}`, worker: 'w1', model: 'opus', cwd: h.ws, promptPreview: `PREVIEW-OF-${n}`, outputFile: path.join(h.tasksDir, `${taskId(n)}.md`), ...extra });
  for (let n = 0; n < 320; n++) {
    lines.push(JSON.stringify(ev(n, 'running')));
    lines.push(JSON.stringify(ev(n, 'done', { inputTokens: 10, outputTokens: 20, costUsd: 0.01 })));
  }
  // the newest rows: a session task with a prompt file and a ledger record, a failed task, a plain one
  const session = 1000;
  const failed = 1001;
  const plain = 1002;
  lines.push(JSON.stringify(ev(session, 'running', { meshWorker: 'cco-w-aaaaaa-w1-7', promptFile: path.join(h.tasksDir, `${taskId(session)}.prompt.txt`) })));
  lines.push(JSON.stringify(ev(session, 'done', { meshWorker: 'cco-w-aaaaaa-w1-7' })));
  const longError = 'exit code 1: the build failed\nsecond line of the error\n' + 'e'.repeat(900) + '\nTAILMARKER';
  lines.push(JSON.stringify(ev(failed, 'running')));
  lines.push(JSON.stringify(ev(failed, 'error', { error: longError })));
  lines.push(JSON.stringify(ev(plain, 'running')));
  fs.writeFileSync(h.log_, lines.join('\n') + '\n');
  fs.writeFileSync(path.join(h.tasksDir, `${taskId(session)}.prompt.txt`), 'FULLPROMPT of the session task\nwith a second line');
  fs.writeFileSync(path.join(h.tasksDir, `${taskId(session)}.md`), 'report of the session task\n');
  const worktree = path.join(h.ws, '.claude', 'worktrees', 'cco-session');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.dirname(contract.meshStateFile(h.ws)), { recursive: true });
  fs.writeFileSync(
    contract.meshStateFile(h.ws),
    JSON.stringify({
      cwd: h.ws,
      workers: [
        // an OLDER worker that carried the same name for another task: the join is the task id
        { name: 'cco-w-aaaaaa-w1-7', account: 'w1', configDir: w1.configDir, jobId: '0000aaaa', model: 'opus', role: 'worker', spawnedAt: now - 9e6, stoppedAt: now - 8e6, taskId: taskId(5), worktree: '.claude/worktrees/gone', branch: 'worktree-of-another-task' },
        { name: 'cco-w-aaaaaa-w1-7', account: 'w1', configDir: w1.configDir, jobId: '0000bbbb', model: 'opus', role: 'worker', spawnedAt: now - 1e6, stoppedAt: now - 5e5, taskId: taskId(session), worktree: path.relative(h.ws, worktree), branch: 'worktree-cco-session' },
      ],
    }),
  );
  return { session: taskId(session), failed: taskId(failed), plain: taskId(plain), longError };
}

cases['TOOLTIP-lazy'] = async () => {
  const h = boot();
  const ids = smallWorkspace(h);
  const views = h.req('views.js');
  const hist = h.req('history-view.js');
  const tasks = new views.TasksProvider();
  const spy = spyFs(['openSync', 'readFileSync', 'readdirSync', 'opendirSync']);
  const rows = tasks.getChildren();
  const items = rows.map((r) => tasks.getTreeItem(r));
  spy.restore();
  const other = spy.calls.filter((c) => c.path !== h.log_);
  check('getChildren + getTreeItem of 300 rows read no prompt file and no ledger', other.length === 0, { count: other.length, first: other.slice(0, 4) });
  check('no task row has a tooltip before it is hovered', items.slice(0, 300).every((item) => item.tooltip === undefined), items.slice(0, 300).filter((i) => i.tooltip !== undefined).length);
  check('the tree is the newest 300 tasks plus one closing row', rows.length === 301, rows.length);
  const last = items[items.length - 1];
  check('the closing row says how many are not listed and opens the dashboard', /Older tasks/.test(String(last.label)) && /23\b/.test(String(last.description)) && last.command && last.command.command === 'claudeCodeOrchestrator.openDashboard', { label: last.label, description: last.description, command: last.command });
  check('every task row passes its id — a string — to the output command', items.slice(0, 300).every((item, i) => item.command.command === 'claudeCodeOrchestrator.showTaskOutput' && item.command.arguments.length === 1 && item.command.arguments[0] === rows[i].id), items[0].command);
  const hover = (id) => {
    const at = rows.findIndex((r) => r.id === id);
    if (at === -1) return undefined;
    const item = typeof tasks.resolveTreeItem === 'function' ? tasks.resolveTreeItem(tasks.getTreeItem(rows[at]), rows[at]) : tasks.getTreeItem(rows[at]);
    return { item, text: item.tooltip && item.tooltip.value !== undefined ? item.tooltip.value : String(item.tooltip) };
  };
  check('this build resolves tooltips on hover', typeof tasks.resolveTreeItem === 'function', typeof tasks.resolveTreeItem);
  const s = hover(ids.session);
  check('hover of a session task: the full prompt from its prompt file', s && /FULLPROMPT/.test(s.text) && /second/.test(s.text), s && s.text.slice(0, 400));
  check('hover of a session task: worktree and branch of ITS ledger record', s && /worktree\\-cco\\-session/.test(s.text) && !/another/.test(s.text), s && s.text.slice(0, 400));
  check('hover of a session task: mode, id, model and account', s && /Mesh/.test(s.text) && s.text.includes(ids.session) && /opus/.test(s.text) && /w1/.test(s.text), s && s.text.slice(0, 300));
  const f = hover(ids.failed);
  check('hover of a failed task: the whole recorded error, not its first 240 characters', f && /TAILMARKER/.test(f.text) && /second/.test(f.text), f && f.text.slice(-200));
  check('hover of a task without a prompt file: the preview its event carries', f && /PREVIEW\\-OF\\-1001/.test(f.text), f && f.text.slice(0, 300));
  const p = hover(ids.plain);
  check('hover of a running task says since when', p && /Started/.test(p.text) && /running/.test(p.text), p && p.text.slice(0, 300));
  const failedItem = items[rows.findIndex((r) => r.id === ids.failed)];
  check('a failed row reads as an error', /error/.test(String(failedItem.description)) && failedItem.iconPath.id === 'error', { description: failedItem.description, icon: failedItem.iconPath });
  const runningItem = items[rows.findIndex((r) => r.id === ids.plain)];
  check('a running row offers Cancel (context value) and carries its id for it', runningItem.contextValue === 'runningTask' && rows.find((r) => r.id === ids.plain).id === ids.plain, runningItem.contextValue);

  // Worker History
  const hp = new hist.WorkerHistoryProvider();
  const spyH = spyFs(['openSync', 'readFileSync']);
  const hrows = hp.getChildren();
  const hitems = hrows.map((r) => hp.getTreeItem(r));
  spyH.restore();
  const promptReads = spyH.calls.filter((c) => c.path.startsWith(h.tasksDir));
  check('Worker History: one row for the finished session task', hrows.length === 1 && hrows[0].id === ids.session, hrows.map((r) => r.id));
  check('Worker History: drawing the row reads no prompt file', promptReads.length === 0 && hitems.every((i) => i.tooltip === undefined), { promptReads, tooltips: hitems.filter((i) => i.tooltip !== undefined).length });
  check('Worker History: the row shows the branch of its own record as unmerged', hitems[0] && /unmerged branch worktree-cco-session/.test(String(hitems[0].description)), hitems[0] && hitems[0].description);
  check('Worker History: the row passes its id to the output command', hitems[0] && hitems[0].command.arguments.length === 1 && hitems[0].command.arguments[0] === ids.session, hitems[0] && hitems[0].command);
  if (typeof hp.resolveTreeItem === 'function' && hrows.length === 1) {
    const tip = hp.resolveTreeItem(hp.getTreeItem(hrows[0]), hrows[0]).tooltip;
    check('Worker History: the hover carries the prompt and the branch', tip && /FULLPROMPT/.test(tip.value) && /unmerged/.test(tip.value), tip && tip.value.slice(0, 300));
  } else {
    check('Worker History: the hover is resolved lazily', false, typeof hp.resolveTreeItem);
  }
  // scope: every workspace
  tasks.scopeToWorkspace = false;
  fs.appendFileSync(h.log_, JSON.stringify({ id: taskId(7000), ts: Date.now(), status: 'done', title: 'from another workspace', worker: 'w1', model: 'opus', cwd: path.join(h.scratch, 'other-ws') }) + '\n');
  const allRows = tasks.getChildren();
  check('with the workspace filter off, a task of another workspace is listed first', allRows[0].title === 'from another workspace', allRows[0].title);
  tasks.scopeToWorkspace = true;
  check('with it on, it is not', tasks.getChildren()[0].title !== 'from another workspace', tasks.getChildren()[0].title);
  // an unreadable log is said, in both trees
  fs.renameSync(h.log_, `${h.log_}.parked`);
  fs.mkdirSync(h.log_);
  const broken = tasks.getChildren();
  const brokenItem = broken.length > 0 ? tasks.getTreeItem(broken[0]) : undefined;
  check('an unreadable task log is one row that says so, not an empty tree', broken.length === 1 && /could not be read/.test(String(brokenItem.label)) && /directory/.test(String(brokenItem.description)), { rows: broken.length, label: brokenItem && brokenItem.label, description: brokenItem && brokenItem.description });
  const brokenHistory = hp.getChildren();
  check('…and in Worker History too', brokenHistory.length === 1 && /could not be read/.test(String(hp.getTreeItem(brokenHistory[0]).label)), brokenHistory.length);
  tasks.dispose(); hp.dispose();
  finish(h);
};

/* ---- F9: nothing named by a log line is opened --------------------------- */

cases['F9-paths'] = async () => {
  const h = boot();
  const contract = h.req('mesh/contract.js');
  const now = Date.now();
  const w1 = claudeWorker(h, 'w1');
  writeRegistry(h, { workers: [w1], claudePath: path.join(h.fakebin, 'claude') });
  const secret = path.join(h.scratch, 'id_rsa');
  const SECRET = 'THIS-IS-A-SECRET-FILE-OUTSIDE-THE-DATA-ROOT';
  fs.writeFileSync(secret, `-----BEGIN-----\n${SECRET}\n-----END-----\n`);
  const link = path.join(h.ws, 'innocent-looking.md');
  fs.symlinkSync(secret, link);
  const planted = {
    outside: taskId(1), // both paths outside the data directory
    symlink: taskId(2), // both paths at a symbolic link
    hosts: taskId(3), // /etc/hosts
    history: taskId(4), // a finished session task, for Worker History
    running: taskId(5), // a running session task, for the cancel note
    linked: taskId(6), // its prompt file in tasks/ IS a symbolic link to the secret
    real: taskId(7), // an ordinary task with real files, as the control
  };
  const ev = (id, status, extra) => JSON.stringify({ id, ts: now - 1000 + Number.parseInt(id.slice(-5, -4), 36), status, title: `planted ${id}`, worker: 'w1', model: 'opus', cwd: h.ws, ...extra });
  const lines = [
    ev(planted.outside, 'done', { outputFile: secret, promptFile: secret }),
    ev(planted.symlink, 'done', { outputFile: link, promptFile: link }),
    ev(planted.hosts, 'done', { outputFile: '/etc/hosts', promptFile: '/etc/hosts' }),
    ev(planted.history, 'done', { outputFile: secret, promptFile: secret, meshWorker: 'cco-w-aaaaaa-w1-9' }),
    ev(planted.running, 'running', { outputFile: secret, promptFile: secret, meshWorker: 'cco-w-aaaaaa-w1-8' }),
    ev(planted.linked, 'done', { outputFile: path.join(h.tasksDir, `${planted.linked}.md`) }),
    ev(planted.real, 'done', { outputFile: path.join(h.tasksDir, `${planted.real}.md`), promptFile: path.join(h.tasksDir, `${planted.real}.prompt.txt`) }),
  ];
  fs.writeFileSync(h.log_, lines.join('\n') + '\n');
  fs.symlinkSync(secret, path.join(h.tasksDir, `${planted.linked}.prompt.txt`));
  fs.writeFileSync(path.join(h.tasksDir, `${planted.real}.md`), 'the real report\n');
  fs.writeFileSync(path.join(h.tasksDir, `${planted.real}.prompt.txt`), 'REALPROMPT text');
  fs.mkdirSync(path.dirname(contract.meshStateFile(h.ws)), { recursive: true });
  fs.writeFileSync(contract.meshStateFile(h.ws), JSON.stringify({ cwd: h.ws, workers: [] }));
  const secretBefore = fs.readFileSync(secret);
  const hostsBefore = fs.readFileSync('/etc/hosts');

  const views = h.req('views.js');
  const hist = h.req('history-view.js');
  const ui = h.req('uiModel.js');
  const forbidden = new Set([secret, link, '/etc/hosts', '/private/etc/hosts']);
  const spy = spyFs([...OPENERS, ...LOOKERS]);
  const tooltips = [];
  const argumentsSeen = [];
  for (const provider of [new views.TasksProvider(), new hist.WorkerHistoryProvider()]) {
    const rows = provider.getChildren();
    for (const row of rows) {
      let item = provider.getTreeItem(row);
      if (typeof provider.resolveTreeItem === 'function') item = provider.resolveTreeItem(item, row);
      tooltips.push(item.tooltip && item.tooltip.value !== undefined ? item.tooltip.value : String(item.tooltip ?? ''));
      if (item.command) argumentsSeen.push(...(item.command.arguments ?? []));
    }
    provider.dispose();
  }
  const model = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
  // the cancel of a running session task appends a note to the task's report
  const report = {};
  let cancelled;
  try {
    cancelled = await views.cancelTaskMeshAware(planted.running, 'cancelled by user', report);
  } catch (err) {
    cancelled = `threw: ${err && err.message}`;
  }
  spy.restore();

  const touched = spy.calls.filter((c) => forbidden.has(c.path) || forbidden.has(path.resolve(c.path)));
  check('no fs call of any kind names a path taken from the log', touched.length === 0, touched.slice(0, 5));
  const opened = spy.calls.filter((c) => OPENERS.includes(c.fn));
  const outsideData = opened.filter((c) => !c.path.startsWith(h.root + path.sep) && c.path !== h.root);
  check('everything opened is inside the data directory', outsideData.length === 0, outsideData.slice(0, 5));
  const taskFiles = opened.filter((c) => c.path.startsWith(h.tasksDir + path.sep));
  const expectedName = /^t[a-z0-9]{6,24}(\.md|\.prompt\.txt)$/;
  check('in tasks/ only <id>.md and <id>.prompt.txt of listed tasks were opened', taskFiles.length > 0 && taskFiles.every((c) => expectedName.test(path.basename(c.path))), taskFiles.map((c) => path.basename(c.path)).slice(0, 8));
  check('no hover shows the secret file', tooltips.every((t) => !t.includes('SECRET')), tooltips.filter((t) => t.includes('SECRET')).length);
  check('the control task still shows its real prompt', tooltips.some((t) => t.includes('REALPROMPT')), tooltips.length);
  check('every row command argument is a task id, never a path', argumentsSeen.length >= 7 && argumentsSeen.every((a) => typeof a === 'string' && TASK_ID.test(a)), argumentsSeen);
  check('the model has an output only for the task whose report is in tasks/', JSON.stringify(model.tasks.filter((t) => t.hasOutput).map((t) => t.id)) === JSON.stringify([planted.real]), model.tasks.map((t) => [t.id, t.hasOutput]));
  check('resolveTaskOutput: a planted id resolves to nothing, the real one to its file in tasks/', ui.resolveTaskOutput(planted.outside) === undefined && ui.resolveTaskOutput(planted.hosts) === undefined && ui.resolveTaskOutput(planted.real) === path.join(h.tasksDir, `${planted.real}.md`), [ui.resolveTaskOutput(planted.outside), ui.resolveTaskOutput(planted.real)]);
  check('resolveTaskOutput refuses ids that are not file names', ui.resolveTaskOutput('../registry') === undefined && ui.resolveTaskOutput(`${planted.real}/../x`) === undefined && ui.resolveTaskOutput(42) === undefined && ui.resolveTaskOutput(undefined) === undefined, 'resolved');
  check('the cancel closed the task', cancelled === true, { cancelled, report });
  check('the secret file is byte for byte what it was', fs.readFileSync(secret).equals(secretBefore), fs.readFileSync(secret, 'utf8').slice(-200));
  check('/etc/hosts is byte for byte what it was', fs.readFileSync('/etc/hosts').equals(hostsBefore), 'changed');
  const note = path.join(h.tasksDir, `${planted.running}.md`);
  check('the cancel note went to the report the task id names', fs.existsSync(note) && /CANCELLED: cancelled by user/.test(fs.readFileSync(note, 'utf8')), fs.existsSync(note) ? fs.readFileSync(note, 'utf8').slice(0, 200) : 'no file');
  // a report in tasks/ that is itself a symbolic link is not a report
  fs.symlinkSync(secret, path.join(h.tasksDir, `${planted.linked}.md`));
  check('a symbolic link at tasks/<id>.md is not an output', ui.resolveTaskOutput(planted.linked) === undefined, ui.resolveTaskOutput(planted.linked));
  finish(h);
};

/* ---- unsupported registry entries ---------------------------------------- */

cases['UNSUP-entries'] = async () => {
  const h = boot();
  const w1 = claudeWorker(h, 'w1');
  const vendorHome = path.join(h.home, '.opencode');
  fs.mkdirSync(path.join(vendorHome, 'sessions'), { recursive: true });
  const many = [];
  for (let i = 0; i < 21; i++) many.push({ name: `future${i}`, configDir: path.join(h.home, `.future${i}`), provider: `vendor-${i}` });
  const registry = {
    workers: [
      w1,
      // a usable account whose entry carries keys this file's node kinds use
      { name: 'kindly', configDir: path.join(h.home, '.claude-kindly'), model: 'opus', kind: 'stat', index: 0 },
      { name: 'oc', configDir: vendorHome, provider: 'opencode', model: 'big-pickle', permissionMode: 'full-auto' },
      { name: 'half' },
      { name: 'w1', configDir: path.join(h.home, '.claude-other') },
      42,
      { name: 'weird', configDir: path.join(h.home, '.weird'), provider: 7 },
      ...many,
    ],
    vendorWorkers: [
      { name: 'cx', configDir: path.join(h.home, '.codex-cx'), provider: 'codex' },
      { name: 'nothere', configDir: path.join(h.home, '.x') },
    ],
    claudePath: path.join(h.fakebin, 'claude'),
  };
  writeRegistry(h, registry);
  const registryBytes = fs.readFileSync(path.join(h.root, 'registry.json'));
  const now = Date.now();
  fs.writeFileSync(h.log_, [
    JSON.stringify({ id: taskId(1), ts: now - 5000, status: 'done', title: 'by oc', worker: 'oc', model: 'big-pickle', cwd: h.ws, inputTokens: 5, outputTokens: 5, costUsd: 1 }),
    JSON.stringify({ id: taskId(2), ts: now - 4000, status: 'running', title: 'by oc', worker: 'oc', model: 'big-pickle', cwd: h.ws }),
    JSON.stringify({ id: taskId(3), ts: now - 3000, status: 'done', title: 'by w1', worker: 'w1', model: 'opus', cwd: h.ws, inputTokens: 1, outputTokens: 2, costUsd: 0.1 }),
  ].join('\n') + '\n');

  const reg = h.req('registry.js');
  const entries = reg.readRegistry().unsupportedWorkers;
  check('fixture: the registry reader keeps 27 entries out of its workers', Array.isArray(entries) && entries.length === 27 && reg.readRegistry().workers.length === 3, { unsupported: entries && entries.length, workers: reg.readRegistry().workers.map((w) => w.name) });
  // every call of workerProvider, by anything loaded after this point
  const asked = [];
  const realWorkerProvider = reg.workerProvider;
  reg.workerProvider = (worker) => { asked.push(worker); return realWorkerProvider(worker); };

  const ui = h.req('uiModel.js');
  const views = h.req('views.js');
  const usage = h.req('usage.js');
  const team = h.req('team.js');
  const keepalive = h.req('keepalive.js');
  const { WorkerManager } = h.req('workerManager.js');
  // The dispatch server's wording of the three reasons, to compare the editor's with. If the
  // dispatch core cannot be loaded here, that is one failed check and the rest still runs
  // against the three sentences spelled out.
  let serverReason;
  try {
    serverReason = h.req('mcp/task-runner.js').unsupportedWorkerReason;
  } catch (err) {
    serverReason = undefined;
    check('the dispatch server\'s wording (mcp/task-runner.js) could be loaded for comparison', false, String(err && err.message).split('\n')[0]);
  }
  if (typeof serverReason !== 'function') {
    const flat = h.req('displayText.js');
    serverReason = (e) => (e.reason === 'provider' ? `unknown provider "${flat.sliceOneLine(flat.flattenOneLine(e.providerText), 80)}"` : e.reason === 'duplicate-name' ? 'duplicate name' : 'incomplete entry');
  }
  let threw;
  let model;
  let nodes = [];
  let items = [];
  const wp = new views.WorkersProvider(new WorkerManager());
  try {
    model = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: team.collectSessions({ workspaceRoot: h.ws, scope: 'all' }) });
    nodes = wp.getChildren();
    items = nodes.map((n) => wp.getTreeItem(n));
    for (const n of nodes) wp.getChildren(n).map((row) => wp.getTreeItem(row));
    ui.knownAccounts();
    usage.listAccounts();
    usage.listProviderAccounts();
    for (const w of reg.readRegistry().workers) usage.getCachedWorkerUsage(w);
    // a profile somebody built by hand with a provider this version does not know
    usage.getCachedWorkerUsage({ name: 'oc', configDir: vendorHome, provider: 'opencode' });
    usage.ownsUsageReading({ name: 'oc', configDir: vendorHome, provider: 'opencode' });
    views.sessionWorkersStrandedByRemoval({ name: 'oc', configDir: vendorHome, provider: 'opencode' });
    await keepalive.runKeepaliveSweep();
  } catch (err) {
    threw = String((err && err.stack) || err);
  }
  check('nothing throws with such a registry', threw === undefined, threw);

  // the model
  const expected = entries.slice(0, 20).map((e) => ({ name: e.name, detail: serverReason(e) }));
  check('the model lists at most 20 unsupported entries', model && Array.isArray(model.unsupportedAccounts) && model.unsupportedAccounts.length === 20, model && model.unsupportedAccounts && model.unsupportedAccounts.length);
  check('…each with the entry\'s name and the dispatch server\'s wording of why', model && JSON.stringify(model.unsupportedAccounts) === JSON.stringify(expected), { got: model && model.unsupportedAccounts && model.unsupportedAccounts.slice(0, 6), expected: expected.slice(0, 6) });
  const byName = (name) => model && (model.unsupportedAccounts ?? []).find((a) => a.name === name);
  check('the three reasons read: unknown provider "…", incomplete entry, duplicate name', byName('oc') && byName('oc').detail === 'unknown provider "opencode"' && byName('half').detail === 'incomplete entry' && byName('w1').detail === 'duplicate name' && byName('weird').detail === 'unknown provider "(number)"', [byName('oc'), byName('half'), byName('w1'), byName('weird')]);
  check('an element without a name is listed with the empty name', model && (model.unsupportedAccounts ?? []).some((a) => a.name === '' && a.detail === 'incomplete entry'), model && model.unsupportedAccounts && model.unsupportedAccounts.filter((a) => a.name === ''));
  check('every string of the list is within its cap', model && (model.unsupportedAccounts ?? []).every((a) => typeof a.name === 'string' && a.name.length <= 64 && typeof a.detail === 'string' && a.detail.length <= 80), 'over a cap');
  if (typeof ui.unsupportedEntryDetail === 'function') {
    const probes = [...entries, { reason: 'provider', providerText: 'a\u202eb "quoted" ' + 'z'.repeat(200) }, { reason: 'provider', providerText: '' }, { reason: 'shape', providerText: 'x' }, { reason: 'duplicate-name', providerText: '' }];
    const differing = probes.filter((e) => ui.unsupportedEntryDetail(e) !== serverReason(e));
    check('the editor words every reason exactly as the dispatch server does', differing.length === 0, differing.slice(0, 2).map((e) => [ui.unsupportedEntryDetail(e), serverReason(e)]));
  } else {
    check('the editor words every reason exactly as the dispatch server does', false, 'no uiModel.unsupportedEntryDetail in this build');
  }
  const accountNames = model ? model.accounts.map((a) => a.name) : [];
  check('no unsupported entry is an account', model && JSON.stringify(accountNames) === JSON.stringify(['main', 'w1', 'kindly', 'cx']), accountNames);
  const w1Account = model && model.accounts.find((a) => a.name === 'w1');
  check('…and none is counted: the dispatches recorded under "oc" belong to no account', model && model.accounts.every((a) => a.name === 'w1' ? a.week.tasks === 1 && a.running === 0 : a.week.tasks === 0 && a.running === 0), model && model.accounts.map((a) => [a.name, a.week.tasks, a.running]));
  check('known accounts, usage accounts and vendor accounts leave them out', JSON.stringify(ui.knownAccounts().map((a) => a.name)) === JSON.stringify(['main', 'w1', 'kindly', 'cx']) && JSON.stringify(usage.listAccounts().map((a) => a.name)) === JSON.stringify(['main', 'w1', 'kindly']) && JSON.stringify(usage.listProviderAccounts().map((a) => a.name)) === JSON.stringify(['cx']), { known: ui.knownAccounts().map((a) => a.name), usage: usage.listAccounts().map((a) => a.name), vendor: usage.listProviderAccounts().map((a) => a.name) });
  void w1Account;

  // the tree
  const usable = nodes.slice(0, 3);
  const rest = nodes.slice(3);
  check('the tree lists the usable accounts first', JSON.stringify(usable.map((n) => n.name)) === JSON.stringify(['w1', 'kindly', 'cx']) && items.slice(0, 3).every((i) => /^worker\./.test(String(i.contextValue))), { names: usable.map((n) => n.name), ctx: items.slice(0, 3).map((i) => i.contextValue) });
  check('…then one row per unsupported entry', rest.length === entries.length, { rows: rest.length, entries: entries.length });
  const shapeOk = rest.every((n, i) => JSON.stringify(Object.keys(n).sort()) === JSON.stringify(['index', 'kind', 'name']) && n.kind === 'unsupportedWorker' && n.index === i && n.name === entries[i].name);
  check('each node is exactly { kind: "unsupportedWorker", index, name } with the registry\'s index and name', shapeOk, rest.slice(0, 3));
  const restItems = items.slice(3);
  check('each row has the context value "unsupportedWorker", a warning icon and no children', restItems.length > 0 && restItems.every((i) => i.contextValue === 'unsupportedWorker' && i.iconPath && i.iconPath.id === 'warning' && i.collapsibleState === 0) && rest.every((n) => wp.getChildren(n).length === 0), restItems.slice(0, 2));
  check('label = the name, description = why', restItems.length > 0 && restItems.every((item, i) => (entries[i].name === '' ? item.label === '(unnamed entry)' : item.label === entries[i].name) && item.description === serverReason(entries[i])), restItems.slice(0, 6).map((i) => [i.label, i.description]));
  check('the tooltip says this version cannot use it and a newer one may have written it', restItems.length > 0 && restItems.every((i) => /cannot use/.test(String(i.tooltip)) && /newer version/.test(String(i.tooltip))), restItems[0] && restItems[0].tooltip);
  const idsGiven = items.map((i) => i.id).filter((id) => id !== undefined);
  check('the account rows have unique ids and the rows about the registry have none to collide with', new Set(idsGiven).size === idsGiven.length && idsGiven.length === 3 && restItems.every((i) => i.id === undefined), items.map((i) => i.id).slice(0, 6));
  const kindly = items[1];
  check('a usable account whose entry has a "kind" key is still drawn as an account', kindly && kindly.contextValue === 'worker.claude' && wp.getChildren(nodes[1]).length >= 4, kindly && { ctx: kindly.contextValue, children: wp.getChildren(nodes[1]).length });

  // workerProvider was never asked about one of them by a view or the model
  const unknown = asked.filter((w) => w && w.provider !== undefined && w.provider !== null && !['claude', 'codex', 'cursor', 'gemini'].includes(w.provider));
  const fromSurfaces = unknown.filter((w) => !(w.name === 'oc' && w.configDir === vendorHome)); // the three hand-built probes above
  check('workerProvider is never asked about an unsupported entry', asked.length > 0 && fromSurfaces.length === 0, fromSurfaces.slice(0, 3));
  reg.workerProvider = realWorkerProvider;
  // nothing ran `claude` against the other vendor's directory, and the registry file is untouched
  const calls = fs.existsSync(h.callLog) ? fs.readFileSync(h.callLog, 'utf8') : '';
  check('no CLI was started against an unsupported entry\'s directory', !calls.includes('.opencode') && !calls.includes('.future'), calls.slice(0, 300));
  check('the registry file is byte for byte what it was', fs.readFileSync(path.join(h.root, 'registry.json')).equals(registryBytes), 'changed');

  // more than the tree lists
  const flood = { workers: [w1] };
  for (let i = 0; i < 450; i++) flood.workers.push(i);
  writeRegistry(h, flood);
  const floodNodes = wp.getChildren();
  const closing = wp.getTreeItem(floodNodes[floodNodes.length - 1]);
  check('450 nameless elements: 200 rows and one that counts the rest', floodNodes.length === 1 + 200 + 1 && /250/.test(String(closing.description)), { rows: floodNodes.length, closing: closing.description });
  wp.dispose();
  finish(h);
};

/* ---- a registry that cannot be read --------------------------------------- */

cases['REGPROB-registry'] = async () => {
  const h = boot();
  const file = path.join(h.root, 'registry.json');
  const SECRETISH = 'sk-PRIVATE-0123456789';
  const text = `{\n  "workers": [\n    { "name": "w1", "configDir": "${path.join(h.home, '.claude-w1')}", "note": "${SECRETISH}" },\n  ],\n  "custom": true\n}\n`;
  fs.writeFileSync(file, text);
  const bytes = fs.readFileSync(file);
  const ui = h.req('uiModel.js');
  const views = h.req('views.js');
  const team = h.req('team.js');
  const { WorkerManager } = h.req('workerManager.js');
  const wp = new views.WorkersProvider(new WorkerManager());
  const tasks = new views.TasksProvider();
  let threw;
  let model;
  let nodes = [];
  let items = [];
  try {
    for (let i = 0; i < 10; i++) {
      model = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: team.collectSessions({ workspaceRoot: h.ws, scope: 'workspace' }) });
      nodes = wp.getChildren();
      items = nodes.map((n) => wp.getTreeItem(n));
      for (const n of nodes) wp.getChildren(n);
      tasks.getChildren();
      ui.knownAccounts();
      ui.resolveAccount('0123456789abcdef');
    }
  } catch (err) {
    threw = String((err && err.stack) || err);
  }
  check('ten refreshes of a registry with a trailing comma throw nothing', threw === undefined, threw);
  const problem = model && model.health.registryProblem;
  check('the model says the registry could not be read', typeof problem === 'string' && problem.length > 0 && problem.length <= 200 && /JSON/.test(problem), problem);
  check('…in words that quote nothing of the file', typeof problem === 'string' && !problem.includes(SECRETISH) && !problem.includes('w1') && !problem.includes(h.home), problem);
  check('…and lists no accounts and no unsupported entries', model && model.accounts.length === 0 && Array.isArray(model.unsupportedAccounts) && model.unsupportedAccounts.length === 0, model && { accounts: model.accounts.map((a) => a.name), unsupported: model.unsupportedAccounts });
  const first = items[0];
  check('the Workers tree opens with a row that states the problem', first && /could not be read/.test(String(first.label)) && first.description === problem, first && { label: first.label, description: first.description });
  check('…whose click opens the registry file with the editor\'s own vscode.open', first && first.command && first.command.command === 'vscode.open' && first.command.arguments.length === 1 && first.command.arguments[0].fsPath === file && first.command.arguments[0].scheme === 'file', first && first.command);
  check('…and which is not an account row', first && !/^worker\./.test(String(first.contextValue)) && wp.getChildren(nodes[0]).length === 0, first && first.contextValue);
  check('the tree shows nothing else', nodes.length === 1, nodes.length);
  check('the registry file is byte for byte what it was', fs.readFileSync(file).equals(bytes), 'changed');

  // other states of the same path
  const variants = [
    ['merge markers', '<<<<<<< HEAD\n{"workers":[]}\n=======\n{"workers":[]}\n>>>>>>> x\n', true],
    ['a JSON array', '[]', true],
    ['"workers" is not a list', '{"workers":{"w1":{}}}', true],
    ['a byte-order mark before a valid file', '\ufeff' + JSON.stringify({ workers: [claudeWorker(h, 'w1')] }), false],
    ['an empty file', '', false],
  ];
  for (const [label, content, broken] of variants) {
    await sleep(15);
    fs.writeFileSync(file, content);
    const m = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
    const rows = wp.getChildren();
    const top = rows.length > 0 ? wp.getTreeItem(rows[0]) : undefined;
    const said = typeof m.health.registryProblem === 'string';
    const row = top !== undefined && top.contextValue === 'registryProblem';
    check(`${label}: ${broken ? 'a problem in the model and a row in the tree' : 'no problem'}`, said === broken && row === broken && (broken ? m.accounts.length === 0 : m.accounts.length >= 1), { registryProblem: m.health.registryProblem, top: top && top.label, accounts: m.accounts.map((a) => a.name) });
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  const dirModel = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
  const dirRows = wp.getChildren();
  check('a directory at the path: a problem in the model and a row in the tree', typeof dirModel.health.registryProblem === 'string' && dirRows.length === 1 && wp.getTreeItem(dirRows[0]).contextValue === 'registryProblem', { registryProblem: dirModel.health.registryProblem, rows: dirRows.length });
  fs.rmdirSync(file);
  const noneModel = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace', settings: {}, health: {}, sessions: [] });
  check('no registry at all is a first run, not a problem', noneModel.health.registryProblem === null && noneModel.accounts.length === 1 && wp.getChildren().length === 0, { registryProblem: noneModel.health.registryProblem, accounts: noneModel.accounts.length, rows: wp.getChildren().length });
  wp.dispose(); tasks.dispose();
  finish(h);
};

/* ---- the probes' output caps ---------------------------------------------- */

/**
 * A stand-in for `claude` (or for the provider helper) that can flood one of its streams:
 * 50 MiB without a single line feed, then it stays alive. What it does is read from
 * <home>/fake-mode; it records its pid and, one line per chunk, how many bytes it has handed
 * to the stream so far (appended, so that being killed mid-write cannot blank the record).
 */
function floodScript(h) {
  return `#!${process.execPath}
const fs = require('fs');
const dir = ${JSON.stringify(h.home)};
let mode = 'quiet';
try { mode = fs.readFileSync(dir + '/fake-mode', 'utf8').trim(); } catch {}
fs.appendFileSync(dir + '/cli-calls.log', 'fake ' + process.argv.slice(2).join(' ') + ' | CLAUDE_CONFIG_DIR=' + (process.env.CLAUDE_CONFIG_DIR ?? '<unset>') + '\\n');
fs.writeFileSync(dir + '/fake-pid', String(process.pid));
fs.writeFileSync(dir + '/fake-progress', '0\\n');
if (mode === 'ok') { process.stdout.write('OK\\n'); process.exit(0); }
if (mode === 'flood-stdout' || mode === 'flood-stderr') {
  const stream = mode === 'flood-stdout' ? process.stdout : process.stderr;
  stream.on('error', () => process.exit(0));
  const chunk = Buffer.alloc(65536, 0x78);
  const target = 50 * 1024 * 1024;
  let total = 0;
  const pump = () => {
    while (total < target) {
      total += chunk.length;
      fs.appendFileSync(dir + '/fake-progress', total + '\\n');
      if (!stream.write(chunk)) { stream.once('drain', pump); return; }
    }
  };
  pump();
}
process.stdin.resume();
setInterval(() => {}, 1000);
`;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function goneWithin(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

cases['USAGE-caps'] = async () => {
  const h = boot();
  const fake = path.join(h.fakebin, 'claude');
  fs.writeFileSync(fake, floodScript(h));
  fs.chmodSync(fake, 0o755);
  const w1 = claudeWorker(h, 'w1');
  fs.mkdirSync(w1.configDir, { recursive: true });
  writeRegistry(h, { workers: [w1], claudePath: fake });
  const usage = h.req('usage.js');
  const ui = h.req('uiModel.js');
  const setMode = (mode) => fs.writeFileSync(path.join(h.home, 'fake-mode'), mode);
  const progress = () => Math.max(0, ...fs.readFileSync(path.join(h.home, 'fake-progress'), 'utf8').split('\n').map(Number).filter(Number.isFinite));
  const pid = () => Number(fs.readFileSync(path.join(h.home, 'fake-pid'), 'utf8'));
  const TIMEOUT = 8000;

  for (const stream of ['stdout', 'stderr']) {
    setMode(`flood-${stream}`);
    const t0 = Date.now();
    const reading = await usage.fetchAccountUsage('w1', w1.configDir, TIMEOUT);
    const took = Date.now() - t0;
    const child = pid();
    check(`usage probe, 50 MiB on ${stream} without a line feed: fails as "output too large"`, reading.error === 'output too large' && reading.available === false, { error: String(reading.error).slice(0, 120), took });
    check(`…well before its ${TIMEOUT} ms timeout`, took < TIMEOUT / 2, `${took} ms`);
    const dead = await goneWithin(child, 6000);
    const wrote = progress();
    check('…and the child is ended, having written a small part of what it meant to', dead && wrote < 16 * 1024 * 1024, { dead, wroteMiB: (wrote / 1048576).toFixed(1) });
    info(`usage probe / ${stream}: resolved after ${took} ms; the child had written ${(wrote / 1048576).toFixed(1)} MiB of 50 when it was ended`);
    if (!dead) { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } }
  }

  for (const stream of ['stdout', 'stderr']) {
    setMode(`flood-${stream}`);
    const t0 = Date.now();
    const status = await usage.fetchAuthStatus(w1.configDir, TIMEOUT);
    const took = Date.now() - t0;
    const child = pid();
    check(`login probe, 50 MiB on ${stream}: "unknown", and not after its whole timeout`, status === undefined && took < TIMEOUT / 2, { status, took });
    const dead = await goneWithin(child, 6000);
    check('…and the child is ended', dead && progress() < 16 * 1024 * 1024, { dead, wroteMiB: (progress() / 1048576).toFixed(1) });
    if (!dead) { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } }
  }

  setMode('flood-stdout');
  const t0 = Date.now();
  const version = await ui.probeClaudeVersion(fake);
  const took = Date.now() - t0;
  const child = pid();
  check('version probe, 50 MiB on stdout: no version, and not after its whole 8 s timeout', version === null && took < 4000, { version, took });
  check('…and the child is ended', await goneWithin(child, 6000), 'still alive');
  try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }

  // an ordinary child is unaffected: one that says nothing still times out as before
  setMode('quiet');
  const quiet = await usage.fetchAccountUsage('w1', w1.configDir, 1500);
  check('a silent child still fails by its timeout, not by the cap', quiet.error === 'timeout', quiet.error);
  await goneWithin(pid(), 7000);
  check('the e-mail reader that read the wrong file is gone', usage.readOauthEmail === undefined, typeof usage.readOauthEmail);
  finish(h);
};

cases['USAGE-helper-cap'] = async () => {
  const h = boot();
  const helper = path.join(h.home, 'fake-provider-cli.js');
  fs.writeFileSync(helper, floodScript(h).replace(/^#!.*\n/, ''));
  const cx = { name: 'cx', configDir: path.join(h.home, '.codex-cx'), provider: 'codex' };
  fs.mkdirSync(cx.configDir, { recursive: true });
  writeRegistry(h, { workers: [], vendorWorkers: [cx], claudePath: path.join(h.fakebin, 'claude') });
  fs.writeFileSync(path.join(h.home, 'fake-mode'), 'flood-stdout');
  const usage = h.req('usage.js');
  const t0 = Date.now();
  await usage.refreshProviderUsage({ helperPath: helper, polling: false, force: true });
  const took = Date.now() - t0;
  const entry = usage.readUsageCache()[cx.configDir];
  check('provider helper, 50 MiB on stdout: recorded as "output too large"', entry && /output too large/.test(String(entry.error)), entry && String(entry.error).slice(0, 160));
  check('…long before its 25 s timeout', took < 10_000, `${took} ms`);
  const child = Number(fs.readFileSync(path.join(h.home, 'fake-pid'), 'utf8'));
  check('…and the helper is ended', await goneWithin(child, 6000), 'still alive');
  try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
  finish(h);
};

/* ---- keepalive: an unreadable log is not "nothing is running" ------------- */

function keepaliveFixture(h) {
  const fake = path.join(h.fakebin, 'claude');
  fs.writeFileSync(fake, floodScript(h));
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(path.join(h.home, 'fake-mode'), 'ok');
  const w2 = claudeWorker(h, 'w2');
  fs.mkdirSync(w2.configDir, { recursive: true });
  writeRegistry(h, { workers: [w2], claudePath: fake });
  fs.writeFileSync(path.join(h.root, 'usage.json'), JSON.stringify({ [w2.configDir]: { name: 'w2', configDir: w2.configDir, available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: Date.now() } }));
  return w2;
}
const pings = (h) => (fs.existsSync(h.callLog) ? fs.readFileSync(h.callLog, 'utf8').split('\n').filter((l) => l.includes('Reply with exactly')).length : 0);

cases['KEEPALIVE-unreadable'] = async () => {
  const h = boot();
  keepaliveFixture(h);
  const keepalive = h.req('keepalive.js');
  // the task log is a directory: which accounts are busy is unknown
  fs.mkdirSync(h.log_);
  await keepalive.runKeepaliveSweep();
  check('with an unreadable task log no account is pinged', pings(h) === 0, `${pings(h)} ping(s)`);
  fs.rmdirSync(h.log_);
  await keepalive.runKeepaliveSweep();
  check('with no task log at all (nothing was ever dispatched) the idle account is pinged', pings(h) === 1, `${pings(h)} ping(s)`);
  const stamps = keepalive.readKeepaliveStamps();
  check('…and stamped', Object.keys(stamps).length === 1 && Number.isFinite(Object.values(stamps)[0].lastSuccessAt), stamps);
  // the stamp file as a symbolic link to somebody else's file is not read through
  const stampFile = path.join(h.root, 'keepalive.json');
  const elsewhere = path.join(h.scratch, 'elsewhere.json');
  fs.renameSync(stampFile, elsewhere);
  fs.symlinkSync(elsewhere, stampFile);
  check('a symbolic link at keepalive.json is not followed', Object.keys(keepalive.readKeepaliveStamps()).length === 0, keepalive.readKeepaliveStamps());
  finish(h);
};

cases['KEEPALIVE-fifo'] = async () => {
  const h = boot();
  keepaliveFixture(h);
  const keepalive = h.req('keepalive.js');
  execFileSync('mkfifo', [path.join(h.root, 'keepalive.json')]);
  // On a build that reads the stamp file unguarded this call never returns, and the parent
  // reports the case as not having run to its end.
  const t0 = Date.now();
  const stamps = keepalive.readKeepaliveStamps();
  check('a pipe at keepalive.json does not block the reader', Object.keys(stamps).length === 0 && Date.now() - t0 < 2000, { stamps, ms: Date.now() - t0 });
  finish(h);
};

/* ---- smaller items --------------------------------------------------------- */

cases['MISC-small'] = async () => {
  const h = boot();
  const contract = h.req('mesh/contract.js');
  const ui = h.req('uiModel.js');
  const usage = h.req('usage.js');
  const views = h.req('views.js');
  const w3 = claudeWorker(h, 'w3');
  writeRegistry(h, { workers: [w3], claudePath: path.join(h.fakebin, 'claude') });

  // validateSetting('claudePath') applies the platform's rule
  const v = (value) => ui.validateSetting('claudePath', value);
  const refused = ['$(touch /tmp/x)', '`touch x`', './tools/claude', 'tools/claude', '~/bin/claude', 'claude; rm -rf x', 'cl aude', 'claude\u0007', '', '   ', 'x'.repeat(2000), 'a\nb', 42, null];
  const wrongly = refused.filter((value) => v(value).ok !== false);
  check('claudePath: anything but a command name or an absolute path is refused', wrongly.length === 0, wrongly);
  const accepted = [['claude', 'claude'], ['  claude  ', 'claude'], ['claude-2.1', 'claude-2.1'], ['/usr/local/bin/claude', '/usr/local/bin/claude'], ['/Applications/My Tools/claude', '/Applications/My Tools/claude']];
  const wrong = accepted.filter(([value, want]) => { const r = v(value); return !(r.ok === true && r.value === want); });
  check('claudePath: a command name or an absolute path is accepted, trimmed', wrong.length === 0, wrong.map(([value]) => [value, v(value)]));

  // the usage cache is this product's own file: a link at its name is not followed
  const cacheFile = path.join(h.root, 'usage.json');
  const elsewhere = path.join(h.scratch, 'usage-elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ [w3.configDir]: { name: 'w3', configDir: w3.configDir, available: true, subscriptionType: 'max', windows: [], fetchedAt: Date.now() } }));
  fs.symlinkSync(elsewhere, cacheFile);
  check('a symbolic link at usage.json is not followed', Object.keys(usage.readUsageCache()).length === 0, Object.keys(usage.readUsageCache()));
  fs.rmSync(cacheFile);
  fs.copyFileSync(elsewhere, cacheFile);
  check('the usage cache itself is still read', Object.keys(usage.readUsageCache()).length === 1, Object.keys(usage.readUsageCache()));

  // a ledger in the mesh directory that is a symbolic link is not followed
  fs.mkdirSync(contract.MESH_STATE_DIR, { recursive: true });
  const record = (jobId) => ({ name: 'cco-w-aaaaaa-w3-1', account: 'w3', configDir: w3.configDir, jobId, model: 'opus', role: 'worker', spawnedAt: Date.now() - 1000, taskId: taskId(1) });
  const outsideLedger = path.join(h.scratch, 'ledger-elsewhere.json');
  fs.writeFileSync(outsideLedger, JSON.stringify({ cwd: h.ws, workers: [record('aaaa1111')] }));
  fs.symlinkSync(outsideLedger, path.join(contract.MESH_STATE_DIR, 'ffffffffffffffff.json'));
  check('a symbolic link among the ledgers is not followed', views.sessionWorkersStrandedByRemoval(w3).length === 0, views.sessionWorkersStrandedByRemoval(w3));
  fs.writeFileSync(path.join(contract.MESH_STATE_DIR, 'eeeeeeeeeeeeeeee.json'), JSON.stringify({ cwd: h.ws, workers: [record('bbbb2222')] }));
  const tracked = views.sessionWorkersStrandedByRemoval(w3);
  check('a real ledger beside it still is', tracked.length === 1 && tracked[0].jobId === 'bbbb2222', tracked);

  // a session entry of the CLI that is a symbolic link is not read through
  const team = h.req('team.js');
  const sessions = path.join(h.home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const entry = (pid, name) => JSON.stringify({ pid, sessionId: `${String(pid).padStart(8, '0')}-0000-0000-0000-000000000000`, cwd: h.ws, kind: 'interactive', name, status: 'idle', startedAt: Date.now() - 5000, updatedAt: Date.now(), messagingSocketPath: `/tmp/cc-socks/${pid}.sock` });
  const entryElsewhere = path.join(h.scratch, 'entry-elsewhere.json');
  fs.writeFileSync(entryElsewhere, entry(process.pid, 'linked-session'));
  fs.symlinkSync(entryElsewhere, path.join(sessions, `${process.pid}.json`));
  fs.writeFileSync(path.join(sessions, `${process.ppid}.json`), entry(process.ppid, 'real-session'));
  team.invalidateTeamCache();
  const live = team.collectSessions({ workspaceRoot: h.ws, scope: 'workspace', maxAgeMs: 0 }).map((row) => row.name);
  check('a symbolic link among the session entries is not followed; a real entry is listed', live.includes('real-session') && !live.includes('linked-session'), live);

  // a cancel that cannot read the log says so instead of "not running"
  fs.mkdirSync(h.log_);
  const report = {};
  const cancelled = await views.cancelTaskMeshAware(taskId(1), 'cancelled by user', report);
  check('a cancel with an unreadable log reports that the log could not be read', cancelled === false && report.logUnreadable === true, { cancelled, report });
  finish(h);
};

const run = cases[CASE];
if (!run) {
  console.log(`FAIL ${CASE}: no such case`);
  process.exit(1);
}
run().catch((err) => {
  console.log(`FAIL ${CASE}: the case threw — ${String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ')}`);
  process.exit(1);
});
