"""관리 창 화면(tkinter). 그리기·클릭만 — 판단은 status·actions·jobs 에 있다.

작업 스레드는 위젯도 after() 도 부르지 않고 큐에 넣기만 하며, 메인 스레드가 주기적으로 큐를 읽어 화면을 바꾼다.
"""
from __future__ import annotations

import collections
import ctypes
import json
import msvcrt
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
import traceback
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, ttk

from . import (actions, activity, backup, console_stage, install, jobs, logs, moves, names, power, release,
               server_api, status)
from . import main as main_boot

BG, BG2, PANEL, PANEL2 = "#08090a", "#0c0e10", "#121316", "#181a1e"
TEXT, MUTED, MUTED2, LIME, INK = "#f3f4f6", "#8b909c", "#5f6573", "#c4e84a", "#131806"
RED, AMBER, BLUE, VIOLET, CYAN = "#f0626b", "#f2b84b", "#6aa8ff", "#b49cff", "#5fd0c4"
FONT = ("Malgun Gothic", 10)
BOLD = ("Malgun Gothic", 10, "bold")
MONO = ("Consolas", 10)
MAX_LINES_PER_TAB = 3000
QUEUE_MAX = 200            # 화면이 못 따라오면 작업 스레드가 기다린다(무한히 쌓지 않는다)
DRAIN_LINES = 3000         # 한 번에 화면에 넣는 로그 줄 상한
JOB_READ_BYTES = 64_000    # 업데이트 출력은 한 번에 이만큼씩 따라 읽는다
STEP_LABELS = ("코드 받기", "파이썬", "CLI", "화면 빌드", "시험 기동", "서비스 전환")
SERVER_COLORS = {"ok": LIME, "switching": AMBER, "starting": AMBER, "maintenance": AMBER, "blocked": AMBER,
                 "not_ready": RED, "no_answer": RED, "stopped": MUTED, "unknown": MUTED, "no_task": MUTED}
JOB_TERMINAL = ("finished", "refused", "check_needed", "runner_error")
NAV = (("status", "상태·로그"), ("intake", "생성 접수"), ("power", "켜기·끄기"), ("backup", "DB·백업"),
       ("update", "업데이트"), ("release", "릴리스"), ("move", "서버 이사"), ("address", "서버 주소"))
# 로그 탭 위의 표(activity.read_activity 의 키·제목·칸). 칸 = (키, 머리글, 너비)
TABLES = {
    "generation": ("generations", "최근 생성 — 작업자 PC 가 보낸 정보(프롬프트는 안 보임)",
                   (("when", "시각", 90), ("who", "작업자", 100), ("model", "모델", 170), ("where", "프로젝트 › 폴더", 300),
                    ("status", "상태", 80), ("credits", "크레딧", 90))),
    "settings": ("changes", "누가 무엇을 바꿨나 — 서버 변경 기록",
                 (("when", "시각", 90), ("who", "누가", 100), ("what", "무엇을", 210), ("target", "대상", 260),
                  ("fields", "바뀐 칸", 180))),
    "connection": ("people", "최근 활동한 사람 — 서버 DB 기준(실시간 접속 아님 · 접속 이력은 남기지 않음)",
                   (("who", "이름", 140), ("last_gen", "마지막 생성", 130), ("agent", "에이전트 보고", 130),
                    ("today", "오늘 생성", 90))),
}
TONES = {"ok": TEXT, "run": BLUE, "bad": RED, "warn": AMBER, "muted": TEXT}  # 줄 전체에 칠해지니 평소 줄은 보통 글자색
ACTIVITY_SECONDS = 30
POWER_TASK_WORDS = {"Running": "실행 중", "Ready": "켜짐(대기)", "Disabled": "꺼짐", "Missing": "없음",
                    "Queued": "대기열", "Error": "확인 불가"}
OFF_WORDS = {"stopping": "끄는 중 멈춤", "stopped": "관리 창이 끔", "starting": "켜는 중 멈춤",
             "start_failed": "켜기 실패 — 확인 필요"}
PRESENCE_COLUMNS = (("who", "이름", 160), ("app", "앱 연결 수 · 백그라운드 포함", 240),
                    ("agent", "에이전트 · 최근 40초 신호", 200))
RELEASE_COLUMNS = (("버전", 180), ("상태", 180), ("용량", 80), ("제작 시각", 120),
                   ("배포", 84), ("해제", 84), ("삭제", 84))


class ConsoleTk(tk.Tk):
    """홈·현재 폴더의 .Tk.py·.Tk.tcl 등을 실행하는 readprofile 을 막은 Tk."""

    def readprofile(self, baseName, className):  # noqa: N802,N803 — tkinter 이름 그대로
        return None

    def report_callback_exception(self, exc, val, tb):
        _log_ui_error("".join(traceback.format_exception(exc, val, tb)))
        try:
            messagebox.showerror("MV Hub 서버 관리", f"화면 처리 중 오류가 났습니다.\n{val}\n자세한 내용: logs\\{names.UI_LOG}")
        except tk.TclError:
            pass


def _log_ui_error(text: str) -> None:
    try:
        path = install.ROOT / "logs" / names.UI_LOG
        with path.open("a", encoding="utf-8") as handle:
            handle.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + text.rstrip() + "\n")
    except OSError:
        pass


def check_tk() -> int:
    """띄우기 전 점검(같은 격리 조건). 실패 이유를 보이고 0 이 아닌 값으로 끝낸다."""
    try:
        root = ConsoleTk()
        root.withdraw()
        root.update_idletasks()
        root.destroy()
    except Exception as exc:  # noqa: BLE001
        print(f"[error] tkinter 를 시작하지 못했습니다: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print("tk ok")
    return 0


def _single_instance():
    """logs\\server-console.lock 첫 바이트 잠금. 이미 열려 있으면 None."""
    path = install.ROOT / "logs" / names.LOCK_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return None
    return handle


def _ago(seconds: float | None) -> str:
    if seconds is None:
        return "시각 모름"
    seconds = max(0, int(seconds))
    if seconds < 90:
        return f"{seconds}초 전"
    if seconds < 5400:
        return f"{seconds // 60}분 전"
    return f"{seconds // 3600}시간 전"


def _int(value) -> int | None:
    """로그에서 읽은 숫자. 형식이 틀리면 None(화면에는 '확인 불가')."""
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _line_count(text: tk.Text) -> int:
    """줄마다 '\\n' 으로 끝나게 넣으므로 마지막 빈 줄은 세지 않는다."""
    return int(text.index("end-1c").split(".")[0]) - 1


class App:
    def __init__(self, root: ConsoleTk, inst: install.Installation, autostart: bool = True, note: str = "") -> None:
        self.root = root
        self.inst = inst
        self.note = note  # 부트스트랩이 넘긴 알림(관리 창 stage 확인 실패 등) — 상단에 늘 보인다
        self.reopen_requested = False
        self.runner = install.default_runner(inst)
        server_api.bind(inst, self.runner)  # 토큰을 실은 요청은 보내기 바로 전에 서버를 다시 확인한다
        self.queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        self.hub = logs.LogHub(inst)
        self.buffers = {key: collections.deque(maxlen=MAX_LINES_PER_TAB) for key, _ in logs.TABS}
        self.workers_seen: set[str] = set()
        self.status: status.Status | None = None
        self.tasks: dict | None = None
        self.task_match = "unknown"
        self.addresses: list[tuple[str, str]] | None = None
        self.copy_text = ""
        self.job_view = ("", 0)  # (따라가는 작업 ID, 바꾼 횟수) — 한 번에 바꿔 작업 스레드가 섞어 읽지 않게
        self.job_step = 0
        self.job_closed = ""  # 끝 처리를 마친 작업 — 같은 작업의 반복 알림이 다음 요청의 busy 를 풀지 않게
        self.backlog: collections.deque = collections.deque()  # 예산을 넘어 다음 차례로 미룬 메시지 조각
        self.busy = False
        self.stop = threading.Event()
        # 관리자 로그인(창마다 한 번). 토큰은 이 메모리에만 — 파일·인자·환경·작업 기록에 쓰지 않고 창을 닫으면 사라진다.
        self.session: server_api.Session | None = None
        self.login_window: tk.Toplevel | None = None
        self.after_login = None  # 로그인 뒤 이어서 할 일(인증이 필요한 동작)
        self.intake_api: tuple[bool, float] | None = None  # 로그인 뒤 서버 API 로 읽은 값·시각 — DB 읽기(추정)보다 우선
        self.intake_busy = False
        # 화면별로 따라가는 작업(생성 접수·백업) — 업데이트 작업 보기와 따로(업데이트 중에도 접수는 바꿀 수 있게)
        self.side_jobs: dict[str, str] = {}
        self.backup_view: dict | None = None
        self.backup_busy = False
        self.backup_due = False  # 백업 화면 정보를 작업 스레드가 다시 읽을 때
        self.backup_shown = ""   # 입력 칸에 마지막으로 채운 위치 — 사람이 고치는 중이면 덮지 않는다
        self.release_view: dict | None = None
        self.release_busy = False
        self.release_due = False
        self.address_view: dict | None = None
        self.address_busy = False
        self.address_shown = ("", "")  # 주소·이름 칸에 마지막으로 채운 값
        self.activity: dict | None = None  # 로그 탭 위 표(activity.read_activity)
        self.activity_paused = ""  # 서버가 정상이 아니라 표를 다시 읽지 않는 동안의 알림
        self.power_busy = self.drill_busy = self.move_busy = False
        self.move_view: dict | None = None  # moves.view + 최근 백업 목록
        self.move_due = False
        # 지금 접속 중(서버 API) — 로그인·접속 탭일 때만, 한 번에 하나. 응답은 보낸 세션과 같을 때만 받는다.
        self.presence: dict | None = None
        self.presence_inflight = False
        self.log_tab = ""
        self.page = "status"
        self._build()
        # 다시 열면 결과를 확인하지 않은 작업을 먼저, 없으면 마지막 작업을 다시 보여 준다.
        recent = (jobs.unresolved_jobs(inst) or [])[:1] or jobs.recent_jobs(inst, 1)
        if recent:
            self.job_id = recent[0]
            self.busy = True
            self._set_start_buttons("disabled")
        if autostart:  # 시험은 끄고 메시지를 직접 넣는다
            threading.Thread(target=self._worker, name="console-worker", daemon=True).start()
            self.root.after(250, self._drain)

    @property
    def job_id(self) -> str:
        return self.job_view[0]

    @job_id.setter
    def job_id(self, value: str) -> None:
        self.job_view = (value, self.job_view[1] + 1)  # 같은 작업을 다시 골라도 출력은 처음부터 다시 읽는다

    # ---------- 화면 만들기 ----------
    def _build(self) -> None:
        root = self.root
        root.title("MV Hub 서버 관리")
        root.configure(bg=BG)
        root.geometry("1280x800")
        root.minsize(1000, 640)
        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TNotebook", background=BG, borderwidth=0)
        style.configure("TNotebook.Tab", background=BG, foreground=MUTED, padding=(12, 6), font=BOLD, borderwidth=0)
        style.map("TNotebook.Tab", background=[("selected", PANEL)], foreground=[("selected", LIME)])
        style.configure("Console.Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT, font=FONT,
                        rowheight=22, borderwidth=0, bordercolor=PANEL2, lightcolor=PANEL2, darkcolor=PANEL2)
        style.configure("Console.Treeview.Heading", background=PANEL2, foreground=MUTED, font=FONT, relief="flat")
        style.map("Console.Treeview", background=[("selected", PANEL2)], foreground=[("selected", LIME)])
        for orientation in ("Vertical", "Horizontal"):
            name = f"{orientation}.TScrollbar"
            style.configure(name, background=MUTED2, troughcolor=BG2, bordercolor=BG2,
                            lightcolor=MUTED2, darkcolor=MUTED2, arrowcolor=TEXT, relief="flat")
            style.map(name, background=[("pressed", LIME), ("active", LIME)],
                      lightcolor=[("pressed", LIME), ("active", LIME)],
                      darkcolor=[("pressed", LIME), ("active", LIME)])
        style.configure("TCombobox", fieldbackground=PANEL, background=PANEL2, foreground=TEXT, arrowcolor=TEXT)
        style.map("TCombobox", fieldbackground=[("readonly", PANEL)], foreground=[("readonly", TEXT)],
                  selectbackground=[("readonly", PANEL)], selectforeground=[("readonly", TEXT)])

        scale = float(root.tk.call("tk", "scaling")) / 1.333
        self.nav = tk.Frame(root, bg=BG2, width=int(200 * max(1.0, scale)))
        self.nav.pack(side="left", fill="y")
        self.nav.pack_propagate(False)
        tk.Label(self.nav, text="MV Hub 서버", bg=BG2, fg=TEXT, font=("Malgun Gothic", 12, "bold")).pack(anchor="w", padx=14, pady=(14, 0))
        self.nav_state = tk.Label(self.nav, text="● 확인 중", bg=BG2, fg=MUTED, font=("Malgun Gothic", 9))
        self.nav_state.pack(anchor="w", padx=14, pady=(2, 12))
        self.pages: dict[str, tk.Frame] = {}
        self.nav_items: dict[str, tk.Label] = {}
        main = tk.Frame(root, bg=BG)
        main.pack(side="left", fill="both", expand=True)
        if self.note:  # 부트스트랩 알림(관리 창 stage 확인 실패 등)은 어느 화면에서도 보이게 맨 위에
            tk.Label(main, text=self.note, bg="#3a2f12", fg=AMBER, font=BOLD, anchor="w", justify="left",
                     wraplength=1000, padx=12, pady=6).pack(fill="x")
        builders = {"status": self._build_status_page, "intake": self._build_intake_page,
                    "power": self._build_power_page, "backup": self._build_backup_page,
                    "address": self._build_address_page, "update": self._build_update_page,
                    "release": self._build_release_page, "move": self._build_move_page}
        for key, label in NAV:
            if key not in builders:  # 아직 만들지 않은 화면은 이름만
                tk.Label(self.nav, text=f"{label}  · 다음 단계", bg=BG2, fg=MUTED2, font=("Malgun Gothic", 10),
                         anchor="w", padx=12, pady=7).pack(fill="x", padx=8, pady=1)
                continue
            item = tk.Label(self.nav, text=label, bg=BG2, fg=MUTED, font=("Malgun Gothic", 11, "bold"),
                            anchor="w", padx=12, pady=8, cursor="hand2", takefocus=True)
            item.pack(fill="x", padx=8, pady=1)
            item.bind("<Button-1>", lambda _e, k=key: self.show(k))
            item.bind("<Return>", lambda _e, k=key: self.show(k))
            self.nav_items[key] = item
            self.pages[key] = tk.Frame(main, bg=BG)
        tk.Label(self.nav, text="창을 닫아도 서버는 계속 돕니다", bg=BG2, fg=MUTED2,
                 font=("Malgun Gothic", 8)).pack(side="bottom", anchor="w", padx=12, pady=10)
        account = tk.Frame(self.nav, bg=BG2)
        account.pack(side="bottom", fill="x", padx=12)
        self.login_label = tk.Label(account, text="관리자 로그인 안 함", bg=BG2, fg=MUTED, font=("Malgun Gothic", 9),
                                    anchor="w", justify="left", wraplength=170)
        self.login_label.pack(fill="x")
        self.login_button = self._button(account, "로그인", self.toggle_login)
        self.login_button.pack(anchor="w", pady=(2, 0))
        for key, build in builders.items():
            build(self.pages[key])
        self.show("status")

    def show(self, key: str) -> None:
        for name, page in self.pages.items():
            page.pack_forget()
            self.nav_items[name].configure(bg=BG2, fg=MUTED)
        self.pages[key].pack(fill="both", expand=True)
        self.nav_items[key].configure(bg="#1b2010", fg=LIME)
        self.page = key
        if key == "backup":
            self.backup_due = True  # 열 때마다 새로 읽는다(작업 스레드)
        if key in ("release", "address"):
            self.release_due = True
        if key == "move":
            self.move_due = True
        if key == "power":
            self._show_power()

    def _header(self, page: tk.Frame, title: str) -> tk.Frame:
        head = tk.Frame(page, bg=BG2)
        head.pack(fill="x")
        tk.Label(head, text=title, bg=BG2, fg=TEXT, font=("Malgun Gothic", 13, "bold")).pack(side="left", padx=14, pady=12)
        return head

    def _button(self, parent, text, command, primary=False) -> tk.Button:
        bg, fg = (LIME, INK) if primary else (PANEL2, TEXT)
        return tk.Button(parent, text=text, command=command, bg=bg, fg=fg, activebackground=bg, activeforeground=fg,
                         relief="flat", font=BOLD, padx=12, pady=5, bd=0, highlightthickness=0, cursor="hand2")

    def _build_status_page(self, page: tk.Frame) -> None:
        head = self._header(page, "상태·로그")
        self.code_label = tk.Label(head, text="돌고 있는 코드 —", bg=PANEL, fg=MUTED, font=FONT, padx=8, pady=3)
        self.code_label.pack(side="left", padx=4)
        self._button(head, "주소 복사", self.copy_address).pack(side="right", padx=4)
        self.addr_label = tk.Label(head, text="주소 —", bg=PANEL, fg=MUTED, font=FONT, padx=8, pady=3,
                                   justify="left", wraplength=560)
        self.addr_label.pack(side="left", padx=4)

        cards = tk.Frame(page, bg=BG)
        cards.pack(fill="x", padx=12, pady=10)
        self.cards: dict[str, tuple[tk.Label, tk.Label]] = {}
        for key, title in (("server", "서버"), ("accounts", "접속 계정"), ("requests", "요청"),
                           ("db", "DB"), ("backup", "백업"), ("intake", "생성 접수")):
            box = tk.Frame(cards, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
            box.pack(side="left", fill="x", expand=True, padx=4)
            tk.Label(box, text=title, bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=10, pady=(8, 0))
            value = tk.Label(box, text="—", bg=PANEL, fg=TEXT, font=("Malgun Gothic", 15, "bold"))
            value.pack(anchor="w", padx=10)
            sub = tk.Label(box, text="확인 중", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9), justify="left")
            sub.pack(anchor="w", padx=10, pady=(0, 8))
            self.cards[key] = (value, sub)

        tools = tk.Frame(page, bg=BG)
        tools.pack(fill="x", padx=12)
        tk.Label(tools, text="작업자", bg=BG, fg=MUTED, font=FONT).pack(side="left")
        self.worker_filter = ttk.Combobox(tools, values=["모두"], state="readonly", width=14, font=FONT)
        self.worker_filter.set("모두")
        self.worker_filter.pack(side="left", padx=(4, 12))
        self.worker_filter.bind("<<ComboboxSelected>>", lambda _e: (self._rerender_all(), self._render_tables()))
        tk.Label(tools, text="찾기", bg=BG, fg=MUTED, font=FONT).pack(side="left")
        self.search = tk.Entry(tools, bg=PANEL, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT, width=28)
        self.search.pack(side="left", padx=4)
        self.search.bind("<Return>", lambda _e: self.find_next())
        self._button(tools, "다음", self.find_next).pack(side="left", padx=4)
        self.sources_label = tk.Label(tools, text="", bg=BG, fg=MUTED2, font=("Malgun Gothic", 8))
        self.sources_label.pack(side="right")
        self.noise_label = tk.Label(tools, text="", bg=BG, fg=MUTED2, font=("Malgun Gothic", 8))
        self.noise_label.pack(side="right", padx=8)

        self.notebook = ttk.Notebook(page)
        self.notebook.pack(fill="both", expand=True, padx=12, pady=(6, 12))
        self.texts: dict[str, tk.Text] = {}
        self.tables: dict[str, tuple[ttk.Treeview, tk.Label]] = {}
        self.notebook.bind("<<NotebookTabChanged>>", lambda _e: setattr(
            self, "log_tab", logs.TABS[self.notebook.index("current")][0]))
        for key, label in logs.TABS:
            frame = tk.Frame(self.notebook, bg=PANEL)
            panes = tk.PanedWindow(frame, orient="vertical", bg=PANEL, bd=0, sashwidth=5,
                                   sashrelief="flat", showhandle=False)
            panes.pack(fill="both", expand=True, padx=12, pady=8)
            if key == "connection":
                self._build_presence(panes)
            if key in TABLES:
                self._build_table(panes, key)
            body, _note = self._log_panel(panes, "상세 로그")
            text = tk.Text(body, bg=PANEL, fg=MUTED, font=MONO, relief="flat", bd=0, padx=8, pady=8,
                           wrap="none", highlightthickness=0, insertbackground=TEXT)
            self._scroll_content(body, text)
            text.configure(state="disabled")
            for tag, color in (("ERROR", RED), ("WARNING", AMBER), ("CRITICAL", RED), ("INFO", MUTED), ("hit", INK)):
                text.tag_configure(tag, foreground=color)
            text.tag_configure("hit", background=LIME)
            self.notebook.add(frame, text=label)
            self.texts[key] = text

    def _log_panel(self, panes: tk.PanedWindow, title: str) -> tuple[tk.Frame, tk.Label]:
        panel = tk.Frame(panes, bg=PANEL, highlightbackground=PANEL2, highlightthickness=1)
        panes.add(panel, minsize=70, stretch="always")
        head = tk.Frame(panel, bg=PANEL2)
        head.pack(fill="x")
        tk.Label(head, text=title, bg=PANEL2, fg=MUTED, font=FONT).pack(side="left", padx=8, pady=5)
        note = tk.Label(head, text="", bg=PANEL2, fg=MUTED2, font=("Malgun Gothic", 8))
        note.pack(side="right", padx=8)
        body = tk.Frame(panel, bg=PANEL)
        body.pack(fill="both", expand=True)
        return body, note

    @staticmethod
    def _scroll_content(body: tk.Frame, content) -> None:
        body.rowconfigure(0, weight=1)
        body.columnconfigure(0, weight=1)
        vertical = ttk.Scrollbar(body, orient="vertical", command=content.yview)
        horizontal = ttk.Scrollbar(body, orient="horizontal", command=content.xview)
        content.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        content.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal.grid(row=1, column=0, sticky="ew")

    def _build_table(self, frame: tk.Frame, key: str) -> None:
        """로그 탭 위의 표 — 이름만 보인다(activity). 아래 글자 칸은 그대로 흐름 줄."""
        _source, title, columns = TABLES[key]
        box, note = self._log_panel(frame, title)
        note.configure(text="읽는 중")
        tree = ttk.Treeview(box, columns=[c[0] for c in columns], show="headings", height=4, style="Console.Treeview")
        for column, heading, width in columns:
            tree.heading(column, text=heading, anchor="w")
            tree.column(column, width=width, minwidth=60, anchor="w",
                        stretch=column in ("where", "target", "what") or column == columns[-1][0])
        for tone, color in TONES.items():
            tree.tag_configure(tone, foreground=color)
        self._scroll_content(box, tree)
        self.tables[key] = (tree, note)

    def _build_presence(self, frame: tk.Frame) -> None:
        """접속 탭 맨 위 '지금 접속 중'(서버 메모리 — 이력 없음, Jay 10-24). 관리자 로그인했을 때만."""
        box, self.presence_note = self._log_panel(frame, "지금 접속 중 — 서버가 지금 붙어 있다고 아는 계정(기록하지 않음)")
        self.presence_note.configure(text="관리자로 로그인하면 보입니다")
        self.presence_tree = ttk.Treeview(box, columns=[c[0] for c in PRESENCE_COLUMNS], show="headings", height=3,
                                          style="Console.Treeview")
        for column, heading, width in PRESENCE_COLUMNS:
            self.presence_tree.heading(column, text=heading, anchor="w")
            self.presence_tree.column(column, width=width, minwidth=60, anchor="w", stretch=column == "who")
        self._scroll_content(box, self.presence_tree)

    def _render_presence(self) -> None:
        tree = getattr(self, "presence_tree", None)
        if tree is None:
            return
        data = self.presence if self.session is not None else None
        tree.delete(*tree.get_children())
        if data is None:
            self.presence_note.configure(text="관리자로 로그인하면 보입니다" if self.session is None else "읽는 중", fg=MUTED2)
            return
        stamp = datetime.fromtimestamp(data.get("read_at") or time.time(), activity.KST).strftime("%H:%M:%S")
        if data.get("error"):
            self.presence_note.configure(text=f"읽지 못함: {data['error']}", fg=AMBER)
            return
        rows = data.get("rows") or {}
        for row in rows.get("people") or []:
            tree.insert("", "end", values=(activity.shown(row.get("name"), 40) or "팀원", row.get("app", 0),
                                           "있음" if row.get("agent") else "—"))
        other = rows.get("other_connections") or 0
        self.presence_note.configure(text=f"{stamp} 읽음 · {len(rows.get('people') or [])}명"
                                          + (f" · 계정 없는 연결 {other}" if other else ""), fg=MUTED2)

    def _render_tables(self) -> None:
        self._render_presence()
        data = self.activity or {}
        paused = self.activity_paused  # 작업자 칸을 바꿔 다시 그려도 멈춤 알림은 남는다(새 표를 받을 때만 풀림)
        errors = data.get("errors") or {}
        worker = self.worker_filter.get()
        for key, (tree, note) in self.tables.items():
            source, _title, columns = TABLES[key]
            rows = [row for row in data.get(source) or [] if worker in ("", "모두") or row.get("who") == worker]
            if not paused:  # 멈춘 동안은 마지막 표를 그대로 둔다
                tree.delete(*tree.get_children())
                for row in rows:
                    tree.insert("", "end", values=[row.get(c[0], "") for c in columns],
                                tags=(row.get("tone", "muted"),))
            # 최근 활동한 사람은 두 DB 를 합친다 — 하나만 못 읽어도 '일부만'이라고 알린다.
            error = (" · ".join(e for e in (errors.get("changes"), errors.get("generations")) if e)
                     if key == "connection" else errors.get(source, ""))
            read_at = data.get("read_at")
            stamp = datetime.fromtimestamp(read_at, activity.KST).strftime("%H:%M:%S") if read_at else ""
            text = (f"{paused}{f' — 마지막 {stamp} 읽음' if stamp else ''}" if paused
                    else f"일부만 읽음: {error}" if error and rows else error
                    or (f"{stamp} 읽음 · {len(rows)}줄" if read_at else "읽는 중"))
            note.configure(text=text, fg=AMBER if (error or paused) else MUTED2)

    def _presence_step(self, now: float, last: float) -> float:
        """작업 스레드: 로그인했고 접속 탭을 볼 때만 30초마다 '지금 접속 중'을 한 번에 하나 묻는다(별도 스레드 — 로그·작업
        진행 읽기를 붙잡지 않게). 서버 확인은 call() 이 보내기 직전에 한다(따로 verify 하지 않음)."""
        session = self.session
        if (session is None or self.presence_inflight or self.page != "status" or self.log_tab != "connection"
                or now - last <= ACTIVITY_SECONDS):
            return last
        self.presence_inflight = True

        def ask() -> None:
            try:
                value = {"rows": server_api.read_presence(session.server, session.token), "read_at": time.time()}
            except server_api.ServerError as exc:
                value = {"error": str(exc), "read_at": time.time(), "auth_expired": isinstance(exc, server_api.AuthExpired)}
            except Exception as exc:  # noqa: BLE001
                value = {"error": f"{type(exc).__name__}", "read_at": time.time()}
            if not self._put(("presence", session, value)):
                self.presence_inflight = False
        threading.Thread(target=ask, daemon=True).start()
        return now

    def _activity_step(self, now: float, last: float, server_ok: bool) -> float:
        """작업 스레드: 상태·로그 화면일 때 30초마다 DB 를 읽는다. 서버가 정상이 아니면(멈춤·전환·점검 — 복원·이사로
        DB 파일을 바꾸는 동안) 읽지 않는다(Codex 리뷰 P2 — 읽기 연결이 파일 교체·체크포인트를 막지 않게)."""
        if self.page != "status" or now - last <= ACTIVITY_SECONDS:
            return last
        if not server_ok:
            self._put(("activity_paused", "서버가 정상일 때만 DB 를 읽습니다"))
        else:
            try:
                self._put(("activity", activity.read_activity(self.inst)))
            except status.DbBusy as exc:  # 이사 도구가 DB 잠금을 쥠(설계 3판) — 연습 내보내기는 해당 없음
                self._put(("activity_paused", str(exc)))
        return now

    def _build_intake_page(self, page: tk.Frame) -> None:
        self._header(page, "생성 접수")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        card = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        card.pack(fill="x")
        tk.Label(card, text="지금", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(10, 0))
        self.intake_value = tk.Label(card, text="—", bg=PANEL, fg=TEXT, font=("Malgun Gothic", 18, "bold"))
        self.intake_value.pack(anchor="w", padx=12)
        self.intake_sub = tk.Label(card, text="확인 중", bg=PANEL, fg=MUTED, font=FONT, justify="left", wraplength=900)
        self.intake_sub.pack(anchor="w", padx=12, pady=(0, 10))
        self.intake_row = tk.Frame(body, bg=BG)
        self.intake_row.pack(fill="x", pady=10)
        self.pause_button = self._button(self.intake_row, "⏸ 생성 접수 멈추기", lambda: self.request_intake(True))
        self.resume_button = self._button(self.intake_row, "▶ 다시 받기", lambda: self.request_intake(False),
                                          primary=True)
        self.intake_hint = tk.Label(self.intake_row, text="", bg=BG, fg=MUTED, font=FONT)
        self.intake_note = tk.Label(body, text="", bg=BG, fg=AMBER, font=FONT, justify="left", wraplength=900)
        self.intake_note.pack(anchor="w")
        info = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        info.pack(fill="x", pady=10)
        tk.Label(info, text="멈춘 동안", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(10, 0))
        tk.Label(info, text='팀원 앱에는 "생성 요청을 잠시 중지했습니다" 안내가 뜹니다. 이미 시작된 생성은 끝까지 갑니다.\n'
                            "서버를 다시 켜도 저절로 풀리지 않습니다 — 배포가 끝나면 이 화면에서 [다시 받기]를 누르세요.",
                 bg=PANEL, fg=TEXT, font=FONT, justify="left", wraplength=900).pack(anchor="w", padx=12, pady=(0, 10))
        self.intake_last = tk.Label(body, text=last_intake_text(self.inst), bg=BG, fg=MUTED, font=FONT)
        self.intake_last.pack(anchor="w")
        self._show_intake()

    def _show_intake(self) -> None:
        """서버 API 값(로그인 뒤)을 기준으로, 없으면 DB 읽기(추정). DB 집계(진행 중 생성 수)는 따로 보인다."""
        st = self.status
        db = st.intake if st is not None else None
        if db is not None:
            active = _int(db.get("active_generation_total"))
            waiting = _int(db.get("non_terminal_request_total"))
            counts = (f"진행 중 생성 {'?' if active is None else active}건 · 처리 대기 요청 {'?' if waiting is None else waiting}건"
                      " (DB 집계 — Resolve·Comfy 작업까지 비었다는 뜻은 아님)")
        else:
            counts = (st.intake_error if st is not None else "") or "DB 를 읽지 못함"
        db_paused = db.get("paused") if db is not None and isinstance(db.get("paused"), bool) else None
        if self.intake_api is not None:
            paused, seen = self.intake_api
            source = f"서버 값({time.strftime('%H:%M:%S', time.localtime(seen))} 확인)"
            if db_paused is not None and db_paused != paused:
                source += f" · DB 읽기는 '{'중지' if db_paused else '가능'}' — 다시 확인하려면 버튼을 누르세요"
        elif db_paused is not None:
            paused, source = db_paused, "DB 읽기(추정 — 로그인하면 서버 값으로 확인)"
        else:
            paused, source = None, "확인 불가"
        self.intake_value.configure(text={True: "중지", False: "가능", None: "확인 불가"}[paused],
                                    fg={True: AMBER, False: LIME, None: MUTED}[paused])
        what = {True: "팀원의 새 생성 요청을 받지 않습니다", False: "팀원의 새 생성 요청을 받고 있습니다", None: ""}[paused]
        self.intake_sub.configure(text=" · ".join(p for p in (what, source) if p) + "\n" + counts)
        for widget in (self.pause_button, self.resume_button, self.intake_hint):
            widget.pack_forget()
        if paused is not True:
            self.pause_button.pack(side="left", padx=(0, 8))
        if paused is not False:
            self.resume_button.pack(side="left", padx=(0, 8))
        self.intake_hint.configure(text={False: "배포 직전에 누름 → 진행 중 생성이 0이 되면 업데이트",
                                         True: "배포·팀원 업데이트가 끝나면 누름"}.get(paused, ""))
        self.intake_hint.pack(side="left", padx=4)
        for button in (self.pause_button, self.resume_button):
            button.configure(state="disabled" if self.intake_busy else "normal")

    def request_intake(self, want: bool) -> None:
        if not self.intake_busy:
            self.require_login(lambda: self._begin_intake(want))

    def _begin_intake(self, want: bool) -> None:
        if self.intake_busy or self.session is None:
            return
        self.intake_busy = True
        self._show_intake()
        self.intake_note.configure(text="서버를 확인하고 지금 값을 읽는 중", fg=MUTED)
        threading.Thread(target=self._intake_plan_worker, args=(self.session, want), daemon=True).start()

    def _intake_plan_worker(self, session: server_api.Session, want: bool) -> None:
        value = None
        try:
            server = server_api.verify_server(self.inst, self.runner)  # 토큰을 보내기 전에 늘 다시 확인
            value = server_api.read_intake(server, session.token)
            plan = actions.plan_intake_set(self.inst, server, value, want, moving=jobs.move_active(self.inst))
        except server_api.ServerError as exc:
            plan = actions.Refusal((str(exc),))
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self.queue.put(("intake_plan", plan, value, time.time()))

    def _on_intake_plan(self, plan, value, seen: float) -> None:
        if value is not None:
            self.intake_api = (value, seen)
        if isinstance(plan, actions.Refusal):
            self.intake_busy = False
            self._relogin_if_needed(plan.reasons)
            self.intake_note.configure(text="바꾸지 않았습니다:\n· " + "\n· ".join(plan.reasons), fg=AMBER)
            self._show_intake()
            return
        self._show_intake()
        if messagebox.askokcancel(f"{actions.ACTIONS[plan.kind]} 확인", "\n\n".join(plan.summary) + "\n\n실행할까요?",
                                  icon="warning"):
            self.intake_note.configure(text="바꾸는 중", fg=MUTED)
            threading.Thread(target=self._start_worker, args=(plan, "intake"), daemon=True).start()
        else:
            self.intake_busy = False
            self.intake_note.configure(text="")
            self._show_intake()

    def _on_intake_job(self, state: dict) -> None:
        status_text = state.get("status")
        if status_text not in JOB_TERMINAL:
            return
        self.side_jobs.pop("intake", None)
        self.intake_busy = False
        if status_text == "finished" and state.get("exit_code") == 0:
            paused = _dict(state.get("intake")).get("paused")
            if isinstance(paused, bool):
                self.intake_api = (paused, float(state.get("finished_at") or time.time()))
            self.intake_note.configure(text=f"완료: 생성 접수 = {'중지' if paused else '가능'} (서버에서 다시 읽어 확인)", fg=LIME)
        elif status_text == "finished":
            if state.get("auth_expired"):
                self.logout()
            self.intake_note.configure(text=f"실패: {state.get('error') or '이유 모름'}", fg=RED)
            self._refresh_intake()
        elif status_text == "refused":
            reasons = [str(r) for r in state.get("reasons") or []]
            self._relogin_if_needed(reasons)
            self.intake_note.configure(text="바꾸지 않았습니다:\n· " + "\n· ".join(reasons), fg=AMBER)
        else:
            self.intake_note.configure(text=f"결과 확인 필요: 실행기가 결과를 남기지 못했습니다({state.get('error') or '사라짐'}). "
                                            "아래 값을 다시 읽어 확인하세요 — 업데이트 화면에서 [확인했음]을 눌러야 업데이트가 열립니다.",
                                       fg=AMBER)
            self._refresh_intake()
        self.intake_last.configure(text=last_intake_text(self.inst))
        self._show_intake()

    def _refresh_intake(self) -> None:
        """로그인돼 있으면 서버 API 값을 다시 읽는다(작업 스레드). 실패는 화면 값만 그대로."""
        session = self.session
        if session is None:
            return

        def read() -> None:
            try:
                value = server_api.read_intake(server_api.verify_server(self.inst, self.runner), session.token)
            except Exception:  # noqa: BLE001 — 읽기만 실패, 다음 동작 때 다시 확인한다
                return
            self.queue.put(("intake_value", value, time.time()))
        threading.Thread(target=read, daemon=True).start()

    def _relogin_if_needed(self, reasons) -> None:
        if any(server_api.RELOGIN in str(r) for r in reasons):
            self.logout()

    # ---------- 켜기·끄기(설계 B-1·B-3) ----------
    def _build_power_page(self, page: tk.Frame) -> None:
        self._header(page, "켜기·끄기 — 서버 예약 작업")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        self.power_state = tk.Label(body, text="확인 중", bg=PANEL, fg=TEXT, font=MONO, justify="left", anchor="w",
                                    padx=12, pady=10)
        self.power_state.pack(fill="x")
        row = tk.Frame(body, bg=BG)
        row.pack(fill="x", pady=10)
        self.power_buttons = [
            self._button(row, "다시 켜기", lambda: self.request_power("server-restart"), primary=True),
            self._button(row, "끄기", lambda: self.request_power("server-stop")),
            self._button(row, "켜기", lambda: self.request_power("server-start")),
        ]
        for button in self.power_buttons:
            button.pack(side="left", padx=(0, 8))
        tk.Label(body, text="[켜기] = Server·Watchdog 둘 다 켜고 시작합니다(꺼 두기 전 상태 복원이 아님). NAS 복사 예약은 건드리지 않습니다. "
                            "모든 동작은 확인 창 → 별도 실행기(창을 닫아도 계속) → 결과를 여기에 보입니다.",
                 bg=BG, fg=MUTED, font=FONT, wraplength=950, justify="left").pack(anchor="w")
        self.power_note = tk.Label(body, text="", bg=BG, fg=MUTED, font=FONT, wraplength=950, justify="left")
        self.power_note.pack(anchor="w", pady=(8, 0))
        repair = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        repair.pack(fill="x", pady=(16, 0))
        tk.Label(repair, text="설치·복구", bg=PANEL, fg=TEXT, font=BOLD).pack(anchor="w", padx=12, pady=(8, 2))
        tk.Label(repair, text="예약 작업이 없어졌거나 다른 설치를 가리킬 때·Python 이 바뀌었을 때만. 예약 작업 3개를 이 설치로 다시 "
                              "만들고(꺼 둔 작업도 켜짐) 서버를 다시 켭니다.",
                 bg=PANEL, fg=MUTED, font=FONT, wraplength=900, justify="left").pack(anchor="w", padx=12)
        self.autostart_button = self._button(repair, "자동시작 다시 등록", self.request_autostart)
        self.autostart_button.pack(anchor="w", padx=12, pady=(6, 10))

    def _show_power(self) -> None:
        tasks = self.tasks or {}
        rows = []
        for name in names.TASKS:
            state = (tasks.get(name) or {}).get("state")
            rows.append(f"{name:<18} {POWER_TASK_WORDS.get(state, state or '확인 불가')}")
        off_state, off = power.read_off(self.inst)
        rows.append("끈 기록          " + ("읽지 못함 — 수동 확인" if off_state == "bad" else "없음" if not off else
                                         f"{OFF_WORDS.get(off['phase'], off['phase'])} · 작업 {off['job_id'][:8]} · "
                                         f"{time.strftime('%m-%d %H:%M', time.localtime(off.get('updated_at') or 0))}"))
        server = status.SERVER_LABELS.get(self.status.server, self.status.server) if self.status else "확인 중"
        rows.append(f"서버              {server}")
        self.power_state.configure(text="\n".join(rows))
        for button in (*self.power_buttons, self.autostart_button):
            button.configure(state="disabled" if self.power_busy else "normal")

    def request_power(self, kind: str) -> None:
        if self.power_busy:
            return
        self.power_busy = True
        self._show_power()
        self.power_note.configure(text="조건을 확인하는 중", fg=MUTED)
        threading.Thread(target=self._power_plan_worker, args=(kind,), daemon=True).start()

    def request_autostart(self) -> None:
        self.request_power("server-autostart")

    def _power_plan_worker(self, kind: str) -> None:
        try:
            tasks = install.task_states(self.runner)
            traces = status.update_traces(self.inst)
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            if kind == "server-autostart":
                plan = actions.plan_autostart(self.inst, tasks, traces, unresolved)
            else:
                ready = status.read_ready(self.inst.port, tls=self.inst.tls)
                plan = actions.plan_power(self.inst, kind, tasks, traces, unresolved, ready.payload)
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self._put(("area_plan", "power", plan))

    # ---------- 서버 이사(설계 D) ----------
    def _build_move_page(self, page: tk.Frame) -> None:
        self._header(page, "서버 이사·복구")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        self.move_state = tk.Label(body, text="확인 중", bg=PANEL, fg=TEXT, font=FONT, justify="left", anchor="w",
                                   padx=12, pady=10, wraplength=950)
        self.move_state.pack(fill="x")
        row = tk.Frame(body, bg=BG)
        row.pack(fill="x", pady=10)
        self.move_buttons = [
            self._button(row, "연습 내보내기", lambda: self.request_move("move-rehearsal")),
            self._button(row, "진짜 이사 내보내기", lambda: self.request_move("move-out"), primary=True),
            self._button(row, "되돌리기(UNDO)", lambda: self.request_move("move-undo")),
        ]
        for button in self.move_buttons:
            button.pack(side="left", padx=(0, 8))
        tk.Label(body, text="질문은 새로 열리는 콘솔 창에서 답합니다. 진짜 이사·복구가 도는 동안 이 창은 DB 를 읽지 않습니다. "
                            "새 PC 들여오기는 새 PC 에서 server_move_IN.bat 을 두 번 눌러 실행하세요(새 PC 에는 아직 관리 창이 제 역할을 못 합니다). "
                            "죽은 서버를 새 PC 에서 NAS 백업으로 되살리는 일은 docs\\SERVER_MIGRATION.md '재해복구'.",
                 bg=BG, fg=MUTED, font=FONT, wraplength=950, justify="left").pack(anchor="w")
        self.move_note = tk.Label(body, text="", bg=BG, fg=MUTED, font=FONT, wraplength=950, justify="left")
        self.move_note.pack(anchor="w", pady=(8, 0))
        restore = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        restore.pack(fill="both", expand=True, pady=(16, 0))
        tk.Label(restore, text="백업으로 복구 — 이 PC 의 DB 를 서버 디스크 자동 백업으로 되살립니다(먼저 [끄기])",
                 bg=PANEL, fg=TEXT, font=BOLD).pack(anchor="w", padx=12, pady=(8, 4))
        self.restore_tree = self._sets_tree(restore)
        self.restore_button = self._button(restore, "이 백업으로 복구", lambda: self.request_move("move-restore"))
        self.restore_button.pack(anchor="w", padx=12, pady=(6, 10))

    def _sets_tree(self, parent: tk.Frame) -> ttk.Treeview:
        tree = ttk.Treeview(parent, columns=("when", "roles", "size", "folder"), show="headings", height=5,
                            selectmode="browse", style="Console.Treeview")
        for column, heading, width in (("when", "시각", 150), ("roles", "구성", 220), ("size", "크기", 90),
                                       ("folder", "폴더", 200)):
            tree.heading(column, text=heading, anchor="w")
            tree.column(column, width=width, anchor="w", stretch=column == "folder")
        tree.pack(fill="x", padx=12)
        return tree

    def _fill_sets(self, tree: ttk.Treeview, rows: list[dict] | None) -> None:
        keep = tree.selection()
        tree.delete(*tree.get_children())
        for index, row in enumerate(rows or []):
            tree.insert("", "end", iid=str(index), values=(_stamp_text(row["stamp"]), " · ".join(row["roles"]),
                                                           f"{row['bytes'] / 1_000_000:,.0f} MB", row.get("folder") or "."))
        if keep and tree.exists(keep[0]):
            tree.selection_set(keep[0])

    def _selected_set(self, tree: ttk.Treeview, rows: list[dict] | None) -> dict | None:
        chosen = tree.selection()
        if not chosen or not rows or int(chosen[0]) >= len(rows):
            return None
        return dict(rows[int(chosen[0])])  # 목록을 읽은 시점의 백업 루트 그대로 — 설정이 바뀌었으면 find_set 이 거절

    def _show_move(self) -> None:
        view = self.move_view or {}
        running, last, (kind, text) = view.get("running"), view.get("last"), view.get("record") or ("", "확인 중")
        lines = [f"이사 기록: {text}"]
        if running:
            lines.append(f"지금 실행 중: {actions.ACTIONS.get(running.get('kind'), running.get('kind'))} — 콘솔 창에서 진행 중"
                         + (" (감싸개 생사 확인 불가 — 창을 확인하세요)" if running.get("wrapper") == "unknown" else ""))
        if last:
            lines.append(f"마지막 이사 작업: {actions.ACTIONS.get(last.get('kind'), last.get('kind'))} — "
                         + area_result_text(last)[0])
        self.move_state.configure(text="\n".join(lines), fg=AMBER if kind in ("bad", "out", "in") or running else TEXT)
        self._fill_sets(self.restore_tree, view.get("sets"))
        for button in (*self.move_buttons, self.restore_button):
            button.configure(state="disabled" if self.move_busy or running else "normal")

    def request_move(self, kind: str) -> None:
        if self.move_busy:
            return
        selection = self._selected_set(self.restore_tree, (self.move_view or {}).get("sets"))\
            if kind == "move-restore" else None
        self.move_busy = True
        self._show_move()
        self.move_note.configure(text="조건을 확인하는 중", fg=MUTED)
        threading.Thread(target=self._move_plan_worker, args=(kind, selection), daemon=True).start()

    def _move_plan_worker(self, kind: str, selection: dict | None) -> None:
        try:
            tasks = install.task_states(self.runner)
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            stopped = power.stopped_problems(self.inst, self.runner) if kind == "move-restore" else None
            plan = actions.plan_move(self.inst, kind, tasks, status.update_traces(self.inst), unresolved,
                                     selection, stopped)
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self._put(("area_plan", "move", plan))

    # ---------- DB·백업 ----------
    def _build_backup_page(self, page: tk.Frame) -> None:
        self._header(page, "DB·백업")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        cards = tk.Frame(body, bg=BG)
        cards.pack(fill="x")
        self.backup_cards: dict[str, tuple[tk.Label, tk.Label]] = {}
        for key, title in (("db", "DB"), ("disk", "백업(서버 디스크)"), ("nas", "NAS 복사")):
            box = tk.Frame(cards, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
            box.pack(side="left", fill="x", expand=True, padx=(0, 8))
            tk.Label(box, text=title, bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(8, 0))
            value = tk.Label(box, text="—", bg=PANEL, fg=TEXT, font=("Malgun Gothic", 15, "bold"))
            value.pack(anchor="w", padx=12)
            sub = tk.Label(box, text="확인 중", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9), justify="left")
            sub.pack(anchor="w", padx=12, pady=(0, 8))
            self.backup_cards[key] = (value, sub)
        where = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        where.pack(fill="x", pady=10)
        tk.Label(where, text="백업 복사 위치 (서버 밖 NAS — 서버가 고장 나도 남게)", bg=PANEL, fg=MUTED,
                 font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(10, 4))
        row = tk.Frame(where, bg=PANEL)
        row.pack(fill="x", padx=12)
        self.backup_entry = tk.Entry(row, bg=PANEL2, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT, width=60,
                                     disabledbackground=PANEL, disabledforeground=MUTED)
        self.backup_entry.pack(side="left", ipady=4)
        self.backup_save = self._button(row, "저장(시험 복사)", lambda: self.request_backup("backup-save"), primary=True)
        self.backup_save.pack(side="left", padx=8)
        self.backup_run = self._button(row, "지금 복사", lambda: self.request_backup("backup-run"))
        self.backup_run.pack(side="left")
        self.backup_task = tk.Label(where, text="", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9), justify="left",
                                    wraplength=900)
        self.backup_task.pack(anchor="w", padx=12, pady=(6, 0))
        self.backup_reasons = tk.Label(where, text="", bg=PANEL, fg=AMBER, font=FONT, justify="left", wraplength=900)
        self.backup_reasons.pack(anchor="w", padx=12, pady=(2, 10))
        notes = tk.Frame(body, bg=BG)
        notes.pack(fill="x")
        self.backup_note = tk.Label(notes, text="", bg=BG, fg=MUTED, font=FONT, justify="left", wraplength=900)
        self.backup_note.pack(side="left")
        self.backup_revert = self._button(notes, "이전 위치로 되돌리기", self.revert_backup)  # 시험 복사가 실패했을 때만
        self.backup_old = ""
        sets = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        sets.pack(fill="x", pady=(12, 0))
        tk.Label(sets, text="서버 디스크의 최근 자동 백업 — 한 줄을 골라 복원 연습(검증만, 서버·실DB 는 그대로)", bg=PANEL, fg=MUTED,
                 font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(8, 4))
        self.backup_sets = self._sets_tree(sets)
        drill = tk.Frame(sets, bg=PANEL)
        drill.pack(fill="x", padx=12, pady=(6, 10))
        self.drill_button = self._button(drill, "이 백업 확인", self.request_drill)
        self.drill_button.pack(side="left")
        self.drill_note = tk.Label(drill, text="", bg=PANEL, fg=MUTED, font=FONT, justify="left", wraplength=780)
        self.drill_note.pack(side="left", padx=10)

    def _show_backup(self) -> None:
        snap = _dict(_dict(self.status.snapshot if self.status else None).get("snapshot"))
        operations = _dict(snap.get("operations"))
        fresh = self.status is not None and self.status.snapshot_state == "ok"
        ready = _dict(operations.get("databases")).get("ready")
        self._backup_card("db", {True: "정상", False: "오류"}.get(ready, "확인 불가") if fresh else "확인 불가",
                          "서버 실행 기록" if fresh else "서버 기록 없음·오래됨",
                          {True: LIME, False: RED}.get(ready, MUTED) if fresh else MUTED)
        backups = _dict(operations.get("backups"))
        sets = _int(backups.get("set_count")) if fresh else None
        latest = backups.get("latest_age_seconds")
        latest = latest if isinstance(latest, (int, float)) and not isinstance(latest, bool) else None
        self._backup_card("disk", "확인 불가" if sets is None else f"{sets}세트",
                          f"마지막 {_ago(latest)}" if latest is not None else "마지막 백업 모름", TEXT if sets else MUTED)
        view = self.backup_view
        if view is None:
            return
        setting = _dict(view.get("setting"))
        result = _dict(setting.get("result"))
        state = result.get("state")
        if not setting:
            nas = ("확인 불가", view.get("error") or "", MUTED)
        elif not setting.get("target"):
            nas = ("없음", "위치를 정하세요", AMBER)
        elif result.get("target_id") not in (None, setting.get("target_id")) or state == "never_run":
            nas = ("아직 안 함", "이 위치로는 아직 복사하지 않았습니다", AMBER)
        elif state == "success":
            when = backup.parse_time(result.get("last_success_at"))
            nas = ("정상", f"마지막 성공 {_ago(time.time() - when.timestamp()) if when else '시각 모름'}", LIME)
        elif state == "failed":
            nas = ("실패", str(result.get("error_code") or ""), RED)
        else:
            nas = ({"disabled": "없음", "no_source": "원본 없음"}.get(state, "확인 불가"), str(state or ""), AMBER)
        self._backup_card("nas", *nas)
        target = str(setting.get("target") or "")
        locked = setting.get("source") == "env"
        if self.backup_entry.get() == self.backup_shown:  # 사람이 고치는 중이면 덮지 않는다
            self.backup_entry.configure(state="normal")
            self.backup_entry.delete(0, "end")
            self.backup_entry.insert(0, target)
            self.backup_shown = target
        self.backup_entry.configure(state="disabled" if locked else "normal")
        task = view.get("task")
        if task and task.get("exists"):
            when = backup.parse_time(task.get("next_run"))
            self.backup_task.configure(text=f"예약 작업(MVHub BackupCopy) · {'켜짐' if task.get('enabled') else '꺼짐'}"
                                            f" · 다음 {time.strftime('%m-%d %H:%M', time.localtime(when.timestamp())) if when else '모름'}"
                                            " · 대상에는 최근 30개 보관")
        else:
            self.backup_task.configure(text="")
        reasons = [r for r in (view.get("unsupported"), view.get("error")) if r] + backup.task_problems(task)
        if locked:
            reasons.append("서버 기계 설정값 CONTENT_HUB_BACKUP_REPLICA_DIR 로 정해져 있어 위치는 보기만 합니다")
        self.backup_reasons.configure(text="\n".join(f"· {r}" for r in reasons))
        rows = view.get("sets")
        self._fill_sets(self.backup_sets, rows)
        if rows is None and not self.drill_busy:
            self.drill_note.configure(text="백업 폴더를 읽지 못했습니다" if "sets" in view else "확인 중", fg=MUTED)
        elif not rows and not self.drill_busy:
            self.drill_note.configure(text="백업이 아직 없습니다", fg=MUTED)
        for button in (self.backup_save, self.backup_run):
            button.configure(state="disabled" if self.backup_busy else "normal")
        self.drill_button.configure(state="disabled" if self.drill_busy else "normal")
        if locked:
            self.backup_save.configure(state="disabled")

    def _backup_card(self, key: str, value: str, sub: str, color: str) -> None:
        label, small = self.backup_cards[key]
        label.configure(text=value, fg=color)
        small.configure(text=sub)

    def request_backup(self, kind: str) -> None:
        if self.backup_busy:
            return
        self.backup_busy = True
        self.backup_revert.pack_forget()
        self._show_backup()
        self.backup_note.configure(text="조건을 확인하는 중", fg=MUTED)
        threading.Thread(target=self._backup_plan_worker, args=(kind, self.backup_entry.get()), daemon=True).start()

    def _backup_plan_worker(self, kind: str, target: str) -> None:
        try:
            view = backup.read_view(self.inst, self.runner)
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            plan = (actions.plan_backup_save(self.inst, view, target, unresolved) if kind == "backup-save"
                    else actions.plan_backup_run(self.inst, view, unresolved))
            self.queue.put(("backup_view", view))
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self.queue.put(("backup_plan", plan))

    def _on_backup_plan(self, plan) -> None:
        if isinstance(plan, actions.Refusal):
            self.backup_busy = False
            self.backup_note.configure(text="하지 않았습니다:\n· " + "\n· ".join(plan.reasons), fg=AMBER)
            self._show_backup()
            return
        target = plan.params.get("target")
        if target and self.backup_entry.get().strip() != target:  # Z:\… 를 실제 주소로 바꾼 것을 칸에도
            self.backup_entry.delete(0, "end")
            self.backup_entry.insert(0, target)
        if messagebox.askokcancel(f"{actions.ACTIONS[plan.kind]} 확인", "\n\n".join(plan.summary) + "\n\n실행할까요?",
                                  icon="warning"):
            self.backup_note.configure(text="시작하는 중", fg=MUTED)
            threading.Thread(target=self._start_worker, args=(plan, "backup"), daemon=True).start()
        else:
            self.backup_busy = False
            self.backup_note.configure(text="")
            self._show_backup()

    def _on_backup_job(self, state: dict, tail: str) -> None:
        status_text = state.get("status")
        if status_text not in JOB_TERMINAL:
            self.backup_note.configure(text=tail or "진행 중", fg=MUTED)
            return
        self.side_jobs.pop("backup", None)
        self.backup_busy, self.backup_due = False, True
        text, color = backup_result_text(state)
        self.backup_note.configure(text=text, fg=color)
        self.backup_old = str(state.get("old_target") or "")
        if status_text == "finished" and state.get("saved") and state.get("exit_code") != 0 and self.backup_old:
            self.backup_revert.pack(side="left", padx=10)
        self._show_backup()

    def request_drill(self) -> None:
        if self.drill_busy:
            return
        selection = self._selected_set(self.backup_sets, (self.backup_view or {}).get("sets"))
        self.drill_busy = True
        self.drill_note.configure(text="조건을 확인하는 중", fg=MUTED)
        self.drill_button.configure(state="disabled")

        def plan_worker() -> None:
            try:
                plan = actions.plan_drill(self.inst, selection, jobs.unresolved_jobs_or_repair(self.inst, self.runner))
            except Exception as exc:  # noqa: BLE001
                plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
            self._put(("area_plan", "drill", plan))
        threading.Thread(target=plan_worker, daemon=True).start()

    def revert_backup(self) -> None:
        """시험 복사가 실패한 뒤 이전 위치로 — 같은 [저장(시험 복사)] 절차로(확인·재확인·시험 복사)."""
        self.backup_entry.configure(state="normal")
        self.backup_entry.delete(0, "end")
        self.backup_entry.insert(0, self.backup_old)
        self.request_backup("backup-save")

    # ---------- 릴리스·주소 공통 ----------
    def _area_note(self, area: str) -> tk.Label:
        return {"intake": self.intake_note, "backup": self.backup_note, "release": self.release_note,
                "address": self.address_note, "power": self.power_note, "drill": self.drill_note,
                "move": self.move_note}[area]

    def _on_area_plan(self, area: str, plan) -> None:
        note = self._area_note(area)
        if isinstance(plan, actions.Refusal):
            setattr(self, f"{area}_busy", False)
            self._relogin_if_needed(plan.reasons)
            note.configure(text="하지 않았습니다:\n· " + "\n· ".join(plan.reasons), fg=AMBER)
            self._show_area(area)
            return
        confirmed = (self._confirm_release_delete(plan) if plan.kind == "release-delete" else
                     messagebox.askokcancel(f"{actions.ACTIONS[plan.kind]} 확인",
                                            "\n\n".join(plan.summary) + "\n\n실행할까요?", icon="warning"))
        if confirmed:
            note.configure(text="시작하는 중", fg=MUTED)
            threading.Thread(target=self._start_worker, args=(plan, area), daemon=True).start()
        else:
            setattr(self, f"{area}_busy", False)
            note.configure(text="")
            self._show_area(area)

    def _confirm_release_delete(self, plan: actions.Plan) -> bool:
        dialog = tk.Toplevel(self.root)
        dialog.title("릴리스 삭제")
        dialog.configure(bg=PANEL)
        dialog.transient(self.root)
        dialog.resizable(False, False)
        confirmed = False

        def finish(value=False):
            nonlocal confirmed
            confirmed = value
            dialog.destroy()

        tk.Label(dialog, text="\n\n".join(plan.summary), bg=PANEL, fg=TEXT, font=FONT,
                 wraplength=520, justify="left", anchor="w", padx=20, pady=20).pack(fill="x")
        buttons = tk.Frame(dialog, bg=PANEL)
        buttons.pack(fill="x", padx=20, pady=(0, 20))
        delete = self._button(buttons, "삭제", lambda: finish(True), primary=True)
        delete.pack(side="right")
        cancel = self._button(buttons, "취소", finish)
        cancel.pack(side="right", padx=8)
        cancel.configure(default="active")
        cancel.bind("<Return>", lambda _e: finish())
        delete.bind("<Return>", lambda _e: finish(True))
        dialog.bind("<Escape>", lambda _e: finish())
        dialog.protocol("WM_DELETE_WINDOW", finish)
        dialog.wait_visibility()
        dialog.grab_set()
        cancel.focus_set()
        self.root.wait_window(dialog)
        return confirmed

    def _on_area_job(self, area: str, state: dict, tail: str) -> None:
        note = self._area_note(area)
        if state.get("status") not in JOB_TERMINAL:
            note.configure(text=tail or "진행 중", fg=MUTED)
            return
        self.side_jobs.pop(area, None)
        setattr(self, f"{area}_busy", False)
        self.release_due = self.move_due = self.backup_due = True
        if state.get("auth_expired"):
            self.logout()
        text, color = area_result_text(state)
        note.configure(text=text, fg=color)
        self._show_area(area)

    def _show_area(self, area: str) -> None:
        {"release": self._show_release, "address": self._show_address_page, "power": self._show_power,
         "drill": self._show_backup, "move": self._show_move}[area]()

    # ---------- 릴리스 ----------
    def _build_release_page(self, page: tk.Frame) -> None:
        self._header(page, "릴리스 — 팀원 앱 배포")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        folder = tk.Frame(body, bg=BG)
        folder.pack(fill="x")
        tk.Label(folder, text="NAS 릴리스 폴더", bg=BG, fg=MUTED, font=FONT).pack(side="left")
        self.release_entry = tk.Entry(folder, bg=PANEL2, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT,
                                      width=60)
        self.release_entry.pack(side="left", padx=8, ipady=3)
        self._button(folder, "저장", self.save_release_source).pack(side="left")
        self.release_shown = ""
        self.release_all = False  # 이전 릴리스까지 다 보이기(처음엔 최근 8개 + 배포 중·후보)
        tk.Label(body, text="NAS 릴리스 폴더의 모든 릴리스. [배포] = 팀원에게 알림이 가고 그 릴리스로 업데이트(옛 릴리스면 되돌리기). "
                            "[해제] = 팀원 알림만 거둠(배포는 그대로) · [삭제] = 확인 후 릴리스 파일 삭제.",
                 bg=BG, fg=MUTED, font=("Malgun Gothic", 9), wraplength=950, justify="left").pack(anchor="w", pady=(8, 4))
        self.release_warn = tk.Label(body, text="", bg=BG, fg=AMBER, font=FONT, wraplength=950, justify="left")
        self.release_warn.pack(anchor="w")
        # 아래 안내·결과 줄을 먼저 아래쪽에 붙인다 — 목록이 길어도 밀려나지 않고, 목록은 남은 자리에서 스크롤한다.
        tk.Label(body, text="배포할 때 순서: ① 생성 접수 멈추기 → ② 서버 Git 업데이트 → ③ [배포] → ④ 팀원 업데이트 끝나면 생성 접수 다시 받기. "
                            "업데이트·배포가 실패하면 생성 접수는 멈춘 채로 두고 위 결과를 보세요.",
                 bg=PANEL, fg=TEXT, font=FONT, wraplength=950, justify="left", anchor="w", padx=12, pady=8
                 ).pack(side="bottom", fill="x", pady=8)
        notes = tk.Frame(body, bg=BG)
        notes.pack(side="bottom", fill="x")
        self.release_note = tk.Label(notes, text="", bg=BG, fg=MUTED, font=FONT, wraplength=820, justify="left")
        self.release_note.pack(side="left")
        self.release_resume = self._button(notes, "이어서 하기", lambda: self.request_release("release-resume", None))
        holder = tk.Frame(body, bg=BG)
        holder.pack(fill="both", expand=True, pady=6)
        holder.columnconfigure(0, weight=1)
        holder.rowconfigure(1, weight=1)
        header_canvas = tk.Canvas(holder, bg=PANEL2, height=34, highlightthickness=0, bd=0)
        header_canvas.grid(row=0, column=0, sticky="ew")
        self.release_header = tk.Frame(header_canvas, bg=PANEL2, highlightbackground=PANEL2, highlightthickness=1)
        header_window = header_canvas.create_window((0, 0), window=self.release_header, anchor="nw")
        for column, (label, width) in enumerate(RELEASE_COLUMNS):
            self.release_header.columnconfigure(column, minsize=width, weight=column == 0)
            tk.Label(self.release_header, text=label, bg=PANEL2, fg=MUTED, font=BOLD,
                     anchor="w", width=1, padx=10, pady=7).grid(row=0, column=column, sticky="ew")
        self.release_canvas = tk.Canvas(holder, bg=BG, highlightthickness=0, bd=0)
        scroll = ttk.Scrollbar(holder, orient="vertical", command=self.release_canvas.yview)
        self.release_canvas.configure(yscrollcommand=scroll.set)
        scroll.grid(row=1, column=1, sticky="ns")
        self.release_canvas.grid(row=1, column=0, sticky="nsew")
        def scroll_x(*args):
            self.release_canvas.xview(*args)
            header_canvas.xview(*args)
        horizontal = ttk.Scrollbar(holder, orient="horizontal", command=scroll_x)
        horizontal.grid(row=2, column=0, sticky="ew")
        self.release_canvas.configure(xscrollcommand=horizontal.set)
        self.release_rows = tk.Frame(self.release_canvas, bg=BG)
        window = self.release_canvas.create_window((0, 0), window=self.release_rows, anchor="nw")
        self.release_rows.bind("<Configure>", lambda _e: self.release_canvas.configure(
            scrollregion=self.release_canvas.bbox("all")))
        def resize(e):
            width = max(e.width, sum(size for _label, size in RELEASE_COLUMNS) + 2)
            self.release_canvas.itemconfigure(window, width=width)
            header_canvas.itemconfigure(header_window, width=width)
            header_canvas.configure(scrollregion=(0, 0, width, 34))
        self.release_canvas.bind("<Configure>", resize)
        wheel = lambda e: self.release_canvas.yview_scroll(-1 if e.delta > 0 else 1, "units")  # noqa: E731
        holder.bind("<Enter>", lambda _e: self.release_canvas.bind_all("<MouseWheel>", wheel))
        holder.bind("<Leave>", lambda _e: self.release_canvas.unbind_all("<MouseWheel>"))

    def save_release_source(self) -> None:
        typed = self.release_entry.get().strip()
        fixed, why = install.network_path(typed)
        if not why and fixed != typed:  # 바꾼 주소를 사람이 보고 다시 누를 때만 저장한다
            self.release_entry.delete(0, "end")
            self.release_entry.insert(0, fixed)
            self.release_note.configure(text=f"{typed[:2]} 는 관리자 권한인 이 창에서 보이지 않아 실제 주소로 바꿔 넣었습니다 "
                                             "— 맞으면 [저장]을 다시 누르세요", fg=AMBER)
            return
        try:
            release.save_source(self.inst, typed)
        except (release.ReleaseError, OSError) as exc:
            self.release_note.configure(text=f"저장하지 않았습니다: {exc}", fg=AMBER)
            return
        self.release_shown = typed
        self.release_note.configure(text="NAS 릴리스 폴더를 저장했습니다 — 목록을 다시 읽습니다", fg=LIME)
        self.release_due = True

    def _show_release(self) -> None:
        view = self.release_view or {}
        source = str(view.get("source") or "")
        if self.release_entry.get().strip() == self.release_shown:  # 사람이 고치는 중이면 덮지 않는다
            self.release_entry.delete(0, "end")
            self.release_entry.insert(0, source)
            self.release_shown = source
        read = view.get("read") or {}
        overview = read.get("overview") if isinstance(read.get("overview"), dict) else None
        notices = view.get("notices")
        warnings = []
        if not source:
            warnings.append("NAS 릴리스 폴더를 정하세요(팀원 PC 의 INSTALL_SOURCE.txt 에 적힌 것과 같은 폴더)")
        else:
            fixed, why = install.network_path(source)
            if why or fixed != source:  # 전에 Z:\… 로 저장해 둔 값
                warnings.append(why or f"{source[:2]} 같은 연결 드라이브는 관리자 권한인 이 창에서 보이지 않습니다 — "
                                       "[저장]을 누르면 실제 주소로 바꿔 보여 줍니다")
        if source and read and not read.get("ok"):
            warnings.append(str(read.get("error")))
        warnings += [str(read[k]) for k in ("packages_error", "overview_error") if read.get(k)]
        if overview and overview.get("candidate_error"):
            warnings.append("NAS 의 후보 파일(candidate.json)을 읽을 수 없어 배포를 막았습니다 — 릴리스를 다시 만들어 올리세요")
        if overview and overview.get("published_state") == "error":
            warnings.append("팀 공개 표지(latest.json)를 읽을 수 없어 배포 상태를 확인할 수 없습니다")
        if notices is None:
            warnings.append("관리자로 로그인하면 팀원 알림 상태와 [배포]·[해제]·[삭제] 단추를 사용할 수 있습니다"
                            + (f" — {view.get('notice_error')}" if view.get("notice_error") else ""))
        self.release_warn.configure(text="\n".join(f"· {w}" for w in warnings))
        for child in self.release_rows.winfo_children():
            child.destroy()
        rows = read.get("packages") if isinstance(read.get("packages"), list) else []
        published, candidate = release.shas(overview)
        pub = (overview or {}).get("published") or {}
        cand_file = (overview or {}).get("file") if (overview or {}).get("source") == "candidate" else None
        blocked = (not read.get("ok") or bool(read.get("packages_error")) or bool(read.get("overview_error")) or overview is None
                   or bool(overview.get("candidate_error")) or overview.get("published_state") == "error")
        delete_blocked = not read.get("ok") or bool(read.get("packages_error"))
        shown = [r for i, r in enumerate(rows)
                 if self.release_all or i < 8 or r.get("file") in (pub.get("file"), cand_file)]
        for row in shown:
            sha = published if row.get("file") == pub.get("file") else candidate if row.get("file") == cand_file else ""
            notice = next((n for n in notices or [] if n.get("file") == row.get("file")
                           and (not sha or n.get("sha256") == sha)), None)
            self._release_row(row, notice, live=row.get("file") == pub.get("file"),
                              candidate=row.get("file") == cand_file,
                              logged_in=notices is not None, blocked=blocked,
                              removed=row.get("file") in (view.get("removed_files") or []), delete_blocked=delete_blocked)
        if not shown:
            empty = "릴리스가 없습니다" if read.get("ok") and not read.get("packages_error") else "릴리스 목록을 읽지 못했습니다"
            tk.Label(self.release_rows, text=empty if source and read else "", bg=BG, fg=MUTED,
                     font=FONT).pack(anchor="w")
        if len(rows) > len(shown):
            self._button(self.release_rows, f"이전 릴리스 {len(rows) - len(shown)}개 더 보기 ▾", self.show_all_releases
                         ).pack(anchor="w", pady=4)
        resume = view.get("resume")
        if resume and notices is not None:
            self.release_resume.configure(text=f"이어서 하기 — v{resume.get('version')}",
                                          state="disabled" if self.release_busy else "normal")
            self.release_resume.pack(side="left", padx=10)
        else:
            self.release_resume.pack_forget()

    def show_all_releases(self) -> None:
        self.release_all = True
        self._show_release()

    def _release_row(self, row: dict, notice: dict | None, live: bool, candidate: bool, logged_in: bool,
                     blocked: bool, removed: bool = False, delete_blocked: bool = False) -> None:
        revision = int((notice or {}).get("announcement_revision") or 0)
        waiting = candidate and revision > 0
        line = tk.Frame(self.release_rows, bg=PANEL, highlightbackground=LIME if live else "#26282d", highlightthickness=1)
        line.pack(fill="x", pady=(0, 2))
        line.rowconfigure(0, minsize=54)
        for column, (_label, width) in enumerate(RELEASE_COLUMNS):
            line.columnconfigure(column, minsize=width, weight=column == 0)
        tag = ("팀 배포 중", LIME) if live else ("공지됨 · 아직 배포 안 됨", AMBER) if waiting else\
            ("새 후보 · 배포 전", CYAN) if candidate else ("", MUTED)
        size = row.get("size") if isinstance(row.get("size"), int) else 0
        values = (f"v{row.get('version')}", tag[0] + (f" · 알림 {revision}회" if revision else ""),
                  f"{size / 1024 / 1024:,.0f}MB", _built_at(str(row.get('version') or '')))
        for column, text in enumerate(values):
            tk.Label(line, text=text, bg=PANEL, fg=tag[1] if column == 1 else TEXT if column == 0 else MUTED,
                     font=BOLD if column == 0 else FONT, anchor="w", width=1,
                     wraplength=RELEASE_COLUMNS[column][1] - 20, padx=10, pady=9
                     ).grid(row=0, column=column, sticky="ew")
        target = {**row, "notice": notice}
        buttons = [("✓ 배포" if live and not blocked else "배포", "release-deploy", live and not blocked, blocked),
                   ("✓ 해제" if removed and not notice else "해제", "release-remove", removed and not notice,
                    removed and not notice),
                   ("삭제", "release-delete", False, delete_blocked or live or candidate or bool(notice))]
        for column, (label, kind, complete, off) in enumerate(buttons, 4):
            button = self._button(line, label, lambda k=kind: self.request_release(k, target))
            button.configure(fg=LIME if complete else TEXT,
                             state="disabled" if self.release_busy or not logged_in or off else "normal",
                             disabledforeground=LIME if complete else MUTED2)
            button.grid(row=0, column=column, sticky="ew", padx=5, pady=5)

    def request_release(self, kind: str, row: dict | None) -> None:
        if not self.release_busy:
            self.require_login(lambda: self._begin_release(kind, row))

    def _begin_release(self, kind: str, row: dict | None) -> None:
        if self.release_busy or self.session is None:
            return
        if kind == "release-delete":
            read = (self.release_view or {}).get("read") or {}
            overview = read.get("overview") or {}
            if (not row or (self.release_view or {}).get("notices") is None
                    or not read.get("ok") or read.get("packages_error") or row.get("notice")
                    or row.get("file") in ((overview.get("published") or {}).get("file"), overview.get("file"))):
                self.release_note.configure(text="배포 중이거나 후보인 릴리스, 상태를 확인하지 못한 릴리스는 삭제할 수 없습니다", fg=AMBER)
                return
        if kind == "release-resume":
            row = (self.release_view or {}).get("resume")
            if not row:
                return
        self.release_busy = True
        self._show_release()
        self.release_note.configure(text="서버·릴리스 폴더를 확인하는 중", fg=MUTED)
        threading.Thread(target=self._release_plan_worker, args=(kind, row, self.session), daemon=True).start()

    def _release_plan_worker(self, kind: str, row: dict, session: server_api.Session) -> None:
        try:
            server = server_api.verify_server(self.inst, self.runner)  # 토큰을 보내기 전에 늘 다시 확인
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            source = release.release_source(self.inst)
            if kind == "release-resume":
                params, state, intent = release.resume_source(self.inst, row["job_id"])
                plan = actions.plan_release_resume(self.inst, server, source, row["job_id"], params, state, intent,
                                                   unresolved, release.resume_chain(self.inst, row["job_id"]))
            elif kind in ("release-deploy", "release-delete"):
                read = release.helper(self.inst, release.scratch_dir(self.inst), source, "read")
                overview = read.get("overview") if isinstance(read.get("overview"), dict) else {}
                if kind == "release-deploy" and overview.get("source") == "candidate" and overview.get("file") == row["file"]:
                    fields = {key: overview[key] for key in release.FIELDS}
                else:
                    self.queue.put(("area_note", "release", "릴리스 파일 지문을 확인하는 중(수백 MB — 몇 분 걸릴 수 있음)"))
                    answer = release.helper(self.inst, release.scratch_dir(self.inst), source,
                                            "delete-info" if kind == "release-delete" else "manifest", row["file"],
                                            timeout=release.HASH_TIMEOUT)
                    if not answer.get("ok"):
                        raise release.ReleaseError(str(answer.get("error")))
                    fields = answer["manifest"]
                notice = (release.find_delete_notice(server, session.token, fields) if kind == "release-delete"
                          else release.find_notice(server, session.token, str(fields.get("sha256") or "")))
                planner = actions.plan_release_delete if kind == "release-delete" else actions.plan_release_deploy
                plan = planner(self.inst, server, source, read, fields, notice, unresolved)
            else:
                sha = str((row.get("notice") or {}).get("sha256") or "")
                if not sha and kind == "release-remove":
                    read = release.helper(self.inst, release.scratch_dir(self.inst), source, "read")
                    overview = read.get("overview") or {}
                    fields = next((item for item in (overview, overview.get("published") or {})
                                   if item.get("file") == row.get("file") and item.get("sha256")), None)
                    if fields is None:
                        answer = release.helper(self.inst, release.scratch_dir(self.inst), source,
                                                "delete-info", row["file"], timeout=release.HASH_TIMEOUT)
                        if not answer.get("ok"):
                            raise release.ReleaseError(str(answer.get("error")))
                        fields = answer["manifest"]
                    sha = str(fields.get("sha256") or "")
                notice = release.find_notice(server, session.token, sha) if sha else None
                plan = actions.plan_notice_action(self.inst, kind, server, notice, sha, unresolved)
        except (server_api.ServerError, release.ReleaseError) as exc:
            plan = actions.Refusal((str(exc),))
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self.queue.put(("area_plan", "release", plan))

    # ---------- 주소 ----------
    def _build_address_page(self, page: tk.Frame) -> None:
        self._header(page, "서버 주소")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)

        def card(title: str) -> tk.Frame:
            box = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
            box.pack(fill="x", pady=(0, 10))
            tk.Label(box, text=title, bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(8, 2))
            return box
        now = card("현재 서버 주소 (이 PC의 네트워크 주소 · 포트)")
        row = tk.Frame(now, bg=PANEL)
        row.pack(fill="x", padx=12, pady=(0, 10))
        self.address_now = tk.Label(row, text="확인 중", bg=PANEL, fg=TEXT, font=("Malgun Gothic", 13, "bold"),
                                    justify="left")
        self.address_now.pack(side="left")
        self._button(row, "복사", self.copy_address).pack(side="right")
        name = card("팀원 앱에 보이는 서버 이름 ([팀에 공지] 때 함께 기록 — 비우면 주소로 보임)")
        self.name_entry = tk.Entry(name, bg=PANEL2, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT, width=40)
        self.name_entry.pack(anchor="w", padx=12, pady=(0, 10), ipady=3)
        move = card("주소를 바꿀 때 (이사·IP 변경)")
        row = tk.Frame(move, bg=PANEL)
        row.pack(fill="x", padx=12)
        self.url_entry = tk.Entry(row, bg=PANEL2, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT, width=40)
        self.url_entry.pack(side="left", ipady=3)
        self.address_button = self._button(row, "팀에 공지", self.request_address, primary=True)
        self.address_button.pack(side="left", padx=8)
        tk.Label(move, text="NAS 릴리스 폴더에 이사 공지(server-location.json)를 남김 → 팀원 앱에 알림 → 누르면 새 주소로 전환(자동 전환 아님)",
                 bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9)).pack(anchor="w", padx=12, pady=(4, 2))
        self.location_label = tk.Label(move, text="", bg=PANEL, fg=MUTED, font=("Malgun Gothic", 9), justify="left")
        self.location_label.pack(anchor="w", padx=12, pady=(0, 10))
        self.address_note = tk.Label(body, text="", bg=BG, fg=MUTED, font=FONT, wraplength=950, justify="left")
        self.address_note.pack(anchor="w")
        tk.Label(body, text="서버 이사(3단계)는 이 화면에서 이어집니다.", bg=BG, fg=MUTED2, font=("Malgun Gothic", 9)
                 ).pack(anchor="w", pady=(8, 0))

    def _show_address_page(self) -> None:
        scheme = "https" if self.inst.tls else "http"
        urls = [f"{scheme}://{ip}:{self.inst.port}  ({alias})" for alias, ip in (self.addresses or [])]
        self.address_now.configure(text="\n".join(urls) if urls else
                                   ("네트워크 주소 확인 불가" if self.addresses is None else "네트워크 주소 없음"))
        view = self.address_view or {}
        location = view.get("location") or {}
        current = location.get("announcement") if isinstance(location.get("announcement"), dict) else None
        state = view.get("state") or {}
        if not view:
            self.location_label.configure(text="")
        elif not view.get("source"):
            self.location_label.configure(text="NAS 릴리스 폴더를 먼저 정하세요(릴리스 화면)", fg=AMBER)
        elif not location.get("ok"):
            self.location_label.configure(text=f"지금 공지 파일을 읽지 못했습니다 — {location.get('error')}", fg=AMBER)
        elif current is None:
            self.location_label.configure(text="지금 공지: 아직 없음", fg=MUTED)
        else:
            self.location_label.configure(text=f"지금 공지: 판 {current.get('revision')} · {current.get('url')}"
                                               f" · 이름 '{current.get('name') or '없음'}' · {current.get('announced_at')}",
                                          fg=MUTED)
        wanted = (str((current or {}).get("url") or ""), str(state.get("server_name") or (current or {}).get("name") or ""))
        if (self.url_entry.get(), self.name_entry.get()) == self.address_shown:  # 고치는 중이면 덮지 않는다
            for entry, value in ((self.url_entry, wanted[0]), (self.name_entry, wanted[1])):
                entry.delete(0, "end")
                entry.insert(0, value)
            self.address_shown = wanted
        self.address_button.configure(state="disabled" if self.address_busy else "normal")

    def request_address(self) -> None:
        if self.address_busy:
            return
        self.address_busy = True
        self._show_address_page()
        self.address_note.configure(text="지금 공지 파일을 확인하는 중", fg=MUTED)
        threading.Thread(target=self._address_plan_worker, args=(self.url_entry.get(), self.name_entry.get()),
                         daemon=True).start()

    def _address_plan_worker(self, url: str, name: str) -> None:
        try:
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            source = release.release_source(self.inst)
            location = release.read_location(self.inst, release.scratch_dir(self.inst), source)
            plan = actions.plan_address_notice(self.inst, source, location, url, name, unresolved)
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        self.queue.put(("area_plan", "address", plan))

    def _build_update_page(self, page: tk.Frame) -> None:
        self._header(page, "업데이트(서버 Git)")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        tk.Label(body, text="GitHub main 의 코드로 이 서버를 바꿉니다. 옆에서 새 코드를 준비·시험한 뒤 마지막에 서버를 잠깐 "
                             "멈추고 새 버전으로 전환합니다(약 30초 끊김). 실패하면 이전 코드로 저절로 돌아갑니다.",
                 bg=BG, fg=MUTED, font=FONT, wraplength=900, justify="left").pack(anchor="w")
        row = tk.Frame(body, bg=BG)
        row.pack(fill="x", pady=10)
        self.start_button = self._button(row, "Git 업데이트", self.request_plan, primary=True)
        self.start_button.pack(side="left")
        self.plan_note = tk.Label(row, text="", bg=BG, fg=AMBER, font=FONT, justify="left", wraplength=820)
        self.plan_note.pack(side="left", padx=12)
        steps = tk.Frame(body, bg=BG)
        steps.pack(fill="x", pady=(6, 2))
        self.step_bars: list[tk.Frame] = []
        self.step_labels: list[tk.Label] = []
        for index, label in enumerate(STEP_LABELS, 1):
            cell = tk.Frame(steps, bg=BG)
            cell.pack(side="left", fill="x", expand=True, padx=3)
            bar = tk.Frame(cell, bg="#26282d", height=6)
            bar.pack(fill="x")
            text = tk.Label(cell, text=f"{index} {label}", bg=BG, fg=MUTED2, font=("Malgun Gothic", 9))
            text.pack(anchor="w")
            self.step_bars.append(bar)
            self.step_labels.append(text)
        frame = tk.Frame(body, bg=PANEL)
        frame.pack(fill="both", expand=True, pady=8)
        self.job_text = tk.Text(frame, bg="#07080a", fg=MUTED, font=MONO, relief="flat", bd=0, padx=12, pady=8,
                                wrap="word", highlightthickness=0, state="disabled")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.job_text.yview)
        self.job_text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.job_text.pack(fill="both", expand=True)
        bottom = tk.Frame(body, bg=BG)
        bottom.pack(fill="x")
        self.result_label = tk.Label(bottom, text="", bg=BG, fg=TEXT, font=("Malgun Gothic", 12, "bold"), anchor="w",
                                     justify="left", wraplength=900)
        self.result_label.pack(side="left", fill="x")
        self.ack_button = self._button(bottom, "확인했음", self.acknowledge)  # 결과를 잃은 작업에만 보인다
        self.reopen_button = self._button(bottom, "관리 창 다시 열기", self.reopen, primary=True)  # 관리 창이 바뀐 뒤에만
        tools = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        tools.pack(fill="x", pady=(10, 0))
        tk.Label(tools, text="관리 도구", bg=PANEL, fg=TEXT, font=BOLD).pack(side="left", padx=(12, 8), pady=8)
        console_sha = running_console_sha()
        tk.Label(tools, text=f"{console_sha[:12]} (관리 창 stage)" if console_sha else "서버 폴더 판(아직 갱신 안 함)",
                 bg=PANEL, fg=MUTED, font=FONT).pack(side="left")
        self.rollback_button = self._button(tools, "이전 관리 창", lambda: self.request_plan("console-rollback"))
        self.rollback_button.pack(side="right", padx=8, pady=6)
        self.tools_button = self._button(tools, "관리 도구 갱신", lambda: self.request_plan("tools-update"))
        self.tools_button.pack(side="right", pady=6)
        self.start_buttons = (self.start_button, self.tools_button, self.rollback_button)

    # ---------- 동작 ----------
    def copy_address(self) -> None:
        if not self.copy_text:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.copy_text)

    # ---------- 관리자 로그인 ----------
    def toggle_login(self) -> None:
        if self.session is not None:
            self.logout()
        else:
            self.require_login(None)

    def logout(self) -> None:
        """토큰을 버린다(서버 로그아웃 API 는 그 계정의 MCP 연결까지 끊으므로 부르지 않는다)."""
        self.session = None
        self.login_label.configure(text="관리자 로그인 안 함", fg=MUTED)
        self.login_button.configure(text="로그인")
        self.release_due = True  # 로그인으로만 보이던 알림 상태·단추를 거둔다
        self.presence = None
        self._render_presence()

    def require_login(self, then) -> None:
        """로그인돼 있으면 then() 을 바로, 아니면 로그인 창 → 성공한 뒤 then()."""
        if self.session is not None:
            if then:
                then()
            return
        self.after_login = then
        if self.login_window is not None:
            self.login_window.lift()
            return
        window = tk.Toplevel(self.root, bg=PANEL)
        window.title("관리자 로그인")
        window.transient(self.root)
        window.resizable(False, False)
        window.protocol("WM_DELETE_WINDOW", self._close_login)
        tk.Label(window, text="서버 관리자 계정으로 로그인합니다(이 PC 의 서버 127.0.0.1 로만 보냅니다).",
                 bg=PANEL, fg=MUTED, font=FONT, wraplength=360, justify="left").pack(anchor="w", padx=16, pady=(14, 8))
        fields = {}
        for key, label in (("email", "이메일"), ("password", "비밀번호")):
            tk.Label(window, text=label, bg=PANEL, fg=TEXT, font=FONT).pack(anchor="w", padx=16)
            entry = tk.Entry(window, bg=PANEL2, fg=TEXT, insertbackground=TEXT, relief="flat", font=FONT, width=40,
                             show="•" if key == "password" else "")
            entry.pack(fill="x", padx=16, pady=(0, 8))
            fields[key] = entry
        self.login_note = tk.Label(window, text="", bg=PANEL, fg=AMBER, font=FONT, wraplength=360, justify="left")
        self.login_note.pack(anchor="w", padx=16)
        row = tk.Frame(window, bg=PANEL)
        row.pack(fill="x", padx=16, pady=12)
        self.login_send = self._button(row, "로그인", lambda: self._send_login(fields), primary=True)
        self.login_send.pack(side="right")
        self._button(row, "취소", self._close_login).pack(side="right", padx=8)
        fields["password"].bind("<Return>", lambda _e: self._send_login(fields))
        fields["email"].focus_set()
        self.login_window = window

    def _send_login(self, fields: dict) -> None:
        email, password = fields["email"].get().strip(), fields["password"].get()
        if not email or not password:
            self.login_note.configure(text="이메일과 비밀번호를 넣으세요")
            return
        fields["password"].delete(0, "end")  # 화면에도 남기지 않는다(실패하면 다시 넣는다)
        self.login_send.configure(state="disabled")
        self.login_note.configure(text="서버를 확인하고 로그인하는 중", fg=MUTED)
        threading.Thread(target=self._login_worker, args=(email, password), daemon=True).start()

    def _login_worker(self, email: str, password: str) -> None:
        try:
            result = server_api.login(self.inst, self.runner, email, password)
        except server_api.ServerError as exc:
            result = str(exc)
        except Exception as exc:  # noqa: BLE001 — 이유만 화면에(비밀번호는 예외 문구에 들어가지 않는다)
            result = f"로그인 중 오류: {type(exc).__name__}"
        self.queue.put(("login", result))

    def _on_login(self, result) -> None:
        if isinstance(result, str):
            if self.login_window is not None:
                self.login_note.configure(text=result, fg=AMBER)
                self.login_send.configure(state="normal")
            return
        self.session = result
        self.login_label.configure(text=f"관리자: {result.email}", fg=LIME)
        self.login_button.configure(text="로그아웃")
        then, self.after_login = self.after_login, None
        self._close_login(keep_pending=True)
        self.release_due = True  # 릴리스 화면의 알림 상태·단추
        if then:
            then()
        else:
            self._refresh_intake()  # 로그인하면 생성 접수를 서버 값으로 다시 읽는다

    def _close_login(self, keep_pending: bool = False) -> None:
        if not keep_pending:
            self.after_login = None
        if self.login_window is not None:
            self.login_window.destroy()
            self.login_window = None

    def acknowledge(self) -> None:
        if not messagebox.askokcancel("결과 확인", "서버 상태와 로그로 지난 업데이트 결과를 확인했나요?\n"
                                      "확인했다고 표시하면 새 업데이트를 시작할 수 있습니다.", icon="warning"):
            return
        try:
            jobs.acknowledge(self.inst, self.job_id)
        except (jobs.JobError, OSError) as exc:
            messagebox.showerror("결과 확인", f"표시하지 못했습니다: {exc}")
            return
        self.ack_button.pack_forget()
        self._job_done()

    def find_next(self) -> None:
        needle = self.search.get().strip()
        tab = logs.TABS[self.notebook.index("current")][0]
        text = self.texts[tab]
        text.tag_remove("hit", "1.0", "end")
        if not needle:
            return
        start = text.index("insert") if text.tag_ranges("sel") else "1.0"
        found = text.search(needle, f"{start}+1c", stopindex="end", nocase=True) or text.search(needle, "1.0", stopindex="end", nocase=True)
        if found:
            text.tag_add("hit", found, f"{found}+{len(needle)}c")
            text.mark_set("insert", found)
            text.see(found)

    def _set_start_buttons(self, state: str) -> None:
        for button in self.start_buttons:
            button.configure(state=state)

    def request_plan(self, kind: str = "git-update") -> None:
        if self.busy:
            return
        self.busy = True
        self._set_start_buttons("disabled")
        self.plan_note.configure(text="대상과 조건을 확인하는 중", fg=MUTED)
        threading.Thread(target=self._plan_worker, args=(kind,), daemon=True).start()

    def _plan_worker(self, kind: str = "git-update") -> None:
        unresolved: list[str] | None = []
        try:
            unresolved = jobs.unresolved_jobs_or_repair(self.inst, self.runner)
            if kind == "tools-update":
                plan = actions.plan_tools_update(self.inst, status.update_traces(self.inst), unresolved)
            elif kind == "console-rollback":
                plan = actions.plan_console_rollback(self.inst, console_stage.read_pointer(self.inst.root),
                                                     status.update_traces(self.inst), unresolved)
            else:
                tasks = install.task_states(self.runner)
                plan = actions.plan_git_update(self.inst, install.server_task_matches(self.inst, tasks),
                                               status.update_traces(self.inst),
                                               install.untrusted_writers(self.inst, self.runner),
                                               unresolved_jobs=unresolved)
                if isinstance(plan, actions.Plan):  # Git 은 검사를 통과한 뒤에만 실행한다
                    plan = actions.with_reference(plan, self.inst, actions.reference_main(self.inst, self.runner))
        except Exception as exc:  # noqa: BLE001
            plan = actions.Refusal((f"확인 중 오류: {type(exc).__name__}: {exc}"[:300],))
        if isinstance(plan, actions.Refusal) and unresolved:
            self.queue.put(("job_select", unresolved[0]))  # 막고 있는 작업을 보여 [확인했음]을 누를 수 있게
        self.queue.put(("plan", plan))  # 버리면 busy 가 안 풀린다 — 자리가 날 때까지 기다린다

    def _on_plan(self, plan) -> None:
        if isinstance(plan, actions.Refusal):
            self.busy = False
            if not self.ack_button.winfo_manager():  # 결과 확인 전에는 시작 단추를 다시 켜지 않는다
                self._set_start_buttons("normal")
            self.plan_note.configure(text="지금은 시작할 수 없습니다:\n· " + "\n· ".join(plan.reasons), fg=AMBER)
            return
        # 권한 알림은 막지 않고 업데이트 화면에만 남긴다(Jay 결정 2026-10-23 — actions.acl_warnings).
        self.plan_note.configure(text="\n".join(f"참고: {w}" for w in plan.warnings), fg=AMBER if plan.warnings else MUTED)
        title = f"{actions.ACTIONS.get(plan.kind, plan.kind)} 확인"
        if messagebox.askokcancel(title, "\n\n".join(plan.summary) + "\n\n실행할까요?", icon="warning"):
            threading.Thread(target=self._start_worker, args=(plan,), daemon=True).start()
        else:
            self.busy = False
            self._set_start_buttons("normal")

    def _start_worker(self, plan, area: str = "") -> None:
        """area(생성 접수·백업)가 있으면 업데이트 작업 보기를 바꾸지 않고 그 화면이 따로 따라간다."""
        def refuse(text: str) -> None:
            refusal = actions.Refusal((text,))
            self.queue.put(("side_refused", area, refusal) if area else ("plan", refusal))
        session = self.session if plan.kind in actions.AUTH_KINDS else None
        if plan.kind in actions.AUTH_KINDS and session is None:
            refuse("관리자 로그인이 필요합니다")
            return
        try:
            job_id = jobs.new_job(self.inst, plan, self.runner, login_email=session.email if session else "")
        except Exception as exc:  # noqa: BLE001 — 작업 폴더도 못 만들었으면 남은 것이 없다
            refuse(f"작업을 시작하지 못했습니다: {exc}")
            return
        try:
            jobs.launch_runner(self.inst, job_id, token=session.token if session else None)
        except Exception as exc:  # noqa: BLE001 — 만든 작업은 기록을 남겨 '결과 확인 필요'로 보인다
            try:
                jobs.mark_launch_failed(self.inst, job_id, f"실행기를 띄우지 못했습니다: {exc}")
            except Exception:  # noqa: BLE001 — 기록도 못 남기면 read_job 이 시작 대기 뒤 check_needed 로 본다
                _log_ui_error(traceback.format_exc())
        self.queue.put(("side_started", area, job_id) if area else ("job_started", job_id))

    # ---------- 작업 스레드(위젯·after 금지, 큐에만) ----------
    def _put(self, item) -> bool:
        try:
            self.queue.put(item, timeout=2)
            return True
        except queue.Full:
            return False

    def _worker(self) -> None:
        last_status = last_tasks = last_addr = last_backup = last_release = last_activity = 0.0
        last_move = last_presence = 0.0
        last_hidden = -1
        server_ok = False
        offsets: dict[str, int] = {}  # 작업마다 읽은 위치 — 이 스레드만 만진다
        while not self.stop.is_set():
            now = time.time()
            try:
                if now - last_tasks > 20:
                    self.tasks = install.task_states(self.runner)
                    self.task_match = install.server_task_matches(self.inst, self.tasks)
                    last_tasks = now
                if now - last_addr > 60:
                    self._put(("addresses", install.addresses(self.runner)))
                    last_addr = now
                if now - last_status > 4:
                    current = status.collect_status(self.inst, self.tasks, self.task_match)
                    server_ok = current.server == "ok"
                    self._put(("status", current))
                    last_status = now
                lines = self.hub.poll()
                if lines:
                    self._put(("logs", lines))
                self._put(("sources", self.hub.states()))
                if self.hub.hidden != last_hidden and self._put(("noise", self.hub.hidden)):
                    last_hidden = self.hub.hidden
                last_activity = self._activity_step(now, last_activity, server_ok)
                view = self.job_view
                if view[0]:
                    state = jobs.read_job(self.inst, view[0])  # 상태를 먼저 — 끝났으면 출력도 이미 다 쓰였다
                    new_lines, offset = jobs.read_output(self.inst, view[0], offsets.get(view, 0), JOB_READ_BYTES,
                                                         final=state.get("status") in JOB_TERMINAL)
                    if self._put(("job", view, new_lines, state)):
                        offsets[view] = offset  # 못 넣었으면 다음에 같은 곳부터 다시 읽는다
                for area, side in list(self.side_jobs.items()):
                    tail = jobs.read_output(self.inst, side, 0, JOB_READ_BYTES, final=True)[0][-1:]
                    self._put(("side_job", area, side, jobs.read_job(self.inst, side), tail[0] if tail else ""))
                if self.backup_due or (self.page == "backup" and now - last_backup > 30):
                    self.backup_due, last_backup = False, now
                    self._put(("backup_view", backup.read_view(self.inst, self.runner)))
                if self.move_due or (self.page == "move" and now - last_move > 10):
                    self.move_due, last_move = False, now
                    self._put(("move_view", {**moves.view(self.inst), "sets": backup.recent_sets(self.inst)}))
                last_presence = self._presence_step(now, last_presence)
                if self.release_due or (self.page in ("release", "address") and now - last_release > 60):
                    self.release_due, last_release = False, now
                    if self.page == "address":
                        source = release.release_source(self.inst)
                        self._put(("address_view", {"source": source, "state": release.read_state(self.inst),
                                                    "location": release.read_location(
                                                        self.inst, release.scratch_dir(self.inst), source)}))
                    else:
                        self._put(("release_view", release.read_view(self.inst, self.runner, self.session)))
            except Exception:  # noqa: BLE001
                _log_ui_error(traceback.format_exc())
            self.stop.wait(1.0)

    # ---------- 메인 스레드: 큐 비우기 ----------
    def _drain(self) -> None:
        try:
            budget = DRAIN_LINES
            for _ in range(50):
                if budget <= 0:
                    break
                if self.backlog:
                    item = self.backlog.popleft()
                else:
                    try:
                        item = self.queue.get_nowait()
                    except queue.Empty:
                        break
                item = self._split(item, budget)
                try:
                    budget -= self._handle(item)
                except Exception:  # noqa: BLE001 — 메시지 하나가 이후 갱신을 멈추면 안 된다
                    _log_ui_error(traceback.format_exc())
        finally:
            self.root.after(250, self._drain)

    def _split(self, item, budget: int):
        """줄이 많은 메시지는 남은 예산만큼만 이번에 그리고, 나머지는 다음 차례 맨 앞으로 미룬다."""
        kind = item[0]
        if kind == "logs" and len(item[1]) > budget:
            self.backlog.appendleft(("logs", item[1][budget:]))
            return ("logs", item[1][:budget])
        if kind == "job" and len(item[2]) > budget:
            # 상태(끝 처리)는 줄을 다 그린 마지막 조각에만 싣는다.
            self.backlog.appendleft(("job", item[1], item[2][budget:], item[3]))
            return ("job", item[1], item[2][:budget], {"status": "running"})
        return item

    def _handle(self, item) -> int:
        """메시지 하나를 화면에 반영하고 넣은 줄 수(최소 1)를 돌려준다."""
        kind = item[0]
        if kind == "status":
            self._show_status(item[1])
            if self.page == "power":
                self._show_power()
        elif kind == "logs":
            self._add_lines(item[1])
            return max(1, len(item[1]))
        elif kind == "job_select":
            if item[1] != self.job_id:
                self._select_job(item[1])
        elif kind == "sources":
            self.sources_label.configure(text=" · ".join(f"{logs.short_name(k)} {self._source_word(v)}"
                                                         for k, v in item[1].items()))
        elif kind == "noise":
            self.noise_label.configure(text=f"연결 열림·닫힘 {item[1]}줄 숨김(원문은 서버 창 로그)" if item[1] else "")
        elif kind == "activity":
            self.activity, self.activity_paused = item[1], ""
            names_now = {row.get("who") for source in ("generations", "changes", "people")
                         for row in item[1].get(source) or []} - {"", "—", None}
            if names_now - self.workers_seen:
                self.workers_seen |= names_now
                self.worker_filter.configure(values=["모두", *sorted(self.workers_seen)])
            self._render_tables()
        elif kind == "activity_paused":
            self.activity_paused = item[1]
            self._render_tables()
        elif kind == "addresses":
            self.addresses = item[1]
            self._show_address()
            self._show_address_page()
        elif kind == "plan":
            self._on_plan(item[1])
        elif kind == "login":
            self._on_login(item[1])
        elif kind == "intake_plan":
            self._on_intake_plan(item[1], item[2], item[3])
        elif kind == "side_refused":
            if item[1] == "intake":
                self._on_intake_plan(item[2], None, 0.0)
            elif item[1] == "backup":
                self._on_backup_plan(item[2])
            else:
                self._on_area_plan(item[1], item[2])
        elif kind == "side_started":
            self.side_jobs[item[1]] = item[2]
            self._area_note(item[1]).configure(text=f"작업 {item[2][:8]} 시작 — 실행 직전에 조건을 다시 확인합니다",
                                               fg=MUTED)
        elif kind == "side_job":
            if self.side_jobs.get(item[1]) == item[2]:  # 끝 처리 뒤 늦게 온 같은 작업 알림은 버린다
                if item[1] == "intake":
                    self._on_intake_job(item[3])
                elif item[1] == "backup":
                    self._on_backup_job(item[3], item[4])
                else:
                    self._on_area_job(item[1], item[3], item[4])
        elif kind == "backup_view":
            self.backup_view = item[1]
            self._show_backup()
        elif kind == "backup_plan":
            self._on_backup_plan(item[1])
        elif kind == "release_view":
            self.release_view = item[1]
            if item[1].get("auth_expired"):
                self.logout()
            self._show_release()
        elif kind == "address_view":
            self.address_view = item[1]
            self._show_address_page()
        elif kind == "move_view":
            self.move_view = item[1]
            self._show_move()
        elif kind == "presence":
            self.presence_inflight = False
            if self.session is not None and self.session is item[1]:  # 로그아웃·계정이 바뀐 뒤 온 응답은 버린다
                self.presence = item[2]
                if item[2].get("auth_expired"):
                    self.logout()
                self._render_tables()
        elif kind == "area_plan":
            self._on_area_plan(item[1], item[2])
        elif kind == "area_note":
            self._area_note(item[1]).configure(text=item[2], fg=MUTED)
        elif kind == "intake_value":
            self.intake_api = (item[1], item[2])
            self._show_intake()
        elif kind == "job_started":
            self._select_job(item[1])
            note = self.plan_note.cget("text")  # 권한 알림이 있었으면 이어서 남긴다
            self.plan_note.configure(text=f"작업 {item[1][:8]} 시작 — 진행은 아래에 나옵니다" + (f"\n{note}" if note.startswith("참고:") else ""))
        elif kind == "job":
            self._show_job(item[1], item[2], item[3])
            return max(1, len(item[2]))
        return 1

    @staticmethod
    def _source_word(state: str) -> str:
        return {"ok": "정상", "missing": "없음", "error": "읽기 실패"}.get(state, state)

    def _show_status(self, st: status.Status) -> None:
        self.status = st
        label = status.SERVER_LABELS.get(st.server, st.server)
        color = SERVER_COLORS.get(st.server, MUTED)
        observed = time.strftime("%H:%M:%S", time.localtime(st.observed_at))
        self.nav_state.configure(text=f"● {label}", fg=color)
        self._card("server", label, f"{observed} 확인 · /api/ready {st.ready.code or st.ready.error or '-'}", color)
        commit = st.code.get("commit", "")
        code_text = {"stage": f"stage {commit[:8] or st.code.get('build_id', '')[:8]}",
                     "legacy": "소스 트리(legacy)"}.get(st.code.get("source"), "확인 불가")
        self.code_label.configure(text=f"돌고 있는 코드 {code_text}")
        self._show_address()
        snap = _dict(_dict(st.snapshot).get("snapshot"))
        fresh = st.snapshot_state == "ok"
        age = _ago(st.snapshot_age)
        if not fresh:
            why = {"missing": "로그 없음", "unreadable": "로그 읽기 실패", "none": "아직 기록 없음",
                   "stale": f"마지막 기록 {age}"}.get(st.snapshot_state, st.snapshot_state)
            for key in ("accounts", "requests", "db", "backup"):
                self._card(key, "확인 불가", why, MUTED)
        else:
            counts = [n for n in (_int(_dict(snap.get("agents")).get("connected_accounts")),
                                  _int(_dict(snap.get("websocket")).get("authenticated_accounts"))) if n is not None]
            self._card("accounts", str(max(counts)) if counts else "확인 불가", f"{age} 기록", TEXT if counts else MUTED)
            requests = _dict(snap.get("requests"))
            fivexx = _int(_dict(requests.get("status")).get("5xx", 0))
            fivexx_text = "?" if fivexx is None else str(fivexx)
            total = _int(requests.get("total"))
            if st.rate:
                delta, seconds = st.rate
                self._card("requests", f"{delta:,}", f"최근 {int(seconds)}초 · 누적 5xx {fivexx_text}", TEXT)
            elif total is not None:
                self._card("requests", f"{total:,}", f"이 실행 누적 · 5xx {fivexx_text}", TEXT)
            else:
                self._card("requests", "확인 불가", "기록 형식이 다름", MUTED)
            operations = _dict(snap.get("operations"))
            ready = _dict(operations.get("databases")).get("ready", True)
            if isinstance(ready, bool):
                self._card("db", "정상" if ready else "오류", f"{age} 기록", LIME if ready else RED)
            else:
                self._card("db", "확인 불가", "기록 형식이 다름", MUTED)
            backups = _dict(operations.get("backups"))
            sets = _int(backups.get("set_count", 0))
            latest = backups.get("latest_age_seconds")
            latest = latest if isinstance(latest, (int, float)) and not isinstance(latest, bool) else None
            self._card("backup", "확인 불가" if sets is None else f"{sets}세트",
                       f"마지막 백업 {_ago(latest) if latest is not None else '모름'}", MUTED if sets is None else TEXT)
        if st.intake is None:
            self._card("intake", "확인 불가", st.intake_error or "DB 를 읽지 못함", MUTED)
        else:
            paused = st.intake.get("paused")
            active = _int(st.intake.get("active_generation_total", 0))
            self._card("intake", "중지" if paused else "가능",
                       f"진행 중 생성 {'?' if active is None else active}건", AMBER if paused else LIME)
        self._show_intake()
        self._show_backup()
        if st.traces and not self.job_id:
            self.plan_note.configure(text="업데이트 흔적: " + " / ".join(t for _, t in st.traces), fg=AMBER)

    def _show_address(self) -> None:
        """NIC 별 주소(작업 스레드가 조회)와 포트·프로토콜. 서버가 그 포트로 답했을 때만 '확인'으로 본다."""
        scheme = "https" if self.inst.tls else "http"
        ready = self.status.ready if self.status is not None else None
        if ready is not None and status.is_mvhub(ready):
            note = ""
        elif ready is not None and ready.code is not None:
            note = " (이 포트가 답했지만 MV Hub 인지 미확인)"
        else:
            note = " (설정값·응답 없음)" if self.inst.port_known else " (기본값 추정·응답 없음)"
        urls = [(f"{scheme}://{ip}:{self.inst.port}", alias) for alias, ip in (self.addresses or [])]
        self.copy_text = urls[0][0] if urls else ""
        if self.addresses is None:
            shown = f"네트워크 주소 확인 불가 · 포트 {self.inst.port}"
        elif not urls:
            shown = f"네트워크 주소 없음 · 포트 {self.inst.port}"
        else:
            shown = " / ".join(f"{url} ({alias})" for url, alias in urls)
        self.addr_label.configure(text=f"주소 {shown}{note}")

    def _card(self, key: str, value: str, sub: str, color: str) -> None:
        big, small = self.cards[key]
        big.configure(text=value, fg=color)
        small.configure(text=sub)

    def _visible(self, line: logs.LogLine) -> bool:
        worker = self.worker_filter.get()
        return worker in ("", "모두") or line.worker == worker

    def _add_lines(self, lines: list[logs.LogLine]) -> None:
        new_workers = False
        for line in lines:
            if line.worker and line.worker not in self.workers_seen:
                self.workers_seen.add(line.worker)
                new_workers = True
            for tab in line.tabs:
                self.buffers[tab].append(line)
        if new_workers:
            self.worker_filter.configure(values=["모두", *sorted(self.workers_seen)])
        for key, text in self.texts.items():
            mine = [line for line in lines if key in line.tabs and self._visible(line)]
            if mine:
                self._append(text, mine)

    def _append(self, text: tk.Text, lines: list[logs.LogLine]) -> None:
        at_bottom = text.yview()[1] >= 0.999
        text.configure(state="normal")
        for line in lines:
            text.insert("end", line.text + "\n", line.level)
        overflow = _line_count(text) - MAX_LINES_PER_TAB
        if overflow > 0:
            text.delete("1.0", f"{overflow + 1}.0")
        text.configure(state="disabled")
        if at_bottom:  # 사람이 위로 올려 읽는 중이면 따라 내리지 않는다
            text.see("end")

    def _rerender_all(self) -> None:
        for key, text in self.texts.items():
            text.configure(state="normal")
            text.delete("1.0", "end")
            text.configure(state="disabled")
            self._append(text, [line for line in self.buffers[key] if self._visible(line)])

    def _select_job(self, job_id: str) -> None:
        """업데이트 화면이 따라갈 작업을 바꾼다(새 작업·막고 있는 미확인 작업). 출력은 처음부터 다시 읽힌다."""
        self.job_id, self.job_step, self.job_closed = job_id, 0, ""
        self.backlog = collections.deque(m for m in self.backlog if m[0] != "job")
        self.ack_button.pack_forget()
        self._set_job_text([])
        self.result_label.configure(text="")

    def _set_job_text(self, lines: list[str]) -> None:
        self.job_text.configure(state="normal")
        self.job_text.delete("1.0", "end")
        for line in lines:
            self.job_text.insert("end", logs.clean(line) + "\n")
        self.job_text.configure(state="disabled")

    def _show_job(self, view: tuple[str, int], new_lines: list[str], state: dict) -> None:
        if view != self.job_view:
            return  # 바꾸기 전 작업(또는 같은 작업의 이전 보기)의 알림
        job_id = view[0]
        if new_lines:
            self.job_step = max(self.job_step, jobs.step_of(new_lines))
            at_bottom = self.job_text.yview()[1] >= 0.999
            self.job_text.configure(state="normal")
            for line in new_lines:
                self.job_text.insert("end", logs.clean(line) + "\n")
            overflow = _line_count(self.job_text) - MAX_LINES_PER_TAB
            if overflow > 0:
                self.job_text.delete("1.0", f"{overflow + 1}.0")
            self.job_text.configure(state="disabled")
            if at_bottom:
                self.job_text.see("end")
        for index, (bar, label) in enumerate(zip(self.step_bars, self.step_labels), 1):
            bar.configure(bg=LIME if index <= self.job_step else "#26282d")
            label.configure(fg=LIME if index == self.job_step else MUTED2)
        status_text = state.get("status")
        text, color = job_result_text(state)
        self.result_label.configure(text=text, fg=color)
        if status_text not in JOB_TERMINAL:
            return
        if self.job_closed == job_id:
            # 끝 처리는 한 번만 — 다만 그 뒤 다른 곳에서 확인 처리됐으면(이어서 하기가 멈춘 배포를 푼 경우) 잠금을 푼다.
            if state.get("acknowledged") and self.ack_button.winfo_manager():
                self.ack_button.pack_forget()
                if not self.busy:  # 다른 요청을 확인하는 중이면 그대로 둔다
                    self._set_start_buttons("normal")
            return
        self.job_closed = job_id  # 끝 처리는 작업마다 한 번만
        if jobs.needs_check(state) and not state.get("acknowledged"):
            self.busy = False  # 머리글 단추로 다시 눌러도 사전 검사가 이 작업 때문에 거절한다
            self._set_start_buttons("disabled")
            self.ack_button.pack(side="left", padx=10)
        else:
            self._job_done()
            if (state.get("kind") in ("tools-update", "console-rollback") and state.get("exit_code") == 0
                    and state.get("console_sha") != running_console_sha()):
                self.reopen_button.pack(side="left", padx=10)  # 새 관리 창은 다시 열어야 적용된다

    def _job_done(self) -> None:
        self.busy = False
        self._set_start_buttons("normal")

    def reopen(self) -> None:
        """창을 닫고 부트스트랩으로 다시 연다(포인터의 새 관리 창). 단일 실행 잠금은 run() 이 놓은 뒤 띄운다."""
        self.reopen_requested = True
        self.stop.set()
        self.root.destroy()


def running_console_sha() -> str:
    """지금 이 관리 창이 도는 stage 커밋(루트 판이면 '')."""
    return install.CODE_ROOT.name if install.CODE_ROOT != install.ROOT else ""


def job_result_text(state: dict) -> tuple[str, str]:
    """작업 상태 → (화면 문구, 색). '결과 미확인'(종료 코드 3)은 사람이 확인할 때까지 새 작업을 막는다고 덧붙인다."""
    text, color = _result_base(state)
    if state.get("status") == "finished" and state.get("exit_code") == jobs.UNCONFIRMED:
        return text + (" — 확인했음으로 표시됨" if state.get("acknowledged")
                       else " — 확인한 뒤 [확인했음]을 누르세요(그 전에는 새 작업을 막습니다)"), color
    return text, color


def _result_base(state: dict) -> tuple[str, str]:
    """판정은 종료 코드, 커밋은 이 실행과 이어졌을 때만 적는다."""
    status_text = state.get("status")
    kind = state.get("kind")
    if status_text == "finished" and kind in ("backup-save", "backup-run"):
        return backup_result_text(state)
    if status_text == "finished" and kind in ("release-deploy", "release-resume", "release-announce",
                                              "release-remove", "release-delete", "address-notice", "backup-drill",
                                              *actions.POWER_KINDS, *actions.MOVE_KINDS):
        return area_result_text(state)
    if status_text == "finished" and kind == "intake-set":
        if state.get("exit_code") != 0:
            return f"실패: 생성 접수를 바꾸지 못했습니다 — {state.get('error') or '이유 모름'}", RED
        paused = _dict(state.get("intake")).get("paused")
        return f"완료: 생성 접수 = {'중지' if paused else '가능'}(서버에서 다시 읽어 확인)", LIME
    if status_text == "finished" and kind in ("tools-update", "console-rollback"):
        if state.get("exit_code") != 0:
            return f"실패: {actions.ACTIONS[kind]}이(가) 끝나지 않았습니다 — 관리 창은 그대로입니다. 위 내용을 확인하세요.", RED
        sha = str(state.get("console_sha") or "")
        if sha and sha == running_console_sha():
            return f"완료: 지금 관리 창이 {sha[:12]} 입니다.", LIME
        return f"완료: 관리 창을 {sha[:12]} 로 바꿨습니다 — [관리 창 다시 열기]를 누르면 적용됩니다.", LIME
    if status_text == "finished":
        code = state.get("exit_code")
        if code != 0:
            return f"실패: 업데이트가 끝나지 않았습니다(종료 코드 {code}). 위 내용을 확인하세요.", RED
        after = _dict(state.get("code_after"))
        commit = after.get("commit") if isinstance(after.get("commit"), str) else ""
        if after.get("linked") and after.get("prepare") == "up_to_date":
            return f"완료: 이미 최신이었습니다(커밋 {commit[:8] or '미확인'}).", LIME
        if after.get("linked") and after.get("installed") is True and commit:
            return f"완료: 서버가 커밋 {commit[:8]} 로 동작 중입니다.", LIME
        return "완료(종료 코드 0): 설치된 커밋은 이 작업과 잇지 못해 미확인 — 위 '돌고 있는 코드'를 보세요.", LIME
    if status_text == "refused":
        return "시작하지 않음: " + " / ".join(str(r) for r in state.get("reasons") or []), AMBER
    if status_text in ("check_needed", "runner_error"):
        left = (f" 백업 확인의 임시 DB 사본이 남아 있을 수 있습니다: {state['leftover_tmp']} — 확인 후 지우세요."
                if state.get("leftover_tmp") else "")
        if state.get("acknowledged"):
            return "결과를 잃은 작업 — 확인했음으로 표시됨. 새 업데이트를 시작할 수 있습니다." + left, MUTED
        return ("결과 확인 필요: 실행기가 결과를 남기지 못했습니다. 서버 상태와 로그를 확인한 뒤 "
                "[확인했음]을 누르세요(그 전에는 새 업데이트를 막습니다)." + left), AMBER
    return "진행 중 (이 창을 닫아도 업데이트는 계속됩니다)", MUTED


def _built_at(version: str) -> str:
    """릴리스 버전(YYYY.MM.DD-HHMM = 만든 시각) → 'MM-DD HH:MM'."""
    try:
        return time.strftime("%m-%d %H:%M", time.strptime(version, "%Y.%m.%d-%H%M"))
    except ValueError:
        return ""


def area_result_text(state: dict) -> tuple[str, str]:
    """릴리스·주소 작업 상태 → (화면 문구, 색). '알림'과 'NAS 표지' 결과를 따로 말한다."""
    status_text, kind = state.get("status"), state.get("kind")
    if status_text == "refused":
        return "하지 않았습니다: " + " / ".join(str(r) for r in state.get("reasons") or []), AMBER
    if status_text != "finished":
        extra = " 릴리스 화면의 [이어서 하기]로 서버·NAS 를 다시 읽어 이어 갈 수 있습니다." if kind == "release-deploy" else ""
        if state.get("leftover_tmp"):
            extra += f" 임시 DB 사본이 남아 있을 수 있습니다: {state['leftover_tmp']} — 확인 후 지우세요."
        return f"결과 확인 필요: 실행기가 결과를 남기지 못했습니다.{extra}", AMBER
    error = state.get("error") or "이유 모름"
    if kind == "release-delete" and state.get("exit_code") == jobs.UNCONFIRMED:
        return f"결과 미확인: {error} — 릴리스 폴더와 로그를 확인한 뒤 업데이트 화면에서 [확인했음]을 누르세요.", AMBER
    if kind in actions.POWER_KINDS or kind == "backup-drill" or kind in actions.MOVE_KINDS:
        return _control_result_text(state, kind, error)
    if state.get("exit_code") == 0:
        if kind == "release-announce":
            return f"완료: 팀원 알림을 다시 보냈습니다({state.get('revision')}번째) — 배포는 그대로입니다.", LIME
        if kind == "release-remove":
            return "완료: 팀원 알림 목록에서 거뒀습니다(배포는 그대로).", LIME
        if kind == "release-delete":
            return "완료: 릴리스 파일을 삭제했습니다.", LIME
        if kind == "address-notice":
            note = _dict(state.get("announcement"))
            return f"완료: 팀에 주소를 공지했습니다(판 {note.get('revision')}) — 팀원 앱에 알림이 뜹니다.", LIME
        version = state.get("version")
        if state.get("deploy") == "already":
            return f"완료: v{version} 은(는) 이미 팀에 배포된 릴리스입니다(알림만).", LIME
        if state.get("rolled_back"):
            return f"완료: v{version} 으로 되돌렸습니다 — 팀원 PC 에 '업데이트 있음'이 뜹니다.", LIME
        return f"완료: v{version} 을(를) 팀에 배포했습니다 — 팀원 PC 에 '업데이트 있음'이 뜹니다.", LIME
    if kind in ("release-deploy", "release-resume") and state.get("announced") is not False:
        if state.get("announced") is None and kind == "release-deploy":
            return f"알림 결과를 확인할 수 없어 배포하지 않았습니다 — [이어서 하기]로 확인하세요. 이유: {error}", AMBER
        if state.get("deploy") == "unconfirmed":
            return f"알림은 나갔지만 팀 배포 결과를 확인할 수 없습니다 — [이어서 하기]로 다시 읽어 이어 가세요. 이유: {error}", AMBER
        if state.get("announced"):
            return f"알림은 나갔지만 팀 배포는 하지 못했습니다 — {error}", RED
    return f"실패: {error}", RED


def _stamp_text(stamp: str) -> str:
    """백업 이름의 UTC 시각(YYYYMMDD_HHMMSS[_ffffff]) → 이 PC 시각."""
    try:
        when = time.mktime(time.strptime(stamp[:15], "%Y%m%d_%H%M%S")) - time.timezone
    except ValueError:
        return stamp
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(when))


def _control_result_text(state: dict, kind: str, error: str) -> tuple[str, str]:
    """켜기·끄기·재등록·드릴·이사 결과 → (문구, 색). 끝난 작업만(진행 중·거절은 area_result_text 가 먼저 거른다)."""
    code = state.get("exit_code")
    note = f" · {state['backup_note']}" if state.get("backup_note") else ""
    if kind in actions.MOVE_KINDS:
        if state.get("not_started"):
            return "시작하지 않았습니다: " + " / ".join(str(r) for r in state.get("reasons") or []), AMBER
        if code == 0 and kind == "move-restore":
            archive = ", ".join(state.get("archive") or []) or "확인 못 함"
            return (f"완료: DB 를 되살렸습니다(지금 DB 보관: db\\{archive}) — [켜기]로 서버를 켜고 생성 접수 상태를 확인하세요", LIME)
        if code == 0:
            return "완료 — 자세한 결과는 그 콘솔 창의 마지막 안내를 따르세요(이사 화면의 이사 기록도 갱신됩니다)", LIME
        if state.get("move") == "unconfirmed":
            return f"결과 미확인: {error} — 이사 기록·서버 상태를 확인한 뒤 업데이트 화면에서 [확인했음]", AMBER
        return (f"멈춤(종료 코드 {code}) — 콘솔 창의 [중단] 이유를 보세요. {state.get('error') or ''}".rstrip(), RED)
    if kind == "backup-drill":
        cleanup = {"done": "임시 사본 지움", "left": f"임시 사본이 남음: {state.get('tmp')}",
                   "skipped": f"자손 회수 미확인 — 임시 사본을 지우지 않음: {state.get('tmp')}"}.get(state.get("cleanup"), "")
        head = str(state.get("root_commit") or "")[:8] or "모름"
        if code in (0, 3) and state.get("drill") == "passed":
            return (f"완료: 루트 코드({head}) 기준 복원 검증 통과 — {cleanup}", LIME if code == 0 else AMBER)
        return f"실패: {error} — {cleanup}", RED
    if code == 0:
        if kind == "server-stop":
            return f"완료: 서버를 껐습니다 — 다시 켤 때는 [켜기]{note}", LIME
        build = str(state.get("build_id") or "")[:12]
        already = " (이미 켜져 있었음 — 꺼진 작업만 켬)" if state.get("already") else ""
        what = "자동시작을 다시 등록했고 " if kind == "server-autostart" else ""
        return f"완료: {what}서버가 정상입니다(build {build}){already}{note}", LIME
    if kind == "server-autostart":
        changed = ("확인하지 못함" if state.get("changed") is None
                   else ", ".join(state.get("changed") or []) or "없음")
        stage = f"({state['stage']} 단계)" if state.get("stage") else ""
        return f"실패{stage}: {error} — 바뀐 것: {changed}. 수동 복구가 필요하면 SERVER_RECOVERY.md", RED
    return f"실패: {error} — 위의 상태·끈 기록을 확인하세요{note}", RED


BACKUP_CODES = {  # 복사기(tools/backup_replicate.py) 결과 코드 → 사람 말. 관리 창 확인(probe)은 이 계정, 복사는 SYSTEM 이다
    "target_unavailable": "예약 작업(SYSTEM)이 NAS 폴더를 열지 못했습니다 — NAS 가 켜져 있는지, "
                          "NAS 에서 이 서버 PC 의 접근·쓰기를 허용했는지 확인하세요",
}


def backup_result_text(state: dict) -> tuple[str, str]:
    """백업 작업 상태 → (화면 문구, 색). '설정 저장'과 '복사 결과'를 따로 말한다."""
    status_text = state.get("status")
    if status_text == "refused":
        return "하지 않았습니다: " + " / ".join(str(r) for r in state.get("reasons") or []), AMBER
    if status_text != "finished":
        return ("결과 확인 필요: 실행기가 결과를 남기지 못했습니다 — 백업 상태를 다시 보고, "
                "업데이트 화면에서 [확인했음]을 누르세요"), AMBER
    saved = " (새 위치 저장됨)" if state.get("saved") else ""
    if state.get("exit_code") == 0:
        counts = _dict(state.get("counts"))
        return f"완료: 복사 성공 — 새로 {counts.get('copied', '?')} · 그대로 {counts.get('skipped', '?')}{saved}", LIME
    copy = state.get("copy")
    why = state.get("error") or state.get("error_code") or "이유 모름"
    code = state.get("error_code") or why
    part = {"failed": f"복사는 실패했습니다({BACKUP_CODES.get(code, code)})",
            "unconfirmed": f"복사 결과는 미확인입니다 — {why}",
            "not_started": f"복사는 시작하지 못했습니다 — {why}"}.get(copy)
    if state.get("saved") and part:
        return f"설정은 저장됐고 {part}", RED
    return f"실패: {part or why}", RED


def last_intake_text(inst: install.Installation) -> str:
    """관리 창 기록(console-actions.jsonl)에서 마지막으로 성공한 생성 접수 변경."""
    try:
        lines = status.read_tail_lines(inst.logs / names.ACTION_LOG, 256_000)
    except OSError:
        lines = []
    for raw in reversed(lines):
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("kind") == "intake-set" and row.get("result") == "success":
            when = row.get("ts")
            stamp = time.strftime("%m-%d %H:%M", time.localtime(when)) if isinstance(when, (int, float)) else "시각 모름"
            paused = _dict(row.get("params")).get("paused")
            return f"최근 변경: {stamp} {'중지로' if paused else '가능으로'} 바꿈 · {row.get('login_email') or '계정 모름'}"
    return "최근 변경: 관리 창 기록 없음(웹·붙여넣기로 바꾼 것은 여기 안 나옵니다)"


def _mark_ui(inst: install.Installation) -> Path:
    """이 화면이 쓰는 관리 창 코드를 남긴다 — 관리 도구 갱신이 쓰는 중인 stage 를 지우지 않게(console_stage.in_use)."""
    path = inst.logs / names.UI_MARK
    jobs.write_json(path, {"pid": os.getpid(), "created": jobs.process_created(os.getpid()),
                           "code_root": str(install.CODE_ROOT)})
    return path


def _relaunch() -> None:
    """부트스트랩(서버 루트의 main.py)을 다시 띄운다 — 포인터의 관리 창으로 열린다. 이미 관리자 권한이다."""
    python = main_boot.registered_python(install.ROOT)
    if python is None:
        return
    pythonw = python.with_name("pythonw.exe")
    subprocess.Popen([str(pythonw if pythonw.is_file() else python), "-I", "-B",
                      str(install.ROOT / "tools" / "server_console" / "main.py")], close_fds=True)


def run(note: str = "") -> int:
    if hasattr(ctypes, "windll"):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    lock = _single_instance()
    if lock is None:
        root = ConsoleTk()
        root.withdraw()
        messagebox.showinfo("MV Hub 서버 관리", "서버 관리 창이 이미 열려 있습니다.")
        root.destroy()
        return 0
    reopen, mark = False, None
    try:
        inst = install.resolve_installation()
        root = ConsoleTk()
        if "stage_copy" in inst.problems:
            root.withdraw()
            messagebox.showerror("MV Hub 서버 관리", "stage 사본 안에서는 열 수 없습니다. 서버 루트의 바로가기로 여세요.")
            root.destroy()
            return 1
        try:
            mark = _mark_ui(inst)
        except OSError:
            _log_ui_error(traceback.format_exc())
        app = App(root, inst, note=note)
        root.protocol("WM_DELETE_WINDOW", lambda: (app.stop.set(), root.destroy()))
        root.mainloop()
        reopen = app.reopen_requested
        return 0
    except Exception:  # noqa: BLE001
        _log_ui_error(traceback.format_exc())
        raise
    finally:
        if mark is not None:
            mark.unlink(missing_ok=True)
        lock.close()
        if reopen:  # 잠금을 놓은 뒤에 띄워야 새 창이 '이미 열려 있음'에 걸리지 않는다
            _relaunch()
