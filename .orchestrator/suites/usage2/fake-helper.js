// A stand-in for out/mcp/provider-cli.js. NEVER starts a vendor CLI.
// Behaviour is chosen per account directory or per provider from FAKE_HELPER_MODES (JSON map),
// else FAKE_HELPER_MODE, else "ok". Every event is appended to FAKE_HELPER_LOG.
const fs = require('fs');
const { spawn } = require('child_process');

const [command, provider, configDir, ...rest] = process.argv.slice(2);
let modes = {};
try {
  modes = JSON.parse(process.env.FAKE_HELPER_MODES || '{}');
} catch {
  modes = {};
}
const mode = modes[configDir] || modes[provider] || process.env.FAKE_HELPER_MODE || 'ok';
const log = (ev, extra) => {
  try {
    fs.appendFileSync(process.env.FAKE_HELPER_LOG, JSON.stringify({ ev, t: Date.now(), pid: process.pid, provider, configDir, mode, ...extra }) + '\n');
  } catch {
    // no log file
  }
};
const IDENTITY = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT'];
// SHELL-FIX (D1): the Anthropic variables no vendor child may inherit, and a few it must keep.
const ANTHROPIC = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'];
const PASSED = ['PATH', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'HTTPS_PROXY'];
log('start', {
  anthropicLeaked: ANTHROPIC.filter((k) => k in process.env),
  passed: Object.fromEntries(PASSED.map((k) => [k, process.env[k] ?? null])),
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  execArgv: process.execArgv,
  identityLeaked: IDENTITY.filter((k) => k in process.env),
  keep: process.env.KEEP_ME ?? null,
  home: process.env.HOME ?? null,
  hasIpc: typeof process.send === 'function',
});
process.on('exit', (code) => log('exit', { code }));
// Safety net: no fake outlives a test run.
setTimeout(() => {
  log('selfdestruct');
  process.exit(99);
}, 45000).unref();

const quota = rest.includes('--quota')
  ? {
      allowed: true,
      windows: [
        { label: '5h limit', usedPercent: 12, resetAt: '2031-01-01T00:00:00.000Z' },
        { label: 'Weekly limit', usedPercent: 34, resetAt: '2031-01-05T00:00:00.000Z' },
      ],
    }
  : null;
const status = (over = {}) => JSON.stringify({ cliFound: true, loggedIn: true, mode: 'chatgpt', quota, error: null, ...over });
const say = (line, code) => process.stdout.write(line + '\n', () => (code === undefined ? undefined : process.exit(code)));

switch (mode) {
  case 'ok':
    say(status(), 0);
    break;
  case 'slow':
    setTimeout(() => say(status(), 0), 700);
    break;
  case 'garbage':
    say('this is not json\n<<<{]]\n{"half":', 0);
    break;
  case 'refuse':
    // the shape the contract names for a bad argument
    say(JSON.stringify({ error: 'unknown provider "nope"' }), 2);
    break;
  case 'refuse-status':
    // the shape the delivered helper actually prints for a bad argument
    say(status({ loggedIn: null, mode: null, quota: null, error: 'missing configDir — usage: provider-cli status …' }), 2);
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  case 'hang-stubborn':
    process.on('SIGTERM', () => log('sigterm-ignored'));
    setInterval(() => {}, 1000);
    break;
  case 'answer-then-hang':
    say(status());
    setInterval(() => {}, 1000);
    break;
  case 'crash':
    process.stderr.write('Error: boom\n    at somewhere (provider-cli.js:1:1)\n', () => process.exit(1));
    break;
  case 'silent-exit':
    process.exit(0);
    break;
  case 'noisy':
    process.stderr.write('E'.repeat(300000));
    process.stdout.write('warning: an update is available\n' + 'x'.repeat(20000) + '\n');
    say(status(), 0);
    break;
  case 'flood':
    // more stdout than the reader keeps, with the status only at the very end
    process.stdout.write(('y'.repeat(1000) + '\n').repeat(200));
    say(status(), 0);
    break;
  case 'giant':
    // one line far past what the reader keeps: there is no status to find
    say('{"cliFound":true,"pad":"' + 'z'.repeat(200000) + '"}', 0);
    break;
  case 'cli-missing':
    say(status({ cliFound: false, loggedIn: null, mode: null, quota: null, error: 'codex not found — the Codex CLI is not installed or not on PATH' }), 0);
    break;
  case 'logged-out':
    say(status({ loggedIn: false, mode: null, quota: null }), 0);
    break;
  case 'unknown-login':
    say(status({ loggedIn: null, mode: null, quota: null }), 0);
    break;
  case 'pipe-holder': {
    // exits at once while a detached grandchild keeps stdout open: 'close' would wait 6 s
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
    g.unref();
    say(status(), 0);
    break;
  }
  case 'hostile': {
    const windows = [];
    for (let i = 0; i < 500; i++) {
      windows.push({ label: '<img src=x onerror=alert(1)>‮\u0007\n' + 'L'.repeat(5000), usedPercent: i % 3 === 0 ? 'NaN' : i % 3 === 1 ? 1e308 : -40, resetAt: i % 2 ? 'not a date' : 12345 });
    }
    say(JSON.stringify({ cliFound: 'yes', loggedIn: 'true', mode: 12, quota: { allowed: 'maybe', windows }, error: { a: 1 } }), 0);
    break;
  }
  default:
    say(status(), 0);
}
