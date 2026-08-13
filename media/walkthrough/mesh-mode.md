# Mesh Mode (experimental)

Mesh Mode does not add a second workflow — it changes what a dispatch is. With it
on, each dispatched worker becomes a persistent `claude --bg` session you can
attach a terminal to, working in **its own git worktree**. Same `dispatch_task` /
`dispatch_tasks`, same results, timeouts, cancellation and failover.

Needs **Claude Code >= 2.1.224** on **macOS or Linux**. Off by default; with it
off, dispatch is unchanged.

Try it:

1. Turn on **`claudeCodeOrchestrator.meshMode`** (or use the dashboard's Settings
   card), then restart the Claude Code session in this workspace.
2. Dispatch a task as usual. In a git workspace the result names a worktree
   (`.claude/worktrees/cco-<taskId>`) and its branch — verify there, merge what
   passes, then remove the worktree and stop the worker.
3. While it works, ask your session to poll `mesh_receive` for progress notes and
   questions, and to steer the worker with `mesh_send_worker`.
4. Attach to a worker from the **Attachable workers** group in the Worker Accounts
   view to watch it in a terminal.

Good to know:

- Workers stay alive after their dispatch returns. Idle auto-stop
  (`meshWorkerIdleTimeoutMin`, 15 min) and the live-worker cap
  (`meshMaxLiveWorkers`, 8 — dispatches past it are refused, not queued) are
  backstops, not a substitute for stopping workers you are done with.
- A worktree with uncommitted changes is never removed for you; `mesh_status`
  keeps listing it.
- If the mesh cannot start, the dispatch runs as a one-shot worker and its result
  says so.
