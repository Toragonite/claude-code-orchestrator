'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* Drives the bundled team.ts against fixture ledgers / session dirs / team configs under a
 * temp HOME. Usage: env -i HOME=<tmp> PATH=... node test-team.js <bundle.js>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

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

// PROCESSES OF THIS SUITE'S OWN. A session entry is the file `<pid>.json` of a process that exists: the scan
// reads the pid off the file NAME (canonical decimal), passes over an entry whose process is gone without
// opening it, and drops one whose own `pid` field says another process (contract §9.8). So every fixture
// session below is named for a pid this suite owns —
//   live: the eight sleepers and this process itself, nine in all, each used at most once per account
//         directory (one pid may name an entry in several directories: they are scanned separately);
//   dead: children this suite started and reaped, never a guessed number.
// Never more than eight children at a time: the dead ones are made first, one after the other, and the
// sleepers start only once nothing else has to be run (startSleepers, after the FIFOs are made).
const isGone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
const reapedPids = new Set();
for (let tries = 0; reapedPids.size < 1301 && tries < 6000; tries++) {
  const r = cp.spawnSync('/bin/sh', ['-c', ':'], { stdio: 'ignore' });
  if (Number.isInteger(r.pid) && r.pid > 1 && isGone(r.pid)) reapedPids.add(r.pid);
}
if (reapedPids.size < 1301) { console.error('fixture: could not make 1,301 dead pids'); process.exit(2); }
const [DEAD, ...LITTER] = [...reapedPids];
const ME = process.pid;
const sleepers = [];
const LIVE = [];
const startSleepers = () => {
  for (let i = 0; i < 8; i++) {
    sleepers.push(cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }));
  }
  LIVE.push(...sleepers.map((s) => s.pid));
  if (new Set([...LIVE, ME]).size !== 9 || LIVE.some((pid) => !Number.isInteger(pid) || isGone(pid))) { console.error('fixture: the sleepers did not start'); process.exit(2); }
};
const cleanup = () => sleepers.forEach((s) => { try { s.kill('SIGKILL'); } catch { /* gone */ } });
process.on('exit', cleanup);

const ROOT = path.join(HOME, '.claude-code-orchestrator');
const MESH = path.join(ROOT, 'mesh');
const HOSTDIR = path.join(HOME, '.claude');
const W1DIR = path.join(HOME, '.claude-w1');
const W2DIR = path.join(HOME, '.claude-w2');
const WS = path.join(HOME, 'ws', 'proj');
const WS2 = path.join(HOME, 'ws', 'proj-2');
const EVILDIR = path.join(HOME, 'evil-config');
for (const d of [ROOT, HOSTDIR, W1DIR, W2DIR, EVILDIR, path.join(HOME, 'ws')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [MESH, path.join(ROOT, 'tasks'), path.join(HOSTDIR, 'sessions'), path.join(W1DIR, 'sessions'), path.join(W2DIR, 'sessions'), path.join(EVILDIR, 'sessions'), path.join(WS, 'sub'), WS2]) fs.mkdirSync(d, { recursive: true });

// The two FIFOs of the fixture, made while no other child of this suite is alive. The one in sessions/ stands at
// the entry name of a LIVE process (this one), in the w1 account's directory: the scan does try to read it.
cp.execFileSync('mkfifo', [path.join(W1DIR, 'sessions', process.pid + '.json')]);
fs.mkdirSync(path.join(HOSTDIR, 'teams', 'fifo'), { recursive: true });
cp.execFileSync('mkfifo', [path.join(HOSTDIR, 'teams', 'fifo', 'config.json')]);
startSleepers();

const NOW = Date.now();
const T1 = 'tteam00001', T3 = 'tteam00003', T4 = 'tteam00004';
const hashOf = (cwd) => crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 6);
const H = hashOf(WS);
const wt = (id) => '.claude/worktrees/cco-' + id;
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
mk(path.join(WS, wt(T1))); mk(path.join(WS, wt(T3))); mk(path.join(WS, wt(T4)));

fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers: [{ name: 'w1', configDir: W1DIR, model: 'opus' }, { name: 'w2', configDir: W2DIR, model: 'sonnet' }] }));
const taskBase = (id, extra) => Object.assign({ id, title: 'Title of ' + id, worker: 'w1', model: 'opus', outputFile: path.join(ROOT, 'tasks', id + '.md'), cwd: WS }, extra);
fs.writeFileSync(
  path.join(ROOT, 'tasks.jsonl'),
  [
    taskBase(T1, { ts: NOW - 600000, status: 'running', title: '‮Implement\nthe thing ' + 'x'.repeat(400), meshWorker: `cco-w-${H}-w1-1` }),
    taskBase(T3, { ts: NOW - 500000, status: 'running' }),
    taskBase(T3, { ts: NOW - 400000, status: 'done', meshWorker: `cco-w-${H}-main-1` }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n',
);

const entry = (dir, fileName, o) => fs.writeFileSync(path.join(dir, 'sessions', fileName), typeof o === 'string' ? o : JSON.stringify(o));
const sess = (pid, o) => Object.assign({ pid, sessionId: crypto.randomUUID(), cwd: WS, version: '2.1.283', peerProtocol: 1, kind: 'bg', messagingSocketPath: '/tmp/sock-' + pid, status: 'busy', updatedAt: NOW - 1000 }, o);
const rec = (o) => Object.assign({ name: `cco-w-${H}-w1-1`, account: 'w1', configDir: W1DIR, model: 'opus', role: 'dispatch', spawnedAt: NOW - 600000, ownerPid: 1, lastActivityAt: NOW - 600000 }, o);

// --- ledger of WS ------------------------------------------------------------------------
const workers = [
  rec({ jobId: 'aaaa1111', taskId: T1, worktree: wt(T1), branch: 'worktree-cco-' + T1, keepAlive: true }),                                   // live busy
  rec({ jobId: 'bbbb2222', name: `cco-w-${H}-w1-2`, settledAt: NOW - 100000, deadlineAt: NOW + 1 }),                                         // live waiting
  rec({ jobId: 'cccc3333', name: `cco-w-${H}-main-1`, account: 'main', configDir: HOSTDIR, taskId: T3, worktree: wt(T3), branch: 'worktree-cco-' + T3 }), // live idle on main, task done
  rec({ jobId: 'dddd4444', name: `cco-w-${H}-w1-4`, taskId: T4, stoppedAt: NOW - 50000, worktree: wt(T4), branch: 'worktree-cco-' + T4 }),    // stopped, worktree exists
  rec({ jobId: 'eeee5555', name: `cco-w-${H}-w1-5`, stoppedAt: NOW - 50000, worktree: wt('tgone00001'), branch: 'worktree-cco-tgone00001' }), // stopped, worktree gone
  rec({ jobId: 'eeee6666', name: `cco-w-${H}-w1-6`, spawnedAt: NOW - 3600000 }),                                                             // dead, never marked, no worktree
  rec({ jobId: 'eeee7777', name: `cco-w-${H}-w1-7`, spawnedAt: NOW - 5000 }),                                                                // just spawned, no entry yet
  rec({ jobId: '; rm -rf ~', name: 'evil-job' }),                                                                                            // hostile job id
  rec({ jobId: '--help', name: 'evil-job-2' }),
  rec({ jobId: 'f00dbabe', name: '‮evil\u0007name' + 'n'.repeat(300), configDir: EVILDIR, account: '‮acct', worktree: '../../../etc', branch: '--upload-pack=touch /tmp/pwned', taskId: '../../x', model: '\u202Emodel' + 'm'.repeat(300), spawnedAt: NOW - 4000 }), // unknown account + hostile fields
  rec({ jobId: 'f00dbab2', name: 'non-string-model', model: 5, spawnedAt: NOW - 2000 }),
  rec({ jobId: 'job_1-x', name: 'odd-job-id', spawnedAt: NOW - 2500 }),                                                                      // not hex, but a safe argument                                                      // not a well-formed record
  rec({ jobId: 'f00dbab1', name: 'abs-worktree', worktree: '/etc', branch: 'a..b', spawnedAt: NOW - 3000 }),
  rec({ jobId: 'ffff6666', name: `cco-w-${H}-w2-1`, account: 'w2', configDir: W2DIR, pid: LIVE[2] }),                                         // littered dir, found by direct read
  rec({ jobId: 'abab7777', name: `cco-w-${H}-w2-2`, account: 'w2', configDir: W2DIR, spawnedAt: NOW - 3600000 }),                              // littered dir, not found → unknown
  rec({ jobId: 'abab8888', name: `cco-w-${H}-w2-3`, account: 'w2', configDir: W2DIR, spawnedAt: NOW - 3600000, stoppedAt: NOW - 1000 }),       // littered dir, ledger says stopped, no worktree
  null, 5, 'str', { name: 'no-job' }, rec({ jobId: 'aaaa1111', name: 'duplicate-job-id' }),
];
fs.writeFileSync(path.join(MESH, H + '.json'), JSON.stringify({ ownerPid: 1, cwd: WS, gatewayName: 'cco-gw-old', startedAt: NOW - 700000, workers }));
// other ledgers (scope 'all' only)
fs.writeFileSync(path.join(MESH, hashOf(WS2) + '.json'), JSON.stringify({ ownerPid: 1, cwd: WS2, startedAt: NOW, workers: [rec({ jobId: 'cdcd8888', name: `cco-w-${hashOf(WS2)}-w1-1`, spawnedAt: NOW - 700000 })] }));
fs.writeFileSync(path.join(MESH, 'garbage.json'), 'not json');
fs.writeFileSync(path.join(MESH, 'arr.json'), '[]');
fs.writeFileSync(path.join(MESH, 'nullfile.json'), 'null');
fs.writeFileSync(path.join(MESH, 'workers-string.json'), JSON.stringify({ cwd: WS, workers: 'nope' }));
fs.writeFileSync(path.join(MESH, 'nocwd.json'), JSON.stringify({ workers: [rec({ jobId: '12ab34cd', name: 'no-cwd-worker', worktree: wt(T1), spawnedAt: NOW - 800000 })] }));
fs.writeFileSync(path.join(MESH, H + '.json.123.tmp'), 'partial');
fs.writeFileSync(path.join(MESH, H + '.lock'), '1 2 3');

// --- session entries ------------------------------------------------------------------------
// `at(dir, pid, body)` writes the entry of process `pid`: the file `<pid>.json`.
const at = (dir, pid, body) => entry(dir, pid + '.json', body);
if (!isGone(DEAD)) { console.error('fixture: the reaped pid ' + DEAD + ' is in use again'); process.exit(2); }

// the w1 account: three workers, the entry of a dead process …
at(W1DIR, LIVE[0], sess(LIVE[0], { jobId: 'aaaa1111', name: `cco-w-${H}-w1-1`, cwd: path.join(WS, wt(T1)), status: 'busy' }));
at(W1DIR, LIVE[1], sess(LIVE[1], { jobId: 'bbbb2222', name: `cco-w-${H}-w1-2`, status: 'waiting', waitingFor: '‮permission\nto run tests ' + 'w'.repeat(400) }));
at(W1DIR, LIVE[4], sess(LIVE[4], { jobId: 'cdcd8888', name: 'other-ws-worker', cwd: WS2, status: 'idle' }));
at(W1DIR, DEAD, sess(DEAD, { jobId: 'eeee6666', name: 'dead-entry' }));
// … and five entries of LIVE processes that are not sessions to list, each for one reason only (the sixth
// free pid of this directory, this process's own, is the FIFO made above):
at(W1DIR, LIVE[2], sess(LIVE[2], { kind: 'interactive', name: 'oversized-entry', pad: 'p'.repeat(100 * 1024) }));                      // 100 KiB: not read
at(W1DIR, LIVE[3], { pid: LIVE[3], sessionId: 'litter', cwd: WS, version: '2.1.200', peerProtocol: 1, kind: 'interactive', entrypoint: 'sdk-cli', name: 'no-socket-litter' }); // alive, but no socket
at(W1DIR, LIVE[5], sess(LIVE[5] + 0.5, { kind: 'interactive', name: 'float-pid' }));                                                   // its `pid` field is not its name's number
at(W1DIR, LIVE[6], sess(String(LIVE[6]), { kind: 'interactive', name: 'string-pid' }));                                                // … is that number as a STRING
at(W1DIR, LIVE[7], Object.assign(sess(LIVE[0], { kind: 'interactive', name: 'pid-of-another-process' }), { messagingSocketPath: '/tmp/sock-x' })); // … is another live process

// the truncated directory: 1,300 entries of dead processes with their keys (2,600 files), plus the real entry of a known pid
LITTER.forEach((p, i) => {
  fs.writeFileSync(path.join(W2DIR, 'sessions', p + '.json'), JSON.stringify({ pid: p, sessionId: 's' + i, cwd: os.tmpdir(), version: '2.1.200', peerProtocol: 1, kind: 'interactive', entrypoint: 'sdk-cli' }));
  fs.writeFileSync(path.join(W2DIR, 'sessions', p + '.' + 'a'.repeat(64) + '.key'), 'k');
});
at(W2DIR, LIVE[2], sess(LIVE[2], { jobId: 'ffff6666', name: `cco-w-${H}-w2-1`, status: 'idle' }));

at(EVILDIR, LIVE[6], sess(LIVE[6], { jobId: 'f00dbabe', name: 'in-a-foreign-dir', status: 'busy' }));

// host account: a worker, peers, and junk. Nine entries of live processes — this one and the eight sleepers.
at(HOSTDIR, ME, sess(ME, { kind: 'interactive', entrypoint: 'claude-vscode', name: 'my-session', sessionId: 'abcdef01-1111-4222-8333-444444444444', status: 'idle', startedAt: NOW - 900000 }));
at(HOSTDIR, LIVE[3], sess(LIVE[3], { name: `cco-w-${H}-main-1`, sessionId: 'cccc3333-0000-4000-8000-000000000000', cwd: path.join(WS, wt(T3)), status: 'idle' })); // no jobId field: matched by session id prefix
at(HOSTDIR, LIVE[0], sess(LIVE[0], { jobId: 'aaaa1111', name: `cco-w-${H}-w1-1`, ccoMirror: true }));                                  // the bridge's copy of w1's worker
at(HOSTDIR, LIVE[5], { pid: LIVE[5], sessionId: 'x', cwd: WS, kind: 'interactive', name: 'no-version-fields', messagingSocketPath: '/tmp/s' });
at(HOSTDIR, LIVE[4], { sessionId: 'y', cwd: WS, kind: 'interactive', name: 'no-pid-field', messagingSocketPath: '/tmp/s' });           // no `pid` inside: the name decides
at(HOSTDIR, LIVE[1], sess(LIVE[1], { kind: 'interactive', name: 'peer-in-proj-2', cwd: WS2, status: 'busy' }));
at(HOSTDIR, LIVE[6], sess(LIVE[6], { kind: 'interactive', name: '‮hostile\u0000peer' + 'h'.repeat(300), sessionId: '<img src=x>', cwd: path.join(WS, 'sub'), status: 'weird', updatedAt: 'x', model: '‮m' + 'm'.repeat(200), waitingFor: 7 }));
at(HOSTDIR, LIVE[7], sess(LIVE[7], { kind: 'bg', name: 'manual-bg', jobId: '99aa88bb', sessionId: '99aa88bb-0000-4000-8000-000000000000', status: 'waiting', waitingFor: 'your answer' }));
at(HOSTDIR, LIVE[2], sess(LIVE[2], { kind: 'interactive', name: 'relative-cwd', sessionId: 'feedface-0000', cwd: '.' }));
at(HOSTDIR, DEAD, sess(DEAD, { name: 'dead-peer', kind: 'interactive' }));
// Files whose NAME is not a process id are passed over without being opened. Each of these holds a complete,
// listable session of a live process (LIVE[7]), so only its name keeps it off the list.
// (No upper-case `<pid>.JSON` among them: on a case-insensitive file system that IS the entry `<pid>.json`.)
const ODD_NAMES = ['session.json', `0${LIVE[7]}.json`, `+${LIVE[7]}.json`, `${LIVE[7]}.json.bak`, ` ${LIVE[7]}.json`, `${LIVE[7]}.5.json`, '4294967297.json', '0.json']; // 4294967297: ten digits, past the largest pid there can be
ODD_NAMES.forEach((name, i) => entry(HOSTDIR, name, sess(LIVE[7], { kind: 'interactive', name: 'odd-name-' + i })));
entry(HOSTDIR, 'junk.json', 'this is not json');
fs.writeFileSync(path.join(HOSTDIR, 'sessions', DEAD + '.' + 'b'.repeat(64) + '.key'), 'k');
// (the FIFO of this fixture stands in the w1 directory, at this process's own entry name — see above)
fs.mkdirSync(path.join(HOSTDIR, 'sessions', 'dir.json'));

// --- native teams ---------------------------------------------------------------------------
const team = (name, content) => { mk(path.join(HOSTDIR, 'teams', name)); fs.writeFileSync(path.join(HOSTDIR, 'teams', name, 'config.json'), typeof content === 'string' ? content : JSON.stringify(content)); };
team('x', {
  name: 'alpha', createdAt: NOW, leadAgentId: 'team-lead@alpha', leadSessionId: 'abc',
  members: [
    { agentId: 'team-lead@alpha', name: 'team-lead', agentType: 'team-lead', cwd: WS, joinedAt: NOW },
    { agentId: 'researcher@alpha', name: 'researcher', agentType: 'researcher', model: 'sonnet', backendType: 'in-process', cwd: WS, isActive: true, joinedAt: NOW - 1000 },
    { agentId: 'tester@alpha', name: 'tester', agentType: 'general-purpose', cwd: path.join(WS, 'sub'), isActive: false, joinedAt: new Date(NOW - 2000).toISOString() },
    { agentId: 'elsewhere@alpha', name: 'elsewhere', agentType: 'x', cwd: WS2 },
    { agentId: 'nocwd@alpha', name: 'nocwd', agentType: 'x' },
    { agentId: 'team-lead@alpha', name: 'lead-by-id', agentType: 'worker', cwd: WS },
    { agentId: 'sneaky@alpha', name: 'sneaky', agentType: 'worker', cwd: WS },
    { agentId: '‮id' + 'i'.repeat(500), name: '‮hostile\nmate' + 'z'.repeat(300), agentType: '‮role' + 'r'.repeat(300), model: 5, cwd: WS, isActive: 'yes', joinedAt: 'not a date' },
    'str', null, 5, [], { cwd: WS },
  ],
});
team('arr', '[1,2,3]');
team('nope', { name: 'nope', members: 'nope' });
team('nullteam', 'null');
team('notjson', '{{{');
team('big', JSON.stringify({ name: 'big', members: [{ agentId: 'a', name: 'too-big', cwd: WS }], pad: 'p'.repeat(100 * 1024) }));
mk(path.join(HOSTDIR, 'teams', 'empty'));
fs.writeFileSync(path.join(HOSTDIR, 'teams', 'afile'), 'x');
// (teams/fifo/config.json — a FIFO — was made above, before the sleepers started)

// --- load -----------------------------------------------------------------------------------
const bundle = require(path.resolve(process.argv[2]));
const team_ = bundle.team || bundle;
const ui = bundle.ui;
const dt = bundle.dt;
const INCOMPLETE = '(session list incomplete — run "Clean up stale session files")';
const CAPS = { name: 80, accountName: 64, detail: 160, taskTitle: 160, model: 64, location: 120, branch: 120, team: 64, role: 64, key: 160 };
function invariants(label, rows) {
  const problems = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (v === undefined) problems.push(r.key + '.' + k + ' undefined');
      if (typeof v === 'number' && !Number.isFinite(v)) problems.push(r.key + '.' + k + ' not finite');
      if (typeof v === 'string') {
        if (dt && dt.flattenOneLine(v) !== v) problems.push(r.key + '.' + k + ' not flattened');
        if (CAPS[k] !== undefined && v.length > CAPS[k]) problems.push(r.key + '.' + k + ' over cap: ' + v.length);
        if (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) problems.push(r.key + '.' + k + ' is absolute: ' + v);
      }
    }
    if (Object.keys(r).length !== 22) problems.push(r.key + ' has ' + Object.keys(r).length + ' fields');
  }
  check(label + ': rows are complete, finite, flattened, capped; nothing absolute', problems.length === 0, problems.slice(0, 5).join(' | ') || undefined);
  check(label + ': keys unique', new Set(rows.map((r) => r.key)).size === rows.length);
  const json = JSON.stringify(rows);
  check(label + ': no config dir, socket path or home path in any row', !json.includes(HOME) && !json.includes('/tmp/sock') && !json.includes('evil-config'));
}

const t0 = Date.now();
const rows = noThrow('collectSessions(workspace)', () => team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW }));
check('collectSessions returns promptly despite FIFOs in sessions/ and teams/', Date.now() - t0 < 3000, (Date.now() - t0) + ' ms');
invariants('workspace scope', rows);
const by = (name) => rows.find((r) => r.name === name);
const rs_ = (k) => team_.resolveSession(k);
const key = (k) => rows.find((r) => r.key === k);
const accKey = (dir) => crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
console.log('  rows: ' + rows.map((r) => `${r.source}/${r.status}/${r.name.slice(0, 28)}`).join(', '));

// --- workers ---
const wBusy = key('worker:aaaa1111');
check('worker: live entry busy → busy, joined with task title, worktree-relative location', wBusy && wBusy.status === 'busy' && wBusy.source === 'worker' && wBusy.kind === 'background' && wBusy.taskId === T1 && wBusy.taskTitle.startsWith('Implement the thing x') && wBusy.taskTitle.length === 160 && wBusy.location === wt(T1) && wBusy.branch === 'worktree-cco-' + T1 && wBusy.unmerged === true && wBusy.settled === false && wBusy.inWorkspace === true && wBusy.canAttach === true && wBusy.canStop === true && wBusy.accountName === 'w1' && wBusy.accountKey === accKey(W1DIR) && wBusy.model === 'opus' && wBusy.startedAt === NOW - 600000 && wBusy.updatedAt === NOW - 1000, JSON.stringify(wBusy));
const wWait = key('worker:bbbb2222');
check('worker: waiting → waiting, detail = waitingFor (flattened, ≤160), settled from settledAt', wWait && wWait.status === 'waiting' && wWait.detail.startsWith('permission to run tests w') && wWait.detail.length === 160 && wWait.settled === true && wWait.unmerged === false && wWait.location === 'proj', JSON.stringify(wWait));
const wIdle = key('worker:cccc3333');
check('worker: idle on the main account; matched by session-id prefix; settled from the task\'s terminal status', wIdle && wIdle.status === 'idle' && wIdle.detail === null && wIdle.settled === true && wIdle.accountName === 'main' && wIdle.accountKey === accKey(HOSTDIR) && wIdle.taskTitle === 'Title of ' + T3, JSON.stringify(wIdle));
const wStopped = key('worker:dddd4444');
check('worker: stopped + worktree on disk → listed as stopped/unmerged, cannot be stopped again', wStopped && wStopped.status === 'stopped' && wStopped.unmerged === true && wStopped.canStop === false && wStopped.taskTitle === null && wStopped.updatedAt === NOW - 50000, JSON.stringify(wStopped));
check('worker: stopped + worktree gone → not listed', !key('worker:eeee5555'));
check('worker: dead (no entry, past the grace, no worktree) → not listed, even with a dead-pid entry file', !key('worker:eeee6666'));
const wFresh = key('worker:eeee7777');
check('worker: spawned 5 s ago with no entry yet → unknown, not stopped', wFresh && wFresh.status === 'unknown', JSON.stringify(wFresh && wFresh.status));
check('worker: hostile job ids and malformed records are not rows', !rows.some((r) => r.name === 'evil-job' || r.name === 'evil-job-2' || r.name === 'no-job' || r.name === 'non-string-model'));
check('worker: a second record with the same job id does not replace the first', !by('duplicate-job-id') && wBusy.name === `cco-w-${H}-w1-1`);
const wEvil = key('worker:f00dbabe');
check('worker [UPDATED: a ledger directory that is no current Claude Code account is not looked into]: config dir of no known account → status "unknown" although a matching live entry sits in that directory, no account, not attachable / stoppable; hostile branch / worktree / task id dropped', wEvil && wEvil.accountKey === null && wEvil.status === 'unknown' && wEvil.canAttach === false && wEvil.canStop === false && wEvil.branch === null && wEvil.unmerged === false && wEvil.taskId === null && wEvil.model.length === 64 && wEvil.model.startsWith('modelm') && wEvil.accountName === 'acct' && wEvil.name.startsWith('evil name') && wEvil.name.length === 80, JSON.stringify(wEvil));
const wAbs = key('worker:f00dbab1');
check('worker: absolute worktree and a ".." branch are refused', wAbs && wAbs.unmerged === false && wAbs.branch === null && wAbs.location === 'proj', JSON.stringify(wAbs && [wAbs.unmerged, wAbs.branch, wAbs.location]));
const wDirect = key('worker:ffff6666');
check('worker in a truncated session dir: found by reading <pid>.json directly', wDirect && wDirect.status === 'idle' && wDirect.accountName === 'w2', JSON.stringify(wDirect && wDirect.status));
const wUnknown = key('worker:abab7777');
check('worker in a truncated session dir, not found → unknown (absence proves nothing), still listed', wUnknown && wUnknown.status === 'unknown', JSON.stringify(wUnknown && wUnknown.status));
check('worker the ledger marks stopped, no worktree → not listed even in a truncated dir', !key('worker:abab8888'));
const wOdd = key('worker:job_1-x');
check('worker: a job id that is not hex but is a safe argument is accepted verbatim', wOdd && wOdd.status === 'unknown' && rs_('worker:job_1-x').jobId === 'job_1-x');
check('scope workspace: a worker of another workspace\'s ledger is not listed as a worker', !key('worker:cdcd8888') && !key('worker:12ab34cd'));

// --- incomplete listing ---
const inc = rows.filter((r) => r.name === INCOMPLETE);
check('truncated session dir → exactly ONE synthetic row for that account, status unknown', inc.length === 1 && inc[0].status === 'unknown' && inc[0].accountName === 'w2' && inc[0].accountKey === accKey(W2DIR) && inc[0].canAttach === false && inc[0].canStop === false && typeof inc[0].detail === 'string', JSON.stringify(inc));

// --- teammates ---
const mates = rows.filter((r) => r.source === 'teammate');
check('teammates: members other than the lead (by type or by id), inside the workspace; a member with no id and no name is skipped', JSON.stringify(mates.map((r) => r.name.slice(0, 12)).sort()) === JSON.stringify(['hostile mate', 'researcher', 'sneaky', 'tester'].sort()), JSON.stringify(mates.map((r) => r.name.slice(0, 12))));
const researcher = by('researcher');
check('teammate: isActive true → busy; kind teammate; role, team, account = main; never attachable', researcher && researcher.status === 'busy' && researcher.kind === 'teammate' && researcher.role === 'researcher' && researcher.team === 'alpha' && researcher.accountKey === accKey(HOSTDIR) && researcher.accountName === 'main' && researcher.canAttach === false && researcher.canStop === false && researcher.model === 'sonnet' && researcher.startedAt === NOW - 1000 && researcher.location === 'proj' && /^teammate:[0-9a-f]{16}$/.test(researcher.key), JSON.stringify(researcher));
const tester = by('tester');
check('teammate: isActive false → idle; ISO joinedAt parsed; sub-folder location', tester && tester.status === 'idle' && tester.location === 'sub' && tester.startedAt === Math.floor((NOW - 2000)), JSON.stringify(tester && [tester.status, tester.location, tester.startedAt]));
const hostileMate = mates.find((r) => r.name.startsWith('hostile mate'));
check('teammate: isActive neither true nor false → unknown; hostile name/role capped', hostileMate && hostileMate.status === 'unknown' && hostileMate.name.length === 80 && hostileMate.role.length === 64 && hostileMate.model === null && hostileMate.startedAt === null, JSON.stringify(hostileMate && [hostileMate.status, hostileMate.name.length, hostileMate.role.length]));
check('teams: an array config, members:"nope", null, non-JSON, a 100 KiB config and a FIFO contribute nothing', !rows.some((r) => r.team !== null && r.team !== 'alpha') && !by('too-big'));

// --- peers ---
const peers = rows.filter((r) => r.source === 'peer' && r.name !== INCOMPLETE);
// [second review: the list was 'hostile peer', 'manual-bg', 'my-session', 'no-version-f' — an entry with no `pid` inside was
// not a session.] The pid is the file name's; a `pid` field is optional, so the entry without one is a session too.
check('peers: live + socket + not a mirror + inside the workspace + not already a worker (an entry without version / peerProtocol, or without a `pid` field, is still a session)', JSON.stringify(peers.map((r) => r.name.slice(0, 12)).sort()) === JSON.stringify(['hostile peer', 'manual-bg', 'my-session', 'no-pid-field', 'no-version-f'].sort()), JSON.stringify(peers.map((r) => r.name.slice(0, 14))));
{
  const np = by('no-pid-field');
  check('peer: an entry with no `pid` field takes its process from its file name — key peer:<account>:<pid of the name>:<tag>, listed under the account whose directory holds it', np && np.source === 'peer' && np.kind === 'interactive' && new RegExp(`^peer:${accKey(HOSTDIR)}:${LIVE[4]}:[0-9a-f]{8}$`).test(np.key) && np.accountName === 'main' && np.canAttach === false, JSON.stringify(np && np.key));
}
const mine = by('my-session');
check('peer: own-pid entry → interactive, idle, key = peer:<account>:<pid>:<sessionId[:8]>, not attachable', mine && mine.kind === 'interactive' && mine.status === 'idle' && mine.key === `peer:${accKey(HOSTDIR)}:${process.pid}:abcdef01` && mine.canAttach === false && mine.canStop === false && mine.accountName === 'main' && mine.location === 'proj' && mine.startedAt === NOW - 900000 && mine.updatedAt === NOW - 1000, JSON.stringify(mine));
const bg = by('manual-bg');
check('peer: kind bg with a job id → background, attachable; waiting detail', bg && bg.kind === 'background' && bg.canAttach === true && bg.canStop === true && bg.status === 'waiting' && bg.detail === 'your answer', JSON.stringify(bg));
const hp = peers.find((r) => r.name.startsWith('hostile peer'));
check('peer: hostile fields → name capped, status unknown, non-hex session id hashed into the key', hp && hp.name.length === 80 && hp.status === 'unknown' && hp.updatedAt === null && hp.model.length === 64 && hp.location === 'sub' && /^peer:[0-9a-f]{16}:\d+:[0-9a-f]{8}$/.test(hp.key), JSON.stringify(hp && [hp.key, hp.status, hp.location]));
// [second review: "missing / fractional / string pid are not listed" — the missing one is listed now (above); the other two
// are entries whose own `pid` field contradicts the name they stand under, as is one that names another live process.]
check('peers: dead pid, ccoMirror, 100 KiB entry, no-socket litter, other workspace, relative cwd, and an entry whose `pid` field contradicts its file name (a fraction, a string, another live process) are not listed',
  !by('dead-peer') && !by('oversized-entry') && !by('no-socket-litter') && !by('peer-in-proj-2') && !by('relative-cwd') && !by('float-pid') && !by('string-pid') && !by('pid-of-another-process') && !by('in-a-foreign-dir') && !rows.some((r) => r.source === 'peer' && r.name.startsWith('cco-w-')));
check('peers: a file whose name is not a canonical process id — a word, a leading zero, a sign, a suffix, a space, a fraction, a number past the pid range, zero — is passed over, whatever session it holds',
  ODD_NAMES.length === 8 && !rows.some((r) => r.name.startsWith('odd-name-')), rows.filter((r) => r.name.startsWith('odd-name-')).map((r) => r.name).join(','));

// --- resolveSession ---
const rs = team_.resolveSession;
const rBusy = rs('worker:aaaa1111');
check('resolveSession(worker) → config dir of the known account, job id, existing worktree, branch, workspace cwd, task id', rBusy && rBusy.key === 'worker:aaaa1111' && rBusy.source === 'worker' && rBusy.name === `cco-w-${H}-w1-1` && rBusy.configDir === W1DIR && rBusy.jobId === 'aaaa1111' && rBusy.worktreeAbs === path.join(WS, wt(T1)) && rBusy.branch === 'worktree-cco-' + T1 && rBusy.cwd === WS && rBusy.taskId === T1, JSON.stringify(rBusy));
const rEvil = rs('worker:f00dbabe');
check('resolveSession(hostile record) → no config dir, no worktree, no branch, no task id; name is what was shown', rEvil && rEvil.configDir === undefined && rEvil.worktreeAbs === undefined && rEvil.branch === undefined && rEvil.taskId === undefined && rEvil.jobId === 'f00dbabe' && rEvil.name === wEvil.name, JSON.stringify(rEvil));
const rMate = rs(researcher.key);
check('resolveSession(teammate) → no job id, host config dir, member cwd', rMate && rMate.source === 'teammate' && rMate.jobId === undefined && rMate.configDir === HOSTDIR && rMate.cwd === WS && rMate.name === 'researcher', JSON.stringify(rMate));
const rPeer = rs(mine.key);
check('resolveSession(peer without job) → no job id', rPeer && rPeer.jobId === undefined && rPeer.configDir === HOSTDIR && rPeer.cwd === WS && rPeer.name === 'my-session', JSON.stringify(rPeer));
check('resolveSession(bg peer) → job id', rs(bg.key).jobId === '99aa88bb');
check('resolveSession(synthetic incomplete row) → undefined', rs(inc[0].key) === undefined);
for (const bad of ['worker:zzzz', 'worker:AAAA1111', 'worker:aaaa1111 ', ' worker:aaaa1111', 'aaaa1111', 'worker:', 'peer:../../etc/passwd', '', 'x'.repeat(5000), null, undefined, 5, {}, ['worker:aaaa1111'], { key: 'worker:aaaa1111' }, '__proto__', 'constructor']) {
  check('resolveSession rejects ' + JSON.stringify(typeof bad === 'string' ? bad.slice(0, 30) : bad), rs(bad) === undefined);
}
rBusy.configDir = '/mutated';
check('resolveSession returns a copy', rs('worker:aaaa1111').configDir === W1DIR);

// --- cache ---
const counters = { opendirSync: 0, openSync: 0, readFileSync: 0, statSync: 0 };
const originals = {};
for (const k of Object.keys(counters)) { originals[k] = fs[k]; fs[k] = function (...a) { counters[k]++; return originals[k].apply(fs, a); }; }
const reset = () => { for (const k of Object.keys(counters)) counters[k] = 0; };
reset();
const cachedRows = team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 2000 });
check('within maxAgeMs (default 3 s): answered from cache, no file system access at all', JSON.stringify(cachedRows) === JSON.stringify(rows) && Object.values(counters).every((n) => n === 0), JSON.stringify(counters));
cachedRows[0].name = 'mutated';
check('the cache is not exposed to mutation by a caller', team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 2000 })[0].name !== 'mutated');
reset();
team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 3500 });
check('past maxAgeMs: re-collected', counters.opendirSync > 0, JSON.stringify(counters));
reset();
team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 3600, maxAgeMs: 0 });
check('maxAgeMs 0: always re-collected', counters.opendirSync > 0);
reset();
team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 3700 });
const beforeInvalidate = counters.opendirSync;
team_.invalidateTeamCache();
check('after invalidateTeamCache, keys already shown still resolve', rs('worker:aaaa1111') !== undefined);
team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW + 3800 });
check('invalidateTeamCache forces the next collection to re-read', beforeInvalidate === 0 && counters.opendirSync > 0, beforeInvalidate + ' → ' + counters.opendirSync);
for (const k of Object.keys(originals)) fs[k] = originals[k];

// --- scope all ---
const all = noThrow('collectSessions(all)', () => team_.collectSessions({ workspaceRoot: WS, scope: 'all', now: NOW }));
invariants('all scope', all);
const akey = (k) => all.find((r) => r.key === k);
check('scope all: worker of another workspace listed with inWorkspace false and a folder label', akey('worker:cdcd8888') && akey('worker:cdcd8888').inWorkspace === false && akey('worker:cdcd8888').status === 'idle' && akey('worker:cdcd8888').location === 'proj-2', JSON.stringify(akey('worker:cdcd8888')));
check('scope all: a ledger with no cwd still lists its (stopped-or-unknown) worker only when live', !akey('worker:12ab34cd'));
check('scope all: this workspace\'s workers are still there, inWorkspace true', akey('worker:aaaa1111') && akey('worker:aaaa1111').inWorkspace === true && akey('worker:aaaa1111').location === wt(T1));
check('scope all: peers and teammates of other folders appear, flagged', all.some((r) => r.name === 'peer-in-proj-2' && r.inWorkspace === false && r.location === 'proj-2') && all.some((r) => r.name === 'elsewhere' && r.inWorkspace === false) && all.some((r) => r.name === 'nocwd' && r.location === null) && all.some((r) => r.name === 'relative-cwd' && r.location === null));
check('scope all: a session already listed as a worker is not listed again as a peer', !all.some((r) => r.source === 'peer' && (r.name === 'other-ws-worker' || r.name.startsWith('cco-w-'))));
check('scope all: what is not a session in one scope is not one in the other — the contradicting, oversized, socket-less, dead and oddly named entries', !all.some((r) => ['float-pid', 'string-pid', 'pid-of-another-process', 'oversized-entry', 'no-socket-litter', 'dead-peer', 'dead-entry'].includes(r.name) || r.name.startsWith('odd-name-')));
check('scope all: garbage / array / null ledgers and temp files are ignored', all.filter((r) => r.source === 'worker').every((r) => /^worker:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(r.key)) && all.filter((r) => r.source === 'worker').length === rows.filter((r) => r.source === 'worker').length + 1);
check('both scopes keep resolving (the dashboard and the tree view use different scopes)', rs('worker:cdcd8888') && rs('worker:cdcd8888').cwd === WS2 && rs('worker:aaaa1111') && rs(mine.key) !== undefined);
check('workspace-scope keys still resolve after an all-scope collection and vice versa', rs(researcher.key) !== undefined);
check('location is never absolute (both scopes)', [...rows, ...all].every((r) => r.location === null || (!path.isAbsolute(r.location) && !r.location.startsWith('..'))), JSON.stringify([...new Set([...rows, ...all].map((r) => r.location))]));

// --- the rows feed the dashboard model ---
if (ui) {
  const model = ui.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: {}, health: {}, sessions: rows, now: NOW });
  const t1 = model.tasks.find((t) => t.id === T1), t3 = model.tasks.find((t) => t.id === T3);
  check('model: collected rows pass through unchanged', JSON.stringify(model.sessions) === JSON.stringify(rows));
  check('model: a session task takes branch + unmerged from its worker row', t1 && t1.mode === 'session' && t1.branch === 'worktree-cco-' + T1 && t1.unmerged === true && t1.sessionWorker === `cco-w-${H}-w1-1` && t3.branch === 'worktree-cco-' + T3 && t3.unmerged === true, JSON.stringify(t1 && [t1.mode, t1.branch, t1.unmerged]));
}

// --- keys of a collection nobody refreshes stop resolving ---
{
  const realNow = Date.now;
  Date.now = () => realNow() + 9 * 60_000;
  const at9 = rs('worker:aaaa1111') !== undefined;
  Date.now = () => realNow() + 11 * 60_000;
  const at11 = rs('worker:aaaa1111');
  Date.now = () => realNow() - 60_000;
  const backwards = rs('worker:aaaa1111');
  Date.now = realNow;
  check('a collection keeps resolving for 10 minutes, then (or if the clock went backwards) answers nothing', at9 === true && at11 === undefined && backwards === undefined && rs('worker:aaaa1111') !== undefined);
}

// --- entries of live processes whose CONTENT is not a session (second group, on pids already running) ---
// Five of the w1 directory's pids, and this process's own, are re-used: what stood under them above has been
// checked. Each of the six is now something a scan must survive at the entry name of a process that exists.
{
  const w1Sessions = path.join(W1DIR, 'sessions');
  const through = path.join(HOME, 'elsewhere-session.json');
  fs.writeFileSync(through, JSON.stringify(sess(LIVE[7], { kind: 'interactive', name: 'through-a-symlink' })));
  for (const pid of [LIVE[2], LIVE[3], LIVE[5], LIVE[6], LIVE[7], ME]) fs.rmSync(path.join(w1Sessions, pid + '.json'), { force: true });
  at(W1DIR, LIVE[2], 'this is not json {"name":"not-json"');
  at(W1DIR, LIVE[3], 'null');
  at(W1DIR, LIVE[5], JSON.stringify([sess(LIVE[5], { kind: 'interactive', name: 'in-an-array' })]));
  at(W1DIR, LIVE[6], '');
  fs.symlinkSync(through, path.join(w1Sessions, LIVE[7] + '.json'));
  fs.mkdirSync(path.join(w1Sessions, ME + '.json'));
  team_.invalidateTeamCache();
  const t1 = Date.now();
  const second = noThrow('collectSessions(workspace) over non-JSON, null, an array, an empty file, a symbolic link and a directory at live entry names', () => team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW }));
  const names = second.map((r) => r.name);
  check('entries of live processes that are not JSON, are `null`, an array or empty, a symbolic link to a real session and a directory: none is listed, the link is not followed, and the sessions beside them still are',
    Date.now() - t1 < 3000 && !names.some((n) => ['not-json', 'in-an-array', 'through-a-symlink'].includes(n)) && second.filter((r) => r.source === 'peer' && r.accountName === 'w1').length === 0
    && ['my-session', 'manual-bg', 'no-pid-field', 'no-version-fields'].every((n) => names.includes(n)) && second.some((r) => r.key === 'worker:aaaa1111' && r.status === 'busy') && second.some((r) => r.key === 'worker:bbbb2222' && r.status === 'waiting'),
    (Date.now() - t1) + ' ms; w1 peers: ' + second.filter((r) => r.source === 'peer' && r.accountName === 'w1').map((r) => r.name).join(',') + '; ' + names.filter((n) => !n.startsWith('cco-w-')).map((n) => n.slice(0, 16)).join(', '));
  invariants('second group', second);
}

// --- a stopped worker is listed only while its worktree exists ---
fs.rmSync(path.join(WS, wt(T4)), { recursive: true });
team_.invalidateTeamCache();
const afterRm = team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW });
check('stopped worker disappears once its worktree directory is removed', !afterRm.some((r) => r.key === 'worker:dddd4444') && afterRm.some((r) => r.key === 'worker:aaaa1111'));
check('… and its key no longer resolves in that scope\'s collection', team_.collectSessions({ workspaceRoot: WS, scope: 'all', now: NOW, maxAgeMs: 0 }) && rs('worker:dddd4444') === undefined);
// a worktree path that is a FILE is not a worktree
fs.rmSync(path.join(WS, wt(T3)), { recursive: true }); fs.writeFileSync(path.join(WS, wt(T3)), 'x');
team_.invalidateTeamCache();
const fileWt = team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW }).find((r) => r.key === 'worker:cccc3333');
check('a worktree path that is a file is not "unmerged"', fileWt && fileWt.unmerged === false && rs('worker:cccc3333').worktreeAbs === undefined);
// the live worker's process dies (awaited: a killed child stays a zombie — and `kill(pid, 0)`
// keeps succeeding — until this process reaps it on the event loop)
(async () => {
await new Promise((res) => { sleepers[0].once('exit', res); sleepers[0].kill('SIGKILL'); });
team_.invalidateTeamCache();
const afterKill = team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW }).find((r) => r.key === 'worker:aaaa1111');
check('a worker whose process died is stopped (still listed: its worktree exists)', afterKill && afterKill.status === 'stopped' && afterKill.unmerged === true && afterKill.canStop === false, JSON.stringify(afterKill && afterKill.status));

// --- no workspace / garbage options ---
check('scope workspace with no workspace → no rows', team_.collectSessions({ workspaceRoot: undefined, scope: 'workspace' }).length === 0);
const noWs = noThrow('collectSessions(all, no workspace)', () => team_.collectSessions({ workspaceRoot: undefined, scope: 'all', now: NOW }));
check('scope all with no workspace → rows, none inWorkspace except the synthetic one', noWs.length > 0 && noWs.every((r) => r.inWorkspace === false || r.name === INCOMPLETE));
for (const bad of [undefined, null, 5, 'x', [], { workspaceRoot: 5, scope: {} }, { workspaceRoot: '.', scope: 'workspace' }, { workspaceRoot: 'relative/path', scope: 'all', now: 'x', maxAgeMs: -5 }, { workspaceRoot: WS + '\u0000x', scope: 'workspace' }]) {
  const r = noThrow('collectSessions(' + JSON.stringify(bad) + ')', () => team_.collectSessions(bad));
  check('  … and returns an array', Array.isArray(r));
}

// --- everything missing / hostile directories ---
fs.rmSync(MESH, { recursive: true }); fs.writeFileSync(MESH, 'a file where the mesh dir should be');
fs.rmSync(path.join(HOSTDIR, 'teams'), { recursive: true }); fs.writeFileSync(path.join(HOSTDIR, 'teams'), 'file');
fs.rmSync(path.join(W1DIR, 'sessions'), { recursive: true }); fs.writeFileSync(path.join(W1DIR, 'sessions'), 'file');
fs.rmSync(path.join(W2DIR), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers: [{ name: 'w1', configDir: W1DIR }, { name: 'w2', configDir: W2DIR }, { name: 'ghost', configDir: path.join(HOME, 'nope') }] }));
team_.invalidateTeamCache();
const bare = noThrow('collectSessions(all) with files where directories should be', () => team_.collectSessions({ workspaceRoot: WS, scope: 'all', now: NOW }));
invariants('degraded', bare);
check('degraded: peers of the host account still listed, no incomplete row for an ABSENT directory', bare.some((r) => r.name === 'my-session') && bare.filter((r) => r.name === INCOMPLETE).length === 0, JSON.stringify(bare.map((r) => r.name.slice(0, 20))));
if (process.getuid() !== 0) {
  fs.chmodSync(path.join(HOSTDIR, 'sessions'), 0o000);
  team_.invalidateTeamCache();
  const denied = noThrow('collectSessions with an unreadable sessions dir', () => team_.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW }));
  fs.chmodSync(path.join(HOSTDIR, 'sessions'), 0o755);
  check('an UNREADABLE session directory is reported as an incomplete row, not as "no sessions"', denied.filter((r) => r.name === INCOMPLETE).length === 1 && denied.find((r) => r.name === INCOMPLETE).accountName === 'main', JSON.stringify(denied.map((r) => [r.name.slice(0, 24), r.detail])));
}

cleanup();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL — unexpected: ' + (e && e.stack)); cleanup(); process.exit(1); });
