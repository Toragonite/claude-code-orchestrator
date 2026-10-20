#!/usr/bin/env node
/*
 * Proves, against a FRESH extraction of src/ (extract-l10n.cjs is run here, every time):
 *  1. the three l10n bundles parse, have identical key sets, and that set EQUALS the extracted set
 *     (no missing key, no stale key); the translated bundles list the keys in the English bundle's
 *     order; every bundle / nls file is 2-space JSON with a trailing newline;
 *  2. the English bundle is an identity map (value = key);
 *  3. per key and language: the same multiset of {n} placeholders, the same backtick code spans,
 *     no empty value, no leading/trailing whitespace or newline-count drift, no trailing
 *     ellipsis/colon/question-mark or sentence-final-period drift;
 *  4. a translation identical to the English must be on the explicit allow-list below (printed);
 *  5. a translation contains its script (Hangul / Han), and no Han in ko / Hangul in zh;
 *  6. quoted command titles: a key that quotes the English title of a command ("Re-login Account",
 *     "Remove Registry Entry…", …) must quote that command's translated title in each language
 *     (taken from package.nls.<lang>.json), and a quoted single-token name ("main", "claude",
 *     "mcpServers") survives verbatim;
 *  7. Korean particles directly after a placeholder are the optional forms (을(를), 은(는), 이(가), (으)로),
 *     never a bare 을 / 를 / 은 / 는 / 이 / 가 / 와 / 과 / 으로 / 로 that is right for only half of all words;
 *  8. no key or value contains a path under /Users/;
 *  9. the three package.nls files parse, have identical key sets in the same order, every %key% in
 *     package.json resolves in all three and no nls key is unused; command links and code spans
 *     in nls values match; the two Re-login command titles differ in every language;
 * 10. the string table of dashboardStrings() equals the English table in media/dashboard/fixtures.js.
 *
 * usage: node verify-l10n.cjs [repo]     (exit 1 on any failure)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const here = __dirname;
const repo = path.resolve(process.argv[2] || path.join(here, '..', '..', '..'));
let failures = 0;
const fail = (m) => {
  failures++;
  console.log('FAIL ' + m);
};
const ok = (m) => console.log('ok   ' + m);
const readText = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const check = (bad, label) => (bad ? fail : ok)(label);

// ---------- extraction ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-l10n-verify-'));
const extractedFile = path.join(tmp, 'extracted.json');
const exOut = execFileSync(process.execPath, [path.join(here, 'extract-l10n.cjs'), repo, '--json', extractedFile], { encoding: 'utf8' });
const extracted = JSON.parse(fs.readFileSync(extractedFile, 'utf8'));
console.log('extraction: ' + exOut.split('\n')[0]);
if (extracted.nonLiteral.length) fail(`${extracted.nonLiteral.length} l10n.t call(s) whose first argument is not a plain literal`);
else ok('every l10n.t call has a plain-literal first argument');
if (extracted.aliases.length) fail(`${extracted.aliases.length} use(s) of l10n other than a direct vscode.l10n.t(...) call`);
else ok('l10n.t is never aliased, destructured or passed around');
// every line that textually contains `l10n.t(` is a parsed call, except comments
const nonComment = extracted.textualOnly.filter((t) => !/^\s*(\*|\/\/|\/\*)/.test(t.text));
if (nonComment.length) fail(`${nonComment.length} textual l10n.t( occurrence(s) the parser did not see as a call: ${JSON.stringify(nonComment)}`);
else ok(`textual l10n.t( occurrences that are not parsed calls: ${extracted.textualOnly.length}, all inside comments`);

// ---------- bundles ----------
const BUNDLES = [
  ['en', 'l10n/bundle.l10n.json'],
  ['ko', 'l10n/bundle.l10n.ko.json'],
  ['zh-cn', 'l10n/bundle.l10n.zh-cn.json'],
];
const bundle = {};
for (const [name, rel] of BUNDLES) {
  try {
    const text = readText(rel);
    bundle[name] = JSON.parse(text);
    check(text !== JSON.stringify(bundle[name], null, 2) + '\n', `${rel}: 2-space JSON with a trailing newline`);
  } catch (e) {
    fail(`${rel} does not parse: ${e.message}`);
    process.exit(1);
  }
}
const en = bundle.en, ko = bundle.ko, zh = bundle['zh-cn'];
const want = new Set(extracted.keys);
for (const [name] of BUNDLES) {
  const have = new Set(Object.keys(bundle[name]));
  const missing = [...want].filter((k) => !have.has(k));
  const stale = [...have].filter((k) => !want.has(k));
  if (missing.length || stale.length) {
    fail(`${name}: ${missing.length} missing, ${stale.length} stale`);
    missing.slice(0, 20).forEach((k) => console.log('     missing: ' + JSON.stringify(k)));
    stale.slice(0, 20).forEach((k) => console.log('     stale:   ' + JSON.stringify(k)));
  } else ok(`${name}: ${have.size} keys = the ${want.size} extracted keys`);
}
const orderOf = (o) => JSON.stringify(Object.keys(o));
check(orderOf(en) !== JSON.stringify([...Object.keys(en)].sort()), 'English bundle keys are in the default sort order');
check(orderOf(ko) !== orderOf(en) || orderOf(zh) !== orderOf(en), 'ko and zh-cn list the keys in the English bundle order');
const nonIdentity = Object.entries(en).filter(([k, v]) => k !== v);
check(nonIdentity.length > 0, `English bundle is an identity map (violations: ${nonIdentity.length})`);

const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
const codeSpans = (s) => (s.match(/`[^`]*`/g) || []).sort().join('|');
// Values allowed to equal the English: product / model / protocol names and pure format strings.
const SAME_OK = new Set(['CLI', 'Claude Code', 'Claude Code Orchestrator', 'Fable', '{0} / {1}', '{0}%', '{0} → {1}', 'Auto + Composer']);
const trailClass = (s) => {
  const t = s.trimEnd();
  if (/(…|\.\.\.)$/.test(t)) return 'ellipsis';
  if (/[:：]$/.test(t)) return 'colon';
  if (/[?？]$/.test(t)) return 'question';
  return 'other';
};
const sentenceEnd = (s) => /[.。]$/.test(s.trimEnd());
const sameAsEnglish = { ko: [], zh: [] };
const counts = { ph: 0, empty: 0, ws: 0, punct: 0, code: 0, end: 0, dbl: 0, users: 0, particle: 0, nfc: 0, invisible: 0, angle: 0, script: 0 };
// bare Korean particles right after a placeholder
const BARE_PARTICLE = /\{\d+\}(?:을|를|은|는|이|가|와|과|으로|로)(?=[\s.,;:!?)\]"'—…]|$)/;
for (const [lang, b] of [['ko', ko], ['zh', zh]]) {
  for (const key of extracted.keys) {
    const v = b[key];
    if (typeof v !== 'string') continue;
    const tag = (kind) => console.log(`     ${lang} ${kind}: ${JSON.stringify(key)} -> ${JSON.stringify(v)}`);
    if (v.trim() === '') { counts.empty++; tag('EMPTY'); }
    if (placeholders(v) !== placeholders(key)) { counts.ph++; tag('PLACEHOLDERS'); }
    if (codeSpans(v) !== codeSpans(key)) { counts.code++; tag('CODE SPANS'); }
    if (v !== v.trim() || /^\s|\s$/.test(key) !== /^\s|\s$/.test(v) || (key.match(/\n/g) || []).length !== (v.match(/\n/g) || []).length) {
      counts.ws++; tag('WHITESPACE');
    }
    if (/ {2,}/.test(v) && !/ {2,}/.test(key)) { counts.dbl++; tag('DOUBLE SPACE'); }
    if (trailClass(key) !== trailClass(v)) { counts.punct++; tag('TRAILING PUNCTUATION'); }
    if (sentenceEnd(key) !== sentenceEnd(v)) { counts.end++; tag('SENTENCE END'); }
    if (lang === 'ko' && BARE_PARTICLE.test(v)) { counts.particle++; tag('BARE PARTICLE AFTER PLACEHOLDER'); }
    if (v !== v.normalize('NFC')) { counts.nfc++; tag('NOT NFC'); }
    if (/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff\ufffd\u00a0\u3000]/.test(v) && !/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff\ufffd\u00a0\u3000]/.test(key)) {
      counts.invisible++; tag('INVISIBLE / UNUSUAL CHARACTER');
    }
    // markup-looking tokens (<job id>) are data: the same ones, none added, none lost
    if ((v.match(/<[^<>]*>/g) || []).sort().join('|') !== (key.match(/<[^<>]*>/g) || []).sort().join('|')) {
      counts.angle++; tag('ANGLE-BRACKET TOKENS');
    }
    // the wrong language's punctuation: full-width marks in Korean; ASCII marks glued to Han in Chinese
    if (lang === 'ko' && /[，。：；！？（）、]/.test(v)) { counts.script++; tag('FULL-WIDTH PUNCTUATION IN KOREAN'); }
    if (lang === 'zh' && /[一-鿿][.,:;?!(]|[)][一-鿿]/.test(v)) { counts.script++; tag('ASCII PUNCTUATION NEXT TO HAN IN CHINESE'); }
    if (key.includes('/Users/') || v.includes('/Users/')) { counts.users++; tag('/Users/ PATH'); }
    if (v === key) sameAsEnglish[lang].push(key);
  }
}
for (const key of Object.keys(en)) if (key.includes('/Users/')) { counts.users++; console.log(`     key with /Users/: ${JSON.stringify(key)}`); }
check(counts.empty, `empty values: ${counts.empty}`);
check(counts.ph, `placeholder multiset mismatches: ${counts.ph}`);
check(counts.code, `backtick code-span mismatches: ${counts.code}`);
check(counts.ws, `leading/trailing whitespace or newline-count drift: ${counts.ws}`);
check(counts.dbl, `double spaces introduced by a translation: ${counts.dbl}`);
check(counts.punct, `trailing ellipsis/colon/question drift: ${counts.punct}`);
check(counts.end, `sentence-final period drift: ${counts.end}`);
check(counts.particle, `Korean particles that are not the optional form right after a placeholder: ${counts.particle}`);
check(counts.users, `keys or values containing a /Users/ path: ${counts.users}`);
check(counts.nfc, `translations that are not NFC-normalised: ${counts.nfc}`);
check(counts.invisible, `translations with a zero-width / NBSP / ideographic-space / replacement character the English lacks: ${counts.invisible}`);
check(counts.angle, `translations whose <…> tokens differ from the English: ${counts.angle}`);
check(counts.script, `translations with the other language's punctuation habits (full-width in ko, ASCII next to Han in zh): ${counts.script}`);
console.log(`     allow-list of values that may equal the English: ${JSON.stringify([...SAME_OK])}`);
for (const lang of ['ko', 'zh']) {
  const unexpected = sameAsEnglish[lang].filter((k) => !SAME_OK.has(k));
  console.log(`     ${lang}: identical to English: ${sameAsEnglish[lang].length} ${JSON.stringify(sameAsEnglish[lang])}`);
  unexpected.forEach((k) => console.log(`     ${lang} SAME AS ENGLISH (not allow-listed): ${JSON.stringify(k)}`));
  check(unexpected.length, `${lang}: values identical to English outside the allow-list: ${unexpected.length}`);
}
// A zh/ko value must actually contain its script unless allow-listed (catches a pasted-wrong-language value).
const hangul = /[가-힣]/;
const han = /[一-鿿]/;
// Translations that deliberately keep a Latin loanword and have no Han / Hangul at all.
const LATIN_ONLY_OK = { ko: new Set(), zh: new Set(['Tokens', '{0} tokens']) };
console.log(`     allow-list of translations without any Han / Hangul: ${JSON.stringify({ ko: [...LATIN_ONLY_OK.ko], zh: [...LATIN_ONLY_OK.zh] })}`);
const noScript = (b, re, lang) => extracted.keys.filter((k) => !SAME_OK.has(k) && !LATIN_ONLY_OK[lang].has(k) && typeof b[k] === 'string' && !re.test(b[k]) && /[A-Za-z]{3,}/.test(b[k]));
const koNo = noScript(ko, hangul, 'ko'), zhNo = noScript(zh, han, 'zh');
check(koNo.length || zhNo.length, `values with Latin words but no Hangul (ko) / no Han (zh): ${koNo.length} / ${zhNo.length} ${JSON.stringify([...koNo, ...zhNo])}`);
const koHan = extracted.keys.filter((k) => han.test(ko[k] || ''));
const zhHangul = extracted.keys.filter((k) => hangul.test(zh[k] || ''));
check(koHan.length || zhHangul.length, `cross-script contamination (Han in ko: ${koHan.length}, Hangul in zh: ${zhHangul.length})`);

// ---------- package.nls ----------
const pkg = readJson('package.json');
const NLS = [
  ['en', 'package.nls.json'],
  ['ko', 'package.nls.ko.json'],
  ['zh', 'package.nls.zh-cn.json'],
];
const nls = {};
for (const [name, rel] of NLS) {
  const text = readText(rel);
  nls[name] = JSON.parse(text);
  check(text !== JSON.stringify(nls[name], null, 2) + '\n', `${rel}: 2-space JSON with a trailing newline`);
}
const nlsEn = nls.en, nlsKo = nls.ko, nlsZh = nls.zh;
const refs = new Set();
(function walk(v) {
  if (typeof v === 'string') {
    const m = /^%([^%]+)%$/.exec(v);
    if (m) refs.add(m[1]);
  } else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
})(pkg);
const ek = Object.keys(nlsEn), kk = Object.keys(nlsKo), zk = Object.keys(nlsZh);
check(!(JSON.stringify([...ek].sort()) === JSON.stringify([...kk].sort()) && JSON.stringify([...ek].sort()) === JSON.stringify([...zk].sort())), `nls key sets identical (${ek.length} / ${kk.length} / ${zk.length})`);
check(JSON.stringify(ek) !== JSON.stringify(kk) || JSON.stringify(ek) !== JSON.stringify(zk), 'nls files list their keys in the same order');
const unresolved = [...refs].filter((r) => !(r in nlsEn) || !(r in nlsKo) || !(r in nlsZh));
check(unresolved.length, `%key% references in package.json: ${refs.size}, unresolved: ${unresolved.length} ${JSON.stringify(unresolved)}`);
const unusedNls = ek.filter((k) => !refs.has(k));
check(unusedNls.length, `nls keys not referenced by package.json: ${unusedNls.length} ${JSON.stringify(unusedNls)}`);
const links = (s) => (s.match(/\(command:[^)]+\)/g) || []).sort().join('|');
let nlsBad = 0;
const NLS_SAME_OK = new Set(['viewsContainer.title', 'command.category', 'configuration.title']);
const nlsSame = { ko: [], zh: [] };
for (const [lang, b] of [['ko', nlsKo], ['zh', nlsZh]]) {
  for (const k of ek) {
    const e = nlsEn[k], v = b[k];
    if (typeof v !== 'string' || v.trim() === '') { nlsBad++; console.log(`     nls ${lang} EMPTY ${k}`); continue; }
    if (links(e) !== links(v)) { nlsBad++; console.log(`     nls ${lang} COMMAND LINKS ${k}`); }
    if ((e.match(/\n/g) || []).length !== (v.match(/\n/g) || []).length) { nlsBad++; console.log(`     nls ${lang} NEWLINES ${k}`); }
    if (codeSpans(e) !== codeSpans(v)) { nlsBad++; console.log(`     nls ${lang} CODE SPANS ${k}`); }
    if (v === e) nlsSame[lang].push(k);
  }
}
check(nlsBad, `nls structural mismatches (empty / command links / newlines / code spans): ${nlsBad}`);
for (const lang of ['ko', 'zh']) {
  const unexpected = nlsSame[lang].filter((k) => !NLS_SAME_OK.has(k));
  console.log(`     nls ${lang}: identical to English: ${JSON.stringify(nlsSame[lang])}`);
  check(unexpected.length, `nls ${lang}: identical to English outside the allow-list: ${unexpected.length}`);
}
const contributed = new Set((pkg.contributes.commands || []).map((c) => c.command));
const badLinks = [];
for (const b of [nlsEn, nlsKo, nlsZh]) for (const v of Object.values(b)) for (const m of v.matchAll(/\(command:([^)]+)\)/g)) if (!contributed.has(m[1])) badLinks.push(m[1]);
check(badLinks.length, `command links in nls values that name a non-contributed command: ${badLinks.length}`);
// The two Re-login commands must not read as the same command.
for (const [lang, b] of [['en', nlsEn], ['ko', nlsKo], ['zh', nlsZh]]) {
  const a = b['command.loginWorker.title'], c = b['command.reloginWorker.title'];
  const stem = (s) => s.replace(/\s*[（(].*$/, '').trim();
  check(a === c || stem(a) === stem(c), `${lang}: command.loginWorker / command.reloginWorker titles differ ("${a}" / "${c}")`);
}

// ---------- quoted command titles and names ----------
// English command title (without its trailing parenthetical) -> the translated one, per language.
const titleMap = [];
for (const k of ek) {
  if (!/^command\.[^.]+\.title$/.test(k)) continue;
  const stem = (s) => s.replace(/\s*[（(].*$/, '').trim();
  titleMap.push({ en: stem(nlsEn[k]), ko: stem(nlsKo[k]), zh: stem(nlsZh[k]), id: k });
}
// Quoted names that are NOT command titles but are translated or kept: settings, buttons, UI names.
const QUOTED_CHECKED = [];
let quoteBad = 0;
for (const key of extracted.keys) {
  for (const m of key.matchAll(/"([^"{}]+)"/g)) {
    const name = m[1];
    const t = titleMap.find((x) => x.en === name);
    if (t) {
      QUOTED_CHECKED.push(`${name} @ ${key.slice(0, 40)}`);
      if (!ko[key].includes(t.ko)) { quoteBad++; console.log(`     ko quotes "${name}" but not its title "${t.ko}": ${JSON.stringify(key.slice(0, 80))}`); }
      if (!zh[key].includes(t.zh)) { quoteBad++; console.log(`     zh quotes "${name}" but not its title "${t.zh}": ${JSON.stringify(key.slice(0, 80))}`); }
    } else if (name in en && !/^[A-Za-z0-9_.\-/]+$/.test(name)) {
      // A quoted name that is itself a label of this extension (a button, a link: "Register MCP Server")
      // is quoted by the translation of that label.
      QUOTED_CHECKED.push(`${name} @ ${key.slice(0, 40)}`);
      if (!ko[key].includes(ko[name])) { quoteBad++; console.log(`     ko quotes "${name}" but not its label "${ko[name]}": ${JSON.stringify(key.slice(0, 80))}`); }
      if (!zh[key].includes(zh[name])) { quoteBad++; console.log(`     zh quotes "${name}" but not its label "${zh[name]}": ${JSON.stringify(key.slice(0, 80))}`); }
    } else if (/^[A-Za-z0-9_.\-/]+$/.test(name) && !/^[A-Z][a-z]+$/.test(name)) {
      // a single token that is code, a key or a file name (main, claude, mcpServers, claudeCodeOrchestrator.assetPacks)
      for (const [lang, b] of [['ko', ko], ['zh', zh]]) {
        if (!b[key].includes(`"${name}"`)) { quoteBad++; console.log(`     ${lang} lost the quoted token "${name}": ${JSON.stringify(key.slice(0, 80))}`); }
      }
    }
  }
}
// A view named in a sentence ("… in the Worker Accounts view") is named by the title the user sees.
let viewBad = 0, viewChecked = 0;
for (const k of ek.filter((x) => /^view\.[^.]+\.name$/.test(x))) {
  for (const key of extracted.keys) {
    if (!key.includes(`${nlsEn[k]} view`)) continue;
    viewChecked++;
    if (!ko[key].includes(nlsKo[k])) { viewBad++; console.log(`     ko names the "${nlsEn[k]}" view but not by "${nlsKo[k]}": ${JSON.stringify(key.slice(0, 80))}`); }
    if (!zh[key].includes(nlsZh[k])) { viewBad++; console.log(`     zh names the "${nlsEn[k]}" view but not by "${nlsZh[k]}": ${JSON.stringify(key.slice(0, 80))}`); }
  }
}
check(viewBad, `views named in a sentence that are not named by their visible title: ${viewBad} (checked ${viewChecked})`);
check(quoteBad, `quoted command titles / code tokens that do not survive translation: ${quoteBad} (command-title quotes checked: ${QUOTED_CHECKED.length})`);

// ---------- dashboard preview table ----------
try {
  const table = JSON.parse(
    execFileSync(process.execPath, [path.join(here, 'extract-dashboard-strings.cjs'), repo], { encoding: 'utf8' }),
  );
  const fixtures = readText('media/dashboard/fixtures.js');
  const block = fixtures.slice(fixtures.indexOf('/* <strings:begin> */'), fixtures.indexOf('/* <strings:end> */'));
  // fill-dashboard-fixtures.py writes one `    key: <JSON string>,` line per entry; read them as that.
  const preview = {};
  for (const line of block.split('\n')) {
    const m = /^\s+([A-Za-z0-9_]+): ("(?:[^"\\]|\\.)*"),?\s*$/.exec(line);
    if (m) preview[m[1]] = JSON.parse(m[2]);
  }
  const same = JSON.stringify(preview) === JSON.stringify(table);
  check(!same, `media/dashboard/fixtures.js string table equals dashboardStrings() (${Object.keys(table).length} entries)`);
  // A plain literal with no letter in it (the ' · ' separator) is not text to translate.
  const notInBundle = Object.entries(table).filter(([, v]) => !(v in en) && /\p{L}/u.test(v));
  const literalOnly = Object.entries(table).filter(([, v]) => !(v in en) && !/\p{L}/u.test(v));
  console.log(`     dashboardStrings() entries that are not translated text (no letter): ${JSON.stringify(literalOnly)}`);
  check(notInBundle.length, `every dashboardStrings() text with a letter in it is a key of the bundles (violations: ${notInBundle.length})`);
} catch (e) {
  fail('dashboard table check could not run: ' + e.message);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nCOUNTS: l10n.t calls ${extracted.calls}, unique keys ${extracted.keys.length}, bundle keys en/ko/zh ${Object.keys(en).length}/${Object.keys(ko).length}/${Object.keys(zh).length}, nls keys en/ko/zh ${ek.length}/${kk.length}/${zk.length}, %refs ${refs.size}`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
