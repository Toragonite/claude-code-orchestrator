#!/usr/bin/env node
// reports.mjs — what a dispatch does when the NAME of its report (`tasks/<id>.md`) has been
// taken over while the worker ran: by a symbolic link, a dangling link, a FIFO nobody reads, a
// directory, or a regular file that is also a hard link to a file elsewhere.
//
//   node .orchestrator/fixes/reports.mjs                 every case, on the CURRENT sources
//   node .orchestrator/fixes/reports.mjs --only fifo     cases whose name contains "fifo"
//   node .orchestrator/fixes/reports.mjs --src <dir>     bundle the server from <dir> (a copy of
//                                                        src/) instead — how the cases are shown
//                                                        to FAIL on the code before the fix
//
// Each case starts a REAL dispatch server (a private esbuild bundle in a scratch directory,
// never `out/`) inside a sandbox of the session-worker harness (../mesh2/helpers2.mjs — its
// fake `claude`, its throwaway HOME, its hermetic environment), dispatches one task, waits
// until the worker is running, puts the obstacle at the report's name, and lets the worker
// finish. Two kinds of dispatch: a one-shot worker (`claude -p`) and a session worker
// (`claude --bg`). No real agent CLI is started and nothing outside the sandbox is touched.
//
// A case passes when the dispatch ENDS within 30 s of the obstacle being planted, with the
// worker's own outcome; nothing was written through the obstacle; and the server still answers
// afterwards. `PASS <name>` / `FAIL <name> — <why>` per case, a tally last, exit 0 only when
// every case passed. At most one server and its fake workers are alive at a time.
import keychainGuard from './keychain-guard.cjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-reports', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const SRC = path.resolve(opt('--src', path.join(REPO, 'src')));
const ONLY = opt('--only');
/** How long a dispatch may take to end once the obstacle is in place and the worker is done. */
const END_WITHIN_MS = 30_000;

if (process.platform === 'win32') {
  console.log('SKIP reports.mjs — symbolic links and FIFOs are what this exercises');
  process.exit(0);
}

// ---- a private build of the server, beside its supervisor and helper as shipped ----------------

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-reports-'));
const SERVER_JS = path.join(WORK, 'out', 'mcp', 'server.js');
{
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  for (const entry of ['server', 'run-task', 'provider-cli']) {
    await esbuild.build({
      entryPoints: [path.join(SRC, 'mcp', `${entry}.ts`)],
      bundle: true,
      platform: 'node',
      target: 'node18',
      logLevel: 'error',
      // A copied source tree has no node_modules above it.
      nodePaths: [path.join(REPO, 'node_modules')],
      outfile: path.join(WORK, 'out', 'mcp', `${entry}.js`),
    });
  }
}
// The harness reads this when it is loaded, so it is set first and the harness imported after.
process.env.MESH2_SERVER_JS = SERVER_JS;
const h = await import('../mesh2/helpers2.mjs');

// ---- plumbing ------------------------------------------------------------------------------

const tally = { pass: 0, fail: 0 };
const oneLine = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 600);
const ORIGINAL = 'ORIGINAL — a file that belongs to somebody else\n';

/** Resolve with `promise`, or reject after `ms` — the difference between "ended" and "hung". */
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The obstacles. Each `plant(name, elsewhere)` puts one at `name` (the report's path, which the
 * RUNNING report occupies — removed first) and returns what must still be true afterwards.
 */
const OBSTACLES = {
  'a symlink to a file elsewhere': {
    replaced: true,
    plant(name, elsewhere) {
      fs.writeFileSync(elsewhere, ORIGINAL);
      fs.symlinkSync(elsewhere, name);
      return () => assert.equal(fs.readFileSync(elsewhere, 'utf8'), ORIGINAL, "the report was written over the link's target");
    },
  },
  'a dangling symlink': {
    replaced: true,
    plant(name, elsewhere) {
      fs.symlinkSync(elsewhere, name);
      return () => assert.equal(fs.existsSync(elsewhere), false, 'a file was created at the target of the dangling link');
    },
  },
  'a fifo with no reader': {
    replaced: true,
    plant(name) {
      assert.equal(spawnSync('mkfifo', [name]).status, 0, 'mkfifo failed');
      return () => {};
    },
  },
  'a directory': {
    replaced: false,
    plant(name) {
      fs.mkdirSync(name);
      fs.writeFileSync(path.join(name, 'inside'), ORIGINAL);
      return () => {
        assert.ok(fs.lstatSync(name).isDirectory(), 'the directory at the name was removed');
        assert.equal(fs.readFileSync(path.join(name, 'inside'), 'utf8'), ORIGINAL, 'the directory at the name was changed');
      };
    },
  },
  'a regular file that is a hard link to a file elsewhere': {
    replaced: true,
    plant(name, elsewhere) {
      fs.writeFileSync(elsewhere, ORIGINAL);
      fs.chmodSync(elsewhere, 0o644);
      fs.linkSync(elsewhere, name);
      return () => assert.equal(fs.readFileSync(elsewhere, 'utf8'), ORIGINAL, 'the report was written INTO the file at the name, which is also the file elsewhere');
    },
  },
};

/**
 * The two kinds of dispatch. `start` returns once the worker is running and can be made to
 * finish: `{ id, finish(), pending, marker }`.
 */
const DISPATCHES = {
  'one-shot': {
    fixture: { registry: { meshMode: 'off' }, scenario: { oneShot: { mode: 'success', delayMs: 3000 } } },
    marker: h.ONESHOT_MARKER,
    async start(fx, srv, title) {
      const pending = srv.callTool('dispatch_task', { title, prompt: 'reports.mjs: answer in one line.' }, 120_000);
      const running = await h.waitFor(() => fx.eventsFor(title).find((e) => e.status === 'running' && typeof e.pid === 'number'), {
        timeoutMs: 40_000,
        label: 'the one-shot worker to be running',
      });
      // The fake answers by itself after its delay.
      return { id: running.id, pending, finish() {} };
    },
  },
  'session worker': {
    fixture: { workspace: 'plain', scenario: { bg: { default: { kind: 'never' } } } },
    marker: 'FAKE2_REPORT done',
    async start(fx, srv, title) {
      const pending = srv.callTool('dispatch_task', { title, prompt: 'reports.mjs: do the work and report done.' }, 180_000);
      let early;
      pending.then((answer) => (early = answer), () => {});
      const spawned = await h.waitFor(
        () => {
          if (early) {
            throw new Error(`the dispatch answered before its session worker was told to report: ${early.text.slice(0, 300)}`);
          }
          const hit = fx.bgSpawns()[0];
          return hit && hit.exitCode === 0 && fx.job(hit.jobId)?.pid ? hit : undefined;
        },
        { timeoutMs: 60_000, label: 'the session worker to be spawned' },
      );
      const running = await h.waitFor(() => fx.eventsFor(title).find((e) => e.status === 'running'), { timeoutMs: 10_000, label: 'a running event' });
      return { id: running.id, pending, finish: () => fx.command(spawned.jobId, 'result-done') };
    },
  },
};

async function runCase(dispatchName, obstacleName) {
  const dispatch = DISPATCHES[dispatchName];
  const obstacle = OBSTACLES[obstacleName];
  const title = `reports ${dispatchName} ${obstacleName}`.replace(/[^A-Za-z0-9 ]/g, '');
  const fx = h.makeFixture({ label: 'reports', workers: [{ name: 'wa' }], ...dispatch.fixture });
  let srv;
  try {
    srv = await fx.startServer();
    const run = await dispatch.start(fx, srv, title);
    const name = path.join(fx.orchRoot, 'tasks', `${run.id}.md`);
    const elsewhere = path.join(path.dirname(fx.orchRoot), 'elsewhere.txt');
    assert.ok(fs.lstatSync(name).isFile(), 'fixture: the RUNNING report is not there to be replaced');
    fs.rmSync(name);
    const stillTrue = obstacle.plant(name, elsewhere);
    run.finish();

    // 1. It ENDS. A server whose only thread is stuck in a write never answers.
    const answer = await within(run.pending, END_WITHIN_MS, 'the end of the dispatch');
    // 2. With the worker's own outcome.
    assert.equal(answer.isError, false, `the dispatch failed: ${answer.text.slice(0, 300)}`);
    assert.ok(answer.text.includes(dispatch.marker), `the worker's text is not in the result: ${answer.text.slice(0, 300)}`);
    const events = fx.eventsFor(title);
    assert.ok(events.some((e) => e.status === 'done') && !events.some((e) => e.status === 'error'), `the task log does not say done: ${events.map((e) => e.status).join(' → ')}`);
    // 3. Nothing was written through the obstacle.
    stillTrue();
    if (obstacle.replaced) {
      const st = fs.lstatSync(name);
      assert.ok(st.isFile(), `the name does not hold a regular file now (${st.isSymbolicLink() ? 'still a link' : st.isFIFO() ? 'still a FIFO' : 'something else'})`);
      const report = fs.readFileSync(name, 'utf8');
      assert.ok(report.includes('## Result') && report.includes(dispatch.marker), `the file at the name is not the report: ${report.slice(0, 200)}`);
      assert.equal((st.mode & 0o777).toString(8), '600', 'the report is readable by others');
      assert.equal(st.nlink, 1, 'the report is still a hard link to another file');
    } else if (dispatchName === 'one-shot') {
      // The one-shot core says so in the result when its report could not be written.
      assert.match(answer.text, /note: the output file of this task was NOT written/, `no note about the unwritten report: ${answer.text.slice(-300)}`);
    }
    assert.deepEqual(fs.readdirSync(path.join(fx.orchRoot, 'tasks')).filter((n) => n.endsWith('.tmp')), [], 'a temporary file was left in the tasks directory');
    // 4. And the server is still there for the next request.
    const after = await within(srv.callTool('list_workers', {}, 20_000), 20_000, 'an answer to the next request');
    assert.equal(after.isError, false, `the server did not answer normally afterwards: ${after.text.slice(0, 200)}`);
  } finally {
    // A server stuck in a blocking open does not notice its stdin closing: no patience for it.
    srv?.kill();
    await fx.cleanup();
  }
}

for (const dispatchName of Object.keys(DISPATCHES)) {
  for (const obstacleName of Object.keys(OBSTACLES)) {
    const name = `${dispatchName}: the report's name taken by ${obstacleName}`;
    if (ONLY && !name.includes(ONLY)) {
      continue;
    }
    while (os.loadavg()[0] > 30) {
      await h.sleep(5000);
    }
    try {
      await runCase(dispatchName, obstacleName);
      tally.pass++;
      console.log(`PASS ${name}`);
    } catch (err) {
      tally.fail++;
      console.log(`FAIL ${name} — ${oneLine(err)}`);
    }
  }
}

await h.cleanupAll();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${tally.pass} passed, ${tally.fail} failed — src: ${SRC}`);
process.exit(tally.fail === 0 ? 0 : 1);
