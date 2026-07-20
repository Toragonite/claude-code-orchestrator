# Changelog

All notable changes to **Claude Code Orchestrator** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] — 2026-07-20

### Fixed
- **Usage probes no longer break for hours after the `claude` CLI is
  reinstalled or moved** (the "usage unavailable: spawn failed: spawn claude
  ENOENT" incident). Two layers: settings sync no longer overwrites a
  previously-good absolute `claude` path with the bare fallback name when
  login-shell resolution transiently fails — the last known good path is kept
  while it still exists on disk as an executable file and still matches the
  configured command name — and every usage/auth probe now re-resolves the
  `claude` binary at spawn time when the registry value is a bare name or a
  dead absolute path, memoized per process with a 60-second retry throttle, so
  probes work even in processes that lack the login-shell PATH (VS Code
  extension hosts, the bundled MCP dispatch server). The same re-resolution now
  covers worker dispatch too — the bundled MCP dispatch server resolves the
  `claude` binary the same way when launching worker sessions, so dispatches
  recover alongside the usage panel instead of silently staying broken behind a
  healthy-looking panel. Resolution also gained a deterministic fallback: when
  the non-interactive login-shell lookup can't find the binary (login shells
  don't read `.zshrc`, where version managers commonly edit PATH), well-known
  install locations are checked directly — `~/.npm-global/bin`, `~/.local/bin`,
  Homebrew and `/usr/local/bin`, the newest nvm version, and `~/n/bin`.
- **Failed usage probes are no longer cached as if they were successes.** An
  errored account entry now goes stale after 60 seconds instead of the full
  4-minute freshness window, so the next refresh picks it up promptly instead
  of showing a stale error for the rest of the window — in practice the
  bundled MCP dispatch server's usage path recovers within about a minute of
  the underlying cause being fixed, and the editor's periodic refresh within
  its normal cycle.
- **Hardened login-shell path resolution against shell injection.** The
  configured `claude` command is only interpolated into the `command -v`
  lookup when it is a plain bare command name (letters, digits, dot,
  underscore, hyphen); absolute paths are used as-is and anything else is
  never passed to a shell. The value can originate from workspace-level
  settings or the hand-editable shared registry file, so it is now treated
  as untrusted.

## [1.2.0] — 2026-07-20

### Added
- **Expired-login detection.** An account whose subscription OAuth session has
  expired (or that was never logged in) used to be indistinguishable from a
  token/API-key account — both showed "no plan limits". The usage refresher now
  runs a fast `claude auth status --json` probe for exactly those ambiguous
  accounts and surfaces an expired login as its own state on the dashboard usage
  card, the Worker Accounts tree, and `list_workers` — instead of the misleading
  token-account message. Genuine token/API-key logins are unaffected (they
  report `loggedIn: true`), and the probe result for them is memoized for six
  hours so they are not re-probed every refresh cycle.
- **One-click re-login.** An expired account's dashboard card gains a
  **Re-login** button, and worker items gain a **Re-login Account** context-menu
  command. Both open a terminal with the account's `CLAUDE_CONFIG_DIR` set,
  running `claude auth login` with the account's email pre-filled from its
  config directory.
- **Dispatch protection for logged-out workers, with live self-heal.**
  Automatic assignment skips a logged-out worker and naming one explicitly is
  refused with recovery instructions — but before refusing, the dispatch server
  re-checks the login live (bounded: 5s per probe, at most 3 accounts per
  dispatch), so an account you just re-logged-in becomes dispatchable
  immediately, without waiting for the next usage refresh.
- **Session keepalive (opt-in).** New setting
  `claudeCodeOrchestrator.sessionKeepalive` (default **off**): sends one minimal
  `haiku` request per subscription account per 24 hours to keep OAuth sessions
  fresh. Pings run sequentially, skip the main session, accounts with a running
  dispatch, and exhausted windows (a keepalive can never trigger overage
  billing); failed pings back off for 6 hours, and editors sharing the machine
  coordinate through a claim file so accounts are not double-pinged.
- **Overage dispatch guard.** New setting
  `claudeCodeOrchestrator.overageWorkerDispatch` (`block` by default): when
  blocking, the dispatch server never assigns work to a quota-exhausted worker —
  not even one with extra-usage billing enabled — so dispatch can never spend
  money past a plan window. Refusals name the setting and include each worker's
  reset time. Set it to `allow` to restore the previous last-resort fallback
  (every such dispatch still carries the explicit ⚠ billing warning).

### Changed
- **Overage fallback now requires opt-in (behavior change).** Previously,
  when every eligible worker was exhausted, automatic assignment silently fell
  back to a worker with overage billing enabled and billed real money; naming
  an exhausted overage-enabled worker also proceeded billably. Both paths are
  now refused unless `overageWorkerDispatch` is set to `allow`.
- **The two billing guards are now impossible to confuse.** The frontier
  setting is relabeled "frontier **model** dispatch (claude-fable-5 only — its
  own quota / per-use billing)" and its description now states it does **not**
  prevent overage billing for other models; the new overage guard sits next to
  it in the dashboard as "overage dispatch (spend extra credit past plan limits
  — any model)". `list_workers` per-worker lines and footnotes reflect the
  actual guard state.

### Fixed
- **Expired logins no longer masquerade as token accounts** across the
  dashboard, tree view, and `list_workers` (previously they rendered as
  "no plan limits — token / non-subscription", and dispatches to them failed
  mid-task with an authentication error).
- Worker terminals now quote a configured `claude` path containing spaces.
- `main` is reserved as a worker name (add, import, and rename), preventing a
  worker from shadowing the orchestrator session's own account in usage views
  and the re-login flow.

## [1.1.2] — 2026-07-15

### Added
- **Distinct "temporarily unavailable" plan-usage state.** When an account's
  live plan usage briefly comes back empty even though it has reported rate-limit
  windows before, the Worker Accounts tree and the Orchestrator Dashboard now say
  "temporarily unavailable" (with the age of the last good reading) instead of
  the "no rate-limit windows reported" message. This state is a known, transient
  upstream `get_usage` hiccup — the numbers return on their own — and is now
  clearly separated from an account that has no plan at all ("no plan limits")
  and from one that genuinely reports no windows.
- **Quota-aware dispatch.** A worker whose plan window is exhausted is now
  skipped by automatic assignment and refused at the dispatch MCP server, so
  work is not sent to an account that cannot run it. The one exception is an
  account with overage billing enabled: exhausting its window bills money
  against the monthly cap instead of blocking, so such a worker stays
  dispatchable — automatic assignment falls back to it only when no
  non-exhausted worker is available, and every overage dispatch carries an
  explicit ⚠ warning (in the returned result and the task output file) that it
  is spending real money.
- **Guard against reusing another worker's login.** Adding a worker whose config
  directory (`~/.claude-<name>`) already belongs to a registered worker is now
  refused, and if that directory exists with a leftover login from a
  since-renamed worker (a worker keeps its original directory when renamed), a
  confirmation dialog warns before the existing login is reused.
- **Prompt visible on running tasks.** Dispatched tasks now show what they are
  running — a prompt preview in the Dispatched Tasks tooltip, the dashboard
  task-row hover, and the task output file — without opening the output.
- **Dashboard button on the Worker Accounts view.** The Orchestrator Dashboard
  can now be opened from the Worker Accounts view title, not only the Dispatched
  Tasks view.

### Changed
- **Cross-editor shared refresh throttle.** Automatic account-usage refreshes
  (on activation and on the 5-minute timer) now skip probing when another editor
  window sharing the same usage cache refreshed recently, avoiding redundant
  `get_usage` probes. The explicit Refresh Account Usage command still forces a
  live probe.

### Fixed
- Worker Accounts context-menu commands (rename, re-login, remove, toggle
  preferred, open session) now act on the account you clicked instead of
  re-prompting a picker to choose one.

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
