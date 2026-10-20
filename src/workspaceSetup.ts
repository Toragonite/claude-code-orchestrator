/**
 * "Update Workspace Setup" and the `cco` launcher — the parts that need no editor
 * (contract-2.0-fixes.md §15.7, §15.8).
 *
 * WHY THE COMMAND EXISTS. 2.0 teaches the orchestrating Claude Code session the `cco` command
 * (`~/.claude-code-orchestrator/bin/cco`, run with its Bash tool) instead of the MCP tools. The
 * texts that teach it — the policy block in CLAUDE.md and the team proxy agent — are files the
 * extension put into the user's workspaces at some EARLIER version, and nothing rewrites them on
 * its own: a block that differs is an old one or one the user edited, and the two cannot be told
 * apart. So a workspace set up under 1.x keeps naming tools its session may no longer have, and
 * the user asked for one way to bring such a workspace up to date. That is this command: it
 * LOOKS at what the folder has, shows all of it in one list with each item's current state, and
 * applies only what the user checked — in a fixed order, each item through the guarded writer
 * the other installers use, and item 4 (removing the MCP server) only once item 1 is current.
 *
 * WHY THE SPLIT. Everything in this file is plain Node: the decisions (where Claude Code keeps
 * the local settings file, what a settings file gains or loses, which items are checked at
 * first, the order the items run in and when item 4 may run at all), the two questions only git
 * can answer, and the launcher's text. Each of them can therefore be exercised without an editor.
 * The extension (extension.ts) owns the dialogs, every user-visible word, and every write.
 *
 * Must not import 'vscode'.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { COMMAND_SPELLING, TASK_FILE_DIR } from './mcp/host-protocol';
import type { PolicyState } from './prompts';
import { statFileSafe } from './safeFs';

/* ------------------------------------------------------------------------- *
 * Names
 * ------------------------------------------------------------------------- */

/** The server key "Register MCP Server" writes into a workspace's `.mcp.json`. */
export const MCP_SERVER_NAME = 'cco-dispatch';

/** The key of the same server before the rename; removed wherever ours is written or removed. */
export const LEGACY_MCP_SERVER_NAME = 'fable-dispatch';

/** Both keys of the dispatch server, as item 4 removes them. */
export const DISPATCH_SERVER_NAMES: readonly string[] = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME];

/** The local settings file, relative to the root Claude Code reads it at (decideSettingsRoot). */
export const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';

/**
 * How long one git question may take. Past it the answer counts as "git failed", and a failing
 * git sends the settings file to the folder itself (§15.7 item 3) — exactly what Claude Code
 * does when it cannot ask git either.
 */
export const GIT_TIMEOUT_MS = 5_000;

/** The most a git answer here can be: one path. Anything longer is not an answer to these questions. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024;

/* ------------------------------------------------------------------------- *
 * The launcher (§15.8)
 * ------------------------------------------------------------------------- */

/** `<data root>/bin/cco` — the file COMMAND_SPELLING names. */
export function launcherPathOf(dataRoot: string): string {
  return path.join(dataRoot, 'bin', 'cco');
}

/** `<data root>/mcp/cli.js` — the stable copy of the client, beside the stable server. */
export function cliPathOf(dataRoot: string): string {
  return path.join(dataRoot, 'mcp', 'cli.js');
}

/**
 * Is the launcher in place: a regular file at launcherPathOf (a stat, followed through a link)?
 * Never on win32, where it is not written — `cco` does not run there in this version. Advisory,
 * as every stat is: it answers the nag and the dashboard chip, never a write.
 */
export function launcherPresent(dataRoot: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && statFileSafe(launcherPathOf(dataRoot)) !== undefined;
}

/**
 * `value` as ONE POSIX shell word that the shell takes literally: in single quotes, with every
 * `'` written as `'\''` (close the quote, an escaped quote, open again). Nothing inside single
 * quotes is special to sh — no `$`, no backtick, no backslash — so this is the whole rule.
 */
export function shSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher's exact text (§15.8, as amended after review L1). `nodeCommand` is
 * resolveNodeCommand's answer, `node` until it has one; `cliPath` is cliPathOf(data root). Both
 * are single-quoted (shSingleQuoted), so a home directory with a space, a `$` or a quote in it is
 * still one word.
 *
 * Why each line:
 *  - RECORDED keeps what the extension found, untouched, so the failure sentence can name it:
 *    the user then sees WHICH node went missing (an nvm / volta / asdf version since removed)
 *    instead of being told to install a Node.js they have.
 *  - Only an ABSOLUTE recorded path is tested with `-x`. A bare name (`node`, written before
 *    resolveNodeCommand answers) would be tested relative to the Bash tool's cwd — a directory or
 *    an executable named `node` in the project would pass the test and `exec node` would then
 *    fail the PATH lookup with the shell's own error and exit code. A bare name, and an absolute
 *    path that is gone or not executable, go to the PATH of the Bash tool that runs the command.
 *  - Both sentences go through printf with the value as an ARGUMENT (`%s`), never inside the
 *    format or an `echo`: a backslash or a `%` in a path prints as itself, and no shell's echo
 *    reads `\c` in a home directory as "stop here".
 *  - No node at all, and a client copy that is missing, are each one sentence on stderr and exit
 *    22 — cco's "cannot run here" (host-protocol EXIT.cannotRun), which the installed policy tells
 *    the model to report rather than work around.
 *  - `exec` replaces the shell, so signals and the exit code are the client's own.
 */
export function launcherScript(nodeCommand: string, cliPath: string): string {
  return [
    '#!/bin/sh',
    '# Claude Code Orchestrator — the cco command. Written by the extension at activation; do not edit.',
    `RECORDED=${shSingleQuoted(nodeCommand)}`,
    `CLI=${shSingleQuoted(cliPath)}`,
    'NODE=$RECORDED',
    'case "$NODE" in /*) [ -x "$NODE" ] || NODE= ;; *) NODE= ;; esac',
    '[ -n "$NODE" ] || NODE=$(command -v node 2>/dev/null)',
    `if [ -z "$NODE" ]; then printf 'cco: Node.js was not found (the extension recorded %s, and no node is on this PATH). Reopen VS Code so it can find Node.js again, or install Node.js 18 or later.\\n' "$RECORDED" >&2; exit 22; fi`,
    `if [ ! -f "$CLI" ]; then printf 'cco: %s is missing. Reopen VS Code so Claude Code Orchestrator can restore it.\\n' "$CLI" >&2; exit 22; fi`,
    'exec "$NODE" "$CLI" "$@"',
    '',
  ].join('\n');
}

/**
 * "This folder can dispatch" (§15.7, Nags): the launcher is in place AND the folder's policy
 * block is this version's — which is what teaches the session the command — OR `.mcp.json`
 * registers the dispatch server (mcpJsonRegistersDispatch — the one reading, item 4's too),
 * whose tools a session can use without either. The activation offer and the dashboard chip
 * appear only when this is false.
 */
export function canDispatchFrom(facts: {
  launcherPresent: boolean;
  policy: PolicyState | undefined;
  mcpRegistered: boolean;
}): boolean {
  return (facts.launcherPresent && facts.policy === 'current') || facts.mcpRegistered;
}

/* ------------------------------------------------------------------------- *
 * The four items, their states, their order
 * ------------------------------------------------------------------------- */

/** The items of the one multi-select list, by what they change. */
export type SetupItemId = 'policy' | 'teamAgent' | 'allowCco' | 'removeMcp';

/**
 * The order the items are applied in, whatever order they were checked in: 1, 2, 3, 4. Item 4
 * comes last because it may run only once item 1 has made the policy current, and item 3
 * before it because both write the local settings file (item 4 looks at that file again).
 */
export const SETUP_ORDER: readonly SetupItemId[] = ['policy', 'teamAgent', 'allowCco', 'removeMcp'];

/**
 * The items offered on `platform`. Items 2, 3 and 4 are about the `cco` command, which does not
 * run on win32 in this version: there the MCP server stays the way to dispatch, and nothing may
 * remove it or add permission rules for a command that is not there. Item 2 goes with them
 * (§15.12 M1): the team proxy agent has `tools: Bash, Write` and dispatches ONLY by running
 * `cco`, so on win32 it could not dispatch at all — installing it there would hand the session
 * an agent that fails every task it is given. Item 1 stays: the policy names the MCP tools of
 * the same names for Windows. runSetupPlan refuses what is not in this list even when asked.
 */
export function offeredSetupItems(platform: NodeJS.Platform = process.platform): SetupItemId[] {
  return platform === 'win32' ? ['policy'] : [...SETUP_ORDER];
}

/** Item 1: prompts.policyState, or `unreadable` when CLAUDE.md is a file that must not be rewritten. */
export type PolicyItemState = PolicyState | 'unreadable';

/**
 * Item 2: teamAgent.teamAgentState (`foreign` is "not ours"), plus the places the installer
 * does not write to: `symlink` (the path itself is a link), `outside` (a directory on the way
 * leads out of the folder) and `unreadable`.
 */
export type TeamAgentItemState = 'absent' | 'current' | 'differs' | 'foreign' | 'symlink' | 'outside' | 'unreadable';

/** Item 3: how many of the five rules are missing (0 = all present), or `unreadable`. */
export type AllowItemState = { missing: number } | 'unreadable';

/** Item 4: whether `.mcp.json` holds the dispatch server under either of its names. */
export type McpItemState = 'present' | 'absent' | 'unreadable';

/** The states the list is built from — each computed from the files, never assumed. */
export interface SetupItemStates {
  policy: PolicyItemState;
  /** Undefined where item 2 is not offered (win32). */
  teamAgent: TeamAgentItemState | undefined;
  /** Undefined where item 3 is not offered. */
  allowCco: AllowItemState | undefined;
  /** Undefined where item 4 is not offered. */
  removeMcp: McpItemState | undefined;
}

/**
 * Which items start CHECKED (§15.7):
 *  1. unless current — a current block is shown unchecked, "nothing to do". A CLAUDE.md that
 *     cannot be rewritten at all is not checked either: checking it could only be refused;
 *  2. when ours and differing, or absent — never for "not ours", nor where it cannot be written,
 *     nor where it is not offered;
 *  3. when any of the five rules is missing;
 *  4. never: removing the server is the user's own decision, and only safe once item 1 is current.
 */
export function checkedByDefault(states: SetupItemStates): Set<SetupItemId> {
  const checked = new Set<SetupItemId>();
  if (states.policy === 'absent' || states.policy === 'differs') {
    checked.add('policy');
  }
  if (states.teamAgent === 'absent' || states.teamAgent === 'differs') {
    checked.add('teamAgent');
  }
  if (states.allowCco !== undefined && states.allowCco !== 'unreadable' && states.allowCco.missing > 0) {
    checked.add('allowCco');
  }
  return checked;
}

/**
 * May item 4 run, given the policy state as it is RIGHT BEFORE item 4 — after item 1 ran, when
 * it was checked? Only a current block teaches the cco command; any other block still names the
 * MCP tools (or there is none), and removing the server would leave the session with nothing.
 */
export function mcpRemovalAllowed(policyNow: PolicyItemState): boolean {
  return policyNow === 'current';
}

/** What one item came to: done, unchanged, or refused — with the sentence that says what or why. */
export interface StepOutcome {
  kind: 'done' | 'unchanged' | 'refused';
  /** What was done, or why nothing was: one clause or sentence, in the caller's words. */
  text: string;
  /** Sentences the report adds after this item's line (a tracked file, a restart to make). */
  notes: string[];
}

/** What runSetupPlan needs from the caller: the writes, and the words of its own refusals. */
export interface SetupPlanSteps {
  /** Apply one item. Expected not to throw; a throw is `failed`'s outcome. */
  run(item: SetupItemId): StepOutcome;
  /** The policy state of CLAUDE.md as the file is NOW (a fresh look, not the one the list showed). */
  policyStateNow(): PolicyItemState;
  /** Item 4's refusal while the policy is not current. */
  policyNotCurrent(state: PolicyItemState): StepOutcome;
  /** An item that was asked for but is not offered on this platform. */
  notOffered(item: SetupItemId): StepOutcome;
  /** An item whose step threw. */
  failed(item: SetupItemId, err: unknown): StepOutcome;
}

/**
 * Apply what was chosen — and ONLY that — in SETUP_ORDER, whatever order `chosen` lists it in.
 * The order and item 4's precondition are enforced HERE, not by the list that asked: a caller
 * that hands over any collection (another command, a test, a list with the items in reverse)
 * gets the same guarantees. Values in `chosen` that are not item ids are ignored; an item that
 * is not offered is refused (`notOffered`); item 4 asks for the policy state at the moment it is
 * about to run and is refused (`policyNotCurrent`) unless that is `current`. Never throws on a
 * step's account: a step that throws is that item's `failed` outcome, and the next item runs.
 */
export function runSetupPlan(
  chosen: Iterable<unknown>,
  offered: readonly SetupItemId[],
  steps: SetupPlanSteps,
): Array<{ item: SetupItemId; outcome: StepOutcome }> {
  const wanted = new Set<unknown>(chosen);
  const results: Array<{ item: SetupItemId; outcome: StepOutcome }> = [];
  for (const item of SETUP_ORDER) {
    if (!wanted.has(item)) {
      continue;
    }
    let outcome: StepOutcome;
    try {
      if (!offered.includes(item)) {
        outcome = steps.notOffered(item);
      } else if (item === 'removeMcp') {
        // Asked once, now — after item 1 ran when it was chosen — and decided on that answer.
        const now = policyNowOf(steps);
        outcome = mcpRemovalAllowed(now) ? steps.run(item) : steps.policyNotCurrent(now);
      } else {
        outcome = steps.run(item);
      }
    } catch (err) {
      outcome = steps.failed(item, err);
    }
    results.push({ item, outcome });
  }
  return results;
}

/** steps.policyStateNow, with a throw read as `unreadable` — which item 4 refuses. */
function policyNowOf(steps: SetupPlanSteps): PolicyItemState {
  try {
    return steps.policyStateNow();
  } catch {
    return 'unreadable';
  }
}

/* ------------------------------------------------------------------------- *
 * JSON files: what a settings file or .mcp.json gains or loses
 * ------------------------------------------------------------------------- */

/**
 * Why a JSON file is not rewritten. The caller turns it into a sentence naming the file:
 *  - `not-json`: JSON.parse refused it (a comment, a trailing comma, merge-conflict markers…);
 *  - `not-object`: valid JSON, but not an object (`[]`, `null`, `"x"`);
 *  - `not-object-at`: the key holds something other than an object (`"permissions": []`);
 *  - `not-string-list-at`: the key holds something other than a list of strings.
 */
export type JsonProblem =
  | { code: 'not-json'; detail: string }
  | { code: 'not-object' }
  | { code: 'not-object-at'; key: string }
  | { code: 'not-string-list-at'; key: string };

/** What a change to a JSON file's text came to. `count`: how many entries were added or removed. */
export type TextChange =
  | { kind: 'unchanged' }
  | { kind: 'changed'; text: string; count: number }
  | { kind: 'refused'; problem: JsonProblem };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * A JSON file's text as the object it holds. `undefined` (no file) and a file of nothing but
 * JSON white space are `{}` — there is nothing in them a rewrite could lose, and the latter is
 * what an editor leaves when a new file is saved before anything is typed. One leading byte-order
 * mark is ignored. Everything else that is not exactly one JSON object is a problem, and a file
 * with a problem is never rewritten: a file that holds something and was not understood is never
 * treated as an empty one.
 */
export function parseJsonObject(
  text: string | undefined,
): { ok: true; json: Record<string, unknown> } | { ok: false; problem: JsonProblem } {
  if (text === undefined) {
    return { ok: true, json: {} };
  }
  const body = text.replace(/^﻿/, '');
  if (/^[ \t\r\n]*$/.test(body)) {
    return { ok: true, json: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, problem: { code: 'not-json', detail: err instanceof Error ? err.message : String(err) } };
  }
  return isPlainObject(parsed) ? { ok: true, json: parsed } : { ok: false, problem: { code: 'not-object' } };
}

/**
 * The text a changed object is written as: 2-space JSON and a final newline. Key order is what
 * JSON.parse / JSON.stringify keep; the user's own formatting (indentation, a byte-order mark,
 * a missing final newline) is NOT kept — stated in §15.7, and the reason nothing is written when
 * nothing changes.
 */
function serialize(json: Record<string, unknown>): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** The five rules item 3 adds (§15.7), in the order they are added. */
export interface CcoRules {
  /** For `permissions.allow`. */
  allow: readonly string[];
  /** For `sandbox.excludedCommands`. */
  excludedCommands: readonly string[];
}

/** How many rules item 3 is about — the "5" of "all 5 present" / "<n> of 5 missing". */
export const CCO_RULE_COUNT = 5;

/**
 * The rules that let the session run the command without a prompt, and outside the sandbox:
 *
 *  - `Bash(~/.claude-code-orchestrator/bin/cco *)` — the spelling the installed texts use; and
 *    `Bash(<home>/.claude-code-orchestrator/bin/cco *)` because a leading `~` in a Bash rule is
 *    not documented (F6): one of the two is the form Claude Code compares;
 *  - `Edit(/.cco/**)` — the task files the session writes with its Write tool (governed by
 *    Edit rules, F7) into `.cco/` at the workspace root;
 *  - the same two spellings in `sandbox.excludedCommands` (without `Bash(…)`): inside the
 *    sandbox the host cannot write the workers' config directories and refuses to start (§15.2.d).
 *
 * `home` is the user's home directory as the editor sees it (os.homedir()).
 */
export function ccoRules(home: string): CcoRules {
  const spelled = COMMAND_SPELLING;
  const expanded = path.posix.join(home, spelled.replace(/^~\//, ''));
  return {
    allow: [`Bash(${spelled} *)`, `Bash(${expanded} *)`, `Edit(/${TASK_FILE_DIR}/**)`],
    excludedCommands: [`${spelled} *`, `${expanded} *`],
  };
}

/** The list at `json[objectKey][listKey]`: absent reads as empty; a wrong shape is a problem. */
function listAt(
  json: Record<string, unknown>,
  objectKey: string,
  listKey: string,
): { ok: true; list: readonly string[] } | { ok: false; problem: JsonProblem } {
  if (!hasOwn(json, objectKey)) {
    return { ok: true, list: [] };
  }
  const holder = json[objectKey];
  if (!isPlainObject(holder)) {
    return { ok: false, problem: { code: 'not-object-at', key: objectKey } };
  }
  if (!hasOwn(holder, listKey)) {
    return { ok: true, list: [] };
  }
  const list = holder[listKey];
  if (!isStringList(list)) {
    return { ok: false, problem: { code: 'not-string-list-at', key: `${objectKey}.${listKey}` } };
  }
  return { ok: true, list };
}

/**
 * Which of the five rules a settings object lacks, compared exactly (a rule with other spacing
 * is another rule). `permissions` / `sandbox` that are not objects, and `permissions.allow` /
 * `sandbox.excludedCommands` that are not lists of strings, are problems: nothing can be added
 * to them without replacing what the user put there.
 */
export function missingCcoRules(
  json: Record<string, unknown>,
  rules: CcoRules,
):
  | { ok: true; missing: { allow: string[]; excludedCommands: string[] }; count: number }
  | { ok: false; problem: JsonProblem } {
  const allow = listAt(json, 'permissions', 'allow');
  if (!allow.ok) {
    return allow;
  }
  const excluded = listAt(json, 'sandbox', 'excludedCommands');
  if (!excluded.ok) {
    return excluded;
  }
  const missingAllow = rules.allow.filter((rule) => !allow.list.includes(rule));
  const missingExcluded = rules.excludedCommands.filter((rule) => !excluded.list.includes(rule));
  return {
    ok: true,
    missing: { allow: missingAllow, excludedCommands: missingExcluded },
    count: missingAllow.length + missingExcluded.length,
  };
}

/** Item 3's state of a settings file's text (no file: all five missing). */
export function allowItemStateOf(text: string | undefined, rules: CcoRules): AllowItemState {
  const read = parseJsonObject(text);
  if (!read.ok) {
    return 'unreadable';
  }
  const look = missingCcoRules(read.json, rules);
  return look.ok ? { missing: look.count } : 'unreadable';
}

/** Append `added` to `json[objectKey][listKey]`, creating either when absent (shapes already checked). */
function appendTo(json: Record<string, unknown>, objectKey: string, listKey: string, added: readonly string[]): void {
  if (added.length === 0) {
    return;
  }
  if (!hasOwn(json, objectKey)) {
    json[objectKey] = {};
  }
  const holder = json[objectKey] as Record<string, unknown>;
  if (!hasOwn(holder, listKey)) {
    holder[listKey] = [];
  }
  (holder[listKey] as string[]).push(...added);
}

/**
 * The settings text with the rules it lacks added — each only when absent, at the end of its
 * list, in the order ccoRules gives them; `permissions` / `sandbox` and their lists are created
 * at the end of their objects when there are none. Every other key keeps its value and its place.
 * `unchanged` when all five are there (nothing is rewritten, so the user's formatting stays);
 * `refused` when the text is not a settings object this can add to (parseJsonObject,
 * missingCcoRules) — the caller then writes nothing. `undefined` text is "no file".
 */
export function withCcoRules(text: string | undefined, rules: CcoRules): TextChange {
  const read = parseJsonObject(text);
  if (!read.ok) {
    return { kind: 'refused', problem: read.problem };
  }
  const look = missingCcoRules(read.json, rules);
  if (!look.ok) {
    return { kind: 'refused', problem: look.problem };
  }
  if (look.count === 0) {
    return { kind: 'unchanged' };
  }
  appendTo(read.json, 'permissions', 'allow', look.missing.allow);
  appendTo(read.json, 'sandbox', 'excludedCommands', look.missing.excludedCommands);
  return { kind: 'changed', text: serialize(read.json), count: look.count };
}

/**
 * THE ONE READING of "this `mcpServers` object registers the dispatch server" (§15.7 Nags and
 * item 4, amended: one rule for both): an own entry under `cco-dispatch` OR the legacy name
 * whose value is a JSON object — the only shape Claude Code starts a server from. A `null`, a
 * string or a list under either name registers nothing: a session in that folder has no
 * dispatch tools, so it must not count as "can dispatch" (the nag would stay silent while
 * nothing works), and item 4 must not call it "present". Before this rule, the nag read only
 * `cco-dispatch` (a folder still registered under the legacy name was nagged although it could
 * dispatch) and item 4 read any value — three places, three answers.
 */
export function registersDispatchServer(servers: Record<string, unknown>): boolean {
  return DISPATCH_SERVER_NAMES.some((name) => hasOwn(servers, name) && isPlainObject(servers[name]));
}

/**
 * Item 4's state of a `.mcp.json` text: `present` when registersDispatchServer says so,
 * `unreadable` for a text or an `mcpServers` that is not a JSON object (nothing in it can be
 * removed without replacing it), `absent` otherwise.
 */
export function mcpItemStateOf(text: string | undefined): McpItemState {
  const read = parseJsonObject(text);
  if (!read.ok) {
    return 'unreadable';
  }
  if (!hasOwn(read.json, 'mcpServers')) {
    return 'absent';
  }
  const servers = read.json.mcpServers;
  if (!isPlainObject(servers)) {
    return 'unreadable';
  }
  return registersDispatchServer(servers) ? 'present' : 'absent';
}

/**
 * Does this `.mcp.json` text register the dispatch server? Item 4's reading, as a yes / no for
 * the questions that only ask — "this folder can dispatch" in the extension and on the dashboard.
 * No file, and a file that is not understood, answer no. Never throws.
 */
export function mcpJsonRegistersDispatch(text: string | undefined): boolean {
  return mcpItemStateOf(text) === 'present';
}

/**
 * The `.mcp.json` text without the dispatch server: ONLY the `cco-dispatch` entry and the
 * legacy name's are removed; every other server and key stays, and an `mcpServers` left empty
 * stays as `{}` — the file is kept (the user may add servers to it later, and a file that
 * disappears is a surprise in a diff). No file, no `mcpServers`, or neither name: `unchanged`.
 * An entry under either name is removed whatever its value: one that registers nothing
 * (registersDispatchServer) is still ours to clear once the user asked for the server to go.
 */
export function withoutMcpServers(text: string | undefined): TextChange {
  const read = parseJsonObject(text);
  if (!read.ok) {
    return { kind: 'refused', problem: read.problem };
  }
  if (!hasOwn(read.json, 'mcpServers')) {
    return { kind: 'unchanged' };
  }
  const servers = read.json.mcpServers;
  if (!isPlainObject(servers)) {
    return { kind: 'refused', problem: { code: 'not-object-at', key: 'mcpServers' } };
  }
  let count = 0;
  for (const name of DISPATCH_SERVER_NAMES) {
    if (hasOwn(servers, name)) {
      delete servers[name];
      count++;
    }
  }
  return count === 0 ? { kind: 'unchanged' } : { kind: 'changed', text: serialize(read.json), count };
}

/**
 * The local settings text without the dispatch server's names in `enabledMcpjsonServers` (the
 * list Claude Code keeps of the project servers the user approved). Every other name stays, in
 * its order; a list left empty stays as `[]`. No file, no list, or neither name: `unchanged`.
 */
export function withoutEnabledMcpServers(text: string | undefined): TextChange {
  if (text === undefined) {
    return { kind: 'unchanged' };
  }
  const read = parseJsonObject(text);
  if (!read.ok) {
    return { kind: 'refused', problem: read.problem };
  }
  if (!hasOwn(read.json, 'enabledMcpjsonServers')) {
    return { kind: 'unchanged' };
  }
  const list = read.json.enabledMcpjsonServers;
  if (!isStringList(list)) {
    return { kind: 'refused', problem: { code: 'not-string-list-at', key: 'enabledMcpjsonServers' } };
  }
  const kept = list.filter((name) => !DISPATCH_SERVER_NAMES.includes(name));
  if (kept.length === list.length) {
    return { kind: 'unchanged' };
  }
  read.json.enabledMcpjsonServers = kept;
  return { kind: 'changed', text: serialize(read.json), count: list.length - kept.length };
}

/* ------------------------------------------------------------------------- *
 * Where Claude Code keeps the local settings file (§15.7 item 3, F7)
 * ------------------------------------------------------------------------- */

/**
 * Why the root is the root:
 *  - `repository` — the folder's git top-level;
 *  - `main-checkout` — the folder is in a linked worktree, whose local settings live in the main
 *    checkout's root;
 *  - `not-git` — not a git repository, git missing, failing or past GIT_TIMEOUT_MS — for ANY of
 *    the questions, the common-dir one included: the folder;
 *  - `home` — the root is the home directory: the folder;
 *  - `not-owned` — the root, its `.git` or its `.claude` is not the user's: the folder.
 */
export type SettingsRootWhy = 'repository' | 'main-checkout' | 'not-git' | 'home' | 'not-owned';

export interface SettingsRoot {
  /** The directory whose `.claude/settings.local.json` Claude Code reads for this folder. */
  root: string;
  why: SettingsRootWhy;
  /** Git answered for the folder: the tracked-file question is worth asking. */
  inGit: boolean;
}

/** What git said about the folder; undefined where it said nothing usable. */
export interface GitRootFacts {
  /** `git rev-parse --show-toplevel`: one absolute path. */
  toplevel: string | undefined;
  /** `git rev-parse --path-format=absolute --git-common-dir`: one absolute path. */
  commonDir: string | undefined;
}

/** The file-system questions decideSettingsRoot asks, so that it can be asked without a disk. */
export interface RootProbe {
  /** The home directory, realpath'd. */
  home: string;
  /** process.getuid(); undefined where there is none (then nothing is "owned by the user"). */
  uid: number | undefined;
  /** `fs.statSync(p).uid`; undefined when it cannot be stat'ed. */
  ownerOf(p: string): number | undefined;
  /** Is something at `p` (lstat)? A failure other than ENOENT counts as "yes". */
  exists(p: string): boolean;
  /** fs.realpathSync, or undefined. */
  realpath(p: string): string | undefined;
}

/**
 * THE RULE of where item 3 writes, as F7 describes where Claude Code (2.1.211+) reads and writes
 * the local settings file of a session started in `folder`:
 *
 *  - the git top-level — for a session started in a subdirectory, that is ABOVE the folder;
 *  - for a linked worktree, the MAIN checkout's root: the common git directory without its
 *    trailing `/.git`. A common directory not named `.git` (a bare repository's worktree, a
 *    submodule) has no main checkout to name; the top-level stays;
 *  - but the folder itself when git gave no top-level (not a repository, git missing, failing,
 *    timed out), OR gave a top-level but no common directory (amended, §15.7 item 3), when the
 *    root is the home directory, or when the root, its `.git` or its `.claude` (when there is
 *    one) is not owned by the user — a root that is not the user's is one Claude Code does not
 *    write to either, and neither does this.
 *
 * Why a top-level without a common directory is not trusted: every work tree has a git
 * directory, so a git that answers the first question and fails the second is a FAILING git (a
 * timeout, a broken repository) — and the top-level alone cannot tell a linked worktree, whose
 * settings live in the main checkout, from a plain checkout. Writing at the top-level would then
 * put the rules where Claude Code may never read them; the folder itself is where Claude Code
 * reads when its own git questions fail.
 *
 * A rule written to any other file would sit where Claude Code never reads it: the item would
 * say "done" and the prompt would still come.
 */
export function decideSettingsRoot(folder: string, facts: GitRootFacts, probe: RootProbe): SettingsRoot {
  if (facts.toplevel === undefined || facts.commonDir === undefined) {
    return { root: folder, why: 'not-git', inGit: false };
  }
  const real = (p: string): string => probe.realpath(p) ?? p;
  let root = facts.toplevel;
  let why: SettingsRootWhy = 'repository';
  if (path.basename(facts.commonDir) === '.git') {
    const main = path.dirname(facts.commonDir);
    if (real(main) !== real(root)) {
      root = main;
      why = 'main-checkout';
    }
  }
  if (real(root) === probe.home) {
    return { root: folder, why: 'home', inGit: true };
  }
  const owned = (p: string): boolean => probe.uid !== undefined && probe.ownerOf(p) === probe.uid;
  const claudeDir = path.join(root, '.claude');
  if (!owned(root) || !owned(path.join(root, '.git')) || (probe.exists(claudeDir) && !owned(claudeDir))) {
    return { root: folder, why: 'not-owned', inGit: true };
  }
  return { root, why, inGit: true };
}

/** The host's answers to RootProbe's questions. */
export function hostRootProbe(): RootProbe {
  const realpath = (p: string): string | undefined => {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const home = os.homedir();
  return {
    home: realpath(home) ?? home,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    ownerOf: (p) => {
      try {
        return fs.statSync(p).uid;
      } catch {
        return undefined;
      }
    },
    exists: (p) => {
      try {
        fs.lstatSync(p);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT';
      }
    },
    realpath,
  };
}

/** One git answer: what it printed, or that it said nothing usable (and its exit code when it exited). */
export type GitAnswer = { ok: true; stdout: string } | { ok: false; exitCode: number | undefined };

/**
 * The environment git is asked in: the editor's, without the variables that point git at ANOTHER
 * repository than the one the folder is in — the question is about the folder, as Claude Code
 * started in it would see it. No prompt for credentials, no optional locks.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ]) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/**
 * Ask git one read-only question in `cwd`: execFile, never a shell, GIT_TIMEOUT_MS at most
 * (killed past it), stdin closed. `core.fsmonitor` is turned off for the call: it is a repository
 * setting that names a COMMAND git runs when it reads the index, and a folder opened in the editor
 * is not thereby a folder whose configured commands should run. Never rejects: a git that is
 * missing, fails, or takes too long answers `ok: false`.
 */
export function runGit(cwd: string, args: readonly string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitAnswer> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'git',
        ['-c', 'core.fsmonitor=false', ...args],
        {
          cwd,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: GIT_OUTPUT_MAX_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          env: gitEnvironment(),
        },
        (err, stdout) => {
          if (err) {
            const code: unknown = err.code;
            resolve({ ok: false, exitCode: typeof code === 'number' && !err.killed ? code : undefined });
            return;
          }
          resolve({ ok: true, stdout: String(stdout) });
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end();
    } catch {
      resolve({ ok: false, exitCode: undefined });
    }
  });
}

/** The one line git printed (its final line end removed); undefined for none, or more than one. */
function oneLine(stdout: string): string | undefined {
  const line = stdout.endsWith('\r\n') ? stdout.slice(0, -2) : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  return line === '' || /[\r\n]/.test(line) ? undefined : line;
}

/** oneLine, and only an absolute path. A path may end in a space: only the line end is removed. */
function oneAbsolutePath(stdout: string): string | undefined {
  const line = oneLine(stdout);
  return line !== undefined && path.isAbsolute(line) ? line : undefined;
}

/**
 * Where Claude Code keeps the local settings file of a session started in `folder`: git is
 * asked (runGit) and decideSettingsRoot decides. The common directory is asked with
 * `--path-format=absolute` (git 2.31+); an older git prints that flag back instead of honouring
 * it — not one absolute path — and is then asked without it, its relative answer resolved
 * against the folder it was asked in. When neither common-dir question is answered, the facts
 * carry no common directory and decideSettingsRoot answers the folder itself: a git that fails
 * any question is a failing git (§15.7 item 3, amended).
 */
export async function lookUpSettingsRoot(folder: string, probe: RootProbe = hostRootProbe()): Promise<SettingsRoot> {
  const top = await runGit(folder, ['rev-parse', '--show-toplevel']);
  const toplevel = top.ok ? oneAbsolutePath(top.stdout) : undefined;
  if (toplevel === undefined) {
    return decideSettingsRoot(folder, { toplevel: undefined, commonDir: undefined }, probe);
  }
  const absolute = await runGit(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let commonDir = absolute.ok ? oneAbsolutePath(absolute.stdout) : undefined;
  if (commonDir === undefined) {
    const relative = await runGit(folder, ['rev-parse', '--git-common-dir']);
    const line = relative.ok ? oneLine(relative.stdout) : undefined;
    commonDir = line === undefined ? undefined : path.resolve(folder, line);
  }
  return decideSettingsRoot(folder, { toplevel, commonDir }, probe);
}

/**
 * Does git track `rel` (relative to `root`)? `git ls-files --error-unmatch`: exit 0 yes, exit 1
 * no, anything else — not a repository, git missing or failing — undefined, and nothing is said.
 */
export async function isTrackedInGit(root: string, rel: string = LOCAL_SETTINGS_FILE): Promise<boolean | undefined> {
  const answer = await runGit(root, ['ls-files', '--error-unmatch', '--', rel]);
  if (answer.ok) {
    return true;
  }
  return answer.exitCode === 1 ? false : undefined;
}
