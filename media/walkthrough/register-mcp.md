# Register the dispatch MCP server

**Register Dispatch MCP Server in This Workspace** writes a `fable-dispatch`
entry into the workspace's `.mcp.json`.

After registering:

1. Restart the Claude Code session in this workspace.
2. Approve the project MCP server when Claude Code asks.
3. Your main session now has two tools: `dispatch_task` and `list_workers`.

The server file is kept at a stable path under `~/.fable-orchestrator/mcp/`,
so extension updates won't break the registration.
