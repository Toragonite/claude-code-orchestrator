#!/usr/bin/env node
// Fake `claude` for exercising the termination ladder. NEVER the real binary.
// Behaviour is selected by FAKE_MODE (comma-separated flags); every event is appended to FAKE_LOG.
const fs = require('fs');
const { spawn } = require('child_process');

const modes = new Set((process.env.FAKE_MODE || '').split(',').filter(Boolean));
const logFile = process.env.FAKE_LOG;
const log = (ev, extra) => {
  try {
    fs.appendFileSync(logFile, JSON.stringify({ ev, t: Date.now(), pid: process.pid, ...extra }) + '\n');
  } catch {
    // no log file — nothing to record
  }
};

const pick = (k) => (process.env[k] === undefined ? null : process.env[k]);
const args = process.argv.slice(2);
log('start', {
  argv: args,
  cwd: process.cwd(),
  env: {
    CLAUDE_CONFIG_DIR: pick('CLAUDE_CONFIG_DIR'),
    CLAUDECODE: pick('CLAUDECODE'),
    CLAUDE_CODE_ENTRYPOINT: pick('CLAUDE_CODE_ENTRYPOINT'),
    CLAUDE_CODE_SESSION_ID: pick('CLAUDE_CODE_SESSION_ID'),
    CLAUDE_CODE_MESSAGING_SOCKET: pick('CLAUDE_CODE_MESSAGING_SOCKET'),
    CLAUDE_CODE_MESSAGING_TOKEN: pick('CLAUDE_CODE_MESSAGING_TOKEN'),
    CLAUDE_PROJECT_DIR: pick('CLAUDE_PROJECT_DIR'),
    CLAUDE_CODE_OAUTH_TOKEN: pick('CLAUDE_CODE_OAUTH_TOKEN'),
    CLAUDE_CODE_USE_BEDROCK: pick('CLAUDE_CODE_USE_BEDROCK'),
  },
});

// Safety net: no fake outlives a test run, whatever it was told to ignore.
setTimeout(() => {
  log('selfdestruct');
  process.exit(99);
}, 15000);
setInterval(() => log('hb'), 100);
process.on('exit', (code) => log('exit', { code }));
process.on('SIGTERM', () => {
  log('sigterm');
  if (!modes.has('ignore-term')) {
    process.exit(143);
  }
});

if (modes.has('grandchild')) {
  // A process that outlives us while holding OUR stdout/stderr pipes — 'close' never fires upstream.
  const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 6000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  g.unref();
  log('grandchild', { gpid: g.pid });
}

const USAGE_DATA = {
  rate_limits_available: !modes.has('no-limits'),
  subscription_type: 'max',
  rate_limits: modes.has('no-limits')
    ? null
    : {
        five_hour: { utilization: 12, resets_at: '2099-01-01T00:00:00Z' },
        seven_day: { utilization: 34, resets_at: '2099-01-02T00:00:00Z' },
      },
  session: { total_cost_usd: 0.5 },
};

if (args[0] === 'auth') {
  if (!modes.has('silent')) {
    const body = modes.has('logged-out')
      ? { loggedIn: false, authMethod: 'none' }
      : { loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com' };
    process.stdout.write('notice: an update is available\n' + JSON.stringify(body) + '\n');
  }
  if (!modes.has('hang')) {
    setTimeout(() => process.exit(modes.has('logged-out') ? 1 : 0), 30);
  }
} else if (args.includes('stream-json')) {
  if (modes.has('exit-early')) {
    process.stderr.write('boom: not logged in\n');
    setTimeout(() => process.exit(1), 30);
  } else {
    if (!modes.has('no-hello')) {
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    }
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        log('request', { subtype: msg && msg.request && msg.request.subtype });
        if (modes.has('silent')) {
          continue;
        }
        const resp =
          JSON.stringify({
            type: 'control_response',
            response: modes.has('error-response')
              ? { subtype: 'error', request_id: msg.request_id }
              : { subtype: 'success', request_id: msg.request_id, response: USAGE_DATA },
          }) + '\n';
        if (modes.has('respond-then-exit')) {
          process.stdout.write(resp, () => process.exit(0));
        } else {
          process.stdout.write(resp);
          if (modes.has('chatty-after')) {
            const junk = 'x'.repeat(8192) + '\n';
            setInterval(() => {
              process.stdout.write(junk);
              process.stderr.write(junk);
            }, 5);
          }
        }
      }
    });
    process.stdin.on('end', () => {
      log('stdin-end');
      if (!modes.has('ignore-stdin')) {
        setTimeout(() => process.exit(0), 150);
      }
    });
  }
} else {
  // keepalive ping: `-p <prompt> --model haiku`
  if (modes.has('ping-fail')) {
    setTimeout(() => process.exit(3), 30);
  } else if (!modes.has('hang')) {
    setTimeout(() => process.exit(0), 30);
  }
}
