---
status: draft
updated: 2026-11-20
---

# MV Agent 대화를 Claude 앱에서 이어 쓰고 다시 가져오기 (2026-11-19)

owner: Claude(설계·총괄) · Codex(구현) · reviewer: Codex(설계 확정) · Claude 별도 세션(독립 리뷰) · status: 검증 중 — 1묶음 백엔드 독립 리뷰 PASS(작업실 브랜치 커밋) · 2묶음 재확인 PASS(낮음 3, 총괄 보고) 뒤 fix-2 반영·화면 200 통과, 총괄 최종 확인 남음 · 실제 허브 코드 M4·실사용 전 확인 남음 · updated: 2026-11-19
작업실: `D:\ClaudeCode\work\mvagent-claude-app-20261119`(브랜치 `codex/mvagent-claude-app`, 기준 dev `d117c248`) · 담당 Codex(구현)·Claude(총괄) · 포트·서버 없음 · 시험 데이터 = pytest 임시 폴더만 · 완료 조건 = 5절

## 1. 요청

- Jay 11-19: "mv agent에서 대화한거 일반 클로드앱이나 이런곳에서 열어보거나 할려면 어떻게 해야하는지" → 조사 → 시안 → "앱에서 쓴 말도 나오게 할 수는 없나" → 원본 열기 + 다시 가져오기 시안 → **"이 흐름으로 설계"**.
- 목표: MV Agent 의 Claude 대화를 **Claude 데스크톱 앱 Code 탭에서 같은 세션 id 로** 이어 쓰고, MV Agent 로 돌아와 **[여기로 가져오기]** 를 누르면 그쪽에서 새로 쓴 말이 이 대화 기록에 이어서 보이며 같은 세션으로 계속 대화한다.
- 제외: Codex 대화 · 사본으로 열기(`--fork-session`) · 자동 동기화(누를 때만 가져옴) · claude.ai 웹·모바일 · 다른 세션으로 갈아탄 기록 · 가져온 계획의 실행 · 가져온 글 고쳐 보내기.
- 시안(공유 노트 폴더 `side-session-notes/local_fca53044…/MVAgent_Claude앱열기_시안_*.png`, 앱 CSS 값): `open_and_bring_back.png`(이 설계의 흐름 4칸) · `open_in_claude_buttons.png`(단추 자리 A·B안).

## 2. 근거

확인한 사실(코드·이 PC, Claude 조사):
- 칸은 `claude.exe -p … --resume <cli_session_id>` 로 부르고 세션 저장을 끄지 않는다 — `services/agent_chat_process.py:202-213`. cwd = `%LOCALAPPDATA%\MVHub\agent_chat\work` — `services/agent_chat.py:358,530`. 세션 id·자격 폴더·cwd 는 대화 표 `cli_session_id`·`cli_home`·`cli_cwd` — `services/agent_chat.py:498-501`.
- 칸 화면은 기록 DB(`agent_chat_turn`·`agent_chat_event`)만 그린다. Claude 세션 파일은 지우기 확인 때만 읽는다 — `services/agent_chat_claude.py:235`.
- 일반 차례 입력 키는 `^[A-Za-z0-9_-]+$` — `routers/agent_chat.py:482`(`:` 가 든 내부 키와 부딪치지 않음). 차례 사건 상한 `MAX_EVENTS = 1000` — `services/agent_chat.py:45`.
- 이 PC: Claude 대화 3건 모두 세션 파일 있음 · Claude Code 2.1.322(공식 설치).

공식 문서(직접 읽음):
- [desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli): `claude --desktop --resume <session-id>` — v2.1.285 이상, macOS·x64 Windows, 구독 로그인. `Opening session <id> in Claude Desktop` 을 찍고 끝난다. 다른 터미널에 열려 있거나 백그라운드로 도는 세션은 옮기지 않는다. 앱이 없으면 다운로드 링크를 찍고 끝난다. 데스크톱은 자체 Claude Code 를 쓰므로 판이 터미널 CLI 와 다를 수 있다.
- [sessions](https://code.claude.com/docs/en/sessions): `-p` 세션도 `--resume <id>` 로 이어 간다 · 세션 파일 형식은 내부용이라 판마다 바뀔 수 있다 · 같은 세션을 두 곳이 동시에 이어 쓰면 메시지가 빠질 수 있다 · `--mcp-config` 같은 실행 옵션은 이어 갈 때 다시 줘야 한다 · `/compact` 는 기록을 요약으로 바꾼다.
- [agent-sdk/python](https://code.claude.com/docs/en/agent-sdk/python): `get_session_messages(session_id, directory, limit, offset)` — 기록 보기 화면용 공개 함수.
- [claude-directory](https://code.claude.com/docs/en/claude-directory): Claude 앱에서 이어 간 세션 기록은 30일 자동 삭제에서 빠진다.
- SDK 패키지 `claude-agent-sdk` 0.2.184: Windows 휠 159.3MB(Claude Code 동봉)·의존 `mcp` 등. 세션 읽기는 `_internal/sessions.py` 의 순수 파이썬 · MIT(Claude 조사, Codex 는 원본 링크로 대조).

## 3. 확정 설계(3판)

3판 = 2판 + 0단계 실측(4-1) 반영: 띄우기는 숨긴 새 콘솔·종료 코드 판정(R1) · 사람 글 고르기 규칙(R2) · 압축 경계 한 연결만 따라가기(R3) · 앵커 뒤 갈라짐이면 넣지 않음(R4) · 다시 열기 종료 1 안내(R5) · 크기·판 섞임(R6·R7). 바뀐 문단에 **[3판]** 표시.

### 3-1. 저장 상태
- 대화 표에 두 칸만 더한다(처음 열 때 없는 칸만 더하는 지금 방식): `app_handoff TEXT`(JSON) · `app_opened_at TEXT`(앱으로 전달됐거나 전달됐을 수 있는 마지막 시각). **차례 표에는 칸을 더하지 않는다** — 출처는 `context` 에 둔다.
- `app_handoff` = `{revision, phase: idle|opening|handed|uncertain, handoff_id, at, anchor: {session_id, transcript_location, anchor_uuid, prefix_digest}, last_request: {request_id, action, request_fingerprint, result}}`. NULL = idle·revision 0. 잠긴 상태 = opening·handed·uncertain. 가져온 뒤엔 idle 로 바꾸고 앵커를 지우되 revision·최근 결과는 남긴다. JSON 이 깨졌거나 모르는 상태면 **보통으로 보지 않는다**(잠금).
- 공개 응답은 `app_handoff: {id, at, state} | null`·`app_revision`·`app_opened_at`·`can_open_app`·`open_app_block` 만. 파일 위치·세션 id·앵커는 내보내지 않는다.

### 3-2. 요청
- `POST /api/agent-chat/conversations/{id}/claude-app/open` `{request_id, expected_revision, handoff_id?}`
- `POST /api/agent-chat/conversations/{id}/claude-app/bring-back` `{request_id, expected_revision, handoff_id, unlock_only: false}`(엄격한 boolean)
- 재요청: 최근 요청과 같은 id·같은 내용 → 저장한 결과 · 같은 id 다른 내용 → 409 · revision·handoff_id 다름 → 409 `stale_handoff` · 정상 요청만 상태를 바꾼다. 모든 옛 요청 결과를 영구 보관하는 장부는 두지 않는다 — 어떤 옛 요청도 새 앱 실행·중복 넣기·새 잠금 풀기를 일으키지 않으면 된다.
- 두 길 모두 기존 `_panel` 의존성(루프백·칸 표·계정·허브·복원 세대 검사) 그대로. 경로·명령·세션 id 는 요청에서 받지 않는다. `_turn_lock(identity)` 안에서, 실행·읽기·DB 반영은 `service.issuance(identity)` 와 기존 취소 보호 패턴으로 감싼다. 신원은 외부 실행 직전과 커밋 직전에 다시 확인한다.

### 3-3. 잠금이 막는 것·두는 것
| 동작 | 넘김 동안 |
|---|---|
| 그 대화의 새 차례 | 라우터 + `claim_turn` 거래 안에서 막음 |
| 그 대화에서 새 포크 | 사전 검사 + `_fork_check` 거래 안에서 막음 |
| **그 대화를 원본으로 쓰는 시작 전 포크의 첫 차례** | 막음 — 전달 직전 그 포크들의 `fork_turn` 을 NULL 로 바꿔 기존 `source_changed` 판정을 탄다(포크 기록·사건은 그대로, 다시 포크해야 함, 잠금만 풀어도 `ready` 로 돌아오지 않음). 이미 자기 세션을 받은 포크는 건드리지 않는다. 까닭: 지금 포크 판정은 세션 id·DB 마지막 차례만 봐서 앱의 쓰기를 모른다(`repo/agent_chat.py:365`) |
| 그 대화 지우기 | 라우터 + 삭제 거래 안에서 막음 |
| 이름·고정·보관·프로젝트·읽음 | 허용 |
| 대화·MCP 기록 읽기 | 허용(앱에서 쓴 말은 아직 안 보인다고 표시) |
| 이미 묶인 계획 [실행] | 기존 권한 검사 그대로 허용 |
| 다른 대화 쓰기 | 기존 신원 차례 제한 안에서 허용 |
| 백업 | 허용 |
| 그 Agent DB 를 바꾸는 전체 복원 | 넘김이 하나라도 있으면 409(기존 `restore_guard`·`issuance` 순서) |

- `has_active()` 는 지금처럼 running·cancelling 차례만 뜻한다(넘김을 가짜 차례로 만들지 않음). 열기·가져오기 자체는 신원에 진행 중 차례가 있으면 409, 열기는 `service.forking_from(session_id)` 도 본다.
- 복원본: `adopt_restored()` 에서 넘김·최근 결과·`app_opened_at` 을 비운다(기존 `restored_from`·`resumable=0`·CLI 정보 지우기 유지). 가져온 차례의 출처는 보존. 백업은 Claude 세션 파일까지 보장하지 않는다. `backup_manifest.py` 는 추가 칸을 허용하므로 바꾸지 않는다.
- 데스크톱에 칸 MCP 설정·비밀값을 넘기지 않는다. 돌아온 뒤엔 기존 `build_command()` 의 도구·권한 제한이 다시 걸린다. 가져온 기록으로 계획 묶음·화면 동작·실행 가능한 카드를 만들지 않는다.

### 3-4. 열기
- 조건: Claude 대화·복원 아님 · 자기 `cli_session_id`·`resumable=1` · 시작 전 포크 아님 · 진행 중 차례·원본을 쓰는 포크 실행기 없음 · x64 Windows·CLI 2.1.285 이상·구독 로그인 · `_login_token_problem()` 통과(Windows 실행 사용자 검사일 뿐 구독 검사가 아님) · 저장된 `cli_home`·`cli_cwd` 가 실제 환경과 맞음 · 세션 파일을 하나로 특정하고 온전한 본 줄기와 앵커를 읽음. 못 맞추면 work 폴더로 대신하지 않고 거절.
- **[3판] 실행 전 설치 확인**: 현재 Windows 사용자에게 설치된 Claude 데스크톱의 **등록 정보와 실제 실행 대상**을 확인한다(`%APPDATA%\Claude\claude-code\` 폴더는 보조 증거일 뿐 — 지운 뒤 남은 폴더를 설치로 오판하지 않게). 결과는 `available`·`missing`·`unknown` — `missing` 은 "Claude 데스크톱 앱이 없어요", 조회 실패·지원 안 하는 설치 형태는 "설치를 확인하지 못했어요"로 안내하고 실행하지 않는다. 확인 뒤에도 제거·업데이트가 일어날 수 있으니 실행 결과의 불확실성 처리는 그대로 둔다. 앱이 없을 때 CLI 종료 코드는 미측정이라 실행 결과로 가르지 않는다.
- 순서: ① 짧은 거래로 `opening`+앵커 저장 ② `[*engine_prefix("claude"), "--desktop", "--resume", session_id]`, 기록된 cwd·`child_env()` ③ **[3판]** `shell=False`·`close_fds=True`·`stdin/stdout/stderr=None`, 새 `STARTUPINFO` 에 `STARTF_USESHOWWINDOW`+`SW_HIDE` 만(`STARTF_USESTDHANDLES` 없음) — `PIPE`·`DEVNULL`·파일 리디렉션·`input`·`capture_output` 금지(파이프로 받으면 CLI 가 "can't run non-interactively … redirected output" 로 거부 — 실측 M1). 생성 플래그 `CREATE_NEW_CONSOLE | CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB`(`CREATE_NO_WINDOW`·`DETACHED_PROCESS` 섞지 않음 — `SW_HIDE` 는 콘솔을 숨길 뿐 없애지 않는다, [생성 플래그](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)·[STARTUPINFO](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow)). **실측한 조합은 숨긴 새 콘솔뿐**이고 정지 생성·breakaway 조합은 M4 에서 검증한다 ④ `_in_any_job()` 으로 Job 밖 확인(조회 실패·미확인이면 재개하지 않음) ⑤ 신원 재확인·시작 전 포크 무효화·`app_opened_at`·**실행기 PID·생성 시각**을 넘김 JSON 에 기록 뒤 재개 — 이 PC 의 Python `Popen` 은 생성 뒤 주 스레드 핸들을 닫으므로 기존 `_resume(proc)`(프로세스 단위 재개)를 쓰고 실패 경로를 시험한다 ⑥ 30초 안에 종료 코드 수집.
- 로그인 창 `_spawn_window()` 는 보이는 콘솔·고정 cwd 계약이라 그대로 쓰지 않는다 — `_login_token_problem`·Job 검사·멈춘 프로세스 재개만 재사용. 로그인 기록·스위치에 묶지 않는다. Claude 자격 잠금은 전달 명령 구간에만 쥔다.
- **[3판] 판정(종료 코드만 — 출력을 받을 수 없다)**: 재개 전 실패는 **생성한 실행기의 종료를 확인한 경우에만** 예약 풀기, 종료 확인 실패·재개 여부 불명은 `uncertain` · breakaway 된 정지 프로세스가 허브 종료로 회수된다고 가정하지 않는다 — 복구 때 넘김 JSON 의 PID·생성 시각으로 같은 실행기임을 확인한 것만 정리하고 자동 재개하지 않는다(생성과 식별 기록 사이에 허브가 죽는 짧은 구간은 한계로 남김) · 재개 뒤 종료 0 → 지원·검증한 환경에서 **전달 명령 완료**로 보고 `handed`(앱 화면이 실제 열렸다는 관찰과는 구분) · **0 이 아닌 종료·시간 초과·응답 유실·허브 종료 → `uncertain`, 잠금 유지** · 다시 열기에서 0 이 아니면 기존 잠금·앵커 유지하고 "이미 Claude 앱에 열려 있을 수 있어요 · 앱에서 찾아 주세요"(실측 M5 — 앱에 열린 채면 종료 1, 까닭 미확인이라 '이미 열림'으로 단정하지 않음). 로그엔 종료 코드·분류·시간만. 시간 초과 정리는 이번에 만든 실행기 핸들만(앱·세션 프로세스는 끄지 않음 — 세션은 앱 본체가 따로 띄운다, 실측 M1). 재시작 뒤 남은 `opening` 은 `uncertain` 취급(자동 재실행·자동 해제 없음).

### 3-5. 세션 읽기 — J1 = 나(Codex 동의)
- **나: SDK 0.2.184 `_internal/sessions.py` 의 필요한 읽기 로직만 새 `services/agent_chat_transcript.py` 로 옮긴다**(고정 판·원본 URL·옮긴 함수·고친 점·MIT 전문 표기). 가: SDK 통째 의존은 이 기능만 위해 무겁고 공개 반환값으로 손상·압축 원인 판정이 어렵다. 다: 직접 최소 읽기는 "줄 순서 = 본 줄기" 가정이 틀린다.
- 옮기는 것: 부모 연결로 본 줄기 만들기 · 병렬 도구 기록 보완 · `isMeta`·`isSidechain`·`teamName` 구분 · 압축 요약 표식. 옮기지 않는 것: 세션 목록·git worktree 탐색·클라우드 저장소·세션 편집·하위 에이전트 파일 탐색 · 전역 `os.environ` 바꾸기.
- 지킬 것: 저장된 home 아래에서 지정 id 파일만(중복 후보·링크/정션 이탈·다른 세션 내용 거절) · 파일 없음/빈 파일/새 말 없음/손상을 서로 다른 결과로 · 불완전 JSON 줄·충돌 uuid·끊긴 연결을 조용히 건너뛰지 않음 · 읽기 전후 파일 식별·크기·수정 시각 비교, 바뀌었으면 이번 가져오기 거절.
- **앵커** = 본 줄기 마지막 유효 메시지 uuid + 그 지점까지 정규화한 메시지 지문(`prefix_digest`). 가져올 때 앵커까지 그대로인지 확인. 되감기·분기로 앵커가 사라지거나 앞이 달라지면 `anchor_changed` 실패(시각·줄 번호·유사도로 이어 붙이지 않음).
- **[3판] 압축 경계(R3, 조건부)**: 2판의 "압축이면 실패" 대신, 이번 넘김 뒤 구간에서 **검증된 압축 경계 하나**를 건널 때만 허용한다(일반 `parentUuid or logicalParentUuid` 탐색은 쓰지 않음). 모두 충족: ① 경계가 같은 세션 본 줄기에 있고 `type=system`·`subtype=compact_boundary`·`parentUuid=null`(칸 없음·빈 글자는 근거 없이 같게 보지 않음) ② `logicalParentUuid` 가 같은 세션의 실제 선행 노드를 가리키고 순환·충돌 없이 저장된 앵커에 닿음 ③ 경계의 직접 자식인 user 요약 노드에 `isCompactSummary=true` 가 있고 가져올 뒤 줄기가 그 요약을 통해 이어짐(이 모양은 합성 시험 자료로 고정 — 4-1 만으로 요약의 직접 부모 관계까지 확인했다고 적지 않음) ④ 경계를 건너도 앵커·`prefix_digest` 일치 ⑤ 앵커부터 끝까지 다른 압축 경계·경쟁 요약 경로 없음. 검증한 경계에만 논리 부모 연결을 더하고, 압축 전 앵커 뒤 발화는 한 번씩 가져오며 요약은 발화·답으로 넣지 않는다. 경계 둘 이상·구조 불명이면 전체 거절·잠금 유지. SDK 는 요약과 앞 내용이 겹치지 않게 논리 부모를 일부러 따르지 않는다 — 이것은 MV Hub 의 제한된 확장이다([SDK 주석](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.184/src/claude_agent_sdk/_internal/sessions.py#L839)).
- **[3판] 갈라짐(R4)**: 물리적 JSONL 잎 수가 아니라 **정규화한 대화 진행 경로 수**로 판정하고, SDK 가 최신 잎 하나를 골라 나머지를 버리기 **전에** 검사한다. 연결 검증에는 uuid·부모를 가진 알려진 `user`·`assistant`·`system`·`progress`·`attachment` 노드를 보존한다(표시에서 빼는 것과 연결 그래프에서 빼는 것은 다름). 하위 에이전트·sidechain·team 기록은 출처를 확인해 본 경로에서 뺀다. 알려진 메타·진행·멈춤 요약·첨부 노드는 갈래로 세지 않는다. 같은 응답의 병렬 도구는 SDK 의 응답 id·작성자·도구 id 대응으로 입증될 때만 묶는다([SDK 병렬 도구](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.184/src/claude_agent_sdk/_internal/sessions.py#L982)). R3 을 통과한 논리 연결까지 넣어 그래프를 만들면 압축 전 끝은 따로 잎이 아니다(경계가 가리킨다는 까닭만으로 다른 경쟁 가지를 빼지 않음). 앵커 뒤 서로 포함되지 않는 사용자·assistant 진행 경로가 둘 이상이면 `branched` 로 전체 거절 — 병렬 도구인지 실제 갈래인지 못 가르면 넣지 않고, 최신 가지 고르기·사람 확인 뒤 합치기는 하지 않는다. 같은 세션의 새 대화 후보가 앵커와 이어지지 않으면 "새 말 없음"이 아니라 연결 실패. 실측 M5b 에서 동시 쓰기가 기록을 두 갈래로 만들었다.
- **[3판] 판 섞임·큰 줄(R6·R7)**: 한 파일에 CLI 판·앱 내장 판 줄이 섞이는 것은 허용하되 각 줄이 지원하는 구조인지 검사한다(판 글자가 다르다는 까닭으로 거절하거나 아는 판이라는 까닭으로 모르는 구조를 허용하지 않음). 각 줄은 크기 제한 안에서 JSON 으로 읽어 최상위 종류·연결 칸을 확인한다. 알려진 `api-request`·`api-request-blob` 의 요청 본문은 변환·로그·시험 자료로 복사하거나 그 안의 글자를 다시 해석하지 않고 버린다. 본 줄기 연결에 필요한 `progress`·`attachment` 는 무조건 버리지 않는다. 모르는 연결 노드·대화 후보는 조용히 빼지 않는다. 두 차례 관측한 증가량(46KB→약 1MB)을 모든 대화의 증가율로 일반화하지 않는다.
- 보호 한도(실측값 아님): 파일 64MiB · 한 줄 16MiB · 바꾼 결과 JSON 4MiB. 긴 앱 대화가 64MiB 에 걸리면 `too_large`(잠금 유지) — 걸리는 빈도를 보고 조정.

### 3-6. 가져오기와 바꾸기
- 사용자가 앱에서 그 대화·진행 중 작업을 끝냈다고 확인한 뒤 가져온다(파일이 잠깐 안 바뀐 것을 앱 종료 증거로 보지 않음).
- 순서: 요청 id·handoff_id·revision·신원·진행 중 차례 검사 → 원본 세션 읽기·안정성·앵커·본 줄기 검증 → 앵커 뒤 **원본 세션 본 줄기**만 바꾸기 → 상한·형식 확인 → `BEGIN IMMEDIATE` 한 거래에서 상태 재확인 후 차례·사건 넣기·최근 결과·상태 해제·`updated_at`·읽지 않음 함께 커밋. `cli_session_id`·`cli_home`·`cli_cwd`·칸 연결은 그대로 → 다음 차례는 기존 명령으로 같은 id 를 이어 간다.
- 저장 모양: 실제 사용자 메시지마다 차례 하나 · `context` = `{origin: "claude_app", handoff_id, source_uuid, imported_at, 생략 정보}` · `status=done`(= 기록 넣기 완료, 외부 도구 성공 뜻 아님) · `created_at` = 가져온 시각(넣은 순서 유지, 원본 시각은 context) · 입력 키 = `app:<sha256(conversation_id, session_id, source_uuid)>`(일반 키에 `:` 금지라 안 부딪침) · 부딪치는 행이 있으면 같은 대화·원본인지 대조(`INSERT OR IGNORE` 로 숨기지 않음).
- **[3판] 사람 글 고르기(R2, 실측 M2·M6)**: 앵커 뒤 user 기록을 **메시지별로** 나눈다. 앱의 실제 사용자 차례는 `entrypoint == "claude-desktop"` 와 구조가 맞는 `origin.kind == "human"` 을 **둘 다** 확인한다(그림·문서만 든 메시지도 같은 검사). 알려진 압축 요약(`isCompactSummary`)·메타·로컬 명령·도구 결과 전용 기록은 각자의 구조로 분류하고 human 표식이 없다는 까닭으로 실패시키지 않는다. 반대로 사람이 쓴 글·첨부 후보인데 `origin` 이 없거나 틀리거나 모르는 kind 이면 **한 건만 있어도** `read_failed`(다른 메시지에 정상 origin 이 있다고 그 메시지를 버리고 성공하지 않음). 앵커 뒤 본 대화 후보에 `entrypoint == "sdk-cli"` 가 있으면 잠금 밖 쓰기로 전체 거절. 모르는 entrypoint·분류 못 한 사용자 후보도 빠뜨리지 않는다(실패). assistant·tool_result 는 human 표식을 요구하지 않고 검증한 본 줄기와 그 사용자 차례에 이어 다룬다. **`<system-reminder>` 로 시작한다는 까닭만으로 text 블록을 지우지 않는다** — 실측한 앱 삽입 안내의 완결된 블록 구조·위치(첫 사람 글 메시지의 앞 블록)에 맞을 때만 떼고, 일부 글자·닫히지 않은 태그·사람 입력과 가를 근거가 부족하면 원문을 보존한다. 로컬 명령도 태그 글자만으로 사람 글에서 지우지 않는다. 가져올 차례 0개는 모든 새 대화 후보가 정상 분류된 뒤에만 성공.
- 바꾸기 표: 사용자 글 → 차례 `text` · 그림·문서만 → `[그림]`·`[문서]` 자리표시 · assistant text → `text` 사건 · tool_use+짝 tool_result → `tool` 사건 done/failed · **결과 없는 tool_use → 성공으로 만들지 않고 '결과 미확인'** · tool_result 만 든 user → 차례 안 만듦 · 글과 결과 섞임 → 각각 · 앵커 뒤 assistant 부터 → 출처 표시된 보충 차례 하나 · thinking·내부 메타·하위 에이전트 본문 → 제외 · 압축 요약 → 사용자 발화로 만들지 않음 · 계획·화면 동작처럼 보이는 도구 출력 → 실행 가능한 사건으로 안 바꿈. 도구 이름은 `mcp__mvhub_panel__` 접두만 줄인다(다른 서버 이름은 그대로).
- 라이브 `ClaudeParser` 는 쓰지 않는다(허용 목록 밖 도구를 위반으로 다루는 실행 감시 계약).
- 상한: 한 번에 차례 200 · 차례당 사건 1000(마지막 상태·안내 포함) · 글 하나 20,000자(줄이면 생략 표시·개수를 기록에 남김) · 넘으면 413, **넣기 없이 잠금 유지**("앞의 N개를 버리고 성공" 하지 않음).
- 새 말이 정말 없으면 `imported: 0` 으로 잠금 해제(읽기 실패를 이걸로 바꾸지 않음). 실패 = `read_failed`·`anchor_changed`·`branched`(3판)·`file_changed`·`too_large` → 잠금 유지, 재시도 또는 `unlock_only: true`.
- 잠금만 풀기: 같은 handoff_id·revision 확인 · 기록에 "앱 기록을 가져오지 않고 잠금을 풂" 남김 · 원본 세션을 확인할 수 있으면 같은 id 유지, 없거나 확인 못 하면 `resumable=0`·새 대화 안내 · 안내 = "앱에서 쓴 내용은 화면에 반영되지 않았어요. 이어질 문맥은 Claude 세션 상태에 따릅니다" · 다른 id·최근 바뀐 파일을 대신 고르지 않음.

### 3-7. 화면·MCP·지우기
- A안(공용 대화 메뉴 — 서랍 ⋯·제목 ⌄) **[Claude 앱에서 열기]**, 메뉴 안 단축키 O. 처음 안내는 `storageKeys.ts` 공용 키로 창 단위 저장 — 같은 원본을 씀·돌아오기 전 앱 대화 닫기·앱 자체 도구·권한이 적용됨.
- 상태 구분: 여는 중 · 전달 확인 불가(`uncertain`) · 정상 넘김. 잠금 중 입력·보내기·끌어 넣기·고쳐 보내기·포크·지우기를 막고, 다른 대화로 옮기는 건 막지 않는다. 기존 계획 카드 실행은 유지.
- 가져온 묶음 앞에 출처·시각, 가져온 사용자 글엔 고쳐 보내기 없음. 가져오기 성공 뒤 **서버 대화 스냅샷을 다시 읽는다**(화면이 따로 합성하지 않음). 늦은 응답은 기존 `ticket()`·계정·대화 검사로 버리고, 늦은 목록이 새 잠금을 덮지 않게 `app_revision` 비교. 창 복귀·대화 열기 때 DB 상태를 새로 읽고, 파일 자동 감시는 없음. 새 필드가 없는 옛 서버면 메뉴를 숨긴다(기능 플래그 없음).
- `context` 전체는 내보내지 않는다 — `restore_snapshot()` 에서 `origin`·묶음·생략 표시만 뽑아 API·훅 타입에 반영.
- MCP: `agent_chats`·`agent_chat` 대화 정보에 `in_claude_app` · 가져온 차례에 출처·생략 정보(안내 사건만으로는 MCP `_turn()` 이 안 내보내므로 명시 출력) · 읽기 전용 경로는 `open_db()` 를 안 부르니 새 칸이 없는 DB 는 칸 존재를 보고 기본값.
- 지우기 확인 문구: "Claude 앱에서도 쓰는 원본 세션 파일을 함께 지울 수 있어요. 앱에서 이 대화를 닫아 주세요" — 실제 삭제 여부는 기존 `session_file` 결과로 알린다(앱 목록에서 사라짐을 단정하지 않음).
- 보장 문구: "AI 가 전부 기억" 대신 **같은 세션으로 이어 가기와 화면 반영**만 보장(압축은 기록을 요약으로 바꾼다).

## 4. 0단계 실측(구현 전 · 버리는 세션·임시 데이터만 · Jay 와 정한 범위 — Claude 앱에서 직접 쳐 주셔야 함)
| 항목 | 확인 | 통과·중단 |
|---|---|---|
| M1 열기 | 칸과 같은 제한 옵션으로 만든 세션 · 고른 CLI·데스크톱 내장 CLI 판 · 구독·작업 폴더 · 앱 켜짐/꺼짐 · 출력·종료 코드 | 같은 원본이 Code 탭에 열려야 함 |
| M2 왕복 기록 | 앱에서 두 차례 이상 → 앱 대화 닫기 → 원래 id·경로·본문·본 줄기 · 같은 id 다른 파일·늦은 저장·따로 저장 여부 | 원본에 새 말이 적히고 중복·누락 없이 골라져야 함 |
| M3 이어 가기 | 넣은 뒤 기존 `build_command()` 옵션으로 같은 id 이어 가기 · 앱에서 준 시험 표식 | 복제 세션 없이 문맥이 이어지고 도구·권한 제한도 다시 걸려야 함 |
| M4 Job | breakaway 허용/거부 Job · 멈춘 상태 검사 · 앱 켜짐/꺼짐 · 허브 종료 | 지원 환경에서 앱 유지, 거부·미확인이면 안전하게 막음 |
| M5 재시도·중단 | 다시 열기 · 응답 유실 · 시간 초과 · 전달 직전/직후 허브 종료 · 다시 가져온 뒤 늦은 옛 요청 | 새 세션·자동 잠금 해제·중복 실행 없이 복구 |
| M6 기록 변형 | 같은 이름 병렬 도구 · 실패/미완료 도구 · 그림·문서 · 하위 에이전트 · `/compact`·자동 압축 · 되감기 · `/clear`·`/branch`·`/cd` · 앱 업데이트 | 지원 기록은 정확히, 연속성 확인 못 하면 부분 넣기 없이 분명히 실패 |
- M1~M3 에서 앱이 **다른 id 로 이어 쓰면 구현을 멈추고 목표를 다시 본다**. `/clear`·분기로 다른 세션에 옮긴 건 가져오지 않는다(허브가 늘 알아챈다고 주장하지 않음). `/compact` 로 앵커를 잃으면 성공이 아니라 안전한 실패. 창 닫기 = 세션 실행 종료인지 실측(배경 작업이 남으면 안내를 맞춤). 경로가 옮겨졌으면 경로만 보고 다른 파일을 고르지 않음. 시험 자료는 합성 대화(비밀값·실제 대화 없음), 정리는 만든 대상만.

### 4-1. 실측 결과(11-19, Jay 참여 · 버리는 세션 `37f1eed4…` 하나 · 임시 폴더 cwd · Haiku · MV 생성 없음)
도구 = 세션 스크래치 `desk/measure.py`·`inspect2.py`·`inspect3.py`(허브 `child_env` 처럼 CLAUDE*·ANTHROPIC* 변수를 빼고 공식 설치 `claude.exe` 2.1.322 로 실행). 만든 차례는 칸과 같은 제한 옵션(`--tools ""`·`--strict-mcp-config`·`--permission-mode dontAsk`·`--setting-sources local`).

| 항목 | 결과 |
|---|---|
| M1 열기 | **출력을 받아 가는(파이프) 실행은 거부** — `--desktop opens the Claude Desktop app and can't run non-interactively (--print, --sdk-url, --init-only, or redirected output)`, 종료 1. **새 콘솔(숨김 창)·입출력 넘기지 않음**으로 띄우면 1.4초·종료 0, Claude 앱 Code 탭에 원래 대화가 그대로 열림(Jay 화면 확인 — "시작 위치: 이 컴퓨터 · work"). 앱이 자기 내장 Claude Code 2.1.325 프로세스를 새로 띄움(부모 = Claude 앱 본체 — 띄운 쪽의 자식이 아님) |
| M2 왕복 기록 | 앱에서 쓴 두 마디(도구 Bash 1회 포함)가 **같은 `<id>.jsonl`·같은 세션 id** 에 이어 적힘. 같은 id 를 담은 다른 파일 없음. 앵커에서 parentUuid 줄기가 끊김 없이 이어짐. 앱 줄 표식: `entrypoint: "claude-desktop"`, 사람 글은 `origin: {kind: "human"}`. **첫 사람 글 앞에 앱이 `<system-reminder>` 안내 블록을 같은 메시지에 붙임**. 한 파일에 2.1.322·2.1.325 줄이 섞임. 앱이 `api-request`·`api-request-blob`(요청 본문 통째 — 전역 지침·훅 출력 포함) 줄을 많이 써서 파일이 46KB → 약 1MB(두 차례) |
| M3 이어 가기 | 칸 옵션 `-p --resume <id>` → 같은 id, 앱에서 준 단어("노란바나나")까지 기억, 같은 파일에 이어 적힘 |
| M5 다시 열기 | 앱에 열린 채로 `--desktop --resume` → 종료 1(출력을 못 받아 까닭 미확인) |
| **M5b 동시 쓰기** | 앱에 열린 채로 칸 `-p --resume` 이 **막히지 않고 성공**. 앱 화면엔 그 차례가 안 보임(Jay 확인). 그 뒤 앱에서 쓴 말은 앱이 아는 마지막 메시지에 붙어 **기록이 두 갈래로 갈라짐**(칸 차례와 앱 차례가 같은 부모) — 칸 차례는 버려진 갈래가 됨 |
| M6 압축 | `/compact` → `compact_boundary` 줄은 `parentUuid` 가 비고 **`logicalParentUuid` = 압축 전 끝**. 끝에서 parentUuid 만 따라가면 경계에서 끊겨 앵커 못 찾음, logicalParentUuid 까지 따라가면 앵커에 닿음. 압축 전 줄들은 파일에 그대로 남음. 압축 요약은 `isCompactSummary: true` user 줄, `/compact` 명령은 `<local-command-caveat>`·`<command-name>`·`<local-command-stdout>` user 줄(사람 표식 없음) |
| M4 Job | **앱 켜짐 쪽 통과 · 앱 꺼짐 미측정.** 11-19 14:20 M4 측정(세션 스크래치 `desk/m4.py`, Jay 가 탐색기 Win+R 로 실행 → 측정기 자신은 Job 밖 `runner_in_job=false` = 바로가기로 켠 허브와 같은 조건, CLAUDE*·ANTHROPIC* 변수 없음): 허브와 같은 Job(`KILL_ON_JOB_CLOSE|BREAKAWAY_OK`, `run_agent_session.py:1228-1230`)에 든 '가짜 허브'가 제품 옵션(숨긴 새 콘솔·`CREATE_SUSPENDED|CREATE_BREAKAWAY_FROM_JOB`·입출력 무지정)으로 실행 → **실행기 Job 밖(`launcher_in_any_job=false`) · 재개 0 · 종료 0 · 1.3초** · 가짜 허브 Job 강제 종료 뒤 **앱 본체 유지** · 탈출 금지 Job(`KILL_ON_JOB_CLOSE` 만)은 생성이 **WinError 5 거부** · 재개 전에 끈 실행기는 재개가 `0xC000010A`(끝나는 중)로 실패·세션 안 생김. 앱 본체 자체는 시스템이 만든 Job 안에 있고 부모는 `sihost.exe`(앱 패키지 실행). **도구 셸(Claude 앱 안)에서 띄우면 breakaway 를 요청해도 실행기가 바깥 Job 에 남았다** — 생성 뒤 `_in_any_job()` 재확인이 꼭 필요한 근거. **앱 꺼짐도 통과**(14:31 다시 측정, Jay 가 트레이에서 종료한 뒤 탐색기로 실행): 시작 때 앱 프로세스 0개 → 같은 가짜 허브·제품 옵션 → 실행기 Job 밖 · 재개 0 · **종료 0 · 1.3초**(실행기는 앱이 다 뜨기를 기다리지 않음 — 앱 본체는 약 2초 뒤 새로 시작) · 앱 내장 Claude Code 프로세스가 뜸 · 가짜 허브 Job 강제 종료 뒤 앱 본체 유지(같은 PID 가 그 뒤에도 살아 있음). 남은 확인: 시험 세션이 앱 화면에 열렸는지는 Jay 눈 확인(종료 0 = 전달 명령 완료일 뿐). Job 조회 실패는 실제로 만들 수 없어 단위 시험으로 |

측정 범위(Codex 2차 정정): 위 결과는 Claude 측정·Jay 화면 확인 보고다. `measure.py` 는 고정된 공식 CLI 경로·빈 MCP 설정·**모든 `CLAUDE*` 변수를 뺀 환경**으로 돌렸다 — 제품의 CLI 고르기·칸 MCP 설정·`child_env()`(`CLAUDE_CONFIG_DIR` 등은 남김, `services/agent_chat_process.py:23-24`)와 같은 환경은 아니다.

고칠 곳(→ 3판 3-4·3-5·3-6 에 반영, Codex 재확인 대상):
- **R1 띄우기**: `CREATE_NEW_CONSOLE`(숨김 `STARTUPINFO`) + `CREATE_SUSPENDED`·`CREATE_BREAKAWAY_FROM_JOB`, 입출력 넘기지 않음 → **성공 판정은 종료 코드만**(3-4 의 '출력의 성공 문구' 판정은 쓸 수 없음). 종료 0 = `handed`, 재개 뒤 0 이 아니면 `uncertain`(잠금 유지). '앱 없음' 안내는 실행 전 설치 확인(앱 패키지·내장 Claude Code 폴더)으로.
- **R2 사람 글 고르기**: 앱 줄은 `origin.kind == "human"` 인 user 만 차례로. `<system-reminder>` 블록은 버림. 압축 요약(`isCompactSummary`)·로컬 명령 줄은 사람 글이 아님.
- **R3 압축**: `compact_boundary.logicalParentUuid` 한 가지 연결만 따라가 앵커까지 이어지면 가져오기를 허용(압축 전 줄은 파일에 남아 있음)하고, 못 이으면 지금처럼 `anchor_changed` — 3-5 의 "압축이면 실패"를 바꿀지 Codex 와 확정.
- **R4 갈라짐**: 동시 쓰기를 CLI 가 막지 않음이 실측됐다 → 넘김 잠금은 필수. 가져오기 때 앵커 뒤에 끝(잎)이 둘 이상이면(압축 경계 말고) "기록이 갈라졌어요"로 알리고 넣지 않음(또는 사람 확인) — 확정 필요.
- **R5 다시 열기**: 앱에 열려 있으면 종료 1 → "이미 Claude 앱에 열려 있을 수 있어요 · 앱에서 찾아 주세요"(다른 실패와 구분 못 함).
- **R6 크기**: 앱이 요청 본문 줄을 써서 파일이 빨리 커짐(두 차례 약 20배) → 64MiB 보호 한도에 긴 앱 대화가 걸릴 수 있음, 읽기는 user·assistant·system 줄만 펼침.
- **R7 판 섞임**: 한 파일에 CLI 판·앱 내장 판 줄이 섞임 → 읽기 도구는 판별로 갈라 다루지 않는다.
- **R8 M4 — 11-19 측정 통과**(앱 켜짐·꺼짐 · breakaway 허용/거부 · 재개 실패 · 허브 종료 뒤 앱 유지 · 정지 실행기 정리, 위 M4 줄). 측정은 제품 코드가 아니라 같은 옵션·같은 Job·같은 `child_env` 규칙을 쓴 측정기였으므로 **구현 뒤 실제 허브 코드로 한 번 더**(실사용 활성화 전). Job 조회 실패는 단위 시험. 원래 조건(Codex 2차): 파서·격리 DB·가짜 실행기 구현은 막지 않되, 실제 Agent 데이터의 넘김 경로를 켜기 전에 **제품과 같은 생성 옵션·환경**으로 통과해야 한다 — 앱 켜짐/꺼짐 · breakaway 허용/거부 · Job 조회 실패 · 재개 실패 · 허브 종료 뒤 앱 유지 · 정지 실행기 정리. 앱을 끄는 시험은 Jay 와 정한 별도 시점(사용자 작업 보존). 못 잰 조건을 구조 추정으로 통과 처리하지 않는다.

## 5. 완료 조건과 시험
- 완료 조건: ① M1~M3 정상 왕복에서 같은 원본 id 로 열기 → 넣기 → 다음 차례 ② 전달 뒤 불확실한 실패·재시작에도 잠금 유지 ③ 차례·포크·시작 전 포크·지우기·전체 복원을 서버가 막음 ④ 옛 요청·재시도가 새 넘김을 바꾸거나 중복으로 넣지 않음 ⑤ 넣기는 전부 성공 아니면 전부 실패, 손상·앵커 유실·상한을 성공으로 숨기지 않음 ⑥ 다시 열기·MCP 읽기·포크 복사·백업·복원에서 가져온 기록과 출처 유지 ⑦ 옛 DB·옛 백업·새 필드 없는 서버 화면 유지 ⑧ 외부 기록에서 실행 권한·계획 묶음·화면 동작을 만들지 않음 ⑨ 다른 계정·허브·복원 세대에 늦은 결과가 반영되지 않음 ⑩ 독립 리뷰 높음·중간 해결 뒤 실사용 데이터에 적용.
- 백엔드(저장소 `backend` 폴더, 실행마다 새 basetemp):
```powershell
$ErrorActionPreference = 'Stop'
$env:CONTENT_HUB_NO_PROXY = '1'
& 'D:\ClaudeCode\MV-hub-S-dev\.venv\Scripts\python.exe' -B -m pytest -q -p no:cacheprovider --basetemp (Join-Path $env:TEMP ('mvhub-claude-app-' + [guid]::NewGuid().ToString('N'))) tests/test_agent_chat_claude_app.py tests/test_agent_chat_transcript.py tests/test_agent_chat_api.py tests/test_agent_chat_runtime.py tests/test_agent_chat_connect.py tests/test_agent_chat_manage.py tests/test_agent_chat_fork.py tests/test_agent_chat_restore.py tests/test_agent_chat_mcp_read.py tests/test_agent_chat_screen_actions.py tests/test_backup_v3_local.py
if ($LASTEXITCODE -ne 0) { throw 'Agent backend tests failed' }
```
  요청 취소·계정 전환·복원 접수 경합 · 커밋 직전 실패 · 성공 응답 유실 · 다른 대화의 같은 원본 uuid · 옛 넘김의 늦은 가져오기 · 잘못된 JSON·마지막 불완전 줄 · 파일 교체 · 압축·분기 변경을 넣는다.
  **[3판]** 시험 자료는 보고된 구조를 본뜬 **합성** 기록만(실제 세션 파일·요청 본문·전역 지침은 복사하지 않음). 성공·실패 쌍: 압축 경계 1개 + 직접 이어진 요약 = 성공 / 요약 없음·틀린 부모·다른 세션·순환·압축 2개 = 실패 · 정상 병렬 도구·메타 잎 = 갈래로 오판 안 함 / 서로 다른 사용자 진행 가지·압축 전 경쟁 가지 = 실패 · 정상 human 사이에 origin 빠진 사용자 기록 1개·틀린 origin 타입·모르는 kind·entrypoint = 전체 실패 · 표식 없는 tool_result·압축 요약 = 정상 분류, 그림만 든 human = 차례 생성 · 사람이 입력한 `<system-reminder>`·로컬 명령 태그 문장 = 손실 없음 · 큰 요청 본문 안의 가짜 `type`·`uuid`·`origin` 글자 = 대화로 안 봄.
  실행기 시험은 제품의 정확한 옵션을 검사한다(가짜 CLI 의 파이프 거절만으로 콘솔 동작을 검증했다고 보지 않음). 별도 Windows 시험에서 자식의 표준 핸들이 실제 콘솔인지·정지·재개·Job 동작을 확인하고, 설치 잔여 폴더·조회 실패·확인 뒤 제거·종료 0·비정상 종료·시간 초과·정지 상태 정리 실패를 넣는다.
- 프런트(`frontend` 폴더): `npm.cmd test -- --run tests/agentChatPanel.test.tsx tests/agentChatConnect.test.tsx tests/agentChatTopBar.test.tsx` · `npm.cmd run lint:architecture` · `npm.cmd run build`. 메뉴뿐 아니라 키보드 보내기·끌어 넣기·고쳐 보내기·별도 창의 옛 상태·대화 전환 중 늦은 응답.
- 마무리: `tools/check_code_map.py` · `tools/gen_inventory.py --check`. 실제 Job 동작·데스크톱 왕복은 가짜 CLI 시험으로 대신하지 않는다(M1~M6).

## 6. Jay 결정
- J1 읽기 도구 — **나**(SDK 읽기 로직만 옮김)로 확정 제안(Claude·Codex 같음). 다르게 원하시면 가(공식 패키지, 159MB).
- J2 단추 자리 — A안(메뉴 안) 기준. B안(머리줄 단추)은 고르시면.
- ~~J3 0단계 실측 시점~~ — 11-19 실시(4-1). ~~J4 M4 실측~~ — 11-19 실시·통과(4-1 M4 줄).
- J5 구현 시작 여부 — 격리 구현(파서·DB·가짜 실행기)은 M4 전에도 가능, 실사용 활성화는 M4 통과 뒤.

## 7. 검토 기록
- Claude 설계 1판(11-19).
- Codex 설계 확정 1차(새 세션 `01a1f180-b36f-7a82-810d-f48fa0f8e4b3`, 요청 `gpt-6-astra`·high, 실제 로그 `model: gpt-6-astra`·`reasoning effort: high`·`sandbox: read-only`, 종료 0, 답 = 세션 스크래치 `codex/plan_review_1.answer.md`) — 방향 유지, 지적 9(높음 7·중간 2): D1 시작 전 포크 첫 실행 막기 · D2 시간 초과·응답 유실은 잠금 유지(`uncertain`) · D3 가져오기에 handoff_id·revision · D4 앵커 uuid 만으론 부족(압축·분기·불완전 쓰기 구분) · D5 차례 표 `origin` 칸 대신 `context` · D6 내부 전용 입력 키·짝 없는 도구를 성공으로 안 함·상한 넘으면 넣지 않고 잠금 유지 · D7 넘김 중 전체 복원 409·복원본 넘김 초기화 · D8 "AI 가 전부 기억"·"앱 목록에서 사라짐" 보장 문구 뺌 · D9 앱 쪽 MV 실행 권한을 가정하지 않고 가져온 기록으로 계획 묶음·화면 동작을 만들지 않음. → Claude 가 근거 코드(`routers/agent_chat.py:482` 입력 키 규칙, `services/agent_chat.py:45` 사건 상한, `repo/agent_chat.py:365` 포크 판정, `repo/agent_chat.py:236` 복원 채택)를 직접 확인하고 전부 받아 2판으로 반영.
- 0단계 실측(11-19, Claude 실행·Jay 앱 조작, 결과 4-1) → 3판(Claude): R1 숨긴 새 콘솔·종료 코드 판정·설치 사전 확인 · R2 사람 글 고르기 · R3 압축 경계 한 연결 · R4 갈라짐 실패 · R5 다시 열기 안내 · R6·R7 큰 줄·판 섞임 · 합성 시험 자료. M4 앱 꺼진 경우는 남음.
- Codex 설계 확정 2차(같은 세션 `01a1f180-…` 이어 받기, 요청 `gpt-6-astra`·high·`-c sandbox_mode=read-only`, 실제 로그 `model: gpt-6-astra`·`reasoning effort: high`·`sandbox: read-only`, 종료 0, 답 = 세션 스크래치 `codex/plan_review_2.answer.md`) — **3판 방향 동의**, 조건 6(높음 5·중간 1): P1 실측한 조합은 숨긴 새 콘솔뿐 — 정지·breakaway·Job 종료는 미검증, 표준 핸들 무지정·`STARTF_USESTDHANDLES` 금지·실행기 PID 기록·자동 재개 금지 · P2 내장 CLI 폴더만으로 설치를 확정하지 않음(available·missing·unknown), 종료 0 = 전달 명령 완료(화면 관찰과 구분) · P3 압축 경계는 구조 5조건(요약 직접 자식·경계 하나 등)을 모두 맞을 때만, 측정기의 일반 논리 부모 탐색은 검증이 아님 · P4 갈라짐은 물리 잎이 아니라 정규화한 진행 경로 수, SDK 가 잎을 고르기 전에 검사 · P5 origin 은 건별 검사(하나라도 빠지면 실패), `<system-reminder>` 는 접두만으로 지우지 않음 · P6 측정 환경(모든 CLAUDE* 제거)은 제품 `child_env()` 와 다름, M4 는 미완료·실사용 활성화 전 필수. → Claude 가 근거(`services/agent_chat_process.py:23-24` 변수 빼기 범위, `measure.py` 생성 옵션)를 확인하고 전부 받아 3판에 반영. R5·합성 자료·판 섞임 허용 방향은 동의.
- M4 실측(11-19 오후, 4-1 M4 줄) 통과 — 앱 켜짐·꺼짐 모두.
- **1묶음 백엔드 구현**(Codex 새 세션 `01a1f24f-3b4e-7940-8de9-56be40a71830`, 요청·실제 `gpt-6-astra`·high·`workspace-write`(작업실 + `.tmp` 만), 프롬프트 = 세션 스크래치 `codex/impl_backend.prompt.md`) — 샌드박스 안 Agent 시험 11파일 385+2 실패 → 고침. 총괄 샌드박스 밖 재실행 400 통과·코드 지도·인벤토리 통과.
- **독립 리뷰 1차**(Claude 별도 세션 `e4e2882e-10f7-4da9-8b75-0cc5d9f42ee3`, `claude-opus-5-5` high, 읽기 도구만) — **CHANGES**: 중간 1(설정 폴더를 바꾼 환경에서 앱이 원래 세션을 못 봐 `imported 0` 으로 거짓 성공 — 추정) · 낮음 7(재개 전 실패 까닭 · 같은 초 정렬 · 깨진 넘김 JSON 영구 잠금 · 머리말 글자 깨짐 · 안내 블록 정규식 · 포크 거절 403 · 로그 없음) · 시험 빈틈 6.
- **총괄 실제 기록 확인**(0단계·M4 시험 세션 3개 사본, 세션 스크래치 `desk/real_read.py`) — **높음 H1**: 실제 기록의 메타 줄(`session-owner`·`atis-latch`·`cost-state`·`mode`·`api-request-shape`·`tools-used`, 연결 칸 없음) 때문에 앵커 만들기부터 전부 `read_failed`(합성 시험 자료엔 없던 줄).
- **수정 1차**(같은 Codex 세션 이어 받기, `-c sandbox_mode=workspace-write`, 로그 sandbox 줄 확인) — H1(연결 칸 없는 모르는 종류 = 메타로 건너뜀, 있으면 실패) · 중간 1(`CLAUDE_CONFIG_DIR` 있거나 `cli_home` ≠ 기본이면 `custom_config_dir` 409) · 낮음 2·3·5·6·7·8 · 시험 빈틈 보강, 낮음 4 는 설계대로 닫힌 실패 유지. Codex 423 통과 → 총괄 샌드박스 밖 **423 통과**·코드 지도·인벤토리 통과. 실제 기록 재확인: 갈라진 기록 = `branched` · 몰래 넣은 차례만 뺀 사본 = 앱 사람 글 4개(도구 done·압축 경계 건넘 포함)가 차례 4개 · 새 말 없는 세션 2개 = 0개.
- **독립 리뷰 2차**(같은 리뷰 세션 이어 받기) — **PASS**. 남은 낮음 3: 연결 칸 없이 최상위 `message`·`origin` 을 실은 모르는 종류를 건너뜀(→ 2묶음 때 실패로 바꿈) · `CLAUDE_CONFIG_DIR=""` 도 막힘(보수적, 문구로 안내) · 목록마다 경로 해석(느려지면 기본 경로 한 번만 계산).
- **2묶음 화면 구현**(11-19, Codex, 사용자 지정 작업실·기존 구현 위 수정, 커밋 없음): 제목·서랍 공용 메뉴 A안/O · 창 단위 원본 확인 · 넘김 3상태·입력/포크/삭제 잠금 · 가져오기 뒤 서버 스냅샷 · 잠금만 풀기 확인 · 출처/현지 시각/생략/도구 결과 미확인 · 창 복귀 조회·늦은 응답/낮은 번호 목록 거절 · 원본 파일 삭제 경고. `AgentPlanCard.tsx`는 실행을 유지하면서 고치기만 막기 위해 콜백을 선택값으로 바꿨다. 백엔드 낮음 2개도 반영: 모르는 종류의 최상위 `message`/`origin`은 실패(연결 칸과 같은 존재 검사), 기본 홈 키는 프로필별 한 번 계산(기존 경로 비교 유지).
- **2묶음 보완 판단**: 시안의 완료 안내는 기존 공통 안내 줄(입력칸 위)을 재사용한다. 작업 응답 뒤 스냅샷 조회까지 실패하면 입력·포크·삭제 잠금을 유지하고 `[상태 다시 확인]`만 추가해 읽기로 복구한다(읽지 못한 상태를 성공으로 합성하지 않음). 가져온 시각은 기존 UTC 해석 함수로 PC 현지 시각을 표시한다. 창 복귀 조회는 쓰던 초안·모델을 유지하며, 그 뒤 시작한 차례를 덮지 않는다.
- **2묶음 자기 검증**: 지정 백엔드 11파일 `pytest -q -p no:cacheprovider --basetemp <매번 새 임시 폴더>` **428 통과, 0 실패(613.95초)**. `check_code_map.py` 통과(누락 0), `gen_inventory.py --check` 통과. 프런트 `lint:architecture`와 소스 타입 검사 통과. 지정 화면 시험 4파일과 `npm.cmd run build`는 Vite 설정 적재 중 정션 아래 `node_modules/.vite-temp` 쓰기 `EPERM`으로 중단(화면 시험 실행 0; 빌드는 `tsc -b` 뒤 Vite 단계에서 막힘). 캐시·설정·정션을 바꿔 우회하지 않았다. 신규 화면 시험은 정상 왕복·확인 기억·잠금 경로·실패/잠금만 풀기·늦은 응답·스냅샷 실패 복구를 포함하며 실제 실행은 총괄에게 인계한다. 로그는 작업실 옆 `.tmp`의 `frontend-backend-tests.log`, `frontend-tests.log`, `frontend-build.log`, `frontend-lint.log`. 실제 앱·CLI·네트워크·유료 생성은 호출하지 않음. 독립 리뷰 PASS로 기록하지 않는다.

- **2묶음 fix-1 총괄 보고·정정**: 총괄의 샌드박스 밖 결과는 백엔드 428 통과, 화면 8파일 187 통과·REG2 1 실패, 경계·빌드 통과. 독립 리뷰 `e4e2882e`는 CHANGES. 앞서 요청 본문이 `request`·`data` 안이라고 본 추정은 실제 `api-request-blob`의 최상위 `message` 때문에 틀렸고 실제 3개 기록의 앵커 읽기를 막았다(REG1). SDK가 다루는 메타 종류와 총괄 실측 종류는 본문을 해석하지 않고 건너뛰며, 목록 밖 종류만 연결 칸·`message`·`origin` 존재 시 전체 거절한다. 실측 칸 모양을 본뜬 합성 `api-request-blob`·`queue-operation`을 정상 왕복 자료에 추가했다. 실제 기록 재확인은 총괄에게 인계한다.
- **2묶음 fix-1 반영**: REG2는 `unread_rev`가 낮은 응답을 병합할 때 이전 요약 전체를 살려 `c1`의 새 프로젝트 `p1`을 잃은 원인이다. 읽음 필드만 보존하고 새 메타는 반영하며 기존 후보 15개 기대값을 유지했다. 리뷰 1은 보관 요청의 상태 번호·넘김 대상이 모두 같을 때만 재사용, 2는 오류를 해당 대화에만 표시, 3은 `launcher_uncertain`에서 잠금만 풀기를 숨기고 상태 읽기만 제공, 4는 `unlock_only`·`supplement`를 안내 줄로 표시, 5는 확인 문구를 실행 전 시제로 변경, 6은 명시적 대화 열기에서 낮아진 서버 상태 번호를 받아 복원 뒤 빈 화면을 방지했다. 서버 처리 뒤 응답 유실·서랍 다른 대화 열기·오류 이동·복원 낮은 번호를 회귀 시험에 추가했다. 미반영 지적 없음.

- **2묶음 fix-1 자기 검증**: 지정 백엔드 11파일을 새 `basetemp`로 실행해 **431 통과·0 실패(665.18초)**. `check_code_map.py` 누락 0, `gen_inventory.py --check`, `lint:architecture`, 최종 소스 타입 검사와 화면 시험 파일 구문 검사 통과. 첫 빌드에서 찾은 보관 요청의 `undefined` 타입 오류는 명시적 존재 검사로 수정했다. 지정 화면 8파일은 실행 전 Vite 설정 적재의 공유 정션 `node_modules/.vite-temp` 쓰기 `EPERM`으로 중단(시험 실행 0). 최종 `npm.cmd run build`도 `tsc -b` 통과 뒤 같은 Vite 쓰기 제한으로 중단했다. 캐시·정션·설정 우회 없음. 로그는 작업실 옆 `.tmp/frontend-fix1-{backend,tests,build,lint}.log`. REG2를 포함한 화면 동작·실제 기록 3개·독립 재확인은 총괄에게 인계하며, PASS로 기록하지 않는다. 프로젝트 전용 근거이므로 기억·볼트에는 복제하지 않음.

- **2묶음 fix-2 총괄 보고·반영**: 총괄의 fix-1 샌드박스 밖 화면 결과는 195 통과·서랍 시험 2 실패, 경계·빌드 통과. 실제 기록 3개는 `branched`·정상 4개·새 말 없음 0개로 기대대로였고, 독립 재확인은 PASS(낮음 3)라는 보고를 받았다. 다른 대화의 앱 열기는 서랍을 유지해 해당 줄의 모니터를 갱신하고, HTTP 오류·실행 시작 실패는 공통 안내 줄에 한 번 표시한다. 낮은 상태 번호 수용은 명시적 복원 기록 조회이며 같은 대화의 앱 작업이 진행 중이지 않을 때로 제한한다. 앱 열기 중 같은 대화 재조회는 기존 화면·잠금을 유지하며 일반/복원 기록의 늦은 조회를 시험한다.
- **바뀐 병합 규칙(fix-1 REG2·fix-2 낮음 3)**: 낮은 `unread_rev` 응답에서도 이름·고정·보관·프로젝트는 병합 시 들어온 응답 값을 반영하고, 읽음 필드만 높은 번호의 값을 보존한다. `app_revision` 보호와 목록 요청 이후 로컬 변경을 지키는 순번 검사는 별도로 유지한다.

- **2묶음 fix-2 자기 검증**: 허용된 Vite 캐시 두 폴더를 사용한 지정 화면 8파일 **200 통과·0 실패(61.63초)**, `lint:architecture`·`npm.cmd run build` 모두 종료 코드 0. `check_code_map.py` 누락 0, `gen_inventory.py --check`·`git diff --check` 통과. 이번 수정은 화면·시험·본 문서에 한정해 백엔드 묶음은 재실행하지 않았다(앞 fix-1 431 통과 재사용). 로그는 작업실 옆 `.tmp/frontend-fix2-{tests,lint,build}.log`. 낮음 3건 모두 반영했고 실제 앱·CLI·네트워크·다른 에이전트 호출·커밋은 하지 않았다. 프로젝트 전용 변경이므로 기억·볼트에는 복제하지 않음.

- **격리 허브 실제 왕복(11-19~20, 총괄 실행·Jay 앱 조작)** — 작업실 코드(0b591304)로 격리 허브 H 8241·서버 S 8242(`data_test/db` 임시 복사본, 일회용 계정, MV Agent 기록 폴더도 격리, Job 밖 실행)를 띄웠다. Haiku 로 버리는 대화 하나를 만들고(세션 `09a0e6fb…`), 메뉴 → 확인 창 → [열기]. 허브 로그 `exit_code=0 classification=handed 1.547초`, 칸 잠금은 시안대로였다. Claude 앱 `main.log` 17:18:26~27 에 "Resume deep link: importing CLI session" → "Imported … as Desktop session local_09a0e6fb…" → 본창이 그 세션으로 바뀜. Jay 가 앱에서 두 마디를 쳤다(`entrypoint: claude-desktop`·`origin: human` 2개). [여기로 가져오기] → 구분선 "Claude 앱에서 이어진 대화"·차례 2개·생각 과정 생략 표시·"Claude 앱에서 쓴 말 2개를 가져왔어요", DB `imported: 2`·`app_handoff: null`·각 차례 `context.origin = claude_app`. 가져온 글엔 고쳐 보내기 없음(첫 MV Agent 글에만 남음, 3-7 대로). 이어서 MV Agent 에 물은 "두 번째 시험 단어" → "빨간노을". 새 차례는 같은 세션 파일에 앱의 마지막 줄을 부모로 이어 적혔다(파일 하나·갈라짐 없음). 정리: 격리 서버 끔·복사본 삭제, 실제 `%LOCALAPPDATA%\MVHub\agent_chat\profiles` 에 생긴 시험 파일 1개는 세션 스크래치로 옮김.
- **왕복에서 찾은 것(고칠 후보, 코드 0)**: ① 앱 목록에 제목 **"Untitled"** 로 들어가고 첫 말이 MV Agent 안내문이라 Jay 가 하룻밤 뒤 못 찾았다("앱에 안 열렸어" → 앱 로그로 열린 것 확인). CLI 에 `-n, --name` 은 있으나 `--desktop` 과 함께 앱 제목까지 가는지 미확인. ② "N개를 가져왔어요" 안내가 다음 차례 뒤에도 맨 아래 남는다. ③ 도구를 안 쓴 가져온 차례에도 "외부 도구 결과는 실행 권한이 아닙니다"가 붙는다. ④ 입력칸 옆 돌아가는 표시가 계속 보였다(격리 서버 탓인지 미확인).

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-claude-app-2026-11-19",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "88edc1da-c224-472f-a96b-4dd708f63196"},
  "risk": {"level": "major", "reason": "칸 기록 DB 에 칸을 더해 넘김 잠금을 두고, Job 밖으로 외부 앱을 띄우며, Claude 세션 기록을 읽어 차례·사건으로 넣고, 포크·지우기·복원 경로를 막는다"},
  "goal": "MV Agent 의 Claude 대화를 Claude 데스크톱 앱에서 같은 세션 id 로 열어 이어 쓰는 동안 칸을 잠그고, [여기로 가져오기] 로 앵커 뒤 본 줄기를 이 대화의 차례로 한 거래에 넣은 뒤 같은 세션으로 계속 대화한다. 불확실하면 잠금을 유지한다.",
  "touched_paths": ["backend/app/repo/agent_chat.py", "backend/app/routers/agent_chat.py", "backend/app/services/agent_chat.py", "backend/app/services/agent_chat_claude.py", "backend/app/services/agent_chat_transcript.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/lib/useAgentChat.ts", "frontend/src/lib/storageKeys.ts", "frontend/src/components/agent-chat/AgentPanel.tsx", "frontend/src/components/agent-chat/AgentPlanCard.tsx", "frontend/src/styles/agent-chat.css", "backend/tests/test_agent_chat_claude_app.py", "backend/tests/test_agent_chat_transcript.py", "backend/tests/agent_chat_fake_cli.py", "backend/tests/fixtures/agent_chat_transcript_cases.json", "backend/tests/test_agent_chat_fork.py", "backend/tests/test_agent_chat_restore.py", "backend/tests/test_agent_chat_mcp_read.py", "backend/tests/test_backup_v3_local.py", "frontend/tests/agentChatPanel.test.tsx", "docs/CODE_MAP.md", "docs/inventory/endpoints.md"],
  "criteria": [
    {"id": "measure", "success": "실측 M1~M6 — 같은 원본 id 로 열림·같은 세션 파일에 이어 적힘·읽기 도구가 앵커 뒤 본 줄기를 찾음·같은 id 이어 가기에 문맥과 제한 유지·변형 기록은 정확히 또는 분명히 실패, 그리고 실사용 활성화 전 제품과 같은 생성 옵션·환경으로 M4(앱 켜짐/꺼짐·breakaway 허용/거부·Job 조회 실패·재개 실패·허브 종료 뒤 앱 유지·정지 실행기 정리) 통과", "failure": "지원 형태의 정상 가져오기 실패, 미지원·손상 형태의 조용한 누락·부분 넣기, Job 안전 조건 실패(의도적으로 거절해야 하는 자료의 안전한 실패는 실패가 아님)", "required": true, "verification": []},
    {"id": "backend", "success": "위 백엔드 시험 묶음 통과(열기 조건·Job 판정·uncertain 유지·stale 요청 거절·시작 전 포크 무효화·가져오기 바꾸기·멱등·상한 413 잠금 유지·읽기 실패와 잠금만 풀기·복원 409·다음 차례 같은 id)", "failure": "시험 실패", "required": true, "verification": []},
    {"id": "screen", "success": "MV Agent 칸 시험(메뉴·안내·상태 구분·잠금 경로·스냅샷 다시 읽기·늦은 응답 버림) + 경계 검사·빌드·코드 지도·인벤토리 검사 통과", "failure": "시험·빌드·검사 실패", "required": true, "verification": []}
  ],
  "references": [],
  "decisions": [
    {"choice": "원본 세션 그대로 열고(사본 없음) 넘김 동안 칸을 잠근 뒤 누를 때만 가져온다", "why": "같은 세션을 이어 써야 화면과 세션 문맥이 맞고, 잠금이 동시 쓰기를 줄인다", "alternative": "사본으로 열기(가져올 세션 id 를 알 수 없음) / 자동 동기화(동시 쓰기·감시 비용)", "revisit": "Claude 앱 쪽 세션 id 를 알려 주는 공식 길이 생기면"},
    {"choice": "가져온 말은 지금 차례·사건 모양으로 넣고 출처는 context 에 둔다(차례 표 칸 추가 없음)", "why": "화면·MCP 읽기·백업·포크 복사가 손대지 않고 보이고 스키마 변경이 작다", "alternative": "차례 표 origin 칸 / 따로 표", "revisit": "출처로 검색·정렬해야 하면"},
    {"choice": "SDK 0.2.184 읽기 로직을 쓰되 앵커·앞 지문을 보존하고 이번 넘김 구간의 검증된 압축 경계 하나만 논리 부모로 잇는다. 메타와 입증된 병렬 도구를 정규화한 뒤 대화 진행 경로가 둘 이상이거나 분류가 불명확하면 전체 거절", "why": "SDK 통째(159MB)는 무겁고 직접 최소 읽기는 줄 순서 가정이 틀린다. 실측 보고에서 압축 전 기록과 논리 연결이 남았지만, 측정기의 일반 논리 부모 탐색·물리적 잎 계산은 제품의 안전한 판정을 대신하지 못한다", "alternative": "SDK 패키지 의존 / 직접 최소 읽기 / 압축이면 늘 실패 / 시각·유사도로 이어 붙이기 / 갈래 중 최신 하나를 골라 넣기", "revisit": "복수 압축·새 기록 형태가 필요하면 그 자료와 반례를 먼저 확보해 지원 범위를 다시 본다 · 옮긴 코드가 형식 변경으로 깨지면 SDK 새 판에서 다시 옮김"},
    {"choice": "새 사용자 후보를 건별로 검증하고 일부 표식 누락도 전체 실패로 다룬다. 텍스트 태그만으로 사람 입력을 지우지 않는다", "why": "일부 기록의 조용한 누락과 사람 글의 잘못된 삭제를 막는다", "alternative": "origin 의 전역 존재 여부만 확인 / 태그 접두로 삭제", "revisit": "사람 입력과 앱 삽입 내용을 가르는 공식 구조가 생기면"},
    {"choice": "격리 구현은 진행할 수 있으나 제품 옵션의 M4 와 앱 꺼짐 시험은 실사용 활성화 전 필수", "why": "지금 보고는 실행 방식의 가능성을 보였을 뿐 실제 Job 수명과 앱이 꺼진 상태의 시작까지 검증하지 않았다", "alternative": "구현 전체 보류 / 구조 추정으로 M4 통과 처리", "revisit": "그 실측이 실패하면 실행 설계를 다시 본다"},
    {"choice": "전달 여부가 불확실하면(uncertain) 잠금을 유지하고, 가져오기 실패·상한 초과도 넣지 않고 잠금 유지 후 사람이 잠금만 풀기를 고른다", "why": "앱에 넘어간 세션을 칸이 모르게 동시에 이어 쓰거나 기록이 반쯤 들어가는 일을 막는다(실측: CLI 는 앱에 열린 세션의 동시 이어 쓰기를 막지 않는다)", "alternative": "실패하면 자동 해제 / 앞을 버리고 성공 처리", "revisit": "없음"},
    {"choice": "claude --desktop 은 숨긴 새 콘솔·표준 입출력 무지정·정지 생성·breakaway 로 띄운다. 설치 등록과 실행 대상을 사전 확인하고, 검증한 환경의 종료 0 은 전달 명령 완료로 기록한다. 전달 여부나 정리가 불확실하면 잠금을 유지한다", "why": "파이프 실행 거부와 숨긴 새 콘솔 성공은 Claude 실측 보고로 확인됐으나, 정지·breakaway 조합과 앱 꺼짐 조건은 아직 검증되지 않았다", "alternative": "출력 문구로 판정 / 의사 콘솔(ConPTY)로 출력 받기", "revisit": "CLI 가 비대화형 열기나 기계용 결과를 지원하면"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": [
    {"host": "codex", "session": "01a1f180-b36f-7a82-810d-f48fa0f8e4b3", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/19/rollout-2026-11-19T10-51-46-01a1f180-b36f-7a82-810d-f48fa0f8e4b3.jsonl"}
  ], "review": null}
}
```
