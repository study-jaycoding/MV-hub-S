---
status: active
updated: 2026-10-28
---

# ZIP 없는 MCP 독립 업데이트와 결과 표시

사용자 요청: 이 채팅의 `zip-mcp` 23:10 예약. 개발 작업실의 설계·구현·격리 비유료 검증까지 승인했다. 실제 커밋·푸시·병합·릴리스·배포·NAS 쓰기·설치본/사용자 DB/전역 등록 변경·유료 생성은 제외한다. 기존 다른 예약과 합치거나 메시지를 보내지 않는다.

owner와 담당 경로는 아래 계약이 정본이다. reviewer: Claude 별도 세션 `50b4200b-5cd4-44dc-b18b-d86bc869f15c` 재리뷰 승인. 로컬 구현·격리 검증 상태: 완료. 실제 설치·NAS·운영 배포와 최초 본체 도입: 보류. 외부 표시: 보류(미해결). 데스크톱 카드 유지·모바일 실제 표시·중복 없음은 최종 사용자 요구이며 아직 해결·검증되지 않았다. 이번 준비 계약의 통과를 그 완료로 확대하지 않는다.

```vibe-intent
{
  "schema": 1,
  "id": "mcp-independent-20261027",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a17c8c-7cb0-77c1-88a3-04e544cd8486"},
  "risk": {"level": "major", "reason": "실행 코드 배포·설치·동시 전환 및 MCP 결과 권한 경계"},
  "goal": "MCP server.py만 검증된 origin/main 고정 커밋에서 가져와 별도 후보→관리자 게시→사용자 개별파일 설치하는 제품 연결을 구현한다. ZIP·전체 checkout 업데이트·클라이언트 Git 없이 기존 연결을 보존한다. 원본 생성 식별자와 표시 문맥을 권한검사 뒤 제공하되 외부 위젯/모바일 단일표시의 미해결을 기록한다. 운영·전역설정·사용자 데이터·유료생성·실제 커밋/푸시/배포는 변경하지 않는다.",
  "touched_paths": [
    "tools/mcp_adapter/update.py", "tools/mcp_adapter/server.py", "tools/mcp_adapter/test_update.py", "tools/mcp_adapter/README.md",
    "backend/app/services/mcp_update.py", "backend/app/services/release_update.py", "backend/app/routers/mcp.py", "backend/app/routers/mcp_v2.py",
    "backend/tests/test_mcp_update.py", "backend/tests/test_mcp_display_context.py", "backend/tests/test_release_frontend_build.py",
    "tools/server_console/mcp_stage.py", "tools/server_console/ui.py", "tools/server_console/test_mcp_stage.py",
    "frontend/src/components/mcp/McpUpdate.tsx", "frontend/src/components/mcp/McpUpdate.test.tsx", "frontend/src/components/mcp/McpRegistration.tsx", "frontend/src/lib/i18n.ts",
    "release/make_release.ps1", "docs/MCP_INTEGRATION.md", "docs/CODE_MAP.md", "docs/inventory/endpoints.md", "docs/inventory/env_vars.md"
  ],
  "criteria": [
    {"id":"files", "success":"임시 Git origin/main 고정 커밋에서 허용된 server.py만 바이너리 추출하고 후보 코드를 실행하지 않고 크기/해시/AST/호환 조건 검사; 작업트리 변경과 ZIP 생성 없음", "failure":"허용외 경로·링크·손상 manifest·미검증 후보 실행·checkout 변경", "required":true, "verification":["0d2ba99f169945afb19ecf757b034fa9"]},
    {"id":"install", "success":"임시 배포/설치 사본에서 후보→게시→파일다운로드→포인터전환→롤백 전체 경로 통과; 중간실패/동시성/본체잠금/손상/호환실패 때 기존판 유지", "failure":"부분판 활성화·인증설정 변경·HTTP/다른 출처 redirect 수용·본체 교체와 경합", "required":true, "verification":["1afb2e2705c0474faa0239076362fc96"]},
    {"id":"clients", "success":"기존 stdio/DPAPI 회귀와 새 버전 선택 검증; UI 확인/고정 후보 적용/오류/재시작 안내 및 권한 제한 시험 통과", "failure":"기존 등록 무효·실행중 판을 새판이라고 단정·표시만 있고 실제 설치 연결 누락", "required":true, "verification":["3442583ee43740118573a771bc4a25f2","4b060f16b75d4994a0420fb5fbbafeee","dde43be99932459c812a57628d5d4589"]},
    {"id":"display", "success":"권한·공간·생성자 검사 후 실제 원본job_id와MV generation_id를 구분; 미완료/원본없음/타공간 거부 시험; 자동 위젯 재호출/이중출력/재생성 없음; 외부 실제 화면 미검증 명시", "failure":"ID 추측/DB전수조사·프롬프트 매칭·권한 유출·모바일 성공 허위 주장·기본UI 일방변경", "required":true, "verification":["d77e7d3486e14864befc446f6fdd50fb"]}
  ],
  "decisions": [
    {"choice":"기존 본체 잠금 탐지에서 Windows Python PermissionError에 winerror가 빠진 경우 읽기 전용 Win32 공유위반 재확인. 새 MCP 문구는 기존 영어사전에도 추가", "why":"실제 격리시험에서 공유0 잠금을 기존 탐지가 놓쳤고 영어화면 회귀가 발견됨", "alternative":"권한오류를 모두 잠금으로 처리하거나 시험완화는 제외", "revisit":"다른 런타임에서 잠금 실패근거가 달라질 때"},
    {"choice":"서버는 main 고정 커밋의 blob을 파일 단위 추출하고 기존 신뢰된 릴리스 위치 아래 mcp에 별도 게시", "why":"전체 앱 checkout·패키지와 독립, 기존 배포정책/원본설정을 유지", "alternative":"dev 배포정책 변경·새 서비스·ZIP archive는 제외", "revisit":"별도 원본/SDK/Python 독립배포가 명시 승인될 때"},
    {"choice":"고정 설치본 server.py의 시작 단계가 update.py를 통해 설치위치별 current 포인터를 검증하고 선택판을 실행; 모듈 import API는 유지", "why":"기존 등록 경로와 DPAPI/SDK를 보존", "alternative":"전체 server.py를 다른 모듈로 이동하거나 전역 MCP 재등록은 제외", "revisit":"고정 실행기/API 변경 시 최초 본체 도입 업데이트 필요"},
    {"choice":"허용목록은 고정 update.py의 server.py 하나. local_setup/update.py/requirements 잠금과 요구 hub features 호환 검사; 실행 Python은 기존 번들 사용", "why":"코드만 독립갱신하고 실행기·SDK·프로필·백엔드 변경은 본체 도입으로 한정", "alternative":"가변 manifest가 실행기/의존성을 임의 확장하는 설계는 제외", "revisit":"명시적 런타임 갱신 계약 합의 시"},
    {"choice":"불변버전폴더·manifest digest·원자 current/previous 전환과 CAS. Windows 공유0의 .update.lock 및 서버 Git/게시 잠금. 자동 GC 생략", "why":"부분파일과 동시전환을 차단하고 실행중인 판을 보존", "alternative":"단순 상태폴링·최신버전 숫자 자동선택·실행실패후재실행은 제외", "revisit":"디스크 정리 요구 또는 플랫폼 확장 시"},
    {"choice":"포인터에 설치본 VERSION.txt/번들 server.py 지문을 고정하고 본체 변경 시 재확인. 사전검증 실패만 번들 선택, 후보 실행 시작 뒤 실패는 재실행하지 않음", "why":"본체 갱신 뒤 낡은 포인터와 이중실행을 방지", "alternative":"버전 숫자만 비교해 롤백을 무력화하지 않음", "revisit":"초기 도입 실설치 확인 뒤"},
    {"choice":"권한을 통과한 본인 생성의 실제 job_id만 표시문맥으로 제공. 팀공간도 권한이 맞으면 허용하되 외부커넥터 접근 가능을 보장하지 않음. MV 폴더를 HF folder_id로 추측하지 않음", "why":"실제 R&D 사용 흐름을 보존하면서 계정/공간 확인 책임을 명확히 함", "alternative":"기본 표시를 카드+이미지로 이중출력하거나 전역 표시완료 기록으로 다른채팅을 막는 방법 제외", "revisit":"호스트가 공식 단일UI/모바일대체 계약을 제공하면 별도 합의"}
  ],
  "evidence": {"target":{"kind":"worktree"}, "consensus":[{"host":"claude","session":"6e226bdb-1a3d-4c49-b6da-3b3c881b4b2f","transcript":"C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/6e226bdb-1a3d-4c49-b6da-3b3c881b4b2f.jsonl"},{"host":"codex","session":"01a17c8c-7cb0-77c1-88a3-04e544cd8486","transcript":"C:/Users/FX-PC06/.codex/sessions/2026/10/27/rollout-2026-10-27T17-49-04-01a17c8c-7cb0-77c1-88a3-04e544cd8486.jsonl"}], "design_sessions":[{"host":"claude","session":"6e226bdb-1a3d-4c49-b6da-3b3c881b4b2f"},{"host":"claude","session":"9722a481-57bd-4e4c-a764-04312a0f7a4e"}], "review":{"host":"claude","session":"50b4200b-5cd4-44dc-b18b-d86bc869f15c","transcript":"C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/50b4200b-5cd4-44dc-b18b-d86bc869f15c.jsonl"}}
}
```

## 직접 확인과 설계 교환

- 실제 Claude 구조 설계 및 수정안 회수: `6e226bdb-1a3d-4c49-b6da-3b3c881b4b2f`, 요청 opus/high, 응답 메타데이터 claude-opus-5-5. high 실제 적용값은 미확인. Codex 반례를 검토하고 잠금/번역·자동 생성 목록·릴리스 fixture까지 포함한 최종 계약에 실제 양측 hash 합의를 받았다.
- 별도 Claude vibe-ux: `9722a481-57bd-4e4c-a764-04312a0f7a4e`, opus/medium 요청, claude-opus-5-5 응답. 기존 Tk 큐·버전표·색상·설정 상태패턴 재사용 제안. CSS·실제 화면 검수는 미수행.
- 초기 작업 트리에 운영 문서/역할 변경이 있었다. 제품 파일은 수정 전 상태를 다시 확인한다. 다른 예약의 `hf_improvements_2026-10-27.md`는 별도 담당 기록이므로 변경하지 않는다.
- MCP는 설치본 server.py·local_setup·SDK·Python에 결합되어 있어 최초 도입은 본체 업데이트가 필요하다. 향후 어댑터 코드만 독립 업데이트한다. MV 백엔드·SDK/Python/인증프로필 변경까지 독립화했다고 주장하지 않는다.
- Git 가져오기에는 기존 console_stage의 ZIP 추출을 재사용하지 않는다. 기존 origin/main·잠금·불변stage 패턴만 재사용한다. 서버 본체 checkout은 유지한다.
- 모바일 단일표시: 사용자 보고는 HF 카드 데스크톱 성공/폰 실패, 같은 원본 HTTPS Markdown 이미지 폰 성공. 후자는 데스크톱 카드 유지 조건을 충족하지 못한다. job_display는 호출마다 새 위젯이며 교체/클라이언트별 표시 제어 계약이 노출되지 않았다. MV만으로 최종 UX를 해결했다고 볼 수 없다.

## 예정 사용자 흐름

개발→검증 및 기존 승인 절차의 main 고정 커밋→서버 MCP Git 업데이트(후보만)→파일검증/호환성 확인→MCP 배포→사용자 설정 새 버전 확인→고정 버전 MCP 업데이트→LLM MCP 재연결. 이 예약은 해당 제품 경로를 임시 저장소와 설치 사본에서만 시험한다.

## 구현과 현재 검증 근거

- 고정 실행 경로를 유지하고 설치 위치별 포인터로 어댑터 한 파일만 선택한다. SDK와 DPAPI는 설치본에서 읽는다. 최초 독립판 롤백은 포인터를 비활성화해 설치본으로 돌아가며 이후는 직전 독립판으로 전환한다. 버전 파일을 자동 삭제하지 않는다.
- 서버 콘솔은 main의 blob을 크기/모드 검사 후 추출한다. 정적 검증은 실제 생성 시험 통과를 뜻하지 않는다. 기존 원본 폴더 아래 mcp에만 개별 파일을 게시하며 ZIP 경로를 사용하지 않는다.
- 사용자 설정은 확인한 manifest 지문을 적용/롤백 요청에 고정한다. 이미 실행 중인 MCP의 실제 버전과 다음 연결에서 선택될 버전을 구분한다.
- 실제 Windows Python 3.14.3에서 공유0 잠금에 대한 CRT open 오류는 errno=13, winerror=None이었다(클라이언트 구현 담당 실측). 기존 탐지가 놓치는 반례를 최소 Win32 읽기 재확인으로 고쳤다. 새 통합 시험에서 기존 detector=True와 중복 설치 거부를 확인했다.
- 원본 job_id는 실제 행의 값만 쓰며 MV generation_id를 대입하지 않는다. 생성자·공간 권한 확인 뒤 단건 이미지의 표시 준비 문맥만 제공한다. 외부 계정/공간/공유폴더 접근 확인이 필요하며 조회 성공을 표시 완료로 기록하지 않는다.

| 검증 | 결과와 범위 |
|---|---|
| 새 표시 경계 + 기존 MCP persistent + 본체 release_update | root 직접 실행 276 passed, 167.62초. 첫 명령은 루트 cwd로 app import 수집 실패하여 올바른 backend cwd에서 실행 |
| 어댑터 stdio/DPAPI | root 직접 test_server 9·test_local_setup 9·test_persistent 26 passed |
| 새 파일 업데이트 core | 최종 16 passed / 1 skipped(Windows symlink 생성 권한 1314). 실제 subprocess 잠금·선택 실행·손상 복귀·부분 다운로드·원자 교체 실패·CAS·롤백 및 사전 실행기 실패 세 종류 포함 |
| 서버 후보/게시/Tk | 9 passed. 임시 Git→게시 폴더→설치 사본까지, HEAD 보존/ZIP 미생성/허용밖 파일 제외/관리자 만료 확인 |
| 새 사용자 업데이트 + 기존 등록 | 담당 보고 75 backend·17 frontend passed; root 영수증에서 frontend 17 재확인. 임시 LOCALAPPDATA/원본/설치 사본과 프로필 보존 |
| 프런트 빌드/architecture lint | root 직접 통과. 기존 큰 chunk 안내는 남음 |
| 지도/영향 확인 | graft grep update_in_progress·blast 실행. 코드 지도 누락 0, 없는 코드 경로 0. graph 도달률을 커버리지로 주장하지 않음 |
| 기존 서버 콘솔 회귀 | 담당 보고 352 passed / 1 failed. 미변경 install.acl_offenders의 PowerShell DONE 미수신, 단독 재실행도 같음. 이번 변화의 통과로 덮지 않음 |
| 릴리스 도입 회귀 | 첫 실행 190 passed / 22 failed: 기존 archive fixture에 새 필수 update.py가 없어 조기 실패. fixture와 누락 검사 항목을 고친 뒤 MCP update/bridge·release contract·frontend build 묶음 213 passed. 본체 ZIP fixture 검사이며 MCP 배포 경로에서 ZIP을 쓴다는 뜻은 아님 |

실제 공유 서버/NAS/사용자 설치본/사용 DB/전역 MCP 등록/자동시작은 변경하지 않았다. 생성 호출은 0회다. 독립 리뷰 재확인은 통과했다. 최종 영수증 ID는 위 criteria에, 통합 검사 결과는 아래 최종 통합 확인에 기록했다.

## 표시 조건과 미확인 범위

| 클라이언트 | 이 작업의 근거 |
|---|---|
| Codex 데스크톱 | 이전 HF 카드 성공은 사용자 보고. 이번에는 기존 표시 경로 유지 및 단일 경로 지침/메타데이터 시험만 수행 |
| iPhone Codex | HF 카드 실패·HTTPS 본문 이미지 성공은 사용자 보고. 카드 유지와 모바일 동시 단일표시를 충족하는 공식 호스트 경로는 확인하지 못함 |
| Claude Code | 이전 HF 결과 표시 성공은 사용자 보고. 이번 v2 stdio/메타데이터 시험은 실제 Claude 화면 검증을 대신하지 않음 |
| Claude Desktop/모바일 | 실제 화면·위젯 지원 미검증 |
| 일반 ChatGPT 채팅 | 이전 로그인 화면까지만 열었고 비교 대화/전송/표시 검증은 미수행 |

안전한 다음 단계는 새 과금 없이 기존 생성물로 호스트별 단일 UI/대체 표시 계약을 확인하는 것이다. 외부 플러그인의 위젯 교체·기기 판별 기능을 임의로 구현했다고 하지 않는다. 현재 코드가 LLM의 중복 호출이나 외부 앱 렌더링을 강제 제어하지 못한다.

## 최종 통합 확인 — 2026-10-28

- guard integrate 직접 확인: `ok=true`, 계약 `855a92d44fa6f7b0d4f7d236f236cb877c670007d827bc73dc6fcbf05e7a889a`, 대상 지문 `0d53c1f1a2ad0e6d4b5c8483775ffd98f6948163b1fadbef638a542d2838f4d4`. 위 criteria의 최종 영수증 여섯 개와 실제 양측 합의·독립 리뷰를 대조했다. 전체 운영 배포 게이트 통과를 뜻하지 않는다.
- 독립 리뷰 P2 두 건을 반영했다. 고정 실행기 사전 선택 오류는 번들로 복귀하고 후보 실행 이후 실패는 중복 실행하지 않는다. 기본 MV 미리보기 지침을 유지하며 사용자가 외부 표시를 선택했을 때만 해당 경로를 사용한다. 수정 뒤 별도 Claude 세션의 실제 `VIBE-REVIEW-PASS`를 회수했다.
- 비유료 외부 조회: Higgsfield의 현재 선택 공간은 R&D(`4a8c5224-f4da-4640-b115-e68be2b2bed5`). 기존 MV 원본 `1f7fde72-67c6-4d24-9fc4-a94ef7ec4db2`와 비교용 직접 생성 `181ab3d2-090b-4464-9224-fabfcb7b3716`를 `jobs_wait(timeout_seconds=0)`로 조회해 두 건 모두 completed 및 원본 URL 존재를 확인했다. 새 위젯이나 본문 이미지는 추가하지 않았다. 이 증거는 조회 접근만 확인하며 모바일·Claude 화면 성공을 뜻하지 않는다.
- 최초 배포 때 서버 콘솔과 사용자 앱에 이번 실행기/설정/API가 포함된 본체 업데이트가 한 번 필요하다. 그 뒤 동일 호환 경계의 `server.py` 변경은 별도 파일 배포로 설치할 수 있다. SDK·Python·실행기·백엔드 변경은 여전히 본체 업데이트 대상이다. 기존 연결 경로와 인증 프로필은 유지하며 실행 중 MCP는 다음 재연결에서 새 판을 사용한다.
- 후속 실설치 검증은 별도 승인 후 실제 PC에서 최초 도입→기존 등록 유지→독립 업데이트→재연결→롤백 순서로 수행한다. NAS 공유 잠금은 로컬 Windows 시험으로 보장하지 않으며 실제 공유 환경 시험이 필요하다. NAS 게시 포인터 손상은 안전하게 실패하지만 자동 복구 UI는 없으므로 원인 확인 후 정상 포인터 복원이 필요하다.
- 미확인/실패를 보존한다: 기존 서버 콘솔 ACL 시험 한 건 실패, 실제 Windows symlink 시험 한 건 권한 부족으로 건너뜀, 실제 설치본/NAS/운영 배포 및 클라이언트 화면 검증 미수행. 본체 업데이트에도 쓰이는 `_updater_lock_held` 수정은 격리 시험만 했고 실제 설치본의 업데이트 실행은 검증하지 않았다. 외부 위젯의 모바일 렌더링·단일 표시 교체는 호스트/플러그인 측 계약 확인이 필요하며 MV 코드만으로 완료할 수 있다고 단정하지 않는다.
- 마감 대조: 실제 Claude 설계 세션은 로컬 구현까지만 완료하고 외부 표시를 미해결로 남기는 보고에 조건부 동의했다. 상태·날짜·영수증 위치·통합 결과·기존 생성물 조회·실설치 한계를 명확히 하라는 문서 지적을 반영했다. SHA 재계산은 Codex 직접 확인이며 Claude는 이를 총괄 보고로 구분했다. 수정한 문장을 Claude가 다시 읽었다고 주장하지 않는다.

- 일회성 예약 정리: 결과 보고 후 앱 도구로 `zip-mcp`만 삭제했고 `deleteStatus=deleted`를 확인했다. 다른 예약·채팅은 변경하지 않았다.

프로젝트 문서: 구현·시험·미해결은 이 기록 하나에 보존한다. 볼트: 프로젝트에 결합된 내용이므로 옮기지 않는다.
