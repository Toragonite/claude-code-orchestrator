# mesh2 — offline harness for v2.0.0 session workers

A black-box check of the session-worker ("mesh mode") path of the dispatch server, written
from `.orchestrator/contract-2.0.md` alone. It drives the **real compiled server** over stdio
and replaces the `claude` CLI with a fake, so it needs no account, no session and no quota,
and it never touches the real `~/.claude*` or `~/.claude-code-orchestrator`.

## Run it

```sh
npm run compile                                   # builds out/mcp/server.js
node .orchestrator/mesh2/probe2.mjs --selftest    # proves the harness itself; no server needed
node .orchestrator/mesh2/probe2.mjs               # M1–M16, the extras X1–X20, then D1–D6
node .orchestrator/mesh2/probe2.mjs M4 M5         # a subset
node .orchestrator/mesh2/probe2.mjs --no-extras   # only the sixteen rows of the §9 table
node .orchestrator/mesh2/probe2.mjs --jobs 4      # up to four probes at once
node .orchestrator/mesh2/probe2.mjs --verbose     # print sandbox diagnostics for passes too
node .orchestrator/mesh2/probe2.mjs --list        # list the probes
```

Each probe prints one line, `PASS — <id> <name>: <what was observed>` or
`FAIL — <id> <name>: <expected vs observed>`, followed on a failure by what the sandbox
looked like (CLI invocations, `--bg` spawns, task events, ledger, server stderr). The run ends
with a cleanup line and a tally, and exits `1` if any probe failed, a fake process was left
running, or a sandbox was left on disk (`2` for a usage error or a missing server bundle).

A FAIL line distinguishes two kinds of expectation:

- a **row** expectation — what the table in contract §9 says for that probe;
- a **pinned** expectation, tagged `[§x.y]` — text or behaviour another clause spells out and
  that the same scenario makes observable (for example the `worker_cap` message of §5.2).

Anything the contract leaves open is reported as a note on the PASS line and never fails.

## Files

| File | What it is |
|---|---|
| `fake-claude2.mjs` | The fake `claude`. Scenario-driven emulation of `--version`, `--bg`, `stop`, `rm`, `agents --json [--all]`, `auth status --json`, the stream-json usage probe and the one-shot `-p --output-format json` run, following contract §P. |
| `helpers2.mjs` | Sandbox fixture (fake HOME, worker account dirs, a workspace, registry/usage/stats files, the scenario file; optionally vendor accounts with their own homes and a hermetic environment for the vendor CLIs), the JSON-RPC stdio client for the server, a direct runner for the fake, recursive directory snapshots, and process/sandbox cleanup. |
| `probe2.mjs` | The probes M1–M16 (one per row of the §9 table), the extras X1–X20, the vendor-account probes D1–D6, and the runner. |
| `selftest2.mjs` | The self-test behind `probe2.mjs --selftest`: cases S1–S18, S21 and S22 exercise the fake directly (no server, no build) and assert the files and processes it produces; S19 and S20 prove the vendor fixture (hermeticity, snapshots, bait processes); S99 checks that nothing was left behind. `--selftest S4 S12` runs a subset. |
| `README.md` | This file. |

## How a probe is isolated

Each probe (each sub-run of a probe) gets its own sandbox directory under the system temp
directory, named `cco-mesh2-<probe>-XXXXXX`:

```
home/                              HOME for the server and for the fake
  .claude/                         the CLI's default config dir (the "host" account)
    sessions/                      its session registry — present by default (see below)
  .claude-code-orchestrator/       the server's data root (registry.json, usage.json, stats.json,
                                   tasks.jsonl, tasks/, mesh/<hash>.json, bg-io/…)
  accounts/wa, accounts/wb         worker config dirs
  .codex, .cursor, .agy            vendor homes — only in a fixture with vendor accounts
ws-git/ or ws-plain/               the workspace (server cwd): a repo with one commit, or a plain dir
scenario.json                      what the fake should do; FAKE_CLAUDE2_SCENARIO points here
fake2.log.jsonl                    every fake invocation: argv, cwd, full environment, exit code
pids/                              one file per live fake process
bin/, login-shell, vendor-cli.log, login-shell.log, net.json, net.log.jsonl
                                   only in a fixture with vendor accounts (see "Vendor accounts")
```

**The host account has a session registry.** `home/.claude/sessions/` exists in every fixture
unless it is built with `hostSessions: false`. That is what a real host looks like: this
server's client is a Claude Code session, and that session's own entry lives in that
directory. It matters because the bridge mirrors a worker of ANOTHER account into it, and the
dispatch result's third line depends on whether that mirror exists when the dispatch settles:
`peer: <name> — steer with SendMessage(to: "<name>")` once the host account can see the
worker, `peer: <name> — not visible to this session's account yet (mirror pending); mesh_status
shows when it is` until then. M1 covers the first state (it holds the worker busy until the
mirror is there — the bridge sweeps every 2 s — and only then lets it report); X4 covers the
second, with no `sessions/` directory at all, where no mirror can ever be written.

The server is started with `HOME` pointing at `home/` and with every `CLAUDE*`,
`ANTHROPIC_*`, `CCO_*` and `GIT_*` variable of the calling shell removed. That matters: this
harness is normally run from inside a Claude Code session, whose identity variables would
otherwise reach the server and blur what M2 and M3 measure.

Cleanup runs in a `finally` for every probe, including one that failed or hit its timeout:
the server is ended (stdin EOF, then SIGKILL), every process the fake started is SIGKILLed,
and the sandbox is removed. A pid is only signalled when it is still the process that was
recorded — its command line carries this sandbox's root, or it started when the record says
it did — because pids are recycled within minutes on a busy machine and, with `--jobs`, a
stale pid can come back as another probe's live worker.

One process deserves a note: at session end the server fires `claude stop <id>` (then
`claude rm <id>`) **detached**, so those outlive it. Cleanup waits for a quiet window and
finds them in the process table by job id; the fake itself can never re-create a sandbox
that has been removed (every directory it makes is created non-recursively beneath one that
still exists); and the run ends with a sweep that kills any late one and says so on the
`cleanup:` line. The run fails only if a process survives that sweep or a sandbox is still
on disk.

Three independent safety nets keep a worker helper from outliving a harness that was itself
killed: it exits when its job file disappears, it exits after 10 minutes, and the fake
refuses to run at all (exit 97) without a scenario file or with a config dir outside the
sandbox root.

## The fake

`FAKE_CLAUDE2_SCENARIO` must name a JSON file; without it the fake exits 97. The config
directory is resolved as the real CLI resolves it — `CLAUDE_CONFIG_DIR` when set and
non-empty, otherwise `$HOME/.claude` — and the fake never writes a `.claude.json`.

`--bg` parses its argv the way the real CLI does, including the variadic `--allowedTools`
(a prompt placed directly after it is swallowed and the session starts idle, P8). It records
argv and environment, prints `backgrounded · <8 hex> · <name>`, and leaves a detached helper
that plays the worker: it writes `<configDir>/sessions/<pid>.json`
(`{pid, sessionId, jobId, name, kind:'bg', peerProtocol:1, version, cwd, status, updatedAt,
messagingSocketPath}`), a transcript under `<configDir>/projects/…/<sessionId>.jsonl`, and
acts out the scenario. With `-w` in a repository it creates a real git worktree at
`.claude/worktrees/<name>` on branch `worktree-<name>`. The helper finds the task file, the
result path and the task id by **parsing the bootstrap prompt** (§4.6); the `--add-dir` value
is the fallback, and the log records which source each value came from.

**The result token is read the way a real worker is told to read it: off the FIRST LINE of the
task file** (`<!-- cco-io-token: <hex> -->`), and only there (`promptInfo.from.token ===
'task-file-line-1'`). A line of that shape further down the file is the task's own text; the
fake counts such lines (`promptInfo.taskFileOtherTokenLines`) and never reads them. The
bootstrap prompt is a command-line argument and must not carry the token: the fake records
whether it does (`promptInfo.promptCarriesToken`) and never uses it. S4 and M2 fail when that is
`true`, and X9 checks every recorded argv, the spawn environment, the process table and
`tasks.jsonl` for the token. A task file that cannot be read means no task and no token — the
fake worker then writes **no** result file and ends its turn, as the prompt says.

Scenario file keys (all optional):

| Key | Meaning |
|---|---|
| `version` | `--version` output. Default `2.1.283 (Claude Code)`. |
| `bg.default` / `bg.sequence[]` / `bg.byAccount{}` | What a `--bg` worker does. `sequence` is indexed by the order of `--bg` invocations and beats `byAccount` (keyed by config-dir basename), which beats `default`. An entry is a scenario name or `{kind, …knobs}`. |
| `timing` | `resultDelayMs` (150), `parkDelayMs` (150), `dieAfterMs` (2500), `entryDelayMs` (0), `maxLifetimeMs` (600000). Also accepted as per-entry knobs. |
| `waitingFor` | Text for `park-waiting`. |
| `rm` | `auto` (default: decide from the worktree, per P7), `removed`, `kept`. |
| `enforceTrust` | `true`: refuse `--bg` with the P9 message unless the account's `.claude.json` trusts the workspace root. |
| `bypassDisclaimerAccepted` | `true`: allow `--bg` in `bypassPermissions`. By default it is refused, as on the real CLI (P5). |
| `oneShot`, `auth`, `usage` | Canned replies for the one-shot run, `auth status --json`, and `get_usage`; each takes `byAccount` overrides. |

`--bg` scenarios: `result-done`, `result-error`, `park-no-result`, `park-waiting`,
`wrong-token`, `die`, `never`, `untrusted`, `bypass-refused` (the nine of §9), plus
`wrong-task-id`, `not-json`, `oversize`, and four more ways of getting the result wrong:
`placeholder-token` (the stand-in the prompt's JSON template shows, copied where the value
belongs), `header-line-token` (the whole first line of the task file as the token), `no-token`
(no `token` member), `symlink-result` (a well-formed result with the RIGHT token, written beside
the result path, and the result path made a symbolic link to it). The scenario file also takes
`stop: { fail: true }`, which makes every `claude stop` exit 1. Per-entry knobs worth knowing: `report`,
`writeFile:{name,content}` (edit a file in the working tree before reporting),
`dieLeavesEntry:false`, `holdPipes:true` (the helper keeps the launcher's stdout/stderr open,
P16), `then` (what `bypass-refused` does once it is not refused).

A live worker can be told to change course — `fx.command(jobId, 'result-done')` writes
`<job file>.cmd`, which the helper picks up within 40 ms. M11 uses it to make a `never`
worker report.

`__bait` is not a CLI surface at all: `fx.spawnBait({ asCli: true })` starts the fake through a
symbolic link named `claude` with that single argument, and it then stays alive doing nothing —
a process whose command line names the CLI and that is nobody's worker (X11, X12, S22). It ends
when its sandbox is removed.

One command exists only on that channel: `impostor`. The helper stays alive with its session
entry exactly as it was, and sets its process title, so that `ps` no longer shows a command line
naming the fake (or `claude`). From outside that is what a recycled pid looks like: the entry
still names the pid, and the pid is somebody else. Such a helper is no longer recognisable to the
harness's cleanup by its command line; it ends itself when its job file disappears (S21), and
X13 kills it explicitly.

Where the fake goes beyond what contract §P states, so that a surprise can be traced:

- `agents --json` (without `--all`) still lists a session that **died without a clean stop**,
  with `state:"working"` and no `pid`/`status`. That is the observation recorded in
  `src/mesh/bg-liveness.ts` ("presence is not liveness; the pid is"), not a line of §P; set
  `agentsHideCrashed: true` to turn it off.
- A live row's `status` is the registry entry's own value, so a waiting session lists as
  `waiting` (with `waitingFor`), not `idle`.
- A clean end (`stop`, SIGTERM) removes the registry entry; `die` leaves it behind with a dead
  pid, as a crash does (P3).
- The first `--bg` under a config dir prints `Starting background service…` on stderr (P8
  says it "may").
- Messages for cases §P does not quote (unknown model, unknown job id, `-w` outside a
  repository) are the fake's own wording; only the exit codes are meant.

## The probes

| # | What is driven | Row expectation |
|---|---|---|
| M1 | mesh on, a worker that reports `done` once its entry is mirrored into the host account, git workspace | 2-line header + `peer: <name> — steer with SendMessage(to: "<name>")`; `done` event; ledger record has `settledAt` |
| M2 | one dispatch in a git workspace, one in a plain directory; the server is started WITH all thirteen session-identity variables, an OAuth token and two pass-through variables | argv order per §4.2; `--settings` only with `-w`; no `CLAUDE_CODE_MESSAGING_TOKEN` / `CLAUDECODE`; `CLAUDE_CONFIG_DIR` = the worker's dir; the result token on line 1 of the task file and in NO argv element (the prompt shows a stand-in) |
| M3 | the only worker lives in `$HOME/.claude`; run once with no `~/.claude.json` and once with one (trust enforced from it) | spawn env has no `CLAUDE_CONFIG_DIR`; `$HOME/.claude.json` not created / byte-, mtime- and inode-identical |
| M4 | `park-no-result` | error "ended its turn without writing the result file" within grace + 2 ticks; worker still alive, no `stop`/`rm` |
| M5 | `park-waiting` | the same, and the text carries the `waitingFor` value |
| M6 | `wrong-token`, then the worker parks | never `done`; ends by the parked path or the (2-minute) timeout |
| M7 | `die` after 2.5 s | the death-path error, not a hang |
| M8 | `untrusted` | result prefixed `⚠ ran as a one-shot worker (not attachable)`; `done` via the one-shot fake |
| M9 | registry `permissionMode: bypassPermissions` | every `--bg` argv carries `acceptEdits` |
| M10 | `--version` prints 2.1.200 | one-shot fallback, `⚠ mesh unavailable` prefix naming 2.1.200 and 2.1.283 |
| M11 | cap 1, first worker `never` | second dispatch refused `worker_cap`; after the first reports and parks, a third is accepted |
| M12 | `tools/list` | exactly the seven tools |
| M13 | `initialize` with `2025-11-25`, `2099-01-01`, no version | `2025-11-25` each time |
| M14 | `model` = `gpt-4`, `""`, `claude-opus-4-8`, `OPUS`, with mesh on and again with mesh off | rejected with the hint / worker default (`sonnet` in this fixture) / `opus` / `opus` |
| M15 | `mesh_status` before and after a dispatch | no gateway / live feed / keep-alive / idle auto-stop text; has `dispatches in flight:` |
| M16 | a first session writes a ledger; the harness adds `gatewayName` and `keepAlive:true`; a second session uses it | it loads; after the next write both keys are gone and the old record is still there |

Extras, outside the §9 table (skip them with `--no-extras`):

| # | What is driven | Expectation | Clause |
|---|---|---|---|
| X1 | the data root has **no** `mesh/` directory | the first dispatch still runs as a session worker | a machine that has never run mesh mode (every M probe starts with `mesh/` present) |
| X2 | the `--bg` child keeps its stdout/stderr open | `done` in well under the 30 s spawn window | P16, §4.2 `runMeshProcess`, §F |
| X3 | result files with a wrong task id, not JSON, oversize | none settles as `done` | §F |
| X4 | the host account has **no** `sessions/` directory, so the bridge cannot mirror | result line 3 is `peer: <name> — not visible to this session's account yet (mirror pending); mesh_status shows when it is`, and `mesh_status` says `peer: not visible … (mirror pending)` for the same worker, never `SendMessage(to: …)` | §4.1 `peerVisible`, §5.4, providers §11 F4 |
| X5 | **no worker account** has a `sessions/` directory (accounts that have never run a session), and a stale mirror — `ccoMirror: true`, a LIVE pid, no source anywhere — sits in the host account; then one dispatch, which gives one account its first session | `mesh_status` never says `degraded`, before or after the dispatch; the stale mirror is pruned within a few sweeps (the bridge has a complete picture, so it prunes by the live set) and the process it named is untouched; the bridge line says `1 participant(s)` before the dispatch and `2 participant(s), 1 mirror(s)` after it — the account's `sessions/` directory appeared after the bridge had started | §4.4, known-issues K6, fixes §4.7 |
| X6 | one worker account's `sessions/` **exists with mode 000**; the other has none; the same stale mirror | the bridge line says `(degraded: unreadable dir <that directory>; prune limited this sweep: …)` and does not name the account that merely has no directory; the stale mirror is KEPT (with an incomplete picture only mirrors of dead processes may go). Reported as not exercised when this user can read a mode-000 directory (root) | §4.4, known-issues K6 |
| X7 | the ledger's write lock (`<state>.write.lock`) is **held by a live process** — a symbolic link carrying a 2.0 token that names the harness itself — while a dispatch spawns its worker; the first account is NAMED `quota`, so the refusal text (which quotes the worker's name) carries a word the quota classifier knows | the dispatch FAILS after two 15 s waits with `… could not be recorded in this workspace's mesh ledger … was stopped again … Could not lock …`, the lock's own message whole (the pid holding it, the lock file); exactly one `--bg` spawn (no failover) and no account on a cooldown, `claude stop <job>` for it, its process gone, no ledger record, the planted lock untouched; once the lock is removed the next dispatch runs and is recorded | §4.2 (a spawned worker is recorded before the spawn returns), known-issues K4, fixes §4.7 |
| X8 | a worker account's `.claude.json.cco.lock` is found **already there with nobody holding it** — once as an empty file an hour old (what an earlier build leaves after a crash), once as a symbolic link carrying the token of a dead process — and the fake CLI enforces trust from that account's `.claude.json` | both times the dispatch runs as a session worker (one accepted `--bg`, no `⚠ ran as a one-shot worker`), the `.claude.json` records this workspace's trust decision with its other keys kept, and the lock is gone afterwards | §4.2 `prepareAccount`, known-issues K5 |
| X9 | one dispatch whose worker stays busy, looked at from OUTSIDE the task's io directory; the dispatched prompt and system prompt BEGIN with a line shaped like the token line | line 1 of the task file is the server's token line and the caller's three look-alike lines sit below it; the token is in no argv element of any CLI call, in no environment variable of the spawn, on no command line of `ps -axww`, not in `tasks.jsonl` (whose RUNNING events carry its SHA-256 and no `ioToken`), and nowhere else under the data directory; io directories are 0700 and the task file 0600; result files FORGED from all of that (the digest and its halves, every long hex run in the log and on the command lines, the prompt's stand-ins, the look-alike token) are each refused — `mesh_status` counts them and quotes none — with the dispatch still in flight; the genuine report then settles it `done` and the io directory is removed | fixes §4.1–§4.4 |
| X10 | five dispatches, one per way of getting the token wrong: `placeholder-token`, `header-line-token`, `no-token`, `wrong-token`, `symlink-result` | none settles; each failure says `A result file at … was found and REFUSED: the worker's result was refused because its token was missing or wrong; the token is on the first line of the task file (…)` and names its own mistake (`the placeholder was copied …`, `the header line was copied …`, `… no token at all`, `a value of the right shape that is not this task's token`) — for the link, `… what is at the result path is not a regular file …`; neither the expected token nor the presented value is quoted, and the refused report is not relayed | fixes §4.1 |
| X11 | `mesh_stop_worker { force: true }` with a `claude stop` that fails: once for a live fake worker, once for a worker that was killed and whose session entry (stating no start time) now names an unrelated process (a bait). Then the pool alone, over five planted records whose entries name baits: two that are not the CLI and three that ARE by their command line (`fx.spawnBait({ asCli: true })`), under entries that say the session started a minute before the bait did, that were written after the bait started, or that state no start time | the live worker is killed and its record marked stopped; for the bait the stop is refused with `mesh error [stop_failed]: … not stopped: could not confirm pid <n> is the worker`, the bait is still running and the record is not marked. Pool alone: not the CLI + no start time → refused; not the CLI + younger than the session → `sessionStatus` is `gone` at the first look and the stop answers "session was already gone" without signalling; CLI-named + younger than the session → REFUSED and still running; CLI-named + entry written after it started → signalled; CLI-named + no start time → signalled (the command line decides alone) | fixes §4.5 |
| X12 | a server crashes with three workers running; one worker's session entry is made to name a bait that is not the CLI, another's a bait that names the CLI but started a minute after the session the entry describes; the next server's orphan sweep runs with a `claude stop` that fails | the orphan whose entry names its own process is killed; neither bait is signalled, the workers behind the moved entries are untouched, their records are not marked stopped, and the server's stderr says `could not confirm pid <n> is the worker` for both | fixes §4.5 |
| X13 | a busy worker is told `impostor`: its pid stops being the CLI while its session entry stays `busy` | the dispatch fails by the DEATH path about one death grace (10 s) later, not at its one-minute timeout; the process is never signalled and no `claude stop` / `claude rm` runs for it | fixes §4.5 (the liveness reading) |
| X14 | `dispatch_task` with `prompt: 123`, with `ultrathink: "yes"`, and with a 10 MB three-line title | the first two are refused with the checker's own sentence (`invalid prompt — expected a string, got a number`, `invalid ultrathink — expected true or false, got a string`), no worker started, nothing in the task log; the third runs, and its title is one line of at most 200 characters in every event, with `tasks.jsonl` and the output file small | fixes §4.6 |
| X15 | `<ledger>.<pid>.tmp` and `<account>/.claude.json.<pid>.tmp` planted for a DEAD pid (ten minutes old), for a LIVE pid, fresh, and under non-matching names; then one dispatch that writes both files | the dead pid's two old temp files are removed by the next write; every other one is left alone | fixes §4.7 |
| X16 | one dispatch whose worker stays busy, ended three ways — the registry intact, the registry replaced by unparseable text, every worker account removed from it — and then the session ends. Beside it a planted record that NAMES the running server as its owner, under the second account, which that server never started a session under | in all three, `claude stop <job>` is run for the worker under the account it was started under, the worker is gone and its record is marked stopped. The planted record is stopped too while the registry lists its account; otherwise no command is run for it, it is not marked, and the server's stderr carries exactly ONE line naming it, the reason, and `claude stop <job>` | fixes §10.1 |
| X17 | a server crashes with a busy worker; the worker's account is then removed from the registry; the next server runs `mesh_status`, `dispatch_status` and `mesh_stop_worker` | the worker's line reads ``unknown (its account is not configured in this version — it may still be running; stop it with `claude stop <job>` under that account)`` — never `dead`, `alive` or `stopped`; no `claude` invocation is aimed at that account; the worker is not signalled, its record is neither marked stopped nor settled, it is still counted in flight (`1/…`) and not as parked, its task is still `running`, the sweep says one line on stderr, and `mesh_stop_worker` refuses it | fixes §10.1 |
| X18 | a server crashes with a worker in flight on a 30-minute budget — once a worker that never reports, once one that writes its report after the crash — and the next server's `mesh_status` runs the orphan sweep, which stops the worker | the FIRST `dispatch_status` after the stop reports the task as over, in under 20 s: `error … orphaned` with a note saying the worker was stopped by this session's own sweep, or `done` with the worker's own report; exactly one terminal event, and a second call changes nothing | fixes §10.3 |
| X19 | two tasks planted as 1.5.3 left them — a `running` event with the plain token and no timeout, a ledger record with no deadline, a valid `result.json` — one whose owner pid is dead, one whose owner is a live process started before its record was written | the first is `done` with its report on the first `dispatch_status`; the second stays `running` while its owner lives and is `done` on the first call after the owner is killed; nothing is started or stopped | fixes §10.4 |
| X20 | the two crashes of X18, but NO `dispatch_status` is sent: the next server's first mesh call (`mesh_status`) runs the orphan sweep, and `tasks.jsonl` is read directly for up to 2 s after that call | the task's terminal event is in the log within those 2 s — `error … orphaned` with the note naming the sweep, or `done` with the worker's report; a `dispatch_status` afterwards reports the same outcome and adds no second terminal event; nothing about the settle on stderr | fixes §10.3 |

## Vendor accounts (D1–D6)

Since 2.0 a registry worker can be an account on another vendor's CLI — Codex, Cursor,
Antigravity — and its `configDir` is then THAT vendor's home (`~/.codex`, …). Decision D2 of
`contract-2.0-providers.md` §12: everything that treats a directory as a Claude config dir must
only ever see Claude Code accounts. A real `~/.codex` has a `sessions/` directory of its own,
with another meaning; and a `claude` process started with `CLAUDE_CONFIG_DIR` naming a directory
creates Claude config files inside it.

Each D probe registers one Claude worker (`wa`; D5 and D6 add more), one Codex worker
(`cx`, FIRST in the registry) and one Cursor worker (`cu`), with mesh mode on, in a plain
workspace. Every one of them ends with the same four checks (`assertVendorsUntouched`):

- over the fake's **whole call log** — `--bg`, `agents`, `stop`, `rm`, `-p`, anything — no
  invocation resolved a vendor home as its config dir or carried one in `CLAUDE_CONFIG_DIR`;
- a **recursive listing of both vendor homes** (every entry: type, size, mtime, content hash;
  directory mtimes included, so a file created and removed again is still seen) is identical
  before and after;
- no vendor CLI was started (`vendor-cli.log` is empty) and no network request was attempted;
- the fake refused or misunderstood nothing.

| # | What is driven | Expectation |
|---|---|---|
| D1 | the whole lifecycle: `mesh_status`, a dispatch, a server **crash** (SIGKILL), a restart (orphan sweep with its `claude agents` probe, `stop` + `rm` of the orphan, `adopt`), another dispatch, an untrusted workspace (the one-shot `-p` fallback), a clean session end (the detached `stop` + `rm`), one more restart | the default dispatch runs on `wa` although a healthy-looking Codex account is listed first; the call log holds every kind of call and none is aimed at a vendor home; `mesh_status` names no vendor directory in any of the three sessions |
| D2 | each vendor `sessions/` holds a file that is exactly what a live session worker of this workspace registers (live pid, this workspace's name prefix with sequence numbers 41 and 57, a job id, a messaging socket) | the next worker is named `…-wa-2`, not `…-wa-58` (the sequence scan); no ledger record names a bait or a vendor dir (`adopt`); nothing is mirrored into the host account, while the Claude worker's entry is (`bridge: 2 participant(s), 1 mirror(s)`, not degraded); `mesh_status` lists no vendor directory and no bait; both bait processes are still running |
| D3 | three ledger records planted by hand, each naming a vendor directory: one carrying the job id of a worker that is LIVE under `wa`, one with a live bait entry waiting in the vendor `sessions/`, one recording the running server as its owner | `mesh_status` reports each vendor directory as not checked, shows no such record as alive and prints no `claude` command naming a vendor directory; `mesh_stop_worker` by job id, forced, and by name refuses (`… was NOT stopped … not a Claude Code account …`); the bait process survives; after a session end none of the three records is marked stopped; the genuine orphan under `wa` is swept as usual |
| D4 | a crashed dispatch whose ledger record is re-pointed at the Cursor home, where `projects/<x>/<job id>-….jsonl` holds a transcript-shaped bait; `dispatch_status` then settles the overdue task | settled as an error; the bait text is published nowhere; the note says the transcript was NOT LOOKED FOR because the directory is not a Claude Code account |
| D5 | the pool called **directly** through the IWorkerPool seam of contract §4.1 (the compiled `out/mesh/pool.js`, in a child process inside the sandbox): `spawnDispatchWorker` under the Codex dir, the Cursor dir (with a trailing slash), a directory no account has, a Claude worker, the host account, and a Claude worker removed from the registry in between; then `sessionStatus`, `workerLiveness`, `list`, `stop(force)` and `adopt` over a planted record that names the Codex dir, with a live bait entry in it | the four non-accounts are refused with `mesh error [spawn_failed]: … not a Claude Code account …` — no `claude --bg`, nothing created, the directory not quoted in the text — while the two real accounts spawn; the planted record reads as `unknown` / not alive / `attachCommand` that is not a command / stop refused with `capability_failed` / nothing adopted; the bait process survives and the record is not marked stopped |

| D6 | the keep-alive sweep called **directly** (the compiled `out/keepalive.js`, in a child process inside the sandbox), twice, over a registry of two idle Claude workers, a worker entry pointing at the host's own directory, and the two vendor accounts — all five with a fresh, healthy-looking usage reading | exactly two `claude -p … --model haiku` pings, for `wa` and `wb`; `keepalive.json` holds a stamp for those two directories and nothing else; the second sweep pings nobody; no other CLI call |

D5 and D6 are the two probes that do not go through the server. D5: the server only ever hands
the pool a Claude Code account, so nothing above it can show what the pool does when handed
something else — and the pool is the last place that can refuse: below it are the
session-registry scan, the `.claude.json` pre-seed and `claude --bg` itself. D6: the keep-alive
sweep belongs to the extension host and has no server tool in front of it. Both need the `tsc`
output next to the bundle (`<bundle dir>/../mesh/pool.js` and `<bundle dir>/../keepalive.js`,
which `npm run compile` writes); `MESH2_POOL_JS` / `MESH2_KEEPALIVE_JS` point them elsewhere,
and each FAILS rather than passes when its module is not there.

D2–D5 fail against a build without the D2 changes in `src/mesh/pool.ts` and
`src/mesh/reaper.ts` (checked by building one): the next worker comes out as `…-wa-58`, both
baits are adopted, `claude --bg` / `agents` / `stop` run with a vendor home as their config
dir and leave files in it, a forced stop kills the bait process, and D4 publishes the bait
text. D6 fails against a `keepalive.js` whose account list is the whole registry: it then pings
`.codex` and `.cursor`, because a vendor account's usage reading passes every other guard the
sweep has. D1 is the lifecycle invariant on its own and holds on both builds — the
dispatch-server half of D2 (probes, bridge participants) already kept an untouched vendor home
untouched.

### How a vendor fixture stays hermetic

The machine this harness runs on usually has the real `codex`, `cursor-agent` and `agy`
installed and logged in, and none of them may ever be started. A fixture built with `vendors`
(and only such a fixture — the others register no vendor account, so the server never looks for
one of those CLIs) therefore gets, in the pattern of `../providers/helpers.mjs`:

- `bin/codex`, `bin/cursor-agent`, `bin/agy`: **stubs** that append their argv to
  `vendor-cli.log` and exit 97, plus `bin/node` (a symlink, for the fake's `#!/usr/bin/env node`);
- `login-shell`: the server resolves a bare CLI name with `$SHELL -lc "command -v <name>"`; this
  script reads no profile and searches the sandbox `PATH` only, logging each lookup;
- an environment built from an allow-list (`TMPDIR`, `LANG`, `LC_*`, `USER`, `LOGNAME`, `TERM`,
  `TZ`) with `PATH=<sandbox>/bin:/usr/bin:/bin:/usr/sbin:/sbin`, `SHELL` = that script, and
  `../providers/net-guard.cjs` preloaded (read-only reuse: it stubs `fetch` and refuses every
  non-loopback socket);
- `fx.assertHermetic()`, run before every server start: each of the three names must resolve to
  its stub, through the sandbox login shell and through a plain `PATH` walk, or the fixture
  refuses to start anything (`REFUSED TO RUN — …`).

The vendor homes are seeded with files of the vendor's own (`config.toml`, `history.jsonl`,
`sessions/…`, `cli-config.json`, `projects/…`) and with **no credential file**, and every entry
is given an old mtime so that even a byte-identical rewrite is visible. A planted session entry
needs a live pid to be bait at all; `fx.spawnBait()` starts a sacrificial process for that — never
the harness's own pid, because code that takes the entry for one of its workers may SIGKILL it
(the unfixed build does exactly that in D3).

## Slow probes and timing overrides

The server is started with the two test-only overrides the contract allows:
`CCO_TEST_PARK_GRACE_MS=600` and `CCO_TEST_LIVENESS_TICK_MS=200` (production: 45 000 and
15 000). With them honoured the whole run takes about two minutes sequentially and under one at `--jobs 4` on an otherwise idle machine (several times that on a loaded one). A server
that ignores them still has to pass, only slower, so the timeouts are sized for production:

| Probe | Why it can be slow | With overrides | Without | Probe timeout |
|---|---|---|---|---|
| M4, M5 | the parked verdict needs the park grace plus up to two liveness ticks (45 s + 2 × 15 s) | ~1 s after the worker parks | up to ~80 s | 150 s |
| M6 | the wrong-token worker then parks: the same grace; if there were no parked path, the 2-minute dispatch timeout ends it | ~2 s | up to ~80 s (or ~135 s by timeout) | 215 s |
| M7 | a death is seen on a liveness tick, then a fixed 10 s death grace runs (no override exists for it). The worker lives 2.5 s: long enough to be seen alive by a 200 ms tick. With a 15 s tick it is never seen alive, so the server must first wait out the 90 s entry-appear grace | ~13 s | ~115 s | 185 s |
| X3 | two of its three workers end by the parked path | ~4 s | up to ~80 s | 215 s |
| X7 | the ledger write is attempted twice, and each attempt waits out the 15 s the lock gives a live holder (no override exists for it) | ~32 s | ~32 s | 300 s |
| X10 | five dispatches in a row, each ending by the parked path | ~8 s | up to ~400 s | 600 s |
| X13 | the fixed 10 s death grace after the liveness tick that sees the pid is no longer the CLI (on a build without that reading: the one-minute dispatch timeout) | ~12 s | ~45 s | 240 s |

M4 and M5 also assert a floor (the settle must not come before a grace has run: 360 ms with
the default override, 20 s under `MESH2_NO_TEST_OVERRIDES=1`) and report on the PASS line
which timing the server used.

## Environment variables the harness reads

| Variable | Effect |
|---|---|
| `MESH2_SERVER_JS` | Server bundle to test instead of `out/mcp/server.js`. |
| `MESH2_POOL_JS` | Compiled pool module for D5 instead of `<bundle dir>/../mesh/pool.js`. |
| `MESH2_KEEPALIVE_JS` | Compiled keep-alive module for D6 instead of `<bundle dir>/../keepalive.js`. |
| `MESH2_NO_TEST_OVERRIDES=1` | Do not pass `CCO_TEST_*` to the server: run on production timing. |
| `MESH2_PARK_GRACE_MS`, `MESH2_LIVENESS_TICK_MS` | Values for the two overrides (defaults 600 and 200). |
| `MESH2_KEEP=1` | Leave sandboxes on disk for inspection (processes are still killed). |
| `MESH2_VERBOSE=1` | Same as `--verbose`. |

Variables it sets for the server: `HOME`, `FAKE_CLAUDE2_SCENARIO`, `CCO_TEST_PARK_GRACE_MS`,
`CCO_TEST_LIVENESS_TICK_MS`; M2 additionally sets the thirteen session-identity variables,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and `MESH2_PASSTHROUGH_SENTINEL`.

## What this harness assumes about the server

The contract does not state these; the harness relies on them:

- A worker name is `cco-w-<6 hex>-<account>-<seq>` (D2–D4 read the workspace's 6 hex from the
  first worker's name to build bait names).
- The `--add-dir` value of a `--bg` spawn is the task's io directory, holding `task.md` and
  `result.json` (X9 reads the first and writes the second), and `mesh_status` prints one
  `rejected result files: <n>` line, with the newest refusal under it, once a result file was
  refused.
- The server recognises a worker's process by the basename of the configured `claudePath`
  (here `fake-claude2.mjs`) or `claude` on its command line (X11–X13), and — before it signals
  one — by its start time against the `startedAt` of the session entry that names its pid. The
  fake writes `startedAt` into every entry: the launcher's clock just before it starts the
  helper, so a helper's process is a few milliseconds YOUNGER than its entry says, inside the
  five seconds the server allows.
- A ledger record carries `name`, `account`, `configDir`, `jobId`, `model`, `role`, `spawnedAt`
  and optionally `pid`, `taskId`, `ownerPid`, `ownerStartedAt`, `deadlineAt`, `stoppedAt`
  (D3 and D4 plant and edit records).
- `mesh_status` prints one `bridge: <n> participant(s), <m> mirror(s) …` line, with
  `(degraded: …)` inside it when the bridge is not healthy, and names a config dir it did not
  probe on a line that says so (`… not probed …` / `could not check`).

- The ledger is the only `<hex>.json` file under `<data root>/mesh/`. The harness finds it by
  listing that directory, so it does not depend on how the workspace hash is computed.
- Task events carry `title`, `status`, `id`, `worker` and `outputFile`, as they did in v1.x.
- A tool failure is a `tools/call` result with `isError: true` and its message in
  `content[0].text`; an unknown tool is a JSON-RPC error.
- `usage.json` keeps its v1.x shape (§2.4 says the cache format is unchanged), so a fresh
  healthy reading per worker lets selection proceed without a live probe.
- With two workers and a fresh server, the first dispatch goes to the first worker. Probes
  read the account from the spawn log rather than assuming it, except M14, which gives both
  workers the same default model.

## What it does not cover

- Real cross-session messaging (`SendMessage`, permission-class holds): the fake has no
  messaging socket behind its `messagingSocketPath`. The bridge's MIRROR FILE is covered (M1,
  X4, D2); whether a message addressed through it arrives is not.
- A vendor worker actually running a task, and `list_workers` / the usage refresh with vendor
  accounts registered: that is `../providers`. The D probes never ask for either, which is why
  "no vendor CLI was started" can be asserted outright.
- The rest of the extension host: the dashboard, the Team view, and the Tasks-tree cancel of a
  session worker (which runs `claude stop` / `claude rm` under the directory a LEDGER RECORD
  names, from `src/views.ts`).
- The dispatch timeout path itself and cancellation (unchanged from v1.x per §5.2).
- Whether a real MODEL copies the token from line 1 of its task file: the fake does it by
  construction. That takes one dispatch on the real CLI.
- What the command line of a real `claude --bg` session looks like in `ps`: the identity checks
  of X11–X13 are driven with the fake's own name.
- Quota stall on a parked worker (§5.2 step 2): the fixture's usage reading is healthy.
