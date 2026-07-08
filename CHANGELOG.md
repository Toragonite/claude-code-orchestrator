# Changelog

All notable changes to **Claude Code Orchestrator** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-07-08

### Added
- **Asset Manager panel and asset packs.** A dedicated panel
  (**Claude Code Orchestrator: Open Asset Manager**) manages "asset packs" —
  directories of Claude Code skills, agents, commands, output styles, and
  hooks — installed per-workspace into `.claude/`. Add pack directories (e.g.
  a private assets repo) alongside the bundled pack, toggle individual assets
  on and off, see per-asset and per-file sync status (synced / update
  available / customized / conflict / not installed), diff or reset any file
  that's out of sync with the pack, and scaffold new assets with
  **New asset…**. Sync never overwrites a file you've edited by hand.
- **Five asset types**, including a new **hooks** type: a hook is a script,
  not markdown, and is scaffolded as an executable shell skeleton whose
  comments show how to wire it into `.claude/settings.json` — installing the
  script does not register it on its own.
- **Tri-lingual UI.** The extension's commands, settings, and webviews are now
  available in English, Korean, and Simplified Chinese.
- **Main-session check-in freshness.** The dashboard now shows how long ago
  the current session briefed in and how long ago it was last active, so a
  stale "not checked in yet" no longer lingers after switching accounts; a
  "Reset session check-in" button clears it manually.

### Changed
- **Worker timeout is now configurable.** The wall-clock limit per dispatch
  is controlled by the new `claudeCodeOrchestrator.workerTimeoutMinutes`
  setting (1–480 minutes), with a default raised from a fixed 30 minutes to
  45, and can be overridden per dispatch with a `timeout_minutes` argument.

### Fixed
- **Dispatches could hang forever** when a worker spawned subprocesses (as
  the Claude Code CLI does for shell-tool calls) that outlived the worker
  itself — the dispatch now always returns within seconds of its timeout
  regardless of any lingering subprocess.

## [1.0.1] — 2026-07-08

### Changed
- Updated the Marketplace icon.

## [1.0.0] — 2026-07-08

First public release.

### Added
- **Multi-account dispatch from the Claude Code panel.** Your main session
  designs and verifies while worker Claude accounts implement in parallel,
  through an MCP dispatch server registered in the workspace `.mcp.json`.
- **MCP tools:** `dispatch_tasks` (parallel batch), `dispatch_task`,
  `list_workers`, and `orchestrator_briefing`.
- **Accounts as config directories.** Each worker is a Claude Code config
  directory (`~/.claude-<name>`) with its own login; the extension never
  handles tokens or credentials.
- **Quota-aware scheduling and failover.** Per-worker usage tracking, automatic
  cooldown and failover on quota/rate-limit errors, and a ★ preferred worker
  that is favored without being flooded.
- **Frontier billing guard.** Worker dispatches to `claude-fable-5` are blocked
  by default (they may bill per use) and steered to `claude-opus-4-8` +
  `ultrathink`; toggleable per workspace via a setting and a dashboard control.
- **Three-layer orchestration prompt stack** — a worker base prompt, a
  `CLAUDE.md` dispatch policy, and a briefing-delivered model calibration —
  tuned across four A/B benchmark rounds. See `docs/benchmarks.md`.
- **Views and dashboard.** Worker Accounts and Dispatched Tasks tree views, plus
  an editor-tab Orchestrator Dashboard with stat tiles, activity and usage
  charts, and a settings panel.
- **Trilingual documentation** (English, Korean, Simplified Chinese).

### Notes
- Requires the Claude Code CLI and one or more additional Claude accounts to use
  as workers.
- Using multiple Claude accounts is subject to Anthropic's Terms of Service; you
  are responsible for ensuring your setup complies. Unofficial extension — not
  affiliated with, sponsored, or endorsed by Anthropic.
