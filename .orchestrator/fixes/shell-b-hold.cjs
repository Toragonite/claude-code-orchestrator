// A LIVE process that holds the registry's own lock — taken through the product's exported
// `withPathLock` at the path the registry writers use (`<registry.json>.lock`) — until a release
// file appears. Nothing is written to the registry: what is on disk at release is what was there.
//
//   HOME=<sandbox> node shell-b-hold.cjs <compiled out dir> <ready file> <release file> [maxMs]
//
// <ready file> is created from inside the critical section, so its existence means "the lock is
// held by this pid right now".
'use strict';
const fs = require('fs');
const path = require('path');

const [out, readyFile, releaseFile, maxArg] = process.argv.slice(2);
const maxMs = Number(maxArg || 120000);
const registry = require(path.join(out, 'registry.js'));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));

registry.ensureDirs();
registry.withPathLock(`${registry.REGISTRY_FILE}.lock`, () => {
  fs.writeFileSync(readyFile, String(process.pid));
  const started = Date.now();
  while (!fs.existsSync(releaseFile) && Date.now() - started < maxMs) {
    sleep(25);
  }
});
process.exit(0);
