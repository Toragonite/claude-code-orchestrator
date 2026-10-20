import * as fs from 'fs';
import * as path from 'path';
import { REPORTED_MODEL_ID } from '../platform';
import { readTextSafe } from '../safeFs';

/**
 * mesh/transcript — reading a background worker's outcome back off disk, with no
 * subprocess and no cooperation from the worker.
 *
 * A `claude --bg` worker outlives the session that dispatched it. When the orchestrator
 * dies mid-flight nothing settles those tasks: the result file the worker was asked to
 * write may never have been written, and `claude` cannot be shelled out to from every
 * surface that needs the answer (the extension host settles tasks with no MCP server
 * alive). What survives unconditionally is the CLI's own session transcript — the worker
 * writes it as it goes, so it is the one recovery source that does not depend on the
 * worker having finished cooperatively.
 *
 * This module is PURE: it opens files for reading and nothing else. No writes, no
 * child_process, no network, no module state. It NEVER throws — every I/O and parse
 * failure comes back as a `problem` field, because the callers are recovery paths and a
 * recovery path that throws re-creates the failure it exists to clean up.
 *
 * Locating the file is the subtle half. Transcripts live at
 * `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, and the path is deliberately
 * NOT constructed here for two measured reasons:
 *   - the cwd encoding maps both `/` and `.` to `-`, so it is lossy and not invertible;
 *   - a worker started with `-w` writes under the WORKTREE-encoded directory while every
 *     other surface (registry entry, `claude agents`) reports the repo root — the two
 *     disagree, so a path built from the ledger's cwd points at nothing.
 * Instead we glob `<configDir>/projects/*` for a `<jobId>*.jsonl` basename. That resolves
 * because a jobId is exactly the first 8 hex characters of the session UUID and
 * `<sessionId>.jsonl` basenames are unique across a whole config dir.
 *
 * vscode-free, node18 stdlib only (no fs.globSync — that lands in node 22 and the MCP
 * server bundles for node18). The non-stdlib imports are two leaf modules. `safeFs`, over the
 * same builtins: EVERY path this module opens is a path an untrusted process can create — a
 * `--bg` worker knows its own config dir and its own session id — and safeFs is this codebase's
 * one owner of "open a file some other process may control". Importing it is what keeps this
 * module from carrying a second, drifting copy of that open; the one read safeFs has no
 * primitive for — the END of a file — is guarded here to the same standard (readTail). And
 * `platform`, for the shape of a reported model id (sessionModelOf).
 */

export type TurnState = 'ended' | 'mid-turn' | 'unknown';

export interface TranscriptRead {
  /** Absolute path actually read, when exactly one matched. */
  file?: string;
  /** 'ended' iff the last non-sidechain content row is an assistant row with stop_reason 'end_turn'. */
  turn: TurnState;
  /** Last non-sidechain assistant row's non-empty TEXT, scanning BACKWARD. Never a thinking block. */
  finalText?: string;
  /** Epoch ms of the last row carrying a timestamp — staleness input for callers. */
  lastRowAt?: number;
  /** True when a row reported sessionKind 'bg'. */
  isBackground?: boolean;
  /** Set when nothing could be read; the caller reports this verbatim. */
  problem?: 'not-found' | 'ambiguous' | 'unreadable' | 'empty';
}

/**
 * Hard ceiling on a single transcript, in bytes. A transcript is attacker-adjacent in the
 * only sense that matters here — it is written by a model that can be told to emit
 * anything, in a directory any process on the machine can drop a file into — and this
 * module runs inside the extension host, where one unbounded readFileSync stalls the whole
 * UI or takes the host down with it. 64 MiB sits far above real usage: across 1086
 * transcripts on a working machine the p99 was 5.6 MB and the single largest 19.5 MB.
 * Exceeding it is reported as 'unreadable' rather than truncated — a half-read transcript
 * would classify the turn off a row that is not the last one, which is worse than
 * admitting we could not read it.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Hard ceiling on rows, defending the case the byte cap does not: millions of one-byte
 * lines that pass the size check and then blow up as an array of parsed objects. 200k is
 * ~22x the largest row count observed (8921) and still trivially cheap to walk.
 */
const MAX_TRANSCRIPT_ROWS = 200_000;

/**
 * A jobId we are willing to turn into a filename prefix.
 *
 * This is a match guard, not cosmetics. The ledger's jobId is 8 hex characters; anything
 * shorter — an empty string above all — turns the prefix match into "every transcript in
 * the config dir", which resolves to `ambiguous` at best and, in a directory holding a
 * single session, silently returns an UNRELATED worker's answer. The optional tail lets a
 * caller pass a full session UUID instead of the 8-char prefix. Nothing else is accepted,
 * so no separator, wildcard, or traversal sequence ever reaches the comparison.
 */
const JOB_ID_RE = /^[0-9a-f]{8}[0-9a-f-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Bounds on ONE lookup's directory walk, and why an uncapped walk was a defect rather than a
 * slow path.
 *
 * The early return at 2+ matches bounds only the AMBIGUOUS case. The case this module documents
 * as NORMAL — zero matches, "a finished worker does not always leave a transcript behind" — has
 * no exit at all until every entry of every `projects/*` directory has been listed and compared,
 * and that walk happens inside the synchronous reconcile sweep (extension-host activate(), MCP
 * dispatch_status), once per task, on a directory tree any process on the machine can grow. A
 * worker with a shell can make the common outcome the expensive one.
 *
 * Both numbers sit ~2 orders of magnitude above measured reality (one observed config dir held
 * 21 sessions; 1086 transcripts across a whole working machine), so no real lookup can reach
 * them. What happens when one does is stated in resolveTranscript: the scan reports 'unreadable',
 * never 'not-found'. Cutting a scan short and calling it absence is the swallowed error this
 * module already refuses elsewhere — and it would ALSO destroy the uniqueness the caller relies
 * on, since the second match may be the one behind the cap.
 */
const MAX_PROJECT_DIRS = 4096;
const MAX_SCANNED_ENTRIES = 100_000;

/** Shared, mutable remaining-entry budget for one lookup's walk. */
interface ScanBudget {
  entries: number;
}

/**
 * One project directory, scanned entry-at-a-time under the shared budget. Never throws.
 *
 * `fs.opendirSync` + `dir.readSync()` rather than `fs.readdirSync`, and that IS the bound:
 * readdirSync materializes every name in the directory before this code can look at one of
 * them, so a project dir holding a million entries is a million-string allocation inside a
 * synchronous sweep no matter what the loop over the array then does. Entry-at-a-time lets the
 * budget stop the walk while it is still cheap. opendir(3) opens with O_DIRECTORY, so a FIFO or
 * device among the entries is an immediate ENOTDIR rather than a blocking open — the same
 * property safeFs gives the file reads.
 *
 * 'exhausted' means the walk stopped without reaching the end of this directory, and the caller
 * turns it into 'unreadable'. That covers BOTH the budget running out and a mid-listing read
 * error: at that point we know the entry we needed may be one we never looked at.
 */
function scanProjectDir(
  projectDir: string,
  prefix: string,
  matches: string[],
  budget: ScanBudget,
): 'done' | 'exhausted' | 'ambiguous' {
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(projectDir);
  } catch {
    // A plain file or an unreadable project dir among the entries — skipped, as before. If the
    // match happened to live in it we degrade to 'not-found', the safe direction: a caller that
    // sees no evidence waits, one that sees the wrong evidence settles.
    return 'done';
  }
  try {
    for (;;) {
      if (budget.entries <= 0) {
        return 'exhausted';
      }
      let entry: fs.Dirent | null;
      try {
        entry = dir.readSync();
      } catch {
        // Half-listed: this IS a directory and we got partway into it, so unlike the opendir
        // failure above we cannot claim to have looked.
        return 'exhausted';
      }
      if (entry === null) {
        return 'done';
      }
      budget.entries -= 1;
      const name = entry.name;
      if (name.length > prefix.length && name.toLowerCase().startsWith(prefix) && name.endsWith('.jsonl')) {
        matches.push(path.join(projectDir, name));
        // Two is already the answer; stop walking so a config dir with a pathological
        // number of projects cannot turn ambiguity into a long scan.
        if (matches.length > 1) {
          return 'ambiguous';
        }
      }
    }
  } finally {
    try {
      dir.closeSync();
    } catch {
      // an fd we already hold; a failure to close costs the caller nothing
    }
  }
}

/**
 * The one transcript belonging to `jobId`, or the reason there is not exactly one.
 *
 * Zero matches is `not-found` and is a NORMAL outcome, not an error: a finished worker
 * does not always leave a transcript behind (3 of 21 in one observed config dir had none),
 * so callers treat it as "no evidence", never as a failure to report.
 *
 * A scan that was CUT SHORT is a fourth thing and reports 'unreadable' — see MAX_SCANNED_ENTRIES.
 */
function resolveTranscript(
  configDir: string,
  jobId: string,
): { file?: string; problem?: 'not-found' | 'ambiguous' | 'unreadable' } {
  // configDir arrives from a ledger record — i.e. from data, possibly hand-edited. A
  // relative path would be resolved against whatever cwd this process happens to hold,
  // which is a different directory in the extension host than in the MCP server.
  if (typeof configDir !== 'string' || configDir === '' || !path.isAbsolute(configDir)) {
    return { problem: 'not-found' };
  }
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId.toLowerCase())) {
    return { problem: 'not-found' };
  }
  const prefix = jobId.toLowerCase();
  const projects = path.join(path.resolve(configDir), 'projects');

  let root: fs.Dir;
  try {
    root = fs.opendirSync(projects);
  } catch (err) {
    // A config dir that has never hosted a session has no projects/ at all — that is
    // "nothing to match", not a fault. Anything else (permissions, an unmounted volume)
    // means the answer might exist and we cannot see it, which callers must not read as
    // evidence of absence.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { problem: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable' };
  }

  const matches: string[] = [];
  const budget: ScanBudget = { entries: MAX_SCANNED_ENTRIES };
  let dirsLeft = MAX_PROJECT_DIRS;
  let cutShort = false;
  let ambiguous = false;
  try {
    for (;;) {
      let entry: fs.Dirent | null;
      try {
        entry = root.readSync();
      } catch {
        cutShort = true;
        break;
      }
      if (entry === null) {
        break;
      }
      if (dirsLeft <= 0 || budget.entries <= 0) {
        cutShort = true;
        break;
      }
      dirsLeft -= 1;
      budget.entries -= 1;
      const outcome = scanProjectDir(path.join(projects, entry.name), prefix, matches, budget);
      if (outcome === 'ambiguous') {
        ambiguous = true;
        break;
      }
      if (outcome === 'exhausted') {
        cutShort = true;
        break;
      }
    }
  } finally {
    try {
      root.closeSync();
    } catch {
      // as above
    }
  }

  if (ambiguous) {
    return { problem: 'ambiguous' };
  }
  // Checked BEFORE the match count, and in this order deliberately: a cut-short walk cannot
  // prove there is exactly one match any more than it can prove there are none, so a single
  // match found before the cap is still not an answer.
  if (cutShort) {
    return { problem: 'unreadable' };
  }
  if (matches.length === 0) {
    return { problem: 'not-found' };
  }
  return { file: matches[0] };
}

/**
 * Whole-file read under both caps, or the reason there is no text.
 *
 * DELEGATED TO `safeFs.readTextSafe`, and the delegation is the FIX, not a tidy-up. This body
 * used to open the file itself: `fs.openSync(file, 'r')`, then fstat-the-same-fd — the right
 * half, kept, because the worker is often still appending and a stat/read race is the difference
 * between honouring MAX_TRANSCRIPT_BYTES and merely intending to — but with NO O_NONBLOCK. A
 * resolved transcript path is not proof of a transcript. Transcripts live in a directory any
 * process on the machine can write, a `--bg` worker knows its own config dir and its own session
 * id, and `mkfifo <configDir>/projects/<anything>/<sessionId>.jsonl` is one command. Opening a
 * FIFO for reading BLOCKS UNTIL A WRITER APPEARS — forever, if none ever does — and this
 * function is reached from the SYNCHRONOUS reconcile sweep, which runs from the extension host's
 * activate() and from the MCP server's dispatch_status. Measured on the pre-fix body: a FIFO
 * planted at a resolved transcript path hung readWorkerTranscript until the probe was killed.
 * `registry.readResultFile` states this exact lesson in its own header and this module did not
 * take it — which is the case for one owner rather than two copies to keep in step.
 *
 * The mapping back onto this module's vocabulary: zero bytes is 'empty' (a real observed state —
 * a session that registered and wrote nothing), and every failure is 'unreadable', INCLUDING
 * safeFs's 'absent'. Absent is deliberately NOT 'not-found' here: resolveTranscript listed this
 * name a moment ago, so a file that is gone now vanished under us, and a caller must not read
 * that race as the NORMAL "this worker left no transcript behind".
 */
function readCapped(file: string): { text?: string; problem?: 'unreadable' | 'empty' } {
  // `noFollow`: what this returns is published as "the last thing the worker said". A transcript
  // is a regular file the CLI appends to; a symbolic link at a resolved transcript name would make
  // that sentence true of whatever file the link points at, so it is refused like any other
  // non-file — and reported, like them, as 'unreadable'.
  const read = readTextSafe(file, MAX_TRANSCRIPT_BYTES, { noFollow: true });
  if (!read.ok) {
    return { problem: 'unreadable' };
  }
  if (read.bytes === 0) {
    return { problem: 'empty' };
  }
  return { text: read.text };
}

/**
 * The text a worker actually said in one assistant row: its `text` blocks, joined.
 *
 * Thinking blocks are excluded by construction and that exclusion is the point — a row
 * can carry nothing but `thinking` and still be the final row, so a naive "last assistant
 * message" reader hands the caller an empty answer for a task that completed fine.
 */
function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Resolve and read a worker's transcript from its ledger coordinates. Never throws.
 *
 * Turn classification is decided by the SHAPE OF THE LAST non-sidechain content row, and
 * deliberately NOT by the `system`/`turn_duration` row that looks like it was built for
 * this: measured across 908 transcripts that row is background-only, is not emitted once
 * per turn (files with 2–22 user turns carried 0, 1 or 2 of them; zero of 35 matched the
 * turn count), is missing outright from 6+ of 35 background transcripts, and is never
 * last. The last-row shape, by contrast, was one of exactly three across all 35:
 *   assistant + stop_reason 'end_turn'  → the turn ENDED;
 *   user carrying a tool_result         → mid-turn, a tool returned and the model never replied;
 *   assistant + stop_reason 'tool_use'  → mid-turn, a tool call was issued and never resolved.
 * The two mid-turn shapes need no telling apart here, so anything that is not an
 * end_turn assistant row collapses to 'mid-turn'.
 *
 * 'mid-turn' says NOTHING about whether the worker is alive — it means still working OR
 * died mid-turn. Liveness is a different module's evidence; inferring it from a transcript
 * would silently settle tasks that are still running. `lastRowAt` is exported precisely so
 * that judgement stays with the caller.
 */
export function readWorkerTranscript(configDir: string, jobId: string): TranscriptRead {
  const found = resolveTranscript(configDir, jobId);
  if (found.problem !== undefined || found.file === undefined) {
    return { turn: 'unknown', problem: found.problem ?? 'not-found' };
  }
  const file = found.file;

  const loaded = readCapped(file);
  if (loaded.problem !== undefined || loaded.text === undefined) {
    return { file, turn: 'unknown', problem: loaded.problem ?? 'unreadable' };
  }

  // Counted before splitting, and that order is the whole defence: the byte cap alone
  // still permits 64 MiB of one-byte lines, which becomes a 64-million-element array and
  // costs gigabytes before a single row is parsed. This pass allocates nothing, so the
  // split below only ever runs on an already-bounded file.
  let rows = 1;
  for (let i = loaded.text.indexOf('\n'); i !== -1; i = loaded.text.indexOf('\n', i + 1)) {
    if (++rows > MAX_TRANSCRIPT_ROWS) {
      return { file, turn: 'unknown', problem: 'unreadable' };
    }
  }
  const lines = loaded.text.split('\n');

  let parsedRow = false;
  let lastRowAt: number | undefined;
  let isBackground = false;
  let lastContentIsEnded = false;
  let sawContent = false;
  let finalText: string | undefined;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // A live worker's last line is regularly a half-flushed append, and unrelated
      // tooling has been seen to leave stray lines behind. One bad line must never cost
      // us the other few thousand good ones.
      continue;
    }
    if (!isRecord(row)) {
      continue;
    }
    parsedRow = true;

    if (typeof row.timestamp === 'string') {
      const at = Date.parse(row.timestamp);
      if (Number.isFinite(at)) {
        lastRowAt = at; // last row that carries one, not the newest — rows are append-ordered
      }
    }
    if (row.sessionKind === 'bg') {
      isBackground = true;
    }

    const type = row.type;
    if (type !== 'assistant' && type !== 'user') {
      continue; // system / attachment / file-history-snapshot / custom-title / … — not content
    }
    if (row.isSidechain === true) {
      continue; // a subagent's turn, not this worker's: its end_turn is not the task ending
    }
    sawContent = true;

    const message = isRecord(row.message) ? row.message : undefined;
    lastContentIsEnded = type === 'assistant' && message?.stop_reason === 'end_turn';

    if (type === 'assistant' && message !== undefined) {
      const text = assistantText(message);
      if (text !== '') {
        // Last non-empty wins, which is exactly "the last such row scanning backward" —
        // reached in one forward pass so we never have to retain every parsed row.
        finalText = text;
      }
    }
  }

  // Not one row-shaped object came back. A JSONL file whose lines are bare arrays or
  // scalars parses without error and still yields nothing to reason about, so it is
  // reported as unreadable rather than 'empty' — 'empty' claims we read a real transcript
  // and it had no turns in it, which would be a lie about a file we never understood.
  if (!parsedRow) {
    return { file, turn: 'unknown', problem: 'unreadable' };
  }
  if (!sawContent) {
    // Rows parsed but none of them were a turn: a session that registered and died before
    // its first message. lastRowAt/isBackground still ship — they are the caller's only
    // staleness signal for exactly this case.
    return { file, turn: 'unknown', lastRowAt, isBackground: isBackground || undefined, problem: 'empty' };
  }

  return {
    file,
    turn: lastContentIsEnded ? 'ended' : 'mid-turn',
    finalText,
    lastRowAt,
    isBackground: isBackground || undefined,
  };
}

/**
 * The most of a transcript's END that sessionModelOf reads. A worker's last assistant entries
 * sit at the end of its transcript, behind a few rows of bookkeeping (a `system` row, the
 * `last-prompt` and `cost-state` rows — around 2 KB together on the real ones), so this is far
 * more than the answer needs; what it bounds is the cost of a transcript that does not end that
 * way. The largest single rows seen on real transcripts are attachments of ~190 KB, so a window
 * of this size still holds whole rows after one of them.
 */
const MODEL_TAIL_BYTES = 512 * 1024;

/**
 * Open flags for readTail: readTextSafe's `noFollow` read — read-only, non-blocking (a FIFO at
 * the name returns instead of hanging the caller), no controlling terminal, and no symbolic link
 * followed at the final component. Each optional flag is probed rather than assumed: an
 * undefined constant folded into the OR would make the flags NaN.
 */
const HAS_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number';
const TAIL_READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0) |
  (HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

/** Bytes a line must hold to be worth parsing: an assistant row names its type, or escapes it. */
const ASSISTANT_BYTES = Buffer.from('assistant', 'latin1');
const JSON_UNICODE_ESCAPE = Buffer.from('\\u', 'latin1');

/**
 * The last `max` bytes of a regular file, and whether they are the whole file — or undefined
 * when that cannot be read. Never throws.
 *
 * Guarded LOCALLY because safeFs reads whole files only, and to safeFs's standard: the same
 * open flags as a `noFollow` readTextSafe (on a platform without O_NOFOLLOW the name is asked
 * first, as readTextSafe asks it), an fstat of the SAME fd, anything but a regular file refused,
 * and a short read — the file shrank under us — refused rather than handed back as a tail. What
 * is read is the end of the size the fstat measured: a CLI still appending past it is ignored,
 * and its half-written last line is the caller's to skip.
 */
function readTail(file: string, max: number): { bytes: Buffer; whole: boolean } | undefined {
  let fd = -1;
  try {
    if (!HAS_O_NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) {
      return undefined;
    }
    fd = fs.openSync(file, TAIL_READ_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return undefined;
    }
    const size = stat.size;
    if (!Number.isFinite(size) || size <= 0) {
      return undefined;
    }
    const start = Math.max(0, size - max);
    const bytes = Buffer.alloc(size - start);
    for (let got = 0; got < bytes.length; ) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, start + got);
      if (n <= 0) {
        return undefined;
      }
      got += n;
    }
    return { bytes, whole: start === 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // an fd we already hold; a failure to close costs the caller nothing
      }
    }
  }
}

/**
 * The model a session worker's own turns ran on: `message.model` of the LAST row of its
 * transcript that is `type: "assistant"` and not `isSidechain: true`, when that value has the
 * shape of a reported model id (platform.REPORTED_MODEL_ID). Undefined in every other case — no
 * transcript, not exactly one, one that cannot be read, no such row in what is read, or a last
 * such row whose `model` is missing or of another shape. Never a guess: an earlier row is never
 * taken in place of a last one that says nothing usable. Never throws.
 *
 * WHY THE TRANSCRIPT. A one-shot run's CLI prints a result document that names the model that
 * ran; a session worker prints none — its result is a file the worker writes, and what a worker
 * says about which model it is would be the model's claim. Every assistant row of the
 * transcript carries the id the API answered with, written by the CLI as the session goes, and
 * a worker that has written its result file has made at least one of them (the Write call is an
 * assistant row). It is the CLI's record, not a guarantee: the file lives where the worker can
 * write, which is why the value is held to the reported-id shape and used for what one-shot's is
 * — a record and a display, nothing that decides.
 *
 * SIDECHAINS ARE NEVER TAKEN. A subagent's turns are `isSidechain: true` rows in the same file,
 * on the subagent's model, and they can be the last rows of it; the task ran on the main thread's.
 *
 * READ FROM THE END, and at most MODEL_TAIL_BYTES of it — never the whole file, which is tens of
 * megabytes on a long session. The located file is the one readWorkerTranscript reads
 * (resolveTranscript). Lines are scanned from the last one back; a line is parsed only when it
 * holds the bytes `assistant` or a `\u` escape, and one that does not parse — the last line of a
 * transcript still being written, above all — is skipped. Because every line after a match has
 * been read and found not to be an answer, the first match from the end IS the last such row of
 * the file. The window's first line is never read unless the window is the whole file: it may
 * have begun before the window, and a row read from its middle is not that row.
 */
export function sessionModelOf(configDir: string, jobId: string): string | undefined {
  const found = resolveTranscript(configDir, jobId);
  if (found.file === undefined) {
    return undefined;
  }
  const tail = readTail(found.file, MODEL_TAIL_BYTES);
  if (tail === undefined) {
    return undefined;
  }
  const { bytes, whole } = tail;
  for (let end = bytes.length; ; ) {
    const feed = end === 0 ? -1 : bytes.lastIndexOf(0x0a, end - 1);
    if (feed === -1 && !whole) {
      return undefined;
    }
    const line = bytes.subarray(feed + 1, end);
    if (
      line.length > 0 &&
      (line.indexOf(ASSISTANT_BYTES) !== -1 || line.indexOf(JSON_UNICODE_ESCAPE) !== -1)
    ) {
      let row: unknown;
      try {
        row = JSON.parse(line.toString('utf8'));
      } catch {
        row = undefined;
      }
      if (isRecord(row) && row.type === 'assistant' && row.isSidechain !== true) {
        const model = isRecord(row.message) ? row.message.model : undefined;
        return typeof model === 'string' && REPORTED_MODEL_ID.test(model) ? model : undefined;
      }
    }
    if (feed === -1) {
      return undefined;
    }
    end = feed;
  }
}
