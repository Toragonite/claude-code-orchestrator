#!/usr/bin/env node
// models-fake-claude.mjs — the stand-in `claude` of .orchestrator/fixes/models.mjs.
//
// Never the real CLI: no network, no login, no tokens. The dispatch server is pointed at this
// file through `registry.claudePath` and spawns it exactly as it spawns a worker
// (`claude -p --output-format json --model … --append-system-prompt …`, prompt on stdin).
//
// A copy of runner-fake-claude.mjs's skeleton (what one invocation does is chosen by the PROMPT
// it is handed), extended with the one thing that harness's fake does not do: it REPORTS A MODEL.
// A success prints the result document the real CLI printed for the alias it was asked for
// (models-fixtures.mjs — captured live), so `--model haiku` answers with a `modelUsage` keyed
// `claude-haiku-4-5-20251001`, exactly as Claude Code 2.1.283 does.
//
//   [[fake:ok]]                 success, reporting the model its `--model` resolves to (default)
//   [[fake:nomodel]]            success with NO `modelUsage` at all — an older or another CLI
//   [[fake:usage:NAME]]         success with the `modelUsage` named NAME in the file
//                               MODELS_FAKE_USAGE (a JSON object: NAME → any JSON value)
//
// That same file can say what ONE ACCOUNT's CLI resolves everything to: an entry named
// `@<account>` is the `modelUsage` every result of that account carries (success or plan-limit
// error), whatever `--model` it was given — two accounts whose CLIs are different versions.
//
//   [[fake:fail]]               a line on stderr, exit 3
//   [[fake:error-with-usage]]   an `is_error` result that nevertheless carries a `modelUsage`
//   [[fake:quota]]              the Claude CLI's plan-limit `is_error` result, every time
//   [[fake:quota-once:KEY]]     the same the FIRST time KEY is seen (with a `modelUsage` in it),
//                               success after that
//   [[fake:delay:MS]]           success after MS milliseconds
//   [[fake:finishing:MS]]       IGNORES SIGTERM and prints its success after MS milliseconds — a
//                               CLI past its last request when it is told to stop
//   [[fake:doc:NAME]]           success with the REAL result document NAME.json out of the
//                               directory MODELS_FAKE_DOCS names (its `result` replaced), e.g.
//                               `haiku-with-sonnet-subagent`: a run whose subagent used another model
//   [[tag:NAME]]                a name for the run in the log (default: the mode)
//
// Every worker invocation appends to the file MODELS_FAKE_LOG names:
//   { ev: 'run', pid, t, mode, tag, account, argv, model }   once the prompt was read
// `account` is the base name of CLAUDE_CONFIG_DIR; `model` is the value after `--model`, or
// null when no `--model` was passed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import { RESOLVED, RESULT_DOCUMENTS } from './models-fixtures.mjs';

const argv = process.argv.slice(2);
const LOG = process.env.MODELS_FAKE_LOG || '';

function log(record) {
  if (LOG === '') return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...record }) + '\n');
  } catch {
    // an unwritable log is the test's problem to report, not a reason to change the run
  }
}

function out(text, code) {
  process.stdout.write(text, () => process.exit(code));
}

if (argv.includes('auth') && argv.includes('status')) {
  out(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stub@example.invalid' }) + '\n', 0);
} else if (argv.includes('stream-json')) {
  out(JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false } } }) + '\n', 0);
} else if (!argv.includes('-p')) {
  process.stderr.write(`models-fake-claude: unsupported invocation ${JSON.stringify(argv.slice(0, 4))}\n`, () => process.exit(2));
} else {
  worker();
}

/** MODELS_FAKE_USAGE as an object; {} when it names no readable JSON object. */
function usageTable() {
  try {
    const table = JSON.parse(fs.readFileSync(process.env.MODELS_FAKE_USAGE || '', 'utf8'));
    return typeof table === 'object' && table !== null ? table : {};
  } catch {
    return {};
  }
}

/** The `modelUsage` the real CLI would print for `model`: the captured one for an alias. */
function usageFor(model) {
  const account = path.basename((process.env.CLAUDE_CONFIG_DIR || '').replace(/[/\\]+$/, ''));
  const table = usageTable();
  if (Object.hasOwn(table, `@${account}`)) {
    return table[`@${account}`];
  }
  if (Object.hasOwn(RESULT_DOCUMENTS, model)) {
    return RESULT_DOCUMENTS[model].modelUsage;
  }
  // A full id runs as itself (with the small haiku helper entry beside it, as on the real CLI).
  return {
    [RESOLVED.haiku]: { inputTokens: 897, outputTokens: 10, costUSD: 0.000947 },
    [model]: { inputTokens: 2, outputTokens: 4, costUSD: 0.2 },
  };
}

function worker() {
  const at = argv.indexOf('--model');
  const model = at >= 0 && typeof argv[at + 1] === 'string' ? argv[at + 1] : null;
  process.once('SIGTERM', () => process.kill(process.pid, 'SIGTERM'));

  let prompt = '';
  let began = false;
  const begin = () => {
    if (began) return;
    began = true;
    const mode = /\[\[fake:([^\]]+)\]\]/.exec(prompt)?.[1] ?? 'ok';
    const tag = /\[\[tag:([^\]]+)\]\]/.exec(prompt)?.[1] ?? mode;
    const account = path.basename((process.env.CLAUDE_CONFIG_DIR || '').replace(/[/\\]+$/, '')) || '(default)';
    log({ ev: 'run', mode, tag, account, argv, model });
    run(mode, tag);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', begin);
  process.stdin.on('error', begin);
  setTimeout(begin, 3000);

  /** A success document: the captured one's shape, this run's text, the chosen `modelUsage`. */
  const success = (tag, modelUsage) => {
    const base = Object.hasOwn(RESULT_DOCUMENTS, model ?? '') ? RESULT_DOCUMENTS[model] : RESULT_DOCUMENTS.opus;
    const doc = { ...base, result: `FAKE_OK ${tag}`, usage: { ...base.usage, input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.001 };
    if (modelUsage === undefined) {
      delete doc.modelUsage;
    } else {
      doc.modelUsage = modelUsage;
    }
    return JSON.stringify(doc);
  };
  const quota = () =>
    JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1760000000', modelUsage: usageFor(model ?? 'opus') });

  function run(mode, tag) {
    const [kind, ...rest] = mode.split(':');
    const arg = rest.join(':');
    if (kind === 'nomodel') {
      out(success(tag, undefined), 0);
    } else if (kind === 'usage') {
      const table = usageTable();
      // `null` and every other JSON value are passed on as they are: that is the point.
      const doc = JSON.parse(success(tag, {}));
      doc.modelUsage = Object.hasOwn(table, arg) ? table[arg] : undefined;
      out(JSON.stringify(doc), 0);
    } else if (kind === 'fail') {
      setTimeout(() => {
        process.stderr.write('models-fake-claude: deterministic failure, nothing about any account\n', () => process.exit(3));
      }, 200);
    } else if (kind === 'error-with-usage') {
      setTimeout(() => out(JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'the run failed', modelUsage: usageFor(model ?? 'opus') }), 0), 200);
    } else if (kind === 'quota') {
      setTimeout(() => out(quota(), 0), 200);
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
      setTimeout(() => out(first ? quota() : success(tag, usageFor(model ?? 'opus')), 0), 200);
    } else if (kind === 'delay') {
      setTimeout(() => out(success(tag, usageFor(model ?? 'opus')), 0), Number(arg) || 0);
    } else if (kind === 'finishing') {
      process.removeAllListeners('SIGTERM');
      process.on('SIGTERM', () => log({ ev: 'sigterm-ignored', tag }));
      setTimeout(() => out(success(tag, usageFor(model ?? 'opus')), 0), Number(arg) || 0);
    } else if (kind === 'doc') {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(process.env.MODELS_FAKE_DOCS || '', `${arg.replace(/[^A-Za-z0-9_-]/g, '_')}.json`), 'utf8'));
      } catch {
        doc = undefined;
      }
      if (typeof doc !== 'object' || doc === null) {
        process.stderr.write(`models-fake-claude: no document ${JSON.stringify(arg)} under MODELS_FAKE_DOCS\n`, () => process.exit(4));
      } else {
        out(JSON.stringify({ ...doc, result: `FAKE_OK ${tag}` }), 0);
      }
    } else {
      out(success(tag, usageFor(model ?? 'opus')), 0);
    }
  }
}
