// Bundle ONE variant of src/registry.ts into a CommonJS file the stress children can require().
//
//   node build.mjs --name fixed --out <dir>                       the live src/registry.ts
//   node build.mjs --name baseline --src <copy of registry.ts> --out <dir>
//   node build.mjs --name fast --out <dir> --set LOCK_ACQUIRE_TIMEOUT_MS=3_000
//
// --deps <dir>  resolve registry.ts's sibling imports (displayText, platform, providers, safeFs)
//               from a SNAPSHOT directory instead of the live src/, so every variant in a
//               comparison differs in registry.ts and nothing else — other workers edit src/ at
//               the same time, and a baseline-vs-fixed comparison must not move under them.
// --set K=V     rewrite `const K = …;` (exactly one occurrence) in the staged copy. Used ONLY by
//               runs that say so in their report (a shortened acquire timeout, to make the
//               timeout scenarios affordable). The shipped file is never touched.
//
// Output: <out>/<name>/registry.cjs, and the staged source beside it for inspection.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');

const args = process.argv.slice(2);
function opt(flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}
function opts(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

const name = opt('--name');
const outRoot = opt('--out');
if (!name || !outRoot) {
  console.error('usage: node build.mjs --name <variant> --out <dir> [--src <registry.ts>] [--deps <dir>] [--set K=V]...');
  process.exit(2);
}
const src = path.resolve(opt('--src', path.join(REPO, 'src', 'registry.ts')));
const deps = path.resolve(opt('--deps', path.join(REPO, 'src')));
const stage = path.join(path.resolve(outRoot), name);
fs.mkdirSync(stage, { recursive: true });

let text = fs.readFileSync(src, 'utf8');
for (const kv of opts('--set')) {
  const eq = kv.indexOf('=');
  const key = kv.slice(0, eq);
  const value = kv.slice(eq + 1);
  const re = new RegExp(`^const ${key} = [^;]+;`, 'm');
  const hits = text.match(new RegExp(`^const ${key} = [^;]+;`, 'gm')) ?? [];
  if (hits.length !== 1) {
    console.error(`--set ${key}: expected exactly one \`const ${key} = …;\`, found ${hits.length}`);
    process.exit(2);
  }
  text = text.replace(re, `const ${key} = ${value};`);
}
const staged = path.join(stage, 'registry.ts');
fs.writeFileSync(staged, text);

await esbuild.build({
  entryPoints: [staged],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(stage, 'registry.cjs'),
  logLevel: 'warning',
  plugins: [
    {
      name: 'siblings-from-deps',
      setup(build) {
        build.onResolve({ filter: /^\.\// }, (a) => {
          if (path.resolve(a.importer) !== staged) return undefined;
          return { path: path.join(deps, `${a.path.slice(2)}.ts`) };
        });
      },
    },
  ],
});
console.log(path.join(stage, 'registry.cjs'));
