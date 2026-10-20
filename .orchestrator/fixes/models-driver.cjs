#!/usr/bin/env node
// models-driver.cjs — runs ONE providerModels() call in a process of its own, for
// .orchestrator/fixes/models.mjs.
//
//   node models-driver.cjs <core bundle> <provider> <configDir> <timeoutMs>
//
// Why a process of its own: providerModels resolves the vendor CLI through the login shell and
// PATH of the process it runs in, and starts it there. The test's own process still has the
// machine's real PATH, where a real `cursor-agent` or `agy` may be installed — so the call is
// made here, in a child the test starts with a sandbox environment (the providers harness's
// `fx.env()`: a sandbox HOME, PATH and login shell in which the only CLIs are fakes).
//
// Why at all, when `provider-cli.js models` exists: that helper always runs with the full 25 s
// budget. The function takes `timeoutMs`, which is how a test asks for the same behaviour — "the
// CLI never answers" — in two seconds instead of twenty.
//
// Prints one line: { catalog, elapsedMs }.

'use strict';

const [bundle, provider, configDir, timeoutMs] = process.argv.slice(2);
const core = require(bundle);
const started = Date.now();
const call = core.providerRunner && core.providerRunner.providerModels;
if (typeof call !== 'function') {
  process.stdout.write(JSON.stringify({ missing: 'providerRunner.providerModels is not exported by this build' }) + '\n', () => process.exit(0));
} else {
  call({ provider, configDir }, { timeoutMs: Number(timeoutMs) }).then(
    (catalog) => process.stdout.write(JSON.stringify({ catalog, elapsedMs: Date.now() - started }) + '\n', () => process.exit(0)),
    (err) => process.stdout.write(JSON.stringify({ rejected: String(err && err.message ? err.message : err), elapsedMs: Date.now() - started }) + '\n', () => process.exit(0)),
  );
}
