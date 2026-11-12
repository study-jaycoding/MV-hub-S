---
status: active
updated: 2026-11-12
---

# MV Agent ChatGPT(Codex) 잠금 풀기 — 설정 쪽 [연결]로 이 PC 에서 켜기 (2026-11-12)

owner: Claude(설계·구현·실측) · reviewer: Codex(설계 적대적 검토 → 구현 뒤 다른 세션 독립 리뷰) · status: 보류(실측 권한 — Jay 결정 대기, 코드 0) · updated: 2026-11-12

> [!IMPORTANT]
> **11-12 저녁 보류** — 2-4 훅 대조 시험의 '대조'(훅을 일부러 켜서 실제로 도는지 보이기)는 `--dangerously-bypass-hook-trust` 를 써야 하는데(공식 문서: 프로젝트 훅은 그 폴더를 믿을 때만, 훅마다 신뢰를 기록 — 자동화는 이 플래그로만 한 번에 돌림), 이 실행이 Claude Code 자동 권한 판정에서 '안전 우회 플래그'로 거절됐다. 우회하지 않고 멈춤. 합의 조건상 대조가 성공해야만 잠금을 푼다 → **Codex 는 그대로 잠금**. 다음 = Jay 가 (가) 임시 폴더에서 이 플래그로 대조를 돌리도록 허락하거나 (나) 그대로 잠가 두기를 고른다. 실측 스크립트 = 세션 스크래치 `codexmeasure/measure_codex.py`(A 대조·B/C/D/F 칸 명령·E 이어 가기 대조, 임시 폴더·`--ignore-user-config`, MV 연결 없음).

## 1. 요청과 사실

- Jay 11-12: 설정 창에서 "클로드나 코덱스 연결도 가능하다면 연결도 여기서" → 남은 목록 "GPT(Codex) 잠금 풀기 조건(허용 밖 도구 3개를 받아들일지·팀 전체에 열지)" → **"모두 구현하자. 설계부터 확정하고 바로 구현"**(결정은 추천안으로 — 이 기록 2절에 적는다).
- 지금(코드 확인): `agent_chat_process.CODEX_LOCK` 한 줄이 엔진을 잠근다(`engine_problem` → 칸 메뉴에 "점검 필요"). 실행 명령·해석기·위반 감지(`command_execution`·`file_change`·`web_search`·`collab_tool_call` = 바로 끔)·판 고정(`CODEX_VERIFIED = 0.162.0-alpha.17.2`, 이 PC 의 Codex 도 이 판)·구독 확인(`login status` 에 ChatGPT)은 이미 있다.
- 0단계 실측(옆 칸 설계 6-1, 11-09): 노출 도구 = 조건부 통과 — 기능 16개 끄기·앱·웹 끄기 뒤 남은 것 `apply_patch`(읽기 전용 샌드박스라 못 씀)·시계·MCP 자료 3개(list/read resources·templates)·칸 도구. 전역 지침 `~/.codex/AGENTS.md` 는 늘 들어감(Jay 11-09 허용). **남은 확인 = 훅 대조 시험 + 허용 밖 도구 3개 결정 + 두 모델 합의**(8절 6번).

## 2. 설계(추천안 — Jay '모두 구현' 위임)

### 2-1. 범위 = PC 마다 사람이 켠다(기본 꺼짐)
- `CODEX_LOCK` 상수 대신 **이 PC 의 칸 설정 표식** `%LOCALAPPDATA%\MVHub\agent_chat\codex_enabled.json`(`{"enabled": true, "version": "<켠 때 Codex 판>", "at": 시각}`) 이 있을 때만 엔진을 연다. 없거나 깨졌거나 판이 다르면 지금처럼 잠금(까닭: "설정에서 켜야 써요" / "확인하지 않은 판").
- 켜기: 설정 쪽 ChatGPT 줄 **[연결]** → 허브 `POST /api/agent-chat/codex/enable`(칸 인증) — 허브가 ① Codex 판이 `CODEX_VERIFIED` 안 ② 구독 로그인(`login status`) ③ **격리 점검**(2-3)을 통과해야 표식을 쓴다. 실패면 까닭을 그대로 보이고 표식 없음. 끄기 = 같은 줄 [끄기] → 표식 지움. 팀 PC 는 각자 켤 때만 열린다(팀 전체 기본 열기 아님).
- 공유 서버는 칸이 안 붙으니 그대로 제외.

### 2-2. 허용 밖 도구 3개 = 받아들인다(근거와 막는 장치)
- `apply_patch`: `--sandbox read-only` 라 파일을 못 쓴다(0단계 실측) + 해석기가 `file_change` 항목을 보면 바로 끈다(지금 그대로).
- 시계: 시각만 준다 — 해 없음.
- MCP 자료 3개: 붙은 MCP 서버가 `mvhub_panel` 하나뿐(`enabled_tools` 로 칸 도구만, 사용자 설정은 `--ignore-user-config` 로 안 읽음)이라 그 서버의 자료 목록만 본다 — 칸 서버는 자료를 내놓지 않는다(어댑터 확인).
- 이 셋 밖의 도구·항목이 보이면 지금처럼 위반으로 끈다.

### 2-3. 격리 점검(켤 때마다 · 판이 바뀌면 다시) = 무과금 한 차례
- 허브가 칸 실행과 **같은 명령**(같은 기능 끄기·샌드박스·`--ignore-user-config`·`--ignore-rules`)으로 Codex 를 한 번 띄우되 MCP 는 **허브 안 가짜 점검 서버**(도구 `ping` 하나, MV 실행 도구 없음)를 붙이고, 프롬프트 = "ping 을 한 번 부르고, 쓸 수 있는 도구 이름을 줄마다 적어라".
- 통과 = 끝남(`turn.completed`) · 위반 항목 0(명령·파일·웹·협업) · `ping` 이 한 번 불림 · 적은 도구 이름이 {ping, 시계·apply_patch·MCP 자료 3개} 안. 모델 보고는 약한 근거라 **위반 항목 0 과 실제 호출 기록이 주 근거**, 이름 목록은 보조(모르는 이름이 나오면 실패).
- 시간 제한 120초, Job 으로 묶어 끝나면 0개 확인(칸 차례와 같은 실행기).

### 2-4. 훅 대조 시험(합의 조건 — 구현 전 실측)
- 임시 작업 폴더에 프로젝트 `.codex/config.toml`(+필요하면 훅 파일)로 **표식 파일을 만드는 훅**을 둔다. ① 칸 명령 그대로 → 표식 없음 ② 대조(같은 폴더, 칸 제한을 뺀 명령 + 훅 신뢰 강제 `--dangerously-run-hooks` 류) → 표식 생김. ②가 생겨야 ①의 '없음'이 뜻이 있다. ②가 어떤 방법으로도 안 생기면(이 판에서 프로젝트 훅을 못 켬) 그 사실과 근거를 적고 ①만으로 판단한다. MV 연결·Jay 사용자 설정은 쓰지 않는다(임시 폴더·`--ignore-user-config`).

### 2-5. 화면
- 설정 쪽 ChatGPT 줄: 꺼짐 = [연결](누르면 '확인하는 중' → 통과면 연결됨·실패면 까닭) · 켜짐 = 연결됨 + [끄기]. 모델 칩 메뉴의 ChatGPT 줄은 허브 엔진 상태 그대로(켜지면 고를 수 있음).

## 2-6. 1차 설계 검토(Codex, 11-12) — 수정 요청(2판에서 반영할 것)
- P1: ① Codex 해석기가 모르는 항목을 그냥 넘김 → 알려진 항목만 허용(목록 밖 = 위반) ② 칸 어댑터가 HTML 자료(MCP Apps)를 등록할 수 있음 → 칸 모드는 등록 안 함(지금 코드 `apps = … and not panel` 로 이미 막혀 있음 — 2판에서 시험으로 못 박기) ③ 점검의 `ping` 은 `enabled_tools` 에 없음 → 가짜 `check_connection`(nonce 돌려줌)으로 ④ 한 번 정상으로 돈 것은 격리 증거가 아님 → apply_patch 거절·프로젝트 `.codex`·AGENTS.md·skills·MCP 유입을 따로 시험 ⑤ 훅 대조는 새 차례·이어 가기 둘 다 성공해야 하고, 못 하면 잠금 유지.
- P2: 표식 수명·정책 판 · 켜기/끄기 경합 · 화면의 '허용됨'과 '로그인됨' 구분.
- 2판 진행 조건 = 2-4 대조가 실제로 성공(위 보류 참조). 그 전에는 코드를 바꾸지 않는다.

## 3. 시험
- 허브: 표식 없음·깨짐·판 다름 = 잠금 · enable 이 판·로그인·점검 실패마다 표식을 안 씀 · 통과면 씀 · disable 지움 · 점검 명령 = 칸 명령 + 가짜 점검 서버 · 위반·시간 초과 = 실패.
- 해석기: Codex 시계·apply_patch·MCP 자료 항목 모양(0단계 원본)을 위반으로 보지 않고, 그 밖 항목은 위반.
- 화면: [연결]·확인 중·실패 까닭·[끄기].
- 실측(무과금 Codex 구독 차례, MV 생성 없음): 2-3 점검 1회 · 2-4 대조 시험.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-codex-unlock-2026-11-12",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "4e253e69-1c8b-4f92-80da-34b2f50ce3c0"},
  "risk": {"level": "major", "reason": "잠가 둔 Codex 엔진을 PC 별 설정으로 열고, 허브가 격리 점검으로 Codex 를 띄운다 — 권한·격리 경계"},
  "goal": "설정 쪽 ChatGPT [연결]로 이 PC 에서 Codex 를 켠다. 판·구독·격리 점검을 통과해야 열리고, 허용 밖 도구 3개는 근거와 막는 장치를 두고 받아들인다.",
  "touched_paths": ["backend/app/services/agent_chat_process.py", "backend/app/services/agent_chat_parse.py", "backend/app/services/agent_chat_codex.py", "backend/app/routers/agent_chat.py", "backend/app/config.py", "backend/tests/test_agent_chat_codex_unlock.py", "backend/tests/test_agent_chat_parse.py", "backend/tests/agent_chat_fake_cli.py", "frontend/src/lib/agentChatApi.ts", "frontend/src/components/agent-chat/AgentSettings.tsx", "frontend/src/styles/agent-chat.css", "frontend/tests/agentChatPanel.test.tsx", "docs/inventory/endpoints.md", "docs/CODE_MAP.md"],
  "criteria": [
    {"id": "measure", "success": "격리 점검 1회 통과 + 훅 대조 시험 결과 기록(무과금, MV 생성 없음)", "failure": "점검 실패 또는 대조 시험에서 훅이 칸 명령에 들어감", "required": true, "verification": []},
    {"id": "backend", "success": "백엔드 agent_chat 시험(잠금 해제 새 시험 포함) 통과", "failure": "시험 실패", "required": true, "verification": []},
    {"id": "screen", "success": "MV Agent 칸 시험 + 빌드·경계 검사 통과", "failure": "시험·빌드 실패", "required": true, "verification": []}
  ],
  "references": [],
  "decisions": [
    {"choice": "Codex 는 PC 마다 설정 [연결]로 켠다(기본 꺼짐, 판이 바뀌면 다시 꺼짐)", "why": "팀 전체를 한 번에 열지 않고 켠 사람만 위험을 진다", "alternative": "CODEX_LOCK 을 지워 모두에게 열기", "revisit": "팀이 모두 Codex 를 쓰게 되면"},
    {"choice": "허용 밖 도구 3개(apply_patch·시계·MCP 자료)는 받아들인다", "why": "읽기 전용 샌드박스·파일 변경 감지·칸 서버 하나뿐이라 행동으로 이어지지 않는다", "alternative": "끌 방법이 생길 때까지 잠금 유지", "revisit": "그 도구가 쓰기·외부 접근을 하게 되면"},
    {"choice": "켤 때마다 무과금 격리 점검을 허브가 돌린다", "why": "Codex 판·서버 기본값이 바뀌어 새 도구가 붙는 것을 켜는 순간 잡는다", "alternative": "한 번 실측한 결과를 믿음", "revisit": "점검이 자주 틀리면"}
  ],
  "evidence": {"target": {"kind": "worktree"}}
}
```
