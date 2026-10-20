#!/usr/bin/env node
// models-fake-codex.mjs — a stand-in `codex` for ONE thing: `codex app-server`, asked for its
// models, for .orchestrator/fixes/models.mjs. It speaks the protocol the real one (0.162.1) was
// seen to speak: JSON-RPC, one message per line on stdin and stdout —
//
//   → {"id":1,"method":"initialize","params":{"clientInfo":{"name":…,"title":…,"version":…}}}
//   ← {"id":1,"result":{"userAgent":…,"codexHome":…,"platformFamily":…,"platformOs":…}}
//   → {"method":"initialized"}
//   → {"id":2,"method":"model/list","params":{}}            (or {"cursor":"…"})
//   ← {"id":2,"result":{"data":[{id, model, displayName, description, isDefault,
//                                supportedReasoningEfforts:[{reasoningEffort, description}]}],
//                       "nextCursor":null|"…"}}
//
// and it ends when its stdin does, as a server whose client has gone. A request other than
// `initialize` before the `initialized` notification gets an error, as from a server that is
// strict about the handshake.
//
// Never a real CLI: it reads nothing but its own arguments and stdin, touches no home directory,
// opens no connection. It is started through a launcher the test writes into a sandbox's `bin/`:
//
//   exec node models-fake-codex.mjs --mode=<mode> [--log=<file>] "$@"
//
//   --mode=ok          the seven models the real CLI listed (gpt-6.1-sol the default)
//   --mode=paged:<N>   the same seven over N pages, chained by `nextCursor`
//   --mode=hostile     600 entries: a 10 kB displayName, `$(icon)` in a name, ids no model rule
//                      takes (`__proto__`, one with a space), junk efforts, several defaults
//   --mode=gated       the seven, plus the two ids only an API-key login may select
//                      (`gpt-5.1-codex-max`, `gpt-5.2`)
//   --mode=error       `model/list` answers a JSON-RPC error
//   --mode=garbage     prints lines that are not JSON, then ends with stdin, exit 0
//   --mode=exit1       answers like `ok`, then exits 1
//   --mode=no-exit     answers like `ok`, and does NOT end when stdin closes
//   --mode=deaf        answers nothing and never ends (dies on SIGTERM)
//   --mode=deaf-hard   the same, ignoring SIGTERM (only SIGKILL ends it)
//
// Anything but `app-server` exits 2. With --log, records are appended to the file: one
// { ev: 'start', pid, argv, codexHome, foreign } per invocation (`foreign`: the names of any
// ANTHROPIC_* / CLAUDE_* / CLAUDECODE variable it was given), { ev: 'got', pid, method, cursor }
// per message read, and { ev: 'end', pid, why } when it ends by itself.

import * as fs from 'node:fs';
import process from 'node:process';
import * as readline from 'node:readline';

const own = {};
const argv = [];
for (const a of process.argv.slice(2)) {
  const m = /^--(mode|log)=(.*)$/s.exec(a);
  if (m && argv.length === 0) {
    own[m[1]] = m[2];
  } else {
    argv.push(a);
  }
}
const [mode, ...rest] = String(own.mode ?? 'ok').split(':');
const arg = rest.join(':');

const log = (record) => {
  if (!own.log) return;
  try {
    fs.appendFileSync(own.log, JSON.stringify({ pid: process.pid, t: Date.now(), ...record }) + '\n');
  } catch {
    // evidence only
  }
};
log({ ev: 'start', mode, argv, codexHome: process.env.CODEX_HOME ?? null, foreign: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_)/i.test(k) || k === 'CLAUDECODE') });
process.stdout.on('error', () => process.exit(1));

if (argv[0] !== 'app-server') {
  process.stderr.write(`fake codex: only app-server is played here, not ${JSON.stringify(argv[0] ?? '')}\n`);
  process.exit(2);
}

if (mode === 'deaf' || mode === 'deaf-hard') {
  if (mode === 'deaf-hard') {
    process.on('SIGTERM', () => log({ ev: 'ignored-sigterm' }));
  }
  process.stdin.resume();
  process.stdin.on('data', () => {});
  setInterval(() => {}, 1 << 30);
} else {
  const effort = (e) => ({ reasoningEffort: e, description: `${e} reasoning` });
  const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'].map(effort);
  const REAL = [
    ['gpt-6.1-sol', 'GPT-6.1 Sol', true],
    ['gpt-6-astra', 'GPT-6 Astra', false],
    ['gpt-6-sol', 'GPT-6 Sol', false],
    ['gpt-6-luna', 'GPT-6 Luna', false],
    ['gpt-5.6-sol', 'GPT-5.6 Sol', false],
    ['gpt-5.6-terra', 'GPT-5.6 Terra', false],
    ['gpt-5.6-luna', 'GPT-5.6 Luna', false],
  ].map(([id, displayName, isDefault]) => ({ id, model: id, displayName, description: `${displayName}, as the CLI describes it`, isDefault, supportedReasoningEfforts: EFFORTS }));
  const hostile = () => {
    const out = [];
    out.push({ id: 'gpt-h-long', model: 'gpt-h-long', displayName: `Long ${'n'.repeat(10_000)}`, isDefault: true, supportedReasoningEfforts: [...EFFORTS, effort('ultra'), effort('mega'), effort('giga')] });
    out.push({ id: 'gpt-h-icon', model: 'gpt-h-icon', displayName: '$(icon) Icon Model', isDefault: true, supportedReasoningEfforts: [effort('UPPER'), effort('has space'), effort('x'.repeat(40)), effort('ok-1'), 'low', 42, null] });
    out.push({ id: '__proto__', model: '__proto__', displayName: 'Proto', isDefault: false });
    out.push({ id: 'two words', model: 'two words', displayName: 'Two Words', isDefault: false });
    for (let i = 0; out.length < 600; i++) {
      out.push({ id: `gpt-h-${i}`, model: `gpt-h-${i}`, displayName: `H ${i}`, isDefault: i % 50 === 0, supportedReasoningEfforts: EFFORTS });
    }
    return out;
  };
  const pages = mode === 'paged' ? Math.max(1, Number(arg) || 2) : 1;
  const gatedExtra = ['gpt-5.1-codex-max', 'gpt-5.2'].map((id) => ({ id, model: id, displayName: id.toUpperCase(), description: 'API key only', isDefault: false, supportedReasoningEfforts: EFFORTS }));
  const listing = mode === 'hostile' ? hostile() : mode === 'gated' ? [...REAL, ...gatedExtra] : REAL;
  const pageOf = (cursor) => {
    const index = typeof cursor === 'string' && /^c(\d+)$/.test(cursor) ? Number(cursor.slice(1)) : 0;
    const size = Math.ceil(listing.length / pages);
    const data = listing.slice(index * size, (index + 1) * size);
    return { data, nextCursor: index + 1 < pages ? `c${index + 1}` : null };
  };
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let initialized = false;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (mode === 'garbage') {
      process.stdout.write('this is not json\n{"half":\n');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    log({ ev: 'got', method: message?.method ?? null, cursor: message?.params?.cursor ?? null });
    if (message?.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.162.1 (fake)', codexHome: process.env.CODEX_HOME ?? null, platformFamily: 'unix', platformOs: 'macos' } });
    } else if (message?.method === 'initialized') {
      initialized = true;
    } else if (!initialized) {
      send({ id: message?.id ?? null, error: { code: -32002, message: 'Not initialized' } });
    } else if (message?.method === 'model/list') {
      if (mode === 'error') {
        send({ id: message.id, error: { code: -32603, message: 'model list unavailable' } });
      } else {
        send({ id: message.id, result: pageOf(message?.params?.cursor) });
      }
    } else {
      send({ id: message?.id ?? null, error: { code: -32601, message: 'Method not found' } });
    }
  });
  rl.on('close', () => {
    if (mode === 'no-exit') {
      log({ ev: 'stdin-closed-staying' });
      setInterval(() => {}, 1 << 30);
      return;
    }
    log({ ev: 'end', why: 'stdin closed' });
    process.stdout.write('', () => process.exit(mode === 'exit1' ? 1 : 0));
  });
}
