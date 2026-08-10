# Mesh Mode (experimental)

Dispatch fans work out and reads the result files back. **Mesh Mode** adds a
live two-way channel on top: persistent `claude --bg` workers that stay alive
between messages, so your main session can hold a real back-and-forth with them
instead of waiting for a task to finish.

It rides Claude Code's own cross-session messaging — so it needs
**Claude Code >= 2.1.224** on **macOS or Linux**. Orchestration stays
file-based; the mesh only adds the live coordination layer alongside dispatch.

Turn it on with the **`claudeCodeOrchestrator.meshMode`** setting. That enables
the five `mesh_*` tools — spawn a worker, list the mesh, send it a message, read
its replies, and stop it.

Tips:

- The **cross-account bridge** (`claudeCodeOrchestrator.meshCrossAccountBridge`)
  is a separate experimental² opt-in that lets mesh workers on different
  accounts reach one another. Leave it off unless you need it.
- Restart the Claude Code session after enabling so it picks up the `mesh_*`
  tools, then ask it to spin up a background worker and talk to it live.
