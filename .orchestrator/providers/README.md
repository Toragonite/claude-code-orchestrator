# providers — offline harness for v2.0.0 vendor workers

A black-box check of the provider workers of release 2.0 — worker accounts that run on
**Codex** (`codex exec`), **Cursor** (`cursor-agent -p`) or **Antigravity** (`agy -p`) instead
of Claude Code. It is written from `.orchestrator/contract-2.0-providers.md` (§10.2, §10.3,
§10.5, and the §11 rows F3–F5) and from the adapters' own documented wire formats, not from
the implementation.

It drives the **real compiled server** (`out/mcp/server.js`) and the real helper
(`out/mcp/provider-cli.js`) and replaces the three vendor CLIs with fakes. It needs no account,
no login and no quota; it never starts a real `codex`, `cursor-agent`, `agy` or `claude`, never
reads or writes `~/.codex`, `~/.cursor`, `~/.agy`, `~/.claude*` or `~/.claude-code-orchestrator`,
and cannot make a network request to a vendor.

## Run it

```sh
node .orchestrator/providers/probe.mjs --selftest   # the fakes against the REAL adapters; no build needed
npm run compile                                     # builds out/mcp/{server,run-task,provider-cli}.js
node .orchestrator/providers/probe.mjs              # V1–V20, then the extras X1–X7 (4 at a time)
node .orchestrator/providers/probe.mjs V3 V7        # a subset
node .orchestrator/providers/probe.mjs --no-extras  # only the twenty rows of the table
node .orchestrator/providers/probe.mjs --jobs 1     # one probe at a time
node .orchestrator/providers/probe.mjs --verbose    # print sandbox diagnostics for passes too
node .orchestrator/providers/probe.mjs --list       # list the probes
node .orchestrator/providers/probe.mjs --selftest S3 S7
```

Each probe prints one line, `PASS — <id> <name>: <what was observed>` or
`FAIL — <id> <name>: <expected vs observed>`, followed on a failure by what the sandbox looked
like (vendor CLI invocations, anomalies, task events, login-shell lookups, network attempts,
server stderr). The run ends with a cleanup line, an optional **findings** section and a tally,
and exits `1` if any probe failed, a process was left running or a sandbox was left on disk
(`2` for a usage error or a missing server bundle).

Three kinds of statement appear, and a FAIL line says which one broke:

- a **row** expectation — what the probe table of the P-HARNESS task says for that probe;
- a **pinned** expectation, tagged `[§x.y …]` — text or behaviour a contract clause, or a doc
  comment of the frozen `src/providers.ts`, spells out and that the same scenario makes
  observable;
- a **note** — something the contract leaves open. Notes sit on the PASS line and never fail.
  A note that deserves a decision is a **finding**: it is repeated in the `findings` section
  at the end of the run. A finding has no effect on the tally.

`[harness safety]` on a FAIL line means a vendor child was started outside the sandbox or
without the harness environment, or something reached for the network. It fails the probe
whatever the probe was testing.

## Files

| File | What it is |
|---|---|
| `fake-vendor.mjs` | The emulation of all three vendor CLIs, scenario-driven. |
| `fake-codex.mjs`, `fake-cursor-agent.mjs`, `fake-agy.mjs` | The three executables: each only says which CLI it is. |
| `net-guard.cjs` | Preload (`NODE_OPTIONS=--require`): replaces the global `fetch` with a stub and refuses every non-loopback socket. |
| `helpers.mjs` | Sandbox fixture, the allow-list environment, the hermeticity check, the JSON-RPC stdio client, the `provider-cli.js` runner, the adapter loader, process and sandbox cleanup. |
| `selftest.mjs` | Cases S1–S14 + S99 behind `probe.mjs --selftest` (S14: the keychain guard is live in a sandbox child). |
| `probe.mjs` | The probes V1–V20, the extras X1–X7, and the runner. |
| `README.md` | This file. |

Read-only reuse: `../mesh2/fake-claude2.mjs` plays `claude` in the Claude legs (V1, V7, V15,
V17, V19, V20, X4, X5, X7). Nothing under `../mesh2` or `../detach` is modified.

## How a probe is isolated

Each probe (each leg of a probe) gets its own sandbox under the system temp directory (or
`PROVIDERS_TMPDIR`), named `cco-prov-<probe>-XXXXXX`:

```
.cco-providers-sandbox             marker: the fakes refuse to act anywhere else
home/                              HOME for the server and for every fake
  .claude/                         the host Claude account
  .claude-code-orchestrator/       the server's data root (registry.json, usage.json, stats.json,
                                   tasks.jsonl, tasks/, mesh/)
  accounts/<name>/                 Claude worker config dirs
  .codex, .codex-<name>/           Codex homes (each with an auth.json fixture)
  .cursor/                         the one Cursor identity
  .agy, .agy-<name>/               Antigravity homes
bin/codex, cursor-agent, agy       launchers: `exec <node> fake-<cli>.mjs --fake-root=<sandbox> "$@"`
bin/node                           symlink, for fake-claude2's `#!/usr/bin/env node`
login-shell                        the sandbox "login shell" (see below) + login-shell.log
ws-plain/ or ws-git/               the workspace (server cwd)
vendor-scenario.json               what the vendor fakes do; CCO_PROVIDERS_SCENARIO points here
fake-vendor.log.jsonl              every vendor-fake invocation: argv, cwd, full environment, exit
claude-scenario.json, fake-claude.log.jsonl     the same for fake-claude2
net.json, net.log.jsonl            what the network guard answers; what it was asked
pids/, pids-claude/                one file per live fake process
```

**Environment.** Built from an allow-list (`TMPDIR`, `LANG`, `LC_*`, `USER`, `LOGNAME`, `TERM`,
`TZ`), never from the caller's environment. The harness is normally run from a Claude Code
session on a machine where the real CLIs are installed and logged in; its `PATH`, its `CLAUDE*`
variables, a `CODEX_HOME`, an `OPENAI_API_KEY` or a proxy setting must not reach a run.

**Which binary.** `PATH` is `<sandbox>/bin:/usr/bin:/bin:/usr/sbin:/sbin` and `SHELL` is the
sandbox login shell. The server resolves a bare CLI name with `$SHELL -lc "command -v <name>"`;
a real login shell would run `/etc/profile` (on macOS `path_helper` puts `/usr/local/bin` first)
and the user's profile, so the sandbox one reads no profile at all and searches the sandbox
`PATH` only. It logs every lookup it is asked for. Two checks back this up:

- once per run (`hermeticVerdict`): with **no** fake installed, nothing named `codex`,
  `cursor-agent`, `agy` or `claude` may be resolvable — through the sandbox `PATH`, through the
  sandbox login shell, or through `/bin/sh`, `/bin/bash` and `/bin/zsh` as login shells. If
  anything is, **every probe fails** with `REFUSED TO RUN — a real binary would have been
  resolved …` and nothing is started;
- per fixture (`fx.assertHermetic`, before every server start): every installed fake is exactly
  what its name resolves to. A "CLI not installed" case additionally refuses to run when a real
  binary sits in `/opt/homebrew/bin` or `/usr/local/bin`, the two fixed locations of the server's
  well-known-location fallback that no environment can redirect.

**Network.** `net-guard.cjs` is preloaded into the server, the detach supervisor,
`provider-cli.js` and the fakes. The Codex adapter's `quota()` calls the vendor's usage endpoint
with the global `fetch` and the bearer it finds in `<CODEX_HOME>/auth.json`; the guard *is* that
global `fetch` (the adapter's `fetchFn` seam, reached from outside — the bundle is not
modified), answering from `net.json`: `deny` (default; rejects like a network failure),
`snapshot` (200 with a body), `http` (a status), `hang` (never settles). It also refuses every
non-loopback TCP connection, whatever API asked for it. It is not an HTTP server listening on a
socket: the hard-coded `https://chatgpt.com/…` URL cannot be pointed at one without a TLS
certificate Node trusts, and an in-process stub needs neither a port nor a certificate. Two
layers keep a probe from reaching the endpoint at all: every Codex fixture except V18's `cq`
carries **no access token** (so `quota()` resolves `null` before any `fetch`), and any `fetch`
outside V18 fails the probe.

**Cleanup** runs in a `finally` for every probe, including one that failed or timed out: the
server is ended (stdin EOF, then SIGKILL), every process whose command line names the sandbox
is SIGKILLed (the launchers put the sandbox on each fake's command line for exactly this), and
the sandbox is removed. A fake also ends itself when its sandbox disappears and after 10
minutes.

## The fakes

`CCO_PROVIDERS_SCENARIO` must name a JSON file inside a sandbox. A fake exits **97** when the
variable is missing, the file is not in a sandbox, `HOME` or the vendor home is outside the
sandbox, a run's working directory is outside it, or a launcher is handed another sandbox's
scenario; **2** for an invocation it does not emulate; **98** for an internal error.

| CLI | Emulated | Home |
|---|---|---|
| `codex` | `exec --json [--model M] [--sandbox MODE] … -- <prompt>`, `exec resume <id> …`, `--version`, `login status` | `CODEX_HOME`, else `$HOME/.codex` |
| `cursor-agent` | `-p --output-format json [--trust] [--model M] [--sandbox MODE] … -- <prompt>`, `--resume <id>`, `status`, `models`, `create-chat`, `--version` | none (`$HOME/.cursor` as a label) |
| `agy` | `--output-format json [--model M] [--mode MODE] … -p <prompt>`, `--conversation <id>`, `models`, `--version` | `AGY_HOME`, else `$HOME/.agy` |

Scenario file (all keys optional; one section per vendor id `codex` / `cursor` / `gemini`):

| Key | Meaning |
|---|---|
| `<vendor>.run` | A run spec, or `{ default, sequence[], byHome{} }`. `sequence` is indexed by the order of that vendor's runs and beats `byHome` (keyed by the basename of the home directory), which beats `default`. |
| `<vendor>.login` | `"in"` (default) / `"out"`, or `{ default, byHome{} }`. Cursor and Antigravity only — Codex's login state is its `auth.json` fixture. |
| `<vendor>.version` | Text for `--version`. |

A run spec is a scenario name or `{ kind, …knobs }`:

| `kind` | What the fake does |
|---|---|
| `ok` | answer text, token usage, a conversation id. Knobs: `text`, `inputTokens`, `outputTokens`, `conversationId`, `reportModel` (Codex: a model id in the stream) |
| `ok-no-conversation` | `ok` without a conversation id |
| `ok-empty-text` | a successful run whose answer is the empty string |
| `ok-blank-text` | a successful run whose answer is whitespace |
| `error` | a vendor-reported failure (`message`, `partialText`) |
| `quota` | the vendor's usage-limit sentence, where the real CLI puts it. `carrier: "text"` also puts it in the assistant text |
| `auth` | the "not logged in" answer |
| `hang` | never answers. `ignoreSigterm: true` survives SIGTERM |
| `slow:<ms>` | `ok` after a delay (`{ kind: "slow", ms }`) |
| `huge` | more than 8 MiB of output (default 12 MiB on stdout **and** on stderr). `where`: `"text"` (the answer itself is that large — default), `"after"` / `"before"` (a normal answer plus that much chatter); `bytes`; `stderr: false` |
| `spawn-grandchild` | `ok`, leaving a child process in the same process group |
| `garbage` | exit 0 with nothing parseable |
| `exit:<code>` | no output, that exit code |

Any spec may add `grandchild: true | { lifetimeMs, ignoreSigterm, holdPipes }`: a helper in the
fake's own process group (only a signal to the group reaches it); `holdPipes` makes it inherit
stdout/stderr, so the caller's `'close'` never fires while it lives. A logged-out account
answers `auth` whatever the spec says (`ignoreLogin: true` turns that off).

What the adapters (0.1.1) make of each scenario — pinned by the self-test, and the reason some
probes distinguish vendors:

| Scenario | Codex | Cursor | Antigravity |
|---|---|---|---|
| `ok` | `ok` | `ok` | `ok` (one trailing newline stripped) |
| `ok-empty-text` | `incomplete` | `incomplete` | **`ok` with text `""`** |
| `error` | `error`, message in **`note`**, text `""` | `error`, message is the **text** | `error`, message in **`note`**, text `""` |
| `quota` | `error`, sentence in `note` | `error`, sentence is the text | `error`, sentence in `note` |
| logged out | `error`, sentence in `note` | **throws** `AdapterExecError("cursor-agent exited with code 1")`, sentence only in `.stderr` | `error`, sentence in `note` |
| `hang` + timeout | `incomplete`, note `timed out after …ms` | same | same |
| `exit:<n>` | throws `AdapterExecError` | same | same |

No adapter in 0.1.1 raises `QuotaExceededError` or `AuthError` from `run()`; a quota or a login
failure can only be recognized from the text, the note, the stderr of the exec error, or a
separate `authStatus()` call.

**Codex `auth.json` fixture** (`writeCodexAuth(dir, state)`; a worker's `auth` option):
`chatgpt` (default: logged in, **no access token**), `chatgpt-quota` (plus an access token),
`api-key`, `out` (the token-less file a logout leaves), `garbage`, `absent`. Recognizable secrets
are planted (`SECRETS` in `helpers.mjs`): an id token, an access token, a refresh token, an API
key, an e-mail address, an account id.

## The probes

| # | What is driven | Row expectation |
|---|---|---|
| V1 | registry `[Codex, Claude]`; three dispatches with no `worker`/`provider`; then the same with mesh on | all on the Claude worker; the Codex fake never invoked |
| V2 | registry: only a Codex worker; no `worker`/`provider` | an error naming Claude Code; nothing spawned |
| V3 | `provider: "codex"`; again with no conversation id, a system prompt and `ultrathink` | `codex exec --json`; header line 1 `[worker: cx, model: gpt-5.5, provider: codex]`, line 2 `task: … · output: …`, line 3 `conversation: <id>` only with an id; `done` event with `provider: "codex"` and the fake's token counts |
| V4 | `worker: "cu"` (a Cursor worker) | `cursor-agent -p --output-format json`; the same header rules |
| V5 | `provider` = `gemini`, `antigravity`, `agy` | all three reach the `agy` fake |
| V6 | `provider: "nope"`; `worker: cx` + `provider: "cursor"` | both rejected before any spawn, with the contract's messages |
| V7 | `model` = `gpt-5.6-sol`, `bad model`, `""` on a Codex worker; `OPUS` on a Claude worker | `--model gpt-5.6-sol`; rejected with the Codex hint; no `--model`; `opus` |
| V8 | server started with all thirteen session-identity variables; Codex default + isolated home, Cursor, Antigravity default + isolated | none of them in any vendor child; `CODEX_HOME` only for the isolated home; no home variable for Cursor |
| V9 | per-worker `permissionMode` rewritten between dispatches; registry-wide mode `bypassPermissions` | Codex default `--sandbox workspace-write`, `read-only` honoured, invalid → default; Antigravity default `--mode accept-edits`; Cursor default no `--sandbox`; never `--force` / `--yolo` / `--dangerously-*` |
| V10 | `hang` + grandchild with `timeout_minutes: 1` — Codex, and Cursor ignoring SIGTERM | a timeout error; the fake and its grandchild dead |
| V11 | `notifications/cancelled` during a 45 s `slow` | child killed; a cancelled terminal event; no response |
| V12 | two Codex workers, the first run answers `quota` | the first cooled down; the task done on the second |
| V13 | A: cache says logged out. B: cache says logged in, CLI logged out. C: a single logged-out worker (Codex, Cursor, Antigravity) | the account skipped / the task failed over; the failure says the login is the problem |
| V14 | `error`, `ok-empty-text` on all three vendors; `huge` | a failure with the fake's text; a failure saying there was no text; settles without crashing, recorded output bounded |
| V15 | mesh on, `provider: "codex"` | one-shot through the fake, no `⚠`, no `--bg` spawn |
| V16 | `detach: true`, `provider: "codex"` | completes; `dispatch_status` returns the result |
| V17 | `list_workers` and `orchestrator_briefing`, mixed registry and Claude-only registry | each worker's provider label and the opt-in sentence; with Claude only, neither |
| V18 | `provider-cli.js status <provider> <dir> [--quota]`: logged in / out / binary missing / garbage arguments | one line of JSON in the `ProviderStatus` shape; exit 0, or 2 for bad arguments; never a token |
| V19 | Claude-only registry: a one-shot and a session-worker dispatch | the 2-line header with no `provider:`; no `provider` key on the events |
| V20 | an entry with `provider: "weird"`; entries sharing provider and directory | treated as Claude Code; only the first listed |

Extras, outside the table (skip them with `--no-extras`):

| # | What is driven | Expectation | Clause |
|---|---|---|---|
| X1 | the CLI answers and exits while a helper keeps its stdout/stderr open for 40 s | the result within seconds | §10.3 "settle on `'exit'` + ≤250 ms drain (never `'close'`)" |
| X2 | the `codex` launcher is not installed | an error naming the CLI and the provider, no cooldown; `list_workers` says "CLI not found" | §10.5 |
| X3 | `worker` = `42`, an object, an array, `true` — in-process, detached, with a provider | `invalid worker — expected the name of a registered worker`; no event, no file, no spawn | §11 F5 |
| X4 | a session worker parks without a result on an account dispatched under overage billing; a control leg without overage whose live usage reading says exhausted | the overage leg settles as the parked error, with no cooldown and no stop; the control takes the quota rung | §11 F3 |
| X5 | the host account's session directory is read-only, so no mirror can be written | `peer: <name> — not visible to this session's account yet (mirror pending); mesh_status shows when it is` | §11 F4 |
| X6 | one `dispatch_tasks` batch: Claude, Codex, Cursor, Antigravity and an unknown provider | each task on its own CLI with its own header; the unknown one rejected in place | §10.3 |
| X7 | mesh on with vendor workers registered; one Claude session-worker dispatch | none — it only reports what `mesh_status` says about vendor homes, and whether a vendor home was written to | not pinned (a finding) |

## Slow probes and timing

At the default `--jobs 4` the whole run (27 probes) took 73 s, measured on a heavily loaded
machine; V10 alone sets that floor. A sequential run (`--jobs 1`) was not measured — the
per-probe times add up to roughly three and a half minutes. The self-test takes under a
minute. Every timeout is sized for a loaded machine (a Node process can take seconds to
start), so a probe timeout firing means a hang, not a slow host.

| Probe | Why it is slow | Typical |
|---|---|---|
| V10 | the smallest dispatch timeout is one minute (`timeout_minutes` is clamped to ≥ 1; there is no test override); the SIGTERM-ignoring leg adds the 5 s SIGKILL grace. Both legs run at once. | ~70 s |
| V18 | about thirty helper processes; the `hang` case waits out the adapter's 10 s quota deadline | 15–40 s |
| V14 | three 12 MiB floods. A server that stopped READING at its cap (instead of dropping the excess) would block the fake and make each wait for the 1-minute timeout — the probe fails that as "did not settle when the child exited". | ~15 s |
| X4 | two parked workers. The server is started with `CCO_TEST_PARK_GRACE_MS=600` and `CCO_TEST_LIVENESS_TICK_MS=200`; without them each leg takes up to ~80 s. | ~10 s |
| S4, S5 (self-test) | one adapter-level timeout plus the 5 s SIGKILL grace; three 24 MiB floods | 10–30 s each |

Timing assertions use two clocks on purpose: lower bounds are measured from the tool call (the
server's timer cannot have started earlier), upper bounds from the moment the fake logged its
own start.

## Environment variables the harness reads

| Variable | Effect |
|---|---|
| `PROVIDERS_OUT_DIR` | Directory holding `server.js`, `run-task.js` and `provider-cli.js`, instead of `out/mcp`. |
| `PROVIDERS_TMPDIR` | Where sandboxes are created, instead of the system temp directory. |
| `PROVIDERS_KEEP=1` | Leave sandboxes on disk for inspection (processes are still killed). |
| `PROVIDERS_VERBOSE=1` | Same as `--verbose`. |

Variables it sets for everything it starts: `HOME`, `PATH`, `SHELL`, `CCO_PROVIDERS_SCENARIO`,
`FAKE_CLAUDE2_SCENARIO`, `CCO_PROVIDERS_NET`, `NODE_OPTIONS` (the network guard and `../fixes/keychain-guard.cjs`
preloaded), `AGENT_CLI_CREDENTIAL_STORE=memory` (no adapter reads a keychain or a login file),
`CCO_KEYCHAIN_GUARD_LOG` (a refused `security` call is logged there; a non-empty log fails the run at exit),
`CCO_PROVIDERS_PASSTHROUGH` (a sentinel V8 looks for), `CCO_TEST_PARK_GRACE_MS`,
`CCO_TEST_LIVENESS_TICK_MS`. V8 additionally sets the thirteen session-identity variables,
`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`.

## What this harness assumes

The contract does not state these; the harness relies on them.

- A registry entry for a vendor worker is `{ name, configDir, provider, model?, permissionMode? }`
  beside the existing fields, and the server re-reads `registry.json` on every dispatch (V9
  rewrites one worker's `permissionMode` between dispatches).
- A vendor worker needs no usage reading to be dispatchable. Fixtures give Claude workers a
  fresh healthy reading (as the mesh2 fixture does) and vendor workers none, except where a
  probe plants one (V13 A/B, in the `AccountUsage` shape of §10.4).
- The server finds a vendor CLI through `$SHELL -lc "command -v <name>"` or a plain `PATH`
  lookup. Both lead to the sandbox launchers.
- The vendor child inherits the server's environment apart from the session-identity variables
  (§10.1) — that is how `CCO_PROVIDERS_SCENARIO` reaches the fakes. A child started without it
  is refused and reported as `[harness safety]`.
- A tool failure is a `tools/call` result with `isError: true` and its message in
  `content[0].text`. Task events carry `id`, `title`, `status`, `worker`, `outputFile`.
- "A cancelled terminal event" (V11) is the event the Claude path writes today: `status:
  "error"` with `error` containing "cancelled". A `status: "cancelled"` would pass too.
- "The opt-in sentence" (V17) has no pinned wording. The probe looks for a line that mentions
  `provider` together with one of *opt-in / only / unless / explicit / never / must / ask*, and
  prints the line it found. "Provider label shown" means the label appears in the worker's own
  block of `list_workers` (its `- <name>` line and the lines indented under it).
- A failure text may be capped (§10.3 "flattened, capped"), so V14 asks for the *start* of the
  fake's sentence (`FAKE_<VENDOR>_ERROR`) and reports as a finding when the rest was cut.
- For `ok-empty-text` the pinned wording follows the adapter: "the worker returned no text"
  where the adapter says `ok` with an empty text (Antigravity), "ended without a final answer"
  where it says `incomplete` (Codex, Cursor). The row itself accepts either.
- V18 accepts `loggedIn: null` or `false` (anything but `true`) when the binary is missing, and
  any object carrying a non-empty `error` string for bad arguments; `status claude <dir>` and an
  empty `<dir>` are reported as notes.
- V20 tests the duplicate rule with Codex entries. Whether two **Claude** entries may still
  share a directory (v1.x allowed it) is not probed.

## What it does not cover

- The extension host: the Add-worker flow, the Workers tree, the Team view, the dashboard, and
  `refreshProviderUsage` / `recordProviderStatus` in `usage.ts` (§10.4).
- The real CLIs. Everything the fakes emit comes from the adapters' parsers, tests and
  documentation; the sentences of `quota` and `auth` are plausible, not captured.
- `resume` by conversation id (the server does not use it), and streaming.
- Windows.
- A quota pre-check from a vendor usage reading (§10.3 Selection 4, last sentence): no probe
  plants an exhausted vendor window.
