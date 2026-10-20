// K-SHELL probe helper: holds the REGISTRY's own lock (the product's lock, taken through the product's
// exported withPathLock at the path withFileLock uses: <registry.json>.lock) for <ms> milliseconds, as a
// live process. HOME must be the probe's sandbox. usage: node lock-holder.js <compiled out dir> <ms> <ready file>
const path = require('path');
const fs = require('fs');
const registry = require(path.join(process.argv[2], 'registry.js'));
const ms = Number(process.argv[3]);
registry.ensureDirs();
registry.withPathLock(`${registry.REGISTRY_FILE}.lock`, () => {
  fs.writeFileSync(process.argv[4], String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
});
