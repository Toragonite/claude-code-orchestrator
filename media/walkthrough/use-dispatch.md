# Use it from your Claude Code panel

Chat in the Claude Code panel as usual (pick your main model — e.g. Fable).
For bigger jobs, ask it to fan out:

> "Split this into independent subtasks and dispatch them to the workers in parallel."

Each `dispatch_task` call runs a full Claude Code session under a worker
account in this same workspace. Watch progress in the **Dispatched Tasks**
view — click a task to see its prompt and result.

Tips:

- Add dispatch policy to your `CLAUDE.md` (when to dispatch, which model for
  what) so the main session behaves consistently.
- Use **Open Worker Session in Terminal** to run a worker visibly in a
  terminal when you want to watch and steer it.
- Run **Refresh Account Usage** to re-fetch each account's live plan quota
  shown in the Worker Accounts view (it also auto-refreshes on activation and
  every 5 minutes).
