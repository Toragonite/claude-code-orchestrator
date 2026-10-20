// What would ship, and does it hold together?  node .orchestrator/tools/pkg/verify-package.cjs
//
// Offline (no vsce, no network). From `out/` as built by `npm run compile`:
//  1. the require graph of the extension host (from package.json "main") reaches only files that
//     .vscodeignore lets through, and requires no package that does not ship (node_modules is
//     excluded: only Node built-ins and `vscode` are allowed);
//  2. the three server bundles the extension copies and runs require only Node built-ins;
//  3. every file the manifest points at (main, icon, l10n, walkthrough media) ships;
//  4. nothing that ships contains a home-directory path or an e-mail address other than the
//     documented placeholder ones.
// Exit 0 only when every check passes.
'use strict';
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const REPO = path.resolve(__dirname, '..', '..', '..');
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
let failed = 0;
const ok = (name, pass, detail) => { if (!pass) failed++; console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || detail === undefined ? '' : ' — ' + detail}`); };

// ---- .vscodeignore, as far as this repository uses it: one glob per line, `!` to re-include.
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '(?:/.*)?$');
const rules = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ neg: l.startsWith('!'), re: globToRe(l.replace(/^!/, '')) }));
const ships = (file) => { let ignored = false; for (const r of rules) if (r.re.test(file)) ignored = !r.neg; return !ignored; };

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => 'node:' + m)]);
const requiresOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

// 1. extension-host graph
const main = path.join(REPO, pkg.main.endsWith('.js') ? pkg.main : pkg.main + '.js');
ok('out/ is built (package.json "main" exists)', fs.existsSync(main), rel(main));
if (!fs.existsSync(main)) { console.log('\nrun `npm run compile` first'); process.exit(1); }
const seen = new Set(); const stack = [main]; const notShipped = []; const foreign = []; const missing = [];
while (stack.length) {
  const file = stack.pop(); if (seen.has(file)) continue; seen.add(file);
  if (!ships(rel(file))) notShipped.push(rel(file));
  for (const req of requiresOf(file)) {
    if (req.startsWith('.')) { const target = [req, req + '.js', path.join(req, 'index.js')].map((r) => path.resolve(path.dirname(file), r)).find((p) => fs.existsSync(p) && fs.statSync(p).isFile()); if (target) stack.push(target); else missing.push(`${rel(file)} → ${req}`); }
    else if (req !== 'vscode' && !builtins.has(req)) foreign.push(`${rel(file)} → ${req}`);
  }
}
ok(`extension host: ${seen.size} modules reachable from ${rel(main)}, all of them ship`, notShipped.length === 0, notShipped.join(', '));
ok('extension host: every relative require resolves', missing.length === 0, missing.join('; '));
ok('extension host: requires only Node built-ins and `vscode` (node_modules does not ship)', foreign.length === 0, foreign.join('; '));

// 2. the server bundles
for (const b of ['out/mcp/server.js', 'out/mcp/run-task.js', 'out/mcp/provider-cli.js', 'out/mcp/cli.js']) {
  const file = path.join(REPO, b); const exists = fs.existsSync(file);
  const bad = exists ? requiresOf(file).filter((r) => !builtins.has(r)) : ['(missing)'];
  ok(`${b}: built, ships, and requires only Node built-ins`, exists && ships(b) && bad.length === 0, bad.slice(0, 5).join(', '));
}

// 3. manifest targets
const targets = [pkg.icon, 'l10n/bundle.l10n.json', 'l10n/bundle.l10n.ko.json', 'l10n/bundle.l10n.zh-cn.json', 'package.nls.json', 'package.nls.ko.json', 'package.nls.zh-cn.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'media/dashboard/dashboard.js', 'media/dashboard/dashboard.css'];
for (const w of pkg.contributes.walkthroughs ?? []) for (const s of w.steps ?? []) { const m = s.media ?? {}; for (const v of [m.markdown, m.image, m.svg]) if (typeof v === 'string') targets.push(v); }
const gone = targets.filter((t) => typeof t === 'string' && (!fs.existsSync(path.join(REPO, t)) || !ships(t)));
ok(`manifest targets (${targets.length}): each exists and ships`, gone.length === 0, gone.join(', '));

// 4. what ships, and what is in it
const all = []; const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); const r = rel(p); if (e.name === '.git' || r === 'node_modules') continue; if (e.isDirectory()) { walk(p); } else if (ships(r)) all.push(r); } };
walk(REPO);
const shipped = all.filter((f) => !f.endsWith('.vsix'));
const unreachable = shipped.filter((f) => /^out\/.*\.js$/.test(f) && !seen.has(path.join(REPO, f)) && !/^out\/mcp\/(server|run-task|provider-cli|cli)\.js$/.test(f));
ok('no compiled module ships that nothing loads', unreachable.length === 0, unreachable.join(', '));
const stray = shipped.filter((f) => /^(\.orchestrator|src|docs|\.claude|\.vscode|node_modules)\//.test(f) || /\.(map|ts|vsix)$/.test(f) || /(^|\/)(fixtures\.js|preview\.html)$/.test(f));
ok('nothing ships from the source, test or tooling directories', stray.length === 0, stray.slice(0, 8).join(', '));
const leaks = [];
for (const f of shipped) { const st = fs.statSync(path.join(REPO, f)); if (st.size > 4 * 1024 * 1024 || /\.(png|jpg|gif|ico|woff2?)$/.test(f)) continue; const text = fs.readFileSync(path.join(REPO, f), 'utf8');
  for (const m of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) if (!['x', 'me', 'you', 'name', 'user', 'alice', 'bob'].includes(m[1].toLowerCase())) leaks.push(`${f}: ${m[0]}`);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/(@users\.noreply\.github\.com|@example\.(com|org)|@x\.(com|y)$|@anthropic\.com|^git@github\.com|@toragonite\/|@[0-9])/.test(m[0]) && !/\.(png|js|json|md)$/i.test(m[0].split('@')[1] ?? '')) leaks.push(`${f}: ${m[0]}`); }
ok('no home-directory path or personal e-mail address in anything that ships', leaks.length === 0, [...new Set(leaks)].slice(0, 8).join(' | '));
const bytes = shipped.reduce((n, f) => n + fs.statSync(path.join(REPO, f)).size, 0);
console.log(`\nlet through by .vscodeignore (vsce applies a few defaults of its own on top): ${shipped.length} files, ${(bytes / 1048576).toFixed(1)} MiB — by directory: ` + Object.entries(shipped.reduce((acc, f) => { const d = f.includes('/') ? f.split('/').slice(0, f.startsWith('out/m') || f.startsWith('media/') ? 2 : 1).join('/') : '(root)'; acc[d] = (acc[d] ?? 0) + 1; return acc; }, {})).map(([d, n]) => `${d} ${n}`).join(', '));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
