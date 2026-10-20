#!/usr/bin/env node
// models-cancel.cjs — runs ONE registry.cancelRunningTask() call in a process of its own, for
// .orchestrator/fixes/models.mjs: the editor's "Cancel Dispatch" command is another process
// than the dispatch server, and so is this.
//
//   node models-cancel.cjs <core bundle> <task id> <reason> [graceMs]
//
// The test starts it with a sandbox environment (HOME redirected), so the task log it reads and
// writes is the sandbox's. Prints one line: { cancelled, elapsedMs } — or { threw }.

'use strict';

const [bundle, id, reason, grace] = process.argv.slice(2);
const core = require(bundle);
const started = Date.now();
const args = grace === undefined ? [id, reason] : [id, reason, Number(grace)];
Promise.resolve()
  .then(() => core.registry.cancelRunningTask(...args))
  .then(
    (cancelled) => process.stdout.write(JSON.stringify({ cancelled, elapsedMs: Date.now() - started }) + '\n', () => process.exit(0)),
    (err) => process.stdout.write(JSON.stringify({ threw: String(err && err.message ? err.message : err) }) + '\n', () => process.exit(0)),
  );
