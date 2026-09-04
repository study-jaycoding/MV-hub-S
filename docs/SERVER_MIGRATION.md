---
updated: 2026-09-04
status: active
---

# 공유 서버 이전 절차

공유 서버를 **다른 PC 로 옮길 때**의 절차와 도구. 서버 PC 가 죽어 예비 PC 로 복구할 때도
같은 도구를 쓴다(차이는 [재해복구](#재해복구--옛-서버가-죽어-export-를-못-돌릴-때) 절 하나뿐).

자동 복구 체계·수동 중지 명령은 [SERVER_RECOVERY.md](SERVER_RECOVERY.md), 서버 설정과
운영 변수는 [SERVER.md](SERVER.md), 어떤 상태를 누가 소유하는지는
[DATA_OWNERSHIP.md](DATA_OWNERSHIP.md) 를 따른다.

## 도구

| 명령 | 어디서 | 하는 일 |
|---|---|---|
| `server_move_export.bat <빈 폴더>` | 옛 서버 | 운영 DB 3종을 스냅샷 + SHA-256 manifest |
| `server_move_import.bat <폴더>` | 새 PC | **검증만** — 격리 폴더에 복원하고 격리 서버로 로그인까지 확인 |
| `server_move_import.bat <폴더> --install` | 새 PC | 실제로 운영 DB 교체 |

`--install` 을 붙이지 않으면 아무것도 바꾸지 않는다. 항상 검증부터 한 번 돌린다.

## ★ 서버를 먼저 멈춰야 하는 이유

`export` 와 `--install` 은 **서버가 완전히 멈춘 상태에서만** 동작한다. 도구가 강제한다.
편의 문제가 아니라 데이터 유실 문제다.

1. **export 이후의 쓰기가 통째로 사라진다.** 서버를 켜 둔 채 패키지를 만들고 나중에
   서버를 내리면, 그 사이에 들어온 댓글·공유·계정 변경·프로젝트 변경이 새 서버에 없다.
   `generation_deployment_paused` 는 **생성 접수만** 막고 다른 쓰기는 막지 않는다.
2. **휴지통 항목이 양쪽에서 함께 사라질 수 있다.** content 스냅샷을 뜬 뒤 trash 스냅샷을
   뜨기 전에 누가 휴지통에서 **복원**하면, 그 행은 content 스냅샷에도(아직 복원 전) trash
   스냅샷에도(이미 복원 후) 없다. 반대 방향(삭제)으로 생기는 중복은 부팅 정합기가
   정리하지만, 이 누락은 **감지도 복구도 되지 않는다.**

서버를 먼저 멈추면 두 문제가 함께 없어진다.

도구가 요구하는 "멈춤"의 조건:

- 예약 작업 `MVHub Server`·`MVHub Watchdog` 이 **Disabled** (Ready·Running 이면 거부)
- 이 설치본의 `backend\serve.py`·`server_supervisor.py`·`server_watchdog.py` 프로세스 없음
- 서버 포트에 다른 점유자 없음
- DB 3종의 WAL 정리가 `busy=0`, 쓰기 잠금 확보 가능

> [!IMPORTANT]
> `schtasks /End` 만 하면 **재부팅 때 되살아난다.** `/DISABLE` 을 먼저 걸고 `/End` 한다.
> 조회 자체가 실패하면 도구는 "멈췄다"로 보지 않고 중단한다.

> [!WARNING]
> 이 검사는 위험을 크게 줄이지만 **정지를 증명하지는 못한다.** 서버와 도구가 공유하는
> 배타적 운영 lease 가 코드에 없기 때문이다. 다음은 여전히 통과한다 —
> ① 문서가 허용하는 `python -m uvicorn ...` 직접 실행,
> ② 다른 설치본이 같은 데이터 폴더를 다른 포트로 쓰는 경우,
> ③ 검사 통과 직후에 새로 시작하는 쓰기.
> 도구는 교체 직전에 한 번 더 확인하지만 그 사이의 경쟁까지 없애지는 못한다.
> **표준 중지 절차를 사람이 먼저 지키는 것이 여전히 안전의 근거다.**

## 1단계 — 새 PC 미리 준비 (옛 서버 켜둔 채, 며칠 전에 해도 됨)

1. Python·Node 설치
2. `setup_clone_git.bat` 로 저장소 클론 (서버는 릴리스 ZIP 이 아니라 **git 클론**)
3. 방화벽에서 서버 포트(기본 8010) 인바운드 허용
4. 연습 — 아무 옛 백업 세트로 검증만 한 번 돌려 본다

```powershell
$env:CONTENT_HUB_EXTERNAL_RECOVERY = "0"
py -3 tools\verify_backup_restore.py --backup-set "E:\MVHub-backups\content_hub_<stamp>.db"
```

## 2단계 — 실제 이사

5. 팀에 "팀 공유 잠시 중단" 공지하고 생성 접수를 멈춘다([SERVER.md](SERVER.md) 의
   `deployment-pause`). 진행 중 생성이 0 인지 `tools\deploy_fence_check.py` 로 확인한다.
6. **옛 서버를 완전히 멈춘다** — 워치독 먼저, `/DISABLE` 을 먼저 걸고 `/End`
   ([SERVER_RECOVERY.md](SERVER_RECOVERY.md) 의 "수동 중지").
7. 옛 서버에서 패키지를 만든다.

   ```
   server_move_export.bat D:\move
   ```

   화면에 찍히는 **데이터 폴더 경로가 이 서버가 실제로 쓰던 것인지 반드시 확인한다.**
   예약 작업은 SYSTEM 계정으로 돌아 콘솔과 환경변수가 다를 수 있다. 다르면
   `--data-dir` 로 실제 경로를 지정한다.

8. `D:\move` 를 새 PC 로 옮긴다(USB·NAS).
9. 새 PC 에서 **검증만** 먼저 돌린다.

   ```
   server_move_import.bat D:\move
   ```

   manifest 의 크기·SHA-256 전량 대조 → 격리 폴더에 실제 복원 → 격리 서버 기동 →
   ready·로그인·행수 대조까지 통과해야 한다. 하나라도 실패하면 설치하지 말고 이전 세트로
   다시 시도한다.

10. 이상 없으면 설치한다.

    ```
    server_move_import.bat D:\move --install
    ```

11. 새 PC 에 서버 IP 를 설정한다. **옛 IP 를 그대로 쓰면 팀원은 아무것도 바꿀 필요가 없다.**
12. `MV_server.bat` 으로 한 번 띄우고 `/api/ready` 200 을 확인한다.

## 3단계 — 마무리

13. 팀원 1명에게 접속·로그인·팀 탭 확인 요청
14. `register_autostart.bat` (자동시작 등록 + NAS 백업 복제 경로 **재설정**)
15. IP 가 바뀌었으면 앱에서 **[팀에 공지]** ([SERVER_RELOCATION.md](SERVER_RELOCATION.md))
16. **생성 접수 재개** — 아래 "놓치기 쉬운 것" 참고
17. 옛 서버 PC 는 1~2주 **켜지 말고** 그대로 보관한다(되돌릴 수 있게)

## 놓치기 쉬운 것

| 함정 | 왜 | 어떻게 |
|---|---|---|
| 새 서버가 생성이 멈춘 채로 뜬다 | `generation_deployment_paused` 는 content DB 의 `app_setting` 에 있어 **백업을 타고 따라온다** | 설치 후 `deployment-pause` 를 `false` 로 되돌린다 |
| 옛 서버가 재부팅으로 되살아난다 | `schtasks /End` 는 현재 인스턴스만 멈춘다 | `/DISABLE` 을 먼저 |
| 둘 다 켜져 데이터가 갈라진다 | 같은 IP 면 충돌, 다른 IP 면 팀원이 나뉜다 | 옛 서버를 먼저 완전히 멈춘 뒤 새 서버를 켠다 |
| 엉뚱한 DB 를 가져간다 | 예약 작업(SYSTEM)과 콘솔의 `CONTENT_HUB_DATA` 가 다를 수 있다 | export 가 찍는 경로를 확인, 필요하면 `--data-dir` |
| 옛 PC 경로가 DB 안에 남는다 | `project.render_root_path` 등 | 설치 후 도구가 목록을 찍는다. 새 PC 에서 접근되는지 확인 |
| NAS 백업 복제가 조용히 멈춘다 | 복제 대상은 머신별 설정이고 SYSTEM 계정 권한이 필요하다 | `register_autostart.bat` 에서 다시 지정하고 1회 실행해 로그 확인 |

## 무엇을 가져가고 무엇을 두고 가나

**가져간다 (도구가 자동)**

| 파일 | 무엇 |
|---|---|
| `content_hub.db` | 서버 메인 — 계정·권한·공유·프로젝트·생성 요청·감사·설정 |
| `content_hub_trash.db` | 휴지통 |
| `manage_hub.db` | PM·크레딧·팀 통계 |

세션 서명 시크릿은 content DB 의 `app_setting` 에 있어 함께 따라온다(환경변수로 지정한
설치는 환경변수가 우선).

**선택 (플래그로)**

- `--with-worker-backups` — `db-backups\` . 팀원이 "서버 백업에서 복원"으로 되찾는 이력.
  안 가져가면 그 목록이 빈다. 팀원 PC 복구 수단이므로 계획 이전에서는 가져가길 권한다.
- `--with-media` — `media\` . 기본 URL-only 정책에서는 캐시라 없어도 된다.
  `CONTENT_HUB_MEDIA_PRESERVATION=1` 로 원본을 보존해 온 설치라면 필요하다.

`--install` 은 패키지에 담긴 이 폴더들도 함께 설치한다. **새 PC 에 같은 이름의 폴더가 이미
있으면 덮어쓰지 않고 건너뛴다** — 어느 쪽이 최신인지, 어떻게 합칠지는 도구가 정할 문제가
아니다. 그 경우 화면에 양쪽 경로를 찍으니 사람이 판단한다. `--backup-set` 모드에는
이 폴더가 없으므로 아무것도 설치하지 않는다.

**두고 간다 (새 PC 신원과 충돌한다)**

| 파일 | 이유 |
|---|---|
| `device_identity.json` | 이 PC 식별자. 새 PC 는 새 ID 여야 한다 |
| `active.json` | 로컬 허브 계정 포인터. AUTH-on 서버는 무시하지만 남기면 나중에 충돌 |
| `worker_backup_state.db`, `worker-backup-outbox\` | 작업자 PC 의 업로드 상태·옛 경로 |
| `resolve\` | Resolve host-id·기기 lock |
| `cost_cache.json` | 재생성된다 |
| `bootstrap_admin_password.txt` | 일회용 평문. 비밀번호 해시는 DB 안에 있다 |
| `.mvhub-runtime\`, `backup_replica_status.json`, `tools\backup_replica_target.txt` | 옛 PC 의 절대경로·작업 상태. 새 PC 에서 다시 만든다 |
| `assets\` | 작업자 로컬 파일. 서버를 작업자로도 썼을 때만 수동 이전 |
| `backups\` | 과거 백업 이력. NAS 원본을 그대로 두면 된다 |
| `db\acct\` | 계정별 로컬 DB. **AUTH=1 공유 서버는 읽지 않는다**(로컬 허브로 쓰던 흔적) |

> [!NOTE]
> `db\acct\` 와 `backups\<계정슬러그>\` 는 `AUTH_ENABLED` 일 때 코드가 아예 만들지 않는다
> (`app/active_account.py` 의 `account_key()`, `app/services/backup.py`). 공유 서버에 이것이
> 있다면 과거에 그 폴더를 로컬 허브로 썼다는 뜻이므로, 개인 데이터로 보고 옮기지 않는다.

## `CONTENT_HUB_DB` 를 쓰는 설치

세 DB 의 위치 규칙이 서로 다르다.

| DB | 어디 | 근거 |
|---|---|---|
| content | `CONTENT_HUB_DB` 가 있으면 그것 | `app/db_paths.py` |
| trash | **content 와 같은 폴더** | `app/repo/trash.py` `_trash_path()` |
| manage | `<CONTENT_HUB_DATA>\db\` 고정 | `app/manage_db.py` `MANAGE_DB_PATH` |

`export` 는 이 규칙을 그대로 따라 짝이 맞는 세트를 만든다. 하지만 `--install` 은 세 파일이
**같은 폴더**에 있는 표준 배치만 설치하고, 갈라져 있으면 거부한다. 일부만 교체되어
content·trash 는 옛것, manage 만 새것인 혼합 상태가 되는 것을 막기 위해서다.
`CONTENT_HUB_DB` 를 해제하거나 `--data-dir` 를 실제 폴더로 맞춘 뒤 실행한다.
`MV_server.bat` 은 `CONTENT_HUB_DB` 를 설정하지 않으므로 보통은 해당 없다.

## 실패하면

설치는 **staging 을 다 만들고 검사까지 끝낸 뒤에야** 기존 파일을 건드린다.

1. 같은 볼륨에 staging 3개 생성 + 검사 — 여기까지 기존 DB 는 손대지 않는다
2. 서버 중지 재확인 + WAL 정리
3. 기존 DB 를 `db\_before_move_<stamp>\` 로 이동(같은 볼륨 rename)
4. staging 을 최종 이름으로 rename
5. 설치 결과 재검증(스키마·행수)

3~5 중 어디서 실패해도 보존 폴더에서 자동으로 되돌린다. 롤백까지 실패하면 자동 복구를
멈추고 `db\.server_move_journal.json` 에 상태를 남긴다 — 그 파일과 `_before_move_<stamp>\`
를 보고 사람이 판단한다. 그 파일이 남아 있으면 도구는 다음 실행을 거부한다.

성공하면 기존 DB 는 `db\_before_move_<stamp>\` 에 그대로 남는다.
**새 서버가 정상임을 확인할 때까지 지우지 않는다.**

## 재해복구 — 옛 서버가 죽어 export 를 못 돌릴 때

NAS 자동백업 세트에서 바로 설치한다.

```
server_move_import.bat --backup-set "\\NAS\share\mvhub_backup\content_hub_<stamp>.db"
server_move_import.bat --backup-set "\\NAS\share\mvhub_backup\content_hub_<stamp>.db" --install
```

같은 폴더에서 **정확히 같은 stamp** 의 `content_trash_*.db`·`manage_hub_*.db` 를 찾는다.
셋 중 하나라도 없으면 아무것도 하지 않는다.

이 경로에는 manifest 가 없다. 무결성과 세트 구성은 확인하지만 **원래 백업 시점의 SHA 진위는
확인할 수 없다.** 도구가 화면에 그렇게 표시한다.

이 절 전체는 [SERVER_RECOVERY.md](SERVER_RECOVERY.md) 의 "예비 PC 복구 절차"와 같은 일이다.
그쪽의 1번(**원 서버 전원 차단**)과 2번(고정 IP)은 여전히 사람이 먼저 해야 한다.

## 월 1회 리허설과의 관계

`server_move_import.bat <폴더>`(검증만)은 실제 설치와 **같은 검증 엔진**을 쓴다. 그래서
리허설에서 통과한 것이 실제 복구에서도 통과한다.

다만 이 도구 하나가 리허설 전체를 대신하지는 않는다. 작업자 계정 세트 복원, 자동시작,
워치독 확인은 [SERVER_RECOVERY.md](SERVER_RECOVERY.md) 의 체크리스트를 그대로 따른다.
