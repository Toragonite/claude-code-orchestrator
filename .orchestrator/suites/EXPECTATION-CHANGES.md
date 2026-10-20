# Expectation changes

Every expectation that was changed or removed when the suites moved from the session scratch directory
into `.orchestrator/suites/`, with the reason. Three kinds, and each entry says which:

- **(a) expectation** — the product changed on purpose; the check now asserts the new behaviour, as
  strictly as the old one was asserted.
- **(b) fixture** — the product is unchanged in what the check is about, but the suite's fixture no
  longer exercised it (a vendor account written into `workers[]`, a file named for a pid that happens
  to be alive, a size that followed the length of a path). The fixture was corrected; the expectation stands.
- **removed** — the thing the check was about no longer exists; what replaced it and where that is tested.

"Contract" is `.orchestrator/contract-2.0-fixes.md`; "facts" is `.orchestrator/docs-facts-2.0.md`,
section B.

No check is left failing, and none was left failing because the product looked wrong. The changes came
in three rounds, and each entry below says which: **section 1** is the move itself, against the tree as it
stood after fix wave 5 (all nineteen suites green on the tree of 2026-10-14 01:06); **section 6** is the
second review's fixes (contract §9), which landed while the suites were being moved and turned six of
them red again — each brought to the final behaviour once the rulings were in; **section 7** is wave 7
(contract §11: every tier alias as a worker's default, and the Claude Code model picker).

Counts in the headings of section 1 are `PASS` lines at the last all-green run in the scratch directory
(2026-10-13 20:49) → after the move. Section 6 gives the counts as they are now.

## 1. Changes made in the move

### f1 — 114 → 132

Since 2.0 the module connects only to a socket named `<pid>.sock` for the entry's own pid, and looks
at the path (`lstat`) before any connect (contract §2.7).

| check | old | new | why |
|---|---|---|---|
| (b) every scenario about what a connect answers — 2, 3, 4 (three), 5 (four), 6 (three), 7 (all stand-in runs), 8 (60 entries; 4,000 entries), 9, 11 (two symlinks), 12 | the socket was `live.sock`, `stale.sock`, `regular-file.sock`, `s<i>.sock`, … or a path where nothing exists | the socket (or file, directory, FIFO, link) stands at the entry's own `<pid>.sock`; a stale one is left by a child that listened on it and was SIGKILLed | under any other name the module no longer connects at all, so "kept" passed for the name and "removed" could not pass; the stand-in for `net.connect` was never reached because its default path held nothing (now decided by `lstat` alone) — the suite crashed there |
| (b) section 10: `200.json`, `201.json`, `202.json`, `203.json` | fixed numbers | files named for pids that are provably gone | rules (a) and (b1) now also ask whether the process the file NAME names is gone (§2.7); 200… are anybody's live processes |
| (a) 7 "ECONNREFUSED for a path where nothing exists at all" | KEPT (the refusal was not believed without a socket at the path) | REMOVED, and no connect attempted | §2.7: `ENOENT` → nobody is listening, no connect is made |
| (a) 10 "NO messagingSocketPath (pid field is a live pid, irrelevant)" | REMOVED | KEPT when the `pid` field names another process; REMOVED only when it is the file's own pid | module header: "its `pid` — if it has one — is the number in the file name"; pinned by `fixes/litter.mjs` ("pid field of another process (b1)") |
| (a) 11 "zero-padded file name, pid equals its NUMBER" | REMOVED | KEPT | §2.7 "a name whose pid cannot be read keeps the file"; header: plain decimal spelling, no leading zero |
| (a) 11 "of all of these, only the symlink-to-live case reached the listener (one silent connection)" | one connection | none | the path is `lstat`ed before any connect, and a symbolic link is not a socket |
| (a) 9 "dryRun: counts …" | `scanned === 3` | `scanned === 4` | one fixture entry added (a listened-to socket under another name, which the dry run may not connect to either) |
| (a) 12 "none of the 30 stale socket files was touched" | 30 | 20, counted | 15 sockets left by dead sessions + 5 of the live processes; the even half of the 30 entries never had a file |

New checks (18): the verdict of 2 came from exactly one connect, to that path; `2b` a stale socket
under another name, or named for another pid, is kept and never connected to (4); `3b` a listened-to
socket under another name sees no connection (2); 5 none of the four non-sockets was connected to; 6
the connect to a forbidden `<pid>.sock` was attempted; 7 a regular file is never connected to; 7
nothing-at-the-path is decided without a connect; 8 the 4,000-entry pass made real connects; 10 a
live file name / pid 1 / a foreign `pid` field keep the file, for rules (a) and (b1) (5); 12 one
connection per listened-to entry.

### litter — 152 → 159

| check | old | new | why |
|---|---|---|---|
| (b) the whole fixture | files `123.json`, `200.json`, `1000.json` …; every probe body said `pid: 1` | fixture entry `n` is `<P(n)>.json` with `P(n) = 3,000,000 + n`, asked of the kernel to be gone (`ESRCH`) or the suite stops; its body says `pid: P(n)` | §2.7: the process the name names must be gone, for every rule; and a probe entry's own `pid` must be that number. All 29 failures of the suite came from this |
| (b) "entry WITH messagingSocketPath" (`210.json`) and "a live session among them" (`2999.json`) | an entry with a socket and `pid: 1` | the entry of a process that is alive (this one), with a socket | since rule (b2) exists such an entry was kept only because `1 ≠ 210`; what it stands for is a live session |
| (b) 7e, the entry that must survive the swap | an entry with a socket path and `pid: 1` | a session worker's entry (`kind: "bg"`) for the same dead pid | an entry with a socket whose process is gone and whose socket path holds nothing IS litter now; a new fixture check shows the decoy alone is removed and the survivor alone is kept |
| (a) "10-digit zero-byte 0000000202.json" and "its key 0000000202.<hex>.key" | REMOVED | KEPT (the key aged 48 h, so only its name keeps it) | §2.7; header: plain decimal spelling, no leading zero |

New kept cases (6): the zero-byte entry of a live process and its 48-hour-old key; `1.json` and
`1.<hex>.key`; a probe entry whose `pid` field names another process; one whose `pid` field is 1.

### usage2 — 119 → 122

| check | old | new | why |
|---|---|---|---|
| (b) the registry fixture | every worker under `workers` | Claude accounts under `workers`, entries with a `provider` under `vendorWorkers` | contract §2.1, facts B.5. One new check reads the same accounts in the old single-array layout and requires identical lists |
| (a) "listAccounts() = main + Claude workers only (an unknown provider id reads as Claude)" | `['main', 'claude-a', 'typo']` | `['main', 'claude-a']` | §2.1 / B.6: an unknown provider is an unsupported entry, in no enumeration |
| (a) D1 "a "logged out" recorded for a directory that is a Claude account's … writes nothing" | five calls, the fifth for the `typo` entry's directory, with a Claude reading seeded for it | four calls; D2 expects 3 cache keys (was 4) and now also that main's reading is untouched | that entry is not a Claude account any more, so the rule has nothing to say about its directory |
| (a) G1 "refreshAllUsage() probes main + the two Claude workers" | 3 results, 3 starts, names within main / claude-a / typo | exactly 2, names equal to main + claude-a | §2.1: an unsupported entry is not probed |
| (a) G2 "afterwards the cache holds Claude and provider readings side by side" | 7 keys | 6 keys, and the `typo` directory is not one | same |

New (3): the unknown-provider entry is in neither list; the old layout reads the same; its
directory is not probed and gets no cache entry.

### ui2 — 72 → 72

| check | old | new | why |
|---|---|---|---|
| (b) the registry fixture | one array | `workers` + `vendorWorkers` | §2.1 |
| (a) "account list: main first, then one row per directory" | 16 rows | 15 rows, `typo-w` not among them | §2.1 / B.6 |
| (a) "unknown provider id reads as Claude Code — and ignores the per-worker mode" | a Claude row: provider claude, mode auto, session workers, model opus, login refreshing | no row; `model.unsupportedAccounts` is exactly `[{ name: 'typo-w', detail: 'unknown provider "codexx"' }]` | contract §7.1 |
| (a) "no reading at all → refreshing (and only then)" | `agy-plan,codex-noread,typo-w` | `agy-plan,codex-noread` | same |

### model — 371 → 374

| check | old | new | why |
|---|---|---|---|
| (b) "large log (… MiB, 40,000 tasks): first build parses, second does not" | pad of 280 characters per record | pad sized so the log is 60 MiB wherever `HOME` is | every record carries `HOME`'s path twice: the log was 63.5 MiB under the old scratch path and passes the product's 64 MiB read cap under a longer one — the model then (correctly) reads nothing and the check fails for a reason that is not the product's |
| (a) "after an append: the log is re-read once and the task shows done" | `openSync === 1` (the whole log read again) | two opens (the appended tail; the one changed row by its offset), no `readFileSync`, bytes read ≤ 2 × the append + 512 and under 1 % of the log | contract §7.3: incremental index; `uiModel.readTaskLog` + `loadDetails` |
| (a) "resolveTaskOutput rejects uppercase" | `undefined` | `undefined` on a case-sensitive file system; on a case-insensitive one the same regular file (same device and inode) under the spelling asked for | §2.3 amendment: one id rule `/^[A-Za-z0-9_-]{1,128}$/`, then `lstat` in the tasks directory; nothing lower-cases an id. See "Observations" in section 5 |
| (a) "registry [] → only the main account" | one row (main) | no rows, no unsupported rows, `health.registryProblem === 'not a JSON object'` | contract §7.2, facts B.7; `uiModel.buildAccounts` |
| (a) "a FIFO at registry.json does not block the build" | `< 1000 ms` and one row | `< 1000 ms`, no rows, `registryProblem === 'not a regular file'` | same |

New (3): `registry.json` = `null`, `{"workers":"nope"}`, `{"workers":{…}}` each report a problem of
at most 200 characters and show no account row.

### hostile — 35 → 35

Both rules below are stated in the product source and exercised by `fixes/views.cjs`; neither is
named in the contract or the fact sheet (see section 5).

| check | old | new | why |
|---|---|---|---|
| (a) "a 10 MiB NUL line and a 3 MiB record are skipped cheaply; neighbours kept" | `taskTotal === 2` | `taskTotal === 3`: the NUL line is skipped, the 3 MiB record is the task it says it is; still under 1500 ms; its row has status done, every string of the model is capped, the serialized model is under 64 KiB | the views read the log by the registry's own rule, line for line (`uiModel.LogPass.line`); the old reader's "skip any line over 1 MiB unparsed" is gone. `fixes/views.cjs`: "a multi-piece log with a 5 MiB line" must equal a full parse |
| (a) "status prefixes: classified on the text the page shows" | error text U+200B `cancelled` U+200B ` by user` → cancelled | → failed; a new record ` \tCANCELLED by user` → cancelled | `uiModel.terminalStatus`: decided on the text as recorded — leading whitespace skipped, case ignored, nothing else removed (the same test as `registry.claimsErrorClass`) |

### d2-data — 20 → 20

| check | old | new | why |
|---|---|---|---|
| fixture kept on purpose | every entry under `workers` | unchanged, with a comment | this suite is about hand-edited registries ("a Codex worker listed BEFORE the Claude worker of the same directory"), which exist only in that layout; the reader still accepts it (§2.1) |
| (a) G6 "… an unknown provider id reads as Claude Code (the registry's rule)" | `ownsUsageReading({ provider: 'codexx' }) === true` | `=== false`, `getCachedWorkerUsage(…) === undefined`, and the same for a provider that is a number | §2.1: `workerProvider` refuses an unknown provider; `usage.ownsUsageReading` |

### ext-verify2 — 87 → 88 (static checks of the sources)

| check | old | new | why |
|---|---|---|---|
| (a) "every declared command is registered in src/extension.ts" and "every UiCommandId the dashboard may send is a declared and registered command" | ids read from `registerCommand('…'` | ids read from `guardedCommand('…'` | contract §7.2: every command goes through one registration whose handler can neither throw nor reject. New check: the only `commands.registerCommand` call in the seven host files is the one inside `guardedCommand` |
| (a) "pgid is no longer read as a detach marker in views.ts (F2)" | no `typeof event.pgid` in views.ts, and `typeof event.supervisorPid === 'number'` in views.ts | neither views.ts nor uiModel.ts reads `pgid`; views.ts reads neither field; `uiModel.hasSupervisor` is the numeric test | §7.3: the trees take a task's mode from the shared index |

### ext-probe2 — 213 → 222

| check | old | new | why |
|---|---|---|---|
| (b) section H and the preferred-worker checks: `entryOf`, `names`, `prefs` | `readReg().workers` | `readWorkers()` — `workers` then `vendorWorkers` of the file | §2.1. Five failures (H3, H5, H8, H11, H13) and a crash came from looking for vendor accounts in `workers` |
| (a) D22 "the cancellation is noted in the task output file" | in the file the task's log line names | in the report its id names, `<tasks dir>/<id>.md`; the log-named file is byte-for-byte untouched | contract §5.3 / §7.3, facts B.21: notes go through `appendTaskNote`, a path from the log is never opened |
| (a) F3 "openTaskOutput opens nothing for an unknown id, a path, or a malformed argument" | nothing opened and **nothing said**; the bare string `'tabc1234'` was among the refused | nothing opened and one warning ("The output of that task could not be found.") per refused argument — 16 of them, bare paths and the report's own path included; the bare id is accepted | §7.3 "they take a task id, not a path"; `extension.openTaskReport`: "open nothing and are said" |
| (a) F4 "a known id opens the file the HOST resolved" | the path the (stubbed) page-model resolver gave | `<tasks dir>/<id>.md`, beside the active editor, as a preview | §5.4 / §7.3: `registry.resolveTaskFile` |
| (a) F18 "showTaskOutput ignores a non-string argument" | nothing opened, nothing said (a string was a path it opened) | a non-id argument or any path: nothing opened, a warning each | same |
| (a) F23 / F24 / F25 "history tooltip: …" | an event object handed to `getTreeItem`, its `promptFile` any path | the row comes from the provider, the hover from `resolveTreeItem`, the prompt from `<tasks dir>/<id>.prompt.txt`; the path the log line names holds a decoy that must not appear | §7.3 |
| (a) J15 "the Tasks tree renders a log holding wrong-typed fields …" / J19 | one fixture record had wrong-typed fields **and** `ts: 'yesterday'`, and was a row | the wrong-typed record has a real timestamp and is a row; a second record with `ts: 'yesterday'` must not be one. Still 11 rows | `uiModel.acceptEvent`: a task id, one of three statuses and a usable timestamp — one rule for every surface (§7.3) |
| (a) tooltips of task rows (J18, F2a–c, J21) | read off `getTreeItem` | read off the hovered row (`resolveTreeItem`) | §7.3: hovers are built on demand |

New (7): `F4b` a bare id; `F4c` a symbolic link at the report's name is refused; `F18b` a task id
opens its report in the active group; `F22b` a history row is drawn without a tooltip and its command
carries the id; `F22c` no prompt file → the preview, never the log-named file; `F25b` a link at the
prompt's name is not followed; `J15b` no Tasks row is drawn with a tooltip.

### probe-shellfix — 75 → 73 passed + 3 skipped (76 with an older build, see section 4)

| check | old | new | why |
|---|---|---|---|
| (b) `entryOf`; the output note of a cancelled task | `readReg().workers`; `<sandbox>/<id>.md` (the log-named path) | `readWorkers()`; `<tasks dir>/<id>.md`, and the log-named file untouched | §2.1; §5.3 / §7.3 |
| (a) T9 "an account object carrying a provider id this version does not know is opened as Claude Code … not a crash" | one terminal running `claude` in the Claude environment | `TypeError: workerProvider: unknown provider — not a registry worker`, and no terminal at all | §2.1: classifying it as any provider would aim one vendor's CLI at another's directory |
| (a) X0 "the registry holds all four" | `workers` names `cxmain,cxw1,w1,cx2` | `workers` = `w1` (no `provider` key), `vendorWorkers` = the three Codex accounts; read order `w1,cxmain,cxw1,cx2` | §2.1 |
| (a) X15 / X16 "Tasks-tree cancel … the output note …" | note looked for in the log-named file | in the id-named report | §5.3 / §7.3 |

### probe-kshell — 106 → 104 passed + 4 skipped (108 with an older build)

| check | old | new | why |
|---|---|---|---|
| (b) P3, P4, P7, P8 and the walk of Q1 / Q2 | tooltips read off `getTreeItem` | read off the hovered row | §7.3. Also: `reg()` reads `readWorkers()`; the Q fixture writes the id-named prompt file |
| (a) Q1 "the fixture reaches every state the rows can be in" | 14 task rows | 13: the record with status `DATA_STATUS` is not a row | `uiModel.acceptEvent` (§7.3) |
| (a) T8 "a setting change REPORTS that it could not be saved — one warning" | one warning after the burst | no message: in this sequence the refusal was first met by activation, which now says it at startup (new `T4b`), and a refusal is said once. The old assertion is kept as new `T8b`, where a settings change is the first to meet the held lock (adds 15 s) | `extension.reportRegistryStateAtStartup`; the configuration listener's "once per refusal" |
| (a) T12 ""Set as preferred" with the lock held" | one **error**: "The preferred worker was not changed. Could not lock registry.json…" | one **warning** that is the lock's own sentence from its first word | contract §7.2; `extension.showStateWriteRefusal` |
| (a) T13 ""Remove Account" with the lock held" | error, "Worker account "w2" was not removed. Could not lock…" | warning, the lock's own sentence | same |

### dash-host — 73 → 74

The suite crashed at load: it replaced `./registry` for every compiled module with a two-key object,
and the host now imports modules (`settings`, `workerManager`, `usage`) that need the real one. The
stand-in is now handed to `dashboard.js` alone and is the real module with `readRegistry` and
`resolveTaskFile` overridden.

| check | old | new | why |
|---|---|---|---|
| (a) H23 "openTask: the file comes from the host resolver, never from the message" | the resolver was `uiModel.resolveTaskOutput` | the registry is asserted to have been asked for `(id, 'output')`; the page-model resolver answers a wrong path that must not be opened. H24 asserts the same question was asked | §5.4 / §7.3 |

### dash-sync

The scratch version (`dash/sync.sh`) **rewrote** `media/dashboard/fixtures.js` on every run and then
checked key parity. Here it compares and writes nothing: the table generated from `src/dashboard.ts`
must equal the block in `fixtures.js` byte for byte (a difference lists the keys), every key the page
asks for must be in the table, and both scripts must parse. Regeneration is `check-strings.js --write`,
never run by `run.sh`. The generator was rewritten from Python to Node; its output was verified
byte-identical to the Python one on the current table (380 keys).

### dash-matrix, ladder, unref, team, probe, helper-env

No expectation changed in the move (`team` changed later: section 6). `dash-matrix` takes the browser from `CHROME` and lets it pick its own
debugging port (a fixed port could be one another browser on the machine is listening on).

## 2. Edits inherited from the two generated layers (applied once, in the files)

Before the move, patched copies of four suites were rebuilt on every run by two scripts. Their edits
are now simply part of the files. They were made by the owners of those fix waves; listed for the record.

From `kshell/update-expectations.py` (14):

| file | edit | why (as recorded) |
|---|---|---|
| ext-probe2 | harness: the dashboard stand-in gains `setDashboardSettingsSync` (2 edits) | the shell now hands the dashboard host its settings-sync step |
| ext-probe2 | G6: cancelling a session-worker task whose name is carried only by records of OTHER tasks stops nothing; new G6b for the case the name fallback is for | a task is joined to its ledger record by task id, not by worker name |
| ext-probe2 | provider pick descriptions: `claude` → `claude · attachable sessions`, … | the pick states the trade-off beside the label |
| ext-probe2 | task hover headings compared unescaped; "never calls it claude -p" tolerant of the escape (2 edits) | headings go through `appendText` (superseded here by `shown()`, section 3) |
| ext-probe2, probe-shellfix, helper-env | the credential list is eight named variables plus every `ANTHROPIC_*` / `CLAUDE_*` variable the process holds (7 edits) | facts: vendor child environments withhold every Anthropic-scoped variable |
| probe-shellfix | K1b: the keychain trade-off is read from the item's description | same wording change as the provider pick |

From `w5-shell-a/update-expectations.py` (15):

| file | edit | why (as recorded) |
|---|---|---|
| ext-verify2 | "every createTerminal call passes env: …" → one `createTerminal` call, and every `openCommandTerminal` caller passes one of the two environments (2 edits) | contract §6.2 |
| ext-probe2, probe-shellfix | an initial prompt is one single-quoted argument (2 edits); T7b compares with the older tree except for that quoting | §6.2 |
| ext-probe2 | F8: a differing copy of our team-agent definition is replaced only after a modal "Replace" (new F8a) | §6.8 |
| ext-probe2 | F15: Reset Check-in asks in a modal first (new F15a) | §6.7 |
| probe-shellfix | fixture job id `abcdat04` → `abcda004` (7 places) | §6.2: a job id is 8 hexadecimal characters |
| probe-shellfix | K8: for a folder that already holds something the keychain step is not offered (was: a modal "NOT applied" afterwards); new K8b | §6.5 |
| dash-host | the suite's clock moves 2 s before each message (2 edits); the stand-in window answers a modal and records it | §6.7 one page action per second; §6.6 |
| dash-host | H18: a workspace value shadows nothing — the value in effect is the one saved for the user, no caveat | §6.1 |
| dash-host | H20b: a billing guard set to allow shows one modal first | §6.6 |

## 3. Stand-ins made stricter

Where an older stand-in for `vscode` was more forgiving than `fixes/shell-a-stub.cjs`, the stricter
behaviour was taken.

`lib/host-harness.js` (ext-probe2, probe-shellfix, probe-kshell):

| was | now | effect |
|---|---|---|
| `MarkdownString.appendText` escaped punctuation and line feeds only | the editor's full escaping: every space → `&nbsp;`, `>` → `\>` | five checks of ext-probe2 compared `.value` as if it were the text (J8, J9, F2a, F2b, J21) and now compare what is shown (`shown()`). J21's "the hover never calls it claude -p" could not have failed on a real editor's value; it can now |
| `getConfiguration().get` returned the caller's fallback for an unset key; `inspect` returned `{ globalValue }` only | the manifest default, and the editor's `inspect` shape | none |
| `update` accepted any target | a machine-scoped setting is written to User settings only (an error otherwise); writes recorded | none |
| `executeCommand` of an unknown id resolved to `undefined` | throws `command '…' not found` | none |
| any object after the message was the options of `show*Message` | only one that carries `modal` or `detail` | none |
| `Uri` a bare object; no `env.shell`, `showOpenDialog`, `extensions`, `onDidChangeWorkspaceFolders` | a class with `joinPath` / `with` / `toString`; `env.shell` `/bin/zsh`; the missing members | none |

Kept from the older harness, because there it is the stricter side: its `child_process` allowlist
**throws** on anything but the fake CLI, `git`, `ps` and `mkfifo` (the newer stub redirects to a fake).

`dash-host`: settings answer manifest defaults for every key (four were hard-coded); `update` refuses a
non-User target for a machine-scoped setting; `executeCommand` refuses a command the manifest does not
declare. No check moved.

## 4. What could not be moved

Seven checks compare the tree under test with a **compiled copy of an older tree** — T6b, T7b, T8 of
probe-shellfix (the tree before the shell-fix wave) and O8b, P6, S16, Q2b of probe-kshell (the tree
before the wave after it). Those builds exist only in the scratch directory and cannot be rebuilt from
the repository, and build output does not belong in it. Each of the seven prints `SKIP` by name unless
`CCO_SUITES_BASE_SHELLFIX` / `CCO_SUITES_BASE_KSHELL` names such a build (README). With the scratch
builds named, all seven pass on the final tree too (built 02:41: 76 / 76 and 109 / 109).

Nothing else was left behind. Not moved because they are not suites: the scratch directory's run logs,
screenshots, mutation experiments (`pdata/mut3`, `usage-task/mut`), benchmarks and the older source
snapshots.

## 5. Observations, and how they were ruled

- **A case variant of a task id resolves to the same report on a case-insensitive file system.**
  `registry.resolveTaskFile('T0000LFLZ', 'output')` returns `<tasks dir>/T0000LFLZ.md` when
  `t0000lflz.md` exists, on macOS (default) and Windows. It is the same task's report and still a
  regular file in the tasks directory, so nothing foreign can be opened. *Ruled: accepted as the `model`
  check now asserts it.*
- **Two rules in `uiModel.ts` that the contract did not name**: a log line of any length that parses
  as a record is a task (the 1 MiB per-line skip is gone), and the cancelled / orphaned class is decided
  on the error text as recorded. *Ruled: intended; the two `hostile` updates stand.*
- **A refused settings sync is said once at startup** (probe-kshell T4b). *Ruled: intended.* This
  suite is the only place it is pinned.
- **A timestamp more than five minutes ahead**: contract §9.7 first said it "reads as the time the
  event was read"; the code makes it no time at all. *Ruled: the code is right and the contract was
  amended* — see `hostile` in section 6.

## 6. The second review's fixes (contract §9)

These landed between 01:03 and 02:30 on 2026-10-14, after section 1 was done. Six suites went red; five
needed changes here (the sixth, `dash-sync`, went green when `media/dashboard/fixtures.js` was regenerated
by its owner). Counts are `PASS` lines after section 1 → now.

### team — 110 → 118

The session scan takes a session's process from its entry's FILE NAME — `<pid>.json`, the pid in canonical
decimal — passes over an entry whose process is gone without opening it, and drops an entry whose own
`pid` field says another process; a `pid` field inside the file is optional (§9.8).

| check | old | new | why |
|---|---|---|---|
| (b) every session fixture | files named `hostile.json`, `bg-peer.json`, `noversion.json`, `mirror.json`, `big.json`, `litter.json`, `other-ws.json`, `relative-cwd.json`, `dead.json`; several of them describing one pid; the dead pid a guessed number (99999999); 1,300 litter entries named `40000000+i.json` | each is the file `<pid>.json` of a process **the suite itself started**: the eight sleepers and the suite's own process are the nine live pids, each used at most once per account directory (host, w1; the directories are scanned separately); the dead pid and the 1,300 litter pids are children started and reaped one at a time before the sleepers start, each asked of the kernel to be gone. Never more than eight children alive | §9.8. Under the old names nothing but `<own pid>.json` was a session any more: three peer checks failed and the suite stopped with a `TypeError` after 36 of 110 checks |
| (b) the FIFO in a sessions directory | `fifo.json` | at the entry name of a live process (`<suite pid>.json` in the w1 directory) | a name that is not a pid is no longer opened at all, so "returns promptly despite FIFOs" would not have tried the FIFO |
| (a) "peers: live + socket + not a mirror + …" | four peers: hostile peer, manual-bg, my-session, no-version-fields | five: the entry with **no `pid` field** is a session too | ruling: for an entry whose body has no usable pid, the name decides |
| (a) "peers: dead pid, ccoMirror, 100 KiB entry, non-JSON, no-socket litter, other workspace, relative cwd, missing / fractional / string pid are not listed" | an entry with a missing, fractional or string `pid` field is not listed | a fractional or string `pid` field, **or the pid of another live process**, contradicts the name the entry stands under: not listed. The missing one moved to the check above; "non-JSON" moved to the second group below | `team.liveEntry`: `bag.pid !== undefined && bag.pid !== pid` |

New (8): the no-`pid`-field entry is keyed `peer:<account>:<pid of its name>:<tag>`; eight files whose
name is not a canonical pid — a word, a leading zero, a sign, a suffix, a space, a fraction, a ten-digit
number past the largest pid, zero — are passed over although each holds a listable session; the same
entries stay off the list in scope "all"; and a **second group** on the same live pids — not JSON,
`null`, an array, an empty file, a symbolic link to a real session, a directory at an entry name — none
listed, the link not followed, the sessions beside them still listed (one check for not throwing, one
for the result, three for the rows' invariants).

No upper-case `<pid>.JSON` among the odd names: on a case-insensitive file system that is the entry itself.

### hostile — 35 → 36

| check | old | new | why |
|---|---|---|---|
| (a) "edge numbers: sums stay finite; out-of-range timestamps are not records" | the record dated 8.64e15 (the largest valid date) had to be **among the listed tasks** — it headed the list | it is a task with no time: counted (`taskTotal === 2005`), **not** among the newest 300 (all 300 listed tasks are dated), in no window sum (`week.tasks === 2003`, `session5h.tasks === 2003`) and no daily bucket (the 14 buckets hold 2,003). The other clauses are unchanged | §9.7 as amended (ruling 1); `uiModel.recordedTime` |

New (1): a small log where the undated tasks are on the list — order: the dated ones newest first (one
dated four minutes ahead, within the slack, first; a task of 1970 last of them), then the undated
running one, then the undated finished one; neither shows a start or end time; their tokens are in no
sum; `taskTotal` 6, week 3, daily 3, running 1.

### ext-verify2 — 88 → 88

| check | old | new | why |
|---|---|---|---|
| (a) ""Import workers" stays Claude-only: discoverConfigDirs still scans .claude* and import adds with no provider" | `entry.name.startsWith('.claude')` in workerManager.ts; `workers.add(entry.suggestedName, choice.model, entry.dir);` in extension.ts | in the body of `discoverConfigDirs`: the `.claude` name test **and** `!isRealDirectory(dir) || !looksLikeClaudeConfigDir(dir)`; in the import handler: exactly one `workers.add(name, choice.model, entry.dir);` (three arguments, no provider), with the suggested and the typed name each passed through `workerNameProblem` | §9.4 |

### ext-probe2 — 222 → 228

| check | old | new | why |
|---|---|---|---|
| (b) H17 ""Import Existing Claude Config Directories" discovers only .claude* directories …" | `.claude-w2`, an empty directory, was offered | it gets a `sessions/` directory and is offered | §9.4: only a real directory that looks like a config directory is offered |
| (a) J14 "… while the row id stays the registry's own string" | `item.id === worker.name` | `item.id === 'account:' + JSON.stringify(name)`; the rows under it `detail:<JSON name>:<seq>:<label>`; no two ids of the tree alike — with three workers named to collide in the old form (`idclash`, `idclash:0:Status`, `"idclash"`) | §9.4: ids built from a name must be unambiguous |
| (b) C14, C15, C16 "tree paths of the same actions" | a hand-built `{ name, configDir, model }` object | the Workers tree's own row | §9.3: a row is resolved by provenance; a hand-built object is a payload, which the other C checks already cover |

New (6): `A1b` when `activate()` returns nothing it owes has run — no usage refresh, no orphan sweep, the
stable copy untouched, no login shell asked for, the registry holding `claude` as configured — and the
resolved path is there a turn later (§9.5, §9.10); `K1b` the stale stable copies were replaced (a new
inode under each name) and no temp file is left (§9.1); `C14b` a tree row whose own `name` / `id` /
`kind` keys were changed still stands for the account it was listed as, and a detail row or a payload
claiming to be an unsupported entry's row names no worker (§9.3); `H17b` what Import offers and does not
— each of the four markers, and an empty directory, markers of the wrong kind, a symbolic link, a file;
`H17c` a directory whose name is not a worker name is asked for one (sanitized suggestion, the name
rule as validation) and Escape skips it; `H17d` with a name typed it is added as a Claude Code account.

### probe-shellfix — 73 → 73 (3 skipped)

| check | old | new | why |
|---|---|---|---|
| (a) K1b "… and that login detection and dispatch still work …" | the keychain item's detail matched `/login detection and dispatch still work/` | it is exactly "The sign-in is kept in the OS keychain; no token file is written to the account folder.", neither item says "still work" or "login detection"; the file item is exactly "The sign-in token is a plain file, auth.json, in the account folder." | §9.11: that was not verified end to end and is no longer claimed |
| (b) L1, L2: the "offered, not used yet" directory | `.claude-fresh`, an empty directory | `.claude-unused`, which has a `projects/` directory and neither sign-in file; the empty one is asserted **not** offered | §9.4 |
| (b) L2: finding a directory's item in the picker | by `description === dir` | by the entry the item carries; and its description is asserted to be the directory as one display-safe line of at most 200 characters | the picker shows a path through `views.rowText`; under a long temp path the description is the path's head |

### probe-kshell — 104 → 105 (4 skipped)

No expectation changed. New (1): `V13` a second activation over the same bundle does not rewrite the
stable server copies — same inode, size, modification and change time (§9.1).

### dash-sync

Red at 01:31 and 01:36 (`unsupportedBody`, `groupSessionNote` differed after §9.11 changed them in
`src/dashboard.ts`), green from 02:22, when the copy in `fixtures.js` was regenerated by its owner. No
change here.

### The other §9 items, and what these suites say about them

| §9 item | suites | finding |
|---|---|---|
| 9.2 keep-alive pings only on a recorded claim; a stamp dated in the future is not "due" | ladder | not pinned here: the suite drives `pingAccount` and the probe ladder, never the sweep. Its checks still hold |
| 9.3 `{ id }` / `{ name }` payloads keep working | ext-probe2, probe-shellfix, probe-kshell | every other command call in the three suites is such a payload, and passes unchanged |
| 9.5 `resolveClaudePathPreservingAsync` / `…WithoutLookup` | the shared harness | the harness stands in for the asynchronous lookup with the same answer as the synchronous one (the real one would start a login shell, which its allowlist refuses); `…WithoutLookup` is the real function |
| 9.6 a process group is signalled only when `pgid === pid` | — | not pinned here: the cancel checks of these suites are all session-worker cancels (`claude stop`) |
| 9.7 in team.ts and the hovers | team, ext-probe2 | the team rows read times through the same rule and pass; the "unknown time" hover text is not pinned here |
| 9.9 an explicit refresh rebuilds the index from byte 0 | model | "after an append …" builds the model without a refresh command, and still holds: bytes read stay bounded by the append |
| 9.10 the dead-task reap runs a second time after the orphan sweep | ext-probe2 | `A9` counts the orphan sweep (once); the reap is not observable through the harness |
| the task-log id rule, `mesh_status`, quota wording | — | dispatch-server behaviour; none of these suites touches it |

## 7. Wave 7 — models that can be seen to work (contract §11)

Landed on 2026-10-14 after section 6. Four suites went red: two needed changes here, and the other two
(`dash-matrix`, `dash-sync`) went green when `media/dashboard/fixtures.js` was given the twenty new
string keys by its owner. Counts are `PASS` lines after section 6 → now.

### ui2 — 72 → 72

| check | old | new | why |
|---|---|---|---|
| (a) "settings.providers: Claude Code row" | `models: ['opus', 'sonnet', 'fable']` | `models: ['opus', 'sonnet', 'haiku', 'fable']` | §11: `platform.WORKER_MODELS` is every tier alias, in display order — an alias names no model version, so the list cannot go stale |
| (b) the `SETTINGS` the model is built from | `workerModels: ['opus', 'sonnet', 'fable']` | `workerModels: ['opus', 'sonnet', 'haiku', 'fable']` | the same list, as the dashboard host now hands it in; no check reads it back, the fixture is kept equal to what the product sends |

### ext-probe2 — 228 → 228

| check | old | new | why |
|---|---|---|---|
| (a) C6 "setModel with no value offers platform WORKER_MODELS" | the pick's labels are exactly `[...WORKER_MODELS]` | exactly `['claude-opus-5-5', ...WORKER_MODELS, 'Enter a model id…']`; the first item — the full id C5 has just stored for `w1` — is the one item marked `current`; the pick of `fable` is still stored | §11.2: a stored default that is not an alias stays a choice (first, marked), and the picker ends with an item that takes a typed id through `platform.normalizeModel` |
| (a) H2b "its model pick offers the Claude tiers, and no login-choice step is shown" | the second pick's labels are exactly `[...WORKER_MODELS]` | exactly `[...WORKER_MODELS, 'Enter a model id…']`, and no item is marked `current` (the worker does not exist yet); still two picks, no login-choice step | §11.2, the same picker in the Add Worker flow |

### dash-matrix, dash-sync

Red while `fixtures.js` lacked the new keys (`accountsError`, `accountsChecking`, `accountsUnknown` on the
three fixtures whose accounts are in those states; twenty keys in the table check), green once the table
was regenerated (`check-strings.js --write`) together with the fixture data for the new fields. No change
here.

### What else of §11 these suites say

| §11 item | suites | finding |
|---|---|---|
| a page message `setModel` WITHOUT a value is bounded on a lane of its own | dash-host | `P18` and `P27` send one each, two seconds apart on the suite's clock: both are admitted, and both checks hold unchanged. The burst itself is pinned in `fixes/ui7.cjs` (H1) |
| `modelUsed` / `modelSource` / `modelRanAs` / `policyOutdated` in the page model | model, ui2, d2-data, hostile | their fixtures carry none of them; every existing check holds. The fields are pinned in `fixes/ui7.cjs` (I1, H1, P1) |
| the vendor model picker asks the CLI for its list | ext-probe2, probe-shellfix, probe-kshell | the shared harness has no `createQuickPick`, so the picker shows what is known in memory in one `showQuickPick` and starts no helper: their vendor-picker checks hold unchanged, and so do the three "every blocked spawn was a login-shell lookup" checks. The live path is pinned in `fixes/ui7.cjs` (U1, K2) |



## 8. Wave 8 — fixes of the third review (contract §12)

| Suite / file | Check | Was | Now | Why |
|---|---|---|---|---|
| `fixes/views.cjs` (oracle) | `TASK_ID` of the full-parse reference; the junk line `"NOT-AN-ID"` | `/^t[a-z0-9]{6,24}$/`; the junk id was refused by it | `/^[A-Za-z0-9_-]{1,128}$/`; the junk id is `"NOT AN ID"` | every reader now admits events by one rule (`ranAs.isCountedTaskEvent`, the task-file id rule); the old oracle was narrower than the product |
| `probe-shellfix` | L2 `shownDir` | the first 200 characters of the directory | the whole directory | picker paths are shown whole (up to 1,024 characters): a cut path carries no "…" and reads as another directory |


## 9. Wave 10 — model lists from the CLIs, pinned models (contract §14)

| Suite / file | Check | Was | Now | Why |
|---|---|---|---|---|
| `ui2` | "settings.providers: Codex row" models | `gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5` | `gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol` | the built-in Codex suggestions follow what `codex app-server` listed on 2026-10-14 (`gpt-5.5` is no longer offered) |
| `probe-shellfix` | K1–K5 (Codex add flow) | picks / stores `gpt-5.5` | `gpt-5.6-sol` | the flow picks from the built-in suggestions, which no longer hold `gpt-5.5` |
| `ext-probe2` | C5, the v1.x id `claude-opus-4-8` | stored as `opus` | stored as `claude-opus-4-8` with `modelPinned: true` | a model chosen in the editor is pinned: the CLI offers "Opus 4.8" as a model of its own |
| `dash-host` | H28 | page value ` Claude-Opus-4-8 ` forwarded as `opus` | forwarded as `claude-opus-4-8` | same |

## 10. Wave 11 / 11b — dispatch without MCP (contract §15, amendments §15.12)

Every change below follows a contract clause that changed the behaviour on purpose; none was made
to turn a red check green without one.

- `suites/ext-probe2/ext-probe2.js` F6 — after "Install Team Agent" in a folder that cannot
  dispatch, the follow-up now says the session "cannot dispatch yet" and offers **Update Workspace
  Setup** (macOS/Linux), not "the dispatch MCP server … is not registered" / Register MCP Server
  (§15.7 Nags). Windows keeps the MCP sentence (not exercised here).
- `fixes/shell-a.cjs` F2-mcp-offer — the activation offer for a folder that cannot dispatch is
  the Update Workspace Setup offer and touches no file (§15.7 Nags). The old intent — "Register
  MCP Server" on a `.mcp.json` it does not understand refuses, keeps the file byte-identical, says
  why, never says "Registered" — is now checked by running that command directly.
- `fixes/ui7.cjs` P1-page — a click on the "Update the dispatch policy" chip posts
  `updateWorkspaceSetup`, not `addDispatchPolicy` (§15.7: the policyOutdated chip opens it).
- `fixes/registry.mjs` — fixtures that plant a DEAD `running` event naming no process (no pid,
  supervisorPid or meshWorker) were stamped seconds old; under §15.12 M4 such an event reads alive
  for FAILOVER_GRACE_MS (3 min) — its dispatcher may be between two attempts. They are now
  stamped `PIDLESS_DEAD_AGE_MS` (10 min) old (in the FIFO check's child script: the literal
  600000), so each still tests what it was written for. A new check `15.12 M4 …` pins the grace
  itself: 5 s and 179 s old → alive; 181 s, a dead pid, or a time an hour ahead → settled.
- `fixes/cco.mjs` — `START_LOCK_STALE_MS` 30,000 → 60,000 (§15.12 L11); the 300 KB cut point is
  `min(OUT_CAP, max(8,000, OUT_CAP − stderr written)) − FOOTER_RESERVE` (§15.12 M3); a successful
  tools/call answer has no `isError` at all (absent = not an error, as MCP), so the
  notifications/cancelled check reads `isError !== true`.
- `fixes/setup.cjs` — three expectations follow amendments: `decideSettingsRoot` with a top-level
  but no common-dir answer → the folder itself (§15.7 item 3 amended); `offeredSetupItems('win32')`
  → `['policy']` and the win32 plan refuses item 2 (§15.12 M1); the launcher's pinned text and its
  Node.js sentence follow the amended §15.8.
- Launcher at activation (code, not a test): activation writes the launcher with the node this
  extension host already resolved, else `node`, and starts NO login shell for it — the extra
  `command -v node` shell made ext6 L1/L2 count two shells and ext-probe2 A1b/K7 see a shell before
  the deferred work; Update Workspace Setup resolves node and rewrites the launcher (§15.8 as
  amended in §15.12).
- `fixes/ui7.cjs` C1-policy-command — after a WRITE, the plain policy installer also offers
  "Allow cco" (§15.12 M2), asynchronously (once git has said where the local settings live), so
  it can land in the NEXT run's message window. The scenario's `run()` now waits 400 ms for the
  previous run's offer and keeps that offer apart (`offers`) from what the command said (`plain`).
  No behaviour of the command changed; the "nothing else is said" checks still hold for `plain`.

## 11. Team mode (contract-team-mode-v2)

Every change below follows from the team-mode contract (`.orchestrator/contract-team-mode-v2.md`
and its frozen code, commit 40ea49c); no check was deleted, and each keeps what it was written to
prove.

- `fixes/cco.mjs` output — the 300 KB answer's cut point is `(OUT_CAP − stderr written) −
  FOOTER_RESERVE` with FOOTER_RESERVE now taken from `host-protocol.footerReserveChars(cap, 1)`:
  §4.4 item 2 / L9 add `TEAM_FOOTER_RESERVE_CHARS` (300) to the reserve for the unread team
  footer. The suite no longer re-writes the reserve rule; it calls the contract file's own
  function (`footerReserve` near the top of the suite), so the next move of the reserve cannot
  drift silently.
- `fixes/cco.mjs` output — `dispatch_status` of a 300 KB single JSON line is cut at exactly
  `OUT_CAP − footerReserveChars(OUT_CAP)` = 26,700 (was 27,000; reserve 1,300, was 1,000). §4.4
  item 2, L9.
- `fixes/cco.mjs` output — the six `BASH_MAX_OUTPUT_LENGTH` checks cut at `cap −
  footerReserveChars(cap)`: 10000 → 7,700 (was 8,000); 4000 → 1,700 (was 2,000; the reserve stays
  under the half-cap ceiling, min(1,300, 1,500)); 3999, 50000, abc, 12000.5 → 26,700 (was
  27,000). §4.4 item 2, L9.
- `fixes/cco.mjs` output — a batch of two 200 KB answers is cut at or before `OUT_CAP −
  footerReserveChars(OUT_CAP, 2)` = 26,500 (was 26,800). §4.4 item 2, L9.
- `fixes/cco.mjs` contract — the `RPC_ERROR` snapshot (and the suite's own `RPC` table, which the
  snapshot now is) gains `badCredential: -32012` and `roleForbidden: -32013` (team contract §7.6,
  frozen in host-protocol.ts by T1).
- `fixes/shell-a-stub.cjs` (stand-in, not an expectation) — the `vscode` stand-in gains what
  activation now calls for the Teams group (§8.1): `StatusBarAlignment`,
  `window.createStatusBarItem` (items recorded in `log.statusItems`), `window.onDidCloseTerminal`
  (fired by a test through `h.terminalClosed`), and `onDidExpandElement` on a tree view (its
  emitter is `view._exp`). `fixes/shell-b-stub.cjs` builds on it unchanged and needed nothing.
- `fixes/shell-a.cjs` — `ALL_KEYS` gains the eight team settings of §7.7 (`teamMode`,
  `teamMaxMembers`, `teamMaxRunningTurns`, `teamTurnTimeoutMinutes`, `teamTurnsPerMemberPerHour`,
  `teamTurnsPerDay`, `teamCursorForce`, `teamAgySkipPermissions`); the three "every default"
  lists (`ALL_DEFAULTS`) gain `false, 6, 4, 0, 20, 300, false, false` — `teamTurnTimeoutMinutes`
  has no default in package.json (null: unset follows `workerTimeoutMinutes`, §7.7) and
  `userSetting()` reads it as its kind's 0.
- `fixes/shell-a.cjs` F1-hostile-* — the hostile workspace settings also arm team mode, both
  per-vendor permission switches (§7.7, S3(b)) and out-of-range team numbers; a new check per run
  pins that the registry keeps the team defaults (`teamMode`/`teamCursorForce`/
  `teamAgySkipPermissions` `off`, 6 / 4 / 20 / 300, no `teamTurnTimeoutMinutes` written). The
  workspace-settings warning check now names "all 21 keys" (was 13), counted from `ALL_KEYS`.
- `fixes/shell-a.cjs` F1-user-values — the user's values include all eight team settings; a new
  check pins that the registry holds them (`on`, 3, 2, 30, 10, 100, `on`, `on`); `userSetting()`
  returns each.
- `fixes/shell-a.cjs` F10-lines-posix — "workerManager.js is the only compiled module that calls
  sendText / createTerminal" is split in two: `sendText` is still workerManager.js only;
  `createTerminal` is workerManager.js and teamView.js, where it must occur exactly once and pass
  `shellPath` and `shellArgs` — the take-over terminal, whose process IS the member's
  `claude --resume`, started as the shell and never typed (§3.10 step 3, S1-3).
- `suites/lib/host-harness.js` (stand-in, not an expectation) — the suites' own `vscode` stand-in
  gains the same activation-time APIs as `fixes/shell-a-stub.cjs` (§8.1): `StatusBarAlignment`,
  `window.createStatusBarItem` (items in `rec.statusItems`), `window.onDidCloseTerminal` (exported
  emitter `terminalClosed`), and `onDidExpandElement` on a tree view (`view._exp`). Without them
  activate() threw at `registerTeamModeSurface`, which failed ext-probe2 (11), probe-shellfix (4)
  and probe-kshell (16) as a whole; no check of those suites was changed.
- `suites/ext-verify2` "every declared command is registered in src/extension.ts" — the ids are
  read from `guardedCommand('<id>'` calls AND, while extension.ts registers
  `teamView.teamCommandHandlers(client)` in its one `for … guardedCommand(id, run)` loop, from that
  table's keys (§8.1 commands; the one-door rule `guardedCommand` is unchanged and still checked).
- `suites/ext-verify2` "[UPDATED for W5 SHELL-A] the one createTerminal call …" — one more
  `createTerminal` is allowed: the take-over terminal in src/teamView.ts, recognised by
  `shellPath: plan.command`, `shellArgs: plan.args` and an env built from the host's take-over plan
  (`{ ...plan.env.set }`), never assembled in the extension (§3.10 step 3, M14). Every other
  terminal is still workerManager's one call with `env: options.env`, and every
  `openCommandTerminal` call still passes `claudeTerminalEnv(...)` / `accountTerminalEnv(...)`.
- NOT changed, failing on purpose: `suites/ext-verify2` — the seven package.nls checks (every key
  in package.nls.ko.json and package.nls.zh-cn.json, the same key order in all three files, Hangul /
  Han in every value) fail on the 29 new team keys (`command.team*`, the team settings' and
  views' strings) that are in package.nls.json only. The contract scopes T7 to "`package.nls.json`
  English" (§11 T7 row, §8.1); translating them is unassigned work, not an expectation change.
- NOT changed, failing on purpose: `fixes/shell-a.cjs` F1-hostile-multiroot-{reports,filters}
  "the warning names all 21 keys" and "the warning names the legacy keys too". The notice names at
  most `WORKSPACE_SETTINGS_SHOWN` (24, src/extension.ts) entries; its own comment says that is
  "room for every setting at one level, the pre-rename ones, and a few more from a second level",
  which with 21 settings + 2 legacy + 4 workspace-file entries (27) no longer holds. That is a
  source finding (the constant should grow with the settings), not an expectation change.

## 12. CA — the login state as five states (contract "Login state (CA)", commit c0810be)

Every change below follows the CA contract; no check was deleted, and each keeps what it was written to
prove. Two facts of the contract account for all of them: a Claude Code reading that carries no login
probes (any entry an older version, a hand edit or a fixture wrote) is `unconfirmed`, never `ok` and
never "logged out"; and `loggedOut` needs two "not logged in" probes at least 15 s apart (the newer
taken in the reading process's lifetime) or a dispatch that failed on login. So a fixture that wants a
logged-out Claude Code account now writes two such probes, and one that wants a reading list_workers or
a parked worker takes as it stands writes the `in` probe this version's refresh files with it. Product
regressions CA introduced were fixed in the product, not here (the model's per-build registry read,
Check Login Now's endless "Check Again" chain).

| Suite / file | Check | Was | Now | Why |
|---|---|---|---|---|
| `model` (fixture) | "login expired (isLoginExpired)" | w1's entry `auth.loggedIn: false` alone | the same entry plus two `out` probes 20 s apart through w1's explicit binding, the newer stamped after the bundle loaded | **(b) fixture**: a probe-less "not logged in" is `unconfirmed` (shown `refreshing`); the expectation (`expired`, no detail) stands |
| `ext-verify2` | "views.ts builds the worker context value …" | `worker.${provider}${provider === 'claude' ? '' : '.permission'}` | `worker.claude[.loggedOut]` keyed on `isLoginExpired(usage)`, `worker.<provider>.permission` | **(a) expectation**: the contract names `worker.claude.loggedOut` — Re-login Account only on a confirmed logout |
| `ext-verify2` | "a Claude Code row offers the six common actions plus loginWorker …" | one Claude row context: six common actions + loginWorker | two: `worker.claude` → five (no reloginWorker) + loginWorker + checkLoginNow; `worker.claude.loggedOut` (new check) → six + loginWorker + checkLoginNow; neither offers setWorkerPermissionMode, and the other vendors' rows are unchanged (no checkLoginNow) | **(a) expectation**: Check Login Now on Claude Code rows, Re-login only for `loggedOut` (contract, Wording rules) |
| `probe-shellfix` (fixture) | X4, X12 | w1 `auth.loggedIn: false` alone | plus two `out` probes 20 s apart (`usage.loginProbePath(W1)`), the newer in this process | **(b) fixture**: X4/X12 still prove the Codex worker on w1's directory is never shown the Claude account's state; the Claude row says "login expired" again |
| `probe-kshell` (fixture) | Q1 "login expired — re-login needed" | DATA_C4 `auth: authOut` alone | plus two `out` probes 20 s apart | **(b) fixture**: every row state is reached again |
| `probe-kshell` (fixture) | Q5, the busiest row (DATA_C1) | probe-less entry | one `in` probe of now (`via: usage`) | **(b) fixture**: a healthy account of this version carries its refresh's probe; without it the row gained "⟦login not confirmed⟧". The recorded row is unchanged |
| `probe-kshell` | Q1 states | 44 strings | 45: `login not confirmed` (the probe-less Claude Code entries reach it) | **(a) expectation**: the new row state is covered like the others |
| `fixes/mesh.mjs` (fixture) | "no agent CLI was started by any check" | `fresh()` usage entries without probes | each with an `in` probe of now, explicit binding | **(b) fixture**: `refreshAllUsageIfStale` probes an `unconfirmed` account even when its reading is fresh (contract, Transitions), and bg-runner's parked-worker rung calls it — the stub was run by that usage probe (`fetchAccountUsage`), not by a login check (those go through `claude auth status`) |
| `fixes/models.mjs` (fixture) | accounts: "…a menu entry whose label is not one clean line … is left out" | probe-less Claude Code entries | each Claude Code entry (main included, not the Codex one) with an `in` probe of now | **(b) fixture**: list_workers probed the probe-less accounts, and the refresh rewrote h1's hostile `/model` menu through the cache's own menu reader (which flattens and cuts labels), so the display reader under test never saw the hostile labels |
| `fixes/server.mjs` | claim/claim-lock-held "a dispatch still runs, one-shot …" | failure detail: the answer's text | `{ isError, timedOut, elapsedMs, text }` | not an expectation change: the gate's failure printed an empty text and said nothing more. Alone the check passes, and the dispatch takes ~15.1 s on both the pre-CA and the CA sources (one lock wait); the next failure under load says whether the 60 s call timed out |
