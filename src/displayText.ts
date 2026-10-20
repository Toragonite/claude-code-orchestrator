/**
 * displayText — the ONE character-hygiene rule for every caller-supplied string this system
 * renders as a single line of text a human reads.
 *
 * WHY THIS FILE EXISTS AS ITS OWN MODULE. The rule below was born inside
 * `mcp/task-runner.headerText()`, where it guards the markdown output files. Sibling surfaces
 * are fed by exactly the same untrusted text and had drifted to weaker spellings of it — one
 * stripped `Cc/Zl/Zp` and nothing else, another collapsed whitespace and nothing else — so the
 * same hostile title rendered clean in the output file and hostile in the tree view.
 * Re-spelling the rule at each site is what produced that drift; importing it from a shared
 * owner is the only thing that ends it. `registry.ts` cannot import from `mcp/task-runner.ts`
 * (task-runner imports registry — that edge is a real cycle), so the rule cannot live in either
 * of them. It lives here.
 *
 * THIS MODULE IS A LEAF, DELIBERATELY. It imports NOTHING — not a repo module, not a Node
 * builtin, not `vscode`. That is a load-bearing property, not an accident: it is what lets
 * `registry.ts` (the shared-state module, which must stay importable from the extension host AND
 * from the standalone MCP server process), `mcp/task-runner.ts` (which imports registry),
 * `mcp/server.ts` and `mesh/pool.ts` all depend on it without forming a cycle. In particular
 * `mesh/pool.ts` is imported BY `mcp/server.ts`, so the rule could not have lived in the server
 * either. Anything added here that needs an import belongs in a different file.
 *
 * WHO RELIES ON IT — every surface that echoes caller-supplied text back as one line:
 *
 *   1. `mcp/task-runner.headerText()` — the `# <title>`, `- worker:`, `- model:` lines of
 *      `tasks/<id>.md`, written by the `-p` dispatch path.
 *   2. `mcp/bg-runner`'s RUNNING/DONE/FAILED writers — the same header lines for the `--bg`
 *      (mesh) dispatch path, plus `- mesh:` and `- worktree: … (branch …)`; they import
 *      `headerText` from task-runner so the two dispatch paths cannot diverge.
 *   3. `registry.recoveredErrorLabel()` — the one-line `TaskEvent.error` label composed from a
 *      recovered worker's own prose (up to 256 KiB of it), rendered as a tree-item row by
 *      `views.ts` and returned as a JSON string by `dispatch_status`.
 *   4. `TaskEvent.promptPreview` — built by both dispatch paths from the dispatched prompt,
 *      i.e. fully caller-controlled, and rendered as a tree tooltip (`views.ts`,
 *      `history-view.ts`) and as a `title=` attribute in the dashboard webview
 *      (`dashboard.ts`).
 *   5. `mcp/server.ts oneLine()` — every ledger-sourced value the `mesh_status` report prints
 *      (worker name, account, model, role, task id, job id, config dir, worktree, branch, the
 *      rendered attach command). It calls `flattenChars`, NOT `flattenOneLine`, and the reason
 *      is spelled out on `flattenChars`: `mesh_status` output for ordinary workers has to stay
 *      byte-identical, and `flattenOneLine`'s whitespace collapse would change it.
 *   6. `mesh/pool.ts errorValue()` — foreign values (a ledger job id or name, a caller-supplied
 *      stop target) interpolated into the `mesh error [<code>]: <detail>` strings returned by
 *      `mesh_stop_worker` / `mesh_send_worker`, i.e. into JSON an orchestrating model parses.
 *
 * Sites 5 and 6 were the drift this module was created to end and did not, for one release:
 * `server.oneLine` predated it and was left alone, and `pool.errorValue` was written fresh
 * against `pool.ts may not import server.ts` — which was true, and pointed at this file. Both
 * now import from here. If you are about to write a fourth spelling because importing this feels
 * heavier than a `.replace()`, that is exactly the reasoning that produced the first three.
 *
 * WHAT IT GUARANTEES those readers, and it is narrow and total: whatever a caller supplies, the
 * value comes back as ONE line of well-formed, left-to-right, control-free text, and producing
 * it never throws.
 *
 * THE RESIDUALS, STATED EXACTLY, because an over-claim is worse than the hole it hides. The
 * previous version of this header claimed the variation-selector rule "takes back everything
 * that is not a real variation sequence", and a hostile review then drove 41 of 41 selectors
 * through it. There are three residuals and no others:
 *
 *   1. U+200C ZWNJ and U+200D ZWJ are KEPT — they are what holds an emoji sequence together, see
 *      `INVISIBLES` — so a run of them still carries about one bit per character, invisibly.
 *      That is the irreducible price of "emoji must survive readable", and it is accepted.
 *   2. A variation selector is kept ONLY directly behind a character that can bear one AND that
 *      occupies visible width, at most one per bearer — see `SELECTOR_WITHOUT_VISIBLE_BEARER`.
 *      The selector alphabet is still an alphabet, but every symbol of it now costs a VISIBLE
 *      character in the rendered label: the 82-code-point, zero-visible-glyph payload that
 *      defeated the previous rule is no longer constructible, and a Latin-script label carries
 *      zero bits, because no Latin letter is a bearer. Where the bearer is an ideograph the
 *      surviving capacity is that of an Ideographic Variation Sequence itself — about a byte per
 *      visible ideograph — which is inherent in keeping IVS at all.
 *   3. It removes INVISIBILITY; it does not promise LEGIBILITY. A value made entirely of
 *      combining marks, private-use code points or unassigned code points survives and may
 *      render as little or nothing depending on the font. That is a legibility problem and not a
 *      smuggling channel: none of those characters is a bearer, so none of them can carry a
 *      selector, and a label that renders as nothing is at least a label a human can SEE is
 *      wrong.
 *
 * What it does NOT claim is anything about the value's MEANING — a title that flattens to the
 * exact text `- worker: someone-else` is an ordinary title and is returned as one. None of these
 * surfaces is a parser boundary; all of them are display.
 *
 * NOTHING HERE IS A LENGTH POLICY. Each caller keeps its own cap and its own truncation marker,
 * because a markdown header line, a tree-item label, a tooltip preview, a `mesh_status` row and
 * an error-message quotation are different budgets. `sliceOneLine` exists only so that CUTTING
 * at whichever length a caller chose cannot undo the well-formedness the flattening established.
 */

/**
 * Characters that would end a LINE, or split one for a reader that does not split on `\n`.
 * Defined by Unicode CATEGORY rather than by enumeration on purpose: the input is arbitrary
 * text, and a list of bad spellings is a blacklist, not a boundary.
 *
 *   - \p{Cc} — every C0/C1 control. LF and CR are the obvious ones; VT, FF and NEL (U+0085)
 *     split lines for splitlines()-style readers that never see a `\n`; NUL truncates a C
 *     string; ESC injects terminal escape sequences into every surface that echoes the value
 *     back — a tree label, a webview cell, a terminal that cats the file.
 *   - \p{Zl} / \p{Zp} — U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: line breaks that
 *     are not `\n`, so a newline-only filter would hand them straight to a reader that splits
 *     on them.
 *
 * FLATTENED to a space rather than deleted: each of these stands where a word break stood in the
 * original text, and the space is what keeps `"Fix the parser\r\nand its tests"` legible. This
 * is the ONLY class that becomes a space; every other class below is deleted, because every
 * other class is zero-width and a space in its place is a visible artifact the reader never had.
 */
const LINE_BREAKERS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * U+2800 BRAILLE PATTERN BLANK — the one assigned character that renders as BLANK WIDTH while
 * being neither whitespace, nor a format character, nor Default_Ignorable, so every class in this
 * file used to let it straight through.
 *
 * Unicode has no property for "renders as nothing". `Default_Ignorable_Code_Point` is the closest
 * and deliberately EXCLUDES this one, because in braille it is a real character: it is the
 * braille SPACE. Which is exactly why it is FLATTENED TO A SPACE rather than deleted — the same
 * treatment, for the same reason, as the line breakers above. In legitimate braille it stands
 * where a word break stands, and deleting it would run `⠓⠑⠇⠇⠕<U+2800>⠺⠕⠗⠇⠙` together into
 * one word. (The separator is written as its code point rather than embedded: embedded, it
 * is invisible, and the example would already look joined.) As a space the break survives and the character stops being invisible.
 *
 * MEASURED, which is why it is here at all. A hostile review built `<U+2800><selector>` repeated
 * and got 41 of 41 selectors through the previous adjacency rule — 82 code points rendering as
 * nothing whatsoever — and separately got 500 lone U+2800 through, which makes a worker NAME
 * render as nothing. As a space, the first payload's bearers become spaces and no selector
 * survives, and the second collapses to `''` under `flattenOneLine`, where every caller already
 * has a placeholder for an empty value.
 *
 * ENUMERATED, AND THE ENUMERATION IS DELIBERATELY NOT LOAD-BEARING. A blacklist of one code point
 * cannot be a boundary — this file's own discipline says so — so nothing security-relevant rests
 * on it. The boundary is `SELECTOR_WITHOUT_VISIBLE_BEARER` below, a positive whitelist: a blank
 * character this line has never heard of still cannot carry a selector, because it is not on the
 * list of bearers. This line only stops such a character from being an invisible SPACER.
 */
// Written as an ESCAPE, not as the character: this is a file about invisible characters, and a
// literal U+2800 in the source is a regex a reader cannot see the contents of.
const BLANK_GLYPHS = /\u2800/gu;

/**
 * Every Unicode bidirectional control: U+061C ALM, U+200E LRM, U+200F RLM, the U+202A–U+202E
 * embeddings and overrides (RLO among them), and the U+2066–U+2069 isolates. Named by the
 * `Bidi_Control` PROPERTY, so the set is Unicode's own and stays complete as Unicode grows —
 * the same category-not-enumeration discipline as the class above.
 *
 * These break no line, so the line-breaker class leaves them intact — which was defensible while
 * this rule protected a parser and is not now that display is the entire purpose. A bidi control
 * is the presentation-layer equivalent of a terminal escape: U+202E RLO renders the rest of a
 * string right-to-left, and an unterminated isolate reorders the text that FOLLOWS it, so a
 * value can be made to DISPLAY as a value nobody wrote. HTML-escaping the surrounding markup
 * does not help: to an escaper these are ordinary characters, and to a renderer they are
 * instructions.
 *
 * Every Bidi_Control is today also `\p{Cf}`, so INVISIBLES below would remove all of them on its
 * own. Kept as its own named class anyway: this class exists because of what these characters DO
 * to a rendered line, and that reason must not come to depend on a general-category coincidence
 * that a future Unicode version is free to break.
 */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

/**
 * Every invisible with NO text-shaping role — the class the first version of this file did not
 * have, and the hole a hostile review walked through.
 *
 * THE UNION, and why it takes two properties rather than one:
 *
 *   - \p{Default_Ignorable_Code_Point} — Unicode's own name for "a code point a renderer should
 *     draw as nothing". It is what covers the characters that are invisible without being
 *     `Format`: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0 (category `Lo` — pseudo
 *     LETTERS that render as blank width, which is how a worker name can *display* as a
 *     different name, or as no name at all), U+034F CGJ, U+17B4/U+17B5, and the WHOLE of plane
 *     14 including the unassigned slots of the tag block. Unassigned matters: an unassigned
 *     default-ignorable renders as nothing today and may be assigned tomorrow, and either way it
 *     is not text a human is reading.
 *   - \p{Cf} — every Format character. It is what covers the invisibles Unicode deliberately
 *     EXCLUDES from Default_Ignorable: U+FFF9–U+FFFB, the interlinear annotation anchors (they
 *     are excluded because a renderer is supposed to show annotation structure, which is exactly
 *     why they may not ride inside a one-line label), and the prepended concatenation marks
 *     (U+0600–U+0605, U+06DD, U+070F, U+0890/U+0891, U+08E2, U+110BD, U+110CD). It also covers
 *     U+180E MONGOLIAN VOWEL SEPARATOR, U+FEFF, U+2060–U+2064, U+206A–U+206F, and the musical
 *     and Egyptian format controls.
 *
 * KNOWINGLY SACRIFICED, so nobody has to rediscover it: U+180E and the prepended concatenation
 * marks are real characters of real scripts, and this deletes them. They are not glyph-joining
 * controls — they do not select or fuse a neighbouring glyph — and on a surface that is a
 * one-line LABEL rather than a text renderer, an invisible-or-spanning format control is a
 * smuggling channel long before it is typography. The incumbent `mesh_status` spelling already
 * sacrificed U+180E; this only makes that decision explicit and uniform.
 *
 * THE KEEPERS ARE THE POINT OF THE LOOKAHEAD, and they are why this MUST NOT be "simplified"
 * back into a range. The obvious-looking spelling — strip U+200B–U+200F wholesale, as the old
 * `mesh_status` rule did — takes U+200C ZWNJ and U+200D ZWJ with it, and those two are the
 * characters that HOLD EMOJI TOGETHER. Under a range strip, a family emoji shatters into three
 * separate people, a rainbow flag becomes a white flag next to a rainbow, and Persian and Indic
 * text loses the ZWNJ that separates its words. Measured, against the old rule: 5 of 14 emoji /
 * ZWNJ probes came back altered. So the keeper set is exactly the invisibles that CHANGE THE
 * RENDERING OF A NEIGHBOURING GLYPH:
 *
 *   - U+200C ZWNJ, U+200D ZWJ — join and separate; every multi-person emoji, every profession
 *     emoji, every flag-with-a-symbol, and ordinary Persian/Urdu/Hindi/Bengali prose.
 *   - `\p{Variation_Selector}` — U+FE00–U+FE0F, the U+E0100–U+E01EF supplement, and the
 *     Mongolian free variation selectors U+180B–U+180D and U+180F. VS16 is what makes U+2764 a
 *     red heart instead of a black dingbat; VS15 is what makes it a dingbat on purpose; the
 *     supplement carries every Ideographic Variation Sequence; the Mongolian ones do the same
 *     job for Mongolian. Named by the PROPERTY rather than by three hand-written ranges, for two
 *     reasons. The supplement sits INSIDE plane 14 next to the tag block, so `Default_Ignorable`
 *     covers both and cannot tell them apart, which means the carve-out has to be explicit
 *     however it is spelled. And the property is the SAME SET that
 *     `SELECTOR_WITHOUT_VISIBLE_BEARER` bounds below, so the keeper set and the bounded set
 *     cannot drift apart — the hand-written range had already lost U+180F, a Mongolian selector
 *     Unicode added after this file was written. (U+180E, one code point after the third
 *     Mongolian selector, is not a variation selector and is NOT a keeper — see above.)
 *
 * Skin-tone modifiers (U+1F3FB–U+1F3FF, `Sk`), regional indicators (U+1F1E6–U+1F1FF, `So`) and
 * the combining enclosing keycap (U+20E3, `Me`) are none of these properties and were never at
 * risk; they are listed here only so the next reader does not go looking for them in the keeper
 * set. Verified in both directions — see the self-check: 35 emoji/ZWNJ/variation/RTL/Indic
 * constructions survive byte-identical, and 0 of 64 invisible, control and line-breaking probes
 * survive.
 *
 * KEEPING THE VARIATION SELECTORS OPENS A HOLE OF ITS OWN, and it is BOUNDED one class below
 * rather than here: they are ~260 zero-width code points, a WIDER smuggling alphabet than the
 * 96-symbol tag block. `SELECTOR_WITHOUT_VISIBLE_BEARER` bounds it to at most one selector per
 * VISIBLE bearer character — read it before assuming these are kept unconditionally, and before
 * assuming they are stripped either.
 */
const INVISIBLES =
  /(?![\u200C\u200D\p{Variation_Selector}])[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

/**
 * The Unicode Tag block, U+E0000–U+E007F, named on its own even though `INVISIBLES` already
 * covers every code point in it.
 *
 * This is the canonical invisible-ASCII-smuggling encoding: U+E0041 is a TAG LATIN CAPITAL A,
 * and a whole sentence written in tag characters renders as nothing at all while being perfectly
 * legible to any model that reads the string. It was measured riding a recovered worker error
 * into `TaskEvent.error` — 14 tag characters, invisible in the tree row, returned verbatim to
 * the orchestrating model by `dispatch_status`.
 *
 * It gets its own line because it is the one class whose removal must not be an inference. A
 * future editor narrowing `INVISIBLES` (to a category, to a range, to whatever looks tidier)
 * would have to delete THIS line explicitly to lose it, and this comment is what they would have
 * to read first.
 */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * A variation selector standing where nothing can BEAR one. This is the only positional rule in
 * the file, and it is the SECOND version of that rule, so it needs both its own reason and its
 * predecessor's failure stated plainly.
 *
 * WHY SELECTORS ARE BOUNDED AT ALL. They have to survive `INVISIBLES` — they are exactly what
 * makes U+2764 a red heart rather than a black dingbat, and they carry every Ideographic
 * Variation Sequence — and that keeper carve-out is a ~260-symbol alphabet of zero-width code
 * points, a HIGHER-bandwidth smuggling channel than the tag block this file was written to
 * close. Measured against the character classes alone: a 50-character instruction encoded as
 * variation selectors rode through `flattenOneLine` with all 50 code points intact.
 *
 * WHY THE PREVIOUS RULE DID NOT HOLD, because this one has to avoid the same trap. It was a
 * negative lookbehind over a NEGATED class — delete a selector unless what precedes it is
 * start-of-value, whitespace, a joiner, or another selector — which is a BLACKLIST of non-bases.
 * So "a real base character" really meant "any code point that survived the classes above", and
 * the smuggler picks the base. U+2800 BRAILLE PATTERN BLANK is category `So`, is not whitespace,
 * is not `Cf` and is not Default_Ignorable: it survived, and it counted as a base.
 * `<U+2800><selector>` repeated gave 41 of 41 selectors through alongside 41 invisible braille
 * blanks — 82 code points and ZERO visible glyphs, about a byte per two code points at no visual
 * cost, roughly 64x the ZWJ/ZWNJ residual this project has explicitly accepted. It was driven end
 * to end into `TaskEvent.error`, which `dispatch_status` returns to an orchestrating MODEL, and
 * an invisible channel there is instruction injection rather than a display bug.
 *
 * SO THIS RULE IS A WHITELIST OF BEARERS, in two clauses, and a selector is deleted if EITHER
 * fires. The whitelist IS the fix: a character nobody has thought of fails it by default, which
 * is the one property a blacklist can never have.
 *
 *   1. What precedes must be a character Unicode actually registers variation sequences FOR.
 *      `\p{Emoji}` covers every emoji base — including the digits and `#`/`*` that keycap
 *      sequences are built on; `\p{Ideographic}` covers Ideographic Variation Sequences and the
 *      CJK compatibility variants; `\p{Math}` covers the standardized variants of the
 *      mathematical symbols; `\p{Script=Mongolian}` covers what the Mongolian free variation
 *      selectors attach to. Nothing else can be selecting anything: not a Latin letter, not a
 *      space, not the start of the value, and not U+2800.
 *   2. What precedes must not be ZERO-ADVANCE — not `\p{Mn}`, `\p{Me}` or `\p{Cf}`. This clause
 *      is what makes clause 1's "visible" TRUE rather than merely asserted, and it is not
 *      hypothetical: U+16FE4 KHITAN SMALL SCRIPT FILLER is `Mn`, a NONSPACING mark with zero
 *      advance width, and is `Ideographic=Yes`, so clause 1 on its own would have re-opened the
 *      braille hole under a different code point. It also closes, for free and without depending
 *      on any property staying as it is, the two spellings that must never be bearers whatever
 *      Unicode does next: every variation selector is itself `Mn`, so a RUN of selectors keeps
 *      only its first (a run is a payload, not a sequence), and ZWJ/ZWNJ are `Cf`, so
 *      `<ZWJ><selector>` repeated — the channel's other spelling — carries nothing. Sweeping the
 *      whole bearer set turned up a THIRD case nobody would have guessed: the Mongolian free
 *      variation selectors are themselves `Script=Mongolian`, so under clause 1 alone each one
 *      is a legal bearer for the NEXT and a run of them is unbounded — 40 of 41 measured.
 *
 * CLAUSE 2 IS WHAT MAKES THE WHOLE RULE TRUE, and that is measured over the whole alphabet
 * rather than argued from examples. Of the 114,851 code points clause 1 admits, clause 2 removes
 * 34 zero-advance ones (the Mongolian selectors, U+16FE4, the invisible math operators
 * U+2061–U+2064, and the combining marks of U+20D0–U+20EF). Of the 114,817 that remain, ZERO are
 * Default_Ignorable, zero are whitespace, zero are unassigned, zero are private-use and zero are
 * noncharacters. So "the bearer occupies visible width" is a checked property of the entire
 * bearer set, not a claim about the characters someone happened to test.
 *
 * WHAT SURVIVES is precisely the legitimate capacity: at most one variation selector per visible
 * bearer. Verified in both directions in the self-check — family and profession ZWJ sequences,
 * the rainbow flag, VS15 and VS16 hearts, skin tones, flags, keycaps, Ideographic Variation
 * Sequences and Mongolian free variation selectors all come back byte-identical, and every
 * bearer-less payload comes back with no selectors at all.
 *
 * KNOWINGLY SACRIFICED, so nobody has to rediscover it: a standardized variation sequence whose
 * base is neither emoji, ideographic, mathematical nor Mongolian — in practice the Phags-pa
 * ones — loses its selector. On a one-line LABEL that is a glyph-variant difference in a script
 * these labels have never carried, and the alternative is widening the bearer set until it stops
 * being a whitelist.
 *
 * RUNS AFTER the line breakers and the blank glyphs, which is load-bearing: `<CR><selector>` and
 * `<U+2800><selector>` have to reach this pass with a SPACE in front of the selector, or clause 1
 * would be judging a character that is no longer there.
 */
const SELECTOR_WITHOUT_VISIBLE_BEARER =
  /(?:(?<![\p{Emoji}\p{Ideographic}\p{Math}\p{Script=Mongolian}])|(?<=[\p{Mn}\p{Me}\p{Cf}]))\p{Variation_Selector}/gu;

/**
 * Unpaired UTF-16 surrogates — all of them, wherever they sit, not merely a half left behind at
 * a truncation boundary. In `u` mode a match advances by CODE POINT, so a well-formed pair is a
 * single astral code point outside this range and only an orphaned half can match: the class is
 * exactly "the code units that are not a character".
 *
 * A lone surrogate is not encodable as UTF-8, so `fs.writeFileSync` substitutes U+FFFD without
 * complaint and the value reaches the file — and every surface echoing it — visibly corrupted;
 * `JSON.stringify` escapes it on its own into every event record. Removed from the INPUT rather
 * than only at a cap, because a lone LOW surrogate can sit anywhere in an arbitrary caller
 * string (a JSON payload, a clipboard paste, a name another tool already truncated), and no
 * amount of care at the cut boundary reaches it.
 *
 * Removed FIRST of all the classes, which is load-bearing rather than stylistic: the astral
 * classes above (the tag block, the plane-14 half of `INVISIBLES`) can only match code points,
 * so they need the string to be well-formed UTF-16 before they run.
 */
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;

/** A trailing HIGH surrogate: the only orphan a cut through already-flattened text can create. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * THE CHARACTER RULE, and nothing else: no whitespace collapse, no trim, no length policy.
 *
 * This is the half of `flattenOneLine` that every caller must share, split out from the half
 * that not every caller may take. `mcp/server.ts oneLine()` is the caller that needed the split:
 * its output is the `mesh_status` report, and two things there are load-bearing.
 *
 *   1. `mesh_status` for ordinary workers must stay byte-identical across this change. Its
 *      values are filesystem paths and shell command strings, where a run of spaces is DATA —
 *      `/Users/x/My  Documents` is a real directory and `flattenOneLine` would render it as
 *      `/Users/x/My Documents`, which is a different path. Collapsing whitespace is right for a
 *      title and wrong for a path.
 *   2. `attachCommandWithholdReason` withholds the printed attach command unless
 *      `oneLine(cmd) === cmd` — it runs the RENDERER and demands a no-op, which is what makes
 *      the bytes it checked the bytes it prints. Under a whitespace collapse that guard would
 *      start withholding the attach command for every user whose config dir holds two adjacent
 *      spaces: a real setup, silently degraded, for no gain.
 *
 * So: same classes, same order, same deletions, applied to the caller's own whitespace. Total
 * for the same reason `flattenOneLine` is — see there.
 */
export function flattenChars(raw: unknown): string {
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : String(raw);
  } catch {
    // String() throws on any object whose toString or valueOf does, on a null-prototype object
    // (no toString to find), and on a Proxy whose get trap throws — none of which may take a
    // write path down with it. Note it does NOT throw on a symbol: String(sym) is the one
    // conversion the spec special-cases, and it is why the explicit String() call is here at
    // all rather than a template literal, which throws on exactly that value.
    return '';
  }
  return text
    .replace(LONE_SURROGATES, '')
    .replace(BIDI_CONTROLS, '')
    .replace(INVISIBLES, '')
    .replace(TAG_CHARACTERS, '')
    .replace(LINE_BREAKERS, ' ')
    .replace(BLANK_GLYPHS, ' ')
    .replace(SELECTOR_WITHOUT_VISIBLE_BEARER, '');
}

/**
 * Flatten one caller-supplied value to a single line of display-safe text. No length policy —
 * see `sliceOneLine` and the caller's own cap for that.
 *
 * Total by construction: it never throws, whatever it is handed, because every one of its
 * callers sits on a write path (an output file, an appended event record, an error message that
 * still has to reach the caller) and losing that write over a hostile value would only trade one
 * failure for another. A hostile value is neutralised, never rejected. `raw` is `unknown` rather
 * than `string` for the same reason: the header values include numbers and fields typed `string`
 * that arrive from `JSON.parse` of a worker's stdout, which is to say from nowhere in
 * particular.
 *
 * This is `flattenChars` — the shared character rule, read it for the class-by-class reasoning
 * and for why emoji survive it — plus the two whitespace steps a title-shaped caller wants and a
 * path-shaped caller must not have: every remaining whitespace run collapses to one ASCII space
 * (which also folds away NBSP and the ideographic spaces JS counts as `\s`), and the ends are
 * trimmed.
 *
 * Returns `''` for a value that flattens away to nothing (and for one that cannot be converted
 * to a string at all). Each caller substitutes its own placeholder, because what an empty title
 * should read as in a markdown header is not what an empty error label should read as. Note that
 * a value made entirely of invisibles — a name spelled in Hangul fillers, say — now lands in
 * exactly that case, which is the honest answer: it never had any visible text in it.
 */
export function flattenOneLine(raw: unknown): string {
  return flattenChars(raw).replace(/\s+/g, ' ').trim();
}

/**
 * Cut already-flattened text to at most `max` UTF-16 code units without leaving an orphaned
 * surrogate half behind.
 *
 * A cut at a fixed COUNT can land between the two halves of a surrogate pair. The orphan is not
 * a character: it is unencodable as UTF-8 (so a file write silently substitutes U+FFFD), it has
 * to be escaped on its own by every JSON encoder that touches it, and it renders as a
 * replacement glyph. Dropping it costs one astral character — usually one emoji — and keeps the
 * returned string well-formed UTF-16.
 *
 * Only a trailing HIGH surrogate is possible here, and only because the input is assumed to have
 * been through `flattenOneLine`, which removes every orphan already: in well-formed text the
 * sole way to create one is to cut between a pair, which leaves the high half at the end. On
 * input that never saw `flattenOneLine` this still does the trailing-half trim and nothing more,
 * which is strictly better than not doing it, but is not the guarantee above.
 *
 * EVERY caller that cuts must come through here rather than call `.slice()` itself. That is not
 * a style preference: `mesh/pool.errorValue` cut with a raw `.slice(0, 80)`, and a value whose
 * 80th and 81st units were the two halves of an emoji came out ill-formed — measured, 5 of 484
 * pad/tail combinations — into a `mesh error […]` string that an orchestrating model then parses
 * out of JSON.
 *
 * Adds no marker. Whether a truncation should announce itself, and with what text, is the
 * caller's policy — see `headerText`'s `…` and `recoveredErrorLabel`'s explicit note about where
 * the full text lives. Total: a `max` that is not a positive number yields `''` rather than a
 * throw or a surprise, for the same write-path reason as above.
 */
export function sliceOneLine(text: string, max: number): string {
  if (typeof text !== 'string') {
    return '';
  }
  const limit = typeof max === 'number' && max > 0 ? Math.floor(max) : 0;
  if (limit === 0) {
    return '';
  }
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}
