// Does the mesh LEDGER lock (src/mesh/pool.ts withLedgerLock) lose updates the way registry's
// withFileLock did? Read-only as far as src/ goes: it bundles the live pool.ts into a scratch
// dir and drives its exported mutateMeshWorkers from K processes × M appends each.
//
//   node pool-repro.mjs <scratch dir> <runs> [plant|noplant] [linger]
//
// `linger` keeps every child alive for 3 s after its last append. It separates two ways a live
// lock gets broken: with it, no writer's pid dies during the run, so "the token I read names a
// pid that has since exited" cannot be what misleads ledgerLockIsStale.
//
// Each append adds ONE uniquely named worker record under the write lock, so the ledger must
// end with exactly K*M records; fewer is a lost update. `plant` first leaves an abandoned
// `<state>.write.lock` (dead pid), which is the case that needs a lock to be BROKEN.
import keychainGuard from '../fixes/keychain-guard.cjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// AGENT_CLI_CREDENTIAL_STORE=memory and the keychain guard, in this process and every child it starts from
// process.env; the run FAILS at exit if anything tried the keychain (see keychain-guard.cjs).
keychainGuard.harness('pool-repro');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const scratch = path.resolve(process.argv[2]);
const runs = Number(process.argv[3] || 20);
const plant = process.argv[4] === 'plant';
const linger = process.argv[5] === 'linger';
const K = 8;
const M = 20;

const bundle = path.join(scratch, 'pool-repro', 'pool.cjs');
await require('esbuild').build({
  entryPoints: [path.join(REPO, 'src', 'mesh', 'pool.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'error',
});

const childCode = `
const pool = require(${JSON.stringify(bundle)});
const cwd = process.argv[1];
const wait = Number(process.argv[2]) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
for (let i = 0; i < ${M}; i++) {
  pool.mutateMeshWorkers(cwd, (workers) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    workers.push({ name: 'r-' + process.pid + '-' + i, account: 'main', configDir: '/nowhere', jobId: 'deadbeef', model: 'opus', role: 'worker', spawnedAt: Date.now() });
  }, { onSkip: (why) => { console.log('SKIP ' + why.slice(0, 80)); } });
}
if (${linger}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);`;

let lostRuns = 0;
let lost = 0;
let skips = 0;
const t0 = Date.now();
for (let r = 0; r < runs; r++) {
  const home = fs.mkdtempSync(path.join(process.env.LOCKFIX_TMP || os.tmpdir(), 'cco-poolrepro-'));
  const cwd = path.join(home, 'ws');
  fs.mkdirSync(cwd);
  const meshDir = path.join(home, '.claude-code-orchestrator', 'mesh');
  fs.mkdirSync(meshDir, { recursive: true });
  // The state file's name is a hash of the workspace path; ask the module rather than guess.
  const probe = spawn(process.execPath, ['-e', `console.log(require(${JSON.stringify(bundle)}).meshStateFile ? '' : ''); const c=require(${JSON.stringify(bundle)}); c.mutateMeshWorkers(process.argv[1], () => {});`, cwd], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
  await new Promise((res) => probe.once('exit', res));
  const stateFile = fs.readdirSync(meshDir).find((n) => n.endsWith('.json'));
  if (!stateFile) {
    console.log('could not locate the state file; mesh dir holds', fs.readdirSync(meshDir));
    process.exit(2);
  }
  const statePath = path.join(meshDir, stateFile);
  if (plant) {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const dead = c.pid;
    await new Promise((res) => c.once('exit', res));
    fs.writeFileSync(`${statePath}.write.lock`, `${dead} ${Date.now()} zzz`);
  }
  const startAt = Date.now() + 250;
  const outs = await Promise.all(
    Array.from({ length: K }, () => new Promise((res) => {
      const c = spawn(process.execPath, ['-e', childCode, cwd, String(startAt)], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.once('close', () => res(out));
    })),
  );
  skips += outs.join('').split('\n').filter((l) => l.startsWith('SKIP')).length;
  const n = JSON.parse(fs.readFileSync(statePath, 'utf8')).workers.length;
  if (n !== K * M) {
    lostRuns++;
    lost += K * M - n;
  }
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(
  `${plant ? 'abandoned write lock planted' : 'no abandoned lock'}${linger ? ', writers linger after their last append' : ''}: ${runs} runs of ${K}×${M} appends; ` +
    `${lostRuns} runs ended short (${lost} records missing in all); ${skips} writes reported skipped; ` +
    `${Math.round((Date.now() - t0) / 1000)} s; load ${os.loadavg()[0].toFixed(1)}`,
);
