# Fable Orchestrator

**기존 Claude Code 익스텐션을 멀티 계정으로 확장**하는 VS Code 익스텐션입니다. 평소처럼 Claude Code 패널(메인 계정, Fable)에서 대화하고, 메인 세션이 MCP 도구로 **다른 Claude 계정들(워커)** 에게 작업을 병렬 분배합니다.

```
Claude Code 패널 (메인 계정, Fable 5)          ← 평소처럼 사용
   │  MCP 도구: dispatch_task / list_workers
   ▼
fable-dispatch MCP 서버 (.mcp.json에 등록)
   │  CLAUDE_CONFIG_DIR=<워커 dir> 로 Claude Code 실행 (같은 워크스페이스)
   ├────────────┬────────────┐
   ▼            ▼            ▼
워커 w1        워커 w2       워커 w3
(opus-4-8)    (sonnet-5)   (opus-4-8)
```

핵심 아이디어: **계정 = Claude Code config 디렉토리.** 워커마다 `~/.claude-<이름>` 디렉토리를 만들고 그 계정으로 한 번만 로그인해두면, 이후에는 저장된 로그인이 계속 재사용됩니다. 이 익스텐션은 토큰을 직접 다루지 않습니다 — 로그인/갱신은 전부 Claude Code가 처리합니다.

## 설정 순서

1. `npm install && npm run compile`, F5로 익스텐션 실행 (또는 vsix 패키징 후 설치)
2. 액티비티 바 **Fable Orchestrator** → **Add Worker Account**
   - 이름 입력(예: `w1`) → 기본 모델 선택(`claude-opus-4-8` / `claude-sonnet-5`)
   - 열리는 터미널에서 해당 슬롯에 쓸 Claude 계정으로 **1회 로그인**
   - 이미 로그인해둔 `~/.claude-*` 디렉토리가 있다면 **Import Existing Claude Config Directories**로 한 번에 등록
3. **Register Dispatch MCP Server in This Workspace** — 워크스페이스 루트 `.mcp.json`에 `fable-dispatch` 서버를 등록합니다
4. Claude Code 패널 세션을 재시작하고 프로젝트 MCP 서버를 승인 → 메인 세션에 `dispatch_task`, `list_workers` 도구가 생깁니다

이후에는 그냥 Claude Code 패널에서 대화하면 됩니다. 큰 작업을 주면서 "독립적인 부분은 워커에게 병렬로 dispatch해서 진행해줘"라고 하면 메인(Fable)이 알아서 fan-out 합니다. `CLAUDE.md`에 디스패치 방침(언제/무엇을 위임할지)을 적어두면 더 일관되게 동작합니다.

## 동작 방식

- **dispatch_tasks (병렬 배치, 권장)** — 여러 개의 독립 태스크를 한 번의 호출로 넘기면 서버가 워커들에 걸쳐 **진짜 병렬로** 실행하고 결과를 모아 반환합니다. 메인 모델이 도구를 순차 호출해도 병렬성이 보장됩니다.
- **dispatch_task (단건)** — 태스크 하나를 워커에 실행. 워커의 `CLAUDE_CONFIG_DIR`로 Claude Code를 백그라운드 실행합니다(같은 워크스페이스 cwd, 파일/셸 접근 가능).
  - `system_prompt` 파라미터로 메인 세션(Fable)이 워커에게 역할·품질 기준·출력 형식 시스템 프롬프트를 직접 내려보낼 수 있습니다 (`--append-system-prompt`로 전달) — 복잡한 작업 품질에 큰 차이를 만듭니다
  - 워커 미지정 시 **쿼터 인지 라운드로빈** 배정, `model` 미지정 시 워커의 기본 모델 사용
  - 백그라운드 워커는 권한 프롬프트에 답할 수 없으므로 기본 `--permission-mode acceptEdits`로 실행 (설정 가능; 셸 명령 실행이 필요한 태스크는 `bypassPermissions` 필요 — 보안 영향 이해하고 사용)
- **쿼터 추적/자동 분산** — 워커별 누적 사용량(태스크 수, 토큰, 비용)을 CLI 결과에서 집계해 기록합니다. quota/rate-limit 에러가 감지되면 그 워커를 일정 시간 쿨다운시키고 **다른 워커로 자동 재시도**합니다. 워커가 하나뿐이면 재시도 없이 명확한 에러로 알려줍니다. `list_workers`로 워커별 사용량·쿨다운 상태를 조회할 수 있고, Worker Accounts 뷰에도 표시됩니다.
- **Dispatched Tasks 뷰** — MCP 서버가 남기는 태스크 로그(`~/.fable-orchestrator/tasks.jsonl`)를 실시간 표시. 클릭하면 해당 태스크의 프롬프트/결과 마크다운이 열립니다.
- **Open Interactive Worker Session** — 워커를 백그라운드가 아니라 **통합 터미널의 인터랙티브 Claude Code 세션**으로 띄웁니다(선택적으로 초기 태스크 주입). 눈으로 보면서 개입하고 싶은 작업용.

## 커맨드

| 커맨드 | 설명 |
|---|---|
| Add Worker Account | 워커 생성 (config dir 생성 + 로그인 터미널) |
| Import Existing Claude Config Directories | `~/.claude*` 디렉토리 스캔 후 일괄 등록 |
| Register Dispatch MCP Server in This Workspace | `.mcp.json`에 fable-dispatch 등록 |
| Open Worker Session in Terminal | 워커를 보이는 터미널 세션으로 실행 (항목의 인라인 터미널 버튼) |
| Re-login Worker Account | 워커 계정 재로그인 (항목 우클릭) |
| Remove Worker Account / Clear Task History | 정리 (항목 우클릭 / Tasks 뷰 버튼) |

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `fableOrchestrator.workerPermissionMode` | `acceptEdits` | 백그라운드 워커의 `--permission-mode` (`default`는 편집 승인 대기로 멈추므로 비추천) |
| `fableOrchestrator.claudePath` | `claude` | Claude Code CLI 경로 |
| `fableOrchestrator.quotaCooldownMinutes` | `30` | 쿼터 에러 후 해당 워커를 배정에서 제외하는 시간(분) |

## 코드 구조

| 파일 | 역할 |
|---|---|
| `src/mcp/server.ts` | fable-dispatch MCP 서버 (stdio, 의존성 없음) — dispatch_task/list_workers, 워커 실행, 태스크 로그 |
| `src/registry.ts` | 익스텐션 ↔ MCP 서버 공유 상태 (`~/.fable-orchestrator/`): 워커 목록, 설정, 태스크 로그 |
| `src/workerManager.ts` | 워커 프로필 관리, config dir 탐색, 로그인/인터랙티브 터미널 |
| `src/views.ts` | Worker Accounts / Dispatched Tasks 트리 뷰 |
| `src/extension.ts` | 커맨드 등록 및 배선 |

## 참고

- 메인 계정은 건드리지 않습니다 — Claude Code 패널이 쓰는 기본 로그인(`~/.claude`) 그대로입니다. 메인에서 Fable을 쓰려면 Claude Code의 모델 선택에서 Fable을 고르면 됩니다.
- 워커들은 같은 워크스페이스 파일을 동시에 수정할 수 있으므로, 파일이 겹치는 작업은 프롬프트에서 담당 영역을 나눠 주세요 (worktree 분리는 추후 확장 예정).
- 이전 버전의 직접 API 호출(OAuth 토큰 관리) 방식은 제거되었습니다 — git 히스토리에서 확인할 수 있습니다.
