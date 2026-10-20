// dash-sync — the dashboard's string table, three ways, must agree:
//   1. src/dashboard.ts            dashboardStrings(): the table the host hands the page;
//   2. media/dashboard/fixtures.js the copy between <strings:begin> and <strings:end> that the
//                                  browser preview (and so the page matrix) renders with;
//   3. media/dashboard/dashboard.js every key the page asks for.
//
//   node check-strings.js <repo root>            compare; writes nothing; exit 1 on a difference
//   node check-strings.js <repo root> --write    regenerate block 2 from table 1 (a maintenance
//                                                step; run.sh never does this)
//
// The table is read out of the TypeScript source with the compiler's own parser, so a string is
// compared as the literal the host really passes to vscode.l10n.t.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(process.argv[2] || '');
const WRITE = process.argv.includes('--write');
const DASH_TS = path.join(ROOT, 'src', 'dashboard.ts');
const FIXTURES = path.join(ROOT, 'media', 'dashboard', 'fixtures.js');
const PAGE = path.join(ROOT, 'media', 'dashboard', 'dashboard.js');

let failures = 0;
const check = (name, ok, observed) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${observed !== undefined ? `: ${observed}` : ''}`);
};

/** The English table of dashboardStrings(), in source order. */
function extractTable() {
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
  const src = fs.readFileSync(DASH_TS, 'utf8');
  const sf = ts.createSourceFile('dashboard.ts', src, ts.ScriptTarget.ES2022, true);
  const out = {};
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'dashboardStrings') {
      const walk = (n) => {
        if (ts.isObjectLiteralExpression(n) && Object.keys(out).length === 0) {
          for (const p of n.properties) {
            if (!ts.isPropertyAssignment(p)) throw new Error('unexpected property kind');
            const key = p.name.getText(sf);
            let init = p.initializer;
            if (ts.isCallExpression(init)) {
              if (init.expression.getText(sf) !== 'vscode.l10n.t') throw new Error('not l10n.t: ' + key);
              if (init.arguments.length !== 1) throw new Error('args: ' + key);
              init = init.arguments[0];
            }
            if (!ts.isStringLiteral(init) && !ts.isNoSubstitutionTemplateLiteral(init)) throw new Error('not a literal: ' + key);
            out[key] = init.text;
          }
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ASCII-only output: every character outside space..~ is written as \uXXXX.
const asciiJson = (v) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const BEGIN = '/* <strings:begin> */';
const END = '/* <strings:end> */';
const blockOf = (table) =>
  `${BEGIN}\n  const STRINGS = {\n${Object.entries(table).map(([k, v]) => `    ${k}: ${asciiJson(v)},`).join('\n')}\n  };\n  ${END}`;

let table;
try {
  table = extractTable();
} catch (e) {
  check('the string table can be read out of src/dashboard.ts', false, String(e && e.message));
  console.log(`\n0 passed, ${failures} failed`);
  process.exit(1);
}
const keys = Object.keys(table);
const fixtures = fs.readFileSync(FIXTURES, 'utf8');
const a = fixtures.indexOf(BEGIN);
const b = fixtures.indexOf(END);
const generated = blockOf(table);

if (WRITE) {
  if (a < 0 || b < a) {
    console.error('fixtures.js has no <strings:begin> … <strings:end> block; nothing written');
    process.exit(1);
  }
  const next = fixtures.slice(0, a) + generated + fixtures.slice(b + END.length);
  if (next === fixtures) {
    console.log(`fixtures.js already holds the generated table (${keys.length} keys); nothing written`);
  } else {
    fs.writeFileSync(FIXTURES, next);
    console.log(`filled ${keys.length} keys into ${path.relative(ROOT, FIXTURES)}`);
  }
  process.exit(0);
}

check('the string table can be read out of src/dashboard.ts (every value a literal handed to vscode.l10n.t)', keys.length > 0, `${keys.length} keys`);

const present = a >= 0 && b > a ? fixtures.slice(a, b + END.length) : null;
let drift = '';
if (present !== null && present !== generated) {
  // say WHICH keys differ, so the report is useful while the table is being regenerated
  const have = {};
  for (const m of present.matchAll(/^ {4}([A-Za-z0-9_$]+): (".*"),$/gm)) {
    try {
      have[m[1]] = JSON.parse(m[2]);
    } catch {
      have[m[1]] = undefined;
    }
  }
  const missing = keys.filter((k) => !(k in have));
  const extra = Object.keys(have).filter((k) => !(k in table));
  const changed = keys.filter((k) => k in have && have[k] !== table[k]);
  const order = missing.length === 0 && extra.length === 0 && changed.length === 0 ? ' (same keys and texts; order or spelling of the block differs)' : '';
  drift = `not in fixtures.js: ${JSON.stringify(missing)}; only in fixtures.js: ${JSON.stringify(extra)}; text differs: ${JSON.stringify(changed)}${order}`;
}
check('media/dashboard/fixtures.js holds exactly the table generated from src/dashboard.ts',
  present === generated, present === null ? 'no <strings:begin> … <strings:end> block' : present === generated ? `${keys.length} keys, byte for byte` : drift);

const page = fs.readFileSync(PAGE, 'utf8');
const used = new Set();
for (const m of page.matchAll(/\bt\('([A-Za-z0-9]+)'/g)) used.add(m[1]);
for (const m of page.matchAll(/'([A-Za-z][A-Za-z0-9]+)'/g)) if (table[m[1]] !== undefined) used.add(m[1]);
const missing = [...used].filter((k) => table[k] === undefined);
const unused = keys.filter((k) => !used.has(k));
console.log(`table ${keys.length} used ${used.size} missing ${JSON.stringify(missing)} unused ${JSON.stringify(unused)}`);
check('every key the page asks for is in the table', missing.length === 0, JSON.stringify(missing));

for (const f of [PAGE, FIXTURES]) {
  const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  check(`${path.relative(ROOT, f)} parses`, r.status === 0, r.status === 0 ? undefined : String(r.stderr).split('\n').slice(0, 4).join(' | '));
}
console.log(`\n${4 + 1 - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
