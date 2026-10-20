// Fixture tests for the compiled src/sessionLitter.ts. Everything lives under the scratch dir.
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pruneSessionLitter, pruneAllSessionLitter } = require(process.env.SL_BUNDLE || './build/sessionLitter.js');

const S = __dirname;
const ROOT = path.join(S, 'litter-fixtures');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const TMP = fs.realpathSync(os.tmpdir());
const MIN = 60_000;
const HOUR = 60 * MIN;
const OLD = 2 * HOUR; // older than the 10-minute floor, younger than 24 h
const ANCIENT = 48 * HOUR; // older than 24 h
const YOUNG = 1 * MIN;
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) {
    pass++;
  } else {
    fail++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const age = (p, ms) => {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(p, t, t);
};
let cfgSeq = 0;
const newCfg = (withSessions = true) => {
  const cfg = path.join(ROOT, `cfg${++cfgSeq}`);
  fs.mkdirSync(withSessions ? path.join(cfg, 'sessions') : cfg, { recursive: true });
  return cfg;
};
const put = (cfg, name, content, ageMs) => {
  const p = path.join(cfg, 'sessions', name);
  fs.writeFileSync(p, content);
  age(p, ageMs);
  return p;
};
const probe = (extra = {}) =>
  JSON.stringify({
    pid: 1,
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: TMP,
    startedAt: 1700000000000,
    kind: 'interactive',
    entrypoint: 'sdk-cli',
    ...extra,
  });
// Since 2.0 a file is litter only when the process its NAME names is gone (kill(pid, 0) → ESRCH), and a
// probe entry's own `pid` — when it has one — must be that same number. These fixtures used to be named
// 123.json, 200.json, 1000.json … — numbers that are some live process on any machine — and every probe
// entry said `pid: 1`. Fixture entry number `n` is now the file `<P(n)>.json`, where P(n) is a pid in a
// block no process on this machine has, and its body says `pid: P(n)`, as a leaked entry really does.
const DEAD_BASE = 3_000_000;
const provenDead = new Set();
const P = (n) => {
  const pid = DEAD_BASE + n;
  if (!provenDead.has(pid)) {
    let code = 'alive';
    try {
      process.kill(pid, 0);
    } catch (e) {
      code = e.code;
    }
    if (code !== 'ESRCH') {
      throw new Error(`fixture: pid ${pid} is not free on this machine (${code}); the fixtures need a block of dead pids`);
    }
    provenDead.add(pid);
  }
  return pid;
};
/** The entry a leaked probe of process P(n) left: the signature, and its own pid. */
const entryOf = (n, extra = {}) => probe({ pid: P(n), ...extra });
// Two processes that are ALIVE for the whole run: this one, and the one that started it.
const LIVE = process.pid;
const LIVE2 = process.ppid;
const snapshot = (dir) =>
  fs
    .readdirSync(dir)
    .sort()
    .map((n) => {
      const st = fs.lstatSync(path.join(dir, n));
      return `${n}|${st.mode}|${st.size}|${st.mtimeMs}|${st.ino}`;
    })
    .join('\n');

(async () => {
  // ------------------------------------------------------------------ main fixture
  const cfg = newCfg();
  const sess = path.join(cfg, 'sessions');
  const outside = path.join(ROOT, 'outside');
  fs.mkdirSync(outside);
  const gone = {}; // label -> path that MUST be removed
  const kept = {}; // label -> path that MUST survive

  gone['zero-byte old <pid>.json'] = put(cfg, `${P(123)}.json`, '', OLD);
  gone['probe entry (sdk-cli)'] = put(cfg, `${P(200)}.json`, entryOf(200), OLD);
  gone['its key <pid>.<hex>.key'] = put(cfg, `${P(200)}.${HEX}.key`, 'k', OLD);
  gone['probe entry (claude-vscode)'] = put(cfg, `${P(201)}.json`, entryOf(201, { entrypoint: 'claude-vscode' }), OLD);
  gone['its key A'] = put(cfg, `${P(201)}.${HEX}.key`, 'k', OLD);
  gone['its key B'] = put(cfg, `${P(201)}.${HEX2}.key`, 'k', OLD);
  // [2.0: these two were REMOVED] a name is a pid only in its plain decimal spelling — no leading zero —
  // so a zero-padded name is one the module does not understand, and it keeps the file and its key.
  const PADDED = String(P(202)).padStart(10, '0');
  kept['10-digit zero-padded, zero-byte <0…pid>.json'] = put(cfg, `${PADDED}.json`, '', OLD);
  kept['its key <0…pid>.<hex>.key (48 h old)'] = put(cfg, `${PADDED}.${HEX}.key`, 'k', ANCIENT);
  gone['orphan key older than 24 h'] = put(cfg, `${P(300)}.${HEX}.key`, 'k', ANCIENT);
  gone['probe entry with messagingSocketPath:null'] = put(cfg, `${P(203)}.json`, entryOf(203, { messagingSocketPath: null }), OLD);
  {
    const base = entryOf(204, { pad: '' }); // P(204) and P(244) are both seven digits: one base length serves both
    const exact = entryOf(204, { pad: 'x'.repeat(64 * 1024 - Buffer.byteLength(base)) });
    gone['probe entry of exactly 64 KiB'] = put(cfg, `${P(204)}.json`, exact, OLD);
    kept['probe entry of 64 KiB + 1 byte'] = put(cfg, `${P(244)}.json`, entryOf(244, { pad: 'x'.repeat(64 * 1024 - Buffer.byteLength(base) + 1) }), OLD);
    if (fs.statSync(gone['probe entry of exactly 64 KiB']).size !== 65536 || fs.statSync(kept['probe entry of 64 KiB + 1 byte']).size !== 65537) {
      throw new Error('fixture size bug');
    }
  }
  gone['zero-byte old entry whose key is fresh'] = put(cfg, `${P(248)}.json`, '', OLD);
  kept['fresh key of a removed entry (age floor applies to keys too)'] = put(cfg, `${P(248)}.${HEX}.key`, 'k', YOUNG);

  // a LIVE session: its entry is named for a process that exists and carries a messaging socket
  kept['entry of a LIVE process, WITH messagingSocketPath'] = put(cfg, `${LIVE}.json`, probe({ pid: LIVE, messagingSocketPath: '/tmp/claude-x.sock' }), OLD);
  kept['key of the live entry with a socket (ancient)'] = put(cfg, `${LIVE}.${HEX}.key`, 'k', ANCIENT);
  // 2.0: the process is asked for EVERY rule — an empty entry, a probe-signature entry without a socket and
  // an orphan key are all kept while the process their name names is alive (or cannot be asked about)
  kept['zero-byte entry of a LIVE process'] = put(cfg, `${LIVE2}.json`, '', OLD);
  kept['ancient key beside the zero-byte entry of a live process'] = put(cfg, `${LIVE2}.${HEX}.key`, 'k', ANCIENT);
  kept['zero-byte 1.json (pid 1 exists and is not ours)'] = put(cfg, '1.json', '', OLD);
  kept['ancient orphan key 1.<hex>.key'] = put(cfg, `1.${HEX}.key`, 'k', ANCIENT);
  kept['probe-signature entry, no socket, whose `pid` field names ANOTHER process'] = put(cfg, `${P(260)}.json`, probe({ pid: P(261) }), OLD);
  kept['probe-signature entry, no socket, whose `pid` field is 1 (what every fixture here used to say)'] = put(cfg, `${P(262)}.json`, probe(), OLD);
  kept['entry whose cwd is not the tmp dir'] = put(cfg, `${P(211)}.json`, entryOf(211, { cwd: '/work/someone/project' }), OLD);
  kept['key of the non-tmp entry (ancient)'] = put(cfg, `${P(211)}.${HEX}.key`, 'k', ANCIENT);
  kept['FRESH probe-signature entry'] = put(cfg, `${P(212)}.json`, entryOf(212), YOUNG);
  kept['fresh key of the fresh entry'] = put(cfg, `${P(212)}.${HEX}.key`, 'k', YOUNG);
  kept['fresh zero-byte entry'] = put(cfg, `${P(213)}.json`, '', YOUNG);
  kept['ancient key whose entry is fresh'] = put(cfg, `${P(213)}.${HEX}.key`, 'k', ANCIENT);
  kept['zero-byte entry with a FUTURE mtime'] = put(cfg, `${P(246)}.json`, '', -HOUR);

  // symlinks: never followed, never removed; their targets never touched
  const target1 = path.join(outside, 'target-zero.json');
  fs.writeFileSync(target1, '');
  age(target1, OLD);
  const target2 = path.join(outside, 'target-probe.json');
  fs.writeFileSync(target2, entryOf(1240));
  age(target2, OLD);
  const target3 = path.join(outside, 'target.key');
  fs.writeFileSync(target3, 'k');
  age(target3, ANCIENT);
  fs.symlinkSync(target1, path.join(sess, `${P(124)}.json`));
  fs.lutimesSync(path.join(sess, `${P(124)}.json`), (Date.now() - OLD) / 1000, (Date.now() - OLD) / 1000);
  fs.symlinkSync(target2, path.join(sess, `${P(1240)}.json`));
  fs.lutimesSync(path.join(sess, `${P(1240)}.json`), (Date.now() - OLD) / 1000, (Date.now() - OLD) / 1000);
  kept['symlink <pid>.json → outside zero-byte file'] = path.join(sess, `${P(124)}.json`);
  kept['symlink <pid>.json → outside probe entry'] = path.join(sess, `${P(1240)}.json`);
  kept['outside target (zero-byte)'] = target1;
  kept['outside target (probe entry)'] = target2;
  gone['zero-byte entry (its key is a symlink)'] = put(cfg, `${P(214)}.json`, '', OLD);
  fs.symlinkSync(target3, path.join(sess, `${P(214)}.${HEX}.key`));
  fs.lutimesSync(path.join(sess, `${P(214)}.${HEX}.key`), (Date.now() - ANCIENT) / 1000, (Date.now() - ANCIENT) / 1000);
  kept['symlink key of a removed entry'] = path.join(sess, `${P(214)}.${HEX}.key`);
  kept['outside target (key)'] = target3;
  fs.symlinkSync(path.join(outside, 'nowhere'), path.join(sess, `${P(1241)}.json`));
  kept['dangling symlink <pid>.json'] = path.join(sess, `${P(1241)}.json`);
  kept['ancient key beside a dangling-symlink entry'] = put(cfg, `${P(1241)}.${HEX}.key`, 'k', ANCIENT);

  // a DIRECTORY with a candidate name, and what is inside it
  const DIR125 = path.join(sess, `${P(125)}.json`);
  fs.mkdirSync(DIR125);
  fs.writeFileSync(path.join(DIR125, `${P(1250)}.json`), '');
  age(path.join(DIR125, `${P(1250)}.json`), OLD);
  age(DIR125, OLD);
  kept['DIRECTORY named <pid>.json'] = DIR125;
  kept['zero-byte file inside that directory'] = path.join(DIR125, `${P(1250)}.json`);
  kept['ancient key beside the directory entry'] = put(cfg, `${P(125)}.${HEX}.key`, 'k', ANCIENT);
  fs.mkdirSync(path.join(sess, `${P(126)}.${HEX}.key`));
  age(path.join(sess, `${P(126)}.${HEX}.key`), ANCIENT);
  kept['DIRECTORY named like an orphan key'] = path.join(sess, `${P(126)}.${HEX}.key`);
  fs.mkdirSync(path.join(sess, 'sub'));
  fs.writeFileSync(path.join(sess, 'sub', `${P(124)}.json`), '');
  age(path.join(sess, 'sub', `${P(124)}.json`), OLD);
  kept['zero-byte candidate name in a SUBdirectory'] = path.join(sess, 'sub', `${P(124)}.json`);
  fs.writeFileSync(path.join(cfg, `${P(123)}.json`), '');
  age(path.join(cfg, `${P(123)}.json`), OLD);
  kept['zero-byte ../<pid>.json (in the config dir, outside sessions)'] = path.join(cfg, `${P(123)}.json`);
  fs.writeFileSync(path.join(cfg, `${P(300)}.${HEX}.key`), 'k');
  age(path.join(cfg, `${P(300)}.${HEX}.key`), ANCIENT);
  kept['ancient ../<pid>.<hex>.key outside sessions'] = path.join(cfg, `${P(300)}.${HEX}.key`);

  // a FIFO with a candidate name must neither block the pass nor be removed
  execFileSync('mkfifo', [path.join(sess, `${P(245)}.json`)]);
  age(path.join(sess, `${P(245)}.json`), OLD);
  kept['FIFO named <pid>.json'] = path.join(sess, `${P(245)}.json`);

  // names that are one step away from a candidate — all zero-byte and old
  for (const name of [
    '126.json.bak', '..x', '..123.json', '.json', '127.JSON', '-128.json', ' 129.json', '130.json ', '131.json\n',
    '12345678901.json', '1e3.json', '0x10.json', '١٢٣.json', '132.json.tmp', 'abc.json', '133..json',
    '134.jsonx', '135', '136.json~', '+137.json', '1 38.json', '139.json.', '１２３.json',
  ]) {
    kept[`odd name ${JSON.stringify(name)}`] = put(cfg, name, '', OLD);
  }
  // key names that are one step away — all orphan and older than 24 h
  for (const name of [
    `135.${HEX.toUpperCase()}.key`, `136.${HEX.slice(1)}.key`, `137.${HEX}a.key`, `138.${HEX}.key.bak`, `139.${HEX}.KEY`,
    `.${HEX}.key`, `140.${'g' + HEX.slice(1)}.key`, `141.${HEX}.key\n`, `12345678901.${HEX}.key`, `142.${HEX}.key `,
    `x143.${HEX}.key`, `144..${HEX}.key`, `145.${HEX}`,
  ]) {
    kept[`odd key name ${JSON.stringify(name)}`] = put(cfg, name, 'k', ANCIENT);
  }

  kept['entry with ccoMirror:true (otherwise a probe signature)'] = put(cfg, `${P(220)}.json`, entryOf(220, { ccoMirror: true }), OLD);
  kept['entry with ccoMirror:false (any ccoMirror key)'] = put(cfg, `${P(221)}.json`, entryOf(221, { ccoMirror: false }), OLD);
  kept['orphan key YOUNGER than 24 h'] = put(cfg, `${P(301)}.${HEX}.key`, 'k', OLD);
  kept['unparseable non-empty entry'] = put(cfg, `${P(230)}.json`, '{not json', OLD);
  kept['ancient key of the unparseable entry'] = put(cfg, `${P(230)}.${HEX}.key`, 'k', ANCIENT);
  kept['whitespace-only entry (non-empty, not JSON)'] = put(cfg, `${P(2300)}.json`, ' \n', OLD);
  kept['JSON array'] = put(cfg, `${P(231)}.json`, JSON.stringify([JSON.parse(entryOf(231))]), OLD);
  kept['JSON string'] = put(cfg, `${P(232)}.json`, JSON.stringify(entryOf(232)), OLD);
  kept['JSON null'] = put(cfg, `${P(233)}.json`, 'null', OLD);
  kept['JSON number'] = put(cfg, `${P(2330)}.json`, '42', OLD);
  kept['kind:"bg"'] = put(cfg, `${P(234)}.json`, entryOf(234, { kind: 'bg' }), OLD);
  kept['entrypoint:"cli"'] = put(cfg, `${P(235)}.json`, entryOf(235, { entrypoint: 'cli' }), OLD);
  kept['cwd = tmp dir + trailing slash'] = put(cfg, `${P(236)}.json`, entryOf(236, { cwd: TMP + '/' }), OLD);
  kept['cwd = a subdirectory of the tmp dir'] = put(cfg, `${P(237)}.json`, entryOf(237, { cwd: TMP + '/sub' }), OLD);
  kept['kind:"Interactive" (case)'] = put(cfg, `${P(238)}.json`, entryOf(238, { kind: 'Interactive' }), OLD);
  kept['messagingSocketPath:"" (empty string)'] = put(cfg, `${P(239)}.json`, entryOf(239, { messagingSocketPath: '' }), OLD);
  kept['messagingSocketPath:{} (unknown shape)'] = put(cfg, `${P(240)}.json`, entryOf(240, { messagingSocketPath: {} }), OLD);
  kept['messagingSocketPath:0'] = put(cfg, `${P(2400)}.json`, entryOf(2400, { messagingSocketPath: 0 }), OLD);
  kept['messagingSocketPath:false'] = put(cfg, `${P(2401)}.json`, entryOf(2401, { messagingSocketPath: false }), OLD);
  kept['entrypoint missing'] = put(cfg, `${P(241)}.json`, entryOf(241, { entrypoint: undefined }), OLD);
  kept['cwd missing'] = put(cfg, `${P(242)}.json`, entryOf(242, { cwd: undefined }), OLD);
  kept['cwd is an array containing the tmp dir'] = put(cfg, `${P(243)}.json`, entryOf(243, { cwd: [TMP] }), OLD);
  kept['entrypoint is an array'] = put(cfg, `${P(2430)}.json`, entryOf(2430, { entrypoint: ['sdk-cli'] }), OLD);
  kept['kind missing'] = put(cfg, `${P(2431)}.json`, entryOf(2431, { kind: undefined }), OLD);
  kept['BOM-prefixed probe entry'] = put(cfg, `${P(247)}.json`, '﻿' + entryOf(247), OLD);
  kept['probe signature nested one level down'] = put(cfg, `${P(249)}.json`, JSON.stringify({ entry: JSON.parse(entryOf(249)) }), OLD);
  kept['unrelated real file'] = put(cfg, 'README.txt', 'hello', ANCIENT);

  const total = fs.readdirSync(sess).length;
  const wantRemoved = Object.keys(gone).length;

  console.log('--- 1. dryRun classifies and removes nothing');
  {
    const before = snapshot(sess);
    const r = await pruneSessionLitter(cfg, { dryRun: true });
    check('1a dryRun: directory byte-for-byte unchanged (names, sizes, mtimes, inodes)', snapshot(sess) === before);
    check('1b dryRun: every file still exists', Object.values(gone).every(exists) && Object.values(kept).every(exists));
    check('1c dryRun report counts what WOULD be removed', r.removed === wantRemoved && r.scanned === total && r.truncated === false && r.errors === 0, JSON.stringify(r));
  }

  console.log('--- 2. the real pass');
  const t0 = Date.now();
  const rep = await pruneSessionLitter(cfg);
  // `scanned` may fall short of `total` by entries that were removed (through their key) before
  // the directory stream reached them; it can never exceed it.
  check('2a report', rep.configDir === cfg && rep.removed === wantRemoved && rep.scanned <= total && rep.scanned >= total - wantRemoved && rep.truncated === false && rep.errors === 0, JSON.stringify({ ...rep, configDir: '<cfg>' }) + ` total=${total} in ${Date.now() - t0}ms`);
  for (const [label, p] of Object.entries(gone)) {
    check(`2 REMOVED  ${label}`, !exists(p));
  }
  for (const [label, p] of Object.entries(kept)) {
    check(`2 KEPT     ${label}`, exists(p));
  }
  check('2b symlink targets intact', fs.readFileSync(target2, 'utf8') === entryOf(1240) && fs.statSync(target1).size === 0 && fs.readFileSync(target3, 'utf8') === 'k');
  check('2c symlinks are still symlinks', fs.lstatSync(kept['symlink <pid>.json → outside zero-byte file']).isSymbolicLink() && fs.lstatSync(kept['symlink key of a removed entry']).isSymbolicLink());
  {
    const before = snapshot(sess);
    const again = await pruneSessionLitter(cfg);
    check('2d second pass removes nothing more', again.removed === 0 && again.errors === 0 && snapshot(sess) === before, JSON.stringify(again));
  }

  console.log('--- 3. missing / odd sessions directory');
  {
    const r1 = await pruneSessionLitter(path.join(ROOT, 'does-not-exist'));
    check('3a missing config dir → scanned:0, no throw, no error', r1.scanned === 0 && r1.removed === 0 && r1.truncated === false && r1.errors === 0, JSON.stringify(r1));
    const c2 = newCfg(false);
    const r2 = await pruneSessionLitter(c2);
    check('3b config dir without sessions/ → scanned:0', r2.scanned === 0 && r2.errors === 0, JSON.stringify(r2));
    const c3 = newCfg(false);
    fs.writeFileSync(path.join(c3, 'sessions'), 'i am a file');
    const r3 = await pruneSessionLitter(c3);
    check('3c sessions is a regular FILE → scanned:0, file untouched', r3.scanned === 0 && r3.removed === 0 && fs.readFileSync(path.join(c3, 'sessions'), 'utf8') === 'i am a file', JSON.stringify(r3));
    const c4 = newCfg(false);
    const real = newCfg();
    const victim = put(real, `${P(500)}.json`, '', OLD);
    fs.symlinkSync(path.join(real, 'sessions'), path.join(c4, 'sessions'));
    const r4 = await pruneSessionLitter(c4);
    check('3d sessions is a SYMLINK to a directory of litter → not followed, nothing removed', r4.scanned === 0 && r4.removed === 0 && exists(victim), JSON.stringify(r4));
    const c5 = path.join(ROOT, 'a-file-not-a-dir');
    fs.writeFileSync(c5, 'x');
    const r5 = await pruneSessionLitter(c5);
    check('3e config dir is a file (ENOTDIR) → scanned:0, no error', r5.scanned === 0 && r5.errors === 0, JSON.stringify(r5));
    const c6 = newCfg();
    const r6 = await pruneSessionLitter(c6);
    check('3f empty sessions dir → all zeros, not truncated', r6.scanned === 0 && r6.removed === 0 && r6.truncated === false && r6.errors === 0);
  }

  console.log('--- 4. bounds');
  {
    const c = newCfg();
    for (let i = 0; i < 50; i++) {
      put(c, `${P(1000 + i)}.json`, '', OLD);
    }
    const d = path.join(c, 'sessions');
    const r = await pruneSessionLitter(c, { maxFiles: 10 });
    check('4a maxFiles 10 of 50 → truncated:true, scanned 10, removed 10', r.truncated === true && r.scanned === 10 && r.removed === 10 && fs.readdirSync(d).length === 40, JSON.stringify(r));
    const r0 = await pruneSessionLitter(c, { maxFiles: 0 });
    check('4b maxFiles 0 → nothing examined, truncated:true', r0.truncated === true && r0.scanned === 0 && r0.removed === 0 && fs.readdirSync(d).length === 40, JSON.stringify(r0));
    const rT = await pruneSessionLitter(c, { maxMs: 0 });
    check('4c maxMs 0 → nothing examined, truncated:true', rT.truncated === true && rT.scanned === 0 && rT.removed === 0 && fs.readdirSync(d).length === 40, JSON.stringify(rT));
    const rX = await pruneSessionLitter(c, { maxFiles: 40 });
    check('4d maxFiles exactly the directory size → all removed, truncated:false', rX.truncated === false && rX.scanned === 40 && rX.removed === 40 && fs.readdirSync(d).length === 0, JSON.stringify(rX));
    const rE = await pruneSessionLitter(c, { maxFiles: 0 });
    check('4e maxFiles 0 on an EMPTY directory → truncated:false', rE.truncated === false && rE.scanned === 0);
  }
  {
    // pairs under a small cap: repeat while truncated; a key must never go while its entry stays.
    // Keys are older than 24 h, as real litter is: a key whose entry went in an EARLIER pass is
    // an orphan by the time it is met, and rule (c) only lets an orphan go once it is that old.
    const c = newCfg();
    const d = path.join(c, 'sessions');
    const N = 60;
    for (let i = 0; i < N; i++) {
      put(c, `${P(2000 + i)}.json`, i % 2 ? '' : entryOf(2000 + i), OLD);
      put(c, `${P(2000 + i)}.${HEX}.key`, 'k', ANCIENT);
    }
    put(c, `${LIVE}.json`, probe({ pid: LIVE, messagingSocketPath: '/s' }), OLD); // a live session among them: this process
    put(c, `${LIVE}.${HEX}.key`, 'k', ANCIENT);
    let passes = 0;
    let invariant = true;
    let removed = 0;
    let r;
    do {
      r = await pruneSessionLitter(c, { maxFiles: 7 });
      passes++;
      removed += r.removed;
      const names = new Set(fs.readdirSync(d));
      for (let i = 0; i < N; i++) {
        if (names.has(`${P(2000 + i)}.json`) && !names.has(`${P(2000 + i)}.${HEX}.key`)) {
          invariant = false;
        }
      }
    } while (r.truncated && passes < 200);
    const left = fs.readdirSync(d).sort();
    check('4f capped passes repeated while truncated: all litter gone, the live pair survives', removed === 2 * N && left.length === 2 && left[0] === `${LIVE}.${HEX}.key` && left[1] === `${LIVE}.json`, `passes=${passes} removed=${removed} left=${left.length}`);
    check('4g no pass ever removed a key while leaving its entry', invariant);
  }
  {
    // the contract's rule (c) at a truncation boundary: an entry removed in pass 1, its 2 h-old
    // key first met in pass 2 → the key is an orphan younger than 24 h and must WAIT.
    const c = newCfg();
    const d = path.join(c, 'sessions');
    for (let i = 0; i < 40; i++) {
      put(c, `${P(3000 + i)}.json`, '', OLD);
      put(c, `${P(3000 + i)}.${HEX}.key`, 'k', OLD);
    }
    let r;
    let passes = 0;
    do {
      r = await pruneSessionLitter(c, { maxFiles: 1000, maxMs: 4000 });
      passes++;
    } while (r.truncated && passes < 50);
    check('4h uncapped: every pair goes in one pass whatever the directory order', passes === 1 && fs.readdirSync(d).length === 0, `passes=${passes} left=${fs.readdirSync(d).length}`);
    for (let i = 0; i < 40; i++) {
      put(c, `${P(3000 + i)}.json`, '', OLD);
      put(c, `${P(3000 + i)}.${HEX}.key`, 'k', OLD);
    }
    passes = 0;
    do {
      r = await pruneSessionLitter(c, { maxFiles: 5 });
      passes++;
    } while (r.truncated && passes < 50);
    const left = fs.readdirSync(d);
    const names = new Set(left);
    // Every key still there either still has its entry, or is an orphan younger than 24 h.
    // (With a cap this small the young orphans at the head of the directory use up the whole
    // cap, so later entries are never reached: the pass keeps reporting truncated and removes
    // nothing — it does not "make progress" by removing a key rule (c) protects.)
    const keyWithoutEntryRemoved = [...Array(40).keys()].some((i) => names.has(`${P(3000 + i)}.json`) && !names.has(`${P(3000 + i)}.${HEX}.key`));
    check('4i tiny cap: no key is ever removed ahead of rule (c); the stuck pass stays truncated and removes nothing', !keyWithoutEntryRemoved && left.length > 0 && r.truncated === true && r.removed === 0, `passes=${passes} left=${left.length} (entries ${left.filter((n) => n.endsWith('.json')).length}, keys ${left.filter((n) => n.endsWith('.key')).length})`);
    const later = await pruneSessionLitter(c, { now: Date.now() + 23 * HOUR });
    check('4j ... and one ordinary pass clears all of it once the keys are older than 24 h', fs.readdirSync(d).length === 0 && later.removed === left.length && later.truncated === false, JSON.stringify({ removed: later.removed, was: left.length }));
  }

  console.log('--- 5. options and misuse');
  {
    const mk = () => {
      const c = newCfg();
      return { c, zero: put(c, `${P(10)}.json`, '', OLD), tmpEntry: put(c, `${P(11)}.json`, entryOf(11), OLD), custom: put(c, `${P(12)}.json`, entryOf(12, { cwd: '/custom/tmp' }), OLD), young: put(c, `${P(13)}.json`, '', YOUNG) };
    };
    let f = mk();
    let r = await pruneSessionLitter(f.c, { tmpDirs: ['/custom/tmp'] });
    check('5a explicit tmpDirs replaces the default', !exists(f.custom) && exists(f.tmpEntry) && !exists(f.zero) && r.removed === 2, JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { tmpDirs: [] });
    check('5b empty tmpDirs switches rule (b) off, rule (a) still works', exists(f.custom) && exists(f.tmpEntry) && !exists(f.zero) && r.removed === 1, JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { tmpDirs: [42, null, '', TMP] });
    check('5c non-string tmpDirs members are ignored', !exists(f.tmpEntry) && exists(f.custom), JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { now: Date.now() - 3 * HOUR });
    check('5d `now` 3 h in the past: 2 h-old files are in the future → kept', r.removed === 0 && exists(f.zero) && exists(f.tmpEntry), JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { minAgeMs: 3 * HOUR });
    check('5e minAgeMs 3 h keeps 2 h-old litter', r.removed === 0 && exists(f.zero), JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { minAgeMs: 0 });
    check('5f minAgeMs 0 removes a 1-minute-old zero-byte entry', !exists(f.young) && r.removed === 3, JSON.stringify(r));
    f = mk();
    r = await pruneSessionLitter(f.c, { minAgeMs: NaN, maxFiles: -1, maxMs: 'soon', now: 'today', tmpDirs: 'nope', dryRun: 'yes' });
    check('5g garbage option values fall back to defaults (and dryRun must be exactly true)', r.removed === 2 && !exists(f.zero) && !exists(f.tmpEntry) && exists(f.young) && exists(f.custom), JSON.stringify(r));
    for (const bad of [null, 'opts', 7, [], () => 1]) {
      f = mk();
      r = await pruneSessionLitter(f.c, bad);
      check(`5h opts = ${typeof bad === 'function' ? 'function' : JSON.stringify(bad)} → defaults`, r.removed === 2 && r.errors === 0, JSON.stringify(r));
    }
  }
  {
    const cwdBefore = process.cwd();
    const trap = path.join(ROOT, 'cwd-trap');
    fs.mkdirSync(path.join(trap, 'sessions'), { recursive: true });
    const victim = path.join(trap, 'sessions', `${P(77)}.json`);
    fs.writeFileSync(victim, '');
    age(victim, OLD);
    process.chdir(trap); // a relative/empty configDir would resolve HERE
    let threw = false;
    const results = [];
    for (const bad of [undefined, null, 42, '', '.', 'relative/dir', {}, [], path.join(trap) + '\u0000x', './']) {
      try {
        results.push(await pruneSessionLitter(bad));
      } catch {
        threw = true;
      }
    }
    process.chdir(cwdBefore);
    check('5i bad configDir (non-string, empty, relative, NUL): never throws, refused with errors:1', !threw && results.length === 10 && results.every((r) => r.scanned === 0 && r.removed === 0 && r.errors === 1 && r.truncated === false), JSON.stringify(results.map((r) => r.errors)));
    check('5j an empty/relative configDir did NOT fall through to ./sessions of the cwd', exists(victim));
  }

  console.log('--- 6. pruneAllSessionLitter');
  {
    const a = newCfg();
    const b = newCfg();
    put(a, `${P(1)}.json`, '', OLD);
    put(b, `${P(1)}.json`, '', OLD);
    put(b, `${P(2)}.json`, '', OLD);
    const reps = await pruneAllSessionLitter([a, a + '/', a + '/.', path.join(a, 'x', '..'), b, b]);
    check('6a de-duplicated by path.resolve, order kept, first spelling reported', reps.length === 2 && reps[0].configDir === a && reps[0].removed === 1 && reps[1].configDir === b && reps[1].removed === 2, JSON.stringify(reps));
    let threw = false;
    let r2;
    let r3;
    try {
      r2 = await pruneAllSessionLitter('not an array');
      r3 = await pruneAllSessionLitter([null, 5, a, undefined]);
    } catch {
      threw = true;
    }
    check('6b non-array → []; non-string members → refused reports, never a throw', !threw && Array.isArray(r2) && r2.length === 0 && r3.length === 4 && r3[0].errors === 1 && r3[1].errors === 1 && r3[2].errors === 0 && r3[3].errors === 1, JSON.stringify(r3));
    // sequential: options are passed through to every dir
    const c = newCfg();
    const young = put(c, `${P(9)}.json`, '', YOUNG);
    const r4 = await pruneAllSessionLitter([c], { minAgeMs: 0 });
    check('6c options reach each directory', r4.length === 1 && r4[0].removed === 1 && !exists(young));
  }

  console.log('--- 7. races between judging a file and removing it (fs.promises patched)');
  {
    const fsp = fs.promises;
    const realLstat = fsp.lstat;
    // 7a: the entry is rewritten by a NEW live session after it was read, before the unlink
    const c = newCfg();
    const p = put(c, `${P(900)}.json`, entryOf(900), OLD);
    const live = entryOf(900, { messagingSocketPath: '/live.sock', kind: 'bg' });
    let calls = 0;
    fsp.lstat = async (file, ...rest) => {
      if (file === p && ++calls === 2) {
        fs.writeFileSync(p, live); // pid reuse: same name, new content, new mtime
      }
      return realLstat.call(fsp, file, ...rest);
    };
    const r = await pruneSessionLitter(c);
    fsp.lstat = realLstat;
    check('7a entry rewritten between read and unlink → kept (re-lstat sees a different file)', calls === 2 && exists(p) && fs.readFileSync(p, 'utf8') === live && r.removed === 0 && r.errors === 0, JSON.stringify(r) + ` lstat calls=${calls}`);

    // 7b: the entry is REPLACED (new inode, identical bytes and mtime) between read and unlink
    const c2 = newCfg();
    const p2 = put(c2, `${P(901)}.json`, entryOf(901), OLD);
    const mt = fs.statSync(p2).mtime;
    calls = 0;
    fsp.lstat = async (file, ...rest) => {
      if (file === p2 && ++calls === 2) {
        const tmp = p2 + '.swap';
        fs.writeFileSync(tmp, entryOf(901));
        fs.utimesSync(tmp, mt, mt);
        fs.renameSync(tmp, p2);
      }
      return realLstat.call(fsp, file, ...rest);
    };
    const rb = await pruneSessionLitter(c2);
    fsp.lstat = realLstat;
    check('7b same bytes, same mtime, different inode → kept', exists(p2) && rb.removed === 0, JSON.stringify(rb));

    // 7c: swapped for a symlink to an outside probe entry between the lstat and the open
    const c3 = newCfg();
    const p3 = put(c3, `${P(902)}.json`, entryOf(902), OLD);
    const out3 = path.join(outside, 'race-target.json');
    fs.writeFileSync(out3, entryOf(902)); // what the name would be judged removable on, were the link followed
    age(out3, OLD);
    calls = 0;
    fsp.lstat = async (file, ...rest) => {
      const st = await realLstat.call(fsp, file, ...rest);
      if (file === p3 && ++calls === 1) {
        fs.unlinkSync(p3);
        fs.symlinkSync(out3, p3);
      }
      return st;
    };
    const rc = await pruneSessionLitter(c3);
    fsp.lstat = realLstat;
    check('7c swapped for a symlink after the lstat → not followed, not removed, target intact, not an error', fs.lstatSync(p3).isSymbolicLink() && exists(out3) && fs.readFileSync(out3, 'utf8') === entryOf(902) && rc.removed === 0 && rc.errors === 0, JSON.stringify(rc));

    // 7d: the entry vanishes (the CLI cleaned it up itself) between the lstat and the open
    const c4 = newCfg();
    const p4 = put(c4, `${P(903)}.json`, entryOf(903), OLD);
    const k4 = put(c4, `${P(903)}.${HEX}.key`, 'k', OLD);
    calls = 0;
    fsp.lstat = async (file, ...rest) => {
      const st = await realLstat.call(fsp, file, ...rest);
      if (file === p4 && ++calls === 1) {
        fs.unlinkSync(p4);
      }
      return st;
    };
    const rd = await pruneSessionLitter(c4);
    fsp.lstat = realLstat;
    check('7d entry vanished mid-judgement → no error, and its (young-ish) key is left for a later pass', rd.errors === 0 && rd.removed === 0 && exists(k4), JSON.stringify(rd));
  }

  {
    // 7e: A → symlink-to-B → A. The name is pointed at an outside PROBE entry only while it is
    // being read, and is the original LIVE entry again (same inode, size, mtime) by the time
    // of the re-check. Only proving that the bytes came from the judged file stops this.
    const fsp = fs.promises;
    const realLstat = fsp.lstat;
    const realOpen = fsp.open;
    const c = newCfg();
    // The entry that must survive is a session worker's (kind "bg": never litter, whatever its process);
    // the decoy is a leaked probe's entry for the same pid, which on its own WOULD be removed. (Before 2.0
    // the survivor was "an entry with a socket and pid 1"; an entry with a socket whose process is gone
    // and whose socket path holds nothing is litter now, so it could no longer play the part.)
    const liveBody = entryOf(904, { kind: 'bg', messagingSocketPath: '/live/socket/path' });
    const pA = put(c, `${P(904)}.json`, liveBody, OLD);
    const decoy = path.join(outside, 'decoy-probe.json');
    const base = entryOf(904, { pad: '' });
    const decoyBody = entryOf(904, { pad: 'x'.repeat(Buffer.byteLength(liveBody) - Buffer.byteLength(base)) });
    fs.writeFileSync(decoy, decoyBody);
    if (fs.statSync(decoy).size !== fs.statSync(pA).size) {
      throw new Error('fixture: decoy must be the same size as the live entry');
    }
    {
      // the two halves of the fixture, each judged on its own bytes
      const alone = newCfg();
      const decoyAlone = put(alone, `${P(904)}.json`, decoyBody, OLD);
      const ra = await pruneSessionLitter(alone);
      const alone2 = newCfg();
      const liveAlone = put(alone2, `${P(904)}.json`, liveBody, OLD);
      const rl = await pruneSessionLitter(alone2);
      check('7e (fixture) read on its own bytes the decoy IS removed and the surviving entry is NOT — so only reading the wrong file could remove it', !exists(decoyAlone) && ra.removed === 1 && exists(liveAlone) && rl.removed === 0, JSON.stringify([ra.removed, rl.removed]));
    }
    let swapped = 0;
    fsp.lstat = async (file, ...rest) => {
      const st = await realLstat.call(fsp, file, ...rest);
      if (file === pA && swapped === 0) {
        swapped = 1;
        fs.renameSync(pA, pA + '.orig');
        fs.symlinkSync(decoy, pA);
      }
      return st;
    };
    fsp.open = async (file, ...rest) => {
      try {
        return await realOpen.call(fsp, file, ...rest);
      } finally {
        if (file === pA && swapped === 1) {
          swapped = 2;
          fs.unlinkSync(pA);
          fs.renameSync(pA + '.orig', pA);
        }
      }
    };
    const re = await pruneSessionLitter(c);
    fsp.lstat = realLstat;
    fsp.open = realOpen;
    check('7e name pointed at a probe-shaped decoy only during the read, then restored → the live entry survives', swapped === 2 && exists(pA) && fs.readFileSync(pA, 'utf8') === liveBody && re.removed === 0, JSON.stringify(re) + ` swapped=${swapped}`);
  }

  console.log('--- 8. failures are counted, never thrown');
  {
    const c = newCfg();
    const d = path.join(c, 'sessions');
    const a = put(c, `${P(40)}.json`, '', OLD);
    const b = put(c, `${P(41)}.json`, entryOf(41), OLD);
    const k = put(c, `${P(41)}.${HEX}.key`, 'k', OLD);
    fs.chmodSync(d, 0o555); // unlink → EACCES
    let threw = false;
    let r;
    try {
      r = await pruneSessionLitter(c);
    } catch {
      threw = true;
    }
    fs.chmodSync(d, 0o755);
    check('8a unlink refused (read-only directory): errors counted, nothing removed, key left with its entry', !threw && r.removed === 0 && r.errors === 2 && exists(a) && exists(b) && exists(k), JSON.stringify(r));
    const u = put(c, `${P(42)}.json`, entryOf(42), OLD);
    fs.chmodSync(u, 0o000); // open → EACCES
    try {
      r = await pruneSessionLitter(c);
    } catch {
      threw = true;
    }
    fs.chmodSync(u, 0o644);
    check('8b unreadable entry: counted as an error and kept; the rest still pruned', !threw && r.errors === 1 && exists(u) && !exists(a) && !exists(b) && !exists(k) && r.removed === 3, JSON.stringify(r));
    const c2 = newCfg();
    fs.chmodSync(path.join(c2, 'sessions'), 0o000); // opendir → EACCES
    try {
      r = await pruneSessionLitter(c2);
    } catch {
      threw = true;
    }
    fs.chmodSync(path.join(c2, 'sessions'), 0o755);
    check('8c unreadable sessions directory: errors:1, scanned:0, no throw', !threw && r.errors === 1 && r.scanned === 0, JSON.stringify(r));
  }
  {
    const c = newCfg();
    for (let i = 0; i < 300; i++) {
      put(c, `${P(5000 + i)}.json`, i % 3 ? entryOf(5000 + i) : '', OLD);
      put(c, `${P(5000 + i)}.${HEX}.key`, 'k', OLD);
    }
    let threw = false;
    let rs;
    try {
      rs = await Promise.all([pruneSessionLitter(c), pruneSessionLitter(c), pruneSessionLitter(c)]);
    } catch {
      threw = true;
    }
    const sum = rs ? rs.reduce((n, r) => n + r.removed, 0) : -1;
    // NOT `sum === 600`: on this platform two unlink() calls racing on one path can BOTH report
    // success (measured separately), so concurrent passes may each count the same file.
    check('8d three concurrent passes over one directory: nothing thrown, no errors, directory empty', !threw && sum >= 600 && rs.every((r) => r.errors === 0) && fs.readdirSync(path.join(c, 'sessions')).length === 0, `removed per pass ${JSON.stringify(rs.map((r) => r.removed))} sum=${sum} for 600 files`);
  }

  console.log(`\nlitter: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('UNEXPECTED THROW', e);
  process.exit(3);
});
