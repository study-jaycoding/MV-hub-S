"""Server console organization usage page; workers only write into the host queue."""
from __future__ import annotations

import threading
import tkinter as tk
from datetime import date, datetime, timedelta, timezone
from tkinter import messagebox, ttk

from . import server_api

BG, PANEL, TEXT, MUTED = "#08090a", "#121316", "#f3f4f6", "#8b909c"
KST = timezone(timedelta(hours=9))
FONT = ("Malgun Gothic", 10)


def period_dates(mode: str, start="", end="", *, today=None) -> dict:
    today = today or datetime.now(KST).date()
    if mode == "직접":
        first, last = date.fromisoformat(start), date.fromisoformat(end) + timedelta(days=1)
    else:
        first = today.replace(day=1)
        if mode == "지난달":
            last, first = first, (first - timedelta(days=1)).replace(day=1)
        else:
            last = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    if first >= last:
        raise ValueError("시작·끝 날짜를 확인하세요")
    return {"start": first.isoformat(), "end": last.isoformat()}


def money(cents) -> str:
    if type(cents) is not int:
        return "미확정"
    sign = "−" if cents < 0 else ""
    whole, fraction = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{fraction:02d}"


def when(value) -> str:
    return datetime.fromtimestamp(value // 1000, KST).strftime("%Y-%m-%d %H:%M KST") if value else "—"


def status_text(meta: dict) -> str:
    collecting = ("복원 정지" if meta.get("restore_paused") else
                  "멈춤: " + meta["pause_code"] if meta.get("pause_code") else
                  "켜짐" if meta.get("enabled") else "꺼짐")
    lag = f"{meta['delay_ms'] // 60000}분" if meta.get("delay_ms") is not None else "미수집"
    return (f"등록 {'됨' if meta.get('registered') else '안 됨'} · 상태 {meta.get('state', 'none')} · revision {meta.get('revision', 0)}\n"
            f"등록 {when(meta.get('registered_at_ms'))} · 등록자 {meta.get('registered_by') or '—'} · 조직 #{meta.get('org_hash') or '—'} · 만료 {meta.get('expires_on') or '미입력'}\n"
            f"수집 {collecting} · 실행 환경 {'허용' if meta.get('environment_ok') else '차단'} · 마지막 성공 {when(meta.get('last_success_at_ms'))} · 지연 {lag} · 최근 수집 코드 {meta.get('last_attempt_code') or '—'} · 키 확인 {meta.get('last_check_code') or '—'}")


class HfOrgUsagePage:
    def __init__(self, page, host):
        self.host, self.busy, self.generation = host, False, 0
        self.meta, self.spaces = {}, []
        host._header(page, "힉스필드 조직 사용량")
        body = tk.Frame(page, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        card = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        card.pack(fill="x", pady=(0, 10))
        self._label(card, "키·수집 상태").pack(anchor="w", padx=12, pady=(8, 0))
        self.status = self._label(card, "관리자로 로그인하면 보입니다")
        self.status.pack(anchor="w", padx=12, pady=8)
        row = tk.Frame(card, bg=PANEL)
        row.pack(fill="x", padx=12, pady=4)
        self._label(row, "새 키").pack(side="left")
        self.key = tk.Entry(row, show="•", width=36, bg="#181a1e", fg=TEXT, insertbackground=TEXT, font=FONT)
        self.key.pack(side="left", padx=8)
        self.buttons = []
        for label, action in (("등록 / 교체", "put"), ("키 확인", "check"), ("삭제", "delete"), ("새로 읽기", "status")):
            self._button(row, label, action)
        row = tk.Frame(card, bg=PANEL)
        row.pack(fill="x", padx=12, pady=(4, 10))
        self._label(row, "만료일 (YYYY-MM-DD, 선택)").pack(side="left")
        self.expiry = tk.Entry(row, width=12, font=FONT, bg="#181a1e", fg=TEXT,
                               insertbackground=TEXT, relief="flat", highlightthickness=0)
        self.expiry.pack(side="left", padx=8)
        self._button(row, "수집 켜기", "enable")
        self._button(row, "수집 끄기", "disable")
        compare = tk.Frame(body, bg=PANEL, highlightbackground="#26282d", highlightthickness=1)
        compare.pack(fill="both", expand=True)
        self._label(compare, "대조 — KST 날짜, 끝 날짜 포함").pack(anchor="w", padx=12, pady=8)
        row = tk.Frame(compare, bg=PANEL)
        row.pack(fill="x", padx=12)
        self.mode = tk.StringVar(value="이번 달")
        modes = ttk.Combobox(row, textvariable=self.mode, values=("이번 달", "지난달", "직접"), state="readonly", width=9)
        modes.pack(side="left")
        self.start_date, self.end_date = tk.StringVar(), tk.StringVar()
        for variable, label in ((self.start_date, "시작"), (self.end_date, "끝")):
            self._label(row, label).pack(side="left", padx=(8, 4))
            tk.Entry(row, textvariable=variable, width=12, font=FONT, bg="#181a1e", fg=TEXT,
                     insertbackground=TEXT, relief="flat", highlightthickness=0).pack(side="left")
        self._button(row, "불러오기", "comparison")
        self._button(row, "지금 다시 받기", "refresh")
        self.note = self._label(compare, "")
        self.note.pack(anchor="w", padx=12, pady=8)
        columns = ("공간", "API 순사용", "청구", "환불", "생성 수", "서버 생성 기록", "CLI 거래", "차이", "MV 기록 있음", "MV 기록 없음", "생성 아닌 차감", "완전성·마지막 확인")
        self.table = self._table(compare, columns, height=8)
        self.table.bind("<<TreeviewSelect>>", self.select_space)
        self._label(compare, "차이는 오류가 아닐 수 있습니다 — API 는 생성 시각, CLI 거래는 거래 시각 기준입니다.").pack(anchor="w", padx=12, pady=6)
        details = tk.Frame(compare, bg=PANEL)
        details.pack(fill="both", expand=True)
        people, errors = tk.Frame(details, bg=PANEL), tk.Frame(details, bg=PANEL)
        people.pack(side="left", fill="both", expand=True)
        errors.pack(side="left", fill="both", expand=True)
        self.actors = self._table(people, ("사람", "순사용", "청구", "환불", "생성 수"), height=4)
        self.errors = self._table(errors, ("실패 코드", "건수"), height=4)
        for variable in (self.mode, self.start_date, self.end_date):
            variable.trace_add("write", self.period_changed)

    def _label(self, parent, text):
        return tk.Label(parent, text=text, bg=PANEL, fg=TEXT, font=FONT, justify="left", anchor="w", wraplength=1100)

    def _button(self, parent, label, action):
        button = self.host._button(parent, label, lambda: self.start(action), primary=action == "put")
        button.pack(side="left", padx=5)
        self.buttons.append(button)

    def _table(self, parent, columns, height):
        frame = tk.Frame(parent, bg=PANEL)
        frame.pack(fill="both", expand=True, padx=12, pady=4)
        tree = ttk.Treeview(frame, columns=columns, show="headings", height=height, style="Console.Treeview")
        for column in columns:
            tree.heading(column, text=column)
            tree.column(column, width={"공간": 130, "사람": 140, "완전성·마지막 확인": 190}.get(column, 86), minwidth=75)
        scroll = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
        vertical = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(xscrollcommand=scroll.set, yscrollcommand=vertical.set)
        scroll.pack(side="bottom", fill="x")
        vertical.pack(side="right", fill="y")
        tree.pack(fill="both", expand=True)
        return tree

    def reset(self):
        self.generation += 1
        self.meta, self.spaces = {}, []
        self.key.delete(0, "end")
        self.status.configure(text="관리자로 로그인하면 보입니다")
        self.clear_tables()

    def clear_tables(self):
        for table in (self.table, self.actors, self.errors):
            table.delete(*table.get_children())

    def period_changed(self, *_):
        self.generation += 1
        self.spaces = []
        self.clear_tables()
        self.note.configure(text="기간이 바뀌었습니다. 불러오기를 누르세요")

    def start(self, action="status"):
        if self.busy or self.host.session is None:
            return
        body = {"expected_revision": self.meta.get("revision", 0)}
        if action in ("put", "check"):
            key = self.key.get().strip()
            self.key.delete(0, "end")  # UI thread; never copy into a status/queue item.
            if action == "put" and not key:
                self.note.configure(text="새 키를 입력하세요")
                return
            if key:
                body["api_key"] = key
            if action == "put":
                body["expires_on"] = self.expiry.get().strip() or None
        elif action in ("enable", "disable"):
            body["enabled"] = action == "enable"
        elif action in ("comparison", "refresh"):
            try:
                body = period_dates(self.mode.get(), self.start_date.get(), self.end_date.get())
            except (ValueError, OverflowError):
                self.note.configure(text="날짜를 YYYY-MM-DD 로 입력하세요. 끝 날짜는 포함됩니다")
                return
        elif action == "status":
            body = None
        if action == "delete" and not messagebox.askokcancel("힉스필드 키 삭제", "키를 삭제하고 수집을 끕니다. 사용 이력은 보존됩니다.", default="cancel"):
            return
        self.busy = True
        for button in self.buttons:
            button.configure(state="disabled")
        self.note.configure(text="처리 중…")
        threading.Thread(target=self.worker, args=(self.host.session, self.generation, action, body), daemon=True).start()

    def worker(self, session, generation, action, body):
        value, meta, error = None, None, ""
        try:
            server = server_api.verify_server(self.host.inst, self.host.runner)
            value = server_api.hf_org_usage(server, session.token, action, body)
            if action not in ("comparison", "status"):
                meta = server_api.hf_org_usage(server, session.token, "status")
        except server_api.AuthExpired:
            error = server_api.RELOGIN
        except server_api.ServerError as exc:
            error = str(exc)
        except Exception:
            error = "요청 결과를 확인하지 못했습니다. 새로 읽기를 누르세요"
        self.host._put(("hf_org_result", session, generation, action, value, meta, error))

    def result(self, session, generation, action, value, meta, error):
        self.busy = False
        for button in self.buttons:
            button.configure(state="normal")
        if session is not self.host.session or generation != self.generation:
            return
        if error:
            self.note.configure(text=error)
            self.host._relogin_if_needed([error])
            return
        if action == "status":
            meta = value
        if meta is not None:
            self.meta = meta
            self.status.configure(text=status_text(meta))
        self.note.configure(text="요청을 처리했습니다" if action != "refresh" else "수집을 예약했습니다. 완료 후 불러오기로 확인하세요")
        if action == "comparison":
            self.show_comparison(value)

    def show_comparison(self, value):
        self.clear_tables()
        self.spaces = value.get("spaces", [])
        lag = value.get("delay_ms")
        self.note.configure(text=f"출처: {value.get('api_source') or 'API 미확정'} · 대조: {value.get('check_state')} · 사유: {value.get('api_reason') or '—'} · 지연: {lag // 60000 if lag is not None else '—'}분")
        for index, row in enumerate(self.spaces):
            fact = money(row["fact_c"]) + (f" (추정 {row['fact_estimated_count']})" if row["fact_estimated_count"] else "")
            other = ", ".join(f"{kind}: {count}" for kind, count in row.get("other_types", {}).items())
            self.table.insert("", "end", iid=str(index), values=(row["workspace_name"], money(row["api_net_c"]),
                money(row["api_charged_c"]), money(row["api_refunded_c"]), row["generation_count"], fact,
                money(row["cli_c"]), money(row["difference_c"]), row["mv_record"], row["no_mv_record"], row["non_generation"],
                row["completeness"] + " · " + when(row["last_success_at_ms"]) + (" · 기타 유형 " + other if other else "")))

    def select_space(self, *_):
        selected = self.table.selection()
        if not selected:
            return
        row = self.spaces[int(selected[0])]
        self.actors.delete(*self.actors.get_children())
        self.errors.delete(*self.errors.get_children())
        for actor in row["actors"]:
            self.actors.insert("", "end", values=(actor["label"], money(actor["net_c"]), money(actor["charged_c"]), money(actor["refunded_c"]), actor["generation_count"]))
        for error in row["errors"]:
            self.errors.insert("", "end", values=(error["code"], error["count"]))
