// helpers.mjs — hermetic fixture + stdio JSON-RPC driver for the Phase 0 detach
// characterization probes. Everything here is isolation plumbing: a fake HOME so
// os.homedir() resolves to a throwaway .claude-code-orchestrator, a crafted
// registry/usage/stats, and a minimal newline-delimited JSON-RPC client that
// speaks to `out/mcp/server.js` over its stdio transport.

import keychainGuard from '../fixes/keychain-guard.cjs';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('detach', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DETACH_DIR = HERE;
// .orchestrator/detach → repo root is two levels up.
export const REPO_ROOT = path.resolve(HERE, '..', '..');
/**
 * The build under test: `<repo>/out` unless CCO_DETACH_OUT_DIR names another directory with
 * the same layout (`mcp/server.js`, `mcp/run-task.js`, `registry.js`). The override exists
 * for the case where `npm run compile` cannot finish — several workers edit this checkout at
 * once, and one file mid-change fails the whole tsc pass — so the harness can still be run
 * against bundles built into a scratch directory (README, "Running against another build").
 */
export const OUT_DIR = process.env.CCO_DETACH_OUT_DIR
  ? path.resolve(process.env.CCO_DETACH_OUT_DIR)
  : path.join(REPO_ROOT, 'out');
export const SERVER_JS = path.join(OUT_DIR, 'mcp', 'server.js');
// The detach supervisor. The server resolves it BESIDE its own bundle (`__dirname`), so it
// has to exist next to SERVER_JS for any detach probe to run.
export const RUN_TASK_JS = path.join(OUT_DIR, 'mcp', 'run-task.js');
// The tsc-emitted CommonJS module (NOT the server bundle) — it exports reapDeadTasks and
// updateStats so the reaper and lock probes can require and invoke them directly. A CommonJS
// esbuild bundle of src/registry.ts exports the same names and serves equally.
export const REGISTRY_JS = path.join(OUT_DIR, 'registry.js');
export const FAKE_CLAUDE = path.join(HERE, 'fake-claude.mjs');

/** Fail loudly with a build hint if any of the three artifacts the probes drive is missing. */
export function assertServerBuilt() {
  for (const file of [SERVER_JS, RUN_TASK_JS, REGISTRY_JS]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Build artifact not found at ${file}. Run \`npm run compile\` from the repo root first` +
          (process.env.CCO_DETACH_OUT_DIR ? ' (or fix CCO_DETACH_OUT_DIR).' : '.'),
      );
    }
  }
}

/**
 * Build an isolated fake HOME with a crafted .claude-code-orchestrator:
 *  - registry.json: two workers wa/wb with distinct config dirs, claudePath →
 *    the (absolute, executable) fake-claude stub, acceptEdits, both billing
 *    guards blocked, a small worker timeout. Both store the v1.x model id
 *    `claude-opus-4-8` ON PURPOSE: a registry written by 1.x holds exactly that, and
 *    2.0 must read it as the alias `opus` (contract-2.0 §3.1) — the header probes pin it.
 *  - usage.json: every worker available with low windows, overage disabled, fresh
 *    fetchedAt — so pickWorker neither refuses nor triggers a live auth re-probe.
 *  - stats.json: empty (no cooldowns).
 *  - tasks/: present and empty; tasks.jsonl absent until the first event.
 * Returns the paths the probes need. The workspace (server cwd) is a separate
 * temp dir so no repo `.mcp.json` is ever loaded.
 *
 * `opts.workers`, when given, replaces the two default workers: a function
 * `({ waDir, wbDir, homeClaudeDir }) => [{ name, configDir, model }, …]`. `homeClaudeDir`
 * is `<fakeHome>/.claude` — the CLI's DEFAULT config directory as a server running under
 * this fake HOME sees it, which is what the environment probe needs a worker to live in.
 * It is a path inside the throwaway home; the real `~/.claude` is never involved.
 */
export function makeFakeHome(opts = {}) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-detach-home-'));
  const root = path.join(fakeHome, '.claude-code-orchestrator');
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });

  // Distinct config dirs; the basenames wa/wb drive fake-claude's failover mode.
  const waDir = path.join(fakeHome, 'configs', 'wa');
  const wbDir = path.join(fakeHome, 'configs', 'wb');
  const homeClaudeDir = path.join(fakeHome, '.claude');

  // isSpawnableFile() (registry.ts) requires the execute bit on claudePath.
  fs.chmodSync(FAKE_CLAUDE, 0o755);

  const workers = opts.workers
    ? opts.workers({ waDir, wbDir, homeClaudeDir })
    : [
        { name: 'wa', configDir: waDir, model: 'claude-opus-4-8' },
        { name: 'wb', configDir: wbDir, model: 'claude-opus-4-8' },
      ];
  for (const dir of [waDir, wbDir, ...workers.map((w) => w.configDir)]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const registry = {
    workers,
    permissionMode: 'acceptEdits',
    claudePath: FAKE_CLAUDE,
    cooldownMinutes: 30,
    workerTimeoutMinutes: opts.workerTimeoutMinutes ?? 2,
    frontierWorkerDispatch: 'block',
    overageWorkerDispatch: 'block',
  };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry, null, 2));

  const now = Date.now();
  const future = new Date(now + 6 * 3600_000).toISOString();
  const account = (name, configDir) => ({
    name,
    configDir,
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
  });
  // Keyed by config dir, exactly as the usage cache is: one entry per ACCOUNT.
  const usage = {};
  for (const w of workers) {
    usage[w.configDir] = account(w.name, w.configDir);
  }
  fs.writeFileSync(path.join(root, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(root, 'stats.json'), JSON.stringify({}, null, 2));

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-detach-ws-'));
  // Where fake-claude records its invocations when a probe turns recording on
  // (recordingEnv). Inside the fake home, so it is torn down with it.
  const callsFile = path.join(fakeHome, 'fake-claude-calls.jsonl');
  return { fakeHome, root, workspace, waDir, wbDir, homeClaudeDir, callsFile };
}

/**
 * Environment additions that make fake-claude record every invocation into `fx.callsFile`.
 * `valueNames` are the variables whose VALUES are recorded as well as their presence — pass
 * only names the probe itself sets to marker values (see fake-claude.mjs, RECORDING).
 */
export function recordingEnv(fx, valueNames = []) {
  return {
    FAKE_CLAUDE_RECORD: fx.callsFile,
    FAKE_CLAUDE_RECORD_VALUES: valueNames.join(','),
  };
}

/**
 * Every fake-claude invocation recorded so far, in spawn order. An absent file is an empty
 * list — which, with recording on, is the proof that NOTHING was spawned.
 */
export function readFakeClaudeCalls(fx) {
  let raw;
  try {
    raw = fs.readFileSync(fx.callsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** The recorded invocations that are WORKER runs (`claude -p …`), as opposed to stray probes. */
export function workerCalls(fx) {
  return readFakeClaudeCalls(fx).filter((c) => Array.isArray(c.argv) && c.argv.includes('-p'));
}

/** The value following `flag` in a recorded argv, or undefined when the flag is absent. */
export function argvValue(call, flag) {
  const i = call.argv.indexOf(flag);
  return i >= 0 ? call.argv[i + 1] : undefined;
}

export function tasksLogPath(root) {
  return path.join(root, 'tasks.jsonl');
}

/** Path of a file under the fake root's tasks/ directory. */
export function taskFilePath(root, name) {
  return path.join(root, 'tasks', name);
}

/** Parse tasks/<id>.result.json (the detach handshake file), or undefined if absent/torn. */
export function readResultJson(root, id) {
  try {
    return JSON.parse(fs.readFileSync(taskFilePath(root, `${id}.result.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Path of the fake root's stats.json (the concurrent-writer probe reads it back). */
export function statsPath(root) {
  return path.join(root, 'stats.json');
}

/** Append one fabricated event object to the fake root's tasks.jsonl (mirrors appendTaskEvent). */
export function appendEvent(root, event) {
  fs.appendFileSync(tasksLogPath(root), JSON.stringify(event) + '\n');
}

/** Write a fabricated tasks/<id>.result.json for the reaper reconcile probes. */
export function writeResultFile(root, id, obj) {
  fs.writeFileSync(taskFilePath(root, `${id}.result.json`), JSON.stringify(obj));
}

/**
 * A per-task result token of the shape the dispatcher mints (src/ioToken.ts newIoToken: 16
 * random bytes as hex). Random per call, like the real one, so no probe can pass by
 * agreeing with a constant.
 */
export function newDetachToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** What the task log records for a result token (src/ioToken.ts ioTokenDigest): its SHA-256, as hex. */
export function detachTokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The 2.0 result header + text a dispatch returns and a supervisor records (contract-2.0 §3.2). */
export function resultText({ id, worker, model, outputFile, body }) {
  return `[worker: ${worker}, model: ${model}]\ntask: ${id} · output: ${outputFile}\n\n${body}`;
}

/**
 * Plant what a GENUINE detach supervisor (src/mcp/run-task.ts) leaves on disk for a task
 * whose worker finished and whose terminal event is not in the log — the append was refused
 * or lost — once the supervisor is gone: the task log still says `running`, both pids are
 * dead, and a valid tasks/<id>.result.json is waiting to be reconciled. (A supervisor writes
 * its record AFTER the terminal event, so a record with no terminal event is a lost append,
 * not a supervisor that died between the two — probe P6-1 pins that order.)
 *
 * WHY THE SHAPE MATTERS — this is the fixture P3-4 and P4-F2 were broken by not having.
 * tasks/<id>.result.json sits at a fixed path a dispatched worker can write, so the reader
 * (registry.readResultForTask) believes a file there only when the task's own EVENT HISTORY
 * says a supervisor existed and what its record must prove:
 *   1. some event of the task carries a numeric `supervisorPid` — only a detach supervisor
 *      ever records one, so a history without it has no legitimate writer of that file
 *      (refused: "no event of this dispatch records a detach supervisor");
 *   2. the first event carrying `detachIoTokenSha256` fixes what the file's `token` must
 *      hash to (refused: "the record does not carry this dispatch's result token"). The log
 *      holds the DIGEST of the token and never the token; the file holds the token.
 * So the events below are the four `running` events a real supervisor produces per attempt,
 * in its order — the core's identity event, the supervisor's digest stamp of it, the core's
 * pid event, the supervisor's digest stamp of that — and the record is its TaskResult plus
 * the token. Probe P5-6 runs a real supervisor and fails if this drifts from it.
 *
 * Every pid here must be DEAD (makeDeadPid). Returns what was planted.
 *
 * The override knobs exist for the probes that plant something other than what this version
 * writes: `supervisor: false` drops every supervisorPid (the pre-v1.6 fixture shape);
 * `resultToken` replaces the token the file carries (`null` omits the field); and
 * `legacyToken: true` records the token itself on the events, as `detachIoToken` — what a
 * build before digests wrote, and what a reader still has to accept.
 */
export function plantDeadDetachTask(root, opts) {
  const {
    id,
    title,
    workerPid,
    supervisorPid,
    worker = 'wa',
    model = 'opus',
    cwd = os.tmpdir(),
    prompt = 'planted detach task',
    body = 'STUB_RESULT_OK',
    usage = { inputTokens: 11, outputTokens: 22, costUsd: 0.001 },
    supervisor = true,
    token = newDetachToken(),
    legacyToken = false,
  } = opts;
  const resultToken = opts.resultToken === undefined ? token : opts.resultToken;
  const stamp = legacyToken ? { detachIoToken: token } : { detachIoTokenSha256: detachTokenDigest(token) };
  const outputFile = taskFilePath(root, `${id}.md`);
  const identity = {
    id,
    title,
    worker,
    model,
    modelSource: 'worker',
    outputFile,
    cwd,
    promptPreview: prompt,
    ...(supervisor ? { supervisorPid } : {}),
  };
  const now = Date.now();
  const withWorker = { pid: workerPid, pgid: workerPid };
  // The four running events of one attempt, in the order run-task/task-runner append them.
  appendEvent(root, { ...identity, ts: now - 400, status: 'running' });
  appendEvent(root, { ...identity, ts: now - 399, status: 'running', ...stamp });
  appendEvent(root, { ...identity, ts: now - 390, status: 'running', ...withWorker });
  appendEvent(root, { ...identity, ts: now - 389, status: 'running', ...withWorker, ...stamp });
  // The DONE output file the core writes before it would have appended the `done` event.
  fs.writeFileSync(
    outputFile,
    `# ${title}\n\n- worker: ${worker}\n- model: ${model}\n- tokens: ${usage.inputTokens} in / ` +
      `${usage.outputTokens} out (~$${usage.costUsd.toFixed(4)})\n\n---\n\n## Prompt\n\n${prompt}\n\n` +
      `## Result\n\n${body}\n`,
  );
  const text = resultText({ id, worker, model, outputFile, body });
  // run-task.writeResultJson: the TaskResult, plus `token` attached at serialization.
  const record = { id, status: 'done', text, worker, model, ...usage };
  if (resultToken !== null) {
    record.token = resultToken;
  }
  writeResultFile(root, id, record);
  return { id, outputFile, token, text, usage };
}

/**
 * Rewrite the task log without the events `drop(event)` selects. The log is append-only in
 * the product; this exists for one probe, which simulates a terminal append that was LOST
 * (no process may be writing the log when this runs). Returns how many events were dropped.
 */
export function dropEvents(root, drop) {
  const events = readEvents(root);
  const kept = events.filter((e) => !drop(e));
  fs.writeFileSync(tasksLogPath(root), kept.map((e) => JSON.stringify(e) + '\n').join(''));
  return events.length - kept.length;
}

/**
 * Invoke reapDeadTasks() from the freshly built out/registry.js with HOME=<fakeHome>,
 * in a child process so it resolves ROOT_DIR under the isolated fake home. Returns the
 * reaped count it prints to stdout.
 */
export function runReaper(fakeHome) {
  const res = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(require(${JSON.stringify(REGISTRY_JS)}).reapDeadTasks()))`],
    { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`reaper child exited ${res.status}: ${res.stderr || res.stdout || 'no output'}`);
  }
  return parseInt(String(res.stdout).trim(), 10) || 0;
}

/** A pid that is guaranteed DEAD: spawn a throwaway node sleeper, SIGKILL it, await its exit. */
export async function makeDeadPid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' });
  const pid = child.pid;
  child.kill('SIGKILL');
  await waitFor(() => !isPidAlive(pid), { timeoutMs: 5000, label: `throwaway pid ${pid} to die` });
  return pid;
}

/**
 * Spawn a LIVE process whose command line matches the TIGHTENED isOurSupervisor()
 * (registry.ts F4 — `ps -o args=` must include BOTH `run-task.js` AND this task's
 * `tasks/<id>.spec.json`): a real `run-task.js` entrypoint plus a second argv that
 * mirrors the server's per-task spec path. Used by the false-orphan guard probe (P3-5).
 * Returns its pid + a kill fn.
 */
export function spawnFakeSupervisor(fakeHome, id) {
  const script = path.join(fakeHome, 'run-task.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
  const specArg = path.join(fakeHome, '.claude-code-orchestrator', 'tasks', `${id}.spec.json`);
  const child = spawn(process.execPath, [script, specArg], { stdio: 'ignore' });
  return {
    pid: child.pid,
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Spawn a LIVE process whose command line contains 'run-task' ONLY inside an unrelated
 * filename (run-task-fake.mjs) and carries no spec path — the exact shape the loose old
 * substring check wrongly accepted. The tightened isOurSupervisor() must NOT match it, so
 * a task naming this pid as its supervisorPid still gets reaped (drives P4-F4). Returns its
 * pid + a kill fn.
 */
export function spawnLooseRunTaskProcess(fakeHome) {
  const stub = path.join(fakeHome, 'run-task-fake.mjs');
  fs.writeFileSync(stub, 'setInterval(() => {}, 1e9);\n');
  const child = spawn(process.execPath, [stub], { stdio: 'ignore' });
  return {
    pid: child.pid,
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}

/** Absolute path of the advisory lock file withFileLock() uses for `<targetFileName>`. */
export function lockPathFor(root, targetFileName) {
  return path.join(root, `${targetFileName}.lock`);
}

/**
 * Plant an ABANDONED advisory lock: write `<root>/<targetFileName>.lock` naming a DEAD pid,
 * so lockIsStale() judges it stale and the next writer must break it. Reproduces the
 * supervisor-crash-mid-critical-section condition F1 guards. Returns the lock path.
 */
export function plantStaleLock(root, targetFileName, deadPid) {
  const lockPath = lockPathFor(root, targetFileName);
  fs.writeFileSync(lockPath, `${deadPid} ${Date.now()}`);
  return lockPath;
}

/**
 * Spawn a child that hammers updateStats() from out/registry.js under HOME=<fakeHome>,
 * doing `times` increments of stats[key].tasks through the advisory lock. Spawns
 * immediately (so several calls run CONCURRENTLY); the returned promise resolves when the
 * child exits 0 and rejects otherwise. Drives the F1 lost-update stress (P4-F1).
 */
export function spawnUpdateStats(fakeHome, key, times) {
  const k = JSON.stringify(key);
  const code =
    `const r=require(${JSON.stringify(REGISTRY_JS)});` +
    `for(let i=0;i<${times};i++){r.updateStats(s=>{` +
    `s[${k}]=s[${k}]||{tasks:0,errors:0,inputTokens:0,outputTokens:0,costUsd:0};` +
    `s[${k}].tasks++;});}`;
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, HOME: fakeHome },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (c) => (c === 0 ? resolve(0) : reject(new Error(`updateStats child exited ${c}`))));
  });
}

/** Parse the append-only task event log, skipping any torn/blank line. */
export function readEvents(root) {
  let raw;
  try {
    raw = fs.readFileSync(tasksLogPath(root), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // torn last line — ignore, keep the rest
    }
  }
  return events;
}

/** Whether `pid` names a live process (probe-only, mirrors registry.isPidAlive). */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a synchronous predicate until it returns truthy, or throw on timeout. */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 40, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out (${timeoutMs}ms) waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

export function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

/**
 * Spawn the dispatch server over stdio and wrap it in a tiny JSON-RPC client.
 * Responses (messages carrying `id` + result/error) are buffered by id; the
 * server emits nothing else on stdout. env MUST already carry HOME=<fakeHome> and,
 * when relevant, FAKE_CLAUDE_MODE.
 */
export function startServer(env, cwd) {
  const child = spawn(process.execPath, [SERVER_JS], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  const waiters = new Map();
  let outBuf = '';
  let stderr = '';

  child.stdout.on('data', (d) => {
    outBuf += d;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        responses.set(msg.id, msg);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w(msg);
        }
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d));

  return {
    child,
    get stderr() {
      return stderr;
    },
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    hasResponse(id) {
      return responses.has(id);
    },
    getResponse(id) {
      return responses.get(id);
    },
    waitResponse(id, timeoutMs = 20000) {
      if (responses.has(id)) return Promise.resolve(responses.get(id));
      return new Promise((resolve, reject) => {
        waiters.set(id, resolve);
        setTimeout(() => {
          if (waiters.has(id)) {
            waiters.delete(id);
            reject(new Error(`Timed out waiting for JSON-RPC response id=${id}`));
          }
        }, timeoutMs);
      });
    },
    async initialize() {
      this.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'detach-probe', version: '0' },
        },
      });
      await this.waitResponse(1);
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    closeStdin() {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    },
    waitExit(timeoutMs = 15000) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server did not exit in time')), timeoutMs);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}
