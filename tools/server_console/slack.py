"""Server-local Slack page. Secrets are cleared before leaving the UI thread."""
from __future__ import annotations

import threading
import tkinter as tk
from tkinter import messagebox

from . import server_api


class SlackPage:
    def __init__(self, page, host):
        self.host = host
        self.busy = False
        self.meta = {}
        host._header(page, 'Slack 알림')
        body = tk.Frame(page, bg='#121316')
        body.pack(fill='both', expand=True, padx=16, pady=12)
        tk.Label(body, text='회사 Slack 봇 토큰은 이 서버 PC에서만 풀리는 형태로 저장합니다.', bg='#121316', fg='#ddd').pack(anchor='w')
        self.status = tk.Label(body, text='관리자로 로그인하면 보입니다', bg='#121316', fg='#ddd')
        self.status.pack(anchor='w', pady=12)
        tk.Label(body, text='봇 토큰', bg='#121316', fg='#ddd').pack(anchor='w')
        self.token = tk.Entry(body, show='•', width=60)
        self.token.pack(anchor='w')
        tk.Label(body, text='열기 주소', bg='#121316', fg='#ddd').pack(anchor='w', pady=(12, 0))
        self.url = tk.Entry(body, width=60)
        self.url.insert(0, 'http://127.0.0.1:8010')
        self.url.pack(anchor='w')
        buttons = tk.Frame(body, bg='#121316')
        buttons.pack(anchor='w', pady=12)
        self.buttons = []
        for label, action in [('등록 / 교체', 'put'), ('토큰 지우기', 'delete'), ('일시 멈춤', 'pause'), ('다시 켜기', 'resume'), ('새로 읽기', 'get')]:
            button = host._button(buttons, label, lambda a=action: self.start(a))
            button.pack(side='left', padx=(0, 8))
            self.buttons.append(button)
            if action == 'resume':
                self.resume_button = button

    def start(self, action='get'):
        if self.busy or self.host.session is None:
            return
        if action == 'resume' and self.meta.get('pause_reason') == 'auth_error':
            self.status.configure(text='토큰 오류 — 다시 등록해 주세요')
            return
        body = None
        if action == 'put':
            token = self.token.get().strip()
            if not token:
                self.status.configure(text='봇 토큰을 입력해 주세요')
                return
            if not messagebox.askokcancel('Slack 알림', 'Slack 토큰을 등록합니다. 연결 확인 요청을 보냅니다.', default='cancel'):
                return
            body = {'bot_token': token, 'open_base_url': self.url.get().strip(), 'enabled': True}
            self.token.delete(0, 'end')
        elif action != 'get' and not messagebox.askokcancel('Slack 알림', 'Slack 알림 설정을 변경합니다.', default='cancel'):
            return
        self.busy = True
        for button in self.buttons:
            button.configure(state='disabled')
        threading.Thread(target=self.worker, args=(self.host.session, action, body), daemon=True).start()

    def worker(self, session, action, body):
        meta, error = None, ''
        try:
            server = server_api.verify_server(self.host.inst, self.host.runner)
            method = {'get': 'GET', 'put': 'PUT', 'delete': 'DELETE'}.get(action, 'POST')
            path = '/api/admin/slack' + ('/' + action if action in ('pause', 'resume') else '')
            meta = server_api.expect_ok(*server_api.call(server, method, path, session.token, body), 'Slack 설정')
        except server_api.ServerError as exc:
            error = str(exc)
        except Exception:
            error = 'Slack 설정을 확인하지 못했습니다'
        self.host._put(('slack_result', session, meta, error))

    def result(self, session, meta, error):
        self.busy = False
        for button in self.buttons:
            button.configure(state='normal')
        if session is not self.host.session:
            return
        if error:
            self.status.configure(text=error)
            return
        self.meta = meta
        self.resume_button.configure(state='disabled' if meta.get('pause_reason') == 'auth_error' else 'normal')
        text = '등록된 토큰 없음'
        if meta.get('state') == 'undecryptable':
            text = '이 PC에서 토큰을 풀 수 없습니다. 다시 등록해 주세요'
        elif meta.get('state') == 'ok':
            text = '토큰 오류 — 다시 등록' if meta.get('pause_reason') == 'auth_error' else '일시 멈춤' if meta.get('paused') else '켜짐' if meta.get('enabled') else '꺼짐'
        self.status.configure(text=text)
