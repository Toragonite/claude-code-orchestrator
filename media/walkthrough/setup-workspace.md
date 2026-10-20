# Set up this workspace

**Update Workspace Setup** looks at the workspace and offers one checklist,
each item with its state. It applies only what you check, and tells you for
each item what it did or why it refused. No MCP server is needed: the main
session dispatches by running the `~/.claude-code-orchestrator/bin/cco`
command through its Bash tool.

The checklist:

1. **Dispatch policy** — add or update the dispatch policy block in
   `CLAUDE.md`. It tells the main session to delegate all implementation to
   workers and to design, integrate and verify itself, and it teaches the
   session the `cco` command.
2. **Team proxy agent** — add or update `.claude/agents/cco-worker.md`. A file
   there that is not ours is never overwritten.
3. **Permissions** — let `~/.claude-code-orchestrator/bin/cco` run without
   permission prompts, with rules in `.claude/settings.local.json` (at the git
   repository's root; in the folder itself outside git): the command in both
   of its spellings, `Edit(/.cco/**)` so that the session can write task
   files, and both spellings in `sandbox.excludedCommands`. A settings file
   that cannot be parsed is never rewritten. If that file is tracked in git,
   the rules apply once the folder is trusted and reach everyone who clones it.
4. **MCP server** — remove the `cco-dispatch` entry from `.mcp.json`.
   Unchecked by default, and offered only once the policy is current. After
   this one, restart the Claude Code session.

The command is also in the Command Palette, and the dashboard's setup button,
the onboarding step and the "policy outdated" chip open it.

`cco` does not run on Windows in 2.0. There, run **Register Dispatch MCP Server
in This Workspace** instead: it writes a `cco-dispatch` entry into the
workspace's `.mcp.json`, after which you restart the Claude Code session and
approve the project MCP server. You can also use it on macOS and Linux if you
prefer MCP tools; the operations are the same.
