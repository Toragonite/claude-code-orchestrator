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

> **v1.4의 새 기능 — 메시 모드 (실험적)**
> Claude Code 자체의 크로스 세션 메시징(CLI 2.1.224부터 기본 활성화) 위에 구축되어, 이번 릴리스는 이를 실시간 오케스트레이션 레이어로 노출합니다.
> 상시 실행되는 `claude --bg` 백그라운드 워커를 띄우고 그 워커와 실시간으로 양방향 대화를 나누세요(터미널 탭에서 아무 워커에나 attach해 지켜보거나 개입 가능) — 일회성 디스패치를 대체하지 않고 보완합니다.
> 기본적으로 꺼져 있습니다. Claude Code CLI 2.1.224 이상, macOS 또는 Linux 필요. → [메시 모드](#메시-모드-실험적)

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

메시 모드는 Claude Code 자체의 크로스 세션 메시징 위에, 오케스트레이터 세션과 상시 실행되는 백그라운드 워커 사이의 **실시간 양방향 협업 레이어**를 추가합니다. 일회성 디스패치를 대체하지 않고 보완합니다. 디스패치는 여전히 영속적이고 쿼터를 정밀하게 처리하는 경로입니다(구조화된 `result.json`, 타임아웃, 취소, 페일오버). 메시는 워커를 한 번 띄운 뒤 그 워커와 실시간으로 대화하고 싶을 때 — 메시지를 보내고, 상태 업데이트를 받고, 터미널 탭에서 작업을 지켜보고 싶을 때 — 를 위한 것이며, 워커는 대화 전체에 걸쳐 자신의 컨텍스트를 유지합니다.

### 동작 방식 — 게이트웨이 vs 브리지

두 가지 구성 요소가 있으며, 둘을 구분해서 이해하는 편이 좋습니다:

- **게이트웨이** — 서버가 *메시 위에서 자기 자신의 아이덴티티로* 띄우는 작은 `claude -p` 릴레이 세션입니다. 오케스트레이터는 메시에 직접 메시지를 보낼 수 없습니다: VS Code 패널 세션은 메시징 소켓 없이 등록되고(업스트림 [#82313](https://github.com/anthropics/claude-code/issues/82313)), MCP 서버는 애초에 Claude 세션이 아니기 때문입니다 — 그래서 게이트웨이가 이들을 대신해 메시지를 주고받습니다. 게이트웨이는 메시지를 중계만 하므로 저렴한 모델(기본값 haiku)로 실행됩니다.
- **브리지** — 계정 간에 세션 디스커버리를 미러링합니다. **같은** 계정의 워커들은 별도 설정 없이 서로를 찾지만, **다른** 계정의 워커에 도달하게 해주는 것이 바로 브리지입니다.

|  | 게이트웨이 | 브리지 |
|---|---|---|
| **이유** | 오케스트레이터(패널/서버)가 메시에 직접 참여할 수 없음 | 디스커버리가 `CLAUDE_CONFIG_DIR`별로 격리됨 |
| **필요 시점** | 메시 모드가 켜져 있으면 항상 (단일·멀티 계정 모두) | 멀티 계정에서만 |
| **설정** | `meshMode` | `meshCrossAccountBridge` |

(대신 오케스트레이터를 **터미널**의 Claude 세션으로 실행하면, 그 세션은 완전한 메시 참여자이므로 게이트웨이 없이도 워커에 메시지를 보낼 수 있습니다 — 게이트웨이는 이 익스텐션이 사용하는 패널/서버 진입점을 위해 존재합니다.)

### 요구 사항

- Claude Code CLI 2.1.224 이상 (크로스 세션 메시징은 이 버전부터 기본 활성화됩니다)
- macOS 또는 Linux 전용 — 메시는 유닉스 도메인 소켓 위에서 동작하므로 Windows에서는 지원되지 않습니다
- 오케스트레이터와 같은 머신 (메시 워커는 `claude --bg` 백그라운드 프로세스로 뜨며, 메시 메시징은 머신을 넘나들지 않습니다)

### 활성화 방법

메시 모드는 기본적으로 꺼져 있으며, 서로 독립적인 두 단계의 옵트인으로 구성됩니다 (둘 다 실험적):

- `claudeCodeOrchestrator.meshMode` (기본값 `off`) — 마스터 스위치입니다. 켜면 게이트웨이 릴레이 세션(아래 참고)이 시작되고 오케스트레이터에게 `mesh_*` MCP 도구가 노출됩니다.
- `claudeCodeOrchestrator.meshCrossAccountBridge` (기본값 `off`) — **실험적²**, 아래 경고 참고. `meshMode`가 켜져 있을 때만 의미가 있습니다.
- `claudeCodeOrchestrator.meshGatewayModel` (기본값 `haiku`) — 게이트웨이 릴레이 세션이 사용할 모델입니다. 게이트웨이는 사소한 메시지 중계 턴만 수행하므로 기본값은 의도적으로 저렴한 모델입니다.

### mesh_* 도구

| 도구 | 용도 |
|---|---|
| `mesh_status` | 게이트웨이 상태, 크로스 계정 브리지 상태, 그리고 모든 메시 워커(이름, 계정, 모델, 레지스트리상의 실시간 상태, attach 명령)를 보고합니다. 다른 `mesh_*` 도구를 쓰기 전에 먼저 호출하세요. |
| `mesh_spawn_workers` | 한 번의 호출로 상시 실행되는 `claude --bg` 메시 워커를 하나 이상 생성합니다. 각각 역할 슬러그와 완전한 상시 브리핑을 받습니다. 쿼터 인지 계정 배정은 디스패치의 가드(로그아웃, 쿨다운, 소진, 초과 과금, frontier)를 그대로 따릅니다. |
| `mesh_send` | 메시 워커(또는 도달 가능한 다른 피어 세션)에 실시간 메시지를 보냅니다. 워커 이름 또는 `uds:...` 회신 주소로 지정합니다. 실제 전달 상태를 반환합니다. |
| `mesh_receive` | 게이트웨이 수신함을 롱폴링해 메시 워커의 메시지를 가져옵니다. |
| `mesh_stop_worker` | 메시 워커를 중지합니다 (해당 계정에서 `claude stop <jobId>` 실행; `force: true`는 실패 시 프로세스 강제 종료로 대체). |

### 워커 생명주기

메시 워커는 다음 단계를 거칩니다: **생성** (`mesh_spawn_workers`가 상시 브리핑을 가진 `claude --bg` 백그라운드 세션을 시작 — 자신의 컨텍스트를 유지한 채 계속 살아 있음) → **메시징** (`mesh_send`/`mesh_receive`로 일회성 디스패치 프롬프트와 다른 실시간 대화를 주고받음) → **attach** (Worker Accounts 뷰에서 통합 터미널 탭으로 워커를 열거나, `mesh_status`가 반환하는 `attachCommand`를 실행해 직접 지켜보고 개입 — `Ctrl+Z`로 중지 없이 분리 가능; attach 없이 `claude logs <jobId>`로 가볍게 들여다볼 수도 있음) → **중지** (`mesh_stop_worker`, 또는 터미널에서 `claude stop`).

### 크로스 계정 브리지 (실험적²)

> ⚠️ **기본적으로 꺼져 있으며, 문서화되지 않은 Claude Code 파일 형식에 의존합니다.** 브리지는 등록된 모든 계정의 `CLAUDE_CONFIG_DIR`에 걸쳐 실시간 세션 레지스트리 항목을 미러링해, 메인 계정뿐 아니라 다른 워커 계정의 메시 워커도 도달 가능하게 만듭니다. 이는 Claude Code CLI의 경험적으로 관찰된, 공개되지 않은 동작(`docs/session-messaging-spike.md` 참고)에만 의존하며 — 공식 API는 없습니다. 앞으로 나올 Claude Code 릴리스가 이 형식을 예고 없이 바꿀 수 있습니다. 브리지는 그럴 때 디스패치를 망가뜨리는 대신 스스로 성능을 낮추도록(auto-degrade) 만들어졌지만, 크로스 계정 메시 워커가 꼭 필요한 경우가 아니라면 꺼두세요.

### 알려진 업스트림 한계

- **IDE 패널 세션은 메시에 직접 참여할 수 없습니다** — 메시징 소켓 없이 등록되므로 아무것도 받을 수 없고, 자신이 보낸 메시지도 조용히 전달에 실패합니다. 메시 모드가 오케스트레이터의 메시 아이덴티티로 별도의 백그라운드 릴레이("게이트웨이") 세션을 띄우는 이유가 바로 이것입니다. 업스트림 이슈: [anthropics/claude-code#82313](https://github.com/anthropics/claude-code/issues/82313).
- **VS Code 익스텐션은 `CLAUDE_CONFIG_DIR` 오버라이드를 무시**하고 항상 `~/.claude`로 귀결됩니다 — 위의 크로스 계정 브리지가 존재하는 이유 중 하나이며, 익스텐션 호스트가 다른 계정을 직접 보게 하는 대신 파일을 미러링하는 방식으로 동작하는 이유이기도 합니다. 업스트림 이슈: [anthropics/claude-code#30538](https://github.com/anthropics/claude-code/issues/30538).

이 섹션의 모든 주장을 뒷받침하는 전체 검증 근거(프로브 P1–P11)는 [docs/session-messaging-spike.md](docs/session-messaging-spike.md)에서 확인할 수 있습니다.

## 뷰와 대시보드

- **Worker Accounts** — 워커를 펼치면 상태(가용/쿨다운), 라이브 플랜 사용량(Session 5h·Weekly 7d·Weekly Fable 사용률, 각각 리셋 시각 포함, Claude Code의 `get_usage`로 조회), 이 익스텐션 자체의 세션(5h)·주간(7d) 디스패치 사용량, 전체 누적, 에러가 표시됩니다. 플랜 사용량은 워커뿐 아니라 메인 계정도 포함하며, 활성화 시점과 5분마다 자동 갱신됩니다(또는 **Refresh Account Usage**로 즉시 갱신). 디스패치 사용량 수치는 별개이며 이 익스텐션이 보낸 태스크만 반영할 뿐 계정의 전체 소비량이 아닙니다. `claude setup-token` 등 구독이 아닌 방식으로 로그인한 계정은 연결된 플랜이 없어 "no plan limits"로 표시됩니다. **Rename Worker Account**(컨텍스트 메뉴)는 워커의 라벨만 바꿉니다 — config 디렉토리와 로그인은 그대로 유지되며, 디스패치가 실행 중일 때는 거부됩니다. 업스트림 사용량 소스가 잠시 아무 값도 반환하지 않으면, 이전에 받은 값을 최대 30분간 stale(오래됨) 표시와 함께(경과 시간 포함) 그대로 유지합니다.
- **Dispatched Tasks** — 라이브 태스크 피드. 기본은 현재 워크스페이스 스코프(전체 워크스페이스로 전환 가능). 태스크를 클릭하면 프롬프트/결과 마크다운이 열립니다. 실행 중인 행에는 인라인 **Cancel Dispatched Task** 버튼이, 뷰 타이틀에는 확인을 먼저 묻는 **Cancel All Running Dispatches** 버튼이 있습니다.
- **오케스트레이터 대시보드** (에디터 탭) — 통계 타일(실행 중, 7일 태스크, 성공률, 토큰, 비용), 라이브 사용량 패널(윈도우별 막대에 %, 심각도 색상, 리셋 카운트다운, "N분 전 업데이트" 최신성 표시), 14일 태스크 차트, 워커별 토큰 분포, 워커·태스크 테이블, 빠른 액션이 있는 설정 패널. 2초마다 자동 갱신, 테마 자동 대응. 실행 중인 행에는 Cancel 버튼이 있고, 모든 실행 중인 디스패치 취소도 빠른 액션으로 제공됩니다.
- **Open Interactive Worker Session** — 워커를 통합 터미널의 보이는 세션으로 실행합니다(초기 태스크 주입 가능). 지켜보며 개입하고 싶을 때.

디스패치를 멈추면 실제로 멈춥니다: Stop을 누르면 해당 MCP 요청이 취소되고 그 워커의 프로세스 트리 전체가 종료됩니다(`dispatch_tasks`로 보낸 배치는 하나의 요청이므로, 취소하면 배치 안의 모든 태스크가 함께 멈춥니다). 오케스트레이터 세션이 끝나면 — 패널을 닫거나, 창을 새로고침하거나, VS Code를 종료하거나, 프로세스를 강제 종료하면 — 그 세션이 띄운 모든 워커를 `workerTimeoutMinutes` 시간까지 방치하지 않고 종료시킵니다. 익스텐션은 여전히 자신의 워커임이 확인된 프로세스 ID에만 신호를 보내며(OS가 재사용한 ID에는 절대 보내지 않음), 취소는 워커 에러나 쿼터 쿨다운으로 집계되지 않고, 워커가 죽었는데도 실행 중으로 표시된 태스크는 다음 활성화 때 오펀(orphaned)으로 회수됩니다.

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

## 데이터와 프라이버시

모든 것이 로컬에 머뭅니다. 익스텐션과 서버는 `~/.claude-code-orchestrator/` 아래 상태를 공유합니다: 워커 레지스트리(이름, config dir 경로, 기본 모델 — **토큰·자격 증명 없음**), 워커별 사용량 통계, 태스크 로그, 태스크 결과 마크다운. 사용자가 디스패치한 Claude Code CLI 호출 외에는 아무것도 외부로 전송되지 않습니다. 익스텐션을 제거해도 이 디렉토리는 남습니다 — 완전히 지우려면 직접 삭제하세요.

## 트러블슈팅

- **MCP 서버가 “failed”로 표시** — 대개 GUI 프로세스의 Node.js 경로 문제입니다. *Register Dispatch MCP Server*를 다시 실행하세요; 익스텐션이 로그인 셸로 `node` 절대 경로를 찾아 `.mcp.json`에 기록합니다.
- **워커가 멈췄다가 타임아웃** — `workerPermissionMode`를 확인하세요; `default`는 아무도 누를 수 없는 권한 승인을 무한 대기합니다. 태스크는 `claudeCodeOrchestrator.workerTimeoutMinutes`(기본값 45, 범위 1–480) 후 타임아웃되며, 한 번의 디스패치에 한해 `timeout_minutes` 도구 인자로 재정의할 수 있습니다.
- **“Dispatch to claude-fable-5 is blocked”** — 과금 가드가 켜져 있습니다(기본값). 비용을 감수한다면 `frontierWorkerDispatch: allow`로 의도적으로 여세요.
- **모든 디스패치가 쿼터 에러** — `list_workers` / Worker Accounts 뷰에서 쿨다운을 확인하세요; 워커가 하나면 페일오버가 없습니다.

## 한계와 참고

- 워커들은 **같은 워크스페이스**의 파일을 동시에 수정합니다. 겹치는 작업에는 프롬프트에서 파일 소유 목록을 분리해 주세요 (태스크별 worktree 격리는 로드맵에 있습니다).
- 메인 계정은 건드리지 않습니다 — 패널은 기본 `~/.claude` 로그인을 그대로 씁니다.
- 여러 Claude 계정 사용은 Anthropic 서비스 약관과 사용 정책의 적용을 받습니다. **계정 구성과 사용이 약관을 준수하는지 확인할 책임은 사용자에게 있습니다.** 디스패치된 작업은 각 워커 계정의 쿼터 또는 종량 과금을 소비합니다.

## 라이선스와 상표

[MIT](LICENSE) © 2026 Toragonite.

Claude, Claude Code, Anthropic은 Anthropic, PBC의 상표입니다. 이 프로젝트는 독립적인 커뮤니티 확장이며 Anthropic과 제휴·후원·보증 관계가 없습니다.
