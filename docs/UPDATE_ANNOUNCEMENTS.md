---
aliases:
  - 업데이트 공지 계약
  - 릴리스 알림 관리
tags:
  - mvhub
  - mvhub/운영
  - mvhub/업데이트
status: active
updated: 2026-10-02
---

# 업데이트 공지 관리 계약

## 목적

팀원이 보는 업데이트는 **관리자가 [공지]를 누른 판만**이다(Jay 2026-10-02, B안). 릴리스 스크립트는 NAS
릴리스 폴더에 **후보**만 올리고, 관리자 창 **업데이트 탭**의 [공지]가 공지와 동시에 팀원 PC 가 보는
**표지**(`latest.json`)를 그 후보로 바꾼다. 관리자 PC 도 공지 뒤에 설치한다(1단계 — 후보 선설치는 나중 설계).
일반 사용자는 공지를 발행할 수 없다. 받은 공지를 클릭하면 업데이트 실행 흐름이 열린다 — 새 버전 공지는 그
자리에서 한 번 더 확인을 묻고, **서버 이사 공지는 확인창 없이 즉시 전환**한다(`components/NotificationCenter.tsx`).

설계 기록: Claude 설계 r1~r4 · Codex 적대적 검토 4회(r4 조건부 승인) · 코드 리뷰 승인(2026-10-02).

## 릴리스 폴더의 파일

| 파일 | 쓰는 쪽 | 뜻 |
| --- | --- | --- |
| `MVHub-<버전>.zip` | `release/make_release.ps1` | 판. **한 번 올린 이름은 바뀌지 않는다** — 같은 이름에 다른 지문이면 게시를 거부한다 |
| `candidate.json` | make_release(새 후보) · select_release(되돌리기 때 공개본과 같게) | 다음에 공지할 후보. 팀원 PC 는 읽지 않는다 |
| `latest.json` | 관리자 창 [공지](promote) · select_release | **표지** — 모든 팀원 PC 의 '업데이트 있음'·설치·첫 설치기가 이것만 본다 |
| `latest-backups\latest.previous-*.json` | promote · select_release | 표지를 바꾸기 전 원본(고유 접미사) |
| `release.lock` | 세 쓰기자 공통 | 공유 없이 연 동안이 잠금(아래). 파일은 남겨 둔다 |
| `MVHub_Install.bat` | 사람 | 공용 첫 설치기. make_release 는 **복사하지 않는다**(아래 '설치기') |

후보와 표지는 필드가 같다(`version`·`higgsfield_cli_version`·`file`·`sha256`·`size`·`created_at`, UTF-8 BOM).
[공지]는 후보 원문 바이트를 그대로 표지로 옮긴다.

## 흐름

1. `make_release.ps1` — 빌드 전에 같은 이름 zip 이 있거나 출력 폴더가 게시 폴더면 멈춘다. 게시 폴더에 zip 을
   `.part-<guid>` 로 복사한 뒤 덮어쓰기 없는 이동으로 확정하고, 잠금 안에서 `candidate.json` 을 쓴다.
   팀원 PC 에는 아무 변화가 없다.
2. 관리자 창 **업데이트 탭** — 로컬 `GET /api/release-update/latest-metadata` 가 후보(없으면 표지)와 공개
   상태(`published`·`published_state`·`pending`)를 준다. 실제 배포 경로는 내보내지 않는다. 새 후보면 노란 상자
   "새 후보 v… — 아직 팀원에게는 안 보입니다 [목록에 등록]"(관리자 설정 화면에도 "새 후보 v…" 한 줄).
3. **[공지]**(처음) — 공유 서버에 공지(회차 +1, 팀원 알림) → 로컬 `POST /api/release-update/promote`.
   promote 는 공유 서버 단건 조회(`GET /api/update-notices/admin/item?sha256=`)로 **그 항목이 공지됐는지·id·
   version·file·size·sha 가 후보와 같은지** 확인하고, zip 실물의 크기·전체 sha256 을 검증한 뒤(잠금 밖),
   잠금 안에서 두 표지가 처음 읽은 바이트 그대로인지 다시 보고 → 백업 → 표지 교체. 그때부터 모든 PC(관리자
   포함)에 '업데이트 있음'.
4. **[재공지]** — 알림만 다시(회차 +1). 표지는 **바꾸지 않는다** — 되돌린 판이 재공지로 되살아나지 않게.
5. **[배포 반영]** — 드물게: 공지는 됐는데 표지 교체만 실패했을 때 그 줄에만 보인다. 알림 없이 promote 만.
6. **[해제]** — 확인 창 뒤 공유 서버 `DELETE /api/update-notices/admin/{id}` → 목록과 팀원 알림에서만 지운다
   (읽음 기록은 FK CASCADE). 설치 파일·표지·후보는 그대로. 없는 항목도 성공(`removed: false`).

## 되돌리기·전환

- 되돌리기는 지금처럼 `release/select_release.ps1 -PackagePath <zip>` — 잠금 안에서 **후보 먼저, 표지
  마지막**으로 같은 내용을 쓴다. 공지 전 후보가 있었으면 "cancelled by this selection" 으로 알린다(그 후보는
  취소된다). 표지 전환만 실패하면 "latest.json was NOT switched; run the same command again", 결과를
  확인하지 못했으면 "could not be confirmed — check latest.json" 로 나눠 알린다.
- **처음 B안이 들어간 판**은 관리자 PC 가 아직 옛 앱이라 [공지]로 표지를 못 바꾼다 → 그 판만 select_release 로
  공개하고 옛 흐름(등록·공지)으로 알린다. 관리자 PC 가 새 판이 되고 관리자 창을 새로 연 뒤부터 B 흐름.
- 공유 서버도 한 번 업데이트한다(단건 조회·DELETE). 옛 서버면 promote 가 "공유 서버를 업데이트한 뒤
  배포할 수 있습니다", [해제]가 같은 안내를 낸다.

## 잠금·교체 규칙(세 쓰기자 공통)

- `release.lock` 을 공유 없이 연다(PowerShell `[IO.File]::Open(…,'None')` — `release/release_manifest_io.ps1`,
  Python `_winapi.CreateFile(share=0)` — `services/release_update.py`). 공유 위반이면 10초까지 기다린다.
  핸들을 닫으면 풀리므로 잠금 파일을 지울 일이 없다. 원격 장애 때는 서버가 연결을 정리할 때까지 해제가 늦을
  수 있다.
- 교체는 같은 폴더 임시 파일 → 대상이 있으면 `File.Replace`/`os.replace`, 없으면 덮어쓰기 없는 `File.Move`.
  PowerShell 5.1 의 `Move-Item -Force` 는 '삭제 후 이동'이라 쓰지 않는다. 실패하면 대상을 다시 읽어
  **무변경(임시 파일 정리) / 새 내용 반영(성공) / 확인 불가(임시 파일 보존·그렇게 알림)** 로 나눈다.
- 공개 표지를 못 읽으면(`published_state: error`, `pending: null`) 화면은 '배포 상태 확인 불가'로 [공지]·
  [배포 반영]을 막는다. 후보 파일이 깨졌으면 `candidate_error` 로 알리고 첫 [공지]를 모두 막는다(재공지는 됨).
  깨진 표지는 promote 가 고쳐 쓰지 않는다 — select_release 로 고친다.
- **보장 범위**: 공식 설치 경로(표지)의 공개 시점을 [공지]에 묶는다. `release.lock` 은 이 규칙에 참여하는
  쓰기자만 직렬화한다(옛 스크립트·손 복사·NAS 내부 작업은 막지 못함). 후보 zip 의 비공개·위조 서버 방어는
  범위 밖이고, 최종 쓰기 권한은 NAS 릴리스 폴더 권한(관리자 PC 만 쓰기)이다. 드라이브 문자와 UNC 처럼 다른
  이름의 같은 폴더는 출력=게시 폴더 검사가 가려내지 못한다. 실제 SMB/NAS 에서의 잠금·교체는 미실측이다.

## 설치기(`MVHub_Install.bat`)

공지 전에 공용 첫 설치기를 바꾸지 않도록 make_release 는 복사하지 않고, 다르면 경고만 한다. 바꿔야 하는 판은
공지 뒤에 **옛 공개 판과 함께 설치되는지 확인한 다음**, 릴리스 폴더에 임시 이름으로 복사하고 교체한다:

```powershell
$Dir = "\\NAS\...\packages"   # 릴리스 폴더
Copy-Item -LiteralPath .\release\packages\MVHub_Install.bat -Destination "$Dir\MVHub_Install.bat.new"
[System.IO.File]::Replace("$Dir\MVHub_Install.bat.new", "$Dir\MVHub_Install.bat", [NullString]::Value)
```

## 최근 5개와 고정 규칙

- 화면에는 최대 5개만 표시한다. DB의 이전 기록을 삭제하는 것이 아니라 목록에서만 밀려난다.
  단, 현재 후보가 목록 밖으로 밀렸으면 단건 조회로 찾아 맨 위에 보인다.
- 고정 항목을 먼저 표시하고, 남는 자리는 최신 미고정 항목으로 채운다.
- 고정은 최대 4개다. 따라서 새 업데이트가 들어왔을 때 최소 한 자리는 항상 남는다.
- 같은 SHA256을 다시 등록하면 새 항목을 만들지 않고 기존 항목의 메타데이터만 갱신한다.
- 파일명이 같아도 SHA256이 다르면 서로 다른 업데이트로 취급한다.

## 공지와 읽음 규칙

- 등록만 한 업데이트는 일반 사용자에게 보이지 않는다. **공지**를 눌러야 보인다.
- 같은 업데이트를 다시 공지하면 공지 회차가 증가해 모든 사용자에게 다시 미확인으로 나타난다.
- 읽음 상태의 기준은 브라우저 저장소가 아니라 공유 서버 DB다. 다른 PC에서도 같은 계정이면
  동일하게 이어진다.
- 알림 센터는 서버 공지와 설치 완료 알림을 보인다(로컬에서 새 버전을 감지해 따로 띄우는 알림은 없다).
- 서버가 잠시 응답하지 않으면 마지막으로 받은 알림 목록을 유지하고 다음 조회 때 복구한다.

## 권한과 서버 경계

- 조회와 읽음 처리는 로그인 사용자에게 허용한다.
- 등록·고정·공지·단건 조회·해제 API는 공유 서버의 `Admin` 권한을 다시 확인한다. 프런트 화면을 숨기는 것만으로
  권한을 판단하지 않는다. 로컬의 저장된 역할(`publish._is_admin`)은 설정 화면 '새 후보' 한 줄 표시에만 쓴다.
- 작업자 PC는 관리 요청을 공유 서버로 전달하고, 공유 서버가 최종 권한과 DB 변경을 책임진다. promote 는
  이 PC 전용 경로(`/api/release-update/*`, 로컬 요청만)이며 '공지됐나'는 공유 서버가 판정한다.

## 검증 기준

- 시험: `backend/tests/test_release_promote.py`(overview·promote·잠금 교차·교체 실패 셋·라우트),
  `test_select_release_backups.py`(후보=표지·취소 안내·표지 전환만 실패·잠금 대기),
  `test_release_update.py`(make_release 계약), `test_update_notices.py`(단건·해제),
  `frontend/tests/updateNoticesSection.test.tsx`(처음 공지만 배포·재공지 알림만·배포 반영·해제·확인 불가).
- 최신 업데이트가 들어오면 오래된 미고정 항목이 밀리는지, 고정 4개가 유지되면서 최신 미고정 1개가 보이는지.
- 공지 → 읽음 → 재공지 순서에서 재공지가 다시 미확인으로 보이는지.
- 일반 사용자의 관리 API 호출이 `403`으로 거부되는지, 같은 SHA256 재등록이 중복 행을 만들지 않는지.
