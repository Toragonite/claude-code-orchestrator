# Claude Code Orchestrator

**English** | [한국어](README.ko.md) | [简体中文](README.zh-CN.md)

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/toragonite.claude-code-orchestrator.svg?label=VS%20Marketplace&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs-short/toragonite.claude-code-orchestrator.svg?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Open VSX](https://img.shields.io/open-vsx/v/toragonite/claude-code-orchestrator?label=Open%20VSX&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/toragonite/claude-code-orchestrator?label=downloads&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![GitHub release](https://img.shields.io/github/v/release/Toragonite/claude-code-orchestrator?label=release&logo=github)](https://github.com/Toragonite/claude-code-orchestrator/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/Toragonite/claude-code-orchestrator)](https://github.com/Toragonite/claude-code-orchestrator)
[![License: MIT](https://img.shields.io/github/license/Toragonite/claude-code-orchestrator?color=brightgreen)](LICENSE)

![Claude Code Orchestrator — one Claude Code session dispatching work to worker accounts in parallel](media/screenshots/banner.png)

> Unofficial extension — not affiliated with or endorsed by Anthropic. Formerly named *Fable Orchestrator*.

Claude Code Orchestrator lets one **Claude Code** session — the *orchestrator* — hand coding tasks to worker sessions that run under your **other accounts**, in parallel, through a dispatch command that it runs in its own Bash tool (or, if you prefer, through MCP dispatch tools). The main session designs, integrates and verifies while the workers implement, each on its own plan quota, with quota-aware failover, live per-account usage, a Team view of live sessions and a dashboard.

> **2.0 — realigned with Claude Code 2.1.283 and newer.**
> Session workers are now peer sessions that your own session messages with `SendMessage`. Worker accounts can also run on Codex, Cursor and Antigravity. There is a Team view and a redesigned dashboard. The relay "gateway", three MCP tools and two settings are gone, because Claude Code now does that job itself. Settings are now read from your User settings only. Dispatch no longer needs MCP: the main session runs the `~/.claude-code-orchestrator/bin/cco` command through its Bash tool. MCP stays available as an option.
> → [Upgrading from 1.x](#upgrading-from-1x) · [What is experimental or not verified](#what-is-experimental-or-not-verified) · [Changelog](CHANGELOG.md)

```
Claude Code panel (main account — the orchestrator)            ← use it as usual
   │  Bash tool → ~/.claude-code-orchestrator/bin/cco dispatch_tasks · dispatch_task · dispatch_status · list_workers · cancel · …
   ▼
dispatch host (one background process per Claude Code session, on your machine; the cco-dispatch MCP server, if registered, runs the same code)
   │  starts each worker's own CLI under that worker's login, in this workspace
   ├──────────────┬──────────────┬──────────────────────┐
   ▼              ▼              ▼                      ▼
worker w1       worker w2      worker w3              worker codex1
Claude Code     Claude Code    Claude Code            Codex — only when a dispatch
(opus)          (sonnet)       (opus)                 asks for it (provider / worker)
```

The core idea: **an account is a login that the vendor's own CLI already holds.** A Claude Code worker is a separate config directory (`~/.claude-<name>`) that you sign in to once; a worker on another vendor's CLI uses the login of that CLI. The extension starts those CLIs; it does not handle their credentials (see [Trust and privacy](#trust-and-privacy)).

## Who it is for

- You have more than one coding-agent subscription — several Claude plans, or a Claude plan plus Codex, Cursor or Antigravity — and want to spend their quota in parallel from one conversation.
- You want the main session to stay a designer and a verifier: it freezes a contract, fans the implementation out, then builds, tests and merges.
- You want one place that shows which account is near a limit, logged out or cooling down, and what every worker is doing right now.

It is not a hosted service. Everything runs on your machine, under logins you made yourself.

## Screenshots

*Session start: the orchestrator checks in with `orchestrator_briefing`, then reads every account's live plan usage from `list_workers` and routes around the accounts that are near a limit:*

![Orchestrator session start: the briefing and live plan usage from list_workers](media/screenshots/panel-1.png)

*The fan-out: once the interface contract is frozen, one `dispatch_tasks` call sends the independent subtasks to the worker accounts in parallel:*

![One dispatch_tasks call fanning subtasks out to worker accounts](media/screenshots/panel-2.png)

*The sidebar: Worker Accounts (each with the CLI it runs on, its login state and its live plan usage), Team, Dispatched Tasks and Worker History:*

![The sidebar views: Worker Accounts, Team, Dispatched Tasks and Worker History](media/screenshots/sidebar.png)

*The Team view: live sessions across accounts, grouped as Working, Waiting and Parked, with attach, logs, diff and stop on each row:*

![The Team view listing live sessions across accounts](media/screenshots/team.png)

*The dashboard: account cards with usage gauges and reset countdowns, the three-lane Team board, and the Activity list:*

![The Orchestrator Dashboard in a dark theme](media/screenshots/dashboard.png)

*The same dashboard in a light theme — it follows the editor's theme, including high contrast:*

![The Orchestrator Dashboard in a light theme](media/screenshots/dashboard-light.png)

*Adding a worker starts with the CLI the account runs on:*

![The provider pick shown when adding a worker account](media/screenshots/add-worker.png)

## Requirements

- **VS Code 1.90 or newer**, or a compatible editor that installs from Open VSX.
- **Claude Code CLI**, installed and logged in as your main account. Release 2.0 was verified against Claude Code 2.1.283.
- **Node.js** on your login shell's `PATH` — the dispatch server runs with it.
- **At least one worker account:**
  - another Claude account, on a plan that can run the models you assign; and/or
  - for another provider, that vendor's CLI installed and signed in: `codex` (Codex), `cursor-agent` (Cursor) or `agy` (Antigravity). A dispatch to each of the three was verified live on 2026-10-14 with codex-cli 0.162.1, cursor-agent 2026.10.12 and agy 1.3.4.
- **For session workers (Mesh Mode, experimental):** Claude Code **2.1.283 or newer** on **macOS or Linux**. On an older CLI, or on another platform, session workers do not start and every dispatch runs as a one-shot worker instead.
- **For dispatch without MCP (the default):** macOS or Linux, and the main session's Bash tool. `~/.claude-code-orchestrator/bin/cco` does not run on Windows in 2.0 — use the MCP server there.

## Installation

- **Marketplace**: search for “Claude Code Orchestrator”.
- **From source**: `npm install && npm run compile`, then F5 (Extension Development Host) or `npm run package` and install the generated `.vsix`.

## Quick start

1. Open the **Claude Code Orchestrator** view in the activity bar and run **Add Worker Account**. Pick the CLI the account runs on, a name (for example `w1`) and a default model, then sign in **once** in the terminal the extension offers to open (Antigravity signs in through its own app instead). Already have `~/.claude-*` directories? Use **Import Existing Claude Config Directories** instead.
2. Run **Update Workspace Setup** (Command Palette; the dashboard's setup button, the onboarding step and the "policy outdated" chip open it too). This is all the setup that dispatching needs; no MCP server is involved. It looks at the workspace and offers one checklist, each item with its state. It applies only what you check, and reports for each item what it did or why it refused:
   - **Dispatch policy** — add or update the dispatch policy block in `CLAUDE.md`.
   - **Team proxy agent** — add or update `.claude/agents/cco-worker.md`; a file there that is not ours is never overwritten.
   - **Permissions** — let `~/.claude-code-orchestrator/bin/cco` run without permission prompts, by adding rules to `.claude/settings.local.json`.
   - **MCP server** — remove the `cco-dispatch` entry from `.mcp.json`. Unchecked by default, and offered only once the policy is current.

   The rules are `Bash(~/.claude-code-orchestrator/bin/cco *)`, the same with the absolute home path (Claude Code matches the two spellings separately), `Edit(/.cco/**)` so that the session can write task files without a prompt, and both spellings of the command in `sandbox.excludedCommands`. They go into `.claude/settings.local.json` at the git repository's root, where Claude Code reads it, or in the folder itself outside git. A settings file that cannot be parsed is never rewritten. If the file is tracked in git, the setup tells you that the rules apply once the folder is trusted and reach everyone who clones it. After removing the MCP server, restart the Claude Code session. When you add the dispatch policy by itself on macOS or Linux (**Add Dispatch Policy to CLAUDE.md**, the dashboard or onboarding button, or an offer) and the folder's permission rules are missing, the extension asks once: “Let the Claude session run cco without permission prompts in this folder?” **Allow cco** applies the same rules as above; **Not now** does nothing, and it asks again the next time the policy is added. On Windows, **Update Workspace Setup** offers only the dispatch policy (the team proxy agent cannot dispatch there), and the policy tells a Windows session to use the MCP tools of the same names.
3. Chat as usual. Give the main session a large task and it fans out: independent subtasks go to workers in parallel while it designs, integrates and verifies.
4. Optional: turn on [session workers](#session-workers-mesh-mode-experimental), and keep the [team proxy agent](#team-proxy-agent) if you use native agent teams.
5. Optional, and the way to dispatch on Windows: run **Register Dispatch MCP Server in This Workspace**. It writes a `cco-dispatch` entry into the workspace `.mcp.json`; a `.mcp.json` it cannot safely rewrite — invalid JSON, not an object, a symbolic link — is left exactly as it is, and the message says why. The same holds for a `.mcp.json` or `CLAUDE.md` that is not valid UTF-8 text (saved as Latin-1, EUC-KR or UTF-16, say) or that you cannot write: it is not rewritten, because a rewrite would alter or lose characters, and the command says so. The server lives at a stable path under `~/.claude-code-orchestrator/mcp/`, so an extension update never breaks the registration. Accept the offer to add the **dispatch policy** to the workspace `CLAUDE.md` (or run **Add Dispatch Policy to CLAUDE.md** later), then restart the Claude Code session and approve the project MCP server.

## Two ways a task runs

Every dispatch goes through the same operations (`dispatch_task` / `dispatch_tasks`) — as `cco` commands or as MCP tools — and has the same timeout, cancellation and quota-aware failover. What differs is the kind of worker behind it.

| | One-shot worker (default) | Session worker (Mesh Mode on — experimental) |
|---|---|---|
| What runs | A headless `claude -p` run that ends with the task | A persistent `claude --bg` background session that stays attachable after the task |
| Where its edits land | Directly in your working tree | In a git workspace: its own worktree `.claude/worktrees/cco-<taskId>` on branch `worktree-cco-<taskId>`. In a non-git workspace: directly in the working tree |
| What you get back | The worker's report | The report and, in a git workspace, a **branch to verify and merge** with the work auto-committed |
| Talking to it mid-task | Not possible | Your session's own `SendMessage`, addressed to the name on the result's `peer:` line |
| Watching it | The Dispatched Tasks view | Attach a terminal, read its logs or open its branch diff from the Team view |
| What it may run | A full Claude Code session; `workerPermissionMode` governs what it may do unattended | It writes files. It is started with a fixed list of pre-approved tools (`ListAgents`, `SendMessage`, `Read`, `Write`, `Edit`, `Glob`, `Grep`) in a permission mode that is never bypass, and it is told not to run shell commands; a shell call would stop at a prompt nobody answers. That is a policy, not a sandbox. Builds and tests stay with the orchestrator |
| Token and cost numbers | Recorded per task | Not reported (shown as `n/a`) |
| Outliving your session | Only with `detach: true` | No — when the session that owns it ends, its dispatch server asks every session worker it started to stop (best effort) |

Three cases always run one-shot, whatever the setting says: a task dispatched with `detach: true`, a task sent to a worker on [another provider](#other-providers), and any task when session workers cannot start.

### Session workers (Mesh Mode, experimental)

Turn on `claudeCodeOrchestrator.meshMode` (Settings, or the dashboard's settings drawer). The dispatch server reads the switch at each dispatch, so a change applies from the next dispatch of a server that is already running; turning it off does not stop session workers that are already running. What was checked against the real CLI, and what only against a fake one, is listed under [What is experimental or not verified](#what-is-experimental-or-not-verified).

- **The worktree starts from your current HEAD commit.** A worker sees every commit on the branch you are on and nothing uncommitted. Commit what a worker needs before you dispatch, or put that content in the task prompt.
- **The result is a branch to merge.** When a dispatch settles with a result from the worker — done, or an error it reported — the extension stages everything in the worker's worktree (`git add -A`) and commits it to `worktree-cco-<taskId>` with `--no-verify --no-gpg-sign`, so repository hooks and commit signing are skipped, and the result names the branch and a short commit id. Verify the branch, merge what passes, then stop the worker. A dispatch that timed out, died, was cancelled or ended with the worker parked is **not** committed: what the worker wrote is still uncommitted in its worktree, and teardown never removes a worktree that still holds work.
- **You talk to a worker with Claude Code's own tools.** The worker's name is on the `peer:` line of the dispatch result and in `mesh_status`. Your session messages it with `SendMessage`; a message lands at the worker's next tool round and the reply arrives as an ordinary cross-session message. Workers do not send progress on their own — ask for a status if you want one. After its result is in, a worker answers questions but will not touch a file again unless a message says `RESUME`; work done after that is not auto-committed. Messaging a worker that runs under a different account than yours depends on a copy of its session entry in your account, and that path has not been verified live.
- **A worker that ends its turn without reporting is a failed dispatch.** If a worker stops to ask or to wait instead of writing its result, the dispatch is recorded as failed, with an attach command so you can see what it was waiting for. The worker is left running. The one exception: when its account's plan usage shows an exhausted window, the worker is stopped and the task fails over to another account.
- **The cap counts only dispatches still in flight.** `claudeCodeOrchestrator.meshMaxLiveWorkers` (default `8`) refuses a dispatch past the cap with a `worker_cap` error instead of queuing it. Parked workers — finished, still attachable — do not count.
- **Session workers never run in bypass-permissions mode.** If `workerPermissionMode` is `bypassPermissions`, a session worker starts in `acceptEdits` instead, because Claude Code holds messages between a bypass session and a prompting one.
- **A worker stays until something stops it.** That is you (the Team view, the dashboard, or `mesh_stop_worker`), the end of the session that owns it, or Claude Code retiring a session that has sat idle. There is no idle auto-stop in the extension. When the owning session ends, its dispatch server asks every session worker it started to stop — parked ones too, and even when the registry cannot be read or the worker's account was removed in the meantime. The request is sent as the server exits, so it is best effort: a worker whose stop did not land keeps running until it is stopped by hand. Stopping removes the worktree only when it is clean.
- **Workers whose owner is gone are stopped.** When the extension activates, it stops the session workers whose dispatch server has ended — in every workspace that has a session-worker record — and a dispatch server does the same for its own workspace when it starts Mesh Mode. Each is asked to stop with `claude stop`; only if that fails is it ended by force, and only after the process is confirmed to be the worker. A worktree that still holds work is kept. A worker whose state cannot be established is left running, and `mesh_status` lists it. Right after the start-up sweep a dispatch server settles the tasks of the workers it dealt with, so a crash no longer leaves them `running` for up to 10 minutes. A worker `mesh_status` cannot look at — for example one whose account is no longer a configured Claude Code account, because no command is ever aimed at such a directory — reads `unknown`, not `dead`, with the `claude stop <job id>` command to run by hand under that account, because it may still be running. Its record leaves the ledger 24 hours after its time ran out, never while a worktree of it is on disk or its owner is alive, and only after a successful registry read.

When session workers cannot be used, the dispatch does not fail — it runs one-shot and, in the two cases below, says so on the first line of its result:

```
⚠ mesh unavailable — ran as a one-shot worker (not attachable): <reason>
⚠ ran as a one-shot worker (not attachable): <account> has not trusted this workspace for background sessions — <what to run>
```

The first line appears when the CLI is older than 2.1.283, the platform is unsupported, or another window already owns the session workers of this workspace. The second appears for one task when that account has not accepted Claude Code's workspace-trust prompt. For a worker account with its own config directory the extension records that trust itself before the first session worker starts; it never writes your home-level `~/.claude.json`, so a worker that runs as your default login needs you to have trusted the workspace in the CLI once. A task dispatched with `detach: true`, or to a worker on another provider, also runs one-shot, and its result carries no line of this kind.

## Other providers

A worker account can run on **Codex** (`codex`), **Cursor** (`cursor-agent`) or **Antigravity** (`agy`) instead of Claude Code. The orchestrator is still your Claude Code session; the dispatch server starts the other vendor's CLI through the `@toragonite/agent-mesh` adapters that ship inside the extension.

**The opt-in rule.** A dispatch that names neither `worker` nor `provider` only ever runs on a Claude Code worker. A task reaches another vendor only when the dispatch asks for it:

- `provider: "codex"`, `"cursor"` or `"gemini"` (Antigravity) lets any account of that vendor take the task;
- `worker: "<name>"` names one account.

Cooldown, login-expiry handling and failover work among one vendor's accounts. A task never moves from one vendor to another.

**The limits, stated plainly.**

- They always run **one-shot**, with Mesh Mode on as well. They cannot be attached to, messaged or steered. `detach: true` works for them as for any one-shot worker.
- They **edit the working tree in place** — no worktree, no branch, nothing to merge. Give tasks that run at the same time disjoint file-ownership lists.
- `model` takes **that vendor's own model ids**. The id is checked for shape only; an id the vendor does not have fails that dispatch as an ordinary error, and the wording depends on the adapter. Omit `model` to use the worker's default, or the CLI's own default when it has none. **Set Default Model** on such an account asks the CLI for its current model list where the CLI can give one (Cursor and Antigravity; Codex uses a built-in list) and shows that vendor's own models first. Models of other vendors that the CLI resells come after a separator, each marked as billed through this provider's account, not through that vendor's own. If the CLI cannot list, built-in suggestions are shown with a note; when you add such an account the CLI has not started yet, so the suggestions are the built-in ones. **Let the CLI choose** and **Enter another model id…** are always there.
- The frontier and overage billing guards cover Claude Code workers only. A model that one vendor resells from another spends that other vendor's quota.
- **Codex needs a git repository.** Outside one, the Codex CLI refuses to run and the dispatch fails with its message.
- **Plan usage is shown for Codex and Cursor accounts.** Codex shows its 5-hour and weekly windows ("Primary limit" / "Secondary limit"); Cursor shows the billing period's "Total usage", "Auto + Composer" and "API usage", each with the period's end. Each is a request from this machine to that vendor's usage service, made with the sign-in the vendor's own CLI keeps: for Codex the token in the account's `auth.json`; for Cursor, on macOS, the `cursor-agent` CLI's keychain item `cursor-access-token`, read through `/usr/bin/security` only to ask Cursor for that account's own usage (elsewhere the CLI's sign-in file). If macOS asks for access and you deny it, it is not asked again for 6 hours. The dispatch server makes the request in its own process when `list_workers` runs, and the extension through a helper process. **Antigravity accounts show no usage reading**: its CLI keeps its sign-in in the keychain, and reading it is not implemented. "No usage reading" does not mean "no usage". Turn `claudeCodeOrchestrator.providerUsagePolling` off to stop these requests altogether.
- **Anthropic credentials are never passed to another vendor's CLI.** Every environment variable whose name starts with `ANTHROPIC_` or `CLAUDE_`, and `CLAUDECODE`, is removed from the environment of every such process — among them `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` — and from the login terminals the extension opens for them.

| Provider | CLI | `provider` value | Accounts | Permission / sandbox modes |
|---|---|---|---|---|
| Codex | `codex` | `codex` | The login already on the machine, or a separate one in its own home directory (`CODEX_HOME`). Plan usage is shown | `workspace-write` (default), `read-only`, `danger-full-access` |
| Cursor | `cursor-agent` | `cursor` | One login per machine, so one worker. A dispatch was verified live on 2026-10-14. Plan usage is shown (needs the CLI's own sign-in on this machine) | `enabled`, `disabled`; the CLI's default when none is set |
| Antigravity | `agy` | `gemini` | The login already on the machine. A separate home directory (`AGY_HOME`) is accepted but **not verified** to give a second login. No plan-usage reading | `accept-edits` (default), `plan` |

The permission mode of such a worker is set per account (**Set Permission Mode**) and passed to the CLI as that CLI's own sandbox or mode option. Beyond the mode you chose, the extension adds no permission or sandbox flag of its own, except that the bundled Cursor adapter passes `--trust` on every Cursor run, so that `cursor-agent` does not stop at its workspace-trust prompt. Choosing a mode that turns a vendor's sandbox off asks for confirmation first.

## Views and the dashboard

- **Worker Accounts** — accounts only. Each row shows the CLI the account runs on, its default model, and whether it is preferred, cooling down or logged out. Expand a Claude Code account for its live plan usage (each window with a reset time) and for this extension's own dispatch counters; expand an account on another CLI for its login state, its permission mode and a usage reading when there is one. Each account has a **Default model** row. Plan usage covers your main account too, and refreshes on activation, every 5 minutes, and on **Refresh Account Usage**. If a reading briefly comes back empty, the last one is kept and marked stale for up to 30 minutes. An entry of `registry.json` that this version cannot use is listed as unsupported, with the reason and **Remove Registry Entry…** on its row; a registry file that cannot be read is reported in this view and on the dashboard, with an **Open File** action. An account is shown as logged out only once its login is confirmed out (two checks a few seconds apart, or a dispatch that failed on login); a check that could not run says so and is retried, and **Check Login Now** (right-click a Claude Code account, or its dashboard card) checks it at once — as `cco list_workers --check` does for every account.
- **Team** — every live Claude Code session working in this workspace, across accounts: the session workers you dispatched, the members of a native Claude Code agent team, and other sessions of your accounts. Rows are grouped as **Working**, **Waiting** and **Parked**. A dispatched worker offers **attach** (a terminal on the session), **logs**, **diff** (its result branch against your HEAD), **copy name** (the address `SendMessage` takes) and **stop**. Teammates and other sessions are listed so that you can see them; an action is offered only where the session can be addressed. A stopped worker stays listed while its worktree still exists, so unmerged work is not forgotten.
- **Dispatched Tasks** — the task feed, scoped to the current workspace by default. Click a task to open its output. The view lists the newest 300 tasks and ends with a row that opens the dashboard for older ones. A running row has **Cancel Dispatched Task**. **Cancel All Running Dispatches** asks first, and it cancels every running dispatch on this machine, in every workspace, not only the ones listed here. A task log that cannot be read is shown as such, never as an empty list. A task whose log entry is dated more than 5 minutes in the future has no usable time: it is listed after the dated tasks, is in no 5-hour, 7-day or daily figure, and its hover says it started at an unknown time.
- **Worker History** — finished session-worker dispatches, newest first, capped by `claudeCodeOrchestrator.meshHistoryLimit`, each flagged while its branch is not merged yet.
- **Orchestrator Dashboard** (an editor tab) — a page to read in a few seconds and act from:
  - a header with the workspace, the orchestrator's model, a switch between this workspace and all workspaces, and health chips that appear only when something needs attention (an expired login, an account at a plan limit or cooling down, a CLI too old for session workers, an unreadable task log, a missing setup step);
  - **account cards** with usage gauges and reset countdowns, cooldown and extra-usage marks, dispatch counts for the last 5 hours, 7 days and all time, and **Re-login** in front when a login has expired;
  - a three-lane **Team board** — Working · Waiting on you · Parked — with attach, logs, diff and stop on each card;
  - an **Activity** list with five outcomes — running, done, failed, cancelled, orphaned — filters by status, CLI and text, and a 14-day strip with the success rate;
  - a **settings drawer** (Dispatch · Billing guards · Session workers · Other providers · Setup · Danger zone) whose controls show saved or failed from the editor's own answer.

  The page is served under a strict Content Security Policy: no inline styles or handlers, no remote content, and no HTML is ever built from data. The Asset Manager page is served under the same kind of policy. Resetting the main-session check-in and stopping a session are single clicks on the page that the editor then confirms in a dialog, and a setting that needs a confirmation shows "waiting for your answer" instead of timing out. The page was checked in headless Chrome against recorded data; how it behaves inside a real editor window is described under [What is experimental or not verified](#what-is-experimental-or-not-verified).

Stopping a dispatch depends on how it was started. With the `cco` command, ending or interrupting the command (Esc, a timeout) only ends the waiting: the work goes on, and `dispatch_status` reads it. To stop work, run `~/.claude-code-orchestrator/bin/cco cancel <id>` or use **Cancel Dispatched Task** in the Dispatched Tasks view. With the MCP tools, cancelling ends the MCP request and terminates the worker's whole process tree (a `dispatch_tasks` batch is one request, so cancelling it stops every task in it). For a session worker, cancelling stops its background session; what it had already written stays on disk. Ending the orchestrator session ends the one-shot workers it started, unless a task was dispatched with `detach: true`, and asks its session workers to stop; one that survives is reported by `mesh_status`. The dispatch host ends together with its session.

## Team proxy agent

Claude Code's native agent teams always run a teammate on the lead's own account. **Install Team Proxy Agent in This Workspace** writes a small subagent definition, `cco-worker`, to `.claude/agents/cco-worker.md`, which lets a team include a worker that runs on **another account**.

- The proxy does not do the task. It makes one `dispatch_task` call with the task text **verbatim** and replies with a pointer: done or failed, the worker and model, the task id and the file that holds the full report, and the `peer:`, `worktree:` and `conversation:` lines when the result has them.
- The proxy dispatches with the `~/.claude-code-orchestrator/bin/cco` command, using only its Bash and Write tools: it writes the task into `.cco/`, runs the command in the foreground and waits up to 9 minutes per call, then keeps waiting with `~/.claude-code-orchestrator/bin/cco dispatch_status --wait 540 <task id>` for as long as the exit code is 23. No MCP server is needed.
- The lead may put optional header lines before the task text: `MODEL:`, `WORKER:`, `PROVIDER:`, `TITLE:`, `TIMEOUT_MINUTES:` and `ULTRATHINK: true`.
- The lead steers a session worker directly, by the name on the `peer:` line — never through the proxy.
- The command never overwrites a different agent that already lives at that path; if the file there is an earlier or an edited copy of this definition, it asks before replacing it. **Update Workspace Setup** installs and updates the same file. Because the proxy uses `cco`, it cannot dispatch on Windows.

Native agent teams are an experimental Claude Code feature. The proxy has not been exercised inside a real team in this release — see [what is not verified](#what-is-experimental-or-not-verified).

## Teammate mode (experimental)

Teammate mode runs a **live team** of coding agents across vendors and accounts — Claude Code, Codex, Cursor and Antigravity — led by your own Claude Code session. It is **off by default** and experimental; read [its limitations](#what-is-experimental-or-not-verified) before you use it.

- **Each member has its own worktree and branch.** A member works in a git worktree under `~/.claude-code-orchestrator/worktrees/`, outside your repository, on its own branch `cco/<team>/<member>`. The branch starts at your current HEAD, or at the `base` the team file names.
- **Each turn is a headless run of the vendor's CLI**, resumed in the member's own conversation. After every turn the extension makes a checkpoint commit on the member's branch.
- **Members talk through team tools**: `team_send`, `team_inbox`, `team_board` and task updates. A member whose vendor cannot use the tools runs **turns-only**: a message reaches it at its next turn, and its final answer is its report.
- **Nothing is merged for you.** You review each member's branch and merge it yourself.

### Turning it on

Run **Turn On Teammate Mode (Experimental)** from the Command Palette or from the Team view. It shows a warning and, once you confirm, sets `claudeCodeOrchestrator.teamMode` in your User settings; **Turn Off Teammate Mode** sets it back. You can also set it in the settings page. Turning it off while a team runs does not stop that team: only creating a team and adding a member are refused. The other team settings (member limit, turn limits, the Cursor and Antigravity permission switches) are in the [Settings](#settings) table.

### Starting a team

Your Claude Code session leads the team with `cco team_*` commands, run in its Bash tool. A team is described in a JSON file that the session writes into `.cco/`, the same way as a task file. A long text goes in its own file, named by `goal_file`, `brief_file`, `body_file` or `text_file` relative to the JSON file. A minimal team file:

```json
{
  "name": "login-fix",
  "goal": "Make the login form validate its fields and add tests for it.",
  "members": [
    { "name": "builder", "role": "Implements the change", "brief": "Fix the form in src/login; do not touch src/api.", "paths": ["src/login/"] },
    { "name": "tester", "role": "Writes the tests", "brief": "Cover the validation rules with tests.", "provider": "codex" }
  ],
  "tasks": [
    { "title": "Validate the email field", "assignee": "builder" }
  ]
}
```

```
~/.claude-code-orchestrator/bin/cco team_create .cco/team.json
~/.claude-code-orchestrator/bin/cco team_wait        # run in the background
```

If your members depend on each other's files, or need installed dependencies, read the limits on separate branches and fresh checkouts under [What is experimental or not verified](#what-is-experimental-or-not-verified) before you write the briefs.

The keys are checked before anything is sent; an unknown key is refused with exit code 21 and the closest allowed one. A team file has `name`, `title`, `goal` (or `goal_file`), `base`, `members`, `tasks` and `worktree`. A member has `name`, `role`, `brief` (or `brief_file`), `provider`, `worker`, `model`, `paths` and `start`. `"start": false` makes a member's first turn wait for its first message; a board task assigned to it in the team file counts as that message, so such a member starts at once. A board task has `title`, `body` (or `body_file`), `assignee`, `paths` and `allow_overlap`. A team name is lowercase letters, digits and hyphens (at most 32 characters, starting with a letter); a member name is the same with at most 24. `team_create` answers at once and the worktrees are created in the background. The team file may be up to 16 MiB; a goal, body or message text file up to 64 KiB and a brief file up to 256 KiB.

### The lead's commands

All of these are `~/.claude-code-orchestrator/bin/cco <command>`; `cco help` prints the exact flags.

| Command | What it does |
|---|---|
| `team_create <team file>` | Creates the team from a team file (goal, members, board tasks). |
| `team_add <members file>` | Adds members and board tasks, from a file `{"members": [...], "tasks": [...]}`. |
| `team_send <message file>` | Sends one message (`to`, `text` or `text_file`, `kind`, `urgent`, `reply_to`, `task`) to a teammate, or to all. |
| `team_inbox [--all]` | Prints your unread team messages, oldest first, and marks the ones shown as read. `--all` prints the last 50 and marks nothing. |
| `team_wait [--wait <s>] [--settle <s>]` | Run it with the Bash tool's background option while the team works. It exits as soon as a teammate needs you, printing the messages. `--settle <s>` (0 to 300, default 20) batches what follows the first message. |
| `team_status [--all \| --member <name> \| --task <id> \| --message <id>]` | Prints the team's members, board and warnings; one member, task or message in full; or, with `--all`, every team of this repository. |
| `team_task <task-op file>` | Changes the board from a file `{"op": "add" \| "assign" \| "unassign" \| "update" \| "cancel" \| "reopen", …}`. |
| `team_member <name> (--stop \| --restart \| --pause \| --unpause \| --interrupt \| --switch) [--now] [--provider <p>] [--worker <w>] [--model <m>]` | Controls one teammate. Exactly one operation; `--now` only with `--stop` or `--pause`; `--provider`, `--worker` and `--model` only with `--switch`. |
| `team_attach <name>` | Prints the command line that takes over a Claude teammate's conversation in a terminal, for you to run; it changes nothing. |
| `team_end [--now]` | Ends the team: running turns finish (`--now` stops them), worktrees are committed, and every branch is listed with the commands that review and merge it. |
| `team_resume [--team <id or name>]` | Resumes a suspended team of this repository after its lead's session ended. |

The exit codes are those of [the `cco` command](#exit-codes): `0` the answer was printed (read it), `20` the host answered with an error and nothing was started, `21` the command line or a file is wrong, `22` `cco` cannot run here, `23` `team_wait --wait` ran out (the team goes on), `24` the waiting was interrupted. When your team has unread messages, the last line of every `cco` answer says so. A `cco` command run inside a teammate's shell is refused.

### The Teams view

The Team view lists the roster, the board, the activity and the messages of the team, next to the live sessions it listed before. Right-click a member, a task or the team to: send a message (to one member or to all), interrupt, pause, unpause, stop or restart a member, show its activity or its changes, copy its branch name or its merge command, open its worktree in a new window, take it over in a terminal, release it, add, assign, finish, rework, cancel or reopen a board task, and end the team. The commands are in the [Commands](#commands) table under their `Team` names.

### Reviewing and merging

The extension never merges, rebases or pushes a member's branch. `team_status` and the view give the commands: review a branch with **Show Changes** or `git diff <base>...cco/<team>/<member>`, then merge it yourself with the command **Copy Merge Command** puts on your clipboard. A task a member reports as `review` waits for you to mark it done or send it back for rework.

### Ending and resuming

`team_end` (or **End Team…**) lets running turns finish, commits each worktree and lists every branch with the commands that review and merge it. It never deletes a branch, and never deletes a worktree that holds work. A team whose lead session ended is suspended; `team_resume` from a new session of the same repository continues it.

## The dispatch operations

The main session dispatches in one of two ways, with the same operations, arguments, limits and results. By default it runs them as `~/.claude-code-orchestrator/bin/cco <operation>` commands through its own Bash tool, which needs no MCP server (macOS and Linux). Optionally it calls them as MCP tools of the `cco-dispatch` server, which is also the way to dispatch on Windows. The table lists the operations under their MCP tool names, which are also the `cco` operation names. `cco` has two more that the MCP server does not: `cancel <id>…` stops tasks, and `recent [--limit n]` lists this workspace's latest tasks, for ids that were lost. `~/.claude-code-orchestrator/bin/cco help` lists them all, and the dispatch policy teaches the main session the rest — there is nothing to learn by hand.

<!-- BEGIN GENERATED:tools (tool and argument names from src/mcp/server.ts + src/mesh/contract.ts — do not edit by hand) -->
| Tool | Arguments | Purpose |
|---|---|---|
| `dispatch_tasks` | `tasks[]` (required) — each task takes the dispatch arguments below | **Batch dispatch (preferred).** Hand over several independent tasks in one call (1–100). They run in parallel across worker accounts, up to the server's concurrency limit (8 by default); the rest wait their turn. One malformed task refuses the whole call and nothing runs. The call returns every result. |
| `dispatch_task` | `title` (required), `prompt` (required), `model`, `worker`, `provider`, `system_prompt`, `ultrathink`, `timeout_minutes`, `detach` | Dispatch one self-contained task to one worker. On a quota error it fails over to another eligible worker. |
| `dispatch_status` | `id`, `ids[]` | Read-only: the latest status of a dispatched task by id (running, done or error) — one `id`, or up to 100 `ids` — and, once it has finished, its result (whole up to 1 MiB), including that of a `detach` task whose session was interrupted. An id with no record is `not_found`; if the task log cannot be read, the call fails and says the status is UNKNOWN. |
| `orchestrator_briefing` | `model` (required) | Called once per session by the main model, with its own model id. Records the orchestrator model for the workspace and returns the operating brief for its tier; with session workers on, or other-vendor workers registered, the brief carries those rules too. |
| `list_workers` | `check`, `diagnostics` | Every worker with its default model, cumulative dispatch usage, cooldown state and live plan usage (with reset times and overage-billing state), plus the frontier guard state and how many dispatches wait for a free slot. When a worker on another vendor's CLI is registered, each line also names the CLI it runs on, and such a worker shows its login state and suggested model ids. Registry entries this version cannot use are listed as such; a registry that cannot be read is reported instead of a list. |
| `mesh_status` | none | Session workers only. How many dispatches are in flight against the cap, how many workers are parked, and per worker: task, account, model, permission mode, state, job id, the name to message it by, its worktree, and an attach command. Also reports workers whose owning session is gone. |
| `mesh_stop_worker` | `job_id`, `name`, `force` | Stop one session worker, by `job_id` (preferred) or by name. Its worktree is removed only when it is clean; one that still holds uncommitted or unpushed work is kept. |
<!-- END GENERATED:tools -->

Dispatch arguments, for `dispatch_task` and for each entry of `dispatch_tasks`:

<!-- BEGIN GENERATED:params (argument names from TASK_PROPERTIES in src/mcp/server.ts — do not edit by hand) -->
| Argument | Type | Meaning |
|---|---|---|
| `title` (required) | string | Short label shown in the task lists. One line; cut at 200 characters. |
| `prompt` (required) | string | The complete, self-contained task. The worker sees nothing else of your conversation. Not empty, no NUL character, at most 1 MiB. |
| `model` | string | A tier alias — `opus`, `sonnet`, `fable`, `haiku` — or a full model id. Omit it for the worker's default. A value that is neither is rejected, not replaced. For a worker on another vendor's CLI, pass that vendor's own model id. |
| `worker` | string | A specific worker account. Omit it for automatic, quota-aware assignment among Claude Code workers. |
| `provider` | string | Opt in to another vendor's CLI: `codex`, `cursor` or `gemini` (Antigravity). Omitted, a task only ever runs on a Claude Code worker. |
| `system_prompt` | string | A task-specific system prompt (role, quality bar, output format), layered on the built-in worker base prompt. No NUL character, at most 256 KiB. |
| `ultrathink` | boolean | Escalate that worker to maximum reasoning depth. For contract-critical implementation, subtle debugging and adversarial reviews. `true` or `false` only; any other value is refused. |
| `timeout_minutes` | number | Wall-clock limit for this one dispatch, 1–480 minutes; a value outside that range is clamped to it. Overrides the `workerTimeoutMinutes` setting. |
| `detach` | boolean | A background supervisor owns the task, so it keeps running and records its result even if your session ends. Always a one-shot worker. `true` or `false` only; any other value is refused. |
<!-- END GENERATED:params -->

### The cco command

The first `~/.claude-code-orchestrator/bin/cco` command of a Claude Code session starts a **dispatch host** for it: a background Node process that runs the same dispatch server code. Later commands reach it over a private socket in `~/.claude-code-orchestrator/run/`. The host ends by itself when that Claude Code session ends, and then stops that session's workers exactly as the MCP server does; its log is `~/.claude-code-orchestrator/run/s<pid>.log`. The extension installs the launcher at `~/.claude-code-orchestrator/bin/cco` (macOS and Linux) and keeps it current at each activation, next to the server copy; it runs the Node.js the extension found, or `node` from `PATH`. Once installed, it keeps working in a terminal Claude Code session with the editor closed.

A task is handed over as files, so no prompt text is ever on a command line. The session writes them with its Write tool into `.cco/` at the workspace root: a small JSON file for each task, and the prompt in its own file. A batch for `dispatch_tasks` is a file of the form `{"tasks": [ … ]}` with one such entry per task.

| Task-file field | Meaning |
|---|---|
| `title` | A short label for the task lists. |
| `prompt_file` | The file that holds the prompt, written by the session next to the JSON file. |
| `system_prompt_file` | Optional: the file that holds a task-specific system prompt. |
| `model`, `worker`, `provider`, `ultrathink`, `timeout_minutes`, `detach` | Optional; the same as the dispatch arguments above, with the same rules. |

Then it runs one short command, for example:

```
~/.claude-code-orchestrator/bin/cco dispatch_tasks .cco/batch.json
~/.claude-code-orchestrator/bin/cco dispatch_status --wait 540 <id>
~/.claude-code-orchestrator/bin/cco cancel <id>
~/.claude-code-orchestrator/bin/cco recent --limit 5
```

- **Waiting.** A dispatch waits until every task has finished, then prints the results. `--wait <seconds>` waits at most that long, and `--no-wait` returns as soon as the tasks are accepted. Task ids are printed at once (`cco: accepted <id> — <title>`) and each task's end as it happens (`cco: settled <id> done` or `error`).
- **Ending the command is not cancelling.** Ending or interrupting it only ends the waiting: the work goes on, and `dispatch_status` reads it. `cancel` stops it, and `recent` finds ids that were lost.
- **Long results.** A result of more than 28,000 characters is cut at a line end and saved whole in `.cco/out/`, with every task's report path listed.
- **Scratch files.** `.cco/` gets a `.gitignore` containing `*` on first use, so git ignores it. The product never deletes anything in it. The policy tells the session to give each task a new file name in `.cco/`.
- **A dispatched worker cannot dispatch.** Every worker carries a marker, `cco` refuses to run inside one, and the MCP server's `dispatch_task`, `dispatch_tasks`, `mesh_stop_worker` and `orchestrator_briefing` answer an error there; `list_workers`, `dispatch_status` and `mesh_status` still answer. It is a guard against accidents.

### Exit codes

The `cco` command ends with one of these codes:

| Exit code | Meaning |
|---|---|
| `0` | The answer was printed. A batch whose tasks failed is still 0 — read the results. |
| `20` | The operation answered with an error. |
| `21` | The command or a task file is wrong; nothing was started. |
| `22` | `cco` cannot run here; the message says why (see [Troubleshooting](#troubleshooting)). |
| `23` | `--wait` ran out; the work goes on. |
| `24` | The waiting was interrupted; the work goes on. |

### Argument rules and limits

Arguments are checked before anything runs. An invalid call is refused with a message that names the field, and nothing is started or recorded for it.

- **Batches.** `dispatch_tasks` takes 1 to 100 tasks. All of them are checked first: one malformed task refuses the whole call, and none of its tasks runs.
- **Values.** A wrong type, an empty `prompt`, a NUL character in `prompt` or `system_prompt`, a `prompt` over 1 MiB and a `system_prompt` over 256 KiB are refused. `ultrathink` and `detach` take only `true` or `false`: the string `"true"` or the number `1` is refused, not read as true. A `title` is flattened to one line and cut at 200 characters; `model`, `worker` and `provider` are single lines of at most 200 characters; a `timeout_minutes` outside 1–480 is clamped to that range.
- **Concurrency.** One dispatch server runs at most `maxConcurrentDispatches` one-shot, vendor and detached dispatches at a time — 8 unless you change it in the registry file ([see below](#the-worker-registry)) — and the rest wait in order; `list_workers` shows how many wait. A `dispatch_tasks` batch is therefore not "all at once" beyond that limit. Session workers are not counted there: `meshMaxLiveWorkers` limits them, and a dispatch past that cap is refused rather than queued.
- **Status.** `dispatch_status` takes one `id` or up to 100 `ids`; more is refused. An id the server has no record of is `not_found`. If the task log itself cannot be read, the call fails and says the status is UNKNOWN, because the tasks may well exist.
- **Results.** A result of up to 1 MiB comes back whole. A longer one is cut there and ends with a line naming the task's report file under `~/.claude-code-orchestrator/tasks/`, which holds all of it. A one-shot worker whose output passes 8 MiB is ended, and the dispatch fails like any other failed dispatch.
- **Result tokens.** The result file of a detached task and of a session worker must carry a random per-task token. The token is never on a command line and never in the task log, which keeps only its SHA-256; for a session worker it is the first line of the task file in that task's own directory (mode `0700`). This stops a result written for another task, by another user's process, or forged from the task log. It does not stop a process that runs as your own user and reads that task file or the server's memory: nothing on disk can.

### Models

`model` is a tier alias — `opus`, `sonnet`, `fable`, `haiku` — which Claude Code resolves to the newest model of that family, or a full model id when you want to pin one. A worker's default model is stored as an alias, so it does not go stale. A value that is neither an alias nor a well-formed model id is **rejected** before anything starts; it is never silently replaced by the worker's default.

**See which model ran.** After a run the CLI reports the model id it used, and the product shows it. The first line of a result reads `[worker: wa, model: haiku → claude-haiku-4-5-20251001]`; the arrow appears only when the CLI reported a model that differs from the text asked for, otherwise the line is as before. The task's report file records `model ran` (when reported) and `model source`: named by the dispatch, worker default, or CLI default (no default stored, so the CLI chose). `list_workers` shows `default model haiku (last ran as …)` for each worker, `dispatch_status` returns `modelSource` and, for a finished task, `modelUsed`, and the dashboard shows "default haiku · last ran …" on an account card and `opus → …` in a task row, with the source in its tooltip and details.

**What an alias means depends on the CLI version installed for that account**, not on this extension. As an example, measured on one machine on 2026-10-14: Claude Code 2.1.283 ran `haiku` as `claude-haiku-4-5-20251001` and `sonnet` as `claude-sonnet-5`, while 2.1.296 ran `haiku` as `claude-haiku-5-5` and `sonnet` as `claude-sonnet-5-5` (`opus` was measured only on 2.1.283: `claude-opus-5-5`). So a newer CLI resolved the same aliases to newer models in that case; this is a measurement, not a promise. Update the Claude Code CLI of an account to get it, and the "last ran" text shows the result. For a Claude Code account **Set Default Model** offers the four aliases, each with "last ran as …" when known, and **Enter a model id…**. **Set Default Model** lists what that account's CLI itself offers: the aliases with what they mean on that CLI ("opus — Opus 5.5"), then the older models it still offers; for Codex the CLI's current list with the default marked and the reasoning efforts each supports. `list_workers` shows per account what its aliases mean on its CLI. Two config folders signed in to one claude.ai account (the editor session's own included) are named as such on the dashboard, in the Worker Accounts view and in `list_workers`, because they draw on one plan's limits; dispatch is not changed by it, and only a hash of the address is kept to compare them. "Last ran as" is the model of the task itself: when a task starts subagents on other models, it is not the most expensive model in the run, and when that cannot be told nothing is shown. The three ids that meant a tier in 1.x (`claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`) can be pinned exactly like any full id, from the list or typed; an alias follows the newest model of its family. In a dispatch argument these three ids still mean their tier. An older version of the extension reads them as the tier everywhere.

## The orchestration quality stack

Three prompt layers ship with the extension. All model-facing text is English.

1. **Worker base prompt** — prepended to every dispatched task: contract discipline (binding interfaces, file-ownership limits), autonomy to completion, scope restraint, evidence-audited reporting.
2. **Dispatch policy** (a block in `CLAUDE.md`, upserted between marker comments) — the standing instructions for the *main* session. The heart of it: **the orchestrator does not implement.** It does design, decomposition, dispatch, integration and verification; production code, tests and docs are written by workers. Plus batch parallelism, verification loops, hunting unknown unknowns, and an escalation ladder for the frontier tier. The policy names models by alias and tells the session to omit `model` by default, so a task runs on its worker's default; it names `sonnet` for documentation and simple transforms. If the `CLAUDE.md` of a workspace holds a policy block from another version, or one you changed, the dashboard's setup area offers **Update the dispatch policy**, and **Add Dispatch Policy to CLAUDE.md** asks before replacing it. Only the text between the policy's markers is replaced; text outside them is never changed. A block that is already current is left alone and said to be current. A marker counts only on a line of its own and outside a code block, so quoting the markers in text or in a code example is not a policy block. After an add or update the file holds exactly one policy block (duplicates and markers that lost their partner are removed), written in the file's own line endings, and a block that a markdown formatter re-spaced still counts as current. The offer after **Register Dispatch MCP Server in This Workspace** asks before replacing a block that is not this version's, as the command does. **Update Workspace Setup** keeps the block current as the first item of its checklist, and the installed policy teaches the main session to dispatch with the `cco` command, with the same operations as the MCP tools. When the policy is added by itself on macOS or Linux and the folder's permission rules are missing, the extension also asks once whether to let the session run `cco` without permission prompts (**Allow cco**).
3. **Model calibration** (returned by `orchestrator_briefing`) — a frontier-tier orchestrator gets a short confirmation; other tiers get a calibration addendum that holds them to the same operating standard during long multi-agent work. With session workers on, or with other-vendor workers registered, the brief also carries the rules for those.

The stack is benchmark-tuned: across four two-orchestrator A/B builds of increasing difficulty, judged blind with execution-grounded probes, the scoring gap between a frontier orchestrator and a calibrated Opus orchestrator narrowed from about 11.5 points to **3 points with zero functional defects on either side**. See [docs/benchmarks.md](docs/benchmarks.md).

## Quota-aware scheduling and billing guards

- **Cooldown and failover.** On a quota or rate-limit error the worker goes on a configurable cooldown and the task fails over to another eligible worker. With a single worker there is nothing to fail over to, and you get a clear error instead.
- **What counts as a quota error.** A status code stated as a status (`status 429`, `HTTP 529`, `"code": 429`), or a message that an account allowance was reached, exceeded or used up ("out of extra usage", "limit has been reached"). Stack traces, paths, URLs, quoted identifiers and test-runner result lines are ignored, `context limit exceeded` is not an account limit, and a spawn failure, a timeout or an output overflow is never a quota failure. The rules were tested against written-out error texts, not against live captures of every CLI at its limit.
- **Accounts that cannot work are skipped.** An account whose live plan usage shows an exhausted window, or whose login has expired, is skipped by automatic assignment and refused when named. A completed re-login is detected on the next dispatch. An account on another vendor's CLI whose run failed on login is also skipped for up to 30 minutes, until a run succeeds or you sign in again from the extension, because that CLI's own status command can still say it is logged in.
- **★ Preferred worker.** Mark the worker that shares your main account (**Toggle Preferred Worker**); it wins automatic assignment whenever it is not busier than the least busy alternative.
- **Overage guard.** Once a plan window is used up, an account with extra usage enabled starts billing real money. `claudeCodeOrchestrator.overageWorkerDispatch` defaults to `block`: the dispatch server never assigns work to a quota-exhausted worker, even when extra usage is on. `allow` permits it as a last resort.
- **Frontier guard.** The frontier tier (`fable`) may bill per use or draw a separate quota, depending on the plan. `claudeCodeOrchestrator.frontierWorkerDispatch` defaults to `block`: such dispatches are rejected in the dispatch server — not just discouraged in a prompt — with an error that steers the orchestrator to `opus` with `ultrathink`. `list_workers` shows the guard state before any dispatch is attempted. While the guard blocks `fable`, an account whose default model is `fable` is skipped by a dispatch that names no model, and the task runs on the next account; a dispatch that names that account, or names `fable`, is refused. `list_workers`, the model picker and the account's Default model row say so.

Both guards are enforced by the dispatch server and shared by every editor on the machine, and both cover Claude Code workers only.

## Asset packs and Asset Manager

An **asset pack** is a plain directory that mirrors the `.claude/` layout — `skills/`, `agents/`, `commands/`, `output-styles/`, `hooks/` — with an optional `pack.json`. Two kinds are available: the **bundled pack** shipped inside the extension, and any **user packs** you list in `claudeCodeOrchestrator.assetPacks` (for example a private repo clone).

Enable individual assets per workspace; enabling installs them into that workspace's `.claude/` directory, and the choice is tracked in `.claude/cco-assets.json` — the ownership ledger sync uses to know what it wrote. If that file cannot be read — damaged, not JSON, not a regular file, over 8 MiB — sync and the Asset Manager change nothing and say so, with an action to open it; the file is left exactly as it is.

**Sync** keeps enabled assets installed and up to date, but it never overwrites a file you have edited by hand — that file is reported as "customized" instead. Disabling an asset removes only the files sync itself wrote. **Reset** is the explicit escape hatch that overwrites a file, or a whole asset, with the pack version. An install path that holds a symbolic link, a directory, a pipe or a file over 16 MiB is never read as content and never written, not even by **Reset**: sync lists that file as "not synced", with the reason, and carries on with the rest. Files are written by replacing the name, so what sits at the name can neither stall sync nor redirect it.

The **Asset Manager panel** (**Open Asset Manager**) is where you manage all of this: add or remove pack directories, toggle assets per workspace, and see a status badge for each one:

| Badge | Meaning |
|---|---|
| synced | installed and matches the pack |
| update available | the pack has moved ahead of what is installed |
| customized | you edited the installed file — sync will not touch it |
| conflict | two enabled assets claim the same install path |
| not installed | enabled but not yet synced |

From the panel you can also diff or reset any out-of-sync file, clean up orphaned installs, and scaffold a new skill, agent, command, output style or hook with **New asset…** (it writes into a writable pack — the bundled pack is read-only here).

**Hooks are scripts, not markdown.** Installing a `hook` asset writes the script to disk but does not register it — you still add it to the `hooks` block in `.claude/settings.json` yourself; the scaffold's comments show the exact entry.

Anything in the extension's own bundled `assets/` becomes public the moment the extension is published. Keep personal or team-private assets in a separate pack directory and register it through `assetPacks`.

## Commands

<!-- BEGIN GENERATED:commands (from package.json + package.nls — do not edit by hand) -->
| Command | Command id | Where it appears |
|---|---|---|
| Add Worker Account | `claudeCodeOrchestrator.addWorker` | Command Palette · Worker Accounts view toolbar |
| Import Existing Claude Config Directories | `claudeCodeOrchestrator.importWorkers` | Command Palette · Worker Accounts view toolbar |
| Remove Worker Account | `claudeCodeOrchestrator.removeWorker` | Command Palette · Worker Accounts view, on a row |
| Remove Registry Entry… | `claudeCodeOrchestrator.removeUnsupportedEntry` | Worker Accounts view, on a row |
| Rename Worker Account | `claudeCodeOrchestrator.renameWorker` | Command Palette · Worker Accounts view, on a row |
| Set Default Model | `claudeCodeOrchestrator.setWorkerModel` | Command Palette · Worker Accounts view, on a row |
| Set Permission Mode | `claudeCodeOrchestrator.setWorkerPermissionMode` | Command Palette · Worker Accounts view, on a row |
| Sign In Worker Account (opens its CLI in a terminal; it asks you to sign in) | `claudeCodeOrchestrator.loginWorker` | Command Palette · Worker Accounts view, on a row |
| Re-login Account (opens the CLI's login in a terminal) | `claudeCodeOrchestrator.reloginWorker` | Command Palette · Worker Accounts view, on a row |
| Check Login Now | `claudeCodeOrchestrator.checkLoginNow` | Command Palette · Worker Accounts view, on a row |
| Show Login Diagnostics | `claudeCodeOrchestrator.showLoginDiagnostics` | Command Palette |
| Open Worker Session in Terminal (watch & steer this account) | `claudeCodeOrchestrator.openWorkerSession` | Command Palette · Worker Accounts view, on a row |
| Toggle Preferred Worker (same account as main — favored when idle) | `claudeCodeOrchestrator.togglePreferred` | Command Palette · Worker Accounts view, on a row |
| Account Action… | `claudeCodeOrchestrator.accountAction` | not shown — used by the dashboard and the views |
| Register Dispatch MCP Server in This Workspace | `claudeCodeOrchestrator.installMcp` | Command Palette · Worker Accounts view toolbar |
| Add Dispatch Policy to CLAUDE.md | `claudeCodeOrchestrator.addDispatchPolicy` | Command Palette |
| Install Team Proxy Agent in This Workspace | `claudeCodeOrchestrator.installTeamAgent` | Command Palette · Team view toolbar |
| Update Workspace Setup | `claudeCodeOrchestrator.updateWorkspaceSetup` | Command Palette |
| Show Task Output | `claudeCodeOrchestrator.showTaskOutput` | not shown — used by the dashboard and the views |
| Open Task Output | `claudeCodeOrchestrator.openTaskOutput` | not shown — used by the dashboard and the views |
| Clear Task History | `claudeCodeOrchestrator.clearTasks` | Command Palette · Dispatched Tasks view toolbar |
| Cancel Dispatched Task | `claudeCodeOrchestrator.cancelTask` | Command Palette · Dispatched Tasks view, on a row |
| Cancel All Running Dispatches | `claudeCodeOrchestrator.cancelAllTasks` | Command Palette · Dispatched Tasks view toolbar |
| Toggle Task Scope (This Workspace / All) | `claudeCodeOrchestrator.toggleTaskScope` | Command Palette · Dispatched Tasks view toolbar |
| Open Orchestrator Dashboard | `claudeCodeOrchestrator.openDashboard` | Command Palette · Worker Accounts view toolbar · Team view toolbar · Dispatched Tasks view toolbar |
| Open Extension Settings | `claudeCodeOrchestrator.openSettings` | Command Palette · Team view toolbar |
| Refresh Account Usage | `claudeCodeOrchestrator.refreshUsage` | Command Palette · Worker Accounts view toolbar |
| Reset Main-Session Check-in for This Workspace | `claudeCodeOrchestrator.resetCheckin` | Command Palette |
| Clean Up Stale Session Files | `claudeCodeOrchestrator.cleanSessionLitter` | Command Palette · Worker Accounts view toolbar · Team view toolbar |
| Open Asset Manager (workspace skills, agents, commands) | `claudeCodeOrchestrator.openAssetManager` | Command Palette · Worker Accounts view toolbar |
| Manage Workspace Assets (quick pick) | `claudeCodeOrchestrator.manageAssets` | Command Palette |
| Sync Workspace Assets Now | `claudeCodeOrchestrator.syncAssets` | Command Palette |
| Reset Customized Asset to Pack Version | `claudeCodeOrchestrator.resetAsset` | Command Palette |
| Session Action… | `claudeCodeOrchestrator.sessionAction` | not shown — used by the dashboard and the views |
| Attach to Session in Terminal | `claudeCodeOrchestrator.attachSession` | Team view, on a row |
| Show Session Logs | `claudeCodeOrchestrator.sessionLogs` | Team view, on a row |
| Stop Session | `claudeCodeOrchestrator.stopSession` | Team view, on a row |
| Open Result Branch Diff | `claudeCodeOrchestrator.openSessionDiff` | Team view, on a row |
| Copy Session Name (for SendMessage) | `claudeCodeOrchestrator.copySessionName` | Team view, on a row |
| Refresh Team | `claudeCodeOrchestrator.refreshTeam` | Command Palette · Team view toolbar |
| Clear Stopped Workers | `claudeCodeOrchestrator.clearStoppedWorkers` | Command Palette · Worker History view toolbar |
| Send Message… | `claudeCodeOrchestrator.teamSendMessage` | Team view, on a row |
| Send to All… | `claudeCodeOrchestrator.teamSendToAll` | Team view, on a row |
| Interrupt | `claudeCodeOrchestrator.teamInterrupt` | Team view, on a row |
| Take Over in Terminal | `claudeCodeOrchestrator.teamTakeOver` | Team view, on a row |
| Release | `claudeCodeOrchestrator.teamRelease` | Team view, on a row |
| Stop | `claudeCodeOrchestrator.teamStopMember` | Team view, on a row |
| Restart | `claudeCodeOrchestrator.teamRestartMember` | Team view, on a row |
| Pause | `claudeCodeOrchestrator.teamPauseMember` | Team view, on a row |
| Unpause | `claudeCodeOrchestrator.teamUnpauseMember` | Team view, on a row |
| Show Activity | `claudeCodeOrchestrator.teamShowActivity` | Team view, on a row |
| Show Changes | `claudeCodeOrchestrator.teamShowChanges` | Team view, on a row |
| Copy Branch | `claudeCodeOrchestrator.teamCopyBranch` | Team view, on a row |
| Copy Merge Command | `claudeCodeOrchestrator.teamCopyMergeCommand` | Team view, on a row |
| Open Worktree in New Window | `claudeCodeOrchestrator.teamOpenWorktree` | Team view, on a row |
| End Team… | `claudeCodeOrchestrator.teamEnd` | Team view, on a row |
| Add Task… | `claudeCodeOrchestrator.teamAddTask` | Team view, on a row |
| Assign… | `claudeCodeOrchestrator.teamAssignTask` | Team view, on a row |
| Done | `claudeCodeOrchestrator.teamTaskDone` | Team view, on a row |
| Rework | `claudeCodeOrchestrator.teamTaskRework` | Team view, on a row |
| Cancel | `claudeCodeOrchestrator.teamTaskCancel` | Team view, on a row |
| Reopen | `claudeCodeOrchestrator.teamTaskReopen` | Team view, on a row |
| Turn On Teammate Mode (Experimental) | `claudeCodeOrchestrator.teamModeTurnOn` | Command Palette · Team view toolbar |
| Turn Off Teammate Mode | `claudeCodeOrchestrator.teamModeTurnOff` | Command Palette |
<!-- END GENERATED:commands -->

## Settings

Every setting is also reachable from the dashboard's settings drawer, except the two asset settings.

**Settings are read from your User settings only.** Every setting is machine-scoped. A value in a workspace's or a folder's `.vscode/settings.json`, or in a `.code-workspace` file, is ignored, and the extension says so once at activation, naming the keys and where they were found. A workspace can be a repository you just cloned, or one an agent is editing right now, and these settings decide which program is started, what a worker may do unattended and whether money may be spent. A value of the wrong type reads as not set.

`claudePath` must be a command name or an absolute path; anything else is not used (the default `claude` is, and a warning says so). Storing `bypassPermissions`, `allow` for either billing guard, or a `claudePath` other than `claude` from the dashboard or a command asks for confirmation in a dialog first; a value you type into the Settings editor yourself is not asked about. Terminal command lines the extension types are quoted by one function for the shell the editor uses (a POSIX shell, PowerShell or cmd), and a value that cannot be written safely for that shell is not typed at all — an error says so.

<!-- BEGIN GENERATED:settings (from package.json + package.nls — do not edit by hand) -->
| Setting | Type | Default | Allowed | Description |
|---|---|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | string | `"acceptEdits"` | `acceptEdits`, `auto`, `dontAsk`, `plan`, `default`, `bypassPermissions` | --permission-mode for dispatched workers. A dispatched worker runs unattended and cannot answer a permission prompt, so a mode that asks ('default') stalls on its first edit. Session workers (Mesh Mode) never run in 'bypassPermissions': they start in 'acceptEdits' instead. Applies to Claude Code workers only: a worker on another vendor's CLI has a permission mode of its own ("Set Permission Mode" on the worker). |
| `claudeCodeOrchestrator.claudePath` | string | `"claude"` | — | The Claude Code CLI to run: a command name such as `claude` (looked up on PATH) or an absolute path. A relative path or one starting with '~' is not used: the default `claude` is used instead and you are told. Read from your User settings only — a workspace value is ignored. |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | number | `30` | `1`–`1440` | Minutes a worker account sits out after a quota/rate-limit error before dispatches are routed to it again. |
| `claudeCodeOrchestrator.workerTimeoutMinutes` | number | `45` | `1`–`480` | Minutes a dispatched worker may run before it is terminated. Deep tasks (contract-critical implementation, adversarial review) routinely exceed 30 minutes; a task killed here loses its unwritten work. A single task can override this with the dispatch tool's timeout_minutes argument. |
| `claudeCodeOrchestrator.assetPacks` | list of strings | `[]` | — | Additional asset-pack directories ('~' allowed). Each pack mirrors the .claude/ layout — skills/, agents/, commands/, output-styles/ — and its assets become available in 'Manage Workspace Assets'. Point this at a clone of a private asset repo to keep personal assets out of the public extension. |
| `claudeCodeOrchestrator.assetAutoSync` | boolean | `true` | — | On startup, refresh assets enabled in this workspace when their pack content changed. Files you have edited by hand are never overwritten — the Asset Manager shows them as 'customized', with a diff against the pending pack version. |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | string | `"block"` | `block`, `allow` | Billing guard over WHICH MODEL may be dispatched: it governs only the frontier tier (fable). 'block' (default) makes the dispatch server reject those dispatches and steer the orchestrator to opus + ultrathink. This setting does NOT prevent overage billing for other models — a dispatch of any model can still spend real money past an exhausted plan window; that is controlled by overageWorkerDispatch. |
| `claudeCodeOrchestrator.overageWorkerDispatch` | string | `"block"` | `block`, `allow` | Billing guard for overage (extra-credit) dispatches. 'block' (default): the dispatch server never assigns work to a quota-exhausted worker, even when that account has extra usage enabled — dispatch never spends money past a plan window. 'allow': exhausted workers with extra usage enabled may be used as a last resort; those dispatches bill real money against the account's monthly cap. Independent of frontierWorkerDispatch, which only controls the frontier tier (fable). |
| `claudeCodeOrchestrator.sessionKeepalive` | boolean | `false` | — | Send one minimal Claude request (haiku model) per subscription account per 24h to keep OAuth sessions fresh. Spends a negligible amount of plan usage. Off by default; recovery from an already-expired login is the Re-login command. |
| `claudeCodeOrchestrator.providerUsagePolling` | boolean | `true` | — | Ask other vendors' CLIs for plan usage. When on (the default), every usage refresh — at startup, every 5 minutes, and on "Refresh Account Usage" — also asks each worker account that runs on another vendor's CLI (Codex, Cursor, Antigravity) for a usage reading. Where the vendor provides one, that is a request sent from this machine to the vendor's usage service; a helper process reads the login the vendor's CLI already stored here to make it, and the extension stores and shows no token. Turn this off to stop those requests: such accounts then show "no usage reading", their login state is still checked through the CLI, and dispatch is unaffected. Claude Code accounts are not governed by this setting. |
| `claudeCodeOrchestrator.meshMode` | boolean | `false` | — | EXPERIMENTAL. Turn on session workers (Mesh Mode): each dispatched task runs as a persistent background session (`claude --bg`) instead of a one-shot worker. In a git workspace the worker edits in its own worktree and branch, created from your current HEAD commit — it sees every commit on the current branch and nothing uncommitted. Requires Claude Code >= 2.1.283 on macOS or Linux. A session worker is a peer of your own session: steer it with SendMessage, using the name on the `peer:` line of the dispatch result, and find it in the Team view to attach, read its logs or stop it. Dispatch itself is unchanged — same dispatch_task / dispatch_tasks tools, results, timeouts, cancellation and failover. Tasks dispatched with detach still run as one-shot workers, and when session workers cannot be used (an older CLI, or an account that has not trusted this workspace) the dispatch falls back to a one-shot worker and says so in its result. Off by default. |
| `claudeCodeOrchestrator.meshMaxLiveWorkers` | number | `8` | `1`–`64` | EXPERIMENTAL. Maximum number of session workers with a dispatch still in flight. A dispatch past the cap is REFUSED, not queued: it fails with a worker_cap error naming this limit. Parked workers — their dispatch has finished and they only stay attachable — do not count. Let running dispatches finish before a larger fan-out, or raise this number. Only takes effect when Mesh Mode is on. |
| `claudeCodeOrchestrator.meshHistoryLimit` | integer | `50` | `1`–`1000` | EXPERIMENTAL. Maximum number of finished session-worker dispatches kept in the Worker History view before the oldest are dropped. Integer, default 50, minimum 1. Only takes effect when Mesh Mode is on. |
| `claudeCodeOrchestrator.teamMode` | boolean | `false` | — | EXPERIMENTAL. Turn on Teammate mode: your Claude Code session can lead a team of coding agents — Claude Code, Codex, Cursor or Antigravity worker accounts — each in its own git worktree and branch, coordinating through messages and a shared task board, with the `cco team_*` commands. The Team view shows every team of this workspace and lets you message, pause, stop or take over its members. macOS and Linux only. Turned off while a team runs, the team continues; only creating a team or adding a member is refused. Off by default. |
| `claudeCodeOrchestrator.teamMaxMembers` | number | `6` | `1`–`8` | EXPERIMENTAL. Maximum number of members in one team, stopped members included. Integer, default 6, 1 to 8. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamMaxRunningTurns` | number | `4` | `1`–`16` | EXPERIMENTAL. Maximum number of team member turns running at once in one Claude Code session. Turns do not take dispatch slots. Integer, default 4, 1 to 16. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamTurnTimeoutMinutes` | number,null | `null` | `5`–`240` | EXPERIMENTAL. Minutes one team member turn may run before it is stopped. Integer, 5 to 240. Not set (the default): the value of workerTimeoutMinutes. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamTurnsPerMemberPerHour` | number | `20` | `1`–`240` | EXPERIMENTAL. Maximum number of turns one team member may start per hour; past it the member waits. Integer, default 20, 1 to 240. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamTurnsPerDay` | number | `300` | `10`–`5000` | EXPERIMENTAL. Maximum number of turns per team per day; past it the team waits until tomorrow. Integer, default 300, 10 to 5000. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamCursorForce` | boolean | `false` | — | EXPERIMENTAL. Cursor teammates run with `--force` (commands run without approval). Off by default: Cursor teammates then edit files but may not reach their team tools on every turn. Only takes effect when Teammate mode is on. |
| `claudeCodeOrchestrator.teamAgySkipPermissions` | boolean | `false` | — | EXPERIMENTAL. Antigravity teammates run with `--dangerously-skip-permissions` — needed for their team tools; every command then runs without approval. Off by default: Antigravity teammates then run turns-only (they report at the end of each turn and cannot use the team tools). Only takes effect when Teammate mode is on. |
<!-- END GENERATED:settings -->

### The worker registry

`~/.claude-code-orchestrator/registry.json` holds the worker accounts and a copy of the settings the dispatch server needs: the extension copies your User settings into it, and the server reads it at each dispatch. You may edit it by hand. Its rules:

- **Two keys for accounts.** `workers` holds Claude Code accounts only. Accounts of other vendors' CLIs are stored under a second top-level key, `vendorWorkers`, each entry carrying its `provider`; the key is absent while there are none. An editor of an earlier version that shares the file never sees a vendor account as a Claude Code account, and it leaves the key as it is.
- **`maxConcurrentDispatches`** is how many one-shot, vendor and detached dispatches one dispatch server runs at a time: a whole number from 1 to 64, default 8; anything else reads as 8. It is edited in this file — 2.0 has no VS Code setting for it.
- **Entries this version cannot use** — an unknown provider, an incomplete entry, a duplicate name, no name — are kept in the file exactly as they are and take part in nothing. The Worker Accounts view and the dashboard show them, and **Remove Registry Entry…** deletes one after you confirm.
- **A registry that cannot be read is never overwritten.** That means invalid JSON, a file that is not an object, a `workers` or `vendorWorkers` value that is not a list, a file over 1 MiB, something that is not a regular file, or a read error. Every change is refused with a message that names the file; the Worker Accounts view and the dashboard report it with an **Open File** action; `list_workers` and `dispatch_task` answer with the problem instead of "no workers". A UTF-8 byte-order mark is accepted, and an empty file reads as a new registry. Before 2.0, such a file was silently replaced by an empty registry.
- **Renaming a worker** updates the task log, the statistics and the registry together, or changes none of them.
- **Worker names** use letters, digits, `_` and `-`, at most 64 characters. `main` is reserved for your own account, and a name every plain object already has (`constructor`, `toString`, `__proto__`, …) is refused. The rule holds wherever a name is typed and when accounts are imported; a name already in the file is not judged by it. **Import Existing Claude Config Directories** offers only a real directory — never a symbolic link — in your home directory whose name starts with `.claude` and that holds a `.claude.json` or `.credentials.json` file, or a `sessions/` or `projects/` directory, and it asks for a name when the directory's own name does not fit the rule.

## Upgrading from 1.x

Restart the Claude Code session after updating, so that it reads the new tool list. The MCP registration itself keeps working — the server copy at the stable path is refreshed on activation. To dispatch without MCP, run **Update Workspace Setup** once in each workspace.

**Removed, and what replaces each.**

| Removed in 2.0 | Use instead |
|---|---|
| The relay "gateway" session and the `meshGatewayModel` setting | Nothing to configure. On Claude Code 2.1.283 and newer the IDE panel session is itself a messaging peer, so no relay is needed |
| The `mesh_send_worker` tool | Your session's own `SendMessage` tool, addressed to the worker name on the `peer:` line of the dispatch result |
| The `mesh_receive` tool | Replies arrive as ordinary cross-session messages. Workers no longer send progress notes on their own — ask one for a status |
| The `mesh_keep_worker` tool and keep-alive marks | Not needed: nothing stops an idle worker any more |
| The idle auto-stop and the `meshWorkerIdleTimeoutMin` setting | A parked worker runs until you stop it (Team view, dashboard, `mesh_stop_worker`), its owning session ends, or Claude Code retires it |
| The "Attachable workers" group in the Worker Accounts tree | The **Team** view |

A stale `meshGatewayModel` or `meshWorkerIdleTimeoutMin` key in your settings is ignored. A call to a removed tool gets the standard unknown-tool error; if your `CLAUDE.md` still carries the 1.x policy block, run **Add Dispatch Policy to CLAUDE.md** once to refresh it.

**Changed behaviour to know about.**

- **Models are tier aliases.** Use `opus`, `sonnet`, `fable` or `haiku`, or a full model id. The three dated ids that 1.x accepted — `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5` — are read as `opus`, `sonnet` and `fable`, including in a stored worker default. An unrecognized `model` is now rejected instead of being replaced by the worker's default.
- **The result of a session worker is a branch to merge**, and its worktree now starts from your current HEAD commit. Before 2.0, Claude Code's default applied and a worker could start from the remote default branch without the commits of the branch you were on.
- **Session workers need Claude Code 2.1.283 or newer** (1.5 needed 2.1.224). On an older CLI dispatch still works, one-shot.
- **`meshMaxLiveWorkers` counts only dispatches still in flight.** Parked workers no longer use up the cap.
- **Session workers never run in bypass-permissions mode**; with that setting they start in `acceptEdits`.
- **A worker that ends its turn without reporting is recorded as a failed dispatch** with an attach command. It is no longer nudged after a silence, and it no longer hangs until the timeout.
- **A task left "running" by a session that died is settled on the next start** from the result its worker recorded, or marked orphaned when there is none.
- **Settings are read from your User settings only.** A value in a workspace's or a folder's settings is ignored and reported once at activation. Move any setting you kept there into your User settings.
- **Arguments are checked before anything runs.** A non-boolean `detach` or `ultrathink`, an empty prompt, a NUL character, a prompt over 1 MiB, a malformed task in a `dispatch_tasks` batch, or more than 100 tasks is refused — and one malformed task refuses the whole batch.
- **A registry file that cannot be read is no longer replaced** by an empty one: every change is refused until you fix the file.
- **A dispatch started by an earlier build whose dispatch server then died is no longer completed automatically.** It is settled as an error with a note, and its result file is kept for 24 hours.

**The first-run cleanup of stale session files.** Earlier versions read each account's plan usage by starting a short `claude` process and then killing it. Every kill left two small files behind in that account's `sessions/` directory, and over months these grew to tens of thousands per account — enough to make Claude Code's own session listing take more than 30 seconds. 2.0 ends that process cleanly, so nothing is left behind any more, and it removes what earlier versions left: about 15 seconds after startup, and then at most once a day, it deletes only files that match the signature of those probes, that nobody has touched for 10 minutes, and whose process is provably gone: the process id comes from the file name and must no longer exist, and for an entry that names a messaging socket, nobody may be listening at `<pid>.sock` either. A live session is never touched. You are told once, the first time anything was removed; the totals are in the "Claude Code Orchestrator" output channel, and **Clean Up Stale Session Files** runs the same pass on demand.

## What is experimental or not verified

**Experimental.** Session workers (Mesh Mode), the Team view's listing of native agent teams, and the team proxy agent rest on Claude Code internals that have no public API — the session registry, the background-session commands and the agent-team files. If those change, session workers fall back to one-shot workers and a listing can come back empty; a change that lands mid-dispatch shows up as a timeout or a failed dispatch, not as a wrong result.

**Verified against the real CLIs, 2026-10-13** (macOS, Claude Code 2.1.283). A session worker on the main account, end to end: start, a worktree based on HEAD, the result, the auto-commit, `mesh_status`, a message to it with `SendMessage` from an IDE-panel session (which reported 2.1.292) and its reply, and a stop that kept an unmerged worktree. One-shot dispatches to Antigravity and to Codex (inside a git repository).

**Verified again against the real CLI, 2026-10-14** (macOS, Claude Code 2.1.283, the main account as the worker), after the result tokens and the process-identity checks were in. A session-worker dispatch completed, the worker copying its token from the first line of its task file; no token appeared on any command line, and the task log held only its SHA-256. A detached one-shot task was relayed through the token check, and `mesh_stop_worker` stopped the session. The command line and start time of a real `--bg` session match the rule the forced stop uses to confirm that a process is the worker. **Not exercised live:** a forced stop, a task long enough for many liveness checks, a parked session that is revived, anything on another account, and a planted result file being refused; those were tested against stand-ins only.

**Verified against the real vendor CLIs, 2026-10-14.** Dispatches to the real Codex (codex-cli 0.162.1), Cursor (cursor-agent 2026.10.12) and Antigravity (agy 1.3.4) CLIs each returned their answer, and no Anthropic or Claude variable reached any of them. On Claude Code 2.1.283, a default model, a model named by the dispatch and a detached dispatch each showed the model that ran. The model-list helper was run against the three real CLIs.

**Verified in a real editor.** The compiled extension was installed in a VS Code 1.138 window. It activated with no error notification, the four views and the dashboard (under its Content Security Policy) loaded, and the screenshots in this README were taken there.

**Verified live, 2026-10-15.** A permission rule written with `~` matches the command typed with `~` and not the absolute spelling, and the other way round (Claude Code 2.1.299), so both are written. `Edit(/.cco/**)` in `.claude/settings.local.json` lets the session write task files without a prompt. One real task through `cco` on a real account (haiku) took 3.8 seconds from the first command to the answer, including the start of the dispatch host; the host's parent is the system, not the session's shell.

**Verified against stand-ins only.** Everything else ran against fake CLIs, a stand-in for the editor API and — for the dashboard and Asset Manager pages — headless Chrome with recorded data.

**Not verified — treat these as untested.**

- **Windows and Linux.** Nothing in 2.0 was run there. On Windows, reads that must not follow a symbolic link fall back to a check made before the open, forced stops of session workers are refused (a process's identity cannot be read), the `0700` and `0600` modes have no effect, and the terminal command lines for PowerShell and cmd were built by rule and never run.
- **Interactive behaviour in a real editor window.** Commands, confirmation dialogs, tree hovers, the Asset Manager page inside a webview, and the Korean and Chinese interface text in place were exercised only against the stand-ins above.
- **A session worker on a different account than the orchestrator's**, and so steering across accounts. Addressing it by name depends on mirroring its session entry into your main account; this path is covered by offline tests only, because every worker account on the verification machine was logged out.
- **Session-worker failure paths against the real CLI** — a worker parked without a result, timeout, cancel and failover — were exercised with a fake CLI only.
- **The new model pickers in a real editor window.** They were driven through a stand-in of the editor API only.
- **A usage reading for Antigravity accounts** does not exist (not implemented), and the Cursor and Codex readings were verified against the real vendor services only on 2026-10-14.
- **A second Antigravity login** through a separate home directory.
- **A complete Codex keychain login.** The extension is designed to detect it (through `codex login status`) and dispatch normally, but no complete keychain login was run. Where logins are kept on Linux and Windows is also unchecked — see [Where your logins are stored](#where-your-logins-are-stored).
- **The team proxy agent inside a real native agent team.**
- **Mixed operation with an editor of an earlier version on the same machine.** Reasoned, not measured. Known: a process of an earlier version can break a 2.0 file lock by its own rule; 2.0 notices this when it releases the lock, and re-applies its write or reports it.
- **Claude Code versions other than 2.1.283.**

**Teammate mode — experimental, with these limits.**

- **Isolation is against accidents and against a member's model misusing its tools. It is not a security boundary against a process of your own OS user.** A member that can run shell commands (Claude Code under `bypassPermissions`, Codex, Cursor and Antigravity with their own sandboxes) can read your user's files and speak the dispatch host's socket protocol. Do not run a team on a repository whose content you do not trust.
- **Linux is not verified.** macOS is the tested platform.
- **Take-over is Claude Code only and experimental.** Attaching to a member's conversation interactively is offered for Claude Code members only.
- **Antigravity.** Every Antigravity account is the CLI's default login, because `agy` ignores `AGY_HOME`. An Antigravity account in `plan` mode is refused as a member. Team tools of Antigravity and Cursor members are off unless `teamAgySkipPermissions` or `teamCursorForce` is on, so they run turns-only by default.
- **Members do not see each other's changes while they work**, because each member is on its own branch. A member that needs another member's file reads it from git (`git show cco/<team>/<member>:<path>`), and only after that member's turn has ended, because the checkpoint commit is made at the end of a turn. Say so in the dependent member's brief.
- **A member's worktree is a fresh checkout.** Ignored files such as `node_modules` or build output are not there. If a member must build or run tests, say in its brief how to install or link what it needs.
- **A member's hidden reasoning does not carry over to its next turn on every vendor.** Cursor keeps the visible conversation (messages, answers, tool results) across turns but not the model's private reasoning, so anything a member must remember belongs in its answer or in a file.
- **Some engine counters restart with the dispatch host**: the send rate, and duplicate detection beyond the log window.
- **Not in this release:** failover to another vendor (only failover to another account of the same vendor), a file mailbox, automatic re-attach, and editing a team from the separate Gilde app.
- Nothing is merged automatically.

**Known limits.**

- `cco` does not run on Windows in 2.0 — use the MCP server there. The team proxy agent cannot dispatch on Windows either.
- If Claude Code's sandbox is on, `cco` must be excluded from it. **Update Workspace Setup** does this in the folder's local settings; with an organization-managed sandbox it must go in your user settings. Otherwise `cco` answers with exit code 22 and names the setting. When `cco` itself is refused inside the sandbox, the message tells you to ask the user to run **Update Workspace Setup** and check “Allow cco without a prompt”.
- A task queued in another Claude Code session's dispatch host reads `not_found` until it starts.
- After an extension update, a session's running dispatch host keeps the earlier build until a new Claude Code session starts; `cco` prints one warning line.
- Two Claude Code sessions in one workspace behave as two MCP servers do: the second session's session-worker dispatches run one-shot, with their notice.
- A `registry.json` that is a symbolic link is read through the link, but the first write replaces the link with a regular file.
- Rewriting `.mcp.json` re-serializes it: indentation and line endings become two-space LF, and an integer beyond 2^53 loses precision. A `.mcp.json` that is a symbolic link is not written.
- A write that needs a lock held by a stuck process waits up to 15 seconds — on the editor's UI thread too — and then reports who holds it. The lock's deadline uses the wall clock.
- In the confirmation dialogs for widening values (skipping permission checks, allowing billing, running another `claude` program), Enter activates the confirm button.
- For Codex, Cursor and Antigravity the model that ran is shown only when the dispatch named no model and the CLI itself named one (at the time of writing, Codex). When a model is named, the bundled adapters hand back the requested name, which is no evidence of what ran, so nothing is shown.
- A session worker (`--bg`) records the model it ran, read from its own session transcript; a task whose result was recovered after its server died records it only when exactly one worker session matches.
- Cursor usage needs the `cursor-agent` CLI's own sign-in on this machine (the keychain on macOS). "Same claude.ai account" needs the CLI to name the signed-in address, and the extension compares hashes, so it cannot say which address. Windows and Linux are still not verified.
- A model-list helper that is killed outright cannot stop the CLI it started.
- Updating `CLAUDE.md` replaces the file by name: a hard link to it is broken and extended attributes are not kept.
- "Last ran as" goes by account name and CLI: an account removed and added again under the same name on the same CLI shows what the old one ran.
- A one-shot worker (`claude -p` or another vendor's CLI) is stopped at its time limit only by the process that dispatched it: the dispatch server for an ordinary dispatch, the detach supervisor for a detached one. If that process is killed rather than shut down in order while the worker runs, the worker keeps running with no limit; its task reads `running` for as long as it lives and is settled as orphaned when it exits. Stop it from the Dispatched Tasks view, or by the pid in the task log. Nothing else enforces the limit.
- The task index behind the views and the dashboard is extended in place as the log grows. It does not notice bytes rewritten in place, outside the first 256 and the 64 before its read position, until it is next rebuilt from the start of the log: by a command that refreshes a task view (for example **Toggle Task Scope**, **Clear Task History**, **Cancel Dispatched Task**, **Refresh Account Usage** or **Refresh Team**), or when the log changes more than 10 minutes after the previous full read. Nothing in this project writes the log that way.
- The final round of fixes before this release was checked by its authors' tests, by re-running the earlier adversarial probes on the fixed code, and by the integration gate. It has had no further independent check.
- A very large batch (around 100 tasks with long titles) can still produce more output than Claude Code shows inline; the session then reads the saved output file.

## Trust and privacy

**What runs where.** Everything runs on your machine: the extension in the editor's extension host; the dispatch server as a Node process — the dispatch host that the first `cco` command of your Claude Code session starts from `~/.claude-code-orchestrator/mcp/`, or the MCP server when you register it instead; and each worker as a child process of that server — the vendor's own CLI, under that worker's login, in your workspace.

**No server of ours.** Nothing is proxied, relayed or collected by us, and there is no telemetry. What leaves your machine is what the vendor CLIs send to their own vendors while they work, plus plan-usage readings. For Claude Code accounts the extension reads usage by running the Claude Code CLI. For Codex accounts, when `claudeCodeOrchestrator.providerUsagePolling` is on, the bundled Codex adapter reads the account's `auth.json` token and calls Codex's usage service from this machine — in the dispatch server's own process when `list_workers` runs, in a helper process when the extension refreshes. For Cursor accounts the same setting governs one request to Cursor's usage service, made with the `cursor-agent` CLI's own sign-in. Those usage requests are the only network requests made by this project's own code.

**The opt-out for vendor usage readings.** Turn `claudeCodeOrchestrator.providerUsagePolling` off and those requests stop. The accounts then show "no usage reading", their login state is still checked through the CLI, and dispatch is unaffected.

**Anthropic credentials are not passed to other vendors' CLIs.** Every environment variable whose name starts with `ANTHROPIC_` or `CLAUDE_` (among them `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`), and `CLAUDECODE`, is removed from the environment of every Codex, Cursor and Antigravity process the extension starts, including login terminals. A Claude Code worker does not inherit the variables that identify your own session, nor an OAuth token that belongs to a different account. One thing is passed on to Claude Code workers on purpose: `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` select a key for the whole machine, so if you export either one where your Claude Code session or editor runs, every Claude Code worker runs on that key. Other vendors' CLIs never receive either.

**What is written, and where.**

- `~/.claude-code-orchestrator/` — `registry.json` (worker names, directory paths, default models, the CLI each runs on, and the settings the dispatch server needs — **no tokens, no credentials**), `stats.json` (dispatch counters), `tasks.jsonl` (the task log, with a preview of each prompt), `tasks/` (each task's report and full prompt, and per-task result files), `usage.json` (cached plan-usage readings, which include the e-mail address and plan the CLI reported for each Claude Code account), `orchestrators.json`, `mesh/` (the session-worker ledgers), `mcp/` (a stable copy of the dispatch server, with `cli.js`, the `cco` client), `bin/` (the `cco` launcher, `~/.claude-code-orchestrator/bin/cco`) and `run/` (the sockets, locks and logs of the dispatch hosts). The directory is created `0700` — one made by an earlier version is closed to other users the first time this version writes to it — and the state files, task reports and prompts in it are `0600`; neither mode has any effect on Windows. Activation also writes a one-line forwarding file, `~/.fable-orchestrator/mcp/server.js`, so that registrations made before the rename keep working. Uninstalling the extension leaves all of this; delete both directories to remove every file this project wrote there.
- Your workspace — the policy block in `CLAUDE.md`; `.cco/` (the task files the main session writes, with a `.cco/.gitignore` of `*` and `.cco/out/` for long results; the product never deletes in it); the rules in `.claude/settings.local.json` when you apply that item of **Update Workspace Setup** (at the git repository's root); the `cco-dispatch` entry in `.mcp.json` if you register the MCP server; `.claude/agents/cco-worker.md` if you install it, enabled assets under `.claude/`, and session-worker worktrees under `.claude/worktrees/`. `.mcp.json` is changed only when it parses to a JSON object (a byte-order mark is accepted, an empty file counts as new); otherwise nothing is changed and the message says why. A `CLAUDE.md` that could not be read is not rewritten, and asset sync never writes or deletes through a symbolic link below `.claude`.
- Claude Code config directories — three things. For a worker account with its own directory, the workspace is recorded as trusted in that account's `.claude.json` before its first session worker starts, and the workspace's undecided MCP servers are marked disabled for it. To make a session worker of another account addressable by name, its session entry is copied into your main account's `sessions/` directory, marked as a copy; only files carrying that mark are ever removed again. And the stale-file cleanup described under [Upgrading from 1.x](#upgrading-from-1x) deletes leaked probe files there. Your home-level `~/.claude.json` is never written.

### Where your logins are stored

Signing in is done by each vendor's own CLI, in a terminal the extension opens. The extension never stores a credential, and never sends one anywhere but to the vendor that issued it. Where a login lives is that CLI's decision:

| CLI | Where the login is kept |
|---|---|
| Claude Code | On macOS, the system keychain: the default account under `Claude Code-credentials`, and every other config directory under its own `Claude Code-credentials-<8 hex>` item, derived from the directory path. There is no token file in the config directory on macOS. On Linux and Windows it depends on the platform: the CLI uses that platform's mechanism, or a `.credentials.json` file in the config directory. |
| Cursor | The system keychain. |
| Antigravity | Its app storage, encrypted with a key held in the system keychain. |
| Codex | By default a token **file**, `<CODEX_HOME>/auth.json`, with owner-only permissions. |

**Codex can keep its login in the OS keychain instead.** Put `cli_auth_credentials_store = "keyring"` in `<CODEX_HOME>/config.toml` and log in again. The trade-off: the extension is designed to detect that login (it asks `codex login status`, which does not depend on where the login is kept) and to dispatch normally, but no complete keychain login was run, so that is not verified; and it cannot show a plan-usage figure for that Codex account, because the adapter reads usage with the token from that file. When you add a Codex worker with a separate login, the extension offers this choice only for a folder it creates or finds empty, and creates the one-line `config.toml` exclusively; an existing Codex configuration, a folder that already holds a login, and a folder reached through a symbolic link are never changed.

Apart from the Cursor sign-in described under usage readings (read from the keychain on macOS only to ask Cursor for that account's usage), that file is the one place where code shipped with this extension reads a stored login. The bundled Codex adapter reads `auth.json` to tell whether the account is signed in and, for a usage reading, uses the token in it for one request to Codex's own usage service. Turning `claudeCodeOrchestrator.providerUsagePolling` off stops that request; the file is still read for the login state. When the adapter does not report a login, the extension asks `codex login status` instead, and that answer wins.

These locations were checked on macOS from keychain item names and file existence only — no secret was read. Not verified: a complete Codex keychain login (it needs a browser sign-in), and the storage locations on Linux and Windows.

**Your responsibility.** Using several accounts is subject to each vendor's terms of service and usage policies. **You are responsible for making sure your account setup and usage comply.** Dispatched work spends each worker account's own quota or metered billing.

## Troubleshooting

- **`cco` ends with exit code 22.** The message says why. This shell has no Claude Code session: run the command from the Bash tool of a Claude Code session. It does not run on Windows: use the MCP server there. Claude Code's sandbox is on: the message names the setting to add, `~/.claude-code-orchestrator/bin/cco *` in `sandbox.excludedCommands`; **Update Workspace Setup** does it in the folder's local settings, an organization-managed sandbox needs it in your user settings, and the command must be one simple command, with no pipe, redirection or `cd`. Or the shell belongs to a dispatched worker, which cannot dispatch.
- **`cco: command not found`, or exit code 127.** The launcher is not installed yet. Reopen VS Code, or run **Update Workspace Setup**.
- **`cco: Node.js was not found`.** The full message reads “cco: Node.js was not found (the extension recorded <path>, and no node is on this PATH). Reopen VS Code so it can find Node.js again, or install Node.js 18 or later.” Do as it says.
- **A `cco` call says the dispatch host ended, or a dispatch hangs.** The message names the host's log, `~/.claude-code-orchestrator/run/s<pid>.log`; read it, then read the outcome with `dispatch_status`.
- **`cco: ⚠ this session's dispatch host runs an earlier build`.** The extension was updated while the session was running. Start a new Claude Code session to use the new build; dispatching works in the meantime.
- **The MCP server shows “failed”.** Usually a Node.js path problem in a process started from the GUI. Run **Register Dispatch MCP Server in This Workspace** again; the extension resolves the absolute `node` path through your login shell and writes it into `.mcp.json`.
- **The main account shows as logged out after updating from 1.x.** That was a 1.x defect and is fixed in 2.0; run **Refresh Account Usage** once.
- **A dispatch ran one-shot although Mesh Mode is on.** If its result starts with a ⚠ line, that line names the reason — an older CLI, another window that owns the session workers, or an account that has not trusted the workspace. With no such line, the task was dispatched with `detach: true` or to a worker on another provider, and those always run one-shot.
- **A worker stalls and times out.** Check `workerPermissionMode`: `default` waits for an approval nobody can give. Tasks time out after `claudeCodeOrchestrator.workerTimeoutMinutes` (default 45, range 1–480); one dispatch can override it with `timeout_minutes`.
- **A dispatch asking for `fable` is rejected.** The frontier guard is on by default. Set `frontierWorkerDispatch` to `allow` deliberately if you accept the cost.
- **`invalid model …`.** The value is neither an alias nor a well-formed model id. For a worker on another vendor's CLI, pass that vendor's model id.
- **A Codex dispatch fails with "Not inside a trusted directory".** Codex needs a git repository; dispatch from one.
- **Quota errors on every dispatch.** Check `list_workers`, the Worker Accounts view or the dashboard for cooldowns; with one worker there is no failover.
- **A message says `registry.json` could not be read.** See [The worker registry](#the-worker-registry): nothing was changed. Open the file from the Worker Accounts view or the dashboard, fix the JSON or delete the file, and try again. Deleting it removes your worker list, so keep a copy first.
- **Registering the MCP server reports that nothing was changed.** Your `.mcp.json` is not a JSON object (a comment or a trailing comma makes it invalid), is a symbolic link, or is over 1 MiB. Correct it, then register again.
- **`mesh_status` shows a worker as `unknown`.** Nothing could be checked for it: its account was removed from the registry, or its session registry could not be read. It may still be running and still holds its slot. Run the `claude stop <job id>` command that `mesh_status` names, under that account. Cancelling such a dispatch from the views cancels the task only; the message lists the job ids to stop by hand.

## Limitations and notes

- One-shot workers, and every worker on another provider, edit files in the **same working tree** at the same time. Give overlapping tasks disjoint file-ownership lists. Session workers in a git workspace are isolated in their own worktrees instead, and you merge the branches.
- A session worker's retry after a failed attempt reuses the same task worktree, so one branch can carry the edits of both attempts. Verify the whole diff before merging.
- If a session ends before a clean worktree was removed, `cco-…` worktrees can accumulate under `.claude/worktrees/`; a clean one is safe to remove with `git worktree remove`.
- Session workers record no token or cost numbers in this extension's counters. Each account's live plan usage is unaffected — that is read from the account itself.
- Your main account is not reconfigured: the panel keeps using its own Claude Code login.

## License and trademarks

[MIT](LICENSE) © 2026 Toragonite.

Claude, Claude Code and Anthropic are trademarks of Anthropic, PBC. Codex, Cursor and Antigravity are trademarks of their respective owners. This project is an independent community extension and is not affiliated with, sponsored by or endorsed by any of them.
