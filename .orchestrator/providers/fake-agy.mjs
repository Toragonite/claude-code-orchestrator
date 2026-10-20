#!/usr/bin/env node
// fake-agy.mjs — the fake `agy` CLI of the providers harness. The whole emulation lives
// in fake-vendor.mjs; this file only says which CLI it is. It refuses to run (exit 97)
// without a scenario file (CCO_PROVIDERS_SCENARIO) or outside a harness sandbox.
import { runAsCli } from './fake-vendor.mjs';

runAsCli('gemini');
