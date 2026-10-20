// registry.mjs — offline checks of src/registry.ts for the 2.0 fix wave (contract-2.0-fixes §2).
//
//   node .orchestrator/fixes/registry.mjs                 every check, against the live src/
//   node .orchestrator/fixes/registry.mjs --only tokens   only checks whose name contains "tokens"
//   node .orchestrator/fixes/registry.mjs --src <dir>     bundle <dir>/registry.ts instead (a
//                                                         snapshot of src/ — used to show that the
//                                                         checks FAIL on the code before the fixes)
//   node .orchestrator/fixes/registry.mjs --fast          skip the one check that waits out the
//                                                         real 15 s lock timeout
//
// It bundles the source with esbuild into a fresh temp directory, points HOME and USERPROFILE at
// a throwaway directory BEFORE loading the bundle (the module computes its data root when it is
// loaded), and removes everything it made. No agent CLI is ever started and nothing outside the
// temp directory is read or written. Each check prints `PASS <name>` or `FAIL <name> — <why>`;
// the exit code is 0 only when every check passed.
import keychainGuard from './keychain-guard.cjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-registry', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');

const argv = process.argv.slice(2);
function opt(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const SRC = path.resolve(opt('--src', path.join(REPO, 'src')));
const ONLY = opt('--only');
const FAST = argv.includes('--fast');
const POSIX = process.platform !== 'win32';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-registry-'));
const HOME = path.join(WORK, 'home');
fs.mkdirSync(HOME, { recursive: true });
const BUNDLE = path.join(WORK, 'registry.cjs');

await esbuild.build({
  entryPoints: [path.join(SRC, 'registry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: BUNDLE,
  logLevel: 'warning',
});

const SAFE_BUNDLE = path.join(WORK, 'safeFs.cjs');
await esbuild.build({
  entryPoints: [path.join(SRC, 'safeFs.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: SAFE_BUNDLE,
  logLevel: 'warning',
});

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const reg = require(BUNDLE);
const safe = require(SAFE_BUNDLE);
const ROOT = path.join(HOME, '.claude-code-orchestrator');
const REGISTRY = path.join(ROOT, 'registry.json');
const STATS = path.join(ROOT, 'stats.json');
const ORCHESTRATORS = path.join(ROOT, 'orchestrators.json');
const LOG = path.join(ROOT, 'tasks.jsonl');
const TASKS = path.join(ROOT, 'tasks');
assert.equal(reg.REGISTRY_FILE, REGISTRY, 'the bundle did not pick up the redirected HOME');

// ---- plumbing ------------------------------------------------------------------------------

const tally = { pass: 0, fail: 0, skip: 0 };
function oneLine(err) {
  const text = err && err.message ? String(err.message) : String(err);
  return text.replace(/\s+/g, ' ').slice(0, 600);
}
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) {
    return;
  }
  try {
    const verdict = await fn();
    if (verdict === 'skip') {
      tally.skip++;
      console.log(`SKIP ${name}`);
      return;
    }
    tally.pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    tally.fail++;
    console.log(`FAIL ${name} — ${oneLine(err)}`);
  }
}

/** An empty data directory (with its tasks directory), as after a first run. */
function fresh() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(TASKS, { recursive: true });
}
function writeRegistryFile(value) {
  fs.writeFileSync(REGISTRY, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const readFile = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readFile(file));
function appendLines(events) {
  fs.appendFileSync(LOG, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)) + '\n').join(''));
}
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}
function need(name) {
  assert.equal(typeof reg[name], 'function', `the module does not export ${name}()`);
  return reg[name];
}
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const newToken = () => crypto.randomBytes(16).toString('hex');
/** A pid that named a process a moment ago and names none now. */
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(Number.isInteger(done.pid) && done.pid > 1, 'could not make a dead pid');
  return done.pid;
}
/** Run generated CommonJS in a child with the redirected HOME; kill it at `timeoutMs`. */
function runChild(source, { home = HOME, timeoutMs = 30_000, args = [] } = {}) {
  const file = path.join(WORK, `child-${crypto.randomBytes(4).toString('hex')}.cjs`);
  fs.writeFileSync(file, source);
  const done = spawnSync(process.execPath, [file, BUNDLE, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return { ...done, timedOut: done.error?.code === 'ETIMEDOUT' || done.signal === 'SIGTERM' };
}

const CLAUDE_A = { name: 'a', configDir: '/acct/SENTINEL_dirA', model: 'opus' };
const CLAUDE_B = { name: 'b', configDir: '/acct/SENTINEL_dirB', model: 'sonnet', preferred: true };

// ---- §2.1 worker entries: three outcomes ---------------------------------------------------

await check('2.1 provider values: each reads as usable, unsupported or dropped by VALUE', () => {
  const cases = [
    // [provider value (undefined = key absent), expected]
    [undefined, { usable: 'claude' }],
    [null, { usable: 'claude' }],
    ['Claude-Code', { usable: 'claude' }],
    ['claude', { usable: 'claude' }],
    [' agy ', { usable: 'gemini' }],
    ['codex', { usable: 'codex' }],
    ['CURSOR', { usable: 'cursor' }],
    ['bogus', { unsupported: 'bogus' }],
    ['', { unsupported: '' }],
    [0, { unsupported: '(number)' }],
    [false, { unsupported: '(boolean)' }],
    [{}, { unsupported: '(object)' }],
    [[], { unsupported: '(array)' }],
    ['open\ncode\t' + 'x'.repeat(100), { unsupported: null }],
  ];
  for (const [provider, expected] of cases) {
    fresh();
    const entry = { name: 'w', configDir: '/acct/w' };
    if (provider !== undefined) {
      entry.provider = provider;
    }
    writeRegistryFile({ workers: [entry] });
    const r = reg.readRegistry();
    const label = `provider ${JSON.stringify(provider)}`;
    assert.ok(Array.isArray(r.unsupportedWorkers), `${label}: unsupportedWorkers is not an array`);
    if (expected.usable) {
      assert.equal(r.workers.length, 1, `${label}: should be usable`);
      assert.equal(reg.workerProvider(r.workers[0]), expected.usable, `${label}: wrong provider`);
      assert.equal(r.unsupportedWorkers.length, 0, `${label}: must not also be unsupported`);
      assert.equal(
        r.workers[0].provider,
        expected.usable === 'claude' ? undefined : expected.usable,
        `${label}: the profile's provider field`,
      );
    } else {
      assert.equal(r.workers.length, 0, `${label}: must NOT be a usable worker`);
      assert.equal(r.unsupportedWorkers.length, 1, `${label}: should be kept as unsupported`);
      const u = r.unsupportedWorkers[0];
      assert.equal(u.reason, 'provider', `${label}: reason`);
      // Found in workers[]; `source` is where it is WRITTEN, and an entry naming another
      // provider is never written where a pre-2.0 editor runs claude against it.
      assert.equal(u.source, 'vendorWorkers', `${label}: source`);
      assert.equal(u.name, 'w', `${label}: name`);
      assert.deepEqual(u.raw, entry, `${label}: raw must be the entry as parsed`);
      if (expected.unsupported === null) {
        assert.ok(u.providerText.length <= 40 && !/[\n\t]/.test(u.providerText), `${label}: providerText is not one bounded line: ${JSON.stringify(u.providerText)}`);
        assert.ok(u.providerText.startsWith('open code'), `${label}: providerText ${JSON.stringify(u.providerText)}`);
      } else {
        assert.equal(u.providerText, expected.unsupported, `${label}: providerText`);
      }
    }
  }
});

await check('2.1 elements with no usable name are kept, not deleted: unsupported under the name "", written back verbatim after the named ones', () => {
  fresh();
  const namelessInWorkers = [7, 1.5, 'text', null, true, false, [], [{ name: 'in-array', configDir: '/x' }], {}, { configDir: '/acct/noname' }, { name: '   ', configDir: '/acct/blank' }, { name: 5, configDir: '/acct/num' }];
  const namelessInVendor = [3, null, 'x', [], { provider: 'codex', configDir: '/acct/noname2' }];
  const namedShape = { name: 'nodir', model: 'opus' };
  writeRegistryFile({
    workers: [namelessInWorkers[0], namedShape, ...namelessInWorkers.slice(1), CLAUDE_A],
    vendorWorkers: [...namelessInVendor, { name: 'g', configDir: '/acct/g', provider: 'gemini' }, { name: 'future', provider: 'next' }],
    custom: 1,
  });
  const before = readFile(REGISTRY);
  const r = reg.readRegistry();
  // They take part in nothing.
  assert.deepEqual(r.workers.map((w) => w.name), ['a', 'g']);
  const nameless = r.unsupportedWorkers.filter((u) => u.name === '');
  assert.equal(nameless.length, namelessInWorkers.length + namelessInVendor.length, 'an element with no usable name was dropped on read');
  for (const u of nameless) {
    assert.deepEqual([u.reason, u.providerText === '' || u.providerText === 'codex'], ['shape', true]);
  }
  assert.deepEqual(nameless.filter((u) => u.source === 'workers').map((u) => u.raw), namelessInWorkers, 'nameless elements of workers[]: raw / order');
  assert.deepEqual(nameless.filter((u) => u.source === 'vendorWorkers').map((u) => u.raw), namelessInVendor, 'nameless elements of vendorWorkers[]: raw / order');
  assert.equal(nameless.find((u) => isPlainObject(u.raw) && u.raw.provider === 'codex').providerText, 'codex');
  // In memory: per array, the named ones first.
  assert.deepEqual(r.unsupportedWorkers.map((u) => `${u.source}:${u.name}`).filter((s, i, all) => all.indexOf(s) === i), ['workers:nodir', 'workers:', 'vendorWorkers:future', 'vendorWorkers:']);

  reg.updateRegistry((x) => {
    x.cooldownMinutes = 31;
  });
  const one = readFile(REGISTRY);
  const file = JSON.parse(one);
  assert.deepEqual(file.workers.slice(1), [namedShape, ...namelessInWorkers], 'workers[]: usable, then named unsupported, then the nameless ones verbatim in their original order');
  assert.deepEqual(file.vendorWorkers.slice(1), [{ name: 'future', provider: 'next' }, ...namelessInVendor], 'vendorWorkers[]: same layout');
  assert.equal(file.custom, 1);
  reg.writeRegistry(reg.readRegistry());
  assert.equal(readFile(REGISTRY), one, 'a second write changed the file');
  assert.deepEqual(reg.readRegistry(), reg.readRegistry());
  assert.notEqual(before, one);
  // A nameless element can be removed only by an explicit array, like any other.
  reg.updateRegistry((x) => {
    x.unsupportedWorkers = x.unsupportedWorkers.filter((u) => u.raw !== null);
  });
  const after = readJson(REGISTRY);
  assert.ok(!after.workers.includes(null) && !after.vendorWorkers.includes(null), 'an explicit removal did not remove the null elements');
  assert.ok(after.workers.includes(7) && after.vendorWorkers.includes('x'));
});

await check('2.1 shape: no configDir, or a Claude entry in vendorWorkers, is unsupported (not dropped, not usable)', () => {
  fresh();
  const noDir = { name: 'nodir', model: 'opus' };
  const blankDir = { name: 'blankdir', configDir: '  ' };
  const numDir = { name: 'numdir', configDir: 42, provider: 'codex' };
  const claudeInVendor = { name: 'cl', configDir: '/acct/cl' };
  const nullInVendor = { name: 'cl2', configDir: '/acct/cl2', provider: null };
  writeRegistryFile({ workers: [noDir, blankDir, numDir, CLAUDE_A], vendorWorkers: [claudeInVendor, nullInVendor] });
  const r = reg.readRegistry();
  assert.deepEqual(r.workers.map((w) => w.name), ['a']);
  assert.deepEqual(
    r.unsupportedWorkers.map((u) => [u.name, u.reason, u.source, u.providerText]),
    [
      ['nodir', 'shape', 'workers', ''],
      ['blankdir', 'shape', 'workers', ''],
      // It names a provider other than Claude Code, so it is written under vendorWorkers.
      ['numdir', 'shape', 'vendorWorkers', 'codex'],
      ['cl', 'shape', 'vendorWorkers', ''],
      ['cl2', 'shape', 'vendorWorkers', ''],
    ],
  );
  assert.deepEqual(r.unsupportedWorkers[0].raw, noDir);
});

// What 1.5.3 does with this file (git show 18fdc5f:src/registry.ts, readRegistry / writeRegistry):
// every element of `workers` is a Claude account, every key it does not know is spread through.
const DEFAULTS_153 = { workers: [], permissionMode: 'acceptEdits', claudePath: 'claude', cooldownMinutes: 30, workerTimeoutMinutes: 45, frontierWorkerDispatch: 'block', overageWorkerDispatch: 'block', meshMode: 'off', meshWorkerIdleTimeoutMin: 30, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, meshGatewayModel: 'haiku' };
function readAs153(text) {
  const raw = JSON.parse(text);
  return { ...DEFAULTS_153, ...raw, workers: raw.workers ?? [], overageWorkerDispatch: raw.overageWorkerDispatch === 'allow' ? 'allow' : 'block', meshMode: raw.meshMode === 'on' ? 'on' : 'off' };
}
/** Does this element name a provider other than Claude Code — by any spelling of "not Claude"? */
function namesAnotherProvider(element) {
  if (!isPlainObject(element) || element.provider === undefined || element.provider === null) {
    return false;
  }
  return typeof element.provider !== 'string' || !['claude', 'claude-code'].includes(element.provider.trim().toLowerCase());
}

await check('2.1 a pre-2.0 editor reading a file this version wrote sees no element in workers[] that names another provider, and keeps vendorWorkers', () => {
  fresh();
  const messy = {
    workers: [
      CLAUDE_A,
      { name: 'cx', configDir: '/acct/cx', provider: 'codex', model: 'gpt-5.5' }, // usable vendor
      { name: 'oc', configDir: '/acct/oc', provider: 'opencode' }, // unknown provider
      { name: 'nodir-cx', provider: 'codex' }, // known vendor, no directory
      { name: 'cx', configDir: '/acct/cx-two', provider: 'codex' }, // duplicate name, vendor
      { name: 'a', configDir: '/acct/a-two' }, // duplicate name, Claude
      { name: 'p0', configDir: '/acct/p0', provider: 0 }, // a provider that is not text
      { name: 'pe', configDir: '/acct/pe', provider: '' }, // an empty provider
      { configDir: '/acct/nameless-weird', provider: 'weird' }, // no name, another provider
      { configDir: '/acct/nameless-cx', provider: ' Codex ' }, // no name, a known vendor
      { configDir: '/acct/nameless-claude' }, // no name, no provider
      { name: 'cl-named', provider: 'Claude-Code' }, // Claude by name, no directory
      7,
      null,
      'text',
      CLAUDE_B,
    ],
    vendorWorkers: [{ name: 'future', provider: 'next' }, { name: 'g', configDir: '/acct/g', provider: 'gemini' }],
    custom: { keep: true },
  };
  writeRegistryFile(messy);
  reg.updateRegistry(() => {});
  const written = readFile(REGISTRY);
  const old = readAs153(written);
  const offenders = old.workers.filter(namesAnotherProvider);
  assert.deepEqual(offenders, [], 'a pre-2.0 editor would run claude against these');
  // Everything that names another provider is under vendorWorkers instead — nothing was deleted.
  const file = JSON.parse(written);
  const expectedVendor = messy.workers.filter(namesAnotherProvider).length + messy.vendorWorkers.length;
  assert.equal(file.vendorWorkers.length, expectedVendor, 'an element naming another provider was lost on the way to vendorWorkers');
  assert.equal(file.workers.length, messy.workers.length - messy.workers.filter(namesAnotherProvider).length, 'an element of workers[] was lost');
  for (const kept of [messy.workers[2], messy.workers[3], messy.workers[4], messy.workers[6], messy.workers[7], messy.workers[8], messy.workers[9], messy.vendorWorkers[0]]) {
    assert.ok(file.vendorWorkers.some((e) => JSON.stringify(e) === JSON.stringify(kept)), `not kept verbatim under vendorWorkers: ${JSON.stringify(kept)}`);
  }
  for (const kept of [messy.workers[5], messy.workers[10], messy.workers[11], 7, null, 'text']) {
    assert.ok(file.workers.some((e) => JSON.stringify(e) === JSON.stringify(kept)), `not kept verbatim under workers: ${JSON.stringify(kept)}`);
  }
  // The old editor adds a Claude account and writes the file back its own way.
  old.workers.push({ name: 'added-by-1x', configDir: '/acct/old', model: 'claude-opus-4-8' });
  fs.writeFileSync(REGISTRY, JSON.stringify(old, null, 2));
  assert.deepEqual(readJson(REGISTRY).vendorWorkers, file.vendorWorkers, 'vendorWorkers did not survive the old editor');
  const back = reg.readRegistry();
  assert.deepEqual(back.workers.map((w) => `${w.name}:${reg.workerProvider(w)}`), ['a:claude', 'b:claude', 'added-by-1x:claude', 'cx:codex', 'g:gemini']);
  // And this version's next write is stable and still clean for the old editor.
  reg.updateRegistry(() => {});
  const again = readFile(REGISTRY);
  assert.deepEqual(readAs153(again).workers.filter(namesAnotherProvider), []);
  reg.updateRegistry(() => {});
  assert.equal(readFile(REGISTRY), again, 'a further write changed the file');
  // The writer keeps the rule even for an object whose `source` says otherwise.
  const forced = reg.readRegistry();
  for (const u of forced.unsupportedWorkers) {
    u.source = 'workers';
  }
  reg.writeRegistry(forced);
  assert.deepEqual(readAs153(readFile(REGISTRY)).workers.filter(namesAnotherProvider), [], 'a caller-set source put a vendor entry under workers[]');
});

await check('2.1 duplicates: same account is dropped, same name is unsupported (duplicate-name)', () => {
  fresh();
  const sameAccount = { name: 'a-again', configDir: '/acct/SENTINEL_dirA/' };
  const sameName = { name: 'a', configDir: '/acct/other', model: 'sonnet' };
  const sameBoth = { name: 'a', configDir: '/acct/SENTINEL_dirA' };
  // The same directory under ANOTHER provider is a different account.
  const codexSameDir = { name: 'cx', configDir: '/acct/SENTINEL_dirA', provider: 'codex' };
  writeRegistryFile({ workers: [CLAUDE_A, sameAccount, sameName, sameBoth], vendorWorkers: [codexSameDir] });
  const r = reg.readRegistry();
  assert.deepEqual(r.workers.map((w) => [w.name, reg.workerProvider(w)]), [['a', 'claude'], ['cx', 'codex']]);
  assert.deepEqual(r.unsupportedWorkers.map((u) => [u.name, u.reason, u.source]), [['a', 'duplicate-name', 'workers']]);
  assert.deepEqual(r.unsupportedWorkers[0].raw, sameName);
});

await check('2.1 a duplicate name whose account a usable entry serves is an account duplicate (dropped), and the read is a fixed point', () => {
  fresh();
  // B repeats A's name; C (later) is the same account as B under its own name.
  writeRegistryFile({ workers: [CLAUDE_A, { name: 'a', configDir: '/acct/two' }, { name: 'c', configDir: '/acct/two' }] });
  const first = reg.readRegistry();
  assert.deepEqual(first.workers.map((w) => w.name), ['a', 'c']);
  assert.deepEqual(first.unsupportedWorkers, []);
  reg.writeRegistry(first);
  const one = readFile(REGISTRY);
  reg.writeRegistry(reg.readRegistry());
  assert.equal(readFile(REGISTRY), one, 'a second write changed the file');
});

await check('2.1 order: registry.workers is the Claude entries in file order, then the vendor entries in file order', () => {
  fresh();
  writeRegistryFile({
    workers: [{ name: 'cx-early', configDir: '/acct/cx1', provider: 'codex' }, CLAUDE_A, { name: 'g', configDir: '/acct/g', provider: 'antigravity' }, CLAUDE_B],
    vendorWorkers: [{ name: 'cur', configDir: '/acct/cur', provider: 'cursor' }, { name: 'cx-late', configDir: '/acct/cx2', provider: 'codex' }],
  });
  const r = reg.readRegistry();
  assert.deepEqual(r.workers.map((w) => w.name), ['a', 'b', 'cx-early', 'g', 'cur', 'cx-late']);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'vendorWorkers'), false, 'vendorWorkers is a key of the file, not of the object');
});

await check('2.1 a vendor entry that precedes a Claude entry of the same name in workers[]: one stable winner across writes', () => {
  fresh();
  writeRegistryFile({ workers: [{ name: 'x', configDir: '/acct/vx', provider: 'codex' }, { name: 'x', configDir: '/acct/cx' }] });
  const usable = () => reg.readRegistry().workers.map((w) => `${w.name}:${reg.workerProvider(w)}:${w.configDir}`);
  const before = usable();
  assert.equal(before.length, 1, 'exactly one usable worker may hold the name');
  reg.updateRegistry(() => {});
  const one = readFile(REGISTRY);
  assert.deepEqual(usable(), before, 'the name changed hands after one write');
  reg.updateRegistry(() => {});
  assert.equal(readFile(REGISTRY), one, 'a second write changed the file');
  assert.deepEqual(usable(), before, 'the name changed hands after two writes');
  assert.equal(reg.readRegistry().unsupportedWorkers.length, 1, 'the other entry must still be kept');
});

await check('2.1 a workers / vendorWorkers value that is present and not a list is a registry that could not be read: a problem, and no write', () => {
  const readChecked = need('readRegistryChecked');
  for (const key of ['workers', 'vendorWorkers']) {
    for (const value of [{ a: { name: 'SENTINEL_inside', configDir: '/acct/x' } }, 'SENTINEL_text', 7, true, false, 0, '']) {
      fresh();
      const text = JSON.stringify({ [key]: value, frontierWorkerDispatch: 'allow', custom: 'SENTINEL_custom' }, null, 2);
      writeRegistryFile(text);
      const checked = readChecked();
      const label = `${key}: ${JSON.stringify(value)}`;
      assert.equal(checked.problem, `its "${key}" value is not a list`, label);
      assert.deepEqual(checked.registry.workers, [], label);
      assert.deepEqual(checked.registry.unsupportedWorkers, [], label);
      assert.deepEqual(reg.readRegistry(), checked.registry, `${label}: readRegistry and readRegistryChecked disagree`);
      let mutated = false;
      const fromUpdate = thrown(() =>
        reg.updateRegistry((r) => {
          mutated = true;
          r.workers.push({ name: 'new', configDir: '/acct/new', model: 'opus' });
        }),
      );
      const fromWrite = thrown(() => reg.writeRegistry(reg.readRegistry()));
      for (const err of [fromUpdate, fromWrite]) {
        assert.ok(err instanceof Error, `${label}: a writer did not refuse`);
        assert.equal(need('isStateWriteRefusal')(err), true, `${label}: ${err.message}`);
        assert.ok(!err.message.includes('SENTINEL'), `${label}: the refusal quotes the file`);
      }
      assert.equal(mutated, false, `${label}: mutate ran`);
      assert.equal(readFile(REGISTRY), text, `${label}: the file was written over`);
    }
  }
  // Absent and null both mean "no entries" — a 1.x file may lack either key — and can be written.
  for (const shape of [{}, { workers: null }, { vendorWorkers: null }, { workers: null, vendorWorkers: null }, { workers: [], vendorWorkers: null }]) {
    fresh();
    writeRegistryFile({ ...shape, custom: 1 });
    const checked = readChecked();
    assert.equal(checked.problem, null, JSON.stringify(shape));
    assert.deepEqual(checked.registry.workers, []);
    reg.updateRegistry((r) => {
      r.workers.push({ name: 'new', configDir: '/acct/new', model: 'opus' });
    });
    const file = readJson(REGISTRY);
    assert.deepEqual(file.workers.map((w) => w.name), ['new'], JSON.stringify(shape));
    assert.ok(!('vendorWorkers' in file) && file.custom === 1);
  }
  // Both wrong: the first is the one named.
  fresh();
  writeRegistryFile({ workers: 'x', vendorWorkers: 'y' });
  assert.equal(readChecked().problem, 'its "workers" value is not a list');
});

await check('2.1 workerProvider throws for a provider that is present and unknown; absent is Claude Code', () => {
  assert.equal(reg.workerProvider({}), 'claude');
  assert.equal(reg.workerProvider({ provider: undefined }), 'claude');
  assert.equal(reg.workerProvider({ provider: 'codex' }), 'codex');
  for (const provider of ['bogus', '', 0, false, {}, []]) {
    const err = thrown(() => reg.workerProvider({ provider }));
    assert.ok(err instanceof TypeError, `provider ${JSON.stringify(provider)} must throw a TypeError`);
    assert.match(err.message, /unknown provider/);
  }
});

// ---- §2.1 unsupported entries: kept out, written back --------------------------------------

const UNSUPPORTED_NEW = { name: 'oc', configDir: '/acct/SENTINEL_opencode', provider: 'opencode', model: 'big-pickle', permissionMode: 'full-auto', nested: { list: [1, { deep: true }], n: null } };
const UNSUPPORTED_VENDOR = { name: 'future', provider: 'codex-next', home: '/acct/future', flags: ['x'] };
// No directory. One names no provider and stays in workers[]; one names a vendor and does not.
const UNSUPPORTED_SHAPE = { name: 'nodir', model: 'opus', note: 'no directory' };
const UNSUPPORTED_SHAPE_VENDOR = { name: 'nodir-cx', provider: 'codex' };
const VENDOR_IN_WORKERS = { name: 'cx', configDir: '/acct/cx', provider: 'codex', model: 'gpt-5.5' };
const MIXED = {
  workers: [CLAUDE_A, UNSUPPORTED_NEW, VENDOR_IN_WORKERS, CLAUDE_B, UNSUPPORTED_SHAPE, UNSUPPORTED_SHAPE_VENDOR],
  vendorWorkers: [UNSUPPORTED_VENDOR, { name: 'g', configDir: '/acct/g', provider: 'gemini' }],
  custom: { keep: ['me'] },
};

await check('2.1 an unsupported entry is in no enumeration: not in registry.workers, not in claudeWorkers()', () => {
  fresh();
  writeRegistryFile(MIXED);
  const r = reg.readRegistry();
  const names = r.workers.map((w) => w.name);
  assert.deepEqual(names, ['a', 'b', 'cx', 'g']);
  assert.deepEqual(reg.claudeWorkers(r).map((w) => w.name), ['a', 'b']);
  for (const hidden of ['oc', 'future', 'nodir', 'nodir-cx']) {
    assert.ok(!names.includes(hidden), `${hidden} leaked into registry.workers`);
  }
  // In the order they are written: the one under workers[], then those under vendorWorkers[].
  assert.deepEqual(r.unsupportedWorkers.map((u) => `${u.source}:${u.name}`), ['workers:nodir', 'vendorWorkers:oc', 'vendorWorkers:nodir-cx', 'vendorWorkers:future']);
});

await check('2.1 an unsupported entry survives updateRegistry and writeRegistry deep-equal, in the array it is written to, across two writes', () => {
  fresh();
  writeRegistryFile(MIXED);
  const assertKept = (label) => {
    const file = readJson(REGISTRY);
    assert.deepEqual(file.workers.filter((e) => e.name === 'nodir'), [UNSUPPORTED_SHAPE], `${label}: the entry that names no provider stays in workers[]`);
    assert.deepEqual(
      file.vendorWorkers.filter((e) => ['oc', 'nodir-cx', 'future'].includes(e.name)),
      [UNSUPPORTED_NEW, UNSUPPORTED_SHAPE_VENDOR, UNSUPPORTED_VENDOR],
      `${label}: entries that name another provider, under vendorWorkers[]`,
    );
    assert.deepEqual(file.workers.filter(namesAnotherProvider), [], `${label}: an element of workers[] names another provider`);
    assert.ok(!('unsupportedWorkers' in file), `${label}: unsupportedWorkers must never be a key of the file`);
    assert.deepEqual(file.custom, MIXED.custom, `${label}: an unknown top-level key was lost`);
  };
  reg.updateRegistry((r) => {
    r.cooldownMinutes = 31;
  });
  assertKept('after updateRegistry');
  reg.writeRegistry(reg.readRegistry());
  assertKept('after writeRegistry');
  const two = readFile(REGISTRY);
  reg.updateRegistry((r) => {
    r.cooldownMinutes = 31;
  });
  assert.equal(readFile(REGISTRY), two, 'a third write of the same registry changed the bytes');
});

await check('2.1 a vendor entry found in workers[] is written back under vendorWorkers', () => {
  fresh();
  writeRegistryFile(MIXED);
  reg.updateRegistry(() => {});
  const file = readJson(REGISTRY);
  assert.ok(!file.workers.some((e) => e.name === 'cx'), 'the codex entry is still in workers[] — a pre-2.0 editor would run claude against it');
  assert.deepEqual(file.vendorWorkers.filter((e) => e.name === 'cx').map((e) => e.provider), ['codex']);
  for (const e of file.workers.filter((w) => ['a', 'b'].includes(w.name))) {
    assert.ok(!('provider' in e), 'a Claude entry must carry no provider key');
  }
});

await check('2.1 a Claude-only registry: write(read(f)) twice gives identical bytes and no vendorWorkers key', () => {
  fresh();
  // What 1.5.3 writes: dated model ids, its own top-level keys, a key this version does not know.
  writeRegistryFile({
    workers: [{ name: 'a', configDir: '/acct/a', model: 'claude-opus-4-8', preferred: true }, { name: 'b', configDir: '/acct/b', model: 'claude-sonnet-5' }],
    permissionMode: 'acceptEdits',
    claudePath: 'claude',
    cooldownMinutes: 30,
    workerTimeoutMinutes: 45,
    frontierWorkerDispatch: 'allow',
    frontierGuardSetBy: 'Visual Studio Code',
    overageWorkerDispatch: 'block',
    meshMode: 'on',
    someFutureKey: { a: [1, 2, 3] },
  });
  reg.writeRegistry(reg.readRegistry());
  const one = readFile(REGISTRY);
  reg.writeRegistry(reg.readRegistry());
  const two = readFile(REGISTRY);
  assert.equal(two, one, 'the second write changed the file');
  const file = JSON.parse(two);
  assert.ok(!('vendorWorkers' in file), 'a Claude-only registry gained a vendorWorkers key');
  assert.ok(!('unsupportedWorkers' in file));
  assert.deepEqual(file.someFutureKey, { a: [1, 2, 3] });
  assert.equal(file.frontierWorkerDispatch, 'allow');
  assert.deepEqual(file.workers.map((w) => w.name), ['a', 'b']);
});

await check('2.1 two reads of an unchanged file are deep-equal (unsupportedWorkers included)', () => {
  fresh();
  writeRegistryFile(MIXED);
  assert.deepEqual(reg.readRegistry(), reg.readRegistry());
  const checked = need('readRegistryChecked')();
  assert.deepEqual(checked.registry, reg.readRegistry());
  assert.equal(checked.problem, null);
});

await check('2.1 a hand-built object WITHOUT unsupportedWorkers does not delete the entries in the file; an explicit array does', () => {
  fresh();
  writeRegistryFile(MIXED);
  const handBuilt = reg.readRegistry();
  delete handBuilt.unsupportedWorkers;
  handBuilt.cooldownMinutes = 12;
  reg.writeRegistry(handBuilt);
  let file = readJson(REGISTRY);
  assert.equal(file.cooldownMinutes, 12);
  const keptInVendor = (file) => file.vendorWorkers.filter((e) => ['oc', 'nodir-cx', 'future'].includes(e.name));
  assert.deepEqual(file.workers.filter((e) => e.name === 'nodir'), [UNSUPPORTED_SHAPE], 'absence deleted the unsupported entry of workers[]');
  assert.deepEqual(keptInVendor(file), [UNSUPPORTED_NEW, UNSUPPORTED_SHAPE_VENDOR, UNSUPPORTED_VENDOR], 'absence deleted the unsupported entries of vendorWorkers[]');

  // Not an array at all is absence too.
  reg.writeRegistry({ ...reg.readRegistry(), unsupportedWorkers: undefined });
  reg.updateRegistry((r) => {
    r.unsupportedWorkers = null;
  });
  file = readJson(REGISTRY);
  assert.equal(file.workers.filter((e) => e.name === 'nodir').length + keptInVendor(file).length, 4, 'a non-array unsupportedWorkers deleted entries');

  // Only an explicit array with the entry removed removes it — and only that one.
  reg.updateRegistry((r) => {
    const at = r.unsupportedWorkers.findIndex((u) => u.name === 'oc');
    r.unsupportedWorkers.splice(at, 1);
  });
  file = readJson(REGISTRY);
  assert.ok(!file.workers.some((e) => e.name === 'oc') && !file.vendorWorkers.some((e) => e.name === 'oc'), 'an explicit removal did not remove the entry');
  assert.deepEqual(file.workers.filter((e) => e.name === 'nodir'), [UNSUPPORTED_SHAPE]);
  assert.deepEqual(keptInVendor(file), [UNSUPPORTED_SHAPE_VENDOR, UNSUPPORTED_VENDOR]);
});

await check('2.1 a malformed unsupportedWorkers entry, or a worker with an unknown provider, refuses the write and changes nothing', () => {
  fresh();
  writeRegistryFile(MIXED);
  const before = readFile(REGISTRY);
  const bad = reg.readRegistry();
  bad.unsupportedWorkers.push({ name: 'no-raw', reason: 'provider', providerText: '', source: 'workers' });
  assert.ok(thrown(() => reg.writeRegistry(bad)) instanceof TypeError, 'a malformed unsupported entry must throw');
  assert.equal(readFile(REGISTRY), before);
  for (const malformed of [null, 7, 'x', [], { raw: {}, source: 'elsewhere' }, { raw: {} }, { source: 'workers', raw: undefined }]) {
    const withIt = reg.readRegistry();
    withIt.unsupportedWorkers.push(malformed);
    assert.ok(thrown(() => reg.writeRegistry(withIt)) instanceof TypeError, `accepted a malformed entry: ${JSON.stringify(malformed)}`);
    assert.equal(readFile(REGISTRY), before);
  }
  const cast = reg.readRegistry();
  cast.workers.push({ name: 'z', configDir: '/acct/z', model: 'opus', provider: 'bogus' });
  assert.ok(thrown(() => reg.writeRegistry(cast)) instanceof TypeError, 'a worker with an unknown provider must throw');
  assert.equal(readFile(REGISTRY), before);
});

// ---- §2.2 a registry that cannot be read is never written over -----------------------------

const GOOD = { workers: [CLAUDE_A, CLAUDE_B], frontierWorkerDispatch: 'allow', custom: 'SENTINEL_custom' };
const GOOD_TEXT = JSON.stringify(GOOD, null, 2);
const UNREADABLE = {
  'trailing comma': GOOD_TEXT.replace(/\n}$/, ',\n}'),
  'merge markers': `<<<<<<< HEAD\n${GOOD_TEXT}\n=======\n{}\n>>>>>>> SENTINEL_branch\n`,
  'merge markers inside': GOOD_TEXT.replace('"frontierWorkerDispatch"', '<<<<<<< SENTINEL_branch\n  "frontierWorkerDispatch"'),
  truncated: GOOD_TEXT.slice(0, 60),
  'a JSON array': '[1,2,"SENTINEL_array"]',
  'a JSON string': '"SENTINEL_string"',
  'a JSON number': '42',
  'a JSON null': 'null',
  'not JSON at all': 'SENTINEL_words are not json',
};

/** No piece of the file may ride out in a message: no sentinel, and no line of the file. */
function assertNoFileContent(message, text, label) {
  assert.ok(!message.includes('SENTINEL'), `${label}: the message quotes the file: ${message}`);
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 6)) {
    assert.ok(!message.includes(line), `${label}: the message quotes a line of the file (${line}): ${message}`);
  }
}

for (const [label, text] of Object.entries(UNREADABLE)) {
  await check(`2.2 unreadable registry (${label}): reads with a problem, both writers refuse, bytes unchanged`, () => {
    fresh();
    writeRegistryFile(text);
    const checked = need('readRegistryChecked')();
    assert.equal(typeof checked.problem, 'string', 'readRegistryChecked reported no problem');
    assert.ok(checked.problem.length > 0 && checked.problem.length <= 200 && !/[\r\n]/.test(checked.problem), `problem is not one bounded line: ${JSON.stringify(checked.problem)}`);
    assertNoFileContent(checked.problem, text, 'problem');
    assert.deepEqual(checked.registry.workers, []);
    assert.deepEqual(reg.readRegistry(), checked.registry, 'readRegistry and readRegistryChecked disagree');

    let mutated = false;
    const fromUpdate = thrown(() =>
      reg.updateRegistry((r) => {
        mutated = true;
        r.cooldownMinutes = 31;
      }),
    );
    assert.ok(fromUpdate instanceof Error, 'updateRegistry did not throw');
    assert.equal(mutated, false, 'mutate ran on a registry that could not be read');
    assert.equal(readFile(REGISTRY), text, 'updateRegistry changed the file');
    const fromWrite = thrown(() => reg.writeRegistry(reg.readRegistry()));
    assert.ok(fromWrite instanceof Error, 'writeRegistry did not throw');
    assert.equal(readFile(REGISTRY), text, 'writeRegistry changed the file');
    for (const err of [fromUpdate, fromWrite]) {
      assert.equal(need('isStateWriteRefusal')(err), true, `not recognised as a refusal: ${err.message}`);
      assert.ok(err.message.startsWith(`Could not read ${REGISTRY}: `), err.message);
      assert.ok(err.message.endsWith(' — nothing was changed. Fix the file or delete it.'), err.message);
      assertNoFileContent(err.message.replace(REGISTRY, ''), text, 'error');
    }
    assert.deepEqual(fs.readdirSync(ROOT).filter((n) => n.startsWith('registry.json')).sort(), ['registry.json'], 'something was left beside the registry');
  });
}

await check('2.2 a BOM in front of a valid registry reads normally and can be updated', () => {
  fresh();
  writeRegistryFile('﻿' + GOOD_TEXT);
  const checked = need('readRegistryChecked')();
  assert.equal(checked.problem, null);
  assert.deepEqual(checked.registry.workers.map((w) => w.name), ['a', 'b']);
  assert.equal(checked.registry.frontierWorkerDispatch, 'allow');
  reg.updateRegistry((r) => {
    r.cooldownMinutes = 31;
  });
  const file = readJson(REGISTRY);
  assert.deepEqual(file.workers.map((w) => w.name), ['a', 'b']);
  assert.equal(file.custom, 'SENTINEL_custom');
  assert.equal(file.cooldownMinutes, 31);
});

await check('2.2 a missing, empty or whitespace-only registry is a fresh one: no problem, and it can be written', () => {
  for (const [label, text] of [['missing', null], ['empty', ''], ['whitespace', ' \n\t\r\n '], ['only a BOM', '﻿'], ['BOM and whitespace', '﻿ \n']]) {
    fresh();
    if (text !== null) {
      writeRegistryFile(text);
    }
    const checked = need('readRegistryChecked')();
    assert.equal(checked.problem, null, `${label}: reported a problem`);
    assert.deepEqual(checked.registry.workers, []);
    reg.updateRegistry((r) => {
      r.workers.push({ name: 'new', configDir: '/acct/new', model: 'opus' });
    });
    assert.deepEqual(readJson(REGISTRY).workers.map((w) => w.name), ['new'], `${label}: could not be written`);
  }
});

await check('2.2 a registry larger than 1 MiB, or unreadable by mode, has a problem and is not written over', () => {
  fresh();
  const big = JSON.stringify({ workers: [CLAUDE_A], pad: 'x'.repeat(1024 * 1024) });
  writeRegistryFile(big);
  let checked = need('readRegistryChecked')();
  assert.equal(checked.problem, 'larger than 1 MiB');
  assert.ok(need('isStateWriteRefusal')(thrown(() => reg.updateRegistry(() => {}))));
  assert.equal(fs.statSync(REGISTRY).size, Buffer.byteLength(big));

  if (!POSIX || process.getuid() === 0) {
    return;
  }
  fresh();
  writeRegistryFile(GOOD_TEXT);
  fs.chmodSync(REGISTRY, 0o000);
  try {
    checked = reg.readRegistryChecked();
    assert.equal(checked.problem, 'EACCES');
    const err = thrown(() => reg.updateRegistry(() => {}));
    assert.ok(reg.isStateWriteRefusal(err), 'an unreadable-by-mode registry was written over');
  } finally {
    fs.chmodSync(REGISTRY, 0o600);
  }
  assert.equal(readFile(REGISTRY), GOOD_TEXT);
});

await check('2.2 a FIFO or a directory at the registry path refuses, and does not hang', () => {
  if (!POSIX) {
    return 'skip';
  }
  const child = `
    const fs = require('fs'), path = require('path'), os = require('os');
    const reg = require(process.argv[2]);
    const out = {};
    const checked = typeof reg.readRegistryChecked === 'function' ? reg.readRegistryChecked() : { problem: '(no readRegistryChecked)' };
    out.problem = checked.problem;
    try { reg.updateRegistry((r) => { r.cooldownMinutes = 31; }); out.update = 'wrote'; }
    catch (e) { out.update = String(e.message); out.refusal = typeof reg.isStateWriteRefusal === 'function' && reg.isStateWriteRefusal(e); }
    try { reg.writeRegistry(reg.readRegistry()); out.write = 'wrote'; }
    catch (e) { out.write = String(e.message); }
    const st = fs.lstatSync(reg.REGISTRY_FILE);
    out.kind = st.isFIFO() ? 'fifo' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
    process.stdout.write(JSON.stringify(out));
  `;
  for (const kind of ['fifo', 'directory']) {
    const home = fs.mkdtempSync(path.join(WORK, `home-${kind}-`));
    const root = path.join(home, '.claude-code-orchestrator');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'registry.json');
    if (kind === 'fifo') {
      assert.equal(spawnSync('mkfifo', [file]).status, 0, 'mkfifo failed');
    } else {
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, 'inside'), 'SENTINEL_inside');
    }
    const done = runChild(child, { home, timeoutMs: 20_000 });
    assert.equal(done.timedOut, false, `${kind}: the child hung`);
    assert.equal(done.status, 0, `${kind}: the child failed: ${done.stderr}`);
    const out = JSON.parse(done.stdout);
    assert.equal(out.problem, 'not a regular file', `${kind}: problem`);
    assert.equal(out.refusal, true, `${kind}: updateRegistry was not refused: ${out.update}`);
    assert.notEqual(out.write, 'wrote', `${kind}: writeRegistry wrote over it`);
    assert.equal(out.kind, kind, `${kind}: what is at the path changed`);
    if (kind === 'directory') {
      assert.equal(readFile(path.join(file, 'inside')), 'SENTINEL_inside');
    }
  }
});

await check('2.2 isStateWriteRefusal: true only for the two refusals, total for anything else', () => {
  const is = need('isStateWriteRefusal');
  for (const value of [undefined, null, 0, 'Could not lock x', {}, { message: 'Could not lock x' }, new Error('boom'), new Error('Could not read something else'), new TypeError('x')]) {
    assert.equal(is(value), false, `wrongly a refusal: ${String(value && value.message ? value.message : value)}`);
  }
  assert.equal(is(new Error('Could not lock registry.json: its lock stayed busy')), true, 'the lock timeout error is a refusal');
});

await check('2.2 stats.json / orchestrators.json: a damaged one is set aside as .damaged before it is replaced', () => {
  for (const [file, write, expectKey] of [
    [STATS, () => reg.updateStats((s) => { s.wa = reg.emptyStats(); s.wa.tasks = 1; }), 'wa'],
    [ORCHESTRATORS, () => reg.recordOrchestrator('/ws/one', 'claude-test'), '/ws/one'],
  ]) {
    const name = path.basename(file);
    for (const damaged of ['{"wa": {"tasks": 5,}}', '[1,2,3]', '<<<<<<< SENTINEL\n{}\n']) {
      fresh();
      fs.writeFileSync(file, damaged);
      write();
      assert.ok(expectKey in readJson(file), `${name}: the new file was not written`);
      assert.ok(fs.existsSync(`${file}.damaged`), `${name}: no copy of the damaged file was kept`);
      assert.equal(readFile(`${file}.damaged`), damaged, `${name}: the copy is not the damaged file`);
    }
    // One slot: a later damaged file replaces the copy.
    fs.writeFileSync(file, 'second damage');
    write();
    assert.equal(readFile(`${file}.damaged`), 'second damage', `${name}: the slot was not overwritten`);
    // A BOM is not damage, and a healthy or empty file is not set aside.
    fresh();
    fs.writeFileSync(file, '﻿{"kept":{"tasks":3,"errors":0,"inputTokens":0,"outputTokens":0,"costUsd":0,"model":"m","ts":1}}');
    write();
    assert.ok('kept' in readJson(file), `${name}: a BOM-prefixed file was treated as damaged`);
    assert.ok(!fs.existsSync(`${file}.damaged`), `${name}: a healthy file was set aside`);
    fresh();
    fs.writeFileSync(file, '');
    write();
    assert.ok(!fs.existsSync(`${file}.damaged`), `${name}: an empty file was set aside`);
    // A directory where the file should be is set aside too (after a regular copy is in the slot).
    fresh();
    fs.writeFileSync(`${file}.damaged`, 'older copy');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'inside'), 'x');
    write();
    assert.ok(expectKey in readJson(file), `${name}: a directory at the path was not replaced`);
    assert.equal(readFile(path.join(`${file}.damaged`, 'inside')), 'x', `${name}: the directory was not kept in the slot`);
  }
});

await check('2.2 readStatsChecked: an unreadable or damaged stats.json has a problem; missing, empty and healthy do not', () => {
  const readChecked = need('readStatsChecked');
  fresh();
  assert.deepEqual(readChecked(), { stats: Object.create(null), problem: null });
  fs.writeFileSync(STATS, '');
  assert.equal(readChecked().problem, null);
  fs.writeFileSync(STATS, '﻿{"wa":{"tasks":2,"cooldownUntil":99}}');
  let got = readChecked();
  assert.equal(got.problem, null);
  assert.deepEqual({ ...got.stats.wa }, { tasks: 2, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cooldownUntil: 99 });
  assert.deepEqual(reg.readStats(), got.stats);
  fs.writeFileSync(STATS, '{"wa":{"tasks":2,"SENTINEL":1},}');
  got = readChecked();
  assert.match(got.problem, /^not valid JSON/);
  assert.ok(!got.problem.includes('SENTINEL'));
  assert.deepEqual(Object.keys(got.stats), []);
  fs.writeFileSync(STATS, '[]');
  assert.equal(readChecked().problem, 'not a JSON object');
});

await check('2.2 stats.json / orchestrators.json that could not be READ: the write is refused and nothing is moved', () => {
  if (!POSIX || process.getuid() === 0) {
    return 'skip';
  }
  for (const [file, write] of [
    [STATS, () => reg.updateStats((s) => { s.wa = reg.emptyStats(); })],
    [STATS, () => reg.writeStats({})],
    [ORCHESTRATORS, () => reg.touchOrchestrator('/ws/one')],
  ]) {
    fresh();
    const good = '{"keep":{"tasks":9,"errors":0,"inputTokens":0,"outputTokens":0,"costUsd":0}}';
    fs.writeFileSync(file, good);
    fs.chmodSync(file, 0o000);
    let err;
    try {
      err = thrown(write);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    assert.ok(err instanceof Error, `${path.basename(file)}: the write was not refused`);
    assert.equal(need('isStateWriteRefusal')(err), true, err.message);
    assert.equal(readFile(file), good, `${path.basename(file)}: the unread file was replaced`);
    assert.ok(!fs.existsSync(`${file}.damaged`), `${path.basename(file)}: a file that was merely unreadable was set aside`);
  }
});

// ---- §2.3 the task log ---------------------------------------------------------------------

function logLines() {
  return readFile(LOG).split('\n').filter((l) => l !== '');
}
const LINE_MAX = 32 * 1024;
// Contract §15.12 M4 (wave 11b): a `running` event that names no process (no pid, supervisorPid or
// meshWorker) and is younger than FAILOVER_GRACE_MS (3 min) reads ALIVE — its dispatcher is between
// two attempts. A fixture meant to be a DEAD pid-less task is planted older than that.
const PIDLESS_DEAD_AGE_MS = 10 * 60_000;
const BASE_EVENT = { ts: 1_760_000_000_000, id: 'tabc12345', status: 'running', worker: 'wa', model: 'opus', outputFile: '/x/tabc12345.md', cwd: '/work/space' };

await check('2.3 appendTaskEvent: a 10 MB title is written as one line of at most 200 chars', () => {
  fresh();
  reg.appendTaskEvent({ ...BASE_EVENT, title: `  line one\nline\ttwo ${'T'.repeat(10 * 1024 * 1024)}` });
  reg.appendTaskEvent({ ...BASE_EVENT, title: 'short  title\nwith a break' });
  const lines = logLines();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) + 1 <= LINE_MAX, `a line is ${Buffer.byteLength(line)} bytes`);
  }
  const [big, small] = lines.map((l) => JSON.parse(l));
  assert.equal(big.title.length, 200);
  assert.ok(big.title.startsWith('line one line two TTT'), big.title.slice(0, 40));
  assert.equal(small.title, 'short title with a break');
  for (const ev of [big, small]) {
    assert.deepEqual({ id: ev.id, ts: ev.ts, status: ev.status, worker: ev.worker, cwd: ev.cwd, outputFile: ev.outputFile }, { id: BASE_EVENT.id, ts: BASE_EVENT.ts, status: 'running', worker: 'wa', cwd: '/work/space', outputFile: BASE_EVENT.outputFile });
  }
});

await check('2.3 appendTaskEvent: a 10 MB error is cut, the rest of the event is intact', () => {
  fresh();
  const digest = sha256('token-one');
  reg.appendTaskEvent({ ...BASE_EVENT, status: 'error', title: 't', error: 'E'.repeat(10 * 1024 * 1024), ioTokenSha256: digest, promptPreview: 'p'.repeat(300) });
  const lines = logLines();
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) + 1 <= LINE_MAX, `the line is ${Buffer.byteLength(lines[0])} bytes`);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.error, `${'E'.repeat(2000)}…[truncated]`);
  assert.equal(ev.promptPreview, 'p'.repeat(300), 'a string under the limit was altered');
  assert.deepEqual([ev.id, ev.ts, ev.status, ev.ioTokenSha256, ev.worker, ev.title], [BASE_EVENT.id, BASE_EVENT.ts, 'error', digest, 'wa', 't']);
});

await check('2.3 appendTaskEvent: a cut never leaves half a surrogate pair, and nested strings are cut too', () => {
  fresh();
  // 1,999 ASCII then emoji: the 2,000th and 2,001st code units are one character.
  const odd = `${'a'.repeat(1999)}${'😀'.repeat(30_000)}`;
  reg.appendTaskEvent({ ...BASE_EVENT, title: 't', error: odd, extra: { list: ['z'.repeat(50_000), 5], deep: { s: 'y'.repeat(50_000) } } });
  const line = logLines()[0];
  assert.ok(Buffer.byteLength(line) + 1 <= LINE_MAX);
  const ev = JSON.parse(line);
  assert.equal(ev.error, `${'a'.repeat(1999)}…[truncated]`, 'the cut left an orphaned surrogate or cut at the wrong place');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(ev.error), 'an orphaned high surrogate was written');
  assert.equal(ev.extra.list[0], `${'z'.repeat(2000)}…[truncated]`);
  assert.equal(ev.extra.list[1], 5);
  assert.equal(ev.extra.deep.s, `${'y'.repeat(2000)}…[truncated]`);
});

await check('2.3 appendTaskEvent: 200 extra 1 MB fields — written in the reduced form, id/ts/status and the digests intact', () => {
  fresh();
  const digest = sha256('token-two');
  const detachDigest = sha256('token-three');
  const event = { ...BASE_EVENT, status: 'done', title: 'big one', provider: 'codex', cwd: `/${'c'.repeat(5000)}`, ioTokenSha256: digest, detachIoTokenSha256: detachDigest };
  const mb = 'f'.repeat(1024 * 1024);
  for (let i = 0; i < 200; i++) {
    event[`extra${i}`] = mb;
  }
  reg.appendTaskEvent(event);
  const lines = logLines();
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) + 1 <= LINE_MAX, `the line is ${Buffer.byteLength(lines[0])} bytes`);
  const ev = JSON.parse(lines[0]);
  assert.deepEqual([ev.id, ev.ts, ev.status, ev.ioTokenSha256, ev.detachIoTokenSha256], [BASE_EVENT.id, BASE_EVENT.ts, 'done', digest, detachDigest]);
  assert.deepEqual([ev.worker, ev.model, ev.provider, ev.title], ['wa', 'opus', 'codex', 'big one']);
  assert.equal(ev.cwd.length, 1000);
  assert.equal(ev.error, 'event too large — other fields dropped');
  assert.ok(!('extra0' in ev) && !('outputFile' in ev));
});

await check('2.3 appendTaskEvent: every line stays within 32 KiB for worst-case text (control characters, 3-byte characters)', () => {
  fresh();
  const shapes = {
    control: '\u0001'.repeat(40_000),
    cjk: '漢'.repeat(40_000),
    quotes: '"'.repeat(40_000),
  };
  for (const [label, text] of Object.entries(shapes)) {
    reg.appendTaskEvent({ ...BASE_EVENT, title: text, worker: text, model: text, provider: text, cwd: text, error: text, promptPreview: text, a: text, b: text, c: text, label });
  }
  const lines = logLines();
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) + 1 <= LINE_MAX, `a line is ${Buffer.byteLength(line)} bytes`);
    const ev = JSON.parse(line);
    assert.deepEqual([ev.id, ev.ts, ev.status], [BASE_EVENT.id, BASE_EVENT.ts, 'running']);
  }
});

await check('2.3 appendTaskEvent: an ordinary event is written exactly as before (nothing reordered, nothing added)', () => {
  fresh();
  const event = { ts: 1, id: 'tplain001', status: 'done', title: 'plain title', worker: 'wa', model: 'opus', outputFile: '/x/tplain001.md', inputTokens: 3, outputTokens: 4, costUsd: 0.5, cwd: '/w', promptPreview: 'hello', pid: 12, meshWorker: 'cco-x', error: undefined };
  reg.appendTaskEvent(event);
  assert.equal(readFile(LOG), `${JSON.stringify(event)}\n`);
});

await check('2.3 appendTaskEvent: an event whose id alone does not fit a line is refused, not filed under a cut id', () => {
  fresh();
  const err = thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id: 'i'.repeat(100_000), title: 't' }));
  assert.ok(err instanceof Error, 'an event with a 100,000-character id was written');
  assert.ok(!fs.existsSync(LOG) || readFile(LOG) === '', 'something was appended');
});

await check('2.3 checked readers: a log over the read cap, a directory at the log path, an unreadable mode — unreadable:true, never "nothing there"', () => {
  const ids = ['tabc12345'];
  const expectUnreadable = (label) => {
    assert.equal(reg.readTaskEventsChecked().unreadable, true, `${label}: readTaskEventsChecked`);
    const byIds = need('latestEventsByIdsChecked')(ids);
    assert.equal(byIds.unreadable, true, `${label}: latestEventsByIdsChecked`);
    assert.ok(byIds.events instanceof Map && byIds.events.size === 0, `${label}: events must be an empty Map`);
    const counts = need('runningCountsChecked')();
    assert.equal(counts.unreadable, true, `${label}: runningCountsChecked`);
    assert.deepEqual(Object.keys(counts.counts), [], `${label}: counts`);
    assert.equal(need('latestEventByIdChecked')(ids[0]).unreadable, true, `${label}: latestEventByIdChecked`);
    assert.equal(need('runningTasksChecked')().unreadable, true, `${label}: runningTasksChecked`);
    // The plain forms keep answering "none" without throwing.
    assert.deepEqual(reg.readTaskEvents(), []);
    assert.equal(reg.latestEventsByIds(ids).size, 0);
    assert.deepEqual(Object.keys(reg.runningCounts()), []);
  };
  // Over the cap: a SPARSE file one byte past it, holding a real running event at the front.
  fresh();
  appendLines([{ ...BASE_EVENT, title: 't' }]);
  fs.truncateSync(LOG, 64 * 1024 * 1024 + 1);
  expectUnreadable('over the cap');
  // A directory where the log should be.
  fresh();
  fs.mkdirSync(LOG);
  expectUnreadable('a directory');
  // Unreadable by mode.
  if (POSIX && process.getuid() !== 0) {
    fresh();
    appendLines([{ ...BASE_EVENT, title: 't' }]);
    fs.chmodSync(LOG, 0o000);
    try {
      expectUnreadable('mode 000');
    } finally {
      fs.chmodSync(LOG, 0o600);
    }
  }
  // Knowledge, for contrast: no log is "nothing", and a readable log is read.
  fresh();
  assert.deepEqual(need('latestEventsByIdsChecked')(ids), { events: new Map(), unreadable: false });
  assert.deepEqual(need('runningCountsChecked')(), { counts: Object.create(null), unreadable: false });
  appendLines([{ ...BASE_EVENT, title: 't' }, 'not json', 'null', { ...BASE_EVENT, id: 'tother0001', status: 'done' }]);
  const read = reg.latestEventsByIdsChecked(ids);
  assert.equal(read.unreadable, false);
  assert.equal(read.events.get('tabc12345').status, 'running');
  assert.deepEqual({ ...reg.runningCountsChecked().counts }, { wa: 1 });
  assert.equal(reg.latestEventByIdChecked('tnone00001').event, undefined);
  assert.deepEqual(reg.runningTasksChecked().tasks.map((t) => t.id), ['tabc12345']);
});

await check('2.3 isTaskFileId: 1–128 letters, digits, _ and - — the one rule for turning a task id into a file name', () => {
  const is = need('isTaskFileId');
  for (const good of ['tm3x9k2aq7zp', 'reap-done-1', 'shape-1', 'headless-reap-1', 'refused-12', 'T12345678', 'a', '0', '_', '-', 'A_b-9', 'x'.repeat(128)]) {
    assert.equal(is(good), true, `a usable id was refused: ${good.slice(0, 40)}`);
  }
  for (const bad of ['', '.', '..', 'a.b', 'a/b', 'a\\b', '../x', '/abs', 'a b', ' a', 'a ', 'a\n', 'a\u0000', 'ä', 'a:b', 'a*', '~', 'x'.repeat(129), 'x'.repeat(5000), 7, 0, null, undefined, true, {}, ['a'], { toString: () => 'a' }]) {
    assert.equal(is(bad), false, `not a task file id, but accepted: ${JSON.stringify(String(bad)).slice(0, 40)}`);
  }
  // The same rule decides this module's own files about a task: a dotted id has no result
  // file and no report, even though a file by that name is right there.
  fresh();
  const dotted = 'a.b';
  fs.writeFileSync(path.join(TASKS, `${dotted}.md`), 'ORIGINAL');
  fs.writeFileSync(path.join(TASKS, `${dotted}.result.json`), JSON.stringify({ id: dotted, status: 'done', text: 'x' }));
  appendLines([{ ts: Date.now() - 1000, id: dotted, status: 'running', title: 'dotted', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, `${dotted}.md`), supervisorPid: deadPid() }]);
  assert.equal(reg.reapDeadTasks(), 1);
  assert.equal(reg.latestEventById(dotted).status, 'error', 'a result file was read for an id that is not a task file id');
  assert.equal(readFile(path.join(TASKS, `${dotted}.md`)), 'ORIGINAL', 'a note was appended for an id that is not a task file id');
  // And an id the harness plants — hyphens, no leading t — has all three.
  fresh();
  const planted = 'reap-done-1';
  fs.writeFileSync(path.join(TASKS, `${planted}.md`), 'report\n');
  fs.writeFileSync(path.join(TASKS, `${planted}.result.json`), JSON.stringify({ id: planted, status: 'done', text: 'x', inputTokens: 3 }));
  appendLines([{ ts: Date.now() - 1000, id: planted, status: 'running', title: 'planted', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, `${planted}.md`), supervisorPid: deadPid() }]);
  assert.equal(reg.reapDeadTasks(), 1);
  assert.equal(reg.latestEventById(planted).status, 'done');
  assert.match(readFile(path.join(TASKS, `${planted}.md`)), /RECONCILED/);
  assert.equal(need('resolveTaskFile')(planted, 'output'), path.join(TASKS, `${planted}.md`));
  assert.equal(need('readTaskFile')(planted, 'output', 4096).ok, true);
});

await check('2.3 resolveTaskFile: only <TASKS_DIR>/<id>.md and <id>.prompt.txt of a regular file, for a task file id', () => {
  fresh();
  const resolve = need('resolveTaskFile');
  const outside = path.join(WORK, 'outside-secret.txt');
  fs.writeFileSync(outside, 'SENTINEL_outside');
  const id = 'tm3x9k2aq7zp';
  fs.writeFileSync(path.join(TASKS, `${id}.md`), 'report');
  fs.writeFileSync(path.join(TASKS, `${id}.prompt.txt`), 'prompt');
  assert.equal(resolve(id, 'output'), path.join(TASKS, `${id}.md`));
  assert.equal(resolve(id, 'prompt'), path.join(TASKS, `${id}.prompt.txt`));
  // Kinds that are not kinds.
  for (const kind of ['result', 'spec', '', undefined, null, '__proto__', 'constructor', 'output/../x', 7]) {
    assert.equal(resolve(id, kind), undefined, `kind ${JSON.stringify(kind)} resolved`);
  }
  // Ids that are not task ids. A file is planted wherever the id would land, so "undefined" is
  // the resolver refusing and not merely nothing being there.
  fs.writeFileSync(path.join(ROOT, 'x.md'), 'one level up');
  fs.mkdirSync(path.join(TASKS, 'a'), { recursive: true });
  fs.writeFileSync(path.join(TASKS, 'a', 'b.md'), 'nested');
  // Ids that no release minted but that ARE file-name safe resolve like any other.
  for (const plain of ['reap-done-1', 'T12345678', 'tabc', 'x'.repeat(128)]) {
    fs.writeFileSync(path.join(TASKS, `${plain}.md`), 'a report');
    assert.equal(resolve(plain, 'output'), path.join(TASKS, `${plain}.md`), `${plain.slice(0, 20)} did not resolve`);
  }
  fs.writeFileSync(path.join(TASKS, `${id}.md.md`), 'the id with its suffix as an id');
  fs.writeFileSync(path.join(TASKS, 'a.b.md'), 'a dotted id');
  const absolute = outside.replace(/\.txt$/, '');
  fs.writeFileSync(`${absolute}.md`, 'absolute');
  const hostile = ['../x', 'a/b', '..', '.', '', absolute, `${id}\u0000`, `${id}\u0000.md`, 'a'.repeat(5000), `t${'a'.repeat(5000)}`, 'x'.repeat(129), 'a.b', `${id}\n`, ` ${id}`, `${id}.md`, `./${id}`, `${id}/`, 7, null, undefined, {}, [id], { toString: () => id }];
  for (const bad of hostile) {
    for (const kind of ['output', 'prompt']) {
      let got;
      assert.doesNotThrow(() => {
        got = resolve(bad, kind);
      }, `resolveTaskFile threw for ${JSON.stringify(String(bad)).slice(0, 40)}`);
      assert.equal(got, undefined, `id ${JSON.stringify(String(bad)).slice(0, 40)} (${kind}) resolved to ${got}`);
    }
  }
  // Not a regular file under the right name.
  const linked = 'tlink0000001';
  if (POSIX) {
    fs.symlinkSync(outside, path.join(TASKS, `${linked}.md`));
    assert.equal(fs.readFileSync(path.join(TASKS, `${linked}.md`), 'utf8'), 'SENTINEL_outside', 'fixture: the symlink does not resolve');
    assert.equal(resolve(linked, 'output'), undefined, 'a symlink pointing outside the tasks directory was resolved');
    const dangling = 'tlink0000002';
    fs.symlinkSync(path.join(WORK, 'nowhere'), path.join(TASKS, `${dangling}.md`));
    assert.equal(resolve(dangling, 'output'), undefined);
    const fifo = 'tfifo0000001';
    spawnSync('mkfifo', [path.join(TASKS, `${fifo}.md`)]);
    assert.equal(resolve(fifo, 'output'), undefined, 'a FIFO was resolved');
  }
  const dir = 'tdir00000001';
  fs.mkdirSync(path.join(TASKS, `${dir}.md`));
  assert.equal(resolve(dir, 'output'), undefined, 'a directory with the right name was resolved');
  assert.equal(resolve('tmissing0001', 'output'), undefined);
});

await check('2.3 readTaskFile: the text of a task file by id — a symlink is not followed, and "could not read" is not "absent"', () => {
  fresh();
  const read = need('readTaskFile');
  const outside = path.join(WORK, 'outside-secret-2.txt');
  fs.writeFileSync(outside, 'SENTINEL_outside');
  const id = 'tread0000001';
  fs.writeFileSync(path.join(TASKS, `${id}.md`), 'the report');
  fs.writeFileSync(path.join(TASKS, `${id}.prompt.txt`), 'the prompt');
  assert.deepEqual(read(id, 'output', 1024), { ok: true, text: 'the report', bytes: 10 });
  assert.deepEqual(read(id, 'prompt', 1024), { ok: true, text: 'the prompt', bytes: 10 });
  const reason = (...args) => {
    const got = read(...args);
    assert.equal(got.ok, false, `read ${JSON.stringify(String(args[0])).slice(0, 40)} succeeded: ${JSON.stringify(got).slice(0, 80)}`);
    assert.ok(!JSON.stringify(got).includes('SENTINEL'), 'a refusal carries file content');
    return got.reason;
  };
  assert.equal(reason(id, 'output', 4), 'too-large');
  assert.equal(reason('tmissing0002', 'output', 1024), 'absent');
  fs.writeFileSync(path.join(TASKS, 'reap-done-1.md'), 'planted');
  assert.deepEqual(read('reap-done-1', 'output', 1024), { ok: true, text: 'planted', bytes: 7 });
  for (const bad of ['../x', '..', `${id}/../${id}`, outside.replace(/\.txt$/, ''), `${id}\u0000`, 'a'.repeat(5000), 'a.b', 7, null, undefined, {}]) {
    assert.equal(reason(bad, 'output', 1024), 'absent', `id ${JSON.stringify(String(bad)).slice(0, 30)}`);
  }
  assert.equal(reason(id, 'result', 1024), 'absent');
  const dir = 'tread0000003';
  fs.mkdirSync(path.join(TASKS, `${dir}.md`));
  assert.equal(reason(dir, 'output', 1024), 'not-a-file');
  if (POSIX) {
    const linked = 'tread0000004';
    fs.symlinkSync(outside, path.join(TASKS, `${linked}.md`));
    assert.equal(reason(linked, 'output', 1024), 'not-a-file', 'a symlink out of the tasks directory was read');
    const dangling = 'tread0000007';
    fs.symlinkSync(path.join(WORK, 'nowhere-at-all'), path.join(TASKS, `${dangling}.md`));
    assert.equal(reason(dangling, 'output', 1024), 'not-a-file', 'a dangling symlink was reported as an absent file');
    const fifo = 'tread0000005';
    spawnSync('mkfifo', [path.join(TASKS, `${fifo}.md`)]);
    assert.equal(reason(fifo, 'output', 1024), 'not-a-file');
    if (process.getuid() !== 0) {
      const locked = 'tread0000006';
      fs.writeFileSync(path.join(TASKS, `${locked}.md`), 'x');
      fs.chmodSync(path.join(TASKS, `${locked}.md`), 0o000);
      assert.equal(reason(locked, 'output', 1024), 'unreadable', 'an unreadable file was reported as something else');
    }
  }
});

await check('safeFs.readTextSafe noFollow: a symlink at the path is refused in the open; the default still follows one', () => {
  if (!POSIX) {
    return 'skip';
  }
  const dir = fs.mkdtempSync(path.join(WORK, 'safefs-'));
  const real = path.join(dir, 'real.txt');
  fs.writeFileSync(real, 'SENTINEL real content');
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(real, link);
  const dangling = path.join(dir, 'dangling.txt');
  fs.symlinkSync(path.join(dir, 'nowhere'), dangling);
  const linkToLink = path.join(dir, 'link2.txt');
  fs.symlinkSync(link, linkToLink);
  const realDir = path.join(dir, 'realdir');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'inner.txt'), 'inner');
  const dirLink = path.join(dir, 'dirlink');
  fs.symlinkSync(realDir, dirLink);
  const fifo = path.join(dir, 'fifo');
  spawnSync('mkfifo', [fifo]);
  const NF = { noFollow: true };
  const read = safe.readTextSafe;

  // The default is unchanged: a link to a regular file is that file.
  assert.deepEqual(read(link, 1024), { ok: true, text: 'SENTINEL real content', bytes: 21 });
  assert.deepEqual(read(linkToLink, 1024), { ok: true, text: 'SENTINEL real content', bytes: 21 });
  assert.equal(read(dangling, 1024).reason, 'absent');
  // Options that are not the literal `noFollow: true` are the default read, and never a throw.
  for (const notAsked of [undefined, null, {}, { noFollow: false }, { noFollow: 'true' }, { noFollow: 1 }, 'noFollow', 1, true, []]) {
    assert.equal(read(link, 1024, notAsked).ok, true, `options ${JSON.stringify(notAsked)} changed the default`);
  }
  // Asked for: the link is the fact, whatever it points at.
  for (const [label, file] of [['a link to a regular file', link], ['a link to a link', linkToLink], ['a dangling link', dangling], ['a link to a directory', dirLink]]) {
    const got = read(file, 1024, NF);
    assert.equal(got.ok, false, `${label}: followed`);
    assert.equal(got.reason, 'not-a-file', `${label}: ${JSON.stringify(got)}`);
    assert.ok(!got.detail.includes(dir) && !got.detail.includes('SENTINEL'), `${label}: the detail carries a path or content`);
  }
  // Everything else answers as it always did.
  assert.deepEqual(read(real, 1024, NF), { ok: true, text: 'SENTINEL real content', bytes: 21 });
  assert.equal(read(real, 4, NF).reason, 'too-large');
  assert.equal(read(path.join(dir, 'missing'), 1024, NF).reason, 'absent');
  assert.equal(read(realDir, 1024, NF).reason, 'not-a-file');
  assert.equal(read(fifo, 1024, NF).reason, 'not-a-file', 'a FIFO under noFollow');
  assert.equal(read('', 1024, NF).reason, 'unreadable');
  // Only the FINAL component: a link in a directory on the way is followed either way.
  assert.deepEqual(read(path.join(dirLink, 'inner.txt'), 1024, NF), { ok: true, text: 'inner', bytes: 5 });
  // A link swapped in for a regular file between two reads is refused by the second.
  const swapped = path.join(dir, 'swapped.txt');
  fs.writeFileSync(swapped, 'mine');
  assert.equal(read(swapped, 1024, NF).ok, true);
  fs.rmSync(swapped);
  fs.symlinkSync(real, swapped);
  assert.equal(read(swapped, 1024, NF).reason, 'not-a-file');
});

await check('2.3 the registry\'s own note goes to <TASKS_DIR>/<id>.md, never to the path a log line names', () => {
  fresh();
  const victim = path.join(WORK, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL');
  // A forged running event (no pid: nothing alive) whose outputFile names a file outside.
  const id = 'tforged00001';
  appendLines([{ ts: Date.now() - PIDLESS_DEAD_AGE_MS - 1000, id, status: 'running', title: 'forged', worker: 'wa', model: 'opus', outputFile: victim }]);
  // And one whose ID tries to leave the directory: `<TASKS_DIR>/../../victim-by-id` is in HOME.
  const escaping = '../../victim-by-id';
  const escaped = path.join(HOME, 'victim-by-id');
  assert.equal(path.join(TASKS, `${escaping}.md`), `${escaped}.md`, 'fixture: the id does not land where the test looks');
  fs.writeFileSync(`${escaped}.md`, 'ORIGINAL');
  fs.writeFileSync(`${escaped}.result.json`, JSON.stringify({ id: escaping, status: 'done', text: 'x' }));
  appendLines([{ ts: Date.now() - 1000, id: escaping, status: 'running', title: 'escaping', worker: 'wa', model: 'opus', outputFile: `${escaped}.md`, supervisorPid: deadPid() }]);
  const reaped = reg.reapDeadTasks();
  assert.equal(reaped, 2, `expected both dead tasks to be settled, got ${reaped}`);
  assert.equal(readFile(victim), 'ORIGINAL', 'a note was appended to the file a log line named');
  assert.equal(readFile(`${escaped}.md`), 'ORIGINAL', 'a note was appended outside the tasks directory via the id');
  assert.match(readFile(path.join(TASKS, `${id}.md`)), /ORPHANED: worker process is no longer running/);
  const settled = reg.latestEventsByIds([id, escaping]);
  assert.equal(settled.get(id).status, 'error');
  assert.equal(settled.get(escaping).status, 'error', 'the result file outside the tasks directory was read through the id');
  assert.deepEqual(fs.readdirSync(HOME).filter((n) => n.includes('reconcile')), [], 'a reconcile lock was left outside the tasks directory');
  // cancelRunningTask takes the same route.
  fresh();
  fs.writeFileSync(victim, 'ORIGINAL');
  appendLines([{ ts: Date.now() - PIDLESS_DEAD_AGE_MS, id, status: 'running', title: 'forged', worker: 'wa', model: 'opus', outputFile: victim }]);
  return reg.cancelRunningTask(id, 'cancelled by the test', 1).then((did) => {
    assert.equal(did, true);
    assert.equal(readFile(victim), 'ORIGINAL', 'cancel appended to the file a log line named');
    assert.match(readFile(path.join(TASKS, `${id}.md`)), /CANCELLED: cancelled by the test/);
  });
});

// ---- writeTaskFile: the whole file, by id, replacing the name ---------------------------------

const REPORT_TEXT = '# report\n\n- status: DONE\n\n## Result\n\n결과 — résultat — 😀\n';
const tmpLitter = () => fs.readdirSync(TASKS).filter((n) => n.endsWith('.tmp'));
const modeOf = (file) => (fs.lstatSync(file).mode & 0o777).toString(8);

await check('writeTaskFile: a symlink at the name is REPLACED by the file — its target, existing or not, is never written', () => {
  if (!POSIX) {
    return 'skip';
  }
  fresh();
  const write = need('writeTaskFile');
  const elsewhere = path.join(WORK, 'write-target.txt');
  fs.writeFileSync(elsewhere, 'ORIGINAL\n');
  const dangling = path.join(WORK, 'write-dangling-target.txt');
  fs.rmSync(dangling, { force: true });
  const targetDir = path.join(WORK, 'write-target-dir');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [id, target] of [['twrite000001', elsewhere], ['twrite000002', dangling], ['twrite000003', targetDir]]) {
    for (const kind of ['output', 'prompt']) {
      const name = path.join(TASKS, `${id}${kind === 'output' ? '.md' : '.prompt.txt'}`);
      fs.symlinkSync(target, name);
      assert.deepEqual(write(id, kind, REPORT_TEXT), { ok: true }, `${id} ${kind}`);
      assert.ok(fs.lstatSync(name).isFile(), `${id} ${kind}: the name is still not a regular file`);
      assert.equal(readFile(name), REPORT_TEXT);
      assert.equal(modeOf(name), '600');
    }
  }
  assert.equal(readFile(elsewhere), 'ORIGINAL\n', "the text was written into the link's target");
  assert.equal(fs.existsSync(dangling), false, 'a file was created at the target of a dangling link');
  assert.deepEqual(fs.readdirSync(targetDir), [], 'something was written into the directory a link pointed at');
  assert.deepEqual(tmpLitter(), []);
  // What the reader resolves is now the file that was written.
  assert.equal(reg.resolveTaskFile('twrite000001', 'output'), path.join(TASKS, 'twrite000001.md'));
});

await check('writeTaskFile: a FIFO at the name is replaced without ever being opened (no block) — in a child with a timeout', () => {
  if (!POSIX) {
    return 'skip';
  }
  const child = `
    const fs = require('fs'), path = require('path'), cp = require('child_process');
    const reg = require(process.argv[2]);
    fs.mkdirSync(reg.TASKS_DIR, { recursive: true });
    const out = {};
    const name = path.join(reg.TASKS_DIR, 'twfifo000001.md');
    cp.spawnSync('mkfifo', [name]);
    out.exported = typeof reg.writeTaskFile;
    out.result = reg.writeTaskFile('twfifo000001', 'output', 'REPORT');
    const st = fs.lstatSync(name);
    out.kind = st.isFile() ? 'file' : st.isFIFO() ? 'fifo' : 'other';
    out.text = st.isFile() ? fs.readFileSync(name, 'utf8') : null;
    out.litter = fs.readdirSync(reg.TASKS_DIR).filter((n) => n.endsWith('.tmp'));
    process.stdout.write(JSON.stringify(out));
  `;
  const home = fs.mkdtempSync(path.join(WORK, 'home-fifo-write-'));
  const done = runChild(child, { home, timeoutMs: 20_000 });
  assert.equal(done.timedOut, false, 'the write blocked on a FIFO');
  assert.equal(done.status, 0, String(done.stderr).slice(0, 300));
  const out = JSON.parse(done.stdout);
  assert.deepEqual(out.result, { ok: true });
  assert.deepEqual([out.kind, out.text, out.litter], ['file', 'REPORT', []]);
});

await check('writeTaskFile: a regular file is replaced whole; a missing one is created; the prompt kind has its own name', () => {
  fresh();
  const write = need('writeTaskFile');
  const id = 'twrite000011';
  const name = path.join(TASKS, `${id}.md`);
  fs.writeFileSync(name, 'a much longer RUNNING report that the DONE text must replace entirely\n'.repeat(50));
  assert.deepEqual(write(id, 'output', REPORT_TEXT), { ok: true });
  assert.equal(readFile(name), REPORT_TEXT, 'the old text was not replaced whole');
  assert.deepEqual(write(id, 'output', ''), { ok: true });
  assert.equal(readFile(name), '');
  const big = '한'.repeat(700_000);
  assert.deepEqual(write(id, 'output', big), { ok: true });
  assert.equal(readFile(name), big);
  assert.deepEqual(write('twrite000012', 'prompt', 'the prompt'), { ok: true });
  assert.equal(readFile(path.join(TASKS, 'twrite000012.prompt.txt')), 'the prompt');
  assert.equal(fs.existsSync(path.join(TASKS, 'twrite000012.md')), false);
  if (POSIX) {
    assert.equal(modeOf(name), '600');
    assert.equal(modeOf(path.join(TASKS, 'twrite000012.prompt.txt')), '600');
  }
  // An id the harness plants is a task file id too.
  assert.deepEqual(write('reap-done-1', 'output', 'x'), { ok: true });
  assert.deepEqual(tmpLitter(), []);
  // And a note can then be appended to what was written.
  assert.deepEqual(reg.appendTaskNote({ ts: 1, id, status: 'done', title: 't', worker: 'w', model: 'm', outputFile: name }, '\nNOTE\n'), { ok: true });
  assert.equal(readFile(name), `${big}\nNOTE\n`);
});

await check('writeTaskFile: a directory at the name is a refusal — nothing removed, nothing left behind', () => {
  fresh();
  const write = need('writeTaskFile');
  const id = 'twrite000021';
  const name = path.join(TASKS, `${id}.md`);
  fs.mkdirSync(name);
  fs.writeFileSync(path.join(name, 'inside'), 'ORIGINAL');
  const got = write(id, 'output', REPORT_TEXT);
  assert.deepEqual([got.ok, got.reason], [false, 'not-a-file'], JSON.stringify(got));
  assert.equal(got.detail, 'a directory is at the name of the task file');
  assert.ok(fs.lstatSync(name).isDirectory());
  assert.equal(readFile(path.join(name, 'inside')), 'ORIGINAL');
  assert.deepEqual(tmpLitter(), [], 'a temporary file was left behind by a refused write');
  // An EMPTY directory is not removed to make room either.
  const empty = path.join(TASKS, 'twrite000022.md');
  fs.mkdirSync(empty);
  assert.equal(write('twrite000022', 'output', 'x').reason, 'not-a-file');
  assert.ok(fs.lstatSync(empty).isDirectory());
});

await check('writeTaskFile: ids, kinds and texts that are not what they should be are refused, never thrown, and write nothing', () => {
  fresh();
  const write = need('writeTaskFile');
  fs.writeFileSync(path.join(ROOT, 'x.md'), 'ORIGINAL');
  const outside = path.join(WORK, 'write-outside');
  fs.writeFileSync(`${outside}.md`, 'ORIGINAL');
  for (const bad of ['../x', '..', '.', '', 'a/b', 'a.b', outside, 'x'.repeat(129), 'ok\u0000', ' ok', 7, null, undefined, {}, ['ok']]) {
    let got;
    assert.doesNotThrow(() => {
      got = write(bad, 'output', 'TEXT');
    });
    assert.deepEqual([got.ok, got.reason], [false, 'not-a-task-file'], `id ${JSON.stringify(String(bad)).slice(0, 30)}`);
  }
  for (const kind of ['result', 'spec', '', undefined, null, 7, '__proto__']) {
    assert.equal(write('twrite000031', kind, 'TEXT').reason, 'not-a-task-file', `kind ${JSON.stringify(kind)}`);
  }
  for (const text of [undefined, null, 7, {}, ['x'], Buffer.from('x')]) {
    assert.equal(write('twrite000031', 'output', text).reason, 'not-a-task-file', `text ${JSON.stringify(text)}`);
  }
  assert.equal(readFile(path.join(ROOT, 'x.md')), 'ORIGINAL');
  assert.equal(readFile(`${outside}.md`), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(TASKS), [], 'something was created for a refused write');
  // No tasks directory: `absent`, and it is not created.
  fs.rmSync(TASKS, { recursive: true, force: true });
  const gone = write('twrite000032', 'output', 'TEXT');
  assert.deepEqual([gone.ok, gone.reason], [false, 'absent']);
  assert.equal(fs.existsSync(TASKS), false);
  // A tasks directory this user may not write into: `unwritable`, with the errno code only.
  if (POSIX && process.getuid() !== 0) {
    fresh();
    fs.chmodSync(TASKS, 0o500);
    let denied;
    try {
      denied = write('twrite000033', 'output', 'TEXT');
    } finally {
      fs.chmodSync(TASKS, 0o700);
    }
    assert.deepEqual([denied.ok, denied.reason], [false, 'unwritable'], JSON.stringify(denied));
    assert.match(denied.detail, /\(EACCES\)$/);
    assert.ok(!denied.detail.includes(TASKS) && !denied.detail.includes('TEXT'), 'the refusal carries the path or the text');
  }
});

await check('writeTaskFile: a temporary name that is already taken is never opened — another is tried, and after a few the write is refused', () => {
  if (!POSIX) {
    return 'skip';
  }
  fresh();
  const write = need('writeTaskFile');
  const cjsCrypto = require('crypto');
  const realRandomBytes = cjsCrypto.randomBytes;
  const victim = path.join(WORK, 'temp-victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL');
  const id = 'twrite000041';
  const name = path.join(TASKS, `${id}.md`);
  // The "random" part of the temporary name, made predictable for this check only.
  const forced = (n) => Buffer.alloc(12, n);
  const tempName = (n) => `${name}.${forced(n).toString('hex')}.tmp`;
  const run = (taken) => {
    for (let n = 1; n <= taken; n++) {
      if (fs.lstatSync(tempName(n), { throwIfNoEntry: false }) === undefined) {
        fs.symlinkSync(victim, tempName(n));
      }
    }
    let calls = 0;
    cjsCrypto.randomBytes = (size) => (size === 12 ? forced(++calls) : realRandomBytes(size));
    try {
      return write(id, 'output', REPORT_TEXT);
    } finally {
      cjsCrypto.randomBytes = realRandomBytes;
    }
  };
  // Three names taken by links to a victim file, the fourth free: the write lands, the
  // victim is untouched, and the links that were in the way are still there (not ours).
  assert.deepEqual(run(3), { ok: true });
  assert.equal(readFile(name), REPORT_TEXT);
  assert.equal(readFile(victim), 'ORIGINAL', 'the text was written through a link planted at the temporary name');
  for (let n = 1; n <= 3; n++) {
    assert.ok(fs.lstatSync(tempName(n)).isSymbolicLink(), 'a planted name was removed or replaced');
  }
  assert.equal(fs.existsSync(tempName(4)), false, 'the temporary file was left behind');
  // All four taken: refused, the report as it was, the victim untouched.
  const refused = run(4);
  assert.deepEqual([refused.ok, refused.reason], [false, 'unwritable'], JSON.stringify(refused));
  assert.equal(readFile(name), REPORT_TEXT);
  assert.equal(readFile(victim), 'ORIGINAL');
});

// ---- a note is appended to a REGULAR report, never through a link -----------------------------

const NOTE = '\n\n---\n\nNOTE: appended by the test\n';
const noteTask = (id) => ({ ts: Date.now() - PIDLESS_DEAD_AGE_MS, id, status: 'running', title: 'note', worker: 'wa', model: 'opus', outputFile: 'whatever the log says' });
const reportOf = (id) => path.join(TASKS, `${id}.md`);

await check('note: a symlinked report is refused (ok:false) and the file it points at is untouched — appendTaskNote, appendOutputNote, settle and cancel', async () => {
  if (!POSIX) {
    return 'skip';
  }
  fresh();
  const elsewhere = path.join(WORK, 'note-target.txt');
  fs.writeFileSync(elsewhere, 'ORIGINAL\n');
  const id = 'tnote0000001';
  fs.symlinkSync(elsewhere, reportOf(id));
  for (const [label, append] of [['appendTaskNote', () => need('appendTaskNote')(noteTask(id), NOTE)], ['appendOutputNote', () => reg.appendOutputNote(reportOf(id), NOTE)]]) {
    const got = append();
    assert.deepEqual([got.ok, got.reason], [false, 'not-a-file'], `${label}: ${JSON.stringify(got)}`);
    assert.equal(got.detail, 'the report is a symbolic link', label);
    assert.equal(readFile(elsewhere), 'ORIGINAL\n', `${label}: the note was appended to the link's target`);
    assert.ok(fs.lstatSync(reportOf(id)).isSymbolicLink(), `${label}: the link itself was replaced`);
  }
  // The reader refuses the same name, so the two agree about which file is the report.
  assert.equal(reg.resolveTaskFile(id, 'output'), undefined);
  // Links to things that are not files are links first.
  for (const [n, make] of [[2, (target) => fs.mkdirSync(target)], [3, (target) => spawnSync('mkfifo', [target])]]) {
    const linked = `tnote000000${n}`;
    const target = path.join(WORK, `note-target-${n}`);
    make(target);
    fs.symlinkSync(target, reportOf(linked));
    assert.deepEqual(reg.appendTaskNote(noteTask(linked), NOTE), { ok: false, reason: 'not-a-file', detail: 'the report is a symbolic link' });
  }
  // The settle of a dead task whose report is a link: the task still settles, the label says
  // the report could not be annotated, and nothing is written through the link.
  appendLines([{ ...noteTask(id), ts: Date.now() - PIDLESS_DEAD_AGE_MS - 1000, outputFile: reportOf(id) }]);
  assert.equal(reg.reapDeadTasks(), 1, 'a refused note changed whether the task settled');
  const settled = reg.latestEventById(id);
  assert.equal(settled.status, 'error');
  assert.match(settled.error, /^orphaned — .*the output file could not be annotated \(not-a-file\)$/);
  assert.equal(readFile(elsewhere), 'ORIGINAL\n', 'the settle note was appended through the link');
  // And a cancel: it still cancels.
  const cancelId = 'tnote0000009';
  fs.symlinkSync(elsewhere, reportOf(cancelId));
  appendLines([{ ...noteTask(cancelId), outputFile: reportOf(cancelId) }]);
  assert.equal(await reg.cancelRunningTask(cancelId, 'stop', 1), true, 'a refused note changed the outcome of a cancel');
  assert.equal(reg.latestEventById(cancelId).status, 'error');
  assert.equal(readFile(elsewhere), 'ORIGINAL\n', 'the cancel note was appended through the link');
});

await check('note: a dangling symlink is refused and nothing is created at its target', () => {
  if (!POSIX) {
    return 'skip';
  }
  fresh();
  const id = 'tnote0000011';
  const target = path.join(WORK, 'note-dangling-target.txt');
  fs.rmSync(target, { force: true });
  fs.symlinkSync(target, reportOf(id));
  for (const append of [() => reg.appendTaskNote(noteTask(id), NOTE), () => reg.appendOutputNote(reportOf(id), NOTE)]) {
    const got = append();
    assert.deepEqual([got.ok, got.reason], [false, 'not-a-file'], JSON.stringify(got));
    assert.equal(fs.existsSync(target), false, 'a file was created at the target of a dangling link');
    assert.ok(fs.lstatSync(reportOf(id)).isSymbolicLink());
  }
});

await check('note: a directory at the report\'s name is refused, and nothing in it changes', () => {
  fresh();
  const id = 'tnote0000021';
  fs.mkdirSync(reportOf(id));
  fs.writeFileSync(path.join(reportOf(id), 'inside'), 'ORIGINAL');
  for (const append of [() => reg.appendTaskNote(noteTask(id), NOTE), () => reg.appendOutputNote(reportOf(id), NOTE)]) {
    const got = append();
    assert.deepEqual([got.ok, got.reason], [false, 'not-a-file'], JSON.stringify(got));
    assert.ok(!String(got.detail).includes(TASKS), 'the refusal carries the path');
  }
  assert.deepEqual(fs.readdirSync(reportOf(id)), ['inside']);
  assert.equal(readFile(path.join(reportOf(id), 'inside')), 'ORIGINAL');
  // A report whose DIRECTORY is missing is not created along with its directory.
  const got = reg.appendOutputNote(path.join(TASKS, 'no-such-dir', 'tnote0000022.md'), NOTE);
  assert.deepEqual([got.ok, got.reason], [false, 'absent']);
  assert.equal(fs.existsSync(path.join(TASKS, 'no-such-dir')), false);
});

await check('note: a FIFO at the report\'s name is refused without blocking — with no reader, with a reader, and from the settle sweep', () => {
  if (!POSIX) {
    return 'skip';
  }
  const child = `
    const fs = require('fs'), path = require('path'), cp = require('child_process');
    const reg = require(process.argv[2]);
    fs.mkdirSync(reg.TASKS_DIR, { recursive: true });
    const task = (id, outputFile) => ({ ts: Date.now() - 600000 - 1000, id, status: 'running', title: 'n', worker: 'wa', model: 'opus', outputFile: outputFile || 'x' });
    const out = {};
    const a = path.join(reg.TASKS_DIR, 'tfifo0000001.md');
    cp.spawnSync('mkfifo', [a]);
    out.noReader = reg.appendTaskNote(task('tfifo0000001'), 'NOTE');
    const b = path.join(reg.TASKS_DIR, 'tfifo0000002.md');
    cp.spawnSync('mkfifo', [b]);
    const reader = fs.openSync(b, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    out.withReader = reg.appendTaskNote(task('tfifo0000002'), 'NOTE');
    try { out.bytesThroughPipe = fs.readSync(reader, Buffer.alloc(16), 0, 16, null); } catch (e) { out.bytesThroughPipe = e.code; }
    fs.appendFileSync(reg.TASKS_LOG_FILE, JSON.stringify(task('tfifo0000001', a)) + '\\n');
    out.reaped = reg.reapDeadTasks();
    out.stillFifo = fs.lstatSync(a).isFIFO() && fs.lstatSync(b).isFIFO();
    process.stdout.write(JSON.stringify(out));
  `;
  const home = fs.mkdtempSync(path.join(WORK, 'home-fifo-note-'));
  const done = runChild(child, { home, timeoutMs: 20_000 });
  assert.equal(done.timedOut, false, 'the append blocked on a FIFO');
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.deepEqual([out.noReader.ok, out.noReader.reason], [false, 'not-a-file'], JSON.stringify(out.noReader));
  assert.deepEqual([out.withReader.ok, out.withReader.reason], [false, 'not-a-file'], JSON.stringify(out.withReader));
  assert.ok(out.bytesThroughPipe === 0 || out.bytesThroughPipe === 'EAGAIN', `something was written into the pipe: ${out.bytesThroughPipe}`);
  assert.equal(out.reaped, 1, 'the sweep did not settle a dead task whose report is a FIFO');
  assert.equal(out.stillFifo, true);
});

await check('note: the genuine regular report is appended to; a missing one is created with the note, mode 0600', () => {
  fresh();
  const id = 'tnote0000031';
  fs.writeFileSync(reportOf(id), '# report\n');
  assert.deepEqual(reg.appendTaskNote(noteTask(id), NOTE), { ok: true });
  assert.deepEqual(reg.appendOutputNote(reportOf(id), 'second\n'), { ok: true });
  assert.equal(readFile(reportOf(id)), `# report
${NOTE}second
`);
  // No report yet: today's answer is kept — the report is created and holds the note.
  for (const [n, append] of [[2, (file, missing) => reg.appendTaskNote(noteTask(missing), NOTE)], [3, (file) => reg.appendOutputNote(file, NOTE)]]) {
    const missing = `tnote000003${n}`;
    assert.deepEqual(append(reportOf(missing), missing), { ok: true });
    assert.equal(readFile(reportOf(missing)), NOTE);
    if (POSIX) {
      assert.equal((fs.statSync(reportOf(missing)).mode & 0o777).toString(8), '600', 'a report created by a note is readable by others');
    }
  }
  // Nothing to annotate is not a failure: no recorded output file, or an id that is no file name.
  assert.deepEqual(reg.appendTaskNote({ ...noteTask('tnote0000034'), outputFile: '' }, NOTE), { ok: true });
  assert.equal(fs.existsSync(reportOf('tnote0000034')), false);
  assert.deepEqual(reg.appendTaskNote(noteTask('../escape'), NOTE), { ok: true });
  assert.deepEqual(reg.appendOutputNote(undefined, NOTE), { ok: true });
  // Arguments that are not what they should be are refused, never thrown.
  assert.equal(reg.appendOutputNote(reportOf(id), 7).ok, false);
  assert.equal(reg.appendOutputNote(`${reportOf(id)} x`, NOTE).ok, false);
  assert.equal(readFile(reportOf(id)), `# report
${NOTE}second
`);
});

// ---- §2.4 tokens in the log ----------------------------------------------------------------

function plantResult(id, token, extra = {}) {
  const record = { id, status: 'done', text: 'RESULT', worker: 'wa', model: 'opus', inputTokens: 1, outputTokens: 2, costUsd: 0.25, ...extra };
  if (token !== undefined) {
    record.token = token;
  }
  fs.writeFileSync(path.join(TASKS, `${id}.result.json`), JSON.stringify(record));
}
function runningEvent(id, extra = {}) {
  return { ts: Date.now() - 500, id, status: 'running', title: 'tok', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, `${id}.md`), supervisorPid: 4_000_000, ...extra };
}
function verdictFor(id, token, extra) {
  plantResult(id, token, extra);
  const latest = reg.latestEventById(id);
  const read = reg.readResultForTask(latest);
  return read.kind === 'refused' ? `refused: ${read.why}` : read.kind;
}

await check('2.4 tokens: the FIRST event fixes the expectation; a later forged digest or legacy value changes nothing', () => {
  fresh();
  const id = 'ttoken000001';
  const [real, forgedA, forgedB] = [newToken(), newToken(), newToken()];
  appendLines([
    runningEvent(id, { detachIoTokenSha256: sha256(real) }),
    runningEvent(id, { detachIoTokenSha256: sha256(forgedA), detachIoToken: forgedB }),
    runningEvent(id, { detachIoToken: forgedB }),
    runningEvent(id, { detachIoTokenSha256: '', detachIoToken: null }),
  ]);
  assert.equal(verdictFor(id, real), 'ok');
  assert.match(verdictFor(id, forgedA), /^refused: the record does not carry this dispatch's result token/);
  assert.match(verdictFor(id, forgedB), /^refused: the record does not carry/);
  assert.match(verdictFor(id, undefined), /^refused: the record does not carry/, 'a record with no token passed');
  assert.match(verdictFor(id, sha256(real)), /^refused/, 'the digest itself was accepted as the token');
  assert.match(verdictFor(id, real.toUpperCase()), /^refused/);
  for (const notAToken of [42, null, {}, [real], true]) {
    assert.match(verdictFor(id, undefined, { token: notAToken }), /^refused/, `token ${JSON.stringify(notAToken)} passed`);
  }
});

await check('2.4 tokens: a legacy plain value is still accepted as the expectation, first-wins as well', () => {
  fresh();
  const id = 'ttoken000002';
  const [real, forged] = [newToken(), newToken()];
  appendLines([runningEvent(id, { detachIoToken: real }), runningEvent(id, { detachIoTokenSha256: sha256(forged) }), runningEvent(id, { detachIoToken: forged })]);
  assert.equal(verdictFor(id, real), 'ok');
  assert.match(verdictFor(id, forged), /^refused: the record does not carry/);
});

await check('2.4 tokens: on ONE event the digest wins over the legacy value', () => {
  fresh();
  const id = 'ttoken000003';
  const [byDigest, byLegacy] = [newToken(), newToken()];
  appendLines([runningEvent(id, { detachIoToken: byLegacy, detachIoTokenSha256: sha256(byDigest) })]);
  assert.equal(verdictFor(id, byDigest), 'ok');
  assert.match(verdictFor(id, byLegacy), /^refused: the record does not carry/);
});

await check('2.4 tokens: no token recorded ⇒ shape only; a token field with no usable value ⇒ refused', () => {
  fresh();
  const none = 'ttoken000004';
  appendLines([runningEvent(none)]);
  assert.equal(verdictFor(none, undefined), 'ok', 'a pre-token dispatch must be judged by shape alone');
  assert.equal(verdictFor(none, newToken()), 'ok');
  assert.match(verdictFor(none, undefined, { status: 'weird' }), /^refused: the record carries no "done"\/"error" status/);
  for (const [n, fields] of [[5, { detachIoTokenSha256: '' }], [6, { detachIoToken: null }], [7, { detachIoTokenSha256: 'not-a-digest' }], [8, { detachIoToken: 12345 }]]) {
    const id = `ttoken00000${n}`;
    appendLines([runningEvent(id, fields)]);
    const verdict = verdictFor(id, newToken());
    assert.match(verdict, /^refused: this dispatch's recorded result token is unusable/, `${JSON.stringify(fields)}: ${verdict}`);
    assert.ok(!verdict.includes('not-a-digest') && !verdict.includes('12345'), 'the refusal quotes the recorded value');
  }
  // A damaged first line does not take the place of a well-formed one that follows it.
  const later = 'ttoken000009';
  const real = newToken();
  appendLines([runningEvent(later, { detachIoTokenSha256: '' }), runningEvent(later, { detachIoTokenSha256: sha256(real) })]);
  assert.equal(verdictFor(later, real), 'ok');
});

await check('2.4 tokens: a result file that is a symbolic link is refused, not read through', () => {
  if (!POSIX) {
    return 'skip';
  }
  fresh();
  const id = 'tlinked00001';
  appendLines([runningEvent(id)]);
  // A perfectly valid record for this id — somewhere else.
  const elsewhere = path.join(WORK, 'result-elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ id, status: 'done', text: 'SENTINEL', inputTokens: 5 }));
  fs.symlinkSync(elsewhere, path.join(TASKS, `${id}.result.json`));
  const read = reg.readResultForTask(reg.latestEventById(id));
  assert.equal(read.kind, 'refused', `a symlinked result file was ${read.kind}`);
  assert.equal(read.why, 'the path is not a regular file');
  // The same record as a regular file is accepted (this dispatch recorded no token).
  fs.rmSync(path.join(TASKS, `${id}.result.json`));
  fs.copyFileSync(elsewhere, path.join(TASKS, `${id}.result.json`));
  assert.equal(reg.readResultForTask(reg.latestEventById(id)).kind, 'ok');
});

await check('2.4 tokens: firstRecordedIoToken — both dispatch paths, three answers', () => {
  const first = need('firstRecordedIoToken');
  const d1 = sha256('one');
  const d2 = sha256('two');
  const t1 = newToken();
  const events = [
    { id: 'A', ioTokenSha256: d1, detachIoToken: t1 },
    { id: 'A', ioTokenSha256: d2, ioToken: t1, detachIoTokenSha256: d2 },
    { id: 'B', ioToken: t1 },
    { id: 'C' },
    { id: 'D', ioToken: '' },
    { id: 'D', ioTokenSha256: 7 },
    null,
    'x',
  ];
  assert.deepEqual(first(events, 'A', 'session'), { sha256: d1 });
  assert.deepEqual(first(events, 'A', 'detach'), { legacy: t1 });
  assert.deepEqual(first(events, 'B', 'session'), { legacy: t1 });
  assert.deepEqual(first(events, 'B', 'detach'), {});
  assert.deepEqual(first(events, 'C', 'session'), {});
  assert.deepEqual(first(events, 'D', 'session'), { legacy: '' });
  assert.deepEqual(first(events, 'nobody', 'session'), {});
  assert.deepEqual(first([], 'A', 'detach'), {});
});

await check('2.4 tokens: isMeshDispatchEvent — a string at ioToken, ioTokenSha256 or meshWorker', () => {
  const is = need('isMeshDispatchEvent');
  assert.equal(is({ ioToken: newToken() }), true);
  assert.equal(is({ ioTokenSha256: sha256('x') }), true);
  assert.equal(is({ meshWorker: 'cco-t1' }), true);
  assert.equal(is({ ioToken: '' }), true, 'presence, not value');
  for (const not of [{}, { detachIoToken: newToken() }, { detachIoTokenSha256: sha256('x') }, { ioToken: 5 }, { ioTokenSha256: null }, { meshWorker: {} }, null, undefined, 'meshWorker', 7]) {
    assert.equal(is(not), false, `wrongly a session-worker event: ${JSON.stringify(not)}`);
  }
});

await check('2.4 tokens: a session-worker dispatch refuses the detached path\'s result file (digest field counts)', () => {
  fresh();
  for (const [n, fields] of [[1, { ioTokenSha256: sha256(newToken()) }], [2, { ioToken: newToken() }], [3, { meshWorker: 'cco-x' }]]) {
    const id = `tmesh000000${n}`;
    appendLines([runningEvent(id, fields)]);
    assert.match(verdictFor(id, undefined), /^refused: this dispatch has no detach supervisor/, JSON.stringify(fields));
  }
});

await check('2.4 tokens: a terminal event composed from a running one carries NEITHER detach field', () => {
  fresh();
  const id = 'tterm0000001';
  const token = newToken();
  const gone = deadPid();
  appendLines([{ ...runningEvent(id, { supervisorPid: gone, detachIoTokenSha256: sha256(token), detachIoToken: token, ioTokenSha256: undefined }) }]);
  plantResult(id, token);
  assert.equal(reg.reapDeadTasks(), 1);
  const lines = logLines();
  const terminal = JSON.parse(lines[lines.length - 1]);
  assert.equal(terminal.status, 'done', `the genuine result was not accepted: ${JSON.stringify(terminal)}`);
  assert.ok(!('detachIoToken' in terminal), 'the terminal event carries the legacy token');
  assert.ok(!('detachIoTokenSha256' in terminal), 'the terminal event carries the digest');
  assert.ok(!lines[lines.length - 1].includes(token), 'the token is in the terminal line');
  // And through cancel.
  const cancelId = 'tterm0000002';
  appendLines([runningEvent(cancelId, { detachIoTokenSha256: sha256(token), detachIoToken: token })]);
  return reg.cancelRunningTask(cancelId, 'stop', 1).then(() => {
    const last = JSON.parse(logLines().pop());
    assert.equal(last.id, cancelId);
    assert.ok(!('detachIoToken' in last) && !('detachIoTokenSha256' in last), 'cancel kept a detach token field');
  });
});

// ---- §2.6 / §2.8 ---------------------------------------------------------------------------

await check('2.6 sanitizeDispatchConcurrency: an integer 1–64, anything else is 8', () => {
  const sanitize = need('sanitizeDispatchConcurrency');
  assert.equal(reg.DISPATCH_CONCURRENCY_DEFAULT, 8);
  const table = [[undefined, 8], [null, 8], [NaN, 8], [Infinity, 8], [-Infinity, 8], [-1, 8], [0, 8], [1, 1], [8, 8], [64, 64], [65, 8], [2.5, 8], ['8', 8], ['16', 8], [[], 8], [{}, 8], [1e9, 8], [true, 8], [[3], 8], [3, 3], [63, 63]];
  for (const [value, expected] of table) {
    assert.equal(sanitize(value), expected, `sanitizeDispatchConcurrency(${typeof value === 'number' ? String(value) : JSON.stringify(value)})`);
  }
  for (const [stored, expected] of [[undefined, 8], [12, 12], ['12', 8], [0, 8], [200, 8], [1.5, 8]]) {
    fresh();
    writeRegistryFile(stored === undefined ? {} : { maxConcurrentDispatches: stored });
    assert.equal(reg.readRegistry().maxConcurrentDispatches, expected, `stored ${JSON.stringify(stored)}`);
  }
});

await check('2.8 processRunsCli: true / false for a command line that was read, undefined when it cannot be determined', () => {
  if (!POSIX) {
    return 'skip';
  }
  const runs = need('processRunsCli');
  const self = path.basename(process.execPath);
  assert.equal(runs(process.pid, self), true, `this process (${self}) was not recognised`);
  assert.equal(runs(process.pid, 'definitely-not-a-cli-xyz'), false);
  assert.equal(runs(process.pid, self.slice(0, -1)), false, 'a prefix of the name matched');
  assert.equal(runs(deadPid(), self), undefined, 'a pid that names no process must be undefined, not false');
  for (const pid of [-1, 0, 1.5, NaN, Infinity, '12', null, undefined]) {
    assert.equal(runs(pid, self), undefined, `pid ${String(pid)}`);
  }
  for (const cli of ['', '   ', null, undefined, 7]) {
    assert.equal(runs(process.pid, cli), undefined, `cli ${JSON.stringify(cli)}`);
  }
  // A child whose command line names a CLI as a path component and as a bare word.
  const script = path.join(WORK, 'cursor-agent', 'index.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'setTimeout(() => {}, 60000);');
  const child = spawn(process.execPath, [script, 'agy'], { stdio: 'ignore' });
  try {
    // Give the child a moment to become the program it was started as.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    assert.equal(runs(child.pid, 'cursor-agent'), true, 'a directory on the way to the script');
    assert.equal(runs(child.pid, 'agy'), true, 'a bare word');
    assert.equal(runs(child.pid, 'cursor'), false, 'part of a name');
    assert.equal(runs(child.pid, 'claude'), false);
  } finally {
    child.kill('SIGKILL');
  }
});

// ---- §2.5 data directory modes -------------------------------------------------------------

const MODES_CHILD = `
  const fs = require('fs'), path = require('path');
  const reg = require(process.argv[2]);
  reg.updateRegistry((r) => { r.cooldownMinutes = 31; });
  reg.updateStats((s) => { s.wa = reg.emptyStats(); });
  reg.recordOrchestrator('/ws/one', 'claude-test');
  reg.appendTaskEvent({ ts: Date.now(), id: 'tmode0000001', status: 'running', title: 't', worker: 'wa', model: 'opus', outputFile: path.join(reg.TASKS_DIR, 'tmode0000001.md') });
  const mode = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8); } catch (e) { return e.code; } };
  process.stdout.write(JSON.stringify({
    root: mode(reg.ROOT_DIR), tasks: mode(reg.TASKS_DIR), registry: mode(reg.REGISTRY_FILE), stats: mode(reg.STATS_FILE),
    orchestrators: mode(reg.ORCHESTRATORS_FILE), log: mode(reg.TASKS_LOG_FILE),
  }));
`;

await check('2.5 modes: a new data directory is 0700 and the files this module creates are 0600', () => {
  if (!POSIX) {
    return 'skip';
  }
  const home = fs.mkdtempSync(path.join(WORK, 'home-modes-new-'));
  const done = runChild(MODES_CHILD, { home });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), { root: '700', tasks: '700', registry: '600', stats: '600', orchestrators: '600', log: '600' });
});

await check('2.5 modes: an existing 0755 data directory is closed to 0700 on first use; files rewritten become 0600', () => {
  if (!POSIX) {
    return 'skip';
  }
  const home = fs.mkdtempSync(path.join(WORK, 'home-modes-old-'));
  const root = path.join(home, '.claude-code-orchestrator');
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o755);
  fs.writeFileSync(path.join(root, 'registry.json'), '{}');
  fs.chmodSync(path.join(root, 'registry.json'), 0o644);
  // A temp file left behind by an earlier version, with that version's mode.
  const done = runChild(MODES_CHILD, { home });
  assert.equal(done.status, 0, done.stderr);
  const modes = JSON.parse(done.stdout);
  assert.equal(modes.root, '700', 'the data directory is still open to group/other');
  assert.equal(modes.registry, '600');
  assert.equal(modes.tasks, '700');
});

await check('2.5 modes: a symlinked data directory is left alone', () => {
  if (!POSIX) {
    return 'skip';
  }
  const home = fs.mkdtempSync(path.join(WORK, 'home-modes-link-'));
  const real = path.join(home, 'elsewhere');
  fs.mkdirSync(real);
  fs.chmodSync(real, 0o755);
  fs.symlinkSync(real, path.join(home, '.claude-code-orchestrator'));
  const done = runChild(MODES_CHILD, { home });
  assert.equal(done.status, 0, done.stderr);
  assert.equal((fs.statSync(real).mode & 0o777).toString(8), '755', 'the directory behind the symlink was chmod-ed');
  assert.equal(JSON.parse(done.stdout).registry, '600');
});

// ---- renameWorker: all or nothing ----------------------------------------------------------

/** A registry with workers wa and wb, stats for wa, and a settled log naming wa. */
function renameFixture() {
  fresh();
  writeRegistryFile({ workers: [{ name: 'wa', configDir: '/acct/wa', model: 'opus' }, { name: 'wb', configDir: '/acct/wb', model: 'opus' }, UNSUPPORTED_NEW], custom: 1 });
  fs.writeFileSync(STATS, JSON.stringify({ wa: { tasks: 3, errors: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.5 }, wb: { tasks: 1, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }, null, 2));
  const lines = [
    JSON.stringify({ ts: 1, id: 't000000001', status: 'done', title: 'one', worker: 'wa', model: 'opus', outputFile: '/x' }),
    '{"ts":2,   "id":"t000000002","status":"done","worker":"wb","spacing":  "kept  as  is","n":1.0}',
    'this line is not JSON and must survive byte for byte',
    JSON.stringify({ ts: 3, id: 't000000003', status: 'error', title: 'failover', worker: 'wb,wa', model: 'opus', outputFile: '/x' }),
    JSON.stringify({ ts: 4, id: 't000000004', status: 'done', title: 'other', worker: 'wax', model: 'opus', outputFile: '/x' }),
  ];
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  return { registry: readFile(REGISTRY), stats: readFile(STATS), log: readFile(LOG), lines };
}
function assertOldNameEverywhere(before, label) {
  assert.equal(readFile(LOG), before.log, `${label}: the task log changed`);
  assert.deepEqual(readJson(STATS), JSON.parse(before.stats), `${label}: stats changed`);
  assert.equal(readFile(REGISTRY), before.registry, `${label}: the registry changed`);
}

await check('rename: the happy path renames all three, and re-writes only the lines that name the worker', () => {
  const before = renameFixture();
  reg.renameWorker('wa', 'wz');
  assert.deepEqual(readJson(REGISTRY).workers.map((w) => w.name), ['wz', 'wb']);
  assert.deepEqual(readJson(REGISTRY).vendorWorkers, [UNSUPPORTED_NEW], 'the unsupported entry was not kept verbatim');
  const stats = readJson(STATS);
  assert.ok('wz' in stats && !('wa' in stats) && stats.wz.tasks === 3);
  const lines = readFile(LOG).split('\n');
  assert.equal(JSON.parse(lines[0]).worker, 'wz');
  assert.equal(lines[1], before.lines[1], 'a line about another worker was re-spelled');
  assert.equal(lines[2], before.lines[2], 'an unparseable line was not preserved');
  assert.equal(JSON.parse(lines[3]).worker, 'wb,wz');
  assert.equal(lines[4], before.lines[4], 'a name that merely contains the old name was touched');
});

await check('rename: every check refuses BEFORE the first write (taken name, unsupported entry\'s name, unknown worker, running dispatch, unreadable registry)', () => {
  let before = renameFixture();
  assert.match(thrown(() => reg.renameWorker('wa', 'wb')).message, /already exists/);
  assertOldNameEverywhere(before, 'taken name');
  const held = thrown(() => reg.renameWorker('wa', 'oc'));
  assert.ok(held instanceof Error, 'a name held by an unsupported entry was accepted');
  assertOldNameEverywhere(before, "an unsupported entry's name");
  assert.match(thrown(() => reg.renameWorker('nobody', 'wz')).message, /No worker named/);
  assertOldNameEverywhere(before, 'unknown worker');

  before = renameFixture();
  fs.appendFileSync(LOG, JSON.stringify({ ts: 9, id: 't000000009', status: 'running', title: 'live', worker: 'wb', model: 'opus', outputFile: '/x' }) + '\n');
  before.log = readFile(LOG);
  assert.match(thrown(() => reg.renameWorker('wa', 'wz')).message, /dispatches are running/);
  assertOldNameEverywhere(before, 'running dispatch');

  before = renameFixture();
  writeRegistryFile(before.registry.replace(/\n}$/, ',\n}'));
  before.registry = readFile(REGISTRY);
  const refused = thrown(() => reg.renameWorker('wa', 'wz'));
  assert.equal(need('isStateWriteRefusal')(refused), true, `an unreadable registry did not refuse the rename: ${refused && refused.message}`);
  assert.equal(readFile(LOG), before.log, 'unreadable registry: the task log was rewritten first');
  assert.equal(readFile(STATS), before.stats, 'unreadable registry: stats were rewritten first');
  assert.equal(readFile(REGISTRY), before.registry);
});

await check('rename: a task log that cannot be read (over the cap, a directory) refuses before anything is written', () => {
  let before = renameFixture();
  fs.truncateSync(LOG, 64 * 1024 * 1024 + 1);
  assert.ok(thrown(() => reg.renameWorker('wa', 'wz')) instanceof Error, 'an oversize log did not refuse');
  assert.equal(readFile(STATS), before.stats);
  assert.equal(readFile(REGISTRY), before.registry);
  before = renameFixture();
  fs.rmSync(LOG);
  fs.mkdirSync(LOG);
  assert.ok(thrown(() => reg.renameWorker('wa', 'wz')) instanceof Error, 'a directory at the log path did not refuse');
  assert.equal(readFile(STATS), before.stats);
  assert.equal(readFile(REGISTRY), before.registry);
});

await check('rename: a write that fails after the others succeeded is undone, and the error says so', () => {
  if (!POSIX) {
    return 'skip';
  }
  // The registry is written last. A non-empty directory at its temp path makes that write fail.
  let before = renameFixture();
  const registryTmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.mkdirSync(registryTmp);
  fs.writeFileSync(path.join(registryTmp, 'squatter'), 'x');
  let err = thrown(() => reg.renameWorker('wa', 'wz'));
  fs.rmSync(registryTmp, { recursive: true, force: true });
  assert.ok(err instanceof Error, 'the rename did not report the failed registry write');
  assertOldNameEverywhere(before, 'registry write failed');
  assert.match(err.message, /all still use the old name/, err.message);
  assert.equal(need('isStateWriteRefusal')(err), false, 'a failure after writes began is not a clean refusal');

  // stats is written second: the task log, already rewritten, must come back.
  before = renameFixture();
  const statsTmp = `${STATS}.${process.pid}.tmp`;
  fs.mkdirSync(statsTmp);
  fs.writeFileSync(path.join(statsTmp, 'squatter'), 'x');
  err = thrown(() => reg.renameWorker('wa', 'wz'));
  fs.rmSync(statsTmp, { recursive: true, force: true });
  assert.ok(err instanceof Error, 'the rename did not report the failed stats write');
  assertOldNameEverywhere(before, 'stats write failed');
  assert.match(err.message, /all still use the old name/, err.message);
  // And the same rename then succeeds.
  reg.renameWorker('wa', 'wz');
  assert.deepEqual(readJson(REGISTRY).workers.map((w) => w.name), ['wz', 'wb']);
});

await check('rename: with the stats lock held by another process it is refused, and the log, stats and registry still say the OLD name', async () => {
  if (FAST) {
    return 'skip';
  }
  const before = renameFixture();
  const holding = path.join(WORK, `holding-${Date.now()}`);
  const release = path.join(WORK, `release-${Date.now()}`);
  const holderFile = path.join(WORK, 'hold-stats.cjs');
  fs.writeFileSync(
    holderFile,
    `
    const fs = require('fs');
    const reg = require(process.argv[2]);
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    reg.updateStats(() => {
      fs.writeFileSync(process.argv[3], String(process.pid));
      const started = Date.now();
      while (!fs.existsSync(process.argv[4]) && Date.now() - started < 120000) sleep(25);
    });
    `,
  );
  const holder = spawn(process.execPath, [holderFile, BUNDLE, holding, release], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'ignore' });
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  try {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(holding)) {
      assert.ok(Date.now() < deadline, 'the lock holder never took the stats lock');
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = Date.now();
    const err = thrown(() => reg.renameWorker('wa', 'wz'));
    const waited = Date.now() - started;
    assert.ok(err instanceof Error, 'renameWorker did not throw while the stats lock was held');
    assert.match(err.message, /^Could not lock stats\.json/, err.message);
    assert.ok(waited >= 10_000, `the refusal came after ${waited} ms — the lock was not actually waited for`);
    // The holder writes stats back unchanged when it is released, so compare by value.
    assertOldNameEverywhere(before, 'stats lock held');
    assert.equal(need('isStateWriteRefusal')(err), true);
  } finally {
    fs.writeFileSync(release, '1');
    await exited;
  }
  assertOldNameEverywhere(before, 'after the holder released');
  // Nothing is left locked: the same rename now goes through.
  reg.renameWorker('wa', 'wz');
  assert.deepEqual(readJson(REGISTRY).workers.map((w) => w.name), ['wz', 'wb']);
});

// ---- §10.6 the id rule in the event writer -------------------------------------------------

const REFUSED_PREFIX = 'task log append refused: ';
/** Ids that cannot name a file in the tasks directory. [what it is, the id] */
const NOT_FILE_IDS = [
  ['a path that leaves the directory', '../evil'],
  ['a deeper one', '../../victim-by-id'],
  ['a separator', 'a/b'],
  ['a backslash', 'a\\b'],
  ['a dot', 'tabc.12345'],
  ['a single dot', '.'],
  ['the empty string', ''],
  ['a space', 'tabc 12345'],
  ['a line break', 'tabc12345\n'],
  ['a NUL', 'tabc\u000012345'],
  ['a letter outside ASCII', 'täsk12345'],
  ['129 characters', 'x'.repeat(129)],
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
  ['an array', ['tabc12345']],
  ['an object that prints as an id', { toString: () => 'tabc12345' }],
];
/** Ids that can — the shapes this product mints, and the ones this file plants. */
const FILE_IDS = ['tabc12345', 'tmv6vsustoxk8', 'reap-done-1', 'shape-1', 'T_9-z', '0', '-', '_', 'x'.repeat(128)];

await check('10.6 appendTaskEvent: an event whose id cannot name a task file is refused, and nothing is written', () => {
  for (const [what, id] of NOT_FILE_IDS) {
    for (const status of ['running', 'done', 'error']) {
      fresh();
      const err = thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id, status }));
      assert.ok(err instanceof Error, `${what} (${status}): the event was accepted`);
      assert.ok(err.message.startsWith(REFUSED_PREFIX), `${what} (${status}): the refusal reads "${oneLine(err)}"`);
      assert.ok(!fs.existsSync(LOG), `${what} (${status}): a log was created`);
      assert.deepEqual(fs.readdirSync(TASKS), [], `${what} (${status}): something was left in the tasks directory`);
    }
  }
});

await check('10.6 appendTaskEvent: the refusal leaves a log that already has lines byte for byte as it was', () => {
  fresh();
  reg.appendTaskEvent({ ...BASE_EVENT, title: 'first' });
  // A torn tail too: the separator the writer puts in front of a record must not be written
  // for a record that is refused.
  fs.appendFileSync(LOG, '{"ts":1,"id":"ttorn0001","sta');
  const before = fs.readFileSync(LOG);
  for (const [what, id] of NOT_FILE_IDS) {
    assert.ok(thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id })) instanceof Error, `${what}: accepted`);
    assert.ok(fs.readFileSync(LOG).equals(before), `${what}: the log changed`);
  }
});

await check('10.6 appendTaskEvent: the refusal is one line of literals — it does not carry the id it refused', () => {
  fresh();
  const marker = 'SENTINEL_id_Zq7';
  const messages = new Set();
  for (const id of [`../${marker}`, `${marker}/x`, `${marker}.md`, `${marker} `, `${marker}${'y'.repeat(200)}`]) {
    const err = thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id }));
    assert.ok(err instanceof Error && err.message.startsWith(REFUSED_PREFIX), `accepted: ${id.slice(0, 40)}`);
    assert.ok(!err.message.includes(marker), `the refusal quotes the id: ${oneLine(err)}`);
    assert.ok(!/[\r\n]/.test(err.message) && err.message.length <= 200, `not one short line: ${oneLine(err)}`);
    messages.add(err.message);
  }
  assert.equal(messages.size, 1, 'the wording depends on the id');
});

await check('10.6 appendTaskEvent: an id that can name a task file is written as before — every shape this product mints or this file plants', () => {
  fresh();
  for (const id of FILE_IDS) {
    reg.appendTaskEvent({ ...BASE_EVENT, id });
  }
  assert.deepEqual(logLines().map((l) => JSON.parse(l).id), FILE_IDS);
  assert.equal(readFile(LOG), FILE_IDS.map((id) => `${JSON.stringify({ ...BASE_EVENT, id })}\n`).join(''));
});

await check('10.6 the id rule comes before the size rule: an oversized event under an id that is no file id is refused for its id', () => {
  fresh();
  const err = thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id: '../evil', title: 'T'.repeat(200_000), promptPreview: 'P'.repeat(200_000) }));
  assert.ok(err instanceof Error && /^task log append refused: the id of the event is not a task id/.test(err.message), oneLine(err));
  assert.ok(!fs.existsSync(LOG), 'something was appended');
});

await check('10.6 the sweep can still CLOSE a line that is already in the log under such an id — one terminal line, no file — and nothing can add to it through appendTaskEvent', () => {
  fresh();
  const good = 'tneighbour01';
  const escaping = '../../closed-by-the-sweep';
  const outside = path.join(HOME, 'closed-by-the-sweep');
  assert.equal(path.join(TASKS, `${escaping}.md`), `${outside}.md`, 'fixture: the id does not land where the test looks');
  appendLines([
    { ts: Date.now() - PIDLESS_DEAD_AGE_MS - 2000, id: escaping, status: 'running', title: 'escaping', worker: 'wa', model: 'opus', outputFile: `${outside}.md`, supervisorPid: deadPid() },
    { ts: Date.now() - PIDLESS_DEAD_AGE_MS - 1000, id: good, status: 'running', title: 'neighbour', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, `${good}.md`), pid: deadPid() },
    { ts: Date.now() - PIDLESS_DEAD_AGE_MS - 500, id: 'a b', status: 'running', title: 'spaced', worker: 'wa', model: 'opus', outputFile: '/x' },
  ]);
  assert.equal(need('runningCounts')().wa, 3, 'fixture: the three lines are not counted as running');
  assert.equal(reg.reapDeadTasks(), 3, 'a dead task was left running because of its id');
  const after = logLines().map((l) => JSON.parse(l));
  assert.equal(after.length, 6, 'not exactly one terminal line per task');
  for (const id of [escaping, good, 'a b']) {
    const own = after.filter((e) => e.id === id);
    assert.deepEqual(own.map((e) => e.status), ['running', 'error'], `the lines under ${JSON.stringify(id)}`);
  }
  assert.equal(need('runningCounts')().wa ?? 0, 0, 'a closed line still counts against its worker');
  assert.deepEqual(fs.readdirSync(HOME).filter((n) => n.includes('closed-by')), [], 'a file was created outside the tasks directory');
  assert.deepEqual(fs.readdirSync(TASKS).filter((n) => n.endsWith('.md') && !n.startsWith(good)), [], 'a report was created for a task that can have none');
  // Closed is closed: a second sweep adds nothing, and the writer every caller uses still
  // refuses the id — for a progress note, for a second terminal event, for a reopening.
  assert.equal(reg.reapDeadTasks(), 0);
  const bytes = fs.readFileSync(LOG);
  for (const status of ['running', 'done', 'error']) {
    const err = thrown(() => reg.appendTaskEvent({ ...BASE_EVENT, id: escaping, status }));
    assert.ok(err instanceof Error && err.message.startsWith(REFUSED_PREFIX), `${status}: appended under the id that is no file id`);
  }
  assert.ok(fs.readFileSync(LOG).equals(bytes), 'the log changed');
});

// ---- done ----------------------------------------------------------------------------------

fs.rmSync(WORK, { recursive: true, force: true });
// Contract §15.12 M4 (wave 11b): the dispatcher's grace for a `running` event that names no process.
await check('15.12 M4 a running event with no pid that is younger than FAILOVER_GRACE_MS reads alive; older, or naming a dead pid, settles', () => {
  fresh();
  const now = Date.now();
  appendLines([
    { ts: now - 5_000, id: 'tgrace000001', status: 'running', title: 'between attempts', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, 'tgrace000001.md') },
    { ts: now - 179_000, id: 'tgrace000002', status: 'running', title: 'just inside', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, 'tgrace000002.md') },
    { ts: now - 181_000, id: 'tgrace000003', status: 'running', title: 'just outside', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, 'tgrace000003.md') },
    { ts: now - 5_000, id: 'tgrace000004', status: 'running', title: 'young but its pid is dead', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, 'tgrace000004.md'), pid: deadPid() },
    { ts: now + 3_600_000, id: 'tgrace000005', status: 'running', title: 'stamped an hour ahead', worker: 'wa', model: 'opus', outputFile: path.join(TASKS, 'tgrace000005.md') },
  ]);
  assert.equal(reg.reapDeadTasks(), 3, 'exactly the outside-grace, the dead-pid and the future-stamped tasks settle');
  const statusOf = (id) => reg.latestEventById(id).status;
  assert.deepEqual(
    ['tgrace000001', 'tgrace000002', 'tgrace000003', 'tgrace000004', 'tgrace000005'].map(statusOf),
    ['running', 'running', 'error', 'error', 'error'],
  );
});

console.log(`\n${tally.pass} passed, ${tally.fail} failed${tally.skip ? `, ${tally.skip} skipped` : ''} — src: ${SRC}`);
process.exit(tally.fail === 0 ? 0 : 1);
