# Claude Code Orchestrator

[English](README.md) | **한국어** | [简体中文](README.zh-CN.md)

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/toragonite.claude-code-orchestrator.svg?label=VS%20Marketplace&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs-short/toragonite.claude-code-orchestrator.svg?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Open VSX](https://img.shields.io/open-vsx/v/toragonite/claude-code-orchestrator?label=Open%20VSX&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/toragonite/claude-code-orchestrator?label=downloads&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![GitHub release](https://img.shields.io/github/v/release/Toragonite/claude-code-orchestrator?label=release&logo=github)](https://github.com/Toragonite/claude-code-orchestrator/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/Toragonite/claude-code-orchestrator)](https://github.com/Toragonite/claude-code-orchestrator)
[![License: MIT](https://img.shields.io/github/license/Toragonite/claude-code-orchestrator?color=brightgreen)](LICENSE)

![Claude Code Orchestrator — Claude Code를 위한 멀티 계정 병렬 디스패치](media/screenshots/banner.png)

> 비공식(unofficial) 확장입니다 — Anthropic과 무관하며 Anthropic의 보증을 받지 않았습니다. 구 이름: *Fable Orchestrator*.

기존 **Claude Code** 패널을 멀티 계정 오케스트레이터로 확장합니다. 평소처럼 메인 세션과 대화하면, 메인은 설계와 검증을 맡고 구현 작업을 MCP 디스패치 도구로 **워커 Claude 계정들**(Opus / Sonnet — 그리고 과금 가드 뒤의 Fable)에 **병렬** 분배합니다. 계정별 사용량 추적(각 계정의 실시간 실제 플랜 사용량과 리셋 시각 포함), 쿼터 인지 자동 분산, 라이브 대시보드가 포함됩니다.

> **새 기능 — 메시 모드 재설계: attach 가능한, worktree로 격리된 디스패치 (실험적)**
> 메시 모드는 더 이상 자기만의 도구를 가진 별도 워크플로가 아닙니다. 켜면 디스패치된 모든 워커가 터미널로 attach할 수 있는 상시 `claude --bg` 세션이 되어 **자기 전용 git worktree** 안에서 작업합니다 — 즉 결과가 머지할 브랜치의 형태로 돌아옵니다 — 그리고 오케스트레이터는 작업 중인 워커에게 메시지를 보내 방향을 잡아줄 수 있고, 워커는 진행 상황을 보고합니다.
> 기본적으로 꺼져 있으며, 꺼져 있을 때 디스패치 동작은 이전과 동일합니다. Claude Code CLI 2.1.224 이상, macOS 또는 Linux 필요. → [메시 모드](#메시-모드-실험적)

```
Claude Code 패널 (메인 계정 — 오케스트레이터)          ← 평소처럼 사용
   │  MCP 도구: dispatch_tasks / dispatch_task / list_workers / orchestrator_briefing
   ▼
cco-dispatch MCP 서버 (워크스페이스 .mcp.json에 등록)
   │  CLAUDE_CONFIG_DIR=<워커 dir> 로 Claude Code CLI 실행 (같은 워크스페이스)
   ├──────────────┬──────────────┐
   ▼              ▼              ▼
워커 w1          워커 w2         워커 w3
(opus-4-8)      (sonnet-5)     (opus-4-8)
```

핵심 아이디어: **계정 = Claude Code config 디렉토리.** 워커마다 `~/.claude-<이름>` 디렉토리를 만들고 그 계정으로 한 번만 로그인해두면 저장된 로그인이 계속 재사용됩니다. 이 익스텐션은 토큰이나 자격 증명을 직접 다루지 않습니다 — 로그인/갱신은 전부 Claude Code가 처리합니다.

## 스크린샷

*세션 시작: 오케스트레이터가 `orchestrator_briefing`으로 체크인한 뒤, `list_workers`에서 각 계정의 라이브 플랜 사용량을 읽어 한도에 가까운 계정을 피해 갑니다:*

![오케스트레이터 세션: briefing과 list_workers의 라이브 플랜 사용량](media/screenshots/panel-1.png)

*병렬 팬아웃: 오케스트레이터가 인터페이스 계약을 확정한 뒤, 정상 상태인 워커 계정들에 독립적인 서브태스크를 한 번의 배치로 디스패치하는 모습:*

![dispatch_tasks를 통한 워커 계정으로의 병렬 팬아웃](media/screenshots/panel-2.png)

*각 계정의 라이브 플랜 쿼터(Session 5시간 · Weekly 7일 · Weekly Fable, 각각 리셋 시각 포함)를 이 익스텐션 자체의 디스패치 카운터와 분리해서 보여주는 워커 계정과 라이브 태스크 피드:*

![Worker Accounts와 Dispatched Tasks 뷰](media/screenshots/sidebar.png)

*대시보드: 통계 타일, 활동 차트, 라이브 플랜 사용량 패널(계정별 막대와 리셋 카운트다운), 워커별 사용량, frontier 과금 가드를 포함한 설정:*

![오케스트레이터 대시보드](media/screenshots/dashboard.png)

## 요구 사항

- VS Code 1.90+
- [Claude Code](https://claude.com/claude-code) CLI 설치 및 로그인 (메인 계정)
- 워커로 쓸 추가 Claude 계정 1개 이상 (배정할 모델을 실행할 수 있는 플랜)

## 설치

- **마켓플레이스**: “Claude Code Orchestrator” 검색.
- **소스에서**: `npm install && npm run compile` 후 F5 (Extension Development Host), 또는 `npm run package`로 생성된 `.vsix` 설치.

## 빠른 시작

1. 액티비티 바의 **Claude Code Orchestrator** 뷰 → **Add Worker Account**. 이름(예: `w1`)과 기본 모델을 고르면 터미널이 열립니다 — 그 슬롯에 쓸 Claude 계정으로 **1회 로그인**하세요. 이미 `~/.claude-*` 디렉토리가 있다면 **Import Existing Claude Config Directories**로 일괄 등록.
2. **Register Dispatch MCP Server in This Workspace** 실행 — 워크스페이스 `.mcp.json`에 `cco-dispatch` 항목을 씁니다 (서버 파일은 `~/.claude-code-orchestrator/mcp/` 아래 고정 경로에 있어 익스텐션 업데이트로 등록이 깨지지 않습니다).
3. 워크스페이스 `CLAUDE.md`에 **디스패치 정책** 추가 제안을 수락하세요 (나중에 **Add Dispatch Policy to CLAUDE.md**로도 가능).
4. Claude Code 세션을 재시작하고 프로젝트 MCP 서버를 승인.
5. 평소처럼 대화하세요. 큰 작업을 주면 메인이 알아서 분배합니다: 독립적인 서브태스크는 워커들에게 병렬로 나가고, 메인은 설계·통합·검증에 집중합니다.

## MCP 도구

| 도구 | 용도 |
|---|---|
| `dispatch_tasks` | **배치 디스패치 (권장).** 독립 태스크 N개를 한 번에 넘기면 서버가 워커 계정들에 걸쳐 진짜 병렬로 실행하고 결과를 모아 반환합니다. |
| `dispatch_task` | 자기완결적 태스크 하나를 워커 하나에 실행 (같은 워크스페이스에서 파일·셸 접근이 가능한 헤드리스 Claude Code 세션). |
| `orchestrator_briefing` | CLAUDE.md 정책에 따라 메인 모델이 세션당 1회, 자기 모델 ID로 호출합니다. 워크스페이스별 오케스트레이터 모델을 기록하고 티어에 맞는 운영 브리핑을 반환합니다 — 아래 *모델 보정* 참고. |
| `list_workers` | 워커별 기본 모델, 누적 사용량(태스크·토큰·비용), 라이브 플랜 사용량(Session/Weekly/Weekly Fable %, 리셋 시각 포함), 각 계정의 초과 과금(overage billing) 상태(꺼짐, 또는 켜짐 + 월 한도 대비 현재 지출), 가용성/쿨다운, frontier 디스패치 가드 상태. |

알아둘 만한 디스패치 파라미터:

- **`system_prompt`** — 오케스트레이터가 워커마다 태스크 맞춤 시스템 프롬프트(역할, 품질 기준, 출력 형식)를 내려보낼 수 있습니다. 내장 워커 기본 프롬프트 위에 겹쳐지며, 복잡한 작업 품질에 큰 차이를 만듭니다.
- **`ultrathink: true`** — 해당 워커 실행의 추론 깊이를 기계적으로 최대로 올립니다. 계약이 걸린 구현, 미묘한 디버깅, 적대적 리뷰용.
- **`model`** — 어려운 추론/코딩은 `claude-opus-4-8`, 단순·대량 작업은 `claude-sonnet-5`, `claude-fable-5`는 최고 레버리지 디스패치(설계 자문, 적대적 리뷰)에만 — 그리고 frontier 디스패치를 열어둔 경우에만 (아래 *과금 가드* 참고).
- **`worker`** — 계정 명시 지정(선택). 생략하면 쿼터 인지 자동 배정.
- **`timeout_minutes`** — 해당 태스크에만 적용되는 벽시계 제한 시간(분, 1–480)을 선택적으로 지정합니다. 그 한 번의 디스패치에 한해 `workerTimeoutMinutes` 설정을 덮어씁니다.

## 오케스트레이션 품질 스택

익스텐션에 세 겹의 프롬프트 레이어가 내장되어 있습니다 (모델에게 전달되는 텍스트는 전부 영어이며 특정 모델명을 언급하지 않습니다):

1. **워커 기본 프롬프트** — 모든 디스패치 세션에 자동 주입: 계약 준수(바인딩 인터페이스, 파일 소유 범위), 완주하는 자율성, 스코프 절제, 근거 감사를 거친 보고.
2. **디스패치 정책** (`CLAUDE.md` 블록, 마커 주석 사이에 멱등 업서트) — *메인* 세션의 상시 지침. 핵심은 **오케스트레이터는 구현하지 않는다** — 설계·분해·디스패치·통합·검증만 직접 하고, 프로덕션 코드·테스트·문서는 전부 워커가 작성합니다. 배치 병렬성, 검증 루프, unknown unknowns 사냥, frontier 에스컬레이션 래더, 보고 언어 규칙 포함.
3. **모델 보정** (`orchestrator_briefing` 응답) — 프론티어 티어 오케스트레이터에는 짧은 확인만 주고 최대한의 자유를 보장합니다. 그 외 티어에는 긴 멀티 에이전트 작업에서 같은 운영 수준을 유지하게 하는 보정 지침이 붙습니다 (위임 강제, 외부화된 계획, 프로브로 추적되는 premortem, dismissal 절차가 있는 적대적 리뷰, 문서 정합 게이트, 근거 기반 주장).

이 스택은 벤치마크로 튜닝되었습니다: 난이도를 올려가며 진행한 4회의 오케스트레이터 A/B 빌드(실행 기반 프로브로 블라인드 판정)에서 프론티어 오케스트레이터와 보정된 Opus 오케스트레이터의 점수 격차가 ~11.5점에서 **기능 결함 양쪽 0인 3점**까지 좁혀졌습니다. [docs/benchmarks.ko.md](docs/benchmarks.ko.md) 참고.

## 쿼터 인지 스케줄링과 자동 분산

- 워커별 누적 사용량(태스크·토큰·비용)을 CLI 결과에서 파싱해 로컬에 기록합니다.
- quota/rate-limit 에러가 나면 그 워커는 설정 가능한 **쿨다운**에 들어가고, 태스크는 다른 워커로 **자동 페일오버**됩니다. 워커가 하나뿐이면 페일오버 대상이 없으므로 명확한 에러를 반환합니다.
- **★ Preferred 워커** — 메인과 같은 계정의 워커를 지정하세요 (우클릭 → *Toggle Preferred*). 가장 한가한 대안보다 바쁘지 않은 한 자동 배정에서 우선됩니다: 우선하되, 몰리지 않게.
- 백그라운드 워커는 권한 프롬프트에 답할 수 없어 기본 `--permission-mode acceptEdits`로 실행됩니다 (설정 가능; 셸 명령 실행이 필요한 태스크는 `bypassPermissions`가 필요합니다 — 보안 영향을 이해하고 켜세요).

## 초과 과금(overage billing) 표시

Anthropic의 레이트리밋 윈도우(Session 5시간, Weekly 7일, Weekly Fable)는 그 계정의 **초과 과금(overage billing)** 활성화 여부에 따라 한도에 도달했을 때 서로 다르게 동작합니다. 초과 과금이 **꺼져** 있으면 윈도우 한도에 도달한 순간 단순히 작업이 막히고 리셋을 기다리게 됩니다 — 위의 쿨다운·자동 페일오버가 그대로 처리하며, 플랜 이상으로 과금되는 일은 없습니다. 초과 과금이 **켜져** 있으면 윈도우 한도를 넘긴 작업이 그 계정의 월 한도(monthly cap)에 대해 과금되므로, 윈도우를 초과하는 디스패치는 실제 비용을 발생시키기 시작합니다.

익스텐션은 각 계정의 초과 과금 상태를 `list_workers`, Worker Accounts 트리, 대시보드 사용량 카드 전반에 걸쳐 표시하며, `claudeCodeOrchestrator.overageWorkerDispatch`로 디스패치를 보호합니다: 기본값인 **`block`**은 초과 과금이 켜져 있어도 쿼터가 소진된 워커에는 절대 작업을 배정하지 않으므로(디스패치가 플랜 윈도우를 넘겨 과금되는 일이 없음), **`allow`**는 이를 최후 수단으로 허용하며 그 디스패치는 실제 비용을 발생시킵니다. (아래의 `claude-fable-5` 전용 frontier 가드는 이와 별개이며 변경되지 않았습니다.)

## Frontier 과금 가드

`claude-fable-5`는 플랜에 따라 구독 쿼터가 아니라 **사용량 과금**될 수 있습니다. 디스패치는 자율적으로 일어나므로(정책이 처방한 설계 자문이 사용자가 안 보는 사이 나갈 수 있음), 가드는 프롬프트가 아니라 **디스패치 서버에서 강제**됩니다:

- 기본값: **block** — frontier 디스패치를 거부하고, 오케스트레이터를 `claude-opus-4-8` + `ultrathink`로 유도하는 안내 에러를 반환합니다 (재시도·페일오버 없음).
- `list_workers`와 도구 스키마가 디스패치 시도 전에 가드 상태를 보여줍니다.
- 의도적으로 열 때만: `claudeCodeOrchestrator.frontierWorkerDispatch` 설정 또는 대시보드의 드롭다운. 잘 작동하는 외과적 패턴: 열고 → 중요한 빌드의 적대적 리뷰 1건 디스패치 → 닫기.

## 메시 모드 (실험적)

메시 모드는 "또 하나의 작업 방식"이 아닙니다. **디스패치가 무엇인지 자체를** 바꿉니다: 켜면 디스패치된 모든 워커가 일회성 실행 대신 attach 가능한 상시 `claude --bg` 백그라운드 세션으로 돌아가며, git 워크스페이스에서는 자기 전용 git worktree 안에서 작업합니다. `dispatch_task` / `dispatch_tasks`는 그대로 쓰면 되고, 결과·타임아웃·취소·쿼터 인지 페일오버도 전과 같습니다. 따로 배워야 할 메시 워크플로는 없습니다.

무엇이 좋아지는가: 실행 중인 워커에 터미널로 attach해 지켜볼 수 있고, 오케스트레이터가 작업 도중 메시지를 보내 방향을 잡아줄 수 있으며, 워커는 일하는 동안 진행 상황과 질문을 보내옵니다.

메시 모드가 **꺼져 있으면** 디스패치는 이전 릴리스와 완전히 동일합니다 — 태스크당 일회성 워커 하나, 바뀌지 않은 코드 경로.

### 결과는 머지할 브랜치의 형태로 돌아옵니다

사용자에게 가장 크게 보이는 변화입니다. git 워크스페이스에서는 디스패치마다 자기 worktree(`.claude/worktrees/cco-<taskId>`)를 받고, `worktree-cco-<taskId>` 브랜치가 체크아웃됩니다(Claude Code 자체의 `-w` worktree 기능). 워커는 공유 체크아웃이 아니라 **그 worktree 안에서** 파일을 수정하며, 디스패치 결과에 worktree 경로와 브랜치가 함께 적힙니다. 오케스트레이터는 그 worktree에서 검증(diff, 빌드, 테스트)하고, 통과한 것을 머지한 뒤, worktree를 제거하고 워커를 중지하도록 지시받습니다 — 브랜치가 머지되기 전까지 그 디스패치는 통합된 것이 아닙니다.

worktree가 **없는** 경우는 두 가지이며, 이때 결과에는 worktree 줄이 아예 없습니다. 수정 내용이 이미 작업 트리에 들어와 있다는 뜻입니다:

- 워크스페이스가 git 저장소가 아닐 때,
- 디스패치가 일회성 워커로 폴백했을 때(아래 *메시를 시작할 수 없을 때* 참고).

머지되지 않은 작업이 임의로 정리되는 일은 없습니다: 워커를 중지하면 Claude Code에 worktree 제거를 요청하지만, Claude Code는 **깨끗한(clean)** worktree만 제거합니다. 커밋되지 않은 변경이 있는 worktree는 보존되고, `mesh_status`가 "보존됨" 표시와 함께 계속 목록에 보여주므로 잃어버릴 일이 없습니다.

### 실행 중인 워커와 대화하기

| 도구 | 용도 |
|---|---|
| `mesh_status` | 핵심 화면: 릴레이 상태, 아직 읽지 않은 라이브 피드 메시지와 대기 중인 워커 질문 수, 상한 대비 살아 있는 워커 수, 유휴 자동 중지 시간, 그리고 워커별로 담당 디스패치 태스크·계정·모델·생존 여부·유휴 시간·keep-alive 표시·worktree(커밋되지 않은 변경 때문에 보존된 경우 표시)·복사해 쓸 수 있는 attach 명령을 보고합니다. |
| `mesh_send_worker` | 이 워크스페이스에서 실행 중인 워커 **하나**에 실시간 메시지를 보냅니다: 정정 사항, 새로 발견한 제약, 워커 질문에 대한 답, 잘못된 방향을 그만두라는 지시 등. |
| `mesh_receive` | 이 워크스페이스 워커들이 보내는 라이브 피드를 롱폴링합니다 — 진행 상황 노트와 `STATUS <id> QUESTION: …` 질문(강조 표시됨). 결과 완료 핑은 내부에서 소비되며 여기에는 나타나지 않습니다. |
| `mesh_stop_worker` | 워커 하나를 중지합니다(해당 계정에서 `claude stop` 후, 백그라운드 작업을 정리하고 깨끗한 worktree를 제거하는 `claude rm`). |
| `mesh_keep_worker` | 유휴 자동 중지가 건드리지 않도록 워커에 keep-alive 표시를 합니다 — attach 명령을 사용자에게 알려주기 전에 먼저 설정하세요. 세션 종료 시의 정리는 이 표시와 무관하게 적용됩니다. |

v1.4의 도구들은 사라졌습니다. `mesh_spawn_workers`는 더 이상 없고(이제 디스패치가 워커를 띄웁니다), 임의의 피어 세션까지 지정할 수 있던 `mesh_send`도 없습니다. `mesh_receive`는 이름만 남았고 의미는 달라졌습니다: 범용 피어 수신함이 아니라 *이 워크스페이스의 디스패치 워커들*이 보내는 라이브 피드입니다. 워커 간(peer-to-peer) 메시징은 폐기되었습니다 — `mesh_send_worker`는 이 워크스페이스의 살아 있는 워커가 아닌 이름을 거부합니다.

메시지는 큐에 쌓였다가 워커의 다음 턴 경계에서 전달되므로, 진행 중인 도구 호출을 중간에 끊지 않습니다. 스티어링 메시지는 태스크를 수정할 수 있고 원래 태스크 내용과 충돌하면 더 나중 지시가 우선하지만, 워커의 파일 소유 목록을 넓힐 수는 없으며, 워커가 받은 메시지 내용은 언제나 지시가 아니라 데이터로 취급됩니다.

### 두 개의 채널: 결과는 파일이, 스티어링은 메시지가 나릅니다

워커의 보고서는 디스패치 서버가 읽는 **결과 파일**로 전달되고, 실시간 메시지 채널은 짧은 완료 핑·진행 노트·스티어링만 나릅니다. 이 분리는 의도된 것입니다 — 릴레이가 죽으면 스티어링과 진행 노트는 잃어도 결과는 잃지 않습니다. 대기 중인 디스패치는 여전히 결과 파일로 완료되며, `mesh_status`도 그렇게 알려줍니다("ping/STATUS channel lost; results still collected via files"). 진행 노트는 설계상 best-effort입니다: 워커는 보내도록 지시받지만, 어떤 동작도 그 도착에 의존하지 않습니다.

### 정리(teardown) — 살아 있는 워커는 점유된 자원입니다

워커는 디스패치가 반환돼도 **사라지지 않습니다**. 그것이 attach 가능성의 핵심이고, 그래서 누군가는 워커를 중지해야 합니다. 오케스트레이터는 작업이 머지되는 대로 각 워커를 중지하도록 지시받으며, 그 아래에 세 가지 백스톱이 있습니다:

- **유휴 자동 중지** — `claudeCodeOrchestrator.meshWorkerIdleTimeoutMin` (기본값 `15`, `0`이면 비활성화). 진행 중인 디스패치도, 메시지도, keep-alive 표시도 없는 살아 있는 워커는 그만큼의 분이 지나면 중지됩니다. **Attachable workers** 트리에서 attach하면 먼저 keep-alive 표시가 되므로 사용자가 들어가 있는 세션은 회수되지 않으며(표시를 기록하지 못하면 경고가 뜹니다), 오케스트레이터 쪽에서는 `mesh_keep_worker`가 같은 일을 합니다.
- **동시 워커 상한** — `claudeCodeOrchestrator.meshMaxLiveWorkers` (기본값 `8`). 상한을 넘는 디스패치는 **큐에 쌓이지 않고 거부됩니다**: 해당 태스크가 상한을 명시한 `worker_cap` 오류로 실패하므로, 아무도 비워주지 않는 슬롯을 기다리며 배치가 교착되는 일이 없습니다. 대규모 팬아웃 전에 끝난 워커를 중지하거나 값을 올리세요.
- **세션 종료** — 디스패치 서버가 종료될 때 자신이 소유한 모든 워커를 중지하며(keep-alive 표시가 있어도 포함), 다음 활성화 시에는 강제 종료된 세션이 남긴 고아 워커를 훑어 아직 살아 있는 것을 중지합니다.

워커를 중지할 때 백그라운드 작업도 함께 정리되며(깨끗한 worktree는 이때 제거됩니다), 그 때문에 타임아웃에 걸린 디스패치는 타임아웃 시각보다 최대 30초쯤 늦게 보고될 수 있습니다(중지와 작업 제거가 각각 15초로 제한됩니다).

### 활성화 방법

메시 모드는 기본적으로 꺼져 있습니다. 아래 다섯 설정은 오케스트레이터 대시보드의 Settings 카드에도 있으며, 변경은 해당 워크스페이스의 다음 Claude Code 세션부터 적용됩니다.

| 설정 | 기본값 | 효과 |
|---|---|---|
| `claudeCodeOrchestrator.meshMode` | `false` | 마스터 스위치: 릴레이 세션을 시작하고, detach가 아닌 모든 디스패치를 attach 가능한 워커로 보냅니다 |
| `claudeCodeOrchestrator.meshGatewayModel` | `haiku` | 릴레이 세션의 모델. 아주 작은 중계 턴만 수행합니다 |
| `claudeCodeOrchestrator.meshWorkerIdleTimeoutMin` | `15` | 유휴 상태의 attach 가능 워커를 중지하기까지의 분. `0`이면 비활성화 |
| `claudeCodeOrchestrator.meshMaxLiveWorkers` | `8` | 동시에 살아 있을 수 있는 attach 가능 워커 수. 초과 디스패치는 큐잉이 아니라 거부 |
| `claudeCodeOrchestrator.meshHistoryLimit` | `50` | Worker History 뷰가 유지하는 중지된 워커 기록 수. 초과 시 오래된 것부터 삭제 (최소 `1`, 최대 `1000`) |

`meshCrossAccountBridge` 설정은 사라졌습니다. 그 설정이 제어하던 계정 간 미러링은 여전히 동작하며(한 계정의 워커가 다른 계정의 릴레이에 도달하게 해주는 장치입니다), 이제는 사용자가 켜고 끄는 기능이 아니라 메시와 함께 시작되는 내부 배관입니다. `mesh_status`는 이를 한 줄로 보고합니다.

### 메시를 시작할 수 없을 때

지원되지 않는 플랫폼, 다른 창이 이미 이 워크스페이스의 메시를 점유 중, 릴레이 기동 실패 등 어떤 이유로든 메시를 초기화할 수 없으면 디스패치는 **실패하지 않습니다**. 평범한 일회성 워커로 실행되고, 결과 앞에 다음이 붙습니다:

```
⚠ mesh unavailable — ran as a one-shot worker (not attachable): <이유>
```

`mesh_status`는 초기화 오류를 계속 보고하며, 이런 디스패치에는 worktree가 없습니다 — 수정 내용은 작업 트리에 바로 반영됩니다.

### 요구 사항과 솔직한 한계

- **Claude Code CLI 2.1.224 이상** (크로스 세션 메시징이 이 버전부터 기본 활성화). 여기 적힌 worktree 동작은 2.1.227에서 검증했습니다.
- **macOS 또는 Linux, 같은 머신.** 메시는 유닉스 도메인 소켓 위에서 동작하므로 Windows에서는 아예 시작되지 않고, 모든 디스패치가 위의 일회성 폴백으로 처리됩니다.
- **attach 가능한 워커는 파일을 쓰는 역할이지 빌드를 돌리지 않습니다.** Bash 도구 없이 생성되며(Claude Code가 명백히 안전한 읽기 전용 명령을 자동 승인할 수는 있으므로, 샌드박스가 아니라 "파일 작성자"로 취급하세요), 워크스페이스의 MCP 서버는 이들에게 비활성화되어 있어 워커가 또 다른 워커를 디스패치할 수 없습니다. 빌드·테스트·셸 작업은 오케스트레이터의 몫입니다.
- **`detach: true`는 여전히 일회성입니다.** detach 태스크는 세션보다 오래 살아남으라고 있는 것이고 릴레이는 그렇지 않기 때문에, 메시 모드가 켜져 있어도 detach 디스패치는 기존 감독자 경로를 그대로 씁니다.
- **릴레이에는 약간의 비용이 듭니다.** 메시 모드가 켜져 있는 동안 서버는 메인 계정에서 작은 `claude -p` 릴레이 세션 하나를 유지합니다(`meshGatewayModel`, 기본 `haiku`). 짧은 메시지만 중계하지만 공짜는 아닙니다.
- **태스크별 토큰·비용 수치는 없습니다.** CLI가 `--bg` 세션의 사용량을 보고하지 않으므로, attach 가능한 디스패치는 이 익스텐션 자체 카운터와 차트에 0 토큰 / 0 비용으로 기록되고 태스크 출력에는 `tokens n/a`라고 적힙니다. 각 계정의 라이브 플랜 사용량은 영향받지 않습니다 — 그 값은 계정에서 직접 읽어옵니다.
- **worktree가 남을 수 있습니다.** 제거가 실행되기 전에 세션이 끝나면 깨끗한 `cco-…` worktree가 `.claude/worktrees/` 아래에 쌓일 수 있으며, `git worktree remove`로 안전하게 지울 수 있습니다. 또 워커가 막 작업을 마친 직후에는 실제로 깨끗한 worktree가 이따금 *보존됨*으로 보고되기도 합니다 — 잃어버리는 것은 없고, 몇 초 뒤에 다시 제거하면 성공합니다.
- **실패한 시도 뒤의 재시도는 같은 태스크 worktree를 다시 씁니다.** 따라서 한 브랜치에 두 번의 시도가 함께 담길 수 있으니, 머지하기 전에 diff 전체를 확인하세요.
- **공개 API가 없는 Claude Code 내부 동작에 기대고 있습니다**(세션 레지스트리와 백그라운드 작업 명령). 그 내부가 바뀌면 메시 초기화가 실패하고 디스패치는 일회성 워커로 폴백합니다. 디스패치 도중에 바뀌면 잘못된 결과가 아니라 타임아웃이나 워커 사망 오류로 드러납니다.

### 알려진 업스트림 한계

- **IDE 패널 세션은 메시에 직접 참여할 수 없습니다** — 메시징 소켓 없이 등록되므로 아무것도 받을 수 없고, 자신이 보낸 메시지도 조용히 전달에 실패합니다. 메시 모드가 오케스트레이터의 메시 아이덴티티로 별도의 백그라운드 릴레이 세션을 띄우는 이유가 바로 이것입니다. 업스트림 이슈: [anthropics/claude-code#82313](https://github.com/anthropics/claude-code/issues/82313).
- **VS Code 익스텐션은 `CLAUDE_CONFIG_DIR` 오버라이드를 무시**하고 항상 `~/.claude`로 귀결됩니다 — 계정 간 도달성이 익스텐션 호스트가 다른 계정을 직접 보는 대신 레지스트리 파일 미러링으로 구현된 이유 중 하나입니다. 업스트림 이슈: [anthropics/claude-code#30538](https://github.com/anthropics/claude-code/issues/30538).

이 기능이 딛고 선 메시징 메커니즘 검증(프로브 P1–P11)은 [docs/session-messaging-spike.md](docs/session-messaging-spike.md)에서 볼 수 있습니다. 그 문서의 도구 목록은 이번 재설계 이전 것입니다.

## 뷰와 대시보드

- **Worker Accounts** — 워커를 펼치면 상태(가용/쿨다운), 라이브 플랜 사용량(Session 5h·Weekly 7d·Weekly Fable 사용률, 각각 리셋 시각 포함, Claude Code의 `get_usage`로 조회), 이 익스텐션 자체의 세션(5h)·주간(7d) 디스패치 사용량, 전체 누적, 에러가 표시됩니다. 플랜 사용량은 워커뿐 아니라 메인 계정도 포함하며, 활성화 시점과 5분마다 자동 갱신됩니다(또는 **Refresh Account Usage**로 즉시 갱신). 디스패치 사용량 수치는 별개이며 이 익스텐션이 보낸 태스크만 반영할 뿐 계정의 전체 소비량이 아닙니다. `claude setup-token` 등 구독이 아닌 방식으로 로그인한 계정은 연결된 플랜이 없어 "no plan limits"로 표시됩니다. **Rename Worker Account**(컨텍스트 메뉴)는 워커의 라벨만 바꿉니다 — config 디렉토리와 로그인은 그대로 유지되며, 디스패치가 실행 중일 때는 거부됩니다. 업스트림 사용량 소스가 잠시 아무 값도 반환하지 않으면, 이전에 받은 값을 최대 30분간 stale(오래됨) 표시와 함께(경과 시간 포함) 그대로 유지합니다.
- **Dispatched Tasks** — 라이브 태스크 피드. 기본은 현재 워크스페이스 스코프(전체 워크스페이스로 전환 가능). 태스크를 클릭하면 프롬프트/결과 마크다운이 열립니다. 실행 중인 행에는 인라인 **Cancel Dispatched Task** 버튼이, 뷰 타이틀에는 확인을 먼저 묻는 **Cancel All Running Dispatches** 버튼이 있습니다.
- **오케스트레이터 대시보드** (에디터 탭) — 통계 타일(실행 중, 7일 태스크, 성공률, 토큰, 비용), 라이브 사용량 패널(윈도우별 막대에 %, 심각도 색상, 리셋 카운트다운, "N분 전 업데이트" 최신성 표시), 14일 태스크 차트, 워커별 토큰 분포, 워커·태스크 테이블, 빠른 액션이 있는 설정 패널. 2초마다 자동 갱신, 테마 자동 대응. 실행 중인 행에는 Cancel 버튼이 있고, 모든 실행 중인 디스패치 취소도 빠른 액션으로 제공됩니다.
- **Open Interactive Worker Session** — 워커를 통합 터미널의 보이는 세션으로 실행합니다(초기 태스크 주입 가능). 지켜보며 개입하고 싶을 때.

디스패치를 멈추면 실제로 멈춥니다: Stop을 누르면 해당 MCP 요청이 취소되고 그 워커의 프로세스 트리 전체가 종료됩니다(`dispatch_tasks`로 보낸 배치는 하나의 요청이므로, 취소하면 배치 안의 모든 태스크가 함께 멈춥니다). 메시 모드가 켜져 있으면 프로세스 트리에 신호를 보내는 대신 워커의 백그라운드 세션을 중지하며, 그때까지 워커가 써 둔 내용은 디스크에 그대로 남습니다. 오케스트레이터 세션이 끝나면 — 패널을 닫거나, 창을 새로고침하거나, VS Code를 종료하거나, 프로세스를 강제 종료하면 — 그 세션이 띄운 모든 워커를 `workerTimeoutMinutes` 시간까지 방치하지 않고 종료시킵니다. 익스텐션은 여전히 자신의 워커임이 확인된 프로세스 ID에만 신호를 보내며(OS가 재사용한 ID에는 절대 보내지 않음), 취소는 워커 에러나 쿼터 쿨다운으로 집계되지 않고, 워커가 죽었는데도 실행 중으로 표시된 태스크는 다음 활성화 때 오펀(orphaned)으로 회수됩니다.

## 에셋 팩과 Asset Manager

**에셋 팩**은 `.claude/` 레이아웃 — `skills/`, `agents/`, `commands/`, `output-styles/`, `hooks/` — 을 그대로 미러링하는 일반 디렉토리입니다. `pack.json`은 선택 사항입니다. 두 종류가 있습니다: 익스텐션에 내장된 **번들 팩**, 그리고 `claudeCodeOrchestrator.assetPacks` 설정에 등록한 **사용자 팩**(예: 프라이빗 레포 클론)입니다.

에셋은 워크스페이스별로 개별 활성화합니다. 활성화하면 해당 워크스페이스의 `.claude/` 디렉토리에 설치되고, 그 선택은 `.claude/cco-assets.json`에 기록됩니다 — sync가 무엇을 직접 썼는지 추적하는 소유권 원장입니다.

**Sync**는 활성화된 에셋을 설치하고 최신 상태로 유지하지만, 직접 손으로 수정한 파일은 절대 덮어쓰지 않습니다 — 대신 "customized"로 표시됩니다. 에셋을 비활성화하면 sync가 직접 쓴 파일만 제거되고, 커스터마이즈된 파일은 그대로 남습니다. **Reset**은 파일 하나 또는 에셋 전체를 팩 버전으로 강제 덮어쓰는 명시적 탈출구입니다.

이 모든 것을 관리하는 곳이 **에셋 매니저 패널**(**Open Asset Manager**)입니다: 팩 디렉토리 추가/제거, 워크스페이스별 에셋 토글, 그리고 각 에셋의 상태 배지 확인:

| 배지 | 의미 |
|---|---|
| synced | 설치됨, 팩과 일치 |
| update available | 팩이 설치본보다 앞서 있음 |
| customized | 설치된 파일을 직접 수정함 — sync가 건드리지 않음 |
| conflict | 활성화된 에셋 두 개가 같은 설치 경로를 요구함 |
| not installed | 활성화됐지만 아직 sync되지 않음 |

패널에서 동기화가 어긋난 파일을 diff하거나 reset할 수 있고, orphan이 된 설치를 정리하며, **New asset…**로 새 스킬·에이전트·커맨드·output style·hook을 스캐폴딩할 수 있습니다(쓰기 가능한 팩에 생성됩니다 — 번들 팩은 여기서 읽기 전용입니다).

**Hook은 스크립트이지 마크다운이 아닙니다.** `hook` 에셋을 설치하면 스크립트 파일이 디스크에 쓰이지만 자동으로 등록되지는 않습니다 — `.claude/settings.json`의 `hooks` 블록에 직접 추가해야 하며, 스캐폴드의 주석이 정확한 항목 형식을 보여줍니다.

**프라이버시:** 익스텐션 자체의 번들 `assets/`에 넣은 것은 익스텐션이 게시되는 순간 공개됩니다. 개인적이거나 팀 전용인 에셋은 별도 팩 디렉토리에 두고 `assetPacks`로 등록하세요.

언제든 **Sync Assets**로 팩 업데이트를 가져올 수 있습니다. `claudeCodeOrchestrator.assetAutoSync`(기본 켜짐)는 활성화 시 조용히 이를 수행하고, 실제로 뭔가 바뀌었을 때만 알림을 띄웁니다.

## 커맨드

| 커맨드 | 설명 |
|---|---|
| Add Worker Account | 워커 생성 (config dir + 1회 로그인 터미널) |
| Import Existing Claude Config Directories | `~/.claude*` 스캔 후 일괄 등록 |
| Register Dispatch MCP Server in This Workspace | `.mcp.json`에 cco-dispatch 등록 |
| Add Dispatch Policy to CLAUDE.md | 정책 블록 주입/갱신 |
| Open Worker Session in Terminal | 인터랙티브 워커 세션 (항목의 인라인 버튼) |
| Re-login Worker Account | 워커 재로그인 (컨텍스트 메뉴) |
| Toggle Preferred Worker | 자동 배정에서 이 워커 우선 (컨텍스트 메뉴) |
| Rename Worker Account | 레지스트리·사용량 통계·태스크 로그에 걸쳐 워커 이름 변경; config 디렉토리와 로그인은 그대로 (컨텍스트 메뉴) |
| Refresh Account Usage | 모든 계정의 라이브 플랜 사용량 재조회 (Worker Accounts 뷰의 툴바 버튼) |
| Open Orchestrator Dashboard | 에디터 탭 대시보드 |
| Toggle Task Scope | Tasks 뷰: 현재 워크스페이스 ↔ 전체 |
| Cancel Dispatched Task | 실행 중인 디스패치의 워커 프로세스 종료 (Dispatched Tasks 뷰와 대시보드의 행 인라인 버튼) |
| Cancel All Running Dispatches | 실행 중인 모든 디스패치를 확인 후 종료 (Dispatched Tasks 뷰 타이틀 버튼; 대시보드의 빠른 액션) |
| Remove Worker Account / Clear Task History | 정리 |

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | `acceptEdits` | 백그라운드 워커의 `--permission-mode` (`default`는 편집 승인 대기로 멈춤) |
| `claudeCodeOrchestrator.claudePath` | `claude` | Claude Code CLI 경로 |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | `30` | 쿼터 에러 후 해당 워커 배정 제외 시간(분) |
| `claudeCodeOrchestrator.workerTimeoutMinutes` | `45` | 디스패치당 벽시계 제한 시간(분, 1–480); `timeout_minutes`로 디스패치별 재정의 가능 |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | `block` | frontier 워커 모델 과금 가드 (위 참고) |
| `claudeCodeOrchestrator.overageWorkerDispatch` | `block` | 초과 과금 디스패치 가드: `block`은 초과 과금이 켜져 있어도 쿼터가 소진된 워커에 절대 작업을 배정하지 않음; `allow`은 최후 수단으로 배정을 허용하고 실제 비용이 발생함 |
| `claudeCodeOrchestrator.sessionKeepalive` | `false` | OAuth 세션을 최신 상태로 유지하기 위해 구독 계정마다 24시간에 한 번 최소한의 `haiku` 요청을 전송 |
| `claudeCodeOrchestrator.assetPacks` | `[]` | 번들 팩 외에 에셋을 불러올 추가 에셋 팩 디렉토리 |
| `claudeCodeOrchestrator.assetAutoSync` | `true` | 활성화 시 활성화된 에셋을 조용히 동기화하고, 실제로 변경된 경우에만 알림 표시 |

메시 모드는 다섯 개의 설정(`meshMode`, `meshGatewayModel`, `meshWorkerIdleTimeoutMin`, `meshMaxLiveWorkers`, `meshHistoryLimit`)을 추가합니다 — [메시 모드](#메시-모드-실험적) 참고.

## 데이터와 프라이버시

모든 것이 로컬에 머뭅니다. 익스텐션과 서버는 `~/.claude-code-orchestrator/` 아래 상태를 공유합니다: 워커 레지스트리(이름, config dir 경로, 기본 모델 — **토큰·자격 증명 없음**), 워커별 사용량 통계, 태스크 로그, 태스크 결과 마크다운. 사용자가 디스패치한 Claude Code CLI 호출 외에는 아무것도 외부로 전송되지 않습니다. 익스텐션을 제거해도 이 디렉토리는 남습니다 — 완전히 지우려면 직접 삭제하세요.

## 트러블슈팅

- **MCP 서버가 “failed”로 표시** — 대개 GUI 프로세스의 Node.js 경로 문제입니다. *Register Dispatch MCP Server*를 다시 실행하세요; 익스텐션이 로그인 셸로 `node` 절대 경로를 찾아 `.mcp.json`에 기록합니다.
- **워커가 멈췄다가 타임아웃** — `workerPermissionMode`를 확인하세요; `default`는 아무도 누를 수 없는 권한 승인을 무한 대기합니다. 태스크는 `claudeCodeOrchestrator.workerTimeoutMinutes`(기본값 45, 범위 1–480) 후 타임아웃되며, 한 번의 디스패치에 한해 `timeout_minutes` 도구 인자로 재정의할 수 있습니다.
- **“Dispatch to claude-fable-5 is blocked”** — 과금 가드가 켜져 있습니다(기본값). 비용을 감수한다면 `frontierWorkerDispatch: allow`로 의도적으로 여세요.
- **모든 디스패치가 쿼터 에러** — `list_workers` / Worker Accounts 뷰에서 쿨다운을 확인하세요; 워커가 하나면 페일오버가 없습니다.

## 한계와 참고

- 워커들은 **같은 워크스페이스**의 파일을 동시에 수정합니다. 겹치는 작업에는 프롬프트에서 파일 소유 목록을 분리해 주세요. ([메시 모드](#메시-모드-실험적)가 켜져 있고 git 워크스페이스라면, 디스패치마다 자기 worktree로 격리되고 여러분은 브랜치를 머지하게 됩니다.)
- 메인 계정은 건드리지 않습니다 — 패널은 기본 `~/.claude` 로그인을 그대로 씁니다.
- 여러 Claude 계정 사용은 Anthropic 서비스 약관과 사용 정책의 적용을 받습니다. **계정 구성과 사용이 약관을 준수하는지 확인할 책임은 사용자에게 있습니다.** 디스패치된 작업은 각 워커 계정의 쿼터 또는 종량 과금을 소비합니다.

## 라이선스와 상표

[MIT](LICENSE) © 2026 Toragonite.

Claude, Claude Code, Anthropic은 Anthropic, PBC의 상표입니다. 이 프로젝트는 독립적인 커뮤니티 확장이며 Anthropic과 제휴·후원·보증 관계가 없습니다.
