#!/usr/bin/env node
/*
 * Rebuild l10n/bundle.l10n{,.ko,.zh-cn}.json from
 *   - a FRESH extraction of the keys src/ uses now (extract-l10n.cjs is run here, every time);
 *   - the bundles as they are in the repository (the source for every key that has no override);
 *   - the translation tables in ./translations/*.txt (overrides, and translations of new keys).
 *
 * A key in src/ but not in the bundles needs an entry in a table; a key in the bundles but not
 * in src/ is dropped. The English bundle is key = value. The translated bundles are written in
 * the English bundle's key order (the default string sort), 2-space JSON, trailing newline.
 *
 * Translation table format (UTF-8, one entry per block, blocks separated by blank lines;
 * lines starting with `#` between blocks are comments):
 *
 *   @ <the English key, verbatim, on ONE line>
 *   ko: <Korean>
 *   zh: <Simplified Chinese>
 *
 * An entry whose English key is not used by src/ is an error (a typo, or a retired key).
 * An entry may omit `ko:` or `zh:` to leave that language to the existing bundle.
 *
 * usage: node build-l10n.cjs [repo] [--write]
 * Without --write it only reports. Exit 1 when any key lacks a translation or a table is bad.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname;
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const repo = path.resolve(positional[0] || path.join(here, '..', '..', '..'));
const write = args.includes('--write');

// 1. fresh extraction
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-l10n-'));
const extractedFile = path.join(tmp, 'extracted.json');
const out = execFileSync(process.execPath, [path.join(here, 'extract-l10n.cjs'), repo, '--json', extractedFile], {
  encoding: 'utf8',
});
process.stdout.write(out);
const extracted = JSON.parse(fs.readFileSync(extractedFile, 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });
const wanted = new Set(extracted.keys);

// 2. translation tables
const problems = [];
const overrides = { ko: new Map(), zh: new Map() };
const tableDir = path.join(here, 'translations');
const tableFiles = fs.existsSync(tableDir) ? fs.readdirSync(tableDir).filter((f) => f.endsWith('.txt')).sort() : [];
for (const f of tableFiles) {
  const lines = fs.readFileSync(path.join(tableDir, f), 'utf8').split('\n');
  let key;
  let startLine = 0;
  let seen;
  const close = () => {
    if (key === undefined) return;
    if (!wanted.has(key)) problems.push(`${f}:${startLine}: key is not used by src/: ${JSON.stringify(key)}`);
    for (const lang of ['ko', 'zh']) {
      if (seen[lang] === undefined) continue;
      if (seen[lang].trim() === '') problems.push(`${f}:${startLine}: empty ${lang} for ${JSON.stringify(key)}`);
      if (overrides[lang].has(key)) problems.push(`${f}:${startLine}: ${lang} defined twice for ${JSON.stringify(key)}`);
      overrides[lang].set(key, seen[lang]);
    }
    key = undefined;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@ ')) {
      close();
      key = line.slice(2);
      startLine = i + 1;
      seen = {};
    } else if (/^(ko|zh): /.test(line)) {
      if (key === undefined) problems.push(`${f}:${i + 1}: translation line outside an entry`);
      else seen[line.slice(0, 2)] = line.slice(4);
    } else if (line.trim() === '' || line.startsWith('#')) {
      // separator / comment
    } else {
      problems.push(`${f}:${i + 1}: unrecognised line: ${JSON.stringify(line.slice(0, 80))}`);
    }
  });
  close();
}

// 3. the bundles as they are now
const readBundle = (rel) => JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
const current = {
  en: readBundle('l10n/bundle.l10n.json'),
  ko: readBundle('l10n/bundle.l10n.ko.json'),
  zh: readBundle('l10n/bundle.l10n.zh-cn.json'),
};

const keys = [...extracted.keys].sort();
const bundles = { en: {}, ko: {}, zh: {} };
const missing = { ko: [], zh: [] };
for (const key of keys) {
  bundles.en[key] = key;
  for (const lang of ['ko', 'zh']) {
    const v = overrides[lang].has(key) ? overrides[lang].get(key) : current[lang][key];
    if (typeof v !== 'string' || v.trim() === '') missing[lang].push(key);
    else bundles[lang][key] = v;
  }
}
const added = keys.filter((k) => !(k in current.en));
const removed = Object.keys(current.en).filter((k) => !wanted.has(k));
const changed = { ko: 0, zh: 0 };
for (const lang of ['ko', 'zh']) for (const k of keys) if (k in current[lang] && bundles[lang][k] !== current[lang][k]) changed[lang]++;

console.log(`keys needed: ${keys.length} (bundle now: ${Object.keys(current.en).length}); to add: ${added.length}; to remove: ${removed.length}`);
console.log(`translation entries: ko ${overrides.ko.size}, zh ${overrides.zh.size} from ${tableFiles.length} file(s); existing translations replaced: ko ${changed.ko}, zh ${changed.zh}`);
console.log(`missing ko: ${missing.ko.length}, missing zh: ${missing.zh.length}`);
for (const lang of ['ko', 'zh']) for (const k of missing[lang]) console.log(`  MISSING ${lang}: ${JSON.stringify(k)}`);
for (const k of removed) console.log(`  REMOVE ${JSON.stringify(k)}`);
for (const p of problems) console.log(`  PROBLEM ${p}`);

const bad = missing.ko.length || missing.zh.length || problems.length;
if (write) {
  if (bad) {
    console.log('NOT WRITTEN: fix the problems above first.');
    process.exit(1);
  }
  const dump = (o) => JSON.stringify(o, null, 2) + '\n';
  fs.writeFileSync(path.join(repo, 'l10n/bundle.l10n.json'), dump(bundles.en));
  fs.writeFileSync(path.join(repo, 'l10n/bundle.l10n.ko.json'), dump(bundles.ko));
  fs.writeFileSync(path.join(repo, 'l10n/bundle.l10n.zh-cn.json'), dump(bundles.zh));
  console.log('written: l10n/bundle.l10n.json, .ko.json, .zh-cn.json');
}
process.exit(bad ? 1 : 0);
