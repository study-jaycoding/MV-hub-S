# 공유 서버 운영·복구 가이드

공유 서버(사무실 PC 1대, `MV_server.bat`, 포트 8010)의 자동 복구 체계와,
서버 PC 자체가 죽었을 때 예비 PC로 복구하는 절차.

## 자동 복구 체계 (3겹)

| 겹 | 담당 | 잡는 장애 |
|---|---|---|
| 1 | `tools/server_supervisor.py` | 프로세스 **크래시** — 지수 대기 후 재기동, 빠른 실패 5회면 폭풍 차단·ALERT |
| 2 | `MV_watchdog.bat` → `tools/server_watchdog.py` | **행**(프로세스가 실제로 무응답) — busy·유지보수는 경보만, `dead` 연속 3회만 정확한 serve.py PID를 종료 → 1겹이 재기동 |
| 3 | 작업 스케줄러 (`register_autostart.bat`) | **PC 재부팅**(Windows 업데이트 등) — 부팅 시 로그인 없이 서버+워치독 자동 시작 |

여기에 더해 앱 자체가 로컬 우선 구조라, 서버가 죽어도 팀원 개인 작업(생성)은
각자 로컬 허브에서 계속된다. 멈추는 건 팀 공유·팀 탭·매니징 집계뿐.

### 설치 (서버 PC에서 1회 — 더블클릭 한 번)

`register_autostart.bat` 를 **더블클릭**한다. 관리자 권한은 스스로 요청하고,
안에서 전부 처리한다:

1. NAS 백업 복제 경로를 물어본다(Enter 로 건너뛰기 가능, 나중에 설정 가능)
2. 자동시작 작업 3개 등록:
   - `MVHub Server` — 부팅 +1분에 MV_server.bat (콘솔 출력 → `logs\server_console.log`)
   - `MVHub Watchdog` — 부팅 +2분에 MV_watchdog.bat (→ `logs\watchdog_console.log`)
   - `MVHub BackupCopy` — 매일 03:30 백업 원격 복제 (→ `logs\backup_console.log`)
3. 서버·워치독을 즉시 시작한다(재부팅 불필요). 이미 콘솔 창에서 돌던 서버가
   있으면 안전하게 멈추고 자동시작 쪽으로 넘긴다.

이후 일상 사용에서 할 일은 없다. **MV_server.bat 를 수동으로 띄우지 말 것**
(이미 배경에서 돌고 있어 포트 충돌). 예전 콘솔 창 대신 로그는
**`MV_logs.bat` 더블클릭**으로 실시간 확인한다.

### 백업 원격 복제 대상 설정

설치 때 물어보는 NAS 경로가 이것이다. 건너뛰었다면 나중에
`tools\backup_replica_target.txt` 파일을 만들고 첫 줄에 대상 경로를 적는다.

```
\\NAS\share\mvhub_backup
```

- **반드시 UNC 경로**(`\\장비\공유폴더\...`)를 쓸 것. 복제 작업은 SYSTEM 계정으로
  돌아서 `Z:` 같은 사용자 매핑 드라이브가 **안 보인다**. NAS 쪽에서 이 서버 PC의
  접근(컴퓨터 계정 또는 everyone 쓰기)을 허용해야 한다.
- 서버 PC "밖"의 장비여야 의미가 있다(같은 디스크면 동반 손실).
- 설정 직후 `schtasks /Run /TN "MVHub BackupCopy"` 로 1회 실행해서
  `logs\backup_replicate.log` 에 **"복제 완료"가 찍히고 "복제 실패" 줄이 없는지**
  꼭 확인한다(실패는 성공으로 위장하지 않고 "복제 실패"로 찍힌다).
- 복제 범위: 서버 자동 백업(`backups\`, 앱이 CONTENT_HUB_BACKUP_DIR 로 위치를
  옮겼으면 그 위치를 따라감) + 팀원이 업로드한 DB 백업(`db-backups\<계정슬러그>\`).
- 자동 백업 한 세트는 `content_hub_*`(콘텐츠), `content_trash_*`(휴지통),
  `manage_hub_*`(프로젝트 관리, 사용 중일 때)로 구성된다. 각 파일은 생성 때와
  원격 복제 직후 모두 SQLite 무결성 검사를 통과해야 완성본으로 취급한다.

### 워치독의 안전장치 (알아둘 것)

- 부팅 직후 npm 빌드 몇 분간 서버가 안 떠 있는 건 정상 — 워치독은 기본 **30분간**
  개입하지 않는다. 30분이 지난 뒤에도 HTTP 응답이 없으면 그때부터 dead 횟수를 세며,
  기본 3회 연속 dead에서 안전한 대상 PID를 특정해 개입하거나 특정 실패 ALERT를 남긴다.
- `/api/ready`가 HTTP 오류를 응답하면 서버 프로세스는 살아 있는 `busy`로 본다. busy가 기본 30회
  연속(기본 확인 주기에서는 약 30분)되면 ALERT를 남기지만 자동 종료하지 않는다.
- DB 가져오기·복원처럼 유지보수 게이트가 열린 동안 `/api/ready`는 즉시
  `503 {"status":"maintenance"}`와 `Retry-After: 5`를 반환한다. 워치독은 maintenance를
  별도 상태로 보고 자동 종료하지 않으며, 기본 60회 연속(약 60분)일 때만 장기 유지보수 ALERT를
  한 번 남긴다.
- 연결 거부·timeout처럼 HTTP 응답 자체가 없는 `dead`만 연속 실패 횟수에 포함한다. 시작 유예가
  끝났거나 한 번 정상화된 서버에서 기본 3회 연속 dead일 때만 개입한다.
- 계속 죽는 비정상 상황(**1시간 내 3회** 개입)이면 재시작 폭풍을 막기 위해
  1시간 개입을 멈추고 `logs\watchdog_ALERT.txt` 를 남긴다. 이 파일이 보이면
  사람이 서버 로그를 직접 확인해야 한다.
- 다른 프로그램이 서버 포트(8010)를 차지한 경우엔 오살 위험 때문에 자동 종료하지
  않는다 — 대신 같은 ALERT 파일로 알린다(사람이 점유 프로그램을 정리해야 함).
- 부팅 직후 npm/네트워크 문제로 시작에 실패하면 작업 스케줄러가 **5분 간격으로
  최대 10회 재시도**한다(일시적 장애는 스스로 회복).
- 콘솔 로그(`logs\*_console.log`)는 **예약작업이 (재)시작될 때**(재부팅·실패
  재시도) 50MB 를 넘으면 `.old` 로 밀어둔다. 재부팅 없이 수개월 연속 가동하면
  그 사이엔 회전이 없으니, 로그가 크면 register 재실행(=재시작+회전)으로 정리.
- 알려진 한계: "기존 서버 인계"는 포트를 점유한 serve.py 를 종료하는데, 같은
  PC 에 **다른 저장소의 serve.py** 가 그 포트를 쓰고 있어도 구분하지 못한다.
  서버 PC 에는 허브 저장소 하나만 두는 것을 전제로 한다.

### 수동 중지 / 재시작

```
schtasks /End /TN "MVHub Watchdog"     ← 워치독 먼저 중지(안 하면 되살림)
schtasks /End /TN "MVHub Server"
taskkill /IM python.exe /F              ← 또는 작업관리자에서 serve.py 프로세스 종료
```
다시 시작: `schtasks /Run /TN "MVHub Server"` → `schtasks /Run /TN "MVHub Watchdog"`

## 예비 PC 복구 절차 (서버 PC 하드웨어 사망 시)

목표: 10분 내 복구. **순서가 중요하다 — 특히 1번.**

1. **원 서버 PC 전원을 끄거나 랜선을 뽑는다.** (살아있는 채로 예비 PC에 같은
   IP를 주면 IP 충돌로 둘 다 이상해진다.)
2. 예비 PC에 서버 고정 IP를 수동 설정한다(제어판 → 네트워크 → IPv4 속성).
   IP가 같으면 팀원들은 아무 설정도 바꿀 필요 없다.
3. 예비 PC에 저장소가 없으면 `setup_clone_git.bat` 로 클론, 있으면
   `update_git.bat` 로 최신화.
4. 최신 백업 DB를 복원한다 (복제 위치의 폴더 구조 기준):
   - `backups\content_hub_*.db` 최신본 → `backend\data\db\content_hub.db` 로
     복사(이름 변경). 서버 메인 DB.
   - 같은 시각의 `backups\content_trash_*.db` →
     `backend\data\db\content_hub_trash.db` 로 복원.
   - 같은 시각의 `backups\manage_hub_*.db` →
     `backend\data\db\manage_hub.db` 로 복원.
   - `backups\<계정슬러그>\content_hub_*.db` 가 있으면 →
     `backend\data\db\acct\<계정슬러그>\content_hub.db` 로 복원(계정별 DB).
   - `db-backups\<계정슬러그>\` 는 팀원 로컬 허브가 올려둔 개인 DB 백업 —
     서버 복구에는 불필요하고, 팀원 PC 가 죽었을 때 그 팀원에게 돌려주는 용도.
5. `MV_server.bat` 실행(임시로는 수동 실행으로 충분).
6. 검증: 팀원 1명에게 접속·로그인·팀 탭 확인 요청. 서버 PC 교체가 길어지면
   예비 PC에도 `register_autostart.bat` 를 등록한다.

### 월 1회 리허설 체크리스트

- [ ] 복제 위치에 어제 날짜 백업이 있는가 (`logs\backup_replicate.log` 확인)
- [ ] 백업 하나를 임시 폴더에 복원해 SQLite 로 열리는가
      (`python -c "import sqlite3;sqlite3.connect(r'복원.db').execute('PRAGMA integrity_check').fetchone()"`)
- [ ] 서버 PC 재부팅 → 로그인 없이 자동으로 서버·워치독이 뜨는가
- [ ] `logs\watchdog_ALERT.txt` 가 없는가 (있으면 원인 확인 후 삭제)

## 평상시 관리 루틴 (주 1회 5분)

- `MV_logs.bat`에서 5xx, 생성 확인 필요, 백업 실패가 없는지
- `logs\watchdog.log` 에 "개입" 기록이 있는지 (있으면 행이 있었다는 뜻 — 빈도 확인)
- 디스크 여유 공간 (백업+미디어 캐시가 쌓인다)
- 업데이트 순서는 항상: **서버 먼저 → 팀원 에이전트** (버전 게이트가 구 에이전트를 막는다)
