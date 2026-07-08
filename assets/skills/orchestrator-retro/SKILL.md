---
name: orchestrator-retro
description: Post-build retrospective for orchestrated runs — review the dispatch log, verification records, and worker outputs of the last orchestrated build and distill lessons into .orchestrator/plan.md.
---

# Orchestrator retrospective

Run after an orchestrated build finishes (all dispatches integrated and
verified). Produces a short retro that makes the next orchestration better.

## Steps

1. Read `.orchestrator/plan.md` and `VERIFICATION.md` if present, plus the
   final reports of the run's dispatched tasks.
2. Answer, with evidence from those artifacts:
   - Which contracts held, and which needed re-dispatch? Why?
   - Which premortem items fired? Which failures were NOT predicted?
   - Was worker/model selection right (Opus vs Sonnet vs frontier)?
3. Append a dated **Lessons** entry to `.orchestrator/plan.md` — one line per
   lesson, with why it mattered. Update stale lessons instead of duplicating.

Keep the retro under 30 lines; it is a steering artifact, not a report.
