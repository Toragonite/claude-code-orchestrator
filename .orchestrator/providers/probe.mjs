#!/usr/bin/env node
// probe.mjs — black-box probes V1–V20 for the v2.0.0 provider workers (Codex, Cursor,
// Antigravity), plus the extras X1–X7.
//
//   node .orchestrator/providers/probe.mjs                 V1–V20, then the extras
//   node .orchestrator/providers/probe.mjs V3 V7           a subset
//   node .orchestrator/providers/probe.mjs --no-extras     only the twenty rows of the table
//   node .orchestrator/providers/probe.mjs --jobs 1        one probe at a time (default 4)
//   node .orchestrator/providers/probe.mjs --verbose       print sandbox diagnostics for passes too
//   node .orchestrator/providers/probe.mjs --list          list the probes and exit
//   node .orchestrator/providers/probe.mjs --selftest      prove the fakes against the REAL adapters (no server)
//
// Each probe builds a fresh sandbox (fake HOME, fake vendor CLIs, one workspace), starts the
// real compiled server (`out/mcp/server.js`) over stdio, and asserts one row of the probe
// table in the P-HARNESS task, which restates .orchestrator/contract-2.0-providers.md §10.2,
// §10.3 and §10.5. It prints
//
//   PASS — <id> <name>: <what was observed>
//   FAIL — <id> <name>: <expected vs observed>
//
// then a tally, and exits 1 when anything failed.
//
// The probes are written against the CONTRACT, not the implementation. Two kinds of
// expectation appear, and a FAIL line says which one broke:
//   - a row expectation — what the probe table itself says;
//   - a pinned expectation, tagged `[§x.y …]` — text or behaviour a contract clause (or a
//     doc comment of the frozen src/providers.ts) spells out and that the same scenario
//     makes observable.
// Things the contract leaves open are reported as notes on the PASS line and never fail.

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import { CURSOR_IDENTITY, RAW_MARKER, TEXTS, TOKENS } from './fake-vendor.mjs';
import {
  CLAUDE_ONESHOT_MARKER,
  KEEP_SANDBOXES,
  MODEL_FORMS_HINT,
  PASSTHROUGH_VALUE,
  PROVIDERS,
  PROVIDER_CLI_JS,
  RUN_TASK_JS,
  SECRETS,
  SERVER_JS,
  SESSION_IDENTITY_ENV,
  VENDOR_CLIS,
  assertBuilt,
  cleanupAll,
  clip,
  hermeticVerdict,
  isPidAlive,
  leftoverSandboxes,
  makeFixture,
  pgidOf,
  providerModelHint,
  readJson,
  runNode,
  settleStrays,
  sleep,
  waitFor,
} from './helpers.mjs';
import { runSelfTest } from './selftest.mjs';

/* ------------------------------------------------------------------------- *
 * Expectation bookkeeping
 * ------------------------------------------------------------------------- */

class ProbeFailure extends Error {}

/**
 * Things a probe SAW that no contract clause pins but that somebody should look at. They
 * never fail a probe; they are repeated in their own section at the end of the run so that
 * they are not lost inside a PASS line.
 */
const FINDINGS = [];

class Checks {
  constructor() {
    this.failures = [];
    this.notes = [];
  }
  /** A row expectation from the probe table. */
  must(cond, expected, observed) {
    if (!cond) {
      this.failures.push(`expected ${expected}; observed ${fmt(observed)}`);
    }
    return Boolean(cond);
  }
  /** An expectation a contract clause pins; `clause` names it. */
  pinned(clause, cond, expected, observed) {
    if (!cond) {
      this.failures.push(`[${clause}] expected ${expected}; observed ${fmt(observed)}`);
    }
    return Boolean(cond);
  }
  /** Something worth reporting that the contract does not pin. Never fails. */
  note(text) {
    this.notes.push(text);
  }
  /** A note that deserves a decision: also listed at the end of the run. Never fails. */
  finding(probeId, text) {
    this.notes.push(`FINDING: ${text}`);
    FINDINGS.push(`${probeId}: ${text}`);
  }
  done(summary) {
    if (this.failures.length > 0) {
      throw new ProbeFailure(this.failures.join(' | '));
    }
    return this.notes.length > 0 ? `${summary} (notes: ${this.notes.join('; ')})` : summary;
  }
}

function fmt(v) {
  if (v === undefined) {
    return 'nothing';
  }
  return clip(typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v), 460);
}

/** How long one `tools/call` may take. Generous: a loaded machine starts a Node process slowly. */
const CALL_MS = 120_000;

const TIMEOUT_TEXT = /timed out|time[- ]?out/i;
const LOGIN_TEXT = /log(?:ged)?[ -]?(?:in|out)|\blogin\b|sign(?:ed)?[ -]?in|authenticat|unauthori[sz]ed|credential/i;
const NO_TEXT = /no text|without a final answer|no final answer|empty (?:answer|result|text|response)/i;
const PARKED_TEXT = /ended its turn without writing the result file/;
const ESCALATION_FLAG = /^(?:--force|-f|--yolo|--dangerously.*)$/;

/**
 * The header of a dispatch result:
 *   [⚠ … prefix lines]
 *   [worker: <account>, model: <model>(, provider: <id>)]
 *   task: <id> · output: <path>
 *   <key>: <value> …            (conversation: / peer: / worktree:)
 *   <blank>
 *   <the worker's text>
 */
function parseResult(text) {
  const lines = String(text).split('\n');
  let i = 0;
  while (i < lines.length && i < 6 && !lines[i].startsWith('[worker: ')) {
    i++;
  }
  const head = /^\[worker: (.*?), model: (.*?)(?:, provider: (.*?))?\]$/.exec(lines[i] ?? '');
  const task = /^task: (\S+) · output: (.+)$/.exec(lines[i + 1] ?? '');
  const extras = {};
  let j = i + 2;
  for (; j < lines.length && lines[j] !== ''; j++) {
    const m = /^([a-z]+): (.*)$/.exec(lines[j]);
    if (!m) {
      break;
    }
    extras[m[1]] = m[2];
  }
  return {
    ok: head !== null && task !== null,
    prefix: lines.slice(0, i),
    startsWithHeader: i === 0 && head !== null,
    line1: lines[i],
    line2: lines[i + 1],
    worker: head?.[1],
    model: head?.[2],
    provider: head?.[3],
    taskId: task?.[1],
    outputFile: task?.[2],
    extraLines: lines.slice(i + 2, j),
    conversation: extras.conversation,
    peer: extras.peer,
    body: lines.slice(j + 1).join('\n'),
  };
}

const head = (text, n = 4) => String(text).split('\n').slice(0, n).join(' ⏎ ');

/** Statuses of some events, in order. */
function statuses(events) {
  return events.map((e) => e.status).join(' → ') || '(no events)';
}

/** Everything a run's argv carries except the prompt (which may say anything). */
function flagsOf(run) {
  const argv = run.argv;
  const at = argv.lastIndexOf(run.parsed.prompt);
  return at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 1)] : argv;
}

/** `--model <value>` as it appears in a run's argv, or undefined. */
function modelFlag(run) {
  const flags = flagsOf(run);
  const at = flags.indexOf('--model');
  return at >= 0 ? flags[at + 1] : undefined;
}

/** The permission flag and its value in a run's argv (`--sandbox X` / `--mode X`), or 'none'. */
function permissionOf(run) {
  const flags = flagsOf(run);
  const at = flags.indexOf(run.parsed.permissionFlag);
  return at >= 0 ? `${run.parsed.permissionFlag} ${flags[at + 1]}` : 'none';
}

/**
 * Where a secret or a raw vendor payload leaked to. Scans every tool result handed in, the
 * task log, every file under tasks/, the usage and stats files and the servers' stderr.
 */
function leaks(fx, texts = []) {
  const needles = {
    'the raw vendor payload marker': RAW_MARKER,
    'the planted id token': SECRETS.idToken,
    'the planted access token': SECRETS.accessToken,
    'the planted refresh token': SECRETS.refreshToken,
    'the planted API key': SECRETS.apiKey,
  };
  const hay = texts.map((t, i) => [`tool result #${i + 1}`, String(t)]);
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  for (const name of ['tasks.jsonl', 'usage.json', 'stats.json', 'orchestrators.json']) {
    hay.push([name, read(path.join(fx.orchRoot, name))]);
  }
  let names = [];
  try {
    names = fs.readdirSync(fx.tasksDir);
  } catch {
    // no tasks directory
  }
  for (const n of names) {
    hay.push([`tasks/${n}`, read(path.join(fx.tasksDir, n))]);
  }
  fx.servers.forEach((srv, i) => hay.push([`server #${i + 1} stderr`, srv.stderr]));
  const found = [];
  for (const [where, text] of hay) {
    for (const [what, needle] of Object.entries(needles)) {
      if (text.includes(needle)) {
        found.push(`${what} in ${where}`);
      }
    }
  }
  return found;
}

/** Workers whose stats carry a failure or a cooldown. */
function penalized(fx) {
  return Object.entries(fx.stats())
    .filter(([, s]) => s && (s.errors > 0 || (Number.isFinite(s.cooldownUntil) && s.cooldownUntil > Date.now())))
    .map(([name, s]) => `${name}: errors ${s.errors ?? 0}${s.cooldownUntil > Date.now() ? ', cooling down' : ''}`);
}

/** Rewrite one worker's registry entry (the server reads the registry on every dispatch). */
function patchWorker(fx, name, patch) {
  const file = path.join(fx.orchRoot, 'registry.json');
  const registry = readJson(file);
  const entry = registry.workers.find((w) => w.name === name);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete entry[k];
    } else {
      entry[k] = v;
    }
  }
  const tmp = `${file}.probe.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, file);
}

/** The block of `list_workers` output that belongs to one worker: its `- <name>` line and what is indented under it. */
function workerBlock(text, name) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => new RegExp(`^- ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(l));
  if (at < 0) {
    return undefined;
  }
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) {
    end++;
  }
  return lines.slice(at, end).join('\n');
}

/* ------------------------------------------------------------------------- *
 * V1 — no worker, no provider → Claude Code only
 * ------------------------------------------------------------------------- */

async function v1(t) {
  const c = new Checks();
  // The Codex worker is FIRST in the registry: a selection that walked every worker would hit it.
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }, { name: 'wa' }] });
  const srv = await fx.startServer();
  const texts = [];
  for (let i = 1; i <= 3; i++) {
    const r = await srv.callTool('dispatch_task', { title: `V1 one-shot ${i}`, prompt: 'V1: answer in one line.' }, CALL_MS);
    const h = parseResult(r.text);
    texts.push(r.text);
    c.must(!r.isError && h.worker === 'wa', `dispatch ${i} (no worker, no provider) to run on the Claude Code worker wa`, head(r.text));
    c.pinned('§10.3 result header', h.provider === undefined, 'no `provider:` field in a Claude worker header', h.line1);
  }
  const oneShots = fx.claudeOneShots();
  c.must(oneShots.length === 3 && oneShots.every((o) => o.configDir === fx.worker('wa').configDir), "three `claude -p` runs under wa's config dir", oneShots.map((o) => o.configDir));
  c.must(fx.invocations('codex').length === 0, 'the Codex fake never to be invoked', fx.invocations('codex').map((x) => x.argv.slice(0, 3)));
  c.pinned('§10.3 task events', fx.events().every((e) => !Object.hasOwn(e, 'provider')), 'no `provider` key on a Claude task event', fx.events().filter((e) => Object.hasOwn(e, 'provider')).map((e) => `${e.status}:${e.provider}`));
  await srv.stop();

  // The session-worker core must make the same choice (§10.3 Routing).
  const mesh = t.fixture({ workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'cx', provider: 'codex' }, { name: 'wa' }], claude: { bg: { default: 'result-done' } } });
  const msrv = await mesh.startServer();
  const how = [];
  for (let i = 1; i <= 2; i++) {
    const r = await msrv.callTool('dispatch_task', { title: `V1 mesh ${i}`, prompt: 'V1: report done.' }, CALL_MS);
    const h = parseResult(r.text);
    c.pinned('§10.3 Routing ("the mesh core only ever selects Claude workers")', !r.isError && h.worker === 'wa' && h.provider === undefined, `mesh-on dispatch ${i} to run on wa`, head(r.text));
    how.push(r.text.startsWith('⚠') ? 'one-shot fallback' : h.peer !== undefined ? 'session worker' : 'one-shot');
  }
  const spawned = [...mesh.claudeBgSpawns(), ...mesh.claudeOneShots()];
  c.pinned('§10.3 Routing', spawned.length >= 2 && spawned.every((s) => s.configDir === mesh.worker('wa').configDir), "every claude worker spawn under wa's config dir", spawned.map((s) => `${s.kind}:${s.configDir}`));
  c.pinned('§10.3 Routing', mesh.invocations('codex').length === 0, 'the Codex fake never invoked with mesh on either', mesh.invocations('codex').map((x) => x.argv.slice(0, 3)));
  return c.done(`3 one-shot dispatches and 2 mesh-on dispatches (${how.join(', ')}) all ran on wa; the Codex fake was never invoked; no provider key on any event`);
}

/* ------------------------------------------------------------------------- *
 * V2 — only a Codex worker, no worker/provider
 * ------------------------------------------------------------------------- */

async function v2(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }] });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'V2 no claude worker', prompt: 'V2: never runs.' }, CALL_MS);
  c.must(r.isError && /claude/i.test(r.text), 'an error saying no Claude Code worker is usable', r.text);
  const r2 = await srv.callTool('dispatch_task', { title: 'V2 no cursor worker', prompt: 'V2: never runs.', provider: 'cursor' }, CALL_MS);
  c.pinned('§10.3 Selection 2 ("an error that says which provider had no usable worker")', r2.isError && /cursor/i.test(r2.text), 'provider "cursor" with no Cursor worker → an error naming Cursor', r2.text);
  const spawned = [...fx.vendorLog(), ...fx.claudeLog()];
  c.must(spawned.length === 0, 'nothing spawned', spawned.map((x) => `${x.vendor ?? 'claude'}:${x.kind}`));
  c.pinned('§10.3 Selection', !fx.events().some((e) => e.status === 'running' || e.status === 'done'), 'no running/done event for a dispatch that had no candidate', statuses(fx.events()));
  c.pinned('§10.3 Selection', penalized(fx).length === 0, 'no failure recorded against the Codex worker', penalized(fx));
  return c.done(`"${clip(r.text, 150)}"; nothing spawned`);
}

/* ------------------------------------------------------------------------- *
 * V3 — provider: "codex"
 * ------------------------------------------------------------------------- */

async function v3(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex', model: 'gpt-5.6-sol' }] });
  const srv = await fx.startServer();
  const prompt = 'V3-TASK-TEXT: answer in one line.';
  const r = await srv.callTool('dispatch_task', { title: 'V3 codex', prompt, provider: 'codex' }, CALL_MS);
  const h = parseResult(r.text);
  const runs = fx.runs('codex');
  const run = runs[0];
  c.must(!r.isError, 'the dispatch to succeed', r.text);
  c.must(runs.length === 1 && run.argv[0] === 'exec' && run.argv.includes('--json'), 'exactly one `codex exec --json` invocation of the fake', runs.map((x) => x.argv.slice(0, 4)));
  if (!run) {
    return c.done('');
  }
  c.must(h.startsWithHeader && h.line1 === '[worker: cx, model: gpt-5.6-sol, provider: codex]', 'header line 1 `[worker: cx, model: gpt-5.6-sol, provider: codex]`', head(r.text));
  const outFile = h.taskId ? path.join(fx.tasksDir, `${h.taskId}.md`) : undefined;
  c.must(h.taskId !== undefined && h.outputFile === outFile && fs.existsSync(outFile), 'header line 2 `task: <id> · output: <absolute path of tasks/<id>.md>`, naming an existing file', h.line2);
  c.must(h.extraLines[0] === `conversation: ${run.conversationId}`, `line 3 \`conversation: ${run.conversationId}\` (the id the fake returned)`, h.extraLines);
  c.must(h.body.trim() === run.text, "the fake's text as the result body", clip(h.body, 200));
  const events = fx.eventsOfTask(h.taskId);
  const done = events.filter((e) => e.status === 'done');
  c.must(done.length === 1 && done[0].provider === 'codex', 'one `done` event carrying provider: "codex"', events.map((e) => `${e.status}:${e.provider}`));
  c.must(done[0]?.inputTokens === TOKENS.codex.input && done[0]?.outputTokens === TOKENS.codex.output, `the fake's token counts (${TOKENS.codex.input} in / ${TOKENS.codex.output} out) on the done event`, { inputTokens: done[0]?.inputTokens, outputTokens: done[0]?.outputTokens });
  const stats = fx.stats().cx;
  c.pinned('§10.3 Selection 4 (stats "exactly as today")', stats?.tasks === 1 && stats.inputTokens === TOKENS.codex.input && stats.outputTokens === TOKENS.codex.output, "the run and its tokens in the worker's stats", stats);
  c.pinned('§10.3 adapter construction', run.cwd === fx.workspace, 'the vendor child to run in the workspace', run.cwd);
  const sent = run.parsed.prompt;
  c.pinned(
    '§10.3 prompt assembly',
    sent.includes('## Your task') && sent.indexOf('## Your task') < sent.indexOf(prompt) && sent.indexOf('## Your task') > 200 && !sent.includes('## Task system prompt'),
    'one text: the base engineering principles, then `## Your task` and the prompt (no system-prompt section when none was given)',
    `${sent.length} chars; "## Your task" at ${sent.indexOf('## Your task')}, the prompt at ${sent.indexOf(prompt)}`,
  );
  c.note(`${events.filter((e) => e.provider === 'codex').length}/${events.length} events of the task carry provider`);

  // No conversation id → no conversation line. With a system prompt and ultrathink.
  fx.setScenario({ codex: { run: 'ok-no-conversation' } });
  const prompt2 = 'V3-SECOND-TASK: answer in one line.';
  const r2 = await srv.callTool('dispatch_task', { title: 'V3 no conversation id', prompt: prompt2, system_prompt: 'V3-SYSTEM-TEXT: be terse.', ultrathink: true, provider: 'codex' }, CALL_MS);
  const h2 = parseResult(r2.text);
  const run2 = fx.runs('codex')[1];
  c.must(!r2.isError && h2.ok && h2.conversation === undefined && h2.extraLines.length === 0, 'no `conversation:` line when the fake returned no id', head(r2.text));
  if (run2) {
    const p2 = run2.parsed.prompt;
    const iSys = p2.indexOf('## Task system prompt');
    const iTask = p2.indexOf('## Your task');
    c.pinned(
      '§10.3 prompt assembly',
      iSys > 0 && iSys < p2.indexOf('V3-SYSTEM-TEXT') && p2.indexOf('V3-SYSTEM-TEXT') < iTask && iTask < p2.indexOf(prompt2),
      '`## Task system prompt` + the system prompt, then `## Your task` + the prompt',
      { systemHeading: iSys, systemText: p2.indexOf('V3-SYSTEM-TEXT'), taskHeading: iTask, taskText: p2.indexOf(prompt2) },
    );
    c.pinned('§10.3 prompt assembly', p2.trimEnd().split('\n').pop() === 'Think as deeply as you can before acting.', 'ultrathink → a final line `Think as deeply as you can before acting.`', p2.trimEnd().split('\n').pop());
  }
  const leaked = leaks(fx, [r.text, r2.text]);
  c.pinned('§10.3 ("never … a token; never include `raw` payloads in events or results")', leaked.length === 0, 'no token and no raw vendor payload in a result, an event, an output file or the server log', leaked);
  return c.done(`${h.line1} ⏎ ${h.line2?.replace(fx.tasksDir, '<tasks>')} ⏎ ${h.extraLines[0]}; done event provider=codex tokens ${done[0]?.inputTokens}/${done[0]?.outputTokens}; no conversation line without an id`);
}

/* ------------------------------------------------------------------------- *
 * V4 — worker: "<cursor worker>"
 * ------------------------------------------------------------------------- */

async function v4(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cu', provider: 'cursor' }] });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'V4 cursor by name', prompt: 'V4: answer in one line.', worker: 'cu' }, CALL_MS);
  const h = parseResult(r.text);
  const run = fx.runs('cursor')[0];
  c.must(!r.isError && run !== undefined && run.argv[0] === '-p' && run.argv.join(' ').includes('--output-format json'), 'a `cursor-agent -p --output-format json` run of the fake', run ? run.argv.slice(0, 5) : head(r.text));
  c.must(h.startsWithHeader && /^\[worker: cu, model: .+, provider: cursor\]$/.test(h.line1 ?? ''), 'header line 1 `[worker: cu, model: <m>, provider: cursor]`', head(r.text));
  c.pinned("§10.3 ProviderRunOutcome.model ('-' when the CLI default was used and not reported)", h.model === '-', 'model `-` for a worker with no default model', h.line1);
  c.must(h.taskId !== undefined && h.outputFile === path.join(fx.tasksDir, `${h.taskId}.md`), 'header line 2 `task: <id> · output: <path>`', h.line2);
  c.must(run !== undefined && h.extraLines[0] === `conversation: ${run.conversationId}` && h.body.trim() === run.text, "line 3 `conversation: <session id>` and the fake's text", { extra: h.extraLines, body: clip(h.body, 120) });
  const done = fx.eventsOfTask(h.taskId).filter((e) => e.status === 'done');
  c.must(done.length === 1 && done[0].provider === 'cursor' && done[0].inputTokens === TOKENS.cursor.input && done[0].outputTokens === TOKENS.cursor.output, 'a done event with provider: "cursor" and the fake\'s token counts', done[0]);
  if (run) {
    c.pinned('§10.3 adapter construction', modelFlag(run) === undefined, 'no `--model` for a worker with no default model', flagsOf(run));
  }
  const r2 = await srv.callTool('dispatch_task', { title: 'V4 cursor by name and provider', prompt: 'V4: answer in one line.', worker: 'cu', provider: 'cursor', model: 'composer-2.5' }, CALL_MS);
  const h2 = parseResult(r2.text);
  const run2 = fx.runs('cursor')[1];
  c.pinned('§10.3 Selection 2', !r2.isError && h2.line1 === '[worker: cu, model: composer-2.5, provider: cursor]' && run2 !== undefined && modelFlag(run2) === 'composer-2.5', '`worker` plus a matching `provider` accepted, and an explicit model passed to `--model`', run2 ? `${h2.line1} / ${flagsOf(run2).join(' ')}` : head(r2.text));
  c.must(fx.claudeOneShots().length === 0 && fx.runs('codex').length === 0 && fx.runs('gemini').length === 0, 'no other CLI to be run', fx.vendorLog().map((x) => `${x.vendor}:${x.kind}`));
  return c.done(`${h.line1} ⏎ ${h.extraLines[0]}; cursor-agent argv ${run ? flagsOf(run).join(' ') : '—'}`);
}

/* ------------------------------------------------------------------------- *
 * V5 — provider: "gemini" | "antigravity" | "agy"
 * ------------------------------------------------------------------------- */

async function v5(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'ag', provider: 'gemini' }] });
  const srv = await fx.startServer();
  const seen = [];
  for (const provider of ['gemini', 'antigravity', 'agy']) {
    const before = fx.runs('gemini').length;
    const r = await srv.callTool('dispatch_task', { title: `V5 ${provider}`, prompt: 'V5: answer in one line.', provider }, CALL_MS);
    const h = parseResult(r.text);
    const run = fx.runs('gemini')[before];
    c.must(!r.isError && run !== undefined && run.cli === 'agy' && run.argv.includes('-p'), `provider "${provider}" to reach the agy fake`, run ? run.argv.slice(0, 4) : head(r.text));
    c.pinned('§10.3 result header', h.line1 !== undefined && /^\[worker: ag, model: .+, provider: gemini\]$/.test(h.line1), 'the header to name the provider by its id, `gemini`', h.line1);
    seen.push(`${provider}→${run ? 'agy' : 'nothing'}`);
  }
  for (const provider of ['Antigravity', ' AGY ']) {
    const before = fx.runs('gemini').length;
    const r = await srv.callTool('dispatch_task', { title: `V5 ${provider.trim()} spelled loosely`, prompt: 'V5: answer in one line.', provider }, CALL_MS);
    c.pinned('providers.ts parseProvider (trimmed, case-insensitive)', !r.isError && fx.runs('gemini').length === before + 1, `provider ${JSON.stringify(provider)} accepted as gemini`, head(r.text));
  }
  c.must(fx.runs('codex').length === 0 && fx.runs('cursor').length === 0 && fx.claudeOneShots().length === 0, 'no other CLI to be run', fx.vendorLog().map((x) => `${x.vendor}:${x.kind}`));
  return c.done(seen.join(', '));
}

/* ------------------------------------------------------------------------- *
 * V6 — unknown provider; worker/provider mismatch
 * ------------------------------------------------------------------------- */

async function v6(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }, { name: 'cu', provider: 'cursor' }] });
  const srv = await fx.startServer();
  const r1 = await srv.callTool('dispatch_task', { title: 'V6 unknown provider', prompt: 'V6: never runs.', provider: 'nope' }, CALL_MS);
  c.must(r1.isError && r1.text.includes('unknown provider "nope" — use one of: claude, codex, cursor, gemini'), 'the message `unknown provider "nope" — use one of: claude, codex, cursor, gemini`', r1.text);
  const r2 = await srv.callTool('dispatch_task', { title: 'V6 mismatch', prompt: 'V6: never runs.', worker: 'cx', provider: 'cursor' }, CALL_MS);
  c.must(r2.isError && r2.text.includes('worker cx runs on Codex, not Cursor'), 'the message `worker cx runs on Codex, not Cursor`', r2.text);
  const r3 = await srv.callTool('dispatch_task', { title: 'V6 mismatch claude', prompt: 'V6: never runs.', worker: 'cx', provider: 'claude' }, CALL_MS);
  c.pinned('§10.3 Selection 2', r3.isError && r3.text.includes('worker cx runs on Codex, not Claude Code'), '`worker cx runs on Codex, not Claude Code`', r3.text);
  const r4 = await srv.callTool('dispatch_task', { title: 'V6 mismatch the other way', prompt: 'V6: never runs.', worker: 'wa', provider: 'codex' }, CALL_MS);
  c.pinned('§10.3 Selection 2', r4.isError && r4.text.includes('worker wa runs on Claude Code, not Codex'), '`worker wa runs on Claude Code, not Codex`', r4.text);
  for (const provider of [42, { id: 'codex' }, ['codex'], true]) {
    const r = await srv.callTool('dispatch_task', { title: 'V6 non-string provider', prompt: 'V6: never runs.', provider }, CALL_MS);
    c.pinned('§10.3 Selection 1 (a PRESENT provider that parseProvider does not know)', r.isError && /^Error: invalid provider — expected a string, got /.test(r.text), `provider ${JSON.stringify(provider)} refused by the argument check (a non-string is a shape error, judged before any registry lookup)`, r.text);
  }
  const batch = await srv.callTool('dispatch_tasks', { tasks: [{ title: 'V6 batch unknown provider', prompt: 'V6: never runs.', provider: 'nope' }] }, CALL_MS);
  c.pinned('§10.3 Tool surface (dispatch_tasks takes `provider` too)', /unknown provider "nope"/.test(batch.text), 'the same rejection inside a dispatch_tasks batch', batch.text);
  const spawned = [...fx.vendorLog(), ...fx.claudeLog()];
  c.must(spawned.length === 0, 'both rejected before any spawn', spawned.map((x) => `${x.vendor ?? 'claude'}:${x.kind}`));
  c.pinned('§10.3 Selection', fx.events().length === 0 && penalized(fx).length === 0, 'no task event and no failure recorded for a rejected dispatch', { events: statuses(fx.events()), stats: penalized(fx) });
  for (const [provider, label] of [['', 'an empty string'], [null, 'null']]) {
    const r = await srv.callTool('dispatch_task', { title: `V6 provider ${label}`, prompt: 'V6: answer in one line.', provider }, CALL_MS);
    c.note(`provider ${label} → ${r.isError ? `rejected (${clip(r.text, 70)})` : `treated as absent (ran on ${parseResult(r.text).worker})`}`);
  }
  return c.done(`"${clip(r1.text, 90)}" / "${clip(r2.text, 60)}"; nothing spawned, no event, no failure recorded`);
}

/* ------------------------------------------------------------------------- *
 * V7 — models
 * ------------------------------------------------------------------------- */

async function v7(t) {
  const c = new Checks();
  const fx = t.fixture({
    workers: [
      { name: 'wa', model: 'sonnet' },
      { name: 'cx', provider: 'codex' },
      { name: 'cd', provider: 'codex', model: 'gpt-5.6-sol' },
      { name: 'cb', provider: 'codex', extra: { model: 'bad model' } },
    ],
  });
  const srv = await fx.startServer();
  const codexRuns = () => fx.runs('codex');
  const seen = [];

  let n = codexRuns().length;
  let r = await srv.callTool('dispatch_task', { title: 'V7 explicit codex model', prompt: 'V7: answer in one line.', worker: 'cx', model: 'gpt-5.6-sol' }, CALL_MS);
  let run = codexRuns()[n];
  c.must(!r.isError && run !== undefined && modelFlag(run) === 'gpt-5.6-sol', 'Codex `model: "gpt-5.6-sol"` passed to `--model`', run ? flagsOf(run) : head(r.text));
  c.pinned('§10.3 result header', parseResult(r.text).line1 === '[worker: cx, model: gpt-5.6-sol, provider: codex]', 'the header to name the model that was asked for', head(r.text, 1));
  seen.push(`"gpt-5.6-sol"→--model ${run ? modelFlag(run) : '?'}`);

  n = codexRuns().length;
  const hint = providerModelHint('codex');
  r = await srv.callTool('dispatch_task', { title: 'V7 bad codex model', prompt: 'V7: never runs.', worker: 'cx', model: 'bad model' }, CALL_MS);
  c.must(r.isError && r.text.includes(hint) && codexRuns().length === n, `Codex \`model: "bad model"\` rejected with the provider hint "${hint}", nothing spawned`, r.text);
  const r2 = await srv.callTool('dispatch_task', { title: 'V7 bad codex model by provider', prompt: 'V7: never runs.', provider: 'codex', model: 'bad model' }, CALL_MS);
  c.pinned('§10.3 Selection 3 (the provider of the candidates decides the model rule)', r2.isError && r2.text.includes(hint) && codexRuns().length === n, 'the same rejection when the candidates come from `provider: "codex"`', r2.text);
  for (const model of ['gpt-5;rm -rf /', '$(id)', 42]) {
    const rr = await srv.callTool('dispatch_task', { title: 'V7 hostile model', prompt: 'V7: never runs.', worker: 'cx', model }, CALL_MS);
    // A model that is not a string never reaches the provider's model rule: the argument check
    // (src/mcp/dispatch-args.ts) refuses it by type, in its own words, with nothing echoed.
    const want = typeof model === 'string' ? hint : 'invalid model — expected a string, got a number';
    c.pinned('§10.5 ("shell text → rejected before spawn")', rr.isError && rr.text.includes(want) && codexRuns().length === n, `model ${JSON.stringify(model)} rejected before spawn`, rr.text);
  }
  c.pinned('§10.3 Selection 3 ("No failure is recorded")', penalized(fx).length === 0 && !fx.events().some((e) => /bad codex model|hostile model/.test(e.title)), 'no failure and no event for a rejected model', { stats: penalized(fx), events: fx.events().map((e) => e.title) });
  seen.push('"bad model"→rejected with the hint');

  n = codexRuns().length;
  r = await srv.callTool('dispatch_task', { title: 'V7 empty codex model', prompt: 'V7: answer in one line.', worker: 'cx', model: '' }, CALL_MS);
  run = codexRuns()[n];
  c.must(!r.isError && run !== undefined && modelFlag(run) === undefined, 'Codex `model: ""` → the CLI default (no `--model`)', run ? flagsOf(run) : head(r.text));
  c.pinned("§10.3 ProviderRunOutcome.model ('-' when the CLI default was used and not reported)", parseResult(r.text).line1 === '[worker: cx, model: -, provider: codex]', 'header model `-`', head(r.text, 1));
  seen.push(`""→${run ? (modelFlag(run) === undefined ? 'no --model' : `--model ${modelFlag(run)}`) : '?'}`);

  r = await srv.callTool('dispatch_task', { title: 'V7 claude OPUS', prompt: 'V7: answer in one line.', worker: 'wa', model: 'OPUS' }, CALL_MS);
  const shot = fx.claudeOneShots().at(-1);
  c.must(!r.isError && shot !== undefined && shot.parsed?.model === 'opus' && parseResult(r.text).line1 === '[worker: wa, model: opus]', 'Claude worker `model: "OPUS"` → `opus`', shot ? `--model ${shot.parsed?.model}; ${head(r.text, 1)}` : head(r.text));
  seen.push(`claude "OPUS"→--model ${shot?.parsed?.model}`);
  const shots = fx.claudeOneShots().length;
  r = await srv.callTool('dispatch_task', { title: 'V7 claude with a vendor id', prompt: 'V7: never runs.', worker: 'wa', model: 'gpt-5.6-sol' }, CALL_MS);
  c.pinned('contract-2.0 §3.2 (Claude model rule unchanged)', r.isError && r.text.includes(`invalid model "gpt-5.6-sol" — use ${MODEL_FORMS_HINT}`) && fx.claudeOneShots().length === shots, 'a vendor model id sent to a Claude worker rejected with the Claude hint', r.text);

  n = codexRuns().length;
  r = await srv.callTool('dispatch_task', { title: 'V7 worker default model', prompt: 'V7: answer in one line.', worker: 'cd' }, CALL_MS);
  run = codexRuns()[n];
  c.pinned("§10.3 Selection 3 (absent → the chosen worker's default)", !r.isError && run !== undefined && modelFlag(run) === 'gpt-5.6-sol', "no model → the worker's default `gpt-5.6-sol`", run ? flagsOf(run) : head(r.text));
  n = codexRuns().length;
  r = await srv.callTool('dispatch_task', { title: 'V7 unreadable stored default', prompt: 'V7: answer in one line.', worker: 'cb' }, CALL_MS);
  run = codexRuns()[n];
  c.pinned('§10.2 (a stored model that is not a model id → NO default model)', !r.isError && run !== undefined && modelFlag(run) === undefined, 'a registry entry with `model: "bad model"` to run with no `--model`', run ? flagsOf(run) : head(r.text));
  n = codexRuns().length;
  r = await srv.callTool('dispatch_task', { title: 'V7 another vendor id', prompt: 'V7: answer in one line.', worker: 'cx', model: 'opus' }, CALL_MS);
  run = codexRuns()[n];
  c.pinned("§10.5 (another vendor's id that has the shape of an id reaches the CLI)", run !== undefined && modelFlag(run) === 'opus', '`model: "opus"` to a Codex worker passed to `--model` (the vendor CLI is what rejects it)', run ? flagsOf(run) : head(r.text));
  return c.done(seen.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V8 — environment of the vendor child
 * ------------------------------------------------------------------------- */

async function v8(t) {
  const c = new Checks();
  const fx = t.fixture({
    workers: [
      { name: 'cxd', provider: 'codex', configDir: 'default' },
      { name: 'cxi', provider: 'codex' },
      { name: 'cu', provider: 'cursor' },
      { name: 'gd', provider: 'gemini', configDir: 'default' },
      { name: 'gi', provider: 'gemini' },
    ],
  });
  const identity = Object.fromEntries(SESSION_IDENTITY_ENV.map((k) => [k, `leaked-${k.toLowerCase()}`]));
  // Not session identity, so by §10.1 they pass through — which is worth SEEING: they are the
  // user's Anthropic credentials, handed to another vendor's binary.
  const credentials = { CLAUDE_CODE_OAUTH_TOKEN: 'harness-claude-oauth-token', ANTHROPIC_API_KEY: 'harness-anthropic-api-key' };
  const srv = await fx.startServer({ env: { ...identity, CLAUDECODE: '1', ...credentials } });
  const runOf = {};
  for (const w of fx.workers) {
    const vendor = w.provider;
    const before = fx.runs(vendor).length;
    const r = await srv.callTool('dispatch_task', { title: `V8 ${w.name}`, prompt: 'V8: answer in one line.', worker: w.name }, CALL_MS);
    runOf[w.name] = fx.runs(vendor)[before];
    if (!c.must(!r.isError && runOf[w.name] !== undefined, `a run on ${w.name} to inspect`, head(r.text))) {
      return c.done('');
    }
  }
  const children = fx.vendorLog();
  const leaked = children.flatMap((x) => SESSION_IDENTITY_ENV.filter((k) => Object.hasOwn(x.env ?? {}, k)).map((k) => `${x.cli ?? x.vendor} ${x.kind}: ${k}`));
  c.must(leaked.length === 0, `none of the ${SESSION_IDENTITY_ENV.length} session-identity variables in any vendor child (the server was started with all of them)`, leaked);
  c.must(runOf.cxd.env.CODEX_HOME === undefined, 'no CODEX_HOME for the Codex worker whose configDir is $HOME/.codex', runOf.cxd.env.CODEX_HOME);
  c.must(runOf.cxi.env.CODEX_HOME === fx.worker('cxi').configDir, "CODEX_HOME = the worker's configDir for the isolated Codex worker", runOf.cxi.env.CODEX_HOME);
  const cursorHomes = ['CODEX_HOME', 'AGY_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CURSOR_HOME'].filter((k) => Object.hasOwn(runOf.cu.env, k));
  c.must(cursorHomes.length === 0, 'no home variable for the Cursor worker', cursorHomes);
  c.pinned('providers.ts adapterAccountDir', runOf.gd.env.AGY_HOME === undefined && runOf.gi.env.AGY_HOME === fx.worker('gi').configDir, 'AGY_HOME absent for the default Antigravity home and set for an isolated one', { gd: runOf.gd.env.AGY_HOME, gi: runOf.gi.env.AGY_HOME });
  const crossed = [
    ...['cxd', 'cxi'].filter((n) => Object.hasOwn(runOf[n].env, 'AGY_HOME')).map((n) => `${n}: AGY_HOME`),
    ...['gd', 'gi'].filter((n) => Object.hasOwn(runOf[n].env, 'CODEX_HOME')).map((n) => `${n}: CODEX_HOME`),
    ...Object.entries(runOf).filter(([, x]) => Object.hasOwn(x.env, 'CLAUDE_CONFIG_DIR')).map(([n]) => `${n}: CLAUDE_CONFIG_DIR`),
  ];
  c.pinned('§10.3 adapter construction', crossed.length === 0, "no other provider's home variable in a vendor child", crossed);
  const changed = Object.entries(runOf).filter(([, x]) => x.env.CCO_PROVIDERS_PASSTHROUGH !== PASSTHROUGH_VALUE || x.env.HOME !== fx.home || x.env.PATH !== fx.sandboxPath).map(([n]) => n);
  c.pinned('§10.1 scrubSessionEnv ("nothing else changed")', changed.length === 0, 'every other variable (HOME, PATH, an unrelated one) passed through unchanged', changed);
  c.note(`CLI names resolved through the login shell: ${fx.loginShellLog().length > 0 ? fx.loginShellLog().map((l) => clip(l, 40)).join(' | ') : 'no lookup seen'}`);
  const inherited = Object.keys(credentials).filter((k) => children.some((x) => x.env?.[k] === credentials[k]));
  if (inherited.length > 0) {
    c.finding('V8', `${inherited.join(' and ')} set in the server's environment ${inherited.length > 1 ? 'are' : 'is'} inherited by the vendor CLI children (codex, cursor-agent, agy). §10.1 scrubSessionEnv removes the session-identity variables "and nothing else", so this is what the contract says — but it hands the user's Anthropic credentials to another vendor's binary`);
  }
  return c.done(`${children.length} vendor children, none with a session-identity variable; CODEX_HOME ${runOf.cxd.env.CODEX_HOME ?? 'absent'} (default home) / set (isolated); Cursor: no home variable; AGY_HOME absent (default) / set (isolated)`);
}

/* ------------------------------------------------------------------------- *
 * V9 — permission mode
 * ------------------------------------------------------------------------- */

async function v9(t) {
  const c = new Checks();
  // A Claude-only setting that must not reach a vendor flag: the registry-wide permission mode.
  const fx = t.fixture({ registry: { permissionMode: 'bypassPermissions' }, workers: [{ name: 'cx', provider: 'codex' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }] });
  const srv = await fx.startServer();
  const cases = [
    ['cx', undefined, '--sandbox workspace-write', 'row', 'Codex default'],
    ['cx', 'read-only', '--sandbox read-only', 'row', 'Codex permissionMode "read-only"'],
    ['cx', 'bogus', '--sandbox workspace-write', 'row', 'Codex invalid stored mode'],
    ['cx', 42, '--sandbox workspace-write', 'pinned', 'Codex non-string stored mode'],
    ['cx', 'danger-full-access', '--sandbox danger-full-access', 'pinned', 'Codex permissionMode "danger-full-access" (a listed mode the operator stored)'],
    ['ag', undefined, '--mode accept-edits', 'row', 'Antigravity default'],
    ['ag', 'plan', '--mode plan', 'pinned', 'Antigravity permissionMode "plan"'],
    ['ag', 'acceptEdits', '--mode accept-edits', 'row', "Antigravity invalid stored mode (Claude's spelling)"],
    ['cu', undefined, 'none', 'row', 'Cursor default'],
    ['cu', 'enabled', '--sandbox enabled', 'pinned', 'Cursor permissionMode "enabled"'],
    ['cu', 'workspace-write', 'none', 'row', "Cursor invalid stored mode (Codex's spelling)"],
  ];
  const seen = [];
  const escalations = [];
  for (const [name, mode, want, kind, label] of cases) {
    patchWorker(fx, name, { permissionMode: mode });
    const vendor = fx.worker(name).provider;
    const before = fx.runs(vendor).length;
    const r = await srv.callTool('dispatch_task', { title: `V9 ${label}`, prompt: 'V9: answer in one line.', worker: name }, CALL_MS);
    const run = fx.runs(vendor)[before];
    const got = run ? permissionOf(run) : `no run (${clip(r.text, 120)})`;
    const expected = `${label} → ${want === 'none' ? `no \`${PROVIDERS[vendor].permissionFlag}\`` : `\`${want}\``}`;
    if (kind === 'row') {
      c.must(got === want, expected, got);
    } else {
      c.pinned('providers.ts normalizeProviderPermissionMode', got === want, expected, got);
    }
    if (run) {
      escalations.push(...flagsOf(run).filter((a) => ESCALATION_FLAG.test(a)).map((a) => `${label}: ${a}`));
    }
    seen.push(`${label}: ${got}`);
  }
  c.must(escalations.length === 0, 'never `--force`, `--yolo` or `--dangerously-*` in a vendor argv', escalations);
  return c.done(seen.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V10 — hang, timeout_minutes: 1
 * ------------------------------------------------------------------------- */

async function hangLeg(t, c, { provider, spec, label, stubborn }) {
  const vendor = provider;
  const fx = t.fixture({ workers: [{ name: 'w', provider }], scenario: { [vendor]: { run: spec } } });
  const srv = await fx.startServer();
  const calledAt = Date.now();
  const call = srv.startTool('dispatch_task', { title: `V10 ${label}`, prompt: 'V10: this never answers.', worker: 'w', timeout_minutes: 1 });
  const run = await waitFor(() => fx.runs(vendor)[0], { timeoutMs: 60_000, label: `${label}: the fake to start`, abort: () => fx.aborted });
  await waitFor(() => fx.grandchildren().find((g) => g.pid === run.grandchildPid), { timeoutMs: 30_000, label: `${label}: the grandchild to register`, abort: () => fx.aborted });
  const group = [pgidOf(run.pid), pgidOf(run.grandchildPid)];
  const r = await call.answer(140_000);
  // Two clocks: the server's timer runs from the spawn, which lies between the call and the
  // moment the fake logged itself. Lower bounds use the call, upper bounds the fake's start.
  const sinceCall = Date.now() - calledAt;
  const elapsed = Date.now() - run.ts;
  c.must(r.isError && TIMEOUT_TEXT.test(r.text), `${label}: the dispatch to end as a timeout error`, r.text);
  let dead = true;
  try {
    await waitFor(() => !isPidAlive(run.pid) && !isPidAlive(run.grandchildPid), { timeoutMs: 12_000, label: 'the processes to die', abort: () => fx.aborted });
  } catch {
    dead = false;
  }
  c.must(dead, `${label}: the fake AND its grandchild dead afterwards`, { fake: isPidAlive(run.pid) ? 'alive' : 'dead', grandchild: isPidAlive(run.grandchildPid) ? 'alive' : 'dead' });
  c.must(sinceCall >= 59_500 && elapsed <= 95_000, `${label}: the timeout about one minute after the child started`, `${sinceCall} ms after the call, ${elapsed} ms after the fake started`);
  c.pinned('§10.3 process control (spawn detached, own process group)', run.groupLeader === true && group[0] === run.pid && group[1] === run.pid, `${label}: the vendor child a process-group leader with its grandchild in the group`, { pid: run.pid, pgidOfChild: group[0], pgidOfGrandchild: group[1] });
  const events = fx.eventsFor(`V10 ${label}`);
  c.pinned('§10.5 ("incomplete … never `done`")', events.length > 0 && events.at(-1).status === 'error' && !events.some((e) => e.status === 'done'), `${label}: a terminal error event and no done event`, statuses(events));
  c.pinned('§10.3 Selection 4 (a timeout is never a quota failure)', !(fx.stats().w?.cooldownUntil > Date.now()), `${label}: no cooldown after a timeout`, fx.stats().w);
  if (stubborn) {
    const ignored = fx.vendorLog().filter((x) => x.kind === 'sigterm-ignored').length;
    c.pinned('§10.5 ("Child ignores SIGTERM → process group SIGKILL after 5 s")', ignored >= 1 && sinceCall >= 64_500, `${label}: SIGTERM delivered (and ignored), the answer no earlier than 5 s after the timeout`, { sigtermsIgnored: ignored, msAfterTheCall: sinceCall });
  }
  const answered = await srv.request('tools/list', undefined, 20_000).then(
    () => true,
    () => false,
  );
  c.pinned('§10.5', answered, `${label}: the server still answering after the timeout`, 'no answer to tools/list');
  return `${label}: timeout error after ${(elapsed / 1000).toFixed(1)} s, both processes dead`;
}

async function v10(t) {
  const c = new Checks();
  const out = await Promise.all([
    hangLeg(t, c, { provider: 'codex', label: 'codex hang', spec: { kind: 'hang', grandchild: true } }),
    hangLeg(t, c, { provider: 'cursor', label: 'cursor-agent hang that ignores SIGTERM', stubborn: true, spec: { kind: 'hang', ignoreSigterm: true, grandchild: { ignoreSigterm: true } } }),
  ]);
  return c.done(out.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V11 — notifications/cancelled during `slow`
 * ------------------------------------------------------------------------- */

async function v11(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }], scenario: { codex: { run: { kind: 'slow', ms: 45_000, grandchild: true } } } });
  const srv = await fx.startServer();
  const title = 'V11 cancelled';
  const call = srv.startTool('dispatch_task', { title, prompt: 'V11: this is cancelled mid-run.', worker: 'cx' });
  const run = await waitFor(() => fx.runs('codex')[0], { timeoutMs: 60_000, label: 'the slow fake to start', abort: () => fx.aborted });
  await waitFor(() => fx.grandchildren().find((g) => g.pid === run.grandchildPid), { timeoutMs: 30_000, label: 'the grandchild to register', abort: () => fx.aborted });
  // The server registers the child for cancellation when it learns of it; give that a moment.
  await sleep(500);
  const cancelledAt = Date.now();
  srv.notify('notifications/cancelled', { requestId: call.id, reason: 'V11 probe' });
  let killed = true;
  try {
    await waitFor(() => !isPidAlive(run.pid), { timeoutMs: 15_000, label: 'the child to die', abort: () => fx.aborted });
  } catch {
    killed = false;
  }
  const killMs = Date.now() - cancelledAt;
  c.must(killed, 'the vendor child killed after the cancellation', `still alive ${killMs} ms later`);
  const exit = fx.vendorLog().find((x) => x.inv === run.inv)?.exit;
  c.note(exit?.signal === 'SIGTERM' ? `the child received SIGTERM ${exit.ts - cancelledAt} ms after the cancellation` : 'the child logged no SIGTERM (it was killed outright)');
  let groupDead = true;
  try {
    await waitFor(() => !isPidAlive(run.grandchildPid), { timeoutMs: 8000, label: 'the grandchild to die', abort: () => fx.aborted });
  } catch {
    groupDead = false;
  }
  c.pinned('§10.3 process control ("a kill function that does the same ladder" — the whole group)', groupDead, 'the grandchild killed with it', 'grandchild still alive');
  await sleep(3000);
  c.must(!srv.hasResponse(call.id), 'no response to the cancelled request', 'a response arrived');
  const events = fx.eventsFor(title);
  const last = events.at(-1);
  c.must(last !== undefined && (last.status === 'cancelled' || (last.status === 'error' && /cancel/i.test(String(last.error)))), 'a `cancelled` terminal event', events.map((e) => `${e.status}${e.error ? `(${clip(e.error, 60)})` : ''}`));
  c.pinned('§10.3 ("exactly as it reaches a `claude -p` child today": no failure, no failover, no cooldown)', penalized(fx).length === 0 && fx.runs('codex').length === 1, 'nothing recorded against the worker and no second attempt', { stats: penalized(fx), runs: fx.runs('codex').length });
  const alive = await srv.request('tools/list', undefined, 20_000).then(
    () => true,
    () => false,
  );
  c.pinned('§10.3', alive, 'the server still answering', 'no answer to tools/list');
  return c.done(`child dead ${killMs} ms after the cancellation, grandchild too; terminal event ${last?.status}("${clip(last?.error ?? '', 50)}"); no response to request ${call.id}`);
}

/* ------------------------------------------------------------------------- *
 * V12 — quota on the first of two workers → cooldown + failover
 * ------------------------------------------------------------------------- */

async function quotaLeg(t, { provider, carrier }) {
  const vendor = provider;
  const fx = t.fixture({
    label: `${t.id}${provider}${carrier ?? ''}`,
    workers: [{ name: 'wa' }, { name: 'q1', provider }, { name: 'q2', provider }],
    // By run ORDER, not by account: the probe does not depend on which worker is picked first.
    scenario: { [vendor]: { run: { sequence: [carrier ? { kind: 'quota', carrier } : 'quota', 'ok'] } } },
  });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: `V12 ${provider}`, prompt: 'V12: answer in one line.', provider }, CALL_MS);
  const runs = fx.runs(vendor);
  const accountOf = (run) => fx.workers.find((w) => w.configDir === run.home)?.name;
  const first = runs[0] ? accountOf(runs[0]) : undefined;
  const second = runs[1] ? accountOf(runs[1]) : undefined;
  const h = parseResult(r.text);
  const cooled = first !== undefined && fx.stats()[first]?.cooldownUntil > Date.now();
  return {
    fx,
    r,
    h,
    runs,
    first,
    second,
    cooled,
    failedOver: !r.isError && runs.length === 2 && second !== undefined && second !== first && h.worker === second,
    summary: `${runs.length} run(s) [${runs.map((x) => `${accountOf(x)}:${x.scenario}`).join(', ')}], ${r.isError ? `error "${clip(r.text, 110)}"` : `done on ${h.worker}`}, ${first ?? 'first worker'} ${cooled ? 'cooling down' : 'NOT cooled down'}`,
  };
}

async function v12(t) {
  const c = new Checks();
  const [codex, gemini] = await Promise.all([quotaLeg(t, { provider: 'codex' }), quotaLeg(t, { provider: 'gemini' })]);
  let diagnosis = '';
  if (!codex.failedOver || !codex.cooled) {
    // Where did the classifier look? The real CLI puts the sentence in an error event, which
    // the adapter hands over as RunResult.note with an EMPTY text. Repeat with the sentence
    // also in the assistant text, to tell "no failover at all" from "only `text` is classified".
    const alt = await quotaLeg(t, { provider: 'codex', carrier: 'text' });
    diagnosis = ` — for comparison, with the quota sentence ALSO in the assistant text: ${alt.summary}`;
  }
  c.must(codex.cooled, 'the first Codex worker cooled down after its quota error', `${codex.summary}${diagnosis}`);
  c.must(codex.failedOver, 'the task to fail over to the second Codex worker and succeed', `${codex.summary}${diagnosis}`);
  c.pinned('§10.5 ("cooldown + failover among the SAME provider\'s candidates")', codex.fx.claudeOneShots().length === 0 && codex.fx.runs('gemini').length === 0, 'no failover onto another provider', codex.fx.claudeLog().map((x) => x.kind));
  c.pinned('§10.5 (vendor quota exhausted — Antigravity)', gemini.cooled && gemini.failedOver, 'the same for two Antigravity workers', gemini.summary);
  const interim = codex.fx.events().filter((e) => e.status === 'running' && /fail(ing)? over/i.test(String(e.error)));
  c.note(interim.length > 0 ? `interim event "${clip(interim[0].error, 60)}"` : 'no interim failover event');
  return c.done(`codex: ${codex.summary}; antigravity: ${gemini.summary}`);
}

/* ------------------------------------------------------------------------- *
 * V13 — logged-out account
 * ------------------------------------------------------------------------- */

async function v13(t) {
  const c = new Checks();
  const now = Date.now();
  const loggedOutReading = { available: false, subscriptionType: null, windows: [], auth: { loggedIn: false, method: null, email: null, checkedAt: now } };
  const loggedInReading = { available: false, subscriptionType: 'chatgpt', windows: [], auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now } };

  // A — the usage cache already says "logged out": selection skips the account.
  const legA = async () => {
    const fx = t.fixture({ label: 'V13a', workers: [{ name: 'wa' }, { name: 'c1', provider: 'codex', auth: 'out' }, { name: 'c2', provider: 'codex' }], usage: { c1: loggedOutReading } });
    const srv = await fx.startServer();
    const r = await srv.callTool('dispatch_task', { title: 'V13 cached logout', prompt: 'V13: answer in one line.', provider: 'codex' }, CALL_MS);
    const h = parseResult(r.text);
    const onC1 = fx.runs('codex').filter((x) => x.home === fx.worker('c1').configDir);
    c.pinned('§10.5 ("selection skips it when the usage cache says so")', !r.isError && h.worker === 'c2' && onC1.length === 0, 'A: a Codex worker the cache marks logged out skipped without a run; the task done on the other', `${r.isError ? clip(r.text, 160) : `done on ${h.worker}`}; runs on c1: ${onC1.length}`);
    return `A (cache says logged out): ${r.isError ? 'error' : `done on ${h.worker}`}, ${onC1.length} run(s) on the logged-out account`;
  };
  // B — the cache says "fine" but the CLI is logged out: the run fails, the task fails over.
  const legB = async () => {
    const fx = t.fixture({ label: 'V13b', workers: [{ name: 'wa' }, { name: 'c1', provider: 'codex', auth: 'out' }, { name: 'c2', provider: 'codex' }], usage: { c1: loggedInReading } });
    const srv = await fx.startServer();
    const r = await srv.callTool('dispatch_task', { title: 'V13 stale login', prompt: 'V13: answer in one line.', provider: 'codex' }, CALL_MS);
    const h = parseResult(r.text);
    const onC1 = fx.runs('codex').filter((x) => x.home === fx.worker('c1').configDir);
    c.must(!r.isError && h.worker === 'c2', 'B: the logged-out account skipped, or the task failed over — done on the second Codex worker', r.isError ? r.text : head(r.text));
    c.pinned('§10.5 (a login failure is not a quota failure)', !(fx.stats().c1?.cooldownUntil > Date.now()), 'B: no quota cooldown for the logged-out account', fx.stats().c1);
    const reading = fx.usage()[fx.worker('c1').configDir];
    c.note(`B: usage reading of the logged-out account afterwards: ${reading ? `auth.loggedIn=${reading.auth?.loggedIn}, fetchedAt ${reading.fetchedAt === now ? 'unchanged' : 'changed'}` : 'removed'}`);
    return `B (cache says logged in, CLI logged out): done on ${h.worker ?? '—'} after ${onC1.length} run(s) on the logged-out account`;
  };
  // C — nothing to fail over to: the failure must say the login is the problem.
  const legC = async (provider, workerOpts, scenario) => {
    const vendor = provider;
    const fx = t.fixture({ label: `V13c${provider}`, workers: [{ name: 'wa' }, { name: 'lo', provider, ...workerOpts }], scenario });
    const srv = await fx.startServer();
    const title = `V13 ${provider} logged out`;
    const r = await srv.callTool('dispatch_task', { title, prompt: 'V13: answer in one line.', worker: 'lo' }, CALL_MS);
    c.must(r.isError && LOGIN_TEXT.test(r.text), `C (${PROVIDERS[provider].label}): a failure that says the login is the problem`, r.text);
    c.must(!fx.eventsFor(title).some((e) => e.status === 'done'), `C (${PROVIDERS[provider].label}): never \`done\``, statuses(fx.eventsFor(title)));
    c.pinned('§10.5 (a login failure is not a quota failure)', !(fx.stats().lo?.cooldownUntil > Date.now()), `C (${PROVIDERS[provider].label}): no quota cooldown`, fx.stats().lo);
    const probes = fx.invocations(vendor).filter((x) => x.kind !== 'run').map((x) => x.kind);
    return `C ${provider}: "${clip(r.text, 100)}" (${fx.runs(vendor).length} run(s)${probes.length > 0 ? `, probes: ${probes.join(',')}` : ''})`;
  };
  const out = await Promise.all([
    legA(),
    legB(),
    legC('codex', { auth: 'out' }, {}),
    legC('cursor', {}, { cursor: { login: 'out' } }),
    legC('gemini', {}, { gemini: { login: 'out' } }),
  ]);
  return c.done(out.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V14 — error, ok-empty-text, huge
 * ------------------------------------------------------------------------- */

async function v14(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }] });
  const srv = await fx.startServer();
  const workerOf = { codex: 'cx', cursor: 'cu', gemini: 'ag' };
  const seen = [];

  for (const vendor of ['codex', 'cursor', 'gemini']) {
    fx.setScenario({ [vendor]: { run: 'error' } });
    const title = `V14 ${vendor} error`;
    const r = await srv.callTool('dispatch_task', { title, prompt: 'V14: this run fails.', worker: workerOf[vendor] }, CALL_MS);
    // "flattened, capped": the label may be cut, so the row asks for the START of the vendor's
    // sentence; whether all of it survived, and where the rest went, is reported.
    const marker = TEXTS[vendor].error.split(':')[0];
    c.must(r.isError && r.text.includes(marker), `error (${PROVIDERS[vendor].label}): a failure carrying the fake's text ("${marker}: …")`, r.text);
    const events = fx.eventsFor(title);
    if (r.isError && !r.text.includes(TEXTS[vendor].error)) {
      const file = events.find((e) => typeof e.outputFile === 'string')?.outputFile;
      const inFile = file !== undefined && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(TEXTS[vendor].error);
      c.finding('V14', `error (${PROVIDERS[vendor].label}): the vendor's sentence is CUT in the tool result — "${clip(r.text.replace(/\(task .*$/s, ''), 190)}" — and is ${inFile ? 'complete' : 'NOT complete'} in the output file. For an isolated Antigravity account the adapter's fixed AGY_HOME note comes first and uses up most of the capped label`);
    }
    c.pinned('§10.3 outcome mapping', events.at(-1)?.status === 'error' && !events.some((e) => e.status === 'done') && fx.runs(vendor).filter((x) => x.scenario === 'error').length === 1, `error (${PROVIDERS[vendor].label}): a terminal error event, one attempt`, statuses(events));
    c.pinned('§10.3 Selection 4 (an ordinary failure is not a quota failure)', !(fx.stats()[workerOf[vendor]]?.cooldownUntil > Date.now()), `error (${PROVIDERS[vendor].label}): no cooldown`, fx.stats()[workerOf[vendor]]);
  }
  seen.push('error: the fake\'s text in the failure, for all three vendors');

  for (const vendor of ['codex', 'cursor', 'gemini']) {
    fx.setScenario({ [vendor]: { run: 'ok-empty-text' } });
    const title = `V14 ${vendor} empty`;
    const r = await srv.callTool('dispatch_task', { title, prompt: 'V14: this run answers nothing.', worker: workerOf[vendor] }, CALL_MS);
    c.must(r.isError && NO_TEXT.test(r.text) && !fx.eventsFor(title).some((e) => e.status === 'done'), `ok-empty-text (${PROVIDERS[vendor].label}): a failure saying there was no text, never \`done\``, r.text);
    // The adapters differ: only Antigravity's reports status ok with an empty text; Codex's
    // and Cursor's report `incomplete` for an empty answer.
    if (vendor === 'gemini') {
      c.pinned('§10.3 outcome mapping ("Empty final text with status ok")', r.text.includes('the worker returned no text'), 'ok-empty-text (Antigravity): "the worker returned no text"', r.text);
    } else {
      c.pinned("§10.3 outcome mapping ('incomplete' without a timeout)", r.text.includes('ended without a final answer'), `ok-empty-text (${PROVIDERS[vendor].label}): "ended without a final answer"`, r.text);
    }
    seen.push(`empty ${vendor}: "${clip(r.text, 70)}"`);
  }
  fx.setScenario({ codex: { run: 'ok-blank-text' } });
  const blank = await srv.callTool('dispatch_task', { title: 'V14 codex blank', prompt: 'V14: this run answers whitespace.', worker: 'cx' }, CALL_MS);
  c.note(`a whitespace-only Codex answer → ${blank.isError ? `failure "${clip(blank.text, 60)}"` : 'accepted as a result'}`);

  // huge — the ANSWER itself is 12 MiB. A capped reader cannot have a parseable answer left;
  // an uncapped one would record all 12 MiB.
  const BOUND = 8 * 1024 * 1024 + 512 * 1024;
  for (const [vendor, spec, label] of [
    ['codex', { kind: 'huge', where: 'text' }, 'huge answer (Codex)'],
    ['codex', { kind: 'huge', where: 'after' }, 'answer then 12 MiB of chatter (Codex)'],
    ['cursor', { kind: 'huge', where: 'text' }, 'huge answer (Cursor)'],
  ]) {
    fx.setScenario({ [vendor]: { run: spec } });
    const title = `V14 ${label}`;
    const bytesBefore = fx.dataRootBytes();
    const outBefore = srv.stdoutBytes;
    const started = Date.now();
    let r;
    try {
      r = await srv.callTool('dispatch_task', { title, prompt: 'V14: this run floods its output.', worker: workerOf[vendor], timeout_minutes: 1 }, 110_000);
    } catch (err) {
      c.must(false, `${label}: the run to settle`, err.message);
      break;
    }
    const elapsed = Date.now() - started;
    const alive = await srv.request('tools/list', undefined, 20_000).then(
      () => true,
      () => false,
    );
    c.must(alive && !srv.exited, `${label}: to settle without crashing the server`, srv.exited ? `server exited (${JSON.stringify(srv.exitInfo)})` : 'no answer to tools/list');
    c.must(elapsed < 55_000, `${label}: to settle when the child exits, not at the 1-minute timeout`, `${elapsed} ms`);
    const responseBytes = srv.stdoutBytes - outBefore;
    const recorded = fx.dataRootBytes() - bytesBefore;
    c.must(responseBytes <= BOUND && recorded <= 2 * BOUND, `${label}: the recorded output bounded (tool response ≤ ${BOUND} bytes, data root growth ≤ ${2 * BOUND})`, { responseBytes, recordedBytes: recorded });
    const run = fx.runs(vendor).at(-1);
    c.note(`${label}: ${r.isError ? `failure "${clip(r.text, 60)}"` : 'done'} in ${(elapsed / 1000).toFixed(1)} s, response ${responseBytes} bytes, ${recorded} bytes recorded${run && isPidAlive(run.pid) ? ', CHILD STILL ALIVE' : ''}`);
  }
  seen.push('huge: settled, server alive, recorded output bounded');
  return c.done(seen.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V15 — mesh mode ON, provider: "codex"
 * ------------------------------------------------------------------------- */

async function v15(t) {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }], claude: { bg: { default: 'result-done' } } });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'V15 codex with mesh on', prompt: 'V15: answer in one line.', provider: 'codex' }, CALL_MS);
  const h = parseResult(r.text);
  const run = fx.runs('codex')[0];
  c.must(!r.isError && run !== undefined && run.argv[0] === 'exec' && h.body.trim() === run.text, 'a one-shot run through the codex fake', run ? head(r.text) : r.text);
  c.must(!r.text.includes('⚠') && h.startsWithHeader, 'NO `⚠` prefix (it is the expected path, not a fallback)', head(r.text, 2));
  c.must(fx.claudeBgSpawns().length === 0, 'no `--bg` spawn', fx.claudeBgSpawns().map((s) => s.argv.slice(0, 4)));
  c.pinned('§10.3 Routing', h.peer === undefined && !/^worktree:/m.test(r.text.split('\n\n')[0]), 'no `peer:` / `worktree:` line — the run is not a session worker', h.extraLines);
  c.pinned('§10.3 Routing (edits the working tree in place)', run !== undefined && run.cwd === fx.workspace, 'the vendor child in the workspace itself, not a worktree', run?.cwd);
  const claudeCalls = fx.claudeLog().map((x) => x.kind);
  c.note(`claude invocations while serving it: ${claudeCalls.length > 0 ? [...new Set(claudeCalls)].join(', ') : 'none'}`);
  // …and a Claude dispatch in the same session still becomes a session worker.
  const r2 = await srv.callTool('dispatch_task', { title: 'V15 claude with mesh on', prompt: 'V15: report done.' }, CALL_MS);
  const h2 = parseResult(r2.text);
  c.pinned('§10.3 Routing', !r2.isError && h2.worker === 'wa' && h2.provider === undefined, 'a Claude dispatch in the same session still runs on the Claude worker', head(r2.text));
  c.note(`the Claude dispatch ran as ${r2.text.startsWith('⚠') ? 'a one-shot fallback' : h2.peer !== undefined ? 'a session worker' : 'a one-shot'}`);
  const stop = await srv.callTool('mesh_stop_worker', { name: 'cx' }, CALL_MS);
  c.pinned('§10.5 ("`mesh_stop_worker` on its name → the existing unknown-worker answer")', stop.isError && /unknown[_ ]worker/i.test(stop.text), 'mesh_stop_worker on the Codex worker\'s name answered as an unknown worker', stop.text);
  const status = await srv.callTool('mesh_status', {}, CALL_MS);
  const workerLines = status.text.split('\n').filter((l) => /^\s+- \S/.test(l));
  c.pinned('§10.5 ("Session-worker features asked of a non-Claude worker: not offered")', !status.isError && !workerLines.some((l) => l.includes('[cx]')), 'no session-worker line for the Codex account in mesh_status', workerLines);
  return c.done(`${h.line1}, no ⚠ prefix, no --bg spawn`);
}

/* ------------------------------------------------------------------------- *
 * V16 — detach: true, provider: "codex"
 * ------------------------------------------------------------------------- */

async function v16(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex', model: 'gpt-5.6-sol' }] });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'V16 detached codex', prompt: 'V16: answer in one line.', provider: 'codex', detach: true }, CALL_MS);
  const h = parseResult(r.text);
  const run = fx.runs('codex')[0];
  c.must(!r.isError && run !== undefined && h.line1 === '[worker: cx, model: gpt-5.6-sol, provider: codex]' && h.body.trim() === run.text, 'the detached dispatch to complete through the codex fake', r.isError ? r.text : head(r.text));
  if (h.taskId === undefined) {
    return c.done('');
  }
  const status = await srv.callTool('dispatch_status', { id: h.taskId }, 30_000);
  let rec;
  try {
    rec = JSON.parse(status.text).tasks[0];
  } catch {
    rec = undefined;
  }
  c.must(rec !== undefined && rec.status === 'done' && typeof rec.result === 'string' && rec.result.includes(run?.text ?? '\u0000'), '`dispatch_status` to return status done and the result', clip(status.text, 300));
  c.pinned('contract-detach §3 (the relayed string is the recorded one)', rec?.result === r.text, 'the recorded result identical to the relayed one', clip(rec?.result ?? '', 200));
  const events = fx.eventsOfTask(h.taskId);
  const done = events.find((e) => e.status === 'done');
  c.pinned('§10.3 task events', done?.provider === 'codex' && done.inputTokens === TOKENS.codex.input, 'the done event of a detached run carrying provider and tokens', done);
  c.pinned('§11 F2 (a detached task carries a numeric supervisorPid)', events.some((e) => Number.isInteger(e.supervisorPid)), 'supervisorPid on the task events', events.map((e) => Object.keys(e).filter((k) => /pid/i.test(k))));
  const leaked = leaks(fx, [r.text, status.text]);
  c.pinned('§10.3 ("never … a token; never include `raw` payloads")', leaked.length === 0, 'no token and no raw payload in the detach records', leaked);
  return c.done(`${h.line1}; dispatch_status → ${rec?.status}, result ${rec?.result === r.text ? 'identical to' : 'different from'} the relayed text`);
}

/* ------------------------------------------------------------------------- *
 * V17 — list_workers and orchestrator_briefing
 * ------------------------------------------------------------------------- */

const VENDOR_LABEL = /\b(?:Codex|Cursor|Antigravity)\b/;
const OPT_IN_LINE = (line) => /provider/i.test(line) && /opt[- ]?in|only|unless|explicit|never|must|ask/i.test(line);

async function v17(t) {
  const c = new Checks();
  const mixed = t.fixture({ label: 'V17mixed', workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex', model: 'gpt-5.6-sol' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }] });
  const srv = await mixed.startServer();
  const list = await srv.callTool('list_workers', {}, CALL_MS);
  c.must(!list.isError, 'list_workers to answer', list.text);
  const shown = [];
  for (const w of mixed.workers) {
    const block = workerBlock(list.text, w.name);
    const label = PROVIDERS[w.provider].label;
    c.must(block !== undefined && block.includes(label), `list_workers: worker ${w.name} shown with its provider label "${label}"`, block ?? `no "- ${w.name}" line in: ${clip(list.text, 300)}`);
    shown.push(`${w.name}→${block?.includes(label) ? label : '?'}`);
  }
  const footer = list.text.split('\n').filter((l) => !/^(- |\s+\S)/.test(l) && OPT_IN_LINE(l));
  c.must(footer.length > 0, 'list_workers: the opt-in sentence (a footer line about `provider`)', clip(list.text, 400));
  const cxBlock = workerBlock(list.text, 'cx') ?? '';
  c.pinned('§10.3 Tool surface (list_workers: "the suggested model ids")', cxBlock.includes(PROVIDERS.codex.firstSuggestedModel), "the Codex worker's block to show its suggested model ids", cxBlock);
  c.note(`login state on the vendor lines: ${['cx', 'cu', 'ag'].map((n) => `${n} ${/logged[ -]?in|logged[ -]?out|login/i.test(workerBlock(list.text, n) ?? '') ? 'shown' : 'not shown'}`).join(', ')}`);
  const brief = await srv.callTool('orchestrator_briefing', { model: 'claude-opus-5-5' }, CALL_MS);
  c.must(!brief.isError && brief.text.split('\n').some(OPT_IN_LINE), 'orchestrator_briefing: the opt-in sentence', clip(brief.text.slice(-600), 400));
  c.pinned('§10.3 Tool surface (orchestrator_briefing)', /OTHER-VENDOR WORKERS/i.test(brief.text) && /`?worker`?/.test(brief.text) && /one-shot/i.test(brief.text), 'an "OTHER-VENDOR WORKERS" paragraph (opt-in by `worker` or `provider`; one-shot; …)', clip(brief.text.slice(-700), 400));
  const leaked = leaks(mixed, [list.text, brief.text]);
  c.pinned('§10.3 ("never … a token")', leaked.length === 0, 'no token in list_workers / the briefing', leaked);
  c.note(`vendor status probes list_workers ran: ${mixed.vendorLog().filter((x) => x.kind !== 'run').map((x) => `${x.cli} ${x.kind}`).join(', ') || 'none'}`);

  const plain = t.fixture({ label: 'V17claude', workers: [{ name: 'wa' }, { name: 'wb' }] });
  const psrv = await plain.startServer();
  const plist = await psrv.callTool('list_workers', {}, CALL_MS);
  const blocks = ['wa', 'wb'].map((n) => workerBlock(plist.text, n) ?? '');
  const optInThere = plist.text.split('\n').filter((l) => footer.includes(l) || OPT_IN_LINE(l));
  c.must(!plist.isError && optInThere.length === 0 && !VENDOR_LABEL.test(plist.text), 'Claude-only list_workers: no opt-in sentence (and no other vendor named)', optInThere.length > 0 ? optInThere : clip(plist.text, 400));
  c.must(blocks.every((b) => b !== '' && !b.includes('Claude Code')), 'Claude-only list_workers: no provider label on the worker lines', blocks.map((b) => b.split('\n')[0]));
  const pbrief = await psrv.callTool('orchestrator_briefing', { model: 'claude-opus-5-5' }, CALL_MS);
  c.must(!pbrief.isError && !/OTHER-VENDOR/i.test(pbrief.text) && !VENDOR_LABEL.test(pbrief.text), 'Claude-only briefing: no other-vendor paragraph and no vendor label', clip(pbrief.text.slice(-500), 300));
  return c.done(`mixed: ${shown.join(', ')}; opt-in line "${clip(footer[0] ?? '', 120)}"; Claude-only: neither`);
}

/* ------------------------------------------------------------------------- *
 * V18 — out/mcp/provider-cli.js status
 * ------------------------------------------------------------------------- */

const STATUS_KEYS = ['cliFound', 'error', 'loggedIn', 'mode', 'quota'];

/** Problems with one helper run: exit code, "one line of JSON", the ProviderStatus shape. */
function statusProblems(res, { exit = 0 } = {}) {
  const problems = [];
  if (res.timedOut) {
    return { problems: ['the helper did not exit (killed by the probe)'], status: undefined };
  }
  if (res.code !== exit) {
    problems.push(`exit code ${res.code}, expected ${exit}`);
  }
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  if (lines.length !== 1) {
    problems.push(`${lines.length} lines on stdout, expected exactly one`);
  }
  let status;
  try {
    status = JSON.parse(lines[0] ?? '');
  } catch {
    problems.push(`stdout is not JSON: ${clip(res.stdout, 120)}`);
    return { problems, status: undefined };
  }
  if (typeof status !== 'object' || status === null || Array.isArray(status)) {
    problems.push('the JSON is not an object');
    return { problems, status: undefined };
  }
  if (exit === 2) {
    if (typeof status.error !== 'string' || status.error === '') {
      problems.push('no `error` text for a bad invocation');
    }
    return { problems, status };
  }
  const str = (v, max) => v === null || (typeof v === 'string' && v.length <= max);
  if (typeof status.cliFound !== 'boolean') {
    problems.push('cliFound is not a boolean');
  }
  if (!(status.loggedIn === null || typeof status.loggedIn === 'boolean')) {
    problems.push('loggedIn is not boolean | null');
  }
  if (!str(status.mode, 32)) {
    problems.push('mode is not a string ≤ 32 | null');
  }
  if (!str(status.error, 200)) {
    problems.push('error is not a string ≤ 200 | null');
  }
  const q = status.quota;
  if (q !== null) {
    const windowsOk =
      typeof q === 'object' &&
      typeof q.allowed === 'boolean' &&
      Array.isArray(q.windows) &&
      q.windows.every((w) => w && typeof w.label === 'string' && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && (w.resetAt === null || typeof w.resetAt === 'string') && Object.keys(w).sort().join() === 'label,resetAt,usedPercent');
    if (!windowsOk || Object.keys(q).sort().join() !== 'allowed,windows') {
      problems.push(`quota is not null | { allowed, windows: [{ label, usedPercent, resetAt }] }: ${clip(JSON.stringify(q), 160)}`);
    }
  }
  if (Object.keys(status).sort().join() !== STATUS_KEYS.join()) {
    problems.push(`keys ${Object.keys(status).sort().join()} — expected exactly ${STATUS_KEYS.join()}`);
  }
  return { problems, status };
}

async function v18(t) {
  const c = new Checks();
  const fx = t.fixture({
    workers: [
      { name: 'cin', provider: 'codex' },
      { name: 'ckey', provider: 'codex', auth: 'api-key' },
      { name: 'cout', provider: 'codex', auth: 'out' },
      { name: 'cq', provider: 'codex', auth: 'chatgpt-quota' },
      { name: 'cu', provider: 'cursor' },
      { name: 'ag', provider: 'gemini' },
    ],
  });
  const dirOf = (name) => fx.worker(name).configDir;
  const outputs = [];
  const helper = async (args, timeoutMs = 60_000) => {
    const res = await runNode([PROVIDER_CLI_JS, ...args], { env: fx.env(), cwd: fx.workspace, timeoutMs });
    outputs.push({ args, text: `${res.stdout}\n${res.stderr}` });
    return res;
  };
  const seen = [];
  /** One helper run checked against the ProviderStatus shape and against `want`. */
  const expectStatus = async (label, args, want, clause) => {
    const res = await helper(['status', ...args]);
    const { problems, status } = statusProblems(res);
    c.must(problems.length === 0, `${label}: one line of JSON in the ProviderStatus shape, exit 0`, `${problems.join('; ')} — stdout ${clip(res.stdout, 200)} stderr ${clip(res.stderr, 200)}`);
    if (status === undefined) {
      return undefined;
    }
    const diff = Object.entries(want).filter(([k, v]) => (typeof v === 'function' ? !v(status[k]) : status[k] !== v)).map(([k]) => `${k}=${JSON.stringify(status[k])}`);
    const expected = `${label}: ${Object.entries(want).map(([k, v]) => `${k} ${typeof v === 'function' ? v.label : JSON.stringify(v)}`).join(', ')}`;
    if (clause) {
      c.pinned(clause, diff.length === 0, expected, status);
    } else {
      c.must(diff.length === 0, expected, status);
    }
    seen.push(`${label}→${JSON.stringify({ cliFound: status.cliFound, loggedIn: status.loggedIn, mode: status.mode, quota: status.quota === null ? null : 'snapshot' })}`);
    return status;
  };
  const notTrue = Object.assign((v) => v !== true, { label: 'not true' });

  // logged in
  fx.assertHermetic();
  await Promise.all([
    expectStatus('codex logged in', ['codex', dirOf('cin')], { cliFound: true, loggedIn: true, quota: null }),
    expectStatus('codex api key', ['codex', dirOf('ckey')], { cliFound: true, loggedIn: true, mode: 'api-key' }, 'providers.ts ProviderStatus.mode'),
    expectStatus('codex logged out', ['codex', dirOf('cout')], { cliFound: true, loggedIn: false }),
    expectStatus('codex, a directory that does not exist', ['codex', path.join(fx.home, 'no-such-codex-home')], { cliFound: true, loggedIn: false }, '§10.3 providerStatus ("never rejects")'),
    expectStatus('cursor logged in', ['cursor', dirOf('cu')], { cliFound: true, loggedIn: true, quota: null }),
    expectStatus('antigravity logged in', ['gemini', dirOf('ag')], { cliFound: true, loggedIn: true, quota: null }),
  ]);
  await Promise.all([
    expectStatus('codex mode', ['codex', dirOf('cin')], { mode: 'chatgpt' }, 'providers.ts ProviderStatus.mode'),
    expectStatus('cursor mode', ['cursor', dirOf('cu')], { mode: 'cursor' }, 'providers.ts ProviderStatus.mode'),
    expectStatus('antigravity mode (provider spelled "antigravity")', ['antigravity', dirOf('ag')], { mode: 'google' }, 'providers.ts ProviderStatus.mode'),
  ]);

  // logged out (Cursor and Antigravity keep no login in the sandbox: the fake CLI says so)
  fx.setScenario({ cursor: { login: 'out' }, gemini: { login: 'out' } });
  await Promise.all([
    expectStatus('cursor logged out', ['cursor', dirOf('cu')], { cliFound: true, loggedIn: false }),
    expectStatus('antigravity logged out', ['gemini', dirOf('ag')], { cliFound: true, loggedIn: false }),
  ]);
  fx.setScenario({});

  // --quota: the fixture `cq` carries a usable bearer; the network guard answers the request
  const fetched = () => fx.netLog().filter((x) => x.kind === 'fetch');
  await expectStatus('codex with a bearer, WITHOUT --quota', ['codex', dirOf('cq')], { loggedIn: true, quota: null });
  c.pinned('§10.3 provider-cli (`--quota` is what asks for a usage reading)', fetched().length === 0, 'no usage request without `--quota`', fetched().map((x) => x.url));
  fx.setNet({ mode: 'deny' }, { expectBearer: SECRETS.accessToken });
  let started = Date.now();
  let st = await expectStatus('codex --quota, the usage request fails', ['codex', dirOf('cq'), '--quota'], { loggedIn: true, quota: null });
  c.must(Date.now() - started < 40_000, 'codex --quota with a failing request: an answer without hanging', `${Date.now() - started} ms`);
  const attempts = fetched().length;
  fx.setNet({ mode: 'snapshot', body: { allowed: true, primary_window: { used_percent: 42, resets_at: 1893456000 }, secondary_window: { used_percent: 7, resets_at: 1893456000 }, harness_raw_marker: RAW_MARKER } }, { expectBearer: SECRETS.accessToken });
  st = await helper(['status', 'codex', dirOf('cq'), '--quota']);
  const snap = statusProblems(st);
  c.must(snap.problems.length === 0, 'codex --quota, the usage request answered: one line in the ProviderStatus shape (quota null or a snapshot), exit 0', `${snap.problems.join('; ')} — ${clip(st.stdout, 240)}`);
  if (attempts > 0) {
    const w = snap.status?.quota?.windows ?? [];
    c.pinned('providers.ts ProviderStatus.quota', snap.status?.quota?.allowed === true && w.length === 2 && w[0].usedPercent === 42 && w[1].usedPercent === 7 && typeof w[0].resetAt === 'string', 'the snapshot the stub served: allowed, windows 42 % and 7 % with a reset time', snap.status?.quota);
  } else {
    c.note('the helper never called fetch for --quota (it cannot have produced a snapshot)');
  }
  fx.setNet({ mode: 'hang' }, { expectBearer: SECRETS.accessToken });
  started = Date.now();
  st = await helper(['status', 'codex', dirOf('cq'), '--quota'], 60_000);
  const hung = statusProblems(st);
  const hangMs = Date.now() - started;
  c.must(hung.problems.length === 0 && hung.status?.quota === null && hangMs < 45_000, 'codex --quota against an endpoint that never answers: `quota: null`, without hanging', `${hung.problems.join('; ') || `quota ${JSON.stringify(hung.status?.quota)}`} after ${hangMs} ms`);
  fx.setNet({ mode: 'deny' });
  await Promise.all([
    expectStatus('cursor --quota', ['cursor', dirOf('cu'), '--quota'], { loggedIn: true, quota: null }, 'PV5 (adapter 0.1.1 has no Cursor usage reading)'),
    expectStatus('antigravity --quota', ['gemini', dirOf('ag'), '--quota'], { loggedIn: true, quota: null }, 'PV5 (adapter 0.1.1 has no Antigravity usage reading)'),
  ]);
  const usageCalls = fetched();
  c.pinned('§10.3 ("never log, return or store a token")', usageCalls.every((x) => x.bearerMatches !== false), 'the bearer sent only as the Authorization header of the usage request', usageCalls.map((x) => `${x.url} bearerMatches=${x.bearerMatches}`));
  seen.push(`--quota: ${usageCalls.length} usage request(s), all answered by the harness stub`);

  // garbage arguments
  const garbage = [[], ['status'], ['status', 'nope', dirOf('cin')], ['frobnicate', 'codex', dirOf('cin')], ['status', 'codex'], ['status', 'codex', dirOf('cin'), '--bogus']];
  const exits = await Promise.all(
    garbage.map(async (args) => {
      const res = await helper(args);
      const { problems } = statusProblems(res, { exit: 2 });
      c.must(problems.length === 0, `garbage arguments ${JSON.stringify(args.map((a) => (a.startsWith(fx.root) ? '<dir>' : a)))}: one line of JSON with an \`error\`, exit 2`, `${problems.join('; ')} — exit ${res.code}, stdout ${clip(res.stdout, 160)}`);
      return res.code;
    }),
  );
  seen.push(`garbage arguments → exit ${[...new Set(exits)].join('/')}`);
  const odd = await helper(['status', 'claude', dirOf('cin')]);
  c.note(`\`status claude <dir>\` → exit ${odd.code} ${clip(odd.stdout, 80)}`);
  const blank = await helper(['status', 'codex', '']);
  c.note(`an empty <dir> → exit ${blank.code} ${clip(blank.stdout, 80)}`);

  // binary missing — only when no real binary could be picked up instead
  let missingSafe = true;
  for (const cli of VENDOR_CLIS) {
    fx.removeCli(cli);
  }
  try {
    fx.assertHermetic();
  } catch (err) {
    missingSafe = false;
    c.must(false, 'the "binary missing" cases to be runnable without any risk of starting a real CLI', err.message);
  }
  if (missingSafe) {
    await Promise.all([
      expectStatus('codex, binary missing', ['codex', dirOf('cin')], { cliFound: false }),
      expectStatus('cursor, binary missing', ['cursor', dirOf('cu')], { cliFound: false, loggedIn: notTrue }),
      expectStatus('antigravity, binary missing', ['gemini', dirOf('ag')], { cliFound: false, loggedIn: notTrue }),
    ]);
  }

  // nothing secret, in any output above
  const tokens = { 'id token': SECRETS.idToken, 'access token': SECRETS.accessToken, 'refresh token': SECRETS.refreshToken, 'API key': SECRETS.apiKey };
  const tokenLeaks = outputs.flatMap((o) => Object.entries(tokens).filter(([, v]) => o.text.includes(v)).map(([k]) => `${k} in the output of ${JSON.stringify(o.args.slice(0, 2))}`));
  c.must(tokenLeaks.length === 0, `never a token in the helper's output (${outputs.length} runs; an id token, an access token, a refresh token and an API key were planted)`, tokenLeaks);
  const personal = { 'the Codex account e-mail': SECRETS.email, 'the Cursor identity': CURSOR_IDENTITY, 'the raw vendor payload marker': RAW_MARKER, 'the ChatGPT account id': SECRETS.accountId };
  const personalLeaks = outputs.flatMap((o) => Object.entries(personal).filter(([, v]) => o.text.includes(v)).map(([k]) => `${k} in the output of ${JSON.stringify(o.args.slice(0, 2))}`));
  c.pinned('providers.ts ProviderStatus ("No token, e-mail or raw vendor payload ever appears in it")', personalLeaks.length === 0, 'no e-mail, account id or raw payload either', personalLeaks);
  return c.done(seen.join('; '));
}

/* ------------------------------------------------------------------------- *
 * V19 — Claude-only regression
 * ------------------------------------------------------------------------- */

async function v19(t) {
  const c = new Checks();
  const fx = t.fixture({ label: 'V19oneshot', workers: [{ name: 'wa' }, { name: 'wb' }] });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'V19 claude one-shot', prompt: 'V19: answer in one line.' }, CALL_MS);
  const h = parseResult(r.text);
  const lines = r.text.split('\n');
  c.must(!r.isError && /^\[worker: w[ab], model: opus\]$/.test(lines[0]) && /^task: \S+ · output: .+\.md$/.test(lines[1] ?? '') && lines[2] === '' && h.body.includes(CLAUDE_ONESHOT_MARKER), 'a Claude one-shot: the 2-line header `[worker: <w>, model: opus]` / `task: … · output: …`, a blank line, the text', head(r.text));
  c.must(!/provider/.test(lines.slice(0, 2).join('\n')), 'no `provider:` field in a Claude one-shot header', lines.slice(0, 2));
  const withKey = fx.events().filter((e) => Object.hasOwn(e, 'provider'));
  c.must(fx.events().length >= 2 && withKey.length === 0, 'no `provider` key on the events of a Claude one-shot', withKey.map((e) => `${e.status}:${JSON.stringify(e.provider)}`));
  c.must(fx.vendorLog().length === 0, 'no vendor CLI involved in a Claude-only registry', fx.vendorLog().map((x) => `${x.cli}:${x.kind}`));
  await srv.stop();

  const mesh = t.fixture({ label: 'V19mesh', workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa' }, { name: 'wb' }], claude: { bg: { default: 'result-done' } } });
  const msrv = await mesh.startServer();
  const r2 = await msrv.callTool('dispatch_task', { title: 'V19 claude session worker', prompt: 'V19: report done.' }, CALL_MS);
  const h2 = parseResult(r2.text);
  c.must(!r2.isError && h2.startsWithHeader && /^\[worker: w[ab], model: opus\]$/.test(h2.line1 ?? '') && h2.taskId !== undefined && mesh.claudeBgSpawns().length === 1, 'a Claude session-worker dispatch (`--bg`): the same 2-line header', r2.isError ? r2.text : `${head(r2.text)} (--bg spawns: ${mesh.claudeBgSpawns().length})`);
  c.must(h2.provider === undefined && h2.conversation === undefined, 'no `provider:` field and no `conversation:` line on a session-worker result', h2.line1);
  const mWithKey = mesh.events().filter((e) => Object.hasOwn(e, 'provider'));
  c.must(mesh.events().length >= 2 && mWithKey.length === 0, 'no `provider` key on the events of a session-worker dispatch', mWithKey.map((e) => `${e.status}:${JSON.stringify(e.provider)}`));
  c.note(h2.peer !== undefined ? `peer line "${clip(h2.peer, 60)}"` : 'no peer line');
  return c.done(`one-shot ${lines[0]}; session worker ${h2.line1}; no provider key on ${fx.events().length + mesh.events().length} events`);
}

/* ------------------------------------------------------------------------- *
 * V20 — registry hygiene
 * ------------------------------------------------------------------------- */

async function v20(t) {
  const c = new Checks();
  // An entry whose `provider` this version does not know is NOT a worker — not a Claude Code
  // worker, not any vendor's. Its directory is prepared exactly like a Claude account's (the
  // bait), and a real Claude worker and a Codex worker sit beside it. Run twice: with the
  // entry under `vendorWorkers`, where this version writes such an entry and where no pre-2.0
  // editor reads it as a Claude account; and with it under `workers`, where a hand edit or an
  // earlier build may have left one.
  const unknownProviderLeg = async (placement) => {
    const where = `entry under \`${placement}\``;
    const fx = t.fixture({
      label: placement === 'vendorWorkers' ? 'V20weird' : 'V20weirdInWorkers',
      workers: [{ name: 'ww', extra: { provider: 'weird', model: 'weird-large', permissionMode: 'full-auto', vendorKey: { kept: [1, 2] } } }, { name: 'wa' }, { name: 'cx', provider: 'codex' }],
    });
    const registryFile = path.join(fx.orchRoot, 'registry.json');
    const planted = readJson(registryFile);
    const unknown = planted.workers.find((w) => w.name === 'ww');
    if (placement === 'vendorWorkers') {
      planted.workers = planted.workers.filter((w) => w.name !== 'ww');
      planted.vendorWorkers = [unknown];
      fs.writeFileSync(registryFile, JSON.stringify(planted, null, 2));
    }
    const wwDir = fx.worker('ww').configDir;
    // Its name with a Claude Code label attached, in any of the forms a worker's provider is
    // shown in: `- ww [Claude Code]`, `ww (Claude Code)`, `ww: Claude Code`.
    const asClaudeCode = /\bww\b\s*[[(:]\s*Claude Code/;
    const aimedAtIt = () => fx.claudeLog().filter((x) => x.configDir === wwDir);

    const srv = await fx.startServer();
    const list = await srv.callTool('list_workers', {}, CALL_MS);
    c.pinned('contract-2.0-fixes §2.1 ("in NO enumeration")', !list.isError && workerBlock(list.text, 'ww') === undefined, `${where}: no worker row for the entry with \`provider: "weird"\` in list_workers`, workerBlock(list.text, 'ww') ?? clip(list.text, 300));
    c.must(workerBlock(list.text, 'wa') !== undefined && workerBlock(list.text, 'cx') !== undefined, `${where}: the two real workers still listed`, clip(list.text, 300));
    c.pinned('contract-2.0-fixes §2.1', !asClaudeCode.test(list.text), `${where}: the entry never labelled Claude Code`, clip(list.text, 300));

    // A dispatch that NAMES it is an error, and nothing is started for it.
    const r = await srv.callTool('dispatch_task', { title: 'V20 unknown provider', prompt: 'V20: never runs.', worker: 'ww' }, CALL_MS);
    c.pinned('contract-2.0-fixes §2.1 / §3.2', r.isError && /\bww\b/.test(r.text), `${where}: a dispatch naming the entry answered with an error that names it`, r.text);
    c.pinned('contract-2.0-fixes §2.1', !asClaudeCode.test(r.text), `${where}: the error does not call the entry a Claude Code worker`, r.text);
    c.pinned('contract-2.0-fixes §2.1 ("not assigned")', fx.claudeOneShots().length === 0 && fx.claudeBgSpawns().length === 0 && fx.runs().length === 0, `${where}: no worker process spawned for that dispatch`, [...fx.claudeOneShots(), ...fx.claudeBgSpawns(), ...fx.runs()].map((x) => x.kind));
    const startedAsIt = fx.events().filter((e) => e.worker === 'ww' && e.status === 'running');
    c.must(startedAsIt.length === 0, `${where}: no \`running\` event for a worker named ww`, startedAsIt.length);

    // A dispatch that names nobody runs on the Claude worker — never on the entry.
    const unnamed = await srv.callTool('dispatch_task', { title: 'V20 unnamed dispatch', prompt: 'V20: answer in one line.' }, CALL_MS);
    const ran = parseResult(unnamed.text);
    c.must(!unnamed.isError && ran.worker === 'wa', `${where}: a dispatch naming no worker ran on the Claude Code worker wa`, unnamed.isError ? unnamed.text : head(unnamed.text, 1));
    c.pinned('contract-2.0-fixes §2.1 ("not probed, not assigned")', aimedAtIt().length === 0, `${where}: no \`claude\` invocation of any kind aimed at the entry's directory`, aimedAtIt().map((x) => x.kind));
    await srv.stop();

    // The entry is still in the file exactly as it was — once, and never moved INTO `workers`.
    const after = readJson(registryFile);
    const copies = (key) => (Array.isArray(after?.[key]) ? after[key].filter((w) => w?.name === 'ww') : []);
    const everywhere = [...copies('workers'), ...copies('vendorWorkers')];
    c.pinned('contract-2.0-fixes §2.1 ("NEVER modified; written back as is")', everywhere.length === 1 && JSON.stringify(everywhere[0]) === JSON.stringify(unknown), `${where}: the entry still in registry.json, once, unchanged`, everywhere);
    if (placement === 'vendorWorkers') {
      c.pinned('contract-2.0-fixes §2.1', copies('vendorWorkers').length === 1 && copies('workers').length === 0, 'the entry still under `vendorWorkers`, and not under `workers`', { workers: copies('workers').length, vendorWorkers: copies('vendorWorkers').length });
    }
    return { refusal: r.text, ran: ran.line1 };
  };
  const leg = await unknownProviderLeg('vendorWorkers');
  await unknownProviderLeg('workers');

  // Two entries with the same provider and directory: only the first exists.
  const dup = t.fixture({
    label: 'V20dup',
    workers: [{ name: 'wa' }, { name: 'c1', provider: 'codex' }],
  });
  const dir = dup.worker('c1').configDir;
  const file = path.join(dup.orchRoot, 'registry.json');
  const registry = readJson(file);
  registry.workers.push(
    { name: 'c2', configDir: dir, provider: 'codex' },
    { name: 'c3', configDir: `${dir}${path.sep}.`, provider: 'codex' },
    { name: 'c4', configDir: `${dir}${path.sep}..${path.sep}${path.basename(dir)}`, provider: 'codex' },
    { name: 'g1', configDir: dir, provider: 'gemini' },
  );
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  const dsrv = await dup.startServer();
  const dlist = await dsrv.callTool('list_workers', {}, CALL_MS);
  const listed = (name) => workerBlock(dlist.text, name) !== undefined;
  c.must(!dlist.isError && listed('c1') && !listed('c2'), 'two entries with the same provider and directory → only the first listed', `c1 ${listed('c1') ? 'listed' : 'missing'}, c2 ${listed('c2') ? 'listed' : 'not listed'} — ${clip(dlist.text, 260)}`);
  c.pinned('§10.2 ("may not share (provider, path.resolve(configDir))")', !listed('c3') && !listed('c4'), 'another spelling of the same directory is the same directory', `c3 ${listed('c3') ? 'listed' : 'not listed'}, c4 ${listed('c4') ? 'listed' : 'not listed'}`);
  c.pinned('§10.2 (the key includes the provider)', listed('g1'), 'the same directory under a DIFFERENT provider is a different worker', clip(dlist.text, 260));
  const r2 = await dsrv.callTool('dispatch_task', { title: 'V20 dropped worker', prompt: 'V20: never runs.', worker: 'c2' }, CALL_MS);
  c.pinned('§10.2 ("the second such entry is dropped on read")', r2.isError && /unknown worker/i.test(r2.text) && dup.runs('codex').length === 0, 'the dropped entry is not dispatchable (unknown worker)', r2.text);
  for (let i = 1; i <= 2; i++) {
    const rr = await dsrv.callTool('dispatch_task', { title: `V20 codex ${i}`, prompt: 'V20: answer in one line.', provider: 'codex' }, CALL_MS);
    c.pinned('§10.2', !rr.isError && parseResult(rr.text).worker === 'c1', `provider "codex" dispatch ${i} on c1, the only Codex worker left`, head(rr.text, 1));
  }
  return c.done(`provider "weird" → not a worker: no row in list_workers, a dispatch naming it refused ("${clip(leg.refusal, 70)}"), an unnamed dispatch ran as ${leg.ran}, entry unchanged under vendorWorkers (and the same with the entry under workers); duplicates: listed ${['c1', 'c2', 'c3', 'c4', 'g1'].filter(listed).join(', ')}`);
}

/* ------------------------------------------------------------------------- *
 * Extras — outside the twenty rows
 * ------------------------------------------------------------------------- */

/** X1 — a vendor helper keeps the pipes open after the CLI answered and exited. */
async function x1(t) {
  const c = new Checks();
  const lifetimeMs = 40_000;
  const fx = t.fixture({ workers: [{ name: 'cx', provider: 'codex' }], scenario: { codex: { run: { kind: 'spawn-grandchild', grandchild: { holdPipes: true, lifetimeMs } } } } });
  const srv = await fx.startServer();
  const call = srv.startTool('dispatch_task', { title: 'X1 held pipes', prompt: 'X1: answer in one line.', worker: 'cx' });
  const run = await waitFor(() => fx.runs('codex')[0], { timeoutMs: 60_000, label: 'the fake to start', abort: () => fx.aborted });
  const r = await call.answer(CALL_MS);
  const afterStart = Date.now() - run.ts;
  c.pinned('§10.3 process control ("settle on \'exit\' + ≤250 ms drain (never \'close\')"), contract-2.0 §F', !r.isError && afterStart < lifetimeMs - 10_000, `the result within seconds of the CLI exiting, not when the helper lets go of the pipes ${lifetimeMs / 1000} s later`, r.isError ? r.text : `${afterStart} ms after the child started`);
  c.pinned('§10.3', !r.isError && parseResult(r.text).body.trim() === run.text, "the fake's answer as the result", head(r.text));
  c.note(`the pipe-holding helper is ${isPidAlive(run.grandchildPid) ? 'still alive' : 'dead'} after the settle`);
  return c.done(`settled ${afterStart} ms after the child started while a helper held its stdout/stderr for ${lifetimeMs / 1000} s`);
}

/** X2 — the provider CLI is not installed. */
async function x2(t) {
  const c = new Checks();
  const fx = t.fixture({ clis: ['cursor-agent', 'agy'], workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }] });
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'X2 codex not installed', prompt: 'X2: never runs.', provider: 'codex' }, CALL_MS);
  c.pinned('§10.5 ("dispatch error naming the CLI and the provider")', r.isError && /\bcodex\b/.test(r.text) && r.text.includes('Codex'), 'an error naming the CLI `codex` and the provider Codex', r.text);
  c.pinned('§10.5 ("no cooldown")', !(fx.stats().cx?.cooldownUntil > Date.now()), 'no cooldown for the worker', fx.stats().cx);
  c.pinned('§10.5', fx.claudeOneShots().length === 0 && fx.runs().length === 0, 'nothing run instead', [...fx.claudeLog(), ...fx.runs()].map((x) => x.kind));
  const list = await srv.callTool('list_workers', {}, CALL_MS);
  const block = workerBlock(list.text, 'cx');
  c.pinned('§10.5 ("`list_workers` … show \\"CLI not found\\"")', block !== undefined && /CLI not found/i.test(block), 'list_workers: "CLI not found" on the Codex worker', block ?? clip(list.text, 300));
  return c.done(`"${clip(r.text, 150)}"; list_workers: ${clip(block ?? '', 120)}`);
}

/** X3 — §11 F5: a non-string `worker` argument. */
async function x3(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }] });
  const srv = await fx.startServer();
  // The argument check's refusal (mcp/dispatch-args), made by the server before anything else:
  // `invalid worker — expected a string, got a number` / `an object` / `an array` / `a boolean`.
  const want = 'invalid worker — expected a string, got ';
  const seen = [];
  for (const worker of [42, { name: 'wa' }, ['wa'], true]) {
    for (const extra of [{}, { detach: true }, { provider: 'codex' }]) {
      const r = await srv.callTool('dispatch_task', { title: 'X3 non-string worker', prompt: 'X3: never runs.', worker, ...extra }, CALL_MS);
      c.pinned('§11 F5', r.isError && r.text.includes(want), `worker ${JSON.stringify(worker)}${Object.keys(extra).length > 0 ? ` with ${JSON.stringify(extra)}` : ''} rejected with "${want}"`, r.text);
    }
    seen.push(JSON.stringify(worker));
  }
  await sleep(500);
  const records = fs.readdirSync(fx.tasksDir);
  c.pinned('§11 F5 ("rejected before any event is written … never written into an event or a result record")', fx.events().length === 0 && records.length === 0, 'no task event and no task file', { events: fx.events().length, files: records });
  c.pinned('§11 F5', fx.vendorLog().length === 0 && fx.claudeLog().length === 0, 'nothing spawned', [...fx.vendorLog(), ...fx.claudeLog()].map((x) => x.kind));
  return c.done(`worker ${seen.join(', ')} — in-process, detached and with a provider — all rejected with "${want}"; no event, no file, no spawn`);
}

/** X4 — §11 F3: a parked session worker that was knowingly dispatched under overage billing. */
async function x4(t) {
  const c = new Checks();
  const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const exhausted = [
    { kind: 'session', label: 'Session (5hr)', percent: 100, severity: 'critical', resetsAt: future },
    { kind: 'weekly_all', label: 'Weekly (7 day)', percent: 5, severity: 'normal', resetsAt: future },
  ];
  // The live usage probe of the parked episode says "exhausted" in BOTH legs.
  const claude = { bg: { default: 'park-no-result' }, usage: { available: true, fiveHour: 100, sevenDay: 5 } };
  const leg = async (label, opts) => {
    const fx = t.fixture({ label, workspace: 'git', workers: [{ name: 'wa' }], claude, ...opts });
    const srv = await fx.startServer();
    const r = await srv.callTool('dispatch_task', { title: label, prompt: 'X4: end the turn without a result.' }, 170_000);
    return { fx, r, spawned: fx.claudeBgSpawns().length, cooled: fx.stats().wa?.cooldownUntil > Date.now(), stops: fx.claudeLog().filter((x) => x.kind === 'stop').length };
  };
  // Control: the cached reading is healthy but an hour old, so the parked path spends its one
  // live probe, which says "exhausted" → the quota rung. (A fresh healthy reading is believed.)
  const old = Date.now() - 3_600_000;
  const [control, overage] = await Promise.all([
    leg('X4control', { registry: { meshMode: 'on' }, usage: { wa: { fetchedAt: old, windowsFetchedAt: old, lastGoodWindowsAt: old } } }),
    leg('X4overage', { registry: { meshMode: 'on', overageWorkerDispatch: 'allow' }, usage: { wa: { windows: exhausted, extraUsage: { enabled: true, percent: 10, spendLabel: '$5.00 / $50.00' } } } }),
  ]);
  if (overage.spawned === 0) {
    c.note(`inconclusive: the overage dispatch did not start a session worker (${clip(overage.r.text, 120)})`);
    return c.done('no session worker to observe');
  }
  const controlTookQuotaRung = control.r.isError && !PARKED_TEXT.test(control.r.text);
  if (!controlTookQuotaRung) {
    c.note(`the control leg (no overage, live usage exhausted) did not take the quota rung — "${clip(control.r.text, 90)}" — so this probe cannot tell the two paths apart here`);
  }
  c.pinned('§11 F3 ("must SKIP the quota rung … and go to the error settle")', overage.r.isError && PARKED_TEXT.test(overage.r.text), 'a parked worker dispatched under overage billing settled as the parked ERROR ("ended its turn without writing the result file")', overage.r.text);
  c.pinned('§11 F3', !overage.cooled, 'no quota cooldown for that account', overage.fx.stats().wa);
  c.pinned('contract-2.0 §5.2 ("Do NOT stop the worker")', overage.stops === 0, 'the parked worker not stopped', `${overage.stops} stop invocation(s)`);
  return c.done(`overage leg: "${clip(overage.r.text, 110)}"; control leg (quota rung expected): "${clip(control.r.text, 90)}"${control.cooled ? ', cooled down' : ''}`);
}

/** X5 — §11 F4: the `peer:` line of a worker the host account cannot see. */
async function x5(t) {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa' }], claude: { bg: { default: 'result-done' } } });
  // A mirror of a worker on another account is `<host config dir>/sessions/<pid>.json`. With
  // that directory read-only the bridge cannot write one, so the worker stays invisible.
  const hostSessions = path.join(fx.home, '.claude', 'sessions');
  fs.mkdirSync(hostSessions, { recursive: true });
  fs.chmodSync(hostSessions, 0o555);
  try {
    const srv = await fx.startServer();
    const r = await srv.callTool('dispatch_task', { title: 'X5 unmirrored worker', prompt: 'X5: report done.' }, CALL_MS);
    const h = parseResult(r.text);
    const job = fx.claudeJobs()[0];
    if (r.isError || !job || h.peer === undefined) {
      c.note(`inconclusive: no session worker with a peer line (${clip(r.text, 140)})`);
      return c.done('nothing to observe');
    }
    const mirrored = fs.existsSync(path.join(hostSessions, `${job.pid}.json`));
    if (mirrored) {
      c.note('inconclusive: the worker WAS mirrored into the host account despite the read-only directory');
      return c.done(`peer: ${clip(h.peer, 100)}`);
    }
    c.pinned('§11 F4', /not visible to this session's account yet \(mirror pending\); mesh_status shows when it is/.test(h.peer) && !/SendMessage/.test(h.peer), "`peer: <name> — not visible to this session's account yet (mirror pending); mesh_status shows when it is` for a worker with no entry in the host account", `peer: ${h.peer}`);
    return c.done(`no mirror entry for worker pid ${job.pid}; peer: ${clip(h.peer, 120)}`);
  } finally {
    try {
      fs.chmodSync(hostSessions, 0o755);
    } catch {
      // removed with the sandbox
    }
  }
}

/** X6 — one dispatch_tasks batch across every provider. */
async function x6(t) {
  const c = new Checks();
  const fx = t.fixture({ workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }] });
  const srv = await fx.startServer();
  const prompt = 'X6: answer in one line.';
  const r = await srv.callTool(
    'dispatch_tasks',
    {
      tasks: [
        { title: 'X6 claude', prompt },
        { title: 'X6 codex', prompt, provider: 'codex' },
        { title: 'X6 cursor', prompt, worker: 'cu' },
        { title: 'X6 agy', prompt, provider: 'agy' },
        { title: 'X6 nope', prompt, provider: 'nope' },
      ],
    },
    CALL_MS,
  );
  const want = ['[worker: wa, model: opus]', '[worker: cx, model: -, provider: codex]', '[worker: cu, model: -, provider: cursor]', '[worker: ag, model: -, provider: gemini]'];
  const missing = want.filter((line) => !r.text.split('\n').includes(line));
  c.pinned('§10.3 Tool surface (dispatch_tasks takes `provider` per task)', missing.length === 0, 'each task of the batch on its own provider, with its own header', missing.length > 0 ? `missing ${missing.join(' / ')} in: ${clip(r.text, 500)}` : '');
  c.pinned('§10.3 Selection 1', r.text.includes('unknown provider "nope"'), 'the task with an unknown provider rejected inside the batch, the others unaffected', clip(r.text, 400));
  const counts = { claude: fx.claudeOneShots().length, codex: fx.runs('codex').length, cursor: fx.runs('cursor').length, gemini: fx.runs('gemini').length };
  c.pinned('§10.3 Selection', Object.values(counts).every((n) => n === 1), 'exactly one run per CLI', counts);
  const byTitle = Object.fromEntries(fx.events().filter((e) => e.status === 'done').map((e) => [e.title, e.provider]));
  c.pinned('§10.3 task events', JSON.stringify(byTitle) === JSON.stringify({ ...byTitle, 'X6 claude': undefined, 'X6 codex': 'codex', 'X6 cursor': 'cursor', 'X6 agy': 'gemini' }) && Object.keys(byTitle).length === 4, 'four done events, each with its provider (none for Claude)', byTitle);
  return c.done(`one batch: ${Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(', ')}; "nope" rejected in place`);
}

/** X7 — what the session-worker machinery does with a vendor account's home directory. */
async function x7(t) {
  const c = new Checks();
  const fx = t.fixture({ workspace: 'git', registry: { meshMode: 'on' }, workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }, { name: 'cu', provider: 'cursor' }, { name: 'ag', provider: 'gemini' }], claude: { bg: { default: 'result-done' } } });
  // A healthy host account has a session registry. The vendor homes have none: `sessions/`
  // under a Claude config dir is Claude Code's session registry, and these are not Claude
  // config dirs.
  fs.mkdirSync(path.join(fx.home, '.claude', 'sessions'), { recursive: true });
  const tree = (dir) => {
    const out = [];
    const walk = (p, rel) => {
      let entries = [];
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        out.push(path.join(rel, e.name));
        if (e.isDirectory()) {
          walk(path.join(p, e.name), path.join(rel, e.name));
        }
      }
    };
    walk(dir, '');
    return out.sort();
  };
  const vendors = fx.workers.filter((w) => w.provider !== 'claude');
  const before = Object.fromEntries(vendors.map((w) => [w.name, tree(w.configDir)]));
  const srv = await fx.startServer();
  const r = await srv.callTool('dispatch_task', { title: 'X7 claude session worker', prompt: 'X7: report done.' }, CALL_MS);
  if (r.isError || fx.claudeBgSpawns().length === 0) {
    c.note(`inconclusive: no session worker was started (${clip(r.text, 140)})`);
    return c.done('nothing to observe');
  }
  // one bridge sweep
  await sleep(3000);
  const status = await srv.callTool('mesh_status', {}, CALL_MS);
  const bridge = status.text.split('\n').find((l) => /^bridge:/.test(l)) ?? '';
  const named = vendors.filter((w) => status.text.includes(w.configDir)).map((w) => `${w.name} (${PROVIDERS[w.provider].label})`);
  if (named.length > 0) {
    c.finding(
      'X7',
      `with Mesh Mode on, the session-worker bridge looks for a Claude session registry inside the home directories of VENDOR workers — mesh_status names ${named.join(', ')}: "${clip(bridge.split(fx.root).join('<sandbox>'), 420)}". ` +
        'So a registered Codex, Cursor or Antigravity worker leaves the bridge reporting itself degraded with a limited prune sweep. (Not observable from outside, but worth checking: a real ~/.codex has a sessions/ directory of its own, which the bridge would then read as if it were one.) ' +
        'contract-2.0 §5.1 ("Bridge participants: [hostConfigDir(), ...distinct worker dirs]") predates providers; §10.3 only says the mesh core SELECTS Claude workers',
    );
  }
  const changed = vendors.filter((w) => JSON.stringify(tree(w.configDir)) !== JSON.stringify(before[w.name])).map((w) => `${w.name}: ${tree(w.configDir).filter((f) => !before[w.name].includes(f)).join(', ')}`);
  if (changed.length > 0) {
    c.finding('X7', `the server created files inside a vendor worker's home directory while serving a Claude session worker — ${changed.join('; ')}`);
  }
  return c.done(`bridge line: ${clip(bridge.split(fx.root).join('<sandbox>'), 160)}; vendor homes ${changed.length === 0 ? 'unchanged' : 'CHANGED'}`);
}

/* ------------------------------------------------------------------------- *
 * Runner
 * ------------------------------------------------------------------------- */

const PROBES = [
  { id: 'V1', name: 'no worker, no provider → the Claude worker', timeoutMs: 420_000, run: v1 },
  { id: 'V2', name: 'only a Codex worker, no worker/provider', timeoutMs: 240_000, run: v2 },
  { id: 'V3', name: 'provider: "codex"', timeoutMs: 300_000, run: v3 },
  { id: 'V4', name: 'worker: "<cursor worker>"', timeoutMs: 300_000, run: v4 },
  { id: 'V5', name: 'provider: "gemini" / "antigravity" / "agy"', timeoutMs: 420_000, run: v5 },
  { id: 'V6', name: 'unknown provider; worker/provider mismatch', timeoutMs: 300_000, run: v6 },
  { id: 'V7', name: 'models', timeoutMs: 600_000, run: v7 },
  { id: 'V8', name: 'environment of the vendor child', timeoutMs: 420_000, run: v8 },
  { id: 'V9', name: 'permission mode', timeoutMs: 600_000, run: v9 },
  { id: 'V10', name: 'hang with timeout_minutes: 1', timeoutMs: 300_000, slow: 'the smallest dispatch timeout is one minute; one leg adds the 5 s SIGKILL grace (about 70 s, both legs at once)', run: v10 },
  { id: 'V11', name: 'notifications/cancelled during slow', timeoutMs: 240_000, run: v11 },
  { id: 'V12', name: 'quota on the first of two workers', timeoutMs: 420_000, run: v12 },
  { id: 'V13', name: 'logged-out account', timeoutMs: 420_000, run: v13 },
  { id: 'V14', name: 'error, ok-empty-text, huge', timeoutMs: 900_000, slow: 'three 12 MiB floods; a server that stops reading at its cap makes each wait out a 1-minute timeout', run: v14 },
  { id: 'V15', name: 'mesh mode ON, provider: "codex"', timeoutMs: 300_000, run: v15 },
  { id: 'V16', name: 'detach: true, provider: "codex"', timeoutMs: 300_000, needs: [RUN_TASK_JS], run: v16 },
  { id: 'V17', name: 'list_workers and orchestrator_briefing', timeoutMs: 420_000, run: v17 },
  { id: 'V18', name: 'provider-cli.js status', timeoutMs: 600_000, needs: [PROVIDER_CLI_JS], allowsFetch: true, slow: 'about thirty helper processes; one waits out the adapter\'s 10 s quota deadline', run: v18 },
  { id: 'V19', name: 'Claude-only regression', timeoutMs: 300_000, run: v19 },
  { id: 'V20', name: 'registry hygiene', timeoutMs: 420_000, run: v20 },
  { id: 'X1', name: 'extra: a helper holds the pipes after the CLI exits (§10.3 exec seam)', timeoutMs: 300_000, extra: true, run: x1 },
  { id: 'X2', name: 'extra: provider CLI not installed (§10.5)', timeoutMs: 300_000, extra: true, run: x2 },
  { id: 'X3', name: 'extra: non-string worker argument (§11 F5)', timeoutMs: 420_000, extra: true, needs: [RUN_TASK_JS], run: x3 },
  { id: 'X4', name: 'extra: parked worker under overage billing (§11 F3)', timeoutMs: 420_000, extra: true, slow: 'up to ~80 s per leg if the server ignores the CCO_TEST_* grace overrides', run: x4 },
  { id: 'X5', name: 'extra: peer line of an unmirrored worker (§11 F4)', timeoutMs: 300_000, extra: true, run: x5 },
  { id: 'X6', name: 'extra: one dispatch_tasks batch across every provider (§10.3)', timeoutMs: 300_000, extra: true, run: x6 },
  { id: 'X7', name: 'extra: the session-worker bridge and vendor home directories (not pinned)', timeoutMs: 300_000, extra: true, run: x7 },
];

/** What the sandbox looked like — gathered BEFORE cleanup removes it. */
function diagnostics(fixtures) {
  const out = [];
  for (const fx of fixtures) {
    try {
      out.push(`sandbox ${path.basename(fx.root)} — workers: ${fx.registry.workers.map((w) => `${w.name}(${w.provider ?? 'claude'})`).join(', ')}`);
      const vendor = fx.vendorLog().filter((x) => x.kind !== 'grandchild' && x.kind !== 'sigterm-ignored');
      if (vendor.length > 0) {
        out.push(`  vendor CLI invocations: ${vendor.map((x) => `${x.cli ?? x.vendor} ${x.kind}${x.scenario ? `[${x.scenario}]` : ''}${x.exitCode !== undefined ? `=${x.exitCode}` : ''}`).join(', ')}`);
      }
      for (const a of fx.anomalies()) {
        out.push(`  fake anomaly: ${a.vendor} ${a.kind} argv=${clip(JSON.stringify(a.argv), 160)}${a.what ? ` (${a.what} ${a.where})` : ''}`);
      }
      const counts = {};
      for (const r of fx.claudeLog()) {
        counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      }
      if (Object.keys(counts).length > 0) {
        out.push(`  claude invocations: ${Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(', ')}`);
      }
      const events = fx.events();
      if (events.length > 0) {
        out.push(`  task events: ${events.map((e) => `${e.status}${e.provider ? `<${e.provider}>` : ''}${e.error ? `(${clip(e.error, 80)})` : ''}`).join(' → ')}`);
      }
      const lookups = fx.loginShellLog();
      if (lookups.length > 0) {
        out.push(`  login-shell lookups: ${lookups.map((l) => clip(l, 50)).join(' | ')}`);
      }
      const net = fx.netLog();
      if (net.length > 0) {
        out.push(`  network attempts: ${net.map((x) => (x.kind === 'fetch' ? `fetch ${x.url} [${x.mode}]` : `connect ${x.host}:${x.port} [refused]`)).join(', ')}`);
      }
      fx.servers.forEach((srv, i) => {
        const tail = clip(srv.stderr.slice(-800), 500);
        out.push(`  server #${i + 1}: ${srv.exited ? `exited (code ${srv.exitInfo?.code}, signal ${srv.exitInfo?.signal})` : 'running'}${tail ? `; stderr tail: ${tail}` : '; stderr empty'}`);
      });
    } catch (e) {
      out.push(`sandbox ${path.basename(fx.root)}: diagnostics unavailable (${e.message})`);
    }
  }
  return out;
}

/**
 * What no probe may do, whatever it was testing: start a vendor CLI outside the sandbox or
 * without the harness environment, or reach for the network.
 */
function safetyViolations(probe, fixtures) {
  const out = [];
  for (const fx of fixtures) {
    for (const a of fx.anomalies()) {
      if (a.kind === 'sandbox-violation') {
        out.push(`a ${a.vendor} child was started with ${a.what} ${a.where} OUTSIDE the sandbox (the fake refused to run)`);
      } else if (a.kind === 'no-scenario') {
        out.push(`a ${a.vendor} child was started WITHOUT the harness environment (the server did not pass its environment through; the fake refused to run)`);
      }
    }
    for (const n of fx.netLog()) {
      if (n.kind === 'connect') {
        out.push(`a process tried to open a connection to ${n.host}:${n.port} (refused by the harness)`);
      } else if (n.kind === 'fetch' && !probe.allowsFetch) {
        out.push(`a process called fetch(${n.url}) in a probe whose fixtures carry no usable token (answered "${n.mode}" by the harness)`);
      }
    }
  }
  return [...new Set(out)];
}

async function runProbe(probe, { verbose }) {
  const fixtures = [];
  const t = {
    id: probe.id,
    fixture(opts = {}) {
      const fx = makeFixture({ label: probe.id, ...opts });
      fixtures.push(fx);
      return fx;
    },
  };
  const started = Date.now();
  let timer;
  let result;
  try {
    const verdict = hermeticVerdict();
    if (verdict.violations.length > 0) {
      throw new ProbeFailure(`REFUSED TO RUN — a real binary would have been resolved instead of a fake: ${verdict.violations.join('; ')}`);
    }
    const missing = (probe.needs ?? []).filter((f) => !fs.existsSync(f));
    if (missing.length > 0) {
      throw new ProbeFailure(`expected the build output ${missing.map((f) => path.relative(process.cwd(), f)).join(', ')} to exist (npm run compile); observed it missing`);
    }
    const work = probe.run(t);
    // A probe abandoned by its timeout keeps running until its sandbox is torn down under
    // it; its late rejection must not become an unhandled one.
    work.catch(() => {});
    const observed = await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure(`expected the probe to finish within ${probe.timeoutMs / 1000} s; observed no outcome in that time (a hang, or a server that never answered)`)), probe.timeoutMs);
      }),
    ]);
    const unsafe = safetyViolations(probe, fixtures);
    if (unsafe.length > 0) {
      throw new ProbeFailure(`[harness safety] expected every vendor child inside the sandbox and no network access; observed ${unsafe.join(' | ')}`);
    }
    const unsupported = fixtures.flatMap((fx) => fx.anomalies().filter((a) => a.kind === 'unsupported').map((a) => `${a.cli ?? a.vendor} ${a.argv.slice(0, 3).join(' ')}`));
    const suffix = unsupported.length > 0 ? ` (the fakes were also asked for something no adapter sends: ${[...new Set(unsupported)].join(', ')})` : '';
    result = { ok: true, line: `PASS — ${probe.id} ${probe.name}: ${observed}${suffix}`, diag: verbose ? diagnostics(fixtures) : [] };
  } catch (err) {
    const unsafe = safetyViolations(probe, fixtures);
    const message = err instanceof ProbeFailure ? err.message : `expected the probe to run to completion; observed ${err && err.message ? err.message : err}`;
    result = { ok: false, line: `FAIL — ${probe.id} ${probe.name}: ${message}${unsafe.length > 0 && !message.includes('[harness safety]') ? ` | [harness safety] ${unsafe.join(' | ')}` : ''}`, diag: diagnostics(fixtures) };
  } finally {
    clearTimeout(timer);
    for (const fx of fixtures) {
      fx.aborted = true;
    }
    for (const fx of fixtures) {
      await fx.cleanup();
    }
  }
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

function parseCli(argv) {
  const opts = { ids: [], jobs: 4, verbose: process.env.PROVIDERS_VERBOSE === '1', selftest: false, list: false, extras: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      opts.selftest = true;
    } else if (a === '--list') {
      opts.list = true;
    } else if (a === '--no-extras') {
      opts.extras = false;
    } else if (a === '--verbose' || a === '-v') {
      opts.verbose = true;
    } else if (a === '--jobs' || a === '-j') {
      opts.jobs = Math.max(1, Math.min(8, Number(argv[++i]) || 1));
    } else if (/^--jobs=\d+$/.test(a)) {
      opts.jobs = Math.max(1, Math.min(8, Number(a.split('=')[1])));
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}`);
    } else {
      opts.ids.push(a.toUpperCase());
    }
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const bail = (signal) => {
    console.log(`\n${signal} — cleaning up sandboxes and fake processes…`);
    cleanupAll().finally(() => process.exit(130));
  };
  process.on('SIGINT', () => bail('SIGINT'));
  process.on('SIGTERM', () => bail('SIGTERM'));

  if (opts.selftest) {
    const { fail } = await runSelfTest({ only: opts.ids });
    process.exit(fail > 0 ? 1 : 0);
  }
  if (opts.list) {
    for (const p of PROBES) {
      console.log(`${p.id.padEnd(4)} ${p.name}${p.slow ? `  [slow: ${p.slow}]` : ''}`);
    }
    return;
  }
  const unknown = opts.ids.filter((id) => !PROBES.some((p) => p.id === id));
  if (unknown.length > 0) {
    console.error(`Unknown probe id(s): ${unknown.join(', ')}. Known: ${PROBES.map((p) => p.id).join(' ')}.`);
    process.exit(2);
  }
  try {
    assertBuilt([SERVER_JS]);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const selected = opts.ids.length > 0 ? PROBES.filter((p) => opts.ids.includes(p.id)) : PROBES.filter((p) => opts.extras || !p.extra);
  console.log(`providers probes — ${selected.length} probe(s) against ${SERVER_JS}, ${opts.jobs} at a time`);
  const verdict = hermeticVerdict();
  console.log(
    verdict.violations.length === 0
      ? 'hermetic: with no fake installed, nothing named codex / cursor-agent / agy / claude resolves in a sandbox environment; the network guard is preloaded into every process'
      : `NOT HERMETIC — every probe will refuse to run: ${verdict.violations.join('; ')}`,
  );
  if (KEEP_SANDBOXES) {
    console.log('PROVIDERS_KEEP=1 — sandboxes are left on disk under the system temp directory');
  }

  const results = new Map();
  const queue = [...selected];
  const worker = async () => {
    for (;;) {
      const probe = queue.shift();
      if (!probe) {
        return;
      }
      const res = await runProbe(probe, opts);
      results.set(probe.id, res);
      console.log(`${res.line}  [${res.seconds} s]`);
      for (const line of res.diag) {
        console.log(`       ${line}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, selected.length) }, worker));

  const failed = selected.filter((p) => !results.get(p.id)?.ok).map((p) => p.id);
  const tally = (label, group) => {
    if (group.length === 0) {
      return;
    }
    const bad = group.filter((p) => failed.includes(p.id)).map((p) => p.id);
    console.log(`${label}: ${group.length - bad.length} passed, ${bad.length} failed${bad.length > 0 ? ` (${bad.join(', ')})` : ''}`);
  };
  const { lateKilled, remaining: strays } = await settleStrays();
  const leftovers = leftoverSandboxes();
  console.log('');
  if (strays.length > 0 || leftovers.length > 0) {
    console.log(`CLEANUP PROBLEM — ${strays.length} process(es) still running ${JSON.stringify(strays)}; ${leftovers.length} sandbox(es) left ${JSON.stringify(leftovers)}`);
  } else {
    console.log(`cleanup: no process left running, no sandbox left on disk${lateKilled > 0 ? ` (${lateKilled} late process(es) were killed in the final sweep)` : ''}`);
  }
  if (FINDINGS.length > 0) {
    console.log('findings — seen by a probe, pinned by no contract clause, no effect on the tally:');
    for (const f of FINDINGS) {
      console.log(`  - ${f}`);
    }
  }
  tally('tally (probe table, V1–V20)', selected.filter((p) => !p.extra));
  tally('extras (outside the table)', selected.filter((p) => p.extra));
  process.exit(failed.length > 0 || strays.length > 0 || leftovers.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`probe: fatal — ${err && err.stack ? err.stack : err}`);
  await cleanupAll();
  process.exit(2);
});
