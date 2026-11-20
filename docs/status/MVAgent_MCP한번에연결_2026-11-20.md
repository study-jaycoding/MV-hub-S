---
status: draft
updated: 2026-11-20
---

# MV Agent 연결 한 번으로 Claude Code·Codex·Claude 앱에서도 MV Hub 바로 쓰기 (2026-11-20)

owner: Codex(구현) · Claude(설계·총괄) · reviewer: Codex(설계 확정) · Claude 별도 세션(독립 리뷰) · status: 완료 — dev 37181cbb 반영(검사기 integrate 통과), 실측 R1~R5 통과 · updated: 2026-11-20
선행 기록: [Claude 앱 MV 도구 자동 허용](MVAgent_Claude앱_MV도구자동허용_2026-11-20.md) · [MCP 한 번에 연결](MCP_한번에연결_2026-10-29.md) · [MV Agent 설치하고 연결 구현](MVAgent_설치연결_구현_2026-11-20.md)

## 1. 요청
- Jay(11-20): "기존에 내가 만든 mcp 서버에서 따로 관리하고있는게 필요한가?" · "mv agent를 통해 ai와 연결하면 mv hub나 클로드코드, 코덱스에서도 다른 mcp사용하듯이 바로바로 생성이나 mv hub컨트롤이 되어야한다." · "여러번 고치라고 했는데 여전히 똑같다".
- Jay(/goal): "설계 시작하고 구현후에 실측까지 진행해서 완벽한 mv agent와 mcp연동되게 하자."

## 2. 근거 (Claude 직접 확인·실측, Codex 독립 검토 `01a1f7a7-461c-7832-bbd9-d94a1a68a136`)
- 등록기는 호스트 설정에 서버 정의만 쓴다: `tools/mcp_adapter/local_setup.py:187-217`, `configure_client` 282-348. 도구 허용(Claude `permissions.allow`)·승인 방식(Codex `default_tools_approval_mode`)은 안 쓴다. 그런데 [한 번에 연결] 안내는 "이후 생성마다 승인을 묻지 않고"(`frontend/src/components/mcp/McpQuickConnect.tsx:151`) — 안내와 동작이 어긋난다.
- MV Agent 칸 연결은 일부러 전역 설정을 안 건드린다(`backend/app/routers/mcp_v2.py:315-317`), 화면도 "MV Agent 칸은 이 연결 없이 씁니다"(McpQuickConnect.tsx:116). 칸 연결 완료 ≠ Claude Code·Codex 준비 완료.
- 이 PC: `~/.claude.json` 사용자 범위에 `mvhub`(설치본 8010)·`mvhub-test`(dev 8012), `~/.claude/settings.json` 은 `defaultMode: auto` + `allow` 에 Higgsfield 도구 8개만. `~/.codex/config.toml` 은 `approval_policy="never"`·`sandbox_mode="danger-full-access"`, mvhub 표에 승인 방식 없음.
- Claude 공식 문서(code.claude.com/docs/en/permissions, /settings): dontAsk 에서도 `permissions.allow` 규칙은 실행 · 사용자 범위 규칙은 모든 프로젝트 · `mcp__<서버>` 는 그 서버 모든 도구 · deny → ask → allow 순서·광역 패턴 지원 · permissions 는 실행 중에도 다시 읽음.
- 실측(15:35, 시험 앱 대화 f5 `92dec522`): dontAsk 세션을 앱으로 넘김 → `mcp__mvhub-test__check_connection` 거부(`mode:dontAsk`) → 대화를 연 채로 프로젝트 허용을 씀 → 같은 대화 2회차 `accept · rule · projectSettings`.
- Codex 판정(공식 소스 rust-v0.162.0-alpha.17.2 `codex-mcp/src/mcp/mod.rs#L91`·`core/src/mcp_tool_call.rs#L1510·#L1615·#L2461`): 서버 승인 방식 `approve` 면 자동 통과, `never`+전체 접근이면 자동 통과, 제한 샌드박스+기본 `auto` 면 파괴적 표시 도구는 거부. 실측(`codex exec --sandbox read-only`): `check_connection` 실행, `execute_generation_plan`(없는 plan_id)은 "MCP tool call requires approval, but approval policy is never" 로 허브 전에 거부. 그 도구는 `destructive_hint=True`(`tools/mcp_adapter/server.py:1176`).
- 앱으로 넘긴 Jay 대화 `417be1ae…` 는 꺼져 있던 `mvhub`(8010)를 골랐다 — 같은 PC 에 연결이 둘이면 권한이 풀려도 엉뚱한 허브를 부른다.

## 3. 설계 (5판 — Codex 설계 확정 `01a1f7c2-fe1a-7c62-9745-1fedf388945e`·양측 합의 1~3차 지적 반영)

### 3-1. 등록이 허용까지 한다 (`local_setup.configure_client`)
- **Claude(`claude`)**: `~/.claude.json` 등록 성공 뒤 `~/.claude/settings.json` 의 `permissions.allow` 에 서버 전체 규칙 `mcp__<서버 이름>` 하나를 더한다(`server_name`: 설치본 `mvhub`, dev `mvhub-test`).
  - `permissions`·`allow`·`deny`·`ask` 형식을 모두 검증한다. 깨진 JSON·중복 키·비표준 상수·4MB 초과·꼴이 다르면 손대지 않고 `access="failed"`.
  - **충돌 검사가 먼저**: `deny`·`ask` 에 그 서버를 덮을 수 있는 규칙(`*`, `mcp__*`, `mcp__<이름>`, `mcp__<이름>__…`, 그 서버를 맞출 수 있는 광역 패턴·인자 제한 규칙)이 있으면 손대지 않고 `access="conflict"`. 해석이 불명확하면 허용하지 않는다.
  - 같은 규칙이 이미 있으면 바이트·백업 모두 불변(`present`). `defaultMode`·다른 키·목록 순서·기존 거부 보존(서식 바이트 보존은 약속하지 않음).
  - `CLAUDE_CONFIG_DIR` 이면 쓰지 않고 `manual`. 허용 쓰기 실패·충돌은 `configured + access` 로 돌려준다 — 이미 성공한 등록을 예외로 바꿔 새 자격을 회수하지 않는다. `access` 는 "사용자 설정 반영 결과"이지 모든 세션의 실행 보증이 아니다(프로젝트·관리자 정책은 판정 밖).
- **Claude 데스크톱(`claude_desktop`)**: 등록만으로 Claude Code 사용자 허용을 쓰지 않는다(데스크톱 채팅 등록 파일은 Claude Code 등록과 다르다). 지금 동작 그대로.
- **Codex(`codex`)**: 새 등록 표에 `default_tools_approval_mode = "approve"`(칸과 같은 값, `agent_chat_process.py:275`). 기존 표에 `auto/prompt/writes` 같은 다른 값이 있으면 사용자 설정으로 보고 덮지 않는다(`conflict`). 재등록(표 교체)·구 `mvhub` 항목 제거는 표에 `command`·`args`·`tool_timeout_sec`·`default_tools_approval_mode` 밖의 키나 하위 표가 있으면 지우지 않고 `manual` 로 멈춘다(지금은 조용히 지운다). 기존 timeout 값도 조용히 초기화하지 않는다. Claude `mcpServers` 항목의 사용자 추가 키(`env` 등)도 자동 재등록으로 지우지 않는다.
- **파일 쓰기 공통**: 설정 파일의 정규화된 경로 기준 **Windows 프로세스 간 잠금(이름 붙은 뮤텍스)** 안에서 읽기→검증→백업→교체. 백업은 최초 원본(`.mvhub-original`, 배타적 생성 — 덮지 않음)과 직전 원본(`.mvhub-backup`) 두 벌, 백업 실패면 교체하지 않는다. 교체 직전 원본 재대조는 유지하되, 잠금에 참여하지 않는 편집기·구버전 MV Hub 와의 경쟁을 완전히 없앴다고 주장하지 않는다. 두 Claude 파일 변경은 한 트랜잭션이 아니므로 부분 성공을 결과로 구분한다.
- 결과의 `access`: `allowed` · `present` · `conflict` · `manual` · `failed` (+ Codex `missing`). 비밀값·설정 내용은 결과·로그에 싣지 않는다.

### 3-2. 이미 등록된 연결의 허용만 맞춘다 (`local_setup.ensure_access` 새 함수)
- 재발급 없이 허용만 맞춘다. 대상 서버 항목이 우리 등록(실행 파일·어댑터·`--url` = 현재 허브)이고, 항목의 `--profile` 경로가 `connections/<현재 허브 id>/<연결 id>.bin` 형태이며, 기존 `read_profile`(`local_setup.py:92`)로 **메모리에서만** 연 프로필의 `url`·`hub_id`·`client_id` 가 항목·경로와 같고, 비밀값 해시가 **이 계정의 살아 있는 같은 이름 연결** DB 행과 맞으며, 그 행의 소유자·계정·비밀번호 변경 시점이 현재 인증 조건(`mcp_v2.py:139` 검사와 같은 기준)과 맞을 때만 3-1 의 허용을 맞춘다. 맞지 않으면(파일 없음·손상·내부 id/해시 불일치·다른 계정·회수된 자격·수동 등록 미완료·항목 없음) 설정 변경·재발급 없이 `reconnect`. 비밀값은 돌려주거나 기록하지 않는다. 기존 `can_execute=False`·고정 공간 자격은 넓히지 않는다(그 자격이면 `limited`).
- Codex 기존 표에 승인 방식 키가 없으면 **그 표 안에 한 줄만 삽입**하고, 다시 읽은 전체 파싱 결과가 `기존 + 그 키 하나` 와 정확히 같을 때만 저장. 일반·인용 표 헤더만 처리, 인라인 표·점 표기만 있는 정의·모호한 다중행·중복 후보·파싱 실패는 `manual`. `enabled=false`·도구 제한·도구별 승인 재정의가 있으면 보존하고 `limited` 로 표시.

### 3-3. MV Agent 연결 = 바깥 앱 연결 (`POST /api/mcp/v2/app/agent-link` 새 API)
- 본문 `{"engines": ["claude"|"codex"], "identity_key": …}`, 머리 `X-MVHub-Tab`·`X-MVHub-Expect-Account`. 기존 `_app_context`(로그인·loopback·Origin·공유 서버 검사) 위에 기대 계정·`identity_key`·허브 신원 불일치를 **쓰기 전에** 거절한다. 엔진은 `claude/codex` 만, 중복 제거.
- 엔진 → 클라이언트: `claude → claude`, `codex → codex`. 데스크톱 채팅은 켜진 앱에선 등록 불가(10-29 실측)·요구 범위 밖이라 MV·MCP 연결 창에 그대로.
- 표식 = 기존 `app_setting` 키 `mcp_agent_link:<owner_uid>:<계정 이메일>:<클라이언트>`, 값 = `linked`/`off`/`retry` 와 연결 id(JSON). 새 표·마이그레이션 없음.

| 관측 상태 | 자동 연결 동작 |
|---|---|
| `off` | 설정·허용·자격 모두 안 건드림 |
| 실제 설정과 맞는 살아 있는 자격(3-2) | 그 id 유지, 허용만 점검(재발급 금지 — 재발급은 같은 이름 앞 연결을 회수해 열린 앱을 끊는다, `mcp_v2.py:293-294`). 표식이 없던 기존 [한 번에 연결] 사용자는 이때 `linked` 를 기록 |
| 표식 없음 + 서버 항목·연결 이력 없음 | 최초 발급: 기존 [한 번에 연결]과 같은 `_register_client(scope account, allow_execution=True)` → `configured` 면 `linked` |
| `linked` + 같은 이름 살아 있는 자격 0개(로그아웃 `auth.py:333-334`·비밀번호 변경으로 회수·무효) | 표식의 이전 연결 id 로 DB 행(회수된 행 포함 — 범위·실행권이 남는다, `repo/mcp_v2.py:34·62`)을 찾아 소유자·계정·허브·클라이언트 이름을 확인하고, 실제 서버 설정의 프로필이 **그 이전 연결**을 가리킬 때만 **이전 공간 범위·실행권을 그대로 물려받아** 다시 발급 → `linked`. 팀 공간 범위를 물려받을 때는 `/app/configure` 처럼 `_workspace`(`mcp_v2.py:202-218`)로 현재 팀 소속을 다시 확인한다. 이전 행·공간 권한을 확인할 수 없거나 설정이 다른 연결(다른 계정 등)로 바뀌었으면 덮지 않고 "다시 연결 필요". 명시적 해제는 마지막 자격 회수와 같은 트랜잭션에 `off` 를 쓰므로 이 상태는 해제가 아니고, 끊을 열린 연결도 없다 |
| 이번 기능이 남긴 `retry` | 설정을 다시 검사한 뒤 실패했던 최초 등록만 재시도 |
| `linked` 인데 살아 있는 자격은 있으나 실제 설정과 안 맞음 / 표식 없이 회수 이력만 있음(의도 구분 불가) | 자동 발급하지 않고 "다시 연결 필요" |

- 발급 전에는 `/app/configure` 처럼 AUTH 켠 허브에서 `mcp_active_account` 를 현재 계정으로 맞춘다(`mcp_v2.py:340-341` — 다르면 새 연결이 403, `mcp_v2.py:169`).
- "살아 있는 자격" 의 정의는 한 곳에서만 정한다: `revoked_at` 이 비었고, 소유자·계정이 현재와 같고, 비밀번호 변경 시점이 현재 계정 값과 같은 행(비밀번호를 바꾸면 행은 회수되지 않은 채 쓸 수 없게만 된다, `mcp_v2.py:140`). 상태표 판정과 3-2 대조가 같은 함수를 쓴다. 최초 발급만 기존 [한 번에 연결]과 같은 계정 범위·실행 허용이다.

- 명시적 [해제]가 **현재 소유자의 아직 회수되지 않은 행을 이번 요청으로 회수했고, 회수 뒤 같은 클라이언트의 살아 있는 자격이 0개**일 때 같은 DB 트랜잭션에 `off` 를 쓴다 — 해제한 행이 비밀번호 변경으로 이미 무효였어도 포함한다(그래야 `linked`+자격 0개 재발급 규칙이 해제를 뒤집지 않는다). 이미 회수된 옛 id 를 다시 해제하는 요청은 제외(새 연결의 표식은 안 바뀜). 내부 실패 정리·재등록에 따른 구 자격 회수·칸 자격 회수·로그아웃은 `off` 로 기록하지 않는다. 자동 등록의 `manual/skipped/error` 는 성공 표식을 안 남기고 새로 만든 미완료 자격은 회수한다(`retry`). 수동 configure 의 설정 복사 계약은 그대로, 성공하면 `linked`.
- **잠금**: `_registration_lock` 을 재진입 가능한 `threading.RLock` 으로 바꿔 configure·agent-link·명시적 revoke·로그아웃의 자격 회수를 직렬화하고, 조회→판정→설정 쓰기→자격·표식 확정을 한 등록 작업 안에서 끝낸다. 요청 시작의 계정 세대를 잡고 쓰기 전후 `_still_current` 로 다시 본다(로그아웃이 먼저 끝났으면 발급하지 않고, 발급이 먼저면 로그아웃이 그 자격도 회수). 파일 작업은 기존 비취소 스레드 도우미(`backend/app/services/async_tools.py`)로 — 요청 취소를 쓰기 취소로 오인하지 않는다.
- **화면**: 호출 상태는 `useAgentChat` 이 맡고(`AgentPanel` 은 표시만), 키 = 계정 namespace·인증 토큰 세대·`identity_key`·엔진. 이미 처리한 엔진은 다시 안 부르고, 진행 중 요청은 합치고, StrictMode 재실행·분리 창(AgentWindow)을 견디며, 계정 변경·언마운트 뒤 응답은 버린다(창 사이 중복의 최종 방어는 서버 멱등). 실패는 성공 캐시에 넣지 않고 자동 반복 대신 MV Agent 설정 › 연결에 바깥 연결 전용 상태 한 줄과 `[다시 확인]` — 칸 대화는 계속 쓸 수 있다. `off` 는 재시도로 풀지 않는다.
- 상태 한 줄: "Claude Code·Codex 에서도 MV Hub 사용 — 연결됨 / 허용 확인 필요(충돌) / 제한된 연결 / 수동 등록 필요 / 다시 연결 필요 / 해제됨". "등록·허용 설정 완료"와 "실제 호출 확인"(`last_seen_at`)을 구분한다. `McpQuickConnect`·`McpRegistration` 도 `access` 결과를 보이고, 살아 있는 행이 실패를 가리지 않게 한다.
- 동의 문구: MV Agent 연결 안내(AgentConnect 하단·AgentSettings 연결 구역)에 "연결하면 이 PC 의 Claude Code·Codex 에서도 MV Hub 를 바로 쓰고 생성해요(생성마다 묻지 않음 · 요청한 생성은 크레딧)". MV·MCP 연결의 "MV Agent 칸은 이 연결 없이 씁니다" → "MV Agent 를 연결하면 Claude Code·Codex 는 저절로 연결돼요".

### 3-4. 같은 PC 의 두 MV Hub 연결 고르기 (어댑터 안내문)
- 일반(칸 아닌) 안내에 추가: "이 PC 에 MV Hub 연결이 둘 이상(예: mvhub·mvhub-test)이면 각 연결의 check_connection 으로 응답하는(status=available) 허브를 찾고, 그 연결의 connect 로 자격·범위를 확인한 뒤 쓰세요. 둘 다 응답하면 임의로 고르지 말고 어느 허브인지 사용자에게 확인하세요." `available` 은 계정 인증 성공이 아니다. 기존 "다른 연결의 ID 재사용·포트 자동 탐색 금지"는 유지. native·conversation 양쪽에 들어가므로 `CONVERSATION_SURFACE_SHA256` 은 의도한 차이만 확인하고 갱신, 칸 안내·도구 목록은 불변 검증. `ADAPTER_VERSION = "2026.11.20.1"`.
- 독립 MCP 업데이트 대상은 `server.py` 뿐이다 — 이번 등록기·백엔드·프런트 변경은 앱 업데이트가 필요하다. `update.py`·배포 포맷은 안 바꾼다.

### 3-5. 바꾸지 않는 것 · 범위 밖
- 칸 실행 옵션(`--permission-mode dontAsk`·`--strict-mcp-config`·`--setting-sources local`, Codex `--ignore-user-config`)과 칸 전용 `mvhub_panel` 자격 — 칸은 사용자 설정을 안 읽어 이번 허용이 칸에 안 들어간다.
- 칸 작업 폴더 프로젝트 허용(`agent_chat_claude.allow_hub_tools`) — 앱 인계 보조로 유지. 사용자 `defaultMode`·기존 deny/ask·데스크톱 채팅 권한·MCP 독립 업데이트.
- **범위 밖(별도 큰 작업)**: 바깥 앱(Claude Code·Codex)에서의 화면 편집(캔버스 선택·노드 연결 등 `screen_action`). 지금은 칸의 진행 중 차례·화면 탭·현재 씬에 묶이고 일반 자격은 403(`mcp_v2.py:1549·1611`). 이 검사를 푸는 것은 연결 개선이 아니라 권한 모델 변경이라, "바깥 연결을 사용자가 고른 탭에 짧게 결합 + 계정·공간·씬 revision 검사 + 기존 화면 실행기로 전달" 설계가 따로 필요하다(Codex 추정 제품 6~10·시험 3~5 파일). 이번 완료 범위 = **바깥 앱 연결·조회·계획·생성·결과·명시적 캔버스 추가(`add_to_canvas`)**.

## 4. 남은 위험
- 유료 생성 도구까지 호스트가 매번 묻지 않는다 — [한 번에 연결] 안내·칸 정책과 같고 허브의 연결별 실행권·계정·공간 검사는 그대로.
- 사용자 전역 설정 두 파일을 바꾼다 — 백업 두 벌·프로세스 간 잠금·재대조·충돌/형식 오류 불변. 비협조 편집기와의 동시 저장은 남는다.
- 설정 반영이 모든 호스트·관리자 정책에서 무승인 실행을 보장하지는 않는다 — 최종 판정은 실제 도구 호출(5장 real).
- Codex 서버 표에 직접 키를 더한 사용자는 자동 재등록이 수동 안내로 바뀐다.

## 5. 완료 조건과 시험 (저장소 루트에서, `$py = D:/ClaudeCode/MV-hub-S-dev/.venv/Scripts/python.exe`)
- setup: `$py tools/mcp_adapter/test_local_setup.py` (어댑터 시험은 `PYTHONPATH` 에 `%LOCALAPPDATA%\MVHub-MCP\venv\Lib\site-packages`(+win32·win32\lib·pythonwin))
- link: `$py -m pytest -q -p no:cacheprovider -c backend/pytest.ini --rootdir backend -o pythonpath=D:/ClaudeCode/MV-hub-S-dev/backend backend/tests/test_mcp_persistent.py backend/tests/test_mcp_bridge.py`
- adapter: `$py tools/mcp_adapter/test_persistent.py` · `test_server.py` · `test_update.py` · 백엔드 `test_agent_chat_api.py test_agent_chat_runtime.py test_agent_chat_screen_actions.py test_mcp_update.py`
- ui: `npm.cmd --prefix frontend test -- --run tests/agentChatPanel.test.tsx tests/agentChatConnect.test.tsx tests/agentSettingsInstall.test.tsx tests/mcpQuickConnect.test.tsx tests/mcpRegistration.test.tsx` · 회귀 `tests/agentChatCook.test.tsx tests/agentChatImages.test.tsx tests/agentChatScreenContext.test.tsx tests/mcpCanvasTasks.test.tsx` · `npm.cmd --prefix frontend run lint:architecture` · `npm.cmd --prefix frontend run build`
- docs: `$py tools/check_code_map.py` · `$py tools/gen_inventory.py --check` · 백엔드 `test_docs_inventory_fresh.py`
- real(실측, MV 생성 크레딧 0 — Claude·Codex 구독 사용량은 든다): 격리 시험·독립 리뷰를 마친 뒤 dev 허브(8012)에서. R1 MV Agent 칸이 available 전환에서 agent-link 를 부르고(재호출·칸 다시 열기·분리 창에도) 연결 id·설정 지문 전후 비교 — `~/.claude/settings.json` 에 `mcp__mvhub-test`, `~/.codex/config.toml` mvhub-test 표에 approve, 기존 id 유지 · R2 칸 폴더 밖·프로젝트 허용 없는 새 폴더의 Claude Code(-p 기본 모드와 dontAsk 둘 다)에서 `check_connection`→`connect`(account 범위·실행권)→문법상 유효한 없는 UUID 로 `execute_generation_plan` → `userSettings` 허용, 허브 not_found(422·인증 거부·호스트 승인 거부는 실패) · R3 프로젝트 허용 없는 새 폴더로 넘긴 앱 대화(dontAsk)에서 같은 도구 → `userSettings` 허용(`mcp__mvhub_panel` 허용이 원인이 아님을 분리) · R4 새 폴더 `codex exec --sandbox read-only` 같은 순서 → 승인 거부 없이 허브 not_found(세션 메타데이터로 샌드박스 기록) · R5 실제 칸은 `mvhub_panel` 만, 일반 자격의 `screen_action` 거부 유지, 실측 전후 생성 제출 0. 검사 스크립트는 스크래치(저장소 밖)에서 실제 관측 자료(대상 지문·호스트 버전·호출 서버·허용 출처·구조화 오류·생성 미발행)를 읽어 판정한다 — 자기 선언 `passed` 를 믿지 않는다. 토큰·프로필 원문은 증거에 복제하지 않는다.

## 6. 검토 기록
- 설계 1판(Claude) → Codex 설계 확정 `01a1f7c2-fe1a-7c62-9745-1fedf388945e`(gpt-6-astra·high·읽기 전용): 수정 필요 — P1 7(기존 연결 재사용 검증·표식 상태·잠금 교착·계정 검사·Claude 충돌 범위·프로세스 간 잠금·Codex 보존) · P2 3(프런트 호출 키·안내문 지문/버전·화면 조작 범위) → 2판에 반영. 바꾼 판단: 실측 검사 스크립트는 저장소 대신 스크래치(제품 지문 밖) · 화면 조작은 범위 밖으로 확정(Jay 에게 후속 보고).
- 양측 합의 1차(계약 a25697e7): Codex(같은 세션 이어 받기) 보류 — P2 경로·DB 대조만으로는 프로필 없음·손상을 놓침 → `read_profile` 메모리 확인으로(2판의 '복호화 없음' 판단 철회). Claude 별도 세션 `6c80010b-424d-48ef-8dd3-5c89621fdc0e` 보류 — P2 로그아웃·비밀번호 변경 뒤 `linked`+자격 0개가 '다시 연결 필요'에 갇힘 → 재발급으로, 낮음 2(발급 전 `mcp_active_account`·기존 사용자 `linked` 기록) 반영. 둘 다 touched_paths 변경 없음 → 3판.
- 양측 합의 2차(계약 69258d96): Claude `6c80010b…` 동의(낮음: 살아 있는 자격 정의 한 곳). Codex 보류 — P1 `linked`+자격 0개 재발급이 최초 발급 권한(계정 전체·실행 허용)이면 제한 연결이 넓어지고 다른 계정 설정을 덮을 수 있음 → 이전 연결의 범위·실행권 계승·설정이 이전 연결을 가리킬 때만 → 4판.
- 양측 합의 3차(계약 3270f1c9): Claude `6c80010b…` 동의(낮음: 팀 공간 계승 때 `_workspace` 재확인). Codex 보류 — P1 비밀번호 변경으로 무효가 된 행을 해제하면 off 가 안 남아 자동 재발급이 해제를 뒤집음 → off 조건을 '미회수 행을 이번에 회수 + 회수 뒤 살아 있는 자격 0개'로 → 5판.
- **양측 합의 4차(계약 d9508acf) = 합의**: Codex `01a1f7c2…`(gpt-6-astra·high·read-only 이어 받기) "확정 가능, 남은 P1/P2 없음" · Claude `6c80010b…`(claude-opus-5-5·high·Read/Grep/Glob) 동의. 둘 다 VIBE-AGREE.

## 7. 구현·리뷰·실측·통합 기록
- **구현**: Codex 같은 세션 `01a1f7c2…` 이어 받기(요청·실제 gpt-6-astra·high·workspace-write = 작업실 `D:\ClaudeCode\work\mvagent-mcp-link-20261120` + `.tmp`), 26파일·범위 밖 0. 샌드박스 안 실패(대화형 사용자 검사·`node_modules/.vite-temp` EPERM·실행 정책·SDK 경로)는 총괄이 샌드박스 밖에서 다시 돌려 전부 통과. 총괄 재시험이 퇴행 1건을 잡음 — 설정 연결 구역에 새로 넣은 바깥 연결 단추 글자가 기존 Claude 상태 `다시 확인` 과 같아 시험·사용자가 엉뚱한 단추를 누름(`agentChatConnect` "연결 오류는 설정 안에…") → Codex 수정(`연결 다시 확인`, import 위치) → 통과. 커밋 `115e1894`, 최신 dev(2cc10c16 업스케일) 병합 `37181cbb`(겹친 파일 CODE_MAP 자동 병합, 코드맵·인벤토리 검사 통과).
- **독립 리뷰**: Claude 새 세션 `c60f4b38-f7d4-4e10-8aae-d720aa79944d`(claude-opus-5-5·high·Read/Grep/Glob, 설계·합의·구현 미참여) **PASS**(높음·중간 0). 낮음(반영 안 함·기록): L1 `_still_current` 계정 세대 검사가 칸 진행 중 같은 계정 다시 로그인 때도 연결을 끊음(보안상 이득·드묾) · L2 Codex·Claude 미설치로 보이면 칸 열 때마다 회수 행·`.bin` 이 쌓임 · L3 `recheckExternal` 이 off 결과를 안 지움, 상태 줄이 실제 호출 확인(`last_seen_at`)을 구분 안 함 · L4 `연결 안 됨` 영어 번역 없음 · L5 충돌 검사가 무관한 와일드카드(`mcp__other__*`)도 conflict(설계대로 보수적).
- **실측(dev 허브 8012, MV 생성 크레딧 0 — 실행 도구는 없는 UUID `00000000-0000-4000-8000-00000000c0de` 로만, 허브 not_found)**: 후보 파일을 dev 작업 트리에 꺼내 test_dev 재시작(8012 17:54:11·5173 17:54:16) 뒤.
  - R1 내장 브라우저에서 MV Agent 칸을 열자 `agent-link` 자동 호출(엔진별 2회) → Claude `1689dc79…`·Codex `dcfc24cd…` 같은 id `configured·access=allowed`. `~/.claude/settings.json` 에 `mcp__mvhub-test`(defaultMode auto 보존, `.mvhub-original` 이 이때 처음 생김), `~/.codex/config.toml` mvhub-test 표에 `default_tools_approval_mode = "approve"` 한 줄(10-16 옛 `.mvhub-original` 은 덮지 않음), 표식 `linked`. 새로고침 재호출 → `access=present`·두 파일 바이트 불변·id 그대로.
  - R2 칸 폴더 밖 프로젝트 설정 없는 새 폴더 Claude Code(`-p --permission-mode default`·`dontAsk` 둘 다): check_connection·connect(`connected:true`·account·실행권, 어댑터 `2026.11.20.1`)·execute 모두 `accept · rule · userSettings`, execute 는 허브 not_found.
  - R3 프로젝트 허용 없는 새 폴더로 넘긴 앱 대화(dontAsk, 세션 `b3bbd81c…`): 세 도구 `userSettings` 허용, execute not_found, 폴더에 `.claude` 없음(전·후).
  - R4 새 폴더 `codex exec --sandbox read-only`(rollout `sandbox_policy: read-only`, 스레드 `01a1f82b…`): check_connection·connect 완료, execute 는 승인 거부 없이 허브 not_found(고치기 전 같은 조건은 "requires approval, but approval policy is never").
  - R5 칸 실행 옵션(`--setting-sources local`·strict MCP·dontAsk)은 사용자 허용을 안 받아 거부(`mode:dontAsk`), 대조 `user,local` 은 `userSettings` 허용.
  - **R6 제품 경로 끝까지(통합 뒤, dev 5173)**: 내장 브라우저의 MV Agent 칸에서 새 대화("준비됐어요" 한 마디) → 제목 메뉴 [Claude 앱에서 열기] → 확인 창 [열기] → 앱에 넘어간 대화 `06544ae6…`(칸 작업 폴더, `permissionMode: dontAsk` 이어받음)에 연결 이름을 지정하지 않고 "MV Hub 에 연결해서 공간 목록, 같은 연결로 없는 계획 실행"을 시킴 → 앱 대화가 두 연결 모두 `check_connection`(`mvhub` 8010 = unavailable·어댑터 옛 판 2026.11.14.1, `mvhub-test` 8012 = available) 뒤 응답하는 `mvhub-test` 를 골라 connect(account·실행권)·`read_context` 공간 목록(개인 1+팀 9)·`get_plan`/`execute_generation_plan`(not_found) — 전부 묻지 않고 `accept · rule`(mvhub-test = userSettings). 자료 `link_real_evidence\e2e.json`. 연결 고르기 안내가 의도대로 동작("응답한 곳이 하나뿐이라 묻지 않았다").
  - 판정 스크립트·자료 = 스크래치 `hub_tools\link_real.py`(sha256 앞 16 `dcfb7745296b9ccc`)·`link_real_evidence\*.json` — 보존은 작업실 보관 폴더로. 첫 판정에서 R2 가 실패로 나온 것은 스크립트 버그(같은 결과의 `api-request-blob` 사본 줄이 판정 줄을 덮음·`"connected":true` 띄어쓰기 패턴)였고, 세션 기록을 다시 실행하지 않고 고친 판정기로 다시 읽어 통과.
- **시험 기록(run-test, dev 작업 트리 = 후보 지문 6b9bdf47)**: setup 1 · adapter 5 · link 5(필수 2 + 고친 모듈을 쓰는 추가 29파일을 3묶음) · ui 3(MV Agent·MCP 11파일 260개·lint:architecture·build) · docs 3 · real 1 — 18개 모두 exit 0·stable. 그 밖에 총괄 확인: 번역 관련 프런트 48파일 1,181개 통과.
- **통합**: `check --stage integrate --revision 37181cbb…` 통과 → 같은 명령에서 스테이징 빈 것 확인 → 담당 26파일 add → `merge --ff-only` → dev `37181cbb`. dev 허브는 꺼낸 시점부터 이 코드로 실행 중(재시작 불필요).
- **남은 것·후속**: ① 바깥 앱(Claude Code·Codex)에서의 화면 편집(`screen_action`)은 범위 밖 — Jay 기존 요구('mv hub 컨트롤')의 후속으로 보고(별도 큰 작업). ② 설치본(`mvhub`, 8010)·팀 PC 는 이 기능이 든 릴리스로 앱 업데이트해야 적용(MCP 독립 업데이트만으로는 안 됨). ③ 위 낮음 L1~L5. ④ 작업실 `mvagent-mcp-link-20261120`·브랜치 `codex/mvagent-mcp-link`·앱 시험 대화(f5 `92dec522`, r3 `b3bbd81c`) 정리.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-mcp-agent-link-2026-11-20",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1f7c2-fe1a-7c62-9745-1fedf388945e"},
  "risk": {"level": "major", "reason": "사용자 전역 설정(~/.claude/settings.json·~/.codex/config.toml)에 MV Hub MCP 도구 허용·승인 방식을 쓰고, MV Agent 연결 때 계정 범위·실행 허용 MCP 자격을 자동 발급한다(유료 생성 도구까지 호스트가 묻지 않음) · 등록·해제·로그아웃 동시성"},
  "goal": "MV Agent 에서 Claude·Codex 엔진을 연결하면 같은 PC 의 Claude Code·Codex(와 Claude 앱으로 넘긴 대화)에서 MV Hub MCP 의 조회·계획·생성·결과·캔버스 추가를 추가 승인 없이 바로 쓰게 한다. 등록 때 호스트 허용(Claude 사용자 allow·Codex approve)까지 하고, 이미 등록된 연결은 재발급 없이 허용만 맞추며, 사용자가 해제한 연결은 다시 붙이지 않는다. 같은 PC 의 두 MV Hub 연결 중 응답하는 허브를 고르게 안내한다. 칸 실행·자격 격리와 바깥 앱 화면 편집 제한은 그대로 둔다.",
  "touched_paths": [
    "tools/mcp_adapter/local_setup.py",
    "tools/mcp_adapter/test_local_setup.py",
    "tools/mcp_adapter/server.py",
    "tools/mcp_adapter/test_persistent.py",
    "tools/mcp_adapter/README.md",
    "backend/app/routers/mcp_v2.py",
    "backend/app/repo/mcp_v2.py",
    "backend/app/routers/auth.py",
    "backend/tests/test_mcp_persistent.py",
    "frontend/src/lib/agentChatApi.ts",
    "frontend/src/lib/useAgentChat.ts",
    "frontend/src/lib/i18n.ts",
    "frontend/src/components/agent-chat/AgentPanel.tsx",
    "frontend/src/components/agent-chat/AgentSettings.tsx",
    "frontend/src/components/agent-chat/AgentConnect.tsx",
    "frontend/src/components/mcp/McpQuickConnect.tsx",
    "frontend/src/components/mcp/McpRegistration.tsx",
    "frontend/tests/agentChatPanel.test.tsx",
    "frontend/tests/agentChatConnect.test.tsx",
    "frontend/tests/agentSettingsInstall.test.tsx",
    "frontend/tests/mcpQuickConnect.test.tsx",
    "frontend/tests/mcpRegistration.test.tsx",
    "docs/CODE_MAP.md",
    "docs/MCP_INTEGRATION.md",
    "docs/inventory/endpoints.md",
    "docs/inventory/db_tables.md"
  ],
  "criteria": [
    {"id": "setup", "success": "Claude 사용자 허용 병합(새로 만듦·병합·멱등 바이트 불변·deny/ask 광역 충돌 불변·형식 오류·중복 키·과대 파일 불변·CLAUDE_CONFIG_DIR manual·백업 두 벌과 백업 실패 시 불교체·원본 재대조·프로세스 간 잠금), 데스크톱 등록은 Claude Code 허용을 안 씀, Codex 새 등록 approve·다른 승인 값 보존·재등록과 구 항목 제거의 추가 키·하위 표 fail-closed·ensure_access 한 줄 삽입의 정확한 파싱 대조와 모호 구문 manual·제한 보존 표시, ensure_access 의 경로·read_profile 메모리 확인(url·hub_id·client_id·비밀값 해시·DB 행·비밀번호 변경 시점) 대조, 프로필 없음·손상·내부 id/해시 불일치면 설정 불변 reconnect, 재발급 없음 시험 통과", "failure": "시험 실패 또는 사용자 설정을 덮거나 지우는 경로 존재", "required": true, "verification": ["95116c927a3f4b87bed902c2555ebe0c"]},
    {"id": "link", "success": "agent-link: 기대 계정·identity_key·허브 신원 불일치 거절, 최초 발급과 linked 표식(발급 전 mcp_active_account), 살아 있는 맞는 자격은 같은 id 유지하며 허용만(표식 없던 기존 사용자는 linked 기록), 제한 자격 비확대, off 는 아무것도 안 건드림, 명시적 해제가 미회수 행을 회수하고 같은 클라이언트 살아 있는 자격이 0개일 때만 off(비밀번호 변경으로 무효였던 행의 해제 포함 — 비밀번호 변경→명시적 해제→agent-link 에서도 off 유지·재발급 없음, 옛 id 재해제·내부 정리·재등록 회수·칸·로그아웃은 off 아님), 팀 공간 범위 계승 때 _workspace 재확인, 로그아웃→재로그인→자동 재발급·명시적 해제→재로그인→off 유지, linked+자격 0개는 이전 연결의 공간 범위·실행권을 물려받아 재발급(제한 연결은 로그아웃·재로그인 뒤에도 제한 유지)·설정이 다른 계정 연결로 바뀌었거나 이전 행을 확인 못 하면 설정 불변 다시 연결 필요, 살아 있는 자격 정의 한 곳(revoked_at·소유자·계정·비밀번호 변경 시점), retry 재시도, 회수 이력만 있거나 살아 있는 자격이 설정과 안 맞으면 다시 연결 필요, 수동 configure 성공 시 linked, RLock 직렬화와 로그아웃 경합·계정 세대, 취소·부분 실패 시험과 기존 MCP 시험 묶음 통과", "failure": "시험 실패 또는 해제한 연결 재발급·열린 연결 회수·다른 계정 쓰기 경로 존재", "required": true, "verification": ["7457115459e44d399e75371024dfd1d8", "1b5c493d05124c458d2c3196f0fea793", "b11618ae753d474eb91d186566683f99", "8c5aabe0e8954100ba78350e275f39fc", "e7e04a32ce2440809a1aa3349d3682d3"]},
    {"id": "adapter", "success": "일반 안내문에 두 연결 고르기 문장(check_connection→connect, 둘 다 응답 시 사용자 확인)과 ADAPTER_VERSION 2026.11.20.1, CONVERSATION_SURFACE_SHA256 의도한 갱신, 칸 안내·도구 목록 불변, 업데이트 선택 계약 불변, 칸 API·실행 옵션·화면 조작 제한 회귀 시험 통과", "failure": "시험 실패 또는 칸 표면·업데이트 계약 변경", "required": true, "verification": ["7eca63f8466d42ce8a4d554c34fe3731", "6c2069aee9ee4d4b9f406901a3979144", "78fa264cec694f2b92c2087f247241d4", "198f60aeb5174ea8992f81dd4a0e08dc", "18b181b3bba242b1a2f578ca9b3f5bf9"]},
    {"id": "ui", "success": "useAgentChat 이 엔진 available 에서 계정·토큰 세대·identity_key·엔진당 한 번 agent-link 호출(StrictMode·엔진 추가·늦은 응답·계정 변경·실패 후 [다시 확인]·off 유지), MV Agent 설정 연결 상태 한 줄과 동의 문구, McpQuickConnect·McpRegistration 의 access 표시와 실패를 가리지 않는 우선순위, 관련·회귀 시험, lint:architecture, build 통과", "failure": "시험·검사·빌드 실패 또는 칸 대화가 바깥 연결 실패에 막힘", "required": true, "verification": ["de5a4f2da51a43b79f6892f9e40a73f9", "61eeb259b47a41f287a767db9a484ec8", "28fb85275b2a4b52bc6a4a2ec536d8bc"]},
    {"id": "docs", "success": "check_code_map·gen_inventory --check·test_docs_inventory_fresh 통과(생성 결과는 생성기로만)", "failure": "목록·코드맵 낡음", "required": true, "verification": ["26bf78f869f046bcbe81c7b22712d72e", "9dde71061903405292cb9618c3628cbb", "36f1209326764f75a845528099dee728"]},
    {"id": "real", "success": "dev 허브(8012) 실측(MV 생성 크레딧 0): R1 칸 available 전환의 agent-link 실호출로 사용자 설정에 mcp__mvhub-test 허용·Codex mvhub-test 표 approve·기존 연결 id 유지(재호출·칸 다시 열기·분리 창 포함) · R2 칸 폴더 밖 새 Claude Code(-p 기본·dontAsk)에서 check_connection→connect→없는 UUID execute_generation_plan 이 userSettings 규칙으로 허용되어 허브 not_found · R3 프로젝트 허용 없는 새 폴더로 넘긴 앱 대화(dontAsk)에서 userSettings 허용 · R4 새 폴더 codex exec --sandbox read-only 에서 승인 거부 없이 허브 not_found · R5 칸은 mvhub_panel 만·일반 자격 screen_action 거부 유지·생성 제출 0 — 스크래치 검사 스크립트가 실제 관측 자료로 판정", "failure": "어느 경로든 호스트 승인 거부·다른 출처 허용·연결 id 변경·칸 표면 변경·생성 제출 발생 또는 실측 미완료", "required": true, "verification": ["df8c26aeb05a43b5a311cdb7ea33212d"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "등록 때 호스트 허용까지 쓴다: Claude 는 사용자 설정 permissions.allow 에 서버 전체 규칙 mcp__<서버 이름> 하나, Codex 는 그 서버 표에 default_tools_approval_mode=approve", "why": "Jay 요구는 MV Agent 연결 뒤 Claude Code·Codex 어디서든 다른 MCP 처럼 바로 쓰기다. 등록기가 서버 정의만 쓰고 허용을 안 써서 dontAsk 인계·제한 샌드박스 Codex 에서 막혔다(실측). 사용자 범위 규칙은 모든 프로젝트·dontAsk 에 적용되고(공식 문서), approve 는 칸이 이미 쓰는 값이다. 서버 전체 규칙은 MCP 독립 업데이트로 도구가 늘어도 다시 막히지 않는다", "alternative": "도구별 허용 목록(업데이트마다 갱신 필요) / 칸 작업 폴더 프로젝트 허용만(일반 세션 미해결) / 사용자가 매번 승인(요구와 반대)", "revisit": "호스트가 MCP 서버별 공식 허용 등록 방법을 주거나 MV Hub 도구에 별도 승인이 필요한 고위험 도구가 생기면"},
    {"choice": "이미 등록된 연결은 재발급하지 않고 허용만 맞추며, 서버 항목의 --url·프로필 경로가 맞고 기존 read_profile 로 메모리에서만 연 프로필의 url·hub_id·client_id·비밀값 해시가 이 계정의 살아 있는 같은 이름 연결 DB 행(소유자·계정·비밀번호 변경 시점 포함)과 맞을 때만 그렇게 한다", "why": "재발급은 같은 이름 앞 연결을 회수해 열려 있는 Claude·Codex 를 끊는다. 경로·DB 행만으로는 파일 없음·손상을 놓쳐 쓸 수 없는 연결을 연결됨으로 본다(Codex 합의 P2). 기존 함수를 재사용하고 비밀값은 메모리 밖으로 내지 않는다", "alternative": "매번 재발급 / DB 행만 보고 판정 / 경로만 대조", "revisit": "없음"},
    {"choice": "MV Agent 의 엔진 available 전환에서 새 agent-link API 로 claude→claude, codex→codex 바깥 연결을 맞추고, app_setting 표식 linked/off/retry 로 명시적 해제를 존중한다(명시적 해제가 미회수 행을 회수하고 같은 클라이언트 살아 있는 자격이 0개일 때 off — 비밀번호 변경으로 무효였던 행 포함)", "why": "Jay 요구 'mv agent 연결하면 mcp 연결된 것처럼'. 해제한 연결을 자동으로 되살리면 사용자 선택을 뒤집는다. 실패·로그아웃·재등록 회수를 해제로 오인하지 않게 상태를 나누고, linked 인데 살아 있는 자격이 0개면(로그아웃·비밀번호 변경) 해제가 아니므로 다시 발급해 '바로' 쓰는 상태를 유지하되(Claude 합의 P2), 이전 연결의 공간 범위·실행권을 그대로 물려받고 실제 설정이 그 이전 연결을 가리킬 때만 한다 — 제한 연결이 로그아웃만으로 계정 전체 실행 허용으로 넓어지거나 다른 계정 설정을 덮지 않게(Codex 합의 P1). 새 표·마이그레이션 없이 기존 키-값 저장을 쓴다", "alternative": "칸 연결 자격을 바깥 앱에 공유(차례·계획·화면 경계 붕괴) / 매 화면 열기마다 무조건 등록 / 사용자가 MV·MCP 연결 창에서 따로 누르기(지금)", "revisit": "MV Agent 엔진에 Claude·Codex 밖의 호스트가 더해지면"},
    {"choice": "_registration_lock 을 RLock 으로 바꿔 configure·agent-link·명시적 revoke·로그아웃 회수를 직렬화하고 계정 세대를 쓰기 전후 재확인, 설정 파일은 정규화 경로 기준 Windows 이름 붙은 뮤텍스 안에서 백업 두 벌 뒤 원본 재대조 교체", "why": "기존 비재진입 Lock 안에서 _register_client 를 부르면 교착된다. 설치본·dev 두 허브가 같은 사용자 설정을 고칠 수 있다. 원본 재대조만으로는 프로세스 간 경쟁을 못 막는다", "alternative": "잠금 없이 재시도 / 새 잠금 파일", "revisit": "없음"},
    {"choice": "같은 PC 의 두 MV Hub 연결은 어댑터 일반 안내문으로 check_connection→connect 로 응답하는 허브를 고르고 둘 다 응답하면 사용자에게 확인하게 한다(ADAPTER_VERSION 2026.11.20.1)", "why": "인계 대화가 꺼진 8010 의 mvhub 를 골랐다. 허브별 이름은 이미 다르고, 대화마다 상태를 남기거나 설정을 뒤집는 것보다 안내문 한 문장이 작고 두 호스트에 같이 적용된다", "alternative": "인계 때 다른 서버를 deny 로 숨김(두 허브가 같은 작업 폴더라 서로 뒤집음) / 대화별 허브 표식 파일", "revisit": "Claude 앱이 인계 세션에 연결 선택을 넘기는 방법을 주면"},
    {"choice": "칸 실행 옵션·mvhub_panel 자격·칸 작업 폴더 프로젝트 허용은 그대로 두고, 바깥 앱 화면 편집(screen_action)은 이번 범위 밖으로 둔다", "why": "칸은 strict MCP·setting-sources local 이라 사용자 허용이 안 들어간다. 바깥 화면 편집은 탭·씬 결합 권한 모델 변경이라 별도 큰 작업이다(Codex 추정 제품 6~10 파일)", "alternative": "이번에 화면 편집까지(범위·위험 급증)", "revisit": "Jay 의 기존 요구('mv hub 컨트롤')의 후속 범위로 보고하고 Jay 가 확정하면"}
  ],
  "evidence": {"target": {"kind": "revision", "revision": "37181cbbf88da9037ac5830c1e548342ab70b63d"}, "consensus": [
    {"host": "codex", "session": "01a1f7c2-fe1a-7c62-9745-1fedf388945e", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/20/rollout-2026-11-20T16-01-54-01a1f7c2-fe1a-7c62-9745-1fedf388945e.jsonl"},
    {"host": "claude", "session": "6c80010b-424d-48ef-8dd3-5c89621fdc0e", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools/6c80010b-424d-48ef-8dd3-5c89621fdc0e.jsonl"}
  ], "review": {"host": "claude", "session": "c60f4b38-f7d4-4e10-8aae-d720aa79944d", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-review-link/c60f4b38-f7d4-4e10-8aae-d720aa79944d.jsonl"}, "design_sessions": [
    {"host": "codex", "session": "01a1f7a7-461c-7832-bbd9-d94a1a68a136"},
    {"host": "codex", "session": "01a1f7c2-fe1a-7c62-9745-1fedf388945e"}
  ]}
}
```
