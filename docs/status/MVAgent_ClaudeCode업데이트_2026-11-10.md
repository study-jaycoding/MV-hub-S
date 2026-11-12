---
status: active
updated: 2026-11-12
---

# MV Agent — Claude Code 공식 설치 보장 · [업데이트] 단추 (2026-11-10)

owner: Claude · reviewer: Codex(설계 검토·독립 리뷰) · status: 완료(dev — v3 7판, 독립 리뷰 2차 통과 · 실제 설치 1회는 릴리스 PC 에서) · updated: 2026-11-12

> [!IMPORTANT]
> **11-12 설계 v3(2-v3 절)** — Jay "모두 구현하자. 설계부터 확정하고 바로 구현": [업데이트] 단추를 빼고 공식 자동 업데이트에 맡기며, 설치 보장만 2차 지적대로 고친다. 계약은 아래 블록(v3).
>
> 2차 설계 검토(v2, 5절) — Codex **수정 요청**(P1 6 · P2 3). Claude 합의 세션은 npm `claude.cmd` 가 지워져 시작하지 못함(아래). 같은 때 **Jay PC 는 공식 설치 2.1.322 로 바뀌고 npm 판은 지워졌다**(18:54 — 허브가 공식 설치본을 고르고 요금제 Ultra·최신 2.1.322 확인). 다음 판(v3) 범위를 Jay 에게 묻고 멈춤. 코드 0.

## 1. 요청과 사실

- Jay 11-10(차례대로): 서랍 아래에 "업데이트가 생기면 [업데이트]를 눌러 설치" → "MV Agent 는 최신 에이전트로 자동 업데이트되어야 한다" → "MV Hub 를 설치·업데이트할 때 공식 설치를 하게 하자".
- 실측(11-10):
  - 이 PC 허브가 쓰는 Claude Code = npm 전역 설치본 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` **2.1.296**(10-14 뒤 그대로 — `~/.claude.json` `autoUpdates: false`). 공식 설치본(`~\.local\bin\claude.exe`)은 없다(`~\.local\share\claude\versions` 에 5월 판 2.1.143·144 흔적만).
  - 허브 고르기(`agent_chat_process.find_claude`) = PATH 의 npm 셰임 옆 실제 exe · 공식 위치 — 둘이면 판이 높은 쪽, 같으면 공식.
  - 칸 모델은 별칭(`opus`·`fable`…)이라 실제 모델이 CLI 판을 따른다 — 2.1.296 의 fable = claude-fable-5-1, 2.1.321 = claude-fable-5-2. **CLI 를 최신으로 두면 모델도 자동으로 최신**이 된다.
  - Claude 데스크톱 앱 업데이트로는 허브의 Claude Code 가 안 바뀐다(앱은 `%APPDATA%\Claude\claude-code\<판>\` 을 따로 쓴다).
- 공식 문서(code.claude.com/docs/en/setup·troubleshoot-install, 하위 에이전트가 읽음): 공식 설치는 **백그라운드에서 스스로 업데이트**(시작할 때·실행 중 확인, 다음 시작에 적용) · `claude update` = 지금 바로 업데이트 · 데스크톱 앱과 CLI 는 나란히 써도 되고 설정(`~/.claude`)을 같이 쓴다 · npm → 공식 = 공식 설치 뒤 npm 판 지우기 권장(설치는 하나만).
- 공식 설치 스크립트 원문(11-10, `claude.ai/install.ps1` → 302 → `downloads.claude.ai/claude-code-releases/bootstrap.ps1`): `downloads.claude.ai` 에서 판·manifest·`claude.exe` 를 받아 **SHA-256 확인** 뒤 `claude.exe install latest` 실행 · 묻는 것 없음 · 관리자 불필요 · PATH·레지스트리는 스크립트가 안 건드림(`claude install` 안쪽은 미확인) · 실패면 종료 코드 1.
- MV Hub 설치·업데이트 흐름(11-10 코드 조사): 첫 설치(`release/MVHub_Install.bat`)·앱 안 업데이트(`release_update.py` → `update_release.bat` → 워커)·손 업데이트 모두 **사용자 계정(관리자 아님)**으로 돌고 끝에 `MV_agent.bat` → `run_agent_session.py` 로 허브를 다시 켠다. 공유 서버는 다른 길(`MV_server.bat`·SYSTEM 예약 작업·`update_git`). 실행기 `main()` 은 이미 `ensure_desktop_shortcut()`(1438행 — 표식·`.git` 이면 건너뜀·실패 삼킴)을 같은 자리에서 돈다.
- **앞 결정 변경(Jay 11-10)**: 「Claude Code 없는 PC = 설치 안내(B), 앱이 설치를 실행하지 않음」(옆 칸 설계) → **MV Hub 설치·업데이트 때 공식 설치를 실행**. 실패해도 MV Hub 설치는 계속, 공유 서버 제외.

## 2-v3. 설계 v3 (2026-11-12 — Jay "모두 구현하자. 설계부터 확정하고 바로 구현", 2차 검토 P1 6 반영)

범위 결정(추천안 — Jay 위임): **[업데이트] 단추를 빼고, 앱은 업데이트를 돌리지 않는다.** 공식 설치는 스스로 업데이트하는 방식이지만(공식 문서, 1절) 끌 수 있고 허브 `-p` 실행에서 실제로 도는지는 미확인이라, 앱이 '최신 유지'를 보장한다고 말하지 않는다(4판). 2차 지적 중 업데이트에서 나온 P1-2(배타)·P1-5(강제 중단 안전)·P1-6(업데이트 대상 고르기)이 범위에서 빠진다. 남는 일 = **설치 보장** 하나.

### 2-v3-1. 공식 설치 보장 — 실행기(`run_agent_session.py`) — **4판(11-12, Codex v3 검토 반영)**
- 자리: `main()` 에서 `_start_open_link_registration` 과 같은 방식의 배경 스레드. **승인된 부팅 뒤에만** 시작한다(v3 검토 P1-2): 업데이트 부팅(`MVHUB_ACTIVATION_CONTROL`)이면 `_update_boot_outcome(nonce)` 가 **committed** 일 때까지 기다리고(롤백·대체면 하지 않음), 그 밖은 `_boot_would_be_accepted()` 가 참일 때만. 앱 기동은 기다리지 않는다.
- 감독 = 살아 있는 실행기 안 스레드(실행기는 `run_guarded` 로 허브가 도는 내내 산다). 설치 프로세스는 **멈춘 채 생성 → 설치 전용 Job 배정 → 재개**(Job = 닫히면 모두 끔, 탈출 허용 없음, 핸들 상속 없음 — 지금 `run_guarded` 와 같은 방식). Job 배정 실패면 그 프로세스를 끄고 실패로 적는다.
- **중단·재시도**(v3 검토 P1-1): 표식 상태 = `started` → `ok` | `failed`. 실행기가 끝나거나 업데이트 워커가 실행기를 강제로 끄면 Job 이 닫혀 설치도 끝나고 표식은 `started` 로 남는다 → 다음 켜짐에 '중단됨'으로 보고 **바로 다시** 한다(24시간 간격은 `failed` 뒤에만). 부분 설치는 다음 판정(`--version`)이 '안 돎'으로 보고 다시 설치한다. 실제 공식 설치기가 중간에 끊겼을 때 어떤 상태로 남는지는 **미확인**(가짜 프로세스 시험으로는 증명하지 못함 — 남은 위험).
- 할 때(모두 참): Windows · **릴리스 설치**(`.git` 없음 + `open_link.py` 있음 + 설치 표식 `.install-activation.json` 있음) · **대화형 일반 사용자**(토큰에 INTERACTIVE(`S-1-5-4`) 그룹 · SYSTEM·LocalService·NetworkService 아님 · `TokenElevation` 이 상승 아님 — 조회가 하나라도 실패하면 하지 않음, v3 검토 P2-5) · 공유 서버 아님(`CONTENT_HUB_AUTH` != `1`) · 끄는 스위치 없음(`MVHUB_CLAUDE_INSTALL` != `0`) · **공식 Claude Code 가 제대로 돌지 않음** — 실행기 자체 판정 함수(허브의 `cli_version` 을 쓰지 않음, v3 검토 P2-6): `%USERPROFILE%\.local\bin\claude.exe --version` 을 정확한 경로로 · 20초 제한 · 출력 4KB 상한 · 종료 0 + `숫자.숫자.숫자` 면 '있음', 파일이 있어도 안 돌면 '고쳐야 함' · 표식이 `failed` 면 24시간 지남.
- **잠금**(v3 검토 P1-3): 사용자 프로필의 파일 잠금 `%LOCALAPPDATA%\MVHub\claude-install.lock`(배타 열기 — 같은 프로필을 쓰는 다른 Windows 세션·여러 실행기도 막힘). 잠금을 못 잡으면 이번엔 하지 않는다. 잡은 뒤 위 조건을 **다시** 보고, 표식 `started` 를 먼저 쓴 뒤 설치한다(표식 쓰기 실패면 하지 않음).
- 하는 일: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; irm https://claude.ai/install.ps1 | iex"`(공식 문서 명령 + 5판 보탬) · 작업 폴더 `%LOCALAPPDATA%\MVHub` · 창 없음 · 입출력은 버림(로그 파일 없음 — 원문을 남기지 않는다, v3 검토 P2-7) · 15분 넘으면 Job 을 닫아 끔.
- 결과: 끝난 뒤 같은 판정 함수 — 종료 0 + 판이면 `ok(판)`, 아니면 `failed(종료 코드 | timeout | job | start | version_check)`. 표식 `%LOCALAPPDATA%\MVHub\claude-install.json` 에 상태·시각·종료 코드·판·까닭만. 실패해도 앱 기동은 그대로이고, 연결 안내가 설치 중·실패·건너뜀을 보인다(2-v3-1b).
- npm 설치본은 앱이 바꾸지 않는다. 허브 고르기(판이 높은 쪽, 같으면 공식)도 그대로 — **공식으로 모인다고 보장하지 않는다**(npm 이 더 높으면 npm 을 쓴다, v3 검토 P1-4).
- 원격 스크립트 신뢰(P2): HTTPS 와 공식 배포처(`claude.ai` → `downloads.claude.ai`)에 두는 결정이다. 스크립트 안의 SHA-256 확인은 그 스크립트가 받는 파일에 대한 것이다.

- **5판 보탬(Claude 합의 1차)**: `powershell.exe` 는 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 절대 경로, 작업 폴더 `%LOCALAPPDATA%\MVHub`(설치 폴더를 붙잡지 않게), 명령 앞에 `$ProgressPreference='SilentlyContinue';`(숨은 진행 막대가 느리게 함 — 프로젝트 실측 63.5초 → 9.6초). 관리자 판정은 **상승한 토큰(`TokenElevation.TokenIsElevated`)이면 뺀다**(7판 — Codex 5판 검토 P1: `TokenElevationType=Full` 만 빼면 UAC 를 끈 관리자에게 원격 설치 스크립트가 관리자 권한으로 돈다). 대신 UAC 를 끈 관리자·내장 Administrator 가 '왜 안 깔렸는지' 모르는 일이 없게(Claude 합의 1차) 건너뛴 까닭을 표식 `last_skip{reason}`(elevated·not_interactive·token_unknown 등)에 남기고 연결 안내가 그 까닭과 손 설치 안내를 보인다.

### 2-v3-1b. 허브·연결 안내 — 설치 중·실패를 보인다(5판, Claude 합의 1차 보통 1)
- 허브가 같은 사용자 프로필의 표식 `%LOCALAPPDATA%\MVHub\claude-install.json` 을 **읽기만** 해서 Claude 상태 응답(`/api/agent-chat/claude` 와 엔진 목록의 Claude)에 `install: running | failed{at} | skipped{reason} | null` 을 더한다. running = 표식이 `started` 이고 시작한 지 20분 안(설치 시한 15분 + 여유 — 실행기가 죽어 `started` 로 남아도 20분 뒤엔 running 아님). 허브는 실행기 코드를 가져다 쓰지 않는다(CODE_MAP §5) — 경로·상태 이름은 두 곳에 두고 시험으로 맞춘다.
- **설치 중엔 허브가 공식 `claude.exe` 만 후보에서 뺀다**(6판, Claude 합의 2차): 고르기 한 곳(`agent_chat_process._claude_candidates`)에서 공식 위치를 빼면 상태 판정·차례 시작·로그인 창이 모두 따른다. npm 등 다른 후보가 있으면 평소대로 쓴다(npm 으로 잘 쓰던 PC 가 설치 15~20분 동안 막히지 않게). 다른 후보가 없을 때만 `not_installed` + `install=running`. 연결 안내가 2초마다 다시 보는 `--version` 이 공식 파일 교체와 부딪치지 않게 하려는 것이다(충돌 자체는 추정).
- 표식의 건너뜀은 따로 칸 `last_skip{reason, at}` 에 두고 `started`·`ok`·`failed` 상태와 시각은 건드리지 않는다(같은 프로필의 개발본 건너뜀이 릴리스 기록을 덮지 않게). 건너뜀도 공식 판이 안 돌 때만, **잠금을 잡은 실행기만** 쓴다(잠금을 못 잡은 실행기는 표식을 아예 쓰지 않는다 — Codex 5판 P1). 설치 실패·건너뜀 한 줄은 연결 안내의 `unknown`(공식 파일은 있으나 안 돎) 화면에도 보인다.
- 후보 빼기는 `_claude_candidates` 가 부를 때마다 표식을 읽어 정하고, 허브의 엔진 상태 캐시도 설치 중 표식을 보면 쓰지 않는다 — 후보 비교용 `--version`(후보가 둘일 때)까지 포함해 설치 중 공식 exe 실행 0회(Codex 5판 P1, 시험으로 센다). 표식 확인과 실행 사이 아주 짧은 틈은 남는다(그 사이 시작한 설치는 공식 파일을 다 바꾸기 전이라 판 확인이 실패하면 다음 확인에 맡긴다 — 남은 위험).
- **설치 중 화면 자동 갱신**(Codex 5판 P2): 연결 안내가 `install=running` 을 받으면 3초마다 Claude 상태를 다시 묻고(로그인 창 기다림과 같은 반복 조회 장치), running 이 끝나면 멈춘다. 칸을 닫으면 멈춘다. 설치가 끝나 `ready`·`not_logged_in` 이 되면 화면이 저절로 그 단계로 넘어간다.
- 연결 안내(`AgentConnect.tsx`, `not_installed` 화면): 설치 중이면 "MV Hub 가 Claude Code 를 설치하는 중이에요 · 끝나면 저절로 이어져요"(손 설치 명령은 접어 둠 — 겹쳐 설치하지 않게) · 실패면 "자동 설치가 안 됐어요" 아래에 지금의 손 설치 안내 · 건너뜀이면 지금 안내 그대로 + 까닭 한 줄. 머리말의 "앱은 설치를 실행하지 않는다"를 고친다.

### 2-v3-2. 화면 — 서랍 아래 줄(확인된 사실만)
- 지금의 `v<판>` 과 라임 글자(npm 최신 판보다 낮음)는 그대로. 허브가 고른 실행 파일(판과 **같은 파일**로 계산)이 공식 설치본이면 "공식 설치", npm 전역 설치본이면 "npm 설치", 그 밖의 PATH 위 `claude.exe` 면 표시 없음(`other`) — 회색 작은 글로 **설치 방식만** 보인다. '자동 업데이트'·'곧 공식으로 바뀜' 같은 보장 문구는 쓰지 않는다(공식 설치도 자동 업데이트를 끌 수 있고, 허브의 `-p` 실행에서 업데이트가 도는지는 미확인 — v3 검토 P1-4). [업데이트] 단추는 만들지 않는다.

### 2-v3-3. 구현(11-12)
- 실행기 `run_agent_session.py` — `ensure_claude_official()`(자격 → 파일 잠금 → 판정 → 건너뜀 기록 또는 started → 설치 → 결과) · `_claude_version`(정확한 경로, 읽는 동안 4KB 상한·20초) · `_claude_token_problem`(TokenUser·TokenElevation·INTERACTIVE 소속, 실패면 token_unknown) · `_claude_install_lock`(`msvcrt` 바이트 잠금 — 다른 프로세스도 막힘을 시험으로 확인) · `_run_claude_installer`(멈춘 채 생성→Job(닫히면 모두 끔만)→재개, 끝나면 Job 을 끄고 0개 확인 뒤 돌려줌) · `_start_claude_install`(승인된 부팅·committed 뒤 배경 스레드) · `main()` 이 링크 등록 다음에 부름.
- 허브 `agent_chat_process.py` — `claude_install()`(표식 읽기, running 20분·건너뜀은 설치 상태보다 새로울 때만·모르는 까닭은 버림) · `_claude_candidates` 가 설치 중엔 공식 파일만 실제 경로 비교로 뺌 · `install_method()`. `services/agent_chat.py` 엔진 캐시 = 설치 중엔 안 쓰고 표식이 바뀌면 버림, Claude 줄에 `install`·`method`. 라우터 `/claude` 에 `install`, `/claude/version` 에 `method`.
- 화면 — `AgentConnect` 설치 중(기다림·손 설치 접음)·실패·건너뜀(까닭 한 줄)·unknown 에도 그 줄 · `useAgentChat` 설치 중 3초 다시 보기(로그인 창 기다림과 따로, 칸을 닫으면 멈춤) · 서랍 아래 `v<판>` 옆 회색 '공식 설치'·'npm 설치'.
- 이 PC 확인(11-12, 실제 설치는 안 돌림): 토큰 판정 = 대화형 일반 사용자(건너뜀 없음) · 공식 판 읽기 2.1.322 · dev 폴더는 `.git` 이라 대상 아님.
- 독립 리뷰 1차(Codex 새 세션, gpt-6.1-sol high, 무도구, 지문 `42b276b3…`) — **수정 요청** P1 1·P2 4 → 고침: ① Job 종료 확인이 실패해도 잠금을 놓음 → 0개를 확인할 때까지 끄고 기다림(`_hold_until_empty`, 실행기가 끝나면 핸들이 닫혀 커널이 끔) · 배정 실패한 멈춘 프로세스도 끝남 확인(`_end_process`) ② 잠금 안에서 자격(릴리스·서버·스위치)도 다시 ③ 엔진 캐시 비교를 보이는 값이 아니라 표식 원본 + 보이는 상태로(성공 ok·20분 만료도 바뀜) ④ unknown 화면의 실패·건너뜀 줄 아래에 손 설치 안내 ⑤ 시험 — 토큰 판정을 순수 함수로 나눠 경우별 시험 + 이 PC 실제 토큰을 `IsUserAnAdmin` 과 대조(늘 token_unknown 이면 잡힘) · 실행기를 강제로 끄면 손자까지 끝나고 다음 켜짐에 바로 다시 · 종료 확인 실패 3번 뒤에야 돌아감 · 캐시(None→ok·running 만료) · 설치 중→실패 전환 화면.
- 독립 리뷰 2차(같은 리뷰 세션, 지문 `0eed8539…`) — **통과**(추가 지적 없음, 정적 리뷰). 커밋의 `background_jobs.md` 에는 다른 세션 코드(`resolve_panel.py`)의 줄을 넣지 않는다.
- 남은 위험(그대로): 실제 공식 설치기가 Job 종료로 끊겼을 때 남는 상태 · 표식 확인과 공식 exe 실행 사이 아주 짧은 틈 · 실제 설치 1회는 릴리스 PC 에서 처음 확인된다(가짜 자식 프로세스 시험은 그 증거가 아님).

## 2. 설계 v2 (v3 로 대체 — 기록)

원칙: **npm 설치본은 앱이 바꾸지 않는다** — 1차 검토(4절)의 위험 대부분이 npm 제자리 교체(Windows 파일 잠금·설치 위치 판정·되돌리기·허브 종료 복구)에서 나왔다. 모든 PC 를 공식 설치본으로 모으고, 업데이트도 공식 업데이트만 쓴다.

### 2-1. 공식 설치 보장 — MV Hub 실행기(`run_agent_session.py`)
- 자리: `main()` 의 `ensure_desktop_shortcut()` 다음, `run_guarded` 전 — 첫 설치·업데이트 모두 실행기로 끝나므로 둘 다 닿는다. **배경 스레드로 시작만 하고 넘어간다**(앱 기동을 막지 않음).
- 할 때(모두 참): Windows · 릴리스 설치(설치 폴더에 `.git` 없음 — 바로가기와 같은 판정) · 일반 사용자(현재 토큰 SID 가 SYSTEM `S-1-5-18` 아님, `USERPROFILE` 있음) · 공유 서버 아님(`CONTENT_HUB_AUTH` != `1`) · 끄는 스위치 없음(`MVHUB_CLAUDE_INSTALL` != `0`) · `%USERPROFILE%\.local\bin\claude.exe` 없음 · 표식 `%LOCALAPPDATA%\MVHub\claude-install.json` 의 마지막 시도가 24시간보다 오래됨(실패 반복 막기 — 표식을 못 읽으면 시도).
- 하는 일: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"`(공식 문서 명령 그대로) · 창 없음 · **실행기 Job 밖**(`CREATE_BREAKAWAY_FROM_JOB` — MV Hub 창을 닫아도 설치가 반쯤 끊기지 않게, 기존 797·1130행 방식) 이면서 **설치 전용 Job**(자식까지 묶음)에 담아 15분 넘으면 Job 을 닫아 끈다 · 출력은 `%LOCALAPPDATA%\MVHub\claude-install.log` 에 덮어쓰기(뒤 64KB만).
- 결과: 끝난 뒤 `~\.local\bin\claude.exe` 가 있으면 성공, 아니면 실패 — 표식에 시각·결과·종료 코드만(경로·출력 원문 없음). 실패해도 앱은 그대로(MV Agent 는 지금의 연결 안내를 보인다).
- npm 설치본은 지우지 않는다 — 허브가 판이 높은 쪽(같으면 공식)을 고르므로 공식 설치가 끝나면 그쪽으로 간다. 허브의 엔진 상태 캐시(60초) 뒤 저절로 새 판을 본다(재시작 불필요). 터미널 PATH 순서는 사용자 몫.

### 2-2. [업데이트] 단추 — 공식 설치본일 때만
- `GET /api/agent-chat/claude/version` 에 `method`(`official` = 허브가 고른 exe 가 `official_claude()` 와 같은 파일 · `npm` · `none`) · `can_update`(official · 새 판 · 업데이트 안 하는 중) · `job`(`idle|running|done|failed` + 판·까닭) 을 더한다.
- 서랍 아래 줄: `v<지금>` 옆에 `can_update` 일 때 **[업데이트]**. npm 이면 단추 없이 지금처럼 라임 글자 + 알림 글(다음 MV Hub 켜짐에 공식 설치 — 2-1). `job` 이 running·failed 면 `can_update` 와 상관없이 그 상태를 보인다.
- `POST /api/agent-chat/claude/update`(칸 표): 허브 안 한 번에 하나, 바로 `job` 을 돌려주고 일은 스레드:
  1. `ClaudeLock("update")` — 차례·로그인 창 만들기와 같은 뮤텍스. `_valid_owner` 가 `update` 를 받게 하고, 차례처럼 **회수 표식**을 연다(놓지 못하고 죽으면 다음 획득이 막힘). 진행 중 차례·로그인 창이면 거절("Claude 가 일하는 중이에요"). `would_block` 은 주인 기록 kind 가 `update` 면 "Claude Code 업데이트 중이에요"(읽지 못하면 지금 문구).
  2. 업데이트 중에는 **허브가 claude.exe 를 띄우는 길이 모두 띄우지 않는다**: 엔진 목록·`/claude` 상태는 마지막 값을 그대로(+ `updating`), 차례 시작은 `engine_problem` **보다 먼저** 409, 판 확인은 캐시만.
  3. 실행: `<공식 claude.exe> update` 를 `JobProcess` 로(창 없음·stdin 닫음·출력 읽어 버림·10분 제한). 공식 설치는 실행 중에도 백그라운드 업데이트가 도는 방식이라(문서) 다른 곳에 claude 가 떠 있어도 막지 않는다.
  4. 끝: Job 0개 확인 뒤 잠금 놓기(못 하면 놓지 않음 — 차례와 같은 규칙) · 엔진·최신 판 캐시 비움 · 공식 exe 로 판 다시 읽기 → `done(새 판)` / `failed(종료 코드·시간 초과)`.
- 허브가 도중에 꺼지면 Job 이 `claude update` 를 끈다 — 공식 업데이터가 새 판을 따로 받은 뒤 바꾸는지는 **미확인(격리 실측 항목)**. 다음 켜짐에 판 확인이 그대로 보여 준다.
- 화면: [업데이트] → `업데이트하는 중`(잠금) → `v<새 판>` / `업데이트하지 못했어요` + [다시] · 대화 중엔 잠금 · 서랍을 닫아도 허브에서 계속(다시 열면 이어 보임).

### 2-3. 1차 검토 지적 처리
- ① 허브가 업데이트 중 exe 를 띄움 → 2-2 의 2. ② 잠금·주인 기록·회수 표식 → 2-2 의 1·4. ③ npm 위치 판정 · ④ 실행 중 exe·되돌리기 · ⑤ 허브 종료 복구 → npm 을 앱이 바꾸지 않아 범위에서 빠짐(공식 업데이터의 일 — ⑤의 공식 쪽 동작은 실측). ⑥ 엄격한 판 모양(숫자.숫자.숫자) · job 은 `can_update` 와 따로.

## 3. 시험 — v2 판(기록, v3 4판 시험은 계약 블록의 criteria 가 정본)

- 실행기: 조건마다 설치를 안 부름(`.git`·SYSTEM·서버·스위치 0·이미 있음·24시간 안 시도·Windows 아님) · 부를 때 명령·창 없음·Job 밖 플래그 · 성공/실패 표식(경로·출력 없음) · 15분 시간 초과로 끔 · 배경이라 `main()` 이 기다리지 않음.
- 허브: method 판정(공식·npm·없음) · `can_update` · 업데이트 성공(명령 = `<공식 exe> update`)·실패·시간 초과 · 동시 두 번(하나만) · **업데이트 중 exe 를 띄우는 길 0**(엔진 목록·상태·차례 시작) · 주인 기록 `update` 와 회수 표식(놓지 못하면 다음 획득을 막음) · 진행 중 차례·로그인 창이면 거절 · `would_block` 문구.
- 화면: 공식 + 새 판일 때만 [업데이트] · 진행·성공·실패 · 대화 중 잠금 · npm 일 때 알림 글.
- 격리 실측(진짜 설치 없이): 실행기 배경 시작이 기동 시간을 늘리지 않음. 실제 설치·업데이트 1회는 Jay PC 에서 Jay 승인 뒤.

## 4. 1차 설계 검토(v1 — npm 을 앱이 교체하는 안, 계약 SHA 50333a1d…)

- Codex(설계 세션 `01a1bf3c` 이어 받기, 요청 모델 gpt-6.1-sol·high, 무도구·읽기 전용) — **수정 요청**, P1 6 · P2 3. Claude(읽기 전용 새 세션 `d77d3d43`, claude-opus-5-5) — **수정 요청**, 중대 3 · 보통 2 · 작음 2.
- 겹친 중대 지적: ① 업데이트 중에도 허브가 같은 claude.exe 를 띄운다(상태 조회·차례 시작의 `engine_problem` 이 `would_block` 보다 먼저 — `routers/agent_chat.py:217`) ② `ClaudeLock` 은 자격 폴더 기준 `Local\` 뮤텍스이고 `_valid_owner` 가 `update` 를 모름(173줄)·업데이트엔 회수 표식 없음 ③ npm 전역 설치 위치를 `which("npm")` 폴더로 판정하면 틀림(`npm prefix -g`) ④ 명령줄 글자 대신 ExecutablePath · 확인~설치 사이 틈 → 되돌릴 수 있는 교체 ⑤ 허브가 설치 도중 꺼질 때 복구 계약 없음 ⑥ (P2) 판 모양·상태 표시·touched_paths.
- 원문: 세션 스크래치 `agentpanel/codex_update_design_reply.md` · `claude_update_agree.json`. → v2 에서 2-3 처럼 처리.

## 5. 2차 설계 검토(v2, 계약 SHA b0b17b6c…)

- Codex(같은 설계 세션 `01a1bf3c` 이어 받기, 요청 모델 gpt-6.1-sol·high, 무도구) — **수정 요청**:
  1. [P1] 배경 스레드는 실행기와 함께 죽는다 — Job 을 실행기가 쥐면 닫힐 때 설치가 죽고, 아니면 시간 제한·결과 기록을 맡을 주체가 없다 → **독립 감독 프로세스**가 설치 Job·시한·로그·표식을 쥔다(멈춘 채 생성→Job 배정→재개).
  2. [P1] 설치 중복·업데이트와의 배타 부족(잠금이 자격 폴더·세션별) → 공식 설치 대상 기준 **유지보수 잠금**을 설치·업데이트가 함께 쓰고, 잠금 안에서 조건 재확인·시작 표식 먼저.
  3. [P1] `.git` 없음 ≠ 릴리스, SYSTEM 아님 ≠ 일반 사용자(서비스 계정·상승 관리자) → 릴리스 표식·허용된 실행 경로·실제 사용자 토큰으로 판정, 상승 실행 제외.
  4. [P1] 파일이 있다고 성공으로 보면 깨진 설치가 굳는다 → 정확한 경로로 실행해 종료 코드·판을 확인, 있는데 안 도는 경우는 복구 필요 상태.
  5. [P1] 공식 업데이터를 강제로 끊어도 안전한지 미확인 → 실사용 전 공식 근거 또는 격리 중단·재시작 검증, 미완료 기록·손상 감지·복구 안내.
  6. [P1] 공식 설치가 npm 보다 옛 판이면 허브가 npm 을 고르고 단추도 숨는다 → 사용 대상과 업데이트 대상 고르기를 나눈다.
  7. [P2] 원격 스크립트 신뢰 범위·로그 정책 · [P2] 새 판 판정 출처(npm latest)와 공식 업데이트 채널 일치 · [P2] `agent_chat_process.py` 를 touched_paths 에, 경계 시험(여러 실행기·표식 쓰기 실패·설치 중 실행기 종료) 추가.
- Claude(세션 `d77d3d43` 이어 받기) — **실행 실패**: `%APPDATA%\npm\claude.cmd` 가 없어졌다(Jay 가 공식 설치로 옮기며 npm 판을 지움). 다음 합의는 공식 설치본 `~\.local\bin\claude.exe` 로 띄운다.
- 원문: 세션 스크래치 `agentpanel/codex_update_design2_reply.md`.

## 6. v3 설계 검토(11-12)

- Codex 1차(새 세션 `01a1ce80-977e-7581-ab0a-2cce37505a22`, gpt-6.1-sol high, 읽기 전용, v3 계약 `1ec821ee…`) — **수정 요청** P1 4·P2 3: 업데이트 워커의 강제 종료·24시간 표식으로 재시도 안 됨 · 미완료 업데이트 부팅에서 원격 설치가 먼저 · `Local\` 은 세션 범위 · 공식 설치 = 자동 업데이트·공식 전환 보장 아님 · 대화형 토큰·TokenElevation · 기존 판 함수는 종료 코드를 안 봄 · 시험·로그 정리. → 4판(2-v3-1·2).
- Codex 2차(같은 세션, 4판 계약 `23c07c71…`) — **동의**. 구현 때 지킬 P2: 파일 잠금은 설치 자식·손자 종료 확인과 결과 판정까지 쥔다 · 배정 실패·시간 초과·실행기 강제 종료 뒤 바로 다시 켜기 시험 · `run_guarded` 의 탈출 허용 플래그를 복사하지 않는다 · 판정 출력 4KB 는 **읽는 동안의 상한**, 시간 초과면 끄고 회수 · 서랍의 판과 설치 방식은 **같은 실행 파일**로 계산(공식 경로가 아니면 무조건 npm 으로 적지 않기) · 공식 설치기의 실제 중단·복구는 미검증(가짜 Job 시험을 그 증거로 적지 않는다).
- Claude 합의 1차(읽기 전용 새 세션 `cb397624-ec5d-48c4-b6a2-5b0106dc34d9`, claude-opus-5-5, 계약 `23c07c71…`) — **수정 요청** 보통 1·작음 4: 설치 중·실패가 화면에 안 보이고 손 설치를 권함 · UAC 꺼진 관리자 판정 · powershell 절대 경로·작업 폴더 · 진행 막대 · 설치 방식 '기타'. → 5판(2-v3-1b).
- Claude 합의 2차(같은 세션, 계약 `20bde725…`) — **수정 요청** 보통 1·작음 2: 설치 중 모든 claude.exe 를 막으면 npm 으로 쓰던 PC 가 막힘 → 공식 후보만 뺌(`agent_chat_process._claude_candidates`, 담당 목록에) · 건너뜀은 `last_skip` 따로 · `unknown` 화면에도 실패 줄. → 6판.
- Codex 3차(같은 세션 `01a1ce80`, 5판 계약 `20bde725…`) — **수정 요청** P1 3·P2 1: skipped 가 started·failed 를 지움(잠금 못 잡은 실행기는 안 씀) · 상태 함수만 막으면 find_claude 의 후보 비교가 이미 공식 exe 를 띄움 · `TokenElevationType=Full` 만 빼면 UAC 꺼진 관리자에게 관리자 권한 설치 · 설치 중 반복 조회 흐름. → 6판(공식 후보만 빼기·last_skip)과 7판(상승 토큰이면 빼고 까닭을 화면에 — 두 검토가 엇갈린 관리자 판정은 더 안전한 쪽, 반복 조회·캐시 무시·`useAgentChat.ts`·`services/agent_chat.py` 담당 목록에).
- 구현 중(11-12): 자동 목록(`gen_inventory`)이 실행기의 새 배경 스레드(설치 확인·판 읽기)를 동시성 시작점으로 잡아 `docs/inventory/background_jobs.md` 가 바뀜 → 담당 목록에 더하고 goal 의 '4판'을 '7판'으로(계약 SHA 바뀜 → 양측 재확인). 표식 읽기는 후보 빼기와 같은 곳인 `agent_chat_process.py`(허브 `agent_chat_claude.py` 가 이미 이 모듈을 가져다 쓴다 — 순환 import 없음)에 둔다.
- 7판(계약 `539a0d43…`) — **Codex 4차 동의 · Claude 합의 3차 동의**. 구현 때 지킬 점: PATH 에서 먼저 찾은 후보가 공식 파일이어도 실제 경로로 비교해 뺀다(시험: 공식이 PATH 에도 있는 고치기 설치 중 공식 실행 0회) · 엔진 캐시는 설치 시작·종료·재시도 전환 모두에서 무효화 · `last_skip` 은 설치 상태 시각보다 새로울 때만 보인다 · 설치 대기는 로그인 창 대기(10분·login_window 조건)와 따로 — 완료·실패·20분 만료·칸 닫힘 시험 · 본문 38~39행 옛 문구·goal 의 '4판'은 구현 기록 때 정리 · 표식 확인~실행 사이 틈과 실제 설치기 중단 복구는 남은 위험(가짜 시험의 '공식 실행 0회'를 그 증거로 적지 않는다).

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-claude-update-2026-11-10",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "4e253e69-1c8b-4f92-80da-34b2f50ce3c0"},
  "risk": {"level": "major", "reason": "MV Hub 실행기가 팀 PC 마다 Claude Code 공식 설치(원격 스크립트)를 실행한다 — 설치 흐름 변경, 실패 시 MV Agent 를 못 쓰게 될 수 있음"},
  "goal": "MV Hub 를 켤 때(승인된 부팅·업데이트 확정 뒤) 공식 Claude Code 가 없거나 안 돌면 살아 있는 실행기가 감독하는 설치 전용 Job 으로 공식 설치를 하고(대화형 일반 사용자·파일 잠금·실행 확인·중단 뒤 다시), 업데이트 단추 없이 서랍에는 설치 방식만 보인다(Jay 11-10·11-12, 설계 v3 7판).",
  "touched_paths": ["run_agent_session.py", "backend/tests/test_claude_official_install.py", "backend/app/services/agent_chat_claude.py", "backend/app/services/agent_chat_process.py", "backend/app/services/agent_chat.py", "backend/app/routers/agent_chat.py", "backend/tests/test_agent_chat_connect.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/lib/useAgentChat.ts", "frontend/src/components/agent-chat/AgentPanel.tsx", "frontend/src/components/agent-chat/AgentConnect.tsx", "frontend/src/styles/agent-chat.css", "frontend/tests/agentChatPanel.test.tsx", "frontend/tests/agentChatConnect.test.tsx", "docs/inventory/env_vars.md", "docs/inventory/background_jobs.md"],
  "criteria": [
    {"id": "launcher", "success": "실행기 공식 설치 시험(진짜 설치·네트워크 없이 가짜 자식 프로세스로 — 조건별 안 부름(개발본·대화형 아님·SYSTEM·상승·조회 실패·서버·스위치·잘 도는 설치·failed 24시간) · 안 도는 설치·중단된 started 는 다시 · 업데이트 부팅은 committed 뒤에만, 롤백이면 안 함 · 파일 잠금 겹치면 건너뜀(표식 안 씀) · 두 실행기가 겹쳐도 started·failed 시각 보존 · last_skip 은 따로 · 잠금 안 재확인·started 먼저·표식 쓰기 실패면 안 함 · 멈춘 채 생성→Job→재개·Job 배정 실패 · Job 닫으면 손자까지 끝남 · 15분 시간 초과 · 결과는 판정 함수(종료 0·엄격한 판·20초·4KB) · 표식에 원문 없음) + 바로가기·실행기 기존 시험 통과", "failure": "시험 실패 또는 시험이 진짜 설치를 부름", "required": true, "verification": ["4fe1d079c6834dac81c8ad32fed68a7c", "27fd996c7ba442bca9eb0ab522b12142"]},
    {"id": "backend", "success": "판 확인에 method(공식·npm·기타·없음, 판과 같은 파일) + Claude 상태의 install(running·failed·skipped·없음, 20분 경계) + 설치 중엔 공식 claude.exe 만 후보에서 뺌(npm 후보는 그대로 씀, 후보 비교 --version 포함 공식 실행 0회, 캐시 무시) + 칸 연결 시험 통과", "failure": "시험 실패", "required": true, "verification": ["aebc35167b94414eb9704bd6d55923c0", "e6b17bedc24244ab9ee2e37af9ce9ee9"]},
    {"id": "frontend", "success": "서랍 아래 줄(설치 방식만) + 연결 안내(설치 중·실패·건너뜀, unknown 화면 포함) + 설치 중 3초 반복 조회·끝나면 저절로 다음 단계·칸 닫으면 멈춤 + MV Agent 칸·연결 시험 + 빌드 + 경계 검사 통과", "failure": "시험·빌드 실패", "required": true, "verification": ["68ca2c8629d946828c5aaf60d8d23753", "5d18d49e0c0b4cab8ea3fbc4ba5ebf3c", "cbbcf42731744898aade0b4dac8e5c96"]},
    {"id": "inventory", "success": "gen_inventory --check · check_code_map 통과", "failure": "목록 낡음", "required": true, "verification": ["fea23ba381194a4996af8d394420b967", "4087a1b0f1f54f8e91408863b16bcffa"]}
  ],
  "decisions": [
    {"choice": "승인된 부팅(업데이트면 committed) 뒤 살아 있는 실행기가 감독하는 설치 전용 Job(멈춘 채 생성→배정→재개, 탈출·상속 없음)으로 공식 설치, 중단된 started 는 다음 켜짐에 바로 다시·failed 만 24시간 간격", "why": "Jay 11-10 '설치·업데이트 때 공식 설치' — 실행기는 허브가 도는 내내 살고, 롤백될 업데이트에서 원격 설치를 먼저 돌리지 않으며, 강제 종료로 끊겨도 다음 켜짐에 고친다(v3 검토 P1-1·2)", "alternative": "따로 감독 프로세스 / 설치·업데이트 스크립트에 단계 추가", "revisit": "실제 공식 설치기가 끊긴 뒤 못 고치는 상태가 보이면"},
    {"choice": "[업데이트] 단추 없음, 서랍에는 설치 방식(공식·npm)만 — 자동 업데이트·공식 전환을 보장한다고 쓰지 않는다", "why": "공식 설치도 자동 업데이트를 끌 수 있고 허브 -p 실행에서 업데이트가 도는지 미확인, npm 이 더 높으면 npm 을 쓴다(v3 검토 P1-4)", "alternative": "공식 claude update 단추(v2) / '자동 업데이트' 표시", "revisit": "허브 실행에서 자동 업데이트가 도는 것이 확인되면"},
    {"choice": "설치 판정 = 실행기 자체 함수로 정확한 경로의 --version(종료 0·엄격한 판·20초·4KB), 파일만 있고 안 돌면 고침", "why": "깨진 설치가 성공으로 굳지 않게, 종료 코드를 안 보는 허브 함수에 기대지 않게(v2 P1-4·v3 P2-6)", "alternative": "파일 있음 = 성공", "revisit": "없음"},
    {"choice": "대화형 일반 사용자(INTERACTIVE 그룹·서비스 계정 아님·상승 토큰(TokenIsElevated) 아님, 조회 실패면 안 함 — 건너뛴 까닭은 표식 last_skip 에 남기고 연결 안내가 보임)·릴리스·공유 서버 아님·스위치 0 아님에서만, 사용자 프로필 파일 잠금 하나(못 잡으면 표식도 안 씀)", "why": "원격 설치 스크립트를 관리자 권한으로 돌리지 않고(Codex 5판 P1), 같은 프로필의 다른 Windows 세션도 겹쳐 설치하지 않으며, 건너뛴 PC 도 까닭을 알게(Claude 합의 1차)", "alternative": "TokenElevationType=Full 만 빼기 · Local\\ 뮤텍스·IsUserAnAdmin", "revisit": "UAC 를 끈 관리자 PC 가 팀에 많아 손 설치가 잦으면"},
    {"choice": "허브는 설치 표식을 읽기만 해 Claude 상태에 install 을 싣고, 설치 중엔 공식 claude.exe 만 후보에서 빼며(npm 은 그대로), 연결 안내가 설치 중·실패·건너뜀을 보인다(설치 중엔 손 설치 명령을 접음)", "why": "팀원이 자동 설치 중에 손 설치를 겹쳐 돌리거나 실패를 모르는 일을 막고, npm 으로 잘 쓰던 PC 를 설치 동안 막지 않는다(Claude 합의 1·2차)", "alternative": "화면 표시 없음 / 설치 중 모든 claude.exe 막기", "revisit": "없음"},
    {"choice": "npm 설치본은 앱이 바꾸지 않고 허브 고르기도 그대로, 설치 출력은 남기지 않는다(상태·종료 코드·판만)", "why": "npm 제자리 교체의 위험(v1 검토)을 앱이 떠안지 않고, 원문 로그의 크기·내용 문제를 없앤다(v3 P2-7)", "alternative": "npm 업데이트를 앱이 실행(v1) / 출력 로그", "revisit": "공식 설치 실패 원인을 알아야 할 일이 잦으면"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": [
    {"host": "claude", "session": "cb397624-ec5d-48c4-b6a2-5b0106dc34d9", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode/cb397624-ec5d-48c4-b6a2-5b0106dc34d9.jsonl"},
    {"host": "codex", "session": "01a1ce80-977e-7581-ab0a-2cce37505a22", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/12/rollout-2026-11-12T15-44-57-01a1ce80-977e-7581-ab0a-2cce37505a22.jsonl"}
  ], "review": {"host": "codex", "session": "01a1cef4-d3ae-7260-86f3-bc21f17e4809", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/12/rollout-2026-11-12T17-51-54-01a1cef4-d3ae-7260-86f3-bc21f17e4809.jsonl"}}
}
```
