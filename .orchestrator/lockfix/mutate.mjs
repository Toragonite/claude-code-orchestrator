// Write MUTANT copies of src/registry.ts — each with one safety property of the lock removed —
// so the harness can be shown to fail when the property is gone. Copies only; src/ is not touched.
//
//   node mutate.mjs <outDir>          -> <outDir>/<mutant>/registry.ts for every mutant below
//
// Then bundle each with build.mjs --src and run the scenario named beside it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src', 'registry.ts');
const outDir = path.resolve(process.argv[2] || '.');
const original = fs.readFileSync(SRC, 'utf8');

function replaceOnce(text, find, replace) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`anchor occurs ${n} times: ${find.slice(0, 80)}`);
  return text.replace(find, () => replace);
}

const FORCE_FALLBACK = [
  "  const symlinks = process.platform !== 'win32';\n",
  '  const symlinks = false as boolean;\n',
];

export const MUTANTS = {
  // The elected breaker removes whatever is at the path without judging it again.
  'no-recheck': {
    scenarios: 'dead,breakers',
    edits: [
      [
        '    const verdict = judgeLock(lockPath, memo);\n    if (verdict.state !== \'abandoned\') {\n      return verdict.state === \'absent\';\n    }\n',
        '    const verdict: LockVerdict = { state: \'abandoned\' };\n',
      ],
    ],
  },
  // The verdict rests on ONE look: "its claimant is dead" is taken to mean "it is still there".
  'no-second-look': {
    scenarios: 'exiters,breakers',
    edits: [
      [
        "  if (verdict.state !== 'abandoned') {\n    return verdict;\n  }\n  const again = sightLock(lockPath);",
        "  if (verdict.state !== 'abandoned' || Date.now() > 0) {\n    return verdict;\n  }\n  const again = sightLock(lockPath);",
      ],
    ],
  },
  // A lock that vanished between two looks is "stale" again.
  'vanished-is-stale': {
    scenarios: 'plain,breakers',
    edits: [
      [
        "  if (seen.kind === 'absent') {\n    return { state: 'absent' };\n  }\n  if (seen.kind === 'unknown') {",
        "  if (seen.kind === 'absent') {\n    return { state: 'abandoned' };\n  }\n  if (seen.kind === 'unknown') {",
      ],
    ],
  },
  // Every breaker is "the only one".
  'no-election': {
    scenarios: 'breakers,dead',
    edits: [
      [
        '    if (!enterBreakerElection(dir, entry) || !soleBreaker(dir, mine, memo)) {\n      return false;\n    }\n',
        '    void enterBreakerElection;\n    void soleBreaker;\n',
      ],
    ],
  },
  // Release unlinks whatever is at the path.
  'blind-release': {
    scenarios: 'evicted',
    edits: [
      [
        '    if (readLockToken(lockPath) !== token) {\n      return false;\n    }\n    try {\n      fs.unlinkSync(lockPath);',
        '    try {\n      fs.unlinkSync(lockPath);',
      ],
    ],
  },
  // Age is a proof again: a live holder whose lock is 10 s old is "gone".
  'age-is-proof': {
    scenarios: 'paused',
    edits: [
      [
        '  const current = linuxProcessStat(claim.pid);\n  if (current !== undefined) {\n    if (current.zombie) {',
        '  if (Date.now() - claim.claimedAt > 10_000) {\n    return true;\n  }\n  const current = linuxProcessStat(claim.pid);\n  if (current !== undefined) {\n    if (current.zombie) {',
      ],
    ],
  },
  // The deadline backstop is back: a waiter out of patience removes the lock and takes it.
  'deadline-break': {
    scenarios: 'paused',
    edits: [
      [
        '    if (expired) {\n      throw lockWaitError(targetFile, lockPath, verdict);\n    }\n    // Held; or abandoned',
        '    if (expired) {\n      removeAbandonedLock(lockPath);\n      create = true;\n      continue;\n    }\n    // Held; or abandoned',
      ],
      [
        '    if (expired && overtime) {\n      throw lockWaitError(targetFile, lockPath, verdict);\n    }\n',
        '',
      ],
    ],
  },
  // Create-then-stamp (the regular-file fallback, forced on) with no grace for the unstamped
  // window: a waiter that looks between the create and the stamp sees "no token" and clears a
  // live holder's lock.
  'fallback-no-grace': {
    scenarios: 'plain,breakers',
    edits: [FORCE_FALLBACK, ['const LOCK_UNSTAMPED_GRACE_MS = 2_000;', 'const LOCK_UNSTAMPED_GRACE_MS = -1;']],
  },
  // NOT a mutant: the shipped code with its create-then-stamp fallback forced on, which must
  // still PASS everything (it is what runs on win32 and on a filesystem without symlinks).
  'forced-fallback': {
    scenarios: 'all',
    mustPass: true,
    edits: [FORCE_FALLBACK],
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, m] of Object.entries(MUTANTS)) {
    let text = original;
    for (const [find, replace] of m.edits) text = replaceOnce(text, find, replace);
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'registry.ts'), text);
    console.log(`${name}\t${m.mustPass ? 'must PASS' : 'must FAIL'}\t${m.scenarios}`);
  }
}
