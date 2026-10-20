'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* Second-round probes: inputs chosen to BREAK the contract rather than to confirm it.
 * Usage: env -i HOME=<tmp> PATH=... node test-hostile.js <both.js>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
if (process.env.CLAUDE_CONFIG_DIR) {
  console.error('refusing to run: CLAUDE_CONFIG_DIR is set');
  process.exit(2);
}
let pass = 0;
let fail = 0;
function check(name, cond, observed) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (observed !== undefined ? ': ' + observed : ''));
}
const ROOT = path.join(HOME, '.claude-code-orchestrator');
const LOG = path.join(ROOT, 'tasks.jsonl');
const WS = path.join(HOME, 'ws', 'proj');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
const NOW = Date.now();
const { ui, team, dt } = require(path.resolve(process.argv[2]));
const build = (o) => ui.buildDashboardModel(Object.assign({ workspaceRoot: WS, scope: 'all', settings: {}, health: {}, sessions: [], now: NOW }, o));
const safe = (model) => {
  const bad = [];
  (function walk(v, where) {
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(where + ' not finite');
    else if (typeof v === 'string') { if (dt.flattenOneLine(v) !== v) bad.push(where + ' not flat'); if (v.length > 1024) bad.push(where + ' long'); }
    else if (v === undefined) bad.push(where + ' undefined');
    else if (Array.isArray(v)) v.forEach((x) => walk(x, where));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], where + '.' + k);
  })(model, '');
  return bad;
};
const timed = (fn) => { const t = process.hrtime.bigint(); let v, err; try { v = fn(); } catch (e) { err = e; } return { v, err, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const id = (n) => 't' + (9000000 + n).toString(36).padStart(8, '0');
const ev = (n, o) => JSON.stringify(Object.assign({ id: id(n), ts: NOW - n * 1000 - 1000, status: 'done', title: 'task ' + n, worker: 'w1', model: 'opus', outputFile: path.join(ROOT, 'tasks', id(n) + '.md'), cwd: WS }, o));
let step = 0;
const writeLog = (text) => { fs.writeFileSync(LOG, text + '\n'.repeat(++step)); }; // a different size every time → a different stat key

// 1. JSON shapes that parse but are not records, and parser stress
writeLog(['['.repeat(200000), '{"a":'.repeat(50000) + '1' + '}'.repeat(50000), 'true', '1e999', '-0', '""', '{}', '{"id":null}', ev(1), '﻿' + ev(2), ev(3).replace(/^\{/, '{"__proto__":{"status":"done","polluted":true},'), '{"id":"' + id(4) + '","ts":' + (NOW - 1) + ',"status":"done","title":{"toString":"x"},"worker":["w1"],"model":true,"constructor":{"prototype":{"x":1}}}'].join('\n'));
let r = timed(() => build({}));
check('deeply nested / primitive / empty-object lines: no throw, real records kept', !r.err && r.v.taskTotal === 3 && safe(r.v).length === 0 && ({}).polluted === undefined, r.err ? String(r.err) : 'tasks ' + r.v.taskTotal + ' in ' + r.ms.toFixed(0) + ' ms; bad=' + safe(r.v).slice(0, 3));

// 2. CRLF line endings
writeLog([ev(1), ev(2), ev(3)].join('\r\n') + '\r');
r = timed(() => build({}));
check('CRLF log: every record read', !r.err && r.v.taskTotal === 3, String(r.v && r.v.taskTotal));

// 3. one enormous line, and NUL padding
writeLog(ev(1) + '\n' + '\u0000'.repeat(10 * 1024 * 1024) + '\n' + '{"id":"' + id(2) + '","pad":"' + 'p'.repeat(3 * 1024 * 1024) + '","ts":' + NOW + ',"status":"done"}' + '\n' + ev(3));
r = timed(() => build({}));
// [2.0: was "a 10 MiB NUL line and a 3 MiB record are skipped cheaply" — taskTotal === 2.] The views read the
// log by the registry's own rule now, line for line: a line that does not parse is skipped, and a line that
// parses as a record IS a record, however long (the old reader skipped any line over 1 MiB unparsed). So the
// NUL line is still nothing, the 3 MiB record is the task it says it is — and none of its 3 MiB crosses
// into the model: a row that long is never read back for its details.
{
  const big = r.v && r.v.tasks.find((t) => t.id === id(2));
  check('a 10 MiB NUL line is skipped and a 3 MiB record is read as the one task it is, cheaply; neighbours kept; its bulk does not reach the model',
    !r.err && r.v.taskTotal === 3 && r.ms < 1500 && big !== undefined && big.status === 'done' && safe(r.v).length === 0 && JSON.stringify(r.v).length < 64 * 1024,
    r.ms.toFixed(0) + ' ms, tasks ' + (r.v && r.v.taskTotal) + ', model ' + (r.v && JSON.stringify(r.v).length) + ' chars');
}

// 4. numbers at the edges
writeLog([
  ev(1, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER + 2, costUsd: 5e-324 }),
  ev(2, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1e308, costUsd: -0 }),
  ev(3, { inputTokens: true, outputTokens: [5], costUsd: { valueOf: 1 } }),
  ev(4, { ts: 8.64e15 }), ev(5, { ts: 8.64e15 + 1 }), ev(6, { ts: 0 }), ev(7, { ts: -5 }), ev(8, { ts: 1.5 }),
  ...Array.from({ length: 2000 }, (_, i) => ev(100 + i, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER, costUsd: Number.MAX_SAFE_INTEGER, ts: NOW - 500000 - i })),
].join('\n'));
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers: [{ name: 'w1', configDir: path.join(HOME, '.claude-w1'), model: 'opus' }] }));
r = timed(() => build({}));
const w1 = r.v && r.v.accounts.find((a) => a.name === 'w1');
// [second review, contract §9.7 as amended: this check used to require the record dated 8.64e15 — the largest
// valid date, 270,000 years ahead — to be AMONG THE LISTED TASKS (it was the newest of all, so it headed the list).]
// A timestamp more than five minutes past the reader's clock is no time at all. The task is still a task — it is
// counted — but it sorts after every task that has a time, so with 2,003 dated tasks it is not among the newest
// 300; and it is in no 5-hour / 7-day sum and no daily bucket.
{
  const listed = r.v ? r.v.tasks : [];
  const dailyTotal = r.v ? r.v.daily.reduce((n, d) => n + d.done + d.failed + d.cancelled, 0) : -1;
  check('edge numbers: sums stay finite; out-of-range timestamps are not records; a timestamp far in the future is no time — the task is counted, but is not among the newest 300, in no window sum and in no daily bucket',
    !r.err && safe(r.v).length === 0 && Number.isFinite(w1.week.inputTokens) && w1.week.inputTokens > 1e18
    && !listed.some((t) => [id(5), id(6), id(7)].includes(t.id))
    // id(1..3) + the 2,000 = 2,003 dated tasks of this week; id(8) is dated 1970; id(4) has no time: 2,005 tasks in all
    && r.v.taskTotal === 2005 && listed.length === 300 && !listed.some((t) => t.id === id(4)) && listed.every((t) => typeof t.endedAt === 'number' && t.endedAt <= NOW)
    && w1.week.tasks === 2003 && w1.session5h.tasks === 2003 && dailyTotal === 2003
    && listed.find((t) => t.id === id(1)).outputTokens === null && listed.find((t) => t.id === id(2)).costUsd === 0,
    r.err ? String(r.err) : JSON.stringify({ taskTotal: r.v.taskTotal, listed: listed.length, week: w1.week.tasks, session5h: w1.session5h.tasks, dailyTotal }));
}
// The same rule where the undated tasks ARE on the list: after every dated one — a task of 1970 included — the
// running one before the finished one, and neither shows a time.
writeLog([
  ev(1), ev(2),
  ev(4, { ts: 8.64e15, inputTokens: 5, outputTokens: 6, costUsd: 0.5 }),      // finished, dated in the future
  ev(9, { ts: NOW + 6 * 60_000, status: 'running' }),                          // running, dated six minutes ahead
  ev(10, { ts: NOW + 4 * 60_000 }),                                            // four minutes ahead: within the slack, a time
  ev(5, { ts: 8.64e15 + 1 }), ev(6, { ts: 0 }), ev(7, { ts: -5 }), ev(8, { ts: 1.5 }),
].join('\n'));
r = timed(() => build({}));
{
  const order = r.v ? r.v.tasks.map((t) => t.id) : [];
  const row = (n) => r.v.tasks.find((t) => t.id === id(n));
  const w = r.v && r.v.accounts.find((a) => a.name === 'w1');
  const dailyTotal = r.v ? r.v.daily.reduce((n, d) => n + d.done + d.failed + d.cancelled, 0) : -1;
  check('a timestamp more than five minutes ahead: the task sorts after every dated task (the running one before the finished one), shows no time, and is in no sum; four minutes ahead is still a time',
    !r.err && safe(r.v).length === 0 && JSON.stringify(order) === JSON.stringify([id(10), id(1), id(2), id(8), id(9), id(4)]) && r.v.taskTotal === 6
    && row(4).status === 'done' && row(4).startedAt === null && row(4).endedAt === null && row(9).status === 'running' && row(9).startedAt === null && row(9).endedAt === null
    && row(10).endedAt === NOW + 4 * 60_000
    // the week holds the three tasks dated now (10, 1, 2): not the task of 1970, not the two without a time — whose 5 + 6 tokens are in no sum
    && w.week.tasks === 3 && w.session5h.tasks === 3 && w.week.inputTokens === 0 && w.week.outputTokens === 0 && w.week.costUsd === 0 && dailyTotal === 3 && r.v.running.all === 1,
    r.err ? String(r.err) : JSON.stringify({ order: order.map((x) => x.slice(-2)), taskTotal: r.v.taskTotal, week: w.week, dailyTotal, running: r.v.running, t4: [row(4) && row(4).startedAt, row(4) && row(4).endedAt] }));
}
check('a far-future timestamp cannot produce an invalid date in the model', r.v.tasks.every((t) => !Number.isNaN(new Date(t.endedAt ?? t.startedAt ?? 0).getTime())));

// 5. strings at the edges
const astral = '😀'.repeat(200);
const zwj = '👨‍👩‍👧‍👦'.repeat(60);
writeLog([
  ev(1, { title: astral, worker: zwj, model: 'm' + '\uD83D', error: 'x', promptPreview: '\uDC00\uD83D' + 'p'.repeat(299) + '😀' }),
  ev(2, { title: ' \t\n ', worker: '​​', model: '‮‭', promptPreview: 'ㅤㅤ' }),
  ev(3, { title: 'a'.repeat(159) + '😀' + 'tail', status: 'error', error: '​cancelled​ by user' }),
  ev(4, { title: 'x'.repeat(159) + ' ' + 'y', status: 'error', error: 'ORPHANED — x' }),
  ev(5, { status: 'error', error: 'cancel' }), ev(6, { status: 'error', error: '' }), ev(7, { status: 'error' }), ev(8, { status: 'error', error: 5 }),
  ev(9, { status: 'error', error: 'not cancelled, it failed' }),
  ev(10, { status: 'error', error: ' \tCANCELLED by user' }),
].join('\n'));
r = timed(() => build({}));
const T = (n) => r.v.tasks.find((t) => t.id === id(n));
check('surrogates: a cut never leaves half a pair; lone halves are removed', !r.err && safe(r.v).length === 0 && T(1).title.length === 160 && T(1).worker.length <= 120 && !/[\uD800-\uDBFF]$/.test(T(1).title) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(T(1).worker + T(1).model + T(1).promptPreview) && T(1).model === 'm', JSON.stringify([T(1).title.length, T(1).worker.length, T(1).model]));
check('all-invisible values: "-" for required strings, null for optional ones', T(2).title === '-' && T(2).worker === '-' && T(2).model === '-' && T(2).promptPreview === null, JSON.stringify([T(2).title, T(2).worker, T(2).model, T(2).promptPreview]));
check('a cut that would split an emoji or end in a space is trimmed back', T(3).title.length === 159 && T(4).title.length === 159 && T(4).title.endsWith('x'), T(3).title.length + '/' + T(4).title.length);
// [2.0: was "classified on the text the page shows" — T(3), whose error is U+200B + "cancelled" + U+200B + " by user",
// read as cancelled.] The class is decided on the text AS RECORDED: leading whitespace skipped, case ignored, nothing
// else removed — a zero-width character in front of the word is not the word (the registry applies the same test before
// it lets a result's own message keep one of the two words). T(10) is the positive case: whitespace and capitals.
check('status prefixes: classified on the text as recorded — a zero-width character before "cancelled" does not make a task cancelled; leading whitespace and case do not unmake one',
  T(3).status === 'failed' && T(4).status === 'orphaned' && T(5).status === 'failed' && T(6).status === 'failed' && T(6).error === null && T(7).status === 'failed' && T(8).status === 'failed' && T(8).error === null && T(9).status === 'failed' && T(10).status === 'cancelled',
  JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10].map((n) => T(n).status)));

// 6. last-event-wins, including hostile overwrites of a real task
writeLog([
  ev(1, { status: 'running', ts: NOW - 9000, title: 'real title' }),
  '{"id":"' + id(1) + '","status":"hacked","ts":' + (NOW - 8000) + ',"title":"<img src=x onerror=alert(1)>"}',
  '{"id":"' + id(1) + '","status":"done","ts":"' + (NOW - 7000) + '","title":"string ts"}',
  ev(2, { status: 'done', ts: NOW - 6000 }), ev(2, { status: 'running', ts: NOW - 5000 }),
  ev(3, { status: 'running', ts: NOW - 4000, cwd: WS }), ev(3, { status: 'done', ts: NOW - 3000, cwd: '/somewhere/else', outputFile: '/etc/passwd', title: '<script>alert(1)</script>' }),
].join('\n'));
r = timed(() => build({ scope: 'workspace' }));
check('an event with a bad status or a string ts cannot hide or flip a real task', !r.err && r.v.tasks.find((t) => t.id === id(1)).status === 'running' && r.v.tasks.find((t) => t.id === id(1)).title === 'real title');
check('a later event wins, whatever it says (done then running → running)', r.v.tasks.find((t) => t.id === id(2)).status === 'running' && r.v.tasks.find((t) => t.id === id(2)).startedAt === null);
check('a later event that moves the task elsewhere takes it out of the workspace scope; its output no longer resolves', !r.v.tasks.some((t) => t.id === id(3)) && ui.resolveTaskOutput(id(3)) === undefined && r.v.taskTotal === 2);
check('markup in a title is carried as text, flattened — the page must still never use innerHTML', build({}).tasks.find((t) => t.id === id(3)).title === '<script>alert(1)</script>');

// 7. the small files, at scale
const manyKeys = {};
for (let i = 0; i < 150000; i++) manyKeys['/ws/' + i] = { model: 'opus', ts: 1, lastSeen: 2 };
fs.writeFileSync(path.join(ROOT, 'orchestrators.json'), JSON.stringify(manyKeys));
fs.writeFileSync(path.join(ROOT, 'usage.json'), JSON.stringify({ [path.join(HOME, '.claude')]: { available: true, fetchedAt: NOW, windows: Array.from({ length: 100000 }, () => null).concat([{ kind: 'session', label: 'late', percent: 5 }]) } }));
const firstBig = timed(() => build({}));
const nextBig = timed(() => { for (let i = 0; i < 20; i++) build({}); });
check('150,000-key orchestrators.json and a 100,000-entry windows array: bounded, and free once cached', !firstBig.err && firstBig.v.orchestrator === null && firstBig.v.accounts[0].windows.length === 0 && nextBig.ms / 20 < 5, 'first ' + firstBig.ms.toFixed(0) + ' ms, then ' + (nextBig.ms / 20).toFixed(2) + ' ms per build');
fs.writeFileSync(path.join(ROOT, 'stats.json'), JSON.stringify({ w1: { tasks: 1e308, errors: -1, inputTokens: 1.5, outputTokens: null, costUsd: '1', cooldownUntil: 'soon', lastError: { a: 1 } }, __proto__x: 1 }).replace('"__proto__x":1', '"__proto__":{"tasks":99},"constructor":{"tasks":98},"hasOwnProperty":{"tasks":97}'));
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers: [{ name: 'w1', configDir: path.join(HOME, '.claude-w1') }, { name: '__proto__', configDir: path.join(HOME, '.p') }, { name: 'hasOwnProperty', configDir: path.join(HOME, '.h') }, { name: 'toString', configDir: path.join(HOME, '.t') }, { name: 'rel', configDir: 'relative/dir' }, { name: 'nul', configDir: '/a\u0000b' }] }));
r = timed(() => build({}));
const names = r.v && r.v.accounts.map((a) => a.name);
check('stats: absurd values → 0/null; workers named __proto__ / hasOwnProperty / toString read only their OWN entry', !r.err && safe(r.v).length === 0 && r.v.accounts[1].allTime.tasks === 0 && r.v.accounts[1].allTime.errors === 0 && r.v.accounts[1].allTime.inputTokens === 1.5 && r.v.accounts[1].cooldownUntil === null && r.v.accounts[1].lastError === null && r.v.accounts.find((a) => a.name === '__proto__').allTime.tasks === 99 && r.v.accounts.find((a) => a.name === 'hasOwnProperty').allTime.tasks === 97 && r.v.accounts.find((a) => a.name === 'toString').allTime.tasks === 0 && !names.includes('nul'), r.err ? String(r.err.stack) : JSON.stringify(names));
check('every account key resolves back to exactly that account', r.v.accounts.every((a) => { const x = ui.resolveAccount(a.key); return x && (a.isMain ? x.isMain : x.name === a.name); }));

// 8. file replaced between builds: same size, different content is detected through mtime
const a = ev(1, { title: 'AAAA' }), b = ev(1, { title: 'BBBB' });
fs.writeFileSync(LOG, a + '\n');
const first = build({}).tasks[0].title;
const future = new Date(Date.now() + 5000);
fs.writeFileSync(LOG, b + '\n'); fs.utimesSync(LOG, future, future);
check('same-size rewrite with a new mtime is picked up', first === 'AAAA' && build({}).tasks[0].title === 'BBBB');
fs.rmSync(LOG);
check('a deleted log is an empty history, not a stale one', build({}).taskTotal === 0 && build({}).health.taskLogProblem === null);
fs.symlinkSync(path.join(ROOT, 'missing-target'), LOG);
check('a dangling symlink at the log path is absent, not a problem', build({}).health.taskLogProblem === null && build({}).taskTotal === 0);
fs.rmSync(LOG); fs.symlinkSync('/dev/zero', LOG);
r = timed(() => build({}));
check('a symlink to /dev/zero at the log path is refused without reading it', !r.err && typeof r.v.health.taskLogProblem === 'string' && r.v.taskTotal === 0 && r.ms < 500, JSON.stringify(r.v && r.v.health.taskLogProblem) + ' in ' + r.ms.toFixed(0) + ' ms');
fs.rmSync(LOG);

// 9. resolvers called with odd `this` / odd arguments, repeatedly
for (const f of ['resolveAccount', 'resolveTaskOutput', 'validateSetting', 'accountKeyFor', 'taskBrief']) {
  const res = timed(() => { for (const v of [undefined, null, 0, NaN, '', 'x', [], {}, () => 1, Symbol('s'), 10n, new Date(), Object.create(null), new Proxy({}, { get() { throw new Error('trap'); } })]) ui[f](v, v); });
  check(f + ' is total over exotic arguments', !res.err, res.err ? String(res.err) : undefined);
}
for (const f of ['collectSessions', 'resolveSession']) {
  const res = timed(() => { for (const v of [undefined, null, 0, '', [], {}, () => 1, Symbol('s'), 10n, Object.create(null), new Proxy({}, { get() { throw new Error('trap'); } })]) team[f](v); });
  check(f + ' is total over exotic arguments', !res.err, res.err ? String(res.err) : undefined);
}
const trap = () => new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
const revoked = (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })();
for (const [label, value] of [['an input whose property access throws', trap()], ['a revoked Proxy', revoked], ['inputs whose settings / health / sessions throw on access', { workspaceRoot: WS, scope: 'all', settings: trap(), health: trap(), sessions: [trap(), revoked], now: NOW }], ['a getter that throws', { get workspaceRoot() { throw new Error('getter'); }, get sessions() { throw new Error('getter'); } }]]) {
  r = timed(() => ui.buildDashboardModel(value));
  check('buildDashboardModel survives ' + label, !r.err && r.v.schema === 2 && r.v.daily.length === 14 && safe(r.v).length === 0, r.err ? 'threw: ' + r.err.message : 'problem=' + JSON.stringify(r.v.health.taskLogProblem));
  r = timed(() => team.collectSessions(value));
  check('collectSessions survives ' + label, !r.err && Array.isArray(r.v), r.err ? 'threw: ' + r.err.message : undefined);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
