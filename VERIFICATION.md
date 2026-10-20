# Verification record — v2

Every gate below was executed by the orchestrator (the main session), not by a
worker. Worker sessions in this environment run under a permission mode that
refuses `node`/`npx`/`npm`, so no worker could run a compiler or a probe; each
of them said so plainly rather than claiming a pass. All execution evidence
here is from this session.

## Gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc -p ./ --noEmit` | clean, exit 0 |
| Build + bundle | `npm run compile` | ok (`out/mcp/server.js`, 45.3 kb) |
| Server stays vscode-free | `npm run bundle-server` | ok — esbuild resolves the whole server graph without `vscode` |
| Engine probes | `test-assets.js` | 19/19 |
| Panel-helper probes | `test-assets2.js` | 15/15 |
| Adversarial-fix regressions | `test-assets3.js` | 16/16 |
| Hooks, namespaces, templates, clamp | `test-assets4.js` | 42/42 |
| End-to-end MCP timeout | `regression-mcp.js` | 7/7 |
| Translation-bundle parity | ko + zh-cn vs English | 203 keys each; 0 missing, 0 extra, 0 placeholder drift, 0 newline drift |
| NLS parity | 3 × `package.nls*.json` vs `%keys%` in package.json | 39 keys each; 0 missing, 0 orphans |
| Packaging | `npx vsce ls` | 31 files; `l10n/**` and `package.nls*.json` ship; no `CLAUDE.md`, `.mcp.json`, `.claude/`, `.orchestrator/`, `docs/` |

## Contract-violating probes (hostile input)

The mandate is to try to break the contract, not confirm it. Each probe below
was run against the real code, not reasoned about.

1. **Ledger path traversal.** A workspace whose `.claude/cco-assets.json` claims
   `"../../victim.txt"` with the victim's real sha256, then a sync.
   *Observed:* the outside file survives; the malicious record is dropped.
   `isSafeRel` rejects the rel before `fs.rmSync` is reached. (`test-assets3`)
2. **Two packs, one install path.** Bundled and private packs both ship
   `commands/plan.md`, both enabled.
   *Observed:* first pack owns the path and is written; the loser is reported
   `conflict` (not `customized`, which would have offered a destructive reset);
   disabling the owner transfers the recorded hash to the other claimant rather
   than deleting the file. (`test-assets3`)
3. **Corrupt ledger.** `.claude/cco-assets.json` containing `{ this is not json`.
   *Observed in v1.3 (`test-assets3`; behaviour since changed):* read yielded
   an empty state and the original was preserved as `cco-assets.json.corrupt`.
   From 2.0 the read is refused, the file is left exactly as it is (not moved
   aside), and nothing is written over it.
4. **Pack rename.** An installed asset's pack changes its `pack.json` name,
   changing every asset key.
   *Observed:* the ledger record migrates to the new key; no orphan is
   reported; the installed file is untouched. (`test-assets3`)
5. **Bare workspace.** A no-op sync in a directory with nothing managed.
   *Observed:* no `.claude/` directory is created. (`test-assets3`)
6. **Hook id collision.** A pack with `fmt.sh`, `fmt.py`, `solo`, `deep/x.sh`.
   *Observed:* ids `fmt.sh`, `fmt.py` (both fall back to full filenames),
   `solo`, `deep` — no silent drop, no readdir-order dependence.
   (`test-assets4`)
7. **chmod as a false customization.** `chmod -x` an installed hook, then sync.
   *Observed:* not reported customized, not rewritten — the ledger hashes
   content, not mode. (`test-assets4`)
8. **Scaffold id injection.** `createAssetTemplate` with `../evil`, `.hidden`,
   `a/b`.
   *Observed:* all three rejected by `ASSET_ID_PATTERN`. (`test-assets4`)
9. **Empty `description:` capture.** A frontmatter whose `description:` is empty
   and is followed by a `#` comment line.
   *Observed:* `readDescription` returns `undefined`. Before the fix, the old
   `/^description:\s*(.+)$/m` captured `# a comment line`, because `\s` crosses
   newlines. Reproduced both regexes side by side before changing the code.
10. **`setTimeout` overflow.** `clampTimeoutMinutes(1e9)`.
    *Observed:* 480, i.e. 28 800 000 ms — below the 2 147 483 647 ms ceiling
    above which Node silently coerces the delay to 1 ms and a "long" timeout
    fires immediately. Twelve boundary cases pass. (`test-assets4`)

## The hang: reproduced, then fixed, then re-probed

A worker's report flagged a residual risk rather than a defect. Per the
dismissal rule, the bug **class** was reproduced before deciding.

*Repro (primitive level).* Spawn `bash -c 'sleep 60 & exec sleep 60'`, attach
`exit` and `close` listeners, SIGKILL after 300 ms, observe 1500 ms later:

```
no grandchild      : exit=true close=true  -> settles
grandchild holds fd: exit=true close=false -> HANGS (close never fired)
```

Node fires `close` only after every stdio stream reaches EOF. A grandchild that
inherited the stdout pipe holds it open, so `close` never arrives. Since the
reworked timeout built its rejection only inside `close`, the dispatch Promise
never settled: no error, no result, `tools/call` never returns. Strictly worse
than the original code, which rejected immediately from the timeout callback.
This is the exact shape of a real dispatch, because the Claude Code CLI spawns
bash tool subprocesses that inherit its stdio.

*Fix.* Settle from `exit` after a 250 ms drain, with a `settled` guard making
double-settle impossible, a 5 s reap timer after SIGKILL as a last resort, and
stdio destroyed on any forced settle so no pipe keeps the server's event loop
alive.

*Re-probe (end to end, against the real `out/mcp/server.js`).* A scratch `HOME`,
a `registry.json` whose `claudePath` is a fake `claude` that traps SIGTERM,
backgrounds a grandchild holding stdout, and never exits; then a real JSON-RPC
`tools/call` for `dispatch_task` with `timeout_minutes: 1`:

```
PASS  gate4: dispatch settled (did not hang)
PASS  gate4: message is the timeout, not "exited with code null"
PASS  gate4: settled within the 15s post-deadline bound      elapsed 70.3s
PASS  gate5: healthy worker returns parsed result
PASS  gate5: result not truncated by the drain timer
PASS  gate5: returned fast (<3s)
PASS  gate6: server exits after stdin close (no leaked handles)
```

70.3 s = 60 s deadline + 10 s SIGTERM grace + drain. The bound is 15 s past the
deadline (SIGTERM → 10 s → SIGKILL → 5 s → forced settle).

## Documentation conformance

Claims extracted from `docs/V2-DESIGN.md` and `assets/README.md` and probed:

| Documented claim | Probe | Observed |
| --- | --- | --- |
| "a chmod alone does not mark a file customized" | probe 7 above | holds |
| "the first pack in load order owns the path" | probe 2 above | holds |
| "bare repos stay bare" | probe 5 above | holds |
| "`hooks/` id strips one trailing extension … both keep their full filename" | probe 6 above | holds |
| "mode `0755`, `#!/usr/bin/env bash`" for the hook scaffold | `test-assets4` | holds |
| "203 runtime keys, 39 nls keys" | parity script | holds |
| "a timed-out dispatch returns at most 15 s after its deadline" | `regression-mcp` gate 4 | settled 10.3 s past deadline |

## Known gaps, stated rather than hidden

- **`symbol-event` codicon is unverified.** It is the icon VS Code maps to
  `SymbolKind.Event`, but `@vscode/codicons` is not a dependency here, so it was
  not checked against the icon list. Failure mode if wrong is cosmetic: the
  QuickPick label renders `$(symbol-event)` as literal text. Not a compile
  error.
- **Namespaced agents and output styles may install files Claude Code ignores.**
  Only *command* namespacing is documented upstream. The recursive walk is
  applied uniformly because it can only surface more files, never fewer; an
  `agents/team/reviewer.md` will be installed even if nothing loads it. This is
  an install-time no-op, not corruption.
- **Windows grandchildren.** On Windows the CLI is spawned through a shell, so
  the direct child is the shell and killing it need not kill its grandchild.
  This predates v2 and is out of scope here, but the drain/reap path now
  guarantees the dispatch still returns.
- **A mode-only pack change does not propagate** until the file's content also
  changes, because the ledger hashes content. Deliberate: hashing mode would
  make a stray `chmod -R` freeze every hook against future updates.
