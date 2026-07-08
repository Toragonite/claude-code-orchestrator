# Register the dispatch MCP server

**Register Dispatch MCP Server in This Workspace** writes a `cco-dispatch`
entry into the workspace's `.mcp.json`.

After registering:

1. Restart the Claude Code session in this workspace.
2. Approve the project MCP server when Claude Code asks.
3. Your main session now has three tools: `dispatch_tasks` (parallel batch),
   `dispatch_task`, and `list_workers`.

You'll also be offered a dispatch policy for `CLAUDE.md` — it tells the main
session to delegate all implementation to workers and only design, integrate,
and verify itself.

The server file is kept at a stable path under `~/.claude-code-orchestrator/mcp/`,
so extension updates won't break the registration.
