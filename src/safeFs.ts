import * as fs from 'fs';

/**
 * safeFs — the ONE owner of "touch a file that an untrusted process may control".
 *
 * WHY THIS FILE EXISTS AS ITS OWN MODULE. A dispatched worker runs with Bash under
 * `bypassPermissions`. It is told its io directory and its config dir, and from those it can
 * derive the extension's task directory and its own task id — so the NAMES this system reads and
 * appends to are names that worker can occupy first. Six hostile review rounds found the same
 * defect four times, and never as a missing idea: the idea was always present at one call site
 * and absent at its siblings. `registry.readResultFile` opened O_NONBLOCK and fstat'ed its own
 * fd; `mesh/transcript.readCapped` fstat'ed its own fd and did NOT open non-blocking;
 * `server.readOutputBody` did neither; `registry.lockIsStale` did neither. Re-spelling a guard
 * at each site is what produces that drift. Owning it in one place is the only thing that ends
 * it.
 *
 * THE TWO CONSEQUENCES THAT WERE ACTUALLY MEASURED, so nobody has to rediscover the stakes:
 *
 *   1. A worker-created FIFO at `tasks/<id>.md` makes `fs.appendFileSync` block FOREVER (opening
 *      a FIFO blocks until the other end appears, and none ever comes). The sweep that writes
 *      that file runs SYNCHRONOUSLY from the extension's `activate()`, so one such file bricks
 *      editor activation permanently — and it hangs after appending the terminal event, leaving
 *      the reconcile lock held, which wedges every other process too.
 *   2. A symlink to `/dev/zero` at a read path crashed the whole process: an unbounded read of an
 *      infinite character device allocates until the heap dies.
 *
 * Both are the same shape — the path is a NAME, not a file — and both are closed here by the
 * same two lines: open non-blocking, then fstat THAT fd and refuse anything that is not a
 * regular file.
 *
 * THIS MODULE IS A LEAF, DELIBERATELY. It imports exactly one thing: the Node builtin `fs`.
 * Nothing from this repo, and in particular not `registry` (which imports it), not `vscode`
 * (which would make it unusable from the standalone MCP server process), and not `path` (which
 * it has no use for — a path is the caller's to build). That is a load-bearing property, not
 * tidiness: `registry.ts`, `mcp/server.ts` and `mesh/transcript.ts` all depend on it, and
 * `registry.ts` is imported by nearly everything, so any import added here becomes an import
 * cycle candidate for the whole tree. Anything that needs an import belongs in a different file.
 *
 * WHAT IT GUARANTEES, and it is narrow and total:
 *
 *   - No call here can block. Every open is non-blocking where the platform has the flag, and
 *     the only thing ever read or written afterwards is a regular file.
 *   - No call here can read or allocate without a bound the CALLER set.
 *   - No call here throws, on any input, including inputs that are not strings.
 *   - Every failure is a NAMED fact, and `absent` is not the same fact as any other. This
 *     codebase has twice been bitten by a swallowed read error reading as "the file was empty" —
 *     once destructively, when a momentary EMFILE made every task look not-running and the
 *     reaper deleted a live task's unread deliverable. A caller that cannot tell "there is no
 *     file" from "I could not read the file" will eventually act on the wrong one, so the type
 *     makes collapsing them require a deliberate `default:` rather than an accident.
 *
 * WHAT IT DOES NOT CLAIM. Nothing about the CONTENT: bytes that came off disk are still
 * untrusted text, and every caller that renders them owes them to `displayText`. Nothing about
 * WHO wrote the file. And nothing about atomicity — an append is an append.
 *
 * `detail` IS COMPOSED ENTIRELY FROM LITERALS IN THIS FILE plus a validated errno code and
 * numbers this module computed. It never contains the path and never contains a byte of the
 * file, because callers put it into `mesh error [...]` strings and into `dispatch_status` output
 * that an orchestrating MODEL parses, and a detail string carrying attacker bytes would make
 * this module a smuggling channel of its own. (Callers that DO want to name the path — see
 * `server.readOutputBody` — flatten it themselves through `displayText` first.)
 */

/**
 * Why a read produced no text. Four facts, not one, and the split is the point of the type.
 *
 *   - `absent`     — the filesystem said ENOENT: there is nothing at this path. The ONLY code
 *                    that produces this. A dangling symlink lands here too, correctly: its
 *                    target does not exist.
 *   - `not-a-file` — something is there and it is a directory, FIFO, socket or device. This is
 *                    the hostile case: a name occupied by a thing that is not a file.
 *   - `too-large`  — a regular file past the caller's cap. Refused, never truncated.
 *   - `unreadable` — everything else, and it means IGNORANCE, never absence: EACCES on a file
 *                    someone chmod'ed, EMFILE under fd pressure, EIO on a failing disk, ENOTDIR
 *                    on a broken path, a caller argument that was not a usable path at all.
 *
 * A fifth, which only a caller that ASKED for a strict read can be given (`strictUtf8`):
 *
 *   - `not-utf8`   — a regular file within the cap whose bytes are not valid UTF-8: the text
 *                    they decode to would not encode back to the same bytes.
 */
export type SafeReadFailure = 'absent' | 'not-a-file' | 'too-large' | 'unreadable' | 'not-utf8';

/**
 * The result of one read. `bytes` is what was actually read and decoded, so `ok && bytes === 0`
 * is the honest answer for a zero-length regular file — a real, observed state (a session that
 * registered and wrote nothing) that must NOT be reported as a failure, or the empty/absent
 * confusion this module exists to prevent comes back through the front door.
 */
export type SafeRead =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: SafeReadFailure; detail: string };

/**
 * Open flags for every read here: read-only, and NON-BLOCKING where the platform has the flag.
 *
 * PREVENTS: the verified permanent brick. Nothing guarantees the thing at a caller's path is a
 * file; a worker with a shell can `mkfifo` it, and opening a FIFO for reading blocks until a
 * writer appears — forever, if none ever does. The callers of this module run inside a
 * SYNCHRONOUS reconcile sweep reached from the extension host's `activate()` and from the MCP
 * server's `dispatch_status`, so one such file wedges editor activation and holds the reconcile
 * lock while it does. Opening non-blocking returns immediately even on a writer-less FIFO, and
 * the fstat below then refuses it for not being a regular file. On a regular file the flag is a
 * no-op.
 *
 * O_NOCTTY is in here for the same family of reason: a character device at the path could
 * otherwise become this process's controlling terminal merely by being opened.
 *
 * WINDOWS DEGRADES, DELIBERATELY, AND THIS COMMENT IS THE HONEST STATEMENT OF IT: win32 defines
 * neither O_NONBLOCK nor O_NOCTTY, so on that platform this is a plain O_RDONLY and the
 * non-blocking guarantee IS NOT GIVEN. What still holds there is the fstat-and-refuse check
 * below, which is what rejects the device and the directory. What does not hold is the FIFO
 * defence — mitigated only by the fact that a Windows named pipe lives in the `\\.\pipe\`
 * namespace and cannot be created inside a task directory, so the exact measured attack has no
 * Windows spelling. That is a mitigation, not a guarantee, and it is stated here rather than
 * implied by silence.
 *
 * Written as an explicit `typeof` test rather than `?? 0` because an undefined constant folded
 * into a bitwise OR becomes NaN, i.e. an unopenable flag set — a self-inflicted total outage.
 */
const READ_ONLY_NONBLOCK =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

/**
 * Whether this platform can refuse a symbolic link IN THE OPEN ITSELF. win32 defines no
 * O_NOFOLLOW; there a `noFollow` read falls back to looking at the name first (see
 * readTextSafe), which is a check and not a guarantee.
 */
const HAS_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number';

/**
 * READ_ONLY_NONBLOCK that additionally will not follow a symbolic link at the FINAL component
 * of the path: the kernel refuses the open (ELOOP; EMLINK on some BSDs) instead of opening
 * whatever the link names. Used only for a read that asked for `noFollow`.
 *
 * NOT THE DEFAULT, deliberately. Most paths this module reads are files a person may keep as a
 * symbolic link on purpose — a registry.json or a settings file linked into a dotfiles
 * repository — and refusing those would break a working setup to defend a path nobody
 * attacks through. It is for the caller whose path is a NAME IT BUILT ITSELF inside a
 * directory this product owns, where a link can only be something put there to make that name
 * mean a file somewhere else.
 */
const READ_ONLY_NONBLOCK_NOFOLLOW =
  READ_ONLY_NONBLOCK | (HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

/** What a `noFollow` read says about a symbolic link at its path. Literals only. */
const REFUSED_SYMLINK = 'the path is a symbolic link, and this read does not follow one';

/** Whether a symbolic link is at `file` right now. `lstat`, so the link itself is asked. */
function isSymbolicLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** How readTextSafe is asked to read. Every member is optional; absent means the default. */
export interface SafeReadOptions {
  /**
   * `true`: a symbolic link at the FINAL component of the path is refused (`not-a-file`), never
   * followed — the read is of the file that IS at this name, or of nothing. Default `false`:
   * a link is followed, as every ordinary read follows one. A link in a DIRECTORY component of
   * the path is followed either way.
   */
  noFollow?: boolean;
  /**
   * `true`: the read is LOSSLESS or it is refused. Decoding replaces every byte sequence that
   * is not UTF-8 with U+FFFD, so text read from a Latin-1, EUC-KR or UTF-16 file and written
   * back is another file. A caller that will write the text back — an installer that puts a
   * block into the user's own document — asks for this, and a file whose bytes are not exactly
   * what its text encodes to is `not-utf8` instead of text. A byte-order mark and NUL bytes
   * are valid UTF-8 and are read as they are. Default `false`: the read every other caller
   * has always had, for values that are only shown or parsed.
   */
  strictUtf8?: boolean;
}

/**
 * Open flags for every append here: write-only, append-only, create-if-absent — and the SAME
 * non-blocking treatment, for the same measured reason on the write side.
 *
 * PREVENTS: the FIFO that bricked `activate()`. `fs.appendFileSync` on a worker-created FIFO
 * blocks until a READER appears. Opening O_WRONLY | O_NONBLOCK on a reader-less FIFO fails
 * immediately with ENXIO instead (classified below as `not-a-file`, which is exactly what it
 * proves), and a FIFO that does have a reader opens but is then refused by the fstat.
 *
 * O_APPEND rather than a seek: it is what makes each write land at the end of the file as one
 * operation, so two processes appending concurrently interleave whole writes rather than
 * overwriting each other. That is the property `appendFileSync` had and that this must not lose.
 *
 * The create mode is 0o666 — Node's own `appendFileSync` default, umask-masked by the kernel —
 * because these files are read by the user's own editor and CLI, and quietly tightening the mode
 * of an existing product's files is a behaviour change that belongs to nobody's task. A tighter
 * mode would buy nothing anyway: the untrusted writer here runs as the same user.
 */
const APPEND_ONLY_NONBLOCK =
  fs.constants.O_WRONLY |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
  (typeof fs.constants.O_NOCTTY === 'number' ? fs.constants.O_NOCTTY : 0);

const CREATE_MODE = 0o666;

/**
 * An errno code we are willing to quote into a `detail` string.
 *
 * PREVENTS: this module becoming the smuggling channel it was written to close. `detail` is
 * relayed to a human and to an orchestrating model, and `err.code` is only conventionally a
 * Node errno — the value is whatever the throwing object carries, and a `catch` sees objects
 * this module did not create. Shape-checking it against the errno alphabet costs one regex and
 * means no byte of foreign text can ride out of here.
 *
 * MEASURED, so this is not a hypothetical: opening a unix socket on macOS 14 throws with
 * `code === "Unknown system error -102"` and a `message` that quotes the PATH. Without this
 * check that whole string, path included, would have been interpolated into `detail` and handed
 * to an orchestrating model.
 */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** The errno code of a caught value, if it looks like one, else undefined. */
function errnoCode(err: unknown): string | undefined {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERRNO_CODE.test(code) ? code : undefined;
}

/**
 * Turn a caught value into a named failure.
 *
 * ENOENT IS THE ONLY CODE THAT BECOMES `absent`, and that is a deliberate refusal to guess.
 * ENOTDIR ("a component of the path is not a directory") also means the file cannot exist, but
 * it means the path is BROKEN, which is a different operational fact from a fresh install that
 * has simply never dispatched anything — and callers act on the second by carrying on and on the
 * first by reporting. EISDIR and ENXIO are mapped to `not-a-file` because that is precisely what
 * they prove: EISDIR is a directory (the platforms that refuse to open one at all report it here
 * rather than at the fstat), and ENXIO on a write open is a FIFO with no reader or a device node
 * with no device.
 *
 * AND WHEN THE PLATFORM HAS NO NAME FOR THE FAILURE, THE FILESYSTEM IS ASKED INSTEAD OF GUESSED.
 * The errno alphabet is not portable: a unix SOCKET at the path fails to open with EOPNOTSUPP,
 * which libuv does not name, so `err.code` comes back as the free text
 * `"Unknown system error -102"` (measured on macOS 14) and the code check below correctly
 * refuses to quote it. Falling through to `unreadable` there would make this type's promise
 * platform-dependent — the doc says a socket is `not-a-file`, and on one platform it would not
 * be. So an unrecognised failure gets one `statSync`, purely to NAME what is at the path, and is
 * upgraded to `not-a-file` only if the filesystem positively reports something non-regular. That
 * is not a TOCTOU: nothing is read either way, the call has already failed, and the only thing
 * being decided is which true sentence to return. If the stat says "a regular file", or says
 * nothing at all, the answer stays `unreadable` — ignorance is never upgraded to a claim.
 *
 * Everything else is ignorance, and says so.
 */
function nonRegularKind(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? undefined : fileKind(st);
  } catch {
    // The path vanished, or cannot be stat'ed either. No new fact, so no new claim.
    return undefined;
  }
}

function classify(err: unknown, file: string): { reason: SafeReadFailure; detail: string } {
  const code = errnoCode(err);
  if (code === 'ENOENT') {
    return { reason: 'absent', detail: 'there is nothing at this path (ENOENT)' };
  }
  if (code === 'EISDIR') {
    return { reason: 'not-a-file', detail: 'the path is a directory (EISDIR)' };
  }
  if (code === 'ENXIO') {
    return {
      reason: 'not-a-file',
      detail: 'the path is a pipe with no reader or a device with no device (ENXIO)',
    };
  }
  const kind = nonRegularKind(file);
  if (kind !== undefined) {
    return { reason: 'not-a-file', detail: `the path is ${kind}` };
  }
  return {
    reason: 'unreadable',
    detail: code === undefined ? 'the operation failed' : `the operation failed (${code})`,
  };
}

/**
 * What the thing at the path actually is, for the `not-a-file` detail. Literals only.
 *
 * `isSymbolicLink` can never be true for an `fstat` of an open fd (opening follows the link) nor
 * for `statSync` (which follows it too); it is listed so that a future reader who switches either
 * call to `lstat` gets a correct message instead of "something else".
 */
function fileKind(st: fs.Stats): string {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  if (st.isCharacterDevice()) {
    return 'a character device';
  }
  if (st.isBlockDevice()) {
    return 'a block device';
  }
  if (st.isSymbolicLink()) {
    return 'a symbolic link';
  }
  return 'something other than a regular file';
}

/**
 * Whether `file` is a value we are willing to hand to `fs`, and if not, why.
 *
 * PREVENTS: a throw, and a lie. `fs.openSync` throws TypeError on a non-string and
 * ERR_INVALID_ARG_VALUE on a string containing a NUL — neither is an errno, so both would fall
 * through the classifier as a bare `unreadable` with a useless detail. Worse, an empty string
 * reaches the filesystem and comes back ENOENT, which this module would then report as
 * `absent` — asserting a fact about a file the caller never named. A caller bug must not be
 * laundered into a filesystem observation.
 *
 * The NUL check is not decoration: a path is handed to a C API, where a NUL ends the string, so
 * a value shaped like `/safe/dir/x<NUL>/../../etc/passwd` is the classic truncation trick. Node
 * rejects it; this names it.
 */
function pathProblem(file: unknown): string | undefined {
  if (typeof file !== 'string') {
    return 'the path given is not a string';
  }
  if (file === '') {
    return 'the path given is empty';
  }
  if (file.includes('\u0000')) {
    return 'the path given contains a NUL byte';
  }
  return undefined;
}

/**
 * Close an fd we opened, never letting the close itself become the failure.
 *
 * PREVENTS: an fd leak, which under repetition is EMFILE — and EMFILE in this codebase is not a
 * slowdown, it is the condition that once made every task look not-running and cost a live
 * task's deliverable. Every path out of every function below goes through a `finally` that calls
 * this.
 */
function closeQuietly(fd: number): void {
  if (fd === -1) {
    return;
  }
  try {
    fs.closeSync(fd);
  } catch {
    // Closing an fd we hold cannot lose data that was written with writeSync, and a failure here
    // must not replace the caller's real result with a false one.
  }
}

/**
 * Read a whole regular file as UTF-8 text, or say why there is no text. Never throws.
 *
 * `maxBytes` is the caller's ceiling and there is NO default, on purpose: the right cap for a
 * 40-byte lock token, a 1 MiB result record and a 64 MiB transcript are three different numbers,
 * and a shared default is how one of them silently becomes wrong.
 *
 * TOO LARGE IS REFUSED, NEVER TRUNCATED, and that is the whole reason the cap is checked before
 * the read rather than used as a read length. PREVENTS: a corruption report for a size problem.
 * A truncated JSON document does not parse and a half-read log ends mid-record, so a caller that
 * received the first `maxBytes` bytes reports "this file is corrupt" about a file that is
 * perfectly well-formed and merely bigger than it expected — and, for the ledger, "corrupt"
 * means "ignore these records", i.e. silent data loss. A refusal is a fact the caller can act
 * on; a prefix is a lie it cannot detect.
 *
 * `options.strictUtf8` (see SafeReadOptions) refuses a file that would not survive being
 * written back from its text (`not-utf8`); without it nothing here changes.
 *
 * `options.noFollow` (see SafeReadOptions) makes a symbolic link at the path a `not-a-file`
 * refusal instead of a way to some other file. Where the platform has O_NOFOLLOW the refusal
 * is the kernel's, made in the same call that opens the file, so there is no moment between a
 * check and the open in which the name could be swapped; the fstat below then still proves the
 * thing opened is a regular file. Where it has not (win32) the name is `lstat`ed first — the
 * best that platform offers, and the same declared gap as its missing O_NONBLOCK. Even a
 * DANGLING link is `not-a-file` under `noFollow`: something is at the name, and it is a link.
 */
export function readTextSafe(
  file: string,
  maxBytes: number,
  options?: SafeReadOptions,
): SafeRead {
  const bad = pathProblem(file);
  if (bad !== undefined) {
    return { ok: false, reason: 'unreadable', detail: bad };
  }
  // By VALUE: only the literal `true` asks for it. An options value of the wrong type — a
  // string, a number, null — is the default read, never a throw.
  const noFollow =
    typeof options === 'object' && options !== null && options.noFollow === true;
  const strictUtf8 =
    typeof options === 'object' && options !== null && options.strictUtf8 === true;
  // A cap that is not a usable byte count is REFUSED rather than defaulted. PREVENTS: an
  // unbounded read from a typo. `size > NaN` and `size > undefined` are both false, so a
  // malformed cap folded straight into the comparison below would quietly disable the ceiling —
  // and the ceiling is the only thing standing between this call and the /dev/zero-shaped
  // failure it exists to prevent. Zero is legitimate and means "nothing may be read but an empty
  // file"; a fractional cap floors.
  const cap =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0
      ? Math.floor(maxBytes)
      : -1;
  if (cap < 0) {
    return { ok: false, reason: 'unreadable', detail: 'the read cap is not a usable byte count' };
  }

  let fd = -1;
  try {
    if (noFollow && !HAS_O_NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) {
      return { ok: false, reason: 'not-a-file', detail: REFUSED_SYMLINK };
    }
    fd = fs.openSync(file, noFollow ? READ_ONLY_NONBLOCK_NOFOLLOW : READ_ONLY_NONBLOCK);
    // FSTAT THE SAME fd, never stat-then-open. PREVENTS: a TOCTOU the file wins. Between a
    // `statSync` and an `openSync` the path can be replaced — the check would describe the decoy
    // and the read would consume the replacement — and the writer here is a process that can
    // retry the swap in a loop until it lands. An fstat asks the OPEN FILE what it is, so the
    // thing measured and the thing read are the same object no matter what happens to the name
    // afterwards.
    const st = fs.fstatSync(fd);
    // REFUSE ANYTHING THAT IS NOT A REGULAR FILE. PREVENTS: the /dev/zero crash and the FIFO
    // hang, and it is the check that has to be here rather than at the open, because a symlink
    // to a device opens exactly like a file and only its fstat gives it away.
    if (!st.isFile()) {
      return { ok: false, reason: 'not-a-file', detail: `the path is ${fileKind(st)}` };
    }
    const size = st.size;
    if (!Number.isFinite(size) || size < 0) {
      return { ok: false, reason: 'unreadable', detail: 'the file reports no usable size' };
    }
    if (size > cap) {
      return {
        ok: false,
        reason: 'too-large',
        detail:
          `the file is ${size} bytes, past the ${cap}-byte read cap, and was refused rather ` +
          `than truncated`,
      };
    }
    if (size === 0) {
      // A zero-length regular file is a SUCCESS carrying no bytes, not a failure. PREVENTS the
      // exact confusion this module's type exists to prevent: reporting empty-as-failure would
      // make `absent` and `empty` indistinguishable again for every caller that only checks
      // `ok`. Callers that care test `bytes === 0`.
      return { ok: true, text: '', bytes: 0 };
    }
    // Buffer.alloc, not allocUnsafe: zero-filled. PREVENTS handing back whatever was previously
    // in that memory if any read below returns short. The short-read refusal makes that
    // unreachable today, but a memory-disclosure property must not depend on a control-flow
    // property two screens away.
    const buf = Buffer.alloc(size);
    let read = 0;
    // LOOP ON SHORT READS. PREVENTS: a legitimate file silently lost. `readSync` is allowed to
    // return fewer bytes than asked for — it is a single `pread`, and large reads, signals and
    // network filesystems all shorten it — and a single-call reader hands back a prefix that the
    // caller then reports as unparseable. That is a legitimate file reported as corrupt, which is
    // worse than either a refusal or a retry. One sibling reader in this repo looped and another
    // did not; that inconsistency is why this loop lives in one place now. The explicit
    // `position` argument makes each call a pread from a known offset, so the loop does not
    // depend on the fd's cursor.
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    if (read < size) {
      // EOF before the size the fstat promised: the file SHRANK while it was being read, so what
      // we hold is a prefix of a file that no longer exists in that form. Refused for the same
      // reason `too-large` is refused — a half record read as data is worse than a named failure
      // the caller can retry. (Growth is harmless and needs no case: we read exactly the size we
      // measured, and the bytes past it are simply not ours yet.)
      return {
        ok: false,
        reason: 'unreadable',
        detail: `the file shrank while it was being read (${read} of ${size} bytes)`,
      };
    }
    // Decoding never throws: invalid UTF-8 becomes U+FFFD. A buffer past V8's maximum string
    // length does throw, and lands in the catch as `unreadable` — which is why the caller's cap
    // is the real defence and this is only the backstop.
    const text = buf.toString('utf8');
    // The strict read is decided by the property its caller needs, not by a decoder's opinion:
    // the text must encode back to the bytes that were read. That holds for exactly the valid
    // UTF-8 files (a replacement character re-encodes to three bytes of its own).
    if (strictUtf8 && !Buffer.from(text, 'utf8').equals(buf)) {
      return {
        ok: false,
        reason: 'not-utf8',
        detail: 'the file is not valid UTF-8 text, so it cannot be read and written back byte for byte',
      };
    }
    return { ok: true, text, bytes: read };
  } catch (err) {
    // O_NOFOLLOW refusing a symbolic link is ELOOP (EMLINK on some BSDs). Named here, before
    // the general classifier, because that one would `stat` the path — which FOLLOWS the link —
    // and call a link to a regular file merely `unreadable`. Under `noFollow` the link itself
    // is the fact. The same code also means a genuine loop of links in a DIRECTORY component,
    // so the name is asked what it is: only a link AT the path gets this answer, and anything
    // else stays with the classifier.
    const code = errnoCode(err);
    if (noFollow && fd === -1 && (code === 'ELOOP' || code === 'EMLINK') && isSymbolicLink(file)) {
      return { ok: false, reason: 'not-a-file', detail: REFUSED_SYMLINK };
    }
    return { ok: false, ...classify(err, file) };
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Append text to a regular file, creating it if absent. Never throws.
 *
 * Reuses `SafeReadFailure` because the failures ARE the same failures — the path is the hostile
 * thing, not the direction of travel. Two notes on the vocabulary here:
 *
 *   - `absent` on an append means the PARENT DIRECTORY does not exist (the file itself is
 *     created). Callers that own the directory should call their own `ensureDirs()` first; this
 *     module deliberately creates no directories, because silently materialising a tree is how a
 *     typo'd path becomes a real one.
 *   - `too-large` is never returned. How big a file may get before a caller stops appending to
 *     it is that caller's policy, and inventing one here would silently stop the ledger.
 *
 * BEST-EFFORT REMAINS THE CALLER'S CHOICE. This returns a result; it does not decide whether
 * failing to append is fatal. `registry.appendOutputNote` swallows it; `appendTaskEvent` must
 * not.
 */
export function appendTextSafe(
  file: string,
  text: string,
): { ok: boolean; reason?: SafeReadFailure; detail?: string } {
  const bad = pathProblem(file);
  if (bad !== undefined) {
    return { ok: false, reason: 'unreadable', detail: bad };
  }
  // A non-string payload is REFUSED rather than coerced. PREVENTS: `[object Object]` and
  // `undefined` becoming permanent lines of an append-only ledger. `String(x)` can also throw (a
  // null-prototype object, a throwing `toString`, a Proxy), so coercing here would reopen the
  // throw this function promises never to do.
  if (typeof text !== 'string') {
    return { ok: false, reason: 'unreadable', detail: 'the text to append is not a string' };
  }

  let fd = -1;
  try {
    fd = fs.openSync(file, APPEND_ONLY_NONBLOCK, CREATE_MODE);
    // FSTAT THE SAME fd — the same TOCTOU refusal as on the read path, and it matters more here:
    // a check that passed on a decoy and a write that landed in the replacement is how a guarded
    // append still ends up writing into a pipe. PREVENTS the measured `activate()` brick together
    // with the O_NONBLOCK above: the flag is what lets us reach this line at all on a FIFO that
    // has a reader, and this line is what refuses to write to it.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, reason: 'not-a-file', detail: `the path is ${fileKind(st)}` };
    }
    const buf = Buffer.from(text, 'utf8');
    let written = 0;
    // LOOP ON SHORT WRITES, the mirror of the read loop and for the mirror reason: `writeSync`
    // may write fewer bytes than it was given, and a single-call writer silently truncates the
    // record. PREVENTS: a torn ledger line — which this codebase has already paid for once, as a
    // task that had settled reading as though it never had and settling a second time.
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) {
        break;
      }
      written += n;
    }
    if (written < buf.length) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `only ${written} of ${buf.length} bytes could be appended`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, ...classify(err, file) };
  } finally {
    closeQuietly(fd);
  }
}

/**
 * The size and mtime of a REGULAR FILE at `file`, or undefined. Never throws.
 *
 * Undefined means all of: nothing is there, something is there that is not a regular file, or it
 * could not be stat'ed. That collapse is deliberate and is the one place in this module where it
 * is right: the callers ask this question to decide whether a lock looks abandoned, and every one
 * of those answers sends them down the same branch. The moment a caller needs to tell those
 * apart, it wants `readTextSafe`, which does.
 *
 * THE REGULAR-FILE CHECK IS HERE TOO, and that is the entire lesson of this module applied to its
 * third entry point. PREVENTS the sibling-hole defect: a `statFileSafe` that answered for a FIFO
 * or a device would hand a caller a size and an mtime for a thing that is not a file, and the
 * caller — having "checked" — would then treat it as one.
 *
 * IT DOES NOT OPEN, and this asymmetry with the two functions above is deliberate rather than an
 * oversight. `statSync` does not block on a FIFO (only `open` does), so there is nothing to
 * defend against with O_NONBLOCK here, while opening would consume an fd and would refuse a file
 * that can be stat'ed but not read (mode 000), which would change lock ageing for no gain. The
 * consequence, stated plainly: this is ADVISORY. Its answer describes the path at the instant it
 * was asked and can be stale by the time the caller acts. Nothing may be enforced with it —
 * enforcement lives on the fd inside `readTextSafe` and `appendTextSafe`, where the thing
 * measured is the thing used.
 */
export function statFileSafe(file: string): { size: number; mtimeMs: number } | undefined {
  if (pathProblem(file) !== undefined) {
    return undefined;
  }
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) {
      return undefined;
    }
    // Both numbers are validated before they leave. PREVENTS a NaN age comparison reading as "not
    // stale" forever: `Date.now() - NaN > LOCK_STALE_MS` is false, so a filesystem that reports no
    // usable mtime would make every lock immortal. Undefined sends the caller to the branch it
    // already has for "cannot tell".
    if (!Number.isFinite(st.size) || !Number.isFinite(st.mtimeMs)) {
      return undefined;
    }
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}
