# Fable Orchestrator

멀티 계정 Claude 오케스트레이션 VS Code 익스텐션입니다. Antigravity의 멀티 계정처럼, 계정마다 브라우저에서 **Claude 계정으로 로그인(OAuth)** 해서 등록합니다.

- **메인 계정** — `claude-fable-5`가 오케스트레이터로 동작합니다. 요청을 분석해 직접 답하거나, 독립적인 서브태스크로 분해해 워커에게 위임합니다.
- **워커 계정 (1개 이상)** — 각자 자신의 Claude 계정(OAuth 토큰)으로 `claude-opus-4-8` 또는 `claude-sonnet-5`를 실행하며, 오케스트레이터가 `dispatch_task` 도구로 보낸 태스크를 병렬로 처리합니다.

## 인증 (OAuth)

Claude Code와 동일한 claude.ai OAuth(authorization code + PKCE) 플로우를 사용합니다.

1. 계정 추가 시 브라우저가 열리면 **해당 슬롯에 쓸 Claude 계정으로 로그인**
2. 콜백 페이지에 표시되는 코드(`code#state` 형태)를 VS Code 입력창에 붙여넣기
3. 액세스/리프레시 토큰 쌍이 VS Code Secret Storage에 저장되고, 만료 임박 시 리프레시 토큰으로 자동 갱신

계정별로 다른 Claude 계정으로 로그인하면 되므로 계정 수 제한 없이 추가할 수 있습니다. **로그인은 최초 등록 때 1회뿐**이고 이후에는 저장된 토큰이 계속 재사용됩니다. 리프레시 토큰까지 만료되면 **Re-authenticate Account** 커맨드로 다시 로그인하면 됩니다. (Console API 키를 쓰고 싶은 계정은 추가 시 "Anthropic API key"를 선택할 수도 있습니다.)

### 저장된 로그인 가져오기

이미 다른 도구로 로그인해둔 계정이 있다면 브라우저 로그인 없이 **Import Stored Logins** 커맨드로 바로 가져올 수 있습니다. 스캔 대상:

- **Claude Code** — `~/.claude/.credentials.json`, `$CLAUDE_CONFIG_DIR`, 그리고 멀티 계정 용도로 흔히 쓰는 `~/.claude-*` 디렉토리들
- **ant CLI 프로필** — `ant auth login --profile <이름>`으로 만든 `~/.config/anthropic/credentials/*.json`

발견된 로그인 중 원하는 것들을 골라 각각 Main / Worker(opus) / Worker(sonnet) 역할을 지정하면 됩니다. 즉, 미리 `ant auth login --profile w1`, `--profile w2` ... 식으로 여러 계정을 로그인해두고 한 번에 임포트하는 흐름이 가능합니다.

주의: 토큰은 Secret Storage로 **복사**되며, 이후 익스텐션이 자체적으로 토큰을 갱신하면 원본 도구(Claude Code 등)의 토큰과 갈라져 원본 쪽에서 재로그인이 필요해질 수 있습니다. macOS에서는 Claude Code가 토큰을 Keychain에 보관하는 경우 파일 스캔으로 발견되지 않으니 브라우저 로그인을 사용하세요.

> 참고: 구독(OAuth) 토큰은 요청에 `anthropic-beta: oauth-2025-04-20` 헤더와 Claude Code 아이덴티티 시스템 블록이 필요하며, 익스텐션이 자동으로 처리합니다. 구독 계정의 사용량 한도는 각 계정의 플랜을 따릅니다.

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
- Fable 5의 안전 분류기 거절(refusal)에 대비해 기본으로 **server-side fallbacks 베타**(`server-side-fallback-2026-06-01`)를 켜서, 오탐 시 같은 요청을 `claude-opus-4-8`이 이어받게 합니다. `fableOrchestrator.enableRefusalFallback` 설정으로 끌 수 있습니다 (OAuth 계정에서 이 베타가 거부되는 경우에도 끄면 됩니다).
- 자격증명(OAuth 토큰 쌍 또는 API 키)은 VS Code **Secret Storage**에만 저장됩니다 (settings.json에 저장되지 않음).

## 사용법

1. `npm install && npm run compile` 후 F5 (Extension Development Host 실행)
2. 좌측 액티비티 바의 **Fable Orchestrator** 뷰 열기
3. **Add Account**로 계정 등록 (각각 브라우저에서 해당 Claude 계정으로 로그인)
   - Main 역할 1개 (Fable을 쓸 계정)
   - Worker 역할 1개 이상 (다른 계정들 + 기본 모델 선택)
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
| `src/oauth.ts` | claude.ai OAuth (PKCE) — 로그인 URL, 코드 교환, 토큰 리프레시 |
| `src/importers.ts` | 로컬에 저장된 로그인 발견 (Claude Code / ant 프로필) |
| `src/accounts.ts` | 계정 관리 (메타데이터: globalState, 토큰/키: SecretStorage, 자동 리프레시) |
| `src/orchestrator.ts` | Fable 5 에이전틱 루프 + `dispatch_task` 도구 정의 |
| `src/workers.ts` | 워커 풀 — 라운드로빈 배정, Opus/Sonnet 스트리밍 실행 |
| `src/tasks.ts` | 태스크 레지스트리 (상태/출력 추적) |
| `src/views.ts` | Accounts/Tasks 트리 뷰, 태스크 출력 가상 문서 |
| `src/extension.ts` | 커맨드 등록 및 배선 |
