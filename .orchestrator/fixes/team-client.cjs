// FX2: the VS Code team client (src/teamClient.ts) against a fake dispatch host speaking the
// observer protocol (§7.6) on a Unix socket. Covers the three fixes — a full history replay asks
// `fromSeq: 0` explicitly (an absent `fromSeq` replays nothing), a reconnect resubscribes from the
// last seq seen (kept across a dropped connection, with the messages already known), and the
// `run/` watch neither turns every host log line into a list request nor lists a host more than
// once per 4.5 s — plus what the client already did: snapshot re-reads debounced to ≤ 2 per
// second, events of a forged request id ignored, a host record naming another socket never
// connected to, and L7 (an `active` team of a dead owner is not believed).
//
//   node .orchestrator/fixes/team-client.cjs
//
// Bundles src/teamClient.ts (and the host-protocol helpers the fake needs) with the repository's
// esbuild into a temp directory and loads it in THIS process, with HOME / USERPROFILE pointed at
// a fresh sandbox under /tmp before anything loads (short paths keep the sockets in the run
// directory). No CLI is started; the only child processes are esbuild and the `ps` of L7.
// Prints `PASS <name>` / `FAIL <name> — <why>` and a tally; exit 0 only when everything passed.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('team-client', { selfCheck: true });
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync('/tmp/cco-tc-'));
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

const tally = { pass: 0, fail: 0 };
const show = (v) => {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return text === undefined ? String(v) : text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(v);
  }
};
function check(name, ok, observed) {
  if (ok) {
    tally.pass++;
    console.log(`PASS ${name}`);
  } else {
    tally.fail++;
    console.log(`FAIL ${name} — ${show(observed)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 20) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
};

/* ------------------------------------------------------------------------- *
 * The module under test
 * ------------------------------------------------------------------------- */

const entry = path.join(SANDBOX, 'entry.ts');
fs.writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(path.join(REPO, 'src', 'teamClient'))};`,
    `export { PROTOCOL_VERSION, TEAM_FEATURE, METHOD, METHOD_TEAM, runDirOf, socketPathFor, teamsDirOf } from ${JSON.stringify(path.join(REPO, 'src', 'mcp', 'host-protocol'))};`,
    `export { processStartedAt } from ${JSON.stringify(path.join(REPO, 'src', 'registry'))};`,
  ].join('\n'),
);
const bundled = path.join(SANDBOX, 'teamClient.js');
const built = spawnSync(
  path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  [entry, '--bundle', '--platform=node', '--target=node18', '--log-level=error', '--external:vscode', `--outfile=${bundled}`],
  { cwd: REPO, encoding: 'utf8' },
);
if (built.status !== 0) {
  console.log(`FAIL bundle — ${show(built.stderr || built.error)}`);
  process.exit(1);
}
const M = require(bundled);
const UID = process.getuid();

/* ------------------------------------------------------------------------- *
 * Fixtures: a data root, a workspace, a team on disk, a fake host
 * ------------------------------------------------------------------------- */

let rootN = 0;
function makeRoot() {
  const dataRoot = path.join(SANDBOX, `d${++rootN}`);
  const workspace = path.join(SANDBOX, `w${rootN}`);
  fs.mkdirSync(M.runDirOf(dataRoot), { recursive: true });
  fs.mkdirSync(M.teamsDirOf(dataRoot), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { dataRoot, workspace, runDir: M.runDirOf(dataRoot) };
}

function teamState(id, workspace, seq, extra = {}) {
  return {
    v: 1,
    id,
    name: 'alpha',
    title: 'Alpha',
    status: 'active',
    workspace,
    repoRoot: workspace,
    leadRel: '',
    baseCommit: '0'.repeat(40),
    createdAt: Date.now() - 60_000,
    seq,
    owner: null,
    lead: { unread: 0, readSeq: 0, waiter: false, lastCallAt: null, wakesToday: 0 },
    user: { unread: 0, readSeq: 0 },
    members: [],
    board: [],
    budgets: { turnsToday: 0, turnsPerDay: 100, running: 0, maxRunning: 2, pingPongTripped: false },
    totals: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    warnings: [],
    ...extra,
  };
}

function writeTeamOnDisk(env, state) {
  const dir = path.join(M.teamsDirOf(env.dataRoot), state.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ id: state.id, workspace: env.workspace, repoRoot: env.workspace }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

function writeRecord(env, sessionPid, socket) {
  const record = {
    protocol: M.PROTOCOL_VERSION,
    hostPid: process.pid,
    hostStartedAt: Date.now(),
    session: { pid: sessionPid, startedAt: Date.now() },
    workspace: env.workspace,
    socket,
    serverHash: 'abcdef012345',
  };
  fs.writeFileSync(path.join(env.runDir, `s${sessionPid}.json`), JSON.stringify(record));
}

/**
 * A fake host owning one team: answers hello / list / get / subscribe / unsubscribe, keeps a log
 * of `msg.posted` events, replays the ones after `fromSeq` (none when it is absent), and records
 * every request. `replayLimit` cuts a replay short and then closes the connection (an overflow).
 */
function fakeHost(env, sessionPid, teamId) {
  const socketPath = M.socketPathFor(env.runDir, sessionPid, UID).socket;
  const h = {
    socketPath,
    requests: [],
    log: [],
    conns: new Set(),
    subs: new Map(),
    replayLimit: undefined,
    state: () => teamState(teamId, env.workspace, h.log.length),
    post(text) {
      const e = { seq: h.log.length + 1, ts: Date.now(), kind: 'msg.posted', data: { kind: 'text', from: 'lead', to: 'user', body: text, bytes: text.length } };
      h.log.push(e);
      for (const [sock, sub] of h.subs) h.push(sock, sub, e);
      return e;
    },
    push(sock, sub, e) {
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: M.METHOD_TEAM.event, params: { requestId: sub.id, teamId, ...e } })}\n`);
    },
    count: (method) => h.requests.filter((r) => r.method === method).length,
    dropAll() {
      for (const sock of h.conns) sock.destroy();
    },
  };
  const answer = (sock, id, result) => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  h.server = net.createServer((sock) => {
    h.conns.add(sock);
    let buf = '';
    sock.on('close', () => {
      h.conns.delete(sock);
      h.subs.delete(sock);
    });
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        h.requests.push({ method: msg.method, params: msg.params, at: Date.now() });
        if (msg.method === M.METHOD.hello) {
          answer(sock, msg.id, { protocol: M.PROTOCOL_VERSION, hostPid: process.pid, features: [M.TEAM_FEATURE] });
        } else if (msg.method === M.METHOD_TEAM.list) {
          answer(sock, msg.id, { ok: true, teams: [{ teamId, ownedHere: true, state: 'active' }] });
        } else if (msg.method === M.METHOD_TEAM.get) {
          answer(sock, msg.id, { ok: true, state: h.state() });
        } else if (msg.method === M.METHOD_TEAM.unsubscribe) {
          const old = h.subs.get(sock);
          h.subs.delete(sock);
          if (old) answer(sock, old.id, { ok: true });
          answer(sock, msg.id, { ok: true });
        } else if (msg.method === M.METHOD_TEAM.subscribe) {
          const old = h.subs.get(sock);
          if (old) answer(sock, old.id, { ok: true, replaced: true });
          const sub = { id: msg.id };
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: M.METHOD_TEAM.event, params: { requestId: msg.id, teamId, seq: h.log.length, ts: Date.now(), kind: 'snapshot', state: h.state() } })}\n`);
          const from = msg.params.fromSeq;
          const replay = typeof from === 'number' ? h.log.filter((e) => e.seq > from) : [];
          if (h.replayLimit !== undefined && replay.length > h.replayLimit) {
            for (const e of replay.slice(0, h.replayLimit)) h.push(sock, sub, e);
            h.replayLimit = undefined;
            setTimeout(() => sock.destroy(), 50);
            continue;
          }
          for (const e of replay) h.push(sock, sub, e);
          h.subs.set(sock, sub);
        } else if (typeof msg.id === 'number') {
          answer(sock, msg.id, { ok: true });
        }
      }
    });
  });
  h.listen = () => new Promise((resolve) => h.server.listen(socketPath, resolve));
  h.close = () => new Promise((resolve) => {
    h.dropAll();
    h.server.close(() => resolve());
  });
  return h;
}

function client(env) {
  const lines = [];
  const c = new M.TeamClient({
    dataRoot: env.dataRoot,
    workspace: () => env.workspace,
    connectWanted: () => true,
    log: (line) => lines.push(line),
  });
  c.lines = lines;
  return c;
}

const subscribes = (h) => h.requests.filter((r) => r.method === M.METHOD_TEAM.subscribe);
const messagesOf = (c, teamId) => c.team(teamId)?.messages ?? [];

/* ------------------------------------------------------------------------- *
 * Cases
 * ------------------------------------------------------------------------- */

const TEAM = 'tmabcdefghi1';

async function shortLogAndResume() {
  const env = makeRoot();
  const h = fakeHost(env, 4101, TEAM);
  for (let i = 1; i <= 5; i++) h.post(`hello ${i}`);
  writeTeamOnDisk(env, h.state());
  await h.listen();
  writeRecord(env, 4101, h.socketPath);
  const c = client(env);
  c.start();
  try {
    await until(() => messagesOf(c, TEAM).length === 5);
    const first = subscribes(h)[0];
    check('fix 1: a short log is replayed from the start — the subscribe carries fromSeq: 0 explicitly', first !== undefined && Object.prototype.hasOwnProperty.call(first.params, 'fromSeq') && first.params.fromSeq === 0, first?.params);
    check('fix 1: the Messages node holds the whole short history (5 messages)', messagesOf(c, TEAM).length === 5, messagesOf(c, TEAM).map((m) => m.seq));
    check('the snapshot is live and believed', c.team(TEAM)?.live === true && c.team(TEAM)?.believed === true, c.team(TEAM));

    h.post('hello 6');
    await until(() => messagesOf(c, TEAM).length === 6);
    // The connection drops (the host closes it, as an overflow would); two messages are posted meanwhile.
    h.dropAll();
    await until(() => c.team(TEAM)?.live !== true, 2000);
    h.post('while away 7');
    h.post('while away 8');
    await until(() => subscribes(h).length >= 2 && messagesOf(c, TEAM).length === 8, 10_000);
    const second = subscribes(h)[1];
    check('fix 2: the reconnect resubscribes from the last seq seen (fromSeq: 6)', second?.params?.fromSeq === 6, second?.params);
    check('fix 2: the messages known before the drop are kept and the missed ones arrive (8)', messagesOf(c, TEAM).length === 8 && c.team(TEAM)?.live === true, messagesOf(c, TEAM).map((m) => m.seq));

    // A connection closed mid-replay: the opening snapshot (seq 12) must not count as seen.
    h.dropAll();
    await until(() => c.team(TEAM)?.live !== true, 2000);
    for (let i = 9; i <= 12; i++) h.post(`burst ${i}`);
    h.replayLimit = 2; // replays 9 and 10, then closes
    await until(() => subscribes(h).length >= 4 && messagesOf(c, TEAM).length === 12, 15_000);
    const third = subscribes(h)[2];
    const fourth = subscribes(h)[3];
    check('fix 2: a replay cut short resumes from the last EVENT (10), not the snapshot seq (12)', third?.params?.fromSeq === 8 && fourth?.params?.fromSeq === 10, [third?.params, fourth?.params]);
    check('fix 2: after the cut replay every message is listed (12)', messagesOf(c, TEAM).length === 12, messagesOf(c, TEAM).map((m) => m.seq));

    // Forged request ids: an event whose requestId is not the live subscription's is ignored.
    await sleep(1200); // the replay's own debounced re-reads settle first
    const getsBefore = h.count(M.METHOD_TEAM.get);
    for (const sock of h.conns) {
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: M.METHOD_TEAM.event, params: { requestId: 999_999, teamId: TEAM, seq: 99, ts: Date.now(), kind: 'msg.posted', data: { kind: 'text', from: 'mallory', to: 'user', body: 'forged' } } })}\n`);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999_998, result: { ok: true } })}\n`);
    }
    await sleep(900);
    check('a forged requestId is ignored (no message, no snapshot re-read)', !messagesOf(c, TEAM).some((m) => m.seq === 99) && h.count(M.METHOD_TEAM.get) === getsBefore && c.team(TEAM)?.live === true, { messages: messagesOf(c, TEAM).map((m) => m.seq), gets: h.count(M.METHOD_TEAM.get) - getsBefore });

    // Debounced snapshot re-reads (A14): 30 events within ~300 ms → at most 2 gets per second.
    const t0 = Date.now();
    const g0 = h.count(M.METHOD_TEAM.get);
    for (let i = 0; i < 30; i++) {
      h.post(`fast ${i}`);
      await sleep(10);
    }
    await sleep(1600);
    const gets = h.requests.filter((r) => r.method === M.METHOD_TEAM.get && r.at >= t0);
    const window = Math.max(1, (Date.now() - t0) / 1000);
    check('snapshot re-reads are debounced (≥ 1, ≤ 2 per second)', gets.length >= 1 && gets.length <= Math.ceil(window * 2) + 1 && gets.length < 10, { gets: gets.length, seconds: window });
    check('the last re-read shows the latest seq', c.team(TEAM)?.state.seq === h.log.length, { client: c.team(TEAM)?.state.seq, host: h.log.length, g0 });
  } finally {
    c.dispose();
    await h.close();
  }
}

async function listStorm() {
  const env = makeRoot();
  const h = fakeHost(env, 4201, TEAM);
  h.post('one');
  writeTeamOnDisk(env, h.state());
  await h.listen();
  writeRecord(env, 4201, h.socketPath);
  const c = client(env);
  c.start();
  try {
    await until(() => c.team(TEAM)?.live === true);
    await sleep(300);
    // A host log appended continuously for 2 s: no list request may follow from it.
    const logFile = path.join(env.runDir, 's4201.log');
    const t0 = Date.now();
    const lists0 = h.count(M.METHOD_TEAM.list);
    while (Date.now() - t0 < 2000) {
      fs.appendFileSync(logFile, `host line ${Date.now()}\n`);
      await sleep(5);
    }
    const fromLog = h.count(M.METHOD_TEAM.list) - lists0;
    // The 5 s tick may fall inside the window once.
    check('fix 3: host log lines do not cause list requests (≤ 1 in 2 s of appends, the 5 s tick)', fromLog <= 1, fromLog);

    // Other run-directory churn: debounced, and at most one list per 4.5 s per host.
    const t1 = Date.now();
    const lists1 = h.count(M.METHOD_TEAM.list);
    const lock = path.join(env.runDir, 's4201.lock');
    while (Date.now() - t1 < 3000) {
      fs.writeFileSync(lock, String(Date.now()));
      await sleep(40);
    }
    const listTimes = h.requests.filter((r) => r.method === M.METHOD_TEAM.list).map((r) => r.at);
    let minGap = Infinity;
    for (let i = 1; i < listTimes.length; i++) minGap = Math.min(minGap, listTimes[i] - listTimes[i - 1]);
    check('fix 3: run-directory churn lists a host at most once per 4.5 s', h.count(M.METHOD_TEAM.list) - lists1 <= 1 && minGap >= 4400, { lists: h.count(M.METHOD_TEAM.list) - lists1, minGap });

    // A new host record is still found by the watch, without waiting for the 5 s tick.
    const h2 = fakeHost(env, 4202, 'tmabcdefghi2');
    await h2.listen();
    const t2 = Date.now();
    writeRecord(env, 4202, h2.socketPath);
    await until(() => h2.count(M.METHOD.hello) > 0, 6000);
    const found = Date.now() - t2;
    check('fix 3: a new host record is still picked up by the (debounced) watch, well inside the 5 s tick', h2.count(M.METHOD.hello) === 1 && found < 2500, { hello: h2.count(M.METHOD.hello), ms: found });

    // Refresh lists at once, cap or no cap.
    const lists2 = h.count(M.METHOD_TEAM.list);
    c.refresh();
    await until(() => h.count(M.METHOD_TEAM.list) > lists2, 1000);
    check('a Refresh lists at once', h.count(M.METHOD_TEAM.list) === lists2 + 1, h.count(M.METHOD_TEAM.list) - lists2);
    await h2.close();
  } finally {
    c.dispose();
    await h.close();
  }
}

async function wrongSocket() {
  const env = makeRoot();
  const elsewhere = path.join(SANDBOX, 'elsewhere.sock');
  const h = fakeHost(env, 4301, TEAM);
  h.socketPath = elsewhere;
  await new Promise((resolve) => h.server.listen(elsewhere, resolve));
  writeRecord(env, 4301, elsewhere);
  const c = client(env);
  c.start();
  try {
    await sleep(1500);
    check('a host record naming another socket is never connected to', h.requests.length === 0 && c.teams().length === 0, { requests: h.requests.length, teams: c.teams().length });
  } finally {
    c.dispose();
    await h.close();
  }
}

async function ownerL7() {
  const env = makeRoot();
  let dead = 999_999;
  while (dead > 2 && (() => { try { process.kill(dead, 0); return true; } catch (e) { return e.code === 'EPERM'; } })()) dead--;
  const startedAt = M.processStartedAt(process.pid);
  writeTeamOnDisk(env, teamState('tmdeadowner1', env.workspace, 3, { owner: { hostPid: dead, hostStartedAt: Date.now(), session: { pid: dead, startedAt: Date.now() } } }));
  writeTeamOnDisk(env, teamState('tmliveowner1', env.workspace, 3, { owner: { hostPid: process.pid, hostStartedAt: startedAt ?? 0, session: { pid: process.pid, startedAt: startedAt ?? 0 } } }));
  writeTeamOnDisk(env, teamState('tmnoowner001', env.workspace, 3, { status: 'suspended' }));
  const c = client(env);
  c.start();
  try {
    await until(() => c.teams().length === 3, 3000);
    const deadT = c.team('tmdeadowner1');
    const liveT = c.team('tmliveowner1');
    const susp = c.team('tmnoowner001');
    check('L7: an active team whose owner is dead is not believed (host gone)', deadT !== undefined && deadT.live === false && deadT.believed === false, deadT && { live: deadT.live, believed: deadT.believed });
    check('L7: an active team whose owner is provably alive is believed', startedAt === undefined || (liveT !== undefined && liveT.believed === true), { startedAt, believed: liveT?.believed });
    check('L7: a non-active team is believed without an owner', susp !== undefined && susp.believed === true && susp.messages.length === 0, susp && { believed: susp.believed });
  } finally {
    c.dispose();
  }
}

/**
 * S2 (A35): `run/` holds 1,000 old host logs (named so that they sort before the record) and 250
 * records of hosts long gone, all older than the one live record: the live host is still found —
 * the scan keeps only `s<P>.json` names, newest first, before its cap of 200.
 */
async function s2RunDirFilter() {
  const env = makeRoot();
  const h = fakeHost(env, 4401, TEAM);
  h.post('one');
  writeTeamOnDisk(env, h.state());
  await h.listen();
  const old = (Date.now() - 30 * 24 * 3_600_000) / 1000;
  for (let k = 1; k <= 1000; k++) {
    const f = path.join(env.runDir, `s${100000 + k}.log`);
    fs.writeFileSync(f, 'an old host log\n');
    fs.utimesSync(f, old, old);
  }
  const dead = 999_000;
  for (let k = 1; k <= 250; k++) {
    const f = path.join(env.runDir, `s${200000 + k}.json`);
    fs.writeFileSync(
      f,
      JSON.stringify({ protocol: M.PROTOCOL_VERSION, hostPid: dead - k, hostStartedAt: 1, session: { pid: 200000 + k, startedAt: 1 }, workspace: env.workspace, socket: '/tmp/gone.sock', serverHash: 'x' }),
    );
    fs.utimesSync(f, old, old);
  }
  writeRecord(env, 4401, h.socketPath);
  const c = client(env);
  c.start();
  try {
    const live = await until(() => c.team(TEAM)?.live === true, 8000);
    check('S2 the live host is found behind 1,000 old host logs and 250 stale records (records only, newest first, then the cap)', live === true && h.count(M.METHOD.hello) >= 1, { hellos: h.count(M.METHOD.hello), teams: c.teams().map((t) => [t.teamId, t.live]) });
    // Variant: a second live host whose record is the newest of all, in a directory that now also
    // holds 50 lock / fail / spec files — found as well, by the watch.
    for (let k = 1; k <= 50; k++) fs.writeFileSync(path.join(env.runDir, `s${300000 + k}.${['lock', 'fail', 'spec.json'][k % 3]}`), 'x');
    const h2 = fakeHost(env, 4402, 'tmabcdefghj2');
    await h2.listen();
    writeRecord(env, 4402, h2.socketPath);
    c.refresh();
    const second = await until(() => h2.count(M.METHOD.hello) > 0, 6000);
    check('S2 variant: a second live record among lock/fail/spec files is found too', Boolean(second), { hellos: h2.count(M.METHOD.hello) });
    await h2.close();
  } finally {
    c.dispose();
    await h.close();
  }
}

/**
 * S6 (A38): a team directory whose `team.json` is not there yet when the client first looks (the
 * engine makes the directory, then renames the header into it) is listed once the header appears
 * — nothing is cached for a header that could not be read. Variant: the header path is first a
 * DIRECTORY (a read error of another kind), then a file.
 */
async function s6HeaderRetry() {
  const env = makeRoot();
  const id1 = 'tmlateheader1';
  const id2 = 'tmdirheader01';
  for (const id of [id1, id2]) {
    const dir = path.join(M.teamsDirOf(env.dataRoot), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(teamState(id, env.workspace, 2, { status: 'suspended' })));
  }
  fs.mkdirSync(path.join(M.teamsDirOf(env.dataRoot), id2, 'team.json'));
  const c = client(env);
  c.start();
  try {
    await sleep(400);
    check('S6 before its header exists the team is not listed', c.team(id1) === undefined && c.team(id2) === undefined, c.teams().map((t) => t.teamId));
    fs.writeFileSync(path.join(M.teamsDirOf(env.dataRoot), id1, 'team.json'), JSON.stringify({ id: id1, workspace: env.workspace, repoRoot: env.workspace }));
    c.refresh();
    const listed = await until(() => c.team(id1) !== undefined, 2000);
    check('S6 a header that appears later is read on the next look (not cached as "not ours")', Boolean(listed), c.teams().map((t) => t.teamId));
    const headerDir = path.join(M.teamsDirOf(env.dataRoot), id2, 'team.json');
    fs.rmdirSync(headerDir);
    fs.writeFileSync(headerDir, JSON.stringify({ id: id2, workspace: env.workspace, repoRoot: env.workspace }));
    c.refresh();
    const listed2 = await until(() => c.team(id2) !== undefined, 2000);
    check('S6 variant: a header path that was a directory (a read error) and then a file is read again', Boolean(listed2), c.teams().map((t) => t.teamId));
  } finally {
    c.dispose();
  }
}

(async () => {
  console.log(`team-client: sandbox = ${SANDBOX}`);
  for (const run of [shortLogAndResume, listStorm, wrongSocket, ownerL7, s2RunDirFilter, s6HeaderRetry]) {
    try {
      await run();
    } catch (e) {
      check(`${run.name} ran to its end`, false, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
    }
  }
  console.log(`\nteam-client: ${tally.pass} passed, ${tally.fail} failed`);
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    // left for inspection
  }
  process.exit(tally.fail === 0 ? 0 : 1);
})();
