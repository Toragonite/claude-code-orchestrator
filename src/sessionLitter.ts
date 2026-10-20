import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

/**
 * sessionLitter — remove the session-registry files that v1.x usage probes leaked.
 *
 * WHY THIS EXISTS. Through v1.x the usage probe SIGKILLed its `claude -p` child the instant
 * the reading arrived. A killed CLI cannot clean up after itself and leaves two files in
 * `<configDir>/sessions/`: `<pid>.json` (its session-registry entry) and `<pid>.<64 hex>.key`.
 * One probe per account every few minutes, for months, leaves tens of thousands of such files
 * in an account directory, and every CLI command that lists sessions reads them all. The probe
 * no longer leaks (see usage.terminateChild); this module is the one-time clean-up of what is
 * already on disk.
 *
 * THIS MODULE DELETES FILES INSIDE A USER'S ACCOUNT DIRECTORY, in the same directory where
 * the CLI keeps the entries of sessions that are alive right now. So the whole design is one
 * rule: a file is removed only when EVERY condition of the predicate below is positively
 * established, and anything that cannot be established — an lstat that failed, a name that is
 * one character off, JSON that does not parse, a field with an unexpected shape, a process
 * that may still exist, a file that changed between being read and being removed — means the
 * file is LEFT ALONE. Leaving litter behind costs a few bytes; removing a live session's entry
 * makes that session invisible.
 *
 * THE PREDICATE. A direct child of `<configDir>/sessions` is removed only if
 *   - its name is `<pid>.json` or `<pid>.<64 hex>.key`, where `<pid>` is the plain decimal
 *     spelling — no sign, no leading zero — of an integer from 2 to 4,194,304, AND
 *   - lstat says it is a regular file (a symlink is never followed and never removed; a
 *     directory, FIFO, socket or device is never touched), AND
 *   - its mtime is older than `minAgeMs` (a live probe exists for under 30 seconds), AND
 *   - THE PROCESS IT IS NAMED FOR IS GONE: `process.kill(pid, 0)` throws ESRCH. This is asked
 *     for every rule below, immediately before the unlink. A call that returns (a process of
 *     ours) and EPERM (a process of another user) both keep the file; AND
 *   - one of:
 *     (a) the name is `<pid>.json` and the file is empty;
 *     (b) the name is `<pid>.json`, the file is at most 64 KiB and parses as a JSON object
 *         carrying the probe's signature: `kind` is "interactive", `entrypoint` is "sdk-cli"
 *         or "claude-vscode", `cwd` is one of `tmpDirs`, its `pid` — if it has one — is the
 *         number in the file name, AND EITHER
 *           (b1) it names no messaging socket at all, OR
 *           (b2) it names one (a string), its `pid` IS the number in the file name, and NOBODY
 *                IS LISTENING at the socket path. That means: it is an absolute path, and
 *                `lstat` either finds nothing there (ENOENT — no connect is made), or finds a
 *                socket whose file name is exactly `<pid>.sock` and a connect to it as a
 *                unix-domain socket is refused (ECONNREFUSED; or ENOENT, the file having gone
 *                in between). A socket under any other name is never connected to, and keeps
 *                the file;
 *     (c) the name is `<pid>.<64 hex>.key` and either its `<pid>.json` was removed in this
 *         same pass, or no `<pid>.json` exists and the key itself is older than 24 hours.
 * Nothing else is ever a candidate. A dry run applies exactly this predicate — the same
 * questions, the same connects — and differs only in not unlinking.
 *
 * WHY THE SIGNATURE IS NOT ENOUGH, AND THE PROCESS IS ASKED FOR EVERY RULE. Probes run in
 * `os.tmpdir()` (so that no project `.mcp.json` is loaded), which a session a person is
 * actually using does not; a `--bg` worker has `kind:"bg"`; a mirrored entry written by the
 * mesh bridge carries `ccoMirror`. Each of those fails rule (b) on a field of its own. But the
 * signature describes what a probe's entry LOOKS like, and so does the entry of any other
 * headless session started in the temp directory — an SDK script, an editor's helper — while
 * it is running; an empty entry looks like nothing at all. What separates litter from a
 * session is not what its entry says but whether its process exists, and the kernel answers
 * that. The pid comes from the file NAME, because the CLI names the file after itself and an
 * entry need not carry a `pid` at all; a name that is not the plain spelling of a pid in range
 * is one this code does not understand, and it keeps the file.
 *
 * WHY (b2) ASKS ABOUT THE SOCKET AS WELL. A probe of a LOGGED-IN account registers a messaging
 * socket, so most leaked entries carry one — and a socket is also exactly what a LIVE session
 * has. For these entries the process is shown to be gone a second, independent way: nothing
 * answers at the socket it would be listening on. The pid is asked FIRST, so the socket of a
 * process that is alive is never even looked at.
 *
 * WHY "THE SOCKET FILE IS GONE" IS NOT THE TEST. A process that is SIGKILLed never unlinks its
 * socket, so a leftover socket FILE is the normal state of a leaked entry, and it looks exactly
 * like one somebody is listening on. What tells the two apart is whether anything ANSWERS. A
 * connect to a socket file nobody is listening on is refused at once (ECONNREFUSED); a connect
 * that is accepted proves a listener, and is closed immediately with nothing sent. Every other
 * outcome — EACCES, EPERM, a timeout of SOCKET_PROBE_TIMEOUT_MS, any error this code does not
 * know — is doubt, and keeps the file. The probe never writes, never holds a connection, and
 * never touches the socket file itself: that directory is the platform's, not ours.
 *
 * WHY ONLY `<pid>.sock` IS EVER CONNECTED TO. The socket path is a string read out of a file in
 * a directory other processes write. A module that connected to whatever path such a file
 * named could be made to open a connection to any unix socket on the machine, by anything able
 * to drop a file into `sessions/` — and a dry run would do it too. The CLI names a session's
 * messaging socket after the session's own pid (`/tmp/cc-socks/<pid>.sock`, measured on
 * 2.1.292), so the only socket whose listener says anything about entry `<pid>.json` is one
 * named `<pid>.sock`. It is `lstat`ed before any connect: nothing there needs no connect, and
 * something there that is not a socket, or is a socket under another name, is not approached.
 *
 * WHAT IS STILL NOT PROVEN. Every proof is made from THIS machine's point of view. A session
 * running in ANOTHER PID namespace (a container) that shares this config directory but not
 * this `/tmp` has a pid the kernel here does not know and a socket path that does not exist
 * here, so it would pass both — what keeps it is the rest of the predicate: for rule (b) its
 * `cwd` would have to be this host's own `realpath(os.tmpdir())`, its entrypoint `sdk-cli` or
 * `claude-vscode`, and its entry untouched for ten minutes; for rule (a) its entry would have
 * to be empty and that old. Should one ever match all of that, what it loses is its registry
 * entry — other sessions can no longer discover it as a peer — and not its work. And a pid is
 * a number the kernel reuses: an entry whose process died and whose pid now belongs to an
 * unrelated process is KEPT for as long as that process lives, which is the safe direction.
 * (One more platform fact, measured on macOS: a listener whose accept queue is FULL also
 * answers ECONNREFUSED. That cannot be told from "nobody is listening"; it is reachable only
 * for such a foreign-namespace session that shares `/tmp` after all, at an instant when its
 * backlog is saturated.)
 *
 * BOUNDED BY CONSTRUCTION. The directory is walked with `opendir`, one entry at a time — it
 * is never read whole, because tens of thousands of names is the case this module exists for.
 * A call examines at most `maxFiles` entries and runs for at most about `maxMs`, yields to the
 * event loop every YIELD_EVERY entries, and reports `truncated` when it stopped early so the
 * caller can call again. It runs in the extension host, which has other things to do: every
 * filesystem call is asynchronous, and at most PARALLEL files are in hand at a time.
 * (Measured with `.orchestrator/fixes/litter.mjs --bench`, the defaults, macOS, load average
 * 5: a fixture of 77,556 files under rules (a) and (b1) was emptied in 3 passes, the longest
 * 2.3 s, longest event-loop gap 4 ms. A fixture of 77,552 files with every entry naming a
 * `<pid>.sock` — rule (b2), five in eight of them a real leftover socket file, so 24,235
 * connects — was emptied in 3 passes, the longest 3.3 s, longest gap 4 ms.)
 *
 * Never throws and never rejects, whatever it is handed. Must not import `vscode`.
 */

export interface LitterReport {
  configDir: string;
  /** Directory entries looked at. */
  scanned: number;
  /** Files unlinked. In a `dryRun` pass: files that WOULD have been unlinked. */
  removed: number;
  /** The pass stopped at `maxFiles` / `maxMs` — more may remain. */
  truncated: boolean;
  /** Unlink / read failures (never thrown). */
  errors: number;
}

export interface LitterOptions {
  /** Epoch ms, default Date.now(). */
  now?: number;
  /** Default 10 * 60_000. */
  minAgeMs?: number;
  /** Max directory entries examined per call, default 20_000. */
  maxFiles?: number;
  /** Wall-clock budget per call, default 4_000. */
  maxMs?: number;
  /** Realpaths counted as "the probe cwd"; default [realpath(os.tmpdir())]. */
  tmpDirs?: string[];
  /** Classify only, unlink nothing. */
  dryRun?: boolean;
}

const DEFAULT_MIN_AGE_MS = 10 * 60_000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_MS = 4_000;

/** Rule (c): how old a key with NO sibling entry must be before it counts as abandoned. */
const ORPHAN_KEY_MIN_AGE_MS = 24 * 60 * 60_000;

/**
 * Rule (b): the largest entry that is read at all. A real entry is a few hundred bytes; a
 * file past this is not something a probe wrote, and is not read to find out what it is.
 */
const MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The event loop is yielded to after this many directory entries. The contract's ceiling is
 * 200; entries whose names do not match cost no I/O of their own, so without an explicit
 * yield a long run of them would be little more than one burst of microtasks.
 */
const YIELD_EVERY = 100;

/**
 * How many files are judged at once. Every filesystem call here is awaited on libuv's thread
 * pool (4 threads by default), so one-at-a-time spends nearly all of a pass waiting for a
 * round trip: measured that way, a 77,000-file directory took 7 to 10 four-second passes,
 * and the caller allows itself 10 a day. Kept below the pool size so the host's own file I/O
 * is never queued behind a full pool of ours.
 */
const PARALLEL = 3;

/**
 * The only two name shapes that are ever candidates. Anchored at both ends, ASCII digits
 * only (`\d` without the `u`/`v` flags is exactly [0-9]), lower-case hex only — the shapes the
 * CLI writes, and nothing "close enough". `$` has no multiline flag, so a name ending in a
 * newline does not match either. The digits are then read as a pid by `pidOfName`, which is
 * stricter than the shape.
 */
const ENTRY_NAME = /^(\d{1,10})\.json$/;
const KEY_NAME = /^(\d{1,10})\.[0-9a-f]{64}\.key$/;

/**
 * The pids a file name may stand for. 1 is the init process and 0 is not a process at all —
 * `kill(0, …)` addresses the caller's own process GROUP. 4,194,304 (2^22) is the largest pid
 * Linux can be configured to issue, and macOS stops far below it; a larger number in a name is
 * not a pid any supported kernel handed out.
 */
const NAME_PID_MIN = 2;
const NAME_PID_MAX = 4_194_304;

/**
 * The pid a file is named for, from the digits at the front of its name — or undefined when
 * they are not the way a pid is written: a leading zero (`007`), or a number outside
 * NAME_PID_MIN..NAME_PID_MAX. The CLI names these files with its own pid in plain decimal, so a
 * name that is not exactly that is one this module does not understand, and it keeps the file.
 */
function pidOfName(digits: string): number | undefined {
  const pid = Number(digits);
  return Number.isInteger(pid) && pid >= NAME_PID_MIN && pid <= NAME_PID_MAX && String(pid) === digits
    ? pid
    : undefined;
}

/** `entrypoint` values observed on leaked probe entries. */
const PROBE_ENTRYPOINTS: readonly string[] = ['sdk-cli', 'claude-vscode'];

/**
 * Open flags for reading a candidate entry: never follow a symlink at the final component,
 * never block on a FIFO, never acquire a controlling terminal. Each optional flag is probed
 * (win32 defines none of the three) because an undefined constant folded into a bitwise OR is
 * NaN, an unopenable flag set. Where O_NOFOLLOW is missing, the lstat-then-fstat identity
 * check in readProven is what still refuses a file that was swapped after it was judged.
 */
const READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * What became of one `<pid>.json` in this pass — the fact rule (c) needs about a key's sibling.
 *   - `removed`: it was litter and was unlinked (or, in a dry run, would have been).
 *   - `absent`:  the filesystem said there is nothing by that name.
 *   - `kept`:    everything else, INCLUDING "could not find out". A key is never removed on
 *                the strength of a sibling whose state is unknown.
 */
type EntryFate = 'removed' | 'absent' | 'kept';

/** A finite, non-negative number, else the default. Never trusts an option's declared type. */
function boundOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The errno code of a caught value, when it carries one. */
function errnoOf(err: unknown): string | undefined {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * "There is nothing by that name." ENOENT is the file having gone; ENOTDIR is the sessions
 * directory itself having gone or been replaced. Neither is a failure of ours — the CLI
 * removes its own entries all the time — so neither is counted in `errors`.
 */
function isGone(err: unknown): boolean {
  const code = errnoOf(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Is the SAME file still there, unmodified? Identity (dev, ino) plus size and mtime. */
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * What rule (b)'s content test makes of one entry:
 *   - `keep`:      not a leaked probe's entry, or not provably one.
 *   - `litter`:    the probe signature with no messaging socket (b1).
 *   - an object:   the probe signature WITH a messaging socket (b2) — `socketPath` is what
 *                  `nobodyListening` must still establish.
 * Neither of the last two removes anything by itself: the content says what KIND of entry
 * this is, and whether its process is gone is a separate question every rule asks.
 */
type ProbeVerdict = 'keep' | 'litter' | { socketPath: string };

/**
 * Rule (b)'s content test: is this the registry entry of a leaked usage probe? Pure, total.
 * `filePid` is the pid the file is named for.
 *
 * Every field is checked by VALUE. `ccoMirror` under any value marks a file this product's
 * mesh bridge wrote and owns, so its mere presence ends the question. The entry's own `pid`
 * may be absent (older CLIs wrote none); when it is there it must be the pid the file is named
 * for — the CLI names the file after itself, so a mismatch is a file this code does not
 * understand. `messagingSocketPath` counts as "no socket" only when it is absent or null. A
 * STRING is a socket some process opened, and is answered with the (b2) verdict only when the
 * entry does carry that `pid`; any other shape of either field is a format this code does not
 * know — which is doubt, and doubt keeps the file.
 */
function classifyEntry(text: string, tmpDirs: readonly string[], filePid: number): ProbeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'keep';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'keep';
  }
  const entry = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(entry, 'ccoMirror')) {
    return 'keep';
  }
  const signature =
    entry.kind === 'interactive' &&
    typeof entry.entrypoint === 'string' &&
    PROBE_ENTRYPOINTS.includes(entry.entrypoint) &&
    typeof entry.cwd === 'string' &&
    tmpDirs.includes(entry.cwd);
  if (!signature) {
    return 'keep';
  }
  const pid = entry.pid;
  if (pid !== undefined && pid !== filePid) {
    return 'keep';
  }
  const socketPath = entry.messagingSocketPath;
  if (socketPath === undefined || socketPath === null) {
    return 'litter';
  }
  if (typeof socketPath !== 'string' || pid !== filePid) {
    return 'keep';
  }
  return { socketPath };
}

/**
 * Does the kernel say NO process has this pid? Signal 0 delivers nothing; it only asks.
 *
 * True on ESRCH alone. A call that returns is a live process of ours; EPERM is a live process
 * of another user; anything else is an answer this code does not understand. All three keep
 * the file.
 */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return errnoOf(err) === 'ESRCH';
  }
}

/** How long one connect attempt may go unanswered before it is abandoned (and the file kept). */
const SOCKET_PROBE_TIMEOUT_MS = 500;

/**
 * The longest socket path that is connected to, in bytes. A unix-domain address holds 104
 * bytes on macOS / BSD and 108 on Linux. A path past that cannot be the address of any socket,
 * and some runtimes TRUNCATE it and connect to a different path instead of refusing. Whether
 * the last byte must be a terminator differs between platforms (macOS accepts all 104,
 * measured), so the limit is one under the smaller of the two, everywhere: a longer path is
 * simply kept.
 */
const SOCKET_PATH_MAX_BYTES = 103;

/**
 * Try to connect to `socketPath` as a unix-domain socket and say what happened: `connected`,
 * `timeout`, the errno code of the failure, or `unknown`. Never throws and never rejects.
 *
 * This is a QUESTION, not a conversation. Nothing is ever written; a connection that is
 * accepted is destroyed in the same tick it is reported, so the most a listener can observe is
 * a peer that connected and hung up without a byte; and the attempt is destroyed on every
 * path out of here, the timeout included, so no descriptor outlives the answer. The `error`
 * listener stays attached for the socket's whole life: an error arriving after the answer was
 * given (a destroyed socket can still emit one) would otherwise be an uncaught exception in
 * the extension host.
 *
 * The timer is deliberately NOT unref'd: it is what guarantees an answer when neither event
 * comes, and the caller is awaiting it.
 */
function connectOutcome(socketPath: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    const settle = (outcome: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // already destroyed
      }
      resolve(outcome);
    };
    try {
      socket = net.connect({ path: socketPath });
      socket.on('error', (err) => settle(errnoOf(err) ?? 'unknown'));
      socket.once('connect', () => settle('connected'));
      timer = setTimeout(() => settle('timeout'), SOCKET_PROBE_TIMEOUT_MS);
    } catch {
      // `net.connect` throws synchronously on an address it will not even try
      settle('unknown');
    }
  });
}

/**
 * Is NOBODY LISTENING at the messaging socket an entry of process `pid` names? True only on an
 * answer that establishes it:
 *   - `lstat` says ENOENT: there is nothing at the path. No connect is made.
 *   - a socket IS at the path, it is named exactly `<pid>.sock`, and a connect to it is refused
 *     (ECONNREFUSED): a socket FILE with no process behind it — what a SIGKILLed session leaves
 *     in the socket directory. (ENOENT from the connect — the file went between the two calls
 *     — is the first answer arriving late.)
 * Everything else is false, and keeps the entry.
 *
 * THE PATH IS A STRING OUT OF A FILE, in a directory that other processes write. Connecting to
 * whatever it names would let any file in `sessions/` make this process open a connection to
 * any unix socket on the machine — a database's, an agent's, another user's service. So a
 * connect is made to ONE kind of path only: a socket whose file name is `<pid>.sock` for the
 * very pid the entry belongs to, which is how the CLI names a session's messaging socket
 * (`/tmp/cc-socks/<pid>.sock`, measured on 2.1.292). A socket by any other name is not one this
 * code understands; it is not connected to and the entry is kept. That holds for a dry run
 * exactly as for a real one.
 *
 * Refused before anything is asked of the filesystem, because none of them names a socket that
 * can be asked about: a path that is not absolute (relative to WHAT?), one that holds a NUL,
 * and one longer than a socket address can be.
 *
 * `lstat`, never `stat`: a symlink at the path is not a socket by itself. It is asked BEFORE
 * the connect — that is what keeps a connect from ever being aimed at something that is not a
 * socket — and again after a refusal, because on Linux a regular file answers ECONNREFUSED too
 * and the name could have been replaced in between. Nothing here writes: the socket file is
 * never modified, moved or removed, whatever the answer.
 *
 * What still keeps the entry: a connection that was ACCEPTED (somebody is listening — it is
 * closed at once with nothing sent), EACCES / EPERM (somebody may be, and we are not allowed
 * to ask), ENOTDIR and every other `lstat` failure, a timeout, an unknown error.
 *
 * No failure in here is counted in `errors`: the path lies outside the directory this module
 * is responsible for, and "could not find out" already has its meaning — keep.
 */
async function nobodyListening(socketPath: string, pid: number): Promise<boolean> {
  if (
    !path.isAbsolute(socketPath) ||
    socketPath.includes('\u0000') ||
    Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES
  ) {
    return false;
  }
  try {
    if (!(await fs.promises.lstat(socketPath)).isSocket()) {
      return false;
    }
  } catch (err) {
    return errnoOf(err) === 'ENOENT';
  }
  if (path.basename(socketPath) !== `${pid}.sock`) {
    return false;
  }
  const outcome = await connectOutcome(socketPath);
  if (outcome === 'ENOENT') {
    return true;
  }
  if (outcome !== 'ECONNREFUSED') {
    return false;
  }
  try {
    return (await fs.promises.lstat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

/**
 * Rule (b2): the process behind a socket-carrying entry is provably gone.
 *
 * The pid is asked FIRST and the socket is looked at only when the answer was ESRCH, so a
 * socket whose own process is alive is never even approached. It is asked AGAIN after the
 * probe, because that was awaited and the verdict that matters is the one nearest the unlink.
 * (A pid REUSED by a new session is a different danger with its own guard: that session
 * rewrites `<pid>.json`, and `unlinkJudged` refuses a file that changed.)
 */
async function processProvablyGone(pid: number, socketPath: string): Promise<boolean> {
  return pidIsGone(pid) && (await nobodyListening(socketPath, pid)) && pidIsGone(pid);
}

/**
 * Remove the leaked usage-probe files from `<configDir>/sessions`. See the module header for
 * the predicate; this comment is about the mechanics.
 *
 * - `configDir` must be an absolute path. Anything else — a non-string, an empty or relative
 *   string (which `path.join` would quietly resolve against this process's cwd), a NUL — is
 *   refused with `errors: 1` and nothing is touched.
 * - `<configDir>/sessions` must itself be a real directory. Missing is `scanned: 0`; a
 *   symlink in its place is not followed, because the files behind it are not known to be an
 *   account's sessions.
 * - A key is judged together with its entry: meeting `<pid>.<hex>.key` looks at `<pid>.json`
 *   by name right then, under exactly rules (a)/(b), instead of waiting for the directory
 *   stream to reach it. Directory order is arbitrary, so without this a capped pass strands
 *   every key whose entry lies beyond the cap, and the next pass meets those same keys first.
 *   `scanned` counts entries the directory stream returned, each once.
 * - A key whose entry went in an EARLIER pass is an orphan when it is finally met, so rule (c)
 *   holds it until it is 24 hours old. That is the rule working, not litter being missed: a
 *   pass run once the key is that old removes it.
 * - Invalid option values (NaN, negative, non-numbers) fall back to the defaults. An explicit
 *   `tmpDirs` is used as given, compared by exact string; an empty list switches rule (b) off.
 * - With `dryRun`, `removed` is the number of files a real pass would have unlinked. A dry
 *   run CLASSIFIES exactly as a real pass does, so it makes the same connect attempts for rule
 *   (b2); what it never does is unlink.
 * - `maxMs` is checked before each directory entry is taken. Once it is spent, no new file is
 *   started; the at most PARALLEL files already in hand are finished, and each of those can
 *   wait on at most one connect of SOCKET_PROBE_TIMEOUT_MS — so a pass ends within about half
 *   a second of its budget even if every socket it asks stays silent.
 * - `removed` counts unlink calls that reported success. Two passes racing over ONE directory
 *   (two editor windows) can both be told the same file was theirs — measured on APFS, where
 *   concurrent `unlink` calls on one path can each return success — so their counts can sum to
 *   more than the files that existed. What gets removed is unaffected.
 */
export async function pruneSessionLitter(configDir: string, opts?: LitterOptions): Promise<LitterReport> {
  const report: LitterReport = {
    configDir: typeof configDir === 'string' ? configDir : '',
    scanned: 0,
    removed: 0,
    truncated: false,
    errors: 0,
  };
  try {
    await prune(report, configDir, opts);
  } catch {
    // Nothing below is expected to throw past its own handling; this is the guarantee that an
    // unanticipated one becomes a count instead of a rejected promise in the caller's timer.
    report.errors++;
  }
  return report;
}

async function prune(report: LitterReport, configDir: unknown, opts: unknown): Promise<void> {
  if (typeof configDir !== 'string' || configDir.includes('\u0000') || !path.isAbsolute(configDir)) {
    report.errors++;
    return;
  }
  const o = (opts !== null && typeof opts === 'object' ? opts : {}) as LitterOptions;
  const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();
  const minAgeMs = boundOr(o.minAgeMs, DEFAULT_MIN_AGE_MS);
  const maxFiles = boundOr(o.maxFiles, DEFAULT_MAX_FILES);
  const maxMs = boundOr(o.maxMs, DEFAULT_MAX_MS);
  const dryRun = o.dryRun === true;

  let tmpDirs: string[];
  if (Array.isArray(o.tmpDirs)) {
    tmpDirs = o.tmpDirs.filter((d): d is string => typeof d === 'string' && d !== '');
  } else {
    try {
      tmpDirs = [await fs.promises.realpath(os.tmpdir())];
    } catch {
      // The temp dir cannot be resolved, so no cwd can be recognized as "the probe's": rule (b)
      // matches nothing this pass. Rules (a) and (c) do not depend on it.
      tmpDirs = [];
    }
  }

  const sessionsDir = path.join(configDir, 'sessions');
  let dir: fs.Dir;
  try {
    // lstat, not stat: a symlink standing where the sessions directory should be is refused
    // rather than followed.
    if (!(await fs.promises.lstat(sessionsDir)).isDirectory()) {
      return;
    }
    dir = await fs.promises.opendir(sessionsDir);
  } catch (err) {
    if (!isGone(err)) {
      report.errors++;
    }
    return;
  }

  /** Is this file's mtime more than `ms` in the past? A future or unreadable mtime is not. */
  const olderThan = (st: fs.Stats, ms: number): boolean => {
    const age = now - st.mtimeMs;
    return Number.isFinite(age) && age > ms;
  };

  /**
   * Unlink a file that has just been judged removable — THE one place a file is removed, so
   * the one place the last question is asked: is process `pid`, which the file is named for,
   * gone? Every rule passes through here, and a pid the kernel still knows keeps the file
   * whatever the rule concluded. A dry run asks it too; it only skips the unlink.
   *
   * `judged` is the lstat the judgement was made on. When anything was awaited since (`fresh`
   * false) the name is lstat'ed again and must still be that same unmodified regular file: a
   * pid can be reused, and the entry a new session writes under an old name must not be
   * removed on the old file's verdict. `unlink` itself never follows a symlink and cannot
   * remove a directory.
   */
  const unlinkJudged = async (
    file: string,
    judged: fs.Stats,
    fresh: boolean,
    pid: number,
  ): Promise<EntryFate> => {
    if (!pidIsGone(pid)) {
      return 'kept';
    }
    if (dryRun) {
      report.removed++;
      return 'removed';
    }
    try {
      if (!fresh) {
        const again = await fs.promises.lstat(file);
        if (!again.isFile() || !sameFile(again, judged)) {
          return 'kept';
        }
      }
      await fs.promises.unlink(file);
      report.removed++;
      return 'removed';
    } catch (err) {
      if (isGone(err)) {
        return 'absent';
      }
      report.errors++;
      return 'kept';
    }
  };

  /**
   * Read the whole of a judged entry, or undefined. The fd is opened without following a
   * symlink and then fstat'ed: what is read must be the very file the lstat described, still
   * regular and unchanged — the check is on the open file, so swapping the name afterwards
   * cannot make this read something else.
   */
  const readProven = async (file: string, judged: fs.Stats): Promise<string | undefined> => {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file, READ_FLAGS);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(opened, judged)) {
        return undefined;
      }
      const buf = Buffer.alloc(opened.size);
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await handle.read(buf, off, buf.length - off, off);
        if (bytesRead <= 0) {
          break;
        }
        off += bytesRead;
      }
      // Short of the size the fstat promised: it shrank mid-read, and a prefix is not the file.
      return off === buf.length ? buf.toString('utf8') : undefined;
    } catch (err) {
      // ELOOP / EMLINK is O_NOFOLLOW refusing a symlink that replaced the file after the lstat:
      // not a read failure, just no longer a candidate.
      const code = errnoOf(err);
      if (!isGone(err) && code !== 'ELOOP' && code !== 'EMLINK') {
        report.errors++;
      }
      return undefined;
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // a failed close cannot change what was already read
        }
      }
    }
  };

  /** Rules (a) and (b) for one `<pid>.json`, by name. */
  const judgeEntry = async (name: string): Promise<EntryFate> => {
    // The name FIRST: a file whose name does not say which process it belongs to is not one
    // any rule below can ask the deciding question about.
    const pid = pidOfName(ENTRY_NAME.exec(name)?.[1] ?? '');
    if (pid === undefined) {
      return 'kept';
    }
    const file = path.join(sessionsDir, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(file);
    } catch (err) {
      if (isGone(err)) {
        return 'absent';
      }
      report.errors++;
      return 'kept';
    }
    if (!st.isFile() || !olderThan(st, minAgeMs)) {
      return 'kept';
    }
    if (st.size === 0) {
      // Rule (a). An empty entry says nothing about itself, so the process is all there is to
      // ask: a session that is still running owns its entry however little is in it.
      return unlinkJudged(file, st, true, pid);
    }
    if (st.size > MAX_ENTRY_BYTES) {
      return 'kept';
    }
    const text = await readProven(file, st);
    if (text === undefined) {
      return 'kept';
    }
    const verdict = classifyEntry(text, tmpDirs, pid);
    if (verdict === 'keep') {
      return 'kept';
    }
    // Rule (b2) adds its own proof — nobody listening at the entry's socket — to the one every
    // rule gets in unlinkJudged. Rule (b1) has no socket to ask, and rests on that one.
    if (verdict !== 'litter' && !(await processProvablyGone(pid, verdict.socketPath))) {
      return 'kept';
    }
    return unlinkJudged(file, st, false, pid);
  };

  /** Rule (c) for one `<pid>.<hex>.key`, given what became of its `<pid>.json`. */
  const judgeKey = async (name: string, sibling: EntryFate): Promise<void> => {
    if (sibling === 'kept') {
      return;
    }
    const pid = pidOfName(KEY_NAME.exec(name)?.[1] ?? '');
    if (pid === undefined) {
      return;
    }
    const file = path.join(sessionsDir, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(file);
    } catch (err) {
      if (!isGone(err)) {
        report.errors++;
      }
      return;
    }
    if (!st.isFile() || !olderThan(st, minAgeMs)) {
      return;
    }
    if (sibling === 'absent' && !olderThan(st, ORPHAN_KEY_MIN_AGE_MS)) {
      return;
    }
    await unlinkJudged(file, st, true, pid);
  };

  // Keyed by the `<pid>.json` NAME, and holding the PROMISE of the verdict: an entry is judged
  // exactly once per pass, whether the directory stream reached it first or one of its keys
  // did, and a key that arrives while that judgement is still running waits for the same one.
  const fates = new Map<string, Promise<EntryFate>>();
  const fateOf = (entryName: string): Promise<EntryFate> => {
    let fate = fates.get(entryName);
    if (fate === undefined) {
      fate = judgeEntry(entryName).catch((): EntryFate => {
        report.errors++;
        return 'kept';
      });
      fates.set(entryName, fate);
    }
    return fate;
  };
  // A key name is acted on once per pass even if the directory stream, which is being deleted
  // from underneath, were to return it twice.
  const keysSeen = new Set<string>();

  // Files are judged a few at a time. Each judgement is still its own strictly ordered
  // lstat → read → re-check → unlink; only DIFFERENT files overlap, and the one thing files
  // share — a key's dependence on its entry — goes through `fates`.
  const inFlight = new Set<Promise<void>>();
  const launch = (work: Promise<unknown>): void => {
    const tracked: Promise<void> = work
      .then(
        () => undefined,
        () => {
          report.errors++;
        },
      )
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  const started = performance.now();
  try {
    for (;;) {
      let ent: fs.Dirent | null;
      try {
        ent = await dir.read();
      } catch {
        // The stream itself failed. Not `truncated`: that flag invites the caller to call
        // again, and a directory that cannot be read would fail the same way each time.
        report.errors++;
        break;
      }
      if (ent === null) {
        break;
      }
      // Checked with an entry in hand, so `truncated` is only ever claimed when at least one
      // entry really was left unexamined.
      if (report.scanned >= maxFiles || performance.now() - started >= maxMs) {
        report.truncated = true;
        break;
      }
      report.scanned++;
      if (report.scanned % YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }

      const name: unknown = ent.name;
      if (typeof name !== 'string') {
        continue;
      }
      const isEntry = ENTRY_NAME.test(name);
      const key = isEntry ? null : KEY_NAME.exec(name);
      if (!isEntry && key === null) {
        continue;
      }
      while (inFlight.size >= PARALLEL) {
        await Promise.race(inFlight);
      }
      if (isEntry) {
        launch(fateOf(name));
      } else if (key !== null && !keysSeen.has(name)) {
        keysSeen.add(name);
        launch(fateOf(`${key[1]}.json`).then((sibling) => judgeKey(name, sibling)));
      }
    }
  } finally {
    // Nothing is left running when the report is handed back: the counts are final and no
    // unlink happens after the caller has been told the pass is over.
    await Promise.all(inFlight);
    try {
      await dir.close();
    } catch {
      // already closed
    }
  }
}

/**
 * pruneSessionLitter over several config dirs, one after another — never in parallel, since
 * each pass is already a sustained burst of filesystem work on the host's thread pool.
 *
 * De-duplicated by `path.resolve`: the registry can name one directory twice (a worker that
 * shares the main account's dir, a trailing slash), and a second pass over the same directory
 * is pure cost. The first spelling given is the one that is used and reported. Values that
 * are not strings are not de-duplicated; each is handed on and comes back as a refused report.
 *
 * Never throws. A non-array yields an empty list.
 */
export async function pruneAllSessionLitter(
  configDirs: string[],
  opts?: LitterOptions,
): Promise<LitterReport[]> {
  const reports: LitterReport[] = [];
  if (!Array.isArray(configDirs)) {
    return reports;
  }
  const seen = new Set<string>();
  for (const dir of configDirs) {
    if (typeof dir === 'string') {
      let resolved: string;
      try {
        resolved = path.resolve(dir);
      } catch {
        resolved = dir;
      }
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
    }
    reports.push(await pruneSessionLitter(dir, opts));
  }
  return reports;
}
