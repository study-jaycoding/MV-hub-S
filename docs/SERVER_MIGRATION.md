---
updated: 2026-10-01
status: active
---

# 공유 서버 이전 절차

공유 서버를 **다른 PC 로 옮길 때**의 절차와 도구. 서버 PC 가 죽어 예비 PC 로 복구할 때도
같은 도구를 쓴다(차이는 [재해복구](#재해복구--옛-서버가-죽어-export-를-못-돌릴-때) 절 하나뿐).

자동 복구 체계·수동 중지 명령은 [SERVER_RECOVERY.md](SERVER_RECOVERY.md), 서버 설정과
운영 변수는 [SERVER.md](SERVER.md), 어떤 상태를 누가 소유하는지는
[DATA_OWNERSHIP.md](DATA_OWNERSHIP.md) 를 따른다.

## 쉬운 이사 — bat 두 번 (2026-10-01)

아래 수동 절차를 묶은 것이다. 표준 배치(세 DB 가 `backend\data\db` 한 폴더, `CONTENT_HUB_DATA`·`CONTENT_HUB_DB`·
TLS 변수 없음)인 서버만 이 길로 옮긴다. 아니면 도구가 시작 전에 멈추고 수동 절차로 보낸다.
설계·검토(Claude 설계 → Codex 적대 검토 3회): 정지 뒤 최종 확인, 하나의 파이썬 고정, 첫 변경 전 되돌리기, IP 를 넘긴 뒤 되돌리기 금지,
기계 변수는 이름 목록만 적용.

**미리 한 번**: 새 코드가 양쪽 PC 에 있어야 한다 — 옛 서버는 평소 업데이트 절차(SERVER.md), 새 PC 는 `update_git.bat`.

| 순서 | 어디서 | 무엇 |
|---|---|---|
| 1 | 옛 서버 | `server_move_OUT.bat` — **무엇이든 바꾸기 전에** 바탕화면에 `MVHub_server_UNDO.bat` 과 되돌리기 기록(`backend\data\server_move_out_state.json`)을 만든다. 그다음 생성 접수 멈춤(DB 값 직접, 관리자 로그인 불필요) → 진행 중 0 대기(최대 15분, 넘으면 멈춤) → 예약 작업 3개 사용 안 함·끝내기·남은 이 저장소 프로세스 정리(목록 보이고 Y) → **정지 상태에서 최종 확인**(0 이 아니면 내보내지 않음) → 바탕화면 `MVHub_server_move_<시각>` 폴더(DB 3종·작업자 백업·보존 모드면 media·`machine_settings.json`) |
| 2 | 사람 | 그 폴더를 새 서버 바탕화면으로(USB·NAS) |
| 3 | 새 서버 | `server_move_IN.bat` — 점검(지난 설치 기록·8010 점유·기존 예약 작업·방화벽 8010·시간대 KST·표준 배치·폴더 충돌, 하나라도 걸리면 **아무것도 안 바꾸고** 멈춤) → 검증(드릴) → 설치(SQLite 엔진 차이 색인 재생성 포함) → 임시 관리자 비밀번호 파일 삭제·생성 접수 원래 값 → 기계 변수(대장·media 보존 이름 목록만)·NAS 복제 경로 → `register_autostart.bat`(설치에 쓴 파이썬을 `MVHUB_SERVER_PYEXE` 로 고정) → ready → BackupCopy 이번 결과 |
| 4 | 사람 | 옛 서버 PC 를 끄거나 랜선 분리 → 새 PC IP 를 옛 값으로(IN 끝 화면의 표). **같은 정확한 URL** 이어야 팀원 PC 의 남은 보고가 이어진다(에이전트 outbox 는 서버 URL 단위) |
| 5 | 사람 | 다른 PC 에서 `http://<옛IP>:8010/api/ready`, 팀원 한 명 접속·생성 1건 → 이사 폴더 사본을 모두 지운다(계정·비밀번호 해시 포함) |

- **되돌리기**: 옛 서버 바탕화면 `MVHub_server_UNDO.bat` — 생성 접수 멈춤을 원래 값으로, 원래 켜져 있던 예약 작업만 켜고 원래 돌던
  서버·워치독만 다시 돌린다(BackupCopy 는 안 돌림). **새 PC 가 옛 IP 를 받은 뒤에는 쓰지 않는다** — 새 서버가 받은 자료가 옛 DB 에 없다.
- **OUT 이 중간에 멈췄을 때**(진행 중 생성이 15분 안에 안 끝남 등): 먼저 UNDO 로 되돌린 뒤 OUT 을 다시 한다. 끝나지 않은 기록이 있으면
  OUT 은 처음 상태를 지키려고 덮어쓰지 않고 멈춘다. OUT·IN 둘 다 이 창이나 기계에 `CONTENT_HUB_DATA`·`CONTENT_HUB_DB`·TLS 변수가 있으면 시작 전에 멈춘다.
- **IN 이 설치 뒤에 멈췄을 때**(작업자 백업 복사·자동시작 등록 실패 등): 원인을 고치고 IN 을 다시 누르면 DB 설치는 건너뛰고 이어서 끝낸다
  (`backend\data\server_move_in_state.json` — DB 설치 직후 디스크에 기록). **처음 설치에 쓴 파이썬·SQLite 와 같을 때만** 이어진다(색인을 그 엔진으로
  다시 만들었으므로). 다른 이사 폴더의 미완료 기록이나 깨진 기록(다른 DB 를 가리키는 것 포함)이 있으면 멈춘다. 이어할 때 지난번에 넣은
  작업자 백업·media 는 내용(파일 목록·크기)이 같으면 건너뛰고, 다르면 합칠지 사람이 정하도록 멈춘다.
- **검증 범위**: DB 3종과 `machine_settings.json` 은 manifest 의 크기·SHA-256 으로 대조한다. 작업자 백업(`db-backups`)·`media` 는
  기존 도구와 같이 **최선 노력**이다 — 이름만 기록하고 내용 해시는 대조하지 않는다(이어하기는 파일 목록·크기로만 '지난번 것'을 가린다).
  작업자 백업은 각 작업자 PC 에도 남아 있어 다시 받을 수 있다.
- **남은 위험(수동 확인)**: 세 bat 은 관리자 권한을 요청할 때 받은 인자(`--package "…"` 등)를 그대로 넘기지만, 공백·따옴표가 든 인자가
  UAC 를 거쳐 그대로 오는지는 자동 시험이 없다. 평소처럼 두 번 눌러(인자 없이) 쓰면 해당 없다.
- 기계 변수는 전부 `machine_settings.json` 에 담기지만 자동 적용은 이름 목록(`CONTENT_HUB_ASSET_REGISTRY*`·`CONTENT_HUB_MEDIA_PRESERVATION*`)만.
  나머지는 IN 이 이름을 보여 주고 필요하면 수동.
- 옮기는 txt 는 `tools\backup_replica_target.txt` 하나. 새 PC 의 SYSTEM 계정이 NAS 에 쓸 수 있는지는 IN 끝의 BackupCopy 결과로 본다.
- 도구: `tools/server_move_easy.py`(out · in · undo-out), 저수준은 아래 `server_move.py` 그대로.

### 연습(리허설) — 진짜 이사 전에 새 PC 에서 미리 보기 (2026-10-01)

OUT 은 시작할 때 **1 = 연습 / 2 = 진짜 이사**를 묻는다. 고른 값은 이사 폴더(`machine_settings.json` 의 `purpose`)가 들고 가고
IN 은 묻지 않고 그대로 따른다(옛 서버를 꺼 둘지가 OUT 에서 정해지므로). 설계: Claude → Codex 적대 검토 3회(P1 11건 반영).
10-01 Jay 결정(Codex 승인): **연습 OUT 은 서버를 멈추지 않는다** — 읽기 전용으로 둘러보고 버리는 자료라 누른 순간의 사진이면 된다.

| 순서 | 어디서 | 무엇 |
|---|---|---|
| 1 | 옛 서버 | `server_move_OUT.bat` → **1(연습)**. 이 서버는 **아무것도 바꾸지 않는다**(접수 멈춤·정지·OUT 기록·UNDO bat 없음, 팀은 그대로 씀). 켜진 DB 3종을 온라인 백업으로 찍어(`cmd_export(live_snapshot=True)`, 서버 자동 백업과 같은 원리) 바탕화면 `…_rehearsal` 폴더로. 작업자 백업·media 는 담지 않는다 |
| 2 | 사람 | 그 폴더를 새 서버 바탕화면으로 |
| 3 | 새 서버 | `server_move_IN.bat` — **진짜 자리 기준 점검을 그대로**(최종 날 막힐 것을 지금 찾음 + Node·파이썬 패키지·화면 빌드·도구 파일·빈 공간) → 드릴 → `backend\data-rehearsal` 에만 설치 → 생성 접수 멈춤 → **읽기 전용** 연습 서버 창 |
| 4 | 사람 | 다른 PC 브라우저로 `http://<새 PC IP>:8010` 로그인·자료 확인. 저장·생성·설정 변경은 403 이 정상. 앱의 공유 서버 주소는 바꾸지 않는다 |
| 5 | 진짜 이사 날 | 옛 서버 OUT → **2(진짜)** → 새 폴더로 IN(위 표). IN 이 연습 서버를 끄고 진짜 자리에 설치, 끝에 연습 폴더를 지울지 묻는다 |

- **연습 사진의 한계**: 누른 뒤의 변경은 담기지 않고, 세 DB 를 차례로 찍어(셋 다 찍은 뒤 검사·해시) DB 사이에 시점 차가 있다 — 그 사이 휴지통
  이동·복원 한두 건이 겹치거나 빠질 수 있다(서버 자동 백업과 같은 한계). 찍는 순간 진행 중이던 생성은 연습 서버에 '진행 중'으로 보일 뿐이다.
  연습은 **로그인·자료(DB) 확인**이며 media 가 필요한 화면·작업자 백업 복원은 확인하지 않는다. OUT 의 '서버 멈추기' 단계는 진짜 이사 날 처음 돈다.
- **진짜 자리를 건드리지 않는다**: 연습은 `backend\data-rehearsal`(gitignore)에만 풀고, 예약 작업·기계 변수·`tools\backup_replica_target.txt`·
  `.mvhub-runtime\python.txt` 는 손대지 않는다. 다시 연습하면 지난 연습 폴더를 **다 지운 뒤**(남으면 멈춤) 새로 푼다. 링크·연결 폴더이거나 진짜
  데이터 폴더와 겹치거나 이사 폴더가 그 안에 있으면 지우지 않는다.
- **연습 서버는 읽기 전용**(`CONTENT_HUB_READ_ONLY=1`): GET·HEAD·OPTIONS 와 로그인(POST `/api/auth/access`·`login`·`logout`) 외 요청은 403.
  사본 DB 에 든 운영 경로로 렌더 폴더에 쓰거나(최종본 저장·미러) 옮기는 일, 에이전트 push 가 막힌다. 사본 밖을 건드리는 백그라운드
  (임시파일 청소 — 사본 DB 의 Comfy 입력 폴더를 지울 수 있음, 에셋 대장, media 보존, 주기 동기화)도 켜지 않는다. 사본 DB 안의 로그인·캐시 갱신까지
  막는 모드는 아니다. 서버 환경은 부모의 `CONTENT_HUB_*` 를 하나도 물려받지 않고 전부 명시한다(MV_server.bat 은 빈 값일 때만 기본값을 넣으므로).
  파이썬은 설치에 쓴 것(`PYEXE`) — 색인을 다시 만든 SQLite 와 같은 엔진. 복원 드릴도 같은 읽기 전용으로 띄운다.
- **오래된 폴더로 진짜 이사 막기**: 지금까지 푼 연습 폴더 중 가장 새 것의 시각을 `.mvhub-runtime\server_move_rehearsal.json` 에 남긴다(연습 폴더를
  지우기 **전에** 먼저 써서 끊겨도 줄지 않음). 진짜 IN 은 그보다 새 폴더만 받는다. 그래서 진짜 OUT 을 한 뒤에 연습을 또 하면 그 진짜 폴더도
  거부된다 — 옛 서버 UNDO 후 진짜 OUT 을 다시 한다(연습은 진짜 OUT 전에 끝낸다). '가장 최신'을 보증하는 것이 아니라 연습에 쓴(또는 더 오래된) 폴더로
  진짜 자리를 덮는 실수만 막는다.
- **진짜 IN 의 옛 서버 확인**: 옛 서버 주소(`settings.server_url`)의 `/api/ready` 가 200 이면 거부. 응답이 없으면 '꺼졌다'는 증거가 아니므로
  "옛 서버가 지금도 꺼져 있고 OUT 뒤에 UNDO 하지 않았습니까?" 를 사람에게 묻는다.
- 진짜 새 설치는 이 PC 의 옛 자동 백업(`backend\data\backups`, 예: 빈 DB 시험 서버의 것)을 바뀐 DB 와 같은 보관 폴더로 옮긴다 — 남겨 두면 BackupCopy 가
  새 서버 백업과 섞어 NAS 로 복제한다. 못 옮기면(열린 파일 등) 들여오기 기록을 남기기 전에 멈추고, 다시 누르면 새 설치로 다시 시도한다.
- 설치 전 공간 점검은 실제 설치 기준(DB × 2 + 256MiB)에 작업자 백업·media 복사분을 더해 본다. Node 는 등록과 같이 `node --version`·`npm --version` 까지.
- 연습 서버가 ready 가 안 되거나 기다리는 중 Ctrl+C 를 누르면 띄운 창(감독기·서버)을 끄고, 끄지 못했으면 '직접 닫으라'고 알린다.
- UNDO 는 OUT 전에 응답하던 서버면 **지금 응답해야** 되돌린 것으로 본다(작업이 이미 Running 인데 응답이 없는 두 번째 UNDO 포함).
- **연습에서 확인 못 하는 것**: SYSTEM 계정의 NAS 쓰기·예약 작업 실제 실행(진짜 IN 끝의 BackupCopy 결과로 본다).

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
12. 옛 서버에서 에셋 대장을 켜 썼으면 **먼저 기계 환경변수 두 개**를 넣는다(관리자 PowerShell, 새 창에서 13단계부터):
    `[System.Environment]::SetEnvironmentVariable('CONTENT_HUB_ASSET_REGISTRY','1','Machine')` 와
    `CONTENT_HUB_ASSET_REGISTRY_DRIVES` 를 같은 방식으로(값은 [ASSET_REGISTRY.md](ASSET_REGISTRY.md) §6). 그다음
    `MV_server.bat` 으로 한 번 띄우고 `/api/ready` 200 을 확인한다.

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
| 에셋 대장이 조용히 꺼진다 | 켜기 변수는 PC 의 기계 환경변수라 도구가 옮기지 않는다(훑는 곳 선택·대장 번호는 DB 라 따라온다) | 12단계의 두 변수를 넣고, 이사 뒤 관리자 창 '에셋 대장' 탭에 표가 보이는지 확인 |
| 검증이 `missing from index idx_credit_txn_julian` 로 멈춘다(옛 도구) | 새 PC 의 SQLite 가 옛 서버와 다르면 계산식 색인(`julianday(created_at)` 등) 키가 어긋난다 — 3.45 는 초 소수 .9995 이상을 다음 초로 올리고 3.49 이상은 .999 에서 멈춘다(2026-10-01 실측). 자료는 멀쩡하지만 새 엔진에서 그 행을 지우면 `database disk image is malformed` | 지금 도구는 **계산식 색인 어긋남만** 알아보고 복원·설치 사본에서 새 PC 엔진으로 다시 만든 뒤 엄격 재검사한다(화면에 "색인을 새로 만듦"). 원본 백업·패키지는 안 건드림. 다른 종류의 오류가 섞이면 지금처럼 멈춘다. 이사 도구 밖 복구 경로(작업자 백업 복원 등)는 `quick_check` 라 이 어긋남을 못 본다 — 후속 |

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
