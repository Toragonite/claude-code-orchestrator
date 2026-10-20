# Cross-Session Messaging Spike — Verification Evidence

> **Historical record.** These probes were run on Claude Code 2.1.226. The gateway design that followed from finding P7 (the IDE panel session could not exchange messages) was removed in 2.0.0: on Claude Code 2.1.283 the panel session is a full messaging peer, and the `mesh_send` / `mesh_receive` tools named below no longer exist. See the README for current behaviour.

**Date:** 2026-08-10
**Claude Code version under test:** 2.1.226 (macOS, darwin-arm64, VS Code extension native binary)
**Question:** Can the orchestrator replace/augment MCP `dispatch_task` with the new
cross-session messaging feature (`SendMessage`/`ListAgents`, default-on since v2.1.224),
spawning worker sessions as editor terminal tabs — and does it work across the
multi-account `CLAUDE_CONFIG_DIR` boundary this extension is built on?

## Background (from docs/changelog research)

- **Cross-session messaging** (local sessions, `SendMessage`/`ListAgents`) ships enabled by
  default since v2.1.224 (2026-08-07). Settings: `crossSessionInbound`, `isolatePeerMachines`,
  `dialogExpiry`. Docs: https://code.claude.com/docs/en/cross-session-messaging
- **Agent Teams** remain experimental behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  (shared task list, teammates spawned by a lead; teammates inherit the lead's account —
  not usable for multi-account pooling). Docs: https://code.claude.com/docs/en/agent-teams
- Delivery model: plain text; queued if receiver is mid-turn, drained at the receiver's next
  tool round; message ≠ permission consent; ~50 unread cap; dedup/throttle of repeated sends.

## Discovered mechanics (filesystem inspection)

- Session discovery registry: `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` — **per config dir**.
  Entry: `{pid, sessionId, cwd, version, peerProtocol, kind, entrypoint, messagingSocketPath?, name, nameSource}`.
  Stale entries linger after process death; liveness is checked at read time.
- Messaging sockets: `/tmp/cc-socks/<pid>.sock` — **machine-global** directory, but discovery
  never scans it directly; only the per-config-dir registry is consulted.
- The VS Code extension UI session (entrypoint `claude-vscode`, the panel session — not a
  terminal) registers **without** `messagingSocketPath`. CLI `-p` and terminal sessions
  register **with** a socket.

## Probes and observed results

All probes ran as headless `claude -p` (haiku/sonnet) with `--name`, launched from this
orchestrator session. Raw outputs preserved in the session scratchpad (`*.out`).

| # | Probe | Setup | Observed result |
|---|-------|-------|-----------------|
| P1 | `probe-same` visibility | `-p` session, same config dir (`~/.claude`) as orchestrator | **Visible** to orchestrator `ListAgents` as `Peer sessions: probe-same` |
| P2 | `probe-cross` visibility | `-p` session, `CLAUDE_CONFIG_DIR=~/.claude-toragonite` | **Never visible** to orchestrator (registered in its own dir's `sessions/`) |
| P3 | Reverse visibility to UI session | Both probes ran `ListAgents`, then `SendMessage to:"fable-orchestrator-b6"` | Both: `No reachable agents.` + `{"success":false,"message":"No agent named 'fable-orchestrator-b6' is reachable..."}` — UI session has no socket, cannot be seen or messaged |
| P4 | Same-dir CLI↔CLI discovery | `alpha-one`/`alpha-two`, both `~/.claude` | **Mutual discovery** within seconds (`alpha-two` saw `alpha-one [8c2893]`; `alpha-one` saw `beta-main`) |
| P5 | Cross-dir discovery, both directions | `beta-main` (`~/.claude`) vs `beta-worker` (`~/.claude-toragonite`), 8 polls each, overlapping | **Invisible in both directions**; sends fail `No agent named '...' is reachable` |
| P6 | Send to dead peer | Orchestrator → exited `probe-same` | Immediate `{"success":false,...not reachable}` — clean liveness signal |
| P7 | UI session → live CLI peer delivery | Orchestrator `SendMessage` to `echo-target`, then retest `echo2` (25-poll window, send landed seconds after spawn) | **Silent blackhole**: send returns `{"success":true, "msg_id":"..."}` but receiver polled 25× and got nothing. Reproduced twice. |
| P8 | CLI↔CLI full round trip | `relay-a` → `relay-b` (both `~/.claude`, both `-p`) | **Works end-to-end**: bare-name send rejected with ref-confirmation (`Re-send with the ref ... "relay-b [1d6fa4]"`); ref'd send delivered mid-run as `<cross-session-message from="uds:/tmp/cc-socks/75445.sock" from-name="relay-a" from-mode="prompting">`; reply addressed to the `uds:` value succeeded without ref dance; original sender received the ACK. |
| P9 | **SDK-gateway feasibility** (the shape an IDE extension would host) | Long-lived `claude -p --input-format stream-json --output-format stream-json --name gateway-test`, stdin held open via fifo; `courier` CLI probe messages it | **Full mesh peer.** Registered WITH `messagingSocketPath`; while idle-waiting on stdin, courier's message was delivered and started a new turn (visible in stream output as a user turn containing the `<cross-session-message>` block); gateway's `SendMessage` to the `uds:` address succeeded; courier received `GATEWAY-ACK` within 2 polls. Every step surfaced as parseable stream-json events. Relay turn cost ≈ $0.03 haiku (bloated by inherited user settings/plugins — slim the gateway's config in production). |
| P10 | **`--bg` background agent as mesh peer** | `claude --bg --name bgworker-test "<standing instructions>"`; `bgcourier` CLI probe messages it | **Full mesh peer, plus lifecycle surface.** Spawn returns immediately with a job id and management commands (`claude agents` / `attach <id>` / `logs <id>` / `stop <id>`). Registry entry: `"kind":"bg"`, `messagingSocketPath` present, **and live `"status":"idle"` + `"jobId"` fields**. Courier's message was delivered to the idle bg agent, which replied `BG-ACK` successfully. |
| P11 | **Cross-account registry bridge** | `bridge-worker` spawned `--bg` under `CLAUDE_CONFIG_DIR=~/.claude-toragonite`; its `sessions/<pid>.json` **copied once** into `~/.claude/sessions/`; main-account courier messages it | **Works end-to-end across the account boundary.** After the copy, the worker appeared in main-account `ListAgents` (including the orchestrator panel session's). Courier's `HELLO-BRIDGE` was delivered; the worker's `BRIDGE-ACK` came back on poll #3 **without any reverse mirroring** — `uds:`-addressed replies bypass discovery entirely. Staleness observed: the source entry keeps updating (`status`, `statusUpdatedAt`, a `bridgeSessionId` field appeared post-spawn) while the copy froze; reachability was unaffected (socket path/pid/name are stable), but a bridge daemon should re-sync on change to keep listing metadata fresh. `claude stop <jobId>` cleaned up both test agents. |

## Upstream corroboration (docs & issue tracker, checked 2026-08-10)

- Panel-session invisibility is a **known, undocumented** gap: anthropics/claude-code
  **#82313** (open) — VS Code-launched sessions never join the peer mesh. No fix in the
  changelog up to v2.1.226 (latest release; v2.1.225 messaging notes cover Remote Control only).
- Docs confirm the P8/P9 mechanics: cross-session-messaging.md "Non-interactive sessions" —
  "Claude Code binds an inbox socket for a `claude -p` session like an interactive one, so a
  long-running `-p` worker can receive messages and appears in the listing."
- The inbound event shape in `--output-format stream-json` is **not documented**; P9 supplies
  the empirical answer (a new user turn whose content is the `<cross-session-message>` block).
- The TypeScript/Python **Agent SDK APIs expose no messaging surface** (no SendMessage/
  ListAgents options documented) — the gateway must be built on raw CLI flags, not SDK wrappers.
- Config-dir scoping matches the docs' file-visibility rule ("two sessions can reach each
  other only when they can see the same files"). Related: **#30538** (open) — the VS Code
  extension itself always uses `~/.claude`, ignoring `CLAUDE_CODE_CONFIG_DIR` overrides.
- VS Code `TerminalOptions.hideFromUser` is stable API (since 1.36), `terminal.show()`
  reveals hidden terminals, they do **not** survive window reloads, and the API works in
  forks (Cursor/Windsurf/VSCodium) — viable for a "background worker, reveal on click" UX.
- 2.1.226 ships `--bg/--background` ("start the session as a background agent, manage with
  `claude agents`") and `claude attach <id>` ("open the background session in this terminal…
  the session keeps running either way") — a native background+attach visualization path.

Additional observations:
- First cross-session send from a given session requires the `name [ref]` confirmation echo;
  replies addressed to a `uds:/tmp/cc-socks/<pid>.sock` `from` value skip it.
- Headless `-p` sessions **do receive** queued messages mid-run (drained between tool rounds)
  and can reply — the fire-and-forget dispatch model can, in principle, gain a live side-channel.
- Probe Bash `sleep` was blocked by the worker sandbox (consistent with the project's
  "workers cannot execute code" constraint).

## Conclusions (pinned to 2.1.226)

1. **The mesh is real and CLI↔CLI works fully** — discovery, send with ref confirmation,
   mid-run delivery to headless sessions, socket-addressed replies.
2. **`CLAUDE_CONFIG_DIR` is a hard mesh boundary.** Discovery reads only the caller's own
   config-dir registry. Multi-account workers (this extension's core design) cannot see or
   message each other or the main account. Sockets being machine-global suggests a
   registry-file bridge could work, but that is an unofficial, version-fragile hack.
3. **The VS Code panel session is a second-class citizen**: it registers without a messaging
   socket (cannot receive), and its outbound sends report success but are never delivered
   (P7). Treat orchestrator-from-panel messaging as broken in 2.1.226; likely an upstream
   bug worth re-testing on later versions. A CLI session in an integrated terminal is a
   full participant.

## Design implications for this extension

- **The IDE-panel entry point is NOT a dead end.** The extension can host a persistent
  stream-json gateway process (P9) as its own first-class mesh identity: outbound = write a
  relay instruction to the gateway's stdin; inbound = parse `<cross-session-message>` user
  turns from its stream-json stdout. Everything stays on the official CLI surface — no
  socket-protocol reverse engineering. Natural owner: the MCP dispatch server process,
  exposing e.g. `mesh_send` / `mesh_receive` (long-poll) tools to the panel orchestrator.
- Session-mesh mode can alternatively run the **orchestrator as a named CLI session in a
  terminal tab** — a full participant with zero relay cost (until P7 is fixed upstream).
- Mesh participants must share one `CLAUDE_CONFIG_DIR` → mesh mode is a **same-account
  collaboration feature**; multi-account quota pooling stays on MCP dispatch. The two are
  complementary, not substitutes: dispatch keeps structured results (result.json), timeouts,
  cancellation, failover, usage routing; the mesh adds live bidirectional coordination.
- **Preferred worker spawn mode: `claude --bg` background agents (P10)**, not terminals.
  They need no pty, survive editor window reloads (owned by the CLI's background service,
  not the extension host), are full mesh peers, and give a Cursor-style UX for free:
  a tree-view "open" button runs `claude attach <jobId>` in a fresh integrated terminal
  (Ctrl+Z detaches, session keeps running); `claude logs <jobId>` for a quick peek;
  `claude stop <jobId>` for teardown. The registry's live `status` field feeds the
  extension's worker view via a cheap `fs.watch` on `<configDir>/sessions/`.
  `hideFromUser` terminals remain a fallback (stable API since VS Code 1.36, works in
  forks, but hidden terminals do not survive window reloads).
- The extension process itself cannot join the mesh via any official API. Its handlers:
  (a) spawner/lifecycle — `--bg` workers with a naming convention;
  (b) observer — watch `<configDir>/sessions/*.json` for name/socket/status;
  (c) gateway (P9) — the extension's own mesh identity for panel-driven orchestration;
  (d) cross-account bridge — **verified feasible (P11)**: a daemon that `fs.watch`es every
  registered account's `sessions/` dir and mirrors live entries into the other accounts'
  dirs (prune on pid death / source removal; re-sync on change because entries mutate).
  Only the request direction needs mirroring — replies ride the `uds:` address. Gate it
  as experimental²: double opt-in setting, `peerProtocol === 1` pin, and a startup
  capability probe (tiny two-probe round trip; auto-disable on failure) since the file
  format is undocumented and may change without notice.
- **Quota-aware worker pool on top of the bridge** (design direction): reuse the existing
  usage machinery (usage.ts `AccountUsage`/`exhaustedWindows`, cooldowns, overage guard) —
  spawn-time placement picks the healthiest account per worker; the usage refresh loop
  marks exhausted accounts, whose workers get drained (orchestrator mesh-messages them to
  finish and stop claiming; extension `claude stop`s and respawns replacements on healthy
  accounts, re-briefed via spawn prompt). Note the granularity difference: MCP dispatch
  balances per task; mesh balances per worker placement + rotation. Keep dispatch for
  fine-grained per-task routing.
