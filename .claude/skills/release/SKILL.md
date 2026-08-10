---
name: release
description: Cut a release of the Claude Code Orchestrator extension — bump the version, update the changelog and release notes, build the .vsix, and publish to the VS Code Marketplace (vsce) and Open VSX (ovsx). Use when the user says "release", "cut a release", "publish the extension", "ship v1.x", "bump and publish", or asks to deploy a new version to the marketplaces.
---

# Release the extension

End-to-end release workflow for this VS Code extension: version bump → changelog/release
notes → build → verify → publish to both marketplaces → tag. The build/publish plumbing
already exists in `package.json` scripts (`package`, `publish`, `publish:ovsx`,
`publish:all`); this skill sequences them safely and fills in the human steps around them.

## Inputs

- **Target version** — read from the user's request (e.g. "release v1.4.0"). If they only
  say "release" or "bump", infer the bump from the work since the last tag: new
  user-facing feature → minor; fixes only → patch; breaking change → major (SemVer). State
  the version you picked and proceed; it is reversible before publish.
- **Marketplaces** — default BOTH (VS Code Marketplace via `vsce`, Open VSX via `ovsx`).
  Only skip one if the user says so.

## Preconditions (check first, do not skip)

1. **Clean-ish tree / right branch.** `git status`. Release from a release branch or `main`
   per the repo's convention (`git branch --show-current`). Uncommitted *release* edits
   (version, changelog) are expected; unrelated uncommitted work is a stop-and-ask.
2. **Publisher auth exists.** Publishing needs tokens the operator holds, NOT committed:
   - `vsce` needs a VS Code Marketplace PAT (`VSCE_PAT` env var, or `vsce login <publisher>`).
   - `ovsx` needs an Open VSX token (`OVSX_PAT` env var, or `ovsx create-namespace`/`--pat`).
   Do not ask the user to paste tokens into the chat. If a publish step fails on auth,
   report exactly which token is missing and how to set it, and stop before retrying.
3. **Build is green.** `npm run compile` must pass before anything else.

## Steps

### 1. Bump the version
Edit `package.json` `"version"` to the target. Keep it the single source of truth — the
`.vsix` filename and `publish:all` derive from `$npm_package_version`.

### 2. Update the changelog
Prepend a new section to `CHANGELOG.md` in the existing Keep-a-Changelog format:
`## [<version>] — <YYYY-MM-DD>` with `### Added` / `### Changed` / `### Fixed` / `### Notes`
subsections. Use today's date. Summarize the actual work since the last released version
(read `git log <last-tag>..HEAD --oneline` and the diff). Match the tone and depth of
existing entries — this file is user-facing release notes.

### 3. Update READMEs if the feature surface changed
If the release adds/renames settings, commands, or tools, reflect it in `README.md` and the
translations (`README.ko.md`, `README.zh-CN.md`) so the three stay in parity. Skip for
pure-fix releases.

### 4. Build and verify the package
```
npm run compile
npx vsce ls          # inspect the file manifest that will ship
```
Confirm the manifest ships what it should (`out/**`, `l10n/**`, `package.nls*.json`,
`media/**`) and does NOT ship dev-only files (`.claude/`, `.orchestrator/`, `docs/`,
`CLAUDE.md`, `.mcp.json`, `src/**` if the repo excludes it, `*.vsix`). If a `.vscodeignore`
governs this, verify against it. Fix leaks before publishing.

### 5. Build the .vsix
```
npm run package      # → claude-code-orchestrator-<version>.vsix
```
Sanity-check the produced filename matches the target version.

### 6. Publish
Prefer the repo's combined script, which packages once and pushes to both marketplaces:
```
npm run publish:all
```
`publish:all` = `vsce package` + `vsce publish --packagePath <vsix>` + `ovsx publish <vsix>`.
If the user asked for only one marketplace, run the single target instead:
- VS Code Marketplace only: `npm run publish` (`vsce publish`)
- Open VSX only: `npm run publish:ovsx` (`ovsx publish`)

Publishing is an outward-facing, hard-to-reverse action: it pushes a public artifact to
third-party registries. Confirm the version and marketplaces with the user before running
the publish command unless they already said "publish without asking". A published version
number cannot be reused — a mistake means bumping again.

### 7. Commit and tag
After a successful publish:
```
git add package.json CHANGELOG.md README*.md
git commit -m "Release v<version> — <one-line summary>"
git tag v<version>
```
Push the branch and tag when the user is ready (`git push && git push --tags`). Follow the
repo's remote convention (see CLAUDE.md / repo memory: which remote is public vs private).

## Failure handling

- **`vsce`/`ovsx` auth error** → name the missing token and how to provide it; stop.
- **Version already exists on a marketplace** → the version was published before; bump to
  the next patch and redo from step 1. Never force-overwrite a published version.
- **Manifest leaked a dev file** → fix `.vscodeignore` (or file placement) and repackage;
  do not publish a package that ships `.mcp.json`, `CLAUDE.md`, or `.claude/`.
- **One marketplace succeeded, the other failed** → the succeeded one is now public; do NOT
  bump to "retry both". Publish only the failed marketplace's single target for the same
  version once its issue is fixed.

## Report

Finish with: the published version, which marketplaces got it (with the gallery/registry
URLs when the tool prints them), the changelog section added, and whether the commit/tag
were created and pushed. If publish was skipped (dry run / build-only), say so plainly.
