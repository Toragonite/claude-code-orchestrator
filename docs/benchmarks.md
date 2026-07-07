# Orchestrator A/B benchmark program — a detailed retrospective

**English** | [한국어](benchmarks.ko.md) | [简体中文](benchmarks.zh-CN.md)

The prompt stack that ships with this extension (worker base prompt, dispatch
policy, model calibration) was not written in one sitting — it was tuned over
four adversarial A/B rounds. This document is the full retrospective: what each
round measured, the evidence behind each verdict, which calibration rule each
round produced, and what the program as a whole taught us about closing the gap
between a frontier orchestrator and a calibrated non-frontier one.

## Protocol

Every round followed the same shape:

1. **Two fresh workspaces, one brief.** The identical build prompt goes to two
   Claude Code sessions: one orchestrated by a frontier-tier main model, one by
   `claude-opus-4-8`. Both use the same worker pool, the same dispatch policy,
   the same MCP setup. The workers are identical — only the orchestrator
   differs, so any quality difference is attributable to orchestration:
   contract design, verification aggression, and judgment on review findings.
2. **Blind, execution-grounded judging.** A third, fresh session receives both
   folders with neutral names and a 100-point rubric. Every point must be
   backed by a command the judge ran itself — identical probe sets fired at
   both builds (hostile inputs, concurrency races, `kill -9` recovery,
   documentation-versus-behavior checks, whatever the domain demands). Where
   the brief left a decision open, each project is judged against **its own
   pinned contract**, not against the other project's choice.
3. **Exactly one recommendation.** The judge must end with a single
   highest-leverage calibration addition. That rule is folded into the
   non-frontier calibration prompt — never into the tier-neutral static policy
   unless the frontier side also failed — and the next round runs.

The forcing function matters: one recommendation per round keeps the
calibration from bloating into a checklist nobody follows, and it makes each
round falsifiable — if the rule works, that failure class must not recur.

## Results at a glance

| Round | Task | Frontier | Calibrated Opus | Gap | Rule produced |
|---|---|---|---|---|---|
| 1 | Expense-tracker REST API (greenfield, R1–R7) | 96.5 | 85 | 11.5 | Structured unknown-unknowns hunting |
| 2 | Same domain, harder adversarial probes | 96 | 85 | 11 | Reproduce-the-class dismissal procedure |
| 3 | Same domain, stricter execution-grounded judge | 90 | 81 | 9 | Absent ≠ invalid; premortem traceability |
| 4 | Job-queue CLI (state/concurrency/time) + mid-flight change request | 99 | 96 | **3** | Documentation-conformance gate |

Scores are **not comparable across rounds** — the rubric and judge strictness
tightened every round (round 3's judge scored the same-quality frontier build
6 points lower than round 2's). The signal is the *within-round gap* and the
*kind* of defect that produced it.

## Round 1 — the baseline: where an uncalibrated gap actually lives

**Task.** Build an expense-tracker REST API + minimal frontend from scratch:
validated POST, filtered listing, monthly summary, DELETE semantics, XSS-safe
frontend, ≥25 tests, README (R1–R7).

**Verdict: 96.5 : 85.** The calibrated side at this point had only the generic
operating rules (delegate-don't-implement, externalized planning, autonomy,
evidence-based reporting). The 11.5-point gap decomposed almost entirely into
**basic contract holes**: validation rules that checked shape but not meaning,
failure paths the contract never defined, and edge inputs no task prompt had
pinned — each one a thing a worker *could* have handled, but only if the
contract had told it to. The frontier orchestrator's contracts pinned these
before any worker started typing.

**Rule adopted.** The first big calibration block: *hunt unknown unknowns
structurally* — a premortem before freezing any contract, a self-generated
domain footgun checklist (categories universal, items per-project), validation
defined at the level of **value semantics** rather than surface shape, explicit
behavior for **outside-spec failure paths**, at least five hostile probes
recorded in a verification file, and a fresh-context adversarial review
dispatched as its own task.

**Takeaway.** The gap was never "Opus writes worse code." Workers wrote the
code on both sides. The gap was that one orchestrator *saw traps in advance*
and encoded them into contracts; the other found out from the judge. That
diagnosis — contract resolution is the variable — set the direction for every
later round.

## Round 2 — failure classes climb one level

**Task.** Same domain, but the judge probed deeper: platform-raised failure
paths, money-representation edges, and the handling of adversarial-review
findings.

**Verdict: 96 : 85.** The round-1 rule worked — the basic holes were gone. The
calibrated side now failed one level up:

- **Platform-raised errors were nobody's contract.** Probes that made the
  *framework itself* throw before any application validation ran (URI-decoding
  errors in middleware, payload-size limits) produced unhandled or
  inconsistently-shaped responses. The contract had defined the app's own
  failure paths (round 1's lesson) but not the platform's.
- **Money-input contract strength** and frontend contract specificity lagged
  the frontier side's.
- Most damaging: a real adversarial-review finding was **dismissed after a
  narrow reproduction** — the orchestrator tried the reviewer's literal probe,
  saw it pass in its setup, and closed the finding. The class was real; the
  single probe wasn't representative.

**Rule adopted.** The dismissal procedure: to dismiss a review finding you must
reproduce the **bug class**, not the reviewer's literal probe — personally run
at least two variants (different operation/method, different input position or
size), record them in the verification file, and treat errors raised by the
platform/framework itself as members of the class, pinned explicitly in the
contract's failure-path list.

**Takeaway.** Calibration rules genuinely consume failure classes — and the
frontier model then finds the next layer up. Round 2 also localized the gap
precisely: of the three orchestration levers (contract design, verification
aggression, judgment on findings), the costliest miss was a **judgment**
failure, not a design failure. Judgment is the hardest thing to delegate.

## Round 3 — one root cause wearing two costumes

**Task.** Same domain; the judge this round executed everything itself
(both servers stood up, identical curl probe sets, process forensics on git
history and verification files) and scored more strictly across the board.

**Verdict: 90 : 81.** Functionally both builds were strong; five factors
decided it, and the two decisive ones shared a single root:

- `GET /api/expenses?category=&month=` — the calibrated build returned
  **400 invalid_month** for empty filter values; the frontier build returned
  200 with the full list. Browser forms serialize empty fields routinely; its
  own frontend only survived by never sending empty params. An API-contract
  defect, not a style choice.
- `GET /api/summary` without `month` — the calibrated build made the parameter
  **mandatory** (400), so "total spending overall" was simply impossible; the
  frontier build returned the all-time aggregate.
- The calibrated frontend implemented a category filter server-side but **never
  exposed it in the UI** — a self-inconsistency between its own contract
  surfaces.
- Error-code taxonomy drift (`invalid_json`/`invalid_amount` where the
  contract's own vocabulary said `invalid_body`).
- Process forensics: the frontier side left a versioned contract (v1.0→v1.1),
  two clean fix cycles fed back into the contract, and a verification file
  whose numbers stayed consistent; the calibrated side's verification file
  retained stale intermediate counts.

Both decisive functional defects were **over-strictness applied to
empty/omitted input** — "rigor" pointed at the wrong target. The sharpest
detail: the calibrated orchestrator's *own premortem* (item 8) had flagged
exactly this trap, and the implementation resurrected it anyway. The finding
existed; it just never became a contract clause or a test.

**Rules adopted.** Two, because the round exposed a defect *and* a process
leak: (a) **absent ≠ invalid** — for every optional input, pin "omitted or
empty = feature not requested, succeed with default behavior" as the contract
default, reserving strict validation for present-but-invalid values; (b)
**premortem traceability** — every premortem cause must map to a contract
clause, every clause to a probe; an identified-but-unpinned trap protects
nothing.

**Takeaway.** By round 3 the calibrated side's *premortems were good* — the
bottleneck had moved from "can't see the trap" to "can't carry the sighting
into the contract." That is a mechanical, fixable process gap, which is
exactly what a calibration rule can encode.

## Round 4 — domain shift, functional dead heat

**Task.** Deliberately different: a file-backed **job-queue CLI** (zero
runtime dependencies) hitting the footgun categories rounds 1–3 never touched
— exactly-once claiming under concurrent workers, SIGKILL crash recovery,
state-machine transitions, backoff timing, priority/FIFO ordering — plus a
**phase-2 change request** delivered only after phase-1 completion: job
dependencies, a destructive prune command, and a breaking change to a default
behavior. This tested two things no greenfield round could: whether the
calibration rules transfer across domains, and whether an orchestrator can
revise a frozen contract without regressing.

**Verdict: 99 : 96 — zero functional defects on either side.** Every
functional probe came back equal, including the hardest ones:

- Exactly-once: 20 jobs, two racing `work --concurrency 4` processes, three
  repetitions — 20 executions, zero duplicates, both sides.
- SIGKILL recovery: both recovered orphaned jobs **per their own documented
  semantics** (one recorded the interrupted attempt as `interrupted`, the
  other as `orphaned` with a process-group kill of the surviving child — both
  valid, both honored their pinned contract).
- Hostile command strings (`$(…)`, backticks, quotes, non-ASCII) round-tripped
  with no injection artifacts on either side; both independently chose
  argv-array storage with `shell: false`.
- Backoff timing, dependency cascades (failed parent → transitively
  blocked/skipped children), prune safety, and the breaking-change migration
  all matched their contracts on both sides.

The entire 3-point margin was **rigor allocation in the final mile**:

- The calibrated side's adversarial review caught a genuine CRITICAL (pruning
  a succeeded parent silently orphaned a dependent child). The fix was real —
  but it landed in the contract file and the code, **not in the README**. Its
  most important safety behavior became invisible to users. The frontier side
  shipped the same protection *with* a README-documented notice, observed
  verbatim in the judge's probe.
- The calibrated README claimed "all env vars validated at startup, exit 1" —
  refuted by observation (`JOBQ_STALE_MS=abc` on one subcommand exited 0; the
  judge probed the claim across four variables and three subcommands before
  calling it).
- One corrupt-record condition produced two different warning vocabularies
  from two subcommands.

Two details worth recording honestly. First, the process deductions were
**symmetric**: the frontier side lost its only point for lacking an explicit
risk→clause→probe table — the very artifact our calibration *mandates* for the
non-frontier side (which had it, and was praised for it). The calibration is
no longer purely corrective; in at least one place it exceeds frontier-native
process. We deliberately did not port it back — the frontier tier performs
best with maximum freedom, and one rubric point is the accepted price. Second,
both sides' fresh-context **frontier-worker adversarial reviews each caught a
real cross-feature CRITICAL** that 40+ single-feature probes had missed — the
escalation ladder's value, previously a hypothesis from the literature, was
confirmed on both sides of the same round.

**Rule adopted.** The documentation-conformance gate: user-facing docs are a
contract surface under the same verification gate as code. Any
behavior-changing fix updates the docs in the same dispatch (docs belong in
the fix's file-ownership list), and before the final report a conformance pass
extracts every testable doc claim, probes it, and records claim-versus-
observation in the verification file.

**Takeaway.** The functional gap is closable — it was closed, across a domain
shift, with no recurrence of any earlier failure class. What remains at the
3-point level is "where does rigor point in the last hour," which is a
resource-allocation habit, not a capability difference.

## Cross-round analysis

### The failure-class ladder

Each round's decisive defect was one level subtler than the last:

| Round | Class | Nature |
|---|---|---|
| 1 | Contract holes (shape-only validation, undefined failure paths) | Design |
| 2 | Platform-raised failures; narrow-reproduction dismissals | Design + **judgment** |
| 3 | Over-strictness on absent input; premortem→contract leakage | Semantics + **process** |
| 4 | Post-fix documentation drift; claim-vs-observation gaps | **Allocation** |

The progression itself is the strongest evidence the loop works: no class ever
recurred after its rule landed, including across the round-4 domain shift —
the round-3 "absent ≠ invalid" rule held in a CLI-flag world it was never
written for.

### Three levers an orchestrator cannot delegate

Workers were identical in every round, so every point of gap traces to one of:

1. **Contract design** — what gets pinned before workers start (rounds 1–3).
2. **Verification aggression** — what the orchestrator personally tries to
   break, and how hostile the probes are (rounds 1, 4).
3. **Judgment on findings** — what happens when a review says "this is broken"
   and the orchestrator must decide (rounds 2, 4). This proved the most
   expensive to get wrong and the hardest to proceduralize; the dismissal rule
   and the doc-gate are both, at bottom, judgment scaffolds.

### What prompting could not do, structure did

Prompt iteration saturated around round 2–3 (11.5 → 11 → 9). The round-4
collapse to 3 coincided with the structural levers switching on:

- **Escalation ladder** (frontier model as a *worker* for design consults and
  adversarial reviews): validated experimentally — both sides' frontier
  reviews caught CRITICALs that saturation probing missed. This is consistent
  with the verifier-scaling literature (a strong verifier lifts a weaker
  generator further than more generation does), and it is exactly why the
  extension enforces a **billing guard** around the same lever: the value is
  real, and after frontier models moved to metered billing, so is the cost.
- **Contract tournament** (2–3 independent drafts, judge-merged): in round 4
  the two independent drafts chose opposite claim architectures
  (rename-as-claim vs lock-file-lease) and *both* proved correct under the
  same probes — evidence that the tournament's value is hole-coverage
  diversity, not picking "the right" design.

### Placement discipline

Every rule from this program lives in the **briefing-delivered calibration**
(served only to non-frontier orchestrators), never in the static CLAUDE.md
policy. Rationale, confirmed by the data: the frontier tier handled every one
of these cases natively, and frontier performance is best preserved by keeping
its instruction surface minimal. The static policy carries only tier-neutral
structural facts (delegation principle, tool mechanics, escalation-ladder
economics). Where money is at stake rather than quality, the rule moved out of
prompts entirely and into **server-enforced code** (the billing guard) — a
prompt can be ignored; a rejected dispatch cannot.

## Threats to validity

- **n = 1 per cell.** This is a tuning loop with a falsification criterion
  (classes must not recur), not a controlled study. Treat the trajectory, not
  any single score, as the finding.
- **Rubric drift across rounds** is real and intentional (each judge probed
  deeper); cross-round score comparisons are meaningless. Within-round
  comparisons are protected by identical probe sets and blind folder names.
- **Judge model family.** The judges were Claude sessions; a systematic
  same-family bias would affect both sides equally within a round but could
  compress or stretch gaps.
- **Benchmark overfitting** was the explicit reason round 4 changed domains;
  the rules held. One domain shift is evidence, not proof.
- **Cost asymmetry is unmeasured.** The frontier side's quota consumption per
  build was not part of the rubric; the program optimized quality-per-round,
  not quality-per-dollar. The billing guard exists precisely because these can
  now diverge.

## What we'd run next

- A round with the **escalation ladder disabled** on the calibrated side, to
  isolate its contribution to the round-4 collapse (confound: rules 3a–3e also
  landed between rounds 3 and 4).
- A **quality-per-dollar** rubric: same builds, scored against tokens and
  metered cost.
- A cross-workspace **lessons store** (the round-3 premortem-leak class
  suggests orchestrators forget across sessions what they learned within one).

## Harness documents (research notes, Korean)

- [`ab-test.md`](ab-test.md) — rounds 1–3 harness: build brief + judge prompt.
- [`ab-test-2.md`](ab-test-2.md) — round 4 harness: two-phase CLI build with a
  breaking change request and the execution-grounded judge protocol (P1–P11).
- [`gap-closing-research.md`](gap-closing-research.md) — literature mapping
  (verifier scaling, cascade routing, asymmetric maker–checker) to this
  system's design, with sources.
