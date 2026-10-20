// P-SHELL (wave 2) verification: manifest / nls / command-registration consistency.
// The wave-1 checks of ext-verify.js, unchanged except where marked WAVE2, plus the provider checks at the end.
// Usage: node ext-verify.js <repo root>
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
};

// 1. package.json parses
let pkg;
try {
  pkg = JSON.parse(read('package.json'));
  check('package.json parses', true, `version ${pkg.version}`);
} catch (e) {
  check('package.json parses', false, e.message);
  process.exit(1);
}
check('version is 2.0.1', pkg.version === '2.0.1', pkg.version);

const NLS = { en: 'package.nls.json', ko: 'package.nls.ko.json', 'zh-cn': 'package.nls.zh-cn.json' };
const nls = {};
for (const [lang, file] of Object.entries(NLS)) {
  try {
    nls[lang] = JSON.parse(read(file));
  } catch (e) {
    check(`${file} parses`, false, e.message);
    process.exit(1);
  }
}

// 2. %key% usage vs. the three nls files
const pkgText = read('package.json');
const used = [...new Set([...pkgText.matchAll(/%([A-Za-z0-9_.-]+)%/g)].map((m) => m[1]))];
for (const lang of Object.keys(nls)) {
  const missing = used.filter((k) => !(k in nls[lang]));
  check(`every %key% in package.json exists in ${NLS[lang]}`, missing.length === 0, missing.join(', ') || `${used.length} keys`);
}
const keySets = Object.fromEntries(Object.entries(nls).map(([l, d]) => [l, Object.keys(d)]));
for (const a of Object.keys(nls)) {
  for (const b of Object.keys(nls)) {
    if (a === b) continue;
    const extra = keySets[a].filter((k) => !(k in nls[b]));
    check(`${NLS[a]} has no key ${NLS[b]} lacks`, extra.length === 0, extra.join(', ') || `${keySets[a].length} keys`);
  }
}
const sameOrder = Object.values(keySets).every((ks) => ks.join('|') === keySets.en.join('|'));
check('the three nls files list their keys in the same order', sameOrder);
const unused = keySets.en.filter((k) => !used.includes(k));
check('no nls key is unused by package.json', unused.length === 0, unused.join(', '));
for (const lang of Object.keys(nls)) {
  const blank = Object.entries(nls[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
  check(`${NLS[lang]} has no blank value`, blank.length === 0, blank.join(', '));
}
// translated: ko / zh-cn values must differ from English except for proper nouns
const PROPER = new Set(['viewsContainer.title', 'command.category', 'configuration.title']);
for (const lang of ['ko', 'zh-cn']) {
  const same = keySets.en.filter((k) => !PROPER.has(k) && nls[lang][k] === nls.en[k]);
  check(`${NLS[lang]} is translated (no value identical to English)`, same.length === 0, same.join(', '));
}
const hangul = /[가-힣]/;
const han = /[一-鿿]/;
check('every ko value (except proper nouns) contains Hangul', keySets.en.every((k) => PROPER.has(k) || hangul.test(nls.ko[k])),
  keySets.en.filter((k) => !PROPER.has(k) && !hangul.test(nls.ko[k])).join(', '));
check('every zh-cn value (except proper nouns) contains Han characters', keySets.en.every((k) => PROPER.has(k) || han.test(nls['zh-cn'][k])),
  keySets.en.filter((k) => !PROPER.has(k) && !han.test(nls['zh-cn'][k])).join(', '));
check('no zh-cn value contains Hangul and no ko value is missing its command links', keySets.en.every((k) => !hangul.test(nls['zh-cn'][k])));

// 3. command ids
const c = pkg.contributes;
const declared = c.commands.map((x) => x.command);
check('no command is declared twice', new Set(declared).size === declared.length);
const referenced = new Map(); // id -> where
const ref = (id, where) => referenced.set(id, [...(referenced.get(id) || []), where]);
for (const [menu, items] of Object.entries(c.menus || {})) {
  for (const it of items) ref(it.command, `menus.${menu}`);
}
for (const kb of c.keybindings || []) ref(kb.command, 'keybindings');
const linkRe = /command:([A-Za-z0-9_.-]+)/g;
const resolveNls = (s, lang) => {
  const m = /^%(.+)%$/.exec(s);
  return m ? nls[lang][m[1]] : s;
};
for (const vw of c.viewsWelcome || []) {
  for (const lang of Object.keys(nls)) {
    for (const m of String(resolveNls(vw.contents, lang)).matchAll(linkRe)) ref(m[1], `viewsWelcome(${vw.view},${lang})`);
  }
}
for (const wt of c.walkthroughs || []) {
  for (const step of wt.steps || []) {
    for (const ev of step.completionEvents || []) {
      const m = /^onCommand:(.+)$/.exec(ev);
      if (m) ref(m[1], `walkthrough.${step.id}.completionEvents`);
    }
    for (const lang of Object.keys(nls)) {
      for (const m of String(resolveNls(step.description, lang)).matchAll(linkRe)) ref(m[1], `walkthrough.${step.id}(${lang})`);
    }
  }
}
const undeclared = [...referenced.keys()].filter((id) => !declared.includes(id));
check('every command referenced in menus / commandPalette / viewsWelcome / keybindings / walkthroughs is declared',
  undeclared.length === 0, undeclared.map((id) => `${id} @ ${referenced.get(id).join('+')}`).join('; ') || `${referenced.size} distinct ids referenced`);
// command links must be the same set in every language of a key
const linkDrift = keySets.en.filter((k) => {
  const sets = Object.keys(nls).map((l) => [...String(nls[l][k]).matchAll(linkRe)].map((m) => m[1]).sort().join(','));
  return new Set(sets).size !== 1;
});
check('every nls key carries the same command links in all three languages', linkDrift.length === 0, linkDrift.join(', '));

const ext = read('src/extension.ts');
// [2.0: the ids were read from `registerCommand('…'` calls.] Every command is registered through ONE helper,
// guardedCommand(id, run) — the only place vscode.commands.registerCommand is called — whose handler can
// neither throw nor reject. The ids are read from its calls, and the helper being the only door is checked below.
// [TEAM MODE, contract §8.1] The Teams-group commands are a table, teamView.teamCommandHandlers(client), whose
// every id extension.ts registers in ONE loop through the same guardedCommand — so those ids count as registered
// only while that loop is there.
const teamTable = /export function teamCommandHandlers\([\s\S]*?\n}\n/.exec(read('src/teamView.ts'))?.[0] ?? '';
const teamLoop = /for \(const \[id, run\] of Object\.entries\(teamCommandHandlers\(\w+\)\)\) \{\s*context\.subscriptions\.push\(guardedCommand\(id, run\)\);/.test(ext);
const teamIds = teamLoop ? [...teamTable.matchAll(/^\s*'([A-Za-z0-9_.]+)': /gm)].map((m) => m[1]) : [];
const registered = [...new Set([...[...ext.matchAll(/guardedCommand\(\s*'([A-Za-z0-9_.]+)'/g)].map((m) => m[1]), ...teamIds])];
const directRegistrations = ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts', 'src/dashboard.ts', 'src/assetManager.ts']
  .flatMap((f) => [...read(f).matchAll(/commands\.registerCommand\(([^,)]*)/g)].map((m) => `${f}: registerCommand(${m[1].trim()}`));
check('the one vscode.commands.registerCommand call of the extension is the one inside guardedCommand(id, run): no command is registered around the guard',
  directRegistrations.length === 1 && directRegistrations[0] === 'src/extension.ts: registerCommand(id' && /function guardedCommand\(id: string, run: \(\.\.\.args: unknown\[\]\) => unknown\): vscode\.Disposable \{\s*return vscode\.commands\.registerCommand\(id, async/.test(ext),
  directRegistrations.join(' ; '));
const notRegistered = declared.filter((id) => !registered.includes(id));
const notDeclared = registered.filter((id) => !declared.includes(id));
check('every declared command is registered in src/extension.ts', notRegistered.length === 0, notRegistered.join(', ') || `${declared.length} commands`);
check('every command registered in src/extension.ts is declared', notDeclared.length === 0, notDeclared.join(', ') || `${registered.length} registrations`);
const executed = [...new Set([...['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts']
  .flatMap((f) => [...read(f).matchAll(/'(claudeCodeOrchestrator\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]))])]
  // WAVE2: a contributed SETTING id (handed to workbench.action.openSettings) is not a command.
  // TM: a context key set with setContext (claudeCodeOrchestrator.teamModeOn) is not a command either.
  .filter((id) => !/\.(workers|team|tasks|workerHistory|gettingStarted)$/.test(id) && !id.includes('mcpOfferDismissed') && !(id in c.configuration.properties) && !/\.teamModeOn$/.test(id));
const strayIds = executed.filter((id) => !declared.includes(id));
check('every claudeCodeOrchestrator.* command literal in my source files is a declared command', strayIds.length === 0, strayIds.join(', '));

for (const gone of ['attachMeshWorker', 'meshWorkerLogs', 'stopMeshWorker']) {
  const hits = ['package.json', ...Object.values(NLS), 'src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts']
    .filter((f) => new RegExp(`\\b${gone}\\b`).test(read(f)));
  check(`removed command ${gone} is gone from my files`, hits.length === 0, hits.join(', '));
}

// commandPalette: hidden entries exist, and every hidden command is one that needs an argument
const hidden = (c.menus.commandPalette || []).filter((x) => x.when === 'false').map((x) => x.command.replace('claudeCodeOrchestrator.', ''));
check('commandPalette hides the argument-only commands', hidden.length > 0, hidden.join(', '));

// 4. views
const viewIds = c.views.claudeCodeOrchestrator.map((v) => v.id);
check('views are workers, team, tasks, workerHistory in that order',
  viewIds.join(',') === ['workers', 'team', 'tasks', 'workerHistory'].map((v) => `claudeCodeOrchestrator.${v}`).join(','), viewIds.join(', '));
const welcomeViews = (c.viewsWelcome || []).map((v) => v.view);
check('viewsWelcome covers all four views', viewIds.every((v) => welcomeViews.includes(v)) && welcomeViews.every((v) => viewIds.includes(v)), welcomeViews.join(', '));
const whenViews = [...pkgText.matchAll(/view == (claudeCodeOrchestrator\.[A-Za-z]+)/g)].map((m) => m[1]);
check('every view named in a when-clause exists', whenViews.every((v) => viewIds.includes(v)), [...new Set(whenViews.filter((v) => !viewIds.includes(v)))].join(', '));
const srcViews = [...new Set([...['src/extension.ts', 'src/teamView.ts'].flatMap((f) => [...read(f).matchAll(/(?:createTreeView|registerTreeDataProvider)\(\s*'([^']+)'/g)].map((m) => m[1]))])];
check('every contributed view has a provider registered and vice versa',
  viewIds.every((v) => srcViews.includes(v)) && srcViews.every((v) => viewIds.includes(v)), srcViews.join(', '));

// 5. removed settings
const mine = ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts', 'package.json', ...Object.values(NLS), '.vscodeignore'];
for (const key of ['meshGatewayModel', 'meshWorkerIdleTimeoutMin', 'MESH_GATEWAY', 'setWorkerKeepAlive', 'keepAlive', 'keep-alive', 'mesh_keep_worker', 'mesh_send_worker', 'mesh_receive']) {
  const hits = mine.filter((f) => read(f).includes(key));
  check(`"${key}" appears in none of my files`, hits.length === 0, hits.join(', '));
}
const props = c.configuration.properties;
check('settings meshGatewayModel / meshWorkerIdleTimeoutMin are not contributed',
  !('claudeCodeOrchestrator.meshGatewayModel' in props) && !('claudeCodeOrchestrator.meshWorkerIdleTimeoutMin' in props));

// 6. permission-mode enum == platform WORKER_PERMISSION_MODES
const platform = read('src/platform.ts');
const pm = /export const WORKER_PERMISSION_MODES = \[([^\]]+)\]/.exec(platform);
const modes = pm ? [...pm[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const perm = props['claudeCodeOrchestrator.workerPermissionMode'];
check('workerPermissionMode enum equals platform WORKER_PERMISSION_MODES, same order',
  modes.length > 0 && JSON.stringify(perm.enum) === JSON.stringify(modes), JSON.stringify(perm.enum));
check('workerPermissionMode default is acceptEdits', perm.default === 'acceptEdits');
check('workerPermissionMode has one enumDescription per value', Array.isArray(perm.enumDescriptions) && perm.enumDescriptions.length === perm.enum.length);

// 7. every user-visible contribution string is a %key%
const STRING_FIELDS = new Set(['title', 'description', 'name', 'contents', 'category', 'markdownDescription']);
const literal = [];
(function walk(node, trail) {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${trail}[${i}]`));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && STRING_FIELDS.has(k) && !/^%[^%]+%$/.test(v)) literal.push(`${trail}.${k}`);
      if (k === 'enumDescriptions' && Array.isArray(v)) v.forEach((s, i) => { if (!/^%[^%]+%$/.test(s)) literal.push(`${trail}.${k}[${i}]`); });
      walk(v, `${trail}.${k}`);
    }
  }
})(c, 'contributes');
check('every title / description / name / contents / category / enumDescription under contributes is a %key%', literal.length === 0, literal.join(', '));

// 8. .vscodeignore
const ignore = read('.vscodeignore').split('\n');
for (const line of ['media/dashboard/preview.html', 'media/dashboard/fixtures.js', 'VERIFICATION.md']) {
  check(`.vscodeignore lists ${line}`, ignore.includes(line));
}

// 9. no dated model id outside platform.ts in my files
const dated = /claude-(opus|sonnet|fable|haiku)-\d/;
const datedHits = mine.filter((f) => dated.test(read(f)));
check('no claude-<family>-<version> literal in my files', datedHits.length === 0, datedHits.join(', '));

// 10. the unions in uiTypes.ts vs. what the shell implements
const uiTypes = read('src/uiTypes.ts');
const union = (name) => {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(uiTypes);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};
const arrayIn = (file, name) => {
  const m = new RegExp(`${name}[^=]*= \\[([^\\]]+)\\]`).exec(read(file));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};
const uiCommands = union('UiCommandId');
const missingUi = uiCommands.filter((id) => !declared.includes(`claudeCodeOrchestrator.${id}`) || !registered.includes(`claudeCodeOrchestrator.${id}`));
check('every UiCommandId the dashboard may send is a declared and registered command', uiCommands.length > 0 && missingUi.length === 0, missingUi.join(', ') || uiCommands.join(', '));
const sameSet = (a, b) => a.length > 0 && a.length === b.length && a.every((x) => b.includes(x));
check('SESSION_ACTIONS (teamView.ts) equals the UiSessionAction union', sameSet(union('UiSessionAction'), arrayIn('src/teamView.ts', 'SESSION_ACTIONS')), arrayIn('src/teamView.ts', 'SESSION_ACTIONS').join(', '));
check('ACCOUNT_ACTIONS (extension.ts) equals the UiAccountAction union', sameSet(union('UiAccountAction'), arrayIn('src/extension.ts', 'ACCOUNT_ACTIONS')), arrayIn('src/extension.ts', 'ACCOUNT_ACTIONS').join(', '));

// 11. l10n call sites: the key must be ONE plain string literal (extractable), never a template or a concatenation
const badL10n = [];
for (const f of ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts']) {
  const text = read(f);
  for (const m of text.matchAll(/l10n\.t\(\s*([^\s])/g)) {
    const first = m[1];
    const line = text.slice(0, m.index).split('\n').length;
    if (first !== "'" && first !== '"') badL10n.push(`${f}:${line} starts with ${first}`);
  }
  // a literal immediately followed by "+" is a concatenated key
  for (const m of text.matchAll(/l10n\.t\(\s*'(?:[^'\\]|\\.)*'\s*\+/g)) badL10n.push(`${f}:${text.slice(0, m.index).split('\n').length} concatenated key`);
}
check('every vscode.l10n.t key in my files is a single plain string literal', badL10n.length === 0, badL10n.join('; '));
const l10nCount = ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts']
  .map((f) => `${path.basename(f)} ${[...read(f).matchAll(/l10n\.t\(/g)].length}`).join(', ');
console.log(`INFO — vscode.l10n.t call sites: ${l10nCount}`);

// 12. env construction: no hand-built CLAUDE_CONFIG_DIR object anywhere in my source files
const envHits = [];
for (const f of ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts']) {
  read(f).split('\n').forEach((line, i) => {
    if (!line.includes('CLAUDE_CONFIG_DIR')) return;
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (code.includes('CLAUDE_CONFIG_DIR')) envHits.push(`${f}:${i + 1}`);
  });
}
check('CLAUDE_CONFIG_DIR appears in my source files only inside comments', envHits.length === 0, envHits.join(', '));
// W5 SHELL-A: every terminal is opened by workerManager.openCommandTerminal — the only createTerminal call, which
// passes `env: options.env` — so the rule is checked where the environment is chosen: each call of it hands over
// an object literal (inline, or the `options` constant declared just above the call) whose env is one of the two.
const TERM_FILES = ['src/extension.ts', 'src/views.ts', 'src/teamView.ts', 'src/workerManager.ts'];
const createCalls = TERM_FILES.flatMap((f) => [...read(f).matchAll(/createTerminal\(\{[\s\S]*?\}\);/g)].map((m) => ({ f, text: m[0] })));
// [TEAM MODE, contract §3.10 step 3 / M14] One more createTerminal is allowed: the take-over terminal in
// src/teamView.ts, whose process IS the member's `claude --resume` (started as the shell — shellPath/shellArgs,
// nothing typed) and whose env is the host's take-over plan (built from claudeTerminalEnv on the host side), never
// assembled here.
const ownCalls = createCalls.filter((c) => !(c.f === 'src/teamView.ts' && /shellPath: plan\.command,/.test(c.text) && /shellArgs: plan\.args,/.test(c.text) && /\benv,/.test(c.text)));
const takeoverOk = createCalls.length - ownCalls.length === 1 && /const env: Record<string, string \| null> = \{ \.\.\.plan\.env\.set \};/.test(read('src/teamView.ts'));
const oneOwner = takeoverOk && ownCalls.length === 1 && ownCalls[0].f === 'src/workerManager.ts' && /env: options\.env/.test(ownCalls[0].text);
const termEnv = TERM_FILES.flatMap((f) => {
  const src = read(f);
  const optionsConst = /const options = \{[^;]*env: (claudeTerminalEnv|accountTerminalEnv)\(/.test(src);
  return [...src.matchAll(/(?<!function )openCommandTerminal\(\s*(\{[\s\S]*?\}|options),/g)].map((m) => ({ f, ok: oneOwner && (m[1] === 'options' ? optionsConst : /env: (claudeTerminalEnv|accountTerminalEnv)\(/.test(m[1])) }));
});
// WAVE2: accountTerminalEnv is the provider-aware owner (it returns claudeTerminalEnv for Claude Code).
check('[UPDATED for W5 SHELL-A] the one createTerminal call takes its env from its caller, and every openCommandTerminal call passes env: claudeTerminalEnv(...) or accountTerminalEnv(...)', termEnv.length >= 4 && termEnv.every((t) => t.ok), `${termEnv.length} terminals: ${termEnv.map((t) => `${path.basename(t.f)}${t.ok ? '' : ' MISSING'}`).join(', ')}`);
const wm = read('src/workerManager.ts');
const ate = /export function accountTerminalEnv\([\s\S]*?\n}\n/.exec(wm);
// SHELL-FIX (D1): a non-Claude terminal starts from platform.vendorTerminalEnv(), which nulls the Anthropic
// credential variables as well as the session identity; the function no longer builds the null list itself.
check('accountTerminalEnv returns claudeTerminalEnv for Claude Code and starts from vendorTerminalEnv() for the rest (D1)',
  ate !== null && /provider === 'claude'\) \{\s*return claudeTerminalEnv\(configDir\);/.test(ate[0]) && /const env = vendorTerminalEnv\(\);/.test(ate[0]) && !/SESSION_IDENTITY_ENV/.test(ate[0]) && /adapterAccountDir\(provider, configDir\)/.test(ate[0]));

/* ============================ WAVE 2: providers ============================ */
// 13. the new setting
const pup = props['claudeCodeOrchestrator.providerUsagePolling'];
check('setting providerUsagePolling is contributed: boolean, default true, described by a %key%',
  pup !== undefined && pup.type === 'boolean' && pup.default === true && pup.description === '%config.providerUsagePolling.description%', JSON.stringify(pup));
const pupText = nls.en['config.providerUsagePolling.description'] || '';
check('its description says plainly what is asked, when, and that it can be turned off',
  /usage service/.test(pupText) && /at startup, every 5 minutes/.test(pupText) && /Turn this off/.test(pupText) && /another vendor's CLI/.test(pupText), pupText.slice(0, 90));
check('the dashboard-writable setting keys (UiSettingKey) are all contributed settings',
  union('UiSettingKey').length > 0 && union('UiSettingKey').every((k) => `claudeCodeOrchestrator.${k}` in props), union('UiSettingKey').filter((k) => !(`claudeCodeOrchestrator.${k}` in props)).join(', '));

// 14. the Workers-tree menus against the context values views.ts actually produces
const providersTs = read('src/providers.ts');
const providerIds = [...(/export const PROVIDER_IDS = \[([^\]]+)\]/.exec(providersTs) || [, ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('providers.ts lists the four providers', JSON.stringify(providerIds) === JSON.stringify(['claude', 'codex', 'cursor', 'gemini']), providerIds.join(', '));
const viewsTs = read('src/views.ts');
// [CA: was the one-line `worker.${provider}${provider === 'claude' ? '' : '.permission'}`.] A Claude
// Code row whose login is CONFIRMED logged out (isLoginExpired — the state `loggedOut`) adds
// `.loggedOut`, so Re-login Account is offered on such a row only (contract-2.0-fixes "Login state (CA)").
check('views.ts builds the worker context value as worker.claude[.loggedOut] / worker.<provider>.permission',
  /item\.contextValue =\s*provider === 'claude'\s*\? `worker\.claude\$\{isLoginExpired\(usage\) \? '\.loggedOut' : ''\}`\s*: `worker\.\$\{provider\}\.permission`;/.test(viewsTs));
const ctxOf = (p) => (p === 'claude.loggedOut' ? 'worker.claude.loggedOut' : `worker.${p}${p === 'claude' ? '' : '.permission'}`);
const whenMatches = (when, viewItem) => {
  const eq = /viewItem == ([A-Za-z0-9_.-]+)/.exec(when);
  if (eq) return eq[1] === viewItem;
  const re = /viewItem =~ \/(.+)\/$/.exec(when.trim());
  if (re) return new RegExp(re[1]).test(viewItem);
  return undefined;
};
const workerMenu = c.menus['view/item/context'].filter((m) => /view == claudeCodeOrchestrator\.workers/.test(m.when));
const unparsed = workerMenu.filter((m) => whenMatches(m.when, 'worker.claude') === undefined).map((m) => m.when);
check('every Workers-tree menu when-clause is one this check can evaluate (and its regexp compiles)', unparsed.length === 0, unparsed.join(' | '));
const shownFor = (p) => workerMenu.filter((m) => whenMatches(m.when, ctxOf(p)) === true).map((m) => m.command.replace('claudeCodeOrchestrator.', '')).sort();
const ALL = ['openWorkerSession', 'togglePreferred', 'setWorkerModel', 'renameWorker', 'reloginWorker', 'removeWorker'];
// [CA: was "the six common actions plus loginWorker" on every Claude Code row.] Re-login Account only on a
// confirmed logout; Check Login Now on every Claude Code row; never on another vendor's (the checks below).
check('a Claude Code row offers the five common actions but Re-login, plus loginWorker and checkLoginNow, and NOT setWorkerPermissionMode',
  JSON.stringify(shownFor('claude')) === JSON.stringify([...ALL.filter((a) => a !== 'reloginWorker'), 'loginWorker', 'checkLoginNow'].sort()), shownFor('claude').join(', '));
check('a logged-out Claude Code row offers the six common actions plus loginWorker and checkLoginNow, and NOT setWorkerPermissionMode',
  JSON.stringify(shownFor('claude.loggedOut')) === JSON.stringify([...ALL, 'loginWorker', 'checkLoginNow'].sort()), shownFor('claude.loggedOut').join(', '));
for (const p of ['codex', 'cursor', 'gemini']) {
  check(`a ${p} row offers the six common actions plus setWorkerPermissionMode, and NOT loginWorker`,
    JSON.stringify(shownFor(p)) === JSON.stringify([...ALL, 'setWorkerPermissionMode'].sort()), shownFor(p).join(', '));
}
check('no Workers-tree menu still matches the bare wave-1 context value "worker"', workerMenu.every((m) => whenMatches(m.when, 'worker') !== true),
  workerMenu.filter((m) => whenMatches(m.when, 'worker') === true).map((m) => m.command).join(', '));
check('a stat row (workerStat) gets no worker action', workerMenu.every((m) => whenMatches(m.when, 'workerStat') !== true));

// 15. seams called the way the contract spells them
check('extension.ts calls setDashboardLog with the output channel (F9)', /setDashboardLog\(\(line\) => output\.appendLine\(line\)\);/.test(ext));
check('extension.ts calls refreshProviderUsage({ helperPath, polling }) and reads the providerUsagePolling setting',
  /refreshProviderUsage\(\{[\s\S]{0,60}helperPath: providerHelperPath,[\s\S]{0,300}polling:[\s\S]{0,200}'providerUsagePolling'/.test(ext)
  && /const providerHelperPath = context\.asAbsolutePath\(path\.join\(BUNDLE_DIR, PROVIDER_HELPER\)\);/.test(ext));
check('markWorkerStopped is called with the job id by every caller in my files (F6)',
  [...['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts'].flatMap((f) => [...read(f).matchAll(/markWorkerStopped\(([^)]*)\)/g)].map((m) => m[1]))]
    .filter((args) => !/^cwd|name: string/.test(args)).every((args) => args.split(',').length === 3),
  [...viewsTs.matchAll(/markWorkerStopped\(([^)]*)\)/g)].map((m) => m[1]).join(' | '));
// [2.0: was looked for in views.ts.] The trees take a task's dispatch mode from the shared task index of
// uiModel.ts now, so the marker is read there — once, in hasSupervisor — and views.ts reads neither field.
{
  const uiModelTs = read('src/uiModel.ts');
  check('pgid is no longer read as a detach marker (F2): uiModel.ts decides on a numeric supervisorPid, and neither it nor views.ts reads pgid',
    !/typeof event\.pgid/.test(viewsTs) && !/typeof event\.pgid/.test(uiModelTs) && !/\bpgid\b/.test(viewsTs) && !/supervisorPid/.test(viewsTs)
    && /function hasSupervisor\(event: Record<string, unknown>\): boolean \{\s*return typeof event\.supervisorPid === 'number' && Number\.isFinite\(event\.supervisorPid\);/.test(uiModelTs));
}
for (const f of ['src/views.ts', 'src/history-view.ts']) {
  const t = read(f);
  const raw = [...t.matchAll(/new vscode\.TreeItem\(\s*(event\.[a-zA-Z]+)/g)].map((m) => m[1]);
  check(`${f}: no tree label is built straight from an event field (F7)`, raw.length === 0, raw.join(', '));
  const desc = [...t.matchAll(/item\.description = [^;]*\$\{event\.(title|worker|model)\}/g)].map((m) => m[0]);
  check(`${f}: no description interpolates event.title / worker / model raw (F7)`, desc.length === 0, desc.join(' | '));
}
// [second review, §9.4: the patterns were `entry.name.startsWith('.claude')` in workerManager.ts and
// `workers.add(entry.suggestedName, choice.model, entry.dir);` in extension.ts.] Import still looks at `.claude*`
// names only and still adds with no provider; it now also offers only a real directory that looks like a Claude
// Code config directory, and the name it adds under has passed the one name rule (the directory's own name
// when the rule takes it, else one the user typed).
{
  const discover = (/\n  discoverConfigDirs\(\): \{[^\n]*\{\n([\s\S]*?)\n  \}\n/.exec(wm) || [])[1] || '';
  const importCmd = (/guardedCommand\('claudeCodeOrchestrator\.importWorkers'([\s\S]*?)\n    \}\),\n/.exec(ext) || [])[1] || '';
  check('"Import workers" stays Claude-only: discoverConfigDirs scans .claude* names and offers only a real directory that looks like a Claude Code config directory; import adds with no provider, under a name the name rule took',
    /if \(!name\.startsWith\('\.claude'\)\) \{\s*continue;/.test(discover) && /if \(!isRealDirectory\(dir\) \|\| !looksLikeClaudeConfigDir\(dir\)\) \{\s*continue;/.test(discover)
    && /workers\.add\(name, choice\.model, entry\.dir\);/.test(importCmd) && (importCmd.match(/workers\.add\(/g) || []).length === 1
    && /const suggestionProblem = workerNameProblem\(name, taken, unusable\);/.test(importCmd) && /const typedProblem = workerNameProblem\(name, taken, unusable\);/.test(importCmd),
    `discoverConfigDirs body ${discover.length} chars, import handler ${importCmd.length} chars`);
}
// F10: sandbox-removing modes
const SRC = ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts'];
const mapDefs = SRC.flatMap((f) => [...read(f).matchAll(/UNSANDBOXED_MODES[^=\n]*= \{([\s\S]*?)\n\};/g)].map((m) => ({ f, body: m[1] })));
check('F10: the list of sandbox-removing modes exists in exactly ONE place (workerManager.ts), keyed by provider: codex danger-full-access, cursor disabled, none for claude / gemini',
  mapDefs.length === 1 && mapDefs[0].f === 'src/workerManager.ts' && /claude: \[\],/.test(mapDefs[0].body) && /codex: \['danger-full-access'\],/.test(mapDefs[0].body) && /cursor: \['disabled'\],/.test(mapDefs[0].body) && /gemini: \[\],/.test(mapDefs[0].body),
  mapDefs.map((d) => `${d.f}: ${d.body.replace(/\s+/g, ' ').trim()}`).join(' | '));
const codeOnly = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const modeLiterals = SRC.flatMap((f) => [...codeOnly(read(f)).matchAll(/'(danger-full-access|disabled)'/g)].map((m) => `${f}:${m[1]}`));
check('F10: no other line of code in my files names such a mode (everything else asks removesSandbox)', JSON.stringify(modeLiterals) === JSON.stringify(['src/workerManager.ts:danger-full-access', 'src/workerManager.ts:disabled']), modeLiterals.join(', '));
const storeCalls = SRC.flatMap((f) => [...codeOnly(read(f)).matchAll(/workers\.setPermissionMode\(([^)]*)\)/g)].map((m) => `${f}: ${m[1]}`));
check('F10: the shell stores a permission mode in ONE call, and that call passes whether the unsandboxed choice was confirmed', storeCalls.length === 1 && storeCalls[0] === 'src/extension.ts: worker.name, mode, unsandboxed', storeCalls.join(' | '));
const gate = /const unsandboxed = removesSandbox\(provider, mode\);\s*if \(unsandboxed\) \{[\s\S]*?showWarningMessage\([\s\S]*?modal: true,[\s\S]*?if \(confirm !== confirmLabel\) \{[\s\S]*?return;\s*\}\s*\}\s*try \{\s*if \(workers\.setPermissionMode\(/.test(ext);
check('F10: between choosing the mode and storing it stands a modal showWarningMessage whose dismissal returns before anything is stored', gate);
check('F10: WorkerManager.setPermissionMode throws on an unsandboxed mode unless the confirmation is stated', /if \(removesSandbox\(provider, mode\) && unsandboxedConfirmed !== true\) \{\s*throw new Error\(/.test(wm));
check('no real vendor home is named as a literal path in my source files',
  ['src/extension.ts', 'src/views.ts', 'src/history-view.ts', 'src/teamView.ts', 'src/workerManager.ts'].every((f) => !/['"`]~?\/?\.(codex|cursor|agy)['"`/]/.test(read(f))));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
