#!/usr/bin/env node
// team-fake-agy.mjs — the stand-in `agy` (Antigravity) of the team-mode harness
// (.orchestrator/fixes/team.mjs), installed by team-fakes.mjs as `<sandbox>/bin/agy`. Written from
// contract-team-mode-v2.md §3.2 (the agy column), the T0 amendments (A9) and team-probes.md —
// never from the adapters or the engine.
//
// Never the real CLI: no network, no login, no tokens. What it does per invocation:
//
//   --version                       `1.3.6`
//   models                          a listing (`<id>\t<label>` lines); exit 1 with nothing when the
//                                   harness wrote `out` for account `ambient` (the adapter's login check)
//   -p /usage --output-format json  `{}` (no usage reading)
//   … -p <prompt>                   A TEAM TURN (Go-style flags):
//     · argv checked against §3.2 (record `start.problems`): the prompt DIRECTLY follows `-p`
//       and is the last argument (probed); an unknown flag → `flag provided but not defined: <x>`,
//       exit 2
//     · `--conversation <id>` of an id the store does not hold → stderr `warning: conversation
//       "<id>" not found`, then SILENTLY a new conversation with a NEW id (RP-9)
//     · MCP: ONLY with `--dangerously-skip-permissions` are the servers of
//       `<cwd>/.agents/mcp_config.json` started and its tools called (RP-5: without the flag agy
//       never calls an MCP tool in print mode — every scripted call is logged `tool-refused`)
//     · `--mode plan` writes no file, even with the flag (RP-25); shell commands run only with the flag
//     · the stream: `{"event":"init","conversation_id":…}` FIRST (RP-4), `step_update`
//       agent_response text deltas, `{"event":"result","result":{conversation_id, status, response,
//       usage}}`; a failure is status `ERROR` with `error`, exit 1
//     · SIGINT (leader or group) stops it within ~0.4 s, exit 1; SIGTERM kills it by the signal
//
// Every invocation is logged (team-fakes.mjs "The log").

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { emitLine, fakeRuntime, finish, guardPipes, memberOfCwd, runTurnFlow, SIGINT_EXIT, VENDOR_TEXT, VENDOR_VERSION } from './team-fakes.mjs';

guardPipes();
const rt = fakeRuntime('gemini', import.meta.url);
const argv = process.argv.slice(2);
const account = 'ambient';
const MODES = ['accept-edits', 'plan'];

const pAt = argv.indexOf('-p');
if (process.env.FAKE_STRAGGLER === '1') {
  rt.logStart('straggler', argv);
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === '--version' || argv[0] === 'version') {
  rt.logStart('version', argv);
  process.stdout.write(`${VENDOR_VERSION.gemini}\n`, () => process.exit(0));
} else if (argv[0] === 'models') {
  rt.logStart('models', argv, { account });
  if (rt.authOut(account)) {
    process.stderr.write('Not logged in.\n', () => process.exit(1));
  } else {
    process.stdout.write('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (high)\ngemini-3.8-flash-low\tGemini 3.8 Flash (low)\n', () => process.exit(0));
  }
} else if (pAt !== -1 && argv[pAt + 1] === '/usage') {
  rt.logStart('usage', argv);
  process.stdout.write('{}\n', () => process.exit(0));
} else if (pAt !== -1) {
  turn().catch((err) => {
    process.stderr.write(`agy fake: ${err?.stack ?? err}\n`);
    finish(rt, 'fake-error', 70);
  });
} else {
  rt.logStart('other', argv);
  process.stderr.write(`agy fake: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
}

/** argv → {flags, prompt, promptLast, unknown}. Go flags: `-p <prompt>` takes the next argument verbatim. */
function parse(args) {
  const out = { flags: new Map(), prompt: undefined, promptLast: false, unknown: [], extra: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p') {
      out.prompt = args[i + 1];
      out.promptLast = i + 1 === args.length - 1;
      i++;
      continue;
    }
    if (['--output-format', '--model', '--mode', '--conversation', '--print-timeout'].includes(a)) {
      out.flags.set(a, args[++i]);
      continue;
    }
    if (a === '--dangerously-skip-permissions') {
      out.flags.set(a, true);
      continue;
    }
    if (a.startsWith('-')) {
      out.unknown.push(a);
      continue;
    }
    out.extra.push(a);
  }
  return out;
}

/** Where this turn's argv departs from §3.2's agy column. */
function shapeProblems(p) {
  const problems = [];
  if (p.flags.get('--output-format') !== 'stream-json') problems.push(`--output-format is ${p.flags.get('--output-format')}`);
  if (!MODES.includes(String(p.flags.get('--mode')))) problems.push(`--mode is ${p.flags.get('--mode')} (want accept-edits or plan, on EVERY turn)`);
  if (typeof p.prompt !== 'string') problems.push('no prompt after -p');
  if (!p.promptLast) problems.push('the prompt is not the last argument, directly after -p');
  if (p.flags.has('--print-timeout')) problems.push('--print-timeout passed (refuted, §13)');
  if (p.flags.has('--conversation') && (typeof p.flags.get('--conversation') !== 'string' || p.flags.get('--conversation') === '')) problems.push('--conversation without an id');
  if (p.extra.length > 0) problems.push(`stray arguments: ${p.extra.join(' ')}`);
  return problems;
}

async function turn() {
  const p = parse(argv);
  const member = memberOfCwd(process.cwd());
  const problems = shapeProblems(p);
  const skip = p.flags.has('--dangerously-skip-permissions');
  const mode = String(p.flags.get('--mode') ?? 'accept-edits');
  rt.logStart('turn', argv, { account, problems, unknown: p.unknown, skip, mode, model: p.flags.get('--model') ?? null });
  if (p.unknown.length > 0) {
    process.stderr.write(`flag provided but not defined: ${p.unknown[0]}\n`);
    finish(rt, 'usage', 2);
    return;
  }
  const requested = p.flags.get('--conversation');
  const prompt = rt.recordPrompt(p.prompt ?? '');
  const { turn: n, step } = rt.nextStep(member, prompt);
  rt.log({ ev: 'step', turn: n, step });
  let convId;
  let found = false;
  if (typeof requested === 'string') {
    found = rt.convExists(requested);
    if (!found) process.stderr.write(`${VENDOR_TEXT.gemini.missing(requested)}\n`);
    convId = found && !step.newConversation ? requested : crypto.randomUUID();
  } else {
    convId = crypto.randomUUID();
  }
  rt.convWrite(convId, { created: Date.now() });
  rt.log({ ev: 'conversation', id: convId, resumed: typeof requested === 'string', expected: requested, found, ...(typeof requested === 'string' && convId !== requested ? { replaced: requested } : {}) });

  const servers = [];
  const mcpFile = path.join(process.cwd(), '.agents', 'mcp_config.json');
  if (skip) {
    try {
      const j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      for (const [name, s] of Object.entries(j?.mcpServers ?? {})) {
        if (s && typeof s.command === 'string') servers.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: { ...process.env } });
      }
    } catch {
      rt.log({ ev: 'mcp-init', ok: false, why: `no readable ${mcpFile}` });
    }
  }
  if (rt.authOut(account)) step.fail = step.fail ?? 'auth';
  await runTurnFlow(rt, {
    step,
    turn: n,
    member,
    mcpServers: servers,
    toolsBlocked: skip ? undefined : 'agy calls no MCP tool in print mode without --dangerously-skip-permissions (RP-5)',
    readOnly: mode === 'plan',
    runsCommands: skip,
    commandDeniedWhy: 'print mode approves no shell command without --dangerously-skip-permissions',
    cliName: 'agy',
    stragglerArgs: ['--output-format', 'stream-json', '-p'],
    sigintExit: SIGINT_EXIT.gemini,
    vendorText: VENDOR_TEXT.gemini,
    lines: {
      ids: () => emitLine({ event: 'init', conversation_id: convId }),
      assistant: (text) => emitLine({ event: 'step_update', step_update: { conversation_id: convId, step_type: 'agent_response', text_delta: `${text}\n` } }),
      progress: (i) => emitLine({ event: 'step_update', step_update: { conversation_id: convId, step_type: 'agent_response', text_delta: `progress ${i}\n` } }),
      toolUse: (tool, a) => emitLine({ event: 'step_update', step_update: { conversation_id: convId, step_type: 'tool_call', tool_name: `cco_team.${tool}`, arguments: a } }),
      toolResult: (tool, res) => emitLine({ event: 'step_update', step_update: { conversation_id: convId, step_type: 'tool_result', tool_name: `cco_team.${tool}`, is_error: res.isError, text: res.text.slice(0, 2000) } }),
      failure: async (fkind, text) => {
        await emitLine({ event: 'result', result: { conversation_id: convId, status: 'ERROR', error: text, response: '' } });
        process.stderr.write(`${text}\n`);
        return 1;
      },
      result: (text, tokens) => emitLine({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: text, usage: { input_tokens: tokens.in, output_tokens: tokens.out } } }),
    },
  });
}
