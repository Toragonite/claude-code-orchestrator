#!/usr/bin/env node
// team-fake-cursor.mjs — the stand-in `cursor-agent` of the team-mode harness
// (.orchestrator/fixes/team.mjs), installed by team-fakes.mjs as `<sandbox>/bin/cursor-agent`.
// Written from contract-team-mode-v2.md §3.2 (the Cursor column), the T0 amendments (A8) and
// team-probes.md — never from the adapters or the engine.
//
// Never the real CLI: no network, no login, no tokens. What it does per invocation:
//
//   --version                       `2026.10.14-0f9edde`
//   status                          `Logged in as fake@example.invalid` (exit 0), or `Not logged in`
//                                   (exit 1) after the harness wrote `out` for account `ambient`
//   models                          a two-line listing
//   create-chat                     prints a fresh chat id (a UUID) and records the empty chat
//   -p … --resume <chatId> … -- <prompt>   A TEAM TURN:
//     · argv checked against §3.2 (record `start.problems`); an unknown option →
//       `error: unknown option '<x>'`, exit 1
//     · `--resume` of a NON-UUID → `Persistent-session chat ID must be a UUID`, exit 1; of a
//       well-formed UUID the store does not hold → SILENTLY a new chat with a NEW id (RP-9): the
//       stream's session_id is the new one — only the engine's id comparison can notice (S4)
//     · with `--approve-mcps` the servers of `<cwd>/.cursor/mcp.json` are started (this process's
//       environment); without it none is (they would wait for an approval nobody gives)
//     · MCP calls go through without `--force` unless the step says `mcpReject` (A8 / RP-26: small
//       calls went through, a large one was rejected — inconsistent, so it is scripted)
//     · shell commands (a `runCco` step) run only with `--force` (A8)
//     · the stream: `system/init {session_id}` FIRST, `user`, `assistant` (with timestamp_ms),
//       `tool_call` started / completed, `result {session_id, usage{inputTokens,outputTokens}}`; a
//       failure is a `result` with is_error, exit 1
//   · every assistant MESSAGE goes out as cursor-agent sent it in the live run (stream-partial-output):
//     its fragments, each an `assistant` event with timestamp_ms, then the complete message once more
//     as one more such event; the successful `result` is the final message's text appended to every
//     earlier message of the turn with no separator (seen live: "…진행합니다.CODEWORD CHOSEN")
//     · SIGINT (leader or group) stops it within ~0.4 s, exit 130; SIGTERM kills it by the signal
//
// Every invocation is logged (team-fakes.mjs "The log").

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import {
  emitLine,
  fakeRuntime,
  finish,
  guardPipes,
  memberOfCwd,
  runTurnFlow,
  SIGINT_EXIT,
  UUID_ANY,
  VENDOR_TEXT,
  VENDOR_VERSION,
} from './team-fakes.mjs';

guardPipes();
const rt = fakeRuntime('cursor', import.meta.url);
const argv = process.argv.slice(2);
const account = 'ambient';

if (process.env.FAKE_STRAGGLER === '1') {
  rt.logStart('straggler', argv);
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === '--version' || argv[0] === '-v') {
  rt.logStart('version', argv);
  process.stdout.write(`${VENDOR_VERSION.cursor}\n`, () => process.exit(0));
} else if (argv[0] === 'status' || argv[0] === 'whoami') {
  rt.logStart('auth', argv, { account });
  const out = rt.authOut(account);
  process.stdout.write(out ? 'Not logged in\n' : 'Logged in as fake@example.invalid\n', () => process.exit(out ? 1 : 0));
} else if (argv[0] === 'models') {
  rt.logStart('models', argv);
  process.stdout.write('Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5\n', () => process.exit(0));
} else if (argv[0] === 'create-chat') {
  const id = crypto.randomUUID();
  rt.logStart('create-chat', argv, { chatId: id });
  rt.convWrite(id, { created: Date.now(), turns: 0 });
  process.stdout.write(`${id}\n`, () => process.exit(0));
} else if (argv.includes('-p') || argv.includes('--print')) {
  turn().catch((err) => {
    process.stderr.write(`cursor fake: ${err?.stack ?? err}\n`);
    finish(rt, 'fake-error', 70);
  });
} else {
  rt.logStart('other', argv);
  process.stderr.write(`cursor fake: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
}

/** argv → {flags, positional, unknown, dashSeen}. `--resume` takes an OPTIONAL value. */
function parse(args) {
  const out = { flags: new Map(), positional: [], unknown: [], dashSeen: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (out.dashSeen) {
      out.positional.push(a);
      continue;
    }
    if (a === '--') {
      out.dashSeen = true;
      continue;
    }
    if (a === '--resume') {
      out.flags.set(a, i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : true);
      continue;
    }
    if (['--output-format', '--model', '-m', '--sandbox', '--api-key', '--workspace'].includes(a)) {
      out.flags.set(a === '-m' ? '--model' : a, args[++i]);
      continue;
    }
    if (['-p', '--print', '--stream-partial-output', '--trust', '--approve-mcps', '--force', '-f', '--yolo', '--browser'].includes(a)) {
      out.flags.set(a === '--print' ? '-p' : a === '-f' || a === '--yolo' ? '--force' : a, true);
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

/** Where this turn's argv departs from §3.2's Cursor column. */
function shapeProblems(p) {
  const problems = [];
  const f = p.flags;
  if (!f.has('-p')) problems.push('no -p');
  if (f.get('--output-format') !== 'stream-json') problems.push(`--output-format is ${f.get('--output-format')}`);
  if (!f.has('--stream-partial-output')) problems.push('no --stream-partial-output');
  if (!f.has('--trust')) problems.push('no --trust');
  if (!f.has('--approve-mcps')) problems.push('no --approve-mcps');
  if (typeof f.get('--resume') !== 'string') problems.push('no --resume <chatId> (the id comes from create-chat, before the first turn)');
  if (f.has('--sandbox') && !['enabled', 'disabled'].includes(String(f.get('--sandbox')))) problems.push(`--sandbox is ${f.get('--sandbox')}`);
  if (!p.dashSeen) problems.push('no -- before the prompt');
  if (p.positional.length !== 1) problems.push(`${p.positional.length} positional arguments (want exactly the prompt)`);
  if (p.dashSeen && argv[argv.length - 2] !== '--') problems.push('the prompt is not the one argument after --, last');
  return problems;
}

async function turn() {
  const p = parse(argv);
  const member = memberOfCwd(process.cwd());
  const problems = shapeProblems(p);
  const force = p.flags.has('--force');
  rt.logStart('turn', argv, { account, problems, unknown: p.unknown, force, model: p.flags.get('--model') ?? null });
  if (p.unknown.length > 0) {
    process.stderr.write(`error: unknown option '${p.unknown[0]}'\n`);
    finish(rt, 'usage', 1);
    return;
  }
  const requested = p.flags.get('--resume');
  if (typeof requested === 'string' && !UUID_ANY.test(requested)) {
    rt.log({ ev: 'conversation', id: requested, resumed: true, found: false, refused: 'not a uuid' });
    process.stderr.write(`Error: ${VENDOR_TEXT.cursor.notUuid}\n`);
    finish(rt, 'resume-not-uuid', 1);
    return;
  }
  const prompt = rt.recordPrompt(p.positional[0] ?? '');
  const { turn: n, step } = rt.nextStep(member, prompt);
  rt.log({ ev: 'step', turn: n, step });
  const known = typeof requested === 'string' && rt.convExists(requested);
  // RP-9: a well-formed id the CLI does not hold is a NEW chat, silently.
  const chatId = known && !step.newConversation ? requested : crypto.randomUUID();
  rt.convWrite(chatId, { created: Date.now() });
  rt.log({ ev: 'conversation', id: chatId, resumed: typeof requested === 'string', expected: requested, found: known, ...(typeof requested === 'string' && chatId !== requested ? { replaced: requested } : {}) });

  const servers = [];
  const mcpFile = path.join(process.cwd(), '.cursor', 'mcp.json');
  if (p.flags.has('--approve-mcps')) {
    try {
      const j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      for (const [name, s] of Object.entries(j?.mcpServers ?? {})) {
        if (s && typeof s.command === 'string') servers.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: { ...process.env } });
      }
    } catch {
      rt.log({ ev: 'mcp-init', ok: false, why: `no readable ${mcpFile}` });
    }
  } else if (fs.existsSync(mcpFile)) {
    rt.log({ ev: 'mcp-init', ok: false, why: 'MCP servers wait for an approval (no --approve-mcps)' });
  }
  if (rt.authOut(account)) step.fail = step.fail ?? 'auth';
  const started = Date.now();
  const base = { session_id: chatId };
  let call = 0;
  /** The complete messages of this turn, in order (what the live `result` runs together). */
  const said = [];
  const message = async (text) => {
    const chars = Array.from(text);
    const cut = [0, Math.ceil(chars.length / 3), Math.ceil((2 * chars.length) / 3), chars.length];
    for (let i = 0; i < 3; i++) {
      const fragment = chars.slice(cut[i], cut[i + 1]).join('');
      if (fragment !== '') await emitLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: fragment }] }, timestamp_ms: Date.now(), ...base });
    }
    await emitLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp_ms: Date.now(), ...base });
    said.push(text);
  };
  await runTurnFlow(rt, {
    step,
    turn: n,
    member,
    mcpServers: servers,
    runsCommands: force,
    commandDeniedWhy: 'print mode runs shell commands only with --force',
    cliName: 'cursor-agent',
    stragglerArgs: ['-p', '--output-format', 'stream-json', '--'],
    sigintExit: SIGINT_EXIT.cursor,
    vendorText: VENDOR_TEXT.cursor,
    lines: {
      ids: async () => {
        await emitLine({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), model: p.flags.get('--model') ?? 'Auto', permissionMode: 'default', ...base });
        await emitLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt.slice(0, 200) }] }, ...base });
      },
      assistant: (text) => message(text),
      progress: (i) => message(`progress ${i}`),
      toolUse: (tool, a) => emitLine({ type: 'tool_call', subtype: 'started', call_id: `call_${++call}`, tool_call: { mcpToolCall: { args: { name: `cco_team-${tool}`, args: a, toolName: tool, providerIdentifier: 'cco_team' } } }, ...base }),
      toolResult: (tool, res) =>
        emitLine({ type: 'tool_call', subtype: 'completed', call_id: `call_${call}`, tool_call: { mcpToolCall: { args: { toolName: tool }, result: res.isError ? { rejected: { reason: res.text } } : { success: { content: [{ text: { text: res.text } }] } } } }, ...base }),
      failure: async (fkind, text) => {
        await emitLine({ type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - started, result: text, ...base });
        process.stderr.write(`${text}\n`);
        return 1;
      },
      result: async (text, tokens) => {
        await message(text);
        await emitLine({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - started, duration_api_ms: Date.now() - started, result: said.join(''), request_id: crypto.randomUUID(), usage: { inputTokens: tokens.in, outputTokens: tokens.out }, ...base });
      },
    },
  });
}
