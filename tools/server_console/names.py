"""관리 창 안에서만 쓰는 이름·기본값. 기존 도구들의 전역 설정으로 키우지 않는다."""
from __future__ import annotations

TASK_SERVER = "MVHub Server"
TASK_WATCHDOG = "MVHub Watchdog"
TASK_BACKUP = "MVHub BackupCopy"
TASKS = (TASK_SERVER, TASK_WATCHDOG, TASK_BACKUP)

DEFAULT_PORT = 8010
RUNTIME_LOG = "mvhub-runtime.jsonl"
CONSOLE_LOGS = ("server_console.log", "watchdog_console.log", "backup_console.log")
ALERT_FILES = ("server_ALERT.txt", "watchdog_ALERT.txt")

JOB_DIR = "console-jobs"
UI_LOG = "console-ui.log"
LOCK_FILE = "server-console.lock"
UI_MARK = "console-ui.json"  # 열린 화면이 쓰는 관리 창 코드(pid·생성 시각·code_root) — 쓰는 중인 stage 보존용
ACTION_LOG = "console-actions.jsonl"  # 관리 창 기록: 시각·Windows 계정·로그인 계정·동작·확인 대상·결과·작업 ID
DB_LOCK = "console-db.lock"  # 관리 창의 직접 DB 읽기 ↔ DB 를 바꾸는 이사 도구(진짜 OUT·백업 복구) 배타 — 0번 바이트
SERVER_OFF = "console-server-off.json"  # 관리 창이 끈 기록 {phase, job_id, updated_at} — [켜기] 가 확인 뒤 지운다

# 이사 도구가 쓰는 기록(server_move_easy.py·server_move.py 와 같은 이름) — 관리 창은 읽기만.
MOVE_OUT_STATE = "server_move_out_state.json"  # <data>\
MOVE_IN_STATE = "server_move_in_state.json"    # <data>\
MOVE_JOURNAL = ".server_move_journal.json"     # <data>\db\ — 설치 중·되돌리기 실패면 남는다
MOVE_OUT_ACTIVE = ("prepared", "paused", "stopped", "exported")

# runtime_snapshot 은 60초마다 쌓인다. 이보다 오래되면 '확인 불가'로 본다.
SNAPSHOT_STALE_SECONDS = 180

# 업데이트·전환 흔적(updater 와 supervisor 가 이미 쓰는 파일).
GIT_UPDATE_LOCK = "git-update.lock"
UPDATE_REQUEST = "server-update-request.json"
INSTALL_JOURNAL = "server-install-journal.json"
PREPARE_RECORD = "server-prepare.json"
SERVER_CURRENT = "server-current.json"
TERMINAL_PHASES = ("committed", "rolled_back")

# 이 SID 만 설치 루트·도구·Python 을 쓸 수 있어야 한다(그 밖이 쓰면 관리자 동작 거절).
TRUSTED_WRITERS = frozenset({
    "S-1-5-18",          # SYSTEM
    "S-1-5-32-544",      # Administrators
    "S-1-3-0",           # CREATOR OWNER (자기가 만든 하위 항목에만 해당)
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",  # TrustedInstaller
})
