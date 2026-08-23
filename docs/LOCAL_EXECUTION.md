# 로컬 실행 v2 — Agent-XGeny 가 이 PC 에서 도는 방식

커넥터에서 시작한 Agent-XGeny 대화는 **이 PC 의 로컬 실행 환경(사이드카)** 에서 돈다.
메모리·파일·이력·자격증명은 **서버가 관리**하고, 로컬은 실행만 맡는다. 로컬에서 돌 수
없을 때만 서버 sandbox 로 보내며, 그때도 이유를 숨기지 않는다(채팅 배지 + 진단 로그).

```
[커넥터 chatStart]
   ├─ localExec.enabled && 런타임 설치됨 && 문자열 입력 && 첨부 없음
   │     ├─ GET  /api/agentflow/geny-agent/{wf}/local-turn-context  (에이전트 설정·계정 키·관리자 설정)
   │     ├─ 로컬 동기화 폴더 확보(LocalSyncManager.ensureSynced)
   │     ├─ CLI provider 면 바이너리 보장(서버 목표 버전)
   │     ├─ 사이드카 데몬에 turn → chunk/tool 이벤트 → 채팅 (status: 이 PC에서 실행)
   │     ├─ flushSync(로컬 변경 → 서버 인덱스)
   │     └─ POST /api/agentflow/geny-agent/{wf}/report-turn  (텍스트·도구 이벤트·usage·상태)
   └─ 아니면 → 서버 POST /execute/based-id/stream  + execution_target:'sandbox'
               (status: 서버에서 실행 — 사유)
```

## 구성요소 (설치 폴더 `<dataRoot>` = 기본 `~/xgen-connector`)

| 경로 | 내용 | 누가 만드나 |
|---|---|---|
| `local-runtime/python/` | 이식형 CPython + `xgen-agent-runtime`(사이드카 포함) | 인스톨러(NSIS 복사) / 부팅 안전망(cpSync·다운로드) |
| `local-runtime/bin/{codex,claude}[.exe]` | Codex / Claude Code CLI — **서버와 같은 버전** | 부팅 자동 설치 → 로그인 후 서버 매니페스트로 수렴 |
| `local-runtime/codex-home`, `claude-home` | CLI 격리 홈(`CODEX_HOME`/`CLAUDE_CONFIG_DIR`) — 서버 중앙 자격증명이 여기로 물질화 | 사이드카(LocalHostServices) |
| `workspace/<agent>/` | 에이전트 로컬 동기화 폴더(= 사이드카 작업 폴더) | 동기화 엔진 |

## 서버 버전 수렴 (`local-runtime-converge.ts`)

로그인 직후와 [설정 → 일반 → 서버 버전으로 맞추기] 에서
`GET /api/agentflow/geny-agent/local-runtime/manifest` 를 받아
- 런타임 wheel 버전이 다르면 설치 폴더 Python 에 `pip install --upgrade <wheel_url>` (Python 은 그대로),
- Codex / Claude Code 가 목표 버전이 아니면 공식 배포처에서 그 버전을 설치한다.
실패는 상태(lastError)로만 드러나고 기존 설치본은 보존된다(비파괴).

## 사이드카 데몬 (`local-agent-sidecar.ts` ↔ `xgen_agent_runtime.host.sidecar --serve`)

- 첫 턴에 기동, 유휴 15분 후 자가 종료, 앱 종료 시 내림. 기동은 `ready`, 턴은 `id` 로 상관.
- 이벤트: `started` · `chunk` · `tool`(웹과 같은 tool_call/tool_result/tool_error) · `canvas_command` ·
  `done` · `error` · `cancelled`. 취소는 `cancel` 명령(협조) → 유예 초과 시 데몬 강제 종료.
- 환경: `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1`, PATH 앞에 `local-runtime/bin`.

## 서버 계약 (xgen-workflow)

- `local-turn-context.settings`: `CLAUDE_CODE_AUTH_MODE`/`OAUTH_TOKEN`(setup_token 일 때), `CODEX_AUTH_MODE`/
  `CODEX_CREDENTIALS_JSON`(oauth 일 때), 기본 모델·타임아웃·예산, `GENY_TOOLS_*_ENABLED`. 커넥터가
  `CODEX_BINARY_PATH`/`CLAUDE_CODE_BINARY_PATH`/`XGEN_LOCAL_CODEX_HOME`/`XGEN_LOCAL_CLAUDE_CONFIG_DIR` 를 덮어쓴다.
- `execution_target: 'sandbox'`: 커넥터 폴백 턴 — 서버는 커넥터 로컬 워크스페이스(역방향 WS) 프로브를 건너뛴다.

## 진단

- 설정 → 스토리지 → [진단 로그 복사] 의 `local-exec` 항목: 폴백 사유, 사이드카 기동/종료, 수렴 계획.
- 채팅 메시지 상단 배지: **이 PC에서 실행** / **서버에서 실행(사유)**.

## CLI 인증 (이 PC 로그인) — `local-cli-auth.ts`

XGEN 관리자 LLM 탭과 같은 로그인 흐름을 커넥터 안에서 제공한다. 자격증명은 설치 폴더의 격리 홈에만 남는다.

| 도구 | 로그인 | 상태 | 로그아웃 |
|---|---|---|---|
| Claude Code | `claude auth login --claudeai` (파이프) → URL 열기 → 브라우저가 준 코드 입력(stdin) | `claude auth status` (JSON) | `claude auth logout` |
| Codex | `codex login --device-auth` (파이프) → URL 열기 + 일회용 코드 표시 → CLI 폴링 완료 | `codex login status` | `codex logout` |

로컬 턴 settings 우선순위: **이 PC 로그인(oauth) > 서버 설정(API 키 / 중앙 자격증명)**. 로그인이 있으면
`CODEX_AUTH_MODE`/`CLAUDE_CODE_AUTH_MODE=oauth` 로 덮고 서버 중앙 자격증명은 제거한다(격리 홈을 덮어쓰지 않게).
둘 다 없으면 로컬에서 시작하지 않고 **서버로 폴백**(`cli_auth_missing`). 로컬 실행이 첫 출력 전에 죽으면
(인증 만료·바이너리 실행 실패·키 없음 등 "[ERROR] … could not start") 역시 서버로 폴백(`local_start_failed`).
