'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* SHELL-FIX proof (D2, data layer): uiModel.ts account assembly, usage.ts ownership helpers and
 * team.ts session-registry scans, with accounts of other vendors registered on directories a
 * Claude Code account also has — a registry only a hand edit produces.
 *
 *   env -i HOME=<scratch home> PATH=$PATH TMPDIR=$TMPDIR node test-d2-data.js <both bundle> <usage bundle>
 *
 * No CLI is started: everything here is file reads under the scratch HOME.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const HOME = os.homedir(); // the scratch home run.sh made — ../lib/staged.js refused to start otherwise
if (process.env.CLAUDE_CONFIG_DIR) {
  console.error('refusing to run: CLAUDE_CONFIG_DIR is set');
  process.exit(2);
}
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + String(detail).slice(0, 500) + ']' : ''}`);
};

const ROOT = path.join(HOME, '.claude-code-orchestrator');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'mesh'), { recursive: true });
const WS = path.join(HOME, 'ws', 'proj');
fs.mkdirSync(WS, { recursive: true });
const NOW = Date.now();
const D = (n) => path.join(HOME, n);
const HOST = D('.claude');
const SHARED = D('.shared');
const CX_OWN = D('.codex-own');
const AG_OWN = D('.agy-own');
const GONE = D('.claude-gone');

const workers = [
  { name: 'cx-first', configDir: SHARED, provider: 'codex', model: 'gpt-5.5' }, // a Codex worker listed BEFORE the Claude worker of the same directory
  { name: 'cl-second', configDir: SHARED + '/', model: 'sonnet' }, // the Claude worker (another spelling of the same directory)
  { name: 'cx-host', configDir: HOST, provider: 'codex' }, // a Codex worker on MAIN's directory
  { name: 'cx-own', configDir: CX_OWN, provider: 'codex', model: 'gpt-5.5' },
  { name: 'cur-dup', configDir: CX_OWN, provider: 'cursor' }, // a second vendor on that home: the first owns it
  { name: 'ag-own', configDir: AG_OWN, provider: 'gemini' },
];
// Deliberately the layout a 2.0 development build (or a hand edit) wrote: every entry under `workers`.
// 2.0 itself writes vendor accounts under `vendorWorkers`, always after the Claude Code ones, so "a Codex
// worker listed BEFORE the Claude worker of the same directory" — the first case below — exists only in a
// file like this one. The reader still accepts it, and this suite is about exactly such files.
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers, permissionMode: 'acceptEdits', claudePath: 'claude' }));
fs.writeFileSync(path.join(ROOT, 'tasks.jsonl'), '');

const both = require(path.resolve(process.argv[2]));
const usage = require(path.resolve(process.argv[3]));
const { ui, team } = both;
if (!usage.USAGE_CACHE_FILE.startsWith(HOME)) {
  console.error('refusing to run: cache file outside the scratch home');
  process.exit(2);
}

// ---- usage cache: Claude readings written as the Claude probe files them, provider readings through the product's own writer
const claudeEntry = (name, dir, plan, percent) => ({ name, configDir: dir, available: true, subscriptionType: plan, windows: [{ kind: 'session', label: 'Session (5hr)', percent, severity: 'normal', resetsAt: null }], sessionCostUsd: null, extraUsage: null, fetchedAt: NOW - 1000 });
fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({ [HOST]: claudeEntry('main', HOST, 'max', 12), [SHARED + '/']: claudeEntry('cl-second', SHARED + '/', 'pro', 55) }));
const status = (percent) => ({ cliFound: true, loggedIn: true, mode: 'chatgpt', quota: { allowed: true, windows: [{ label: '5h limit', usedPercent: percent, resetAt: null }] }, error: null });
usage.recordProviderStatus({ name: 'cx-own', configDir: CX_OWN }, status(34), NOW - 900);
usage.recordProviderStatus({ name: 'cx-host', configDir: HOST }, status(99), NOW - 900); // must be refused
usage.recordProviderStatus({ name: 'cx-first', configDir: SHARED }, status(98), NOW - 900); // must be refused
const cache = () => JSON.parse(fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8'));

console.log('--- usage.ts: who is a Claude Code account, and whose reading a directory holds');
{
  check('G1 listAccounts() — the list every `claude` probe, the keep-alive and the prune are fed from — is main and the Claude worker only', JSON.stringify(usage.listAccounts().map((a) => a.name)) === '["main","cl-second"]', JSON.stringify(usage.listAccounts().map((a) => a.name)));
  check('G2 listProviderAccounts() — the accounts the provider helper is run for — is the vendor workers that own a directory no Claude account has: cx-own and ag-own; not the two registered on Claude directories, not the second vendor on a taken home',
    JSON.stringify(usage.listProviderAccounts().map((a) => `${a.name}:${a.provider}`)) === '["cx-own:codex","ag-own:gemini"]', JSON.stringify(usage.listProviderAccounts().map((a) => `${a.name}:${a.provider}`)));
  const c = cache();
  check('G3 a vendor reading is never filed under a Claude account\'s directory (unchanged rule): main\'s and the Claude worker\'s entries are still their own', c[HOST].name === 'main' && c[HOST].subscriptionType === 'max' && c[SHARED + '/'].name === 'cl-second' && !(SHARED in c) && c[CX_OWN].name === 'cx-own',
    Object.keys(c).map((k) => `${path.basename(k)}=${c[k].name}`).join(','));
  if (typeof usage.getCachedWorkerUsage === 'function') {
    const own = (w) => usage.getCachedWorkerUsage(w);
    check('G4 getCachedWorkerUsage: a Codex worker on main\'s directory has NO reading (main\'s is not shown as its own); likewise the Codex worker on the Claude worker\'s directory and the second vendor on a taken home',
      own({ name: 'cx-host', configDir: HOST, provider: 'codex' }) === undefined && own({ name: 'cx-first', configDir: SHARED, provider: 'codex' }) === undefined && own({ name: 'cur-dup', configDir: CX_OWN, provider: 'cursor' }) === undefined);
    check('G5 getCachedWorkerUsage: the owner gets its reading — the Codex worker with its own home, the Claude worker, and main addressed as a Claude account',
      own({ name: 'cx-own', configDir: CX_OWN, provider: 'codex' }).windows[0].percent === 34 && own({ name: 'cl-second', configDir: SHARED + '/' }).subscriptionType === 'pro' && own({ name: 'main', configDir: HOST, provider: 'claude' }).subscriptionType === 'max');
    // [2.0: the last clause was "an unknown provider id reads as Claude Code (the registry's rule)" — === true.]
    // An entry with a provider this version does not know is not a worker at all: it owns no reading, of any
    // vendor, and is shown none — here on the Claude worker's own directory, whose reading must not become its.
    check('G6 ownership follows name AND provider, not the directory alone: another name, or another provider, on the owner\'s home owns nothing; an unknown provider id owns nothing either',
      usage.ownsUsageReading({ name: 'cx-own', configDir: CX_OWN, provider: 'codex' }) === true && usage.ownsUsageReading({ name: 'someone-else', configDir: CX_OWN, provider: 'codex' }) === false
      && usage.ownsUsageReading({ name: 'cx-own', configDir: CX_OWN, provider: 'gemini' }) === false && usage.ownsUsageReading({ name: 'cx-own', configDir: CX_OWN + '/', provider: 'codex' }) === true
      && usage.ownsUsageReading({ name: 'typo', configDir: SHARED, provider: 'codexx' }) === false && usage.getCachedWorkerUsage({ name: 'typo', configDir: SHARED, provider: 'codexx' }) === undefined
      && usage.ownsUsageReading({ name: 'typo', configDir: CX_OWN, provider: 5 }) === false);
  } else {
    check('G4-G6 the ownership helpers exist (getCachedWorkerUsage, ownsUsageReading)', false, 'not exported by this bundle');
  }
}

console.log('--- uiModel.ts: account assembly');
const SETTINGS = {
  workerPermissionMode: 'acceptEdits', permissionModes: ['acceptEdits', 'auto'], claudePath: 'claude', quotaCooldownMinutes: 30, workerTimeoutMinutes: 45,
  frontierWorkerDispatch: { value: 'block', effective: 'block', setBy: null }, overageWorkerDispatch: { value: 'block', effective: 'block', setBy: null },
  meshMode: true, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, sessionKeepalive: false, workerModels: ['opus', 'sonnet', 'fable'],
};
const HEALTH = { claudeVersion: '2.1.283 (Claude Code)', sessionWorkersSupported: true, sessionWorkersMinVersion: '2.1.283', taskLogProblem: null, mcpInstalled: true, policyInstalled: true, teamAgentInstalled: true };
{
  const m = ui.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: SETTINGS, health: HEALTH, sessions: [], now: NOW });
  const acct = (n) => m.accounts.find((a) => a.name === n);
  check('U1 the account list: main, the Claude worker, and the two vendor workers that own their home — a vendor worker registered on a Claude account\'s directory is not listed, whether it comes after it (main) or BEFORE it (the shared directory)',
    JSON.stringify(m.accounts.map((a) => `${a.name}:${a.provider}`)) === '["main:claude","cl-second:claude","cx-own:codex","ag-own:gemini"]', JSON.stringify(m.accounts.map((a) => `${a.name}:${a.provider}`)));
  const main = m.accounts[0];
  check('U2 main is Claude Code with its own plan and usage, and is NOT merged with the Codex worker registered on its directory', main.isMain && !main.isWorker && main.provider === 'claude' && main.plan === 'max' && main.windows[0].percent === 12 && main.defaultModel === null,
    JSON.stringify({ isWorker: main.isWorker, plan: main.plan, model: main.defaultModel }));
  const cl = acct('cl-second');
  check('U3 the shared directory\'s row is the CLAUDE worker, with the Claude reading filed there — no row presents that plan usage as a Codex account\'s', cl !== undefined && cl.provider === 'claude' && cl.plan === 'pro' && cl.windows[0].percent === 55 && cl.defaultModel === 'sonnet'
    && !m.accounts.some((a) => a.provider !== 'claude' && (a.plan === 'pro' || a.plan === 'max')), m.accounts.map((a) => `${a.name}:${a.provider}:${a.plan}`).join(','));
  check('U4 a vendor worker that owns its home shows its own reading', acct('cx-own').plan === 'chatgpt' && acct('cx-own').windows[0].percent === 34 && acct('cx-own').login === 'ok');
  check('U5 account keys are unique', new Set(m.accounts.map((a) => a.key)).size === m.accounts.length);
  const rShared = ui.resolveAccount(ui.accountKeyFor(SHARED));
  const rHost = ui.resolveAccount(ui.accountKeyFor(HOST));
  check('U6 resolveAccount — what a dashboard action acts on: the shared directory\'s key is the Claude worker (registry string verbatim), main\'s key is main; neither resolves to a Codex account',
    rShared && rShared.name === 'cl-second' && rShared.provider === 'claude' && rShared.configDir === SHARED + '/' && rHost && rHost.name === 'main' && rHost.provider === 'claude' && rHost.isMain && !rHost.isWorker, JSON.stringify([rShared, rHost]));
  check('U7 knownAccounts() (what the Team scan is fed from) agrees', JSON.stringify(ui.knownAccounts().map((a) => `${a.name}:${a.provider}`)) === '["main:claude","cl-second:claude","cx-own:codex","ag-own:gemini"]');
}

console.log('--- team.ts: which directories are read as a Claude Code session registry');
(async () => {
  const sleepers = [0, 1, 2, 3].map(() => cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
  const LIVE = sleepers.map((s) => s.pid);
  const hashOf = (cwd) => crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 6);
  const sess = (pid, o) => ({ pid, sessionId: crypto.randomUUID(), cwd: WS, version: '2.1.283', peerProtocol: 1, kind: 'bg', messagingSocketPath: '/tmp/sock-' + pid, status: 'busy', updatedAt: NOW - 1000, ...o });
  const put = (dir, pid, o) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', pid + '.json'), JSON.stringify(sess(pid, o)));
  };
  const rec = (o) => ({ name: 'cco-w-x', account: 'x', model: 'opus', role: 'dispatch', spawnedAt: NOW - 600000, ownerPid: 1, lastActivityAt: NOW - 600000, ...o });
  // entries that WOULD match, under each directory
  put(CX_OWN, LIVE[0], { jobId: 'aaaa1111', name: 'under-a-codex-home' });
  put(CX_OWN, LIVE[1], { jobId: 'dddd4444', name: 'under-a-codex-home-by-pid' });
  put(GONE, LIVE[2], { jobId: 'bbbb2222', name: 'under-a-removed-account' });
  put(SHARED, LIVE[3], { jobId: 'cccc3333', name: 'under-the-claude-worker' });
  fs.writeFileSync(path.join(ROOT, 'mesh', hashOf(WS) + '.json'), JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: NOW - 700000, workers: [
    rec({ jobId: 'aaaa1111', name: 'w-codex-home', account: 'cx-own', configDir: CX_OWN }),
    rec({ jobId: 'dddd4444', name: 'w-codex-home-pid', account: 'cx-own', configDir: CX_OWN + '/', pid: LIVE[1] }),
    rec({ jobId: 'bbbb2222', name: 'w-removed-account', account: 'gone', configDir: GONE }),
    rec({ jobId: 'cccc3333', name: 'w-shared', account: 'cl-second', configDir: SHARED }),
  ] }));
  // every fs call that names a path under the Codex home, or under the directory no account has, is recorded
  const touched = [];
  const restore = [];
  for (const name of Object.keys(fs)) {
    if (typeof fs[name] !== 'function' || !/^(open|opendir|readdir|readFile|read|stat|lstat|fstat|exists|access|realpath)(Sync)?$/.test(name)) continue;
    const orig = fs[name];
    fs[name] = function (p, ...rest) {
      if (typeof p === 'string' && (path.resolve(p).startsWith(CX_OWN + path.sep) || path.resolve(p).startsWith(GONE + path.sep))) touched.push(`${name}(${path.relative(HOME, p)})`);
      return orig.call(this, p, ...rest);
    };
    restore.push(() => { fs[name] = orig; });
  }
  team.invalidateTeamCache();
  const rows = team.collectSessions({ workspaceRoot: WS, scope: 'workspace', now: NOW, maxAgeMs: 0 });
  for (const r of restore) r();
  const row = (job) => rows.find((r) => r.key === `worker:${job}`);
  const a = row('aaaa1111');
  const d = row('dddd4444');
  check('M1 a ledger record that names another vendor\'s HOME is not looked into: its row is "unknown" — not "busy", though a matching live entry sits under that home — has no account, and cannot be attached to or stopped',
    a !== undefined && a.status === 'unknown' && a.accountKey === null && a.canAttach === false && a.canStop === false, a && JSON.stringify({ status: a.status, accountKey: a.accountKey, canAttach: a.canAttach }));
  check('M2 same class, other input: the home spelled with a trailing separator, and a record carrying a pid (the direct-read path) — still "unknown", still no account', d !== undefined && d.status === 'unknown' && d.accountKey === null && d.canAttach === false && d.canStop === false,
    d && JSON.stringify({ status: d.status, accountKey: d.accountKey }));
  const b = row('bbbb2222');
  check('M3 the same for a directory NO account has (a removed worker, an edited ledger): the pool\'s rule — a ledger directory that is not a current Claude Code account\'s is not looked into — so its row is "unknown" too, with no account, not attachable, not stoppable',
    b !== undefined && b.status === 'unknown' && b.accountKey === null && b.canAttach === false && b.canStop === false, b && JSON.stringify({ status: b.status, canAttach: b.canAttach }));
  check('M4 and nothing under either directory was opened, listed or stat\'ed by the collection — a vendor home\'s `sessions/` is that vendor\'s own store', touched.length === 0, touched.slice(0, 6).join(' ; ') || 'no file-system call under the Codex home or the unregistered directory');
  const c = row('cccc3333');
  const resolved = team.resolveSession('worker:cccc3333');
  check('M5 the directory a Claude worker and a Codex worker share is the CLAUDE worker\'s: its session worker is read, attributed to that account, attachable — and resolves to the registry\'s own string for that Claude worker',
    c !== undefined && c.status === 'busy' && c.accountName === 'cl-second' && c.accountKey === ui.accountKeyFor(SHARED) && c.canAttach === true && c.canStop === true && resolved !== undefined && resolved.configDir === SHARED + '/',
    c && JSON.stringify({ status: c.status, accountName: c.accountName, canAttach: c.canAttach, dir: resolved && path.basename(resolved.configDir) }));
  check('M6 no row of any source names a vendor account, and no entry found under a vendor home is listed as a peer', rows.every((r) => !['cx-own', 'cx-first', 'cx-host', 'cur-dup', 'ag-own'].includes(r.accountName) || r.accountKey === null) && !rows.some((r) => /under-a-codex-home/.test(r.name)),
    rows.map((r) => `${r.source}:${r.name}:${r.accountName}`).join(' | '));
  check('M7 every resolvable row\'s config dir is a Claude Code account\'s (what attach / logs / stop would be run under), never a vendor home',
    rows.every((r) => { const s = team.resolveSession(r.key); return s === undefined || s.configDir === undefined || [HOST, SHARED + '/'].includes(s.configDir); }),
    rows.map((r) => { const s = team.resolveSession(r.key); return `${r.key}→${s && s.configDir ? path.basename(s.configDir) : '-'}`; }).join(' '));
  for (const s of sleepers) s.kill('SIGKILL');
  console.log(`\nd2-data: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  probe crashed: ' + (e && e.stack));
  process.exit(1);
});
