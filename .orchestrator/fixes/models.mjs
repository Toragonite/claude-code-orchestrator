#!/usr/bin/env node
// models.mjs — offline checks of "the model that actually ran is recorded and shown"
// (.orchestrator/contract-2.0-fixes.md §11.1): where a task's model came from (`modelSource`),
// what its CLI reported it ran (`modelUsed`), the result header and report-file lines that say
// so, `dispatch_status` and `list_workers`, and the vendor model catalog helper
// (`provider-cli.js models`). And the bounded reader a task is closed by
// (registry.latestTaskEventOf): the same answer as the whole-log reader, at a bounded cost.
//
//   node .orchestrator/fixes/models.mjs                     every section, on the CURRENT sources
//   node .orchestrator/fixes/models.mjs --only chooser,claude   some sections
//   node .orchestrator/fixes/models.mjs --sources <dir>     the current tree with every .ts file of
//                                                           <dir> laid over the src/mcp (or src)
//                                                           file of that name — how the checks are
//                                                           shown to FAIL without the change
//   node .orchestrator/fixes/models.mjs --slow              also: the helper against a CLI that never
//                                                           answers, with its real 25 s budget
//   node .orchestrator/fixes/models.mjs --keep              leave the scratch directory behind
//
// Sections: chooser · claude · detach · vendor · failover · session · transcript · list ·
// frontier · ranas · cancel · reader · helper · codexlive · pinned · accounts · recover. Exit 0
// only when every check passed; each check prints `PASS <name>` or `FAIL <name> — <why>`, and the
// last line is the tally.
//
// WHAT RUNS. The sources are bundled with esbuild into a scratch directory (never `out/`):
//   chooser         the functions themselves, in this process
//   transcript      the functions themselves, in this process, on transcripts written here; the
//                   bytes one call reads are counted in a process of its own (models-reader.cjs)
//   reader          the functions themselves, in processes of their own (models-reader.cjs)
//   codexlive       the helper bundled with a Codex adapter that lists live (the installed one,
//                   or the agent-mesh repository's source beside this one), against a fake
//                   `codex app-server` (models-fake-codex.mjs)
//   every other     a real server process over stdio (or the real helper), in the providers
//                   harness's sandbox — with models-fake-claude.mjs as `claude` (it prints the
//                   result documents the real CLI printed, models-fixtures.mjs), the harness's
//                   fake vendor CLIs, and models-fake-vendor.mjs for the listings those cannot give
//
// ISOLATION. HOME and USERPROFILE are pointed at a scratch directory before anything that
// touches state is loaded; every child gets a sandbox HOME, PATH and login shell built by the
// providers harness (never the caller's); the only `claude` is a fake, by absolute path. No real
// agent CLI is ever started: a case that needs "the CLI is not installed" is skipped when a real
// one sits where the server's fixed fallback locations would find it.
//
// LOAD. A server and at most three other processes are alive at a time; a section waits while
// the 1-minute load average is above 30.

import keychainGuard from './keychain-guard.cjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RESOLVED, RESULT_DOCUMENTS } from './models-fixtures.mjs';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-models', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FAKE_CLAUDE_SRC = path.join(HERE, 'models-fake-claude.mjs');
const FIXTURES_SRC = path.join(HERE, 'models-fixtures.mjs');
const FAKE_VENDOR = path.join(HERE, 'models-fake-vendor.mjs');
const DRIVER = path.join(HERE, 'models-driver.cjs');
const CANCEL_DRIVER = path.join(HERE, 'models-cancel.cjs');
const READER_DRIVER = path.join(HERE, 'models-reader.cjs');
const FAKE_CODEX = path.join(HERE, 'models-fake-codex.mjs');
/** Result documents the real CLI printed, one file each (kept by the orchestrator). */
const REAL_DOCS = path.join(HERE, 'real-docs');
const SUBAGENT_DOC = JSON.parse(fs.readFileSync(path.join(REAL_DOCS, 'haiku-with-sonnet-subagent.json'), 'utf8'));

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const SOURCES = opt('--sources') ? path.resolve(opt('--sources')) : undefined;
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : undefined;
const KEEP = argv.includes('--keep');
const SLOW = argv.includes('--slow');

/* ------------------------------------------------------------------------- *
 * Scratch space and isolation — before anything else is loaded
 * ------------------------------------------------------------------------- */

const REAL_HOME = os.userInfo().homedir;
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-models-')));
const MAIN_HOME = path.join(BASE, 'home-main');
fs.mkdirSync(MAIN_HOME, { recursive: true });
process.env.HOME = MAIN_HOME;
process.env.USERPROFILE = MAIN_HOME;
// Where the providers harness (loaded later) builds its sandboxes, and which build it starts.
process.env.PROVIDERS_TMPDIR = BASE;
process.env.PROVIDERS_OUT_DIR = path.join(BASE, 'out', 'mcp');
delete process.env.PROVIDERS_KEEP;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
const skipped = [];
function clip(value, max = 320) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…[${flat.length} chars]` : flat;
}
function check(name, ok, why = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} — ${clip(why === '' ? 'the condition did not hold' : why)}`);
  }
  return ok;
}
function skip(name, why) {
  skipped.push(name);
  console.log(`SKIP ${name} — ${why}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function calm() {
  const deadline = Date.now() + 10 * 60_000;
  while (os.loadavg()[0] > 30 && Date.now() < deadline) {
    console.log(`  (load average ${os.loadavg()[0].toFixed(1)} — waiting)`);
    await sleep(5000);
  }
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line
    }
  }
  return rows;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 40, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out (${timeoutMs} ms) waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------------- *
 * Build
 * ------------------------------------------------------------------------- */

const OUT = path.join(BASE, 'out');
const CORE_CJS = path.join(OUT, 'core.cjs');
let SRC;
let esbuildOptions;

/** The functions under test as ONE module; the server bundles are built by buildServer. */
async function build() {
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  let src = path.join(REPO, 'src');
  if (SOURCES !== undefined) {
    // The whole current tree, with every `.ts` file of <dir> laid over the file of the same
    // name — under src/mcp when there is one there, else directly under src.
    src = path.join(BASE, 'staged-src');
    fs.cpSync(path.join(REPO, 'src'), src, { recursive: true });
    for (const name of fs.readdirSync(SOURCES).filter((f) => f.endsWith('.ts')).sort()) {
      const target = [path.join(src, 'mcp', name), path.join(src, name)].find((f) => fs.existsSync(f));
      if (target === undefined) {
        throw new Error(`--sources: ${name} is not a file of src/mcp or src`);
      }
      fs.copyFileSync(path.join(SOURCES, name), target);
      console.log(`  using ${path.join(SOURCES, name)} as ${path.relative(src, target)}`);
    }
  }
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    logLevel: 'error',
    // A staged tree has no node_modules above it.
    nodePaths: [path.join(REPO, 'node_modules')],
  };
  SRC = src;
  esbuildOptions = { esbuild, common };
  fs.mkdirSync(OUT, { recursive: true });
  const entry = path.join(OUT, 'core-entry.ts');
  const from = (rel) => JSON.stringify(path.join(src, rel));
  fs.writeFileSync(
    entry,
    [
      // As namespaces: a build of older sources does not export everything a check asks for,
      // and that must be a failed check, not a failed build.
      `export * as taskRunner from ${from('mcp/task-runner')};`,
      `export * as providerRunner from ${from('mcp/provider-runner')};`,
      `export * as registry from ${from('registry')};`,
      `export * as platform from ${from('platform')};`,
      `export * as ranAs from ${from('ranAs')};`,
      `export * as transcript from ${from('mesh/transcript')};`,
      `export * as contract from ${from('mesh/contract')};`,
      '',
    ].join('\n'),
  );
  await esbuild.build({ ...common, entryPoints: [entry], format: 'cjs', outfile: CORE_CJS });
}

let serverBuilt = false;
/** The server, its detach supervisor and the provider helper, beside each other as shipped. */
async function buildServer() {
  if (serverBuilt) return;
  const { esbuild, common } = esbuildOptions;
  for (const entry of ['server', 'run-task', 'provider-cli']) {
    await esbuild.build({ ...common, entryPoints: [path.join(SRC, 'mcp', `${entry}.ts`)], outfile: path.join(OUT, 'mcp', `${entry}.js`) });
  }
  serverBuilt = true;
}

let H; // .orchestrator/providers/helpers.mjs, loaded once the build exists
async function harness() {
  await buildServer();
  H ??= await import(pathToFileURL(path.join(REPO, '.orchestrator', 'providers', 'helpers.mjs')).href);
  return H;
}

/* ------------------------------------------------------------------------- *
 * Reading a result, a report and a task's records
 * ------------------------------------------------------------------------- */

/** The parts of a dispatch result: its first line, the task id and output file of its second. */
function parseResult(text) {
  const lines = String(text).split('\n');
  const second = /^task: (\S+) · output: (.+)$/.exec(lines[1] ?? '');
  return { line1: lines[0], taskId: second?.[1], outputFile: second?.[2], lines };
}

/** `dispatch_status` for one id, as the record it returns. */
async function statusOf(srv, id) {
  const r = await srv.callTool('dispatch_status', { id }, 30_000);
  try {
    return JSON.parse(r.text).tasks[0];
  } catch {
    return { unparseable: r.text };
  }
}

const sources = (events) => events.map((e) => e.modelSource);
const withUsed = (events) => events.filter((e) => Object.hasOwn(e, 'modelUsed'));
const describe = (events) => events.map((e) => `${e.status}:${e.worker}:${e.model}:${e.modelSource ?? '∅'}:${e.modelUsed ?? '∅'}`);

/* ------------------------------------------------------------------------- *
 * Section: chooser — the pure functions
 * ------------------------------------------------------------------------- */

async function sectionChooser(core) {
  const tr = core.taskRunner ?? {};
  const pr = core.providerRunner ?? {};
  const reported = tr.reportedModel;
  if (!check('chooser: task-runner exports reportedModel', typeof reported === 'function', Object.keys(tr).filter((k) => /model/i.test(k)))) {
    return;
  }
  // (modelUsage, the model that was asked for, how many subagents the run started). The rows
  // below that pass neither ask for `opus` of a run that started no subagent: where the table
  // holds no `claude-opus…` entry, that is the "another family ran, nothing was delegated" case,
  // answered from all the entries.
  const safe = (value, ...rest) => {
    // Not default parameters: `undefined` is one of the values the rows hand over.
    const asked = rest.length > 0 ? rest[0] : 'opus';
    const spawned = rest.length > 1 ? rest[1] : 0;
    try {
      return { value: reported(value, asked, spawned) };
    } catch (err) {
      return { threw: String(err && err.message ? err.message : err) };
    }
  };
  // The three documents the real CLI printed.
  for (const alias of ['haiku', 'sonnet', 'opus']) {
    const doc = RESULT_DOCUMENTS[alias];
    const got = safe(doc.modelUsage, alias, doc.subagent_stats?.spawned);
    check(`chooser: the real \`--model ${alias}\` document → ${RESOLVED[alias]}`, got.value === RESOLVED[alias] && doc.subagent_stats?.spawned === 0, got);
  }

  // The MAIN model, not the dearest: a real `--model haiku` run whose one subagent ran on sonnet.
  {
    const usage = SUBAGENT_DOC.modelUsage;
    const spawned = SUBAGENT_DOC.subagent_stats?.spawned;
    check('main model: the premise — the real document lists haiku (cost 0.048) AND sonnet (cost 0.095), and says it started 1 subagent', usage[RESOLVED.haiku].costUSD < usage[RESOLVED.sonnet].costUSD && spawned === 1, { costs: [usage[RESOLVED.haiku].costUSD, usage[RESOLVED.sonnet].costUSD], spawned });
    check(`main model: asked for \`haiku\` → ${RESOLVED.haiku}, although the subagent's sonnet cost more`, safe(usage, 'haiku', spawned).value === RESOLVED.haiku, safe(usage, 'haiku', spawned));
    check('main model: the same table asked for `sonnet` → the sonnet entry (the family decides, not the order)', safe(usage, 'sonnet', spawned).value === RESOLVED.sonnet, safe(usage, 'sonnet', spawned));
    check('main model: asked for `opus` (no entry of that family) of a run that started a subagent → nothing reported', safe(usage, 'opus', spawned).value === undefined, safe(usage, 'opus', spawned));
  }
  const entry = (costUSD, outputTokens = 1) => ({ costUSD, outputTokens });
  check('main model: an alias takes the ids `claude-<alias>` followed by `-`, `[` or nothing — whatever their letter case — and no others', safe({ 'claude-haikuish-1': entry(9), 'claude-haiku': entry(1) }, 'haiku', 3).value === 'claude-haiku' && safe({ 'claude-haikuish-1': entry(9), 'claude-haiku[1m]': entry(1) }, 'haiku', 3).value === 'claude-haiku[1m]' && safe({ 'claude-haikuish-1': entry(9), 'CLAUDE-HAIKU-4-5': entry(1) }, 'HAIKU', 3).value === 'CLAUDE-HAIKU-4-5' && safe({ 'claude-haikuish-1': entry(9), 'xclaude-haiku-4': entry(5) }, 'haiku', 3).value === undefined, [safe({ 'claude-haikuish-1': entry(9), 'claude-haiku': entry(1) }, 'haiku', 3), safe({ 'claude-haikuish-1': entry(9), 'xclaude-haiku-4': entry(5) }, 'haiku', 3)]);
  check('main model: a full id takes that id and that id with more after a `-`, `[1m]` aside on both sides', ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20260101', 'Claude-Opus-5-5'].every((id) => safe({ 'claude-sonnet-5': entry(9), [id]: entry(1) }, 'claude-opus-5-5', 2).value === id) && safe({ 'claude-sonnet-5': entry(9), 'claude-opus-5-5-20260101': entry(1) }, 'claude-opus-5-5[1m]', 2).value === 'claude-opus-5-5-20260101' && safe({ 'claude-sonnet-5': entry(9), 'claude-opus-5-50': entry(1) }, 'claude-opus-5-5', 2).value === undefined && safe({ 'claude-sonnet-5': entry(9), 'claude-opus-5': entry(1) }, 'claude-opus-5-5', 2).value === undefined, [safe({ 'claude-sonnet-5': entry(9), 'claude-opus-5-50': entry(1) }, 'claude-opus-5-5', 2)]);
  check('main model: two entries of the asked family (the plain id and its `[1m]` form) → the dearer of the family, whatever else cost more', safe({ 'claude-opus-5-5': entry(0.2), 'claude-opus-5-5[1m]': entry(0.9), 'claude-sonnet-5': entry(5) }, 'opus', 1).value === 'claude-opus-5-5[1m]' && safe({ 'claude-opus-5-5': entry(0.9), 'claude-opus-5-5[1m]': entry(0.2), 'claude-sonnet-5': entry(5) }, 'opus', 1).value === 'claude-opus-5-5' && safe({ 'claude-opus-5-5': entry(0.5, 2), 'claude-opus-5-5[1m]': entry(0.5, 9) }, 'opus', 0).value === 'claude-opus-5-5[1m]' && safe({ 'claude-opus-5-5': entry(0.5, 2), 'claude-opus-5-5[1m]': entry(0.5, 2) }, 'opus', 0).value === 'claude-opus-5-5', safe({ 'claude-opus-5-5': entry(0.2), 'claude-opus-5-5[1m]': entry(0.9), 'claude-sonnet-5': entry(5) }, 'opus', 1));
  check('main model: no entry of the asked family and NO subagent → the CLI ran another family, which is shown (the dearest of all)', safe({ [RESOLVED.haiku]: entry(0.001), 'claude-sonnet-5': entry(0.2) }, 'opus', 0).value === 'claude-sonnet-5', safe({ [RESOLVED.haiku]: entry(0.001), 'claude-sonnet-5': entry(0.2) }, 'opus', 0));
  {
    const other = { [RESOLVED.haiku]: entry(0.001), 'claude-sonnet-5': entry(0.2) };
    const silent = [1, 7, undefined, null, '0', 'none', NaN, Infinity, -1, true, {}, [0]].filter((spawned) => safe(other, 'opus', spawned).value !== undefined || 'threw' in safe(other, 'opus', spawned));
    check('main model: no entry of the asked family and subagents started — or a document that does not say (`subagent_stats` absent, or not a count) → nothing reported, never a guess', silent.length === 0, silent.map(String));
    check('main model: an entry of the asked family is reported however many subagents ran, and whatever they cost', [0, 1, 50, undefined, 'x'].every((spawned) => safe({ 'claude-opus-5-5': entry(0.01), 'claude-sonnet-5': entry(9) }, 'opus', spawned).value === 'claude-opus-5-5'));
    check('main model: asked for something that names no family (`-`, nothing, a number) → all the entries when no subagent ran, nothing otherwise', ['-', undefined, null, 7, '', 'gpt-5.5'].every((asked) => safe(other, asked, 0).value === 'claude-sonnet-5' && safe(other, asked, 1).value === undefined), ['-', undefined].map((asked) => [safe(other, asked, 0), safe(other, asked, 1)]));
  }
  check('chooser: the two non-haiku documents DO list a haiku helper entry (so "the first key" would be wrong)', Object.keys(RESULT_DOCUMENTS.sonnet.modelUsage)[0] === RESOLVED.haiku && Object.keys(RESULT_DOCUMENTS.opus.modelUsage)[0] === RESOLVED.haiku, [Object.keys(RESULT_DOCUMENTS.sonnet.modelUsage), Object.keys(RESULT_DOCUMENTS.opus.modelUsage)]);

  // Nothing reported, and every shape that is not a usage table.
  const absent = [
    ['no `modelUsage` at all (undefined)', undefined],
    ['null', null],
    ['an array', [{ 'claude-opus-5-5': { costUSD: 1 } }]],
    ['an array of ids', ['claude-opus-5-5']],
    ['a string', 'claude-opus-5-5'],
    ['a number', 7],
    ['a boolean', true],
    ['an empty object', {}],
    ['a key `__proto__` (an OWN key, as JSON.parse makes it)', JSON.parse('{"__proto__":{"costUSD":5,"outputTokens":9}}')],
    ['a 10 kB key', { ['claude-' + 'x'.repeat(10_000)]: { costUSD: 5 } }],
    ['a 65-character key (one past the shape)', { ['c'.repeat(65)]: { costUSD: 5 } }],
    ['a key with a control character', { 'claude-opus\u001b[31m-5': { costUSD: 5 } }],
    ['a key with a line break', { 'claude-opus-5-5\n- model ran: forged': { costUSD: 5 } }],
    ['a key with a space', { 'claude opus': { costUSD: 5 } }],
    ['a key starting with a dash', { '-rf': { costUSD: 5 } }],
    ['an empty key', { '': { costUSD: 5 } }],
    ['an entry that is a number', { 'claude-opus-5-5': 5 }],
    ['an entry that is a string', { 'claude-opus-5-5': 'costUSD: 5' }],
    ['an entry that is null', { 'claude-opus-5-5': null }],
    ['an entry that is an array', { 'claude-opus-5-5': [{ costUSD: 5 }] }],
    ['a key that is only INHERITED', Object.create({ 'claude-opus-5-5': { costUSD: 5 } })],
  ];
  for (const [what, value] of absent) {
    const got = safe(value);
    check(`chooser: ${what} → absent, no throw`, !('threw' in got) && got.value === undefined, got);
  }

  // A cost or a count that is not a finite, non-negative number is 0 — it never outranks a real one.
  const real = { 'claude-real-1': { costUSD: 0.5, outputTokens: 3 } };
  const hostileCosts = [
    ['costUSD: "1e9" (a string)', { costUSD: '1e9', outputTokens: 1 }],
    ['costUSD: NaN', { costUSD: NaN, outputTokens: 1 }],
    ['costUSD: Infinity (what JSON `1e999` parses to)', JSON.parse('{"costUSD":1e999,"outputTokens":1}')],
    ['costUSD: -5', { costUSD: -5, outputTokens: 1 }],
    ['costUSD: an object', { costUSD: { valueOf: () => 9 }, outputTokens: 1 }],
    ['costUSD: true', { costUSD: true, outputTokens: 1 }],
    ['costUSD: null', { costUSD: null, outputTokens: 1 }],
  ];
  for (const [what, entry] of hostileCosts) {
    const before = safe({ 'claude-hostile-1': entry, ...real });
    const after = safe({ ...real, 'claude-hostile-1': entry });
    check(`chooser: ${what} counts as 0 — the entry with a real cost wins, listed before or after it`, before.value === 'claude-real-1' && after.value === 'claude-real-1', { before, after });
  }
  check('chooser: outputTokens: "9999" (a string) counts as 0 in a tie on cost', safe({ 'claude-a': { costUSD: 1, outputTokens: '9999' }, 'claude-b': { costUSD: 1, outputTokens: 2 } }).value === 'claude-b');
  check('chooser: an entry whose only cost is a string is still what the CLI reported — the id, with a cost of 0', safe({ 'claude-only-1': { costUSD: '1e9' } }).value === 'claude-only-1');
  check('chooser: an entry that is not an object is skipped, not the whole table', safe({ 'claude-junk-1': 5, 'claude-real-1': { costUSD: 0.1 } }).value === 'claude-real-1');
  check('chooser: a hostile key is skipped, not the whole table', safe({ ['x'.repeat(10_000)]: { costUSD: 99 }, 'claude-real-1': { costUSD: 0.1 } }).value === 'claude-real-1');

  // Ties.
  check('chooser: a tie in cost → the larger outputTokens', safe({ 'claude-a': { costUSD: 0.2, outputTokens: 4 }, 'claude-b': { costUSD: 0.2, outputTokens: 40 } }).value === 'claude-b');
  check('chooser: a tie in cost and in outputTokens → the first', safe({ 'claude-a': { costUSD: 0.2, outputTokens: 4 }, 'claude-b': { costUSD: 0.2, outputTokens: 4 } }).value === 'claude-a');
  check('chooser: costs missing everywhere → the larger outputTokens', safe({ 'claude-a': { outputTokens: 4 }, 'claude-b': { outputTokens: 40 }, 'claude-c': { outputTokens: 7 } }).value === 'claude-b');
  check('chooser: costs and counts missing everywhere → the first', safe({ 'claude-a': {}, 'claude-b': {}, 'claude-c': {} }).value === 'claude-a');
  check('chooser: a null-prototype table is read like any other', safe(Object.assign(Object.create(null), { 'claude-a': { costUSD: 1 }, 'claude-b': { costUSD: 2 } })).value === 'claude-b');
  check('chooser: another vendor\'s id shape is accepted (`gpt-5.6-sol`, `a:b[c]`)', safe({ 'gpt-5.6-sol': { costUSD: 1 } }).value === 'gpt-5.6-sol' && safe({ 'a:b[c]': { costUSD: 1 } }).value === 'a:b[c]');
  check('chooser: an id with a context-window suffix is reported whole (`claude-opus-5-5[1m]`)', safe({ [RESOLVED.haiku]: { costUSD: 0.0009 }, 'claude-opus-5-5[1m]': { costUSD: 0.2 } }).value === 'claude-opus-5-5[1m]');
  check('chooser: an id is reported in the letter case the CLI printed', safe({ 'Claude-Opus-5-5': { costUSD: 0.2 } }).value === 'Claude-Opus-5-5');
  {
    const many = {};
    for (let i = 0; i < 5000; i++) many[`claude-n-${i}`] = { costUSD: i };
    const got = safe(many);
    check('chooser: a table of 5000 entries is answered from a bounded scan, without throwing', typeof got.value === 'string' && /^claude-n-\d+$/.test(got.value), got);
  }

  // The header's first line and the report's lines.
  const text = tr.resultModelText;
  if (check('chooser: task-runner exports resultModelText', typeof text === 'function')) {
    check('header: an alias and what it ran as → `haiku → claude-haiku-4-5-20251001`', text('haiku', RESOLVED.haiku) === `haiku → ${RESOLVED.haiku}`, text('haiku', RESOLVED.haiku));
    check('header: nothing reported → the requested model alone', text('haiku', undefined) === 'haiku');
    check('header: a full id that ran as itself → no arrow', text('claude-opus-5-5', 'claude-opus-5-5') === 'claude-opus-5-5');
    check('header: a reported id with square brackets is shown whole (`opus → claude-opus-5-5[1m]`)', text('opus', 'claude-opus-5-5[1m]') === 'opus → claude-opus-5-5[1m]' && text('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]') === 'claude-opus-5-5[1m]', text('opus', 'claude-opus-5-5[1m]'));
    check('header: the two strings are compared as they are — a difference in letter case alone is shown', text('opus', 'OPUS') === 'opus → OPUS' && text('claude-opus-5-5', 'Claude-Opus-5-5') === 'claude-opus-5-5 → Claude-Opus-5-5', [text('opus', 'OPUS'), text('claude-opus-5-5', 'Claude-Opus-5-5')]);
    check('header: nothing was requested (`-`) and an id was reported → `- → <id>` (a case the dispatch core does not produce: see vendor)', text('-', 'gpt-5.6-terra') === '- → gpt-5.6-terra');
  }
  const lines = tr.modelHeaderLines;
  if (check('chooser: task-runner exports modelHeaderLines', typeof lines === 'function')) {
    check('report: worker default, with a reported model', lines('worker', RESOLVED.haiku) === `\n- model ran: ${RESOLVED.haiku}\n- model source: worker default`, lines('worker', RESOLVED.haiku));
    check('report: dispatch, nothing reported → no `- model ran:` line', lines('dispatch') === '\n- model source: dispatch', lines('dispatch'));
    check('report: CLI default', lines('cli') === '\n- model source: CLI default', lines('cli'));
  }
  const decide = tr.attemptModel;
  if (check('chooser: task-runner exports attemptModel', typeof decide === 'function')) {
    check('source: the dispatch named none, the worker has a default → `worker`', eq(decide(undefined, { model: 'haiku' }), { requested: 'haiku', model: 'haiku', source: 'worker' }), decide(undefined, { model: 'haiku' }));
    check('source: the dispatch named one → `dispatch`, whatever the worker defaults to', eq(decide('opus', { model: 'haiku' }), { requested: 'opus', model: 'opus', source: 'dispatch' }) && decide('opus', { model: '' }).source === 'dispatch', decide('opus', { model: 'haiku' }));
    check('source: neither → `cli`, nothing to pass, `-` in the records', eq(decide(undefined, { model: '' }), { requested: '', model: '-', source: 'cli' }), decide(undefined, { model: '' }));
  }

  // A vendor run: the adapter's field, when it is not the request coming back.
  const vendor = pr.reportedProviderModel;
  if (check('chooser: provider-runner exports reportedProviderModel', typeof vendor === 'function')) {
    check('vendor: no model was requested and the CLI named one → that id', vendor(undefined, 'gpt-5.6-terra') === 'gpt-5.6-terra' && vendor('', 'gpt-5.6-terra') === 'gpt-5.6-terra');
    check('vendor: the adapter hands back the requested id → NOT an observation, absent', vendor('gpt-5.5', 'gpt-5.5') === undefined && vendor(' gpt-5.5 ', 'gpt-5.5') === undefined);
    check('vendor: an id other than the requested one → that id', vendor('auto', 'composer-2.5') === 'composer-2.5');
    const bad = [undefined, null, 5, {}, ['gpt-5.5'], '', 'two words', 'x'.repeat(65), '-dash', 'gpt-5.5\n', 'a/b'];
    const kept = bad.filter((value) => {
      try {
        return vendor(undefined, value) !== undefined;
      } catch {
        return true;
      }
    });
    check('vendor: a reported value that is not a string in the id shape → absent, no throw', kept.length === 0, kept);
  }
  const entries = pr.catalogEntries;
  if (check('chooser: provider-runner exports catalogEntries', typeof entries === 'function')) {
    // A listing as an adapter hands it over, and the text a CLI would have printed for it: one
    // line per model, `<id><TAB><name>`.
    const asPrinted = (list) => list.filter((e) => e && typeof e.id === 'string').map((e) => `${e.id}\t${typeof e.label === 'string' ? e.label : ''}`).join('\n');
    const listed = [
      { id: 'gemini-a', label: 'Gemini  A​​' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)‌' },
      { id: ' gemini-padded ', label: 'the rule would trim this id' },
      { id: 'gemini-b​', label: 'a zero-width character after the id' },
      { id: 'gemini-tab', label: 'Tab\tbed' },
      { id: 'gemini-long', label: 'N'.repeat(300) },
      { id: 'gpt-oss-120b-medium' },
      { id: 'gemini-invisible', label: '​‍⁠﻿' },
      { id: 'gemini-a', label: 'a second time' },
      { id: 'gemini-emoji', label: 'Family \u{1F468}‍\u{1F469}‍\u{1F467} tier' },
      { id: 'gemini-basic', label: 'Basic Reasoning Model' },
      { id: 'gemini-num', label: 42 },
      null,
      'gemini-string',
      { id: 7 },
      { id: 'x'.repeat(129), label: 'too long' },
    ];
    const got = entries('gemini', listed, asPrinted(listed));
    check('catalog: own models first, then the resold ones, each in the listing\'s order; an id the rule would alter, a repeated id and a non-entry are left out', eq(got.map((m) => m.id), ['gemini-a', 'gemini-tab', 'gemini-long', 'gemini-invisible', 'gemini-emoji', 'gemini-basic', 'gemini-num', 'claude-opus-5-5-high', 'gpt-oss-120b-medium']), got.map((m) => m.id));
    check('catalog: `resold: true` on the models of another vendor\'s family, no such key on the provider\'s own', eq(got.map((m) => (Object.hasOwn(m, 'resold') ? m.resold : null)), [null, null, null, null, null, null, null, true, true]), got);
    const byId = Object.fromEntries(got.map((m) => [m.id, m]));
    check('catalog: labels are one clean line — zero-width suffix gone, doubled space and tab one space, 300 characters cut to 80', byId['gemini-a'].label === 'Gemini A' && byId['claude-opus-5-5-high'].label === 'Claude Opus 5.5 (High)' && byId['gemini-tab'].label === 'Tab bed' && byId['gemini-long'].label === 'N'.repeat(80), got);
    check('catalog: a label with no visible text, or that is not text, is left out; a joiner INSIDE a label and an ordinary phrase are kept as they are', !Object.hasOwn(byId['gemini-invisible'], 'label') && !Object.hasOwn(byId['gemini-num'], 'label') && byId['gemini-emoji'].label === 'Family \u{1F468}‍\u{1F469}‍\u{1F467} tier' && byId['gemini-basic'].label === 'Basic Reasoning Model', got);

    // A label is the display name the CLI PRINTED — what an adapter adds to it is not shown.
    const printed = ['Available models', '', 'auto - Auto', 'gpt-5.6 - GPT 5.6', 'composer-2.5 - Composer 2.5', 'kimi-k2 - Kimi K2  (preview)​', 'cursor-small - Small', '', 'Tip: use --model auto'].join('\n');
    const decorated = [
      { id: 'auto', label: 'Auto — the adapter\'s own remark about this router' },
      { id: 'gpt-5.6', label: 'GPT 5.6 — a remark the adapter appends to a resold model' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'kimi-k2', label: 'Kimi K2  (preview)​ — a remark the adapter appends to a resold model' },
      { id: 'cursor-small', label: 'A remark in FRONT of the name: Small' },
    ];
    const stripped = entries('cursor', decorated, printed);
    check('catalog: what an adapter APPENDS to the name the CLI printed is removed — `Auto`, `GPT 5.6`, `Kimi K2 (preview)`; a label the adapter left alone is kept', eq(stripped, [{ id: 'auto', label: 'Auto' }, { id: 'composer-2.5', label: 'Composer 2.5' }, { id: 'cursor-small' }, { id: 'gpt-5.6', label: 'GPT 5.6', resold: true }, { id: 'kimi-k2', label: 'Kimi K2 (preview)', resold: true }]), stripped);
    check('catalog: a label whose START is not what the CLI printed (words put in front of the name) is left out, not guessed at', !Object.hasOwn(stripped.find((m) => m.id === 'cursor-small'), 'label'), stripped);
    check('catalog: a label that is only the adapter\'s words (no name the CLI printed) is left out', eq(entries('cursor', [{ id: 'auto', label: 'the adapter\'s own remark about this router' }], printed), [{ id: 'auto' }]), entries('cursor', [{ id: 'auto', label: 'the adapter\'s own remark about this router' }], printed));
    check('catalog: with no printed text at all — an adapter\'s built-in catalog — no entry has a label', eq(entries('cursor', decorated), [{ id: 'auto' }, { id: 'composer-2.5' }, { id: 'cursor-small' }, { id: 'gpt-5.6', resold: true }, { id: 'kimi-k2', resold: true }]) && eq(entries('gemini', [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (a remark in brackets)' }]), [{ id: 'claude-sonnet-4-6', resold: true }]), entries('cursor', decorated));
    check('catalog: the name is found on the line that NAMES the model — a line that merely ends the same way, or a name inside another line, does not count', eq(entries('cursor', [{ id: 'cursor-x', label: 'Shared Name — remark' }], 'cursor-y - Shared Name\ncursor-x - Shared Name'), [{ id: 'cursor-x', label: 'Shared Name' }]) && eq(entries('cursor', [{ id: 'cursor-x', label: 'Name — remark' }], 'cursor-y - Name\ncursor-x is mentioned here but ReName'), [{ id: 'cursor-x' }]), [entries('cursor', [{ id: 'cursor-x', label: 'Shared Name — remark' }], 'cursor-y - Shared Name\ncursor-x - Shared Name'), entries('cursor', [{ id: 'cursor-x', label: 'Name — remark' }], 'cursor-y - Name\ncursor-x is mentioned here but ReName')]);
    {
      const started = Date.now();
      const long = entries('cursor', [{ id: 'cursor-x', label: 'ab'.repeat(2000) + ' tail' }], `cursor-x - ${'ab'.repeat(1900)}`);
      check('catalog: a pathological label against a pathological line is answered at once (the comparison is linear)', Date.now() - started < 500 && long.length === 1, [Date.now() - started, long.length]);
    }

    // A model's own line — the one that begins with its id — is the line its name is read from.
    {
      const mentions = Array.from({ length: 9 }, (_, i) => `m${i + 1} - Like auto ${i + 1}`);
      check('catalog: a model whose id is a word in nine EARLIER display names keeps the name on its own line', eq(entries('cursor', [{ id: 'auto', label: 'Auto — the adapter\'s remark' }], [...mentions, 'auto - Auto'].join('\n')), [{ id: 'auto', label: 'Auto' }]), entries('cursor', [{ id: 'auto', label: 'Auto — the adapter\'s remark' }], [...mentions, 'auto - Auto'].join('\n')));
      check('catalog: …and its own line is the one that counts even when a line that merely mentions the id would fit the label too', eq(entries('cursor', [{ id: 'cursor-x', label: 'Shared — remark' }], 'cursor-y - cursor-x Shared — remark\ncursor-x - Shared'), [{ id: 'cursor-x', label: 'Shared' }]), entries('cursor', [{ id: 'cursor-x', label: 'Shared — remark' }], 'cursor-y - cursor-x Shared — remark\ncursor-x - Shared'));
      check('catalog: where no line begins with the id (a listing that puts it elsewhere), a line that names it still counts', eq(entries('gemini', [{ id: 'gemini-x', label: 'X Name' }], 'Model gemini-x X Name'), [{ id: 'gemini-x', label: 'X Name' }]), entries('gemini', [{ id: 'gemini-x', label: 'X Name' }], 'Model gemini-x X Name'));
    }
    // Which models are a provider's own.
    check('catalog: Cursor — `auto`, `composer*` and `cursor-*` are its own; every other id it lists is resold, whatever its family', eq(entries('cursor', [{ id: 'grok-4.7-low-fast' }, { id: 'auto' }, { id: 'claude-fable-5' }, { id: 'composer-2.5' }, { id: 'kimi-k2' }, { id: 'gemini-3.8-pro' }, { id: 'cursor-grok-4.5-high' }, { id: 'gpt-5.6' }, { id: 'composer-3' }, { id: 'cursor-small' }]), [{ id: 'auto' }, { id: 'composer-2.5' }, { id: 'cursor-grok-4.5-high' }, { id: 'composer-3' }, { id: 'cursor-small' }, { id: 'grok-4.7-low-fast', resold: true }, { id: 'claude-fable-5', resold: true }, { id: 'kimi-k2', resold: true }, { id: 'gemini-3.8-pro', resold: true }, { id: 'gpt-5.6', resold: true }]), entries('cursor', [{ id: 'kimi-k2' }, { id: 'composer-3' }, { id: 'cursor-small' }]));
    check('catalog: `kimi-k2` under Cursor → resold; under Antigravity (a family this code does not know) → not resold', eq(entries('cursor', [{ id: 'kimi-k2' }]), [{ id: 'kimi-k2', resold: true }]) && eq(entries('gemini', [{ id: 'kimi-k2' }]), [{ id: 'kimi-k2' }]) && eq(entries('codex', [{ id: 'kimi-k2' }]), [{ id: 'kimi-k2' }]), [entries('cursor', [{ id: 'kimi-k2' }]), entries('gemini', [{ id: 'kimi-k2' }])]);
    check('catalog: `composer-3` and `cursor-small` under Cursor → its own', eq(entries('cursor', [{ id: 'composer-3' }, { id: 'cursor-small' }]), [{ id: 'composer-3' }, { id: 'cursor-small' }]), entries('cursor', [{ id: 'composer-3' }, { id: 'cursor-small' }]));
    {
      const many = [];
      for (let i = 0; i < 450; i++) many.push({ id: `claude-resold-${i}` }, { id: `gemini-own-${i}` });
      const capped = entries('gemini', many);
      check('catalog: at most 600 — the provider\'s own first (450), then as many resold as fit (150): a cut falls on the resold models listed last', capped.length === 600 && capped.slice(0, 450).every((m, i) => m.id === `gemini-own-${i}` && !Object.hasOwn(m, 'resold')) && capped.slice(450).every((m, i) => m.id === `claude-resold-${i}` && m.resold === true), [capped.length, capped[0], capped[450], capped[599]]);
      const under = entries('gemini', many.slice(0, 500));
      check('catalog: a listing under the cap is listed whole (500 → 500)', under.length === 500 && under.filter((m) => m.resold === true).length === 250, under.length);
      const huge = [];
      for (let i = 0; i < 100_000; i++) huge.push({ id: `gemini-own-${i}`, label: `Name ${i}` });
      const started = Date.now();
      const first = entries('gemini', huge, asPrinted(huge));
      check('catalog: a listing of 100,000 entries → the first 600 with their names, from a bounded scan', first.length === 600 && first[599].id === 'gemini-own-599' && first[599].label === 'Name 599' && Date.now() - started < 3000, [first.length, first[599], Date.now() - started]);
      // The largest line the helper can print: 600 entries, each with the longest id the model
      // rule accepts, a label of 80 characters that are 3 bytes each as UTF-8, and `resold`.
      const longest = [];
      for (let i = 0; i < 700; i++) longest.push({ id: `m${i}`.padEnd(120, 'x'), label: '漢'.repeat(300) });
      const full = entries('cursor', longest, longest.map((e) => `${e.id} - ${e.label}`).join('\n'));
      const line = JSON.stringify({ models: full, source: 'live', error: null }) + '\n';
      const bytes = Buffer.byteLength(line);
      check(`catalog: 600 entries of maximal id and label length → the printed line is under 256 KiB (${bytes} bytes)`, full.length === 600 && full.every((m) => m.id.length === 120 && m.label === '漢'.repeat(80) && m.resold === true) && bytes < 256 * 1024, [full.length, bytes, full[0]]);
      // The same arithmetic at the contract's own bound for an id (128 characters), which the
      // model rule does not even reach: the line would still fit.
      const perEntry = Buffer.byteLength(JSON.stringify({ id: 'x'.repeat(128), label: '漢'.repeat(80), resold: true })) + 1;
      check(`catalog: …and 600 entries at the contract's bounds (128-character id, 80-character label of 3-byte characters) would be ${600 * perEntry + 64} bytes — still under 256 KiB`, 600 * perEntry + 64 < 256 * 1024, [perEntry, 600 * perEntry + 64]);
    }
    let threw = false;
    try {
      for (const hostile of [undefined, null, 'gemini-a', 7, {}, [[]], [undefined], [{ id: null, label: {} }]]) {
        if (entries('gemini', hostile, 'gemini-a\tA').length !== 0) threw = true;
      }
    } catch {
      threw = true;
    }
    check('catalog: a listing that is not a list of entries → no entries, no throw', !threw);
  }
  const label = tr.windowLabel;
  if (check('chooser: task-runner exports windowLabel', typeof label === 'function')) {
    check('windows: `primary` / `secondary` → "Primary limit" / "Secondary limit"; any other label as given', label('primary') === 'Primary limit' && label('secondary') === 'Secondary limit' && label('Session (5hr)') === 'Session (5hr)' && label('weekly') === 'weekly', [label('primary'), label('secondary'), label('Session (5hr)')]);
    let threw = false;
    try {
      label(undefined);
      label(7);
      label(null);
    } catch {
      threw = true;
    }
    check('windows: a label that is not a string does not throw', !threw);
    check('windows: formatExhaustedWindow names the window the same way', tr.formatExhaustedWindow({ kind: 'session', label: 'primary', percent: 100, severity: 'critical', resetsAt: null }).startsWith('Primary limit 100% '), tr.formatExhaustedWindow({ kind: 'session', label: 'primary', percent: 100, severity: 'critical', resetsAt: null }));
  }

  // The task log: an event too large for a line keeps the two fields in its reduced form.
  {
    const reg = core.registry;
    const id = `tmodels${Date.now().toString(36)}`;
    const big = {};
    for (let i = 0; i < 60; i++) big[`extra${i}`] = 'z'.repeat(3000);
    reg.appendTaskEvent({ id, ts: Date.now(), status: 'done', title: 'oversize', worker: 'wa', model: 'haiku', modelSource: 'worker', modelUsed: RESOLVED.haiku, outputFile: '/nowhere', ...big });
    reg.appendTaskEvent({ id: `${id}b`, ts: Date.now(), status: 'done', title: 'ordinary', worker: 'wa', model: 'haiku', modelSource: 'worker', modelUsed: RESOLVED.haiku, outputFile: '/nowhere' });
    const events = reg.readTaskEvents();
    const reduced = events.find((e) => e.id === id);
    const ordinary = events.find((e) => e.id === `${id}b`);
    check('task log: an oversize event is written in its reduced form (the premise)', reduced !== undefined && reduced.extra0 === undefined && /too large/.test(String(reduced.error)), reduced);
    check('task log: …and that form keeps `modelSource` and `modelUsed`', reduced?.modelSource === 'worker' && reduced?.modelUsed === RESOLVED.haiku, reduced);
    check('task log: an ordinary event carries both fields as written', ordinary?.modelSource === 'worker' && ordinary?.modelUsed === RESOLVED.haiku, ordinary);
  }
}

/* ------------------------------------------------------------------------- *
 * A sandbox with Claude Code workers on the model-reporting fake
 * ------------------------------------------------------------------------- */

/**
 * `workers`: [{ name, model }]. The fake is copied into the sandbox (with the fixtures it
 * imports) so that the copy can carry the execute bit the registry asks of `claudePath`.
 */
async function claudeSandbox(label, workers, { registry = {}, usageTable = {}, noStoredModel = [], docs = {}, stats, start = true } = {}) {
  const fx = H.makeFixture({ label, workers });
  const fakeDir = path.join(fx.root, 'fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  const fake = path.join(fakeDir, 'models-fake-claude.mjs');
  fs.copyFileSync(FAKE_CLAUDE_SRC, fake);
  fs.copyFileSync(FIXTURES_SRC, path.join(fakeDir, 'models-fixtures.mjs'));
  fs.chmodSync(fake, 0o755);
  const log = path.join(fx.root, 'models-fake.log');
  const usageFile = path.join(fx.root, 'models-fake-usage.json');
  fs.writeFileSync(usageFile, JSON.stringify(usageTable));
  const registryFile = path.join(fx.orchRoot, 'registry.json');
  const reg = { ...JSON.parse(fs.readFileSync(registryFile, 'utf8')), claudePath: fake, workerTimeoutMinutes: 2, ...registry };
  // `noStoredModel`: entries written with no `model` key at all, as a hand-edited registry can hold.
  reg.workers = reg.workers.map((w) => (noStoredModel.includes(w.name) ? Object.fromEntries(Object.entries(w).filter(([k]) => k !== 'model')) : w));
  fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2));
  if (stats !== undefined) {
    fs.writeFileSync(path.join(fx.orchRoot, 'stats.json'), JSON.stringify(stats, null, 2));
  }
  // What `[[fake:doc:NAME]]` prints: the real documents, and any the caller made up.
  const docsDir = path.join(fx.root, 'fake-docs');
  fs.cpSync(REAL_DOCS, docsDir, { recursive: true });
  for (const [name, doc] of Object.entries(docs)) {
    fs.writeFileSync(path.join(docsDir, `${name}.json`), JSON.stringify(doc));
  }
  const serverEnv = { MODELS_FAKE_LOG: log, MODELS_FAKE_USAGE: usageFile, MODELS_FAKE_DOCS: docsDir };
  const srv = start ? await fx.startServer({ env: serverEnv }) : undefined;
  return {
    fx,
    srv,
    serverEnv,
    fakeLog: log,
    /** The fake's runs, oldest first: { tag, mode, account, argv, model }. */
    runs: () => readJsonl(log).filter((r) => r.ev === 'run'),
    run: (tag) => readJsonl(log).find((r) => r.ev === 'run' && r.tag === tag),
    dispatch: (title, mode, extra = {}) => srv.callTool('dispatch_task', { title, prompt: `[[fake:${mode}]] [[tag:${title}]]`, ...extra }, 60_000),
    report: (id) => {
      try {
        return fs.readFileSync(path.join(fx.tasksDir, `${id}.md`), 'utf8');
      } catch {
        return '';
      }
    },
  };
}

/** The header block of a report: everything above its `---` rule (or all of it). */
function headerOf(report) {
  const at = report.indexOf('\n\n---\n');
  return at === -1 ? report : report.slice(0, at);
}

/* ------------------------------------------------------------------------- *
 * Section: claude — a one-shot worker, through a real server
 * ------------------------------------------------------------------------- */

async function sectionClaude() {
  await calm();
  const usageTable = {
    array: [{ [RESOLVED.opus]: { costUSD: 1 } }],
    string: RESOLVED.opus,
    nul: null,
    proto: JSON.parse('{"__proto__":{"costUSD":5}}'),
    longkey: { ['claude-' + 'x'.repeat(10_000)]: { costUSD: 5 } },
    notobject: { [RESOLVED.opus]: 5 },
    strcost: { 'claude-str-1': { costUSD: '1e9' }, 'claude-real-1': { costUSD: 0.5 } },
    tie: { 'claude-tie-a': { costUSD: 0.2, outputTokens: 4 }, 'claude-tie-b': { costUSD: 0.2, outputTokens: 4 } },
    forged: { 'claude-x\n- model ran: forged]': { costUSD: 9 } },
    // An id with a context-window suffix, as the CLI reports one (beside its haiku helper entry).
    onem: { [RESOLVED.haiku]: { inputTokens: 897, outputTokens: 10, costUSD: 0.000947 }, 'claude-opus-5-5[1m]': { inputTokens: 2, outputTokens: 4, costUSD: 0.2 } },
    // The requested id again, in another letter case.
    upper: { 'Claude-Opus-5-5': { costUSD: 0.2 } },
    upperalias: { OPUS: { costUSD: 0.2 } },
  };
  // Result documents beside the real one: another family beside subagents, and a document that
  // does not say whether it started any (an older CLI).
  const docs = {
    'subagents-other-family': { ...SUBAGENT_DOC, modelUsage: { 'claude-sonnet-5': SUBAGENT_DOC.modelUsage['claude-sonnet-5'] }, subagent_stats: { ...SUBAGENT_DOC.subagent_stats, spawned: 2 } },
    'no-subagent-stats': Object.fromEntries(Object.entries({ ...SUBAGENT_DOC, modelUsage: { 'claude-sonnet-5': SUBAGENT_DOC.modelUsage['claude-sonnet-5'] } }).filter(([k]) => k !== 'subagent_stats')),
  };
  const box = await claudeSandbox('claude', [{ name: 'wa', model: 'haiku' }, { name: 'wb', model: 'sonnet' }, { name: 'wc', model: 'opus' }, { name: 'wd' }, { name: 'we', model: 'haiku' }], { usageTable, noStoredModel: ['wd'], docs });
  const { fx, srv } = box;
  try {
    // 1 — a CLI that reports NO model. First, so that nothing in the log can answer for it.
    {
      const r = await box.dispatch('m-nomodel', 'nomodel', { worker: 'wa' });
      const h = parseResult(r.text);
      const events = fx.eventsFor('m-nomodel');
      const report = box.report(h.taskId);
      const st = await statusOf(srv, h.taskId);
      const list = await srv.callTool('list_workers', {}, 60_000);
      check('claude/no model reported: the header is exactly `[worker: wa, model: haiku]`', !r.isError && h.line1 === '[worker: wa, model: haiku]', r.text.split('\n').slice(0, 2));
      check('claude/no model reported: no `modelUsed` on any event, in the report, in dispatch_status or in list_workers', withUsed(events).length === 0 && !/model ran/.test(report) && !Object.hasOwn(st, 'modelUsed') && !/last ran as/.test(list.text), { events: describe(events), header: headerOf(report), st, list: clip(list.text, 200) });
      check('claude/no model reported: every event still says where the model came from (`worker`), and so do the report and dispatch_status', events.length >= 3 && sources(events).every((s) => s === 'worker') && /\n- model: haiku\n- model source: worker default\n/.test(report) && st.modelSource === 'worker', { events: describe(events), header: headerOf(report), st });
    }
    // 2 — no `model` in the dispatch: the worker's default applies, and the CLI says what ran.
    let defaultTask;
    {
      const r = await box.dispatch('m-default', 'ok', { worker: 'wa' });
      const h = parseResult(r.text);
      defaultTask = h.taskId;
      const run = box.run('m-default');
      const events = fx.eventsFor('m-default');
      const done = events.filter((e) => e.status === 'done');
      const report = box.report(h.taskId);
      const st = await statusOf(srv, h.taskId);
      check('claude/worker default: the CLI is started with `--model haiku`', run?.model === 'haiku' && run?.account === 'wa', run);
      check(`claude/worker default: the first line is \`[worker: wa, model: haiku → ${RESOLVED.haiku}]\``, !r.isError && h.line1 === `[worker: wa, model: haiku → ${RESOLVED.haiku}]`, r.text.split('\n').slice(0, 2));
      check('claude/worker default: …and nothing else of the result moved — `task: <id> · output: <file>`, a blank line, the text', /^t[a-z0-9]+$/.test(h.taskId ?? '') && h.outputFile === path.join(fx.tasksDir, `${h.taskId}.md`) && h.lines[2] === '' && h.lines[3] === 'FAKE_OK m-default' && h.lines.length === 4, h.lines);
      check('claude/worker default: every event carries `modelSource: "worker"`, the running ones included', events.length >= 3 && sources(events).every((s) => s === 'worker'), describe(events));
      check(`claude/worker default: the terminal event, and only it, carries \`modelUsed: "${RESOLVED.haiku}"\` — beside \`model: "haiku"\``, done.length === 1 && done[0].modelUsed === RESOLVED.haiku && done[0].model === 'haiku' && withUsed(events).length === 1, describe(events));
      check('claude/worker default: the report header has `- model ran:` and `- model source:` directly under `- model:`', headerOf(report).includes(`\n- worker: wa\n- model: haiku\n- model ran: ${RESOLVED.haiku}\n- model source: worker default\n- tokens: `), headerOf(report));
      check('claude/worker default: dispatch_status reports both fields', st.modelUsed === RESOLVED.haiku && st.modelSource === 'worker' && st.model === 'haiku' && st.status === 'done', st);
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineA = list.text.split('\n').find((l) => l.startsWith('- wa'));
      const lineB = list.text.split('\n').find((l) => l.startsWith('- wb'));
      check(`claude/worker default: list_workers says \`default model haiku (last ran as ${RESOLVED.haiku})\``, lineA !== undefined && lineA.startsWith(`- wa: default model haiku (last ran as ${RESOLVED.haiku}) — `), lineA);
      check('claude/worker default: …and nothing for a worker whose default has not run', lineB !== undefined && lineB.startsWith('- wb: default model sonnet — '), lineB);
    }
    // 3 — the dispatch names a model.
    {
      const r = await box.dispatch('m-named', 'ok', { worker: 'wa', model: 'opus' });
      const h = parseResult(r.text);
      const events = fx.eventsFor('m-named');
      const report = box.report(h.taskId);
      const st = await statusOf(srv, h.taskId);
      check('claude/named: `model: "opus"` → `--model opus`, and the first line names what it ran as', box.run('m-named')?.model === 'opus' && h.line1 === `[worker: wa, model: opus → ${RESOLVED.opus}]`, { run: box.run('m-named')?.model, line1: h.line1 });
      check('claude/named: every event carries `modelSource: "dispatch"`; the terminal one `modelUsed`', events.length >= 3 && sources(events).every((s) => s === 'dispatch') && events.at(-1).modelUsed === RESOLVED.opus && withUsed(events).length === 1, describe(events));
      check('claude/named: the report says `- model source: dispatch`; dispatch_status reports both', headerOf(report).includes(`\n- model: opus\n- model ran: ${RESOLVED.opus}\n- model source: dispatch\n`) && st.modelUsed === RESOLVED.opus && st.modelSource === 'dispatch', { header: headerOf(report), st });
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineA = list.text.split('\n').find((l) => l.startsWith('- wa'));
      check('claude/named: a run on a model the dispatch named does not change what the DEFAULT last ran as', lineA !== undefined && lineA.startsWith(`- wa: default model haiku (last ran as ${RESOLVED.haiku}) — `), lineA);
    }
    // 4 — a full id that runs as itself: nothing to add to the line.
    {
      const r = await box.dispatch('m-fullid', 'ok', { worker: 'wa', model: 'claude-opus-5-5' });
      const h = parseResult(r.text);
      const events = fx.eventsFor('m-fullid');
      check('claude/full id: `model: "claude-opus-5-5"` that ran as itself → the line is exactly `[worker: wa, model: claude-opus-5-5]`, and the event still records what was reported', !r.isError && h.line1 === '[worker: wa, model: claude-opus-5-5]' && events.at(-1).modelUsed === 'claude-opus-5-5' && events.at(-1).modelSource === 'dispatch', { line1: h.line1, events: describe(events) });
    }
    // 4b — square brackets in what the CLI reports: the line's closing bracket is its LAST character.
    {
      const r = await box.dispatch('m-1m', 'usage:onem', { worker: 'wc' });
      const h = parseResult(r.text);
      const events = fx.eventsFor('m-1m');
      const report = box.report(h.taskId);
      const st = await statusOf(srv, h.taskId);
      const anchored = /^\[worker: (.*?), model: (.*?)(?:, provider: (.*?))?\]$/.exec(h.line1 ?? '');
      check('claude/`[1m]`: a requested `opus` that ran as `claude-opus-5-5[1m]` → `[worker: wc, model: opus → claude-opus-5-5[1m]]` (the line ends `[1m]]`)', !r.isError && h.line1 === '[worker: wc, model: opus → claude-opus-5-5[1m]]' && h.line1.endsWith('[1m]]') && box.run('m-1m')?.model === 'opus', h.line1);
      check('claude/`[1m]`: a reader anchored on the END of the line (the harnesses\' pattern) reads the worker and the whole model text', anchored?.[1] === 'wc' && anchored?.[2] === 'opus → claude-opus-5-5[1m]' && anchored?.[3] === undefined, anchored);
      check('claude/`[1m]`: the event, the report\'s `- model ran:` line and dispatch_status carry the id whole', events.at(-1).modelUsed === 'claude-opus-5-5[1m]' && headerOf(report).includes('\n- model: opus\n- model ran: claude-opus-5-5[1m]\n- model source: worker default\n') && st.modelUsed === 'claude-opus-5-5[1m]', { events: describe(events), header: headerOf(report), st });
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineC = list.text.split('\n').find((l) => l.startsWith('- wc'));
      check('claude/`[1m]`: list_workers shows it whole — `default model opus (last ran as claude-opus-5-5[1m])`', lineC !== undefined && lineC.startsWith('- wc: default model opus (last ran as claude-opus-5-5[1m]) — '), lineC);
      const r2 = await box.dispatch('m-1m-same', 'ok', { worker: 'wa', model: 'claude-opus-5-5[1m]' });
      check('claude/`[1m]`: a requested `claude-opus-5-5[1m]` that ran as itself → exactly `[worker: wa, model: claude-opus-5-5[1m]]`', !r2.isError && parseResult(r2.text).line1 === '[worker: wa, model: claude-opus-5-5[1m]]' && box.run('m-1m-same')?.model === 'claude-opus-5-5[1m]', r2.text.split('\n')[0]);
    }
    // 4c — a reported id that differs from the request only in letter case is still what the CLI said.
    {
      const r = await box.dispatch('m-case-id', 'usage:upper', { worker: 'wa', model: 'claude-opus-5-5' });
      const r2 = await box.dispatch('m-case-alias', 'usage:upperalias', { worker: 'wa', model: 'opus' });
      check('claude/letter case: requested `claude-opus-5-5`, reported `Claude-Opus-5-5` → `[worker: wa, model: claude-opus-5-5 → Claude-Opus-5-5]`; requested `opus`, reported `OPUS` → `[worker: wa, model: opus → OPUS]`', parseResult(r.text).line1 === '[worker: wa, model: claude-opus-5-5 → Claude-Opus-5-5]' && parseResult(r2.text).line1 === '[worker: wa, model: opus → OPUS]' && fx.eventsFor('m-case-id').at(-1).modelUsed === 'Claude-Opus-5-5', [r.text.split('\n')[0], r2.text.split('\n')[0]]);
    }
    // 4d — a Claude Code account whose entry stores NO model. It is never a "CLI default"
    // account: the registry reads a missing default as `opus`, so the worker is started with
    // `--model opus`, the source is `worker`, and "last ran as" follows the rule for a default.
    {
      const stored = JSON.parse(fs.readFileSync(path.join(fx.orchRoot, 'registry.json'), 'utf8')).workers.find((w) => w.name === 'wd');
      const r = await box.dispatch('m-nostored', 'ok', { worker: 'wd' });
      const events = fx.eventsFor('m-nostored');
      check('claude/no stored model: the entry has no `model`, yet the CLI is started with `--model opus` and every event says `modelSource: "worker"` (never `cli`)', stored !== undefined && !Object.hasOwn(stored, 'model') && !r.isError && box.run('m-nostored')?.model === 'opus' && events.length >= 3 && sources(events).every((s) => s === 'worker') && parseResult(r.text).line1 === `[worker: wd, model: opus → ${RESOLVED.opus}]`, { stored, run: box.run('m-nostored')?.model, events: describe(events), line1: r.text.split('\n')[0] });
      const lineOf = async () => (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- wd'));
      const line = await lineOf();
      check(`claude/no stored model: list_workers says \`default model opus (last ran as ${RESOLVED.opus})\``, line?.startsWith(`- wd: default model opus (last ran as ${RESOLVED.opus}) — `), line);
      fs.appendFileSync(path.join(fx.orchRoot, 'tasks.jsonl'), JSON.stringify({ id: 'tclisource1', ts: Date.now(), status: 'done', title: 'forged', worker: 'wd', model: '-', modelSource: 'cli', modelUsed: 'claude-from-a-cli-default-run', outputFile: '/nowhere' }) + '\n');
      const after = await lineOf();
      check('claude/no stored model: a newer log line claiming a `cli`-source run does not change it — an account WITH a default follows the default\'s rule', after === line, after);
    }
    // 4e — the MAIN model, not the dearest: the real document of a `haiku` run whose subagent ran
    // on sonnet (which cost more). On an account of its own, so that nothing else answers for it.
    {
      const r = await box.dispatch('m-subagent', 'doc:haiku-with-sonnet-subagent', { worker: 'we' });
      const h = parseResult(r.text);
      const events = fx.eventsFor('m-subagent');
      check(`main model: a \`haiku\` run whose subagent ran on sonnet → \`[worker: we, model: haiku → ${RESOLVED.haiku}]\` — not the subagent's model`, !r.isError && h.line1 === `[worker: we, model: haiku → ${RESOLVED.haiku}]` && events.at(-1).modelUsed === RESOLVED.haiku && box.run('m-subagent')?.model === 'haiku', { line1: h.line1, events: describe(events) });
      const lineOf = async () => (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- we'));
      const line = await lineOf();
      check(`main model: list_workers says that account's \`haiku\` last ran as ${RESOLVED.haiku}`, line?.startsWith(`- we: default model haiku (last ran as ${RESOLVED.haiku}) — `), line);
      const r2 = await box.dispatch('m-subagent-other', 'doc:subagents-other-family', { worker: 'we' });
      const r3 = await box.dispatch('m-no-stats', 'doc:no-subagent-stats', { worker: 'we' });
      check('main model: a run that started subagents and lists no entry of the asked family, and one whose document does not say whether it started any → the header is exactly `[worker: we, model: haiku]`, nothing recorded', !r2.isError && !r3.isError && parseResult(r2.text).line1 === '[worker: we, model: haiku]' && parseResult(r3.text).line1 === '[worker: we, model: haiku]' && withUsed([...fx.eventsFor('m-subagent-other'), ...fx.eventsFor('m-no-stats')]).length === 0, [r2.text.split('\n')[0], r3.text.split('\n')[0]]);
      const after = await lineOf();
      check('main model: …and what the default last ran as is still the run that reported it', after?.startsWith(`- we: default model haiku (last ran as ${RESOLVED.haiku}) — `), after);
    }
    // 5 — a run that failed has no model to report, whatever it printed.
    {
      const r = await box.dispatch('m-fail', 'fail', { worker: 'wa' });
      const events = fx.eventsFor('m-fail');
      const st = await statusOf(srv, events[0]?.id ?? 'tnone');
      check('claude/failed: the failure event names the model its attempt asked for — the worker\'s default `haiku`, as the running events do — and dispatch_status says the same (never `-` beside "worker default")', events.at(-1)?.status === 'error' && events.every((e) => e.model === 'haiku') && st.model === 'haiku' && st.modelSource === 'worker', { events: describe(events), st });
      check('claude/failed: a run that exits non-zero records no `modelUsed`; its events, the failure included, still carry `modelSource`', r.isError && events.at(-1)?.status === 'error' && withUsed(events).length === 0 && sources(events).every((s) => s === 'worker') && !Object.hasOwn(st, 'modelUsed') && st.modelSource === 'worker', { text: clip(r.text, 120), events: describe(events), st });
      const r2 = await box.dispatch('m-iserror', 'error-with-usage', { worker: 'wa' });
      const events2 = fx.eventsFor('m-iserror');
      check('claude/failed: an `is_error` result that carries a `modelUsage` records none either', r2.isError && events2.at(-1)?.status === 'error' && withUsed(events2).length === 0, { text: clip(r2.text, 120), events: describe(events2) });
    }
    // 6 — hostile `modelUsage` shapes, end to end: absent, the header unchanged, nothing thrown.
    for (const name of ['array', 'string', 'nul', 'proto', 'longkey', 'notobject', 'forged']) {
      const title = `m-usage-${name}`;
      const r = await box.dispatch(title, `usage:${name}`, { worker: 'wa' });
      const h = parseResult(r.text);
      const events = fx.eventsFor(title);
      const report = box.report(h.taskId);
      check(`claude/hostile \`modelUsage\` (${name}): the task succeeds, the header is exactly \`[worker: wa, model: haiku]\`, no \`modelUsed\` anywhere`, !r.isError && h.line1 === '[worker: wa, model: haiku]' && h.lines[3] === `FAKE_OK ${title}` && withUsed(events).length === 0 && !/model ran/.test(headerOf(report)), { text: clip(r.text, 160), events: describe(events) });
    }
    {
      const r = await box.dispatch('m-usage-strcost', 'usage:strcost', { worker: 'wa' });
      check('claude/hostile `modelUsage` (a cost of "1e9"): the entry with a real cost is the one reported', parseResult(r.text).line1 === '[worker: wa, model: haiku → claude-real-1]', r.text.split('\n')[0]);
      const r2 = await box.dispatch('m-usage-tie', 'usage:tie', { worker: 'wa' });
      check('claude/tie: two entries equal in cost and output → the first', parseResult(r2.text).line1 === '[worker: wa, model: haiku → claude-tie-a]', r2.text.split('\n')[0]);
    }
    // 7 — while it runs: the report says who chose the model, and claims nothing about what ran.
    {
      const call = srv.startTool('dispatch_task', { title: 'm-running', prompt: '[[fake:delay:2500]] [[tag:m-running]]', worker: 'wb' });
      await waitFor(() => box.run('m-running'), { label: 'the m-running worker to start' });
      const id = fx.eventsFor('m-running')[0]?.id;
      const report = box.report(id);
      const st = await statusOf(srv, id);
      check('claude/running: the RUNNING report has `- model source:` under `- model:` and no `- model ran:`; dispatch_status has the source and no `modelUsed`', /- status: RUNNING/.test(report) && headerOf(report).includes('\n- worker: wb\n- model: sonnet\n- model source: worker default') && !/model ran/.test(report) && st.status === 'running' && st.modelSource === 'worker' && !Object.hasOwn(st, 'modelUsed'), { header: headerOf(report), st });
      const a = await call.answer(60_000);
      check(`claude/running: …and once it finished, \`[worker: wb, model: sonnet → ${RESOLVED.sonnet}]\``, parseResult(a.text).line1 === `[worker: wb, model: sonnet → ${RESOLVED.sonnet}]`, a.text.split('\n')[0]);
    }
    // 8 — a cancelled task: the server authors the terminal event from the attempt's identity.
    {
      const call = srv.startTool('dispatch_task', { title: 'm-cancel', prompt: '[[fake:delay:20000]] [[tag:m-cancel]]', worker: 'wa' });
      await waitFor(() => box.run('m-cancel'), { label: 'the m-cancel worker to start' });
      srv.notify('notifications/cancelled', { requestId: call.id });
      const events = await waitFor(() => (fx.eventsFor('m-cancel').some((e) => e.status === 'error') ? fx.eventsFor('m-cancel') : undefined), { label: 'the cancelled event' });
      const last = events.at(-1);
      check('claude/cancelled: the event the server writes for a cancelled task carries the attempt\'s `modelSource`, and no `modelUsed`', /cancelled/.test(String(last.error)) && last.modelSource === 'worker' && withUsed(events).length === 0, describe(events));
    }
    // 9 — the newest finished task of the default wins, and a forged log line does not. By now
    // the newest real one is the tie row above: a default run that reported `claude-tie-a`.
    {
      const ranAs = (text) => /^- wa: default model haiku(?: \(last ran as ([^)]*)\))? — /m.exec(text)?.[1];
      const before = ranAs((await srv.callTool('list_workers', {}, 60_000)).text);
      check('list_workers: what the default last ran as follows the newest finished default task (here `claude-tie-a`)', before === 'claude-tie-a', before);
      fs.appendFileSync(
        path.join(fx.orchRoot, 'tasks.jsonl'),
        [
          { id: 'tforged1', ts: Date.now(), status: 'done', title: 'forged', worker: 'wa', model: 'haiku', modelUsed: 'claude-x\u001b[31m forged', outputFile: '/nowhere' },
          { id: 'tforged2', ts: Date.now(), status: 'done', title: 'forged', worker: 'wa', model: 'haiku', modelUsed: 'y'.repeat(500), outputFile: '/nowhere' },
          { id: 'tforged3', ts: Date.now(), status: 'done', title: 'forged', worker: 'wa', model: 'haiku', modelUsed: ['claude-opus-5-5'], modelSource: 'root', outputFile: '/nowhere' },
          { id: 'tforged4', ts: Date.now(), status: 'error', title: 'forged', worker: 'wa', model: 'haiku', modelUsed: 'claude-from-an-error', outputFile: '/nowhere' },
          { id: 'tforged5', ts: Date.now(), status: 'done', title: 'forged', worker: 'wa', model: 'opus', modelUsed: 'claude-not-the-default', outputFile: '/nowhere' },
          null,
          [1, 2],
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      );
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineA = list.text.split('\n').find((l) => l.startsWith('- wa'));
      check('list_workers: newer log lines whose `modelUsed` is not a model id, that are not `done`, or that ran another model change nothing', !list.isError && ranAs(list.text) === before && !/forged|yyyy|from-an-error|not-the-default/.test(list.text), lineA ?? list.text);
      const st3 = await statusOf(srv, 'tforged3');
      const st4 = await statusOf(srv, 'tforged4');
      check('dispatch_status: a forged record\'s `modelUsed` / `modelSource` are reported only when they are what the fields hold by value', !Object.hasOwn(st3, 'modelUsed') && !Object.hasOwn(st3, 'modelSource') && !Object.hasOwn(st4, 'modelUsed'), { st3, st4 });
      fs.appendFileSync(path.join(fx.orchRoot, 'tasks.jsonl'), JSON.stringify({ id: 'tnewer1', ts: Date.now(), status: 'done', title: 'newer', worker: 'wa', model: 'haiku', modelUsed: 'claude-haiku-9-9', outputFile: '/nowhere' }) + '\n');
      const list2 = await srv.callTool('list_workers', {}, 60_000);
      check('list_workers: the NEWEST `done` event of the default is the one shown', list2.text.split('\n').find((l) => l.startsWith('- wa'))?.includes('default model haiku (last ran as claude-haiku-9-9) — '), list2.text.split('\n').find((l) => l.startsWith('- wa')));
    }
    // 10 — a task log that cannot be read shows nothing extra, and does not fail the listing.
    {
      const logFile = path.join(fx.orchRoot, 'tasks.jsonl');
      const kept = `${logFile}.kept`;
      fs.renameSync(logFile, kept);
      fs.mkdirSync(logFile);
      const list = await srv.callTool('list_workers', {}, 60_000);
      fs.rmdirSync(logFile);
      fs.renameSync(kept, logFile);
      check('list_workers: an unreadable task log (a directory at its name) → the listing still answers, with no "last ran as"', !list.isError && /^- wa: default model haiku — /m.test(list.text) && !/last ran as/.test(list.text), clip(list.text, 240));
    }
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: detach — the supervisor runs the same core, and its text is relayed verbatim
 * ------------------------------------------------------------------------- */

async function sectionDetach() {
  await calm();
  const box = await claudeSandbox('detach', [{ name: 'wa', model: 'haiku' }]);
  const { fx, srv } = box;
  try {
    {
      const r = await box.dispatch('d-default', 'ok', { worker: 'wa', detach: true });
      const h = parseResult(r.text);
      const events = fx.eventsFor('d-default');
      const st = await statusOf(srv, h.taskId);
      const report = box.report(h.taskId);
      check(`detach: the relayed first line is \`[worker: wa, model: haiku → ${RESOLVED.haiku}]\``, !r.isError && h.line1 === `[worker: wa, model: haiku → ${RESOLVED.haiku}]` && box.run('d-default')?.model === 'haiku', r.text.split('\n').slice(0, 2));
      check('detach: every event — the supervisor\'s own stamps included — carries `modelSource: "worker"`; the terminal one `modelUsed`', events.length >= 4 && events.every((e) => typeof e.supervisorPid === 'number') && sources(events).every((s) => s === 'worker') && events.at(-1).status === 'done' && events.at(-1).modelUsed === RESOLVED.haiku && withUsed(events).length === 1, describe(events));
      check('detach: dispatch_status reports both fields, and the report has both lines', st.modelUsed === RESOLVED.haiku && st.modelSource === 'worker' && headerOf(report).includes(`\n- model: haiku\n- model ran: ${RESOLVED.haiku}\n- model source: worker default\n`), { st, header: headerOf(report) });
      check('detach: dispatch_status hands back the same first line (from the supervisor\'s record)', String(st.result).split('\n')[0] === h.line1, String(st.result).split('\n')[0]);
    }
    {
      const r = await box.dispatch('d-nomodel', 'nomodel', { worker: 'wa', detach: true, model: 'sonnet' });
      const events = fx.eventsFor('d-nomodel');
      check('detach: a CLI that reports no model → exactly `[worker: wa, model: sonnet]`, `modelSource: "dispatch"`, no `modelUsed`', !r.isError && parseResult(r.text).line1 === '[worker: wa, model: sonnet]' && sources(events).every((s) => s === 'dispatch') && withUsed(events).length === 0, { line1: r.text.split('\n')[0], events: describe(events) });
    }
    {
      const call = srv.startTool('dispatch_task', { title: 'd-cancel', prompt: '[[fake:delay:20000]] [[tag:d-cancel]]', worker: 'wa', detach: true });
      await waitFor(() => box.run('d-cancel'), { label: 'the d-cancel worker to start' });
      // The pid-carrying stamp is what the cancel signals; wait for it before cancelling.
      await waitFor(() => fx.eventsFor('d-cancel').some((e) => typeof e.pid === 'number'), { label: 'the pid event of d-cancel' });
      await sleep(150);
      srv.notify('notifications/cancelled', { requestId: call.id });
      const events = await waitFor(() => (fx.eventsFor('d-cancel').some((e) => e.status === 'error') ? fx.eventsFor('d-cancel') : undefined), { label: 'the cancelled event of d-cancel', timeoutMs: 30_000 });
      const last = events.at(-1);
      check('detach/cancelled: the event the supervisor writes for a cancelled task carries the attempt\'s `modelSource`, and no `modelUsed`', /cancelled/.test(String(last.error)) && last.modelSource === 'worker' && withUsed(events).length === 0, describe(events));
    }
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: vendor — a worker on another vendor's CLI
 * ------------------------------------------------------------------------- */

async function sectionVendor() {
  await calm();
  const fx = H.makeFixture({
    label: 'vendor',
    workspace: 'git',
    workers: [
      { name: 'wa' },
      { name: 'cx', provider: 'codex' },
      { name: 'cd', provider: 'codex', model: 'gpt-5.5' },
      { name: 'cu', provider: 'cursor' },
    ],
  });
  try {
    const srv = await fx.startServer();
    const report = (id) => {
      try {
        return fs.readFileSync(path.join(fx.tasksDir, `${id}.md`), 'utf8');
      } catch {
        return '';
      }
    };
    const lastRun = (vendor) => fx.runs(vendor).at(-1);
    const hasModelFlag = (run) => (run?.argv ?? []).some((a) => a === '--model' || a === '-m');

    // No default stored, and the CLI names the model it ran.
    {
      fx.setScenario({ codex: { run: { kind: 'ok', reportModel: 'gpt-5.6-terra' } } });
      const r = await srv.callTool('dispatch_task', { title: 'v-cli-reported', prompt: 'say ok', worker: 'cx' }, 90_000);
      const h = parseResult(r.text);
      const events = fx.eventsFor('v-cli-reported');
      const st = await statusOf(srv, h.taskId);
      const run = lastRun('codex');
      check('vendor/no default: no `--model` on the vendor argv', !r.isError && run !== undefined && !hasModelFlag(run) && run.parsed?.model === undefined, run?.argv);
      check('vendor/no default: every event carries `modelSource: "cli"`', events.length >= 3 && sources(events).every((s) => s === 'cli'), describe(events));
      check('vendor/no default, a model reported: the terminal event carries `modelUsed`, dispatch_status reports both', events.at(-1).status === 'done' && events.at(-1).modelUsed === 'gpt-5.6-terra' && withUsed(events).length === 1 && st.modelUsed === 'gpt-5.6-terra' && st.modelSource === 'cli' && st.provider === 'codex', { events: describe(events), st });
      check('vendor/no default, a model reported: the first line names it once (`[worker: cx, model: gpt-5.6-terra, provider: codex]`), the report has both lines above `- provider:`', h.line1 === '[worker: cx, model: gpt-5.6-terra, provider: codex]' && headerOf(report(h.taskId)).includes('\n- model: gpt-5.6-terra\n- model ran: gpt-5.6-terra\n- model source: CLI default\n- provider: codex'), { line1: h.line1, header: headerOf(report(h.taskId)) });
      const lineX = (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- cx'));
      check('vendor/list_workers: an account with NO default shows what the CLI\'s own default last ran as — `default model none (the codex CLI\'s own default) (last ran as gpt-5.6-terra)`', lineX?.startsWith("- cx [Codex]: default model none (the codex CLI's own default) (last ran as gpt-5.6-terra) — "), lineX);
    }
    // The same with square brackets in the id: under a vendor header the model text is followed
    // by `, provider: <id>]`, and the reported id is still shown whole.
    {
      fx.setScenario({ codex: { run: { kind: 'ok', reportModel: 'gpt-5.6-terra[1m]' } } });
      const r = await srv.callTool('dispatch_task', { title: 'v-cli-1m', prompt: 'say ok', worker: 'cx' }, 90_000);
      const h = parseResult(r.text);
      const events = fx.eventsFor('v-cli-1m');
      const anchored = /^\[worker: (.*?), model: (.*?)(?:, provider: (.*?))?\]$/.exec(h.line1 ?? '');
      check('vendor/`[1m]`: no model requested, `gpt-5.6-terra[1m]` reported → `[worker: cx, model: gpt-5.6-terra[1m], provider: codex]` — the id once, no arrow (never `- → …`)', !r.isError && h.line1 === '[worker: cx, model: gpt-5.6-terra[1m], provider: codex]' && events.at(-1).model === 'gpt-5.6-terra[1m]' && events.at(-1).modelUsed === 'gpt-5.6-terra[1m]' && events.at(-1).modelSource === 'cli', { line1: h.line1, events: describe(events) });
      check('vendor/`[1m]`: the end-anchored pattern reads worker, model and provider; the report carries the id whole', anchored?.[1] === 'cx' && anchored?.[2] === 'gpt-5.6-terra[1m]' && anchored?.[3] === 'codex' && headerOf(report(h.taskId)).includes('\n- model: gpt-5.6-terra[1m]\n- model ran: gpt-5.6-terra[1m]\n- model source: CLI default\n- provider: codex'), { anchored, header: headerOf(report(h.taskId)) });
    }
    // No default stored, and the CLI names none.
    {
      fx.setScenario({ codex: { run: 'ok' } });
      const r = await srv.callTool('dispatch_task', { title: 'v-cli-silent', prompt: 'say ok', worker: 'cx' }, 90_000);
      const h = parseResult(r.text);
      const events = fx.eventsFor('v-cli-silent');
      const st = await statusOf(srv, h.taskId);
      check('vendor/no default, nothing reported: exactly `[worker: cx, model: -, provider: codex]`, `modelSource: "cli"`, no `modelUsed` anywhere, no `--model`', !r.isError && h.line1 === '[worker: cx, model: -, provider: codex]' && sources(events).every((s) => s === 'cli') && withUsed(events).length === 0 && !Object.hasOwn(st, 'modelUsed') && st.modelSource === 'cli' && !/model ran/.test(headerOf(report(h.taskId))) && headerOf(report(h.taskId)).includes('\n- model: -\n- model source: CLI default\n- provider: codex') && !hasModelFlag(lastRun('codex')), { line1: h.line1, events: describe(events), st, header: headerOf(report(h.taskId)) });
    }
    // A stored default: asked for by name — and the adapter hands the request back as "what ran".
    {
      fx.setScenario({ codex: { run: { kind: 'ok', reportModel: 'gpt-5.6-terra' } } });
      const r = await srv.callTool('dispatch_task', { title: 'v-default', prompt: 'say ok', worker: 'cd' }, 90_000);
      const h = parseResult(r.text);
      const events = fx.eventsFor('v-default');
      const run = lastRun('codex');
      check('vendor/worker default: `--model gpt-5.5` on the argv, `modelSource: "worker"`, the header unchanged', !r.isError && run?.parsed?.model === 'gpt-5.5' && sources(events).every((s) => s === 'worker') && h.line1 === '[worker: cd, model: gpt-5.5, provider: codex]', { argv: run?.argv, events: describe(events), line1: h.line1 });
      check('vendor/worker default: the adapter returns the REQUESTED id as its `model` (even with another one in the CLI\'s stream) — that is not an observation, and no `modelUsed` is recorded', withUsed(events).length === 0 && !/model ran/.test(headerOf(report(h.taskId))), { events: describe(events), header: headerOf(report(h.taskId)) });
    }
    // The dispatch names a model.
    {
      fx.setScenario({ codex: { run: 'ok' } });
      const r = await srv.callTool('dispatch_task', { title: 'v-named', prompt: 'say ok', worker: 'cx', model: 'gpt-5.6-sol' }, 90_000);
      const events = fx.eventsFor('v-named');
      check('vendor/named: `model: "gpt-5.6-sol"` → `--model gpt-5.6-sol`, `modelSource: "dispatch"`', !r.isError && lastRun('codex')?.parsed?.model === 'gpt-5.6-sol' && sources(events).every((s) => s === 'dispatch') && parseResult(r.text).line1 === '[worker: cx, model: gpt-5.6-sol, provider: codex]', { events: describe(events), line1: r.text.split('\n')[0] });
      const lineX = (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- cx'));
      check('vendor/list_workers: after a later run that NAMED a model (and one where the CLI named none), the parenthesis still shows the newest CLI-default run that reported an id', lineX?.startsWith("- cx [Codex]: default model none (the codex CLI's own default) (last ran as gpt-5.6-terra[1m]) — "), lineX);
    }
    // Another vendor, no default: its adapter reports no model at all.
    {
      const r = await srv.callTool('dispatch_task', { title: 'v-cursor', prompt: 'say ok', worker: 'cu' }, 90_000);
      const events = fx.eventsFor('v-cursor');
      check('vendor/cursor, no default: `modelSource: "cli"`, no `--model`, `[worker: cu, model: -, provider: cursor]`, no `modelUsed`', !r.isError && sources(events).every((s) => s === 'cli') && !hasModelFlag(lastRun('cursor')) && parseResult(r.text).line1 === '[worker: cu, model: -, provider: cursor]' && withUsed(events).length === 0, { events: describe(events), line1: r.text.split('\n')[0], argv: lastRun('cursor')?.argv });
    }
    // A reported value that is not a model id.
    {
      fx.setScenario({ codex: { run: { kind: 'ok', reportModel: 'not a model id; rm -rf' } } });
      const r = await srv.callTool('dispatch_task', { title: 'v-hostile', prompt: 'say ok', worker: 'cx' }, 90_000);
      const events = fx.eventsFor('v-hostile');
      check('vendor/hostile report: a "model" that is not in the id shape is not recorded as `modelUsed`; the task still succeeds', !r.isError && events.at(-1)?.status === 'done' && withUsed(events).length === 0, { line1: r.text.split('\n')[0], events: describe(events) });
    }
    // A failed vendor run.
    {
      fx.setScenario({ codex: { run: 'error' } });
      const r = await srv.callTool('dispatch_task', { title: 'v-failed', prompt: 'say ok', worker: 'cd' }, 90_000);
      const events = fx.eventsFor('v-failed');
      check('vendor/failed: the failure event names the model its attempt asked for (`gpt-5.5`, the worker\'s default)', events.at(-1)?.status === 'error' && events.every((e) => e.model === 'gpt-5.5'), describe(events));
      check('vendor/failed: no `modelUsed`; the failure event carries `modelSource: "worker"`', r.isError && events.at(-1)?.status === 'error' && withUsed(events).length === 0 && sources(events).every((s) => s === 'worker'), describe(events));
    }
    {
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineX = list.text.split('\n').find((l) => l.startsWith('- cx'));
      const lineD = list.text.split('\n').find((l) => l.startsWith('- cd'));
      const lineU = list.text.split('\n').find((l) => l.startsWith('- cu'));
      check('vendor/list_workers: a default that only ever came back as the request shows no "last ran as"; neither does a no-default account whose CLI never named a model (Cursor)', !list.isError && lineD?.startsWith('- cd [Codex]: default model gpt-5.5 — ') && lineU?.startsWith("- cu [Cursor]: default model none (the cursor-agent CLI's own default) — "), { lineD, lineU });
      // Log lines any process could append: only a `done` event with `modelSource: "cli"` and a
      // well-formed `modelUsed` counts for an account with no default.
      const forged = (extra) => JSON.stringify({ id: `tforgedv${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), title: 'forged', worker: 'cx', provider: 'codex', outputFile: '/nowhere', ...extra }) + '\n';
      const logFile = path.join(fx.orchRoot, 'tasks.jsonl');
      fs.appendFileSync(logFile, forged({ status: 'done', model: '-', modelSource: 'cli', modelUsed: 'not a model id' }) + forged({ status: 'error', model: '-', modelSource: 'cli', modelUsed: 'gpt-from-an-error' }) + forged({ status: 'done', model: 'gpt-x', modelSource: 'dispatch', modelUsed: 'gpt-from-a-named-run' }) + forged({ status: 'done', model: 'gpt-y', modelUsed: 'gpt-with-no-source' }) + forged({ status: 'done', model: 'gpt-z', modelSource: 'worker', modelUsed: 'gpt-from-a-default-it-does-not-have' }));
      const still = (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- cx'));
      check('vendor/list_workers: newer log lines that are not a finished CLI-default run with a well-formed id change nothing', still === lineX && /\(last ran as gpt-5\.6-terra\[1m\]\)/.test(still ?? ''), { before: lineX, after: still });
      fs.appendFileSync(logFile, forged({ status: 'done', model: 'gpt-5.6-luna', modelSource: 'cli', modelUsed: 'gpt-5.6-luna' }));
      const newer = (await srv.callTool('list_workers', {}, 60_000)).text.split('\n').find((l) => l.startsWith('- cx'));
      check('vendor/list_workers: the NEWEST finished CLI-default run that reported an id is the one shown', newer?.includes("(the codex CLI's own default) (last ran as gpt-5.6-luna) — "), newer);
    }
    await srv.stop();
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: failover — each attempt has its own model and its own source
 * ------------------------------------------------------------------------- */

async function sectionFailover() {
  await calm();
  // Claude Code: two accounts with different defaults; the first one picked hits its plan limit.
  {
    const box = await claudeSandbox('failover', [{ name: 'wa', model: 'haiku' }, { name: 'wb', model: 'sonnet' }]);
    const { fx } = box;
    try {
      const r = await box.dispatch('f-claude', 'quota-once:f1');
      const h = parseResult(r.text);
      const events = fx.eventsFor('f-claude');
      const runs = box.runs().filter((x) => x.tag === 'f-claude');
      const defaults = { wa: 'haiku', wb: 'sonnet' };
      const first = runs[0]?.account;
      const second = runs[1]?.account;
      check('failover/claude: the first account hit its limit and the task ran again on the other', !r.isError && runs.length === 2 && first !== second && [first, second].sort().join() === 'wa,wb', runs.map((x) => `${x.account}:${x.model}`));
      check('failover/claude: each attempt was started with ITS account\'s default', runs[0]?.model === defaults[first] && runs[1]?.model === defaults[second], runs.map((x) => `${x.account}:${x.model}`));
      const ofFirst = events.filter((e) => e.worker === first);
      const ofSecond = events.filter((e) => e.worker === second);
      check('failover/claude: the events of each attempt carry its own model and `modelSource: "worker"` — the "failing over" note included', ofFirst.length >= 3 && ofSecond.length >= 3 && ofFirst.length + ofSecond.length === events.length && ofFirst.every((e) => e.model === defaults[first] && e.modelSource === 'worker') && ofSecond.every((e) => e.model === defaults[second] && e.modelSource === 'worker') && ofFirst.some((e) => /failing over/.test(String(e.error))), describe(events));
      check('failover/claude: `modelUsed` is on the terminal event alone, and is what the SECOND account\'s CLI reported (the failed run printed a `modelUsage` too)', withUsed(events).length === 1 && events.at(-1).status === 'done' && events.at(-1).worker === second && events.at(-1).modelUsed === RESOLVED[defaults[second]], describe(events));
      check('failover/claude: the first line names the account and the model that finished the task', h.line1 === `[worker: ${second}, model: ${defaults[second]} → ${RESOLVED[defaults[second]]}]`, h.line1);
    } finally {
      await fx.cleanup();
    }
  }
  // The same default on both accounts, resolved differently by each account's CLI (two CLI
  // versions): what is recorded and shown is what the account that FINISHED the task reported.
  {
    const ids = { wa: 'claude-opus-5-5', wb: 'claude-opus-6-0' };
    const box = await claudeSandbox('failoverid', [{ name: 'wa', model: 'opus' }, { name: 'wb', model: 'opus' }], {
      usageTable: { '@wa': { [ids.wa]: { costUSD: 0.2, outputTokens: 4 } }, '@wb': { [ids.wb]: { costUSD: 0.2, outputTokens: 4 } } },
    });
    const { fx, srv } = box;
    try {
      const r = await box.dispatch('f-ids', 'quota-once:f2');
      const h = parseResult(r.text);
      const events = fx.eventsFor('f-ids');
      const runs = box.runs().filter((x) => x.tag === 'f-ids');
      const first = runs[0]?.account;
      const second = runs[1]?.account;
      check('failover/ids: the retry ran on the other account, both asked for `opus`', !r.isError && runs.length === 2 && first !== second && runs.every((x) => x.model === 'opus'), runs.map((x) => `${x.account}:${x.model}`));
      check('failover/ids: the first line names the second account and the id ITS CLI reported', h.line1 === `[worker: ${second}, model: opus → ${ids[second]}]`, h.line1);
      check('failover/ids: the id the failed attempt\'s CLI printed is on no event, in no report line and not in the result', withUsed(events).length === 1 && events.at(-1).modelUsed === ids[second] && !JSON.stringify(events).includes(ids[first]) && !box.report(h.taskId).includes(ids[first]) && !r.text.includes(ids[first]), describe(events));
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lineOf = (name) => list.text.split('\n').find((l) => l.startsWith(`- ${name}`));
      check('failover/ids: list_workers shows what `opus` last ran as on the account that finished, and nothing for the one whose run failed', lineOf(second)?.includes(`default model opus (last ran as ${ids[second]}) — `) && lineOf(first)?.includes('default model opus — ') && !/last ran as/.test(lineOf(first) ?? ''), { first: lineOf(first), second: lineOf(second) });
    } finally {
      await fx.cleanup();
    }
  }
  // Another vendor: one account with a default, one without — the source differs per attempt.
  {
    const fx = H.makeFixture({
      label: 'failoverv',
      workspace: 'git',
      workers: [{ name: 'wa' }, { name: 'q1', provider: 'codex', model: 'gpt-5.5' }, { name: 'q2', provider: 'codex' }],
      scenario: { codex: { run: { sequence: ['quota', { kind: 'ok', reportModel: 'gpt-5.6-luna' }] } } },
    });
    try {
      const srv = await fx.startServer();
      const r = await srv.callTool('dispatch_task', { title: 'f-vendor', prompt: 'say ok', provider: 'codex' }, 90_000);
      const events = fx.eventsFor('f-vendor');
      const runs = fx.runs('codex');
      const expected = { q1: { source: 'worker', model: 'gpt-5.5' }, q2: { source: 'cli', model: undefined } };
      const order = [...new Set(events.map((e) => e.worker))];
      check('failover/vendor: the vendor\'s quota wall moved the task to the other account', !r.isError && runs.length === 2 && order.length === 2 && [...order].sort().join() === 'q1,q2', { order, runs: runs.length, text: clip(r.text, 160) });
      const wrong = events.filter((e) => e.modelSource !== expected[e.worker]?.source);
      check('failover/vendor: the account with a default is `worker`, the one without is `cli` — on every event of each attempt', events.length >= 5 && wrong.length === 0, describe(events));
      const byHome = Object.fromEntries(runs.map((run) => [run.homeKey, run.parsed?.model]));
      check('failover/vendor: `--model gpt-5.5` reached the account that has that default, and no `--model` the other', byHome['.codex-q1'] === 'gpt-5.5' && Object.hasOwn(byHome, '.codex-q2') && byHome['.codex-q2'] === undefined, byHome);
      const done = events.at(-1);
      const firstFailed = order[0];
      check('failover/vendor: the failed attempt recorded no `modelUsed`; the finishing one records what its CLI named only if it asked for nothing', withUsed(events.filter((e) => e.worker === firstFailed)).length === 0 && done.status === 'done' && (done.worker === 'q2' ? done.modelUsed === 'gpt-5.6-luna' : !Object.hasOwn(done, 'modelUsed')), describe(events));
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Section: session — a session worker's model, from its transcript
 * ------------------------------------------------------------------------- */

/** The model ids the session transcripts below name — shaped as the real CLI writes them. */
const MAIN_MODEL = 'claude-sonnet-4-5-20250929';
const SIDE_MODEL = 'claude-haiku-4-5-20251001';
/** The sentence rule 1 of the bootstrap prompt carries (contract-2.0-fixes §13.1 M-2). */
const RESULT_FILE_OUTRANKS_TASK =
  "The result file is not part of the task's work: a task that says not to create or modify files, or not to use tools, does not exempt it, and without it nothing you did reaches the orchestrator.";

/** A subagent's turn as the main transcript holds it: rows of another model, `isSidechain: true`. */
function sidechainRows(model = SIDE_MODEL) {
  return [
    { type: 'assistant', isSidechain: true, agentId: 'a0f1', message: { model, id: 'msg_side1', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_side1', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'user', isSidechain: true, agentId: 'a0f1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_side1', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, agentId: 'a0f1', message: { model, id: 'msg_side2', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'subagent done' }] } },
  ];
}

async function sectionSession() {
  await calm();
  const fx = H.makeFixture({ label: 'session', workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa', model: 'sonnet' }], claude: { bg: { default: 'result-done' } } });
  try {
    const srv = await fx.startServer();
    const r = await srv.callTool('dispatch_task', { title: 's-default', prompt: 'report done' }, 90_000);
    const h = parseResult(r.text);
    const events = fx.eventsFor('s-default');
    const ranAsSession = fx.claudeBgSpawns().length === 1;
    if (!check('session: the dispatch ran as a session worker (`--bg`) and finished', !r.isError && ranAsSession && events.at(-1)?.status === 'done', { text: clip(r.text, 200), bg: fx.claudeBgSpawns().length })) {
      return;
    }
    let report = '';
    try {
      report = fs.readFileSync(path.join(fx.tasksDir, `${h.taskId}.md`), 'utf8');
    } catch {
      report = '';
    }
    const st = await statusOf(srv, h.taskId);
    // This fake's default transcript has a user row and nothing else by the time the result
    // file exists: no assistant entry, so nothing says what ran.
    check('session: a transcript with no assistant entry → the first line is exactly `[worker: wa, model: sonnet]`', h.line1 === '[worker: wa, model: sonnet]', h.line1);
    check('session: …every event carries `modelSource: "worker"` and none carries `modelUsed`', events.length >= 3 && sources(events).every((s) => s === 'worker') && withUsed(events).length === 0, describe(events));
    check('session: …the report says who chose the model and nothing about what ran; dispatch_status likewise', headerOf(report).includes('\n- worker: wa\n- model: sonnet\n- model source: worker default\n- mesh: session worker ') && !/model ran/.test(headerOf(report)) && st.modelSource === 'worker' && !Object.hasOwn(st, 'modelUsed'), { header: headerOf(report), st });
    const spawn0 = fx.claudeBgSpawns()[0];
    check('session: the bootstrap prompt the worker was handed says, in rule 1, that the result file outranks a task\'s "no files / no tools" — and the result path is still read off the prompt', typeof spawn0?.parsed?.prompt === 'string' && spawn0.parsed.prompt.includes(`1. The RESULT FILE is how your work is collected — nothing else is. ${RESULT_FILE_OUTRANKS_TASK} On completion,`) && spawn0.promptInfo?.from?.resultFile === 'prompt', { from: spawn0?.promptInfo?.from, rule1: clip(String(spawn0?.parsed?.prompt ?? '').split('\n').find((l) => l.startsWith('1. ')) ?? '', 400) });
    const r2 = await srv.callTool('dispatch_task', { title: 's-named', prompt: 'report done', model: 'opus' }, 90_000);
    const events2 = fx.eventsFor('s-named');
    check('session: a model the dispatch named → `modelSource: "dispatch"` on every event', !r2.isError && parseResult(r2.text).line1 === '[worker: wa, model: opus]' && events2.length >= 3 && sources(events2).every((s) => s === 'dispatch') && withUsed(events2).length === 0, describe(events2));
    const list = await srv.callTool('list_workers', {}, 60_000);
    check('session: a default whose session transcripts named no model has no "last ran as"', /^- wa: default model sonnet — /m.test(list.text), list.text.split('\n').find((l) => l.startsWith('- wa')));

    /** One dispatch whose worker's transcript is shaped by `knobs` (fake-claude2 transcriptBeforeResult). */
    const dispatchWith = async (title, knobs, args = {}) => {
      // The worker's turn ends long after it has reported, so the transcript is read with the
      // rows below as its last ones.
      fx.setClaudeScenario({ bg: { default: { kind: 'result-done', parkDelayMs: 20_000, ...knobs } } });
      const r = await srv.callTool('dispatch_task', { title, prompt: 'report done', ...args }, 120_000);
      const head = parseResult(r.text);
      let rep = '';
      try {
        rep = fs.readFileSync(path.join(fx.tasksDir, `${head.taskId}.md`), 'utf8');
      } catch {
        rep = '';
      }
      return { r, head, events: fx.eventsFor(title), report: rep, st: head.taskId === undefined ? {} : await statusOf(srv, head.taskId) };
    };

    // The real shape: the main thread's rows, then a subagent's rows of ANOTHER model last.
    {
      const d = await dispatchWith('s-transcript', { transcriptModel: MAIN_MODEL, transcriptRows: sidechainRows() });
      check(`session: the main thread ran ${MAIN_MODEL} and a subagent ${SIDE_MODEL} after it (the transcript's last rows) → the first line is \`[worker: wa, model: sonnet → ${MAIN_MODEL}]\``, !d.r.isError && d.head.line1 === `[worker: wa, model: sonnet → ${MAIN_MODEL}]`, { line1: d.head.line1, text: clip(d.r.text, 200) });
      check('session: …the terminal `done` event carries that `modelUsed`, and no `running` event carries one', d.events.at(-1)?.status === 'done' && d.events.at(-1)?.modelUsed === MAIN_MODEL && withUsed(d.events).length === 1, describe(d.events));
      check(`session: …the report says \`- model ran: ${MAIN_MODEL}\` under \`- model: sonnet\`, and dispatch_status reports it`, headerOf(d.report).includes(`\n- model: sonnet\n- model ran: ${MAIN_MODEL}\n- model source: worker default\n- mesh: session worker `) && d.st.modelUsed === MAIN_MODEL && d.st.modelSource === 'worker', { header: headerOf(d.report), st: d.st });
      const after = await srv.callTool('list_workers', {}, 60_000);
      const line = after.text.split('\n').find((l) => l.startsWith('- wa'));
      check(`session: …and list_workers now says \`default model sonnet (last ran as ${MAIN_MODEL})\` — the shared ranAs rule, as for one-shot`, line?.startsWith(`- wa: default model sonnet (last ran as ${MAIN_MODEL}) — `), line);
    }
    // 50 MiB of rows before the main thread's last assistant row.
    {
      const d = await dispatchWith('s-transcript-50m', { transcriptModel: 'claude-sonnet-4-6', transcriptPadBytes: 50 * 1024 * 1024, transcriptRows: sidechainRows() });
      const job = fx.claudeJobs().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).at(-1);
      let size = 0;
      try {
        const projects = path.join(fx.worker('wa').configDir, 'projects');
        for (const dir of fs.readdirSync(projects)) {
          const file = path.join(projects, dir, `${job.sessionId}.jsonl`);
          if (fs.existsSync(file)) size = fs.statSync(file).size;
        }
      } catch {
        size = -1;
      }
      check('session: a 50 MiB transcript with the main thread\'s last assistant row near its end → that row\'s model is the task\'s `modelUsed`', size > 50 * 1024 * 1024 && d.events.at(-1)?.modelUsed === 'claude-sonnet-4-6' && d.head.line1 === '[worker: wa, model: sonnet → claude-sonnet-4-6]', { size, events: describe(d.events), line1: d.head.line1 });
    }
    // A torn last line: an assistant row of another model, cut mid-write.
    {
      const d = await dispatchWith('s-transcript-torn', { transcriptModel: MAIN_MODEL, transcriptRows: ['{"type":"assistant","isSidechain":false,"message":{"model":"claude-opus-5-5","role":"assist'] });
      check('session: a torn last line (an assistant row cut mid-write) is skipped — the last WHOLE main-thread row names the model', d.events.at(-1)?.modelUsed === MAIN_MODEL && d.head.line1 === `[worker: wa, model: sonnet → ${MAIN_MODEL}]`, { events: describe(d.events), line1: d.head.line1 });
    }
    // A hostile `model` on the main thread's assistant rows.
    {
      const d = await dispatchWith('s-transcript-hostile', { transcriptModel: 'claude-opus\u001b[2J\u001b[31m-red' });
      check('session: a `model` that is not of the reported-id shape (control characters) → no `modelUsed`, no arrow, no `- model ran:` line, nothing in dispatch_status', d.events.at(-1)?.status === 'done' && withUsed(d.events).length === 0 && d.head.line1 === '[worker: wa, model: sonnet]' && !/model ran/.test(headerOf(d.report)) && !Object.hasOwn(d.st, 'modelUsed'), { events: describe(d.events), line1: d.head.line1, header: headerOf(d.report) });
    }
    await srv.stop();
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: transcript — mesh/transcript.sessionModelOf, on transcripts written here
 * ------------------------------------------------------------------------- */

/**
 * The rows of a real session transcript, in the order a worker's run left them (entry types and
 * fields as the CLI writes them; texts are made up): bookkeeping rows, the task's user row,
 * attachments, the main thread's assistant rows (thinking, text, tool_use; end_turn last), a
 * tool result, then the turn-end bookkeeping.
 */
function realTranscriptRows(sessionId, model) {
  const common = { parentUuid: null, isSidechain: false, sessionKind: 'bg', userType: 'external', entrypoint: 'cli', cwd: '/w', sessionId, version: '2.1.299', gitBranch: 'cco-t1' };
  const at = (n) => ({ uuid: `u-${n}`, timestamp: new Date(1_791_000_000_000 + n * 1000).toISOString() });
  const assistant = (n, block, stop) => ({ ...common, ...at(n), type: 'assistant', requestId: `req_${n}`, message: { model, id: `msg_${n}`, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } });
  return [
    { type: 'custom-title', customTitle: 'cco-t1', sessionId },
    { type: 'agent-name', agentName: 'cco-t1', sessionId },
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId },
    { type: 'worktree-state', worktreeSession: { name: 'cco-t1' }, sessionId },
    { type: 'file-history-snapshot', messageId: 'm0', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
    { ...common, ...at(1), type: 'user', message: { role: 'user', content: 'read the task file' } },
    { ...common, ...at(2), type: 'attachment', attachment: { type: 'skill_listing', content: 'a'.repeat(2000) } },
    { type: 'last-prompt', lastPrompt: 'read the task file', leafUuid: 'u-2', sessionId },
    { type: 'atis-latch', atis: true, sessionId },
    assistant(3, { type: 'thinking', thinking: '', signature: 's' }, 'tool_use'),
    assistant(4, { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/io/result.json' } }, 'tool_use'),
    { ...common, ...at(5), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'written' }] }, toolUseResult: {} },
    { type: 'file-history-delta', messageId: 'm1', snapshotMessageId: 'm0', trackingPath: 'x', backup: null, timestamp: new Date().toISOString() },
    assistant(6, { type: 'text', text: 'done' }, 'end_turn'),
    { ...common, ...at(7), type: 'system', subtype: 'turn_duration', durationMs: 900, messageCount: 9, isMeta: true },
    { type: 'last-prompt', lastPrompt: 'read the task file', leafUuid: 'u-6', sessionId },
    { type: 'cost-state', sessionId, totalCostUSD: 0.01, modelUsage: { [SIDE_MODEL]: { inputTokens: 1 }, [model]: { inputTokens: 2 } }, hasUnknownModelCost: false },
  ];
}

async function sectionTranscript(core) {
  const T = core.transcript;
  const root = path.join(BASE, 'transcripts');
  let n = 0;
  /** A config dir holding one transcript made of `rows` (objects are rows, strings are written as given). */
  const make = (rows, { sessionId = randomUUID(), slug = '-w-ws--claude-worktrees-cco-t1' } = {}) => {
    const configDir = path.join(root, `c${++n}`);
    const dir = path.join(configDir, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    const fd = fs.openSync(file, 'w');
    for (const row of rows) fs.writeSync(fd, typeof row === 'string' ? row : `${JSON.stringify(row)}\n`);
    fs.closeSync(fd);
    return { configDir, jobId: sessionId.slice(0, 8), sessionId, file };
  };
  const ask = (t) => T.sessionModelOf(t.configDir, t.jobId);
  const countHome = path.join(BASE, 'home-transcript');
  fs.mkdirSync(countHome, { recursive: true });
  const counted = (t) => readerRun([READER_DRIVER, 'transcript', CORE_CJS, t.configDir, t.jobId], countHome);
  const sid = () => randomUUID();
  const pad = (bytes) => ({ type: 'attachment', isSidechain: false, attachment: { type: 'pad', content: 'p'.repeat(bytes) } });

  // The real shape, then a subagent's rows of another model after the main thread's.
  {
    const s = sid();
    const t = make([...realTranscriptRows(s, MAIN_MODEL), ...sidechainRows()], { sessionId: s });
    check(`transcript: a real-shaped transcript whose LAST assistant rows are a subagent's (\`isSidechain: true\`, ${SIDE_MODEL}) → the main thread's model, ${MAIN_MODEL}`, ask(t) === MAIN_MODEL, ask(t));
    const only = make([...realTranscriptRows(sid(), MAIN_MODEL).filter((r) => r.type !== 'assistant'), ...sidechainRows()]);
    check('transcript: …a transcript whose only assistant rows are a subagent\'s → nothing (a sidechain is never taken)', ask(only) === undefined, ask(only));
    const none = make(realTranscriptRows(sid(), MAIN_MODEL).filter((r) => r.type !== 'assistant'));
    check('transcript: …and one with no assistant row at all → nothing', ask(none) === undefined, ask(none));
  }
  // A torn last line, and an unterminated one that is whole.
  {
    const torn = make([...realTranscriptRows(sid(), MAIN_MODEL), '{"type":"assistant","isSidechain":false,"message":{"model":"claude-opus-5-5","ro']);
    check('transcript: a torn last line (an assistant row of another model, cut mid-write) is skipped → the last whole main-thread row\'s model', ask(torn) === MAIN_MODEL, ask(torn));
    const whole = make([...realTranscriptRows(sid(), MAIN_MODEL), JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', role: 'assistant' } })]);
    check('transcript: …a last line that is a whole row without its line feed is that row', ask(whole) === 'claude-opus-5-5', ask(whole));
  }
  // A `model` of another shape on the last main-thread row: nothing — never the row before it.
  {
    const hostile = [
      ['control characters', 'claude-opus\u001b[2J'],
      ['a newline', 'claude-opus\nsecond line'],
      ['65 characters', `c${'x'.repeat(64)}`],
      ['a path', '../../etc/passwd'],
      ['empty', ''],
      ['a number', 42],
      ['null', null],
      ['an object', { id: MAIN_MODEL }],
    ];
    const got = hostile.map(([what, model]) => [what, ask(make([...realTranscriptRows(sid(), MAIN_MODEL), { type: 'assistant', isSidechain: false, message: { model, role: 'assistant', stop_reason: 'end_turn', content: [] } }]))]);
    const noModel = ask(make([...realTranscriptRows(sid(), MAIN_MODEL), { type: 'assistant', isSidechain: false, message: { role: 'assistant' } }]));
    const noMessage = ask(make([...realTranscriptRows(sid(), MAIN_MODEL), { type: 'assistant', isSidechain: false, message: 'claude-opus-5-5' }]));
    check('transcript: a last main-thread row whose `model` is not a reported id (control characters, a newline, 65 characters, a path, empty, a number, null, an object), has none, or has no message object → nothing — the valid row before it is NOT taken', got.every(([, v]) => v === undefined) && noModel === undefined && noMessage === undefined, { got, noModel, noMessage });
    const escaped = ask(make([...realTranscriptRows(sid(), SIDE_MODEL), '{"type":"\\u0061ssistant","isSidechain":false,"message":{"model":"claude-opus-5-5"}}\n']));
    check('transcript: …a row whose `type` is spelled through a \\u escape is still an assistant row', escaped === 'claude-opus-5-5', escaped);
  }
  // From the end, and at most the last 512 KiB.
  {
    const s = sid();
    const big = make([...Array.from({ length: 800 }, () => pad(64 * 1024)), ...realTranscriptRows(s, MAIN_MODEL), ...sidechainRows()], { sessionId: s });
    const size = fs.statSync(big.file).size;
    const r = await counted(big);
    console.log(`  transcript: 50 MiB (${size} bytes) → ${JSON.stringify(r)}`);
    check('transcript: a 50 MiB transcript, the main thread\'s last row near its end → its model, reading less than 512 KiB of it, and never the whole file', size > 50 * 1024 * 1024 && r.model === MAIN_MODEL && r.bytesRead <= 512 * 1024 && r.wholeReads === 0, { size, ...r });
    const beyond = make([...realTranscriptRows(sid(), MAIN_MODEL), ...Array.from({ length: 10 }, () => pad(64 * 1024))]);
    const rb = await counted(beyond);
    console.log(`  transcript: main row past the window → ${JSON.stringify(rb)}`);
    check('transcript: …a main-thread row more than 512 KiB from the end → nothing, and still no more than 512 KiB read', rb.model === null && rb.bytesRead <= 512 * 1024 && rb.wholeReads === 0, rb);
    // A main-thread row that begins before the window and ends inside it: never read from its middle.
    const straddle = make([{ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } }, pad(300 * 1024)]);
    check('transcript: …a main-thread row that begins before the 512 KiB window is not read from its middle → nothing', ask(straddle) === undefined, ask(straddle));
    const small = make([{ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', role: 'assistant' } }, pad(1000)]);
    check('transcript: …while in a transcript smaller than the window its first line is read like any other', ask(small) === 'claude-opus-5-5', ask(small));
  }
  // What cannot be read, or is not exactly one transcript: nothing, at once.
  {
    const good = make(realTranscriptRows(sid(), MAIN_MODEL));
    const cases = [];
    const fifo = make([]);
    fs.rmSync(fifo.file);
    spawnSync('mkfifo', [fifo.file]);
    let t0 = Date.now();
    cases.push(['a FIFO with no writer', ask(fifo), Date.now() - t0]);
    const dir = make([]);
    fs.rmSync(dir.file);
    fs.mkdirSync(dir.file);
    cases.push(['a directory', ask(dir)]);
    const link = make([]);
    fs.rmSync(link.file);
    fs.symlinkSync(good.file, link.file);
    cases.push(['a symbolic link to a good transcript', ask(link)]);
    const locked = make(realTranscriptRows(sid(), MAIN_MODEL));
    fs.chmodSync(locked.file, 0o000);
    cases.push(['mode 000', process.getuid?.() === 0 ? undefined : ask(locked)]);
    fs.chmodSync(locked.file, 0o600);
    const empty = make([]);
    cases.push(['empty', ask(empty)]);
    const twin = make(realTranscriptRows(sid(), MAIN_MODEL));
    fs.mkdirSync(path.join(twin.configDir, 'projects', 'other'), { recursive: true });
    fs.copyFileSync(twin.file, path.join(twin.configDir, 'projects', 'other', `${twin.jobId}-ffff-4fff-8fff-ffffffffffff.jsonl`));
    cases.push(['two transcripts for the job id', ask(twin)]);
    cases.push(['no projects directory', T.sessionModelOf(path.join(root, 'nothing-here'), good.jobId)]);
    cases.push(['a relative config dir', T.sessionModelOf(path.relative(process.cwd(), good.configDir), good.jobId)]);
    cases.push(['a job id that is not one', T.sessionModelOf(good.configDir, '')]);
    cases.push(['a job id with a separator', T.sessionModelOf(good.configDir, `${good.jobId}/..`)]);
    check('transcript: a transcript that cannot be read, or not exactly one — a FIFO (answered at once), a directory, a symbolic link, mode 000, an empty file, two matches, no projects directory, a relative config dir, a job id that is not one — → nothing; the same config dir\'s good transcript still answers', cases.every(([, v]) => v === undefined) && cases[0][2] < 1000 && ask(good) === MAIN_MODEL, cases);
  }
  // The bootstrap prompt (M-2), from the product's own builder.
  {
    const prompt = core.contract.bgDispatchBootstrapPrompt({ workerName: 'cco-t1', taskId: 'tbootstrap1', cwd: path.join(BASE, 'ws') });
    const lines = prompt.split('\n');
    const from = lines.findIndex((l) => l.startsWith('1. The RESULT FILE'));
    const to = lines.findIndex((l) => l.startsWith('2. Writing the result file'));
    const rule1 = from === -1 || to === -1 ? '' : lines.slice(from, to).join('\n');
    check('transcript: the bootstrap prompt\'s rule 1 says the result file is not part of the task\'s work — a task\'s "no files / no tools" does not exempt it — right after its first sentence', rule1.startsWith(`1. The RESULT FILE is how your work is collected — nothing else is. ${RESULT_FILE_OUTRANKS_TASK} On completion, and equally on failure`), clip(rule1, 500));
  }
}

/* ------------------------------------------------------------------------- *
 * Section: list — the names of usage windows
 * ------------------------------------------------------------------------- */

async function sectionList() {
  await calm();
  const windows = (primary, secondary) => ({ allowed: primary < 100, primary_window: { used_percent: primary, resets_at: 1893456000 }, secondary_window: { used_percent: secondary, resets_at: 1893456000 } });
  {
    const fx = H.makeFixture({ label: 'labels', workspace: 'git', workers: [{ name: 'wa' }, { name: 'cq', provider: 'codex', auth: 'chatgpt-quota' }], net: { mode: 'deny' } });
    try {
      fx.setNet({ mode: 'snapshot', body: windows(42, 7) }, { expectBearer: H.SECRETS.accessToken });
      const srv = await fx.startServer();
      const list = await srv.callTool('list_workers', {}, 90_000);
      const at = list.text.split('\n').findIndex((l) => l.startsWith('- cq'));
      const usage = at === -1 ? '' : list.text.split('\n')[at + 1];
      check('list_workers: a Codex account\'s windows read `Primary limit` / `Secondary limit`', !list.isError && /usage: Primary limit 42% \(resets [^)]+\) · Secondary limit 7% \(resets [^)]+\)/.test(usage), usage || clip(list.text, 300));
      check('list_workers: …and the adapter\'s bare `primary` / `secondary` are not printed', !/\bprimary \d|\bsecondary \d/.test(list.text), usage);
      check('list_workers: a Claude Code account\'s windows keep their own names', /usage: Session \(5hr\) 5% .* · Weekly \(7 day\) 5% /.test(list.text), list.text.split('\n').find((l) => /Session \(5hr\)/.test(l)));
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
  {
    const fx = H.makeFixture({ label: 'labelsfull', workspace: 'git', workers: [{ name: 'wa' }, { name: 'cq', provider: 'codex', auth: 'chatgpt-quota' }], net: { mode: 'deny' } });
    try {
      fx.setNet({ mode: 'snapshot', body: windows(100, 7) }, { expectBearer: H.SECRETS.accessToken });
      const srv = await fx.startServer();
      const list = await srv.callTool('list_workers', {}, 90_000);
      check('list_workers: an exhausted window is named the same way on the ⛔ line', /⛔ quota exhausted: Primary limit 100% \(resets /.test(list.text), list.text.split('\n').find((l) => /⛔/.test(l)) ?? clip(list.text, 300));
      const r = await srv.callTool('dispatch_task', { title: 'l-exhausted', prompt: 'say ok', worker: 'cq' }, 60_000);
      check('dispatch: …and in the refusal of a dispatch naming that worker', r.isError && /per live plan usage: Primary limit 100% \(resets /.test(r.text) && fx.runs('codex').length === 0, clip(r.text, 240));
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Section: frontier — the billing guard and dispatches that name no model; what a failure names
 * ------------------------------------------------------------------------- */

async function sectionFrontier() {
  await calm();
  const MARK = 'is on the frontier tier, which the frontier guard blocks';
  /** What a failed tool call said: the server puts `Error: ` in front of the dispatch's message. */
  const said = (r) => r.text.replace(/^Error: /, '');
  // One account's default is on the blocked tier, another's is not.
  {
    const box = await claudeSandbox('frontier', [{ name: 'wa', model: 'fable' }, { name: 'wb', model: 'opus' }]);
    const { fx, srv } = box;
    try {
      const firsts = [];
      for (let i = 0; i < 4; i++) {
        const r = await box.dispatch(`fr-auto-${i}`, 'ok');
        firsts.push(`${r.isError ? 'ERROR ' : ''}${r.text.split('\n')[0]}`);
      }
      check('frontier: four dispatches that name no model all run on the account whose default is not blocked — none is refused, none reaches the blocked one', firsts.every((l) => l === `[worker: wb, model: opus → ${RESOLVED.opus}]`) && box.runs().length === 4 && box.runs().every((r) => r.account === 'wb'), firsts);
      const list = await srv.callTool('list_workers', {}, 60_000);
      const lines = list.text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('- wa'));
      const next = lines.findIndex((l, i) => i > at && (l.startsWith('- ') || l === ''));
      const waBlock = lines.slice(at, next === -1 ? undefined : next);
      check('frontier: list_workers says of the blocked-default account that dispatches naming no model skip it — and of no other account', waBlock.some((l) => l === `  ⛔ default model fable ${MARK} — dispatches that name no model skip this worker; one that names a model off that tier runs here`) && lines.filter((l) => l.includes(MARK)).length === 1, waBlock);
      const before = fx.events().length;
      const named = await box.dispatch('fr-named-worker', 'ok', { worker: 'wa' });
      check('frontier: naming that WORKER and no model is refused with the message it always had, and leaves no trace', named.isError && said(named).startsWith('Dispatch blocked: the default model of worker "wa" is on the frontier tier (fable)') && fx.events().length === before && box.run('fr-named-worker') === undefined, clip(named.text, 220));
      const model = await box.dispatch('fr-named-model', 'ok', { model: 'fable' });
      check('frontier: naming the frontier MODEL is refused as before, whichever account it would land on', model.isError && said(model).startsWith('Dispatch blocked: the requested model is on the frontier tier (fable)') && fx.events().length === before, clip(model.text, 220));
      const off = await box.dispatch('fr-other-model', 'ok', { worker: 'wa', model: 'sonnet' });
      check('frontier: a dispatch that names a model off the tier runs on the blocked-default account', !off.isError && parseResult(off.text).line1 === `[worker: wa, model: sonnet → ${RESOLVED.sonnet}]`, off.text.split('\n')[0]);
    } finally {
      await fx.cleanup();
    }
  }
  // Every account's default is blocked.
  {
    const box = await claudeSandbox('frontierall', [{ name: 'wa', model: 'fable' }, { name: 'wc', model: 'claude-mythos-1' }]);
    const { fx, srv } = box;
    try {
      const r = await box.dispatch('fr-none', 'ok');
      const expected =
        `No eligible worker: default model fable ${MARK} — wa; default model claude-mythos-1 ${MARK} — wc. ` +
        'A dispatch that names a model off the frontier tier (for example model opus) runs on such an account; the operator can also allow the tier ("claudeCodeOrchestrator.frontierWorkerDispatch"). ' +
        'Add another worker account if this keeps blocking dispatches.';
      check('frontier: every account\'s default blocked and no model named → refused with "No eligible worker" and the reasons, and nothing is run', r.isError && said(r).split('\n')[0] === expected && box.runs().length === 0, said(r).split('\n')[0]);
      const events = fx.eventsFor('fr-none');
      check('failure event: a dispatch that failed before any attempt and named no model records `model: "-"` and NO `modelSource`', events.length === 1 && events[0].status === 'error' && events[0].model === '-' && !Object.hasOwn(events[0], 'modelSource'), events.map((e) => ({ status: e.status, worker: e.worker, model: e.model, modelSource: e.modelSource })));
      const named = await box.dispatch('fr-none-named', 'ok', { model: 'opus' });
      check('frontier: …and the same accounts take a dispatch that names a model off the tier', !named.isError && /^\[worker: w[ac], model: opus → /.test(named.text), named.text.split('\n')[0]);
      // The operator allows the tier: the default is a default like any other.
      const registryFile = path.join(fx.orchRoot, 'registry.json');
      fs.writeFileSync(registryFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(registryFile, 'utf8')), frontierWorkerDispatch: 'allow' }, null, 2));
      const allowed = await box.dispatch('fr-allowed', 'ok');
      const list = await srv.callTool('list_workers', {}, 60_000);
      check('frontier: with the guard set to allow, a dispatch that names no model runs the frontier default, and list_workers has no such line', !allowed.isError && ['fable', 'claude-mythos-1'].includes(box.run('fr-allowed')?.model) && !list.text.includes(MARK), { line1: allowed.text.split('\n')[0], model: box.run('fr-allowed')?.model });
    } finally {
      await fx.cleanup();
    }
  }
  // A failure that never reached an attempt, of a dispatch that DID name a model.
  {
    const box = await claudeSandbox('noattempt', [{ name: 'wa', model: 'haiku' }], { stats: { wa: { tasks: 0, errors: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, cooldownUntil: Date.now() + 3_600_000 } } });
    const { fx } = box;
    try {
      const r = await box.dispatch('na-named', 'ok', { model: 'opus' });
      const events = fx.eventsFor('na-named');
      check('failure event: no attempt at all, a model named → `model` is the requested one and `modelSource` is `dispatch`', r.isError && /^No eligible worker: cooling down/.test(said(r)) && events.length === 1 && events[0].model === 'opus' && events[0].modelSource === 'dispatch' && box.runs().length === 0, { text: clip(r.text, 120), events: describe(events) });
    } finally {
      await fx.cleanup();
    }
  }
  // Every attempt failed: the failure event speaks of the LAST one.
  {
    const box = await claudeSandbox('allfail', [{ name: 'wa', model: 'haiku' }, { name: 'wb', model: 'sonnet' }]);
    const { fx, srv } = box;
    try {
      const r = await box.dispatch('af-quota', 'quota');
      const events = fx.eventsFor('af-quota');
      const runs = box.runs().filter((x) => x.tag === 'af-quota');
      const last = runs.at(-1);
      const final = events.at(-1);
      const st = await statusOf(srv, final?.id ?? 'tnone');
      check('failure event: both accounts failed → the dispatch\'s failure event names what the LAST attempt asked for (that account\'s default) with `modelSource: "worker"`, as that attempt\'s running events did', r.isError && runs.length === 2 && final.status === 'error' && final.model === last.model && final.modelSource === 'worker' && events.filter((e) => e.worker === last.account).every((e) => e.model === last.model) && st.model === last.model, { runs: runs.map((x) => `${x.account}:${x.model}`), events: describe(events), st: [st.model, st.modelSource] });
    } finally {
      await fx.cleanup();
    }
  }
  // The session-worker core selects and records by the same rules.
  {
    const fx = H.makeFixture({ label: 'frontierbg', workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa', model: 'fable' }, { name: 'wb', model: 'opus' }], claude: { bg: { default: 'result-done' } } });
    try {
      const srv = await fx.startServer();
      const r1 = await srv.callTool('dispatch_task', { title: 'frbg-1', prompt: 'report done' }, 90_000);
      const r2 = await srv.callTool('dispatch_task', { title: 'frbg-2', prompt: 'report done' }, 90_000);
      check('frontier/session worker: dispatches that name no model run on the account whose default is not blocked', !r1.isError && !r2.isError && [r1, r2].every((r) => parseResult(r.text).line1 === '[worker: wb, model: opus]') && fx.claudeBgSpawns().length === 2, [r1.text.split('\n')[0], r2.text.split('\n')[0]]);
      const named = await srv.callTool('dispatch_task', { title: 'frbg-named', prompt: 'report done', worker: 'wa' }, 90_000);
      check('frontier/session worker: naming the blocked-default worker and no model is refused with the same message', named.isError && said(named).startsWith('Dispatch blocked: the default model of worker "wa" is on the frontier tier (fable)') && fx.eventsFor('frbg-named').length === 0, clip(named.text, 200));
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
  {
    const fx = H.makeFixture({ label: 'frontierbgall', workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa', model: 'fable' }], claude: { bg: { default: 'result-done' } } });
    try {
      const srv = await fx.startServer();
      const r = await srv.callTool('dispatch_task', { title: 'frbg-none', prompt: 'report done' }, 90_000);
      const events = fx.eventsFor('frbg-none');
      check('frontier/session worker: the only account\'s default is blocked → "No eligible worker" with the reason; nothing is spawned', r.isError && said(r).startsWith(`No eligible worker: default model fable ${MARK} — wa.`) && fx.claudeBgSpawns().length === 0, clip(r.text, 240));
      check('failure event (session worker): no attempt and no model named → `model: "-"`, no `modelSource`', events.length === 1 && events[0].status === 'error' && events[0].model === '-' && !Object.hasOwn(events[0], 'modelSource'), events.map((e) => ({ status: e.status, model: e.model, modelSource: e.modelSource })));
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
  {
    const fx = H.makeFixture({ label: 'failbg', workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa', model: 'sonnet' }], claude: { bg: { default: 'result-error' } } });
    try {
      const srv = await fx.startServer();
      const r = await srv.callTool('dispatch_task', { title: 'failbg', prompt: 'report an error' }, 90_000);
      const events = fx.eventsFor('failbg');
      const final = events.at(-1);
      check('failure event (session worker): a failed attempt on the worker\'s default → the failure event says `model: "sonnet"`, `modelSource: "worker"`', r.isError && fx.claudeBgSpawns().length === 1 && final?.status === 'error' && final.model === 'sonnet' && final.modelSource === 'worker' && events.every((e) => e.model === 'sonnet'), { text: clip(r.text, 120), events: describe(events) });
      await srv.stop();
    } finally {
      await fx.cleanup();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Section: ranas — what `list_workers` reads out of the task log, and how
 * ------------------------------------------------------------------------- */

async function sectionRanAs() {
  await calm();
  const fx = H.makeFixture({
    label: 'ranas',
    workspace: 'git',
    workers: [
      { name: 'wa', model: 'haiku' },
      { name: 'wo', model: 'opus' },
      { name: 'w2', provider: 'cursor' },
      // (One Cursor account at most: that CLI has a single login per machine.)
      { name: 'w3', provider: 'codex', model: 'opus' },
      { name: 'cx', provider: 'codex' },
    ],
  });
  try {
    const srv = await fx.startServer();
    const logFile = path.join(fx.orchRoot, 'tasks.jsonl');
    let ts = Date.now() - 3_600_000;
    let n = 0;
    const tid = () => `t${(3_000_000 + ++n).toString(36)}ra`;
    const ev = (id, status, worker, model, extra = {}) => ({ id, status, ts: (ts += 1000), title: `task ${id}`, worker, model, outputFile: '/nowhere', ...extra });
    /** The events of one finished task: a running one, then `done` carrying what was reported. */
    const done = (worker, model, source, used, extra = {}) => {
      const id = tid();
      const src = source === undefined ? {} : { modelSource: source };
      return [ev(id, 'running', worker, model, { ...src, ...extra }), ev(id, 'done', worker, model, { ...src, ...(used === undefined ? {} : { modelUsed: used }), ...extra })];
    };
    const write = (events) => {
      // A new file each time: another inode, so no earlier reading can stand in for it.
      fs.rmSync(logFile, { force: true });
      fs.writeFileSync(logFile, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + (events.length > 0 ? '\n' : ''));
    };
    /** worker name → the id list_workers says its default last ran as (undefined when it says none). */
    const ranAs = async () => {
      const list = await srv.callTool('list_workers', {}, 60_000);
      const out = {};
      for (const line of list.text.split('\n')) {
        const m = /^- (\S+)(?: \[[^\]]+\])?: default model .*? — /.exec(line);
        if (m) out[m[1]] = /\(last ran as ([^)]+)\) — /.exec(line)?.[1];
      }
      return { out, isError: list.isError, text: list.text };
    };
    const H45 = RESOLVED.haiku;

    write([...done('wa', 'haiku', 'worker', H45)]);
    let got = await ranAs();
    check('ranas: baseline — the default\'s finished task that reported a model is shown', got.out.wa === H45 && got.out.wo === undefined, got.out);

    // The task's FINAL event decides.
    {
      const id = tid();
      write([ev(id, 'running', 'wa', 'haiku', { modelSource: 'worker', pid: 4242 }), ev(id, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: H45 }), ev(id, 'error', 'wa', 'haiku', { modelSource: 'worker', error: 'cancelled by user' })]);
      got = await ranAs();
      check('ranas: a task whose final event is not `done` (a `done` followed by an `error` of the same id) says nothing', got.out.wa === undefined, got.out);
      const id2 = tid();
      write([ev(id2, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: H45 }), ev(id2, 'running', 'wa', 'haiku', { modelSource: 'worker' })]);
      got = await ranAs();
      check('ranas: …nor one whose `done` is followed by a `running` line of the same id', got.out.wa === undefined, got.out);
      const id3 = tid();
      write([ev(id3, 'done', 'wa', 'haiku', { modelSource: 'worker', modelUsed: H45 }), ev(id3, 'done', 'wo', 'opus', { modelSource: 'worker', modelUsed: RESOLVED.opus })]);
      got = await ranAs();
      check('ranas: one id finished on two accounts (a retry) counts for the account of its final event only', got.out.wa === undefined && got.out.wo === RESOLVED.opus, got.out);
    }
    // An account is its name AND its CLI.
    write([...done('w2', '-', 'cli', 'gpt-5.5', { provider: 'codex' }), ...done('w3', 'opus', 'worker', RESOLVED.opus)]);
    got = await ranAs();
    check('ranas: a Cursor account that reuses the name of a removed Codex account is not shown what that account ran; nor a Codex account (default `opus`) the id a Claude Code account of its name ran on `opus`', got.out.w2 === undefined && got.out.w3 === undefined && Object.keys(got.out).length === 5, got.out);
    write([...done('w2', '-', 'cli', 'composer-9', { provider: 'cursor' }), ...done('w3', 'opus', 'worker', 'gpt-9-opus', { provider: 'codex' }), ...done('wa', 'haiku', 'worker', H45, { provider: 'martian' })]);
    got = await ranAs();
    check('ranas: …while tasks of that name on that CLI are; an event of a provider this build does not know matches no account', got.out.w2 === 'composer-9' && got.out.w3 === 'gpt-9-opus' && got.out.wa === undefined, { out: got.out, lines: got.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 90)) });
    // The model that was asked for is compared as the model it means.
    for (const spelled of ['OPUS', ' opus ', 'claude-opus-4-8']) {
      write([...done('wo', spelled, 'dispatch', RESOLVED.opus)]);
      got = await ranAs();
      check(`ranas: a task that asked for ${JSON.stringify(spelled)} ran the default \`opus\``, got.out.wo === RESOLVED.opus, got.out);
    }
    // Lines that are not events of a task do not exist.
    write([
      { ...done('wa', 'haiku', 'worker', 'claude-from-a-bad-id')[1], id: '../../x' },
      { ...done('wa', 'haiku', 'worker', 'claude-from-a-numeric-id')[1], id: 7 },
      Object.fromEntries(Object.entries(done('wa', 'haiku', 'worker', 'claude-with-no-ts')[1]).filter(([k]) => k !== 'ts')),
      { ...done('wa', 'haiku', 'worker', 'claude-with-ts-zero')[1], ts: 0 },
      { ...done('wa', 'haiku', 'worker', 'claude-with-a-status')[1], status: 'finished' },
      'null',
      '[1,2]',
      '{"torn":',
    ]);
    got = await ranAs();
    check('ranas: a line with an id that is no task id, a numeric id, no time, a time of 0 or an unknown status is not an event — nothing is shown from it', !got.isError && got.out.wa === undefined, got.out);
    // No default: the CLI's own, by `modelSource`.
    write([...done('cx', 'gpt-5.6-terra', 'cli', 'gpt-5.6-terra', { provider: 'codex' }), ...done('cx', 'gpt-5.6-sol', 'dispatch', 'gpt-5.6-sol-b', { provider: 'codex' })]);
    got = await ranAs();
    check('ranas: an account with no default shows its newest finished CLI-default run, not a newer run that named a model', got.out.cx === 'gpt-5.6-terra', got.out);

    // The reading is kept for as long as the file is the same file in the same state.
    {
      write([...done('wa', 'haiku', 'worker', 'claude-haiku-first')]);
      // A modification time that can be put back exactly: whole milliseconds.
      const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
      fs.utimesSync(logFile, stamp, stamp);
      got = await ranAs();
      const st = fs.statSync(logFile);
      // In place: the same inode, the same size, and the time put back.
      const text = fs.readFileSync(logFile, 'utf8').replace('claude-haiku-first', 'claude-haiku-other');
      const fd = fs.openSync(logFile, 'r+');
      fs.writeSync(fd, text, 0);
      fs.closeSync(fd);
      fs.utimesSync(logFile, stamp, stamp);
      const after = fs.statSync(logFile);
      const again = await ranAs();
      check('ranas/cache: the log is read once per state of the file — rewritten in place to the same size with its time put back (same device, inode, size, mtime), the earlier reading is what is shown', got.out.wa === 'claude-haiku-first' && after.ino === st.ino && after.size === st.size && after.mtimeMs === st.mtimeMs && again.out.wa === 'claude-haiku-first', { first: got.out.wa, again: again.out.wa, same: [after.ino === st.ino, after.size === st.size, after.mtimeMs === st.mtimeMs] });
      fs.appendFileSync(logFile, done('wa', 'haiku', 'worker', 'claude-haiku-appended').map((e) => JSON.stringify(e)).join('\n') + '\n');
      got = await ranAs();
      check('ranas/cache: a log that grew is read again', got.out.wa === 'claude-haiku-appended', got.out);
      // Replaced by another file of the same size (a rename): another inode.
      const replaced = fs.readFileSync(logFile, 'utf8').replace('claude-haiku-appended', 'claude-haiku-replaced');
      fs.writeFileSync(`${logFile}.new`, replaced);
      fs.renameSync(`${logFile}.new`, logFile);
      got = await ranAs();
      check('ranas/cache: a log replaced by another file of the same size is read again', got.out.wa === 'claude-haiku-replaced', got.out);
      fs.truncateSync(logFile, 0);
      got = await ranAs();
      check('ranas/cache: a log truncated to nothing shows nothing', !got.isError && got.out.wa === undefined, got.out);
      // The default changed in the registry while the log did not: answered for the new default.
      write([...done('wa', 'haiku', 'worker', H45), ...done('wa', 'sonnet', 'dispatch', RESOLVED.sonnet)]);
      got = await ranAs();
      const registryFile = path.join(fx.orchRoot, 'registry.json');
      const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      reg.workers = reg.workers.map((w) => (w.name === 'wa' ? { ...w, model: 'sonnet' } : w));
      fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2));
      const changed = await ranAs();
      check('ranas/cache: a default changed in the registry is answered for the new default, from the same reading of the log', got.out.wa === H45 && changed.out.wa === RESOLVED.sonnet, [got.out.wa, changed.out.wa]);
    }
    // A large log: one bounded pass, and not the parsed log in memory.
    {
      const fd = fs.openSync(logFile, 'w');
      const preview = 'Implement the interface contract for the registry reader and its tests. '.repeat(4);
      let bytes = 0;
      let i = 0;
      let at = Date.now() - 86_400_000 * 20;
      while (bytes < 24 * 1024 * 1024) {
        let chunk = '';
        for (let k = 0; k < 500; k++) {
          const id = `t${(5_000_000 + ++i).toString(36)}big`;
          for (const status of ['running', 'running', 'done']) {
            chunk += JSON.stringify({ id, status, ts: (at += 500), title: `task ${i}`, worker: 'wo', model: 'opus', modelSource: 'worker', ...(status === 'done' ? { modelUsed: i % 2 === 0 ? RESOLVED.opus : 'claude-opus-5-5[1m]' } : {}), outputFile: `/x/tasks/${id}.md`, cwd: '/x/workspace', promptPreview: preview }) + '\n';
          }
        }
        fs.writeSync(fd, chunk);
        bytes += Buffer.byteLength(chunk);
      }
      fs.closeSync(fd);
      const rss = () => Number(String(spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(srv.child.pid)], { encoding: 'utf8' }).stdout).trim()) / 1024;
      const before = rss();
      const t0 = Date.now();
      got = await ranAs();
      const first = Date.now() - t0;
      const times = [];
      for (let r = 0; r < 5; r++) {
        const t1 = Date.now();
        await ranAs();
        times.push(Date.now() - t1);
      }
      const after = rss();
      const lastId = i % 2 === 0 ? RESOLVED.opus : 'claude-opus-5-5[1m]';
      check(`ranas/large log: a ${(bytes / 1048576).toFixed(0)} MiB log of ${i} tasks is answered right (the newest task's id), and an account that never ran its default still reads nothing`, got.out.wo === lastId && got.out.wa === undefined, got.out);
      check(`ranas/large log: the server's resident memory grows by far less than the log is large (${before.toFixed(0)} → ${after.toFixed(0)} MiB; the parsed log used to cost several times its size)`, after - before < 60, { before, after, first, times });
      check(`ranas/large log: a repeated call does not read the log again (${times.join(' / ')} ms after a first call of ${first} ms)`, Math.min(...times) < Math.max(40, first / 4), { first, times });
    }
    // Unreadable: nothing extra, and no failure.
    {
      fs.rmSync(logFile, { force: true });
      fs.mkdirSync(logFile);
      const dir = await ranAs();
      fs.rmdirSync(logFile);
      check('ranas: a directory where the log should be → the listing answers, with nothing extra', !dir.isError && Object.values(dir.out).every((v) => v === undefined) && Object.keys(dir.out).length === 5, { keys: Object.keys(dir.out), lines: dir.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 90)) });
    }
    await srv.stop();
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: cancel — a task is closed in the log once, by whoever gets there first
 * ------------------------------------------------------------------------- */

async function sectionCancel() {
  await calm();
  const box = await claudeSandbox('cancel', [{ name: 'wa', model: 'haiku' }]);
  const { fx, srv } = box;
  try {
    /** registry.cancelRunningTask in a process of its own, as the editor's cancel command is. */
    const cancel = async (id, grace) => {
      const res = await H.runNode([CANCEL_DRIVER, CORE_CJS, id, 'cancelled by user', ...(grace === undefined ? [] : [String(grace)])], { env: fx.env(), cwd: fx.workspace, timeoutMs: 40_000 });
      try {
        return JSON.parse(res.stdout.trim().split('\n').at(-1));
      } catch {
        return { unparseable: clip(res.stdout + res.stderr, 300) };
      }
    };
    const terminal = (events) => events.filter((e) => e.status !== 'running');
    const shape = (events) => events.map((e) => (e.status === 'error' ? `error(${clip(String(e.error), 40)})` : e.status));
    const withPid = async (title) => (await waitFor(() => fx.eventsFor(title).find((e) => typeof e.pid === 'number'), { label: `the pid event of ${title}` })).id;
    const errorsOf = () => fx.stats().wa?.errors ?? 0;

    // A — the worker FINISHES inside the cancel's grace (it ignores SIGTERM for its last moment).
    {
      const call = srv.startTool('dispatch_task', { title: 'c-finishing', prompt: '[[fake:finishing:1500]] [[tag:c-finishing]]', worker: 'wa' });
      const id = await withPid('c-finishing');
      await sleep(300);
      const c = await cancel(id);
      const a = await call.answer(60_000);
      const events = fx.eventsFor('c-finishing');
      const st = await statusOf(srv, id);
      const list = await srv.callTool('list_workers', {}, 60_000);
      check('cancel: a cancel that lands while the worker is finishing leaves EXACTLY ONE terminal event — never `done` followed by `error`', terminal(events).length === 1, shape(events));
      check('cancel: …the cancel got there first, so that is the record — `error: cancelled by user` — and every reader says so (dispatch_status, and list_workers shows no "last ran as" for a task that did not end `done`)', c.cancelled === true && terminal(events)[0]?.error === 'cancelled by user' && st.status === 'error' && st.error === 'cancelled by user' && !/last ran as/.test(list.text), { c, events: shape(events), st: [st.status, st.error], list: list.text.split('\n').find((l) => l.startsWith('- wa')) });
      check('cancel: …and the dispatch\'s caller still gets the result its worker produced, with a note that the log records the cancellation', !a.isError && a.text.includes('FAKE_OK c-finishing') && /note: the task log records this task as error \("cancelled by user"\)/.test(a.text), clip(a.text, 400));
    }
    // B — the ordinary cancel: the worker dies of the signal.
    {
      const before = errorsOf();
      const call = srv.startTool('dispatch_task', { title: 'c-running', prompt: '[[fake:delay:30000]] [[tag:c-running]]', worker: 'wa' });
      const id = await withPid('c-running');
      await sleep(300);
      const c = await cancel(id);
      const a = await call.answer(60_000);
      const events = fx.eventsFor('c-running');
      const report = box.report(id);
      check('cancel: cancelling a running worker leaves exactly one terminal event, and it is the cancellation — not the worker\'s death recorded as its failure', c.cancelled === true && terminal(events).length === 1 && terminal(events)[0].error === 'cancelled by user' && terminal(events)[0].modelSource === 'worker', { c, events: shape(events) });
      check('cancel: …the dispatch\'s caller is told the task was cancelled; nothing is counted against the account; the report keeps the CANCELLED note and is not rewritten as FAILED', a.isError && /cancelled by user/.test(a.text) && errorsOf() === before && /CANCELLED: cancelled by user/.test(report) && !/^FAILED:/m.test(report), { text: clip(a.text, 160), errors: [before, errorsOf()], report: clip(report, 200) });
      const again = await cancel(id);
      check('cancel: a second cancel of the same task does nothing and says so', again.cancelled === false && fx.eventsFor('c-running').length === events.length, again);
    }
    // C — a task that had already finished is left alone, and the caller told so.
    {
      const r = await box.dispatch('c-done', 'ok', { worker: 'wa' });
      const id = parseResult(r.text).taskId;
      const events = fx.eventsFor('c-done');
      const c = await cancel(id);
      check('cancel: a task that had already finished is left as it finished — nothing appended, the caller told (`false`)', c.cancelled === false && eq(shape(fx.eventsFor('c-done')), shape(events)) && events.at(-1).status === 'done', { c, events: shape(fx.eventsFor('c-done')) });
      const none = await cancel('tnosuchtask0');
      check('cancel: a task the log does not have → `false`, nothing appended', none.cancelled === false && fx.eventsOfTask('tnosuchtask0').length === 0, none);
    }
    // D — several cancels at once: one of them cancels.
    {
      const call = srv.startTool('dispatch_task', { title: 'c-many', prompt: '[[fake:delay:30000]] [[tag:c-many]]', worker: 'wa' });
      const id = await withPid('c-many');
      await sleep(300);
      const results = await Promise.all([cancel(id, 500), cancel(id, 500), cancel(id, 500), cancel(id, 500)]);
      await call.answer(60_000);
      const events = fx.eventsFor('c-many');
      check('cancel: four cancels of one task at the same moment → exactly one of them cancels it, and the task has exactly one terminal event', results.filter((x) => x.cancelled === true).length === 1 && results.filter((x) => x.cancelled === false).length === 3 && terminal(events).length === 1, { results, events: shape(events) });
    }
    // E — a cancel and a completion in the same instant, several times over.
    {
      const outcomes = [];
      for (let i = 0; i < 6; i++) {
        const title = `c-race-${i}`;
        const call = srv.startTool('dispatch_task', { title, prompt: `[[fake:delay:700]] [[tag:${title}]]`, worker: 'wa' });
        const id = await withPid(title);
        // Around the moment the worker prints its result: the driver's own start takes a while.
        await sleep(250 + i * 60);
        const c = await cancel(id, 300);
        const a = await call.answer(60_000);
        const events = fx.eventsFor(title);
        outcomes.push({ cancelled: c.cancelled, terminal: shape(terminal(events)), isError: a.isError });
      }
      check('cancel: a cancel and a completion at the same moment, six times → every task has exactly one terminal event, whichever came first', outcomes.every((o) => o.terminal.length === 1), outcomes);
      check('cancel: …and what the cancel answered agrees with the log each time (`true` ⇔ the one terminal event is the cancellation)', outcomes.every((o) => o.cancelled === (o.terminal[0] === 'error(cancelled by user)')), outcomes);
    }
    // F — a detached task: its supervisor finds the task closed and records nothing over it.
    {
      const call = srv.startTool('dispatch_task', { title: 'c-detached', prompt: '[[fake:delay:30000]] [[tag:c-detached]]', worker: 'wa', detach: true });
      const id = await withPid('c-detached');
      await sleep(400);
      const c = await cancel(id);
      const a = await call.answer(60_000);
      const events = fx.eventsFor('c-detached');
      check('cancel: a detached task cancelled from the editor → one terminal event (the cancellation), and the waiting dispatch is told so', c.cancelled === true && terminal(events).length === 1 && terminal(events)[0].error === 'cancelled by user' && a.isError && /cancelled by user/.test(a.text), { c, events: shape(events), text: clip(a.text, 160) });
    }
    // G — the request is cancelled after the editor already cancelled the task.
    {
      const call = srv.startTool('dispatch_task', { title: 'c-both', prompt: '[[fake:finishing:2500]] [[tag:c-both]]', worker: 'wa' });
      const id = await withPid('c-both');
      await sleep(300);
      const c = await cancel(id, 200);
      srv.notify('notifications/cancelled', { requestId: call.id });
      await sleep(3200);
      const events = fx.eventsFor('c-both');
      check('cancel: a request cancelled after the editor cancelled its task adds no second terminal event', c.cancelled === true && terminal(events).length === 1 && terminal(events)[0].error === 'cancelled by user', shape(events));
    }
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: pinned — a pinned model is read, kept and written as the exact id
 * ------------------------------------------------------------------------- */

async function sectionPinned(core) {
  const R = core.registry;
  const file = path.join(MAIN_HOME, '.claude-code-orchestrator', 'registry.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  const dirOf = (name) => path.join(BASE, 'pinned-accounts', name);
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = (name) => [...(onDisk().workers ?? []), ...(onDisk().vendorWorkers ?? [])].find((w) => w.name === name);
  const profile = (name) => R.readRegistry().workers.find((w) => w.name === name);
  const shape = (w) => (w === undefined ? null : [w.model, w.modelPinned ?? null]);
  const threw = (fn) => {
    try {
      fn();
      return undefined;
    } catch (err) {
      return String(err && err.message ? err.message : err);
    }
  };
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          workers: [
            { name: 'pa', configDir: dirOf('pa'), model: 'claude-opus-4-8', modelPinned: true, keptKey: 1 },
            { name: 'pb', configDir: dirOf('pb'), model: 'claude-opus-4-8' },
            { name: 'pc', configDir: dirOf('pc'), model: ' CLAUDE-SONNET-5 ', modelPinned: true },
            { name: 'pd', configDir: dirOf('pd'), model: 'claude-fable-5', modelPinned: 'yes' },
            { name: 'pe', configDir: dirOf('pe'), model: 'opus', modelPinned: true },
            { name: 'pf', configDir: dirOf('pf'), model: 'not a model', modelPinned: true },
          ],
          vendorWorkers: [{ name: 'px', provider: 'codex', configDir: dirOf('px'), model: 'gpt-6.1-sol' }],
        },
        null,
        2,
      ),
    );
    const read = Object.fromEntries(['pa', 'pb', 'pc', 'pd', 'pe', 'pf'].map((n) => [n, shape(profile(n))]));
    check('pinned: a v1.x tier id the entry PINS is read as that exact model (`claude-opus-4-8`, `claude-sonnet-5`); the same id unpinned is its tier (`opus`); only the literal `true` pins (`"yes"` does not)', eq(read.pa, ['claude-opus-4-8', true]) && eq(read.pb, ['opus', null]) && eq(read.pc, ['claude-sonnet-5', true]) && eq(read.pd, ['fable', null]), read);
    check('pinned: …and nothing new is refused: a pinned alias stays an alias, a pinned value that is no model reads as the default tier, as an unpinned one does', eq(read.pe, ['opus', true]) && eq(read.pf, ['opus', true]), read);
    R.updateRegistry(() => {});
    check('pinned: a rewrite keeps `modelPinned: true` and the pinned id as it is, with the keys this version does not know; an unpinned tier id is rewritten as its alias, and a `modelPinned` that is not `true` is dropped', eq([entry('pa')?.model, entry('pa')?.modelPinned, entry('pa')?.keptKey], ['claude-opus-4-8', true, 1]) && eq([entry('pb')?.model, 'modelPinned' in (entry('pb') ?? {})], ['opus', false]) && !('modelPinned' in (entry('pd') ?? {})) && entry('px')?.model === 'gpt-6.1-sol', { pa: entry('pa'), pb: entry('pb'), pd: entry('pd') });
    R.renameWorker('pa', 'pa2');
    check('pinned: …and so does a rename', eq([entry('pa2')?.model, entry('pa2')?.modelPinned], ['claude-opus-4-8', true]) && entry('pa') === undefined, entry('pa2'));

    // The setter the extension host calls.
    const steps = [];
    const step = (label, args, want) => {
      const got = R.setWorkerModel(...args);
      steps.push({ label, got, entry: entry(args[0]) });
      return got === want;
    };
    const ok1 = step('pin a tier id', ['pb', 'claude', 'claude-opus-4-8', true], true) && eq([entry('pb').model, entry('pb').modelPinned], ['claude-opus-4-8', true]) && eq(shape(profile('pb')), ['claude-opus-4-8', true]);
    const ok2 = step('the same id unpinned', ['pb', 'claude', 'claude-opus-4-8', false], true) && eq([entry('pb').model, 'modelPinned' in entry('pb')], ['opus', false]);
    const ok3 = step('an alias asked pinned', ['pb', 'claude', 'Sonnet', true], true) && eq([entry('pb').model, 'modelPinned' in entry('pb')], ['sonnet', false]);
    const ok4 = step('a full id, spelled loosely', ['pb', 'claude', ' Claude-Opus-4-7 ', true], true) && eq([entry('pb').model, entry('pb').modelPinned], ['claude-opus-4-7', true]);
    check('pinned: setWorkerModel stores `model` and `modelPinned` together — a pinned full id (a tier id kept exact), an unpinned tier id as its alias, an alias never pinned, an id normalized', ok1 && ok2 && ok3 && ok4, steps);
    const was = JSON.stringify(onDisk());
    const refusals = [threw(() => R.setWorkerModel('pb', 'claude', 'two words', true)), threw(() => R.setWorkerModel('px', 'codex', 'two words', false)), threw(() => R.setWorkerModel('pb', 'claude', 'gpt-6.1-sol', false))];
    check('pinned: …a value that is not a model for the worker\'s CLI throws (literals only — the value is not echoed) and nothing is written', refusals.every((m) => typeof m === 'string' && !m.includes('two words') && !m.includes('gpt-6.1-sol')) && JSON.stringify(onDisk()) === was, refusals);
    const missing = [R.setWorkerModel('nobody', 'claude', 'opus', false), R.setWorkerModel('pb', 'codex', 'gpt-6.1-sol', false), R.setWorkerModel('px', 'claude', 'opus', false)];
    check('pinned: …a name with no worker, or a worker on another CLI than the one named → `false`, nothing written', missing.every((v) => v === false) && JSON.stringify(onDisk()) === was, missing);
    const vendor = [R.setWorkerModel('px', 'codex', 'gpt-6-luna', true), entry('px')?.model, 'modelPinned' in (entry('px') ?? {}), R.setWorkerModel('px', 'codex', '', false), entry('px')?.model];
    check('pinned: …another vendor\'s worker gets its own id, never `modelPinned`; `""` is "the CLI chooses"', eq(vendor, [true, 'gpt-6-luna', false, true, '']), vendor);
  } finally {
    if (before === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }

  // Through a server: a pinned worker runs the exact id it pins.
  await calm();
  const box = await claudeSandbox('pinned', [{ name: 'wp', model: 'claude-opus-4-8', extra: { modelPinned: true } }, { name: 'wq', model: 'claude-opus-4-8' }]);
  try {
    const rp = await box.dispatch('p-pinned', 'ok', { worker: 'wp' });
    const rq = await box.dispatch('p-tier', 'ok', { worker: 'wq' });
    check('pinned: a worker pinned to `claude-opus-4-8` is started with `--model claude-opus-4-8` and reports it — `[worker: wp, model: claude-opus-4-8]`', !rp.isError && box.run('p-pinned')?.model === 'claude-opus-4-8' && parseResult(rp.text).line1 === '[worker: wp, model: claude-opus-4-8]', { line1: parseResult(rp.text).line1, model: box.run('p-pinned')?.model });
    check(`pinned: …the same id unpinned is its tier: \`--model opus\`, \`[worker: wq, model: opus → ${RESOLVED.opus}]\``, !rq.isError && box.run('p-tier')?.model === 'opus' && parseResult(rq.text).line1 === `[worker: wq, model: opus → ${RESOLVED.opus}]`, { line1: parseResult(rq.text).line1, model: box.run('p-tier')?.model });
    const list = await box.srv.callTool('list_workers', {}, 60_000);
    const lineP = list.text.split('\n').find((l) => l.startsWith('- wp'));
    check('pinned: …and list_workers shows the pinned id as the default, with what it ran as', lineP?.startsWith('- wp: default model claude-opus-4-8 (last ran as claude-opus-4-8) — '), lineP);
    await box.srv.stop();
  } finally {
    await box.fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: accounts — list_workers says which accounts are one, and what aliases mean
 * ------------------------------------------------------------------------- */

/** A `/model` menu as the usage cache holds it (contract §14.1), from the CLI's `initialize` answer. */
const CLAUDE_MENU = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', label: 'Opus 5.5', description: 'Opus 5.5' },
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 5.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
];

async function sectionAccounts() {
  await calm();
  const K1 = 'a1b2c3d4e5f60718';
  const K2 = '0f1e2d3c4b5a6978';
  const now = Date.now();
  const hostile = [
    { value: 'opus', label: 'Opus\nInjected line' },
    { value: 'sonnet', label: 'S'.repeat(61) },
    { value: 'haiku', label: '$(icon) Haiku' },
    { value: '__proto__', label: 'Proto' },
    { value: 'fable', label: 42 },
    ...Array.from({ length: 500 }, (_, i) => ({ value: `claude-x-${i}`, label: `X ${i}` })),
    { value: 'fable', label: 'Fable after the 64th entry' },
  ];
  const fx = H.makeFixture({
    label: 'accounts',
    workers: [{ name: 'c' }, { name: 't' }, { name: 'mg' }, { name: 'c2' }, { name: 'x3' }, { name: 'h1' }, { name: 'h2' }, { name: 'cx', provider: 'codex' }],
    usage: {
      c: { accountKey: K1, models: CLAUDE_MENU, modelsFetchedAt: now, planLabel: 'Claude Max' },
      t: { accountKey: K2 },
      mg: { accountKey: K1 },
      c2: { accountKey: K1 },
      x3: { accountKey: K2.toUpperCase() },
      h1: { models: hostile },
      h2: { models: 'not a list', accountKey: 'a1b2c3d4e5f6071' },
    },
  });
  try {
    // main's entry, as the editor writes it: this session's own account — the same one as t.
    const env = fx.env();
    const mainDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : path.join(fx.home, '.claude');
    const cacheFile = path.join(fx.orchRoot, 'usage.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache[mainDir] = { ...cache[fx.worker('t').configDir], name: 'main', configDir: mainDir, accountKey: K2 };
    // [CA: a Claude Code reading with no login probes is `unconfirmed`, and list_workers probes such an
    // account although its reading is fresh (contract-2.0-fixes "Login state (CA)"); the refresh then
    // rewrites the entry, carrying the menu forward through the cache's own menu reader, so the hostile
    // labels below never reached the display reader these checks are about.] Every Claude Code entry
    // carries the probe this version's refresh files with its reading — `in`, through the binding the
    // account runs with (main: unset unless this session sets CLAUDE_CONFIG_DIR; a worker: explicit) —
    // so list_workers reads the cache as written. The Codex entry gets none: probes make a Claude reading.
    const cxDir = fx.worker('cx').configDir;
    for (const [dir, entry] of Object.entries(cache)) {
      if (dir === cxDir || entry === null || typeof entry !== 'object') continue;
      const binding = dir === mainDir && !(typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '') ? 'unset' : 'explicit';
      entry.loginProbes = [{ at: now, path: binding, result: 'in', via: 'usage', reason: 'plan usage read' }];
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    const srv = await fx.startServer();
    const list = await srv.callTool('list_workers', {}, 60_000);
    await srv.stop();
    const text = list.text;
    console.log(text.split('\n').map((l) => `  | ${l}`).join('\n'));
    const block = (head) => {
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.startsWith(head));
      if (at === -1) return [];
      const out = [lines[at]];
      for (let i = at + 1; i < lines.length && lines[i].startsWith('  '); i++) out.push(lines[i]);
      return out;
    };
    const has = (head, line) => block(head).includes(line);
    const warns = (head) => block(head).filter((l) => l.startsWith('  ⚠ same claude.ai account'));
    check('accounts: two accounts with one key — main and t — each get `  ⚠ same claude.ai account as <other> — both draw on one plan\'s limits`', has('main (this session)', '  ⚠ same claude.ai account as t — both draw on one plan\'s limits') && has('- t ', '  ⚠ same claude.ai account as main — both draw on one plan\'s limits'), { main: block('main (this session)'), t: block('- t ') });
    check('accounts: three with one key name the other two, in list order — `as mg, c2 — all of them draw on one plan\'s limits`', has('- c ', '  ⚠ same claude.ai account as mg, c2 — all of them draw on one plan\'s limits') && has('- mg ', '  ⚠ same claude.ai account as c, c2 — all of them draw on one plan\'s limits') && has('- c2 ', '  ⚠ same claude.ai account as c, mg — all of them draw on one plan\'s limits'), { c: block('- c '), mg: block('- mg '), c2: block('- c2 ') });
    check('accounts: no notice for a key that is not one (upper case, 15 digits), for an account with none (no email), or for another vendor\'s account', warns('- x3 ').length === 0 && warns('- h1 ').length === 0 && warns('- h2 ').length === 0 && warns('- cx').length === 0, { x3: block('- x3 '), h2: block('- h2 '), cx: block('- cx') });
    check('accounts: a cached `/model` menu → `  aliases on this CLI: opus = Opus 5.5 · sonnet = Sonnet 5.5 · haiku = Haiku 5.5 · fable = Fable 5.1` (the pickers\' order, `default` and the pinned ids left out), at the end of that account\'s block', has('- c ', '  aliases on this CLI: opus = Opus 5.5 · sonnet = Sonnet 5.5 · haiku = Haiku 5.5 · fable = Fable 5.1') && block('- c ').at(-1) === '  aliases on this CLI: opus = Opus 5.5 · sonnet = Sonnet 5.5 · haiku = Haiku 5.5 · fable = Fable 5.1', block('- c '));
    check('accounts: …a menu entry whose label is not one clean line of at most 60 (a newline, 61 characters, a number) is left out, `__proto__` is no alias, only the first 64 entries are read; `$(icon)` is text', has('- h1 ', '  aliases on this CLI: haiku = $(icon) Haiku') && !text.includes('Injected line') && !text.includes('Fable after'), block('- h1 '));
    check('accounts: …no aliases line without a menu, or with one that is not a list', block('- t ').every((l) => !l.startsWith('  aliases')) && block('- h2 ').every((l) => !l.startsWith('  aliases')), { t: block('- t '), h2: block('- h2 ') });
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: recover — a session task recovered by a later sweep records what ran
 * ------------------------------------------------------------------------- */

async function sectionRecover() {
  await calm();
  const fx = H.makeFixture({
    label: 'recover',
    workspace: 'git',
    registry: { meshMode: 'on' },
    workers: [{ name: 'wa', model: 'sonnet' }],
    claude: { bg: { default: { kind: 'result-done', resultDelayMs: 4000, parkDelayMs: 60_000, transcriptModel: MAIN_MODEL, transcriptRows: sidechainRows() } } },
  });
  try {
    const first = await fx.startServer();
    first.startTool('dispatch_task', { title: 'r-recover', prompt: 'report done' });
    await waitFor(() => fx.claudeJobs().length === 1 && fx.eventsFor('r-recover').some((e) => typeof e.meshWorker === 'string'), { timeoutMs: 40_000, label: 'the session worker to be running' });
    const id = fx.eventsFor('r-recover')[0].id;
    // The dispatching server dies; its worker reports afterwards, to nobody.
    first.kill();
    await waitFor(() => typeof fx.claudeJobs()[0]?.resultWrittenAt === 'number', { timeoutMs: 40_000, label: 'the worker to write its result' });
    check('recover: the premise — the dispatching server was gone, and nothing had closed the task, when its worker wrote its result', fx.eventsFor('r-recover').every((e) => e.status === 'running'), describe(fx.eventsFor('r-recover')));
    const second = await fx.startServer();
    const st = await statusOf(second, id);
    const events = fx.eventsFor('r-recover');
    let report = '';
    try {
      report = fs.readFileSync(path.join(fx.tasksDir, `${id}.md`), 'utf8');
    } catch {
      report = '';
    }
    check(`recover: a later server's sweep recovers the task from the worker's result file as \`done\`, with the \`modelUsed\` its transcript names (${MAIN_MODEL}, not the subagent's)`, events.at(-1)?.status === 'done' && events.at(-1)?.modelUsed === MAIN_MODEL && withUsed(events).length === 1 && /RECOVERED: recorded done from the worker's own dispatch result file/.test(report), { events: describe(events), note: clip(report.slice(report.indexOf('RECOVERED')), 200) });
    check('recover: …dispatch_status reports it, and list_workers says what the default last ran as', st.status === 'done' && st.modelUsed === MAIN_MODEL && (await second.callTool('list_workers', {}, 60_000)).text.split('\n').some((l) => l.startsWith(`- wa: default model sonnet (last ran as ${MAIN_MODEL}) — `)), st);
    await second.stop();
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: codexlive — a live Codex catalog, from `codex app-server`
 * ------------------------------------------------------------------------- */

/**
 * Which Codex adapter the live rows run, and how the helper is bundled with it: the INSTALLED
 * package when it lists live itself (it exports `fetchLiveModels`), else the adapter's source in
 * the agent-mesh repository beside this one (or at $CCO_CODEX_ADAPTER_SRC) put in its place —
 * read, never written. Undefined when there is neither: the rows are then skipped.
 */
function liveCodexAdapter() {
  const installed = createRequire(path.join(REPO, 'package.json'))('@toragonite/agent-mesh-codex');
  if (typeof installed.fetchLiveModels === 'function') {
    return { label: 'the installed @toragonite/agent-mesh-codex', plugins: [] };
  }
  const src = process.env.CCO_CODEX_ADAPTER_SRC ?? path.join(REPO, '..', 'agent-mesh', 'packages', 'codex', 'src', 'index.ts');
  if (!fs.existsSync(src)) {
    return undefined;
  }
  return {
    label: `the adapter source ${src}`,
    plugins: [{ name: 'codex-adapter-source', setup: (b) => b.onResolve({ filter: /^@toragonite\/agent-mesh-codex$/ }, () => ({ path: src })) }],
  };
}

/** The helper, and the adapter on its own, bundled with the adapter liveCodexAdapter chose. */
async function buildLiveCodex(adapter) {
  const { esbuild, common } = esbuildOptions;
  const dir = path.join(OUT, 'codexlive');
  const helper = path.join(dir, 'mcp', 'provider-cli.js');
  await esbuild.build({ ...common, entryPoints: [path.join(SRC, 'mcp', 'provider-cli.ts')], outfile: helper, plugins: adapter.plugins });
  const entry = path.join(dir, 'codex-entry.ts');
  fs.writeFileSync(entry, "export * from '@toragonite/agent-mesh-codex';\n");
  const lib = path.join(dir, 'codex-adapter.cjs');
  await esbuild.build({ ...common, entryPoints: [entry], format: 'cjs', outfile: lib, plugins: adapter.plugins });
  return { helper, codex: createRequire(import.meta.url)(lib) };
}

/** What `codex app-server` lists in the fake, as the real one listed it (models-fake-codex.mjs). */
const CODEX_LIVE = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

async function sectionCodexLive(core) {
  await calm();
  // The catalog rule for a listing that is the CLI's own answer, on the function itself.
  {
    const entries = core.providerRunner.catalogEntries;
    const cli = { cliFields: true };
    const got = entries('codex', [
      { id: 'gpt-6.1-sol', label: '  GPT-6.1   Sol​ ', default: true, efforts: ['low', 'high', 'UPPER', 'has space', 'x'.repeat(17), 7, 'low'] },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', default: true, efforts: 'high' },
      { id: '__proto__', label: 'Proto' },
      { id: 'gpt-6-sol' },
    ], cli);
    check('codexlive: a listing that is the CLI\'s own answer keeps its display names (as one clean line), ONE `default` — the first — and only well-formed effort words', eq(got, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', default: true, efforts: ['low', 'high'] }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6-sol' }]), got);
    const printed = 'gpt-6.1-sol - GPT-6.1 Sol\n';
    const asTable = entries('codex', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', default: true, efforts: ['low'] }], printed);
    const builtIn = entries('codex', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', default: true, efforts: ['low'] }]);
    check('codexlive: …while a listing read off printed text, and a built-in catalog, never say `default` or `efforts`', eq(asTable, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]) && eq(builtIn, [{ id: 'gpt-6.1-sol' }]), { asTable, builtIn });
  }

  const adapter = liveCodexAdapter();
  if (adapter === undefined) {
    skip('codexlive: the helper against `codex app-server`', 'neither the installed Codex adapter nor an adapter source beside this repository lists models live (set CCO_CODEX_ADAPTER_SRC)');
    return;
  }
  console.log(`  codexlive: running ${adapter.label}`);
  const { helper, codex } = await buildLiveCodex(adapter);
  const fx = H.makeFixture({ label: 'codexlive', workers: [{ name: 'cx', provider: 'codex' }, { name: 'ck', provider: 'codex', auth: 'api-key' }] });
  const dirOf = (name) => fx.worker(name).configDir;
  const log = path.join(fx.root, 'fake-codex.log');
  const play = (mode) =>
    fs.writeFileSync(fx.launcher('codex'), ['#!/bin/sh', '# models.mjs launcher: a FAKE codex app-server (models-fake-codex.mjs). Never the real CLI.', `exec ${shq(process.execPath)} ${shq(FAKE_CODEX)} ${shq(`--mode=${mode}`)} ${shq(`--log=${log}`)} "$@"`, ''].join('\n'), { mode: 0o755 });
  const records = () => readJsonl(log);
  const planted = { ANTHROPIC_API_KEY: 'sk-ant-PLANTED-CODEXLIVE', CLAUDE_CONFIG_DIR: path.join(fx.home, '.claude'), CLAUDECODE: '1' };
  const ask = async (mode, { worker = 'cx', budgetMs } = {}) => {
    fs.rmSync(log, { force: true });
    play(mode);
    const started = Date.now();
    const res = await H.runNode([helper, 'models', 'codex', dirOf(worker), ...(budgetMs === undefined ? [] : [`--budget-ms=${budgetMs}`])], { env: fx.env(planted), cwd: fx.workspace, timeoutMs: 40_000 });
    const elapsedMs = Date.now() - started;
    // A process group the adapter killed is gone a moment after the helper has answered.
    await sleep(300);
    const starts = records().filter((r) => r.ev === 'start');
    return { res, elapsedMs, starts, left: starts.filter((r) => isPidAlive(r.pid)).map((r) => r.pid), ...catalogProblems(res) };
  };
  const idsOf = (catalog) => (catalog?.models ?? []).map((m) => m.id);
  const builtInOf = async (configDir) => (await new codex.CodexAdapter({ binary: '', env: {} }).availableModels({ vendor: 'codex', configDir })).map((m) => m.id);
  try {
    fx.assertHermetic();
    const builtIn = await builtInOf(dirOf('cx'));
    // The real protocol, answered.
    {
      const a = await ask('ok');
      console.log(`  codexlive: ${a.res.stdout.trim()}`);
      const want = CODEX_LIVE.map(([id, label], i) => ({ id, label, ...(i === 0 ? { default: true } : {}), efforts: CODEX_EFFORTS }));
      check('codexlive: `codex app-server` answers model/list and ends when its stdin closes → one line in the catalog shape, `source: "live"`', a.problems.length === 0 && a.catalog?.source === 'live' && a.catalog?.error === null, { problems: a.problems, out: clip(a.res.stdout, 300) });
      check('codexlive: …the CLI\'s models in its order, each labelled with its `displayName`, `gpt-6.1-sol` marked `default`, the reasoning efforts it lists on every one', eq(a.catalog?.models, want), a.catalog?.models);
      const got = records().filter((r) => r.ev === 'got').map((r) => r.method);
      check('codexlive: …ONE `codex app-server`, with the account\'s directory as CODEX_HOME and no Anthropic variable (three were planted), sent initialize → initialized → model/list, ended by itself, nothing left running', a.starts.length === 1 && eq(a.starts[0].argv, ['app-server']) && a.starts[0].codexHome === dirOf('cx') && eq(a.starts[0].foreign, []) && eq(got, ['initialize', 'initialized', 'model/list']) && records().some((r) => r.ev === 'end') && a.left.length === 0, { starts: a.starts.map((r) => ({ argv: r.argv, home: r.codexHome, foreign: r.foreign })), got, left: a.left });
    }
    {
      const a = await ask('paged:3');
      const cursors = records().filter((r) => r.ev === 'got' && r.method === 'model/list').map((r) => r.cursor);
      check('codexlive: a listing over three pages (`nextCursor`) → all seven models, from one app-server that was asked for each page in turn', a.catalog?.source === 'live' && eq(idsOf(a.catalog), CODEX_LIVE.map(([id]) => id)) && a.starts.length === 1 && eq(cursors, [null, 'c1', 'c2']) && a.left.length === 0, { ids: idsOf(a.catalog), starts: a.starts.length, cursors });
    }
    // The login's gate, as the adapter applies it.
    {
      const chatgpt = await ask('gated');
      const key = await ask('gated', { worker: 'ck' });
      check('codexlive: a CLI that lists ids only an API key may select → they are left out for a ChatGPT login and kept for an API-key one, as the adapter gates its own listing', chatgpt.catalog?.source === 'live' && eq(idsOf(chatgpt.catalog), CODEX_LIVE.map(([id]) => id)) && key.catalog?.source === 'live' && eq(idsOf(key.catalog), [...CODEX_LIVE.map(([id]) => id), 'gpt-5.1-codex-max', 'gpt-5.2']), { chatgpt: idsOf(chatgpt.catalog), key: idsOf(key.catalog) });
    }
    // What does not answer, or does not end, or answers wrong: the built-in catalog, and nothing left.
    for (const [mode, what] of [
      ['deaf', 'never answers'],
      ['deaf-hard', 'never answers and ignores SIGTERM'],
      ['no-exit', 'answers but does not end when its stdin closes'],
    ]) {
      const a = await ask(mode, { budgetMs: 4000 });
      check(`codexlive: an app-server that ${what} → stopped inside the budget (4 s asked), the built-in catalog (\`source: "static"\`), and no process of it left running`, a.problems.length === 0 && a.catalog?.source === 'static' && eq(idsOf(a.catalog), builtIn) && a.elapsedMs < 4000 + 2000 && a.starts.length === 1 && a.left.length === 0, { problems: a.problems, source: a.catalog?.source, elapsedMs: a.elapsedMs, left: a.left });
    }
    for (const [mode, what] of [
      ['garbage', 'prints lines that are not JSON'],
      ['exit1', 'answers and then exits 1'],
      ['error', 'answers model/list with an error'],
    ]) {
      const a = await ask(mode);
      check(`codexlive: an app-server that ${what} → the built-in catalog, \`source: "static"\``, a.problems.length === 0 && a.catalog?.source === 'static' && eq(idsOf(a.catalog), builtIn) && a.left.length === 0, { problems: a.problems, catalog: a.catalog });
    }
    // A hostile listing.
    {
      const a = await ask('hostile');
      const models = a.catalog?.models ?? [];
      const byId = new Map(models.map((m) => [m.id, m]));
      const long = byId.get('gpt-h-long');
      check('codexlive: 600 entries with a 10 kB name, `$(icon)` in a name, `__proto__` and an id with a space, junk efforts and several defaults → the catalog shape holds, inside 256 KiB', a.problems.length === 0 && a.catalog?.source === 'live' && models.length > 0 && Buffer.byteLength(a.res.stdout) <= 256 * 1024, { problems: a.problems, bytes: Buffer.byteLength(a.res.stdout), n: models.length });
      check('codexlive: …the ids no model rule takes are left out; the 10 kB name is cut to 80; `$(icon) Icon Model` is kept as the text it is; one `default` — the first the CLI named', !byId.has('__proto__') && !byId.has('two words') && typeof long?.label === 'string' && long.label.length <= 80 && long.label.startsWith('Long n') && byId.get('gpt-h-icon')?.label === '$(icon) Icon Model' && models.filter((m) => m.default === true).length === 1 && long.default === true, { long: long && { label: clip(long.label, 90), default: long.default }, icon: byId.get('gpt-h-icon'), defaults: models.filter((m) => m.default === true).map((m) => m.id) });
      check('codexlive: …efforts are short lower-case words, at most six, on the first 64 entries only', eq(long?.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']) && eq(byId.get('gpt-h-icon')?.efforts, ['ok-1']) && models.slice(64).every((m) => !('efforts' in m)) && models.slice(2, 64).every((m) => eq(m.efforts, CODEX_EFFORTS)), { long: long?.efforts, icon: byId.get('gpt-h-icon')?.efforts, after64: models.slice(64).filter((m) => 'efforts' in m).length });
    }
  } finally {
    await fx.cleanup();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: reader — registry.latestTaskEventOf, the reader every terminal event is written behind
 * ------------------------------------------------------------------------- */

/** One models-reader.cjs run with HOME at `home`; its last stdout line, parsed. */
function readerRun(args, home, { nodeArgs = [], timeoutMs = 120_000, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onLine !== undefined) onLine(stdout);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const last = stdout.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ unparseable: clip(`${stdout}${stderr} (exit ${code ?? signal})`, 600) });
      }
    });
  });
}

const MiB = 1024 * 1024;

async function sectionReader() {
  await calm();
  const homeOf = (label) => {
    const home = path.join(BASE, `home-reader-${label}`);
    fs.mkdirSync(path.join(home, '.claude-code-orchestrator'), { recursive: true });
    return home;
  };

  // A — the same answer as the whole-log reader, on 2,000 random logs.
  {
    const r = await readerRun([READER_DRIVER, 'equiv', CORE_CJS, '2000', '20261014'], homeOf('equiv'), { timeoutMs: 300_000 });
    const t = r.tally ?? {};
    console.log(`  equiv: ${JSON.stringify(t)}`);
    check(
      'reader: on 2,000 random logs, latestTaskEventOf(id) gives the whole-log reader\'s answer for every id asked — the last event of that id among those ranAs.isCountedTaskEvent admits, no line past the 32 KiB clamp counted, or "none" — and no other',
      r.mismatchCount === 0 && t.logs === 2000 && t.asks === 22000,
      r.mismatches ?? r,
    );
    check(
      'reader: …and those logs held what the rule has to survive: lines across 64 KiB chunk boundaries (answers among them), 5 MiB lines, a last line without a line feed, \\u-escaped ids, duplicate keys, ids that are a prefix of a later line\'s id, lines past the clamp after the answer, garbage, a BOM — and answers where the whole-log reader, unfiltered, says something else',
      t.logsOver64KiB > 500 && t.answersStraddlingAChunk > 50 && t.with5MiBLine === 50 && t.withTrailingHalf > 100 && t.answersInLastLine > 50 && t.answersFromEscapedLine > 100 && t.answersFromDuplicateKeyLine > 50 && t.answersPastAPrefixDecoy > 500 && t.answersPastALongLine > 500 && t.withBom > 10 && t.answersNone > 0 && t.rawFullReaderDiffers > 100,
      t,
    );
    const special = Array.isArray(r.special) ? r.special : [];
    check(
      'reader: …and where the log is refused or absent, the same verdict as the whole-log reader: absent and empty are "none"; a directory, a FIFO with no writer (answered at once) and a log past 64 MiB are "unreadable"; exactly 64 MiB of one line is read and is "none"',
      special.length === 6 &&
        special.every((x) => (x.bounded === 'unreadable') === x.fullUnreadable && (x.bounded === 'none' || x.bounded === 'unreadable')) &&
        eq(special.map((x) => x.bounded), ['none', 'none', 'unreadable', 'unreadable', 'unreadable', 'none']) &&
        special[3].ms < 1000,
      special,
    );
  }

  // B — what one call costs on a 61 MiB log whose task events are in its last 1 MiB.
  {
    const home = homeOf('cost');
    const made = await readerRun([READER_DRIVER, 'costlog', CORE_CJS, 'tcost1'], home);
    const cost = (which) => readerRun([READER_DRIVER, 'cost', CORE_CJS, 'tcost1', which], home, { nodeArgs: ['--expose-gc'] });
    const bounded = await cost('bounded');
    const full = await cost('full');
    const close = await cost('close');
    console.log(`  cost: log ${JSON.stringify(made)}`);
    for (const x of [bounded, full, close]) console.log(`  cost: ${JSON.stringify(x)}`);
    check(
      'reader: on a 61 MiB log whose task events lie in its last 1 MiB, one latestTaskEventOf call reads less than 2 MiB and grows the process by less than 16 MiB (bytes counted through fs.readSync; rss after a gc, before and after) — and answers what the whole-log reader answers',
      made.size > 61 * MiB - 4096 && made.firstOfTaskFromEnd <= MiB + 64 * 1024 &&
        bounded.wholeReads === 0 && bounded.bytesRead < 2 * MiB && bounded.rssDelta < 16 * MiB &&
        typeof bounded.answer === 'string' && bounded.answer.startsWith('running') && bounded.answer === full.answer,
      { made, bounded, full },
    );
    check(
      'reader: …where the whole-log reader reads all 61 MiB (the cost this reader removes), and a whole close of that task (appendTerminalTaskEvent: the lock, the read, the append) also reads less than 2 MiB',
      full.bytesRead === made.size && close.answer === 'closed over running' && close.bytesRead < 2 * MiB && close.rssDelta < 16 * MiB,
      { full, close },
    );
  }

  // C — the task's reconcile lock is held by another process past the wait.
  {
    const home = homeOf('lock');
    const id = 'tlockheld1';
    const log = path.join(home, '.claude-code-orchestrator', 'tasks.jsonl');
    const running = { id, ts: Date.now(), status: 'running', worker: 'wa', title: 'lock held elsewhere' };
    fs.writeFileSync(log, `${JSON.stringify(running)}\n`);
    let held = false;
    const holder = readerRun(
      [READER_DRIVER, 'hold', CORE_CJS, id, '20000', JSON.stringify({ ...running, ts: running.ts + 1, status: 'done' })],
      home,
      { timeoutMs: 60_000, onLine: (text) => (held ||= text.includes('held\n')) },
    );
    await waitFor(() => held, { label: 'the holder to take the lock', timeoutMs: 20_000 });
    const lockFile = path.join(home, '.claude-code-orchestrator', 'tasks', `${id}.reconcile.lock`);
    const cancelled = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CANCEL_DRIVER, CORE_CJS, id, 'cancelled by user', '0'], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => {
        try {
          resolve(JSON.parse(out.trim().split('\n').at(-1)));
        } catch {
          resolve({ unparseable: out });
        }
      });
    });
    // While the holder still holds it: the close went ahead without the lock, and left it alone.
    const lockStillThere = (() => {
      try {
        fs.lstatSync(lockFile);
        return true;
      } catch {
        return false;
      }
    })();
    const after = await holder;
    const events = readJsonl(log).filter((e) => e.id === id);
    const terminal = events.filter((e) => e.status !== 'running');
    console.log(`  lock: cancel ${JSON.stringify(cancelled)}; holder ${JSON.stringify(after)}; log ${JSON.stringify(events.map((e) => e.status === 'error' ? `error(${e.error})` : e.status))}`);
    check(
      'close: with the task\'s reconcile lock held by another process past the 15 s wait, a cancel waits it out and then closes the task WITHOUT the lock — the lock left where it is, held — and the log has exactly one terminal event: the cancellation (`error: cancelled by user`)',
      cancelled.cancelled === true && cancelled.elapsedMs >= 15_000 && lockStillThere &&
        terminal.length === 1 && terminal[0].status === 'error' && terminal[0].error === 'cancelled by user' && events.length === 2,
      { cancelled, lockStillThere, events },
    );
    check(
      'close: …and the holder, once it lets go, finds the task closed and writes nothing of its own: its `done` is refused with the cancellation as the final event',
      after.heldMs >= 20_000 && after.after?.closed === false && after.after?.final?.status === 'error' && after.after?.final?.error === 'cancelled by user' && readJsonl(log).length === 2,
      after,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Section: helper — `provider-cli.js models <provider> <configDir>`
 * ------------------------------------------------------------------------- */

const CATALOG_MAX_BYTES = 256 * 1024;

/** What is wrong with one helper run as an answer in the catalog shape; [] when nothing is. */
function catalogProblems(res) {
  const problems = [];
  if (res.code !== 0) problems.push(`exit ${res.code}${res.timedOut ? ' (killed by the test)' : ''}`);
  const lines = res.stdout.split('\n').filter((l) => l !== '');
  if (lines.length !== 1 || !res.stdout.endsWith('\n')) problems.push(`${lines.length} lines on stdout`);
  if (Buffer.byteLength(res.stdout) > CATALOG_MAX_BYTES) problems.push(`${Buffer.byteLength(res.stdout)} bytes on stdout`);
  let catalog;
  try {
    catalog = JSON.parse(lines[0] ?? '');
  } catch {
    problems.push('stdout is not JSON');
    return { problems, catalog: undefined };
  }
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    problems.push('not an object');
    return { problems, catalog: undefined };
  }
  if (!eq(Object.keys(catalog).sort(), ['error', 'models', 'source'])) problems.push(`keys ${Object.keys(catalog).join(',')}`);
  if (!Array.isArray(catalog.models)) {
    problems.push('`models` is not an array');
    return { problems, catalog };
  }
  if (catalog.source !== 'live' && catalog.source !== 'static') problems.push(`source ${JSON.stringify(catalog.source)}`);
  if (catalog.error !== null && (typeof catalog.error !== 'string' || catalog.error.length > 200 || /[\r\n]/.test(catalog.error) || catalog.error === '')) problems.push('`error` is not null or one line of at most 200 chars');
  if (catalog.models.length > 600) problems.push(`${catalog.models.length} models`);
  if ((catalog.error === null) !== (catalog.models.length > 0)) problems.push('`error` is null exactly when there are models — violated');
  const ids = new Set();
  let resoldSeen = false;
  let defaults = 0;
  for (const m of catalog.models) {
    const keys = Object.keys(m ?? {});
    // `id`, then `label`, `resold`, `default` and `efforts` when there are — in that order.
    if (!eq(keys, ['id', ...['label', 'resold', 'default', 'efforts'].filter((k) => k in (m ?? {}))])) problems.push(`entry keys ${keys.join(',')}`);
    if ('default' in (m ?? {}) && m.default !== true) problems.push(`default ${JSON.stringify(m.default)} on ${m.id}`);
    if (m?.default === true) defaults++;
    if ('efforts' in (m ?? {}) && (!Array.isArray(m.efforts) || m.efforts.length === 0 || m.efforts.length > 6 || !m.efforts.every((e) => typeof e === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(e)) || new Set(m.efforts).size !== m.efforts.length)) problems.push(`efforts ${clip(m.efforts, 80)} on ${m.id}`);
    if (typeof m?.id !== 'string' || m.id === '' || m.id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:\/=,\[\]-]*$/.test(m.id)) problems.push(`id ${clip(m?.id, 40)}`);
    if (ids.has(m?.id)) problems.push(`id ${m.id} twice`);
    ids.add(m?.id);
    // One line, at most 80, nothing invisible at either end, no run of blanks inside.
    if ('label' in (m ?? {}) && (typeof m.label !== 'string' || m.label === '' || m.label.length > 80 || /[\r\n\t\u0000-\u001f\u200b\ufeff]| {2}/.test(m.label) || /^[\s\u200c\u200d]|[\s\u200c\u200d]$/.test(m.label))) problems.push(`label ${JSON.stringify(m.label).slice(0, 60)}`);
    if ('resold' in (m ?? {}) && m.resold !== true) problems.push(`resold ${JSON.stringify(m.resold)} on ${m.id}`);
    if (m?.resold === true) resoldSeen = true;
    else if (resoldSeen) problems.push(`${m?.id} (own) is listed after a resold model`);
  }
  if (defaults > 1) problems.push(`${defaults} entries marked default`);
  if (catalog.source !== 'live' && catalog.models.some((m) => 'label' in (m ?? {}) || 'default' in (m ?? {}) || 'efforts' in (m ?? {}))) problems.push('a built-in catalog carries a label, a default or efforts');
  return { problems, catalog };
}

/**
 * The INSTALLED Codex adapter's built-in catalog for an account directory: its `availableModels`
 * with a process seam that starts nothing — the way the product asks for it (provider-runner
 * builtInModels).
 */
async function codexBuiltIn(configDir) {
  const { CodexAdapter } = createRequire(path.join(REPO, 'package.json'))('@toragonite/agent-mesh-codex');
  const nothing = async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
  const list = await new CodexAdapter({ exec: nothing, env: {} }).availableModels({ vendor: 'codex', configDir });
  return Array.isArray(list) ? list.map((m) => m.id) : [];
}

async function sectionHelper() {
  await calm();
  const helper = (fx, args, env = {}, timeoutMs = 40_000) => H.runNode([H.PROVIDER_CLI_JS, ...args], { env: fx.env(env), cwd: fx.workspace, timeoutMs });
  const idsOf = (catalog) => (catalog?.models ?? []).map((m) => m.id);
  const outputs = [];
  /** The helper's exact line per case against the harness's fakes — printed at the end. */
  const exact = {};
  const ask = async (fx, args, env, timeoutMs) => {
    const res = await helper(fx, args, env, timeoutMs);
    outputs.push(res.stdout + res.stderr);
    return { res, ...catalogProblems(res) };
  };

  // 1 — each provider against the harness's own fake CLIs.
  {
    const fx = H.makeFixture({
      label: 'helper',
      workspace: 'git',
      workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }, { name: 'ck', provider: 'codex', auth: 'api-key' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }],
    });
    try {
      fx.assertHermetic();
      const dirOf = (name) => fx.worker(name).configDir;
      const planted = { ANTHROPIC_API_KEY: 'sk-ant-PLANTED-MODELS-TEST', ANTHROPIC_AUTH_TOKEN: 'PLANTED-AUTH', CLAUDE_CONFIG_DIR: path.join(fx.home, '.claude'), CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'PLANTED-OAUTH' };

      // The harness's fake `codex` plays no app-server, so whatever the installed adapter does to
      // list live, the answer here is its built-in catalog — asked of the adapter itself, so the
      // rows follow the adapter's own list (and its gating by login) from one version to the next.
      const builtInChatGpt = await codexBuiltIn(dirOf('cx'));
      const builtInKey = await codexBuiltIn(dirOf('ck'));
      const codex = await ask(fx, ['models', 'codex', dirOf('cx')], planted);
      check('helper/codex: one line in the catalog shape, exit 0', codex.problems.length === 0, `${codex.problems.join('; ')} — ${clip(codex.res.stdout, 200)}`);
      check(`helper/codex: a CLI that lists nothing → \`source: "static"\`, the installed adapter's built-in catalog for a ChatGPT login (${builtInChatGpt.join(', ')})`, codex.catalog?.source === 'static' && builtInChatGpt.length > 0 && eq(idsOf(codex.catalog), builtInChatGpt) && codex.catalog?.error === null, { catalog: codex.catalog, builtInChatGpt });
      check('helper/codex: the whole line, exactly — Codex\'s own models carry no `resold` key, and a built-in catalog no label, default or efforts', codex.res.stdout === `${JSON.stringify({ models: builtInChatGpt.map((id) => ({ id })), source: 'static', error: null })}\n`, codex.res.stdout);
      exact.codex = codex.res.stdout.trim();
      check('helper/codex: …and whatever was started for it was `codex app-server`, and nothing of it is left running', fx.invocations('codex').every((x) => x.argv?.[0] === 'app-server') && fx.invocations('codex').every((x) => typeof x.pid !== 'number' || !isPidAlive(x.pid)), fx.invocations('codex').map((x) => x.argv));
      const codexKey = await ask(fx, ['models', 'codex', dirOf('ck')]);
      exact['codex (API-key login)'] = codexKey.res.stdout.trim();
      check('helper/codex: an API-key login is offered the adapter\'s catalog for that login — more ids than a ChatGPT login\'s', codexKey.problems.length === 0 && codexKey.catalog?.source === 'static' && eq(idsOf(codexKey.catalog), builtInKey) && builtInKey.length > builtInChatGpt.length, { catalog: codexKey.catalog, builtInKey });

      const cursor = await ask(fx, ['models', 'cursor', dirOf('cu')], planted);
      check('helper/cursor: one line in the catalog shape, exit 0', cursor.problems.length === 0, `${cursor.problems.join('; ')} — ${clip(cursor.res.stdout, 200)}`);
      check('helper/cursor: `source: "live"` — what `cursor-agent models` listed, in its order, with its display names', cursor.catalog?.source === 'live' && eq(idsOf(cursor.catalog), ['auto', 'composer-2.5', 'cursor-grok-4.5-high', 'gpt-5.6']) && cursor.catalog.models[1].label === 'Composer 2.5' && cursor.catalog.error === null, cursor.catalog);
      check('helper/cursor: the model of another vendor\'s family (`gpt-5.6`) is marked `resold: true`, and only it', eq((cursor.catalog?.models ?? []).map((m) => m.resold === true), [false, false, false, true]) && eq(Object.keys(cursor.catalog?.models[1] ?? {}), ['id', 'label']), cursor.catalog);
      check('helper/cursor: the whole line, exactly — every label is the display name the CLI printed (`Auto`, `GPT 5.6`), with nothing the adapter appends to it', cursor.res.stdout === '{"models":[{"id":"auto","label":"Auto"},{"id":"composer-2.5","label":"Composer 2.5"},{"id":"cursor-grok-4.5-high","label":"Grok 4.5 High"},{"id":"gpt-5.6","label":"GPT 5.6","resold":true}],"source":"live","error":null}\n', cursor.res.stdout);
      exact.cursor = cursor.res.stdout.trim();
      const cursorCalls = fx.invocations('cursor');
      check('helper/cursor: exactly one `cursor-agent models` was run', cursorCalls.length === 1 && eq(cursorCalls[0].argv, ['models']), cursorCalls.map((x) => x.argv));

      const gemini = await ask(fx, ['models', 'gemini', dirOf('ag')], planted);
      check('helper/antigravity: one line in the catalog shape, exit 0', gemini.problems.length === 0, `${gemini.problems.join('; ')} — ${clip(gemini.res.stdout, 200)}`);
      check('helper/antigravity: `source: "live"` — what `agy models` listed (the adapter\'s exported live listing), not its built-in catalog', gemini.catalog?.source === 'live' && eq(idsOf(gemini.catalog), ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gpt-oss-120b-medium']) && gemini.catalog.models[0].label === 'Gemini 3.8 Flash (High)', gemini.catalog);
      check('helper/antigravity: the whole line, exactly — `gpt-oss-120b-medium` is the one marked `resold: true`', gemini.res.stdout === '{"models":[{"id":"gemini-3.8-flash-high","label":"Gemini 3.8 Flash (High)"},{"id":"gemini-3.8-flash-medium","label":"Gemini 3.8 Flash (Medium)"},{"id":"gemini-3.8-flash-low","label":"Gemini 3.8 Flash (Low)"},{"id":"gpt-oss-120b-medium","label":"GPT-OSS 120B (Medium)","resold":true}],"source":"live","error":null}\n', gemini.res.stdout);
      exact.gemini = gemini.res.stdout.trim();
      const agyCalls = fx.invocations('gemini');
      check('helper/antigravity: one `agy models`, with the account\'s directory as AGY_HOME', agyCalls.length === 1 && eq(agyCalls[0].argv, ['models']) && agyCalls[0].env?.AGY_HOME === dirOf('ag'), agyCalls.map((x) => ({ argv: x.argv, home: x.env?.AGY_HOME })));
      const leaked = [...cursorCalls, ...agyCalls].flatMap((x) => Object.keys(x.env ?? {}).filter((k) => /^(ANTHROPIC_|CLAUDE_)/.test(k) || k === 'CLAUDECODE'));
      check('helper: no Anthropic variable reaches a vendor CLI (five were planted in the helper\'s environment)', cursorCalls.length + agyCalls.length === 2 && leaked.length === 0, leaked);
      const aliases = await ask(fx, ['models', 'antigravity', dirOf('ag')]);
      check('helper: a provider alias (`antigravity`) is the provider', aliases.problems.length === 0 && aliases.catalog?.source === 'live' && idsOf(aliases.catalog).length === 4, aliases.catalog);

      // The CLI is there and cannot list: the adapter's built-in catalog answers.
      fx.setScenario({ cursor: { login: 'out' }, gemini: { login: 'out' } });
      const cursorOut = await ask(fx, ['models', 'cursor', dirOf('cu')]);
      exact['cursor (CLI cannot list)'] = cursorOut.res.stdout.trim();
      const geminiOut0 = await ask(fx, ['models', 'gemini', dirOf('ag')]);
      check('helper/cursor: `cursor-agent models` fails (logged out) → `source: "static"`, the adapter\'s own short list, no error', cursorOut.problems.length === 0 && cursorOut.catalog?.source === 'static' && idsOf(cursorOut.catalog).includes('auto') && idsOf(cursorOut.catalog).length >= 2 && !idsOf(cursorOut.catalog).includes('gpt-5.6'), cursorOut.catalog ?? cursorOut.res.stdout);
      check('helper: a built-in catalog carries ids only — its text is the adapter\'s, and no CLI printed a name for it', [cursorOut, geminiOut0].every((a) => (a.catalog?.models ?? []).length > 0 && a.catalog.models.every((m) => !Object.hasOwn(m, 'label'))), [cursorOut.catalog, geminiOut0.catalog]);
      const geminiOut = geminiOut0;
      exact['gemini (CLI cannot list)'] = geminiOut.res.stdout.trim();
      check('helper/antigravity: `agy models` fails (logged out) → `source: "static"`, the adapter\'s built-in catalog, its Claude and GPT entries marked resold', geminiOut.problems.length === 0 && geminiOut.catalog?.source === 'static' && idsOf(geminiOut.catalog).length > 4 && !idsOf(geminiOut.catalog).includes('gemini-3.8-flash-high') && eq(geminiOut.catalog.models.filter((m) => m.resold === true).map((m) => m.id), ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']), geminiOut.catalog ?? geminiOut.res.stdout);
      fx.setScenario({});

      // Arguments.
      const bad = [
        ['a provider that does not exist', ['models', 'nope', dirOf('cx')], /unknown provider "nope"/],
        ['`claude` (not a provider this lists)', ['models', 'claude', dirOf('cx')], /unknown provider "claude"/],
        ['no provider at all', ['models'], /unknown provider ""/],
        ['a missing directory', ['models', 'codex'], /missing configDir/],
        ['an empty directory argument', ['models', 'codex', ''], /missing configDir/],
        ['a flag where the directory belongs', ['models', 'codex', '--quota'], /missing configDir/],
        ['an extra argument', ['models', 'codex', dirOf('cx'), '--quota'], /unknown argument "--quota"/],
        ['a provider of 5000 characters', ['models', 'x'.repeat(5000), dirOf('cx')], /unknown provider "x{60}"/],
      ];
      for (const [what, args, expect] of bad) {
        const a = await ask(fx, args);
        check(`helper/arguments: ${what} → the same shape with an \`error\`, an empty list, exit 0`, a.problems.length === 0 && a.catalog?.models.length === 0 && expect.test(String(a.catalog?.error)), `${a.problems.join('; ')} — ${clip(a.res.stdout, 200)}`);
      }
      const before = fx.vendorLog().length;
      const gone = await ask(fx, ['models', 'codex', path.join(fx.home, 'no-such-dir')]);
      check('helper: a directory that does not exist is not an error for a catalog that needs none — Codex answers its built-in one, and nothing is started or created', gone.problems.length === 0 && gone.catalog?.source === 'static' && idsOf(gone.catalog).length >= 4 && fx.vendorLog().length === before && !fs.existsSync(path.join(fx.home, 'no-such-dir')), gone.catalog ?? gone.res.stdout);

      // `status` is what it was.
      const st = await helper(fx, ['status', 'codex', dirOf('cx')]);
      const frob = await helper(fx, ['frobnicate', 'codex', dirOf('cx')]);
      let stParsed;
      try {
        stParsed = JSON.parse(st.stdout);
      } catch {
        stParsed = undefined;
      }
      check('helper: `status` still prints a ProviderStatus and exits 0; an unknown command still exits 2', st.code === 0 && stParsed?.loggedIn === true && Object.hasOwn(stParsed, 'cliFound') && frob.code === 2 && /unknown command/.test(frob.stdout), { st: clip(st.stdout, 120), frob: `${frob.code} ${clip(frob.stdout, 120)}` });

      // The CLI is not installed — only where no real one could be found instead.
      for (const [provider, cli, worker] of [['cursor', 'cursor-agent', 'cu'], ['gemini', 'agy', 'ag']]) {
        if (H.hermeticVerdict().systemBinaries[cli].length > 0) {
          skip(`helper/${provider}: the CLI is not installed → static`, `a real ${cli} exists at ${H.hermeticVerdict().systemBinaries[cli].join(', ')}, where the lookup's fixed fallback would find it`);
          continue;
        }
        fx.removeCli(cli);
        try {
          fx.assertHermetic();
          const a = await ask(fx, ['models', provider, dirOf(worker)]);
          check(`helper/${provider}: the CLI is not installed → \`source: "static"\`, the adapter's built-in catalog, no error`, a.problems.length === 0 && a.catalog?.source === 'static' && a.catalog.models.length > 0 && a.catalog.error === null, a.catalog ?? a.res.stdout);
        } finally {
          fx.installCli(cli);
        }
      }

      const secrets = [...Object.values(H.SECRETS), 'PLANTED-MODELS-TEST', 'PLANTED-AUTH', 'PLANTED-OAUTH', 'harness-cursor-user@example.invalid'];
      const leaks = secrets.filter((s) => outputs.some((o) => o.includes(s)));
      check(`helper: nothing secret in any output above (${outputs.length} runs)`, leaks.length === 0, leaks);
    } finally {
      await fx.cleanup();
    }
  }

  // 2 — listings the harness's fakes cannot give, from models-fake-vendor.mjs.
  {
    const fx = H.makeFixture({ label: 'helperhostile', workspace: 'git', workers: [{ name: 'wa' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }, { name: 'cx', provider: 'codex' }] });
    try {
      const dirOf = (name) => fx.worker(name).configDir;
      const vendorLog = path.join(fx.root, 'models-fake-vendor.log');
      const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
      /** Replace the sandbox's launcher of `cli` with one for models-fake-vendor.mjs in `mode`. */
      const install = (cli, mode) => {
        const vendor = cli === 'agy' ? 'gemini' : 'cursor';
        fs.writeFileSync(
          fx.launcher(cli),
          ['#!/bin/sh', `# models.mjs launcher: a FAKE ${cli} (models-fake-vendor.mjs). Never the real CLI.`, `exec ${shq(process.execPath)} ${shq(FAKE_VENDOR)} ${shq(`--vendor=${vendor}`)} ${shq(`--mode=${mode}`)} ${shq(`--log=${vendorLog}`)} "$@"`, ''].join('\n'),
          { mode: 0o755 },
        );
        fx.assertHermetic();
      };
      const fakePids = () => readJsonl(vendorLog).map((r) => r.pid);
      const listing = (name, text) => {
        const file = path.join(fx.root, `${name}.txt`);
        fs.writeFileSync(file, text);
        return file;
      };

      // megabytes
      for (const [provider, cli, worker] of [['cursor', 'cursor-agent', 'cu'], ['gemini', 'agy', 'ag']]) {
        install(cli, 'big:5');
        const a = await ask(fx, ['models', provider, dirOf(worker)]);
        check(`helper/${provider}: a CLI that prints 5 MiB of models → one line under 256 KiB with the first 600 and their names, \`live\`, in seconds`, a.problems.length === 0 && a.catalog?.models.length === 600 && a.catalog.source === 'live' && a.catalog.models[0].id === 'big-model-0' && a.catalog.models[599].id === 'big-model-599' && a.catalog.models[599].label === 'Big Model 599' && a.res.elapsedMs < 20_000, `${a.problems.join('; ')} — ${a.catalog?.models.length} models, ${Buffer.byteLength(a.res.stdout)} bytes, ${a.res.elapsedMs} ms, ${JSON.stringify(a.catalog?.models[599])}`);
        // `big-model-*` is a family nobody knows: resold under Cursor (its own are a named set),
        // not resold under Antigravity.
        check(`helper/${provider}: …an id of an unknown family is ${provider === 'cursor' ? 'resold under Cursor' : 'not called resold under Antigravity'}`, (a.catalog?.models ?? []).every((m) => (m.resold === true) === (provider === 'cursor')), a.catalog?.models[0]);
      }
      // labels
      install('cursor-agent', 'many:700');
      {
        const a = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        const labels = (a.catalog?.models ?? []).map((m) => m.label ?? '');
        check('helper: 700 models with labels of 200 characters → 600 entries, each label cut to 80', a.problems.length === 0 && labels.length === 600 && labels.every((l) => l === 'L'.repeat(80)), `${a.problems.join('; ')} — ${labels.length} labels, ${clip(labels[0], 100)}`);
      }
      // The largest line the helper can print, through the real helper and the real adapter:
      // 700 models whose ids are as long as the model rule accepts and whose names are 300
      // characters of 3 bytes each.
      {
        const lines = ['Available models', ''];
        for (let i = 0; i < 700; i++) lines.push(`${`m${i}`.padEnd(120, 'x')} - ${'\u6f22'.repeat(300)}`);
        lines.push('', 'Tip: use --model <id>', '');
        install('cursor-agent', `file:${listing('cursor-largest', lines.join('\n'))}`);
        const a = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        const bytes = Buffer.byteLength(a.res.stdout);
        check(`helper: 600 entries of maximal id and label length → the printed line is under 256 KiB (${bytes} bytes)`, a.problems.length === 0 && a.catalog?.models.length === 600 && a.catalog.models.every((m) => m.id.length === 120 && m.label === '\u6f22'.repeat(80) && m.resold === true) && bytes < 256 * 1024 && bytes > 200 * 1024, `${a.problems.join('; ')} — ${a.catalog?.models.length} models, ${bytes} bytes`);
      }
      // A listing shaped like the real one (cursor-agent 2026.10.12): 259 models — 17 of
      // Cursor's own among 242 it resells from seven families — between a title, a blank line
      // and a closing tip.
      {
        const families = [['claude', 123], ['gpt', 83], ['gemini', 16], ['grok', 8], ['muse', 6], ['kimi', 4], ['glm', 2]];
        const resoldLines = families.flatMap(([family, count]) => Array.from({ length: count }, (_, i) => `${family}-${i + 1}-high - ${family[0].toUpperCase()}${family.slice(1)} ${i + 1} High`));
        const ownLines = ['auto - Auto (default)', ...Array.from({ length: 8 }, (_, i) => `composer-${i + 1} - Composer ${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `cursor-small-${i + 1} - Cursor Small ${i + 1}`)];
        // Own models scattered through the listing, so that "own first" is the catalog's doing.
        const body = [ownLines[0]];
        for (let i = 0; i < resoldLines.length; i++) {
          body.push(resoldLines[i]);
          if (i % 15 === 7 && 1 + Math.floor(i / 15) < ownLines.length) body.push(ownLines[1 + Math.floor(i / 15)]);
        }
        const text = ['Available models', '', ...body, '', "Tip: use --model <id> - e.g. --model 'composer-2.5'", ''].join('\n');
        install('cursor-agent', `file:${listing('cursor-259', text)}`);
        const a = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        const models = a.catalog?.models ?? [];
        const ownIds = ownLines.map((l) => l.split(' - ')[0]);
        check('helper/cursor (a listing shaped like the real one): the premise — 259 model lines, 17 of them Cursor\'s own', body.length === 259 && ownLines.length === 17 && body.filter((l) => ownIds.includes(l.split(' - ')[0])).length === 17, [body.length, ownLines.length]);
        check('helper/cursor (a listing shaped like the real one): all 259 are in the catalog, `live`', a.problems.length === 0 && models.length === 259 && a.catalog?.source === 'live', `${a.problems.join('; ')} — ${models.length} models`);
        check('helper/cursor (…): the 17 own models come first, in the listing\'s order, then the 242 resold ones in the listing\'s order', eq(models.slice(0, 17).map((m) => m.id), body.map((l) => l.split(' - ')[0]).filter((id) => ownIds.includes(id))) && models.slice(0, 17).every((m) => !Object.hasOwn(m, 'resold')) && eq(models.slice(17).map((m) => m.id), body.map((l) => l.split(' - ')[0]).filter((id) => !ownIds.includes(id))) && models.slice(17).every((m) => m.resold === true), [models.slice(0, 3), models.slice(17, 19)]);
        const families3 = ['muse', 'kimi', 'glm'].map((f) => models.filter((m) => m.id.startsWith(`${f}-`)));
        check('helper/cursor (…): `muse-*` (6), `kimi-*` (4) and `glm-*` (2) — families this code does not know — are resold under Cursor', eq(families3.map((list) => list.length), [6, 4, 2]) && families3.flat().every((m) => m.resold === true), families3.map((list) => list.length));
        check('helper/cursor (…): the title and the closing `Tip: use --model <id>` line are not models; `auto` is labelled as the CLI printed it (`Auto (default)`)', !models.some((m) => /^(tip|available)/i.test(m.id) || /tip:/i.test(m.label ?? '')) && models[0].id === 'auto' && models[0].label === 'Auto (default)' && models.find((m) => m.id === 'claude-1-high')?.label === 'Claude 1 High', [models[0], models.find((m) => m.id === 'claude-1-high')]);
        exact['cursor (259-model listing): first 3 and last 2 entries'] = JSON.stringify([...models.slice(0, 3), ...models.slice(-2)]);
      }
      // ids the model rule refuses
      {
        const long = 'L'.repeat(130);
        install('cursor-agent', `file:${listing('cursor-ids', ['Available models', '', 'ok-model - Fine', 'semi;colon - Refused', '$(id) - Refused', `${long} - Too long`, 'ok-model - A second time', '-leading-dash - Refused', 'ok.two[fast=true] - Fine too', 'quote"d - Refused', 'tab\tbed - Refused', '', 'Tip: use --model <id>', ''].join('\n'))}`);
        const a = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        check('helper/cursor: ids the model rule refuses are left out, and an id is listed once (with the name of its FIRST line)', a.problems.length === 0 && eq(a.catalog?.models, [{ id: 'ok-model', label: 'Fine', resold: true }, { id: 'ok.two[fast=true]', label: 'Fine too', resold: true }]) && a.catalog.source === 'live', a.catalog ?? a.res.stdout);
        install('agy', `file:${listing('agy-ids', ['Fetching available models...', 'ok-model\tFine', 'two words\tRefused', 'semi;colon\tRefused', `${long}\tToo long`, 'ok-model\tA second time', 'ok.two\tFine \u001b[31mtoo\u001b[0m', 'bare-id\t', ''].join('\n'))}`);
        const g = await ask(fx, ['models', 'gemini', dirOf('ag')]);
        check('helper/antigravity: ids the model rule refuses are left out; a label\'s control characters are flattened; an empty label is no label', g.problems.length === 0 && eq(idsOf(g.catalog), ['ok-model', 'ok.two', 'bare-id']) && !Object.hasOwn(g.catalog.models[2], 'label') && !/\u001b/.test(g.catalog.models[1].label), g.catalog ?? g.res.stdout);
        // The shapes the real listings have: zero-width characters after a display name, a
        // doubled space and a tab inside one, a parenthesised note, a name of 300 characters,
        // a name that is nothing but invisible characters — and resold models among the own.
        install(
          'agy',
          `file:${listing(
            'agy-real',
            [
              'Fetching available models...',
              'gemini-3.8-flash-high\tGemini 3.8 Flash  (High)\u200b\u200b',
              'claude-opus-5-5-high\tClaude Opus 5.5 (High)\u200c',
              'gemini-3.8-pro\tGemini 3.8\tPro',
              `gemini-long\t${'N'.repeat(300)}`,
              'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
              'gemini-invisible\t\u200b\u200d\u2060',
              'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
              'gemini-zw\u200b\tAn id with a zero-width character after it',
              '',
            ].join('\n'),
          )}`,
        );
        const real = await ask(fx, ['models', 'gemini', dirOf('ag')]);
        check('helper/antigravity (real-listing shapes): own models first in the CLI\'s order, then the resold ones in the CLI\'s order', real.problems.length === 0 && real.catalog?.source === 'live' && eq(idsOf(real.catalog), ['gemini-3.8-flash-high', 'gemini-3.8-pro', 'gemini-long', 'gemini-invisible', 'gemini-3.8-flash-low', 'claude-opus-5-5-high', 'gpt-oss-120b-medium']) && eq(real.catalog.models.map((m) => m.resold === true), [false, false, false, false, false, true, true]), `${real.problems.join('; ')} — ${clip(real.res.stdout, 400)}`);
        const labelOf = (id) => real.catalog?.models.find((m) => m.id === id)?.label;
        check('helper/antigravity (real-listing shapes): a zero-width suffix is gone, a doubled space and a tab are one space, 300 characters are 80, an invisible name is no label', labelOf('gemini-3.8-flash-high') === 'Gemini 3.8 Flash (High)' && labelOf('claude-opus-5-5-high') === 'Claude Opus 5.5 (High)' && labelOf('gemini-3.8-pro') === 'Gemini 3.8 Pro' && labelOf('gemini-long') === 'N'.repeat(80) && real.catalog?.models.some((m) => m.id === 'gemini-invisible' && !Object.hasOwn(m, 'label')), real.catalog?.models);
        check('helper/antigravity (real-listing shapes): an id the model rule would have to alter (a zero-width character after it) is left out, not repaired', !idsOf(real.catalog).some((id) => id.startsWith('gemini-zw')), idsOf(real.catalog));
        install(
          'cursor-agent',
          `file:${listing(
            'cursor-real',
            [
              'Available models',
              '',
              'auto - Auto',
              'grok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b',
              'composer-2.5 - Composer  2.5\u200b',
              'claude-fable-5-1m-thinking - Claude Fable 5 1M Thinking (NO ZDR)\u200c',
              'cursor-tabbed - Cursor\tTabbed',
              `cursor-long - ${'N'.repeat(300)}`,
              'cursor-invisible - \u200b\u200d\u2060',
              'gemini-3.8-pro - Gemini 3.8 Pro',
              '',
              "Tip: use --model <id>, e.g. --model 'composer-2.5'",
              '',
            ].join('\n'),
          )}`,
        );
        const realC = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        const labelC = (id) => realC.catalog?.models.find((m) => m.id === id)?.label;
        check('helper/cursor (real-listing shapes): `auto`, `composer-*` and `cursor-*` first, then the Grok, Claude and Gemini models marked resold', realC.problems.length === 0 && realC.catalog?.source === 'live' && eq(idsOf(realC.catalog), ['auto', 'composer-2.5', 'cursor-tabbed', 'cursor-long', 'cursor-invisible', 'grok-4.7-low-fast', 'claude-fable-5-1m-thinking', 'gemini-3.8-pro']) && eq(realC.catalog.models.map((m) => m.resold === true), [false, false, false, false, false, true, true, true]), `${realC.problems.join('; ')} — ${clip(realC.res.stdout, 400)}`);
        check('helper/cursor (real-listing shapes): the display names are the CLI\'s, clean — `Auto`, `Grok 4.7 Low Fast`, `Claude Fable 5 1M Thinking (NO ZDR)`: one space, no zero-width character, no tab, at most 80, none for an invisible one, nothing the adapter appends', labelC('auto') === 'Auto' && labelC('composer-2.5') === 'Composer 2.5' && labelC('cursor-tabbed') === 'Cursor Tabbed' && labelC('cursor-long') === 'N'.repeat(80) && labelC('grok-4.7-low-fast') === 'Grok 4.7 Low Fast' && labelC('claude-fable-5-1m-thinking') === 'Claude Fable 5 1M Thinking (NO ZDR)' && labelC('gemini-3.8-pro') === 'Gemini 3.8 Pro' && realC.catalog?.models.some((m) => m.id === 'cursor-invisible' && !Object.hasOwn(m, 'label')), realC.catalog?.models);
        exact['cursor (real-listing shapes)'] = realC.res.stdout.trim();
        install('agy', `file:${listing('agy-none', ['Fetching available models...', 'two words\tRefused', 'semi;colon\tRefused', ''].join('\n'))}`);
        const none = await ask(fx, ['models', 'gemini', dirOf('ag')]);
        check('helper/antigravity: a listing with no usable id is not a catalog — the built-in one answers (`static`)', none.problems.length === 0 && none.catalog?.source === 'static' && idsOf(none.catalog).length > 4, none.catalog ?? none.res.stdout);
        // `agy models` that prints a listing and FAILS: the adapter's live function does not look
        // at the exit code, so the helper has to.
        install('agy', `fail:${listing('agy-fail', ['Fetching available models...', 'from-a-failed-run\tShould not be believed', ''].join('\n'))}`);
        const failed = await ask(fx, ['models', 'gemini', dirOf('ag')]);
        check('helper/antigravity: a listing printed by a run that EXITED 1 is not believed — `static`', failed.problems.length === 0 && failed.catalog?.source === 'static' && !idsOf(failed.catalog).includes('from-a-failed-run'), failed.catalog ?? failed.res.stdout);
      }
      // A CLI that never answers. The helper itself always takes its 25 s budget; providerModels
      // takes `timeoutMs`, so the same behaviour is asked for here in 2.5 s (models-driver.cjs).
      const drive = async (provider, worker, timeoutMs) => {
        const res = await H.runNode([DRIVER, CORE_CJS, provider, dirOf(worker), String(timeoutMs)], { env: fx.env(), cwd: fx.workspace, timeoutMs: 40_000 });
        try {
          return { ...JSON.parse(res.stdout.trim().split('\n').at(-1)), code: res.code, wallMs: res.elapsedMs };
        } catch {
          return { unparseable: clip(res.stdout + res.stderr, 300), code: res.code };
        }
      };
      for (const [provider, cli, worker, mode] of [['cursor', 'cursor-agent', 'cu', 'hang'], ['gemini', 'agy', 'ag', 'hang'], ['cursor', 'cursor-agent', 'cu', 'hang-deaf'], ['gemini', 'agy', 'ag', 'hang-deaf']]) {
        install(cli, mode);
        const known = new Set(fakePids());
        const d = await drive(provider, worker, 2500);
        const started = fakePids().filter((pid) => !known.has(pid));
        await sleep(200);
        const what = mode === 'hang' ? 'never answers' : 'never answers and ignores SIGTERM';
        check(`helper/${provider}: a CLI that ${what} (budget 2.5 s) → the built-in catalog, \`static\`, inside the budget`, d.catalog?.source === 'static' && d.catalog.models.length > 0 && d.catalog.error === null && d.elapsedMs < 3600, d);
        check(`helper/${provider}: …and that CLI is gone when the answer is given`, started.length === 1 && !isPidAlive(started[0]), { started, alive: started.filter(isPidAlive) });
      }
      {
        install('cursor-agent', 'hang');
        const d = await drive('cursor', 'cu', 999_999);
        check('helper: a caller cannot ask for MORE than the 25 s budget (the request is clamped)', d.catalog?.source === 'static' && d.elapsedMs < 24_000 && d.elapsedMs > 15_000, d);
      }
      // A model's own listing line always counts for its name, however many earlier display
      // names hold its id as a word.
      {
        const lines = ['Available models', ''];
        for (let i = 1; i <= 9; i++) lines.push(`m${i} - Like auto ${i}`);
        lines.push('auto - Auto', 'composer-2.5 - Composer 2.5', '', 'Tip: use --model auto', '');
        install('cursor-agent', `file:${listing('cursor-word', lines.join('\n'))}`);
        const a = await ask(fx, ['models', 'cursor', dirOf('cu')]);
        check('helper/cursor: a model whose id is a word in nine EARLIER display names keeps its own label (`auto` → `Auto`)', a.problems.length === 0 && a.catalog?.models[0]?.id === 'auto' && a.catalog.models[0].label === 'Auto' && a.catalog.models.find((m) => m.id === 'm9')?.label === 'Like auto 9', a.catalog?.models.slice(0, 3));
      }

      // ---- The helper's own lifetime: what it started ends with it, and it answers in its budget.
      /** Start the real helper and hand back the process, for the rows that signal it or time it. */
      const startHelper = (args, env = {}) => {
        const child = spawn(process.execPath, [H.PROVIDER_CLI_JS, ...args], { env: fx.env(env), cwd: fx.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
        const started = Date.now();
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', () => {});
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => setTimeout(() => resolve({ code, signal, stdout, elapsedMs: Date.now() - started }), 60)));
        return { child, exited, started };
      };
      const trees = () => readJsonl(vendorLog).filter((r) => r.ev === 'tree');
      const gone = async (pids, withinMs = 1500) => {
        const deadline = Date.now() + withinMs;
        while (pids.some(isPidAlive) && Date.now() < deadline) await sleep(40);
        return pids.filter(isPidAlive);
      };
      // Told to go while a vendor CLI — and that CLI's own child — hang and ignore SIGTERM.
      for (const [what, args, cli, signal, code] of [
        ['models cursor', ['models', 'cursor', dirOf('cu')], 'cursor-agent', 'SIGTERM', 143],
        ['models gemini', ['models', 'gemini', dirOf('ag')], 'agy', 'SIGTERM', 143],
        ['status cursor', ['status', 'cursor', dirOf('cu')], 'cursor-agent', 'SIGTERM', 143],
        ['models cursor', ['models', 'cursor', dirOf('cu')], 'cursor-agent', 'SIGINT', 130],
        ['models cursor', ['models', 'cursor', dirOf('cu')], 'cursor-agent', 'SIGHUP', 129],
      ]) {
        install(cli, 'deaf-tree');
        const before = trees().length;
        const run = startHelper(args);
        const tree = await waitFor(() => trees()[before], { label: `the CLI of \`${what}\` to start`, timeoutMs: 20_000 }).catch(() => undefined);
        await sleep(300);
        const sentAt = Date.now();
        run.child.kill(signal);
        const end = await run.exited;
        const left = tree === undefined ? ['(the CLI never started)'] : await gone([tree.pid, tree.child]);
        check(`helper lifetime: \`${what}\` sent ${signal} while its CLI hangs → the helper exits ${code} at once, and the CLI and the CLI's own child are gone with it`, end.code === code && end.signal === null && Date.now() - sentAt < 3000 && left.length === 0, { end: { code: end.code, signal: end.signal }, ms: Date.now() - sentAt, left });
        // Whatever a build without the handler left behind is ended here, not carried on.
        for (const pid of tree === undefined ? [] : [tree.pid, tree.child]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // gone, as it should be
          }
        }
      }
      // A budget the caller names: the answer comes inside it, and nothing is left behind.
      {
        install('cursor-agent', 'deaf-tree');
        const before = trees().length;
        const run = startHelper(['models', 'cursor', dirOf('cu'), '--budget-ms=3000']);
        const end = await run.exited;
        const tree = trees()[before];
        const left = tree === undefined ? ['(the CLI never started)'] : await gone([tree.pid, tree.child], 500);
        const { problems, catalog } = catalogProblems({ ...end, timedOut: false });
        check('helper budget: `models … --budget-ms=3000` against a CLI that never answers → the built-in catalog inside the three seconds, exit 0, and nothing it started is left', problems.length === 0 && catalog?.source === 'static' && end.elapsedMs < 3600 && end.elapsedMs > 1500 && left.length === 0, { problems, ms: end.elapsedMs, left });
        const beforeS = trees().length;
        const runS = startHelper(['status', 'cursor', dirOf('cu'), '--budget-ms=2000']);
        const endS = await runS.exited;
        const treeS = trees()[beforeS];
        const leftS = treeS === undefined ? ['(the CLI never started)'] : await gone([treeS.pid, treeS.child], 500);
        let status;
        try {
          status = JSON.parse(endS.stdout);
        } catch {
          status = undefined;
        }
        check('helper budget: `status … --budget-ms=2000` against a login check that never answers → an answer inside the two seconds (login unknown, an `error`), exit 0, and the hung check is not left running', endS.code === 0 && status?.loggedIn === null && typeof status?.error === 'string' && endS.elapsedMs < 3000 && leftS.length === 0, { code: endS.code, status, ms: endS.elapsedMs, left: leftS });
      }
      // The budget is counted from the helper's own start: a helper that is slow to load answers
      // by the same moment.
      {
        install('cursor-agent', 'hang-deaf');
        const late = path.join(fx.root, 'late-start.cjs');
        fs.writeFileSync(late, "if (/provider-cli\\.js$/.test(process.argv[1] || '')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); }\n");
        const run = startHelper(['models', 'cursor', dirOf('cu'), '--budget-ms=6000'], { NODE_OPTIONS: `${fx.env().NODE_OPTIONS} --require ${JSON.stringify(late)}` });
        const end = await run.exited;
        const { problems, catalog } = catalogProblems({ ...end, timedOut: false });
        check('helper budget: a helper whose start is 2.5 s late still answers inside its six seconds — the budget runs from its own start, not from when it got going', problems.length === 0 && catalog?.source === 'static' && catalog.models.length > 0 && end.elapsedMs > 2500 && end.elapsedMs < 6600, { problems, ms: end.elapsedMs, catalog });
      }
      // A budget that is not one: the command's bad-invocation answer, and no CLI is started.
      {
        install('cursor-agent', 'hang');
        install('agy', 'hang');
        const started = () => readJsonl(vendorLog).length + fx.vendorLog().length;
        const bad = ['--budget-ms=abc', '--budget-ms=0', '--budget-ms=999', '--budget-ms=1e12', '--budget-ms=3000.5', '--budget-ms=-5', '--budget-ms=+5000', '--budget-ms=05000', '--budget-ms= 5000', '--budget-ms', '--budget-ms='];
        const before = started();
        const wrongM = [];
        for (const tail of [...bad.map((b) => [b]), ['--budget-ms=25001'], ['--budget-ms=5000', '--budget-ms=5000'], ['--budget-ms=5000', 'extra']]) {
          const a = await ask(fx, ['models', 'cursor', dirOf('cu'), ...tail], {}, 20_000);
          if (a.problems.length > 0 || a.catalog?.models.length !== 0 || !/--budget-ms/.test(String(a.catalog?.error)) || a.res.elapsedMs > 5000) wrongM.push({ tail, problems: a.problems, error: a.catalog?.error, ms: a.res.elapsedMs });
        }
        for (const args of [['models', '--budget-ms=5000', 'cursor', dirOf('cu')], ['models', 'cursor', '--budget-ms=5000', dirOf('cu')]]) {
          const a = await ask(fx, args, {}, 20_000);
          if (a.problems.length > 0 || a.catalog?.models.length !== 0 || a.catalog?.error === null || a.res.elapsedMs > 5000) wrongM.push({ args: args.slice(0, 3), problems: a.problems, error: a.catalog?.error });
        }
        check('helper budget: `models` with a budget that is not a whole number, out of 1000–25000, given twice, or anywhere but last → the same shape with an `error`, exit 0, at once', wrongM.length === 0, wrongM);
        const wrongS = [];
        for (const tail of [...bad.map((b) => [b]), ['--budget-ms=20001'], ['--budget-ms=5000', '--budget-ms=5000'], ['--budget-ms=5000', '--quota']]) {
          const res = await helper(fx, ['status', 'cursor', dirOf('cu'), ...tail], {}, 20_000);
          let parsed;
          try {
            parsed = JSON.parse(res.stdout);
          } catch {
            parsed = undefined;
          }
          if (res.code !== 2 || parsed?.loggedIn !== null || parsed?.cliFound !== true || !/--budget-ms/.test(String(parsed?.error)) || res.elapsedMs > 5000) wrongS.push({ tail, code: res.code, out: clip(res.stdout, 160) });
        }
        check('helper budget: `status` with such a budget (its range is 1000–20000) → its bad-invocation answer, exit 2, at once', wrongS.length === 0, wrongS);
        check('helper budget: …and for none of those invocations was a vendor CLI started', started() === before, { before, after: started() });
        const ok = await helper(fx, ['status', 'codex', dirOf('cx'), '--quota', '--budget-ms=5000'], {}, 20_000);
        const edge = await helper(fx, ['status', 'codex', dirOf('cx'), '--budget-ms=20000'], {}, 20_000);
        let okParsed;
        try {
          okParsed = JSON.parse(ok.stdout);
        } catch {
          okParsed = undefined;
        }
        check('helper budget: a budget in range, as the last argument, is taken (`status codex <dir> --quota --budget-ms=5000`; `--budget-ms=20000`)', ok.code === 0 && okParsed?.loggedIn === true && edge.code === 0, { ok: clip(ok.stdout, 120), edge: edge.code });
      }

      console.log('  the helper\'s line, verbatim:');
      for (const [what, lineOut] of Object.entries(exact)) {
        console.log(`    ${what}: ${lineOut}`);
      }
      if (SLOW) {
        install('agy', 'hang');
        const known = new Set(fakePids());
        const a = await ask(fx, ['models', 'gemini', dirOf('ag')], {}, 40_000);
        const started = fakePids().filter((pid) => !known.has(pid));
        check('helper (--slow): the real helper, against a CLI that never answers → an answer before its 25 s are up, `static`, the CLI gone', a.problems.length === 0 && a.catalog?.source === 'static' && a.res.elapsedMs < 25_000 && a.res.elapsedMs > 15_000 && started.length === 1 && !isPidAlive(started[0]), `${a.problems.join('; ')} — ${a.res.elapsedMs} ms`);
      }
    } finally {
      await fx.cleanup();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

async function cleanup() {
  try {
    if (H !== undefined) {
      await H.cleanupAll();
      await H.settleStrays({ timeoutMs: 4000 });
    }
  } catch {
    // best effort
  }
  if (!KEEP) {
    fs.rmSync(BASE, { recursive: true, force: true });
  }
}

async function main() {
  if (path.resolve(os.homedir()) === path.resolve(REAL_HOME)) {
    throw new Error('REFUSING TO RUN: HOME was not redirected');
  }
  console.log(`models — sources: ${SOURCES ?? 'current tree'}; scratch: ${BASE}`);
  await build();
  const core = createRequire(import.meta.url)(CORE_CJS);
  const sections = [
    ['chooser', async () => sectionChooser(core)],
    ['claude', async () => (await harness(), sectionClaude())],
    ['detach', async () => (await harness(), sectionDetach())],
    ['vendor', async () => (await harness(), sectionVendor())],
    ['failover', async () => (await harness(), sectionFailover())],
    ['session', async () => (await harness(), sectionSession())],
    ['transcript', async () => sectionTranscript(core)],
    ['list', async () => (await harness(), sectionList())],
    ['frontier', async () => (await harness(), sectionFrontier())],
    ['ranas', async () => (await harness(), sectionRanAs())],
    ['cancel', async () => (await harness(), sectionCancel())],
    ['reader', async () => sectionReader()],
    ['helper', async () => (await harness(), sectionHelper())],
    ['codexlive', async () => (await harness(), sectionCodexLive(core))],
    ['pinned', async () => (await harness(), sectionPinned(core))],
    ['accounts', async () => (await harness(), sectionAccounts())],
    ['recover', async () => (await harness(), sectionRecover())],
  ];
  for (const [name, run] of sections) {
    if (ONLY !== undefined && !ONLY.has(name)) continue;
    console.log(`\n== ${name}`);
    try {
      await run();
    } catch (err) {
      check(`${name}: the section ran to its end`, false, err && err.stack ? err.stack : String(err));
    }
  }
}

let exitCode = 1;
process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});
main()
  .then(() => {
    exitCode = failures.length === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.log(`FAIL models — ${err && err.stack ? err.stack : err}`);
    failures.push('models');
  })
  .finally(async () => {
    await cleanup();
    const skips = skipped.length > 0 ? `, ${skipped.length} skipped` : '';
    console.log(`\n${passed} passed, ${failures.length} failed${skips}${failures.length > 0 ? `:\n  - ${failures.join('\n  - ')}` : ''}`);
    process.exit(exitCode);
  });
