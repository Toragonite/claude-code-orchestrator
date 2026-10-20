#!/bin/bash
# Orchestration state ⇄ the private orphan branch `ops/team-mode-state` (worktree .orchestrator/state).
#
# WHY: the contracts, plan, review reports, verification records and worker prompts live in the
# gitignored .orchestrator/ and .cco/ — on purpose, so a squash release to the PUBLIC origin can never
# carry them. A second machine still needs them to continue. They are mirrored into an orphan branch
# pushed ONLY to the `private` remote (never origin). HANDOFF.md (status first) lives there natively.
#
#   bash .orchestrator/tools/handoff-sync.sh            # copy state in, commit, push to private
#   bash .orchestrator/tools/handoff-sync.sh --restore  # on another machine: fetch the branch, attach
#                                                       # the worktree, copy the files back into place
set -euo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$R"
BRANCH=ops/team-mode-state
S="$R/.orchestrator/state"
# What is mirrored (paths relative to the repository root). Globs are expanded here.
ITEMS=(
  .orchestrator/plan.md
  .orchestrator/contract-team-mode-v2.md
  .orchestrator/contract-2.0-fixes.md
  .orchestrator/team-probes.md
  .orchestrator/decision-ide-direction.md
  .orchestrator/review-team-contract.md
  .orchestrator/review-t11-engine-report.md
  .orchestrator/review-t11-surface-report.md
  .orchestrator/review-t11
  .orchestrator/VERIFICATION-2.0.md
  .orchestrator/docs-facts-2.0.md
  .orchestrator/known-issues-2.0.md
  .cco
)
MEM="$HOME/.claude/projects/-Users-toragonite-Documents-projects-doraemon-fable-orchestrator/memory"

if [ "${1:-}" = "--restore" ]; then
  git fetch private "$BRANCH:$BRANCH" 2>/dev/null || git fetch private "$BRANCH"
  [ -d "$S/.git" ] || [ -f "$S/.git" ] || git worktree add -q "$S" "$BRANCH"
  git -C "$S" pull -q --ff-only private "$BRANCH" || true
  for it in "${ITEMS[@]}"; do
    [ -e "$S/mirror/$it" ] || continue
    mkdir -p "$(dirname "$R/$it")"; rsync -a "$S/mirror/$it" "$(dirname "$R/$it")/"
  done
  # .cco/ ignores itself with its own .gitignore (not mirrored): recreate it, or the restored task
  # files would show up as untracked in the main tree.
  [ -d "$R/.cco" ] && [ ! -e "$R/.cco/.gitignore" ] && printf '*\n' > "$R/.cco/.gitignore"
  echo "restored into $R — read $S/HANDOFF.md first (memory snapshot: $S/memory/)"
  exit 0
fi

[ -d "$S" ] || { echo "no worktree at $S — run with --restore first"; exit 2; }
mkdir -p "$S/mirror"
for it in "${ITEMS[@]}"; do
  [ -e "$R/$it" ] || continue
  mkdir -p "$S/mirror/$(dirname "$it")"
  rsync -a --delete --exclude 'out/' --exclude '.gitignore' "$R/$it" "$S/mirror/$(dirname "$it")/"
done
# The auto-memory of this project (context a fresh session on another machine would lack).
[ -d "$MEM" ] && { mkdir -p "$S/memory"; rsync -a --delete "$MEM/" "$S/memory/"; }
cd "$S"
git add -A
if git diff --cached --quiet; then echo "state: nothing changed"; else
  git commit -q -m "state sync $(date '+%Y-%m-%d %H:%M %Z') — $(head -n 3 HANDOFF.md 2>/dev/null | tail -n 1 | cut -c1-80)"
  echo "state: committed $(git log --oneline -1)"
fi
git push -q private "$BRANCH" && echo "state: pushed to private/$BRANCH"
