from datetime import date
import ast
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from server_console import hf_org_usage as page, server_api


class Widget:
    def __init__(self, text=""):
        self.text, self.values = text, {}
    def configure(self, **kwargs):
        self.values.update(kwargs)
    def get(self):
        return self.text
    def delete(self, *args):
        self.text = ""


def test_kst_inclusive_end_and_money_without_float():
    assert page.period_dates("직접", "2026-11-01", "2026-11-30") == dict(start="2026-11-01", end="2026-12-01")
    assert page.period_dates("지난달", today=date(2026,1,15)) == dict(start="2025-12-01", end="2026-01-01")
    assert page.money(2**63-1) == "92,233,720,368,547,758.07"
    assert page.money(None) == "미확정"


def bare_page():
    view = page.HfOrgUsagePage.__new__(page.HfOrgUsagePage)
    session = object()
    view.host = SimpleNamespace(session=session, _relogin_if_needed=lambda _: None)
    view.generation, view.busy, view.buttons = 2, True, [Widget()]
    view.period_generation = 3
    view.meta, view.status, view.note = {}, Widget(), Widget()
    view.clear_tables = lambda: None
    return view


def test_stale_session_result_is_ignored_without_releasing_new_operation():
    view = bare_page()
    view.result(view.host.session, 1, 3, "status", dict(state="ok"), None, "")
    assert view.meta == {} and view.busy
    view.result(object(), 2, 3, "status", dict(state="ok"), None, "")
    assert view.meta == {} and view.busy
    view.result(view.host.session, 2, 3, "status", dict(state="ok"), None, "")
    assert view.meta["state"] == "ok"


@pytest.mark.parametrize("action", ["status", "put", "check", "delete", "enable", "disable"])
def test_period_change_keeps_key_and_collector_results(action):
    view = bare_page()
    view.note.configure(text="처리 중…")
    view.period_changed()
    assert view.generation == 2 and view.period_generation == 4
    view.result(view.host.session, 2, 3, action, dict(state="ok"), dict(state="ok"), "")
    assert view.meta["state"] == "ok"
    assert not view.busy and view.buttons[0].values["state"] == "normal"
    assert view.note.values["text"] == "요청을 처리했습니다"


@pytest.mark.parametrize("action", ["comparison", "refresh"])
def test_stale_period_result_is_ignored_but_releases_busy(action):
    view = bare_page()
    view.show_comparison = lambda _: pytest.fail("stale comparison applied")
    view.period_changed()
    view.result(view.host.session, 2, 3, action, {}, dict(state="ok"), "")
    assert view.meta == {}
    assert not view.busy and view.buttons[0].values["state"] == "normal"
    assert view.note.values["text"] == "기간이 바뀌었습니다. 불러오기를 누르세요"


def test_reset_releases_busy_and_clears_processing_note():
    view = bare_page()
    view.key = Widget("fake-key")
    view.note.configure(text="처리 중…")
    view.reset()
    assert not view.busy and view.key.get() == ""
    assert view.buttons[0].values["state"] == "normal"
    assert view.note.values["text"] == ""


def test_failed_action_is_not_presented_as_success():
    view = bare_page()
    view.period_changed()
    view.result(view.host.session, 2, 3, "put", None, None, "요청 실패")
    assert view.note.values["text"] == "요청 실패" and not view.meta


def test_key_entry_cleared_before_worker_start(monkeypatch):
    view = bare_page()
    view.busy = False
    view.key, view.expiry = Widget("fake-key"), Widget("")
    calls = []
    class Thread:
        def __init__(self, *, target, args, daemon):
            calls.append(args)
        def start(self):
            assert view.key.get() == ""
    monkeypatch.setattr(page.threading, "Thread", Thread)
    view.start("put")
    assert calls[0][-1]["api_key"] == "fake-key"
    assert calls[0][1:3] == (2, 3)


def test_console_api_never_displays_reflected_error_body(monkeypatch):
    monkeypatch.setattr(server_api, "call", lambda *a, **kw: (400, {"detail": "fake-key"}))
    with pytest.raises(server_api.ServerError) as caught:
        server_api.hf_org_usage({}, "fake-session", "put", {"api_key": "fake-key"})
    assert "fake-key" not in str(caught.value)


@pytest.mark.parametrize("code", sorted(server_api.HF_ORG_ERROR_MESSAGES))
def test_console_api_preserves_known_code_with_korean_guidance(monkeypatch, code):
    monkeypatch.setattr(server_api, "call", lambda *a, **kw: (409, {"detail": code}))
    with pytest.raises(server_api.ServerError) as caught:
        server_api.hf_org_usage({}, "fake-session", "check")
    assert f"({code})" in str(caught.value)
    assert server_api.HF_ORG_ERROR_MESSAGES[code] in str(caught.value)


def test_console_error_allowlist_covers_backend_fixed_codes():
    root = Path(__file__).resolve().parents[1] / "app"
    codes = {"http_401", "http_403", "http_410", "http_429", "http_503", "http_5xx", "http_error"}
    for folder in ("routers", "usecases", "services", "repo"):
        for source in (root / folder).glob("hf_org_usage*.py"):
            tree = ast.parse(source.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    index = {"UsageError": 0, "HTTPException": 1}.get(node.func.id)
                    if index is not None and len(node.args) > index:
                        value = node.args[index]
                        if isinstance(value, ast.Constant) and isinstance(value.value, str) and " " not in value.value:
                            codes.add(value.value)
                if isinstance(node, ast.FunctionDef) and node.name == "_error_code":
                    for child in ast.walk(node):
                        if isinstance(child, ast.Set):
                            codes.update(item.value for item in child.elts if isinstance(item, ast.Constant))
    assert codes <= server_api.HF_ORG_ERROR_MESSAGES.keys()


def test_auth_pause_and_error_code_have_korean_guidance():
    text = page.status_text(dict(pause_code="auth", enabled=False, last_attempt_code="http_401"))
    assert "인증 오류로 멈춤 — 키 확인 뒤 수집 켜기" in text
    assert server_api.HF_ORG_ERROR_MESSAGES["http_401"] in text
    assert "fake-key" not in server_api.hf_org_code_text("fake-key")


def test_cli_sign_anomaly_count_shown_separately_from_valid_total():
    view = bare_page()
    inserted = []
    view.table = SimpleNamespace(insert=lambda *args, **kwargs: inserted.append(kwargs["values"]))
    row = dict(workspace_name="시험 공간", fact_c=100, fact_estimated_count=0,
               api_net_c=100, api_charged_c=100, api_refunded_c=0, generation_count=1,
               cli_c=75, cli_sign_anomaly_count=2, difference_c=25, mv_record=1,
               no_mv_record=0, non_generation=0, completeness="complete", last_success_at_ms=None)
    view.show_comparison(dict(spaces=[row]))
    assert inserted[0][6] == "0.75 · 부호 이상 2건"
    assert inserted[0][7] == "0.25"
    assert "CLI 부호 이상 2건(해당 행 제외)" in view.note.values["text"]


def test_ongoing_period_has_korean_not_applicable_notice():
    view = bare_page()
    view.show_comparison(dict(spaces=[], check_state="ongoing"))
    assert "대조 대상 아님(진행 중)" in view.note.values["text"]
