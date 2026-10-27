---
status: active
updated: 2026-10-28
---

# 23:10 예약 개선 작업

요청 근거: 전용 채팅 `01a17c80-70de-7b12-a1b3-db66f4672df6`의 사용자 승인 인계 및 `mv-hub` 예약 heartbeat. owner·touched_paths·완료 조건은 아래 계약을 정본으로 한다. 작업 status: 완료(dev 승인 범위). 실제 Claude 설계 합의·비구현자 독립 리뷰·격리 검증 후 dev 런타임 전환 및 현재 계정의 허용된 장부 반영을 마쳤다. 실제 유료 생성과 운영 배포는 수행하지 않았다. 아래 중간 단계 기록은 해당 시점의 이력이며 최신 결과는 마지막 절을 따른다.

승인 범위는 CLI 1.2.3, 가격 12시간 캐시, 실제 크레딧 매칭과 현재 계정 10건 검증, 모델 옵션 최신화, 선택 과금 공간 잔액 갱신, Host 콘솔 오류 안내, 이미지 수정 위치/이름 변경, draw_to_video 영상 수정, 내레이션 오디오 생성, 서버 기준/실제 앱 CLI 버전 표시, 참조 제출/관측 대조·기록, 생성 중 업데이트 및 재시작 복구다. 전체 요구는 원본 채팅과 예약 인계를 따르며 현재 계약은 이 전체 범위를 포함한다. 아래 최초 중단 기록은 그 시점의 이력으로 보존한다.

보호 범위: 기존 다른 세션 변경, 사용자 데이터, 확정 장부, 과거 견적, 참조 입력 순서/역할/파일명, 기존 실행 정책. 운영 설치본·공유 서버·NAS 변경, 유료 생성, 임의 거래 연결/환불 연결, 생성 전 hover 팝업, 상시 갱신 배지는 제외한다. Claude 불가 시 단독 우회하지 않는다. 앱 재시작은 진행 중 작업과 승인 범위를 확인한 뒤 판단한다.

```vibe-intent
{
  "schema": 1,
  "id": "hf-improvements-20261027-cli",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {
    "host": "codex",
    "session": "01a17c80-70de-7b12-a1b3-db66f4672df6"
  },
  "risk": {
    "level": "major",
    "reason": "공식 CLI 전환, 금액 연결, 생성·참조 증거 및 업데이트 복구의 다중 경계 변경"
  },
  "goal": "2026-10-28 사용자의 공식 실행 파일 사용 승인으로 재개한다. 공식 Windows v1.2.3 아카이브·공개 digest·checksums를 검증하고 dev 전용 .mvhub-runtime/higgsfield/higgsfield.exe를 직접 실행한다. npm manifest 버전을 위조하지 않고 전역 CLI·운영 설치본·서버·NAS·사용 데이터·진행 작업을 보존한다. pin은 독립 리뷰와 안전 확인 뒤 로컬 dev 검증에만 적용하며 커밋·main·배포 후보·작업자 배포에 포함하지 않는다. 배포 범위로 전환하려면 별도 설치 계약과 합의가 필요하다. 후속 승인 11개 범위는 원본 인계에 보존하고 순차 합의·구현한다. 유료 생성·배포는 제외한다. 현재 계약을 사용자 승인 전체 12개로 확장한다. 기존 가격/옵션/잔액/콘솔/버전 구현을 보존하고 아래 미디어·참조·거래·업데이트 조건을 Claude 실제 설계와 합의하여 구현한다. 기존 다른 세션 변경은 합의된 파일에서도 보존한다.",
  "touched_paths": [
    "hf_cli_version.txt",
    "MV_agent.bat",
    "tools/hf_cli_contract_smoke.py",
    "backend/tests/test_native_cli_launcher.py",
    "docs/HF_CLI_UPGRADE.md",
    ".mvhub-runtime/higgsfield/higgsfield.exe",
    ".mvhub-runtime/higgsfield/hf_1.2.3_windows_amd64.tar.gz",
    ".mvhub-runtime/higgsfield/checksums.txt",
    "backend/app/services/cli_bridge.py",
    "backend/app/routers/generation.py",
    "backend/tests/test_metadata_refresh.py",
    "backend/tests/test_cli_bridge_contract.py",
    "frontend/src/lib/useModels.ts",
    "frontend/src/api.ts",
    "frontend/src/types.ts",
    "frontend/tests/modelMetadataRefresh.test.tsx",
    "backend/app/main.py",
    "backend/app/routers/console.py",
    "backend/app/routers/ingest.py",
    "backend/tests/test_credit_balance_refresh.py",
    "backend/tests/test_console_panel.py",
    "frontend/src/lib/useAccountStatus.ts",
    "frontend/src/components/AccountMenu.tsx",
    "frontend/src/lib/appEvents.ts",
    "frontend/src/lib/progressSocket.ts",
    "frontend/tests/accountCreditsRefresh.test.tsx",
    "frontend/tests/cliVersionSources.test.tsx",
    "backend/app/models.py",
    "backend/app/services/media_types.py",
    "backend/app/services/mcp_ingest.py",
    "backend/app/usecases/gen_requests.py",
    "backend/app/routers/gen_requests.py",
    "backend/app/repo/gen_requests.py",
    "backend/app/repo/generation_sync.py",
    "backend/app/repo/manage_transactions.py",
    "backend/app/usecases/generation_media_cache.py",
    "backend/app/services/release_update.py",
    "backend/app/services/operational_health.py",
    "backend/app/services/update_activity.py",
    "backend/app/routers/release_update.py",
    "agent_push.py",
    "frontend/src/components/SpotlightPrompt.tsx",
    "frontend/src/components/spotlight/SpotlightOptionsBar.tsx",
    "frontend/src/components/spotlight/SpotlightGenerateControls.tsx",
    "frontend/src/components/spotlight/useSpotlightSubmit.ts",
    "frontend/src/lib/spotlightSubmit.ts",
    "frontend/src/components/InfoPopup.tsx",
    "frontend/src/components/edit/PartialEditHost.tsx",
    "frontend/src/components/edit/PartialEditModal.tsx",
    "frontend/src/components/MediaPreview.tsx",
    "frontend/src/components/MediaThumbnail.tsx",
    "frontend/src/components/GenerationCard.tsx",
    "frontend/src/components/scene/cards/GenerationCard.tsx",
    "frontend/src/components/scene/SceneModelModal.tsx",
    "frontend/src/components/compare/CompareSourceLightbox.tsx",
    "frontend/src/styles/partial-edit.css",
    "frontend/src/lib/releaseUpdate.ts",
    "frontend/src/components/settings/SettingsSections.tsx",
    "backend/tests/test_generation_audio.py",
    "backend/tests/test_draw_to_video.py",
    "backend/tests/test_reference_observation.py",
    "backend/tests/test_update_recovery_checkpoint.py",
    "backend/tests/test_transaction_matching_safety.py",
    "backend/tests/test_agent_contracts.py",
    "backend/tests/test_asset_provenance.py",
    "backend/tests/test_generation_state_engine.py",
    "backend/tests/test_agent_post_submit_persistence.py",
    "backend/tests/test_generation_media_cache.py",
    "backend/tests/test_release_update.py",
    "backend/tests/test_operational_health.py",
    "frontend/tests/mediaGeneration.test.tsx",
    "frontend/tests/videoEdit.test.tsx",
    "backend/data_test/db/content_hub.db",
    "backend/data_test/db/manage_hub.db",
    "frontend/src/components/timeline/EditTab.tsx",
    "frontend/src/components/timeline/useSourcePane.ts",
    "frontend/src/components/history/HistoryBoardNode.tsx",
    "backend/tests/test_generation_sync.py",
    "backend/tests/credit_matching_mutation_check.py",
    "backend/tests/test_release_update_state_gate.py",
    "frontend/tests/releaseUpdate.test.ts",
    "docs/CODE_MAP.md",
    "docs/inventory/endpoints.md",
    "docs/inventory/env_vars.md",
    "docs/README.md",
    "docs/CURRENT_STATUS.md",
    "docs/inventory/db_tables.md",
    "docs/inventory/background_jobs.md",
    "backend/app/services/media_preservation.py",
    "backend/app/repo/media_preservation.py",
    "backend/tests/test_media_preservation.py",
    "frontend/src/components/manage/CreditPlanFields.tsx",
    "backend/tests/test_release_update_state_writer.py",
    "backend/tests/test_comfy_update_registration.py"
  ],
  "criteria": [
    {
      "id": "official",
      "success": "공식 릴리스·태그·Windows 아카이브 digest와 checksums를 교차 확인하고 후보 실행 파일 version=1.2.3; npm은 배치 대상 아님",
      "failure": "공식 자산 누락·digest 불일치·실제 버전 불일치",
      "required": true,
      "verification": [
        "89742dd5d4454840bdf9a14841301f09"
      ]
    },
    {
      "id": "contract",
      "success": "실제 앱의 direct exe 경로와 동일한 후보로 비과금 CLI 계약 스모크 및 모델/워크플로/음성/비용/상태/인증 관련 확인; 지원 계약과 미지원 범위 구분",
      "failure": "다른 CLI로 시험·계약 불일치 은폐·유료 생성",
      "required": true,
      "verification": [
        "870281c9e6cd4465a47212181586c0ce"
      ]
    },
    {
      "id": "isolation",
      "success": "버전이 맞는 기존 runtime 번들→dev 전용 exe→전역 순으로 선택하고 dev exe 선택 시 그 폴더를 PATH 맨 앞에 추가하여 cli_bridge.cli_path와 agent가 같은 exe를 가리킴을 회귀 확인; 후보 검증은 pin 변경 없이 가능; 기존 pin/실행경로 시험 및 새 회귀 통과; 전역 CLI 불변; 진행 작업이 있으면 적용 재시작 보류",
      "failure": "다른 앱 CLI 교체·진행 작업 중단·검증 전 사용자 데이터 변경·검증 전 pin 교체·로컬 pin의 배포 후보 편입·백엔드/agent 실행 파일 불일치",
      "required": true,
      "verification": [
        "603ae9504692429582eaa49142f5ca13"
      ]
    },
    {
      "id": "prices",
      "success": "가격 TTL 기본12시간. 공개 견적은 기존값+실제저장시각+stale을 즉시 반환하고 단일 background 갱신. fresh 요청은 같은 갱신 완료를 기다림. 내부 제출 견적은 기존 fresh대기 유지. 프런트도 저장시각으로만 TTL판정하고 stale응답 후 fresh조회로 현재선택에 새값 반영. 실패시 기존값/시각 유지, 중복조회/오래된응답 차단. 과거견적/장부 불변",
      "failure": "가격표갱신으로 과거견적변경·0원위조·실패시각갱신·옵션전환응답오염·종료후 background잔류",
      "required": true,
      "verification": [
        "ac8520bcaaa3469280acb6237ac9afc2"
      ]
    },
    {
      "id": "schemas",
      "success": "모델스키마 TTL1시간. 기존스키마 즉시표시 뒤 단일갱신, 허용파라미터명도 성공스키마에맞춰갱신. 같은모델 배경갱신은 사용자모델/값 보존. 무효/사라진값은 기존오류흐름으로 알리고 조용히삭제/기본값대체하지않음. 무효값이 남으면 paramsError 및 paramsModel 정합을 깨서 기존 제출·저장 게이트로 차단하고 이를 회귀시험. 사용자가 유효값으로 수정하면 다시 허용. 새모델자동노출/이름덮기/배지추가없음",
      "failure": "기존선택초기화·빈스키마로덮기·실패캐시·허용이름영구캐시·동적옵션자동보정이사용자값변경·보존한무효값이제출때소리없이빠짐",
      "required": true,
      "verification": [
        "af891f8a30b04acd9b03e4999fa2bd70"
      ]
    },
    {
      "id": "balances",
      "success": "실제 생성 완료와 거래 저장/매칭 완료에만 기존 계정범위 WS를 통해 잔액 갱신 신호. 일반 polling tick은 제외. 현재 선택공간 잔액을 공급자에게 조회하여 기존 숫자만 변경. 계정/공간 key·요청세대로 늦은응답 거부, 동시조회 합류, 실패하면 이전숫자 보존. 잔액차이로 개별비용 확정하지 않음",
      "failure": "다른공간/계정의 늦은값 표시·조회폭주·추측잔액·새배지/시간/상자",
      "required": true,
      "verification": [
        "3290c1b3f41a4e379b3e39ff45f09386"
      ]
    },
    {
      "id": "console_errors",
      "success": "CLI 로그인/권한/통신/형식 오류와 정상빈목록 구분. upstream 오류는 안전한코드/행동만 Host로그로 기록, workspace실패를빈성공으로반환하지않음. HF로그인실패로Hub로그아웃을유도하는401오용없음. 기존account응답호환유지",
      "failure": "비밀값출력·오류를빈성공으로숨김·추가팝업/하단설명상자·Hub와HF인증혼동",
      "required": true,
      "verification": [
        "de258b0857844bf5a9f6571f0f5219ea"
      ]
    },
    {
      "id": "cli_versions",
      "success": "기존 내계정 CLI 행을 서버요구버전 (기준) / 실제로컬CLI version결과 (앱)으로 표시. main cli-check는 기존판정변경없이 required필드추가, 연결된서버요구만사용하고 공유서버본체는자기pin이서버기준. console은로컬요청전용+local_worker여부와제한시간/캐시/실패null인실제version제공. 조회불가 확인안됨, 타PC보고값/앱버전/로컬pin을실제버전으로대체하지않음",
      "failure": "출처혼동·추가생성차단정책·오래된계정응답표시·조회실패를pin으로가장",
      "required": true,
      "verification": [
        "2531356a0d7340788592a1271d7d72a7"
      ]
    },
    {
      "id": "media",
      "success": "공식 workflow draw_to_video와 text2speech_v2만 최소 추가. 기존 create/regenerate 요청과 계정·과금공간·프로젝트/컷·idempotency·정책·원본계보를 재사용. draw_to_video는 영상1개+주석그림 정확1장, 공식 video/image_references flags로 보내고 선택시점은 그림·설명에 기록(없는 timestamp flag 금지). 비용은 실제duration/resolution과12h정책. Audio는 공식스키마/voices list/get 기반 preset만, prompt길이 및 variant/voice 필수값 검증, 실제음성호환 유료미검증을 명시. audio는 파싱·저장·캐시·카드·상세·재생/다운로드 끝까지 지원, 자동재생없음. 구버전agent에는 media-v2 capability로 새요청만 보이지 않게 하며 기존요청유지.",
      "failure": "가짜모델/가격/voice·0원위조·워크플로를model명령에전송·오디오를image로저장·다른프로젝트/공간귀속·구agent오실행·새정책면제",
      "required": true,
      "verification": [
        "c670f857d7264c798db5804d59db1520"
      ]
    },
    {
      "id": "edit_ui",
      "success": "상단 부분수정 제거, 기존 ZIP 자리의 이미지수정/영상수정 두버튼을 나란히 표시하며 미디어에 맞는 동작만 활성화. 기존 히스토리/캔버스/닫기 및 다른 ZIP호출 보존. 이미지수정 seedream_v5_pro와 도구/안전/원본비교 유지. 같은 편집UI에 원본영상 프레임시점선택 및 그림1장전송 추가. 원본덮기없음. Audio진입은 기존 Image/Video 흐름에 추가, 새hover팝업/배지없음.",
      "failure": "기존그림도구손실·원본변경·영상없이수정·중복부분수정버튼·파일삭제·배지/새최종확인팝업",
      "required": true,
      "verification": [
        "1c9bf229759346e0a804e121c0049f0d"
      ]
    },
    {
      "id": "references",
      "success": "기존 submission_fingerprint/ref_digests/gen_reference 재사용. 제출 references 위치·종류·역할·파일지문/검증ID 및 실제CLI인자순서와 raw generate-get 관측순서를 별도저장. 사용자순서/과거값 불변. upload/media ID 또는 실제hash 근거만 동일성판정, 개수/위치 또는 재정렬값을 독립근거로사용금지. missing/replaced/duplicate/반환순서차이/확인불가 구분. 정보없음은 실패아님. 결과차단/재생성금지, Host콘솔. fulfill/reconcile 반복에서멱등.",
      "failure": "기존입력순서변경·array순서를모델적용순서로단정·미확인실패화·URL/비밀복제·과거대량보정·개수만같다고share_url연결",
      "required": true,
      "verification": [
        "1591036a529945eea600ebd13f9ba522"
      ]
    },
    {
      "id": "ledger",
      "success": "검증별칭과 표시명으로 후보모델군 분리하되 계정·시각·거래증거도 함께사용. 모든 최대매칭에서 거래ID가 유일한 경우만 기존 transaction 확정; 금액만 일정하고 ID가모호한 경우 후보금액으로구분하며 이번에는 장부미확정으로유지. 환불/여분/기확정거래 재사용금지. 현재계정 대상10건은 최신확인+SQLite일관백업+복제본dryrun+비구현독립리뷰 뒤만 실제반영, 다른건이같은후보요소에들면건드리지않음. 실제반영직전 입력재검증/CAS, 기존telemetry/fact경로재사용.",
      "failure": "임의ID연결·환불연결·후보금액을실제로표시·확정882건변경·다른계정/대상외수정·재실행중복·백업없는실제쓰기",
      "required": true,
      "verification": [
        "ee24fe3e7ec74a23b3ba98b562f11db2"
      ]
    },
    {
      "id": "update_recovery",
      "success": "normal update checking으로 신규claim/submit차단 후 두번째활동검사. confirmed remote job anchor와 계정/허브/공간/rid/gen/job를 같은DB snapshot에서 app_setting checkpoint로영속(기존미해결보존), 저장실패시차단. remote accepted tracking/running은checkpoint확보시업데이트허용. 전송중/응답불명/로컬쓰기와Comfy/Resolve는계속보호, 오래된상태만으로무기한차단하지않고 기존recovery_required근거보존. 새 endpoint로기존reconcile-candidates list유지하며 startup에는저장된동일계정/허브job만 기존get/reconcile로먼저복구, 자동재제출/전체이력조회없음. 실제같은job완료및결과저장확인후만checkpoint정리; 진행/조회실패/실패롤백보존. 로컬reconcile/cache쓰기에는counter+checking검사배리어로경합차단. 기존업데이트단일실행/원자성/복귀불변.",
      "failure": "force일반버튼연결·상수제거만함·영속실패강행·저장대상미소비·결과저장전삭제·다른허브조회·submit재시도중복과금·Comfy/Resolve보호제거",
      "required": true,
      "verification": [
        "85a1c05e9d3648fc9e75247581e326b0"
      ]
    }
  ],
  "decisions": [
    {
      "choice": "공식 exe를 기존 git 제외 폴더 .mvhub-runtime에 배치하고 런처의 버전 일치 선택을 재사용",
      "why": "사용자가 공식 실행 파일 사용을 승인했고 기존 cli_bridge와 agent는 exe 직접 실행을 지원",
      "alternative": "1.2.2 npm wrapper에 1.2.3 바이너리를 섞거나 전역 설치를 교체하지 않음",
      "revisit": "공식 exe의 필요한 계약이 실패하거나 기존 실행 경로를 보존할 수 없을 때"
    },
    {
      "choice": "금액만확정 가능한 모호한 거래는 이번에 실제장부확정하지 않고 후보금액/ID불명확으로 구분",
      "why": "동일금액의 여분10지출/9생성 및환불로 개별ID증거없음; 임의연결과중복계산방지",
      "alternative": "새그룹예약원장/워터마크엔진은 현재증거로정당화되지않아추가하지않음",
      "revisit": "공식request/job거래ID 또는 완전성증거가추가될때"
    },
    {
      "choice": "독립 리뷰의 미디어/업데이트 경계 수정",
      "why": "새workflow의 확인되지 않은 반환모양으로 정상결과를실패시키지않고, extension없는TTS는모델근거audio, 표준허용목록편집에새모델2개추가, 그림있으면프레임전환잠금, 새video는현재옵션성공견적만제출, 캐시최대치시가장오래된1개만축출, 일시조회실패의기존계정정보보존",
      "alternative": "유료스모크/새팝업/정책면제/InfoPopup밖ZIP버튼신설/미확인기록자동삭제는하지않음",
      "revisit": "공식workflow결과참조계약또는추가사용자요구가확인될때"
    }
  ],
  "evidence": {
    "target": {
      "kind": "worktree"
    },
    "consensus": [
      {
        "host": "codex",
        "session": "01a17c80-70de-7b12-a1b3-db66f4672df6",
        "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/10/27/rollout-2026-10-27T17-35-54-01a17c80-70de-7b12-a1b3-db66f4672df6.jsonl"
      },
      {
        "host": "claude",
        "session": "ec5d1d08-2f62-4978-a623-ef38bb421194",
        "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/ec5d1d08-2f62-4978-a623-ef38bb421194.jsonl"
      }
    ],
    "design_sessions": [
      {
        "host": "claude",
        "session": "e0e051f5-287a-4b0a-8b8c-1775df4cdb70"
      },
      {
        "host": "claude",
        "session": "ec5d1d08-2f62-4978-a623-ef38bb421194"
      },
      {
        "host": "claude",
        "session": "a3eb2f58-f587-4092-9b6f-9cde7f557fc0"
      },
      {
        "host": "claude",
        "session": "134c8a9b-9fab-4116-b977-a8cde41cc136"
      },
      {
        "host": "claude",
        "session": "1edee66d-a911-4af9-aeb9-54b32b3349f0"
      },
      {
        "host": "claude",
        "session": "d0fb1204-45b0-4fa7-9911-d3ea2b951c8d"
      }
    ],
    "review": {
      "host": "claude",
      "session": "6c35d307-a284-48e6-82fb-9624bbc3f6fa",
      "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/6c35d307-a284-48e6-82fb-9624bbc3f6fa.jsonl"
    }
  }
}
```

## 시작 확인

- Git 루트는 dev이며 운영 문서/역할 설정 등의 기존 수정과 work 산출물이 있다. 기존 변경은 보존한다.
- 등록된 mvhub_test 연결의 check_connection 및 connect 성공. 연결은 계정 범위이며 실제 계정/DB 귀속은 추가 확인 전이다.
- 실제 Claude `mvhub-design` 가용성 호출 성공: session `e0e051f5-287a-4b0a-8b8c-1775df4cdb70`, 요청 opus/medium, 응답 메타데이터 `claude-opus-5-5`. 설계·합의 성공으로 간주하지 않는다.
- Ponytail 스킬을 읽었다. 코드 변경 전이므로 아직 graft 및 제품 시험을 실행하지 않았다.

## 실행 결과와 중단 근거

2026-10-27 23:13~23:16 KST 확인. 구현 완료나 공동 합의 완료가 아니다.

| 확인 | 직접 관측한 결과 |
|---|---|
| [공식 GitHub 릴리스](https://github.com/higgsfield-ai/cli/releases/tag/v1.2.3) | 정식 v1.2.3 존재, 본문은 공백. Windows amd64 자산 7,443,013 bytes, 공개 digest `e24690776f1d438194702d1108f7f0587824023fac497c3792dfa40352fac5fd` |
| 공식 태그 v1.2.2 / v1.2.3 | 두 태그가 commit `fd21e7cb550b5835cc00c6b4abfea0c02fe77ff2`를 가리킴. 바이너리 동작 동일의 증거는 아님 |
| npm 정확 버전 조회 | `npm.cmd view @higgsfield/cli@1.2.3 version dist.tarball dist.integrity --registry=https://registry.npmjs.org --json` → E404 |
| [공식 npm registry API](https://registry.npmjs.org/@higgsfield%2fcli) 직접 조회 | `versions`에 1.2.3 없음, 1.2.2 있음, `dist-tags.latest=1.2.2`. `/1.2.3` 직접 HTTP 조회도 404. 로컬 npm 캐시 문제로만 판단하지 않음 |
| 현재 pin / 설치 package.json / 실제 wrapper 실행 | 모두 1.2.2. node+JS의 실제 `version` 출력 build `53301eadf7311fc6a6a4c024cf4aff432028e974` |
| 지침 쌍 | 프로젝트 소개 문구를 제외한 본문 동일, 전역 공통 블록 이후 본문 동일. 지침 수정 없음 |
| 의도 계약 | inspect 성공, 계약 SHA `d3056449f04d0ff38c25f77eddbfcd2a28de85e198e1aac17644b5d3d9968ceb`; 실제 훅 세션에 bind 성공. 합의/구현/integrate 통과를 뜻하지 않음 |
| 코드 지도 | `python tools/check_code_map.py` 통과: 문서상 누락·없는 코드 경로 각 0 |

사용자 인계의 “공식 배포 검증 실패 시 실사용 경로를 덮어쓰지 말고 구체적인 근거와 미완료 범위를 보고” 및 “업그레이드 검증을 선행하고 통과하면 나머지 작업 수행” 조건을 적용했다. 1.2.2 패키지의 버전 표기를 1.2.3으로 고치거나 GitHub 바이너리를 다른 버전 wrapper에 끼워 넣지 않았다. 최신 버전 임의 대체도 하지 않았다.

### Claude 설계 응답 (상대 보고)

위와 같은 실제 Claude 세션에서 구조 설계 응답을 회수했으나 계약 수정 요청이며 `VIBE-AGREE`는 발급하지 않았다. 원본은 `C:/Users/FX-PC06/.claude/projects/D--ClaudeCode-MV-hub-S-dev/e0e051f5-287a-4b0a-8b8c-1775df4cdb70.jsonl`이다. 요청 opus/medium, 실제 메타데이터 claude-opus-5-5. 별도 비구현자 독립 리뷰는 아직 수행하지 않았다.

- 상대 지적 중 소스로 직접 대조한 것: 런처는 동봉본 → 전역 → pin 버전 전역 npm 설치 순서이며, 백엔드는 node+JS를 직접 실행한다. 기존 스모크는 별도 CLI 경로를 선택한다. 따라서 pin만 먼저 올리는 적용은 이번 격리 조건을 충족하지 않는다.
- 아직 채택하지 않은 제안: 런타임 로컬 제외 설정, 스모크 경로 보강과 관련 시험 확장, 진행 중 생성 확인 후 pin 적용. 후속 재개 시 계약 경로와 성공 조건을 보완해 실제 합의해야 한다. 검사기는 폴더/glob을 touched_paths로 지원하지 않으므로 런타임 전체 폴더를 그대로 계약에 넣는 제안도 구체화가 필요하다.
- 상대 응답의 한계: CLAUDE/AGENT_WORKFLOW 원문 재확인 미수행을 스스로 밝혔으므로 지침 로드 완료·합의로 기록하지 않는다.

### 미완료·보존·재개 조건

- 승인된 12개 작업의 구현은 시작하지 않았다. CLI 후보 다운로드/설치, 장부 10건 재검증/백업/적용, 영상·음성 workflow 실조회, UI 구현, 업데이트 복구 구현과 회귀 시험은 미수행이다. 미확정 수·확정 수의 과거 인계값을 현재 측정값으로 사용하지 않는다.
- 제품 소스·pin·npm 설치·사용자 DB·실사용 설치본·공유 서버·NAS를 변경하지 않았다. 실행 중 앱이나 생성 작업을 중단·재시작하지 않았고 유료 생성 0회다. 계정 연결 성공을 실제 계정/DB 귀속 검증 완료로 확대하지 않는다.
- 새 작업 기록만 작성했다. 다른 세션이 수정 중인 CURRENT_STATUS/README는 조율 없이 편집하지 않았다. 새 기록의 색인 연결은 그 세션과 조율할 때 처리한다. 문서만 바뀌어 graft 재빌드·제품 전체 시험·inventory 재생성은 생략했다.
- 재개 조건: 공식 npm 1.2.3 게시 후 패키지·자산 해시·실제 앱 실행 경로를 검증하거나, 사용자가 별도 공식 바이너리 배치 방식과 필요한 범위 변경을 명시 결정할 때. 현재 승인에 포함되지 않은 설치 계약 변경으로 우회하지 않는다.
- 프로젝트 문서: 이 기록에 선행 실패와 전체 미완료 범위를 보존. 볼트: 프로젝트 고유 상태이므로 기록하지 않음.
- 일회성 `mv-hub` 예약은 도구의 `deleteStatus=deleted`로 삭제 확인했다. 기존 `hf-cli`는 ACTIVE, 매일 09:00, 원래 채팅 대상 유지 확인. 자동 재시도 예약을 만들지 않았다.
- 작업판 Add-Content 명령은 의도 훅이 쓰기 경로를 확인하지 못해 거부했다. 경로를 명시한 apply_patch로 한 줄만 추가하는 안전한 방법을 사용했다. 계약 검사 설정·지침은 변경하지 않았다.

## 2026-10-28 재개

사용자가 “공식 실행 파일로 1.2.3 검증하고 클로드랑 예약했던 작업 전부 이어서 진행”을 명시 승인했다. npm 미게시를 전체 중단 근거로 삼은 이전 판단을 정정한다. 공식 exe 직접 실행과 후속 전체 작업을 진행하며 전역 npm 설치는 변경하지 않는다. 작업 status: 설계 중. 현재 release_update.py 등 MCP 독립 업데이트 작업의 기존 변경이 있으므로 해당 경로는 소유권을 조율하기 전 수정하지 않는다.

- 공식 GitHub Windows amd64 아카이브와 checksums.txt 각각 공개 SHA-256 일치 확인. 임시 후보 `C:/Users/FX-PC06/AppData/Local/Temp/mvhub-hf123-wqtqg0ef/higgsfield.exe`의 SHA-256은 `9c2a04f38577293b377baca26a526035f954e4bbe76fc1257cec2db00db62caf`, 실제 version은 `1.2.3`, build `4cdfcbdbc9972c1092f9d8fcb93a00c3a97de84f`이다. 태그 소스 커밋과 바이너리 빌드 커밋을 동일하다고 주장하지 않는다.
- 기존 smoke 모듈을 메모리에 로드하여 후보 exe와 임시 pin/data 경로로 실행: 34 PASS / 0 WARN / 0 FAIL, exit 0. 조회·견적만 실행했고 계정/거래/결과 URL 내용은 출력하지 않았다. 실제 dev 실행 경로 검증과 적용은 별도다.
- 공식 `workflow get draw_to_video` 및 `generate workflow draw_to_video --help` 확인: video 필수, image_references 정확히 1장, `--image-references`/`--image` 지원, 비용 인자 duration/resolution. 숨은 timestamp 인자는 없으므로 임의 옵션으로 보내지 않는다.
- 공식 모델 카탈로그의 audio 항목, text2speech_v2의 prompt/variant/voice_id/voice_type 계약 및 voices list 응답(114항목)을 확인했다. 목소리 호환성과 실제 생성은 아직 검증하지 않았다.
- 소스 탐색 두 세션은 코드 읽기만 수행. 가격의 양쪽 캐시, 임의 거래 ID 연결 위험, 기존 참조 지문과 영속 추적 재사용 지점을 보고받았다. 이는 상대 보고이며 설계 합의·실사용 검증은 아니다.
- 등록 연결의 mcp_client ID와 hub_id를 해당 DB의 읽기 전용 조회로 대조하고, 그 계정 이메일과 공식 후보 CLI의 account status 이메일 일치를 출력 없이 비교했다. 연결 활성/동일 계정/동일 hub 모두 일치. 현재 완료 892건, 실제 금액 있음 882건, 미확정 10건. active.json은 없는 AUTH-on dev이므로 포인터 부재를 계정 부재로 판단하지 않았다.
- 미확정 10건은 nano_banana_2 9건과 seedream_v5_pro 1건, 모두 transaction_pending_ambiguous. UTC 2026-09-05 08:50:12.850696~08:51:25.562682. 각 미확정 생성의 ±60초에 겹치는 미연결 거래는 Seedream 지출 -3 한 건, Nano 지출 -2 열 건, Nano 환불 +2 한 건이다. 단순 후보 금액을 실제 확정으로 쓰지 않았다.
- CLI 경로 회귀 91 passed / 17 subtests, 공식 후보 스모크 34 PASS / WARN 0 / FAIL 0. 기록된 시험 영수증은 각각 `ad3f092616504ea6a2c53d31861e36c1`, `9810ad84ca94433b91f1c3ea41b28eec`, 공식 해시/실제 버전 검사는 `40317aae5a0c4b92bfa9f7a73a8a5cd2`. 이들은 CLI 단계 당시 근거이며 이후 계약·대상 변경의 최종 통과 영수증으로 자동 재사용하지 않는다.
- 가격/스키마 추가 계약은 실제 Claude `ec5d1d08-2f62-4978-a623-ef38bb421194`와 합의했고 구현 검사 통과. backend/frontend 두 구현 역할은 담당 경로를 분리했다. 장부·잔액·콘솔·미디어·참조·업데이트의 미완료 상태는 그대로 유지한다.

- 2026-10-28 잔액/콘솔/버전 구현은 양쪽 작업자 쓰기 종료. 프런트 관련 81시험/빌드/ESLint, 서버 관련 최종57시험+17subtests 통과(작업자 보고). 아직 실제앱적용·독립리뷰 전. 전체 잔여 계약 확장 준비, 아래 새 hash 재합의 전 해당 구현 시작하지 않음.

### 전체 계약 합의 이후 진행

- 실제 Claude `ec5d1d08-2f62-4978-a623-ef38bb421194`와 전체 설계 합의 후 필수 호출자·시험 5개 경로를 추가 합의했다. 현재 계약 SHA `ce18e18c05232f805a044b2110c689a3eec67727a2db408eb96ee061255118b7`, guard implement 통과. 설계·UX·장부·복구를 맡았던 실제 Claude 세션은 계약 evidence에 보존했다.
- 장부 연결은 금액 불변성만으로 거래 ID를 고르지 않도록 변경했다. 알려진 Nano 별칭/표시명을 후보 분리에 사용한다. 대상 ID 제한은 전체 연결 요소를 구한 뒤 적용한다. 장부 시험 36개/668 subtests 통과, 기존 거래 결함과 새 동일금액 ID 결함의 변이 8개를 모두 의미 있는 assertion으로 검출했다.
- 동기화의 개수/위치 기반 share_url 보강을 제거했다. 이미 같은 URL로 독립 식별되는 참조만 보강하고 사용자 파일·역할·순서는 보존한다. 관련 시험 19개/14 subtests 통과.
- 두 SQLite DB를 online backup하고 복제본에서 integrity_check 통과. 위치 `backend/data_test/backups/hf-improvements-20261027T180330Z/`, 복구용 원본 `content_hub.db`, `manage_hub.db`, 검증 복제본 `content_hub.dryrun.db`, 입력/출력 SHA 근거 `audit.json`.
- 이 백업의 비용 기록 886건은 완료 882건과 실패 4건을 합친 수치다. 앞서 이를 신규 완료 4건 증가처럼 해석한 것은 잘못이며 상태별 SQL 대조로 정정했다. 완료 생성물 집계는 892건 중 확정 882·미확정 10이다. 복제본에서 Seedream 1건(3크레딧)만 추가 확정되고 Nano 9건은 미확정 유지. 기존 비용 기록 886건·generation 전체 불변, 두 번째 실행의 장부/telemetry digest 불변을 확인했다. 실제 DB에는 아직 장부 수정을 하지 않았다.
- 영상·오디오 프런트/백엔드, 업데이트 checkpoint/로컬 쓰기 보호는 역할별 구현·격리 시험 중이다. 이 단계의 중간 시험을 전체 완료나 실사용 검증으로 보지 않는다. 유료 생성·운영 배포·앱 재시작은 하지 않았다.

### 독립 리뷰와 보정

- 장부/참조/복구 리뷰: 실제 Claude `86adaac5-381b-4e33-8f8b-70b11163610c`. 모델 미상 생성물을 후보에서 빼서 거짓 유일성을 만드는 L-1을 수정했다. 별칭 및 매칭 47시험/670 subtests 통과. 재검토에서 장부 범위 승인. 이 세션에는 요청 범위 밖 읽기 도구 호출 1회가 포함되어 최종 guard 독립 리뷰 근거로 사용하지 않는다. 데이터/제품 쓰기는 없었다.
- 수정 후 복제본에서 대상 10개·확정 쌍·대상 밖 metrics 불변·날짜 불명 거래/인근 중복 신원 없음의 증거를 `audit.json`에 추가했다. 모든 계정에 매칭을 호출한 추가 진단은 복제본에서만 수행했다. 그때 발견한 다른 계정의 69건은 실사용 반영 대상이 아니며 원본에 적용하지 않는다. 실반영은 현재 계정의 명시한 10개만 대상으로 한다.
- 복구 B-1: 업데이트 중 보존 작업을 영구 실패로 닫던 경로를 partial+60초 재시도로 수정했다. 기존 누계와 시도 예산을 보존한다. 독립 후속 검증 17시험 통과. 손상되거나 종료를 입증하지 못한 checkpoint를 임의 삭제하지 않으며, 손상 시 업데이트가 차단되는 제한을 유지한다.
- UI/미디어/가격/버전 리뷰: 별도 실제 Claude `6c35d307-a284-48e6-82fb-9624bbc3f6fa`. 신규 workflow의 확인되지 않은 반환 참조 정보로 정상 결과를 실패시키지 않도록 보정하고 기존 이미지 미부착 방어는 유지한다. 확장자 없는 TTS, 설정 타입 오류, 제한 그룹의 새 모델 선택, 프레임 잠금, 현재 옵션의 영상 견적, 캐시 한도, 계정 오류 보존을 보정·시험 중이다.
- 프런트 보정 8파일 77시험 및 tsc/build/ESLint 통과(담당자 보고). 첫 독립 통합 검증은 728시험+692 subtests 통과/12실패로, 합성 업데이트 fixture의 임시 DB 접근이 원인이었다. fixture 격리 보강 뒤 해당 복구 묶음 204시험 통과. 전체 재실행은 최종 소스 고정 뒤 수행한다.
- 실제 Edge 렌더러에서 테스트 미디어·모의 API를 사용한 4개 화면을 확인했다. `C:/Users/FX-PC06/AppData/Local/Temp/mvhub-ui-9112adf7b62d4cf5a44c683e7d4c9c93/`에 정보창(이미지/영상), 영상 1.5초 프레임 편집, Audio 옵션 캡처와 `ui-result.json`이 있다. 런타임 오류 0. 실제 유료 생성·계정 전체 화면 검증과 구분한다. 검증용 Vite는 종료했다.
- 현재 계약 SHA `74f3fe27716315e5bba2677cd220b78ca9f236d4b7d590ecc52e4609e46aa54e`; 실제 Claude와 재합의하고 implement 검사를 통과했다. 운영/전역 CLI는 계속 보존하며 pin·dev 재시작·실제 장부 반영은 최종 게이트 뒤 수행한다.

- 최종 실제 Claude 독립 리뷰 `6c35d307-a284-48e6-82fb-9624bbc3f6fa`에서 범위 A/B 전체 승인 토큰을 회수했다. 대상 fingerprint `5975f37ecc5f255b363d0e72c49d23b064be920d56174855384f5d9a1c853cb0`. 독립 검증 최종 backend 767+692 subtests, frontend 146, build PASS, 85개 소스/시험/pin 전후 SHA 동일. 13개 완료 조건에 실제 시험 영수증을 연결했다. 실제 DB·기동 전환은 이 코드 게이트 뒤 별도 결과로 남긴다.

## 최종 실행 결과 — 2026-10-28

- 공식 Windows 실행 파일 SHA·실제 버전과 확장 비과금 계약 검사 41개를 확인했다. `.mvhub-runtime/higgsfield/higgsfield.exe`를 dev 런처가 선택하고 로컬 pin은 1.2.3이다. 개인 전역 npm 패키지는 1.2.2 그대로이며 운영 설치·공유 서버·NAS에 배포하지 않았다. 공식 CLI가 `model get nano_banana_2`를 `job_type=nano_banana_pro`로 해석하는 것과 파라미터 4개 반환도 직접 확인했다.
- 가격 12시간/스키마 1시간 갱신, 이전 값·실제 저장 시각 보존, 선택/응답 경합 보호, 계정 잔액 갱신과 Host 콘솔 오류 분류, 서버 기준/실행 앱 버전 분리 표시를 구현했다. 이미지 수정 위치/이름, 원본 프레임에 그리는 영상 수정, 최소 내레이션 Audio, 결과 저장·재생·다운로드·계보와 비용 연결을 함께 구현했다.
- 참조는 기존 제출 기록/파일 지문을 재사용해 CLI 관측과 분리 저장한다. 불확실한 반환을 정상 결과 실패로 만들지 않는다. 업데이트는 원격 작업 체크포인트를 영속 보존하고 재시작 뒤 그 대상만 기존 추적으로 이어간다. 제출·로컬 저장·Comfy·Resolve 보호와 보존 재시도는 유지한다.
- 실행 전 새 일관 백업: `backend/data_test/backups/hf-preapply-20261027T183231Z/`. 실제 반영 직전 백업 및 실행 결과: `backend/data_test/backups/hf-ledger-apply-20261027T183451Z/`. 각각 content_hub.db·manage_hub.db를 보존했다. 후자의 `apply-result.json`, `post-apply-audit.json`에 반영 수·허용 ID 변화·백업 integrity·재실행 결과를 남겼다.
- 현재 계정의 검토 대상 10개를 쓰기 잠금 안에서 재확인하고, 복제본에서 승인한 Seedream 쌍과 일치할 때만 반영했다. **완료 892건 중 실제 비용 확정 883건·미확정 9건**이다. 신규 확정은 Seedream 1건 3크레딧이며, Nano 9건·환불·여분 거래는 연결하지 않았다. generation 행 변화 0, generation_metrics와 credit_txn은 각각 승인된 1개 ID만 달라졌음을 백업과 재대조했다. 실패 4건의 기존 비용도 보존했다.
- 기존 `build_telemetry_facts`와 계정 범위 `upsert_facts`를 해당 생성물 1개에만 사용하고 dirty revision CAS로 정산했다. 다른 fact 행의 해시는 보존됐고 과거 예상 견적도 바뀌지 않았다. 전체 계정을 대상으로 한 진단 실행은 복제본에서만 했으며 실사용에 적용하지 않았다.
- 재시작 전 생성 요청의 실행 단계 0건, pending/running 생성물 0건, Comfy 미회수 원장 0건을 확인했다. 기본 교체 helper가 Windows의 종료 오류로 실패한 첫 시도는 성공 처리하지 않았다. dev 경로·부모 관계를 확인한 기존 Job Object 보호 프로세스만 종료한 뒤 같은 dev 실행기를 재시작했다. 백엔드 PID 68248→16332, health/ready 정상, 실행기 콘솔의 실제 선택 결과는 `Using Higgsfield CLI 1.2.3: D:\ClaudeCode\MV-hub-S-dev\.mvhub-runtime\higgsfield\higgsfield.exe`였다. frontend는 5173에서 다시 실행 중이다. 기존 등록 MCP의 같은 client_id/hub_id로 재연결을 확인했다.
- **검증:** 독립 backend 767시험+692 subtests, frontend 146시험·build, 공식 CLI 41검사 모두 통과. 85개 소스/시험/pin 지문 전후 동일. `graft build/check`, 코드 지도(879개 대상/누락 0), inventory 동기화, diff 공백 검사도 통과. 빌드에는 기존 500KB 청크 경고만 남았다. 실제 반영 전 guard integrate는 계약 `74f3fe27716315e5bba2677cd220b78ca9f236d4b7d590ecc52e4609e46aa54e`와 fingerprint `5975f37ecc5f255b363d0e72c49d23b064be920d56174855384f5d9a1c853cb0`에서 통과했다. 그 뒤 승인된 DB 내용 변화는 별도 사후 감사로 확인했으며 코드 변경은 없었다.
- 최종 시험 근거: `C:/Users/FX-PC06/AppData/Local/Temp/mvhub-verify-0b5e8346eddb4a80b8d2c2904cec0d02/final/summary.json` 및 같은 폴더 JUnit/log/source-before/source-after. 실행 시점의 잠금·조건부 반영·MCP/콘솔 실측 원본은 이 채팅의 Codex transcript(계약 evidence 경로)에 있다. Claude 최종 리뷰 세션이 apply-result·백업·pin을 읽고 기록 대조에 동의했다(실행 직접 검증으로 확대하지 않음).

### 남은 한계와 복구

- 유료 생성은 0회다. 실제 영상 수정/내레이션 결과 품질·유료 반환 형식·음성 엔진별 목소리 호환성은 검증하지 않았다. 공식 카탈로그에는 엔진별 호환 필드가 없어 이를 추측하지 않았다. 신규 workflow는 반환 참조가 불완전하다는 이유로 정상 결과를 강제 실패시키지 않는다.
- 거래 연결은 계정·시각·검증 모델 계열로 구성한 후보 그래프의 유일성에 근거한다. 모델별 금액이 일정해도 특정 거래가 유일하지 않으면 실제 비용을 확정하지 않는다. 남은 Nano 9건을 풀려면 추가 거래 식별 근거가 필요하다.
- 손상된 `app_setting.update_remote_checkpoint`는 업데이트를 안전하게 차단한다. 종료가 입증되지 않은 기록도 임의로 지우지 않아 일부 예외 종료 기록이 재시작 때 다시 조회될 수 있다. 복구 시 두 DB와 해당 설정 원문부터 보존한 뒤 같은 계정·허브의 원격 job 상태를 대조해 재구성한다. 일괄 삭제/force 우회나 검증 없이 옛 DB를 덮어쓰지 않는다.
- pin과 native 실행 파일 배치는 로컬 dev 전용이다. 커밋·푸시·main 병합·배포 후보·운영 반영을 수행하지 않았다. 일회성 mv-hub 예약은 앞서 삭제 완료했고 기존 매일 09:00 hf-cli 감시는 유지했다.
- 프로젝트 문서: 이 기록을 정본으로 유지. 볼트: 프로젝트 고유 구현·실행 상태이므로 기록하지 않음.


## dev 커밋 인계 — 2026-10-28

- 사용자 요청으로 HF 계약의 `touched_paths` 중 이 작업 변경만 dev에 커밋한다. 코드·시험 커밋은 `191cac8341f37d8082178ad1c2146f7119cf00bf`이며, 이 기록과 관련 문서는 후속 별도 커밋으로 분리한다. 이 절 이전의 “커밋 미수행”은 당시 실행 단계의 상태다.
- `hf_cli_version.txt`, `.mvhub-runtime` 실행 파일·배포 자산, `backend/data_test` DB·백업은 커밋에서 제외하고 로컬 상태를 보존했다. 다른 세션의 MCP 업데이트·운영 지침·도구 변경도 제외했다. 공용 문서에서는 HF 관련 줄만, `release_update.py`에서는 이번 복구 변경만 선택했으며 기존 Windows 잠금 수정은 미커밋으로 남겼다.
- 커밋 후보를 별도 임시 폴더에 추출하여 백엔드 업데이트·복구·보존 관련 277시험, `mediaGeneration.test.tsx`·`videoEdit.test.tsx` 16시험, 프런트 타입 검사·빌드, inventory 및 CODE_MAP 검사를 통과했다. 빌드의 기존 500KB 청크 경고는 유지된다. 전체 시험을 새로 반복하지 않고 위 최종 독립 검증의 소스 지문 85개 불변도 대조했다.
- 분리한 후보·검증·선택 경로 근거: `C:/Users/FX-PC06/AppData/Local/Temp/hf-commit-9d57abcef26d4eb6b8f494f141b28528/`. 생성 정보 창의 후속 버튼 수정은 Claude가 코드 커밋 위에서 별도 진행할 예정이며 이번 커밋에 미리 넣지 않았다.
- 커밋은 로컬 dev만 대상으로 하며 push·main 병합·배포·유료 생성은 수행하지 않았다. 프로젝트 문서: 이 절에 인계 근거 기록. 볼트: 프로젝트 고유 상태라 미기록.
