#!/bin/bash
# Build every mutant of mutate.mjs and run it against the scenario that should catch it.
#   bash run-mutants.sh <scratch dir> <deps snapshot dir> [mutant ...]
# A must-FAIL mutant is run until its first failing run (at most the run budget below); a
# must-PASS variant is run in full. Prints one verdict line per mutant.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$1"; DEPS="$2"; shift 2
export LOCKFIX_TMP="${LOCKFIX_TMP:-$SCRATCH/sb}"
node "$HERE/mutate.mjs" "$SCRATCH/variants" > "$SCRATCH/mutants.tsv" || exit 2

budget() {
  case "$1" in
    blind-release) echo 6 ;;
    age-is-proof|deadline-break) echo 4 ;;
    forced-fallback) echo "${FORCED_RUNS:-30}" ;;
    *) echo 200 ;;
  esac
}

while IFS=$'\t' read -r name expect scenarios; do
  if [ "$#" -gt 0 ]; then
    case " $* " in *" $name "*) ;; *) continue ;; esac
  fi
  node "$HERE/build.mjs" --name "$name" --src "$SCRATCH/variants/$name/registry.ts" --deps "$DEPS" --out "$SCRATCH/build" > /dev/null || { echo "$name: BUILD FAILED"; continue; }
  runs="$(budget "$name")"
  extra="--stop-on-fail"
  [ "$expect" = "must PASS" ] && extra=""
  # LOCKFIX_FLAGS: extra run.mjs flags for every mutant (e.g. "--max-procs 8 --load-gate 40,25").
  out="$(node "$HERE/run.mjs" --bundle "$SCRATCH/build/$name/registry.cjs" --scenario "$scenarios" --runs "$runs" $extra ${LOCKFIX_FLAGS:-} 2>&1)"
  rc=$?
  echo "=== $name ($expect; scenarios $scenarios; up to $runs runs each) -> exit $rc"
  echo "$out" | grep -v '^  e.g\.' | cut -c1-240 | head -14
  if [ "$expect" = "must FAIL" ] && [ $rc -eq 0 ]; then echo "!!! MUTANT SURVIVED: $name"; fi
  if [ "$expect" = "must PASS" ] && [ $rc -ne 0 ]; then echo "!!! VARIANT FAILED: $name"; fi
done < "$SCRATCH/mutants.tsv"
