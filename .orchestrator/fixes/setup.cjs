// SETUP (2.0 wave 11, contract-2.0-fixes.md §15.7 and §15.8): the editor-free logic of
// "Update Workspace Setup" and the `cco` launcher — where the local settings file lives, what a
// settings file / `.mcp.json` gains or loses, the item states and what starts checked, the order
// the items run in and when item 4 may run, "this folder can dispatch", and the launcher's text,
// RUN with /bin/sh against fake node binaries.
//
//   node .orchestrator/fixes/setup.cjs [--keep] [--only ROOT,GIT,RULES,MCP,PLAN,STATES,NAGS,LAUNCH]
//
// What it loads: src/workspaceSetup.ts, src/prompts.ts, src/teamAgent.ts and
// src/mcp/host-protocol.ts, each bundled with esbuild (platform node, format cjs, nothing
// external — a `vscode` import fails the BUILD group) into a scratch directory under the system
// temp directory (never out/), then required and called directly.
//
// Isolation: before anything runs, HOME / USERPROFILE / XDG_CONFIG_HOME point at a fresh
// directory inside the scratch directory, every GIT_* variable of the caller is dropped, and git
// is configured by environment only (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL = an empty file in
// that home, author / committer set, GIT_CEILING_DIRECTORIES = the scratch directory so that
// "not a repository" cannot be answered by a repository above it). Every repository, worktree,
// submodule and file is made inside the scratch directory; nothing in this repository and
// nothing in the real home directory is written. The launcher checks run /bin/sh with an
// environment of PATH + HOME only, PATH pointing at directories this file fills with fakes.
//
// Output: `PASS <GROUP>: <check>` / `FAIL <GROUP>: <check> — expected …; observed …` /
// `SKIP …` / `INFO …` (not counted), per-group counts and a tally line. Exit 0 only when every
// check passed. `--keep` keeps the scratch directory (its path is the `SCRATCH` line).
//
// A check whose name starts with `[contract …]` asserts a contract sentence the code may not
// meet; its FAIL line quotes the clause. Takes about 10 s (one git question is made to time out
// at GIT_TIMEOUT_MS = 5 s on purpose).
'use strict';
// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
require('./keychain-guard.cjs').harness('fix-setup', { selfCheck: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const GROUPS = ['BUILD', 'ROOT', 'GIT', 'RULES', 'MCP', 'PLAN', 'STATES', 'NAGS', 'LAUNCH'];
let ONLY;
{
  const at = argv.indexOf('--only');
  if (at !== -1) {
    ONLY = String(argv[at + 1] ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const unknown = ONLY.filter((g) => !GROUPS.includes(g));
    if (ONLY.length === 0 || unknown.length > 0) {
      console.error(`setup: --only takes a comma-separated list of ${GROUPS.slice(1).join(', ')}; got ${JSON.stringify(argv[at + 1])}`);
      process.exit(2);
    }
  }
  const stray = argv.filter((a, i) => a !== '--keep' && a !== '--only' && !(i > 0 && argv[i - 1] === '--only'));
  if (stray.length > 0) {
    console.error(`setup: unknown argument(s) ${JSON.stringify(stray)}. Usage: node .orchestrator/fixes/setup.cjs [--keep] [--only GROUP,...]`);
    process.exit(2);
  }
}
if (process.platform === 'win32') {
  console.log('setup: this suite needs /bin/sh and a POSIX file system; it does not run on Windows.');
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * Scratch directory and the environment every git call sees
 * ------------------------------------------------------------------------- */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-setup-')));
console.log(`SCRATCH ${SCRATCH}`);
const HOME_DIR = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME_DIR);
const GIT_GLOBAL = path.join(HOME_DIR, '.gitconfig');
fs.writeFileSync(GIT_GLOBAL, '');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: HOME_DIR,
  USERPROFILE: HOME_DIR,
  XDG_CONFIG_HOME: path.join(HOME_DIR, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GIT_GLOBAL,
  GIT_AUTHOR_NAME: 'setup suite',
  GIT_AUTHOR_EMAIL: 'setup@example.invalid',
  GIT_COMMITTER_NAME: 'setup suite',
  GIT_COMMITTER_EMAIL: 'setup@example.invalid',
  GIT_CEILING_DIRECTORIES: SCRATCH,
  GIT_TERMINAL_PROMPT: '0',
});

const restoreModes = [];
let cleaned = false;
function cleanup() {
  if (cleaned) {
    return;
  }
  cleaned = true;
  for (const dir of restoreModes) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
  if (KEEP) {
    console.log(`setup: scratch directory kept at ${SCRATCH}`);
    return;
  }
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on('exit', cleanup);

/* ------------------------------------------------------------------------- *
 * Checks and the tally
 * ------------------------------------------------------------------------- */

const tally = new Map();
let current = 'BUILD';
function count(kind) {
  const t = tally.get(current) ?? { pass: 0, fail: 0, skip: 0 };
  t[kind]++;
  tally.set(current, t);
}
function show(v) {
  let text;
  try {
    text =
      v === undefined
        ? 'undefined'
        : JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x === undefined ? '<undefined>' : x instanceof Error ? `Error(${x.message})` : x));
  } catch {
    text = String(v);
  }
  if (text === undefined) {
    text = String(v);
  }
  return text.length > 900 ? `${text.slice(0, 900)}…(${text.length} chars)` : text;
}
function diffNote(expected, observed) {
  if (typeof expected !== 'string' || typeof observed !== 'string') {
    return '';
  }
  let i = 0;
  while (i < expected.length && i < observed.length && expected[i] === observed[i]) {
    i++;
  }
  return ` [first difference at character ${i}: expected ${JSON.stringify(expected.slice(i, i + 50))}, observed ${JSON.stringify(observed.slice(i, i + 50))}]`;
}
function pass(name) {
  count('pass');
  console.log(`PASS ${current}: ${name}`);
}
function fail(name, why) {
  count('fail');
  console.log(`FAIL ${current}: ${name} — ${why}`);
}
function check(name, ok, why) {
  if (ok) {
    pass(name);
  } else {
    fail(name, typeof why === 'function' ? why() : why);
  }
  return ok;
}
function eq(name, observed, expected) {
  return check(name, util.isDeepStrictEqual(observed, expected), () => `expected ${show(expected)}; observed ${show(observed)}${diffNote(expected, observed)}`);
}
function skip(name, why) {
  count('skip');
  console.log(`SKIP ${current}: ${name} — ${why}`);
}
function info(text) {
  console.log(`INFO ${current}: ${text}`);
}
async function group(name, fn) {
  if (name !== 'BUILD' && ONLY !== undefined && !ONLY.includes(name)) {
    return;
  }
  current = name;
  tally.set(name, tally.get(name) ?? { pass: 0, fail: 0, skip: 0 });
  try {
    await fn();
  } catch (err) {
    fail('the group ran to its end', `it threw: ${String((err && err.stack) || err).split('\n').slice(0, 5).join(' | ')}`);
  }
}

/** One POSIX shell word that sh takes literally — the test's own copy of the rule, not the unit's. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Run git for the test's own set-up, in the isolated environment. Throws with git's stderr. */
function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env, timeout: 30_000 });
  } catch (err) {
    throw new Error(`set-up: git ${args.join(' ')} in ${cwd} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

/** An executable file with `text`, mode 0755 whatever the umask says. */
function writeExecutable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
  return file;
}

/** process.env.PATH = dir while fn runs (runGit looks git up on the PATH of process.env). */
async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

/* ------------------------------------------------------------------------- *
 * BUILD — the modules under test, bundled into the scratch directory
 * ------------------------------------------------------------------------- */

let WS; // src/workspaceSetup.ts
let PR; // src/prompts.ts
let TA; // src/teamAgent.ts
let HP; // src/mcp/host-protocol.ts

function bundle(entry, outName) {
  const esbuild = require('esbuild');
  const outfile = path.join(SCRATCH, 'bundle', outName);
  esbuild.buildSync({
    entryPoints: [path.join(REPO, entry)],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  return require(outfile);
}

function tryBundle(entry, outName) {
  try {
    const mod = bundle(entry, outName);
    pass(`${entry} bundles for Node with nothing external (no vscode) and loads`);
    return mod;
  } catch (err) {
    const detail = Array.isArray(err.errors) && err.errors.length > 0 ? err.errors.map((e) => e.text).join(' | ') : String(err.message || err);
    fail(`${entry} bundles for Node with nothing external (no vscode) and loads`, detail.slice(0, 600));
    return undefined;
  }
}

function groupBuild() {
  const src = fs.readFileSync(path.join(REPO, 'src', 'workspaceSetup.ts'), 'utf8');
  check(
    'src/workspaceSetup.ts does not import vscode (§15.7: the decisions run without an editor)',
    !/from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)|import\(\s*['"]vscode['"]\s*\)/.test(src),
    'an import of vscode was found in the source',
  );
  WS = tryBundle('src/workspaceSetup.ts', 'workspaceSetup.cjs');
  PR = tryBundle('src/prompts.ts', 'prompts.cjs');
  TA = tryBundle('src/teamAgent.ts', 'teamAgent.cjs');
  HP = tryBundle('src/mcp/host-protocol.ts', 'host-protocol.cjs');
  if (WS !== undefined) {
    const wanted = {
      function: [
        'launcherPathOf', 'cliPathOf', 'launcherPresent', 'shSingleQuoted', 'launcherScript', 'canDispatchFrom', 'offeredSetupItems',
        'checkedByDefault', 'mcpRemovalAllowed', 'runSetupPlan', 'parseJsonObject', 'ccoRules', 'missingCcoRules', 'allowItemStateOf',
        'withCcoRules', 'mcpItemStateOf', 'withoutMcpServers', 'withoutEnabledMcpServers', 'decideSettingsRoot', 'hostRootProbe',
        'runGit', 'lookUpSettingsRoot', 'isTrackedInGit',
      ],
    };
    const missing = wanted.function.filter((name) => typeof WS[name] !== 'function');
    eq('workspaceSetup exports every function this suite calls', missing, []);
    eq(
      'workspaceSetup constants',
      {
        MCP_SERVER_NAME: WS.MCP_SERVER_NAME,
        LEGACY_MCP_SERVER_NAME: WS.LEGACY_MCP_SERVER_NAME,
        DISPATCH_SERVER_NAMES: WS.DISPATCH_SERVER_NAMES,
        LOCAL_SETTINGS_FILE: WS.LOCAL_SETTINGS_FILE,
        GIT_TIMEOUT_MS: WS.GIT_TIMEOUT_MS,
        CCO_RULE_COUNT: WS.CCO_RULE_COUNT,
        SETUP_ORDER: Array.isArray(WS.SETUP_ORDER) ? [...WS.SETUP_ORDER] : WS.SETUP_ORDER,
      },
      {
        MCP_SERVER_NAME: 'cco-dispatch',
        LEGACY_MCP_SERVER_NAME: 'fable-dispatch',
        DISPATCH_SERVER_NAMES: ['cco-dispatch', 'fable-dispatch'],
        LOCAL_SETTINGS_FILE: '.claude/settings.local.json',
        GIT_TIMEOUT_MS: 5000,
        CCO_RULE_COUNT: 5,
        SETUP_ORDER: ['policy', 'teamAgent', 'allowCco', 'removeMcp'],
      },
    );
  }
  if (HP !== undefined) {
    eq('host-protocol COMMAND_SPELLING / TASK_FILE_DIR', [HP.COMMAND_SPELLING, HP.TASK_FILE_DIR], ['~/.claude-code-orchestrator/bin/cco', '.cco']);
  }
}

/* ------------------------------------------------------------------------- *
 * ROOT — decideSettingsRoot fed fake probe answers (§15.7 item 3, F7)
 * ------------------------------------------------------------------------- */

function groupRoot() {
  const ME = 501;
  const P = (over = {}) => ({ home: '/home/u', uid: ME, ownerOf: () => ME, exists: () => false, realpath: (p) => p, ...over });
  const d = (folder, toplevel, commonDir, over) => WS.decideSettingsRoot(folder, { toplevel, commonDir }, P(over));
  const at = (root, why) => ({ root, why, inGit: true });

  eq('not a repository (git gave no top-level) → the folder itself, inGit false', d('/w/f', undefined, undefined), { root: '/w/f', why: 'not-git', inGit: false });
  eq('no top-level but a common dir → still the folder itself', d('/w/f', undefined, '/w/.git'), { root: '/w/f', why: 'not-git', inGit: false });
  eq('a repository opened at its top-level → the top-level', d('/r', '/r', '/r/.git'), at('/r', 'repository'));
  eq('a subdirectory of the repository → the top-level ABOVE it', d('/r/a/b', '/r', '/r/.git'), at('/r', 'repository'));
  eq('a linked worktree → the main checkout (the common dir without its trailing /.git)', d('/wt/x', '/wt', '/main/.git'), at('/main', 'main-checkout'));
  eq('a linked worktree, common dir written with a trailing slash → still the main checkout', d('/wt', '/wt', '/main/.git/'), at('/main', 'main-checkout'));
  eq('a submodule (common dir <super>/.git/modules/<name>) → its own top-level', d('/super/sub', '/super/sub', '/super/.git/modules/sub'), at('/super/sub', 'repository'));
  eq("a bare repository's worktree (common dir repo.git) → the worktree's top-level", d('/bwt', '/bwt', '/bare.git'), at('/bwt', 'repository'));
  eq(
    "a worktree of a bare repository that is named .git → its parent, as the rule reads (common dir without /.git)",
    d('/proj/wt', '/proj/wt', '/proj/.git'),
    at('/proj', 'main-checkout'),
  );
  // Contract §15.7 item 3 as amended 2026-10-15: a top-level without a common-dir answer is not trusted.
  eq('no common-dir answer → the folder itself, inGit false', d('/r/a', '/r', undefined), { root: '/r/a', why: 'not-git', inGit: false });
  eq(
    'top-level and main checkout are one directory through a symbolic link → the top-level as git named it (not main-checkout)',
    d('/link/r', '/link/r', '/real/r/.git', { realpath: (p) => (p === '/link/r' ? '/real/r' : p) }),
    at('/link/r', 'repository'),
  );
  eq('the top-level is the home directory → the folder itself', d('/home/u/proj', '/home/u', '/home/u/.git'), at('/home/u/proj', 'home'));
  eq(
    'the top-level reaches the home directory through a link → the folder itself',
    d('/hl/p', '/hl', '/hl/.git', { realpath: (p) => (p === '/hl' ? '/home/u' : p) }),
    at('/hl/p', 'home'),
  );
  eq('a linked worktree whose main checkout is the home directory → the folder itself', d('/wt', '/wt', '/home/u/.git'), at('/wt', 'home'));
  eq('a repository BELOW the home directory → its top-level (only the home directory itself is excluded)', d('/home/u/p/a', '/home/u/p', '/home/u/p/.git'), at('/home/u/p', 'repository'));

  const notMine = (bad) => ({ ownerOf: (p) => (p === bad ? 0 : ME), exists: () => true });
  eq('the root is not owned by the user → the folder itself', d('/r/a', '/r', '/r/.git', notMine('/r')), at('/r/a', 'not-owned'));
  eq("the root's .git is not owned by the user → the folder itself", d('/r/a', '/r', '/r/.git', notMine('/r/.git')), at('/r/a', 'not-owned'));
  eq("the root's .claude is not owned by the user → the folder itself", d('/r/a', '/r', '/r/.git', notMine('/r/.claude')), at('/r/a', 'not-owned'));
  eq(
    'no .claude at the root (an owner that would not match is never asked about) → the top-level',
    d('/r/a', '/r', '/r/.git', { ownerOf: (p) => (p === '/r/.claude' ? 0 : ME), exists: (p) => p !== '/r/.claude' }),
    at('/r', 'repository'),
  );
  eq('the root cannot be stat\'ed (no owner) → the folder itself', d('/r/a', '/r', '/r/.git', { ownerOf: (p) => (p === '/r' ? undefined : ME) }), at('/r/a', 'not-owned'));
  eq('no user id on this platform → nothing is "owned by the user" → the folder itself', d('/r/a', '/r', '/r/.git', { uid: undefined }), at('/r/a', 'not-owned'));
  eq('a linked worktree: ownership is asked of the MAIN checkout (main not owned → the folder)', d('/wt', '/wt', '/main/.git', notMine('/main')), at('/wt', 'not-owned'));
  eq("a linked worktree: main checkout owned, the worktree's own directory not → still the main checkout", d('/wt', '/wt', '/main/.git', notMine('/wt')), at('/main', 'main-checkout'));
  eq("a linked worktree: the main checkout's .git not owned → the folder", d('/wt', '/wt', '/main/.git', notMine('/main/.git')), at('/wt', 'not-owned'));

  const asked = [];
  WS.decideSettingsRoot('/r/a', { toplevel: '/r', commonDir: '/r/.git' }, P({ ownerOf: (p) => { asked.push(p); return ME; }, exists: () => true }));
  check(
    'ownership is asked of the root, its .git and its .claude',
    ['/r', '/r/.git', '/r/.claude'].every((p) => asked.includes(p)),
    () => `expected the owner of /r, /r/.git and /r/.claude to be asked; asked ${show(asked)}`,
  );
}

/* ------------------------------------------------------------------------- *
 * GIT — lookUpSettingsRoot / isTrackedInGit / runGit / hostRootProbe against real git
 * repositories in the scratch directory, and fake gits on PATH
 * ------------------------------------------------------------------------- */

async function groupGit() {
  const G = path.join(SCRATCH, 'git');
  fs.mkdirSync(G);
  const uid = process.getuid();

  // --- set-up -------------------------------------------------------------
  const plain = path.join(G, 'plain');
  git(G, 'init', '-q', '-b', 'main', 'plain');
  fs.writeFileSync(path.join(plain, 'f.txt'), 'x\n');
  git(plain, 'add', 'f.txt');
  git(plain, 'commit', '-q', '-m', 'init');
  const plainSub = path.join(plain, 'a', 'b');
  fs.mkdirSync(plainSub, { recursive: true });
  const wt = path.join(G, 'wt');
  git(plain, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const wtSub = path.join(wt, 'x');
  fs.mkdirSync(wtSub);
  const sup = path.join(G, 'super');
  git(G, 'init', '-q', '-b', 'main', 'super');
  git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', plain, 'sub');
  const subm = path.join(sup, 'sub');
  git(G, 'clone', '-q', '--bare', plain, 'bare.git');
  const bwt = path.join(G, 'bwt');
  git(path.join(G, 'bare.git'), 'worktree', 'add', '-q', '--detach', bwt, 'main');
  const proj = path.join(G, 'proj');
  fs.mkdirSync(proj);
  git(proj, 'clone', '-q', '--bare', plain, '.git');
  const projWt = path.join(proj, 'wt');
  git(path.join(proj, '.git'), 'worktree', 'add', '-q', '--detach', projWt, 'main');
  const norepo = path.join(G, 'norepo');
  fs.mkdirSync(norepo);
  const trail = path.join(G, 'trail ');
  git(G, 'init', '-q', 'trail ');
  const homerepo = path.join(G, 'homerepo');
  git(G, 'init', '-q', '-b', 'main', 'homerepo');
  fs.writeFileSync(path.join(homerepo, 'h.txt'), 'h\n');
  git(homerepo, 'add', 'h.txt');
  git(homerepo, 'commit', '-q', '-m', 'h');
  fs.mkdirSync(path.join(homerepo, 'proj'));
  const hwt = path.join(G, 'hwt');
  git(homerepo, 'worktree', 'add', '-q', '--detach', hwt, 'main');
  const homeLink = path.join(G, 'home-link');
  fs.symlinkSync(homerepo, homeLink);
  const other = path.join(G, 'other');
  git(G, 'init', '-q', '-b', 'main', 'other');
  fs.writeFileSync(path.join(other, 'only-in-other.txt'), 'o\n');
  git(other, 'add', 'only-in-other.txt');
  git(other, 'commit', '-q', '-m', 'o');
  const emptyBin = path.join(G, 'empty-bin');
  fs.mkdirSync(emptyBin);

  const probe = WS.hostRootProbe();
  const look = (folder, pr = probe) => WS.lookUpSettingsRoot(folder, pr);
  const at = (root, why) => ({ root, why, inGit: true });

  // --- hostRootProbe ------------------------------------------------------
  eq('hostRootProbe: home = realpath(os.homedir()) (the test home)', probe.home, HOME_DIR);
  eq('hostRootProbe: uid = process.getuid()', probe.uid, uid);
  eq('hostRootProbe: ownerOf(a directory of ours) = our uid; of nothing = undefined', [probe.ownerOf(G), probe.ownerOf(path.join(G, 'missing'))], [uid, undefined]);
  const dangling = path.join(G, 'dangling');
  fs.symlinkSync(path.join(G, 'nowhere'), dangling);
  eq('hostRootProbe: exists(nothing) false; exists(a dangling link) true (lstat)', [probe.exists(path.join(G, 'missing')), probe.exists(dangling)], [false, true]);
  if (uid === 0) {
    skip('hostRootProbe: a failure other than ENOENT counts as "exists"', 'running as root: a mode-000 directory does not refuse root');
  } else {
    const locked = path.join(G, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    restoreModes.push(locked);
    eq('hostRootProbe: a failure other than ENOENT (EACCES) counts as "exists"', probe.exists(path.join(locked, 'x')), true);
    fs.chmodSync(locked, 0o700);
  }
  eq('hostRootProbe: realpath(link) = its target; realpath(nothing) = undefined', [probe.realpath(homeLink), probe.realpath(path.join(G, 'missing'))], [homerepo, undefined]);

  // --- real repositories --------------------------------------------------
  eq('plain repository → its top-level', await look(plain), at(plain, 'repository'));
  eq('a subdirectory of a repository → the top-level above it', await look(plainSub), at(plain, 'repository'));
  eq('a linked worktree → the main checkout', await look(wt), at(plain, 'main-checkout'));
  eq('a subdirectory of a linked worktree → the main checkout', await look(wtSub), at(plain, 'main-checkout'));
  eq('a submodule → its own top-level (its common dir is .git/modules/sub)', await look(subm), at(subm, 'repository'));
  eq('the superproject of that submodule → its top-level', await look(sup), at(sup, 'repository'));
  eq("a bare repository's linked worktree (bare.git) → the worktree's top-level", await look(bwt), at(bwt, 'repository'));
  eq('a worktree of a bare repository named proj/.git → proj (the rule: common dir without /.git)', await look(projWt), at(proj, 'main-checkout'));
  eq('not a repository → the folder itself', await look(norepo), { root: norepo, why: 'not-git', inGit: false });
  eq('the .git directory itself (git: "must be run in a work tree") → the folder itself', await look(path.join(plain, '.git')), {
    root: path.join(plain, '.git'),
    why: 'not-git',
    inGit: false,
  });
  eq('a folder that does not exist → the folder itself (git cannot run there)', await look(path.join(G, 'gone')), {
    root: path.join(G, 'gone'),
    why: 'not-git',
    inGit: false,
  });
  eq('a repository whose path ends in a space → that path, the space kept', await look(trail), at(trail, 'repository'));

  // --- the home directory -------------------------------------------------
  const savedHome = process.env.HOME;
  let homeProbe;
  process.env.HOME = homeLink;
  try {
    homeProbe = WS.hostRootProbe();
  } finally {
    process.env.HOME = savedHome;
  }
  eq('HOME given as a symbolic link → the probe compares its realpath', homeProbe.home, homerepo);
  eq('a repository whose top-level is HOME, folder below it → the folder itself', await look(path.join(homerepo, 'proj'), homeProbe), at(path.join(homerepo, 'proj'), 'home'));
  eq('the HOME repository opened at HOME → the folder (HOME) itself', await look(homerepo, homeProbe), at(homerepo, 'home'));
  eq('a linked worktree whose main checkout is HOME → the folder itself', await look(hwt, homeProbe), at(hwt, 'home'));

  // --- ownership (fake owner answers over real git facts) -----------------
  fs.mkdirSync(path.join(plain, '.claude'));
  const ownerNot = (bad) => ({ ...probe, ownerOf: (p) => (p === bad ? uid + 1 : probe.ownerOf(p)) });
  eq('real repo, .claude present and ours → the top-level', await look(plainSub), at(plain, 'repository'));
  eq('real repo, the root not owned → the folder itself', await look(plainSub, ownerNot(plain)), at(plainSub, 'not-owned'));
  eq("real repo, the root's .git not owned → the folder itself", await look(plainSub, ownerNot(path.join(plain, '.git'))), at(plainSub, 'not-owned'));
  eq("real repo, the root's .claude not owned → the folder itself", await look(plainSub, ownerNot(path.join(plain, '.claude'))), at(plainSub, 'not-owned'));
  eq("linked worktree, the main checkout's .claude not owned → the folder itself", await look(wt, ownerNot(path.join(plain, '.claude'))), at(wt, 'not-owned'));

  // --- the caller's git environment does not leak in ----------------------
  const leak = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, '.git', 'index'), GIT_COMMON_DIR: path.join(other, '.git') };
  Object.assign(process.env, leak);
  try {
    eq('GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE of another repository in the environment are ignored', await look(plainSub), at(plain, 'repository'));
    eq('… and isTrackedInGit asks about the folder, not GIT_DIR (a file tracked only in the other repository → false)', await WS.isTrackedInGit(plain, 'only-in-other.txt'), false);
  } finally {
    for (const key of Object.keys(leak)) {
      delete process.env[key];
    }
  }

  // --- isTrackedInGit ------------------------------------------------------
  const settings = path.join(plain, '.claude', 'settings.local.json');
  fs.writeFileSync(settings, '{}\n');
  eq('isTrackedInGit: an untracked local settings file → false', await WS.isTrackedInGit(plain), false);
  git(plain, 'add', '.claude/settings.local.json');
  eq('isTrackedInGit: the file once git tracks it (default path = .claude/settings.local.json) → true', await WS.isTrackedInGit(plain), true);
  eq('isTrackedInGit: a tracked file named explicitly → true', await WS.isTrackedInGit(plain, 'f.txt'), true);
  eq('isTrackedInGit: not a repository → undefined (nothing is said)', await WS.isTrackedInGit(norepo), undefined);
  eq('isTrackedInGit: a path that looks like an option ("--version") is a path, not an option → false', await WS.isTrackedInGit(plain, '--version'), false);

  const fsm = path.join(G, 'fsm');
  git(G, 'init', '-q', '-b', 'main', 'fsm');
  fs.writeFileSync(path.join(fsm, 'f.txt'), 'f\n');
  git(fsm, 'add', 'f.txt');
  git(fsm, 'commit', '-q', '-m', 'f');
  const hook = writeExecutable(path.join(G, 'fsm-hook.sh'), `#!/bin/sh\ntouch ${q(G)}/fsm-fired-$$\nexit 1\n`);
  git(fsm, 'config', 'core.fsmonitor', hook);
  const fired = () => fs.readdirSync(G).filter((n) => n.startsWith('fsm-fired-'));
  const clearFired = () => fired().forEach((n) => fs.rmSync(path.join(G, n)));
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', 'f.txt'], { cwd: fsm, stdio: 'ignore', env: process.env });
  } catch {
    /* only whether the hook ran matters */
  }
  const controlFired = fired().length > 0;
  clearFired();
  const trackedFsm = await WS.isTrackedInGit(fsm, 'f.txt');
  const rootFsm = await look(fsm);
  const firedNow = fired();
  check(
    "neither isTrackedInGit nor lookUpSettingsRoot runs the repository's core.fsmonitor command",
    firedNow.length === 0 && trackedFsm === true && util.isDeepStrictEqual(rootFsm, at(fsm, 'repository')),
    () => `hook ran ${firedNow.length} time(s); isTrackedInGit → ${show(trackedFsm)}; root → ${show(rootFsm)}`,
  );
  if (!controlFired) {
    info('control: a plain `git ls-files` did not run the fsmonitor hook on this git either, so the check above proves little here');
  }

  // --- runGit directly ----------------------------------------------------
  eq('runGit: one answer, stdout as git printed it', await WS.runGit(plain, ['rev-parse', '--show-toplevel']), { ok: true, stdout: `${plain}\n` });
  eq('runGit: git exits 128 → ok false with that exit code', await WS.runGit(norepo, ['rev-parse', '--show-toplevel']), { ok: false, exitCode: 128 });
  let rejected;
  const gone = await WS.runGit(path.join(G, 'gone'), ['status']).catch((err) => {
    rejected = err;
    return 'rejected';
  });
  eq('runGit: a cwd that does not exist → ok false (never rejects)', [gone, rejected], [{ ok: false, exitCode: undefined }, undefined]);
  eq('runGit: git missing from PATH → ok false, no exit code', await withPath(emptyBin, () => WS.runGit(plain, ['rev-parse', '--show-toplevel'])), { ok: false, exitCode: undefined });

  const fakeDir = (name, body) => {
    const dir = path.join(G, 'fake', name);
    writeExecutable(path.join(dir, 'git'), `#!/bin/sh\nPATH=/usr/bin:/bin\nexport PATH\n${body}\n`);
    return dir;
  };
  const logDir = path.join(G, 'fake-log');
  fs.mkdirSync(logDir);
  const logging = fakeDir(
    'logging',
    [
      'cat > /dev/null',
      `for a in "$@"; do printf '%s' "$a" | od -v -An -tx1 | tr -d ' \\n'; echo; done > ${q(path.join(logDir, 'args'))}`,
      `printf 'TP=%s\\nOL=%s\\nGD=%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_OPTIONAL_LOCKS" "\${GIT_DIR-UNSET}" > ${q(path.join(logDir, 'env'))}`,
      `printf '%s\\n' ${q(plain)}`,
    ].join('\n'),
  );
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_TERMINAL_PROMPT = '1';
  const started = Date.now();
  let logged;
  try {
    logged = await withPath(logging, () => WS.runGit(plain, ['rev-parse', '--show-toplevel'], 3000));
  } finally {
    delete process.env.GIT_DIR;
    process.env.GIT_TERMINAL_PROMPT = '0';
  }
  const loggedArgs = fs.existsSync(path.join(logDir, 'args'))
    ? fs.readFileSync(path.join(logDir, 'args'), 'utf8').split('\n').filter((l, i, all) => i < all.length - 1).map((hex) => Buffer.from(hex, 'hex').toString('utf8'))
    : 'no log';
  const loggedEnv = fs.existsSync(path.join(logDir, 'env')) ? fs.readFileSync(path.join(logDir, 'env'), 'utf8') : 'no log';
  eq('runGit: stdin is closed (a git that reads stdin to its end answers at once)', [logged, Date.now() - started < 2500], [{ ok: true, stdout: `${plain}\n` }, true]);
  eq('runGit: argv = -c core.fsmonitor=false, then the question', loggedArgs, ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']);
  eq('runGit: GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, GIT_DIR removed', loggedEnv, 'TP=0\nOL=0\nGD=UNSET\n');

  const hang = fakeDir('hang', 'exec sleep 30');
  const t0 = Date.now();
  const hung = await withPath(hang, () => WS.runGit(plain, ['rev-parse', '--show-toplevel'], 400));
  const hungMs = Date.now() - t0;
  eq('runGit: a git past its timeout is killed → ok false, no exit code, promptly', [hung, hungMs < 3000], [{ ok: false, exitCode: undefined }, true]);
  const huge = fakeDir('huge', 'yes aaaaaaaaaaaaaaa | head -c 200000');
  eq('runGit: more than 64 KiB of output is not an answer → ok false', await withPath(huge, () => WS.runGit(plain, ['rev-parse', '--show-toplevel'])), {
    ok: false,
    exitCode: undefined,
  });
  eq('isTrackedInGit: git exit 1 → false', await withPath(fakeDir('exit1', 'exit 1'), () => WS.isTrackedInGit(plain)), false);
  eq('isTrackedInGit: git exit 128 → undefined', await withPath(fakeDir('exit128', 'exit 128'), () => WS.isTrackedInGit(plain)), undefined);
  eq('isTrackedInGit: git exit 0 → true', await withPath(fakeDir('exit0', 'exit 0'), () => WS.isTrackedInGit(plain)), true);
  eq('isTrackedInGit: git missing → undefined', await withPath(emptyBin, () => WS.isTrackedInGit(plain)), undefined);

  // --- lookUpSettingsRoot with fake gits ----------------------------------
  const say = (...lines) => `printf '%s\\n' ${lines.map(q).join(' ')}`;
  const answering = ({ top, abs = 'exit 128', rel = 'exit 128' }) =>
    [
      'if [ "$1" = "-c" ]; then shift 2; fi',
      'case "$*" in',
      `  "rev-parse --show-toplevel") ${top} ;;`,
      `  "rev-parse --path-format=absolute --git-common-dir") ${abs} ;;`,
      `  "rev-parse --git-common-dir") ${rel} ;;`,
      '  *) echo "fake git: unexpected question: $*" >&2; exit 129 ;;',
      'esac',
    ].join('\n');
  eq('git missing → the folder itself (a real repository folder)', await withPath(emptyBin, () => look(plainSub)), { root: plainSub, why: 'not-git', inGit: false });
  eq('git fails (exit 128 on every question) → the folder itself', await withPath(fakeDir('fail', 'exit 128'), () => look(plainSub)), { root: plainSub, why: 'not-git', inGit: false });
  eq('git prints a RELATIVE top-level → not an answer → the folder itself', await withPath(fakeDir('relative', answering({ top: say('plain') })), () => look(plainSub)), {
    root: plainSub,
    why: 'not-git',
    inGit: false,
  });
  eq('git prints two lines for the top-level → not an answer → the folder itself', await withPath(fakeDir('twolines', answering({ top: say(plain, other) })), () => look(plainSub)), {
    root: plainSub,
    why: 'not-git',
    inGit: false,
  });
  eq('git prints nothing (exit 0) → not an answer → the folder itself', await withPath(fakeDir('silent', answering({ top: 'exit 0' })), () => look(plainSub)), {
    root: plainSub,
    why: 'not-git',
    inGit: false,
  });
  eq(
    'git answers with CRLF line ends → the line end is removed, the path kept',
    await withPath(fakeDir('crlf', answering({ top: `printf '%s\\r\\n' ${q(plain)}`, abs: `printf '%s\\r\\n' ${q(path.join(plain, '.git'))}` })), () => look(plainSub)),
    at(plain, 'repository'),
  );
  eq(
    'an older git (no --path-format: it echoes the flag) → asked again without it; the relative common dir resolved against the folder (subdirectory)',
    await withPath(fakeDir('old-sub', answering({ top: say(plain), abs: say('--path-format=absolute', '../../.git'), rel: say('../../.git') })), () => look(plainSub)),
    at(plain, 'repository'),
  );
  eq(
    'an older git in a linked worktree → the relative common dir resolved against the folder → the main checkout',
    await withPath(fakeDir('old-wt', answering({ top: say(wt), abs: say('--path-format=absolute', '../plain/.git'), rel: say('../plain/.git') })), () => look(wt)),
    at(plain, 'main-checkout'),
  );
  const partial = await withPath(fakeDir('common-fails', answering({ top: say(plain) })), () => look(plainSub));
  check(
    "[contract §15.7 item 3: 'but the folder itself when: … git missing or failing (5 s timeout)'] git answers the top-level, then FAILS both common-dir questions → the folder itself",
    partial.root === plainSub,
    () => `expected root ${show(plainSub)}; observed ${show(partial)} — lookUpSettingsRoot keeps the top-level when only the common-dir questions fail (commonDir undefined → decideSettingsRoot keeps facts.toplevel)`,
  );
  const tHang = Date.now();
  const timedOut = await withPath(hang, () => look(plainSub));
  const tookMs = Date.now() - tHang;
  eq(
    `a git that hangs → the folder itself after GIT_TIMEOUT_MS (took ${tookMs} ms)`,
    [timedOut, tookMs >= 4000 && tookMs < 9000],
    [{ root: plainSub, why: 'not-git', inGit: false }, true],
  );
}

/* ------------------------------------------------------------------------- *
 * RULES — the five rules and settings.local.json (§15.7 item 3)
 * ------------------------------------------------------------------------- */

function groupRules() {
  const H = '/home/u';
  const R = WS.ccoRules(H);
  const A1 = 'Bash(~/.claude-code-orchestrator/bin/cco *)';
  const A2 = `Bash(${H}/.claude-code-orchestrator/bin/cco *)`;
  const A3 = 'Edit(/.cco/**)';
  const E1 = '~/.claude-code-orchestrator/bin/cco *';
  const E2 = `${H}/.claude-code-orchestrator/bin/cco *`;
  eq('the five rules for home /home/u, exactly (§15.7 item 3)', { allow: [...R.allow], excludedCommands: [...R.excludedCommands] }, { allow: [A1, A2, A3], excludedCommands: [E1, E2] });
  if (HP !== undefined) {
    eq('the ~ rules spell the command exactly as COMMAND_SPELLING', [R.allow[0], R.excludedCommands[0]], [`Bash(${HP.COMMAND_SPELLING} *)`, `${HP.COMMAND_SPELLING} *`]);
  }
  eq('a home written with a trailing slash → the same rules', [...WS.ccoRules('/home/u/').allow], [A1, A2, A3]);
  const weird = "/Users/o'brien \"q\" smith";
  const RW = WS.ccoRules(weird);
  eq(
    'a home with a space, a single and a double quote → taken literally in the rules',
    { allow: [...RW.allow], excludedCommands: [...RW.excludedCommands] },
    {
      allow: [A1, `Bash(${weird}/.claude-code-orchestrator/bin/cco *)`, A3],
      excludedCommands: [E1, `${weird}/.claude-code-orchestrator/bin/cco *`],
    },
  );
  const weirdWrite = WS.withCcoRules(undefined, RW);
  const weirdBack = weirdWrite.kind === 'changed' ? JSON.parse(weirdWrite.text) : undefined;
  eq(
    '… written as JSON (the quote escaped) and read back unchanged',
    weirdBack === undefined ? weirdWrite : [weirdBack.permissions.allow, weirdBack.sandbox.excludedCommands, weirdWrite.text.includes('o\'brien \\"q\\" smith')],
    [[...RW.allow], [...RW.excludedCommands], true],
  );

  const EXPECT_NEW = [
    '{',
    '  "permissions": {',
    '    "allow": [',
    `      "${A1}",`,
    `      "${A2}",`,
    `      "${A3}"`,
    '    ]',
    '  },',
    '  "sandbox": {',
    '    "excludedCommands": [',
    `      "${E1}",`,
    `      "${E2}"`,
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n');
  eq('no file → all five added, 2-space indent, final newline', WS.withCcoRules(undefined, R), { kind: 'changed', text: EXPECT_NEW, count: 5 });
  eq('"{}" → the same text', WS.withCcoRules('{}', R), { kind: 'changed', text: EXPECT_NEW, count: 5 });
  const blanks = ['', ' ', '\n', '\t\r\n ', '﻿', '﻿ \n'];
  const blankWrong = blanks.filter((t) => !util.isDeepStrictEqual(WS.withCcoRules(t, R), { kind: 'changed', text: EXPECT_NEW, count: 5 }));
  eq('a blank file (empty, white space, a lone byte-order mark) → read as {} → the same text', blankWrong, []);
  eq('a byte-order mark before an object → the object kept, the mark not written back', WS.withCcoRules('﻿{"a": 1}', R), {
    kind: 'changed',
    text: `${JSON.stringify({ a: 1, permissions: { allow: [A1, A2, A3] }, sandbox: { excludedCommands: [E1, E2] } }, null, 2)}\n`,
    count: 5,
  });

  // Not JSON → refused, with nothing to write.
  const notJson = [
    '// my settings\n{}\n',
    '{\n  "permissions": { "allow": [] } // mine\n}\n',
    '/* c */ {}',
    '{"a": 1,}',
    '{"permissions": {"allow": ["Bash(ls)",]}}',
    '{"a": 1}\n<<<<<<< HEAD\n',
    "{'a': 1}",
    '﻿﻿{}',
    '{"a": 1} {"b": 2}',
    'undefined',
    'NaN',
    ' {}',
  ];
  const notJsonWrong = [];
  for (const text of notJson) {
    let validJson = true;
    try {
      JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      validJson = false;
    }
    const change = WS.withCcoRules(text, R);
    const state = WS.allowItemStateOf(text, R);
    if (validJson || change.kind !== 'refused' || change.problem?.code !== 'not-json' || 'text' in change || state !== 'unreadable') {
      notJsonWrong.push({ text, validJson, change, state });
    }
  }
  eq('comments, trailing commas, conflict markers, single quotes, two BOMs, two objects… → refused "not-json", no text, state unreadable', notJsonWrong, []);
  const filed = path.join(SCRATCH, 'rules', 'settings.local.json');
  fs.mkdirSync(path.dirname(filed), { recursive: true });
  const commented = '{\n  // keep me\n  "permissions": {"allow": ["Bash(npm test)"],},\n}\n';
  fs.writeFileSync(filed, commented);
  const beforeBytes = fs.readFileSync(filed);
  const commentedChange = WS.withCcoRules(fs.readFileSync(filed, 'utf8'), R);
  check(
    'a settings file with comments and a trailing comma → refused with no text to write; the file stays byte-identical',
    commentedChange.kind === 'refused' && !('text' in commentedChange) && fs.readFileSync(filed).equals(beforeBytes),
    () => `observed ${show(commentedChange)}`,
  );

  const notObject = ['[]', 'null', '"x"', '1', 'true', '[{"permissions": {}}]'];
  const notObjectWrong = notObject.filter((t) => !util.isDeepStrictEqual(WS.withCcoRules(t, R), { kind: 'refused', problem: { code: 'not-object' } }) || WS.allowItemStateOf(t, R) !== 'unreadable');
  eq('valid JSON that is not an object ([], null, a string, a number, true) → refused "not-object"', notObjectWrong, []);

  const refusedAt = (text) => {
    const c = WS.withCcoRules(text, R);
    return c.kind === 'refused' ? c.problem : c;
  };
  eq('"permissions": [] → refused (not an object at permissions)', refusedAt('{"permissions": []}'), { code: 'not-object-at', key: 'permissions' });
  eq('"permissions": null / "x" / 1 → refused', ['{"permissions": null}', '{"permissions": "x"}', '{"permissions": 1}'].map(refusedAt), [
    { code: 'not-object-at', key: 'permissions' },
    { code: 'not-object-at', key: 'permissions' },
    { code: 'not-object-at', key: 'permissions' },
  ]);
  eq('"sandbox": [] / true → refused', ['{"sandbox": []}', '{"sandbox": true}'].map(refusedAt), [
    { code: 'not-object-at', key: 'sandbox' },
    { code: 'not-object-at', key: 'sandbox' },
  ]);
  const allowBad = ['{"permissions": {"allow": [1]}}', '{"permissions": {"allow": ["Bash(ls)", 1]}}', '{"permissions": {"allow": "Bash(ls)"}}', '{"permissions": {"allow": {}}}', '{"permissions": {"allow": null}}', '{"permissions": {"allow": [["x"]]}}'];
  eq('permissions.allow holding a number / not a list / null → refused "not-string-list-at permissions.allow"', allowBad.map(refusedAt), allowBad.map(() => ({ code: 'not-string-list-at', key: 'permissions.allow' })));
  const exclBad = ['{"sandbox": {"excludedCommands": "x"}}', '{"sandbox": {"excludedCommands": {}}}', '{"sandbox": {"excludedCommands": [null]}}', '{"sandbox": {"excludedCommands": 5}}'];
  eq('sandbox.excludedCommands not a list of strings → refused', exclBad.map(refusedAt), exclBad.map(() => ({ code: 'not-string-list-at', key: 'sandbox.excludedCommands' })));
  eq(
    'a good permissions.allow beside a bad sandbox → refused as a whole (nothing half-added)',
    WS.withCcoRules('{"permissions": {"allow": []}, "sandbox": []}', R),
    { kind: 'refused', problem: { code: 'not-object-at', key: 'sandbox' } },
  );
  eq('a refused file reads "unreadable" as item 3\'s state', WS.allowItemStateOf('{"permissions": {"allow": [1]}}', R), 'unreadable');

  const allFive = `{\n\t"sandbox": {"excludedCommands": ["docker *", "${E2}", "${E1}"]},\n\t"permissions": {"allow": ["${A3}", "Bash(ls)", "${A2}", "${A1}"]}\n}`;
  eq('all five present (other order, other rules among them, the user\'s own formatting) → unchanged, nothing written', WS.withCcoRules(allFive, R), { kind: 'unchanged' });
  eq('… and item 3\'s state is "0 missing"', WS.allowItemStateOf(allFive, R), { missing: 0 });

  const some = {
    env: { A: '1' },
    permissions: { deny: ['Bash(rm *)'], allow: ['Bash(npm test)', A2], defaultMode: 'acceptEdits' },
    sandbox: { enabled: true, excludedCommands: [E2, 'docker *'] },
    zzz: [1, { b: null }, 'x'],
  };
  const someText = JSON.stringify(some, null, '\t'); // tabs, no final newline
  const someExpected = {
    env: { A: '1' },
    permissions: { deny: ['Bash(rm *)'], allow: ['Bash(npm test)', A2, A1, A3], defaultMode: 'acceptEdits' },
    sandbox: { enabled: true, excludedCommands: [E2, 'docker *', E1] },
    zzz: [1, { b: null }, 'x'],
  };
  const someChange = WS.withCcoRules(someText, R);
  eq('some present → only the missing ones added (count 3)', someChange.kind === 'changed' ? [someChange.kind, someChange.count] : someChange, ['changed', 3]);
  eq(
    '… at the end of their lists in rule order, every other key kept in its place, 2-space indent + final newline',
    someChange.text,
    `${JSON.stringify(someExpected, null, 2)}\n`,
  );
  eq('… and applying it again changes nothing', WS.withCcoRules(someChange.text ?? '', R), { kind: 'unchanged' });
  eq(
    'permissions without "allow" and no sandbox → "allow" made at the end of permissions, "sandbox" at the end of the file',
    WS.withCcoRules('{"permissions": {"ask": ["Bash(git push)"]}, "model": "opus"}', R),
    {
      kind: 'changed',
      text: `${JSON.stringify({ permissions: { ask: ['Bash(git push)'], allow: [A1, A2, A3] }, model: 'opus', sandbox: { excludedCommands: [E1, E2] } }, null, 2)}\n`,
      count: 5,
    },
  );
  eq(
    'a rule the user listed twice is not added again and both copies stay',
    WS.withCcoRules(JSON.stringify({ permissions: { allow: [A1, A1] } }), R),
    { kind: 'changed', text: `${JSON.stringify({ permissions: { allow: [A1, A1, A2, A3] }, sandbox: { excludedCommands: [E1, E2] } }, null, 2)}\n`, count: 4 },
  );
  const near = ['Bash(~/.claude-code-orchestrator/bin/cco  *)', 'Bash(~/.claude-code-orchestrator/bin/cco*)', 'bash(~/.claude-code-orchestrator/bin/cco *)', E1];
  eq('near-miss spellings, or a rule in the wrong list, do not count as present (5 missing)', WS.allowItemStateOf(JSON.stringify({ permissions: { allow: near }, sandbox: { excludedCommands: [A1] } }), R), {
    missing: 5,
  });

  // __proto__ / constructor in the file: kept as data, nothing polluted, never read as the lists.
  const protoText =
    '{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted2": "yes"}}, ' +
    `"permissions": {"__proto__": {"allow": ["${A1}", "${A2}", "${A3}"]}, "allow": ["x"]}, "sandbox": {"constructor": 1}}`;
  const protoChange = WS.withCcoRules(protoText, R);
  let out;
  try {
    out = protoChange.kind === 'changed' ? JSON.parse(protoChange.text) : undefined;
  } catch {
    out = undefined;
  }
  const own = (o, k) => (o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? Object.getOwnPropertyDescriptor(o, k).value : '<not own>');
  eq(
    '"__proto__" / "constructor" keys survive as data, are not read as the lists (5 missing), and the rules land in the real lists',
    out === undefined
      ? protoChange
      : {
          count: protoChange.count,
          keys: Object.keys(out),
          proto: own(out, '__proto__'),
          ctor: own(out, 'constructor'),
          permKeys: Object.keys(own(out, 'permissions')),
          permProto: own(own(out, 'permissions'), '__proto__'),
          allow: own(own(out, 'permissions'), 'allow'),
          sandbox: own(out, 'sandbox'),
        },
    {
      count: 5,
      keys: ['__proto__', 'constructor', 'permissions', 'sandbox'],
      proto: { polluted: 'yes' },
      ctor: { prototype: { polluted2: 'yes' } },
      permKeys: ['__proto__', 'allow'],
      permProto: { allow: [A1, A2, A3] },
      allow: ['x', A1, A2, A3],
      sandbox: { constructor: 1, excludedCommands: [E1, E2] },
    },
  );
  eq(
    '… and Object.prototype is not polluted',
    [({}).polluted, ({}).polluted2, Object.prototype.hasOwnProperty('polluted'), typeof ({}).constructor],
    [undefined, undefined, false, 'function'],
  );
  eq(
    'rules that sit only under a top-level "__proto__" key are not present (5 missing)',
    WS.allowItemStateOf(`{"__proto__": {"permissions": {"allow": ["${A1}", "${A2}", "${A3}"]}, "sandbox": {"excludedCommands": ["${E1}", "${E2}"]}}}`, R),
    { missing: 5 },
  );
}

/* ------------------------------------------------------------------------- *
 * MCP — removing the dispatch server (§15.7 item 4)
 * ------------------------------------------------------------------------- */

function groupMcp() {
  const srv = { command: 'node', args: ['/x/server.js'] };
  const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
  eq(
    'cco-dispatch among other servers → only it removed, the others and other keys kept in order',
    WS.withoutMcpServers(JSON.stringify({ mcpServers: { a: { command: 'a' }, 'cco-dispatch': srv, b: { x: 1 } }, other: 1 })),
    { kind: 'changed', text: j({ mcpServers: { a: { command: 'a' }, b: { x: 1 } }, other: 1 }), count: 1 },
  );
  eq(
    'the legacy name too → both removed (count 2)',
    WS.withoutMcpServers(JSON.stringify({ mcpServers: { 'fable-dispatch': srv, a: {}, 'cco-dispatch': srv } })),
    { kind: 'changed', text: j({ mcpServers: { a: {} } }), count: 2 },
  );
  eq('only the legacy name → removed, and item 4 reads it as present', [WS.withoutMcpServers(JSON.stringify({ mcpServers: { 'fable-dispatch': srv } })), WS.mcpItemStateOf(JSON.stringify({ mcpServers: { 'fable-dispatch': srv } }))], [
    { kind: 'changed', text: '{\n  "mcpServers": {}\n}\n', count: 1 },
    'present',
  ]);
  eq('the only entry → "mcpServers" stays as {} (the file is kept)', WS.withoutMcpServers(JSON.stringify({ mcpServers: { 'cco-dispatch': srv } })), {
    kind: 'changed',
    text: '{\n  "mcpServers": {}\n}\n',
    count: 1,
  });
  eq('an entry whose value is null is still removed', WS.withoutMcpServers('{"mcpServers": {"cco-dispatch": null}}'), { kind: 'changed', text: '{\n  "mcpServers": {}\n}\n', count: 1 });
  const absent = [undefined, '', '  \n', '{}', '{"mcpServers": {}}', '{"mcpServers": {"other": {}}}', '{"servers": {"cco-dispatch": {}}}', '{"mcpServers": {"CCO-DISPATCH": {}, "cco-dispatch ": {}, "cco_dispatch": {}}}'];
  eq(
    'absent (no file, blank, {}, no mcpServers, other servers, wrong top key, near-miss names) → unchanged and "absent"',
    absent.map((t) => [WS.withoutMcpServers(t), WS.mcpItemStateOf(t)]),
    absent.map(() => [{ kind: 'unchanged' }, 'absent']),
  );
  const badServers = ['{"mcpServers": []}', '{"mcpServers": "cco-dispatch"}', '{"mcpServers": null}', '{"mcpServers": 1}', '{"mcpServers": [{"cco-dispatch": {}}]}'];
  eq(
    '"mcpServers" not an object → refused (not-object-at mcpServers) and "unreadable"',
    badServers.map((t) => [WS.withoutMcpServers(t), WS.mcpItemStateOf(t)]),
    badServers.map(() => [{ kind: 'refused', problem: { code: 'not-object-at', key: 'mcpServers' } }, 'unreadable']),
  );
  const nj = WS.withoutMcpServers('{"mcpServers": {"cco-dispatch": {}},}');
  eq('a .mcp.json that is not JSON → refused "not-json" and "unreadable"', [nj.kind, nj.problem?.code, WS.mcpItemStateOf('{"mcpServers": {"cco-dispatch": {}},}')], ['refused', 'not-json', 'unreadable']);
  eq('a .mcp.json that is an array → refused "not-object"', WS.withoutMcpServers('[]'), { kind: 'refused', problem: { code: 'not-object' } });
  const protoMcp = WS.withoutMcpServers('{"mcpServers": {"__proto__": {"command": "x"}, "cco-dispatch": {}, "constructor": {}}}');
  let protoOut;
  try {
    protoOut = protoMcp.kind === 'changed' ? JSON.parse(protoMcp.text) : undefined;
  } catch {
    protoOut = undefined;
  }
  eq(
    '"__proto__" / "constructor" server names are kept as data; only cco-dispatch leaves',
    protoOut === undefined ? protoMcp : [protoMcp.count, Object.keys(protoOut.mcpServers), Object.getOwnPropertyDescriptor(protoOut.mcpServers, '__proto__')?.value, ({}).command],
    [1, ['__proto__', 'constructor'], { command: 'x' }, undefined],
  );
  eq(
    'cco-dispatch only under an "__proto__" key of mcpServers is not an entry → absent, unchanged',
    [WS.mcpItemStateOf('{"mcpServers": {"__proto__": {"cco-dispatch": {}}}}'), WS.withoutMcpServers('{"mcpServers": {"__proto__": {"cco-dispatch": {}}}}')],
    ['absent', { kind: 'unchanged' }],
  );
  const once = WS.withoutMcpServers(JSON.stringify({ mcpServers: { 'cco-dispatch': srv, a: {} } }));
  eq('removing twice changes nothing more', once.kind === 'changed' ? WS.withoutMcpServers(once.text) : once, { kind: 'unchanged' });

  // enabledMcpjsonServers in the local settings file
  eq(
    'enabledMcpjsonServers: both names removed, the rest kept in order, other keys kept',
    WS.withoutEnabledMcpServers(JSON.stringify({ enabledMcpjsonServers: ['a', 'cco-dispatch', 'b', 'fable-dispatch'], permissions: { allow: ['Bash(ls)'] } })),
    { kind: 'changed', text: j({ enabledMcpjsonServers: ['a', 'b'], permissions: { allow: ['Bash(ls)'] } }), count: 2 },
  );
  eq('enabledMcpjsonServers holding only ours → stays as []', WS.withoutEnabledMcpServers('{"enabledMcpjsonServers": ["cco-dispatch"]}'), {
    kind: 'changed',
    text: '{\n  "enabledMcpjsonServers": []\n}\n',
    count: 1,
  });
  eq('a name listed twice → both copies removed (count 2)', WS.withoutEnabledMcpServers('{"enabledMcpjsonServers": ["cco-dispatch", "x", "cco-dispatch"]}'), {
    kind: 'changed',
    text: j({ enabledMcpjsonServers: ['x'] }),
    count: 2,
  });
  const unchangedEnabled = [undefined, '', '{}', '{"enabledMcpjsonServers": []}', '{"enabledMcpjsonServers": ["a", "CCO-DISPATCH"]}', '{"disabledMcpjsonServers": ["cco-dispatch"], "enableAllProjectMcpServers": true}'];
  eq(
    'no file / no list / none of ours / ours only in disabledMcpjsonServers → unchanged (disabledMcpjsonServers is not touched)',
    unchangedEnabled.map((t) => WS.withoutEnabledMcpServers(t)),
    unchangedEnabled.map(() => ({ kind: 'unchanged' })),
  );
  const badEnabled = ['{"enabledMcpjsonServers": "cco-dispatch"}', '{"enabledMcpjsonServers": {"cco-dispatch": true}}', '{"enabledMcpjsonServers": ["a", 1]}', '{"enabledMcpjsonServers": null}'];
  eq(
    'enabledMcpjsonServers not a list of strings → refused',
    badEnabled.map((t) => WS.withoutEnabledMcpServers(t)),
    badEnabled.map(() => ({ kind: 'refused', problem: { code: 'not-string-list-at', key: 'enabledMcpjsonServers' } })),
  );
  const ne = WS.withoutEnabledMcpServers('{"enabledMcpjsonServers": ["cco-dispatch"],}');
  eq('a local settings file that is not JSON → refused "not-json"', [ne.kind, ne.problem?.code], ['refused', 'not-json']);
  const R = WS.ccoRules('/home/u');
  const withRules = WS.withCcoRules('{"enabledMcpjsonServers": ["cco-dispatch", "z"]}', R);
  const afterBoth = withRules.kind === 'changed' ? WS.withoutEnabledMcpServers(withRules.text) : withRules;
  eq(
    'item 3 then item 4 on one file: the rules item 3 added survive the enabledMcpjsonServers clean-up',
    afterBoth.kind === 'changed' ? [WS.allowItemStateOf(afterBoth.text, R), JSON.parse(afterBoth.text).enabledMcpjsonServers] : afterBoth,
    [{ missing: 0 }, ['z']],
  );
}

/* ------------------------------------------------------------------------- *
 * PLAN — runSetupPlan: order, unknown ids, item 4's gate, throws, win32
 * ------------------------------------------------------------------------- */

function groupPlan() {
  const ALL = ['policy', 'teamAgent', 'allowCco', 'removeMcp'];
  const outcome = (kind, text) => ({ kind, text, notes: [] });
  function fakeSteps(initial, opts = {}) {
    const log = [];
    let policy = initial;
    const steps = {
      run(item) {
        log.push(`run:${item}`);
        const how = opts.run?.[item];
        if (how === 'throw') {
          throw new Error(`boom ${item}`);
        }
        if (how === 'makeCurrent') {
          policy = 'current';
        }
        return outcome(how === 'refuse' ? 'refused' : 'done', item);
      },
      policyStateNow() {
        log.push('policyNow');
        if (policy === 'THROW') {
          throw new Error('cannot read CLAUDE.md');
        }
        return policy;
      },
      policyNotCurrent(state) {
        log.push(`notCurrent:${state}`);
        if (opts.notCurrentThrows) {
          throw new Error('nc');
        }
        return outcome('refused', `policy ${state}`);
      },
      notOffered(item) {
        log.push(`notOffered:${item}`);
        return outcome('refused', `not offered ${item}`);
      },
      failed(item, err) {
        log.push(`failed:${item}:${err instanceof Error ? err.message : String(err)}`);
        return outcome('refused', `failed ${item}`);
      },
    };
    return { steps, log };
  }
  const items = (res) => res.map((r) => r.item);
  const kinds = (res) => res.map((r) => `${r.item}:${r.outcome.kind}`);

  {
    const { steps, log } = fakeSteps('current');
    const res = WS.runSetupPlan(['removeMcp', 'allowCco', 'teamAgent', 'policy'], WS.offeredSetupItems('darwin'), steps);
    eq('items given in reverse order run 1, 2, 3, 4', items(res), ALL);
    eq('… the steps are called in that order, the policy looked at right before item 4', log, ['run:policy', 'run:teamAgent', 'run:allowCco', 'policyNow', 'run:removeMcp']);
  }
  {
    const { steps } = fakeSteps('current');
    const viaSet = items(WS.runSetupPlan(new Set(['allowCco', 'policy']), ALL, steps));
    const viaGen = items(
      WS.runSetupPlan(
        (function* gen() {
          yield 'removeMcp';
          yield 'teamAgent';
        })(),
        ALL,
        steps,
      ),
    );
    eq('a Set and a generator are accepted, and ordered the same way', [viaSet, viaGen], [['policy', 'allowCco'], ['teamAgent', 'removeMcp']]);
  }
  {
    const { steps, log } = fakeSteps('current');
    const res = WS.runSetupPlan(['bogus', 42, null, undefined, 'POLICY', 'policy ', {}, ['policy'], 'toString', '__proto__', 'constructor', 'allowCco'], ALL, steps);
    eq('values that are not item ids are ignored: no outcome, no step called (as the code defines)', { items: items(res), log }, { items: ['allowCco'], log: ['run:allowCco'] });
  }
  {
    const { steps, log } = fakeSteps('current');
    const res = WS.runSetupPlan(['policy', 'removeMcp', 'policy', 'removeMcp'], ALL, steps);
    eq('an item listed twice runs once', { items: items(res), log }, { items: ['policy', 'removeMcp'], log: ['run:policy', 'policyNow', 'run:removeMcp'] });
  }
  {
    const { steps, log } = fakeSteps('current');
    eq('nothing chosen → no outcome, no step called (not even the policy look)', { res: WS.runSetupPlan([], ALL, steps), log }, { res: [], log: [] });
    eq('a bare string is not a list of ids (its characters are not ids) → nothing runs', WS.runSetupPlan('removeMcp', ALL, steps), []);
  }

  // Item 4's gate: the policy state RIGHT BEFORE item 4.
  const wrong = [];
  for (const initial of ['absent', 'differs', 'current']) {
    for (const item1 of ['makeCurrent', 'refuse', 'throw', 'notChosen']) {
      for (const order of item1 === 'notChosen' ? ['only'] : ['forward', 'reverse']) {
        const chosen = order === 'only' ? ['removeMcp'] : order === 'forward' ? ['policy', 'removeMcp'] : ['removeMcp', 'policy'];
        const { steps, log } = fakeSteps(initial, { run: { policy: item1 } });
        const res = WS.runSetupPlan(chosen, ALL, steps);
        const finalPolicy = item1 === 'makeCurrent' ? 'current' : initial;
        const shouldRun = finalPolicy === 'current';
        const expectedTail = shouldRun ? ['policyNow', 'run:removeMcp'] : ['policyNow', `notCurrent:${finalPolicy}`];
        const tail = log.slice(-2);
        const last = res[res.length - 1];
        const lastOk = last !== undefined && last.item === 'removeMcp' && last.outcome.kind === (shouldRun ? 'done' : 'refused');
        if (!util.isDeepStrictEqual(tail, expectedTail) || !lastOk) {
          wrong.push({ initial, item1, order, log, last });
        }
      }
    }
  }
  check(
    'item 4 runs only when the policy is current right before it: 3 starting states × item 1 made current / refused / threw / not chosen × both orders',
    wrong.length === 0,
    () => `mismatches: ${show(wrong)}`,
  );
  for (const state of ['absent', 'differs']) {
    const { steps, log } = fakeSteps(state);
    const res = WS.runSetupPlan(['removeMcp'], ALL, steps);
    eq(`policy ${state}, item 1 not chosen → item 4 refused through policyNotCurrent("${state}"), its step never runs`, { kinds: kinds(res), text: res[0]?.outcome.text, log }, {
      kinds: ['removeMcp:refused'],
      text: `policy ${state}`,
      log: ['policyNow', `notCurrent:${state}`],
    });
  }
  {
    const { steps, log } = fakeSteps('current');
    eq('policy already current, item 1 not chosen → item 4 runs', [kinds(WS.runSetupPlan(['removeMcp'], ALL, steps)), log], [['removeMcp:done'], ['policyNow', 'run:removeMcp']]);
  }
  {
    const { steps, log } = fakeSteps('unreadable');
    eq('policy unreadable → item 4 refused', [kinds(WS.runSetupPlan(['removeMcp'], ALL, steps)), log], [['removeMcp:refused'], ['policyNow', 'notCurrent:unreadable']]);
  }
  {
    const { steps, log } = fakeSteps('THROW');
    eq('the policy look throws → read as unreadable → item 4 refused (never run)', [kinds(WS.runSetupPlan(['removeMcp'], ALL, steps)), log], [['removeMcp:refused'], ['policyNow', 'notCurrent:unreadable']]);
  }
  {
    const { steps, log } = fakeSteps('differs', { notCurrentThrows: true });
    eq('policyNotCurrent itself throws → item 4 is the failed outcome', [kinds(WS.runSetupPlan(['removeMcp'], ALL, steps)), log], [['removeMcp:refused'], ['policyNow', 'notCurrent:differs', 'failed:removeMcp:nc']]);
  }
  eq('mcpRemovalAllowed: only "current"', ['absent', 'differs', 'current', 'unreadable'].map((s) => WS.mcpRemovalAllowed(s)), [false, false, true, false]);

  {
    const { steps, log } = fakeSteps('current', { run: { teamAgent: 'throw' } });
    const res = WS.runSetupPlan(ALL, ALL, steps);
    eq('a step that throws → that item\'s failed outcome; the later items still run', { kinds: kinds(res), log }, {
      kinds: ['policy:done', 'teamAgent:refused', 'allowCco:done', 'removeMcp:done'],
      log: ['run:policy', 'run:teamAgent', 'failed:teamAgent:boom teamAgent', 'run:allowCco', 'policyNow', 'run:removeMcp'],
    });
  }
  {
    const thrown = new Error('the very error');
    let seen;
    const mine = outcome('done', 'mine');
    const steps = {
      run: (item) => {
        if (item === 'policy') {
          throw thrown;
        }
        return mine;
      },
      policyStateNow: () => 'current',
      policyNotCurrent: () => outcome('refused', 'nc'),
      notOffered: () => outcome('refused', 'no'),
      failed: (_item, err) => {
        seen = err;
        return outcome('refused', 'failed');
      },
    };
    const res = WS.runSetupPlan(['policy', 'allowCco'], ALL, steps);
    check('failed() is handed the thrown error itself, and an outcome is passed through as the step returned it', seen === thrown && res[1]?.outcome === mine, () => `failed got ${show(seen)}; outcome ${show(res[1])}`);
  }

  // Contract §15.12 M1: the team proxy cannot dispatch on Windows, so item 2 is not offered there.
  eq('offeredSetupItems: win32 → item 1 only', WS.offeredSetupItems('win32'), ['policy']);
  eq('offeredSetupItems: darwin / linux → all four, in order', [WS.offeredSetupItems('darwin'), WS.offeredSetupItems('linux')], [ALL, ALL]);
  const copy = WS.offeredSetupItems('darwin');
  copy.reverse();
  copy.push('x');
  eq('offeredSetupItems answers a copy (changing it changes neither SETUP_ORDER nor the next answer)', [[...WS.SETUP_ORDER], WS.offeredSetupItems('darwin')], [ALL, ALL]);
  {
    const { steps, log } = fakeSteps('current');
    const res = WS.runSetupPlan(ALL, WS.offeredSetupItems('win32'), steps);
    eq('on win32 items 2, 3 and 4 are refused as not offered: their steps never run and the policy is not even looked at', { kinds: kinds(res), log }, {
      kinds: ['policy:done', 'teamAgent:refused', 'allowCco:refused', 'removeMcp:refused'],
      log: ['run:policy', 'notOffered:teamAgent', 'notOffered:allowCco', 'notOffered:removeMcp'],
    });
  }
}

/* ------------------------------------------------------------------------- *
 * STATES — items 1 and 2, what starts checked, the "<n> of 5 missing" count
 * ------------------------------------------------------------------------- */

function mutate(text, from, to) {
  if (!text.includes(from)) {
    throw new Error(`test fixture: ${JSON.stringify(from.slice(0, 80))} is not in the text, so this mutation would change nothing`);
  }
  return text.replace(from, to);
}

function groupStates() {
  if (PR === undefined || TA === undefined) {
    fail('prompts.ts and teamAgent.ts are loaded', 'a bundle failed (see BUILD)');
    return;
  }
  const BLOCK = PR.DISPATCH_POLICY_MD;
  const st = PR.policyState;
  const lines = BLOCK.split('\n');
  const START = lines[0];
  const END = lines[lines.length - 1];
  const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
  const doubleBlank = (t) => t.replace(/\n\n/g, '\n\n\n');
  const noBlank = (t) => t.replace(/\n{2,}/g, '\n');
  const trailing = (t) => t.split('\n').map((l) => `${l} \t `).join('\n');

  check('the policy block starts and ends with its markers', /^<!-- claude-code-orchestrator:policy:start -->$/.test(START) && /^<!-- claude-code-orchestrator:policy:end -->$/.test(END), () => show([START, END]));
  if (HP !== undefined) {
    check(
      'the policy block teaches the command as COMMAND_SPELLING (orchestrator_briefing --model)',
      BLOCK.includes(`${HP.COMMAND_SPELLING} orchestrator_briefing --model`),
      'COMMAND_SPELLING + " orchestrator_briefing --model" is not in DISPATCH_POLICY_MD',
    );
  }
  eq('no CLAUDE.md / empty / only the user\'s text → absent', [st(undefined), st(''), st('# Project\n\nNotes.\n')], ['absent', 'absent', 'absent']);
  eq('the block alone → current', st(BLOCK), 'current');
  eq('the block amid the user\'s text → current', st(`# Project\n\nOwn notes.\n\n${BLOCK}\n\n## More\nmine\n`), 'current');
  eq('CRLF line endings → current', st(crlf(`# P\n\n${BLOCK}\n`)), 'current');
  eq('lone-CR line endings → current', st(`# P\n\n${BLOCK}\n`.replace(/\n/g, '\r')), 'current');
  eq(
    'a formatter\'s changes (blank lines doubled / removed, trailing blanks, CRLF, all at once) → current',
    [st(doubleBlank(BLOCK)), st(noBlank(BLOCK)), st(trailing(BLOCK)), st(crlf(trailing(doubleBlank(`# T\n\n${BLOCK}\n`))))],
    ['current', 'current', 'current', 'current'],
  );
  const edited = mutate(BLOCK, 'Apply the operating brief it returns', 'Apply the brief it returns');
  eq('one word changed inside the block → differs', st(edited), 'differs');
  eq('the MCP-era wording (briefing as a tool, not the cco command) → differs', st(mutate(BLOCK, 'orchestrator_briefing --model <your exact model ID>', 'orchestrator_briefing tool')), 'differs');
  eq('two complete blocks → differs', st(`${BLOCK}\n\n${BLOCK}\n`), 'differs');
  eq('a start marker with no end → differs', st(`# P\n${START}\nold text\n`), 'differs');
  eq('the block inside a closed fenced code block → absent (it is the user\'s example)', st(`# P\n\n\`\`\`\n${BLOCK}\n\`\`\`\n`), 'absent');
  eq('this version\'s block plus a lone end marker after it → current', st(`${BLOCK}\n\n${END}\n`), 'current');

  const mine = '# Mine\n\nKeep me.\n';
  const added = PR.upsertPolicy(mine);
  eq('upsertPolicy on a CLAUDE.md without the block → current, the user\'s text first and unchanged', [st(added), added.startsWith(mine)], ['current', true]);
  eq('upsertPolicy on a differing block → replaced in place, the text around it unchanged', PR.upsertPolicy(`# A\n\n${edited}\n\n# Z\n`), `# A\n\n${BLOCK}\n\n# Z\n`);
  const crlfUp = PR.upsertPolicy(crlf(`# A\n\n${edited}\n`));
  eq('upsertPolicy on a CRLF file → current, and no bare LF written into it', [st(crlfUp), /(^|[^\r])\n/.test(crlfUp)], ['current', false]);
  eq('upsertPolicy twice → nothing more changes', PR.upsertPolicy(added), added);

  const AG = TA.TEAM_AGENT_MD;
  const ta = TA.teamAgentState;
  if (HP !== undefined) {
    check('the team agent runs the command as COMMAND_SPELLING', AG.includes(`${HP.COMMAND_SPELLING} dispatch_task`), 'COMMAND_SPELLING + " dispatch_task" is not in TEAM_AGENT_MD');
  }
  eq('team agent: no file / empty / blank → absent', [ta(undefined), ta(''), ta(' \n\t\n')], ['absent', 'absent', 'absent']);
  eq('team agent: this version\'s file → current; with CRLF → current', [ta(AG), ta(crlf(AG))], ['current', 'current']);
  eq('team agent: the MCP-era tools line → differs', ta(mutate(AG, 'tools: Bash, Write', 'tools: mcp__cco-dispatch__dispatch_task, mcp__cco-dispatch__dispatch_status')), 'differs');
  eq('team agent: one word changed → differs', ta(mutate(AG, 'You are a dispatch proxy.', 'You are a proxy.')), 'differs');
  eq('team agent: the user\'s own agent at the path → foreign ("not ours")', ta('---\nname: cco-worker\ndescription: mine\n---\nDo my thing.\n'), 'foreign');
  const taStart = /<!-- claude-code-orchestrator:team-agent:start -->/.exec(AG);
  eq('team agent: a file that holds our start marker → differs (ours, edited)', taStart ? ta(`---\nname: x\n---\n${taStart[0]}\nmine\n`) : 'no start marker in TEAM_AGENT_MD', 'differs');

  // What starts checked (§15.7 items 1-4).
  const base = { policy: 'current', teamAgent: 'current', allowCco: { missing: 0 }, removeMcp: 'absent' };
  const cbd = (over) => [...WS.checkedByDefault({ ...base, ...over })].sort();
  eq('nothing to do anywhere → nothing checked', cbd({}), []);
  eq('item 1: absent → checked; differs → checked; current → not', [cbd({ policy: 'absent' }), cbd({ policy: 'differs' }), cbd({ policy: 'current' })], [['policy'], ['policy'], []]);
  eq('item 1: unreadable → not checked (as the code defines: it could only be refused)', cbd({ policy: 'unreadable' }), []);
  eq(
    'item 2: absent / differs → checked; current / foreign (not ours) / symlink / outside / unreadable → not',
    ['absent', 'differs', 'current', 'foreign', 'symlink', 'outside', 'unreadable'].map((s) => cbd({ teamAgent: s })),
    [['teamAgent'], ['teamAgent'], [], [], [], [], []],
  );
  eq(
    'item 3: checked when any rule is missing; not when none is, when unreadable, or when not offered',
    [cbd({ allowCco: { missing: 1 } }), cbd({ allowCco: { missing: 5 } }), cbd({ allowCco: { missing: 0 } }), cbd({ allowCco: 'unreadable' }), cbd({ allowCco: undefined })],
    [['allowCco'], ['allowCco'], [], [], []],
  );
  eq('item 4: never checked (present / absent / unreadable / not offered)', ['present', 'absent', 'unreadable', undefined].map((s) => cbd({ removeMcp: s })), [[], [], [], []]);
  eq('everything to do at once → items 1, 2, 3 checked, item 4 not', cbd({ policy: 'differs', teamAgent: 'absent', allowCco: { missing: 5 }, removeMcp: 'present' }), ['allowCco', 'policy', 'teamAgent']);

  // "<n> of 5 missing" for every subset of the five rules.
  const R = WS.ccoRules('/home/u');
  const five = [...R.allow.map((r) => ['allow', r]), ...R.excludedCommands.map((r) => ['excl', r])];
  const wrongCounts = [];
  for (let mask = 0; mask < 32; mask++) {
    const json = { permissions: { allow: [] }, sandbox: { excludedCommands: [] } };
    let present = 0;
    five.forEach(([where, rule], i) => {
      if (mask & (1 << i)) {
        present++;
        (where === 'allow' ? json.permissions.allow : json.sandbox.excludedCommands).push(rule);
      }
    });
    const text = JSON.stringify(json);
    const state = WS.allowItemStateOf(text, R);
    const change = WS.withCcoRules(text, R);
    const missing = 5 - present;
    const after = change.kind === 'changed' ? WS.allowItemStateOf(change.text, R) : state;
    const ok =
      util.isDeepStrictEqual(state, { missing }) &&
      (missing === 0 ? change.kind === 'unchanged' : change.kind === 'changed' && change.count === missing) &&
      util.isDeepStrictEqual(after, { missing: 0 });
    if (!ok) {
      wrongCounts.push({ mask, state, change: change.kind, count: change.count, after });
    }
  }
  eq('"<n> of 5 missing": for all 32 subsets of the five rules, the state counts what is missing and the change adds exactly that', wrongCounts, []);
  eq('no settings file → 5 of 5 missing; {} → 5; CCO_RULE_COUNT = 5', [WS.allowItemStateOf(undefined, R), WS.allowItemStateOf('{}', R), WS.CCO_RULE_COUNT], [{ missing: 5 }, { missing: 5 }, 5]);
}

/* ------------------------------------------------------------------------- *
 * NAGS — "this folder can dispatch", launcherPresent
 * ------------------------------------------------------------------------- */

function groupNags() {
  const wrong = [];
  const policies = ['current', 'differs', 'absent', undefined];
  for (const launcher of [true, false]) {
    for (const policy of policies) {
      for (const mcp of [true, false]) {
        const want = (launcher && policy === 'current') || mcp;
        const got = WS.canDispatchFrom({ launcherPresent: launcher, policy, mcpRegistered: mcp });
        if (got !== want) {
          wrong.push({ launcher, policy, mcp, want, got });
        }
      }
    }
  }
  eq('canDispatchFrom = (launcher AND policy current) OR MCP entry, for all 16 combinations', wrong, []);
  eq(
    'canDispatchFrom spot checks: launcher+current → yes; launcher+differs → no; current without launcher → no; MCP alone → yes; launcher + unknown policy → no',
    [
      WS.canDispatchFrom({ launcherPresent: true, policy: 'current', mcpRegistered: false }),
      WS.canDispatchFrom({ launcherPresent: true, policy: 'differs', mcpRegistered: false }),
      WS.canDispatchFrom({ launcherPresent: false, policy: 'current', mcpRegistered: false }),
      WS.canDispatchFrom({ launcherPresent: false, policy: 'absent', mcpRegistered: true }),
      WS.canDispatchFrom({ launcherPresent: true, policy: undefined, mcpRegistered: false }),
    ],
    [true, false, false, true, false],
  );

  const N = path.join(SCRATCH, 'nags');
  const mk = (name) => {
    const dir = path.join(N, name);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    return dir;
  };
  eq('launcherPathOf / cliPathOf', [WS.launcherPathOf('/d'), WS.cliPathOf('/d')], ['/d/bin/cco', '/d/mcp/cli.js']);
  const reg = mk('regular');
  fs.writeFileSync(path.join(reg, 'bin', 'cco'), '#!/bin/sh\n');
  eq('launcherPresent: a regular file at bin/cco → true on darwin and linux, false on win32', [WS.launcherPresent(reg, 'darwin'), WS.launcherPresent(reg, 'linux'), WS.launcherPresent(reg, 'win32')], [true, true, false]);
  eq('launcherPresent: platform defaults to this one', WS.launcherPresent(reg), process.platform !== 'win32');
  const none = path.join(N, 'none');
  fs.mkdirSync(none);
  eq('launcherPresent: no bin/ → false', WS.launcherPresent(none, 'darwin'), false);
  const dir = mk('dir');
  fs.mkdirSync(path.join(dir, 'bin', 'cco'));
  eq('launcherPresent: a directory at bin/cco → false', WS.launcherPresent(dir, 'darwin'), false);
  const link = mk('link');
  fs.symlinkSync(path.join(reg, 'bin', 'cco'), path.join(link, 'bin', 'cco'));
  eq('launcherPresent: a link to a regular file → true (followed)', WS.launcherPresent(link, 'darwin'), true);
  const dang = mk('dangling');
  fs.symlinkSync(path.join(N, 'nowhere'), path.join(dang, 'bin', 'cco'));
  eq('launcherPresent: a dangling link → false', WS.launcherPresent(dang, 'darwin'), false);
  const fifo = mk('fifo');
  let madeFifo = false;
  try {
    execFileSync('mkfifo', [path.join(fifo, 'bin', 'cco')], { stdio: 'ignore' });
    madeFifo = true;
  } catch {
    madeFifo = false;
  }
  if (madeFifo) {
    eq('launcherPresent: a FIFO at bin/cco → false (and the stat does not block)', WS.launcherPresent(fifo, 'darwin'), false);
  } else {
    skip('launcherPresent: a FIFO at bin/cco', 'mkfifo is not available here');
  }
}

/* ------------------------------------------------------------------------- *
 * LAUNCH — the launcher's text (§15.8), and running it with /bin/sh
 * ------------------------------------------------------------------------- */

function pinnedLauncher(node, cli) {
  return [
    '#!/bin/sh',
    '# Claude Code Orchestrator — the cco command. Written by the extension at activation; do not edit.',
    `RECORDED='${node}'`,
    `CLI='${cli}'`,
    'NODE=$RECORDED',
    'case "$NODE" in /*) [ -x "$NODE" ] || NODE= ;; *) NODE= ;; esac',
    '[ -n "$NODE" ] || NODE=$(command -v node 2>/dev/null)',
    `if [ -z "$NODE" ]; then printf 'cco: Node.js was not found (the extension recorded %s, and no node is on this PATH). Reopen VS Code so it can find Node.js again, or install Node.js 18 or later.\\n' "$RECORDED" >&2; exit 22; fi`,
    `if [ ! -f "$CLI" ]; then printf 'cco: %s is missing. Reopen VS Code so Claude Code Orchestrator can restore it.\\n' "$CLI" >&2; exit 22; fi`,
    'exec "$NODE" "$CLI" "$@"',
    '',
  ].join('\n');
}

/** A fake node: prints its tag, its pid, then $0 and every argument hex-encoded, one per line; exits 37. */
function fakeNodeText(tag) {
  return [
    '#!/bin/sh',
    'PATH=/usr/bin:/bin',
    'export PATH',
    `echo "FAKE-NODE ${tag}"`,
    'echo "PID $$"',
    'echo "ARGC $#"',
    `for a in "$0" "$@"; do printf '%s' "$a" | od -v -An -tx1 | tr -d ' \\n'; echo; done`,
    'exit 37',
    '',
  ].join('\n');
}

function parseFake(stdout) {
  const lines = String(stdout).split('\n');
  const tag = /^FAKE-NODE (\S+)$/.exec(lines[0] ?? '');
  const pid = /^PID (\d+)$/.exec(lines[1] ?? '');
  const argc = /^ARGC (\d+)$/.exec(lines[2] ?? '');
  if (!tag || !pid || !argc) {
    return undefined;
  }
  const n = Number(argc[1]) + 1;
  return { tag: tag[1], pid: Number(pid[1]), argv: lines.slice(3, 3 + n).map((hex) => Buffer.from(hex, 'hex').toString('utf8')) };
}

function groupLaunch() {
  const plainNode = '/usr/local/bin/node';
  const plainCli = '/Users/u/.claude-code-orchestrator/mcp/cli.js';
  eq('the generated script equals the pinned text (§15.8) for a plain node path', WS.launcherScript(plainNode, plainCli), pinnedLauncher(plainNode, plainCli));
  eq('… and for the bare `node` it is written with before resolveNodeCommand answers', WS.launcherScript('node', plainCli), pinnedLauncher('node', plainCli));

  let contract;
  try {
    contract = fs.readFileSync(path.join(REPO, '.orchestrator', 'contract-2.0-fixes.md'), 'utf8');
  } catch {
    contract = undefined;
  }
  const at = contract === undefined ? -1 : contract.indexOf('### 15.8');
  const open = at === -1 ? -1 : contract.indexOf('```sh\n', at);
  const close = open === -1 ? -1 : contract.indexOf('```', open + 6);
  if (open === -1 || close === -1) {
    skip('the generated script equals the block in contract §15.8', 'the contract file or its ```sh block was not found');
  } else {
    const block = contract
      .slice(open + 6, close)
      .split('\n')
      .map((l) => l.replace(/^ {2}/, ''));
    while (block.length > 0 && block[block.length - 1] === '') {
      block.pop();
    }
    const fromContract = `${block.join('\n')}\n`.replace("RECORDED='<node>'", `RECORDED='${plainNode}'`).replace("CLI='<data root>/mcp/cli.js'", `CLI='${plainCli}'`);
    eq('the generated script equals the ```sh block of contract §15.8 (placeholders filled)', WS.launcherScript(plainNode, plainCli), fromContract);
  }

  eq(
    'shSingleQuoted: plain, empty, quotes',
    [WS.shSingleQuoted('a b'), WS.shSingleQuoted(''), WS.shSingleQuoted("it's"), WS.shSingleQuoted("''")],
    ["'a b'", "''", "'it'\\''s'", "''\\'''\\'''"],
  );
  const hostile = ["it's", '$HOME', '`id`', '$(id)', '"dq"', '\\n\\t', '*', '; rm -rf x', 'a\nb', "'", "''", "'\\''", ' lead', 'trail ', '-n', 'é한글', '!x', '{a,b}', '~'];
  const badQuote = [];
  for (const s of hostile) {
    const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${WS.shSingleQuoted(s)}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    if (r.status !== 0 || r.stdout !== s) {
      badQuote.push({ s, status: r.status, out: r.stdout, err: r.stderr });
    }
  }
  eq('shSingleQuoted: sh reads every hostile value back literally', badQuote, []);

  const L = path.join(SCRATCH, 'launch');
  const cwd = path.join(L, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const emptyBin = path.join(L, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const pathBin = path.join(L, 'path-bin');
  writeExecutable(path.join(pathBin, 'node'), fakeNodeText('path'));
  const ARGS = ['arg with spaces', '', "it's", '$HOME', '`id`', '$(id)', '*', '--wait', '540', 'line1\nline2', 'é한글', '-', '"dq"', '\\back', '  '];
  const run = (launcher, args, opts = {}) => {
    const env = { PATH: opts.pathValue ?? emptyBin, HOME: HOME_DIR };
    const where = opts.cwd ?? cwd;
    return opts.direct
      ? spawnSync(launcher, args, { cwd: where, env, encoding: 'utf8', timeout: 20_000 })
      : spawnSync('/bin/sh', [launcher, ...args], { cwd: where, env, encoding: 'utf8', timeout: 20_000 });
  };
  const place = (name, node, cli) => writeExecutable(path.join(L, name, 'bin', 'cco'), WS.launcherScript(node, cli));
  const describe = (r) => ({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error ? String(r.error.message) : undefined });

  // A node path and a data root full of shell syntax.
  const weirdNodeDir = path.join(L, "n o'd\"e $HOME `touch PWNED1` $(touch PWNED2) \\x * ; & | < > é한");
  const weirdNode = writeExecutable(path.join(weirdNodeDir, 'node'), fakeNodeText('weird'));
  const weirdRoot = path.join(L, "data root 'x' $y `z`");
  const weirdCli = path.join(weirdRoot, 'mcp', 'cli.js');
  fs.mkdirSync(path.dirname(weirdCli), { recursive: true });
  fs.writeFileSync(weirdCli, '// the client\n');
  const weirdLauncher = place('weird', weirdNode, weirdCli);
  const viaSh = run(weirdLauncher, ARGS);
  const fakeSh = parseFake(viaSh.stdout);
  eq(
    'node path with a quote, a space, $, backticks: `sh cco …` execs exactly that node with the CLI and every argument unchanged ("$@": spaces, an empty one, a newline)',
    fakeSh === undefined ? describe(viaSh) : { tag: fakeSh.tag, argv: fakeSh.argv, status: viaSh.status, stderr: viaSh.stderr },
    { tag: 'weird', argv: [weirdNode, weirdCli, ...ARGS], status: 37, stderr: '' },
  );
  check('… by exec: the node runs in the launcher\'s own process (same pid), its exit code is the command\'s', fakeSh !== undefined && fakeSh.pid === viaSh.pid && viaSh.status === 37, () => `launcher pid ${viaSh.pid}, node pid ${fakeSh?.pid}, exit ${viaSh.status}`);
  const direct = run(weirdLauncher, ARGS, { direct: true });
  const fakeDirect = parseFake(direct.stdout);
  eq(
    'the launcher run directly (its #!/bin/sh line, mode 0755) does the same',
    fakeDirect === undefined ? describe(direct) : { tag: fakeDirect.tag, argv: fakeDirect.argv, status: direct.status },
    { tag: 'weird', argv: [weirdNode, weirdCli, ...ARGS], status: 37 },
  );
  const pwned = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'PWNED1' || entry.name === 'PWNED2') {
        pwned.push(path.join(dir, entry.name));
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      }
    }
  };
  walk(L);
  eq('nothing in the node path or the data root was run by the shell (no PWNED files)', pwned, []);

  const nlNodeDir = path.join(L, "line\nbreak '\\'' $(x)");
  const nlNode = writeExecutable(path.join(nlNodeDir, 'node'), fakeNodeText('newline'));
  const nlRun = run(place('newline', nlNode, weirdCli), ['x']);
  const nlFake = parseFake(nlRun.stdout);
  eq('a node path holding a newline and the \'\\\'\' sequence itself → still exactly that node', nlFake === undefined ? describe(nlRun) : nlFake.argv, [nlNode, weirdCli, 'x']);

  // Fallbacks to `node` on PATH.
  const plainRoot = path.join(L, 'root');
  const cli = path.join(plainRoot, 'mcp', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '// the client\n');
  const noExecNode = path.join(L, 'noexec', 'node');
  fs.mkdirSync(path.dirname(noExecNode), { recursive: true });
  fs.writeFileSync(noExecNode, fakeNodeText('noexec'));
  fs.chmodSync(noExecNode, 0o644);
  const pathNode = path.join(pathBin, 'node');
  const fallbacks = [
    ['NODE names a file that is not executable', noExecNode],
    ['NODE names nothing (an nvm version since removed)', path.join(L, 'removed', 'v20', 'bin', 'node')],
    ['NODE is the bare `node`', 'node'],
  ];
  for (const [label, node] of fallbacks) {
    const r = run(place(`fallback-${fallbacks.findIndex((f) => f[1] === node)}`, node, cli), ['a b', ''], { pathValue: `${emptyBin}:${pathBin}` });
    const fake = parseFake(r.stdout);
    eq(`${label} → the node on PATH runs, with the CLI and the arguments`, fake === undefined ? describe(r) : { tag: fake.tag, argv: fake.argv, status: r.status }, {
      tag: 'path',
      argv: [pathNode, cli, 'a b', ''],
      status: 37,
    });
  }

  // The pinned sentence (§15.8 as amended) names what the extension recorded.
  const NO_NODE = (recorded) =>
    `cco: Node.js was not found (the extension recorded ${recorded}, and no node is on this PATH). Reopen VS Code so it can find Node.js again, or install Node.js 18 or later.\n`;
  const goneNode = path.join(L, 'removed', 'node');
  const noNode = run(place('no-node', goneNode, cli), ['x']);
  eq('no node at all (NODE gone, none on PATH) → exit 22, the pinned sentence on stderr, nothing on stdout', describe(noNode), {
    status: 22,
    signal: null,
    stdout: '',
    stderr: NO_NODE(goneNode),
    error: undefined,
  });
  const noNodeBare = run(place('no-node-bare', 'node', cli), ['x']);
  eq('NODE bare `node` and none on PATH → exit 22 and the same sentence', [noNodeBare.status, noNodeBare.stdout, noNodeBare.stderr], [22, '', NO_NODE('node')]);

  const okNode = writeExecutable(path.join(L, 'ok-node', 'node'), fakeNodeText('ok'));
  const missingCli = path.join(L, 'gone root $x', 'mcp', 'cli.js');
  const noCli = run(place('no-cli', okNode, missingCli), ['x']);
  eq('the CLI is missing → exit 22, the pinned sentence naming the path on stderr, the node never runs', describe(noCli), {
    status: 22,
    signal: null,
    stdout: '',
    stderr: `cco: ${missingCli} is missing. Reopen VS Code so Claude Code Orchestrator can restore it.\n`,
    error: undefined,
  });
  const dirCli = path.join(L, 'dir-cli', 'mcp', 'cli.js');
  fs.mkdirSync(dirCli, { recursive: true });
  const dirRun = run(place('dir-cli-launcher', okNode, dirCli), []);
  eq('a directory where the CLI should be → exit 22 and the missing sentence', [dirRun.status, dirRun.stdout, dirRun.stderr], [
    22,
    '',
    `cco: ${dirCli} is missing. Reopen VS Code so Claude Code Orchestrator can restore it.\n`,
  ]);
  const both = run(place('both-missing', path.join(L, 'removed', 'node'), missingCli), []);
  eq('no node AND no CLI → the node sentence (it is checked first), exit 22', [both.status, both.stderr], [22, NO_NODE(goneNode)]);

  // The contract's own claim: "`[ -x 'node' ]` is false for a bare name → the PATH lookup".
  const nodeDirCwd = path.join(L, 'cwd-with-node');
  fs.mkdirSync(path.join(nodeDirCwd, 'node'), { recursive: true });
  const bareLauncher = place('bare-node', 'node', cli);
  const withPathNode = run(bareLauncher, ['y'], { cwd: nodeDirCwd, pathValue: `${emptyBin}:${pathBin}` });
  const fakeWith = parseFake(withPathNode.stdout);
  eq(
    'NODE bare `node`, the cwd holding a directory named `node`, a node on PATH → the node on PATH runs',
    fakeWith === undefined ? describe(withPathNode) : { tag: fakeWith.tag, argv: fakeWith.argv },
    { tag: 'path', argv: [pathNode, cli, 'y'] },
  );
  const withoutPathNode = run(bareLauncher, ['y'], { cwd: nodeDirCwd });
  check(
    "[contract §15.8: '`[ -x 'node' ]` is false for a bare name → the PATH lookup' + 'no node at all → exit 22'] NODE bare `node`, the Bash cwd holding a directory named `node`, no node on PATH → exit 22 and the pinned sentence",
    withoutPathNode.status === 22 && withoutPathNode.stderr === NO_NODE('node'),
    () =>
      `expected exit 22 and ${JSON.stringify(NO_NODE('node'))}; observed exit ${withoutPathNode.status}, stderr ${JSON.stringify(withoutPathNode.stderr)} — ` +
      '`[ -x node ]` tests ./node relative to the cwd, which is true for a directory (or an executable) named node, so NODE stays `node` and `exec node` fails the PATH lookup',
  );

  // Not counted: what the pinned `echo` does with a backslash in the CLI path (sh's echo may read escapes).
  const backslashCli = path.join(L, 'back\\cslash', 'mcp', 'cli.js');
  const bs = run(place('backslash', okNode, backslashCli), []);
  info(
    `observation (not a check): CLI path holding "\\c" and missing → exit ${bs.status}, stderr ${JSON.stringify(bs.stderr)} ` +
      `(expected text ${JSON.stringify(`cco: ${backslashCli} is missing. …`)}; a shell whose echo reads escapes cuts it)`,
  );
}

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

(async () => {
  await group('BUILD', groupBuild);
  if (WS === undefined) {
    current = 'BUILD';
    fail('the remaining groups ran', 'src/workspaceSetup.ts did not bundle, so nothing else can be checked');
  } else {
    await group('ROOT', groupRoot);
    await group('GIT', groupGit);
    await group('RULES', groupRules);
    await group('MCP', groupMcp);
    await group('PLAN', groupPlan);
    await group('STATES', groupStates);
    await group('NAGS', groupNags);
    await group('LAUNCH', groupLaunch);
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  console.log('');
  for (const [name, t] of tally) {
    console.log(`setup: ${name.padEnd(6)} ${t.pass} passed, ${t.fail} failed${t.skip ? `, ${t.skip} skipped` : ''}`);
    passed += t.pass;
    failed += t.fail;
    skipped += t.skip;
  }
  console.log(`setup: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exitCode = failed === 0 && passed > 0 ? 0 : 1;
})().catch((err) => {
  console.log(`FAIL ${current}: the suite threw — ${String((err && err.stack) || err).split('\n').slice(0, 5).join(' | ')}`);
  process.exitCode = 1;
});
