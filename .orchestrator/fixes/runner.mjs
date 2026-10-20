#!/usr/bin/env node
// runner.mjs — offline checks of the dispatch runners (src/mcp/task-runner.ts,
// src/mcp/provider-runner.ts, src/mcp/dispatch-gate.ts): the quota classifier, the dispatch
// gate, checked arguments, output caps, and the records a dispatch writes about itself.
//
//   node .orchestrator/fixes/runner.mjs                     every section, on the CURRENT sources
//   node .orchestrator/fixes/runner.mjs --only quota,gate   some sections
//   node .orchestrator/fixes/runner.mjs --sources <dir>     the current tree with every .ts file of <dir>
//                                                           laid over the src/mcp (or src) file of
//                                                           that name — how a fix is shown to fail
//                                                           WITHOUT it (<dir> holds the old files)
//   node .orchestrator/fixes/runner.mjs --keep              leave the scratch directory behind
//
// Sections: quota · streams · gate · core · e2e · vendor. Exit 0 only when every check passed; each check
// prints `PASS <name>` or `FAIL <name> — <why>`, and the last line is the tally.
//
// WHAT RUNS. The sources are bundled with esbuild into a scratch directory (never `out/`), and
// everything is driven from there:
//   quota, streams, gate   the functions themselves, in this process
//   core          the dispatch core inside a child process (runner-core.cjs) — for what a server
//                 never shows (what a cancelled dispatch fails with) and for module state
//   e2e, vendor   a real server process over stdio, in the providers harness's sandbox, with
//                 runner-fake-claude.mjs as `claude` and the harness's fake vendor CLIs
//
// ISOLATION. HOME and USERPROFILE are pointed at a scratch directory before anything that
// touches state is loaded, every child is given its own scratch HOME and an environment built
// here (never the caller's), and no real agent CLI can be resolved: the only `claude` is the
// fake, by absolute path, and the one "missing binary" case uses a name that exists nowhere.
//
// LOAD. At most a server and three workers are alive at a time on the current sources (seven
// workers on a build without the gate); a section waits while the 1-minute load average is
// above 30.

import keychainGuard from './keychain-guard.cjs';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('fix-runner', { selfCheck: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FAKE_SRC = path.join(HERE, 'runner-fake-claude.mjs');
const CORE_DRIVER = path.join(HERE, 'runner-core.cjs');

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const SOURCES = opt('--sources') ? path.resolve(opt('--sources')) : undefined;
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : undefined;
const KEEP = argv.includes('--keep');

/* ------------------------------------------------------------------------- *
 * Scratch space and isolation — before anything else is loaded
 * ------------------------------------------------------------------------- */

const REAL_HOME = os.userInfo().homedir;
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cco-fixes-runner-')));
const MAIN_HOME = path.join(BASE, 'home-main');
fs.mkdirSync(MAIN_HOME, { recursive: true });
process.env.HOME = MAIN_HOME;
process.env.USERPROFILE = MAIN_HOME;
// Where the providers harness (loaded later) builds its sandboxes, and which build it starts.
process.env.PROVIDERS_TMPDIR = BASE;
process.env.PROVIDERS_OUT_DIR = path.join(BASE, 'out', 'mcp');
delete process.env.PROVIDERS_KEEP;

const FAKE = path.join(BASE, 'fake', 'claude-fake.mjs');
fs.mkdirSync(path.dirname(FAKE), { recursive: true });
fs.copyFileSync(FAKE_SRC, FAKE);
fs.chmodSync(FAKE, 0o755);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
function clip(value, max = 300) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…[${flat.length} chars]` : flat;
}
function check(name, ok, why = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} — ${clip(why === '' ? 'the condition did not hold' : why)}`);
  }
  return ok;
}

async function calm() {
  const deadline = Date.now() + 10 * 60_000;
  while (os.loadavg()[0] > 30 && Date.now() < deadline) {
    console.log(`  (load average ${os.loadavg()[0].toFixed(1)} — waiting)`);
    await sleep(5000);
  }
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line
    }
  }
  return rows;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 40, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out (${timeoutMs} ms) waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------------- *
 * Build
 * ------------------------------------------------------------------------- */

const OUT = path.join(BASE, 'out');
const SERVER_JS = path.join(OUT, 'mcp', 'server.js');
const CORE_CJS = path.join(OUT, 'core.cjs');

/** Where the sources being tested are: the tree itself, or a staged copy with files laid over it. */
let SRC;
let esbuildOptions;

/**
 * The core bundle, which every section needs. The server bundles are built separately and only
 * for the sections that start a server (buildServer): they pull in every module the server
 * imports, and one of those mid-edit by somebody else must not stop the checks that never load it.
 */
async function build() {
  const require = createRequire(path.join(REPO, 'package.json'));
  const esbuild = require('esbuild');
  let src = path.join(REPO, 'src');
  if (SOURCES !== undefined) {
    // The whole current tree, with every `.ts` file of <dir> laid over the file of the same
    // name — under src/mcp when there is one there, else directly under src.
    src = path.join(BASE, 'staged-src');
    fs.cpSync(path.join(REPO, 'src'), src, { recursive: true });
    for (const name of fs.readdirSync(SOURCES).filter((f) => f.endsWith('.ts')).sort()) {
      const target = [path.join(src, 'mcp', name), path.join(src, name)].find((f) => fs.existsSync(f));
      if (target === undefined) {
        throw new Error(`--sources: ${name} is not a file of src/mcp or src`);
      }
      fs.copyFileSync(path.join(SOURCES, name), target);
      console.log(`  using ${path.join(SOURCES, name)} as ${path.relative(src, target)}`);
    }
  }
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    logLevel: 'error',
    // A staged tree has no node_modules above it.
    nodePaths: [path.join(REPO, 'node_modules')],
  };
  SRC = src;
  esbuildOptions = { esbuild, common };
  // The core as ONE module, so the gate a test reads is the gate the core took its slot from.
  fs.mkdirSync(OUT, { recursive: true });
  const entry = path.join(OUT, 'core-entry.ts');
  const from = (rel) => JSON.stringify(path.join(src, rel));
  fs.writeFileSync(
    entry,
    [
      `export * from ${from('mcp/task-runner')};`,
      `export { acquireDispatchSlot, dispatchGateStats } from ${from('mcp/dispatch-gate')};`,
      `export { checkDispatchArgs } from ${from('mcp/dispatch-args')};`,
      `export { readRegistry, readStats, updateStats } from ${from('registry')};`,
      `export { recordProviderStatus } from ${from('usage')};`,
      // As a namespace: a build of older sources may not export everything a check asks for,
      // and that must be a failed check, not a failed build.
      `export * as providerRunner from ${from('mcp/provider-runner')};`,
      '',
    ].join('\n'),
  );
  await esbuild.build({ ...common, entryPoints: [entry], format: 'cjs', outfile: CORE_CJS });
}

let serverBuilt = false;
/** The server, its detach supervisor and the provider helper, beside each other as shipped. */
async function buildServer() {
  if (serverBuilt) return;
  const { esbuild, common } = esbuildOptions;
  for (const entry of ['server', 'run-task', 'provider-cli']) {
    await esbuild.build({ ...common, entryPoints: [path.join(SRC, 'mcp', `${entry}.ts`)], outfile: path.join(OUT, 'mcp', `${entry}.js`) });
  }
  serverBuilt = true;
}

/* ------------------------------------------------------------------------- *
 * Section: quota — the classifier, as a function
 * ------------------------------------------------------------------------- */

// The two tables of the fix contract (§3.1), verbatim. In its text a stack trace's lines are
// joined by `\n`; here those are real line breaks, which is what a CLI prints.
const CONTRACT_MUST = [
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  'Claude AI usage limit reached|1760000000',
  "You've hit your limit · resets 3am (Asia/Seoul)",
  '5-hour limit reached ∙ resets 3pm',
  'exceeded retry limit, last status: 429 Too Many Requests',
  'Request failed with status code 429',
  'You exceeded your current quota, please check your plan and billing details.',
  "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'",
  'HTTP 529',
];
const CONTRACT_MUST_NOT = [
  'TypeError: x is not a function\n    at renderTurn (/opt/x/cli.js:429:17)\n    at async main (/opt/x/cli.js:529:3)',
  'ReferenceError: y is not defined\n    at checkQuota (/opt/x/quota.js:10:2)',
  'request failed (cf-ray: 9a1429f0c8d2e529-ICN)',
  'The requested model is not available for this account',
  'Worker exited with code 1: wrote 5290 bytes to 429 files',
  "error: unknown option '--foo'",
  "ENOENT: no such file or directory, open '/tmp/429/529.json'",
];
// This harness's own cases. [text, what it is]
const MORE_MUST = [
  ['API Error: 529 status code (no body)', 'the status with no body, as the Claude CLI prints it'],
  ['HTTP/1.1 429', 'a status line'],
  ['got HTTP/2 529', 'a status line, HTTP/2'],
  ['status=429', 'key=value'],
  ['Unknown Error (529)', 'the number in brackets after "error"'],
  ['{\n  "error": {\n    "code": 429,\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}', 'a JSON error body pretty-printed over several lines'],
  ["{'status': 529, 'body': ''}", 'a Python dict repr'],
  ['curl: (22) The requested URL returned error: 429', "curl's own sentence"],
  ['unexpected status 529 Service Unavailable, url: https://x/y, cf-ray: 9a1429f0c8d2e529-ICN', 'a status beside a request id'],
  ['upstream returned 529', '"returned"'],
  ['the server responded with 429', '"with"'],
  ['statusCode: 429', 'camelCase key'],
  ['http_status=529', 'snake_case key'],
  ['HTTPError: 529', 'an HTTP error class'],
  ['Error 529: upstream failure', 'a status followed by a colon and text'],
  ['error: 429 from api.example.com', 'a status followed by "from"'],
  ['API Error: 529\n    at request (/opt/x/cli.js:10:2)', 'a real status above a stack trace'],
  ['{"error":{"type":"insufficient_quota"}}', 'an error code that contains the word'],
  ['rateLimitExceeded', 'the word in camelCase'],
  ["You've hit your weekly Opus limit", 'a plan window with two words before "limit"'],
  ['You have hit your 5-hour limit', 'a plan window with one word before "limit"'],
];
const MORE_MUST_NOT = [
  ['TypeError: x is not a function\\n    at renderTurn (/opt/x/cli.js:429:17)\\n    at async main (/opt/x/cli.js:529:3)', 'the contract trace with its line breaks ESCAPED (one line)'],
  ['{"level":"error","stack":"ReferenceError: y is not defined\\n    at checkQuota (/opt/x/quota.js:10:2)\\n    at main (/opt/x/cli.js:529:3)"}', 'a JSON log line quoting a stack trace'],
  ["Error: Cannot find module 'C:\\x\\429\\y.js'\n    at load (C:\\x\\429\\y.js:10:2)", 'a Windows path with 429 in it'],
  ['request 7f3a429b-529c-4f1e-9a14-29f0c8d2e529 failed: connection reset', 'a UUID containing the digits'],
  ['error: 429 bytes exceeds the buffer', 'a byte count after "error:"'],
  ["src/file.ts(429,17): error TS2304: Cannot find name 'x'.", 'a compiler diagnostic position'],
  ['error(429,17): unexpected token', 'a position in brackets after "error"'],
  ['[12:04:29] worker crashed', 'a clock time'],
  ['2026-10-13T04:29:00.529Z error: connection reset', 'an ISO timestamp'],
  ['connect ECONNREFUSED 127.0.0.1:4290', 'a port'],
  ['fetch http://localhost:429/health failed', 'a port after a URL scheme'],
  ['KeyError: 429', 'a Python missing-key error'],
  ['error: 429 files could not be formatted', 'a count after "error:"'],
  ['Build failed with 529 errors and 12 warnings', 'a count after "with"'],
  ['query returned 429 rows, expected 1', 'a count after "returned"'],
  ['exit status 1; processed 429 of 600 records', 'a count with no status word before it'],
  ["TS2345: Argument of type '429' is not assignable to parameter of type 'string'", 'a quoted literal'],
  ['line 429: unexpected token', 'a line number'],
  ['panic: runtime error\n\t/src/app/worker.go:429 +0x1d', 'a Go frame'],
  ['npm ERR! code E429', 'a code with a letter in front'],
  ['Error: 429 is not a function', 'a value in a sentence'],
  ['duration_ms: 4290, session 9d2f4290', 'longer numbers'],
  ['see /var/www/error/429.html and error_529.png', 'file names'],
  ['status 429.5 is not an integer', 'a decimal'],
  ['error: 429,000 tokens requested', 'a grouped figure'],
  ['TypeError: 529\n    at Object.<anonymous> (/x/y.js:1:1)', 'another error class with a bare number'],
  ['error: 529% of the buffer', 'a percentage'],
  ['started with 429 MB of heap', 'a size'],
  ['"error_count": 429', 'a JSON count'],
  ['Service Unavailable (529)', 'the number in brackets after a reason phrase that is not a status word (decided: not classified)'],
  ['529 status code (no body)', 'the number BEFORE "status code", with nothing introducing it (decided: not classified)'],
];

// The cases the ruling on the WORD step added, verbatim: a limit that is not an account's
// allowance, and the names of files and places.
const RULED_MUST = [
  'Opus weekly limit reached ∙ resets Oct 20',
  'Limit reached · resets 3pm',
  'Spending limit reached',
  'daily request limit exceeded',
  "You've hit your session limit · resets 2pm",
  'exceeded retry limit, last status: 429 Too Many Requests',
  'https://api.x/v1/messages returned 429',
];
const RULED_MUST_NOT = [
  'context limit exceeded',
  'retry limit exceeded',
  'output token limit exceeded',
  'maximum turn limit reached',
  "thread 'main' panicked at src/quota.rs:10:5:\nindex out of bounds",
  'Traceback (most recent call last):\n  File "/opt/x/quota.py", line 10, in check\nKeyError: \'plan\'',
  'goroutine 1 [running]:\nmain.run()\n\t/src/ratelimit/limiter.go:42 +0x1d',
  'see https://docs.example.com/rate-limits for details',
  "ENOENT: no such file or directory, open '/home/u/quota/usage limit.json'",
];
// This harness's own cases for the same two rules. [text, what it is]
const WORDS_MUST = [
  ['Weekly limit reached', 'a plan window, bare'],
  ['Session limit reached ∙ resets 9pm', 'a plan window with its reset'],
  ['monthly spending limit exceeded', 'a spending cap'],
  ['tokens per minute limit exceeded', 'a rate named in tokens — "minute" and "per" stand before the limit'],
  ['API call limit reached', 'a limit on calls (decided: an allowance)'],
  ['concurrency limit reached', 'a limit on concurrency (decided: an allowance)'],
  ["You've hit your token rate limit", 'a refused "hit your … limit" that holds a rate limit'],
  ['retry limit exceeded. Rate limit exceeded for requests', 'a refused limit followed by a real one'],
  ['The context was reset. Limit reached · resets 3pm', 'a bare limit after a sentence that ends in other words'],
  ['{"error":"rate_limit_exceeded","url":"https://api.x/v1"}', 'a JSON body with no spaces and a URL in it'],
  ['"body":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"overloaded_error\\",\\"message\\":\\"Overloaded\\"}}"', 'a JSON body quoted inside another (words)'],
  ['"body":"{\\"error\\":{\\"code\\": 429,\\"status\\":\\"RESOURCE_EXHAUSTED\\"}}"', 'a JSON body quoted inside another (status)'],
  ['POST https://api.anthropic.com/v1/messages failed: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'the words beside a URL'],
  ['Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000. Visit https://platform.openai.com/account/rate-limits to learn more.', "a vendor's rate-limit sentence with a URL"],
  ['You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.', "a vendor's quota sentence with a URL"],
  ['Caused by: com.acme.QuotaExceededException: quota exceeded for project p1\n\tat com.acme.Api.call(Api.java:42)', 'a Java message line above its frames'],
  ['Traceback (most recent call last):\n  File "/opt/x/client.py", line 10, in call\n    return self._request(x)\nanthropic.RateLimitError: Error code: 429 - {\'type\': \'error\'}', 'the last line of a Python traceback'],
  // An allowance word beside a non-allowance one wins.
  ['monthly token limit reached', 'an allowance word beside a non-allowance: monthly'],
  ['input tokens daily limit reached', 'an allowance word directly before the limit: daily'],
  ['daily output token limit exceeded', 'an allowance word three words before the limit'],
  ['5-hour token limit reached', 'a period beside a non-allowance'],
  ['per minute output token limit exceeded', 'a period three words before the limit'],
  ["Your organization's monthly token limit exceeded", 'whose it is, and how often it renews'],
  ['tokens: daily limit reached', 'the allowance word after a label'],
  ['daily time limit reached', '"daily" beside "time" (decided: an allowance — it renews)'],
  ['session token limit reached', '"session" beside "token" (decided by the ruled list: an allowance)'],
  ['organization token limit exceeded', '"organization" beside "token" (decided by the ruled list: an allowance)'],
  ["You have reached your plan's context limit", '"plan" beside "context" (decided by the ruled list: an allowance)'],
  ['requests per day token limit exceeded', 'a period ("day") within three words'],
  // The verb before "your … limit".
  ["You've reached your monthly request limit", '"reached your … limit"'],
  ['You have exceeded your usage limit', '"exceeded your … limit"'],
  ["You've reached your limit", '"reached your limit", bare'],
  ['You have reached your storage limit', '"reached your storage limit" (decided: an allowance of the account)'],
  // Words joined by a slash are alternatives, not a path.
  ['You have exceeded your quota/rate limit.', 'two words of the vocabulary joined by a slash'],
  ['usage/billing limit reached', 'alternatives directly before the limit'],
  ['daily/weekly limit reached', 'alternatives that are both allowance words'],
  // A quoted run with white space in it is a sentence, not an identifier.
  ["{'error': {'message': 'Rate limit reached for gpt-5 in organization org-x', 'code': 'rate_limit_exceeded'}}", 'an error body printed as a Python dict — by its message'],
  ["the 'usage limit' was hit", 'a quoted phrase of two words'],
  // Regression rows.
  ['upstream connect error: 529', 'a status after "error:"'],
  ['HTTP/2 429', 'a status line, HTTP/2'],
  ['Weekly limit reached ∙ resets Mon 9am', 'a plan window with its reset day'],
  ['stream error: unexpected status 429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}', "a vendor's stream error with its body"],
];
const WORDS_MUST_NOT = [
  ['exceeded retry limit, last status: 503 Service Unavailable', '"retry limit" with a status that is not a quota one'],
  ['context window limit exceeded', 'a non-allowance two words before the limit'],
  ['tool call limit reached', 'a tool-call budget'],
  ['time limit exceeded', 'a time limit'],
  ['file size limit exceeded', 'a size limit'],
  ['recursion depth limit reached', 'a depth limit'],
  ['memory limit exceeded', 'a memory limit'],
  ['open files limit reached', 'a plural of a non-allowance'],
  ['Maximum iterations limit reached', 'an iteration budget'],
  ['maxTurnsLimit exceeded', 'a non-allowance in camelCase'],
  ['max_tokens limit reached', 'a non-allowance in snake_case'],
  ['You have hit your context limit', '"hit your … limit" naming a non-allowance'],
  ["You've hit your token limit", '"hit your token limit" — nothing names an allowance'],
  ['java.lang.IllegalStateException: boom\n\tat com.acme.quota.QuotaService.check(QuotaService.java:42)\n\tat java.base/java.lang.Thread.run(Thread.java:833)', 'Java frames'],
  ['{"level":"error","stack":"java.lang.RuntimeException: boom\\n\\tat com.acme.quota.Quota.check(Quota.java:1)\\n\\tat com.acme.Main.main(Main.java:2)"}', 'Java frames quoted in a JSON log line'],
  ['System.InvalidOperationException: boom\n   at Acme.Quota.RateLimiter.Check(String s) in C:\\src\\Quota\\RateLimiter.cs:line 42', 'a .NET frame'],
  ["thread 'main' panicked at 'boom', src/main.rs:3:5\nstack backtrace:\n   3: codex::quota::check\n             at ./src/quota.rs:10:5\n   4: codex::main", 'a Rust backtrace'],
  ['panic: runtime error: index out of range [5] with length 3\n\ngoroutine 1 [running]:\nmain.checkQuota(0xc000010000)\n\t/src/app/quota.go:17 +0x45\nmain.main()\n\t/src/app/main.go:9 +0x1d\nexit status 2', 'a Go dump with its function lines'],
  ['Traceback (most recent call last):\n  File "/opt/x/app.py", line 10, in main\n    check_rate_limit(quota)\n    ~~~~~~~~~~~~~~~~^^^^^^^\nTypeError: boom', 'a Python frame with its source line and carets'],
  ["quota.c:10:5: error: expected ';' before '}' token", 'a compiler diagnostic on a file named quota'],
  ["Error: Cannot find module './quota'", 'a module specifier'],
  ['error in quota.py line 3: unexpected indent', 'a bare file name'],
  ['failed to read ratelimit.go: permission denied', 'another bare file name'],
  ['cat quota.json | jq . failed', 'a data file'],
  ['C:\\Users\\u\\rate-limit\\app.exe exited with code 3', 'a Windows path'],
  // Nothing names an allowance, so the non-allowance word stands.
  ['context window limit reached', 'a context window'],
  ['reached your context limit', '"reached your … limit" naming a non-allowance'],
  ['You have exceeded your context window limit', '"exceeded your … limit" naming a non-allowance'],
  ['Session ab12: context limit exceeded', 'an allowance word that is only a LABEL before a colon'],
  ['account 12: token limit exceeded', 'another label before a colon'],
  ['Request too large: context limit exceeded', 'a sentence before a colon'],
  ['2 hour time limit exceeded', 'a period beside "time" is a duration'],
  ['30 minute timeout limit reached', 'a period beside "timeout" is a duration'],
  ['per-request token limit exceeded', '"per request" is a scope, not a count (decided: not classified)'],
  // Slashes: alternatives of non-allowance words stay visible; two-word paths are still paths.
  ['time/memory limit exceeded', 'alternatives that are both non-allowance words'],
  ['context/token limit exceeded', 'alternatives that are both non-allowance words, directly before the limit'],
  ['input/output token limit exceeded', 'alternatives before a non-allowance word'],
  ['see docs/quota for details', 'a two-word path whose first word is not vocabulary'],
  ['Cannot find module src/quota', 'another two-word path'],
  ['internal/quota: no such file or directory', 'a two-word path of dictionary words'],
  ['error in services/ratelimit', 'a two-word path, the keyword second'],
  ['retry and/or wait', '"and/or" by itself'],
  // An identifier a tool quotes.
  ["error TS2304: Cannot find name 'quotaExceeded'.\n  src/usage.ts(429,17)", 'a compiler quoting an identifier'],
  ["git: 'ratelimit' is not a git command. See 'git --help'.", 'a tool quoting a command name'],
  ['unknown option `--rate-limit`', 'a flag in backticks'],
  ['ReferenceError: `checkQuota` is not defined', 'a function name in backticks'],
  ["{'code': 'rate_limit_exceeded'}", 'a Python-dict body with ONLY a quoted code and no status (a known miss)'],
  // Regression rows.
  ['Error: listen EADDRINUSE: address already in use :::4290', 'a port after colons'],
  ['npm ERR! 429 packages are looking for funding', 'a count after "ERR!"'],
  ['AssertionError [ERR_ASSERTION]: expected 529 to equal 200', 'a value in an assertion'],
  ['SyntaxError: Unexpected token } in JSON at position 429', 'a position'],
  ['Process exited with signal SIGKILL after 429ms', 'a duration'],
  ['input length and `max_tokens` exceed context limit: 180000 + 32000 > 200000', "the API's own context-length sentence"],
  ['Could not lock ledger: process 429 (node) has held its lock for more than 15s.', 'a pid'],
];

// A second battery, copied row for row: the wordings vendors' CLIs and APIs are known to print,
// and the noise beside them. [name, text]
const BATTERY_MUST = [
  ['claude-usage-limit-pipe', 'Claude AI usage limit reached|1760000000'],
  ['claude-hit-limit', "You've hit your limit · resets 3am (Asia/Seoul)"],
  ['claude-5h', '5-hour limit reached ∙ resets 3pm'],
  ['claude-weekly', 'Weekly limit reached ∙ resets Mon 9am'],
  ['claude-api-429', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}'],
  ['claude-api-529', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  ['claude-out-of-extra-usage', "You're out of extra usage · resets 3pm (America/Los_Angeles)"],
  ['claude-is-error-subtype', 'Worker error (rate_limit_error): Rate limit exceeded — usage limit reached (429).'],
  ['claude-opus-limit', 'Opus limit reached · resets 6pm'],
  ['claude-limit-reached-plain', 'Limit reached · resets 3pm'],
  ['claude-max-weekly', "You've reached your weekly limit for Claude. Your limit will reset Oct 20 at 9am."],
  ['claude-session-limit', 'Session limit reached ∙ resets 3pm'],
  ['claude-token-limit-monthly', 'monthly token limit reached'],
  ['claude-exceeded-usage', 'You have exceeded your usage limit for this period.'],
  ['claude-rate-limit-error-code', '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'],
  ['claude-overloaded-plain', 'overloaded_error: Overloaded'],
  ['claude-too-many', 'HTTP 429 Too Many Requests'],
  ['claude-status-code', 'Request failed with status code 429'],
  ['claude-retry-status', 'exceeded retry limit, last status: 429 Too Many Requests'],
  ['openai-quota', 'You exceeded your current quota, please check your plan and billing details.'],
  ['openai-insufficient', 'Error: insufficient_quota: You exceeded your current quota'],
  ['openai-rate-limit-reached', 'Rate limit reached for gpt-5 in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000'],
  ['openai-429-json', '{"error":{"message":"Rate limit reached","type":"tokens","code":"rate_limit_exceeded"}}'],
  ['codex-usage-limit', "You've hit your usage limit. Try again at 5:00 PM."],
  ['codex-plan-limit', 'Codex usage limit reached for your plan. Resets in 2h 14m.'],
  ['google-resource-exhausted', "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'"],
  ['google-429-status', 'Error: [429 Too Many Requests] Resource has been exhausted (e.g. check quota).'],
  ['google-exhausted-only', 'Resource has been exhausted (e.g. check quota).'],
  ['http2-429', 'HTTP/2 429'],
  ['http-529', 'HTTP 529'],
  ['upstream-529', 'upstream connect error: 529'],
  ['status-equals', 'status=429'],
  ['statusCode-camel', 'statusCode: 429'],
  ['daily-limit', 'Daily limit reached. Try again tomorrow.'],
  ['credit-limit', 'Your credit limit has been reached'],
  ['spend-limit', 'Spending limit reached for this organization'],
  ['request-limit', 'request limit exceeded'],
  ['hit-5h-limit', 'You hit your 5-hour limit'],
  ['ratelimit-joined', 'RateLimitError: ratelimited'],
  ['rate-limited-past', 'You are being rate limited. Please slow down.'],
  ['throttled', 'Request throttled: too many requests'],
  ['capacity', 'Model is currently overloaded. Please try again later.'],
];
const BATTERY_MUST_NOT = [
  ['js-stack-429', 'TypeError: x is not a function\n    at renderTurn (/opt/x/cli.js:429:17)\n    at async main (/opt/x/cli.js:529:3)'],
  ['ref-error', 'ReferenceError: y is not defined\n    at checkQuota (/opt/x/quota.js:10:2)'],
  ['cf-ray', 'request failed (cf-ray: 9a1429f0c8d2e529-ICN)'],
  ['model-unavailable', 'The requested model is not available for this account'],
  ['exit-counts', 'Worker exited with code 1: wrote 5290 bytes to 429 files'],
  ['unknown-option', "error: unknown option '--foo'"],
  ['enoent-path', "ENOENT: no such file or directory, open '/tmp/429/529.json'"],
  ['context-limit', 'context limit exceeded'],
  ['retry-limit', 'retry limit exceeded'],
  ['output-token-limit', 'output token limit exceeded'],
  ['max-turns', 'Reached max turns (25)'],
  ['prompt-too-long', 'Prompt is too long'],
  ['port-4290', 'address already in use :::4290'],
  ['funding', '429 packages are looking for funding'],
  ['chai', 'expected 529 to equal 200'],
  ['position', 'Unexpected token } in JSON at position 429'],
  ['after-ms', 'request completed after 429ms'],
  ['ts-ident', "error TS2304: Cannot find name 'quotaExceeded'."],
  ['git-ident', "git: 'ratelimit' is not a git command."],
  ['docs-path', 'modified: docs/quota.md'],
  ['lock-pid', 'Could not lock /x/registry.json: held by pid 429 for 15 s'],
  // A worker's own prose about a limit it imposed on itself.
  ['worker-prose-limit', 'I limited the scan to 200 files (file limit reached) and stopped.'],
  ['worker-prose-tool', 'tool call limit reached for this turn; summarizing.'],
  // PROSE, which does not reach the classified channel: only a CLI's own failure text is read
  // for quota, never what a worker wrote. Not classified all the same — the rate directly after
  // "sampling" is a property of a signal, not of requests (NOT_A_REQUEST_RATE).
  ['worker-prose-rate', 'The sampling rate limits the resolution of the chart.'],
  ['auth-401', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
  ['billing-disabled', 'This organization has been disabled.'],
  ['credit-low', 'Your credit balance is too low to access the Anthropic API.'],
  ['exit-code-1', "Worker exited with code 1: Error: Cannot find module '/opt/x/node_modules/quota-utils/index.js'"],
  ['timeout-msg', 'Worker timed out after 2 minutes and was terminated. Captured before the kill: 429 chars of stdout, 529 chars of stderr.'],
  ['git-rev', "fatal: ambiguous argument 'HEAD~429': unknown revision"],
  ['line-col', 'src/app.ts(429,5): error TS2322'],
  ['http-200', 'HTTP/1.1 200 OK (429 bytes)'],
  ['version', 'version 4.2.9 (build 529)'],
  ['limit-order', 'ORDER BY ts LIMIT 429'],
  ['quota-field-name', 'Unknown field "quota" in settings.json'],
  // PROSE of the same kind: a test runner's report line, quoted. Not classified all the same —
  // a line of the shape `test <name> ... ok` is a test's NAME and is not read (TEST_REPORT_LINE).
  ['test-name', 'test quota handling › returns 429 when limited ... ok'],
];
// This harness's own cases for the phrasings and the double-quote rule. [text, what it is]
const PHRASE_MUST = [
  ['You are out of usage for this billing period.', '"out of usage", without "extra"'],
  ['Limit has been reached · resets 3pm', '"limit has been reached", bare'],
  ['Your monthly limit has been exceeded.', '"limit has been exceeded" named by an allowance word'],
  ['The daily token limit has been exceeded', '"has been", with an allowance word beside a non-allowance one'],
  ['{"error":{"code":"rate_limit_exceeded"}}', 'a code that is a JSON VALUE'],
  ['{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', 'a code that is a JSON value, with a message that says nothing'],
  ['{\n  "error": {\n    "code": "rate_limit_exceeded"\n  }\n}', 'the same body pretty-printed'],
  [`{\n${' '.repeat(20)}"error": {\n${' '.repeat(40)}"code": "rate_limit_exceeded"\n${' '.repeat(20)}}\n}`, 'pretty-printed with a deep indentation'],
  ['"body":"{\\"error\\":{\\"code\\":\\"rate_limit_exceeded\\"}}"', 'a body quoted inside another'],
  ['{"error":{"code":"rate_limit_exceeded"', 'a body cut short directly after the code'],
  ['{"quota":{"limit":100,"used":100}}', 'the word as a JSON KEY'],
  ['{"errors":["rate_limit_exceeded"]}', 'a bare code in an array, inside a body'],
  ['stream error: {"type":"overloaded_error"}', 'a body after a label'],
  ['error: "Rate limit reached for requests"', 'a double-quoted SENTENCE outside any body'],
  ['✗ Rate limit reached', "a CLI's own error behind a cross — not a test report"],
  ["× You've hit your usage limit", 'the same, with another cross'],
  ['Token refresh rate limit exceeded', 'a rate of requests named by what is requested'],
];
const PHRASE_MUST_NOT = [
  ['Unrecognized key "rateLimit" in config', 'a tool quoting a key in double quotes'],
  ['unknown option "--rate-limit"', 'a flag in double quotes'],
  ['Cannot find name "quotaExceeded".', 'an identifier in double quotes'],
  ['error: "quota": not allowed here', 'a quoted name between colons, outside any braces'],
  ['[error] config: "quota": unknown key', 'the same after a bracketed log level'],
  ['expected "overloaded" to equal "ok"', 'two quoted values of an assertion'],
  ['expected ["quota"] to equal []', 'a quoted value in brackets, outside any braces'],
  ['{ note: "quota" is not a field }', 'inside braces after a colon, but followed by a word'],
  ['The context limit has been reached', '"has been", naming a non-allowance'],
  ['The maximum token limit has been exceeded', '"has been", naming another'],
  ['retry limit has been reached', '"has been", naming a retry budget'],
  ['time limit has been exceeded', '"has been", naming a time limit'],
  ['ok 12 - quota: returns 429 when rate limited', "a TAP report line"],
  ['not ok 3 rate limit backoff', 'a failing TAP line'],
  ['--- FAIL: TestRateLimit (0.00s)', "a Go test's report line"],
  ['=== RUN   TestQuotaExceeded', "a Go test's start line"],
  ['frame rate limit exceeded', 'a rate that is not one of requests, as a "limit exceeded"'],
  ['bit rate limits were applied to the stream', 'another such rate'],
  // Known misses, pinned so that a change to them is a decision: each is a code in a position
  // the rule does not read as a body, in a text that says the refusal nowhere else.
  ['code="rate_limit_exceeded"', 'a key=value log field (a known miss)'],
  ['{"message":"bad } here","code":"rate_limit_exceeded"}', 'a code after a message with a closing brace in it (a known miss)'],
  ['ERROR: {"detail":{"code":"usage_limit_reached"}}', 'the code `usage_limit_reached` with no message and no status (a known miss: "usage limit" is read with a space)'],
];
// A known OVER-read, pinned for the same reason. It is prose, which does not reach the
// classified channel; "out of usage" is read wherever it stands.
const PHRASE_KNOWN_OVER_READ = [['The word fell out of usage long ago.', 'the idiom "fall out of usage"']];

function sectionQuota(core) {
  const isQuotaError = core.isQuotaError;
  for (const text of CONTRACT_MUST) {
    check(`quota/contract must: ${clip(text, 70)}`, isQuotaError(text) === true, 'not classified as a quota failure');
  }
  for (const text of CONTRACT_MUST_NOT) {
    check(`quota/contract must-not: ${clip(text, 70)}`, isQuotaError(text) === false, 'classified as a quota failure');
  }
  for (const text of RULED_MUST) {
    check(`quota/ruled must: ${clip(text, 70)}`, isQuotaError(text) === true, 'not classified as a quota failure');
  }
  for (const text of RULED_MUST_NOT) {
    check(`quota/ruled must-not: ${clip(text, 70)}`, isQuotaError(text) === false, 'classified as a quota failure');
  }
  for (const [text, what] of WORDS_MUST) {
    check(`quota/words must (${what})`, isQuotaError(text) === true, `not classified: ${text}`);
  }
  for (const [text, what] of WORDS_MUST_NOT) {
    check(`quota/words must-not (${what})`, isQuotaError(text) === false, `classified: ${text}`);
  }
  for (const [text, what] of MORE_MUST) {
    check(`quota/must (${what})`, isQuotaError(text) === true, `not classified: ${text}`);
  }
  for (const [text, what] of MORE_MUST_NOT) {
    check(`quota/must-not (${what})`, isQuotaError(text) === false, `classified: ${text}`);
  }
  for (const [name, text] of BATTERY_MUST) {
    check(`quota/battery must (${name})`, isQuotaError(text) === true, `not classified: ${text}`);
  }
  for (const [name, text] of BATTERY_MUST_NOT) {
    check(`quota/battery must-not (${name})`, isQuotaError(text) === false, `classified: ${text}`);
  }
  for (const [text, what] of PHRASE_MUST) {
    check(`quota/phrase must (${what})`, isQuotaError(text) === true, `not classified: ${text}`);
  }
  for (const [text, what] of PHRASE_MUST_NOT) {
    check(`quota/phrase must-not (${what})`, isQuotaError(text) === false, `classified: ${text}`);
  }
  for (const [text, what] of PHRASE_KNOWN_OVER_READ) {
    check(`quota/phrase known over-read (${what})`, isQuotaError(text) === true, `no longer classified — move the row: ${text}`);
  }
  check('quota/not a string is not a quota failure', [undefined, null, 429, 42, {}, [], ['429']].every((v) => isQuotaError(v) === false));
  check('quota/5 MB of one letter is judged without a throw', (() => {
    try {
      return isQuotaError('x'.repeat(5_000_000)) === false;
    } catch {
      return false;
    }
  })());
  // Hostile sizes: the search must stay linear.
  const started = Date.now();
  const hostile = [
    'error'.repeat(200_000),
    'status code '.repeat(100_000),
    '    at f (/x.js:1:2)\n'.repeat(60_000),
    ':1'.repeat(500_000),
    'hit your '.repeat(100_000),
    'a'.repeat(1_000_000),
    `${'x'.repeat(200)}/`.repeat(5_000),
    'context limit exceeded '.repeat(50_000),
    '"'.repeat(500_000),
    'name.'.repeat(200_000),
    'goroutine 1 [running]:\n'.repeat(40_000),
    '{"a":"b",'.repeat(100_000),
    '"quota" '.repeat(120_000),
    'test x ... '.repeat(90_000),
  ];
  for (const big of hostile) {
    isQuotaError(big);
  }
  check(`quota/${hostile.length} megabyte-sized inputs are judged in under 2 s`, Date.now() - started < 2000, `${Date.now() - started} ms`);
  check('quota/a quota statement past the scanned head is not what decides', isQuotaError(`${'x'.repeat(70_000)} rate limit`) === false);
}

/* ------------------------------------------------------------------------- *
 * Section: streams — what is kept of a child's output
 * ------------------------------------------------------------------------- */

function sectionStreams(core) {
  const BoundedText = core.providerRunner?.BoundedText;
  const TAIL = core.providerRunner?.STDERR_TAIL_BYTES;
  if (!check('streams/the bounded stream and the stderr budget are exported (256 KiB)', typeof BoundedText === 'function' && TAIL === 256 * 1024, { BoundedText: typeof BoundedText, TAIL })) {
    return;
  }
  // The end of a stream, written one byte at a time — the worst case for what it costs to keep.
  {
    const kept = new BoundedText(TAIL, 0);
    const total = 2 * 1024 * 1024;
    let all = '';
    for (let i = 0; i < total; i++) {
      const ch = String.fromCharCode(97 + (i % 26));
      kept.push(ch);
    }
    all = Array.from({ length: 64 }, (_, k) => String.fromCharCode(97 + ((total - 64 + k) % 26))).join('');
    const text = kept.text();
    check('streams/stderr rule: 2 MiB in 1-byte writes keeps only the end, at most 256 KiB of it', kept.dropped === true && kept.bytes === total && text.length <= TAIL && text.length >= TAIL - 32 * 1024 && text.endsWith(all), { kept: text.length, dropped: kept.dropped, bytes: kept.bytes });
    check('streams/…as a bounded number of pieces, not one per write', Array.isArray(kept.tail) ? kept.tail.length <= 1100 : true, Array.isArray(kept.tail) ? kept.tail.length : 'n/a');
    check('streams/the diagnostic tail is the last characters', kept.tailText(10) === text.slice(-10));
  }
  // A short stream is kept whole.
  {
    const kept = new BoundedText(TAIL, 0);
    kept.push('line one\n');
    kept.push('line two\n');
    check('streams/a short stream is kept whole', kept.text() === 'line one\nline two\n' && kept.dropped === false);
  }
  // Start and end, middle dropped (another vendor's stdout).
  {
    const cap = 8 * 1024 * 1024;
    const head = 1024 * 1024;
    const kept = new BoundedText(cap, head);
    const chunk = (n) => String(n % 10).repeat(64 * 1024);
    for (let i = 0; i < 192; i++) kept.push(chunk(i)); // 12 MiB
    const text = kept.text();
    check('streams/stdout rule for a vendor: start and end kept, middle dropped, at most the cap', kept.dropped === true && text.startsWith(chunk(0)) && text.endsWith(chunk(191)) && text.length <= cap + 1 && text.length >= cap - 128 * 1024, { chars: text.length });
  }
  // Multi-byte text is counted in bytes.
  {
    const kept = new BoundedText(1024, 0);
    for (let i = 0; i < 2000; i++) kept.push('한');
    check('streams/the budget is in bytes, not characters', Buffer.byteLength(kept.text()) <= 1024 && kept.text().length >= 300 && /^한+$/.test(kept.text()), { bytes: Buffer.byteLength(kept.text()), chars: kept.text().length });
  }
}

/* ------------------------------------------------------------------------- *
 * Section: gate — the module alone
 * ------------------------------------------------------------------------- */

/** 'pending' when `promise` has not settled after the event loop went round once. */
function stateOf(promise) {
  return Promise.race([
    promise.then(
      () => 'fulfilled',
      () => 'rejected',
    ),
    new Promise((resolve) => setImmediate(() => resolve('pending'))),
  ]);
}

async function sectionGate(core) {
  const acquire = core.acquireDispatchSlot;
  const stats = core.dispatchGateStats;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('gate/starts empty', same(stats(), { running: 0, waiting: 0 }), stats());

  // Under the limit: at once. At the limit: waits.
  {
    const held = [await acquire({ limit: 3 }), await acquire({ limit: 3 }), await acquire({ limit: 3 })];
    const fourth = acquire({ limit: 3 });
    check('gate/three of three are admitted, the fourth waits', (await stateOf(fourth)) === 'pending' && same(stats(), { running: 3, waiting: 1 }), stats());
    held[0].release();
    const slot = await fourth;
    check('gate/a release admits the waiter', same(stats(), { running: 3, waiting: 0 }), stats());
    for (const s of [held[1], held[2], slot]) s.release();
    check('gate/all released', same(stats(), { running: 0, waiting: 0 }), stats());
  }

  // FIFO.
  {
    const order = [];
    const first = await acquire({ limit: 1 });
    const waiters = ['b', 'c', 'd', 'e'].map((name) =>
      acquire({ limit: 1 }).then((slot) => {
        order.push(name);
        return slot;
      }),
    );
    first.release();
    for (const w of waiters) {
      (await w).release();
    }
    check('gate/waiters are admitted in the order they asked', order.join('') === 'bcde', order.join(''));
    check('gate/FIFO leaves nothing behind', same(stats(), { running: 0, waiting: 0 }), stats());
  }

  // Aborted before the call.
  {
    const c = new AbortController();
    c.abort();
    const err = await acquire({ limit: 5, signal: c.signal }).then(
      () => undefined,
      (e) => e,
    );
    check('gate/a signal aborted before the call rejects with an Error named AbortError', err instanceof Error && err.name === 'AbortError', err);
    check('gate/…and consumed nothing', same(stats(), { running: 0, waiting: 0 }), stats());
  }

  // Aborted while waiting.
  {
    const holder = await acquire({ limit: 1 });
    const c = new AbortController();
    const waiting = acquire({ limit: 1, signal: c.signal });
    const before = stats();
    c.abort();
    const err = await waiting.then(
      () => undefined,
      (e) => e,
    );
    check('gate/a waiter whose signal aborts rejects with AbortError', before.waiting === 1 && err instanceof Error && err.name === 'AbortError', { before, err: String(err) });
    check('gate/…leaves the queue and holds no slot', same(stats(), { running: 1, waiting: 0 }), stats());
    holder.release();
    check('gate/…and the released slot is free for the next caller', same(stats(), { running: 0, waiting: 0 }) && (await stateOf(acquire({ limit: 1 }).then((s) => s.release()))) === 'fulfilled', stats());
  }

  // An aborted HEAD lets the next waiter be judged by its own limit.
  {
    const a = await acquire({ limit: 8 });
    const b = await acquire({ limit: 8 });
    const c = new AbortController();
    const strict = acquire({ limit: 1, signal: c.signal });
    const roomy = acquire({ limit: 8 });
    const held = (await stateOf(roomy)) === 'pending';
    c.abort();
    await strict.catch(() => undefined);
    const slot = await roomy;
    check('gate/a waiter behind a stricter head waits, and is admitted when that head is cancelled', held && same(stats(), { running: 3, waiting: 0 }), { held, stats: stats() });
    for (const s of [a, b, slot]) s.release();
  }

  // An abort after admission changes nothing.
  {
    const c = new AbortController();
    const slot = await acquire({ limit: 1, signal: c.signal });
    c.abort();
    await sleep(5);
    check('gate/an abort after the slot was handed over does not take it back', same(stats(), { running: 1, waiting: 0 }), stats());
    slot.release();
  }

  // Double release.
  {
    const holder = await acquire({ limit: 1 });
    const w1 = acquire({ limit: 1 });
    const w2 = acquire({ limit: 1 });
    holder.release();
    holder.release();
    holder.release();
    const s1 = await w1;
    check('gate/releasing a slot three times frees ONE slot', (await stateOf(w2)) === 'pending' && same(stats(), { running: 1, waiting: 1 }), stats());
    s1.release();
    (await w2).release();
    check('gate/…and the count never goes below zero', same(stats(), { running: 0, waiting: 0 }), stats());
  }

  // Limits that are not a whole number of at least 1.
  for (const bad of [0, -1, NaN, 2.5, Infinity, -Infinity, '3', undefined, null]) {
    const first = await acquire({ limit: bad });
    const second = acquire({ limit: bad });
    const waits = (await stateOf(second)) === 'pending';
    first.release();
    (await second).release();
    check(`gate/a limit of ${String(bad)}${typeof bad === 'string' ? ' (a string)' : ''} is enforced as 1`, waits && same(stats(), { running: 0, waiting: 0 }), { waits, stats: stats() });
  }

  // The limit lowered, then raised, between acquires.
  {
    const three = [await acquire({ limit: 3 }), await acquire({ limit: 3 }), await acquire({ limit: 3 })];
    const lowered = acquire({ limit: 1 });
    three[0].release();
    const stillWaitingAtTwo = (await stateOf(lowered)) === 'pending';
    three[1].release();
    const stillWaitingAtOne = (await stateOf(lowered)) === 'pending';
    three[2].release();
    const slot = await lowered;
    check('gate/a waiter that asked under a LOWER limit waits until fewer than that are running', stillWaitingAtTwo && stillWaitingAtOne && same(stats(), { running: 1, waiting: 0 }), { stillWaitingAtTwo, stillWaitingAtOne, stats: stats() });
    const raised = [await acquire({ limit: 5 }), await acquire({ limit: 5 })];
    check('gate/a caller that asks under a RAISED limit is admitted beside it', same(stats(), { running: 3, waiting: 0 }), stats());
    for (const s of [slot, ...raised]) s.release();
    check('gate/…and everything drains', same(stats(), { running: 0, waiting: 0 }), stats());
  }

  // 10,000 cycles.
  {
    let now = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10_000 }, async (_, i) => {
        const slot = await acquire({ limit: 4 });
        now++;
        peak = Math.max(peak, now);
        if (i % 7 === 0) await new Promise((r) => setImmediate(r));
        else await null;
        now--;
        slot.release();
        if (i % 11 === 0) slot.release();
      }),
    );
    check('gate/10,000 acquire/release cycles never exceed the limit', peak === 4, `peak ${peak}`);
    check('gate/…and leave running and waiting at 0', same(stats(), { running: 0, waiting: 0 }), stats());
  }
}

/* ------------------------------------------------------------------------- *
 * Section: core — the dispatch core inside a child process
 * ------------------------------------------------------------------------- */

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Run one scenario of runner-core.cjs under its own scratch HOME. Resolves its RESULT object. */
/**
 * `opts.env` / `opts.cwd` replace the scratch HOME and directory (a scenario that runs inside a
 * providers-harness sandbox passes that sandbox's).
 *
 * `opts.stop` STOPS the scenario's process and resumes it: `{ when, exited, forMs }` — SIGSTOP
 * as soon as `when(fakeLog)` holds (its worker is running), SIGCONT once `exited(fakeLog)` holds
 * (the worker has left) AND `forMs` have passed since the stop. It is how a dispatching process
 * that got no CPU past its worker's time limit is produced in seconds, without anybody sleeping
 * for a minute: the limit is short, and the process is stopped across it.
 */
function runCore(scenario, timeoutMs = 240_000, opts = {}) {
  const dir = path.join(BASE, `core-${scenario}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const fakeLog = path.join(dir, 'fake.log');
  const env = opts.env ?? {
    HOME: home,
    USERPROFILE: home,
    PATH: [path.dirname(process.execPath), ...SYSTEM_PATH].join(':'),
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: 'C',
    RUNNER_FAKE: FAKE,
    RUNNER_FAKE_LOG: fakeLog,
    ...keychainGuard.envVars(),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE_DRIVER, CORE_CJS, scenario], { env, cwd: opts.cwd ?? dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let stoppedAt = 0;
    let stoppedMs = 0;
    const stopper =
      opts.stop === undefined
        ? undefined
        : setInterval(() => {
            try {
              if (stoppedAt === 0) {
                if (opts.stop.when(fakeLog)) {
                  process.kill(child.pid, 'SIGSTOP');
                  stoppedAt = Date.now();
                }
              } else if (stoppedMs === 0 && Date.now() - stoppedAt >= opts.stop.forMs && opts.stop.exited(fakeLog)) {
                stoppedMs = Date.now() - stoppedAt;
                process.kill(child.pid, 'SIGCONT');
              }
            } catch {
              // the scenario's process is gone; its exit says the rest
            }
          }, 20);
    const timer = setTimeout(() => {
      try {
        process.kill(child.pid, 'SIGCONT');
      } catch {
        // gone
      }
      child.kill('SIGKILL');
      reject(new Error(`core scenario ${scenario} did not finish in ${timeoutMs} ms; stderr: ${clip(err, 400)}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(stopper);
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || line === undefined) {
        reject(new Error(`core scenario ${scenario} exited ${code}; stderr: ${clip(err, 600)}`));
        return;
      }
      resolve({ result: JSON.parse(line.slice('RESULT '.length)), stderr: err, stoppedMs });
    });
  });
}

/** `runCore`'s stop rule for a scenario whose worker is the fake `claude`. */
const stopAcrossFakeClaude = (forMs) => ({
  when: (log) => readJsonl(log).some((r) => r.ev === 'mode'),
  exited: (log) => readJsonl(log).some((r) => r.ev === 'exit'),
  forMs,
});

const ZERO = { running: 0, waiting: 0 };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OVERFLOW = 'Worker output exceeded 8 MiB and was discarded';
const CANCELLED_WAITING = 'cancelled before it started';
const CANCELLED_RUNNING = 'cancelled by the orchestrator session';

/** The wrong-typed arguments of the `args` scenario, in its order (runner-core.cjs). */
const CORE_ARG_CASES = [
  ['arguments: null', null],
  ['arguments: array', ['x']],
  ['title: array', { title: ['x'], prompt: 'ok' }],
  ['title: number', { title: 7, prompt: 'ok' }],
  ['prompt: number', { title: 't', prompt: 123 }],
  ['prompt: object', { title: 't', prompt: { a: 1 } }],
  ['prompt: absent', { title: 't' }],
  ['prompt: blank', { title: 't', prompt: '   ' }],
  ['prompt: NUL', { title: 't', prompt: 'a\u0000b' }],
  ['system_prompt: number', { title: 't', prompt: 'ok', system_prompt: 7 }],
  ['system_prompt: NUL', { title: 't', prompt: 'ok', system_prompt: 'a\u0000b' }],
  ['model: object', { title: 't', prompt: 'ok', model: { x: 1 } }],
  ['model: 10k', { title: 't', prompt: 'ok', model: 'a'.repeat(10000) }],
  ['worker: object', { title: 't', prompt: 'ok', worker: { name: 'wa' } }],
  ['worker: number', { title: 't', prompt: 'ok', worker: 42 }],
  ['provider: object', { title: 't', prompt: 'ok', provider: {} }],
  ['ultrathink: "yes"', { title: 't', prompt: 'ok', ultrathink: 'yes' }],
  ['ultrathink: 1', { title: 't', prompt: 'ok', ultrathink: 1 }],
  ['detach: "true"', { title: 't', prompt: 'ok', detach: 'true' }],
  ['timeout_minutes: object', { title: 't', prompt: 'ok', timeout_minutes: {} }],
  ['timeout_minutes: true', { title: 't', prompt: 'ok', timeout_minutes: true }],
];

async function sectionCore(core) {
  // Arguments.
  {
    const { result: r } = await runCore('args');
    for (const [name, args] of CORE_ARG_CASES) {
      const want = core.checkDispatchArgs(args).error;
      const got = r.results.find((x) => x.name === name);
      check(`core/args ${name} → the checker's message`, got !== undefined && got.ok === false && got.text === want, { want, got });
    }
    check('core/args: the two literal messages a client is most likely to meet', r.results.find((x) => x.name === 'prompt: number')?.text === 'invalid prompt — expected a string, got a number' && r.results.find((x) => x.name === 'ultrathink: "yes"')?.text === 'invalid ultrathink — expected true or false, got a string', r.results);
    check('core/args: nothing was logged, tracked, written or spawned for any refusal', r.events === 0 && r.tracked === 0 && r.fakeStarts === 0 && r.taskFiles.length === 0 && eq(r.gate, ZERO), { events: r.events, tracked: r.tracked, fakeStarts: r.fakeStarts, taskFiles: r.taskFiles, gate: r.gate });
  }
  // The bounded title.
  {
    const { result: r } = await runCore('title');
    const bounded = (rows) => rows.length > 0 && rows.every((t) => t.chars >= 1 && t.chars <= 200 && t.oneLine);
    check('core/title: a 10 MB title still dispatches', r.ok === true, r);
    check('core/title: the host is handed a one-line title of at most 200 characters', bounded(r.trackedTitles), r.trackedTitles);
    check('core/title: every event of the task carries that title', bounded(r.eventTitles) && r.logBytes < 64 * 1024, { titles: r.eventTitles, logBytes: r.logBytes });
    check('core/title: the output file header is that title (one line, ≤ 200 + "# ")', r.headerLine >= 3 && r.headerLine <= 202 && r.fileBytes < 8192, { headerLine: r.headerLine, fileBytes: r.fileBytes });
    check('core/title: the result does not grow with the title', r.resultChars < 2000, r.resultChars);
  }
  // Cancelled while waiting for a slot.
  {
    const { result: r } = await runCore('cancel-waiting');
    check('core/gate: a second dispatch at limit 1 waits, with nothing logged for it', eq(r.whileWaiting, { running: 1, waiting: 1 }) && r.eventsWhileWaiting === 0, { whileWaiting: r.whileWaiting, events: r.eventsWhileWaiting });
    check(`core/gate: cancelled while waiting → "${CANCELLED_WAITING}"`, r.waiter.ok === false && r.waiter.text === CANCELLED_WAITING, r.waiter);
    check('core/gate: …and it left the queue without a slot, an id, an event, a file or a process', eq(r.afterCancel, { running: 1, waiting: 0 }) && r.waiterTracked === 0 && r.waiterSettled === 0 && r.waiterEvents === 0 && r.waiterRuns === 0, r);
    check('core/gate: the dispatch that held the slot finished and released it', r.holder.ok === true && eq(r.atEnd, ZERO), { holder: r.holder, atEnd: r.atEnd });
  }
  // Every way a dispatch ends, at limit 2.
  {
    await calm();
    const { result: r } = await runCore('gate-drain');
    check('core/gate: seven dispatches at limit 2 — two run, five wait', eq(r.midway, { running: 2, waiting: 5 }), r.midway);
    check('core/gate: never more than 2 worker processes alive', r.peak <= 2 && r.peak >= 1, `peak ${r.peak}`);
    check('core/gate: spawn ENOENT fails as "Failed to start"', r.enoent.ok === false && r.enoent.text.startsWith('Failed to start'), r.enoent);
    check("core/gate: a spawn that fails with ENOENT never reaches the host's onSpawn, and no event names a pid for it", r.enoentSpawned === 0 && r.enoentPidEvents === 0, { onSpawnCalls: r.enoentSpawned, pidEvents: r.enoentPidEvents });
    check('core/gate: success, non-zero exit, and the last dispatch', r.success.ok === true && r.failed.ok === false && r.failed.text.startsWith('Worker exited with code 3') && r.last.ok === true, { success: r.success, failed: r.failed, last: r.last });
    check('core/gate: cancelled while running', r.cancelledRunning.ok === false && r.cancelledRunning.text === CANCELLED_RUNNING, r.cancelledRunning);
    check('core/gate: cancelled while waiting never started', r.cancelledWaiting.ok === false && r.cancelledWaiting.text === CANCELLED_WAITING && r.waitingTracked === 0 && r.runsByTag['g-cancel-wait'] === undefined, { answer: r.cancelledWaiting, runs: r.runsByTag });
    check('core/gate: a quota failure fails over inside its one slot (two runs, one cooldown)', r.failover.ok === true && r.runsByTag['g-quota'] === 2 && r.cooled.length === 1, { answer: r.failover, runs: r.runsByTag, cooled: r.cooled });
    check(`core/output: 12 MiB of stdout → "${OVERFLOW}", one run`, r.overflow.ok === false && r.overflow.text === OVERFLOW && r.runsByTag['g-big'] === 1, { answer: r.overflow, runs: r.runsByTag });
    check('core/gate: after all of them the gate is empty and no worker is alive', eq(r.gate, ZERO) && r.aliveAtEnd === 0, { gate: r.gate, alive: r.aliveAtEnd });
  }
  // The final output file cannot be written.
  {
    const { result: r } = await runCore('outfile');
    const NOTE = 'note: the output file of this task was NOT written';
    check('core/records: a DONE file that cannot be written leaves the task DONE', r.done.ok === true && r.done.text.includes('FAKE_OK donefile') && r.doneEvents.at(-1) === 'done', { done: r.done, events: r.doneEvents });
    check('core/records: …and the result says the file was not written', r.done.ok === true && r.done.text.includes(NOTE), r.done.text);
    check("core/records: a FAILED file that cannot be written leaves the worker's failure as the failure", r.failed.ok === false && r.failed.text.startsWith('Worker exited with code 3') && r.failed.text.includes(NOTE), r.failed);
    check("core/records: …and the terminal event is still appended, with the worker's failure", r.failedEvents.at(-1)?.status === 'error' && String(r.failedEvents.at(-1)?.error).startsWith('Worker exited with code 3'), r.failedEvents);
    const totals = Object.values(r.stats).reduce((acc, s) => ({ tasks: acc.tasks + (s.tasks ?? 0), errors: acc.errors + (s.errors ?? 0) }), { tasks: 0, errors: 0 });
    check('core/records: one success and one failure were counted, and nothing ran twice', totals.tasks === 1 && totals.errors === 1 && eq(r.runs, ['donefile', 'failfile']) && eq(r.gate, ZERO), { totals, runs: r.runs, gate: r.gate });
  }
  // A stuck stats lock.
  {
    const { result: r } = await runCore('stats-pause');
    check('core/records: a stats write refused by the lock leaves the task done, with a note', r.first.ok === true && r.first.text.includes('note: stats for this task were not recorded') && r.first.text.includes('Could not lock') && r.first.ms >= 10_000, r.first);
    check('core/records: the NEXT task does not wait for the lock again (under 5 s)', r.second.ok === true && r.second.ms < 5000, r.second);
    check('core/records: …and says its stats were skipped because the lock was just found stuck', r.second.ok === true && /note: stats for this task were not recorded — skipped: the stats lock was found stuck/.test(r.second.text), r.second.text);
    check('core/records: a quota cooldown skipped the same way is still honoured (failover to the other account)', r.third.ok === true && r.quotaAccounts.length === 2 && r.quotaAccounts[0] !== r.quotaAccounts[1] && r.cooldownHeld === true && r.third.ms < 8000, { third: r.third, accounts: r.quotaAccounts, held: r.cooldownHeld });
    check('core/records: nothing reached stats.json, and the gate is empty', Object.keys(r.statsOnDisk).length === 0 && eq(r.gate, ZERO), { stats: r.statsOnDisk, gate: r.gate });
  }
  // A named entry this version cannot use.
  {
    const { result: r } = await runCore('unsupported');
    const FUTURE = 'worker "future" is a registry entry this version cannot use (unknown provider "copilot-next")';
    check('core/workers: the registry reads the two entries as unsupported', r.unsupported.some((e) => e.name === 'future' && e.reason === 'provider') && r.unsupported.some((e) => e.name === 'half' && e.reason === 'shape'), r.unsupported);
    check('core/workers: naming an entry with an unknown provider', r.future.ok === false && r.future.text === FUTURE, r.future);
    check('core/workers: naming an incomplete entry', r.half.ok === false && r.half.text === 'worker "half" is a registry entry this version cannot use (incomplete entry)', r.half);
    check('core/workers: a name nobody registered is still "Unknown worker"', r.nobody.ok === false && r.nobody.text === 'Unknown worker "nobody". Registered workers: wa, wb.', r.nobody);
    check('core/workers: all three are refused before anything exists — zero events, zero files, nothing tracked', r.left.events === 0 && r.left.taskFiles.length === 0 && r.left.tracked === 0 && r.left.settled === 0, r.left);
    check('core/workers: the same refusal when no entry is usable at all', r.alone.ok === false && r.alone.text === FUTURE && r.empty.ok === false && r.empty.text.startsWith('No worker accounts registered'), { alone: r.alone, empty: r.empty });
    check('core/workers: none of them started a worker', r.runs === 0 && eq(r.gate, ZERO), { runs: r.runs, gate: r.gate });
  }
  // The event writer refuses an id that cannot name a task file. What a dispatch makes of that.
  {
    const { result: r } = await runCore('event-id');
    const REFUSAL = 'task log append refused: the id of the event is not a task id';
    check('core/records: a terminal event the log refuses for its id does not throw into the dispatch', r.threw === null, r.threw);
    check('core/records: …the outcome stands, and the note says the task log does not have it and why', r.note.includes('note: the outcome of this task was NOT written to the task log') && r.note.includes(REFUSAL) && r.note.includes('The log still shows the task as running'), r.note);
    check('core/records: …in words that do not carry the id', !r.note.includes('SENTINEL'), r.note);
    check('core/records: an event under an ordinary id is written, with nothing to note', r.fineNote === '' && r.goodLines === 1, { note: r.fineNote, lines: r.goodLines });
    check('core/records: a host that hands the core an id that cannot name a file is refused before anything starts', r.dispatch.ok === false && r.dispatch.text.startsWith(REFUSAL) && !r.dispatch.text.includes('SENTINEL') && r.runs === 0 && r.spawned === 0, { dispatch: r.dispatch, runs: r.runs, spawned: r.spawned });
    check('core/records: …with no line in the log, no file anywhere, its slot released and the host told it is over', r.logGrew === 0 && r.taskFiles.filter((n) => !n.startsWith('tgoodid')).length === 0 && r.homeFiles.length === 0 && eq(r.gate, ZERO) && r.settled === 1, { logGrew: r.logGrew, taskFiles: r.taskFiles, homeFiles: r.homeFiles, gate: r.gate, settled: r.settled });
  }
  // What "timed out" means: runClaude driven directly, with a limit of 1.2 seconds.
  {
    const { result: r } = await runCore('limit', 120_000);
    if (check('core/limit: runClaude is exported for this harness', r.exported === true, r)) {
      check('core/limit: a worker that finishes inside its limit is a success', r.quick.ok === true && r.quick.text === 'FAKE_OK lim-quick', r.quick);
      check('core/limit: a worker still running at its limit is killed and reported as timed out', r.hang.ok === false && r.hang.text.startsWith('Worker timed out after') && r.hang.gone === true && r.hang.ms < 5000, r.hang);
      check('core/limit: a worker that leaves with exit 0 and its WHOLE successful result after the kill was sent is a success', r.termOk.ok === true && r.termOk.text === 'FAKE_OK lim-term-ok', r.termOk);
      check('core/limit: …but an `is_error` result printed on the way out does not replace the timeout (and is not read for quota)', r.termError.ok === false && r.termError.text.startsWith('Worker timed out after'), r.termError);
      check('core/limit: …and neither does an exit 0 with nothing printed', r.termEmpty.ok === false && r.termEmpty.text.startsWith('Worker timed out after'), r.termEmpty);
    }
  }
  // The dispatching process gets no CPU past the limit while its worker finishes. A limit of 2 s;
  // the scenario's process is stopped from the moment its worker runs until 2.6 s later.
  {
    const done = await runCore('stop-claude', 60_000, { stop: stopAcrossFakeClaude(2600) });
    check('core/limit: a worker that exited 0 with its result while its dispatcher was STOPPED past the limit is a success, not a timeout', done.stoppedMs >= 2600 && done.result.ok === true && done.result.text === 'FAKE_OK stop-claude', { stoppedMs: done.stoppedMs, ...done.result });
    const failed = await runCore('stop-claude-fail', 60_000, { stop: stopAcrossFakeClaude(2600) });
    check('core/limit: …and one that FAILED by itself meanwhile is reported as that failure, not as a timeout', failed.stoppedMs >= 2600 && failed.result.ok === false && String(failed.result.text).startsWith('Worker exited with code 3'), { stoppedMs: failed.stoppedMs, ...failed.result });
  }
  // The same race with a cancel instead of the limit: the host cancels at +900 ms, while stopped.
  {
    const c = await runCore('stop-cancel', 60_000, { stop: stopAcrossFakeClaude(1400) });
    check('core/cancel: a cancel that is handled after the worker had exited 0 does not undo the run — it is recorded done, with its result', c.stoppedMs >= 1400 && c.result.cancelledByThen === true && c.result.ok === true && c.result.hasAnswer === true && c.result.statuses.at(-1) === 'done' && c.result.fileHasResult === true, { stoppedMs: c.stoppedMs, ...c.result });
  }
}

/* ------------------------------------------------------------------------- *
 * Sections e2e and vendor — a real server in the providers harness's sandbox
 * ------------------------------------------------------------------------- */

let H; // .orchestrator/providers/helpers.mjs, loaded once the build exists

/** A sandbox with Claude Code workers wa and wb on the fake, and a server started in it. */
async function claudeSandbox(label, registryPatch = {}) {
  const fx = H.makeFixture({ label, workers: [{ name: 'wa' }, { name: 'wb' }] });
  const fake = path.join(fx.root, 'fake', 'claude-fake.mjs');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.copyFileSync(FAKE_SRC, fake);
  fs.chmodSync(fake, 0o755);
  const log = path.join(fx.root, 'runner-fake.log');
  const registryFile = path.join(fx.orchRoot, 'registry.json');
  const patchRegistry = (patch) => {
    const reg = { ...JSON.parse(fs.readFileSync(registryFile, 'utf8')), ...patch };
    fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify(reg, null, 2));
    fs.renameSync(`${registryFile}.tmp`, registryFile);
  };
  patchRegistry({ claudePath: fake, workerTimeoutMinutes: 2, ...registryPatch });
  const srv = await fx.startServer({ env: { RUNNER_FAKE_LOG: log } });
  const rows = () => readJsonl(log);
  return {
    fx,
    srv,
    fake,
    patchRegistry,
    /** The worker runs the fake recorded: { pid, tag, mode, account, start, exit?, how? }. */
    runs() {
      const byPid = new Map();
      for (const r of rows()) {
        const run = byPid.get(r.pid) ?? { pid: r.pid };
        if (r.ev === 'start') run.start = r.t;
        if (r.ev === 'mode') Object.assign(run, { tag: r.tag, mode: r.mode, account: r.account });
        if (r.ev === 'exit') Object.assign(run, { exit: r.t, how: r.how, written: r.written });
        byPid.set(r.pid, run);
      }
      return [...byPid.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    },
    starts: () => rows().filter((r) => r.ev === 'start').length,
  };
}

/** Most runs alive at the same moment, from their recorded [start, exit] intervals. */
function peakOverlap(runs, now = Date.now()) {
  const edges = [];
  for (const r of runs) {
    if (typeof r.start !== 'number') continue;
    edges.push([r.start, 1], [typeof r.exit === 'number' ? r.exit : now, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let alive = 0;
  let peak = 0;
  for (const [, d] of edges) {
    alive += d;
    peak = Math.max(peak, alive);
  }
  return peak;
}

const cooled = (stats) => Object.entries(stats).filter(([, s]) => typeof s?.cooldownUntil === 'number' && s.cooldownUntil > Date.now()).map(([name]) => name);

async function sectionE2eArguments(core) {
  const box = await claudeSandbox('args');
  const { fx, srv } = box;
  try {
    // [name, arguments, 'exact' | pattern]. Until the server checks arguments itself (it calls
    // the cores' resolveDispatchTarget first), a `worker` / `provider` of the wrong type is
    // refused by that function's own words; both spellings are refusals of the same field.
    const cases = [
      ['title: array', { title: ['x'], prompt: 'ok' }, 'exact'],
      ['prompt: number', { title: 't', prompt: 123 }, 'exact'],
      ['prompt: absent', { title: 't' }, 'exact'],
      ['prompt: NUL', { title: 't', prompt: 'a\u0000b [[fake:ok]]' }, 'exact'],
      ['system_prompt: number', { title: 't', prompt: 'ok', system_prompt: 7 }, 'exact'],
      ['model: object', { title: 't', prompt: 'ok', model: { x: 1 } }, 'exact'],
      ['model: 10,000 characters', { title: 't', prompt: 'ok', model: 'a'.repeat(10000) }, 'exact'],
      ['ultrathink: "yes"', { title: 't', prompt: '[[fake:ok]]', ultrathink: 'yes' }, 'exact'],
      ['detach: "true"', { title: 't', prompt: '[[fake:ok]]', detach: 'true' }, 'exact'],
      ['timeout_minutes: object', { title: 't', prompt: '[[fake:ok]]', timeout_minutes: {} }, 'exact'],
      ['arguments: a string', 'a string', 'exact'],
      ['arguments: an array', [1, 2], 'exact'],
      ['worker: a name nobody registered', { title: 't', prompt: '[[fake:ok]]', worker: 'nobody' }, /^Error: Unknown worker "nobody"\. Registered workers: wa, wb\.$/],
      ['worker: object', { title: 't', prompt: 'ok', worker: { name: 'wa' } }, /^Error: invalid worker — expected /],
      ['provider: object', { title: 't', prompt: 'ok', provider: {} }, /^Error: (invalid|unknown) provider\b/],
    ];
    for (const [name, args, how] of cases) {
      const r = await srv.callTool('dispatch_task', args, 30_000);
      const want = `Error: ${core.checkDispatchArgs(args).error}`;
      const ok = r.isError === true && (how === 'exact' ? r.text === want : how.test(r.text)) && !/TypeError|is not a function|Cannot read prop/.test(r.text) && r.text.length < 400;
      check(`e2e/args ${name} → refused${how === 'exact' ? " with the checker's message" : ''}`, ok, { want: how === 'exact' ? want : String(how), got: r.text });
    }
    await sleep(300);
    check('e2e/args: no task-log entry, no task file and no spawned process for any of them', fx.events().length === 0 && fs.readdirSync(fx.tasksDir).length === 0 && box.starts() === 0, { events: fx.events().length, files: fs.readdirSync(fx.tasksDir), starts: box.starts() });

    // The same server still dispatches — and bounds a 10 MB title.
    const huge = 'T'.repeat(10 * 1024 * 1024);
    const r = await srv.callTool('dispatch_task', { title: huge, prompt: '[[fake:ok]] [[tag:bigtitle]]' }, 60_000);
    // By its prompt: on a build that runs what this one refuses, the log holds other tasks too.
    const events = fx.events().filter((e) => String(e.promptPreview).includes('bigtitle'));
    const outputFile = events.find((e) => typeof e.outputFile === 'string')?.outputFile;
    const header = outputFile && fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').split('\n', 1)[0] : '';
    check('e2e/title: a 10 MB title dispatches, and the result is small', r.isError === false && r.text.includes('FAKE_OK bigtitle') && r.text.length < 2000, { isError: r.isError, chars: r.text.length });
    check('e2e/title: one bounded line in every task-log event', events.length >= 2 && events.every((e) => typeof e.title === 'string' && e.title.length <= 200 && !/[\r\n]/.test(e.title)) && fs.statSync(path.join(fx.orchRoot, 'tasks.jsonl')).size < 64 * 1024, { titles: events.map((e) => String(e.title).length), bytes: fs.statSync(path.join(fx.orchRoot, 'tasks.jsonl')).size });
    check('e2e/title: one bounded line as the output file header', header.startsWith('# T') && header.length <= 202, `header line of ${header.length} characters`);
  } finally {
    await fx.cleanup();
  }
}

async function sectionE2eGate() {
  await calm();
  const box = await claudeSandbox('gate', { maxConcurrentDispatches: 3 });
  const { fx, srv } = box;
  let polledPeak = 0;
  const poll = setInterval(() => {
    const alive = box.runs().filter((r) => isPidAlive(r.pid)).length;
    polledPeak = Math.max(polledPeak, alive);
  }, 40);
  try {
    const start = (title, mode, extra = {}) => srv.startTool('dispatch_task', { title, prompt: `[[fake:${mode}]] [[tag:${title}]]`, ...extra });
    const started = (title) => box.runs().some((r) => r.tag === title);
    const cancel = (call) => srv.notify('notifications/cancelled', { requestId: call.id });

    // 1 — spawn ENOENT. First and alone: `claudePath` is one value for the whole server. The
    // name exists nowhere, so the login-shell lookup the server falls back on finds nothing.
    box.patchRegistry({ claudePath: path.join(fx.root, 'missing', 'cco-runner-absent-cli') });
    const a1 = await start('D1', 'ok').answer(30_000);
    box.patchRegistry({ claudePath: box.fake });
    check('e2e/gate D1: spawn ENOENT fails the dispatch, with no cooldown', a1.isError && a1.text.includes('Failed to start') && cooled(fx.stats()).length === 0, { text: a1.text, stats: fx.stats() });

    // 2-4 fill the three slots; 5-8 queue behind them.
    const d2 = start('D2', 'delay:5000');
    await sleep(120);
    const d3 = start('D3', 'hang', { timeout_minutes: 1 });
    await sleep(120);
    const d4 = start('D4', 'hang');
    await waitFor(() => ['D2', 'D3', 'D4'].every(started), { label: 'D2, D3 and D4 to be running' });
    const d5 = start('D5', 'fail');
    await sleep(80);
    const d6 = start('D6', 'delay:1000');
    await sleep(80);
    const d7 = start('D7', 'quota-once:gate12');
    await sleep(80);
    const d8 = start('D8', 'delay:600');
    await sleep(500);
    const queuedTitles = ['D5', 'D6', 'D7', 'D8'];
    check('e2e/gate: with three running, four more dispatches wait — nothing logged, nothing spawned', queuedTitles.every((t) => !started(t) && fx.eventsFor(t).length === 0) && box.runs().length === 3, { runs: box.runs().map((r) => r.tag), events: queuedTitles.map((t) => fx.eventsFor(t).length) });

    // 6 is cancelled while it waits; 4 while it runs — which frees the first slot.
    cancel(d6);
    await sleep(300);
    cancel(d4);
    const a5 = await d5.answer(30_000);
    const a7 = await d7.answer(30_000);
    const a8 = await d8.answer(30_000);
    const a2 = await d2.answer(30_000);
    const a9 = await start('D9', 'delay:300').answer(30_000);
    check('e2e/gate D2, D8, D9: success', [a2, a8, a9].every((a) => a.isError === false) && a2.text.includes('FAKE_OK D2') && a8.text.includes('FAKE_OK D8') && a9.text.includes('FAKE_OK D9'), [a2.text, a8.text, a9.text].map((t) => clip(t, 80)));
    check('e2e/gate D5: non-zero exit', a5.isError && a5.text.includes('Worker exited with code 3'), a5.text);
    const d4run = box.runs().find((r) => r.tag === 'D4');
    await waitFor(() => d4run !== undefined && !isPidAlive(d4run.pid), { timeoutMs: 15_000, label: "D4's worker to be gone" }).catch(() => undefined);
    check('e2e/gate D4: cancelled while running — worker killed, terminal event, no answer', d4run !== undefined && !isPidAlive(d4run.pid) && fx.eventsFor('D4').at(-1)?.error === CANCELLED_RUNNING && !srv.hasResponse(d4.id), { run: d4run, last: fx.eventsFor('D4').at(-1), answered: srv.hasResponse(d4.id) });
    check('e2e/gate D6: cancelled while waiting — never spawned, no task-log entry, no answer', !started('D6') && fx.eventsFor('D6').length === 0 && !srv.hasResponse(d6.id), { started: started('D6'), events: fx.eventsFor('D6').length, answered: srv.hasResponse(d6.id) });
    const d7runs = box.runs().filter((r) => r.tag === 'D7');
    check('e2e/gate D7: quota failover — two runs on two accounts, one cooldown, then success', a7.isError === false && a7.text.includes('FAKE_OK D7') && d7runs.length === 2 && d7runs[0].account !== d7runs[1].account && eq(cooled(fx.stats()), [d7runs[0].account]), { text: clip(a7.text, 100), runs: d7runs, cooled: cooled(fx.stats()) });
    const firstStart = (t) => box.runs().find((r) => r.tag === t)?.start ?? NaN;
    check('e2e/gate: the queue was served in order (D5, then D7, then D8)', firstStart('D5') <= firstStart('D7') && firstStart('D7') <= firstStart('D8'), ['D5', 'D7', 'D8'].map(firstStart));

    // 3 runs into its one-minute wall clock.
    const a3 = await d3.answer(120_000);
    const d3run = box.runs().find((r) => r.tag === 'D3');
    check('e2e/gate D3: timeout — after one minute, worker gone', a3.isError && a3.text.includes('timed out after 1 minutes') && d3run !== undefined && !isPidAlive(d3run.pid) && a3.elapsedMs >= 55_000, { text: clip(a3.text, 120), elapsedMs: a3.elapsedMs });

    // The first nine have ended in seven different ways. If any of them kept its slot, the
    // last three cannot all be alive at once.
    await calm();
    const before = box.runs().length;
    const last = [start('D10', 'delay:1500'), start('D11', 'delay:1500'), start('D12', 'delay:1500')];
    const answers = [];
    for (const call of last) answers.push(await call.answer(30_000));
    const lastRuns = box.runs().filter((r) => ['D10', 'D11', 'D12'].includes(r.tag));
    check('e2e/gate D10-D12: the last three still run', answers.every((a) => a.isError === false) && lastRuns.length === 3 && box.runs().length === before + 3, answers.map((a) => clip(a.text, 60)));
    check('e2e/gate D10-D12: all three were alive at the same moment (no slot was lost)', peakOverlap(lastRuns) === 3, { peak: peakOverlap(lastRuns), runs: lastRuns });
    clearInterval(poll);
    const peak = peakOverlap(box.runs());
    check('e2e/gate: never more than 3 worker processes alive', peak === 3 && polledPeak <= 3, { fromTheFakesOwnLog: peak, polled: polledPeak, runs: box.runs().length });
    check('e2e/gate: eleven worker runs in all (D1 and D6 none, D7 two), none of them still alive', box.runs().length === 11 && box.runs().every((r) => !isPidAlive(r.pid)), box.runs().map((r) => r.tag));
  } finally {
    clearInterval(poll);
    await fx.cleanup();
  }
}

async function sectionE2eOutcomes() {
  await calm();
  const box = await claudeSandbox('outcomes', { maxConcurrentDispatches: 3 });
  const { fx, srv } = box;
  try {
    // ONE dispatch_tasks call larger than the limit: it must drain, three at a time. Seven
    // tasks, not more: on a build without the gate they all run together.
    const batch = await srv.callTool('dispatch_tasks', { tasks: Array.from({ length: 7 }, (_, i) => ({ title: `batch-${i}`, prompt: `[[fake:delay:400]] [[tag:batch-${i}]]` })) }, 60_000);
    const batchRuns = box.runs().filter((r) => String(r.tag).startsWith('batch-'));
    check('e2e/gate: one dispatch_tasks batch of seven at limit 3 drains — all seven succeed', batch.isError === false && batch.text.startsWith('7 task(s) dispatched in parallel, 7 succeeded, 0 failed.') && batchRuns.length === 7, clip(batch.text, 160));
    check('e2e/gate: …three at a time', peakOverlap(batchRuns) === 3, `peak ${peakOverlap(batchRuns)}`);

    // A detached dispatch reaches the same core through its supervisor's spec file.
    const detached = await srv.callTool('dispatch_task', { title: ['x'], prompt: '[[fake:ok]] [[tag:detached]]', detach: true }, 60_000);
    await sleep(300);
    check("e2e/args: a wrong-typed title on a DETACHED dispatch is the checker's message too, and nothing runs", detached.isError === true && detached.text === 'Error: invalid title — expected a string, got an array' && !box.runs().some((r) => r.tag === 'detached') && fx.events().every((e) => String(e.title).startsWith('batch-')), { text: detached.text, runs: box.runs().map((r) => r.tag).filter((t) => !String(t).startsWith('batch-')) });

    // 40 MiB on stderr is not a reason to stop a worker: the run succeeds, and only the end
    // of what it logged is held.
    const noisy = await srv.callTool('dispatch_task', { title: 'noisy', prompt: '[[fake:bigerr:40]] [[tag:noisy]]' }, 90_000);
    check('e2e/output: 40 MiB of stderr does not fail a run that then succeeds', noisy.isError === false && noisy.text.includes('FAKE_OK noisy'), clip(noisy.text, 160));

    // A single JSON result larger than the cap is no result either.
    const fat = await srv.callTool('dispatch_task', { title: 'fat', prompt: '[[fake:bigjson:9]] [[tag:fat]]' }, 90_000);
    check(`e2e/output: a 9 MiB JSON result → "${OVERFLOW}"`, fat.isError === true && fat.text === `Error: ${OVERFLOW}` && box.runs().filter((r) => r.tag === 'fat').length === 1, { isError: fat.isError, chars: fat.text.length, head: fat.text.slice(0, 100) });
    // 80 MiB of stdout.
    const big = await srv.callTool('dispatch_task', { title: 'big', prompt: '[[fake:bigout:80]] [[tag:big]]' }, 90_000);
    const bigRuns = box.runs().filter((r) => r.tag === 'big');
    await waitFor(() => bigRuns.length === 1 && !isPidAlive(bigRuns[0].pid), { timeoutMs: 15_000, label: 'the flooding worker to be gone' }).catch(() => undefined);
    const bigRun = box.runs().find((r) => r.tag === 'big');
    check(`e2e/output: 80 MiB of stdout → "${OVERFLOW}"`, big.isError === true && big.text === `Error: ${OVERFLOW}`, { isError: big.isError, chars: big.text.length, head: big.text.slice(0, 120) });
    check('e2e/output: the worker was killed at the cap, not left to finish', bigRuns.length === 1 && !isPidAlive(bigRuns[0].pid) && bigRun?.how === 'SIGTERM' && typeof bigRun.written === 'number' && bigRun.written < 40, bigRun);
    const bigStats = fx.stats();
    // Two errors by now: this one and the 9 MiB JSON result above.
    check('e2e/output: an ordinary failure — one run, its error counted, no cooldown, no failover', Object.values(bigStats).reduce((n, s) => n + (s.errors ?? 0), 0) === 2 && cooled(bigStats).length === 0 && !fx.eventsFor('big').some((e) => /failing over/.test(String(e.error))) && fx.eventsFor('big').at(-1)?.error === OVERFLOW, { stats: bigStats, events: fx.eventsFor('big').map((e) => `${e.status}:${e.error ?? ''}`) });
    const alive = await srv.request('tools/list', undefined, 20_000).then(
      () => true,
      () => false,
    );
    check('e2e/output: the server is alive, and everything it has answered so far is small', alive && srv.stdoutBytes < 2 * 1024 * 1024, { alive, stdoutBytes: srv.stdoutBytes });

    // RO: a report, then a turn a background monitor's expiry started, every line in pieces.
    const report = [`REPORT_BEGIN trickle`, ...Array.from({ length: 40 }, (_, i) => `finding ${i + 1}: the work of trickle is done and verified.`), `REPORT_END trickle`].join('\n');
    const after = '[after a background task finished: The progress monitor has expired; there is nothing to re-arm and the report stands.]';
    const trickle = await srv.callTool('dispatch_task', { title: 'trickle', prompt: '[[fake:turns-trickle]] [[tag:trickle]]' }, 90_000);
    const trickleBody = trickle.text.slice(trickle.text.indexOf('\n\n') + 2);
    check('e2e/turns: a stream of two results written five bytes at a time → the report that answered the prompt, then the background turn marked', trickle.isError === false && trickleBody === `${report}\n\n${after}`, { isError: trickle.isError, body: clip(trickleBody, 200) });
    const trickleDone = fx.eventsFor('trickle').at(-1);
    check('e2e/turns: …its done event sums both turns\' tokens (1030 in, 2040 out) and carries the last result\'s running total ($0.75)', trickleDone?.inputTokens === 1030 && trickleDone?.outputTokens === 2040 && trickleDone?.costUsd === 0.75, trickleDone);
    check('e2e/turns: RO2 — the cost is not the sum of the cumulative totals ($0.50 + $0.75 = $1.25)', typeof trickleDone?.costUsd === 'number' && trickleDone.costUsd !== 1.25, trickleDone);

    // A crash whose stack trace has line number 429.
    const crash = await srv.callTool('dispatch_task', { title: 'crash', prompt: '[[fake:stack429]] [[tag:crash]]' }, 30_000);
    const crashRuns = box.runs().filter((r) => r.tag === 'crash');
    check('e2e/quota: a stack trace with :429:17 fails the dispatch ONCE', crash.isError === true && crash.text.includes('Worker exited with code 1') && crash.text.includes(':429:17') && crashRuns.length === 1, { text: clip(crash.text, 200), runs: crashRuns.length });
    check('e2e/quota: …with no cooldown in stats.json and no failover event', cooled(fx.stats()).length === 0 && !fx.eventsFor('crash').some((e) => /failing over/.test(String(e.error))), { stats: fx.stats(), events: fx.eventsFor('crash').map((e) => e.error) });

    // A real quota text.
    const quota = await srv.callTool('dispatch_task', { title: 'quota', prompt: '[[fake:quota-once:outcomes]] [[tag:quota]]' }, 30_000);
    const quotaRuns = box.runs().filter((r) => r.tag === 'quota');
    check('e2e/quota: a real quota text still cools the account down and fails over', quota.isError === false && quota.text.includes('FAKE_OK quota') && quotaRuns.length === 2 && quotaRuns[0].account !== quotaRuns[1].account && eq(cooled(fx.stats()), [quotaRuns[0].account]) && fx.eventsFor('quota').some((e) => e.error === `quota error on ${quotaRuns[0].account} — failing over`), { text: clip(quota.text, 100), runs: quotaRuns, cooled: cooled(fx.stats()) });
  } finally {
    await fx.cleanup();
  }
}

async function sectionVendor() {
  // A vendor failure whose PARTIAL ANSWER talks about rate limits.
  {
    const fx = H.makeFixture({
      label: 'vpartial',
      workspace: 'git',
      workers: [{ name: 'wa' }, { name: 'q1', provider: 'codex' }, { name: 'q2', provider: 'codex' }],
      scenario: {
        codex: {
          run: {
            sequence: [
              {
                kind: 'error',
                message: 'The requested model is not available for this account',
                partialText: 'I wrote the client. It retries when the API answers HTTP 429 Too Many Requests and backs off at the rate limit; the quota is read from the response.',
              },
              'ok',
            ],
          },
        },
      },
    });
    try {
      const srv = await fx.startServer();
      const r = await srv.callTool('dispatch_task', { title: 'vpartial', prompt: 'write a rate-limited client', provider: 'codex' }, 90_000);
      const stats = fx.stats();
      check("vendor/quota: a worker's partial answer about rate limits is not the vendor's verdict — one run, an ordinary failure", r.isError === true && fx.runs('codex').length === 1 && /reported an error/.test(r.text) && !/quota or rate limit reached/.test(r.text), { text: clip(r.text, 220), runs: fx.runs('codex').length });
      check('vendor/quota: …no cooldown, no failover', cooled(stats).length === 0 && !fx.eventsFor('vpartial').some((e) => /failing over/.test(String(e.error))), { stats, events: fx.eventsFor('vpartial').map((e) => e.error) });
    } finally {
      await fx.cleanup();
    }
  }
  // The vendor's own quota wall still fails over.
  {
    const fx = H.makeFixture({
      label: 'vquota',
      workspace: 'git',
      workers: [{ name: 'wa' }, { name: 'q1', provider: 'codex' }, { name: 'q2', provider: 'codex' }],
      scenario: { codex: { run: { sequence: ['quota', 'ok'] } } },
    });
    try {
      const srv = await fx.startServer();
      const r = await srv.callTool('dispatch_task', { title: 'vquota', prompt: 'anything', provider: 'codex' }, 90_000);
      check("vendor/quota: the vendor's own quota wall still cools the account down and fails over", r.isError === false && fx.runs('codex').length === 2 && cooled(fx.stats()).length === 1, { text: clip(r.text, 160), runs: fx.runs('codex').length, cooled: cooled(fx.stats()) });
    } finally {
      await fx.cleanup();
    }
  }
  // The vendor path's process seam, driven through runProviderWorker with a limit of seconds:
  // a fake vendor CLI that finishes (after 500 ms) while its dispatcher is stopped.
  {
    const fx = H.makeFixture({ label: 'vstop', workspace: 'git', workers: [{ name: 'wa' }, { name: 'cx', provider: 'codex' }] });
    try {
      fx.assertHermetic();
      const vendorEnv = fx.env({ RUNNER_FAKE: FAKE, RUNNER_FAKE_LOG: path.join(fx.root, 'unused-fake.log'), RUNNER_VENDOR_DIR: fx.worker('cx').configDir });
      const inSandbox = (stop) => ({ env: vendorEnv, cwd: fx.workspace, ...(stop ? { stop } : {}) });
      /** Stop from the moment the next Codex run starts until it has exited and `forMs` passed. */
      const stopAcrossNextRun = (forMs) => {
        const before = fx.runs('codex').length;
        return {
          when: () => fx.runs('codex').length > before,
          exited: () => fx.runs('codex')[before]?.exitCode !== undefined,
          forMs,
        };
      };
      fx.setScenario({ codex: { run: { kind: 'slow', ms: 500 } } });
      const late = await runCore('stop-vendor', 60_000, inSandbox(stopAcrossNextRun(2600)));
      check('vendor/limit: a vendor CLI that finished while its dispatcher was STOPPED past the limit is a success, not a timeout', late.stoppedMs >= 2600 && late.result.ok === true && String(late.result.text).startsWith('FAKE_CODEX_OK'), { stoppedMs: late.stoppedMs, ...late.result });

      fx.setScenario({ codex: { run: { kind: 'slow', ms: 500 } } });
      const cancelled = await runCore('stop-vendor-cancel', 60_000, inSandbox(stopAcrossNextRun(1400)));
      check('vendor/cancel: a cancel that is handled after the vendor CLI had exited 0 does not undo the run either', cancelled.stoppedMs >= 1400 && cancelled.result.ok === true && String(cancelled.result.text).startsWith('FAKE_CODEX_OK'), { stoppedMs: cancelled.stoppedMs, ...cancelled.result });

      fx.setScenario({ codex: { run: { kind: 'slow', ms: 500 } } });
      const both = await runCore('stop-vendor-both', 60_000, inSandbox(stopAcrossNextRun(1400)));
      check('vendor/limit: …nor do the limit AND a cancel, both due while it was stopped — two stops asked for in one turn', both.stoppedMs >= 1400 && both.result.ok === true && String(both.result.text).startsWith('FAKE_CODEX_OK'), { stoppedMs: both.stoppedMs, ...both.result });

      fx.setScenario({ codex: { run: 'hang' } });
      const twice = await runCore('vendor-cancel-twice', 60_000, inSandbox());
      check('vendor/cancel: a run cancelled twice in a row is still stopped, and reported as cancelled', twice.result.ok === false && twice.result.name === 'ProviderCancelledError' && !isPidAlive(twice.result.pid) && twice.result.ms < 10_000, twice.result);

      fx.setScenario({ codex: { run: 'hang' } });
      const hung = await runCore('vendor-limit', 60_000, inSandbox());
      check('vendor/limit: a vendor CLI still running at its limit is killed and reported as timed out', hung.result.ok === false && hung.result.name === 'ProviderTimeoutError' && !isPidAlive(hung.result.pid) && hung.result.ms < 10_000, hung.result);

      fx.setScenario({ codex: { run: 'hang' } });
      const live = await runCore('vendor-cancel-live', 60_000, inSandbox());
      check('vendor/cancel: a vendor CLI still running when its run is cancelled is killed and reported as cancelled', live.result.ok === false && live.result.name === 'ProviderCancelledError' && !isPidAlive(live.result.pid) && live.result.ms < 10_000, live.result);
    } finally {
      await fx.cleanup();
    }
  }
  // A login failure proved by a run.
  {
    const fx = H.makeFixture({
      label: 'vlogin',
      workspace: 'git',
      workers: [{ name: 'wa' }, { name: 'c1', provider: 'codex' }],
      scenario: { codex: { run: 'auth' } },
    });
    try {
      const srv = await fx.startServer();
      const dir = fx.worker('c1').configDir;
      const reading = () => fx.usage()[dir];

      const failed = await srv.callTool('dispatch_task', { title: 'vlogin-1', prompt: 'anything', worker: 'c1' }, 90_000);
      check('vendor/login: a run that fails on login is filed as logged out WITH the run mark', failed.isError === true && /not logged in/.test(failed.text) && reading()?.auth?.loggedIn === false && reading()?.auth?.fromRun === true && typeof reading()?.auth?.fromRunAt === 'number', { text: clip(failed.text, 160), auth: reading()?.auth });

      // An ordinary status reading — what a refresh files — says "logged in".
      const status = spawnSync(
        process.execPath,
        ['-e', `require(${JSON.stringify(CORE_CJS)}).recordProviderStatus(${JSON.stringify({ name: 'c1', configDir: dir })},{cliFound:true,loggedIn:true,mode:null,quota:null,error:null})`],
        { env: fx.env(), encoding: 'utf8' },
      );
      check('vendor/login: a later ordinary status reading "logged in" does not clear it', status.status === 0 && reading()?.auth?.loggedIn === false && reading()?.auth?.fromRun === true, { exit: status.status, stderr: clip(status.stderr ?? '', 200), auth: reading()?.auth });

      // An automatic dispatch must not start the account again on the status command's word.
      fx.setScenario({ codex: { run: 'ok' } });
      const invocationsBefore = fx.invocations('codex').length;
      const auto = await srv.callTool('dispatch_task', { title: 'vlogin-2', prompt: 'anything', provider: 'codex' }, 90_000);
      check('vendor/login: an automatic dispatch does not re-check that verdict with the status command, and starts nothing', auto.isError === true && fx.runs('codex').length === 1 && fx.invocations('codex').length === invocationsBefore, { text: clip(auto.text, 400), runs: fx.runs('codex').length, invocations: fx.invocations('codex').length - invocationsBefore });
      check('vendor/login: …and its refusal says why and names both ways out', /last run on c1 failed because the account was not logged in/.test(auto.text) && /Re-login Account/.test(auto.text) && /name the worker explicitly/.test(auto.text), auto.text);
      check('vendor/login: …and the verdict is still on file', reading()?.auth?.loggedIn === false && reading()?.auth?.fromRun === true, reading()?.auth);

      // Naming the worker tries it once; the run that works is what clears the verdict.
      const named = await srv.callTool('dispatch_task', { title: 'vlogin-3', prompt: 'anything', worker: 'c1' }, 90_000);
      check('vendor/login: naming the worker runs it, and the successful run clears the verdict', named.isError === false && fx.runs('codex').length === 2 && reading()?.auth?.loggedIn === true && reading()?.auth?.fromRun === undefined, { text: clip(named.text, 160), runs: fx.runs('codex').length, auth: reading()?.auth });
    } finally {
      await fx.cleanup();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

/** SIGKILL whatever still names the scratch directory on its command line. */
function killStrays() {
  const res = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', env: { PATH: SYSTEM_PATH.join(':'), LC_ALL: 'C' } });
  let killed = 0;
  for (const line of String(res.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && m[2].includes(BASE)) {
      try {
        process.kill(Number(m[1]), 'SIGKILL');
        killed++;
      } catch {
        // gone already
      }
    }
  }
  return killed;
}

async function cleanup() {
  try {
    if (H !== undefined) {
      await H.cleanupAll();
      await H.settleStrays({ timeoutMs: 4000 });
    }
  } catch {
    // best effort
  }
  killStrays();
  if (!KEEP) {
    fs.rmSync(BASE, { recursive: true, force: true });
  }
}

async function main() {
  if (path.resolve(os.homedir()) === path.resolve(REAL_HOME)) {
    throw new Error('REFUSING TO RUN: HOME was not redirected');
  }
  console.log(`runner fixes — sources: ${SOURCES ?? 'current tree'}; scratch: ${BASE}`);
  await build();
  const core = createRequire(import.meta.url)(CORE_CJS);
  const sections = [
    ['quota', async () => sectionQuota(core)],
    ['streams', async () => sectionStreams(core)],
    ['gate', async () => sectionGate(core)],
    ['core', async () => sectionCore(core)],
    [
      'e2e',
      async () => {
        await buildServer();
        H ??= await import(pathToFileURL(path.join(REPO, '.orchestrator', 'providers', 'helpers.mjs')).href);
        await sectionE2eArguments(core);
        await sectionE2eOutcomes();
        await sectionE2eGate();
      },
    ],
    [
      'vendor',
      async () => {
        await buildServer();
        H ??= await import(pathToFileURL(path.join(REPO, '.orchestrator', 'providers', 'helpers.mjs')).href);
        await sectionVendor();
      },
    ],
  ];
  for (const [name, run] of sections) {
    if (ONLY !== undefined && !ONLY.has(name)) continue;
    console.log(`\n== ${name}`);
    try {
      await run();
    } catch (err) {
      check(`${name}: the section ran to its end`, false, err && err.stack ? err.stack : String(err));
    }
  }
}

let exitCode = 1;
process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});
main()
  .then(() => {
    exitCode = failures.length === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.log(`FAIL runner — ${err && err.stack ? err.stack : err}`);
    failures.push('runner');
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failures.length} failed${failures.length > 0 ? `:\n  - ${failures.join('\n  - ')}` : ''}`);
    process.exit(exitCode);
  });
