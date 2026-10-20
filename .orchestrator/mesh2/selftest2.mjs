// selftest2.mjs — proves the HARNESS, not the server: it drives fake-claude2.mjs directly
// (no MCP server, no compiled output) and asserts the files and processes each emulated
// command produces. `node probe2.mjs --selftest` runs it.
//
// A probe in probe2.mjs is only evidence about the server if the fake behaves the way
// contract §P says the real CLI behaves; this file is where that is checked. It passes on its
// own, whatever state `src/` or `out/` is in.

import keychainGuard from '../fixes/keychain-guard.cjs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  FAKE_CLAUDE2,
  ONESHOT_MARKER,
  SESSION_WORKER_SETTINGS_JSON,
  TOKEN_TEMPLATE_STAND_IN,
  VENDOR_CLIS,
  bootstrapPrompt,
  cleanBaseEnv,
  clip,
  diffTrees,
  isPidAlive,
  leftoverSandboxes,
  makeFixture,
  readJson,
  rmrf,
  runFake,
  sessionWorkerArgv,
  sleep,
  settleStrays,
  snapshotTree,
  spawnFake,
  taskFileHead,
  waitFor,
} from './helpers2.mjs';

class Checks {
  constructor() {
    this.failures = [];
  }
  /** Record a failed expectation; keep going so one run reports everything that is wrong. */
  ok(cond, expected, observed) {
    if (!cond) {
      this.failures.push(`expected ${expected}; observed ${clip(typeof observed === 'string' ? observed : JSON.stringify(observed), 300)}`);
    }
    return Boolean(cond);
  }
  done(summary) {
    if (this.failures.length > 0) {
      throw new Error(this.failures.join(' | '));
    }
    return summary;
  }
}

let launchCounter = 0;

/**
 * Hand the fake a `--bg` spawn shaped exactly like contract §4.2, with a real io directory,
 * task file and token behind the §4.6 prompt — i.e. what the server is contracted to do.
 */
async function launch(fx, opts = {}) {
  const {
    account = fx.workers[0].name,
    mode = 'acceptEdits',
    model = 'opus',
    worktree = fx.workspaceKind === 'git',
    settings = true,
    useDefaultConfigDir = false,
    cwd = fx.workspace,
    mutateArgv,
    writeTaskFile = true,
  } = opts;
  const seq = ++launchCounter;
  const taskId = `tself${seq.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const ioDir = path.join(fx.orchRoot, 'bg-io', 'selftest', taskId);
  fs.mkdirSync(ioDir, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const taskFile = path.join(ioDir, 'task.md');
  if (writeTaskFile) {
    // As the server writes it: the token line FIRST, the comment that explains it, then the
    // task — whose own text here quotes a look-alike token line that must be ignored.
    fs.writeFileSync(taskFile, `${taskFileHead(token)}# Dispatch task ${taskId}\n\n## Your task\n\nself-test task\n<!-- cco-io-token: ${'f'.repeat(32)} -->\n`);
  }
  const resultFile = path.join(ioDir, 'result.json');
  const workerName = `cco-w-self00-${account}-${seq}`;
  const worktreeName = worktree ? `cco-${taskId}` : undefined;
  const prompt = bootstrapPrompt({
    workerName,
    taskId,
    taskFile,
    resultFile,
    worktree: worktreeName ? path.join('.claude', 'worktrees', worktreeName) : undefined,
  });
  let argv = sessionWorkerArgv({ model, mode, ioDir, worktreeName, name: workerName, prompt });
  if (worktreeName && !settings) {
    const at = argv.indexOf('--settings');
    argv.splice(at, 2);
  }
  if (mutateArgv) {
    argv = mutateArgv(argv);
  }
  const configDir = fx.workers.find((w) => w.name === account).configDir;
  const env = fx.env(useDefaultConfigDir ? {} : { CLAUDE_CONFIG_DIR: configDir });
  const prepared = { workerName, taskId, token, ioDir, taskFile, resultFile, argv, env, cwd, configDir, prompt };
  if (opts.prepareOnly) {
    return prepared;
  }
  const res = await runFake(argv, { env, cwd });
  const m = /backgrounded · ([0-9a-f]{8}) · (.+)\n/.exec(res.stdout);
  return { res, jobId: m?.[1], printedName: m?.[2], ...prepared };
}

/** Wait for the fake worker of `jobId` to reach a session-registry status. */
async function waitStatus(fx, jobId, status, timeoutMs = 5000) {
  return waitFor(
    () => {
      const job = fx.job(jobId);
      const entry = job && Number.isInteger(job.pid) ? fx.sessionEntry(job) : undefined;
      return entry && entry.status === status ? { job, entry } : undefined;
    },
    { timeoutMs, label: `fake worker ${jobId} to reach status ${status}` },
  );
}

const cases = [];
const selfCase = (id, name, run) => cases.push({ id, name, run });

/* ------------------------------------------------------------------------- */

selfCase('S1', '--version', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain' });
  const a = await runFake(['--version'], { env: fx.env(), cwd: fx.workspace });
  c.ok(a.code === 0 && a.stdout === '2.1.283 (Claude Code)\n', 'exit 0 and "2.1.283 (Claude Code)"', a);
  fx.setScenario({ version: '2.1.200 (Claude Code)' });
  const b = await runFake(['--version'], { env: fx.env(), cwd: fx.workspace });
  c.ok(b.code === 0 && b.stdout === '2.1.200 (Claude Code)\n', 'the scenario version text', b);
  fx.setScenario({ versionExitCode: 3 });
  const d = await runFake(['--version'], { env: fx.env(), cwd: fx.workspace });
  c.ok(d.code === 3 && d.stdout === '', 'exit 3 and no stdout when the scenario fails --version', d);
  const logged = fx.invocations('version');
  c.ok(logged.length === 3 && logged.every((r) => r.configDirSource === 'default' && r.configDir === fx.defaultConfigDir), 'three logged invocations resolved to $HOME/.claude', logged.map((r) => [r.configDirSource, r.configDir]));
  return c.done(`default "${a.stdout.trim()}", override "${b.stdout.trim()}", forced failure exit ${d.code}; ${logged.length} invocations logged`);
});

selfCase('S2', 'sandbox guard', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain' });
  const noScenario = await runFake(['--version'], { env: fx.env({ FAKE_CLAUDE2_SCENARIO: null }), cwd: fx.workspace });
  c.ok(noScenario.code === 97 && noScenario.stdout === '', 'exit 97 with no scenario variable', noScenario);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-mesh2-outside-')));
  try {
    const res = await runFake(['agents', '--json'], { env: fx.env({ CLAUDE_CONFIG_DIR: outside }), cwd: fx.workspace });
    c.ok(res.code === 97, 'exit 97 for a config dir outside the sandbox', res);
    c.ok(fs.readdirSync(outside).length === 0, 'nothing written into the outside directory', fs.readdirSync(outside));
    const home = await runFake(['agents', '--json'], { env: fx.env({ HOME: outside }), cwd: fx.workspace });
    c.ok(home.code === 97, 'exit 97 when HOME (the default config dir) is outside the sandbox', home);
    c.ok(fs.readdirSync(outside).length === 0, 'nothing written under the outside HOME', fs.readdirSync(outside));
  } finally {
    rmrf(outside);
  }
  c.ok(fx.log().some((r) => r.kind === 'sandbox-violation'), 'the violation recorded in the sandbox log', fx.log().map((r) => r.kind));
  return c.done('exit 97 without a scenario, and for a config dir or HOME outside the sandbox; nothing written outside');
});

selfCase('S3', 'config-dir resolution (P1)', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', workers: [{ name: 'wa' }, { name: 'wd', configDir: 'default' }], scenario: { bg: { default: 'never' } } });
  const explicit = await launch(fx, { account: 'wa' });
  const implicit = await launch(fx, { account: 'wd', useDefaultConfigDir: true });
  c.ok(explicit.res.code === 0 && implicit.res.code === 0, 'both spawns to exit 0', [explicit.res, implicit.res]);
  const [recA, recD] = fx.bgSpawns();
  c.ok(recA.configDirSource === 'env' && recA.configDir === explicit.configDir, 'CLAUDE_CONFIG_DIR honoured verbatim', recA && [recA.configDirSource, recA.configDir]);
  c.ok(recD.configDirSource === 'default' && recD.configDir === path.join(fx.home, '.claude') && !('CLAUDE_CONFIG_DIR' in recD.env), 'unset → $HOME/.claude', recD && [recD.configDirSource, recD.configDir]);
  const jobA = fx.job(explicit.jobId);
  const jobD = fx.job(implicit.jobId);
  await waitStatus(fx, explicit.jobId, 'busy');
  await waitStatus(fx, implicit.jobId, 'busy');
  c.ok(fs.existsSync(path.join(explicit.configDir, 'sessions', `${jobA.pid}.json`)), 'the entry under the explicit dir', jobA.pid);
  c.ok(fs.existsSync(path.join(fx.home, '.claude', 'sessions', `${jobD.pid}.json`)), 'the entry under $HOME/.claude', jobD.pid);
  c.ok(!fs.existsSync(path.join(fx.home, '.claude.json')) && !fs.existsSync(path.join(explicit.configDir, '.claude.json')), 'the fake never to create a .claude.json', 'one exists');
  return c.done(`set → ${path.relative(fx.root, recA.configDir)} (env); unset → ${path.relative(fx.root, recD.configDir)} (default); no .claude.json written`);
});

selfCase('S4', '--bg result-done', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'result-done' } } });
  const w = await launch(fx);
  c.ok(w.res.code === 0, 'exit 0', w.res);
  c.ok(/^backgrounded · [0-9a-f]{8} · \S+\n$/.test(w.res.stdout) && w.printedName === w.workerName, 'stdout "backgrounded · <8 hex> · <name>"', w.res.stdout);
  c.ok(w.res.stderr.includes('Starting background service'), 'the service banner on stderr for the first session', w.res.stderr);
  const job = fx.job(w.jobId);
  c.ok(job && isPidAlive(job.pid) && job.pid !== w.res.pid, 'a live helper that is not the launcher', job && job.pid);
  const { entry } = await waitStatus(fx, w.jobId, 'idle');
  for (const [k, v] of Object.entries({ pid: job.pid, jobId: w.jobId, name: w.workerName, kind: 'bg', peerProtocol: 1, version: '2.1.283', cwd: fx.workspace })) {
    c.ok(entry[k] === v, `session entry ${k} = ${v}`, entry[k]);
  }
  c.ok(typeof entry.sessionId === 'string' && entry.sessionId.startsWith(w.jobId), 'jobId = first 8 hex of sessionId', entry.sessionId);
  c.ok(typeof entry.messagingSocketPath === 'string' && typeof entry.updatedAt === 'number', 'messagingSocketPath and updatedAt', entry);
  const result = readJson(w.resultFile);
  c.ok(result && result.taskId === w.taskId && result.status === 'done' && result.token === w.token && /FAKE2_REPORT done/.test(result.report), "a valid done result carrying the token from the task file's first line", result);
  c.ok(isPidAlive(job.pid), 'the worker still alive after reporting (parked)', job.pid);
  const info = fx.job(w.jobId).promptInfo;
  c.ok(info.from.resultFile === 'prompt' && info.from.taskId === 'prompt-json' && info.from.taskFile === 'prompt', 'the task file, the result path and the task id all parsed from the prompt', info.from);
  c.ok(info.from.token === 'task-file-line-1' && info.taskFileToken === w.token && info.taskFileOtherTokenLines === 1, 'the token read off the FIRST line of the task file, a look-alike line further down ignored', info);
  // LOUD: the prompt is an argv element. If it ever carries the token again, this fails.
  c.ok(info.promptCarriesToken === false && !w.prompt.includes(w.token) && w.argv.every((a) => !a.includes(w.token)), 'NO argv element of the spawn — the bootstrap prompt included — contains the token', { promptCarriesToken: info.promptCarriesToken, argvWithToken: w.argv.map((a, i) => (a.includes(w.token) ? i : null)).filter((i) => i !== null) });
  c.ok(info.promptTokenTemplate === TOKEN_TEMPLATE_STAND_IN && !/^[0-9a-f]{16,}$/.test(info.promptTokenTemplate), 'the prompt shows a stand-in where the token goes, not something token-shaped', info.promptTokenTemplate);
  c.ok(info.resultInAddDir === true && info.taskFileReadable === true, 'the result path inside --add-dir and the task file readable', info);
  const rec = fx.bgSpawns()[0];
  c.ok(JSON.stringify(rec.argv) === JSON.stringify(w.argv), 'argv logged verbatim', rec.argv.slice(0, 8));
  c.ok(rec.env.CLAUDE_CONFIG_DIR === w.configDir && rec.env.HOME === fx.home, 'environment logged', [rec.env.CLAUDE_CONFIG_DIR, rec.env.HOME]);
  c.ok(rec.exitCode === 0 && rec.parsed.swallowedIntoAllowedTools.length === 0 && rec.parsed.positionals === 1, 'one positional prompt, nothing swallowed', rec.parsed.positionals);
  const transcripts = fs.readdirSync(path.join(w.configDir, 'projects')).flatMap((d) => fs.readdirSync(path.join(w.configDir, 'projects', d)));
  c.ok(transcripts.includes(`${entry.sessionId}.jsonl`), 'a transcript named <sessionId>.jsonl', transcripts);
  return c.done(`job ${w.jobId}, helper pid ${job.pid} alive and idle; result.json {status:"done", token ok}; entry fields per P11`);
});

selfCase('S5', '--bg result-error', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'result-error' } } });
  const w = await launch(fx);
  await waitStatus(fx, w.jobId, 'idle');
  const result = readJson(w.resultFile);
  c.ok(result && result.status === 'error' && result.token === w.token && result.taskId === w.taskId, 'an error result with the right token', result);
  // The protocol's branch for an unreadable task file: no task and no token, so NO result file —
  // the worker says what it could not read and ends its turn (never a guessed task).
  fx.setScenario({ bg: { default: 'result-done' } });
  const blind = await launch(fx, { writeTaskFile: false });
  await waitStatus(fx, blind.jobId, 'idle');
  const blindJob = fx.job(blind.jobId);
  c.ok(!fs.existsSync(blind.resultFile), 'NO result file when the task file is missing (a result needs the token from it)', readJson(blind.resultFile));
  c.ok(blindJob.promptInfo.taskFileReadable === false && blindJob.promptInfo.token === undefined && blindJob.history.some((h) => h.event === 'no-result'), 'the worker to have found no task file and no token, and to have said so', blindJob.history);
  return c.done('result-error writes {status:"error"}; with a missing task file the worker writes no result file and ends its turn');
});

selfCase('S6', '--bg park-no-result / park-waiting / never', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: ['park-no-result', { kind: 'park-waiting', waitingFor: 'selftest approval' }, 'never'] } } });
  const idle = await launch(fx);
  const waiting = await launch(fx);
  const never = await launch(fx);
  const a = await waitStatus(fx, idle.jobId, 'idle');
  const b = await waitStatus(fx, waiting.jobId, 'waiting');
  c.ok(a.entry.waitingFor === undefined, 'no waitingFor on an idle entry', a.entry.waitingFor);
  c.ok(b.entry.waitingFor === 'selftest approval', 'waitingFor on the waiting entry', b.entry.waitingFor);
  await sleep(700);
  const n = fx.sessionEntry(fx.job(never.jobId));
  c.ok(n && n.status === 'busy', 'the `never` worker still busy', n && n.status);
  for (const w of [idle, waiting, never]) {
    c.ok(!fs.existsSync(w.resultFile), `no result file for ${w.jobId}`, 'a result file exists');
    c.ok(isPidAlive(fx.job(w.jobId).pid), `worker ${w.jobId} alive`, 'dead');
  }
  c.ok(typeof fx.job(idle.jobId).parkedAt === 'number', 'the park time recorded for probes', fx.job(idle.jobId).parkedAt);
  return c.done('idle (no waitingFor), waiting (waitingFor "selftest approval"), never (busy after 700 ms); no result files; all three alive');
});

selfCase('S7', '--bg wrong-token and the rejected-result extras', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: ['wrong-token', 'wrong-task-id', 'not-json', 'oversize', 'placeholder-token', 'header-line-token', 'no-token', 'symlink-result'] } } });
  const tok = await launch(fx);
  const tid = await launch(fx);
  const nj = await launch(fx);
  const big = await launch(fx);
  const ph = await launch(fx);
  const hl = await launch(fx);
  const nt = await launch(fx);
  const sl = await launch(fx);
  for (const w of [tok, tid, nj, big, ph, hl, nt, sl]) {
    await waitStatus(fx, w.jobId, 'idle');
  }
  // A well-formed result with the right token, reachable only through a link at the result path.
  const linked = fs.lstatSync(sl.resultFile).isSymbolicLink() ? readJson(fs.readlinkSync(sl.resultFile)) : undefined;
  c.ok(linked && linked.taskId === sl.taskId && linked.status === 'done' && linked.token === sl.token, 'symlink-result: the result path is a symbolic link to a well-formed result carrying the right token', linked ?? fs.lstatSync(sl.resultFile).isSymbolicLink());
  // The three ways of getting the token wrong without altering it.
  const r5 = readJson(ph.resultFile);
  c.ok(r5 && r5.taskId === ph.taskId && r5.token === TOKEN_TEMPLATE_STAND_IN, "placeholder-token: the stand-in of the prompt's JSON template as the token", r5);
  const r6 = readJson(hl.resultFile);
  c.ok(r6 && r6.token === `<!-- cco-io-token: ${hl.token} -->`, "header-line-token: the whole first line of the task file as the token", r6);
  const r7 = readJson(nt.resultFile);
  c.ok(r7 && r7.taskId === nt.taskId && r7.status === 'done' && !('token' in r7), 'no-token: a result with no token member', r7);
  const r1 = readJson(tok.resultFile);
  c.ok(r1 && r1.taskId === tok.taskId && r1.status === 'done' && r1.token !== tok.token && r1.token.length === tok.token.length, 'a well-formed result whose token is altered', r1);
  const r2 = readJson(tid.resultFile);
  c.ok(r2 && r2.token === tid.token && r2.taskId !== tid.taskId, 'the right token with another task id', r2);
  c.ok(readJson(nj.resultFile) === undefined && fs.statSync(nj.resultFile).size > 0, 'a non-empty result that is not JSON', 'parsed');
  c.ok(fs.statSync(big.resultFile).size > 262_144, 'a result larger than the 262144-byte read cap', fs.statSync(big.resultFile).size);
  return c.done(`wrong-token (token ${r1.token.slice(0, 6)}… ≠ ${tok.token.slice(0, 6)}…), wrong-task-id, not-json, oversize (${fs.statSync(big.resultFile).size} bytes), placeholder-token, header-line-token, no-token, symlink-result`);
});

selfCase('S8', '--bg die', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: [{ kind: 'die', dieAfterMs: 1200 }, { kind: 'die', dieAfterMs: 1200, dieLeavesEntry: false }] } } });
  const crash = await launch(fx);
  const pidCrash = fx.job(crash.jobId).pid;
  c.ok(isPidAlive(pidCrash), 'the first worker alive right after its spawn', pidCrash);
  const tidy = await launch(fx);
  const pidTidy = fx.job(tidy.jobId).pid;
  c.ok(isPidAlive(pidTidy), 'the second worker alive right after its spawn', pidTidy);
  c.ok(fx.sessionEntry(fx.job(tidy.jobId))?.status === 'busy', 'a die worker to be busy while it lives', fx.sessionEntry(fx.job(tidy.jobId)));
  await waitFor(() => !isPidAlive(pidCrash) && !isPidAlive(pidTidy), { timeoutMs: 5000, label: 'the die workers to exit' });
  c.ok(!fs.existsSync(crash.resultFile) && !fs.existsSync(tidy.resultFile), 'no result file from a worker that died', 'a result file exists');
  const stale = readJson(path.join(crash.configDir, 'sessions', `${pidCrash}.json`));
  c.ok(stale && stale.pid === pidCrash && stale.jobId === crash.jobId, 'the crashed worker to leave its entry behind (dead pid)', stale);
  c.ok(!fs.existsSync(path.join(tidy.configDir, 'sessions', `${pidTidy}.json`)), 'dieLeavesEntry:false to remove the entry', 'entry still there');
  c.ok(fx.job(crash.jobId).crashed === true, 'the job marked crashed', fx.job(crash.jobId).exit);
  return c.done(`both helpers exited without a result; the crash left sessions/${pidCrash}.json (dead pid), the tidy exit removed its entry`);
});

selfCase('S9', '--bg refusals: untrusted, bypass, unknown model (P5, P9, P13)', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'untrusted' } } });
  const u = await launch(fx);
  c.ok(u.res.code === 1 && u.res.stdout === '', 'exit 1 with no stdout', u.res);
  c.ok(u.res.stderr === `Workspace not trusted. Run \`claude\` in ${fx.workspace} once and accept the trust prompt, then retry.\n`, 'the P9 message naming the workspace', u.res.stderr);
  c.ok(fx.jobs().length === 0 && !fs.existsSync(path.join(u.configDir, 'sessions')), 'no job and no session entry', fx.jobs().length);

  fx.setScenario({ bg: { default: 'bypass-refused' } });
  const b = await launch(fx, { mode: 'bypassPermissions' });
  c.ok(b.res.code === 1 && b.res.stderr.startsWith('--bg with bypassPermissions requires accepting the disclaimer first'), 'the P5 refusal', b.res);
  const ok = await launch(fx, { mode: 'acceptEdits' });
  c.ok(ok.res.code === 0 && ok.jobId, 'the same scenario to start a worker in acceptEdits', ok.res);
  await waitStatus(fx, ok.jobId, 'idle');
  c.ok(readJson(ok.resultFile)?.status === 'done', 'that worker to report done', readJson(ok.resultFile));

  fx.setScenario({ bg: { default: 'result-done' }, bypassDisclaimerAccepted: true });
  const accepted = await launch(fx, { mode: 'bypassPermissions' });
  c.ok(accepted.res.code === 0, 'bypass to start once the scenario says the disclaimer was accepted', accepted.res);

  fx.setScenario({ bg: { default: 'result-done' } });
  const model = await launch(fx, { model: 'gpt-4' });
  c.ok(model.res.code === 1 && /unknown model/.test(model.res.stderr), 'exit 1 for an unknown model', model.res);
  for (const good of ['OPUS', 'claude-opus-4-8', 'claude-fable-5-1', 'haiku']) {
    const g = await launch(fx, { model: good });
    c.ok(g.res.code === 0, `model ${good} accepted`, g.res);
  }

  // Trust enforced from the account's own .claude.json, read from where the CLI keeps it.
  fx.setScenario({ bg: { default: 'never' }, enforceTrust: true });
  const before = await launch(fx);
  c.ok(before.res.code === 1 && before.res.stderr.startsWith('Workspace not trusted.'), 'enforceTrust to refuse an untrusted workspace', before.res);
  fs.writeFileSync(path.join(before.configDir, '.claude.json'), JSON.stringify({ projects: { [fx.workspace]: { hasTrustDialogAccepted: true } } }));
  const after = await launch(fx);
  c.ok(after.res.code === 0, 'enforceTrust to accept once <configDir>/.claude.json trusts the root', after.res);
  return c.done('untrusted → exit 1 + P9 text; bypassPermissions → exit 1 + P5 text (acceptEdits and an accepted disclaimer start); gpt-4 → exit 1; trust read from <configDir>/.claude.json');
});

selfCase('S10', '--bg -w worktree and --settings (P6)', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'git', scenario: { bg: { default: 'never' } } });
  const head = await launch(fx, { worktree: true, settings: true });
  const fresh = await launch(fx, { worktree: true, settings: false });
  c.ok(head.res.code === 0 && fresh.res.code === 0, 'both worktree spawns to exit 0', [head.res, fresh.res]);
  const jh = fx.job(head.jobId);
  const jf = fx.job(fresh.jobId);
  const wtPath = path.join(fx.workspace, '.claude', 'worktrees', `cco-${head.taskId}`);
  c.ok(jh.worktree && jh.worktree.path === wtPath && fs.existsSync(path.join(wtPath, 'README.md')), 'a real worktree at .claude/worktrees/<name>', jh.worktree);
  c.ok(jh.worktree.branch === `worktree-cco-${head.taskId}` && jh.worktree.baseRefRequested === 'head', 'branch worktree-<name>, baseRef head when --settings says so', jh.worktree);
  c.ok(jf.worktree.baseRefRequested === 'fresh', 'baseRef "fresh" (remote default branch) without --settings', jf.worktree);
  const { entry } = await waitStatus(fx, head.jobId, 'busy');
  c.ok(entry.cwd === wtPath, 'the session entry cwd to be the worktree', entry.cwd);
  const rec = fx.bgSpawns()[0];
  c.ok(rec.parsed.settingsRaw === SESSION_WORKER_SETTINGS_JSON && rec.parsed.worktreeName === `cco-${head.taskId}`, 'the settings JSON and worktree name parsed', rec.parsed);

  const plain = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'never' } } });
  const refused = await launch(plain, { worktree: true });
  c.ok(refused.res.code === 1 && /requires a git repository/.test(refused.res.stderr), '-w outside a repository to exit 1', refused.res);
  return c.done(`worktree ${path.relative(fx.workspace, wtPath)} on ${jh.worktree.branch} from HEAD; without --settings the base is "fresh"; -w outside a repo exits 1`);
});

selfCase('S11', '--allowedTools swallows a directly following prompt (P8)', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'result-done' } } });
  // Move `--name <n>` in front of --allowedTools, so the prompt follows the tool list directly.
  const w = await launch(fx, {
    mutateArgv: (argv) => {
      const at = argv.indexOf('--name');
      const pair = argv.splice(at, 2);
      argv.splice(argv.indexOf('--allowedTools'), 0, ...pair);
      return argv;
    },
  });
  c.ok(w.res.code === 0 && w.jobId, 'the spawn itself to succeed', w.res);
  const rec = fx.bgSpawns()[0];
  c.ok(rec.parsed.positionals === 0 && rec.parsed.swallowedIntoAllowedTools.length === 1, 'the prompt swallowed into the tool list', rec.parsed.positionals);
  await waitStatus(fx, w.jobId, 'idle');
  await sleep(400);
  c.ok(!fs.existsSync(w.resultFile), 'a promptless session to write no result', 'a result file exists');
  c.ok(fx.job(w.jobId).history.some((h) => h.event === 'started-without-prompt'), 'the job to record that it started without a prompt', fx.job(w.jobId).history.map((h) => h.event));
  return c.done('prompt placed right after --allowedTools → 0 positionals, session idle with no prompt, no result file');
});

selfCase('S12', 'agents --json [--all], stop', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: ['never', 'park-no-result', { kind: 'die', dieAfterMs: 200 }] } } });
  const busy = await launch(fx);
  const idle = await launch(fx);
  const dead = await launch(fx);
  await waitStatus(fx, idle.jobId, 'idle');
  const deadPid = fx.job(dead.jobId).pid;
  await waitFor(() => !isPidAlive(deadPid), { timeoutMs: 4000, label: 'the die worker to exit' });
  const env = fx.env({ CLAUDE_CONFIG_DIR: busy.configDir });
  const list = async (...extra) => {
    const res = await runFake(['agents', '--json', ...extra], { env, cwd: fx.workspace });
    return { res, rows: JSON.parse(res.stdout) };
  };
  const first = await list();
  const row = (rows, id) => rows.find((r) => r.id === id);
  const rb = row(first.rows, busy.jobId);
  const ri = row(first.rows, idle.jobId);
  const rd = row(first.rows, dead.jobId);
  c.ok(first.res.code === 0 && Array.isArray(first.rows), 'a JSON array', first.res.stdout);
  c.ok(rb && rb.kind === 'background' && rb.pid === fx.job(busy.jobId).pid && rb.status === 'busy' && rb.sessionId.startsWith(rb.id), 'a live busy row with pid and status', rb);
  c.ok(ri && ri.pid === fx.job(idle.jobId).pid && ri.status === 'idle', 'a live idle row with pid and status', ri);
  c.ok(rd && rd.pid === undefined && rd.status === undefined && rd.state === 'working', 'a crashed session listed with its persisted state and NO pid', rd);
  for (const k of ['id', 'sessionId', 'cwd', 'kind', 'startedAt', 'name', 'state']) {
    c.ok(rb && rb[k] !== undefined, `row field ${k}`, rb);
  }

  const stop = await runFake(['stop', idle.jobId], { env, cwd: fx.workspace });
  c.ok(stop.code === 0, 'stop to exit 0', stop);
  c.ok(!isPidAlive(fx.job(idle.jobId).pid), 'the stopped helper dead', fx.job(idle.jobId).pid);
  c.ok(!fs.existsSync(path.join(idle.configDir, 'sessions', `${fx.job(idle.jobId).pid}.json`)), 'its session entry removed', 'still there');
  const again = await runFake(['stop', idle.jobId], { env, cwd: fx.workspace });
  c.ok(again.code === 0, 'a second stop of the same id to exit 0', again);
  const unknown = await runFake(['stop', 'deadbeef'], { env, cwd: fx.workspace });
  c.ok(unknown.code === 1, 'stop of an unknown id to exit 1', unknown);
  // The same id under ANOTHER account's config dir does not exist there.
  const otherAccount = await runFake(['stop', busy.jobId], { env: fx.env({ CLAUDE_CONFIG_DIR: fx.workers[1].configDir }), cwd: fx.workspace });
  c.ok(otherAccount.code === 1 && isPidAlive(fx.job(busy.jobId).pid), 'stop under the wrong account to find nothing and kill nothing', otherAccount);

  const second = await list();
  c.ok(!row(second.rows, idle.jobId), 'a stopped session absent without --all', row(second.rows, idle.jobId));
  const all = await list('--all');
  const stopped = row(all.rows, idle.jobId);
  c.ok(stopped && stopped.state === 'done' && stopped.pid === undefined && stopped.status === undefined, 'the stopped row only with --all, state done, no pid/status', stopped);
  return c.done(`live rows carry pid+status (busy/idle), the crashed row carries neither; stop → exit 0 and helper dead; stopped row only with --all (state "done")`);
});

selfCase('S13', 'rm: removed / kept (P7)', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'git', scenario: { bg: { default: 'park-no-result' } } });
  const clean = await launch(fx);
  const dirty = await launch(fx);
  const committed = await launch(fx);
  for (const w of [clean, dirty, committed]) {
    await waitStatus(fx, w.jobId, 'idle');
  }
  const env = fx.env({ CLAUDE_CONFIG_DIR: clean.configDir });
  const wt = (w) => fx.job(w.jobId).worktree;
  fs.writeFileSync(path.join(wt(dirty).path, 'uncommitted.txt'), 'work in progress\n');
  fs.writeFileSync(path.join(wt(committed).path, 'committed.txt'), 'finished work\n');
  const gitEnv = cleanBaseEnv();
  const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: gitEnv });
  g(wt(committed).path, 'add', '-A');
  g(wt(committed).path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'work');

  const cleanPath = wt(clean).path;
  const cleanBranch = wt(clean).branch;
  const r1 = await runFake(['rm', clean.jobId], { env, cwd: fx.workspace });
  c.ok(r1.code === 0 && r1.stdout === `removed ${clean.jobId}\n`, '"removed <id>" exit 0 for a clean worktree', r1);
  c.ok(!fs.existsSync(cleanPath) && g(fx.workspace, 'rev-parse', '--verify', '--quiet', cleanBranch).status !== 0, 'the clean worktree and its branch gone', 'still there');
  c.ok(fx.job(clean.jobId)?.removed === true && !isPidAlive(fx.job(clean.jobId).pid), 'the job removed and its helper stopped', fx.job(clean.jobId));

  const r2 = await runFake(['rm', dirty.jobId], { env, cwd: fx.workspace });
  c.ok(r2.code === 1 && r2.stdout.startsWith(`kept ${dirty.jobId} — its worktree is still at ${wt(dirty).path}`), '"kept <id> — its worktree is still at …" exit 1 for uncommitted changes', r2);
  c.ok(fs.existsSync(path.join(wt(dirty).path, 'uncommitted.txt')), 'the uncommitted work untouched', 'gone');
  const r2b = await runFake(['rm', dirty.jobId], { env, cwd: fx.workspace });
  c.ok(r2b.code === 1 && r2b.stdout.startsWith('kept '), 'kept again on a second rm ("every time")', r2b);

  const r3 = await runFake(['rm', committed.jobId], { env, cwd: fx.workspace });
  c.ok(r3.code === 1 && r3.stdout.startsWith(`kept ${committed.jobId}`) && /unpushed/.test(r3.stdout), 'kept for unpushed commits', r3);

  fx.setScenario({ bg: { default: 'park-no-result' }, rm: 'kept' });
  const forcedKept = await launch(fx);
  const r4 = await runFake(['rm', forcedKept.jobId], { env, cwd: fx.workspace });
  c.ok(r4.code === 1 && r4.stdout.startsWith(`kept ${forcedKept.jobId}`), 'rm:"kept" to force the kept outcome', r4);
  fx.setScenario({ bg: { default: 'park-no-result' }, rm: 'removed' });
  const r5 = await runFake(['rm', dirty.jobId], { env, cwd: fx.workspace });
  c.ok(r5.code === 0 && r5.stdout === `removed ${dirty.jobId}\n`, 'rm:"removed" to force removal', r5);
  const r6 = await runFake(['rm', 'deadbeef'], { env, cwd: fx.workspace });
  c.ok(r6.code === 1, 'rm of an unknown id to exit 1', r6);
  return c.done('clean → "removed <id>" exit 0 (worktree + branch gone); uncommitted and unpushed → "kept <id> — its worktree is still at …" exit 1, repeatably; scenario can force either');
});

selfCase('S14', 'one-shot, auth status, usage probe', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain' });
  const env = fx.env({ CLAUDE_CONFIG_DIR: fx.workers[0].configDir });
  const oneShotArgs = ['-p', '--output-format', 'json', '--model', 'opus', '--permission-mode', 'acceptEdits', '--append-system-prompt', 'system text --bg --version stop'];
  const one = await runFake(oneShotArgs, { env, cwd: fx.workspace, input: 'do the thing' });
  const parsed = JSON.parse(one.stdout);
  c.ok(one.code === 0 && parsed.result.startsWith(ONESHOT_MARKER) && parsed.result.includes('model=opus') && parsed.result.includes('account=wa'), 'a success JSON naming model and account', one.stdout);
  c.ok(parsed.usage.input_tokens === 11 && parsed.usage.output_tokens === 22 && parsed.total_cost_usd === 0.001, 'fixed usage numbers', parsed);
  c.ok(fx.invocations('oneshot').length === 1 && fx.bgSpawns().length === 0, 'option VALUES that look like commands not to be mistaken for commands', fx.log().map((r) => r.kind));

  fx.setScenario({ oneShot: { byAccount: { wa: { mode: 'quota' } } } });
  const quota = await runFake(oneShotArgs, { env, cwd: fx.workspace, input: 'x' });
  c.ok(JSON.parse(quota.stdout).is_error === true, 'a quota error JSON for the configured account', quota.stdout);
  const other = await runFake(oneShotArgs, { env: fx.env({ CLAUDE_CONFIG_DIR: fx.workers[1].configDir }), cwd: fx.workspace, input: 'x' });
  c.ok(JSON.parse(other.stdout).result.includes('account=wb'), 'the other account unaffected', other.stdout);
  fx.setScenario({ oneShot: { mode: 'fail' } });
  const fail = await runFake(oneShotArgs, { env, cwd: fx.workspace, input: 'x' });
  c.ok(fail.code === 3 && fail.stdout === '', 'exit 3 for mode fail', fail);

  fx.setScenario({});
  const auth = await runFake(['auth', 'status', '--json'], { env, cwd: fx.workspace });
  c.ok(auth.code === 0 && JSON.parse(auth.stdout).loggedIn === true, 'loggedIn:true', auth.stdout);
  fx.setScenario({ auth: { loggedIn: false } });
  const out = await runFake(['auth', 'status', '--json'], { env, cwd: fx.workspace });
  c.ok(out.code === 1 && JSON.parse(out.stdout).loggedIn === false, 'loggedIn:false with exit 1', out);

  fx.setScenario({ usage: { fiveHour: 42, sevenDay: 7 } });
  const probe = spawnFake(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, cwd: os.tmpdir() });
  let buf = '';
  probe.stdout.on('data', (d) => (buf += d));
  const exited = new Promise((resolve) => probe.on('exit', (code, signal) => resolve({ code, signal })));
  probe.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'u1', request: { subtype: 'get_usage' } }) + '\n');
  await waitFor(() => buf.includes('\n'), { timeoutMs: 20_000, label: 'the control_response' });
  const msg = JSON.parse(buf.split('\n')[0]);
  c.ok(msg.type === 'control_response' && msg.response.subtype === 'success' && msg.response.request_id === 'u1', 'a control_response echoing the request id', msg);
  const data = msg.response.response;
  c.ok(data.rate_limits_available === true && data.rate_limits.five_hour.utilization === 42 && data.rate_limits.seven_day.utilization === 7 && typeof data.rate_limits.five_hour.resets_at === 'string' && data.subscription_type === 'max', 'the P15 payload', data);
  c.ok(probe.exitCode === null, 'the probe session to stay up until its stdin ends', probe.exitCode);
  probe.stdin.end();
  const end = await exited;
  c.ok(end.code === 0, 'exit 0 when stdin ends (no SIGKILL needed)', end);
  const termed = spawnFake(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, cwd: os.tmpdir() });
  const termExit = new Promise((resolve) => termed.on('exit', (code, signal) => resolve({ code, signal })));
  // Signal it only once it has ANSWERED a request: the fake installs its SIGTERM handler before
  // it starts reading, so an answer proves the handler is there. A fixed pause instead measures
  // how fast a process starts — on a loaded machine the signal then lands on a process that is
  // still booting, which dies by the default action (signal SIGTERM, no exit code).
  let termBuf = '';
  termed.stdout.on('data', (d) => (termBuf += d));
  termed.stdin.on('error', () => {});
  termed.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'u2', request: { subtype: 'get_usage' } }) + '\n');
  await waitFor(() => termBuf.includes('\n'), { timeoutMs: 20_000, label: 'the second probe session to answer before it is signalled' });
  termed.kill('SIGTERM');
  const te = await termExit;
  c.ok(te.code === 143, 'exit 143 on SIGTERM', te);
  return c.done('one-shot success/quota/fail; auth loggedIn true (exit 0) and false (exit 1); usage probe answers get_usage and exits 0 on stdin EOF, 143 on SIGTERM');
});

selfCase('S15', 'scenario selection, live control channel, unsupported argv', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: ['never'], byAccount: { wb: 'park-waiting' }, default: 'park-no-result' } } });
  const first = await launch(fx, { account: 'wb' }); // sequence slot 0 beats byAccount
  const second = await launch(fx, { account: 'wb' }); // byAccount
  const third = await launch(fx, { account: 'wa' }); // default
  const kinds = fx.bgSpawns().map((r) => `${r.seq}:${r.scenario}`);
  c.ok(kinds.join(',') === '0:never,1:park-waiting,2:park-no-result', 'sequence → byAccount → default', kinds);
  await waitStatus(fx, second.jobId, 'waiting');
  await waitStatus(fx, third.jobId, 'idle');

  // A live `never` worker is told to finish.
  c.ok(!fs.existsSync(first.resultFile), 'no result before the command', 'exists');
  fx.command(first.jobId, 'result-done');
  await waitStatus(fx, first.jobId, 'idle');
  c.ok(readJson(first.resultFile)?.status === 'done' && readJson(first.resultFile)?.token === first.token, 'a valid result after the command', readJson(first.resultFile));
  // A parked worker is told to start another turn, then to park again.
  fx.command(third.jobId, 'busy');
  await waitStatus(fx, third.jobId, 'busy');
  fx.command(third.jobId, { kind: 'park-waiting', waitingFor: 'second thoughts' });
  const again = await waitStatus(fx, third.jobId, 'waiting');
  c.ok(again.entry.waitingFor === 'second thoughts', 'the commanded waitingFor', again.entry.waitingFor);

  const odd = await runFake(['mcp', 'list'], { env: fx.env(), cwd: fx.workspace });
  c.ok(odd.code === 2 && fx.anomalies().some((r) => r.kind === 'unsupported'), 'an unsupported invocation to exit 2 and be logged as an anomaly', odd);
  return c.done('sequence beats byAccount beats default; a live `never` worker finishes on command; a parked one goes busy and parks again; unsupported argv exits 2 and is logged');
});

selfCase('S16', 'no helper outlives its sandbox', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'never' } } });
  const a = await launch(fx);
  const b = await launch(fx, { account: 'wb' });
  const pids = [fx.job(a.jobId).pid, fx.job(b.jobId).pid];
  c.ok(pids.every(isPidAlive), 'two live helpers', pids);
  await fx.cleanup();
  c.ok(pids.every((p) => !isPidAlive(p)), 'both helpers dead after fixture cleanup', pids.filter(isPidAlive));
  c.ok(!fs.existsSync(fx.root), 'the sandbox removed', fx.root);

  // A helper whose sandbox vanishes WITHOUT cleanup (a SIGKILLed harness) ends itself.
  const orphan = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'never' } } });
  const o = await launch(orphan);
  const orphanPid = orphan.job(o.jobId).pid;
  rmrf(orphan.root);
  await waitFor(() => !isPidAlive(orphanPid), { timeoutMs: 5000, label: 'the orphaned helper to notice its sandbox is gone' });
  c.ok(!isPidAlive(orphanPid), 'the orphaned helper to exit by itself', orphanPid);
  return c.done(`helpers ${pids.join(', ')} killed by cleanup; helper ${orphanPid} exited by itself when its sandbox was removed`);
});

selfCase('S17', 'holdPipes reproduces P16; entryDelayMs delays the registry entry', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { sequence: [{ kind: 'never', holdPipes: true }, { kind: 'never', entryDelayMs: 1200 }] } } });
  // Raw spawn: runFake() deliberately settles on 'exit', which is the very thing under test.
  const p = await launch(fx, { prepareOnly: true });
  const child = spawnFake(p.argv, { env: p.env, cwd: p.cwd });
  let out = '';
  let exitAt;
  let closeAt;
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', () => {});
  child.on('exit', () => (exitAt = Date.now()));
  child.on('close', () => (closeAt = Date.now()));
  child.stdin.end();
  await waitFor(() => exitAt !== undefined, { timeoutMs: 10_000, label: 'the --bg launcher to exit' });
  const jobId = /backgrounded · ([0-9a-f]{8}) · /.exec(out)?.[1];
  c.ok(jobId !== undefined, 'the backgrounded line before the launcher exits', out);
  await sleep(700);
  c.ok(closeAt === undefined, "NO 'close' 700 ms after 'exit' while the session holds the pipes", closeAt === undefined ? '' : `close ${closeAt - exitAt} ms after exit`);
  const stop = await runFake(['stop', jobId], { env: p.env, cwd: p.cwd });
  c.ok(stop.code === 0, 'stop to exit 0', stop);
  await waitFor(() => closeAt !== undefined, { timeoutMs: 5000, label: "'close' once the session is stopped" }).catch(() => undefined);
  c.ok(closeAt !== undefined, "'close' only once the session is gone", 'never closed');

  const late = await launch(fx);
  const job = fx.job(late.jobId);
  c.ok(late.res.code === 0 && isPidAlive(job.pid), '--bg to return with a live helper', late.res);
  c.ok(fx.sessionEntry(job) === undefined, 'NO registry entry yet when --bg returns (entryDelayMs)', fx.sessionEntry(job));
  const { entry } = await waitStatus(fx, late.jobId, 'busy', 6000);
  c.ok(entry.updatedAt - job.startedAt >= 1000, 'the entry to appear only after the delay', `${entry.updatedAt - job.startedAt} ms`);
  return c.done(`with holdPipes the launcher exits but its pipes stay open until the session is stopped (close ${closeAt - exitAt} ms after exit); with entryDelayMs the entry appears ${entry.updatedAt - job.startedAt} ms after the spawn`);
});

selfCase('S18', 'a late fake process cannot re-create a removed sandbox', async (t) => {
  const c = new Checks();
  // The server fires `claude stop` DETACHED at session end, so one can start while the
  // harness is deleting the sandbox. Reproduce the worst case: the scenario is still readable
  // (kept outside the root here), the root itself is already gone.
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'never' } } });
  const w = await launch(fx);
  const configDir = w.configDir;
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-mesh2-late-')));
  try {
    const scenarioCopy = path.join(outside, 'scenario.json');
    fs.copyFileSync(fx.scenarioFile, scenarioCopy);
    await fx.cleanup();
    c.ok(!fs.existsSync(fx.root), 'the sandbox removed by cleanup', fx.root);
    const env = { ...cleanBaseEnv(), HOME: fx.home, FAKE_CLAUDE2_SCENARIO: scenarioCopy, CLAUDE_CONFIG_DIR: configDir };
    for (const args of [['stop', w.jobId], ['rm', w.jobId], ['agents', '--json'], w.argv, ['--version']]) {
      const res = await runFake(args, { env, cwd: outside });
      c.ok(!fs.existsSync(fx.root), `no sandbox re-created by a late \`${args[0]}\``, `exit ${res.code}; ${fx.root} exists again`);
      c.ok(res.code !== null && !res.timedOut, `a late \`${args[0]}\` to exit by itself`, res);
    }
    c.ok(fs.readdirSync(outside).length === 1, 'nothing written next to the scenario copy either', fs.readdirSync(outside));
  } finally {
    rmrf(outside);
  }
  return c.done('stop, rm, agents, --bg and --version started after the sandbox was removed all exit without putting it back');
});

selfCase('S19', 'vendor fixture: registered, seeded, and hermetic for the three vendor CLIs', async (t) => {
  const c = new Checks();
  const fx = t.fixture({
    workspace: 'plain',
    workers: [{ name: 'wa' }],
    vendors: [
      { name: 'cx', provider: 'codex' },
      { name: 'cu', provider: 'cursor' },
    ],
    registryOrder: ['cx', 'wa', 'cu'],
  });
  const reg = readJson(path.join(fx.orchRoot, 'registry.json'));
  c.ok(JSON.stringify(reg.workers.map((w) => [w.name, w.provider ?? 'claude'])) === JSON.stringify([['cx', 'codex'], ['wa', 'claude'], ['cu', 'cursor']]), 'registry.json to list cx (codex), wa (no provider field), cu (cursor), in that order', reg.workers);
  c.ok(fx.workers.length === 1 && fx.workers[0].name === 'wa' && fx.vendors.length === 2, '`workers` to hold the Claude account only and `vendors` the other two', { workers: fx.workers.map((w) => w.name), vendors: fx.vendors.map((v) => v.name) });
  const codex = fx.vendors[0].configDir;
  const cursor = fx.vendors[1].configDir;
  c.ok(codex === path.join(fx.home, '.codex') && cursor === path.join(fx.home, '.cursor'), "each vendor account in that vendor's default home under the sandbox HOME", [codex, cursor]);
  for (const dir of [codex, cursor]) {
    const sessions = path.join(dir, 'sessions');
    c.ok(fs.existsSync(sessions) && fs.readdirSync(sessions).length > 0, `${path.basename(dir)}/sessions/ to exist with files in it`, fs.existsSync(sessions) ? fs.readdirSync(sessions) : 'absent');
    const creds = [...snapshotTree(dir).keys()].filter((rel) => /auth\.json|credential|token/i.test(rel));
    c.ok(creds.length === 0, `no credential file in ${path.basename(dir)}`, creds);
  }
  const usage = readJson(path.join(fx.orchRoot, 'usage.json'));
  c.ok(usage[codex]?.available === true && usage[cursor]?.available === true && usage[fx.workers[0].configDir]?.available === true, 'a healthy-looking usage reading for every account, vendor ones included', Object.keys(usage ?? {}));

  // The three CLI names resolve to the stubs — through the lookup the server performs.
  const env = fx.env();
  c.ok(env.PATH.split(':')[0] === path.join(fx.root, 'bin') && !/homebrew|\.npm|nvm|\/usr\/local/.test(env.PATH), 'PATH to be the sandbox bin plus the system directories only', env.PATH);
  c.ok(env.SHELL === path.join(fx.root, 'login-shell') && !('CODEX_HOME' in env) && !('OPENAI_API_KEY' in env) && /net-guard\.cjs/.test(env.NODE_OPTIONS ?? ''), 'SHELL to be the sandbox login shell, no vendor variables, the network guard preloaded', { SHELL: env.SHELL, NODE_OPTIONS: env.NODE_OPTIONS });
  let refused = '';
  try {
    fx.assertHermetic();
  } catch (e) {
    refused = e.message;
  }
  c.ok(refused === '', 'assertHermetic() to pass', refused);
  const before = new Map(fx.vendors.map((v) => [v.name, snapshotTree(v.configDir)]));
  for (const cli of VENDOR_CLIS) {
    const found = spawnSync(env.SHELL, ['-lc', `command -v ${cli}`], { encoding: 'utf8', env });
    c.ok(String(found.stdout).trim() === path.join(fx.root, 'bin', cli), `\`$SHELL -lc "command -v ${cli}"\` to print the stub`, String(found.stdout).trim() || `exit ${found.status}`);
    const run = spawnSync(String(found.stdout).trim(), ['login', 'status'], { encoding: 'utf8', env, cwd: fx.workspace });
    c.ok(run.status === 97, `the ${cli} stub to refuse with exit 97`, run.status);
  }
  c.ok(JSON.stringify(fx.vendorCliLog()) === JSON.stringify(VENDOR_CLIS.map((cli) => `${cli} login status`)), 'every stub call logged with its argv', fx.vendorCliLog());
  c.ok(fx.loginShellLog().length === VENDOR_CLIS.length + 1, 'every login-shell lookup logged (one per CLI, plus the one assertHermetic made)', fx.loginShellLog());
  const changed = fx.vendors.flatMap((v) => diffTrees(before.get(v.name), snapshotTree(v.configDir)));
  c.ok(changed.length === 0, 'a stub to write nothing into a vendor home', changed);
  // A broken sandbox must refuse to start anything rather than fall through to a real binary.
  fs.unlinkSync(path.join(fx.root, 'bin', 'codex'));
  let stopped = '';
  try {
    fx.assertHermetic();
  } catch (e) {
    stopped = e.message;
  }
  c.ok(/REFUSED TO RUN/.test(stopped) && /codex/.test(stopped), 'assertHermetic() to REFUSE once a stub is missing', stopped || 'it passed');
  let started = 'no error';
  try {
    await fx.startServer();
  } catch (e) {
    started = e.message;
  }
  c.ok(/REFUSED TO RUN/.test(started) && fx.servers.length === 0, 'startServer() to refuse too, before starting any process', { started, servers: fx.servers.length });

  // The fake `claude` still runs under that environment (its shebang finds the sandbox `node`).
  const v = await runFake(['--version'], { env, cwd: fx.workspace });
  c.ok(v.code === 0 && v.stdout === '2.1.283 (Claude Code)\n', 'the fake claude to run under the hermetic environment', v);

  // A fixture without vendors is unchanged: the caller's PATH, and nothing to assert.
  const plain = t.fixture({ workspace: 'plain' });
  c.ok(plain.vendors.length === 0 && plain.env().PATH === cleanBaseEnv().PATH && !fs.existsSync(path.join(plain.root, 'bin')), 'a fixture with no vendor account to keep the ordinary environment (no bin/, no PATH change)', { PATH: plain.env().PATH });
  plain.assertHermetic();
  c.ok(fs.existsSync(plain.hostSessionsDir), 'the host account to have a sessions/ directory by default', plain.hostSessionsDir);
  const bare = t.fixture({ workspace: 'plain', hostSessions: false });
  c.ok(!fs.existsSync(bare.hostSessionsDir) && fs.existsSync(bare.defaultConfigDir), '`hostSessions: false` to leave it absent', bare.hostSessionsDir);
  return c.done(`registry [cx codex, wa claude, cu cursor]; ${VENDOR_CLIS.join(', ')} resolve to stubs that exit 97 and write nothing; a missing stub makes the fixture refuse to start; host sessions/ present by default`);
});

selfCase('S20', 'snapshotTree / diffTrees see every kind of change; a bait process is ours to kill', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', workers: [{ name: 'wa' }], vendors: [{ name: 'cx', provider: 'codex' }] });
  const dir = fx.vendors[0].configDir;
  const file = path.join(dir, 'config.toml');
  const base = snapshotTree(dir);
  c.ok(base.has('.') && base.has('sessions') && base.has('config.toml'), 'the listing to cover the directory itself, its subdirectories and its files', [...base.keys()]);
  // Reading is not a change.
  fs.readFileSync(file);
  fs.readdirSync(path.join(dir, 'sessions'));
  c.ok(diffTrees(base, snapshotTree(dir)).length === 0, 'no difference after reading a file and listing a directory', diffTrees(base, snapshotTree(dir)));
  const expectChange = (label, act, want) => {
    const before = snapshotTree(dir);
    act();
    const diff = diffTrees(before, snapshotTree(dir));
    c.ok(diff.some((line) => want.test(line)), `${label} to show up as ${want}`, diff);
  };
  expectChange('a new file', () => fs.writeFileSync(path.join(dir, '.claude.json'), '{}'), /^ADDED \.claude\.json/);
  expectChange('a new directory', () => fs.mkdirSync(path.join(dir, 'backups')), /^ADDED backups/);
  expectChange('a byte-identical rewrite', () => fs.writeFileSync(file, fs.readFileSync(file)), /^CHANGED config\.toml/);
  expectChange('a same-size edit', () => {
    const bytes = fs.readFileSync(file);
    bytes[0] = bytes[0] === 0x6d ? 0x4d : 0x6d;
    const st = fs.statSync(file);
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, st.atime, st.mtime);
  }, /^CHANGED config\.toml/);
  expectChange('a removed file', () => fs.unlinkSync(path.join(dir, '.claude.json')), /^REMOVED \.claude\.json/);
  expectChange('a file created and removed again (a lock, a tmp-then-rename)', () => {
    const lock = path.join(dir, 'sessions', 'x.cco.lock');
    fs.writeFileSync(lock, '');
    fs.unlinkSync(lock);
  }, /^CHANGED sessions: dir mtime=/);

  const kept = fx.spawnBait();
  const killed = fx.spawnBait();
  c.ok(isPidAlive(kept) && isPidAlive(killed) && fx.baitAlive(kept) && kept !== process.pid && killed !== process.pid, 'two live bait processes, neither of them this process', [kept, killed, process.pid]);
  process.kill(killed, 'SIGKILL');
  await waitFor(() => !fx.baitAlive(killed), { timeoutMs: 5000, label: 'the killed bait to be reported dead' }).catch(() => undefined);
  c.ok(!fx.baitAlive(killed) && fx.baitAlive(kept), 'baitAlive() to tell a killed bait from a living one', { killed: fx.baitAlive(killed), kept: fx.baitAlive(kept) });
  c.ok(fx.baitAlive(process.pid) === false, 'baitAlive() to be false for a pid that is not a bait', fx.baitAlive(process.pid));
  await fx.cleanup();
  await waitFor(() => !isPidAlive(kept), { timeoutMs: 5000, label: 'cleanup to kill the remaining bait' }).catch(() => undefined);
  c.ok(!isPidAlive(kept), 'cleanup to kill the bait that was left', `pid ${kept} still alive`);
  return c.done('added / removed / rewritten / same-size-edited files and a create-then-delete inside a directory are all reported, reads are not; cleanup kills a bait process');
});

selfCase('S21', 'the `impostor` command: a live helper that stops looking like the CLI', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain', scenario: { bg: { default: 'never' } } });
  const w = await launch(fx);
  await waitStatus(fx, w.jobId, 'busy');
  const pid = fx.job(w.jobId).pid;
  const argsOf = () => String(spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
  const before = argsOf();
  c.ok(before.includes('fake-claude2.mjs') && before.includes('__worker'), 'the helper to be recognisable by its command line before the command', before);
  const entryBefore = fx.sessionEntry(fx.job(w.jobId));
  fx.command(w.jobId, { kind: 'impostor' });
  await waitFor(() => fx.job(w.jobId).history.some((h) => h.event === 'impostor'), { timeoutMs: 5000, label: 'the helper to take the impostor command' });
  const after = argsOf();
  c.ok(after !== '' && !after.includes('fake-claude2') && !/(^|[\s/])claude([\s/.]|$)/.test(after), 'the process table to show a command line that names neither the fake nor `claude`', after);
  const entryAfter = fx.sessionEntry(fx.job(w.jobId));
  c.ok(isPidAlive(pid) && entryAfter && entryAfter.pid === pid && entryAfter.status === 'busy' && entryAfter.jobId === entryBefore.jobId, 'the same pid, alive, with its session entry untouched', entryAfter);
  // Cleanup cannot recognise it by command line any more; it still must not outlive its sandbox.
  await fx.cleanup();
  await waitFor(() => !isPidAlive(pid), { timeoutMs: 5000, label: 'the impostor helper to exit once its sandbox is gone' }).catch(() => undefined);
  c.ok(!isPidAlive(pid), 'the helper to be gone after its sandbox was removed (it ends itself when its job file disappears)', pid);
  return c.done(`helper ${pid}: "${clip(before, 40)}…" → "${clip(after, 40)}"; entry unchanged; gone after cleanup`);
});

selfCase('S22', 'a bait whose command line names the CLI', async (t) => {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'plain' });
  const plain = fx.spawnBait();
  const cli = fx.spawnBait({ asCli: true });
  const argsOf = (pid) => String(spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
  await waitFor(() => argsOf(cli).includes('__bait'), { timeoutMs: 5000, label: 'the CLI-named bait to be running' });
  const names = (line) => /(^|[\s/])claude([\s/.]|$)/.test(line);
  const cliLine = argsOf(cli);
  c.ok(names(cliLine) && !cliLine.includes('fake-claude2'), 'its command line to name `claude` (through the link) and not the fake', cliLine);
  c.ok(!names(argsOf(plain)), 'the plain bait not to name the CLI', argsOf(plain));
  await sleep(600);
  c.ok(fx.baitAlive(cli) && fx.baitAlive(plain), 'both baits alive (the CLI-named one stays up doing nothing)', [fx.baitAlive(cli), fx.baitAlive(plain)]);
  c.ok(fx.jobs().length === 0 && fx.bgSpawns().length === 0, 'no job and no --bg invocation: it is nobody\'s worker', { jobs: fx.jobs().length, bg: fx.bgSpawns().length });
  await fx.cleanup();
  await waitFor(() => !isPidAlive(cli) && !isPidAlive(plain), { timeoutMs: 5000, label: 'the baits to be gone after cleanup' }).catch(() => undefined);
  c.ok(!isPidAlive(cli) && !isPidAlive(plain), 'both baits gone after fixture cleanup', [isPidAlive(cli), isPidAlive(plain)]);
  return c.done(`CLI-named bait ${cli}: "…${cliLine.slice(-40)}"; plain bait ${plain}; both killed by cleanup`);
});

/* ------------------------------------------------------------------------- */

selfCase('S90', 'keychain guard: a fixture child cannot run security', async (t) => {
  const fx = t.fixture();
  const r = keychainGuard.selfCheck(fx.env());
  if (!r.ok) {
    throw new Error(`expected a child spawn of /usr/bin/security to be refused (ENOENT) and logged with its first argument only; observed: ${r.line}`);
  }
  return r.line;
});

/* ------------------------------------------------------------------------- */

export async function runSelfTest({ only = [] } = {}) {
  const selected = only.length > 0 ? cases.filter((k) => only.includes(k.id)) : cases;
  let pass = 0;
  let fail = 0;
  console.log(`mesh2 self-test — ${selected.length} case(s) against ${FAKE_CLAUDE2} (no server involved)`);
  for (const k of selected) {
    const fixtures = [];
    const t = {
      fixture(opts = {}) {
        const fx = makeFixture({ label: k.id, ...opts });
        fixtures.push(fx);
        return fx;
      },
    };
    try {
      const observed = await Promise.race([
        k.run(t),
        new Promise((_, reject) => setTimeout(() => reject(new Error('self-test case timed out after 60 s')), 60_000)),
      ]);
      pass++;
      console.log(`PASS — ${k.id} ${k.name}: ${observed}`);
    } catch (err) {
      fail++;
      console.log(`FAIL — ${k.id} ${k.name}: ${err && err.message ? err.message : err}`);
    } finally {
      for (const fx of fixtures) {
        await fx.cleanup();
      }
    }
  }
  const { remaining: strays } = await settleStrays();
  const leftovers = leftoverSandboxes();
  if (strays.length > 0 || leftovers.length > 0) {
    fail++;
    console.log(`FAIL — S99 cleanup: expected no stray process and no leftover sandbox; observed ${strays.length} process(es) ${JSON.stringify(strays)} and ${leftovers.length} director(ies) ${JSON.stringify(leftovers)}`);
  } else {
    pass++;
    console.log('PASS — S99 cleanup: no fake process left running and no sandbox left on disk');
  }
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  return { pass, fail };
}
