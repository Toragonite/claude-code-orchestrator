# v2 plan — asset templates + tri-lingual UI (en / ko / zh-cn)

## Decisions

- **Version strategy: do this in v2, not a 1.1.0 backport.** Localization is a
  feature, not a fix; v2 already rewrote most of the string surface (Asset
  Manager), so backporting would mean translating and merging the same files
  twice. v2 → main merge ships it once.
- **Templates**: replace TODO prose with structural placeholders. YAML
  frontmatter uses `#` comments (the only valid comment syntax there); the
  markdown body uses `<!-- -->`. Frontmatter keys are present with empty
  values so the shape is visible and `readDescription` degrades to "no
  description" rather than lying.
- **Localization mechanism**: the two VS Code standards, nothing custom.
  - `package.json` static contributions → `%key%` + `package.nls*.json`.
  - Runtime strings → `vscode.l10n.t()` + `l10n/bundle.l10n.<lang>.json`
    (requires `"l10n": "./l10n"` in package.json). Bundle keys ARE the English
    source strings; a missing key silently falls back to English, so parity is
    a verification gate, not a hope.
  - Webviews run in a separate JS context with no `vscode.l10n`. The extension
    host builds a strings object and injects it as JSON into the page.
- **Not localized** (deliberate): `src/prompts.ts` and `src/mcp/server.ts`.
  Those strings are read by Claude, not by the user, and the workspace policy
  pins contracts/worker prompts to English. `src/registry.ts` must stay
  vscode-free (the MCP server bundles it), so it gets no `l10n` import.

## Shared contract files (written by the orchestrator)

- `src/webviewUtil.ts` — `jsonForScript(value)`: JSON for embedding in an
  inline `<script>`; escapes `<`, U+2028, U+2029.
- `src/syncReport.ts` — `describeSyncReport(report)`, localized. Moves out of
  `assets.ts` so the engine stays vscode-free.

## Task decomposition (phase 1, parallel — disjoint file ownership)

| Task | Owns | Definition of done |
| --- | --- | --- |
| T1 package.nls | `package.json`, `package.nls.json`, `package.nls.ko.json`, `package.nls.zh-cn.json` | every localizable contribution field is `%key%`; all three nls files have identical key sets |
| T2 runtime l10n | `src/extension.ts`, `src/views.ts`, `src/workerManager.ts` | every user-facing string wrapped in `vscode.l10n.t()`; `{0}`-style args, never string concatenation |
| T3 webview l10n | `src/dashboard.ts`, `src/assetManager.ts` | exports `<name>Strings()` builder + `<name>Html(s)` taking the strings object; page uses `S.key`, never a literal |
| T4 templates | `src/assets.ts` | `ASSET_TEMPLATES` emit comment placeholders; `describeSyncReport` removed (moved to `syncReport.ts`) |

Phase 2 (after phase 1 typechecks): one translation task authors
`l10n/bundle.l10n.ko.json` and `l10n/bundle.l10n.zh-cn.json` from the actual
extracted `l10n.t()` literals.

## Premortem — how this ships broken

1. **`%key%` in a field VS Code does not substitute** → the literal `%key%`
   renders in the UI. Pin: only `command.title`, `command.category`,
   `view.name`, `viewsContainer.title`, `configuration.title`,
   `configuration.properties.*.description`, `*.enumDescriptions[]`,
   `walkthrough.title/description`, `walkthrough.steps[].title/description`.
   Never `when`, `activationEvents`, `command` ids, enum *values*.
2. **nls key missing from one language** → literal `%key%` for that user.
   Gate: key-set equality across the three nls files, both directions.
3. **`l10n.t()` literal absent from a bundle** → silent English fallback, which
   looks like "translation half-done". Gate: every `t('…')` literal present in
   both bundles.
4. **Placeholder arity drift** (`{0}` in English, none in Korean) → the value
   vanishes from the message. Gate: placeholder set equality per key.
5. **`</script>` inside a translated string** breaks the webview. Pin:
   `jsonForScript` escapes `<`.
6. **Webview HTML functions become untestable** if they call `l10n.t()`
   directly. Pin: html functions are pure and take a strings object.
7. **`l10n/` or `package.nls*.json` excluded from the .vsix** → shipped
   monolingual. Gate: `npx vsce ls`.
8. **Locale id casing**: VS Code expects `zh-cn` lowercase in both file
   families. A `zh-CN.json` is silently ignored.
9. **Template frontmatter invalid** after the rewrite → `loadPack` stops
   discovering the asset it just created. Gate: existing probe
   "new skill discovered by loadPack".
10. **Removing `describeSyncReport` from `assets.ts`** breaks the headless
    probes that import it. Gate: run all probe suites after integration.

## Verification gates

1. `npm run compile` (tsc strict + esbuild bundle).
2. Probe suites 1–3 (updated for the moved `describeSyncReport` and the
   strings-object signature).
3. New probe suite: nls key parity, l10n bundle parity, placeholder arity,
   `%key%` field whitelist, `jsonForScript` escaping, template frontmatter
   round-trip through `loadPack`.
4. Render both webviews in all three languages; assert no `undefined` and no
   raw `%` key leaks.
5. `npx vsce ls` includes `l10n/**` and `package.nls*.json`.
6. Adversarial review dispatch (fresh context, opus + ultrathink).

## Glossary (frozen — translators must not diverge)

| en | ko | zh-cn |
| --- | --- | --- |
| worker account | 워커 계정 | 工作账户 |
| dispatch | 디스패치 | 分发 |
| orchestrator | 오케스트레이터 | 编排器 |
| asset pack | 에셋 팩 | 资源包 |
| workspace | 워크스페이스 | 工作区 |
| skill / agent / command / output style | 스킬 / 에이전트 / 커맨드 / 출력 스타일 | 技能 / 代理 / 命令 / 输出样式 |
| sync | 동기화 | 同步 |
| customized | 커스터마이즈됨 | 已自定义 |
| conflict | 충돌 | 冲突 |
| quota | 쿼터 | 配额 |
| cooldown | 쿨다운 | 冷却 |
| frontier model | 프런티어 모델 | 前沿模型 |
| preferred | 우선 | 优先 |
| permission mode | 권한 모드 | 权限模式 |

## Lessons

- 2026-07-08: the asset engine's "protect customized files" rule mislabeled a
  legitimate override (same install path from two packs) as user-customized.
  A safety mechanism must be cross-checked against the *normal* usage pattern
  it will collide with, not only against hostile input.
