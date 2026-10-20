import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { sameProcess } from '../mcp/host-protocol';
import { isPidAlive, processStartedAt } from '../registry';
import { readTextSafe } from '../safeFs';
import {
  BOARD_ID,
  BOARD_TURNS_MAX,
  bodySha256,
  FEED_DETAIL_MAX_CHARS,
  FEED_KINDS,
  FEED_ROTATE,
  FEED_TEXT_MAX_BYTES,
  FEED_TOOL_MAX_CHARS,
  GOAL_MAX,
  HEAD_MAX_CHARS,
  LOG_LINE_MAX,
  MACHINE_LOGIN_KEYS,
  MACHINE_LOGIN_LABELS,
  MEMBER_NAME,
  MEMBER_STATES,
  memberFilesOf,
  memberPortBase,
  MESSAGE_MAX_BYTES,
  messageIdOf,
  seqOfMessageId,
  START_LOCK_STALE_MS,
  START_SLACK_MS,
  STATE_MAX,
  TASK_STATES,
  TEAM_DIR_MODE,
  TEAM_DIR_SCAN_MAX,
  TEAM_FILE_MODE,
  TEAM_HISTORY_KEEP,
  TEAM_ID,
  TEAM_LOG_MAX,
  TEAM_NUMBER_SETTINGS,
  TEAM_PROVIDERS,
  TEAM_STATUSES,
  TEAM_SUBSCRIBE_REPLAY_MAX,
  teamFilesOf,
  teamsDirOf,
} from './contract';
import type {
  BoardTask,
  CreateTeamStores,
  FeedItem,
  LogAppend,
  LogEvent,
  MemberState,
  MsgPostedEvent,
  ProcessIdentity,
  StoreFailure,
  StoreFailureCode,
  StoreResult,
  TeamCreateInit,
  TeamDirListing,
  TeamHeader,
  TeamLease,
  TeamRuntime,
  TeamState,
  TeamStateOverlay,
  TeamStore,
  TeamStores,
  TeamWarningKind,
} from './contract';

/**
 * team/store — THE STORE of Teammate mode (contract-team-mode-v2.md §2, H4, task T3): one team's
 * directory as an append-only, fdatasync'd event log with exactly one writer, the projection that
 * is the ONLY reducer of that log (T0 amendment A14), the lead seat with H4's takeover, the
 * readers every host and front end may use without the seat, and retention. The interface is
 * frozen in team/contract.ts (TeamStores, TeamStore); its doc comments are the specification and
 * are not repeated here — what is written here is WHY the code is shaped the way it is, and what it
 * still cannot promise.
 *
 * WHY ONE WRITER IS ENFORCED THREE TIMES. (1) Inside a host process: TeamStores.open is memoised,
 * so every caller of one team holds the same TeamStore, and that store serialises its appends
 * through one queue whose flush is synchronous from the fence to the fdatasync — no two batches of
 * one store can interleave. (2) Between hosts: `lease.json` is only ever created by `link()` of a
 * complete, fsync'd temp file, which is atomic and exclusive; whoever links it owns the team, and
 * a taker must first hold `lease.lock` (also link-created) and then RENAME the stale lease away, so
 * two takers can never both succeed at step 4. (3) Against a host that was judged stale while it
 * was in fact alive (a `ps` that lied, a clock step): every batch first re-checks that
 * `lease.json` still names this host (the fence), so a writer that lost its seat stops at its NEXT
 * batch and never writes again (I2). The residual, stated rather than implied: the fence is a check
 * before a write, not a lock around it — a takeover that lands between one batch's fence and its
 * write() lets that one batch through. Takeover only happens when the holder looks dead, so this
 * needs a live host misjudged as dead AND a batch in flight at that instant; the next reader then
 * finds the duplicate seq and calls the team `damaged` (I10), which is loud, never silent.
 *
 * WHY THE FLUSH IS SYNCHRONOUS. The batch window is "the current turn of the event loop": calls made
 * before the scheduled flush runs (setImmediate — far inside LOG_BATCH_WINDOW_MS) are written by
 * ONE write() and ONE fdatasync, and the flush itself never yields between the fence, the body
 * files, the write and the projection, so nothing can observe a half-applied batch. The fdatasync
 * blocks the host's loop for the disk's sync latency; that is the price of I2 ("nothing is
 * acknowledged on the strength of an event that is not yet durable") and it is paid once per batch,
 * not once per event.
 *
 * WHY THE READERS NEVER REPAIR. A reader is any process — another host, a front end's sidecar — and
 * the owner may be mid-write; a final line without `\n` is either a crash's torn tail or bytes still
 * landing. Only the owner, at acquire, holds the seat that makes cutting the file safe.
 *
 * Runtime imports: Node built-ins, registry.ts (processStartedAt, isPidAlive — the same liveness
 * reading the task log's own locks use), safeFs.ts, displayText.ts, mcp/host-protocol.ts and
 * team/contract.ts. Must not import 'vscode'.
 */

/* ------------------------------------------------------------------------- *
 * Small fs plumbing — every function here is total (errno as a value, never a throw)
 * ------------------------------------------------------------------------- */

/** `lease.json` and `lease.lock` are a few hundred bytes; anything past this is not one. */
const LEASE_MAX_BYTES = 4 * 1024;
/** `team.json` is a few hundred bytes; the cap only bounds a hostile one. */
const HEADER_MAX_BYTES = 64 * 1024;
/** Event-carried warnings kept in the projection (overlap, store, stash, context-lost) — the newest. */
const EVENT_WARNINGS_KEPT = 10;
/** A reduction logs at most this many skipped events, so one bad log cannot flood the host log. */
const SKIP_LOG_MAX = 3;

/** Open flags guarded like safeFs: a constant the platform lacks folds to 0, never to NaN. */
const flag = (n: number | undefined): number => (typeof n === 'number' ? n : 0);
const O_NOFOLLOW = flag(fs.constants.O_NOFOLLOW);
const O_NONBLOCK = flag(fs.constants.O_NONBLOCK);
const O_READ = fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const O_APPEND_WRITE = fs.constants.O_WRONLY | fs.constants.O_APPEND | O_NOFOLLOW | O_NONBLOCK;
const O_CREATE_NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

const ERRNO = /^[A-Z][A-Z0-9_]{1,31}$/;
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && ERRNO.test(code) ? code : 'EIO';
}
function fail(code: StoreFailureCode, reason: string, extra?: Partial<StoreFailure>): StoreFailure {
  return { ok: false, code, reason, ...extra };
}
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function ioFail(what: string, errno: string): StoreFailure {
  return fail('io', `${what} failed (${errno})`, { errno });
}
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const randomHex = (): string => randomBytes(6).toString('hex');

function closeQuietly(fd: number | undefined): void {
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // nothing to do: the descriptor is gone either way
    }
  }
}
function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort by contract (a failed batch's body files, a temp file)
  }
}
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    off += fs.writeSync(fd, buf, off, buf.length - off);
  }
}
/** fsync a directory so a rename or a link in it is durable. Best effort: some filesystems refuse it. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // a directory fsync is not available everywhere; the file's own fsync already happened
  } finally {
    closeQuietly(fd);
  }
}

/**
 * The own-directory rule (§2.2): `dir` exists as a REAL directory of this uid, created 0700 when it
 * was absent. A symbolic link → ELOOP, another user's directory → EPERM, a file → ENOTDIR. Its
 * parent must already have passed. Answers undefined or the errno.
 */
function ensureOwnDir(dir: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        return 'ELOOP';
      }
      if (!st.isDirectory()) {
        return 'ENOTDIR';
      }
      if (uid !== undefined && st.uid !== uid) {
        return 'EPERM';
      }
      return undefined;
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') {
        return errnoOf(err);
      }
    }
    try {
      fs.mkdirSync(dir, { mode: TEAM_DIR_MODE });
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        return errnoOf(err);
      }
    }
  }
  return 'EIO';
}

/** Write `data` to `file` atomically: a 0600 temp file in the same directory, fsync, rename. Answers undefined or the errno. */
function writeAtomic(file: string, data: string | Buffer): string | undefined {
  const tmp = `${file}.${process.pid}.${randomHex()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, O_CREATE_NEW, TEAM_FILE_MODE);
    writeAll(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    return undefined;
  } catch (err) {
    closeQuietly(fd);
    unlinkQuietly(tmp);
    return errnoOf(err);
  }
}

/**
 * Create `file` EXCLUSIVELY and COMPLETE: the content goes to a fsync'd temp file that is then
 * `link()`ed into place — atomic, and EEXIST when the name is taken — so a reader never sees a
 * half-written lease or lock. Answers the new file's inode, or the errno.
 */
function linkExclusive(file: string, text: string): { ok: true; ino: bigint } | { ok: false; errno: string } {
  const tmp = `${file}.${process.pid}.${randomHex()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, O_CREATE_NEW, TEAM_FILE_MODE);
    writeAll(fd, Buffer.from(text, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmp, file);
    const ino = fs.lstatSync(tmp, { bigint: true }).ino;
    unlinkQuietly(tmp);
    fsyncDir(path.dirname(file));
    return { ok: true, ino };
  } catch (err) {
    closeQuietly(fd);
    unlinkQuietly(tmp);
    return { ok: false, errno: errnoOf(err) };
  }
}

/** The bytes of a regular file (never a link, FIFO or device), at most `max`. */
function readBytes(
  file: string,
  max: number,
): { ok: true; buf: Buffer } | { ok: false; reason: 'absent' | 'unreadable' | 'too-large'; errno: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, O_READ);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, reason: 'unreadable', errno: 'EINVAL' };
    }
    if (st.size > max) {
      return { ok: false, reason: 'too-large', errno: 'EFBIG' };
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) {
        break;
      }
      off += n;
    }
    return { ok: true, buf: off === buf.length ? buf : buf.subarray(0, off) };
  } catch (err) {
    const errno = errnoOf(err);
    return { ok: false, reason: errno === 'ENOENT' ? 'absent' : 'unreadable', errno };
  } finally {
    closeQuietly(fd);
  }
}

/** The last `max` bytes of a regular file (whole when smaller); `cut` when the start was dropped. */
function readTailBytes(file: string, max: number): { buf: Buffer; cut: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, O_READ);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return undefined;
    }
    const len = Math.min(st.size, max);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, start + off);
      if (n === 0) {
        break;
      }
      off += n;
    }
    return { buf: buf.subarray(0, off), cut: start > 0 };
  } catch {
    return undefined;
  } finally {
    closeQuietly(fd);
  }
}

/** A UTF-8 text file read through safeFs (no link at the name, strict UTF-8), as a store result. */
function readText(file: string, max: number, what: string): StoreResult<string> {
  const r = readTextSafe(file, max, { noFollow: true, strictUtf8: true });
  if (r.ok) {
    return ok(r.text);
  }
  return r.reason === 'absent' ? fail('absent', `${what} does not exist`) : fail('unreadable', `${what}: ${r.detail}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Shapes read from disk
 * ------------------------------------------------------------------------- */

function asHeader(v: unknown, teamId: string): TeamHeader | undefined {
  if (
    !isObj(v) ||
    v.v !== 1 ||
    v.id !== teamId ||
    !isStr(v.name) ||
    !isStr(v.title) ||
    !isStr(v.workspace) ||
    !isStr(v.repoRoot) ||
    !isStr(v.commonDir) ||
    !isNum(v.createdAt)
  ) {
    return undefined;
  }
  return v as unknown as TeamHeader;
}

function asIdentity(v: unknown): ProcessIdentity | undefined {
  return isObj(v) && isPosInt(v.pid) && isNum(v.startedAt) ? { pid: v.pid, startedAt: v.startedAt } : undefined;
}

function asLease(text: string): TeamLease | undefined {
  const v = parseJson(text);
  if (!isObj(v) || v.v !== 1 || !isPosInt(v.hostPid) || !isNum(v.hostStartedAt) || !isStr(v.socket) || !isNum(v.acquiredAt)) {
    return undefined;
  }
  const session = asIdentity(v.session);
  if (session === undefined) {
    return undefined;
  }
  return { v: 1, hostPid: v.hostPid, hostStartedAt: v.hostStartedAt, session, socket: v.socket, acquiredAt: v.acquiredAt };
}

/**
 * Is the process a lease or lock names still there? Alive (kill 0, EPERM counts) AND its start time
 * within START_SLACK_MS of the recorded one — a pid that was reused names a younger process. A start
 * time that cannot be read is NOT stale (MD-7: `ps` unknown ⇒ not stale): taking a live host's seat
 * is the one mistake this file must never make on a guess.
 */
function holderIsLive(pid: number, startedAt: number): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }
  const seen = processStartedAt(pid);
  if (seen === undefined) {
    return true;
  }
  return Math.abs(seen - startedAt) <= START_SLACK_MS;
}

/** How much of a log's end list() reads to find its last event's seq (an event line is far shorter in practice). */
const LAST_SEQ_TAIL_BYTES = 64 * 1024;

/**
 * The seq of the last event in a log file, from its last LAST_SEQ_TAIL_BYTES: the final segment
 * when it parses (a complete line, or an unterminated one parseLog would keep), else the complete
 * line before it (a torn tail). Undefined when it cannot be told — the caller then validates fully.
 */
function lastSeqOf(file: string): number | undefined {
  const tail = readTailBytes(file, LAST_SEQ_TAIL_BYTES);
  if (tail === undefined) {
    return undefined;
  }
  const segments = tail.buf.toString('utf8').split('\n');
  // A cut buffer's first segment is a partial line; an empty last segment is the final `\n`.
  const usable = segments.slice(tail.cut ? 1 : 0).filter((t) => t !== '');
  for (const text of usable.slice(-2).reverse()) {
    const v = parseJson(text);
    if (isObj(v) && isPosInt(v.seq)) {
      return v.seq;
    }
  }
  return undefined;
}

/** The creation time a TEAM_ID encodes (`tm` + base36 ms + 4 random). */
function createdAtOfId(teamId: string): number {
  const n = parseInt(teamId.slice(2, -4), 36);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A relative path inside a team directory (writeFile, readFile, init.files): `/`-separated, no
 * empty, `.` or `..` segment, no backslash or control character — and never one of the files the
 * store itself owns (the log, the projection, the header, the seat), which no caller may replace.
 */
function relProblem(rel: unknown): string | undefined {
  if (!isStr(rel) || rel.length === 0 || rel.length > 1024) {
    return 'not a relative path';
  }
  if (/[\\\u0000-\u001f\u007f]/.test(rel) || rel.startsWith('/')) {
    return 'not a relative path';
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'a path segment is empty, . or ..';
  }
  const top = segments[0];
  if (
    segments.length === 1 &&
    (top === 'team.json' || top === 'events.jsonl' || top === 'state.json' || top.startsWith('lease.'))
  ) {
    return 'the store owns that file';
  }
  return undefined;
}

/** No directory component between `base` and `file` is a symbolic link (reads follow none). */
function parentsAreReal(base: string, rel: string): boolean {
  const segments = rel.split('/');
  let dir = base;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = path.join(dir, segments[i]);
    try {
      if (!fs.lstatSync(dir).isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Cut a string to at most `max` UTF-8 bytes on a code point boundary. */
function cutUtf8(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) {
    return text;
  }
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > max) {
      break;
    }
    out += ch;
    bytes += b;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * The log's rules (§2.3, H4)
 * ------------------------------------------------------------------------- */

interface ParsedLog {
  events: LogEvent[];
  /** Bytes of the torn tail (excluded); 0 when none. */
  tornBytes: number;
  /** Where the last complete line ends (the cut point for a torn tail). */
  cleanBytes: number;
  /** The final line had no `\n` but parsed as the next valid event (kept; the owner adds its `\n`). */
  unterminatedTail: boolean;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The envelope rule of one line: the parsed event, or why it is not the event `seq` must be. */
function checkLine(buf: Buffer, expectedSeq: number): { event: LogEvent } | { problem: string } {
  if (buf.length + 1 > LOG_LINE_MAX) {
    return { problem: 'is over LOG_LINE_MAX' };
  }
  let text: string;
  try {
    text = strictUtf8.decode(buf);
  } catch {
    return { problem: 'is not UTF-8' };
  }
  const v = parseJson(text);
  if (!isObj(v) || v.v !== 1 || !isInt(v.seq) || !isNum(v.ts) || !isStr(v.type) || !isStr(v.by)) {
    return { problem: 'is not a log event' };
  }
  if (v.seq !== expectedSeq) {
    return {
      problem:
        (v.seq as number) < expectedSeq ? `repeats seq ${v.seq} (duplicate)` : `has seq ${v.seq} after ${expectedSeq - 1} (gap)`,
    };
  }
  if (expectedSeq === 1 && v.type !== 'team.created') {
    return { problem: 'is seq 1 but not team.created' };
  }
  return { event: v as unknown as LogEvent };
}

/** Validate a whole log file's bytes (§2.3): the events, or the damage with its line number. */
function parseLog(buf: Buffer): { ok: true; log: ParsedLog } | { ok: false; reason: string } {
  if (buf.length === 0) {
    return { ok: false, reason: 'events.jsonl is empty' };
  }
  const events: LogEvent[] = [];
  let start = 0;
  let line = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    line++;
    if (nl === -1) {
      // The final line has no `\n`: the next valid event (kept) or the torn tail (excluded).
      const tail = buf.subarray(start);
      const checked = checkLine(tail, events.length + 1);
      if ('event' in checked) {
        events.push(checked.event);
        return { ok: true, log: { events, tornBytes: 0, cleanBytes: start, unterminatedTail: true } };
      }
      if (events.length === 0) {
        return { ok: false, reason: 'events.jsonl holds no complete event' };
      }
      return { ok: true, log: { events, tornBytes: tail.length, cleanBytes: start, unterminatedTail: false } };
    }
    const checked = checkLine(buf.subarray(start, nl), events.length + 1);
    if ('problem' in checked) {
      return { ok: false, reason: `events.jsonl line ${line} ${checked.problem}` };
    }
    events.push(checked.event);
    start = nl + 1;
  }
  return { ok: true, log: { events, tornBytes: 0, cleanBytes: buf.length, unterminatedTail: false } };
}

/** One event as the log holds it: the envelope first, then the body (whose own envelope keys never win). */
function eventOf(seq: number, ts: number, by: string, body: Record<string, unknown>): LogEvent {
  const { v, seq: s, ts: t, by: b, type, ...rest } = body;
  void v;
  void s;
  void t;
  void b;
  return { v: 1, seq, ts, type, by, ...rest } as unknown as LogEvent;
}

/* ------------------------------------------------------------------------- *
 * The projection — THE reducer of team events (A14)
 * ------------------------------------------------------------------------- */

type Warning = { kind: TeamWarningKind; text: string };
interface MessageFacts {
  to: string;
  recipients: string[];
  task?: string;
}

const actorOf = (by: unknown): string => (isStr(by) && by.startsWith('member:') ? by.slice('member:'.length) : isStr(by) ? by : 'engine');
const HELD_STATES = new Set(['claimed', 'blocked', 'review']);
const boardNumber = (id: string): number => Number(id.slice(1));

/**
 * The reducer. Fed the log in seq order (apply) and asked for a fresh TeamState at any time
 * (snapshot — a new object every call, so an overlay or a caller may mutate it freely). What the
 * log does not hold is left at the neutral values TeamStateOverlay lists. Never throws: an event
 * whose fields are not what its type needs is skipped (and the first few are logged).
 *
 * Readings this file takes where §2.4 names a field but not its rule (CONTRACT-QUESTION, each
 * consistent with the rest of the contract):
 *  - `user.unread` counts `msg.posted` addressed to `user` after `user.readSeq`, as `lead.unread`
 *    counts those to `lead` — the user "sees everything", but only messages TO the user are unread.
 *  - `pending` per member = `msg.posted` to it (directly or as one of a `to: all` message's
 *    `recipients`) without a `msg.delivered` naming it — the definition of §4.3.
 *  - a member's provider/worker/model before its first `member.routed` are its `member.added`
 *    spec's (provider `claude` when the spec names none), incarnation 0, accountLabel = worker.
 *  - `turn` is set by `turn.planned`, filled by `turn.running`/`member.process`, cleared by
 *    `turn.ended` and by a `member.state` other than running/pausing.
 *  - `budgets.running` = turns planned and not yet ended.
 *  - a checkpoint's sha is attributed to every board task the member holds (claimed, blocked,
 *    review) at that point; a board task's `turns` gain the turn of every `msg.delivered` of a
 *    message carrying that `task` (≤ BOARD_TURNS_MAX, the newest kept).
 *  - `pingPongTripped` is set by `budget.tripped kind=pingpong` and reset by any `msg.posted`
 *    from `lead` or `user` (§3.5.1).
 *  - board moves to `open` or `cancelled` drop the assignee (§5.1: set ⇔ claimed/blocked/review;
 *    kept on done).
 *  - warnings: derived from the current state (each blocked member, each turns-only member, the
 *    ping-pong breaker, each member idle over a budget), plus the newest EVENT_WARNINGS_KEPT that
 *    events carry (overlap.detected, store.warning, stash.changed, a member.conversation with
 *    `replaced`).
 */
class Projection {
  private name: string;
  private title: string;
  private workspace: string;
  private repoRoot: string;
  private leadRel = '';
  private baseCommit = '';
  private createdAt: number;
  private goal: string | undefined;
  private status: TeamState['status'] = 'active';
  private endedAt: number | undefined;
  private seq = 0;
  private owner: TeamState['owner'] = null;
  private leadReadSeq = 0;
  private userReadSeq = 0;
  private readonly toLead: number[] = [];
  private readonly toUser: number[] = [];
  private readonly members = new Map<string, MemberState>();
  private readonly board = new Map<string, BoardTask>();
  private readonly messages = new Map<number, MessageFacts>();
  private readonly delivered = new Set<string>();
  private readonly pending = new Map<string, number>();
  private readonly openTurns = new Map<string, string>();
  private pingPongTripped = false;
  private readonly totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null as number | null };
  private readonly eventWarnings: Warning[] = [];
  private skipped = 0;

  constructor(
    private readonly teamId: string,
    header: TeamHeader | undefined,
    private readonly readGoal: (rel: string) => string | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.name = header?.name ?? teamId;
    this.title = header?.title ?? '';
    this.workspace = header?.workspace ?? '';
    this.repoRoot = header?.repoRoot ?? '';
    this.createdAt = header?.createdAt ?? createdAtOfId(teamId);
  }

  get lastSeq(): number {
    return this.seq;
  }

  apply(e: LogEvent): void {
    const ev = e as unknown as Record<string, unknown>;
    if (isInt(ev.seq)) {
      this.seq = ev.seq;
    }
    let applied: boolean;
    try {
      applied = this.reduce(ev);
    } catch {
      applied = false;
    }
    if (!applied) {
      this.skipped++;
      if (this.skipped <= SKIP_LOG_MAX) {
        this.log(`team ${this.teamId}: event seq ${String(ev.seq)} (${String(ev.type)}) skipped: its fields are not what its type needs`);
      }
    }
  }

  private member(name: unknown): MemberState | undefined {
    return isStr(name) ? this.members.get(name) : undefined;
  }

  private warn(kind: TeamWarningKind, text: string): void {
    this.eventWarnings.push({ kind, text });
    if (this.eventWarnings.length > EVENT_WARNINGS_KEPT) {
      this.eventWarnings.splice(0, this.eventWarnings.length - EVENT_WARNINGS_KEPT);
    }
  }

  /** One event; false when its fields do not fit its type (an unknown type is true: ignored by design). */
  private reduce(ev: Record<string, unknown>): boolean {
    const ts = isNum(ev.ts) ? ev.ts : 0;
    switch (ev.type) {
      case 'team.created': {
        if (!isStr(ev.name) || !isStr(ev.title) || !isObj(ev.goal)) {
          return false;
        }
        this.name = ev.name;
        this.title = ev.title;
        if (isStr(ev.workspace)) this.workspace = ev.workspace;
        if (isStr(ev.repoRoot)) this.repoRoot = ev.repoRoot;
        if (isStr(ev.leadRel)) this.leadRel = ev.leadRel;
        if (isStr(ev.baseCommit)) this.baseCommit = ev.baseCommit;
        const goal = ev.goal;
        this.goal = isStr(goal.text) ? goal.text : isStr(goal.file) ? this.readGoal(goal.file) : undefined;
        return true;
      }
      case 'team.status': {
        if (!isStr(ev.status) || !(TEAM_STATUSES as readonly string[]).includes(ev.status)) {
          return false;
        }
        this.status = ev.status as TeamState['status'];
        if (ev.status === 'ended') {
          this.endedAt = ts;
        }
        return true;
      }
      case 'lease.acquired': {
        const session = asIdentity(ev.session);
        if (!isPosInt(ev.hostPid) || !isNum(ev.hostStartedAt) || session === undefined) {
          return false;
        }
        this.owner = { hostPid: ev.hostPid, hostStartedAt: ev.hostStartedAt, session };
        return true;
      }
      case 'lease.released':
        this.owner = null;
        return true;
      case 'member.added': {
        if (!isStr(ev.name) || !MEMBER_NAME.test(ev.name) || !isPosInt(ev.index) || !isStr(ev.role) || this.members.has(ev.name)) {
          return false;
        }
        const spec = isObj(ev.spec) ? ev.spec : {};
        const provider = isStr(spec.provider) && (TEAM_PROVIDERS as readonly string[]).includes(spec.provider) ? spec.provider : 'claude';
        const worker = isStr(spec.worker) ? spec.worker : '';
        this.members.set(ev.name, {
          name: ev.name,
          index: ev.index,
          role: ev.role,
          state: 'starting',
          provider: provider as MemberState['provider'],
          worker,
          accountLabel: worker,
          machineLogin: false,
          sharesLeadPlan: false,
          billableOverage: false,
          runsCommands: false,
          model: isStr(spec.model) ? spec.model : '',
          incarnation: 0,
          mailbox: 'unverified',
          portBase: memberPortBase(ev.index),
          worktree: { path: '', branch: '', baseCommit: '', ready: false },
          turns: 0,
          tokens: { in: 0, out: 0 },
          costUsd: null,
          pending: 0,
          tasks: [],
          peerWakes: 0,
        });
        return true;
      }
      case 'member.routed': {
        const m = this.member(ev.name);
        if (
          m === undefined ||
          !isPosInt(ev.incarnation) ||
          !isStr(ev.provider) ||
          !(TEAM_PROVIDERS as readonly string[]).includes(ev.provider) ||
          !isStr(ev.worker) ||
          !isStr(ev.model)
        ) {
          return false;
        }
        const provider = ev.provider as MemberState['provider'];
        if (ev.incarnation !== m.incarnation) {
          delete m.conversationShort;
        }
        m.provider = provider;
        m.worker = ev.worker;
        m.model = ev.model;
        m.incarnation = ev.incarnation;
        const single = provider === 'cursor' || provider === 'gemini' ? provider : undefined;
        m.machineLogin = single !== undefined && ev.accountKey === MACHINE_LOGIN_KEYS[single];
        m.accountLabel = m.machineLogin && single !== undefined ? MACHINE_LOGIN_LABELS[single] : ev.worker;
        return true;
      }
      case 'member.worktree.planned':
      case 'member.worktree': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.path) || !isStr(ev.branch) || !isStr(ev.baseCommit)) {
          return false;
        }
        m.worktree = { ...m.worktree, path: ev.path, branch: ev.branch, baseCommit: ev.baseCommit, ready: ev.type === 'member.worktree' };
        return true;
      }
      case 'member.conversation': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.conversationId)) {
          return false;
        }
        m.conversationShort = ev.conversationId.slice(0, 8);
        if (isStr(ev.replaced)) {
          this.warn('context-lost', `${m.name}'s CLI did not find its conversation and started a new one`);
        }
        return true;
      }
      case 'member.state': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.state) || !(MEMBER_STATES as readonly string[]).includes(ev.state)) {
          return false;
        }
        m.state = ev.state as MemberState['state'];
        const r = ev.reason;
        if (isObj(r) && isStr(r.code) && isStr(r.text)) {
          m.reason = { code: r.code as NonNullable<MemberState['reason']>['code'], text: r.text, ...(isNum(r.until) ? { until: r.until } : {}) };
        } else {
          delete m.reason;
        }
        if (m.state !== 'running' && m.state !== 'pausing') {
          delete m.turn;
        }
        return true;
      }
      case 'member.mailbox': {
        const m = this.member(ev.name);
        if (m === undefined || (ev.mailbox !== 'tools' && ev.mailbox !== 'turns-only')) {
          return false;
        }
        m.mailbox = ev.mailbox;
        if (ev.mailbox === 'turns-only' && isStr(ev.reason)) {
          m.mailboxReason = ev.reason;
        } else {
          delete m.mailboxReason;
        }
        return true;
      }
      case 'member.process': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.turnId) || !isPosInt(ev.pid)) {
          return false;
        }
        if (m.turn !== undefined && m.turn.id === ev.turnId) {
          m.turn.pid = ev.pid;
        }
        return true;
      }
      case 'turn.planned': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.turnId) || !isPosInt(ev.n)) {
          return false;
        }
        m.turn = { id: ev.turnId, n: ev.n, startedAt: ts };
        this.openTurns.set(ev.turnId, m.name);
        return true;
      }
      case 'turn.running': {
        if (!isStr(ev.turnId)) {
          return false;
        }
        const m = this.member(this.openTurns.get(ev.turnId));
        if (m?.turn !== undefined && m.turn.id === ev.turnId) {
          if (isPosInt(ev.pid)) m.turn.pid = ev.pid;
          if (isNum(ev.startedAt)) m.turn.startedAt = ev.startedAt;
        }
        return true;
      }
      case 'turn.ended': {
        if (!isStr(ev.turnId) || !isStr(ev.outcome)) {
          return false;
        }
        const name = this.openTurns.get(ev.turnId);
        this.openTurns.delete(ev.turnId);
        const m = this.member(name);
        const tokens = isObj(ev.tokens) ? ev.tokens : {};
        const tin = isNum(tokens.in) ? tokens.in : 0;
        const tout = isNum(tokens.out) ? tokens.out : 0;
        const cost = isNum(ev.costUsd) ? ev.costUsd : undefined;
        this.totals.turns++;
        this.totals.inputTokens += tin;
        this.totals.outputTokens += tout;
        if (cost !== undefined) {
          this.totals.costUsd = (this.totals.costUsd ?? 0) + cost;
        }
        if (m !== undefined) {
          const n = m.turn?.id === ev.turnId ? m.turn.n : m.turns + 1;
          m.turns++;
          m.tokens = { in: m.tokens.in + tin, out: m.tokens.out + tout };
          if (cost !== undefined) {
            m.costUsd = (m.costUsd ?? 0) + cost;
          }
          m.lastInputTokens = tin;
          if (isStr(ev.modelUsed)) {
            m.modelUsed = ev.modelUsed;
          }
          m.lastTurn = {
            id: ev.turnId,
            n,
            outcome: ev.outcome,
            endedAt: ts,
            head: sliceOneLine(flattenOneLine(isStr(ev.text) ? ev.text : ''), HEAD_MAX_CHARS),
          };
          if (m.turn?.id === ev.turnId) {
            delete m.turn;
          }
        }
        return true;
      }
      case 'turn.checkpoint': {
        const m = this.member(ev.name);
        if (m === undefined) {
          return false;
        }
        if (isStr(ev.sha)) {
          m.worktree.headSha = ev.sha;
          if (isInt(ev.filesChanged)) {
            m.worktree.filesChanged = ev.filesChanged;
          }
          for (const task of this.board.values()) {
            if (task.assignee === m.name && HELD_STATES.has(task.state) && !task.commits.includes(ev.sha)) {
              task.commits.push(ev.sha);
            }
          }
        }
        return true;
      }
      case 'msg.posted': {
        if (!isStr(ev.from) || !isStr(ev.to) || !isInt(ev.seq)) {
          return false;
        }
        const recipients = this.recipientsOf(ev.to, ev.recipients);
        this.messages.set(ev.seq, { to: ev.to, recipients, ...(isStr(ev.task) ? { task: ev.task } : {}) });
        for (const r of recipients) {
          this.pending.set(r, (this.pending.get(r) ?? 0) + 1);
        }
        if (ev.to === 'lead') this.toLead.push(ev.seq);
        if (ev.to === 'user') this.toUser.push(ev.seq);
        if (ev.from === 'lead' || ev.from === 'user') {
          this.pingPongTripped = false;
        }
        return true;
      }
      case 'msg.delivered': {
        const seq = seqOfMessageId(ev.msg);
        if (seq === undefined || !isStr(ev.to)) {
          return false;
        }
        const msg = this.messages.get(seq);
        const key = `${seq}:${ev.to}`;
        if (msg !== undefined && msg.recipients.includes(ev.to) && !this.delivered.has(key)) {
          this.delivered.add(key);
          this.pending.set(ev.to, Math.max(0, (this.pending.get(ev.to) ?? 0) - 1));
          const task = msg.task !== undefined ? this.board.get(msg.task) : undefined;
          if (task !== undefined && isStr(ev.turnId) && !task.turns.includes(ev.turnId)) {
            task.turns.push(ev.turnId);
            if (task.turns.length > BOARD_TURNS_MAX) {
              task.turns.splice(0, task.turns.length - BOARD_TURNS_MAX);
            }
          }
        }
        return true;
      }
      case 'msg.read': {
        if (!isInt(ev.upToSeq)) {
          return false;
        }
        if (ev.by === 'lead') this.leadReadSeq = Math.max(this.leadReadSeq, ev.upToSeq);
        else if (ev.by === 'user') this.userReadSeq = Math.max(this.userReadSeq, ev.upToSeq);
        else return false;
        return true;
      }
      case 'board.created': {
        const t = ev.task;
        if (!isObj(t) || !isStr(t.id) || !BOARD_ID.test(t.id) || !isStr(t.title) || !isStr(t.state) || !(TASK_STATES as readonly string[]).includes(t.state)) {
          return false;
        }
        const task = structuredClone(t) as unknown as BoardTask;
        task.paths = Array.isArray(task.paths) ? task.paths.filter(isStr) : [];
        task.reports = Array.isArray(task.reports) ? task.reports : [];
        task.commits = Array.isArray(task.commits) ? task.commits.filter(isStr) : [];
        task.turns = Array.isArray(task.turns) ? task.turns.filter(isStr) : [];
        task.allowOverlap = task.allowOverlap === true;
        if (!isNum(task.createdAt)) task.createdAt = ts;
        if (!isNum(task.updatedAt)) task.updatedAt = ts;
        if (!isStr(task.updatedBy)) task.updatedBy = actorOf(ev.by);
        this.board.set(task.id, task);
        return true;
      }
      case 'board.updated': {
        const task = isStr(ev.id) ? this.board.get(ev.id) : undefined;
        if (task === undefined || !isObj(ev.changes)) {
          return false;
        }
        const c = ev.changes;
        if (isStr(c.state) && (TASK_STATES as readonly string[]).includes(c.state)) {
          task.state = c.state as BoardTask['state'];
          if (task.state === 'open' || task.state === 'cancelled') {
            delete task.assignee;
          }
        }
        if (c.assignee === null) delete task.assignee;
        else if (isStr(c.assignee)) task.assignee = c.assignee;
        if (isStr(c.title)) task.title = c.title;
        if (isStr(c.body)) {
          task.body = c.body;
          delete task.bodyFile;
        }
        if (isStr(c.bodyFile)) {
          task.bodyFile = c.bodyFile;
          delete task.body;
        }
        if (Array.isArray(c.paths)) task.paths = c.paths.filter(isStr);
        if (typeof c.allowOverlap === 'boolean') task.allowOverlap = c.allowOverlap;
        if (isStr(ev.note)) task.note = ev.note;
        if (isStr(ev.reportFile)) task.reports.push({ at: ts, by: actorOf(ev.by), file: ev.reportFile });
        task.updatedAt = ts;
        task.updatedBy = actorOf(ev.by);
        return true;
      }
      case 'overlap.detected': {
        if (!Array.isArray(ev.members) || !Array.isArray(ev.paths)) {
          return false;
        }
        this.warn('overlap', `${ev.members.filter(isStr).join(', ')} changed the same files: ${ev.paths.filter(isStr).slice(0, 5).join(', ')}`);
        return true;
      }
      case 'stash.changed': {
        if (!isStr(ev.name)) {
          return false;
        }
        this.warn('stash', `the repository's stash changed during ${ev.name}'s turn`);
        return true;
      }
      case 'attach.granted': {
        const m = this.member(ev.name);
        if (m === undefined || !isStr(ev.lease)) {
          return false;
        }
        m.attach = { lease: ev.lease, client: '', since: ts };
        return true;
      }
      case 'attach.started':
      case 'attach.ended': {
        if (!isStr(ev.lease)) {
          return false;
        }
        for (const m of this.members.values()) {
          if (m.attach?.lease === ev.lease) {
            if (ev.type === 'attach.ended') delete m.attach;
            else if (isPosInt(ev.pid)) m.attach.pid = ev.pid;
          }
        }
        return true;
      }
      case 'budget.tripped': {
        if (!isStr(ev.kind)) {
          return false;
        }
        if (ev.kind === 'pingpong') {
          this.pingPongTripped = true;
        }
        return true;
      }
      case 'store.warning': {
        if (!isStr(ev.text)) {
          return false;
        }
        this.warn('store', sliceOneLine(flattenOneLine(ev.text), HEAD_MAX_CHARS));
        return true;
      }
      default:
        // turn.accepted, log.repaired, and every type this build does not know: nothing to project.
        return true;
    }
  }

  /** A message's member recipients: `to` itself when it names a member, a `to: all` message's recorded expansion (or, absent, every member that is not stopped/ended now). */
  private recipientsOf(to: string, recorded: unknown): string[] {
    if (to === 'all') {
      if (Array.isArray(recorded)) {
        return recorded.filter((r): r is string => isStr(r) && this.members.has(r));
      }
      return [...this.members.values()].filter((m) => m.state !== 'stopped' && m.state !== 'ended').map((m) => m.name);
    }
    return this.members.has(to) ? [to] : [];
  }

  snapshot(): TeamState {
    const board = [...this.board.values()].sort((a, b) => boardNumber(a.id) - boardNumber(b.id));
    const members = [...this.members.values()]
      .sort((a, b) => a.index - b.index)
      .map((m) => {
        const copy = structuredClone(m);
        copy.pending = this.pending.get(m.name) ?? 0;
        copy.tasks = board.filter((t) => t.assignee === m.name && HELD_STATES.has(t.state)).map((t) => t.id);
        return copy;
      });
    const warnings: Warning[] = [];
    for (const m of members) {
      if (m.state === 'blocked') {
        warnings.push({ kind: 'blocked', text: `${m.name} is blocked${m.reason ? `: ${m.reason.text}` : ''}` });
      }
      if (m.mailbox === 'turns-only') {
        warnings.push({ kind: 'mailbox', text: `${m.name} is turns-only${m.mailboxReason ? ` (${m.mailboxReason})` : ''}` });
      }
      if (m.state === 'idle' && m.reason?.code === 'budget') {
        warnings.push({ kind: 'budget', text: `${m.name}: ${m.reason.text}` });
      }
    }
    if (this.pingPongTripped) {
      warnings.push({ kind: 'budget', text: 'teammate wakes are paused for the team (ping-pong breaker)' });
    }
    warnings.push(...this.eventWarnings.map((w) => ({ ...w })));
    const unreadAfter = (seqs: number[], readSeq: number): number => {
      let n = 0;
      for (let i = seqs.length - 1; i >= 0 && seqs[i] > readSeq; i--) n++;
      return n;
    };
    const state: TeamState = {
      v: 1,
      id: this.teamId,
      name: this.name,
      title: this.title,
      status: this.status,
      workspace: this.workspace,
      repoRoot: this.repoRoot,
      leadRel: this.leadRel,
      baseCommit: this.baseCommit,
      createdAt: this.createdAt,
      seq: this.seq,
      owner: this.owner === null ? null : structuredClone(this.owner),
      lead: { unread: unreadAfter(this.toLead, this.leadReadSeq), readSeq: this.leadReadSeq, waiter: false, lastCallAt: null, wakesToday: 0 },
      user: { unread: unreadAfter(this.toUser, this.userReadSeq), readSeq: this.userReadSeq },
      members,
      board: structuredClone(board),
      budgets: {
        turnsToday: 0,
        turnsPerDay: TEAM_NUMBER_SETTINGS.teamTurnsPerDay.default,
        running: this.openTurns.size,
        maxRunning: TEAM_NUMBER_SETTINGS.teamMaxRunningTurns.default,
        pingPongTripped: this.pingPongTripped,
      },
      totals: { ...this.totals },
      warnings,
    };
    if (this.goal !== undefined) state.goal = this.goal;
    if (this.endedAt !== undefined) state.endedAt = this.endedAt;
    return state;
  }
}

/** The state of a team whose log cannot be read (I10): listed and shown as `damaged`, never as "no team". */
function damagedState(teamId: string, header: TeamHeader | undefined, reason: string): TeamState {
  const s = new Projection(teamId, header, () => undefined, () => undefined).snapshot();
  s.status = 'damaged';
  s.damagedReason = reason;
  return s;
}

/* ------------------------------------------------------------------------- *
 * One team
 * ------------------------------------------------------------------------- */

interface PendingCall {
  items: readonly LogAppend[];
  reserve: boolean;
  /** acquire's own batch: allowed while the seat is being taken. */
  internal: boolean;
  resolve: (r: StoreResult<LogEvent[]>) => void;
}

/** Where this store stands with the seat. `lost` is terminal (I2). */
type Phase = 'none' | 'acquiring' | 'owned' | 'lost';

/** The lease file as read: absent, or its bytes, inode, mtime and parsed value (undefined when unparseable). */
type LeaseRead =
  | { state: 'absent' }
  | { state: 'error'; errno: string }
  | { state: 'present'; text: string; lease: TeamLease | undefined; ino: bigint; mtimeMs: number };

class Store implements TeamStore {
  readonly files: ReturnType<typeof teamFilesOf>;
  private phase: Phase = 'none';
  /** Set by release() at once, so a call made after it is refused even before its batch lands. */
  private releasing = false;
  /** A failed write whose truncation also failed: every later write is `io` until the next acquire repairs. */
  private stopped = false;
  private acquiring: Promise<StoreResult<{ tookOver?: { oldHostPid: number }; repairedBytes: number }>> | undefined;
  private fd: number | undefined;
  private size = 0;
  private header: TeamHeader | undefined;
  private events: LogEvent[] = [];
  private projection: Projection | undefined;
  private fenceCache: { ino: bigint; mtimeMs: number; size: number } | undefined;
  private lostHolder: TeamLease | undefined;
  private overlay: TeamStateOverlay | undefined;
  private readonly callbacks = new Set<(events: LogEvent[]) => void>();
  private queue: PendingCall[] = [];
  private flushScheduled = false;

  constructor(
    readonly teamId: string,
    private readonly runtime: TeamRuntime,
  ) {
    this.files = teamFilesOf(runtime.dataRoot, teamId);
  }

  /* ---- reading ---- */

  private dirExists(): boolean {
    try {
      return fs.lstatSync(this.files.dir).isDirectory();
    } catch {
      return false;
    }
  }

  readHeader(): StoreResult<TeamHeader> {
    if (this.phase === 'owned' && this.header !== undefined) {
      return ok(this.header);
    }
    const r = readText(this.files.header, HEADER_MAX_BYTES, 'team.json');
    if (!r.ok) {
      return r;
    }
    const header = asHeader(parseJson(r.value), this.teamId);
    return header === undefined ? fail('unreadable', "team.json is not this team's header") : ok(header);
  }

  readStateFile(): StoreResult<TeamState> {
    const r = readText(this.files.state, STATE_MAX, 'state.json');
    if (!r.ok) {
      return r;
    }
    const v = parseJson(r.value);
    if (!isObj(v) || v.v !== 1 || v.id !== this.teamId || !Array.isArray(v.members) || !Array.isArray(v.board)) {
      return fail('unreadable', "state.json is not this team's projection");
    }
    return ok(v as unknown as TeamState);
  }

  /** The log from disk with the header, validated; `damaged` for every rule of §2.3 it breaks. */
  private loadLog(): StoreResult<{ header: TeamHeader; log: ParsedLog }> {
    if (!this.dirExists()) {
      return fail('absent', `team ${this.teamId} does not exist`);
    }
    const header = this.readHeader();
    if (!header.ok) {
      return fail('damaged', `team.json cannot be read: ${header.reason}`);
    }
    const bytes = readBytes(this.files.log, TEAM_LOG_MAX);
    if (!bytes.ok) {
      return fail('damaged', bytes.reason === 'absent' ? 'events.jsonl is missing' : `events.jsonl cannot be read (${bytes.errno})`, {
        errno: bytes.errno,
      });
    }
    const parsed = parseLog(bytes.buf);
    if (!parsed.ok) {
      return fail('damaged', parsed.reason);
    }
    return ok({ header: header.value, log: parsed.log });
  }

  readLog(): StoreResult<{ header: TeamHeader; events: LogEvent[]; tornBytes: number }> {
    if (this.phase === 'owned' && this.header !== undefined) {
      return ok({ header: this.header, events: this.events.slice(), tornBytes: 0 });
    }
    const r = this.loadLog();
    return r.ok ? ok({ header: r.value.header, events: r.value.log.events, tornBytes: r.value.log.tornBytes }) : r;
  }

  private goalReader(): (rel: string) => string | undefined {
    return (rel) => {
      if (relProblem(rel) !== undefined || !parentsAreReal(this.files.dir, rel)) {
        return undefined;
      }
      const r = readText(path.join(this.files.dir, ...rel.split('/')), GOAL_MAX, 'the goal');
      return r.ok ? r.value : undefined;
    };
  }

  private reduceAll(header: TeamHeader, events: readonly LogEvent[]): Projection {
    const p = new Projection(this.teamId, header, this.goalReader(), (line) => this.runtime.log(line));
    for (const e of events) {
      p.apply(e);
    }
    return p;
  }

  projectLog(): StoreResult<TeamState> {
    if (this.phase === 'owned' && this.projection !== undefined) {
      return ok(this.projection.snapshot());
    }
    const r = this.loadLog();
    if (r.ok) {
      return ok(this.reduceAll(r.value.header, r.value.log.events).snapshot());
    }
    if (r.code === 'absent') {
      return r;
    }
    const header = this.readHeader();
    return ok(damagedState(this.teamId, header.ok ? header.value : undefined, r.reason));
  }

  eventsFrom(fromSeq: number, max: number): LogEvent[] | 'resnapshot_required' {
    if (!isInt(fromSeq) || fromSeq < 0) {
      return 'resnapshot_required';
    }
    const log = this.readLog();
    if (!log.ok) {
      return 'resnapshot_required';
    }
    const events = log.value.events;
    if (fromSeq > events.length || events.length - fromSeq > TEAM_SUBSCRIBE_REPLAY_MAX) {
      return 'resnapshot_required';
    }
    const limit = isInt(max) && max >= 0 ? max : TEAM_SUBSCRIBE_REPLAY_MAX;
    // seq k is events[k - 1] (gap-free from 1), so the events after fromSeq start at index fromSeq.
    return events.slice(fromSeq, fromSeq + limit);
  }

  messages(query: { to?: string; from?: string; afterSeq?: number; max?: number }): MsgPostedEvent[] {
    const log = this.readLog();
    if (!log.ok) {
      return [];
    }
    const q = isObj(query) ? query : {};
    const after = isInt(q.afterSeq) ? q.afterSeq : 0;
    const out: MsgPostedEvent[] = [];
    for (const e of log.value.events) {
      if (e.type !== 'msg.posted' || e.seq <= after) {
        continue;
      }
      if (q.from !== undefined && e.from !== q.from) {
        continue;
      }
      if (q.to !== undefined && e.to !== q.to && !(Array.isArray(e.recipients) && e.recipients.includes(q.to))) {
        continue;
      }
      out.push(e);
    }
    return isInt(q.max) && q.max >= 0 && out.length > q.max ? out.slice(out.length - q.max) : out;
  }

  messageText(message: MsgPostedEvent): StoreResult<string> {
    if (!isObj(message)) {
      return fail('unreadable', 'not a message');
    }
    if (isStr(message.body)) {
      return ok(message.body);
    }
    if (!isStr(message.bodyFile)) {
      return fail('unreadable', `${messageIdOf(message.seq)} has neither a body nor a body file`);
    }
    const r = this.readFile(message.bodyFile, MESSAGE_MAX_BYTES);
    if (!r.ok) {
      return r.code === 'io' ? fail('unreadable', r.reason) : r;
    }
    return bodySha256(r.value) === message.sha256
      ? r
      : fail('unreadable', `the body file of ${messageIdOf(message.seq)} does not match its sha256`);
  }

  readFile(rel: string, maxBytes: number): StoreResult<string> {
    const problem = relProblem(rel);
    if (problem !== undefined) {
      return fail('io', `${problem}`, { errno: 'EINVAL' });
    }
    if (!parentsAreReal(this.files.dir, rel)) {
      return this.dirExists() ? fail('absent', `${rel} does not exist`) : fail('absent', `team ${this.teamId} does not exist`);
    }
    return readText(path.join(this.files.dir, ...rel.split('/')), maxBytes, rel);
  }

  feedTail(member: string, max: number): FeedItem[] {
    if (!isStr(member) || !MEMBER_NAME.test(member) || !isPosInt(max)) {
      return [];
    }
    const mf = memberFilesOf(this.files.dir, member);
    if (!parentsAreReal(this.files.dir, `members/${member}/feed.jsonl`)) {
      return [];
    }
    const items = feedItemsOf(mf.feed, max);
    if (items.length < max) {
      items.unshift(...feedItemsOf(mf.feedRotated, max - items.length));
    }
    return items;
  }

  /* ---- the seat ---- */

  owned(): boolean {
    return this.phase === 'owned' && !this.releasing;
  }

  private myLease(): TeamLease {
    return {
      v: 1,
      hostPid: this.runtime.host.pid,
      hostStartedAt: this.runtime.host.startedAt,
      session: { pid: this.runtime.session.pid, startedAt: this.runtime.session.startedAt },
      socket: this.runtime.socket,
      acquiredAt: Date.now(),
    };
  }

  private namesMe(lease: TeamLease | undefined): boolean {
    return lease !== undefined && sameProcess({ pid: lease.hostPid, startedAt: lease.hostStartedAt }, this.runtime.host);
  }

  private readLease(file = this.files.lease): LeaseRead {
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(file, { bigint: true });
    } catch (err) {
      return errnoOf(err) === 'ENOENT' ? { state: 'absent' } : { state: 'error', errno: errnoOf(err) };
    }
    const r = readTextSafe(file, LEASE_MAX_BYTES, { noFollow: true, strictUtf8: true });
    if (!r.ok) {
      return r.reason === 'absent' ? { state: 'absent' } : { state: 'present', text: '', lease: undefined, ino: st.ino, mtimeMs: Number(st.mtimeMs) };
    }
    return { state: 'present', text: r.text, lease: asLease(r.text), ino: st.ino, mtimeMs: Number(st.mtimeMs) };
  }

  /** §2.1: stale ⇔ the holder is dead or its start time is not the recorded one; an unparseable lease is stale only when older than START_LOCK_STALE_MS. */
  private leaseIsStale(read: Extract<LeaseRead, { state: 'present' }>): boolean {
    if (read.lease === undefined) {
      return Date.now() - read.mtimeMs > START_LOCK_STALE_MS;
    }
    return !holderIsLive(read.lease.hostPid, read.lease.hostStartedAt);
  }

  private setFenceCache(): void {
    try {
      const st = fs.lstatSync(this.files.lease, { bigint: true });
      this.fenceCache = { ino: st.ino, mtimeMs: Number(st.mtimeMs), size: Number(st.size) };
    } catch {
      this.fenceCache = undefined;
    }
  }

  /**
   * H4's start lock: `lease.lock` created exclusively; an existing one removed only when stale
   * (its holder dead — or, unparseable, older than START_LOCK_STALE_MS), then tried once more.
   * The removal is a RENAME to a unique name followed by an inode check, never a plain unlink: two
   * takers that both judged one dead lock stale would otherwise each unlink — the second unlinking
   * the FIRST one's fresh lock — and both hold it. When the inode moved is not the one judged (a
   * fresh lock slipped in), it is linked back and this taker answers `contended`.
   */
  private takeLock(): { ok: true; ino: bigint } | StoreFailure {
    const lock = this.files.leaseLock;
    const body = JSON.stringify({ pid: this.runtime.host.pid, startedAt: this.runtime.host.startedAt });
    for (let attempt = 0; attempt < 2; attempt++) {
      const made = linkExclusive(lock, body);
      if (made.ok) {
        return { ok: true, ino: made.ino };
      }
      if (made.errno !== 'EEXIST') {
        return ioFail('creating lease.lock', made.errno);
      }
      const held = this.readLease(lock);
      if (held.state === 'absent') {
        continue;
      }
      if (held.state === 'error') {
        return ioFail('reading lease.lock', held.errno);
      }
      const holder = parseJson(held.text);
      const id = asIdentity(holder);
      const stale = id !== undefined ? !holderIsLive(id.pid, id.startedAt) : Date.now() - held.mtimeMs > START_LOCK_STALE_MS;
      if (!stale || attempt > 0) {
        return fail('contended', 'another host is taking the lease right now (lease.lock is held)');
      }
      const aside = `${lock}.${process.pid}.${randomHex()}.stale`;
      try {
        fs.renameSync(lock, aside);
      } catch (err) {
        if (errnoOf(err) === 'ENOENT') {
          continue;
        }
        return ioFail('removing a stale lease.lock', errnoOf(err));
      }
      if (!this.sameInode(aside, held.ino)) {
        this.putBack(aside, lock);
        return fail('contended', 'another host is taking the lease right now (lease.lock changed hands)');
      }
      unlinkQuietly(aside);
    }
    return fail('contended', 'another host is taking the lease right now (lease.lock is held)');
  }

  private sameInode(file: string, ino: bigint): boolean {
    try {
      return fs.lstatSync(file, { bigint: true }).ino === ino;
    } catch {
      return false;
    }
  }

  /** Undo a rename that moved the wrong file: link it back (never over another file), then drop the aside name. */
  private putBack(aside: string, original: string): void {
    try {
      fs.linkSync(aside, original);
      unlinkQuietly(aside);
    } catch {
      // the name was taken again meanwhile: the aside copy stays (named *.stale), nothing is overwritten
    }
  }

  /** Unlink `lease.lock` only while it is still the one this taker created. */
  private dropLock(ino: bigint): void {
    if (this.sameInode(this.files.leaseLock, ino)) {
      unlinkQuietly(this.files.leaseLock);
    }
  }

  /** Unlink `lease.json` only while it names this host — a failed acquire must not free another host's seat. */
  private unlinkMyLease(): void {
    const read = this.readLease();
    if (read.state === 'present' && this.namesMe(read.lease)) {
      unlinkQuietly(this.files.lease);
    }
  }

  /** Steps 2–4 of acquire: the seat, or why not. `created` when this call made the lease file. */
  private claimSeat(): StoreResult<{ created: boolean; tookOver?: { oldHostPid: number } }> {
    const first = this.readLease();
    if (first.state === 'error') {
      return ioFail('reading lease.json', first.errno);
    }
    if (first.state === 'absent') {
      const made = linkExclusive(this.files.lease, JSON.stringify(this.myLease()));
      if (!made.ok) {
        return made.errno === 'EEXIST'
          ? fail('contended', 'another host created lease.json at the same moment')
          : made.errno === 'ENOENT'
            ? fail('absent', `team ${this.teamId} does not exist`)
            : ioFail('creating lease.json', made.errno);
      }
      return ok({ created: true });
    }
    if (this.namesMe(first.lease)) {
      return ok({ created: false });
    }
    if (first.lease === undefined && !this.leaseIsStale(first)) {
      return fail('contended', 'lease.json is being written by another host (unparseable and recent)');
    }
    if (first.lease !== undefined && !this.leaseIsStale(first)) {
      return fail('busy', `team ${this.teamId} is led by host pid ${first.lease.hostPid}`, { holder: first.lease });
    }
    // H4: the lease is stale — take it in the five steps of §2.1.
    const lock = this.takeLock();
    if (!lock.ok) {
      return lock;
    }
    try {
      const again = this.readLease();
      if (again.state === 'error') {
        return ioFail('re-reading lease.json', again.errno);
      }
      if (again.state === 'absent' || again.ino !== first.ino || again.text !== first.text) {
        return fail('contended', 'lease.json changed while it was being taken over', {
          ...(again.state === 'present' && again.lease !== undefined ? { holder: again.lease } : {}),
        });
      }
      if (!this.leaseIsStale(again)) {
        return again.lease !== undefined
          ? fail('busy', `team ${this.teamId} is led by host pid ${again.lease.hostPid}`, { holder: again.lease })
          : fail('contended', 'lease.json is no longer stale');
      }
      const oldHostPid = first.lease?.hostPid ?? 0;
      const kept = this.files.staleLease(oldHostPid);
      try {
        fs.renameSync(this.files.lease, kept);
      } catch (err) {
        return errnoOf(err) === 'ENOENT'
          ? fail('contended', 'lease.json was taken over by another host')
          : ioFail('renaming the stale lease.json', errnoOf(err));
      }
      if (!this.sameInode(kept, first.ino)) {
        this.putBack(kept, this.files.lease);
        return fail('contended', 'lease.json changed while it was being taken over');
      }
      const made = linkExclusive(this.files.lease, JSON.stringify(this.myLease()));
      if (!made.ok) {
        return made.errno === 'EEXIST'
          ? fail('contended', 'another host created lease.json at the same moment')
          : ioFail('creating lease.json', made.errno);
      }
      return ok({ created: true, tookOver: { oldHostPid } });
    } finally {
      this.dropLock(lock.ino);
    }
  }

  acquire(): Promise<StoreResult<{ tookOver?: { oldHostPid: number }; repairedBytes: number }>> {
    if (this.phase === 'owned' && !this.releasing) {
      return Promise.resolve(ok({ repairedBytes: 0 }));
    }
    if (this.phase === 'lost') {
      return Promise.resolve(this.lostFailure());
    }
    if (this.releasing) {
      return Promise.resolve(fail('contended', `this host is releasing team ${this.teamId}'s lease right now`));
    }
    if (this.acquiring === undefined) {
      this.acquiring = this.doAcquire().finally(() => {
        this.acquiring = undefined;
      });
    }
    return this.acquiring;
  }

  private async doAcquire(): Promise<StoreResult<{ tookOver?: { oldHostPid: number }; repairedBytes: number }>> {
    if (!this.dirExists()) {
      return fail('absent', `team ${this.teamId} does not exist`);
    }
    const seat = this.claimSeat();
    if (!seat.ok) {
      return seat;
    }
    const abandon = <T extends StoreFailure>(failure: T): T => {
      closeQuietly(this.fd);
      this.fd = undefined;
      this.phase = 'none';
      this.events = [];
      this.projection = undefined;
      this.unlinkMyLease();
      return failure;
    };
    const loaded = this.loadLog();
    if (!loaded.ok) {
      return abandon(loaded.code === 'absent' ? loaded : fail('damaged', loaded.reason, loaded.errno ? { errno: loaded.errno } : {}));
    }
    const { header, log } = loaded.value;
    try {
      this.fd = fs.openSync(this.files.log, O_APPEND_WRITE);
      if (!fs.fstatSync(this.fd).isFile()) {
        return abandon(ioFail('opening events.jsonl', 'EINVAL'));
      }
      // Step 6, the repair (owner only): cut a torn tail at the last `\n`; give a complete but
      // unterminated last event its `\n`.
      if (log.tornBytes > 0) {
        fs.ftruncateSync(this.fd, log.cleanBytes);
        fs.fsyncSync(this.fd);
        this.size = log.cleanBytes;
      } else if (log.unterminatedTail) {
        writeAll(this.fd, Buffer.from('\n'));
        fs.fdatasyncSync(this.fd);
        this.size = fs.fstatSync(this.fd).size;
      } else {
        this.size = fs.fstatSync(this.fd).size;
      }
    } catch (err) {
      return abandon(ioFail('repairing events.jsonl', errnoOf(err)));
    }
    this.header = header;
    this.events = log.events.slice();
    this.projection = this.reduceAll(header, this.events);
    this.stopped = false;
    this.releasing = false;
    this.lostHolder = undefined;
    this.setFenceCache();
    this.phase = 'acquiring';
    const batch: LogAppend[] = [];
    if (log.tornBytes > 0) {
      batch.push({ by: 'engine', body: { type: 'log.repaired', droppedBytes: log.tornBytes } });
    }
    const me = this.runtime;
    batch.push({
      by: 'engine',
      body: {
        type: 'lease.acquired',
        hostPid: me.host.pid,
        hostStartedAt: me.host.startedAt,
        session: { pid: me.session.pid, startedAt: me.session.startedAt },
        ...(seat.value.tookOver ? { tookOver: seat.value.tookOver } : {}),
      },
    });
    const appended = await this.enqueue(batch, true, true);
    if (!appended.ok) {
      // The await may have seen the fence fail: a lost seat is final, nothing left to abandon.
      if ((this.phase as Phase) === 'lost') {
        return appended;
      }
      return abandon(appended);
    }
    this.phase = 'owned';
    const written = this.writeState();
    if (!written.ok) {
      this.runtime.log(`team ${this.teamId}: state.json not written after acquire: ${written.reason}`);
    }
    return ok({ ...(seat.value.tookOver ? { tookOver: seat.value.tookOver } : {}), repairedBytes: log.tornBytes });
  }

  async release(reason: string): Promise<StoreResult<void>> {
    if (this.phase !== 'owned' || this.releasing) {
      return ok(undefined);
    }
    const appended = this.enqueue([{ by: 'engine', body: { type: 'lease.released', reason: isStr(reason) ? reason : '' } }], true, false);
    // Calls made from here on are refused: nothing may follow lease.released in the log.
    this.releasing = true;
    const r = await appended;
    if (!r.ok && r.code === 'lease-lost') {
      return r;
    }
    this.unlinkMyLease();
    this.dropOwnership('none');
    return r.ok ? ok(undefined) : r;
  }

  /** Leave the owned state (released or lost): the descriptor closed, the memory dropped — the next acquire reloads from disk. */
  private dropOwnership(phase: 'none' | 'lost'): void {
    closeQuietly(this.fd);
    this.fd = undefined;
    this.phase = phase;
    this.releasing = false;
    this.events = [];
    this.projection = undefined;
    this.header = undefined;
    this.fenceCache = undefined;
  }

  private lostFailure(): StoreFailure {
    return fail('lease-lost', `team ${this.teamId} was taken over by another host; this store no longer writes it`, {
      ...(this.lostHolder ? { holder: this.lostHolder } : {}),
    });
  }

  /**
   * The fence (H4): `lease.json` must still name this host. Cached by inode, mtime and size, so the
   * common case is one lstat. Gone or naming another host → this store stops writing FOR GOOD.
   */
  private fence(): StoreFailure | undefined {
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(this.files.lease, { bigint: true });
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') {
        return this.loseLease(undefined);
      }
      return ioFail('checking lease.json', errnoOf(err));
    }
    const c = this.fenceCache;
    if (c !== undefined && c.ino === st.ino && c.mtimeMs === Number(st.mtimeMs) && c.size === Number(st.size)) {
      return undefined;
    }
    const read = this.readLease();
    if (read.state === 'absent') {
      return this.loseLease(undefined);
    }
    if (read.state === 'error') {
      return ioFail('reading lease.json', read.errno);
    }
    if (read.lease === undefined) {
      return ioFail('reading lease.json', 'EINVAL');
    }
    if (!this.namesMe(read.lease)) {
      return this.loseLease(read.lease);
    }
    this.fenceCache = { ino: read.ino, mtimeMs: read.mtimeMs, size: Buffer.byteLength(read.text, 'utf8') };
    return undefined;
  }

  private loseLease(holder: TeamLease | undefined): StoreFailure {
    this.lostHolder = holder;
    const queued = this.queue.splice(0);
    this.dropOwnership('lost');
    this.runtime.log(
      `team ${this.teamId}: lease lost${holder ? ` to host pid ${holder.hostPid}` : ' (lease.json is gone)'}; this store stops writing the team`,
    );
    const failure = this.lostFailure();
    for (const call of queued) {
      call.resolve(failure);
    }
    return failure;
  }

  /** Every write path's gate: the seat, then the fence. */
  private writeGate(): StoreFailure | undefined {
    if (this.phase === 'lost') {
      return this.lostFailure();
    }
    if (this.phase !== 'owned' || this.releasing) {
      return fail('not-owner', `this host does not hold team ${this.teamId}'s lease`);
    }
    return this.fence();
  }

  /* ---- writing ---- */

  append(items: readonly LogAppend[], opts?: { reserve?: boolean }): Promise<StoreResult<LogEvent[]>> {
    if (this.phase === 'lost') {
      return Promise.resolve(this.lostFailure());
    }
    if (this.phase !== 'owned' || this.releasing) {
      return Promise.resolve(fail('not-owner', `this host does not hold team ${this.teamId}'s lease`));
    }
    if (!Array.isArray(items) || items.length === 0) {
      return Promise.resolve(ok([]));
    }
    return this.enqueue(items, opts?.reserve === true, false);
  }

  private enqueue(items: readonly LogAppend[], reserve: boolean, internal: boolean): Promise<StoreResult<LogEvent[]>> {
    return new Promise((resolve) => {
      this.queue.push({ items, reserve, internal, resolve });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  /**
   * One batch: every call queued so far, in the order made. Synchronous from the fence to the last
   * resolve (see the file comment). A call that cannot be written (line-too-long, log-full, a body
   * file that failed) fails alone and takes no seqs; the others keep their order.
   */
  private flush(): void {
    this.flushScheduled = false;
    const calls = this.queue.splice(0);
    if (calls.length === 0) {
      return;
    }
    const allowed = calls.filter((c) => {
      if (this.phase === 'lost') {
        c.resolve(this.lostFailure());
        return false;
      }
      if (!(c.internal ? this.phase === 'acquiring' : this.phase === 'owned')) {
        c.resolve(fail('not-owner', `this host does not hold team ${this.teamId}'s lease`));
        return false;
      }
      if (this.stopped || this.fd === undefined) {
        c.resolve(fail('io', 'events.jsonl is not writable since a failed write could not be undone', { errno: 'EIO' }));
        return false;
      }
      return true;
    });
    if (allowed.length === 0) {
      return;
    }
    const fenced = this.fence();
    if (fenced !== undefined) {
      for (const c of allowed) {
        c.resolve(fenced);
      }
      return;
    }
    const ts = Date.now();
    const soft = TEAM_LOG_MAX - 16 * LOG_LINE_MAX;
    let seq = this.events.length;
    let size = this.size;
    const accepted: Array<{ call: PendingCall; events: LogEvent[] }> = [];
    const chunks: Buffer[] = [];
    const bodyFiles: string[] = [];
    for (const call of allowed) {
      const built = this.buildCall(call, seq, ts);
      if (!built.ok) {
        call.resolve(built);
        continue;
      }
      const bytes = built.lines.reduce((n, b) => n + b.length, 0);
      if (size + bytes > (call.reserve ? TEAM_LOG_MAX : soft)) {
        built.bodyFiles.forEach(unlinkQuietly);
        call.resolve(fail('log-full', `events.jsonl would pass ${call.reserve ? 'TEAM_LOG_MAX' : 'its soft limit'}`));
        continue;
      }
      seq += built.events.length;
      size += bytes;
      chunks.push(...built.lines);
      bodyFiles.push(...built.bodyFiles);
      accepted.push({ call, events: built.events });
    }
    if (accepted.length === 0) {
      return;
    }
    const buf = Buffer.concat(chunks);
    try {
      writeAll(this.fd as number, buf);
      fs.fdatasyncSync(this.fd as number);
    } catch (err) {
      const errno = errnoOf(err);
      try {
        fs.ftruncateSync(this.fd as number, this.size);
      } catch {
        this.stopped = true;
        this.runtime.log(`team ${this.teamId}: a failed append could not be truncated back; the store stops writing until the next acquire`);
      }
      bodyFiles.forEach(unlinkQuietly);
      const failure = ioFail('appending to events.jsonl', errno);
      for (const a of accepted) {
        a.call.resolve(failure);
      }
      return;
    }
    this.size += buf.length;
    const batch = accepted.flatMap((a) => a.events);
    this.events.push(...batch);
    for (const e of batch) {
      this.projection?.apply(e);
    }
    for (const cb of [...this.callbacks]) {
      try {
        cb(batch.slice());
      } catch (err) {
        this.runtime.log(`team ${this.teamId}: an onEvents callback threw: ${flattenOneLine(String((err as Error)?.message ?? err))}`);
      }
    }
    if (this.phase === 'owned') {
      // The fence just passed, and a release's own batch must still reach state.json (owner null).
      const written = this.writeStateFile();
      if (!written.ok) {
        this.runtime.log(`team ${this.teamId}: state.json not written: ${written.reason}`);
      }
    }
    for (const a of accepted) {
      a.call.resolve(ok(a.events));
    }
  }

  /** One call's events and lines from `seq + 1`; its body files written (fsync'd) BEFORE the log write. */
  private buildCall(
    call: PendingCall,
    seq: number,
    ts: number,
  ): { ok: true; events: LogEvent[]; lines: Buffer[]; bodyFiles: string[] } | StoreFailure {
    const events: LogEvent[] = [];
    const lines: Buffer[] = [];
    const bodyFiles: string[] = [];
    const undo = (f: StoreFailure): StoreFailure => {
      bodyFiles.forEach(unlinkQuietly);
      return f;
    };
    for (let i = 0; i < call.items.length; i++) {
      const item = call.items[i];
      if (!isObj(item) || !isObj(item.body) || !isStr(item.body.type) || !isStr(item.by)) {
        return undo(fail('io', `item ${i} is not an event`, { errno: 'EINVAL', index: i }));
      }
      const body: Record<string, unknown> = { ...(item.body as unknown as Record<string, unknown>) };
      const s = seq + i + 1;
      if (body.type === 'msg.posted' && isStr(item.bodyText)) {
        const rel = `bodies/${messageIdOf(s)}.md`;
        const dirErr = ensureOwnDir(this.files.bodies);
        const err = dirErr ?? writeAtomic(path.join(this.files.bodies, `${messageIdOf(s)}.md`), item.bodyText);
        if (err !== undefined) {
          return undo(ioFail(`writing ${rel}`, err));
        }
        bodyFiles.push(path.join(this.files.bodies, `${messageIdOf(s)}.md`));
        delete body.body;
        body.bodyFile = rel;
      }
      const event = eventOf(s, ts, item.by, body);
      const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      if (line.length > LOG_LINE_MAX) {
        return undo(fail('line-too-long', `item ${i} serialises to ${line.length} bytes (LOG_LINE_MAX ${LOG_LINE_MAX})`, { index: i }));
      }
      events.push(event);
      lines.push(line);
    }
    return { ok: true, events, lines, bodyFiles };
  }

  onEvents(cb: (events: LogEvent[]) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  state(): TeamState | undefined {
    if (this.phase !== 'owned' || this.projection === undefined) {
      return undefined;
    }
    return this.withOverlay(this.projection.snapshot());
  }

  private withOverlay(projected: TeamState): TeamState {
    if (this.overlay === undefined) {
      return projected;
    }
    const fallback = structuredClone(projected);
    try {
      const out = this.overlay(projected);
      return isObj(out) ? out : fallback;
    } catch (err) {
      this.runtime.log(`team ${this.teamId}: the state overlay threw: ${flattenOneLine(String((err as Error)?.message ?? err))}`);
      return fallback;
    }
  }

  setOverlay(overlay: TeamStateOverlay): void {
    this.overlay = typeof overlay === 'function' ? overlay : undefined;
  }

  writeState(): StoreResult<void> {
    const gate = this.writeGate();
    return gate !== undefined ? gate : this.writeStateFile();
  }

  private writeStateFile(): StoreResult<void> {
    if (this.projection === undefined) {
      return fail('not-owner', `this host does not hold team ${this.teamId}'s lease`);
    }
    const state = this.withOverlay(this.projection.snapshot());
    let text = JSON.stringify(state);
    if (Buffer.byteLength(text, 'utf8') > STATE_MAX) {
      for (const task of state.board) {
        if (task.bodyFile !== undefined || task.body !== undefined) {
          delete task.body;
        }
      }
      text = JSON.stringify(state);
      if (Buffer.byteLength(text, 'utf8') > STATE_MAX) {
        return fail('too-large', `state.json would be over STATE_MAX (${STATE_MAX} bytes)`);
      }
    }
    const err = writeAtomic(this.files.state, text);
    return err === undefined ? ok(undefined) : ioFail('writing state.json', err);
  }

  writeFile(rel: string, text: string): StoreResult<string> {
    const gate = this.writeGate();
    if (gate !== undefined) {
      return gate;
    }
    return writeTeamFile(this.files.dir, rel, text);
  }

  appendFeed(member: string, items: readonly FeedItem[]): StoreResult<void> {
    const gate = this.writeGate();
    if (gate !== undefined) {
      return gate;
    }
    if (!isStr(member) || !MEMBER_NAME.test(member)) {
      return fail('io', 'not a member name', { errno: 'EINVAL' });
    }
    const mf = memberFilesOf(this.files.dir, member);
    const lines = (Array.isArray(items) ? items : [])
      .filter((item) => isObj(item) && isStr(item.k) && (FEED_KINDS as readonly string[]).includes(item.k))
      .map((item) => `${JSON.stringify(cappedFeedItem(item as unknown as FeedItem))}\n`)
      .join('');
    if (lines.length === 0) {
      return ok(undefined);
    }
    const dirErr = ensureOwnDir(this.files.members) ?? ensureOwnDir(mf.dir);
    if (dirErr !== undefined) {
      return ioFail(`creating members/${member}`, dirErr);
    }
    const bytes = Buffer.from(lines, 'utf8');
    try {
      const st = fs.lstatSync(mf.feed);
      if (st.isFile() && st.size + bytes.length > FEED_ROTATE) {
        fs.renameSync(mf.feed, mf.feedRotated);
      }
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') {
        return ioFail(`rotating members/${member}/feed.jsonl`, errnoOf(err));
      }
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(mf.feed, O_APPEND_WRITE | fs.constants.O_CREAT, TEAM_FILE_MODE);
      if (!fs.fstatSync(fd).isFile()) {
        return ioFail(`appending to members/${member}/feed.jsonl`, 'EINVAL');
      }
      writeAll(fd, bytes);
      return ok(undefined);
    } catch (err) {
      return ioFail(`appending to members/${member}/feed.jsonl`, errnoOf(err));
    } finally {
      closeQuietly(fd);
    }
  }

  /* ---- create's hand-over (TeamStores.create) ---- */

  /** The new team's first batch is durable and its directory in place: this store owns it from here. */
  adoptCreated(header: TeamHeader, events: LogEvent[], size: number): StoreResult<void> {
    try {
      this.fd = fs.openSync(this.files.log, O_APPEND_WRITE);
    } catch (err) {
      this.unlinkMyLease();
      return ioFail('opening events.jsonl', errnoOf(err));
    }
    this.header = header;
    this.events = events;
    this.size = size;
    this.projection = this.reduceAll(header, events);
    this.stopped = false;
    this.releasing = false;
    this.setFenceCache();
    this.phase = 'owned';
    const written = this.writeState();
    if (!written.ok) {
      this.runtime.log(`team ${this.teamId}: state.json not written after create: ${written.reason}`);
    }
    return ok(undefined);
  }

  /** For TeamStores: the team must not be pruned while this store holds it. */
  holdsSeat(): boolean {
    return this.phase === 'owned' || this.phase === 'acquiring';
  }
}

/** writeFile's body, shared with create's init.files: the rel rule, own directories, atomic 0600. */
function writeTeamFile(teamDir: string, rel: string, text: string): StoreResult<string> {
  const problem = relProblem(rel);
  if (problem !== undefined || !isStr(text)) {
    return fail('io', problem ?? 'the text is not a string', { errno: 'EINVAL' });
  }
  const segments = rel.split('/');
  let dir = teamDir;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    const err = ensureOwnDir(dir);
    if (err !== undefined) {
      return ioFail(`creating the directory of ${rel}`, err);
    }
  }
  const file = path.join(dir, segments[segments.length - 1]);
  const err = writeAtomic(file, text);
  return err === undefined ? ok(file) : ioFail(`writing ${rel}`, err);
}

/** §3.8's caps on one feed item (FEED_TEXT_MAX_BYTES, FEED_TOOL_MAX_CHARS, FEED_DETAIL_MAX_CHARS). */
function cappedFeedItem(item: FeedItem): FeedItem {
  const out: FeedItem = { ts: isNum(item.ts) ? item.ts : Date.now(), turn: isStr(item.turn) ? item.turn : '', k: item.k };
  if (isStr(item.s)) out.s = cutUtf8(item.s, FEED_TEXT_MAX_BYTES);
  if (isStr(item.tool)) out.tool = sliceOneLine(flattenOneLine(item.tool), FEED_TOOL_MAX_CHARS);
  if (isStr(item.d)) out.d = sliceOneLine(flattenOneLine(item.d), FEED_DETAIL_MAX_CHARS);
  return out;
}

/** The last `max` valid items of one feed file, oldest first; unparseable lines skipped. */
function feedItemsOf(file: string, max: number): FeedItem[] {
  if (max <= 0) {
    return [];
  }
  const tail = readTailBytes(file, FEED_ROTATE + LOG_LINE_MAX);
  if (tail === undefined) {
    return [];
  }
  const lines = tail.buf.toString('utf8').split('\n');
  if (tail.cut) {
    lines.shift();
  }
  const out: FeedItem[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    const v = parseJson(lines[i]);
    if (isObj(v) && isNum(v.ts) && isStr(v.turn) && isStr(v.k) && (FEED_KINDS as readonly string[]).includes(v.k)) {
      out.push(v as unknown as FeedItem);
    }
  }
  return out.reverse();
}

/* ------------------------------------------------------------------------- *
 * The teams under one data root
 * ------------------------------------------------------------------------- */

const CREATING = /^(tm[0-9a-z]{9,20})\.creating$/;
const REMOVING = /^\.(tm[0-9a-z]{9,20})\.removing$/;

class Stores implements TeamStores {
  private readonly stores = new Map<string, Store>();
  private readonly teamsDir: string;

  constructor(private readonly runtime: TeamRuntime) {
    this.teamsDir = teamsDirOf(runtime.dataRoot);
  }

  open(teamId: string): StoreResult<TeamStore> {
    return this.storeOf(teamId);
  }

  private storeOf(teamId: string): StoreResult<Store> {
    if (!isStr(teamId) || !TEAM_ID.test(teamId)) {
      return fail('invalid-id', 'not a team id');
    }
    let store = this.stores.get(teamId);
    if (store === undefined) {
      store = new Store(teamId, this.runtime);
      this.stores.set(teamId, store);
    }
    return ok(store);
  }

  private ensureTeamsDir(): string | undefined {
    try {
      fs.mkdirSync(this.runtime.dataRoot, { recursive: true, mode: TEAM_DIR_MODE });
    } catch (err) {
      return errnoOf(err);
    }
    return ensureOwnDir(this.teamsDir);
  }

  async create(init: TeamCreateInit): Promise<StoreResult<TeamStore>> {
    const header = isObj(init) ? init.header : undefined;
    const teamId = isObj(header) ? header.id : undefined;
    if (!isStr(teamId) || !TEAM_ID.test(teamId)) {
      return fail('invalid-id', 'not a team id');
    }
    if (asHeader(header, teamId) === undefined) {
      return fail('io', 'the header is not a TeamHeader', { errno: 'EINVAL' });
    }
    const items = Array.isArray(init.events) ? init.events : [];
    if (items.length === 0 || !isObj(items[0]) || !isObj(items[0].body) || items[0].body.type !== 'team.created') {
      return fail('io', 'the first event must be team.created', { errno: 'EINVAL' });
    }
    const store = this.storeOf(teamId);
    if (!store.ok) {
      return store;
    }
    const dirErr = this.ensureTeamsDir();
    if (dirErr !== undefined) {
      return ioFail('creating the teams directory', dirErr);
    }
    const final = path.join(this.teamsDir, teamId);
    const creating = path.join(this.teamsDir, `${teamId}.creating`);
    for (const dir of [final, creating]) {
      try {
        fs.lstatSync(dir);
        return fail('exists', `team ${teamId} already exists`);
      } catch (err) {
        if (errnoOf(err) !== 'ENOENT') {
          return ioFail('checking the team directory', errnoOf(err));
        }
      }
    }
    try {
      fs.mkdirSync(creating, { mode: TEAM_DIR_MODE });
    } catch (err) {
      return errnoOf(err) === 'EEXIST' ? fail('exists', `team ${teamId} already exists`) : ioFail('creating the team directory', errnoOf(err));
    }
    const built = this.buildCreating(creating, header as TeamHeader, items, init.files);
    if (!built.ok) {
      try {
        fs.rmSync(creating, { recursive: true, force: true });
      } catch {
        // prune removes a leftover .creating later
      }
      return built;
    }
    try {
      fs.renameSync(creating, final);
    } catch (err) {
      try {
        fs.rmSync(creating, { recursive: true, force: true });
      } catch {
        // as above
      }
      return errnoOf(err) === 'EEXIST' || errnoOf(err) === 'ENOTEMPTY'
        ? fail('exists', `team ${teamId} already exists`)
        : ioFail('renaming the team directory into place', errnoOf(err));
    }
    fsyncDir(this.teamsDir);
    const adopted = store.value.adoptCreated(header as TeamHeader, built.value.events, built.value.size);
    return adopted.ok ? ok(store.value) : adopted;
  }

  /** Everything of a new team inside its `.creating` directory: header, files, lease, first batch. */
  private buildCreating(
    dir: string,
    header: TeamHeader,
    items: readonly LogAppend[],
    files: TeamCreateInit['files'],
  ): StoreResult<{ events: LogEvent[]; size: number }> {
    const headerErr = writeAtomic(path.join(dir, 'team.json'), JSON.stringify(header));
    if (headerErr !== undefined) {
      return ioFail('writing team.json', headerErr);
    }
    for (const sub of ['bodies', 'members']) {
      const err = ensureOwnDir(path.join(dir, sub));
      if (err !== undefined) {
        return ioFail(`creating ${sub}/`, err);
      }
    }
    for (const f of Array.isArray(files) ? files : []) {
      const r = writeTeamFile(dir, isObj(f) ? (f.rel as string) : '', isObj(f) ? (f.text as string) : '');
      if (!r.ok) {
        return r;
      }
    }
    const rt = this.runtime;
    const lease: TeamLease = {
      v: 1,
      hostPid: rt.host.pid,
      hostStartedAt: rt.host.startedAt,
      session: { pid: rt.session.pid, startedAt: rt.session.startedAt },
      socket: rt.socket,
      acquiredAt: Date.now(),
    };
    const leaseMade = linkExclusive(path.join(dir, 'lease.json'), JSON.stringify(lease));
    if (!leaseMade.ok) {
      return ioFail('creating lease.json', leaseMade.errno);
    }
    const batch: LogAppend[] = [
      items[0],
      {
        by: 'engine',
        body: { type: 'lease.acquired', hostPid: rt.host.pid, hostStartedAt: rt.host.startedAt, session: lease.session },
      },
      ...items.slice(1),
    ];
    const ts = Date.now();
    const events: LogEvent[] = [];
    const lines: Buffer[] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!isObj(item) || !isObj(item.body) || !isStr(item.body.type) || !isStr(item.by)) {
        return fail('io', `item ${i} is not an event`, { errno: 'EINVAL', index: i });
      }
      const body: Record<string, unknown> = { ...(item.body as unknown as Record<string, unknown>) };
      if (body.type === 'msg.posted' && isStr(item.bodyText)) {
        const name = `${messageIdOf(i + 1)}.md`;
        const err = writeAtomic(path.join(dir, 'bodies', name), item.bodyText);
        if (err !== undefined) {
          return ioFail(`writing bodies/${name}`, err);
        }
        delete body.body;
        body.bodyFile = `bodies/${name}`;
      }
      const event = eventOf(i + 1, ts, item.by, body);
      const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      if (line.length > LOG_LINE_MAX) {
        // index into init.events, which has no lease.acquired at 1
        return fail('line-too-long', `event ${i} serialises to ${line.length} bytes (LOG_LINE_MAX ${LOG_LINE_MAX})`, {
          index: i === 0 ? 0 : i - 1,
        });
      }
      events.push(event);
      lines.push(line);
    }
    const buf = Buffer.concat(lines);
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(dir, 'events.jsonl'), O_CREATE_NEW, TEAM_FILE_MODE);
      writeAll(fd, buf);
      fs.fdatasyncSync(fd);
    } catch (err) {
      return ioFail('writing events.jsonl', errnoOf(err));
    } finally {
      closeQuietly(fd);
    }
    fsyncDir(dir);
    return ok({ events, size: buf.length });
  }

  /** TEAM_ID directory names under `teams/`, newest first by the creation time each id encodes. */
  private teamIds(): string[] | { errno: string } {
    let names: string[];
    try {
      names = fs.readdirSync(this.teamsDir);
    } catch (err) {
      return errnoOf(err) === 'ENOENT' ? [] : { errno: errnoOf(err) };
    }
    return names
      .filter((n) => TEAM_ID.test(n))
      .filter((n) => {
        try {
          return fs.lstatSync(path.join(this.teamsDir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => createdAtOfId(b) - createdAtOfId(a) || (a < b ? 1 : a > b ? -1 : 0));
  }

  /**
   * T11 A20 / E11: `state.json` is a projection the owner writes; a crash between a batch and that
   * write, or a second writer, leaves it saying `active` over a log that says `suspended` — or that
   * does not validate at all, which only `acquire` used to find (so the team was listed `active`,
   * hidden, and refused as "not suspended"). The rule, chosen for its cost:
   *  - a LIVE lease holder: `state.json` as it is — the owner validated the log at its acquire and
   *    fences every append; it is the only writer (residual, stated: a foreign hand rewriting
   *    `state.json` or the log under a live owner is not seen here);
   *  - no lease or a STALE one, `state.json` not `ended`: the whole log is read and validated
   *    (`projectLog`, ≤ TEAM_LOG_MAX) — `damaged` with the reason when it breaks a §2.3 rule, the
   *    log's projection when it disagrees with `state.json` on status or seq, else `state.json`
   *    (it carries the overlay). Only teams without a live owner pay this: the suspended and the
   *    crashed ones, a handful per repository;
   *  - `ended` with no live owner (the history, up to TEAM_HISTORY_KEEP per repository): the last
   *    event's seq from the log's last LAST_SEQ_TAIL_BYTES must be `state.json`'s seq, else the
   *    full validation above. Residual, stated: an `ended` team's log garbled in the MIDDLE with an
   *    intact tail is still listed `ended` (it is never resumed, so nothing acts on it).
   */
  private judged(store: Store, fromFile: TeamState, header: TeamHeader | undefined): TeamState {
    if (fromFile.status === 'ended' && lastSeqOf(store.files.log) === fromFile.seq) {
      return fromFile;
    }
    const projected = store.projectLog();
    if (!projected.ok) {
      return damagedState(store.teamId, header, projected.reason);
    }
    const p = projected.value;
    return p.status === 'damaged' || p.status !== fromFile.status || p.seq !== fromFile.seq ? p : fromFile;
  }

  list(): TeamDirListing[] {
    const ids = this.teamIds();
    if (!Array.isArray(ids)) {
      return [];
    }
    return ids.slice(0, TEAM_DIR_SCAN_MAX).map((teamId) => {
      const store = new Store(teamId, this.runtime);
      const header = store.readHeader();
      const fromFile = store.readStateFile();
      const lease = (() => {
        const r = readTextSafe(store.files.lease, LEASE_MAX_BYTES, { noFollow: true, strictUtf8: true });
        return r.ok ? asLease(r.text) : undefined;
      })();
      let state: TeamState;
      if (!fromFile.ok) {
        const projected = store.projectLog();
        state = projected.ok ? projected.value : damagedState(teamId, header.ok ? header.value : undefined, projected.reason);
      } else if (lease !== undefined && holderIsLive(lease.hostPid, lease.hostStartedAt)) {
        state = fromFile.value;
      } else {
        state = this.judged(store, fromFile.value, header.ok ? header.value : undefined);
      }
      return {
        teamId,
        ...(header.ok ? { header: header.value } : {}),
        state,
        ...(lease !== undefined ? { lease } : {}),
      };
    });
  }

  prune(repoRoot: string): StoreResult<string[]> {
    if (!isStr(repoRoot) || repoRoot.length === 0) {
      return ok([]);
    }
    const ids = this.teamIds();
    if (!Array.isArray(ids)) {
      return ioFail('reading the teams directory', ids.errno);
    }
    const ended: string[] = [];
    for (const teamId of ids) {
      const store = new Store(teamId, this.runtime);
      const header = store.readHeader();
      if (!header.ok || header.value.repoRoot !== repoRoot) {
        continue;
      }
      if (this.stores.get(teamId)?.holdsSeat()) {
        continue;
      }
      try {
        fs.lstatSync(store.files.lease);
        continue; // a seat is held (or was left): never removed automatically
      } catch (err) {
        if (errnoOf(err) !== 'ENOENT') {
          continue;
        }
      }
      // state.json first (cheap), then the log must agree: only a team BOTH call ended is removed.
      const fromFile = store.readStateFile();
      if (fromFile.ok && fromFile.value.status !== 'ended') {
        continue;
      }
      const projected = store.projectLog();
      if (projected.ok && projected.value.status === 'ended') {
        ended.push(teamId);
      }
    }
    const removed: string[] = [];
    for (const teamId of ended.slice(TEAM_HISTORY_KEEP)) {
      const aside = path.join(this.teamsDir, `.${teamId}.removing`);
      try {
        fs.renameSync(path.join(this.teamsDir, teamId), aside);
        fs.rmSync(aside, { recursive: true, force: true });
        this.stores.delete(teamId);
        removed.push(teamId);
      } catch (err) {
        this.runtime.log(`team ${teamId}: retention could not remove the team directory (${errnoOf(err)})`);
      }
    }
    this.removeLeftovers();
    return ok(removed);
  }

  /** `.creating` / `.removing` directories older than START_LOCK_STALE_MS: a crash's leftovers. */
  private removeLeftovers(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.teamsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!CREATING.test(name) && !REMOVING.test(name)) {
        continue;
      }
      const full = path.join(this.teamsDir, name);
      try {
        const st = fs.lstatSync(full);
        if (Date.now() - st.mtimeMs <= START_LOCK_STALE_MS) {
          continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) {
          fs.unlinkSync(full);
        } else {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch (err) {
        this.runtime.log(`teams: retention could not remove ${name} (${errnoOf(err)})`);
      }
    }
  }
}

/** src/team/store.ts exports `createTeamStores: CreateTeamStores` (T3). */
export const createTeamStores: CreateTeamStores = (runtime) => new Stores(runtime);
