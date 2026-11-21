---
status: draft
updated: 2026-11-21
---

# MV Agent 실행기 모듈 import 순환 끊기 (2026-11-21)

owner: Codex(구현) · Claude(설계·총괄) · reviewer: Codex(설계 확정) · Claude 별도 세션(독립 리뷰) · status: 완료(후보 408d1e95 독립 리뷰 PASS·시험 기록) · updated: 2026-11-21
관련: [배포 후보 1121](배포후보_1121_2026-11-21.md) — 전체 게이트를 막는 기존 실패

## 1. 요청·발견
- Jay "병합하고 릴리스까지"·"dev 전체로"(11-21). 후보 `b7f4ea10` 전체 게이트 중 백엔드 23% 지점 실패 = `backend/tests/test_architecture_boundaries.py::test_backend_internal_import_graph_has_no_cycles`. main(693c12a9, 0555) 게이트는 이 시험까지 통과했으므로 main 이후 dev 에 들어온 실패이며, 고치지 않으면 Gate 6-A(전체 시험 통과)를 못 넘는다. 바깥 화면 편집 묶음(513e49df·b163eba8)에서는 '기존 실패'로 `-k` 제외해 왔다.

## 2. 근거 (Claude 직접 확인, dev 066b1428)
- 순환 3개(시험 출력): `agent_chat_claude → agent_chat_process → agent_chat_install`(→ claude), `agent_chat_codex → agent_chat_process`(→ codex), `agent_chat_install → agent_chat_process`(→ install).
- 시험은 함수 안 지연 import 까지 모두 간선으로 센다(`test_architecture_boundaries.py:36-69` `ast.walk`), 동적 import 도 잡는다 — 우회 불가, 구조로 풀어야 한다.
- 원인 간선: `agent_chat_process` 가 위층을 부른다 — `_claude_candidates`·`_codex_candidates` 의 `install.status`·`install.official_codex`(`agent_chat_process.py:111·142`), `find_codex` 의 `codex.marker`(`:161`), 그 밖에 `codex.target_matches`·`codex.CODEX_POLICY`. 반대로 위층은 process 를 많이 쓴다: codex(`auth_problem·build_command·child_env·cli_version·codex_target·CODEX_VERIFIED·engine_prefix·JobProcess·OutputLimit·verified_codex`), claude(`child_env·cli_version·CREATE_*·engine_prefix·version_tuple`), install(`cli_version·CODEX_VERIFIED·official_claude`, 그리고 `claude._login_token_problem`).
- 들어온 커밋: [설치하고 연결] `f92117b5`·`037c473b`(11-20).

## 3. 설계 (2판 — 합의 1차 Codex·Claude 의견을 따른 안, Codex 설계안 `DESIGN: READY`)
- 1판(새 바닥 모듈로 install 의 `status` 등을 옮기고 install 이 상대 import 로 다시 내보냄)은 **버린다**: 실행기 `run_agent_session.py:1674-1679` 가 install 파일을 패키지 없이 `spec_from_file_location` 으로 읽어, 상대 import 가 `ImportError` → `:1919-1922` 가 삼켜 [설치하고 연결] 감시가 조용히 꺼진다(양측 P1/P2). `target_matches` 는 process 의 `codex_target`·`CODEX_VERIFIED` 를 써서 바닥으로 못 가고, `CODEX_VERIFIED` 를 옮기면 `install.codex_release()` 의 AST 판독(`agent_chat_install.py:189-197`)이 깨진다.
- **install 은 바닥 그대로** — 표준 라이브러리만 쓰는 실행기 계약 파일로 남기고 다른 `agent_chat_*`·`app.*` 를 import 하지 않게 한다. 실행기가 쓰는 `directory·process_start·read·write·file_lock·ENGINES·official_codex·codex_home·installer_env` 는 위치·서명 그대로.
- install 안에서 위층을 부르는 허브 전용 함수를 **새 윗층 모듈 `backend/app/services/agent_chat_install_service.py`** 로 옮긴다: `eligibility`·`request`·`verified_status`·`_file_stamp`·`_verified`(캐시)·`_verify_lock`(잠금). 새 모듈은 `install`·`process`·`claude`·`config` 를 모듈로 import 하고, 파일 조작은 `install.status/read/write/directory/launcher/file_lock/official_codex/codex_home/ENGINES` 처럼 **모듈 속성으로** 부른다(기존 시험의 `setattr(install, …)` 가 그대로 먹힘). 검사 순서·잠금 범위·`still_current()` 위치 유지. `RequestBusy` 는 install 에 두고 새 모듈이 다시 내보낸다. **install 은 새 모듈의 함수를 다시 내보내지 않는다**(그러면 install → service → process → install 순환 재발).
- 호출자 전환: 라우터 `routers/agent_chat.py` 의 `installer` import 를 새 모듈로, `services/agent_chat.py` 의 `AgentChat.engines` 는 판단 함수에 새 모듈을·캐시 지문의 `launcher()` 에는 install 을. HTTP 계약 그대로.
- **codex 의 상태 읽기는 process 로**: `CODEX_POLICY`, `_path` → `codex_state_path`, `_read` → `read_codex_state`, `marker` → `codex_marker`, `target_matches` → `codex_target_matches`. process 의 `find_codex` 는 codex import 없이 자기 함수를 쓴다. `codex_target_matches` 는 같은 모듈의 `codex_target`·`CODEX_VERIFIED` 를 쓰고, 경로는 `config.AGENT_CHAT_DIR` 를 부를 때마다 읽는다(복사 금지). codex 는 옛 이름(`CODEX_POLICY·_path·_read·marker·target_matches`)을 다시 내보내고 `_write`·`_lock`·`CodexError`·`Busy`·연결/해제 함수는 그대로 둔다. process 는 `config` 를 import 한다(표준 라이브러리만 씀).
- `_login_token_problem` 은 claude 에 그대로(새 모듈의 `eligibility` 가 `claude.` 로 부름). `CODEX_VERIFIED` 는 process 밖으로 옮기지 않는다.
- 결과 간선: service → install·process·claude·config, codex·claude → process, process → install·config, install → (없음) — 순환 0.
- **금지**: `sys.modules`·파일 직접 불러오기(`spec_from_file_location`)로 순환 시험을 피하기, install 에 위층 import 를 다시 넣기, 상태(캐시·잠금)를 두 곳에 두기.
- **동작 변경 0**: 함수 본체·파일 경로·잠금·표식 형식·반환값·오류 문구는 그대로 옮긴다. 공개 API·HTTP·DB 변화 없음.

## 4. 남은 위험
- 내부 호출자 누락(옮긴 함수를 옛 위치로 부르는 곳) — 전수 검색과 전체 시험으로 확인.
- 시험이 codex 의 옛 이름을 바꿔 끼우면 process 에는 전파되지 않는다 — 옮긴 읽기 함수를 바꿔 끼우는 시험은 process 의 새 이름을 쓴다(지금 그런 시험은 없음, 검색 확인).

## 5. 완료 조건과 시험 (dev 루트, 파일별 run-test)
- cycle-arch: `backend/tests/test_architecture_boundaries.py` 전부(순환 시험 포함, `-k` 제외 없음)
- cycle-agent: `backend/tests/test_agent_chat_install.py`(+ **실제 `_install_contract()` 독립 로딩 시험**: 격리 자식 파이썬에서 backend 를 import 경로에 넣지 않고 로더를 mock 하지 않은 채 불러 계약 이름 존재·허브 모듈 import 부재, 기본 `codex_release()`·`installer_env()` 가 기존 허용 판을 돌려주고 오염된 설치 환경변수를 정리 · 새 모듈 경유 중복 요청·중단 판정·설치 중 후보 제외·`probe=False`·캐시 호출 횟수(313줄 부근) 유지 · `codex._write` 로 쓴 표식을 process 탐색이 읽고 해제가 즉시 반영, 옛 npm 표식·정확한 target·정책 불일치 기대값 유지)·`test_agent_chat_codex_unlock.py`·`test_agent_chat_codex_login.py`·`test_agent_chat_runtime.py`·`test_agent_chat_api.py`·`test_agent_chat_connect.py`·`test_agent_chat_claude_app.py`·`test_agent_chat_fork.py`·`test_agent_chat_images.py`·`test_agent_chat_restore.py`·`test_claude_official_install.py`
- cycle-docs: `tools/check_code_map.py`(새 파일 등재)·`tools/gen_inventory.py --check`·`backend/tests/test_docs_inventory_fresh.py`

## 6. 검토 기록
- 1차(계약 bfb95418): Codex `01a1fb54…`(읽기 전용) = 수정 필요 — P2 2(실행기의 install 독립 로딩이 깨짐·`target_matches` 의 process 의존과 `codex_release()` AST 판독). Claude `3c9d3409-2cae-4244-aec2-abc5c2a8dfd1`(claude-opus-5-5·Read/Grep/Glob) = 수정 필요 — P1 1(같은 실행기 로딩 고장, 시험이 `_install_contract` 를 대체해 못 잡음)·P2 2(`target_matches` 는 바닥 불가·실제 로딩 시험 필요) + 권장안(install 을 바닥으로, 허브 전용 함수를 윗층 모듈로, codex 읽기는 process 로). → Codex 에 구체안을 받아(`DESIGN: READY`, 같은 방향) 3장 2판·5장·계약을 고쳐 2차.
- **양측 합의 2차(계약 2efdc829) = 합의**: Codex `01a1fb54…` "P1·P2 없음" + 낮음(유지할 patch 대역은 유지) · Claude `3c9d3409…` 동의(결과 간선 순환 없음·patch 그대로 먹힘·상태 한 곳·옛 위치 호출자 둘 다 범위 안 확인) + 낮음 4(install 의 `threading` 정리·독립 로딩 시험은 자식 `sys.modules` 에 `app` 없음으로 판정·install 의 `app.*`/상대 import 금지 AST 검사(선택)·graft 색인 낡음은 게이트 무관). 낮음은 구현 요청에 반영.
- 범위 한 줄 추가(계약 03a460b2): 구현에서 새 모듈이 `CONTENT_HUB_AGENT_INSTALL_ID` 를 쓰는 파일로 생성 목록 `docs/inventory/env_vars.md` 에 올라가야 해 touched_paths 에 더함 → Codex `01a1fb54`·Claude `3c9d3409` 둘 다 같은 세션 이어 받기로 VIBE-AGREE(설계 판단 불변). 목록은 생성기로만 다시 만듦.
- 구현(Codex `01a1fb54…` 이어 받기·gpt-6-astra·high·workspace-write, 작업실 `codex/agent-chat-import-cycle`) 후보 `408d1e95`(10파일, 새 `agent_chat_install_service.py`): 3장 2판 그대로(설계와 다른 곳 없음), 유지할 patch 대역 유지, 실제 `_install_contract()` 독립 로딩·install 표준 라이브러리 AST 검사·Codex 표식 쓰기→process 탐색 반영 시험 추가. 총괄이 샌드박스 밖 작업실에서 관련 13파일 571 통과·4 건너뜀(순환 시험 포함).
- 독립 리뷰 Claude `d9ac2111-c4e9-4c35-86d1-bc6d506787e6`(claude-opus-5-5·Read/Grep/Glob 읽기 전용, 합의·구현 불참, 대상 408d1e95·지문 ebe4ce1d) = **PASS**(높음·중간 없음). 낮음 4(반영 안 함): 다시 내보낸 codex 이름은 별칭이라 앞으로 patch 는 process 이름으로(지금 해당 시험 0) · 실행기의 계약 로딩 ImportError 삼킴은 원래 동작(새 시험·AST 검사가 회귀를 막음) · 이 기록 머리 상태 갱신 · 주석 위치 취향.
- 시험 기록 15개(조건 3) 모두 통과 — verification 참조.

```vibe-intent
{
  "schema": 1,
  "id": "agent-chat-import-cycle-2026-11-21",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1fb54-b99e-7711-8293-7de2750ce745"},
  "risk": {"level": "major", "reason": "MV Agent 실행기 모듈 경계 변경(함수 이동·다시 내보내기) — 설치 상태·Codex 켬 표식 읽기 경로, 잠금·캐시가 갈라지면 실행기 선택·설치 판정이 틀릴 수 있다"},
  "goal": "백엔드 import 순환(agent_chat_claude/codex/install ↔ agent_chat_process)을 끊어 전체 시험의 구조 경계 시험을 통과시킨다: install 은 실행기가 패키지 없이 읽는 표준 라이브러리 전용 바닥으로 두고 그 안의 허브 전용 함수(eligibility·request·verified_status 와 캐시·잠금)를 새 윗층 모듈 agent_chat_install_service 로 옮기며, codex 의 상태 읽기(CODEX_POLICY·경로·읽기·marker·target_matches)를 process 로 옮기고 codex 는 옛 이름을 다시 내보낸다. 동작·파일 형식·잠금·공개 API·실행기 독립 로딩·버전 판독은 바꾸지 않는다.",
  "touched_paths": [
    "backend/app/services/agent_chat_process.py",
    "backend/app/services/agent_chat_install.py",
    "backend/app/services/agent_chat_codex.py",
    "backend/app/services/agent_chat_install_service.py",
    "backend/app/services/agent_chat.py",
    "backend/app/routers/agent_chat.py",
    "backend/tests/test_agent_chat_install.py",
    "backend/tests/test_agent_chat_codex_unlock.py",
    "backend/tests/test_agent_chat_codex_login.py",
    "backend/tests/test_agent_chat_runtime.py",
    "backend/tests/test_agent_chat_api.py",
    "backend/tests/test_agent_chat_connect.py",
    "backend/tests/test_claude_official_install.py",
    "docs/CODE_MAP.md",
    "docs/CURRENT_STATUS.md",
    "docs/inventory/env_vars.md"
  ],
  "criteria": [
    {"id": "cycle-arch", "success": "test_architecture_boundaries 전부 통과(import 순환 0, -k 제외 없음)", "failure": "순환 남음 또는 다른 경계 시험 실패", "required": true, "verification": ["269fd8dd772346e9a399065669a7331f"]},
    {"id": "cycle-agent", "success": "실제 _install_contract() 독립 로딩(로더 mock 없음·허브 모듈 import 없음·기본 codex_release/installer_env 기존 판·오염 환경변수 정리) 시험과 MV Agent 설치(새 모듈 경유 중복 요청·중단·설치 중 후보 제외·probe=False·캐시 호출 횟수)·Codex 켬/해제 표식이 process 탐색에 즉시 반영·로그인·실행기·대화 API·연결·Claude 앱·포크·그림·복원·Claude 공식 설치 시험 통과(기대값 변경 없음, 옮긴 함수의 호출 모듈·patch 대상만 조정)", "failure": "시험 실패 또는 동작 기대값을 바꿔 통과 또는 실행기 독립 로딩 실패", "required": true, "verification": ["797640f9f2f546a8bbe0cdaa533c7476", "aa23db0fe0da4c0b8641ba614cb6ff3e", "f86801c3265148cb8b3618ab21f109df", "ebb7f2cd165449ed812ab95e6887aef7", "aaadf2f1592d4ae6b3d3b3665ced8428", "fd9c017b64ec4e92a8a6d3180ec2e612", "31aeb9c59df742449a840d509b201e1c", "4bb436b0267e49fb870f44dccc9d6051", "c4021930806942538a940dcc1f444cc2", "2f6a2d17db964d72aff6e9fcf7800e0d", "d8bd4cd49b8446059ddcceb2fcc9dd7b"]},
    {"id": "cycle-docs", "success": "check_code_map(새 파일 등재)·gen_inventory --check·test_docs_inventory_fresh 통과", "failure": "목록·코드맵 낡음", "required": true, "verification": ["8c2e8140dab1433196c220afe0d8d708", "9c0f98dfa08a4cadbe106df28ab127dc", "d545457212a74863a3979d02b057b9e0"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "install 을 실행기 계약 바닥으로 두고 허브 전용 설치 판단·요청을 새 윗층 모듈로, codex 상태 읽기를 process 로 옮긴다(codex 는 옛 이름 다시 내보내기, install 은 새 모듈 함수를 다시 내보내지 않음)", "why": "실행기가 install 을 패키지 없이 읽어 install 에 상대 import 를 넣을 수 없고(양측 1차 P1/P2), target_matches 는 process 의 상수·함수를 써서 바닥으로 못 가며 CODEX_VERIFIED 는 AST 판독 때문에 process 에 있어야 한다. 이 방향은 독립 로딩 폴백·상수 이동·판독 변경 없이 세 순환을 끊고, 상태는 한 곳에만 둔다", "alternative": "새 바닥 모듈+install 상대 import(실행기 고장) / 파일 로딩 폴백(이중 로딩·상태 공유 불확실) / 순환 시험 예외(구조 규칙 약화) / 함수 복사(갈라짐)", "revisit": "실행기 모듈을 다시 나눌 때"}
  ],
  "evidence": {"target": {"kind": "revision", "revision": "408d1e9545fdeb497ef9b63913e7c448cf0ccdfe"}, "consensus": [
    {"host": "codex", "session": "01a1fb54-b99e-7711-8293-7de2750ce745", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/21/rollout-2026-11-21T08-39-56-01a1fb54-b99e-7711-8293-7de2750ce745.jsonl"},
    {"host": "claude", "session": "3c9d3409-2cae-4244-aec2-abc5c2a8dfd1", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-cy-agree/3c9d3409-2cae-4244-aec2-abc5c2a8dfd1.jsonl"}
  ], "review": {"host": "claude", "session": "d9ac2111-c4e9-4c35-86d1-bc6d506787e6", "transcript": "C:/Users/FX-PC06/.claude/projects/C--Users-FX-PC06-AppData-Local-Temp-claude-ee6837cddcdd404e-88edc1da-c224-472f-a96b-4dd708f63196-scratchpad-hub-tools-cy-review/d9ac2111-c4e9-4c35-86d1-bc6d506787e6.jsonl"}, "design_sessions": [
    {"host": "codex", "session": "01a1fb54-b99e-7711-8293-7de2750ce745"}
  ]}
}
```
