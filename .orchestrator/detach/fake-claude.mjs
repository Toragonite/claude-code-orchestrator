#!/usr/bin/env node
// fake-claude.mjs — a deterministic, hermetic stand-in for the `claude` CLI used
// by the Phase 0 detach characterization harness. No network, no login, no real
// tokens. The dispatch server resolves this file as `claudePath` (an absolute,
// executable path) and spawns it exactly as it spawns the real worker binary.
//
// Worker spawn shape (src/mcp/task-runner.ts → runClaude):
//   claude -p --output-format json --model <m> --permission-mode <p> \
//          --append-system-prompt <combined system prompt>
// with the USER PROMPT delivered on stdin. runClaude parses stdout as ONE JSON
// object and reads: result, usage.input_tokens, usage.output_tokens,
// total_cost_usd, is_error, subtype (see settle() in task-runner.ts).
//
// Behaviour is selected by FAKE_CLAUDE_MODE, which the probe sets on the server's
// env and which reaches this child because the worker environment (platform.claudeEnv)
// removes only the session-identity variables and passes everything else through:
//   success (default) : print a success JSON, exit 0
//   quota             : print an is_error JSON whose text trips isQuotaError, exit 0
//   hang              : ignore stdin EOF, stay alive forever (dies only on a signal)
//   fail              : exit non-zero with a NON-quota message
//   delay:MS          : behave as success after MS milliseconds
//   failover          : per CLAUDE_CONFIG_DIR basename — `.../wa` → quota,
//                       anything else (e.g. `.../wb`) → success  (drives P0-7)
//   failover-slow     : same wa→quota / wb→success split, but each response is
//                       delayed FAKE_CLAUDE_SLOW_MS (default 50000). Two attempts sum
//                       past the OLD single-attempt detach ceiling yet each stays under
//                       the per-attempt worker timeout — drives P4-F3.
//
// It also answers an accidental `claude auth status --json` probe or a
// stream-json usage probe with a quick minimal success, so a stray live probe can
// never hang a run.
//
// RECORDING (opt-in). With FAKE_CLAUDE_RECORD=<file> set, EVERY invocation — worker
// run, auth probe, anything — appends one JSON line to that file before doing anything
// else:
//   { pid, argv, cwd, envKeys, env }
// `envKeys` is the sorted list of every environment variable NAME this process was
// started with: enough to assert that a variable is ABSENT, which is what the
// environment probes are about. `env` carries VALUES, and only for the names listed in
// FAKE_CLAUDE_RECORD_VALUES (comma-separated). Values are opt-in per name on purpose:
// this process inherits the developer's real shell environment, and a harness that
// copied all of it into a temp file would be writing their API keys to disk. The probe
// names only variables it has itself set to marker values.
// The file is the probe's proof of what was spawned and how — and, when it does not
// exist after a dispatch, that nothing was spawned at all.

import * as fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);

recordInvocation();

/** Append this invocation to FAKE_CLAUDE_RECORD. Never throws: a recorder must not change a run. */
function recordInvocation() {
  const file = process.env.FAKE_CLAUDE_RECORD;
  if (!file) return;
  try {
    const wanted = (process.env.FAKE_CLAUDE_RECORD_VALUES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const env = {};
    for (const name of wanted) {
      // Own-property test, not truthiness: an EMPTY value is still a variable that was passed.
      if (Object.prototype.hasOwnProperty.call(process.env, name)) env[name] = process.env[name];
    }
    const line = JSON.stringify({
      pid: process.pid,
      argv,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env).sort(),
      env,
    });
    // One appendFileSync is one O_APPEND write, so concurrent workers never interleave lines.
    fs.appendFileSync(file, line + '\n');
  } catch {
    // unwritable record file — the probe reading it will say so; the run itself is unaffected
  }
}

// Defensive: a live auth-status probe (claude auth status --json) → quick success.
if (argv.includes('auth') && argv.includes('status')) {
  writeAndExit(
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.com' }) + '\n',
    0,
  );
}

// Defensive: a stream-json get_usage probe → one control_response success, then exit.
if (argv.includes('stream-json')) {
  writeAndExit(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', response: { rate_limits_available: false } },
    }) + '\n',
    0,
  );
}

/** Stable marker the probe asserts on in the returned text and the output file. */
const MARKER = 'STUB_RESULT_OK';

/** Success payload the server parses into text + usage. Fixed values so probes can pin them. */
function successJson() {
  return JSON.stringify({
    result: MARKER,
    usage: { input_tokens: 11, output_tokens: 22 },
    total_cost_usd: 0.001,
  });
}

/**
 * Quota payload. The server's settle() takes the is_error branch and rejects with
 * `Worker error (<subtype>): <result>`, which dispatchTask classifies via
 * isQuotaError (/quota|usage limit|rate.?limit|…|429|529/i). Both the phrase and
 * the code below match, so the run is treated as a quota failure and fails over.
 */
function quotaJson() {
  return JSON.stringify({
    is_error: true,
    subtype: 'rate_limit_error',
    result: 'Rate limit exceeded — usage limit reached (429).',
  });
}

/** Write to stdout and exit only once the bytes are flushed (pipe writes are async). */
function writeAndExit(text, code) {
  process.stdout.write(text, () => process.exit(code));
}

/**
 * Consume stdin (the prompt) to completion, then run `cb`. Reading to EOF mirrors
 * the real CLI and, crucially, lets the server's `stdin.end()` complete so writing
 * the prompt never trips EPIPE against a child that exited early. 'end' fires
 * within milliseconds because runClaude ends stdin synchronously after spawn; the
 * timeout is only a safety net for a server that died before sending anything.
 */
function afterPrompt(cb) {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    cb();
  };
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', fire);
  process.stdin.on('error', fire);
  setTimeout(fire, 3000);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'success';

if (mode === 'hang') {
  // Ignore stdin EOF; keep the event loop alive forever. Spawned detached, this
  // process leads its own group, so the server's SIGTERM (to -pid) terminates it
  // via the default signal action — exactly the D4/D5 kill paths under test.
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
  setInterval(() => {}, 1 << 30);
} else if (mode === 'quota') {
  afterPrompt(() => writeAndExit(quotaJson(), 0));
} else if (mode === 'fail') {
  afterPrompt(() => {
    process.stderr.write('fake-claude: deterministic non-quota failure\n');
    process.exit(3);
  });
} else if (mode.startsWith('delay:')) {
  const ms = Number(mode.slice('delay:'.length)) || 0;
  afterPrompt(() => setTimeout(() => writeAndExit(successJson(), 0), ms));
} else if (mode === 'failover') {
  const dir = process.env.CLAUDE_CONFIG_DIR || '';
  const base = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  afterPrompt(() => writeAndExit(base === 'wa' ? quotaJson() : successJson(), 0));
} else if (mode === 'failover-slow') {
  // wa → quota, wb → success, each after FAKE_CLAUDE_SLOW_MS. The supervisor spends
  // roughly 2×slow across the failover; with a 1-minute task timeout that exceeds the
  // OLD 90s single-attempt detach ceiling, so only the F3 liveness-aware wait relays it.
  const dir = process.env.CLAUDE_CONFIG_DIR || '';
  const base = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  const slowMs = Number(process.env.FAKE_CLAUDE_SLOW_MS) || 50000;
  afterPrompt(() =>
    setTimeout(() => writeAndExit(base === 'wa' ? quotaJson() : successJson(), 0), slowMs),
  );
} else {
  afterPrompt(() => writeAndExit(successJson(), 0));
}
