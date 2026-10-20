# Changelog

All notable changes to **Claude Code Orchestrator** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] — 2026-10-20

### Fixed
- **A team member that re-submits its task in the state it is already in is no longer refused.** `team_update` to the same state (`review` again after a question from the lead, `blocked` again, `claimed` again) now answers `<task> is already <state>; nothing changed.` instead of an `invalid_transition` error, and records nothing: no board change, no report file, no notice to the lead. If the call carried a `report` or a `note`, the answer says it was not recorded and that the member should send it to the lead with `team_send`.
- **`team_end` and `team_status --member` no longer print a `Merge:` command for a branch that is already merged.** A merged branch still shows its Review and Verify lines, and `team_end` still prints its `git worktree remove` line. A branch whose merge state could not be read keeps its `Merge:` line.

### Changed
- **Bundled agent adapters updated to 0.1.4.** Antigravity's usage read now runs in a per-user working directory, so another local user on a shared machine can no longer block it; the other changes are internal.

## [2.0.0] — 2026-10-20

Realigned with Claude Code 2.1.283 and newer. What Claude Code now does by itself is removed; session workers (Mesh Mode) are peer sessions that your own session messages with `SendMessage`; worker accounts can also run on Codex, Cursor and Antigravity; and there is a Team view and a redesigned dashboard. This release also contains the durable dispatch reconcile work that was planned as 1.6.0 and was never released on its own. See *Upgrading from 1.x* in the README for the removed settings and tools and what replaces each.

### Breaking
- **Session workers need Claude Code 2.1.283 or newer** (1.5 needed 2.1.224). On an older CLI every dispatch runs as a one-shot worker and says so on the first line of its result. Update the CLI to keep using session workers.
- **`mesh_send_worker`, `mesh_receive` and `mesh_keep_worker` no longer exist.** A call to one gets the standard unknown-tool error. Message a worker with your session's own `SendMessage`, addressed to the name on the `peer:` line of the dispatch result. If your `CLAUDE.md` carries a 1.x policy block, run **Add Dispatch Policy to CLAUDE.md** once to refresh it.
- **There is no idle auto-stop any more.** A parked worker — its dispatch has finished and it only stays attachable — runs until you stop it, its owning session ends, or Claude Code retires it. Stop the workers you are done with from the Team view, the dashboard or `mesh_stop_worker`.
- **A `model` that is not recognized is rejected** before anything starts, instead of being silently replaced by the worker's default. Use `opus`, `sonnet`, `fable`, `haiku` or a full model id.
- **A session worker's worktree starts from your current HEAD commit.** It sees every commit on the branch you are on and nothing uncommitted, so commit what a worker needs before you dispatch. Before 2.0 a worker could start from the remote default branch.
- **Session workers never run in bypass-permissions mode.** With `workerPermissionMode` set to `bypassPermissions` a session worker starts in `acceptEdits`; one-shot workers are unaffected.
- **A session worker that ends its turn without writing its result fails the dispatch** and reports an attach command. It is no longer nudged after a silence. Attach to see what it was waiting for.
- **Settings are read from your User settings only.** Every setting is machine-scoped. A value in a workspace's or a folder's settings (`.vscode/settings.json`, a `.code-workspace` file) is ignored and reported once at activation, naming the keys. Move any setting you kept there into your User settings.
- **Dispatch arguments are checked before anything runs, and invalid ones are refused.** A `detach` or `ultrathink` that is not exactly `true` or `false` (the string `"true"` and the number `1` are refused, not read as true), an empty `prompt`, a NUL character, a `prompt` over 1 MiB, a `system_prompt` over 256 KiB and more than 100 tasks in one `dispatch_tasks` call are errors. One malformed task refuses the whole batch, and none of its tasks runs.
- **A dispatch started by an earlier build whose dispatch server then died is no longer completed automatically.** It is settled as an error with a note, and its result file is kept for 24 hours.

### Added
- **Dispatch without MCP: the `cco` command.** The main session runs `~/.claude-code-orchestrator/bin/cco <operation>` through its own Bash tool. The operations are the MCP tool names — `orchestrator_briefing`, `list_workers`, `dispatch_task`, `dispatch_tasks`, `dispatch_status`, `mesh_status`, `mesh_stop_worker` — plus `cancel <id>…`, which stops tasks, and `recent [--limit n]`, which lists this workspace's latest tasks for ids that were lost. `~/.claude-code-orchestrator/bin/cco help` lists them. A task is handed over as files in `.cco/` (a small JSON file and the prompt in its own file), never as text on a command line; `.cco/` gets a `.gitignore` of `*` on first use, and a result over 28,000 characters is saved whole in `.cco/out/`. `--wait <seconds>` and `--no-wait` set how long a dispatch waits. Exit codes: 0 answered, 20 the operation answered with an error, 21 the command or a task file is wrong, 22 `cco` cannot run here (the message says why), 23 `--wait` ran out, 24 the waiting was interrupted; in the last two the work goes on.
- **A dispatch host per Claude Code session.** The first `cco` command of a session starts a background Node process that runs the dispatch server code; later commands reach it over a private socket in `~/.claude-code-orchestrator/run/`. It ends by itself with its session and stops that session's workers, as the MCP server does. Its log is `~/.claude-code-orchestrator/run/s<pid>.log`.
- **Update Workspace Setup** (`claudeCodeOrchestrator.updateWorkspaceSetup`; the Command Palette, and the dashboard's setup button, onboarding step and "policy outdated" chip). One checklist, each item with its state, applying only what you check: add or update the dispatch policy in `CLAUDE.md`; add or update the team proxy agent `.claude/agents/cco-worker.md` (never overwriting a file that is not ours); let `cco` run without permission prompts, with rules in `.claude/settings.local.json` (at the git repository's root) and in `sandbox.excludedCommands`; and remove the `cco-dispatch` MCP server from `.mcp.json` (unchecked by default, offered once the policy is current). A settings file that cannot be parsed is never rewritten.
- **The extension installs the `cco` launcher** at `~/.claude-code-orchestrator/bin/cco` (macOS and Linux) and keeps it current at each activation. It runs the Node.js the extension found, or `node` from `PATH`, and keeps working in a terminal Claude Code session with the editor closed.
- **A dispatched worker cannot dispatch.** `cco` refuses inside a worker, and the MCP server's `dispatch_task`, `dispatch_tasks`, `mesh_stop_worker` and `orchestrator_briefing` answer an error there; `list_workers`, `dispatch_status` and `mesh_status` still answer.
- **Cursor accounts show their plan usage** for the billing period (Total usage, Auto + Composer, API usage, each with the period's end). On macOS the extension reads the `cursor-agent` CLI's keychain item `cursor-access-token` through `/usr/bin/security`, only to ask Cursor for that account's own usage; elsewhere it reads the CLI's sign-in file. If you deny the macOS prompt, it is not asked again for 6 hours. `providerUsagePolling` governs it. Antigravity accounts still show no usage reading.
- **Accounts that are the same claude.ai account** (two Claude Code config folders signed in to one account, the editor session's own included) are named as such on the dashboard, in the Worker Accounts view and in `list_workers`, because they draw on one plan's limits. Dispatch is not changed; only a hash of the address is kept.
- **`list_workers` shows what each Claude Code account's aliases mean on its CLI** ("aliases on this CLI: opus = Opus 5.5 · …").
- **Session workers record the model they ran**, read from the worker's own session transcript.
- **Worker accounts on other providers.** A worker can run on Codex (`codex`), Cursor (`cursor-agent`) or Antigravity (`agy`). **Add Worker Account** now starts by asking which CLI the account runs on. These workers are opt-in per dispatch: a task reaches one only when the dispatch passes `provider` (`codex`, `cursor`, `gemini`) or names it with `worker`. They always run one-shot, edit the working tree in place, cannot be attached to or steered, and take that vendor's own model ids. Codex needs a git repository.
- **A `provider` argument** on `dispatch_task` and `dispatch_tasks`. Leave it out and a task only ever runs on a Claude Code worker.
- **Team view.** A new sidebar view lists the live sessions of this workspace across accounts — the session workers you dispatched, the members of native Claude Code agent teams, and other sessions of your accounts — grouped as Working, Waiting and Parked, with attach, logs, result-branch diff, copy name and stop on a row.
- **Team proxy agent.** **Install Team Proxy Agent in This Workspace** writes a `cco-worker` subagent to `.claude/agents/cco-worker.md`, so that a native agent team can include a worker that runs on another account. It never overwrites a different agent at that path.
- **Steering with Claude Code's own `SendMessage`.** The dispatch result of a session worker carries a `peer:` line with the worker's name, and `mesh_status` shows it per worker.
- **Model aliases.** `model` accepts `opus`, `sonnet`, `fable` and `haiku` — each resolved by Claude Code to the newest model of its family — or a full model id. Worker defaults are stored as aliases.
- **Set Default Model** and, for a worker on another provider, **Set Permission Mode** on a worker account.
- **Two more permission modes** for `claudeCodeOrchestrator.workerPermissionMode`: `auto` and `dontAsk`.
- **`claudeCodeOrchestrator.providerUsagePolling`** (default `true`). Turn it off to stop the extension from asking other vendors for a plan-usage reading.
- **Usage readings for other providers**, shown whenever the provider's adapter returns one. With the adapters in this release that is Codex.
- **Codex workers can keep their login in the system keychain.** Login detection no longer depends on Codex's token file: when the adapter does not report a login, the extension asks `codex login status`. When you add a Codex worker with a separate login, the extension offers the choice only for a folder it creates or finds empty and creates the one-line `config.toml` exclusively; an existing Codex configuration, a folder that already holds a login and a folder reached through a symbolic link are never changed. Detecting a login kept in the keychain is designed but was not verified end to end, and no plan-usage figure can be shown for such an account.
- **Clean Up Stale Session Files**, **Open Extension Settings**, **Refresh Team** and **Reset Main-Session Check-in for This Workspace** as commands.
- **You can see which model actually ran.** The first line of a result reads `[worker: wa, model: haiku → claude-haiku-4-5-20251001]` when the CLI reported a model that differs from the text asked for. The task report records `model ran` and `model source` (named by the dispatch, worker default, or CLI default). `list_workers` shows `default model haiku (last ran as …)`, `dispatch_status` returns `modelSource` and `modelUsed`, the dashboard shows "default haiku · last ran …" on an account card and `opus → …` in a task row, and the Worker Accounts view has a **Default model** row per account.
- **Model pickers.** For a Claude Code account **Set Default Model** lists what the account's own CLI offers: the aliases with what they mean on that CLI, then the older models it still offers, and **Enter a model id…**. For Codex it lists the CLI's current models with the default marked and each model's reasoning efforts. For Codex, Cursor and Antigravity it asks the CLI for its current model list where the CLI can give one, shows the vendor's own models first, and lists models of other vendors that the CLI resells after a separator, each marked as billed through this provider's account. If the CLI cannot list, built-in suggestions are shown with a note; **Let the CLI choose** and **Enter another model id…** remain.
- **Update the dispatch policy** appears in the dashboard's setup area when the `CLAUDE.md` of a workspace holds a policy block from another version or a changed one. **Add Dispatch Policy to CLAUDE.md** asks before replacing such a block, replaces only the text between the policy's markers, leaves a current block alone, saying it is current, and counts a block that a markdown formatter re-spaced as current. The offer after **Register MCP Server** asks before replacing a block that is not this version's, as the command does.
- **`maxConcurrentDispatches`**, a key of `registry.json` (a whole number from 1 to 64, default 8): how many one-shot, vendor and detached dispatches one dispatch server runs at a time. The rest wait in order, and `list_workers` shows how many. It is edited in the file; there is no VS Code setting for it. Session workers keep their own cap, `meshMaxLiveWorkers`.
- **Remove Registry Entry…** on the row of a registry entry this version cannot use deletes it after a confirmation.
- **`dispatch_status` takes up to 100 ids** in one call, and when the task log cannot be read it fails with a message that the status is UNKNOWN instead of reporting the tasks as not found.
- **A task result over 1 MiB is cut** in the tool result, ending with a line that names the task's report file, which holds all of it.
- **Teammate mode (experimental, off by default).** A live team of coding agents across vendors and accounts — Claude Code, Codex, Cursor and Antigravity — led by your own Claude Code session. Turn it on with **Turn On Teammate Mode (Experimental)** (a warning, then `claudeCodeOrchestrator.teamMode` in your User settings) or **Turn Off Teammate Mode**. The lead runs `cco team_create <team file>`, `team_add`, `team_send`, `team_inbox`, `team_wait` (run in the background; it exits when a teammate needs the lead), `team_status`, `team_task`, `team_member`, `team_attach`, `team_end` and `team_resume`; `cco help` lists the flags. Each member works in its own git worktree under `~/.claude-code-orchestrator/worktrees/`, on its own branch `cco/<team>/<member>` based on your HEAD (or the team file's `base`); each turn is a headless run of that vendor's CLI resumed in the member's own conversation, followed by a checkpoint commit on the member's branch. Members message each other and update the task board through team tools; a member whose vendor cannot use them runs turns-only. Nothing is merged automatically: you review each branch and merge it, and ending a team never deletes a branch or a worktree that holds work. The Team view shows the roster, board, activity and messages, with 21 team commands (message, interrupt, pause, stop, restart, take over, show changes, copy the branch or merge command, add, assign and finish tasks, end the team). With them and the two commands that turn the mode on and off, the extension contributes 62 commands.
- **Eight team settings**, all machine-scoped: `teamMode` (default `false`), `teamMaxMembers` (6, 1 to 8), `teamMaxRunningTurns` (4, 1 to 16), `teamTurnTimeoutMinutes` (not set: the value of `workerTimeoutMinutes`; 5 to 240), `teamTurnsPerMemberPerHour` (20, 1 to 240), `teamTurnsPerDay` (300, 10 to 5000), `teamCursorForce` and `teamAgySkipPermissions` (both `false`). The last two decide whether Cursor and Antigravity teammates run with their permission checks skipped, which their team tools need; off, they run turns-only. With them the extension contributes 21 settings.
- **Teammate mode limits.** Isolation is against accidents and a member's model misusing its tools, not against a process of your own OS user: a member that can run shell commands can read your user's files and speak the dispatch host's socket protocol, so do not run a team on a repository you do not trust. Linux is not verified. Take-over of a member's conversation is Claude Code only and experimental. Every Antigravity account is the CLI's default login, and an Antigravity account in `plan` mode is refused as a member. Failover to another vendor, a file mailbox, automatic re-attach and editing from the separate Gilde app are not in this release. See *What is experimental or not verified* in the README.

### Changed
- **Setup order: Add Worker Account, then Update Workspace Setup, then chat.** Registering the MCP server is optional now; **Register Dispatch MCP Server in This Workspace** stays, and on Windows it is still the way to dispatch. A folder that cannot dispatch is offered Update Workspace Setup instead of MCP registration. A folder can dispatch when the `cco` launcher is installed and the folder's policy is current, or when it registered the MCP server. The walkthrough step that registered the MCP server now sets up the workspace.
- **Stopping a dispatch depends on how it ran.** With `cco`, ending or interrupting the command only ends the waiting: the work goes on and `dispatch_status` reads it; `~/.claude-code-orchestrator/bin/cco cancel <id>` or the task list in VS Code stops it. With the MCP tools, cancelling the request still stops the dispatch.
- **The team proxy agent dispatches with `cco`** (tools Bash and Write), waits in the foreground up to 9 minutes per call and keeps waiting with `dispatch_status --wait`. It needs no MCP server and cannot dispatch on Windows.
- **The dispatch policy in `CLAUDE.md` teaches the `cco` command**; run Update Workspace Setup once per workspace to get the new text.
- **While the frontier guard blocks `fable`, an account whose default model is `fable` is skipped** by a dispatch that names no model, and the task runs on the next account; before, that dispatch failed. A dispatch that names that account, or names `fable`, is refused as before. `list_workers`, the model picker and the account's Default model row say so.
- **"Last ran as" is the task's own model.** When a task starts subagents on other models, the model shown is the one the task ran on, not the most expensive one in the run; when that cannot be told, nothing is shown.
- **`list_workers` reads a large task log once per change of the file** instead of on every call.
- **The dispatch policy names models by alias and omits `model` by default**, so a task runs on its worker's default model; it names `sonnet` for documentation and simple transforms.
- **Which model an alias means is decided by the Claude Code version installed for that account.** Update that CLI to get a newer model for the same alias; "last ran" shows the result.
- **The dashboard's Accounts heading counts every account once** and the parts add up to the total ("4 ready · 2 at a limit · 1 check failed"); zero parts are left out. A signed-in account that can take a dispatch but has no usage reading counts as ready.
- **The Errors row of an expanded account ends long text with "…"**; the hover has the whole text.
- **`list_workers` labels the usage windows of Codex "Primary limit" and "Secondary limit"** instead of `primary` and `secondary`.
- **The dashboard is redesigned.** It now shows one card per account with usage gauges and reset countdowns, a three-lane Team board (Working, Waiting on you, Parked), an Activity list that tells running, done, failed, cancelled and orphaned tasks apart, and a settings drawer. It is served under a strict Content Security Policy and follows the editor's theme.
- **`claudeCodeOrchestrator.meshMaxLiveWorkers` counts only dispatches still in flight.** Parked workers no longer use up the cap. A dispatch past the cap is still refused with a `worker_cap` error, not queued.
- **The Worker Accounts view lists accounts only.** Live session workers moved to the Team view, and each account row names the CLI it runs on.
- **`mesh_status` reports dispatches in flight and parked workers**, each worker's permission mode, and how to message it. It no longer has relay, live-feed, idle-timer or keep-alive lines.
- **`mesh_stop_worker` takes a `job_id`.** Worker names are reused, so a name that matches several workers is refused with the job ids it matched.
- **`list_workers`, the frontier guard and the dispatch policy name models by alias** (`opus`, `sonnet`, `fable`). The three dated ids of 1.x — `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5` — are still accepted and read as their alias.
- **An account that has not trusted the workspace gets that one task run as a one-shot worker**, with a line that names the account and what to run. The extension never writes your home-level `~/.claude.json`.
- **Clear Task History asks for confirmation** and says how many dispatches are still running.
- **`dispatch_tasks` is bounded.** It takes 1 to 100 tasks and runs at most `maxConcurrentDispatches` one-shot, vendor and detached tasks at a time (default 8); the rest wait their turn. With Mesh Mode on, the session-worker cap applies instead, and a dispatch past it is refused.
- **Accounts of other vendors' CLIs are stored under a second top-level key of `registry.json`, `vendorWorkers`.** `workers` holds Claude Code accounts only. An editor of an earlier version that shares the file never sees a vendor account as a Claude Code account, and it keeps the key.
- **A registry entry this version cannot use is kept and shown.** An unknown provider, an incomplete entry, a duplicate name or no name: the entry stays in the file untouched, takes part in nothing, and is listed in the Worker Accounts view and on the dashboard. An unknown `provider` used to be read as a Claude Code account.
- **`claudePath` must be a command name or an absolute path.** Anything else is not used (the default `claude` is, and a warning says so).
- **Quota detection is stricter.** A status code counts only in a status context (`status 429`, `HTTP 529`, `"code": 429`); stack traces, paths, URLs and quoted identifiers are ignored; "limit reached" and "limit exceeded" count only for account allowances, not for `context limit exceeded`; and a spawn failure, a timeout or an output overflow is never a quota failure. It also recognises "out of extra usage" and "limit has been reached", and a double-quoted identifier (`Unknown field "quota" in settings.json`) and the result lines of a test runner are no longer read as quota.
- **A vendor account whose run failed on login is skipped** by automatic dispatch for up to 30 minutes, until a run succeeds or you sign in again from the extension, because that CLI's own status command can still report it as logged in.
- **A one-shot worker whose output passes 8 MiB is ended**, and the dispatch fails with an ordinary error.
- **Task reports and prompt files are written by replacing the name** (a temporary file and a rename), notes are appended without following a link, and `tasks/<id>.md` is opened by task id only, never by a path read from the task log. Reports are now `0600`, and the data directory is created `0700`.
- **The Dispatched Tasks view lists the newest 300 tasks** and ends with a row that opens the dashboard for older ones. Hovers are built on demand and the task log is indexed incrementally, so a refresh with nothing new costs one `stat`. A command that refreshes a task view (**Toggle Task Scope**, **Clear Task History**, **Cancel Dispatched Task**, **Refresh Account Usage**, **Refresh Team**) rebuilds the index from the start of the log, and the index is also rebuilt, at most every 10 minutes, when the log changed.
- **A task event dated more than 5 minutes in the future is not placed by that date.** The task is still counted and can still be opened and cancelled; it is listed after the dated tasks, is in no 5-hour, 7-day or daily figure, and its hover says it started at an unknown time.
- **A Mesh Mode change applies at the next dispatch**, and the dashboard's Session workers hint now says so; it no longer points to the next Claude Code session.
- **The extension no longer waits for your login shell at start-up.** The path of `claude` is resolved in the background, and only when the `claudePath` setting changed or the stored path stopped working. The sweeps that read the whole task log run after activation has returned.
- **Worker names follow one rule everywhere**: letters, digits, `_` and `-`, at most 64 characters, not `main`, and not a name every plain object already has. **Import Existing Claude Config Directories** offers only a real directory in your home directory — never a symbolic link — that looks like a Claude Code config directory (it holds a `.claude.json` or `.credentials.json` file, or a `sessions/` or `projects/` directory), and it asks for a name when the directory's own name does not fit the rule.
- **The publish build starts from an empty output directory**, and compiled modules that only the server bundles use are no longer shipped.
- **An unreadable task log is shown as such** in the views, never as "no tasks", and the session keep-alive sweep is skipped while the log cannot be read.
- **On the dashboard, resetting the main-session check-in and stopping a session are single clicks** that the editor confirms in a dialog. A setting that needs a confirmation shows "waiting for your answer" instead of timing out.
- **The Asset Manager page is served under a strict Content Security Policy**, like the dashboard: a nonce'd script and style, and no inline handlers.
- **An asset ledger that cannot be read is reported and left as it is.** If `.claude/cco-assets.json` is damaged, not JSON, not a regular file or over 8 MiB, sync and the Asset Manager change nothing and offer to open the file. It is no longer moved aside to `cco-assets.json.corrupt`.

### Fixed
- **Codex accounts now show their plan usage** (5-hour and weekly windows). The vendor's usage answer was read in an older shape and never showed.
- **A session worker writes its result even when its task says not to create files or use tools**; two such workers had obeyed and their results were lost.
- **Add Dispatch Policy and Register MCP Server no longer rewrite a file that does not read back byte for byte.** A `CLAUDE.md` or `.mcp.json` that is not valid UTF-8 text (saved as Latin-1, EUC-KR or UTF-16, say) used to come back with characters replaced, a UTF-16 file unusable; now the command says so and changes nothing. A file its owner cannot write is not replaced either. (This was also true of 1.5.x.)
- **A policy marker counts only on a line of its own and outside a code block.** Quoting the markers in text or showing them in a code example is no longer a policy block. After an add or update the file holds exactly one policy block (duplicates and markers that lost their partner are removed), your text is never changed, and the block is written in the file's own line endings.
- **Cancelling is recorded when it is asked for, and a task is finished exactly once.** A worker that completes just after a cancel no longer leaves the task looking both done and cancelled; its result carries a note that the log records the cancel.
- **Cancelling a session-worker dispatch while it waits for its turn to start no longer starts the worker anyway** (also for MCP).
- **A failed dispatch records the model it ran on** instead of `-`.
- **A model chosen as a full id is pinned exactly**, from the list or typed, including `claude-opus-4-8`, `claude-sonnet-5` and `claude-fable-5`, which 1.x read as tiers; an alias follows the newest model of its family. In a dispatch argument those three ids still mean their tier. `constructor` and `__proto__` are refused as model values.
- **An account is never shown what another account of a different CLI with the same name ran**; the dashboard, the Worker Accounts view, the pickers and `list_workers` give the same answer.
- **Names a vendor CLI prints for its models are shown as text in pickers**; `$(…)` is no longer drawn as an icon.
- **Stopping the model-list helper also stops the vendor CLI it started.**
- **Add Dispatch Policy no longer damages a `CLAUDE.md`.** With a stray end marker before the policy block, the old block stayed and a piece of your text was written twice; with a start marker that had lost its end marker, your text between it and a later block was deleted. Now only complete marked blocks are replaced, text outside them is never changed, and a second copy of the block is removed.
- **The model list offered for a Claude Code account lacked `haiku`.**
- **The main account no longer reads as logged out.** 1.x passed the default config directory to the CLI explicitly, which current Claude Code treats as a different login.
- **Usage polling no longer leaves session files behind.** Every reading used to leak two files into the account's `sessions/` directory — tens of thousands per account over time, enough to make Claude Code's own session listing take more than 30 seconds. The probe now ends cleanly, and a background pass (15 seconds after startup, at most once a day, or on demand with **Clean Up Stale Session Files**) removes what earlier versions left. It deletes only files whose process is provably gone, and tells you once.
- **Workers no longer inherit the orchestrator session's identity variables**, and a worker on another account no longer inherits an OAuth token that belongs to the orchestrator's account.
- **`detach: true` works from the installed extension.** The supervisor script it needs is now deployed next to the dispatch server.
- **Stats and registry updates are no longer lost when several dispatches finish at the same moment.** The file lock could let one process remove another's live lock.
- **A worker cannot be given a name such as `constructor` or `__proto__`**, which broke the counters of that worker.
- **A task whose session died is no longer left "running" forever.** On the next start it is completed from the result its worker recorded, or marked orphaned when there is none.
- **History retention and the orphan sweep no longer treat a live session worker as gone.** They take liveness from Claude Code's own listing by job id, and keep a record whose liveness cannot be established.
- **A damaged or hostile file in the data directory can no longer hang the extension at startup or forge a line in a view.** Files are read without blocking and with a size cap, and names, titles and paths are flattened before they are displayed.
- **A registry file that cannot be read is no longer replaced by an empty one.** Invalid JSON, a file that is not an object, a `workers` or `vendorWorkers` value that is not a list, a file over 1 MiB and something that is not a regular file used to be overwritten silently. Now every change is refused with a message that names the file; the Worker Accounts view and the dashboard report it with an **Open File** action; `list_workers` and `dispatch_task` answer with the problem instead of "no workers". A UTF-8 byte-order mark is accepted.
- **Renaming a worker is all-or-nothing** across the task log, the statistics and the registry.
- **Register MCP Server no longer wipes your other MCP servers.** It used to treat a `.mcp.json` that was not strict JSON (a comment, a trailing comma, merge-conflict markers) as empty and rewrite it. It now changes the file only when it parses to an object (a byte-order mark is accepted, an empty file counts as new) and otherwise changes nothing and says why. **Add Dispatch Policy to CLAUDE.md** does not rewrite a `CLAUDE.md` it could not read, **Install Team Proxy Agent** asks before replacing a copy of its definition that differs, and asset sync does not write or delete through a symbolic link below `.claude`.
- **A dispatch server that hits an unexpected internal error shuts down in order** — its in-process workers are stopped, the session workers it owns are stopped, detached supervisors are left running — instead of dying with workers still running. SIGHUP is handled like SIGTERM.
- **Two dispatch servers starting at once over a dead owner's marker can no longer both become the session-worker owner of a workspace.**
- **Ending a session stops every session worker its dispatch server started**, including when the registry cannot be read at that moment and when the worker's account was removed in the meantime. A worker whose account is not configured reads `unknown` — never `dead` — in `mesh_status`, with the `claude stop` command to run by hand under that account. Its record is dropped from the ledger 24 hours after its time ran out, unless a worktree of it is still on disk or its owner is alive, and only after a successful registry read.
- **A one-shot worker that finished successfully is recorded as successful** even when the dispatching process was suspended past the time limit (a machine that slept or stalled). A clean exit with a result is never reported as a timeout.
- **After a dispatch server crashes, the next server settles the stopped workers' tasks right after its start-up sweep.** They used to read `running` for up to 10 minutes.
- **Keep-alive pings an account only after its claim is recorded on disk.** A data directory that could not be written used to cause a request to every account every hour.

### Security
- **A workspace can no longer change what the extension runs or spends.** Settings are machine-scoped and read from your User settings only, so a repository's `.vscode/settings.json` cannot repoint the `claude` executable, switch workers to `bypassPermissions` or turn the billing guards off.
- **Widening a setting asks first.** Storing `bypassPermissions`, `allow` for either billing guard, or a `claudePath` other than `claude` from the dashboard or a command asks for confirmation in a modal dialog. A value you type into the Settings editor yourself is not asked about.
- **Terminal command lines are built by one quoting function** for the shell the editor uses. A value that cannot be written safely for that shell is not typed at all, and an error says so.
- **A result file must carry a per-task token.** This applies to a detached task and to a session worker. The token is never on a command line and never in the task log, which keeps only its SHA-256; for a session worker it is the first line of the task file in that task's own directory. It stops a result written for another task, by another user's process, or forged from the task log. It does not stop a process that runs as your own user and reads the task file: nothing on disk can.
- **A forced stop signals a process only after confirming it is the worker**: its command line must name the CLI, and it must not have started after the session entry it was found under. Otherwise nothing is signalled and the stop reports `not stopped: could not confirm pid <n> is the worker` (`stop_failed`).
- **Session entries, the ledger, transcripts and result files are not read through symbolic links.**
- **The data directory is created `0700`** and the state files, task reports and prompts in it are `0600`. A directory made by an earlier version is closed to other users the first time this version writes to it. Neither mode has any effect on Windows.
- **A registry entry of an unknown provider is no longer read as a Claude Code account**, so neither `claude` nor the stale-file cleanup is aimed at another vendor's directory.
- **The copies of the dispatch server that the extension keeps in the data directory, and the forwarding file at the pre-2.0 path, are written by replacing the name and only when their content changed.** A symbolic link or a pipe planted at those names can no longer hang the editor or redirect the write.
- **Tree rows act on the account they show.** An `id` or `kind` key inside a registry entry is never used to choose the target of a command.
- **Cancel signals a process group only when the recorded group id equals the recorded process id.**
- **Asset sync can no longer be stalled or redirected by what sits at an install path.** Files are read without blocking and without following a link, and written by replacing the name. A symbolic link, a directory, a pipe or a file over 16 MiB at an install path is never read as content and never written, not even by a reset; that file is listed as not synced, with the reason, and the rest of the sync goes on.
- **The task log refuses an event whose id could not name a task file** (1 to 128 letters, digits, `_` or `-`).

### Removed
- **The relay "gateway" session** and its `claudeCodeOrchestrator.meshGatewayModel` setting. On Claude Code 2.1.283 and newer the IDE panel session is a messaging peer itself.
- **The `mesh_send_worker`, `mesh_receive` and `mesh_keep_worker` tools**, and keep-alive marks.
- **The idle auto-stop** and its `claudeCodeOrchestrator.meshWorkerIdleTimeoutMin` setting.
- **The "Attachable workers" group** in the Worker Accounts view and its attach, logs and stop commands. The Team view replaces them.
- **Progress notes and questions pushed by workers.** A worker that reaches an open decision makes an assumption and records it in its report; ask it for a status with `SendMessage`.

### Notes
- `cco` does not run on Windows in 2.0; use the MCP server there. If Claude Code's sandbox is on, `cco` must be excluded from it (Update Workspace Setup does this in the folder's local settings; an organization-managed sandbox needs it in user settings), or it answers with exit code 22 naming the setting. A task queued in another session's dispatch host reads `not_found` until it starts. After an extension update a session's running host keeps the earlier build until a new Claude Code session, and `cco` prints one warning line. Verified live on 2026-10-15: a permission rule spelled with `~` matches only the command typed with `~` (so both spellings are written), `Edit(/.cco/**)` lets the session write task files without a prompt, and one real task through `cco` took 3.8 seconds from the first command to the answer.
- Session workers, the Team view's listing of native agent teams and the team proxy agent are experimental. The README section *What is experimental or not verified* lists what was and was not checked for this release: among others, a session worker on a different account than the orchestrator's, a successful Cursor dispatch, and any usage reading from another vendor were not verified live.

## [1.5.3] — 2026-08-20

`mesh_status` now reports background workers that are still ALIVE while this workspace's ledger has lost track of them — including the ones nothing will ever reap. Second of the three-way split that began with 1.5.2. With Mesh Mode **off**, dispatch is unchanged (`src/mcp/task-runner.ts` untouched).

### Added
- **Unowned-worker visibility in `mesh_status`.** When a ledger record has no living recorded owner, the extension asks `claude agents` — under that record's own account config dir — whether the worker is still alive, and reports what it finds in four separately-headed classes, because what is KNOWN about each differs: **adoptable orphans** (a recorded owner that is not running, worker alive); **ghosts** (the same, but the ledger already marks the record stopped — so every sweep skips it and nothing will ever reap it); **unowned in the ledger** (no owner recorded at all, which is also what adopting a worker at startup produces, so it may be one this session itself adopted); and **not checkable** (records that can never be matched against a listing). Liveness is proven by a live process id in the listing, never by a row merely being present — a background row is emitted for a worker killed abruptly, so presence alone would have reported every crash victim as running.
- **Orphan-handling doctrine** for the orchestrator: read the report at session start and before teardown; a worker alive with no living owner is yours to adopt or stop; mark keep-alive *first* if you intend to adopt; a ghost cannot be steered; and absence from the report is not proof a worker is gone, because retention deletes a stopped record while its session may still be running.

### Changed
- **`mesh_status` is descriptive by contract.** It reports what it observed and what it could not observe, and never recommends stopping a worker or presents a destructive action as the next step — action policy lives in the orchestrator doctrine. Misreading a status line should cost a wrong line, not somebody's running work. For the same reason it makes no predictions about what the idle sweep will do: that clock is refreshed by any message from the worker, so a worker that is still reporting may never be swept.
- **Every config dir the probe touches now comes from your configured accounts**, never from the ledger. `claude agents --json` writes to the config dir it targets (it rewrites `.claude.json` and creates `backups/`), so the target set is restricted to the accounts in the registry; anything else is reported as unchecked rather than probed. The probe never runs when no record qualifies, is bounded per config dir and by an overall budget, is capped at eight config dirs per call, and reports every dir it could not check — separately, per dir, so one failure can never render as "clean".
- **Worker names, paths and attach commands are flattened before display** in both the new report and the existing worker list: control, bidi and zero-width characters become spaces and over-long values are truncated with a count, so a ledger value cannot forge a section header or make two different workers render identically. An attach command whose config dir or job id would not survive that flattening intact is withheld with a reason rather than printed, because the command is single-quoted but not escaped.

### Notes
- Experimental Mesh Mode; mesh-off dispatch is byte-identical to 1.5.2.
- This release makes the problem VISIBLE; it does not repair the sweep that causes it. The session-end reaper still judges a background worker's liveness by a name lookup and a process id, neither of which is valid for a background worker, which is how a live worker comes to be marked stopped and then skipped forever. That fix, along with durable dispatch reconcile, is the third release of the split.
- Stopping a worker still resolves by NAME, and worker names are reused across generations, so a name can match a different record than the one displayed. The report identifies workers by job id; confirm a name matches exactly one record before acting on it.

## [1.5.2] — 2026-08-19

Worktree durability + ghost cleanup, driven by real 1.5.1 usage. A mesh worker's edits are now committed to its branch when the dispatch settles — so they survive as a mergeable commit instead of being discarded — and stale "kept worktree" records no longer haunt the history view. With Mesh Mode **off**, dispatch is unchanged (`src/mcp/task-runner.ts` untouched). First of a split; orphan visibility and a durable dispatch-reconcile engine follow in later releases.

### Fixed
- **A mesh worker's work is no longer silently reverted.** Workers run in a git worktree but are spawned without Bash and told not to run git, so they left uncommitted changes on a branch with zero commits — the orchestrator's "merge the branch" then found nothing, and force-removing the dirty worktree discarded the work (observed in real use). The extension now AUTO-COMMITS the worktree to its branch when the dispatch settles (best-effort — commit hooks and GPG signing are bypassed and a git identity is guaranteed, so a repo's hooks or an unset identity can't silently defeat it; strictly contained to the worktree, never the workspace root; and it can never throw into or fail the dispatch). The work becomes a durable, mergeable commit, and the dispatch result names the branch and short sha. The error path commits too, to preserve partial work.
- **Stale "kept worktree" records no longer show a false warning and can be cleared.** `keptWorktree` now trusts only whether the worktree ACTUALLY EXISTS on disk, not the `worktreeKept` flag, which went stale once a worktree was removed — so a removed worktree's record is clearable and cap-prunable again, and the Worker History badge (now "unmerged branch") reflects disk truth instead of a permanent false "uncommitted branch".

### Changed
- The Mesh Mode doctrine now tells the orchestrator that a worker's edits arrive as an auto-committed branch: integrate by MERGING THE BRANCH (the result names it), and never force-remove a worktree before merging.

### Notes
- Experimental Mesh Mode; mesh-off dispatch is byte-identical to 1.5.1.

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
