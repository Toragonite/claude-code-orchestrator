// keychain-guard.cjs — preloaded (NODE_OPTIONS=--require, or required first thing in-process)
// into every Node process a harness of this repository starts or is.
//
// It exists because the Cursor adapter's `quota()` reads the account token from the macOS
// keychain: on darwin, with AGENT_CLI_CREDENTIAL_STORE unset or `default`, it spawns the
// ABSOLUTE path `/usr/bin/security find-generic-password … -w` with a minimal environment. A
// PATH sandbox does not stop an absolute path, and a redirected HOME does not reliably stop
// macOS from resolving the user's login keychain — so without this file a suite that reaches a
// Cursor worker's quota path could read the user's real token. Tests never read keychain
// values or real credentials. So this file, in every process it is loaded into:
//
//   1. sets AGENT_CLI_CREDENTIAL_STORE=memory when it is unset (the adapter then reads neither
//      the keychain nor the auth files), and puts itself on NODE_OPTIONS when it is not there
//      yet, so a child spawned with `...process.env` is guarded too (an allow-list environment
//      builder must add both itself — `envVars()` below gives them);
//   2. wraps spawn / spawnSync / execFile / execFileSync / exec / execSync / fork so that any
//      attempt to run `security` — the absolute path, the bare name resolved on PATH, through a
//      command wrapper (`env security …`), or inside a shell command string — is REFUSED:
//      nothing is launched; the call is turned into the real API's own failure for a program
//      that does not exist (an 'error' event / `error` result / thrown error / callback error,
//      code ENOENT), which every caller already handles. Each refusal appends ONE JSON line
//      {pid, argv0, args: [first argument only], ts} to the file CCO_KEYCHAIN_GUARD_LOG names
//      (when set). No further argument and no value is ever written.
//
// The harness process itself calls `harness(label)` once: it gets its own temp directory with
// the log file, and an 'exit' hook that prints a FAIL line and makes the exit code nonzero when
// that log is not empty. `selfCheck(env)` proves the preload path is live in a child started
// with a given environment (a deliberate `spawn('/usr/bin/security', ['help'])`).
//
// Residuals: a program that execs `security` by itself (a shell script, a native binary) is not
// seen — only Node's child_process API is. A shell string that builds the name at run time
// (`s=sec; ${s}urity`) is not recognised. Loaded twice, it wraps once.

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const MARK = Symbol.for('cco.keychainGuard');
const SELF = __filename;
const REFUSED_PROGRAM = '/nonexistent-cco-keychain-guard/security-refused';

if (!process.env.AGENT_CLI_CREDENTIAL_STORE) {
  process.env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
}
if (!String(process.env.NODE_OPTIONS || '').includes(SELF)) {
  process.env.NODE_OPTIONS = nodeOptionsWith(process.env.NODE_OPTIONS);
}

/** NODE_OPTIONS with this guard's --require first, the rest kept. */
function nodeOptionsWith(existing) {
  const own = `--require ${JSON.stringify(SELF)}`;
  if (typeof existing === 'string' && existing.includes(SELF)) {
    return existing;
  }
  return typeof existing === 'string' && existing.trim() !== '' ? `${own} ${existing}` : own;
}

/** The variables an allow-list environment builder must carry for its children to be guarded. */
function envVars(base) {
  const out = {
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    NODE_OPTIONS: nodeOptionsWith(base && base.NODE_OPTIONS),
  };
  if (process.env.CCO_KEYCHAIN_GUARD_LOG) {
    out.CCO_KEYCHAIN_GUARD_LOG = process.env.CCO_KEYCHAIN_GUARD_LOG;
  }
  return out;
}

const WRAPPERS = new Set(['env', 'sudo', 'nohup', 'xcrun', 'time', 'nice', 'command', 'exec', 'arch']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// `security` as a word in command position or as the last path segment of one.
const IN_SHELL = /(?:^|[\s;&|(){}`'"=!/])security(?=$|[\s;&|()`'"<>])/;

function base(cmd) {
  return typeof cmd === 'string' ? path.basename(cmd.trim()) : '';
}

/** The word after `security` in a shell string — the only argument ever logged. */
function shellFirstArg(str) {
  const m = /security\s+([^\s;&|()`'"<>]+)/.exec(str);
  return m ? [m[1]] : [];
}

/** null when the call may run; else the record to log. */
function verdict(cmd, args, shell) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (shell) {
    const str = [String(cmd), ...list].join(' ');
    return IN_SHELL.test(str) ? { argv0: 'shell', args: shellFirstArg(str) } : null;
  }
  const b = base(cmd);
  if (b === 'security') {
    return { argv0: String(cmd), args: list.slice(0, 1) };
  }
  if (SHELLS.has(b)) {
    const i = list.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (i >= 0 && typeof list[i + 1] === 'string' && IN_SHELL.test(list[i + 1])) {
      return { argv0: String(cmd), args: shellFirstArg(list[i + 1]) };
    }
    return null;
  }
  if (WRAPPERS.has(b)) {
    const i = list.findIndex((a) => base(a) === 'security');
    if (i >= 0) {
      return { argv0: list[i], args: list.slice(i + 1, i + 2) };
    }
  }
  return null;
}

function record(v) {
  const file = process.env.CCO_KEYCHAIN_GUARD_LOG;
  if (!file) {
    return;
  }
  const first = v.args.length > 0 ? [String(v.args[0]).slice(0, 64)] : [];
  try {
    fs.appendFileSync(file, JSON.stringify({ pid: process.pid, argv0: String(v.argv0).slice(0, 200), args: first, ts: Date.now() }) + '\n');
  } catch {
    // evidence only; the call is refused either way
  }
}

/** (args, options) of a spawn-style call whose args are optional. */
function split(rest) {
  const args = Array.isArray(rest[0]) ? rest[0] : [];
  const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
  return { args, options: options && typeof options === 'object' ? options : {} };
}

function lastFn(rest) {
  return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined;
}

if (!globalThis[MARK]) {
  globalThis[MARK] = true;
  const real = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    fork: childProcess.fork,
  };
  const refusedOptions = (options) => ({ stdio: options.stdio, encoding: options.encoding });

  childProcess.spawn = function spawn(cmd, ...rest) {
    const { args, options } = split(rest);
    const v = verdict(cmd, args, options.shell);
    if (v) {
      record(v);
      return real.spawn.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.spawn.call(this, cmd, ...rest);
  };
  childProcess.spawnSync = function spawnSync(cmd, ...rest) {
    const { args, options } = split(rest);
    const v = verdict(cmd, args, options.shell);
    if (v) {
      record(v);
      return real.spawnSync.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.spawnSync.call(this, cmd, ...rest);
  };
  childProcess.execFile = function execFile(cmd, ...rest) {
    const { args, options } = split(rest.filter((r) => typeof r !== 'function'));
    const v = verdict(cmd, args, options.shell);
    if (v) {
      record(v);
      const cb = lastFn(rest);
      return cb ? real.execFile.call(this, REFUSED_PROGRAM, [], refusedOptions(options), cb) : real.execFile.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.execFile.call(this, cmd, ...rest);
  };
  childProcess.execFileSync = function execFileSync(cmd, ...rest) {
    const { args, options } = split(rest);
    const v = verdict(cmd, args, options.shell);
    if (v) {
      record(v);
      return real.execFileSync.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.execFileSync.call(this, cmd, ...rest);
  };
  childProcess.exec = function exec(command, ...rest) {
    const v = verdict(command, [], true);
    if (v) {
      record(v);
      const options = rest[0] && typeof rest[0] === 'object' ? rest[0] : {};
      const cb = lastFn(rest);
      return cb ? real.execFile.call(this, REFUSED_PROGRAM, [], refusedOptions(options), cb) : real.execFile.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.exec.call(this, command, ...rest);
  };
  childProcess.execSync = function execSync(command, ...rest) {
    const v = verdict(command, [], true);
    if (v) {
      record(v);
      const options = rest[0] && typeof rest[0] === 'object' ? rest[0] : {};
      return real.execFileSync.call(this, REFUSED_PROGRAM, [], refusedOptions(options));
    }
    return real.execSync.call(this, command, ...rest);
  };
  childProcess.fork = function fork(modulePath, ...rest) {
    const { options } = split(rest);
    const v = typeof options.execPath === 'string' ? verdict(options.execPath, [String(modulePath)], false) : null;
    if (v) {
      record(v);
      return real.spawn.call(this, REFUSED_PROGRAM, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    }
    return real.fork.call(this, modulePath, ...rest);
  };
  // `util.promisify(execFile)` / `promisify(exec)` resolve {stdout, stderr} through this symbol.
  for (const name of ['execFile', 'exec']) {
    const wrapped = childProcess[name];
    wrapped[util.promisify.custom] = (...a) =>
      new Promise((resolve, reject) => {
        wrapped(...a, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
      });
  }
  try {
    require('module').syncBuiltinESMExports();
  } catch {
    // older runtimes: ESM named imports taken before this point keep the real functions
  }
}

/**
 * Called once by the harness process itself: a temp directory of its own holding the log file,
 * CCO_KEYCHAIN_GUARD_LOG / AGENT_CLI_CREDENTIAL_STORE / NODE_OPTIONS in process.env (so every child
 * spawned from process.env inherits them), and an 'exit' hook that FAILS the harness when the log
 * is not empty. The directory is outside any sandbox the harness removes, and is removed by the
 * hook only when the log is empty. A second call in the same process (two harness modules
 * imported by one entry point) returns the first call's answer. `{ selfCheck: true }` runs
 * selfCheck(process.env) — the environment a `...process.env` child gets — prints its line as
 * PASS / FAIL, and a FAIL fails the harness at exit too.
 */
let current;
function harness(label, { selfCheck: check = false } = {}) {
  if (current) {
    return current;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcguard-'));
  const logFile = path.join(dir, 'keychain-guard.log');
  fs.writeFileSync(logFile, '');
  process.env.CCO_KEYCHAIN_GUARD_LOG = logFile;
  process.env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  process.env.NODE_OPTIONS = nodeOptionsWith(process.env.NODE_OPTIONS);
  let selfCheckFailed = false;
  if (check) {
    const r = selfCheck(process.env);
    selfCheckFailed = !r.ok;
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.line}\n`);
  }
  process.on('exit', () => {
    if (selfCheckFailed) {
      process.exitCode = 1;
    }
    let text = '';
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      text = '';
    }
    if (text.trim() !== '') {
      process.stdout.write(`FAIL keychain-guard (${label}): ${text.trim().split('\n').length} keychain access attempt(s) refused — see ${logFile}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`keychain-guard (${label}): clean — the guard log is empty\n`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leftover empty log is harmless
    }
  });
  current = { logFile, env: envVars };
  return current;
}

/**
 * Start a child node with `env` that tries `spawn('/usr/bin/security', ['help'])`, and say whether
 * the guard refused and logged it there. The child logs to a file of its own, never the harness log.
 * Returns { ok, line } — `line` is what the harness prints.
 */
function selfCheck(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcguard-self-'));
  const logFile = path.join(dir, 'self.log');
  const script =
    "const c=require('child_process').spawn('/usr/bin/security',['help'],{stdio:['ignore','pipe','pipe']});" +
    "c.on('error',e=>{process.stdout.write(JSON.stringify({error:e.code,guard:!!globalThis[Symbol.for('cco.keychainGuard')],store:process.env.AGENT_CLI_CREDENTIAL_STORE}))});" +
    "c.on('spawn',()=>{process.stdout.write(JSON.stringify({launched:true}))});";
  const res = childProcess.spawnSync(process.execPath, ['-e', script], {
    env: { ...env, CCO_KEYCHAIN_GUARD_LOG: logFile },
    encoding: 'utf8',
    timeout: 15_000,
  });
  let out = {};
  try {
    out = JSON.parse(res.stdout || '{}');
  } catch {
    out = {};
  }
  let lines = [];
  try {
    lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    lines = [];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // harmless
  }
  const logged = lines.length === 1 && lines[0].argv0 === '/usr/bin/security' && JSON.stringify(lines[0].args) === '["help"]';
  const ok = out.error === 'ENOENT' && out.guard === true && out.store === 'memory' && logged && !out.launched;
  return {
    ok,
    line: `keychain-guard self-check: a child's spawn('/usr/bin/security', ['help']) ${ok ? 'was refused and logged' : 'was NOT refused as expected'} (child said ${JSON.stringify(out)}, ${lines.length} log line(s))`,
  };
}

module.exports = { harness, selfCheck, envVars, nodeOptionsWith, GUARD_PATH: SELF };
