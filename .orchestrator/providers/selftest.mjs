// selftest.mjs — proves the harness itself, with NO server and no build:
//
//   node .orchestrator/providers/probe.mjs --selftest           all cases
//   node .orchestrator/providers/probe.mjs --selftest S3 S7     a subset
//
// The cases drive the three fake CLIs through the REAL adapter packages installed in
// node_modules (@toragonite/agent-mesh-codex / -cursor / -gemini), each constructed with
// `binary` pointing at a fake. They pin, per scenario, exactly what the adapter makes of the
// fake's output — which is what the server under test will be handed. A probe that later
// fails against the server therefore fails because of the server, not because a fake and an
// adapter disagree.
//
// It also proves the safety plumbing: the fakes refuse to run outside a sandbox, the network
// guard really intercepts `fetch` and sockets, and the hermeticity check can see a decoy.

import keychainGuard from '../fixes/keychain-guard.cjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

import { CURSOR_IDENTITY, EXIT_NO_SANDBOX, EXIT_UNSUPPORTED, RAW_MARKER, SCENARIO_ENV, TEXTS, TOKENS } from './fake-vendor.mjs';
import {
  FAKE_CLAUDE2,
  FAKE_ENTRIES,
  MODEL_FORMS_HINT,
  PROVIDERS,
  QUOTA_CLASSIFIER,
  REPO_ROOT,
  SECRETS,
  SESSION_IDENTITY_ENV,
  VENDOR_IDS,
  cleanupAll,
  clip,
  hermeticVerdict,
  inspectHermeticity,
  isPidAlive,
  leftoverSandboxes,
  loadAdapters,
  makeFixture,
  pgidOf,
  rmrf,
  runFile,
  runNode,
  settleStrays,
  waitFor,
  writeCodexAuth,
} from './helpers.mjs';

class Mismatch extends Error {}

function check(cond, what, observed) {
  if (!cond) {
    throw new Mismatch(`${what}; observed ${clip(typeof observed === 'string' ? observed : JSON.stringify(observed), 500)}`);
  }
}
function eq(actual, expected, what) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}`, actual);
}

/** Await a promise that must reject; returns the error. */
async function rejects(promise, what) {
  try {
    const value = await promise;
    throw new Mismatch(`${what}: expected a rejection; observed a result ${clip(JSON.stringify(value), 300)}`);
  } catch (err) {
    if (err instanceof Mismatch) {
      throw err;
    }
    return err;
  }
}

const HUGE_FLOOR = 8 * 1024 * 1024;

/**
 * A timeout long enough for a fake to have STARTED before it fires. The adapter's clock runs
 * from the spawn, and on a loaded machine a Node process takes a second or more to come up:
 * a fixed short timeout would kill the group before the fake had logged anything.
 */
async function hangTimeoutMs(fx, cli) {
  const started = Date.now();
  await runFile(fx.launcher(cli), ['--version'], { env: fx.env(), cwd: fx.workspace });
  return Math.min(8000, Math.max(1500, (Date.now() - started) * 3));
}

/** A `readTextFile` seam that refuses to read anything outside the sandbox. */
function sandboxReader(fx) {
  return async (file) => {
    if (!path.resolve(file).startsWith(fx.root + path.sep)) {
      throw new Error(`self-test reader was asked for ${file}, outside the sandbox`);
    }
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
}

/** A `fetchFn` seam that must never be reached. */
const forbiddenFetch = async (url) => {
  throw new Error(`self-test: unexpected fetch of ${url}`);
};

function codexAdapter(A, fx, extra = {}) {
  return new A.CodexAdapter({ binary: fx.launcher('codex'), env: fx.env(), readTextFile: sandboxReader(fx), fetchFn: forbiddenFetch, ...extra });
}
const codexAccount = (fx, name = 'cx') => ({ vendor: 'codex', configDir: fx.worker(name).configDir });

/* ------------------------------------------------------------------------- *
 * Cases
 * ------------------------------------------------------------------------- */

async function s1(t) {
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  const other = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  const outside = fs.realpathSync(os.tmpdir());
  const seen = [];
  for (const [cli, entry] of Object.entries(FAKE_ENTRIES)) {
    // no scenario variable at all
    let r = await runNode([entry, '--version'], { env: fx.env({ [SCENARIO_ENV]: null }), cwd: fx.workspace });
    eq(r.code, EXIT_NO_SANDBOX, `${cli}: without ${SCENARIO_ENV} the fake exits ${EXIT_NO_SANDBOX}`);
    // a scenario file that is not in a sandbox (no marker beside it)
    const stray = fs.mkdtempSync(path.join(outside, 'cco-prov-stray-'));
    try {
      fs.writeFileSync(path.join(stray, 'scenario.json'), '{}');
      r = await runNode([entry, '--version'], { env: fx.env({ [SCENARIO_ENV]: path.join(stray, 'scenario.json') }), cwd: fx.workspace });
      eq(r.code, EXIT_NO_SANDBOX, `${cli}: a scenario outside a sandbox is refused`);
    } finally {
      rmrf(stray);
    }
    // HOME outside the sandbox
    r = await runNode([entry, '--version'], { env: fx.env({ HOME: outside }), cwd: fx.workspace });
    eq(r.code, EXIT_NO_SANDBOX, `${cli}: HOME outside the sandbox is refused`);
    // a launcher of sandbox A driven by the scenario of sandbox B
    r = await runFile(fx.launcher(cli), ['--version'], { env: other.env({ PATH: fx.sandboxPath }), cwd: fx.workspace });
    eq(r.code, EXIT_NO_SANDBOX, `${cli}: a launcher refuses another sandbox's scenario`);
    // the launcher started WITHOUT the harness environment: refused, and it says so in the log
    r = await runFile(fx.launcher(cli), ['--version'], { env: fx.env({ [SCENARIO_ENV]: null }), cwd: fx.workspace });
    eq(r.code, EXIT_NO_SANDBOX, `${cli}: a launcher without the scenario variable is refused`);
    // something the fake does not emulate
    r = await runFile(fx.launcher(cli), ['frobnicate', '--now'], { env: fx.env(), cwd: fx.workspace });
    eq(r.code, EXIT_UNSUPPORTED, `${cli}: an unsupported invocation exits ${EXIT_UNSUPPORTED}`);
    seen.push(cli);
  }
  // the vendor home outside the sandbox, and a run from a working directory outside it
  let r = await runFile(fx.launcher('codex'), ['--version'], { env: fx.env({ CODEX_HOME: path.join(outside, 'not-a-sandbox-codex-home') }), cwd: fx.workspace });
  eq(r.code, EXIT_NO_SANDBOX, 'codex: CODEX_HOME outside the sandbox is refused');
  r = await runFile(fx.launcher('agy'), ['models'], { env: fx.env({ AGY_HOME: path.join(outside, 'not-a-sandbox-agy-home') }), cwd: fx.workspace });
  eq(r.code, EXIT_NO_SANDBOX, 'agy: AGY_HOME outside the sandbox is refused');
  r = await runFile(fx.launcher('codex'), ['exec', '--json', '--', 'never runs'], { env: fx.env({ CODEX_HOME: fx.worker('cx').configDir }), cwd: outside });
  eq(r.code, EXIT_NO_SANDBOX, 'codex: a run whose working directory is outside the sandbox is refused');
  const kinds = fx.anomalies().map((a) => a.kind);
  check(kinds.filter((k) => k === 'no-scenario').length === 3, 'each launcher logged a no-scenario record', kinds);
  check(kinds.filter((k) => k === 'sandbox-violation').length >= 5, 'the sandbox violations were logged', kinds);
  check(kinds.filter((k) => k === 'unsupported').length === 3, 'the unsupported invocations were logged', kinds);
  check(fx.runs().length === 0, 'none of the refused invocations ran anything', fx.runs().map((x) => x.argv));
  return `${seen.join(', ')}: exit ${EXIT_NO_SANDBOX} without a scenario, with a scenario outside a sandbox, with HOME / the vendor home / the working directory outside it, and across sandboxes; exit ${EXIT_UNSUPPORTED} for an unknown invocation; every refusal logged`;
}

async function s2(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }, { name: 'cd', provider: 'codex', configDir: 'default' }] });
  const codex = codexAdapter(A, fx);
  const r = await codex.run({ prompt: 'S2 prompt --with a flag-shaped tail', model: 'gpt-5.6-sol', permissionMode: 'workspace-write', cwd: fx.workspace, account: codexAccount(fx), timeoutMs: 15_000 });
  const run = fx.runs('codex')[0];
  eq(run.argv, ['exec', '--json', '--model', 'gpt-5.6-sol', '--sandbox', 'workspace-write', '--', 'S2 prompt --with a flag-shaped tail'], 'codex argv as the adapter builds it');
  eq(run.cwd, fx.workspace, 'codex cwd');
  eq(run.env.CODEX_HOME, fx.worker('cx').configDir, 'CODEX_HOME for an isolated account');
  eq(run.groupLeader, true, 'the adapter spawned the fake as a process-group leader');
  eq({ status: r.status, text: r.text, conversationId: r.conversationId, model: r.model }, { status: 'ok', text: run.text, conversationId: run.conversationId, model: 'gpt-5.6-sol' }, 'codex RunResult');
  check(r.text.startsWith(TEXTS.codex.ok), 'the text carries the fake marker', r.text);
  eq({ i: r.usage?.inputTokens, o: r.usage?.outputTokens }, { i: TOKENS.codex.input, o: TOKENS.codex.output }, 'codex token usage');
  check(JSON.stringify(r.raw).includes(RAW_MARKER), 'RunResult.raw carries the planted raw marker (so a relay of `raw` is detectable)', r.raw);
  // the ambient account: no CODEX_HOME, the fake resolves $HOME/.codex as the CLI would
  const r2 = await codex.run({ prompt: 'S2 ambient', cwd: fx.workspace, account: { vendor: 'codex' }, timeoutMs: 15_000 });
  const run2 = fx.runs('codex')[1];
  eq(run2.argv, ['exec', '--json', '--', 'S2 ambient'], 'codex argv with no model and no mode');
  eq([run2.env.CODEX_HOME, run2.homeSource, run2.home], [undefined, 'default', fx.defaultHome('codex')], 'the ambient account runs with no CODEX_HOME');
  eq(r2.status, 'ok', 'ambient run status');
  check(r2.model === undefined, 'no model is reported when none was asked for and the stream names none', r2.model);
  return `argv ${JSON.stringify(run.argv.slice(0, 6))} … -- <prompt>; cwd, CODEX_HOME (isolated: set, ambient: absent), text, conversation id ${r.conversationId}, tokens ${r.usage.inputTokens}/${r.usage.outputTokens} all as the adapter reports them`;
}

async function s3(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }, { name: 'out', provider: 'codex', auth: 'out' }] });
  const codex = codexAdapter(A, fx);
  const run = (spec, extra = {}) => {
    fx.setScenario({ codex: { run: spec } });
    return codex.run({ prompt: 'S3', cwd: fx.workspace, account: codexAccount(fx), timeoutMs: 15_000, ...extra });
  };
  const seen = [];
  let r = await run('ok-empty-text');
  eq([r.status, r.text], ['incomplete', ''], 'ok-empty-text → the Codex adapter reports incomplete (an empty answer is never "ok" for it)');
  seen.push('ok-empty-text→incomplete');
  r = await run('ok-blank-text');
  check(r.status === 'ok' && r.text.trim() === '' && r.text !== '', 'ok-blank-text → status ok with whitespace-only text', r);
  seen.push('ok-blank-text→ok+blank');
  r = await run('ok-no-conversation');
  eq([r.status, r.conversationId], ['ok', ''], 'ok-no-conversation → no conversation id');
  r = await run('error');
  check(r.status === 'error' && r.text === '' && String(r.note).includes(TEXTS.codex.error), 'error → status error, the vendor message in `note`, empty text', r);
  check(!QUOTA_CLASSIFIER.test(`${r.text} ${r.note}`), 'the error text must not look like a quota error', r.note);
  seen.push('error→error (message in note, text empty)');
  r = await run('quota');
  check(r.status === 'error' && r.text === '' && QUOTA_CLASSIFIER.test(String(r.note)), 'quota → status error, a quota sentence in `note`, empty text; the adapter raises no QuotaExceededError', r);
  seen.push('quota→error (sentence in note)');
  r = await run({ kind: 'quota', carrier: 'text' });
  check(r.status === 'error' && QUOTA_CLASSIFIER.test(r.text), 'quota with carrier text → the sentence is also the text', r);
  r = await run({ kind: 'auth' });
  check(r.status === 'error' && String(r.note).includes(TEXTS.codex.auth) && !QUOTA_CLASSIFIER.test(String(r.note)), 'auth → status error with the login sentence in `note`; the adapter raises no AuthError', r);
  seen.push('auth→error (login sentence in note)');
  // a logged-out auth.json makes ANY scenario answer as logged out, and authStatus agrees
  fx.setScenario({ codex: { run: 'ok' } });
  r = await codex.run({ prompt: 'S3 logged out', cwd: fx.workspace, account: codexAccount(fx, 'out'), timeoutMs: 15_000 });
  check(r.status === 'error' && String(r.note).includes(TEXTS.codex.auth), 'a logged-out account answers the login error whatever the scenario', r);
  eq(await codex.authStatus(codexAccount(fx, 'out')), { loggedIn: false }, 'authStatus of the logged-out fixture');
  r = await run('garbage');
  eq(r.status, 'incomplete', 'garbage → incomplete');
  const crash = await rejects(run('exit:3'), 'exit:3');
  check(crash instanceof A.core.AdapterExecError && crash.exitCode === 3 && /deterministic crash/.test(String(crash.stderr)), 'exit:3 → AdapterExecError with the exit code and stderr', { name: crash.name, message: crash.message, exitCode: crash.exitCode });
  seen.push('exit:3→AdapterExecError');
  const started = Date.now();
  r = await run('slow:400');
  check(r.status === 'ok' && Date.now() - started >= 400, 'slow:400 → ok after at least 400 ms', { status: r.status, ms: Date.now() - started });
  r = await run({ kind: 'ok', reportModel: 'gpt-5.5', inputTokens: 11, outputTokens: 22, text: 'custom text', conversationId: 'custom-thread' });
  eq([r.model, r.usage.inputTokens, r.usage.outputTokens, r.text, r.conversationId], ['gpt-5.5', 11, 22, 'custom text', 'custom-thread'], 'the ok knobs (reportModel, token counts, text, conversationId)');
  const before = fx.runs('codex').length;
  const blocked = await rejects(run('ok', { model: 'gpt-5.1-codex-max' }), 'an api-key-only model under a ChatGPT login');
  check(blocked instanceof A.core.AgentMeshError && fx.runs('codex').length === before, 'the adapter blocks an api-key-only model before spawning', { message: blocked.message });
  seen.push('api-key-only model blocked before spawn');
  return seen.join('; ');
}

async function s4(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  const codex = codexAdapter(A, fx);
  // hang + a grandchild in the same process group; the adapter's own exec times out and
  // signals the group
  const timeoutMs = await hangTimeoutMs(fx, 'codex');
  fx.setScenario({ codex: { run: { kind: 'hang', grandchild: true } } });
  let pending = codex.run({ prompt: 'S4 hang', cwd: fx.workspace, account: codexAccount(fx), timeoutMs });
  let run = await waitFor(() => fx.runs('codex').find((x) => x.grandchildPid), { label: 'the hanging run to start', timeoutMs });
  await waitFor(() => fx.grandchildren().find((g) => g.pid === run.grandchildPid), { label: 'the grandchild to register', timeoutMs });
  eq([pgidOf(run.pid), pgidOf(run.grandchildPid)], [run.pid, run.pid], 'the fake leads a process group and its grandchild is in it');
  let r = await pending;
  check(r.status === 'incomplete' && /timed out/.test(String(r.note)), 'hang → the adapter resolves incomplete with a timed-out note', r);
  await waitFor(() => !isPidAlive(run.pid) && !isPidAlive(run.grandchildPid), { label: 'the fake and its grandchild to die', timeoutMs: 4000 });
  // the SIGTERM-ignoring variant survives until the group SIGKILL, 5 s later
  fx.setScenario({ codex: { run: { kind: 'hang', ignoreSigterm: true, grandchild: { ignoreSigterm: true } } } });
  const started = Date.now();
  pending = codex.run({ prompt: 'S4 stubborn hang', cwd: fx.workspace, account: codexAccount(fx), timeoutMs });
  run = await waitFor(() => fx.runs('codex').find((x) => x.spec?.ignoreSigterm), { label: 'the stubborn run to start', timeoutMs });
  await waitFor(() => fx.grandchildren().find((g) => g.pid === run.grandchildPid), { label: 'the stubborn grandchild to register', timeoutMs });
  r = await pending;
  const elapsed = Date.now() - started;
  check(r.status === 'incomplete' && elapsed >= timeoutMs + 4500, 'a fake that ignores SIGTERM lives until the SIGKILL 5 s after the timeout', { status: r.status, elapsed, timeoutMs });
  check(fx.vendorLog().filter((x) => x.kind === 'sigterm-ignored').length >= 2, 'the fake and its grandchild both logged the SIGTERM they ignored', fx.vendorLog().map((x) => x.kind));
  await waitFor(() => !isPidAlive(run.pid) && !isPidAlive(run.grandchildPid), { label: 'the stubborn fake and grandchild to die', timeoutMs: 4000 });
  // a grandchild that keeps the pipes open after the fake has answered and exited
  fx.setScenario({ codex: { run: { kind: 'spawn-grandchild', grandchild: { holdPipes: true, lifetimeMs: 3000 } } } });
  const t0 = Date.now();
  r = await codex.run({ prompt: 'S4 held pipes', cwd: fx.workspace, account: codexAccount(fx), timeoutMs: 20_000 });
  check(r.status === 'ok' && Date.now() - t0 >= 2500, "with the pipes held, the adapter's default exec only settles when the grandchild lets go (the server's own exec must not wait)", { status: r.status, ms: Date.now() - t0 });
  return `hang → incomplete/timed out, fake and grandchild share a process group and both die; the SIGTERM-ignoring variant lasted ${elapsed} ms against a ${timeoutMs} ms timeout (SIGKILL after 5 s); held pipes delay the adapter's default exec by the grandchild's lifetime`;
}

async function s5(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }, { name: 'ag', provider: 'gemini' }] });
  const env = fx.env({ CODEX_HOME: fx.worker('cx').configDir });
  const sizes = [];
  for (const where of ['text', 'after', 'before']) {
    fx.setScenario({ codex: { run: { kind: 'huge', where } } });
    const r = await runFile(fx.launcher('codex'), ['exec', '--json', '--', 'S5'], { env, cwd: fx.workspace, timeoutMs: 60_000 });
    check(r.code === 0 && r.stdout.length > HUGE_FLOOR && r.stderr.length > HUGE_FLOOR, `huge (${where}) writes more than 8 MiB on stdout and on stderr`, { code: r.code, stdout: r.stdout.length, stderr: r.stderr.length });
    sizes.push(`${where}: ${(r.stdout.length / 1048576).toFixed(1)} MiB out, ${(r.stderr.length / 1048576).toFixed(1)} MiB err`);
  }
  // through the adapters (their default exec has no cap): the answer survives in all three forms
  const codex = codexAdapter(A, fx);
  fx.setScenario({ codex: { run: { kind: 'huge', where: 'text' } }, cursor: { run: { kind: 'huge', where: 'text', stderr: false } }, gemini: { run: { kind: 'huge', where: 'text', stderr: false } } });
  let r = await codex.run({ prompt: 'S5', cwd: fx.workspace, account: codexAccount(fx), timeoutMs: 60_000 });
  check(r.status === 'ok' && r.text.length > HUGE_FLOOR, 'codex huge text arrives whole through an uncapped exec', { status: r.status, length: r.text.length });
  r = await new A.CursorAdapter({ binary: fx.launcher('cursor-agent'), env: fx.env() }).run({ prompt: 'S5', cwd: fx.workspace, timeoutMs: 60_000 });
  check(r.status === 'ok' && r.text.length > HUGE_FLOOR, 'cursor huge text arrives whole through an uncapped exec', { status: r.status, length: r.text.length });
  r = await new A.GeminiAdapter({ binary: fx.launcher('agy'), env: fx.env() }).run({ prompt: 'S5', cwd: fx.workspace, timeoutMs: 60_000 });
  check(r.status === 'ok' && r.text.length > HUGE_FLOOR, 'agy huge text arrives whole through an uncapped exec', { status: r.status, length: r.text.length });
  fx.setScenario({ codex: { run: { kind: 'huge', where: 'after' } } });
  r = await codex.run({ prompt: 'S5', cwd: fx.workspace, account: codexAccount(fx), timeoutMs: 60_000 });
  check(r.status === 'ok' && r.text.startsWith(TEXTS.codex.ok), 'codex huge (after): the answer precedes the chatter and is found', { status: r.status, text: clip(r.text, 80) });
  return sizes.join('; ');
}

async function s6(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  const dir = fx.worker('cx').configDir;
  const acct = codexAccount(fx);
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.Authorization, accountId: init?.headers?.['chatgpt-account-id'] });
    return new Response(
      JSON.stringify({ allowed: true, primary_window: { used_percent: 42, resets_at: 1893456000 }, secondary_window: { used_percent: 7, resets_at: 1893456000 }, harness_raw_marker: RAW_MARKER }),
      { status: 200 },
    );
  };
  const codex = codexAdapter(A, fx, { fetchFn });
  const states = [];
  for (const [state, want] of [
    ['chatgpt', { loggedIn: true, mode: 'chatgpt', detail: SECRETS.email }],
    ['chatgpt-quota', { loggedIn: true, mode: 'chatgpt', detail: SECRETS.email }],
    ['api-key', { loggedIn: true, mode: 'api-key' }],
    ['out', { loggedIn: false }],
    ['garbage', { loggedIn: false }],
    ['absent', { loggedIn: false }],
  ]) {
    writeCodexAuth(dir, state);
    eq(await codex.authStatus(acct), want, `authStatus for the ${state} fixture`);
    states.push(`${state}→${want.loggedIn ? want.mode : 'out'}`);
  }
  // quota: only a fixture with an access token reaches fetch
  writeCodexAuth(dir, 'chatgpt');
  eq(await codex.quota(acct), null, 'quota() of the default fixture (no access token)');
  eq(calls.length, 0, 'quota() of the default fixture never calls fetch');
  writeCodexAuth(dir, 'chatgpt-quota');
  const snap = await codex.quota(acct);
  eq(
    [snap?.allowed, snap?.windows?.map((w) => [w.label, w.usedPercent, typeof w.resetAt])],
    [true, [['primary', 42, 'string'], ['secondary', 7, 'string']]],
    'quota() snapshot mapped from the usage body',
  );
  eq([calls.length, calls[0]?.authorization, calls[0]?.accountId], [1, `Bearer ${SECRETS.accessToken}`, SECRETS.accountId], 'quota() sends the bearer from auth.json to the fetch seam, once');
  check(/^https:\/\/chatgpt\.com\//.test(calls[0].url), 'the usage endpoint the adapter asks for', calls[0].url);
  const failing = codexAdapter(A, fx, {
    fetchFn: async () => {
      throw new TypeError('fetch failed');
    },
  });
  eq(await failing.quota(acct), null, 'a failed fetch resolves null');
  return `authStatus: ${states.join(', ')}; quota(): null with no access token (no fetch), a two-window snapshot with one, null when fetch fails`;
}

async function s7(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'cu', provider: 'cursor' }] });
  const cursor = () => new A.CursorAdapter({ binary: fx.launcher('cursor-agent'), env: fx.env() });
  eq(await cursor().authStatus(), { loggedIn: true, mode: 'cursor', detail: CURSOR_IDENTITY }, 'cursor authStatus, logged in');
  let r = await cursor().run({ prompt: 'S7 prompt', model: 'composer-2.5', permissionMode: 'enabled', cwd: fx.workspace, timeoutMs: 15_000 });
  const run = fx.runs('cursor')[0];
  eq(run.argv, ['-p', '--output-format', 'json', '--trust', '--model', 'composer-2.5', '--sandbox', 'enabled', '--', 'S7 prompt'], 'cursor-agent argv as the adapter builds it');
  eq([run.env.CODEX_HOME, run.env.AGY_HOME, run.homeSource], [undefined, undefined, 'ambient'], 'cursor-agent gets no home variable');
  eq([r.status, r.text, r.conversationId, r.model, r.usage?.inputTokens, r.usage?.outputTokens], ['ok', run.text, run.conversationId, 'composer-2.5', TOKENS.cursor.input, TOKENS.cursor.output], 'cursor RunResult');
  r = await cursor().run({ prompt: 'S7 default', cwd: fx.workspace, timeoutMs: 15_000 });
  eq(fx.runs('cursor')[1].argv, ['-p', '--output-format', 'json', '--trust', '--', 'S7 default'], 'cursor-agent argv with no model and no mode');
  check(r.model === undefined, 'cursor reports no model when none was requested', r.model);
  const models = await cursor().availableModels();
  check(models.some((m) => m.id === 'auto') && models.some((m) => m.id === 'composer-2.5'), 'availableModels() parses the fake `models` listing', models.map((m) => m.id));
  const scen = (spec, login = 'in') => fx.setScenario({ cursor: { run: spec, login } });
  scen('error');
  r = await cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 15_000 });
  eq([r.status, r.text], ['error', TEXTS.cursor.error], 'cursor error → status error with the message as TEXT');
  scen('quota');
  r = await cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 15_000 });
  check(r.status === 'error' && QUOTA_CLASSIFIER.test(r.text), 'cursor quota → status error with a quota sentence as text', r);
  scen('ok-empty-text');
  r = await cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 15_000 });
  eq(r.status, 'incomplete', 'cursor ok-empty-text → incomplete');
  scen('ok-no-conversation');
  r = await cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 15_000 });
  eq([r.status, r.conversationId], ['ok', ''], 'cursor ok-no-conversation');
  scen({ kind: 'hang', grandchild: true });
  r = await cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: await hangTimeoutMs(fx, 'cursor-agent') });
  check(r.status === 'incomplete' && /timed out/.test(String(r.note)), 'cursor hang → incomplete', r);
  // logged out: the status probe says so, and a run dies with the login sentence on stderr
  scen('ok', 'out');
  eq(await cursor().authStatus(), { loggedIn: false }, 'cursor authStatus, logged out');
  const err = await rejects(cursor().run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 15_000 }), 'a logged-out cursor run');
  check(err instanceof A.core.AdapterExecError && String(err.stderr).includes(TEXTS.cursor.auth), 'cursor logged out → AdapterExecError whose STDERR carries the login sentence', { message: err.message, stderr: err.stderr });
  check(!/log|auth/i.test(err.message), "the AdapterExecError's own MESSAGE does not mention the login (only .stderr does)", err.message);
  fx.removeCli('cursor-agent');
  eq(await new A.CursorAdapter({ binary: fx.launcher('cursor-agent'), env: fx.env() }).authStatus(), { loggedIn: false }, 'cursor authStatus, binary missing');
  const enoent = await rejects(new A.CursorAdapter({ binary: fx.launcher('cursor-agent'), env: fx.env() }).run({ prompt: 'S7', cwd: fx.workspace, timeoutMs: 5000 }), 'a run with no binary');
  check(enoent instanceof A.core.AdapterExecError && /failed to start/.test(enoent.message), 'a missing binary → AdapterExecError "failed to start"', enoent.message);
  return `argv ${JSON.stringify(run.argv.slice(0, 8))} -- <prompt>; no home variable; error and quota arrive as TEXT; logged out → AdapterExecError("${err.message}") with the login sentence only in .stderr; missing binary → "failed to start"`;
}

async function s8(t) {
  const A = await t.adapters();
  const fx = t.fixture({ workers: [{ name: 'ag', provider: 'gemini' }, { name: 'gd', provider: 'gemini', configDir: 'default' }] });
  const agy = () => new A.GeminiAdapter({ binary: fx.launcher('agy'), env: fx.env() });
  const iso = { vendor: 'gemini', configDir: fx.worker('ag').configDir };
  eq(await agy().authStatus(iso), { loggedIn: true, mode: 'google' }, 'agy authStatus, logged in');
  let r = await agy().run({ prompt: 'S8 prompt', model: 'gemini-3.8-flash-high', permissionMode: 'accept-edits', cwd: fx.workspace, account: iso, timeoutMs: 15_000 });
  const run = fx.runs('gemini')[0];
  eq(run.argv, ['--output-format', 'json', '--model', 'gemini-3.8-flash-high', '--mode', 'accept-edits', '-p', 'S8 prompt'], 'agy argv as the adapter builds it');
  eq(run.env.AGY_HOME, fx.worker('ag').configDir, 'AGY_HOME for an isolated account');
  eq([r.status, r.text, r.conversationId, r.model, r.usage?.inputTokens, r.usage?.outputTokens], ['ok', run.text, run.conversationId, 'gemini-3.8-flash-high', TOKENS.gemini.input, TOKENS.gemini.output], 'agy RunResult (the trailing newline is stripped)');
  r = await agy().run({ prompt: 'S8 ambient', cwd: fx.workspace, account: { vendor: 'gemini' }, timeoutMs: 15_000 });
  const run2 = fx.runs('gemini')[1];
  eq([run2.argv, run2.env.AGY_HOME, run2.home], [['--output-format', 'json', '-p', 'S8 ambient'], undefined, fx.defaultHome('gemini')], 'agy ambient run: no --model, no --mode, no AGY_HOME');
  const scen = (spec, login = 'in') => fx.setScenario({ gemini: { run: spec, login } });
  scen('ok-empty-text');
  r = await agy().run({ prompt: 'S8', cwd: fx.workspace, account: iso, timeoutMs: 15_000 });
  eq([r.status, r.text], ['ok', ''], 'agy ok-empty-text → status ok WITH empty text (the one adapter where that is reachable)');
  scen('error');
  r = await agy().run({ prompt: 'S8', cwd: fx.workspace, account: iso, timeoutMs: 15_000 });
  check(r.status === 'error' && r.text === '' && String(r.note).includes(TEXTS.gemini.error), 'agy error → status error, the message in `note`, empty text', r);
  scen('quota');
  r = await agy().run({ prompt: 'S8', cwd: fx.workspace, account: iso, timeoutMs: 15_000 });
  check(r.status === 'error' && r.text === '' && QUOTA_CLASSIFIER.test(String(r.note)), 'agy quota → status error with a quota sentence in `note`', r);
  scen('ok', { default: 'in', byHome: { [path.basename(fx.worker('ag').configDir)]: 'out' } });
  eq(await agy().authStatus(iso), { loggedIn: false }, 'agy authStatus of the logged-out home');
  eq(await agy().authStatus({ vendor: 'gemini' }), { loggedIn: true, mode: 'google' }, 'agy authStatus of the other home is unaffected');
  r = await agy().run({ prompt: 'S8', cwd: fx.workspace, account: iso, timeoutMs: 15_000 });
  check(r.status === 'error' && String(r.note).includes(TEXTS.gemini.auth), 'agy logged out → status error with the login sentence in `note`', r);
  scen({ kind: 'hang' });
  r = await agy().run({ prompt: 'S8', cwd: fx.workspace, account: { vendor: 'gemini' }, timeoutMs: await hangTimeoutMs(fx, 'agy') });
  eq(r.status, 'incomplete', 'agy hang → incomplete');
  fx.removeCli('agy');
  eq(await agy().authStatus(iso), { loggedIn: false }, 'agy authStatus, binary missing');
  return `argv ${JSON.stringify(run.argv.slice(0, 6))} -p <prompt>; AGY_HOME (isolated: set, ambient: absent); empty answer → status ok with text ""; error, quota and login failure all arrive in note with empty text`;
}

async function s9() {
  const offenders = [];
  for (const v of VENDOR_IDS) {
    if (!QUOTA_CLASSIFIER.test(TEXTS[v].quota)) {
      offenders.push(`${v}.quota does not match the classifier`);
    }
    for (const k of ['ok', 'error', 'auth']) {
      if (QUOTA_CLASSIFIER.test(TEXTS[v][k])) {
        offenders.push(`${v}.${k} matches the classifier`);
      }
    }
    for (const n of Object.values(TOKENS[v])) {
      if (QUOTA_CLASSIFIER.test(String(n))) {
        offenders.push(`${v} token count ${n} matches the classifier`);
      }
    }
  }
  for (const s of [RAW_MARKER, CURSOR_IDENTITY, ...Object.values(SECRETS), 'account.configDir is passed as AGY_HOME; Antigravity account isolation is unverified']) {
    if (QUOTA_CLASSIFIER.test(s)) {
      offenders.push(`"${s}" matches the classifier`);
    }
  }
  check(offenders.length === 0, 'only the quota texts may look like a quota error to the server', offenders);
  return 'every quota text matches the server classifier; no ok / error / login text, token count, marker or adapter note does';
}

async function s10(t) {
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex', auth: 'chatgpt-quota' }] });
  const script = `
    import net from 'node:net';
    import http from 'node:http';
    const out = { guard: globalThis.fetch.name };
    if (out.guard !== 'guardedFetch') { console.log(JSON.stringify(out)); process.exit(3); }
    try { await fetch('https://nonexistent.invalid/usage'); out.deny = 'resolved'; } catch (e) { out.deny = e.message + '/' + (e.cause && e.cause.code); }
    out.connect = await new Promise((r) => { const s = net.connect(9, '192.0.2.1'); s.on('error', (e) => r(e.code)); s.on('connect', () => r('connected')); });
    const srv = http.createServer((q, s) => s.end('loopback-ok')); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    out.loopback = await (await fetch('http://127.0.0.1:' + srv.address().port + '/')).text(); srv.close();
    const { CodexAdapter } = await import('@toragonite/agent-mesh-codex');
    const snap = await new CodexAdapter({ binary: ${JSON.stringify(fx.launcher('codex'))} }).quota({ vendor: 'codex', configDir: ${JSON.stringify(fx.worker('cx').configDir)} });
    out.quota = snap && { allowed: snap.allowed, windows: snap.windows };
    console.log(JSON.stringify(out));
  `;
  const run = async () => {
    // the child resolves the adapter package from the repository's node_modules
    const r = await runNode(['--input-type=module', '-e', script], { env: fx.env(), cwd: REPO_ROOT, timeoutMs: 30_000 });
    check(r.code === 0, 'the guarded child ran', { code: r.code, stderr: clip(r.stderr, 400), stdout: clip(r.stdout, 200) });
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  fx.setNet({ mode: 'deny' }, { expectBearer: SECRETS.accessToken });
  let out = await run();
  eq([out.guard, out.deny, out.connect, out.loopback, out.quota], ['guardedFetch', 'fetch failed/ECONNREFUSED', 'ECONNREFUSED', 'loopback-ok', null], 'guard in deny mode');
  fx.setNet({ mode: 'snapshot', body: { primary_window: { used_percent: 42, resets_at: 1893456000 } } }, { expectBearer: SECRETS.accessToken });
  out = await run();
  eq([out.quota?.allowed, out.quota?.windows?.[0]?.label, out.quota?.windows?.[0]?.usedPercent], [true, 'primary', 42], "the adapter's own global fetch is answered by the guard (snapshot)");
  fx.setNet({ mode: 'http', status: 401, body: { error: 'unauthorized' } }, { expectBearer: SECRETS.accessToken });
  out = await run();
  eq(out.quota, null, 'an HTTP error from the usage endpoint resolves null');
  const log = fx.netLog();
  const usage = log.filter((x) => x.kind === 'fetch' && /chatgpt\.com/.test(x.url));
  check(usage.length === 3 && usage.every((x) => x.authorization === 'present' && x.bearerMatches === true), 'each adapter quota() call reached the guard with the planted bearer', usage);
  check(log.some((x) => x.kind === 'connect' && x.outcome === 'refused'), 'the refused socket was logged', log.map((x) => x.kind));
  check(!JSON.stringify(log).includes(SECRETS.accessToken), 'the guard never logs the bearer value', '(log contains the token)');
  return 'NODE_OPTIONS preload: global fetch is the guard; deny → "fetch failed", a non-loopback socket → ECONNREFUSED, loopback passes; the Codex adapter\'s quota() gets its snapshot / null from the guard and never leaves the machine';
}

async function s11() {
  const verdict = hermeticVerdict();
  check(verdict.violations.length === 0, 'with no fakes installed, nothing named codex / cursor-agent / agy / claude may be resolvable in a sandbox environment', verdict.violations);
  const decoyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-prov-decoy-')));
  try {
    fs.writeFileSync(path.join(decoyDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(decoyDir, 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const seen = inspectHermeticity({ extraPath: [decoyDir] });
    check(seen.violations.some((v) => v.includes(path.join(decoyDir, 'codex'))) && seen.violations.some((v) => v.includes(path.join(decoyDir, 'agy'))), 'the check reports a decoy `codex` and `agy` placed on the PATH', seen.violations);
    check(seen.violations.some((v) => v.includes('command -v codex')), 'the login-shell lookup is checked as well as the PATH', seen.violations);
  } finally {
    rmrf(decoyDir);
  }
  const sys = Object.entries(verdict.systemBinaries).filter(([, list]) => list.length > 0).map(([cli, list]) => `${cli}: ${list.join(', ')}`);
  return `clean on this machine; a decoy on the PATH is reported through both the PATH walk and the login-shell lookup${sys.length > 0 ? `; NOTE real binaries at fixed system locations (${sys.join('; ')}) — "CLI not installed" cases will refuse to run` : '; no vendor binary at /opt/homebrew/bin or /usr/local/bin'}`;
}

async function s12(t) {
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  fx.assertHermetic();
  const r = await runFile(fx.loginShell, ['-lc', 'command -v codex; command -v cursor-agent; command -v agy'], { env: fx.env(), cwd: fx.workspace });
  eq(r.stdout.trim().split('\n'), [fx.launcher('codex'), fx.launcher('cursor-agent'), fx.launcher('agy')], 'the sandbox login shell resolves each CLI to its launcher');
  fx.removeCli('codex');
  fx.assertHermetic();
  const r2 = await runFile(fx.loginShell, ['-lc', 'command -v codex'], { env: fx.env(), cwd: fx.workspace });
  eq([r2.stdout.trim(), r2.code], ['', 1], 'with the launcher removed, `codex` resolves to nothing');
  // the Claude fake of the mesh2 harness starts through `#!/usr/bin/env node` on the sandbox PATH
  fx.setClaudeScenario({});
  const v = await runFile(FAKE_CLAUDE2, ['--version'], { env: fx.env(), cwd: fx.workspace });
  check(v.code === 0 && /2\.1\.283/.test(v.stdout), 'fake-claude2 runs under the sandbox environment', { code: v.code, stdout: v.stdout, stderr: clip(v.stderr, 200) });
  const env = fx.env();
  check(!Object.keys(env).some((k) => /^(CLAUDE|ANTHROPIC|OPENAI|CODEX|AGY|CURSOR|GEMINI|GOOGLE|HTTPS?_PROXY)/i.test(k)), "none of the caller's vendor or proxy variables is in the sandbox environment", Object.keys(env));
  return 'bare names resolve to the sandbox launchers only; a removed launcher resolves to nothing; fake-claude2 starts through the sandbox PATH; the environment is an allow-list';
}

async function s13() {
  const providers = fs.readFileSync(path.join(REPO_ROOT, 'src', 'providers.ts'), 'utf8');
  const platform = fs.readFileSync(path.join(REPO_ROOT, 'src', 'platform.ts'), 'utf8');
  const missing = [];
  const need = (source, name, snippet) => {
    if (!source.includes(snippet)) {
      missing.push(`${name}: ${snippet}`);
    }
  };
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const block = providers.slice(providers.indexOf(`  ${id}: {`), providers.indexOf('},', providers.indexOf(`  ${id}: {`)));
    need(block, id, `label: '${p.label}'`);
    need(block, id, `cli: '${p.cli}'`);
    need(block, id, `homeEnv: ${p.homeEnv === null ? 'null' : `'${p.homeEnv}'`}`);
    need(block, id, `isolation: '${p.isolation}'`);
    need(block, id, `defaultPermissionMode: ${p.defaultPermissionMode === null ? 'null' : `'${p.defaultPermissionMode}'`}`);
    if (p.permissionModes) {
      need(block, id, `permissionModes: [${p.permissionModes.map((m) => `'${m}'`).join(', ')}]`);
      need(block, id, `suggestedModels: ['${p.firstSuggestedModel}'`);
    }
    need(providers, id, `path.join(home, '${p.defaultHome}')`);
  }
  need(providers, 'aliases', "v === 'antigravity' || v === 'agy' ? 'gemini'");
  need(providers, 'model hint', "`${/^[aeiou]/i.test(INFO[id].label) ? 'an' : 'a'} ${INFO[id].label} model id such as ${INFO[id].suggestedModels[0]}`");
  need(platform, 'model forms hint', MODEL_FORMS_HINT);
  const list = /export const SESSION_IDENTITY_ENV = \[([\s\S]*?)\] as const;/.exec(platform);
  const names = list ? [...list[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]) : [];
  eq(names, SESSION_IDENTITY_ENV, 'SESSION_IDENTITY_ENV as restated in helpers.mjs');
  // The classifier is `isQuotaError`; which module under src/mcp owns it is not our business.
  const mcpDir = path.join(REPO_ROOT, 'src', 'mcp');
  const mcpSources = fs.readdirSync(mcpDir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(mcpDir, f), 'utf8')).join('\n');
  need(mcpSources, 'quota classifier', `/${QUOTA_CLASSIFIER.source}/i`);
  check(missing.length === 0, 'every provider fact restated in helpers.mjs is still what the frozen sources say', missing);
  return 'provider labels, CLI names, home variables, default homes, permission modes, the model hint, the alias rule, SESSION_IDENTITY_ENV and the quota classifier all match src/providers.ts, src/platform.ts and src/mcp';
}

async function s99() {
  const { lateKilled, remaining } = await settleStrays({ timeoutMs: 4000 });
  const left = leftoverSandboxes();
  check(remaining.length === 0 && left.length === 0, 'nothing may be left behind by the cases above', { processes: remaining, sandboxes: left });
  return `no fake process left running, no sandbox left on disk${lateKilled > 0 ? ` (${lateKilled} late process(es) killed in the sweep)` : ''}`;
}

/* S14 — the keychain guard is live in a child started with the sandbox environment. */
async function s14(t) {
  const fx = t.fixture();
  const r = keychainGuard.selfCheck(fx.env());
  check(r.ok, 'a child spawn of /usr/bin/security refused (ENOENT) and logged with its first argument only', r.line);
  return r.line;
}

const CASES = [
  { id: 'S1', name: 'the fakes refuse to run outside a sandbox', run: s1 },
  { id: 'S2', name: 'codex: argv, environment and result through CodexAdapter', run: s2 },
  { id: 'S3', name: 'codex: every answer scenario as the adapter reads it', run: s3 },
  { id: 'S4', name: 'codex: hang, SIGTERM-ignoring hang, grandchild in the process group', run: s4 },
  { id: 'S5', name: 'huge: more than 8 MiB really is written', run: s5 },
  { id: 'S6', name: 'codex: auth.json fixture states and quota() through the seams', run: s6 },
  { id: 'S7', name: 'cursor-agent: status, models, run and failures through CursorAdapter', run: s7 },
  { id: 'S8', name: 'agy: models, run and failures through GeminiAdapter', run: s8 },
  { id: 'S9', name: 'fake texts against the server quota classifier', run: s9 },
  { id: 'S10', name: 'network guard: fetch stub and refused sockets', run: s10 },
  { id: 'S11', name: 'hermeticity check: clean here, and it can see a decoy', run: s11 },
  { id: 'S12', name: 'sandbox name resolution and environment', run: s12 },
  { id: 'S13', name: 'restated constants still match the frozen sources', run: s13 },
  { id: 'S14', name: 'keychain guard: a sandbox child cannot run security', run: s14 },
  { id: 'S99', name: 'nothing left behind', run: s99 },
];

export async function runSelfTest({ only = [] } = {}) {
  const unknown = only.filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length > 0) {
    console.error(`Unknown self-test case(s): ${unknown.join(', ')}. Known: ${CASES.map((c) => c.id).join(' ')}.`);
    return { pass: 0, fail: unknown.length };
  }
  const selected = only.length > 0 ? CASES.filter((c) => only.includes(c.id) || c.id === 'S99') : CASES;
  console.log(`providers self-test — ${selected.length} case(s), no server involved`);
  let adaptersMemo;
  let pass = 0;
  let fail = 0;
  for (const c of selected) {
    const fixtures = [];
    const t = {
      fixture(opts = {}) {
        const fx = makeFixture({ label: c.id, ...opts });
        fixtures.push(fx);
        return fx;
      },
      async adapters() {
        if (!adaptersMemo) {
          adaptersMemo = await loadAdapters();
          const versions = Object.entries(adaptersMemo.versions).map(([k, v]) => `${k}@${v}`).join(', ');
          console.log(`       adapters under test: ${versions}`);
        }
        return adaptersMemo;
      },
    };
    const started = Date.now();
    try {
      const observed = await c.run(t);
      pass++;
      console.log(`PASS — ${c.id} ${c.name}: ${observed}  [${((Date.now() - started) / 1000).toFixed(1)} s]`);
    } catch (err) {
      fail++;
      const message = err instanceof Mismatch ? err.message : `expected the case to run to completion; observed ${err && err.stack ? err.stack : err}`;
      console.log(`FAIL — ${c.id} ${c.name}: ${message}  [${((Date.now() - started) / 1000).toFixed(1)} s]`);
      for (const fx of fixtures) {
        const anomalies = fx.anomalies();
        if (anomalies.length > 0) {
          console.log(`       fake anomalies: ${anomalies.map((a) => `${a.vendor ?? '?'}:${a.kind}`).join(', ')}`);
        }
      }
    } finally {
      for (const fx of fixtures) {
        await fx.cleanup();
      }
    }
  }
  await cleanupAll();
  console.log('');
  console.log(`self-test tally: ${pass} passed, ${fail} failed`);
  return { pass, fail };
}
