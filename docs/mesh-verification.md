# Mesh Mode (v1.4.0) — Verification record

> **Historical record.** This describes Mesh Mode as it was in 1.4.0. The relay gateway and the `mesh_send`, `mesh_receive` and `mesh_spawn_workers` tools it tests were removed (the last of them in 2.0.0); for current behaviour see the README section *Session workers (Mesh Mode, experimental)*.

Every gate below was executed by the orchestrator (main session), not by a worker
(workers cannot run node/npx/builds here). Evidence is from live runs on Claude Code
2.1.226, macOS, against `out/mcp/server.js` driven over stdio JSON-RPC. Probe harnesses
live in the session scratchpad (`probe-mesh.js` scenario A/B, `probe-reply.js` scenario C,
`gw-stream-shape.js`, `bisect-*`, `preseed.py`).

## Build gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc -p ./ --noEmit` | clean, exit 0 |
| Build + bundle | `npm run compile` | ok — `out/mcp/server.js` 167 kb, `run-task.js` 54 kb |
| Server stays vscode-free | `npm run bundle-server` | ok — esbuild resolves `src/mesh/*` + server without `vscode` |

## Functional gates (scenario B, from an UNSEEDED account state)

| Step | Expectation | Result |
| --- | --- | --- |
| mesh off (scenario A) | `mesh_status` static text; `mesh_send`/`mesh_spawn` → `mesh_off` | PASS |
| gateway init | `mesh_status` → `gateway: cco-gw-<hash> (ready)` within 30s | PASS (strict READY; unauthenticated/`--bare` sessions fail the probe loudly) |
| account pre-seed | pool writes `hasTrustDialogAccepted` so `--bg` workers boot past the project `.mcp.json` trust prompt | PASS — workers reach `alive` and register a messaging socket |
| spawn (main + cross-account) | 2/2 workers spawned; bypassPermissions→acceptEdits downgrade noted | PASS (`note: permission mode downgraded…`) |
| bridge mirroring | mirror count rises as cross-account workers appear (3 → 6) | PASS |
| TASK delivery (same account) | `mesh_send` → `delivered … (msg_id …)` | PASS |
| STATUS reply (same account) | worker reply surfaces via `mesh_receive` | PASS — `STATUS probe-ack main #1` |
| TASK + STATUS (cross account, via bridge) | cross-account worker receives and replies | PASS — `STATUS probe-ack cross #1` (reply arrived even after the synchronous relay timed out on a still-booting worker — see note) |
| lifecycle | `mesh_stop_worker` stops each; `attach`/`logs`/`stop` commands surfaced | PASS |

Full bidirectional loop proven (scenario C, isolated): orchestrator → gateway → worker
(TASK) → worker → gateway (INBOUND echo) → orchestrator (`mesh_receive` STATUS).

## Contract-violating probes (hostile input — the mandate is to BREAK it)

| # | Probe | Observed |
| --- | --- | --- |
| H1 | `mesh_send` `to: "x; rm -rf /"` | `invalid_input` — TO_PATTERN rejects shell/meta |
| H2 | `mesh_send` message 9000 chars | `invalid_input` — exceeds MESSAGE_MAX (durable payloads belong in files) |
| H3 | `mesh_spawn_workers` `role: "Bad Role!"` | `invalid_input` — ROLE_PATTERN |
| H4 | `mesh_spawn_workers` `account: "ghost"` | `unknown_account` — lists known accounts |
| H5 | `mesh_send` to a non-existent peer name | `NOT delivered: No agent named … is reachable` (clean, no hang) |
| H6/H6b | two identical `mesh_send` in a row | both delivered with distinct msg_ids (dedup is best-effort upstream; no crash/hang) |
| H7 | a SECOND server calls `mesh_status` | `mesh_busy` — owner lock held by the live pid; second server refuses to init |
| H8 | `mesh_send` immediately after `kill -9` of the gateway | `gateway_down` (no hang, structured error) |
| H8b | `mesh_send` after the restart window | delivered — gateway auto-restarted per backoff and relayed |
| — | `claude --bg` bypassPermissions on this registry | disclaimer error → single acceptEdits retry → spawn ok (fallback) |
| — | worker with `Bash` in acceptEdits | boots `blocked` on an undisplayable prompt → tool set excludes Bash (contract pin) |
| — | isolated Bridge: dead-pid non-mirror file | survived (only `ccoMirror:true` files are ever pruned); mirror refreshed on source change; pruned on source removal |

## Adversarial review (fresh-context, opus + ultrathink) → fixes verified

A hostile fresh-context review of the whole subsystem produced 3 HIGH, 7 MEDIUM, 4 LOW
findings. All HIGHs and the load-bearing MEDIUMs were fixed and re-verified:

| # | Finding | Fix | Re-verified |
| --- | --- | --- | --- |
| H1 | `prepareAccount` lost-update race on the user's `.claude.json` (gateway shares the dir) | exclusive `.cco.lock` (O_EXCL) + re-read inside the lock immediately before the atomic write; skip-not-corrupt on lock timeout | round-trip still works with locking active (`probe-reply3`) |
| H2 | frontier guard was `model === 'claude-fable-5'` (bypass with `fable`, `mythos`, `claude-fable-5-20260101`, casing) | `isFrontierTier()` + whitelist against `WORKER_MODELS`, same as dispatch | PASS — every alias rejected `invalid_input` (probe-frontier) |
| H3 | gateway parsed control lines from model-echoed untrusted text → worker could forge `INBOUND` | per-session 128-bit nonce in `RELAY_RESULT <nonce>` / `INBOUND <nonce>`; nonce lives only in the standing prompt, never sent to a worker | PASS — round trip works with nonce (`probe-reply3`: RELAY_RESULT + INBOUND both parsed) |
| M1/M2 | owner-lock TOCTOU + PID-reuse | atomic `linkSync` claim + write-then-confirm `ownerPid===pid`; `startedAt` sanity token | PASS — a second server gets `mesh_busy`; a still-shutting-down prior owner correctly holds until it exits, then the next server takes over |
| M3 | symlink/non-canonical participant aliasing could delete a genuine session file | `fs.realpathSync` canonicalize + dedupe participant dirs | (static) — `ccoMirror`-only deletion guard unchanged |
| M4 | prune deleted live mirrors on a transient source-dir read error | prune suspended for any sweep where a participant dir failed to read | (static) |
| M5 | `meshMode` off after init didn't gate tools | `ensureMesh` re-reads `meshMode` every call, throws `mesh_off` even when initialized | (static) |
| M6 | seq collision across accounts when the state file is lost | `nextSeq` scans live entries across ALL candidate account dirs | (static) |
| M7 | `applyProjectMcpTrust` coerced a non-object `projects`/entry (array) | `isPlainObject` guard bails without writing | (static) |
| L2 | unbounded gateway stdout/stderr line buffer | 1 MB max-line guard drops the partial + notes once | (static) |

LOW L1 (force-stop of a possibly-recycled pid), L3 (tmp leak on write failure), L4
(unprobed account eligible — matches dispatch, intended) are documented residuals.

## Notes / known behaviors (documented, not defects)

- **Send to a still-booting worker can `relay_timeout`.** A cross-account worker that is
  not yet idle when a TASK is sent may not ack within the 30s relay window; the message
  is still queued and the worker replies once booted (observed: B4 relay_timeout on
  `toragonite-1`, yet its `STATUS probe-ack cross #1` arrived in B5). Guidance: poll
  `mesh_status` for `alive`/idle before the first `mesh_send`, or treat `relay_timeout`
  as "pending, poll `mesh_receive`".
- **Gateway inbound is echoed, not sniffed.** A `-p --output-format stream-json` session
  does NOT emit received cross-session messages as `user` stream events (verified via
  `gw-stream-shape.js`); the gateway model echoes each as an `INBOUND {json}` assistant
  line, which the host parses — same channel as `RELAY_RESULT`.
- **`--bg` cannot use bypassPermissions** (interactive disclaimer); mesh workers run
  under acceptEdits and therefore author files but do not run shell — consistent with the
  standing "workers cannot execute code; the orchestrator runs builds/tests" rule.
- **Account pre-seed mutates `<configDir>/.claude.json`** (atomic tmp+rename): sets the
  project's folder-trust flag and disables the project's `.mcp.json` servers for that
  account so `--bg` workers boot unattended. Idempotent; never created if absent; never
  written on a parse failure.
