#!/bin/bash
# Regenerate the string table of the offline dashboard preview (media/dashboard/fixtures.js) from
# dashboardStrings() in src/dashboard.ts, and check key parity with the page (media/dashboard/dashboard.js).
# Needs: node (with the repository's node_modules/typescript), python3. Nothing outside the repository.
# usage: .orchestrator/tools/l10n/sync-dashboard-strings.sh [repo]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$HERE/../../..}" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node "$HERE/extract-dashboard-strings.cjs" "$ROOT" > "$TMP/strings.json"
python3 "$HERE/fill-dashboard-fixtures.py" "$ROOT" "$TMP/strings.json"
node -e "
const t=require('$TMP/strings.json'); const fs=require('fs');
const js=fs.readFileSync('$ROOT/media/dashboard/dashboard.js','utf8');
const used=new Set();
for(const m of js.matchAll(/\bt\('([A-Za-z0-9]+)'/g)) used.add(m[1]);
for(const m of js.matchAll(/'([A-Za-z][A-Za-z0-9]+)'/g)) if(t[m[1]]!==undefined) used.add(m[1]);
const missing=[...used].filter(k=>t[k]===undefined);
const unused=Object.keys(t).filter(k=>!used.has(k));
console.log('table',Object.keys(t).length,'used by the page',used.size,'missing',JSON.stringify(missing),'unused',JSON.stringify(unused));
process.exit(missing.length?1:0);
"
node --check "$ROOT/media/dashboard/dashboard.js"
node --check "$ROOT/media/dashboard/fixtures.js"
