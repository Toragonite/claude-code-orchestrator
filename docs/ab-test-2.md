# A/B 벤치마크 2 — 파일 기반 잡 큐 CLI (상태·동시성·시간·순서 + 중간 요구사항 변경)

1차 벤치마크(지출 추적 API)와 의도적으로 다른 축을 검사한다:

- **도메인 전환**: 웹 API → CLI. 보정 프롬프트가 1차 도메인에 과적합됐는지 확인.
- **footgun 카테고리 전환**: 입력 경계·숫자 중심 → **상태 머신, 동시성(exactly-once), 크래시 복구, 시간 의미론, 순서 보장**.
- **새 축 — Phase 2 중간 요구사항 변경**: Phase 1 완료 보고 후에만 Phase 2 프롬프트를 전달한다.
  얼린 계약을 개정하고(버전), 파괴적 변경을 문서·테스트까지 일관 반영하고, 회귀 없음을 재검증하는
  능력은 그린필드 1회성 빌드로는 측정되지 않는다.

## 실행 방법

1. 빈 폴더 `run-fable/`, `run-opus/`를 만들고 각각 새 Claude Code 세션을 연다
   (오케스트레이터 모델만 다르게, 디스패치 정책·MCP 등록 동일).
2. 각 세션에 **Phase 1 프롬프트**를 그대로 붙여넣는다.
3. 세션이 Phase 1 완료를 보고하면 **같은 세션에 Phase 2 프롬프트**를 붙여넣는다.
4. 두 쪽 다 끝나면 제3의 새 세션에서 **판정 프롬프트**로 평가한다.
5. 프로세스 지표(아래 표)는 대시보드/`~/.fable-orchestrator/tasks.jsonl`에서 수집한다 —
   특히 opus 런이 **claude-fable-5 워커를 설계 자문·적대 리뷰에 실제로 썼는지**가 이번 런의 핵심 변수다.

---

## Phase 1 프롬프트 (양쪽 동일)

```
ultrathink

Build "jobq", a file-backed job queue CLI, in this workspace.

Constraints:
- Node.js >= 18, TypeScript. ZERO runtime dependencies (dev dependencies allowed:
  typescript, vitest, @types/node only). No daemons, no databases — all state lives
  in files under a `.jobq/` directory in the working directory.
- Initialize a git repository and commit at meaningful phase boundaries with
  descriptive messages.

Requirements:

R1. `jobq add [options] -- <command...>` enqueues a shell command as a job and
    prints the new job id to stdout.
    Options: `--priority <high|normal|low>` (default normal),
    `--run-at <ISO-8601 timestamp>` (optional; the job is not eligible before this
    time), `--max-attempts <n>` (default 3).
    Command strings containing spaces, quotes, `;`, `$`, and non-ASCII characters
    must round-trip through storage and execute correctly.

R2. `jobq list [--status <status>] [--json]` shows jobs (id, status, priority,
    attempts, timestamps). Human-readable table by default, stable
    machine-readable output with `--json`.

R3. `jobq work [--concurrency <n>] [--once]` executes eligible jobs.
    Eligibility: status pending AND run-at (if any) has passed. Claim order:
    priority (high > normal > low), then FIFO within a priority. Job stdout/stderr
    are captured to per-job log files. `--once` drains all currently-eligible jobs
    and exits (this must exist — it is how the queue is tested deterministically).

R4. Retry with exponential backoff: a job whose command exits non-zero has its
    attempt recorded; if attempts < max-attempts it returns to pending and becomes
    eligible again only after a backoff delay (document the exact formula; provide
    `--backoff-base-ms` on `work` so tests can shrink it). When attempts reach
    max-attempts the job becomes `dead`.

R5. Concurrency and crash safety — the core requirement:
    a. Two or more `work` processes running simultaneously against the same queue
       directory must never execute the same job twice (exactly-once claiming).
    b. If a worker process is killed with SIGKILL mid-job, the next `work`
       invocation must recover the orphaned job: it must not be lost, must not be
       stuck in `running` forever, and must not be executed twice concurrently.
       Define and document exactly how an interrupted attempt is counted.

R6. Lifecycle management: `jobq show <id>` (full detail including attempt history
    with per-attempt exit codes and timestamps), `jobq cancel <id>` (allowed from
    pending only; anything else is a domain error), `jobq retry <id>` (dead only;
    define and document whether the attempt counter resets).
    Exit codes for every command: 0 success, 1 domain error (unknown id, illegal
    state transition, job-level failure surfaced by `work --once`… define it),
    2 usage error (unknown flags, malformed values, unknown subcommand).

R7. Tests: at least 25, runnable with `npm test`, non-interactive, and green.
    They must include at least: claim-ordering, backoff timing, exactly-once under
    concurrent workers, and SIGKILL recovery.

R8. README.md: quick start, every command with examples, the full job state
    machine (every status and every legal transition), the exit-code table, the
    on-disk storage format, and known limitations.

Anything these requirements leave open (timestamp handling, status names beyond
those mandated, storage layout, how `--status` with an empty value behaves, …) is
yours to decide — but every such decision must be pinned in your interface
contract and README before implementation, and your verification must exercise it.

When everything above is implemented and verified, report completion with
evidence. A follow-up change request will arrive after your report.
```

## Phase 2 프롬프트 (Phase 1 완료 보고를 받은 뒤, 같은 세션에)

```
ultrathink

Change request — the queue is now used by a team and needs coordination features.
Revise your frozen contract (bump its version, keep the old version visible),
implement, and re-verify. All Phase 1 behavior must be preserved except where
this change request explicitly overrides it; re-run your full Phase 1
verification at the end and record the rerun in your verification file.

C1. Job dependencies: `jobq add --after <id>` (repeatable) makes the new job
    eligible only after ALL referenced jobs reach `done`. Referencing a job id
    that does not exist is a usage error at enqueue time. Define and document the
    complete semantics for every non-success terminal outcome of a parent (dead,
    canceled, and any status you introduced): what happens to the child, and is
    it transitive? Pin it, implement it, test it.

C2. `jobq prune --older-than <duration> [--status <status>]` permanently deletes
    terminal-state jobs older than the given duration (formats: 45s, 30m, 12h,
    7d). `--older-than` is required — refusing to default a destructive operation
    is part of the contract. Define which statuses are prunable; pruning must
    never touch a job another process is executing.

C3. BREAKING: `jobq list` with no `--status` now shows only ACTIVE jobs
    (everything not in a terminal state) instead of all jobs; a new `--all` flag
    restores the old behavior. Update every affected surface: README, help text,
    tests, and any of your own tooling that relied on the old default.

Report completion with evidence when done.
```

---

## 판정 프롬프트 (제3 세션, 두 런 완료 후)

```
ultrathink

You are judging two implementations of the same two-phase specification, built by
two different engineering teams in ./run-fable and ./run-opus. Score them
head-to-head out of 100 points each. You must not assume either is better from
folder names, code style, or documentation polish — every point you award or
deduct must be backed by a command YOU ran in this session and its observed
output. Read each project's README and contract first; where the spec left a
decision open, judge the project against ITS OWN pinned decision (an undocumented
behavior, or a documented behavior that observation contradicts, is a defect; a
pinned decision that merely differs from the other project's is not).

Setup for each project: npm install, npm test (record pass counts), then probe
the real CLI in a scratch directory. Run the SAME probe set against both:

P1. Exactly-once under concurrency: enqueue 20 jobs, each appending its index to
    a shared file then sleeping ~200ms. Start TWO `work --once --concurrency 4`
    processes simultaneously. Assert the file has exactly 20 lines and each index
    appears exactly once. Repeat 3 times.
P2. SIGKILL recovery: enqueue a job that sleeps 10s, start `work`, kill -9 the
    worker after ~1s. Verify the job is not stuck: run `work --once` again and
    check the job's fate matches the project's documented interrupted-attempt
    semantics. Assert it never ran twice concurrently and was never lost.
P3. Ordering: enqueue low, high, normal, high (in that order) with a command that
    records execution order; `work --once --concurrency 1`; assert
    high,high,normal,low with FIFO between the two highs.
P4. Backoff: a job that always fails, max-attempts 3, small --backoff-base-ms.
    Assert it ends `dead` after exactly 3 attempts, with inter-attempt gaps
    consistent with the documented formula, and attempt history visible in
    `show`.
P5. Time semantics: --run-at in the past (must be eligible immediately),
    --run-at 2099 (must NOT run), --run-at "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z", and "garbage" (all must be usage errors, exit 2).
P6. Absent vs invalid filters: `list` with no --status, `--status ""` /
    `--status=`, and `--status bogus`. Empty/omitted must follow the documented
    default (post-C3: active only; --all restores); bogus must be a usage error.
    Also verify --json output is stable and parseable in every case.
P7. Exit codes: success → 0; cancel on a running/done job and unknown id → 1;
    unknown subcommand, unknown flag, malformed value → 2. Check stderr carries
    the error, stdout stays clean for machine-readable paths.
P8. Hostile command strings: enqueue commands containing single/double quotes,
    `;`, `$HOME`, backticks, and non-ASCII; assert they round-trip and execute
    with correct quoting (no word-splitting or injection artifacts).
P9. Dependencies (C1): a chain A→B→C where B is made to fail permanently; assert
    C's fate matches the documented semantics, transitively. --after with a
    nonexistent id at enqueue → exit 2. A child whose parents are all done runs.
P10. Prune (C2): prune without --older-than → usage error. Garbage durations
    ("7", "3 weeks", "-5m") → usage error. Prune must not delete active jobs or
    a job currently executing.
P11. C3 regression sweep: old default gone, --all present, README/help/tests all
    updated consistently; then re-run P1–P8 spot checks to confirm Phase 2 did
    not regress Phase 1.

Scorecard (100 per project):
- Phase 1 functionality, 32: R1 4 / R2 4 / R3 6 / R4 6 / R5 8 / R6 4 — scored
  from P1–P8 observations only.
- Phase 2 functionality, 16: C1 8 / C2 4 / C3 4 — from P9–P11.
- Tests, 12: count (≥25), whether the mandated categories genuinely exercise
  concurrency and SIGKILL (not mocked away), determinism (run npm test twice).
- Code quality, 14: contract consistency across commands (error shapes, exit
  codes, --json), no over-engineering, no dead code, storage format matches its
  documentation.
- Documentation, 10: README complete per R8, and — weighted heaviest — every
  observed behavior matches what is documented, including the pinned open
  decisions and the contract version history from the change request.
- Process, 16: contract versioning across Phase 2 (old version visible, revision
  motivated); premortem items traceable each to a contract clause and a
  verification probe; adversarial review dispatched with findings and a
  reproduce-the-class dismissal record for anything dismissed; verification file
  internally consistent (no stale intermediate counts) and containing the Phase 2
  full-rerun evidence.

Output format:
1. Winner and final score for both, one line.
2. The full scorecard as a table with a one-line evidence note per row citing
   the probe/command behind the score.
3. The decisive gap factors, at most 5, most impactful first — each with the
   exact commands and outputs that demonstrate it.
4. Items that were equal and did not affect the outcome.
5. Exactly ONE recommendation: the single highest-leverage addition to an
   orchestrator calibration prompt that would have prevented the loser's most
   damaging defect class. State the defect class, cite the evidence, then give
   the recommendation as 3–6 sentences of imperative prompt text.
```

---

## 프로세스 지표 (tasks.jsonl / 대시보드에서 수집)

| 지표 | run-fable | run-opus |
|---|---|---|
| 총 dispatch 수 (Phase 1 / Phase 2) | | |
| 병렬 배치(dispatch_tasks) 호출 수 | | |
| 워커 모델 분포 (opus/sonnet/**fable-5**) | | |
| **fable-5 워커 용도** (설계 자문 / 적대 리뷰 / 미사용) | | |
| 계약 토너먼트 사용 여부 (독립 초안 N) | | |
| 재dispatch(수정) 사이클 수 | | |
| ultrathink: true 디스패치 수 | | |
| 총 토큰 (in/out) / 비용 | | |
| 벽시계 시간 (Phase 1 / Phase 2) | | |

## 이번 런에서 확인하려는 가설

1. **도메인 전이**: 보정 프롬프트(빈-값 의미론, premortem 추적성, dismissal 절차)가 API가 아닌
   CLI/동시성 도메인에서도 작동하는가 — 아니면 1차 도메인에 과적합이었나.
2. **계약 개정 능력**: Phase 2에서 파괴적 변경(C3)을 문서·테스트·자체 도구까지 일관 반영하고
   Phase 1 전체 재검증을 남기는가. (그린필드에서는 측정 불가능했던 축)
3. **에스컬레이션 래더 실사용**: opus 오케스트레이터가 정책대로 fable-5 워커를 설계 자문과
   적대 리뷰에 실제로 쓰는가 — 3차 런까지 미확인이었던 레버. 안 쓴다면 그것 자체가
   정책 프롬프트의 다음 수정 대상이다.
