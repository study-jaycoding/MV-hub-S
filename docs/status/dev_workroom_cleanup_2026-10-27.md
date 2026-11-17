---
status: active
updated: 2026-10-27
---

# dev 중심 작업실 정리

owner: 아래 계약 참조 · reviewer: 별도 Codex `cleanup_independent_review` · status: 완료(로컬 전환·보관, 원격 Push 없음)

Jay가 2026-10-27 이 대화에서 필요한 변경과 DB를 안전하게 보관한 뒤 dev2·기존 통합 작업실 정리, dev를 최신 main으로 맞추기, dev 중심 운영 지침 변경을 승인했다. 오늘 23시까지 Claude 크레딧 제약으로 Codex만 작업한다는 기존 직접 지시를 적용했다. Claude 합의·리뷰를 수행했다고 기록하지 않는다. 이번 요청은 새 제품 변경·main Push·실제 서버 배포가 아니다.

```vibe-intent
{
  "schema": 1,
  "id": "dev-workroom-cleanup-20261027",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a15c4b-e564-7a21-bacc-89b4467f4b85"},
  "risk": {"level": "major", "reason": "작업실 보관 이동과 개발 운영 지침 변경. 사용자 데이터와 기존 작업 보존 필요"},
  "goal": "dev2와 기존 통합 작업실의 변경·DB·이력을 복구 가능하게 보관하고 dev를 최신 main 제품 코드 및 최신 로컬 운영안으로 정렬한다. 설치본·운영 서버·NAS·main 원격은 변경하지 않는다.",
  "touched_paths": ["AGENTS.md", "CLAUDE.md", "docs/WORKROOMS.md", "docs/AGENT_WORKFLOW.md", "docs/PR_GATE.md", "docs/README.md", "docs/TESTING.md", "docs/RISK_REDUCTION_PLAN_2026-08-15.md", "docs/CURRENT_STATUS.md", ".claude/agents/mvhub-design.md", ".claude/agents/mvhub-review.md", ".codex/agents/mvhub-implement.toml", ".codex/agents/mvhub-verify.toml"],
  "criteria": [
    {"id": "preserve", "success": "대상별 ZIP 파일 목록·해시 및 사용자 DB 복구 사본 검증, Git 이력 복구 확인, 원본 폴더 보관 후 HEAD·상태 보존", "failure": "필수 파일·DB 누락, 보관 검증 실패 또는 기존 작업 유실", "required": true, "verification": []},
    {"id": "align", "success": "dev HEAD를 확인한 origin/main 기준으로 만들고 제품 코드 차이 0, 이전 dev 이력·미커밋 변경 보관", "failure": "제품 코드 누락·기존 데이터 덮어쓰기·이전 이력 유실", "required": true, "verification": []},
    {"id": "workflow", "success": "지침 쌍 일치·dev 중심 흐름·Gate 유지·두 호스트 새 MCP 경로 일치·dev2 훅 등록 해제", "failure": "상시 통합 의무 잔존·배포 승인선 약화·기존 MCP 경로 단절", "required": true, "verification": []}
  ],
  "decisions": [
    {"choice": "원본 작업실은 같은 볼륨에서 폴더째 보관하고 별도 ZIP·Git·DB 사본을 둔다", "why": "미추적·무시 파일·읽기 제한 시험 폴더를 임의로 삭제하지 않고 복구 가능성을 유지", "alternative": "정리 직후 완전 삭제는 불필요한 데이터 유실 위험 때문에 제외", "revisit": "사용자가 보관 자료까지 삭제하기를 명시적으로 요청할 때"},
    {"choice": "이전 dev 브랜치를 보존 이름으로 남기고 최신 main에서 dev를 시작한다", "why": "과거 내용 병합으로 갈라진 220 대 115개 이력을 무리하게 다시 병합하지 않고 최신 제품 코드를 기준으로 정렬", "alternative": "강제 reset과 기존 변경 덮어쓰기는 제외", "revisit": "보관 이력에서 필요한 미반영 제품 수정이 발견될 때 별도 검토"},
    {"choice": "기존 MCP 경로는 보관 통합본을 가리키는 연결만 유지하고 새 설정은 dev로 변경", "why": "실행 중 프로세스의 옛 코드와 새 모듈이 섞이지 않도록 보호", "alternative": "다른 열린 세션의 MCP 일괄 강제 종료는 제외", "revisit": "기존 프로세스 종료·새 세션 재로드를 확인한 뒤 호환 연결 제거"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": []}
}
```

## 범위와 보관 위치

- dev2 및 `dev2-*` 39개와 기존 통합 1개가 대상이다. 다른 기능 작업실·고정 release·바탕화면 설치본은 유지한다.
- 보관·ZIP·Git 전체 사본·DB 사본: `D:\ClaudeCode\_archive\workrooms-20261027`.
- dev2 원본 폴더 보관: 위 경로의 `rooms`.
- 통합 원본 보관: `C:\Users\FX-PC06\.codex\worktree-archive\workrooms-20261027\mvhub-integration`.
- 실행·검증 기록: `D:\ClaudeCode\work\workspace-cleanup-20261027`.
- ZIP은 파일 내용을 보존하고 접합점을 따라가지 않는다. 재생성 가능한 캐시와 접근 거부된 시험 폴더는 ZIP 검사에서 제외되며 목록으로 기록한다. 원본 폴더는 통째 보관하여 해당 항목·원래 권한·대체 데이터 스트림을 유지한다. Git 잠금은 보관 등록의 우발적 제거 방지이며 파일 쓰기 차단이 아니다.
- dev의 `backend/data`·`backend/data_test`는 그대로 유지한다. DB·미디어를 main 코드로 덮어쓰지 않는다. SQLite 사본은 Backup API 및 quick_check로 확인한다. 외부 NAS 미디어는 이번 이동 대상이 아니다.

## 실행·검증 결과

### 보관과 전환

- dev2 계열 39개와 기존 통합 1개, 총 40개를 같은 볼륨의 보관 위치로 이동하고 Git 작업실 등록을 잠갔다. 40개 모두 이동 전후 HEAD·미커밋/미추적 상태·폴더 식별자가 같았다. 기존 dev2 경로는 남아 있지 않다. 원본의 영구 삭제는 하지 않았다.
- dev까지 포함한 41개 ZIP의 파일 215,949개를 파일 목록과 SHA-256으로 검증했다. SQLite Backup API 사본 225개는 모두 `quick_check=ok`다. Git 전체 사본 5,027개 파일은 원본 해시와 일치하며 연결 검사도 통과했다. `history.bundle`은 별도 checkout 없는 clone으로 복구하여 이전 dev 이력을 확인했다.
- 이전 dev HEAD `ea4a942b1a81bf09065c168a878ecc8d61b8ee85`는 `codex/archive-dev-20261027`에 보존했다. 기존 운영 문서 변경은 파일 백업 및 stash `21ef3839b5204d1047f93f36a40ca29ec4eb8066`에 보존했다.
- 새 dev HEAD는 확인한 원격 main `48af470988942f8233bda9a23822acf68c6cad2c`와 같다. 추적 중인 제품 코드 차이는 0이다. 기존 미추적 파일 925개를 유지했고, 사용자 DB·미디어는 초기화하지 않았다.
- main의 오래된 역할 설정으로 되돌아가지 않도록 Claude design·review, Codex implement·verify 역할 파일은 기존 dev의 최신 바이트를 보존했다. 기존 미추적 역할·기록도 유지했다. 이번 운영 변경은 dev의 로컬 변경으로 남아 있으며 커밋·원격 Push는 하지 않았다.

### 운영 연결

- 프로젝트 지침 쌍과 작업실·에이전트·PR·시험·위험 관리·현황·색인 문서를 dev 중심으로 맞췄다. 기본 dev 작업 → 관련 검사·리뷰 → 선택한 후보 PR → 명시적 main 승인·기존 Gate → 별도 배포 승인 순서를 유지한다.
- Codex `config.toml`과 Claude `.claude.json`의 `mvhub-test` 진입 파일만 dev로 변경했다. 기존 연결 URL·인증 프로필은 보존했다. 공통 `OPERATING.md`와 `hooks/guard.json`도 dev 중심으로 맞췄으며 훅 등록은 dev만 남겼다.
- 실행 중인 MCP가 사용하는 옛 통합 경로는 보관한 통합 원본을 가리키는 Junction으로 유지한다. 옛 코드에 dev의 새 모듈이 섞이지 않도록 한 임시 호환 연결이다. 두 주요 진입 파일의 기존 바이트를 확인했다. 기존 세션 종료·새 설정 재로드 확인 뒤 제거 여부를 판단한다.
- 유지하는 assets 작업실의 `frontend/node_modules` 연결은 보관된 dev2의 같은 의존성 폴더를 가리키도록 바꿨고 Vite 파일 접근을 확인했다. 옛 연결 자체는 `link-backups`에 보존했다.
- HF CLI 공식 업데이트 감시의 대상 안내만 설치본·dev로 정리했다. 일정·상태·알림 정책은 그대로다. 기존 dev2 관련 두 자동화의 일시정지 상태도 유지했다.

### 확인과 제한

- 전환 후 종합 검사 `postcheck.json`: 통과. 제품 변경 0, 기존 미추적 파일·역할 파일 보존, 두 호스트 새 경로·호환 연결·지침 쌍·훅 등록을 확인했다.
- 프런트 타입 검사·빌드, 문서 lint, 코드 지도 검사, 실제 index를 바꾸지 않은 별도 Git tree의 에이전트 지침 검사를 통과했다. 빌드의 큰 청크 경고와 `CURRENT_STATUS.md` 크기 예산 경고는 남아 있으며 이번 작업에서 관련 없는 재구성은 하지 않았다.
- 로컬 검색 색인을 갱신한 뒤 `graft check`에서 코드 연결 관계 일치를 확인했다(종료 0). 선택적인 deep 의미 요약은 만들지 않았다. 원시 결과는 실행 기록의 `graft-check.log`다.
- 새 MCP 진입 파일은 지정 Python으로 `--help` 실행에 성공했다. 작업 의도 기록은 공통 검사기의 `inspect`로 읽히는 것을 확인했다. 이는 두 모델 합의나 새 호스트의 실제 인증 연결 검증을 뜻하지 않는다.
- 접근 제한 항목 51개는 ZIP 내용 검사에서 제외했다. 원본 폴더와 권한은 유지했다. ZIP에는 재생성 캐시·접합점 대상이 포함되지 않으며 상세 제외 목록은 각 해시 manifest에 있다. 보관 경로는 이 PC의 로컬 디스크이며 별도 NAS 재해 복구 사본은 아니다.
- 최초 시도의 임시 중복 사본 `snapshots`와 `MV-hub-S-dev.incomplete`는 자동 승인 검사가 삭제를 차단하여 그대로 남겼다. 구체적인 차단 사유는 반환되지 않았다. 복구에는 검증된 41개 ZIP·원본 보관 폴더·DB 사본을 사용하고 이 임시 사본은 사용하지 않는다.
- 실제 제품 전체 회귀·부하 시험, 운영 서버/설치본 갱신, 기존 Claude·Codex 호스트 재시작·인증 요청은 수행하지 않았다. 새 dev를 자동 실행하거나 유료 생성을 호출하지 않았다.
- 기존 훅에 실제 세션 ID로 작업 기록을 연결했다. `CURRENT_STATUS.md` 첫 항목의 상태 한 줄을 검증 중에서 완료로 바꾸는 마감 편집은 훅이 현재 계약의 Claude·Codex 양측 합의를 요구하여 차단했다. 오늘 Codex만 사용하라는 직접 지시를 유지했고 훅을 우회·해제하지 않았다. 따라서 현황판의 진행 상태 문구만 이전 값이며, 보관·전환의 실제 결과는 이 상세 기록과 검증 파일을 따른다.

상세 근거는 실행 기록 폴더의 `ready-to-retire.json`, `postcheck.json`, `retired.json`, `dev-alignment.json`, `git-backup-verification.json`, `guidance-check.log`와 보관 폴더의 파일/DB manifest를 따른다.

## 복구 방법

1. 보관본의 당시 HEAD·파일 목록·ZIP 해시·DB 결과를 기록과 대조한다. 현재 dev나 운영 DB에 바로 덮어쓰지 않는다.
2. 코드 이력은 `history.bundle` 또는 `common-git` 보관 사본에서 별도 폴더로 복구한다. bundle의 dev 이력을 별도 checkout 없는 clone으로 읽는 시험을 수행한다.
3. 원본 작업실은 잠금을 해제한 뒤 비어 있는 별도 경로로 `git worktree move`하여 복구할 수 있다. 기존 경로가 사용 중이면 옮기지 않는다. 접합점 목록은 당시 원본 경로를 가리킬 수 있으므로 실행 전에 대조한다.
4. 사용자 DB는 `database-snapshots`의 검증된 사본과 ZIP의 미디어·설정을 격리 폴더에서 먼저 확인한다. 암호화된 연결 설정은 이 Windows 사용자 환경에 종속될 수 있다.

## 리뷰와 적용 범위

별도 Codex 사전 설계 및 독립 리뷰를 사용했다. 독립 리뷰의 MCP 전환 유예 문구, 대상별 백업 검증, 실패 시 낡은 통과 영수증 무효화 지적을 반영했다. 전환 후 같은 독립 리뷰어가 이력·설정·보관 결과를 확인하고 승인했다. 백업·DB 검증은 리뷰어의 재실행이 아닌 실행 로그를 근거로 했으며 MCP 실제 요청·기존 세션 재로드는 승인 범위가 아니다. 실제 호스트 훅이 Claude 합의를 승인했다고 주장하지 않는다.

`ponytail`을 읽고 적용했다. dev 기준 코드가 바뀌었으므로 프런트 빌드와 로컬 검색 색인을 갱신했다. 제품 전체 시험·부하 시험은 새로 실행하지 않았다. 최신 main의 제품 검증 결과와 이번 파일/DB 보관·운영 지침 검증을 구분한다. 볼트에는 프로젝트 전용 작업 이력을 복사하지 않는다.

## 후속 승인: 남은 MV Hub 작업실 29개 정리

owner: Codex 총괄 · reviewer: 별도 Codex 독립 리뷰 · status: 완료(29개 보관·후속 검사·독립 리뷰 승인) · updated: 2026-10-27

### 사용자 요청과 범위

Jay의 직접 요청: dev·release·공용 Git·MV-w를 그대로 두고 나머지를 정리한다. dev에 빠진 변경을 확인하고 필요한 변경과 DB를 보관하며 진행사항을 문서에 남긴다. 위 `vibe-intent`는 앞선 dev2·통합 정리의 이력이며, 이 후속 범위는 아래 확정 목록과 실행 기록으로 구분한다. 제품 자동 병합·커밋·원격 Push·배포·기존 세션 종료·추가 운영 정책 변경은 하지 않는다.

- 유지: `D:\ClaudeCode\MV-hub-S-dev`, `MV-hub-S-release`, `MV-hub-S.git`, `MV-w`. 공용 Git의 이력·참조를 유지하며 작업실 이동에 필요한 등록 경로만 갱신한다.
- 대상: `console`, `dev-backup-before-dev2-20261021`, `drift`, `old1358-1021`, `rel-20261026`, `verify-1020`, `ws`, `wt-11a`, `wt-14a`, `wt-assets`, `wt-cut`, `wt-edit7`, `wt-gate`, `wt-mcp-release`, `wt-names`, `wt-r81a`, `wt-r81b`, `wt-r81c`, `wt-r81d`, `wt-r82a`, `wt-r83f`, `wt-r83o`, `wt-r83s`, `wt-r84a`, `wt-r84b`, `wt-r84c`, `wt-r84x`, `wt-rsv`, `wt-tlx` (모두 `MV-hub-S-` 접두사).
- 실행 기록: `D:\ClaudeCode\work\workspace-cleanup-remaining-20261027`.
- 보관 위치: `D:\ClaudeCode\_archive\workrooms-20261027\remaining`. 원본은 `rooms` 아래에 폴더째 이동하고, ZIP·파일 해시·SQLite 사본·Git bundle을 별도로 검증한다. 보관은 로컬 디스크이며 원본·사용자 DB의 영구 삭제는 하지 않는다.
- 명령줄을 확인한 Python/Node 실행은 dev 경로만 사용했고, 유지할 세 폴더의 조사 대상 링크에서 정리 대상 의존성은 발견하지 못했다. Windows 예약 작업 조회에서도 대상 경로를 찾지 못했다. 모든 열린 파일 핸들을 확인했다는 뜻은 아니다.

### dev 누락 확인

기준은 `48af470988942f8233bda9a23822acf68c6cad2c`. 아래 내용 대조는 명시적으로 위임한 별도 Codex 조사 결과이며, 파일·DB 보관 검증은 총괄이 직접 실행한다.

| 대상 | 판정·근거 | 처리 |
|---|---|---|
| wt-11a·wt-14a·wt-names의 고유 커밋 | stable patch-id로 dev의 같은 변경을 확인 | 원본 보관, 중복 병합 없음 |
| wt-r84a·wt-r84x의 409 고침 | dev `4b164fb2`와 후속 코드·시험으로 대체 | 원본·옛 인계 문서 보관 |
| wt-r83o `edc3afff`·wt-r84b `74a91ab5` | **작성자 보호 B는 실제 미반영, 끝 커밋은 미검증 WIP**. dev `8e615e8d`와 [기존 결정](dev2_대체검토_2026-10-21.md)에 전체 제외·신원 연결 최소 차단만 포함했다고 기록됨 | 브랜치·전체 원본·패치 보존. 채택하려면 현재 공유·권한·DB 구조로 새 검토 필요 |
| wt-assets의 미커밋 드래그 | dev의 분리 OLE 프로세스·취소·소스창 확인 등 후속 구현이 있음 | 패치·manifest·시험 baseline과 로그까지 보존 |
| verify-1020 | dev와 동일한 파일, 후속 변경과 다른 구판, 런타임 번들이 섞임 | 모든 원본·ZIP 보존. 차이 전체의 기능 동등성을 주장하지 않음 |
| wt-edit7 | Git 없는 구판. BackupReplica 화면/API/시험 3개는 [관리 창 전환 결정](서버관리창_설계_2026-10-23.md)에 따라 dev에서 삭제됨 | 원본 보관, 구판 복원 없음 |
| wt-names의 미추적 파일 | measure-shot 시안 및 빌드 산출물 | 시안도 함께 보관 |

### 진행과 완료 조건

1. 확정 대상 29개를 조사했다. 백업 대상 일반 파일 87,662개·3,978,573,565바이트, 접근 제한 시험 폴더 2개를 기록했다. 캐시와 접합점은 ZIP에서 제외하고 원본 폴더 이동으로 보존한다.
2. 파일별 ZIP 내용·해시, SQLite 사본의 quick_check, Git bundle에서 각 HEAD 복구 가능성을 확인한 뒤 이동한다.
3. 이동 전후 Git HEAD·작업 상태·폴더 식별자를 비교하고, 유지한 네 폴더의 위치·이력·제품 변경을 확인한다. 최종 결과는 이 절에 이어서 기록한다.

보관 전 독립 Codex 리뷰는 실제 `ready.json=passed` 및 검증 명령 종료 0 확인을 조건으로 승인했다. 원본·ZIP·DB·Git 검사, 이동 범위, 접합점/기존 목적지 거부, 실행 중 경로 확인과 구문을 검토했으며 전체 백업을 중복 실행하지 않았다.

기존 경로 관련 참고: 앱에 저장된 `MV-hub-S-wt-mcp-release` 프로젝트 항목은 예전 작업실을 가리킨다. 보관 후 새 개발에는 `MV-hub-S-dev`를 사용한다. 바탕화면·루트 바로가기 조사에서는 이번 29개를 참조하는 링크를 찾지 못했지만, 앞서 보관한 dev2를 가리키는 `test_dev.bat.lnk`와 `test_dev2_safe.lnk`가 남아 있다. dev를 가리키는 `test_dev.lnk`도 확인했다. 이번 정리에서 앱 프로젝트 목록·바로가기·기존 세션 설정은 변경하지 않는다.

### 후속 실행 결과

- 29개 모두 `remaining\rooms` 아래로 이동했다. Git 작업실 25개는 등록 경로를 갱신하고 잠갔으며, 일반 폴더 4개(이전 DB 백업·빈 폴더 2개·edit7 잔재)는 원본째 옮겼다. 빈 폴더도 영구 삭제하지 않았다.
- `D:\ClaudeCode`의 이번 분류 대상에는 `MV-hub-S-dev`, `MV-hub-S-release`, `MV-hub-S.git`, `MV-w`만 남았다. 다른 프로젝트와 앞서 만든 보관함은 이 범위가 아니다.
- ZIP 29개·일반 파일 87,662개(3,978,573,565바이트)의 내용을 원본 및 SHA-256과 대조했다. 사용자 DB와 시험 자료의 SQLite 사본 총 155개는 모두 quick_check 통과. Git bundle을 별도 bare 저장소로 복구하여 대상 작업실 HEAD 25개를 읽을 수 있음을 확인했다.
- 후속 `postcheck.json` 통과: 29개 폴더 식별자 유지, 이동 전후 파일 목록·크기·수정시각 대조, 접합점·접근 제한 항목 유지, 25개 HEAD·작업 상태 유지, 공용 Git 참조 불변, dev·release의 추적 코드 해시 불변, 유지 폴더 4개 식별자 불변.
- Git 이동이 `.git` 포인터 25개의 수정시각을 갱신했다. 이 25개는 내용 해시가 백업과 같은지 별도로 확인했으며, 나머지 일반 파일은 수정시각도 대조했다. SQLite의 임시 WAL/SHM 파일은 시각 대조 대신 보관 원본과 검증된 DB 사본을 기준으로 했다.
- 작성자 보호 B의 두 기준 SHA는 `unmerged-candidates/r83-owner` 및 `r84-owner-wip`에 기준·패치·커밋 목록을 추가로 보존했다. dev에 자동 적용하지 않았으며 기존 보류 결정을 유지했다. 나머지 비일치 구판·시안·시험 자료도 원본/ZIP으로 보존했다.
- 실행 중 PowerShell 5의 JSON 배열/표준 오류 처리 차이로 이동 전 검사가 멈춘 부분을 수정하고 실제 종료 코드를 검사했다. 간헐적 접근 거부는 원본 존재·목적지 부재를 확인한 뒤에만 최대 3회 재시도했다. 다른 계정 소유의 옛 작업실은 원본 식별자와 Git 포인터 바이트를 확인하고 해당 보관 경로를 명령 단위로만 신뢰하여 읽었다. 전역 Git 신뢰 설정과 원래 ACL은 변경하지 않았다.
- 접근 제한 시험 폴더 2개는 내부를 읽거나 권한을 바꾸지 않았다. 원본 폴더 이동으로 보존했으며, 그 내부 파일의 해시 검증을 통과했다고 주장하지 않는다. 보관 자료는 로컬 디스크이며 별도 장치의 재해 복구 사본은 아니다.
- 제품 파일 수정·기능 실행 시험·DB 초기화/마이그레이션·커밋·Push·main 병합·서버/설치본 갱신은 하지 않았다. 이번 검증은 파일·DB 보관과 작업실 정리의 검증이다.
- 별도 Codex `cleanup_independent_review`가 이동된 경로와 유지 대상, 검사기와 후속 검사 결과를 읽고 최종 승인했다. 백업/DB 검증은 실행 로그 근거이며 독립 리뷰어가 다시 실행하지 않았다. 문서 lint도 통과했고 기존 CURRENT_STATUS 크기 예산 경고만 남아 있다.

후속 복구: `remaining/rooms/<옛 이름>` 또는 같은 이름의 ZIP과 해시 manifest를 확인한다. Git 작업실은 보관 잠금을 해제한 뒤 비어 있는 경로로 옮기고, 일반 폴더는 폴더째 복원한다. Git 등록이 없으면 `remaining/history.bundle`을 별도 폴더에 복구하고 필요한 변경을 선택한다. DB는 `remaining/database-snapshots`와 원본 미디어를 별도 격리 경로에서 먼저 대조한다. 현재 dev나 실행 중 DB 위에 통째로 덮어쓰지 않는다.
