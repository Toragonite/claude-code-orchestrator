#!/usr/bin/env node
// cco-fake-claude.mjs — the stand-in `claude` of .orchestrator/fixes/cco.mjs, modelled on
// server-fake-claude.mjs (the same invocation kinds and log records) with the modes the cco
// checks need: answers of a chosen size and shape, and a worker that runs `cco` itself.
//
// Never the real CLI: no network, no login, no tokens. The dispatch host is pointed at this file
// through `registry.claudePath`, and a copy of it is the only `claude` on the PATH the harness
// gives a client (and so a host, which inherits the client's environment).
//
// EVERY invocation appends one record to the file SRV_FAKE_LOG names, before anything else:
//   { kind, pid, t, argv }       kind: version | auth | usage | agents | stop | worker | other
//
// A WORKER (`claude -p …`, prompt on stdin) does what its PROMPT says:
//
//   [[fake:ok]]                    success at once (also the default)
//   [[fake:delay:MS]]              success after MS milliseconds
//   [[fake:hang]]                  never exits by itself (dies on a signal)
//   [[fake:fail]]                  a line on stderr, exit 3
//   [[fake:lines:COUNT:WIDTH]]     COUNT lines of WIDTH characters (`L000001 xxx…`), between a
//                                  `BIG_BEGIN <tag>` line and a `BIG_END <tag>` line
//   [[fake:wide:CHARS]]            CHARS three-byte characters (U+D55C) on one line, between the same
//   [[fake:astral:COUNT]]          COUNT astral characters (U+1F600, a surrogate pair each) on one line
//   [[fake:astral:COUNT:PREFIX]]   the same after PREFIX on that line (moves where a cut lands by its length)
//   [[fake:cco:OP]] [[cli:PATH]]   run `node PATH OP` with THIS worker's environment and answer
//                                  `CCO_EXIT <status> <its stderr on one line>`
//   [[fake:turns:VARIANT]]         a stream-json run of TWO results (RO), as server-fake-claude.mjs's:
//                                  a long report, then a turn a background monitor's expiry started
//                                  (VARIANT user · system · bare · hooks · hooks-system), answered with one sentence; under
//                                  `--output-format json` only the last result, as the CLI prints it
//   [[tag:NAME]]                   a name for the run: the plain answer is `FAKE_OK NAME`
//
// A worker also appends, once it has read its prompt,
//   { kind: 'worker-mode', pid, t, mode, tag, account, dispatched, claudePid, promptLength,
//     promptBytes, promptSha256, promptBom, sysMarkers, cwd }
// — `dispatched` / `claudePid` are CCO_DISPATCHED_TASK / CLAUDE_PID from its environment (null
// when unset), `promptBom` whether the prompt holds a U+FEFF anywhere, `sysMarkers` every
// `SYSMARK-<x>` token in its argv (the system prompt is passed there) — and
// { kind: 'worker-exit', pid, t, how } when it ends normally or on SIGTERM.

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
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
log({ kind, argv: argv.slice(0, 6).map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)) });

if (kind === 'version') {
  say('9.9.9 (Claude Code)\n');
} else if (kind === 'auth') {
  say(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\n');
} else if (kind === 'usage') {
  say(JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\n');
} else if (kind === 'agents') {
  say('[]\n');
} else if (kind === 'stop') {
  say('');
} else if (kind === 'worker') {
  worker();
} else {
  process.stderr.write(`cco-fake-claude: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
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
    const sysMarkers = [...new Set([...argv.join('\n').matchAll(/SYSMARK-[A-Za-z0-9]+/g)].map((m) => m[0]))];
    log({
      kind: 'worker-mode',
      mode,
      tag,
      account,
      dispatched: process.env.CCO_DISPATCHED_TASK ?? null,
      claudePid: process.env.CLAUDE_PID ?? null,
      promptLength: prompt.length,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      promptSha256: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      promptBom: prompt.includes('﻿'),
      sysMarkers,
      cwd: process.cwd(),
    });
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
  const framed = (tag, body) => `BIG_BEGIN ${tag}\n${body}\nBIG_END ${tag}`;

  function run(mode, tag) {
    const [what, ...rest] = mode.split(':');
    if (what === 'hang') {
      setInterval(() => {}, 1 << 30);
    } else if (what === 'fail') {
      setTimeout(() => {
        process.stderr.write('cco-fake-claude: deterministic failure, nothing about any account\n', () => {
          log({ kind: 'worker-exit', how: 'exit 3' });
          process.exit(3);
        });
      }, 200);
    } else if (what === 'delay') {
      setTimeout(() => out(result(`FAKE_OK ${tag}`), 0), Number(rest[0]) || 0);
    } else if (what === 'lines') {
      const count = Number(rest[0]) || 1;
      const width = Number(rest[1]) || 80;
      const rows = [];
      for (let i = 1; i <= count; i++) {
        const head = `L${String(i).padStart(6, '0')} `;
        rows.push(head + 'x'.repeat(Math.max(0, width - head.length)));
      }
      out(result(framed(tag, rows.join('\n'))), 0);
    } else if (what === 'turns') {
      const stream = turnsStream(rest[0] ?? 'user', tag);
      out(argv.includes('json') ? stream.trimEnd().split('\n').at(-1) : stream, 0);
    } else if (what === 'wide') {
      out(result(framed(tag, '한'.repeat(Number(rest[0]) || 1))), 0);
    } else if (what === 'astral') {
      out(result(framed(tag, `${rest[1] ?? ''}${'\u{1F600}'.repeat(Number(rest[0]) || 1)}`)), 0);
    } else if (what === 'cco') {
      const cli = /\[\[cli:([^\]]+)\]\]/.exec(prompt)?.[1];
      if (cli === undefined) {
        out(result('CCO_EXIT none — no [[cli:PATH]] in the prompt'), 0);
        return;
      }
      const r = spawnSync(process.execPath, [cli, ...(rest.length > 0 ? rest : ['list_workers'])], {
        env: process.env,
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const err = String(r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      out(result(`CCO_EXIT ${r.status === null ? `signal ${r.signal}` : r.status} ${err}`), 0);
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
