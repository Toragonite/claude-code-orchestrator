# Bundled asset pack

Assets in this directory ship inside the extension (and are therefore public
once published to the Marketplace — keep personal assets in a private pack
consumed via the `claudeCodeOrchestrator.assetPacks` setting instead).

Layout mirrors a workspace's `.claude/` directory:

```
assets/
  pack.json               # { "name": "bundled" } — pack display name (optional)
  skills/<id>/            # one directory per skill, must contain SKILL.md
  agents/<id>.md
  commands/<id>.md
  output-styles/<id>.md
  hooks/<name>.sh         # or hooks/<name>/ for a script bundled with support files
```

## Discovery rules, per type

- **`skills/<id>/`** — one directory containing a `SKILL.md`; every other file
  under that directory (at any depth) is a supporting file for that one
  skill. A subdirectory never becomes a second skill.
- **`agents/`, `output-styles/`** — every `.md` file is discovered
  recursively, exactly like `commands/` below. Claude Code itself only
  documents namespacing for commands, so a nested `agents/team/reviewer.md`
  will be installed by this engine even if Claude Code does not load it as a
  namespaced agent — the recursive walk is applied uniformly because it can
  only find more files, never fewer.
- **`commands/<id>.md`** — discovered recursively, so
  `commands/frontend/component.md` installs as the asset `frontend/component`,
  invoked as `/frontend:component`. Custom commands are now merged into
  skills upstream (`commands/deploy.md` and `skills/deploy/SKILL.md` both
  create `/deploy`), and a skill additionally supports a directory of
  supporting files and model-invocation control — existing `commands/` files
  keep working, but new work generally belongs in `skills/`.
- **`hooks/<name>.sh`** (or any extension, or none) — a top-level *file* is one
  hook; a top-level *directory* is one hook bundling everything beneath it,
  the same way a skill bundles its supporting files. A hook's id strips one
  trailing extension (`block-rm.sh` → `block-rm`); if that would make two
  files in the same directory collide on an id (`fmt.sh` and `fmt.py`), both
  keep their full filename instead. Hooks are scripts, not markdown — they
  carry no frontmatter and no description.

  **A hook script installed here registers nothing by itself.** Wiring a hook
  into an actual Claude Code event lives in the workspace's
  `.claude/settings.json` (its `hooks` block); this pack only gets the script
  file onto disk with its executable bit mirrored from the source. Scaffold a
  new hook with **New asset…** in the Asset Manager and its comments show the
  exact `settings.json` entry to add.

Nothing here is installed automatically. Users pick assets per workspace via
**Manage Workspace Assets**; sync then keeps the installed copies up to date
while never overwriting files the user has edited by hand.

## Sync contract (for pack authors)

- **If a user edits an installed file by hand**, the next sync detects the
  mismatch against both the pack's current content and the hash recorded at
  the last sync, marks the file **customized**, and leaves it alone — it is
  reported, never silently overwritten. It stays that way until the user
  reverts their edit or explicitly resets the asset to the pack version
  (whole-asset or single-file reset, both destructive and confirmed).
- **If you rename your pack** (the `pack.json` `name`, or the directory when
  there's no `pack.json`), every asset key changes, since a key embeds the
  pack name (`<pack>:<type-dir>/<id>`). Sync detects an enabled ledger record
  whose key vanished and migrates it to the one newly-loaded, not-yet-recorded
  asset that ships the same install paths — so a straightforward rename
  doesn't orphan your own users' installs. If more than one candidate asset
  matches, or none does, the old record is instead reported as orphaned.
- **If two enabled packs ship the same install path** (e.g. a private
  override of a bundled command), the first pack in load order (bundled pack,
  then `assetPacks` entries in setting order) owns that path — sync writes
  only the owner's copy. The loser is badged **conflict** in the Asset
  Manager, never mislabeled "customized". Disabling the owning asset hands its
  recorded hash to the other enabled claimant, so that asset can then take
  over the file instead of it being deleted out from under the user.

Files you haven't touched show as up to date or "update available" (synced
automatically, or via **Sync Workspace Assets Now**); files you've edited show
as "customized" until reset with **Reset Customized Asset to Pack Version**.
