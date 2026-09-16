---
updated: 2026-09-16
status: active
---

# Higgsfield CLI 업그레이드 절차

우리 앱은 `@higgsfield/cli` 를 로컬에서 실행해 생성물을 만들고 수집한다. **CLI 는
필드명·플래그·출력 형식을 조용히 바꾼다**(실제 사례: 0.2.x→1.x 에서 `job_set_type→job_type`,
`created_at` epoch→ISO, `account transactions` list→`{items}`, seedance 단일 `--medias` →
역할별 `--image/video/audio-references`·`--start/end-image` 로 분리, boolean 파라미터 엄격검증
(`--generate_audio True` 거부 → 소문자 `true`)).
그래서 CLI 버전은 **의도적으로 pin** 하고, **올릴 때마다 계약 스모크로 검증**한다. `@latest`
자동설치는 쓰지 않는다(HF 가 breaking 을 자주 낸다).

> [!NOTE]
> **이 예외는 `c233cdce` 에서 해소됐다.** pin 파일 누락·읽기 실패·빈 값은 손상 상태로 취급한다.
> `setup_clone_git.ps1` 은 의존성 설치 **전에** 실패 종료하고,
> `backend/app/routers/ingest.py` 는 에이전트 실행 bat 생성을 **503 으로 중단**한다.
> `update_cli.bat` 은 `hf_cli_version.txt` 의 정확한 버전만 설치한 뒤 실제 버전을 다시 검증한다.
> 버전 미지정·`@latest` 폴백은 어느 경로에도 없다.

## 버전 pin 단일 출처

- `hf_cli_version.txt` (저장소 루트) — 한 줄, 현재 `1.1.25`.
- 이 값을 런처(`MV_agent.bat`)·업데이트(`update_cli.bat`)·릴리스(`release/make_release.ps1`)·
  서버 생성 bat(`backend/app/routers/ingest.py`)·초기설치(`setup_clone_git.bat`)가 모두 읽어
  **정확히 이 버전**을 설치/검증한다. `MV_agent.bat` 은 매 실행 때 설치본이 pin 과 다르면 교정한다.

## 선제 준비 (새 버전이 오기 전에)

CLI 소스는 비공개고, `higgsfield-ai/cli` GitHub 의 **릴리스 노트 본문은 비어 있다**(확인됨) —
노트로는 변경을 못 안다. 대신 버전 태그별 `MODELS.md`(모델·파라미터 스키마)·`README.md`가
상세하니, **pin ↔ 최신 diff** 로 param/플래그/모델 변경을 설치 전에 미리 본다.

```
python tools/hf_cli_check_update.py
```

- 새 버전이 있으면 `MODELS.md`/`README.md` 의 pin→최신 diff 를 출력한다(예: seedance
  `medias`→`image_references` 같은 변화가 여기서 잡힌다).
- **한계**: 출력 JSON 형식 변경(job_type/created_at/transactions 등)은 문서에 안 나온다 →
  설치 후 스모크로 확정한다(아래).
- **무료 알림**: GitHub `higgsfield-ai/cli` 를 Watch → Custom → Releases 로 구독하면 새 버전
  릴리스 시 이메일이 온다(코드 0).

## 버전 올리는 절차 (bump)

> [!IMPORTANT]
> **순서 주의**: 스모크의 첫 검사가 `version == pin` 이므로 **pin 을 먼저 바꾸고
> `update_cli.bat` 으로 그 버전을 설치한 뒤** 검증한다. 새 CLI 를 깔아두고 pin 을 그대로 두면
> `version == pin` 이 FAIL 이라 릴리스 게이트를 통과할 수 없다. 다만 스모크는 그 뒤의 계약
> 검사를 **끝까지 계속 실행**하므로, 필드·플래그가 무엇이 바뀌었는지 진단 자료로는 쓸 수 있다.

1. `hf_cli_version.txt` 를 새 버전으로 바꾼다. **아직 커밋·릴리스하지 않는다.**
2. 그 pin 대로 한 PC 에 설치: `update_cli.bat` (또는 `npm install -g @higgsfield/cli@<새버전>`)
3. 로그인 + workspace 선택 상태에서 **계약 스모크** 실행:
   ```
   python tools/hf_cli_contract_smoke.py
   ```
4. 결과 판정:
   - **FAIL 이 있으면 → 절대 릴리스 금지.** 어느 계약이 깨졌는지 보고, 아래 "필드를 읽는 곳"의
     해당 매핑을 `x.get(a) or x.get(b)` 폴백 등으로 고친 뒤 스모크를 다시 통과시킨다.
   - **WARN 은 확인 권장.** 특히 seedance 미디어 계약 WARN(모델 스키마에 `medias` 재등장)은
     **seedance 영상을 운영에서 쓰면 릴리스 차단**으로 취급한다(agent_push 의 seedance 경로 재작성 + 유료 실측 필요).
5. **Jay 가 유료 실측을 명시적으로 승인한 경우에만** 소액 생성 1건으로
   `generate create ... --wait --json` 실제 결과를 확인한다. 승인이 없으면 이 단계는 건너뛴다.
   (무료 스모크는 실제 생성 응답과 과금 경계를 확인하지 못한다 — 한계로만 기록해 둔다.)
6. 스모크 통과 후 pin 변경과 호환 코드 수정을 **함께 `dev` 에 커밋**한다.
7. 릴리스는 여기서 바로 만들지 않는다. 프로젝트 절차(루트 `CLAUDE.md`·`AGENTS.md` 안전선)를 따른다 —
   **`dev` 검증 → Jay 지시로 `main` 반영 → 릴리스 폴더를 `origin/main` 에 맞춘 뒤 거기서 제작**.
   릴리스 스크립트는 빌드 원본뿐 아니라 완성된 ZIP 안의 pin·npm package 버전까지 다시 비교한다.
   작업자는 이후 `update_release.bat` 만 실행하면 코드와 해당 CLI 가 함께 교체된다.

## CLI 출력/플래그를 읽는 곳 (계약이 깨지면 여기를 고친다)

- `backend/app/services/cli_bridge.py` — `parse_job`(model/result_url/created_at/status/params),
  `list_models`, `get_model_params`, `estimate_cost`, 상태 정규화(`_STATUS_MAP`).
- `agent_push.py` — 생성 실행 인자 조립(`_role_flag`·`--image`·seedance `--*-references`),
  `model list`/`model get` 캐시, `account transactions` 소비, `result_url` 의 `user_<id>` 추출.
  boolean 파라미터는 `_param_flags`(agent_push.py)·`_param_args`(cli_bridge.py) 가 소문자 `true`/`false` 로 직렬화(1.x 엄격검증).
- `backend/app/services/mcp_ingest.py` — MCP `show_generations` 항목 → CLI list 형태. ★계약(2026-08-27 실측):
  영상 항목의 `results.thumbnailUrl` 은 결과 포스터가 아니라 **첫 입력 이미지**(`params.medias[0].data.url`)다 →
  영상은 버리고 이미지도 입력과 같은 `thumbnailUrl`/`minUrl` 은 버린다. `type`(image|video) 은 `result_media_type`
  으로 `parse_job` 에 전달해 확장자 판정보다 우선한다. 진짜 영상 포스터(`…_thumbnail.webp`)는 CLI `generate get/list` 만 준다.
- 원칙: **raw CLI 출력 필드는 단일 키로 읽지 말고 `x.get(new) or x.get(old)` 폴백**으로 읽어
  개명에 견디게 한다. 내부 표준 필드명(model=job_set_type 등)은 유지한다.
- `agent_push.py` 는 서버가 팀원에게 배포하는 **단독 스크립트**라 backend 를 import 하지 못한다 —
  같은 폴백 로직을 복제하되 주석으로 "cli_bridge 와 동기" 를 남긴다.
- **프론트 `frontend/src/lib/useModels.ts` `HIDDEN_PARAMS`** — CLI 가 model 스키마에 미디어/참조
  param 을 새 이름으로 노출하면(예: `medias`→`image_references`/`video_references`/`audio_references`/
  `start_image`/`end_image`) 옵션 UI 가 정체불명 텍스트칸으로 렌더한다. 참조는 '참조 픽커'가
  담당하므로 새 이름을 이 숨김목록에 추가한다(generate_audio 같은 스칼라 옵션은 노출 유지).

## 스모크가 검증하는 것 (`tools/hf_cli_contract_smoke.py`)

version==pin, `model list`(job_type|job_set_type·display_name), `model get`(params[].name),
`account status`(email·credits), `account transactions`(list|{items} + item 의 created_at/credits),
`workspace list`(id·is_selected·credits·plan_type), `generate list`(bare list·result_url·created_at
파싱·id/status/params·user_ 패턴), `generate cost`(credits_exact|credits),
`generate create --help`(**필수 media flag 존재** 확인 — `--medias` 자체를 검사하지는 않는다),
seedance 모델 스키마(`image_references` 존재, `medias` 가 있으면 **재등장 WARN**),
**boolean 직렬화 계약**(`--generate_audio True` 거부·소문자 `true` 통과 = 우리의 소문자 직렬화가 필수임을 확인).

스모크는 **코드보다 관대하면 안 된다**(통과했는데 코드가 깨지는 오탐 방지). CLI 출력을 새로
읽는 코드가 생기면 스모크에도 그 계약 검증을 추가한다.

## 최근 검증 — 1.1.24 → 1.1.25 (2026-09-16)

- 공식 태그별 MODELS.md/README.md 비교 후 후보를 별도 npm prefix에 설치했다.
  전역 CLI·실사용 설치본은 바꾸지 않았다. 실제 후보 빌드는 `b56caad0`이다.
- 무료 계약 스모크 **34 PASS / WARN·FAIL 0**, 추가 읽기 전용 **29 PASS**.
  앱이 허용하는 이미지 5종·영상 3종의 구/신 CLI 파라미터 스키마가 같고, 무료 비용 견적,
  Seedance 참조 플래그, 5개 워크스페이스 거래 형태, 생성 목록·단건, 전역 선택 불변을 확인했다.
- 과금 공간 고정은 기존 mock 단위 검사만으로 완료 처리하지 않았다. 모의 gateway 재지정이
  구/신 CLI 모두에서 적용되지 않아 외부 거절 프록시가 사전 모델 조회를 차단했고, 그 격리
  검사에서는 create를 실행하지 않았다. 이것은 새 버전 회귀의 증거가 아니다.
- 이후 Jay가 **R&D 최대 1크레딧, 이미지 1장**을 명시 승인했다. 별도 config의 기본 공간을
  R&D와 다르게 두고 `workspace status`로 확인한 뒤, 자식 환경의 `HIGGSFIELD_WORKSPACE_ID`
  로 R&D를 지정했다. 동일 파라미터의 견적 1크레딧 확인 후 `nano_banana_2_lite` 생성 **1회만**
  실행했다. 정상 완료/결과 URL, R&D **-1크레딧·새 거래 1건**, 다른 공간 잔액·거래 변화 0,
  원래 전역 선택 유지까지 확인했다. 재시도·추가 생성·원본 다운로드는 하지 않았다.
- pin 1.1.25 상태에서 백엔드 **2,660 passed / 1 skipped / 800 subtests passed**,
  프런트 **143파일·1,207 passed**, 구조 검사·타입 검사·빌드 통과.
  기존 Windows 심볼릭 링크 권한 제외와 act/큰 번들 경고는 남는다.
- 제품 변경은 pin 한 줄이며 DB·인증·계정·워크스페이스 정책 변경은 없다.
  위 유료 실측은 이미지 1종·공간 1개 사례다. 모든 영상 모델의 실제 생성까지 입증한 것은 아니다.
- Claude Opus 독립 최종 리뷰: 차단 결함 0건, 과금 공간 고정 우려 해소로 판정했다.
  고정 릴리즈 폴더 clean/원격 일치, 완성 ZIP의 실제 CLI 버전 확인, NAS 해시 검증 후
  latest 마지막 게시를 조건으로 승인했다. 이는 운영 서버 적용 완료 판정과는 구분한다.

### 다음 pin 변경 때 함께 확인할 경계

기본 스모크에 더해 실사용 모델 전체, `account transactions`의 호출별 workspace 환경,
기존 전역 선택 보존, 실제 create의 workspace 고정을 재확인한다. 조회 계약만 통과한 것을
실과금 검증으로 기록하지 않는다. 유료 검사는 위 5단계처럼 매번 별도 승인을 받아야 한다.
실제 계정·거래·결과 URL이 담긴 원문은 로그/문서에 복사하지 않고 판정과 변화량만 남긴다.

### 배포·복귀 주의

- 서버와 작업자 PC를 같은 배포본으로 맞추고 에이전트를 재시작한다. CLI 버전은 에이전트
  프로세스 수명 동안 캐시되며, 서버/PC pin이 다르면 런처의 `cli-check`가 생성을 끌 수 있다.
- 작업자에는 `update_release.bat`로 코드와 CLI를 함께 교체한다. 서버의 `update_git.bat`는
  CLI 전역 설치를 바꾸지 않는다. 공유 서버 자체는 생성 CLI 실행 주체가 아니다.
- 릴리즈는 검증한 후보 prefix를 `-HiggsfieldRoot`로 지정해 고정 릴리즈 폴더에서 만들고,
  ZIP pin·npm manifest뿐 아니라 번들 `hf.exe version`도 1.1.25인지 확인한 뒤 그 ZIP을 게시한다.
- 직전 정상 배포는 `2026.09.16-1129`(main `352f59ac`, CLI 1.1.24)다. 복귀가 필요하면
  서버와 PC의 코드/pin을 함께 맞추는 별도 복귀 계획을 승인받는다. CLI만 단독으로 내리지 않는다.
- 서버 적용 전 운영 DB 백업 세트와 진행 중 작업이 없는지 확인한다. 적용 후 첫 실사용 생성의
  정상 완료·과금 공간을 확인하며, 이번 실측에 포함되지 않은 영상 생성도 첫 사용 때 확인한다.
