# Resolve 가져오기 큐 — manifest v3 설계 명세 (코덱스 확정, 2026-08-24)

> **상태: 구현 완료 — 이 문서가 현행 계약.** 2026-08-24 1·2단계 구현, 적대 리뷰 P1 6건 수정,
> 라이브 테스트에서 릴리스 차단 2건(동일 초 FIFO·사망 프로세스 오판) 수정, 실기기 실반입 검증 통과.
> 구현 위치는 `backend/app/services/resolve_queue*.py`·`resolve_lock.py`.
> 아래 본문 끝의 "다음 권장 작업"은 명세 작성 시점의 계획이며 이미 수행됐다.

아래 명세로 확정합니다. 파일 수정은 하지 않았습니다.

핵심 결정은 네 가지입니다.

- v3의 권위 상태는 `queue.state`이며 `ready` 상태를 추가합니다.
- v3는 `format: "mvhub.resolve-transfer.v3"`를 사용합니다. 단순 `version: 3`은 구버전 스캐너가 버전을 검사하지 않아 안전하지 않습니다.
- 이중 드레인은 교체되지 않는 별도 `.lock` 파일의 Windows `LockFileEx`로 막습니다. manifest의 claim/PID/lease는 복구·fencing 용도입니다.
- `importing` 중단 후 “자동 재큐잉”은 누락 목록까지만 자동 생성하고 `dispatch_policy: manual_only`로 둡니다. 실제 Resolve 재실행은 사용자 확인 전에는 하지 않습니다.

현행 근거는 [resolve_transfer.py](../backend/app/services/resolve_transfer.py#L29), [MVHub_Importer.py](../backend/app/resources/resolve/MVHub_Importer.py#L62), [resolve_bridge.py](../backend/app/services/resolve_bridge.py#L332), [resolve_status_runner.py](../backend/app/services/resolve_status_runner.py#L238)입니다.

# 1. manifest v3 상태·복구 명세

## 1.1 파일 위치와 식별자

```text
<프로젝트 루트>\@davinci\.mvhub\transfers\<transfer_id>.json
```

```json
{
  "format": "mvhub.resolve-transfer.v3",
  "version": 3
}
```

v2의 `format: "mvhub.resolve-transfer"`는 그대로 유지합니다. v2 파일을 자동 덮어쓰기하거나 v3로 변환하지 않습니다.

## 1.2 권위 상태 집합

권위 상태 필드:

```json
"queue": {
  "state": "queued",
  "revision": 1,
  "state_changed_at": "2026-08-23T10:00:00Z",
  "dispatch_policy": "auto",
  "resume_state": null,
  "claim": null,
  "blocked": null,
  "cancel": {
    "requested_at": null,
    "requested_by": null,
    "force": false
  },
  "last_error": null
}
```

상태는 다음 9개로 고정합니다.

| 상태 | 의미 |
|---|---|
| `queued` | 접수 완료. 원본 준비 대기 |
| `preparing` | 원본 재조회·캐시·Render 복사 중 |
| `ready` | 가져올 로컬 파일이 준비됨 |
| `blocked` | 조건이 바뀌면 자동 재평가 가능한 보류 |
| `importing` | Resolve 조작 가능성이 있는 실행 중 |
| `complete` | 모든 대상이 import 또는 dedupe skip으로 확정됨 |
| `failed` | 실행 결과가 확정된 실패. 자동 재시도 안 함 |
| `interrupted` | import 도중 결과를 확정하지 못함 |
| `recovery_required` | Bin 구조나 실행 소유권이 애매하여 격리됨 |
| `cancelled` | 사용자가 작업을 폐기함 |

`ready`는 반드시 필요합니다. `queued`만 사용하면 “복사를 다시 해야 하는 작업”과 “Resolve만 기다리는 작업”을 부팅 시 구분할 수 없습니다.

## 1.3 상태 전이표

| 이전 → 다음 | 트리거 | 기록 주체 | 자동 여부 |
|---|---|---|---|
| 없음 → `queued` | 접수 검증 후 최초 manifest 원자 기록 성공 | API 접수부 | 자동 |
| `queued` → `preparing` | 준비 슬롯 최대 3개 중 하나가 claim | 준비 워커 | 자동 |
| `preparing` → `ready` | 항목 준비 종료, 유효한 파일 1개 이상 | 준비 워커 | 자동 |
| `preparing` → `blocked` | 계정 scope·목적지·원격 조회가 현재 불가 | 준비 워커 | 자동 |
| `preparing` → `failed` | 준비 가능 항목 0개 또는 영구 오류 | 준비 워커 | 자동 |
| `preparing` → `cancelled` | 취소 확인, Resolve 부수효과 없음 | 준비 워커 | 명시 취소 |
| `ready` → `importing` | import 전역 락·프로젝트 락·manifest 락 획득, attempt 기록 완료 | push 워커 또는 메뉴 Importer | 자동/수동 |
| `ready` → `blocked` | Resolve 프로젝트 불일치·미오픈·API 불가 | import 소유자 | 자동 |
| `ready` → `cancelled` | 사용자 취소 | 허브 API | 명시 취소 |
| `blocked` → `queued` | 준비 단계 조건 회복 | 재평가기 | 자동 |
| `blocked` → `ready` | Resolve 대상 조건 회복 | 재평가기 | 자동 |
| `blocked` → `failed` | 대상 삭제 등 영구 불가 판정 | 재평가기 | 자동 |
| `importing` → `complete` | 결과 및 프로젝트 저장까지 확정 | import 소유자 | 자동 |
| `importing` → `blocked` | 부수효과 전에 `project_changed` 등 발견 | import 소유자 | 자동 |
| `importing` → `failed` | 자식이 정상 반환했고 실패 범위가 확정됨 | import 소유자 | 자동 |
| `importing` → `interrupted` | 부수효과 이후 자식 사망·강제 중단·결과 유실 | 부팅/드레인 복구기 | 자동 격리 |
| `importing` → `recovery_required` | 고아 rebuild Bin·소유자 불명·구조 모호 | 복구기 | 자동 격리 |
| `interrupted` → `ready` | 정상 Bin에서 누락 목록 산출 | 복구기 | 목록만 자동, `manual_only` |
| `interrupted` → `complete` | 재검사 결과 누락 0개 | 복구기 | 자동 |
| `interrupted` → `recovery_required` | 고아/중복 Bin 등 모호성 발견 | 복구기 | 자동 |
| `failed` → `queued`/`ready` | 사용자가 단계별 재시도 선택 | 허브 API | 수동 |
| `recovery_required` → `interrupted` | 사용자가 Bin/DRP 처리 후 재검사 통과 | 허브 API+복구기 | 수동 |
| 비종료 상태 → `cancelled` | 사용자 폐기 | 허브 API | 수동 |

추가 규칙:

- `partial`은 권위 상태로 쓰지 않습니다. `queue.state="failed"`와 `resolve_import.status="partial"` 조합으로 표현합니다.
- `cancel_requested`가 import 전에 반영되면 `cancelled`입니다.
- 일부 Resolve 변경 뒤 취소되면 먼저 `interrupted`입니다. 사용자가 잔여 작업을 폐기한 뒤에만 `cancelled`로 바꿉니다.
- `complete`와 `cancelled`는 터미널입니다. 다시 가져오기는 새 transfer를 만듭니다.

## 1.4 v2 투영 필드

v3에도 기존 브리지 재사용을 위해 다음 최상위 필드를 유지합니다.

```json
{
  "status": "pending",
  "downloaded": 0,
  "skipped": 0,
  "error_count": 0,
  "items": [],
  "resolve_import": {
    "status": "pending"
  }
}
```

단, 이들은 v2 호환 투영일 뿐 권위 상태가 아닙니다.

- `queued`, `preparing`: 최상위 `status="pending"`
- 준비 완료: `complete|partial|failed`
- import 진행·완료 여부: `resolve_import.status`
- 모든 신규 판단: `queue.state`

## 1.5 v3 JSON 예시

```json
{
  "format": "mvhub.resolve-transfer.v3",
  "version": 3,
  "transfer_id": "20260823T100000Z-a1b2c3d4",
  "project_id": "project-local-uuid",
  "project_name": "EP01",
  "source_root": "D:\\Projects\\EP01\\Render",
  "manifest_root": "D:\\Projects\\EP01\\@davinci",
  "manifest_path": "D:\\Projects\\EP01\\@davinci\\.mvhub\\transfers\\20260823T100000Z-a1b2c3d4.json",
  "created_at": "2026-08-23T10:00:00Z",
  "created_at_ns": 1787654400123456700,
  "status": "pending",
  "total": 1,
  "downloaded": 0,
  "skipped": 0,
  "error_count": 0,
  "resolve_target": {
    "project_id": "resolve-project-uid",
    "project_name": "EP01_EDIT"
  },
  "queue": {
    "state": "queued",
    "revision": 1,
    "state_changed_at": "2026-08-23T10:00:00Z",
    "dispatch_policy": "auto",
    "resume_state": null,
    "claim": null,
    "blocked": null,
    "last_error": null,
    "last_attempt_id": null,
    "cancel": {
      "requested_at": null,
      "requested_by": null,
      "force": false
    }
  },
  "source_payload": {
    "schema": 1,
    "account_scope": {
      "kind": "shared_account",
      "account_key": "acct:artist@example.com",
      "account_email": "artist@example.com",
      "creator_uid_at_accept": "user_123",
      "server_origin": "https://hub.example.com"
    },
    "destination_contract": {
      "root_kind": "project_render",
      "project_id": "project-local-uuid",
      "accepted_root": "D:\\Projects\\EP01\\Render",
      "root_identity": "\\\\nas\\projects\\ep01\\render",
      "path_policy": "safe_join_v1",
      "filename_policy": "generation_sha256_v1",
      "collision_policy": "content_equal_skip_else_fail"
    },
    "reconstruction": {
      "generation_lookup_order": [
        "local_generation_id",
        "local_job_id",
        "scoped_remote_generation_id"
      ],
      "asset_policy": "primary_asset_v1",
      "cdn_credentials": "never_persist"
    }
  },
  "items": [
    {
      "item_id": "item-0001",
      "generation_id": "gen_123",
      "folder_path": "ep001/c0010",
      "filename": "c0010_12ab34cd56ef.mp4",
      "media_type": "video",
      "local_path": "",
      "status": "pending",
      "error": null,
      "source_ref": {
        "requested_generation_id": "gen_123",
        "local_generation_id": "gen_123",
        "job_id": "job_456",
        "asset_id": "asset_789",
        "asset_ordinal": 0,
        "cached_media_ref": "/media/ab/cd/video.mp4"
      },
      "destination": {
        "relative_folder": "ep001/c0010",
        "filename": "c0010_12ab34cd56ef.mp4"
      },
      "prepare": {
        "state": "queued",
        "size": null,
        "sha256": null,
        "error_code": null
      },
      "import": {
        "state": "pending",
        "media_pool_path": "MV Hub/EP01/ep001/c0010",
        "error_code": null
      }
    }
  ]
}
```

## 1.6 재시작 가능한 source payload 필드

필수 필드는 다음과 같습니다.

- 계정:

  - `account_scope.kind`
  - `account_scope.account_key`
  - `account_scope.account_email`
  - `account_scope.creator_uid_at_accept`
  - `account_scope.host_id_at_accept` — 접수한 로컬 PC의 안정 식별자
  - 쿼리·fragment·userinfo를 제거한 `server_origin`

- 생성물 재조회:

  - `requested_generation_id`
  - `local_generation_id`
  - `job_id`
  - `asset_id`
  - `asset_ordinal`
  - `media_type`
  - `/media/...` 형식인 경우에만 `cached_media_ref`

- 목적지:

  - `project_id`
  - `accepted_root`
  - UNC·대소문자 정규화된 `root_identity`
  - `relative_folder`
  - `filename`
  - `path_policy`
  - `filename_policy`
  - `collision_policy`

재구성 순서:

1. 목록·워커·취소·재시도는 현재 `host_id`와 `host_id_at_accept`가 같은 기록만 대상으로 합니다. 이 필드가 없는 구버전 공유 기록은 자동 실행하지 않습니다.
2. 현재 계정의 `account_key`와 `server_origin`이 접수 시 값과 같은지 확인합니다.
3. 로컬 `generation.id`, 로컬 `job_id`, scoped 원격 generation 순으로 재조회합니다.
4. `asset_id`가 있으면 정확히 일치하는 자산만 사용합니다. 없을 때만 `asset_ordinal`을 사용하며 타입까지 일치해야 합니다.
5. 현재 자산의 `/media/...` 또는 현재 재조회 응답의 URL을 메모리에서만 사용합니다.
6. 현재 Render root가 `root_identity`와 다르면 `blocked/destination_changed`입니다.
7. `safe_join(root, relative_folder, filename)`으로 목적지를 다시 만듭니다.
8. 기존 파일이 있으면 크기와 SHA-256/바이트 비교가 같을 때만 `skipped`; 다르면 `destination_conflict`입니다.

저장 금지:

- `source_url`
- URL 형태의 `file_path`
- CDN 서명 query
- Authorization 헤더·쿠키
- 다운로드 토큰
- 토큰이 포함될 수 있는 원문 예외 메시지

## 1.7 원자 교체 규칙

모든 manifest 갱신은 다음 순서입니다.

1. 해당 transfer의 안정된 `.lock` 파일 락 획득
2. 현재 manifest 재읽기
3. `queue.revision`, `claim_token`, `claim_epoch` 확인
4. revision을 1 증가
5. 같은 디렉터리에 고유 `.tmp` 생성
6. UTF-8 JSON 전체 쓰기
7. `flush()`와 `os.fsync()`
8. 같은 볼륨 안에서 `os.replace()`
9. 교체 성공 뒤에만 메모리 상태·HTTP 응답 확정

현행 `atomic_write_text`도 같은 디렉터리 temp→fsync→replace를 사용합니다([atomic_io.py](../backend/app/services/atomic_io.py#L15)).

추가 요구:

- manifest를 직접 truncate/write하지 않습니다.
- lock 파일은 절대 삭제·교체하지 않습니다.
- Windows 공유 위반은 짧게 재시도할 수 있지만, 실패를 성공으로 처리하지 않습니다.
- 최초 접수도 manifest 교체 완료 전에는 성공 응답을 보내지 않습니다.
- API는 `202 Accepted`와 `transfer_id`, `queue.state="queued"`를 반환합니다.

## 1.8 v2/구버전 안전성

단순 `version: 3`은 금지합니다. 현행 스캐너는 version을 검사하지 않고 `format`, 최상위 `status`, `resolve_import.status`만 봅니다([resolve_transfer.py](../backend/app/services/resolve_transfer.py#L211)).

확정 정책:

- v3 format은 `mvhub.resolve-transfer.v3`.
- 구버전 Hub는 format 불일치로 v3를 무시합니다.
- 구버전 `/retry`도 v3를 거부하므로 claim 없는 강제 import가 일어나지 않습니다.
- 신규 Hub는 v2와 v3를 모두 읽습니다.
- v2는 자동 push 워커가 claim하지 않습니다. 기존 메뉴 pull 경로로만 처리합니다.
- 신규 Importer는 `X-MVHub-Resolve-Capabilities: manifest-v3,claim-v1,journal-v1`을 전송합니다.
- 헤더가 없는 구버전 Importer에는 신규 Hub가 v2만 반환합니다.
- 신규 Importer가 구버전 Hub의 claim API에서 404를 받으면 기존 `/pending`으로 폴백하되, 그 응답에서는 v2만 처리합니다.
- 기존 v2 파일은 자동 변환하거나 덮어쓰지 않습니다.

# 2. push 워커 ↔ 수동 Importer 공통 claim/lease

현행 메뉴 Importer는 이미 `127.0.0.1:8010/8012`로 Hub API를 호출할 수 있습니다([MVHub_Importer.py](../backend/app/resources/resolve/MVHub_Importer.py#L25)). 따라서 Importer가 SMB 파일을 직접 잠그지 않고, 로컬 Hub API가 락을 대신 보유하도록 합니다.

## 2.1 락 파일

```text
프로젝트 공용:
<manifest_root>\.mvhub\locks\project-import.lock
<manifest_root>\.mvhub\locks\transfers\<transfer_id>.lock

PC 공용:
<CONTENT_HUB_DATA>\resolve\locks\machine-import.lock
<CONTENT_HUB_DATA>\resolve\host-id
```

락 순서는 항상 다음과 같습니다.

```text
machine-import.lock
  → project-import.lock
    → transfers\<transfer_id>.lock
```

준비 작업은 transfer 락만 사용하므로 최대 3개 병렬입니다. Resolve import는 세 락을 모두 보유하므로 PC 전체 및 해당 프로젝트에서 한 번에 하나만 실행됩니다.

## 2.2 Windows/SMB 락 구현

- Windows `CreateFileW(OPEN_ALWAYS)`로 안정된 lock 파일을 엽니다.
- `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`로 offset 0, length 1을 잠급니다.
- 파일은 비어 있어도 EOF 바깥 바이트 잠금이 가능합니다.
- 핸들은 import가 끝나고 최종 manifest가 저장될 때까지 열어 둡니다.
- manifest 파일 자체를 잠그지 않습니다. `os.replace` 시 파일 객체가 바뀌기 때문입니다.
- lock 파일은 cleanup 대상으로 삭제하지 않습니다.
- 시작 시 두 핸들로 “첫 락 성공, 둘째 락 실패” self-test를 수행합니다.
- SMB가 byte-range lock을 제대로 제공하지 않으면 v3 워커를 비활성화하고 `locking_unsupported`로 보고합니다. best-effort 폴백은 금지합니다.

## 2.3 claim 필드

```json
"claim": {
  "token": "5e0f...128bit...",
  "epoch": 7,
  "purpose": "import",
  "owner": {
    "kind": "push_worker",
    "host_id": "host-uuid",
    "hub_instance_id": "hub-process-uuid",
    "process_id": 14240,
    "process_started_at_filetime": "134010234567890000",
    "process_nonce": "process-random-uuid",
    "executor_pid": 17320
  },
  "attempt_id": "attempt-uuid",
  "acquired_at": "2026-08-23T10:01:00Z",
  "heartbeat_at": "2026-08-23T10:01:30Z",
  "lease_expires_at": "2026-08-23T10:03:30Z"
}
```

- token은 CSPRNG 128비트 이상입니다.
- epoch는 transfer별 단조 증가 정수입니다.
- 기본 lease는 120초, heartbeat는 최대 30초 간격입니다.
- lease 만료는 자식 종료 timeout이 아닙니다.
- import 자식은 `timeout=None`으로 기다립니다.
- lease 만료만으로 자식을 kill하거나 다른 작업자가 `importing`을 빼앗지 않습니다.

## 2.4 claim 순서

1. FIFO 후보를 `created_at_ns`, `transfer_id` 순으로 선택합니다.
   - `created_at`(초 단위)만으로는 같은 초에 들어온 접수가 동률이 되고, 그때 `transfer_id`
     문자열 정렬은 실제 접수 순서와 무관합니다(큐 순서·`ahead` 뒤바뀜). 그래서 접수 순서의
     권위 키는 나노초 정수 `created_at_ns`이며, 같은 프로세스 안에서는 단조 증가를 강제합니다.
   - 하위호환: `created_at_ns`가 없는 기존 v3 manifest는 초 단위 `created_at`을 나노초로
     환산해 같은 축에서 비교하고, 그렇게 동률이 된 옛 기록끼리는 예전대로 `transfer_id`로 갈립니다.
   - 한계: 서로 다른 프로세스(허브 재시작·다른 PC)의 접수는 벽시계 해상도까지만 구분됩니다.
2. import 공용 락을 정해진 순서로 획득합니다.
3. transfer lock 아래 manifest를 재읽습니다.
4. 상태·revision·기존 claim을 다시 검사합니다.
5. claim token/epoch를 기록합니다.
6. attempt journal 초기 파일을 기록합니다.
7. `ready → importing`을 원자 저장합니다.
8. 그 뒤에만 child를 spawn하거나 메뉴 Importer에 manifest를 반환합니다.
9. 모든 결과 갱신은 token+epoch+attempt_id가 현재 값일 때만 허용합니다.
10. 최종 manifest 저장 성공 뒤 lock을 풉니다.

옛 실행자의 늦은 result/heartbeat는 `409 lost_claim`으로 거절합니다.

## 2.5 로컬 API 계약

신규 메뉴 Importer가 사용하는 API를 다음으로 고정합니다.

```text
POST /api/resolve/transfers/claim
POST /api/resolve/transfers/claim/renew
POST /api/resolve/transfers/attempt
POST /api/resolve/transfers/claimed-result
POST /api/resolve/transfers/cancel
```

모든 요청은 기존처럼 로컬 PC 요청만 허용합니다.

claim 요청 최소값:

```json
{
  "capabilities": ["manifest-v3", "claim-v1", "journal-v1"],
  "owner": {
    "session_id": "importer-run-uuid",
    "pid": 1234,
    "process_started_at_filetime": "134010234567890000"
  },
  "current_project": {
    "project_id": "resolve-project-uid",
    "project_name": "EP01_EDIT"
  }
}
```

claim 응답은 한 번에 manifest 하나만 반환합니다.

## 2.6 Importer 최소 준수 규칙

신규 `MVHub_Importer.py`는 반드시:

- 기존 `/pending` 대신 claim POST를 우선 사용
- PID와 Windows 프로세스 creation time 전송
- claim 성공 전 `AddSubFolder`, `ImportMedia`, `SaveProject` 호출 금지
- heartbeat thread를 시작하고 30초 이내 갱신
- 각 Resolve 변경 직전에 attempt phase 기록
- 각 batch 전후 journal 기록
- result에 token, epoch, attempt_id 포함
- claim 상실을 감지하면 다음 batch를 시작하지 않음
- 현재 진행 중인 단일 Resolve API 호출을 자동 kill하지 않음
- v3 result를 기존 token 없는 `/manual-result`로 보내지 않음

## 2.7 소유자 사망과 PID 재사용

PID만으로 사망을 판정하면 안 됩니다.

- `host_id`가 현재 PC와 같을 때만 PID 검사를 수행합니다.
- `OpenProcess`와 `GetProcessTimes`로 PID의 creation time과 **exit time**을 함께 읽습니다.
- PID 존재 + exit time ≠ 0: 이미 종료(커널 객체만 남은 상태), 사망
- PID 존재 + exit time = 0 + creation time 일치: 원 소유자 생존
- PID 존재 + exit time = 0 + creation time 불일치: PID 재사용, 원 소유자 사망
- PID 없음: 사망
- 접근 거부·다른 host·조회 실패: `unknown`

★exit time을 반드시 함께 봅니다. Windows는 프로세스가 끝나도 누군가 핸들을 쥐고 있으면
커널 객체를 남겨 두고, 그동안 `OpenProcess`는 그 PID로 계속 성공하며 `GetProcessTimes`는
creation time을 그대로 돌려줍니다. creation time만 비교하면 강제 종료된 허브를 `alive`로
오판해 부팅 복구가 claim을 회수하지 못하고 `importing`이 고착됩니다.

복구 규칙:

| 상황 | 처리 |
|---|---|
| OS 락 유지 + 소유자 생존 | active, 건드리지 않음 |
| lease 만료 + 소유자 생존 | 자동 steal 금지 |
| lease 만료 + 소유자 unknown | `recovery_required`, 자동 steal 금지 |
| OS 락 획득 가능 + `preparing` | 준비 항목 검증 후 안전하게 재큐잉 |
| OS 락 획득 가능 + `importing` | journal/Resolve 검사 전에는 재실행 금지 |
| PID 재사용 확인 | 원 소유자 사망으로 판단하되 import는 `interrupted` 복구 절차 적용 |

# 3. 조건부 자동 복구 규칙

## 3.1 고아 rebuild Bin 감지

부팅 시와 import claim 직전에 현재 Resolve 프로젝트의 Media Pool root를 재귀 검사합니다.

```text
^__MVHUB_REBUILD_[A-Za-z0-9_]+__$
```

신규 staging 이름은 추적 가능하게 만듭니다.

```text
__MVHUB_REBUILD_<transfer8>_<attempt8>__
```

하나라도 발견되면:

1. 해당 이름을 기록한 attempt journal을 찾습니다.
2. 매칭 manifest는 즉시 `recovery_required`로 전환합니다.
3. journal 매칭이 없으면 Resolve 프로젝트 단위 recovery incident를 만듭니다.
4. 그 Resolve 프로젝트를 대상으로 하는 모든 자동 import를 막습니다.
5. Bin을 자동 이동·삭제하거나 DRP를 자동 복원하지 않습니다.

incident 위치:

```text
<manifest_root>\.mvhub\recovery\<resolve_project_key>.json
```

## 3.2 “정상 Bin” 판정

다음을 모두 만족해야 정상입니다.

- `__MVHUB_REBUILD_*` Bin이 없음
- 현재 Resolve 프로젝트 identity가 manifest와 일치
- `MV Hub\<project_label>` Bin이 0개 또는 정확히 1개
- 각 목적지 Bin 경로가 대소문자 정규화 후 유일함
- attempt journal이 `rebuild_*` 중간 phase에 머물지 않음
- 준비 파일이 source root 아래에 있으며 size/SHA-256이 기록과 일치
- 같은 manifest 안에 동일한 `(target_bin, normalized_local_path)` 중복이 없음

하나라도 판단 불가하면 `recovery_required`입니다.

## 3.3 누락분 계산과 재큐잉

멱등 키:

```text
resolve_project_identity
+ normalized_media_pool_bin_path
+ normalized_local_file_path
```

경로 정규화는 현행처럼:

- 절대경로
- `normpath`
- Windows `normcase`
- 매핑 드라이브를 UNC로 변환

현행 브리지와 메뉴 Importer 모두 이 방식으로 기존 클립을 검사합니다([resolve_bridge.py](../backend/app/services/resolve_bridge.py#L498), [MVHub_Importer.py](../backend/app/resources/resolve/MVHub_Importer.py#L195)).

복구 알고리즘:

1. exact target Bin마다 현재 `File Path` 집합을 수집합니다.
2. 이미 존재하는 항목은 `import.state="recovered_existing"`로 확정합니다.
3. 존재하지 않는 준비 파일만 `recovery.missing_item_ids`에 넣습니다.
4. 누락 0개면 manifest를 `complete`로 확정합니다.
5. 누락이 있으면 `queue.state="ready"`로 돌리되 다음처럼 둡니다.

```json
{
  "dispatch_policy": "manual_only",
  "recovery": {
    "reason": "interrupted_import_missing_items",
    "existing_count": 8,
    "missing_count": 2,
    "missing_item_ids": ["item-0009", "item-0010"],
    "verified_at": "2026-08-23T10:10:00Z"
  }
}
```

이것이 “누락분만 자동 재큐잉”의 정확한 의미입니다. 누락 목록 생성은 자동이지만, 실제 Resolve import는 사용자가 확인할 때까지 실행하지 않습니다. 이는 “importing 중단분 자동 재실행 금지”와 충돌하지 않습니다.

사용자 확인 후에는 `dispatch_policy="auto"`로 바꾸고 새 attempt로 누락 2개만 실행합니다.

## 3.4 멱등 근거

- 동일 target Bin 안의 동일 정규화 경로는 `ImportMedia` 전에 skip됩니다.
- crash가 `ImportMedia` 성공 직후, journal 저장 전에 일어나도 재검사에서 기존 경로로 발견됩니다.
- 다른 Bin의 같은 파일은 별도 의도이므로 dedupe하지 않습니다.
- generation ID만으로 dedupe하지 않습니다. 같은 generation을 다른 Bin에 배치할 수 있기 때문입니다.
- 준비 파일은 size와 SHA-256까지 검사하므로 같은 경로의 다른 파일을 완료로 오인하지 않습니다.
- global import lock이 검사와 다음 import 사이의 다른 MV Hub import를 차단합니다.

## 3.5 사용자 확인 문구

고아 Bin:

> Resolve Bin 재정렬이 완료되기 전에 중단된 흔적을 발견했습니다. 임시 Bin `{staging_bin}` 안에 클립이 남아 있을 수 있어 자동 가져오기를 중지했습니다. 백업: `{drp_path 또는 "없음"}`. Resolve에서 임시 Bin과 `MV Hub` Bin을 확인한 뒤 복구 방법을 선택하세요.

버튼:

```text
[백업 위치 열기] [현재 Bin 재검사] [누락분 복구 준비] [작업 폐기]
```

정상 Bin·누락분만 존재:

> 기존 원본 {existing_count}개는 Media Pool에서 확인했습니다. 누락된 {missing_count}개만 다시 가져올 수 있습니다. 계속할까요?

소유자 불명/PID 확인 불가:

> 이전 가져오기 프로세스가 끝났는지 확인할 수 없습니다. 중복 작업을 막기 위해 자동 실행하지 않았습니다. 다른 PC의 MV Hub와 Resolve를 종료했는지 확인한 뒤 다시 검사하세요.

프로젝트 불일치:

> 전송 대상은 `{expected}`이지만 현재 열린 Resolve 프로젝트는 `{current}`입니다. 대상 프로젝트를 연 뒤 자동으로 다시 확인합니다.

# 부속 명세

## A. attempt journal

위치:

```text
<manifest_root>\.mvhub\attempts\<transfer_id>\<attempt_id>.json
```

자식은 fusionscript import나 Resolve 연결보다 먼저 journal을 씁니다. 이 첫 기록이 실패하면 Resolve를 호출하지 않고 종료합니다.

```json
{
  "format": "mvhub.resolve-attempt",
  "version": 1,
  "transfer_id": "20260823T100000Z-a1b2c3d4",
  "attempt_id": "attempt-uuid",
  "claim_token": "token",
  "claim_epoch": 7,
  "executor": "push_worker",
  "pid": 17320,
  "process_started_at_filetime": "134010234567890000",
  "started_at": "2026-08-23T10:01:01Z",
  "updated_at": "2026-08-23T10:02:05Z",
  "phase": "import_batch_calling",
  "side_effects_started": true,
  "resolve_project": {
    "expected_id": "resolve-project-uid",
    "current_id": "resolve-project-uid",
    "current_name": "EP01_EDIT"
  },
  "staging_bin": "__MVHUB_REBUILD_20260823_ab12cd34__",
  "drp_path": "D:\\Projects\\EP01\\@davinci\\.mvhub\\resolve-backups\\resolve-....drp",
  "last_batch": {
    "index": 3,
    "folder_path": "ep001/c0030",
    "item_ids": ["item-0011", "item-0012"],
    "state": "calling",
    "started_at": "2026-08-23T10:02:04Z",
    "verified_at": null
  },
  "result": null,
  "error_code": null,
  "error": null
}
```

phase 집합:

```text
child_started
connecting
project_verified
mutation_started
rebuild_backup_started
rebuild_backup_complete
rebuild_staging_created
rebuild_to_staging
rebuild_to_final
rebuild_verified
rebuild_staging_deleted
import_batch_calling
import_batch_verified
saving_project
complete
failed
cancelled
```

규칙:

- `mutation_started`를 첫 `AddSubFolder`, `MoveClips`, `ImportMedia`, `SaveProject`보다 먼저 기록합니다.
- batch journal은 API 호출 직전 `calling`, 결과 경로 검증 후 `verified`입니다.
- 자식은 terminal result를 journal에 원자 저장한 뒤 stdout 결과를 출력합니다.
- parent가 결과 수신 후 죽어도 부팅 복구기가 terminal journal로 manifest를 확정할 수 있습니다.
- journal에도 URL·토큰·쿠키를 기록하지 않습니다.

## B. `project_changed=blocked` 재평가

현재 `project_changed` 코드는 브리지에서 이미 생성됩니다([resolve_bridge.py](../backend/app/services/resolve_bridge.py#L348)).

blocked 구조:

```json
{
  "resume_state": "ready",
  "blocked": {
    "code": "project_changed",
    "expected_project_id": "resolve-project-uid",
    "expected_project_name": "EP01_EDIT",
    "observed_project_id": "other-uid",
    "observed_project_name": "OTHER",
    "first_seen_at": "2026-08-23T10:02:00Z",
    "last_checked_at": "2026-08-23T10:03:00Z"
  }
}
```

재평가 트리거:

- Hub 부팅
- 워커 drain 주기
- Resolve 연결 상태 변경
- 메뉴 Importer 실행
- 사용자의 “다시 확인”
- 현재 프로젝트 변경 이벤트를 감지할 수 있다면 해당 이벤트

일치 규칙:

- 양쪽 ID가 있으면 ID 정확 일치
- 한쪽 ID가 없으면 양쪽 이름이 존재하고 NFC 정규화 후 정확 일치
- ID와 이름 모두 검증할 수 없으면 `target_unverifiable`로 계속 blocked
- 일치하면 `blocked → ready`
- 실제 import 직전 브리지가 한 번 더 동일 검사를 수행

`project_changed` 검사는 현재 코드상 Media Pool 변경 전에 실행되므로, 이 오류에 한해서는 `importing → blocked`가 안전합니다.

## C. `error_code` 보존

현재 [resolve_bridge.py](../backend/app/services/resolve_bridge.py#L1058)의 최외곽 `except Exception`이 `ResolveBridgeError.code`를 버립니다. 다음 계약이 필요합니다.

모든 결과 계층에 필수:

```json
{
  "status": "unavailable",
  "error_code": "project_changed",
  "error": "사용자용 설명"
}
```

전달 경로:

```text
ResolveBridgeError.code
→ resolve_bridge 결과.error_code
→ resolve_import_worker stdout JSON
→ resolve_status_runner
→ manifest.resolve_import.error_code
→ queue.last_error.code
→ API 응답
```

최소 코드 집합:

```text
project_changed
target_unverifiable
not_running
no_project
api_unavailable
python_incompatible
module_unavailable
spawn_failed
child_crashed
invalid_child_result
source_missing
source_changed
account_scope_changed
destination_changed
destination_conflict
prepared_file_changed
locking_unsupported
orphan_rebuild_bin
claim_lost
cancelled
unexpected_error
```

추가 요구:

- `ResolveBridgeError`를 먼저 별도 catch하고 `exc.code`를 보존
- 일반 예외만 `unexpected_error`
- `_import_unavailable()`도 `error_code` 인자를 필수로 받음
- 항목 오류는 `items[].error_code`
- 폴더 재정렬 오류는 `ordering_error_codes[]`
- 상태 판단에서 오류 메시지 문자열 파싱 금지

## D. 워커·취소·실행 범위

- 워커 실행 조건은 `os.name == "nt"`이고 `install_mode() == "release"`인 경우만입니다.
- development/server에서는 v3 자동 워커를 시작하지 않습니다.
- 준비 풀 기본 3, 허용값 2 또는 3, 최대 3입니다.
- Resolve import는 항상 1개입니다.
- import 자식 대기에 timeout을 두지 않습니다.
- 일반 취소는 cooperative cancel이며 batch/phase 경계에서 멈춥니다.
- 자동 `TerminateProcess`는 금지합니다.
- 별도 “강제 중단”은 2차 사용자 확인이 있는 명시 동작만 허용합니다.
- import 부수효과 이후 강제 중단은 항상 `recovery_required`입니다.
- 유료 CLI나 생성 큐와는 연결하지 않습니다.

# 최종 보고

1. 변경한 파일  
   없음. read-only 설계 검토만 수행했습니다.

2. 변경 이유  
   구현 전 필수였던 v3 상태 계약, 공통 claim/lease, 조건부 복구 기준을 확정했습니다.

3. 검증 방법  
   현행 v2 스캐너, 메뉴 Importer의 localhost API 사용, atomic write, 프로젝트 검증, rebuild Bin 생성·복구, 자식 프로세스 실행 경로를 정적 대조했습니다.

4. 남아있는 위험 요소  
   실제 NAS가 SMB byte-range lock과 원자 rename을 정상 지원하는지는 설치 PC에서 self-test가 필요합니다. 지원하지 않으면 v3 워커를 비활성화해야 합니다.

5. 다음 권장 작업  
   이 명세대로 먼저 manifest/lock/journal 순수 파일 계층과 상태 전이 테스트를 구현한 뒤, push 워커와 Importer API를 연결하는 순서가 안전합니다.
