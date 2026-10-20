#!/usr/bin/env node
// runner-fake-claude.mjs — the stand-in `claude` of .orchestrator/fixes/runner.mjs.
//
// Never the real CLI: no network, no login, no tokens. The dispatch server is pointed at this
// file through `registry.claudePath` and spawns it exactly as it spawns a worker
// (`claude -p --output-format json --model … --append-system-prompt …`, prompt on stdin).
//
// Unlike the other harnesses' fakes, what ONE invocation does is chosen by the PROMPT it is
// handed, so twelve dispatches through one server can end in twelve different ways:
//
//   [[fake:ok]]                  success at once (also the default)
//   [[fake:delay:MS]]            success after MS milliseconds
//   [[fake:fail]]                a line on stderr, exit 3 (after 300 ms, so it is seen alive)
//   [[fake:hang]]                never exits by itself (dies on a signal)
//   [[fake:quota]]               an `is_error` result in the Claude CLI's words for a plan limit
//   [[fake:quota-once:KEY]]      quota the FIRST time KEY is seen (whatever account that is),
//                                success after that — one failover, deterministically
//   [[fake:stack429]]            exit 1 with a Node stack trace whose line number is 429
//   [[fake:bigout:MB]]           MB MiB of non-JSON text on stdout, then exit 0
//   [[fake:bigjson:MB]]          a JSON result whose text is MB MiB, exit 0
//   [[fake:bigerr:MB]]           MB MiB of text on STDERR, then an ordinary success
//   [[fake:term-ok]]             runs until SIGTERM, then prints a complete SUCCESS result, exit 0
//   [[fake:term-error]]          runs until SIGTERM, then prints an `is_error` result, exit 0
//   [[fake:term-empty]]          runs until SIGTERM, then exits 0 having printed nothing
//   [[fake:turns-trickle]]       a stream-json run of TWO results (RO, as server-fake-claude.mjs's
//                                `turns:user`) written five bytes at a time, so every line reaches
//                                the server across many reads; under `--output-format json` the
//                                last result alone, as the CLI prints it
//   [[tag:NAME]]                 a name for the run in the log (default: the mode)
//
// Every worker invocation appends records to the file RUNNER_FAKE_LOG names:
//   { ev: 'start', pid, t }                       before stdin is read
//   { ev: 'mode',  pid, t, mode, tag, account }   once the prompt was read
//   { ev: 'exit',  pid, t, how, written? }        on a normal exit and on SIGTERM
// `account` is the base name of CLAUDE_CONFIG_DIR. A SIGKILL leaves no exit record, which is
// why the test also asks the operating system whether the pid is alive.

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const LOG = process.env.RUNNER_FAKE_LOG || '';

function log(record) {
  if (LOG === '') return;
  try {
    // One appendFileSync is one O_APPEND write: concurrent fakes never interleave a line.
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...record }) + '\n');
  } catch {
    // an unwritable log is the test's problem to report, not a reason to change the run
  }
}

function out(text, code) {
  process.stdout.write(text, () => {
    log({ ev: 'exit', how: `exit ${code}` });
    process.exit(code);
  });
}

if (argv.includes('auth') && argv.includes('status')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\n', () =>
    process.exit(0),
  );
} else if (argv.includes('stream-json')) {
  process.stdout.write(
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\n',
    () => process.exit(0),
  );
} else if (!argv.includes('-p')) {
  process.stderr.write(`runner-fake-claude: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
} else {
  worker();
}

function worker() {
  log({ ev: 'start' });
  let written = 0;
  process.once('SIGTERM', () => {
    log({ ev: 'exit', how: 'SIGTERM', written });
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
    log({ ev: 'mode', mode, tag, account });
    run(mode, tag);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', begin);
  process.stdin.on('error', begin);
  setTimeout(begin, 3000);

  const success = (tag) =>
    JSON.stringify({ result: `FAKE_OK ${tag}`, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.001 });
  const quota = () =>
    JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1760000000' });

  function run(mode, tag) {
    const [kind, ...rest] = mode.split(':');
    const arg = rest.join(':');
    if (kind === 'hang') {
      setInterval(() => {}, 1 << 30);
    } else if (kind === 'term-ok' || kind === 'term-error' || kind === 'term-empty') {
      // A CLI that handles SIGTERM and leaves in its own time, with exit code 0.
      process.removeAllListeners('SIGTERM');
      process.on('SIGTERM', () => {
        const text = kind === 'term-ok' ? success(tag) : kind === 'term-error' ? quota() : '';
        out(text, 0);
      });
      setInterval(() => {}, 1 << 30);
    } else if (kind === 'fail') {
      setTimeout(() => {
        process.stderr.write('runner-fake-claude: deterministic failure, nothing about any account\n', () => {
          log({ ev: 'exit', how: 'exit 3' });
          process.exit(3);
        });
      }, 300);
    } else if (kind === 'quota') {
      setTimeout(() => out(quota(), 0), 300);
    } else if (kind === 'quota-once') {
      // The marker lives beside the log; O_EXCL makes "first" exact even for two fakes at once.
      const marker = path.join(path.dirname(LOG || '.'), `once-${arg.replace(/[^A-Za-z0-9_-]/g, '_')}`);
      let first = false;
      try {
        fs.closeSync(fs.openSync(marker, 'wx'));
        first = true;
      } catch {
        first = false;
      }
      setTimeout(() => out(first ? quota() : success(tag), 0), 300);
    } else if (kind === 'stack429') {
      process.stderr.write(
        "TypeError: Cannot read properties of undefined (reading 'content')\n" +
          '    at renderTurn (file:///opt/fake/node_modules/@anthropic-ai/claude-code/cli.js:429:17)\n' +
          '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n',
        () => {
          log({ ev: 'exit', how: 'exit 1' });
          process.exit(1);
        },
      );
    } else if (kind === 'bigout') {
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      let left = Number(arg) || 1;
      const pump = () => {
        while (left > 0) {
          left--;
          written++;
          if (!process.stdout.write(chunk)) {
            process.stdout.once('drain', pump);
            return;
          }
        }
        process.stdout.write('\n', () => {
          log({ ev: 'exit', how: 'exit 0', written });
          process.exit(0);
        });
      };
      process.stdout.on('error', () => {
        log({ ev: 'exit', how: 'EPIPE', written });
        process.exit(1);
      });
      pump();
    } else if (kind === 'bigerr') {
      const chunk = Buffer.alloc(1024 * 1024, 'e');
      let left = Number(arg) || 1;
      const pump = () => {
        while (left > 0) {
          left--;
          if (!process.stderr.write(chunk)) {
            process.stderr.once('drain', pump);
            return;
          }
        }
        process.stderr.write('\n', () => out(success(tag), 0));
      };
      pump();
    } else if (kind === 'bigjson') {
      const text = 'y'.repeat((Number(arg) || 1) * 1024 * 1024);
      out(JSON.stringify({ result: text, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }), 0);
    } else if (kind === 'turns-trickle') {
      const stream = turnsStream('user', tag);
      const text = argv.includes('json') ? stream.trimEnd().split('\n').at(-1) : stream;
      let at = 0;
      const drip = () => {
        if (at >= text.length) {
          out('', 0);
          return;
        }
        process.stdout.write(text.slice(at, at + 5), () => setTimeout(drip, 0));
        at += 5;
      };
      drip();
    } else if (kind === 'delay') {
      setTimeout(() => out(success(tag), 0), Number(arg) || 0);
    } else {
      out(success(tag), 0);
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
