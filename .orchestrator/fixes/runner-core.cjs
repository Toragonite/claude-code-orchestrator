// runner-core.cjs — one scenario of .orchestrator/fixes/runner.mjs, run INSIDE a bundle of the
// dispatch core rather than through a server.
//
//   node runner-core.cjs <core bundle (.cjs)> <scenario>
//
// The parent starts this file with HOME (and USERPROFILE) already pointing at a fresh scratch
// directory, RUNNER_FAKE naming the fake `claude` and RUNNER_FAKE_LOG the file it logs to. The
// bundle is loaded only after the fixture is written, so the registry module computes its data
// root under that scratch HOME and nothing here can reach the real one.
//
// Why a scenario runs here at all: a server answers nothing to a cancelled request, so what a
// cancelled dispatch FAILS with is only visible to its host; and module state — the dispatch
// gate's counters, the stats pause — can only be read from inside the process that holds it.
//
// Prints exactly one line `RESULT <json>` and exits 0; anything else is a crash of the scenario.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const [bundlePath, scenario] = process.argv.slice(2);
const HOME = process.env.HOME;
const FAKE = process.env.RUNNER_FAKE;
const FAKE_LOG = process.env.RUNNER_FAKE_LOG;
if (!bundlePath || !scenario || !HOME || !FAKE || !FAKE_LOG) {
  process.stderr.write('usage: HOME=<scratch> RUNNER_FAKE=<fake> RUNNER_FAKE_LOG=<file> node runner-core.cjs <bundle> <scenario>\n');
  process.exit(2);
}
if (path.resolve(HOME) === path.resolve(os.userInfo().homedir)) {
  process.stderr.write('REFUSING TO RUN: HOME is the real home directory\n');
  process.exit(2);
}

const ROOT = path.join(HOME, '.claude-code-orchestrator');
const TASKS = path.join(ROOT, 'tasks');
const MISSING_CLI = path.join(HOME, 'missing', 'cco-runner-absent-cli');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A registry with Claude Code workers `wa` and `wb` on the fake, plus whatever is merged in. */
function writeFixture({ registry = {}, extraWorkers = [], workers } = {}) {
  fs.mkdirSync(TASKS, { recursive: true });
  const names = workers ?? ['wa', 'wb'];
  const entries = names.map((name) => ({ name, configDir: path.join(HOME, 'configs', name), model: 'opus' }));
  for (const e of entries) fs.mkdirSync(e.configDir, { recursive: true });
  fs.chmodSync(FAKE, 0o755);
  const reg = {
    workers: [...entries, ...extraWorkers],
    permissionMode: 'acceptEdits',
    claudePath: FAKE,
    cooldownMinutes: 30,
    workerTimeoutMinutes: 2,
    frontierWorkerDispatch: 'block',
    overageWorkerDispatch: 'block',
    ...registry,
  };
  writeRegistry(reg);
  const now = Date.now();
  const future = new Date(now + 6 * 3600_000).toISOString();
  const usage = {};
  for (const e of entries) {
    usage[e.configDir] = {
      name: e.name,
      configDir: e.configDir,
      available: true,
      subscriptionType: 'max',
      windows: [
        { kind: 'session', label: 'Session (5hr)', percent: 5, severity: 'normal', resetsAt: future },
        { kind: 'weekly_all', label: 'Weekly (7 day)', percent: 5, severity: 'normal', resetsAt: future },
      ],
      sessionCostUsd: 0,
      extraUsage: { enabled: false, percent: null, spendLabel: null },
      fetchedAt: now,
      windowsFetchedAt: now,
      windowsStale: false,
      lastGoodWindowsAt: now,
    };
  }
  fs.writeFileSync(path.join(ROOT, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(ROOT, 'stats.json'), '{}');
  return reg;
}

function writeRegistry(reg) {
  const file = path.join(ROOT, 'registry.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(reg, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { torn: true };
      }
    });
}
const events = () => readJsonl(path.join(ROOT, 'tasks.jsonl'));
const fakeLog = () => readJsonl(FAKE_LOG);
const fakeRuns = () => fakeLog().filter((r) => r.ev === 'mode');
const readStatsFile = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'stats.json'), 'utf8'));
  } catch {
    return {};
  }
};

/** A host context that records what the core asked of it. `over` replaces hooks. */
function host(over = {}) {
  const seen = { tracked: [], spawned: [], settled: [], results: [], children: [] };
  const ctx = {
    shouldAbort: () => false,
    onTrack: (base) => seen.tracked.push(base),
    onSpawn: (id, child) => {
      seen.spawned.push(id);
      seen.children.push(child);
    },
    onSettle: (id) => seen.settled.push(id),
    onResult: (r) => seen.results.push(r),
    ...over,
  };
  return { ctx, seen };
}

/** `{ ok, text }` of one dispatch — a rejection is an answer here, not a throw. */
async function dispatch(core, args, ctx) {
  const started = Date.now();
  try {
    const text = await core.runDispatchTask(args, ctx);
    return { ok: true, text, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

const SCENARIOS = {
  /** Wrong-typed arguments, one field at a time: the refusal, and that nothing else happened. */
  async args(core) {
    writeFixture();
    const cases = [
      ['arguments: null', null],
      ['arguments: array', ['x']],
      ['title: array', { title: ['x'], prompt: 'ok' }],
      ['title: number', { title: 7, prompt: 'ok' }],
      ['prompt: number', { title: 't', prompt: 123 }],
      ['prompt: object', { title: 't', prompt: { a: 1 } }],
      ['prompt: absent', { title: 't' }],
      ['prompt: blank', { title: 't', prompt: '   ' }],
      ['prompt: NUL', { title: 't', prompt: 'a\u0000b' }],
      ['system_prompt: number', { title: 't', prompt: 'ok', system_prompt: 7 }],
      ['system_prompt: NUL', { title: 't', prompt: 'ok', system_prompt: 'a\u0000b' }],
      ['model: object', { title: 't', prompt: 'ok', model: { x: 1 } }],
      ['model: 10k', { title: 't', prompt: 'ok', model: 'a'.repeat(10000) }],
      ['worker: object', { title: 't', prompt: 'ok', worker: { name: 'wa' } }],
      ['worker: number', { title: 't', prompt: 'ok', worker: 42 }],
      ['provider: object', { title: 't', prompt: 'ok', provider: {} }],
      ['ultrathink: "yes"', { title: 't', prompt: 'ok', ultrathink: 'yes' }],
      ['ultrathink: 1', { title: 't', prompt: 'ok', ultrathink: 1 }],
      ['detach: "true"', { title: 't', prompt: 'ok', detach: 'true' }],
      ['timeout_minutes: object', { title: 't', prompt: 'ok', timeout_minutes: {} }],
      ['timeout_minutes: true', { title: 't', prompt: 'ok', timeout_minutes: true }],
    ];
    const results = [];
    const { ctx, seen } = host();
    for (const [name, args] of cases) {
      const r = await dispatch(core, args, ctx);
      results.push({ name, ok: r.ok, text: r.text });
    }
    return {
      results,
      events: events().length,
      tracked: seen.tracked.length,
      settled: seen.settled.length,
      fakeStarts: fakeLog().length,
      taskFiles: fs.readdirSync(TASKS),
      gate: core.dispatchGateStats(),
    };
  },

  /** A 10 MB title: what the host is handed, what is logged, what the output file says. */
  async title(core) {
    writeFixture();
    const huge = 'T\n'.repeat(5 * 1024 * 1024);
    const { ctx, seen } = host();
    const r = await dispatch(core, { title: huge, prompt: '[[fake:ok]] [[tag:title]]' }, ctx);
    const evs = events();
    const outputFile = evs.find((e) => typeof e.outputFile === 'string')?.outputFile;
    const fileText = outputFile ? fs.readFileSync(outputFile, 'utf8') : '';
    return {
      ok: r.ok,
      resultChars: r.text.length,
      trackedTitles: seen.tracked.map((b) => ({ chars: String(b.title).length, oneLine: !/[\r\n]/.test(String(b.title)) })),
      eventTitles: evs.map((e) => ({ chars: String(e.title).length, oneLine: !/[\r\n]/.test(String(e.title)) })),
      logBytes: fs.statSync(path.join(ROOT, 'tasks.jsonl')).size,
      headerLine: fileText.split('\n', 1)[0].length,
      fileBytes: Buffer.byteLength(fileText),
      resultTitle: seen.results.map((x) => x.text.length),
    };
  },

  /** A request cancelled while its dispatch waits for a slot. */
  async 'cancel-waiting'(core) {
    writeFixture({ registry: { maxConcurrentDispatches: 1 } });
    const a = host();
    const first = dispatch(core, { title: 'holder', prompt: '[[fake:delay:1500]] [[tag:holder]]' }, a.ctx);
    await sleep(150);
    let cancelled = false;
    const b = host({ shouldAbort: () => cancelled });
    const second = dispatch(core, { title: 'waiter', prompt: '[[fake:delay:200]] [[tag:waiter]]' }, b.ctx);
    await sleep(150);
    const whileWaiting = core.dispatchGateStats();
    const eventsWhileWaiting = events().filter((e) => e.title === 'waiter').length;
    cancelled = true;
    const waiter = await second;
    const afterCancel = core.dispatchGateStats();
    const holder = await first;
    return {
      waiter,
      holder: { ok: holder.ok, text: holder.text.slice(0, 200) },
      whileWaiting,
      eventsWhileWaiting,
      afterCancel,
      atEnd: core.dispatchGateStats(),
      waiterTracked: b.seen.tracked.length,
      waiterSettled: b.seen.settled.length,
      waiterEvents: events().filter((e) => e.title === 'waiter').length,
      waiterRuns: fakeRuns().filter((r) => r.tag === 'waiter').length,
      waiterFiles: fs.readdirSync(TASKS).length,
    };
  },

  /** The DONE and the FAILED output file cannot be written (their path is a directory). */
  async outfile(core) {
    writeFixture();
    fs.mkdirSync(path.join(TASKS, 'tfixdone1.md'));
    fs.mkdirSync(path.join(TASKS, 'tfixfail1.md'));
    const done = await dispatch(core, { title: 'done-file', prompt: '[[fake:ok]] [[tag:donefile]]' }, host({ preassignedId: 'tfixdone1' }).ctx);
    const failed = await dispatch(core, { title: 'failed-file', prompt: '[[fake:fail]] [[tag:failfile]]' }, host({ preassignedId: 'tfixfail1' }).ctx);
    const evs = events();
    return {
      done: { ok: done.ok, text: done.text },
      failed: { ok: failed.ok, text: failed.text },
      doneEvents: evs.filter((e) => e.id === 'tfixdone1').map((e) => e.status),
      failedEvents: evs.filter((e) => e.id === 'tfixfail1').map((e) => ({ status: e.status, error: e.error })),
      stats: readStatsFile(),
      runs: fakeRuns().map((r) => r.tag),
      gate: core.dispatchGateStats(),
    };
  },

  /** Another process holds the stats lock for longer than the lock's own wait. */
  async 'stats-pause'(core) {
    writeFixture();
    const lock = path.join(ROOT, 'stats.json.lock');
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const r=require(${JSON.stringify(bundlePath)});r.updateStats(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000)})`,
      ],
      { env: process.env, stdio: 'ignore' },
    );
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        let there = false;
        try {
          fs.lstatSync(lock);
          there = true;
        } catch {
          there = false;
        }
        if (there) break;
        if (Date.now() > deadline) throw new Error('the lock holder never took the stats lock');
        await sleep(50);
      }
      const first = await dispatch(core, { title: 'stall', prompt: '[[fake:ok]] [[tag:stall]]', worker: 'wa' }, host().ctx);
      const second = await dispatch(core, { title: 'skip', prompt: '[[fake:ok]] [[tag:skip]]', worker: 'wa' }, host().ctx);
      // A quota failure while stats writes are paused: its cooldown must still be honoured.
      const third = await dispatch(core, { title: 'quota', prompt: '[[fake:quota-once:pause]] [[tag:pausequota]]' }, host().ctx);
      const quotaRuns = fakeRuns().filter((r) => r.tag === 'pausequota');
      const cooled = quotaRuns.length > 0 ? core.workerCooldownUntil(core.readStats(), quotaRuns[0].account) : 0;
      return {
        first: { ok: first.ok, ms: first.ms, text: first.text },
        second: { ok: second.ok, ms: second.ms, text: second.text },
        third: { ok: third.ok, ms: third.ms, text: third.text },
        quotaAccounts: quotaRuns.map((r) => r.account),
        cooldownHeld: cooled > Date.now(),
        statsOnDisk: readStatsFile(),
        gate: core.dispatchGateStats(),
      };
    } finally {
      try {
        holder.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  },

  /** A dispatch that names a registry entry this version cannot use. */
  async unsupported(core) {
    const extra = [
      { name: 'future', configDir: path.join(HOME, 'configs', 'future'), provider: 'copilot-next' },
      { name: 'half' },
    ];
    writeFixture({ extraWorkers: extra });
    const unsupported = (core.readRegistry().unsupportedWorkers ?? []).map((e) => ({ name: e.name, reason: e.reason }));
    const h = host();
    const future = await dispatch(core, { title: 'u1', prompt: '[[fake:ok]]', worker: 'future' }, h.ctx);
    const half = await dispatch(core, { title: 'u2', prompt: '[[fake:ok]]', worker: 'half' }, h.ctx);
    const nobody = await dispatch(core, { title: 'u3', prompt: '[[fake:ok]]', worker: 'nobody' }, h.ctx);
    // What the three refusals left behind — before the fixture is rewritten below.
    const left = { events: events().length, taskFiles: fs.readdirSync(TASKS), tracked: h.seen.tracked.length, settled: h.seen.settled.length };
    // The same question when NO entry is usable.
    writeFixture({ workers: [], extraWorkers: extra });
    const alone = await dispatch(core, { title: 'u4', prompt: '[[fake:ok]]', worker: 'future' }, h.ctx);
    const empty = await dispatch(core, { title: 'u5', prompt: '[[fake:ok]]' }, h.ctx);
    return { unsupported, future, half, nobody, left, alone, empty, runs: fakeRuns().length, gate: core.dispatchGateStats() };
  },

  /**
   * Limit 2, one dispatch alone and then seven at once, ending in every way a dispatch can end —
   * then the gate's own counters, read from inside the process that holds them. Seven, not more:
   * on a build without the gate all of them run together, and this harness keeps to eight
   * children.
   */
  async 'gate-drain'(core) {
    const reg = writeFixture({ registry: { maxConcurrentDispatches: 2 } });
    let alive = 0;
    let peak = 0;
    const watch = (child) => {
      // The core hands over the child of a spawn that FAILED too; it has no pid and never exits.
      if (typeof child.pid !== 'number') return;
      alive++;
      peak = Math.max(peak, alive);
      child.once('exit', () => alive--);
    };
    const plain = () =>
      host({
        onSpawn: (_id, child) => watch(child),
      });
    // The spawn failure goes first and alone: `claudePath` is one value for the whole server.
    writeRegistry({ ...reg, claudePath: MISSING_CLI });
    const missing = host();
    const enoent = await dispatch(core, { title: 'g-enoent', prompt: '[[fake:ok]]', worker: 'wa' }, missing.ctx);
    writeRegistry(reg);
    // Whether the host was handed the child of that spawn, and whether an event names a pid for it.
    const enoentSpawned = missing.seen.spawned.length;
    const enoentPidEvents = events().filter((e) => e.title === 'g-enoent' && e.pid !== undefined).length;

    let cancelRunning = false;
    const running = host({
      shouldAbort: () => cancelRunning,
      onSpawn: (_id, child) => {
        watch(child);
        // What the server's cancelRequest does: mark the request, then signal the child.
        setTimeout(() => {
          cancelRunning = true;
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }, 400);
      },
    });
    let cancelWaiting = false;
    const waiting = host({ shouldAbort: () => cancelWaiting, onSpawn: (_id, child) => watch(child) });
    const all = {
      success: dispatch(core, { title: 'g-ok', prompt: '[[fake:delay:700]] [[tag:g-ok]]' }, plain().ctx),
      cancelledRunning: dispatch(core, { title: 'g-cancel-run', prompt: '[[fake:hang]] [[tag:g-cancel-run]]' }, running.ctx),
      cancelledWaiting: dispatch(core, { title: 'g-cancel-wait', prompt: '[[fake:delay:300]] [[tag:g-cancel-wait]]' }, waiting.ctx),
      failed: dispatch(core, { title: 'g-fail', prompt: '[[fake:fail]] [[tag:g-fail]]' }, plain().ctx),
      failover: dispatch(core, { title: 'g-quota', prompt: '[[fake:quota-once:gate]] [[tag:g-quota]]' }, plain().ctx),
      overflow: dispatch(core, { title: 'g-big', prompt: '[[fake:bigout:12]] [[tag:g-big]]' }, plain().ctx),
      last: dispatch(core, { title: 'g-last', prompt: '[[fake:delay:200]] [[tag:g-last]]' }, plain().ctx),
    };
    await sleep(200);
    const midway = core.dispatchGateStats();
    cancelWaiting = true;
    const out = {};
    for (const [name, promise] of Object.entries(all)) {
      const r = await promise;
      out[name] = { ok: r.ok, text: r.text.slice(0, 240) };
    }
    return {
      enoent: { ok: enoent.ok, text: enoent.text.slice(0, 240) },
      enoentSpawned,
      enoentPidEvents,
      ...out,
      midway,
      peak,
      aliveAtEnd: alive,
      gate: core.dispatchGateStats(),
      runsByTag: fakeRuns().reduce((acc, r) => ((acc[r.tag] = (acc[r.tag] ?? 0) + 1), acc), {}),
      waitingTracked: waiting.seen.tracked.length,
      cooled: Object.entries(readStatsFile())
        .filter(([, s]) => typeof s.cooldownUntil === 'number' && s.cooldownUntil > Date.now())
        .map(([name]) => name),
    };
  },

  /**
   * The id rule of the event writer, as a dispatch meets it: through the record writer, which
   * must report the refusal and leave the outcome alone, and through a host that hands the core
   * an id that cannot name a file.
   */
  async 'event-id'(core) {
    writeFixture();
    const logBytes = () => {
      try {
        return fs.readFileSync(path.join(ROOT, 'tasks.jsonl')).length;
      } catch {
        return 0;
      }
    };
    const badId = '../SENTINEL_evil';
    const event = { id: badId, ts: Date.now(), status: 'done', title: 'x', worker: 'wa', model: 'opus', outputFile: '/x', cwd: '/y' };
    const books = new core.TaskBookkeeping(badId, true);
    let threw = null;
    try {
      books.progressEvent({ ...event, status: 'running', error: 'quota error on wa — failing over' });
      books.terminalEvent(event);
    } catch (err) {
      threw = String(err && err.message);
    }
    const note = books.resultNote();
    // The same writer, with an id that is one: nothing to say.
    const fine = new core.TaskBookkeeping('tgoodid00001', true);
    fine.terminalEvent({ ...event, id: 'tgoodid00001' });
    const fineNote = fine.resultNote();
    const goodLines = events().length;
    // The whole core, handed such an id by its host.
    const before = logBytes();
    const h = host({ preassignedId: badId });
    const r = await dispatch(core, { title: 'event-id', prompt: '[[fake:ok]] [[tag:event-id]]', worker: 'wa' }, h.ctx);
    return {
      threw,
      note,
      fineNote,
      goodLines,
      dispatch: { ok: r.ok, text: r.text.slice(0, 300) },
      logGrew: logBytes() - before,
      runs: fakeRuns().length,
      spawned: h.seen.spawned.length,
      settled: h.seen.settled.length,
      taskFiles: fs.readdirSync(TASKS),
      homeFiles: fs.readdirSync(HOME).filter((n) => n.includes('SENTINEL')),
      gate: core.dispatchGateStats(),
    };
  },

  /**
   * runClaude driven directly, with a limit of seconds — the dispatch arguments cannot ask for
   * less than a minute. What "timed out" means: the kill ended the child.
   */
  async limit(core) {
    writeFixture();
    if (typeof core.runClaude !== 'function') {
      return { exported: false };
    }
    const dir = path.join(HOME, 'configs', 'wa');
    const run = async (mode, tag) => {
      let pid;
      const started = Date.now();
      const gone = () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      try {
        const r = await core.runClaude(core.readRegistry(), dir, 'opus', `[[fake:${mode}]] [[tag:${tag}]]`, 1.2 / 60, undefined, (child) => {
          pid = child.pid;
        });
        return { ok: true, text: r.text, ms: Date.now() - started, gone: gone() };
      } catch (err) {
        return { ok: false, text: String(err && err.message).slice(0, 200), ms: Date.now() - started, gone: gone() };
      }
    };
    return {
      exported: true,
      quick: await run('delay:100', 'lim-quick'),
      hang: await run('hang', 'lim-hang'),
      termOk: await run('term-ok', 'lim-term-ok'),
      termError: await run('term-error', 'lim-term-error'),
      termEmpty: await run('term-empty', 'lim-term-empty'),
    };
  },

  /**
   * THIS process is stopped by the test (SIGSTOP) while its worker finishes, and resumed after
   * the limit has passed. The worker exits 0 with its whole result while nobody is looking.
   */
  async 'stop-claude'(core) {
    return stoppedRun(core, '[[fake:delay:500]] [[tag:stop-claude]]');
  },

  /** The same, with a worker that fails by itself (exit 3) while this process is stopped. */
  async 'stop-claude-fail'(core) {
    return stoppedRun(core, '[[fake:fail]] [[tag:stop-claude-fail]]');
  },

  /**
   * The whole core, with a host that cancels (marks the request, signals the worker's group —
   * what the server does) at +900 ms. The test stops this process before that and resumes it
   * after, so the worker finished long before the cancel. The mark is read off the clock, not
   * set by a timer: after a stall an expired timer and a pending exit can be handled in either
   * order, and this pin is about the order "the request is already marked cancelled when the
   * exit is handled". The signal still comes from a timer; by then there is no group to reach.
   */
  async 'stop-cancel'(core) {
    writeFixture();
    let spawnedAt = Infinity;
    let asked = 0;
    const cancelled = () => Date.now() - spawnedAt >= 900;
    const h = host({
      shouldAbort: () => {
        const yes = cancelled();
        asked += yes ? 1 : 0;
        return yes;
      },
      onSpawn: (_id, child) => {
        spawnedAt = Date.now();
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // the group is gone
          }
        }, 900);
      },
    });
    const r = await dispatch(core, { title: 'stop-cancel', prompt: '[[fake:delay:500]] [[tag:stop-cancel]]', worker: 'wa' }, h.ctx);
    const evs = events().filter((e) => e.title === 'stop-cancel');
    let file = '';
    try {
      file = fs.readFileSync(path.join(TASKS, `${evs[0].id}.md`), 'utf8');
    } catch {
      file = '';
    }
    return {
      ok: r.ok,
      // The whole text is long (it carries the path of the result file); the answer is what matters.
      hasAnswer: r.text.includes('FAKE_OK stop-cancel'),
      text: r.text.slice(0, 120),
      statuses: evs.map((e) => e.status),
      cancelledByThen: cancelled(),
      askedWhileCancelled: asked,
      fileHasResult: file.includes('## Result'),
    };
  },

  /**
   * The vendor path, in a providers-harness sandbox (HOME, PATH and the fake `codex` are the
   * sandbox's): one run through the real adapter and this module's process seam, with a limit
   * of seconds. The test stops this process while the fake finishes.
   */
  async 'stop-vendor'(core) {
    return vendorRun(core, { timeoutMs: 2000 });
  },

  /** The same, with the run cancelled (its `kill`) at +900 ms — while this process is stopped. */
  async 'stop-vendor-cancel'(core) {
    return vendorRun(core, { timeoutMs: 60_000, killAfterMs: 900 });
  },

  /**
   * The same, with BOTH due while this process is stopped: the limit at +800 ms and a cancel at
   * +900 ms, for a worker that finished at +500 ms. Two stops asked for in one turn of the loop.
   */
  async 'stop-vendor-both'(core) {
    return vendorRun(core, { timeoutMs: 800, killAfterMs: 900 });
  },

  /** No stop: a vendor worker that is still running when its run is cancelled TWICE in a row. */
  async 'vendor-cancel-twice'(core) {
    return vendorRun(core, { timeoutMs: 60_000, killAfterMs: 400, twice: true });
  },

  /** No stop: a vendor worker that is still running at its limit. */
  async 'vendor-limit'(core) {
    return vendorRun(core, { timeoutMs: 1500 });
  },

  /** No stop: a vendor worker that is still running when its run is cancelled. */
  async 'vendor-cancel-live'(core) {
    return vendorRun(core, { timeoutMs: 60_000, killAfterMs: 400 });
  },
};

/** One runClaude call with a 2-second limit, as `{ ok, text }`. */
async function stoppedRun(core, prompt) {
  writeFixture();
  if (typeof core.runClaude !== 'function') {
    return { exported: false };
  }
  const started = Date.now();
  try {
    const r = await core.runClaude(core.readRegistry(), path.join(HOME, 'configs', 'wa'), 'opus', prompt, 2 / 60);
    return { exported: true, ok: true, text: r.text, ms: Date.now() - started };
  } catch (err) {
    return { exported: true, ok: false, text: String(err && err.message).slice(0, 300), ms: Date.now() - started };
  }
}

/** One runProviderWorker call on the sandbox's Codex worker, as `{ ok, text | name }`. */
async function vendorRun(core, { timeoutMs, killAfterMs, twice = false }) {
  const worker = { name: 'cx', provider: 'codex', configDir: process.env.RUNNER_VENDOR_DIR, model: '' };
  const started = Date.now();
  let pid;
  try {
    const r = await core.providerRunner.runProviderWorker({
      worker,
      model: undefined,
      prompt: 'answer in one line',
      cwd: process.cwd(),
      timeoutMs,
      onChild: (kill, childPid) => {
        pid = childPid;
        if (killAfterMs !== undefined) {
          setTimeout(() => {
            kill();
            if (twice) {
              kill();
            }
          }, killAfterMs);
        }
      },
    });
    return { ok: true, text: r.text, ms: Date.now() - started, pid };
  } catch (err) {
    return { ok: false, name: err && err.name, text: String(err && err.message).slice(0, 300), ms: Date.now() - started, pid };
  }
}

(async () => {
  const run = SCENARIOS[scenario];
  if (run === undefined) {
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(2);
  }
  fs.mkdirSync(ROOT, { recursive: true });
  // Loaded HERE, after HOME is known to be the scratch one: the registry module fixes its data
  // root when it is first evaluated.
  const core = require(bundlePath);
  const result = await run(core);
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`, () => process.exit(0));
})().catch((err) => {
  process.stderr.write(`scenario ${scenario} crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
