import * as crypto from 'crypto';
import * as fs from 'fs';
import { OUT_CAP_CHARS, RPC_ERROR, TASK_ID } from '../mcp/host-protocol';
import {
  ATTACH_LEASE,
  ATTACH_ORPHAN_MS,
  BOARD_BODY_MAX_BYTES,
  BOARD_ID,
  boardBodyFileOf,
  boardReportFileOf,
  CREDENTIAL,
  FEED_KINDS,
  FEED_ROTATE,
  isTeamRefusal,
  MEMBER_KEYS,
  MEMBER_NAME,
  MEMBER_OP_NOW_OPS,
  MEMBER_OPS,
  MEMBER_SWITCH_KEYS,
  memberFeedFileOf,
  memberFilesOf,
  MESSAGE_FILE_KEYS,
  MESSAGE_ID,
  MESSAGE_MAX_BYTES,
  messageBodyFileOf,
  METHOD_TEAM,
  newFenceId,
  SENDER_MESSAGE_KINDS,
  seqOfMessageId,
  SETUP_KEYS,
  STATUS_MEMBER_FEED_ITEMS,
  STATUS_MEMBER_MESSAGES,
  STATUS_TASK_MAX_BYTES,
  SWEEP_WAIT_MS,
  TASK_KEYS,
  TASK_OP_KEYS,
  TEAM_ACTIVITY_NOTIFY_MAX_BYTES,
  TEAM_ACTIVITY_TAIL_MAX,
  TEAM_FILE_KEYS,
  TEAM_FOOTER_RESERVE_CHARS,
  TEAM_ID,
  TEAM_MEMBER_CONNECTIONS_MAX,
  TEAM_NAME,
  TEAM_OBSERVER_CLIENTS,
  TEAM_OBSERVER_CONNECTIONS_MAX,
  TEAM_RPC,
  TEAM_SUBSCRIBE_REPLAY_MAX,
  TEAM_TEXT,
  TEAM_TOOL_DEFINITIONS,
  TEAM_TOOL_NAMES,
  TEAM_TOOL_TEXT,
  TEAM_TURN_TEXT_MAX_BYTES,
  teamDirOf,
  teamEventParamsOf,
  teamRefusal,
  TeamProtocolError,
  teamSnapshotParamsOf,
  toolRefusal,
  turnTextFileOf,
  WAIT_MAX_SECONDS,
  WAIT_SETTLE_DEFAULT_S,
  WAIT_SETTLE_MAX_S,
  WORKER_FLAG_MAX_CHARS,
  WORKTREE_KEYS,
  hasControlChar,
} from './contract';
import type {
  ConnId,
  CreateTeamSurface,
  EndAnswer,
  FeedItem,
  LogEvent,
  MemberOp,
  MembersFile,
  MsgPostedBody,
  OutgoingMessage,
  Result,
  TaskOp,
  TeamConnections,
  TeamCore,
  TeamEngine,
  TeamFile,
  TeamHostSide,
  TeamOp,
  TeamRefusal,
  TeamRuntime,
  TeamState,
  TeamSurface,
  TeamTool,
  TextResult,
} from './contract';
import {
  badFlagValueText,
  closestKey,
  footerLine,
  internalErrorText,
  MEMBER_OP_RULES_TEXT,
  type MessageHead,
  missingKeyText,
  nearName,
  notObjectText,
  oneLine,
  renderAttachPlan,
  renderBoardAnswer,
  renderCreateAnswer,
  renderEndAnswer,
  renderMemberAnswer,
  renderMemberStatus,
  renderMessageStatus,
  renderSendAnswer,
  renderStatus,
  renderStatusAll,
  renderTaskStatus,
  renderWaitTimedOut,
  statusOneFlagText,
  unknownKeyText,
  unknownTeamText,
  unknownTurnText,
  wrongTypeText,
} from './render';

/**
 * team/surface — the team engine's SURFACE (team contract §7.1, task T5b): `TeamEngine` (what
 * server.ts calls) and `TeamHostSide` (what host.ts calls), both over a `TeamCore` (T5a, built in
 * engine.ts — never imported here: the core is the factory's argument, so the surface is checked
 * against a fake core and the core against fake front doors).
 *
 * WHAT IS HERE AND NOT IN THE CORE. The core owns MEANING: state, the log, every value check,
 * routing, turns, the mailbox rules, the inbox page, the doorbell's wake rule. The surface owns
 * the FRONT DOORS and their words:
 *
 *  - the eleven lead operations (§7.2–§7.4): the shape of each argument object checked first —
 *    an unknown key names itself and the closest allowed key, a wrong JSON type says what it must
 *    be, the client's exit-21 rules (urgent to all, to user, team_member's flags, team_status's one
 *    flag) — then the core, then the answer skeleton of §7.4 (render.ts);
 *  - the doorbell's front (§4.4): `cco/team.wait` with its deadline and its one waiter (the core's
 *    `waitForLead` decides what wakes, coalesces report wakes and settles; the surface aborts it
 *    at the deadline or when the connection goes), the cap-aware inbox page, the unread footer;
 *  - the observer methods and subscriptions with the H1 push/close discipline (§7.6): every log
 *    event of the owned team pushed NOT lossy, in seq order, after the opening snapshot and the
 *    replay; activity pushed lossy; a push that reports `closed` ends that subscription at once
 *    (host.ts has closed the connection — the observer resubscribes from its last seq). Per T0
 *    amendment A14 an observer treats every event as a CHANGE SIGNAL and re-reads `cco/team.get`;
 *    nothing here projects events into state;
 *  - the member side (§3.7, I5): a member hello is decided by the credential FILE the core wrote
 *    (sha256 + timingSafeEqual), the connection then IS the member — `cco/member.call` takes the
 *    identity from the connection and never from an argument (an argument naming a member is an
 *    unknown key, refused `invalid_arguments`); the surface closes a member's connections at its
 *    `turn.ended` (M19, A15);
 *  - Claude take-over's front (§3.10, S1-3): the provider check, the granting connection, the
 *    attach-orphan clock (TeamCore has no "connection closed" hook, so the clock runs here);
 *  - the readers of A15: message bodies, activity feeds and turn texts are read through the path
 *    helpers of team/contract and host-protocol, read-only, capped — TeamCore has no reader.
 *
 * FAILURE OUTSIDE THE PATHS. TeamEngine methods NEVER reject (an internal failure is an isError
 * answer naming it, logged); TeamHostSide.hello and .closed never throw; TeamHostSide.request
 * rejects ONLY with a TeamProtocolError (malformed params → invalidParams; an unknown method →
 * methodNotFound; a defect → internalError, logged). Domain refusals are RESULTS (MD-54). Every
 * file read here is bounded and total — a missing or unreadable file is "not there", never a
 * throw.
 *
 * RESIDUALS (stated). `cco/team.host {reason:'lease-lost'}` is not sent: TeamCore offers no
 * lease-lost signal to the surface (CONTRACT-QUESTION). The sweep's "suspended after its host
 * ended" report is inferred from `listTeams()` before and after `TeamCore.sweep()` (a team that
 * was `active` with no live owner and is `suspended` after) — the core returns nothing from sweep.
 */

/** The connection a lead operation has none of (team_attach's plan-only take-over, §3.10 step 1). CONTRACT-QUESTION: TeamEngine.toolCall carries no ConnId. */
const NO_CONN: ConnId = -1;
/** The sweep's "was suspended" line rides this many footers (or until team_resume of it). */
const SWEEP_NOTE_SHOWS = 3;
/** A feed file is read from its end, at most this many bytes (it rotates at FEED_ROTATE). */
const FEED_READ_MAX_BYTES = FEED_ROTATE + 64 * 1024;
/** A credential file is 64 hex and a newline at most; anything bigger is not one. */
const CREDENTIAL_FILE_MAX_BYTES = 256;
/** What one cco/team.activity notification's items may take, below TEAM_ACTIVITY_NOTIFY_MAX_BYTES (the envelope's share). */
const ACTIVITY_ITEMS_BUDGET_BYTES = TEAM_ACTIVITY_NOTIFY_MAX_BYTES - 1024;
/** A message head in `team_status --member` reads at most this much of a long body's file. */
const MESSAGE_HEAD_READ_BYTES = 1024;
/** cco/team.activityTail without a `limit`. */
const ACTIVITY_TAIL_DEFAULT = 100;
/** Turn ids of the owned team remembered for cco/team.turnText (A39); the oldest goes first. */
const KNOWN_TURNS_MAX = 10_000;
/** The member states during which a turn process — and so its team MCP server — is alive. */
const LIVE_TURN_STATES: ReadonlySet<string> = new Set(['running', 'pausing']);

/* ------------------------------------------------------------------------- *
 * Small total helpers
 * ------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: 'text', text }], isError };
}
function hasOwn(o: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}
/** A copy without the keys whose value is null: null counts as "not given", as the dispatch host reads it (§15.3.2). */
function withoutNulls(o: Json): Json {
  const out: Json = {};
  for (const key of Object.keys(o)) {
    if (o[key] !== null) {
      out[key] = o[key];
    }
  }
  return out;
}
function sha256(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}
/** I5, P64: two credentials compared by their sha256 in constant time. */
function sameSecret(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A regular file's bytes, read without following a symlink at its last component, at most
 * `maxBytes` — from its start, or (`fromEnd`) its last `maxBytes`. Undefined when it is not there,
 * not a regular file, or cannot be read. Total.
 */
function readFileBytes(file: string, maxBytes: number, fromEnd = false): { buf: Buffer; size: number; start: number } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return undefined;
    }
    const length = Math.min(st.size, maxBytes);
    const start = fromEnd ? st.size - length : 0;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    return { buf: buf.subarray(0, read), size: st.size, start };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // closing a read-only descriptor cannot lose anything
      }
    }
  }
}
/** A UTF-8 text file (≤ maxBytes from its start), or undefined. */
function readText(file: string, maxBytes: number): string | undefined {
  const got = readFileBytes(file, maxBytes);
  return got === undefined ? undefined : got.buf.toString('utf8');
}
/** The byte length of `buf` without a trailing INCOMPLETE UTF-8 sequence. */
function completeUtf8Length(buf: Buffer): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) {
    return buf.length;
  }
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i >= need ? buf.length : i;
}

/** One feed line (§3.8) BY VALUE: the known fields only, the rest dropped; undefined when it is not an item. */
function feedItemOf(raw: unknown): FeedItem | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const { ts, turn, k, s, tool, d } = raw;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof turn !== 'string' || typeof k !== 'string') {
    return undefined;
  }
  if (!(FEED_KINDS as readonly string[]).includes(k)) {
    return undefined;
  }
  const item: FeedItem = { ts, turn, k: k as FeedItem['k'] };
  if (typeof s === 'string') {
    item.s = s;
  }
  if (typeof tool === 'string') {
    item.tool = tool;
  }
  if (typeof d === 'string') {
    item.d = d;
  }
  return item;
}
/** The items of a feed file's text; a first line cut by a tail read is dropped by the caller. */
function feedItemsOf(text: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const item = feedItemOf(JSON.parse(line));
      if (item !== undefined) {
        items.push(item);
      }
    } catch {
      // a torn or foreign line is not an item
    }
  }
  return items;
}

/* ------------------------------------------------------------------------- *
 * Argument shapes of the lead's operations (§7.3 keys) — the "file checks"
 * ------------------------------------------------------------------------- */

/** What a key's value must be, by JSON type (values are the core's to judge, §7.3). */
type Expect = 'string' | 'boolean' | 'number' | 'strings' | 'object' | 'objects' | 'start';
const EXPECT_TEXT: Readonly<Record<Expect, string>> = {
  string: 'a string',
  boolean: 'true or false',
  number: 'a number',
  strings: 'an array of strings',
  object: 'a JSON object',
  objects: 'an array of JSON objects',
  start: 'a string or false',
};
function fits(value: unknown, expect: Expect): boolean {
  switch (expect) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'strings':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'object':
      return isPlainObject(value);
    case 'objects':
      return Array.isArray(value) && value.every(isPlainObject);
    case 'start':
      return typeof value === 'string' || value === false;
  }
}

/** The file keys as they reach the HOST: every `x_file` was read by the client into `x` (§7.3, §15.3.2). */
function hostKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => !k.endsWith('_file'));
}
const TEAM_TYPES: Readonly<Record<string, Expect>> = {
  name: 'string',
  title: 'string',
  goal: 'string',
  base: 'string',
  members: 'objects',
  tasks: 'objects',
  worktree: 'object',
};
const MEMBER_TYPES: Readonly<Record<string, Expect>> = {
  name: 'string',
  role: 'string',
  brief: 'string',
  provider: 'string',
  worker: 'string',
  model: 'string',
  paths: 'strings',
  start: 'start',
};
const TASK_TYPES: Readonly<Record<string, Expect>> = {
  title: 'string',
  body: 'string',
  assignee: 'string',
  paths: 'strings',
  allow_overlap: 'boolean',
};
const WORKTREE_TYPES: Readonly<Record<string, Expect>> = { setup: 'object', timeout_minutes: 'number' };
const SETUP_TYPES: Readonly<Record<string, Expect>> = { argv: 'strings', timeout_minutes: 'number' };
const MESSAGE_TYPES: Readonly<Record<string, Expect>> = {
  to: 'string',
  text: 'string',
  kind: 'string',
  urgent: 'boolean',
  reply_to: 'string',
  task: 'string',
};
const TASK_OP_TYPES: Readonly<Record<string, Expect>> = {
  op: 'string',
  tasks: 'objects',
  task: 'string',
  to: 'string',
  force: 'boolean',
  title: 'string',
  body: 'string',
  paths: 'strings',
  allow_overlap: 'boolean',
  state: 'string',
  note: 'string',
};
const MEMBER_OP_TYPES: Readonly<Record<string, Expect>> = {
  member: 'string',
  op: 'string',
  now: 'boolean',
  provider: 'string',
  worker: 'string',
  model: 'string',
};

/**
 * One object's keys and JSON types: the first unknown key (named with the closest allowed one),
 * the first wrong type, the first missing required key — or undefined. `allowed` in the
 * contract's order (the closest key on a tie is the first).
 */
function checkFields(where: string, o: Json, allowed: readonly string[], types: Readonly<Record<string, Expect>>, required: readonly string[] = []): string | undefined {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      return unknownKeyText(where, key, allowed);
    }
  }
  for (const key of allowed) {
    if (hasOwn(o, key) && !fits(o[key], types[key])) {
      return wrongTypeText(where, key, EXPECT_TEXT[types[key]]);
    }
  }
  for (const key of required) {
    if (!hasOwn(o, key)) {
      return missingKeyText(where, key, EXPECT_TEXT[types[key]]);
    }
  }
  return undefined;
}

/** An object with its null-valued keys dropped, or the "must be a JSON object" sentence. */
function objectOf(where: string, raw: unknown): Json | string {
  return isPlainObject(raw) ? withoutNulls(raw) : notObjectText(where);
}

/** Every element of an `objects` array, null keys dropped and checked; the new array or the first problem. */
function checkEach(
  where: string,
  list: unknown,
  allowed: readonly string[],
  types: Readonly<Record<string, Expect>>,
  required: readonly string[] = [],
): Json[] | string | undefined {
  if (list === undefined) {
    return undefined;
  }
  const out: Json[] = [];
  const items = list as unknown[];
  for (let i = 0; i < items.length; i++) {
    const o = objectOf(`${where}[${i}]`, items[i]);
    if (typeof o === 'string') {
      return o;
    }
    const problem = checkFields(`${where}[${i}]`, o, allowed, types, required);
    if (problem !== undefined) {
      return problem;
    }
    out.push(o);
  }
  return out;
}

/** The members and tasks parts shared by a team file and a members file. */
function checkMembersAndTasks(where: string, o: Json): string | undefined {
  const members = checkEach(`${where} members`, o.members, hostKeys(MEMBER_KEYS), MEMBER_TYPES);
  if (typeof members === 'string') {
    return members;
  }
  if (members !== undefined) {
    o.members = members;
  }
  const tasks = checkEach(`${where} tasks`, o.tasks, hostKeys(TASK_KEYS), TASK_TYPES);
  if (typeof tasks === 'string') {
    return tasks;
  }
  if (tasks !== undefined) {
    o.tasks = tasks;
  }
  return undefined;
}

/** team_create's file (§7.3 TEAM_FILE_KEYS, as it reaches the host). */
function checkTeamFile(raw: unknown): TeamFile | string {
  const where = 'team file';
  const o = objectOf(where, raw);
  if (typeof o === 'string') {
    return o;
  }
  const problem = checkFields(where, o, hostKeys(TEAM_FILE_KEYS), TEAM_TYPES, ['members']) ?? checkMembersAndTasks(where, o);
  if (problem !== undefined) {
    return problem;
  }
  if (o.worktree !== undefined) {
    const wt = withoutNulls(o.worktree as Json);
    const wtProblem = checkFields(`${where} worktree`, wt, WORKTREE_KEYS, WORKTREE_TYPES);
    if (wtProblem !== undefined) {
      return wtProblem;
    }
    if (wt.setup !== undefined) {
      const setup = withoutNulls(wt.setup as Json);
      const setupProblem = checkFields(`${where} worktree.setup`, setup, SETUP_KEYS, SETUP_TYPES, ['argv']);
      if (setupProblem !== undefined) {
        return setupProblem;
      }
      wt.setup = setup;
    }
    o.worktree = wt;
  }
  return o as unknown as TeamFile;
}

/** team_add's file: `{"members":[…], "tasks":[…]}`. */
function checkMembersFile(raw: unknown): MembersFile | string {
  const where = 'members file';
  const o = objectOf(where, raw);
  if (typeof o === 'string') {
    return o;
  }
  const problem = checkFields(where, o, ['members', 'tasks'], TEAM_TYPES, ['members']) ?? checkMembersAndTasks(where, o);
  return problem ?? (o as unknown as MembersFile);
}

/** team_send's message file (§7.3 MESSAGE_FILE_KEYS) plus the client's exit-21 rules (§7.3, §4.1). */
function checkLeadMessage(raw: unknown): OutgoingMessage | string {
  const where = 'message file';
  const o = objectOf(where, raw);
  if (typeof o === 'string') {
    return o;
  }
  const problem = checkFields(where, o, hostKeys(MESSAGE_FILE_KEYS), MESSAGE_TYPES, ['to', 'text']);
  if (problem !== undefined) {
    return problem;
  }
  if (o.kind !== undefined && !(SENDER_MESSAGE_KINDS as readonly string[]).includes(o.kind as string)) {
    return `${where}: \`kind\` must be one of ${SENDER_MESSAGE_KINDS.join(', ')}.`;
  }
  if (o.to === 'user') {
    return TEAM_TEXT.leadToUser();
  }
  if (o.urgent === true && o.to === 'all') {
    return TEAM_TEXT.urgentToAll();
  }
  return {
    to: o.to as string,
    text: o.text as string,
    kind: o.kind as OutgoingMessage['kind'],
    urgent: o.urgent as boolean | undefined,
    replyTo: o.reply_to as string | undefined,
    task: o.task as string | undefined,
  };
}

/** A board operation (§7.3 TASK_OP_FILE) — from team_task's file or cco/team.task (without its teamId). */
function checkTaskOp(where: string, raw: unknown): TaskOp | string {
  const o = objectOf(where, raw);
  if (typeof o === 'string') {
    return o;
  }
  const ops = Object.keys(TASK_OP_KEYS) as Array<keyof typeof TASK_OP_KEYS>;
  if (typeof o.op !== 'string' || !(ops as string[]).includes(o.op)) {
    return `${where}: \`op\` must be one of ${ops.join(', ')}.`;
  }
  const op = o.op as keyof typeof TASK_OP_KEYS;
  const required = op === 'add' ? ['tasks'] : op === 'assign' ? ['task', 'to'] : ['task'];
  const problem = checkFields(where, o, hostKeys(TASK_OP_KEYS[op]), TASK_OP_TYPES, required);
  if (problem !== undefined) {
    return problem;
  }
  if (op === 'add') {
    const tasks = checkEach(`${where} tasks`, o.tasks, hostKeys(TASK_KEYS), TASK_TYPES);
    if (typeof tasks === 'string') {
      return tasks;
    }
    o.tasks = tasks;
  }
  return o as unknown as TaskOp;
}

/** team_member / cco/team.member (§7.2): exactly one op; --now only with stop/pause; the switch keys only with switch, ≥ 1. */
function checkMemberOp(where: string, raw: unknown): MemberOp | string {
  const o = objectOf(where, raw);
  if (typeof o === 'string') {
    return o;
  }
  const problem = checkFields(where, o, ['member', 'op', 'now', ...MEMBER_SWITCH_KEYS], MEMBER_OP_TYPES, ['member', 'op']);
  if (problem !== undefined) {
    return problem;
  }
  if (!MEMBER_NAME.test(o.member as string)) {
    return badFlagValueText(where, 'member', o.member, 'a member name');
  }
  const op = o.op as string;
  if (!(MEMBER_OPS as readonly string[]).includes(op)) {
    return MEMBER_OP_RULES_TEXT.op(op);
  }
  if (o.now === true && !(MEMBER_OP_NOW_OPS as readonly string[]).includes(op)) {
    return MEMBER_OP_RULES_TEXT.now();
  }
  const switchKeys = MEMBER_SWITCH_KEYS.filter((k) => hasOwn(o, k));
  if (switchKeys.length > 0 && op !== 'switch') {
    return MEMBER_OP_RULES_TEXT.switchKeys();
  }
  if (op === 'switch' && switchKeys.length === 0) {
    return MEMBER_OP_RULES_TEXT.switchNeedsOne();
  }
  if (typeof o.worker === 'string' && (o.worker.length > WORKER_FLAG_MAX_CHARS || hasControlChar(o.worker))) {
    return MEMBER_OP_RULES_TEXT.worker();
  }
  return o as unknown as MemberOp;
}

/**
 * A member tool call's arguments against the tool's input schema (§3.7: additionalProperties
 * false; an unknown key or a wrong type → `invalid_arguments: <key> …`). This is where I5 shows: a
 * member that names another member in an argument (`from`, `member`, …) is refused here, because
 * no tool has such an argument — its identity is its connection.
 */
function checkToolArguments(tool: TeamTool, raw: unknown): Json | string {
  const schema = TEAM_TOOL_DEFINITIONS[tool].inputSchema;
  if (raw === undefined || raw === null) {
    raw = {};
  }
  if (!isPlainObject(raw)) {
    return TEAM_TOOL_TEXT.invalidArguments('arguments', 'must be a JSON object');
  }
  const allowed = Object.keys(schema.properties);
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      const closest = closestKey(key, allowed);
      return TEAM_TOOL_TEXT.invalidArguments(
        oneLine(key, 64),
        closest !== undefined
          ? `is not an argument of ${tool}; did you mean ${closest}?`
          : `is not an argument of ${tool}, which takes none`,
      );
    }
  }
  for (const key of allowed) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    const prop = schema.properties[key];
    if (typeof value !== 'string') {
      return TEAM_TOOL_TEXT.invalidArguments(key, 'must be a string');
    }
    if (prop.enum !== undefined && !prop.enum.includes(value)) {
      return TEAM_TOOL_TEXT.invalidArguments(key, `must be one of ${prop.enum.join(', ')}`);
    }
  }
  for (const key of schema.required ?? []) {
    if (raw[key] === undefined) {
      return TEAM_TOOL_TEXT.invalidArguments(key, 'is required');
    }
  }
  return raw;
}

/* ------------------------------------------------------------------------- *
 * Observer params (protocol misuse → TeamProtocolError invalidParams, MD-54)
 * ------------------------------------------------------------------------- */

function invalidParams(message: string): TeamProtocolError {
  return new TeamProtocolError(TEAM_RPC.invalidParams, message);
}
/**
 * The params object of an observer method. Unknown keys are IGNORED here (forward compatibility,
 * as §2.3's readers ignore unknown fields) — except where the params ARE a file schema
 * (cco/team.task, cco/team.member), whose keys are checked like the lead's files.
 */
function paramsOf(method: string, params: unknown): Json {
  if (params === undefined) {
    return {};
  }
  if (!isPlainObject(params)) {
    throw invalidParams(`${method}: params must be a JSON object`);
  }
  return params;
}
function reqString(method: string, p: Json, key: string, shape?: RegExp, shapeName?: string): string {
  const v = p[key];
  if (typeof v !== 'string' || (shape !== undefined && !shape.test(v))) {
    throw invalidParams(`${method}: \`${key}\` must be ${shapeName ?? 'a string'}`);
  }
  return v;
}
function optString(method: string, p: Json, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw invalidParams(`${method}: \`${key}\` must be a string`);
  }
  return v;
}
function optBool(method: string, p: Json, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== 'boolean') {
    throw invalidParams(`${method}: \`${key}\` must be true or false`);
  }
  return v;
}
function optInt(method: string, p: Json, key: string, min: number, max: number): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalidParams(`${method}: \`${key}\` must be an integer from ${min} to ${max}`);
  }
  return v;
}

/* ------------------------------------------------------------------------- *
 * The surface
 * ------------------------------------------------------------------------- */

/** A held cco/team.subscribe (one per connection, L8). */
interface Subscription {
  teamId: string;
  activity: boolean;
  /** The last seq pushed (or covered by the snapshot): nothing at or below it is pushed again. */
  lastSeq: number;
  /** Answers the held request. */
  answer(result: object): void;
}

/** A take-over grant made through a connection (§3.10 step 4: its orphan clock). */
interface Grant {
  conn: ConnId;
  attached: boolean;
  orphanTimer?: NodeJS.Timeout;
}

class Surface implements TeamEngine, TeamHostSide {
  private connections: TeamConnections | undefined;
  /** Connections greeted as observers (the TEAM_OBSERVER_CONNECTIONS_MAX count, the cco/team.host pushes). */
  private readonly observers = new Set<ConnId>();
  /** Member connections → the member each one IS (I5). */
  private readonly memberConns = new Map<ConnId, string>();
  private readonly subs = new Map<ConnId, Subscription>();
  /** The held cco/team.wait requests of each connection. */
  private readonly waiters = new Map<ConnId, Set<AbortController>>();
  private readonly grants = new Map<string, Grant>();
  /** turn id → member, from `turn.planned` (TurnEndedBody names no member). */
  private readonly turnMembers = new Map<string, string>();
  /**
   * Every turn id a `turn.planned` of the owned team announced while this host owned it, oldest
   * first, at most KNOWN_TURNS_MAX — the first place cco/team.turnText looks (A39, turnRecorded).
   */
  private readonly knownTurns = new Set<string>();
  /** The id of the team this host owned when it last looked — the last events of an ending team still go out. */
  private ownedId: string | undefined;
  private suspending = false;
  private sweeping: Promise<void> | undefined;
  private sweepNotes: Array<{ teamId: string; text: string; shows: number }> = [];

  constructor(
    private readonly core: TeamCore,
    private readonly runtime: TeamRuntime,
  ) {
    try {
      core.onEvent((e) => this.onCoreEvent(e));
      core.onActivity((member, items) => this.onCoreActivity(member, items));
    } catch (err) {
      this.log(`could not subscribe to the core: ${errorText(err)}`);
    }
  }

  setConnections(connections: TeamConnections): void {
    this.connections = connections;
  }

  private log(line: string): void {
    try {
      this.runtime.log(`team: ${line}`);
    } catch {
      // the host's log is best effort
    }
  }

  /* ---- TeamEngine ---- */

  async toolCall(name: TeamOp, args: unknown, capChars: number | undefined): Promise<TextResult> {
    try {
      await this.sweepWait();
      if (this.suspending) {
        return textResult(TEAM_TEXT.suspending(), true);
      }
      return await this.leadOp(name, args, capChars);
    } catch (err) {
      this.log(`${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return textResult(internalErrorText(name, err), true);
    }
  }

  /**
   * The unread line (§4.4 item 2) — and, for the first few answers after an orphan sweep, the
   * sweep's `Team <name> was suspended … team_resume <name>` (§2.5: "a footer line for the lead"),
   * kept only while both fit the footer's reserve (TEAM_FOOTER_RESERVE_CHARS, L9); the unread line
   * wins when they do not. Cheap and synchronous; never throws.
   */
  footer(): string | undefined {
    try {
      const unread = footerLine(this.core.footerCounts());
      this.sweepNotes = this.sweepNotes.filter((n) => n.shows < SWEEP_NOTE_SHOWS);
      const lines: string[] = [];
      for (const note of this.sweepNotes) {
        const candidate = [...lines, note.text, ...(unread !== undefined ? [unread] : [])].join('\n');
        if (candidate.length <= TEAM_FOOTER_RESERVE_CHARS) {
          lines.push(note.text);
          note.shows++;
        }
      }
      if (unread !== undefined) {
        lines.push(unread);
      }
      return lines.length > 0 ? lines.join('\n') : undefined;
    } catch (err) {
      this.log(`footer failed: ${errorText(err)}`);
      return undefined;
    }
  }

  ownsTurn(taskId: string): boolean {
    try {
      return this.core.ownsTurn(taskId);
    } catch (err) {
      this.log(`ownsTurn failed: ${errorText(err)}`);
      return false;
    }
  }

  async cancelTurn(taskId: string): Promise<string> {
    try {
      return await this.core.cancelTurn(taskId);
    } catch (err) {
      this.log(`cancelTurn ${taskId} failed: ${errorText(err)}`);
      return `${oneLine(taskId, 140)}: ${internalErrorText('cancel', err)}`;
    }
  }

  /**
   * H2, §7.9: `cco/team.host {state:'suspending'}` to every observer FIRST (their connections stay
   * writable), every held team_wait answered, then the core's suspend — awaited at most `budgetMs`
   * on the surface's own timer, so this resolves within the budget even if the core did not.
   */
  async suspendAll(budgetMs: number): Promise<void> {
    try {
      this.suspending = true;
      if (this.core.team() !== undefined) {
        this.pushHost('suspending');
      }
      for (const set of this.waiters.values()) {
        for (const controller of set) {
          controller.abort();
        }
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.core.suspendAll(budgetMs).catch((err: unknown) => this.log(`suspendAll failed: ${errorText(err)}`)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, budgetMs));
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    } catch (err) {
      this.log(`suspendAll failed: ${errorText(err)}`);
    }
  }

  /**
   * S1-6, P13: the orphan sweep, once (a second call returns the first one's promise). Team ops
   * wait for it at most SWEEP_WAIT_MS. Every team that was `active` with no live owner before and
   * is `suspended` after is reported — `cco/team.host` to observers and a footer line for the lead.
   * listTeams() leaves out an `active` team this host does not own, so such a team is ABSENT from
   * the list before the sweep: absent before and `suspended` after is a team the sweep suspended.
   * Residual, stated: the core learns the repository root during its sweep, and listTeams filters
   * by that root once known (by the workspace before) — an OLD suspended team of the same
   * repository created from another workspace directory can appear only after, and is then
   * reported too (its line stays true: it is suspended, and team_resume is the way back).
   */
  sweep(): Promise<void> {
    if (this.sweeping === undefined) {
      this.sweeping = this.runSweep();
    }
    return this.sweeping;
  }

  private async runSweep(): Promise<void> {
    try {
      const before = this.safeList();
      await this.core.sweep();
      const after = this.safeList();
      for (const t of after) {
        const was = before.find((b) => b.teamId === t.teamId);
        if (t.state === 'suspended' && (was === undefined || (was.state === 'active' && !was.ownedHere && was.owner === undefined))) {
          const text = TEAM_TEXT.suspendedAfterHostEnded(t.name);
          this.sweepNotes.push({ teamId: t.teamId, text, shows: 0 });
          this.pushHost('running', text);
        }
      }
    } catch (err) {
      this.log(`sweep failed: ${errorText(err)}`);
    }
  }

  active(): boolean {
    try {
      return this.core.team()?.status === 'active';
    } catch {
      return false;
    }
  }

  private safeList(): ReturnType<TeamCore['listTeams']> {
    try {
      return this.core.listTeams();
    } catch (err) {
      this.log(`listTeams failed: ${errorText(err)}`);
      return [];
    }
  }

  private async sweepWait(): Promise<void> {
    if (this.sweeping === undefined) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.sweeping,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SWEEP_WAIT_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  /* ---- the lead's operations (§7.2–§7.4) ---- */

  private async leadOp(name: TeamOp, args: unknown, capChars: number | undefined): Promise<TextResult> {
    const refused = (r: TeamRefusal): TextResult => textResult(r.sentence, true);
    switch (name) {
      case 'team_create': {
        const file = checkTeamFile(args);
        if (typeof file === 'string') {
          return textResult(file, true);
        }
        const r = await this.core.create(file, 'lead');
        return r.ok ? textResult(renderCreateAnswer(r.value, r.warnings, this.runtime.dataRoot)) : refused(r);
      }
      case 'team_add': {
        const file = checkMembersFile(args);
        if (typeof file === 'string') {
          return textResult(file, true);
        }
        const r = await this.core.add(file, 'lead');
        return r.ok ? textResult(renderCreateAnswer(r.value, r.warnings, this.runtime.dataRoot)) : refused(r);
      }
      case 'team_send': {
        const msg = checkLeadMessage(args);
        if (typeof msg === 'string') {
          return textResult(msg, true);
        }
        const r = await this.core.send(msg, 'lead');
        return r.ok ? textResult(renderSendAnswer(r.value, r.warnings, Date.now())) : refused(r);
      }
      case 'team_inbox': {
        const o = objectOf('team_inbox', args ?? {});
        if (typeof o === 'string') {
          return textResult(o, true);
        }
        const problem = checkFields('team_inbox', o, ['all', 'capChars'], { all: 'boolean', capChars: 'number' });
        if (problem !== undefined) {
          return textResult(problem, true);
        }
        if (this.core.team() === undefined) {
          return textResult(TEAM_TEXT.noTeam(), true);
        }
        const page = this.core.inbox('lead', capOf(capChars ?? o.capChars), o.all === true);
        return textResult(page.text);
      }
      case 'team_status':
        return this.statusOp(args);
      case 'team_task': {
        const op = checkTaskOp('task-op file', args);
        if (typeof op === 'string') {
          return textResult(op, true);
        }
        const r = await this.core.board(op, 'lead');
        return r.ok ? textResult(renderBoardAnswer(op.op, r.value, r.warnings)) : refused(r);
      }
      case 'team_member': {
        const op = checkMemberOp('team_member', args);
        if (typeof op === 'string') {
          return textResult(op, true);
        }
        const r = await this.core.member(op, 'lead');
        return r.ok ? textResult(renderMemberAnswer(r.value, r.warnings)) : refused(r);
      }
      case 'team_attach': {
        const o = objectOf('team_attach', args);
        if (typeof o === 'string') {
          return textResult(o, true);
        }
        const problem = checkFields('team_attach', o, ['member'], { member: 'string' }, ['member']);
        if (problem !== undefined) {
          return textResult(problem, true);
        }
        const member = o.member as string;
        if (!MEMBER_NAME.test(member)) {
          return textResult(badFlagValueText('team_attach', 'member', member, 'a member name'), true);
        }
        const notClaude = this.notClaudeRefusal(member);
        if (notClaude !== undefined) {
          return refused(notClaude);
        }
        // §3.10 step 1: the lead's take-over only PRINTS the plan (TeamCore.takeover by 'lead'
        // computes it without a grant); there is no connection to start an orphan clock on.
        const r = await this.core.takeover(member, false, 'lead', NO_CONN);
        return r.ok ? textResult(renderAttachPlan(member, r.value)) : refused(r);
      }
      case 'team_end': {
        const o = objectOf('team_end', args ?? {});
        if (typeof o === 'string') {
          return textResult(o, true);
        }
        const problem = checkFields('team_end', o, ['now'], { now: 'boolean' });
        if (problem !== undefined) {
          return textResult(problem, true);
        }
        const r = await this.endTeam(o.now === true, 'lead');
        return r.ok ? textResult(renderEndAnswer(r.value.answer, r.value.repoRoot, r.warnings)) : refused(r);
      }
      case 'team_resume': {
        const o = objectOf('team_resume', args ?? {});
        if (typeof o === 'string') {
          return textResult(o, true);
        }
        const problem = checkFields('team_resume', o, ['team'], { team: 'string' });
        if (problem !== undefined) {
          return textResult(problem, true);
        }
        const ref = o.team as string | undefined;
        if (ref !== undefined && !TEAM_ID.test(ref) && !TEAM_NAME.test(ref)) {
          return textResult(badFlagValueText('team_resume', 'team', ref, 'a team id or a team name'), true);
        }
        const r = await this.core.resume(ref, 'lead');
        if (!r.ok) {
          return refused(r);
        }
        this.sweepNotes = this.sweepNotes.filter((n) => n.teamId !== r.value.state.id);
        return textResult(renderCreateAnswer(r.value, r.warnings, this.runtime.dataRoot));
      }
    }
    return textResult(`${oneLine(name, 40)} is not a team operation.`, true);
  }

  /** §3.10 / S1-3: a take-over of a member that runs on another vendor → `not_supported` (also the core's rule; checked here so the words are the contract's). */
  private notClaudeRefusal(member: string): TeamRefusal | undefined {
    const m = this.core.team()?.members.find((x) => x.name === member);
    return m !== undefined && m.provider !== 'claude'
      ? teamRefusal('not_supported', TEAM_TEXT.takeoverNotSupported(member, m.provider))
      : undefined;
  }

  /** team_end and cco/team.end: `cco/team.host {state:'ending'}` to observers first; `running` again when the core refused. */
  private async endTeam(now: boolean, by: 'lead' | 'user'): Promise<Result<{ answer: EndAnswer; repoRoot: string }>> {
    const before = this.core.team();
    if (before !== undefined) {
      this.pushHost('ending');
    }
    const r = await this.core.end(now, by);
    if (!r.ok) {
      if (before !== undefined) {
        this.pushHost('running');
      }
      return r;
    }
    return { ok: true, value: { answer: r.value, repoRoot: before?.repoRoot ?? '' }, warnings: r.warnings };
  }

  /** team_status (§7.2, §7.4): no flag, `--all`, `--member`, `--task`, `--message` — at most one. */
  private statusOp(args: unknown): TextResult {
    const o = objectOf('team_status', args ?? {});
    if (typeof o === 'string') {
      return textResult(o, true);
    }
    const problem = checkFields('team_status', o, ['all', 'member', 'task', 'message'], {
      all: 'boolean',
      member: 'string',
      task: 'string',
      message: 'string',
    });
    if (problem !== undefined) {
      return textResult(problem, true);
    }
    const given = ['all', 'member', 'task', 'message'].filter((k) => hasOwn(o, k) && o[k] !== false);
    if (given.length > 1) {
      return textResult(statusOneFlagText(), true);
    }
    if (o.all === true) {
      return textResult(renderStatusAll(this.core.listTeams()));
    }
    const team = this.core.team();
    if (team === undefined) {
      return textResult(TEAM_TEXT.noTeam(), true);
    }
    const teamDir = teamDirOf(this.runtime.dataRoot, team.id);
    const now = Date.now();
    if (typeof o.member === 'string') {
      if (!MEMBER_NAME.test(o.member)) {
        return textResult(badFlagValueText('team_status', 'member', o.member, 'a member name'), true);
      }
      const m = team.members.find((x) => x.name === o.member);
      if (m === undefined) {
        return textResult(this.unknownMemberText(team, o.member), true);
      }
      const feed = this.feedTail(team.id, m.name, STATUS_MEMBER_FEED_ITEMS);
      return textResult(renderMemberStatus(team, m, now, feed, this.lastMessages(team, m.name, STATUS_MEMBER_MESSAGES)));
    }
    if (typeof o.task === 'string') {
      if (!BOARD_ID.test(o.task)) {
        return textResult(badFlagValueText('team_status', 'task', o.task, 'a board task id (b1, b2, …)'), true);
      }
      const t = team.board.find((x) => x.id === o.task);
      if (t === undefined) {
        return textResult(TEAM_TOOL_TEXT.unknownTask(o.task), true);
      }
      const reports = t.reports.map((r, i) => ({
        at: r.at,
        by: r.by,
        text: readText(boardReportFileOf(teamDir, t.id, i + 1), STATUS_TASK_MAX_BYTES + 4),
      }));
      return textResult(renderTaskStatus(t, newFenceId(), STATUS_TASK_MAX_BYTES, this.taskBody(teamDir, t), reports));
    }
    if (typeof o.message === 'string') {
      if (!MESSAGE_ID.test(o.message)) {
        return textResult(badFlagValueText('team_status', 'message', o.message, 'a message id (m1, m2, …)'), true);
      }
      const found = this.messageEvent(team.id, o.message);
      if (found === undefined) {
        return textResult(TEAM_TOOL_TEXT.unknownMessage(o.message), true);
      }
      const text = found.posted.body ?? readText(messageBodyFileOf(teamDir, o.message), MESSAGE_MAX_BYTES + 4);
      return textResult(renderMessageStatus(o.message, found.ts, found.posted, text, newFenceId()));
    }
    return textResult(renderStatus(team, now, (t) => this.taskBody(teamDir, t)));
  }

  private unknownMemberText(team: TeamState, x: string): string {
    const names = team.members.map((m) => m.name);
    return TEAM_TEXT.unknownMember(oneLine(x, 40), team.name, names, nearName(x, names));
  }

  /** A board task's body: inline, or its `bodies/b<n>.md` read through the path helper (A15). */
  private taskBody(teamDir: string, t: { id: string; body?: string; bodyFile?: string }): string | undefined {
    if (t.body !== undefined) {
      return t.body;
    }
    return t.bodyFile !== undefined ? readText(boardBodyFileOf(teamDir, t.id), BOARD_BODY_MAX_BYTES + 4) : undefined;
  }

  /** The `msg.posted` event of a message id, through the core's log reader. */
  private messageEvent(teamId: string, msgId: string): { ts: number; posted: MsgPostedBody } | undefined {
    const seq = seqOfMessageId(msgId);
    if (seq === undefined) {
      return undefined;
    }
    const got = this.core.eventsFrom(teamId, seq - 1, 1);
    if (!Array.isArray(got)) {
      return undefined;
    }
    const e = got[0];
    return e !== undefined && e.seq === seq && e.type === 'msg.posted' ? { ts: e.ts, posted: e } : undefined;
  }

  /** A member's last messages, to or from it, among the last TEAM_SUBSCRIBE_REPLAY_MAX events (stated bound). */
  private lastMessages(team: TeamState, member: string, max: number): MessageHead[] {
    const from = Math.max(0, team.seq - TEAM_SUBSCRIBE_REPLAY_MAX);
    const events = this.core.eventsFrom(team.id, from, TEAM_SUBSCRIBE_REPLAY_MAX);
    if (!Array.isArray(events)) {
      return [];
    }
    const teamDir = teamDirOf(this.runtime.dataRoot, team.id);
    const heads: MessageHead[] = [];
    for (const e of events) {
      if (e.type !== 'msg.posted') {
        continue;
      }
      if (e.from !== member && e.to !== member && !(e.recipients ?? []).includes(member)) {
        continue;
      }
      const id = `m${e.seq}`;
      const text = e.body ?? readText(messageBodyFileOf(teamDir, id), MESSAGE_HEAD_READ_BYTES) ?? '';
      heads.push({ id, ts: e.ts, from: e.from, to: e.to, kind: e.kind, text });
    }
    return heads.slice(-max);
  }

  /** A member's last `limit` feed items, oldest first: `feed.jsonl`, then its one rotation when that is not enough (§3.8). */
  private feedTail(teamId: string, member: string, limit: number): FeedItem[] {
    const teamDir = teamDirOf(this.runtime.dataRoot, teamId);
    const read = (rotated: boolean): FeedItem[] => {
      const got = readFileBytes(memberFeedFileOf(teamDir, member, rotated), FEED_READ_MAX_BYTES, true);
      if (got === undefined) {
        return [];
      }
      let text = got.buf.toString('utf8');
      if (got.start > 0) {
        // a tail read starts inside a line: that line is not whole
        text = text.slice(text.indexOf('\n') + 1);
      }
      return feedItemsOf(text);
    };
    let items = read(false);
    if (items.length < limit) {
      items = [...read(true), ...items];
    }
    return items.slice(-limit);
  }

  /* ---- TeamHostSide ---- */

  hello(conn: ConnId, role: 'observer' | 'member', params: unknown): { ok: true; result: object } | { ok: false; code: number; message: string } {
    try {
      if (this.suspending) {
        return { ok: false, code: RPC_ERROR.roleForbidden, message: TEAM_TEXT.suspending() };
      }
      return role === 'member' ? this.helloMember(conn, params) : this.helloObserver(conn, params);
    } catch (err) {
      this.log(`hello failed: ${errorText(err)}`);
      return { ok: false, code: TEAM_RPC.internalError, message: 'the team engine could not decide this hello' };
    }
  }

  private helloObserver(conn: ConnId, params: unknown): { ok: true; result: object } | { ok: false; code: number; message: string } {
    if (!isPlainObject(params) || !(TEAM_OBSERVER_CLIENTS as readonly unknown[]).includes(params.client)) {
      return { ok: false, code: TEAM_RPC.invalidParams, message: `an observer hello names its client: ${TEAM_OBSERVER_CLIENTS.join(', ')}` };
    }
    if (!this.observers.has(conn) && this.observers.size >= TEAM_OBSERVER_CONNECTIONS_MAX) {
      return { ok: false, code: RPC_ERROR.roleForbidden, message: `at most ${TEAM_OBSERVER_CONNECTIONS_MAX} observers per host` };
    }
    this.observers.add(conn);
    return { ok: true, result: {} };
  }

  /**
   * A member hello (§7.6, I5, P64/P65): the team must be the one this host owns, the member must
   * be in a live turn (`running`, or `pausing` — still finishing that turn; CONTRACT-QUESTION: §7.6
   * says `running`), and sha256 of the presented credential must equal that of the credential FILE
   * the core wrote 0600 at this lease acquisition (timingSafeEqual). Every refusal is -32012 with
   * one generic message and a host-log line naming the member; past
   * TEAM_MEMBER_CONNECTIONS_MAX it is -32013.
   */
  private helloMember(conn: ConnId, params: unknown): { ok: true; result: object } | { ok: false; code: number; message: string } {
    const refuse = (why: string): { ok: false; code: number; message: string } => {
      this.log(`member hello refused (${why})`);
      return { ok: false, code: RPC_ERROR.badCredential, message: 'the team refused this member credential' };
    };
    if (!isPlainObject(params)) {
      return refuse('malformed hello');
    }
    const { teamId, member, credential } = params;
    if (typeof teamId !== 'string' || !TEAM_ID.test(teamId) || typeof member !== 'string' || !MEMBER_NAME.test(member)) {
      return refuse('malformed team or member');
    }
    if (typeof credential !== 'string' || !CREDENTIAL.test(credential)) {
      return refuse(`malformed credential for ${member} of ${teamId}`);
    }
    const team = this.core.team();
    if (team === undefined || team.id !== teamId) {
      return refuse(`${teamId} is not the team this host leads; member ${member}`);
    }
    const m = team.members.find((x) => x.name === member);
    if (m === undefined || (!LIVE_TURN_STATES.has(m.state) && m.turn === undefined)) {
      return refuse(`${member} of ${teamId} is ${m?.state ?? 'not a member'}`);
    }
    const file = memberFilesOf(teamDirOf(this.runtime.dataRoot, teamId), member).credential;
    const held = readText(file, CREDENTIAL_FILE_MAX_BYTES)?.trim();
    if (held === undefined || !CREDENTIAL.test(held)) {
      return refuse(`no readable credential file for ${member} of ${teamId}`);
    }
    if (!sameSecret(held, credential)) {
      return refuse(`a wrong credential was presented for ${member} of ${teamId}`);
    }
    const open = [...this.memberConns.values()].filter((x) => x === member).length;
    if (!this.memberConns.has(conn) && open >= TEAM_MEMBER_CONNECTIONS_MAX) {
      return { ok: false, code: RPC_ERROR.roleForbidden, message: `at most ${TEAM_MEMBER_CONNECTIONS_MAX} connections per member` };
    }
    this.memberConns.set(conn, member);
    this.core.memberConnection(member, conn, true);
    return { ok: true, result: {} };
  }

  async request(conn: ConnId, method: string, params: unknown): Promise<unknown> {
    try {
      if (method !== METHOD_TEAM.memberCall) {
        await this.sweepWait();
      }
      return await this.dispatch(conn, method, params);
    } catch (err) {
      if (err instanceof TeamProtocolError) {
        throw err;
      }
      this.log(`${method} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      throw new TeamProtocolError(TEAM_RPC.internalError, internalErrorText(method, err));
    }
  }

  closed(conn: ConnId): void {
    try {
      this.observers.delete(conn);
      this.endSubscription(conn, { ok: true });
      const waiters = this.waiters.get(conn);
      if (waiters !== undefined) {
        this.waiters.delete(conn);
        for (const controller of waiters) {
          controller.abort();
        }
      }
      const member = this.memberConns.get(conn);
      if (member !== undefined) {
        this.memberConns.delete(conn);
        this.core.memberConnection(member, conn, false);
      }
      for (const [lease, grant] of this.grants) {
        if (grant.conn === conn && !grant.attached && grant.orphanTimer === undefined) {
          this.startOrphanClock(lease, grant);
        }
      }
    } catch (err) {
      this.log(`closed(${conn}) failed: ${errorText(err)}`);
    }
  }

  /** §3.10 step 4: the granting connection is gone — with no pid reported for ATTACH_ORPHAN_MS the grant is released. */
  private startOrphanClock(lease: string, grant: Grant): void {
    grant.orphanTimer = setTimeout(() => {
      grant.orphanTimer = undefined;
      if (this.grants.get(lease) !== grant || grant.attached) {
        return;
      }
      this.grants.delete(lease);
      this.core.release(lease, 'orphan').then(
        (r) => {
          if (!r.ok) {
            this.log(`orphaned take-over ${lease} not released: ${r.sentence}`);
          }
        },
        (err: unknown) => this.log(`orphaned take-over ${lease} not released: ${errorText(err)}`),
      );
    }, ATTACH_ORPHAN_MS);
    grant.orphanTimer.unref?.();
  }

  private dropGrant(lease: string): void {
    const grant = this.grants.get(lease);
    if (grant !== undefined) {
      if (grant.orphanTimer !== undefined) {
        clearTimeout(grant.orphanTimer);
      }
      this.grants.delete(lease);
    }
  }

  /** A team this host owns, or the `not_owned_here` refusal naming the owning session when one is alive (§7.6). */
  private owned(teamId: string): TeamState | TeamRefusal {
    const team = this.core.team();
    if (team !== undefined && team.id === teamId) {
      this.ownedId = team.id;
      return team;
    }
    const entry = this.safeList().find((t) => t.teamId === teamId);
    const name = entry?.name ?? this.core.snapshotOf(teamId)?.name ?? teamId;
    return teamRefusal('not_owned_here', TEAM_TEXT.notOwnedHere(oneLine(name, 40), entry?.owner));
  }

  private async dispatch(conn: ConnId, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case METHOD_TEAM.memberCall:
        return this.memberCall(conn, params);
      case METHOD_TEAM.wait:
        return this.wait(conn, params);
      case METHOD_TEAM.list:
        return { ok: true, teams: this.core.listTeams() };
      case METHOD_TEAM.get: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const state = this.core.snapshotOf(teamId);
        return state !== undefined ? { ok: true, state } : { ok: false, code: 'unknown_team', sentence: unknownTeamText(teamId) };
      }
      case METHOD_TEAM.subscribe:
        return this.subscribe(conn, paramsOf(method, params));
      case METHOD_TEAM.unsubscribe: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        if (this.subs.get(conn)?.teamId === teamId) {
          this.endSubscription(conn, { ok: true });
        }
        return { ok: true };
      }
      case METHOD_TEAM.activityTail:
        return this.activityTail(paramsOf(method, params));
      case METHOD_TEAM.messageBody:
        return this.messageBody(paramsOf(method, params));
      case METHOD_TEAM.turnText:
        return this.turnText(paramsOf(method, params));
      case METHOD_TEAM.send: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const msg: OutgoingMessage = {
          to: reqString(method, p, 'to'),
          text: reqString(method, p, 'text'),
          kind: optString(method, p, 'kind') as OutgoingMessage['kind'],
          urgent: optBool(method, p, 'urgent'),
          replyTo: optString(method, p, 'replyTo'),
          tellLead: optBool(method, p, 'tellLead') ?? true,
        };
        if (msg.kind !== undefined && !(SENDER_MESSAGE_KINDS as readonly string[]).includes(msg.kind)) {
          throw invalidParams(`${method}: \`kind\` must be one of ${SENDER_MESSAGE_KINDS.join(', ')}`);
        }
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = await this.core.send(msg, 'user');
        return r.ok
          ? { ok: true, msgId: r.value.msgId, recipients: r.value.recipients.map((x) => ({ to: x.to, state: x.state })) }
          : r;
      }
      case METHOD_TEAM.task: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const rest: Json = { ...p };
        delete rest.teamId;
        const op = checkTaskOp(method, rest);
        if (typeof op === 'string') {
          throw invalidParams(op);
        }
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = await this.core.board(op, 'user');
        return r.ok ? { ok: true, task: r.value.task, tasks: r.value.tasks, warnings: r.warnings } : r;
      }
      case METHOD_TEAM.member: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const rest: Json = { ...p };
        delete rest.teamId;
        const op = checkMemberOp(method, rest);
        if (typeof op === 'string') {
          throw invalidParams(op);
        }
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = await this.core.member(op, 'user');
        return r.ok ? { ok: true, state: r.value.state } : r;
      }
      case METHOD_TEAM.takeover: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const member = reqString(method, p, 'member', MEMBER_NAME, 'a member name');
        const now = optBool(method, p, 'now') ?? false;
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const notClaude = this.notClaudeRefusal(member);
        if (notClaude !== undefined) {
          return notClaude;
        }
        const r = await this.core.takeover(member, now, 'user', conn);
        if (!r.ok) {
          return r;
        }
        this.dropGrant(r.value.lease);
        this.grants.set(r.value.lease, { conn, attached: false });
        if (this.connections?.role(conn) === undefined) {
          // the granting connection went while the core worked: its orphan clock starts now
          this.startOrphanClock(r.value.lease, this.grants.get(r.value.lease) as Grant);
        }
        return { ok: true, plan: r.value };
      }
      case METHOD_TEAM.attached: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const lease = reqString(method, p, 'lease', ATTACH_LEASE, 'an attach lease (a + 8 hex)');
        const pid = optInt(method, p, 'pid', 1, 2 ** 31 - 1);
        if (pid === undefined) {
          throw invalidParams(`${method}: \`pid\` must be an integer from 1 to ${2 ** 31 - 1}`);
        }
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = this.core.attached(lease, pid);
        if (!r.ok) {
          return r;
        }
        const grant = this.grants.get(lease);
        if (grant !== undefined) {
          grant.attached = true;
          if (grant.orphanTimer !== undefined) {
            clearTimeout(grant.orphanTimer);
            grant.orphanTimer = undefined;
          }
        }
        return { ok: true };
      }
      case METHOD_TEAM.release: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const lease = reqString(method, p, 'lease', ATTACH_LEASE, 'an attach lease (a + 8 hex)');
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = await this.core.release(lease, 'release');
        if (!r.ok) {
          return r;
        }
        this.dropGrant(lease);
        return { ok: true };
      }
      case METHOD_TEAM.end: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const now = optBool(method, p, 'now') ?? false;
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        const r = await this.endTeam(now, 'user');
        return r.ok ? { ok: true } : r;
      }
      case METHOD_TEAM.markRead: {
        const p = paramsOf(method, params);
        const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
        const upToSeq = optInt(method, p, 'upToSeq', 0, Number.MAX_SAFE_INTEGER);
        if (upToSeq === undefined) {
          throw invalidParams(`${method}: \`upToSeq\` must be an integer from 0`);
        }
        const team = this.owned(teamId);
        if (isTeamRefusal(team)) {
          return team;
        }
        this.core.markRead('user', upToSeq);
        return { ok: true };
      }
    }
    throw new TeamProtocolError(TEAM_RPC.methodNotFound, `${oneLine(method, 80)} is not a team method`);
  }

  /* ---- the doorbell (§4.4 item 1) ---- */

  /**
   * cco/team.wait — HELD (session role). The core's waitForLead decides WHAT wakes (M11's kinds,
   * M13's report coalescing, the settle batching) and holds the one waiter; the surface gives it
   * the deadline (`waitSeconds`) and the connection's life as one AbortSignal. Woken → the inbox
   * page under `capChars` (marked read through the last message SHOWN, M9), exit 0. Deadline →
   * `timedOut`, exit 23. A second waiter → the fixed sentence, exit 0 (never supersede, P25).
   * Defaults when a field is absent: waitSeconds WAIT_MAX_SECONDS, settleSeconds
   * WAIT_SETTLE_DEFAULT_S, capChars OUT_CAP_CHARS; a present but invalid one is invalidParams.
   */
  private async wait(conn: ConnId, params: unknown): Promise<object> {
    const method = METHOD_TEAM.wait;
    const role = this.connections?.role(conn);
    if (role !== undefined && role !== 'session') {
      throw new TeamProtocolError(RPC_ERROR.roleForbidden, `${method} is the lead session's`);
    }
    const p = paramsOf(method, params);
    const waitSeconds = optInt(method, p, 'waitSeconds', 1, WAIT_MAX_SECONDS) ?? WAIT_MAX_SECONDS;
    const settleSeconds = optInt(method, p, 'settleSeconds', 0, WAIT_SETTLE_MAX_S) ?? WAIT_SETTLE_DEFAULT_S;
    const capChars = optInt(method, p, 'capChars', 1, Number.MAX_SAFE_INTEGER) ?? OUT_CAP_CHARS;
    const answer = (text: string, isError: boolean, timedOut: boolean): object => ({ ...textResult(text, isError), timedOut });
    if (this.suspending) {
      return answer(TEAM_TEXT.suspending(), true, false);
    }
    const controller = new AbortController();
    let set = this.waiters.get(conn);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(conn, set);
    }
    set.add(controller);
    let deadline = false;
    const timer = setTimeout(() => {
      deadline = true;
      controller.abort();
    }, waitSeconds * 1000);
    try {
      const outcome = await this.core.waitForLead(controller.signal, settleSeconds * 1000);
      if (outcome === 'woken') {
        return answer(this.core.inbox('lead', capChars, false).text, false, false);
      }
      if (this.suspending && !deadline) {
        return answer(TEAM_TEXT.suspending(), true, false);
      }
      return answer(renderWaitTimedOut(this.core.team()?.name, waitSeconds), false, deadline);
    } catch (err) {
      if (isTeamRefusal(err)) {
        return answer(err.sentence, err.code !== 'already_waiting', false);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      set.delete(controller);
      if (set.size === 0 && this.waiters.get(conn) === set) {
        this.waiters.delete(conn);
      }
    }
  }

  /* ---- subscriptions (§7.6, H1) ---- */

  /**
   * cco/team.subscribe — HELD. The opening snapshot, the replay of the events after `fromSeq`
   * (≤ TEAM_SUBSCRIBE_REPLAY_MAX, else answered `resnapshot_required`), then every live event —
   * all NOT lossy, so an observer that cannot keep up is closed by host.ts (the push answers
   * `closed`) and the subscription ends at once; activity (when asked) is lossy. A second
   * subscribe on one connection answers the first `{ok:true, replaced:true}` (L8). The team's
   * final `team.status ended` answers it `{ok:true}` right after that event is pushed (A39,
   * onCoreEvent). `fromSeq` too far behind the head or beyond it is `resnapshot_required`, with
   * the one sentence that covers both (A39, S8).
   */
  private subscribe(conn: ConnId, p: Json): Promise<object> | object {
    const method = METHOD_TEAM.subscribe;
    const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
    const fromSeq = optInt(method, p, 'fromSeq', 0, Number.MAX_SAFE_INTEGER);
    const activity = optBool(method, p, 'activity') ?? false;
    const team = this.owned(teamId);
    if (isTeamRefusal(team)) {
      return team;
    }
    let replay: LogEvent[] = [];
    if (fromSeq !== undefined) {
      const got = this.core.eventsFrom(teamId, fromSeq, TEAM_SUBSCRIBE_REPLAY_MAX);
      if (!Array.isArray(got)) {
        return teamRefusal('resnapshot_required', TEAM_TEXT.resnapshotRequired());
      }
      replay = got;
    }
    this.endSubscription(conn, { ok: true, replaced: true });
    return new Promise<object>((resolve) => {
      const sub: Subscription = { teamId, activity, lastSeq: team.seq, answer: resolve };
      this.subs.set(conn, sub);
      if (this.push(conn, METHOD_TEAM.event, teamSnapshotParamsOf(team), false) === 'closed') {
        this.endSubscription(conn, { ok: true });
        return;
      }
      for (const e of replay) {
        if (this.subs.get(conn) !== sub) {
          return;
        }
        if (this.push(conn, METHOD_TEAM.event, teamEventParamsOf(teamId, e), false) === 'closed') {
          this.endSubscription(conn, { ok: true });
          return;
        }
        sub.lastSeq = Math.max(sub.lastSeq, e.seq);
      }
    });
  }

  private endSubscription(conn: ConnId, result: object): void {
    const sub = this.subs.get(conn);
    if (sub === undefined) {
      return;
    }
    this.subs.delete(conn);
    sub.answer(result);
  }

  private push(conn: ConnId, method: string, params: object, lossy: boolean): 'sent' | 'dropped' | 'closed' {
    if (this.connections === undefined) {
      return 'closed';
    }
    try {
      return this.connections.push(conn, method, params, lossy);
    } catch (err) {
      this.log(`push ${method} to ${conn} failed: ${errorText(err)}`);
      return 'closed';
    }
  }

  /** `cco/team.host` to every observer and every subscribed connection (§7.6); `requestId` is host.ts's to add. */
  private pushHost(state: 'running' | 'suspending' | 'ending', reason?: string): void {
    const params = reason !== undefined ? { state, reason } : { state };
    for (const conn of new Set([...this.observers, ...this.subs.keys()])) {
      if (this.push(conn, METHOD_TEAM.host, params, false) === 'closed') {
        this.endSubscription(conn, { ok: true });
      }
    }
  }

  private onCoreEvent(e: LogEvent): void {
    try {
      const team = this.core.team();
      if (team !== undefined) {
        this.ownedId = team.id;
      }
      this.afterEvent(e);
      const teamId = this.ownedId;
      if (teamId === undefined) {
        return;
      }
      const ended = e.type === 'team.status' && e.status === 'ended';
      for (const [conn, sub] of [...this.subs]) {
        if (sub.teamId !== teamId || e.seq <= sub.lastSeq) {
          continue;
        }
        sub.lastSeq = e.seq;
        if (this.push(conn, METHOD_TEAM.event, teamEventParamsOf(teamId, e), false) === 'closed' || ended) {
          // A39 (review S10): the team's final `team.status ended` is the last event a subscriber
          // is owed — its held subscribe is answered right after it, instead of being held on a
          // team that will never change again (the release of the lease that follows is not pushed).
          this.endSubscription(conn, { ok: true });
        }
      }
    } catch (err) {
      this.log(`event ${e?.seq} not handled: ${errorText(err)}`);
    }
  }

  /**
   * The surface's own bookkeeping per event: which member a turn is (`turn.planned`), its
   * connections closed at its `turn.ended` (M19, A15) — and at any `member.state` that leaves the
   * live-turn states, as a backstop — and a take-over grant forgotten at its `attach.ended`.
   */
  private afterEvent(e: LogEvent): void {
    switch (e.type) {
      case 'turn.planned':
        this.turnMembers.set(e.turnId, e.name);
        this.knownTurns.add(e.turnId);
        if (this.knownTurns.size > KNOWN_TURNS_MAX) {
          const oldest = this.knownTurns.values().next().value;
          if (oldest !== undefined) {
            this.knownTurns.delete(oldest);
          }
        }
        break;
      case 'turn.ended': {
        const member = this.turnMembers.get(e.turnId) ?? this.core.team()?.members.find((m) => m.turn?.id === e.turnId)?.name;
        this.turnMembers.delete(e.turnId);
        if (member !== undefined) {
          this.closeMemberConnections(member);
        }
        break;
      }
      case 'member.state':
        if (!LIVE_TURN_STATES.has(e.state)) {
          this.closeMemberConnections(e.name);
        }
        break;
      case 'attach.ended':
        this.dropGrant(e.lease);
        break;
    }
  }

  private closeMemberConnections(member: string): void {
    for (const [conn, name] of [...this.memberConns]) {
      if (name !== member) {
        continue;
      }
      this.memberConns.delete(conn);
      try {
        this.core.memberConnection(member, conn, false);
      } catch (err) {
        this.log(`memberConnection(${member}) failed: ${errorText(err)}`);
      }
      try {
        this.connections?.close(conn);
      } catch (err) {
        this.log(`close(${conn}) failed: ${errorText(err)}`);
      }
    }
  }

  private onCoreActivity(member: string, items: FeedItem[]): void {
    try {
      const teamId = this.ownedId ?? this.core.team()?.id;
      if (teamId === undefined) {
        return;
      }
      const chunks = activityChunks(items);
      for (const [conn, sub] of [...this.subs]) {
        if (!sub.activity || sub.teamId !== teamId) {
          continue;
        }
        for (const chunk of chunks) {
          if (this.push(conn, METHOD_TEAM.activity, { teamId, member, items: chunk }, true) === 'closed') {
            this.endSubscription(conn, { ok: true });
            break;
          }
        }
      }
    } catch (err) {
      this.log(`activity of ${member} not handled: ${errorText(err)}`);
    }
  }

  /* ---- the readers (A15) ---- */

  private activityTail(p: Json): object {
    const method = METHOD_TEAM.activityTail;
    const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
    const member = reqString(method, p, 'member', MEMBER_NAME, 'a member name');
    const limit = optInt(method, p, 'limit', 1, TEAM_ACTIVITY_TAIL_MAX) ?? ACTIVITY_TAIL_DEFAULT;
    const state = this.core.snapshotOf(teamId);
    if (state === undefined) {
      return { ok: false, code: 'unknown_team', sentence: unknownTeamText(teamId) };
    }
    if (!state.members.some((m) => m.name === member)) {
      return teamRefusal('unknown_member', this.unknownMemberText(state, member));
    }
    return { ok: true, items: this.feedTail(teamId, member, limit) };
  }

  /** The whole text of a message: inline in its `msg.posted`, else `bodies/m<seq>.md` read through the path helper. */
  private messageBody(p: Json): object {
    const method = METHOD_TEAM.messageBody;
    const teamId = reqString(method, p, 'teamId', TEAM_ID, 'a team id');
    const msgId = reqString(method, p, 'msgId', MESSAGE_ID, 'a message id');
    if (this.core.snapshotOf(teamId) === undefined) {
      return { ok: false, code: 'unknown_team', sentence: unknownTeamText(teamId) };
    }
    const found = this.messageEvent(teamId, msgId);
    const fromFile = (): string | undefined =>
      readText(messageBodyFileOf(teamDirOf(this.runtime.dataRoot, teamId), msgId), MESSAGE_MAX_BYTES + 4);
    const text = found !== undefined ? (found.posted.body ?? fromFile()) : fromFile();
    return text !== undefined ? { ok: true, text } : teamRefusal('unknown_message', TEAM_TOOL_TEXT.unknownMessage(msgId));
  }

  /**
   * `tasks/<turnId>.md` from `offsetBytes`, at most `maxBytes` (≤ TEAM_TURN_TEXT_MAX_BYTES), ending
   * on a whole UTF-8 character — only for a turn id a `turn.planned` of a team of this repository
   * recorded (A39, review S11; turnRecorded); any other id, a dispatch's task id included, is the
   * same `unknown_turn` as a missing file, so the answer never tells which ids exist.
   */
  private turnText(p: Json): object {
    const method = METHOD_TEAM.turnText;
    const turnId = reqString(method, p, 'turnId', TASK_ID, 'a task id');
    const offset = optInt(method, p, 'offsetBytes', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const maxBytes = optInt(method, p, 'maxBytes', 1, TEAM_TURN_TEXT_MAX_BYTES) ?? TEAM_TURN_TEXT_MAX_BYTES;
    if (!this.turnRecorded(turnId)) {
      return { ok: false, code: 'unknown_turn', sentence: unknownTurnText(turnId) };
    }
    const file = turnTextFileOf(this.runtime.dataRoot, turnId);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        return { ok: false, code: 'unknown_turn', sentence: unknownTurnText(turnId) };
      }
      const length = Math.max(0, Math.min(maxBytes, st.size - offset));
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buf, read, length - read, offset + read);
        if (n <= 0) {
          break;
        }
        read += n;
      }
      const got = buf.subarray(0, read);
      const end = offset + read < st.size ? completeUtf8Length(got) : got.length;
      return { ok: true, text: got.subarray(0, end).toString('utf8'), total: st.size };
    } catch {
      return { ok: false, code: 'unknown_turn', sentence: unknownTurnText(turnId) };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // read-only
        }
      }
    }
  }

  /**
   * Whether `turnId` was recorded by a `turn.planned` of a team of this repository (A39) — looked
   * up from the cheapest place on:
   *  1. the turn ids the owned team announced while this host owned it (knownTurns);
   *  2. the owned team's last TEAM_SUBSCRIBE_REPLAY_MAX events, through the core's log reader (the
   *     turns planned before this host adopted the team);
   *  3. every team of the repository (listTeams, ≤ TEAM_LIST_MAX) by its snapshot: a member's
   *     current and last turn and the turns of each board task — each of them a planned turn's id.
   * Stated residual: a turn of a team this host does not own that is neither a member's current
   * or last turn nor on its board, and a turn of the owned team older than the last
   * TEAM_SUBSCRIBE_REPLAY_MAX events and not seen live, read as unknown — the log of a team this
   * host does not own is not parsed per request (that would be up to TEAM_LOG_MAX bytes for any
   * id an observer cares to ask about). Never throws: a reader that fails answers "not recorded".
   */
  private turnRecorded(turnId: string): boolean {
    if (this.knownTurns.has(turnId)) {
      return true;
    }
    try {
      const owned = this.core.team();
      if (owned !== undefined) {
        const events = this.core.eventsFrom(owned.id, Math.max(0, owned.seq - TEAM_SUBSCRIBE_REPLAY_MAX), TEAM_SUBSCRIBE_REPLAY_MAX);
        if (Array.isArray(events) && events.some((e) => e.type === 'turn.planned' && e.turnId === turnId)) {
          return true;
        }
      }
      for (const entry of this.safeList()) {
        const state = owned !== undefined && entry.teamId === owned.id ? owned : this.core.snapshotOf(entry.teamId);
        if (
          state !== undefined &&
          (state.members.some((m) => m.turn?.id === turnId || m.lastTurn?.id === turnId) ||
            state.board.some((t) => t.turns.includes(turnId)))
        ) {
          return true;
        }
      }
    } catch (err) {
      this.log(`turnRecorded(${turnId}) failed: ${errorText(err)}`);
    }
    return false;
  }

  /* ---- the member side (§3.7) ---- */

  /**
   * cco/member.call: the member is the CONNECTION's (I5) — a connection that is not (or no
   * longer) a member's is answered `your turn has ended`; an unknown tool or an argument outside
   * the tool's schema is `invalid_arguments`; everything else is the core's (TeamCore.memberTool).
   */
  private async memberCall(conn: ConnId, params: unknown): Promise<TextResult> {
    const member = this.memberConns.get(conn);
    if (member === undefined) {
      this.log(`a tool call on connection ${conn}, which is no member's (any more)`);
      return textResult(TEAM_TOOL_TEXT.turnEnded(), true);
    }
    if (!isPlainObject(params) || typeof params.tool !== 'string') {
      throw invalidParams(`${METHOD_TEAM.memberCall}: params must be {tool, arguments}`);
    }
    const tool = params.tool;
    if (!(TEAM_TOOL_NAMES as readonly string[]).includes(tool)) {
      return toolRefusal(
        'invalid_arguments',
        TEAM_TOOL_TEXT.invalidArguments('tool', `"${oneLine(tool, 64)}" is not a team tool; the team tools are ${TEAM_TOOL_NAMES.join(', ')}`),
      );
    }
    const args = checkToolArguments(tool as TeamTool, params.arguments);
    if (typeof args === 'string') {
      return toolRefusal('invalid_arguments', args);
    }
    try {
      return await this.core.memberTool(member, tool as TeamTool, args);
    } catch (err) {
      this.log(`${tool} of ${member} failed: ${errorText(err)}`);
      return textResult(internalErrorText(tool, err), true);
    }
  }
}

/** An inbox cap from a client (M9), by value: a positive integer, else OUT_CAP_CHARS. */
function capOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : OUT_CAP_CHARS;
}

/** Activity items split so that each cco/team.activity stays within TEAM_ACTIVITY_NOTIFY_MAX_BYTES. */
function activityChunks(items: readonly FeedItem[]): FeedItem[][] {
  const chunks: FeedItem[][] = [];
  let current: FeedItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (current.length > 0 && bytes + size > ACTIVITY_ITEMS_BUDGET_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** src/team/surface.ts's factory (T1: `createTeamSurface: CreateTeamSurface`). */
export const createTeamSurface: CreateTeamSurface = (core: TeamCore, runtime: TeamRuntime): TeamSurface => {
  const surface = new Surface(core, runtime);
  return {
    engine: surface,
    hostSide: surface,
    setConnections: (connections: TeamConnections) => surface.setConnections(connections),
  };
};
