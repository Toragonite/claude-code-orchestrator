#!/usr/bin/env node
// team-engine.mjs — offline checks of the team engine CORE (src/team/engine.ts, src/team/routing.ts;
// team contract §7.1 TeamCore, task T5a), driven over FAKES of its three frozen seams — the store
// (TeamStores/TeamStore), the driver (StartTurn + MintConversation) and the worktrees
// (TeamWorktrees) — and of its host seam (TeamCoreHost). The fakes live in this file, so the
// checks do not wait on store.ts, driver.ts or worktree.ts: the bundle replaces those three
// modules with stubs that throw if anything calls them.
//
//   node .orchestrator/fixes/team-engine.mjs                 every scenario
//   node .orchestrator/fixes/team-engine.mjs --only quota    scenarios whose name contains "quota"
//   node .orchestrator/fixes/team-engine.mjs --keep          leave the scratch directory behind
//
// WHAT RUNS. src/team/engine.ts is bundled with esbuild into a scratch directory (never `out/`),
// with HOME and USERPROFILE pointed at that directory BEFORE the bundle is loaded (registry.ts
// computes its data root on load). No agent CLI, no git, no `ps` is ever started: every process
// fact is the fake host's table. Each check prints `PASS <name>` or `FAIL <name> — <why>`; the
// last line is the tally; the exit code is 0 only when every check passed.
//
// The premortem rows (contract §10) each scenario expresses are named in its title.

import keychainGuard from './keychain-guard.cjs';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('team-engine', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const ONLY = opt('--only');
const KEEP = argv.includes('--keep');

/* ------------------------------------------------------------------------- *
 * Scratch space and isolation — before anything else is loaded
 * ------------------------------------------------------------------------- */

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-team-engine-')));
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const DATA = path.join(HOME, '.claude-code-orchestrator');
fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
function clip(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…[${flat.length} chars]` : flat;
}
function check(name, ok, why = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} — ${clip(why === '' ? 'the condition did not hold' : why)}`);
  }
  return ok;
}
async function waitFor(fn, { timeoutMs = 4_000, intervalMs = 5, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = fn();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() - started > timeoutMs) return undefined;
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------------- *
 * Build: the engine, with the three seams' modules stubbed
 * ------------------------------------------------------------------------- */

const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');
const OUT = path.join(BASE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const STUB = path.join(OUT, 'seam-stub.ts');
fs.writeFileSync(
  STUB,
  [
    "const no = (what: string) => () => { throw new Error(`${what} is a stub in team-engine.mjs`); };",
    "export const createTeamStores = no('createTeamStores');",
    "export const startTurn = no('startTurn');",
    "export const mintConversation = no('mintConversation');",
    "export const createTeamWorktrees = no('createTeamWorktrees');",
    '',
  ].join('\n'),
);
const ENTRY = path.join(OUT, 'entry.ts');
fs.writeFileSync(
  ENTRY,
  [
    `export { createTeamCoreWith, codexConfigRegistersDispatch } from ${JSON.stringify(path.join(REPO, 'src', 'team', 'engine'))};`,
    `export * as contract from ${JSON.stringify(path.join(REPO, 'src', 'team', 'contract'))};`,
    `export { renderCreateAnswer } from ${JSON.stringify(path.join(REPO, 'src', 'team', 'render'))};`,
    `export { routeMember, accountKeyOf, identityKeysOf, namesOfIdentities } from ${JSON.stringify(path.join(REPO, 'src', 'team', 'routing'))};`,
    '',
  ].join('\n'),
);
const BUNDLE = path.join(OUT, 'engine.cjs');
await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: BUNDLE,
  logLevel: 'error',
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [
    {
      name: 'stub-team-seams',
      setup(build) {
        build.onResolve({ filter: /^\.\/(store|driver|worktree)$/ }, (args) =>
          args.importer.endsWith(path.join('team', 'engine.ts')) ? { path: STUB } : undefined,
        );
      },
    },
  ],
});
const lib = require(BUNDLE);
const { createTeamCoreWith, codexConfigRegistersDispatch, contract: C, renderCreateAnswer } = lib;

/* ------------------------------------------------------------------------- *
 * Fake store (TeamStores / TeamStore)
 * ------------------------------------------------------------------------- */

/** A minimal projection — the engine decides from its own fold; this only feeds answers. */
function project(header, events, status0 = 'active') {
  const st = {
    v: 1,
    id: header.id,
    name: header.name,
    title: header.title,
    status: status0,
    workspace: header.workspace,
    repoRoot: header.repoRoot,
    leadRel: '',
    baseCommit: '',
    createdAt: header.createdAt,
    seq: 0,
    owner: null,
    lead: { unread: 0, readSeq: 0, waiter: false, lastCallAt: null, wakesToday: 0 },
    user: { unread: 0, readSeq: 0 },
    members: [],
    board: [],
    budgets: { turnsToday: 0, turnsPerDay: 300, running: 0, maxRunning: 4, pingPongTripped: false },
    totals: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    warnings: [],
  };
  const member = (name) => st.members.find((m) => m.name === name);
  for (const e of events) {
    st.seq = e.seq;
    switch (e.type) {
      case 'team.created':
        st.baseCommit = e.baseCommit;
        st.leadRel = e.leadRel;
        break;
      case 'team.status':
        st.status = e.status;
        break;
      case 'lease.acquired':
        st.owner = { hostPid: e.hostPid, hostStartedAt: e.hostStartedAt, session: e.session };
        break;
      case 'lease.released':
        st.owner = null;
        break;
      case 'member.added':
        st.members.push({
          name: e.name, index: e.index, role: e.role, state: 'starting', provider: 'claude', worker: '', accountLabel: '',
          machineLogin: false, sharesLeadPlan: false, billableOverage: false, runsCommands: false, model: '', incarnation: 0,
          mailbox: 'unverified', portBase: 20000 + 100 * e.index, worktree: { path: '', branch: '', baseCommit: '', ready: false },
          turns: 0, tokens: { in: 0, out: 0 }, costUsd: null, pending: 0, tasks: [], peerWakes: 0,
        });
        break;
      case 'member.routed': {
        const m = member(e.name);
        if (m) Object.assign(m, { provider: e.provider, worker: e.worker, accountLabel: e.worker, model: e.model, incarnation: e.incarnation });
        break;
      }
      case 'member.state': {
        const m = member(e.name);
        if (m) {
          m.state = e.state;
          if (e.reason) m.reason = e.reason;
          else delete m.reason;
          if (e.state !== 'running' && e.state !== 'pausing') delete m.turn; // as store.ts's reducer
        }
        break;
      }
      case 'member.mailbox': {
        const m = member(e.name);
        if (m) m.mailbox = e.mailbox;
        break;
      }
      case 'turn.planned': {
        const m = member(e.name);
        if (m) m.turn = { id: e.turnId, n: e.n, startedAt: e.ts };
        break;
      }
      case 'turn.ended': {
        for (const m of st.members) if (m.turn?.id === e.turnId) delete m.turn;
        break;
      }
      case 'board.created':
        st.board.push(e.task);
        break;
      default:
        break;
    }
  }
  return st;
}

class FakeStore {
  constructor(stores, header, events, { owned = false, lease } = {}) {
    this.stores = stores;
    this.teamId = header.id;
    this.header = header;
    this.events = events;
    this.files = C.teamFilesOf(DATA, header.id);
    this.fileMap = new Map();
    this.feeds = new Map();
    this._owned = owned;
    this.lease = lease;
    this.listeners = new Set();
    this.overlay = (s) => s;
    this.failNext = []; // [{code, errno}] consumed per append
    this.enospc = false; // every append fails ENOSPC while set
    this.logFull = false;
    this.appendCalls = 0;
    this.failTypes = []; // T11 E19: [{type, code}] — the next batch holding an event of `type` fails `code`
    this.damaged = undefined; // T11 E11: a reason → acquire answers damaged
  }
  readHeader() {
    return { ok: true, value: this.header };
  }
  readStateFile() {
    return { ok: true, value: project(this.header, this.events) };
  }
  readLog() {
    return { ok: true, value: { header: this.header, events: [...this.events], tornBytes: 0 } };
  }
  projectLog() {
    return { ok: true, value: project(this.header, this.events) };
  }
  eventsFrom(fromSeq, max) {
    const after = this.events.filter((e) => e.seq > fromSeq);
    if (after.length > 5000) return 'resnapshot_required';
    return after.slice(0, max);
  }
  messages(q) {
    return this.events.filter(
      (e) => e.type === 'msg.posted' && (q.to === undefined || e.to === q.to || (e.recipients ?? []).includes(q.to)) && (q.from === undefined || e.from === q.from),
    );
  }
  messageText(m) {
    if (typeof m.body === 'string') return { ok: true, value: m.body };
    const t = this.fileMap.get(m.bodyFile);
    return t === undefined ? { ok: false, code: 'unreadable', reason: 'missing body' } : { ok: true, value: t };
  }
  readFile(rel) {
    const t = this.fileMap.get(rel);
    return t === undefined ? { ok: false, code: 'absent', reason: `no ${rel}` } : { ok: true, value: t };
  }
  feedTail(member, max) {
    return (this.feeds.get(member) ?? []).slice(-max);
  }
  async acquire() {
    if (this.damaged !== undefined) return { ok: false, code: 'damaged', reason: this.damaged };
    if (this._owned) return { ok: true, value: { repairedBytes: 0 } };
    if (this.lease && this.stores.host.process.isAlive(this.lease.hostPid)) return { ok: false, code: 'busy', reason: 'busy', holder: this.lease };
    const tookOver = this.lease ? { oldHostPid: this.lease.hostPid } : undefined;
    this.lease = { v: 1, hostPid: process.pid, hostStartedAt: 1, session: { pid: 1, startedAt: 1 }, socket: '/s', acquiredAt: Date.now() };
    this._owned = true;
    await this.append([{ by: 'engine', body: { type: 'lease.acquired', hostPid: process.pid, hostStartedAt: 1, session: { pid: 1, startedAt: 1 }, ...(tookOver ? { tookOver } : {}) } }], { reserve: true });
    return { ok: true, value: { tookOver, repairedBytes: 0 } };
  }
  owned() {
    return this._owned;
  }
  async release(reason) {
    if (!this._owned) return { ok: true, value: undefined };
    await this.append([{ by: 'engine', body: { type: 'lease.released', reason } }], { reserve: true });
    this._owned = false;
    this.lease = undefined;
    return { ok: true, value: undefined };
  }
  async append(items, opts = {}) {
    this.appendCalls++;
    await Promise.resolve();
    if (!this._owned) return { ok: false, code: 'not-owner', reason: 'not owner' };
    if (this.enospc) return { ok: false, code: 'io', errno: 'ENOSPC', reason: 'no space' };
    if (this.failNext.length > 0) {
      const f = this.failNext.shift();
      return { ok: false, code: f.code, errno: f.errno, reason: f.code };
    }
    if (this.failTypes.length > 0 && items.some((it) => it.body.type === this.failTypes[0].type)) {
      const f = this.failTypes.shift();
      return { ok: false, code: f.code, errno: f.errno, reason: f.code };
    }
    if (this.logFull && !opts.reserve) return { ok: false, code: 'log-full', reason: 'full' };
    const out = [];
    for (const it of items) {
      const seq = this.events.length + 1;
      const body = { ...it.body };
      if (it.bodyText !== undefined) {
        const rel = `bodies/m${seq}.md`;
        this.fileMap.set(rel, it.bodyText);
        body.bodyFile = rel;
      }
      const e = { v: 1, seq, ts: Date.now(), by: it.by, ...body };
      this.events.push(e);
      out.push(e);
    }
    for (const cb of this.listeners) cb(out);
    return { ok: true, value: out };
  }
  onEvents(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  state() {
    return this._owned ? this.overlay(project(this.header, this.events)) : undefined;
  }
  setOverlay(o) {
    this.overlay = o;
  }
  writeState() {
    return { ok: true, value: undefined };
  }
  writeFile(rel, text) {
    this.fileMap.set(rel, text);
    return { ok: true, value: path.join(this.files.dir, rel) };
  }
  appendFeed(member, items) {
    const list = this.feeds.get(member) ?? [];
    list.push(...items);
    this.feeds.set(member, list);
    return { ok: true, value: undefined };
  }
  // test helpers
  ofType(type) {
    return this.events.filter((e) => e.type === type);
  }
}

class FakeStores {
  constructor(host) {
    this.host = host;
    this.map = new Map();
    this.created = [];
  }
  async create(init) {
    if (this.map.has(init.header.id)) return { ok: false, code: 'exists', reason: 'exists' };
    const s = new FakeStore(this, init.header, [], { owned: true });
    for (const f of init.files ?? []) s.fileMap.set(f.rel, f.text);
    const [first, ...rest] = init.events;
    const lease = { by: 'engine', body: { type: 'lease.acquired', hostPid: process.pid, hostStartedAt: 1, session: { pid: 1, startedAt: 1 } } };
    // the first batch: no callback sees it (the engine reads it back from readLog)
    let seq = 0;
    for (const it of [first, lease, ...rest]) {
      seq++;
      const body = { ...it.body };
      if (it.bodyText !== undefined) {
        s.fileMap.set(`bodies/m${seq}.md`, it.bodyText);
        body.bodyFile = `bodies/m${seq}.md`;
      }
      s.events.push({ v: 1, seq, ts: Date.now(), by: it.by, ...body });
    }
    s.lease = { v: 1, hostPid: process.pid, hostStartedAt: 1, session: { pid: 1, startedAt: 1 }, socket: '/s', acquiredAt: Date.now() };
    this.map.set(init.header.id, s);
    this.created.push(s);
    return { ok: true, value: s };
  }
  open(teamId) {
    const s = this.map.get(teamId);
    return s ? { ok: true, value: s } : { ok: false, code: 'absent', reason: 'absent' };
  }
  list() {
    return [...this.map.values()].map((s) => ({ teamId: s.teamId, header: s.header, state: project(s.header, s.events), lease: s.lease }));
  }
  prune() {
    return { ok: true, value: [] };
  }
}

/* ------------------------------------------------------------------------- *
 * Fake driver (StartTurn + MintConversation)
 * ------------------------------------------------------------------------- */

function makeDriver(hooks) {
  const scripts = new Map();
  const calls = [];
  let nextPid = 7000;
  let minted = 0;
  const mintFailures = [];
  const startTurn = (spec, deps) => {
    const q = scripts.get(spec.member) ?? [];
    const step = q.length > 0 ? q.shift() : {};
    const call = { spec, deps, step, signals: [], plannedBeforeSpawn: undefined, spawned: false };
    calls.push(call);
    const pid = ++nextPid;
    let resolveResult;
    const result = new Promise((r) => (resolveResult = r));
    let resolveConv;
    const conversationId = new Promise((r) => (resolveConv = r));
    let ended = false;
    const queue = [];
    let wake;
    let closed = false;
    const events = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (closed) return;
          await new Promise((r) => (wake = r));
        }
      },
    };
    const push = (item) => {
      queue.push(item);
      wake?.();
    };
    const outcomeOf = (over = {}) => {
      const sawEvent = step.sawEvent ?? true;
      const sawAssistant = step.sawAssistant ?? sawEvent;
      return {
        outcome: step.outcome ?? 'ok',
        contextLost: step.contextLost === true,
        conversationIdSeen: step.convSeen !== undefined ? step.convSeen : sawEvent ? (spec.expectedConversationId ?? `thread-${pid}`) : undefined,
        sawAssistant,
        assistantAfter: step.assistantAfter ?? (() => sawAssistant),
        text: step.text ?? `turn ${spec.n} of ${spec.member} done`,
        tokens: step.tokens ?? { in: 1000, out: 100 },
        exitCode: 0,
        signal: null,
        signalledBy: step.signalledBy ?? null,
        sawEvent,
        stderrTail: step.stderrTail ?? '',
        ...(step.note !== undefined ? { note: step.note } : {}),
        ...(step.teamToolsConnected !== undefined ? { teamToolsConnected: step.teamToolsConnected } : {}),
        ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
        ...(step.cumulativeCostUsd !== undefined ? { cumulativeCostUsd: step.cumulativeCostUsd } : {}),
        ...over,
      };
    };
    const finish = (o) => {
      if (ended) return;
      ended = true;
      call.outcome = o;
      resolveConv(o.conversationIdSeen);
      resolveResult(o);
      closed = true;
      wake?.();
    };
    const signal = (kind) => {
      call.signals.push(kind);
      if (step.ignoreSignals) return;
      setTimeout(() => finish(outcomeOf({ outcome: 'interrupted', signalledBy: 'engine', sawAssistant: step.sawAssistantBeforeKill ?? false, signal: 'SIGINT', exitCode: null })), 3);
    };
    setTimeout(async () => {
      if (ended) return;
      call.plannedBeforeSpawn = hooks.isPlanned(spec.turnId);
      call.spawned = true;
      deps.onSpawn({ pid, pgid: pid, startedAt: Date.now() });
      if (step.sawEvent !== false) push({ ts: Date.now(), turn: spec.turnId, k: 'turn' });
      for (const tool of step.toolItems ?? []) push({ ts: Date.now(), turn: spec.turnId, k: 'tool', tool });
      if (step.during) {
        try {
          await step.during(call);
        } catch (err) {
          call.duringError = err;
        }
      }
      if (step.hang) return;
      await sleep(step.delay ?? 2);
      finish(outcomeOf());
    }, 1);
    return {
      pid,
      events,
      conversationId,
      lastOutputAt: () => Date.now(),
      result,
      interrupt: () => signal('interrupt'),
      suspend: () => signal('suspend'),
      kill: () => signal('kill'),
    };
  };
  const mintConversation = async (provider) => {
    if (mintFailures.length > 0) return mintFailures.shift();
    minted++;
    if (provider === 'claude') return { ok: true, conversationId: `00000000-0000-4000-8000-${String(minted).padStart(12, '0')}` };
    if (provider === 'cursor') return { ok: true, conversationId: `chat-${minted}` };
    return { ok: true, conversationId: undefined };
  };
  return {
    scripts,
    calls,
    startTurn,
    mintConversation,
    mintFailures,
    script(member, ...steps) {
      scripts.set(member, [...(scripts.get(member) ?? []), ...steps]);
    },
    callsOf(member) {
      return calls.filter((c) => c.spec.member === member);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Fake worktrees (TeamWorktrees)
 * ------------------------------------------------------------------------- */

function makeWorktrees() {
  const wt = {
    calls: [],
    checkpointResult: { ok: true, value: { committed: false, skipped: [] } },
    checkResult: { ok: true, value: undefined },
    stash: '',
    async repository() {
      return { ok: true, value: { repoRoot: '/repo', commonDir: '/repo/.git', leadRel: '', repoHash: 'h1h1', dirtyFiles: 0 } };
    },
    // T11 E3: resolveBase(cwd, ref) — cwd is the lead's workspace / recorded lead checkout.
    async resolveBase(cwd, ref) {
      wt.calls.push(['resolveBase', cwd, ref]);
      return { ok: true, value: 'a'.repeat(40) };
    },
    async freeBytes() {
      return 100 * 1024 ** 3;
    },
    async populate(plan) {
      wt.calls.push(['populate', plan.path]);
      return { ok: true, value: { recovered: false, sparse: false, lfs: 'none' } };
    },
    async runSetup() {
      return { ok: true, value: undefined };
    },
    async check() {
      return wt.checkResult;
    },
    async restore() {
      return { ok: true, value: undefined };
    },
    // T11 E2: async, the base commit's .mcp.json copied to a host-owned outFile.
    projectMcpResult: { ok: true, value: undefined },
    async projectMcpFile(input) {
      wt.calls.push(['projectMcpFile', input]);
      return typeof wt.projectMcpResult === 'function' ? wt.projectMcpResult(input) : wt.projectMcpResult;
    },
    async writeVendorMcp(p, provider) {
      wt.calls.push(['writeVendorMcp', provider]);
      return provider === 'cursor' || provider === 'gemini' ? { ok: true, value: { file: `${p}/x`, tracked: false } } : { ok: true, value: undefined };
    },
    async removeVendorMcp(p, provider) {
      wt.calls.push(['removeVendorMcp', provider]);
      return { ok: true, value: undefined };
    },
    async restoreVendorMcp() {
      return { ok: true, value: false };
    },
    // T11 E5: checkpoint({…, branch}).
    async checkpoint(input) {
      wt.calls.push(['checkpoint', input.path, input.branch]);
      return typeof wt.checkpointResult === 'function' ? wt.checkpointResult(input) : wt.checkpointResult;
    },
    async readStash() {
      return { ok: true, value: wt.stash };
    },
    async facts() {
      return { ok: true, value: { headSha: 'b'.repeat(40), ahead: 1, filesChanged: 1, dirty: false, merged: false } };
    },
    async handoffFacts() {
      return { commits: 'abc123 work', uncommitted: '', diffStat: ' 1 file changed' };
    },
    overlapOf(touched) {
      const owners = new Map();
      for (const [m, paths] of Object.entries(touched)) for (const p of paths) owners.set(p, [...(owners.get(p) ?? []), m]);
      const shared = [...owners.entries()].filter(([, ms]) => ms.length > 1);
      if (shared.length === 0) return undefined;
      return { members: [...new Set(shared.flatMap(([, ms]) => ms))].sort(), paths: shared.map(([p]) => p) };
    },
  };
  return wt;
}

/* ------------------------------------------------------------------------- *
 * Fake host (TeamCoreHost)
 * ------------------------------------------------------------------------- */

function makeHost(over = {}) {
  const host = {
    platform: 'darwin',
    settingsValue: {
      teamMode: 'on',
      teamMaxMembers: 6,
      teamMaxRunningTurns: 4,
      teamTurnsPerMemberPerHour: 20,
      teamTurnsPerDay: 300,
      turnTimeoutMinutes: 45,
      teamCursorForce: 'off',
      teamAgySkipPermissions: 'off',
      permissionMode: 'bypassPermissions',
      cooldownMinutes: 30,
    },
    workers: [
      { name: 'acct1', configDir: '/acct1', model: 'opus' },
      { name: 'acct2', configDir: '/acct2', model: 'opus' },
    ],
    loggedOut: new Set(),
    exhausted: new Set(),
    sameLogin: new Map(),
    resets: new Map(),
    bookkeepingCalls: [],
    taskEvents: [],
    terminals: [],
    closedElsewhere: new Set(),
    alive: new Map(), // pid → startedAt
    ours: new Set(),
    signals: [],
    envMarker: undefined, // undefined → the search cannot run; else turnId → pids
    rss: undefined,
    settings() {
      return { ...host.settingsValue };
    },
    routing() {
      return {
        workers: host.workers,
        leadConfigDir: '/lead',
        sameLoginKey: (w) => host.sameLogin.get(w.name),
        providerCached: () => ({}),
        headroom: () => undefined,
        frontierGuardBlocks: false,
        storedCodexDefault: () => undefined,
        pick: async (candidates, named, attempted, model, mode) => {
          void model;
          void mode;
          if (named !== undefined) {
            const w = host.workers.find((x) => x.name === named);
            if (!w) return { ok: false, text: `No worker named "${named}" is registered.` };
            if (attempted.has(w.name)) return { ok: false, text: `Worker "${w.name}" already failed this task.` };
            if (host.loggedOut.has(w.name)) return { ok: false, text: `login expired/logged out — ${w.name}` };
            if (host.exhausted.has(w.name)) return { ok: false, text: `Worker "${w.name}" is quota-exhausted` };
            return { ok: true, worker: w, billableOverage: false };
          }
          const eligible = candidates.filter((w) => !attempted.has(w.name) && !host.loggedOut.has(w.name) && !host.exhausted.has(w.name));
          if (eligible.length === 0) {
            const lo = candidates.filter((w) => host.loggedOut.has(w.name)).map((w) => w.name);
            return { ok: false, text: lo.length > 0 ? `No eligible worker: login expired/logged out — ${lo.join(', ')}.` : 'No eligible worker: cooling down after quota errors.' };
          }
          return { ok: true, worker: eligible[0], billableOverage: false };
        },
      };
    },
    quotaResetAt(worker) {
      return host.resets.get(worker.name);
    },
    async codexModelLive() {
      return 'gpt-test';
    },
    async claudeLoginProbe() {
      return undefined;
    },
    bookkeeping(worker, names, outcome) {
      host.bookkeepingCalls.push({ worker: worker.name, names: [...names], outcome: outcome.outcome, turnId: outcome.turnId });
      return undefined;
    },
    taskLog: {
      append(e) {
        host.taskEvents.push(e);
      },
      appendTerminal(e) {
        host.terminals.push(e);
        return { closed: !host.closedElsewhere.has(e.id) };
      },
      writePrompt(id) {
        return `/tasks/${id}.prompt.txt`;
      },
      writeOutput() {
        return true;
      },
    },
    process: {
      isAlive: (pid) => host.alive.has(pid),
      startedAt: (pid) => host.alive.get(pid),
      isOurWorker: (pid) => host.ours.has(pid),
      signalGroup: (pgid, sig) => {
        host.signals.push([pgid, sig]);
        if (sig === 'SIGTERM' || sig === 'SIGKILL') host.alive.delete(pgid);
      },
      findByEnvMarker: async (turnId) => (host.envMarker === undefined ? undefined : (host.envMarker.get(turnId) ?? [])),
      rssByGroup: async () => host.rss,
    },
    claudeTakeover() {
      return { command: '/bin/claude', env: { CLAUDE_CONFIG_DIR: '/acct1', CLAUDECODE: null } };
    },
    ...over,
  };
  return host;
}

const TUNING = {
  earlyCrashRetryMs: 40,
  resetMarginMs: 10,
  idleWakeMs: 3,
  endDrainMs: 400,
  rssTickMs: 25,
  silenceNoticeMs: 10 * 60_000,
  attachStartGraceMs: 300,
  attachWatchMs: 15,
  storeRetryMs: 30,
  feedCoalesceMs: 5,
  codexModelLookupMs: 200,
  mintTimeoutMs: 1_000,
  sweepTermWaitMs: 30,
  sweepWaitMs: 300,
};

function makeWorld(over = {}) {
  const host = makeHost(over.host);
  const stores = new FakeStores(host);
  const worktrees = makeWorktrees();
  const logs = [];
  let storeRef;
  const driver = makeDriver({ isPlanned: (turnId) => (storeRef?.() ?? []).some((e) => e.type === 'turn.planned' && e.turnId === turnId) });
  const runtime = {
    dataRoot: DATA,
    workspace: '/repo',
    host: { pid: process.pid, startedAt: 1 },
    session: { pid: 1, startedAt: 1 },
    socket: '/tmp/cco-test.sock',
    nodePath: process.execPath,
    cliJsPath: path.join(DATA, 'mcp', 'cli.js'),
    log: (line) => logs.push(line),
  };
  const core = createTeamCoreWith(runtime, {
    stores,
    startTurn: driver.startTurn,
    mintConversation: driver.mintConversation,
    worktrees,
    host,
    tuning: { ...TUNING, ...(over.tuning ?? {}) },
  });
  const world = {
    host,
    stores,
    worktrees,
    driver,
    core,
    logs,
    runtime,
    /** A second host process of the same workspace: a new core over the same stores, driver, worktrees and host. */
    another() {
      return createTeamCoreWith(runtime, { stores, startTurn: driver.startTurn, mintConversation: driver.mintConversation, worktrees, host, tuning: { ...TUNING, ...(over.tuning ?? {}) } });
    },
    get store() {
      return stores.created[stores.created.length - 1] ?? [...stores.map.values()][0];
    },
    ev(type) {
      return world.store ? world.store.ofType(type) : [];
    },
    memberEvents(type, name) {
      return world.ev(type).filter((e) => e.name === name);
    },
    stateOf(name) {
      const s = world.memberEvents('member.state', name);
      return s.length > 0 ? s[s.length - 1].state : undefined;
    },
    notices(pred = () => true) {
      return world.ev('msg.posted').filter((m) => m.kind === 'notice' && pred(m));
    },
    textOf(m) {
      return typeof m.body === 'string' ? m.body : world.store.fileMap.get(m.bodyFile);
    },
  };
  storeRef = () => world.store?.events;
  return world;
}

function member(name, extra = {}) {
  return { name, role: `${name} role`, brief: `Do the ${name} work.`, ...extra };
}

async function createTeam(w, file) {
  const r = await w.core.create({ name: 'web', goal: 'Build the thing.', members: [member('alice')], ...file }, 'lead');
  return r;
}

async function idle(w, name, timeoutMs = 3000) {
  return waitFor(() => {
    const rt = w.driver.callsOf(name);
    const state = w.stateOf(name);
    return state === 'idle' && w.core.ownsTurn(rt[rt.length - 1]?.spec.turnId ?? '') === false;
  }, { timeoutMs });
}

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

/* ------------------------------------------------------------------------- *
 * Scenarios
 * ------------------------------------------------------------------------- */

scenario('create: events, files, bring-up, first turn write-before-spawn, delivery, report, task log (§7.3, §3.4, I13)', async () => {
  const w = makeWorld();
  const r = await createTeam(w, {
    members: [member('alice'), member('bob', { provider: 'claude' })],
    tasks: [{ title: 'API', assignee: 'alice', paths: ['src/api/'] }],
  });
  check('create: ok, outcome created', r.ok && r.value.outcome === 'created', r);
  const types = w.store.events.map((e) => e.type);
  check('create: first batch in contract order', types[0] === 'team.created' && types[1] === 'lease.acquired' && types.includes('member.added') && types.includes('member.routed') && types.includes('board.created'), types);
  const assignment = w.ev('msg.posted').find((m) => m.kind === 'assignment');
  check('create: an assignee posts an assignment message', assignment !== undefined && assignment.to === 'alice' && assignment.task === 'b1', assignment);
  const fm = w.store.fileMap;
  check('create: credential, tool spec, mcp.json, brief, assignment written', ['credential', 'tool-spec.json', 'mcp.json', 'brief.md', 'assignment.md'].every((f) => fm.has(`members/alice/${f}`)), [...fm.keys()]);
  check('create: credential is 64 hex', /^[0-9a-f]{64}\n$/.test(fm.get('members/alice/credential') ?? ''));
  const spec = JSON.parse(fm.get('members/alice/tool-spec.json') ?? '{}');
  check('create: tool spec names the socket and member, never a secret', spec.member === 'alice' && spec.socket === '/tmp/cco-test.sock' && typeof spec.credentialFile === 'string' && !('credential' in spec), spec);
  check('create: routed apart (spread) acct1 / acct2', w.ev('member.routed').map((e) => e.worker).sort().join(',') === 'acct1,acct2', w.ev('member.routed'));
  const ok = await waitFor(() => w.ev('turn.ended').length >= 2, { timeoutMs: 3000 });
  check('bring-up: planned → ready → idle → first turns', ok && w.ev('member.worktree.planned').length === 2 && w.ev('member.worktree').length === 2, w.store.events.map((e) => e.type));
  const calls = w.driver.calls;
  check('turn: turn.planned durable BEFORE the spawn (write-before-spawn)', calls.length >= 2 && calls.every((c) => c.plannedBeforeSpawn === true), calls.map((c) => c.plannedBeforeSpawn));
  const alice = w.driver.callsOf('alice')[0];
  check('turn: first turn trigger brief, kind first, Claude expected id = minted', w.ev('turn.planned').find((e) => e.name === 'alice')?.trigger === 'brief' && alice.spec.kind === 'first' && /^0{8}-/.test(alice.spec.expectedConversationId ?? ''), alice.spec);
  check('turn: member.conversation durable before the Claude first turn', w.memberEvents('member.conversation', 'alice').length === 1);
  check('turn: env/markers come from the driver; spec carries mcp + brief + cwd root', alice.spec.mcp?.name === 'cco_team' && alice.spec.briefFile.endsWith('brief.md') && alice.spec.cwd.includes('worktrees'), alice.spec);
  check('turn: prompt carries the assignment in a fence and the kickoff', /<<<cco-msg [0-9a-f]{12} m\d+ · from lead · assignment · task b1/.test(alice.spec.prompt) && alice.spec.prompt.includes('Begin: call team_board'), alice.spec.prompt);
  const delivered = w.ev('msg.delivered');
  check('H3: the assignment is delivered at turn.ended (sawAssistant)', delivered.some((d) => d.msg === `m${assignment.seq}` && d.via === 'turn'), delivered);
  const reports = w.ev('msg.posted').filter((m) => m.kind === 'report');
  check('report: every ok turn posts a report to the lead with its meta', reports.length >= 2 && reports.every((m) => m.to === 'lead' && m.report?.outcome === 'ok'), reports);
  const running = w.host.taskEvents.filter((e) => e.status === 'running' && e.member === 'alice');
  check('task log: running event with team fields, then one with pid', running.length >= 2 && running[0].team === w.store.teamId && running[0].turn === 1 && running.some((e) => typeof e.pid === 'number'), running);
  check('task log: terminal done with tokens', w.host.terminals.some((e) => e.member === 'alice' && e.status === 'done' && e.inputTokens === 1000));
  check('bookkeeping: recorded for every turn (ok)', w.host.bookkeepingCalls.filter((b) => b.outcome === 'ok').length >= 2, w.host.bookkeepingCalls);
  check('ownsTurn: false once the turn has ended', w.core.ownsTurn(alice.spec.turnId) === false);
  check('team(): projection with the overlay (runsCommands for bypassPermissions)', w.core.team()?.members.find((m) => m.name === 'alice')?.runsCommands === true, w.core.team()?.members);
});

scenario('create refusals: value checks aggregated, nothing created; mode off; win32; idempotent create (§7.3, P68, P85, P86)', async () => {
  const w = makeWorld();
  const r = await w.core.create({ name: 'Bad Name', goal: '', members: [member('lead'), member('x y'), member('ok', { paths: ['../up'] })] }, 'lead');
  check('values: refused invalid_values', !r.ok && r.code === 'invalid_values', r);
  check('values: names the reserved name, the shape, the path, the goal', !r.ok && r.sentence.includes('reserved') && r.sentence.includes('"x y"') && r.sentence.includes('..') && r.sentence.includes('goal') && r.sentence.endsWith('Nothing was created.'), r.sentence);
  check('values: nothing was created', w.stores.created.length === 0);
  w.host.settingsValue.teamMaxMembers = 1;
  const r2 = await w.core.create({ name: 'web', goal: 'g', members: [member('a'), member('b')] }, 'lead');
  check('values: too many members', !r2.ok && r2.sentence.includes('at most 1 members'), r2);
  w.host.settingsValue.teamMaxMembers = 6;
  w.host.settingsValue.teamMode = 'off';
  const r3 = await createTeam(w, {});
  check('mode off: team_mode_off', !r3.ok && r3.code === 'team_mode_off', r3);
  w.host.settingsValue.teamMode = 'on';
  const w32 = makeWorld({ host: { platform: 'win32' } });
  const r4 = await createTeam(w32, {});
  check('win32: unsupported_platform', !r4.ok && r4.code === 'unsupported_platform', r4);
  const r5 = await createTeam(w, {});
  const r6 = await createTeam(w, { members: [member('alice'), member('zed')] });
  check('idempotent: same name again → exists, missing names listed, one team', r5.ok && r6.ok && r6.value.outcome === 'exists' && r6.value.missing?.join(',') === 'zed' && w.stores.created.length === 1, r6);
  const r7 = await w.core.create({ name: 'other', goal: 'g', members: [member('a')] }, 'lead');
  check('one active team per host: already_leading', !r7.ok && r7.code === 'already_leading', r7);
});

scenario('crash retry: one retry after an early crash, then blocked crash (P6, MD-59)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'crashed', sawEvent: false, stderrTail: 'boom 1' }, { outcome: 'ok' });
  await createTeam(w, {});
  const ok = await waitFor(() => w.ev('turn.ended').some((e) => e.outcome === 'ok'), { timeoutMs: 3000 });
  const planned = w.memberEvents('turn.planned', 'alice');
  check('crash retry: the early crash is retried (two turns, the second ok)', ok && planned.length === 2, w.ev('turn.ended'));
  check('crash retry: the retry still carries the brief trigger', planned[1]?.trigger === 'brief', planned);
  check('crash retry: the retry waited the retry delay', planned.length === 2 && planned[1].ts - w.ev('turn.ended')[0].ts >= 30, planned.map((p) => p.ts));
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'crashed', sawEvent: false, stderrTail: 'boom A' }, { outcome: 'crashed', sawEvent: false, stderrTail: 'boom B' });
  await createTeam(w2, {});
  const blocked = await waitFor(() => w2.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  const reason = w2.memberEvents('member.state', 'alice').at(-1)?.reason;
  check('crash retry: a second early crash → blocked crash with the stderr tail', blocked && reason?.code === 'crash' && reason.text.includes('boom B'), reason);
  await sleep(100);
  check('crash retry: nothing retries after blocked', w2.memberEvents('turn.planned', 'alice').length === 2);
  const w3 = makeWorld();
  w3.driver.script('alice', { outcome: 'crashed', sawEvent: true, sawAssistant: true });
  await createTeam(w3, {});
  await waitFor(() => w3.ev('turn.ended').length === 1);
  await sleep(120);
  check('crash after an event: idle + notice, never re-run', w3.stateOf('alice') === 'idle' && w3.memberEvents('turn.planned', 'alice').length === 1 && w3.notices((m) => w3.textOf(m).includes('ended unexpectedly')).length === 1);
});

scenario('quota/auth with and without a same-provider alternative; no cross-provider move (P43, P45, P47, P52, S1-5, M3)', async () => {
  // with an alternative: acct1 hits quota → acct2, packet turn, re-sent bundle
  const w = makeWorld();
  w.host.workers = [
    { name: 'acct1', configDir: '/acct1', model: 'opus' },
    { name: 'acct1b', configDir: '/acct1b', model: 'opus' },
    { name: 'acct2', configDir: '/acct2', model: 'opus' },
  ];
  w.host.sameLogin.set('acct1', 'L1');
  w.host.sameLogin.set('acct1b', 'L1');
  w.driver.script('alice', { outcome: 'quota', sawEvent: true, sawAssistant: false, note: '5-hour limit reached' }, { outcome: 'ok' });
  await createTeam(w, { members: [member('alice', { worker: 'acct1' })], tasks: [{ title: 'T', assignee: 'alice' }] });
  const ok = await waitFor(() => w.ev('turn.ended').some((e) => e.outcome === 'ok'), { timeoutMs: 3000 });
  const routed = w.memberEvents('member.routed', 'alice');
  check('quota+alt: new incarnation cause failover on acct2 (never the same-login acct1b)', ok && routed.length === 2 && routed[1].cause === 'failover' && routed[1].worker === 'acct2' && routed[1].incarnation === 2, routed);
  const bk = w.host.bookkeepingCalls.find((b) => b.outcome === 'quota');
  check('quota+alt: bookkeeping files the cooldown for every name of the identity (M3)', bk !== undefined && bk.names.includes('acct1') && bk.names.includes('acct1b') && !bk.names.includes('acct2'), bk);
  const second = w.memberEvents('turn.planned', 'alice')[1];
  check('quota+alt: the packet turn starts at once (trigger packet)', second?.trigger === 'packet', second);
  const prompt = w.driver.callsOf('alice')[1]?.spec.prompt ?? '';
  check('H3: the undelivered assignment is re-sent labelled in the packet turn', second?.resent.length === 1 && prompt.includes('re-sent: the previous attempt failed before you saw it') && prompt.includes('hand-off'), prompt);
  check('quota+alt: availability notice to lead and user', w.notices((m) => w.textOf(m).includes('continues on claude/acct2')).length === 2);
  check('quota+alt: the new incarnation gets a new conversation (first turn, new minted id)', w.driver.callsOf('alice')[1]?.spec.kind === 'first' && w.driver.callsOf('alice')[1].spec.expectedConversationId !== w.driver.callsOf('alice')[0].spec.expectedConversationId);

  // without an alternative: blocked quota with the earliest reset, a retry timer
  const w2 = makeWorld();
  w2.host.workers = [{ name: 'acct1', configDir: '/acct1', model: 'opus' }];
  w2.host.resets.set('acct1', { until: Date.now() + 3 * 3_600_000, window: '5-hour' });
  w2.driver.script('alice', { outcome: 'quota', sawEvent: true, sawAssistant: false });
  await createTeam(w2, {});
  const blocked = await waitFor(() => w2.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  const reason = w2.memberEvents('member.state', 'alice').at(-1)?.reason;
  check('quota, no alt: blocked quota with until', blocked && reason?.code === 'quota' && typeof reason.until === 'number', reason);
  check('quota, no alt: notice names the earliest reset', w2.notices((m) => w2.textOf(m).includes('out of quota')).length >= 1);

  // reset within 15 min: paused quota-wait, then the SAME incarnation continues
  const w3 = makeWorld();
  w3.host.workers = [{ name: 'acct1', configDir: '/acct1', model: 'opus' }];
  w3.host.resets.set('acct1', { until: Date.now() + 80, window: '5-hour' });
  w3.driver.script('alice', { outcome: 'quota', sawEvent: true, sawAssistant: true }, { outcome: 'ok' });
  await createTeam(w3, {});
  const paused = await waitFor(() => w3.memberEvents('member.state', 'alice').some((e) => e.state === 'paused' && e.reason?.code === 'quota-wait'), { timeoutMs: 3000 });
  check('quota wait: paused quota-wait', paused);
  const cont = await waitFor(() => w3.memberEvents('turn.planned', 'alice').length === 2, { timeoutMs: 3000 });
  const p2 = w3.memberEvents('turn.planned', 'alice')[1];
  check('quota wait: continues after the reset (trigger continue, same incarnation)', cont && p2.trigger === 'continue' && p2.incarnation === 1 && w3.memberEvents('member.routed', 'alice').length === 1, p2);

  // auth, no alternative → blocked login; no cross-provider move to an available codex worker
  const w4 = makeWorld();
  w4.host.workers = [
    { name: 'acct1', configDir: '/acct1', model: 'opus' },
    { name: 'cx', configDir: '/cx', model: 'gpt-x', provider: 'codex' },
  ];
  w4.driver.script('alice', { outcome: 'auth', sawEvent: true, sawAssistant: false, note: 'Not logged in' });
  await createTeam(w4, { members: [member('alice', { provider: 'claude' })] });
  const b4 = await waitFor(() => w4.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  check('auth, no alt: blocked (login/quota class), never moved to codex', b4 && !w4.ev('member.routed').some((e) => e.provider === 'codex'), w4.memberEvents('member.state', 'alice').at(-1));
  check('auth: bookkeeping outcome auth', w4.host.bookkeepingCalls.some((b) => b.outcome === 'auth'));

  // auth with an alternative → failover
  const w5 = makeWorld();
  w5.driver.script('alice', { outcome: 'auth', sawEvent: true, sawAssistant: false }, { outcome: 'ok' });
  await createTeam(w5, { members: [member('alice', { worker: 'acct1' })] });
  const f5 = await waitFor(() => w5.memberEvents('member.routed', 'alice').length === 2, { timeoutMs: 3000 });
  check('auth+alt: failover within claude', f5 && w5.memberEvents('member.routed', 'alice')[1].worker === 'acct2');
});

scenario('interrupt ladder: urgent interrupts a running turn, the next turn leads with it; the 120 s window (MD-23, §4.3)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { hang: true, sawAssistantBeforeKill: true }, { outcome: 'ok' });
  await createTeam(w, {});
  await waitFor(() => w.core.team()?.members.find((m) => m.name === 'alice')?.state === 'running', { timeoutMs: 2000 });
  const turnId = w.driver.callsOf('alice')[0].spec.turnId;
  check('ownsTurn: true while running', w.core.ownsTurn(turnId));
  const r = await w.core.send({ to: 'alice', text: 'Stop and switch to the cursor API now, please.', urgent: true }, 'lead');
  check('urgent: answer says interrupts', r.ok && r.value.recipients[0].delivery === 'interrupts', r);
  check('urgent: the NORMAL ladder (interrupt) was started on the handle', w.driver.callsOf('alice')[0].signals[0] === 'interrupt', w.driver.callsOf('alice')[0].signals);
  const next = await waitFor(() => w.memberEvents('turn.planned', 'alice').length === 2, { timeoutMs: 3000 });
  const ended = w.ev('turn.ended')[0];
  check('urgent: turn.ended interrupted reason urgent', ended?.outcome === 'interrupted' && ended.reason === 'urgent', ended);
  const p2 = w.memberEvents('turn.planned', 'alice')[1];
  const prompt = w.driver.callsOf('alice')[1]?.spec.prompt ?? '';
  check('urgent: next turn trigger urgent, the urgent message first, recap', next && p2.trigger === 'urgent' && p2.deliver[0] === seqOf(r.value.msgId) && prompt.includes('was interrupted so that the urgent message below reaches you now'), { p2, prompt });
  await waitFor(() => w.ev('turn.ended').length === 2);
  check('urgent: delivered via interrupt at that turn’s end', w.ev('msg.delivered').some((d) => d.msg === r.value.msgId && d.via === 'interrupt'));
  w.driver.script('alice', { hang: true });
  await w.core.send({ to: 'alice', text: 'next piece of work please, a sentence long enough' }, 'lead');
  await waitFor(() => w.core.team()?.members.find((m) => m.name === 'alice')?.state === 'running', { timeoutMs: 2000 });
  const r2 = await w.core.send({ to: 'alice', text: 'another urgent one right away within the window', urgent: true }, 'lead');
  check('urgent: a second urgent inside 120 s is queued, not refused', r2.ok && r2.value.recipients[0].delivery === 'urgent-queued', r2);
  await w.core.end(true, 'lead');
});

scenario('pause --now, cco cancel, external cancel (M8, P111), unpause (M20)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { hang: true });
  await createTeam(w, {});
  await waitFor(() => w.core.team()?.members.find((m) => m.name === 'alice')?.state === 'running', { timeoutMs: 2000 });
  const r = await w.core.member({ member: 'alice', op: 'pause', now: true }, 'lead');
  check('pause --now: the ladder, then paused', r.ok && w.stateOf('alice') === 'paused' && w.ev('turn.ended')[0]?.reason === 'pause', { r, ended: w.ev('turn.ended') });
  const u = await w.core.member({ member: 'alice', op: 'unpause' }, 'lead');
  check('unpause: idle again', u.ok && w.stateOf('alice') === 'idle', u);
  w.driver.script('alice', { hang: true });
  await w.core.send({ to: 'alice', text: 'please continue with the next step of the work' }, 'lead');
  await waitFor(() => w.core.team()?.members.find((m) => m.name === 'alice')?.state === 'running', { timeoutMs: 2000 });
  const turnId = w.driver.callsOf('alice').at(-1).spec.turnId;
  const line = await w.core.cancelTurn(turnId);
  check('cco cancel: the §15.5 row', line === C.TEAM_TEXT.cancelTeamTurn(turnId, 'alice'), line);
  await waitFor(() => w.stateOf('alice') === 'paused');
  const reason = w.memberEvents('member.state', 'alice').at(-1)?.reason;
  check('cco cancel: paused, reason cancelled (stopped by cco cancel), turn interrupted reason cancel', reason?.code === 'cancelled' && reason.text === 'stopped by cco cancel' && w.ev('turn.ended').at(-1).reason === 'cancel', reason);
  // external: a signal the engine did not send
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'cancelled', signalledBy: 'other', sawEvent: true, sawAssistant: true });
  await createTeam(w2, {});
  await waitFor(() => w2.stateOf('alice') === 'paused', { timeoutMs: 3000 });
  await sleep(120);
  check('external cancel: paused cancelled, notice, never retried', w2.memberEvents('member.state', 'alice').at(-1)?.reason?.code === 'cancelled' && w2.memberEvents('turn.planned', 'alice').length === 1 && w2.notices((m) => w2.textOf(m).includes('stopped from outside the team engine')).length === 1);
  // a task-log close by another hand also reads cancelled
  const w3 = makeWorld();
  w3.driver.script('alice', { outcome: 'error', delay: 30 });
  await createTeam(w3, {});
  await waitFor(() => w3.driver.callsOf('alice').length === 1);
  w3.host.closedElsewhere.add(w3.driver.callsOf('alice')[0].spec.turnId);
  await waitFor(() => w3.ev('turn.ended').length === 1);
  check('external task-log close: the outcome is cancelled', w3.ev('turn.ended')[0].outcome === 'cancelled', w3.ev('turn.ended')[0]);
});

scenario('wake budget and the ping-pong breaker (P30, §3.5.1)', async () => {
  const w = makeWorld();
  let k = 0;
  const pingTo = (to) => ({
    during: async (call) => {
      k++;
      await w.core.memberTool(call.spec.member, 'team_send', { to, text: `round ${k}: here is my next thought about the shared design, please consider it` });
    },
  });
  for (let i = 0; i < 30; i++) {
    w.driver.script('a', pingTo('b'));
    w.driver.script('b', pingTo('a'));
  }
  await createTeam(w, { members: [member('a', { start: false }), member('b', { start: false })] });
  await waitFor(() => w.stateOf('a') === 'idle' && w.stateOf('b') === 'idle');
  await w.core.send({ to: 'a', text: 'Start the discussion with b about the design, please.' }, 'lead');
  const tripped = await waitFor(() => w.ev('budget.tripped').some((e) => e.kind === 'pingpong' || e.kind === 'peer-wakes'), { timeoutMs: 5000 });
  await sleep(200);
  const turns = w.ev('turn.planned').length;
  check('loop: a breaker trips', tripped, w.ev('budget.tripped'));
  check('loop: turns are bounded (no endless ping-pong)', turns <= 16, turns);
  const pp = w.ev('budget.tripped').find((e) => e.kind === 'pingpong');
  check('ping-pong: budget.tripped pingpong after 12 member→member messages, notice to lead and user', pp !== undefined && w.notices((m) => w.textOf(m).includes('without a message from you or the user')).length === 2, w.ev('budget.tripped'));
  const before = w.ev('turn.planned').length;
  await w.core.send({ to: 'b', text: 'Lead here: b, please finish the design now and report.' }, 'lead');
  const resumed = await waitFor(() => w.ev('turn.planned').length > before, { timeoutMs: 2000 });
  check('loop: a lead message wakes the member again (breaker reset)', resumed);
  // peer-wake budget alone (no ping-pong): b woken by a 6 times
  const w2 = makeWorld();
  for (let i = 0; i < 12; i++) {
    w2.driver.script('a', {
      during: async (call) => {
        await w2.core.memberTool(call.spec.member, 'team_send', { to: 'b', text: `peer note number ${i} — a sentence that is long enough to count` });
      },
    });
  }
  await createTeam(w2, { members: [member('a', { start: false }), member('b', { start: false })] });
  await waitFor(() => w2.stateOf('a') === 'idle' && w2.stateOf('b') === 'idle');
  for (let i = 0; i < 9; i++) {
    await w2.core.send({ to: 'a', text: `lead asks a for piece ${i} of the work, please send b a note` }, 'lead');
    await waitFor(() => w2.memberEvents('turn.planned', 'a').length > i && w2.stateOf('a') === 'idle' && !w2.core.ownsTurn(w2.driver.callsOf('a').at(-1)?.spec.turnId ?? ''), { timeoutMs: 2000 });
    await waitFor(() => !w2.core.ownsTurn(w2.driver.callsOf('b').at(-1)?.spec.turnId ?? ''), { timeoutMs: 2000 });
    await sleep(20);
  }
  const bTurns = w2.memberEvents('turn.planned', 'b').length;
  check('peer wakes: b is woken by peers at most PEER_WAKE_BUDGET times', bTurns <= C.PEER_WAKE_BUDGET, bTurns);
  check('peer wakes: one notice to the lead', w2.notices((m) => w2.textOf(m).includes('woken')).length === 1, w2.notices().map((m) => w2.textOf(m)));
});

scenario('rate limits and duplicates (P31, P33, L4, MD-18/19)', async () => {
  const w = makeWorld();
  const answers = [];
  w.driver.script('alice', {
    during: async (call) => {
      for (let i = 0; i < 21; i++) {
        answers.push(await w.core.memberTool('alice', 'team_send', { to: 'lead', text: `status ${i}: a message that is long enough to not be exempt from dupes` }));
      }
      answers.push(await w.core.memberTool('alice', 'team_send', { to: 'lead', text: 'x' }));
      void call;
    },
  });
  await createTeam(w, {});
  await waitFor(() => answers.length === 22, { timeoutMs: 3000 });
  check('member: 20 sends per turn, the 21st rate_limited', answers.slice(0, 20).every((a) => !a.isError) && answers[20].isError && answers[20].content[0].text.startsWith('rate_limited:'), answers.map((a) => a.content[0].text.slice(0, 40)));
  const w2 = makeWorld();
  const dup = [];
  w2.driver.script('alice', {
    during: async () => {
      const text = 'the very same message body that is longer than sixty-four bytes, twice';
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'lead', text }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'lead', text }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'lead', text: 'short' }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'lead', text: 'short' }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'all', text: 'hello all' }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'alice', text: 'hello me' }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'nobody', text: 'hello?' }));
      dup.push(await w2.core.memberTool('alice', 'team_send', { to: 'lead', text: 'x', extra: 'y' }));
    },
  });
  await createTeam(w2, {});
  await waitFor(() => dup.length === 8, { timeoutMs: 3000 });
  const t = dup.map((a) => a.content[0].text);
  check('member duplicate: refused naming the earlier id', dup[1].isError && /^duplicate: .*m\d+/.test(t[1]), t[1]);
  check('member duplicate: bodies under 64 bytes are exempt', !dup[2].isError && !dup[3].isError, t.slice(2, 4));
  check('member: all / self / unknown refused', t[4].startsWith('not_allowed:') && t[5].startsWith('not_allowed:') && t[6].startsWith('unknown_recipient:'), t.slice(4, 7));
  check('member: an unknown argument key is invalid_arguments', t[7].startsWith('invalid_arguments:'), t[7]);
  const w3 = makeWorld();
  await createTeam(w3, { members: [member('alice', { start: false }), member('bob', { start: false })] });
  await w3.core.member({ member: 'alice', op: 'pause' }, 'lead');
  await w3.core.member({ member: 'bob', op: 'pause' }, 'lead');
  const long = 'a lead message that is certainly longer than sixty-four bytes in total';
  const a1 = await w3.core.send({ to: 'alice', text: long }, 'lead');
  const a2 = await w3.core.send({ to: 'alice', text: long }, 'lead');
  check('lead duplicate within 60 s: refused', a1.ok && !a2.ok && a2.code === 'duplicate', a2);
  let limited;
  for (let i = 0; i < 125; i++) {
    const r = await w3.core.send({ to: i % 2 === 0 ? 'alice' : 'bob', text: `note ${i}` }, 'lead');
    if (!r.ok) {
      limited = { i, r };
      break;
    }
  }
  check('lead: 120 per 10 minutes, then rate_limited with retry after', limited !== undefined && limited.i === 119 && limited.r.code === 'rate_limited' && /retry after \d+ s/.test(limited.r.sentence), limited);
  const toUser = await w3.core.send({ to: 'user', text: 'hello user' }, 'lead');
  check('lead → user refused with the sentence (P69)', !toUser.ok && toUser.sentence === C.TEAM_TEXT.leadToUser(), toUser);
  const urgentAll = await w3.core.send({ to: 'all', text: 'everyone stop', urgent: true }, 'lead');
  check('urgent to all refused (P35)', !urgentAll.ok && urgentAll.sentence === C.TEAM_TEXT.urgentToAll());
  const big = await w3.core.send({ to: 'alice', text: 'x'.repeat(65_537) }, 'lead');
  const nul = await w3.core.send({ to: 'alice', text: 'a\u0000b' }, 'lead');
  check('hostile text: oversize and NUL refused (P88)', !big.ok && big.code === 'message_too_large' && !nul.ok && nul.code === 'invalid_text', [big, nul]);
});

scenario('suspend within budget (P1, H2)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { hang: true });
  w.driver.script('bob', { hang: true, ignoreSignals: true });
  await createTeam(w, { members: [member('alice'), member('bob')] });
  await waitFor(() => w.driver.calls.filter((c) => c.spawned).length === 2, { timeoutMs: 2000 });
  const t0 = Date.now();
  await w.core.suspendAll(500);
  const elapsed = Date.now() - t0;
  check('suspend: resolves within its budget even with a turn that ignores signals', elapsed < 800, elapsed);
  check('suspend: the SUSPEND ladder on every running turn', w.driver.calls.every((c) => c.signals.includes('suspend')), w.driver.calls.map((c) => c.signals));
  const ended = w.ev('turn.ended').find((e) => e.reason === 'lead-ended');
  check('suspend: turn.ended interrupted reason lead-ended', ended !== undefined && ended.outcome === 'interrupted', w.ev('turn.ended'));
  const status = w.ev('team.status').at(-1);
  check('suspend: team.status suspended, lease released', status?.status === 'suspended' && w.ev('lease.released').length === 1 && !w.store.owned(), w.ev('team.status'));
  check('suspend: the core leads no team afterwards; waiters refused', w.core.team() === undefined);
  const r = await createTeam(w, { name: 'again' });
  check('suspend: no new team on a suspending host', !r.ok && r.code === 'suspending', r);
  const t1 = Date.now();
  await w.core.suspendAll(30_000);
  check('suspend: idempotent', Date.now() - t1 < 50);
});

scenario('orphan sweep: fenced kill, failing fence, planned-without-running; team_resume (P2, P3, M7, S1-6, L10)', async () => {
  const w = makeWorld();
  const header = { v: 1, id: C.newTeamId(Date.now() - 10_000), name: 'old', title: 'old', workspace: '/repo', repoRoot: '/repo', commonDir: '/repo/.git', createdAt: Date.now() - 10_000 };
  let seq = 0;
  const e = (by, body) => ({ v: 1, seq: ++seq, ts: Date.now() - 5000, by, ...body });
  const wt = (name) => `/data/worktrees/h1h1/old-x/${name}`;
  const events = [
    e('lead', { type: 'team.created', name: 'old', title: 'old', workspace: '/repo', repoRoot: '/repo', commonDir: '/repo/.git', baseCommit: 'a'.repeat(40), leadRel: '', goal: { bytes: 4, text: 'goal' } }),
    e('engine', { type: 'lease.acquired', hostPid: 999_001, hostStartedAt: 5, session: { pid: 999_002, startedAt: 5 } }),
  ];
  for (const [i, name] of ['ann', 'ben', 'cat'].entries()) {
    events.push(e('lead', { type: 'member.added', name, index: i + 1, role: 'r', briefBytes: 1, spec: { paths: [] } }));
    events.push(e('engine', { type: 'member.routed', name, incarnation: 1, provider: 'claude', worker: 'acct1', accountKey: '/acct1', model: 'opus', modelSource: 'worker', reason: 'r', cause: 'initial' }));
    events.push(e('engine', { type: 'member.worktree', name, path: wt(name), branch: `cco/old-x/${name}`, baseCommit: 'a'.repeat(40), cwd: wt(name) }));
    events.push(e('engine', { type: 'member.conversation', name, incarnation: 1, conversationId: `00000000-0000-4000-8000-00000000000${i}` }));
  }
  for (const name of ['ann', 'ben', 'cat']) {
    events.push(e('engine', { type: 'turn.planned', turnId: `t${name}0`, name, n: 1, incarnation: 1, trigger: 'brief', deliver: [], resent: [], promptBytes: 10 }));
    events.push(e('engine', { type: 'turn.ended', turnId: `t${name}0`, outcome: 'ok', exitCode: 0, signal: null, durationMs: 5, tokens: { in: 1, out: 1 }, text: 'ok', textFile: '/x', sawAssistant: true, conversationIdSeen: 'c' }));
    events.push(e('engine', { type: 'member.state', name, state: 'idle' }));
  }
  events.push(e('engine', { type: 'turn.planned', turnId: 'tann1', name: 'ann', n: 2, incarnation: 1, trigger: 'message', deliver: [], resent: [], promptBytes: 10 }));
  events.push(e('engine', { type: 'turn.running', turnId: 'tann1', pid: 4242, pgid: 4242, startedAt: 111 }));
  events.push(e('engine', { type: 'member.state', name: 'ann', state: 'running' }));
  events.push(e('engine', { type: 'turn.planned', turnId: 'tben1', name: 'ben', n: 2, incarnation: 1, trigger: 'brief', deliver: [], resent: [], promptBytes: 10 }));
  events.push(e('engine', { type: 'turn.running', turnId: 'tben1', pid: 4343, pgid: 4343, startedAt: 222 }));
  events.push(e('engine', { type: 'member.state', name: 'ben', state: 'running' }));
  events.push(e('engine', { type: 'turn.planned', turnId: 'tcat1', name: 'cat', n: 2, incarnation: 1, trigger: 'brief', deliver: [], resent: [], promptBytes: 10 }));
  const store = new FakeStore(w.stores, header, events, { lease: { v: 1, hostPid: 999_001, hostStartedAt: 5, session: { pid: 999_002, startedAt: 5 }, socket: '/s', acquiredAt: 1 } });
  w.stores.map.set(header.id, store);
  w.host.alive.set(4242, 111);
  w.host.ours.add(4242);
  w.host.alive.set(4343, 222); // alive but NOT ours (pid reused)
  w.host.envMarker = undefined; // the search cannot run
  await w.core.sweep();
  const ended = store.ofType('turn.ended');
  const ann = ended.find((x) => x.turnId === 'tann1');
  const ben = ended.find((x) => x.turnId === 'tben1');
  check('sweep: a fenced orphan gets the ladder from SIGTERM → interrupted engine-restart', ann?.outcome === 'interrupted' && ann.reason === 'engine-restart' && w.host.signals.some(([pg, s]) => pg === 4242 && s === 'SIGTERM'), { ann, signals: w.host.signals });
  check('sweep: an unprovable pid is never signalled → crashed', ben?.outcome === 'crashed' && !w.host.signals.some(([pg]) => pg === 4343), { ben, signals: w.host.signals });
  const cat = store.ofType('member.state').filter((x) => x.name === 'cat').at(-1);
  check('sweep: planned-without-running and no search → blocked unknown-turn with until', cat?.state === 'blocked' && cat.reason?.code === 'unknown-turn' && typeof cat.reason.until === 'number', cat);
  check('sweep: team.status suspended, lease released, suspended notice', store.ofType('team.status').at(-1)?.status === 'suspended' && !store.owned() && store.ofType('msg.posted').some((m) => m.notice === 'suspended'), store.ofType('team.status'));
  check('sweep: never adopts (no team led here)', w.core.team() === undefined);
  check('sweep: task log terminal for every orphan', w.host.terminals.filter((t) => ['tann1', 'tben1', 'tcat1'].includes(t.id)).length === 3);
  w.driver.script('ann', { outcome: 'ok' });
  const r = await w.core.resume('old', 'lead');
  check('resume: ok, resumed, lists report-lost members', r.ok && r.value.outcome === 'resumed' && r.value.reportLost?.includes('ann') && r.value.reportLost?.includes('ben'), r);
  check('resume: team.status active, credentials re-minted', store.ofType('team.status').at(-1)?.status === 'active' && store.fileMap.has('members/ann/credential'));
  await sleep(100);
  check('resume: a recap alone starts no turn (M12)', w.driver.calls.length === 0, w.driver.calls.length);
  await w.core.send({ to: 'ann', text: 'please check your worktree and report what you have' }, 'lead');
  await waitFor(() => w.driver.callsOf('ann').length === 1, { timeoutMs: 2000 });
  const prompt = w.driver.callsOf('ann')[0]?.spec.prompt ?? '';
  check('resume: the next turn carries the resumed recap and the report-lost line (L10)', prompt.includes('The team was resumed at') && prompt.includes('Your previous report was lost'), prompt);
  check('resume: continues the same conversation (kind next)', w.driver.callsOf('ann')[0]?.spec.kind === 'next', w.driver.callsOf('ann')[0]?.spec.kind);
  const busy = await w.core.resume('old', 'lead');
  check('resume: of the team this session leads → already-led', busy.ok && busy.value.outcome === 'already-led');
});

scenario('store full: ENOSPC hold, no new turns, flushed in order; log-full → readonly (P93, §2.3)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'ok', delay: 40 });
  await createTeam(w, {});
  await waitFor(() => w.driver.callsOf('alice').length === 1 && w.driver.callsOf('alice')[0].spawned, { timeoutMs: 2000 });
  // the turn's end batch hits ENOSPC
  w.store.enospc = true;
  await sleep(150);
  const refused = await w.core.send({ to: 'alice', text: 'are you there? please answer me soon' }, 'lead');
  check('ENOSPC: an op that needs the log fails team_store_failed', !refused.ok && refused.code === 'team_store_failed' && refused.sentence.includes('ENOSPC'), refused);
  check('ENOSPC: no new turn starts while the log cannot be written', w.driver.callsOf('alice').length === 1);
  w.store.enospc = false;
  const flushed = await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  check('ENOSPC: the held turn result is appended once space returns', flushed, w.store.events.map((e) => e.type));
  const seqs = w.store.events.map((e) => e.seq);
  check('ENOSPC: the log stays gap-free and ordered', seqs.every((s, i) => s === i + 1));
  w.store.logFull = true;
  const full = await w.core.send({ to: 'alice', text: 'one more message for alice here' }, 'lead');
  await sleep(20);
  check('log-full: team.status readonly appended (reserve)', w.ev('team.status').some((e) => e.status === 'readonly'), w.ev('team.status'));
  const after = await w.core.send({ to: 'alice', text: 'and another message for alice here' }, 'lead');
  check('log-full: later sends refused team_readonly', !full.ok && !after.ok && after.code === 'team_readonly', after);
});

scenario('turns-only verdict and flip-back; agy turns-only from the start (S1-4, M19 as amended by T11 A26, §3.7)', async () => {
  // E10 (A26): demoted only on evidence — here the vendor's explicit "not connected".
  // (Before T11 this check asserted a demotion for merely not calling a tool — the E10 defect.)
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'ok', teamToolsConnected: false }); // no tool call, the model answered, init said not connected
  await createTeam(w, {});
  const verdict = await waitFor(() => w.memberEvents('member.mailbox', 'alice').some((e) => e.mailbox === 'turns-only'), { timeoutMs: 3000 });
  check('turns-only: tools reported not connected by the end of the first turn → member.mailbox turns-only', verdict);
  check('turns-only: notices to lead and user', w.notices((m) => m.notice === 'mailbox').length === 2);
  check('turns-only: the brief is re-composed with the turns-only paragraph', (w.store.fileMap.get('members/alice/brief.md') ?? '').includes('You have no team tools in this session'));
  w.driver.script('alice', {
    during: async () => {
      await w.core.memberTool('alice', 'team_board', {});
    },
  });
  await w.core.send({ to: 'alice', text: 'please look at the board and continue the work' }, 'lead');
  const back = await waitFor(() => w.memberEvents('member.mailbox', 'alice').at(-1)?.mailbox === 'tools', { timeoutMs: 3000 });
  check('flip-back: a later successful tools/call flips it back to tools with a notice', back && w.notices((m) => w.textOf(m).includes('back on its tools')).length >= 1);
  const w2 = makeWorld();
  w2.host.workers = [{ name: 'agy1', configDir: '/agy', model: '', provider: 'gemini', permissionMode: 'accept-edits' }];
  await createTeam(w2, { members: [member('dave', { provider: 'gemini' })] });
  check('agy: turns-only from the start (agy approvals)', w2.memberEvents('member.mailbox', 'dave')[0]?.reason === 'agy approvals');
  await waitFor(() => w2.driver.callsOf('dave').length === 1, { timeoutMs: 2000 });
  check('agy: no team MCP wiring without the opt-in; turns-only kickoff', w2.driver.callsOf('dave')[0].spec.mcp === undefined && w2.driver.callsOf('dave')[0].spec.prompt.includes('Begin: work on the task assigned to you below'), w2.driver.callsOf('dave')[0].spec);
});

scenario('LV-D2: the create answer names each elevated member\'s permission note exactly once (§7.4, I14)', async () => {
  const w = makeWorld();
  w.host.settingsValue.teamCursorForce = 'on';
  w.host.settingsValue.teamAgySkipPermissions = 'on';
  w.host.workers = [
    { name: 'cur', configDir: '/cur', model: '', provider: 'cursor' },
    { name: 'agy1', configDir: '/agy', model: '', provider: 'gemini', permissionMode: 'accept-edits' },
  ];
  const r = await createTeam(w, { members: [member('cur', { provider: 'cursor' }), member('ag', { provider: 'gemini' })] });
  check('LV-D2: create ok', r.ok && r.value.outcome === 'created', r);
  if (!r.ok) return;
  const text = renderCreateAnswer(r.value, r.warnings, '/data');
  const count = (needle) => text.split(needle).length - 1;
  const cursorNote = C.TEAM_TEXT.elevatedNote('cur', 'teamCursorForce');
  const agyNote = C.TEAM_TEXT.elevatedNote('ag', 'teamAgySkipPermissions');
  check('LV-D2: the Cursor note appears exactly once', count(cursorNote) === 1, text);
  check('LV-D2: the Antigravity note appears exactly once', count(agyNote) === 1, text);
});

scenario('H3: a team_inbox pull without assistant output after it is repeated, labelled (P18, P20, P29)', async () => {
  const w = makeWorld();
  let pulled;
  w.driver.script('alice', {
    hang: false,
    delay: 20,
    during: async () => {
      await sleep(10);
      pulled = await w.core.memberTool('alice', 'team_inbox', {});
    },
    assistantAfter: () => false,
    sawAssistant: true,
  });
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.driver.callsOf('alice').length === 1);
  const r = await w.core.send({ to: 'alice', text: 'a message that arrives while the turn is running' }, 'lead');
  await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  check('H3: the pull returned the message', pulled !== undefined && pulled.content[0].text.includes(`${r.value.msgId} · from lead`), pulled);
  check('H3: no msg.delivered for a pull with no assistant event after it', !w.ev('msg.delivered').some((d) => d.msg === r.value.msgId), w.ev('msg.delivered'));
  const next = await waitFor(() => w.driver.callsOf('alice').length === 2, { timeoutMs: 3000 });
  const p2 = w.memberEvents('turn.planned', 'alice')[1];
  check('H3: the next turn repeats it (pending), trigger message', next && p2.deliver.includes(seqOf(r.value.msgId)), p2);
  const w2 = makeWorld();
  let pulled2;
  w2.driver.script('alice', {
    delay: 20,
    during: async () => {
      await sleep(10);
      pulled2 = await w2.core.memberTool('alice', 'team_inbox', {});
    },
    assistantAfter: () => true,
  });
  await createTeam(w2, {});
  await waitFor(() => w2.driver.callsOf('alice').length === 1);
  const r2 = await w2.core.send({ to: 'alice', text: 'a message that arrives while the turn is running' }, 'lead');
  await waitFor(() => w2.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  void pulled2;
  check('H3: a pull acknowledged by later output is delivered via tool and not repeated (MD-25)', w2.ev('msg.delivered').some((d) => d.msg === r2.value.msgId && d.via === 'tool'));
  await sleep(100);
  check('H3: … and starts no further turn', w2.driver.callsOf('alice').length === 1, w2.driver.callsOf('alice').length);
});

scenario('context-lost → re-brief on the new id; context → refresh; resume-failed; proactive refresh (S4, P110, M13)', async () => {
  const w = makeWorld();
  w.host.workers = [{ name: 'cur', configDir: '/cur', model: '', provider: 'cursor' }];
  w.driver.script('carol', { outcome: 'ok' }, { outcome: 'ok', contextLost: true, convSeen: 'chat-new', text: 'did some work in a new chat' }, { outcome: 'ok' });
  await createTeam(w, { members: [member('carol', { provider: 'cursor' })] });
  await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  await w.core.send({ to: 'carol', text: 'please continue with the second part of the job' }, 'lead');
  const lost = await waitFor(() => w.memberEvents('member.conversation', 'carol').some((e) => e.replaced !== undefined), { timeoutMs: 3000 });
  const conv = w.memberEvents('member.conversation', 'carol').at(-1);
  check('context-lost: member.conversation {new, replaced: old} in the same incarnation', lost && conv.conversationId === 'chat-new' && conv.replaced === 'chat-1' && conv.incarnation === 1, conv);
  check('context-lost: the work is kept (report posted), notice context-lost', w.ev('msg.posted').some((m) => m.kind === 'report' && w.textOf(m).includes('new chat')) && w.notices((m) => m.notice === 'context-lost').length === 2);
  const third = await waitFor(() => w.driver.callsOf('carol').length === 3, { timeoutMs: 3000 });
  const c3 = w.driver.callsOf('carol')[2]?.spec;
  check('context-lost: the next turn is a rebrief, kind next, on the NEW id, with the brief and the packet', third && w.memberEvents('turn.planned', 'carol')[2].trigger === 'rebrief' && c3.kind === 'next' && c3.expectedConversationId === 'chat-new' && c3.prompt.includes('Your CLI started a new conversation') && c3.prompt.includes('# Team protocol') && c3.prompt.includes('hand-off'), c3);
  check('cursor: the vendor MCP file is written before the spawn and removed at exit', w.worktrees.calls.some((c) => c[0] === 'writeVendorMcp' && c[1] === 'cursor') && w.worktrees.calls.some((c) => c[0] === 'removeVendorMcp'));
  // context → refresh; a second within 3 turns → blocked context
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'context', sawEvent: true, sawAssistant: false }, { outcome: 'context', sawEvent: true, sawAssistant: false });
  await createTeam(w2, {});
  const blocked = await waitFor(() => w2.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  const routed = w2.memberEvents('member.routed', 'alice');
  check('context: refresh = new incarnation cause refresh, same account; then blocked context', blocked && routed[1]?.cause === 'refresh' && routed[1].worker === routed[0].worker && w2.memberEvents('member.state', 'alice').at(-1).reason?.code === 'context', { routed, last: w2.memberEvents('member.state', 'alice').at(-1) });
  // resume-failed → refresh once, again → blocked resume
  const w3 = makeWorld();
  w3.driver.script('alice', { outcome: 'resume-failed', sawEvent: false }, { outcome: 'resume-failed', sawEvent: false });
  await createTeam(w3, {});
  const b3 = await waitFor(() => w3.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  check('resume-failed: one refresh, then blocked resume', b3 && w3.memberEvents('member.routed', 'alice').length === 2 && w3.memberEvents('member.state', 'alice').at(-1).reason?.code === 'resume');
  // proactive refresh at 150k input tokens
  const w4 = makeWorld();
  w4.driver.script('alice', { outcome: 'ok', tokens: { in: 200_000, out: 10 } }, { outcome: 'ok' });
  await createTeam(w4, {});
  const ref = await waitFor(() => w4.memberEvents('member.routed', 'alice').some((e) => e.cause === 'refresh'), { timeoutMs: 3000 });
  await sleep(80);
  check('proactive refresh: member.routed cause refresh, no turn by itself', ref && w4.driver.callsOf('alice').length === 1);
  await w4.core.send({ to: 'alice', text: 'next task for you after the refresh, please' }, 'lead');
  await waitFor(() => w4.driver.callsOf('alice').length === 2, { timeoutMs: 2000 });
  check('proactive refresh: the next turn carries the hand-off packet on a new conversation', (w4.driver.callsOf('alice')[1]?.spec.prompt ?? '').includes('hand-off') && w4.driver.callsOf('alice')[1].spec.kind === 'first');
});

// RO3: `total_cost_usd` is the running total of the whole conversation, across `--resume`
// processes; the driver prices a resumed turn against TurnSpec.costBaselineUsd, which the engine
// folds from turn.ended.cumulativeCostUsd of the SAME conversation (a fake driver step carries
// costUsd/cumulativeCostUsd as the real driver would report them).
scenario('RO3: the cost baseline of a resumed conversation — 0 when fresh, the last cumulative of the same conversation, kept over a host restart, unknown after a turn logged before RO3, reset by a refresh and a context loss', async () => {
  const w = makeWorld();
  w.driver.script(
    'alice',
    { outcome: 'ok', costUsd: 0.01, cumulativeCostUsd: 0.01 },
    { outcome: 'ok', costUsd: 0.002, cumulativeCostUsd: 0.012 },
    { outcome: 'ok', costUsd: 0.003, cumulativeCostUsd: 0.015 },
    // as a build before RO3 logged a Claude turn: its costUsd was the conversation's total, no cumulative
    { outcome: 'ok', costUsd: 0.5 },
    { outcome: 'ok' },
  );
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  const spec = (i) => w.driver.callsOf('alice')[i]?.spec;
  check('RO3 a fresh conversation\'s first turn has baseline 0', spec(0)?.costBaselineUsd === 0, spec(0)?.costBaselineUsd);
  check('RO3 turn.ended records the turn\'s own cost and, privately, the conversation\'s cumulative total', w.ev('turn.ended')[0]?.costUsd === 0.01 && w.ev('turn.ended')[0]?.cumulativeCostUsd === 0.01, w.ev('turn.ended')[0]);
  const wire = C.teamEventParamsOf('t', w.ev('turn.ended')[0]);
  check('RO3 cumulativeCostUsd is in the LOG\'s turn.ended, and an observer\'s copy carries costUsd without it (log-private)', w.ev('turn.ended')[0]?.cumulativeCostUsd === 0.01 && wire.data.costUsd === 0.01 && !('cumulativeCostUsd' in wire.data) && !('cumulativeCostUsd' in C.wireEventOf(w.ev('turn.ended')[0])), wire.data);
  await idle(w, 'alice');
  await w.core.send({ to: 'alice', text: 'RO3 second round: continue with the next part of the job please.' }, 'lead');
  await waitFor(() => w.ev('turn.ended').length === 2, { timeoutMs: 3000 });
  check('RO3 the next turn resumes with baseline = the last cumulative of the same conversation', spec(1)?.kind === 'next' && spec(1)?.costBaselineUsd === 0.01, spec(1));
  await idle(w, 'alice');
  await w.core.suspendAll(300);
  const next = w.another();
  const r = await next.resume('web', 'lead');
  await next.send({ to: 'alice', text: 'RO3 third round, after a host restart: carry on please.' }, 'lead');
  await waitFor(() => w.ev('turn.ended').length === 3, { timeoutMs: 3000 });
  check('RO3 a host restart + team_resume keeps the baseline (folded from the log)', r.ok && spec(2)?.kind === 'next' && spec(2)?.costBaselineUsd === 0.012, { r, spec: spec(2)?.costBaselineUsd });
  await idle(w, 'alice');
  await next.send({ to: 'alice', text: 'RO3 fourth round: one more step please.' }, 'lead');
  await waitFor(() => w.ev('turn.ended').length === 4, { timeoutMs: 3000 });
  check('RO3 … and moves on to the newest cumulative', spec(3)?.costBaselineUsd === 0.015, spec(3)?.costBaselineUsd);
  await idle(w, 'alice');
  await next.send({ to: 'alice', text: 'RO3 fifth round: after a turn logged the old way.' }, 'lead');
  await waitFor(() => w.ev('turn.ended').length === 5, { timeoutMs: 3000 });
  check('RO3 after a costed turn with no cumulative (logged before RO3) the known baseline (0.015 the turn before) becomes UNKNOWN (absent), never that turn\'s cost', spec(3)?.costBaselineUsd === 0.015 && spec(4) !== undefined && !('costBaselineUsd' in spec(4)), { before: spec(3)?.costBaselineUsd, after: spec(4)?.costBaselineUsd });

  // a refresh is a fresh conversation: baseline 0 again
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'ok', tokens: { in: 200_000, out: 10 }, costUsd: 0.04, cumulativeCostUsd: 0.04 }, { outcome: 'ok' });
  await createTeam(w2, { members: [member('alice')] });
  await waitFor(() => w2.memberEvents('member.routed', 'alice').some((e) => e.cause === 'refresh'), { timeoutMs: 3000 });
  await w2.core.send({ to: 'alice', text: 'RO3 the next task, after the refresh, please.' }, 'lead');
  await waitFor(() => w2.driver.callsOf('alice').length === 2, { timeoutMs: 3000 });
  const r2 = w2.driver.callsOf('alice')[1]?.spec;
  check('RO3 a refresh (new incarnation, new conversation) starts at baseline 0, not the old conversation\'s 0.04', r2?.kind === 'first' && r2.expectedConversationId !== spec(0)?.expectedConversationId && r2.costBaselineUsd === 0, r2 && { kind: r2.kind, costBaselineUsd: r2.costBaselineUsd });

  // a context loss: the vendor's new conversation is counted from the turn that reported it
  const w3 = makeWorld();
  w3.driver.script('alice', { outcome: 'ok', costUsd: 0.02, cumulativeCostUsd: 0.02 }, { outcome: 'ok', contextLost: true, convSeen: 'conv-new', costUsd: 0.004, cumulativeCostUsd: 0.004 }, { outcome: 'ok' });
  await createTeam(w3, { members: [member('alice')] });
  await waitFor(() => w3.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  await idle(w3, 'alice');
  await w3.core.send({ to: 'alice', text: 'RO3 continue the job, the second part please.' }, 'lead');
  await waitFor(() => w3.driver.callsOf('alice').length === 3, { timeoutMs: 3000 });
  const r3 = w3.driver.callsOf('alice')[2]?.spec;
  check('RO3 after a context loss the turn on the NEW id has the new conversation\'s baseline (0.004), not the old one\'s', r3?.expectedConversationId === 'conv-new' && r3.costBaselineUsd === 0.004, r3 && { id: r3.expectedConversationId, costBaselineUsd: r3.costBaselineUsd });
});

scenario('errors, timeout, memory, budgets, team idle once (§3.5, MD-45, M20, M11)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'error', note: 'e1' }, { outcome: 'error', note: 'e2' }, { outcome: 'error', note: 'model retired' });
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.ev('turn.ended').length === 1);
  for (let i = 0; i < 2; i++) {
    await waitFor(() => w.stateOf('alice') === 'idle');
    await w.core.send({ to: 'alice', text: `try again number ${i}, the previous attempt failed` }, 'lead');
    await waitFor(() => w.ev('turn.ended').length === i + 2, { timeoutMs: 2000 });
  }
  const last = await waitFor(() => w.stateOf('alice') === 'blocked', { timeoutMs: 2000 });
  check('errors: 3 in a row → blocked error with the last message', last && w.memberEvents('member.state', 'alice').at(-1).reason?.text.includes('model retired'));
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'timeout' });
  await createTeam(w2, {});
  await waitFor(() => w2.ev('turn.ended').length === 1);
  await waitFor(() => w2.stateOf('alice') === 'idle');
  check('timeout: idle + notice', w2.notices((m) => w2.textOf(m).includes('turn limit')).length === 1);
  await w2.core.send({ to: 'alice', text: 'continue but split the long command please' }, 'lead');
  await waitFor(() => w2.driver.callsOf('alice').length === 2);
  check('timeout: the next turn carries the timeout recap', w2.driver.callsOf('alice')[1].spec.prompt.includes('stopped after 45 minutes'));
  const w3 = makeWorld();
  w3.driver.script('alice', { hang: true });
  await createTeam(w3, {});
  await waitFor(() => w3.driver.callsOf('alice')[0]?.spawned, { timeoutMs: 2000 });
  w3.host.rss = new Map([[w3.driver.callsOf('alice')[0].deps ? 7001 : 0, 9 * 1024 ** 3]]);
  w3.host.rss = new Map([[w3.ev('turn.running')[0]?.pgid ?? 0, 9 * 1024 ** 3]]);
  const mem = await waitFor(() => w3.ev('turn.ended').some((e) => e.outcome === 'memory'), { timeoutMs: 2000 });
  check('memory: ≥ 8 GiB → the ladder, outcome memory, notice with the RSS', mem && w3.notices((m) => w3.textOf(m).includes('MB of memory')).length >= 1, w3.ev('turn.ended'));
  const w4 = makeWorld();
  w4.host.settingsValue.teamTurnsPerMemberPerHour = 2;
  await createTeam(w4, {});
  await waitFor(() => w4.ev('turn.ended').length === 1);
  await w4.core.send({ to: 'alice', text: 'second turn for you please, thank you' }, 'lead');
  await waitFor(() => w4.ev('turn.ended').length === 2, { timeoutMs: 2000 });
  await w4.core.send({ to: 'alice', text: 'third turn for you please, thank you' }, 'lead');
  const budget = await waitFor(() => w4.memberEvents('member.state', 'alice').some((e) => e.reason?.code === 'budget'), { timeoutMs: 2000 });
  check('budget: over turns-per-hour the member stays idle with reason budget + until', budget && w4.ev('budget.tripped').some((e) => e.kind === 'turns-per-hour' && typeof e.until === 'number') && w4.driver.callsOf('alice').length === 2);
  const w5 = makeWorld();
  await createTeam(w5, {});
  await waitFor(() => w5.ev('turn.ended').length === 1 && w5.stateOf('alice') === 'idle');
  await sleep(60);
  w5.core.inbox('lead', 50_000, false);
  await w5.core.member({ member: 'alice', op: 'unpause' }, 'lead');
  await sleep(60);
  const idleNotices = w5.notices((m) => m.notice === 'idle');
  check('team idle: posted once when the team BECOMES idle, never re-posted for an unchanged state (M11)', idleNotices.length === 1, idleNotices.length);
});

scenario('board: claim conflicts and limits, review needs a report, lead overlap is a warning (§5.2, §5.3, P37, P60)', async () => {
  const w = makeWorld();
  const answers = {};
  w.driver.script('alice', {
    during: async () => {
      answers.claim1 = await w.core.memberTool('alice', 'team_claim', { task_id: 'b1' });
      answers.review = await w.core.memberTool('alice', 'team_update', { task_id: 'b1', state: 'review' });
      answers.notMine = await w.core.memberTool('alice', 'team_update', { task_id: 'b3', state: 'blocked', note: 'x' });
    },
  });
  w.driver.script('bob', {
    delay: 30,
    during: async () => {
      await sleep(15);
      answers.conflict = await w.core.memberTool('bob', 'team_claim', { task_id: 'b2' });
      answers.taken = await w.core.memberTool('bob', 'team_claim', { task_id: 'b1' });
    },
  });
  await createTeam(w, {
    members: [member('alice'), member('bob')],
    tasks: [
      { title: 'net', paths: ['src/net/'] },
      { title: 'net client', paths: ['src/net/client.ts'] },
      { title: 'docs', assignee: 'bob' },
    ],
  });
  await waitFor(() => w.ev('turn.ended').length === 2, { timeoutMs: 3000 });
  check('claim: ok', answers.claim1 && !answers.claim1.isError && answers.claim1.content[0].text.startsWith('Claimed b1'), answers.claim1);
  check('update: review needs a report', answers.review?.content[0].text.startsWith('report_required:'), answers.review);
  check('update: another member’s task → not_your_task', answers.notMine?.content[0].text.startsWith('not_your_task:'), answers.notMine);
  check('claim: path overlap with a claimed task of another member → paths_conflict', answers.conflict?.content[0].text.startsWith('paths_conflict:'), answers.conflict);
  check('claim: of two claims the first wins, the second reads not_open', answers.taken?.content[0].text.startsWith('not_open:'), answers.taken);
  const assign = await w.core.board({ op: 'assign', task: 'b2', to: 'bob' }, 'lead');
  check('lead assign: a path conflict is a warning, not a refusal', assign.ok && assign.warnings.some((x) => x.startsWith('warning: b2 overlaps b1 (alice)')), assign);
  const bad = await w.core.board({ op: 'update', task: 'b2', paths: ['/abs'] }, 'lead');
  check('board: invalid path refused naming it (P87)', !bad.ok && bad.code === 'invalid_path' && bad.sentence.includes('/abs'), bad);
  const cancel = await w.core.board({ op: 'cancel', task: 'b3' }, 'lead');
  const again = await w.core.board({ op: 'reopen', task: 'b3' }, 'lead');
  check('board: cancelled is terminal', cancel.ok && !again.ok && again.code === 'invalid_transition', again);
});

scenario('doorbell: wake-worthy, report coalescing, one waiter; cap-aware inbox read marks (M9, M11, M13, P25, P28)', async () => {
  const w = makeWorld();
  w.driver.script('bob', { hang: true });
  await createTeam(w, { members: [member('alice', { start: false }), member('bob')] });
  await waitFor(() => w.stateOf('alice') === 'idle' && w.driver.callsOf('bob')[0]?.spawned);
  const ac = new AbortController();
  const p = w.core.waitForLead(ac.signal, 10);
  let second;
  try {
    await w.core.waitForLead(new AbortController().signal, 0);
  } catch (err) {
    second = err;
  }
  check('waiter: a second one is refused already_waiting (never supersede)', second?.code === 'already_waiting', second);
  await w.core.send({ to: 'alice', text: 'please do one turn and report back' }, 'lead');
  const woken = await Promise.race([p, sleep(2000).then(() => 'timeout')]);
  check('waiter: a report wakes the lead', woken === 'woken', woken);
  w.core.inbox('lead', 100_000, false);
  await sleep(20);
  const p2 = w.core.waitForLead(ac.signal, 0);
  await w.core.send({ to: 'alice', text: 'and a second turn with another report please' }, 'lead');
  await waitFor(() => w.ev('msg.posted').filter((m) => m.kind === 'report').length === 2, { timeoutMs: 2000 });
  const r2 = await Promise.race([p2, sleep(150).then(() => 'still-waiting')]);
  check('coalescing: a second report within 60 s does not wake (M13)', r2 === 'still-waiting', r2);
  ac.abort();
  const aborted = await p2;
  check('waiter: abort answers aborted', aborted === 'aborted', aborted);
  await w.core.end(true, 'lead');
  // cap-aware inbox
  const w2 = makeWorld();
  await createTeam(w2, { members: [member('alice', { start: false })] });
  await waitFor(() => w2.stateOf('alice') === 'idle');
  w2.driver.script('alice', {
    during: async () => {
      for (let i = 0; i < 18; i++) {
        await w2.core.memberTool('alice', 'team_send', { to: 'lead', kind: 'question', text: `question ${i}: ${'detail '.repeat(40)}` });
      }
    },
  });
  await w2.core.send({ to: 'alice', text: 'ask me everything you need to know' }, 'lead');
  await waitFor(() => w2.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  const unread = w2.core.footerCounts();
  const page = w2.core.inbox('lead', 6000, false);
  check('inbox: under a 6,000-char cap only some are shown', page.shown.length > 0 && page.remaining > 0 && page.text.length <= 6000, { shown: page.shown.length, remaining: page.remaining, len: page.text.length });
  check('inbox: read-marked through the LAST message shown, never beyond', page.readThrough === seqOf(page.shown.at(-1)), page);
  await sleep(20);
  const after = w2.core.footerCounts();
  check('inbox: the rest stay unread (footer counts them)', unread !== undefined && after !== undefined && after.unread === unread.unread - page.shown.length, { unread, after });
  check('footer: senders listed', after?.senders.includes('alice'));
});

scenario('end: drain, members ended, task log, lease released, expired notice (§2.5, §4.3, §9.5)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'ok', delay: 60 });
  await createTeam(w, { members: [member('alice'), member('bob', { start: false })] });
  await waitFor(() => w.driver.callsOf('alice')[0]?.spawned, { timeoutMs: 2000 });
  await w.core.member({ member: 'bob', op: 'stop' }, 'lead');
  await w.core.send({ to: 'bob', text: 'this message never reaches bob because he is stopped' }, 'lead');
  const r = await w.core.end(false, 'lead');
  check('end: ok, drained (the running turn finished ok)', r.ok && r.value.mode === 'drain' && w.ev('turn.ended')[0]?.outcome === 'ok', r);
  check('end: every member ended', ['alice', 'bob'].every((n) => w.stateOf(n) === 'ended'));
  check('end: team.status ended, lease released, no team led', w.ev('team.status').at(-1)?.status === 'ended' && !w.store.owned() && w.core.team() === undefined);
  check('end: branches listed with facts', r.ok && r.value.branches.length === 2 && r.value.branches.every((b) => b.branch.startsWith('cco/web-')), r.ok && r.value.branches);
  check('end: an undelivered lead message is reported expired', w.notices((m) => m.notice === 'expired' && m.to === 'lead').length === 1);
  const w2 = makeWorld();
  w2.driver.script('alice', { hang: true });
  await createTeam(w2, {});
  await waitFor(() => w2.driver.callsOf('alice')[0]?.spawned, { timeoutMs: 2000 });
  const r2 = await w2.core.end(true, 'lead');
  check('end --now: the ladder, turn ended interrupted reason end, task log error team ended', r2.ok && w2.ev('turn.ended')[0]?.reason === 'end' && w2.host.terminals.some((t) => t.error === 'team ended'), w2.ev('turn.ended'));
});

scenario('take-over: Claude only, grant/attached/pid death, lead plan changes nothing (§3.10, P74–P76)', async () => {
  const w = makeWorld();
  await createTeam(w, {});
  await waitFor(() => w.ev('turn.ended').length === 1 && w.stateOf('alice') === 'idle', { timeoutMs: 3000 });
  const before = w.store.events.length;
  const lead = await w.core.takeover('alice', false, 'lead', 0);
  check('take-over by lead: a plan, nothing appended', lead.ok && lead.value.lease === '' && lead.value.args[0] === '--resume' && w.store.events.length === before, lead);
  const grant = await w.core.takeover('alice', false, 'user', 7);
  check('take-over grant: attach_pending, env set holds CCO_TEAM_MEMBER and attach marker', grant.ok && w.stateOf('alice') === 'attach_pending' && grant.value.env.set.CCO_TEAM_MEMBER?.startsWith(w.store.teamId) && grant.value.env.set.CCO_DISPATCHED_TASK === `attach-${grant.value.lease}` && grant.value.env.unset.includes('CLAUDECODE'), grant);
  w.host.alive.set(31337, 1);
  const at = w.core.attached(grant.value.lease, 31337);
  await waitFor(() => w.stateOf('alice') === 'attached');
  check('attached: state attached', at.ok && w.stateOf('alice') === 'attached');
  const rel = await w.core.release(grant.value.lease, 'release');
  check('release while the pid lives: still_attached', !rel.ok && rel.code === 'still_attached', rel);
  const sent = await w.core.send({ to: 'alice', text: 'queued while the user is attached to alice' }, 'lead');
  check('send while attached: queued (attached)', sent.ok && sent.value.recipients[0].delivery === 'attached', sent);
  w.host.alive.delete(31337);
  const back = await waitFor(() => w.ev('attach.ended').length === 1 && w.driver.callsOf('alice').length === 2, { timeoutMs: 3000 });
  check('pid dies: attach.ended → idle → the queued message starts a turn', back, w.ev('attach.ended'));
  const w2 = makeWorld();
  w2.host.workers = [{ name: 'cx', configDir: '/cx', model: 'gpt-x', provider: 'codex' }];
  await createTeam(w2, { members: [member('bob', { provider: 'codex' })] });
  const no = await w2.core.takeover('bob', false, 'user', 1);
  check('take-over of a non-Claude member: not_supported', !no.ok && no.code === 'not_supported', no);
});

scenario('routing: lead account kept out of automatic choices; per-identity cap; machine login (MD-48, §6.2 step 4)', async () => {
  const w = makeWorld();
  w.host.workers = [
    { name: 'mine', configDir: '/lead', model: 'opus' },
    { name: 'acct1', configDir: '/acct1', model: 'opus' },
  ];
  const r = await createTeam(w, { members: [member('a'), member('b'), member('c'), member('d')] });
  check('cap: a 4th member on the only non-lead account is refused (≤ 3 per identity)', !r.ok && r.sentence.includes('already runs 3 members'), r);
  const r2 = await createTeam(w, { members: [member('a'), member('b', { worker: 'mine' })] });
  const routed = w.ev('member.routed');
  check('lead account: only when named as worker', r2.ok && routed.find((e) => e.name === 'a')?.worker === 'acct1' && routed.find((e) => e.name === 'b')?.worker === 'mine', routed);
  check('lead account: shares the lead\'s plan in the overlay', w.core.team()?.members.find((m) => m.name === 'b')?.sharesLeadPlan === true);
  const w2 = makeWorld();
  w2.host.workers = [
    { name: 'cur1', configDir: '/c1', model: '', provider: 'cursor' },
    { name: 'cur2', configDir: '/c2', model: '', provider: 'cursor' },
  ];
  w2.driver.script('x', { outcome: 'quota', sawEvent: true, sawAssistant: false });
  await createTeam(w2, { members: [member('x', { provider: 'cursor' }), member('y', { provider: 'cursor' })] });
  check('machine login: accountKey cursor:ambient for every entry', w2.ev('member.routed').every((e) => e.accountKey === 'cursor:ambient'), w2.ev('member.routed'));
  const b = await waitFor(() => w2.stateOf('x') === 'blocked', { timeoutMs: 3000 });
  check('machine login: never "failed over" to another entry of the same login', b && w2.memberEvents('member.routed', 'x').length === 1, w2.memberEvents('member.routed', 'x'));
});

/* ------------------------------------------------------------------------- *
 * T11 fix wave (FX3-B): one regression check (or more) per finding, named with its id.
 * Each FAILS on the code before the fix (the reviewers' probes, .orchestrator/review-t11/).
 * ------------------------------------------------------------------------- */

/** A team left in the store by an earlier host (lease 999_001), members idle with a worktree and a conversation. */
function oldTeam(w, { name = 'old', members = ['ann'], leasePid = 999_001, status } = {}) {
  const header = { v: 1, id: C.newTeamId(Date.now() - 10_000), name, title: name, workspace: '/repo', repoRoot: '/repo', commonDir: '/repo/.git', createdAt: Date.now() - 10_000 };
  let seq = 0;
  const events = [];
  const e = (by, body) => {
    const ev = { v: 1, seq: ++seq, ts: Date.now() - 5000, by, ...body };
    events.push(ev);
    return ev;
  };
  e('lead', { type: 'team.created', name, title: name, workspace: '/repo', repoRoot: '/repo', commonDir: '/repo/.git', baseCommit: 'a'.repeat(40), leadRel: '', goal: { bytes: 4, text: 'goal' } });
  e('engine', { type: 'lease.acquired', hostPid: leasePid, hostStartedAt: 5, session: { pid: 999_002, startedAt: 5 } });
  for (const [i, m] of members.entries()) {
    const spec = typeof m === 'string' ? { name: m } : m;
    const provider = spec.provider ?? 'claude';
    const worker = spec.worker ?? 'acct1';
    const wt = `/data/worktrees/h1h1/${name}-x/${spec.name}`;
    e('lead', { type: 'member.added', name: spec.name, index: i + 1, role: 'r', briefBytes: 1, spec: { paths: [] } });
    e('engine', { type: 'member.routed', name: spec.name, incarnation: 1, provider, worker, accountKey: provider === 'cursor' ? 'cursor:ambient' : `/${worker}`, model: provider === 'cursor' ? '' : 'opus', modelSource: 'worker', reason: 'r', cause: 'initial' });
    e('engine', { type: 'member.worktree', name: spec.name, path: wt, branch: `cco/${name}-x/${spec.name}`, baseCommit: 'a'.repeat(40), cwd: wt });
    e('engine', { type: 'member.conversation', name: spec.name, incarnation: 1, conversationId: provider === 'cursor' ? 'chat-1' : `00000000-0000-4000-8000-00000000000${i}` });
    e('engine', { type: 'turn.planned', turnId: `t${spec.name}0`, name: spec.name, n: 1, incarnation: 1, trigger: 'brief', deliver: [], resent: [], promptBytes: 10 });
    e('engine', { type: 'turn.ended', turnId: `t${spec.name}0`, outcome: 'ok', exitCode: 0, signal: null, durationMs: 5, tokens: { in: 1, out: 1 }, text: 'ok', textFile: '/x', sawAssistant: true, conversationIdSeen: 'c' });
    e('engine', { type: 'member.state', name: spec.name, state: 'idle' });
  }
  if (status !== undefined) {
    e('engine', { type: 'team.status', status, reason: 'lead-ended' });
    e('engine', { type: 'lease.released', reason: 'lead-ended' });
  }
  const lease = status === undefined ? { v: 1, hostPid: leasePid, hostStartedAt: 5, session: { pid: 999_002, startedAt: 5 }, socket: '/s', acquiredAt: 1 } : undefined;
  const store = new FakeStore(w.stores, header, events, { lease });
  w.stores.map.set(header.id, store);
  return { store, header, e };
}

scenario('T11 E2: the project .mcp.json of the BASE commit, copied to the member dir; a git failure warns once per incarnation (A18, I14)', async () => {
  const w = makeWorld();
  w.worktrees.projectMcpResult = (input) => ({ ok: true, value: input.outFile });
  w.driver.script('alice', { outcome: 'ok' });
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  const call = w.worktrees.calls.find((c) => c[0] === 'projectMcpFile')?.[1];
  const spec = w.driver.callsOf('alice')[0]?.spec;
  check(
    'E2 a Claude member gets projectMcpFile({path: worktree, baseCommit, outFile: <member dir>/project-mcp.json}) and passes that copy',
    call !== undefined &&
      call.path === spec?.cwd &&
      call.baseCommit === 'a'.repeat(40) &&
      call.outFile.endsWith(path.join('members', 'alice', 'project-mcp.json')) &&
      !call.outFile.startsWith(spec.cwd) &&
      spec.mcp?.projectConfigFile === call.outFile,
    { call, mcp: spec?.mcp },
  );
  const w2 = makeWorld();
  w2.worktrees.projectMcpResult = { ok: false, code: 'git', text: 'fatal: bad object aaaaaaa' };
  w2.driver.script('alice', { outcome: 'ok' }, { outcome: 'ok' });
  await createTeam(w2, { members: [member('alice')] });
  await waitFor(() => w2.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  await w2.core.send({ to: 'alice', text: 'second turn please, the project servers are not needed' }, 'lead');
  await waitFor(() => w2.ev('turn.ended').length === 2, { timeoutMs: 3000 });
  const warnings = w2.ev('store.warning').filter((x) => x.text.includes('.mcp.json'));
  check(
    'E2 a git failure passes NO project file (both turns) and one store.warning for the incarnation',
    w2.driver.callsOf('alice').length === 2 && w2.driver.callsOf('alice').every((c) => c.spec.mcp?.projectConfigFile === undefined) && warnings.length === 1,
    { warnings, mcp: w2.driver.callsOf('alice').map((c) => c.spec.mcp) },
  );
  const w3 = makeWorld();
  w3.host.workers = [{ name: 'cur', configDir: '/cur', model: '', provider: 'cursor' }];
  await createTeam(w3, { members: [member('carol', { provider: 'cursor' })] });
  await waitFor(() => w3.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  check('E2 a non-Claude member never asks for the project file', !w3.worktrees.calls.some((c) => c[0] === 'projectMcpFile'), w3.worktrees.calls);
});

scenario('T11 E3: the base is resolved in the lead workspace (team_create) and the recorded lead checkout (team_add) (A19)', async () => {
  const w = makeWorld();
  w.worktrees.repository = async () => ({ ok: true, value: { repoRoot: '/main', commonDir: '/main/.git', leadRel: '', repoHash: 'h1h1', dirtyFiles: 0 } });
  const r = await createTeam(w, { members: [member('alice', { start: false })] });
  const first = w.worktrees.calls.filter((c) => c[0] === 'resolveBase');
  check('E3 team_create: resolveBase(<lead workspace>, base), never the main checkout', r.ok && first.length === 1 && first[0][1] === '/repo' && first[0][2] === 'HEAD', first);
  const add = await w.core.add({ members: [member('zed', { start: false })] }, 'lead');
  const second = w.worktrees.calls.filter((c) => c[0] === 'resolveBase');
  check('E3 team_add: resolveBase(<recorded lead checkout>, HEAD), never repoRoot', add.ok && second.length === 2 && second[1][1] === '/repo', second);
});

scenario('T11 E4: a team whose host died after the start-up sweep — resume (unnamed, named), create, list; a live lease is refused (A20)', async () => {
  // unnamed resume
  const w = makeWorld();
  const { store } = oldTeam(w, { name: 'web' });
  w.host.alive.set(999_001, 5); // the other host is alive at this host's start
  await w.core.sweep();
  check('E4 the start-up sweep leaves a team with a LIVE owner alone', store.ofType('team.status').length === 0 && w.core.listTeams().length === 0, w.core.listTeams());
  w.host.alive.delete(999_001); // … and dies afterwards
  const listed = w.core.listTeams();
  check('E4 listTeams shows the ownerless active team as suspended (host gone)', listed.length === 1 && listed[0].state === 'suspended' && listed[0].reason === 'host gone' && listed[0].owner === undefined, listed);
  const r = await w.core.resume(undefined, 'lead');
  check('E4 team_resume (no name) runs the one-team sweep, then resumes', r.ok && r.value.outcome === 'resumed' && store.ofType('team.status').map((x) => x.status).join(',') === 'suspended,active', { r, statuses: store.ofType('team.status') });
  // named resume
  const w2 = makeWorld();
  const t2 = oldTeam(w2, { name: 'web' });
  w2.host.alive.set(999_001, 5);
  await w2.core.sweep();
  w2.host.alive.delete(999_001);
  const r2 = await w2.core.resume('web', 'lead');
  check('E4 team_resume web (named) runs the one-team sweep, then resumes', r2.ok && r2.value.outcome === 'resumed' && t2.store.ofType('team.status').at(-1)?.status === 'active', r2);
  // create of the same name
  const w3 = makeWorld();
  const t3 = oldTeam(w3, { name: 'web' });
  w3.host.alive.set(999_001, 5);
  await w3.core.sweep();
  w3.host.alive.delete(999_001);
  const r3 = await createTeam(w3, { name: 'web' });
  check('E4 team_create web sweeps the dead team first: name_in_use names it suspended, not active', !r3.ok && r3.code === 'name_in_use' && r3.sentence.includes('(suspended)') && t3.store.ofType('team.status').at(-1)?.status === 'suspended', r3);
  // a live lease is never taken
  const w4 = makeWorld();
  const t4 = oldTeam(w4, { name: 'web' });
  w4.host.alive.set(999_001, 5);
  await w4.core.sweep();
  const r4 = await w4.core.resume('web', 'lead');
  const r4b = await w4.core.resume(undefined, 'lead');
  check('E4 a LIVE lease is still refused (team_busy / no suspended team) and never taken', !r4.ok && r4.code === 'team_busy' && !r4b.ok && r4b.code === 'no_suspended_team' && t4.store.ofType('team.status').length === 0 && t4.store.ofType('lease.acquired').length === 1, { r4, r4b });
});

scenario('T11 E5: a checkpoint on a moved branch commits nothing and blocks worktree-branch at once, with the remedy (A21)', async () => {
  const w = makeWorld();
  w.worktrees.checkpointResult = { ok: false, code: 'branch-moved', text: 'detached at 1234abc' };
  await createTeam(w, { members: [member('alice')] });
  const blocked = await waitFor(() => w.stateOf('alice') === 'blocked', { timeoutMs: 3000 });
  const cp = w.ev('turn.checkpoint')[0];
  const st = w.memberEvents('member.state', 'alice').at(-1);
  const branch = w.ev('member.worktree')[0]?.branch;
  const wtPath = w.ev('member.worktree')[0]?.path;
  check('E5 the checkpoint is asked for the member branch', w.worktrees.calls.some((c) => c[0] === 'checkpoint' && c[2] === branch), w.worktrees.calls.filter((c) => c[0] === 'checkpoint'));
  check('E5 turn.checkpoint {error: branch-moved …} names the exact git -C <wt> checkout <branch> remedy', cp?.error?.startsWith('branch-moved: detached at 1234abc') && cp.error.includes(`git -C ${wtPath} checkout ${branch}`), cp);
  const endedSeq = w.ev('turn.ended')[0]?.seq ?? Infinity;
  check('E5 blocked: worktree-branch AT the turn end (no idle after turn.ended, no further turn)', blocked && st.reason?.code === 'worktree-branch' && !w.memberEvents('member.state', 'alice').some((x) => x.seq > endedSeq && x.state === 'idle') && w.driver.callsOf('alice').length === 1, w.memberEvents('member.state', 'alice'));
  // the next message does not start a turn on the moved branch; the lead was told
  await w.core.send({ to: 'alice', text: 'continue after the branch problem, please' }, 'lead');
  await sleep(80);
  check('E5 a blocked member starts no turn; the lead notice carries the remedy', w.driver.callsOf('alice').length === 1 && w.notices((m) => m.to === 'lead' && w.textOf(m).includes('checkout')).length >= 1);
  // variant: a stop's checkpoint on a moved branch records the error and stops (no block)
  const w2 = makeWorld();
  await createTeam(w2, { members: [member('bob', { start: false })] });
  await waitFor(() => w2.stateOf('bob') === 'idle');
  w2.worktrees.checkpointResult = { ok: false, code: 'branch-moved', text: 'on other-branch' };
  const stop = await w2.core.member({ member: 'bob', op: 'stop' }, 'lead');
  check('E5 a stop on a moved branch records branch-moved and the member is stopped', stop.ok && w2.stateOf('bob') === 'stopped' && w2.ev('turn.checkpoint')[0]?.error?.startsWith('branch-moved: on other-branch'), w2.ev('turn.checkpoint'));
});

scenario('T11 E7: a suspend closes a turn whose process is gone; a live one is left to the next host, whose sweep takes the suspended team (A23)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { hang: true });
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.driver.callsOf('alice')[0]?.spawned, { timeoutMs: 2000 });
  w.worktrees.checkpointResult = async () => {
    await sleep(700); // a slow `git add` on a big repository
    return { ok: true, value: { committed: false, skipped: [] } };
  };
  const t0 = Date.now();
  await w.core.suspendAll(500);
  const elapsed = Date.now() - t0;
  const types = w.store.events.map((e) => `${e.type}${e.type === 'team.status' ? `:${e.status}` : ''}`);
  const endedAt = types.indexOf('turn.ended');
  check('E7 the turn whose CLI died is closed BEFORE team.status suspended (interrupted, lead-ended), the member idle', elapsed < 900 && endedAt >= 0 && endedAt < types.indexOf('team.status:suspended') && w.ev('turn.ended')[0].reason === 'lead-ended' && w.stateOf('alice') === 'idle', { elapsed, types });
  await sleep(800);
  check('E7 the late turn end appends nothing to a released team', w.ev('turn.ended').length === 1 && !w.store.owned());
  // variant: the process is still alive → blocked unknown-turn, the turn stays open; the next host sweeps it
  const w2 = makeWorld();
  w2.driver.script('alice', { hang: true, ignoreSignals: true });
  await createTeam(w2, { members: [member('alice')] });
  const running = await waitFor(() => w2.ev('turn.running')[0], { timeoutMs: 2000 });
  w2.host.alive.set(running.pid, running.startedAt);
  w2.host.ours.add(running.pid);
  await w2.core.suspendAll(300);
  const st = w2.memberEvents('member.state', 'alice').at(-1);
  check('E7 a turn whose process may live keeps its open record; the member is blocked unknown-turn', w2.ev('turn.ended').length === 0 && st?.state === 'blocked' && st.reason?.code === 'unknown-turn' && w2.ev('team.status').at(-1)?.status === 'suspended', { st, ended: w2.ev('turn.ended') });
  const next = w2.another();
  await next.sweep();
  const ended = w2.ev('turn.ended')[0];
  check('E7 the next host sweeps a SUSPENDED team that still holds an open turn: fenced SIGTERM, interrupted engine-restart, member idle', ended?.outcome === 'interrupted' && ended.reason === 'engine-restart' && w2.host.signals.some(([pg, sig]) => pg === running.pgid && sig === 'SIGTERM') && w2.stateOf('alice') === 'idle' && w2.ev('team.status').at(-1)?.status === 'suspended', { ended, signals: w2.host.signals, last: w2.memberEvents('member.state', 'alice').at(-1) });
});

scenario('T11 E8/E16: until-timers survive suspend/resume (quota-wait, unknown-turn) (A24)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'quota', sawEvent: true, sawAssistant: false }, { outcome: 'ok' });
  w.host.resets.set('acct1', { until: Date.now() + 900, window: '5-hour' });
  await createTeam(w, { members: [member('alice')] });
  const paused = await waitFor(() => w.memberEvents('member.state', 'alice').at(-1)?.reason?.code === 'quota-wait', { timeoutMs: 3000 });
  await w.core.suspendAll(200);
  const next = w.another();
  const r = await next.resume('web', 'lead');
  const cont = await waitFor(() => w.memberEvents('turn.planned', 'alice').at(-1)?.trigger === 'continue', { timeoutMs: 3000 });
  check('E8 a quota-wait pause re-arms its timer at team_resume: the SAME incarnation continues after the reset', paused && r.ok && cont && w.memberEvents('turn.planned', 'alice').at(-1).incarnation === 1, { r, planned: w.memberEvents('turn.planned', 'alice') });
  // E16: unknown-turn until in the near future, and one already past
  const w2 = makeWorld();
  const { e } = oldTeam(w2, { name: 'old', members: ['ann', 'ben'], status: 'suspended' });
  e('engine', { type: 'member.state', name: 'ann', state: 'blocked', reason: { code: 'unknown-turn', text: 'lost', until: Date.now() + 250 } });
  e('engine', { type: 'member.state', name: 'ben', state: 'blocked', reason: { code: 'unknown-turn', text: 'lost', until: Date.now() - 1000 } });
  const r2 = await w2.core.resume('old', 'lead');
  await sleep(60);
  const benAt = w2.stateOf('ben');
  const annEarly = w2.stateOf('ann');
  const annIdle = await waitFor(() => w2.stateOf('ann') === 'idle', { timeoutMs: 2000 });
  check('E16 blocked unknown-turn has a live timer after resume: idle when its until passes (at once when already past)', r2.ok && benAt === 'idle' && annEarly === 'blocked' && annIdle, { r2, benAt, annEarly, ann: w2.memberEvents('member.state', 'ann') });
});

scenario('T11 E9: the duplicate guard is seeded from the log at adopt (A25)', async () => {
  const w = makeWorld();
  await createTeam(w, { members: [member('alice', { start: false }), member('bob', { start: false })] });
  await waitFor(() => w.stateOf('alice') === 'idle' && w.stateOf('bob') === 'idle');
  const body = 'Please implement the retry policy for the HTTP client and report the result.';
  const first = await w.core.send({ to: 'alice', text: body }, 'lead');
  await w.core.suspendAll(300);
  const next = w.another();
  await next.resume('web', 'lead');
  const again = await next.send({ to: 'alice', text: body }, 'lead');
  check('E9 after suspend + resume the lead re-sending the same body is refused duplicate naming the first id', first.ok && !again.ok && again.code === 'duplicate' && again.sentence.includes(first.value.msgId), { first, again });
  const other = await next.send({ to: 'bob', text: body }, 'lead');
  check('E9 the same body to ANOTHER member is not a duplicate', other.ok, other);
});

scenario('T11 E10: tools verdict — a successful call or init connected=true; demoted only on evidence (A26)', async () => {
  const w = makeWorld();
  w.driver.script('alice', { outcome: 'ok' }); // real work, no team tool call, no init reading
  await createTeam(w, { members: [member('alice')] });
  await waitFor(() => w.ev('turn.ended').length === 1, { timeoutMs: 3000 });
  await sleep(30);
  check('E10 a first turn of real work without a team tool call is NOT demoted (stays unverified, no notice)', w.memberEvents('member.mailbox', 'alice').length === 0 && w.notices((m) => m.notice === 'mailbox').length === 0, w.memberEvents('member.mailbox', 'alice'));
  const w2 = makeWorld();
  w2.driver.script('alice', { outcome: 'ok', teamToolsConnected: true });
  await createTeam(w2, { members: [member('alice')] });
  const tools = await waitFor(() => w2.memberEvents('member.mailbox', 'alice').at(-1)?.mailbox === 'tools', { timeoutMs: 3000 });
  check('E10 Claude init connected=true counts as usable → member.mailbox tools', tools, w2.memberEvents('member.mailbox', 'alice'));
  const w3 = makeWorld();
  w3.driver.script('alice', { outcome: 'ok', toolItems: ['mcp__cco_team__team_board'] }); // the call never reached the host
  await createTeam(w3, { members: [member('alice')] });
  const demoted = await waitFor(() => w3.memberEvents('member.mailbox', 'alice').at(-1)?.mailbox === 'turns-only', { timeoutMs: 3000 });
  check('E10 a FAILED call (a cco_team tool in the stream, none reached the host) demotes to turns-only', demoted, w3.memberEvents('member.mailbox', 'alice'));
  const w4 = makeWorld();
  w4.host.workers = [{ name: 'cur', configDir: '/cur', model: '', provider: 'cursor' }];
  w4.driver.script('carol', { outcome: 'ok' }); // Cursor: no init reading, no tool events, no successful call
  await createTeam(w4, { members: [member('carol', { provider: 'cursor' })] });
  const cursorDemoted = await waitFor(() => w4.memberEvents('member.mailbox', 'carol').at(-1)?.mailbox === 'turns-only', { timeoutMs: 3000 });
  check('E10 Cursor keeps A8\'s per-turn verdict: no successful call in an answered turn → turns-only', cursorDemoted, w4.memberEvents('member.mailbox', 'carol'));
});

scenario('T11 E11: a damaged team is named with its reason — listTeams, team_resume named and unnamed (A20)', async () => {
  const w = makeWorld();
  const { store } = oldTeam(w, { name: 'web' });
  store.damaged = 'events.jsonl line 4 repeats seq 3 (duplicate)';
  await w.core.sweep();
  const listed = w.core.listTeams();
  check('E11 listTeams: state damaged with the reason', listed.length === 1 && listed[0].state === 'damaged' && listed[0].reason?.includes('repeats seq 3'), listed);
  const named = await w.core.resume('web', 'lead');
  check('E11 team_resume web names it damaged with the reason (never "active, not suspended")', !named.ok && named.code === 'not_suspended' && named.sentence.includes('damaged (events.jsonl line 4'), named);
  const unnamed = await w.core.resume(undefined, 'lead');
  check('E11 team_resume (no name) lists the damaged team with its reason', !unnamed.ok && unnamed.code === 'no_suspended_team' && unnamed.sentence.includes('Damaged: web (events.jsonl line 4'), unnamed);
});

scenario('T11 E12: a Codex account that registers this product\'s server.js is refused as a member (A27, §3.9)', async () => {
  const dir = fs.mkdtempSync(path.join(BASE, 'codex-'));
  const cfg = (name, text) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config.toml'), text);
    return d;
  };
  const table = cfg('table', 'model = "gpt-5"\n[mcp_servers.cco]\ncommand = "node"\nargs = ["/Users/x/.claude-code-orchestrator/mcp/server.js"]\n');
  const inline = cfg('inline', 'mcp_servers.cco = { command = "node", args = ["/Users/x/.fable-orchestrator/mcp/server.js"] }\n');
  const other = cfg('other', '[mcp_servers.fs]\ncommand = "npx"\nargs = ["server-filesystem", "/tmp/server.js"]\n');
  const commented = cfg('commented', '# [mcp_servers.cco]\n# args = ["/x/mcp/server.js"]\n[profile]\nname = "a"\n');
  check(
    'E12 the config.toml text check: a [mcp_servers.*] table or an inline entry naming …/mcp/server.js is found; other servers and comments are not',
    codexConfigRegistersDispatch(table) === path.join(table, 'config.toml') &&
      codexConfigRegistersDispatch(inline) === path.join(inline, 'config.toml') &&
      codexConfigRegistersDispatch(other) === undefined &&
      codexConfigRegistersDispatch(commented) === undefined &&
      codexConfigRegistersDispatch(path.join(dir, 'missing')) === undefined,
    [table, inline, other, commented].map((d) => codexConfigRegistersDispatch(d)),
  );
  const routingWith = (w, registered) => {
    const base = w.host.routing.bind(w.host);
    w.host.routing = () => ({ ...base(), codexDispatchServer: (wk) => (registered.has(wk.name) ? `/${wk.name}/config.toml` : undefined) });
  };
  const w = makeWorld();
  w.host.workers = [{ name: 'cx', configDir: '/cx', model: 'gpt-x', provider: 'codex' }];
  routingWith(w, new Set(['cx']));
  const r = await createTeam(w, { members: [member('bob', { provider: 'codex' })] });
  check('E12 provider codex on the only (registered) account → refused with TEAM_TEXT.codexDispatchServer, nothing created', !r.ok && r.sentence.includes(C.TEAM_TEXT.codexDispatchServer('cx', '/cx/config.toml')) && w.stores.created.length === 0, r);
  const r2 = await createTeam(w, { members: [member('bob', { worker: 'cx' })] });
  check('E12 the registered account named as worker → refused with the same sentence', !r2.ok && r2.sentence.includes('registers the Claude Code Orchestrator MCP server for Codex'), r2);
  const w2 = makeWorld();
  w2.host.workers = [
    { name: 'cx', configDir: '/cx', model: 'gpt-x', provider: 'codex' },
    { name: 'cy', configDir: '/cy', model: 'gpt-x', provider: 'codex' },
  ];
  routingWith(w2, new Set(['cx']));
  const r3 = await createTeam(w2, { members: [member('bob', { provider: 'codex' })] });
  check('E12 another Codex account without it is chosen instead', r3.ok && w2.ev('member.routed')[0]?.worker === 'cy', w2.ev('member.routed'));
});

scenario('T11 E15: a pending re-brief / packet turn is derived from the log at adopt (A30)', async () => {
  const w = makeWorld();
  w.host.workers = [
    { name: 'acct1', configDir: '/acct1', model: 'opus' },
    { name: 'acct2', configDir: '/acct2', model: 'opus' },
    { name: 'cur', configDir: '/cur', model: '', provider: 'cursor' },
  ];
  const { e } = oldTeam(w, { name: 'old', members: [{ name: 'carol', provider: 'cursor', worker: 'cur' }, 'ben'], status: 'suspended' });
  e('engine', { type: 'member.conversation', name: 'carol', incarnation: 1, conversationId: 'chat-new', replaced: 'chat-1' });
  e('engine', { type: 'member.routed', name: 'ben', incarnation: 2, provider: 'claude', worker: 'acct2', accountKey: '/acct2', model: 'opus', modelSource: 'worker', reason: 'acct1: quota', cause: 'failover' });
  const r = await w.core.resume('old', 'lead');
  const both = await waitFor(() => w.driver.callsOf('carol').length === 1 && w.driver.callsOf('ben').length === 1, { timeoutMs: 3000 });
  const carol = w.memberEvents('turn.planned', 'carol').at(-1);
  const ben = w.memberEvents('turn.planned', 'ben').at(-1);
  check('E15 context-lost before the restart → the next turn is a rebrief on the NEW id, carrying the brief', r.ok && both && carol?.trigger === 'rebrief' && w.driver.callsOf('carol')[0].spec.expectedConversationId === 'chat-new' && w.driver.callsOf('carol')[0].spec.prompt.includes('# Team protocol'), { carol, spec: w.driver.callsOf('carol')[0]?.spec.prompt?.slice(0, 200) });
  check('E15 a failover incarnation that never ran → a packet turn with the hand-off note', both && ben?.trigger === 'packet' && ben.incarnation === 2 && w.driver.callsOf('ben')[0].spec.prompt.includes('hand-off'), ben);
});

scenario('T11 E19: a failed turn.ended append is retried minimal, then the member is blocked in memory (A33)', async () => {
  const w = makeWorld();
  await createTeam(w, { members: [member('alice', { start: false })] });
  await waitFor(() => w.stateOf('alice') === 'idle');
  w.store.failTypes.push({ type: 'turn.ended', code: 'line-too-long' });
  await w.core.send({ to: 'alice', text: 'one turn whose end record is too long the first time' }, 'lead');
  const ended = await waitFor(() => w.ev('turn.ended')[0], { timeoutMs: 3000 });
  await idle(w, 'alice');
  check('E19 one failure → the minimal turn.ended (no text) lands and the member is idle', ended?.text === '' && ended.note === undefined && w.stateOf('alice') === 'idle', ended);
  const w2 = makeWorld();
  await createTeam(w2, { members: [member('alice', { start: false })] });
  await waitFor(() => w2.stateOf('alice') === 'idle');
  w2.store.failTypes.push({ type: 'turn.ended', code: 'line-too-long' }, { type: 'turn.ended', code: 'io', errno: 'EIO' });
  await w2.core.send({ to: 'alice', text: 'one turn whose end cannot be recorded at all, sorry' }, 'lead');
  const told = await waitFor(() => w2.notices((m) => m.to === 'lead' && w2.textOf(m).includes('could not be recorded')).length === 1, { timeoutMs: 3000 });
  await w2.core.send({ to: 'alice', text: 'are you still there? this should not start a turn' }, 'lead');
  await sleep(120);
  check('E19 two failures → no turn.ended, the lead is told, the member (blocked in memory) starts no further turn', told && w2.ev('turn.ended').length === 0 && w2.driver.callsOf('alice').length === 1 && !w2.core.ownsTurn(w2.driver.callsOf('alice')[0].spec.turnId), { ended: w2.ev('turn.ended'), calls: w2.driver.callsOf('alice').length });
});

scenario('T11 S3/S7: NUL / lone surrogate in inline texts, control characters in one-line values → invalid_text, nothing created (A36)', async () => {
  const w = makeWorld();
  const r1 = await createTeam(w, { goal: 'Build\u0000 the thing.' });
  check('S3 a NUL in the goal → invalid_text, "Nothing was created.", no team', !r1.ok && r1.code === 'invalid_text' && r1.sentence.endsWith('Nothing was created.') && w.stores.created.length === 0, r1);
  const r2 = await createTeam(w, { members: [member('alice', { brief: 'Do the work.\u0000' })] });
  check('S3 a NUL in a member brief → invalid_text', !r2.ok && r2.code === 'invalid_text' && r2.sentence.includes('brief of alice'), r2);
  const r3 = await createTeam(w, { members: [member('alice', { role: 'reviewer\u0007' })] });
  check('S7 a control character in a role → invalid_text', !r3.ok && r3.code === 'invalid_text' && r3.sentence.includes('role of alice'), r3);
  const r4 = await createTeam(w, { tasks: [{ title: 'ok title', body: 'body \uD800 half' }] });
  check('S3 a lone surrogate in a task body → invalid_text', !r4.ok && r4.code === 'invalid_text', r4);
  const r5 = await createTeam(w, { title: 'Title\u001b[31m' });
  check('S7 an escape sequence in the team title → invalid_text', !r5.ok && r5.code === 'invalid_text' && w.stores.created.length === 0, r5);
  const r6 = await createTeam(w, { members: [member('alice', { start: false })], tasks: [{ title: 'a task' }] });
  const r7 = await w.core.board({ op: 'update', task: 'b1', note: 'see\u0000this' }, 'lead');
  const r8 = await w.core.board({ op: 'update', task: 'b1', title: 'new\ttitle' }, 'lead');
  check('S3/S7 board update: a NUL note and a tab in a title → invalid_text', r6.ok && !r7.ok && r7.code === 'invalid_text' && !r8.ok && r8.code === 'invalid_text', { r7, r8 });
});

scenario('T11 S9: reply_to only for a message the sender sent or received (A39)', async () => {
  const w = makeWorld();
  const answers = {};
  await createTeam(w, { members: [member('alice', { start: false }), member('bob', { start: false })] });
  await waitFor(() => w.stateOf('alice') === 'idle' && w.stateOf('bob') === 'idle');
  const toAlice = await w.core.send({ to: 'alice', text: 'alice: please review the retry policy and answer me' }, 'lead');
  w.driver.script('bob', {
    during: async () => {
      answers.peer = await w.core.memberTool('bob', 'team_send', { to: 'alice', text: 'alice, the retry policy is in src/net/retry.ts for your review' });
      answers.notMine = await w.core.memberTool('bob', 'team_send', { to: 'lead', text: 'answering a message I never received', reply_to: toAlice.value.msgId });
    },
  });
  w.driver.script('alice', {
    during: async () => {
      answers.mine = await w.core.memberTool('alice', 'team_send', { to: 'lead', text: 'answering the message you sent me', reply_to: toAlice.value.msgId });
    },
  });
  await w.core.send({ to: 'bob', text: 'bob: tell alice where the retry policy lives' }, 'lead');
  await waitFor(() => answers.notMine !== undefined && answers.mine !== undefined, { timeoutMs: 3000 });
  check('S9 a member replying to a message addressed to someone else → unknown_message', answers.notMine?.isError && answers.notMine.content[0].text.startsWith('unknown_message:'), answers.notMine);
  check('S9 the recipient may reply to it', answers.mine !== undefined && !answers.mine.isError, answers.mine);
  const peerId = /m\d+/.exec(answers.peer?.content[0].text ?? '')?.[0];
  const leadOwn = await w.core.send({ to: 'alice', text: 'following up on my own earlier message to you', replyTo: toAlice.value.msgId }, 'lead');
  const leadPeer = await w.core.send({ to: 'bob', text: 'replying to a message between two members', replyTo: peerId }, 'lead');
  check('S9 the lead may reply_to its own message, not to a member-to-member one', leadOwn.ok && peerId !== undefined && !leadPeer.ok && leadPeer.code === 'unknown_message', { leadOwn, leadPeer, peerId });
});

function seqOf(id) {
  return typeof id === 'string' ? Number(id.slice(1)) : NaN;
}

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

const started = Date.now();
for (const s of scenarios) {
  if (ONLY !== undefined && !s.name.includes(ONLY)) continue;
  console.log(`\n# ${s.name}`);
  try {
    await s.fn();
  } catch (err) {
    check(`${s.name.split(':')[0]}: ran without throwing`, false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  }
}
console.log(`\n${passed} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(' · ')}`);
}
if (!KEEP) {
  fs.rmSync(BASE, { recursive: true, force: true });
} else {
  console.log(`kept ${BASE}`);
}
process.exit(failures.length === 0 ? 0 : 1);
