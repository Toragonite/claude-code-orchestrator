# Claude Code Orchestrator

**English** | [한국어](README.ko.md) | [简体中文](README.zh-CN.md)

![Claude Code Orchestrator — multi-account parallel dispatch for Claude Code](media/screenshots/banner.png)

> Unofficial extension — not affiliated with or endorsed by Anthropic. Formerly named *Fable Orchestrator*.

Turn your existing **Claude Code** panel into a multi-account orchestrator. You chat with your main session as usual; it designs and verifies, and fans implementation work out **in parallel** to worker Claude accounts (Opus / Sonnet — or Fable, behind a billing guard) through MCP dispatch tools. Per-account usage tracking, quota-aware failover, and a live dashboard included.

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

*The orchestrator session plans, checks in via `orchestrator_briefing`, and fans implementation out to workers:*

![Orchestrator session dispatching from the Claude Code panel](media/screenshots/panel.png)

*Worker accounts with per-window usage, and the live task feed:*

![Worker Accounts and Dispatched Tasks views](media/screenshots/sidebar.png)

*The dashboard: stat tiles, activity charts, per-worker usage, and settings — including the frontier billing guard:*

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
| `list_workers` | Per-worker default model, cumulative usage (tasks, tokens, cost), availability/cooldowns, and the frontier-dispatch guard state. |

Dispatch parameters worth knowing:

- **`system_prompt`** — the orchestrator can send each worker a task-specific system prompt (role, quality bar, output format), layered on top of the built-in worker base prompt. This makes a large difference on complex tasks.
- **`ultrathink: true`** — mechanically escalates that worker run to maximum reasoning depth. Meant for contract-critical implementation, subtle debugging, and adversarial reviews.
- **`model`** — `claude-opus-4-8` for hard reasoning/coding, `claude-sonnet-5` for simpler or high-volume work, `claude-fable-5` only for the highest-leverage dispatches (design consults, adversarial reviews) and only if you have enabled frontier dispatch (see *Billing guard*).
- **`worker`** — optional explicit account; omit for automatic quota-aware assignment.

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

## Frontier billing guard

`claude-fable-5` may bill **per use** instead of drawing from a subscription quota, depending on the plan. Because dispatches are autonomous (a policy-driven design consult can fire while you're not watching), the guard is enforced **in the dispatch server, not just in prompts**:

- Default: **block** — frontier dispatches are rejected with an instructive error that steers the orchestrator to `claude-opus-4-8` + `ultrathink` (no retry, no failover).
- `list_workers` and the tool schema surface the guard state before any dispatch is attempted.
- Flip it deliberately: the `claudeCodeOrchestrator.frontierWorkerDispatch` setting, or the dropdown in the dashboard. A surgical pattern that works well: enable, dispatch one adversarial review of a significant build, disable.

## Views and dashboard

- **Worker Accounts** — expand a worker for status (available/cooling down), session (5h) and weekly (7d) dispatch usage, all-time totals, and errors. The *Plan quota* row opens that account's terminal where `/usage` shows the plan's real quota. Numbers in the tree reflect dispatches sent by this extension; they are not the account's total consumption.
- **Dispatched Tasks** — live task feed, scoped to the current workspace by default (toggleable to all workspaces). Click a task to open its prompt/result markdown.
- **Orchestrator Dashboard** (editor tab) — stat tiles (running, 7-day tasks, success rate, tokens, cost), a 14-day task chart, per-worker token distribution, workers/tasks tables, and a settings panel with quick actions. Auto-refreshes every 2 s, theme-aware.
- **Open Interactive Worker Session** — run a worker visibly in an integrated terminal (optionally with an initial task) when you want to watch and steer.

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
| Open Orchestrator Dashboard | Editor-tab dashboard |
| Toggle Task Scope | Tasks view: current workspace ↔ all |
| Remove Worker Account / Clear Task History | Cleanup |

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | `acceptEdits` | `--permission-mode` for background workers (`default` stalls on any edit approval) |
| `claudeCodeOrchestrator.claudePath` | `claude` | Path to the Claude Code CLI |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | `30` | Minutes a worker sits out after a quota error |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | `block` | Billing guard for frontier worker models (see above) |

## Data and privacy

Everything stays on your machine. The extension and server share state under `~/.claude-code-orchestrator/`: the worker registry (names, config-dir paths, default models — **no tokens, no credentials**), per-worker usage stats, the task log, and task outputs as markdown. Nothing is sent anywhere except the Claude Code CLI calls you dispatch. Uninstalling the extension leaves that directory; delete it to remove all traces.

## Troubleshooting

- **MCP server shows “failed”** — usually a Node.js path issue in GUI-spawned processes. Re-run *Register Dispatch MCP Server*; the extension resolves the absolute `node` path via your login shell and writes it into `.mcp.json`.
- **A worker stalls and times out** — check `workerPermissionMode`; `default` waits forever for a permission approval no one can click. Tasks time out after 30 minutes.
- **“Dispatch to claude-fable-5 is blocked”** — the billing guard is on (default). Enable `frontierWorkerDispatch: allow` deliberately if you accept the cost.
- **Quota errors on every dispatch** — check `list_workers` / the Worker Accounts view for cooldowns; with one worker there is no failover.

## Limitations and notes

- Workers edit files in the **same workspace** concurrently. Give overlapping tasks disjoint file-ownership lists in their prompts (per-task worktree isolation is on the roadmap).
- Your main account is untouched — the panel keeps using the default `~/.claude` login.
- Using multiple Claude accounts is subject to Anthropic's Terms of Service and usage policies. **You are responsible for making sure your account setup and usage comply.** Dispatched work consumes each worker account's own quota or metered billing.

## License and trademarks

[MIT](LICENSE) © 2026 Toragonite.

Claude, Claude Code, and Anthropic are trademarks of Anthropic, PBC. This project is an independent community extension and is not affiliated with, sponsored, or endorsed by Anthropic.
