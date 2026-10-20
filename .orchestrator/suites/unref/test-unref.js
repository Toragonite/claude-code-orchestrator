// Proves the ladder timers (and leftover pipes) never keep the HOST process alive.
// `node test-unref.js` runs the three scenarios as subprocesses and times how long each lives;
// `node test-unref.js <scenario>` is one scenario, which simply stops doing things and lets
// the event loop drain — no process.exit().
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const S = __dirname;
const FAKE = path.join(S, '..', 'lib', 'fake-claude.js');
if (!os.homedir().startsWith(S)) {
  console.error('REFUSING TO RUN: HOME is not the scratch home');
  process.exit(2);
}
const scenario = process.argv[2];

if (!scenario) {
  let fail = 0;
  const kill = (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  };
  for (const [name, limitMs, why] of [
    ['term', 1000, 'SIGKILL timer (2000 ms) pending'],
    ['stdin', 1000, 'SIGTERM timer (3000 ms) pending'],
    ['grandchild', 2000, 'pipes held open for 6000 ms by a grandchild'],
  ]) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8', timeout: 20000 });
    const info = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const armed = info.find((i) => i.ready);
    // Measured from the moment the ladder was armed (the fake is known to be up by then), so a
    // slow first exec of the fake cannot make a ref'd timer look unref'd.
    const ms = armed ? Date.now() - armed.armedAt : Date.now() - t;
    const ok = r.status === 0 && ms < limitMs && !!armed;
    if (!ok) {
      fail++;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  U-${name}: host process exited by itself ${ms}ms after arming (< ${limitMs}ms) with ${why}  [status=${r.status} ${r.stderr.trim()}]`);
    for (const i of info) {
      for (const pid of i.pids || []) {
        kill(pid);
      }
    }
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const usage = require('./build/usage.js');
  const logFile = path.join(S, 'logs', `U-${scenario}.jsonl`);
  fs.rmSync(logFile, { force: true });
  const out = (o) => process.stdout.write(JSON.stringify({ armedAt: Date.now(), ...o }) + '\n');
  // Run `fn` once the fake has logged that it is up (its signal handlers are installed).
  const whenUp = (fn) => {
    const poll = setInterval(() => {
      let up = false;
      try {
        up = fs.readFileSync(logFile, 'utf8').includes('"ev":"start"');
      } catch {
        // not written yet
      }
      if (up) {
        clearInterval(poll);
        setTimeout(fn, 100);
      }
    }, 20);
  };
  if (scenario === 'term') {
    const c = spawn(FAKE, ['-p', 'x'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, FAKE_MODE: 'hang,ignore-term', FAKE_LOG: logFile },
    });
    c.unref();
    whenUp(() => {
      usage.terminateChild(c, 'signal');
      out({ ready: true, pids: [c.pid] });
    });
  } else if (scenario === 'stdin') {
    const c = spawn(FAKE, ['-p', '--input-format', 'stream-json'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env, FAKE_MODE: 'ignore-stdin,ignore-term', FAKE_LOG: logFile },
    });
    c.unref();
    whenUp(() => {
      usage.terminateChild(c, 'end-stdin');
      out({ ready: true, pids: [c.pid] });
    });
  } else if (scenario === 'grandchild') {
    fs.chmodSync(FAKE, 0o755);
    fs.writeFileSync(
      path.join(os.homedir(), '.claude-code-orchestrator', 'registry.json'),
      JSON.stringify({ claudePath: FAKE, workers: [] }),
    );
    process.env.FAKE_MODE = 'grandchild';
    process.env.FAKE_LOG = logFile;
    usage.fetchAccountUsage('alpha', path.join(S, 'home', '.claude-worker-a')).then((u) => {
      const log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const g = log.find((e) => e.ev === 'grandchild');
      out({ ready: u.available === true, pids: g ? [g.gpid] : [] });
    });
  }
}
