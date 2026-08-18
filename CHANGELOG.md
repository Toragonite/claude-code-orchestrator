# Changelog

All notable changes to **Claude Code Orchestrator** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] — 2026-08-18

Mesh Mode gains a **Worker History** view, a configurable retention cap, and a **Clear stopped workers** command, and every mesh worker's full prompt is now persisted so a finished worker's task stays readable. The dispatch path is unchanged: with Mesh Mode **off**, dispatch behaves exactly as in 1.5.0 — `src/mcp/task-runner.ts` is untouched. What changed is the extension UI, the retention logic, and one additive persistence write on the mesh path.

### Added
- **Worker History view.** A new tree lists finished (`done`/`error`) mesh dispatches for the workspace, newest first; each row opens the task's output, and its hover carries the full prompt, model, account, branch and completion time. A worker that kept its worktree (uncommitted work) is flagged so the unmerged branch is never silently lost.
- **`claudeCodeOrchestrator.meshHistoryLimit`** (default `50`, min `1`, max `1000`, editable in the dashboard) — how many stopped workers the history retains before the oldest are dropped. Enforced both in the view and by the reaper's cap-prune on the ledger.
- **Clear stopped workers** command, inline on the Attachable workers group — drops the retained stopped-worker records for the workspace (never a live, keep-alive, or worktree-owning record).
- **Full-prompt persistence.** Each mesh dispatch writes its complete task prompt to `tasks/<id>.prompt.txt` (best-effort, capped at 64 KiB), so a surface can show the whole task instead of only the 300-character preview even after the worker is gone.

### Changed
- **The Attachable workers tree now lists only LIVE workers**, and each row expands to read-only detail: project/worktree, dispatch task, started time, idle-since, account/model/role, and a copy-paste attach command. Stopped workers move to the new Worker History view.
- **Dispatched task rows are colored by dispatch mode** — mesh (blue), detached (purple), one-shot `claude -p` (no color) — with a full-metadata hover. The status-shaped icon (and its spinner) is unchanged; only its color and tooltip are new. This is a UI change for all tasks, including on the mesh-off path; dispatch execution is unchanged.

### Fixed
- **A kept worktree is never pruned or cleared even when its recorded path is empty, absolute, or escaping.** History retention now requires a real relative worktree path under the workspace before treating a record as still owning a worktree, closing an edge where such a record became permanently un-removable and the Clear command appeared to do nothing.
- **The history view and the reaper's cap-prune read the retention limit from a single sanitized source**, so a non-integer setting can no longer make the view show a different count than the ledger retains; the limit is bounded to `[1, 1000]` everywhere.

### Notes
- Mesh Mode stays experimental. With it off, dispatch is byte-identical to 1.5.0 on the `claude -p` code path.

## [1.5.0] — 2026-08-13

Mesh Mode (experimental) is reworked into **attachable, worktree-isolated dispatch**. With Mesh Mode **off**, this release is byte-identical to 1.4.2.

### Changed
- **Mesh Mode is now attachable dispatch — the separate mesh workflow is gone.**
  With Mesh Mode on, `dispatch_task` / `dispatch_tasks` spawn persistent,
  attachable `claude --bg` sessions instead of one-shot workers, and that is the
  whole feature: same tools, same results, same timeouts, same cancellation, same
  quota-aware failover. There is nothing new to call and no second work path. You
  can attach a terminal to a running worker, and the orchestrator can message it
  mid-task while it reports progress back. **With Mesh Mode off, dispatch is
  exactly what it was before** — one one-shot worker per task, on the unchanged
  code path.
- **Every mesh dispatch now runs in its own git worktree, so results come back as
  a branch to merge.** In a git workspace a worker edits inside
  `.claude/worktrees/cco-<taskId>` on branch `worktree-cco-<taskId>` instead of
  the shared checkout, and the dispatch result, the task output file and
  `mesh_status` all name that worktree and branch. The orchestrator's doctrine is
  to verify the worktree, merge what passes, then remove it and stop the worker.
  There is no worktree in two cases, and the result then carries no worktree line:
  a workspace that is not a git repository, and a dispatch that fell back to a
  one-shot worker. This is the biggest behavioral change in the release: a
  dispatch is not integrated until its branch is merged.
- **Worker teardown became the orchestrator's explicit job, with backstops.** A
  worker no longer disappears when its dispatch returns. Idle auto-stop, a
  live-worker cap and session-end reaping sit beneath the orchestrator's own
  stop discipline; a worktree holding uncommitted changes is always kept, never
  removed for you, and stays listed in `mesh_status`.
- **The dashboard's Mesh card** now carries the idle auto-stop and max-live-worker
  numbers and describes attachable dispatch; the Worker Accounts tree group is
  named **Attachable workers**, its rows show each worker's dispatch task and
  keep-alive mark, and attaching from the tree marks the worker keep-alive first
  so the idle sweep cannot stop a session you are sitting in.

### Added
- **`mesh_send_worker`** — send live mid-task guidance, a correction, or an answer
  to one running worker of this workspace. Delivery is queued and lands at the
  worker's next turn boundary, so it never interrupts a tool call. A steer may
  amend the task (the newer instruction wins) but cannot widen the worker's
  file-ownership list.
- **`mesh_keep_worker`** — mark a worker keep-alive so idle auto-stop leaves it
  alone. Session-end reaping still applies.
- **`claudeCodeOrchestrator.meshWorkerIdleTimeoutMin`** (default `15`, `0`
  disables) — minutes an idle attachable worker may sit before it is stopped.
- **`claudeCodeOrchestrator.meshMaxLiveWorkers`** (default `8`) — cap on live
  attachable workers. Dispatches past the cap are **refused, not queued**: the
  task fails with a `worker_cap` error naming the limit, so a batch cannot
  deadlock waiting for slots nobody frees.
- **Result files as the channel of record.** A worker's report travels in a file
  the dispatch server reads; the live message channel carries only short wake
  pings, progress notes and steering. A dead relay costs you live steering and
  progress notes, never results — a pending dispatch still settles from its file,
  and `mesh_status` says so.

### Removed
- **`mesh_spawn_workers` and `mesh_send`.** Dispatch spawns the workers now, and
  messaging is scoped to this workspace's own workers — `mesh_send_worker`
  refuses any other address, which is what keeps worker-to-worker messaging
  retired. `mesh_receive` kept its name but is now the live feed of this
  workspace's dispatch workers rather than a general peer inbox.
- **The `claudeCodeOrchestrator.meshCrossAccountBridge` setting.** Cross-account
  registry mirroring still runs — it is what lets a worker under one account
  reach the relay under another — but it is internal plumbing that starts with
  the mesh, not a user-facing opt-in. Old settings files carrying the key are
  harmless; nothing reads it.

### Fixed
- Concurrent ledger writes from the extension host and the dispatch server no
  longer lose each other's updates (a keep-alive mark could be clobbered by a
  simultaneous activity write); every writer now goes through one exclusive lock.
- Each dispatch's task and result files live in their own directory, granted to
  that worker alone and carrying a per-task token, so one worker cannot settle
  another's dispatch even with a well-formed result file.
- Cancelling a running mesh dispatch from the tree no longer inflates the
  worker's error count or writes a second terminal event, and it now records the
  worker as stopped so the idle sweep stops retrying it.
- An oversize (> 256 KB) result file now fails its dispatch immediately, naming
  the size and path, instead of being ignored until the task times out.
- A worker that drops its turn without reporting is nudged by the system after
  about three minutes of silence (sooner on short timeouts) and resumes; if the
  account's plan window is actually exhausted, the attempt fails fast and fails
  over to another account, as a one-shot dispatch does.

### Notes and known rough edges
- **Attachable workers author files; they do not run your build.** They are
  spawned without the Bash tool (Claude Code may still auto-approve obviously-safe
  read-only commands, so treat them as file authors rather than as sandboxed), and
  the workspace's MCP servers are disabled for them, so a worker cannot dispatch
  further workers.
- **`detach: true` tasks still run as one-shot workers**, even with Mesh Mode on:
  a detached task is meant to outlive the session and the relay is not.
- **Costs and counters.** While Mesh Mode is on, one small `claude -p` relay
  session runs on your main account (`meshGatewayModel`, `haiku` by default). The
  CLI reports no usage for `--bg` sessions, so attachable dispatches record 0
  tokens and 0 cost in this extension's own counters and charts (task output says
  `tokens n/a`); each account's live plan usage is unaffected.
- **Progress notes are best-effort.** Their end-to-end fidelity was not measured
  under load — the file channel is what dispatch correctness rests on. In the
  runs that were observed, progress and question lines arrived byte-exact.
- **Leftover worktrees.** If a session ends before the removal runs, clean
  `cco-…` worktrees can accumulate under `.claude/worktrees/`; remove them with
  `git worktree remove`. Immediately after a worker finishes, a genuinely clean
  worktree is occasionally reported as *kept* — nothing is lost, and removing it
  a few seconds later succeeds. Stopping a worker also clears its background job,
  so a dispatch that times out can take up to about 15 seconds longer to report.
- **A retry after a failed attempt reuses the same task worktree**, so its branch
  can carry both attempts' edits — verify the whole diff before merging.
- **A worker's own error report is not classified as a quota error**, so an error
  report mentioning rate limits does not trigger a cooldown or a failover; it is
  surfaced to the orchestrator as written. Genuine mid-run exhaustion is caught by
  the silence check above, which reads the account's real plan usage.
- Mesh Mode remains experimental and rides Claude Code internals that have no
  public API. It is verified against Claude Code 2.1.226–2.1.227 on macOS and
  Linux; if those internals move, mesh initialization fails and dispatch falls
  back to one-shot workers rather than breaking.

## [1.4.2] — 2026-08-10

### Fixed
- **The orchestrator now actually reaches for Mesh Mode.** With Mesh Mode enabled,
  `orchestrator_briefing` returns a mesh doctrine (injected only when `meshMode` is on)
  that tells the main session when to prefer the `mesh_*` tools — a persistent,
  conversational, or self-coordinating worker — over one-shot dispatch. Previously the
  `mesh_*` tools were exposed but nothing instructed the orchestrator to use them, so a
  session following the dispatch policy never did.

### Changed
- **Slimmer, clearer README.** Added a "gateway vs bridge" explainer to the Mesh Mode
  section (why the gateway exists, and that the bridge is only for multiple accounts),
  and condensed the most reference-heavy passages. Tri-lingual (en/ko/zh).

## [1.4.1] — 2026-08-10

### Added
- **Mesh Mode toggles in the Orchestrator Dashboard.** Enabling the experimental
  Mesh Mode no longer requires digging through VS Code Settings — the dashboard's
  Settings card now has checkboxes for `meshMode` and the cross-account bridge, plus
  a gateway-model selector. They write the same settings and take effect on the next
  Claude session in the workspace.

## [1.4.0] — 2026-08-10

### Added
- **Mesh Mode — a live session mesh (experimental).** Built on Claude Code's
  own cross-session messaging (default-on since CC 2.1.224; macOS or Linux
  only — unix sockets, no Windows support). Five new MCP tools —
  `mesh_status`, `mesh_spawn_workers`, `mesh_send`, `mesh_receive`,
  `mesh_stop_worker` — let the orchestrator spawn persistent `claude --bg`
  background workers with quota-aware account placement (mirroring
  dispatch's logged-out/cooldown/exhausted/overage/frontier guards), hold a
  live back-and-forth with them between messages while each keeps its own
  context, and stop them individually. The Worker Accounts view gains
  attach, logs, and stop actions for mesh workers, so a background worker
  can be opened in an integrated terminal tab to watch and steer directly.
  Mesh is a live coordination layer, not a replacement for dispatch:
  durable results, timeouts, cancellation, and quota-precise per-task
  routing stay on `dispatch_task`/`dispatch_tasks`. New setting
  `claudeCodeOrchestrator.meshMode` (default `off`) is the master switch.
- **Cross-account bridge (experimental², off by default).** New
  `claudeCodeOrchestrator.meshCrossAccountBridge` setting mirrors live
  session-registry entries across every registered account's
  `CLAUDE_CONFIG_DIR`, so mesh workers on other worker accounts — not only
  the main account — become reachable. This depends on an unpublished
  Claude Code file format with no public API; it is built to auto-degrade
  rather than break dispatch if a future Claude Code release changes that
  format, but keep it off unless you specifically need cross-account mesh
  workers.
- **Gateway relay session.** Because the VS Code panel session cannot join
  the mesh directly (an upstream limitation), Mesh Mode hosts its own
  background `claude -p` relay session — the gateway — as the
  orchestrator's mesh identity, handling `mesh_send`/`mesh_receive` on its
  behalf. New setting `claudeCodeOrchestrator.meshGatewayModel` (default
  `haiku`) selects the gateway's model; it performs only trivial relay
  turns.
- **Detachable (survivable) dispatch.** `dispatch_task`/`dispatch_tasks`
  gain an opt-in `detach` flag: a standalone background supervisor owns the
  task, records its result, and keeps running even if the orchestrator
  session ends mid-dispatch — while the session stays alive the blocking
  behavior and returned result are unchanged. The new `dispatch_status`
  tool inspects or retrieves a dispatched task's result by id, including a
  detached task whose session was interrupted. Internally the per-task
  dispatch core is factored into a standalone runner so the in-process
  server and the detach supervisor run identical logic.

### Notes
- Mesh Mode is experimental and version-sensitive to Claude Code's own
  internals, including file formats that are not part of any public API —
  see `docs/session-messaging-spike.md` for the full verification evidence
  it is pinned against (Claude Code 2.1.226). Dispatch remains the durable,
  quota-precise path for production work; treat mesh as a live coordination
  layer on top of it, not a substitute.

## [1.3.0] — 2026-07-20

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
- **New commands for asset management:** **Sync Assets** (pulls in pack
  updates, silently or on demand) and **Reset Asset** (force-overwrites a
  file or a whole asset back to the pack version), alongside **Open Asset
  Manager**. Two new settings back these: `claudeCodeOrchestrator.assetPacks`
  (additional pack directories to load assets from) and
  `claudeCodeOrchestrator.assetAutoSync` (default on — syncs enabled assets
  silently on activation).

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
