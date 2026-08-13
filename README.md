# Claude Code Orchestrator

**English** | [한국어](README.ko.md) | [简体中文](README.zh-CN.md)

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/toragonite.claude-code-orchestrator.svg?label=VS%20Marketplace&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs-short/toragonite.claude-code-orchestrator.svg?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Open VSX](https://img.shields.io/open-vsx/v/toragonite/claude-code-orchestrator?label=Open%20VSX&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/toragonite/claude-code-orchestrator?label=downloads&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![GitHub release](https://img.shields.io/github/v/release/Toragonite/claude-code-orchestrator?label=release&logo=github)](https://github.com/Toragonite/claude-code-orchestrator/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/Toragonite/claude-code-orchestrator)](https://github.com/Toragonite/claude-code-orchestrator)
[![License: MIT](https://img.shields.io/github/license/Toragonite/claude-code-orchestrator?color=brightgreen)](LICENSE)

![Claude Code Orchestrator — multi-account parallel dispatch for Claude Code](media/screenshots/banner.png)

> Unofficial extension — not affiliated with or endorsed by Anthropic. Formerly named *Fable Orchestrator*.

Turn your existing **Claude Code** panel into a multi-account orchestrator. You chat with your main session as usual; it designs and verifies, and fans implementation work out **in parallel** to worker Claude accounts (Opus / Sonnet — or Fable, behind a billing guard) through MCP dispatch tools. Per-account usage tracking (including each account's real, live plan usage and resets), quota-aware failover, and a live dashboard included.

> **New — Mesh Mode reworked: attachable, worktree-isolated dispatch (experimental)**
> Mesh Mode is no longer a separate workflow with its own tools. With it on, every dispatched worker is a persistent `claude --bg` session you can attach a terminal to, working in **its own git worktree** — so results come back as a branch to merge — and the orchestrator can message it mid-task to steer it while it reports progress back.
> Off by default; with it off, dispatch is unchanged. Requires Claude Code CLI ≥ 2.1.224, macOS or Linux. → [Mesh Mode](#mesh-mode--attachable-dispatch-experimental)

```
Claude Code panel (main account — the orchestrator)     ← use it as usual
   │  MCP tools: dispatch_tasks / dispatch_task / list_workers / orchestrator_briefing
   ▼
cco-dispatch MCP server (registered in workspace .mcp.json)
   │  runs Claude Code CLI with CLAUDE_CONFIG_DIR=<worker dir>, same workspace
   ├──────────────┬──────────────┐
   ▼              ▼              ▼
worker w1       worker w2      worker w3
(opus-4-8)      (sonnet-5)     (opus-4-8)
```

The core idea: **an account is just a Claude Code config directory.** Each worker gets its own `~/.claude-<name>` directory; you sign in once and the stored login is reused from then on. The extension never touches tokens or credentials — login and refresh are handled entirely by Claude Code itself.

## Screenshots

*Session start: the orchestrator checks in via `orchestrator_briefing`, then reads each account's live plan usage from `list_workers` and routes around accounts near a limit:*

![Orchestrator session: briefing and live plan usage from list_workers](media/screenshots/panel-1.png)

*The parallel fan-out: the orchestrator freezes the interface contract, then dispatches the independent subtasks in one batch across the healthy worker accounts:*

![Parallel fan-out to worker accounts via dispatch_tasks](media/screenshots/panel-2.png)

*Worker accounts showing each account's live plan quota (Session 5hr / Weekly 7 day / Weekly Fable, each with a reset time) separated from this extension's own dispatch counters, plus the live task feed:*

![Worker Accounts and Dispatched Tasks views](media/screenshots/sidebar.png)

*The dashboard: stat tiles, activity charts, the live plan usage panel (per-account bars with reset countdowns), per-worker usage, and settings — including the frontier billing guard:*

![Orchestrator Dashboard](media/screenshots/dashboard.png)

## Requirements

- VS Code 1.90+
- [Claude Code](https://claude.com/claude-code) CLI installed and logged in (your main account)
- One or more additional Claude accounts to use as workers (each with a plan that can run the models you assign)

## Installation

- **Marketplace**: search for “Claude Code Orchestrator”.
- **From source**: `npm install && npm run compile`, then F5 (Extension Development Host) or `npm run package` and install the generated `.vsix`.

## Quick start

1. Open the **Claude Code Orchestrator** view in the activity bar → **Add Worker Account**. Pick a name (e.g. `w1`) and a default model; a terminal opens — sign in **once** with the Claude account for that slot. Already have `~/.claude-*` directories? Use **Import Existing Claude Config Directories** instead.
2. Run **Register Dispatch MCP Server in This Workspace** — writes a `cco-dispatch` entry into the workspace `.mcp.json` (the server binary lives at a stable path under `~/.claude-code-orchestrator/mcp/`, so extension updates never break the registration).
3. Accept the offer to add the **dispatch policy** to your workspace `CLAUDE.md` (or run **Add Dispatch Policy to CLAUDE.md** later).
4. Restart the Claude Code session and approve the project MCP server.
5. Chat as usual. Give the main session a big task and it fans out: independent subtasks are dispatched to workers in parallel while it designs, integrates, and verifies.

## The MCP tools

| Tool | Purpose |
|---|---|
| `dispatch_tasks` | **Batch dispatch (preferred).** Hand over N independent tasks in one call; the server runs them truly in parallel across worker accounts and returns collected results. |
| `dispatch_task` | Dispatch a single self-contained task to one worker (a full headless Claude Code session in the same workspace, with file and shell access). |
| `orchestrator_briefing` | Called once per session by the main model (per the CLAUDE.md policy) with its own model ID. Records the orchestrator model per workspace and returns a tier-appropriate operating brief — see *Model calibration* below. |
| `list_workers` | Per-worker default model, cumulative usage (tasks, tokens, cost), live plan usage (Session/Weekly/Weekly Fable %, with resets), each account's overage-billing state (off, or on with current spend against its monthly cap), availability/cooldowns, and the frontier-dispatch guard state. |

Dispatch parameters worth knowing:

- **`system_prompt`** — the orchestrator can send each worker a task-specific system prompt (role, quality bar, output format), layered on top of the built-in worker base prompt. This makes a large difference on complex tasks.
- **`ultrathink: true`** — mechanically escalates that worker run to maximum reasoning depth. Meant for contract-critical implementation, subtle debugging, and adversarial reviews.
- **`model`** — `claude-opus-4-8` for hard reasoning/coding, `claude-sonnet-5` for simpler or high-volume work, `claude-fable-5` only for the highest-leverage dispatches (design consults, adversarial reviews) and only if you have enabled frontier dispatch (see *Billing guard*).
- **`worker`** — optional explicit account; omit for automatic quota-aware assignment.
- **`timeout_minutes`** — optional per-task wall-clock limit in minutes (1–480), overriding the `workerTimeoutMinutes` setting for that one dispatch.

## The orchestration quality stack

Three prompt layers ship with the extension (all model-facing text is English and model-name-free):

1. **Worker base prompt** — automatically prepended to every dispatched session: contract discipline (binding interfaces, file-ownership limits), autonomy to completion, scope restraint, evidence-audited reporting.
2. **Dispatch policy** (`CLAUDE.md` block, idempotently upserted between marker comments) — the standing instructions for the *main* session. The heart of it: **the orchestrator does not implement.** It personally does only design, decomposition, dispatch, integration, and verification; all production code, tests, and docs are written by workers. Plus: batch parallelism, verification loops, hunting unknown unknowns, an escalation ladder for frontier dispatches, and reporting language rules.
3. **Model calibration** (returned by `orchestrator_briefing`) — frontier-tier orchestrator models get a short confirmation and maximum freedom; other tiers get a calibration addendum that holds them to the same operating standard during long multi-agent work (delegate-don't-implement, externalized planning, premortems with traceable probes, adversarial review with a dismissal procedure, documentation-conformance gates, evidence-based claims).

This stack is benchmark-tuned: across four two-orchestrator A/B builds of increasing difficulty, judged blind with execution-grounded probes, the scoring gap between a frontier orchestrator and a calibrated Opus orchestrator narrowed from ~11.5 points to **3 points with zero functional defects on either side**. See [docs/benchmarks.md](docs/benchmarks.md).

## Quota-aware scheduling and failover

- Per-worker cumulative usage (tasks, tokens, cost) is parsed from CLI results and recorded locally.
- On a quota/rate-limit error the worker goes on a configurable **cooldown** and the task **fails over** to another eligible worker automatically. With a single worker there is nothing to fail over to — you get a clear error instead.
- **★ Preferred worker** — mark the worker that shares your main account (right-click → *Toggle Preferred*). It wins automatic assignment whenever it isn't busier than the least-busy alternative: favored, never flooded.
- Background workers can't answer permission prompts, so they run with `--permission-mode acceptEdits` by default (configurable; tasks that must run shell commands need `bypassPermissions` — understand the security implications before enabling it).

## Overage billing visibility

Anthropic's rate-limit windows (5-hour session, 7-day weekly, weekly Fable) behave differently once you hit them depending on whether **overage billing** is enabled on that account. With it **off**, hitting a window just blocks further work until it resets (cooldown-and-failover handles it, nothing billed beyond the plan). With it **on**, work past a window is billed against that account's monthly cap — so a dispatch that overruns starts spending real money.

The extension surfaces each account's overage state across `list_workers`, the Worker Accounts tree, and the dashboard usage cards, and guards dispatch with `claudeCodeOrchestrator.overageWorkerDispatch`: the default **`block`** never assigns work to a quota-exhausted worker even if overage is enabled (so dispatches never bill past a plan window); **`allow`** permits it as a last resort, and those dispatches bill real money. (The separate frontier guard for `claude-fable-5`, below, is unchanged.)

## Frontier billing guard

`claude-fable-5` may bill **per use** instead of drawing from a subscription quota, depending on the plan. Because dispatches are autonomous (a policy-driven design consult can fire while you're not watching), the guard is enforced **in the dispatch server, not just in prompts**:

- Default: **block** — frontier dispatches are rejected with an instructive error that steers the orchestrator to `claude-opus-4-8` + `ultrathink` (no retry, no failover).
- `list_workers` and the tool schema surface the guard state before any dispatch is attempted.
- Flip it deliberately: the `claudeCodeOrchestrator.frontierWorkerDispatch` setting, or the dropdown in the dashboard. A surgical pattern that works well: enable, dispatch one adversarial review of a significant build, disable.

## Mesh Mode — attachable dispatch (experimental)

Mesh Mode is not a second way to work. It changes what a **dispatch is**: with it on, every dispatched worker runs as a persistent, attachable `claude --bg` background session — in a git workspace, inside its own git worktree — instead of a one-shot run. You keep using `dispatch_task` / `dispatch_tasks` exactly as before, with the same results, timeouts, cancellation and quota-aware failover. There is no separate mesh workflow to learn.

What it buys you: you can attach a terminal to a running worker and watch it, the orchestrator can message it mid-task to steer it, and workers report progress and questions back while they work.

With Mesh Mode **off**, dispatch behaves exactly as in previous releases — one one-shot worker per task, on the unchanged code path.

### Results come back as a branch to merge

This is the biggest visible change. In a git workspace, each dispatch gets its own worktree at `.claude/worktrees/cco-<taskId>`, checked out on branch `worktree-cco-<taskId>` (Claude Code's own `-w` worktree feature). The worker edits **there**, not in your shared checkout, and the dispatch result names the worktree and the branch. The orchestrator's standing instructions are to verify that worktree (diff, build, test), merge what passes, then remove the worktree and stop the worker — a dispatch is not integrated until its branch is merged.

Two cases have **no** worktree, and their results simply carry no worktree line, because the edits are already in your working tree:

- the workspace is not a git repository, and
- the dispatch fell back to a one-shot worker (see *When the mesh can't start*).

Unmerged work is never cleaned up out from under you: stopping a worker asks Claude Code to remove its worktree, and Claude Code removes it **only when it is clean**. A worktree holding uncommitted changes is kept, and `mesh_status` keeps listing it, marked as kept, so it can be found.

### Talking to a running worker

| Tool | Purpose |
|---|---|
| `mesh_status` | The primary surface: relay health, unread live-feed messages and pending worker questions, how many workers are live against the cap, the idle auto-stop window, and per worker its dispatch task, account, model, alive/dead state, idle age, keep-alive mark, its worktree (marked when kept because it holds uncommitted work), and a copy-pasteable attach command. |
| `mesh_send_worker` | Send a live message to one running worker of this workspace: a correction, a discovered constraint, an answer to its question, or an instruction to abandon a wrong path. |
| `mesh_receive` | Long-poll the live feed of messages from this workspace's workers — progress notes and their `STATUS <id> QUESTION: …` questions, which are highlighted. Result wake-pings are consumed internally and never appear here. |
| `mesh_stop_worker` | Stop one worker (`claude stop` under its own account, then `claude rm` to clear its background job and remove a clean worktree). |
| `mesh_keep_worker` | Mark a worker keep-alive so the idle auto-stop leaves it alone — set before handing out an attach command. Session-end reaping still applies. |

The v1.4 tools are gone. `mesh_spawn_workers` no longer exists (dispatch spawns the workers), and neither does `mesh_send`, which could address arbitrary peer sessions. `mesh_receive` kept its name but not its meaning: it is the live feed of *this workspace's own dispatch workers*, not a general peer inbox. Worker-to-worker messaging is retired — `mesh_send_worker` refuses any name that is not a live worker of this workspace.

Messages are queued and land at the worker's next turn boundary, so steering never interrupts a tool call in progress. A steer may amend the task, and where it conflicts with the original task text the newer instruction wins — but it cannot widen a worker's file-ownership list, and worker-supplied message content is always treated as data rather than as instructions.

### Two channels: files carry results, messages carry steering

A worker's report travels in a **result file** that the dispatch server reads; the live message channel carries only short wake pings, progress notes and steering. The split is deliberate — if the relay dies you lose steering and progress notes, never results. A pending dispatch still settles from its result file, and `mesh_status` says as much ("ping/STATUS channel lost; results still collected via files"). Progress notes are best-effort by design: workers are instructed to send them, but nothing depends on their arrival.

### Teardown — a live worker is a held resource

A worker does **not** vanish when its dispatch returns; that is the point of attachability, and it means someone has to stop it. The orchestrator is instructed to stop each worker once its work is merged, and three backstops sit beneath it:

- **Idle auto-stop** — `claudeCodeOrchestrator.meshWorkerIdleTimeoutMin` (default `15`, `0` disables it). A live worker with no in-flight dispatch, no messages and no keep-alive mark is stopped after that many minutes. Attaching from the **Attachable workers** tree marks the worker keep-alive first, so a session you are sitting in is not reaped (if that mark cannot be written, a warning says so); `mesh_keep_worker` does the same from the orchestrator.
- **Live-worker cap** — `claudeCodeOrchestrator.meshMaxLiveWorkers` (default `8`). Dispatches past the cap are **refused, not queued**: the task fails with a `worker_cap` error naming the limit, so a batch can never deadlock waiting for slots nobody frees. Stop finished workers before a large fan-out, or raise the number.
- **Session end** — when the dispatch server shuts down it stops every worker it owns, keep-alive marks included, and the next activation sweeps for orphans left behind by a session that was killed, stopping any that are still alive.

Stopping a worker also clears its background job, which is what removes a clean worktree — so a dispatch that hits its timeout can take up to about 30 seconds longer to report than the timeout itself (the stop and the job removal are each bounded at 15 seconds).

### Enabling it

Mesh Mode is off by default. All four settings are also in the Orchestrator Dashboard's Settings card, and a change takes effect for the next Claude Code session in that workspace.

| Setting | Default | Effect |
|---|---|---|
| `claudeCodeOrchestrator.meshMode` | `false` | Master switch: starts the relay session and routes every non-detached dispatch through an attachable worker |
| `claudeCodeOrchestrator.meshGatewayModel` | `haiku` | Model for the relay session, which only performs tiny relay turns |
| `claudeCodeOrchestrator.meshWorkerIdleTimeoutMin` | `15` | Minutes an idle attachable worker may sit before being stopped; `0` disables |
| `claudeCodeOrchestrator.meshMaxLiveWorkers` | `8` | Cap on live attachable workers; dispatches past it are refused, not queued |

The `meshCrossAccountBridge` setting is gone. The cross-account mirroring it controlled still happens — it is what lets a worker under one account reach the relay under another — but it is now internal plumbing that starts with the mesh, not a feature to opt into. `mesh_status` reports it as one line.

### When the mesh can't start

If the mesh cannot initialize for any reason — an unsupported platform, another window already owning the mesh for this workspace, the relay failing to come up — the dispatch does **not** fail. It runs as an ordinary one-shot worker, and the result is prefixed with:

```
⚠ mesh unavailable — ran as a one-shot worker (not attachable): <reason>
```

`mesh_status` keeps reporting the initialization error, and there is no worktree for such a dispatch: its edits land directly in the working tree.

### Requirements and honest limits

- **Claude Code CLI 2.1.224 or newer** (cross-session messaging ships default-on from that version); the worktree behavior described here was verified against 2.1.227.
- **macOS or Linux, same machine.** The mesh runs over unix domain sockets, so on Windows it never starts and every dispatch takes the one-shot fallback above.
- **Attachable workers author files; they do not run your build.** They are spawned without the Bash tool (Claude Code may still auto-approve obviously-safe read-only commands, so treat them as file authors rather than as sandboxed), and the workspace's MCP servers are disabled for them, so a worker cannot dispatch further workers. Builds, tests and shell work stay with the orchestrator.
- **`detach: true` still means one-shot.** A detached task is meant to outlive the session and the relay is not, so detached dispatches keep the previous supervisor path even with Mesh Mode on.
- **The relay costs a little.** While Mesh Mode is on, the server keeps one small `claude -p` relay session alive on your main account (`meshGatewayModel`, `haiku` by default). It only relays short messages, but it is not free.
- **No per-task token or cost numbers.** The CLI does not report usage for `--bg` sessions, so attachable dispatches record 0 tokens and 0 cost in this extension's own counters and charts, and the task output says `tokens n/a`. Each account's live plan usage is unaffected — that is read from the account itself.
- **Leftover worktrees are possible.** If a session ends before the removal runs, clean `cco-…` worktrees can accumulate under `.claude/worktrees/`; they are safe to remove with `git worktree remove`. Immediately after a worker finishes, a genuinely clean worktree is occasionally reported as *kept* — nothing is lost, and removing it a few seconds later succeeds.
- **A retry after a failed attempt reuses the same task worktree**, so one branch can carry the edits of both attempts. Verify the whole diff before merging.
- **It rides Claude Code internals that have no public API** (the session registry and the background-job commands). If they move, mesh initialization fails and dispatch falls back to one-shot workers; a change landing mid-dispatch surfaces as a timeout or a dead-worker error, not as a wrong result.

### Known upstream limitations

- **The IDE panel session cannot join the mesh directly** — it registers without a messaging socket, so it can receive nothing and its own sends silently fail to deliver. That is why Mesh Mode hosts its own background relay session as the orchestrator's mesh identity. Tracked upstream: [anthropics/claude-code#82313](https://github.com/anthropics/claude-code/issues/82313).
- **The VS Code extension ignores `CLAUDE_CONFIG_DIR` overrides** and always resolves to `~/.claude` — part of why cross-account reachability works by mirroring registry files rather than by having the extension host see other accounts directly. Tracked upstream: [anthropics/claude-code#30538](https://github.com/anthropics/claude-code/issues/30538).

See [docs/session-messaging-spike.md](docs/session-messaging-spike.md) for the messaging-mechanics probes (P1–P11) this is built on; its tool surface predates this rework.

## Views and dashboard

- **Worker Accounts** — expand a worker for status (available/cooling down), live plan usage (Session 5h, Weekly 7d, and Weekly Fable utilization, each with a reset time, fetched via Claude Code's `get_usage`), this extension's own session (5h) and weekly (7d) dispatch usage, all-time totals, and errors. Plan usage covers the main account too, not just workers, and auto-refreshes on activation and every 5 minutes (or on demand via **Refresh Account Usage**). The dispatch-usage numbers are separate and only reflect tasks sent by this extension, not the account's overall consumption. Accounts logged in via `claude setup-token` or another non-subscription credential have no plan attached and show "no plan limits". **Rename Worker Account** (context menu) relabels the worker only — the config directory and login are untouched — and is refused while any dispatch is running. If the upstream usage source briefly returns nothing, the last reading is kept and marked stale (with its age) for up to 30 minutes rather than disappearing.
- **Dispatched Tasks** — live task feed, scoped to the current workspace by default (toggleable to all workspaces). Click a task to open its prompt/result markdown. A running row gets an inline **Cancel Dispatched Task** button; **Cancel All Running Dispatches** is a view-title button that asks for confirmation first.
- **Orchestrator Dashboard** (editor tab) — stat tiles (running, 7-day tasks, success rate, tokens, cost), a live usage panel (a bar per plan window with %, severity color, reset countdown, and "updated N min ago" freshness), a 14-day task chart, per-worker token distribution, workers/tasks tables, and a settings panel with quick actions. Auto-refreshes every 2 s, theme-aware. Running rows get a Cancel button, and canceling all running dispatches is available as a quick action.
- **Open Interactive Worker Session** — run a worker visibly in an integrated terminal (optionally with an initial task) when you want to watch and steer.

Stopping a dispatch actually stops it: pressing Stop cancels the MCP request and terminates its worker's whole process tree (a `dispatch_tasks` batch is one request, so cancelling it stops every task in the batch). With Mesh Mode on, cancelling stops the worker's background session instead of signaling a process tree; whatever it had already written stays on disk. Ending the orchestrator session — closing the panel, reloading, quitting, or killing the process — terminates every worker it spawned rather than leaving them to run out the `workerTimeoutMinutes` clock. It only ever signals a process ID it has confirmed is still its own worker (never one the OS recycled), a cancellation is never counted as a worker error or a quota cooldown, and any task left marked running with a dead worker is reclaimed as orphaned on the next activation.

## Asset packs and Asset Manager

An **asset pack** is a plain directory that mirrors the `.claude/` layout — `skills/`, `agents/`, `commands/`, `output-styles/`, `hooks/` — with an optional `pack.json`. Two kinds are available: the **bundled pack** shipped inside the extension, and any **user packs** you list in `claudeCodeOrchestrator.assetPacks` (e.g. a private repo clone).

Enable individual assets per workspace; enabling installs them into that workspace's `.claude/` directory, and the choice is tracked in `.claude/cco-assets.json` — the ownership ledger sync uses to know what it wrote.

**Sync** keeps enabled assets installed and up to date, but it never overwrites a file you've edited by hand — that file is reported as "customized" instead. Disabling an asset removes only the files sync itself wrote; your customized copies are left alone. **Reset** is the explicit escape hatch that force-overwrites a file, or a whole asset, back to the pack version.

The **Asset Manager panel** (**Open Asset Manager**) is where you manage all of this: add or remove pack directories, toggle assets per workspace, and see a status badge for each one:

| Badge | Meaning |
|---|---|
| synced | installed and matches the pack |
| update available | the pack has moved ahead of what's installed |
| customized | you edited the installed file — sync won't touch it |
| conflict | two enabled assets claim the same install path |
| not installed | enabled but not yet synced |

From the panel you can also diff or reset any out-of-sync file, clean up orphaned installs, and scaffold a new skill, agent, command, output style, or hook with **New asset…** (writes into a writable pack — the bundled pack is read-only here).

**Hooks are scripts, not markdown.** Installing a `hook` asset writes the script to disk but does not register it — you still need to add it to the `hooks` block in `.claude/settings.json` yourself; the scaffold's comments show the exact entry to add.

**Privacy:** anything in the extension's own bundled `assets/` becomes public the moment the extension is published. Keep personal or team-private assets in a separate pack directory and register it via `assetPacks` instead.

Run **Sync Assets** any time to pull in pack updates. `claudeCodeOrchestrator.assetAutoSync` (default on) does this silently on activation, and only shows a notification when something actually changed.

## Commands

| Command | Description |
|---|---|
| Add Worker Account | Create a worker (config dir + one-time login terminal) |
| Import Existing Claude Config Directories | Scan `~/.claude*` and register in bulk |
| Register Dispatch MCP Server in This Workspace | Write `cco-dispatch` into `.mcp.json` |
| Add Dispatch Policy to CLAUDE.md | Inject/refresh the policy block |
| Open Worker Session in Terminal | Interactive worker session (inline button on the item) |
| Re-login Worker Account | Re-authenticate a worker (context menu) |
| Toggle Preferred Worker | Favor this worker in automatic assignment (context menu) |
| Rename Worker Account | Relabel a worker across the registry, usage stats, and task log; config directory and login untouched (context menu) |
| Refresh Account Usage | Re-fetch live plan usage for all accounts (toolbar button, Worker Accounts view) |
| Open Orchestrator Dashboard | Editor-tab dashboard |
| Toggle Task Scope | Tasks view: current workspace ↔ all |
| Cancel Dispatched Task | Terminate a running dispatch's worker processes (inline button on the row, Dispatched Tasks view and dashboard) |
| Cancel All Running Dispatches | Terminate every running dispatch, after confirmation (view-title button, Dispatched Tasks view; quick action in dashboard) |
| Remove Worker Account / Clear Task History | Cleanup |

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | `acceptEdits` | `--permission-mode` for background workers (`default` stalls on any edit approval) |
| `claudeCodeOrchestrator.claudePath` | `claude` | Path to the Claude Code CLI |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | `30` | Minutes a worker sits out after a quota error |
| `claudeCodeOrchestrator.workerTimeoutMinutes` | `45` | Wall-clock limit per dispatch, in minutes (1–480); overridable per-dispatch via `timeout_minutes` |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | `block` | Billing guard for frontier worker models (see above) |
| `claudeCodeOrchestrator.overageWorkerDispatch` | `block` | Billing guard for overage dispatches: `block` never assigns work to a quota-exhausted worker even with overage enabled; `allow` permits it as a last resort and bills real money |
| `claudeCodeOrchestrator.sessionKeepalive` | `false` | Send one minimal `haiku` request per subscription account per 24h to keep OAuth sessions fresh |
| `claudeCodeOrchestrator.assetPacks` | `[]` | Additional asset pack directories (beyond the bundled pack) to load assets from |
| `claudeCodeOrchestrator.assetAutoSync` | `true` | Silently sync enabled assets on activation and notify only when something changed |

Mesh Mode adds four more settings (`meshMode`, `meshGatewayModel`, `meshWorkerIdleTimeoutMin`, `meshMaxLiveWorkers`) — see [Mesh Mode](#mesh-mode--attachable-dispatch-experimental).

## Data and privacy

Everything stays on your machine. The extension and server share state under `~/.claude-code-orchestrator/`: the worker registry (names, config-dir paths, default models — **no tokens, no credentials**), per-worker usage stats, the task log, and task outputs as markdown. Nothing is sent anywhere except the Claude Code CLI calls you dispatch. Uninstalling the extension leaves that directory; delete it to remove all traces.

## Troubleshooting

- **MCP server shows “failed”** — usually a Node.js path issue in GUI-spawned processes. Re-run *Register Dispatch MCP Server*; the extension resolves the absolute `node` path via your login shell and writes it into `.mcp.json`.
- **A worker stalls and times out** — check `workerPermissionMode`; `default` waits forever for a permission approval no one can click. Tasks time out after `claudeCodeOrchestrator.workerTimeoutMinutes` (default 45, range 1–480); a single dispatch can override it with the `timeout_minutes` tool argument.
- **“Dispatch to claude-fable-5 is blocked”** — the billing guard is on (default). Enable `frontierWorkerDispatch: allow` deliberately if you accept the cost.
- **Quota errors on every dispatch** — check `list_workers` / the Worker Accounts view for cooldowns; with one worker there is no failover.

## Limitations and notes

- Workers edit files in the **same workspace** concurrently. Give overlapping tasks disjoint file-ownership lists in their prompts. (With [Mesh Mode](#mesh-mode--attachable-dispatch-experimental) on in a git workspace, each dispatch is isolated in its own worktree instead, and you merge the branches.)
- Your main account is untouched — the panel keeps using the default `~/.claude` login.
- Using multiple Claude accounts is subject to Anthropic's Terms of Service and usage policies. **You are responsible for making sure your account setup and usage comply.** Dispatched work consumes each worker account's own quota or metered billing.

## License and trademarks

[MIT](LICENSE) © 2026 Toragonite.

Claude, Claude Code, and Anthropic are trademarks of Anthropic, PBC. This project is an independent community extension and is not affiliated with, sponsored, or endorsed by Anthropic.
