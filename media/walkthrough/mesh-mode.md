# Session workers — Mesh Mode (experimental)

With Mesh Mode on, each dispatch runs as a persistent `claude --bg` background
session instead of a one-shot run. You keep using `dispatch_task` /
`dispatch_tasks`; results, timeouts, cancellation and failover are unchanged.

Needs **Claude Code 2.1.283 or newer** on **macOS or Linux**. Off by default.
When session workers cannot start, the dispatch runs one-shot and a ⚠ line at
the start of its result says why.

Try it:

1. Turn on **`claudeCodeOrchestrator.meshMode`** (Settings, or the dashboard's
   settings drawer). The dispatch server reads the switch at each dispatch, so
   the next dispatch uses it; no restart is needed. Settings are read from your
   User settings only: the same key in a workspace's `.vscode/settings.json` is
   ignored.
2. Commit what the worker needs. In a git workspace it works in its own
   worktree (`.claude/worktrees/cco-<taskId>`), created from your current HEAD
   commit — it does not see uncommitted changes.
3. Dispatch a task as usual. The result names the worker on a `peer:` line, and
   the branch its work was committed to.
4. To steer the worker, ask your session to message it with `SendMessage`,
   using that name. To watch it, open the **Team** view: attach a terminal,
   read its logs, or open the diff of its branch.
5. Verify the branch, merge what passes, then stop the worker.

Good to know:

- A worker stays alive after its dispatch returns — until you stop it, your
  session ends, or Claude Code retires it. Nothing stops an idle worker for
  you. When your session ends, its dispatch server asks every session worker it
  started to stop; if a stop does not land, the worker keeps running.
- `meshMaxLiveWorkers` (default 8) counts dispatches still in flight. One past
  the cap is refused, not queued; parked workers do not count.
- A worker that ends its turn without reporting is recorded as a failed
  dispatch, with an attach command so you can see what it was waiting for.
- Session workers never run in bypass-permissions mode; with that setting they
  start in `acceptEdits`.
- A worktree that still holds uncommitted or unpushed work is never removed
  for you; `mesh_status` keeps listing it.
- Workers on Codex, Cursor or Antigravity, and tasks dispatched with
  `detach: true`, always run one-shot, without a ⚠ line.
- A worker whose account you have removed shows as `unknown` in `mesh_status`,
  with the `claude stop <job id>` command to run by hand under that account.
- A dispatch that times out, dies or is cancelled is not committed: what the
  worker wrote stays uncommitted in its worktree.
