# MV Hub MCP 어댑터

## 참고 그림 가져오기·검색 (2026-10-28)

어댑터 `2026.10.28.1`의 영속 연결은 `import_reference(file_path, workspace_scope, workspace_id?, asset_project?, project_id?, label?)`를 제공한다.
현재 프로세스의 `CLAUDE_CODE_SESSION_ID`에 해당하는 `%TEMP%/claude/<프로젝트>/<세션>/images/` 한 폴더의 바로 안 PNG·JPEG·WEBP만, 최대 64MiB까지 스트리밍한다.
세션 정보가 없는 Codex 첨부는 지원하지 않는다. 앱 에셋 탭에서 imp/cap에 가져온 뒤 검색한다.
이 경계는 MCP의 임의 경로 읽기를 막는 것이며, 같은 폴더에 다른 도구가 넣은 파일까지 사용자의 직접 첨부임을 보증하지 않는다.

응답 `reference.id`를 같은 연결·공간의 `prepare_generation_plan.items[].reference_ids`에 넣는다.
`asset_project`가 있으면 모든 단일 프레임 그림을 대조해 보수적인 조건에서만 가장 닮은 원본을 연결한다(동일 원본의 증명은 아님).
썸네일 캐시가 없는 첫 대조는 15초 안에 끝나지 않을 수 있다. 불완전·모호·시간 초과·busy이면 imports 사본과 후보 최대 5개를 반환한다.
애니메이션 WEBP는 사본으로만 저장한다. `project_id`는 앱 가져오기와 같은 공유 동기화를 예약하며 `sync_state`는 로컬 저장 성공과 별도로 확인한다.

`read_context(kind="references", asset_project=..., search="폴더 낱말", offset=0)`은 전체 경로의 공백 구분 낱말을 모두 찾는다.
응답 `references[].path`와 `next_offset`을 사용하고, `next_offset=null`이면 마지막 페이지다. 페이지 사이 트리가 바뀌면 중복·누락될 수 있다.
`offset`은 생략하면 전송하지 않는다. 가져오기는 `reference_import`, 명시적 offset 검색은 `reference_search` 기능이 있는 허브가 필요하며 구형 허브에서는 해당 새 호출만 `hub_outdated`다.
백엔드 변경도 포함하므로 이 기능은 본체 업데이트가 필요하다. 어댑터 파일만 교체해서 활성화되지 않는다.

## MCP 파일 독립 업데이트 (개발판, 2026-10-27)

전체 구현·검증 상태는 [작업 기록](../../docs/status/mcp_independent_update_2026-10-27.md)이 정본이다. 운영 배포는 아직 하지 않았다.

최초 본체 도입 업데이트에 고정 `update.py`·설정 UI·서버 콘솔을 포함한다. 이후 검증하고 기존 승인 절차를 거친 main 커밋의
`server.py`만 서버 콘솔에서 후보로 가져와 게시한다. 기존 릴리스 위치의 `mcp/versions/<commit>`에 파일과 manifest를 두며 ZIP을 만들지 않는다.
사용자 설정에서 새 판을 확인하고 적용하면 설치 위치별 `%LOCALAPPDATA%/MVHub-MCP/updates/<identity>`에 준비한다. 사용자 PC에 Git은 필요 없다.
기존 등록의 설치본 `server.py` 경로와 DPAPI 프로필은 유지한다. 실행 중인 MCP는 바뀌지 않으며 재연결/클라이언트 재시작 뒤 새 판을 선택한다.

독립 범위는 어댑터 코드 한 파일이다. 고정 실행기·`local_setup.py`·SDK 잠금·Python·MV 백엔드 변경은 본체 업데이트가 필요하다.
NAS는 기존 설치 원본과 공유 권한을 신뢰한다. 해시는 손상 검사이며 서명이 아니다. HTTP 원본과 HTTPS의 다른 출처/HTTP 이동은 거절한다.
불변 버전 폴더를 완성한 뒤 포인터만 전환한다. 본체 잠금과 경합하면 거절하며 실패 시 기존 판을 보존한다. 첫 독립판은 번들로,
그 뒤에는 직전 독립판으로 되돌릴 수 있다. 실행 중인 코드/파일을 지우지 않도록 자동 버전 정리는 하지 않는다.
본체 버전 또는 번들 코드가 달라지면 기존 독립 포인터를 무효화하고 새 본체 기준으로 다시 확인한다.

`display_context`는 권한을 확인한 생성물의 실제 원본 job ID를 전달하는 준비 정보다. 힉스필드 커넥터의 접근 권한과 화면 지원은 별도 확인이 필요하다.
기본 미리보기는 유지하며 외부 위젯과 본문 이미지를 자동으로 함께 내보내지 않는다. 데스크톱 카드 유지·모바일 표시·중복 방지의 동시 충족은 아직 미검증이다.

격리 시험: `python -B tools/mcp_adapter/test_update.py -v` (임시 폴더와 가짜 원본만 사용).

## 현재 작업: 영속 연결 v2

같은 PC의 Codex·Claude Code는 MV Hub의 **설정 → MV·MCP 연결 열기 → Codex·Claude Code 연결 허용**에서 등록한다.
다른 로컬 stdio MCP 앱은 그 화면에서 제공하는 설정을 한 번 복사한다. 클라이언트 자체 신뢰 승인과
최초 MCP 새로고침/재시작이 필요할 수 있다. 웹·휴대폰 원격 커넥터는 이번 범위가 아니다.
MV Hub와 LLM은 같은 Windows 로그인 사용자로 실행한다. 서비스 계정이나 다른 사용자 실행은 자동 등록을 차단한다.
기존 설정 사본은 설정 파일 옆에 두 개로 보존되며 외부로 공유하지 않는다 — `.mvhub-original`(처음 등록 전 원래 설정, 한 번만 남기고 다시 쓰지 않음)과
`.mvhub-backup`(바로 앞 내용, 등록할 때마다 교체). 바로 앞 사본의 mvhub 항목은 회수된 옛 연결이라, 되살렸으면 MCP 를 다시 등록해야 한다.
예전 판이 만든 `.mvhub-backup-<무작위>` 사본은 자동으로 지우지 않는다(필요 없으면 사람이 확인해 지운다).

v2 등록 설정에는 `--url`과 `--profile`이 들어간다. 프로필은 Windows DPAPI로 암호화하며
클라이언트별로 분리한다. 설정에는 프로필 파일 경로만 있고 비밀 원문이나 허브 로그인 토큰은 없다.
최초 등록 뒤에는 재연결 코드를 입력하지 않는다. 다시 등록하면 같은 클라이언트의 앞 연결은 회수되고 그 프로필 파일도 지운다.
**연결을 막는 것과 끊는 것은 다르다**(Jay 2026-10-16 A안): 로그아웃·다른 계정 전환은 그동안 사용을 **막을 뿐**이며, 같은 계정·같은 권한으로
돌아오면 다시 등록하지 않고 쓸 수 있다. 영구 회수는 앱의 **연결 해제** 또는 성공한 다시 등록이다. 비밀번호를 바꾸면 다시 등록해야 한다.
로그인 없이 쓰는 허브(AUTH off)의 등록은 이 PC 의 로컬 브라우저 문맥(루프백·Host·탭 헤더)과 활성·승인 계정 확인을 거친다 —
정상 화면에서는 사용자가 허용하지만, 이미 로그인된 PC 의 **로컬 프로세스**에 대해 사용자가 직접 동의했다는 별도 증명은 아니다(헤더 수준).

현재 허브는 이 MCP 등록의 `--url`과 프로필로 인증한 허브다. 특정 포트나 열린 브라우저 탭을 기준으로 선택하지 않는다.
`check_connection` → `connect`로 연결을 확인하고, **같은 MCP 연결**에서 아래 조회·계획·실행·대기·표시를 이어간다.
허브를 바꾸면 공간·모델·프로젝트·자료·결과 ID를 새 연결에서 다시 조회한다. 서로 다른 허브는 자료와 결과가 다를 수 있다.
`not_found`이면 현재 허브의 공간·프로젝트·폴더·검색어로 다시 찾고, 다른 포트 자동 탐색이나 자동 재생성은 하지 않는다.

새 등록은 계정 기준이며 현재 앱의 공간 선택에 묶이지 않는다. 기존 공간 고정 연결은 명시 재등록할 때만 바뀐다.
`read_context(kind="workspaces")`로 실제 접근 가능한 공간을 조회한 뒤, 다른 조회와 계획에
`workspace_scope`와 팀 공간의 `workspace_id`를 명시한다. 기본 생성은 캔버스 없이 MV Hub 라이브러리에 기록된다.
`read_context`로 실제 모델·프로젝트·컷·자료를 확인하고 `prepare_generation_plan` → `execute_generation_plan` →
`wait_results(plan_id, item_indexes, wait_seconds=25)` → `show_results(plan_id, item_indexes)` 순서로 처리한다.
한 번에 1~8개 항목을 선택하며 대기는 이미지 카드를 만들지 않는다. `all_terminal`이면 대기를 멈추고,
`all_done`이 false이면 실패·취소·확인 필요 항목을 함께 안내한다. 25초는 대기 예산이며 조회·권한 확인 시간이 더해질 수 있다.
`get_result`는 기존 단건 호출 호환용으로 유지한다.
어댑터 `2026.10.28.1`은 같은 서버의 `--display-mode`로 표시 경로를 하나 선택한다.
Codex 자동 등록은 `conversation`을 지정하며 다른 클라이언트와 플래그 없는 기존 설정은 `native`다.
`conversation`은 MCP Apps 자원·UI 메타·앱 전용 도구를 등록하지 않는다(모델용 14개, 가져오기 포함).
`get_result`·`get_generation`·`show_results`는 표시 파일만 준비하고 ImageContent·별도 설명 블록을 보내지 않는다.
`native`는 파일 없이 ImageContent로만 새 결과를 표시한다(총 15개, 가져오기 포함). 구형 연결은 7개다.
단건·묶음 조회 모두 이미지 뒤에 일반 `card_text` 텍스트 블록을 한 번 반환한다.
`get_result`·`get_generation`·`show_results`에 UI `resourceUri`를 붙이지 않아 Apps 화면을 자동으로 함께 열지 않는다.
Apps 광고 여부로 분기하지 않으므로 미지원 클라이언트에도 기존 ImageContent를 유지한다.
두 모드 모두 실행 도구에는 결과 UI를 붙이지 않는다. 실행 → 대기 → 결과 조회 순서로 한 번 표시한다.
`ui://mvhub/result.html` 리소스·이전 실행 카드의 `live_plan_id` 처리·앱 전용 `read_display_results`는
이미 열린 카드의 호환을 위해 보존한다. 새 결과 도구와 자동 연결하지 않으며 옛 카드의 실제 호스트 동작은 미확인이다.
새 실행 응답은 `live_plan_id`를 만들지 않는다. 호환 코드의 자동 확인은 10분 뒤 또는 오류·숨김·해제 시 멈춘다.
**기존 Codex는 어댑터 업데이트만으로 전환되지 않는다.** MV Hub에서 Codex 연결을 다시 등록하고
MCP를 재연결한 뒤 `check_connection`의 버전과 `display_mode=conversation`을 확인한다.
설치본 파일·전역 등록 설정은 소스 수정이나 미리보기 검증에서 자동으로 바꾸지 않는다.
안내는 실제 카탈로그 모델명과 저장 위치를 사용하며 내부 ID는 구조화 데이터에만 남긴다.
새 연결에서도 권한 공간별 최초 조회로 이름을 확인한다. 카탈로그 실패 시 결과를 유지하고 모델명 미확인을 표시한다.
백엔드는 이미지 원본을 먼저 기존 안전한 썸네일 경로로 읽고, 실패하면 기존 썸네일로 돌아간다.
미리보기는 긴 변 1024px·512KiB 이내이며 크면 512/256px로 낮춘다. `미리보기 크게 보기`는 원본 보기가 아니다.
원본은 MV Hub에서 확인하며 원본 주소·로컬 파일 접근 권한을 새로 공개하지 않는다.
**conversation 모드에서는** 이미 존재하는 이 작업 소유 로컬 폴더를 `display_directory`로 반드시 지정한다.
예: `show_results(plan_id, item_indexes=[0,1,2], display_directory=<작업 폴더 절대경로>)`.
응답의 `display.status=ready`인 `display.reference`를 최종 답변에 그대로 한 번 포함한다.
표시 파일은 이미지만 담는다. 바로 아래에 해당 `card_text`를 일반 대화 텍스트로 한 번 안내한다.
묶음 조회는 `items[i].display`와 `items[i].card_text`를 사용하며 맨 위 묶음 `card_text`는 출력하지 않는다.
표시 파일 없는 실패·취소·미확인 항목도 해당 설명을 한 번 안내한다.
`delivery.card_in_display=false`, conversation 항목의 `repeat_card_text=true`가 이 계약을 나타낸다.
휴대폰 첨부에서 `.16.1`의 HTML 안 설명은 보이지 않았고 일반 대화 텍스트는 보였으므로 표시 위치를 분리했다.
일반 URL·PC 경로·HTML Markdown 링크로 바꾸지 않는다.
표시 파일은 검증한 JPEG를 포함하며 외부 요청이 없다. 로컬 사본과 경로가 대화에 남고,
설치본·`backend/data`·NAS를 표시 폴더로 쓰지 않는다. 폴더 자동 생성·기존 파일 덮어쓰기는 하지 않는다.
`native` 모드는 폴더를 생략하고 네이티브 이미지로만 표시하며 답변에 중복 삽입하거나 Apps 화면을 추가로 열지 않는다.
모드와 폴더 인자가 맞지 않으면 허브 조회 전에 거부한다. 표시 파일 저장 실패 시 다른 표시 경로를
추가하지 않고 오류를 안내한다. 새 생성 없이 유효한 작업 폴더로 결과 조회만 다시 한다.
표시 정보는 content/structuredContent와 기존 호환용 `_meta.display`에 함께 반환한다.
이미지 수신·파일 준비는 실제 화면 표시 확인과 다르다.
Codex·Claude 공통으로 실행 전 조건·위치를 알리고 `presentation.stage` 변경 시 `message`를 안내한다.
`card_text`(상태→조건→위치)는 공통으로 만들고 선택한 표시 경로에서만 보여 준다. 선택 항목 완료는 전체 완료가 아니다.
네이티브 이미지 미지원 호스트에서는 표시 제한과 MV Hub 확인 방법을 안내하며 Apps로 자동 우회하지 않는다.
Higgsfield의 전용 위젯 지원이 임의 로컬 MCP에도 적용된다고 가정하지 않는다. 앱별 실표시는 별도 확인한다.
미리보기 조회는 생성·과금 없이 기존 결과만 읽는다. 영상은 기존 포스터만 표시하고, 원본은 MV Hub에서 확인한다.
기존 결과와 다른 LLM에서 만든 본인 결과는 현재 연결의 `read_context(kind="generations")`로 찾아
`get_generation(generation_id, workspace_scope, workspace_id)`으로 다시 표시한다. 계획 조회·실행은 원래 클라이언트만 가능하다.
목록의 `next_cursor`가 있으면 같은 필터와 `cursor_ts`, `cursor_id`를 다음 요청에 전달한다.
`pagination_unavailable`이면 오래된 기록의 정렬 정보가 없어 후속 페이지를 확인하지 못한 상태다.
`folder_path`, `media_type`으로 범위를 좁히고 `asset_count`로 여러 미디어를 확인한다.
`estimate_plan(plan_id)`은 선택형 예상 비용 조회다. `credits:null`은 확인 불가이며 0이 아니다.
실제 차감액을 보장하지 않으며 견적 조회가 생성 실행을 승인하지 않는다.
`check_connection`의 `adapter.version`, `hub_features`, `reload_required`, `apps_negotiated`로 실제 실행 버전과
화면 확장 협상 여부를 확인한다. `available`만으로 계정 연결·생성 준비·화면 표시가 검증되지는 않는다.
`apps_available`·`apps_negotiated`는 확장 능력 정보이며 결과 화면 자동 연결 여부를 뜻하지 않는다.
실행 중인 구형 MCP는 새 파일을 자동으로 읽지 않으므로 LLM에서 MCP를 다시 불러와야 한다.
오류는 `error={code,message,retryable,next_action}`으로 반환하며 비공개 서버 오류 원문을 전달하지 않는다.
`retryable`은 지정한 조회를 다시 시도할 수 있다는 뜻이며 실패한 생성 요청을 재제출하라는 뜻이 아니다.
MCP 이미지 표시를 지원하지 않는 앱에서도 생성 ID와 상태는 텍스트로 확인할 수 있다. 도구 설명은 완료 뒤 결과 조회를 안내한다.
프로젝트·컷을 생략할 수 있다. `add_to_canvas`는 사용자가 요청할 때만 `scene_id`를 명시하며 새 생성을 하지 않는다.
브라우저 탭을 닫아도 기본 생성은 가능하지만 허브 서버와 작업자는 실행 중이어야 한다.

새 포장 파일 `local_setup.py`는 표준 라이브러리만 사용한다. 실제 등록 시험은 임시 사용자 폴더에서 실행한다.

```powershell
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_server.py
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_local_setup.py
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_persistent.py
```

v2 구현·검증·독립 리뷰 상태의 정본은 [MCP 운영 문서](../../docs/MCP_INTEGRATION.md)다.
아래 '구형 v1 계약과 개발 검증 이력'·'사용'·'범위와 제한'·'이 PC의 재사용 설정' 절은 `--url`만 쓰는 **구형 v1 설정과 당시 실증 기록**이다.
v2에 코드 페어링·탭 상주·단일 클라이언트 제한을 적용하지 않는다. **'릴리스 번들 계약' 절은 현행**이다.

## 구형 v1 계약과 개발 검증 이력

Claude·Codex 같은 MCP 클라이언트가 **열려 있는 MV Hub 앱**과 연결하는 로컬 stdio 어댑터다.
힉스필드에 직접 생성 요청을 보내지 않는다. 자료 조회와 생성 계획 준비를 도구로 제공하고,
최초 앱 연결에서 실행을 허용하면, 명확한 사용자 생성 요청에 따라 기존 생성·기록 경로로 바로 실행한다.
생성마다 앱 승인 버튼을 누를 필요는 없다. 연결한 앱은 열어 두어야 한다.

## 릴리스 번들 계약 (개발 검증 완료)

릴리스 제작 코드는 `server.py`, `requirements.txt`, `requirements.lock.txt`와 전용
`tools/mcp_adapter/site-packages`를 함께 포장한다. 잠근 의존성 29개를 판과 지문(SHA256)까지 고정해
`pip --isolated install --require-hashes --only-binary=:all:`(이 PC 의 `pip.ini` 무시, 소스 빌드 금지)로 설치하며 —
지문이 다르거나 휠이 없거나 잠금에서 빠진 하위 의존성이 있으면 릴리스가 멈춘다 — 백엔드 Python 패키지와 별도로 관리한다.
**번들 의존성 갱신**(판을 올릴 때만 — 매 릴리스마다 새로 고르지 않는다): ① `requirements.txt`(직접 요구)의 판을 올린다
→ ② Python 3.14 x64 로 빈 폴더에 `pip --isolated download --only-binary=:all: -r requirements.txt -d <빈 폴더>`(지문 없는 직접 요구로
하위 의존성까지 새로 확정 — 지문이 붙은 옛 잠금을 입력으로 쓰면 판이 충돌하고 새 하위 의존성이 빠진다) → ③ 받은 휠 **전부**의 판과
SHA256 으로 `requirements.lock.txt` 를 다시 쓴다(핀 아래 `--hash=sha256:…`) → ④ 또 다른 빈 대상에 릴리스와 같은 설치 명령
(`--isolated --require-hashes --only-binary=:all:`, `--no-deps` 없이)으로 설치해 의존성까지 맞는지 확인한다. 시험 `backend/tests/test_release_frontend_build.py`(`mcp_lock`·`mcp_install`). 실행 파일은 설치 폴더의 `runtime/python/python.exe`이고
인자 순서는 `-I`, `-S`, 어댑터 절대 경로, `--url`, 로컬 허브 주소다(v2 등록은 그 뒤에 `--profile`, 프로필 파일 경로).
두 격리 옵션을 생략하지 않는다. `/api/mcp/app/setup`의 `python_args`가 이 순서를 제공한다.
개발 환경은 빈 목록이며 예전 응답에 필드가 없어도 기존 설정을 유지한다.

릴리스 번들이 불완전하면 설정 조회가 503 `MCP 번들이 불완전합니다. 앱을 다시 설치하세요.`로 중단된다.
작업자에게 개발용 Python 설치로 우회시키지 않는다. 아직 전체 ZIP 제작·설치·배포는 하지 않았다.
한글·공백 이동 경로의 패키지 모형에서 실제 SDK stdio 도구 7개, 환경변수 오염 격리,
백엔드 `.pth` 제외를 확인했으며 자세한 근거와 미완료 항목은 [운영 기록](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)에 있다.
패키지 모형과 별도로 개발 DB 사본에서 Claude MCP의 이미지 1건 생성 완료 및 기록을 확인했다.
새 Codex CLI도 7개 도구 로드·페어링·조회와 완료 결과 확인에 성공했고 추가 유료 생성은 하지 않았다.
이 결과가 전체 ZIP 설치나 기존 데스크톱 대화의 도구 자동 갱신을 뜻하지는 않는다. Claude와 명시된 개발 검증 범위의 마감에 합의했다.

업데이트할 때는 기존 MCP 프로세스를 종료하고 앱에서 등록 설정을 다시 복사해 경로·옵션을 대조한다.
클라이언트 재시작/MCP 재로드와 새 코드 페어링이 필요하다. 기존 대화의 도구 목록이 자동 갱신됐다고 가정하지 않는다.

## 개발 환경 설치

Python 3.11 이상을 사용한다. 앱의 기존 Python 환경과 의존성을 섞지 않도록 별도 환경을 만든다.
아래 명령은 저장소 루트의 PowerShell에서 실행한다. 이미 있는 환경은 덮어쓰지 않는다.

```powershell
$mcpEnvironment = Join-Path $env:LOCALAPPDATA 'MVHub-MCP\venv'
if (Test-Path -LiteralPath $mcpEnvironment) { throw '기존 환경을 먼저 확인하세요.' }
python -m venv $mcpEnvironment
if ($LASTEXITCODE -ne 0) { throw '환경 생성 실패' }
& "$mcpEnvironment\Scripts\python.exe" -m pip install -r tools\mcp_adapter\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'MCP 설치 실패' }
```

SDK 버전은 `mcp==2.3.0`으로 고정한다. 아래 설정 예시는 직접 설치한 Python과 개발 저장소의
절대 경로로 바꾼다. 이 문서를 읽거나 어댑터를 설치하는 것만으로 클라이언트 설정은 바뀌지 않는다.

## 개발 환경 클라이언트 설정 예

Claude의 MCP 서버 JSON 설정:

```json
{
  "mcpServers": {
    "mvhub": {
      "command": "C:\\Users\\YOUR_USER\\AppData\\Local\\MVHub-MCP\\venv\\Scripts\\python.exe",
      "args": ["D:\\YOUR_REPO\\tools\\mcp_adapter\\server.py", "--url", "http://127.0.0.1:8012"]
    }
  }
}
```

Codex의 MCP 서버 TOML 설정:

설정 필드는 [공식 설정 참고 문서](https://learn.chatgpt.com/docs/config-file/config-reference)를 따른다.

```toml
[mcp_servers.mvhub]
command = 'C:\Users\YOUR_USER\AppData\Local\MVHub-MCP\venv\Scripts\python.exe'
args = ['D:\YOUR_REPO\tools\mcp_adapter\server.py', '--url', 'http://127.0.0.1:8012']
tool_timeout_sec = 150
```

예시는 MCP 지원 코드로 실행한 격리 개발 서버 `8012`를 지정한다. 일반 dev에 MCP가 없으면 사용할 수 없다.
대상 허브에 MCP 기능이 구현된 버전이 실행 중이어야 한다. `--url`은 필수이며 생략하면 시작하지 않는다.
공유 서버 주소나 외부 주소는 받지 않는다.
원격 웹 클라이언트를 위한 공개 HTTP MCP 서버는 제공하지 않는다.

## 사용

1. `check_connection`으로 주소의 MCP 지원 여부를 확인한다. `available`은 기능 응답만 확인한 것이며 실제 계정·페어링·생성 준비를 뜻하지 않는다.
   `unavailable`이면 앱 실행·주소·응답을, `wrong_app`이면 MCP 지원 버전과 포트를 확인한다.
2. MV Hub 앱에서 사용할 계정·워크스페이스·씬을 열고 MCP 창을 연다.
3. 클라이언트에서 `connect`를 호출하고 받은 6자리 코드를 앱에 입력해 자료 조회·크레딧 사용을 포함한 실행을 허용한다.
4. `read_context(kind="scene")`로 현재 씬과 `context_id`를 읽는다. 프로젝트·생성물·모델도 조회할 수 있다.
5. 해당 `context_id`와 자료 ID를 넣어 `prepare_generation_plan`으로 계획을 준비한다.
6. 사용자가 명확히 생성을 요청했다면 `execute_generation_plan(plan_id=...)`을 호출한다. 실제 크레딧이 소모될 수 있다.
7. 시작 응답은 접수나 완료가 아니다. `get_plan`의 실행 오류·항목 상태·`generation_status`로 확인한다.

`request_execution`은 기존 호환용으로 앱 승인 화면만 연다. 이 도구를 호출하는 것만으로 생성되지는 않는다.
구버전 연결의 `can_execute`는 false다. 앱에서 연결을 해제하고 실행 허용으로 새로 연결해야 직접 실행할 수 있다.
불명확한 응답이나 실패는 자동 재제출하지 않는다. `execution=null`은 현재 앱의 관측값이 없다는 뜻이며 미실행을 보장하지 않는다.

연결이 새로 시작되면 다시 페어링해야 한다. 다른 활성 연결이 있으면 앱에서 연결 상태를 먼저 확인한다.
클라이언트 이름은 요청자가 주장한 표시값이며 실제 실행 모델을 증명하지 않는다.
런타임 인증 비밀값은 어댑터 메모리에만 두고 HTTP 헤더로 전달한다. 설정·도구 인자·도구 결과에 넣지 않는다.
페어링 코드는 사용자가 앱에 입력하기 위한 값이다. 작업 결과로 반환된 자료는 사용하는 AI 서비스에 전달될 수 있다.

## 범위와 제한

- 도구: `check_connection`, `connect`, `read_context`, `prepare_generation_plan`, `get_plan`, `request_execution`, `execute_generation_plan`.
- 계획: 항목 1~20개, 항목별 참고 자료 0~8개. 현재 버전은 `depends_on` 등 항목 간 의존성 입력을 받지 않는다.
- 조회: 1~50개. 요청 JSON 64 KiB, HTTP 응답 256 KiB 이하.
- HTTP 요청 제한 30초, 작업 결과 대기 최대 90초. 시간 초과 시 자동 재제출하지 않고 앱에서 처리 상태를 확인한다.
- 어댑터는 `http://127.0.0.1:PORT`, `http://[::1]:PORT`만 허용한다. 프록시·리디렉션·호스트 이름은 사용하지 않는다.
- 도구 목록은 페어링 전에 보이지만, 업무 자료 조회와 계획 작업은 앱 승인 전 허용하지 않는다.
- stdout은 MCP 통신 전용이다. 진단은 stderr를 사용한다.

## 이 PC의 재사용 설정 (2026-10-15)

Codex와 Claude Code 사용자 설정의 `mvhub`는 다음을 사용한다. 임시 시험용 8014에는 연결하지 않는다.

- Python: `C:\Users\FX-PC06\AppData\Local\MVHub-MCP\venv\Scripts\python.exe` (`mcp==2.3.0`).
- 어댑터: `C:\Users\FX-PC06\.codex\worktrees\mvhub-mcp\MV-hub-S-dev\tools\mcp_adapter\server.py`.
- 허브: `http://127.0.0.1:8016`. 최초 등록 당시에는 실행하지 않았으나 현재는 개발 DB 사본으로 격리 실행 중이다.
  사용자 승인 후 실제 계정·워크스페이스 연결과 Claude의 이미지 1건 생성·기록을 확인했다.
  검증 범위와 남은 조건은 [현행 상태](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)를 따른다.
- Codex `tool_timeout_sec=150`. 새 클라이언트 세션에서 도구 로드를 확인한다. 기존 대화에 자동 반영됐다고 가정하지 않는다.
- Claude Desktop·일반 ChatGPT 웹 커넥터 등록은 별도다. 이번 등록은 이 PC의 Codex·Claude Code다.
- 기존 Codex 대화에는 옛 6개 도구·schema가 남아 있었으나 새 CLI 세션에서는 7개 도구와 연결·완료 결과 조회를 확인했다.
  기존 데스크톱 대화까지 자동 갱신됐다고 가정하지 않는다. SDK 패키지 모형과 실제 CLI 검증 근거는 구분한다.

실제 등록 명령(기존 동명 등록이 없는 상태에서 실행):

```powershell
$mcpPython = "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe"
$mcpAdapter = 'C:\Users\FX-PC06\.codex\worktrees\mvhub-mcp\MV-hub-S-dev\tools\mcp_adapter\server.py'
# 이 PC에서 버전을 확인한 CODEX_CLI_PATH를 사용했다.
& $env:CODEX_CLI_PATH mcp add mvhub -- $mcpPython $mcpAdapter --url http://127.0.0.1:8016
claude.cmd mcp add --scope user --transport stdio mvhub -- $mcpPython $mcpAdapter --url http://127.0.0.1:8016
```

Codex 등록 명령 뒤 `%USERPROFILE%\.codex\config.toml`의 `[mcp_servers.mvhub]` 절에
`tool_timeout_sec = 150`을 추가한다. 위 등록 명령만으로는 이 값이 저장되지 않는다.
등록 해제는 `& $env:CODEX_CLI_PATH mcp remove mvhub`, `claude.cmd mcp remove --scope user mvhub`다.
등록은 미커밋 worktree를 참조한다. 이 폴더를 삭제·이동하면 연결이 깨진다. 릴리스 경로로 전환할 때 다시 등록한다.

같은 어댑터 세션과 앱 연결이 살아 있으면 후속 요청마다 코드를 입력하지 않는다.
새 LLM 세션에서 어댑터가 새로 실행될 때, 어댑터/허브 재시작, 계정·워크스페이스 변경, 앱 연결 임대 만료 시 다시 페어링한다.
동시에 한 클라이언트만 연결된다. Claude에서 Codex로 바꿀 때는 앱에서 기존 연결을 해제한다.

실제 앱 가동 방법과 사용 흐름은 [MCP 운영 문서](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)를 따른다.

## 격리 시험

```powershell
& "$mcpEnvironment\Scripts\python.exe" tools\mcp_adapter\test_server.py
```

시험은 임시 loopback HTTP 서버와 실제 SDK stdio 하위 프로세스를 연결한다.
실사용 DB·서버·힉스필드 생성 API에 접근하지 않는다. 도구 schema, 페어링 전 차단,
계획·승인 화면·직접 실행 요청 전달, 실행 권한 표시, 요청·응답 크기, 인증 비밀값 노출 방지, 프록시·리디렉션 차단을 확인한다.
