#!/usr/bin/env node
// server-fake-claude.mjs — the stand-in `claude` of .orchestrator/fixes/server.mjs.
//
// Never the real CLI: no network, no login, no tokens. The dispatch server is pointed at this
// file through `registry.claudePath`, and a copy of it is the only `claude` on the PATH the
// harness gives a server — so nothing a server does, on any code path, can start the real one.
//
// EVERY invocation appends one record to the file SRV_FAKE_LOG names, before anything else:
//   { kind, pid, t, argv }       kind: version | auth | usage | agents | stop | worker | other
// so "nothing was spawned" is something the harness can read off a file.
//
// A WORKER (`claude -p …`, prompt on stdin) does what its PROMPT says, so several dispatches
// through one server can end in different ways:
//
//   [[fake:ok]]                 success at once (also the default)
//   [[fake:delay:MS]]           success after MS milliseconds
//   [[fake:hang]]               never exits by itself (dies on a signal)
//   [[fake:fail]]               a line on stderr, exit 3
//   [[fake:bigjson:MB]]         a JSON result whose text is MB MiB of `y`
//   [[fake:bigjson:MB:wide]]    the same size in three-byte characters (a cut has boundaries to miss)
//   [[fake:turns:VARIANT]]      a stream-json run of TWO results (RO): a long report answers the
//                               prompt, then a turn the CLI gives the session when a background
//                               monitor expires, answered with one short sentence. VARIANT:
//                                 user     the second turn opens with a `user` notification
//                                 system   …with a `system` notification
//                                 bare     …with nothing that says what started it
//                                 hooks    …with only system/hook_response and thinking_tokens
//                                          (which say nothing about it, RO2)
//                                 hooks-system  those, and the measured task_updated ·
//                                          task_notification · background_tasks_changed
//                                 bigtool  as `user`, and the first turn reads a 9 MiB tool result
//                               total_cost_usd is the running total (0.50, then 0.75), usage per
//                               result (RO2). Asked for `--output-format json`, it prints the last
//                               result alone.
//   [[tag:NAME]]                a name for the run: the result text is `FAKE_OK NAME`
//
// A worker also appends { kind: 'worker-mode', pid, t, mode, tag, account } once it has read
// its prompt and { kind: 'worker-exit', pid, t, how } when it ends normally or on SIGTERM.

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const LOG = process.env.SRV_FAKE_LOG || '';

function log(record) {
  if (LOG === '') return;
  try {
    // One appendFileSync is one O_APPEND write: concurrent fakes never interleave a line.
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...record }) + '\n');
  } catch {
    // an unwritable log is the harness's to report, not a reason to change the run
  }
}

function say(text, code = 0) {
  process.stdout.write(text, () => process.exit(code));
}

const kind = argv.includes('--version')
  ? 'version'
  : argv.includes('auth') && argv.includes('status')
    ? 'auth'
    : argv.includes('stream-json')
      ? 'usage'
      : argv[0] === 'agents'
        ? 'agents'
        : argv[0] === 'stop' || argv[0] === 'rm'
          ? 'stop'
          : argv.includes('-p')
            ? 'worker'
            : 'other';
log({ kind, argv: argv.slice(0, 6) });

if (kind === 'version') {
  // Newer than any minimum the server asks of a CLI that runs session workers.
  say('9.9.9 (Claude Code)\n');
} else if (kind === 'auth') {
  say(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\n');
} else if (kind === 'usage') {
  say(
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\n',
  );
} else if (kind === 'agents') {
  say('[]\n');
} else if (kind === 'stop') {
  say('');
} else if (kind === 'worker') {
  worker();
} else {
  process.stderr.write(`server-fake-claude: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
}

function worker() {
  process.once('SIGTERM', () => {
    log({ kind: 'worker-exit', how: 'SIGTERM' });
    // Die BY the signal, as a CLI without a handler does: the server tells a kill from an exit.
    process.kill(process.pid, 'SIGTERM');
  });
  let prompt = '';
  let began = false;
  const begin = () => {
    if (began) return;
    began = true;
    const mode = /\[\[fake:([^\]]+)\]\]/.exec(prompt)?.[1] ?? 'ok';
    const tag = /\[\[tag:([^\]]+)\]\]/.exec(prompt)?.[1] ?? mode;
    const account = path.basename((process.env.CLAUDE_CONFIG_DIR || '').replace(/[/\\]+$/, '')) || '(default)';
    log({ kind: 'worker-mode', mode, tag, account });
    run(mode, tag);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', begin);
  process.stdin.on('error', begin);
  setTimeout(begin, 3000);

  const result = (text) => JSON.stringify({ result: text, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.001 });
  const out = (text, code) =>
    process.stdout.write(text, () => {
      log({ kind: 'worker-exit', how: `exit ${code}` });
      process.exit(code);
    });

  function run(mode, tag) {
    const [what, ...rest] = mode.split(':');
    if (what === 'hang') {
      setInterval(() => {}, 1 << 30);
    } else if (what === 'fail') {
      setTimeout(() => {
        process.stderr.write('server-fake-claude: deterministic failure, nothing about any account\n', () => {
          log({ kind: 'worker-exit', how: 'exit 3' });
          process.exit(3);
        });
      }, 200);
    } else if (what === 'delay') {
      setTimeout(() => out(result(`FAKE_OK ${tag}`), 0), Number(rest[0]) || 0);
    } else if (what === 'turns') {
      // Under `--output-format json` the CLI prints only the LAST result, as one document: the
      // shape that lost the report of tmveraanutqs3. stream-json prints every event.
      const stream = turnsStream(rest[0] ?? 'user', tag);
      out(argv.includes('json') ? stream.trimEnd().split('\n').at(-1) : stream, 0);
    } else if (what === 'bigjson') {
      const bytes = (Number(rest[0]) || 1) * 1024 * 1024;
      // `wide`: U+D55C, three bytes of UTF-8 each, so a cut at a byte count has two wrong places
      // in three to land on.
      const text = rest[1] === 'wide' ? String.fromCharCode(0xd55c).repeat(Math.ceil(bytes / 3)) : 'y'.repeat(bytes);
      out(result(`BIG_BEGIN ${tag}\n${text}\nBIG_END ${tag}`), 0);
    } else {
      out(result(`FAKE_OK ${tag}`), 0);
    }
  }
}

/**
 * The stdout of a run that answered its prompt and was then given one more turn by a background
 * task's notification — the shape of task tmveraanutqs3 (RO). Both results are in it, each with
 * its own turn's `usage` and with `total_cost_usd` the session's RUNNING total, as the real CLI
 * prints them (RO2, measured): $0.50, then $0.75 for a second turn that cost $0.25. `json` output
 * would have printed the second result alone. `hooks` and `hooks-system` put, between the
 * results, the `system/hook_response` and `system/thinking_tokens` events a CLI prints whether or
 * not a background task woke the session — alone (nothing says what started the turn), or with
 * the measured `task_updated` · `task_notification` · `background_tasks_changed`.
 */
function turnsStream(variant, tag) {
  const ev = (o) => JSON.stringify(o) + '\n';
  const session = { session_id: `fake-session-${tag}` };
  const text = (t) => ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, ...session });
  let s = ev({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', ...session });
  s += text('Working on it.');
  if (variant === 'bigtool') {
    s += ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] }, ...session });
    s += ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'z'.repeat(9 * 1024 * 1024) }] }, ...session });
  }
  s += ev({ type: 'result', subtype: 'success', is_error: false, result: turnsReport(tag), usage: { input_tokens: 1000, output_tokens: 2000 }, total_cost_usd: 0.5, ...session });
  if (variant === 'hooks' || variant === 'hooks-system') {
    s += ev({ type: 'system', subtype: 'hook_response', hook_name: 'Stop', ...session });
    s += ev({ type: 'system', subtype: 'thinking_tokens', ...session });
  }
  if (variant === 'hooks-system') {
    s += ev({ type: 'system', subtype: 'task_updated', status: 'completed', ...session });
    s += ev({ type: 'system', subtype: 'task_notification', status: 'expired', summary: 'the progress monitor expired', ...session });
    s += ev({ type: 'system', subtype: 'background_tasks_changed', ...session });
    s += ev({ type: 'system', subtype: 'thinking_tokens', ...session });
  } else if (variant === 'system') {
    s += ev({ type: 'system', subtype: 'task_notification', status: 'expired', summary: 'the progress monitor expired', ...session });
  } else if (variant !== 'bare' && variant !== 'hooks') {
    s += ev({ type: 'user', message: { role: 'user', content: '<task-notification>the progress monitor expired</task-notification>' }, ...session });
  }
  s += text(TURNS_AFTERTHOUGHT);
  s += ev({ type: 'result', subtype: 'success', is_error: false, result: TURNS_AFTERTHOUGHT, usage: { input_tokens: 30, output_tokens: 40 }, total_cost_usd: 0.75, ...session });
  return s;
}

const TURNS_AFTERTHOUGHT = 'The progress monitor has expired; there is nothing to re-arm and the report stands.';

/** The long report of the first turn: its first and last lines name the run. */
function turnsReport(tag) {
  return [`REPORT_BEGIN ${tag}`, ...Array.from({ length: 40 }, (_, i) => `finding ${i + 1}: the work of ${tag} is done and verified.`), `REPORT_END ${tag}`].join('\n');
}
