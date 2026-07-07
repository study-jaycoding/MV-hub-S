# Higgsfield CLI 업그레이드 절차

우리 앱은 `@higgsfield/cli` 를 로컬에서 실행해 생성물을 만들고 수집한다. **CLI 는
필드명·플래그·출력 형식을 조용히 바꾼다**(실제 사례: 0.2.x→1.x 에서 `job_set_type→job_type`,
`created_at` epoch→ISO, `account transactions` list→`{items}`, seedance 단일 `--medias` →
역할별 `--image/video/audio-references`·`--start/end-image` 로 분리, boolean 파라미터 엄격검증
(`--generate_audio True` 거부 → 소문자 `true`)).
그래서 CLI 버전은 **의도적으로 pin** 하고, **올릴 때마다 계약 스모크로 검증**한다. `@latest`
자동설치는 쓰지 않는다(HF 가 breaking 을 자주 낸다).

## 버전 pin 단일 출처

- `hf_cli_version.txt` (저장소 루트) — 한 줄, 예: `1.1.8`.
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

1. 새 CLI 를 한 PC 에 설치: `npm install -g @higgsfield/cli@<새버전>`
2. 로그인 + workspace 선택 상태에서 **계약 스모크** 실행:
   ```
   python tools/hf_cli_contract_smoke.py
   ```
3. 결과 판정:
   - **FAIL 이 있으면 → 절대 릴리스 금지.** 어느 계약이 깨졌는지 보고, 아래 "필드를 읽는 곳"의
     해당 매핑을 `x.get(a) or x.get(b)` 폴백 등으로 고친 뒤 스모크를 다시 통과시킨다.
   - **WARN 은 확인 권장.** 특히 `--medias`(seedance) 관련 WARN 은 **seedance 영상을 운영에서
     쓰면 릴리스 차단**으로 취급한다(agent_push 의 seedance 경로 재작성 + 유료 실측 필요).
4. 스모크 통과 후 `hf_cli_version.txt` 를 새 버전으로 바꾼다.
5. (선택) 소액 유료 생성 1건으로 `generate create ... --wait --json` 실제 결과를 확인한다 —
   이건 무료 스모크가 못 잡는다.
6. 커밋(무엇이 바뀌어 무엇을 고쳤는지) 후 `release/make_release.bat` 로 릴리스 빌드.
   (릴리스는 pin 과 다른 CLI 를 번들하려 하면 빌드가 중단된다.)

## CLI 출력/플래그를 읽는 곳 (계약이 깨지면 여기를 고친다)

- `backend/app/services/cli_bridge.py` — `parse_job`(model/result_url/created_at/status/params),
  `list_models`, `get_model_params`, `estimate_cost`, 상태 정규화(`_STATUS_MAP`).
- `agent_push.py` — 생성 실행 인자 조립(`_role_flag`·`--image`·seedance `--*-references`),
  `model list`/`model get` 캐시, `account transactions` 소비, `result_url` 의 `user_<id>` 추출.
  boolean 파라미터는 `_param_flags`/`_param_args` 가 소문자 `true`/`false` 로 직렬화(1.x 엄격검증).
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
파싱·id/status/params·user_ 패턴), `generate cost`(credits), `generate create --help`(media flags·
--medias 소멸 경고), seedance `medias` param 소멸 경고, **boolean 직렬화 계약**(`--generate_audio True`
거부·소문자 `true` 통과 = 우리의 소문자 직렬화가 필수임을 확인).

스모크는 **코드보다 관대하면 안 된다**(통과했는데 코드가 깨지는 오탐 방지). CLI 출력을 새로
읽는 코드가 생기면 스모크에도 그 계약 검증을 추가한다.
