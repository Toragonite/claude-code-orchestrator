'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* probeClaudeVersion against FAKE executables only. Usage:
 *   env -i HOME=<tmp> PATH=... [vars to prove they are stripped] node test-probe.js <bundle.js>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
let pass = 0;
let fail = 0;
function check(name, cond, observed) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (observed !== undefined ? ': ' + observed : ''));
}

const BIN = path.join(HOME, 'bin');
fs.rmSync(BIN, { recursive: true, force: true });
fs.mkdirSync(BIN, { recursive: true });
const NODE = process.execPath;
const fake = (name, body) => {
  const file = path.join(BIN, name);
  fs.writeFileSync(file, '#!' + NODE + '\n' + body, { mode: 0o755 });
  return file;
};
const COUNT = path.join(HOME, 'spawn-count.txt');
const ENVDUMP = path.join(HOME, 'env-dump.json');
const bump = `require('fs').appendFileSync(${JSON.stringify(COUNT)}, process.argv.slice(2).join(' ') + '\\n');`;
const good = fake('claude-good', `${bump} require('fs').writeFileSync(${JSON.stringify(ENVDUMP)}, JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) })); console.log('2.1.283 (Claude Code)');`);
const old = fake('claude-old', `${bump} console.log('2.1.200 (Claude Code)');`);
const exit1 = fake('claude-exit1', `${bump} console.log('2.1.283 (Claude Code)'); process.exit(1);`);
const banner = fake('claude-banner', `${bump} console.log('welcome to something else');`);
const hostile = fake('claude-hostile', `${bump} process.stdout.write('\\u202E9.9.9 <img src=x onerror=alert(1)>' + 'A'.repeat(100000) + '\\n');`);
const hang = fake('claude-hang', `${bump} setInterval(() => {}, 1000);`);
const stubborn = fake('claude-stubborn', `${bump} process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(path.join(HOME, 'stubborn.pid'))}, String(process.pid)); setInterval(() => {}, 1000);`);
// Prints the version, then exits while a detached grandchild keeps the stdout pipe open:
// 'close' would not fire until the grandchild ends, 'exit' fires at once (P16).
const pipeHolder = fake(
  'claude-pipeholder',
  `${bump} const { spawn } = require('child_process');
   const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
   g.unref(); process.stdout.write('2.1.283 (Claude Code)\\n', () => process.exit(0));`,
);
const notExecutable = path.join(BIN, 'claude-noexec');
fs.writeFileSync(notExecutable, 'echo 2.1.283', { mode: 0o644 });

const { ui } = require(path.resolve(process.argv[2]));
const spawns = () => (fs.existsSync(COUNT) ? fs.readFileSync(COUNT, 'utf8').split('\n').filter(Boolean).length : 0);
const timed = async (p) => { const t0 = Date.now(); let v; let rejected = false; try { v = await p; } catch (e) { rejected = true; v = e; } return { v, ms: Date.now() - t0, rejected }; };

(async () => {
  let r = await timed(ui.probeClaudeVersion(good));
  check('reads the version of a working CLI', r.v === '2.1.283 (Claude Code)' && !r.rejected, JSON.stringify(r));
  const dump = JSON.parse(fs.readFileSync(ENVDUMP, 'utf8'));
  check('spawned as `--version` only', JSON.stringify(dump.argv) === '["--version"]', JSON.stringify(dump.argv));
  const leaked = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR'].filter((k) => k in dump.env);
  check('claudeEnv: session-identity variables are not inherited', leaked.length === 0 && process.env.CLAUDE_CODE_MESSAGING_TOKEN === 'tok', 'leaked=' + JSON.stringify(leaked) + ' parent had token=' + process.env.CLAUDE_CODE_MESSAGING_TOKEN);
  check('claudeEnv: CLAUDE_CONFIG_DIR is absent for the default host dir; user config flows through', !('CLAUDE_CONFIG_DIR' in dump.env) && dump.env.CLAUDE_CODE_USE_BEDROCK === '1', JSON.stringify({ has: 'CLAUDE_CONFIG_DIR' in dump.env, bedrock: dump.env.CLAUDE_CODE_USE_BEDROCK }));

  const before = spawns();
  r = await timed(ui.probeClaudeVersion(good));
  const r2 = await timed(ui.probeClaudeVersion('  ' + good + '  '));
  check('a reading is cached (no second spawn; trimmed path is the same key)', r.v === '2.1.283 (Claude Code)' && r2.v === r.v && spawns() === before && r.ms < 50, 'spawns ' + before + ' → ' + spawns());

  const b2 = spawns();
  const both = await Promise.all([ui.probeClaudeVersion(old), ui.probeClaudeVersion(old), ui.probeClaudeVersion(old)]);
  check('concurrent callers share one child', both.every((v) => v === '2.1.200 (Claude Code)') && spawns() === b2 + 1, 'spawns +' + (spawns() - b2));

  r = await timed(ui.probeClaudeVersion(exit1));
  check('non-zero exit → null', r.v === null && !r.rejected, JSON.stringify(r));
  const b3 = spawns();
  r = await timed(ui.probeClaudeVersion(exit1));
  check('a failure is cached too (no immediate re-spawn)', r.v === null && spawns() === b3, 'spawns +' + (spawns() - b3));
  r = await timed(ui.probeClaudeVersion(banner));
  check('exit 0 with no version in the output → null', r.v === null, JSON.stringify(r));
  r = await timed(ui.probeClaudeVersion(hostile));
  check('hostile output: flattened, ≤ 40 chars, still parseable', typeof r.v === 'string' && r.v.length <= 40 && r.v.startsWith('9.9.9 <img') && !/[‮\n]/.test(r.v), JSON.stringify(r));
  r = await timed(ui.probeClaudeVersion(path.join(BIN, 'does-not-exist')));
  check('missing binary → null, never rejects', r.v === null && !r.rejected && r.ms < 2000, JSON.stringify(r));
  r = await timed(ui.probeClaudeVersion(notExecutable));
  check('non-executable file → null, never rejects', r.v === null && !r.rejected, JSON.stringify(r));
  r = await timed(ui.probeClaudeVersion(BIN));
  check('a directory → null, never rejects', r.v === null && !r.rejected, JSON.stringify(r));
  for (const bad of ['', '   ', 'cla\u0000ude', 5, null, undefined, {}, 'x'.repeat(5000)]) {
    r = await timed(ui.probeClaudeVersion(bad));
    check('unusable claudePath ' + JSON.stringify(typeof bad === 'string' ? bad.slice(0, 12) : bad) + ' → null without spawning', r.v === null && !r.rejected && r.ms < 50, JSON.stringify(r));
  }

  r = await timed(ui.probeClaudeVersion(pipeHolder));
  check('settles on exit although a grandchild holds the pipe open for 6 s', r.v === '2.1.283 (Claude Code)' && r.ms < 2000, r.ms + ' ms → ' + JSON.stringify(r.v));

  r = await timed(ui.probeClaudeVersion(hang));
  check('a hanging CLI → null after the 8 s timeout', r.v === null && r.ms >= 7900 && r.ms < 9500 && !r.rejected, r.ms + ' ms');
  r = await timed(ui.probeClaudeVersion(stubborn));
  check('a CLI that ignores SIGTERM → null at 8 s (the answer does not wait for the kill)', r.v === null && r.ms >= 7900 && r.ms < 9500, r.ms + ' ms');
  const pid = Number(fs.readFileSync(path.join(HOME, 'stubborn.pid'), 'utf8'));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const aliveAtTimeout = alive(pid);
  await new Promise((res) => setTimeout(res, 2600));
  check('… and it is SIGKILLed 2 s later', aliveAtTimeout === true && alive(pid) === false, 'alive at timeout=' + aliveAtTimeout + ', alive 2.6 s later=' + alive(pid));

  // TTLs, with the clock moved instead of waiting
  const realNow = Date.now;
  const b4 = spawns();
  Date.now = () => realNow() + 61_000;
  r = await timed(ui.probeClaudeVersion(exit1));
  check('a failure is re-probed after 1 minute', spawns() === b4 + 1, 'spawns +' + (spawns() - b4));
  const b5 = spawns();
  Date.now = () => realNow() + 9 * 60_000;
  await ui.probeClaudeVersion(good);
  const stillCached = spawns() === b5;
  Date.now = () => realNow() + 11 * 60_000;
  await ui.probeClaudeVersion(good);
  check('a reading is kept for 10 minutes, then re-probed', stillCached && spawns() === b5 + 1, 'at 9 min cached=' + stillCached + ', at 11 min spawns +' + (spawns() - b5));
  Date.now = () => realNow() - 3_600_000;
  const b6 = spawns();
  await ui.probeClaudeVersion(good);
  check('a clock that jumped backwards does not pin a stale verdict', spawns() === b6 + 1, 'spawns +' + (spawns() - b6));
  Date.now = realNow;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL — unexpected rejection: ' + (e && e.stack));
  process.exit(1);
});
