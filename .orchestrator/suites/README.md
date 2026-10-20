# Offline extension-host suites

Nineteen suites that exercise the extension host and its data modules without an editor, without a
network and without any agent CLI. They were written over several fix waves in a session scratch
directory; this directory is where they live now. One command runs all of them:

```
bash .orchestrator/suites/run.sh
```

It prints one line per suite — `<name>  exit <code>  <passed> passed, <failed> failed[, <n> skipped]  (<seconds>s)` —
then a summary, and exits 0 only when every suite that ran passed. A full run takes about
**3 minutes 40 seconds** on a quiet machine (the slowest: `probe-kshell` 80 s, `dash-matrix` 60 s,
`ladder` 28 s, `probe` 21 s, `f1` 15 s; the other fourteen together about 20 s).

```
run.sh --only f1                    one suite
run.sh --only model,team,hostile    several
run.sh --out /tmp/my-run            use this run directory (not inside the repository) instead of a fresh one
run.sh --list                       the names, in run order
```

The newer, per-fix tests are beside this directory, in `.orchestrator/fixes/`. They are not run from here.

## What a run does

1. Makes a **run directory** under the system temp directory (`$TMPDIR/cco-suites.XXXXXX`, or `--out`).
   Nothing is ever built into `out/` or written into the repository.
2. Builds only what the selected suites read: the extension compiled by `tsc` into `build/out`, and
   single-file `esbuild` bundles of `usage`, `keepalive`, `sessionLitter` and of
   `uiModel + team + displayText` into `build/bundle`. A build that fails stops the run (exit 1) —
   that is the usual sign of a source file being mid-edit; wait and run again. The line
   `built <time> — newest source file: …` says which tree a run tested.
3. **Stages** a copy of this directory in `stage/` and runs every suite from that copy, one at a time.
   The suites write fixtures beside themselves; `lib/staged.js`, which each of them requires first,
   refuses to start anywhere else.
4. Gives each suite an environment with nothing inherited (`env -i`): a scratch `HOME` inside the run
   directory, a temp directory of its own inside the run directory (`f1` alone keeps the system temp
   directory — it binds unix sockets and needs short paths), and a `PATH` whose first entry holds
   stand-ins named `claude`, `codex`, `cursor-agent` and `agy`. A stand-in only records that it was
   reached; if one is, the run prints a `GUARD` block and fails. **No real agent CLI is started and no
   real account directory is read or written**, whatever is installed on the machine. Every suite also
   runs with `AGENT_CLI_CREDENTIAL_STORE=memory` and `../fixes/keychain-guard.cjs` preloaded through
   `NODE_OPTIONS`: an attempt to run the keychain tool `security` is refused and logged, and a logged
   attempt prints a `KEYCHAIN GUARD` block and fails the run. The first line of a run (`keychain-guard`)
   proves the guard is live in a suite's environment.
5. Counts each suite's own `PASS` / `FAIL` / `SKIP` lines (the page matrix prints `ok` per combination).
   A suite passes when it exits 0, prints no `FAIL`, and prints at least the number of `PASS` lines
   pinned for it in `run.sh` (`min_for`) — so a suite that stops early, or loses checks to an edit,
   fails instead of looking green.

Logs are in `<run directory>/logs/<name>.txt`; the directory is printed first and last and is not removed.

## What it needs

- **node** (the suites use `fetch` and `WebSocket` from the runtime in the page matrix: Node 22 or newer)
  and the repository's `node_modules` (`typescript`, `esbuild`).
- **A Chromium-family browser** for `dash-matrix` only. It is looked for at the usual macOS and Linux
  locations, or taken from `CHROME=<path to the binary>` (when `CHROME` is set it is the answer: a path
  that is not an executable is "no browser"). When there is none the suite is not run and the run says
  so — `dash-matrix     SKIP    headless Chrome not found …` — counts it as skipped in the summary, and
  still passes or fails on the other eighteen. The browser gets a private profile inside the run directory and a debugging
  port it picks itself. Before it starts, `run.sh` waits while the 1-minute load average is above 30
  (`CCO_SUITES_MAX_LOAD` changes the threshold).
- `mkfifo`, `ps` and `git` on the system path (present on macOS and Linux).

## The suites

Data modules (single-file bundles; fixtures under a scratch `HOME`):

| name | what it covers |
|---|---|
| `f1` | `sessionLitter` rule (b2): an entry that names a messaging socket is removed only when its process is gone and nobody listens at `<pid>.sock`; every other answer of a connect keeps it. Real sockets, real dead pids, a stand-in for `net.connect` for the answers a platform cannot be made to give. |
| `litter` | `sessionLitter` as a whole on one large fixture directory: what is removed, the ninety-odd things that must be kept (symlinks, FIFOs, odd names, live processes), bounds, options, races between judging and unlinking, failures counted not thrown. |
| `usage2` | `usage.ts` for accounts of other vendors' CLIs: which list an account is in, how a provider status becomes a cache entry, that a Claude account's reading is never overwritten, the helper process (environment, timeouts, crashes), and that the Claude probe never visits another vendor's directory. |
| `ladder` | The usage probe's termination ladder against a fake `claude`: stdin end, SIGTERM, SIGKILL, timeouts, a child that ignores signals, the environment each spawn gets; the keep-alive sweep. |
| `unref` | That the ladder's timers and leftover pipes never keep the host process alive (three scenarios, each a child process that must exit by itself). |
| `model` | `uiModel.buildDashboardModel` on fixture files: every field of the page model, hostile log lines, stat-keyed caches (what a rebuild reads), `resolveTaskOutput`, setting validation, damaged small files, an unreadable task log, a 60 MiB log. |
| `team` | `team.ts`: session rows from ledgers, session registries and team configs — keys, joins by job id, liveness, worktrees, scope, bounded scans. Every fixture session is the file `<pid>.json` of a process the suite itself started (eight sleepers and itself alive; 1,301 children started and reaped for the dead ones). |
| `hostile` | Second-round probes of the model and team modules with inputs chosen to break them: parser stress, CRLF, giant lines, edge numbers, surrogates, classification of error texts. |
| `probe` | `probeClaudeVersion` against fake executables: version gate, caching, timeouts, the environment the probe gets. |
| `ui2` | The page model and team rows with accounts on every provider: provider fields, login states from a provider reading, dispatch mode of a task (session / detached / one-shot). |
| `d2-data` | The same data layer when a hand-edited registry puts another vendor's worker on a Claude account's directory: who owns a usage reading, which accounts each list holds. |
| `helper-env` | The environment of the forked provider status helper: every `ANTHROPIC_*` / `CLAUDE_*` variable the parent holds is withheld, what another vendor's CLI needs is kept. |

Extension shell (the compiled extension against `lib/host-harness.js`, a stand-in for the `vscode` module):

| name | what it covers |
|---|---|
| `ext-verify2` | Static consistency of the manifest, the three language files and the sources: every declared command registered (through the one guarded registration), every string key present in three languages, the terminal-environment rule, source-level invariants of earlier fixes. Reads the repository; runs nothing. |
| `ext-probe2` | The shell end to end: activation, the session-file prune driver, every command's argument validation and confirmation, terminals and their environments, the Tasks / Workers / Worker History / Team trees and their hovers, adding accounts of each provider. |
| `probe-shellfix` | Terminals of non-Claude accounts, the Codex "where to keep the login" step, wording that no longer claims a login, and what happens when another vendor's worker sits on a Claude account's directory (prune list, re-login, stop, cancel). |
| `probe-kshell` | Token-count formatting, own-property reads of the usage cache, joining a task to its ledger record by task id, that no tree text bypasses the translation function, the add-worker picks, a run-recorded logout, and the registry lock held by a live process (activation, a settings change, user actions). |
| `dash-host` | The dashboard host (`src/dashboard.ts`) as a black box: the document and its content-security policy, the model loop, every message the page may send, settings (validation, confirmation of widening values, a registry that refuses the write), disposal. |

Dashboard page:

| name | what it covers |
|---|---|
| `dash-matrix` | `media/dashboard/preview.html` in a headless browser, 5 fixtures × 3 themes × 2 widths: console errors, exceptions, horizontal overflow, unexpected elements or handlers, the markup probe, missing strings, token counts in the one format. Screenshots go to `stage/dash-matrix/shots/` in the run directory. |
| `dash-sync` | The dashboard's string table three ways: `dashboardStrings()` in `src/dashboard.ts`, the copy in `media/dashboard/fixtures.js`, and the keys the page asks for. It **compares and writes nothing**; it runs last because that table is the one other work regenerates. `node .orchestrator/suites/dash-sync/check-strings.js <repo root> --write` regenerates the copy in `fixtures.js` — a maintenance step, never run by `run.sh`. |

## Comparisons that need an older build

`probe-shellfix` (3 checks: T6b, T7b, T8) and `probe-kshell` (4: O8b, P6, S16, Q2b) compare the tree
under test with a compiled copy of the tree as it was **before** the fix they were written for — "the
defect is visible on the old tree, and gone on this one". The repository cannot rebuild those old
trees, so by default each of these checks prints `SKIP` by name. To run them, name a compiled copy:

```
CCO_SUITES_BASE_SHELLFIX=<out dir of the tree before the shell-fix wave> \
CCO_SUITES_BASE_KSHELL=<out dir of the tree before the following wave> bash .orchestrator/suites/run.sh --only probe-shellfix,probe-kshell
```

## Changing a suite

- A check that changes on purpose gets an entry in `EXPECTATION-CHANGES.md` (old expectation, new
  expectation, why — the contract section or the fact it follows). A check never passes by being loosened.
- When checks are added, raise the suite's number in `min_for` in `run.sh`.
- `lib/host-harness.js` is shared by `ext-probe2`, `probe-shellfix` and `probe-kshell`. Its stand-in for
  `vscode` is kept at least as strict as the real API where the suites can tell the difference: full
  `appendText` escaping (compare hovers with `shown()`), manifest defaults and scopes for settings, an
  error for a command nobody registered, and a `child_process` allowlist that throws.
- Fixtures must not depend on the machine: no path of a real home directory, no pid assumed dead or
  alive without asking the kernel, no size that follows the length of `HOME`'s path.
