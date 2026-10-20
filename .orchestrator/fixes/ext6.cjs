// EXT6 (2.0 fix wave 6): the extension host after the second adversarial review — fixed-name
// writes at activation, the keep-alive claim, tree elements resolved by provenance, the one
// worker-name rule, no login shell on the activation path, process-group signals, timestamps
// from the log, the session scan, index freshness, the host thread at activation and on idle
// redraws, four strings — and the asset sync, whose install paths and ledger live in the
// workspace, where anything can be put at their names.
//
//   node .orchestrator/fixes/ext6.cjs [outDir] [--only S1,K,...] [--jobs N]
//
// Loads the COMPILED extension-host modules from `outDir` (default: <repo>/out) against the
// `vscode` stand-in in shell-b-stub.cjs (required as it is, never edited). Every case runs in a
// child process of its own with HOME / USERPROFILE redirected to a fresh temp directory before
// any module loads, PATH cut down to a directory of fake CLIs, and the stub's guard that
// reroutes any agent CLI to its fake. No real claude / codex / cursor-agent / agy is started and
// no real ~/.claude* is touched.
//
// Prints `PASS <name>` / `FAIL <name> — <why>`, and `SKIP <name> — <why>` for a TIMING budget
// that was not judged because the machine was busy (1-minute load average above 20; the
// measured number is printed either way). Exit 0 only when nothing failed. A case that does not
// run to its end — the hangs this file exists to catch — is a FAIL written by the parent.
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-ext6', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const OUT = path.resolve(positional[0] ?? path.join(REPO, 'out'));

/* ------------------------------------------------------------------------- *
 * Parent: one child per case
 * ------------------------------------------------------------------------- */

const S1_NAMES = ['server.js', 'run-task.js', 'provider-cli.js', 'legacy-shim'];
const S1_PLANTS = ['fifo', 'symlink', 'dangling', 'directory', 'identical'];
/** [case name, watchdog in ms]. A hang is the failure several of these exist to catch. */
const CASES = [
  ['S1-control', 30_000],
  ['S1-legacy-linked', 30_000],
  ...S1_PLANTS.flatMap((plant) => S1_NAMES.map((name) => [`S1-${plant}@${name}`, 30_000])),
  ['S2-policy-file', 30_000],
  ...['control', 'dir', 'emptydir', 'readonly', 'symlink', 'future', 'busy-comma'].map((m) => [`K-${m}`, 120_000]),
  ['W1-row-commands', 120_000],
  ['W2-rows-that-are-no-account', 120_000],
  ['N1-add-rename', 120_000],
  ['N2-import', 120_000],
  ['N3-names-already-stored', 120_000],
  ['L1-login-shell', 120_000],
  ['L2-dispose-during-lookup', 60_000],
  ['P1-cancel-pgid', 120_000],
  ['T1-future-ts', 120_000],
  ['Q1-session-scan', 300_000],
  ['I1-index-freshness', 180_000],
  ['A1-activation-sweeps', 180_000],
  ['A2-dispose-at-once', 60_000],
  ['A3-idle-redraws', 120_000],
  ['A4-reap-after-sweep-resolves', 60_000],
  ['A4-reap-after-sweep-rejects', 60_000],
  ['A4-reap-throws', 60_000],
  ['A4-reap-not-after-dispose', 60_000],
  ['X1-strings', 60_000],
  // Asset sync: each with the 30 s watchdog — a pipe at a path is a hang where it is opened.
  ...['control', 'fifo', 'symlink', 'dangling', 'directory', 'big', 'identical', 'edited'].map((p) => [`AS-${p}`, 30_000]),
  ...['fifo', 'symlink', 'directory'].map((p) => [`AL-${p}`, 30_000]),
  ...['control', 'edited', 'fifo', 'symlink', 'dirlink', 'directory', 'big'].map((p) => [`AR-${p}`, 30_000]),
  ['AP-pack-fifo', 30_000],
  ['AP-template', 30_000],
  ['AP-engine-edges', 30_000],
];

if (flag('--case') === undefined) {
  const only = flag('--only');
  const wanted = only === undefined ? CASES : CASES.filter(([c]) => only.split(',').some((sel) => c === sel || c.startsWith(sel)));
  // At most 4 at a time: a case starts a few children of its own (fake CLIs, decoys).
  const jobs = Math.max(1, Math.min(4, Number(flag('--jobs') ?? 3) || 3));
  const tally = { pass: 0, fail: 0, skip: 0 };
  console.log(`ext6: build under test = ${OUT}`);
  console.log(`ext6: load average at start = ${os.loadavg()[0].toFixed(1)}`);

  const runCase = ([name, watchdog]) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, OUT, '--case', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, watchdog);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = out.split('\n').filter((l) => /^(PASS|FAIL|SKIP|INFO) /.test(l));
        for (const line of lines) {
          console.log(line);
          if (line.startsWith('PASS ')) tally.pass++;
          else if (line.startsWith('FAIL ')) tally.fail++;
          else if (line.startsWith('SKIP ')) tally.skip++;
        }
        if (code !== 0 || !lines.some((l) => !l.startsWith('INFO '))) {
          tally.fail++;
          const tail = err.trim().split('\n').slice(-6).join(' | ');
          console.log(
            timedOut
              ? `FAIL ${name}: the case did not run to its end — still running after ${watchdog / 1000} s (a hang), killed`
              : `FAIL ${name}: the case did not run to its end — exit ${code}${signal ? ` (${signal})` : ''}: ${tail || out.trim().split('\n').slice(-3).join(' | ')}`,
          );
        }
        resolve();
      });
    });

  (async () => {
    const queue = [...wanted];
    const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        await runCase(next);
      }
    });
    await Promise.all(workers);
    console.log(`\next6: ${tally.pass} passed, ${tally.fail} failed, ${tally.skip} skipped`);
    process.exit(tally.fail === 0 ? 0 : 1);
  })();
  return;
}

/* ------------------------------------------------------------------------- *
 * Child: one case
 * ------------------------------------------------------------------------- */

const { install } = require('./shell-b-stub.cjs');
const CASE = flag('--case');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return text === undefined ? String(v) : text.length > 900 ? `${text.slice(0, 900)}…` : text;
  } catch {
    return String(v);
  }
};
function check(name, ok, observed) {
  console.log(ok ? `PASS ${CASE}: ${name}` : `FAIL ${CASE}: ${name} — ${show(observed)}`);
}
const info = (text) => console.log(`INFO ${CASE}: ${text}`);
/** A timing budget: judged only on a machine that is not busy; the number is printed either way. */
function budget(name, measured, limit, unit = 'ms') {
  const load = os.loadavg()[0];
  const said = `${name}: ${typeof measured === 'number' ? measured.toFixed(1) : measured} ${unit} (budget ${limit} ${unit}, load ${load.toFixed(1)})`;
  if (load > 20) {
    console.log(`SKIP ${CASE}: ${said} — not judged: the 1-minute load average is above 20`);
  } else {
    console.log(measured <= limit ? `PASS ${CASE}: ${said}` : `FAIL ${CASE}: ${said} — over budget`);
  }
}

const S = 'claudeCodeOrchestrator';
const P = `${S}.`;

function boot(opts = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-x6-')));
  const home = path.join(scratch, 'home');
  const ws = opts.noWorkspace ? undefined : path.join(scratch, 'ws');
  if (ws) fs.mkdirSync(ws, { recursive: true });
  const h = install({ repo: REPO, out: OUT, home, ...opts, workspace: ws });
  h.scratch = scratch;
  h.ws = ws;
  // Before any module loads: the registry module moves a pre-rename data directory into place
  // when this one is missing.
  fs.mkdirSync(path.join(h.root, 'tasks'), { recursive: true });
  h.registryFile = path.join(h.root, 'registry.json');
  h.logFile = path.join(h.root, 'tasks.jsonl');
  h.writeRegistry = (obj) => fs.writeFileSync(h.registryFile, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  h.registryOnDisk = () => JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  return h;
}
/**
 * Wait until the extension's own background work has stopped writing its state files: the
 * lookup of the claude path, the first usage refresh and the sweeps after activation each
 * write one, and a case that compares a file's bytes — or counts opens — must start after
 * them, however busy the machine is. Stable for 350 ms, or 12 s at the most.
 */
async function quiesce(h) {
  const files = ['registry.json', 'usage.json', 'stats.json', 'tasks.jsonl'].map((f) => path.join(h.root, f));
  const stamp = () => files.map((f) => { try { const st = fs.statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return '-'; } }).join('|');
  const end = Date.now() + 12_000;
  let last = stamp();
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(50);
    const now = stamp();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 350) return;
  }
}
/**
 * activate(), then — with `wait` above 0 — that long for what activation put off, and until
 * its background writes have stopped. Returns what it threw and how long activate() took.
 */
async function activate(h, wait = 700) {
  let threw = '';
  const t0 = process.hrtime.bigint();
  try {
    h.req('extension.js').activate(h.context);
  } catch (e) {
    threw = String((e && e.stack) || e);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (wait > 0) {
    await sleep(wait);
    await quiesce(h);
  }
  return { threw, ms };
}
const exec = async (h, id, ...args) => {
  let threw = '';
  let value;
  try {
    value = await h.vscode.commands.executeCommand(P + id, ...args);
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  return { threw, value };
};
const until = async (cond, ms = 5000, step = 25) => {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = Boolean(cond()); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() >= end) return false;
    await sleep(step);
  }
};
const brief = (h) => h.log.messages.map((m) => [m.level, m.modal ? 'modal' : '', String(m.message).slice(0, 160)]);
function finish(h) {
  check('no unhandled rejection or uncaught exception', h.log.rejections.length === 0, h.log.rejections.slice(0, 2));
  try { h.dispose(); } catch { /* best effort */ }
  try { fs.chmodSync(h.root, 0o700); } catch { /* best effort */ }
  try { fs.rmSync(h.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
const workersTree = (h) => h.providers[`${P}workers`];
const historyTree = (h) => h.providers[`${P}workerHistory`];
const tasksTree = (h) => h.context.subscriptions.find((x) => x && x.id === `${P}tasks`).provider;
/** Clear what the stub recorded, and set the answers for the next command. */
function reset(h, answers = {}) {
  for (const key of ['messages', 'terminals', 'inputBoxes', 'quickPicks', 'opened', 'shown', 'vscodeOpen']) {
    if (Array.isArray(h.log[key])) h.log[key].length = 0;
  }
  h.answers.message = answers.message ?? (() => undefined);
  h.answers.quickPick = answers.quickPick ?? (() => undefined);
  h.answers.inputBox = answers.inputBox ?? (() => undefined);
}
/** Counts calls of the fs functions that open or list something, optionally only for some paths. */
function spyFs(match = () => true) {
  const names = ['openSync', 'readFileSync', 'opendirSync', 'readdirSync', 'copyFileSync', 'writeFileSync', 'appendFileSync'];
  const real = {};
  const calls = [];
  for (const name of names) {
    real[name] = fs[name];
    fs[name] = function (...args) {
      const target = name === 'copyFileSync' ? args[1] : args[0];
      if (typeof target === 'string' && match(target, name, args)) calls.push({ fn: name, target, flags: args[1] });
      return real[name].apply(this, args);
    };
  }
  return { calls, restore: () => { for (const name of names) fs[name] = real[name]; } };
}

/**
 * A live process that reads as a one-shot worker ("claude" and " -p" on its command line): a
 * running task that names its pid is left running by the dead-task sweep. Killed at exit.
 */
function liveWorkerStandIn(h) {
  const cp = require('child_process');
  const bin = path.join(h.scratch, 'stand-in-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), 'setTimeout(() => {}, 120000);\n');
  const child = cp.spawn(process.execPath, [path.join(bin, 'claude'), '-p', 'stand-in'], { stdio: 'ignore' });
  process.on('exit', () => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  return child.pid;
}

/* ---- 9.1  fixed-name writes at activation ---- */

function s1Targets(h) {
  const stableDir = path.join(h.root, 'mcp');
  return {
    'server.js': path.join(stableDir, 'server.js'),
    'run-task.js': path.join(stableDir, 'run-task.js'),
    'provider-cli.js': path.join(stableDir, 'provider-cli.js'),
    'legacy-shim': path.join(h.home, '.fable-orchestrator', 'mcp', 'server.js'),
  };
}
function s1Expected(h, name) {
  return name === 'legacy-shim'
    ? Buffer.from(`require(${JSON.stringify(s1Targets(h)['server.js'])});\n`)
    : fs.readFileSync(path.join(OUT, 'mcp', name));
}
const isRightFile = (h, name) => {
  try {
    const target = s1Targets(h)[name];
    return fs.lstatSync(target).isFile() && fs.readFileSync(target).equals(s1Expected(h, name));
  } catch {
    return false;
  }
};
const isWriteOpen = (flags) =>
  typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : false;

async function s1(plant, name) {
  const h = boot({});
  const targets = s1Targets(h);
  const all = Object.values(targets);
  const target = name === undefined ? undefined : targets[name];
  const victim = path.join(h.scratch, 'victim.txt');
  const victimText = 'precious — not this extension\'s to write\n';
  const missing = path.join(h.scratch, 'nowhere', 'missing.js');
  let before;
  if (target !== undefined) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (plant === 'fifo') require('child_process').execFileSync('/usr/bin/mkfifo', [target]);
    if (plant === 'symlink') { fs.writeFileSync(victim, victimText); fs.symlinkSync(victim, target); }
    if (plant === 'dangling') fs.symlinkSync(missing, target);
    if (plant === 'directory') { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'kept'), 'x'); }
    if (plant === 'identical') {
      fs.writeFileSync(target, s1Expected(h, name));
      fs.utimesSync(target, 1_000_000_000, 1_000_000_000);
      before = fs.lstatSync(target);
    }
  }
  // Every open or whole-file write of one of the four fixed names, for the whole case.
  const spy = spyFs((file) => all.includes(file));
  const t0 = Date.now();
  const { threw, ms } = await activate(h, 0);
  const others = S1_NAMES.filter((n) => n !== name);
  // What activation put off: until the names that can be right are right, or 5 s.
  const settled = await until(
    () => (plant === 'directory' && name === 'server.js' ? h.log.output.some((l) => l.includes(target)) : others.every((n) => isRightFile(h, n)) && (plant === 'directory' || name === undefined || isRightFile(h, name))),
    5000,
  );
  await sleep(150);
  const took = Date.now() - t0;
  check(`activate() returned (${ms.toFixed(0)} ms) and what it put off was done within 5 s (${took} ms), nothing thrown`, threw === '' && ms < 5000 && settled && took < 6000, { threw, ms, settled, took, output: h.log.output.slice(0, 3) });
  const wrote = spy.calls.filter((c) => (c.fn === 'openSync' && isWriteOpen(c.flags)) || ['copyFileSync', 'writeFileSync', 'appendFileSync'].includes(c.fn));
  check('none of the four fixed names was opened for writing, copied onto or written whole', wrote.length === 0, wrote.slice(0, 4));
  spy.restore();
  const mcpLines = h.log.output.filter((l) => l.includes('[mcp server]'));

  if (plant === 'control') {
    check('each of the four names holds its file', S1_NAMES.every((n) => isRightFile(h, n)), S1_NAMES.map((n) => [n, isRightFile(h, n)]));
    const mode = (file) => fs.lstatSync(file).mode & 0o777;
    check('the files are readable by the owner only (0600)', all.every((f) => mode(f) === 0o600), all.map((f) => mode(f).toString(8)));
    check('the directories this version created are 0700 — mcp/, and the pre-rename ~/.fable-orchestrator and its mcp/', [path.join(h.root, 'mcp'), path.join(h.home, '.fable-orchestrator'), path.join(h.home, '.fable-orchestrator', 'mcp')].every((d) => mode(d) === 0o700), [path.join(h.root, 'mcp'), path.join(h.home, '.fable-orchestrator'), path.join(h.home, '.fable-orchestrator', 'mcp')].map((d) => mode(d).toString(8)));
    check('nothing is said in the output channel about them', mcpLines.length === 0, mcpLines);
    // "Register MCP Server" registers the stable path, which holds the server.
    reset(h);
    await exec(h, 'installMcp');
    const mcp = JSON.parse(fs.readFileSync(path.join(h.ws, '.mcp.json'), 'utf8'));
    check('"Register MCP Server" registers the stable path', JSON.stringify(mcp.mcpServers['cco-dispatch'].args) === JSON.stringify([targets['server.js']]) && h.log.messages.some((m) => /^Registered/.test(String(m.message))), [mcp, brief(h)]);
    // A second look at an unchanged copy rewrites nothing.
    const stamps = all.map((f) => { fs.utimesSync(f, 1_000_000_000, 1_000_000_000); const st = fs.lstatSync(f); return `${st.ino}:${st.mtimeMs}`; });
    reset(h);
    await exec(h, 'installMcp');
    check('asking again with nothing changed rewrites none of the four files (same inode and mtime)', JSON.stringify(all.map((f) => { const st = fs.lstatSync(f); return `${st.ino}:${st.mtimeMs}`; })) === JSON.stringify(stamps), stamps);
    return finish(h);
  }

  if (plant === 'fifo' || plant === 'symlink' || plant === 'dangling') {
    check(`the ${plant === 'fifo' ? 'pipe' : 'link'} at ${name} was replaced by the right regular file`, isRightFile(h, name), (() => { try { const st = fs.lstatSync(target); return { file: st.isFile(), link: st.isSymbolicLink(), fifo: st.isFIFO(), size: st.size }; } catch (e) { return String(e.code); } })());
    check('…and the other three names hold their files', others.every((n) => isRightFile(h, n)), others.map((n) => [n, isRightFile(h, n)]));
    if (plant === 'symlink') check('the file the link named is byte-identical', fs.readFileSync(victim, 'utf8') === victimText, fs.readFileSync(victim, 'utf8').slice(0, 80));
    if (plant === 'dangling') check('nothing was created where the dangling link pointed', !fs.existsSync(missing) && !fs.existsSync(path.dirname(missing)), fs.existsSync(missing));
    check('nothing is said in the output channel: a replaced name is not a refusal', mcpLines.length === 0, mcpLines);
  }

  if (plant === 'identical') {
    const after = fs.lstatSync(target);
    check(`an identical file at ${name} is not rewritten (same inode, same mtime)`, after.ino === before.ino && after.mtimeMs === before.mtimeMs && isRightFile(h, name), { before: [before.ino, before.mtimeMs], after: [after.ino, after.mtimeMs] });
    check('…and the other three names hold their files', others.every((n) => isRightFile(h, n)), others.map((n) => [n, isRightFile(h, n)]));
  }

  if (plant === 'directory') {
    const about = h.log.output.filter((l) => l.includes(target));
    check(`a directory at ${name}: exactly ONE line in the output channel, naming it`, about.length === 1 && mcpLines.length === 1 && /director/.test(about[0]), mcpLines);
    check('…the directory and what is in it are left as they are', fs.lstatSync(target).isDirectory() && fs.readFileSync(path.join(target, 'kept'), 'utf8') === 'x', 'changed');
    if (name === 'server.js') {
      // The stable path does not hold the server: nothing may be registered at it.
      reset(h);
      const r = await exec(h, 'installMcp');
      const said = h.log.messages.filter((m) => /could not be written/.test(String(m.message)));
      check('"Register MCP Server" says the stable copy could not be written, and registers nothing', r.threw === '' && said.length === 1 && said[0].level === 'error' && said[0].message.includes(target) && !fs.existsSync(path.join(h.ws, '.mcp.json')) && !h.log.messages.some((m) => /^Registered/.test(String(m.message))), [r.threw, brief(h), fs.existsSync(path.join(h.ws, '.mcp.json'))]);
      check('…and the refusal is not said a second time in the output channel', h.log.output.filter((l) => l.includes(target)).length === 1, h.log.output.filter((l) => l.includes('[mcp server]')));
      // The obstacle removed: the same command, with no reload, now registers.
      fs.rmSync(target, { recursive: true });
      reset(h);
      await exec(h, 'installMcp');
      let mcp;
      try { mcp = JSON.parse(fs.readFileSync(path.join(h.ws, '.mcp.json'), 'utf8')); } catch { mcp = undefined; }
      check('with the directory removed, the same command writes the copy and registers it', isRightFile(h, 'server.js') && mcp !== undefined && JSON.stringify(mcp.mcpServers['cco-dispatch'].args) === JSON.stringify([target]) && S1_NAMES.every((n) => isRightFile(h, n)), [mcp, brief(h), S1_NAMES.map((n) => [n, isRightFile(h, n)])]);
    } else {
      check('…and the other three names hold their files', others.every((n) => isRightFile(h, n)), others.map((n) => [n, isRightFile(h, n)]));
      reset(h);
      await exec(h, 'installMcp');
      check('the server itself is in place, so "Register MCP Server" still registers the stable path', fs.existsSync(path.join(h.ws, '.mcp.json')) && h.log.messages.some((m) => /^Registered/.test(String(m.message))), brief(h));
    }
  }
  finish(h);
}

/**
 * The pre-rename directory is a symbolic link to the current one (somebody kept the old name
 * alive that way): its `mcp/server.js` IS the stable copy, and a forwarding file written
 * there would replace the server with a file that requires itself.
 */
async function s1LegacyLinked() {
  const h = boot({});
  fs.symlinkSync(h.root, path.join(h.home, '.fable-orchestrator'));
  const { threw } = await activate(h, 0);
  await until(() => ['server.js', 'run-task.js', 'provider-cli.js'].every((n) => isRightFile(h, n)), 5000);
  await sleep(200);
  const stable = s1Targets(h)['server.js'];
  check('the old directory linked to the new one: the stable path still holds the SERVER, not a file that requires itself', threw === '' && isRightFile(h, 'server.js') && !/^require\(/.test(fs.readFileSync(stable, 'utf8')), fs.readFileSync(stable, 'utf8').slice(0, 80));
  check('…the link is left as it is, and nothing is said', fs.lstatSync(path.join(h.home, '.fable-orchestrator')).isSymbolicLink() && h.log.output.filter((l) => l.includes('[mcp server]')).length === 0, h.log.output);
  finish(h);
}

/* ---- 9.1 (the other fixed-name write of a command): CLAUDE.md ---- */

async function s2PolicyFile() {
  const h = boot({});
  await activate(h, 500);
  const file = path.join(h.ws, 'CLAUDE.md');
  const run = async () => { reset(h); return exec(h, 'addDispatchPolicy'); };
  // absent → created
  let r = await run();
  check('no CLAUDE.md: one is created with the policy block', r.threw === '' && fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8').length > 200, brief(h));
  // an existing file keeps its text, its mode, and is replaced in one step
  fs.writeFileSync(file, '# mine\n');
  fs.chmodSync(file, 0o640);
  const spy = spyFs((f) => f === file);
  r = await run();
  const wrote = spy.calls.filter((c) => (c.fn === 'openSync' && isWriteOpen(c.flags)) || ['writeFileSync', 'appendFileSync', 'copyFileSync'].includes(c.fn));
  spy.restore();
  check('an existing CLAUDE.md keeps its text and its mode, and gains the block', fs.readFileSync(file, 'utf8').startsWith('# mine') && fs.readFileSync(file, 'utf8').length > 200 && (fs.lstatSync(file).mode & 0o777) === 0o640, [fs.readFileSync(file, 'utf8').slice(0, 40), (fs.lstatSync(file).mode & 0o777).toString(8)]);
  check('…without the file ever being opened for writing (it is replaced by a rename)', wrote.length === 0, wrote);
  // a pipe at the name: refused, not waited on
  fs.rmSync(file);
  require('child_process').execFileSync('/usr/bin/mkfifo', [file]);
  const t0 = Date.now();
  r = await run();
  check('a pipe at CLAUDE.md is refused at once and left as it is', r.threw === '' && Date.now() - t0 < 3000 && fs.lstatSync(file).isFIFO() && h.log.messages.some((m) => /was not written/.test(String(m.message))), [Date.now() - t0, brief(h)]);
  fs.rmSync(file);
  // a link inside the workspace is written through and stays a link
  const inside = path.join(h.ws, 'AGENTS.md');
  fs.writeFileSync(inside, '# agents\n');
  fs.symlinkSync('AGENTS.md', file);
  r = await run();
  check('a link to a file inside the workspace: that file gets the block, and the link stays a link', fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(inside, 'utf8').startsWith('# agents') && fs.readFileSync(inside, 'utf8').length > 200, fs.readFileSync(inside, 'utf8').slice(0, 60));
  finish(h);
}

/* ---- 9.2  keep-alive ---- */

async function keepalive(mode) {
  const h = boot({});
  const calls = path.join(h.home, 'pings.log');
  // A fake `claude` that succeeds and logs what it was asked.
  fs.writeFileSync(path.join(h.fakebin, 'claude'), `#!/bin/sh\necho "$* | CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR-<unset>}" >> "${calls}"\ncase "$1" in --version) echo "2.1.283 (Claude Code)";; esac\nexit 0\n`);
  fs.chmodSync(path.join(h.fakebin, 'claude'), 0o755);
  const names = mode === 'busy-comma' ? ['w1', 'w2', 'w1,w2'] : ['w1', 'w2', 'w3'];
  const dirs = names.map((n, i) => path.join(h.home, `.claude-acct${i + 1}`));
  dirs.forEach((d) => fs.mkdirSync(d));
  h.writeRegistry({ workers: dirs.map((d, i) => ({ name: names[i], configDir: d, model: 'opus' })), claudePath: path.join(h.fakebin, 'claude') });
  const now0 = Date.now();
  const usage = {};
  for (const d of dirs) usage[d] = { available: true, fetchedAt: now0, subscriptionType: 'max', windows: [{ kind: 'session', label: '5h', percent: 10, severity: 'normal', resetsAt: new Date(now0 + 3600e3).toISOString() }] };
  fs.writeFileSync(path.join(h.root, 'usage.json'), JSON.stringify(usage));
  const stampFile = path.join(h.root, 'keepalive.json');
  const victim = path.join(h.scratch, 'victim.json');
  if (mode === 'dir') { fs.mkdirSync(stampFile); fs.writeFileSync(path.join(stampFile, 'x'), ''); }
  if (mode === 'emptydir') fs.mkdirSync(stampFile);
  if (mode === 'symlink') { fs.writeFileSync(victim, '{"precious":true}\n'); fs.symlinkSync(victim, stampFile); }
  if (mode === 'future') fs.writeFileSync(stampFile, JSON.stringify(Object.fromEntries(dirs.map((d) => [d, { lastAttemptAt: now0 + 10 * 86400e3, lastSuccessAt: now0 + 10 * 86400e3 }]))));
  if (mode === 'busy-comma') {
    // A dispatch running on the account literally named "w1,w2" — the same text the log writes for a failover from w1 to w2.
    fs.writeFileSync(h.logFile, JSON.stringify({ id: 'tbusy000001', ts: now0, status: 'running', worker: 'w1,w2', model: 'opus', title: 'busy', cwd: h.ws, pid: 1 }) + '\n');
  }
  const ka = h.req('keepalive.js');
  if (mode === 'readonly') fs.chmodSync(h.root, 0o500);
  const HOUR = 3600e3;
  const lines = [];
  const pings = () => {
    const all = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('-p ')) : [];
    const per = {};
    for (const l of all) { const d = path.basename(l.split('CLAUDE_CONFIG_DIR=')[1]); per[d] = (per[d] || 0) + 1; }
    return { total: all.length, per };
  };
  for (let tick = 0; tick < 24; tick++) await ka.runKeepaliveSweep(now0 + tick * HOUR, (line) => lines.push(line));
  const day = pings();
  info(`${mode}: 24 hourly ticks → ${day.total} keep-alive requests ${JSON.stringify(day.per)}; ${lines.length} line(s) in the log`);

  if (mode === 'control' || mode === 'symlink' || mode === 'future') {
    check(`${mode}: 24 hourly ticks send exactly one request per account (3)`, day.total === 3 && Object.values(day.per).every((n) => n === 1), day);
    check('…and nothing is said in the log', lines.length === 0, lines);
    const stamps = ka.readKeepaliveStamps();
    check('…each account\'s claim and success are on disk, readable by the reader every window uses', dirs.every((d) => stamps[d] && Number.isFinite(stamps[d].lastAttemptAt) && Number.isFinite(stamps[d].lastSuccessAt) && stamps[d].lastAttemptAt <= Date.now()), stamps);
    if (mode === 'symlink') check('a link at keepalive.json was replaced by a regular file, and the file it named is byte-identical', fs.lstatSync(stampFile).isFile() && fs.readFileSync(victim, 'utf8') === '{"precious":true}\n', fs.readFileSync(victim, 'utf8'));
    if (mode === 'future') check('a stamp dated ten days ahead was written over at the first ping (it would otherwise read as "due" at every tick)', dirs.every((d) => stamps[d].lastSuccessAt <= Date.now()), stamps);
  } else if (mode === 'busy-comma') {
    const third = path.basename(dirs[2]);
    check('an account named "w1,w2" with a dispatch running on it is not pinged (its name is read as ONE name, as well as a failover of two)', (day.per[third] || 0) === 0, day);
    check('…and neither are w1 and w2, which the same text names as a failover', day.total === 0, day);
  } else {
    check(`${mode}: the stamp file cannot take a claim — NO request is sent in 24 ticks`, day.total === 0, day);
    check('…and that is said exactly once, with the file and the reason', lines.length === 1 && lines[0].includes(stampFile) && /keep-alive/.test(lines[0]), lines);
    check('…no temp file is left beside it', fs.readdirSync(mode === 'readonly' ? h.root : h.root).filter((n) => /^keepalive\.json\..*tmp$/.test(n)).length === 0, fs.readdirSync(h.root));
    // The obstacle removed: the next tick claims and pings once per account. The module stamps
    // with the wall clock, so from here on the wall clock is the simulated one.
    if (mode === 'readonly') fs.chmodSync(h.root, 0o700);
    else fs.rmSync(stampFile, { recursive: true });
    const realNow = Date.now;
    Date.now = () => now0 + 24 * HOUR;
    await ka.runKeepaliveSweep(now0 + 24 * HOUR, (line) => lines.push(line));
    const after = pings();
    check('with the obstacle removed, the next tick claims and pings once per account', after.total === 3 && Object.values(after.per).every((n) => n === 1), after);
    check('…and says, once, that requests resume', lines.length === 2 && /again|resume/.test(lines[1]), lines);
    Date.now = () => now0 + 25 * HOUR;
    await ka.runKeepaliveSweep(now0 + 25 * HOUR, (line) => lines.push(line));
    Date.now = realNow;
    check('…and the tick after that sends nothing and says nothing', pings().total === 3 && lines.length === 2, [pings(), lines]);
  }
  finish(h);
}

/* ---- 9.3  a tree element is what the tree made it ---- */

async function w1RowCommands() {
  const cp = require('child_process');
  const h = boot({});
  const dir = (n) => path.join(h.home, `.claude-${n}`);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) fs.mkdirSync(dir(n));
  const reg = h.req('registry.js');
  const ui = h.req('uiModel.js');
  // A process that reads as a one-shot worker ("claude" and " -p" on its command line): the
  // running task below is its, so activation's dead-task sweep leaves that task running.
  const bin = path.join(h.scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), 'setTimeout(() => {}, 120000);\n');
  const decoy = cp.spawn(process.execPath, [path.join(bin, 'claude'), '-p', 'decoy'], { stdio: 'ignore' });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  process.on('exit', () => { try { process.kill(decoy.pid, 'SIGKILL'); } catch { /* gone */ } });
  const write = (eIndex) => {
    const workers = [
      { name: 'a', configDir: dir('a'), model: 'opus', id: 'b' },
      { name: 'b', configDir: dir('b'), model: 'opus' },
      { name: 'c', configDir: dir('c'), model: 'opus', kind: 'unsupportedWorker' },
      { name: 'd', configDir: dir('d'), model: 'opus', id: 'a4f1c2d0-0000-4000-8000-uuid-of-a-newer-version' },
      // the position and the name of an entry this version cannot use (the second "e", below)
      { name: 'e', configDir: dir('e'), model: 'opus', index: eIndex },
      { name: 'e', configDir: path.join(h.home, '.claude-second-e'), model: 'opus' },
      // the DIRECTORY of another Claude Code account: one login under a second name
      { name: 'h', configDir: dir('b'), model: 'opus' },
      { name: 'g', configDir: dir('g'), model: 'opus', id: 'tcross00001', key: 'worker:deadbeef', action: 'openSession', account: ui.accountKeyFor(dir('b')) },
    ];
    // "__proto__" and "constructor" as KEYS of an entry: written as text, since an object literal would not hold the first.
    const f = `{"name":"f","configDir":${JSON.stringify(dir('f'))},"model":"opus","__proto__":{"name":"b","configDir":${JSON.stringify(dir('b'))}},"constructor":{"name":"b"}}`;
    const text = JSON.stringify({ workers, vendorWorkers: [{ name: 'cx', configDir: dir('a'), model: '', provider: 'codex' }, { name: 'oc', configDir: path.join(h.home, '.opencode'), provider: 'opencode' }] }, null, 2).replace('"vendorWorkers"', `"zz":0,\n  "vendorWorkers"`);
    h.writeRegistry(text.replace(/\n  \],\n  "zz"/, `,\n    ${f}\n  ],\n  "zz"`));
  };
  write(0);
  const eIndex = reg.readRegistry().unsupportedWorkers.findIndex((u) => u.name === 'e');
  write(eIndex);
  const names = reg.readRegistry().workers.map((w) => w.name);
  check('fixture: seven usable Claude accounts (a, b, c, d, e, f, g) and the Codex one on a\'s directory; the second "e" and "oc" are among the unusable entries', JSON.stringify(names.slice().sort()) === JSON.stringify(['a', 'b', 'c', 'cx', 'd', 'e', 'f', 'g']) && reg.readRegistry().unsupportedWorkers[eIndex]?.name === 'e' && reg.readRegistry().unsupportedWorkers.some((u) => u.name === 'oc'), [names, reg.readRegistry().unsupportedWorkers.map((u) => u.name)]);
  check('…and a Claude entry that names the directory of an earlier one ("h", on b\'s) is no account at all: the registry reads one login once', !names.includes('h'), names);
  // A running task whose id the entry "g" carries as an `id` key.
  fs.writeFileSync(h.logFile, JSON.stringify({ id: 'tcross00001', ts: Date.now(), status: 'running', worker: 'b', model: 'opus', title: 'still running', cwd: h.ws, pid: decoy.pid }) + '\n');
  await activate(h, 500);
  const tree = workersTree(h);
  const rows = () => tree.getChildren();
  const row = (n) => rows().find((r) => tree.getTreeItem(r).label.replace(/^★ /, '') === n && /^worker\./.test(String(tree.getTreeItem(r).contextValue)));
  check('every one of them is drawn as an account row', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'cx'].every((n) => row(n) !== undefined), rows().map((r) => [tree.getTreeItem(r).label, tree.getTreeItem(r).contextValue]));

  const own = { a: dir('a'), c: dir('c'), d: dir('d'), e: dir('e'), f: dir('f'), g: dir('g') };
  for (const n of Object.keys(own)) {
    // the inline terminal button — no confirmation stands between the click and the terminal
    reset(h, { inputBox: () => '' });
    await exec(h, 'openWorkerSession', row(n));
    const t = h.log.terminals[0];
    check(`row ${n}: "Open Worker Session" opens ${n}'s own account (terminal "claude: ${n}", its own directory)`, h.log.terminals.length === 1 && t.name === `claude: ${n}` && t.env.CLAUDE_CONFIG_DIR === own[n], h.log.terminals.map((x) => [x.name, x.env && x.env.CLAUDE_CONFIG_DIR]));
    reset(h);
    await exec(h, 'loginWorker', row(n));
    check(`row ${n}: "Sign In" opens ${n}'s own account`, h.log.terminals.length === 1 && h.log.terminals[0].name === `claude: ${n}` && h.log.terminals[0].env.CLAUDE_CONFIG_DIR === own[n], h.log.terminals.map((x) => [x.name, x.env && x.env.CLAUDE_CONFIG_DIR]));
    reset(h);
    await exec(h, 'reloginWorker', row(n));
    check(`row ${n}: "Re-login" signs ${n} in again`, h.log.terminals.length === 1 && h.log.terminals[0].name === `login: ${n}` && h.log.terminals[0].env.CLAUDE_CONFIG_DIR === own[n] && /auth login/.test(h.log.terminals[0].sent.join(' ')), h.log.terminals.map((x) => [x.name, x.sent]));
    reset(h);
    await exec(h, 'renameWorker', row(n));
    check(`row ${n}: "Rename" starts from ${n}'s own name`, h.log.inputBoxes.length === 1 && h.log.inputBoxes[0].value === n, h.log.inputBoxes.map((b) => b.value));
    reset(h);
    await exec(h, 'setWorkerModel', row(n));
    check(`row ${n}: "Set Default Model" asks for ${n}'s model`, h.log.quickPicks.length === 1 && String(h.log.quickPicks[0].options.placeHolder).includes(`"${n}"`), h.log.quickPicks.map((q) => q.options && q.options.placeHolder));
    reset(h);
    await exec(h, 'setWorkerPermissionMode', row(n));
    check(`row ${n}: "Set Permission Mode" answers about ${n}`, h.log.messages.length === 1 && String(h.log.messages[0].message).startsWith(`"${n}" is a Claude Code worker`), brief(h));
    reset(h);
    await exec(h, 'togglePreferred', row(n));
    const marked = reg.readRegistry().workers.filter((w) => w.preferred).map((w) => w.name);
    check(`row ${n}: "Toggle Preferred" marks ${n}, and only ${n}`, JSON.stringify(marked) === JSON.stringify([n]) && h.log.messages.some((m) => String(m.message).startsWith(`"${n}" is now the preferred`)), [marked, brief(h)]);
  }
  // The Codex account registered on the Claude account a's directory: its row is ITS account, on ITS CLI.
  reset(h);
  await exec(h, 'reloginWorker', row('cx'));
  check('row cx (Codex, on the directory of the Claude account a): "Re-login" runs codex\'s own login for cx, never `claude auth login` for a', h.log.terminals.length === 1 && h.log.terminals[0].name === 'login: cx' && /^'?codex'? /.test(h.log.terminals[0].sent[0]) && !/claude/.test(h.log.terminals[0].sent.join(' ')), h.log.terminals.map((x) => [x.name, x.sent]));

  // Rows that carry keys of OTHER commands' payloads.
  reset(h);
  await exec(h, 'cancelTask', row('g'));
  await sleep(100);
  check('row g (its entry holds `id`: a running task\'s id): "Cancel Task" handed that row cancels nothing — the task still runs and its process is alive', reg.runningTasks().some((t) => t.id === 'tcross00001') && alive(decoy.pid) && h.log.messages.length === 0, [reg.runningTasks().map((t) => t.id), alive(decoy.pid), brief(h)]);
  reset(h, { inputBox: () => '' });
  await exec(h, 'accountAction', row('g'));
  check('…and "accountAction" handed that row (its entry holds `action` and another account\'s key) opens nothing', h.log.terminals.length === 0 && h.log.messages.length === 0, [h.log.terminals.map((x) => x.name), brief(h)]);
  reset(h);
  for (const cmd of ['sessionAction', 'stopSession', 'attachSession']) await exec(h, cmd, row('g'));
  check('…and the session commands handed that row (its entry holds `key`) do nothing', h.log.terminals.length === 0 && h.log.messages.length === 0 && h.log.quickPicks.length === 0, [h.log.terminals.length, brief(h), h.log.quickPicks.length]);
  reset(h, { message: (rec) => (rec.modal ? 'Remove Entry' : undefined) });
  const before = fs.readFileSync(h.registryFile, 'utf8');
  await exec(h, 'removeUnsupportedEntry', row('e'));
  check('row e (an ACCOUNT whose entry holds the `index` and `name` of an entry this version cannot use): "Remove Registry Entry" handed that row asks nothing and removes nothing', h.log.messages.length === 0 && fs.readFileSync(h.registryFile, 'utf8') === before, brief(h));

  // Plain payloads a caller built keep working.
  reset(h, { inputBox: () => '' });
  await exec(h, 'openWorkerSession', { name: 'b' });
  await exec(h, 'openWorkerSession', { id: 'b' });
  check('a plain { name } and a plain { id } still name a worker', h.log.terminals.length === 2 && h.log.terminals.every((t) => t.name === 'claude: b' && t.env.CLAUDE_CONFIG_DIR === dir('b')), h.log.terminals.map((x) => x.name));

  // Remove, last: the modal names the row's own account, and that account is the one that goes.
  const staleA = row('a');
  reset(h, { message: (rec) => (rec.modal && rec.items && rec.items.includes('Remove Account') ? 'Remove Account' : undefined) });
  await exec(h, 'removeWorker', staleA);
  const modal = h.log.messages.find((m) => m.modal);
  const left = reg.readRegistry().workers.map((w) => w.name);
  check('row a: "Remove" asks about "a" and removes a — b, whose name a\'s entry carries as `id`, stays', modal && String(modal.message) === 'Remove worker account "a"?' && !left.includes('a') && left.includes('b'), [modal && modal.message, left]);
  // The row of an account that is gone names nobody.
  reset(h, { inputBox: () => '' });
  for (const cmd of ['openWorkerSession', 'loginWorker', 'reloginWorker', 'renameWorker', 'setWorkerModel', 'togglePreferred', 'removeWorker']) await exec(h, cmd, staleA);
  check('a row whose account has since been removed: every command does nothing (no terminal, no question, no pick)', h.log.terminals.length === 0 && h.log.messages.length === 0 && h.log.inputBoxes.length === 0 && h.log.quickPicks.length === 0, [h.log.terminals.map((x) => x.name), brief(h), h.log.inputBoxes.length, h.log.quickPicks.length]);
  finish(h);
}

async function w2RowsThatAreNoAccount() {
  const h = boot({});
  const dir = (n) => path.join(h.home, `.claude-${n}`);
  for (const n of ['w1', 'w2']) fs.mkdirSync(dir(n));
  h.writeRegistry({
    workers: [{ name: 'w1', configDir: dir('w1'), model: 'opus' }, { name: 'w2', configDir: dir('w2'), model: 'opus' }, { name: 'w1', configDir: path.join(h.home, '.claude-w1-again'), model: 'opus' }],
    vendorWorkers: [{ name: 'oc', configDir: path.join(h.home, '.opencode'), provider: 'opencode' }],
  });
  const reg = h.req('registry.js');
  await activate(h, 500);
  const tree = workersTree(h);
  const rows = tree.getChildren();
  const items = rows.map((r) => tree.getTreeItem(r));
  const unsupported = rows.filter((r, i) => items[i].contextValue === 'unsupportedWorker');
  const account = rows.find((r, i) => /^worker\./.test(String(items[i].contextValue)));
  const detail = tree.getChildren(account)[0];
  check('fixture: two unusable entries are drawn (the duplicate "w1" and "oc"), and an account has detail rows', unsupported.length === 2 && detail !== undefined && tree.getTreeItem(detail).contextValue === 'workerStat', items.map((i) => [i.label, i.contextValue]));
  const WORKER_COMMANDS = ['removeWorker', 'renameWorker', 'setWorkerModel', 'setWorkerPermissionMode', 'togglePreferred', 'openWorkerSession', 'loginWorker', 'reloginWorker'];
  const before = fs.readFileSync(h.registryFile, 'utf8');
  const quiet = async (label, element) => {
    const noisy = [];
    for (const cmd of WORKER_COMMANDS) {
      reset(h, { message: (rec) => (rec.modal ? rec.items && rec.items[0] : undefined), inputBox: () => 'zz', quickPick: (list) => list[0] });
      const r = await exec(h, cmd, element);
      await sleep(10);
      if (r.threw !== '' || h.log.messages.length || h.log.terminals.length || h.log.inputBoxes.length || h.log.quickPicks.length) noisy.push([cmd, r.threw, brief(h), h.log.terminals.length, h.log.inputBoxes.length, h.log.quickPicks.length]);
    }
    check(`${label}: every worker command is refused — no terminal, no dialog, no input box, no pick, nothing changed`, noisy.length === 0 && fs.readFileSync(h.registryFile, 'utf8') === before, noisy.slice(0, 3));
  };
  await quiet('the row of the duplicate-name entry "w1" (a usable worker has that name)', unsupported.find((r) => r.name === 'w1'));
  await quiet('the row of the unknown-provider entry "oc"', unsupported.find((r) => r.name === 'oc'));
  await quiet('a detail row under an account', detail);

  // "Remove Registry Entry…": the rule.
  const ocRow = unsupported.find((r) => r.name === 'oc');
  reset(h);
  await exec(h, 'removeUnsupportedEntry', ocRow);
  check('"Remove Registry Entry…" on the entry\'s own row asks, naming it', h.log.messages.length === 1 && h.log.messages[0].modal && /"oc"/.test(String(h.log.messages[0].message)), brief(h));
  reset(h);
  await exec(h, 'removeUnsupportedEntry', detail);
  await exec(h, 'removeUnsupportedEntry', account);
  check('…on a detail row or an account row: nothing', h.log.messages.length === 0, brief(h));
  // THE RULE for a hand-built node: its position and name are a claim about the registry, checked
  // against it and put to the user in the same modal; `kind` is never read.
  const index = reg.readRegistry().unsupportedWorkers.findIndex((u) => u.name === 'oc');
  reset(h);
  await exec(h, 'removeUnsupportedEntry', { kind: 'unsupportedWorker', index, name: 'oc' });
  await exec(h, 'removeUnsupportedEntry', { index, name: 'oc' });
  check('a hand-built { index, name } that matches the registry is asked about exactly like the row (with or without `kind`), and nothing is removed without the answer', h.log.messages.length === 2 && h.log.messages.every((m) => m.modal && /"oc"/.test(String(m.message))) && fs.readFileSync(h.registryFile, 'utf8') === before, brief(h));
  reset(h, { message: () => 'Remove Entry' });
  await exec(h, 'removeUnsupportedEntry', { kind: 'unsupportedWorker', index, name: 'w2' });
  check('…one that names a usable worker, or the wrong position, removes nothing and says the registry changed', h.log.messages.length === 1 && !h.log.messages[0].modal && /registry changed/.test(String(h.log.messages[0].message)) && fs.readFileSync(h.registryFile, 'utf8') === before, brief(h));
  finish(h);
}

/* ---- 9.4  one name rule ---- */

const BAD_NAMES = ['$(id)', 'a b', 'w1,w2', 'a:0:Status', '..', 'x;rm -rf ~', 'tab\there', '', ' ', 'n'.repeat(65), 'main', 'constructor', '__proto__', 'toString', 'ünï', 'a/b', 'a.b'];

async function n1AddRename() {
  const h = boot({});
  const dir = (n) => path.join(h.home, `.claude-${n}`);
  fs.mkdirSync(dir('w1'));
  h.writeRegistry({ workers: [{ name: 'w1', configDir: dir('w1'), model: 'opus' }] });
  await activate(h, 500);
  const wm = h.req('workerManager.js');
  const manager = new wm.WorkerManager();
  const before = fs.readFileSync(h.registryFile, 'utf8');
  const homeBefore = fs.readdirSync(h.home).sort().join('|');

  // the manager itself, called directly
  const accepted = [];
  for (const name of [...BAD_NAMES, ' w9', 'w9 ']) {
    try { manager.add(name, 'opus', path.join(h.home, 'somewhere-' + accepted.length)); accepted.push(name); } catch { /* refused */ }
  }
  check(`WorkerManager.add refuses each of ${BAD_NAMES.length + 2} names the input boxes refuse (shell text, a space, a comma, a colon, dots, a tab, empty, 65 characters, main, object keys, padded)`, accepted.length === 0, accepted);
  check('…the registry file is byte-identical and no directory was created', fs.readFileSync(h.registryFile, 'utf8') === before && fs.readdirSync(h.home).sort().join('|') === homeBefore, fs.readdirSync(h.home));
  const renamed = [];
  for (const name of BAD_NAMES) {
    try { manager.rename('w1', name); renamed.push(name); } catch { /* refused */ }
  }
  check('WorkerManager.rename refuses the same names, and the registry is byte-identical', renamed.length === 0 && fs.readFileSync(h.registryFile, 'utf8') === before, renamed);
  let ok = '';
  try { manager.add('good-name_1', 'opus', dir('good')); } catch (e) { ok = String(e.message); }
  check('a name of letters, digits, - and _ is still added', ok === '' && h.registryOnDisk().workers.some((w) => w.name === 'good-name_1'), ok);
  check('a 64-character name is accepted, a 65-character one is not', typeof wm.workerNameProblem === 'function' && wm.workerNameProblem('n'.repeat(64)) === undefined && wm.workerNameProblem('n'.repeat(65)) !== undefined, typeof wm.workerNameProblem);

  // the Add Worker input box: the same rule in the box, and again after it
  const afterGood = fs.readFileSync(h.registryFile, 'utf8');
  const leaked = [];
  let validators = 0;
  let boxRefusals = 0;
  for (const name of BAD_NAMES) {
    reset(h, { quickPick: (list) => list.find((i) => i.info && i.info.id === 'claude') ?? list.find((i) => i.label === 'opus'), inputBox: () => name, message: () => undefined });
    await exec(h, 'addWorker');
    const box = h.log.inputBoxes[0];
    if (box && typeof box.validateInput === 'function') {
      validators++;
      if (box.validateInput(name)) boxRefusals++;
    }
    if (fs.readFileSync(h.registryFile, 'utf8') !== afterGood) leaked.push(name);
  }
  check('Add Worker: the box\'s own validation refuses each of them', validators === BAD_NAMES.length && boxRefusals === BAD_NAMES.length, [validators, boxRefusals]);
  check('…and a name that got past the box anyway is not added', leaked.length === 0, leaked);
  // Rename, through the command
  const renameLeaks = [];
  for (const name of BAD_NAMES) {
    reset(h, { inputBox: () => name });
    await exec(h, 'renameWorker', { name: 'w1' });
    if (fs.readFileSync(h.registryFile, 'utf8') !== afterGood) renameLeaks.push(name);
  }
  check('Rename Worker: none of them is stored', renameLeaks.length === 0, renameLeaks);
  reset(h, { inputBox: () => 'w1b' });
  await exec(h, 'renameWorker', { name: 'w1' });
  check('…and a good name still renames', h.registryOnDisk().workers.some((w) => w.name === 'w1b'), [h.registryOnDisk().workers.map((w) => w.name), brief(h)]);
  finish(h);
}

async function n2Import() {
  const h = boot({});
  const mk = (name, marker) => {
    const d = path.join(h.home, name);
    fs.mkdirSync(d);
    if (marker === 'config') fs.writeFileSync(path.join(d, '.claude.json'), '{}');
    if (marker === 'projects') fs.mkdirSync(path.join(d, 'projects'));
    if (marker === 'sessions') fs.mkdirSync(path.join(d, 'sessions'));
    if (marker === 'other') { fs.writeFileSync(path.join(d, 'claude-mem.db'), 'x'); fs.writeFileSync(path.join(d, 'settings.json'), '{}'); }
    return d;
  };
  mk('.claude-$(id)', 'config');
  mk('.claude-a b', 'config');
  mk('.claude-w1,w2', 'config');
  mk('.claude-a:0:Status', 'config');
  mk('.claude-skipme!', 'config');
  mk('.claude-good', 'config');
  mk('.claude', 'projects');
  mk('.claude-sess', 'sessions');
  mk('.claude-mem', 'other'); // another tool's directory: nothing of Claude Code in it
  mk('.claude-empty', undefined);
  const shared = path.join(h.home, 'shared-account');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, '.claude.json'), '{}');
  fs.symlinkSync(shared, path.join(h.home, '.claude-link1'));
  fs.symlinkSync(shared, path.join(h.home, '.claude-link2'));
  const w1 = mk('.claude-w1', 'config');
  h.writeRegistry({ workers: [{ name: 'w1', configDir: w1, model: 'opus' }] });
  await activate(h, 500);
  const wm = h.req('workerManager.js');
  const offered = [];
  const asked = [];
  reset(h, {
    quickPick: (list, options) => {
      if (options && options.canPickMany) { offered.push(...list.map((i) => i.entry.dir)); return list; }
      return list.find((i) => i.label === 'opus') ?? list[0];
    },
    inputBox: (options) => {
      asked.push({ value: options.value, prompt: String(options.prompt) });
      // skip one directory, accept the suggestion for the rest
      return /skipme/.test(String(options.prompt)) ? undefined : options.value;
    },
  });
  await exec(h, 'importWorkers');
  const base = offered.map((d) => path.basename(d)).sort();
  check('offered: real directories that hold .claude.json, sessions/ or projects/ — and nothing else', JSON.stringify(base) === JSON.stringify(['.claude', '.claude-$(id)', '.claude-a b', '.claude-a:0:Status', '.claude-good', '.claude-sess', '.claude-skipme!', '.claude-w1,w2'].sort()), base);
  check('…not another tool\'s directory (.claude-mem), not an empty one, not a registered one', !base.includes('.claude-mem') && !base.includes('.claude-empty') && !base.includes('.claude-w1'), base);
  check('…and not a symbolic link (two names for one directory are offered under neither)', !base.includes('.claude-link1') && !base.includes('.claude-link2'), base);
  const stored = h.registryOnDisk().workers;
  const names = stored.map((w) => w.name);
  check('every name now in the registry is one the name rule accepts', names.every((n) => /^[\w-]+$/.test(n) && n.length <= 64 && n !== 'main'), names);
  check('a directory whose name fails the rule asks for a name, pre-filled with a cleaned-up suggestion that passes the rule', asked.length === 5 && asked.every((a) => /^[\w-]+$/.test(a.value) && wm.workerNameProblem(a.value) === undefined), asked);
  const dirOf = (n) => stored.find((w) => w.name === n)?.configDir;
  check('…accepted: the directory is registered under that name (id, a-b, w1-w2, a-0-Status)', dirOf('id') === path.join(h.home, '.claude-$(id)') && dirOf('a-b') === path.join(h.home, '.claude-a b') && dirOf('w1-w2') === path.join(h.home, '.claude-w1,w2') && dirOf('a-0-Status') === path.join(h.home, '.claude-a:0:Status'), stored.map((w) => [w.name, path.basename(w.configDir)]));
  check('…Escape: that directory is skipped and the rest go on', !stored.some((w) => w.configDir === path.join(h.home, '.claude-skipme!')) && names.includes('good') && names.includes('default') && names.includes('sess'), names);
  // The realpath rule of `add` for a directory reached through two links.
  const manager = new wm.WorkerManager();
  let first = '';
  let second = '';
  try { manager.add('alias1', 'opus', path.join(h.home, '.claude-link1')); } catch (e) { first = String(e.message); }
  try { manager.add('alias2', 'opus', path.join(h.home, '.claude-link2')); } catch (e) { second = String(e.message); }
  check('add(): a second worker on another link to the same directory is refused (the realpath rule still holds)', first === '' && /already belongs to worker "alias1"/.test(second) && !h.registryOnDisk().workers.some((w) => w.name === 'alias2'), [first, second]);
  finish(h);
}

async function n3NamesAlreadyStored() {
  const h = boot({});
  const dir = (n) => path.join(h.home, `.claude-${n}`);
  for (const n of ['a', 'legacy-colon', 'w1', 'legacy-comma']) fs.mkdirSync(dir(n));
  h.writeRegistry({
    workers: [
      { name: 'a', configDir: dir('a'), model: 'opus' },
      { name: 'a:0:Status', configDir: dir('legacy-colon'), model: 'opus' },
      { name: 'w1', configDir: dir('w1'), model: 'opus' },
      { name: 'w1,w2', configDir: dir('legacy-comma'), model: 'opus' },
      { name: 'account:"a"', configDir: path.join(h.home, '.claude-q'), model: 'opus' },
      { name: 'detail:"a":0:Status', configDir: path.join(h.home, '.claude-r'), model: 'opus' },
    ],
  });
  const now = Date.now();
  const lineComma = JSON.stringify({ id: 'tcomma00001', ts: now - 5000, status: 'done', worker: 'w1,w2', model: 'opus', title: 'by the worker named w1,w2', cwd: h.ws });
  const lineW1 = JSON.stringify({ id: 'tplain00001', ts: now - 4000, status: 'done', worker: 'w1', model: 'opus', title: 'by w1', cwd: h.ws });
  fs.writeFileSync(h.logFile, `${lineComma}\n${lineW1}\n`);
  await activate(h, 500);
  const tree = workersTree(h);
  const ids = new Map();
  const dup = [];
  const add = (id, what) => { if (id === undefined) return; if (ids.has(id)) dup.push([id, ids.get(id), what]); else ids.set(id, what); };
  const rows = tree.getChildren();
  for (const node of rows) {
    const item = tree.getTreeItem(node);
    add(item.id, `account "${item.label}"`);
    for (const child of tree.getChildren(node)) { const ci = tree.getTreeItem(child); add(ci.id, `detail "${ci.label}" of "${item.label}"`); }
  }
  check(`a registry that ALREADY holds "a:0:Status", "w1,w2" and names shaped like tree ids: all ${ids.size} tree ids are unique`, dup.length === 0 && ids.size > 20, dup.slice(0, 3));
  // They stay usable: a row command acts on the account of that name.
  const row = (n) => rows.find((r) => tree.getTreeItem(r).label === n);
  reset(h, { inputBox: () => '' });
  await exec(h, 'openWorkerSession', row('w1,w2'));
  await exec(h, 'openWorkerSession', row('a:0:Status'));
  check('…and those accounts stay usable from their rows', h.log.terminals.length === 2 && h.log.terminals[0].env.CLAUDE_CONFIG_DIR === dir('legacy-comma') && h.log.terminals[1].env.CLAUDE_CONFIG_DIR === dir('legacy-colon'), h.log.terminals.map((t) => [t.name, t.env.CLAUDE_CONFIG_DIR]));
  const ui = h.req('uiModel.js');
  check('the dispatch totals of "w1,w2" and of "w1" are each their own (exact name)', ui.dispatchWindows('w1,w2').week.tasks === 1 && ui.dispatchWindows('w1').week.tasks === 1, [ui.dispatchWindows('w1,w2').week.tasks, ui.dispatchWindows('w1').week.tasks]);
  // Renaming w1 must leave the events of the worker named "w1,w2" alone.
  const logBefore = fs.readFileSync(h.logFile, 'utf8');
  reset(h, { inputBox: () => 'zz' });
  await exec(h, 'renameWorker', row('w1'));
  const logAfter = fs.readFileSync(h.logFile, 'utf8');
  check('renaming "w1" leaves the event of the worker named "w1,w2" exactly as it was', logAfter.split('\n')[0] === lineComma, logAfter.slice(0, 200));
  info(`rename of "w1" beside "w1,w2": ${logAfter === logBefore ? 'refused, nothing changed' : 'carried out'} — ${JSON.stringify(brief(h)).slice(0, 300)}`);
  check('…the rename is refused with a sentence that names "w1,w2", and the registry still says w1', logAfter === logBefore && h.registryOnDisk().workers.some((w) => w.name === 'w1') && h.log.messages.some((m) => /w1,w2/.test(String(m.message)) && /was not renamed/.test(String(m.message))), brief(h));
  finish(h);
}

/* ---- 9.5  no login shell on the activation path ---- */

function slowShell(h) {
  const runs = path.join(h.scratch, 'shell-runs.log');
  const shell = path.join(h.scratch, 'slow-login-shell');
  // A login shell whose profile takes 1.5 s, and that counts how often it is started.
  fs.writeFileSync(shell, `#!/bin/sh\necho run >> "${runs}"\nsleep 1.5\nexec /bin/sh "$@"\n`);
  fs.chmodSync(shell, 0o755);
  process.env.SHELL = shell;
  return () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
}
/** The longest time the event loop went without a turn, since the last reset. */
function lagMeter() {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  return { reset: () => { last = Date.now(); worst = 0; }, worst: () => { const now = Date.now(); return Math.max(worst, now - last); }, stop: () => clearInterval(timer) };
}

async function l1LoginShell() {
  const h = boot({});
  const runs = slowShell(h);
  const fake2 = path.join(h.fakebin, 'claude2');
  fs.writeFileSync(fake2, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(fake2, 0o755);
  const lag = lagMeter();
  const { threw, ms } = await activate(h, 0);
  check(`activate() returns at once with a login shell whose profile takes 1.5 s (${ms.toFixed(0)} ms; under 300)`, threw === '' && ms < 300, { threw, ms });
  const resolved = await until(() => path.isAbsolute(h.registryOnDisk().claudePath ?? ''), 8000);
  await sleep(400);
  const first = h.registryOnDisk().claudePath;
  check('the lookup ran once, in the background, and the registry got the resolved absolute path', resolved && runs() === 1 && path.isAbsolute(first) && path.basename(first) === 'claude', { runs: runs(), claudePath: first });
  // The longest gap between two turns of the event loop is a timing: judged as a budget.
  budget('the host thread during activation and the lookup (longest gap between two turns of the event loop)', lag.worst(), 400);

  // settings events that are not about the claude path
  lag.reset();
  for (let i = 0; i < 5; i++) h.cfgChanged.fire({ affectsConfiguration: (s) => `${S}.quotaCooldownMinutes`.startsWith(s) });
  for (let i = 0; i < 5; i++) h.fireConfig();
  await h.vscode.workspace.getConfiguration(S).update('quotaCooldownMinutes', 45, 1);
  await sleep(500);
  check('five settings events for another key, five that claim every key, and a real change of another setting: the login shell is run 0 more times', runs() === 1 && h.registryOnDisk().cooldownMinutes === 45, { runs: runs(), cooldown: h.registryOnDisk().cooldownMinutes });
  budget('the host thread during those eleven settings events (longest gap)', lag.worst(), 400);

  // the user changes claudePath
  lag.reset();
  const t0 = Date.now();
  await h.vscode.workspace.getConfiguration(S).update('claudePath', 'claude2', 1);
  const updateMs = Date.now() - t0;
  const got = await until(() => h.registryOnDisk().claudePath === fake2, 8000);
  await sleep(400);
  check('changing claudePath runs the lookup once, and the registry gets the resolved path', got && runs() === 2, { runs: runs(), claudePath: h.registryOnDisk().claudePath });
  check(`…off the thread: the settings write returned before the 1.5 s lookup could have ended (${updateMs} ms)`, updateMs < 1000, updateMs);
  budget('the host thread while claudePath was changed and looked up (longest gap)', lag.worst(), 400);
  for (let i = 0; i < 5; i++) h.fireConfig();
  await sleep(400);
  check('…and further events do not run it again while the stored path serves', runs() === 2, runs());

  // the stored path stops being spawnable
  fs.chmodSync(fake2, 0o644);
  lag.reset();
  h.fireConfig();
  const again = await until(() => runs() === 3, 8000);
  await until(() => h.registryOnDisk().claudePath === 'claude2', 8000);
  check('a stored path that stopped being spawnable triggers ONE lookup; with nothing found, the registry holds the bare command', again && runs() === 3 && h.registryOnDisk().claudePath === 'claude2', { runs: runs(), claudePath: h.registryOnDisk().claudePath });
  budget('the host thread during that lookup (longest gap)', lag.worst(), 400);
  for (let i = 0; i < 5; i++) h.fireConfig();
  await sleep(600);
  check('…and a lookup that found nothing is not repeated at every event', runs() === 3, runs());
  lag.stop();
  finish(h);
}

async function l2DisposeDuringLookup() {
  const h = boot({});
  const runs = slowShell(h);
  await activate(h, 0);
  // The stand-in notes its start and then sleeps 1.5 s: from the moment the note is there, the
  // lookup is in flight for at least that long. (Not a fixed wait: a busy machine starts it late.)
  await until(() => runs() >= 1, 8000, 10);
  const atDispose = fs.existsSync(h.registryFile) ? fs.readFileSync(h.registryFile, 'utf8') : '<absent>';
  const pathAtDispose = fs.existsSync(h.registryFile) ? h.registryOnDisk().claudePath : undefined;
  check('fixture: the lookup has started and is still in flight (the shell ran once; the registry has no absolute path yet)', runs() === 1 && !path.isAbsolute(String(pathAtDispose ?? '')), { runs: runs(), pathAtDispose });
  h.dispose();
  await sleep(2600);
  const after = fs.existsSync(h.registryFile) ? fs.readFileSync(h.registryFile, 'utf8') : '<absent>';
  check('disposed during the lookup: nothing is written afterwards — the registry file is byte-identical 2.6 s later', after === atDispose, [atDispose.slice(0, 120), after.slice(0, 120)]);
  check('…and nothing was started after disposal (no second shell)', runs() === 1, runs());
  finish(h);
}

/* ---- 9.6  signals ---- */

async function p1CancelPgid() {
  const cp = require('child_process');
  const h = boot({});
  const bin = path.join(h.scratch, 'bin');
  fs.mkdirSync(bin);
  // Looks like a one-shot worker on its command line ("claude" and " -p"); with --grandchild it starts one more process in its own group.
  const script = path.join(bin, 'claude');
  fs.writeFileSync(script, `const cp = require('child_process'); const fs = require('fs');\nif (process.argv.includes('--grandchild')) { const g = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); fs.writeFileSync(process.argv[process.argv.length - 1], String(g.pid)); }\nsetTimeout(() => {}, 60000);\n`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pgidOf = (pid) => Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  const decoy = cp.spawn(process.execPath, [script, '-p', 'decoy'], { stdio: 'ignore' });
  // An unrelated process GROUP of this user: stands for a shell, an editor, a server.
  const victim = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
  const grandFile = path.join(h.scratch, 'grandchild.pid');
  const genuine = cp.spawn(process.execPath, [script, '-p', 'genuine', '--grandchild', grandFile], { stdio: 'ignore', detached: true });
  const cleanup = () => { for (const p of [decoy, victim, genuine]) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } };
  try {
    await until(() => fs.existsSync(grandFile), 5000);
    const grand = Number(fs.readFileSync(grandFile, 'utf8'));
    check('fixture: the decoy is NOT a group leader, the victim leads another group, the genuine worker leads its own group with a grandchild in it', pgidOf(decoy.pid) !== decoy.pid && pgidOf(victim.pid) === victim.pid && pgidOf(genuine.pid) === genuine.pid && pgidOf(grand) === genuine.pid, [pgidOf(decoy.pid), decoy.pid, pgidOf(victim.pid), victim.pid, pgidOf(grand), genuine.pid]);
    h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
    const now = Date.now();
    fs.writeFileSync(h.logFile, [
      { id: 'tforged0001', ts: now - 2000, status: 'running', worker: 'a', model: 'opus', title: 'forged: pid of one process, pgid of another', cwd: h.ws, pid: decoy.pid, pgid: victim.pid },
      { id: 'tgenuine001', ts: now - 1000, status: 'running', worker: 'a', model: 'opus', title: 'genuine: a group leader', cwd: h.ws, pid: genuine.pid, pgid: genuine.pid },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    await activate(h, 400);
    // Activation's dead-task sweep must leave both alone: their pids are alive and look like workers.
    const tree = tasksTree(h);
    const row = (id) => tree.getChildren().find((r) => r.id === id);
    check('both rows are drawn as running', row('tforged0001')?.status === 'running' && row('tgenuine001')?.status === 'running', tree.getChildren().map((r) => [r.id, r.status]));
    reset(h);
    await exec(h, 'cancelTask', row('tforged0001'));
    await sleep(300);
    check('a log line naming the pid of one process and the pgid of another: the cancel signals the pid only — the other group\'s leader is still alive', alive(victim.pid) && !alive(decoy.pid), { victimAlive: alive(victim.pid), decoyAlive: alive(decoy.pid), said: brief(h) });
    reset(h);
    await exec(h, 'cancelTask', row('tgenuine001'));
    await until(() => !alive(grand) && !alive(genuine.pid), 3000);
    check('the genuine case (pgid === pid): the whole group is ended — the worker and its grandchild', !alive(genuine.pid) && !alive(grand), { worker: alive(genuine.pid), grandchild: alive(grand) });
    check('…and the unrelated group is still alive after both', alive(victim.pid), alive(victim.pid));
  } finally {
    cleanup();
  }
  finish(h);
}

/* ---- 9.7  timestamps from the log ---- */

async function t1FutureTs() {
  const h = boot({ viewsVisible: true });
  const now = Date.now();
  // The two running tasks name a live process, so the dead-task sweep after activation leaves them running.
  const pid = liveWorkerStandIn(h);
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ id: 'treal00000' + i, ts: now - i * 1000, status: i === 0 ? 'running' : 'done', worker: 'a', model: 'opus', title: 'REAL task ' + i, cwd: h.ws, inputTokens: 10, outputTokens: 1, ...(i === 0 ? { pid } : {}) }));
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ id: 'tpin' + String(i).padStart(6, '0'), ts: 8640000000000000 - i, status: 'done', worker: 'a', model: 'opus', title: 'pinned ' + i, cwd: h.ws, inputTokens: 1000, outputTokens: 1000 }));
  // two more with far-future times: one still running, one a year ahead; and one two minutes ahead (clocks disagree a little)
  lines.push(JSON.stringify({ id: 'tfutrun0001', ts: now + 365 * 86400e3, status: 'running', worker: 'a', model: 'opus', title: 'FUTURE running', cwd: h.ws, pid }));
  lines.push(JSON.stringify({ id: 'tslack00001', ts: now + 120_000, status: 'done', worker: 'a', model: 'opus', title: 'REAL two minutes ahead', cwd: h.ws }));
  fs.writeFileSync(h.logFile, lines.join('\n') + '\n');
  h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
  await activate(h, 700);
  const tree = tasksTree(h);
  const nodes = tree.getChildren();
  const items = nodes.map((n) => tree.getTreeItem(n));
  const real = items.filter((r) => String(r.label).startsWith('REAL'));
  info(`Tasks tree: ${items.length} rows; REAL among them: ${real.length}; running rows: ${items.filter((r) => r.contextValue === 'runningTask').length}; first row: "${items[0].label}"`);
  check('the 5 real tasks (and the one dated two minutes ahead) are listed, at the top', real.length === 6 && items.slice(0, 6).every((r) => String(r.label).startsWith('REAL')), items.slice(0, 8).map((r) => r.label));
  check('the running one is shown as running', items.some((r) => r.label === 'REAL task 0' && r.contextValue === 'runningTask'), items.filter((r) => r.contextValue === 'runningTask').map((r) => r.label));
  check('a task whose only time is in the future is still a task: listed right after the dated ones (a running one before the finished ones with no time), and shown as running', items.findIndex((r) => r.label === 'FUTURE running') === 6 && items.find((r) => r.label === 'FUTURE running')?.contextValue === 'runningTask' && items.slice(7, 300).every((r) => String(r.label).startsWith('pinned')), [items.findIndex((r) => r.label === 'FUTURE running'), items.slice(5, 9).map((r) => r.label)]);
  check('every tree id is unique', new Set(items.map((i) => i.id)).size === items.length, items.length);
  const ui = h.req('uiModel.js');
  const w = ui.dispatchWindows('a');
  check('the 5-hour and 7-day sums count the finished real tasks only (4, and the one two minutes ahead: 5) — not 304', w.session5h.tasks === 5 && w.week.tasks === 5 && w.week.inputTokens === 40, w);
  const m = ui.buildDashboardModel({ workspaceRoot: h.ws, scope: 'workspace' });
  const account = m.accounts.find((a) => a.name === 'a');
  check('the dashboard lists the real tasks first and counts the running ones, future-dated included', m.tasks.slice(0, 6).every((t) => t.title.startsWith('REAL')) && m.running.workspace === 2, [m.tasks.slice(0, 7).map((t) => t.title), m.running]);
  check('…its daily buckets hold the 5 finished real tasks and nothing else', m.daily.reduce((n, d) => n + d.done + d.failed + d.cancelled, 0) === 5, m.daily.filter((d) => d.done + d.failed + d.cancelled > 0));
  check('…and its account card sums the same 5', account && account.session5h.tasks === 5 && account.week.tasks === 5, account && [account.session5h, account.week]);
  const undated = m.tasks.filter((t) => t.title.startsWith('pinned'));
  check('a task with no usable time carries none into the model (no end time, no start time)', undated.length > 0 && undated.every((t) => t.endedAt === null && t.startedAt === null), undated.slice(0, 2));
  // hovers and "ago" texts
  const views = h.req('views.js');
  // The stand-in's appendText writes a space as `&nbsp;`, as the editor's does.
  const hover = (label) => { const at = items.findIndex((r) => r.label === label); return at === -1 ? '<not listed>' : String(tree.resolveTreeItem(items[at], nodes[at]).tooltip.value).replace(/&nbsp;/g, ' '); };
  const pinned = String(items.find((r) => String(r.label).startsWith('pinned')).label);
  check('the hover of a future-dated task says the time is unknown — no clock time, no duration is made up', /unknown time/.test(hover(pinned)) && /unknown time/.test(hover('FUTURE running')) && !/NaN|Invalid/.test(hover(pinned) + hover('FUTURE running')) && /Ended /.test(hover('REAL task 1')) && !/unknown time/.test(hover('REAL task 1')), [hover(pinned).slice(-160), hover('FUTURE running').slice(-160), hover('REAL task 1').slice(-120)]);
  const texts = [8640000000000000, now + 365 * 86400e3, now + 6 * 60_000, now + 60_000, now, now - 90_000, now - 3 * 3600e3, now - 3 * 86400e3, NaN, Infinity, -1, 0, '5', null, undefined, 1e300].map((v) => [String(v), views.agoText(v, now)]);
  check('no "ago" text is negative, NaN or absurd: a time more than five minutes ahead (or not a time at all) prints a dash', texts.every(([, t]) => !/-\d|NaN|Infinity|undefined/.test(t)) && views.agoText(now + 6 * 60_000, now) === '—' && views.agoText(8640000000000000, now) === '—' && views.agoText(0, now) === '—' && views.agoText(now + 60_000, now) === 'just now' && views.agoText(now - 90_000, now) === '1m ago', texts);
  finish(h);
}

/* ---- 9.8  session scan ---- */

async function q1SessionScan() {
  const ACCOUNTS = 5;
  const FILES = 6000;
  const h = boot({ viewsVisible: true });
  const workers = [];
  const pad = 'x'.repeat(200);
  const dirs = [];
  for (let a = 0; a < ACCOUNTS; a++) {
    const dir = path.join(h.home, a === 0 ? '.claude' : `.claude-w${a}`);
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    if (a > 0) workers.push({ name: 'w' + a, configDir: dir, model: 'opus' });
    for (let f = 0; f < FILES; f++) {
      const pid = 3_000_000 + f; // dead pids: what usage probes of earlier versions left behind
      fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: `0000${f}`, cwd: h.ws, kind: 'sdk-cli', startedAt: Date.now(), pad }));
      if (f % 2 === 0) fs.writeFileSync(path.join(dir, 'sessions', `${pid}.${'a'.repeat(64)}.key`), 'k');
    }
  }
  h.writeRegistry({ workers });
  const team = h.req('team.js');
  const sessionOpens = () => spyFs((file, fn) => fn === 'openSync' && file.includes(`${path.sep}sessions${path.sep}`));
  const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
  const spy = sessionOpens();
  const runs = [];
  for (let i = 0; i < 5; i++) { team.invalidateTeamCache(); runs.push(ms(() => team.collectSessions({ workspaceRoot: h.ws, scope: 'workspace' }))); }
  spy.restore();
  const times = runs.map((r) => r[0]).sort((a, b) => a - b);
  info(`${ACCOUNTS} accounts x ${FILES} dead session entries: one poll takes ${runs.map((r) => r[0].toFixed(1)).join(', ')} ms; session files opened in 5 polls: ${spy.calls.length}`);
  check('entries of processes that are gone are not opened at all (0 opens in 5 polls of 10,000 examined names)', spy.calls.length === 0, spy.calls.length);
  check('…and the cut-short listing is still said, once per account (a row, not a silence)', runs[0][1].filter((r) => /incomplete/.test(r.name)).length === ACCOUNTS, runs[0][1].map((r) => r.name).slice(0, 3));
  budget('one Team / dashboard poll (median of 5)', times[2], 40);

  // What is still found, and what a name must be. A small directory, so the listing is complete.
  for (const dir of dirs) fs.rmSync(path.join(dir, 'sessions'), { recursive: true });
  const live = path.join(dirs[1], 'sessions');
  fs.mkdirSync(live);
  const me = process.pid;
  const entry = (pid, name, extra = {}) => JSON.stringify({ pid, sessionId: `${String(pid).padStart(8, '0')}-0000-0000-0000-000000000000`, cwd: h.ws, kind: 'interactive', name, status: 'idle', startedAt: Date.now() - 5000, updatedAt: Date.now(), messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, ...extra });
  fs.writeFileSync(path.join(live, `${me}.json`), entry(me, 'the live one'));
  fs.writeFileSync(path.join(live, `0${me}.json`), entry(me, 'leading zero'));
  fs.writeFileSync(path.join(live, `+${me}.json`), entry(me, 'signed'));
  fs.writeFileSync(path.join(live, `${me}.json.bak`), entry(me, 'backup'));
  fs.writeFileSync(path.join(live, 'abc.json'), entry(me, 'not a pid'));
  fs.writeFileSync(path.join(live, `${me}e0.json`), entry(me, 'exponent'));
  fs.writeFileSync(path.join(live, '99999999999.json'), entry(me, 'past any pid'));
  fs.writeFileSync(path.join(live, '3999999.json'), entry(me, 'a dead pid\'s name, a live pid inside'));
  const ppid = process.ppid;
  fs.writeFileSync(path.join(live, `${ppid}.json`), entry(me, 'another process\'s name, this pid inside'));
  const spy2 = sessionOpens();
  team.invalidateTeamCache();
  const rows = team.collectSessions({ workspaceRoot: h.ws, scope: 'workspace' });
  spy2.restore();
  const opened = spy2.calls.map((c) => path.basename(c.target)).sort();
  check('a live session is found by its file name\'s pid', rows.some((r) => r.name === 'the live one') && rows.filter((r) => r.source === 'peer').length === 1, rows.map((r) => r.name));
  check('names that are not <canonical decimal pid>.json — a leading zero, a sign, an exponent, a suffix, letters, a number past any pid — are skipped WITHOUT being opened, and so is the entry of a pid that is gone', JSON.stringify(opened) === JSON.stringify([`${me}.json`, `${ppid}.json`].sort()), opened);
  check('an entry that says it is another process\'s (its `pid` is not the one its name states) is not listed', !rows.some((r) => /another process/.test(r.name)), rows.map((r) => r.name));
  finish(h);
}

/* ---- 9.9  index freshness ---- */

async function i1IndexFreshness() {
  const h = boot({ viewsVisible: true });
  const now = Date.now();
  const ev = (id, status, extra = {}) => JSON.stringify({ id, ts: now - 60_000, status, worker: 'a', model: 'opus', title: 'task ' + id, cwd: h.ws, ...extra });
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(ev('tinplace' + String(i).padStart(3, '0'), 'done'));
  // Running, and its process is alive: the dead-task sweep after activation leaves it running.
  lines[15] = JSON.stringify({ id: 'tinplace015', ts: now - 60_000, status: 'running', worker: 'a', model: 'opus', title: 'the one that matters', cwd: h.ws, pid: liveWorkerStandIn(h) });
  fs.writeFileSync(h.logFile, lines.join('\n') + '\n');
  h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
  await activate(h, 700);
  const reg = h.req('registry.js');
  const tree = tasksTree(h);
  const shown = (id = 'tinplace015') => { const row = tree.getChildren().find((r) => r.id === id); return row && `${row.status}/${row.title}`; };
  const full = (id = 'tinplace015') => { const e = reg.latestEventById(id); return e && `${e.status === 'error' ? 'failed' : e.status}/${e.title}`; };
  check('as written: the tree and a full parse agree', shown() === 'running/the one that matters' && full() === shown(), [shown(), full()]);
  const rewriteInPlace = (from, to) => {
    const text = fs.readFileSync(h.logFile, 'utf8');
    const edited = text.replace(from, to);
    if (edited === text || Buffer.byteLength(edited) !== Buffer.byteLength(text)) throw new Error('fixture: not a same-length rewrite');
    const fd = fs.openSync(h.logFile, 'r+');
    fs.writeSync(fd, edited, 0);
    fs.closeSync(fd);
  };
  // In place, in the middle, same length — and then the log grows, as it always does.
  rewriteInPlace('"status":"running","worker":"a","model":"opus","title":"the one that matters"', '"status":"done","worker":"a","model":"opus","title":"the one that matters"   ');
  fs.appendFileSync(h.logFile, ev('tinplace900', 'done') + '\n');
  const unnoticed = shown();
  info(`after an in-place rewrite and an append, a plain redraw shows "${unnoticed}" (a full parse: "${full()}")`);
  check('the stated limit: bytes rewritten in place in the middle of a log that then grows are not noticed by a redraw', full().startsWith('done/') && unnoticed === 'running/the one that matters', [unnoticed, full()]);
  // An explicit refresh by the user reads the log from its first byte.
  tree.refresh();
  check('after an explicit refresh of the Tasks tree, the row says what the log says', shown() !== undefined && shown().startsWith('done/') && reg.runningTasks().length === 0, [shown(), full()]);
  // The same through the other two trees' refresh, and through the commands.
  for (const [round, [label, refresh]] of [
    ['the Workers tree\'s refresh (and "Refresh Account Usage", which calls it)', () => workersTree(h).refresh()],
    ['the Worker History tree\'s refresh', () => historyTree(h).refresh()],
    ['the "Refresh Team" command', () => exec(h, 'refreshTeam')],
    ['the "Toggle Task Scope" command (twice)', async () => { await exec(h, 'toggleTaskScope'); await exec(h, 'toggleTaskScope'); }],
  ].entries()) {
    const n = 800 + round;
    const id = 'tinplace0' + String(10 + round).padStart(2, '0');
    const title = `task ${id}`;
    const swapped = `TASK ${id}`.slice(0, title.length);
    rewriteInPlace(`"title":"${title}"`, `"title":"${swapped}"`);
    fs.appendFileSync(h.logFile, ev('tinplace' + n, 'done') + '\n');
    const stale = shown(id);
    await refresh();
    await sleep(20);
    check(`${label} rebuilds the index: a row rewritten in place reads as the log has it`, stale === `done/${title}` && shown(id) === `done/${swapped}`, [stale, shown(id)]);
    // Back as it was, and the rebuild this asks for is made now, not inside the next round.
    rewriteInPlace(`"title":"${swapped}"`, `"title":"${title}"`);
    tree.refresh();
    shown(id);
  }
  // The periodic redraw never rebuilds.
  const spy = spyFs((file) => file === h.logFile);
  for (let i = 0; i < 200; i++) { tree.getChildren(); workersTree(h).getChildren(); historyTree(h).getChildren(); }
  spy.restore();
  check('200 redraws of the three trees with an unchanged log open the log 0 times', spy.calls.length === 0, spy.calls.length);

  // The ten-minute rule: the first change of the log more than ten minutes after the last full read is read from the first byte.
  rewriteInPlace('"title":"task tinplace020"', '"title":"TASK tinplace020"');
  fs.appendFileSync(h.logFile, ev('tinplace901', 'done') + '\n');
  const stale = shown('tinplace020');
  const realNow = Date.now;
  let shift = 9 * 60_000;
  Date.now = () => realNow() + shift;
  fs.appendFileSync(h.logFile, ev('tinplace902', 'done') + '\n');
  const nine = shown('tinplace020');
  shift = 11 * 60_000;
  const spyIdle = spyFs((file) => file === h.logFile);
  const idle = shown('tinplace020');
  spyIdle.restore();
  fs.appendFileSync(h.logFile, ev('tinplace903', 'done') + '\n');
  const eleven = shown('tinplace020');
  check('nine minutes after the last full read a change still extends the index in place; eleven minutes after, the next CHANGE rebuilds it', stale === 'done/task tinplace020' && nine === 'done/task tinplace020' && eleven === 'done/TASK tinplace020', [stale, nine, eleven]);
  check('…while an UNCHANGED log is never read again, however long ago that was', idle === 'done/task tinplace020' && spyIdle.calls.length === 0, [idle, spyIdle.calls.length]);
  shift = 26 * 3600e3;
  const spyOld = spyFs((file) => file === h.logFile);
  shown('tinplace020');
  spyOld.restore();
  check('…not even a day later', spyOld.calls.length === 0, spyOld.calls.length);
  Date.now = realNow;

  // What a rebuild and an idle look cost.
  const big = [];
  for (let i = 0; i < 20_000; i++) big.push(JSON.stringify({ id: 't' + (1_000_000 + i).toString(36) + 'budget', ts: now - 3_600_000 + i, status: 'done', worker: 'a', model: 'opus', title: `budget task ${i} — refactor the widget module`, cwd: h.ws, inputTokens: 100, outputTokens: 10, costUsd: 0.01, promptPreview: 'p'.repeat(120) }));
  fs.writeFileSync(h.logFile, big.join('\n') + '\n');
  tree.getChildren();
  const t0 = process.hrtime.bigint();
  tree.refresh();
  const rowsAfter = tree.getChildren().length;
  const rebuildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) tree.getChildren();
  const idleMs = Number(process.hrtime.bigint() - t1) / 1e6;
  info(`a log of 20,000 tasks (${(fs.statSync(h.logFile).size / 1048576).toFixed(1)} MiB): an explicit refresh rebuilds in ${rebuildMs.toFixed(0)} ms (${rowsAfter} rows drawn); 1,000 idle looks take ${idleMs.toFixed(1)} ms`);
  budget('an explicit refresh of a 20,000-task log', rebuildMs, 800);
  budget('1,000 idle looks at an unchanged log', idleMs, 100);
  finish(h);
}

/* ---- 9.10  the host thread at activation and on idle redraws ---- */

async function a1ActivationSweeps() {
  const h = boot({});
  // A large task log: 300,000 one-event tasks.
  const now = Date.now();
  const parts = [];
  let chunk = '';
  for (let i = 0; i < 300_000; i++) {
    chunk += `{"id":"t${(10_000_000 + i).toString(36)}big","ts":${now - 86_400_000 + i},"status":"done","worker":"a","model":"opus","title":"t${i}"}\n`;
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  fs.writeFileSync(h.logFile, parts.join(''));
  const mib = fs.statSync(h.logFile).size / 1048576;
  h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
  const ledgers = path.join(h.root, 'mesh');
  const spy = spyFs((file) => file === h.logFile || file.startsWith(ledgers) || file.startsWith(path.join(h.root, 'mcp')));
  const { threw, ms } = await activate(h, 0);
  const during = spy.calls.slice();
  check(`within activate() itself nothing opens the task log, a ledger or the stable server copy (${mib.toFixed(0)} MiB log)`, threw === '' && during.length === 0, during.slice(0, 4).map((c) => [c.fn, path.basename(c.target)]));
  info(`activate() with a ${mib.toFixed(0)} MiB task log (300,000 tasks) returned in ${ms.toFixed(0)} ms`);
  budget(`activate() with a ${mib.toFixed(0)} MiB task log`, ms, 250);
  const swept = await until(() => spy.calls.some((c) => c.target === h.logFile), 8000);
  await sleep(300);
  spy.restore();
  check('…and the sweep that reads the whole log still runs, after activate() has returned', swept, spy.calls.length);
  check('…as does the stable server copy', fs.existsSync(path.join(h.root, 'mcp', 'server.js')), fs.existsSync(path.join(h.root, 'mcp')));
  finish(h);
}

async function a2DisposeAtOnce() {
  const h = boot({ globalSettings: { [`${S}.assetAutoSync`]: true } });
  h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
  fs.writeFileSync(h.logFile, JSON.stringify({ id: 'tdispose001', ts: Date.now(), status: 'running', worker: 'a', model: 'opus', title: 'left running', cwd: h.ws, pid: 2_000_000_000 }) + '\n');
  const spy = spyFs((file) => file === h.logFile || file.startsWith(path.join(h.root, 'mcp')));
  const { threw } = await activate(h, 0);
  h.dispose();
  await sleep(900);
  spy.restore();
  const reg = h.req('registry.js');
  check('disposed in the same turn as activate(): none of the steps that were put off is started — the task log is not read, no task is reclaimed', threw === '' && spy.calls.length === 0 && reg.runningTasks().length === 1, [threw, spy.calls.slice(0, 3).map((c) => [c.fn, path.basename(c.target)]), reg.runningTasks().length]);
  check('…the stable server copy is not written', !fs.existsSync(path.join(h.root, 'mcp', 'server.js')), fs.existsSync(path.join(h.root, 'mcp')));
  check('…no usage probe is started', !fs.existsSync(h.callLog) || fs.readFileSync(h.callLog, 'utf8').trim() === '', fs.existsSync(h.callLog) && fs.readFileSync(h.callLog, 'utf8').slice(0, 200));
  check('…and nothing is said', h.log.messages.length === 0, brief(h));
  finish(h);
}

async function a3IdleRedraws() {
  const h = boot({ viewsVisible: true });
  const N = 10;
  const workers = [];
  for (let i = 0; i < N; i++) { const d = path.join(h.home, '.claude-w' + i); fs.mkdirSync(d); workers.push({ name: 'w' + i, configDir: d, model: 'opus' }); }
  workers.push({ name: 'cx', configDir: path.join(h.home, '.codex-cx'), model: '', provider: 'codex' });
  h.writeRegistry({ workers });
  const stats = () => Object.fromEntries(workers.map((w) => [w.name, { tasks: 1, errors: 0, inputTokens: 1, outputTokens: 1, costUsd: 0 }]));
  const statsFile = path.join(h.root, 'stats.json');
  const usageFile = path.join(h.root, 'usage.json');
  fs.writeFileSync(statsFile, JSON.stringify(stats()));
  fs.writeFileSync(usageFile, JSON.stringify(Object.fromEntries(workers.map((w) => [w.configDir, { available: true, fetchedAt: Date.now(), windows: [] }]))));
  fs.writeFileSync(h.logFile, JSON.stringify({ id: 'tidle000001', ts: Date.now(), status: 'done', worker: 'w0', model: 'opus', title: 't', cwd: h.ws, meshWorker: 'cco-w-aaaaaa-w0-1' }) + '\n');
  await activate(h, 900);
  const T = { Workers: workersTree(h), Tasks: tasksTree(h), History: historyTree(h) };
  const draw = (tree, expand) => { for (const n of tree.getChildren()) { tree.getTreeItem(n); if (expand) for (const c of tree.getChildren(n) || []) tree.getTreeItem(c); } };
  for (const t of Object.values(T)) draw(t, true); // warm
  const counts = {};
  for (const [name, tree] of Object.entries(T)) {
    for (const expand of [false, true]) {
      const spy = spyFs((file, fn) => ['openSync', 'readFileSync', 'opendirSync', 'readdirSync'].includes(fn));
      for (let i = 0; i < 100; i++) draw(tree, expand);
      spy.restore();
      counts[`${name} ${expand ? 'expanded' : 'collapsed'}`] = spy.calls.length;
    }
  }
  info(`100 idle redraws, ${N + 1} accounts — files opened or directories listed: ${JSON.stringify(counts)}`);
  check('100 idle redraws of the Workers tree, collapsed and expanded, open no file and list no directory (stat calls only)', counts['Workers collapsed'] === 0 && counts['Workers expanded'] === 0, counts);
  check('…the same for the Tasks tree and the Worker History tree', counts['Tasks collapsed'] === 0 && counts['Tasks expanded'] === 0 && counts['History collapsed'] === 0 && counts['History expanded'] === 0, counts);
  // A change costs one read of the file that changed, however many rows there are.
  const changed = stats();
  changed.w3.tasks = 77;
  await sleep(20);
  fs.writeFileSync(statsFile, JSON.stringify(changed));
  const spy = spyFs((file, fn) => fn === 'openSync' && (file === statsFile || file === usageFile || file === h.registryFile));
  draw(T.Workers, true);
  draw(T.Workers, true);
  spy.restore();
  const per = (f) => spy.calls.filter((c) => c.target === f).length;
  const w3 = T.Workers.getChildren().find((n) => n.name === 'w3');
  const allTime = T.Workers.getChildren(w3).map((c) => T.Workers.getTreeItem(c)).find((i) => /All time/.test(String(i.label)));
  check('after stats.json changed, two expanded redraws of 11 accounts read it ONCE — and the usage cache and the registry not at all', per(statsFile) === 1 && per(usageFile) === 0 && per(h.registryFile) === 0, { stats: per(statsFile), usage: per(usageFile), registry: per(h.registryFile) });
  check('…and the rows show the new figure', allTime && /^77 tasks/.test(String(allTime.description)), allTime && allTime.description);
  // A file made unreadable and readable again without its content changing is read again.
  fs.chmodSync(statsFile, 0o000);
  draw(T.Workers, true);
  fs.chmodSync(statsFile, 0o600);
  const w3b = T.Workers.getChildren().find((n) => n.name === 'w3');
  const again = T.Workers.getChildren(w3b).map((c) => T.Workers.getTreeItem(c)).find((i) => /All time/.test(String(i.label)));
  check('a reading that FAILED is not kept: stats.json made unreadable and then readable again (same size, same mtime) shows its figures again', again && /^77 tasks/.test(String(again.description)), again && again.description);
  finish(h);
}

/**
 * The dead-task sweep runs once after activation and once more when the sweep of orphaned
 * session workers has ended. The two functions are replaced by recorders: what is asserted is
 * the ORDER and the conditions, not what the real sweeps do with a ledger.
 */
async function a4Reap(scenario) {
  const h = boot({ viewsVisible: true });
  h.writeRegistry({ workers: [{ name: 'a', configDir: path.join(h.home, '.claude-a'), model: 'opus' }] });
  const reg = h.req('registry.js');
  const reaper = h.req('mesh/reaper.js');
  const seq = [];
  let reaps = 0;
  reg.reapDeadTasks = (...args) => {
    reaps++;
    seq.push(`reap#${reaps}`);
    seq.args = seq.args ?? [];
    seq.args.push(args.map((a) => typeof a));
    if (scenario === 'throws' && reaps === 2) throw new Error('boom from the second reap');
    return reaps === 2 ? 2 : 0;
  };
  let release;
  reaper.reapOrphanedMeshWorkers = () => {
    seq.push('sweep:start');
    return new Promise((resolve, reject) => {
      release = () => {
        seq.push('sweep:end');
        if (scenario === 'rejects') reject(new Error('the sweep failed'));
        else resolve({ stopped: ['cco-w-aaaaaa-a-1'], marked: [], errors: [] });
      };
    });
  };
  await activate(h, 0);
  check('neither sweep is called before activate() has returned', seq.length === 0, seq.slice());
  const fires = { Tasks: 0, Workers: 0, History: 0 };
  tasksTree(h).onDidChangeTreeData(() => { fires.Tasks++; });
  workersTree(h).onDidChangeTreeData(() => { fires.Workers++; });
  historyTree(h).onDidChangeTreeData(() => { fires.History++; });
  const started = await until(() => seq.includes('sweep:start'), 5000);
  await sleep(250);
  check('after activation: the dead-task sweep runs once, then the session-worker sweep starts — and the second reap waits for it', started && JSON.stringify(seq.slice()) === JSON.stringify(['reap#1', 'sweep:start']), seq.slice());
  if (scenario === 'not-after-dispose') {
    h.dispose();
    const atDispose = { ...fires };
    h.log.messages.length = 0;
    release();
    await sleep(400);
    check('disposed while the session-worker sweep was still running: the dead-task sweep is NOT run a second time', reaps === 1 && JSON.stringify(seq.slice()) === JSON.stringify(['reap#1', 'sweep:start', 'sweep:end']), seq.slice());
    check('…and when that sweep then ends, nothing is said and nothing is redrawn', h.log.messages.length === 0 && JSON.stringify(fires) === JSON.stringify(atDispose), [brief(h), atDispose, fires]);
    return finish(h);
  }
  const before = { ...fires };
  h.log.messages.length = 0;
  release();
  await until(() => reaps === 2, 3000);
  await sleep(150);
  check(`when the session-worker sweep ${scenario === 'rejects' ? 'REJECTS' : 'resolves'}: the dead-task sweep runs a second time, after it`, reaps === 2 && JSON.stringify(seq.slice()) === JSON.stringify(['reap#1', 'sweep:start', 'sweep:end', 'reap#2']), seq.slice());
  check('…with the same arguments as the first (no id list, the mesh-aware liveness check, the mesh-aware recovery)', JSON.stringify(seq.args[0]) === JSON.stringify(seq.args[1]) && seq.args[0][0] === 'undefined' && seq.args[0].length === 3 && seq.args[0][1] !== 'undefined' && seq.args[0][2] !== 'undefined', seq.args);
  if (scenario === 'throws') {
    const said = h.log.output.filter((l) => /dead tasks/.test(l) && /boom from the second reap/.test(l));
    check('a throw from the second reap is ONE line in the output channel', said.length === 1, h.log.output);
    check('…and no tree is redrawn for it', fires.Tasks === before.Tasks && fires.Workers === before.Workers && fires.History === before.History, [before, fires]);
  } else {
    check('it settled 2 tasks: the Tasks, Workers and History trees are each redrawn once, and the user is told', fires.Tasks - before.Tasks === 1 && fires.Workers - before.Workers === 1 && fires.History - before.History === 1 && h.log.messages.some((m) => /Reclaimed 2 dispatched task/.test(String(m.message))), [before, fires, brief(h)]);
  }
  finish(h);
}

/* ---- 9.11  strings ---- */

async function x1Strings() {
  const h = boot({ viewsVisible: true });
  const dir = path.join(h.home, '.claude-w1');
  fs.mkdirSync(dir);
  h.writeRegistry({ workers: [{ name: 'w1', configDir: dir, model: 'opus' }] });
  await activate(h, 900);
  // After activation's own usage refresh (the fake CLI answers nothing): the reading under test.
  const now = Date.now();
  fs.writeFileSync(path.join(h.root, 'usage.json'), JSON.stringify({ [dir]: { name: 'w1', configDir: dir, available: true, fetchedAt: now, subscriptionType: 'max', windows: [], lastGoodWindowsAt: now - 125_000 } }));
  const strings = h.req('dashboard.js').dashboardStrings();
  check('groupSessionNote: a change applies at the next DISPATCH (not "the next Claude Code session")', /next dispatch/.test(strings.groupSessionNote) && !/session/i.test(strings.groupSessionNote), strings.groupSessionNote);
  check('the dashboard names the view by its real title, "Worker Accounts view"', /Worker Accounts view/.test(strings.unsupportedBody) && !/Workers view/.test(strings.unsupportedBody), strings.unsupportedBody);
  const wm = h.req('workerManager.js');
  check('…and so does the refusal of a name an unusable entry holds', /Worker Accounts view/.test(wm.unsupportedNameMessage('x')) && !/Workers view/.test(wm.unsupportedNameMessage('x')), wm.unsupportedNameMessage('x'));
  const tree = workersTree(h);
  const item = tree.getTreeItem(tree.getChildren()[0]);
  check('"plan usage unavailable (last reading 2m ago)"', /plan usage unavailable \(last reading 2m ago\)/.test(String(item.description)), item.description);
  // The Codex keychain choice: what is stored where, and no claim about what still works.
  let store;
  reset(h, {
    quickPick: (list) => {
      if (list.some((i) => i.store === 'keychain')) { store = list; return undefined; }
      return list.find((i) => i.info && i.info.id === 'codex') ?? list.find((i) => i.login === 'separate') ?? list[0];
    },
    inputBox: () => 'cx1',
    message: (rec) => (rec.modal ? rec.items && rec.items[0] : undefined),
  });
  await exec(h, 'addWorker');
  const keychain = store && store.find((i) => i.store === 'keychain');
  check('the Codex keychain choice says where the sign-in is kept and does not claim that login detection "still works"', keychain && /keychain/.test(keychain.detail) && !/still work/.test(keychain.detail) && !/login detection/.test(keychain.detail), keychain && keychain.detail);
  finish(h);
}

/* ---- asset sync: install paths, the ledger, pack files ---- */

const BUNDLED_KEY = 'bundled:skills/orchestrator-retro';
const BUNDLED_REL = 'skills/orchestrator-retro/SKILL.md';

/**
 * A workspace with three enabled assets — the bundled skill and, from a private pack, a
 * command, a hook script and a skill of two files (one of them not text) — none installed yet.
 */
function assetFixture() {
  const h = boot({});
  const pack = path.join(h.scratch, 'pack');
  for (const dir of ['commands', 'hooks', path.join('skills', 'two')]) fs.mkdirSync(path.join(pack, dir), { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'mine' }));
  fs.writeFileSync(path.join(pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello\n');
  fs.writeFileSync(path.join(pack, 'hooks', 'h.sh'), '#!/bin/sh\necho hook\n');
  fs.chmodSync(path.join(pack, 'hooks', 'h.sh'), 0o755);
  fs.writeFileSync(path.join(pack, 'skills', 'two', 'SKILL.md'), '---\nname: two\ndescription: two files\n---\nbody\n');
  // Not UTF-8: an install has to be the pack's bytes, whatever they are.
  fs.writeFileSync(path.join(pack, 'skills', 'two', 'data.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0xc3, 0x28, 0x0a]));
  h.store.global[`${S}.assetPacks`] = [pack];
  h.store.global[`${S}.assetAutoSync`] = true;
  const claude = path.join(h.ws, '.claude');
  const ledgerFile = path.join(claude, 'cco-assets.json');
  const keys = [BUNDLED_KEY, 'mine:commands/hello', 'mine:hooks/h', 'mine:skills/two'];
  const writeLedger = (records = Object.fromEntries(keys.map((k) => [k, { enabled: true, files: {} }]))) => {
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, assets: records }, null, 2) + '\n');
  };
  const bundled = fs.readFileSync(path.join(REPO, 'assets', 'skills', 'orchestrator-retro', 'SKILL.md'));
  const target = path.join(claude, ...BUNDLED_REL.split('/'));
  const at = (rel) => path.join(claude, ...rel.split('/'));
  const same = (rel, source) => { try { return fs.lstatSync(at(rel)).isFile() && fs.readFileSync(at(rel)).equals(fs.readFileSync(source)); } catch { return false; } };
  const othersSynced = () =>
    same('commands/hello.md', path.join(pack, 'commands', 'hello.md')) &&
    same('hooks/h.sh', path.join(pack, 'hooks', 'h.sh')) &&
    same('skills/two/SKILL.md', path.join(pack, 'skills', 'two', 'SKILL.md')) &&
    same('skills/two/data.bin', path.join(pack, 'skills', 'two', 'data.bin'));
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const leftovers = () => {
    const found = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(dir, e.name)); else if (/\.tmp$/.test(e.name)) found.push(path.join(dir, e.name)); } };
    try { walk(claude); } catch { /* a plant in the way */ }
    return found;
  };
  return { h, pack, claude, ledgerFile, keys, writeLedger, bundled, target, at, same, othersSynced, ledger, leftovers };
}

async function assetSync(plant) {
  const fx = assetFixture();
  const { h, target, bundled } = fx;
  fx.writeLedger();
  const victim = path.join(h.scratch, 'victim.md');
  const victimText = 'precious — not an asset\n';
  // Does not exist, in a directory that does: a write through a link to it would create it.
  const nowhere = path.join(h.scratch, 'created-elsewhere.md');
  const BIG = 50 * 1024 * 1024;
  const edited = Buffer.concat([bundled, Buffer.from('\nmy own line\n')]);
  if (plant !== 'control') fs.mkdirSync(path.dirname(target), { recursive: true });
  if (plant === 'fifo') require('child_process').execFileSync('/usr/bin/mkfifo', [target]);
  if (plant === 'symlink') { fs.writeFileSync(victim, victimText); fs.symlinkSync(victim, target); }
  if (plant === 'dangling') fs.symlinkSync(nowhere, target);
  if (plant === 'directory') { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'kept'), 'x'); }
  if (plant === 'big') fs.writeFileSync(target, Buffer.alloc(BIG, 0x61));
  if (plant === 'identical') fs.writeFileSync(target, bundled);
  if (plant === 'edited') fs.writeFileSync(target, edited);
  if (plant === 'big' || plant === 'identical' || plant === 'edited') fs.utimesSync(target, 1_000_000_000, 1_000_000_000);
  const before = plant === 'control' ? undefined : fs.lstatSync(target);
  // Whole-file reads and writes of the planted path, by any means that opens it.
  const spy = spyFs((file) => file === target);
  const blockedPlant = ['fifo', 'symlink', 'dangling', 'directory', 'big'].includes(plant);
  const reason = { fifo: /the path is a FIFO/, symlink: /symbolic link/, dangling: /symbolic link/, directory: /the path is a directory/, big: /52428800 bytes, past the \d+-byte limit/ }[plant];
  const named = (text) => text.includes(BUNDLED_KEY) && text.includes(BUNDLED_REL) && reason.test(text) && /1 file\(s\) not synced/.test(text);
  const unchangedPlant = () => {
    const st = fs.lstatSync(target);
    if (plant === 'fifo') return st.isFIFO();
    if (plant === 'symlink') return st.isSymbolicLink() && fs.readFileSync(victim, 'utf8') === victimText;
    if (plant === 'dangling') return st.isSymbolicLink() && !fs.existsSync(nowhere);
    if (plant === 'directory') return st.isDirectory() && fs.readFileSync(path.join(target, 'kept'), 'utf8') === 'x';
    return st.isFile() && st.ino === before.ino && st.size === before.size && st.mtimeMs === before.mtimeMs;
  };

  // 1. the startup auto-sync
  const t0 = Date.now();
  const { threw } = await activate(h, 0);
  const startup = await until(() => fx.othersSynced(), 10_000);
  await sleep(250);
  check(`startup auto-sync with ${plant === 'control' ? 'nothing in the way' : `a ${plant} at an enabled asset's install path`}: it ends (${Date.now() - t0} ms), nothing thrown, and the OTHER assets are installed — a command, a hook, a two-file skill, byte for byte`, threw === '' && startup, { threw, startup, output: h.log.output.slice(-3) });
  const hookMode = (() => { try { return fs.lstatSync(fx.at('hooks/h.sh')).mode & 0o777; } catch { return -1; } })();
  check('…the hook script is executable, as its pack file is', hookMode !== -1 && (hookMode & 0o111) !== 0, hookMode.toString(8));
  if (plant === 'control') {
    check('…and so is the bundled skill', fx.same(BUNDLED_REL, path.join(REPO, 'assets', 'skills', 'orchestrator-retro', 'SKILL.md')), fs.existsSync(target));
    const l = fx.ledger();
    check('the ledger records a hash for every installed file, and nothing is reported as not synced', fx.keys.every((k) => Object.keys(l.assets[k].files).length > 0) && !h.log.output.some((line) => /not synced/.test(line)), [l, h.log.output]);
    // An update replaces the installed copy by name and keeps the mode the user gave it.
    fs.chmodSync(fx.at('commands/hello.md'), 0o640);
    const inoBefore = fs.lstatSync(fx.at('commands/hello.md')).ino;
    fs.writeFileSync(path.join(fx.pack, 'commands', 'hello.md'), '---\ndescription: hi\n---\nhello, again\n');
    const writes = spyFs((file) => file === fx.at('commands/hello.md') || file === fx.ledgerFile);
    reset(h);
    await exec(h, 'syncAssets');
    writes.restore();
    const opened = writes.calls.filter((c) => (c.fn === 'openSync' && isWriteOpen(c.flags)) || ['writeFileSync', 'appendFileSync', 'copyFileSync'].includes(c.fn));
    check('an update of an installed file: the new content, the same permission bits, 1 updated', fx.same('commands/hello.md', path.join(fx.pack, 'commands', 'hello.md')) && (fs.lstatSync(fx.at('commands/hello.md')).mode & 0o777) === 0o640 && h.log.messages.some((m) => /1 updated/.test(String(m.message))), [(fs.lstatSync(fx.at('commands/hello.md')).mode & 0o777).toString(8), brief(h)]);
    check('…written by replacing the name: neither the install path nor the ledger is ever opened for writing', opened.length === 0 && fs.lstatSync(fx.at('commands/hello.md')).ino !== inoBefore, opened.slice(0, 3));
    check('no temp file is left under .claude', fx.leftovers().length === 0, fx.leftovers());
    return finish(h);
  }
  check(`the ${plant} is exactly as it was`, unchangedPlant(), (() => { const st = fs.lstatSync(target); return { file: st.isFile(), link: st.isSymbolicLink(), fifo: st.isFIFO(), dir: st.isDirectory(), size: st.size }; })());
  if (blockedPlant) {
    const lines = h.log.output.filter((l) => l.startsWith('[assets] not synced:'));
    check('the output channel names the asset that was left alone, its file, and why', lines.length === 1 && lines[0].includes(BUNDLED_KEY) && lines[0].includes(BUNDLED_REL) && reason.test(lines[0]), h.log.output.filter((l) => l.includes('[assets]')));
    const said = h.log.messages.filter((m) => /^Claude assets synced/.test(String(m.message)));
    check('…and so does the notification of the startup sync', said.length === 1 && named(String(said[0].message)) && /3 installed/.test(String(said[0].message)), brief(h));
    check('the ledger records no file for the asset that was left alone, and one for each of the others', Object.keys(fx.ledger().assets[BUNDLED_KEY].files).length === 0 && fx.keys.slice(1).every((k) => Object.keys(fx.ledger().assets[k].files).length > 0), fx.ledger());
  }

  // 2. the manual sync command
  reset(h);
  const t1 = Date.now();
  const r = await exec(h, 'syncAssets');
  const manualMs = Date.now() - t1;
  const manual = h.log.messages.filter((m) => /^Workspace assets synced/.test(String(m.message)));
  if (blockedPlant) {
    check(`"Sync Workspace Assets Now": ends (${manualMs} ms), and its report names the asset, the file and the reason`, r.threw === '' && manual.length === 1 && named(String(manual[0].message)) && !/everything up to date/.test(String(manual[0].message)), [r.threw, brief(h)]);
    check(`…the ${plant} is still exactly as it was`, unchangedPlant(), 'changed');
    // What a view shows for it, and what a reset does to it.
    const assets = h.req('assets.js');
    const packs = h.req('packSources.js').loadedPacks(h.context);
    const asset = packs.flatMap((p) => p.assets).find((a) => a.key === BUNDLED_KEY);
    const status = assets.assetStatus(asset, assets.readAssetState(h.ws), h.ws);
    const files = assets.assetFiles(asset, assets.readAssetState(h.ws), h.ws);
    check('the Asset Manager\'s status for it is "customized" — the state that means sync leaves the file alone', status === 'customized' && files.length === 1 && files[0].state === 'customized', [status, files.map((f) => f.state)]);
    const forced = (() => { try { return assets.syncWorkspace(packs, h.ws, new Set([BUNDLED_KEY])); } catch (e) { return { threw: String(e && e.message).slice(0, 160), updated: [], installed: [] }; } })();
    check('a RESET of the asset does not write it either: left as it was, and reported again', unchangedPlant() && Array.isArray(forced.blocked) && forced.blocked.length === 1 && forced.blocked[0].asset === BUNDLED_KEY && forced.blocked[0].rel === BUNDLED_REL && reason.test(forced.blocked[0].reason) && forced.updated.length === 0 && forced.installed.length === 0, forced);
  }
  if (blockedPlant) {
    // 3. the next window of the same workspace: nothing changed, the same file is in the way
    h.dispose();
    h.context.subscriptions.length = 0;
    reset(h);
    h.log.output.length = 0;
    const next = await activate(h, 0);
    await until(() => h.log.output.some((l) => l.startsWith('[assets] not synced:')), 8000);
    await sleep(250);
    const lines = h.log.output.filter((l) => l.startsWith('[assets] not synced:'));
    check('the next window: the file that is still in the way is named in the output channel again, and NOT in a second notification', next.threw === '' && lines.length === 1 && lines[0].includes(BUNDLED_REL) && reason.test(lines[0]) && h.log.messages.length === 0 && unchangedPlant(), [next.threw, lines, brief(h)]);
  }
  if (plant === 'big') {
    const whole = spy.calls.filter((c) => c.fn === 'readFileSync');
    check('the 50 MB file is never read as content (no whole-file read of it by the startup sync, the command, the status, the reset or the next window)', whole.length === 0, whole.length);
  }
  if (plant === 'identical') {
    check('a file that already holds the pack\'s content is adopted, not rewritten: same inode and mtime, its hash now in the ledger, "everything up to date"', unchangedPlant() && typeof fx.ledger().assets[BUNDLED_KEY].files[BUNDLED_REL] === 'string' && manual.length === 1 && /everything up to date/.test(String(manual[0].message)), [fx.ledger().assets[BUNDLED_KEY], brief(h)]);
  }
  if (plant === 'edited') {
    check('a file the user edited is kept as a user modification, exactly as before: byte-identical, "1 customized file(s) left untouched", and NOT reported as not synced', unchangedPlant() && fs.readFileSync(target).equals(edited) && manual.length === 1 && /1 customized file\(s\) left untouched/.test(String(manual[0].message)) && !/not synced/.test(String(manual[0].message)) && !h.log.output.some((l) => /not synced/.test(l)), brief(h));
  }
  spy.restore();
  const wrote = spy.calls.filter((c) => (c.fn === 'openSync' && isWriteOpen(c.flags)) || ['writeFileSync', 'appendFileSync', 'copyFileSync'].includes(c.fn));
  check('the planted path was never opened for writing', wrote.length === 0, wrote.slice(0, 3));
  check('no temp file is left under .claude', fx.leftovers().length === 0, fx.leftovers());
  finish(h);
}

/**
 * A DISABLED asset whose one file sync installed earlier — its hash is in the ledger. Sync
 * removes that file, and only that file: not what a link at the path or on the way to it
 * leads to, not something it would have to wait on, not a file it cannot read whole.
 */
async function assetRemoval(plant) {
  const fx = assetFixture();
  const { h, pack } = fx;
  const KEY = 'mine:commands/hello';
  const REL = 'commands/hello.md';
  const installed = fs.readFileSync(path.join(pack, 'commands', 'hello.md'));
  const hash = require('crypto').createHash('sha256').update(installed).digest('hex');
  fx.writeLedger({
    [BUNDLED_KEY]: { enabled: true, files: {} },
    [KEY]: { enabled: false, files: { [REL]: hash } },
    'mine:hooks/h': { enabled: true, files: {} },
    'mine:skills/two': { enabled: true, files: {} },
  });
  const target = fx.at(REL);
  // Outside `.claude`, holding a file with exactly the recorded content: read through a link,
  // its hash is the one sync recorded.
  const outside = path.join(h.scratch, 'outside');
  const victim = path.join(outside, 'hello.md');
  fs.mkdirSync(outside);
  fs.writeFileSync(victim, installed);
  const BIG = 50 * 1024 * 1024;
  const edited = Buffer.concat([installed, Buffer.from('my own line\n')]);
  if (plant === 'dirlink') fs.symlinkSync(outside, path.dirname(target));
  else fs.mkdirSync(path.dirname(target), { recursive: true });
  if (plant === 'control') fs.writeFileSync(target, installed);
  if (plant === 'edited') fs.writeFileSync(target, edited);
  if (plant === 'fifo') require('child_process').execFileSync('/usr/bin/mkfifo', [target]);
  if (plant === 'symlink') fs.symlinkSync(victim, target);
  if (plant === 'directory') { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'kept'), 'x'); }
  if (plant === 'big') fs.writeFileSync(target, Buffer.alloc(BIG, 0x61));
  const ino = plant === 'dirlink' ? 0 : fs.lstatSync(target).ino;
  const blockedPlant = ['fifo', 'symlink', 'dirlink', 'directory', 'big'].includes(plant);
  const reason = { fifo: /the path is a FIFO/, symlink: /symbolic link/, dirlink: /symbolic link that leads out of \.claude/, directory: /the path is a directory/, big: /52428800 bytes, past the \d+-byte limit/ }[plant];
  const named = (text) => text.includes(KEY) && text.includes(REL) && reason.test(text) && /1 file\(s\) not synced/.test(text);
  // What this case itself reads and writes is kept out of the record of opens below.
  let own = false;
  const quietly = (fn) => { own = true; try { return fn(); } finally { own = false; } };
  const victimWhole = () => quietly(() => fs.lstatSync(victim).isFile() && fs.readFileSync(victim).equals(installed) && JSON.stringify(fs.readdirSync(outside)) === JSON.stringify(['hello.md']));
  const asItWas = () => quietly(() => {
    if (!victimWhole()) return false;
    if (plant === 'dirlink') return fs.lstatSync(path.dirname(target)).isSymbolicLink();
    const st = fs.lstatSync(target);
    if (st.ino !== ino) return false;
    if (plant === 'fifo') return st.isFIFO();
    if (plant === 'symlink') return st.isSymbolicLink();
    if (plant === 'directory') return st.isDirectory() && fs.readFileSync(path.join(target, 'kept'), 'utf8') === 'x';
    if (plant === 'big') return st.isFile() && st.size === BIG;
    return st.isFile() && fs.readFileSync(target).equals(edited);
  });
  const othersSynced = () =>
    fx.same(BUNDLED_REL, path.join(REPO, 'assets', 'skills', 'orchestrator-retro', 'SKILL.md')) &&
    fx.same('hooks/h.sh', path.join(pack, 'hooks', 'h.sh')) &&
    fx.same('skills/two/SKILL.md', path.join(pack, 'skills', 'two', 'SKILL.md')) &&
    fx.same('skills/two/data.bin', path.join(pack, 'skills', 'two', 'data.bin'));
  const recordKept = () => { const r = fx.ledger().assets[KEY]; return r !== undefined && r.enabled === false && r.files[REL] === hash; };
  // Every open of the recorded path by the code under test.
  const spy = spyFs((file) => !own && file === target);

  // 1. the startup auto-sync
  const t0 = Date.now();
  const { threw } = await activate(h, 0);
  const startup = await until(() => quietly(othersSynced), 10_000);
  await sleep(250);
  check(`startup auto-sync with a disabled asset's recorded file ${plant === 'control' ? 'as sync installed it' : plant === 'edited' ? 'edited by the user' : `replaced by a ${plant}`}: it ends (${Date.now() - t0} ms), nothing thrown, and the enabled assets are installed`, threw === '' && startup, { threw, startup, output: h.log.output.slice(-3) });
  const said = h.log.messages.filter((m) => /^Claude assets synced/.test(String(m.message)));
  if (plant === 'control') {
    check('the file sync installed is removed, its emptied directory with it, and its record is gone from the ledger', !fs.existsSync(target) && !fs.existsSync(path.dirname(target)) && fx.ledger().assets[KEY] === undefined && said.length === 1 && /1 file\(s\) removed/.test(String(said[0].message)) && !/not synced/.test(String(said[0].message)), [fs.existsSync(target), fx.ledger().assets[KEY], brief(h)]);
    check('…and nothing outside .claude was touched', victimWhole(), fs.readdirSync(outside));
  } else if (plant === 'edited') {
    check('a file the user edited is kept, exactly as before: byte-identical, its record kept, "1 customized file(s) left untouched", and NOT reported as not synced', asItWas() && recordKept() && said.length === 1 && /1 customized file\(s\) left untouched/.test(String(said[0].message)) && !/not synced/.test(String(said[0].message)) && !h.log.output.some((l) => /not synced/.test(l)), [fx.ledger().assets[KEY], brief(h)]);
  } else {
    check(`nothing is removed: the ${plant} is exactly as it was, and so is the file outside .claude that holds the recorded content`, asItWas(), { victim: fs.existsSync(victim), outside: fs.readdirSync(outside) });
    const lines = h.log.output.filter((l) => l.startsWith('[assets] not synced:'));
    check('the output channel names the asset, its file, and why it was left', lines.length === 1 && lines[0].includes(KEY) && lines[0].includes(REL) && reason.test(lines[0]), h.log.output.filter((l) => l.includes('[assets]')));
    check('…and so does the notification of the startup sync', said.length === 1 && named(String(said[0].message)) && /3 installed/.test(String(said[0].message)) && !/removed/.test(String(said[0].message)), brief(h));
    check('the record stays in the ledger (disabled, with its hash), so the removal is tried again once the path is a file', recordKept(), fx.ledger().assets[KEY]);
  }

  // 2. the manual sync command
  reset(h);
  const t1 = Date.now();
  const r = await exec(h, 'syncAssets');
  const manual = h.log.messages.filter((m) => /^Workspace assets synced/.test(String(m.message)));
  if (blockedPlant) {
    check(`"Sync Workspace Assets Now": ends (${Date.now() - t1} ms), removes nothing, and its report names the asset, the file and the reason`, r.threw === '' && manual.length === 1 && named(String(manual[0].message)) && !/everything up to date/.test(String(manual[0].message)) && asItWas() && recordKept(), [r.threw, brief(h)]);
    // How the path was looked at, by the two syncs together.
    const opens = spy.calls.filter((c) => c.fn === 'openSync' || c.fn === 'readFileSync');
    const O = fs.constants;
    if (plant === 'symlink' || plant === 'dirlink') {
      check('a path that is a link, or is reached through one, is never opened at all — so what the link leads to is never hashed', opens.length === 0, opens.slice(0, 3));
    } else {
      check('the path is only ever opened read-only, non-blocking and no-follow — and never read by name', opens.length > 0 && opens.every((c) => c.fn === 'openSync' && typeof c.flags === 'number' && (c.flags & O.O_NONBLOCK) !== 0 && (c.flags & O.O_NOFOLLOW) !== 0 && !isWriteOpen(c.flags)), opens.slice(0, 3));
    }
    // The obstacle gone and the file sync installed back in its place: now it is removed.
    quietly(() => {
      if (plant === 'dirlink') { fs.unlinkSync(path.dirname(target)); fs.mkdirSync(path.dirname(target)); } else fs.rmSync(target, { recursive: true, force: true });
      fs.writeFileSync(target, installed);
    });
    reset(h);
    await exec(h, 'syncAssets');
    check('with the file sync installed back at the path, the next sync removes it and drops the record', !fs.existsSync(target) && fx.ledger().assets[KEY] === undefined && h.log.messages.some((m) => /1 file\(s\) removed/.test(String(m.message))) && victimWhole(), [fs.existsSync(target), fx.ledger().assets[KEY], brief(h)]);
  } else if (plant === 'edited') {
    check('"Sync Workspace Assets Now" keeps the edited file too', r.threw === '' && asItWas() && recordKept() && manual.length === 1 && /1 customized file\(s\) left untouched/.test(String(manual[0].message)), [r.threw, brief(h)]);
  } else {
    check('"Sync Workspace Assets Now" after the removal: everything up to date', r.threw === '' && manual.length === 1 && /everything up to date/.test(String(manual[0].message)), [r.threw, brief(h)]);
  }
  spy.restore();
  const wrote = spy.calls.filter((c) => (c.fn === 'openSync' && isWriteOpen(c.flags)) || ['writeFileSync', 'appendFileSync', 'copyFileSync'].includes(c.fn));
  check('the recorded path is never opened for writing', wrote.length === 0, wrote.slice(0, 3));
  check('no temp file is left under .claude', fx.leftovers().length === 0, fx.leftovers());
  finish(h);
}

/** Something that is not a ledger at the ledger's path. Nothing may be read through it or waited on. */
async function assetLedger(plant) {
  const fx = assetFixture();
  const { h, ledgerFile, claude } = fx;
  fs.mkdirSync(claude, { recursive: true });
  const victim = path.join(h.scratch, 'elsewhere-ledger.json');
  // A ledger this version would understand — somewhere else.
  const victimText = JSON.stringify({ version: 1, assets: { 'mine:commands/hello': { enabled: true, files: {} } } }, null, 2) + '\n';
  if (plant === 'fifo') require('child_process').execFileSync('/usr/bin/mkfifo', [ledgerFile]);
  if (plant === 'symlink') { fs.writeFileSync(victim, victimText); fs.symlinkSync(victim, ledgerFile); }
  if (plant === 'directory') { fs.mkdirSync(ledgerFile); fs.writeFileSync(path.join(ledgerFile, 'kept'), 'x'); }
  const asItWas = () => {
    const st = fs.lstatSync(ledgerFile);
    if (plant === 'fifo') return st.isFIFO();
    if (plant === 'symlink') return st.isSymbolicLink() && fs.readFileSync(victim, 'utf8') === victimText;
    return st.isDirectory() && fs.readFileSync(path.join(ledgerFile, 'kept'), 'utf8') === 'x';
  };
  const nothingInstalled = () => JSON.stringify(fs.readdirSync(claude).sort()) === JSON.stringify(['cco-assets.json']);
  const refusals = () => h.log.messages.filter((m) => /assets were not changed/.test(String(m.message)));
  const t0 = Date.now();
  const { threw } = await activate(h, 0);
  await until(() => refusals().length > 0, 8000);
  await sleep(250);
  check(`startup auto-sync with a ${plant} at .claude/cco-assets.json: it ends (${Date.now() - t0} ms) and is refused ONCE, with the file named and "Open File"`, threw === '' && refusals().length === 1 && String(refusals()[0].message).includes(ledgerFile) && JSON.stringify(refusals()[0].items) === JSON.stringify(['Open File']), [threw, brief(h)]);
  check('…nothing is installed, and the path is exactly as it was', nothingInstalled() && asItWas(), fs.readdirSync(claude));
  for (const command of ['syncAssets', 'manageAssets', 'resetAsset']) {
    reset(h, { quickPick: (list) => list });
    const r = await exec(h, command);
    await sleep(20);
    check(`${command}: refused with the same message, nothing installed, nothing thrown`, r.threw === '' && refusals().length === 1 && nothingInstalled() && asItWas(), [r.threw, brief(h), fs.readdirSync(claude)]);
  }
  if (plant === 'symlink') check('a ledger is not read THROUGH a link: the one it points at enabled an asset, and that asset was not installed', !fs.existsSync(path.join(claude, 'commands')), fs.readdirSync(claude));
  check('no temp file is left under .claude', fx.leftovers().length === 0, fx.leftovers());
  finish(h);
}

async function assetPackFifo() {
  const fx = assetFixture();
  const { h, pack } = fx;
  fx.writeLedger();
  // A pipe named pack.json in a pack directory: the pack is listed at every activation.
  fs.rmSync(path.join(pack, 'pack.json'));
  require('child_process').execFileSync('/usr/bin/mkfifo', [path.join(pack, 'pack.json')]);
  const assets = h.req('assets.js');
  const t0 = Date.now();
  const loaded = assets.loadPack(pack);
  check(`loadPack with a pipe at pack.json: it returns (${Date.now() - t0} ms) with the directory's own name and the pack's assets`, loaded && loaded.name === 'pack' && loaded.assets.length === 3, loaded && [loaded.name, loaded.assets.map((a) => a.key)]);
  const { threw } = await activate(h, 800);
  check('…and activation with that pack configured ends too, the bundled asset installed', threw === '' && fx.same(BUNDLED_REL, path.join(REPO, 'assets', 'skills', 'orchestrator-retro', 'SKILL.md')), [threw, h.log.output.slice(-3)]);
  finish(h);
}

async function assetTemplate() {
  const fx = assetFixture();
  const { h, pack } = fx;
  const assets = h.req('assets.js');
  const tryCreate = (type, id) => { try { return { file: assets.createAssetTemplate(pack, type, id) }; } catch (e) { return { threw: String(e.message) }; } };
  // The link's target does not exist, but the directory it would be in does: a write through
  // the link would create it.
  const nowhere = path.join(h.scratch, 'made-elsewhere.md');
  fs.symlinkSync(nowhere, path.join(pack, 'commands', 'dangling.md'));
  let r = tryCreate('command', 'dangling');
  check('a new asset whose file name is a dangling link: refused as already there, and NOTHING is created where the link points', /already exists/.test(String(r.threw)) && !fs.existsSync(nowhere) && fs.lstatSync(path.join(pack, 'commands', 'dangling.md')).isSymbolicLink(), [r, fs.existsSync(nowhere)]);
  require('child_process').execFileSync('/usr/bin/mkfifo', [path.join(pack, 'commands', 'pipe.md')]);
  const t0 = Date.now();
  r = tryCreate('command', 'pipe');
  check('…a pipe at the name: refused at once, and left', /already exists/.test(String(r.threw)) && Date.now() - t0 < 3000 && fs.lstatSync(path.join(pack, 'commands', 'pipe.md')).isFIFO(), [r, Date.now() - t0]);
  r = tryCreate('command', 'fresh');
  check('a free name: the template is created', r.file === path.join(pack, 'commands', 'fresh.md') && /^---\n/.test(fs.readFileSync(r.file, 'utf8')), r);
  check('…and creating it a second time is refused, the first one untouched', /already exists/.test(String(tryCreate('command', 'fresh').threw)), tryCreate('command', 'fresh'));
  r = tryCreate('hook', 'guard');
  check('a hook template is executable (0755)', r.file !== undefined && (fs.lstatSync(r.file).mode & 0o777) === 0o755, r.file && (fs.lstatSync(r.file).mode & 0o777).toString(8));
  r = tryCreate('skill', 'newskill');
  check('a skill template lands in a directory of its own', r.file === path.join(pack, 'skills', 'newskill', 'SKILL.md') && fs.existsSync(r.file), r);
  const tmp = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(dir, e.name)); else if (/\.tmp$/.test(e.name)) tmp.push(e.name); } };
  walk(pack);
  check('no temp file is left in the pack', tmp.length === 0, tmp);
  finish(h);
}

/**
 * The sync engine alone, against arrangements of the workspace's `.claude` that are not a
 * plain tree of files: a second name for an installed file, something that is no directory
 * where a directory is needed, links to directories.
 */
async function assetEngineEdges() {
  const h = boot({});
  const assets = h.req('assets.js');
  let n = 0;
  const fixture = () => {
    const root = path.join(h.scratch, `edge-${++n}`);
    const pack = path.join(root, 'pack');
    const ws = path.join(root, 'ws');
    const claude = path.join(ws, '.claude');
    fs.mkdirSync(path.join(pack, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(pack, 'skills', 's1'), { recursive: true });
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(pack, 'pack.json'), '{"name":"p"}');
    fs.writeFileSync(path.join(pack, 'commands', 'a.md'), 'A v1\n');
    fs.writeFileSync(path.join(pack, 'commands', 'b.md'), 'B v1\n');
    fs.writeFileSync(path.join(pack, 'skills', 's1', 'SKILL.md'), '---\nname: s1\ndescription: d\n---\n');
    const records = { version: 1, assets: Object.fromEntries(['p:commands/a', 'p:commands/b', 'p:skills/s1'].map((k) => [k, { enabled: true, files: {} }])) };
    const ledgerInto = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'cco-assets.json'), JSON.stringify(records)); };
    const sync = (...more) => { try { return assets.syncWorkspace([assets.loadPack(pack)], ws, ...more); } catch (e) { return { threw: String(e && e.message).slice(0, 200), blocked: [], installed: [], updated: [] }; } };
    return { root, pack, ws, claude, ledgerInto, sync, at: (rel) => path.join(claude, ...rel.split('/')) };
  };
  const text = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return `<${e.code}>`; } };
  const blockedFor = (r, rel) => (r.blocked || []).filter((b) => b.rel === rel).map((b) => b.reason);

  // An installed file that has a second name outside the workspace (a hard link): the same
  // inode, so a write INTO the file would change the other name's content too.
  {
    const f = fixture();
    f.ledgerInto(f.claude);
    f.sync();
    const victim = path.join(f.root, 'second-name.md');
    fs.unlinkSync(f.at('commands/a.md'));
    fs.writeFileSync(victim, 'A v1\n');
    fs.linkSync(victim, f.at('commands/a.md'));
    fs.writeFileSync(path.join(f.pack, 'commands', 'a.md'), 'A v2\n');
    const r = f.sync();
    check('an update of an installed file that has a second name elsewhere: the install path gets the new content, the other name keeps the old', text(f.at('commands/a.md')) === 'A v2\n' && text(victim) === 'A v1\n' && r.updated.length === 1, [r, text(victim)]);
    const mine = path.join(f.root, 'second-name-2.md');
    fs.unlinkSync(f.at('commands/b.md'));
    fs.writeFileSync(mine, 'the user\'s own\n');
    fs.linkSync(mine, f.at('commands/b.md'));
    const forced = f.sync(new Set(['p:commands/b']));
    check('…and a RESET of an edited file that has a second name elsewhere: the same', text(f.at('commands/b.md')) === 'B v1\n' && text(mine) === 'the user\'s own\n' && forced.updated.length === 1, [forced, text(mine)]);
  }
  // Something that is no directory where an asset type's directory goes.
  for (const kind of ['a regular file', 'a pipe']) {
    const f = fixture();
    f.ledgerInto(f.claude);
    if (kind === 'a pipe') require('child_process').execFileSync('/usr/bin/mkfifo', [path.join(f.claude, 'commands')]);
    else fs.writeFileSync(path.join(f.claude, 'commands'), 'not a directory');
    const t0 = Date.now();
    const r = f.sync();
    check(`${kind} at .claude/commands: the two commands are reported as not synced, the skill is installed, and what was put there is left (${Date.now() - t0} ms)`, r.threw === undefined && blockedFor(r, 'commands/a.md').length === 1 && blockedFor(r, 'commands/b.md').length === 1 && text(f.at('skills/s1/SKILL.md')).startsWith('---') && (kind === 'a pipe' ? fs.lstatSync(path.join(f.claude, 'commands')).isFIFO() : text(path.join(f.claude, 'commands')) === 'not a directory'), r);
  }
  // `.claude` itself may be a link to a directory: where a workspace keeps it is its owner's choice.
  {
    const f = fixture();
    const elsewhere = path.join(f.root, 'elsewhere');
    f.ledgerInto(elsewhere);
    fs.symlinkSync(elsewhere, f.claude);
    const r = f.sync();
    check('.claude that is a link to a directory: every asset is installed there, nothing is reported', r.threw === undefined && r.installed.length === 3 && (r.blocked || []).length === 0 && text(path.join(elsewhere, 'commands', 'a.md')) === 'A v1\n' && fs.lstatSync(f.claude).isSymbolicLink(), r);
  }
  // A directory link BELOW `.claude`: one that stays inside is followed, one that leads out is not.
  {
    const f = fixture();
    f.ledgerInto(f.claude);
    fs.mkdirSync(path.join(f.claude, 'real-commands'));
    fs.symlinkSync(path.join(f.claude, 'real-commands'), path.join(f.claude, 'commands'));
    const out = path.join(f.root, 'outside-skills');
    fs.mkdirSync(out);
    fs.symlinkSync(out, path.join(f.claude, 'skills'));
    const r = f.sync();
    check('a directory link below .claude that stays inside it is written through; one that leads out is reported and NOTHING is created where it leads', r.threw === undefined && text(path.join(f.claude, 'real-commands', 'a.md')) === 'A v1\n' && fs.readdirSync(out).length === 0 && /leads out of \.claude/.test(String(blockedFor(r, 'skills/s1/SKILL.md')[0])) && r.installed.length === 2, [r, fs.readdirSync(out)]);
  }
  // `.claude` that is a link to nowhere: nothing is created where it points, and the refusal says so.
  {
    const f = fixture();
    const nowhere = path.join(f.root, 'nowhere');
    fs.symlinkSync(nowhere, f.claude);
    let threw = '';
    try { assets.setAssetEnabled(f.ws, 'p:commands/a', true); } catch (e) { threw = String(e && e.message); }
    check('.claude that is a link to nowhere: enabling an asset is refused with the ledger named, and nothing is created where the link points', /^Could not write .*cco-assets\.json: /.test(threw) && !fs.existsSync(nowhere) && fs.lstatSync(f.claude).isSymbolicLink(), [threw, fs.existsSync(nowhere)]);
  }
  finish(h);
}

/* ---- dispatch ---- */

(async () => {
  const s1match = /^S1-([a-z]+)@(.+)$/.exec(CASE);
  if (CASE === 'S1-control') return s1('control', undefined);
  if (CASE === 'S1-legacy-linked') return s1LegacyLinked();
  if (s1match) return s1(s1match[1], s1match[2]);
  if (CASE === 'S2-policy-file') return s2PolicyFile();
  if (CASE.startsWith('K-')) return keepalive(CASE.slice(2));
  if (CASE === 'W1-row-commands') return w1RowCommands();
  if (CASE === 'W2-rows-that-are-no-account') return w2RowsThatAreNoAccount();
  if (CASE === 'N1-add-rename') return n1AddRename();
  if (CASE === 'N2-import') return n2Import();
  if (CASE === 'N3-names-already-stored') return n3NamesAlreadyStored();
  if (CASE === 'L1-login-shell') return l1LoginShell();
  if (CASE === 'L2-dispose-during-lookup') return l2DisposeDuringLookup();
  if (CASE === 'P1-cancel-pgid') return p1CancelPgid();
  if (CASE === 'T1-future-ts') return t1FutureTs();
  if (CASE === 'Q1-session-scan') return q1SessionScan();
  if (CASE === 'I1-index-freshness') return i1IndexFreshness();
  if (CASE === 'A1-activation-sweeps') return a1ActivationSweeps();
  if (CASE === 'A2-dispose-at-once') return a2DisposeAtOnce();
  if (CASE === 'A3-idle-redraws') return a3IdleRedraws();
  if (CASE === 'A4-reap-after-sweep-resolves') return a4Reap('resolves');
  if (CASE === 'A4-reap-after-sweep-rejects') return a4Reap('rejects');
  if (CASE === 'A4-reap-throws') return a4Reap('throws');
  if (CASE === 'A4-reap-not-after-dispose') return a4Reap('not-after-dispose');
  if (CASE === 'X1-strings') return x1Strings();
  if (CASE.startsWith('AS-')) return assetSync(CASE.slice(3));
  if (CASE.startsWith('AL-')) return assetLedger(CASE.slice(3));
  if (CASE.startsWith('AR-')) return assetRemoval(CASE.slice(3));
  if (CASE === 'AP-pack-fifo') return assetPackFifo();
  if (CASE === 'AP-template') return assetTemplate();
  if (CASE === 'AP-engine-edges') return assetEngineEdges();
  console.log(`FAIL ${CASE}: no such case`);
  process.exit(1);
})().catch((e) => {
  console.log(`FAIL ${CASE}: the case threw — ${String((e && e.stack) || e).slice(0, 900)}`);
  process.exit(1);
});
