# v2 design — asset packs & session sync

Status: in development on the `v2` branch (pushed to the private repo only;
`origin` carries released code).

## 1. Asset pack system

Deploy Claude Code assets (skills, agents, commands, output styles, and hook
scripts) from "asset packs" into workspaces, with per-workspace selection and
an update sync that never touches user customizations.

### Sources

| Pack | Location | Visibility |
| --- | --- | --- |
| `bundled` | `assets/` inside the extension | public (ships in the .vsix) |
| user packs | directories in the `claudeCodeOrchestrator.assetPacks` setting | private (e.g. a private repo clone) |

A pack is a plain directory mirroring the `.claude/` layout (`skills/`,
`agents/`, `commands/`, `output-styles/`, `hooks/`) with an optional
`pack.json` (`{"name"}`). Anything bundled into the .vsix is public the moment
the extension is published — personal assets therefore belong in a private
pack repo, never in `assets/`.

### Asset types and discovery (`loadPack` in `src/assets.ts`)

| Type | Pack dir | Discovery |
| --- | --- | --- |
| `skill` | `skills/` | One directory per skill, must contain `SKILL.md`; other files under the skill directory (at any depth) are supporting files for that one skill — a subdirectory never becomes a second skill. Id is the directory name (flat). |
| `agent`, `command`, `output-style` | `agents/`, `commands/`, `output-styles/` | Recursive walk for `*.md` files. A subdirectory namespaces the id: `commands/frontend/component.md` → id `frontend/component` (invoked as `/frontend:component`). |
| `hook` | `hooks/` | A top-level **file** is one hook (a script, not markdown — no frontmatter, no description). A top-level **directory** is one hook bundling every file beneath it, the same way a skill bundles its supporting files. |

Only command namespacing is documented by Claude Code itself; the recursive
walk is applied uniformly to `agents/` and `output-styles/` too because it can
only surface *more* files, never fewer — the trade-off is that
`agents/team/reviewer.md` will be installed by this engine even if Claude Code
itself does not load agents namespaced that way.

Custom commands are now merged into skills upstream: `commands/deploy.md` and
`skills/deploy/SKILL.md` both create `/deploy` and behave the same way. A
skill additionally supports a directory of supporting files and
model-invocation control (`disable-model-invocation`), so `commands/` is
kept working for existing packs but new work generally belongs in `skills/`.
The command scaffold template says so in its comments.

#### Hook id assignment (`hookScriptId`)

A hook script's id is its filename with a single trailing extension removed —
`block-rm.sh` installs to `hooks/block-rm.sh` but is identified as the asset
`block-rm`, because the extension is an implementation detail of the script's
language, not part of its identity. If stripping extensions would make two
files in the same directory collide on one id (`fmt.sh` and `fmt.py` both
becoming `fmt`), **both** fall back to their full filename instead — which is
unique within the directory.

#### Hooks are not self-registering

Dropping a script into `.claude/hooks/` (via a pack sync) registers **nothing**
by itself. Hook wiring lives entirely in `.claude/settings.json`'s `hooks`
block; the engine only installs the script file onto disk. The scaffold
template documents the shape of the settings.json entry to add. This means
enabling a `hook` asset in the Asset Manager is necessary but not sufficient —
the user still has to reference the installed path from `settings.json`
themselves.

#### Hook executable bit (`applySourceMode`)

Hook scripts need `+x` to run at all, and a freshly written file only gets the
process umask's default mode, so the engine mirrors the pack source file's own
permission bits onto the installed copy every time it writes hook content.
This is deliberately one-way and content-keyed, not mode-keyed: the ledger
records a sha256 of file *content*, never mode, so `chmod`ing the installed
copy by hand does **not** mark it "customized" (sync will still overwrite it
on the next content change), and `chmod`ing the pack source alone — with no
content change — does not by itself schedule a rewrite of the installed copy.
Modes are re-applied only when content is rewritten.

### Per-workspace state

`.claude/cco-assets.json` in the workspace records, per asset key
(`<pack>:<type-dir>/<id>`): the enabled flag and the sha256 of each file as
last written by sync. This file is the ownership ledger — sync only ever
deletes or overwrites a file whose on-disk hash matches the ledger.

### Sync semantics (three-way hash compare)

For each file of an enabled asset — pack hash vs recorded hash vs disk hash:

| disk state | action |
| --- | --- |
| missing | install (also covers user-deleted managed files) |
| == pack | up to date; refresh ledger |
| == recorded (pack moved ahead) | overwrite with pack version |
| anything else | **customized — never written**, reported, sync continues |

Disabling an asset removes only files whose disk hash matches the ledger;
customized copies stay. A pre-existing file at an asset's target path is
treated as customized (never clobbered). An enabled asset whose pack is
unavailable (private clone missing on this machine) is reported as orphaned
and its files are left alone. Reset (whole asset, or a single file) is the
explicit escape hatch that force-overwrites.

`readDescription` extracts the first `description:` line from a file's YAML
frontmatter with `/^description:[ \t]*(.+)$/m` — `[ \t]*`, not `\s*`. `\s`
crosses newlines, so with the old pattern an *empty* `description:` line
(exactly what the comment-skeleton templates below emit) would capture
whatever frontmatter line happened to follow it, mistaking a `#` comment for
the asset's description.

Hardening (from the adversarial review):

- rel paths are validated (`isSafeRel`) at every write/delete — a tampered or
  corrupt ledger cannot reach outside `.claude/`.
- Install-path conflicts (two enabled assets shipping the same rel, e.g. a
  private override of a bundled command): the first pack in order owns the
  path (`relOwners`); the loser is reported/badged as `conflict`, never
  mislabeled customized. Disabling the owner hands its recorded hash to the
  other enabled claimant instead of deleting the file.
- Pack renames migrate ledger records to the new keys (matched by recorded
  install paths, only when exactly one loaded-but-unrecorded asset ships all
  of them) instead of orphaning the pack's own installs.
- The ledger is written atomically (tmp+rename); an unparseable ledger is
  moved aside to `cco-assets.json.corrupt` rather than silently replaced.
- A no-op sync in a workspace with nothing managed writes nothing — bare
  repos stay bare.

### Scaffolding (`createAssetTemplate`)

`New asset…` in the Asset Manager (or the underlying `createAssetTemplate`
function) writes a **comment skeleton**, not a draft: every frontmatter key is
present with an empty value, and all guidance lives in comments so nothing in
the scaffold reads as authored content the user might forget to replace.
Inside a frontmatter fence only `#` comments are legal (an HTML comment there
is a YAML parse error); the markdown body uses `<!-- -->` instead. The `hook`
template is not markdown at all — it's a POSIX shell skeleton
(`#!/usr/bin/env bash`, `set -euo pipefail`, mode `0755`) whose comments show
the exact `settings.json` entry needed to wire it up, note that the event
payload arrives as JSON on the hook's stdin, and note that a non-zero exit
blocks the tool call (exit code `2` is specifically the `PreToolUse` block
signal, with stderr routed back to Claude).

Scaffolding only ever writes into the top level of a type directory, so the
id stays flat and `ASSET_ID_PATTERN` (which forbids `/`, the traversal guard)
stays exactly as strict as it is; namespacing is a discovery-side feature —
create the subdirectory by hand and `loadPack` will pick the file up under a
nested id.

### Surface

- **Asset Manager panel** (`openAssetManager`, dashboard button, view title
  icon): pack-source administration (add/remove/reveal), per-workspace toggle
  table with status badges (synced / update available / customized /
  conflict / not installed), summary counts, filter (matches status words),
  per-file detail rows with open / pack version / diff (any out-of-sync
  installed file) / per-file reset, orphan card with confirmed clean-up, and
  guided `New asset…` scaffolding into a writable pack (the bundled pack is
  excluded — it lives in the extension install directory and is replaced on
  every extension update). Polling is gated on panel visibility (every tick
  re-hashes pack + installed files). Destructive actions (reset, orphan clean)
  confirm via modal listing the affected files.
- Commands: `manageAssets` (quick pick), `syncAssets`, `resetAsset`.
- Settings: `assetPacks: string[]`, `assetAutoSync: boolean` (default true —
  silent refresh on activation, notification only when something changed).

### Later

- `settings.json` / `CLAUDE.md` merge-style assets — these are JSON/text
  merges into a file the user also edits directly, not a file-copy sync, and
  need their own conflict model.
- A `plugins/` asset type — Claude Code plugins imply a marketplace/registry
  concept (versioned, installable-by-reference bundles), not a directory the
  engine can just mirror into `.claude/`.
- mtime-keyed hash cache if large packs make the visible-poll noticeable (the
  engine currently re-hashes every tracked file on every poll tick with no
  cache).

## 2. Main-session check-in freshness

Problem: after switching the main account, the dashboard showed a stale model
or "not checked in yet" until the new session's first `orchestrator_briefing`.

- Every dispatch-server tool call now stamps `lastSeen` for the workspace
  (only the main session talks to this server, so any call proves liveness).
- Dashboard shows `briefed Xm ago · active Xm ago`, or "active … — briefing
  pending" when the session is alive but hasn't briefed yet.
- "Reset session check-in" button clears the record after an account switch.

## 3. Localization (tri-lingual UI)

English, Korean, and Simplified Chinese, via VS Code's two separate
localization mechanisms:

- **Static `package.json` contributions** (command titles, view names,
  configuration descriptions, walkthrough text) use `%key%` placeholders,
  resolved by VS Code itself from `package.nls.json` (English) plus
  `package.nls.ko.json` and `package.nls.zh-cn.json`. All three currently
  carry 39 keys.
- **Runtime strings** go through `vscode.l10n.t()`, backed by
  `l10n/bundle.l10n.json` (base/English) plus `l10n/bundle.l10n.ko.json` and
  `l10n/bundle.l10n.zh-cn.json`, activated by `"l10n": "./l10n"` in
  `package.json`. All three currently carry 203 keys.
- **Lowercase `zh-cn`** is mandatory in both filename families — VS Code
  silently ignores a `zh-CN.json` variant.

Webviews (the Orchestrator Dashboard, the Asset Manager panel) run in a
separate JS realm with no access to `vscode.l10n`. The extension host instead
builds a plain strings object from `vscode.l10n.t()` calls
(`assetManagerStrings()`, and the dashboard's equivalent) and injects it into
the page as JSON via `jsonForScript` (`src/webviewUtil.ts`), which escapes
`<`, U+2028 and U+2029 so a translated string containing `</script>` or a
literal line separator can't break out of the inline `<script>` block.
`assetManagerHtml(s)` and the dashboard's HTML function stay pure functions of
that strings object, so they remain headlessly testable without a real
webview or the `vscode.l10n` runtime. In the page's own script, a small
`fmt()` helper substitutes `{0}`/`{1}` placeholders positionally instead of
concatenating string fragments, because Korean and Chinese often reorder
clauses relative to English.

`src/prompts.ts` and `src/mcp/server.ts` are deliberately **not** localized:
those strings are read by Claude (worker prompts, MCP tool descriptions and
error text), not by the human user, so translating them would work against
the model rather than for it.

## 4. Worker timeout semantics

- The wall-clock limit per dispatch was raised from a hardcoded 30 minutes to
  a configurable default of 45 (`claudeCodeOrchestrator.workerTimeoutMinutes`,
  range 1–480), overridable per dispatch with the `timeout_minutes` tool
  argument on `dispatch_task` / `dispatch_tasks`.
- `clampTimeoutMinutes` (in `src/registry.ts`) runs on both sides of the
  shared `registry.json`: the extension host when it writes the setting, and
  the dispatch server when it reads it before arming the timer. Non-numeric
  input falls back to the 45-minute default; numeric input is rounded and
  clamped into `[1, 480]`. The upper bound specifically guards against
  `setTimeout`'s 32-bit signed delay ceiling (2147483647 ms, ≈24.8 days) — a
  delay above that silently fires almost immediately in Node, so an
  unclamped large value would produce a *zero* timeout, not a long one.
- Kill escalation on timeout: SIGTERM at the deadline → 10 s grace
  (`KILL_GRACE_MS`) → SIGKILL → 5 s grace (`REAP_GRACE_MS`) → forced settle
  regardless of process state. A timed-out dispatch is therefore guaranteed
  to return at most 15 seconds after its deadline.
- The failure carries the worker's partial stdout/stderr captured before the
  kill (last 2000 characters of each). The timeout message's leading prose
  (`timeoutMessage()`) is deliberately written to run longer than 300
  characters, because `recordFailure()` truncates `lastError` to 300 chars for
  the tree view and dashboard — that visible slice has to be the
  human-readable summary, not truncated captured worker output.
- A timeout is classified **structurally**, via
  `err instanceof WorkerTimeoutError`, never by matching the error text
  against quota/rate-limit patterns. The timeout message embeds the worker's
  own raw stdout, which routinely contains the words "quota" or "rate limit"
  in ordinary Claude Code output, and `isQuotaError()` also matches the bare
  digits `429`/`529` — which the message's own interpolated minute count or
  character counts could incidentally produce. Misclassifying a timeout as a
  quota error would put a perfectly healthy worker on cooldown and fail the
  task over to a second worker, which would then burn its own full timeout
  window on the same too-large task. So a timeout sets no cooldown and never
  fails over — it surfaces immediately as a plain failure.
- **The hang that was found and fixed**: the dispatch's resolution used to be
  built only inside the child process's `'close'` handler, but `'close'`
  fires only once every stdio stream the child owns has reached EOF. The
  Claude Code CLI spawns its own subprocesses for bash-tool calls; if one of
  those grandchildren inherits the worker's stdout pipe and is still running
  when the worker itself exits, that pipe stays open and `'close'` never
  fires — the dispatch's Promise then never settles, hanging the MCP tool
  call forever. This was reproduced with
  `bash -c 'sleep 60 & exec sleep 60'`: `'exit'` fires promptly, `'close'`
  does not. Fixed by also settling from `'exit'`, after a 250 ms
  (`DRAIN_GRACE_MS`) drain window that gives `'close'` a chance to win the
  race first (since it guarantees complete stdout). A `settled` guard makes
  any later settle attempt — from a stray `'close'`, the drain timer, or the
  timeout path's reap timer — a safe no-op, and any forced (non-`'close'`)
  settle destroys the child's stdio streams and `unref()`s it so a
  grandchild-held pipe can no longer keep the Node event loop, and therefore
  the whole MCP server process, alive after the dispatch has already
  returned.

## 5. Repo topology (hybrid)

- `origin` → public `claude-code-orchestrator`: **main only** (push refspec
  pinned to main).
- `private` → private `claude-code-orchestrator-dev`: `v2` development
  (upstream of the v2 branch).
- private `claude-assets` repo → personal asset pack, cloned locally and
  registered in `assetPacks`. Never merged into this repo.
- Release flow: merge `v2` → `main`, push `origin main`, publish. Personal
  assets stay in their own repo throughout.
