// team-store.mjs — offline checks of src/team/store.ts (contract-team-mode-v2 §2, H4, task T3; the
// T11 regression checks are named E11).
//
//   node .orchestrator/fixes/team-store.mjs                every check, against the live src/
//   node .orchestrator/fixes/team-store.mjs --only H4      only checks whose name contains "H4"
//   node .orchestrator/fixes/team-store.mjs --src <dir>    bundle <dir>/team/store.ts instead
//   node .orchestrator/fixes/team-store.mjs --runs <n>     G-H4 race runs (default 20)
//
// It bundles the store (with registry's processStartedAt / isPidAlive and the contract) with
// esbuild into a fresh temp directory, points HOME and USERPROFILE at a throwaway directory BEFORE
// loading the bundle, and gives the store a data root inside that directory. No agent CLI is ever
// started and nothing outside the temp directory is read or written. Each check prints
// `PASS <name>` or `FAIL <name> — <why>`; the exit code is 0 only when every check passed.
import keychainGuard from './keychain-guard.cjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('team-store', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');

const argv = process.argv.slice(2);
function opt(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const SRC = path.resolve(opt('--src', path.join(REPO, 'src')));
const ONLY = opt('--only');
const RUNS = Number(opt('--runs', '20'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-team-store-'));
const HOME = path.join(WORK, 'home');
fs.mkdirSync(HOME, { recursive: true });
const BUNDLE = path.join(WORK, 'store.cjs');

await esbuild.build({
  stdin: {
    contents: [
      `export { createTeamStores } from ${JSON.stringify(path.join(SRC, 'team', 'store.ts'))};`,
      `export { processStartedAt, isPidAlive } from ${JSON.stringify(path.join(SRC, 'registry.ts'))};`,
      `export * as contract from ${JSON.stringify(path.join(SRC, 'team', 'contract.ts'))};`,
    ].join('\n'),
    resolveDir: SRC,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: BUNDLE,
  logLevel: 'warning',
});

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const mod = require(BUNDLE);
const C = mod.contract;
const ROOT = path.join(HOME, '.claude-code-orchestrator');
const TEAMS = path.join(ROOT, 'teams');
const REPO_ROOT = path.join(WORK, 'repo');
fs.mkdirSync(REPO_ROOT, { recursive: true });

// ---- plumbing ------------------------------------------------------------------------------

const tally = { pass: 0, fail: 0, skip: 0 };
function oneLine(err) {
  const text = err && err.message ? String(err.message) : String(err);
  return text.replace(/\s+/g, ' ').slice(0, 900);
}
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) {
    return;
  }
  try {
    const verdict = await fn();
    if (verdict === 'skip') {
      tally.skip++;
      console.log(`SKIP ${name}`);
      return;
    }
    tally.pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    tally.fail++;
    console.log(`FAIL ${name} — ${oneLine(err)}`);
  }
}

const SELF_START = mod.processStartedAt(process.pid);
assert.ok(typeof SELF_START === 'number', 'processStartedAt(process.pid) could not be read — this harness needs ps');
const hostLog = [];
function runtimeOf(host = { pid: process.pid, startedAt: SELF_START }) {
  return {
    dataRoot: ROOT,
    workspace: REPO_ROOT,
    host,
    session: { pid: host.pid, startedAt: host.startedAt },
    socket: path.join(WORK, 'host.sock'),
    nodePath: process.execPath,
    cliJsPath: path.join(ROOT, 'mcp', 'cli.js'),
    log: (line) => hostLog.push(line),
  };
}
/** A fresh TeamStores of this process (a "host"); `host` names another identity when given. */
const storesOf = (host) => mod.createTeamStores(runtimeOf(host));
function fresh() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  hostLog.length = 0;
}
let idClock = Date.now() - 3_600_000;
const newId = () => C.newTeamId((idClock += 1_000));
function initOf(teamId, { name = 'alpha', repoRoot = REPO_ROOT, goal = 'Build the thing.', more = [], files } = {}) {
  return {
    header: { v: 1, id: teamId, name, title: 'Alpha team', workspace: repoRoot, repoRoot, commonDir: path.join(repoRoot, '.git'), createdAt: Date.now() },
    events: [
      {
        by: 'lead',
        body: {
          type: 'team.created',
          name,
          title: 'Alpha team',
          workspace: repoRoot,
          repoRoot,
          commonDir: path.join(repoRoot, '.git'),
          baseCommit: 'a'.repeat(40),
          leadRel: '',
          goal: { bytes: Buffer.byteLength(goal), text: goal },
        },
      },
      ...more,
    ],
    ...(files ? { files } : {}),
  };
}
async function created(opts) {
  const teamId = newId();
  const stores = storesOf();
  const r = await stores.create(initOf(teamId, opts));
  if (!r.ok) assert.fail(`create failed: ${JSON.stringify(r)}`);
  return { teamId, stores, store: r.value, files: C.teamFilesOf(ROOT, teamId) };
}
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const modeOf = (p) => fs.statSync(p).mode & 0o777;
const warn = (text) => ({ by: 'engine', body: { type: 'store.warning', text } });
/** A pid that named a process a moment ago and names none now. */
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(Number.isInteger(done.pid) && done.pid > 1, 'could not make a dead pid');
  return done.pid;
}
/** A live process (killed at the end) and its start time as registry reads it. */
const sleepers = [];
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  sleepers.push(child);
  const startedAt = mod.processStartedAt(child.pid);
  assert.ok(typeof startedAt === 'number', 'could not read a sleeper start time');
  return { pid: child.pid, startedAt };
}
function leaseNaming(identity, extra = {}) {
  return JSON.stringify({ v: 1, hostPid: identity.pid, hostStartedAt: identity.startedAt, session: identity, socket: '/x.sock', acquiredAt: Date.now(), ...extra });
}
/** Simulate the owner host dying: its store is dropped and lease.json names a dead pid. */
function killOwner(files) {
  const dead = deadPid();
  fs.writeFileSync(files.lease, leaseNaming({ pid: dead, startedAt: Date.now() - 60_000 }));
  return dead;
}
function seqsOf(events) {
  return events.map((e) => e.seq);
}
function assertGapFree(events, what) {
  events.forEach((e, i) => assert.equal(e.seq, i + 1, `${what}: seq ${e.seq} at position ${i + 1}`));
}
const jsonClone = (v) => JSON.parse(JSON.stringify(v));

// ---- create --------------------------------------------------------------------------------

await check('create: layout, 0700/0600 modes, first batch [team.created, lease.acquired, …] durable, state.json, no .creating, open() answers the same owned instance', async () => {
  fresh();
  const { teamId, stores, store, files } = await created({ more: [warn('first-batch extra')] });
  assert.equal(modeOf(files.dir), 0o700, 'team dir mode');
  assert.equal(modeOf(TEAMS), 0o700, 'teams dir mode');
  for (const f of [files.header, files.log, files.state, files.lease]) {
    assert.equal(modeOf(f), 0o600, `${path.basename(f)} mode`);
  }
  const lines = readLines(files.log);
  assert.deepEqual(lines.map((e) => e.type), ['team.created', 'lease.acquired', 'store.warning']);
  assertGapFree(lines, 'first batch');
  assert.equal(lines[1].hostPid, process.pid);
  assert.equal(lines[0].v, 1);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 5), ['v', 'seq', 'ts', 'type', 'by'], 'envelope first');
  assert.equal(JSON.parse(fs.readFileSync(files.header, 'utf8')).id, teamId);
  assert.ok(!fs.existsSync(path.join(TEAMS, `${teamId}.creating`)), '.creating left behind');
  const opened = stores.open(teamId);
  assert.ok(opened.ok && opened.value === store, 'open() did not answer the created instance');
  assert.equal(store.owned(), true);
  const st = JSON.parse(fs.readFileSync(files.state, 'utf8'));
  assert.equal(st.seq, 3);
  assert.equal(st.owner.hostPid, process.pid);
  assert.equal(st.goal, 'Build the thing.');
  assert.equal(st.status, 'active');
});

await check('create: exists for an existing id or a leftover .creating, invalid-id, first event not team.created → nothing created', async () => {
  fresh();
  const { teamId, stores } = await created();
  const again = await stores.create(initOf(teamId));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'exists', JSON.stringify(again));
  const id2 = newId();
  fs.mkdirSync(path.join(TEAMS, `${id2}.creating`));
  const r2 = await stores.create(initOf(id2));
  assert.equal(r2.code, 'exists', `a .creating sibling: ${JSON.stringify(r2)}`);
  const bad = await stores.create(initOf('tm../../etc'));
  assert.equal(bad.code, 'invalid-id');
  assert.equal(stores.open('../x').code, 'invalid-id');
  const id3 = newId();
  const init3 = initOf(id3);
  init3.events = [warn('not first')];
  const r3 = await stores.create(init3);
  assert.equal(r3.ok, false);
  assert.ok(!fs.existsSync(path.join(TEAMS, id3)) && !fs.existsSync(path.join(TEAMS, `${id3}.creating`)), 'a directory was left');
});

await check('create: init.files land before the first batch; a bad rel or an over-long first-batch line refuses and leaves no directory', async () => {
  fresh();
  const big = 'g'.repeat(20_000);
  const { files } = await created({ files: [{ rel: 'bodies/goal.md', text: big }] });
  assert.equal(fs.readFileSync(files.goal, 'utf8'), big);
  assert.equal(modeOf(files.goal), 0o600);
  const stores = storesOf();
  const id = newId();
  const r = await stores.create(initOf(id, { files: [{ rel: '../escape.md', text: 'x' }] }));
  assert.equal(r.code, 'io');
  assert.equal(r.errno, 'EINVAL');
  assert.ok(!fs.existsSync(path.join(WORK, 'home', '.claude-code-orchestrator', 'escape.md')));
  const id2 = newId();
  const r2 = await stores.create(initOf(id2, { more: [warn('x'.repeat(C.LOG_LINE_MAX))] }));
  assert.equal(r2.code, 'line-too-long', JSON.stringify(r2));
  assert.equal(r2.index, 1, 'index into init.events');
  assert.deepEqual(fs.readdirSync(TEAMS).filter((n) => n.includes(id) || n.includes(id2)), [], 'a directory was left');
});

// ---- append --------------------------------------------------------------------------------

await check('append: calls in one tick → ONE batch, consecutive seqs in the order the calls were made, onEvents before any resolve, ts filled', async () => {
  fresh();
  const { store, files } = await created();
  const batches = [];
  const resolvedAtCallback = [];
  let resolved = 0;
  store.onEvents((events) => {
    batches.push(seqsOf(events));
    resolvedAtCallback.push(resolved);
  });
  const calls = [store.append([warn('a1'), warn('a2')]), store.append([warn('b1')]), store.append([warn('c1'), warn('c2'), warn('c3')])];
  calls.forEach((p) => p.then(() => resolved++));
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.ok && seqsOf(r.value)), [[3, 4], [5], [6, 7, 8]]);
  assert.deepEqual(batches, [[3, 4, 5, 6, 7, 8]], 'expected exactly one batch');
  assert.deepEqual(resolvedAtCallback, [0], 'a call resolved before the callback ran');
  assert.ok(results.every((r) => r.value.every((e) => typeof e.ts === 'number' && e.v === 1 && e.by === 'engine')));
  const lines = readLines(files.log);
  assertGapFree(lines, 'log');
  assert.deepEqual(lines.slice(2).map((e) => e.text), ['a1', 'a2', 'b1', 'c1', 'c2', 'c3']);
  const later = await store.append([warn('d')]);
  assert.deepEqual(seqsOf(later.value), [9]);
  assert.deepEqual(batches.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(files.state, 'utf8')).seq, 9, 'state.json rewritten after the batch');
});

await check('append: line-too-long fails alone with its index and takes no seq; the other calls of the window land in order', async () => {
  fresh();
  const { store, files } = await created();
  const [a, b, c] = await Promise.all([
    store.append([warn('ok-1')]),
    store.append([warn('fine'), warn('y'.repeat(C.LOG_LINE_MAX))]),
    store.append([warn('ok-2')]),
  ]);
  assert.deepEqual(seqsOf(a.value), [3]);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'line-too-long');
  assert.equal(b.index, 1);
  assert.deepEqual(seqsOf(c.value), [4]);
  const lines = readLines(files.log);
  assertGapFree(lines, 'log');
  assert.ok(!lines.some((e) => e.text === 'fine'), 'part of a failed call landed');
});

await check('append: bodyText → bodies/m<seq>.md (0600, before the log) and bodyFile relative; messageText reads it and checks sha256 (tampered → unreadable)', async () => {
  fresh();
  const { store, files } = await created();
  const text = 'long body '.repeat(3_000);
  const r = await store.append([
    warn('pad'),
    {
      by: 'lead',
      body: { type: 'msg.posted', from: 'lead', to: 'lead', kind: 'text', urgent: false, bytes: Buffer.byteLength(text), sha256: C.bodySha256(text), source: 'cco' },
      bodyText: text,
    },
  ]);
  assert.ok(r.ok, JSON.stringify(r));
  const msg = r.value[1];
  assert.equal(msg.seq, 4);
  assert.equal(msg.bodyFile, 'bodies/m4.md');
  assert.equal(msg.body, undefined);
  const file = path.join(files.dir, 'bodies', 'm4.md');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(modeOf(file), 0o600);
  const read = store.messageText(msg);
  assert.ok(read.ok && read.value === text, 'messageText');
  const inline = store.messageText({ ...msg, body: 'short', bodyFile: undefined });
  assert.equal(inline.value, 'short');
  const reader = storesOf().open(store.teamId).value;
  const [fromReader] = reader.messages({ to: 'lead' });
  assert.equal(reader.messageText(fromReader).value, text, 'a non-owner reads the same body');
  fs.writeFileSync(file, `${text}!`);
  const tampered = reader.messageText(fromReader);
  assert.equal(tampered.code, 'unreadable', JSON.stringify(tampered));
});

await check('append: not-owner from a store that never acquired, after release; release refuses calls made after it', async () => {
  fresh();
  const { teamId, store } = await created();
  const other = storesOf(sleeper()).open(teamId).value;
  const r = await other.append([warn('x')]);
  assert.equal(r.code, 'not-owner');
  assert.equal(other.writeFile('members/a/brief.md', 'x').code, 'not-owner');
  assert.equal(other.state(), undefined);
  const releasing = store.release('test');
  const after = await store.append([warn('after release')]);
  assert.equal(after.code, 'not-owner');
  assert.ok((await releasing).ok);
  assert.equal(store.owned(), false);
  assert.equal((await store.append([warn('y')])).code, 'not-owner');
});

// ---- projection ----------------------------------------------------------------------------

const TASK = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  state: 'open',
  paths: ['src/'],
  allowOverlap: false,
  createdBy: 'lead',
  createdAt: 1,
  reports: [],
  commits: [],
  turns: [],
  updatedAt: 1,
  updatedBy: 'lead',
  ...extra,
});
const msg = (seqHint, from, to, extra = {}) => ({
  by: from === 'lead' || from === 'user' || from === 'engine' ? from : `member:${from}`,
  body: { type: 'msg.posted', from, to, kind: 'text', urgent: false, body: `m from ${from} ${seqHint}`, bytes: 10, sha256: C.bodySha256(`m from ${from} ${seqHint}`), source: 'cco', ...extra },
});
/** A team history that exercises every reducer branch; appended in several batches. */
async function richHistory(store) {
  const B = async (items) => {
    const r = await store.append(items);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  await B([
    { by: 'lead', body: { type: 'member.added', name: 'api', index: 1, role: 'backend', briefBytes: 10, spec: { provider: 'claude', paths: [] } } },
    { by: 'lead', body: { type: 'member.added', name: 'web', index: 2, role: 'frontend', briefBytes: 10, spec: { paths: [] } } },
    { by: 'engine', body: { type: 'member.routed', name: 'api', incarnation: 1, provider: 'claude', worker: 'wa', accountKey: '/x/.claude-wa', model: 'opus', modelSource: 'dispatch', reason: 'r', cause: 'initial' } },
    { by: 'engine', body: { type: 'member.routed', name: 'web', incarnation: 1, provider: 'cursor', worker: 'cur', accountKey: 'cursor:ambient', model: '', modelSource: 'cli', reason: 'r', cause: 'initial' } },
    { by: 'engine', body: { type: 'member.worktree.planned', name: 'api', path: '/wt/api', branch: 'cco/x/api', baseCommit: 'b'.repeat(40) } },
    { by: 'engine', body: { type: 'member.worktree', name: 'api', path: '/wt/api', branch: 'cco/x/api', baseCommit: 'b'.repeat(40), cwd: '/wt/api' } },
    { by: 'engine', body: { type: 'member.state', name: 'api', state: 'idle' } },
    { by: 'engine', body: { type: 'member.state', name: 'web', state: 'idle' } },
    { by: 'lead', body: { type: 'board.created', task: TASK('b1') } },
    { by: 'lead', body: { type: 'board.created', task: TASK('b2') } },
  ]);
  const posted = await B([msg(1, 'lead', 'api', { task: 'b1' }), msg(2, 'lead', 'all', { recipients: ['api', 'web'] }), msg(3, 'api', 'lead'), msg(4, 'web', 'user'), msg(5, 'engine', 'lead', { kind: 'notice' })]);
  const [toApi, toAll] = posted;
  await B([
    { by: 'member:api', body: { type: 'board.updated', id: 'b1', changes: { state: 'claimed', assignee: 'api' } } },
    { by: 'engine', body: { type: 'turn.planned', turnId: 'tturn0001', name: 'api', n: 1, incarnation: 1, trigger: 'message', deliver: [toApi.seq, toAll.seq], resent: [], promptBytes: 100 } },
    { by: 'engine', body: { type: 'member.state', name: 'api', state: 'running' } },
    { by: 'engine', body: { type: 'turn.running', turnId: 'tturn0001', pid: 4242, pgid: 4242, startedAt: 12345 } },
    { by: 'engine', body: { type: 'member.conversation', name: 'api', incarnation: 1, conversationId: '0123456789abcdef' } },
  ]);
  const mid = store.state();
  if (mid) {
    assert.equal(mid.budgets.running, 1, 'a planned turn runs');
    assert.equal(mid.members[0].turn.pid, 4242);
  }
  await B([
    { by: 'engine', body: { type: 'turn.ended', turnId: 'tturn0001', outcome: 'ok', exitCode: 0, signal: null, durationMs: 1000, tokens: { in: 1500, out: 300 }, costUsd: 0.25, text: 'Done.\nAll good.', textFile: 'tasks/tturn0001.md', sawAssistant: true, modelUsed: 'opus-x' } },
    { by: 'engine', body: { type: 'msg.delivered', msg: C.messageIdOf(toApi.seq), to: 'api', via: 'turn', turnId: 'tturn0001' } },
    { by: 'engine', body: { type: 'msg.delivered', msg: C.messageIdOf(toAll.seq), to: 'api', via: 'turn', turnId: 'tturn0001' } },
    { by: 'engine', body: { type: 'msg.delivered', msg: C.messageIdOf(toAll.seq), to: 'api', via: 'turn', turnId: 'tturn0001' } },
    { by: 'engine', body: { type: 'turn.checkpoint', turnId: 'tturn0001', name: 'api', sha: 'c'.repeat(40), filesChanged: 3, touched: ['src/a'], outsideOwnership: [], skipped: [] } },
    { by: 'engine', body: { type: 'member.state', name: 'api', state: 'idle' } },
    { by: 'lead', body: { type: 'msg.read', upToSeq: posted[2].seq } },
    { by: 'member:api', body: { type: 'board.updated', id: 'b1', changes: { state: 'review' }, note: 'ready', reportFile: 'bodies/b1-r1.md' } },
    { by: 'lead', body: { type: 'board.updated', id: 'b2', changes: { state: 'cancelled' } } },
    { by: 'engine', body: { type: 'budget.tripped', kind: 'pingpong' } },
    { by: 'engine', body: { type: 'overlap.detected', members: ['api', 'web'], paths: ['src/x.ts'] } },
    { by: 'engine', body: { type: 'member.mailbox', name: 'web', mailbox: 'turns-only', reason: 'cursor approvals' } },
    { by: 'engine', body: { type: 'member.state', name: 'web', state: 'blocked', reason: { code: 'quota', text: 'out of quota', until: 99 } } },
    { by: 'engine', body: { type: 'some.future.type', anything: true } },
    { by: 'engine', body: { type: 'member.state', name: 'nobody', state: 'idle' } },
  ]);
}

await check('projection: state() = a fresh reader\'s projectLog() (replay of the log) = state.json, and the reducer\'s readings hold', async () => {
  fresh();
  const { teamId, store, files } = await created();
  await richHistory(store);
  const owner = store.state();
  const replay = storesOf().open(teamId).value.projectLog();
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.deepEqual(jsonClone(owner), jsonClone(replay.value), 'owner projection differs from the replay');
  assert.deepEqual(JSON.parse(fs.readFileSync(files.state, 'utf8')), jsonClone(owner), 'state.json differs');
  const s = owner;
  const api = s.members.find((m) => m.name === 'api');
  const web = s.members.find((m) => m.name === 'web');
  assert.deepEqual(s.members.map((m) => m.name), ['api', 'web']);
  assert.equal(api.state, 'idle');
  assert.equal(api.turn, undefined, 'turn cleared');
  assert.equal(api.turns, 1);
  assert.deepEqual(api.tokens, { in: 1500, out: 300 });
  assert.equal(api.costUsd, 0.25);
  assert.equal(api.modelUsed, 'opus-x');
  assert.equal(api.lastTurn.head, 'Done. All good.');
  assert.equal(api.conversationShort, '01234567');
  assert.equal(api.pending, 0, 'api pending (delivered twice counts once)');
  assert.deepEqual(api.tasks, ['b1']);
  assert.equal(api.worktree.ready, true);
  assert.equal(api.worktree.headSha, 'c'.repeat(40));
  assert.equal(api.portBase, C.memberPortBase(1));
  assert.equal(web.pending, 1, 'web still owes the `all` message');
  assert.equal(web.accountLabel, 'Cursor (machine login)');
  assert.equal(web.machineLogin, true);
  assert.equal(web.mailbox, 'turns-only');
  assert.equal(web.state, 'blocked');
  assert.equal(web.reason.until, 99);
  assert.equal(s.lead.unread, 1, 'lead unread (one notice after the read mark)');
  assert.equal(s.user.unread, 1);
  assert.equal(s.budgets.running, 0);
  assert.equal(s.budgets.pingPongTripped, true);
  assert.deepEqual(s.totals, { turns: 1, inputTokens: 1500, outputTokens: 300, costUsd: 0.25 });
  const b1 = s.board.find((t) => t.id === 'b1');
  const b2 = s.board.find((t) => t.id === 'b2');
  assert.equal(b1.state, 'review');
  assert.equal(b1.assignee, 'api');
  assert.deepEqual(b1.commits, ['c'.repeat(40)]);
  assert.deepEqual(b1.turns, ['tturn0001']);
  assert.equal(b1.reports.length, 1);
  assert.equal(b1.updatedBy, 'api');
  assert.equal(b2.state, 'cancelled');
  assert.equal(b2.assignee, undefined);
  const kinds = s.warnings.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ['blocked', 'budget', 'mailbox', 'overlap'], JSON.stringify(s.warnings));
  assert.equal(s.owner.hostPid, process.pid);
  assert.ok(!JSON.stringify(s).includes('.claude-wa'), 'the private accountKey reached the projection');
  assert.ok(hostLog.some((l) => l.includes('skipped')), 'the malformed event was not logged');
  // the overlay-free projection and the owner-side projectLog agree too
  assert.deepEqual(jsonClone(store.projectLog().value), jsonClone(owner));
});

await check('projection: the overlay is applied by state() and state.json; a throwing overlay is caught, logged, and the projection used', async () => {
  fresh();
  const { store, files } = await created();
  store.setOverlay((s) => ({ ...s, lead: { ...s.lead, waiter: true, wakesToday: 7 } }));
  assert.equal(store.state().lead.waiter, true);
  assert.equal(store.projectLog().value.lead.waiter, false, 'projectLog has no overlay');
  assert.ok(store.writeState().ok);
  assert.equal(JSON.parse(fs.readFileSync(files.state, 'utf8')).lead.wakesToday, 7);
  store.setOverlay((s) => {
    s.name = 'mutated';
    throw new Error('overlay boom');
  });
  const s = store.state();
  assert.equal(s.name, 'alpha', 'a throwing overlay\'s mutation leaked');
  assert.ok(hostLog.some((l) => l.includes('overlay boom')));
  assert.ok((await store.append([warn('still works')])).ok);
});

await check('projection: release puts owner null in state.json, a new lease.acquired sets it again', async () => {
  fresh();
  const { teamId, store, files } = await created();
  assert.ok((await store.release('suspend')).ok);
  assert.equal(JSON.parse(fs.readFileSync(files.state, 'utf8')).owner, null);
  assert.ok(!fs.existsSync(files.lease), 'lease.json kept after release');
  const lines = readLines(files.log);
  assert.equal(lines.at(-1).type, 'lease.released');
  assert.equal(lines.at(-1).reason, 'suspend');
  assert.ok((await store.release('again')).ok, 'a second release is ok');
  const again = await store.acquire();
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.value.tookOver, undefined);
  const after = readLines(files.log);
  assertGapFree(after, 'log');
  assert.equal(after.at(-1).type, 'lease.acquired');
  assert.equal(store.state().owner.hostPid, process.pid);
  assert.equal(storesOf().open(teamId).value.projectLog().value.owner.hostPid, process.pid);
});

// ---- the damaged rules (§2.3, I10, H4) -------------------------------------------------------

await check('torn last line: a reader ignores it (tornBytes) and never writes; the owner\'s acquire truncates it and appends log.repaired {droppedBytes} then lease.acquired {tookOver}', async () => {
  fresh();
  const { teamId, store, files } = await created();
  await store.append([warn('one'), warn('two')]);
  const torn = '{"v":1,"seq":5,"ts":1,"type":"store.war';
  fs.appendFileSync(files.log, torn);
  const dead = killOwner(files);
  const before = fs.readFileSync(files.log);
  const reader = storesOf().open(teamId).value;
  const log = reader.readLog();
  assert.ok(log.ok, JSON.stringify(log));
  assert.equal(log.value.tornBytes, Buffer.byteLength(torn));
  assert.deepEqual(seqsOf(log.value.events), [1, 2, 3, 4]);
  assert.ok(fs.readFileSync(files.log).equals(before), 'a reader wrote the log');
  const host2 = storesOf();
  const r = await host2.open(teamId).value.acquire();
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.repairedBytes, Buffer.byteLength(torn));
  assert.deepEqual(r.value.tookOver, { oldHostPid: dead });
  const lines = readLines(files.log);
  assertGapFree(lines, 'repaired log');
  assert.deepEqual(lines.slice(4).map((e) => e.type), ['log.repaired', 'lease.acquired']);
  assert.equal(lines[4].droppedBytes, Buffer.byteLength(torn));
  assert.deepEqual(lines[5].tookOver, { oldHostPid: dead });
  assert.ok(fs.readFileSync(files.log, 'utf8').endsWith('\n'));
  assert.ok(fs.existsSync(files.staleLease(dead)), 'the stale lease was not kept');
});

await check('unterminated but valid last line: kept as the next event and given its \\n — no log.repaired, repairedBytes 0', async () => {
  fresh();
  const { teamId, files } = await created();
  const line = JSON.stringify({ v: 1, seq: 3, ts: 1, type: 'store.warning', by: 'engine', text: 'no newline' });
  fs.appendFileSync(files.log, line);
  killOwner(files);
  const reader = storesOf().open(teamId).value.readLog();
  assert.deepEqual(seqsOf(reader.value.events), [1, 2, 3]);
  assert.equal(reader.value.tornBytes, 0);
  const r = await storesOf().open(teamId).value.acquire();
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.repairedBytes, 0);
  const lines = readLines(files.log);
  assertGapFree(lines, 'log');
  assert.deepEqual(lines.map((e) => e.type), ['team.created', 'lease.acquired', 'store.warning', 'lease.acquired']);
});

/** Rewrite the log's lines through `edit(lines)` (raw strings), as a foreign hand would. */
function rewriteLog(files, edit) {
  const lines = fs.readFileSync(files.log, 'utf8').split('\n').filter((l) => l !== '');
  fs.writeFileSync(files.log, `${edit(lines).join('\n')}\n`);
}
async function damagedCase(name, edit, reasonPattern) {
  await check(`damaged: ${name} → readLog damaged naming it, projectLog status damaged, acquire refuses and leaves no lease, the log is never written`, async () => {
    fresh();
    const { teamId, store, files } = await created();
    await store.append([warn('a'), warn('b'), warn('c')]);
    await store.release('test');
    rewriteLog(files, edit);
    const bytes = fs.readFileSync(files.log);
    const reader = storesOf().open(teamId).value;
    const log = reader.readLog();
    assert.equal(log.code, 'damaged', JSON.stringify(log));
    assert.match(log.reason, reasonPattern);
    const projected = reader.projectLog();
    assert.ok(projected.ok);
    assert.equal(projected.value.status, 'damaged');
    assert.match(projected.value.damagedReason, reasonPattern);
    assert.equal(projected.value.name, 'alpha', 'the damaged state is built from the header');
    assert.equal(reader.messages({}).length, 0);
    assert.equal(reader.eventsFrom(0, 10), 'resnapshot_required');
    const r = await storesOf().open(teamId).value.acquire();
    assert.equal(r.code, 'damaged', JSON.stringify(r));
    assert.ok(!fs.existsSync(files.lease), 'the lease this acquire created was left behind');
    assert.ok(fs.readFileSync(files.log).equals(bytes), 'a damaged log was written');
    const listed = storesOf().list().find((l) => l.teamId === teamId);
    assert.ok(listed, 'a damaged team must be listed');
  });
}
await damagedCase('an unparseable middle line', (l) => [l[0], l[1], '{not json', ...l.slice(2)], /line 3/);
await damagedCase('a seq gap', (l) => l.filter((_, i) => i !== 3), /line 4 .*gap/);
await damagedCase('a duplicate seq', (l) => [...l.slice(0, 4), l[3], ...l.slice(4)], /line 5 .*duplicate/);
await damagedCase('seq 1 not team.created', (l) => [l[1].replace('"seq":2', '"seq":1'), ...l.slice(2).map((x, i) => x.replace(/"seq":\d+/, `"seq":${i + 2}`))], /seq 1 but not team\.created/);
await damagedCase('an event without v:1', (l) => [l[0], l[1].replace('"v":1', '"v":2'), ...l.slice(2)], /line 2 is not a log event/);
await damagedCase('a blank middle line', (l) => [l[0], '', ...l.slice(1)], /line 2/);

await check('damaged: an empty log, a missing log, an unreadable team.json or one naming another id → damaged; a directory that does not exist → absent', async () => {
  fresh();
  for (const breakIt of [
    (f) => fs.writeFileSync(f.log, ''),
    (f) => fs.rmSync(f.log),
    (f) => fs.writeFileSync(f.header, '{oops'),
    (f) => fs.writeFileSync(f.header, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.header, 'utf8')), id: 'tmzzzzzzzzzzzzz' })),
  ]) {
    const { teamId, store, files } = await created();
    await store.release('test');
    breakIt(files);
    const reader = storesOf().open(teamId).value;
    assert.equal(reader.readLog().code, 'damaged');
    assert.equal(reader.projectLog().value.status, 'damaged');
    assert.equal((await storesOf().open(teamId).value.acquire()).code, 'damaged');
  }
  const ghost = storesOf().open(newId()).value;
  assert.equal(ghost.readLog().code, 'absent');
  assert.equal(ghost.projectLog().code, 'absent');
  assert.equal((await ghost.acquire()).code, 'absent');
  assert.deepEqual(ghost.messages({}), []);
});

// ---- the lead seat (§2.1, H4) ---------------------------------------------------------------

await check('lease: a LIVE holder → busy with holder, nothing appended, lease untouched', async () => {
  fresh();
  const { teamId, files } = await created();
  const live = sleeper();
  fs.writeFileSync(files.lease, leaseNaming(live));
  const leaseBefore = fs.readFileSync(files.lease, 'utf8');
  const logBefore = fs.readFileSync(files.log);
  const r = await storesOf().open(teamId).value.acquire();
  assert.equal(r.code, 'busy', JSON.stringify(r));
  assert.equal(r.holder.hostPid, live.pid);
  assert.equal(fs.readFileSync(files.lease, 'utf8'), leaseBefore);
  assert.ok(fs.readFileSync(files.log).equals(logBefore));
});

await check('lease: a live pid whose start time is not the recorded one (pid reuse) is stale → taken over, the old lease kept as lease.json.<pid>.stale', async () => {
  fresh();
  const { teamId, files } = await created();
  const live = sleeper();
  fs.writeFileSync(files.lease, leaseNaming({ pid: live.pid, startedAt: live.startedAt - 3_600_000 }));
  const r = await storesOf().open(teamId).value.acquire();
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.tookOver, { oldHostPid: live.pid });
  assert.ok(fs.existsSync(files.staleLease(live.pid)));
  assert.equal(JSON.parse(fs.readFileSync(files.lease, 'utf8')).hostPid, process.pid);
  assert.ok(!fs.existsSync(files.leaseLock), 'lease.lock left behind');
});

await check('lease.lock: held by a live process → contended (lease untouched); a dead holder\'s lock → removed and the takeover proceeds; unparseable fresh → contended; unparseable old → removed', async () => {
  fresh();
  const { teamId, files } = await created();
  const dead = killOwner(files);
  const leaseBefore = fs.readFileSync(files.lease, 'utf8');
  const live = sleeper();
  fs.writeFileSync(files.leaseLock, JSON.stringify({ pid: live.pid, startedAt: live.startedAt }));
  let r = await storesOf().open(teamId).value.acquire();
  assert.equal(r.code, 'contended', JSON.stringify(r));
  assert.equal(fs.readFileSync(files.lease, 'utf8'), leaseBefore);
  assert.ok(fs.existsSync(files.leaseLock), 'a live lock was removed');
  fs.writeFileSync(files.leaseLock, 'garbage');
  r = await storesOf().open(teamId).value.acquire();
  assert.equal(r.code, 'contended', `fresh unparseable lock: ${JSON.stringify(r)}`);
  const old = (Date.now() - 2 * C.START_LOCK_STALE_MS) / 1000;
  fs.utimesSync(files.leaseLock, old, old);
  r = await storesOf().open(teamId).value.acquire();
  assert.ok(r.ok, `old unparseable lock: ${JSON.stringify(r)}`);
  assert.deepEqual(r.value.tookOver, { oldHostPid: dead });
  assert.ok(!fs.existsSync(files.leaseLock));
  // and a dead holder's lock
  const t2 = await created();
  killOwner(t2.files);
  fs.writeFileSync(t2.files.leaseLock, JSON.stringify({ pid: deadPid(), startedAt: Date.now() }));
  r = await storesOf().open(t2.teamId).value.acquire();
  assert.ok(r.ok, `dead lock holder: ${JSON.stringify(r)}`);
  assert.ok(!fs.existsSync(t2.files.leaseLock));
  assertGapFree(readLines(t2.files.log), 'log');
});

await check('lease: an unparseable lease.json — fresh → contended, older than START_LOCK_STALE_MS → stale, taken with oldHostPid 0', async () => {
  fresh();
  const { teamId, files } = await created();
  fs.writeFileSync(files.lease, '{"v":1,"hostPid":');
  let r = await storesOf().open(teamId).value.acquire();
  assert.equal(r.code, 'contended', JSON.stringify(r));
  const old = (Date.now() - 2 * C.START_LOCK_STALE_MS) / 1000;
  fs.utimesSync(files.lease, old, old);
  r = await storesOf().open(teamId).value.acquire();
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.tookOver, { oldHostPid: 0 });
  assert.ok(fs.existsSync(files.staleLease(0)));
});

await check('fence: lease.json rewritten to name another host → append lease-lost (holder named), nothing written, FOR GOOD (append, writeFile, appendFeed, writeState, acquire); host log says so', async () => {
  fresh();
  const { store, files } = await created();
  assert.ok((await store.append([warn('before')])).ok);
  const other = sleeper();
  fs.writeFileSync(files.lease, leaseNaming(other));
  const bytes = fs.readFileSync(files.log);
  const r = await store.append([warn('after takeover')]);
  assert.equal(r.code, 'lease-lost', JSON.stringify(r));
  assert.equal(r.holder.hostPid, other.pid);
  assert.ok(fs.readFileSync(files.log).equals(bytes), 'a lost store wrote the log');
  assert.equal(store.owned(), false);
  assert.equal(store.state(), undefined);
  // lost is terminal, even if lease.json named this host again
  fs.writeFileSync(files.lease, leaseNaming({ pid: process.pid, startedAt: SELF_START }));
  assert.equal((await store.append([warn('x')])).code, 'lease-lost');
  assert.equal(store.writeFile('members/api/credential', 'f'.repeat(64)).code, 'lease-lost');
  assert.equal(store.appendFeed('api', [{ ts: 1, turn: 't1', k: 'text', s: 'x' }]).code, 'lease-lost');
  assert.equal(store.writeState().code, 'lease-lost');
  assert.equal((await store.acquire()).code, 'lease-lost');
  assert.ok(!fs.existsSync(path.join(files.dir, 'members', 'api', 'credential')));
  assert.ok(fs.readFileSync(files.log).equals(bytes));
  assert.ok(hostLog.some((l) => l.includes('lease lost')), 'no host log line');
});

await check('fence: lease.json deleted under the owner → lease-lost; queued calls of the same window all fail', async () => {
  fresh();
  const { store, files } = await created();
  fs.rmSync(files.lease);
  const rs = await Promise.all([store.append([warn('a')]), store.append([warn('b')])]);
  assert.deepEqual(rs.map((r) => r.code), ['lease-lost', 'lease-lost']);
  assert.equal(readLines(files.log).length, 2);
});

/**
 * G-H4 (§11.3): two host processes started 0–5 ms apart race to take one stale lease. Each
 * child loads the bundle, reads its own start time BEFORE the barrier, spins to the agreed instant,
 * acquires, and — when it won — appends one event; the loser tries to append too. Both stay alive
 * 1.5 s so neither looks dead to the other's liveness check.
 */
const RACE_CHILD = `
const m = require(${JSON.stringify(BUNDLE)});
const [dataRoot, teamId, startAt, offset] = process.argv.slice(2);
const startedAt = m.processStartedAt(process.pid);
const runtime = { dataRoot, workspace: '/', host: { pid: process.pid, startedAt }, session: { pid: process.pid, startedAt },
  socket: '/x.sock', nodePath: process.execPath, cliJsPath: '/x', log: () => {} };
const store = m.createTeamStores(runtime).open(teamId).value;
(async () => {
  while (Date.now() < Number(startAt) + Number(offset)) {}
  const acquire = await store.acquire();
  const appended = await store.append([{ by: 'engine', body: { type: 'store.warning', text: 'winner ' + process.pid } }]);
  process.stdout.write(JSON.stringify({ pid: process.pid, acquire, appended: appended.ok ? appended.value.map((e) => e.seq) : appended.code }) + '\\n');
  setTimeout(() => process.exit(0), 1500);
})();
`;
const RACE_FILE = path.join(WORK, 'race-child.cjs');
fs.writeFileSync(RACE_FILE, RACE_CHILD);
function runRaceChild(teamId, startAt, offset) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RACE_FILE, ROOT, teamId, String(startAt), String(offset)], {
      env: { ...process.env, HOME, USERPROFILE: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, ...JSON.parse(out.trim().split('\n').at(-1)) });
      } catch {
        resolve({ code, error: `no answer: ${out} ${err}`.slice(0, 400) });
      }
    });
  });
}

await check(`G-H4: ${RUNS} runs of two host processes started 0–5 ms apart against one stale lease → exactly one owner, a gap-free log, the loser refused (contended or busy) and its append not-owner`, async () => {
  fresh();
  const loserCodes = {};
  for (let run = 0; run < RUNS; run++) {
    const { teamId, files, store } = await created();
    await store.append([warn(`run ${run}`)]);
    const dead = killOwner(files);
    const startAt = Date.now() + 600;
    const offset = run % 6;
    const results = await Promise.all([runRaceChild(teamId, startAt, 0), runRaceChild(teamId, startAt, offset)]);
    const bad = results.find((r) => r.error);
    assert.ok(!bad, `run ${run}: ${bad?.error}`);
    const winners = results.filter((r) => r.acquire.ok);
    assert.equal(winners.length, 1, `run ${run}: ${winners.length} owners — ${JSON.stringify(results)}`);
    const [winner] = winners;
    const loser = results.find((r) => !r.acquire.ok);
    assert.ok(['contended', 'busy'].includes(loser.acquire.code), `run ${run}: the loser answered ${JSON.stringify(loser.acquire)}`);
    loserCodes[loser.acquire.code] = (loserCodes[loser.acquire.code] ?? 0) + 1;
    assert.equal(loser.appended, 'not-owner', `run ${run}: the loser's append answered ${loser.appended}`);
    assert.deepEqual(winner.acquire.value.tookOver, { oldHostPid: dead });
    const log = storesOf().open(teamId).value.readLog();
    assert.ok(log.ok, `run ${run}: ${JSON.stringify(log)}`);
    assertGapFree(log.value.events, `run ${run}`);
    const acquired = log.value.events.filter((e) => e.type === 'lease.acquired');
    assert.equal(acquired.length, 2, `run ${run}: ${acquired.length} lease.acquired`);
    assert.equal(acquired[1].hostPid, winner.pid);
    assert.deepEqual(winner.appended, [log.value.events.length]);
    assert.equal(log.value.events.at(-1).text, `winner ${winner.pid}`);
    assert.equal(JSON.parse(fs.readFileSync(files.lease, 'utf8')).hostPid, winner.pid);
    assert.ok(!fs.existsSync(files.leaseLock), `run ${run}: lease.lock left behind`);
  }
  console.log(`     G-H4 losers: ${JSON.stringify(loserCodes)}`);
});

// ---- limits ---------------------------------------------------------------------------------

await check('log-full: past the soft limit (TEAM_LOG_MAX − 16 × LOG_LINE_MAX) a plain append is log-full, `reserve` uses the room up to TEAM_LOG_MAX and never past it', async () => {
  fresh();
  const { teamId, files } = await created();
  const soft = C.TEAM_LOG_MAX - 16 * C.LOG_LINE_MAX;
  const fd = fs.openSync(files.log, 'a');
  let size = fs.fstatSync(fd).size;
  let seq = readLines(files.log).length;
  const text = 'f'.repeat(60_000);
  while (size < soft + 200 * 1024) {
    const line = `${JSON.stringify({ v: 1, seq: ++seq, ts: 1, type: 'store.warning', by: 'engine', text })}\n`;
    fs.writeSync(fd, line);
    size += Buffer.byteLength(line);
  }
  fs.closeSync(fd);
  killOwner(files);
  const store = storesOf().open(teamId).value;
  const acquired = await store.acquire();
  assert.ok(acquired.ok, `acquire with reserve near the limit: ${JSON.stringify(acquired)}`);
  const plain = await store.append([warn('small')]);
  assert.equal(plain.code, 'log-full', JSON.stringify(plain));
  assert.ok((await store.append([warn('small reserve')], { reserve: true })).ok);
  let full;
  for (let i = 0; i < 40; i++) {
    const r = await store.append([warn(text)], { reserve: true });
    if (!r.ok) {
      full = r;
      break;
    }
  }
  assert.equal(full?.code, 'log-full', 'reserve never hit the hard limit');
  assert.ok(fs.statSync(files.log).size <= C.TEAM_LOG_MAX, 'the log passed TEAM_LOG_MAX');
  const log = storesOf().open(teamId).value.readLog();
  assert.ok(log.ok, 'a full log must still read');
  assertGapFree(log.value.events, 'full log');
});

await check('writeState: over STATE_MAX → too-large, the previous state.json stays', async () => {
  fresh();
  const { store, files } = await created();
  const before = fs.readFileSync(files.state, 'utf8');
  store.setOverlay((s) => ({ ...s, warnings: [{ kind: 'store', text: 'w'.repeat(C.STATE_MAX) }] }));
  const r = store.writeState();
  assert.equal(r.code, 'too-large', JSON.stringify(r));
  assert.equal(fs.readFileSync(files.state, 'utf8'), before);
});

// ---- readers ----------------------------------------------------------------------------------

await check('eventsFrom: events after fromSeq (≤ max), from memory and from disk alike; a bad, negative or future fromSeq → resnapshot_required', async () => {
  fresh();
  const { teamId, store } = await created();
  await store.append([warn('a'), warn('b'), warn('c')]);
  const reader = storesOf().open(teamId).value;
  for (const s of [store, reader]) {
    assert.deepEqual(seqsOf(s.eventsFrom(0, 100)), [1, 2, 3, 4, 5]);
    assert.deepEqual(seqsOf(s.eventsFrom(3, 100)), [4, 5]);
    assert.deepEqual(seqsOf(s.eventsFrom(1, 2)), [2, 3]);
    assert.deepEqual(s.eventsFrom(5, 10), []);
    assert.equal(s.eventsFrom(6, 10), 'resnapshot_required');
    assert.equal(s.eventsFrom(-1, 10), 'resnapshot_required');
    assert.equal(s.eventsFrom(1.5, 10), 'resnapshot_required');
    assert.equal(s.eventsFrom('0', 10), 'resnapshot_required');
  }
});

await check('messages: to (direct and a `to: all` recipient), from, afterSeq, max = the newest in seq order; from memory and from disk alike', async () => {
  fresh();
  const { teamId, store } = await created();
  await store.append([
    { by: 'lead', body: { type: 'member.added', name: 'api', index: 1, role: 'r', briefBytes: 1, spec: { paths: [] } } },
    { by: 'lead', body: { type: 'member.added', name: 'web', index: 2, role: 'r', briefBytes: 1, spec: { paths: [] } } },
    msg(1, 'lead', 'api'),
    msg(2, 'lead', 'all', { recipients: ['api', 'web'] }),
    msg(3, 'web', 'lead'),
    msg(4, 'lead', 'web'),
    msg(5, 'lead', 'api'),
  ]);
  const reader = storesOf().open(teamId).value;
  for (const s of [store, reader]) {
    assert.deepEqual(seqsOf(s.messages({ to: 'api' })), [5, 6, 9]);
    assert.deepEqual(seqsOf(s.messages({ to: 'web' })), [6, 8]);
    assert.deepEqual(seqsOf(s.messages({ from: 'web' })), [7]);
    assert.deepEqual(seqsOf(s.messages({ to: 'api', afterSeq: 5 })), [6, 9]);
    assert.deepEqual(seqsOf(s.messages({ to: 'api', max: 2 })), [6, 9]);
    assert.deepEqual(seqsOf(s.messages({})), [5, 6, 7, 8, 9]);
  }
});

await check('writeFile / readFile: atomic 0600 under 0700 dirs; a bad rel (.., absolute, empty segment, backslash, the store\'s own files) → io EINVAL without a write; a symlinked directory is refused', async () => {
  fresh();
  const { store, files } = await created();
  const w = store.writeFile('members/api/credential', 'a'.repeat(64));
  assert.ok(w.ok, JSON.stringify(w));
  assert.equal(w.value, path.join(files.dir, 'members', 'api', 'credential'));
  assert.equal(modeOf(w.value), 0o600);
  assert.equal(modeOf(path.join(files.dir, 'members', 'api')), 0o700);
  assert.equal(store.readFile('members/api/credential', 100).value, 'a'.repeat(64));
  assert.equal(store.readFile('members/api/credential', 10).code, 'unreadable', 'over the cap');
  assert.equal(store.readFile('members/api/nothing', 10).code, 'absent');
  for (const rel of ['../x', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', '', 'events.jsonl', 'state.json', 'lease.json', 'team.json', 'lease.lock']) {
    const r = store.writeFile(rel, 'x');
    assert.equal(r.code, 'io', `${rel}: ${JSON.stringify(r)}`);
    assert.equal(r.errno, 'EINVAL', rel);
  }
  assert.equal(readLines(files.log).length, 2, 'the log was touched');
  const outside = path.join(WORK, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(files.dir, 'members', 'evil'));
  const r = store.writeFile('members/evil/brief.md', 'x');
  assert.equal(r.code, 'io');
  assert.equal(r.errno, 'ELOOP');
  assert.deepEqual(fs.readdirSync(outside), [], 'wrote through a symlink');
  fs.writeFileSync(path.join(outside, 'brief.md'), 'secret');
  assert.notEqual(store.readFile('members/evil/brief.md', 100).ok, true, 'read through a symlinked directory');
});

await check('feed: appendFeed enforces the caps; past FEED_ROTATE it rotates to feed.jsonl.1; feedTail reads across both files oldest first and skips bad lines', async () => {
  fresh();
  const { teamId, store, files } = await created();
  const r = store.appendFeed('api', [{ ts: 1, turn: 't1', k: 'text', s: 'é'.repeat(5_000), tool: 'T'.repeat(100), d: 'line one\nline two '.repeat(30) }, { ts: 2, turn: 't1', k: 'bogus' }]);
  assert.ok(r.ok, JSON.stringify(r));
  const feed = path.join(files.dir, 'members', 'api', 'feed.jsonl');
  assert.equal(modeOf(feed), 0o600);
  const [item, ...rest] = readLines(feed);
  assert.equal(rest.length, 0, 'an item of an unknown kind was written');
  assert.ok(Buffer.byteLength(item.s) <= C.FEED_TEXT_MAX_BYTES);
  assert.ok(!item.s.includes('�'), 'a code point was cut in half');
  assert.ok(item.tool.length <= C.FEED_TOOL_MAX_CHARS);
  assert.ok(item.d.length <= C.FEED_DETAIL_MAX_CHARS && !item.d.includes('\n'));
  let ts = 10;
  const chunk = 's'.repeat(2_000);
  while (!fs.existsSync(`${feed}.1`)) {
    const items = Array.from({ length: 100 }, () => ({ ts: ts++, turn: 't2', k: 'text', s: chunk }));
    assert.ok(store.appendFeed('api', items).ok);
    assert.ok(ts < 10_000, 'never rotated');
  }
  assert.ok(fs.statSync(`${feed}.1`).size <= C.FEED_ROTATE);
  fs.appendFileSync(feed, 'not json\n');
  const reader = storesOf().open(teamId).value;
  const tail = reader.feedTail('api', 150);
  assert.equal(tail.length, 150);
  const tss = tail.map((i) => i.ts);
  assert.deepEqual(tss, [...tss].sort((a, b) => a - b), 'not oldest first');
  assert.equal(tss.at(-1), ts - 1);
  assert.deepEqual(reader.feedTail('nobody', 5), []);
  assert.deepEqual(reader.feedTail('../x', 5), []);
});

// ---- list and retention ---------------------------------------------------------------------

await check('list: TEAM_ID directories only, newest first; a damaged team is listed (state from the header); .creating never; lease included when readable', async () => {
  fresh();
  const a = await created({ name: 'aa' });
  const b = await created({ name: 'bb' });
  const c = await created({ name: 'cc' });
  await c.store.release('x');
  fs.rmSync(c.files.state);
  fs.writeFileSync(c.files.log, '{garbage\n');
  fs.mkdirSync(path.join(TEAMS, `${newId()}.creating`));
  fs.mkdirSync(path.join(TEAMS, 'not-a-team'));
  const listed = storesOf().list();
  assert.deepEqual(listed.map((l) => l.teamId), [c.teamId, b.teamId, a.teamId]);
  assert.equal(listed[0].state.status, 'damaged');
  assert.equal(listed[0].state.name, 'cc');
  assert.equal(listed[0].lease, undefined);
  assert.equal(listed[1].lease.hostPid, process.pid);
  assert.equal(listed[1].header.name, 'bb');
  assert.equal(listed[1].state.status, 'active');
});

// ---- T11 E11 (A20): list() reports what the LOG says when no live owner vouches for state.json ----

/** A team whose owner died: created and grown by this process, then lease.json names a dead pid. */
async function orphaned(more = 3) {
  const t = await created();
  await t.store.append(Array.from({ length: more }, (_, i) => warn(`w${i}`)));
  killOwner(t.files);
  return t;
}
const listedOf = (teamId) => storesOf().list().find((l) => l.teamId === teamId);

await check('E11 list(): a duplicate seq under a STALE lease → damaged with the reason (state.json said active)', async () => {
  fresh();
  const { teamId, files } = await orphaned();
  assert.equal(JSON.parse(fs.readFileSync(files.state, 'utf8')).status, 'active');
  rewriteLog(files, (l) => [...l, l[l.length - 1]]);
  const listed = listedOf(teamId);
  assert.equal(listed.state.status, 'damaged', JSON.stringify(listed.state.status));
  assert.match(listed.state.damagedReason, /repeats seq \d+ \(duplicate\)/);
  assert.equal(listed.state.name, 'alpha');
  assert.ok(listed.lease, 'the stale lease is still listed for the caller to judge');
});

await check('E11 list(): a garbled MIDDLE line with no lease (released) → damaged naming the line', async () => {
  fresh();
  const { teamId, store, files } = await created();
  await store.append([warn('a'), warn('b'), warn('c')]);
  await store.release('test');
  rewriteLog(files, (l) => [l[0], l[1], '{"v":1,"seq":3,"ts":', ...l.slice(3)]);
  const listed = listedOf(teamId);
  assert.equal(listed.state.status, 'damaged');
  assert.match(listed.state.damagedReason, /line 3/);
});

await check('E11 list(): state.json says active, the log says suspended, owner dead → suspended (the log wins); a torn tail is ignored', async () => {
  fresh();
  const t = await created();
  await t.store.append([{ by: 'engine', body: { type: 'team.status', status: 'suspended', reason: 'lead-ended' } }], { reserve: true });
  const st = JSON.parse(fs.readFileSync(t.files.state, 'utf8'));
  fs.writeFileSync(t.files.state, JSON.stringify({ ...st, status: 'active', seq: st.seq - 1 }));
  killOwner(t.files);
  fs.appendFileSync(t.files.log, '{"v":1,"seq":99,"ts":1,"ty');
  const listed = listedOf(t.teamId);
  assert.equal(listed.state.status, 'suspended', JSON.stringify(listed.state.status));
  assert.equal(listed.state.seq, st.seq);
});

await check('E11 list(): the same disagreement on SEQ alone (status equal) → the log projection, not state.json', async () => {
  fresh();
  const t = await orphaned(2);
  const st = JSON.parse(fs.readFileSync(t.files.state, 'utf8'));
  fs.writeFileSync(t.files.state, JSON.stringify({ ...st, seq: st.seq - 2, members: [{ fake: true }] }));
  const listed = listedOf(t.teamId);
  assert.equal(listed.state.seq, st.seq);
  assert.equal(listed.state.members.length, 0, 'state.json\'s stale members were listed');
});

await check('E11 list(): a LIVE owner\'s state.json is listed as it is (no log validation); an intact orphan keeps state.json (its overlay)', async () => {
  fresh();
  const live = await created();
  const st = JSON.parse(fs.readFileSync(live.files.state, 'utf8'));
  fs.writeFileSync(live.files.state, JSON.stringify({ ...st, title: 'from-state-json' }));
  rewriteLog(live.files, (l) => [...l, l[l.length - 1]]);
  assert.equal(listedOf(live.teamId).state.title, 'from-state-json');
  assert.equal(listedOf(live.teamId).state.status, 'active');
  const dead = await orphaned(1);
  const st2 = JSON.parse(fs.readFileSync(dead.files.state, 'utf8'));
  fs.writeFileSync(dead.files.state, JSON.stringify({ ...st2, title: 'overlay-kept' }));
  assert.equal(listedOf(dead.teamId).state.title, 'overlay-kept');
});

await check('E11 list(): an ENDED team without a lease — tail seq = state.json seq → state.json; a duplicate final seq → damaged', async () => {
  fresh();
  const t = await created();
  await t.store.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }], { reserve: true });
  await t.store.release('end');
  const st = JSON.parse(fs.readFileSync(t.files.state, 'utf8'));
  fs.writeFileSync(t.files.state, JSON.stringify({ ...st, title: 'ended-state-json' }));
  assert.equal(listedOf(t.teamId).state.title, 'ended-state-json');
  assert.equal(listedOf(t.teamId).state.status, 'ended');
  rewriteLog(t.files, (l) => [...l, l[l.length - 1].replace(/"seq":\d+/, `"seq":${st.seq + 5}`)]);
  assert.equal(listedOf(t.teamId).state.status, 'damaged');
});

await check(`prune: of one repository's ENDED teams (state.json AND the log agree) only the newest TEAM_HISTORY_KEEP stay; active, suspended, damaged, leased, owned-here and other repositories are kept; old .creating/.removing leftovers go`, async () => {
  fresh();
  const stores = storesOf();
  const endedIds = [];
  for (let i = 0; i < C.TEAM_HISTORY_KEEP + 3; i++) {
    const id = newId();
    const r = await stores.create(initOf(id, { name: `e${i}` }));
    await r.value.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }], { reserve: true });
    await r.value.release('ended');
    endedIds.push(id);
  }
  const keep = [];
  const mk = async (name, finish, opts = {}) => {
    const id = newId();
    const r = await stores.create(initOf(id, { name, ...opts }));
    await finish(r.value, C.teamFilesOf(ROOT, id));
    keep.push(id);
    return id;
  };
  await mk('active', async (s) => s.release('suspend'));
  await mk('suspended', async (s) => {
    await s.append([{ by: 'engine', body: { type: 'team.status', status: 'suspended', reason: 'x' } }]);
    await s.release('suspend');
  });
  await mk('damaged', async (s, f) => {
    await s.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }]);
    await s.release('ended');
    fs.appendFileSync(f.log, '{bad\n{"v":1}\n');
  });
  await mk('leased', async (s, f) => {
    await s.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }]);
    await s.release('ended');
    fs.writeFileSync(f.lease, leaseNaming({ pid: deadPid(), startedAt: 1 }));
  });
  await mk('owned', async (s) => {
    await s.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }]);
  });
  await mk('other-repo', async (s) => {
    await s.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }]);
    await s.release('ended');
  }, { repoRoot: path.join(WORK, 'other') });
  await mk('state-disagrees', async (s, f) => {
    await s.append([{ by: 'lead', body: { type: 'team.status', status: 'ended', reason: 'done' } }]);
    await s.release('ended');
    const st = JSON.parse(fs.readFileSync(f.state, 'utf8'));
    fs.writeFileSync(f.state, JSON.stringify({ ...st, status: 'active' }));
  });
  const oldCreating = path.join(TEAMS, `${newId()}.creating`);
  const oldRemoving = path.join(TEAMS, `.${newId()}.removing`);
  const freshCreating = path.join(TEAMS, `${newId()}.creating`);
  for (const d of [oldCreating, oldRemoving, freshCreating]) fs.mkdirSync(d);
  const old = (Date.now() - 2 * C.START_LOCK_STALE_MS) / 1000;
  fs.utimesSync(oldCreating, old, old);
  fs.utimesSync(oldRemoving, old, old);
  const outside = path.join(WORK, 'prune-outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(C.teamFilesOf(ROOT, endedIds[0]).dir, 'link-out'));
  const r = stores.prune(REPO_ROOT);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([...r.value].sort(), endedIds.slice(0, 3).sort(), 'not the three oldest ended teams');
  for (const id of endedIds.slice(0, 3)) assert.ok(!fs.existsSync(path.join(TEAMS, id)), `${id} still there`);
  for (const id of [...endedIds.slice(3), ...keep]) assert.ok(fs.existsSync(path.join(TEAMS, id)), `${id} was removed`);
  assert.ok(!fs.existsSync(oldCreating) && !fs.existsSync(oldRemoving), 'old leftovers kept');
  assert.ok(fs.existsSync(freshCreating), 'a fresh .creating was removed');
  assert.ok(fs.existsSync(path.join(outside, 'precious')), 'prune followed a symlink');
  assert.deepEqual(stores.prune(REPO_ROOT).value, [], 'a second prune removed more');
});

// ---- done ----------------------------------------------------------------------------------

for (const s of sleepers) s.kill('SIGKILL');
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${tally.pass} passed, ${tally.fail} failed${tally.skip ? `, ${tally.skip} skipped` : ''} — src: ${SRC}`);
process.exit(tally.fail === 0 ? 0 : 1);
