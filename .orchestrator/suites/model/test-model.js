'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* Drives the bundled uiModel against fixture files under a temp HOME. Usage:
 *   env -i HOME=<tmp> PATH=$PATH node test-model.js <bundle.js>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
if (process.env.CLAUDE_CONFIG_DIR) {
  console.error('refusing to run: CLAUDE_CONFIG_DIR is set');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, cond, observed) {
  if (cond) {
    pass++;
    console.log('PASS — ' + name + (observed !== undefined ? ': ' + observed : ''));
  } else {
    fail++;
    console.log('FAIL — ' + name + (observed !== undefined ? ': ' + observed : ''));
  }
}
function noThrow(name, fn) {
  try {
    const v = fn();
    check(name + ' does not throw', true);
    return v;
  } catch (e) {
    check(name + ' does not throw', false, String(e && e.stack));
    return undefined;
  }
}

const ROOT = path.join(HOME, '.claude-code-orchestrator');
const TASKS = path.join(ROOT, 'tasks');
const LOG = path.join(ROOT, 'tasks.jsonl');
const WS = path.join(HOME, 'ws', 'proj');
const WS2 = path.join(HOME, 'ws', 'proj-2');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(path.join(WS, 'sub'), { recursive: true });
fs.mkdirSync(WS2, { recursive: true });

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const tid = () => 't' + (1000000 + ++seq).toString(36).padStart(8, '0');
const out = (id) => path.join(TASKS, id + '.md');
const lines = [];
const ev = (o) => lines.push(JSON.stringify(o));
const base = (id, extra) => Object.assign({ id, title: 'task ' + id, worker: 'w1', model: 'opus', outputFile: out(id), cwd: WS }, extra);

// --- hostile lines -------------------------------------------------------------------
lines.push('null');
lines.push('this is not json {');
lines.push('[1,2,3]');
lines.push('42');
lines.push('"a string"');
ev({ ts: NOW - 1000, status: 'running', title: 'no id', worker: 'w1', model: 'opus', cwd: WS });
ev({ ts: NOW - 1000, id: '../../etc/passwd', status: 'done', title: 'bad id', worker: 'w1', model: 'opus', outputFile: '/etc/passwd', cwd: WS });
const WEIRD = tid();
ev(base(WEIRD, { ts: NOW - 5000, status: 'weird' }));
const BADTS = tid();
ev(base(BADTS, { ts: '<img src=x onerror=alert(1)>', status: 'done' }));

const BIDI = '‮⁦​';
const A = tid();
const hostileTitle = BIDI + 'evil\u0007title\n' + 'x'.repeat(5000) + '‮';
ev(base(A, { ts: NOW - 60000, status: 'running', title: hostileTitle, ioToken: 'SECRET-IO-TOKEN', detachIoToken: 'SECRET-DETACH-TOKEN', promptFile: '/abs/secret/prompt.txt', promptPreview: 'p'.repeat(1000) }));
// costUsd 1e999 parses to Infinity; inputTokens is markup.
lines.push(
  JSON.stringify(base(A, { ts: NOW - 30000, status: 'done', title: hostileTitle, inputTokens: '<img src=x onerror=alert(1)>', outputTokens: 12, ioToken: 'SECRET-IO-TOKEN', promptPreview: 'p'.repeat(1000) })).replace(/}$/, ',"costUsd":1e999}'),
);
fs.writeFileSync(out(A), '# out');

const B = tid();
ev(base(B, { ts: NOW - 50000, status: 'running' }));
ev(base(B, { ts: NOW - 40000, status: 'error', error: 'cancelled by user' }));
const C = tid();
ev(base(C, { ts: NOW - 50000, status: 'running' }));
ev(base(C, { ts: NOW - 39000, status: 'error', error: 'orphaned — worker process is no longer running' }));
const D = tid();
ev(base(D, { ts: NOW - 50000, status: 'running' }));
ev(base(D, { ts: NOW - 38000, status: 'error', error: 'worker reported failure: boom ' + 'e'.repeat(1000) }));
const E = tid();
ev(base(E, { ts: NOW - 50000, status: 'running' }));
ev(base(E, { ts: NOW - 37000, status: 'done', inputTokens: 100, outputTokens: 200, costUsd: 0.5 }));
fs.writeFileSync(out(E), '# real output');
const F = tid();
ev(base(F, { ts: NOW - 20000, status: 'running' }));
ev(base(F, { ts: NOW - 19000, status: 'running', pid: 4242, pgid: 4242 }));
const G = tid();
ev(base(G, { ts: NOW - 50000, status: 'running' }));
ev(base(G, { ts: NOW - 36000, status: 'done', meshWorker: 'cco-w-abc123-w1-1', inputTokens: 0, outputTokens: 0, costUsd: 0 }));
const H = tid();
ev(base(H, { ts: NOW - 50000, status: 'running', supervisorPid: 777 }));
ev(base(H, { ts: NOW - 35000, status: 'done', supervisorPid: 777, inputTokens: 5, outputTokens: 6, costUsd: 0.01 }));
const I = tid();
ev(base(I, { ts: NOW - 50000, status: 'running', cwd: WS2 }));
ev(base(I, { ts: NOW - 34000, status: 'done', cwd: WS2, inputTokens: 1, outputTokens: 1, costUsd: 0 }));
const J = tid();
ev(base(J, { ts: NOW - 50000, status: 'running', cwd: path.join(WS, 'sub') }));
ev(base(J, { ts: NOW - 33000, status: 'done', cwd: path.join(WS, 'sub'), inputTokens: 1, outputTokens: 1, costUsd: 0 }));
const K = tid();
ev(base(K, { ts: NOW - 50000, status: 'running' }));
ev(base(K, { ts: NOW - 32000, status: 'error', error: '  CANCELLED   by the orchestrator session' }));
const L = tid();
ev(base(L, { ts: NOW - 31000, status: 'error', error: 'failed with no start event' }));
const M = tid(); // running in another workspace, on worker w1
ev(base(M, { ts: NOW - 10000, status: 'running', cwd: WS2 }));
const N = tid(); // output file points outside the tasks dir
ev(base(N, { ts: NOW - 50000, status: 'running', outputFile: '/etc/passwd' }));
ev(base(N, { ts: NOW - 29000, status: 'done', outputFile: '/etc/passwd', inputTokens: -5, outputTokens: 1.5e300, costUsd: 1 }));
const O = tid(); // output file in a sibling dir sharing the prefix
fs.mkdirSync(TASKS + '-evil', { recursive: true });
fs.writeFileSync(path.join(TASKS + '-evil', O + '.md'), 'x');
ev(base(O, { ts: NOW - 28000, status: 'done', outputFile: path.join(TASKS + '-evil', O + '.md') }));
const P = tid(); // symlink inside tasks dir pointing outside
fs.writeFileSync(path.join(HOME, 'outside-secret.txt'), 'secret');
fs.symlinkSync(path.join(HOME, 'outside-secret.txt'), out(P));
ev(base(P, { ts: NOW - 27000, status: 'done' }));
const Q = tid(); // traversal that resolves outside
ev(base(Q, { ts: NOW - 26000, status: 'done', outputFile: path.join(TASKS, '..', '..', 'outside-secret.txt') }));
const R = tid(); // missing output file on disk
ev(base(R, { ts: NOW - 25000, status: 'done' }));
const S = tid(); // relative cwd and non-string fields
ev({ id: S, ts: NOW - 24000, status: 'done', title: 12345, worker: { a: 1 }, model: null, outputFile: 'relative/out.md', cwd: '.' });

const SPECIAL = [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S];
const inWs = new Set([A, B, C, D, E, F, G, H, J, K, L, N, O, P, Q, R]);

// --- bulk: 320 done tasks in the workspace over 20 days ------------------------------------
const bulk = [];
for (let i = 0; i < 320; i++) {
  const id = tid();
  const ended = NOW - 100000 - Math.floor((i * 20 * DAY) / 320);
  ev(base(id, { ts: ended - 5000, status: 'running', worker: 'w2' }));
  ev(base(id, { ts: ended, status: 'done', worker: 'w2', inputTokens: 10, outputTokens: 20, costUsd: 0.001 }));
  bulk.push({ id, ended });
}
lines.push('{"ts":123,"id":"ttorn'); // torn tail, no newline
fs.writeFileSync(LOG, lines.join('\n'));

// --- other files ------------------------------------------------------------------------
const HOSTDIR = path.join(HOME, '.claude');
const W1DIR = path.join(HOME, '.claude-w1');
const W2DIR = path.join(HOME, '.claude-w2');
fs.writeFileSync(
  path.join(ROOT, 'registry.json'),
  JSON.stringify({
    workers: [
      null,
      5,
      { name: 5, configDir: '/x' },
      { name: 'blank', configDir: '   ' },
      { name: 'w1', configDir: W1DIR, model: 'claude-opus-4-8', preferred: true },
      { name: 'w2', configDir: W2DIR, model: 'bogus model!!' },
      { name: 'mainworker', configDir: HOSTDIR + '/', model: 'sonnet' },
      { name: 'dup-of-w1', configDir: W1DIR + '/', model: 'fable' },
      { name: '‮bidi\u0000name' + 'n'.repeat(200), configDir: path.join(HOME, '.claude-w3'), model: 'fable' },
      { name: 'constructor', configDir: path.join(HOME, '.claude-w4'), model: 'opus' },
    ],
    claudePath: 'claude',
  }),
);
fs.writeFileSync(
  path.join(ROOT, 'stats.json'),
  JSON.stringify({
    w1: { tasks: 7, errors: 2, inputTokens: '<b>x</b>', outputTokens: 99, costUsd: 1.25, cooldownUntil: NOW + 60000, lastError: '‮boom\n' + 'z'.repeat(999) },
    w2: 'not an object',
    mainworker: { tasks: 3, errors: 0, inputTokens: 1, outputTokens: 2, costUsd: 0, cooldownUntil: NOW - 60000 },
  }),
);
fs.writeFileSync(
  path.join(ROOT, 'usage.json'),
  JSON.stringify({
    [HOSTDIR]: {
      name: 'main', configDir: HOSTDIR, available: true, subscriptionType: 'max', fetchedAt: NOW - 1000,
      windows: [
        null, 'x',
        { kind: 'session', label: 'Session (5hr)', percent: 250, severity: 'critical', resetsAt: new Date(NOW + 3600000).toISOString() },
        { kind: 'weekly_all', label: '‮' + 'L'.repeat(100), percent: -5, severity: 'purple', resetsAt: 'not a date' },
        { kind: 'mystery', label: 5, percent: '<img>', severity: 'warning', resetsAt: null },
      ],
      windowsStale: true, windowsFetchedAt: NOW - 5000, lastGoodWindowsAt: NOW - 5000,
      extraUsage: { enabled: 'yes', percent: 400, spendLabel: '$1.00 / $50.00' },
      auth: { loggedIn: true, email: 'secret@example.com' },
    },
    [W1DIR]: { name: 'w1', configDir: W1DIR, available: false, windows: [], fetchedAt: NOW - 2000, auth: { loggedIn: false, method: 'none', email: 'worker-secret@example.com', checkedAt: NOW } },
    [W2DIR]: { name: 'w2', configDir: W2DIR, available: false, windows: [], fetchedAt: NOW - 2000, error: 'timeout\n' + 'q'.repeat(500) },
    [path.join(HOME, '.claude-w3')]: { available: false, windows: 'nope', fetchedAt: 'x' },
    relative: { available: true },
    arr: [],
  }),
);
fs.writeFileSync(
  path.join(ROOT, 'orchestrators.json'),
  JSON.stringify({ [WS]: { model: 'claude-fable-5', ts: NOW - 9000, lastSeen: NOW - 100 }, [WS2]: { model: '', ts: 0, lastSeen: NOW - 50 }, junk: 5 }),
);

// --- load the bundle ----------------------------------------------------------------------
const bundle = require(path.resolve(process.argv[2]));
const ui = bundle.ui || bundle;
const dt = bundle.dt;
// [CA: w1's `auth.loggedIn: false` alone is no longer "expired" — a reading with no login probes is
// `unconfirmed` (contract-2.0-fixes "Login state (CA)").] w1 reaches `loggedOut` the CA way: two
// "not logged in" probes 20 s apart through its own binding (an explicit CLAUDE_CONFIG_DIR), the
// newer taken AFTER the bundle loaded, i.e. in this process's lifetime. The raw `auth` stays, so
// the "no secret crosses" checks still see its address in the file.
{
  const file = path.join(ROOT, 'usage.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  const at = Date.now();
  cache[W1DIR].loginProbes = [
    { at: at - 20000, path: 'explicit', result: 'out', via: 'status', reason: 'claude auth status said not logged in' },
    { at, path: 'explicit', result: 'out', via: 'status', reason: 'claude auth status said not logged in' },
  ];
  fs.writeFileSync(file, JSON.stringify(cache));
}

const SETTINGS = {
  workerPermissionMode: 'acceptEdits', permissionModes: ['acceptEdits', 'auto'], claudePath: 'claude',
  quotaCooldownMinutes: 30, workerTimeoutMinutes: 45,
  frontierWorkerDispatch: { value: 'block', effective: 'block', setBy: null },
  overageWorkerDispatch: { value: 'block', effective: 'allow', setBy: 'Cursor' },
  meshMode: true, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, sessionKeepalive: false, workerModels: ['opus', 'sonnet', 'fable'],
};
const HEALTH = { claudeVersion: '2.1.283 (Claude Code)', sessionWorkersSupported: true, sessionWorkersMinVersion: '2.1.283', taskLogProblem: null, mcpInstalled: true, policyInstalled: false, teamAgentInstalled: null };
const inputs = (o) => Object.assign({ workspaceRoot: WS, scope: 'workspace', settings: SETTINGS, health: HEALTH, sessions: [], now: NOW }, o);

// --- generic invariants -------------------------------------------------------------------
const CAPS = {
  'accounts.name': 64, 'accounts.loginDetail': 200, 'accounts.plan': 24, 'accounts.lastError': 200,
  'accounts.windows.label': 40, 'accounts.overage.spendLabel': 40,
  'tasks.title': 160, 'tasks.worker': 120, 'tasks.model': 64, 'tasks.error': 240, 'tasks.promptPreview': 300,
  'tasks.sessionWorker': 80, 'tasks.branch': 120, 'tasks.id': 25,
  'sessions.name': 80, 'sessions.accountName': 64, 'sessions.detail': 160, 'sessions.taskTitle': 160, 'sessions.model': 64,
  'sessions.location': 120, 'sessions.branch': 120, 'sessions.team': 64, 'sessions.role': 64, 'sessions.key': 160,
  'health.claudeVersion': 40, 'health.taskLogProblem': 120, 'health.sessionWorkersMinVersion': 24,
  'orchestrator.model': 64, workspace: 80,
  'settings.claudePath': 1024, 'settings.frontierWorkerDispatch.setBy': 64, 'settings.overageWorkerDispatch.setBy': 64,
};
function walk(value, where, problems) {
  if (value === undefined) {
    problems.push(where + ' is undefined');
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(where + ' is not finite: ' + value);
  } else if (typeof value === 'string') {
    if (dt && dt.flattenOneLine(value) !== value) problems.push(where + ' is not flattened: ' + JSON.stringify(value.slice(0, 40)));
    const cap = CAPS[where];
    if (cap !== undefined && value.length > cap) problems.push(where + ' exceeds cap ' + cap + ': ' + value.length);
    if (cap === undefined && value.length > 200) problems.push(where + ' has no known cap and is long: ' + value.length);
    if (path.isAbsolute(value) && where !== 'settings.claudePath') problems.push(where + ' is an absolute path: ' + value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => walk(v, where, problems));
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) walk(value[k], where ? where + '.' + k : k, problems);
  }
}
function invariants(name, model) {
  const problems = [];
  walk(model, '', problems);
  check(name + ': every number finite, every string flattened + capped, nothing undefined, no absolute path', problems.length === 0, problems.slice(0, 5).join(' | ') || undefined);
  const json = JSON.stringify(model);
  check(name + ': no secret or addressable value crosses', !/SECRET-|secret@|worker-secret|prompt\.txt|outside-secret/.test(json) && !json.includes(HOME), undefined);
  check(name + ': exactly 14 daily buckets', model.daily.length === 14, String(model.daily.length));
  check(name + ': schema 2', model.schema === 2);
}

// === 1. hostile log, workspace scope ======================================================
const m = noThrow('buildDashboardModel(hostile log)', () => ui.buildDashboardModel(inputs({})));
invariants('workspace model', m);
const byId = new Map(m.tasks.map((t) => [t.id, t]));
const t = (id) => byId.get(id);
check('missing-id / bad-id / weird-status / bad-ts events are not tasks', !byId.has(WEIRD) && !byId.has(BADTS) && !m.tasks.some((x) => x.title === 'no id' || x.title === 'bad id'));
check('hostile title: flattened, capped at 160, bidi controls gone', t(A).title.length === 160 && t(A).title.startsWith('evil title x') && !/[‮⁦​\u0007\n]/.test(t(A).title), JSON.stringify(t(A).title.slice(0, 20)));
check('inputTokens "<img …>" → null', t(A).inputTokens === null, String(t(A).inputTokens));
check('costUsd 1e999 (Infinity) → null', t(A).costUsd === null, String(t(A).costUsd));
check('finite outputTokens survives', t(A).outputTokens === 12);
check('promptPreview capped at 300', t(A).promptPreview.length === 300);
check('status: "cancelled by user" → cancelled', t(B).status === 'cancelled' && t(B).error === 'cancelled by user');
check('status: "orphaned — …" → orphaned', t(C).status === 'orphaned');
check('status: other error → failed, error capped at 240', t(D).status === 'failed' && t(D).error.length === 240);
check('status: done', t(E).status === 'done' && t(E).error === null && t(E).inputTokens === 100 && t(E).outputTokens === 200 && t(E).costUsd === 0.5);
check('status: running (endedAt null, startedAt = first event)', t(F).status === 'running' && t(F).endedAt === null && t(F).startedAt === NOW - 20000);
check('status: case-insensitive trimmed "  CANCELLED   by …" → cancelled', t(K).status === 'cancelled', t(K).status + ' / ' + t(K).error);
check('session-mode task has null tokens and cost', t(G).mode === 'session' && t(G).inputTokens === null && t(G).outputTokens === null && t(G).costUsd === null && t(G).sessionWorker === 'cco-w-abc123-w1-1');
check('mode: supervisorPid → detached', t(H).mode === 'detached');
check('mode [UPDATED for F2]: pgid on a running one-shot → oneshot (pgid is not a detach marker)', t(F).mode === 'oneshot', t(F).mode);
check('mode: plain → oneshot', t(E).mode === 'oneshot');
check('startedAt/endedAt from first/last event', t(E).startedAt === NOW - 50000 && t(E).endedAt === NOW - 37000);
check('first event not a start → startedAt null', t(L).startedAt === null && t(L).endedAt === NOW - 31000 && t(L).status === 'failed');
check('scope: /ws/proj-2 is NOT in /ws/proj (path boundary)', !byId.has(I) && !byId.has(M));
check('scope: /ws/proj/sub IS in /ws/proj', byId.has(J) && t(J).inWorkspace === true);
check('negative / absurd token counts → null', t(N).inputTokens === null && t(N).outputTokens === null && t(N).costUsd === 1);
check('non-string title/worker/model → "-" ; relative cwd is not in the workspace', !byId.has(S));
const expectedWsTotal = inWs.size + 320;
check('taskTotal is the pre-cap count', m.taskTotal === expectedWsTotal, m.taskTotal + ' vs ' + expectedWsTotal);
check('tasks capped at 300', m.tasks.length === 300, String(m.tasks.length));
let sorted = true;
for (let i = 1; i < m.tasks.length; i++) {
  const a = m.tasks[i - 1], b = m.tasks[i];
  if ((a.endedAt ?? a.startedAt) < (b.endedAt ?? b.startedAt)) sorted = false;
}
check('tasks newest first by (endedAt ?? startedAt)', sorted && m.tasks[0].id === F, m.tasks[0].id);
check('running counts: workspace 1, all 2', m.running.workspace === 1 && m.running.all === 2, JSON.stringify(m.running));
check('hasOutput: true only for a file inside the tasks dir that exists', t(A).hasOutput === true && t(E).hasOutput === true && t(N).hasOutput === false && t(O).hasOutput === false && t(R).hasOutput === false && t(Q).hasOutput === false);

// daily buckets, computed independently
const today = new Date(NOW);
const starts = [];
for (let b = 13; b >= -1; b--) starts.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - b).getTime());
const exp = starts.slice(0, 14).map((day) => ({ day, done: 0, failed: 0, cancelled: 0 }));
const bucketOf = (ts) => { for (let i = 0; i < 14; i++) if (ts >= starts[i] && ts < starts[i + 1]) return i; return -1; };
const addExp = (ts, kind) => { const i = bucketOf(ts); if (i >= 0) exp[i][kind]++; };
for (const b of bulk) addExp(b.ended, 'done');
addExp(NOW - 30000, 'done'); addExp(NOW - 37000, 'done'); addExp(NOW - 36000, 'done'); addExp(NOW - 35000, 'done'); addExp(NOW - 33000, 'done');
addExp(NOW - 29000, 'done'); addExp(NOW - 28000, 'done'); addExp(NOW - 27000, 'done'); addExp(NOW - 26000, 'done'); addExp(NOW - 25000, 'done');
addExp(NOW - 40000, 'cancelled'); addExp(NOW - 32000, 'cancelled');
addExp(NOW - 39000, 'failed'); addExp(NOW - 38000, 'failed'); addExp(NOW - 31000, 'failed');
check('daily: 14 local-day buckets ending today, done / failed+orphaned / cancelled', JSON.stringify(m.daily) === JSON.stringify(exp), JSON.stringify(m.daily.slice(-2)) + ' vs ' + JSON.stringify(exp.slice(-2)));
check('daily: oldest first, each a local midnight', m.daily.every((d, i) => new Date(d.day).getHours() === 0 && (i === 0 || d.day > m.daily[i - 1].day)));

// daily buckets across both DST changes of the process time zone (run with TZ=America/New_York)
for (const iso of ['2026-11-05T15:00:00', '2026-03-12T15:00:00', '2026-11-01T00:30:00', '2026-03-08T03:30:00', '2026-01-01T00:00:00', '2025-12-31T23:59:59']) {
  const at = new Date(iso).getTime();
  const d = ui.buildDashboardModel(inputs({ now: at })).daily;
  const okShape = d.length === 14 && d.every((b, i) => {
    const day = new Date(b.day);
    const gap = i === 0 ? 24 : (b.day - d[i - 1].day) / 3600000;
    return day.getHours() === 0 && day.getMinutes() === 0 && [23, 24, 25].includes(gap);
  });
  const last = new Date(d[13].day), nowD = new Date(at);
  check('daily at ' + iso + ' (' + (process.env.TZ || 'local') + '): 14 consecutive local midnights ending today', okShape && last.getFullYear() === nowD.getFullYear() && last.getMonth() === nowD.getMonth() && last.getDate() === nowD.getDate() && d[13].day <= at, d.map((b, i) => (i === 0 ? '' : String((b.day - d[i - 1].day) / 3600000))).join(' '));
}

// === 2. scope all =========================================================================
const all = noThrow('buildDashboardModel(scope all)', () => ui.buildDashboardModel(inputs({ scope: 'all' })));
invariants('all-scope model', all);
check('scope all: taskTotal counts every valid task', all.taskTotal === SPECIAL.length + 320, all.taskTotal + ' vs ' + (SPECIAL.length + 320));
const allById = new Map(all.tasks.map((x) => [x.id, x]));
check('scope all: other-workspace task listed with inWorkspace false', allById.get(I).inWorkspace === false && allById.get(M).inWorkspace === false && allById.get(E).inWorkspace === true);
check('scope all: non-string title/worker/model → "-"', allById.get(S).title === '-' && allById.get(S).worker === '-' && allById.get(S).model === '-' && allById.get(S).inWorkspace === false);

// === 3. accounts ==========================================================================
const acc = m.accounts;
check('accounts: main first, merged with the worker sharing the host dir', acc[0].isMain && acc[0].isWorker && acc[0].name === 'mainworker' && acc[0].defaultModel === 'sonnet', JSON.stringify(acc.map((a) => a.name)));
check('accounts: registry order after main; invalid entries and a duplicate dir dropped', JSON.stringify(acc.map((a) => a.name.slice(0, 12))) === JSON.stringify(['mainworker', 'w1', 'w2', 'bidi namennn', 'constructor']), JSON.stringify(acc.map((a) => a.name.slice(0, 12))));
check('accounts: keys are 16 hex, unique', acc.every((a) => /^[0-9a-f]{16}$/.test(a.key)) && new Set(acc.map((a) => a.key)).size === acc.length);
check('accountKeyFor = sha256(resolve(dir))[:16]', ui.accountKeyFor(W1DIR + '/') === crypto.createHash('sha256').update(path.resolve(W1DIR)).digest('hex').slice(0, 16) && acc[1].key === ui.accountKeyFor(W1DIR));
const main = acc[0], w1 = acc[1], w2 = acc[2], w3 = acc[3], w4 = acc[4];
check('login ok + plan', main.login === 'ok' && main.plan === 'max' && main.usageFetchedAt === NOW - 1000);
check('windows: non-objects dropped, percent clamped, severity/kind normalized, resetsAt parsed',
  main.windows.length === 3 && main.windows[0].percent === 100 && main.windows[0].severity === 'critical' && typeof main.windows[0].resetsAt === 'number' &&
  main.windows[1].percent === 0 && main.windows[1].severity === 'normal' && main.windows[1].resetsAt === null && main.windows[1].label.length === 40 &&
  main.windows[2].kind === 'other' && main.windows[2].label === '-' && main.windows[2].percent === 0 && main.windows[2].severity === 'warning', JSON.stringify(main.windows.map((w) => [w.kind, w.percent, w.severity])));
check('windowsStaleSince / lastGoodWindowsAt', main.windowsStaleSince === NOW - 5000 && main.lastGoodWindowsAt === NOW - 5000);
check('overage: enabled only if === true, percent clamped', main.overage.enabled === false && main.overage.percent === 100 && main.overage.spendLabel === '$1.00 / $50.00');
check('login expired (isLoginExpired)', w1.login === 'expired' && w1.loginDetail === null);
check('login error + detail capped at 200', w2.login === 'error' && w2.loginDetail.length === 200 && w2.loginDetail.startsWith('timeout q'));
check('login no-plan-limits; no cache entry → refreshing', w3.login === 'no-plan-limits' && w4.login === 'refreshing');
check('defaultModel: legacy id → alias; unreadable → default', w1.defaultModel === 'opus' && w2.defaultModel === 'opus' && w1.preferred === true && w2.preferred === false);
check('stats: non-finite → 0, cooldown in the future kept, lastError capped', w1.allTime.tasks === 7 && w1.allTime.errors === 2 && w1.allTime.inputTokens === 0 && w1.allTime.outputTokens === 99 && w1.cooldownUntil === NOW + 60000 && w1.lastError.length === 200 && w1.lastError.startsWith('boom z'));
check('stats: elapsed cooldown → null; non-object entry → zeros', main.cooldownUntil === null && w2.allTime.tasks === 0 && w2.lastError === null);
check('stats: a worker named "constructor" does not read Object.prototype', w4.allTime.tasks === 0 && w4.running === 0);
check('running per account = running tasks with that exact worker (all workspaces)', w1.running === 2 && w2.running === 0, w1.running + '/' + w2.running);
// window sums, independently: done events for w1 within 5h: A,E,G,H,I,J,N,O,P,Q,R (all "done" with worker w1)
const w1Done = [
  [NOW - 30000, 0, 12, 0], [NOW - 37000, 100, 200, 0.5], [NOW - 36000, 0, 0, 0], [NOW - 35000, 5, 6, 0.01], [NOW - 34000, 1, 1, 0], [NOW - 33000, 1, 1, 0],
  [NOW - 29000, 0, 0, 1], [NOW - 28000, 0, 0, 0], [NOW - 27000, 0, 0, 0], [NOW - 26000, 0, 0, 0], [NOW - 25000, 0, 0, 0],
];
const sum = (rows) => rows.reduce((s, r) => ({ tasks: s.tasks + 1, inputTokens: s.inputTokens + r[1], outputTokens: s.outputTokens + r[2], costUsd: s.costUsd + r[3] }), { tasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
check('session5h for w1: done events only, finite addends only', JSON.stringify(w1.session5h) === JSON.stringify(sum(w1Done)), JSON.stringify(w1.session5h) + ' vs ' + JSON.stringify(sum(w1Done)));
const w2In5h = bulk.filter((b) => b.ended >= NOW - 5 * 3600 * 1000).length;
const w2In7d = bulk.filter((b) => b.ended >= NOW - 7 * DAY).length;
check('5h / 7d windows for w2', w2.session5h.tasks === w2In5h && w2.week.tasks === w2In7d && w2.week.inputTokens === w2In7d * 10, w2.session5h.tasks + '/' + w2.week.tasks + ' vs ' + w2In5h + '/' + w2In7d);

// orchestrator / workspace / health / settings
check('workspace is the folder name only', m.workspace === 'proj');
check('orchestrator: frontier model → not calibrated', m.orchestrator.model === 'claude-fable-5' && m.orchestrator.calibrated === false && m.orchestrator.briefedAt === NOW - 9000 && m.orchestrator.lastSeenAt === NOW - 100);
const m2 = ui.buildDashboardModel(inputs({ workspaceRoot: WS2 }));
check('orchestrator: seen but never briefed → model null', m2.orchestrator.model === null && m2.orchestrator.briefedAt === null && m2.orchestrator.lastSeenAt === NOW - 50 && m2.orchestrator.calibrated === false);
const mSlash = ui.buildDashboardModel(inputs({ workspaceRoot: WS + path.sep }));
check('a workspace root with a trailing separator is the same workspace', mSlash.workspace === 'proj' && mSlash.taskTotal === m.taskTotal && mSlash.orchestrator !== null && mSlash.orchestrator.model === 'claude-fable-5');
const m3 = noThrow('buildDashboardModel(no workspace)', () => ui.buildDashboardModel(inputs({ workspaceRoot: undefined })));
check('no workspace: null workspace/orchestrator, no tasks in "workspace" scope, setup health null', m3.workspace === null && m3.orchestrator === null && m3.tasks.length === 0 && m3.taskTotal === 0 && m3.health.mcpInstalled === null && m3.running.all === 2);
check('health passes through, taskLogProblem null on a readable log', m.health.claudeVersion === '2.1.283 (Claude Code)' && m.health.sessionWorkersSupported === true && m.health.taskLogProblem === null && m.health.mcpInstalled === true && m.health.policyInstalled === false && m.health.teamAgentInstalled === null);
{ const { providerUsagePolling, providers, ...old } = m.settings; check('settings pass through [UPDATED: the two provider fields are checked in test-ui2.js]', JSON.stringify(old) === JSON.stringify(SETTINGS) && providerUsagePolling === true && Array.isArray(providers), JSON.stringify(old)); }
const hostileIn = noThrow('buildDashboardModel(hostile caller inputs)', () =>
  ui.buildDashboardModel({ workspaceRoot: 5, scope: 'weird', settings: { claudePath: '‮/x\n' + 'y'.repeat(3000), quotaCooldownMinutes: NaN, workerTimeoutMinutes: Infinity, meshMaxLiveWorkers: '<img>', meshHistoryLimit: -1, permissionModes: 'x', workerModels: [5, '‮opus'], frontierWorkerDispatch: 'allow', overageWorkerDispatch: { value: 'allow', effective: 7, setBy: 's'.repeat(500) }, meshMode: 'yes' }, health: null, sessions: [null, 5, { key: 'x' }, { key: 'worker:abc', source: 'worker', name: '‮n', location: '/etc/passwd', startedAt: NaN, taskId: '../x', accountKey: 'nope' }, { key: '‮bad', source: 'peer' }], now: 'x' }));
invariants('hostile-inputs model', hostileIn);
check('hostile inputs: settings sanitized', hostileIn.settings.quotaCooldownMinutes === 30 && hostileIn.settings.workerTimeoutMinutes === 480 && hostileIn.settings.meshMaxLiveWorkers === 8 && hostileIn.settings.meshHistoryLimit === 1 && hostileIn.settings.meshMode === false && hostileIn.settings.frontierWorkerDispatch.value === 'block' && hostileIn.settings.overageWorkerDispatch.value === 'allow' && hostileIn.settings.overageWorkerDispatch.effective === 'block' && hostileIn.settings.workerModels.join() === 'opus' && hostileIn.settings.permissionModes.length === 6, JSON.stringify(hostileIn.settings).slice(0, 200));
check('hostile inputs: sessions projected (bad rows dropped, absolute location nulled)', hostileIn.sessions.length === 1 && hostileIn.sessions[0].name === 'n' && hostileIn.sessions[0].location === null && hostileIn.sessions[0].startedAt === null && hostileIn.sessions[0].taskId === null && hostileIn.sessions[0].accountKey === null && hostileIn.scope === 'workspace', JSON.stringify(hostileIn.sessions));
noThrow('buildDashboardModel(undefined)', () => ui.buildDashboardModel(undefined));

// session join → branch / unmerged
const joined = ui.buildDashboardModel(inputs({ sessions: [{ key: 'worker:0a1b2c3d', source: 'worker', name: 'cco-w-abc123-w1-1', accountKey: null, accountName: 'w1', kind: 'background', status: 'idle', detail: null, taskId: G, taskTitle: 't', model: 'opus', startedAt: NOW, updatedAt: NOW, location: '.claude/worktrees/cco-' + G, branch: 'worktree-cco-' + G, unmerged: true, settled: true, inWorkspace: true, canAttach: true, canStop: true, team: null, role: null }] }));
const gj = joined.tasks.find((x) => x.id === G);
check('session task takes branch/unmerged from its worker row', gj.branch === 'worktree-cco-' + G && gj.unmerged === true && joined.tasks.find((x) => x.id === E).branch === null);

// === 4. stat-keyed caches: no re-read ====================================================
const counters = { openSync: 0, readSync: 0, readFileSync: 0, readdirSync: 0, opendirSync: 0, statSync: 0 };
const originals = {};
let bytesRead = 0; // what readSync handed back since the last reset()
for (const k of Object.keys(counters)) {
  originals[k] = fs[k];
  fs[k] = function (...args) { counters[k]++; const r = originals[k].apply(fs, args); if (k === 'readSync' && typeof r === 'number') bytesRead += r; return r; };
}
const reset = () => { for (const k of Object.keys(counters)) counters[k] = 0; bytesRead = 0; };
reset();
const again = ui.buildDashboardModel(inputs({}));
const second = Object.assign({}, counters);
check('second build, nothing changed: 0 opens, 0 reads (stat calls only)', second.openSync === 0 && second.readSync === 0 && second.readFileSync === 0 && second.opendirSync === 0 && second.readdirSync === 0, JSON.stringify(second));
check('second build is identical to the first', JSON.stringify(again) === JSON.stringify(m));
reset();
ui.buildDashboardModel(inputs({ scope: 'all' }));
check('a build with another scope still reads nothing', counters.openSync === 0 && counters.readFileSync === 0, JSON.stringify(counters));
// timing with the same log
const t0 = process.hrtime.bigint();
for (let i = 0; i < 50; i++) ui.buildDashboardModel(inputs({}));
const perBuildMs = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
check('cached build cost', perBuildMs < 20, perBuildMs.toFixed(3) + ' ms per build');
// append one event → exactly one re-read of the log, and the new state is visible
reset();
const appended = '\n' + JSON.stringify(base(F, { ts: NOW - 1000, status: 'done', inputTokens: 3, outputTokens: 4, costUsd: 0 })) + '\n';
fs.appendFileSync(LOG, appended);
reset();
const after = ui.buildDashboardModel(inputs({}));
// [2.0: was "the log is re-read once" — openSync === 1, the WHOLE log read again.] The log is indexed
// incrementally now: an append costs two opens of the log — one to parse the appended tail (after
// checking a 256-byte head and two 64-byte tail fingerprints), one to read the ONE row whose detail
// changed, by its offset — and the bytes read are bounded by the append, not by the log.
const logSize = fs.statSync(LOG).size;
check('after an append: the log is NOT re-read — two opens (the appended tail; the one changed row), bytes read bounded by the append — and the task shows done',
  counters.openSync === 2 && counters.readFileSync === 0 && bytesRead <= 2 * Buffer.byteLength(appended) + 512 && bytesRead < logSize / 100
  && after.tasks.find((x) => x.id === F).status === 'done' && after.running.workspace === 0, JSON.stringify(counters) + ' bytes read ' + bytesRead + ' of a ' + logSize + '-byte log (appended ' + Buffer.byteLength(appended) + ')');
reset();
ui.buildDashboardModel(inputs({}));
check('and the build after that reads nothing again', counters.openSync === 0 && counters.readFileSync === 0, JSON.stringify(counters));
// rewrite stats.json → only that file is re-read
fs.writeFileSync(path.join(ROOT, 'stats.json'), JSON.stringify({ w1: { tasks: 8 } }));
reset();
const afterStats = ui.buildDashboardModel(inputs({}));
check('after stats.json changed: one small read, the log is not re-read', counters.openSync + counters.readFileSync === 1 && afterStats.accounts[1].allTime.tasks === 8, JSON.stringify(counters));
for (const k of Object.keys(originals)) fs[k] = originals[k];

// === 5. resolveTaskOutput ==================================================================
check('resolveTaskOutput accepts a real one', ui.resolveTaskOutput(E) === out(E), String(ui.resolveTaskOutput(E)));
{
  // [2.0: was one of the rejected values below.] Since the fix wave one rule decides every id → file-name
  // mapping (1-128 of A-Z a-z 0-9 _ -) and the file is then lstat'ed in the tasks directory; nothing
  // lower-cases the id. So the upper-case spelling of a real id is refused exactly where the file system
  // tells the two names apart — and where it does not (the default on macOS and Windows) it is the same
  // regular file, returned under the spelling that was asked for.
  const upper = E.toUpperCase();
  const upperFile = path.join(path.dirname(out(E)), upper + '.md');
  const sameFileOnThisFs = fs.existsSync(upperFile);
  const got = ui.resolveTaskOutput(upper);
  check('resolveTaskOutput(the upper-case spelling of a real id): undefined on a case-sensitive file system; on a case-insensitive one the SAME regular file in the tasks directory',
    sameFileOnThisFs ? got === upperFile && fs.lstatSync(got).isFile() && fs.lstatSync(got).ino === fs.lstatSync(out(E)).ino && fs.lstatSync(got).dev === fs.lstatSync(out(E)).dev : got === undefined,
    (sameFileOnThisFs ? 'case-insensitive fs: ' : 'case-sensitive fs: ') + String(got));
}
const rejects = { '../../etc/passwd': '../../etc/passwd', 'path string': out(E), 'too short': 't12345', 'too long': 't' + 'a'.repeat(25), 'trailing newline': E + '\n', number: 12345, null: null, undefined: undefined, object: { id: E }, array: [E], 'unknown id': 'tzzzzzzzz9', 'weird-status id': WEIRD, 'empty': '' };
for (const [name, value] of Object.entries(rejects)) {
  check('resolveTaskOutput rejects ' + name, ui.resolveTaskOutput(value) === undefined, String(ui.resolveTaskOutput(value)));
}
check('resolveTaskOutput rejects outputFile outside the tasks dir (/etc/passwd)', ui.resolveTaskOutput(N) === undefined);
check('resolveTaskOutput rejects a sibling dir sharing the prefix (tasks-evil)', ui.resolveTaskOutput(O) === undefined);
check('resolveTaskOutput rejects a symlink in the tasks dir that points outside', ui.resolveTaskOutput(P) === undefined);
check('resolveTaskOutput rejects a ../ traversal', ui.resolveTaskOutput(Q) === undefined);
check('resolveTaskOutput rejects a file that is not on disk', ui.resolveTaskOutput(R) === undefined);
check('resolveTaskOutput rejects a relative outputFile', ui.resolveTaskOutput(S) === undefined);

// === 6. resolveAccount =====================================================================
const ra = ui.resolveAccount(w1.key);
check('resolveAccount(real key) → registry name + dir verbatim', ra && ra.name === 'w1' && ra.configDir === W1DIR && ra.isWorker === true && ra.isMain === false, JSON.stringify(ra));
const rm = ui.resolveAccount(main.key);
check('resolveAccount(main key) → merged row, the registry\'s own dir string', rm && rm.name === 'mainworker' && rm.configDir === HOSTDIR + '/' && rm.isMain && rm.isWorker, JSON.stringify(rm));
const rw3 = ui.resolveAccount(w3.key);
check('resolveAccount returns the RAW registry name', rw3 && rw3.name.startsWith('‮bidi'));
for (const bad of [w1.key.toUpperCase(), w1.key + '0', w1.key.slice(1), '0'.repeat(16), W1DIR, 'w1', '', null, undefined, 5, {}, [w1.key]]) {
  check('resolveAccount rejects ' + JSON.stringify(bad), ui.resolveAccount(bad) === undefined);
}

// === 7. validateSetting ====================================================================
const ok = (k, v, expect) => { const r = ui.validateSetting(k, v); check('validateSetting accepts ' + k + ' = ' + JSON.stringify(v), r.ok === true && r.key === k && r.value === (expect === undefined ? v : expect), JSON.stringify(r)); };
const no = (k, v) => { const r = ui.validateSetting(k, v); check('validateSetting rejects ' + String(k) + ' = ' + (typeof v === 'number' ? String(v) : JSON.stringify(v)), r.ok === false && typeof r.error === 'string' && r.error.length > 0 && r.error.length <= 200 && (!dt || dt.flattenOneLine(r.error) === r.error), JSON.stringify(r)); };
for (const mode of ['acceptEdits', 'auto', 'dontAsk', 'plan', 'default', 'bypassPermissions']) ok('workerPermissionMode', mode);
for (const v of ['AcceptEdits', ' acceptEdits', 'yolo', '', 5, null, ['auto']]) no('workerPermissionMode', v);
ok('claudePath', 'claude'); ok('claudePath', '/usr/local/bin/claude'); ok('claudePath', '  /opt/My Tools/claude  ', '/opt/My Tools/claude'); ok('claudePath', 'c'.repeat(1024));
for (const v of ['', '   ', 'c'.repeat(1025), '/usr/bin/claude\n--dangerous', 'claude\n', 'claude\r', 'cla\u0000ude', 'a b', 5, null, {}]) no('claudePath', v);
for (const [k, lo, hi] of [['quotaCooldownMinutes', 1, 1440], ['workerTimeoutMinutes', 1, 480], ['meshMaxLiveWorkers', 1, 64], ['meshHistoryLimit', 1, 1000]]) {
  ok(k, lo); ok(k, hi); ok(k, Math.floor((lo + hi) / 2));
  for (const v of [0, hi + 1, -1, 1.5, NaN, Infinity, -Infinity, '5', String(lo), true, null, undefined, [5], { valueOf: () => 5 }]) no(k, v);
}
no('quotaCooldownMinutes', 1441); no('quotaCooldownMinutes', 0); no('quotaCooldownMinutes', '5');
for (const k of ['frontierWorkerDispatch', 'overageWorkerDispatch']) { ok(k, 'block'); ok(k, 'allow'); for (const v of ['Block', 'ALLOW', '', true, 1, null]) no(k, v); }
for (const k of ['meshMode', 'sessionKeepalive']) { ok(k, true); ok(k, false); for (const v of ['true', 1, 0, null, undefined, 'on']) no(k, v); }
for (const k of ['meshGatewayModel', 'meshWorkerIdleTimeoutMin', 'assetPacks', '__proto__', 'constructor', 'toString', '', '‮evil' + 'k'.repeat(500), 5, null, undefined, {}, ['meshMode']]) no(k, true);

// === 8. shape-broken small files ===========================================================
fs.writeFileSync(path.join(ROOT, 'stats.json'), 'null');
fs.writeFileSync(path.join(ROOT, 'registry.json'), '[]');
const broken = noThrow('buildDashboardModel(stats.json = null, registry.json = [])', () => ui.buildDashboardModel(inputs({})));
invariants('broken-small-files model', broken);
// [2.0: was "registry [] → only the main account" (one row, main).] A registry that cannot be read holds
// accounts the model cannot see; listing main alone would read as "you have no workers". The model gives
// NO account rows and says why in health.registryProblem.
check('registry [] (not a JSON object) → NO account rows, no unsupported rows, and health.registryProblem names the problem',
  broken.accounts.length === 0 && Array.isArray(broken.unsupportedAccounts) && broken.unsupportedAccounts.length === 0 && broken.health.registryProblem === 'not a JSON object', JSON.stringify([broken.accounts.length, broken.health.registryProblem]));
check('a removed worker key no longer resolves', ui.resolveAccount(w1.key) === undefined && ui.resolveAccount(main.key).name === 'main' && ui.resolveAccount(main.key).configDir === HOSTDIR);
for (const [file, content] of [['stats.json', '{{{'], ['registry.json', 'null'], ['registry.json', '{"workers":"nope"}'], ['registry.json', '{"workers":{"0":{"name":"a","configDir":"/a"}}}'], ['usage.json', 'null'], ['usage.json', '[]'], ['usage.json', '"x"'], ['orchestrators.json', 'null'], ['orchestrators.json', '[1]'], ['orchestrators.json', JSON.stringify({ [WS]: 'str' })]]) {
  fs.writeFileSync(path.join(ROOT, file), content);
  const r = noThrow('buildDashboardModel(' + file + ' = ' + content.slice(0, 30) + ')', () => ui.buildDashboardModel(inputs({})));
  if (r) invariants(file + ' = ' + content.slice(0, 20), r);
  // 2.0: each of the three registry contents is a registry this version could not interpret
  if (r && file === 'registry.json') check('registry.json = ' + content.slice(0, 30) + ' → a problem of at most 200 characters is reported and no account row is shown', typeof r.health.registryProblem === 'string' && r.health.registryProblem.length > 0 && r.health.registryProblem.length <= 200 && r.accounts.length === 0, JSON.stringify(r.health.registryProblem));
}
// a directory and a FIFO where small files should be
fs.rmSync(path.join(ROOT, 'stats.json')); fs.mkdirSync(path.join(ROOT, 'stats.json'));
fs.rmSync(path.join(ROOT, 'registry.json'));
require('child_process').execFileSync('mkfifo', [path.join(ROOT, 'registry.json')]);
const tF = Date.now();
const fifo = noThrow('buildDashboardModel(registry.json is a FIFO, stats.json is a directory)', () => ui.buildDashboardModel(inputs({})));
// [2.0: was … && fifo.accounts.length === 1 (the main row)] — same rule as above: not readable, so no rows and a reason
check('a FIFO at registry.json does not block the build, and is reported as a registry that is not a regular file', Date.now() - tF < 1000 && fifo.accounts.length === 0 && fifo.health.registryProblem === 'not a regular file', (Date.now() - tF) + ' ms, ' + JSON.stringify(fifo.health.registryProblem));

// === 9. unreadable task log ================================================================
const withLog = (name, setup, expectProblem) => {
  fs.rmSync(LOG, { recursive: true, force: true });
  setup();
  const t1 = Date.now();
  const r = noThrow('buildDashboardModel(task log: ' + name + ')', () => ui.buildDashboardModel(inputs({ scope: 'all' })));
  if (!r) return;
  invariants('task log ' + name, r);
  const p = r.health.taskLogProblem;
  check('task log ' + name + ' → ' + (expectProblem ? 'taskLogProblem set, empty task data' : 'no problem, empty'), (expectProblem ? typeof p === 'string' && p.length > 0 && p.length <= 120 : p === null) && r.tasks.length === 0 && r.taskTotal === 0 && r.running.all === 0 && Date.now() - t1 < 2000, JSON.stringify(p) + ' in ' + (Date.now() - t1) + ' ms');
};
withLog('absent', () => {}, false);
withLog('is a directory', () => fs.mkdirSync(LOG), true);
withLog('is a FIFO', () => require('child_process').execFileSync('mkfifo', [LOG]), true);
withLog('is past the 64 MiB cap', () => { fs.writeFileSync(LOG, 'x'); fs.truncateSync(LOG, 70 * 1024 * 1024); }, true);
withLog('is empty', () => fs.writeFileSync(LOG, ''), false);
withLog('is unreadable (mode 000)', () => { fs.writeFileSync(LOG, JSON.stringify(base(E, { ts: NOW, status: 'done' })) + '\n'); fs.chmodSync(LOG, 0o000); }, process.getuid() !== 0);
fs.chmodSync(LOG, 0o644);
// recovery: a readable log after a problem
fs.rmSync(LOG, { force: true });
fs.writeFileSync(LOG, JSON.stringify(base(E, { ts: NOW - 5, status: 'done', inputTokens: 1, outputTokens: 2, costUsd: 3 })) + '\n');
const rec = ui.buildDashboardModel(inputs({}));
check('a readable log after a problem is picked up', rec.health.taskLogProblem === null && rec.tasks.length === 1 && rec.tasks[0].id === E);

// === 10. a large log: one parse, then stat-only ============================================
{
  // Every record carries HOME's path twice (cwd, outputFile), so with a fixed pad the size of this log
  // followed the length of that path: 63.5 MiB under the directory this suite was written in, and past
  // the product's 64 MiB read cap under a longer one (the model then, correctly, reads nothing). The pad
  // is sized instead, so that the log is 60 MiB wherever HOME is.
  const two = (i, pad) => {
    const id = 't' + (5000000 + i).toString(36).padStart(8, '0');
    return [
      JSON.stringify(base(id, { ts: NOW - 500000 - i * 1000, status: 'running', promptPreview: 'p'.repeat(pad) })),
      JSON.stringify(base(id, { ts: NOW - 400000 - i * 1000, status: 'done', inputTokens: 1, outputTokens: 2, costUsd: 0.1, promptPreview: 'p'.repeat(pad) })),
    ];
  };
  const bare = two(39999, 0).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  const PAD = Math.floor(((60 * 1048576) / 40000 - bare) / 2);
  if (PAD < 1) throw new Error('fixture: HOME is too long a path for a 60 MiB log of 40,000 tasks');
  const big = [];
  for (let i = 0; i < 40000; i++) big.push(...two(i, PAD));
  fs.writeFileSync(LOG, big.join('\n') + '\n');
  const size = fs.statSync(LOG).size;
  if (size > 61 * 1048576 || size < 59 * 1048576) throw new Error('fixture: the large log is ' + size + ' bytes, not 60 MiB');
  const a0 = process.hrtime.bigint();
  const first = ui.buildDashboardModel(inputs({}));
  const a1 = process.hrtime.bigint();
  const secondBuild = ui.buildDashboardModel(inputs({}));
  const a2 = process.hrtime.bigint();
  const firstMs = Number(a1 - a0) / 1e6, secondMs = Number(a2 - a1) / 1e6;
  check('large log (' + (size / 1048576).toFixed(1) + ' MiB, 40,000 tasks): first build parses, second does not', first.taskTotal === 40000 && first.tasks.length === 300 && secondBuild.taskTotal === 40000 && secondMs < firstMs / 5, 'first ' + firstMs.toFixed(1) + ' ms, second ' + secondMs.toFixed(1) + ' ms');
  invariants('large-log model', first);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
