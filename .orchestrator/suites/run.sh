#!/bin/bash
# One runner for the offline extension-host suites. See README.md beside this file.
#
#   run.sh [--only <name>[,<name>...]] [--out <dir>] [--list]
#
# Builds what the suites need into a run directory under the system temp directory (never into
# out/, never into the repository), stages a copy of the suites there, runs them ONE AT A TIME,
# prints one line per suite and a summary, and exits 0 only when every suite that ran passed.
#
# No real claude / codex / cursor-agent / agy is started: every suite gets a scratch HOME inside
# the run directory and a PATH whose first entry holds stand-ins of those four names that only
# record that they were reached (and that makes the run fail). No keychain is read: every suite
# runs with AGENT_CLI_CREDENTIAL_STORE=memory and ../fixes/keychain-guard.cjs preloaded, which
# refuses and logs any attempt to run `security` (a logged attempt makes the run fail).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"

# Order matters only for the last two: the page matrix is the heaviest, and the string-table
# check reads files other work may be regenerating, so it reports last.
ALL="f1 usage2 ui2 ladder unref litter model team hostile probe ext-verify2 ext-probe2 helper-env d2-data probe-shellfix probe-kshell dash-host dash-matrix dash-sync"

# The fewest PASS lines a suite may print and still count as passed. A suite that stops early,
# or loses checks to a careless edit, fails here instead of looking green. Raise a number when
# checks are added; lower one only together with an entry in EXPECTATION-CHANGES.md.
min_for() {
  case "$1" in
    f1) echo 131 ;;            # 132; one fewer when run as root (two EACCES cases fold into one line)
    usage2) echo 122 ;; ui2) echo 72 ;; ladder) echo 63 ;; unref) echo 3 ;;
    litter) echo 159 ;; model) echo 374 ;; team) echo 118 ;; hostile) echo 36 ;; probe) echo 28 ;;
    ext-verify2) echo 88 ;; ext-probe2) echo 228 ;; helper-env) echo 12 ;; d2-data) echo 20 ;;
    probe-shellfix) echo 73 ;; # + 3 that run only with CCO_SUITES_BASE_SHELLFIX (76)
    probe-kshell) echo 105 ;;  # + 4 that run only with CCO_SUITES_BASE_KSHELL (109)
    dash-host) echo 74 ;;
    dash-matrix) echo 30 ;;    # 5 fixtures x 3 themes x 2 widths
    dash-sync) echo 5 ;;
    *) echo 0 ;;
  esac
}

ONLY=""
OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || { echo "run.sh: --only needs a list of suite names" >&2; exit 2; }; ONLY="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || { echo "run.sh: --out needs a directory" >&2; exit 2; }; OUT_DIR="$2"; shift 2 ;;
    --list) for n in $ALL; do echo "$n"; done; exit 0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

SELECTED="$ALL"
if [ -n "$ONLY" ]; then
  SELECTED=""
  for n in $(echo "$ONLY" | tr ',' ' '); do
    case " $ALL " in
      *" $n "*) SELECTED="$SELECTED $n" ;;
      *) echo "run.sh: no suite named '$n' (run.sh --list)" >&2; exit 2 ;;
    esac
  done
fi
selected() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "run.sh: node is not on PATH" >&2; exit 2; fi
NODE_DIR="$(cd "$(dirname "$NODE")" && pwd -P)"
for f in node_modules/typescript/bin/tsc node_modules/esbuild/bin/esbuild; do
  if [ ! -f "$REPO/$f" ]; then echo "run.sh: $f is missing — run npm install in the repository first" >&2; exit 2; fi
done

SYS_TMP="${TMPDIR:-/tmp}"
SYS_TMP="${SYS_TMP%/}"
if [ -n "$OUT_DIR" ]; then
  # Where --out would be, resolved through its nearest existing ancestor — checked BEFORE anything is created.
  case "$OUT_DIR" in /*) want="$OUT_DIR" ;; *) want="$PWD/$OUT_DIR" ;; esac
  anc="$want"
  while [ ! -d "$anc" ]; do anc="$(dirname "$anc")"; done
  want="$(cd "$anc" && pwd -P)${want#"$anc"}"
  case "$want/" in
    "$REPO"/*) echo "run.sh: --out must not be inside the repository ($want)" >&2; exit 2 ;;
  esac
  mkdir -p "$want" || exit 2
  RUN="$(cd "$want" && pwd -P)"
  # a directory this runner used before is reused; anything else in it is left alone
  rm -rf "$RUN/build" "$RUN/stage" "$RUN/home" "$RUN/tmp" "$RUN/guard" "$RUN/logs"
else
  RUN="$(mktemp -d "$SYS_TMP/cco-suites.XXXXXX")" || exit 2
  RUN="$(cd "$RUN" && pwd -P)"
fi
OUT="$RUN/build/out"        # the extension, compiled by tsc
BUNDLE="$RUN/build/bundle"  # single-file bundles of the data modules
STAGE="$RUN/stage"          # the copy of this directory the suites run from
LOGS="$RUN/logs"
mkdir -p "$OUT" "$BUNDLE" "$LOGS" "$RUN/home" "$RUN/guard/bin"

# ---- stand-ins for the four agent CLIs, first on every suite's PATH
GUARD_LOG="$RUN/guard/calls.log"
: > "$GUARD_LOG"
for cli in claude codex cursor-agent agy; do
  printf '#!/bin/sh\necho "%s $* (cwd=$PWD)" >> "%s"\nexit 97\n' "$cli" "$GUARD_LOG" > "$RUN/guard/bin/$cli"
  chmod 755 "$RUN/guard/bin/$cli"
done
SAFE_PATH="$RUN/guard/bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

# ---- the keychain guard, preloaded into every suite process and every node child it starts
KEYCHAIN_GUARD="$REPO/.orchestrator/fixes/keychain-guard.cjs"
KEYCHAIN_LOG="$RUN/guard/keychain.log"
: > "$KEYCHAIN_LOG"

echo "run directory: $RUN"

# ---- build (only what the selected suites read)
need_out=0; need_bundle=0
for n in ext-probe2 probe-shellfix probe-kshell dash-host; do selected "$n" && need_out=1; done
for n in f1 usage2 ui2 ladder unref litter model team hostile probe helper-env d2-data; do selected "$n" && need_bundle=1; done
# esbuild's installer leaves either a native binary or a node script at this path; both run as a program
ESBUILD="$REPO/node_modules/esbuild/bin/esbuild"
build_failed() { echo "BUILD FAILED ($1) — see $LOGS/_build.txt"; tail -20 "$LOGS/_build.txt"; exit 1; }
: > "$LOGS/_build.txt"
: > "$RUN/build/.started"   # anything in the tree newer than this at the end changed while the suites ran
if [ "$need_out" = 1 ]; then
  ( cd "$REPO" && "$NODE" node_modules/typescript/bin/tsc -p . --outDir "$OUT" --sourceMap false ) >> "$LOGS/_build.txt" 2>&1 || build_failed tsc
fi
if [ "$need_bundle" = 1 ]; then
  for f in usage keepalive sessionLitter; do
    ( cd "$REPO" && "$ESBUILD" "src/$f.ts" --bundle --platform=node --log-level=warning "--outfile=$BUNDLE/$f.js" ) >> "$LOGS/_build.txt" 2>&1 || build_failed "esbuild $f"
  done
  # uiModel + team + displayText in one bundle, so the three share one copy of the registry module
  printf 'export * as ui from %s;\nexport * as team from %s;\nexport * as dt from %s;\n' "\"$REPO/src/uiModel\"" "\"$REPO/src/team\"" "\"$REPO/src/displayText\"" > "$RUN/build/entry-both.ts"
  ( cd "$REPO" && "$ESBUILD" "$RUN/build/entry-both.ts" --bundle --platform=node --log-level=warning "--outfile=$BUNDLE/both.js" ) >> "$LOGS/_build.txt" 2>&1 || build_failed "esbuild both"
fi

# which tree this run tested: when it was built, and the newest source file at that moment
newest="$(cd "$REPO" && ls -t src/*.ts src/mcp/*.ts src/mesh/*.ts media/dashboard/*.js 2>/dev/null | head -1)"
echo "built $(date '+%Y-%m-%d %H:%M:%S %z') — newest source file: $newest ($(date -r "$REPO/$newest" '+%H:%M:%S' 2>/dev/null || echo '?'))"

# ---- stage
mkdir -p "$STAGE"
cp -R "$HERE/." "$STAGE/" || { echo "run.sh: staging failed" >&2; exit 2; }

find_chrome() {
  # CHROME, when given, is the answer: a path that is not an executable is "no browser", not a reason to guess
  if [ -n "${CHROME:-}" ]; then [ -x "$CHROME" ] && { echo "$CHROME"; return 0; }; return 1; fi
  local c
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

# The page matrix starts a browser (about eight processes). It waits for a quiet machine.
wait_for_load() {
  local max="${CCO_SUITES_MAX_LOAD:-30}" waited=0 load
  while :; do
    load="$(uptime | sed -E 's/.*load averages?: *([0-9]+)[.,].*/\1/')"
    case "$load" in ''|*[!0-9]*) return 0 ;; esac
    [ "$load" -le "$max" ] && return 0
    [ "$waited" -ge 900 ] && { echo "  (load average still above $max after 15 minutes — running anyway)"; return 0; }
    [ "$waited" = 0 ] && echo "  (1-minute load average is $load, above $max — waiting before the page matrix)"
    sleep 15; waited=$((waited + 15))
  done
}

# Base environment of every suite: nothing is inherited. Each suite gets a temp directory of its own
# inside the run directory, so whatever a suite leaves behind is left THERE — except f1, which binds
# unix sockets under its temp directory and needs their paths short (an address holds 103 bytes): it
# keeps the system temp directory, and removes its sockets itself.
suite_env() { # <home> [NAME=value ...] -- <command...>   (CURRENT names the suite)
  local home="$1"; shift
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  local tmp="$RUN/tmp/$CURRENT"
  if [ "$CURRENT" = f1 ]; then tmp="$SYS_TMP"; else mkdir -p "$tmp"; fi
  env -i HOME="$home" USERPROFILE="$home" PATH="$SAFE_PATH" TMPDIR="$tmp" \
    CCO_SUITES_RUN="$RUN" CCO_SUITES_REPO="$REPO" \
    AGENT_CLI_CREDENTIAL_STORE=memory NODE_OPTIONS="--require \"$KEYCHAIN_GUARD\"" CCO_KEYCHAIN_GUARD_LOG="$KEYCHAIN_LOG" \
    ${extra[@]+"${extra[@]}"} "$@"
}

# Session-identity variables a Claude Code host injects into the process the extension runs in.
IDENTITY_VARS=(CLAUDECODE=1 CLAUDE_CODE_ENTRYPOINT=claude-vscode CLAUDE_CODE_SESSION_ID=s CLAUDE_CODE_MESSAGING_SOCKET=/tmp/x.sock
  CLAUDE_CODE_MESSAGING_TOKEN=tok CLAUDE_PROJECT_DIR=/p)

run_one() { # <name>  → writes $LOGS/<name>.txt, returns the suite's exit status
  local name="$1" H="$RUN/home/$1" S="$STAGE/$1" log="$LOGS/$1.txt"
  CURRENT="$name"
  mkdir -p "$H"
  case "$name" in
    f1)
      ( cd "$S" && suite_env "$H" -- "$NODE" test-f1.js "$BUNDLE/sessionLitter.js" ) > "$log" 2>&1 ;;
    usage2)
      ( cd "$S" && suite_env "$H" "${IDENTITY_VARS[@]}" CLAUDE_PID=1 CLAUDE_EFFORT=high CLAUDE_CODE_EXECPATH=/x CLAUDE_AGENT_SDK_VERSION=1 -- \
          "$NODE" --no-deprecation test-usage2.js "$BUNDLE/usage.js" ) > "$log" 2>&1 ;;
    ui2)
      ( cd "$S" && suite_env "$H" -- "$NODE" test-ui2.js "$BUNDLE/both.js" "$BUNDLE/usage.js" ) > "$log" 2>&1 ;;
    ladder|unref|litter)
      # these three keep HOME, logs and their copy of the bundles beside the test file
      H="$S/home"; mkdir -p "$S/build" "$H/.claude-code-orchestrator" "$S/logs"
      cp "$BUNDLE/usage.js" "$BUNDLE/keepalive.js" "$BUNDLE/sessionLitter.js" "$S/build/"
      ( cd "$S" && suite_env "$H" -- "$NODE" "test-$name.js" ) > "$log" 2>&1 ;;
    model|team|hostile)
      ( cd "$S" && suite_env "$H" -- "$NODE" "test-$name.js" "$BUNDLE/both.js" ) > "$log" 2>&1 ;;
    probe)
      ( cd "$S" && suite_env "$H" "${IDENTITY_VARS[@]}" CLAUDE_CODE_USE_BEDROCK=1 -- "$NODE" test-probe.js "$BUNDLE/both.js" ) > "$log" 2>&1 ;;
    ext-verify2)
      ( cd "$S" && suite_env "$H" -- "$NODE" ext-verify2.js "$REPO" ) > "$log" 2>&1 ;;
    ext-probe2|probe-shellfix|probe-kshell)
      # two Anthropic-scoped variables beyond the ones the harness sets itself, so that "every
      # ANTHROPIC_* / CLAUDE_* variable this process holds is withheld" is tested on more than the named ones
      # A third argument — a compiled copy of the tree as it was before the fix a suite was written for —
      # switches on that suite's before/after comparisons; without it they print SKIP.
      local base=""
      [ "$name" = probe-shellfix ] && base="${CCO_SUITES_BASE_SHELLFIX:-}"
      [ "$name" = probe-kshell ] && base="${CCO_SUITES_BASE_KSHELL:-}"
      ( cd "$S" && suite_env "$H" ANTHROPIC_BASE_URL=http://127.0.0.1:9 CLAUDE_CODE_SSE_PORT=4711 -- "$NODE" "$name.js" "$OUT" "$REPO" ${base:+"$base"} ) > "$log" 2>&1 ;;
    helper-env)
      ( cd "$S" && suite_env "$H" \
          ANTHROPIC_API_KEY=sk-ant-PARENT-KEY ANTHROPIC_AUTH_TOKEN=PARENT-AUTH-TOKEN CLAUDE_CODE_OAUTH_TOKEN=PARENT-OAUTH-TOKEN "CLAUDE_CONFIG_DIR=$H/.claude-host" \
          "ANTHROPIC_CUSTOM_HEADERS=x-parent: 1" ANTHROPIC_FOUNDRY_API_KEY=PARENT-FOUNDRY CLAUDE_CODE_OAUTH_REFRESH_TOKEN=PARENT-REFRESH CLAUDE_CODE_CLIENT_KEY_PASSPHRASE=PARENT-PASSPHRASE \
          CLAUDECODE=1 CLAUDE_CODE_ENTRYPOINT=claude-vscode CLAUDE_CODE_SESSION_ID=host-session-id CLAUDE_CODE_CHILD_SESSION=1 CLAUDE_CODE_SESSION_ATTENDED=1 \
          CLAUDE_CODE_MESSAGING_SOCKET=/tmp/host-msg.sock CLAUDE_CODE_MESSAGING_TOKEN=HOST-MSG-TOKEN CLAUDE_CODE_EXECPATH=/opt/claude/bin CLAUDE_CODE_SSE_PORT=4711 \
          CLAUDE_PID=4242 CLAUDE_PROJECT_DIR=/work/project CLAUDE_AGENT_SDK_VERSION=0.9.9 CLAUDE_EFFORT=high \
          OPENAI_API_KEY=sk-openai-PARENT CURSOR_API_KEY=cursor-PARENT GEMINI_API_KEY=gemini-PARENT HTTPS_PROXY=http://proxy.test:8080 https_proxy=http://proxy.test:8080 NO_PROXY=localhost \
          CLAUDE_CODE_USE_BEDROCK=1 UNRELATED_SETTING=kept -- \
          "$NODE" --no-deprecation prove-helper-env.js "$BUNDLE/usage.js" "$REPO" ) > "$log" 2>&1 ;;
    d2-data)
      ( cd "$S" && suite_env "$H" -- "$NODE" test-d2-data.js "$BUNDLE/both.js" "$BUNDLE/usage.js" ) > "$log" 2>&1 ;;
    dash-host)
      ( cd "$S" && suite_env "$H" -- "$NODE" dash-host-test.js "$OUT" "$REPO" ) > "$log" 2>&1 ;;
    dash-matrix)
      ( cd "$S" && suite_env "$H" "CHROME=$CHROME_BIN" -- "$NODE" dash-matrix.js "$REPO" ) > "$log" 2>&1 ;;
    dash-sync)
      ( cd "$S" && suite_env "$H" -- "$NODE" check-strings.js "$REPO" ) > "$log" 2>&1 ;;
  esac
}

# The tally is counted from the suite's own PASS / FAIL / SKIP lines (the page matrix prints "ok" per
# combination), never taken from a summary line the suite prints about itself.
count_lines() { grep -c "$1" "$2" 2>/dev/null || true; }

ran=0; passed=0; failed=0; skipped=0; FAILED_NAMES=""
T0=$(date +%s)

# The guard is live in a suite's environment: a child node's spawn of /usr/bin/security is refused and logged.
CURRENT=keychain-guard
kc_line="$(suite_env "$RUN/home" -- "$NODE" -e 'const r = require(process.argv[1]).selfCheck(process.env); console.log(r.line); process.exit(r.ok ? 0 : 1)' "$KEYCHAIN_GUARD" 2>&1)"
kc_code=$?
printf '%-15s exit %-3s %s\n' keychain-guard "$kc_code" "$kc_line$([ "$kc_code" = 0 ] || echo '   <-- FAILED')"
[ "$kc_code" = 0 ] || { failed=$((failed + 1)); FAILED_NAMES="$FAILED_NAMES keychain-guard"; }
for name in $SELECTED; do
  if [ "$name" = dash-matrix ]; then
    CHROME_BIN="$(find_chrome || true)"
    if [ -z "$CHROME_BIN" ]; then
      if [ -n "${CHROME:-}" ]; then why="CHROME=$CHROME is not an executable"; else why="headless Chrome not found — set CHROME=<path to the browser binary> to run it"; fi
      printf '%-15s SKIP    %s\n' "$name" "$why"
      skipped=$((skipped + 1)); continue
    fi
    wait_for_load
  fi
  t0=$(date +%s)
  run_one "$name"; code=$?
  secs=$(( $(date +%s) - t0 ))
  if [ "$name" = dash-matrix ]; then P="$(count_lines '^ok ' "$LOGS/$name.txt")"; else P="$(count_lines '^PASS' "$LOGS/$name.txt")"; fi
  F="$(count_lines '^FAIL' "$LOGS/$name.txt")"; K="$(count_lines '^SKIP' "$LOGS/$name.txt")"
  tally="$P passed, $F failed"; [ "$K" = 0 ] || tally="$tally, $K skipped"
  min="$(min_for "$name")"
  verdict=ok
  if [ "$code" != 0 ] || [ "$F" != 0 ] || [ "$P" = 0 ]; then verdict=FAILED
  elif [ "$P" -lt "$min" ]; then verdict=FAILED; tally="$tally — fewer than the $min checks this suite must run"; fi
  printf '%-15s exit %-3s %s  (%ss)%s\n' "$name" "$code" "$tally" "$secs" "$([ "$verdict" = ok ] || echo '   <-- FAILED')"
  ran=$((ran + 1))
  if [ "$verdict" = ok ]; then passed=$((passed + 1)); else failed=$((failed + 1)); FAILED_NAMES="$FAILED_NAMES $name"; fi
done

status=0
[ "$failed" = 0 ] || status=1
# Several suites read the repository itself while they run (sources, manifest, the dashboard page), and the
# build was taken at the start: a file edited meanwhile means this run looked at two trees.
changed="$(cd "$REPO" && find src media/dashboard l10n package.json package.nls.json package.nls.ko.json package.nls.zh-cn.json -type f -newer "$RUN/build/.started" 2>/dev/null | head -6 | tr '\n' ' ')"
if [ -n "$changed" ]; then
  echo "NOTE: files changed while the suites ran ($changed) — the results may describe two trees; run again before diagnosing a failure."
fi
if [ -s "$KEYCHAIN_LOG" ]; then
  echo "KEYCHAIN GUARD: a suite tried to run the keychain tool (refused; first argument only):"
  sed 's/^/  /' "$KEYCHAIN_LOG"
  status=1
fi
if [ -s "$GUARD_LOG" ]; then
  echo "GUARD: an agent CLI was started by name through PATH — a suite's own fake did not catch it:"
  sed 's/^/  /' "$GUARD_LOG"
  status=1
fi
echo "== $ran suites ran in $(( $(date +%s) - T0 ))s: $passed passed, $failed failed${FAILED_NAMES:+ ($(echo $FAILED_NAMES))}, $skipped skipped — logs: $LOGS"
exit "$status"
