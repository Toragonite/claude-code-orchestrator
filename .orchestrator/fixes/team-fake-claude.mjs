#!/usr/bin/env node
// team-fake-claude.mjs — the stand-in `claude` of the team-mode harness (.orchestrator/fixes/team.mjs),
// installed by team-fakes.mjs as `<sandbox>/bin/claude` and named by the sandbox registry's
// `claudePath`. Written from contract-team-mode-v2.md §3.2 (the Claude column), the T0
// amendments and team-probes.md — never from the adapters or the engine.
//
// Never the real CLI: no network, no login, no tokens. What it does per invocation:
//
//   --version                       `2.1.299 (Claude Code)`
//   auth status [--json]            {loggedIn, authMethod, email}; logged out when the harness wrote
//                                   `out` for this config dir (team-fakes setAuth)
//   -p --input-format stream-json   the usage probe: one control_response saying no rate limits
//   A TEAM TURN — `-p` with `--session-id <uuid>` (first) or `--resume <uuid>` (later):
//     · the argv is checked against §3.2's shape (record `start.problems`); an option the real CLI
//       does not know → `error: unknown option '<x>'`, exit 1 (commander's way)
//     · the conversation is the real CLI's transcript, `<configDir>/projects/<cwd with every
//       non-alphanumeric character as '-'>/<id>.jsonl` (configDir = CLAUDE_CONFIG_DIR, else
//       ~/.claude): `--session-id` of an existing transcript → `Error: Session ID <id> is already
//       in use.` (A4, RP-18); `--resume` of a missing one → `No conversation found with session ID:
//       <id>` (RP-9) — both exit 1 before any stream line
//     · every `--mcp-config` file's servers are started (with --strict-mcp-config, only those),
//       with this process's environment; `system/init` lists each as connected / failed (RP-1,
//       RP-24) and its `tools` are the base tools minus --disallowedTools plus the connected
//       servers' `mcp__<server>__<tool>` names (A12: the suite asserts SendMessage/ListAgents absent)
//     · then the scripted turn (team-fakes.mjs: files, team tool calls as `tool_use` /
//       `tool_result`, duration, failures with the measured wording, stragglers, a cco call)
//     · `result` ends it: {subtype, is_error, result, session_id, usage, total_cost_usd,
//       permission_denials}; under any permission mode but bypassPermissions a shell command is
//       DENIED (`--permission-prompts none`, RP-17) and listed in permission_denials
//     · a step's `backgroundTurn` {text, notify} adds, after that result, a turn started by a
//       background task's notification and a second `result` (RO), whose total_cost_usd is the
//       session's running total (RO2)
//     · total_cost_usd is the running total of the CONVERSATION, the results of its earlier
//       `--resume` processes included (RO3, measured on the real CLI): it is kept in the
//       conversation's record (`state/conversations/claude/<id>.json`, `costUsd`). A result costs
//       $0.0012 of its own (a step's `costUsd` overrides it), a background turn's $0.0008, a
//       failure nothing; a step's `costRestart` starts the count over under the same id (a
//       conversation replaced underneath)
//     · SIGINT (leader or group) stops it within ~0.4 s, exit 1; SIGTERM kills it by the signal
//   A one-shot dispatch worker (`-p`, prompt on stdin) answers a json result at once.
//
// Every invocation is logged (team-fakes.mjs "The log").

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import {
  CLAUDE_ALLOWED_ARG,
  CLAUDE_BASE_TOOLS,
  emitLine,
  fakeRuntime,
  finish,
  guardPipes,
  memberOfCwd,
  runTurnFlow,
  SIGINT_EXIT,
  UUID_ANY,
  UUID_V4,
  VENDOR_TEXT,
  VENDOR_VERSION,
} from './team-fakes.mjs';

guardPipes();
const rt = fakeRuntime('claude', import.meta.url);
const argv = process.argv.slice(2);

const VALUE_FLAGS = new Set([
  '--session-id',
  '--resume',
  '-r',
  '--model',
  '--permission-mode',
  '--permission-prompts',
  '--setting-sources',
  '--append-system-prompt-file',
  '--append-system-prompt',
  '--system-prompt',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--output-format',
  '--input-format',
  '--max-turns',
  '--add-dir',
  '--fallback-model',
  '--settings',
  '--name',
  '--permission-prompt-tool',
]);
const BOOL_FLAGS = new Set([
  '-p',
  '--print',
  '--strict-mcp-config',
  '--verbose',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
  '--json',
  '--bare',
]);

/** argv → {flags: Map(flag → value | true | string[]), positional, afterDash, unknown}. */
function parse(args) {
  const flags = new Map();
  const positional = [];
  const unknown = [];
  let afterDash = false;
  let dashSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDash) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      afterDash = true;
      dashSeen = true;
      continue;
    }
    if (a === '--mcp-config') {
      const vals = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) vals.push(args[++i]);
      flags.set(a, [...(flags.get(a) ?? []), ...vals]);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      flags.set(a, args[++i]);
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      flags.set(a, true);
      continue;
    }
    if (a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    positional.push(a);
  }
  return { flags, positional, unknown, dashSeen };
}

const isTurn = argv.includes('-p') && (argv.includes('--session-id') || argv.includes('--resume'));
const kind = argv.includes('--version')
  ? 'version'
  : argv[0] === 'auth' && argv[1] === 'status'
    ? 'auth'
    : argv.includes('--input-format')
      ? 'usage'
      : isTurn
        ? 'turn'
        : argv.includes('-p') && process.env.FAKE_STRAGGLER === '1'
          ? 'straggler'
          : argv.includes('-p')
            ? 'worker'
            : 'other';

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const account = process.env.CLAUDE_CONFIG_DIR ? path.basename(configDir.replace(/[/\\]+$/, '')) : '(default)';

if (kind === 'version') {
  rt.logStart(kind, argv);
  process.stdout.write(`${VENDOR_VERSION.claude}\n`, () => process.exit(0));
} else if (kind === 'auth') {
  rt.logStart(kind, argv, { account });
  const out = rt.authOut(account);
  process.stdout.write(
    JSON.stringify(out ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai', email: 'fake@example.invalid' }) + '\n',
    () => process.exit(out ? 1 : 0),
  );
} else if (kind === 'usage') {
  rt.logStart(kind, argv, { account });
  process.stdout.write(
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\n',
    () => process.exit(0),
  );
  process.stdin.resume();
} else if (kind === 'straggler') {
  rt.logStart(kind, argv);
  setInterval(() => {}, 1 << 30);
} else if (kind === 'worker') {
  rt.logStart(kind, argv);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ result: `FAKE_OK worker ${input.length}`, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n', () => process.exit(0));
  });
} else if (kind === 'turn') {
  turn().catch((err) => {
    process.stderr.write(`claude fake: ${err?.stack ?? err}\n`);
    finish(rt, 'fake-error', 70);
  });
} else {
  rt.logStart(kind, argv);
  process.stderr.write(`claude fake: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
}

/** The real CLI's transcript of session `id` for this cwd. */
function transcriptOf(id) {
  return path.join(configDir, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
}

/** Where this turn's argv departs from §3.2's Claude column (the T0 amendments applied). */
function shapeProblems(p, member) {
  const problems = [];
  const f = p.flags;
  const first = f.has('--session-id');
  const id = first ? f.get('--session-id') : f.get('--resume');
  if (f.has('--session-id') && f.has('--resume')) problems.push('both --session-id and --resume');
  if (first && !UUID_V4.test(String(id))) problems.push(`--session-id is not a UUID v4: ${id}`);
  if (!first && !UUID_ANY.test(String(id))) problems.push(`--resume is not a UUID: ${id}`);
  if (typeof f.get('--permission-mode') !== 'string' || f.get('--permission-mode') === '') problems.push('no --permission-mode');
  if (f.get('--permission-prompts') !== 'none') problems.push(`--permission-prompts is ${f.get('--permission-prompts')} (want none)`);
  if (f.has('--setting-sources')) problems.push('--setting-sources passed (A6: members keep the default sources)');
  if (f.has('--dangerously-skip-permissions')) problems.push('--dangerously-skip-permissions passed (I14)');
  const brief = f.get('--append-system-prompt-file');
  if (typeof brief !== 'string' || !path.isAbsolute(brief) || !fs.existsSync(brief)) problems.push(`--append-system-prompt-file not an existing absolute file: ${brief}`);
  else if (path.basename(brief) !== 'brief.md' || path.basename(path.dirname(brief)) !== member) problems.push(`the brief file is not members/${member}/brief.md: ${brief}`);
  const configs = f.get('--mcp-config') ?? [];
  if (configs.length < 1 || configs.length > 2) problems.push(`--mcp-config takes 1 or 2 files, got ${configs.length}`);
  for (const c of configs) if (!path.isAbsolute(c) || !fs.existsSync(c)) problems.push(`--mcp-config file not an existing absolute path: ${c}`);
  const last = configs[configs.length - 1];
  if (last !== undefined && (path.basename(last) !== 'mcp.json' || path.basename(path.dirname(last)) !== member)) problems.push(`the last --mcp-config is not members/${member}/mcp.json: ${last}`);
  if (configs.length === 2 && configs[0] !== path.join(process.cwd(), '.mcp.json')) problems.push(`the first of two --mcp-config files is not <worktree>/.mcp.json: ${configs[0]}`);
  if (configs.length === 1 && fs.existsSync(path.join(process.cwd(), '.mcp.json'))) problems.push('the worktree has a .mcp.json, yet it was not passed first (H5)');
  if (!f.has('--strict-mcp-config')) problems.push('no --strict-mcp-config');
  if (f.get('--allowedTools') !== CLAUDE_ALLOWED_ARG) problems.push(`--allowedTools is ${f.get('--allowedTools')}`);
  if (f.get('--disallowedTools') !== 'SendMessage,ListAgents') problems.push(`--disallowedTools is ${f.get('--disallowedTools')}`);
  if (!f.has('-p')) problems.push('no -p');
  if (f.get('--output-format') !== 'stream-json') problems.push(`--output-format is ${f.get('--output-format')}`);
  if (!f.has('--verbose')) problems.push('no --verbose');
  if (!p.dashSeen) problems.push('no -- before the prompt');
  if (p.positional.length !== 1) problems.push(`${p.positional.length} positional arguments (want exactly the prompt)`);
  if (p.dashSeen && argv[argv.length - 2] !== '--') problems.push('the prompt is not the one argument after --, last');
  return problems;
}

async function turn() {
  const p = parse(argv);
  const member = memberOfCwd(process.cwd());
  const problems = shapeProblems(p, member);
  rt.logStart('turn', argv, { account, problems, unknown: p.unknown, mode: p.flags.get('--permission-mode') ?? null, model: p.flags.get('--model') ?? null });
  if (p.unknown.length > 0) {
    process.stderr.write(`error: unknown option '${p.unknown[0]}'\n`);
    finish(rt, 'usage', 1);
    return;
  }
  const first = p.flags.has('--session-id');
  const requested = String(first ? p.flags.get('--session-id') : p.flags.get('--resume'));
  const transcript = transcriptOf(requested);
  const prompt = rt.recordPrompt(p.positional[0] ?? '');
  let brief = '';
  try {
    brief = fs.readFileSync(String(p.flags.get('--append-system-prompt-file')), 'utf8');
  } catch {
    // shape problem already recorded
  }
  const { turn: n, step } = rt.nextStep(member, `${brief}\n${prompt}`);
  rt.log({ ev: 'step', turn: n, step });
  if (first && fs.existsSync(transcript)) {
    rt.log({ ev: 'conversation', id: requested, resumed: false, found: true, refused: 'in use' });
    process.stderr.write(`${VENDOR_TEXT.claude.inUse(requested)}\n`);
    finish(rt, 'session-in-use', 1);
    return;
  }
  if (!first && !fs.existsSync(transcript)) {
    rt.log({ ev: 'conversation', id: requested, resumed: true, found: false, refused: 'missing' });
    process.stderr.write(`${VENDOR_TEXT.claude.resumeMissing(requested)}\n`);
    finish(rt, 'resume-missing', 1);
    return;
  }
  const sessionId = step.newConversation ? crypto.randomUUID() : requested;
  const appendTranscript = (entry) => {
    try {
      fs.mkdirSync(path.dirname(transcriptOf(sessionId)), { recursive: true });
      fs.appendFileSync(transcriptOf(sessionId), JSON.stringify({ t: Date.now(), ...entry }) + '\n');
    } catch {
      // the next resume reads it as missing
    }
  };
  if (step.transcriptThenCrash) {
    appendTranscript({ type: 'user', prompt: prompt.slice(0, 200) });
    rt.log({ ev: 'conversation', id: sessionId, resumed: !first, found: true, transcript: transcriptOf(sessionId) });
    process.stderr.write('fatal: claude fake crashed after creating its transcript (scripted)\n');
    finish(rt, 'crash-early', 1);
    return;
  }
  appendTranscript({ type: 'user', prompt: prompt.slice(0, 200) });
  let spent = step.costRestart === true ? 0 : Number(rt.convRead(sessionId)?.costUsd) || 0;
  const spend = (own) => {
    spent = Math.round((spent + own) * 1e10) / 1e10;
    rt.convWrite(sessionId, { transcript: transcriptOf(sessionId), costUsd: spent });
    return spent;
  };
  spend(0);
  rt.log({ ev: 'conversation', id: sessionId, resumed: !first, expected: requested, found: true, ...(sessionId !== requested ? { replaced: requested } : {}) });

  const mode = String(p.flags.get('--permission-mode') ?? 'default');
  const runsCommands = mode === 'bypassPermissions';
  const disallowed = String(p.flags.get('--disallowedTools') ?? '').split(',').filter(Boolean);
  const servers = [];
  for (const file of p.flags.get('--mcp-config') ?? []) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [name, s] of Object.entries(j?.mcpServers ?? {})) {
        if (s && typeof s.command === 'string') servers.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: { ...process.env } });
      }
    } catch {
      // an unreadable file: the CLI would refuse; recorded as a shape problem already
    }
  }
  const authOut = rt.authOut(account);
  const denials = [];
  const step2 = authOut ? { ...step, fail: 'auth', failBeforeAssistant: true } : step;
  if (Array.isArray(step.runCco) && !runsCommands) denials.push({ tool_name: 'Bash', tool_use_id: 'toolu_denied', tool_input: { command: `cco ${step.runCco.join(' ')}` } });
  const started = Date.now();
  const msgId = () => `msg_${crypto.randomBytes(6).toString('hex')}`;
  const assistant = (content) => emitLine({ type: 'assistant', message: { id: msgId(), type: 'message', role: 'assistant', model: 'claude-fake-1', content, usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null, session_id: sessionId });
  await runTurnFlow(rt, {
    step: step2,
    turn: n,
    member,
    mcpServers: servers,
    runsCommands,
    commandDeniedWhy: `permission mode ${mode} with --permission-prompts none denies shell commands`,
    cliName: 'claude',
    stragglerArgs: ['-p', '--output-format', 'stream-json'],
    sigintExit: SIGINT_EXIT.claude,
    vendorText: VENDOR_TEXT.claude,
    lines: {
      ids: (statuses) => {
        const connected = statuses.filter((s) => s.status === 'connected').map((s) => s.name);
        const tools = [
          ...CLAUDE_BASE_TOOLS.filter((t) => !disallowed.includes(t)),
          ...connected.flatMap((name) => (name === 'cco_team' ? ['team_board', 'team_inbox', 'team_send', 'team_claim', 'team_update'] : ['echo']).map((t) => `mcp__${name}__${t}`)),
        ];
        rt.log({ ev: 'init-tools', tools });
        return emitLine({
          type: 'system',
          subtype: 'init',
          cwd: process.cwd(),
          session_id: sessionId,
          tools,
          mcp_servers: statuses.map((s) => ({ ...s, source: 'dynamic' })),
          model: p.flags.get('--model') ?? 'claude-fake-1',
          permissionMode: mode,
          apiKeySource: 'none',
          uuid: crypto.randomUUID(),
        });
      },
      assistant: (text) => assistant([{ type: 'text', text }]),
      progress: (i) => assistant([{ type: 'text', text: `progress ${i}` }]),
      toolUse: (tool, args, k) => assistant([{ type: 'tool_use', id: `toolu_${k}`, name: `mcp__cco_team__${tool}`, input: args }]),
      toolResult: (tool, res, k) =>
        emitLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${k}`, content: [{ type: 'text', text: res.text }], is_error: res.isError }] }, parent_tool_use_id: null, session_id: sessionId }),
      failure: async (fkind, text) => {
        await emitLine({
          type: 'result',
          subtype: 'success',
          is_error: true,
          duration_ms: Date.now() - started,
          num_turns: 1,
          result: text,
          session_id: sessionId,
          total_cost_usd: spent,
          usage: { input_tokens: 0, output_tokens: 0 },
          permission_denials: denials,
        });
        return 1;
      },
      result: async (text, tokens) => {
        appendTranscript({ type: 'assistant', text: text.slice(0, 200) });
        await emitLine({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: Date.now() - started,
          num_turns: 1,
          result: text,
          session_id: sessionId,
          total_cost_usd: spend(typeof step.costUsd === 'number' ? step.costUsd : 0.0012),
          usage: { input_tokens: tokens.in, output_tokens: tokens.out },
          permission_denials: denials,
        });
        // RO: `backgroundTurn` {text, notify?: 'user' | 'system' | 'hooks' | 'none'} — after the
        // answer, the turn the CLI gives the session when a background task the member started
        // expires: its notification (none: nothing says what started it; hooks: only the
        // system/hook_response and thinking_tokens a CLI prints anyway, RO2), one assistant line,
        // a second result: 40 in, 7 out of its own, and total_cost_usd the session's RUNNING
        // total, $0.0008 above the first result's (RO2, as measured on the real CLI).
        const bg = step.backgroundTurn;
        if (bg && typeof bg.text === 'string') {
          if (bg.notify === 'hooks') {
            await emitLine({ type: 'system', subtype: 'hook_response', hook_name: 'Stop', session_id: sessionId });
            await emitLine({ type: 'system', subtype: 'thinking_tokens', session_id: sessionId });
          } else if (bg.notify === 'system') {
            await emitLine({ type: 'system', subtype: 'task_updated', status: 'completed', session_id: sessionId });
            await emitLine({ type: 'system', subtype: 'task_notification', status: 'expired', summary: 'the monitor expired', session_id: sessionId });
            await emitLine({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId });
          } else if (bg.notify !== 'none') {
            await emitLine({ type: 'user', message: { role: 'user', content: '<task-notification>the monitor expired</task-notification>' }, parent_tool_use_id: null, session_id: sessionId });
          }
          await assistant([{ type: 'text', text: bg.text }]);
          await emitLine({
            type: 'result',
            subtype: 'success',
            is_error: false,
            duration_ms: Date.now() - started,
            num_turns: 1,
            result: bg.text,
            session_id: sessionId,
            total_cost_usd: spend(0.0008),
            usage: { input_tokens: 40, output_tokens: 7 },
            permission_denials: denials,
          });
        }
      },
    },
  });
}
