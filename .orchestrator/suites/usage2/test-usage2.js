'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* usage.ts — other vendors' accounts. Fakes only: a fake helper stands in for provider-cli.js
 * and a fake `claude` proves the Claude probe never visits another vendor's directory.
 *   env -i HOME=<scratch home> PATH=$PATH TMPDIR=$TMPDIR <identity vars> node --no-deprecation test-usage2.js <usage bundle> [--slow]
 * `--slow` adds the cases that have to wait out the 25 s cap.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
if (process.env.CLAUDE_CONFIG_DIR) {
  console.error('refusing to run: CLAUDE_CONFIG_DIR is set');
  process.exit(2);
}
const SLOW = process.argv.includes('--slow');
const ROOT = path.join(HOME, '.claude-code-orchestrator');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const CACHE = path.join(ROOT, 'usage.json');
const REGISTRY = path.join(ROOT, 'registry.json');
const HELPER = path.join(__dirname, 'fake-helper.js');
const FAKE_CLAUDE = path.join(__dirname, '..', 'lib', 'fake-claude.js');
fs.chmodSync(FAKE_CLAUDE, 0o755);
const HLOG = path.join(HOME, 'helper-log.jsonl');
const CLOG = path.join(HOME, 'claude-log.jsonl');
process.env.FAKE_HELPER_LOG = HLOG;
process.env.FAKE_LOG = CLOG;
process.env.FAKE_MODE = '';
process.env.KEEP_ME = 'kept';

const usage = require(path.resolve(process.argv[2]));
if (!usage.USAGE_CACHE_FILE.startsWith(HOME)) {
  console.error('refusing to run: cache file outside the scratch home: ' + usage.USAGE_CACHE_FILE);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + String(detail).slice(0, 420) + ']' : ''}`);
};
const quiet = (fn) => {
  try {
    return { value: fn(), threw: false };
  } catch (e) {
    return { value: undefined, threw: true, error: e };
  }
};
const cache = () => JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const entryOf = (dir) => {
  try {
    const c = cache();
    return Object.prototype.hasOwnProperty.call(c, dir) ? c[dir] : undefined;
  } catch {
    return undefined;
  }
};
const readLog = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const starts = () => readLog(HLOG).filter((e) => e.ev === 'start');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const D = (n) => path.join(HOME, n);
const MAIN = D('.claude');
const dirs = { claudeA: D('.claude-a'), typo: D('.claude-typo'), codex: D('.codex'), cursor: D('.cursor'), agy: D('.agy'), agy2: D('.agy-2'), extra: D('.codex-extra') };
// The registry file as 2.0 writes it: Claude Code accounts (no `provider` key) under `workers`, the
// accounts of other vendors' CLIs — every entry that carries a `provider` — under `vendorWorkers`.
// (Until the fix wave this fixture put all of them in `workers`, the layout of a 2.0 development build;
// that layout is still READ, and section A checks it reads the same.)
const split = (workers) => ({ workers: workers.filter((w) => !('provider' in w)), vendorWorkers: workers.filter((w) => 'provider' in w) });
const writeRegistry = (workers) => fs.writeFileSync(REGISTRY, JSON.stringify({ claudePath: FAKE_CLAUDE, ...split(workers) }));
const writeRegistryDevLayout = (workers) => fs.writeFileSync(REGISTRY, JSON.stringify({ claudePath: FAKE_CLAUDE, workers }));
const FULL = [
  { name: 'claude-a', configDir: dirs.claudeA },
  { name: 'codex-a', configDir: dirs.codex, provider: 'codex', model: 'gpt-5.6-sol' },
  { name: 'cursor-a', configDir: dirs.cursor, provider: 'cursor' },
  { name: 'agy-a', configDir: dirs.agy, provider: 'gemini' },
  { name: 'typo', configDir: dirs.typo, provider: 'codexx' },
  { name: 'codex-dup', configDir: dirs.codex + '/', provider: 'cursor' },
  { name: 'codex-on-claude-dir', configDir: dirs.claudeA, provider: 'codex' },
  { name: 'codex-on-main', configDir: MAIN, provider: 'codex' },
  { name: 'alias', configDir: dirs.agy2, provider: 'Antigravity' },
];
writeRegistry(FULL);

const WELL_FORMED = (e) => {
  const problems = [];
  if (typeof e !== 'object' || e === null) return ['not an object'];
  if (typeof e.name !== 'string') problems.push('name');
  if (typeof e.configDir !== 'string') problems.push('configDir');
  if (typeof e.available !== 'boolean') problems.push('available');
  if (!(e.subscriptionType === null || (typeof e.subscriptionType === 'string' && e.subscriptionType.length <= 32 && !/[\u0000-\u001f\u007f‪-‮]/.test(e.subscriptionType)))) problems.push('subscriptionType');
  if (!Array.isArray(e.windows) || e.windows.length > 8) problems.push('windows');
  for (const w of Array.isArray(e.windows) ? e.windows : []) {
    if (!['session', 'weekly_all', 'weekly_scoped'].includes(w.kind)) problems.push('kind ' + w.kind);
    if (typeof w.label !== 'string' || w.label === '' || w.label.length > 40 || /[\u0000-\u001f\u007f‪-‮]/.test(w.label)) problems.push('label ' + JSON.stringify(w.label));
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent) || w.percent < 0 || w.percent > 100) problems.push('percent ' + w.percent);
    if (!['normal', 'warning', 'critical'].includes(w.severity)) problems.push('severity');
    if (!(w.resetsAt === null || (typeof w.resetsAt === 'string' && new Date(w.resetsAt).toISOString() === w.resetsAt))) problems.push('resetsAt ' + w.resetsAt);
  }
  if (e.sessionCostUsd !== null) problems.push('sessionCostUsd');
  if (e.extraUsage !== null) problems.push('extraUsage');
  if (typeof e.fetchedAt !== 'number' || !Number.isFinite(e.fetchedAt)) problems.push('fetchedAt');
  if ('error' in e && (typeof e.error !== 'string' || e.error === '' || e.error.length > 200 || /[\u0000-\u001f\u007f‪-‮]/.test(e.error))) problems.push('error ' + JSON.stringify(e.error));
  if ('auth' in e && (typeof e.auth !== 'object' || typeof e.auth.loggedIn !== 'boolean' || e.auth.email !== null || typeof e.auth.checkedAt !== 'number')) problems.push('auth');
  return problems;
};

(async () => {
  console.log('--- A. which accounts each list holds');
  {
    const names = usage.listAccounts().map((a) => a.name);
    // [2.0: was ['main', 'claude-a', 'typo'] — "an unknown provider id reads as Claude"] An entry whose
    // provider this version does not know is an unsupported entry: it is in no list at all.
    check('listAccounts() = main + Claude workers only (an entry with an unknown provider id is NOT a Claude account)', JSON.stringify(names) === JSON.stringify(['main', 'claude-a']), JSON.stringify(names));
    check('the entry with an unknown provider id ("codexx") is in neither list, by name or by directory',
      !usage.listAccounts().some((a) => a.name === 'typo' || a.configDir === dirs.typo) && !usage.listProviderAccounts().some((a) => a.name === 'typo' || a.configDir === dirs.typo));
    check('listAccounts() omits the Codex worker', !usage.listAccounts().some((a) => a.name === 'codex-a' || a.configDir === dirs.codex));
    check('listAccounts() omits a Codex worker even when it names a Claude directory', !names.includes('codex-on-claude-dir') && !names.includes('codex-on-main'));
    const prov = usage.listProviderAccounts();
    check('listProviderAccounts() = one per directory, none on a Claude directory, alias resolved', JSON.stringify(prov.map((a) => [a.name, a.provider])) === JSON.stringify([['codex-a', 'codex'], ['cursor-a', 'cursor'], ['agy-a', 'gemini'], ['alias', 'gemini']]), JSON.stringify(prov.map((a) => [a.name, a.provider])));
    // the same accounts in the layout a 2.0 development build wrote (everything under `workers`) read the same
    const canonical = JSON.stringify([usage.listAccounts(), usage.listProviderAccounts()]);
    writeRegistryDevLayout(FULL);
    const devLayout = JSON.stringify([usage.listAccounts(), usage.listProviderAccounts()]);
    writeRegistry(FULL);
    check('the development-build layout (vendor accounts under `workers`) reads as exactly the same two lists', devLayout === canonical && JSON.parse(devLayout)[1].length === 4, devLayout.slice(0, 200));
  }

  console.log('--- B. recordProviderStatus: the mapping');
  const T0 = Date.now() - 5 * 60_000;
  const W = { name: 'codex-a', configDir: dirs.codex };
  {
    const r = quiet(() =>
      usage.recordProviderStatus(W, {
        cliFound: true, loggedIn: true, mode: 'chatgpt', error: null,
        quota: { allowed: true, windows: [
          { label: '5h limit', usedPercent: 42.5, resetAt: '2031-01-01T00:00:00Z' },
          { label: 'Weekly limit', usedPercent: 80, resetAt: '2031-01-05T12:00:00+09:00' },
          { label: 'Code review', usedPercent: 95, resetAt: null },
          { label: 'Fourth', usedPercent: 10, resetAt: null },
          { label: 'Fifth', usedPercent: 74.99, resetAt: null },
        ] },
      }, T0));
    const e = entryOf(dirs.codex);
    check('B1 logged in WITH quota: does not throw, entry is well-formed', !r.threw && WELL_FORMED(e).length === 0, JSON.stringify(WELL_FORMED(e)));
    check('B1 available / subscriptionType / no error', e.available === true && e.subscriptionType === 'chatgpt' && !('error' in e) && e.name === 'codex-a' && e.configDir === dirs.codex);
    check('B1 kinds: first session, second weekly_all, EVERY further one weekly_scoped', JSON.stringify(e.windows.map((w) => w.kind)) === JSON.stringify(['session', 'weekly_all', 'weekly_scoped', 'weekly_scoped', 'weekly_scoped']), JSON.stringify(e.windows.map((w) => w.kind)));
    check('B1 labels are the vendor\'s own', JSON.stringify(e.windows.map((w) => w.label)) === JSON.stringify(['5h limit', 'Weekly limit', 'Code review', 'Fourth', 'Fifth']));
    check('B1 severity: critical ≥ 90, warning ≥ 75, else normal', JSON.stringify(e.windows.map((w) => w.severity)) === JSON.stringify(['normal', 'warning', 'critical', 'normal', 'normal']), JSON.stringify(e.windows.map((w) => [w.percent, w.severity])));
    check('B1 resetsAt canonical ISO / null', e.windows[0].resetsAt === '2031-01-01T00:00:00.000Z' && e.windows[1].resetsAt === '2031-01-05T03:00:00.000Z' && e.windows[2].resetsAt === null);
    check('B1 auth = {loggedIn:true, method:mode, email:null, checkedAt:now}', JSON.stringify(e.auth) === JSON.stringify({ loggedIn: true, method: 'chatgpt', email: null, checkedAt: T0 }), JSON.stringify(e.auth));
    check('B1 timestamps: fetchedAt = windowsFetchedAt = lastGoodWindowsAt = now, not stale', e.fetchedAt === T0 && e.windowsFetchedAt === T0 && e.lastGoodWindowsAt === T0 && e.windowsStale === false);
    check('B1 shared gates: not expired, not exhausted, not "CLI missing"', usage.isLoginExpired(e) === false && usage.exhaustedWindows(e, Date.now()).length === 0 && usage.isProviderCliMissing(e) === false);
  }
  {
    // severity boundaries, exactly
    usage.recordProviderStatus({ name: 'x', configDir: dirs.extra }, { cliFound: true, loggedIn: true, mode: null, error: null, quota: { allowed: true, windows: [{ label: 'a', usedPercent: 90, resetAt: null }, { label: 'b', usedPercent: 89.999, resetAt: null }, { label: 'c', usedPercent: 75, resetAt: null }, { label: 'd', usedPercent: 100, resetAt: null }, { label: 'e', usedPercent: 250, resetAt: null }, { label: 'f', usedPercent: -3, resetAt: null }] } }, T0);
    const e = entryOf(dirs.extra);
    check('B1b boundaries 90 / 89.999 / 75 and clamping of 250 and -3', JSON.stringify(e.windows.map((w) => [w.percent, w.severity])) === JSON.stringify([[90, 'critical'], [89.999, 'warning'], [75, 'warning'], [100, 'critical'], [100, 'critical'], [0, 'normal']]), JSON.stringify(e.windows.map((w) => [w.percent, w.severity])));
    check('B1b a window at 100 % with no reset is what exhaustedWindows reports', usage.exhaustedWindows(e, Date.now()).length === 2);
    fs.rmSync(CACHE);
  }
  {
    const dir = dirs.cursor;
    const r = quiet(() => usage.recordProviderStatus({ name: 'cursor-a', configDir: dir }, { cliFound: true, loggedIn: true, mode: 'cursor', quota: null, error: null }, T0));
    const e = entryOf(dir);
    check('B2 logged in, NO quota: well-formed, available false, no windows, no error, auth.loggedIn true', !r.threw && WELL_FORMED(e).length === 0 && e.available === false && e.windows.length === 0 && !('error' in e) && e.auth.loggedIn === true && e.auth.method === 'cursor' && e.subscriptionType === 'cursor', JSON.stringify(e));
    check('B2 not expired', usage.isLoginExpired(e) === false);
  }
  {
    const dir = dirs.agy;
    const r = quiet(() => usage.recordProviderStatus({ name: 'agy-a', configDir: dir }, { cliFound: true, loggedIn: false, mode: null, quota: null, error: null }, T0));
    const e = entryOf(dir);
    check('B3 logged OUT: well-formed, auth.loggedIn false, no error → isLoginExpired() is true', !r.threw && WELL_FORMED(e).length === 0 && e.available === false && e.auth.loggedIn === false && !('error' in e) && usage.isLoginExpired(e) === true, JSON.stringify(e));
    usage.recordProviderStatus({ name: 'agy-a', configDir: dir }, { cliFound: true, loggedIn: false, mode: 'oauth', quota: { allowed: true, windows: [{ label: 'x', usedPercent: 5, resetAt: null }] }, error: 'not signed in' }, T0 + 1);
    const e2 = entryOf(dir);
    check('B3b logged out beside an error text AND a quota: still the plain logged-out reading', e2.available === false && e2.windows.length === 0 && !('error' in e2) && usage.isLoginExpired(e2) === true, JSON.stringify(e2));
  }
  {
    const dir = dirs.agy2;
    const r = quiet(() => usage.recordProviderStatus({ name: 'alias', configDir: dir }, { cliFound: true, loggedIn: null, mode: null, quota: null, error: null }, T0));
    const e = entryOf(dir);
    check('B4 loggedIn null: well-formed, NO auth key at all, no error, not "expired"', !r.threw && WELL_FORMED(e).length === 0 && !('auth' in e) && !('error' in e) && e.available === false && usage.isLoginExpired(e) === false && usage.parseAuth(e.auth) === undefined, JSON.stringify(e));
    usage.recordProviderStatus({ name: 'alias', configDir: dir }, { cliFound: true, loggedIn: null, mode: null, quota: null, error: 'the login check did not answer in time' }, T0 + 1);
    const e2 = entryOf(dir);
    check('B4b loggedIn null WITH a reason: the reason is the entry\'s error', e2.error === 'the login check did not answer in time' && !('auth' in e2) && usage.isLoginExpired(e2) === false && usage.isProviderCliMissing(e2) === false, JSON.stringify(e2));
    usage.recordProviderStatus({ name: 'alias', configDir: dir }, { cliFound: true, loggedIn: true, mode: 'x', quota: null, error: 'the usage reading failed: 503' }, T0 + 2);
    const e3 = entryOf(dir);
    check('B4c logged in, quota failed with a reason: error stored, auth kept', e3.error === 'the usage reading failed: 503' && e3.auth.loggedIn === true && e3.available === false, JSON.stringify(e3));
  }
  {
    const dir = dirs.extra;
    const r = quiet(() => usage.recordProviderStatus({ name: 'x', configDir: dir }, { cliFound: false, loggedIn: null, mode: null, quota: null, error: 'codex not found — the Codex CLI is not installed or not on PATH' }, T0));
    const e = entryOf(dir);
    check('B5 CLI not found: well-formed; error = stable prefix + ": " + detail', !r.threw && WELL_FORMED(e).length === 0 && e.error === 'CLI not found: codex not found — the Codex CLI is not installed or not on PATH' && usage.PROVIDER_CLI_NOT_FOUND === 'CLI not found', JSON.stringify(e));
    check('B5 isProviderCliMissing true; no auth; available false; not expired', usage.isProviderCliMissing(e) === true && !('auth' in e) && e.available === false && usage.isLoginExpired(e) === false);
    console.log('     stored shape (CLI not found): ' + JSON.stringify(e));
    usage.recordProviderStatus({ name: 'x', configDir: dir }, { cliFound: false, loggedIn: true, mode: 'chatgpt', quota: { allowed: true, windows: [{ label: 'a', usedPercent: 5, resetAt: null }] }, error: null }, T0 + 1);
    const e2 = entryOf(dir);
    check('B5b CLI not found with no detail (and contradictory login/quota): error is exactly the prefix, nothing else believed', e2.error === 'CLI not found' && e2.available === false && e2.windows.length === 0 && !('auth' in e2) && usage.isProviderCliMissing(e2) === true, JSON.stringify(e2));
    check('B5c isProviderCliMissing is exact about the prefix', [{ error: 'CLI not foundation' }, { error: 'timeout' }, { error: 'cli not found' }, { error: 5 }, { error: null }, {}, undefined, null].every((u) => usage.isProviderCliMissing(u) === false) && usage.isProviderCliMissing({ error: 'CLI not found' }) && usage.isProviderCliMissing({ error: 'CLI not found: x' }));
    fs.rmSync(CACHE);
  }

  console.log('--- C. recordProviderStatus: hostile and malformed statuses');
  {
    const dir = dirs.codex;
    const windows = [];
    for (let i = 0; i < 500; i++) {
      windows.push({ label: '<img src=x onerror=alert(1)>‮\u0007\n\t' + 'L'.repeat(5000), usedPercent: [NaN, Infinity, -Infinity, '50', null, undefined, {}, 1e308, -40, 55][i % 10], resetAt: [12345, 'not a date', '9'.repeat(5000), {}, '2031-02-30T99:99:99Z', '275760-09-14T00:00:00Z'][i % 6] });
    }
    const hostile = { cliFound: 'yes', loggedIn: 'true', mode: 12, quota: { allowed: 'maybe', windows }, error: { a: 1 } };
    const r = quiet(() => usage.recordProviderStatus(W, hostile, T0));
    const e = entryOf(dir);
    check('C1 hostile status (non-finite %, 500 windows, markup/bidi/control in labels, wrong types): no throw, entry well-formed', !r.threw && WELL_FORMED(e).length === 0, JSON.stringify(WELL_FORMED(e)));
    check('C1 at most 8 windows, and only from the first 32 looked at', e.windows.length <= 8 && e.windows.length > 0, 'windows=' + e.windows.length);
    check('C1 a non-finite or non-number percentage DROPS the window (never 0 %)', e.windows.every((w) => [100, 0, 55].includes(w.percent)), JSON.stringify(e.windows.map((w) => w.percent)));
    check('C1 labels are one line, ≤ 40 chars, with no control or bidi characters (markup is text, not removed)', e.windows.every((w) => w.label.length <= 40 && !/[\u0000-\u001f‮]/.test(w.label) && w.label.startsWith('<img')), JSON.stringify(e.windows[0].label));
    check('C1 wrong-typed login / mode / error are "unknown": no auth, null plan, no error', !('auth' in e) && e.subscriptionType === null && !('error' in e) && e.available === true);
    check('C1 no reset that is not a real date survives', e.windows.every((w) => w.resetsAt === null), JSON.stringify(e.windows.map((w) => w.resetsAt)));
    fs.rmSync(CACHE);
  }
  {
    const dir = dirs.codex;
    let i = 0;
    for (const bad of [null, undefined, 'a string', 42, [], true, () => 1]) {
      const r = quiet(() => usage.recordProviderStatus(W, bad, T0 + ++i));
      const e = entryOf(dir);
      check(`C2 status ${bad === undefined ? 'undefined' : typeof bad === 'function' ? 'function' : JSON.stringify(bad)}: no throw, well-formed error entry`, !r.threw && WELL_FORMED(e).length === 0 && e.error === 'provider status unreadable' && e.fetchedAt === T0 + i, JSON.stringify(e));
    }
    const thrower = { get cliFound() { throw new Error('getter'); } };
    const r = quiet(() => usage.recordProviderStatus(W, thrower, T0 + 50));
    check('C2 a status whose property access throws: no throw', !r.threw);
    const proxy = new Proxy({}, { get() { throw new Error('proxy'); }, has() { throw new Error('proxy'); }, ownKeys() { throw new Error('proxy'); } });
    check('C2 a Proxy status that throws on everything: no throw', !quiet(() => usage.recordProviderStatus(W, proxy, T0 + 51)).threw);
    fs.rmSync(CACHE, { force: true });
  }
  {
    const dir = dirs.codex;
    const shapes = [
      ['quota is an array', { cliFound: true, loggedIn: true, mode: null, quota: [], error: null }, (e) => e.available === false],
      ['quota.windows is an object', { cliFound: true, loggedIn: true, mode: null, quota: { allowed: true, windows: { 0: { label: 'a', usedPercent: 1 } } }, error: null }, (e) => e.available === true && e.windows.length === 0],
      ['quota.windows holds non-objects', { cliFound: true, loggedIn: true, mode: null, quota: { allowed: true, windows: [null, 5, 'x', [], { label: 'ok', usedPercent: 7, resetAt: null }] }, error: null }, (e) => e.windows.length === 1 && e.windows[0].kind === 'weekly_scoped' && e.windows[0].label === 'ok'],
      ['a window with no label gets a positional one', { cliFound: true, loggedIn: true, mode: null, quota: { allowed: true, windows: [{ usedPercent: 7 }, { label: '   ', usedPercent: 8 }] }, error: null }, (e) => e.windows[0].label === 'Window 1' && e.windows[1].label === 'Window 2' && e.windows[0].resetsAt === null],
      ['mode of 5,000 chars with newlines', { cliFound: true, loggedIn: true, mode: 'chat\ngpt‮' + 'm'.repeat(5000), quota: null, error: null }, (e) => e.subscriptionType.length <= 32 && !/[\n‮]/.test(e.subscriptionType) && e.auth.method === e.subscriptionType],
      ['error of 5,000 chars with newlines and a NUL', { cliFound: true, loggedIn: null, mode: null, quota: null, error: 'bad\n\u0000thing‮ ' + 'e'.repeat(5000) }, (e) => e.error.length <= 200 && !/[\n\u0000‮]/.test(e.error)],
      ['CLI-not-found detail of 5,000 chars', { cliFound: false, loggedIn: null, mode: null, quota: null, error: 'd'.repeat(5000) }, (e) => e.error.length <= 200 && e.error.startsWith('CLI not found: d') && usage.isProviderCliMissing(e)],
      ['error that is only whitespace / control characters', { cliFound: true, loggedIn: true, mode: null, quota: null, error: ' \n\t\u0000 ' }, (e) => !('error' in e)],
      ['cliFound: 0 (falsy, not false) is not a "missing CLI" claim', { cliFound: 0, loggedIn: true, mode: null, quota: null, error: null }, (e) => !('error' in e) && e.auth.loggedIn === true],
      ['loggedIn: 0 / "false" are not verdicts', { cliFound: true, loggedIn: 0, mode: null, quota: null, error: null }, (e) => !('auth' in e) && usage.isLoginExpired(e) === false],
      ['an empty object', {}, (e) => e.available === false && !('auth' in e) && !('error' in e)],
    ];
    let i = 100;
    for (const [label, status, expect] of shapes) {
      const r = quiet(() => usage.recordProviderStatus(W, status, T0 + ++i));
      const e = entryOf(dir);
      check(`C3 ${label}: no throw, well-formed, as pinned`, !r.threw && WELL_FORMED(e).length === 0 && e.fetchedAt === T0 + i && expect(e), JSON.stringify(e).slice(0, 300) + ' ' + JSON.stringify(WELL_FORMED(e)));
    }
    fs.rmSync(CACHE, { force: true });
  }
  {
    const before = fs.existsSync(CACHE);
    const ok = { cliFound: true, loggedIn: true, mode: null, quota: null, error: null };
    const bads = [null, undefined, 'codex-a', 5, [], {}, { name: 5, configDir: dirs.codex }, { name: 'x' }, { name: 'x', configDir: 5 }, { name: 'x', configDir: '   ' }, { name: 'x', configDir: '' }];
    const threw = bads.some((w) => quiet(() => usage.recordProviderStatus(w, ok, T0)).threw);
    check('C4 a worker with no usable name / config dir: no throw and nothing written', !threw && fs.existsSync(CACHE) === before && !fs.existsSync(CACHE));
    const r = quiet(() => usage.recordProviderStatus({ name: 'x', configDir: '__proto__' }, ok, T0));
    check('C4 configDir "__proto__": no throw, no prototype pollution', !r.threw && {}.available === undefined && Object.prototype.available === undefined);
    for (const now of [NaN, Infinity, 'soon', null, undefined, -Infinity]) {
      const t = Date.now();
      usage.recordProviderStatus(W, ok, now);
      const e = entryOf(dirs.codex);
      check(`C4 now = ${String(now)} → the current time is used`, Number.isFinite(e.fetchedAt) && e.fetchedAt >= t && e.fetchedAt <= Date.now() && e.auth.checkedAt === e.fetchedAt, String(e.fetchedAt));
    }
    fs.rmSync(CACHE, { force: true });
  }

  console.log('--- D. a Claude account\'s reading is never overwritten');
  {
    const claudeReading = (name, dir) => ({ name, configDir: dir, available: true, subscriptionType: 'max', windows: [{ kind: 'session', label: 'Session (5hr)', percent: 10, severity: 'normal', resetsAt: null }], sessionCostUsd: null, extraUsage: null, fetchedAt: T0 });
    fs.writeFileSync(CACHE, JSON.stringify({ [dirs.claudeA]: claudeReading('claude-a', dirs.claudeA), [MAIN]: claudeReading('main', MAIN) }));
    const before = fs.readFileSync(CACHE, 'utf8');
    const loggedOut = { cliFound: true, loggedIn: false, mode: null, quota: null, error: null };
    usage.recordProviderStatus({ name: 'codex-on-claude-dir', configDir: dirs.claudeA }, loggedOut);
    usage.recordProviderStatus({ name: 'codex-on-claude-dir', configDir: dirs.claudeA + '/' }, loggedOut);
    usage.recordProviderStatus({ name: 'codex-on-main', configDir: MAIN }, loggedOut);
    usage.recordProviderStatus({ name: 'x', configDir: path.join(MAIN, '..', '.claude') }, loggedOut);
    // [2.0: a fifth call, for the "typo" entry's directory, and its seeded Claude reading, are gone from this
    // check — that entry is no longer a Claude account (see section A), so the rule has nothing to say about it]
    check('D1 a "logged out" recorded for a directory that is a Claude account\'s (worker, main, other spellings) writes nothing', fs.readFileSync(CACHE, 'utf8') === before && usage.isLoginExpired(entryOf(dirs.claudeA)) === false && usage.isLoginExpired(entryOf(MAIN)) === false);
    usage.recordProviderStatus(W, loggedOut);
    const c = cache();
    check('D2 a provider reading is merged in beside the Claude readings, which survive untouched', Object.keys(c).length === 3 && JSON.stringify(c[dirs.claudeA]) === JSON.stringify(claudeReading('claude-a', dirs.claudeA)) && JSON.stringify(c[MAIN]) === JSON.stringify(claudeReading('main', MAIN)) && usage.isLoginExpired(c[dirs.codex]) === true, JSON.stringify(Object.keys(c)));
    fs.rmSync(CACHE);
  }

  console.log('--- E. a reading without a quota does not blank a recent one');
  {
    const withQuota = { cliFound: true, loggedIn: true, mode: 'chatgpt', error: null, quota: { allowed: true, windows: [{ label: '5h limit', usedPercent: 99.5, resetAt: null }] } };
    const noQuota = { cliFound: true, loggedIn: true, mode: 'chatgpt', quota: null, error: null };
    const t = Date.now() - 40 * 60_000;
    usage.recordProviderStatus(W, withQuota, t);
    usage.recordProviderStatus(W, noQuota, t + 60_000);
    let e = entryOf(dirs.codex);
    check('E1 one minute later, no quota in the status: the windows are kept, marked stale, dated to when they were seen', e.available === true && e.windows.length === 1 && e.windows[0].percent === 99.5 && e.windowsStale === true && e.windowsFetchedAt === t && e.fetchedAt === t + 60_000 && e.lastGoodWindowsAt === t && WELL_FORMED(e).length === 0, JSON.stringify(e));
    check('E1 and the exhausted window still gates dispatch while it is carried', usage.exhaustedWindows(e, t + 60_000).length === 1);
    usage.recordProviderStatus(W, noQuota, t + 29 * 60_000);
    e = entryOf(dirs.codex);
    check('E2 29 minutes after the snapshot: still carried, still dated to the snapshot', e.available === true && e.windowsStale === true && e.windowsFetchedAt === t);
    usage.recordProviderStatus(W, noQuota, t + 31 * 60_000);
    e = entryOf(dirs.codex);
    check('E3 31 minutes after the snapshot: the carry has expired — no windows, available false, last-good time kept', e.available === false && e.windows.length === 0 && e.windowsStale !== true && e.lastGoodWindowsAt === t && e.auth.loggedIn === true, JSON.stringify(e));
    usage.recordProviderStatus(W, withQuota, t + 32 * 60_000);
    usage.recordProviderStatus(W, { cliFound: true, loggedIn: false, mode: null, quota: null, error: null }, t + 33 * 60_000);
    e = entryOf(dirs.codex);
    check('E4 a LOGGED-OUT reading never carries windows (it must read as expired)', e.available === false && e.windows.length === 0 && usage.isLoginExpired(e) === true && e.lastGoodWindowsAt === t + 32 * 60_000, JSON.stringify(e));
    usage.recordProviderStatus(W, withQuota, t + 34 * 60_000);
    usage.recordProviderStatus(W, { cliFound: true, loggedIn: true, mode: null, quota: null, error: 'the usage reading failed' }, t + 35 * 60_000);
    e = entryOf(dirs.codex);
    check('E5 a FAILED reading does not carry either (same as a failed Claude probe)', e.available === false && e.windows.length === 0 && e.error === 'the usage reading failed' && e.lastGoodWindowsAt === t + 34 * 60_000);
    usage.recordProviderStatus(W, withQuota, t + 36 * 60_000);
    usage.recordProviderStatus(W, { cliFound: false, loggedIn: null, mode: null, quota: null, error: null }, t + 37 * 60_000);
    e = entryOf(dirs.codex);
    check('E6 nor does "CLI not found"', e.available === false && e.windows.length === 0 && usage.isProviderCliMissing(e));
    // an older reading must not replace a newer one already on disk
    usage.recordProviderStatus(W, withQuota, t + 38 * 60_000);
    usage.recordProviderStatus(W, { cliFound: true, loggedIn: false, mode: null, quota: null, error: null }, t + 10 * 60_000);
    e = entryOf(dirs.codex);
    check('E7 a reading OLDER than the one on disk does not replace it', e.available === true && e.fetchedAt === t + 38 * 60_000);
    fs.rmSync(CACHE);
  }

  console.log('--- F. refreshProviderUsage with a fake helper');
  const onlyProviders = [FULL[0], FULL[1], FULL[2], FULL[3]]; // claude-a, codex-a, cursor-a, agy-a
  writeRegistry(onlyProviders);
  const reset = (modes) => {
    fs.rmSync(HLOG, { force: true });
    fs.rmSync(CACHE, { force: true });
    process.env.FAKE_HELPER_MODES = JSON.stringify(modes || {});
  };
  {
    reset({ codex: 'ok', cursor: 'garbage', gemini: 'refuse' });
    const t0 = Date.now();
    // SHELL-FIX (D1): for this one run the parent holds every Anthropic variable the helper must NOT
    // inherit, and a few another vendor's CLI needs and must keep. Removed again right after the run.
    const D1_PARENT = {
      ANTHROPIC_API_KEY: 'sk-ant-parent', ANTHROPIC_AUTH_TOKEN: 'parent-auth-token', CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth-token', CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
      OPENAI_API_KEY: 'sk-openai-parent', CURSOR_API_KEY: 'cursor-key-parent', HTTPS_PROXY: 'http://proxy.test:8080',
    };
    Object.assign(process.env, D1_PARENT);
    const parentPath = process.env.PATH;
    const r = await usage.refreshProviderUsage({ helperPath: HELPER, polling: true }).then(() => 'resolved', () => 'rejected');
    const parentHadAll = Object.keys(D1_PARENT).every((k) => process.env[k] === D1_PARENT[k]);
    for (const k of Object.keys(D1_PARENT)) delete process.env[k];
    const s = starts();
    check('F1 resolves (never rejects); one helper per non-Claude worker, none for the Claude worker', r === 'resolved' && s.length === 3 && JSON.stringify(s.map((e) => e.provider).sort()) === JSON.stringify(['codex', 'cursor', 'gemini']), JSON.stringify(s.map((e) => e.argv)));
    const codex = s.find((e) => e.provider === 'codex');
    check('F1 argv is exactly: status <provider> <configDir> --quota', JSON.stringify(codex.argv) === JSON.stringify(['status', 'codex', dirs.codex, '--quota']), JSON.stringify(codex.argv));
    check('F1 [UPDATED for D1] child env comes from vendorChildEnv(): no session-identity variable, no Anthropic credential and no CLAUDE_CONFIG_DIR although the parent holds them all; PATH, the vendors\' own keys, a proxy and an unrelated variable intact',
      parentHadAll && s.every((e) => e.identityLeaked.length === 0 && e.anthropicLeaked.length === 0 && e.keep === 'kept' && e.home === HOME
        && e.passed.PATH === parentPath && e.passed.OPENAI_API_KEY === 'sk-openai-parent' && e.passed.CURSOR_API_KEY === 'cursor-key-parent' && e.passed.HTTPS_PROXY === 'http://proxy.test:8080')
      && process.env.CLAUDE_CODE_MESSAGING_TOKEN === 'tok',
      JSON.stringify({ identityLeaked: codex.identityLeaked, anthropicLeaked: codex.anthropicLeaked, passed: Object.keys(codex.passed || {}).filter((k) => codex.passed[k] !== null), parentHadAll }) + ' parent token=' + process.env.CLAUDE_CODE_MESSAGING_TOKEN);
    check('F1 forked (IPC channel) with execArgv emptied and a neutral cwd', s.every((e) => e.hasIpc === true && e.execArgv.length === 0 && fs.realpathSync(e.cwd) === fs.realpathSync(os.tmpdir())) && process.execArgv.length > 0, 'parent execArgv=' + JSON.stringify(process.execArgv) + ' child=' + JSON.stringify(codex.execArgv));
    const e = entryOf(dirs.codex);
    check('F1 helper SUCCEEDS → a well-formed reading with its windows', WELL_FORMED(e).length === 0 && e.available === true && e.windows.length === 2 && e.windows[0].label === '5h limit' && e.windows[0].percent === 12 && e.windows[1].kind === 'weekly_all' && e.auth.loggedIn === true && e.name === 'codex-a' && e.fetchedAt >= t0, JSON.stringify(e));
    const g = entryOf(dirs.cursor);
    check('F1 helper prints GARBAGE → an error entry, never a throw', WELL_FORMED(g).length === 0 && typeof g.error === 'string' && g.error.includes('without a status') && g.available === false && g.name === 'cursor-a', JSON.stringify(g));
    const x = entryOf(dirs.agy);
    check('F1 helper refuses its arguments with {"error": …} (exit 2) → that text is the error', x.error === 'provider helper: unknown provider "nope"', JSON.stringify(x));
    check('F1 the Claude worker has no entry written by this', entryOf(dirs.claudeA) === undefined);
  }
  {
    // freshness: a second call right away forks only what is due
    const n0 = starts().length;
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F2 called again at once: every reading is still fresh (4 min; a failure 1 min) → no helper is run', starts().length === n0, `starts ${n0} → ${starts().length}`);
    // age the entries: success 5 min old, errors 61 s old
    const c = cache();
    c[dirs.codex].fetchedAt = Date.now() - 5 * 60_000;
    c[dirs.cursor].fetchedAt = Date.now() - 30_000;
    c[dirs.agy].fetchedAt = Date.now() - 61_000;
    fs.writeFileSync(CACHE, JSON.stringify(c));
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const again = starts().slice(n0).map((e) => e.provider).sort();
    check('F2 a 5-minute-old reading and a 61-second-old failure are re-read; a 30-second-old failure is not', JSON.stringify(again) === JSON.stringify(['codex', 'gemini']), JSON.stringify(again));
    const n1 = starts().length;
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true, force: true });
    check('F2 force: true re-reads every account regardless', starts().length === n1 + 3, `+${starts().length - n1}`);
    // a FUTURE timestamp is not fresh
    const c2 = cache();
    c2[dirs.codex].fetchedAt = Date.now() + 3600_000;
    fs.writeFileSync(CACHE, JSON.stringify(c2));
    const n2 = starts().length;
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F2 an entry dated in the future is stale, not fresh for ever', starts().slice(n2).some((e) => e.provider === 'codex'), JSON.stringify(starts().slice(n2).map((e) => e.provider)));
  }
  {
    reset({});
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: false });
    const s = starts();
    check('F3 polling: false → no --quota is passed to any helper', s.length === 3 && s.every((e) => !e.argv.includes('--quota') && e.argv.length === 3), JSON.stringify(s.map((e) => e.argv)));
    const e = entryOf(dirs.codex);
    check('F3 and the reading is "logged in, no usage reading"', e.available === false && e.windows.length === 0 && e.auth.loggedIn === true && !('error' in e));
    reset({});
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F3 polling: true → --quota on every helper', starts().length === 3 && starts().every((e) => e.argv[3] === '--quota' && e.argv.length === 4));
    reset({});
    await usage.refreshProviderUsage({ helperPath: HELPER });
    check('F3 polling absent → on (only an explicit false turns the quota off)', starts().every((e) => e.argv.includes('--quota')));
    // a quota-less status recorded over a fresh snapshot is re-read on the next polled refresh
    usage.recordProviderStatus({ name: 'codex-a', configDir: dirs.codex }, { cliFound: true, loggedIn: true, mode: null, quota: null, error: null });
    const stale = entryOf(dirs.codex);
    const n = starts().length;
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const after = entryOf(dirs.codex);
    check('F3 a carried (stale) snapshot is re-read at the next polled refresh although its entry is "fresh"', stale.windowsStale === true && starts().length === n + 1 && starts()[n].provider === 'codex' && after.windowsStale === false && after.windows.length === 2);
    const n3 = starts().length;
    usage.recordProviderStatus({ name: 'codex-a', configDir: dirs.codex }, { cliFound: true, loggedIn: true, mode: null, quota: null, error: null });
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: false });
    check('F3 but not when polling is off (there is no quota to fetch)', starts().length === n3);
  }
  {
    reset({});
    const missing = path.join(__dirname, 'no-such-helper.js');
    const r = await usage.refreshProviderUsage({ helperPath: missing, polling: true }).then(() => 'resolved', () => 'rejected');
    const es = [dirs.codex, dirs.cursor, dirs.agy].map(entryOf);
    check('F4 helper file MISSING → resolves, and each account gets an error entry saying so', r === 'resolved' && es.every((e) => e !== undefined && WELL_FORMED(e).length === 0 && /provider helper .*not found/.test(e.error)) && starts().length === 0, JSON.stringify(es[0]));
    const stamps = es.map((e) => e.fetchedAt);
    await usage.refreshProviderUsage({ helperPath: missing, polling: true });
    check('F4 a second call within a minute does not rewrite those failures', JSON.stringify([dirs.codex, dirs.cursor, dirs.agy].map((d) => entryOf(d).fetchedAt)) === JSON.stringify(stamps));
    reset({});
    const variants = [
      ['a relative path', { helperPath: 'fake-helper.js', polling: true }],
      ['a directory', { helperPath: __dirname, polling: true }],
      ['a number', { helperPath: 5, polling: true }],
      ['no options at all', undefined],
      ['null', null],
      ['a string', 'x'],
      ['options whose getters throw', { get helperPath() { throw new Error('g'); }, polling: true }],
    ];
    for (const [label, opts] of variants) {
      const res = await Promise.resolve().then(() => usage.refreshProviderUsage(opts)).then(() => 'resolved', (e) => 'rejected ' + e);
      check(`F4 helperPath / options = ${label}: resolves, runs nothing`, res === 'resolved' && starts().length === 0, res);
    }
    const e = entryOf(dirs.codex);
    check('F4 and the entry names the problem', e !== undefined && typeof e.error === 'string' && WELL_FORMED(e).length === 0, e && e.error);
  }
  {
    reset({ codex: 'crash', cursor: 'silent-exit', gemini: 'noisy' });
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const c = entryOf(dirs.codex);
    check('F5 helper CRASHES (exit 1 + stderr) → error entry carrying a one-line excerpt', WELL_FORMED(c).length === 0 && c.error.includes('exited with code 1') && c.error.includes('boom') && !c.error.includes('\n'), c.error);
    const s = entryOf(dirs.cursor);
    check('F5 helper exits 0 having printed nothing → error entry', s.error === 'the provider helper exited with code 0 without a status', s.error);
    const n = entryOf(dirs.agy);
    check('F5 300 KB of stderr and a banner before the JSON line → the status is still read', WELL_FORMED(n).length === 0 && n.available === true && n.windows.length === 2 && !('error' in n), JSON.stringify(n).slice(0, 200));
  }
  {
    reset({ codex: 'cli-missing', cursor: 'logged-out', gemini: 'unknown-login' });
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F6 helper says the CLI is missing → the "CLI not found" entry', usage.isProviderCliMissing(entryOf(dirs.codex)) && entryOf(dirs.codex).error.startsWith('CLI not found: codex not found'));
    check('F6 helper says logged out → isLoginExpired', usage.isLoginExpired(entryOf(dirs.cursor)) === true);
    check('F6 helper says login unknown → no auth, no error', !('auth' in entryOf(dirs.agy)) && !('error' in entryOf(dirs.agy)));
    reset({ codex: 'hostile', cursor: 'refuse-status', gemini: 'flood' });
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const h = entryOf(dirs.codex);
    check('F6 helper prints a hostile status → still a well-formed entry', WELL_FORMED(h).length === 0 && h.windows.length <= 8 && h.windows.every((w) => w.label.length <= 40), JSON.stringify(WELL_FORMED(h)) + ' windows=' + h.windows.length);
    const rs = entryOf(dirs.cursor);
    check('F6 the delivered helper\'s own bad-argument line (a status with `error`, exit 2) → an error entry with that text', rs.error.startsWith('missing configDir') && !('auth' in rs), rs.error);
    const fl = entryOf(dirs.agy);
    check('F6 200 KB of stdout BEFORE the status: the reader keeps the last 64 KiB, so the status is still read', WELL_FORMED(fl).length === 0 && fl.available === true && !('error' in fl), JSON.stringify(fl).slice(0, 200));
    reset({ codex: 'giant', cursor: 'ok', gemini: 'ok' });
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const gi = entryOf(dirs.codex);
    check('F6 one 200 KB line (no status can be found in what is kept) → error entry, no throw', WELL_FORMED(gi).length === 0 && typeof gi.error === 'string' && gi.error.includes('without a status'), gi.error);
  }
  {
    reset({ codex: 'pipe-holder', cursor: 'ok', gemini: 'ok' });
    const t0 = Date.now();
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    const ms = Date.now() - t0;
    check('F7 settles on EXIT, not close: a grandchild holding stdout open for 6 s does not hold the refresh', ms < 4000 && entryOf(dirs.codex).available === true, ms + ' ms');
  }
  {
    // concurrency: 5 accounts, each helper takes 700 ms → never more than 3 at once
    writeRegistry([FULL[1], FULL[2], FULL[3], FULL[8], { name: 'extra', configDir: dirs.extra, provider: 'codex' }]);
    reset({ codex: 'slow', cursor: 'slow', gemini: 'slow' });
    const t0 = Date.now();
    const both = [usage.refreshProviderUsage({ helperPath: HELPER, polling: true }), usage.refreshProviderUsage({ helperPath: HELPER, polling: true })];
    await Promise.all(both);
    const log = readLog(HLOG);
    const spans = log.filter((e) => e.ev === 'start').map((s) => ({ a: s.t, b: (log.find((e) => e.ev === 'exit' && e.pid === s.pid) || {}).t }));
    let max = 0;
    for (const s of spans) max = Math.max(max, spans.filter((o) => o.a <= s.a && o.b > s.a).length);
    check('F8 five accounts: at most 3 helpers run at once', spans.length === 5 && max <= 3 && max >= 2, `helpers=${spans.length} max overlap=${max} in ${Date.now() - t0} ms`);
    check('F8 two overlapping calls are serialized: the second finds every reading fresh and forks nothing', spans.length === 5);
    writeRegistry(onlyProviders);
  }
  {
    // no provider accounts at all → nothing happens, nothing is written
    writeRegistry([FULL[0]]);
    reset({});
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F9 a registry with only Claude workers: no helper, no cache write', starts().length === 0 && !fs.existsSync(CACHE));
    fs.writeFileSync(REGISTRY, '{ this is not json');
    const r = await usage.refreshProviderUsage({ helperPath: HELPER, polling: true }).then(() => 'resolved', () => 'rejected');
    check('F9 an unreadable registry: resolves, no helper', r === 'resolved' && starts().length === 0);
    // a non-absolute account directory is never passed as an argument
    writeRegistry([{ name: 'odd', configDir: '--quota', provider: 'codex' }, { name: 'rel', configDir: 'relative/dir', provider: 'cursor' }]);
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true });
    check('F9 an account directory that is not an absolute path (e.g. "--quota") is never handed to the helper', starts().length === 0 && entryOf('--quota').error === 'the account directory is not an absolute path', JSON.stringify(entryOf('--quota')));
    writeRegistry(onlyProviders);
  }

  console.log('--- G. the Claude probe never visits another vendor\'s directory');
  {
    writeRegistry(FULL);
    fs.rmSync(CACHE, { force: true });
    fs.rmSync(CLOG, { force: true });
    reset({});
    const results = await usage.refreshAllUsage();
    await sleep(400);
    const claudeStarts = readLog(CLOG).filter((e) => e.ev === 'start');
    const probed = claudeStarts.map((e) => e.env.CLAUDE_CONFIG_DIR);
    const foreign = [dirs.codex, dirs.cursor, dirs.agy, dirs.agy2];
    // [2.0: was "main + the two Claude workers" — 3 results, 3 starts, names within main / claude-a / typo]
    check('G1 refreshAllUsage() probes main + the ONE Claude worker with the (fake) claude, and nothing else', results.length === 2 && claudeStarts.length === 2 && JSON.stringify(results.map((r) => r.name).sort()) === JSON.stringify(['claude-a', 'main']), JSON.stringify(results.map((r) => r.name)) + ' config dirs=' + JSON.stringify(probed));
    check('G1 no claude child was given a Codex / Cursor / Antigravity directory', probed.every((d) => !foreign.includes(d)) && foreign.every((d) => entryOf(d) === undefined), JSON.stringify(probed));
    check('G1 nor the directory of the entry with an unknown provider: an unsupported entry is not probed and gets no cache entry', !probed.includes(dirs.typo) && entryOf(dirs.typo) === undefined, JSON.stringify(probed));
    const n = readLog(CLOG).filter((e) => e.ev === 'start').length;
    await usage.refreshProviderUsage({ helperPath: HELPER, polling: true, force: true });
    await sleep(200);
    check('G2 refreshProviderUsage() never starts the claude binary', readLog(CLOG).filter((e) => e.ev === 'start').length === n && starts().length === 4, `claude starts ${n} → ${readLog(CLOG).filter((e) => e.ev === 'start').length}, helpers=${starts().length}`);
    const c = cache();
    check('G2 afterwards the cache holds Claude and provider readings side by side, all well-formed', Object.keys(c).length === 6 && !(dirs.typo in c) && [dirs.codex, dirs.cursor, dirs.agy, dirs.agy2].every((d) => WELL_FORMED(c[d]).length === 0) && c[MAIN].available === true, JSON.stringify(Object.keys(c).map((k) => path.basename(k))));
    check('G3 isCacheFresh over listAccounts() ignores provider entries (Claude throttle unchanged)', usage.isCacheFresh(c, usage.listAccounts(), Date.now(), 240000) === true);
    writeRegistry(onlyProviders);
  }

  if (SLOW) {
    console.log('--- H. the 25 s cap (slow)');
    writeRegistry([FULL[1], FULL[2], FULL[3]]);
    reset({ codex: 'hang', cursor: 'answer-then-hang', gemini: 'hang-stubborn' });
    const t0 = Date.now();
    const r = await usage.refreshProviderUsage({ helperPath: HELPER, polling: true }).then(() => 'resolved', () => 'rejected');
    const ms = Date.now() - t0;
    check('H1 helpers that HANG: the refresh resolves at the 25 s cap (all three in parallel)', r === 'resolved' && ms >= 24_900 && ms < 28_000 && usage.PROVIDER_HELPER_TIMEOUT_MS === 25_000, ms + ' ms');
    const c = entryOf(dirs.codex);
    check('H1 hang with no output → an error entry that says timeout', WELL_FORMED(c).length === 0 && c.error.startsWith('timeout'), c.error);
    const a = entryOf(dirs.cursor);
    check('H1 answered, then failed to leave → what it printed is still the reading', a.available === true && a.windows.length === 2 && !('error' in a), JSON.stringify(a).slice(0, 160));
    const s = starts();
    await sleep(600);
    check('H2 the hung helper was ended by SIGTERM right after the cap', !alive(s.find((e) => e.provider === 'codex').pid) && !alive(s.find((e) => e.provider === 'cursor').pid));
    const stubborn = s.find((e) => e.provider === 'gemini').pid;
    check('H2 a helper that ignores SIGTERM is still alive just after it …', alive(stubborn) && readLog(HLOG).some((e) => e.ev === 'sigterm-ignored' && e.pid === stubborn));
    await sleep(2200);
    check('H2 … and is SIGKILLed 2 s later', !alive(stubborn));
    writeRegistry(onlyProviders);
  }

  console.log(`\nusage2: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNEXPECTED THROW', e);
  process.exit(3);
});
