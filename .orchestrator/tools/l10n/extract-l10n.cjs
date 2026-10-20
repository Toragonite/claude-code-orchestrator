#!/usr/bin/env node
/*
 * Extract every string-literal first argument of `vscode.l10n.t(` / `l10n.t(` in src/**\/*.ts.
 *
 * Uses the TypeScript parser (not a regex), so single quotes, double quotes, template literals
 * without interpolation, escaped quotes and multi-line `'a' + 'b'` concatenation are all read the
 * way the compiler reads them. Recognised call shapes:
 *   vscode.l10n.t('text', args…)            l10n.t('text', args…)   (import { l10n } from 'vscode')
 *   vscode.l10n.t(`text`)                   vscode.l10n.t('a' + 'b')
 *   vscode.l10n.t({ message: 'text', args, comment })
 * A call whose first argument is not a plain literal (a template WITH `${}`, a variable, a
 * call) is REPORTED (file:line + source text) and never guessed at. Any other use of
 * `l10n` — `const t = vscode.l10n.t`, `const { t } = vscode.l10n`, passing it around — is
 * reported as an ALIAS, because the calls behind it would be invisible here.
 *
 * usage: node extract-l10n.cjs [repo] [--json out.json]     (repo defaults to the repository
 *        this script lives in: <repo>/.orchestrator/tools/l10n/extract-l10n.cjs)
 */
const fs = require('fs');
const path = require('path');

const firstArg = process.argv[2];
const repo = path.resolve(firstArg && !firstArg.startsWith('--') ? firstArg : path.join(__dirname, '..', '..', '..'));
const ts = require(path.join(repo, 'node_modules/typescript/lib/typescript.js'));
const outIdx = process.argv.indexOf('--json');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : undefined;

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** Is `expr` the callee `vscode.l10n.t` or `l10n.t`? */
function isL10nT(expr) {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 't') return false;
  const obj = expr.expression;
  if (ts.isIdentifier(obj)) return obj.text === 'l10n';
  if (ts.isPropertyAccessExpression(obj)) return obj.name.text === 'l10n';
  return false;
}

/** Is `node` an `l10n` / `x.l10n` reference (the namespace itself)? */
function isL10nNamespace(node) {
  if (ts.isIdentifier(node) && node.text === 'l10n') return true;
  return ts.isPropertyAccessExpression(node) && node.name.text === 'l10n';
}

/** Static string value of an expression, or undefined when it is not a plain literal. */
function literalValue(node) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return literalValue(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalValue(node.left);
    const r = literalValue(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  return undefined;
}

const keys = new Map(); // key -> [{file, line}]
const nonLiteral = [];  // {file, line, text, why}
const aliases = [];     // {file, line, text} — l10n used other than as a direct `.t(` call
const parsedCallLines = new Set(); // "file:line" of every parsed call
let calls = 0;

for (const file of walk(path.join(repo, 'src'), []).sort()) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rel = path.relative(repo, file);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  (function visit(node) {
    if (ts.isCallExpression(node) && isL10nT(node.expression)) {
      calls++;
      parsedCallLines.add(`${rel}:${lineOf(node)}`);
      const a0 = node.arguments[0];
      let v = literalValue(a0);
      let why;
      if (v === undefined && a0 && ts.isObjectLiteralExpression(a0)) {
        // vscode.l10n.t({ message, args, comment })
        const m = a0.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name && p.name.getText(sf) === 'message',
        );
        v = m ? literalValue(m.initializer) : undefined;
        if (v === undefined) why = 'options object whose `message` is not a plain literal';
      } else if (v === undefined) {
        why = !a0
          ? 'no argument'
          : ts.isTemplateExpression(a0)
            ? 'template literal WITH interpolation'
            : `first argument is a ${ts.SyntaxKind[a0.kind]}`;
      }
      if (v === undefined) {
        nonLiteral.push({ file: rel, line: lineOf(node), text: node.getText(sf).slice(0, 200).replace(/\s+/g, ' '), why });
      } else {
        if (!keys.has(v)) keys.set(v, []);
        keys.get(v).push({ file: rel, line: lineOf(node) });
      }
    } else if (isL10nT(node) && !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      // `const t = vscode.l10n.t` or passing the function around: calls through the alias are invisible here.
      aliases.push({ file: rel, line: lineOf(node), text: node.parent.getText(sf).slice(0, 160).replace(/\s+/g, ' ') });
    } else if (
      isL10nNamespace(node) &&
      !(node.parent && (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent))) &&
      !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 't') &&
      // `vscode.l10n` as the object of the `.l10n` access itself is handled by the node above
      !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      // `const { t } = vscode.l10n`, `const x = vscode.l10n`, `vscode.l10n.bundle`: the namespace used some other way.
      aliases.push({ file: rel, line: lineOf(node), text: node.parent.getText(sf).slice(0, 160).replace(/\s+/g, ' ') });
    }
    ts.forEachChild(node, visit);
  })(sf);
  // Imports of l10n from anywhere else (e.g. '@vscode/l10n') are another translation path.
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /l10n/.test(st.moduleSpecifier.text)) {
      aliases.push({ file: rel, line: lineOf(st), text: st.getText(sf).slice(0, 160).replace(/\s+/g, ' ') });
    }
  }
}

// Cross-check with a dumb textual scan so a parser blind spot cannot hide calls: every line
// that textually contains `l10n.t(` must be a parsed call; the rest are listed (comments).
const textualOnly = [];
let textual = 0;
for (const file of walk(path.join(repo, 'src'), [])) {
  const rel = path.relative(repo, file);
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((lineText, i) => {
      const n = (lineText.match(/\bl10n\s*\.\s*t\s*\(/g) || []).length;
      textual += n;
      if (n > 0 && !parsedCallLines.has(`${rel}:${i + 1}`)) {
        // a multi-line call may start on a line the parser attributes to an earlier `vscode.` token
        textualOnly.push({ file: rel, line: i + 1, text: lineText.trim().slice(0, 160) });
      }
    });
}

const sorted = [...keys.keys()].sort();
const result = {
  calls,
  textualOccurrences: textual,
  uniqueKeys: sorted.length,
  nonLiteral,
  aliases,
  textualOnly,
  keys: sorted,
  sites: Object.fromEntries(sorted.map((k) => [k, keys.get(k)])),
};
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(
  `calls=${calls} textual=${textual} unique=${sorted.length} nonLiteral=${nonLiteral.length} aliases=${aliases.length} textualOnly=${textualOnly.length}`,
);
for (const n of nonLiteral) console.log(`NON-LITERAL ${n.file}:${n.line} — ${n.why}: ${n.text}`);
for (const a of aliases) console.log(`ALIAS ${a.file}:${a.line}: ${a.text}`);
for (const t of textualOnly) console.log(`TEXTUAL-ONLY ${t.file}:${t.line}: ${t.text}`);
