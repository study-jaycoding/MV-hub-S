---
status: active
updated: 2026-11-21
---

# 바깥 앱(Claude Code·Codex)에서 MV Hub 화면 편집 — MCP screen_action 을 일반 연결에도 (2026-11-20)

owner: Codex(구현) · Claude(설계·총괄) · reviewer: Codex(설계 확정) · Claude 별도 세션(독립 리뷰) · status: 완료(dev 513e49df 반영, 낮음은 [낮음 정리](MVAgent_MCP바깥화면편집_낮음정리_2026-11-20.md)) · updated: 2026-11-21
선행 기록: [MV Agent·MCP 한 번에 연결](MVAgent_MCP한번에연결_2026-11-20.md)(dev 37181cbb — 바깥 연결·허용) · [MV Agent 화면 동작](MVAgent_화면동작_2026-11-12.md)(칸 전용 screen_action 의 원래 설계)

## 1. 요청
- Jay(11-20): "mv agent를 통해 ai와 연결하면 mv hub나 클로드코드, 코덱스에서도 다른 mcp사용하듯이 바로바로 생성이나 **mv hub컨트롤**이 되어야한다." → /goal "완벽한 mv agent와 mcp연동".
- 앞 묶음(37181cbb)에서 바깥 앱 화면 편집은 범위 밖으로 뒀고, Jay 가 11-20 질문에 **"이번에 만들기"**(릴리스는 "지금은 dev 만")로 답했다.

## 2. 근거 (Claude 직접 확인 + Codex 설계 확정 `01a1f849-912c-7cb0-b22d-ca17d956a925` 대조)
- 지금 화면 동작은 칸 전용: 어댑터는 `panel` 일 때만 `screen_action` 등록(`tools/mcp_adapter/server.py:1328`), 허브는 칸 연결이 아니면 403(`backend/app/routers/mcp_v2.py:1705-1708`). 칸 흐름은 차례에 탭·공간·씬을 고정 → `_SCREEN_ARGS` 검증 → `issue_action`(차례 사건) → 그 칸 탭만 claim(토큰) → 결과(`mcp_v2.py:1643-1678`, `services/agent_chat.py:819-896`).
- 실행기는 앱 전체에서 재사용 가능: `frontend/src/lib/agentScreenActions.ts` `runScreenAction`·`undoScreenAction`, App 수준 `agentScreenHost`(`App.tsx:2299`).
- 실시간 통로: 웹소켓 `/ws`(`main.py:1403`), `ws.py` `broadcast(message, account_uid)` — AUTH 켬은 `realtime_scope(account)`(이메일 기반) 정확 일치만, **AUTH 끔은 모든 로컬 소켓이 같은 범위(None)를 공유**(`ws.py:215`, `deps.py:150`). 앱은 WS 를 `progressSocket.ts` 로 받는다(App 이 직접 파싱 안 함, `App.tsx:985`). `useAppToast` 는 2.5초 단일 표시(`useAppToast.ts:6`).
- `mcpTabId()` 는 호출마다 새 값을 만드는 함수(`mcpTab.ts:4`) — 창 공용 번호·실행 자격이 아니다. `_app_context` 의 `X-MVHub-Tab` 은 형식만 본다(`mcp.py:85`).
- 비동기 통로 `add_to_canvas`(캔버스 대기 작업)는 화면을 열 때 붙여 실시간 `read_selection` 에 못 쓴다.

## 3. 설계 (3판 — Codex 설계 확정 반영 · 3-8 가려진 창도 대상)

### 3-1. 수신 창 등록(presence) — 서버 발급 자격, 메모리만
- 새 서비스 `backend/app/services/mcp_screen.py` 가 바깥 연결의 화면 수신 창·대상·동작 수명만 소유한다(칸 상태기계와 공유하지 않음 — 가짜 차례 없음).
- 앱 본창이 화면 제어를 켰고 보일 때 `POST /api/mcp/v2/app/screen-presence` 로 처음 등록 → 서버가 불투명 `receiver_id` 와 무작위 `receiver_secret` 을 발급(창 메모리에만, 서버엔 해시만, WS·MCP 결과·저장소·로그에 안 남김). 등록은 서버 신원·DB 세대·계정·인증 세대·앱 세션에 묶이고 로그아웃·재로그인·DB 교체·허브 재시작이면 무효 → 새 등록.
- 갱신(heartbeat): 보이고 켜진 본창만 10초마다(정상 상태 탭당 분당 약 6회 — 계산값), 공간·씬·보임·켬이 바뀌면 짧게 합쳐 즉시. 본문 `{receiver_id, secret, seq, workspace, scene_id|null, visible, enabled}`, 증가 `seq` 로 늦게 온 갱신이 최신 끔을 못 덮는다. 갱신은 발급 자격·세션 결합·계정/DB 세대만 확인(매번 `/auth/me` 상류 호출 안 함) — heartbeat 만으로 실행을 허가하지 않는다. 숨김·끔·로그아웃은 로컬에서 즉시 실행을 막고 서버에 통보(유실 시 TTL 25초가 마지막 방어). 창당 요청 하나·실패 시 백오프·숨김/끔에선 주기 중지.
- `scene_id` 는 `agentScreenHost.scene()` 의 보드와 실제 화면이 일치할 때만(App 의 activeScene 만으로 판단하지 않음). 본창에 캔버스가 없거나 분리 창이면 null.
- 상한: 계정당 16·서버 128 등록, 만료 자료는 진입 시 정리(상주 청소 스레드 없음). presence·claim·result 경로는 변경 알림(mutation notify) 제외, `screen_action` 은 `_LIBRARY_READ_METHODS` 의 '서버 라이브러리 불변' 분류.

### 3-2. 대상 창 고르기
- 그 계정의 켜짐·보임·유효 본창이 **하나면** 그 창. **여럿이면 자동 선택하지 않고 `screen_ambiguous`** 로 거절하고, 사용자가 설정의 **[이 창 사용]** 으로 정한다(명시 선택은 그 수신 창에 묶이고 heartbeat 순서로 바뀌지 않음, 그 창이 숨거나 닫히면 다른 창으로 옮기지 않음). 없으면 "MV Hub 화면이 열려 있지 않거나 화면 제어가 꺼져 있어요".

### 3-3. 지금 화면 읽기와 화면 표
- 일반 연결의 `read_context(kind='screen')` = 대상 창의 `workspace {scope,id}`·`scene_id|null`·**30초·일회용 `screen_context`**·유효시간만. 씬 제목·다른 창 목록·자격·다른 공간 이름·선택 카드 내용은 싣지 않는다(선택은 `canvas.read_selection` 으로만). 대상 없음·범위 밖 응답에도 다른 화면 정보를 붙이지 않는다. 고정 공간 자격은 `_request_workspace` 로 그 공간만. 칸 자격의 `read_context(screen)` 은 거절.
- `screen_context` 는 연결·수신 창·공간·씬·**화면 세대**에 묶인다. 화면 세대는 공간·씬·켬·보드 해제·인증 변화마다 오른다(3판: 보임↔숨김 전환은 올리지 않음 — 3-8. A→B→A 도 옛 표를 되살리지 않음 — 씬 문서 저장 revision 과는 다르다).

### 3-4. 바깥 연결의 screen_action (허브)
- 일반 연결(영속 프로필 있는 연결만, 구형 6자리 브로커 제외)의 `screen_action(name, args, screen_context)` — `screen_context` 필수, 동작마다 직전에 화면을 다시 읽는다. 칸 경로(`_panel_screen_action`·칸 issue/claim/finish/expire·칸 엔드포인트·`useAgentChat` 실행)는 바꾸지 않는다.
- 검사(발급·claim·결과 수락·MCP 응답 반환 전마다): 원래 연결의 회수 여부·계정·비밀번호·허브·DB 세대·공간 권한 재확인. 새 앱 경로는 `X-MVHub-Expect-Account` 필수. `can_execute=False` 일반 자격은 `read_context(screen)`·`canvas.read_selection` 만, 세 변경 동작은 403(칸의 예외 실행권은 그대로). 공간은 `_request_workspace`(고정 공간 자격을 넓히지 않음). 캔버스는 현재 계정에 그 씬이 저장돼 있고 공간에 맞을 때만(아직 저장 확인 안 된 새 씬은 거절). `library.set_hidden` 은 `_owned_generation_ids` 재사용(없음·타인·다른 공간 구별 안 함). 인자 검증은 `_SCREEN_ARGS`.
- 한도: 계정당 진행 중 1개·서버 8개(넘으면 즉시 busy). 60초 이동 창으로 연결별·계정별 각각 create_nodes 10·connect 20·set_hidden 100, 요청 빈도 연결당 30회/분·계정당 60회/분. 발급한 양은 실패·만료에도 돌려주지 않는다.
- 전달: WS 는 **깨우기만** — `{"type":"mcp_screen_action","receiver_id","action_id"}`(이름·인자·씬·공간 이름·클라이언트 이름·자격 없음). AUTH 켬은 `realtime_scope(ctx.account)` 로만(`broadcast_all` 금지), AUTH 끔은 다른 로컬 소켓에도 깨우기가 갈 수 있음을 명시하고 내용 미전송 + HTTP 자격 검사로 실행·정보 접근을 막는다(기존 `/ws` 인증 구조는 이번에 바꾸지 않음). 실제 명령은 `POST /api/mcp/v2/app/screen-actions/{action_id}/claim`(앱 인증 + 수신 자격 + 기대 계정) 응답으로만, 처음 한 번 토큰. 결과 `POST …/result` `{token, ok, summary, data}`.
- 상태: `pending → claimed → done/failed`, 미선점 만료 `expired_unclaimed`, 선점 뒤 결과 없음 `unknown`, 결과·만료는 같은 잠금에서 한 번만 확정, 늦은 결과·재사용 토큰·중복 claim 은 실행·성공을 만들지 않음, 요청 취소 시 미선점은 닫고 선점은 불명, 재연결·재시작 뒤 자동 재실행 없음. 종료 기록 60초·서버 256개 상한. claim 뒤 이미 시작한 화면 명령을 권한 회수로 소급 취소한다고 약속하지 않는다(claim 이 실행 허가 경계).
- 기능 표식 `external_screen` 을 health·앱 기능 응답에 추가 — 구형 허브는 업데이트 필요를 명시적으로 돌려준다.

### 3-5. 앱 화면
- 기존 WS 하나에서 새 깨우기를 `APP_EVENTS` 로 전달(새 WS 연결 없음). App 수준 훅 `useMcpScreenActions` 가 등록·claim·실행·영수증을 맡는다(칸을 안 열어도 동작). claim 응답 뒤 실제 명령 직전에 현재 세대·보임·켬·계정·공간·보드 `sceneId` 를 다시 확인하고, claim 대기 중 칸·사용자 편집이 있었으면 전후 지문을 비교해 거절. 실행은 `runScreenAction(name, args, agentScreenHost)`(동기 실행기라 칸 명령과 중간에 섞이지 않음).
- 알림: 즉시 토스트와 별도로 닫을 수 있는 **최근 화면 동작 알림 목록**(최대 20개, 자동으로 안 사라짐, 새 `McpScreenNotice`) — "Claude Code 가 캔버스에 카드 2개를 만들었어요 [되돌리기]". 영수증은 서버 결과 전송보다 먼저 보관(전송 실패를 화면 변경 실패로 바꾸지 않음). 되돌리기는 기존 씬 지문·회색 표식 검사 + 계정·허브·공간 확인, 실패하면 이유를 남김. `undo` 자료는 서버에 안 보냄. 성공 = 화면 실행 결과(영구 저장 완료까지 넓히지 않음).
- **화면 제어 스위치: 기본 끔**(저장값 없음·손상·미확인 허브 = 끔). 한 번 켜면 브라우저 origin·허브 ID·계정별로 유지(토큰은 저장 안 함), 다른 탭은 `storage` 알림과 실행 직전 저장값 확인으로 끔을 반영, 저장 실패면 켜졌다고 표시하지 않음. 위치: MV Agent 설정 › 연결(상태 줄 옆)과 MV·MCP 연결, 여러 창이면 [이 창 사용].
- 동의 문구(AgentConnect·AgentSettings·McpQuickConnect·McpRegistration·영어 사전 통일): "화면 제어를 켜면 연결된 바깥 앱이 허용한 MV Hub 창의 현재 공간·씬과 선택 카드 일부를 읽고, 빈 카드·연결·내 생성물 회색 표시를 바꿀 수 있어요. 화면 동작은 MV 생성 크레딧을 쓰지 않아요. 생성 요청에는 기존 크레딧 규칙이 적용돼요."

### 3-6. 어댑터
- 영속 프로필 일반 연결에만 `screen_action`(인자에 `screen_context` 추가)·`read_context` kind `screen` 노출. 칸 도구 이름·설명·스키마·안내문은 그대로(칸 전체 표면은 별도 고정 지문으로 보호). 일반 도구 수 native 16·conversation 15 를 실제 목록과 대조. `ADAPTER_VERSION = "2026.11.20.2"`, 일반 표면 지문(`CONVERSATION_SURFACE_SHA256`)은 의도한 차이만 확인 후 갱신, 독립 어댑터 업데이트의 기능 요구(`external_screen`) 시험. `local_setup.py`·사용자 전역 설정은 안 바꾼다.

### 3-7. 바꾸지 않는 것 · 판단
- 칸 화면 동작(차례 고정·claim·한도)·칸 실행 옵션·`mvhub_panel`, 유료 생성 규칙, 캔버스 대기 작업, WS 매니저·`mcpTab`·`mcpCanvasTasks`(회귀 검증만).
- Claude 확인(Codex 요청): 기본 끔·여러 창일 때 명시 선택·`screen_context` 필수 — 셋 다 채택. Jay 의 "바로바로"와는 처음 한 번 켜기만큼 다르지만, 앞 묶음 동의에 화면 편집이 없었고 팀원 PC 에 조용히 켜지 않는 쪽을 택했다(Jay 에게 보고).
- AUTH 끔은 악성 로컬 프로세스·같은 origin 침해까지 막는 경계가 아니다. 이번 보장은 다른 창의 식별자만으로 명령을 가져가거나 실행할 수 없게 하는 범위다.

### 3-8. 3판 변경 — 가려진 창도 대상 (Jay 11-20 결정, 위 3-1·3-2·3-3·3-4·3-5 의 '보임' 조건을 이 절이 대신한다)
- 근거(실측): 2판대로 '보이는 창만' 받게 하니, Claude 앱 안 브라우저 창이 가려지자 탭이 숨김(`visibilityState=hidden`)이 되어 heartbeat 가 멈추고 25초 뒤 `screen_unavailable`(실측 자료 `claude_hidden`). Windows Chrome 도 창이 완전히 가려지거나 최소화되면 숨김으로 본다 — Claude 앱·터미널을 앞에 두고 쓰는 흔한 모습에서 화면 편집이 안 된다. Jay 결정(11-20 질문): **"가려져도 되게"**.
- 대상: 화면 제어를 **켠** 유효 본창이면 보임 여부와 무관하게 대상(가려짐·뒤에 있음·최소화 포함 — 브라우저가 최소화와 가려짐을 믿을 만하게 구별해 주지 않고, 켜기 스위치·알림 목록·되돌리기로 동의·회복은 이미 보장). 여럿이면 지금처럼 `screen_ambiguous` + [이 창 사용].
- heartbeat: 켜진 본창은 숨김이어도 계속 보낸다(목표 10초). 숨은 탭은 브라우저가 타이머를 늦춘다(길게 숨으면 1분에 한 번까지) → 수신 창 유효시간(TTL)을 **150초**로(보임·숨김 같게, 닫힌 창이 남아도 동작은 claim 없이 30초에 `expired_unclaimed` 로 안전하게 끝남). 깨우기는 WS 메시지(타이머 억제 대상 아님)로 받아 즉시 claim.
- 화면 세대: **보임↔숨김 전환은 세대를 올리지 않는다**(공간·씬·켬·보드 해제·인증 변화만). 창을 오가도 화면 표·진행 중 동작이 깨지지 않게. claim 뒤 실행 직전 확인에서도 '보임' 조건은 뺀다(켬·계정·공간·씬·세대·대기 중 편집 지문은 그대로).
- 숨은 창에서 실행되면 사용자가 바로 못 보므로: 알림 목록(최대 20, 되돌리기)에 그대로 남기고, 창이 다시 보이면 "가려진 동안 바깥 앱이 화면을 N번 바꿨어요" 한 번 알린다.
- 동의 문구에 "창이 가려져 있거나 최소화돼 있어도"를 더한다(4곳·영어 사전).
- 바뀌지 않는 것: 기본 끔·명시 선택·화면 표(30초 일회용·세대)·자격 재확인·한도·칸 경로·WS 내용 없음.
- (3판 재합의 보강) **정지된 창의 늦은 실행 막기**: 브라우저가 숨은 탭을 얼리면(frozen) 타이머·fetch 콜백도 멈춰 "claim 승인 → 창 정지 → 서버 만료 → 창 재개 → 늦은 응답으로 화면 변경"이 가능하다(Codex 3판 합의 P2). → claim 응답에 **남은 실행 시간**(서버 기한까지 ms)을 싣고, 창은 요청 보낸 때부터 지난 시간을 보수적으로 빼서 실행 직전에 0 이하면 실행하지 않는다(결과도 성공으로 안 보냄). 문구 한정: 일반 숨김에서는 수신을 계속 시도하되, 브라우저 정지·폐기 중에는 실행을 보장하지 않으며 만료된 동작을 재개하지 않는다.
- (3판 재합의 보강) **창을 떠날 때 바로 해제**: TTL 이 150초로 길어져 새로고침·닫기 뒤 옛 수신 창이 남으면 새 창과 겹쳐 `screen_ambiguous` 가 난다(Claude 3판 합의 P2). → `pagehide` 에서 `fetch(..., {keepalive: true})` 로 해제(끔 통보와 같은 경로, 수신 자격 포함 — 3판에서 숨김은 해제가 아니다)를 보내고, 뒤로가기 캐시에서 복원되면(`pageshow` persisted) 다시 등록하며, 서버는 해제된 수신 창을 대상·모호 판정에서 즉시 뺀다. 이 요청이 유실될 때만 TTL 이 마지막 방어.
- 창이 여럿이면 새로고침마다 [이 창 사용]을 다시 골라야 한다(비밀값을 창 메모리에만 두는 원칙의 비용 — 문서에 적는다). 숨은 탭은 requestAnimationFrame 이 멈추므로 "카드 만들기 → 그 id 로 연결"이 숨김에서도 되는지는 실측(screen-real)으로 확인한다.

## 4. 남은 위험
- 바깥 AI 가 사용자의 MV Hub 화면을 바꾼다(3판부터 창이 가려져 있어도) — 기본 끔·켠 본창만·명시 선택·화면 표·알림(다시 보일 때 한 번)·되돌리기·한도·자격 재확인으로 묶는다. 브라우저가 탭을 얼리거나 버리면 그동안은 실행되지 않고(30초 뒤 expired_unclaimed), 만료된 동작은 재개되지 않는다.
- 화면 실행 성공이 영구 저장 완료는 아니다(기존 실행기 계약과 같음).
- 알림이 메모리라 허브 재시작 직후 다음 heartbeat 까지 대상이 없다.

## 5. 완료 조건과 시험 (저장소 루트, 각 파일 별도 run-test — 300초 한도)
- screen-server: `backend/tests/test_mcp_screen_actions.py`(새 — 등록·발급 자격·대상 1/여럿/없음·명시 선택·화면 표 일회용/만료/세대·자격 재확인·기대 계정·조회 전용 자격·공간·씬 저장 확인·내 생성물·한도·진행 중 상한·claim 한 번·결과/만료 경합·취소·재시작·정보 최소화·다른 계정/위조 수신 자격 거절 — 제어 가능한 시계·장벽, 실제 HTTP 경로)
- screen-transport: `test_realtime_ws.py`·`test_main_mutation_notify.py`·`test_mutation_notify.py`·`test_ws_ghost_collection.py`·`test_r14_ws_auth_recheck_grace.py`, 프런트 `src/lib/progressSocket.test.ts`(깨우기에 내용·자격 없음·범위 전달·불필요한 synced 없음)
- screen-adapter: 백엔드 `test_mcp_bridge.py`, 어댑터 `test_persistent.py`·`test_server.py`·`test_update.py`·`test_local_setup.py`
- screen-ui: `tests/mcpScreenActions.test.tsx`(새 — StrictMode·늦은 응답·A→B→A·숨김/끔·보드 분리·중복 깨우기·칸과 교차·영수증/되돌리기·알림 목록)
- screen-consent: `tests/mcpQuickConnect.test.tsx`·`mcpRegistration.test.tsx`·`agentChatConnect.test.tsx`·`agentSettingsInstall.test.tsx`(기본 끔·계정/허브별 저장·저장 실패·다른 탭 끔·문구/영어)
- screen-regression: 백엔드 `test_mcp_persistent.py`·`test_agent_chat_screen_actions.py`·`test_agent_chat_api.py`·`test_agent_chat_parse.py`, 프런트 `tests/agentChatPanel.test.tsx`·`agentChatScreenContext.test.tsx`·`agentScreenActions.test.ts`·`mcpCanvasTasks.test.tsx`·`sceneRefServerStatus.test.tsx`·`generationProgressReconnect.test.tsx`
- screen-build: `test_architecture_boundaries.py`, `npm.cmd --prefix frontend run lint:architecture`, `npm.cmd --prefix frontend run build`
- screen-docs: `tools/check_code_map.py`, `tools/gen_inventory.py --check`, `test_docs_inventory_fresh.py`
- screen-real(실측, MV 생성 크레딧 0 — 화면 조회·네 화면 동작만): dev 허브(8012·5173)에서 내장 브라우저의 **실측용 새 씬**(개인 공간, 저장 확인 뒤). R1 준비(실행 소스·어댑터 판·허브 확인, 설치본·공유 서버·사용자 MCP 설정 불변) · R2 Claude Code(칸 폴더 밖 새 폴더 -p): 스위치 끔에서 거절 → 켬 → read_context(screen) → canvas.read_selection → canvas.create_nodes(빈 생성 카드 2개, 실제 생성 아님) → 그 id 로 canvas.connect — 화면에 카드·연결이 생기고 알림 목록·되돌리기(연결 → 카드 순) 동작, 글 카드도 한 번 · R3 Codex(새 폴더 exec read-only) 같은 흐름, 호스트 승인 거부 없이 허브·화면 반영을 따로 기록 · R4 (3판) 창이 가려진(숨김) 상태에서도 같은 흐름이 되고 다시 보일 때 알림, 켜진 본창 두 개면 모호 거절 → [이 창 사용] 뒤 그 창만 변경(가능할 때), 끔·다른 씬·씬 A→B→A 뒤 옛 화면 표 거절(보임↔숨김 전환만으로는 거절되지 않음) · R5 presence 빈도(보임·숨김·끔 60초) 관찰 · R6 정리(되돌리기·저장 확인 뒤 실측용 씬만 앱 정상 삭제, 스위치·대상 선택 원래 값 복구, 생성 API 0건). 다른 계정·위조 자격·조회 전용·고정 공간·재시작 경계는 screen-server 시험(실제 HTTP 경로)이 맡고 실사용 계정 설정은 바꾸지 않는다. 판정은 스크래치 스크립트가 실제 관측 자료(CLI 기록·허브 응답·화면 DOM/스크린샷)로.

## 6. 검토 기록
- 설계 1판(Claude) → Codex 설계 확정 `01a1f849-912c-7cb0-b22d-ca17d956a925`(gpt-6-astra·high·읽기 전용): 수정 필요 — P1 9(최근 heartbeat 대상 선택·공개 탭 번호와 자격 분리·WS 격리 주장·조회-실행 사이 대상 바뀜·원래 연결 권한 재확인·read_context 정보 최소화·상태 전이/한도·기존 사용자 기본 켬·…) · P2 4(칸 상태기계 비공유·heartbeat 부담·WS 수신/되돌리기 위치·어댑터 표면) → 2판. Claude 판단: 기본 끔·명시 선택·screen_context 필수 채택, 위조·다른 계정·재시작 경계는 실사용 허브 대신 백엔드 실제 HTTP 경로 시험으로.
- **양측 합의 1차(계약 bf235633) = 합의**: Codex `01a1f849…`(같은 세션 이어 받기, read-only) "확정 가능, 미해결 P1/P2 없음" · Claude `4391cd72-dcae-496e-a824-90ab019e0652`(claude-opus-5-5·Read/Grep/Glob) 동의. Claude 낮음(구현 요청에 반영): L1 `screen_action` 의 라이브러리 불변 분류는 일반 연결에만(칸 `library.set_hidden` 뒤 목록 갱신 유지) · L2 도구 설명에 "동작마다 read_context(screen) 다시" 명시.
- 구현 중 발견(Codex 구현 답): 독립 어댑터 업데이트 검사기 `tools/mcp_adapter/update.py:129` 가 기능 표식 이름을 `[a-z_]{1,80}` 로만 받아 `external_screen_v1`(숫자)을 거부 → 범위 밖 파일을 늘리는 대신 기존 표식(`agent_chat_read`·`reference_exact`)처럼 숫자 없는 **`external_screen`** 으로 이름만 바꿈(계약 문구 4곳 갱신 → 재합의).
- 구현(Codex `01a1f849…` 이어 받기·workspace-write, 작업실 `codex/mvagent-mcp-screen`) `157f382c` → fix1(대화 도구 수 14→15 시험) → 독립 리뷰 지적 M1(분리 캔버스 창이 수신 창으로 등록됨)·M2(자격 잃으면 30초 뒤 재등록) 반영 fix2 `89ccc8f7`.
- 2판 실측에서 발견: Claude 앱 안 브라우저 창이 가려지면 탭이 숨김 → heartbeat 중지 → `screen_unavailable`. Jay 결정 "가려져도 되게" → 3판(3-8) → 양측 재합의(Codex P2 정지된 창의 늦은 실행 → claim 남은 실행 시간 · Claude P2 새로고침 뒤 옛 수신 창 → pagehide 해제) → 계약 `20eeee46…` → fix3 `513e49df`(세대 엇갈림 조사 포함).
- 독립 리뷰 Claude `9b9b9c6a-2b1c-42de-8348-7bc47ab83f80`(claude-opus-5-5·Read/Grep/Glob 읽기 전용, 대상 513e49df) = **PASS**. 낮음(기록, 반영 안 함): L2 전역 잠금 안에서 상류 조회 · N1 등록 중 페이지를 떠나면 서버에 고아 수신 창(150초 TTL 로 사라짐) · N2 로그인 토큰이 바뀌면 옛 수신 창 해제를 안 보냄(TTL 로 사라짐) · N3 같은 계정 MV Hub 탭이 둘이면 늘 모호(명시 선택 필요 — 설계대로) · N4 브라우저가 얼린 탭은 `expired_unclaimed`.
- 시험(총괄이 샌드박스 밖에서, 513e49df): 프런트 전체 8,054 통과(11 건너뜀)·핵심 283, build·lint:architecture, 어댑터 4종, 백엔드 핵심 174·추가 61파일 2,506 통과. **기존 실패 1** `test_architecture_boundaries.py::test_backend_internal_import_graph_has_no_cycles`(agent_chat_claude→process→install·codex→process 순환) — dev `b313882f`(이번 변경 전)에서도 똑같이 실패하고 이 시험 파일·그 모듈은 이번 범위 밖 → screen-build 시험 기록은 `-k` 로 그 하나만 뺐다.
- 실측(screen-real, dev 허브 8012·5173·내장 브라우저, MV 생성 0) — 판정 스크립트 19/19 통과:
  - R1 준비: 실측 연결 `mvhub-test` = dev 작업 트리 `tools/mcp_adapter/server.py`(ADAPTER_VERSION 2026.11.20.2) → `http://127.0.0.1:8012`. 설치본·공유 서버·사용자 MCP 설정 미사용.
  - R2 Claude Code(새 폴더 `-p`, haiku, `--strict-mcp-config` 로 mvhub-test 만): 끔 → `screen_unavailable` · 켬 → read_context(screen)→read_selection→빈 생성 카드 2개→연결 모두 ok, 보드 DOM 카드 0→2·연결 0→1, 알림 "최근 화면 동작" 3줄·[되돌리기] 2개 → 되돌리기(연결 → 카드)로 0·0 복귀. 도구 허용은 모두 사용자 설정 규칙(userSettings).
  - R3 Codex(새 폴더 `exec --sandbox read-only`): 같은 흐름 6호출 모두 completed·승인 거부 없음, 보드에 카드 2·연결 1, 알림에 "Codex:" 로 표시 → 되돌림.
  - R4 숨김: 내장 브라우저는 뒤 탭·숨은 창에도 `visible` 로 남아(뒤로 보낸 뒤 7초 확인) 실제 숨김을 만들 수 없어, 페이지 안에서 `visibilityState`·`hidden` 을 덮고 `visibilitychange` 를 일으켜 확인 — 숨김 동안 read_context(screen)·create_nodes ok, 카드가 숨김 상태에서 보드에 생김, 다시 보일 때 "가려진 동안 바깥 앱이 화면을 1번 바꿨어요" 알림. **한계**: 브라우저의 숨은 탭 타이머 감속(분당 1회까지)은 이 흉내로 재현되지 않는다 — TTL 150초·WS 깨우기 설계(3-8)가 맡는다. 3-8 의 "숨은 탭 requestAnimationFrame 정지" 걱정은 흉내로는 못 재므로 코드로 확인: 화면 동작은 `scene.commit` → `scene.snapshot` 동기 처리(`frontend/src/lib/agentScreenActions.ts:100-110`)라 rAF 에 기대지 않는다(rAF 는 화면 그리기·컬링만). 실제 브라우저 창을 최소화한 실측은 하지 못했다.
  - R4 거절: 다른 씬 id → 거절(대조: 같은 순간 올바른 씬은 ok, `mcp_v2.py:1925` 표 확인 뒤 `:1931` 씬 비교) · 씬 A→B→A(씬 9→씬 7 보기만→씬 9) 뒤 옛 표 → `screen_context_invalid`(표 나이 5.6초라 만료 아님), 바로 새 표는 ok · 켜진 창 둘 → `screen_ambiguous` → 한 창에서 [이 창 사용] → 그 창만 동작(다른 창 알림 없음).
  - R5 presence 빈도(75초씩): 보임 분당 6.4회·숨김 분당 6.4회(모두 10초 간격).
  - R6 정리: 카드·연결 되돌림, 실측용 씬 9(`mwowja1fytolmk`) 앱에서 삭제, 화면 제어 원래 값(끔), 두 번째 탭 닫음, dev DB 읽기 전용 조회로 생성 관련 표 새 줄 0.
  - 새 낮음 L3: 다른 씬 id 거절도 `screen_context_invalid`(문구 "만료·이미 쓰임·화면 바뀜")라 원인이 구분되지 않는다 — 실측에서 바깥 AI 가 원인을 못 가렸다. 동작은 안전(거절). 후속 후보: 씬 불일치 전용 코드나 문구.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-mcp-external-screen-2026-11-20",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925"},
  "risk": {"level": "major", "reason": "바깥 MCP 연결(Claude Code·Codex)이 사용자가 보는 MV Hub 화면(캔버스 카드·연결·생성물 회색)을 바꾸게 하는 새 권한 경로 — 수신 창 자격·웹소켓 전달·계정/공간 격리·동시성·동의 기본값"},
  "goal": "MV Agent 로 연결한 바깥 앱(Claude Code·Codex)이 사용자가 화면 제어를 켜 둔 MV Hub 본창(가려져 있거나 최소화돼 있어도)의 지금 공간·씬을 읽고 칸과 같은 네 화면 동작(선택 읽기·빈 카드 만들기·연결·내 생성물 회색)을 하게 한다. 서버 발급 수신 자격·명시 대상 선택·일회용 화면 표·연결 권한 재확인·한도로 묶고, 화면 제어는 기본 끔이며 알림·되돌리기를 준다. 칸 화면 동작·칸 실행·유료 생성 규칙·캔버스 대기 작업은 그대로 둔다.",
  "touched_paths": [
    "backend/app/routers/mcp_v2.py",
    "backend/app/services/mcp_screen.py",
    "backend/app/main.py",
    "backend/app/routers/auth.py",
    "backend/app/mutation_notify.py",
    "backend/tests/test_mcp_screen_actions.py",
    "backend/tests/test_mcp_bridge.py",
    "backend/tests/test_main_mutation_notify.py",
    "backend/tests/test_realtime_ws.py",
    "tools/mcp_adapter/server.py",
    "tools/mcp_adapter/test_persistent.py",
    "tools/mcp_adapter/test_update.py",
    "frontend/src/App.tsx",
    "frontend/src/types.ts",
    "frontend/src/lib/useMcpScreenActions.ts",
    "frontend/src/lib/progressSocket.ts",
    "frontend/src/lib/progressSocket.test.ts",
    "frontend/src/lib/appEvents.ts",
    "frontend/src/lib/hubFeatures.ts",
    "frontend/src/components/mcp/McpScreenNotice.tsx",
    "frontend/src/components/mcp/mcp.css",
    "frontend/tests/mcpScreenActions.test.tsx",
    "frontend/src/lib/storageKeys.ts",
    "frontend/src/lib/i18n.ts",
    "frontend/src/components/mcp/McpQuickConnect.tsx",
    "frontend/src/components/mcp/McpRegistration.tsx",
    "frontend/src/components/agent-chat/AgentConnect.tsx",
    "frontend/src/components/agent-chat/AgentSettings.tsx",
    "frontend/tests/mcpQuickConnect.test.tsx",
    "frontend/tests/mcpRegistration.test.tsx",
    "frontend/tests/agentChatConnect.test.tsx",
    "frontend/tests/agentSettingsInstall.test.tsx",
    "docs/CODE_MAP.md",
    "docs/CURRENT_STATUS.md",
    "docs/inventory/endpoints.md"
  ],
  "criteria": [
    {"id": "screen-server", "success": "수신 창 등록(서버 발급 자격·해시 보관·세대 결합·무효화)·대상 선택(하나 자동·여럿 screen_ambiguous·명시 선택 고정·없음)·화면 표(30초 일회용·연결/창/공간/씬/세대 결합·A→B→A 거절)·발급/claim/결과 전 원래 연결 권한·계정·비밀번호·허브·DB 세대·공간 재확인·기대 계정 필수·조회 전용 자격은 읽기만·고정 공간 비확대·씬 저장 확인·내 생성물만·한도(진행 중 계정 1·서버 8·60초 연결별/계정별·요청 빈도)·claim 한 번·결과/만료 같은 잠금 확정·늦은 결과/재사용 토큰 거절·취소·재시작 후 재실행 없음·read_context(screen) 정보 최소화·다른 계정/위조 수신 자격 거절·칸 경로 불변·(3판) 켜진 숨은 창도 대상·TTL 150초·보임↔숨김 전환은 세대·표·동작 유지·claim 응답의 남은 실행 시간·해제된 수신 창은 대상/모호 판정에서 즉시 빠짐 시험 통과", "failure": "시험 실패 또는 다른 계정·다른 창·꺼짐·권한 회수 상태에서 실행되거나 정보가 새는 경로 존재, 서버 기한이 지난 동작이 실행되는 경로 존재", "required": true, "verification": ["976134c0d6aa4a0eb61471a0a744da76"]},
    {"id": "screen-transport", "success": "WS 깨우기에 이름·인자·씬·공간 이름·클라이언트·자격이 없고 AUTH 켬은 realtime_scope 로만·broadcast_all 미사용, presence·claim·result 가 변경 알림 제외·불필요한 synced 없음, 기존 WS 유령 수거·인증 재검사 회귀 통과", "failure": "시험 실패 또는 깨우기에 내용·자격 포함·다른 계정 범위 전달", "required": true, "verification": ["f1476f4293434829a7540180897fde36", "64a2e787fd0644eb8baa62acd4d2f861", "33bcca87285d4965acb17813771ae301", "1513790a836d42328eafe3915b0b796b", "ba78074df54f45aab1508029f4effc15", "f4d9c06cc4864b73af82e3c7de3d4b44"]},
    {"id": "screen-adapter", "success": "영속 프로필 일반 연결에만 screen_action(screen_context)·read_context screen 노출, 구형 브로커·구형 허브는 업데이트 필요 명시, 칸 표면 고정 지문 불변, 일반 도구 수 native 16·conversation 15, ADAPTER_VERSION 2026.11.20.2·일반 표면 지문 의도한 갱신, external_screen 기능 요구, 백엔드 브리지 health 기능 목록 시험 통과", "failure": "시험 실패 또는 칸 표면·업데이트 계약 변경", "required": true, "verification": ["9f735e8579a04b15964f3b9aa812cbee", "5447f633c4434856aacaf79d940cd53a", "393c17d7433945d6af1835a89498c0af", "6ac354bd73534854ae37a0bf067470d9", "12b2a0eca0dc4fb18afe004e1a85bfc0"]},
    {"id": "screen-ui", "success": "useMcpScreenActions 가 켜진 본창만 등록·갱신(보임 여부 무관 — 숨김에도 heartbeat 계속, seq·백오프·끔이면 중지), 보임↔숨김 전환은 세대를 올리지 않음, 자기 수신 창 깨우기만 claim, 실행 직전 세대·켬·계정·공간·보드 재확인(보임 조건 없음)과 대기 중 편집 지문 비교, claim 응답의 남은 실행 시간에서 경과를 빼 0 이하면 실행 안 함(만료 뒤 claim 응답 도착 시 화면 변경 0회), pagehide keepalive 해제 요청, 숨은 동안 실행한 동작은 다시 보일 때 한 번 알림, StrictMode·늦은 응답·A→B→A·보드 분리·중복 깨우기·칸과 교차, 영수증 먼저 보관·알림 목록 20개·되돌리기 시험 통과", "failure": "시험 실패 또는 다른 창 명령 실행·중복 실행·되돌리기 불가", "required": true, "verification": ["7075ece063b84d95bae82ae94cbbd7d4"]},
    {"id": "screen-consent", "success": "화면 제어 기본 끔(저장값 없음·손상·미확인 허브)·origin/허브/계정별 저장·저장 실패 시 켬 표시 안 함·다른 탭 끔 반영·[이 창 사용]·동의 문구 4곳과 영어 사전 일치 시험 통과", "failure": "시험 실패 또는 사용자 동의 없이 켜지는 경로 존재", "required": true, "verification": ["6112ca27e90d47af90a5b486b92e59c2", "4855a985475a4bd184f76384dfd7b590", "5cf40fab85634a3aa7bdaaef46e68316", "ac97d42cb7b84e739a2a7da723f62f8b"]},
    {"id": "screen-regression", "success": "칸 화면 동작·칸 패널·화면 맥락·실행기·캔버스 대기 작업·영속 MCP·씬 서버 상태·진행 재연결 기존 시험 통과", "failure": "기존 동작 회귀", "required": true, "verification": ["9437c46895024fa3badc01e88aae2a8c", "e5a40e8b751d4816adbf606de7c19db1", "1d937d78ca0147b5862b1d73227a0c0d", "819ec37e3e614f848a433213acb5e1ff", "811bf303c4914129996509ab1cb2d90e", "92ca70f8b5dd48bd83a469654dbcf8ea", "9dc7163d28e74473aa3e32d942c519b5", "4283e8be2b24418da328a882766864d2", "63e05a6a3eb04d20bfcf9c358c8b6813", "abcf80d6f2d34a84a2f26b7477f9386d"]},
    {"id": "screen-build", "success": "test_architecture_boundaries·lint:architecture·build 통과", "failure": "검사·빌드 실패", "required": true, "verification": ["9a8d7755374c4cbf8478b8959223d32f", "b400a8c451714177ad2331f1d8e58d77", "d79b0f2e068c48c69e11612838d15ed4"]},
    {"id": "screen-docs", "success": "check_code_map·gen_inventory --check·test_docs_inventory_fresh 통과", "failure": "목록·코드맵 낡음", "required": true, "verification": ["fab2f5cf336b4e429ba0d242e062609f", "d1296e96ed004ee98642f33975a4b2b4", "584ab1e1e0004bb883534d9f1a99ead0"]},
    {"id": "screen-real", "success": "dev 허브 실측(MV 생성 크레딧 0): 실측용 새 씬에서 Claude Code(-p 새 폴더)와 Codex(exec read-only)가 스위치 끔이면 거절, 켜면 read_context(screen)→read_selection→빈 카드 2개 만들기→연결이 실제 화면에 반영되고 알림 목록·되돌리기 동작, **창이 가려진(숨김) 상태에서도** 같은 흐름이 되고 다시 보일 때 알림, 끔·다른 씬·A→B→A 뒤 옛 화면 표 거절, 켜진 본창이 둘이면 모호 거절(가능할 때), presence 빈도 관찰(보임·숨김), 실측용 씬·스위치·선택 정리와 생성 API 0건 — 스크래치 검사 스크립트가 실제 관측 자료로 판정", "failure": "어느 경로든 화면 미반영·잘못된 창/씬 변경·거절되어야 할 상태에서 실행·생성 제출 발생·정리 미완료 또는 실측 미완료", "required": true, "verification": ["b7d19a593c53478fbb850508c66eb1f6"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "바깥 연결의 화면 동작은 새 services/mcp_screen.py 가 수신 창·대상·동작 수명을 따로 소유하고, 칸 상태기계(차례·emit_lock·사건)와는 공유하지 않는다. 인자 검증·공간·내 생성물·실행기·되돌리기만 재사용한다", "why": "칸 동작 표는 차례 종료·취소·사건 기록과 묶여 있어 가짜 차례로 재사용하면 변경 범위와 위험이 커진다(Codex 확정 P2). 재사용 가능한 순수 부분만 공유한다", "alternative": "칸 상태기계 공통화 / 범용 작업 큐 / 캔버스 대기 작업 확장(실시간 읽기 불가)", "revisit": "칸과 바깥 경로에 같은 버그가 반복되면 공통 브로커 검토"},
    {"choice": "수신 창은 서버가 발급한 receiver_id·secret(창 메모리, 서버엔 해시)으로만 갱신·선택·claim·result 하고, WS 는 내용 없는 깨우기만 보내며 실제 명령은 인증된 claim 응답으로만 준다", "why": "X-MVHub-Tab 은 형식만 보고 mcpTabId 는 공용 자격이 아니다. AUTH 끔에선 로컬 소켓이 같은 WS 범위를 공유하므로 내용을 방송하면 다른 창이 볼 수 있다(Codex 확정 P1)", "alternative": "공개 탭 번호로 대상 지정 / WS 에 명령 방송 / 새 WS 인증 구조", "revisit": "/ws 인증이 계정별로 바뀌면"},
    {"choice": "대상 창은 화면 제어를 켠 유효 본창(보임 여부 무관 — 가려짐·최소화 포함, 3판 Jay 결정)이 하나일 때만 자동, 숨김에도 heartbeat 를 계속 보내고 수신 창 TTL 150초, 보임↔숨김 전환은 화면 세대를 올리지 않으며, 여럿이면 screen_ambiguous 로 거절하고 [이 창 사용]으로 명시 선택하며, read_context(screen)이 주는 30초 일회용 screen_context 를 screen_action 에 필수로 받는다", "why": "heartbeat 순서로 대상을 고르면 다른 창이 바뀌고, 조회와 실행 사이에 대상·씬이 바뀔 수 있다(Codex 확정 P1). 칸이 차례에 화면을 고정하는 것과 같은 보호를 바깥 연결에 준다. '보이는 창만'은 실측에서 Claude 앱·터미널이 브라우저를 덮는 흔한 모습마다 거절돼(숨김) Jay 가 '가려져도 되게'로 정했다 — 숨은 탭 타이머 억제(최대 1분 간격)를 TTL 150초로 견디고, 창 전환이 표·동작을 깨지 않게 세대에서 보임을 뺀다", "alternative": "가장 최근 heartbeat 창 / 화면 표 없이 매번 최신 창", "revisit": "사용자가 여러 창을 자주 쓰며 명시 선택이 불편하다고 하면"},
    {"choice": "발급·claim·결과·응답 전마다 원래 MCP 연결의 회수·계정·비밀번호·허브·DB 세대·공간 권한을 다시 보고, 조회 전용(can_execute=False) 자격은 읽기만, 한도(진행 중 계정 1·서버 8, 60초 연결별·계정별 항목 한도, 요청 빈도)를 둔다", "why": "앱 로그인만으로 원래 연결이 유효하다고 볼 수 없고, 여러 연결로 쪼개 한도를 넘는 것을 막는다(Codex 확정 P1)", "alternative": "앱 인증만 확인 / 연결별 한도만", "revisit": "없음"},
    {"choice": "화면 제어 스위치는 기본 끔(저장값 없음·손상·미확인 허브)이고 한 번 켜면 origin·허브·계정별로 유지하며, 동의 문구를 4곳·영어 사전에 통일한다", "why": "앞 묶음의 동의(자료 조회·생성)에 화면 편집이 없었고, 팀원 PC 에 조용히 켜지면 동의 범위가 달라진다(Codex 확정 P1). Jay 의 '바로바로'와는 처음 한 번 켜기만큼 다르다", "alternative": "기본 켬(동의 범위 확대) / 매번 묻기(요구와 반대)", "revisit": "Jay 가 기본 켬을 명시적으로 결정하면"},
    {"choice": "어댑터는 영속 프로필 일반 연결에만 screen_action(screen_context)·read_context screen 을 노출하고 칸 표면은 고정 지문으로 보호하며 ADAPTER_VERSION 2026.11.20.2·기능 표식 external_screen 로 구형 허브를 명시적으로 막는다", "why": "칸 도구 스키마가 바뀌면 칸 계약이 깨지고, 구형 허브에 새 도구가 보이면 조용히 실패한다", "alternative": "공통 read_context Literal 확장(칸 스키마 변경)", "revisit": "없음"}
  ],
  "evidence": {"target": {"kind": "revision", "revision": "513e49df5e51ca65732ac079c89ee83471ae9599"}, "consensus": [
    {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/20/rollout-2026-11-20T18-28-53-01a1f849-912c-7cb0-b22d-ca17d956a925.jsonl"},
    {"host": "claude", "session": "4391cd72-dcae-496e-a824-90ab019e0652", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-screen-agree/4391cd72-dcae-496e-a824-90ab019e0652.jsonl"}
  ], "review": {"host": "claude", "session": "9b9b9c6a-2b1c-42de-8348-7bc47ab83f80", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-review-screen/9b9b9c6a-2b1c-42de-8348-7bc47ab83f80.jsonl"}, "design_sessions": [
    {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925"}
  ]}
}
```
