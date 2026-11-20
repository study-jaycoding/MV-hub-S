---
status: draft
updated: 2026-11-20
---

# 바깥 화면 편집 낮음 정리 — 씬 불일치 코드·등록 중 이탈·토큰 바뀜 해제·고른 창 끔·상류 조회 잠금 밖 (2026-11-20)

owner: Codex(구현) · Claude(설계·총괄) · reviewer: Codex(설계 확정) · Claude 별도 세션(독립 리뷰) · status: 설계 중 · updated: 2026-11-20
선행 기록: [바깥 화면 편집](MVAgent_MCP바깥화면편집_2026-11-20.md)(dev 513e49df·기록 9bbda63c — 리뷰 PASS·실측 19/19, 낮음 L2·L3·N1~N4 남김)

## 1. 요청
- Jay /goal "완벽한 mv agent와 mcp연동" — 앞 묶음 완료 보고 뒤 목표 검사가 "낮음 L2·L3·N1~N4 열림·실제 숨김 미실측"을 미충족으로 봤다. 기억 규칙(배포 전 '낮음'도 미루지 않음)과도 맞춰 이번에 정리한다.
- Jay 11-20 답: 릴리스는 **지금은 dev 만**, 실제 숨김 실측은 **Jay Chrome 사용 허락**.

## 2. 근거 (Claude 직접 확인 — 파일:줄은 dev 513e49df)
- **L3 씬 불일치가 원인 없는 거절**: 화면 동작은 표를 먼저 꺼내고(`backend/app/routers/mcp_v2.py:1925` `consume` — `mcp_screen.py:183` pop) 그 뒤 씬을 비교해(`mcp_v2.py:1931`) `screen_context_invalid` 로 거절한다. 어댑터 문구는 "만료·이미 쓰임·화면 바뀜"(`tools/mcp_adapter/server.py:84`)이라 실측에서 바깥 AI 가 원인을 못 가렸고(`claude_wrongscene`), 표도 버려져 다시 받아야 한다.
- **N1 등록 중 이탈 → 주인 없는 수신 창**: `release()`(`frontend/src/lib/useMcpScreenActions.ts:243-253`)는 수신 창이 있을 때만 해제를 보낸다. 첫 등록 요청이 날아가는 동안 `pagehide` 가 오면 요청만 끊고(`abort`) 서버에는 수신 창이 생길 수 있어 TTL 150초(`mcp_screen.py:14`) 동안 남는다 → 새로고침한 새 창과 겹쳐 `screen_ambiguous`.
- **N2 토큰 바뀜 → 옛 수신 창 해제 못 함**: `release()` 는 `token === getAuthToken()` 일 때만 보내고(`:244`), `jsonFetch` 는 Authorization 을 지금 토큰으로 덮으며(`frontend/src/lib/http.ts:235`), 서버 결합값에 토큰 해시가 들어간다(`mcp_v2.py:1817-1818`). 같은 계정 재로그인 등으로 토큰이 바뀌면 옛 수신 창이 TTL 동안 남아 모호해진다.
- **N5(새, 11-20 Jay Chrome 실측) 고른 창을 꺼도 선택이 남음**: `update()` 는 해제(release) 때만 선택을 지우고 끔(enabled=false)은 남긴다(`mcp_screen.py:144-148`). `target()` 은 선택으로 후보를 거른 뒤 켠 창만 남겨(`:157-162`) 빈 목록 → `screen_unavailable`. 만료(TTL)로 사라진 수신 창의 선택도 `_clean`(`:80-91`)이 지우지 않는다. 실측: 내장 브라우저 창에서 [이 창 사용] → 그 창 끔 → Jay Chrome 창 켬 → `read_context(screen)` = `screen_unavailable`(세션 cf8cd58d), Chrome 등록 응답 `multiple: true, selected: false`.
- **L2 상류 조회를 전역 잠금 안에서**: `_screen_validate` 가 `store.registration_lock`(등록·회수 공용 전역 잠금)을 쥔 채 공유 서버 계정 조회 `_upstream_me` 를 부른다(`mcp_v2.py:1822-1834`). 상류가 느리면 다른 등록·화면 권한 검사가 줄줄이 기다린다.
- 바꾸지 않는 것(설계 의도): **N3** 같은 계정 켠 창이 둘이면 늘 `screen_ambiguous` — heartbeat 순서로 고르기는 1판 Codex P1 로 기각, 명시 선택이 안전장치. **N4** 브라우저가 얼린 탭은 실행을 보장하지 않는다 — 받기(claim) 전에 얼면 30초 뒤 `expired_unclaimed`, 받은 뒤 얼어 결과가 없으면 `unknown`(자동 재실행 안 함). 정지 중 실행 안 함이 안전(앞 기록 3-8 문구 한정).

## 3. 설계
- **L3**: 화면 동작은 표를 **꺼내기 전에** 확인한다 — 화면 서비스 잠금(`consume` 의 `self.lock`) 한 번 안에서 표 확인(꺼내지 않음) → 캔버스 동작의 `scene_id` 가 그 수신 창의 지금 씬과 다르면 `screen_scene_mismatch`(409)로 거절하고 **표는 그대로 둔다**(같은 표로 바른 씬이면 기한 안에 한 번 실행 가능) → 같으면 같은 잠금 안에서 꺼내 한 번만 쓴다. 표·세대·연결 결합 검사와 일회용은 그대로이며, 같은 표의 동시 요청은 하나만 성공한다. 인자 검증(`model_validate`)은 표 확인 앞으로 옮기고, 수신 창에 씬이 없는데(`scene_id` 없음) 캔버스 동작이 오면 기존 `screen_scene_unavailable` 로 거절한다(안내대로 해도 풀리지 않는 mismatch 를 내지 않게). 어댑터 오류 표에 문구 "지금 사용자가 보는 캔버스 씬이 아니에요. read_context(kind='screen')이 준 scene_id 를 그대로 쓰세요."(retryable False, next_action read_context), `ADAPTER_VERSION 2026.11.20.3`(일반·칸 도구 표면 지문 불변).
- **N1**: 창이 등록 요청마다 무작위 `registration` 값을 **요청 보내기 전에** 만들어 창 메모리의 '확인 안 된 등록' 목록(최대 4)에 넣고 함께 보낸다. 서버는 수신 창에 그 해시를 둔다. 목록에서 빼는 때는 응답을 받았을 때(성공 = 수신 창 확정, 명시 거절 4xx = 등록 없음)와 **취소 성공 응답**을 받았을 때뿐이다. 시간 초과(20초)·응답 유실·네트워크 오류처럼 서버 처리 여부를 모르면 그 값으로 바로 취소(`{release: true, registration}`, 수신 자격 없음)를 보낸다. 취소가 429·네트워크 오류로 확인되지 않으면 값을 버리지 않고 목록에 둔 채 다음 차례(heartbeat 백오프)에 다시 취소한다. 목록이 꽉 차면(4) 새 등록을 보내지 않고 취소가 확인될 때까지 미룬다. `pagehide` 때 목록에 남은 값은 모두 keepalive 취소로 보낸다. 서버는 **같은 계정·같은 결합값**일 때만: 그 등록 값의 수신 창이 있으면 즉시 해제(선택·표·진행 동작 정리 포함), 없으면 해시를 묘비로 남겨 뒤늦게 도착한 같은 등록은 수신 창을 만들지 않는다(등록 처리 끝, 저장 직전에 잠금 안에서 묘비를 다시 본다). 서버는 **등록 요청 처리 시작부터 저장까지 20초**(창의 요청 제한과 같음 — 그보다 늦은 응답은 창이 이미 버린다)를 넘기면 저장하지 않고 `screen_stale` 로 끝낸다. 묘비 보존은 **150초**. 그래서 묘비가 막지 못하는 경우는 취소가 '그 등록 요청이 서버에 도착하기 130초 넘게 전'에 온 경우, 곧 요청이 창을 떠나 서버에 닿기까지 130초 넘게 걸린 경우뿐이다(같은 PC 루프백이라 드물 것으로 추정 — 실측한 빈도는 아님). 그때 생긴 수신 창은 **생성부터 최대 150초** 남아 그동안 모호를 만들 수 있다(4장). 묘비 상한(계정 16·전체 512)에 닿으면 **살아 있는 묘비를 지우지 않고** 새 취소를 `screen_busy`(429)로 거절한다(창은 값을 들고 다시 시도, 그동안은 지금처럼 TTL 이 마지막 방어). 다른 계정의 취소는 그 계정 몫만 쓰며 남의 묘비를 밀어내지 못한다. 다른 계정·다른 결합값의 수신 창은 건드리지 못한다. `registration` 은 32~100자 문자열만 받고, 등록 값 없이 만든 수신 창은 어떤 취소와도 짝이 맞지 않는다. 해제 요청 검사(`enabled=false`·`select=false` 필수)는 유지하고 `receiver_id` 대신 `registration` 만 있는 해제를 허용한다. 등록 값 취소도 아래 N2 와 **같은 보내기 함수**(붙잡은 토큰)로 보내 결합값이 맞게 한다.
- **N2**: `release()` 는 효과 시작 때 붙잡은 토큰·계정으로 보낸다 — `jsonFetch` 대신 `fetch(…, {keepalive: true})` 에 `Authorization: Bearer <붙잡은 토큰>`·기대 계정·탭 머리글을 직접 싣는다. 연결(허브)이 바뀌었으면 지금처럼 보내지 않는다. 로그아웃은 토큰을 지우는 대신 그 계정 수신 창을 무효화하고 계정 세대를 바꾸므로(`backend/app/routers/auth.py:329` 부근) 그 뒤의 옛 결합값 해제는 거절돼도 남는 수신 창이 없다.
- **N5**: 선택은 **고른 창이 살아 있고 켜져 있을 때만** 유효하다 — 고른 수신 창이 끄거나(enabled=false)·해제·만료되면 선택을 지운다(`update`·`_clean` — 무효화 `invalidate` 는 이미 지운다, `mcp_screen.py:114`). 그 뒤 대상은 보통 규칙(켠 창 하나면 자동, 둘 이상이면 `screen_ambiguous`). 다시 켜도 선택은 자동 복구하지 않는다(다시 [이 창 사용]). **기존 시험 기대값을 바꾼다**: `backend/tests/test_mcp_screen_actions.py:80` 부근의 "고른 창을 끄면 다른 창으로 넘어가지 않음"은 "고른 창을 끄면 선택이 풀리고, 남은 켠 창 하나가 대상"으로.
- **L2**: `_screen_validate` 에서 **상류(공유 서버)로 나갈 수 있는 검사 전부** — 계정 조회 `_upstream_me`, 팀 공간 권한(`_request_workspace` → `_workspace`, `mcp_v2.py:215` 부근), 내 생성물 조회(`_generation_row` 가 상류로 넘어가는 경로, `backend/app/routers/library.py:1148` 부근) — 를 `registration_lock` **밖에서 먼저** 한다(같은 계정 고정·연결 고정 안). 그다음 잠금을 잡고 로컬 확인(`_still_current` 로그인·연결 권한·회수·`can_execute`·DB 세대)과 **검사 대상 화면의 세대·공간·씬이 잠금 밖 검사 때와 같은지**를 다시 본 뒤 `transition_lock` 커밋만 한다. 잠금 순서는 기존 `registration_lock → transition_lock → 화면 서비스 잠금` 그대로. 다른 경로(앞 묶음 등록·회수)의 잠금은 바꾸지 않는다. 상류 조회가 앞으로 오므로 로컬에서 이미 회수된 연결도 상류 오류 코드(예: `upstream_unavailable`)를 먼저 받을 수 있다 — 보안 영향 없음, 기록만.

## 4. 남은 위험
- N3·N4 는 의도된 동작으로 남는다(창 둘이면 명시 선택, 얼린 탭은 실행 안 함).
- 상류 조회를 잠금 밖으로 옮겨, 조회와 커밋 사이 상류 계정 상태가 바뀌는 짧은 틈은 남는다(지금도 조회 시점 확인이며 다음 동작에서 다시 확인).
- 묘비 상한에 닿으면 새 취소는 거절되고(창은 다시 시도) 그동안 그 등록은 지금처럼 TTL 150초가 마지막 방어다.
- 취소가 등록 요청의 서버 도착보다 130초 넘게 먼저 온 경우(요청 전달에 130초 넘게 걸림 — 루프백에선 사실상 없음)에는 묘비가 이미 사라져 그 등록이 수신 창을 만들 수 있고, 그 창은 생성부터 최대 150초 남아 모호를 만들 수 있다.

## 4-1. 이미 한 실측 (dev 513e49df, 고치기 전)
- **Jay Chrome 실제 숨김**(11-20 22:56~23:03): MV Hub 탭을 덮개 탭 뒤로 362초 숨긴 채(흐름 시작 때 335초 숨김) Claude 흐름(선택 읽기·빈 카드 2·연결) 모두 ok, 동작 3개를 숨김 중에 claim, 카드·연결이 숨김 상태에서 생김, 다시 보일 때 "가려진 동안 바깥 앱이 화면을 2번 바꿨어요". 숨김 heartbeat 33회·11초 간격(5분 넘어도 강한 감속 관측 안 됨 — 타이머를 fetch 응답 뒤에 다시 거는 구조라 Chrome 의 이어진 타이머 조건에 안 걸리는 것으로 추정). 확장 도구가 탭을 조회하면 그 순간 '보임'이 되므로 실행 중엔 손대지 않았다.
- 같은 실측 준비 중 N5 를 발견했다(2장).

## 5. 완료 조건과 시험 (저장소 루트, 파일별 run-test — 300초 한도)
- lows-server: `backend/tests/test_mcp_screen_actions.py`(씬 불일치 코드·표 유지 뒤 바른 씬 한 번 성공·두 번째 거절·같은 표 동시 요청 하나만·씬 없는 수신 창은 screen_scene_unavailable, 등록 값 취소의 앞/뒤 도착·서버 등록 성공→응답 유실→취소·다른 계정/결합값 무시·묘비 150초 만료 경계(만료 직전 저장은 막힘, 만료 직후 저장은 수신 창이 생기고 TTL 150초 — 기대값 명시)·처리 20초 넘긴 등록은 저장 안 됨·상한에서 새 취소 429 이고 살아 있는 묘비 유지·등록 값 길이 검사, 고른 창 끔/해제/만료 시 선택 풀림·남은 하나 자동·둘이면 모호(기존 80줄 부근 기대값 변경), 계정 조회·팀 권한 조회·생성물 조회를 각각 멈춘 동안 다른 등록이 끝남) · `test_mcp_bridge.py`
- lows-ui: `frontend/tests/mcpScreenActions.test.tsx`(등록 중 pagehide → 등록 값 keepalive 취소, 등록 시간 초과·응답 유실 → 즉시 취소·취소 성공 응답 전까지 목록 유지·429 면 다음 차례 재시도·목록 4개면 새 등록 미룸, 토큰 바뀜 → 붙잡은 옛 토큰으로 해제·연결 바뀜이면 안 보냄, 토큰이 바뀌는 순간 등록 진행 중이면 옛 토큰으로 등록 값 취소, 기존 시험 전부)
- lows-adapter: `tools/mcp_adapter/test_server.py`·`test_persistent.py`·`test_update.py`·`test_local_setup.py`
- lows-regression: 백엔드 `test_realtime_ws.py`·`test_agent_chat_screen_actions.py`·`test_mcp_persistent.py`, 프런트 `src/lib/progressSocket.test.ts`·`tests/mcpQuickConnect.test.tsx`·`mcpRegistration.test.tsx`·`agentChatConnect.test.tsx`·`agentSettingsInstall.test.tsx`·`agentChatPanel.test.tsx`
- lows-build: `test_architecture_boundaries.py`(기존 순환 실패 1개만 `-k` 제외 — 앞 기록 6장), `lint:architecture`, `build`
- lows-docs: `tools/check_code_map.py`, `tools/gen_inventory.py --check`, `test_docs_inventory_fresh.py`
- lows-real(dev 허브 8012·5173, MV 생성 0): 다른 씬 → `screen_scene_mismatch` 뒤 같은 표로 바른 씬 성공 · 고른 창 끔 → 남은 켠 창이 대상(N5 반대 확인) · 기본 흐름 회귀(켬 → 빈 카드 2·연결·되돌리기) · Jay Chrome 에서 **실제 숨김 5분 넘게** 뒤 Claude 흐름(카드·연결)과 다시 보일 때 알림, 숨김 heartbeat 간격 기록 · 실측용 씬 삭제·스위치 원래 값·생성 0 — 스크래치 판정 스크립트가 관측 자료로.

## 6. 검토 기록
- 1차(계약 74eb5072): Codex `01a1f849…`(gpt-6-astra·high·읽기 전용 이어 받기) = 수정 필요 — P2 3(L2 잠금 안 상류 조회가 계정 말고도 팀 권한·생성물 · N1 시간 초과 뒤 고아 등록 · N1 상한에서 살아 있는 묘비 제거) + 낮음 4(L3 잠금 안 처리·동시 요청 시험, N5 기존 시험 기대값, N2 로그아웃 설명, N4 문구). Claude `2b064009-cdf7-431c-be2b-230ab72c8878`(claude-opus-5-5·Read/Grep/Glob) = 동의(VIBE-AGREE) + 낮음 8(씬 없는 수신 창 코드·등록 값 길이·같은 보내기 함수·invalidate 는 이미 처리·시간 초과 경로·L2 오류 우선순위·숨김 판정 조건·기록 파일 목록 — 마지막은 기록 파일을 touched_paths 에 넣지 않는 검사기 규칙이라 반영 안 함). → 모두 3·5장·계약에 반영해 2차.
- 2차(계약 46f888d8): Claude `2b064009`(이어 받기) = 동의(VIBE-AGREE) + 낮음 3(목록 꽉 참·씬 없을 때 표 유지·비교값 한 번에 읽기 — 구현 요청에 반영). Codex `01a1f849` = 수정 필요 — P2 1(묘비 만료 직후 늦게 저장된 등록은 그때부터 150초 더 남아 "TTL 로 같은 시각에 사라진다" 설명이 틀림) + 낮음 2(목록 꽉 참·429 취소 재시도, N4 미선점/선점 구분). → 서버 처리 20초 상한·남는 경우 위험 명시·만료 경계 기대값·429 재시도·목록 꽉 참·N4 문구 반영해 3차.
- **양측 합의 3차(계약 187a5312) = 합의**: Codex `01a1f849…`(읽기 전용 이어 받기) "P1·P2 없음" + 낮음(20초는 라우터 첫 비동기 대기 전부터·저장 직전 잠금 안 단조 시계로 재검사, '루프백에선 사실상 없음'은 실측 빈도가 아닌 추정) · Claude `2b064009…` 동의 + 낮음(429 아닌 명시 거절 4xx 취소는 목록에서 뺌 — 허브 바뀜 403 등이 영영 남아 목록이 차는 것 방지). 두 낮음은 구현 요청에 반영.
- 구현(Codex `01a1f849…` 이어 받기·gpt-6-astra·high·workspace-write, 작업실 `codex/mvagent-mcp-screen-lows`) 후보 `b163eba8`(12파일, 기준 dev 9bbda63c). 합의 낮음(목록 꽉 참·씬 없을 때 표 유지·비교값 한 번에 읽기·429 아닌 4xx 취소는 목록에서 뺌·20초는 첫 비동기 대기 전부터)도 반영. 샌드박스 탓 실패(프런트 `.vite-temp` EPERM·어댑터 서비스 계정 제한)는 총괄이 밖에서 다시: 프런트 10파일 251 통과·build·lint, 어댑터 4종 OK(1 건너뜀: 심볼릭 링크 권한), 백엔드 6파일 392 통과, 구조 경계 3 통과(기존 순환 실패 1개만 제외), 코드맵·인벤토리 통과.
- 독립 리뷰 Claude `9b9b9c6a-2b1c-42de-8348-7bc47ab83f80`(claude-opus-5-5·Read/Grep/Glob 읽기 전용, 이번 합의·설계 불참, 대상 b163eba8·지문 5135b4b8) = **PASS**(높음·중간 없음). 낮음 6(반영 안 함, 사유): ① 커밋 안 `_screen_binding` 재계산이 화면 서비스 잠금을 쥔 채 돌아 이벤트 루프가 수 ms 멈출 수 있음 — 그 재계산은 커밋 시점의 로그인·결합 보안 재확인이라 밖으로 빼지 않음(지연은 측정 안 한 추정) ② 회수된 연결도 잠금 밖 조회를 한 번 함 — 3장에 기록·수용 ③ 같은 계정 다른 세션이 묘비 몫을 채울 수 있음 — 4장 수용 범위 ④ 프런트 시간 초과·pagehide 동기 시작은 코드로만 확인(시험은 모의) ⑤ 다른 계정 취소 HTTP 시험은 머리글 검사에서 끝남(서비스 단위 시험이 계정 대조를 덮음) ⑥ endpoints.md 는 새 엔드포인트가 없어 그대로.
- 실측(lows-real, dev 허브 8012·5173 = 후보 지문 5135b4b8, test_dev 23:3x 재시작, MV 생성 0) — 판정 스크립트 9/9 통과: 다른 씬 → `screen_scene_mismatch`(새 안내 문구) → 같은 표로 바른 씬 ok → 같은 표 세 번째 `screen_context_invalid` · N5 내장 창 [이 창 사용] 뒤 끄면 선택이 풀리고(`multiple:false`) 화면 읽기가 남은 Chrome 창으로(고치기 전 같은 순서 = `screen_unavailable`) · 회귀 켬 → 선택 읽기·빈 카드 2·연결 ok, 보드 카드 2·연결 1 → 되돌리기 0·0 · **Jay Chrome 실제 숨김 391초**(흐름은 숨은 지 361초 뒤) 동안 동작 3개 claim·카드 2·연결 1 이 숨김 중 생김, heartbeat 36회 11초 간격, 다시 보일 때 "가려진 동안 바깥 앱이 화면을 2번 바꿨어요" · 새로고침 직후 화면 읽기 모호 없음 · 정리(실측용 씬 삭제·두 브라우저 스위치 끔·Chrome 탭 4개 닫음·dev DB 읽기 전용 생성 표 새 줄 0).
- 시험 기록 23개(조건 7개) 모두 통과 — verification 참조.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-mcp-screen-lows-2026-11-20",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925"},
  "risk": {"level": "major", "reason": "바깥 MCP 화면 편집 권한 경로의 후속 — 화면 표 소비 순서·수신 창 해제(자격 없는 등록 값 해제)·대상 선택 규칙·전역 잠금 안 상류 조회 이동(동시성)"},
  "goal": "바깥 화면 편집(dev 513e49df)의 남은 낮음을 정리한다: 다른 씬을 가리키면 원인이 보이는 screen_scene_mismatch 로 거절하고 표는 버리지 않으며, 등록 도중 창을 떠나도·로그인 토큰이 바뀌어도 옛 수신 창을 바로 해제하고, 고른 창이 끄거나 사라지면 선택을 풀어 남은 켠 창이 대상이 되게 하며, 화면 권한 검사의 공유 서버 조회를 전역 등록 잠금 밖으로 옮긴다. 기본 끔·일회용 표·세대·한도·칸 경로·창 둘이면 모호·얼린 탭 미실행은 그대로 둔다.",
  "touched_paths": [
    "backend/app/routers/mcp_v2.py",
    "backend/app/services/mcp_screen.py",
    "backend/tests/test_mcp_screen_actions.py",
    "backend/tests/test_mcp_bridge.py",
    "frontend/src/lib/useMcpScreenActions.ts",
    "frontend/tests/mcpScreenActions.test.tsx",
    "tools/mcp_adapter/server.py",
    "tools/mcp_adapter/test_server.py",
    "tools/mcp_adapter/test_persistent.py",
    "tools/mcp_adapter/test_update.py",
    "docs/CODE_MAP.md",
    "docs/CURRENT_STATUS.md",
    "docs/inventory/endpoints.md"
  ],
  "criteria": [
    {"id": "lows-server", "success": "씬 불일치는 화면 서비스 잠금 안에서 표를 꺼내기 전에 screen_scene_mismatch 로 거절하고 표를 남겨 같은 표로 바른 씬이면 기한 안에 한 번만 실행(두 번째는 screen_context_invalid, 같은 표 동시 요청은 하나만), 씬 없는 수신 창의 캔버스 동작은 screen_scene_unavailable, 등록 값(32~100자) 취소는 같은 계정·결합값에서만 즉시 해제 또는 150초 묘비로 뒤늦은 등록 차단(앞/뒤 도착·서버 등록 성공 뒤 응답 유실·다른 계정/결합값 무시), 묘비 만료 직전 저장은 막히고 만료 직후 저장은 수신 창이 생겨 TTL 150초(기대값 명시), 처리 시작부터 저장까지 20초를 넘긴 등록은 저장 안 됨, 묘비 상한(계정 16·전체 512)에서는 살아 있는 묘비를 지우지 않고 새 취소를 429 로 거절, 등록 값 없는 수신 창은 어떤 취소와도 안 맞음, 고른 수신 창이 끔·해제·만료되면 선택이 풀려 남은 켠 창 하나는 자동·둘이면 screen_ambiguous, 화면 권한 검사의 상류 조회(계정·팀 권한·생성물)는 registration_lock 밖에서 먼저 하고 잠금 안에서 로그인·연결 권한과 화면 세대·공간·씬을 다시 본 뒤 커밋하며 각 상류 조회가 멈춘 동안 다른 등록이 끝남, 앞 묶음 화면 시험 전부 통과(바뀐 기대값 1건 명시)", "failure": "시험 실패 또는 표가 소비 규칙을 벗어나 두 번 쓰이거나·다른 계정 수신 창을 해제하거나·꺼진 고른 창 때문에 켠 창이 대상이 안 되는 경로 존재", "required": true, "verification": ["f407ddd6bdaf42e0a0a5c6d9e9514429", "f538332955124b0d9b2b5a9fc98d31da"]},
    {"id": "lows-ui", "success": "등록 값은 요청 전에 '확인 안 된 등록' 목록(최대 4)에 넣고 응답(성공·명시 거절)이나 취소 성공 응답을 받을 때만 빼며, 시간 초과·응답 유실이면 즉시 취소하고 취소가 429·오류면 값을 남겨 다음 차례 재시도, 목록 4개면 새 등록을 미루고, pagehide 면 남은 값을 keepalive 로 취소, 로그인 토큰이 바뀌면 효과 시작 때의 토큰·계정으로 옛 수신 창 해제와 진행 중 등록 값 취소를 같은 보내기 함수로 보내며(연결이 바뀌면 안 보냄), 앞 묶음 화면 동작 시험 전부 통과", "failure": "시험 실패 또는 해제가 지금 토큰으로 나가거나 등록 중 이탈에 해제가 없음", "required": true, "verification": ["e1e28a6801b843f3893bcc9948ee0129"]},
    {"id": "lows-adapter", "success": "어댑터 오류 표에 screen_scene_mismatch 문구(read_context 다시)·ADAPTER_VERSION 2026.11.20.3·일반/칸 도구 표면 지문 불변·업데이트 계약 불변 시험 통과", "failure": "시험 실패 또는 도구 표면·업데이트 계약 변경", "required": true, "verification": ["c3056bc1c2c04a35b67adc30c7ff06d1", "7474075ef6f04825bb65c6a1145d7735", "c182ab3139314d81b6461d349b0dcc39", "ff66df04d2f5490e9f58d9aa395c7214"]},
    {"id": "lows-regression", "success": "WS·칸 화면 동작·영속 연결·진행 소켓·연결/동의 화면·칸 패널 기존 시험 통과", "failure": "기존 동작 회귀", "required": true, "verification": ["d1ff07add7b741469e28565ea0b4f4f4", "346dee4bd2284e9399f54f2a2fd2f63a", "5fc2cf93a30d40f99c5aec6aacfe33e3", "ac54fcd1e1384f47af7f25255ef3ed65", "3bd3ee92ec2d41dfa4a3956d982aa32f", "86282ef9b2274ce4ac9b0cf2a1f7928e", "720b1b3140f842e19a872c16ce5ad034", "a920749068b2476dbfd48d100f0ce9d7", "6aad6536cc5f461f8d2113447ef43413"]},
    {"id": "lows-build", "success": "test_architecture_boundaries(기존 순환 실패 1개만 제외)·lint:architecture·build 통과", "failure": "검사·빌드 실패", "required": true, "verification": ["000c75cdfc484d49818d84d5af93c1c7", "f99faf978f3f4e34a0c939911017b89d", "2bd7cb884f8b40a696256e103415369e"]},
    {"id": "lows-docs", "success": "check_code_map·gen_inventory --check·test_docs_inventory_fresh 통과", "failure": "목록·코드맵 낡음", "required": true, "verification": ["4f0b345711304963be7474bc7d3e2dba", "b0bbcae7c78c4cd381a92c10223064e6", "7e5d2fd4618248d597d4ca30cc603768"]},
    {"id": "lows-real", "success": "dev 허브 실측(MV 생성 0): 다른 씬 → screen_scene_mismatch 뒤 같은 표로 바른 씬 성공, 고른 창 끔 → 남은 켠 창이 대상, 켬 → 빈 카드 2·연결·되돌리기 회귀, Jay Chrome 에서 실제 숨김 5분 넘게 뒤 Claude 흐름(카드·연결)이 숨김 중 실행되고 다시 보일 때 알림·숨김 heartbeat 간격 기록(Chrome 이 탭을 얼린 것이 확인되면 '미실행 + expired_unclaimed' 도 설계대로 통과), 실측용 씬 삭제·스위치 원래 값·생성 0 — 스크래치 판정 스크립트가 관측 자료로 판정", "failure": "어느 경로든 미반영·잘못된 창/씬 변경·거절돼야 할 상태에서 실행·생성 제출·정리 미완료", "required": true, "verification": ["cc6e636545c24de4b29a5c59eca7b1f3"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "씬 불일치는 표 확인 뒤·소비 전에 전용 코드 screen_scene_mismatch 로 거절하고 표를 남긴다", "why": "실측에서 공용 코드 screen_context_invalid 로는 바깥 AI 가 원인을 못 가렸고, 씬만 틀린 요청 때문에 표를 버릴 까닭이 없다. 표는 여전히 연결·창·세대에 묶여 한 번만 쓰인다", "alternative": "표를 꺼낸 뒤 전용 코드만 바꾸기 / 문구만 바꾸기", "revisit": "씬 번호 떠보기 남용이 보이면 불일치도 소비"},
    {"choice": "등록 도중 이탈·시간 초과·응답 유실은 창이 요청 전에 만든 일회 등록 값으로 취소하고, 서버가 같은 계정·결합값 안에서만 150초 묘비로 처리하며 상한에서는 살아 있는 묘비를 지우지 않고 새 취소를 거절한다", "why": "pagehide·시간 초과 시점엔 수신 자격이 없거나 서버 처리 여부를 몰라 기존 해제가 불가능하다. 등록 값은 창 메모리에만 있고 계정·결합값으로 묶여 남의 수신 창을 못 건드린다. 살아 있는 묘비를 밀어내면 취소한 등록이 되살아난다(Codex 설계 확정 P2). 서버 처리 20초 상한으로 서버 쪽 지연을 묶고, 남는 경우(요청 전달 130초 초과)는 위험에 명시한다(Codex 2차 P2)", "alternative": "TTL 150초에 맡김(지금) / 탭 번호로 같은 창 재등록 덮기(탭 번호는 자격이 아님·복제 탭에서 서로 밀어냄)", "revisit": "없음"},
    {"choice": "옛 수신 창 해제는 효과 시작 때 붙잡은 토큰·계정으로 keepalive fetch 를 직접 보낸다", "why": "jsonFetch 는 지금 토큰으로 Authorization 을 덮고 서버 결합값에 토큰 해시가 있어, 토큰이 바뀌면 해제가 거절돼 TTL 동안 모호가 생긴다", "alternative": "토큰이 다른 같은 계정 수신 창을 서버가 등록 때 밀어내기(다른 브라우저 같은 계정끼리 서로 밀어냄)", "revisit": "없음"},
    {"choice": "선택은 고른 수신 창이 살아 있고 켜져 있을 때만 유효하고, 끔·해제·만료·무효화 때 지운다", "why": "고른 창을 끄면 켠 다른 창이 있어도 screen_unavailable 이 났다(Jay Chrome 실측). 명시 선택의 목적은 켠 창들 사이의 혼동 방지이지 꺼진 창 고정이 아니다", "alternative": "target 에서만 무시(상태가 남아 응답 multiple 표시가 계속 틀림)", "revisit": "없음"},
    {"choice": "화면 권한 검사의 상류 조회(계정·팀 권한·생성물)를 registration_lock 밖으로 옮기고 잠금 안에는 로컬 확인·화면 세대 재확인과 커밋만 둔다", "why": "느린 공유 서버 응답이 전역 등록 잠금을 붙잡아 다른 등록·권한 검사까지 멈출 수 있다(앞 리뷰 L2, Codex 설계 확정 P2 — 계정 조회 말고도 팀 권한·생성물 조회가 상류로 나간다). 상류 확인은 원래 조회 시점 확인이라 잠금이 지켜 주던 것이 아니다", "alternative": "잠금 유지(지금) / 상류 결과 캐시", "revisit": "상류 상태 경합 문제가 보이면 결과에 세대 표식"}
  ],
  "evidence": {"target": {"kind": "revision", "revision": "b163eba8aba87a56f50395a7a1bd1cb66f9566be"}, "consensus": [
    {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/20/rollout-2026-11-20T18-28-53-01a1f849-912c-7cb0-b22d-ca17d956a925.jsonl"},
    {"host": "claude", "session": "2b064009-cdf7-431c-be2b-230ab72c8878", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-lows-agree/2b064009-cdf7-431c-be2b-230ab72c8878.jsonl"}
  ], "review": {"host": "claude", "session": "9b9b9c6a-2b1c-42de-8348-7bc47ab83f80", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-review-screen/9b9b9c6a-2b1c-42de-8348-7bc47ab83f80.jsonl"}, "design_sessions": [
    {"host": "codex", "session": "01a1f849-912c-7cb0-b22d-ca17d956a925"}
  ]}
}
```
