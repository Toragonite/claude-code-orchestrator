# Orchestrator A/B benchmark program

The prompt stack that ships with this extension (worker base prompt, dispatch
policy, model calibration) was tuned with a repeated A/B protocol:

1. Two fresh workspaces get the identical build brief. One is orchestrated by a
   frontier-tier main session, the other by a calibrated `claude-opus-4-8`
   main session. Both use the same worker pool, policy, and MCP setup.
2. A third, fresh session judges both builds **blind**, with a 100-point rubric
   grounded in commands it executes itself (identical probe sets fired at both:
   hostile inputs, concurrency races, kill -9 recovery, documentation-vs-behavior
   checks — whatever the domain calls for).
3. The judge must end with exactly **one** calibration recommendation. That
   recommendation is folded into the non-frontier calibration prompt, and the
   next round runs.

## Results

| Round | Task | Frontier | Calibrated Opus | Gap |
|---|---|---|---|---|
| 1 | REST API build (greenfield) | 96.5 | 85 | 11.5 |
| 2 | same domain, harder probes | 96 | 85 | 11 |
| 3 | same domain, stricter judge | 90 | 81 | 9 |
| 4 | CLI job queue (state/concurrency/time) + mid-flight change request | 99 | 96 | **3** |

Round 4 had **zero functional defects on either side**; the remaining margin
was documentation drift and cross-command error-shape consistency — which
became the round's calibration rule (documentation-conformance gate).

Failure classes consumed per round, each becoming a calibration rule:

1. Basic contract holes (value-semantics validation, undefined failure paths).
2. Platform-raised failure paths; dismissing review findings after a narrow
   reproduction (→ reproduce-the-class dismissal procedure).
3. Over-strict handling of empty/omitted optional inputs (→ absent ≠ invalid);
   premortem findings not carried into the contract (→ traceability rule).
4. Post-fix documentation drift (→ docs are a contract surface under the same
   verification gate).

## What did NOT close the gap

Prompting alone plateaued after round 2. The additional levers, in order of
measured impact:

- **Escalation ladder** — the calibrated orchestrator dispatches design
  consults and adversarial reviews to a frontier *worker*. In round 4 the
  frontier adversarial review caught a real CRITICAL on **both** sides that
  40+ single-feature probes had missed. (This is why the billing guard exists:
  the lever is real, and so is its cost.)
- **Contract tournament** — 2–3 independent contract drafts dispatched in one
  batch, judged and merged. Surfaces holes a single draft misses.
- Maximum-depth reasoning (`ultrathink`) pinned to design turns and
  contract-critical dispatches.

## Honest limits

- Scores across rounds are not directly comparable (rubrics tightened every
  round); the *gap within a round* is the signal.
- n=1 per cell — this is a tuning loop, not a controlled study.
- What structure does not replicate: the frontier tier's in-flight noticing of
  adjacent traps while solving something else. Builds that genuinely need that
  should run the frontier model as the main session.

## Harness documents (research notes, Korean)

- [`ab-test.md`](ab-test.md) — round 1–3 harness: build brief + judge prompt.
- [`ab-test-2.md`](ab-test-2.md) — round 4 harness: two-phase CLI build with a
  breaking change request, execution-grounded judge protocol (P1–P11).
- [`gap-closing-research.md`](gap-closing-research.md) — literature mapping
  (verifier scaling, cascade routing, asymmetric maker–checker) to this
  system's design, with sources.
