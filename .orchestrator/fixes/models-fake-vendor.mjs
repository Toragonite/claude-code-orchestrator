#!/usr/bin/env node
// models-fake-vendor.mjs — a stand-in `cursor-agent` / `agy` for ONE thing: what a vendor CLI
// answers when it is asked to list its models (`<cli> models`). Used by
// .orchestrator/fixes/models.mjs for the listings the providers harness's own fakes cannot give:
// megabytes of output, a CLI that never answers, ids no model rule accepts, a failing exit.
//
// Never a real CLI: it reads nothing but its own arguments, touches no home directory, opens no
// connection. It is started through a launcher the test writes into a sandbox's `bin/`:
//
//   exec node models-fake-vendor.mjs --vendor=<cursor|gemini> --mode=<mode> [--log=<file>] "$@"
//
//   --mode=file:<path>     print that file's text, exit 0
//   --mode=big:<MiB>       print that many MiB of well-formed listing lines, exit 0
//   --mode=many:<N>        print N well-formed listing lines with labels of 200 characters, exit 0
//   --mode=fail:<path>     print that file's text, exit 1
//   --mode=hang            print nothing and never exit (dies on SIGTERM)
//   --mode=hang-deaf       the same, ignoring SIGTERM (only SIGKILL ends it)
//   --mode=deaf-tree       the same, with a child of its own (in its process group) that
//                          ignores SIGTERM too; one record { ev: 'tree', pid, child } is logged
//
// The three modes that never answer do so for EVERY invocation — `models`, `status`, anything —
// so a login check can be left hanging as well as a listing.
//
// A listing line is `<id> - <label>` for cursor-agent and `<id>\t<label>` for agy — the two forms
// the published adapters parse. In the other modes anything but `models` exits 2.
//
// With --log, one record per invocation is appended: { pid, argv, env } — the test reads the
// environment a vendor child was really given from it.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const own = {};
const argv = [];
for (const a of process.argv.slice(2)) {
  const m = /^--(vendor|mode|log)=(.*)$/s.exec(a);
  if (m && argv.length === 0) {
    own[m[1]] = m[2];
  } else {
    argv.push(a);
  }
}
const vendor = own.vendor === 'gemini' ? 'gemini' : 'cursor';
const [mode, ...rest] = String(own.mode ?? 'hang').split(':');
const arg = rest.join(':');

if (own.log) {
  try {
    fs.appendFileSync(own.log, JSON.stringify({ pid: process.pid, t: Date.now(), vendor, mode, argv, env: { ...process.env } }) + '\n');
  } catch {
    // evidence only
  }
}
process.stdout.on('error', () => process.exit(1));

const line = (id, label) => (vendor === 'gemini' ? `${id}\t${label}\n` : `${id} - ${label}\n`);
const header = vendor === 'gemini' ? 'Fetching available models...\n' : 'Available models\n\n';

/** Write `chunks()` until it returns undefined, honouring backpressure, then exit 0. */
function pump(next) {
  const go = () => {
    for (;;) {
      const chunk = next();
      if (chunk === undefined) {
        process.stdout.write('', () => process.exit(0));
        return;
      }
      if (!process.stdout.write(chunk)) {
        process.stdout.once('drain', go);
        return;
      }
    }
  };
  go();
}

const NEVER_ANSWERS = ['hang', 'hang-deaf', 'deaf-tree'];

if (NEVER_ANSWERS.includes(mode)) {
  if (mode !== 'hang') {
    process.on('SIGTERM', () => {});
  }
  if (mode === 'deaf-tree') {
    // NOT detached: it stays in this process's group, so only a signal to the group reaches it.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--vendor=${vendor}`, '--mode=hang-deaf', ...argv], { detached: false, stdio: 'ignore' });
    child.unref();
    if (own.log) {
      try {
        fs.appendFileSync(own.log, JSON.stringify({ ev: 'tree', pid: process.pid, child: child.pid, argv }) + '\n');
      } catch {
        // evidence only
      }
    }
  }
  // Never for ever: nothing this fake starts may outlive a test that was itself killed.
  setTimeout(() => process.exit(4), 120_000);
} else if (argv[0] !== 'models') {
  process.stderr.write(`models-fake-vendor: unsupported invocation ${JSON.stringify(argv.slice(0, 3))}\n`, () => process.exit(2));
} else if (mode === 'file' || mode === 'fail') {
  let text = '';
  try {
    text = fs.readFileSync(arg, 'utf8');
  } catch {
    text = '';
  }
  process.stdout.write(text, () => process.exit(mode === 'fail' ? 1 : 0));
} else if (mode === 'big') {
  const target = (Number(arg) || 5) * 1024 * 1024;
  let written = Buffer.byteLength(header);
  let n = 0;
  let first = true;
  pump(() => {
    if (first) {
      first = false;
      return header;
    }
    if (written >= target) return undefined;
    let chunk = '';
    for (let i = 0; i < 500; i++) {
      chunk += line(`big-model-${n}`, `Big Model ${n}`);
      n++;
    }
    written += Buffer.byteLength(chunk);
    return chunk;
  });
} else if (mode === 'many') {
  const total = Number(arg) || 300;
  let n = 0;
  let first = true;
  pump(() => {
    if (first) {
      first = false;
      return header;
    }
    if (n >= total) return undefined;
    const chunk = line(`many-model-${n}`, `${'L'.repeat(190)} ${n}`);
    n++;
    return chunk;
  });
} else {
  process.stderr.write(`models-fake-vendor: unknown mode ${JSON.stringify(mode)}\n`, () => process.exit(3));
}
