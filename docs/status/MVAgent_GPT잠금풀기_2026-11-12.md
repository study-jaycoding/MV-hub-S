---
status: active
updated: 2026-11-14
---

# MV Agent ChatGPT(Codex) 잠금 풀기 — 설정 쪽 [연결]로 이 PC 에서 켜기 (2026-11-12)

owner: Claude(설계) · Codex(설계 확정·구현) · reviewer: Claude(구현 리뷰·시험) + 다른 세션 독립 리뷰(최상위 읽기 전용) · status: 완료(dev 커밋 — 독립 리뷰 PASS·integrate 통과, Jay 화면 확인 전) · updated: 2026-11-14

> [!NOTE]
> **11-14 실측 끝 → 2판.** 11-12 저녁 보류(대조 시험의 `--dangerously-bypass-hook-trust` 가 자동 권한 판정에 막힘)는 Jay 가 11-14 "허락"(임시 폴더에서 이 플래그로 대조) → 실측. 1차(06:26)는 내 훅 파일 실수로 대조가 안 돌았고, 고친 2차에서 **대조 성공 · 칸 명령은 훅을 막음**(2-8). Jay 11-12 "gpt잠금 풀어서 설정할수있게하기" → 이 2판으로 진행.

## 1. 요청과 사실

- Jay 11-12: 설정 창에서 "클로드나 코덱스 연결도 가능하다면 연결도 여기서" → 남은 목록 "GPT(Codex) 잠금 풀기 조건(허용 밖 도구 3개를 받아들일지·팀 전체에 열지)" → **"모두 구현하자. 설계부터 확정하고 바로 구현"**(결정은 추천안으로 — 이 기록 2절). 11-12 밤 "gpt잠금 풀어서 설정할수있게하기".
- 지금(코드 확인): `agent_chat_process.CODEX_LOCK` 한 줄이 엔진을 잠근다(`engine_problem` → 칸 메뉴에 "점검 필요"). 실행 명령(`build_command` — 기능 16개 끄기·`--sandbox read-only`·`--ignore-user-config`·`--ignore-rules`·MCP = `mvhub_panel` + `enabled_tools`)·해석기(`CodexParser` — 4종 위반 = 바로 끔, **그 밖 모르는 항목은 그냥 넘김**)·판 고정(`CODEX_VERIFIED = 0.162.0-alpha.17.2`, 이 PC 판도 같음)·구독 확인(`login status` 에 ChatGPT)은 이미 있다.
- 0단계 실측(옆 칸 설계 6-1, 11-09): 노출 도구 = 조건부 통과 — 남은 것 `apply_patch`·시계·MCP 자료 3개(list/read resources·templates)·칸 도구. 전역 지침 `~/.codex/AGENTS.md` 는 늘 들어감(Jay 11-09 허용).

## 2. 설계 2판(추천안 — Jay '모두 구현' 위임)

### 2-1. 범위 = PC 마다 사람이 켠다(기본 꺼짐)
- `CODEX_LOCK` 상수를 지우고 **이 PC 의 표식** `AGENT_CHAT_DIR/codex_enabled.json` = `{"version": "<켠 때 Codex 판>", "policy": CODEX_POLICY, "at": "<ISO 시각>"}` 이 맞을 때만 연다.
- `CODEX_POLICY` = 격리 정책 판(처음 `"2026-11-14"`). 칸 명령의 격리 줄(기능 끄기·샌드박스·설정 무시)이나 해석기 허용 목록을 바꾸면 올린다 → 옛 표식은 낡아 다시 [연결]. 시간 만료는 두지 않는다 — 판이 같으면 이번 실측과 같은 실행 파일이고, 서버 쪽 변화(새 항목 종류)는 해석기 허용 목록이 차례마다 잡는다(2-3).
- `engine_problem("codex")` 순서: 설치 없음 → **표식 없음·깨짐("꺼져 있어요 — 설정에서 [연결]을 눌러 켜요", 프로세스를 띄우지 않음)** → 판 확인 실패·미검증 판 → 표식의 판·정책 ≠ 지금("격리 정책이나 Codex 판이 바뀌어 다시 연결해야 해요") → 작업 폴더 검사 → 로그인(`auth_problem`).
- **엔진 목록도 같다**(2차 검토 P2-1): 표식 없음·깨짐이면 `engines()` 의 Codex 줄도 `cli_version()`·`auth_problem()` 을 부르지 않는다 — 판은 표식에 남은 값이 있으면 그것, 없으면 비운다. 판 확인 프로세스는 표식이 있을 때만(켜진 PC) 띄운다.
- **작업 폴더 검사**(새, 2-8 B 실측 근거): 칸 작업 폴더 `AGENT_CHAT_DIR/work` 에 `AGENTS.md`·`AGENTS.override.md`·`.codex` 가 있거나, 그 폴더나 위 폴더에 `.git`(폴더든 파일이든 — worktree 는 파일) 이 있으면 문제("작업 폴더에 다른 지침 파일이 있어요" 류). Codex 는 Git 뿌리부터 작업 폴더까지의 AGENTS.md 를 읽는다 — 이 PC 의 다른 프로그램이 넣은 지침이 칸 대화에 섞이지 않게. 차례마다 본다(stat 몇 번).
- 공유 서버는 칸이 안 붙으니 그대로 제외. 팀 PC 는 각자 켤 때만 열린다.

### 2-2. 받아들이는 것(근거와 막는 장치)
- `apply_patch`: **샌드박스가 거절**(2-8 D — "writing is blocked by read-only sandbox", 파일 안 생김, `file_change` 항목도 안 나옴). 해석기의 `file_change` 감지는 보조.
- 시계: 시각만 — 해 없음.
- MCP 자료 3개: 붙은 서버 = `mvhub_panel` 하나(사용자 설정은 `--ignore-user-config` 로 안 읽음). 칸 모드 어댑터는 자료(MCP Apps HTML)를 등록하지 않아야 한다 → **시험으로 못 박는다**(1차 검토 P1 ②). **정정(11-14 구현 중)**: 설계 때 `server.py:991`(`apps = … and not panel`)만 보고 '이미 막혀 있음'이라 적었는데, 새 시험이 칸 모드에서 자료 1개를 잡았다 — `server.py:1183` 의 대체 등록 분기 `if native and apps is None:` 가 칸 모드(`apps` = None)에서도 `RESULT_UI_URI` 를 등록한다. 칸 모드에선 이 자료를 참조하는 도구가 없다(`apps` 없음) → 그 분기에 `and not panel` 을 더하고 `ADAPTER_VERSION` 을 `2026.11.14.1` 로 올린다(설치된 PC 가 새 어댑터를 받게). 계약 범위에 `tools/mcp_adapter/server.py` 추가.
- **스킬 목록 글**(새, 2-8): `~/.codex/skills`·`~/.agents/skills` 의 이름·설명·경로가 지침 글로 들어간다. 끄는 공식 설정이 없다(`skip_host_skill_discovery` 는 개발 중이고 실측에서 안 빠짐). 칸에는 파일을 여는 도구가 없어(셸·unified_exec·view_image 끔, 읽기 전용, MCP = 칸 도구만) 본문은 못 연다 → 전역 AGENTS.md(Jay 11-09 허용)와 같은 급의 '글 유입'으로 받아들인다. 끌 공식 길이 생기면 끈다.
- 이 밖의 도구·항목은 위반으로 끈다(2-3).

### 2-3. 해석기 = 알려진 항목만(1차 검토 P1 ①)
- 이 판의 exec JSON 항목 종류(실행 파일 문자열로 확인, 2-8): `agent_message`·`reasoning`·`command_execution`·`file_change`·`mcp_tool_call`·`collab_tool_call`·`web_search`·`todo_list` (+ `error`).
- 허용 = `agent_message`·`reasoning`·`todo_list`·`error`·`mcp_tool_call`(`mvhub_panel` + `PANEL_TOOLS` 만 — 지금 그대로).
- 위반 = `command_execution`·`file_change`·`web_search`·`collab_tool_call` + **목록 밖 모든 종류(종류 없음 포함)** → 바로 끈다(지금 위반 처리, detail 에 종류 이름).
- **`item.started`·`item.updated`·`item.completed` 셋 다** 항목 종류와 MCP 서버·도구를 검사한다(2차 검토 P2-2 — 지금은 `item.updated` 가 검사 전에 버려진다). 글은 `item.completed` 에서만, 도구 상태는 started·completed 에서만 낸다. 그 밖의 `item.*` 이벤트 이름도 위반.
- 최상위 이벤트(`thread.started`·`turn.*`·`item.*`·`error`) 밖은 지금처럼 무시 — 행동은 항목으로만 나온다.

### 2-4. 켜기 점검(1차 검토 P1 ③) — `POST /api/agent-chat/codex/enable`(칸 인증)
- 순서: 판 ∈ `CODEX_VERIFIED` → `auth_problem` 없음 → 작업 폴더 검사 통과 → **점검 차례 1번** → 표식 쓰기. 실패면 까닭을 돌려주고 표식을 쓰지 않는다.
- 점검 차례: 칸과 **같은 `build_command("codex", …)`** 에 `mcp_entry` 만 허브 안 **가짜 점검 서버**로 — `backend/app/services/agent_chat_probe_mcp.py`(표준 라이브러리만, `[sys.executable, "-I", <그 파일>, <nonce>]`). 서버 도구 = `check_connection` 하나(부르면 nonce 글), resources·templates = 빈 목록, MV 실행 도구 없음. 모델 = `MODELS["codex"]` 첫 모델, 깊이 low. 프롬프트 = "연결 점검: check_connection 을 정확히 한 번 부르고 돌려받은 글만 그대로 답하라".
- 통과 = `turn.completed` · 위반 0(2-3) · `mvhub_panel.check_connection` 완료 정확히 1번 · 마지막 답에 nonce · 120초 안 · Job 회수 0개 확인.
- 실행 = 칸 차례와 같은 `JobProcess`(멈춘 채 생성 → Job 배정 → 재개, 끝나면 `reap`), 작업 폴더 = `AGENT_CHAT_DIR/work`. 구독 차례 1번(MV 과금 없음).
- 요청이 끊겨도 점검은 끝까지 돌고 회수한다(포크 라우트처럼 취소 가림 — Job 이 남지 않게).
- 코드 자리: 표식·pending·잠금·작업 폴더 검사·점검 실행 = 새 `backend/app/services/agent_chat_codex.py`. `agent_chat_process.engine_problem` 은 거기의 표식 판정을 부른다. 가짜 점검 서버 = `agent_chat_probe_mcp.py`(표준 라이브러리만).

### 2-5. 끄기·경합(1차 검토 P2)
- `POST /api/agent-chat/codex/disable` → 표식 지움.
- 켜기는 한 번에 하나(이미 점검 중이면 409 "확인하는 중이에요"). 점검 중에 끄면 켜지지 않는다.
- **파일 잠금 둘**(2차 검토 P1 · 3차 재확인 P2): 같은 PC 의 여러 허브(8010 로컬 허브·8012 dev 허브)가 같은 표식을 보므로(설정 `.bat` 들이 `CONTENT_HUB_AGENT_CHAT_DIR` 을 따로 주지 않음 — Claude 합의 검토 확인) 프로세스 안 잠금이 아니라 `msvcrt.locking` 파일 잠금(`resolve_panel_installer.py` 선례. Claude 잠금은 이름 있는 뮤텍스라 다름). 파일 잠금은 쥔 프로세스가 죽으면 OS 가 푼다 → **만료 시간을 두지 않는다**.
  - **실행 잠금** `AGENT_CHAT_DIR/codex_probe.lock`: 켜기가 **시작부터 Job 0개 확인까지** 쥔다(LK_NBLCK — 못 잡으면 바로 409 "확인하는 중이에요"). 같은 허브 안 두 번째 요청도 다른 파일 핸들이라 막힌다. **회수(`reap`)가 False 면 잠금을 쥔 채 회수를 다시 시도한다 — 0개를 확인한 뒤에만 놓는다**(일반 차례가 회수 확인 전엔 차례를 풀지 않는 것과 같게). 끄기·만료는 이 잠금을 풀지 않는다.
  - **상태 잠금** `AGENT_CHAT_DIR/codex_enabled.lock`: 짧게만 쥔다. 그 아래에서만 ① 켜기 시작 = 활성화 token `codex_pending.json`(`{"token": 무작위, "at": 시각}`)을 내 것으로 쓴다(실행 잠금을 쥔 뒤라 남의 살아 있는 켜기는 없다 — 남은 파일은 죽은 켜기의 찌꺼기) ② 켜기 끝 = pending 의 token 이 내 것인지 확인 → 표식 교체(임시 파일 → 바꿔 넣기) → pending 지움, **확인부터 교체까지 잠금을 놓지 않는다** ③ 끄기 = pending(= 진행 중 켜기의 token 취소)·표식 둘 다 지움. 점검 실패도 내 token 일 때만 pending 을 지운다. 끄기는 상태 잠금을 짧게 기다려 잡고(LK_LOCK), 끝내 못 잡으면(`OSError`) 409 "잠시 뒤 다시".
- 구현 메모(Claude 재확인 P3-c): `agent_chat_process.engine_problem` ↔ `agent_chat_codex` 가 서로 import 하지 않게 — 표식 판정은 import 없는 쪽에 두거나 함수 안에서 부른다.
- 끄기는 이미 도는 Codex 차례를 멈추지 않는다 — 다음 차례부터 막힘(차례 시작·실행 직전 두 번 `engine_problem`).
- 둘 다 엔진 캐시를 새로 하고 `engines` 를 돌려준다.

### 2-6. 화면(1차 검토 P2 '허용'과 '로그인' 구분)
- 엔진 줄(codex)에 `enabled: bool`(표식이 지금 판·정책과 맞음)을 더한다. `available` 은 지금처럼(`engine_problem` 없음).
- 설정 쪽 ChatGPT 줄: 작은 글 = `Codex <판> · <꺼짐 | 이 PC 에서 켬> · <연결됨 | 까닭>`. 단추 = 꺼짐이면 **[연결]**(누르는 동안 '확인하는 중', 실패면 까닭을 줄 아래에), 켬이면 **[끄기]**.
- 모델 칩 메뉴는 그대로(`available` 만 본다). `useAgentChat` 이 켜기·끄기를 내고 응답의 `engines` 로 바꾼다.

## 2-7. 1차 설계 검토(Codex, 11-12) — 2판 반영 표(1판 번호)
- P1 ① 모르는 항목 통과 → 2-3 허용 목록 · ② 칸 어댑터 HTML 자료 → 2-2 시험으로 못 박음 · ③ `ping` 이 `enabled_tools` 밖 → 2-4 가짜 `check_connection`+nonce · ④ 한 번 정상 = 격리 증거 아님 → 2-8 실측(apply_patch 거절·프로젝트 `.codex` 안 읽힘·AGENTS.md 읽힘 → 2-1 작업 폴더 검사·스킬 → 2-2) · ⑤ 새 차례·이어 가기 대조 → 2-8 A3·E3 성공, C3·F3 막음.
- P2 표식 수명·정책 판 → 2-1 · 켜기/끄기 경합 → 2-5 · '허용됨'과 '로그인됨' → 2-6.
- **2차 검토(Codex 11-14, thread `01a1d6d9-abb6-7262-8bf6-168446cd10a4`, 도구 0회)**: 1차 ①=부분(item.updated 빠짐) ②③④⑤=해소 · P2 경합=부분. 새 지적 P1 '끄기 성공 뒤 켜기가 표식을 다시 씀(세대 확인~교체가 한 잠금 아님)' → 2-5 파일 잠금+pending token · P2-1 '꺼진 상태 엔진 목록이 `--version` 을 띄움' → 2-1 · P2-2 'item.updated 미검사' → 2-3. 셋 다 반영(방향 변경 없음). 반영본 재확인 = 해소·새 P1/P2 없음 → **VIBE-AGREE**(같은 thread, 실제 모델 `gpt-6.1-sol`).
- **Claude 합의 검토(11-14, 읽기 전용 `claude -p` 세션 `05db43d2-8576-48bf-b67b-c12c2eab85b6`, claude-opus-5-5)**: 격리 경계·실측 정합·구현 가능 = 맞음. P2 '점검 통과 조건 6개를 실패 시험으로 하나씩 확인하지 않음' → 3절 실패 시험 · P3 잠금 선례 오기(Claude 잠금 = 뮤텍스, 파일 잠금 선례 = `resolve_panel_installer.py`)·pending 만료 180→245초·회수 실패 때 pending 유지·새 모듈 자리·`.git` 파일 형태·정책 문구 → 2-1·2-4·2-5 반영. 재확인 = PASS·VIBE-AGREE(같은 세션), 남은 P3(회수 중 pending 시각·끄기 잠금 실패·서로 import) → 2-5 반영.
- **Codex 3차 재확인(같은 thread)**: P2 '회수가 245초 넘게 실패하면 만료 규칙 때문에 다른 허브가 새 점검을 시작해 겹침' → 2-5 를 실행 잠금(시작~Job 0개 확인)·상태 잠금 둘로 바꾸고 만료 시간을 없앰(죽은 프로세스의 잠금은 OS 가 풂). 4차 재확인 = 해소·새 P1/P2 없음 → **VIBE-AGREE**. **설계 확정(11-14)** → 구현 = 같은 Codex 세션(`harness-codex-builder`, workspace-write), 리뷰 = Claude(시험·범위) + 다른 세션 독립 리뷰(최상위 `claude -p` 읽기 전용, 합의 세션과 다름).
- **구현 1차(Codex, 같은 thread, gpt-6.1-sol high, workspace-write) = BUILD: PARTIAL** — 새 어댑터 시험이 칸 모드 HTML 자료 등록 결함(`server.py:1183`)을 잡음(2-2 정정). 계약에 `tools/mcp_adapter/server.py` 추가 → 새 계약 SHA `dccac34d…4a59` → **두 모델 재합의 VIBE-AGREE**(Codex 같은 thread · Claude 같은 세션 `05db43d2`) → Codex 세션 재bind·implement 검사 ok. 2차 수정 = 1183 `and not panel`·`ADAPTER_VERSION 2026.11.14.1`·꺼진 상태 문구 겹침(Claude 리뷰 P3 → `DISABLED` = "설정에서 [연결]을 눌러 켜요").
- **실측이 잡은 결함(3차)**: 격리 폴더에서 실제 Codex 로 `enable()` → "로그인되어 있지 않습니다". 원인 = 실제 `codex login status` 는 종료 0 으로 "Logged in using ChatGPT" 를 **stderr** 에만 쓴다(직접 재현) → `_status_output` 이 stdout 만 봐 늘 실패(옛 `CODEX_LOCK` 때문에 안 드러났던 결함). 종료 0 이면 stdout+stderr 를 보게 고치고, 가짜 CLI 도 stderr 로 내게 바꿔 회귀 고정(Codex 가 수정 전 재현 → 수정 뒤 통과). 4차 = 새 시험의 자식 파이썬 cwd(저장소 루트 실행에서 `app` 못 찾음).
- **시험 기록(최종 지문 `f8f8d51e…cf47`)**: backend R1 175·R2 50·R3 91·R4 207 passed · 어댑터 R5 Ran 45 OK · screen R6 vitest 126·R7 경계·R8 빌드 · **measure R9 = 실제 Codex 0.162.0-alpha.17.2 로 격리 enable 8초 통과 → 표식 → 사용 가능 → disable → 잠김**. `test_watcher_failure_stops_turn_instead_of_leaving_cli`(3초 한도)는 흔들림 — 변경 전 HEAD 사본에서도 3번 중 2번 실패(Claude 엔진 경로, 무관) → R2 는 재실행 통과분.
- **독립 리뷰(새 Claude 최상위 읽기 전용 `05deaa0d`) = PASS**, P3 4개(기록만, 반영 안 함): ① finally 의 상태 잠금 대기 실패가 원래 예외를 덮음(pending 은 token 대조뿐이라 무해) ② 시간 초과 타이머가 회수 뒤 취소 → 회수가 길면 성공도 '시간 초과'(안전한 거짓 실패) ③ 켜기 실패 때 화면이 새 엔진 목록을 못 받음(표식 불변이라 영향 거의 없음) ④ `CONTENT_HUB_AGENT_CHAT_DIR` 을 Git 저장소 안으로 주면 위 폴더 `.git` 검사로 못 켬(기본 LOCALAPPDATA 는 문제없음 — 이 PC 실측 확인).
- 남은 것: Jay 화면 확인(8012 재시작 필요 — Jay 결정) · 어댑터 판이 올라 릴리스 때 설치 PC 의 어댑터 갱신 확인 · `gen_inventory --check` 의 env_vars.md 불일치는 카메라 측정 세션 몫(범위 밖).

## 2-8. 실측(11-14 · Codex 0.162.0-alpha.17.2 · 임시 폴더 · `--ignore-user-config` · MV 연결 없음 · Codex 구독 차례 12번)
스크립트 = 세션 스크래치 `codexmeasure/measure_codex.py`(1차)·`measure2.py`(2차). 표식 = 훅이 임시 폴더에 쓰는 파일.

| 실행 | 명령 | 결과 |
|---|---|---|
| A3 새 차례 대조 | 세션 훅(`-c hooks.SessionStart/UserPromptSubmit`) + `--enable hooks --dangerously-bypass-hook-trust` | 표식 2개(시작·말) **생김** |
| E3 이어 가기 대조 | 같은 것 + `resume` | 표식 2개 **생김** |
| C3 칸 명령 | 칸 명령 + 같은 세션 훅 + 플래그 | **없음** (`--disable hooks` 가 강제 훅까지 끔) |
| F3 칸 이어 가기 | 칸 명령 + 훅 + 플래그 + `resume` | **없음** |
| A2 프로젝트 훅 | `.codex/hooks.json` + `-c projects.<경로>.trust_level="trusted"` + 플래그 | 없음 — `--ignore-user-config` 아래선 신뢰 덮어쓰기로도 프로젝트 층이 안 읽힘(공식 문서: 프로젝트 훅은 `.codex` 층을 믿을 때만) |
| B 칸 명령 + 작업 폴더 AGENTS.md(카나리) | 칸 명령 | **읽힘**(답 = 카나리 낱말) → 2-1 작업 폴더 검사 |
| D 칸 명령 apply_patch | "made.txt 만들어" | 샌드박스 거절, 파일 없음, `file_change` 항목 없음 |
| G 칸 명령 + `--enable skip_host_skill_discovery` | — | 스킬 목록 그대로 들어감 + '개발 중 기능' 경고 |
| B·F 기록 | 칸 명령 | 지침에 스킬 목록(`<skills_instructions>`) 포함 |

- 1차(06:26) A·C·E 는 표식이 안 생겼다 — 원인 = 내 훅 파일(프로젝트 층이라 위 A2 처럼 안 읽힘 + 따옴표 명령 + JSON 칸 이름 `command_windows`, 공식은 `commandWindows`). 2차는 세션 훅·따옴표 없는 명령으로 고쳐 성공. 플래그가 있으면 exec JSON 에 `error` 항목으로 "`--dangerously-bypass-hook-trust` is enabled…" 경고가 나온다(칸 명령은 이 플래그를 쓰지 않는다).
- 결론: 1차 검토 P1 ⑤(대조 성공 + 칸 명령은 막음) 충족 → 2판 진행 조건 충족.

## 3. 시험
- 백엔드 `test_agent_chat_codex_unlock.py`(새): 표식 없음·깨짐 = 잠금이고 판 확인 프로세스도 안 띄움 · **표식 없음·깨짐에서 `engines(refresh=True)`·엔진 목록 API 도 판·로그인 확인 프로세스 0회** · 판 다름·정책 다름 = 잠금 · 작업 폴더 AGENTS.md·AGENTS.override.md·`.codex`·`.git`(위 폴더 포함) = 잠금 · enable 이 판·로그인·작업 폴더·점검 실패마다 표식 안 씀 · 점검 통과면 씀 · 점검 중 disable → 표식 안 씀 · **enable 의 '확인→교체' 직전에 disable 을 끼워 넣어(동기화) 둘 다 끝난 뒤 표식 없음** · 점검 중 두 번째 enable → 409(같은 허브 안·다른 프로세스 둘 다) · **회수가 오래 실패하는 동안(그 사이 disable 포함) 다른 enable 은 409이고, 0개 확인 뒤에만 새 점검** · 죽은 켜기가 남긴 pending 은 다음 켜기가 덮음 · disable 지움 · **점검 통과 조건을 하나씩 깨는 실패 시험**(가짜 CLI) — `turn.failed`·`turn.completed` 없음·위반 항목(`command_execution`·목록 밖 종류)·`check_connection` 0번/2번·답에 nonce 없음·다른 nonce·시간 초과·회수 실패(`reap` False → 실행 잠금 쥔 채 다시 회수) 각각 표식 안 씀·내 pending 정리·Job 0개 확인 뒤 실행 잠금 놓음 · 점검 명령 = 칸 `build_command`(가짜 서버 `mcp_entry`)이고 `--disable hooks`·`--sandbox read-only`·`--ignore-user-config` 포함 · 점검 시간 초과 → 실패·Job 회수 · 가짜 점검 서버 단위(initialize·tools/list = `check_connection` 하나·tools/call = nonce·resources/templates 빈 목록).
- 해석기 `test_agent_chat_parse.py`: 허용 5종은 위반 아님(정상 `item.updated` 포함) · `item.started`·`item.updated`·`item.completed` 각각에 목록 밖 종류(예: `image_view`)·종류 없음·허용 밖 MCP 서버/도구 = 위반 · 모르는 `item.*` 이벤트 이름 = 위반 · 기존 4종 위반 유지.
- 가짜 CLI `agent_chat_fake_cli.py`: codex 점검 흉내(점검 서버를 실제로 띄워 부르거나 인자의 nonce 를 답에 싣기 — 구현이 고른다).
- 기존 `test_agent_chat_runtime.py`·`test_agent_chat_api.py`: `CODEX_LOCK=None` 덮어쓰기를 표식 방식으로 바꿈, `test_codex_locked_until_isolation_checked` → 표식 없으면 잠금.
- 어댑터 `tools/mcp_adapter/test_persistent.py`: 칸 모드 서버의 자료·자료 틀 0개(일반 native 와 대조).
- 화면 `agentChatPanel.test.tsx`: 꺼짐 [연결] → 확인 중 → 성공(켬·[끄기]) / 실패 까닭 / [끄기].
- 빌드·경계 검사·`gen_inventory --check`·`check_code_map`.
- 실측(구현 뒤): 임시 `CONTENT_HUB_DATA`·`CONTENT_HUB_AGENT_CHAT_DIR` 격리 허브에서 enable 1번(실제 Codex 구독 차례 1번, MV 생성 없음) → 통과·표식 확인 · disable → 잠금 확인.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-codex-unlock-2026-11-12",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1d6d9-abb6-7262-8bf6-168446cd10a4"},
  "risk": {"level": "major", "reason": "잠가 둔 Codex 엔진을 PC 별 표식으로 열고, 허브가 점검 차례로 Codex 를 띄운다 — 권한·격리 경계"},
  "goal": "설정 쪽 ChatGPT [연결]로 이 PC 에서 Codex 를 켠다. 판·구독·작업 폴더·점검 차례를 통과해야 열리고, 해석기는 알려진 항목만 허용하며, 받아들이는 도구·글(apply_patch·시계·MCP 자료·스킬 목록)은 근거와 막는 장치를 둔다.",
  "touched_paths": ["backend/app/services/agent_chat_process.py", "backend/app/services/agent_chat_parse.py", "backend/app/services/agent_chat_codex.py", "backend/app/services/agent_chat_probe_mcp.py", "backend/app/services/agent_chat.py", "backend/app/routers/agent_chat.py", "backend/tests/test_agent_chat_codex_unlock.py", "backend/tests/test_agent_chat_parse.py", "backend/tests/agent_chat_fake_cli.py", "backend/tests/test_agent_chat_runtime.py", "backend/tests/test_agent_chat_api.py", "tools/mcp_adapter/server.py", "tools/mcp_adapter/test_persistent.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/lib/useAgentChat.ts", "frontend/src/components/agent-chat/AgentSettings.tsx", "frontend/src/components/agent-chat/AgentPanel.tsx", "frontend/src/styles/agent-chat.css", "frontend/tests/agentChatPanel.test.tsx", "docs/inventory/endpoints.md", "docs/inventory/background_jobs.md", "docs/CODE_MAP.md"],
  "criteria": [
    {"id": "measure", "success": "훅 대조(새·이어 가기 생김, 칸 명령 없음)·apply_patch 거절·AGENTS.md·스킬 유입 실측 기록(2-8) + 구현 뒤 격리 허브 enable 점검 1회 통과", "failure": "대조가 안 돌거나 칸 명령에 훅이 들어감, 또는 점검 실패", "required": true, "verification": ["5d37d854385d4d1a9bd1e5a00ce6c51b"]},
    {"id": "backend", "success": "백엔드 agent_chat 시험(잠금 해제 새 시험·해석기·기존 런타임/API) + 어댑터 시험 통과", "failure": "시험 실패", "required": true, "verification": ["c6fd20b09f944686a51116b1bfb4ea9f", "dcc411cf0060458293a773ae003cee7a", "f79b6f8cec484aa6b6f5f3a04737c8aa", "49f8184fde4f416896e80a2e4d9f2c3c", "c88e87c7d685473385d3e84b898ecba9"]},
    {"id": "screen", "success": "MV Agent 칸 시험 + 빌드·경계 검사 통과", "failure": "시험·빌드 실패", "required": true, "verification": ["810d76bb0e4b40fbac85235029e887e4", "5aca15df808a470e81472f084a9c1c37", "468949602eb04243aad5bb26f6444904"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "Codex 는 PC 마다 설정 [연결]로 켠다(기본 꺼짐, 판·정책이 바뀌면 다시 꺼짐, 시간 만료 없음)", "why": "팀 전체를 한 번에 열지 않고 켠 사람만 위험을 진다 · 판이 같으면 실측한 실행 파일과 같다", "alternative": "CODEX_LOCK 을 지워 모두에게 열기", "revisit": "팀이 모두 Codex 를 쓰게 되면"},
    {"choice": "apply_patch·시계·MCP 자료 3개·스킬 목록 글은 받아들인다", "why": "샌드박스 거절 실측·칸 서버 하나·자료 미등록·파일을 여는 도구가 없어 글로만 들어온다", "alternative": "끌 방법이 생길 때까지 잠금 유지", "revisit": "그 도구가 쓰기·외부 접근을 하게 되거나 스킬을 끄는 공식 설정이 생기면"},
    {"choice": "해석기는 알려진 항목 종류만 허용하고 나머지는 위반으로 끈다", "why": "판·서버 기본값이 바뀌어 새 도구가 생겨도 차례 안에서 바로 멈춘다", "alternative": "알려진 위반 4종만 막기(지금)", "revisit": "판을 올릴 때 항목 종류를 다시 본다"},
    {"choice": "켤 때마다 무과금 점검 차례를 허브가 돌린다(가짜 check_connection + nonce)", "why": "이 PC 의 로그인·서버 기본값·MCP 연결이 실제로 칸 명령으로 도는지 켜는 순간 확인한다", "alternative": "한 번 실측한 결과를 믿음", "revisit": "점검이 자주 틀리면"},
    {"choice": "작업 폴더에 AGENTS.md·.codex·.git(위 폴더 포함)이 있으면 잠근다", "why": "칸 명령도 작업 폴더의 AGENTS.md 를 읽는다(실측 B)", "alternative": "작업 폴더를 믿기", "revisit": "Codex 가 프로젝트 지침을 끄는 설정을 주면"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": [
    {"host": "claude", "session": "05db43d2-8576-48bf-b67b-c12c2eab85b6", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/05db43d2-8576-48bf-b67b-c12c2eab85b6.jsonl"},
    {"host": "codex", "session": "01a1d6d9-abb6-7262-8bf6-168446cd10a4", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/14/rollout-2026-11-14T06-39-12-01a1d6d9-abb6-7262-8bf6-168446cd10a4.jsonl"}
  ], "review": {"host": "claude", "session": "05deaa0d-cbf8-44a7-9ba7-ce703a5c530a", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/05deaa0d-cbf8-44a7-9ba7-ce703a5c530a.jsonl"}}
}
```
