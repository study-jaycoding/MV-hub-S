---
status: active
updated: 2026-11-10
---

# MV Agent — Claude Code 공식 설치 보장 · [업데이트] 단추 (2026-11-10)

owner: Claude · reviewer: Codex(설계 검토·독립 리뷰) · status: 보류 · updated: 2026-11-10

> [!IMPORTANT]
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

## 2. 설계 v2

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

## 3. 시험(가짜만 — 진짜 설치·진짜 업데이트·외부 네트워크 없음)

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

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-claude-update-2026-11-10",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "70730ef8-86b1-4d03-8e24-0b2533ad8e0f"},
  "risk": {"level": "major", "reason": "MV Hub 실행기가 팀 PC 마다 Claude Code 공식 설치를 실행하고, 칸 단추가 공식 업데이트를 실행한다 — 설치·업데이트 흐름 변경, 실패 시 MV Agent 를 못 쓰게 될 수 있음"},
  "goal": "MV Hub 를 켤 때(설치·업데이트 직후 포함) 공식 Claude Code 가 없으면 배경에서 공식 설치를 하고, 서랍 아래 줄에 공식 설치본의 새 판이 있으면 [업데이트](claude update)를 보여 MV Agent 가 늘 최신 Claude Code 로 돌게 한다(Jay 11-10).",
  "touched_paths": ["run_agent_session.py", "backend/tests/test_claude_official_install.py", "backend/app/services/agent_chat_claude.py", "backend/app/services/agent_chat.py", "backend/app/routers/agent_chat.py", "backend/tests/test_agent_chat_update.py", "backend/tests/test_agent_chat_connect.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/components/agent-chat/AgentPanel.tsx", "frontend/src/styles/agent-chat.css", "frontend/tests/agentChatPanel.test.tsx", "docs/inventory/endpoints.md", "docs/inventory/env_vars.md", "docs/inventory/background_jobs.md", "docs/CODE_MAP.md"],
  "criteria": [
    {"id": "launcher", "success": "실행기 공식 설치 시험(조건별 안 부름·명령·Job 밖·표식·시간 초과·배경) + 바로가기·실행기 기존 시험 통과, 진짜 설치·네트워크 없음", "failure": "시험 실패 또는 시험이 진짜 설치를 부름", "required": true, "verification": []},
    {"id": "backend", "success": "업데이트 시험(method·can_update·성공·실패·시간 초과·동시·업데이트 중 exe 0·주인 기록·회수 표식·거절·문구) + 칸 연결·입구·기록 시험 통과", "failure": "시험 실패", "required": true, "verification": []},
    {"id": "frontend", "success": "업데이트 단추 시험 + MV Agent 칸·머리줄·연결 시험 + CSS 계약 + 빌드 + 경계 검사 통과", "failure": "시험·빌드 실패", "required": true, "verification": []},
    {"id": "inventory", "success": "gen_inventory --check · check_code_map 통과", "failure": "목록 낡음", "required": true, "verification": []}
  ],
  "decisions": [
    {"choice": "MV Hub 실행기가 공식 설치를 보장(설치·업데이트 직후 포함, 배경·실패 무시·24시간 간격)", "why": "Jay 11-10 '설치·업데이트 때 공식 설치' — 설치·업데이트 모두 실행기로 끝나고 사용자 계정으로 돈다", "alternative": "설치·업데이트 스크립트(MVHub_Install.bat·워커)에 단계 추가", "revisit": "실행기가 아닌 길로 허브를 켜는 경우가 생길 때"},
    {"choice": "npm 설치본은 앱이 바꾸지 않는다(지우지도 않음) — 공식 설치본으로 모은다", "why": "1차 검토의 위험 대부분이 npm 제자리 교체에서 나옴, 허브는 판이 높은 쪽을 고른다", "alternative": "npm 업데이트를 앱이 실행(v1)", "revisit": "공식 설치가 막힌 PC 가 많을 때"},
    {"choice": "[업데이트] = 공식 설치본의 claude update, 공식일 때만", "why": "공식 업데이터는 실행 중에도 도는 방식(문서) — 파일 잠금·되돌리기를 앱이 떠안지 않는다", "alternative": "단추 없이 백그라운드 자동 업데이트만", "revisit": "공식 업데이터가 허브 종료에 약한 것이 실측되면"},
    {"choice": "공유 서버·SYSTEM·개발 트리·스위치 0 에서는 설치 안 함", "why": "서버는 다른 길·SYSTEM 이면 시스템 프로필에 깔림·개발본은 사람 PC 설정을 바꾸지 않게", "alternative": "어디서나", "revisit": "서버에도 MV Agent 가 필요해질 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}}
}
```
