'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* SHELL-FIX proof (D1, host side): the environment of the forked provider helper.
 *
 * A FAKE helper stands in for out/mcp/provider-cli.js: it dumps its whole environment and its
 * argv to a file and prints one valid status line. It never starts a vendor CLI. The parent
 * (this process) is started by run-proofs.sh with EVERY variable the helper must not inherit
 * already set — the three Anthropic credentials, CLAUDE_CONFIG_DIR and all thirteen
 * session-identity variables — plus the ones another vendor's CLI needs and must keep.
 *
 *   env -i HOME=<scratch home> PATH=$PATH TMPDIR=$TMPDIR <those variables> \
 *     node prove-helper-env.js <usage bundle> <repo root> [--expect-leak]
 *
 * --expect-leak runs the same probe against a bundle built from the tree BEFORE the fix and
 * passes only if the leak is there: it shows the probe can see the defect.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
const BUNDLE = path.resolve(process.argv[2]);
const REPO = path.resolve(process.argv[3]);
const EXPECT_LEAK = process.argv.includes('--expect-leak');

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + String(detail).slice(0, 600) + ']' : ''}`);
};

const ANTHROPIC = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CONFIG_DIR'];
// Written out here on purpose, then compared with the list in src/platform.ts: a variable added
// to the product's list and not to this probe (or the reverse) is a failure, not a silent pass.
const IDENTITY = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT',
];
const KEPT = ['PATH', 'HOME', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'GEMINI_API_KEY', 'UNRELATED_SETTING'];
const SCOPED_EXTRA = ['CLAUDE_CODE_USE_BEDROCK']; // K-SHELL: Anthropic-scoped by prefix, so removed too

const platformSrc = fs.readFileSync(path.join(REPO, 'src', 'platform.ts'), 'utf8');
const listIn = (name) => {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(platformSrc);
  return m ? [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]) : [];
};
check('P0 this probe\'s variable lists are the ones in src/platform.ts (SESSION_IDENTITY_ENV, ANTHROPIC_CREDENTIAL_ENV)',
  JSON.stringify(listIn('SESSION_IDENTITY_ENV').sort()) === JSON.stringify([...IDENTITY].sort()) && JSON.stringify(listIn('ANTHROPIC_CREDENTIAL_ENV').sort()) === JSON.stringify([...ANTHROPIC].sort()),
  `identity ${listIn('SESSION_IDENTITY_ENV').length}, credentials ${listIn('ANTHROPIC_CREDENTIAL_ENV').length}`);

const missingInParent = [...ANTHROPIC, ...IDENTITY, ...KEPT].filter((k) => typeof process.env[k] !== 'string' || process.env[k] === '');
check('P1 the PARENT holds every one of them before the fork (4 Anthropic + 13 session-identity + the ones to keep)', missingInParent.length === 0, missingInParent.join(',') || `${ANTHROPIC.length + IDENTITY.length + KEPT.length} set`);

// ---- sandbox: registry with one worker per non-Claude provider, and the fake helper
const ROOT = path.join(HOME, '.claude-code-orchestrator');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const DUMPS = path.join(HOME, 'helper-env-dumps');
fs.rmSync(DUMPS, { recursive: true, force: true });
fs.mkdirSync(DUMPS, { recursive: true });
const D = (n) => path.join(HOME, n);
const workers = [
  { name: 'claude-a', configDir: D('.claude-a'), model: 'opus' },
  { name: 'codex-own', configDir: D('.codex-own'), provider: 'codex', model: 'gpt-5.5' },
  { name: 'codex-ambient', configDir: D('.codex'), provider: 'codex' },
  { name: 'cursor-a', configDir: D('.cursor'), provider: 'cursor' },
  { name: 'agy-own', configDir: D('.agy-own'), provider: 'gemini' },
];
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers, permissionMode: 'acceptEdits', claudePath: 'claude' }));
const HELPER = path.join(HOME, 'fake-provider-cli.js');
fs.writeFileSync(
  HELPER,
  `// stand-in for provider-cli.js: dumps its environment, prints one status line, starts nothing\n` +
    `const fs = require('fs'); const path = require('path');\n` +
    `const [command, provider, configDir, ...rest] = process.argv.slice(2);\n` +
    `fs.writeFileSync(path.join(${JSON.stringify(DUMPS)}, provider + '-' + path.basename(configDir) + '.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), execArgv: process.execArgv }));\n` +
    `process.stdout.write(JSON.stringify({ cliFound: true, loggedIn: true, mode: 'fake', quota: null, error: null }) + '\\n', () => process.exit(0));\n`,
);

const usage = require(BUNDLE);
if (!usage.USAGE_CACHE_FILE.startsWith(HOME)) {
  console.error('refusing to run: cache file outside the scratch home');
  process.exit(2);
}

(async () => {
  const parentBefore = { ...process.env };
  const outcome = await usage.refreshProviderUsage({ helperPath: HELPER, polling: true, force: true }).then(() => 'resolved', (e) => 'rejected: ' + e);
  const files = fs.readdirSync(DUMPS).sort();
  const dumps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DUMPS, f), 'utf8')));
  check('P2 one helper ran per non-Claude worker (4), none for the Claude worker, and the refresh resolved', outcome === 'resolved' && dumps.length === 4
    && JSON.stringify(dumps.map((d) => d.argv.slice(0, 2).join(' ')).sort()) === JSON.stringify(['status codex', 'status codex', 'status cursor', 'status gemini']), `${outcome}; ${files.join(', ')}`);

  const leaks = dumps.map((d) => ({ who: d.argv.slice(1, 3).join(' '), anthropic: ANTHROPIC.filter((k) => k in d.env), identity: IDENTITY.filter((k) => k in d.env) }));
  if (EXPECT_LEAK) {
    check('P3 [tree BEFORE the fix] every helper INHERITED the four Anthropic variables — the defect, seen by this probe', leaks.every((l) => l.anthropic.length === ANTHROPIC.length && l.identity.length === 0), JSON.stringify(leaks[0]));
  } else {
    check('P3 no helper has ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CONFIG_DIR', leaks.every((l) => l.anthropic.length === 0), JSON.stringify(leaks.map((l) => l.anthropic)));
    check('P4 no helper has any of the 13 session-identity variables', leaks.every((l) => l.identity.length === 0), JSON.stringify(leaks.map((l) => l.identity)));
    // value-level: no VALUE of a removed variable survives under another name either
    const secretValues = [...ANTHROPIC, 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ID'].map((k) => parentBefore[k]);
    const smuggled = dumps.flatMap((d) => Object.entries(d.env).filter(([, v]) => secretValues.includes(v)).map(([k]) => k));
    check('P5 no VALUE of a removed variable appears in a helper\'s environment under any other name', smuggled.length === 0, smuggled.join(','));
    // and nothing of them on the command line
    check('P6 nor on its command line (argv is exactly: status <provider> <configDir> --quota)', dumps.every((d) => d.argv.length === 4 && d.argv[0] === 'status' && d.argv[3] === '--quota' && !d.argv.some((a) => secretValues.includes(a))), JSON.stringify(dumps[0].argv));
  }
  const keptWrong = dumps.flatMap((d) => KEPT.filter((k) => d.env[k] !== parentBefore[k]).map((k) => `${d.argv[1]}:${k}`));
  check('P7 every helper still has PATH, HOME, OPENAI_API_KEY, CURSOR_API_KEY, GEMINI_API_KEY, the proxy variables, a CLAUDE_CODE_* user setting and an unrelated variable — values unchanged', keptWrong.length === 0, keptWrong.join(',') || KEPT.join(','));
  if (!EXPECT_LEAK) {
    // the removed set is EXACTLY the two lists: nothing else of the parent's environment is missing
    const removed = [...new Set(dumps.flatMap((d) => Object.keys(parentBefore).filter((k) => !(k in d.env))))].sort();
    check('P8 what is missing from the helper\'s environment is exactly those 17 variables — nothing else was dropped', JSON.stringify(removed) === JSON.stringify([...new Set([...ANTHROPIC, ...IDENTITY, ...SCOPED_EXTRA, ...Object.keys(parentBefore).filter((k) => /^(ANTHROPIC_|CLAUDE_)/.test(k) || k === 'CLAUDECODE')])].sort()), removed.join(','));
    const added = [...new Set(dumps.flatMap((d) => Object.keys(d.env).filter((k) => !(k in parentBefore))))].sort();
    check('P9 what the helper has and the parent did not is only what Node\'s fork adds (the IPC channel variables)', added.every((k) => /^NODE_CHANNEL_/.test(k) || k === 'ELECTRON_RUN_AS_NODE'), added.join(',') || 'nothing');
  }
  const mutated = Object.keys(parentBefore).filter((k) => process.env[k] !== parentBefore[k]);
  check('P10 the parent\'s own environment was not modified by building the child\'s', mutated.length === 0 && Object.keys(process.env).length === Object.keys(parentBefore).length, mutated.join(','));
  check('P11 forked with execArgv emptied and a neutral cwd (unchanged behaviour)', dumps.every((d) => d.execArgv.length === 0 && fs.realpathSync(d.cwd) === fs.realpathSync(os.tmpdir())));

  console.log(`\nhelper-env${EXPECT_LEAK ? ' (before the fix)' : ''}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  probe crashed: ' + (e && e.stack));
  process.exit(1);
});
