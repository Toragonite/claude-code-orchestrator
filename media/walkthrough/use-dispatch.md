# Use it from your Claude Code panel

Chat in the Claude Code panel as usual, with whichever main model you prefer.
For bigger jobs, ask it to fan out:

> "Split this into independent subtasks and dispatch them to the workers in parallel."

The session writes each task as files in `.cco/` at the workspace root and runs
a short `~/.claude-code-orchestrator/bin/cco` command, for example
`~/.claude-code-orchestrator/bin/cco dispatch_tasks .cco/batch.json`. Each
dispatched task runs under a worker account in this same workspace. Watch
progress in the **Dispatched Tasks** view — click a task to open its output —
or in the **Orchestrator Dashboard**.

Tips:

- Run **Update Workspace Setup** once per workspace (the previous step). It adds
  the dispatch policy to your `CLAUDE.md` (when to dispatch, which model for
  what), so the main session behaves consistently.
- Ending or interrupting a `cco` command only ends the waiting; the work goes
  on. To stop a task, ask the session to run
  `~/.claude-code-orchestrator/bin/cco cancel <id>`, or use **Cancel
  Dispatched Task** in the Dispatched Tasks view. If a task id is lost,
  `~/.claude-code-orchestrator/bin/cco recent` lists this workspace's latest
  tasks.
- `dispatch_tasks` takes up to 100 tasks and runs 8 at a time unless you raise
  the limit in the registry file; the rest wait their turn.
- Name models by alias — `opus`, `sonnet`, `fable`, `haiku` — or leave the
  model out to use the worker's default.
- A task goes to a Codex, Cursor or Antigravity worker only when you ask for
  it: "dispatch this one with provider codex".
- Use **Open Worker Session in Terminal** to run a worker account visibly in a
  terminal when you want to work with it yourself.
- Run **Refresh Account Usage** to re-read each account's live plan usage; it
  also refreshes on activation and every 5 minutes.
