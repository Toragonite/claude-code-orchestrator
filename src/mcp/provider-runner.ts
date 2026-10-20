import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Account,
  Adapter,
  LineStreamFn,
  QuotaSnapshot,
  RunResult as AdapterRunResult,
  RunTask,
  SpawnRequest,
  StreamEndMeta,
} from '@toragonite/agent-mesh';
import * as codexPackage from '@toragonite/agent-mesh-codex';
import { CodexAdapter, type ExecFn } from '@toragonite/agent-mesh-codex';
import { CursorAdapter } from '@toragonite/agent-mesh-cursor';
import { fetchLiveModels, GeminiAdapter } from '@toragonite/agent-mesh-gemini';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { REPORTED_MODEL_ID, vendorChildEnv } from '../platform';
import { WORKER_BASE_PROMPT } from '../prompts';
import { DISPATCHED_TASK_ENV } from './host-protocol';
import {
  adapterAccountDir,
  isOwnModelFamily,
  normalizeProviderModel,
  normalizeProviderPermissionMode,
  parseProvider,
  providerInfo,
  type ProviderId,
  type ProviderInfo,
  type ProviderStatus,
} from '../providers';
import { isSpawnableFile, resolveViaLoginShell, type WorkerProfile } from '../registry';
import { NORMAL_KILL_LADDER, type KillLadder, type TurnLineStreamOptions } from '../team/contract';

/**
 * provider-runner — one task on a worker that is NOT Claude Code: Codex (`codex exec`), Cursor
 * (`cursor-agent -p`) or Antigravity (`agy -p`).
 *
 * WHO OWNS WHAT. The vendor adapters (`@toragonite/agent-mesh-*`) own everything vendor-specific
 * and are verified on their own: the argv each CLI takes, how its output is parsed, which model
 * ids exist, how a login is read. This module never spells an argument of one of those CLIs and
 * never parses a byte of their output. What it owns is everything the adapters are deliberately
 * handed through their seams — WHICH binary runs, in WHAT environment, and above all the PROCESS:
 * each adapter is constructed with this module's own `exec`, so a vendor child is spawned, timed,
 * capped and killed by the same rules a `claude -p` child is, and the dispatch core can reach it.
 *
 * Why not the adapters' own spawner: it settles on the child's 'close' event (a grandchild that
 * inherits a pipe then holds a finished run open), it buffers output without limit, and nothing
 * outside it can kill what it started — so a cancelled request or a server going down would leave
 * a vendor agent running, and billing, with nobody able to stop it.
 *
 * It is also the ONLY module, with its sibling entry point provider-cli.ts, that imports the
 * adapters. Both are reachable only from esbuild bundles; the extension host is plain tsc output
 * with no node_modules beside it, so nothing it loads may import this file.
 *
 * Nothing here logs, returns or stores a credential, and an adapter's `raw` payload is never
 * read: what leaves this module is the final text, counts, an id, and flattened notes.
 *
 * Must not import 'vscode'.
 */

/* ------------------------------------------------------------------------- *
 * Tunables
 * ------------------------------------------------------------------------- */

/** Most of a child's STDOUT that is kept. The rest is dropped. */
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
/**
 * How much of that cap is spent on the START of the stream; the remainder keeps its END. A vendor
 * CLI names the conversation in its first event and gives its answer in its last, so when its
 * stdout outgrows the cap it is the MIDDLE that is dropped — keeping only the head would turn a
 * run that finished into one "without a final answer".
 */
const OUTPUT_HEAD_BYTES = 1024 * 1024;
/**
 * Most of a child's STDERR that is kept: its END, and nothing else. Diagnostics are read from
 * the last thing a CLI said, never from the middle of what it logged on the way, so there is
 * nothing in a long stderr worth megabytes of memory per running worker. The same number for a
 * `claude -p` child (task-runner imports it) and for another vendor's.
 */
export const STDERR_TAIL_BYTES = 256 * 1024;
/** SIGTERM → SIGKILL grace for a child that was told to stop (timeout, cancel, shutdown). */
const KILL_GRACE_MS = 5_000;
/**
 * After 'exit', how long 'close' is waited for before settling anyway. 'exit' means the process
 * is gone; anything still in the pipe arrives within milliseconds. A grandchild that inherited
 * the pipe would keep 'close' from ever firing — this is what turns that hang into a settle.
 */
const DRAIN_GRACE_MS = 250;
/** Last resort after SIGKILL: settle even without an 'exit', so a dispatch always returns. */
const REAP_GRACE_MS = 5_000;
/** Budget of the login check that follows a FAILED run (see confirmLoggedOut). */
const AUTH_CONFIRM_TIMEOUT_MS = 5_000;
/** Longest wait for the Codex CLI's own answer about its login (see codexLoginStatus). */
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 10_000;
/**
 * Default budget of one providerStatus() reading: the login check and the usage read together.
 * Exported for the bundled helper, whose `status` command has this as its whole budget.
 */
export const STATUS_TIMEOUT_DEFAULT_MS = 20_000;
/** How long a FAILED lookup of a provider CLI is trusted before the login shell is asked again. */
const CLI_RESOLVE_RETRY_MS = 60_000;
/**
 * Budget of one providerModels() answer, and the most a caller may ask for. Exported for the
 * bundled helper, whose `models` command has this as its default budget.
 */
export const MODELS_TIMEOUT_MS = 25_000;
/**
 * How much of that budget is kept back from the vendor CLI: a CLI that never answers is given up
 * on this long before the budget ends, so the built-in catalog is still printed inside it. (A
 * fifth of a shorter budget.)
 */
const MODELS_ANSWER_MARGIN_MS = 5_000;
/**
 * Most models one catalog lists. Sized to what a CLI really lists, with room: `cursor-agent
 * models` printed 259 on the day this was measured (17 of its own, 242 resold), and a smaller
 * cap had been dropping the last of them without a word.
 *
 * It is also what bounds the one line of JSON the helper prints. An entry is at most its id
 * (MODEL_ID_MAX_CHARS characters, all ASCII by the model rule: 128 bytes), its label
 * (MODEL_LABEL_MAX_CHARS UTF-16 units, at most 3 bytes each as UTF-8: 240 bytes) and about 35
 * bytes of JSON around them — some 403 bytes — so 600 of them stay under 242 kB. On top of that:
 * one `"default":true` (15 bytes), and the efforts of at most EFFORT_ENTRIES_MAX entries, each
 * at most `,"efforts":[` + EFFORTS_PER_MODEL_MAX quoted words of EFFORT_MAX_CHARS + `]` — 127
 * bytes, 8.2 kB for all of them. Some 250 kB, inside the 256 KiB the line may be. Raising any of
 * these numbers has to keep that sum under the budget.
 */
const MODELS_MAX = 600;
/** How many entries of a listing are looked at to find them. */
const MODELS_SCAN_MAX = 10_000;
/** Longest model id and longest label in a catalog, in UTF-16 code units. */
const MODEL_ID_MAX_CHARS = 128;
const MODEL_LABEL_MAX_CHARS = 80;
/**
 * Reasoning efforts kept for a model, the longest one, and how many entries of a catalog carry
 * them (MODELS_MAX says why all three are bounded). A real Codex answer lists five of at most six
 * letters, on seven models.
 */
const EFFORTS_PER_MODEL_MAX = 6;
const EFFORT_MAX_CHARS = 16;
const EFFORT_ENTRIES_MAX = 64;
const EFFORT_WORD = /^[a-z][a-z0-9_-]{0,15}$/;

/** Longest failure message composed here, in UTF-16 code units — a one-line label, like the reaper's. */
const FAILURE_LABEL_MAX_CHARS = 200;
/**
 * Room a login-failure label always keeps for the vendor's own words, after OUR sentence. That
 * sentence carries the account's login command, and a command that spells out a home directory
 * can be most of FAILURE_LABEL_MAX_CHARS by itself — the vendor's text must not vanish for it.
 */
const LOGIN_LABEL_VENDOR_ROOM_CHARS = 160;
/** Says a label was cut and where the rest is; the dispatch core appends it to the output file. */
const FAILURE_LABEL_ELLIPSIS = ' …[truncated; full text in the output file]';
/** Most vendor text one failure carries along as evidence. */
const FAILURE_DETAIL_MAX_CHARS = 64 * 1024;
/** Longest adapter note passed on (contract: ≤ 300). */
const NOTE_MAX_CHARS = 300;
/** Longest model id / conversation id passed on. Both end up on a header line. */
const ID_MAX_CHARS = 200;

/* ------------------------------------------------------------------------- *
 * Classification
 * ------------------------------------------------------------------------- */

/* ---- a quota wall, read from a failure's own words ---- */

/*
 * WHAT A QUOTA VERDICT COSTS, AND WHY THIS CLASSIFIER PREFERS TO MISS.
 *
 * A "yes" here puts the account on a cooldown (30 minutes by default) and runs the task again on
 * the next one. A wrong "yes" therefore runs the task once per account and takes every one of
 * them out of automatic assignment; a wrong "no" ends the dispatch with the failure's own text,
 * and somebody dispatches again. So every rule below is written to be PRECISE first — while the
 * sentences an account's own CLI uses for a plan limit ("5-hour limit reached", "You've hit your
 * limit", "usage limit reached") must keep matching, because that is the event failover is for.
 *
 * Precision was missing in two places. THE DIGITS: the status codes of a rate limit (429) and of
 * an overloaded service (529) are also a line number, a column, a byte count, a port, part of a
 * request id — and a bare `429` anywhere in a failure used to be a quota verdict, so
 * `cli.js:429:17` in a crash cooled every account down and ran the task on each of them. THE
 * WORDS: `quota`, `rate limit` and `limit exceeded` are also what programmers call their files,
 * functions and URLs, and what a tool says about a context window or a retry budget — none of
 * which is an account running out of anything.
 *
 * THE STEPS.
 *  1. CODE LOCATIONS ARE REMOVED before anything is searched for (withoutCodeLocations): the
 *     frames of a stack trace, whatever runtime printed them, and the `:<line>:<col>` suffix of
 *     a position wherever else one stands. A frame goes entirely, not only its digits, because
 *     its function and file names are somebody's identifiers — `at checkQuota
 *     (…/quota.js:10:2)` says nothing about an account.
 *  2. THE DIGITS count only where they are stated AS A STATUS (statesQuotaStatus): directly
 *     after a word that introduces one, as a whole number, and not as the head of a count.
 *  3. NAMES ARE REMOVED (withoutNames) — paths, URLs, bare file names, an identifier a tool
 *     quotes — and only then
 *  4. THE WORDS are searched (statesQuotaInWords), and a limit that is "reached" or "exceeded"
 *     counts only when it is not named as something other than an account's allowance.
 *
 * WHAT IT IS HANDED is the caller's half of the precision: only the text a CLI or a vendor gave
 * as its FAILURE — never a worker's answer, and never a partial one (see failRun).
 */

/** Most of a failure text that is searched. A quota wall is said at once, not after 64 KiB. */
const QUOTA_SCAN_MAX_CHARS = 64 * 1024;

/**
 * One frame of a JavaScript stack trace, as a line of its own: `at …` ending in a
 * `:<line>:<col>` position (with the bracket that closes it, when there is one) or in
 * `(<anonymous>)` / `(native)`. The `at <path>:<line>:<col>` lines of a Rust backtrace have the
 * same shape. What may still follow is only what closes a JSON string the trace was quoted in.
 * Lower-case `at`, as every runtime that prints this shape writes it.
 */
const STACK_FRAME_LINE = /^\s*at\s.*(?::\d+:\d+\)?|\(<anonymous>\)|\(native\))["'}\],;\s]*$/;
/**
 * One frame of a Java, Kotlin or .NET stack trace: `at` and a dotted name with its bracket
 * directly behind it — `at pkg.Class.method(File.java:42)`, `(Native Method)`, `at
 * Ns.Class.Method(String s) in C:\src\File.cs:line 42`. The dot is required: it is what a
 * sentence that merely begins with "at" does not have before a bracket.
 */
const DOTTED_FRAME_LINE = /^\s*at\s+[\w$<>]+(?:[./][\w$<>`+-]+)+\s?\([^()]*\)(?:\s+in\s+\S.*)?["'}\],;\s]*$/;
/** The location line of a Python traceback: `File "<path>", line <n>[, in <function>]`. */
const PYTHON_FRAME_LINE = /^\s*File ".*", line \d+(?:, in .*)?\s*$/;
/** What follows that line: the source line it points at (indented), and the carets under it. */
const PYTHON_SOURCE_LINE = /^(?:\s+\S.*|[\s~^]+)$/;
/** One numbered frame of a Rust backtrace: `  3: codex::quota::check` (a `::` path is required). */
const RUST_FRAME_LINE = /^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?\S*::\S.*$/;
/** What opens one goroutine of a Go dump; everything up to the next blank line is its frames. */
const GO_DUMP_HEADER = /^goroutine \d+ \[[^\]]*\]:\s*$/;
/**
 * One line of a test runner's report — Rust's `test <name> ... ok`, TAP's `ok 12 - <name>`, Go's
 * `=== RUN <Name>` and `--- FAIL: <Name>`. What stands beside the marker is the NAME somebody gave
 * a test, and a suite that tests rate limiting names its tests after it; no CLI states a refusal
 * in one of these shapes. A check mark or a cross in front of a line is deliberately NOT one of
 * them: that is also how a CLI prints its own error (`✗ Rate limit reached`).
 */
const TEST_REPORT_LINE =
  /^\s*(?:test .+ \.\.\. (?:ok|FAILED|failed|ignored)|(?:not )?ok \d+ (?:- )?.*|--- (?:PASS|FAIL|SKIP): .*|=== RUN\s.*)\s*$/;
/** A line break as a CLI prints it. */
const REAL_LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
/**
 * A line break as it stands inside a JSON string — the two characters `\` `n` — which is how a
 * CLI that logs JSON prints a stack trace on ONE line. Not after another backslash: `\\n` is an
 * escaped backslash followed by the letter n, which is what a Windows path looks like in JSON
 * (`C:\\x\\node_modules`).
 */
const ESCAPED_LINE_BREAK = /(?<!\\)\\r\\n|(?<!\\)\\n/;
/** A tab as it stands inside a JSON string, by the same rule. A quoted Java frame begins with one. */
const ESCAPED_TAB = /(?<!\\)\\t/g;
/** The other escapes of a JSON string that hide what a text says: `\"` `\'` `\\` `\/`. */
const ESCAPED_MARK = /\\(["'\\/])/g;
/** The `:<line>:<col>` of a file position that is not on a frame line of its own. */
const POSITION_SUFFIX = /:\d+:\d+/g;

/**
 * `lines` without the ones that are stack frames, in any of the shapes above, or a test runner's
 * report of one test. Two of the frames are more than one line each: a Python frame is followed
 * by the source line it points at, and a Go dump runs from its `goroutine` header to the next
 * blank line.
 */
function withoutFrameLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let inGoDump = false;
  let afterPythonFrame = false;
  for (const line of lines) {
    if (inGoDump) {
      if (line.trim() !== '') {
        continue;
      }
      inGoDump = false;
    }
    const wasAfterPythonFrame = afterPythonFrame;
    afterPythonFrame = false;
    if (GO_DUMP_HEADER.test(line)) {
      inGoDump = true;
      continue;
    }
    if (PYTHON_FRAME_LINE.test(line)) {
      afterPythonFrame = true;
      continue;
    }
    if (wasAfterPythonFrame && PYTHON_SOURCE_LINE.test(line)) {
      // The carets of a newer Python follow the source line, and belong to the same frame.
      afterPythonFrame = true;
      continue;
    }
    if (STACK_FRAME_LINE.test(line) || DOTTED_FRAME_LINE.test(line) || RUST_FRAME_LINE.test(line)) {
      continue;
    }
    if (TEST_REPORT_LINE.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/**
 * `text` with its code locations taken out: stack-frame lines first — real lines, then the lines
 * of a trace that was printed JSON-escaped on one — and then every remaining `:<line>:<col>`.
 * The JSON escapes of quotes and slashes are undone on the way, so that a body quoted inside
 * another (`\"code\": 429`) reads as the body it is. What comes back is searched, never shown,
 * so the pieces are simply put back one per line.
 */
function withoutCodeLocations(text: string): string {
  const kept: string[] = [];
  for (const line of withoutFrameLines(text.split(REAL_LINE_BREAK))) {
    kept.push(...withoutFrameLines(line.split(ESCAPED_LINE_BREAK).map((piece) => piece.replace(ESCAPED_TAB, '\t'))));
  }
  return kept.join('\n').replace(ESCAPED_MARK, '$1').replace(POSITION_SUFFIX, '');
}

/**
 * 429 / 529 STATED AS A STATUS: the number directly after a word that introduces one.
 *
 *  - THE WORD. `status`, `code`, `error` or `http` (with its version: `HTTP/1.1 429`), alone or
 *    in the compounds an API and its client libraries write — "status code", "API error",
 *    `statusCode`, `http_status`, `HTTPError`, "response code" — and `with` / `returned`, for
 *    "failed with 429" and "returned 429". It must START where a word starts: `KeyError: 429` is
 *    Python reporting a missing key, and `barcode 429` is nobody's status.
 *  - BETWEEN the word and the number: nothing but spaces and the marks a status is introduced
 *    with — `:` `=` `#` `(` — on the same line, after the quote that closes the word when it is
 *    a key of a JSON body (`"code": 429`). Not a path separator, a hyphen or an underscore:
 *    `/tmp/error/429.json` and `error_429.html` are file names.
 *  - THE NUMBER is whole (`4290` and `1429f0` are not it) and is not the start of something
 *    longer: a position (`429:17`), a decimal (`429.5`), a grouped figure (`429,000`).
 *
 * Every repetition is bounded (three words before the last, six marks between), so the search is
 * linear in the text whatever the text is.
 */
const STATUS_CONTEXT =
  /(?<![a-z0-9])(?:(?:(?:api|https?|status|error|response)[ \t_-]?){0,3}(?:http(?:\/\d+(?:\.\d+)?)?|status|code|error)["']?|with|returned)[ \t:=#(]{0,6}\b(?:429|529)(?![a-z0-9_]|[:.,]\d)/gi;

/**
 * What stands after a number that is a COUNT, not a status: a percent sign, a unit of size, or —
 * after a space — a word in lower case, which is the thing being counted ("429 files", "529
 * errors", "429 bytes"). A status is followed by the end of the text, punctuation, a body, or a
 * reason phrase, which is capitalised; the few lower-case words that do follow one are named.
 * Their plurals are not among them: "with 429 error" is a status, "with 429 errors" a count.
 * Case-sensitive, which is why this is not part of STATUS_CONTEXT.
 */
const COUNT_FOLLOWS =
  /^(?:[ \t]*%|[ \t]+(?:[kKMGT]i?B|B)\b|[ \t]+(?!(?:status|error|response|code|from|for|on|when|while|after)\b)[a-z])/;

/** Whether `text` (code locations already removed) states 429 or 529 as a status. */
function statesQuotaStatus(text: string): boolean {
  for (const match of text.matchAll(STATUS_CONTEXT)) {
    const end = (match.index ?? 0) + match[0].length;
    if (!COUNT_FOLLOWS.test(text.slice(end, end + 32))) {
      return true;
    }
  }
  return false;
}

/**
 * An identifier a TOOL is quoting: one token between single quotes or backticks — no white
 * space inside, at most 64 characters — as in "Cannot find name 'quotaExceeded'", "'ratelimit'
 * is not a git command", "`max_tokens`". It is somebody's name for a thing, and the words in it
 * say nothing about an account. The quote must open where a word could begin and close where
 * one could end, so an apostrophe ("You've", "workers'") is never one. Double quotes have a
 * rule of their own, below: that is also where a JSON error body keeps its codes. A quoted run
 * with white space in it is left alone in either kind of quote — the message of an error body
 * printed as a Python dict is one.
 */
const QUOTED_TOKEN = /(?<![A-Za-z0-9])(['`])[^'`\s]{1,64}\1(?![A-Za-z0-9])/g;
/**
 * The same, in DOUBLE quotes — `Unknown field "quota" in settings.json` is a tool naming a key
 * it did not expect. But double quotes are also where a JSON body keeps its keys and its codes
 * (`{"error":{"code":"rate_limit_exceeded"}}`), so this one is removed only when it is NOT in
 * such a position (withoutQuotedWords decides).
 */
const DOUBLE_QUOTED_TOKEN = /(?<![A-Za-z0-9])"[^"\s]{1,64}"(?![A-Za-z0-9])/g;

/**
 * `text` without the double-quoted single tokens that are a tool quoting a name. A token stays
 * when it is a KEY or a VALUE of a JSON body: inside braces, with the punctuation of JSON on both
 * sides of it — `{` `[` `,` `:` before, `:` `,` `}` `]` after, or the end of the text (a body cut
 * short by a size cap is still a body). Everything else in double quotes that is one token goes
 * — `Unknown field "quota"`, `expected ["quota"] to equal []`, `error: "quota": not allowed`,
 * none of which is inside braces — and a quoted run with white space in it is a sentence and
 * was never a candidate. The depth is counted as the text is walked, so the whole is one pass; it
 * is a count of braces and not a parser, so a `}` inside a message can end the body early, and
 * what is lost then is one code that nothing else in the text repeats.
 */
function withoutQuotedWords(text: string): string {
  let depth = 0;
  let walked = 0;
  return text.replace(DOUBLE_QUOTED_TOKEN, (token: string, at: number) => {
    for (let i = walked; i < at; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x7b) {
        depth++;
      } else if (c === 0x7d && depth > 0) {
        depth--;
      }
    }
    walked = at + token.length;
    if (depth > 0) {
      // 64 characters either way: a pretty-printed body puts a line break and its indentation
      // between a value and the brace that closes it.
      const before = text.slice(Math.max(0, at - 64), at).trimEnd().slice(-1);
      const after = text.slice(walked, walked + 64).trimStart().charAt(0);
      // An empty `after` is the end of the text.
      if (before !== '' && '{[,:'.includes(before) && (after === '' || ':,}]'.includes(after))) {
        return token;
      }
    }
    return ' ';
  });
}
/**
 * A run of text between spaces and the marks that close a value — quotes, a comma, a semicolon,
 * `|`, `<`, `>`, `=`. Bounded by those marks, and not by spaces alone, because a JSON body is
 * often printed without a single space: taken whole, one URL inside it would remove the body.
 */
const TEXT_RUN = /[^\s"'`,;|<>=]+/g;
/**
 * A bare file name: a name, a dot and an extension a file of source, configuration or text
 * carries — with the brackets and punctuation that may surround it, and a `:<line>` or
 * `(<line>` behind it. The list is deliberately long; a top-level domain (`.com`, `.io`) is not
 * in it, and neither is anything a sentence ends with.
 */
const FILE_NAME_RUN = new RegExp(
  String.raw`^[(\[{]*[\w$@~+-][\w$@~+.-]*\.(?:` +
    [
      'js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyi|pyc|rb|go|rs|java|kt|kts|scala|groovy|swift|c|h|cc|cpp|cxx|hpp|hh',
      'cs|fs|vb|php|pl|pm|sh|bash|zsh|ps1|bat|cmd|lua|dart|ex|exs|erl|clj|cljs|hs|ml|jl|sql',
      'json|jsonl|json5|yaml|yml|toml|ini|cfg|conf|env|xml|html|htm|css|scss|sass|less|md|mdx|txt|log|lock|map',
      'wasm|vue|svelte|exe|dll|so|dylib|jar|class',
    ].join('|') +
    String.raw`)(?:[:(]\d[\w:()\]]*)?[)\]}.:!?]*$`,
  'i',
);

/**
 * What a LIMIT is not, when it is one of these: an account's allowance. "context limit
 * exceeded", "output token limit exceeded", "maximum turn limit reached", "retry limit exceeded",
 * "time limit exceeded" are a tool describing its own budget for one request or one run — the
 * same on every account, so a second account would say it again. Singular forms; a plural is
 * read as its singular (singularOf).
 */
const NOT_AN_ALLOWANCE = new Set([
  'context',
  'token',
  'output',
  'input',
  'turn',
  'retry',
  'time',
  'timeout',
  'size',
  'length',
  'depth',
  'recursion',
  'memory',
  'stack',
  'file',
  'line',
  'character',
  'iteration',
  'step',
  'tool',
]);
/**
 * What a limit IS, when one of these names it: an account's allowance — whose it is (account,
 * organization, plan, tier), what it is counted in (requests, credits, spend), or how often it
 * renews. One of them beside a word of NOT_AN_ALLOWANCE wins: "monthly token limit reached" and
 * "daily output token limit exceeded" are an account out of its tokens for the month or the day,
 * where "output token limit exceeded" is one answer that grew too long.
 */
const AN_ALLOWANCE = new Set([
  'usage',
  'rate',
  'plan',
  'quota',
  'daily',
  'weekly',
  'monthly',
  'hourly',
  'yearly',
  'annual',
  'session',
  'spend',
  'spending',
  'billing',
  'credit',
  'request',
  'account',
  'organization',
  'org',
  'tier',
]);
/**
 * A unit of time, which names an allowance's window — "5-hour token limit", "tokens per minute
 * limit" — except beside `time` and `timeout`, where it is how long the limit is ("2 hour time
 * limit exceeded" is a run that took too long).
 */
const A_PERIOD = new Set(['second', 'minute', 'hour', 'day', 'week', 'month', 'year']);
/**
 * What a RATE is, when one of these stands directly before it: a property of a signal or of a
 * measurement — "the sampling rate limits the resolution", "frame rate limit", "bit rate limit
 * exceeded". Not one of them is ever in front of the rate limit an API refuses a request with.
 */
const NOT_A_REQUEST_RATE = new Set([
  'sampling',
  'sample',
  'frame',
  'bit',
  'baud',
  'heart',
  'learning',
  'playback',
  'symbol',
  'clock',
  'tick',
]);
/** Where the clause a limit is named in begins: the last of these before it. */
const CLAUSE_BREAK = /[.!?;|·∙()[\]{}"\n]/;
/**
 * Where the PHRASE that names it begins. Narrower than the clause: what stands before a colon
 * is a label ("session ab12: context limit exceeded"), and what stands before a comma is another
 * thought — neither is part of the limit's name, so neither may vouch for it.
 */
const PHRASE_BREAK = /[.!?;|·∙()[\]{}"\n:,]/;

/** `word` (lower case) in the singular, as far as these lists need it: tokens, retries, credits. */
function singularOf(word: string): string {
  if (word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * The words that stand before index `at`, back to the last `breakAt`, oldest first: lower case,
 * singular, a camelCase or snake_case name read by its parts (`maxTurnsLimit`, `max_tokens`),
 * single letters dropped (the `s` of "organization's").
 */
function wordsBefore(text: string, at: number, breakAt: RegExp): string[] {
  const span = text.slice(Math.max(0, at - 96), at).split(breakAt).pop() ?? '';
  return (span.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]{2,}/g) ?? []).map(singularOf);
}

/** The words a slash between them means "or" for: the ones this classifier reads a limit by. */
function isLimitVocabulary(word: string): boolean {
  const w = singularOf(word.toLowerCase());
  return w === 'and' || w === 'or' || w === 'limit' || NOT_AN_ALLOWANCE.has(w) || AN_ALLOWANCE.has(w) || A_PERIOD.has(w);
}

/**
 * Two or three words joined by slashes, with at most a bracket before and punctuation after.
 * Whether it is ALTERNATIVES rather than a path is decided by the words (isLimitVocabulary).
 */
const SLASHED_WORDS_RUN = /^[(\[{]*([A-Za-z]+(?:\/[A-Za-z]+){1,2})[)\]}.:!?]*$/;

/**
 * Whether a run with a slash in it is alternatives — "quota/rate limit", "usage/billing",
 * "input/output", "and/or" — and not a path. Deliberately narrow: every word on either side of
 * the slash has to be one this classifier itself reads a limit by. `src/quota` and
 * `internal/ratelimit` have the same shape and are directories; no rule about shape could tell
 * them from "quota/rate", so the rule is about the words. Keeping such a run matters in both
 * directions: "exceeded your quota/rate limit" must be read, and so must "time/memory limit
 * exceeded" — with its words removed it would be a bare "limit exceeded".
 */
function isSlashedWords(run: string): boolean {
  const words = SLASHED_WORDS_RUN.exec(run)?.[1];
  return words !== undefined && words.split('/').every(isLimitVocabulary);
}

/**
 * `text` without the NAMES in it — what somebody called a thing, which says nothing about an
 * account whatever words the name is made of:
 *  - an identifier a tool quotes (QUOTED_TOKEN; in double quotes, withoutQuotedWords);
 *  - every run that holds a `/` or a `\` — a path, a URL, a module specifier — unless it is
 *    words joined by slashes (isSlashedWords);
 *  - every bare file name (FILE_NAME_RUN).
 * Only the word search reads the result: a status beside a URL ("https://api.x/v1 returned 429")
 * is read before this, and `HTTP/1.1` is itself such a run.
 */
function withoutNames(text: string): string {
  return withoutQuotedWords(text).replace(QUOTED_TOKEN, ' ').replace(TEXT_RUN, (run) => {
    if (run.includes('/') || run.includes('\\')) {
      return isSlashedWords(run) ? run : ' ';
    }
    return FILE_NAME_RUN.test(run) ? ' ' : run;
  });
}

/**
 * The words a quota wall is said in. Substrings on purpose — the codes an API answers with are
 * written `insufficient_quota`, `rate_limit_error`, `rateLimitExceeded`, and a word boundary
 * would lose all three. `rate.?limit` is the three spellings: "rate limit", "ratelimit" and the
 * two joined by one character. "out of usage" is the Claude CLI on an account whose extra usage
 * is spent ("You're out of extra usage · resets 3pm"). The last alternative is an account told
 * about ITS limit, as the agent CLIs say a plan window: "You've hit your limit", "hit your
 * 5-hour limit", "reached your monthly request limit", "exceeded your usage limit" — at most two
 * words between, none of them ending a sentence.
 *
 * ONE literal, with flag `i` and nothing else: the providers harness restates it and checks its
 * copy against this file's text.
 */
const QUOTA_WORDS =
  /quota|usage limit|rate.?limit|limit (?:has been )?(?:reached|exceeded)|too many requests|overloaded|out of (?:extra )?usage|(?:hit|reached|exceeded) your(?: [^\s.,;:!?()]+){0,2} limit/i;
/** A match of QUOTA_WORDS' last alternative (lower case). */
const YOUR_LIMIT_PHRASE = /^(?:hit|reached|exceeded) your/;

/**
 * Whether the limit named at `limitAt` (the index of the word `limit`) is NOT an account's
 * allowance.
 *
 * It is not one when either of the TWO words directly before it, in the same clause, is in
 * NOT_AN_ALLOWANCE — two, so that "context window limit" and "tool call limit" are read as what
 * they are — UNLESS one of the THREE words before it, in the same phrase, says it is an
 * allowance after all: a word of AN_ALLOWANCE, or a period. Two narrow exceptions keep that
 * from saying too much: "per request" is the scope of a limit, not a count of requests, and a
 * period beside `time` / `timeout` is a duration (A_PERIOD).
 *
 * A limit with nothing before it ("Limit reached · resets 3pm"), and one named only by other
 * words ("weekly", "5-hour", "Opus", "spending", "daily request"), is an allowance.
 */
function isNotAnAllowance(text: string, limitAt: number): boolean {
  const refusing = wordsBefore(text, limitAt, CLAUSE_BREAK)
    .slice(-2)
    .filter((word) => NOT_AN_ALLOWANCE.has(word));
  if (refusing.length === 0) {
    return false;
  }
  const aDuration = refusing.every((word) => word === 'time' || word === 'timeout');
  const named = wordsBefore(text, limitAt, PHRASE_BREAK);
  for (let i = Math.max(0, named.length - 3); i < named.length; i++) {
    const word = named[i];
    const vouches =
      word === 'request' ? named[i - 1] !== 'per' : AN_ALLOWANCE.has(word) || (A_PERIOD.has(word) && !aDuration);
    if (vouches) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the limit named at `limitAt` (the index of the word `limit`) is a "rate limit" whose
 * rate is not one of requests: `rate` directly before it, and a word of NOT_A_REQUEST_RATE
 * directly before that. Asked of every phrase that names a limit, because "frame rate limit
 * exceeded" is both a "rate limit" and a "limit exceeded".
 */
function isNotARequestRate(text: string, limitAt: number): boolean {
  const named = wordsBefore(text, limitAt, PHRASE_BREAK);
  return named.length >= 2 && named[named.length - 1] === 'rate' && NOT_A_REQUEST_RATE.has(named[named.length - 2]);
}

/**
 * Whether `text` (names already removed) says a quota wall in WORDS. Every alternative of
 * QUOTA_WORDS counts as it stands except three: the two that name a limit without saying whose
 * — "limit [has been] reached / exceeded" and "hit / reached / exceeded your … limit" — count
 * unless the limit is named as something that is not an allowance, and "rate limit" — in those
 * two as well — counts unless the rate is not one of requests. A phrase that is refused does not
 * hide one that begins inside it: the search goes on from the next character ("hit your token
 * rate limit" is still a rate limit).
 */
function statesQuotaInWords(text: string): boolean {
  const each = new RegExp(QUOTA_WORDS.source, 'gi');
  for (let match = each.exec(text); match !== null; match = each.exec(text)) {
    const phrase = match[0].toLowerCase();
    const limitFirst = phrase.startsWith('limit ');
    const namesALimit = limitFirst || YOUR_LIMIT_PHRASE.test(phrase);
    // Every alternative that names a limit ends with the word, except the one that begins with it.
    const limitAt = limitFirst ? match.index : match.index + phrase.length - 'limit'.length;
    const refused = namesALimit
      ? isNotAnAllowance(text, limitAt) || isNotARequestRate(text, limitAt)
      : phrase.startsWith('rate') && isNotARequestRate(text, limitAt);
    if (!refused) {
      return true;
    }
    each.lastIndex = match.index + 1;
  }
  return false;
}

/**
 * Does this failure text say the ACCOUNT is out of quota or rate limited?
 *
 * THE classifier of every dispatch path. It is defined in this module, and re-exported from
 * task-runner under the name its importers have always used, because this module is the lower
 * of the two: task-runner imports it, and a definition there would make the two import each
 * other. The note above says what it reads and why it would rather miss. Total: anything that
 * is not a string is not a quota failure.
 */
export function isQuotaError(message: string): boolean {
  if (typeof message !== 'string' || message === '') {
    return false;
  }
  const located = withoutCodeLocations(
    message.length > QUOTA_SCAN_MAX_CHARS ? message.slice(0, QUOTA_SCAN_MAX_CHARS) : message,
  );
  return statesQuotaStatus(located) || statesQuotaInWords(withoutNames(located));
}

/* ---- a login failure, read from the vendor's own words ---- */

/**
 * Where a login STATEMENT may begin: at the start of a line (bullets, brackets and marks before
 * it do not count), after the punctuation that ends a clause, or after a spaced dash — optionally
 * behind the word a diagnostic opens with. Never after a comma, a quote or an ordinary word: that
 * is what keeps "users who are not logged in" and "the 'not logged in' banner" out.
 */
const LOGIN_LEAD = String.raw`(?:^[^\p{L}\p{N}"'\x60]*|[:.;!?\]|>]\s+|\s[-\u2013\u2014]\s+)(?:(?:error|fatal|failure|failed)[:!]?\s+)?`;
/**
 * Where a statement must END: the end of the line or the punctuation that closes a clause — not
 * another word, and not a comma (a comma continues the sentence the statement would be part of).
 */
const LOGIN_END = String.raw`(?=\s*(?:$|[.:;!?)\]|<]|[-\u2013\u2014]\s))`;
/**
 * The statements themselves — each a complete clause that says THE CLI has no session. They are
 * the whole list; ordinary words around a login ("login form", "sign in button") are not in it.
 */
const LOGIN_STATEMENTS = [
  String.raw`authentication (?:is )?required`,
  String.raw`(?:you(?:'re| are) )?not (?:logged|signed)[ -]?in`,
  String.raw`(?:you(?:'re| are) )?(?:not authenticated|unauthenticated)`,
  String.raw`(?:log[ -]?in|sign[ -]?in) (?:is )?required`,
  String.raw`please (?:log[ -]?in|sign[ -]?in)(?: again| first| to continue)?`,
].join('|');
const LOGIN_STATEMENT = new RegExp(`${LOGIN_LEAD}(?:${LOGIN_STATEMENTS})${LOGIN_END}`, 'iu');
/** The same statements as the whole value of an error field of a JSON body the CLI printed. */
const LOGIN_STATEMENT_JSON = new RegExp(
  String.raw`"(?:message|error|detail|reason|error_description)"\s*:\s*"(?:${LOGIN_STATEMENTS})[.!]?"`,
  'iu',
);
/** An HTTP 401 reported as "unauthorized", stated as a status — not told as part of a sentence. */
const LOGIN_HTTP_401 = new RegExp(
  String.raw`(?:${LOGIN_LEAD}|\(|\b(?:status|code|error|https?)[:=]?\s+)401\b[\s:()\[\]\u2013\u2014-]{1,4}unauthorized\b` +
    String.raw`|${LOGIN_LEAD}unauthorized[\s:(\[\u2013\u2014-]{1,4}(?:(?:https?|status|code|error)\s+)*401\b`,
  'iu',
);

/**
 * A request that went out with NO credential at all, in the words the API answers it with. This
 * is what a logged-out Codex run says, once per reconnection attempt, before it gives up
 * (measured live on codex-cli 0.145.0, 2026-10-13): "unexpected status 401 Unauthorized: Missing
 * bearer or basic authentication in header, url: …, cf-ray: …". Specific enough to need no
 * anchoring: nobody writes it by hand.
 */
const LOGIN_NO_CREDENTIAL = /missing bearer(?: or basic)? authentication/i;

/**
 * The names a provider's CLI may call ITSELF by in its own diagnostics, lower-cased: the
 * executable, the words it is made of, the provider id and the product name. Derived from
 * providers.ts and nothing else (cursor-agent's own error names its login command `agent login`).
 */
function ownCliNames(info: ProviderInfo): string[] {
  const names = new Set<string>();
  for (const raw of [info.cli, ...info.cli.split(/[^A-Za-z0-9]+/), info.id, info.label]) {
    const name = raw.trim().toLowerCase();
    if (name.length >= 3) {
      names.add(name);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/** "run `<this CLI> login`" / "'<this CLI> auth login'": an instruction to log THIS CLI in. */
function ownLoginCommand(info: ProviderInfo): RegExp {
  const names = ownCliNames(info).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    String.raw`(?:\brun\s+["'\x60]?|["'\x60])(?:${names.join('|')})\s+(?:auth\s+)?login(?![\w-])`,
    'iu',
  );
}

/** Lines of failure text looked at for a login statement; a diagnostic is said in a few lines. */
const LOGIN_SCAN_MAX_LINES = 400;
/** Longest line looked at. A longer one is a payload, not a sentence, and only its head is read. */
const LOGIN_SCAN_MAX_LINE_CHARS = 2_000;

/**
 * Does this text — what a vendor CLI said on its ERROR channel about a run that FAILED — state
 * that the CLI itself is not authenticated?
 *
 * WHY IT EXISTS. A vendor's own "am I logged in" check can be wrong in the direction that
 * matters: `cursor-agent status` answers "logged in" on a machine where every run then fails
 * with "Authentication required. Please run 'agent login' first" (measured live, 2026-10-13).
 * With the status check as the only witness such a run was an ordinary failure: no failover, and
 * an account every surface kept calling logged in.
 *
 * WHAT IT ACCEPTS, per line of `text`, any ONE of:
 *  1. a login STATEMENT standing as a clause of its own (LOGIN_LEAD … LOGIN_END): "authentication
 *     [is] required", "[you are] not logged in", "not signed in", "not authenticated",
 *     "unauthenticated", "login / log in / sign in [is] required", "please log in / sign in
 *     [again | first | to continue]" — or one of them as the whole error field of a JSON body;
 *  2. an instruction to run THIS provider's own login command: "run `codex login`",
 *     "Please run 'agent login' first" (ownLoginCommand);
 *  3. an HTTP 401 reported as "unauthorized", stated as a status ("401 Unauthorized",
 *     "unexpected status 401 Unauthorized: …", "Unauthorized (401)");
 *  4. the API's own words for a request sent without a credential ("Missing bearer or basic
 *     authentication in header").
 *
 * WHAT IT REFUSES is everything else that merely mentions logging in: a statement inside a
 * longer sentence ("users who are not logged in see a banner", "Login required fields are
 * marked"), a quoted one ("the 'not logged in' banner"), another tool's login command ("run `gh
 * auth login`"), a 401 told as prose ("the endpoint returns 401 Unauthorized when …"). It is
 * deliberately not a keyword search: a worker's task may be ABOUT authentication.
 *
 * The caller owns the other half of the caution — it hands over the text of a FAILED run only,
 * and never a worker's answer (see failRun). A wrong "yes" costs one failover and a "logged out"
 * reading that the next dispatch re-checks live before believing; a wrong "no" leaves the
 * failure what it was before this existed, with the status check still asked.
 *
 * Exported for the verification harness; production code reaches it through failRun.
 */
export function isLoginFailureText(text: string, provider: Exclude<ProviderId, 'claude'>): boolean {
  if (typeof text !== 'string' || text === '') {
    return false;
  }
  const ownCommand = ownLoginCommand(providerInfo(provider));
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/, LOGIN_SCAN_MAX_LINES);
  for (const raw of lines) {
    const line = raw.length > LOGIN_SCAN_MAX_LINE_CHARS ? raw.slice(0, LOGIN_SCAN_MAX_LINE_CHARS) : raw;
    if (
      LOGIN_STATEMENT.test(line) ||
      LOGIN_STATEMENT_JSON.test(line) ||
      LOGIN_HTTP_401.test(line) ||
      LOGIN_NO_CREDENTIAL.test(line) ||
      ownCommand.test(line)
    ) {
      return true;
    }
  }
  return false;
}

/* ---- a workspace the vendor CLI refuses, read the same way ---- */

/**
 * `codex exec` refuses to run outside a git repository ("Not inside a trusted directory and
 * --skip-git-repo-check was not specified."), and adapter 0.1.1 has no switch for it. The flag
 * is deliberately NOT passed from here: it turns off a safety check of that CLI, which is the
 * operator's to decide, not a dispatch's.
 */
const CODEX_NOT_A_REPOSITORY = /not inside a trusted directory|--skip-git-repo-check/i;
/** What to do about it, in one sentence — appended to the failure, which is otherwise the CLI's words. */
export const CODEX_NOT_A_REPOSITORY_HINT =
  'Codex only runs inside a git repository — initialise one in the workspace or dispatch this task to another provider.';

/**
 * The sentence to add when a failure is the WORKSPACE's doing rather than the account's or the
 * task's, or undefined. One case today: Codex outside a git repository.
 */
function workspaceRefusalHint(provider: ProviderId, vendorText: string): string | undefined {
  return provider === 'codex' && CODEX_NOT_A_REPOSITORY.test(vendorText) ? CODEX_NOT_A_REPOSITORY_HINT : undefined;
}

/** Base of every failure this module raises. `detail` is the vendor's own words, kept as evidence. */
class ProviderError extends Error {
  /**
   * What the vendor CLI or its adapter actually said — unflattened, bounded, with anything
   * credential-shaped removed. Absent when there is nothing beyond `message`. UNTRUSTED text: the
   * dispatch core appends it to the task's output file, clearly fenced, and puts it nowhere else.
   */
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = new.target.name;
    if (detail !== undefined && detail !== '') {
      this.detail = detail;
    }
  }
}

/** The vendor refused the run on quota or rate limit → cooldown + failover, like a Claude quota error. */
export class ProviderQuotaError extends ProviderError {}
/**
 * The account is not logged in → skip the account and fail over; no cooldown. Raised when the
 * failed run's own error text says so, when the account's login check does, or when an adapter
 * raises AuthError — the message is the same in all three (loginFailure).
 */
export class ProviderAuthError extends ProviderError {}
/** The run hit its wall-clock limit and was terminated → the dispatch timeout path. */
export class ProviderTimeoutError extends ProviderError {}
/** The run was stopped through the `kill` handed to `onChild` (a cancel, or the server going down). */
export class ProviderCancelledError extends ProviderError {}
/**
 * The child died from a termination signal this module never sent — the editor's Cancel button
 * (which signals the recorded pid directly), an OS kill. Never a quota problem and never a reason
 * to run the task again on another account: nobody may still want it.
 */
export class ProviderKilledError extends ProviderError {}
/** The provider's CLI is not installed, not on PATH, or could not be started at all. */
export class ProviderCliError extends ProviderError {}
/** Every other failed run: the worker reported an error, exited badly, or produced no answer. */
export class ProviderRunFailure extends ProviderError {}
/**
 * The vendor CLI refused the WORKSPACE (Codex outside a git repository). An ordinary failure for
 * every purpose but one: it says nothing about the account, so the dispatch core files no error
 * against the worker for it — and, like any ordinary failure, it gets no cooldown and no second
 * worker, which would be refused in the same directory for the same reason.
 */
export class ProviderWorkspaceError extends ProviderRunFailure {}

/**
 * Is `err` the adapter library's error of this name? By `instanceof` when the class identity
 * holds, and by NAME as well: a bundle can end up with two copies of the core package (one per
 * module format), and an error raised through the other copy is the same error.
 */
function isAdapterError(err: unknown, name: 'AuthError' | 'QuotaExceededError'): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

/**
 * Remove what looks like a credential from vendor diagnostics before they are stored or shown.
 * A CLI that fails an authenticated request is the one place a bearer token or an API key can
 * turn up on stderr. Applied to FAILURE text only — never to a worker's answer, which is the
 * task's own content.
 *
 * "Bearer" and "Basic" are also ordinary words, and the sentence a logged-out Codex run fails
 * with says "Missing bearer or basic authentication in header": the three English words of
 * credential length that follow them in prose (authentication, authorization, credential[s])
 * are left alone, so that sentence reaches the reader as the vendor wrote it. Anything else of
 * credential length still goes.
 */
function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(Bearer|Basic)\s+(?!(?:authentication|authorization|credentials?)\b)[A-Za-z0-9._~+/=-]{8,}/gi,
      '$1 [redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
}

/** Vendor text as evidence: credential-shaped runs removed, bounded, otherwise verbatim. */
function evidence(text: string): string {
  const clean = redactSecrets(text).trim();
  return clean.length > FAILURE_DETAIL_MAX_CHARS
    ? `${sliceOneLine(clean, FAILURE_DETAIL_MAX_CHARS)}\n…[cut at ${FAILURE_DETAIL_MAX_CHARS} characters]`
    : clean;
}

/**
 * A one-line failure message: OUR words first, then the vendor's, flattened and cut.
 *
 * The prefix is a literal of this module on purpose. The task tree files a failure as cancelled
 * or orphaned by the first word of its message, so vendor text must never be what opens it. The
 * vendor part goes through displayText.flattenOneLine — the one-line rule every other label in
 * this codebase uses — and the whole is held to `maxChars` (FAILURE_LABEL_MAX_CHARS unless the
 * caller's own sentence needs more — see loginFailure), with a marker that says so when it was
 * cut. The uncut text travels on the error as `detail`.
 */
function failureLabel(prefix: string, vendorText: string, maxChars: number = FAILURE_LABEL_MAX_CHARS): string {
  const flat = flattenOneLine(redactSecrets(vendorText));
  if (flat === '') {
    return prefix.replace(/[:\s—-]+$/, '');
  }
  const room = maxChars - prefix.length;
  if (flat.length <= room) {
    return `${prefix}${flat}`;
  }
  return `${prefix}${sliceOneLine(flat, Math.max(0, room - FAILURE_LABEL_ELLIPSIS.length))}${FAILURE_LABEL_ELLIPSIS}`;
}

/* ------------------------------------------------------------------------- *
 * Logging an account back in
 * ------------------------------------------------------------------------- */

/**
 * Wrap a value in POSIX single quotes so it survives the shell verbatim. Account directories
 * routinely contain spaces ("/Users/x/Library/Application Support/…"), which an unquoted
 * assignment would split into a command. Inside single quotes nothing is special except the
 * closing quote itself, so the only escape needed is the standard '\'' idiom: close, emit a
 * literal quote, reopen. (Moved here from task-runner, which imports it: this is the lower of
 * the two modules and both now print a login command.)
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * How an account on ANOTHER VENDOR'S CLI is logged back in: a shell command built from
 * `providerInfo(p).loginArgs`, or — for a provider that signs in elsewhere (Antigravity: its
 * desktop app) — the phrase that says where.
 *
 * The account's home variable is spelled out only when the adapter would set it for a run too
 * (providers.adapterAccountDir): the machine's ordinary login is re-made by the bare command,
 * and exporting its default directory would be a different statement.
 *
 * THE one definition: the dispatch core's refusals (task-runner.reloginRoute), list_workers and
 * the failure message of a run that hit a dead login all print what this returns.
 */
export function providerLoginRoute(
  provider: Exclude<ProviderId, 'claude'>,
  configDir: string,
): { command: string } | { manual: string } {
  const info = providerInfo(provider);
  if (info.loginArgs === null) {
    return { manual: `sign in through the ${info.label} desktop app` };
  }
  const dir = adapterAccountDir(provider, configDir);
  const prefix = dir !== undefined && info.homeEnv !== null ? `${info.homeEnv}=${shellQuote(dir)} ` : '';
  return { command: `${prefix}${info.cli} ${info.loginArgs.join(' ')}` };
}

/* ------------------------------------------------------------------------- *
 * Which binary
 * ------------------------------------------------------------------------- */

const cliMemo = new Map<string, { value: string; at: number }>();

/** `<cli>.exe` in a directory of this process's PATH — the only thing a shell-less spawn runs on win32. */
function findWindowsExecutable(cli: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, `${cli}.exe`);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

/**
 * The executable to spawn for a provider's CLI, and whether one was found at all.
 *
 * Resolved exactly as a bare `claude` is: registry.resolveViaLoginShell asks the user's login
 * shell (`command -v <cli>`) and then tries the standard install locations — this server is
 * started by the Claude Code CLI and routinely runs without the PATH a terminal has, so a bare
 * name would fail with ENOENT for a CLI that is installed. That lookup is a synchronous shell
 * spawn, so its answer is kept: an absolute path for as long as it still names an executable
 * file, a failure for CLI_RESOLVE_RETRY_MS (a CLI installed a minute ago is then found without a
 * restart, and a missing one is not looked for on every call).
 *
 * On win32 there is no login shell to ask and no shell is ever used to start a child (the prompt
 * is an argument, and a command line built for cmd.exe would be an injection surface), so only a
 * real `<cli>.exe` on PATH counts as found.
 */
export function resolveProviderCli(cli: string, nowMs: number = Date.now()): { command: string; found: boolean } {
  if (process.platform === 'win32') {
    const exe = findWindowsExecutable(cli);
    return { command: exe ?? cli, found: exe !== undefined };
  }
  const memo = cliMemo.get(cli);
  if (memo !== undefined) {
    if (path.isAbsolute(memo.value) && isSpawnableFile(memo.value)) {
      return { command: memo.value, found: true };
    }
    const age = nowMs - memo.at;
    if (!path.isAbsolute(memo.value) && age >= 0 && age < CLI_RESOLVE_RETRY_MS) {
      return { command: cli, found: false };
    }
  }
  const resolved = resolveViaLoginShell(cli);
  cliMemo.set(cli, { value: resolved, at: nowMs });
  const found = path.isAbsolute(resolved) && isSpawnableFile(resolved);
  return { command: found ? resolved : cli, found };
}

function cliMissingMessage(info: ProviderInfo): string {
  return (
    `The ${info.label} CLI ("${info.cli}") was not found: it is not installed, or it is not on ` +
    `the PATH of a login shell. Install it or fix PATH, then retry — a ${info.label} worker ` +
    'cannot run without it. Nothing was started.'
  );
}

/* ------------------------------------------------------------------------- *
 * The process seam
 * ------------------------------------------------------------------------- */

/** How many pieces a kept tail may be in before neighbours are joined (see BoundedText.push). */
const TAIL_PIECES_MAX = 1024;

/** `pieces` in order, neighbours joined until each run holds at least `runChars` characters. */
function joinedInRuns(pieces: readonly string[], runChars: number): string[] {
  const runs: string[] = [];
  let run: string[] = [];
  let chars = 0;
  for (const piece of pieces) {
    run.push(piece);
    chars += piece.length;
    if (chars >= runChars) {
      runs.push(run.join(''));
      run = [];
      chars = 0;
    }
  }
  if (run.length > 0) {
    runs.push(run.join(''));
  }
  return runs;
}

/**
 * One stream of one child, bounded to `capBytes`: its first `headBytes` and its last
 * (`capBytes` − `headBytes`), with the middle dropped once the stream outgrows the cap. With no
 * head it is simply the END of the stream. Chunks arrive already decoded (the stream has an
 * encoding set, so a multi-byte character split across two pipe reads is never torn) and are
 * dropped whole. Never throws, whatever the child writes.
 *
 * Exported for the one-shot `claude -p` runner, which keeps its child's stderr by the same rule.
 */
export class BoundedText {
  private head = '';
  private usedHeadBytes = 0;
  private tail: string[] = [];
  private tailBytes = 0;
  /** Bytes the child wrote in total, kept or not. */
  bytes = 0;
  dropped = false;

  constructor(
    private readonly capBytes: number,
    private readonly headBytes: number,
  ) {}

  push(chunk: string): void {
    const size = Buffer.byteLength(chunk);
    this.bytes += size;
    if (this.tail.length === 0 && this.usedHeadBytes + size <= this.headBytes) {
      this.head += chunk;
      this.usedHeadBytes += size;
      return;
    }
    this.tail.push(chunk);
    this.tailBytes += size;
    const room = this.capBytes - this.headBytes;
    while (this.tailBytes > room && this.tail.length > 1) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift() as string);
      this.dropped = true;
    }
    if (this.tailBytes > room) {
      // One chunk larger than everything the tail may hold: keep its end.
      const only = Buffer.from(this.tail[0]);
      this.tail[0] = only.subarray(only.length - room).toString('utf8');
      this.tailBytes = Buffer.byteLength(this.tail[0]);
      this.dropped = true;
    }
    if (this.tail.length > TAIL_PIECES_MAX) {
      // The cap is on BYTES; a child that writes a few bytes at a time would otherwise keep
      // them as millions of separate strings, which cost far more than the bytes they hold.
      // Joined into runs of a sixteenth of the room, not into one string: the oldest piece is
      // what the loop above drops, whole, and it must stay a small part of what is kept.
      this.tail = joinedInRuns(this.tail, Math.max(1, Math.floor(room / 16)));
    }
  }

  text(): string {
    if (!this.dropped || this.head === '') {
      return `${this.head}${this.tail.join('')}`;
    }
    // The newline keeps the two halves from meeting mid-line: every one of these CLIs writes
    // line-delimited JSON, and the fragment that starts the tail must not complete a line.
    return `${this.head}\n${this.tail.join('')}`;
  }

  /** The last `max` characters, for a diagnostic. */
  tailText(max: number): string {
    const all = this.tail.length > 0 ? this.tail.join('') : this.head;
    if (all.length <= max) {
      return all;
    }
    const cut = all.slice(all.length - max);
    // A cut at a fixed count can land between the halves of a surrogate pair; drop the orphan.
    return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
  }
}

/** What happened to one child this module started — the facts the adapters' result cannot carry. */
export interface ChildObservation {
  /** spawn() produced a process. */
  spawned: boolean;
  /** errno of a spawn failure (ENOENT, EACCES, E2BIG, …). */
  spawnError?: string;
  /** Its wall-clock limit passed while it was still running, and it was told to stop. */
  timedOut: boolean;
  /**
   * This module sent it a signal — for the deadline, or because the run was cancelled. False for
   * a child that had already exited when the stop was asked for, however late that was noticed.
   */
  stopped: boolean;
  exitCode: number | null;
  /** The signal that ended it, whoever sent it. */
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** Part of its STDOUT was dropped by the cap. */
  truncated: boolean;
  /** The end of its stderr, for a diagnostic. Never its stdout: that is the vendor's raw payload. */
  stderrTail: string;
}

interface ProcessSeam {
  /** The adapters' process seam. */
  readonly exec: ExecFn;
  /** Every child asked for so far, in order — including ones that never started. */
  readonly children: ChildObservation[];
  /** kill() has been called. */
  cancelled(): boolean;
  /** Give children started from now on a new deadline (epoch ms). */
  setDeadline(deadlineMs: number): void;
  /**
   * Stop everything this seam has running — SIGTERM to each child's whole process group (one
   * turn of the loop later, and only to a child that is still there by then: see terminate),
   * SIGKILL after KILL_GRACE_MS — and start nothing more. A SECOND call escalates to SIGKILL at
   * once: it is what a caller that cannot wait out the grace (a server about to exit) uses.
   */
  kill(): void;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Every vendor child this PROCESS has running, whichever seam started it — what
 * killVendorChildrenNow ends. A child is here from the moment it exists until its call has
 * settled.
 */
const runningVendorChildren = new Set<ChildProcess>();

/**
 * End, NOW, everything this process started through a process seam: SIGKILL to the process group
 * of every vendor child that is still running (the single process where there are no groups).
 * Returns how many were signalled.
 *
 * FOR A PROCESS THAT IS ITSELF BEING ENDED. A seam stops its children on their deadline and on
 * its own kill(), both of which need this process to go on living: a SIGTERM with its grace, a
 * timer. A helper that is told to go — or that has its answer and is about to exit — has no
 * such time, and a child it leaves behind is reparented and runs on with nobody able to stop it:
 * a vendor CLI stuck on the network has no limit of its own. So this one is synchronous and
 * final: no grace, no timer, nothing awaited.
 *
 * Only a child that has NOT exited is signalled, and by the pid this process spawned it under:
 * that pid still names the process (and, on POSIX, the group it leads) that this module started.
 * The group of a child that has already exited is left alone — its number may be anybody's by
 * now. Idempotent: a second call finds the same children already dying, and signalling them
 * again changes nothing. Never throws.
 */
export function killVendorChildrenNow(): number {
  let signalled = 0;
  for (const child of [...runningVendorChildren]) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    const pid = child.pid;
    try {
      if (process.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
        process.kill(-pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
      signalled++;
    } catch {
      // The group is already gone, or was never one: the single process, when it is still there.
      try {
        if (child.kill('SIGKILL')) {
          signalled++;
        }
      } catch {
        // already exited — nothing to end
      }
    }
  }
  return signalled;
}

/**
 * The environment of a vendor child: platform.vendorChildEnv — the orchestrator session's
 * identity variables removed, and every Anthropic credential with them (an API key, an OAuth
 * token and CLAUDE_CONFIG_DIR authenticate THIS vendor and are nothing another vendor's binary
 * should be able to read out of its environment). Everything else passes through, that
 * vendor's own keys and the proxy settings included.
 *
 * The adapter hands over the environment it composed from the base it was given (the same
 * function) plus the account's home variable; a key whose value is undefined means "absent".
 * It is applied AGAIN here, so that what reaches another vendor's CLI is a property of this
 * spawn site rather than of every caller upstream.
 */
function childEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  if (env === undefined) {
    return vendorChildEnv();
  }
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return vendorChildEnv(out);
}

/**
 * The process seam handed to an adapter: `exec`, implemented with this codebase's own rules.
 *
 *  - Every child is spawned DETACHED (POSIX), so it leads its own process group and a signal to
 *    `-pid` reaches the vendor CLI and everything it started. Never on win32, where `detached`
 *    means "own console, outlives us"; there the direct child is signalled.
 *  - No shell, ever: the prompt is an argument.
 *  - Settled on 'exit' plus at most DRAIN_GRACE_MS — never on 'close' alone.
 *  - Output is bounded (BoundedText) and excess is dropped, never thrown: stdout keeps its
 *    start and its end (OUTPUT_CAP_BYTES), stderr its end only (STDERR_TAIL_BYTES). A child that
 *    outgrows its stdout cap is NOT stopped, unlike a `claude -p` child: its stdout is a stream
 *    of events whose last one is the answer, so a long run that printed a great deal is still a
 *    run that finished, and killing it would discard work already done in the working tree.
 *  - One wall-clock DEADLINE covers every child of the seam, so an adapter that runs a second
 *    process cannot double the budget. At the deadline, a child that is STILL RUNNING once the
 *    loop has gone round (so that an exit already on its way is seen first) gets SIGTERM to its
 *    group and SIGKILL after KILL_GRACE_MS, and the result says `timedOut: true`. A child that
 *    had exited by itself is not touched and is not "timed out", however late this process
 *    came to its timer. kill() stops a child by the same rule.
 *  - `onChild` is called ONCE, when the first child exists, with the seam's kill().
 *  - `dispatchedTask`, when given, is the dispatched task this seam runs: every child gets it as
 *    DISPATCHED_TASK_ENV (contract §15.5), set AFTER childEnv's scrub — it is not an Anthropic
 *    variable, and nothing there may remove it. Only a worker run's seam has one; a status probe
 *    or a model listing starts no worker and carries none.
 *
 * A spawn failure rejects (the adapters turn that into their own error); everything else
 * resolves. No timer, stream or listener is left armed after a child settles.
 */
function createProcessSeam(opts: {
  deadlineMs: number;
  onChild?: (kill: () => void, pid: number | undefined) => void;
  dispatchedTask?: string;
}): ProcessSeam {
  let deadlineMs = opts.deadlineMs;
  let cancelled = false;
  let announced = false;
  const children: ChildObservation[] = [];
  /** terminate() of each child still running. */
  const live = new Set<() => void>();

  const kill = (): void => {
    cancelled = true;
    for (const terminate of [...live]) {
      terminate();
    }
  };

  const exec: ExecFn = (req) =>
    new Promise((resolve, reject) => {
      const seen: ChildObservation = {
        spawned: false,
        timedOut: false,
        exitCode: null,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        stderrTail: '',
        stopped: false,
      };
      children.push(seen);
      // Cancelled between two children of one run: the second one never starts.
      if (cancelled) {
        reject(new Error('the run was cancelled before this process was started'));
        return;
      }
      const own = typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : Infinity;
      const limit = Math.min(own, deadlineMs - Date.now());
      if (!(limit > 0)) {
        // The budget is already spent: report the timeout without starting anything.
        seen.timedOut = true;
        resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true });
        return;
      }

      let child: ChildProcess;
      try {
        const env = childEnv(req.env);
        if (opts.dispatchedTask !== undefined) {
          env[DISPATCHED_TASK_ENV] = opts.dispatchedTask;
        }
        child = spawn(req.cmd, req.args, {
          cwd: req.cwd,
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        seen.spawnError = errnoOf(err) ?? 'EINVAL';
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const stdout = new BoundedText(OUTPUT_CAP_BYTES, OUTPUT_HEAD_BYTES);
      const stderr = new BoundedText(STDERR_TAIL_BYTES, 0);
      let settled = false;
      // A stop has been asked for (the deadline, or kill()); the signal follows a turn later.
      let stopAsked = false;
      // That signal has been sent.
      let signalled = false;
      // A stop was asked for twice before it was: the signal to send is the SIGKILL.
      let killAtOnce = false;
      let deadlinePassed = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      // terminate()'s second look at the child, one turn of the loop after a stop was asked for.
      let stopCheck: NodeJS.Immediate | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let reapTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;

      /** The whole group when there is one; the single process otherwise. Never throws. */
      const signal = (sig: NodeJS.Signals): void => {
        if (gone()) {
          return;
        }
        if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // the group is already gone — fall through to the single-process signal
          }
        }
        try {
          child.kill(sig);
        } catch {
          // already exited — nothing to signal
        }
      };

      const finish = (deliver: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(reapTimer);
        clearTimeout(drainTimer);
        clearImmediate(stopCheck);
        live.delete(terminate);
        runningVendorChildren.delete(child);
        seen.stdoutBytes = stdout.bytes;
        seen.stderrBytes = stderr.bytes;
        // The ANSWER's stream only: a long stderr losing its beginning is what a tail is.
        seen.truncated = stdout.dropped;
        seen.stderrTail = stderr.tailText(4096);
        deliver();
      };

      /** `forced`: 'close' did not fire, so the pipes are still open and must be let go of. */
      const settle = (forced: boolean): void => {
        finish(() => {
          if (forced) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
            child.unref();
          }
          resolve({
            stdout: stdout.text(),
            stderr: stderr.text(),
            exitCode: seen.exitCode,
            timedOut: seen.timedOut,
          });
        });
      };

      const sigkill = (): void => {
        signal('SIGKILL');
        // If not even SIGKILL produces an 'exit' (a wedged process), settle regardless.
        reapTimer ??= setTimeout(() => settle(true), REAP_GRACE_MS);
      };

      /** A signal of this module's is about to reach the child: that is what "stopped" means. */
      const markStopped = (): void => {
        seen.stopped = true;
        if (deadlinePassed) {
          seen.timedOut = true;
        }
      };

      /**
       * Stop the child: SIGTERM, then SIGKILL after the grace; a second call is the SIGKILL, at
       * once.
       *
       * THE FIRST CALL DOES NOT SIGNAL ON THE SPOT. Whoever asks — the deadline's timer, a
       * cancel, a server going down — is asking about a child it BELIEVES is running, and after
       * a stall (SIGSTOP, a debugger, a machine that slept) that belief is stale: the timer or
       * the cancel is handled before the loop has delivered the exit of a child that finished
       * long ago. A run that had its whole answer on the pipe was then reported as timed out,
       * or as cancelled. One turn of the loop delivers a pending exit, so the signal is sent
       * after that turn, and only to a child that is still there. `stopped` and `timedOut` are
       * set when a signal is actually sent — they mean the stop is what ended the run, never
       * merely that one was asked for. A second call that arrives BEFORE that turn (the deadline
       * and a cancel handled together after the same stall) does not signal on the spot either:
       * it makes the signal that turn sends the SIGKILL.
       */
      function terminate(): void {
        if (settled || gone()) {
          return;
        }
        if (signalled) {
          clearTimeout(killTimer);
          sigkill();
          return;
        }
        if (stopAsked) {
          killAtOnce = true;
          return;
        }
        stopAsked = true;
        stopCheck = setImmediate(() => {
          if (settled || gone()) {
            // It left by itself before anything was sent: what it did stands.
            return;
          }
          signalled = true;
          markStopped();
          if (killAtOnce) {
            sigkill();
            return;
          }
          signal('SIGTERM');
          killTimer = setTimeout(sigkill, KILL_GRACE_MS);
        });
      }

      if (child.pid === undefined) {
        // The spawn failed; the 'error' event below carries why.
      } else {
        seen.spawned = true;
        live.add(terminate);
        runningVendorChildren.add(child);
        if (!announced) {
          announced = true;
          try {
            opts.onChild?.(kill, child.pid);
          } catch {
            // the host's bookkeeping must not be able to fail a run that has already started
          }
        }
      }

      timeoutTimer = setTimeout(() => {
        // The deadline has passed. Whether the child is still running — and so whether this is
        // a timeout at all — is terminate()'s to find out.
        deadlinePassed = true;
        terminate();
      }, limit);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
      // EPIPE when the child dies before its stdin is closed — the settle path owns the outcome.
      child.stdin?.on('error', () => {});

      child.on('error', (err) => {
        // Also emitted when a signal could not be delivered to a child that DID start; only a
        // child that never existed is a failure of this call.
        if (seen.spawned) {
          return;
        }
        seen.spawnError = errnoOf(err) ?? 'EINVAL';
        finish(() => reject(err));
      });
      child.on('exit', (code, sig) => {
        seen.exitCode = code;
        seen.signal = sig;
        drainTimer = setTimeout(() => settle(true), DRAIN_GRACE_MS);
      });
      child.on('close', () => {
        // 'close' follows 'exit' and means every pipe reached EOF: nothing more can arrive.
        if (gone()) {
          settle(false);
        }
      });

      try {
        if (req.stdin !== undefined) {
          child.stdin?.write(req.stdin);
        }
        child.stdin?.end();
      } catch {
        // stdin unwritable — the child's exit settles the outcome
      }
    });

  return {
    exec,
    children,
    cancelled: () => cancelled,
    setDeadline: (ms) => {
      deadlineMs = ms;
    },
    kill,
  };
}

/* ------------------------------------------------------------------------- *
 * The turn seam (team mode, contract-team-mode-v2 §3.3 M2, T0 amendment A1)
 * ------------------------------------------------------------------------- */

/** The longest stdout LINE a turn seam hands on whole; a longer one is cut to this and counted. */
const TURN_LINE_MAX_BYTES = 1024 * 1024;
/** The part of a turn seam's stderr tail that is reported (StreamEndMeta.stderrTail), characters. */
const TURN_STDERR_REPORT_CHARS = 4096;
/**
 * A `deadlineMs` below this is read as a DURATION, not an epoch instant (2001-09-09): the
 * contract's TurnDeps text passes `spec.timeoutMs` where createProcessSeam's rule is an instant.
 */
// CONTRACT-QUESTION: TurnDeps' doc writes `createTurnLineStream({deadlineMs: spec.timeoutMs, …})`;
// createProcessSeam's `deadlineMs` (whose rules §3.3 says this follows) is an instant. Both are
// accepted; the driver passes an instant.
const EPOCH_FLOOR_MS = 1e12;

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary. */
function cutToBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) {
    return text;
  }
  // A decoded cut that lands inside a multi-byte character ends in U+FFFD; drop it.
  return bytes.subarray(0, max).toString('utf8').replace(/�$/, '');
}

/**
 * The line-streaming spawn seam of a team TURN (M2) — the ONE new export of this module, handed to
 * an agent-mesh adapter as `RunOptions.lineStream`, so the vendor CLI of a turn is spawned, read,
 * timed and stopped by this codebase's rules rather than the adapter's own spawner. The rules are
 * createProcessSeam's, which stays unchanged:
 *
 *  - DETACHED (POSIX): the CLI leads its own process group (I7 [probed RP-14]), so the group can be
 *    signalled without touching the host's. No shell: the prompt is an argument.
 *  - Settled on 'exit' plus at most DRAIN_GRACE_MS (a grandchild such as the team MCP server that
 *    inherited the pipe can never hold a finished turn open, P7), or REAP_GRACE_MS after a SIGKILL
 *    that produced no 'exit' at all.
 *  - Bounded: lines not yet taken by the consumer are held up to OUTPUT_CAP_BYTES — the first
 *    OUTPUT_HEAD_BYTES of the stream are never dropped (the CLI names its conversation there), past
 *    the cap the OLDEST later line goes (the answer is the last line); stderr keeps its last
 *    STDERR_TAIL_BYTES and reports the last 4 KiB.
 *
 * and adds:
 *
 *  - LINE STREAMING: stdout is yielded one line at a time as it arrives; a line longer than
 *    TURN_LINE_MAX_BYTES is cut to that length (so it can never parse as an event) and counted.
 *  - THE INTERRUPT LADDER (T0 A1): `TurnChildHandle.signal(sig)` sends SIGINT to the LEADER pid ONLY
 *    — a SIGINT to the group does not interrupt Codex, which completes the turn — and every other
 *    signal to the whole GROUP (the escalation, so nothing the turn started survives). The ladder's
 *    STAGES are the caller's (the driver runs NORMAL / SUSPEND / TERM through this handle); the
 *    seam's own DEADLINE runs `deadlineLadder` (default NORMAL_KILL_LADDER: SIGINT leader → 10 s →
 *    SIGTERM group → 5 s → SIGKILL group). As createProcessSeam does, the deadline signals one turn
 *    of the loop later and only a child that is still there, and `timedOut` means a signal of the
 *    deadline actually went out.
 *  - `lastOutputAt()`: the last byte on stdout OR stderr (L13: tool and system lines count), the
 *    spawn time until the first.
 *
 * THE ENVIRONMENT is `opts.env`, verbatim (undefined values dropped) — the turn's whole environment
 * as the driver composed it. The adapter's own `req.env` is NOT used: the adapter adds nothing (M14),
 * and this spawn site is where that holds, whatever an adapter does upstream. (vendorChildEnv is
 * NOT re-applied here, unlike a dispatch child: a Claude member's environment is its account's.)
 *
 * WHAT `onEnd` REPORTS beyond agent-mesh's StreamEndMeta, as extra fields the adapters ignore and
 * the driver reads: `signal` (what ended the CLI, `null` for an exit), `linesCut` and
 * `stdoutDropped`. `onChild` is called once per spawned child, synchronously after the spawn; a
 * throw from it is ignored. A child that cannot be started makes the iteration THROW (the adapter
 * turns that into its one `error` event), with no `onEnd`.
 *
 * A turn child is NOT entered in runningVendorChildren: the team engine owns every turn process
 * (H2) and suspends it on its own ladder; killVendorChildrenNow must not reach it. A consumer that
 * stops iterating early gets the group SIGTERMed (SIGKILL after KILL_GRACE_MS) — nothing a turn
 * started outlives the read of it. Never throws out of a timer or a stream event.
 */
export function createTurnLineStream(opts: TurnLineStreamOptions & { deadlineLadder?: KillLadder }): LineStreamFn {
  const deadlineMs = opts.deadlineMs < EPOCH_FLOOR_MS ? Date.now() + Math.max(0, opts.deadlineMs) : opts.deadlineMs;
  const deadlineLadder = opts.deadlineLadder ?? NORMAL_KILL_LADDER;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return (req: SpawnRequest, onEnd?: (meta: StreamEndMeta) => void): AsyncIterable<string> =>
    (async function* turnLines(): AsyncGenerator<string> {
      const own = typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : Infinity;
      const limit = Math.min(own, deadlineMs - Date.now());
      if (!(limit > 0)) {
        // The budget is already spent: report the timeout without starting anything.
        onEnd?.({ timedOut: true, exitCode: null, stderrTail: '' });
        return;
      }

      const child = spawn(req.cmd, req.args, {
        cwd: req.cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const spawnedAt = Date.now();
      let lastOutput = spawnedAt;
      const stderr = new BoundedText(STDERR_TAIL_BYTES, 0);
      /** Lines not yet taken by the consumer; `head` = within the stream's first OUTPUT_HEAD_BYTES. */
      const queue: Array<{ text: string; bytes: number; head: boolean }> = [];
      let queuedBytes = 0;
      let streamBytes = 0;
      let pending = '';
      let pendingBytes = 0;
      /** The rest of an over-long line is being thrown away until its newline. */
      let discarding = false;
      let linesCut = 0;
      let stdoutDropped = false;
      let ended = false;
      let failure: Error | undefined;
      let timedOut = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let waiter: (() => void) | undefined;
      const timers = new Set<NodeJS.Timeout>();
      let stopCheck: NodeJS.Immediate | undefined;
      let reapTimer: NodeJS.Timeout | undefined;

      const wake = (): void => {
        const resume = waiter;
        waiter = undefined;
        resume?.();
      };
      const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
      const after = (ms: number, fn: () => void): void => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, ms);
        timers.add(timer);
      };

      const enqueue = (text: string): void => {
        const bytes = Buffer.byteLength(text);
        streamBytes += bytes;
        queue.push({ text, bytes, head: streamBytes <= OUTPUT_HEAD_BYTES });
        queuedBytes += bytes;
        while (queuedBytes > OUTPUT_CAP_BYTES) {
          const at = queue.findIndex((entry) => !entry.head);
          if (at === -1) {
            break;
          }
          queuedBytes -= queue[at].bytes;
          queue.splice(at, 1);
          stdoutDropped = true;
        }
        wake();
      };

      /** `forced`: 'close' did not come (a held pipe, or no 'exit' after SIGKILL) — let the pipes go. */
      const finishStream = (forced: boolean): void => {
        if (ended) {
          return;
        }
        if (pending !== '' && !discarding) {
          enqueue(pending);
        }
        pending = '';
        ended = true;
        clearImmediate(stopCheck);
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        if (forced) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          child.unref();
        }
        wake();
      };

      /** One signal to the leader or the group. Never throws; nothing is sent once the stream ended. */
      const send = (sig: NodeJS.Signals, target: 'leader' | 'group'): void => {
        if (ended || child.pid === undefined) {
          return;
        }
        if (target === 'leader' || process.platform === 'win32') {
          if (!gone()) {
            try {
              child.kill(sig);
            } catch {
              // exited between the check and the signal
            }
          }
        } else {
          try {
            process.kill(-child.pid, sig);
          } catch {
            // the group is gone — the leader alone, while it is still there
            if (!gone()) {
              try {
                child.kill(sig);
              } catch {
                // already exited
              }
            }
          }
        }
        if (sig === 'SIGKILL' && reapTimer === undefined) {
          // If not even SIGKILL produces an 'exit' (a wedged process), settle regardless.
          reapTimer = setTimeout(() => finishStream(true), REAP_GRACE_MS);
          timers.add(reapTimer);
        }
      };

      const runLadder = (ladder: KillLadder, from: number): void => {
        const stage = ladder.stages[from];
        if (stage === undefined || ended) {
          return;
        }
        send(stage.signal, stage.target);
        if (from + 1 < ladder.stages.length) {
          after(stage.waitMs, () => {
            if (!gone()) {
              runLadder(ladder, from + 1);
            }
          });
        }
      };

      if (child.pid !== undefined) {
        const pid = child.pid;
        try {
          opts.onChild({
            pid,
            pgid: pid,
            // CONTRACT-QUESTION: TurnChildHandle.signal names no target; A1 fixes it per signal —
            // SIGINT to the leader only, every escalation to the group.
            signal: (sig: NodeJS.Signals) => send(sig, sig === 'SIGINT' ? 'leader' : 'group'),
            lastOutputAt: () => lastOutput,
          });
        } catch {
          // the host's bookkeeping must not be able to fail a turn that has already started
        }
        after(limit, () => {
          // The deadline has passed. Whether the child is still running — and so whether this is
          // a timeout at all — is decided one turn of the loop later (createProcessSeam's rule).
          stopCheck = setImmediate(() => {
            if (ended || gone()) {
              return;
            }
            timedOut = true;
            runLadder(deadlineLadder, 0);
          });
        });
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        lastOutput = Date.now();
        const pieces = chunk.split('\n');
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i];
          const complete = i < pieces.length - 1;
          if (!discarding) {
            const size = Buffer.byteLength(piece);
            if (pendingBytes + size > TURN_LINE_MAX_BYTES) {
              enqueue(cutToBytes(pending + piece, TURN_LINE_MAX_BYTES));
              linesCut++;
              pending = '';
              pendingBytes = 0;
              discarding = true;
            } else {
              pending += piece;
              pendingBytes += size;
            }
          }
          if (complete) {
            if (!discarding) {
              enqueue(pending);
            }
            pending = '';
            pendingBytes = 0;
            discarding = false;
          }
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        lastOutput = Date.now();
        stderr.push(chunk);
      });
      // EPIPE when the child dies before its stdin is closed — the exit path owns the outcome.
      child.stdin?.on('error', () => {});
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      child.on('error', (err) => {
        // Also emitted when a signal could not be delivered to a child that DID start; only a
        // child that never existed fails the iteration.
        if (child.pid !== undefined) {
          return;
        }
        failure = err;
        ended = true;
        wake();
      });
      child.on('exit', (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        after(DRAIN_GRACE_MS, () => finishStream(true));
      });
      child.on('close', () => {
        // 'close' follows 'exit' and means every pipe reached EOF: nothing more can arrive.
        if (gone()) {
          finishStream(false);
        }
      });
      try {
        if (req.stdin !== undefined) {
          child.stdin?.write(req.stdin);
        }
        child.stdin?.end();
      } catch {
        // stdin unwritable — the child's exit settles the outcome
      }

      let completed = false;
      try {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            queuedBytes -= next.bytes;
            yield next.text;
            continue;
          }
          if (failure !== undefined) {
            throw failure;
          }
          if (ended) {
            break;
          }
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
        completed = true;
        onEnd?.({
          timedOut,
          exitCode,
          stderrTail: stderr.tailText(TURN_STDERR_REPORT_CHARS),
          signal: exitSignal,
          linesCut,
          stdoutDropped,
        } as StreamEndMeta);
      } finally {
        if (!completed && failure === undefined && !ended) {
          // The consumer stopped reading a turn that is still running: end it, as nodeLineStream does.
          send('SIGTERM', 'group');
          const killTimer = setTimeout(() => send('SIGKILL', 'group'), KILL_GRACE_MS);
          killTimer.unref();
        }
      }
    })();
}

/* ------------------------------------------------------------------------- *
 * Adapters
 * ------------------------------------------------------------------------- */

/**
 * A fresh adapter for ONE call. Never cached: an adapter keeps per-instance state (a model
 * catalog, a failed-probe memo), and its `exec` is the seam of one run with one deadline.
 *
 * `binary` is the resolved executable, `env` the vendor-child environment (childEnv above says
 * what that leaves out), `defaultAccount` is left unset — the account is passed on every call,
 * so the adapter never falls back to one this module did not choose.
 */
function createAdapter(
  provider: Exclude<ProviderId, 'claude'>,
  binary: string,
  exec: ExecFn,
  probeTimeoutMs: number,
): Adapter {
  const env = vendorChildEnv();
  switch (provider) {
    case 'codex':
      return new CodexAdapter({ exec, binary, env, quotaTimeoutMs: probeTimeoutMs });
    case 'cursor':
      return new CursorAdapter({ exec, binary, env, authTimeoutMs: probeTimeoutMs });
    case 'gemini':
      return new GeminiAdapter({ exec, binary, env, authTimeoutMs: probeTimeoutMs });
  }
}

/** The adapter account for a worker: its directory only when the provider is told one. */
function adapterAccount(provider: ProviderId, configDir: string): Account {
  const dir = adapterAccountDir(provider, configDir);
  return dir === undefined ? { vendor: provider } : { vendor: provider, configDir: dir };
}

/* ------------------------------------------------------------------------- *
 * Codex: the CLI's own answer about its login
 * ------------------------------------------------------------------------- */

/** What a vendor CLI said when it was asked directly whether it is logged in. */
export interface CliLoginVerdict {
  loggedIn: boolean;
  /** The auth mode it named, lower-cased, ≤ 32 chars; null when it named none. */
  mode: string | null;
}

/**
 * `codex login status`, asked of the Codex CLI itself — or undefined when it gave no verdict.
 *
 * WHY. The Codex adapter (0.1.1) decides "logged in" by reading `<CODEX_HOME>/auth.json`, and a
 * Codex login need not be in that file: the CLI can keep it in the OS keyring instead (its
 * config key `cli_auth_credentials_store`: file | keyring | auto | ephemeral). Such an account
 * reads as logged out through the adapter — it would be skipped by selection, shown as logged
 * out everywhere, and a run of it that failed for any reason at all would be filed as a dead
 * login. So whenever the adapter does NOT say "logged in" for a Codex account, the CLI is asked,
 * and its answer wins.
 *
 * WHAT COUNTS (measured live on codex-cli 0.145.0, 2026-10-13: "Logged in using ChatGPT" with
 * exit 0, "Not logged in" with exit 1, both on stderr):
 *  - exit 0 → logged in. The mode is the words after "Logged in using", when there are any;
 *  - exit 1 AND the words "Not logged in" → logged out;
 *  - ANYTHING ELSE — a timeout, another exit code, a signal, a CLI that could not be started —
 *    is no verdict, and the caller keeps what the adapter said.
 *
 * Nothing else of its output is read, and none of it is returned, logged or stored: the mode is
 * cut at the first character that is not a letter or a space, so the masked key an API-key login
 * prints after it can never travel on ("an API key - sk-…" reads as "an api key").
 *
 * Run through this module's own process seam (`exec`) like every other vendor child: the
 * vendor-child environment, CODEX_HOME set by the adapter's own rule (only when the account's
 * directory is not the default home), bounded by `timeoutMs` and by the seam's deadline,
 * whichever is sooner. Never rejects.
 */
async function codexLoginStatus(
  exec: ExecFn,
  binary: string,
  configDir: string,
  timeoutMs: number = CODEX_LOGIN_STATUS_TIMEOUT_MS,
): Promise<CliLoginVerdict | undefined> {
  try {
    const env: Record<string, string | undefined> = { ...vendorChildEnv() };
    const home = adapterAccountDir('codex', configDir);
    if (home !== undefined) {
      env.CODEX_HOME = home;
    }
    const answer = await within(exec({ cmd: binary, args: ['login', 'status'], env, timeoutMs }), timeoutMs + 1_000);
    if (answer.kind !== 'value' || answer.value.timedOut) {
      return undefined;
    }
    const { exitCode } = answer.value;
    const said = `${answer.value.stdout.slice(0, 4096)}\n${answer.value.stderr.slice(0, 4096)}`;
    if (exitCode === 0) {
      const named = /logged in using[ \t]+([A-Za-z]+(?: [A-Za-z]+)*)/i.exec(said)?.[1] ?? '';
      const mode = sliceOneLine(flattenOneLine(named), 32).trim().toLowerCase();
      return { loggedIn: true, mode: mode === '' ? null : mode };
    }
    if (exitCode === 1 && /not logged in/i.test(said)) {
      return { loggedIn: false, mode: null };
    }
    return undefined;
  } catch {
    // the CLI could not be started, or the seam was cancelled: no verdict
    return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Running a task
 * ------------------------------------------------------------------------- */

export interface ProviderRunRequest {
  /** A worker whose provider is NOT Claude Code. */
  worker: WorkerProfile;
  /** Already normalized for that provider; undefined = the CLI's own default. */
  model: string | undefined;
  /** The full text the worker sees — see buildProviderPrompt. */
  prompt: string;
  cwd: string;
  timeoutMs: number;
  claudePathIgnored?: never;
  /**
   * Called once the worker's child exists, with a function that terminates its process group
   * (SIGTERM, then SIGKILL after 5 s; calling it again is the SIGKILL) and stops the run from
   * starting anything further. `pid` is the child's pid, which on POSIX is also its group id.
   */
  onChild?: (kill: () => void, pid: number | undefined) => void;
  /**
   * The dispatched task's id. Every process of the run gets it as DISPATCHED_TASK_ENV (contract
   * §15.5), so a worker that tries to dispatch in turn is refused. The dispatch core always
   * passes it; without it the run's children carry no marker.
   */
  taskId?: string;
}

export interface ProviderRunOutcome {
  text: string;
  /**
   * The model that was asked for; when none was, what the CLI said ran — or '-' when its default
   * was used and it did not say which.
   */
  model: string;
  /** The model id the vendor REPORTED (reportedProviderModel); absent when it reported none. */
  modelUsed?: string;
  /** 0 when not reported. */
  inputTokens: number;
  outputTokens: number;
  /** '' when the vendor returned none. Informational: nothing in this codebase resumes it. */
  conversationId: string;
  /** The adapter's note, flattened, ≤ 300 chars. */
  note: string | undefined;
}

/**
 * The single text a non-Claude worker is given. These CLIs take no system prompt through the
 * adapter contract, so what a Claude worker receives as an appended system prompt and a user
 * message arrives here as ONE document, in the same order of authority: the base engineering
 * principles every worker gets, then the task's own system prompt, then the task.
 *
 * `ultrathink` becomes a plain sentence: the keyword itself is something only the Claude Code
 * harness scans for.
 */
export function buildProviderPrompt(parts: { prompt: string; systemPrompt?: string; ultrathink?: boolean }): string {
  const sections = [WORKER_BASE_PROMPT];
  if (parts.systemPrompt) {
    sections.push(`## Task system prompt\n\n${parts.systemPrompt}`);
  }
  sections.push(`## Your task\n\n${parts.prompt}`);
  if (parts.ultrathink) {
    sections.push('Think as deeply as you can before acting.');
  }
  return sections.join('\n\n');
}

function describeLimit(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${Math.round(timeoutMs / 1000)} seconds`;
}

/**
 * The leading prose is deliberately longer than 300 characters and carries no captured output:
 * the dispatch core's recordFailure keeps the first 300 for the tree view and the dashboard, and
 * that slice has to be the human-readable part. The vendor's stdout is never quoted — it is the
 * raw payload stream.
 */
function timeoutMessage(info: ProviderInfo, timeoutMs: number, child: ChildObservation | undefined): string {
  const captured =
    child === undefined
      ? ''
      : ` Captured before the kill: ${child.stdoutBytes} bytes of stdout, ${child.stderrBytes} bytes of stderr.`;
  return (
    `Worker timed out after ${describeLimit(timeoutMs)} and was terminated (${info.label}). ` +
    'Whatever it had not yet written to disk is gone, but it edits the working tree in place and ' +
    'may already have written files to the workspace, so inspect the working tree before ' +
    're-dispatching. If the task legitimately needs longer, re-dispatch it with a larger ' +
    `timeout_minutes.${captured}`
  );
}

function tokenCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.trunc(raw), Number.MAX_SAFE_INTEGER)
    : 0;
}

/** A vendor-supplied id or model name as one bounded line; '' when it flattens away. */
function oneLineId(raw: unknown): string {
  return typeof raw === 'string' ? sliceOneLine(flattenOneLine(raw), ID_MAX_CHARS) : '';
}

/**
 * The model id a vendor run REPORTED, from the adapter's `RunResult.model` — or undefined when
 * that field holds nothing that can be called an observation.
 *
 * `reported` counts only as a string in the shape of a reported id (platform.REPORTED_MODEL_ID).
 *
 * AND ONLY WHEN IT IS NOT THE REQUEST COMING BACK. The adapter contract describes the field as
 * "the model that actually ran", but the three adapters in use (0.1.1) fill it from the request
 * whenever a model was asked for: Codex returns the requested id in preference to the one in the
 * CLI's event stream, Cursor and Antigravity return the requested id and never read one from
 * their CLI at all. For such a run the field says nothing the request did not, and recording it
 * as "what ran" would show a worker's default as confirmed by a run that confirmed nothing. So a
 * value equal to what was asked for is not taken. What remains is a real statement by the CLI:
 * a run that named no model (Codex then passes on the id its event stream carries), or an
 * adapter that reports an id other than the one requested.
 *
 * The cost of the rule: an adapter that DID observe the requested id itself is indistinguishable
 * from one that echoed it, and its run records no `modelUsed` either. That loses a confirmation;
 * the other reading invents one. Pure and total.
 */
export function reportedProviderModel(requested: string | undefined, reported: unknown): string | undefined {
  if (typeof reported !== 'string' || !REPORTED_MODEL_ID.test(reported)) {
    return undefined;
  }
  const asked = typeof requested === 'string' ? requested.trim() : '';
  return asked !== '' && reported === asked ? undefined : reported;
}

/** Everything one run's classification needs to know. */
interface RunScope {
  provider: Exclude<ProviderId, 'claude'>;
  info: ProviderInfo;
  worker: WorkerProfile;
  adapter: Adapter;
  account: Account;
  seam: ProcessSeam;
  timeoutMs: number;
  /** The resolved executable and the request as it was handed to the adapter (adapterRequestNote). */
  binary: string;
  request: RunTask;
}

/** A process seam that starts nothing and reports a clean, empty exit. */
const NOTHING_RAN: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false });

/**
 * What the adapter has to say about the REQUEST, as opposed to what the vendor said about the
 * run: "this model is not in my catalog", "this account directory is passed as AGY_HOME and
 * its isolation is unverified". An adapter returns both in ONE string — its own remarks first,
 * the vendor's error after them — and a failure message has room for about one sentence, so
 * without telling the two apart the remark is what gets shown and the error is what gets cut.
 *
 * Asked of the adapter itself rather than recognised by its wording: the same request is put
 * through a second instance whose process seam starts nothing, and whatever note comes back
 * from a run in which nothing ran is, by construction, about the request. No sentence of any
 * adapter is spelled here, so a reworded or a new remark needs no change. '' when it has none,
 * or refuses the request outright. Starts no process and never throws.
 */
async function adapterRequestNote(scope: RunScope): Promise<string> {
  try {
    const dry = await createAdapter(scope.provider, scope.binary, NOTHING_RAN, AUTH_CONFIRM_TIMEOUT_MS).run(
      scope.request,
    );
    return typeof dry.note === 'string' ? dry.note : '';
  } catch {
    return '';
  }
}

/**
 * Split an adapter's note into the vendor's part and the adapter's own. When the note does not
 * start with what the adapter says about the bare request, nothing is known about its parts and
 * all of it counts as the vendor's — the direction that hides nothing.
 */
async function splitAdapterNote(scope: RunScope, note: string): Promise<{ vendor: string; adapter: string }> {
  if (note === '') {
    return { vendor: '', adapter: '' };
  }
  const own = await adapterRequestNote(scope);
  if (own === '' || !note.startsWith(own)) {
    return { vendor: note, adapter: '' };
  }
  return { vendor: note.slice(own.length).replace(/^;\s*/, ''), adapter: own };
}

/** The non-empty parts, each once, one per line — a vendor often says the same thing on two channels. */
function joinParts(parts: readonly string[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (text !== '' && !kept.includes(text)) {
      kept.push(text);
    }
  }
  return kept.join('\n');
}

/** The worker's own child: the first process the run started. */
function workerChild(scope: RunScope): ChildObservation | undefined {
  return scope.seam.children.find((child) => child.spawned);
}

/**
 * Is this account, by its own CLI's account of it, NOT logged in?
 *
 * Asked only after a run has already FAILED, and only when the vendor's own error text did not
 * already say so (failRun, isLoginFailureText). The adapters (0.1.x) report a logged-out account
 * as an ordinary failed run — none of them raises its own AuthError — so without a witness a dead
 * login would end the dispatch instead of moving it to the next account. This witness is the
 * adapter's `authStatus`, the same check the usage view shows. It is the SECOND one for a
 * reason measured live: a vendor's status command can answer "logged in" for an account whose
 * runs all fail to authenticate, so its "nothing is wrong" cannot overrule what the run said.
 *
 * `true` only on a POSITIVE reading: the check ran to completion and said "logged out". A check
 * that could not start, timed out or was killed proves nothing, and the failure then stays what
 * it was. Bounded by AUTH_CONFIRM_TIMEOUT_MS — plus, for a Codex account the adapter does not
 * call logged in, CODEX_LOGIN_STATUS_TIMEOUT_MS for the CLI's own answer, which then decides.
 * Every child it starts is covered by the run's kill().
 */
async function confirmLoggedOut(scope: RunScope): Promise<boolean> {
  if (scope.seam.cancelled()) {
    return false;
  }
  const before = scope.seam.children.length;
  scope.seam.setDeadline(Date.now() + AUTH_CONFIRM_TIMEOUT_MS);
  /** The adapter's verdict; undefined when its check proved nothing. */
  let adapterSays: boolean | undefined;
  try {
    const answer = await within(scope.adapter.authStatus(scope.account), AUTH_CONFIRM_TIMEOUT_MS + 1_000);
    if (answer.kind === 'value' && typeof answer.value?.loggedIn === 'boolean') {
      adapterSays = answer.value.loggedIn;
    }
  } catch {
    // a check that threw proved nothing
  }
  const probes = scope.seam.children.slice(before);
  if (probes.some((probe) => probe.timedOut || probe.spawnError !== undefined || probe.signal !== null)) {
    adapterSays = undefined;
  }
  // The Codex adapter reads a FILE, and a Codex login need not be in one (codexLoginStatus): its
  // "logged out", and its silence, are checked with the CLI before they cost an account its turn.
  if (adapterSays !== true && scope.provider === 'codex' && !scope.seam.cancelled()) {
    scope.seam.setDeadline(Date.now() + CODEX_LOGIN_STATUS_TIMEOUT_MS);
    const cliSays = await codexLoginStatus(scope.seam.exec, scope.binary, scope.worker.configDir);
    if (cliSays !== undefined) {
      return cliSays.loggedIn === false;
    }
  }
  return adapterSays === false;
}

/**
 * A dead login as the error the dispatch core acts on — ONE wording, whichever witness
 * established it: the vendor's own error text, the account's login check, or an adapter that
 * raised AuthError.
 *
 * OUR sentence comes first and carries the two things a reader needs — that the login is the
 * problem, and how the account is logged back in (the provider's login command, with the
 * account's home variable when it has one; or where to sign in, for a provider with no command).
 * The vendor's words follow and are what the length cap cuts: they are the evidence, and the
 * output file has all of them. They always keep LOGIN_LABEL_VENDOR_ROOM_CHARS of room, however
 * long the command is.
 */
function loginFailure(
  scope: Pick<RunScope, 'provider' | 'info' | 'worker'>,
  shown: string,
  detail: string,
): ProviderAuthError {
  const route = providerLoginRoute(scope.provider, scope.worker.configDir);
  const fix = 'command' in route ? `log in with "${route.command}"` : route.manual;
  const prefix = `${scope.info.label} account ${scope.worker.name} is not logged in — ${fix}, then retry. Its run failed: `;
  return new ProviderAuthError(
    failureLabel(prefix, shown, Math.max(FAILURE_LABEL_MAX_CHARS, prefix.length + LOGIN_LABEL_VENDOR_ROOM_CHARS)),
    detail,
  );
}

/**
 * Turn a failed run into the error the dispatch core acts on. Order matters:
 *
 *  1. THE WORKSPACE WAS REFUSED (workspaceRefusalHint) → a plain failure with one sentence
 *     saying what to do, typed so that nothing is filed against the account. First, because it
 *     is true of every account in this directory: asking whether this one is logged in, or
 *     moving on to the next, could only repeat it;
 *  2. NOT LOGGED IN, when the vendor's own error text says so (isLoginFailureText) → failover,
 *     no cooldown. Before the quota search on purpose: a login failure is the more specific
 *     statement of the two, and the sentence a logged-out CLI fails with may well go on to
 *     mention the limits of the plan it wants the user to sign in to;
 *  3. QUOTA, when the vendor's own error text says so (isQuotaError, the classifier every
 *     dispatch path uses) → cooldown and failover;
 *  4. NOT LOGGED IN, when the account's own login check says so (confirmLoggedOut) → as rule 2.
 *     Asked last, and only of a failure nothing above explained;
 *  5. otherwise a plain failure, which ends the dispatch.
 *
 * `vendorText` is everything the VENDOR said about the run, from every channel it could have
 * used — the error an adapter carried in its note, the result text, stderr — because no two of
 * these CLIs put a quota wall or a dead login in the same place. It is never a successful
 * answer. It is what the failure SHOWS and what is kept as evidence; it is not what is
 * classified.
 *
 * `errorChannel` is the part of that text that is the vendor's ERROR CHANNEL and nothing else,
 * and it is all that rules 1, 2 and 3 read — one text for every verdict that moves a task to
 * another account. The difference is a partial ANSWER: a worker that had written half a report
 * when the vendor's stream failed leaves that half in the result text, and a report may say "Not
 * logged in." on a line of its own because the task was a login page, or "the endpoint answers
 * 429 above the rate limit" because the task was a client for it. Read as the vendor's verdict,
 * the second of those cooled a healthy account down and ran the task again on the next one. So
 * the result text counts as the error channel only when the vendor carried no error of its own
 * beside it (see errorChannelOf). Defaults to all of `vendorText` for a run that produced no
 * answer at all.
 *
 * `remarks` is what is NOT the vendor's: the adapter's own remark about the request
 * (adapterRequestNote), and this module's about a truncated stream. It FOLLOWS the vendor's
 * text in the message, so it is what the length cap cuts; and it is kept out of every
 * classification — an adapter's remark quotes the requested model id, and an id is not evidence
 * of a rate limit however many digits it shares with a status code.
 */
async function failRun(
  scope: RunScope,
  prefix: string,
  vendorText: string,
  remarks = '',
  errorChannel: string = vendorText,
): Promise<never> {
  const said = evidence(vendorText);
  const remark = remarks.trim();
  const shown = remark === '' ? said : `${said}\n(note: ${remark})`;
  const detail = remark === '' ? said : evidence(`${vendorText}\n\n[note] ${remark}`);
  const name = scope.worker.name;
  // Rules 1 to 3 read the error channel AS THE VENDOR WROTE IT: none of them stores or shows
  // what it reads, and redaction exists for what is stored and shown. Each bounds its own work.
  const hint = workspaceRefusalHint(scope.provider, errorChannel);
  if (hint !== undefined) {
    const label = failureLabel(prefix, shown);
    throw new ProviderWorkspaceError(`${label}${/[.!?]$/.test(label) ? '' : '.'} ${hint}`, detail);
  }
  if (isLoginFailureText(errorChannel, scope.provider)) {
    throw loginFailure(scope, shown, detail);
  }
  if (isQuotaError(errorChannel)) {
    throw new ProviderQuotaError(
      failureLabel(`${scope.info.label} quota or rate limit reached on ${name}: `, shown),
      detail,
    );
  }
  if (await confirmLoggedOut(scope)) {
    throw loginFailure(scope, shown, detail);
  }
  throw new ProviderRunFailure(failureLabel(prefix, shown), detail);
}

/**
 * The vendor's ERROR CHANNEL of a run that came back with a result (failRun says why it is kept
 * apart from the rest): the error the adapter carried, and stderr — plus the result text, but
 * only when the adapter carried no error. A vendor that reports its failure AS the result text
 * (Cursor) has nothing else to say it in; one that reports it in an error event (Codex,
 * Antigravity) leaves the result text to whatever the worker had answered so far.
 */
function errorChannelOf(vendorNote: string, text: string, stderrTail: string): string {
  return joinParts(vendorNote.trim() !== '' ? [vendorNote, stderrTail] : [text, stderrTail]);
}

/**
 * What the PROCESS says happened, which outranks whatever the adapter made of its output.
 *
 * An adapter sees an exit code and a `timedOut` flag, nothing else — and reads a child killed by
 * a signal as exit 0. A worker that was cancelled halfway, after printing one interim message,
 * therefore comes back from the adapter as a successful run with that message as its answer.
 * These three facts are checked first so that can never be recorded as `done`.
 */
function processVerdict(scope: RunScope): ProviderError | undefined {
  const child = workerChild(scope);
  if (child?.timedOut === true || (child === undefined && scope.seam.children.some((c) => c.timedOut))) {
    return new ProviderTimeoutError(timeoutMessage(scope.info, scope.timeoutMs, child));
  }
  // Cancelled — unless the worker's own child had already finished, cleanly, before any signal
  // reached it (ChildObservation.stopped). A stop that was never delivered changes nothing about
  // what the run did: the request may be gone, but the answer is whole and is recorded, exactly
  // as a `claude -p` run that exited 0 before its cancel landed is. Once a signal WAS sent the
  // run is cancelled whatever its output parses as — an event stream cut short can still read
  // as an answer.
  const finishedFirst = child !== undefined && !child.stopped && child.exitCode === 0 && child.signal === null;
  if (scope.seam.cancelled() && !finishedFirst) {
    return new ProviderCancelledError(`the ${scope.info.label} worker was stopped — its run was cancelled`);
  }
  if (child !== undefined && child.signal !== null) {
    const external = child.signal === 'SIGTERM' || child.signal === 'SIGKILL';
    return external
      ? new ProviderKilledError(
          `Worker was terminated externally (${child.signal}) — most likely cancelled from the ` +
            `editor UI or killed by the OS — after ${child.stdoutBytes}/${child.stderrBytes} bytes of ` +
            `output (${scope.info.label}). Not a worker fault; not retried.`,
          evidence(child.stderrTail),
        )
      : new ProviderRunFailure(
          failureLabel(`${scope.info.label} worker was ended by ${child.signal}: `, child.stderrTail),
          evidence(child.stderrTail),
        );
  }
  return undefined;
}

/** A child that could not be started at all, said in terms of what to do about it. */
function spawnVerdict(scope: RunScope): ProviderError | undefined {
  const failed = scope.seam.children.find((child) => child.spawnError !== undefined);
  if (failed === undefined) {
    return undefined;
  }
  const { info } = scope;
  switch (failed.spawnError) {
    case 'ENOENT':
      return new ProviderCliError(cliMissingMessage(info));
    case 'EACCES':
      return new ProviderCliError(
        `The ${info.label} CLI ("${info.cli}") could not be started: it is not executable for this ` +
          'user (EACCES). Nothing was started.',
      );
    case 'E2BIG':
      return new ProviderRunFailure(
        `The task is too large for the ${info.label} CLI ("${info.cli}"), which takes the whole ` +
          'prompt as a command-line argument: the operating system refused the command line ' +
          '(E2BIG). Shorten the prompt or put the bulk in a file the worker can read. Nothing ' +
          'was started.',
      );
    default:
      return new ProviderCliError(
        `The ${info.label} CLI ("${info.cli}") could not be started (${failed.spawnError}). ` +
          'Nothing was started.',
      );
  }
}

/**
 * Run one task on a non-Claude worker through its vendor adapter, under this module's process
 * control. Resolves with the worker's answer; rejects with one of the Provider* errors above,
 * never with anything else.
 */
export async function runProviderWorker(req: ProviderRunRequest): Promise<ProviderRunOutcome> {
  const provider = parseProvider(req.worker.provider);
  if (provider === undefined || provider === 'claude') {
    throw new ProviderRunFailure(
      `worker ${flattenOneLine(req.worker.name)} is a Claude Code worker — it does not run through a provider adapter`,
    );
  }
  const info = providerInfo(provider);
  const cli = resolveProviderCli(info.cli);
  if (!cli.found) {
    throw new ProviderCliError(cliMissingMessage(info));
  }
  const seam = createProcessSeam({
    deadlineMs: Date.now() + req.timeoutMs,
    onChild: req.onChild,
    dispatchedTask: req.taskId,
  });
  const account = adapterAccount(provider, req.worker.configDir);
  const permissionMode = normalizeProviderPermissionMode(provider, req.worker.permissionMode);
  const scope: RunScope = {
    provider,
    info,
    worker: req.worker,
    adapter: createAdapter(provider, cli.command, seam.exec, AUTH_CONFIRM_TIMEOUT_MS),
    account,
    seam,
    timeoutMs: req.timeoutMs,
    binary: cli.command,
    request: {
      prompt: req.prompt,
      ...(req.model ? { model: req.model } : {}),
      cwd: req.cwd,
      account,
      ...(permissionMode !== null ? { permissionMode } : {}),
      timeoutMs: req.timeoutMs,
    },
  };

  let result: AdapterRunResult;
  try {
    result = await scope.adapter.run(scope.request);
  } catch (err) {
    const verdict = processVerdict(scope) ?? spawnVerdict(scope);
    if (verdict !== undefined) {
      throw verdict;
    }
    const message = err instanceof Error ? err.message : String(err);
    const stderr = typeof (err as { stderr?: unknown })?.stderr === 'string' ? (err as { stderr: string }).stderr : '';
    const said = stderr.trim() !== '' ? `${message}: ${stderr}` : message;
    if (isAdapterError(err, 'QuotaExceededError')) {
      throw new ProviderQuotaError(
        failureLabel(`${info.label} quota or rate limit reached on ${req.worker.name}: `, said),
        evidence(said),
      );
    }
    if (isAdapterError(err, 'AuthError')) {
      throw loginFailure(scope, evidence(said), evidence(said));
    }
    // Thrown before any process existed (a model this login may not select, an empty prompt):
    // the adapter refused the request, and the account's login has nothing to do with it.
    if (workerChild(scope) === undefined) {
      throw new ProviderRunFailure(failureLabel(`${info.label} worker could not be started: `, said), evidence(said));
    }
    return failRun(scope, `${info.label} worker failed: `, said);
  }

  const verdict = processVerdict(scope);
  if (verdict !== undefined) {
    throw verdict;
  }
  const child = workerChild(scope);
  const text = typeof result.text === 'string' ? result.text : '';
  const adapterNote = typeof result.note === 'string' ? result.note : '';
  const truncated =
    child?.truncated === true
      ? `the worker's output exceeded ${OUTPUT_CAP_BYTES / (1024 * 1024)} MiB and its middle was dropped`
      : '';

  switch (result.status) {
    case 'ok': {
      if (text.trim() === '') {
        throw new ProviderRunFailure(`${info.label} worker failed: the worker returned no text`);
      }
      const note = sliceOneLine(
        flattenOneLine(redactSecrets([adapterNote, truncated].filter(Boolean).join('; '))),
        NOTE_MAX_CHARS,
      );
      const modelUsed = reportedProviderModel(req.model, result.model);
      return {
        text,
        // What was asked for, first: the record's `model` is the request wherever there was one,
        // and what the vendor reports beside it is `modelUsed`. Only a run that named no model
        // takes the vendor's word here — it has nothing else to show. (The adapters in use hand
        // back the requested id whenever there is one, so this order changes no value they
        // produce today.)
        model: oneLineId(req.model) || oneLineId(result.model) || '-',
        ...(modelUsed !== undefined ? { modelUsed } : {}),
        inputTokens: tokenCount(result.usage?.inputTokens),
        outputTokens: tokenCount(result.usage?.outputTokens),
        conversationId: oneLineId(result.conversationId),
        note: note === '' ? undefined : note,
      };
    }
    case 'stopped':
      throw new ProviderCancelledError(`the ${info.label} worker was stopped — its run was cancelled`);
    case 'error': {
      // The vendor's error first — it is what a quota wall, a dead login or a refused model is
      // said in, and it can be in the note, in the text or only on stderr. Any partial answer
      // the adapter preserved is part of `text`. The adapter's own remarks come last.
      const note = await splitAdapterNote(scope, adapterNote);
      return failRun(
        scope,
        `${info.label} worker reported an error: `,
        joinParts([note.vendor, text, child?.stderrTail ?? '']),
        joinParts([note.adapter, truncated]),
        errorChannelOf(note.vendor, text, child?.stderrTail ?? ''),
      );
    }
    default: {
      // 'incomplete' that was not a timeout (handled above), or a status this code does not know.
      const exit =
        child === undefined || child.exitCode === null ? '' : ` (the CLI exited with code ${child.exitCode})`;
      const note = await splitAdapterNote(scope, adapterNote);
      return failRun(
        scope,
        `${info.label} worker ended without a final answer${exit}: `,
        joinParts([note.vendor, text, child?.stderrTail ?? '']),
        joinParts([note.adapter, truncated]),
        errorChannelOf(note.vendor, text, child?.stderrTail ?? ''),
      );
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Account status
 * ------------------------------------------------------------------------- */

type Settled<T> = { kind: 'value'; value: T } | { kind: 'timeout' };

/** `promise`, or `timeout` after `ms`. A rejection propagates. Leaves no timer behind. */
function within<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: 'value', value });
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function statusError(text: string): string {
  return sliceOneLine(flattenOneLine(redactSecrets(text)), 200);
}

/** A reading that knows nothing beyond `error` — and does not claim the CLI is missing. */
function unknownStatus(error: string): ProviderStatus {
  return { cliFound: true, loggedIn: null, mode: null, quota: null, error: statusError(error) };
}

/**
 * An adapter's quota snapshot as the frozen `ProviderStatus.quota` shape. By VALUE: a window
 * without a finite percentage is not a reading and is left out; a reset time that is not a date
 * is "unknown"; the vendor's raw payload is never looked at. `null` stays `null` — "no usage
 * reading", which is not "no usage".
 */
export function quotaFromSnapshot(snapshot: QuotaSnapshot | null | undefined): ProviderStatus['quota'] {
  if (typeof snapshot !== 'object' || snapshot === null) {
    return null;
  }
  const windows: NonNullable<ProviderStatus['quota']>['windows'] = [];
  for (const raw of Array.isArray(snapshot.windows) ? snapshot.windows.slice(0, 8) : []) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const used = raw.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) {
      continue;
    }
    const label = typeof raw.label === 'string' ? sliceOneLine(flattenOneLine(raw.label), 40) : '';
    const reset = typeof raw.resetAt === 'string' ? Date.parse(raw.resetAt) : NaN;
    windows.push({
      label: label === '' ? `window ${windows.length + 1}` : label,
      usedPercent: Math.max(0, Math.min(100, used)),
      resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    });
  }
  return {
    // The vendor's own gate when it states one; otherwise a spent window is the gate.
    allowed:
      typeof snapshot.allowed === 'boolean' ? snapshot.allowed : !windows.some((window) => window.usedPercent >= 100),
    windows,
  };
}

/**
 * One status reading taken THROUGH an adapter: its login check, then — whenever a usage reading
 * was asked for — its `quota()`.
 *
 * Between the two, when the adapter did not say "logged in" and the caller supplied one, the
 * CLI's own answer (`opts.cliLogin`) is asked and, when it gives a verdict, replaces the
 * adapter's. `quota` is unaffected by which of them said so: an account the CLI calls logged in
 * while the adapter finds no login file has no usage reading, which is `null`, not an error.
 *
 * `quota()` is called for EVERY adapter, whatever its vendor and whatever its `capabilities`
 * say: which vendors can report usage is a fact about the installed library version, not about
 * this code, and an adapter that starts returning a snapshot must light the UI up with no change
 * here. A `null` from it is passed on as `null`.
 *
 * `children` is the process record of the seam the adapter was built on; it is what separates
 * "the CLI says logged out" from "the check never ran", which the adapter's answer alone cannot.
 * Exported for the verification harness; production code calls providerStatus.
 */
export async function statusFromAdapter(
  adapter: Pick<Adapter, 'authStatus' | 'quota'>,
  account: Account,
  children: readonly Pick<ChildObservation, 'spawnError' | 'timedOut' | 'signal'>[],
  opts: {
    quota: boolean;
    deadlineMs: number;
    cli: string;
    /**
     * The CLI's own answer about its login, asked only when the adapter did not say "logged in"
     * (Codex: codexLoginStatus). A verdict from it REPLACES the adapter's; no verdict leaves the
     * adapter's untouched. Must not reject and must bound itself.
     */
    cliLogin?: () => Promise<CliLoginVerdict | undefined>;
  },
): Promise<ProviderStatus> {
  const status: ProviderStatus = { cliFound: true, loggedIn: null, mode: null, quota: null, error: null };
  const remaining = (): number => opts.deadlineMs - Date.now();

  const before = children.length;
  try {
    const answer = await within(adapter.authStatus(account), remaining());
    const probes = children.slice(before);
    if (probes.some((probe) => probe.spawnError === 'ENOENT')) {
      return { ...status, cliFound: false, error: statusError(`${opts.cli} could not be started (not found)`) };
    }
    if (answer.kind === 'timeout' || probes.some((probe) => probe.timedOut)) {
      status.error = 'the login check did not answer in time';
    } else if (probes.some((probe) => probe.spawnError !== undefined || probe.signal !== null)) {
      status.error = 'the login check could not run';
    } else if (typeof answer.value?.loggedIn === 'boolean') {
      status.loggedIn = answer.value.loggedIn;
      const mode = typeof answer.value.mode === 'string' ? sliceOneLine(flattenOneLine(answer.value.mode), 32) : '';
      status.mode = mode === '' ? null : mode;
    } else {
      status.error = 'the login check returned no answer';
    }
  } catch (err) {
    status.error = statusError(`the login check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (status.loggedIn !== true && opts.cliLogin !== undefined && remaining() > 0) {
    try {
      const said = await opts.cliLogin();
      if (said !== undefined) {
        status.loggedIn = said.loggedIn;
        // Logged in: the mode the CLI named, else whatever the adapter had. Logged out: none.
        status.mode = said.loggedIn ? (said.mode ?? status.mode) : null;
        // Whatever the adapter's check could not establish, the CLI just did.
        status.error = null;
      }
    } catch {
      // no verdict — the adapter's stands
    }
  }

  if (opts.quota) {
    try {
      const answer = await within(adapter.quota(account), remaining());
      if (answer.kind === 'timeout') {
        status.error ??= 'the usage reading did not answer in time';
      } else {
        status.quota = quotaFromSnapshot(answer.value);
      }
    } catch (err) {
      status.error ??= statusError(`the usage reading failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return status;
}

/**
 * What is known about one non-Claude account right now: is its CLI there, is it logged in, and —
 * when `quota` is asked for — its usage windows. The frozen ProviderStatus shape; NEVER rejects.
 *
 * For a Codex account the login is the adapter's verdict, corrected by the CLI's own
 * (codexLoginStatus) whenever the adapter does not say "logged in": a login kept in the OS
 * keyring is invisible to the adapter's file read.
 *
 * `quota` is opt-in per call because for some vendors it is a network request made with the
 * account's own local login; whether to make it is the caller's decision (an operator setting),
 * never this function's. `timeoutMs` bounds the whole reading.
 */
export async function providerStatus(
  worker: { provider: ProviderId; configDir: string },
  opts: { quota?: boolean; timeoutMs?: number } = {},
): Promise<ProviderStatus> {
  try {
    const provider = parseProvider(worker?.provider);
    if (provider === undefined || provider === 'claude') {
      return unknownStatus('not an account this reader covers: only Codex, Cursor and Antigravity accounts are read here');
    }
    if (typeof worker.configDir !== 'string' || worker.configDir.trim() === '') {
      return unknownStatus('no account directory was given');
    }
    const info = providerInfo(provider);
    const cli = resolveProviderCli(info.cli);
    if (!cli.found) {
      return {
        cliFound: false,
        loggedIn: null,
        mode: null,
        quota: null,
        error: statusError(`${info.cli} not found — the ${info.label} CLI is not installed or not on PATH`),
      };
    }
    const requested = opts.timeoutMs;
    const budget =
      typeof requested === 'number' && Number.isFinite(requested)
        ? Math.max(1_000, Math.min(120_000, requested))
        : STATUS_TIMEOUT_DEFAULT_MS;
    const deadlineMs = Date.now() + budget;
    const seam = createProcessSeam({ deadlineMs });
    return await statusFromAdapter(
      createAdapter(provider, cli.command, seam.exec, budget),
      adapterAccount(provider, worker.configDir),
      seam.children,
      {
        quota: opts.quota === true,
        deadlineMs,
        cli: info.cli,
        // A Codex login can live in the OS keyring, where the adapter's file read cannot see it.
        ...(provider === 'codex'
          ? {
              cliLogin: () =>
                codexLoginStatus(
                  seam.exec,
                  cli.command,
                  worker.configDir,
                  Math.max(1, Math.min(CODEX_LOGIN_STATUS_TIMEOUT_MS, deadlineMs - Date.now())),
                ),
            }
          : {}),
      },
    );
  } catch (err) {
    return unknownStatus(`the status check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------------- *
 * Model catalog
 * ------------------------------------------------------------------------- */

/**
 * The models an account of another vendor's CLI can be given — the single shape the bundled
 * helper prints as one line of JSON (`out/mcp/provider-cli.js models …`) for the pickers of the
 * extension host.
 *
 * A LIST TO CHOOSE FROM, NEVER A VALIDATION LIST: these catalogs are large and change often, and
 * an id that is not in one still runs (normalizeProviderModel decides what may be stored). So a
 * stored default that a catalog does not name is a default like any other.
 *
 * `error` is null exactly when `models` holds at least one entry.
 */
export interface ProviderModelCatalog {
  /**
   * The provider's OWN models first, then the ones it resells from another vendor — each group
   * in the order the listing gave them — no id twice, at most 600.
   *
   * `id` is one normalizeProviderModel accepts for the provider as it stands, ≤ 128 chars.
   * `label` is the display name the vendor CLI PRINTED for the model, as one line, ≤ 80 chars —
   * and nothing an adapter added to it. Left out when the CLI printed none, and always for a
   * built-in catalog: that text is the adapter's, not the CLI's.
   * `resold: true` marks a model of another vendor's family (providers.isOwnModelFamily): it
   * spends this account's plan on a model another worker account may already pay for. The key
   * is absent for the provider's own.
   * `default: true` marks the model the CLI said it runs when none is named — on ONE entry at
   * most, and only when the CLI's own answer said so (Codex: `codex app-server` model/list's
   * `isDefault`); never on a built-in catalog.
   * `efforts` are the reasoning efforts the CLI's answer lists for the model, in its order: each
   * a short lower-case word (`low`, `xhigh`), at most 6, on the first 64 entries; absent when the
   * answer named none.
   * The keys come in that order: id, label, resold, default, efforts.
   */
  models: Array<{ id: string; label?: string; resold?: true; default?: true; efforts?: string[] }>;
  /**
   * `live`: the vendor CLI was asked now, and this is what it listed. `static`: the adapter's
   * built-in catalog — because that vendor's adapter has no live listing, or because its CLI
   * could not be asked or gave no listing.
   */
  source: 'live' | 'static';
  /** Why there is no catalog, flattened, ≤ 200 chars. */
  error: string | null;
}

/** An answer with no catalog in it. Nothing was listed, so nothing is claimed to be live. */
function noCatalog(error: string): ProviderModelCatalog {
  return { models: [], source: 'static', error: statusError(error) || 'no model could be listed' };
}

/** Joiners and spaces at an end of a label: with nothing on one side of them they join nothing. */
const LABEL_EDGE = /^[‌‍\s]+|[‌‍\s]+$/g;

/**
 * A display name as one line of at most MODEL_LABEL_MAX_CHARS, or '' when it holds no visible
 * text.
 *
 * Real listings are not clean: a display name arrives with doubled spaces, a tab, and zero-width
 * characters after it. The shared one-line rule (displayText.flattenOneLine) removes what cannot
 * be seen and collapses what is blank — except the two joiners it keeps on purpose, because
 * inside a word or an emoji sequence they change what is drawn. At the END of a label, or as all
 * of one, they draw nothing, so they are taken off the edges here: a label made only of
 * invisible characters is then '' and is left out, rather than shown as a blank that is not
 * empty. The cut is sliceOneLine's, so it never leaves half a character, and whatever the cut
 * left dangling at the end is taken off again.
 *
 * Not put through redactSecrets: that is for failure diagnostics, and it reads "Basic Reasoning"
 * as a credential.
 */
function catalogLabel(raw: string): string {
  // The input is cut to a window first: the flattener is several regex passes over the value.
  const flat = flattenOneLine(raw.length > 4096 ? raw.slice(0, 4096) : raw).replace(LABEL_EDGE, '');
  return sliceOneLine(flat, MODEL_LABEL_MAX_CHARS).replace(LABEL_EDGE, '');
}

/** Longest line of a CLI's listing, and longest adapter label, a display name is looked for in. */
const PRINTED_LINE_MAX_CHARS = 4096;
/**
 * How many lines of a listing are looked at, and how many lines that merely MENTION a model id
 * are kept for it beside its own line (linesNaming).
 */
const PRINTED_LINES_SCAN_MAX = 100_000;
const PRINTED_LINES_PER_ID = 8;

/**
 * For each of `ids`, the lines of `printed` — what a vendor CLI wrote when it listed its models
 * — that NAME it: the id stands on the line as a word of its own. Each line without its trailing
 * blanks, from the first PRINTED_LINES_SCAN_MAX lines.
 *
 * TWO KINDS OF LINE NAME AN ID, and they do not count alike:
 *  - a line that BEGINS with the id is that model's own line. The first such line is THE line
 *    for the id, whatever else names it, and nothing else is returned for that id;
 *  - a line that only mentions the id further in — another model's display name that happens to
 *    hold it as a word — counts only for an id no line begins with (a listing that does not put
 *    the id first), and at most PRINTED_LINES_PER_ID of them are kept. Before the two were told
 *    apart, a model whose id was a word in that many EARLIER display names never had its own
 *    line looked at, and lost its label.
 *
 * Nothing else of the listing's FORMAT is assumed: what separates the id from the name is the
 * adapter's to know. A line longer than a listing line can be is skipped.
 */
function linesNaming(printed: string, ids: ReadonlySet<string>): Map<string, string[]> {
  const own = new Map<string, string>();
  const mentions = new Map<string, string[]>();
  let from = 0;
  for (let n = 0; n < PRINTED_LINES_SCAN_MAX && from <= printed.length; n++) {
    const nl = printed.indexOf('\n', from);
    const to = nl === -1 ? printed.length : nl;
    if (to - from <= PRINTED_LINE_MAX_CHARS) {
      const line = printed.slice(from, to).trimEnd();
      const words = line.split(/\s+/);
      // A line that starts with blanks has an empty first piece: the id is then the second.
      const first = words[0] === '' ? words[1] : words[0];
      if (first !== undefined && ids.has(first) && !own.has(first)) {
        own.set(first, line);
      }
      for (const word of words) {
        if (ids.has(word)) {
          const lines = mentions.get(word) ?? [];
          if (lines.length < PRINTED_LINES_PER_ID && !lines.includes(line)) {
            lines.push(line);
            mentions.set(word, lines);
          }
        }
      }
    }
    if (nl === -1) {
      break;
    }
    from = nl + 1;
  }
  const found = new Map<string, string[]>();
  for (const id of ids) {
    const first = own.get(id);
    const lines = first !== undefined ? [first] : mentions.get(id);
    if (lines !== undefined) {
      found.set(id, lines);
    }
  }
  return found;
}

/**
 * The longest START of `label` that `line` ENDS with, as a whole run of words (what stands
 * before it on the line is a blank, or nothing) — '' when there is none.
 *
 * Linear in the two lengths (the prefix function of `label`, a separator no text contains, then
 * `line`), because both come from a vendor CLI: the obvious loop is quadratic, and this runs
 * once per listed model.
 */
function printedStart(label: string, line: string): string {
  const a = label.length > PRINTED_LINE_MAX_CHARS ? label.slice(0, PRINTED_LINE_MAX_CHARS) : label;
  const total = a.length + 1 + line.length;
  const unit = (i: number): number =>
    i < a.length ? a.charCodeAt(i) : i === a.length ? -1 : line.charCodeAt(i - a.length - 1);
  const border = new Int32Array(total);
  for (let i = 1; i < total; i++) {
    let k = border[i - 1];
    while (k > 0 && unit(i) !== unit(k)) {
      k = border[k - 1];
    }
    border[i] = unit(i) === unit(k) ? k + 1 : k;
  }
  // The longest first; each shorter candidate is the next border of the one before it.
  for (let k = border[total - 1]; k > 0; k = border[k - 1]) {
    const at = line.length - k;
    if (at === 0 || /\s/.test(line[at - 1])) {
      return a.slice(0, k);
    }
  }
  return '';
}

/**
 * The display name the CLI printed for a model, out of the label an adapter hands over for it —
 * or '' when no part of that label can be shown to be the CLI's.
 *
 * WHY THE ADAPTER'S LABEL IS NOT SIMPLY SHOWN. An adapter may add words of its own to a name:
 * the Cursor adapter appends a sentence to the name of every model it takes for another
 * vendor's, and another to `auto`; the Antigravity adapter's built-in catalog carries a remark
 * in brackets after some names. Those are remarks for a router, in English, long enough that a
 * cut label is mostly remark — and what they say is on the entry already, as `resold`. A picker
 * says such things in its own words; a label is the name.
 *
 * HOW THE NAME IS TOLD FROM THE REMARK — by comparing the label with its undecorated source, the
 * CLI's own output, and never by knowing the adapter's wording (no sentence of any adapter is
 * spelled in this file; a reworded or a new remark needs no change here). The name is the
 * longest start of the label that the CLI printed at the end of a line naming the model. An
 * adapter that adds nothing has its whole label there; one that appends to the name has the
 * name there and its own words nowhere; one that puts words in front of the name, or whose label
 * has no name in it at all, has nothing there — and that label is left out rather than guessed
 * at. What comes back is therefore always text the CLI itself printed.
 */
function printedName(label: unknown, lines: readonly string[] | undefined): string {
  if (typeof label !== 'string' || label === '' || lines === undefined) {
    return '';
  }
  let best = '';
  for (const line of lines) {
    const start = printedStart(label, line);
    if (start.length > best.length) {
      best = start;
    }
  }
  return best === '' ? '' : catalogLabel(best);
}

/** A reasoning-effort list as a listing gives it, as at most EFFORTS_PER_MODEL_MAX short words. */
function effortWords(raw: unknown): string[] {
  const words: string[] = [];
  if (!Array.isArray(raw)) {
    return words;
  }
  for (const item of raw.slice(0, 64)) {
    if (typeof item === 'string' && item.length <= EFFORT_MAX_CHARS && EFFORT_WORD.test(item) && !words.includes(item)) {
      words.push(item);
      if (words.length === EFFORTS_PER_MODEL_MAX) {
        break;
      }
    }
  }
  return words;
}

/**
 * Where a listing's words come from, for catalogEntries: the text the CLI printed for it
 * (`printed`), or — for a listing that IS the CLI's answer field by field — its entries
 * themselves (`cliFields`). Neither, for an adapter's built-in catalog.
 */
export type CatalogSource = string | { cliFields: true } | undefined;

/**
 * An adapter's model listing as catalog entries, BY VALUE: the listing is whatever a vendor CLI
 * printed, parsed by the adapter, and it is going onto a line of JSON a picker renders.
 *
 * WHICH ENTRIES. One counts when it is an object whose `id` is a string the provider's model
 * rule accepts AS IT STANDS (providers.normalizeProviderModel returns it unchanged), within
 * MODEL_ID_MAX_CHARS. An id the rule would have to trim or alter is left out, not repaired: what
 * is listed here is what gets stored and handed back to the CLI, and that has to be the id the
 * CLI printed. A second entry of an id already taken is left out too.
 *
 * WHAT ORDER. The provider's own models, then the resold ones (providers.isOwnModelFamily; a
 * resold entry carries `resold: true`), each group in the order the listing had them.
 *
 * WHICH LABELS. `source` (CatalogSource) says where a label may come from:
 *  - the text the CLI printed for a live listing (a string): a label is the part of the
 *    adapter's label that stands in it (printedName), cleaned to one line (catalogLabel);
 *  - `{ cliFields: true }`: the listing is the CLI's own answer, field by field, with nothing of
 *    an adapter's in it — Codex's `fetchLiveModels`, which maps `codex app-server`'s model/list
 *    entries (`displayName` → `label`, `isDefault` → `default`, `supportedReasoningEfforts` →
 *    `efforts`) and adds no word (agent-mesh-codex models.ts). Its label is then the CLI's
 *    display name, cleaned to one line;
 *  - nothing — an adapter's built-in catalog: no entry has a label. Nothing in such a catalog was
 *    printed by a CLI, and where its text holds a remark of the adapter's there is nothing to
 *    tell the remark from the name by.
 *
 * DEFAULT AND EFFORTS come from a `cliFields` listing only: the first entry it calls its default
 * gets `default: true`, and an entry it lists efforts for gets them (short lower-case words, at
 * most EFFORTS_PER_MODEL_MAX), not past EFFORT_ENTRIES_MAX entries. A table and a built-in
 * catalog say neither.
 *
 * HOW MANY. At most MODELS_MAX, found among the first MODELS_SCAN_MAX entries — a listing of
 * megabytes costs a bounded scan and produces a bounded line (MODELS_MAX says how its size is
 * kept inside the helper's budget). The scan ends early once the provider's own models alone
 * fill the catalog; a cut, when there is one, falls on the resold models listed last.
 *
 * Total over what it is handed in production: JSON-like values out of an adapter's parser. It
 * reads properties, so an object with a getter that throws would throw here; no adapter makes
 * one.
 *
 * Exported for the verification harness; production code calls providerModels.
 */
export function catalogEntries(
  provider: Exclude<ProviderId, 'claude'>,
  listed: unknown,
  source?: CatalogSource,
): ProviderModelCatalog['models'] {
  if (!Array.isArray(listed)) {
    return [];
  }
  const own: Array<{ id: string; label: unknown; fields: { default?: unknown; efforts?: unknown } }> = [];
  const resold: Array<{ id: string; label: unknown; fields: { default?: unknown; efforts?: unknown } }> = [];
  const seen = new Set<string>();
  const scan = Math.min(listed.length, MODELS_SCAN_MAX);
  for (let i = 0; i < scan && own.length < MODELS_MAX; i++) {
    const entry: unknown = listed[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const raw = entry as { id?: unknown; label?: unknown; default?: unknown; efforts?: unknown };
    // The length first: the rule's own check is a regular expression, and an id is short.
    if (typeof raw.id !== 'string' || raw.id.length > MODEL_ID_MAX_CHARS) {
      continue;
    }
    if (normalizeProviderModel(provider, raw.id) !== raw.id || seen.has(raw.id)) {
      continue;
    }
    seen.add(raw.id);
    (isOwnModelFamily(provider, raw.id) ? own : resold).push({
      id: raw.id,
      label: raw.label,
      fields: { default: raw.default, efforts: raw.efforts },
    });
  }
  const chosen = [
    ...own.map((entry) => ({ ...entry, isResold: false })),
    ...resold.map((entry) => ({ ...entry, isResold: true })),
  ].slice(0, MODELS_MAX);
  const cliFields = typeof source === 'object' && source !== null && source.cliFields === true;
  // Only for the entries that are listed: the CLI's text is read once, for their ids.
  const named =
    typeof source === 'string' && source !== ''
      ? linesNaming(source, new Set(chosen.map((entry) => entry.id)))
      : undefined;
  let defaultShown = false;
  return chosen.map(({ id, label: adapterLabel, fields, isResold }, index) => {
    const label = cliFields
      ? typeof adapterLabel === 'string'
        ? catalogLabel(adapterLabel)
        : ''
      : printedName(adapterLabel, named?.get(id));
    const isDefault = cliFields && fields.default === true && !defaultShown;
    defaultShown ||= isDefault;
    const words = cliFields && index < EFFORT_ENTRIES_MAX ? effortWords(fields.efforts) : [];
    const efforts = words.length > 0 ? words : undefined;
    return {
      id,
      ...(label === '' ? {} : { label }),
      ...(isResold ? { resold: true as const } : {}),
      ...(isDefault ? { default: true as const } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
    };
  });
}

/** Whether two listings name the same ids with the same labels, in the same order. */
function sameListing(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((entry: unknown, i) => {
    const x = entry as { id?: unknown; label?: unknown } | null;
    const y = b[i] as { id?: unknown; label?: unknown } | null;
    return x?.id === y?.id && x?.label === y?.label;
  });
}

/**
 * The adapter's BUILT-IN catalog for an account: what its `availableModels` answers when no
 * process can be started — the same way adapterRequestNote asks an adapter about a request. The
 * Codex adapter reads the account's login file to leave out the ids that login cannot select;
 * the other two answer from a list in their own source.
 *
 * Codex's adapter from 0.1.2 starts `codex app-server` itself, outside the process seam, to
 * list live — so it is given a binary that cannot be started at all (the empty name: a spawn of
 * it throws before any process exists), and answers its static catalog, gated by the login, as
 * it does for a CLI that is not installed. Up to 0.1.1 it starts nothing either way.
 */
function builtInModels(provider: Exclude<ProviderId, 'claude'>, binary: string, account: Account): Promise<unknown> {
  return createAdapter(provider, provider === 'codex' ? '' : binary, NOTHING_RAN, AUTH_CONFIRM_TIMEOUT_MS).availableModels(
    account,
  );
}

/** What agent-mesh-codex's `fetchLiveModels` is called with (its FetchLiveModelsOptions). */
interface CodexLiveOptions {
  binary?: string;
  codexHome?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * The Codex package's live listing — `fetchLiveModels`, and the ids of `STATIC_MODELS` beside it
 * (agent-mesh-codex 0.1.2) — or undefined when the installed version has none. Read off the
 * module when it is asked for, by value: the version this repository is built against may
 * predate both.
 */
function codexLiveListing():
  | { fetchLiveModels: (opts: CodexLiveOptions) => unknown; staticIds: ReadonlySet<string> | undefined }
  | undefined {
  const pkg = codexPackage as unknown as { fetchLiveModels?: unknown; STATIC_MODELS?: unknown };
  if (typeof pkg.fetchLiveModels !== 'function') {
    return undefined;
  }
  const staticModels: unknown = pkg.STATIC_MODELS;
  const staticIds = Array.isArray(staticModels)
    ? new Set(
        staticModels
          .map((m: unknown) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string'),
      )
    : undefined;
  return { fetchLiveModels: pkg.fetchLiveModels as (opts: CodexLiveOptions) => unknown, staticIds };
}

/**
 * How long past its own deadline a Codex listing may take to settle: the package kills the
 * app-server's process group at `timeoutMs` and waits up to 2 s for it to be gone.
 */
const CODEX_LISTING_SETTLE_MS = 2_500;

/** Is `p` an existing directory (a link to one included)? Never throws. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What `codex app-server` lists for an account NOW, through the package's `fetchLiveModels` —
 * or undefined when it listed nothing. Never throws.
 *
 * "LIVE ONLY WHEN THE CLI ANSWERED AND ENDED BY ITSELF" is the package's own contract here, and
 * the reason it can be taken at its word: `fetchLiveModels` resolves entries only when the
 * app-server answered every page AND exited by itself with code 0 once its stdin was closed;
 * every other outcome — no CLI, an error, a malformed line, an early or non-zero exit, the
 * deadline — is `[]`, with the app-server's whole process group killed first. The app-server is
 * the package's child, not this module's: started in a process group of its own, so the
 * helper's stop does not reach it — the package's deadline and the stdin it shares with this
 * process (closed when this process ends) are what end it.
 *
 * THE LOGIN'S GATE, as the adapter applies it to the same listing (`availableModels`): an id its
 * static catalog holds and its built-in answer for this account leaves out (`builtIn`, an
 * API-key-only id under a ChatGPT login) is taken out of the live listing too. With no usable
 * built-in answer nothing is taken out.
 */
async function codexLiveModels(
  codex: NonNullable<ReturnType<typeof codexLiveListing>>,
  binary: string,
  configDir: string,
  builtIn: unknown,
  budgetMs: number,
): Promise<{ listed: unknown[]; source: CatalogSource } | undefined> {
  try {
    const home = adapterAccountDir('codex', configDir);
    // An account home that does not exist holds no login: the CLI is not started for it, and the
    // built-in catalog answers (with 0.1.1 adapters nothing was started for such a home either).
    if (home !== undefined && !isDirectory(home)) {
      return undefined;
    }
    const listing = Promise.resolve(
      codex.fetchLiveModels({
        binary,
        ...(home !== undefined ? { codexHome: home } : {}),
        env: vendorChildEnv(),
        timeoutMs: budgetMs,
      }),
    );
    const answer = await within(listing, budgetMs + CODEX_LISTING_SETTLE_MS);
    if (answer.kind !== 'value' || !Array.isArray(answer.value) || answer.value.length === 0) {
      return undefined;
    }
    const idOf = (entry: unknown): unknown =>
      typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
    const offered = Array.isArray(builtIn) ? new Set(builtIn.map(idOf)) : undefined;
    const blocked =
      offered === undefined || codex.staticIds === undefined
        ? new Set<string>()
        : new Set([...codex.staticIds].filter((id) => !offered.has(id)));
    const listed = (answer.value as unknown[]).filter((entry) => {
      const id = idOf(entry);
      return !(typeof id === 'string' && blocked.has(id));
    });
    return listed.length > 0 ? { listed, source: { cliFields: true } } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the vendor CLI itself lists for an account when asked NOW, with the text it printed — or
 * undefined when it was not asked, could not be, or gave nothing that is a listing. Bounded by
 * `budgetMs`. Whatever an adapter or the process seam throws or rejects with ends as undefined.
 *
 * WHICH CALL IS THE LIVE ONE is the adapter's to say, and the three say it differently:
 *  - Antigravity keeps its `availableModels` static on purpose and exports the live counterpart
 *    beside it (`fetchLiveModels`, which runs `agy models`). That function takes no account, so
 *    the account's home variable is added to the environment here, by the rule the adapter itself
 *    applies to a run: only when the account's directory is not the default home;
 *  - Cursor's `availableModels` IS live (`cursor-agent models`) and falls back to a short list of
 *    its own, silently, whenever that fails;
 *  - Codex's is a list in the adapter's source up to 0.1.1, and starts no process. From 0.1.2 the
 *    package exports the live listing (`fetchLiveModels`: one `codex app-server` session, started
 *    by the package itself), and that is what is asked — codexLiveModels, whose header says why
 *    its answer is taken at its word.
 * Through the seam, nothing is believed "live" on the adapter's word alone. It is live only when a process was
 * actually started for it and ended cleanly by itself — exit 0, not stopped, nothing dropped from
 * its output — and when what came back is not simply the adapter's built-in catalog (`builtIn`),
 * which is what a fallback returns. An adapter that starts listing live in a later version then
 * says `live` here with no change to this code, and one that falls back says `static`.
 */
async function liveModels(
  provider: Exclude<ProviderId, 'claude'>,
  binary: string,
  account: Account,
  configDir: string,
  builtIn: unknown,
  budgetMs: number,
): Promise<{ listed: unknown[]; source: CatalogSource } | undefined> {
  const codex = provider === 'codex' ? codexLiveListing() : undefined;
  if (codex !== undefined) {
    return codexLiveModels(codex, binary, configDir, builtIn, budgetMs);
  }
  try {
    const seam = createProcessSeam({ deadlineMs: Date.now() + budgetMs });
    const env: Record<string, string | undefined> = { ...vendorChildEnv() };
    const info = providerInfo(provider);
    const home = adapterAccountDir(provider, configDir);
    if (home !== undefined && info.homeEnv !== null) {
      env[info.homeEnv] = home;
    }
    // What the CLI printed is kept beside what the adapter made of it: it is the undecorated
    // source a label is compared with (printedName). An adapter composes its own environment
    // for a child; only a call that passes none is given the account's here.
    const printed: string[] = [];
    const exec: ExecFn = async (req) => {
      const answer = await seam.exec({ ...req, env: req.env ?? env });
      printed.push(answer.stdout);
      return answer;
    };
    const listing: Promise<unknown> =
      provider === 'gemini'
        ? fetchLiveModels({ exec, binary, timeoutMs: budgetMs })
        : createAdapter(provider, binary, exec, budgetMs).availableModels(account);
    // The seam stops the child at the deadline and the call then settles by itself; the margin
    // is for that. A child that outlasts it is ignoring the stop, and is killed outright.
    const answer = await within(listing, budgetMs + 500);
    if (answer.kind === 'timeout') {
      seam.kill();
      seam.kill();
      await within(
        listing.catch(() => undefined),
        2_000,
      );
      return undefined;
    }
    const listed: unknown = answer.value;
    const asked = seam.children;
    const clean =
      asked.length > 0 &&
      asked.every(
        (child) =>
          child.spawned &&
          child.exitCode === 0 &&
          child.signal === null &&
          !child.timedOut &&
          !child.stopped &&
          !child.truncated,
      );
    if (!clean || !Array.isArray(listed) || listed.length === 0 || sameListing(listed, builtIn)) {
      return undefined;
    }
    return { listed, source: printed.join('\n') };
  } catch {
    return undefined;
  }
}

/**
 * The model catalog of one non-Claude account: what its CLI lists when it can be asked, else the
 * adapter's built-in catalog (ids only — see catalogEntries on labels). The frozen
 * ProviderModelCatalog shape. It does not reject for what an adapter, the process seam or the
 * CLI lookup throws: all of it runs inside one guard, and an Error (or any ordinary value)
 * caught there becomes `error`.
 *
 * Every process is started through this module's own seam, so it runs in the vendor-child
 * environment (no Anthropic variable reaches it), in its own process group, with its output
 * bounded, and is stopped when its budget ends. `timeoutMs` bounds the whole answer and can only
 * shorten it (1 s to MODELS_TIMEOUT_MS); the CLI is given that minus MODELS_ANSWER_MARGIN_MS, so
 * one that hangs still leaves time for the built-in catalog to be the answer.
 *
 * A CLI that is not installed is not an error here: nothing could be asked, and the adapter's
 * catalog answers (`static`). `error` is for the cases with no catalog at all — not a provider
 * this covers, no directory, a listing with no usable id in it, a failure nobody planned for.
 */
export async function providerModels(
  worker: { provider: ProviderId; configDir: string },
  opts: { timeoutMs?: number } = {},
): Promise<ProviderModelCatalog> {
  try {
    const provider = parseProvider(worker?.provider);
    if (provider === undefined || provider === 'claude') {
      return noCatalog('not a provider this lists models for: only Codex, Cursor and Antigravity accounts are covered');
    }
    if (typeof worker.configDir !== 'string' || worker.configDir.trim() === '') {
      return noCatalog('no account directory was given');
    }
    const info = providerInfo(provider);
    const requested = opts.timeoutMs;
    const budget =
      typeof requested === 'number' && Number.isFinite(requested)
        ? Math.max(1_000, Math.min(MODELS_TIMEOUT_MS, requested))
        : MODELS_TIMEOUT_MS;
    const deadlineMs = Date.now() + budget;
    const cli = resolveProviderCli(info.cli);
    const account = adapterAccount(provider, worker.configDir);

    // The built-in catalog first: it is the answer when the CLI gives none, and what a live
    // listing is told apart from. One that cannot be had is no reason not to ask the CLI.
    let builtIn: unknown;
    let builtInProblem = `the ${info.label} adapter listed no model id that can be stored`;
    try {
      const own = await within(builtInModels(provider, cli.command, account), Math.max(1, deadlineMs - Date.now()));
      if (own.kind === 'value') {
        builtIn = own.value;
      } else {
        builtInProblem = `the ${info.label} model catalog did not answer in time`;
      }
    } catch (err) {
      builtInProblem = `the ${info.label} model catalog could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (cli.found) {
      const liveBudget = deadlineMs - Date.now() - Math.min(MODELS_ANSWER_MARGIN_MS, budget / 5);
      const live =
        liveBudget > 0
          ? await liveModels(provider, cli.command, account, worker.configDir, builtIn, liveBudget)
          : undefined;
      const models = live === undefined ? [] : catalogEntries(provider, live.listed, live.source);
      if (models.length > 0) {
        return { models, source: 'live', error: null };
      }
    }
    const models = catalogEntries(provider, builtIn);
    return models.length > 0 ? { models, source: 'static', error: null } : noCatalog(builtInProblem);
  } catch (err) {
    return noCatalog(`the model listing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
