#!/usr/bin/env node
// models-reader.cjs — the bounded task-log reader (registry.latestTaskEventOf) in a process of
// its own, for .orchestrator/fixes/models.mjs. The test starts it with HOME redirected, so the
// task log it writes and reads is that sandbox's.
//
//   node models-reader.cjs equiv   <core bundle> <logs> <seed>
//       Writes <logs> random task logs, one after another, and for every one of them asks both
//       readers about a fixed set of ids. Prints one JSON line: the tallies and the mismatches.
//   node models-reader.cjs costlog <core bundle> <id>
//       Writes a 61 MiB log whose events of <id> all lie in its last 1 MiB.
//   node --expose-gc models-reader.cjs cost <core bundle> <id> bounded|full|close
//       One call, measured: `bounded` = latestTaskEventOf(id), `full` = latestEventByIdChecked(id),
//       `close` = appendTerminalTaskEvent of a `done` for <id> (the lock, the read and the append).
//       Every byte the call reads through fs.readSync is counted (fs is patched BEFORE the bundle
//       is loaded), and whole-file reads are counted apart. Prints one JSON line.
//   node models-reader.cjs transcript <core bundle> <configDir> <jobId>
//       One transcript.sessionModelOf call, with every byte it reads through fs.readSync counted
//       (fs patched before the bundle is loaded, as for `cost`). Prints one JSON line.
//   node models-reader.cjs hold    <core bundle> <id> <ms> [event json]
//       Takes <id>'s reconcile lock (the one closeTaskOnce takes), prints `held`, keeps it <ms>,
//       releases it, then — given an event — appends it as a terminal event and prints the result.

'use strict';

const fs = require('fs');
const path = require('path');

const [mode, bundle, ...rest] = process.argv.slice(2);

let bytesRead = 0;
let readCalls = 0;
let wholeReads = 0;
if (mode === 'cost' || mode === 'transcript') {
  const readSync = fs.readSync;
  fs.readSync = function countedReadSync(...args) {
    const n = readSync.apply(this, args);
    bytesRead += n;
    readCalls++;
    return n;
  };
  for (const name of ['readFileSync', 'readFile', 'createReadStream']) {
    const real = fs[name];
    fs[name] = function countedWholeRead(...args) {
      wholeReads++;
      return real.apply(this, args);
    };
  }
}

const core = require(bundle);
const reg = core.registry;
const isCounted = core.ranAs.isCountedTaskEvent;
const LOG = reg.TASKS_LOG_FILE;
const CHUNK = 64 * 1024;
const LINE_MAX = 32 * 1024 - 1;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/* ------------------------------------------------------------------------- *
 * equiv
 * ------------------------------------------------------------------------- */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function equiv(count, seed) {
  const R = rng(seed);
  const int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const chance = (p) => R() < p;

  // `t` is a prefix of every other t-id, `t1` of `t1a`, and so on: a line of the longer id holds
  // the shorter one's bytes.
  const ASKED = ['t', 't1', 't1a', 't1a2', 't1a2b', 'tA_b-9', 'Q'.repeat(128)];
  const FILLER = ['zz9', 'f0', 'f1', 'f2', 'f3'];
  // Asked as well: an id with no line, and ids no admitted event can carry.
  const ASKS = [...ASKED, 'tabsent', 'bad id', '', 'Q'.repeat(129)];
  const TEXT = ['', 'hello', 'naïve café', '日本語のタイトル', 'emoji 🎉🎉', 'quote " and \\ backslash', 'tab\tand\u0001ctl', 't1a2 mention', ' sep', 'esc \u001b[31mred'];

  let serial = 0;
  const event = (id, extra = {}) => ({
    id,
    ts: int(1, 2e12),
    status: pick(['running', 'done', 'error']),
    worker: pick(['wa', 'wb', 'wc']),
    n: ++serial,
    ...(chance(0.5) ? { title: pick(TEXT) } : {}),
    ...extra,
  });
  /** An event line of exactly `target` bytes; `big` says whether that is past the clamp. */
  const padded = (obj, target) => {
    const big = target > LINE_MAX;
    const bare = Buffer.byteLength(JSON.stringify({ ...obj, big, pad: '' }));
    return target < bare ? undefined : JSON.stringify({ ...obj, big, pad: 'p'.repeat(target - bare) });
  };
  const small = (id) => JSON.stringify({ ...event(id), big: false, ...(chance(0.3) ? { pad: 'p'.repeat(int(0, 3000)) } : {}) });
  const escapeAll = (text) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const garbage = (len, withId) => {
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      let v = int(0, 255);
      if (v === 0x0a) v = 0x0b;
      b[i] = v;
    }
    if (withId !== undefined && len > withId.length + 2) {
      b.write(withId, int(0, len - withId.length - 1), 'latin1');
    }
    return b;
  };

  const tally = {
    logs: 0, asks: 0, bytes: 0, logsOver64KiB: 0, logsOver1MiB: 0, with5MiBLine: 0, withTrailingHalf: 0, withBom: 0, aligned: 0,
    answersEvent: 0, answersNone: 0, answersUnreadable: 0, answersStraddlingAChunk: 0, answersInLastLine: 0,
    answersFromEscapedLine: 0, answersFromDuplicateKeyLine: 0, answersPastAPrefixDecoy: 0, answersPastALongLine: 0,
    rawFullReaderDiffers: 0,
  };
  const mismatches = [];
  let mismatchCount = 0;
  const keepDir = path.join(path.dirname(LOG), 'mismatch');

  for (let logIndex = 0; logIndex < count; logIndex++) {
    // Line contents (Buffers); offsets and the `n` → line map follow from them.
    const lines = [];
    const add = (content) => lines.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    const size = pick([0, 1, 3, 10, 40, 80, 150, 250, 400]);
    for (let i = 0; i < size; i++) {
      const id = pick(ASKED);
      const r = R();
      if (r < 0.28) add(small(id));
      else if (r < 0.52) add(small(pick(FILLER)));
      else if (r < 0.57) {
        // Objects that are no admitted event, under an asked id.
        add(pick([
          () => JSON.stringify({ ...event(id), status: 'weird' }),
          () => JSON.stringify({ ...event(id), ts: 0 }),
          () => JSON.stringify({ ...event(id), ts: -5 }),
          () => JSON.stringify({ ...event(id), ts: 8.64e15 + 1 }),
          () => JSON.stringify({ ...event(id), ts: '5' }),
          () => JSON.stringify({ id, worker: 'wa', n: ++serial }),
          () => JSON.stringify({ ...event(id), id: `${id} x` }),
          () => JSON.stringify({ ...event(id), id: 7 }),
        ])());
      } else if (r < 0.61) {
        // The id (and sometimes the key) spelled through \u escapes: no raw bytes of the id.
        const e = event(id, { esc: 1 });
        const text = JSON.stringify(e).replace(`"id":${JSON.stringify(id)}`, `"${chance(0.5) ? escapeAll('id') : 'id'}":"${escapeAll(id)}"`);
        add(text);
      } else if (r < 0.64) {
        // Two `id` keys: JSON.parse keeps the last.
        const other = pick([...ASKED, ...FILLER]);
        add(JSON.stringify(event(id, { dup: 1 })).replace(/}$/, `,"id":${JSON.stringify(other)}}`));
      } else if (r < 0.68) add(JSON.stringify({ ...event(pick(FILLER)), note: `${id} and ${pick(ASKED)}` }));
      else if (r < 0.71) add(pick(['null', '42', `"${id}"`, `[${JSON.stringify(event(id))}]`, 'true', '{}']));
      else if (r < 0.75) {
        const whole = small(id);
        add(whole.slice(0, int(1, whole.length - 1)));
      } else if (r < 0.78) add(garbage(int(1, 600), chance(0.6) ? id : undefined));
      else if (r < 0.81) {
        // Invalid UTF-8 inside a string of an otherwise whole event.
        const head = Buffer.from(JSON.stringify(event(id, { big: false })).replace(/}$/, ',"s":"'), 'utf8');
        add(Buffer.concat([head, Buffer.from(pick([[0xff], [0xc3], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xed, 0xa0, 0x80], [0xc0, 0xaf]])), Buffer.from('x"}')]));
      } else if (r < 0.85) add(pick(['', ' ', '   ', '\r', '\t', ' \r']));
      else if (r < 0.88) add(`${small(id)}\r`);
      else if (r < 0.90) add(padded(event(id), int(LINE_MAX + 1, 70_000)));
      else if (r < 0.92) add(padded(event(id), pick([LINE_MAX - 1, LINE_MAX, LINE_MAX + 1, LINE_MAX + 2])));
      else add(small(pick(FILLER)));
    }
    if (logIndex % 40 === 7) {
      // A 5 MiB line — an event of an asked id, or garbage — at the start, the middle or the end.
      const big = chance(0.5) ? Buffer.from(padded(event(pick(ASKED)), 5 * 1024 * 1024)) : garbage(5 * 1024 * 1024, pick(ASKED));
      lines.splice(pick([0, lines.length >> 1, lines.length]), 0, big);
      tally.with5MiBLine++;
    }
    const bom = logIndex % 50 === 3;
    // Where the lines start, and so where each `n` lies.
    const offsets = [];
    let at = bom ? 3 : 0;
    for (const line of lines) {
      offsets.push(at);
      at += line.length + 1;
    }
    let tail = Buffer.alloc(0);
    if (lines.length > 0 && chance(0.5)) {
      // A line — one of the last ten half the time, where answers mostly are — with a filler line
      // after it sized so that a chunk boundary falls at its start, inside it, or at its line feed.
      const i = chance(0.5) ? int(0, lines.length - 1) : Math.max(0, lines.length - 1 - int(0, 9));
      const a = offsets[i];
      const b = a + lines[i].length;
      const B = Math.max(0, Math.min(at, pick([a - 1, a, a + 1, (a + b) >> 1, b - 1, b, b + 1])));
      let L = B + CHUNK - at - 1;
      while (L < 0) L += CHUNK;
      const filler = L <= LINE_MAX ? padded(event(pick(FILLER)), L) : undefined;
      tail = filler !== undefined ? Buffer.from(filler) : Buffer.alloc(L, 'z');
      offsets.push(at);
      lines.push(tail);
      at += tail.length + 1;
      tally.aligned++;
    }
    // The end of the log: a line feed, or a last line without one — a torn event or a whole one.
    let trailing = Buffer.alloc(0);
    if (chance(0.2)) {
      const whole = small(pick(ASKED));
      trailing = Buffer.from(chance(0.5) ? whole : whole.slice(0, int(1, whole.length - 1)));
      offsets.push(at);
      lines.push(trailing);
      tally.withTrailingHalf++;
    }
    const parts = [];
    if (bom) {
      parts.push(Buffer.from([0xef, 0xbb, 0xbf]));
      tally.withBom++;
    }
    lines.forEach((line, i) => {
      parts.push(line);
      if (!(trailing.length > 0 && i === lines.length - 1)) parts.push(Buffer.from('\n'));
    });
    const file = Buffer.concat(parts);
    fs.writeFileSync(LOG, file);
    tally.logs++;
    tally.bytes += file.length;
    if (file.length > CHUNK) tally.logsOver64KiB++;
    if (file.length > 1024 * 1024) tally.logsOver1MiB++;
    // `n` → its line, for where an answer lies.
    const lineOf = new Map();
    lines.forEach((line, i) => {
      const m = /"n":(\d+)/.exec(line.subarray(0, Math.min(line.length, 400)).toString('latin1'));
      if (m) lineOf.set(Number(m[1]), i);
    });

    const full = reg.readTaskEventsChecked();
    for (const id of ASKS) {
      tally.asks++;
      const got = reg.latestTaskEventOf(id);
      // The whole-log reader's answer over the stated rule: the last event whose id is `id`
      // among those ranAs.isCountedTaskEvent admits, no line past the clamp counted.
      let ref;
      let raw;
      for (const e of full.events) {
        if (e.id === id) raw = e;
        if (e.id === id && isCounted(e) && e.big !== true) ref = e;
      }
      const want = full.unreadable ? 'unreadable' : ref === undefined ? 'none' : ref;
      const same = typeof want === 'string' ? got === want : typeof got === 'object' && JSON.stringify(got) === JSON.stringify(want);
      if (!same) {
        mismatchCount++;
        if (mismatches.length < 5) {
          fs.mkdirSync(keepDir, { recursive: true });
          const kept = path.join(keepDir, `log-${logIndex}.jsonl`);
          fs.writeFileSync(kept, file);
          const brief = (v) => (typeof v === 'string' ? v : JSON.stringify(v).slice(0, 200));
          mismatches.push({ logIndex, id, got: brief(got), want: brief(want), kept });
        }
        continue;
      }
      if (raw !== ref) tally.rawFullReaderDiffers++;
      if (typeof got === 'string') {
        tally[got === 'none' ? 'answersNone' : 'answersUnreadable']++;
        continue;
      }
      tally.answersEvent++;
      if (got.esc === 1) tally.answersFromEscapedLine++;
      if (got.dup === 1) tally.answersFromDuplicateKeyLine++;
      const i = lineOf.get(got.n);
      if (i === undefined) continue;
      const a = offsets[i];
      const b = a + lines[i].length;
      for (let k = 1; file.length - k * CHUNK > 0; k++) {
        const boundary = file.length - k * CHUNK;
        if (a < boundary && boundary <= b) {
          tally.answersStraddlingAChunk++;
          break;
        }
      }
      if (i === lines.length - 1) tally.answersInLastLine++;
      const name = Buffer.from(id, 'latin1');
      if (lines.slice(i + 1).some((line) => line.indexOf(name) !== -1)) tally.answersPastAPrefixDecoy++;
      if (lines.slice(i + 1).some((line) => line.length > LINE_MAX)) tally.answersPastALongLine++;
    }
  }

  // The log refused or absent: both readers, the same verdict.
  const special = [];
  const verdicts = (label) => {
    const full = reg.readTaskEventsChecked();
    const started = Date.now();
    const got = reg.latestTaskEventOf('t1');
    special.push({ label, bounded: got, fullUnreadable: full.unreadable, ms: Date.now() - started });
  };
  fs.rmSync(LOG, { force: true });
  verdicts('absent');
  fs.writeFileSync(LOG, '');
  verdicts('empty');
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(LOG);
  verdicts('a directory');
  fs.rmSync(LOG, { recursive: true, force: true });
  require('child_process').execFileSync('mkfifo', [LOG]);
  verdicts('a FIFO with no writer');
  fs.rmSync(LOG, { force: true });
  const fd = fs.openSync(LOG, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  verdicts('64 MiB + 1 byte (sparse)');
  fs.truncateSync(LOG, 64 * 1024 * 1024);
  verdicts('exactly 64 MiB of NUL bytes, one line');
  fs.rmSync(LOG, { force: true });
  out({ tally, mismatchCount, mismatches, special });
}

/* ------------------------------------------------------------------------- *
 * cost
 * ------------------------------------------------------------------------- */

function costlog(id) {
  const TOTAL = 61 * 1024 * 1024;
  const LAST = 1024 * 1024;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const fd = fs.openSync(LOG, 'w');
  let written = 0;
  let k = 0;
  const filler = (target) => {
    const parts = [];
    let len = 0;
    while (len < target) {
      const line = JSON.stringify({ id: `f${k % 997}`, ts: 1_700_000_000_000 + k, status: k % 3 === 0 ? 'running' : 'done', worker: 'wa', title: `filler ${k}`, pad: 'p'.repeat(900 + (k % 200)) }) + '\n';
      k++;
      parts.push(line);
      len += line.length;
    }
    const buf = Buffer.from(parts.join(''));
    fs.writeSync(fd, buf);
    written += buf.length;
  };
  // Everything before the last 1 MiB: other tasks only.
  while (written < TOTAL - LAST - 4 * 1024 * 1024) filler(4 * 1024 * 1024);
  filler(TOTAL - LAST - written);
  const firstOfTask = written;
  // The task's events open the last 1 MiB, so a reader from the end walks all of it.
  for (const status of ['running', 'running']) {
    const line = JSON.stringify({ id, ts: 1_800_000_000_000 + written, status, worker: 'wa', title: 'the task being closed', n: written }) + '\n';
    fs.writeSync(fd, line);
    written += Buffer.byteLength(line);
  }
  const lastOfTask = written;
  filler(TOTAL - written - 2048);
  fs.closeSync(fd);
  const size = fs.statSync(LOG).size;
  out({ size, firstOfTaskFromEnd: size - firstOfTask, lastOfTaskEndFromEnd: size - lastOfTask });
}

function cost(id, which) {
  const run = {
    bounded: () => {
      const r = reg.latestTaskEventOf(id);
      return typeof r === 'string' ? r : `${r.status} n=${r.n}`;
    },
    full: () => {
      const r = reg.latestEventByIdChecked(id);
      return r.unreadable ? 'unreadable' : r.event === undefined ? 'none' : `${r.event.status} n=${r.event.n}`;
    },
    close: () => {
      const r = reg.appendTerminalTaskEvent({ id, ts: Date.now(), status: 'done', worker: 'wa', title: 'the task being closed' });
      return r.closed ? `closed over ${r.superseded?.status}` : `not closed (${r.final?.status})`;
    },
  }[which];
  // Warm what the call does not own (the module's lazy state, the fs binding), then measure.
  reg.ensureDirs();
  global.gc();
  global.gc();
  const before = process.memoryUsage();
  const peakBefore = process.resourceUsage().maxRSS * 1024;
  bytesRead = 0;
  readCalls = 0;
  wholeReads = 0;
  const started = process.hrtime.bigint();
  const answer = run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const after = process.memoryUsage();
  const peakAfter = process.resourceUsage().maxRSS * 1024;
  const counted = { bytesRead, readCalls, wholeReads };
  global.gc();
  const settled = process.memoryUsage();
  out({
    which,
    answer,
    ms: Math.round(ms * 10) / 10,
    ...counted,
    rssDelta: after.rss - before.rss,
    peakRssDelta: peakAfter - peakBefore,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external + after.arrayBuffers - (before.external + before.arrayBuffers),
    rssDeltaAfterGc: settled.rss - before.rss,
  });
}

/* ------------------------------------------------------------------------- *
 * hold
 * ------------------------------------------------------------------------- */

function hold(id, ms, eventJson) {
  reg.ensureDirs();
  const lockPath = path.join(reg.TASKS_DIR, `${id}.reconcile.lock`);
  const heldAt = { at: 0, until: 0 };
  reg.withPathLock(lockPath, () => {
    heldAt.at = Date.now();
    fs.writeSync(1, 'held\n');
    sleepSync(ms);
    heldAt.until = Date.now();
  });
  const after = eventJson === undefined ? undefined : reg.appendTerminalTaskEvent(JSON.parse(eventJson));
  out({ heldMs: heldAt.until - heldAt.at, released: Date.now(), after });
}

try {
  if (mode === 'equiv') equiv(Number(rest[0]), Number(rest[1]));
  else if (mode === 'costlog') costlog(rest[0]);
  else if (mode === 'cost') cost(rest[0], rest[1]);
  else if (mode === 'hold') hold(rest[0], Number(rest[1]), rest[2]);
  else if (mode === 'transcript') {
    bytesRead = 0;
    readCalls = 0;
    wholeReads = 0;
    const model = core.transcript.sessionModelOf(rest[0], rest[1]);
    out({ model: model ?? null, bytesRead, readCalls, wholeReads });
  }
  else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  out({ threw: String(err && err.stack ? err.stack : err) });
}
