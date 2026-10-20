'use strict';
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
/* uiModel.ts + team.ts with accounts on every provider; F2 (dispatch mode).
 *   env -i HOME=<scratch home> PATH=$PATH TMPDIR=$TMPDIR node test-ui2.js <both bundle> <usage bundle>
 * Provider readings are written through the usage bundle's own recordProviderStatus, so the
 * model is tested against what that function really stores.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
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
const WS = path.join(HOME, 'ws', 'proj');
fs.mkdirSync(WS, { recursive: true });
const NOW = Date.now();
const D = (n) => path.join(HOME, n);
const HOST = D('.claude');

const workers = [
  { name: 'claude-w', configDir: D('.claude-w'), model: 'sonnet' },
  { name: 'codex-w', configDir: D('.codex'), provider: 'codex', model: 'gpt-5.6-sol', permissionMode: 'read-only' },
  { name: 'cursor-w', configDir: D('.cursor'), provider: 'cursor' },
  { name: 'agy-w', configDir: D('.agy'), provider: 'gemini', model: 'bad model!!', permissionMode: 'bogus' },
  { name: 'codex-2', configDir: D('.codex-2'), provider: 'codex', permissionMode: 'danger-full-access', preferred: true },
  { name: 'agy-plan', configDir: D('.agy-2'), provider: 'antigravity', permissionMode: 'plan', model: 'gemini-3.8-flash-high' },
  { name: 'codex-at-host', configDir: HOST, provider: 'codex', model: 'gpt-5.5' },
  { name: 'cursor-at-codex', configDir: D('.codex') + '/', provider: 'cursor', permissionMode: 'enabled' },
  { name: 'typo-w', configDir: D('.claude-typo'), provider: 'codexx', permissionMode: 'read-only' },
  { name: 'codex-missing', configDir: D('.codex-missing'), provider: 'codex' },
  { name: 'codex-bare', configDir: D('.codex-bare'), provider: 'codex' },
  { name: 'codex-out', configDir: D('.codex-out'), provider: 'codex' },
  { name: 'codex-noread', configDir: D('.codex-noread'), provider: 'codex' },
  { name: 'codex-unknown', configDir: D('.codex-unknown'), provider: 'codex' },
  { name: 'codex-err', configDir: D('.codex-err'), provider: 'codex' },
  { name: 'codex-hand', configDir: D('.codex-hand'), provider: 'codex' },
  { name: 'cursor-sbx', configDir: D('.cursor-2'), provider: 'cursor', permissionMode: 'enabled', model: 'composer-2.5[fast=true]' },
];
// The registry file as 2.0 writes it: Claude Code accounts under `workers`, every entry that carries a
// `provider` under `vendorWorkers` (until the fix wave this fixture put all of them in `workers`).
fs.writeFileSync(path.join(ROOT, 'registry.json'), JSON.stringify({ workers: workers.filter((w) => !('provider' in w)), vendorWorkers: workers.filter((w) => 'provider' in w), permissionMode: 'auto', claudePath: 'claude' }));
fs.writeFileSync(
  path.join(ROOT, 'stats.json'),
  JSON.stringify({ 'codex-w': { tasks: 4, errors: 1, inputTokens: 100, outputTokens: 200, costUsd: 0, cooldownUntil: NOW + 60000, lastError: 'quota exceeded for the week' } }),
);

// ---- tasks
let seq = 0;
const tid = () => 't' + (2000000 + ++seq).toString(36).padStart(8, '0');
const lines = [];
const ev = (id, extra) => lines.push(JSON.stringify({ id, title: 'task ' + id, worker: 'claude-w', model: 'opus', outputFile: path.join(ROOT, 'tasks', id + '.md'), cwd: WS, ...extra }));
const T = {};
T.oneshotPgid = tid();
ev(T.oneshotPgid, { ts: NOW - 20000, status: 'running' });
ev(T.oneshotPgid, { ts: NOW - 19000, status: 'running', pid: 4242, pgid: 4242 });
T.oneshotDonePgid = tid();
ev(T.oneshotDonePgid, { ts: NOW - 50000, status: 'running', pid: 4243, pgid: 4243 });
ev(T.oneshotDonePgid, { ts: NOW - 40000, status: 'done', pid: 4243, pgid: 4243, inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
T.detach = tid();
ev(T.detach, { ts: NOW - 50000, status: 'running', supervisorPid: 4001 });
ev(T.detach, { ts: NOW - 49000, status: 'running', supervisorPid: 4001, pid: 4002, pgid: 4002 });
ev(T.detach, { ts: NOW - 30000, status: 'done', supervisorPid: 4001, inputTokens: 5, outputTokens: 6, costUsd: 0.01 });
T.detachRunning = tid();
ev(T.detachRunning, { ts: NOW - 9000, status: 'running', supervisorPid: 4003 });
ev(T.detachRunning, { ts: NOW - 8000, status: 'running', supervisorPid: 4003, pid: 4004, pgid: 4004 });
T.detachTerminalWithout = tid();
ev(T.detachTerminalWithout, { ts: NOW - 50000, status: 'running', supervisorPid: 4005 });
ev(T.detachTerminalWithout, { ts: NOW - 29000, status: 'error', error: 'orphaned — the supervisor is no longer running' });
T.supString = tid();
ev(T.supString, { ts: NOW - 50000, status: 'running', supervisorPid: '777', pgid: 5 });
T.supNull = tid();
ev(T.supNull, { ts: NOW - 50000, status: 'running', supervisorPid: null, pgid: 6 });
T.supBool = tid();
ev(T.supBool, { ts: NOW - 50000, status: 'running', supervisorPid: true });
T.session = tid();
ev(T.session, { ts: NOW - 50000, status: 'running', meshWorker: 'cco-w-1' });
ev(T.session, { ts: NOW - 28000, status: 'done', meshWorker: 'cco-w-1', inputTokens: 0, outputTokens: 0, costUsd: 0 });
T.sessionWithSup = tid();
ev(T.sessionWithSup, { ts: NOW - 50000, status: 'running', meshWorker: 'cco-w-2', supervisorPid: 4010 });
T.codexDone = tid();
ev(T.codexDone, { ts: NOW - 60000, status: 'running', worker: 'codex-w', model: 'gpt-5.6-sol', provider: 'codex' });
ev(T.codexDone, { ts: NOW - 59000, status: 'running', worker: 'codex-w', model: 'gpt-5.6-sol', provider: 'codex', pid: 4020, pgid: 4020 });
ev(T.codexDone, { ts: NOW - 27000, status: 'done', worker: 'codex-w', model: 'gpt-5.6-sol', provider: 'codex', inputTokens: 10, outputTokens: 20, costUsd: 0 });
T.codexRunning = tid();
ev(T.codexRunning, { ts: NOW - 7000, status: 'running', worker: 'codex-w', model: '-', provider: 'codex', pid: 4021, pgid: 4021 });
T.providerFirstOnly = tid();
ev(T.providerFirstOnly, { ts: NOW - 60000, status: 'running', worker: 'cursor-w', provider: 'cursor' });
ev(T.providerFirstOnly, { ts: NOW - 26000, status: 'error', worker: 'cursor-w', error: 'orphaned — worker process is no longer running' });
T.provClaude = tid();
ev(T.provClaude, { ts: NOW - 60000, status: 'done', provider: 'claude' });
T.provUnknown = tid();
ev(T.provUnknown, { ts: NOW - 60000, status: 'done', provider: 'foo' });
T.provNumber = tid();
ev(T.provNumber, { ts: NOW - 60000, status: 'done', provider: 5 });
T.provAlias = tid();
ev(T.provAlias, { ts: NOW - 60000, status: 'done', worker: 'agy-w', provider: 'Antigravity' });
T.provMarkup = tid();
ev(T.provMarkup, { ts: NOW - 60000, status: 'done', provider: '<img src=x onerror=alert(1)>' });
T.provDetached = tid();
ev(T.provDetached, { ts: NOW - 60000, status: 'running', worker: 'codex-2', provider: 'codex', supervisorPid: 4030 });
ev(T.provDetached, { ts: NOW - 25000, status: 'done', worker: 'codex-2', provider: 'codex', inputTokens: 3, outputTokens: 4, costUsd: 0 });
T.provLatestWins = tid();
ev(T.provLatestWins, { ts: NOW - 60000, status: 'running', provider: 'codex' });
ev(T.provLatestWins, { ts: NOW - 24000, status: 'done', provider: 'zzz' });
T.plain = tid();
ev(T.plain, { ts: NOW - 60000, status: 'running' });
ev(T.plain, { ts: NOW - 23000, status: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 });
fs.writeFileSync(path.join(ROOT, 'tasks.jsonl'), lines.join('\n') + '\n');

const both = require(path.resolve(process.argv[2]));
const usage = require(path.resolve(process.argv[3]));
const { ui, team } = both;
if (!usage.USAGE_CACHE_FILE.startsWith(HOME)) {
  console.error('refusing to run: cache file outside the scratch home');
  process.exit(2);
}

// ---- usage readings, written the way the product writes them
const rec = (name, status, now) => usage.recordProviderStatus({ name, configDir: workers.find((w) => w.name === name).configDir }, status, now);
const quota3 = { allowed: true, windows: [{ label: '5h limit', usedPercent: 12, resetAt: new Date(NOW + 3600000).toISOString() }, { label: 'Weekly limit', usedPercent: 80, resetAt: null }, { label: 'Code review', usedPercent: 95, resetAt: null }] };
rec('codex-w', { cliFound: true, loggedIn: true, mode: 'chatgpt', quota: quota3, error: null }, NOW - 1000);
rec('cursor-w', { cliFound: true, loggedIn: true, mode: 'cursor', quota: null, error: null }, NOW - 1000);
rec('agy-w', { cliFound: true, loggedIn: null, mode: null, quota: null, error: null }, NOW - 1000);
rec('codex-2', { cliFound: true, loggedIn: true, mode: 'chatgpt', quota: quota3, error: null }, NOW - 120000);
rec('codex-2', { cliFound: true, loggedIn: true, mode: 'chatgpt', quota: null, error: null }, NOW - 1000);
rec('codex-missing', { cliFound: false, loggedIn: null, mode: null, quota: null, error: 'codex not found — the Codex CLI is not installed or not on PATH' }, NOW - 1000);
rec('codex-bare', { cliFound: false, loggedIn: null, mode: null, quota: null, error: null }, NOW - 1000);
rec('codex-out', { cliFound: true, loggedIn: false, mode: null, quota: null, error: null }, NOW - 1000);
rec('codex-unknown', { cliFound: true, loggedIn: null, mode: null, quota: null, error: null }, NOW - 1000);
rec('codex-err', { cliFound: true, loggedIn: null, mode: null, quota: null, error: 'the login check did not answer in time' }, NOW - 1000);
rec('cursor-sbx', { cliFound: true, loggedIn: true, mode: null, quota: null, error: 'the usage reading failed: ‮<b>503</b>\n' + 'x'.repeat(900) }, NOW - 1000);
{
  // entries nobody's code wrote: a Claude reading, and hand-edited junk for a provider account
  const c = JSON.parse(fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8'));
  c[D('.claude-w')] = { name: 'claude-w', configDir: D('.claude-w'), available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: NOW - 1000 };
  c[D('.codex-hand')] = { available: 'yes', error: 5, auth: 'x', windows: [{ kind: 'session', label: '<script>', percent: 'NaN', severity: 'critical' }], subscriptionType: { a: 1 }, fetchedAt: 'never' };
  c[HOST] = { name: 'main', configDir: HOST, available: true, subscriptionType: 'max', windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: NOW - 1000 };
  fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify(c));
}

const SETTINGS = {
  workerPermissionMode: 'acceptEdits', permissionModes: ['acceptEdits', 'auto'], claudePath: 'claude', quotaCooldownMinutes: 30, workerTimeoutMinutes: 45,
  frontierWorkerDispatch: { value: 'block', effective: 'block', setBy: null }, overageWorkerDispatch: { value: 'block', effective: 'block', setBy: null },
  // Since wave 7 the aliases offered as a worker's default are every tier: opus, sonnet, haiku, fable (platform.WORKER_MODELS).
  meshMode: true, meshMaxLiveWorkers: 8, meshHistoryLimit: 50, sessionKeepalive: false, workerModels: ['opus', 'sonnet', 'haiku', 'fable'],
};
const HEALTH = { claudeVersion: '2.1.283 (Claude Code)', sessionWorkersSupported: true, sessionWorkersMinVersion: '2.1.283', taskLogProblem: null, mcpInstalled: true, policyInstalled: true, teamAgentInstalled: true };
const build = (settings) => ui.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', settings: settings ?? SETTINGS, health: HEALTH, sessions: [], now: NOW });

const m = build();
const acct = (name) => m.accounts.find((a) => a.name === name);
const task = (id) => m.tasks.find((t) => t.id === id);

console.log('--- accounts: provider fields');
{
  const names = m.accounts.map((a) => a.name);
  // [2.0: was 16 rows — the entry with an unknown provider ("typo-w") was a Claude Code row]
  check('account list: main first, then one row per directory (a worker on another directory\'s key is not listed twice; an entry with an unknown provider is not an account)', names[0] === 'main' && !names.includes('codex-at-host') && !names.includes('cursor-at-codex') && !names.includes('typo-w') && names.length === 15, JSON.stringify(names));
  const main = m.accounts[0];
  check('main: Claude Code, session workers, NOT merged with the Codex worker that names its directory', main.isMain && !main.isWorker && main.provider === 'claude' && main.providerLabel === 'Claude Code' && main.sessionWorkers === true && main.permissionMode === null && main.defaultModel === null && main.login === 'ok', JSON.stringify({ p: main.provider, w: main.isWorker, pm: main.permissionMode, dm: main.defaultModel }));
  const cw = acct('claude-w');
  check('Claude worker: provider claude; permissionMode is the registry-wide mode ("auto")', cw.provider === 'claude' && cw.providerLabel === 'Claude Code' && cw.sessionWorkers === true && cw.permissionMode === 'auto' && cw.defaultModel === 'sonnet' && cw.login === 'no-plan-limits', JSON.stringify({ pm: cw.permissionMode, dm: cw.defaultModel, login: cw.login }));
  // [2.0: was "unknown provider id reads as Claude Code — and ignores the per-worker mode": a row with
  // provider claude, mode auto, session workers, model opus, login refreshing]
  check('an entry with an unknown provider id is NOT an account row; the model lists it under unsupportedAccounts with the reason, and nothing else is there',
    acct('typo-w') === undefined && JSON.stringify(m.unsupportedAccounts) === JSON.stringify([{ name: 'typo-w', detail: 'unknown provider "codexx"' }]), JSON.stringify(m.unsupportedAccounts));
  const cx = acct('codex-w');
  check('Codex worker: provider / label / no session workers / stored mode / stored model', cx.provider === 'codex' && cx.providerLabel === 'Codex' && cx.sessionWorkers === false && cx.permissionMode === 'read-only' && cx.defaultModel === 'gpt-5.6-sol' && cx.isWorker && !cx.isMain, JSON.stringify({ p: cx.provider, l: cx.providerLabel, sw: cx.sessionWorkers, pm: cx.permissionMode, dm: cx.defaultModel }));
  const cu = acct('cursor-w');
  check('Cursor worker: no stored mode → null (the CLI default); no stored model → null', cu.provider === 'cursor' && cu.providerLabel === 'Cursor' && cu.sessionWorkers === false && cu.permissionMode === null && cu.defaultModel === null, JSON.stringify({ pm: cu.permissionMode, dm: cu.defaultModel }));
  const cs = acct('cursor-sbx');
  check('Cursor worker with a stored mode and a parameterized model id', cs.permissionMode === 'enabled' && cs.defaultModel === 'composer-2.5[fast=true]', JSON.stringify({ pm: cs.permissionMode, dm: cs.defaultModel }));
  const ag = acct('agy-w');
  check('Antigravity worker: a mode it does not accept → its default; a value that is not a model id → no default', ag.provider === 'gemini' && ag.providerLabel === 'Antigravity' && ag.sessionWorkers === false && ag.permissionMode === 'accept-edits' && ag.defaultModel === null, JSON.stringify({ pm: ag.permissionMode, dm: ag.defaultModel }));
  const ap = acct('agy-plan');
  check('provider alias "antigravity" → gemini; stored mode "plan"', ap.provider === 'gemini' && ap.permissionMode === 'plan' && ap.defaultModel === 'gemini-3.8-flash-high');
  const c2 = acct('codex-2');
  check('second Codex worker: danger-full-access shown as stored; preferred', c2.permissionMode === 'danger-full-access' && c2.preferred === true && c2.defaultModel === null);
  check('every account carries the four new fields with the documented types', m.accounts.every((a) => ['claude', 'codex', 'cursor', 'gemini'].includes(a.provider) && typeof a.providerLabel === 'string' && a.providerLabel.length > 0 && a.providerLabel.length <= 32 && typeof a.sessionWorkers === 'boolean' && (a.permissionMode === null || (typeof a.permissionMode === 'string' && a.permissionMode.length <= 32))));
  check('sessionWorkers is true exactly for Claude Code accounts', m.accounts.every((a) => a.sessionWorkers === (a.provider === 'claude')));
}

console.log('--- accounts: login state from a provider reading');
{
  const cx = acct('codex-w');
  check('logged in with quota → ok; windows with positional kinds, vendor labels, severities; plan = mode', cx.login === 'ok' && cx.loginDetail === null && cx.plan === 'chatgpt' && JSON.stringify(cx.windows.map((w) => [w.kind, w.label, w.percent, w.severity])) === JSON.stringify([['session', '5h limit', 12, 'normal'], ['weekly_all', 'Weekly limit', 80, 'warning'], ['weekly_scoped', 'Code review', 95, 'critical']]) && cx.windows[0].resetsAt === NOW + 3600000 && cx.windowsStaleSince === null && cx.usageFetchedAt === NOW - 1000, JSON.stringify(cx.windows));
  const cu = acct('cursor-w');
  check('logged in, no usage reading → no-plan-limits (not an error)', cu.login === 'no-plan-limits' && cu.loginDetail === null && cu.windows.length === 0 && cu.plan === 'cursor', JSON.stringify({ login: cu.login, d: cu.loginDetail }));
  const c2 = acct('codex-2');
  check('a carried snapshot → ok, windows shown, windowsStaleSince = when they were observed', c2.login === 'ok' && c2.windows.length === 3 && c2.windowsStaleSince === NOW - 120000 && c2.lastGoodWindowsAt === NOW - 120000, JSON.stringify({ login: c2.login, stale: c2.windowsStaleSince }));
  const cm = acct('codex-missing');
  check('CLI missing → error, with a clear loginDetail that starts with the stable prefix', cm.login === 'error' && cm.loginDetail === 'CLI not found: codex not found — the Codex CLI is not installed or not on PATH' && cm.windows.length === 0, cm.loginDetail);
  const cb = acct('codex-bare');
  check('CLI missing with no detail in the reading → the detail names the executable', cb.login === 'error' && cb.loginDetail === 'CLI not found — codex is not installed or not on PATH', cb.loginDetail);
  const co = acct('codex-out');
  check('logged out → expired', co.login === 'expired' && co.loginDetail === null);
  const cn = acct('codex-noread');
  check('no reading at all → refreshing (and only then)', cn.login === 'refreshing' && m.accounts.filter((a) => a.login === 'refreshing').map((a) => a.name).sort().join() === 'agy-plan,codex-noread' /* 2.0: was 'agy-plan,codex-noread,typo-w' — the unknown-provider entry is no account */, m.accounts.filter((a) => a.login === 'refreshing').map((a) => a.name).join());
  const ck = acct('codex-unknown');
  check('login unknown (clean reading, no verdict) → error with a detail that says so — never "refreshing", never "logged in"', ck.login === 'error' && ck.loginDetail === 'login state unknown — Codex did not report whether this account is signed in', ck.loginDetail);
  const ag = acct('agy-w');
  check('the same for an Antigravity account, naming that product', ag.login === 'error' && ag.loginDetail === 'login state unknown — Antigravity did not report whether this account is signed in', ag.loginDetail);
  const ce = acct('codex-err');
  check('a reading that failed with a reason → error + that reason', ce.login === 'error' && ce.loginDetail === 'the login check did not answer in time', ce.loginDetail);
  const cs = acct('cursor-sbx');
  check('a hostile reason is one line, ≤ 200 chars, no bidi/control characters', cs.login === 'error' && cs.loginDetail.length <= 200 && !/[\n‮\u0000-\u001f]/.test(cs.loginDetail) && cs.loginDetail.startsWith('the usage reading failed'), cs.loginDetail.slice(0, 60));
  const ch = acct('codex-hand');
  check('a hand-edited junk entry for a provider account: error, null detail, safe window, finite numbers', ch.login === 'error' && ch.loginDetail === null && ch.plan === null && ch.windows.length === 1 && ch.windows[0].percent === 0 && ch.windows[0].label === '<script>' && ch.usageFetchedAt === null, JSON.stringify({ login: ch.login, w: ch.windows }));
  check('a Claude account with no plan limits and no auth verdict is still no-plan-limits (rule unchanged)', acct('claude-w').login === 'no-plan-limits');
}

console.log('--- accounts: stats, cooldown, running — for a provider account');
{
  const cx = acct('codex-w');
  check('all-time stats and lastError by worker name', cx.allTime.tasks === 4 && cx.allTime.errors === 1 && cx.allTime.inputTokens === 100 && cx.allTime.outputTokens === 200 && cx.lastError === 'quota exceeded for the week', JSON.stringify(cx.allTime));
  check('cooldown', cx.cooldownUntil === NOW + 60000);
  check('running = its running dispatches', cx.running === 1 && acct('claude-w').running === 6 && acct('cursor-w').running === 0, `codex-w=${cx.running} claude-w=${acct('claude-w').running}`);
  check('5-hour / 7-day sums from its done events', cx.session5h.tasks === 1 && cx.session5h.inputTokens === 10 && cx.session5h.outputTokens === 20 && cx.week.tasks === 1 && acct('codex-2').week.tasks === 1 && acct('codex-2').week.inputTokens === 3, JSON.stringify(cx.session5h));
}

console.log('--- tasks: F2 (dispatch mode) and provider');
{
  check('F2 a RUNNING one-shot that carries pid + pgid reads "oneshot"', task(T.oneshotPgid).mode === 'oneshot' && task(T.oneshotPgid).status === 'running', task(T.oneshotPgid).mode);
  check('F2 a finished one-shot with pgid on every event reads "oneshot"', task(T.oneshotDonePgid).mode === 'oneshot' && task(T.oneshotDonePgid).inputTokens === 1);
  check('F2 a real detach task (supervisorPid on its events) reads "detached"', task(T.detach).mode === 'detached' && task(T.detach).status === 'done' && task(T.detach).inputTokens === 5, task(T.detach).mode);
  check('F2 a RUNNING detach task reads "detached"', task(T.detachRunning).mode === 'detached' && task(T.detachRunning).status === 'running');
  check('F2 supervisorPid on an EARLIER event only (the terminal event has none) still reads "detached"', task(T.detachTerminalWithout).mode === 'detached' && task(T.detachTerminalWithout).status === 'orphaned', task(T.detachTerminalWithout).mode);
  check('F2 supervisorPid that is not a number ("777", null, true) is not a marker — even beside a pgid', task(T.supString).mode === 'oneshot' && task(T.supNull).mode === 'oneshot' && task(T.supBool).mode === 'oneshot', [task(T.supString).mode, task(T.supNull).mode, task(T.supBool).mode].join());
  check('F2 a session-worker task reads "session" (also when a supervisorPid is present), tokens null', task(T.session).mode === 'session' && task(T.sessionWithSup).mode === 'session' && task(T.session).inputTokens === null);
  check('no task reads "detached" without a numeric supervisorPid somewhere in its events', m.tasks.filter((t) => t.mode === 'detached').map((t) => t.id).sort().join() === [T.detach, T.detachRunning, T.detachTerminalWithout, T.provDetached].sort().join());

  check('provider: a Codex task → "codex" (one-shot, tokens reported)', task(T.codexDone).provider === 'codex' && task(T.codexDone).mode === 'oneshot' && task(T.codexDone).inputTokens === 10 && task(T.codexDone).worker === 'codex-w' && task(T.codexDone).model === 'gpt-5.6-sol');
  check('provider: a running Codex task', task(T.codexRunning).provider === 'codex' && task(T.codexRunning).status === 'running' && task(T.codexRunning).mode === 'oneshot');
  check('provider: named on the first event only (terminal event written without it) → kept', task(T.providerFirstOnly).provider === 'cursor' && task(T.providerFirstOnly).status === 'orphaned', task(T.providerFirstOnly).provider);
  check('provider: a detached Codex task → detached + "codex"', task(T.provDetached).provider === 'codex' && task(T.provDetached).mode === 'detached');
  check('provider: alias "Antigravity" → "gemini"', task(T.provAlias).provider === 'gemini');
  check('provider: absent, "claude", unknown, a number, markup → null', task(T.plain).provider === null && task(T.provClaude).provider === null && task(T.provUnknown).provider === null && task(T.provNumber).provider === null && task(T.provMarkup).provider === null);
  check('provider: the latest event that names one decides (an unknown id there → null)', task(T.provLatestWins).provider === null);
  check('every task\'s provider is null or a non-Claude ProviderId', m.tasks.every((t) => t.provider === null || ['codex', 'cursor', 'gemini'].includes(t.provider)));
}

console.log('--- settings');
{
  const p = m.settings.providers;
  check('settings.providers lists all four, in display order', JSON.stringify(p.map((x) => x.id)) === JSON.stringify(['claude', 'codex', 'cursor', 'gemini']), JSON.stringify(p.map((x) => x.id)));
  check('settings.providers: labels', JSON.stringify(p.map((x) => x.label)) === JSON.stringify(['Claude Code', 'Codex', 'Cursor', 'Antigravity']));
  // [UPDATED, wave 7] `models` is platform.WORKER_MODELS, which now holds every tier alias — haiku too — in display order.
  check('settings.providers: Claude Code row', JSON.stringify(p[0]) === JSON.stringify({ id: 'claude', label: 'Claude Code', models: ['opus', 'sonnet', 'haiku', 'fable'], permissionModes: ['acceptEdits', 'auto', 'dontAsk', 'plan', 'default', 'bypassPermissions'], isolation: 'env', isolationVerified: true, sessionWorkers: true }), JSON.stringify(p[0]));
  check('settings.providers: Codex row', JSON.stringify(p[1]) === JSON.stringify({ id: 'codex', label: 'Codex', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'], permissionModes: ['workspace-write', 'read-only', 'danger-full-access'], isolation: 'env', isolationVerified: true, sessionWorkers: false }), JSON.stringify(p[1]));
  check('settings.providers: Cursor row (no isolation)', JSON.stringify(p[2]) === JSON.stringify({ id: 'cursor', label: 'Cursor', models: ['auto', 'composer-2.5'], permissionModes: ['enabled', 'disabled'], isolation: 'none', isolationVerified: false, sessionWorkers: false }), JSON.stringify(p[2]));
  check('settings.providers: Antigravity row (isolation unverified)', JSON.stringify(p[3]) === JSON.stringify({ id: 'gemini', label: 'Antigravity', models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'], permissionModes: ['accept-edits', 'plan'], isolation: 'env', isolationVerified: false, sessionWorkers: false }), JSON.stringify(p[3]));
  check('providerUsagePolling: absent → true (the default)', m.settings.providerUsagePolling === true);
  check('providerUsagePolling: false → false; true → true', build({ ...SETTINGS, providerUsagePolling: false }).settings.providerUsagePolling === false && build({ ...SETTINGS, providerUsagePolling: true }).settings.providerUsagePolling === true);
  check('providerUsagePolling: "false", 0, null are not a boolean false → true', ['false', 0, null, 'off', {}].every((v) => build({ ...SETTINGS, providerUsagePolling: v }).settings.providerUsagePolling === true));
  const forged = build({ ...SETTINGS, providers: [{ id: 'evil', label: '<script>', models: ['x'], permissionModes: ['--dangerously'], isolation: 'env', isolationVerified: true, sessionWorkers: true }] });
  check('a caller-supplied settings.providers is ignored: the list always comes from providers.ts', JSON.stringify(forged.settings.providers) === JSON.stringify(p));
  check('with no settings at all the provider fields are still there', (() => { const x = ui.buildDashboardModel({ workspaceRoot: WS, scope: 'workspace', sessions: [], now: NOW }); return x.settings.providers.length === 4 && x.settings.providerUsagePolling === true; })());

  const v = ui.validateSetting;
  check('validateSetting: providerUsagePolling accepts true and false', JSON.stringify(v('providerUsagePolling', true)) === JSON.stringify({ ok: true, key: 'providerUsagePolling', value: true }) && JSON.stringify(v('providerUsagePolling', false)) === JSON.stringify({ ok: true, key: 'providerUsagePolling', value: false }));
  check('validateSetting: providerUsagePolling rejects "true", "false", 1, 0, null, undefined, {}, []', ['true', 'false', 1, 0, null, undefined, {}, []].every((x) => v('providerUsagePolling', x).ok === false), JSON.stringify(v('providerUsagePolling', 'true')));
  check('validateSetting: a near-miss key is still unknown', v('providerUsagePollin', true).ok === false && v('providers', []).ok === false && v('ProviderUsagePolling', true).ok === false);
  check('validateSetting: existing keys unchanged', v('meshMode', true).ok && v('workerPermissionMode', 'auto').ok && !v('workerPermissionMode', 'read-only').ok && !v('meshMaxLiveWorkers', '5').ok);
}

console.log('--- resolvers and the shared account list');
{
  const cx = acct('codex-w');
  const r = ui.resolveAccount(cx.key);
  check('resolveAccount(key of the Codex account) → registry name, dir verbatim, provider', JSON.stringify(r) === JSON.stringify({ name: 'codex-w', configDir: D('.codex'), isMain: false, isWorker: true, provider: 'codex' }), JSON.stringify(r));
  const rm = ui.resolveAccount(m.accounts[0].key);
  check('resolveAccount(main) → provider claude, not the Codex worker registered on that directory', rm.name === 'main' && rm.provider === 'claude' && rm.isMain && !rm.isWorker && rm.configDir === HOST, JSON.stringify(rm));
  check('account keys are unique', new Set(m.accounts.map((a) => a.key)).size === m.accounts.length);
  const known = ui.knownAccounts();
  check('knownAccounts() carries the provider', known.length === m.accounts.length && known.find((a) => a.name === 'cursor-w').provider === 'cursor' && known[0].provider === 'claude');
}

console.log('--- the model as a whole');
{
  const json = JSON.stringify(m);
  check('the model is plain JSON with no secret or path of an account in it', JSON.stringify(JSON.parse(json)) === json && !json.includes(D('.codex')) && !json.includes(HOME), 'bytes=' + json.length);
  check('schema 2, no task-log problem, running counts', m.schema === 2 && m.health.taskLogProblem === null && m.running.workspace === 7 && m.taskTotal === Object.keys(T).length, `running=${m.running.workspace} total=${m.taskTotal}`);
  check('a second build with nothing changed is identical', JSON.stringify(build()) === json);
}

console.log('--- team: only Claude Code accounts are scanned for sessions');
(async () => {
  const sleeper = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const sleeper2 = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const entry = (pid, name) => JSON.stringify({ pid, sessionId: '11111111-2222-3333-4444-' + String(pid).padStart(12, '0'), cwd: WS, kind: 'interactive', name, status: 'idle', messagingSocketPath: '/tmp/cc-socks/x.sock', startedAt: NOW - 1000, updatedAt: NOW - 500 });
  const put = (dir, pid, name) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', pid + '.json'), entry(pid, name));
  };
  put(D('.claude-w'), sleeper.pid, 'a-real-claude-session');
  put(D('.codex'), sleeper2.pid, 'looks-like-a-session-under-a-codex-home');
  // far more files than one scan reads, under a Cursor "home"
  fs.mkdirSync(path.join(D('.cursor'), 'sessions'), { recursive: true });
  for (let i = 0; i < 2500; i++) fs.writeFileSync(path.join(D('.cursor'), 'sessions', `${100000 + i}.json`), '');
  team.invalidateTeamCache();
  const rows = team.collectSessions({ workspaceRoot: WS, scope: 'all', now: NOW, maxAgeMs: 0 });
  const peers = rows.filter((r) => r.source === 'peer');
  check('the live session under the Claude worker\'s directory is listed as a peer', peers.some((r) => r.name === 'a-real-claude-session' && r.accountName === 'claude-w'), JSON.stringify(peers.map((r) => [r.name, r.accountName])));
  check('an entry of the same shape under a Codex home is NOT listed', !rows.some((r) => r.name === 'looks-like-a-session-under-a-codex-home'));
  check('2,500 files under a Cursor home produce no "session list incomplete" row', !rows.some((r) => r.name.includes('incomplete')), JSON.stringify(rows.map((r) => r.name)));
  check('no session row names a provider account', rows.every((r) => !['codex-w', 'cursor-w', 'agy-w', 'codex-2'].includes(r.accountName)));
  const model = ui.buildDashboardModel({ workspaceRoot: WS, scope: 'all', settings: SETTINGS, health: HEALTH, sessions: rows, now: NOW });
  check('and the model built with those rows keeps exactly them', model.sessions.length === rows.length && model.sessions.some((s) => s.name === 'a-real-claude-session'));
  sleeper.kill('SIGKILL');
  sleeper2.kill('SIGKILL');

  console.log(`\nui2: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNEXPECTED THROW', e);
  process.exit(3);
});
