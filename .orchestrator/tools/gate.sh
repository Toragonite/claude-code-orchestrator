#!/bin/bash
# The 2.0 integration gate: a clean build, then every harness, fix suite, older suite and
# verifier, ONE AT A TIME. Offline — no real agent CLI is started and no real account or data
# directory is read (each suite redirects HOME and uses the harness fakes), and no keychain is
# read: every step runs with AGENT_CLI_CREDENTIAL_STORE=memory and fixes/keychain-guard.cjs
# preloaded, which refuses and logs any attempt to run `security`; a logged attempt fails the
# gate (step `keychain-guard`). Harnesses that build their own environment log to a file of
# their own and fail by themselves.
#
#   bash .orchestrator/tools/gate.sh [label]        # about 20 minutes; logs in $TMPDIR/cco-gate-<label>/
#
# Exit 0 only when every step exited 0. Run it on a quiet machine: several suites hold real
# 15 s lock waits and time budgets.
set -u
R="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${1:-$(date +%H%M%S)}"
L="${TMPDIR:-/tmp}/cco-gate-$LABEL"; mkdir -p "$L/tmp" "$L/po"; cd "$R"
export AGENT_CLI_CREDENTIAL_STORE=memory
export NODE_OPTIONS="--require \"$R/.orchestrator/fixes/keychain-guard.cjs\"${NODE_OPTIONS:+ $NODE_OPTIONS}"
export CCO_KEYCHAIN_GUARD_LOG="$L/keychain-refusals.jsonl"; : > "$CCO_KEYCHAIN_GUARD_LOG"
FAILED=0
run() { # name, command...
  local name="$1"; shift
  local t0; t0=$(date +%s)
  "$@" > "$L/$name.log" 2>&1; local rc=$?
  [ "$rc" != "0" ] && FAILED=$((FAILED + 1))
  printf '%-22s exit %-3s %4ss  %s\n' "$name" "$rc" "$(( $(date +%s) - t0 ))" \
    "$(grep -E 'passed|failed|ALL GREEN|ALL CHECKS|FAILURE|tally' "$L/$name.log" | tail -2 | tr '\n' ' ' | cut -c1-150)"
}
echo "gate $LABEL started $(date '+%H:%M:%S'), load $(uptime | sed 's/.*averages: //') — logs in $L"
rm -rf out
run compile            npm run compile
[ -e out/mesh/gateway.js ] && { echo "out/mesh/gateway.js exists: a removed module was built"; FAILED=$((FAILED + 1)); }
run tsc-noemit         npx tsc --noEmit -p .
run detach             node .orchestrator/detach/probe.mjs
run mesh2-selftest     node .orchestrator/mesh2/probe2.mjs --selftest
run mesh2              node .orchestrator/mesh2/probe2.mjs --jobs 4
run providers-selftest node .orchestrator/providers/probe.mjs --selftest
run providers          node .orchestrator/providers/probe.mjs
run fix-registry       node .orchestrator/fixes/registry.mjs
run fix-litter         node .orchestrator/fixes/litter.mjs
run fix-runner         node .orchestrator/fixes/runner.mjs
run fix-mesh           node .orchestrator/fixes/mesh.mjs
run fix-reports        node .orchestrator/fixes/reports.mjs
run fix-server         node .orchestrator/fixes/server.mjs
run fix-models         node .orchestrator/fixes/models.mjs
run fix-cco            node .orchestrator/fixes/cco.mjs --skip-slow
run fix-setup          node .orchestrator/fixes/setup.cjs
run team-store         node .orchestrator/fixes/team-store.mjs
run team-driver        node .orchestrator/fixes/team-driver.mjs
run team-engine        node .orchestrator/fixes/team-engine.mjs
run team-surface       node .orchestrator/fixes/team-surface.mjs
run team-client        node .orchestrator/fixes/team-client.cjs
run team-e2e           node .orchestrator/fixes/team.mjs --skip-slow
run workers-snapshot   node .orchestrator/fixes/workers-snapshot.mjs --no-floor-wait
run fix-views          env TMPDIR="$L/tmp" node .orchestrator/fixes/views.cjs
run fix-shell-a        node .orchestrator/fixes/shell-a.cjs
run fix-shell-b        node .orchestrator/fixes/shell-b.cjs
run fix-ext6           node .orchestrator/fixes/ext6.cjs
run fix-ui7            node .orchestrator/fixes/ui7.cjs
run pool-outcomes      node .orchestrator/lockfix/pool-outcomes.mjs "$L/po"
run dashboard-syntax   node --check media/dashboard/dashboard.js
run older-suites       bash .orchestrator/suites/run.sh
run verify-docs        node .orchestrator/tools/docs/verify-docs.cjs
run verify-l10n        node .orchestrator/tools/l10n/verify-l10n.cjs
run verify-package     node .orchestrator/tools/pkg/verify-package.cjs
run keychain-guard     bash -c '[ ! -s "$CCO_KEYCHAIN_GUARD_LOG" ] && echo "keychain-guard: clean — the gate log is empty" || { echo "FAILURE: a step tried to run the keychain tool (refused):"; cat "$CCO_KEYCHAIN_GUARD_LOG"; exit 1; }'
echo "gate $LABEL finished $(date '+%H:%M:%S'), load $(uptime | sed 's/.*averages: //') — $([ "$FAILED" = 0 ] && echo 'ALL STEPS PASSED' || echo "$FAILED STEP(S) FAILED")"
exit $([ "$FAILED" = 0 ] && echo 0 || echo 1)
