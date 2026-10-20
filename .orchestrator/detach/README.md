# Detach characterization + survival harness

Hermetic regression guardrail for the one-shot (`claude -p`) and detach dispatch paths.
It pins the default-path invariants **D1–D6** (see `../contract-detach.md` §4 and §8)
against the dispatch server, plus the Phase 2 **detach** survival probes
(**P2-1…P2-4**), the Phase 3 retrieval / concurrency / cancel / reaper-reconcile probes
(**P3-1…P3-5**), the Phase 4 adversarial-fix probes (**P4-F1…P4-F4**) that pin the fixes
for findings F1–F4 (see `../notes/P4-fix-wave.md`), and the release-2.0 probes
(**P5-1…P5-6**): the model rules and worker environment 2.0 pinned (`../contract-2.0.md`
§3.2, §1) and the result-file gate the reconcile fixtures have to satisfy. Every later
phase must keep all of them GREEN.

As of 2.0 the result text is two header lines, not one (`../contract-2.0.md` §3.2):

```
[worker: <account>, model: <model>]
task: <id> · output: <absolute path of tasks/<id>.md>

<the worker's text>
```

and a model is recorded and reported as its alias (a stored or requested
`claude-opus-4-8` runs and reads as `opus`). P0-1, P0-7, P2-1 and P4-F3 assert the whole
of it — see `assertResultHeader` in `probe.mjs`.

## Run it

```sh
npm run compile                       # from repo root — builds the three artifacts below
node .orchestrator/detach/probe.mjs   # from repo root
```

Exit code `0` iff every probe passes (26: P0-1…P0-7 + P2-1…P2-4 + P3-1…P3-5 +
P4-F1…P4-F4 + P5-1…P5-6); non-zero otherwise. One `PASS`/`FAIL` line per probe, then a
summary line that ends `ALL GREEN` only for a full run with no failure. The suite drives
three build artifacts and refuses to start when one is missing: `out/mcp/server.js`,
`out/mcp/run-task.js` (the detach supervisor, which the server resolves beside its own
bundle) and `out/registry.js` (the reaper and lock probes `require` it directly).

**P4-F3 is slow (~100s):** it drives a detach failover whose wall clock deliberately
exceeds the old single-attempt wait ceiling, to prove the liveness-aware wait relays it
inline. The rest of the suite is fast.

`--only <ids>` runs a subset while iterating: `--only P3-4,P5` runs P3-4 and every P5
probe. A partial run says so on its summary line and never prints `ALL GREEN`; the gate
is the full run.

### Running against another build

`CCO_DETACH_OUT_DIR=<dir>` points the suite at a build other than `<repo>/out`. The
directory needs the same three files (`mcp/server.js`, `mcp/run-task.js`, `registry.js`).
This is for the case where `npm run compile` cannot finish — `tsc` type-checks the whole
project, so one file mid-change elsewhere fails the build of everything — and for checking
a source change without disturbing `out/`:

```sh
T=$(mktemp -d)/out
npx esbuild src/mcp/server.ts   --bundle --platform=node --target=node18 --outfile=$T/mcp/server.js
npx esbuild src/mcp/run-task.ts --bundle --platform=node --target=node18 --outfile=$T/mcp/run-task.js
npx esbuild src/registry.ts     --bundle --platform=node --target=node18 --format=cjs --outfile=$T/registry.js
CCO_DETACH_OUT_DIR=$T node .orchestrator/detach/probe.mjs
```

Beware a FAILED `npm run compile`: `tsc` still emits, and its un-bundled
`out/mcp/server.js` and `out/mcp/run-task.js` overwrite the bundles, while the bundling
step after it never runs. `out/` then holds a build nobody ships.

`probe.mjs` handles all isolation internally — you do **not** set `HOME` or any
env yourself. Each probe:

- creates its own throwaway **fake HOME** (`os.homedir()` → an isolated
  `.claude-code-orchestrator`) with a crafted `registry.json` (two workers
  `wa`/`wb`, `claudePath` → the executable `fake-claude.mjs` stub, `acceptEdits`,
  both billing guards `block`), `usage.json` (both workers available, low
  windows, overage off, fresh), empty `stats.json`, and an empty `tasks/`;
- spawns `node out/mcp/server.js` with `HOME=<fakeHome>` + `FAKE_CLAUDE_MODE=<mode>`
  and a **temp workspace cwd** (never the repo root, so no `.mcp.json` loads);
- tears down its fake HOME and workspace afterward.

No network, no login, no real Anthropic tokens are ever used. The stub also
answers stray `auth status --json` / stream-json probes with a quick success so
nothing can hang.

## Files

- `fake-claude.mjs` — deterministic stand-in for the `claude` binary. Modes via
  `FAKE_CLAUDE_MODE`: `success` (default), `quota`, `hang`, `fail`, `delay:MS`
  (drives P2-2/P2-3), `failover` (config dir basename `wa` → quota, `wb` → success —
  drives P0-7), and `failover-slow` (same split, each response delayed
  `FAKE_CLAUDE_SLOW_MS`, default 50000 — drives P4-F3). With `FAKE_CLAUDE_RECORD=<file>`
  it appends one JSON line per invocation — `{pid, argv, cwd, envKeys, env}` — which is how
  a probe proves what was spawned, with which `--model`, under which environment, or that
  nothing was spawned at all. `envKeys` is every variable NAME; `env` holds VALUES only for
  the names in `FAKE_CLAUDE_RECORD_VALUES`, so the developer's own environment is never
  copied to disk.
- `helpers.mjs` — fake-HOME fixture builder (`makeFakeHome`, whose `workers` option
  replaces the two default accounts) + a minimal newline-delimited JSON-RPC stdio client
  for the server, plus `readResultJson(root, id)` for the detach handshake file,
  `recordingEnv`/`readFakeClaudeCalls`/`workerCalls` for the recorder above,
  `plantStaleLock`/`spawnUpdateStats` (P4-F1),
  `spawnFakeSupervisor(fakeHome, id)`/`spawnLooseRunTaskProcess` (P3-5/P4-F4), and
  `plantDeadDetachTask` — the reconcile fixture, described next.
- `probe.mjs` — the twenty-six probes; the entry point. The reaper probes plant a dead
  task and invoke `reapDeadTasks()` from `out/registry.js` in a child process under the
  fake HOME.

### The reconcile fixture (`plantDeadDetachTask`)

`tasks/<id>.result.json` sits at a fixed path that a dispatched worker can write, so the
reader (`readResultForTask` in `src/registry.ts`) believes a file there only when the
task's own event history says it may:

1. some event of the task records a numeric `supervisorPid` — only a detach supervisor
   writes one, so a history without it has no legitimate writer of that file;
2. the first event carrying `detachIoToken` fixes the token the file must echo as `token`.

A probe that wants "a dead detach task with a valid result file" therefore has to plant
what a real supervisor (`src/mcp/run-task.ts`) leaves: its four `running` events per
attempt (the core's identity event, the supervisor's token stamp of it, the core's pid
event, the token stamp of that) and its record with the echoed token. Until 2.0, P3-4 and
P4-F2 planted one bare `running` event and a bare record; the reader refuses that file,
so both probes reported `orphaned` instead of the reconcile they exist to test. That old
fixture is now pinned as a REFUSAL in P5-5, and P5-6 compares the fixture's shape with a
genuine supervisor's output so it cannot silently go stale again.

## Probes

| Probe | Invariant | What it pins |
|---|---|---|
| P0-1 | D1, 2.0 §3.2 | single-task inline text: line 1 `[worker: wa, model: opus]` exactly; line 2 `task: <id> · output: <path>` with the id being the logged task's and the path being its absolute, existing output file holding the same text; a blank line; then the worker's text and nothing else. The stored `claude-opus-4-8` is spawned as `--model opus` |
| P0-2 | D1 | batch header + `===== Task i: <title> =====` sections |
| P0-3 | D2 | `running`(no pid) → `running`(pid[,pgid on darwin]) → `done`(+usage) |
| P0-4 | D3 | output file has `## Result` + `- tokens: N in / N out` |
| P0-5 | D4 | stdin close → worker killed + `cancelled — orchestrator session ended` |
| P0-6 | D5 | `notifications/cancelled` → worker killed + `cancelled by the orchestrator session`, no reply |
| P0-7 | D6, 2.0 §3.2 | quota on `wa` → interim `quota error on wa — failing over` → `done` on `wb`; the result carries the full 2.0 header for `wb` under the one task id both attempts ran as |
| P2-1 | §3, §5.2/5.4, 2.0 §3.2 | `detach:true` (polite wait) → relay is the identical 2.0 inline string (both header lines, the second naming the supervisor's task and its output file); supervisor-authored `tasks/<id>.result.json` has `status:"done"` and `text === relay` |
| P2-2 | §5.1/5.3, R3 | SIGTERM the server mid-detach → detached worker survives; supervisor finishes and writes `done` + `result.json` post-mortem |
| P2-3 | §5.1/5.3, R3 | SIGKILL the server mid-detach → same survival guarantee |
| P2-4 | §4 D4, R2 | with detach wired, a DEFAULT task on stdin close is STILL killed (`p0_5` re-run) |
| P3-1 | §6 | `dispatch_status` after a detach `done` returns `status: done` + the result text (=== the relayed inline string); an unknown id → `not_found` |
| P3-2 | R4 | 5 concurrent detach supervisors each `recordSuccess` → `stats.json` stays valid JSON and totals exactly 5 tasks (the advisory lock loses no increment) |
| P3-3 | §7 R7 | cancel a hung detach mid-run → worker dies, supervisor records a `cancelled` terminal event + error `result.json`, and NO failover event is written |
| P3-4 | §7 R8 | a dead detach task as a real supervisor leaves one (dead worker pid, dead supervisor pid, token-bearing `running` events, a `result.json(done)` echoing the token) → `reapDeadTasks()` upgrades it to `done`, taking usage from `result.json`; the terminal event carries no token; a second sweep settles nothing |
| P3-5 | §7 R8 | a stuck `running` event with a dead worker pid but a LIVE `supervisorPid` (argv now matches the tightened `run-task.js` + `tasks/<id>.spec.json` check) → `reapDeadTasks()` does NOT orphan it (still `running`) |
| P4-F1 | R4, F1 | an abandoned (dead-pid) `stats.json.lock` + 8×20 concurrent `updateStats` writers → `stats.json` stays valid JSON, totals exactly 160 (identity-safe stale-break loses no increment), and the lock file is not leaked |
| P4-F2 | §6 R8, F2 | the same dead-detach fixture → calling `dispatch_status` (NOT `reapDeadTasks` directly) reconciles it to `done`, persists the event and returns the exact recorded text and usage — the reaper is reachable headless, with no VS Code host. The result token reaches neither the tool result nor the terminal event |
| P4-F3 | §3 D1, F3, 2.0 §3.2 | detach + slow multi-worker failover whose ~100s wall clock exceeds the OLD single-attempt ceiling but not the failover worst case → the polite client receives `wb`'s success INLINE with the full 2.0 header, not a spurious timeout error |
| P4-F4 | §5.5 R8, F4 | a `supervisorPid` naming a live process with `run-task` only in an unrelated filename (no spec path) → the tightened `isOurSupervisor` rejects it, so the dead task is ORPHANED rather than stuck `running` forever |
| P5-1 | 2.0 §3.2 | an explicit model that is not one (`"gpt-4"`, shell metacharacters, a number, 300 multi-line characters; also with a named worker) is REJECTED: `invalid model "<value, one line, ≤ 80 chars>" — use <the four aliases or a full id>`. No `claude` process of any kind is started, no task event and no output file is written, and `stats.json` gains no entry. A valid dispatch on the same server then runs (control) |
| P5-2 | 2.0 §3.2 | the same rejection through `detach: true` is word-for-word identical; still no worker run, no event, no output file, no worker failure — only the supervisor's own error `result.json` |
| P5-3 | 2.0 §3.2, §3.1 | which model a dispatch runs as, checked both in the header and in the recorded `--model`: `""`, `null` and absent → the worker's default (here `sonnet`, stored as `claude-sonnet-5`); `claude-opus-4-8` and ` OPUS ` → `opus`; a full id → itself |
| P5-4 | 2.0 §1, §P P1/P2 | the server is started WITH 13 session-identity variables and an OAuth token; on the one-shot path and through a detach supervisor the worker child gets none of the identity variables; a worker in the default directory (`$HOME/.claude`) has NO `CLAUDE_CONFIG_DIR` and keeps the host's token; a worker elsewhere gets its directory verbatim and not the token; unrelated `CLAUDE_CODE_*` user configuration passes through |
| P5-5 | 1.6 writer gate | a `result.json` nothing was entitled to write is REFUSED and the task settles `orphaned — …; a result file was present and refused` with no usage taken: no supervisor event (the pre-2.0 P3-4 fixture, verbatim), token-bearing events without a supervisor, a file that omits the token, a file with another token |
| P5-6 | 1.6 writer gate | a REAL detach run: every event records the supervisor; the result token is on the log before the worker exists, constant, on the latest running event, echoed by `result.json` and absent from the terminal event; `plantDeadDetachTask` plants events and a record of exactly the genuine SHAPE; with the genuine terminal event removed, the genuine leftovers reconcile to `done` (11/22) |

## Known coverage gap (R9 — Windows detach/cancel/pgid, NOT tested)

Windows detach/kill paths (R9 in the contract) are **not** exercised: this dev
machine is darwin. Specifically UNTESTED on Windows and NOT claimed to work:

- the detach cancel path — `.cancel` marker plus the worker signal — because the
  worker signal relies on a POSIX process group (`-pgid`), which Windows lacks
  (`terminateDetachWorker` → `signalWorker` falls to `taskkill /T` there, unexercised);
- `supervisorPid` reaper liveness — `isOurSupervisor(pid, id)` (tightened to match
  `run-task.js` AND this task's `tasks/<id>.spec.json`, contract F4) uses POSIX `ps`,
  so on win32 it returns `false` (degrades to "not ours"), meaning a detach task between
  worker attempts on Windows could be reaped as orphaned;
- detach cancel of a RUNNING worker on win32 is marker-only: `terminateDetachWorker`
  no-ops there because `isOurWorker` returns false without `ps` (the `taskkill /T`
  branch is unreachable from the cancel path), so only the `.cancel` marker takes
  effect between attempts — a worker already mid-run is not signalled (F5 honesty);
- the advisory file lock's stale-break relies on `ps`/pid semantics that are POSIX
  here.

Every existing `process.platform === 'win32'` branch in the touched files is
preserved. Declared gap to be logged in `../VERIFICATION-detach.md`, not silently capped.
