#!/usr/bin/env node
/*
 * Checks the three READMEs, the walkthrough pages and the 2.0.0 changelog entry against the code.
 * Run from the repository root (no scratch directory, no network):
 *
 *   node .orchestrator/tools/docs/verify-docs.cjs            exit 0 only when every check passes
 *
 * What is checked:
 *
 *  A. every `claudeCodeOrchestrator.*` id written in a doc is a contributed command or a
 *     setting; every tool name is a tool the server defines; every dispatch argument is one of
 *     TASK_PROPERTIES; every removed name that is mentioned is really absent from the code;
 *  B. command titles quoted in prose are the nls titles of that language;
 *  C. every relative link, image path and in-page anchor resolves, and every screenshot exists;
 *  D. the three READMEs have the same structure: the same number of lines, and the SAME KIND of
 *     block on every line (heading level, table row, bullet, quote, paragraph), the same code
 *     tokens, numbers, links and table cells per line;
 *  E. the commands table lists exactly the commands package.json contributes (64) with this
 *     language's titles, and the settings table lists exactly the settings it contributes, each
 *     machine-scoped, with the default and the range;
 *  F. numbers and limits stated in the docs equal the constants in the code;
 *  G. the generated blocks are current; the changelog's top entry is 2.0.0 / 2026-10-13 with
 *     its groups; nothing forbidden appears (paths under /Users, e-mail addresses, finding ids,
 *     the words "reviewer" and "wave", other products, development-process paths);
 *  H. the manifest agrees with itself: nls key sets, walkthrough pages, registered commands.
 *
 * A line that starts with NOTE is advice, not a failure.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const here = __dirname;
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const repo = path.resolve(positional[0] || path.join(here, '..', '..', '..'));
const tsPath = path.join(repo, 'node_modules', 'typescript', 'lib', 'typescript.js');
if (!fs.existsSync(tsPath)) {
  console.error(`ERROR cannot find the TypeScript parser at ${tsPath} — run \`npm install\` in ${repo} first`);
  process.exit(2);
}
const ts = require(tsPath);
let failures = 0;
const fail = (m) => { failures++; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);
const note = (m) => console.log('NOTE ' + m);
const check = (cond, m, detail) => (cond ? ok(m) : fail(m + (detail ? ' — ' + detail : '')));
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(repo, rel));

const READMES = { en: 'README.md', ko: 'README.ko.md', zh: 'README.zh-CN.md' };
const NLS = { en: 'package.nls.json', ko: 'package.nls.ko.json', zh: 'package.nls.zh-cn.json' };
const WALK = fs.readdirSync(path.join(repo, 'media/walkthrough')).filter((f) => f.endsWith('.md')).map((f) => 'media/walkthrough/' + f);
const SCREENSHOTS = ['banner.png', 'panel-1.png', 'panel-2.png', 'sidebar.png', 'team.png', 'dashboard.png', 'dashboard-light.png', 'add-worker.png'];

const pkg = JSON.parse(read('package.json'));
const commands = new Set(pkg.contributes.commands.map((c) => c.command));
const props = pkg.contributes.configuration.properties;
const settings = new Set(Object.keys(props));
const shortSettings = new Set([...settings].map((s) => s.replace('claudeCodeOrchestrator.', '')));

// ---- tools and dispatch args, read from the server source with the TS parser ---------------
function parse(rel) { return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function findConst(sf, name) {
  let found;
  (function visit(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer;
    if (!found) ts.forEachChild(n, visit);
  })(sf);
  return found;
}
const unwrap = (n) => (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) ? unwrap(n.expression) : n);
function toolNames(arr, contractSf) {
  const out = [];
  for (const el of unwrap(arr).elements) {
    if (ts.isSpreadElement(el)) { out.push(...toolNames(findConst(contractSf, 'MESH_TOOLS'), contractSf)); continue; }
    const p = el.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === 'name');
    out.push(p.initializer.text);
  }
  return out;
}
const serverSf = parse('src/mcp/server.ts');
const contractSf = parse('src/mesh/contract.ts');
const tools = new Set(toolNames(findConst(serverSf, 'TOOLS'), contractSf));
const taskArgs = new Set(unwrap(findConst(serverSf, 'TASK_PROPERTIES')).properties.map((p) => p.name.getText()));
const stopArgs = new Set(['job_id', 'name', 'force', 'id', 'ids', 'tasks']);
console.log(`code: ${commands.size} commands, ${settings.size} settings, tools [${[...tools].join(', ')}], dispatch args [${[...taskArgs].join(', ')}]`);

// ---- removed names: must be absent from the code --------------------------------------------
const REMOVED_TOOLS = ['mesh_send_worker', 'mesh_receive', 'mesh_keep_worker'];
const REMOVED_SETTINGS = ['meshGatewayModel', 'meshWorkerIdleTimeoutMin'];
const REMOVED_COMMANDS = ['attachMeshWorker', 'meshWorkerLogs', 'stopMeshWorker'];
for (const t of REMOVED_TOOLS) check(!tools.has(t), `removed tool ${t} is not defined by the server`);
for (const s of REMOVED_SETTINGS) check(!shortSettings.has(s), `removed setting ${s} is not contributed`);
for (const c of REMOVED_COMMANDS) check(!commands.has('claudeCodeOrchestrator.' + c), `removed command ${c} is not contributed`);
check(!exists('src/mesh/gateway.ts'), 'src/mesh/gateway.ts (the relay gateway) does not exist');
const enBundle = JSON.parse(read('l10n/bundle.l10n.json'));
check(!('Attachable workers' in enBundle), 'the "Attachable workers" tree group has no runtime string any more');
const serverText = read('src/mcp/server.ts') + read('src/mesh/contract.ts') + read('src/mcp/bg-runner.ts');
for (const t of REMOVED_TOOLS) check(!new RegExp(`(case\\s+|name:\\s*)['"]${t}['"]`).test(serverText), `no handler or schema for ${t} in the server sources`);

// ---- A. ids, tool names and arguments written in the docs -----------------------------------
const TOOLISH = /^(dispatch_[a-z_]+|mesh_[a-z_]+|list_workers|orchestrator_briefing)$/;
const SNAKE_ARGS = /^(system_prompt|timeout_minutes|job_id|ultrathink|detach|provider|worker|model|prompt|title)$/;
const counts = { ids: 0, tools: 0, args: 0, shortSettings: 0, removedMentions: 0 };
const docs = [...Object.values(READMES), ...WALK, 'CHANGELOG.md'];
const changelogTop = (() => {
  const s = read('CHANGELOG.md');
  const a = s.indexOf('## [2.0.0]');
  const b = s.indexOf('\n## [', a + 5);
  return a < 0 ? '' : s.slice(a, b);
})();
for (const rel of docs) {
  const text = rel === 'CHANGELOG.md' ? changelogTop : read(rel);
  const tokens = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
  const bad = [];
  for (const tok of tokens) {
    const t = tok.replace(/\[\]$/, '');
    if (/^claudeCodeOrchestrator\.[A-Za-z]+$/.test(t)) {
      counts.ids++;
      const short = t.replace('claudeCodeOrchestrator.', '');
      if (REMOVED_SETTINGS.includes(short)) { counts.removedMentions++; continue; }
      if (!commands.has(t) && !settings.has(t)) bad.push(`${t} is neither a command nor a setting`);
    } else if (TOOLISH.test(t)) {
      counts.tools++;
      if (REMOVED_TOOLS.includes(t)) { counts.removedMentions++; continue; }
      if (!tools.has(t)) bad.push(`${t} is not a tool the server defines`);
    } else if (SNAKE_ARGS.test(t)) {
      counts.args++;
      if (!taskArgs.has(t) && !stopArgs.has(t)) bad.push(`${t} is not a tool argument`);
    } else if (shortSettings.has(t)) {
      counts.shortSettings++;
    } else if (REMOVED_SETTINGS.includes(t)) {
      counts.removedMentions++;
    } else if (/^(mesh|worker|frontier|overage|provider|session|quota|asset)[A-Z][A-Za-z]+$/.test(t)) {
      bad.push(`${t} looks like a setting but is not contributed`);
    }
  }
  check(bad.length === 0, `${rel}: every id, tool and argument named exists in the code`, bad.join('; '));
}
console.log(`     checked: ${counts.ids} full ids, ${counts.tools} tool names, ${counts.args} argument names, ${counts.shortSettings} short setting names, ${counts.removedMentions} mentions of removed names`);

// ---- B. command titles quoted in prose --------------------------------------------------------
const QUOTED = ['addWorker', 'importWorkers', 'installMcp', 'addDispatchPolicy', 'refreshUsage', 'togglePreferred', 'setWorkerPermissionMode', 'cancelTask', 'cancelAllTasks', 'cleanSessionLitter', 'openAssetManager', 'installTeamAgent', 'removeUnsupportedEntry'];
for (const [lang, rel] of Object.entries(READMES)) {
  const nls = JSON.parse(read(NLS[lang]));
  const text = read(rel);
  const missing = [];
  for (const id of QUOTED) {
    const title = nls[`command.${id}.title`];
    const lead = title.split(/ \(|（/)[0].trim();
    if (!text.includes(`**${lead}**`)) missing.push(`${id} → **${lead}**`);
  }
  check(missing.length === 0, `${rel}: the ${QUOTED.length} command names used in prose are this language's titles`, missing.join('; '));
}
for (const [lang, rel] of Object.entries(READMES)) {
  const nls = JSON.parse(read(NLS[lang]));
  const text = read(rel);
  const miss = ['view.workers.name', 'view.team.name', 'view.tasks.name', 'view.workerHistory.name'].filter((k) => !text.includes(nls[k]));
  check(miss.length === 0, `${rel}: the four view names appear as this language names them`, miss.join(', '));
}
{
  // the "Open File" action is quoted in prose; its translation is the runtime bundle's
  const bundles = { en: 'l10n/bundle.l10n.json', ko: 'l10n/bundle.l10n.ko.json', zh: 'l10n/bundle.l10n.zh-cn.json' };
  for (const [lang, rel] of Object.entries(READMES)) {
    const bundle = JSON.parse(read(bundles[lang]));
    const label = bundle['Open File'];
    if (typeof label !== 'string') { note(`${bundles[lang]} has no "Open File" string yet, so ${rel} cannot be checked against it`); continue; }
    check(read(rel).includes(`**${label}**`), `${rel}: the "Open File" action is written as the runtime bundle translates it (${label})`);
  }
}

// ---- C. links, images, anchors ---------------------------------------------------------------
const slug = (h) =>
  h.trim().toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
for (const rel of [...Object.values(READMES), ...WALK, 'docs/mesh-verification.md', 'docs/session-messaging-spike.md', 'docs/V1.3-DESIGN.md']) {
  const text = read(rel);
  const noCode = text.replace(/```[\s\S]*?```/g, '');
  const headings = new Set([...noCode.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
  const bad = [];
  let n = 0;
  for (const m of noCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|command:)/.test(target)) continue;
    n++;
    if (target.startsWith('#')) {
      if (!headings.has(decodeURIComponent(target.slice(1)))) bad.push(`anchor ${target}`);
      continue;
    }
    const [file, anchor] = target.split('#');
    const resolved = path.normalize(path.join(path.dirname(rel), file));
    if (!exists(resolved)) { bad.push(`missing ${target}`); continue; }
    if (anchor) {
      const hs = new Set([...read(resolved).matchAll(/^#{1,6}\s+(.+)$/gm)].map((x) => slug(x[1])));
      if (!hs.has(decodeURIComponent(anchor))) bad.push(`anchor ${target}`);
    }
  }
  check(bad.length === 0, `${rel}: ${n} relative links / images / anchors resolve`, bad.join('; '));
}
for (const img of SCREENSHOTS) {
  check(Object.values(READMES).every((r) => read(r).includes(`media/screenshots/${img}`)) && exists(`media/screenshots/${img}`), `screenshot media/screenshots/${img} is referenced by all three READMEs and is on disk`);
}

// ---- D. structural parity ----------------------------------------------------------------------
const shape = (rel) => {
  const text = read(rel);
  const noFence = text.replace(/```[\s\S]*?```/g, '```');
  return {
    headings: [...noFence.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length).join(''),
    tableRows: (noFence.match(/^\|/gm) || []).length,
    images: [...noFence.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u)).join(','),
    fences: (text.match(/^```/gm) || []).length,
    bullets: (noFence.match(/^\s*[-*] /gm) || []).length,
    numbered: (noFence.match(/^\s*\d+\. /gm) || []).length,
    lines: text.split('\n').length,
    codeTokens: [...new Set([...noFence.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((t) => /^[\x20-\x7e]+$/.test(t) && !/[<>]/.test(t)))].sort(),
    versions: [...new Set(noFence.match(/\b\d+\.\d+\.\d+\b/g) || [])].sort().join(','),
    blockMarkers: (text.match(/<!-- (BEGIN|END) GENERATED:/g) || []).length,
  };
};
const shapes = Object.fromEntries(Object.entries(READMES).map(([l, r]) => [l, shape(r)]));
for (const key of ['lines', 'headings', 'tableRows', 'images', 'fences', 'bullets', 'numbered', 'versions', 'blockMarkers']) {
  const vals = Object.values(shapes).map((s) => String(s[key]));
  check(new Set(vals).size === 1, `README parity: ${key} identical in all three (${key === 'headings' || key === 'images' ? vals[0].length + ' chars' : vals[0]})`, vals.join(' | '));
}
{
  const [a, b, c] = Object.values(shapes).map((s) => s.codeTokens);
  const only = (x, y) => x.filter((t) => !y.includes(t));
  const diff = [...only(a, b), ...only(b, a), ...only(a, c), ...only(c, a)];
  check(diff.length === 0, `README parity: the same ${a.length} language-neutral code tokens in all three`, [...new Set(diff)].join(' '));
}
{
  // Line by line: the same line of each file carries the same block, the same code tokens, the
  // same numbers, the same links and the same number of table cells.
  const L = Object.fromEntries(Object.entries(READMES).map(([k, f]) => [k, read(f).split('\n')]));
  // Code tokens with a placeholder in angle brackets are translated on purpose (`~/.claude-<name>`).
  const codes = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => !/[<>]/.test(t));
  // Single digits are skipped: "three" / "3개" / "三个" are the same number spelled three ways.
  const nums = (s) => [...s.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ' ').matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).filter((x) => x.length > 1);
  // The benchmark page exists once per language; the language switcher on line 3 links each file to the other two.
  const links = (s) => [...s.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1].replace(/^docs\/benchmarks(\.[A-Za-z-]+)?\.md$/, 'docs/benchmarks.md'));
  const kind = (s) =>
    s.startsWith('#') ? s.match(/^#+/)[0]
      : s.startsWith('|') ? '|'
        : s.startsWith('- ') ? '-'
          : /^\s+- /.test(s) ? ' -'
            : /^\d+\. /.test(s) ? '1.'
              : s.startsWith('>') ? '>'
                : s.startsWith('<!--') ? '<!--'
                  : s.startsWith('```') ? '```'
                    : s.trim() === '' ? '' : 'p';
  const n = Math.max(L.en.length, L.ko.length, L.zh.length);
  const issues = [];
  for (let i = 0; i < n; i++) {
    const e = L.en[i] ?? '';
    for (const lang of ['ko', 'zh']) {
      const o = L[lang][i] ?? '';
      const msgs = [];
      if (kind(e) !== kind(o)) msgs.push(`kind ${JSON.stringify(kind(e))} vs ${JSON.stringify(kind(o))}`);
      const ce = codes(e).sort(), co = codes(o).sort();
      const missing = ce.filter((x) => !co.includes(x)), extra = co.filter((x) => !ce.includes(x));
      // the code-fenced diagram and the provider table translate some labels on purpose
      if (missing.length || extra.length) msgs.push(`code missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
      else if (ce.length !== co.length) msgs.push(`code count ${ce.length} vs ${co.length}`);
      const ne = nums(e).sort(), no = nums(o).sort();
      const nm = ne.filter((x) => !no.includes(x)), nx = no.filter((x) => !ne.includes(x));
      if (nm.length || nx.length) msgs.push(`numbers missing=${JSON.stringify(nm)} extra=${JSON.stringify(nx)}`);
      if (e.startsWith('|') && e.split('|').length !== o.split('|').length) msgs.push(`table cells ${e.split('|').length} vs ${o.split('|').length}`);
      if (i !== 2) {
        const le = links(e).filter((x) => !x.startsWith('#')).sort().join(','), lo = links(o).filter((x) => !x.startsWith('#')).sort().join(',');
        if (le !== lo) msgs.push(`links ${le} vs ${lo}`);
        if (links(e).length !== links(o).length) msgs.push(`link count ${links(e).length} vs ${links(o).length}`);
      }
      if (msgs.length) issues.push(`line ${i + 1} [${lang}] ${msgs.join('; ')}`);
    }
  }
  check(issues.length === 0, 'README line parity: on every line the three files carry the same block, code tokens, numbers, links and table cells', issues.slice(0, 12).join(' || ') + (issues.length > 12 ? ` || … ${issues.length - 12} more` : ''));
  // advisory: a negation or an "only" that exists in English and has no counterpart
  const cnt = (re, s) => (s.match(re) || []).length;
  const advice = [];
  let fenced = false;
  for (let i = 0; i < L.en.length; i++) {
    const e = L.en[i];
    if (e.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || e.startsWith('<!--') || e.startsWith('|')) continue;
    // quoted English error texts ("Not inside a trusted directory") carry their own negation
    if (/"[^"]*\b(Not|not|No|no)\b[^"]*"/.test(e)) continue;
    const eNeg = cnt(/\b(never|not|no|cannot|nothing|neither|nor|without|isn't|don't|doesn't|won't)\b/gi, e);
    const kNeg = cnt(/않|없|못|절대|아니|말고|안 |불가|미검증|제외|금지|없이|아닌|아닙|어떤|거부|무시|건드리지/g, L.ko[i] || '');
    const zNeg = cnt(/不|没|无|未|非|勿|别|绝|拒|忽略|无法/g, L.zh[i] || '');
    if (eNeg > 0 && kNeg === 0) advice.push(`line ${i + 1} ko`);
    if (eNeg > 0 && zNeg === 0) advice.push(`line ${i + 1} zh`);
  }
  if (advice.length) note(`negation worth a human look (English has a negative, the translation shows none): ${advice.join(', ')}`);
}

// ---- E. commands table and settings table -----------------------------------------------------
const blockOf = (text, name) => {
  const m = new RegExp(`<!-- BEGIN GENERATED:${name}[^>]*-->\\n([\\s\\S]*?)\\n<!-- END GENERATED:${name} -->`).exec(text);
  return m ? m[1].split('\n') : [];
};
const tableCells = (line) => line.replace(/^\|\s*/, '').replace(/\s*\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const wantCommandIds = pkg.contributes.commands.map((c) => c.command);
check(wantCommandIds.length === 64, 'package.json contributes 64 commands', String(wantCommandIds.length));
for (const [lang, rel] of Object.entries(READMES)) {
  const nls = JSON.parse(read(NLS[lang]));
  const rows = blockOf(read(rel), 'commands').filter((l) => l.startsWith('| ') && l.includes('`claudeCodeOrchestrator.'));
  const gotIds = rows.map((r) => tableCells(r)[1].replace(/`/g, ''));
  check(JSON.stringify(gotIds) === JSON.stringify(wantCommandIds), `${rel}: the commands table lists exactly the ${wantCommandIds.length} commands of package.json, in order`, `table has ${gotIds.length}; missing ${wantCommandIds.filter((c) => !gotIds.includes(c)).join(', ') || 'none'}; extra ${gotIds.filter((c) => !wantCommandIds.includes(c)).join(', ') || 'none'}`);
  const badTitle = [];
  for (const r of rows) {
    const cells = tableCells(r);
    const c = pkg.contributes.commands.find((x) => x.command === cells[1].replace(/`/g, ''));
    if (c && nls[c.title.replace(/%/g, '')] !== cells[0].replace(/<br>/g, '\n')) badTitle.push(c.command);
    if (cells[2] === '') badTitle.push(`${cells[1]} has no "where it appears"`);
  }
  check(badTitle.length === 0, `${rel}: every command title in the table is this language's nls title`, badTitle.join(', '));
}
// The range the code clamps a setting to must be the range the manifest declares.
const srcRanges = (() => {
  const wm = read('src/workerManager.ts');
  const n = (name) => Number(new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(wm)[1]);
  return { 'claudeCodeOrchestrator.quotaCooldownMinutes': [n('COOLDOWN_MINUTES_MIN'), n('COOLDOWN_MINUTES_MAX')] };
})();
for (const [key, [lo, hi]] of Object.entries(srcRanges)) {
  check(props[key].minimum === lo && props[key].maximum === hi, `package.json declares ${key} as ${lo}–${hi}, the range the code clamps to`, `manifest says ${props[key].minimum}–${props[key].maximum}`);
}
check(Object.entries(props).every(([, p]) => p.scope === 'machine'), 'package.json: every setting is declared "scope": "machine"');
for (const [lang, rel] of Object.entries(READMES)) {
  const nls = JSON.parse(read(NLS[lang]));
  const rows = blockOf(read(rel), 'settings').filter((l) => l.startsWith('| `claudeCodeOrchestrator.'));
  const gotKeys = rows.map((r) => tableCells(r)[0].replace(/`/g, ''));
  check(JSON.stringify(gotKeys) === JSON.stringify([...settings]), `${rel}: the settings table lists exactly the ${settings.size} settings of package.json, in order`, `missing ${[...settings].filter((k) => !gotKeys.includes(k)).join(', ') || 'none'}; extra ${gotKeys.filter((k) => !settings.has(k)).join(', ') || 'none'}`);
  const bad = [];
  for (const r of rows) {
    const cells = tableCells(r);
    const key = cells[0].replace(/`/g, '');
    const p = props[key];
    if (!p) continue;
    if (cells[2] !== '`' + JSON.stringify(p.default) + '`') bad.push(`${key} default ${cells[2]}`);
    const range = p.minimum !== undefined || p.maximum !== undefined ? [p.minimum, p.maximum] : undefined;
    const want = p.enum ? p.enum.map((e) => '`' + e + '`').join(', ') : range ? `\`${range[0]}\`–\`${range[1]}\`` : '—';
    if (cells[3] !== want) bad.push(`${key} allowed ${cells[3]} (want ${want})`);
    if (cells.slice(4).join(' | ') !== nls[p.description.replace(/%/g, '')].replace(/\n/g, '<br>')) bad.push(`${key} description differs from ${NLS[lang]}`);
  }
  check(bad.length === 0, `${rel}: each setting's default, allowed range and description match package.json and ${NLS[lang]}`, bad.join('; '));
  check(/User settings/.test(read(rel)), `${rel}: states that settings are read from User settings only`);
  const quota = rows.find((r) => r.includes('quotaCooldownMinutes'));
  check(quota !== undefined && tableCells(quota)[3] === '`1`–`1440`', `${rel}: quotaCooldownMinutes is documented as 1–1440`);
}

// ---- F. numbers and limits stated in the docs ----------------------------------------------------
const platform = read('src/platform.ts');
const minVersion = /MIN_CLAUDE_VERSION_FOR_SESSION_WORKERS = '([\d.]+)'/.exec(platform)[1];
const ext = read('src/extension.ts');
const registryText = read('src/registry.ts');
const argsText = read('src/mcp/dispatch-args.ts');
const numberOf = (text, re) => { const m = re.exec(text); return m ? m[1].replace(/_/g, '') : 'not found'; };
const facts = [
  ['minimum Claude Code version for session workers', minVersion, '2.1.283'],
  ['meshMaxLiveWorkers default', String(props['claudeCodeOrchestrator.meshMaxLiveWorkers'].default), '8'],
  ['workerTimeoutMinutes default', String(props['claudeCodeOrchestrator.workerTimeoutMinutes'].default), '45'],
  ['workerTimeoutMinutes range', `${props['claudeCodeOrchestrator.workerTimeoutMinutes'].minimum}–${props['claudeCodeOrchestrator.workerTimeoutMinutes'].maximum}`, '1–480'],
  ['quotaCooldownMinutes range (enforced in code)', srcRanges['claudeCodeOrchestrator.quotaCooldownMinutes'].join('–'), '1–1440'],
  ['workerPermissionMode default', props['claudeCodeOrchestrator.workerPermissionMode'].default, 'acceptEdits'],
  ['frontierWorkerDispatch default', props['claudeCodeOrchestrator.frontierWorkerDispatch'].default, 'block'],
  ['overageWorkerDispatch default', props['claudeCodeOrchestrator.overageWorkerDispatch'].default, 'block'],
  ['meshMode default', String(props['claudeCodeOrchestrator.meshMode'].default), 'false'],
  ['providerUsagePolling default', String(props['claudeCodeOrchestrator.providerUsagePolling'].default), 'true'],
  ['usage refresh interval (5 min)', String(/\}, (5 \* 60 \* 1000)\);/.test(ext)), 'true'],
  ['stale-file cleanup delay (15 s)', numberOf(ext, /LITTER_STARTUP_DELAY_MS = ([\d_]+)/), '15000'],
  ['stale-file cleanup interval (24 h)', /LITTER_MIN_INTERVAL_MS = ([^;]+);/.exec(ext)[1], '24 * 60 * 60 * 1000'],
  ['stale-file cleanup minimum age (10 min)', /DEFAULT_MIN_AGE_MS = ([^;]+);/.exec(read('src/sessionLitter.ts'))[1], '10 * 60_000'],
  ['engine', pkg.engines.vscode, '^1.90.0'],
  ['version', pkg.version, '2.0.1'],
  ['team agent file', /TEAM_AGENT_FILE = '([^']+)'/.exec(read('src/teamAgent.ts'))[1], '.claude/agents/cco-worker.md'],
  ['worktree path', String(/path\.join\('\.claude', 'worktrees', bgWorktreeName\(taskId\)\)/.test(read('src/mesh/contract.ts'))), 'true'],
  ['worktree branch prefix', String(/return `worktree-\$\{bgWorktreeName\(taskId\)\}`/.test(read('src/mesh/contract.ts'))), 'true'],
  ['one-shot fallback prefix (mesh unavailable)', String(read('src/mcp/server.ts').includes('⚠ mesh unavailable — ran as a one-shot worker (not attachable): ')), 'true'],
  ['one-shot fallback prefix (untrusted workspace)', String(read('src/mcp/server.ts').includes('⚠ ran as a one-shot worker (not attachable): ')), 'true'],
  ['model aliases', /MODEL_ALIASES = \[([^\]]+)\]/.exec(platform)[1].replace(/['\s]/g, ''), 'opus,sonnet,fable,haiku'],
  // The table's form changed (an object, then a Map of pairs); the fact is the three id → alias entries.
  ['legacy ids read as aliases', String([['claude-opus-4-8', 'opus'], ['claude-sonnet-5', 'sonnet'], ['claude-fable-5', 'fable']].every(([id, alias]) => new RegExp(`['"]${id.replace(/[.]/g, '\\.')}['"]\\s*[,:]\\s*['"]${alias}['"]`).test(platform))), 'true'],
  ['environment removed for vendor processes: ANTHROPIC_*, CLAUDE_*, CLAUDECODE', String(/\/\^\(ANTHROPIC_\|CLAUDE_\)\/\.test\(name\) \|\| name === 'CLAUDECODE'/.test(platform)), 'true'],
  ['dashboard page served under a strict CSP', String(read('src/dashboard.ts').includes("`default-src 'none'`")), 'true'],
  ['dashboard page builds no HTML from data', String(!/innerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(read('media/dashboard/dashboard.js'))), 'true'],
  ['dispatch_tasks task cap', numberOf(argsText, /DISPATCH_BATCH_MAX_TASKS = ([\d_]+)/), '100'],
  ['prompt limit (bytes, 1 MiB)', numberOf(argsText, /DISPATCH_PROMPT_MAX_BYTES = ([\d_]+)/), '1048576'],
  ['system_prompt limit (bytes, 256 KiB)', numberOf(argsText, /DISPATCH_SYSTEM_PROMPT_MAX_BYTES = ([\d_]+)/), '262144'],
  ['title limit (characters)', numberOf(argsText, /DISPATCH_TITLE_MAX_CHARS = ([\d_]+)/), '200'],
  ['model / worker / provider limit (characters)', numberOf(argsText, /DISPATCH_NAME_MAX_CHARS = ([\d_]+)/), '200'],
  ['dispatch_status id cap', numberOf(read('src/mcp/server.ts'), /const STATUS_MAX_IDS = ([\d_]+)/), '100'],
  ['result text returned whole up to (bytes, 1 MiB)', numberOf(read('src/mcp/server.ts'), /const RELAY_TEXT_MAX_BYTES = ([\d_]+)/), '1048576'],
  ['one-shot output cap (8 MiB)', numberOf(read('src/mcp/task-runner.ts'), /const STDOUT_CAP_BYTES = (\d+ \* 1024 \* 1024)/).replace(/ /g, ''), '8*1024*1024'],
  ['maxConcurrentDispatches default', numberOf(registryText, /DISPATCH_CONCURRENCY_DEFAULT = (\d+)/), '8'],
  ['maxConcurrentDispatches range', `${numberOf(registryText, /DISPATCH_CONCURRENCY_MIN = (\d+)/)}–${numberOf(registryText, /DISPATCH_CONCURRENCY_MAX = (\d+)/)}`, '1–64'],
  ['registry key vendorWorkers', String(/WORKER_SOURCES = \['workers', 'vendorWorkers'\]/.test(registryText)), 'true'],
  ['registry file read cap (1 MiB)', numberOf(registryText, /const STATE_FILE_MAX_BYTES = (\d+ \* 1024)/).replace(/ /g, ''), '1024*1024'],
  ['data directory mode', numberOf(registryText, /const DATA_DIR_MODE = (0o\d+)/), '0o700'],
  ['data file mode', numberOf(registryText, /const DATA_FILE_MODE = (0o\d+)/), '0o600'],
  ['Tasks view row window', numberOf(read('src/uiModel.ts'), /export const TASK_LIST_MAX = (\d+)/), '300'],
  ['a task dated this far ahead has no time (5 min)', /const CLOCK_SLACK_MS = ([^;]+);/.exec(read('src/uiModel.ts'))[1], '5 * 60_000'],
  ['task index: bytes compared at the head of the log', numberOf(read('src/uiModel.ts'), /const LOG_HEAD_BYTES = (\d+)/), '256'],
  ['task index: bytes compared before the read position', numberOf(read('src/uiModel.ts'), /const LOG_TAIL_BYTES = (\d+)/), '64'],
  ['task index: full rebuild at most this often (10 min)', /const LOG_FULL_REBUILD_MS = ([^;]+);/.exec(read('src/uiModel.ts'))[1], '10 * 60_000'],
  ['worker name length limit', numberOf(read('src/workerManager.ts'), /export const WORKER_NAME_MAX = (\d+)/), '64'],
  ['worker name alphabet', String(read('src/workerManager.ts').includes('!/^[\\w-]+$/.test(name)')), 'true'],
  ['a record of an unconfigured account is kept this long past its time (24 h)', /const UNCHECKABLE_RECORD_GRACE_MS = ([^;]+);/.exec(read('src/mesh/reaper.ts'))[1], '24 * 60 * 60 * 1000'],
  ['a mesh_status worker that cannot be looked at reads unknown', String(/`unknown \(\$\{unknownWhy\}\)`/.test(read('src/mcp/server.ts'))), 'true'],
  ['session end stops owned workers without asking the registry for them', String(read('src/mesh/reaper.ts').includes('spawnVettedConfigDir(rec.configDir)')), 'true'],
  ['ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are left alone for Claude Code workers', String(/`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and provider selectors are deliberately left\s*\n\s*\* alone/.test(platform)), 'true'],
  ['import offers only real directories that look like a Claude Code config dir', String(/isRealDirectory\(dir\) \|\| !looksLikeClaudeConfigDir\(dir\)/.test(read('src/workerManager.ts'))), 'true'],
  ['the dashboard hint says a Mesh Mode change applies at the next dispatch', String(/groupSessionNote: vscode\.l10n\.t\('Changes take effect at the next dispatch\.'\)/.test(read('src/dashboard.ts'))), 'true'],
  ['lock wait (15 s)', numberOf(registryText, /const LOCK_ACQUIRE_TIMEOUT_MS = ([\d_]+)/), '15000'],
  ['vendor login-failure skip (30 min)', /RUN_LOGIN_FAILURE_STICKY_MS = ([^;]+);/.exec(read('src/usage.ts'))[1], '30 * 60 * 1000'],
  ['finished result files kept (24 h)', /IO_ARTIFACT_MAX_AGE_MS = ([^;]+);/.exec(read('src/mesh/reaper.ts'))[1], '24 * 60 * 60 * 1000'],
  ['asset install paths: reads are capped (16 MiB), non-blocking and no-follow; writes replace the name', String(/const ASSET_FILE_MAX_BYTES = 16 \* 1024 \* 1024;/.test(read('src/assets.ts')) && /const READ_GUARDED =[\s\S]*O_NONBLOCK[\s\S]*O_NOFOLLOW/.test(read('src/assets.ts')) && /function replaceFile\(/.test(read('src/assets.ts'))), 'true'],
  ['asset ledger read cap (8 MiB)', /STATE_READ_MAX_BYTES = ([^;]+);/.exec(read('src/assets.ts'))[1].replace(/ /g, ''), '8*1024*1024'],
  ['.mcp.json read cap (1 MiB)', /MCP_JSON_MAX_BYTES = ([^;]+);/.exec(ext)[1].replace(/ /g, ''), '1024*1024'],
  ['session-worker tool list', String(read('src/mesh/pool.ts').includes("'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep'")), 'true'],
  ['auto-commit skips hooks and signing', String(/'--no-verify',\s*'--no-gpg-sign'/.test(read('src/mcp/bg-runner.ts'))), 'true'],
  ['bundled Cursor adapter sends --trust', String(/if \(this\.trust\) args\.push\("--trust"\)/.test(fs.readFileSync(path.join(repo, 'node_modules/@toragonite/agent-mesh-cursor/dist/index.js'), 'utf8'))), 'true'],
  ['Codex login is also asked of `codex login status`', String(read('src/mcp/provider-runner.ts').includes("args: ['login', 'status']")), 'true'],
];
for (const [name, got, want] of facts) check(got === want, `fact: ${name} = ${want}`, `code says ${got}`);
// what the README must say for the numbers above to be findable by a reader
const SAME = (re) => ({ en: re, ko: re, zh: re });
const README_PHRASES = [
  ['the batch cap (1 to 100 tasks)', { en: /1 to 100 tasks/, ko: /1개에서 100개/, zh: /1 到 100 个任务/ }],
  ['the dispatch_status cap (100 ids)', { en: /up to 100 `ids`/, ko: /최대 100개의 `ids`/, zh: /最多 100 个 `ids`/ }],
  ['the title cut (200 characters)', { en: /200 characters/, ko: /200자/, zh: /200 个字符/ }],
  ['the Tasks view window (300 tasks)', { en: /newest 300 tasks/, ko: /최신 작업 300개/, zh: /最新的 300 个任务/ }],
  ['the result size note (1 MiB)', SAME(/1 MiB/)], ['the system_prompt limit (256 KiB)', SAME(/256 KiB/)], ['the output cap (8 MiB)', SAME(/8 MiB/)],
  ['`maxConcurrentDispatches`', SAME(/`maxConcurrentDispatches`/)], ['`vendorWorkers`', SAME(/`vendorWorkers`/)],
  ['the data directory mode `0700`', SAME(/`0700`/)], ['the file mode `0600`', SAME(/`0600`/)], ['the Cursor flag `--trust`', SAME(/`--trust`/)],
  ['the commit flags `--no-verify --no-gpg-sign`', SAME(/`--no-verify --no-gpg-sign`/)], ['the pre-approved tools (`ListAgents`)', SAME(/`ListAgents`/)],
  ['the Codex login check `codex login status`', SAME(/`codex login status`/)], ['User settings', SAME(/User settings/)], ['the asset install-path size limit (16 MiB)', SAME(/16 MiB/)],
  ['the worker name length (64)', { en: /at most 64 characters/, ko: /최대 64자/, zh: /最长 64 个字符/ }],
  ['the `unknown` state of a worker that cannot be looked at', SAME(/`unknown`/)], ['the manual stop command', SAME(/`claude stop <job id>`/)],
  ['the two dated live runs', SAME(/2026-10-13[\s\S]*2026-10-14/)],
  ['`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` reach Claude Code workers', SAME(/`ANTHROPIC_API_KEY`(?:와 | and | 和 )`ANTHROPIC_AUTH_TOKEN`/)],
];
for (const [name, res] of README_PHRASES) {
  const missing = Object.entries(READMES).filter(([l, f]) => !res[l].test(read(f))).map(([l]) => l);
  check(missing.length === 0, `README states ${name} (all three languages)`, missing.join(', '));
}
// provider table: every CLI name and permission mode in the README table exists in providers.ts
const providers = read('src/providers.ts');
for (const tok of ['codex', 'cursor-agent', 'agy', 'workspace-write', 'read-only', 'danger-full-access', 'enabled', 'disabled', 'accept-edits', 'plan', 'CODEX_HOME', 'AGY_HOME']) {
  check(providers.includes(`'${tok}'`), `provider table: '${tok}' is in src/providers.ts`);
}
for (const rel of Object.values(READMES)) {
  const t = read(rel);
  check(t.includes('2.1.283') && !/2\.1\.224 or newer|2\.1\.224 이상\b(?!\))/.test(t.replace(/\(1\.5[^)]*\)/g, '')), `${rel}: states 2.1.283 as the session-worker minimum`);
}
// claims the docs must not make any more
const STALE_CLAIMS = [
  [/make no network requests of their own|自身不发起任何网络请求|자체적으로 네트워크 요청을 하지 않습니다/, 'the extension and the server make no network requests'],
  [/reported, not removed|제거하지 않고 보고합니다|只会被报告，不会被移除/, 'workers whose owner is gone are only reported'],
  [/takes effect in the next Claude Code session|다음 Claude Code 세션부터 적용|下一个 Claude Code 会话中生效/, 'Mesh Mode takes effect in the next session'],
  [/delete it to remove every trace|모든 흔적을 지우려면|删除它即可清除所有痕迹/, 'delete the data directory to remove every trace'],
  [/checked in a browser preview, not in a running editor|브라우저 미리보기에서 확인했습니다|是在浏览器预览中检查的/, 'the dashboard was checked only in a browser preview'],
  [/never adds a flag that escalates|상향하는 플래그를 절대 추가하지|绝不会添加任何提升权限的参数/, 'the extension never adds a flag that escalates'],
  [/without a shell tool|셸 도구 없이|不带 shell 工具/, 'a session worker is started without a shell tool'],
  [/into the \*\*new\*\* account folder only|\*\*새\*\* 계정 폴더에만|只把这一行写入\*\*新\*\*的账号文件夹/, 'the keychain line goes into the new account folder only'],
  [/still detects the login and dispatches normally|감지하고 정상적으로 디스패치하지만|仍能检测到登录并正常分发/, 'with the keychain option the login is detected (stated as fact)'],
  [/true parallel/i, '"true parallel execution"'],
  [/predate the result tokens|result tokens, the forced-stop identity check and the no-follow file reads/i, 'the live runs predate the result tokens'],
  [/the extension stops it when the session that owns it ends|소유한 세션이 끝나면 확장이 중지를 시도|所属会话结束时扩展会尽力停止它/, 'the extension stops a session worker at session end (it is the dispatch server)'],
  [/Changes take effect in the next Claude Code session/i, 'a Mesh Mode change takes effect in the next session'],
];
for (const [re, what] of STALE_CLAIMS) {
  const hits = [...Object.values(READMES), ...WALK].filter((f) => re.test(read(f)));
  check(hits.length === 0, `no doc still claims: ${what}`, hits.join(', '));
}
{
  // The dispatch server reads the Mesh Mode switch at each dispatch; the dashboard hint, its
  // preview fixtures and the runtime bundles must say so too.
  const hint = /groupSessionNote: vscode\.l10n\.t\('([^']+)'\)/.exec(read('src/dashboard.ts'));
  check(hint !== null && !/next Claude Code session/i.test(hint[1]), 'the dashboard hint about Mesh Mode does not say "next Claude Code session"', hint ? hint[1] : 'hint not found');
  if (exists('media/dashboard/fixtures.js')) {
    const fx = /groupSessionNote:\s*"([^"]+)"/.exec(read('media/dashboard/fixtures.js'));
    if (fx && hint && fx[1] !== hint[1]) note(`media/dashboard/fixtures.js still reads "${fx[1]}", the source reads "${hint[1]}" (the localization worker regenerates the fixtures)`);
  }
}

// ---- G. generated blocks, changelog, forbidden items ----------------------------------------------
try {
  const out = execFileSync(process.execPath, [path.join(here, 'gen-readme-blocks.cjs'), repo, '--check'], { encoding: 'utf8' });
  check(/all generated blocks are current/.test(out), 'generated README blocks (settings, commands, tools, params) are current in all three languages');
} catch (e) {
  fail('generated README blocks are stale: ' + (e.stdout || e.message));
}
const cl = read('CHANGELOG.md');
// The newest DATED entry is package.json's version; only "— unreleased" entries may sit above it.
{
  const heads = cl.match(/^## \[[^\]]+\] — .*$/gm) || [];
  const firstDated = heads.findIndex((h) => !/ — unreleased$/.test(h));
  const pkgVersion = JSON.parse(read('package.json')).version;
  check(firstDated >= 0 && heads[firstDated].startsWith(`## [${pkgVersion}] — `), `CHANGELOG: the newest dated entry is package.json's version ${pkgVersion}`, heads[firstDated]);
  check(/^## \[2\.0\.0\] — 2026-10-20$/m.test(cl), 'CHANGELOG: 2.0.0 is dated 2026-10-20 (its release)');
}
for (const g of ['Breaking', 'Added', 'Changed', 'Fixed', 'Security', 'Removed']) check(changelogTop.includes(`\n### ${g}\n`), `CHANGELOG 2.0.0 has a "${g}" group`);
check(!/\[Unreleased\]|## \[1\.6\.0\]/.test(cl), 'CHANGELOG has no [Unreleased] or [1.6.0] block');
for (const rel of [...Object.values(READMES), ...WALK, 'CHANGELOG.md']) {
  const t = rel === 'CHANGELOG.md' ? changelogTop : read(rel);
  check(!/LOGINS-SECTION|TODO|TBD|FIXME|XXX/.test(t), `${rel}: no placeholder left`);
}
const DENY = /\b(ccusage|claude-squad|Aider|Copilot|Windsurf|Cline|Roo Code|Devin|Continue\.dev|Zed|JetBrains|OpenAI|ChatGPT|Google|Gemini CLI|Amp|Goose|OpenCode|Kiro)\b/;
const userDocs = { ...Object.fromEntries([...Object.values(READMES), ...WALK].map((f) => [f, read(f)])), 'CHANGELOG.md (2.0.0 entry)': changelogTop };
for (const [rel, t] of Object.entries(userDocs)) check(!DENY.test(t), `${rel}: names no unrelated tool or competitor`, (DENY.exec(t) || [])[0]);
const FORBIDDEN = [
  ['a /Users/ path', /\/Users\//],
  ['a Windows user path', /[A-Za-z]:\\Users\\/],
  ['an e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['a finding id (R1-5, R2-F3, K13)', /\bR\d+-F?\d+\b|\bK\d{1,2}\b/],
  ['the word "reviewer"', /\breviewers?\b/i],
  ['the word "wave"', /\bwaves?\b/i],
  ['a development-process path', /\.orchestrator\/|internal\/research/],
  ['a private home directory', /~\/\.claude-(?!code-orchestrator)[A-Za-z0-9]+\/(?!sessions|worktrees)/],
];
for (const [what, re] of FORBIDDEN) {
  const hits = Object.entries(userDocs).filter(([, t]) => re.test(t.replace(/<!--[\s\S]*?-->/g, ''))).map(([f, t]) => `${f}: ${(re.exec(t.replace(/<!--[\s\S]*?-->/g, '')) || [])[0]}`);
  check(hits.length === 0, `no user document contains ${what}`, hits.join('; '));
}
for (const rel of ['package.json', 'package.nls.json', 'package.nls.ko.json', 'package.nls.zh-cn.json', 'l10n/bundle.l10n.json', 'l10n/bundle.l10n.ko.json', 'l10n/bundle.l10n.zh-cn.json']) {
  try { JSON.parse(read(rel)); } catch (e) { fail(`${rel} does not parse: ${e.message}`); }
}
ok('all seven JSON files parse');

// ---- the package check exists, and the READMEs state no size or file count for the package -------
check(exists('.orchestrator/tools/pkg/verify-package.cjs'), 'the offline package check .orchestrator/tools/pkg/verify-package.cjs exists (it needs a build, so this script does not run it)');
for (const [lang, rel] of Object.entries(READMES)) {
  const hits = read(rel).split('\n').filter((l) => /\.vsix|package size|packaged|the package|VSIX|패키지|扩展包|打包/.test(l) && /\b\d[\d,.]*\s*(files?|kB|KB|MB|MiB|KiB|개 파일|个文件|파일)\b/.test(l));
  check(hits.length === 0, `${rel}: states no file count or size for the package`, hits.map((l) => l.slice(0, 80)).join(' | '));
}

// ---- H. the manifest agrees with itself ------------------------------------------------------------
{
  const nls = Object.fromEntries(Object.entries(NLS).map(([l, f]) => [l, JSON.parse(read(f))]));
  const used = [...new Set([...read('package.json').matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]))];
  for (const [lang, o] of Object.entries(nls)) {
    const missing = used.filter((k) => !(k in o));
    check(missing.length === 0, `${NLS[lang]}: every %key% used in package.json is present (${used.length})`, missing.join(', '));
  }
  const all = new Set(Object.values(nls).flatMap((o) => Object.keys(o)));
  const uneven = [...all].filter((k) => !('en' in nls && k in nls.en && k in nls.ko && k in nls.zh));
  check(uneven.length === 0, 'the three package.nls files carry the same keys', uneven.join(', '));
  const walkMissing = [];
  for (const w of pkg.contributes.walkthroughs || []) for (const s of w.steps) if (s.media && s.media.markdown && !exists(s.media.markdown)) walkMissing.push(s.media.markdown);
  check(walkMissing.length === 0, 'every walkthrough step points at a page that exists', walkMissing.join(', '));
  const badCmdLinks = [];
  for (const [lang, o] of Object.entries(nls)) for (const [k, v] of Object.entries(o)) for (const m of String(v).matchAll(/command:([A-Za-z.]+)/g)) if (!commands.has(m[1])) badCmdLinks.push(`${lang}:${k}:${m[1]}`);
  check(badCmdLinks.length === 0, 'every command: link in the nls files names a contributed command', badCmdLinks.join(', '));
  const srcAll = fs.readdirSync(path.join(repo, 'src'), { recursive: true }).filter((f) => f.endsWith('.ts')).map((f) => read('src/' + f)).join('\n');
  // Also accepts an id-keyed handler map (`'id': (arg) => …`) that extension.ts registers in a loop.
  const unregistered = [...commands].filter((c) => !new RegExp(`(registerCommand|guardedCommand)\\(\\s*['"]${c.replace(/\./g, '\\.')}['"]|^\\s*['"]${c.replace(/\./g, '\\.')}['"]\\s*:\\s*(async\\s*)?\\(`, 'm').test(srcAll));
  check(unregistered.length === 0, 'every contributed command is registered in src/', unregistered.join(', '));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
