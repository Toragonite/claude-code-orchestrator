# Fable Orchestrator

멀티 계정 Claude 오케스트레이션 VS Code 익스텐션입니다.

- **메인 계정** — `claude-fable-5`가 오케스트레이터로 동작합니다. 요청을 분석해 직접 답하거나, 독립적인 서브태스크로 분해해 워커에게 위임합니다.
- **워커 계정 (1개 이상)** — 각자 자신의 Anthropic API 키로 `claude-opus-4-8` 또는 `claude-sonnet-5`를 실행하며, 오케스트레이터가 `dispatch_task` 도구로 보낸 태스크를 병렬로 처리합니다.

## 동작 방식

```
사용자 요청
   │
   ▼
메인 계정 (claude-fable-5) ── 오케스트레이터 에이전틱 루프
   │  dispatch_task 도구 호출 (한 턴에 여러 개 = 병렬 fan-out)
   ├──────────────┬──────────────┐
   ▼              ▼              ▼
워커 A          워커 B          워커 C
(opus-4-8)     (sonnet-5)     (opus-4-8)
   └──────────────┴──────────────┘
   │  tool_result (하나의 user 메시지로 반환)
   ▼
메인 계정이 결과를 통합·검증 → 최종 답변 스트리밍
```

구현 디테일:

- 모든 요청은 스트리밍(`messages.stream`)으로 실행되고, 워커는 `thinking: {type: "adaptive"}`를 사용합니다.
- Fable 5는 thinking이 항상 켜져 있으므로 `thinking` 파라미터를 보내지 않으며, thinking 블록은 받은 그대로 대화 히스토리에 되돌려 보냅니다.
- Fable 5의 안전 분류기 거절(refusal)에 대비해 기본으로 **server-side fallbacks 베타**(`server-side-fallback-2026-06-01`)를 켜서, 오탐 시 같은 요청을 `claude-opus-4-8`이 이어받게 합니다. `fableOrchestrator.enableRefusalFallback` 설정으로 끌 수 있습니다.
- API 키는 VS Code **Secret Storage**에만 저장됩니다 (settings.json에 저장되지 않음).

## 사용법

1. `npm install && npm run compile` 후 F5 (Extension Development Host 실행)
2. 좌측 액티비티 바의 **Fable Orchestrator** 뷰 열기
3. **Add Account**로 계정 등록
   - Main 역할 1개 (Fable을 쓸 계정의 API 키)
   - Worker 역할 1개 이상 (다른 계정들의 API 키 + 기본 모델 선택)
4. 커맨드 팔레트에서:
   - **Fable Orchestrator: Run Orchestrated Task** — Fable이 계획하고 워커에게 분배
   - **Fable Orchestrator: Dispatch Task Directly to a Worker** — 특정 워커/모델에 바로 실행

진행 상황은 **Tasks** 트리 뷰(실행 중 태스크는 스피너)와 "Fable Orchestrator" 출력 채널에서 확인할 수 있고, 태스크를 클릭하면 해당 워커의 전체 출력이 열립니다.

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `fableOrchestrator.mainModel` | `claude-fable-5` | 메인 계정 모델 |
| `fableOrchestrator.defaultWorkerModel` | `claude-opus-4-8` | 워커 기본 모델 |
| `fableOrchestrator.maxOutputTokens` | `64000` | 스트리밍 요청의 max_tokens |
| `fableOrchestrator.enableRefusalFallback` | `true` | Fable 거절 시 Opus 4.8로 서버측 폴백 |

## 코드 구조

| 파일 | 역할 |
|---|---|
| `src/accounts.ts` | 계정 관리 (메타데이터: globalState, API 키: SecretStorage) |
| `src/orchestrator.ts` | Fable 5 에이전틱 루프 + `dispatch_task` 도구 정의 |
| `src/workers.ts` | 워커 풀 — 라운드로빈 배정, Opus/Sonnet 스트리밍 실행 |
| `src/tasks.ts` | 태스크 레지스트리 (상태/출력 추적) |
| `src/views.ts` | Accounts/Tasks 트리 뷰, 태스크 출력 가상 문서 |
| `src/extension.ts` | 커맨드 등록 및 배선 |
