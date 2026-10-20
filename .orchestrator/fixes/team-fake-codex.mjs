#!/usr/bin/env node
// team-fake-codex.mjs — the stand-in `codex` of the team-mode harness (.orchestrator/fixes/team.mjs),
// installed by team-fakes.mjs as `<sandbox>/bin/codex`. Written from contract-team-mode-v2.md §3.2
// (the Codex column), the T0 amendments and team-probes.md — never from the adapters or the engine.
//
// Never the real CLI: no network, no login, no tokens. What it does per invocation:
//
//   --version                       `codex-cli 0.162.1`
//   login status                    `Logged in using ChatGPT` (exit 0), or `Not logged in` (exit 1)
//                                   when the harness wrote `out` for this CODEX_HOME's basename
//   app-server                      the model listing only: initialize → model/list (one model,
//                                   `gpt-fake-1`, the default); ends when stdin does
//   exec … / exec resume <thread> … A TEAM TURN:
//     · argv checked against §3.2 (record `start.problems`); an unknown option →
//       `error: unexpected argument '<x>' found`, exit 2 — and so is `--sandbox` on `exec resume`,
//       which the real CLI does not take ("resume takes NO --sandbox", TP KR)
//     · the `-c key=value` values are parsed as TOML (basic strings, arrays of them); a value that
//       does not parse is a problem (the real CLI would use it as a literal string)
//     · NO `-m` → the model is config.toml's `gpt-5.5`, which no longer exists → `Model metadata for
//       gpt-5.5 not found`, exit 1 (TP KR; D12: `-m` on EVERY turn) — on a first turn and a resume
//     · `exec resume` of an unknown thread → `thread/resume failed: no rollout found for thread id
//       <id>` on stderr, exit 1, before any event (RP-9)
//     · the MCP server of `-c mcp_servers.cco_team.command/args` is started with the FILTERED
//       environment Codex gives its MCP children (HOME LANG PATH TERM USER — RP-6: no
//       CCO_DISPATCHED_TASK, no CCO_TEAM_MEMBER); without
//       `-c mcp_servers.cco_team.default_tools_approval_mode="approve"` every tool call is refused
//       `MCP tool call requires approval, but approval policy is never` (TP MCP)
//     · the stream: `thread.started {thread_id}` FIRST, `turn.started`, `item.started` /
//       `item.completed` (agent_message, mcp_tool_call), `turn.completed {usage}`; a failure is
//       `error` + `turn.failed`, exit 1
//     · the session's sandbox is kept across resumes; `-c sandbox_mode="<m>"` overrides it;
//       `read-only` refuses file writes and shell commands
//     · SIGINT to its LEADER pid stops it within ~0.4 s, exit 1; a GROUP SIGINT is IGNORED — the
//       turn runs to its end (T0 A1: the real Codex finished `sleep 60` and the turn); SIGTERM
//       kills it by the signal
//
// Every invocation is logged (team-fakes.mjs "The log").

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';
import {
  codexFilteredEnv,
  emitLine,
  fakeRuntime,
  finish,
  guardPipes,
  memberOfCwd,
  parseTomlValue,
  runTurnFlow,
  SIGINT_EXIT,
  VENDOR_TEXT,
  VENDOR_VERSION,
} from './team-fakes.mjs';

guardPipes();
const rt = fakeRuntime('codex', import.meta.url);
const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const account = path.basename(home.replace(/[/\\]+$/, ''));
const CONFIG_DEFAULT_MODEL = 'gpt-5.5';
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

if (process.env.FAKE_STRAGGLER === '1') {
  rt.logStart('straggler', argv);
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === '--version') {
  rt.logStart('version', argv);
  process.stdout.write(`${VENDOR_VERSION.codex}\n`, () => process.exit(0));
} else if (argv[0] === 'login' && argv[1] === 'status') {
  rt.logStart('auth', argv, { account });
  const out = rt.authOut(account);
  process.stdout.write(out ? 'Not logged in\n' : 'Logged in using ChatGPT\n', () => process.exit(out ? 1 : 0));
} else if (argv[0] === 'app-server') {
  rt.logStart('app-server', argv, { account });
  appServer();
} else if (argv[0] === 'exec') {
  turn().catch((err) => {
    process.stderr.write(`codex fake: ${err?.stack ?? err}\n`);
    finish(rt, 'fake-error', 70);
  });
} else {
  rt.logStart('other', argv);
  process.stderr.write(`codex fake: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
}

function appServer() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return;
    const result =
      m.method === 'initialize'
        ? { userAgent: 'codex-fake/0.162.1', codexHome: home, platformFamily: 'unix', platformOs: process.platform }
        : m.method === 'model/list'
          ? { data: [{ id: 'gpt-fake-1', model: 'gpt-fake-1', displayName: 'GPT Fake 1', description: 'the harness model', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null }
          : {};
    process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

/** argv → {resumeId, flags, configs: Map(key → raw), positional, unknown, dashSeen}. */
function parse(args) {
  const out = { resumeId: undefined, flags: new Map(), configs: new Map(), configRaw: [], positional: [], unknown: [], dashSeen: false };
  let i = 1;
  if (args[1] === 'resume') {
    out.resumeId = args[2];
    i = 3;
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (out.dashSeen) {
      out.positional.push(a);
      continue;
    }
    if (a === '--') {
      out.dashSeen = true;
      continue;
    }
    if (a === '-c' || a === '--config') {
      const kv = String(args[++i] ?? '');
      const eq = kv.indexOf('=');
      out.configRaw.push(kv);
      if (eq > 0) out.configs.set(kv.slice(0, eq), kv.slice(eq + 1));
      continue;
    }
    if (a === '-m' || a === '--model') {
      out.flags.set('model', args[++i]);
      continue;
    }
    if (a === '-s' || a === '--sandbox') {
      if (out.resumeId !== undefined) {
        out.unknown.push(a);
        i++;
        continue;
      }
      out.flags.set('sandbox', args[++i]);
      continue;
    }
    if (a === '-p' || a === '--profile' || a === '-C' || a === '--cd') {
      out.flags.set(a, args[++i]);
      continue;
    }
    if (['--json', '--skip-git-repo-check', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--last'].includes(a)) {
      out.flags.set(a, true);
      continue;
    }
    if (a.startsWith('-')) {
      out.unknown.push(a);
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

/** Where this turn's argv departs from §3.2's Codex column. */
function shapeProblems(p) {
  const problems = [];
  const resumed = p.resumeId !== undefined;
  if (resumed && (typeof p.resumeId !== 'string' || p.resumeId === '' || p.resumeId.startsWith('-'))) problems.push(`exec resume without a thread id: ${p.resumeId}`);
  if (!p.flags.has('--json')) problems.push('no --json');
  if (!resumed && !p.flags.has('--skip-git-repo-check')) problems.push('no --skip-git-repo-check');
  if (!resumed && !SANDBOXES.includes(String(p.flags.get('sandbox')))) problems.push(`--sandbox is ${p.flags.get('sandbox')}`);
  if (typeof p.flags.get('model') !== 'string' || p.flags.get('model') === '') problems.push('no -m <model> (D12: on EVERY Codex turn)');
  if (resumed) {
    const sm = p.configs.get('sandbox_mode');
    const v = sm === undefined ? undefined : parseTomlValue(sm);
    if (!v || !v.ok || !SANDBOXES.includes(v.value)) problems.push(`no -c sandbox_mode="<m>" on the resume: ${sm}`);
  }
  const cmd = p.configs.get('mcp_servers.cco_team.command');
  const args = p.configs.get('mcp_servers.cco_team.args');
  const appr = p.configs.get('mcp_servers.cco_team.default_tools_approval_mode');
  const c = cmd === undefined ? undefined : parseTomlValue(cmd);
  const a = args === undefined ? undefined : parseTomlValue(args);
  const ap = appr === undefined ? undefined : parseTomlValue(appr);
  if (!c?.ok || typeof c.value !== 'string' || !path.isAbsolute(c.value)) problems.push(`-c mcp_servers.cco_team.command is not a TOML string naming an absolute path: ${cmd}`);
  if (!a?.ok || !Array.isArray(a.value) || a.value.length !== 3 || a.value[1] !== '--team-mcp' || !path.isAbsolute(String(a.value[0])) || !path.isAbsolute(String(a.value[2]))) {
    problems.push(`-c mcp_servers.cco_team.args is not ["<cli.js>","--team-mcp","<tool-spec>"]: ${args}`);
  }
  if (!ap?.ok || ap.value !== 'approve') problems.push(`-c mcp_servers.cco_team.default_tools_approval_mode is ${appr} (want "approve")`);
  if ([...p.configs.keys()].some((k) => k.startsWith('mcp_servers.cco_team.env'))) problems.push('an env table for the team server (§3.2: none is needed)');
  if (!p.dashSeen) problems.push('no -- before the prompt');
  if (p.positional.length !== 1) problems.push(`${p.positional.length} positional arguments (want exactly the prompt)`);
  if (p.dashSeen && argv[argv.length - 2] !== '--') problems.push('the prompt is not the one argument after --, last');
  return problems;
}

async function turn() {
  const p = parse(argv);
  const member = memberOfCwd(process.cwd());
  const problems = shapeProblems(p);
  rt.logStart('turn', argv, { account, problems, unknown: p.unknown, resumed: p.resumeId !== undefined, model: p.flags.get('model') ?? null });
  if (p.unknown.length > 0) {
    process.stderr.write(`error: unexpected argument '${p.unknown[0]}' found\n`);
    finish(rt, 'usage', 2);
    return;
  }
  const model = p.flags.get('model') ?? CONFIG_DEFAULT_MODEL;
  if (model === CONFIG_DEFAULT_MODEL) {
    process.stderr.write(`Error: ${VENDOR_TEXT.codex.noModel(CONFIG_DEFAULT_MODEL)}\n`);
    finish(rt, 'no-model', 1);
    return;
  }
  const prompt = rt.recordPrompt(p.positional[0] ?? '');
  const { turn: n, step } = rt.nextStep(member, prompt);
  rt.log({ ev: 'step', turn: n, step });
  let threadId;
  let sandbox = p.flags.get('sandbox');
  if (p.resumeId !== undefined) {
    const known = rt.convRead(p.resumeId);
    if (known === undefined) {
      rt.log({ ev: 'conversation', id: p.resumeId, resumed: true, found: false, refused: 'missing' });
      process.stderr.write(`${VENDOR_TEXT.codex.resumeMissing(p.resumeId)}\n`);
      finish(rt, 'resume-missing', 1);
      return;
    }
    sandbox = known.sandbox;
    const sm = p.configs.get('sandbox_mode');
    if (sm !== undefined && parseTomlValue(sm).ok) sandbox = parseTomlValue(sm).value;
    threadId = step.newConversation ? crypto.randomUUID() : p.resumeId;
  } else {
    threadId = crypto.randomUUID();
  }
  rt.convWrite(threadId, { model, sandbox: sandbox ?? 'read-only' });
  rt.log({ ev: 'conversation', id: threadId, resumed: p.resumeId !== undefined, expected: p.resumeId, found: true, ...(p.resumeId !== undefined && threadId !== p.resumeId ? { replaced: p.resumeId } : {}), sandbox });

  const servers = [];
  const cmd = p.configs.get('mcp_servers.cco_team.command');
  const args = p.configs.get('mcp_servers.cco_team.args');
  if (cmd !== undefined && args !== undefined) {
    const c = parseTomlValue(cmd);
    const a = parseTomlValue(args);
    servers.push({ name: 'cco_team', command: String(c.value), args: Array.isArray(a.value) ? a.value : [String(a.value)], env: codexFilteredEnv() });
  }
  const appr = p.configs.get('mcp_servers.cco_team.default_tools_approval_mode');
  const approved = appr !== undefined && parseTomlValue(appr).value === 'approve';
  const readOnly = sandbox === 'read-only';
  let item = 0;
  const started = Date.now();
  if (rt.authOut(account)) step.fail = step.fail ?? 'auth';
  await runTurnFlow(rt, {
    step,
    turn: n,
    member,
    mcpServers: servers,
    toolsBlocked: approved ? undefined : VENDOR_TEXT.codex.approval,
    readOnly,
    runsCommands: !readOnly,
    commandDeniedWhy: 'the read-only sandbox refuses commands',
    cliName: 'codex',
    stragglerArgs: ['exec', '--json', '--'],
    ignoreGroupSigint: true,
    sigintExit: SIGINT_EXIT.codex,
    vendorText: VENDOR_TEXT.codex,
    lines: {
      ids: async () => {
        await emitLine({ type: 'thread.started', thread_id: threadId });
        await emitLine({ type: 'turn.started' });
      },
      assistant: (text) => emitLine({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } }),
      progress: (i) => emitLine({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text: `progress ${i}` } }),
      toolUse: (tool, a) => emitLine({ type: 'item.started', item: { id: `item_${item}`, type: 'mcp_tool_call', server: 'cco_team', tool, arguments: a, status: 'in_progress' } }),
      toolResult: (tool, res) =>
        emitLine({
          type: 'item.completed',
          item: { id: `item_${item++}`, type: 'mcp_tool_call', server: 'cco_team', tool, status: res.isError ? 'failed' : 'completed', result: { content: [{ type: 'text', text: res.text }] }, ...(res.isError ? { error: { message: res.text } } : {}) },
        }),
      failure: async (fkind, text) => {
        await emitLine({ type: 'error', message: text });
        await emitLine({ type: 'turn.failed', error: { message: text } });
        process.stderr.write(`ERROR: ${text}\n`);
        return 1;
      },
      result: async (text, tokens) => {
        await emitLine({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } });
        await emitLine({ type: 'turn.completed', usage: { input_tokens: tokens.in, cached_input_tokens: 0, output_tokens: tokens.out }, duration_ms: Date.now() - started });
      },
    },
  });
}
