# Changelog

All notable changes to **Claude Code Orchestrator** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-07-13

### Fixed
- The frontier billing-guard setting (`claudeCodeOrchestrator.frontierWorkerDispatch`)
  is stored in one shared file that every editor with the extension writes
  to. An editor where the setting was left unset used to overwrite another
  editor's explicit `allow` back to the default `block`, so frontier dispatch
  stayed blocked even though the setting showed `allow`. Now an editor only
  changes the guard when its setting is explicitly set; an unset editor no
  longer clobbers another editor's choice, and the guard reverts to the safe
  `block` default only when the editor that enabled it clears the setting.
- The Orchestrator Dashboard now shows the guard value actually in effect and
  which editor set it, so a mismatch between what one editor shows and what
  the dispatch server enforces is visible.

## [1.1.0] — 2026-07-09

### Added
- **Live per-account plan usage.** The Worker Accounts tree, the Orchestrator
  Dashboard, and `list_workers` now surface each account's real claude.ai plan
  usage — Session (5-hour), Weekly (7-day), and Weekly Fable utilization, with
  reset times — fetched via Claude Code's `get_usage`. Covers the main account
  (the orchestrator's own session), not only workers.
- **Overage-billing visibility.** `list_workers`, the Worker Accounts tree,
  and the dashboard now surface each account's overage-billing state: off
  (a plan limit blocks further work at no cost) or on (work past a window is
  billed against the account's monthly cap, shown with current spend and
  cap). Informational only — this release does not block or throttle
  dispatches based on it.
- **Refresh Account Usage** command (toolbar button on the Worker Accounts
  view), plus automatic refresh on activation and every 5 minutes.
- **Rename Worker Account** command (Worker Accounts view context menu).
  Changes only the worker's label — the account's config directory
  (`~/.claude-<name>`) and its login are not touched or moved. The name is a
  key in three places, and all three are migrated together: the worker
  registry, the per-worker usage stats, and the dispatch task log, so past
  tasks in the Dispatched Tasks view show the new name too. Refused while any
  dispatch is running, since the dispatch server appends to the task log
  concurrently; names must be letters, digits, `-`, or `_`, and duplicate
  names are rejected.
- **Cancel Dispatched Task** command — an inline button on a running row in
  the Dispatched Tasks view, and a Cancel button on running rows in the
  dashboard.
- **Cancel All Running Dispatches** command — a button on the Dispatched
  Tasks view title and a quick action in the dashboard; asks for
  confirmation first.
- **Orphan reclamation on startup.** On activation, any task still marked
  running whose worker process is gone is marked as orphaned and the count
  is reported.

### Changed
- The Worker Accounts tree now shows each account's real plan quota live, not
  only this extension's dispatch counts.

### Fixed
- A single truncated or malformed line in the dispatch task log used to
  discard the entire log when read, silently emptying the Dispatched Tasks
  view, zeroing the per-window dispatch usage numbers, and making
  running-dispatch detection report none. Unparseable lines are now skipped
  individually and the rest of the log is kept.
- Cancelling a dispatch (Stop) now terminates its worker processes instead
  of letting them run on. `dispatch_tasks` runs its whole batch under one
  request, so cancelling it cancels every task in the batch.
- Ending the orchestrator session (panel closed, window reloaded, VS Code
  quit, process killed) now terminates every worker it spawned instead of
  orphaning them until the 30-minute timeout — previously those orphaned
  workers kept consuming the account's plan quota.
- Before terminating anything, the extension verifies the recorded process
  ID still belongs to one of its workers, so a process ID recycled by the
  operating system for an unrelated program is never signalled.
  Cancellations are not counted as worker errors and never trigger a quota
  cooldown.
- Cancelling a dispatch or ending the orchestrator session now terminates
  the worker's entire process tree, not just the worker process. A worker
  inherits the workspace `.mcp.json` and can spawn its own dispatch server
  and delegate further; those child processes used to be left running as
  orphans that kept consuming the account's plan quota. Each worker now
  starts in its own process group, and the whole group is terminated
  together (the equivalent process-tree termination is used on Windows).
- Live plan usage now keeps showing the last good reading (marked stale, with
  its age) for up to 30 minutes when the upstream `get_usage` source briefly
  returns no rate-limit data, instead of blanking to "no rate-limit windows
  reported".

### Notes
- Real plan usage requires a subscription (Pro/Max) login. Accounts logged in
  via `claude setup-token` or another non-subscription credential have no plan
  attached and show "no plan limits".

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
