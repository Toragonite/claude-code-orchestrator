# Use it from your Claude Code panel

Chat in the Claude Code panel as usual (pick your main model — e.g. Fable).
For bigger jobs, ask it to fan out:

> "이 작업을 독립적인 서브태스크로 나눠서 워커들에게 dispatch해서 병렬로 진행해줘."

Each `dispatch_task` call runs a full Claude Code session under a worker
account in this same workspace. Watch progress in the **Dispatched Tasks**
view — click a task to see its prompt and result.

Tips:

- Add dispatch policy to your `CLAUDE.md` (when to dispatch, which model for
  what) so the main session behaves consistently.
- Use **Open Interactive Worker Session** to run a worker visibly in a
  terminal when you want to watch and steer it.
