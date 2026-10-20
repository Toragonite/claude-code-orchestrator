// Extract the English string table from src/dashboard.ts (dashboardStrings) with the TS parser,
// as JSON on stdout. Every entry must be a plain `vscode.l10n.t('literal')` or a plain literal.
// usage: node extract-dashboard-strings.cjs [repo]   (default: the repository this script lives in)
const path = require('path');
const fs = require('fs');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const ts = require(path.join(repo, 'node_modules', 'typescript'));
const src = fs.readFileSync(path.join(repo, 'src', 'dashboard.ts'), 'utf8');
const sf = ts.createSourceFile('dashboard.ts', src, ts.ScriptTarget.ES2022, true);
const out = {};
function visit(node) {
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
}
visit(sf);
process.stdout.write(JSON.stringify(out, null, 2));
