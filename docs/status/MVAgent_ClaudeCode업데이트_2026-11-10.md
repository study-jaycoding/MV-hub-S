---
status: active
updated: 2026-11-10
---

# MV Agent — Claude Code 새 판 [업데이트] 단추 (2026-11-10)

owner: Claude · reviewer: Codex(설계 검토·독립 리뷰) · status: 보류 · updated: 2026-11-10

> [!IMPORTANT]
> 1차 설계 검토(아래 4절) 결과 **양측 수정 요청** — 범위(앱이 조용히 설치 / 보이는 창에서 설치 / 안내만)를 Jay 에게 묻고 멈춤. 코드 0.

## 1. 요청과 사실

- Jay 11-10: 서랍 아래 설정 칸을 없애고(dev `ef0f2954` 완료), 그 자리에 **"npm 업데이트가 생기면 [업데이트]를 눌러 설치"**.
- 실측(11-10): 이 PC 허브가 쓰는 Claude Code = npm 전역 설치본 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` **2.1.296**(`agent_chat_process.find_claude` — PATH 의 npm 셰임 옆 실제 exe → 공식 설치 `~\.local\bin\claude.exe`, 둘이면 판이 높은 쪽). npm 최신 2.1.322. 데스크톱 앱 내장 2.1.321 은 허브 후보가 아니다.
- 앞 결정과의 관계: 「Claude Code 없는 PC = 설치 안내(B), 앱이 설치를 실행하지 않음」(옆 칸 설계)은 **새로 설치**의 결정이다. 이번 Jay 요청은 **이미 npm 으로 설치된 Claude Code 의 판 올리기**만 앱이 실행한다. 새로 설치는 지금처럼 안내만.
- 위험: 앱이 PC 의 전역 프로그램을 바꾼다(그 PC 터미널의 `claude` 도 바뀜). 실행 중인 claude.exe 가 파일을 쥐고 있으면 npm 교체가 실패하고 반쯤 지워진 설치가 남을 수 있다(10-27 업데이터에서 겪은 Windows 파일 잠금과 같은 종류). 팀 PC 마다 각자 누른다.

## 2. 설계

### 2-1. 판 확인 — `GET /api/agent-chat/claude/update` (칸 표 `_panel`)
- 답: `{method, current, latest, can_update, reason, job}`.
  - `method`: `npm`(허브가 고른 exe 가 PATH 의 npm 전역 접두사 아래 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`) · `official`(공식 설치 — 스스로 업데이트하므로 단추 없음) · `none`(Claude Code 없음).
  - `current` = `cli_version(find_claude())`, `latest` = npm 의 `latest` 판(아래), `can_update` = method npm · 둘 다 읽힘 · latest > current(판 비교 `version_tuple`) · 진행 중 업데이트 없음.
  - `reason`(단추를 안 보이는 까닭, 화면엔 안 씀): `not_npm` · `check_failed` · `up_to_date` · `no_claude`.
- `latest` 읽기: npm 자체로 묻는다 — `node <npm>/node_modules/npm/bin/npm-cli.js view @anthropic-ai/claude-code@latest version --json`(PC 의 npm 설정·사내 미러를 그대로 따르게 — 설치와 같은 출처). 20초 제한, 결과 6시간 메모리 캐시(실패도 10분 캐시 — 서랍을 열 때마다 npm 을 띄우지 않게). 판 모양(`\d+\.\d+\.\d+`)만 받는다.
- node·npm-cli.js 찾기: `shutil.which("npm")` 의 폴더 + `node_modules/npm/bin/npm-cli.js`, node 는 `shutil.which("node")`(find_codex 와 같은 방식 — `.cmd` 셰임을 거치지 않아 인자가 안전).

### 2-2. 업데이트 — `POST /api/agent-chat/claude/update` (칸 표 `_panel`)
- 허브 안에서 한 번에 하나(모듈 잠금). 바로 `{job}` 을 돌려주고 일은 스레드에서. 화면은 GET 으로 2초마다 `job` 을 본다.
- 스레드 순서(하나라도 걸리면 실패로 끝내고 아무것도 바꾸지 않는다):
  1. 판 확인을 **새로** 다시(캐시 무시) — `can_update` 가 아니면 끝.
  2. `ClaudeLock("update")` 획득(PC 전체 뮤텍스 — 다른 허브의 차례·로그인 창 만들기와 겹치지 않게. 기존 획득 규칙 그대로: 회수 안 된 차례 표식·살아 있는 주인이면 막음). 못 잡으면 "Claude 가 일하는 중이에요".
  3. 잠금 안에서: 로그인 창이 살아 있지 않음(`window_alive()` 거짓, 기록 못 읽으면 막음) · **이 exe 경로로 떠 있는 claude.exe 가 0개**(`_claude_command_lines()` — 못 읽으면 막음, 명령줄에 그 exe 경로가 들어 있으면(대소문자 무시) 막음: "Claude Code 가 다른 곳(터미널 등)에서 실행 중이에요 — 닫고 다시 눌러 주세요").
  4. `node npm-cli.js install -g @anthropic-ai/claude-code@<1단계 latest 그대로> --no-fund --no-audit` 를 `JobProcess` 로(창 없음·자식까지 Job 안·10분 제한, 넘으면 Job 을 닫아 끈다). 환경 = `child_env()`.
  5. 끝나면 `find_claude()`·`cli_version` 으로 **새 판 == 목표** 확인 → 성공. 다르거나 npm 실패면 실패 — 이때 Claude Code 가 아직 도는지(`cli_version` 읽힘)를 함께 알린다: 못 읽으면 "Claude Code 를 다시 설치해야 해요 — 터미널에서 `npm install -g @anthropic-ai/claude-code`".
  6. 잠금을 놓고(Job 0개 확인 뒤), 판 확인 캐시와 엔진 캐시(`service.engines(True)`)를 비운다.
- 차례와 겹침: 업데이트가 잠금을 쥔 동안 새 차례는 `would_block` 이 막는다 — 주인 기록 kind 가 `update` 면 문구를 "Claude Code 업데이트 중이에요"로. 진행 중인 차례가 있으면 2단계에서 업데이트가 막힌다(차례가 잠금을 쥐고 있다).
- 기록: 허브 로그에 시작·끝·npm 종료 코드·목표 판만(npm 출력 원문은 남기지 않는다). 화면 실패 문구에는 npm 오류 코드(`EBUSY`·`EPERM`·`ENOTFOUND` 등 대문자 코드 하나)만 뽑아 보인다.

### 2-3. 화면 — 서랍 맨 아래(옛 설정 칸 자리)
- 서랍을 열 때 GET 한 번. `can_update` 일 때만 한 줄: `Claude Code 새 판 2.1.322 (지금 2.1.296)` + **[업데이트]**(라임 바탕·검은 글자).
- 누르면 POST → 줄이 `업데이트하는 중` (단추 잠금) → 끝나면 `2.1.322 로 업데이트했어요` / `업데이트하지 못했어요 · <까닭>` + [다시]. 대화가 도는 중(`chat.running`)엔 단추를 잠그고 `대화가 끝나면 업데이트할 수 있어요`.
- 서랍을 닫아도 업데이트는 허브에서 계속된다(다시 열면 job 상태를 이어 보인다).
- 새 창(?embed=agent)에서도 같은 서랍이라 같다.

## 4. 1차 설계 검토(계약 SHA 50333a1d…)

- Codex(설계 세션 `01a1bf3c` 이어 받기, 요청 모델 gpt-6.1-sol·high, 무도구·읽기 전용) — **수정 요청**, P1 6 · P2 3.
- Claude(읽기 전용 새 세션 `d77d3d43`, claude-opus-5-5) — **수정 요청**, 중대 3 · 보통 2 · 작음 2.
- 겹친 중대 지적:
  1. 업데이트 중에도 **허브 자신이 같은 claude.exe 를 띄운다** — 상태 조회(`claude_state` 의 `--version`·`auth status`), 차례 시작의 `engine_problem`(잠금 확인 `would_block` 보다 먼저, `routers/agent_chat.py:217`), `/session` 의 엔진 목록, 2초마다 도는 판 확인. 업데이트 중엔 이 길들이 모두 실행하지 않아야 한다.
  2. `ClaudeLock` 은 설치 파일 기준이 아니라 **자격 폴더 기준·`Local\`** 뮤텍스다(`agent_chat_claude.py:144`·`:346`). 주인 기록 검사 `_valid_owner` 가 `update` 를 몰라(173줄) 업데이트 주인 기록을 깨진 기록으로 읽고 막지 않는다 · 업데이트엔 차례 표식(회수 확인)도 없다.
  3. **npm 전역 설치 위치 판정이 틀렸다** — `which("npm")` 폴더(보통 `C:\Program Files\nodejs`)가 아니라 `npm prefix -g`(보통 `%APPDATA%\npm`)와 Claude 셰임 폴더를 맞춰야 한다. 사후 확인도 `find_claude()`(판이 같으면 공식 설치를 고름) 말고 npm exe 경로를 직접.
  4. 실행 중 확인은 명령줄 글자 대신 `ExecutablePath` 로. 그래도 확인~설치 사이에 터미널에서 claude 를 켜는 틈이 남는다 → Codex: **실패 뒤 되돌릴 수 있는 교체**(설치 전 패키지·셰임 복사본 → 실패하면 복원).
  5. 허브가 설치 도중 꺼지면(Job 이 npm 을 끔) 복구 계약이 없다 → 시작 전 대상·목표·진행 상태를 파일에 남기고 다시 켤 때 확인.
  6. (P2) 판 확인은 종료 코드·엄격한 판 모양 · 진행·실패·복구 상태는 `can_update` 와 따로 보여야 한다 · touched_paths 에 `services/agent_chat.py`·`agent_chat_process.py`·`tests/test_agent_chat_claude.py` 추가.
- 원문: 세션 스크래치 `agentpanel/codex_update_design_reply.md` · `claude_update_agree.json`.

## 3. 시험

- 백엔드(가짜만 — 진짜 npm·진짜 Claude Code 를 바꾸지 않는다): 판 확인(npm 경로 판정·official·none, 최신 > 지금일 때만 can_update, 판 모양 아님·실패 캐시) · 업데이트가 막히는 경우(잠금 못 잡음·로그인 창·같은 exe 실행 중·명령줄 조회 실패·1단계에서 최신 아님) · 성공(명령 인자에 정확한 판, 끝 판 확인, 캐시 비움) · npm 실패·판 불일치·시간 초과(Job 닫기) · 동시 두 번 누름(하나만) · 업데이트 중 `would_block` 문구.
- 프런트: can_update 일 때만 줄 · 누르면 POST 후 진행·성공·실패 문구 · 대화 중 잠금 · 그 밖 기존 칸 시험·CSS 계약·빌드·경계 검사.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-claude-update-2026-11-10",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "70730ef8-86b1-4d03-8e24-0b2533ad8e0f"},
  "risk": {"level": "major", "reason": "앱이 PC 의 전역 프로그램(npm 의 Claude Code)을 설치·교체한다 — 업데이트 실행, Windows 파일 잠금으로 실패하면 Claude Code 가 깨질 수 있고, 팀 PC 마다 돈다"},
  "goal": "MV Agent 서랍 맨 아래에, 허브가 쓰는 npm 설치 Claude Code 의 새 판이 있을 때만 [업데이트]를 보이고 누르면 안전 확인 뒤 그 판으로 설치한다(Jay 11-10).",
  "touched_paths": ["backend/app/services/agent_chat_update.py", "backend/app/services/agent_chat_claude.py", "backend/app/routers/agent_chat.py", "backend/tests/test_agent_chat_update.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/components/agent-chat/AgentPanel.tsx", "frontend/src/styles/agent-chat.css", "frontend/tests/agentChatPanel.test.tsx", "docs/inventory/endpoints.md", "docs/inventory/background_jobs.md", "docs/CODE_MAP.md"],
  "criteria": [
    {"id": "backend", "success": "새 업데이트 시험(판 확인·막힘 6가지·성공·실패·시간 초과·동시 누름·would_block 문구) + 칸 기록·실행기 시험 통과, 진짜 npm·Claude Code 는 건드리지 않음", "failure": "시험 실패 또는 시험이 진짜 npm 을 부름", "required": true, "verification": []},
    {"id": "frontend", "success": "업데이트 줄 시험 + MV Agent 칸·머리줄·연결 시험 + CSS 계약 + 빌드 + 경계 검사 통과", "failure": "시험·빌드 실패", "required": true, "verification": []},
    {"id": "inventory", "success": "gen_inventory --check · check_code_map 통과", "failure": "목록 낡음", "required": true, "verification": []}
  ],
  "decisions": [
    {"choice": "이미 npm 으로 설치된 Claude Code 의 판 올리기만 앱이 실행(새로 설치는 안내 그대로)", "why": "Jay 11-10 요청 — 앞 결정(설치 안내 B)은 새로 설치 범위", "alternative": "업데이트도 안내만(명령 복사)", "revisit": "팀 PC 에서 업데이트 실패가 잦을 때"},
    {"choice": "최신 판은 npm view 로(PC 의 npm 설정·미러를 따름), 설치는 그 정확한 판 번호로", "why": "확인한 판과 설치하는 판이 같아야 하고, 사내 미러가 있으면 직접 레지스트리 주소와 다를 수 있다", "alternative": "registry.npmjs.org 직접 조회", "revisit": "npm view 가 느리거나 실패가 잦을 때"},
    {"choice": "PC 전체 Claude 잠금(ClaudeLock update) + 로그인 창 없음 + 같은 exe 의 claude.exe 0개일 때만 설치", "why": "실행 중인 exe 를 npm 이 바꾸다 실패하면 설치가 반쯤 남는다(Windows 파일 잠금)", "alternative": "그냥 실행하고 실패하면 안내", "revisit": "실측에서 막힘이 너무 잦을 때"},
    {"choice": "공식 설치본(~/.local/bin)은 단추 없음", "why": "공식 설치는 Claude Code 가 스스로 업데이트한다", "alternative": "claude update 실행", "revisit": "공식 설치 PC 가 판이 밀릴 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}}
}
```
