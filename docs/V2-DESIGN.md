# v2 design — asset packs & session sync

Status: in development on the `v2` branch (pushed to the private repo only;
`origin` carries released code).

## 1. Asset pack system

Deploy Claude Code assets (skills, agents, commands, output styles) from
"asset packs" into workspaces, with per-workspace selection and an update
sync that never touches user customizations.

### Sources

| Pack | Location | Visibility |
| --- | --- | --- |
| `bundled` | `assets/` inside the extension | public (ships in the .vsix) |
| user packs | directories in the `claudeCodeOrchestrator.assetPacks` setting | private (e.g. a private repo clone) |

A pack is a plain directory mirroring `.claude/` layout (`skills/`, `agents/`,
`commands/`, `output-styles/`) with an optional `pack.json` (`{"name"}`).
Anything bundled into the .vsix is public the moment the extension is
published — personal assets therefore belong in a private pack repo, never in
`assets/`.

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

Hardening (from the adversarial review):

- rel paths are validated (`isSafeRel`) at every write/delete — a tampered or
  corrupt ledger cannot reach outside `.claude/`.
- Install-path conflicts (two enabled assets shipping the same rel, e.g. a
  private override of a bundled command): the first pack in order owns the
  path; the loser is reported/badged as `conflict`, never mislabeled
  customized. Disabling the owner hands the recorded hash to the other
  enabled claimant instead of deleting the file.
- Pack renames migrate ledger records to the new keys (matched by recorded
  install paths) instead of orphaning the pack's own installs.
- The ledger is written atomically (tmp+rename); an unparseable ledger is
  moved aside to `cco-assets.json.corrupt` rather than silently replaced.
- A no-op sync in a workspace with nothing managed writes nothing — bare
  repos stay bare.

### Surface

- **Asset Manager panel** (`openAssetManager`, dashboard button, view title
  icon): pack-source administration (add/remove/reveal), per-workspace toggle
  table with status badges (synced / update available / customized /
  conflict / not installed), summary counts, filter (matches status words),
  per-file detail rows with open / pack version / diff (any out-of-sync
  installed file) / per-file reset, orphan card with confirmed clean-up, and
  guided `New asset…` scaffolding into a writable pack. Polling is gated on
  panel visibility. Destructive actions (reset, orphan clean) confirm via
  modal listing the affected files.
- Commands: `manageAssets` (quick pick), `syncAssets`, `resetAsset`.
- Settings: `assetPacks: string[]`, `assetAutoSync: boolean` (default true —
  silent refresh on activation, notification only when something changed).

### Later

- Hook/settings-fragment assets (needs JSON merge, not file copy — riskier).
- Nested command namespaces (`commands/foo/bar.md`).
- mtime-keyed hash cache if large packs make the visible-poll noticeable.

## 2. Main-session check-in freshness

Problem: after switching the main account, the dashboard showed a stale model
or "not checked in yet" until the new session's first `orchestrator_briefing`.

- Every dispatch-server tool call now stamps `lastSeen` for the workspace
  (only the main session talks to this server, so any call proves liveness).
- Dashboard shows `briefed Xm ago · active Xm ago`, or "active … — briefing
  pending" when the session is alive but hasn't briefed yet.
- "Reset session check-in" button clears the record after an account switch.

## 3. Repo topology (hybrid)

- `origin` → public `claude-code-orchestrator`: **main only** (push refspec
  pinned to main).
- `private` → private `claude-code-orchestrator-dev`: `v2` development
  (upstream of the v2 branch).
- private `claude-assets` repo → personal asset pack, cloned locally and
  registered in `assetPacks`. Never merged into this repo.
- Release flow: merge `v2` → `main`, push `origin main`, publish. Personal
  assets stay in their own repo throughout.
