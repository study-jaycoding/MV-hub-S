"""폴더 열기는 로컬·프로젝트·Render 경계 안의 기존 디렉터리에만 실행한다."""
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import active_account
from app.mutation_notify import notification_domains
from app.routers import manage
from app.routers._proxy import is_local_path
from app.services import project_folders


@pytest.fixture
def folder(tmp_path, monkeypatch):
    render = tmp_path / "My Project" / "Render"
    target = render / "제이" / "shot 01"
    target.mkdir(parents=True)
    monkeypatch.setattr(project_folders, "effective_root_path", lambda pid: str(render.parent))
    opener = Mock()
    monkeypatch.setattr(project_folders.subprocess, "Popen", opener)
    return render, target, opener


@pytest.mark.parametrize("platform,command", [("win32", "explorer.exe"), ("darwin", "open"), ("linux", "xdg-open")])
def test_opens_exact_folder_without_select_or_shell(folder, monkeypatch, platform, command):
    _, target, opener = folder
    monkeypatch.setattr(project_folders.sys, "platform", platform)
    project_folders.open_project_folder("p", "제이/shot 01")
    opener.assert_called_once_with([command, str(target.resolve())], shell=False)


def test_backslash_relative_path_is_supported(folder):
    _, target, opener = folder
    project_folders.open_project_folder("p", "제이\\shot 01")
    assert opener.call_args.args[0][1] == str(target.resolve())


def test_missing_opener_is_not_misreported_as_missing_folder(folder):
    _, _, opener = folder
    opener.side_effect = FileNotFoundError(2, "private executable detail")
    with pytest.raises(OSError, match="탐색기를 실행할 수 없습니다") as error:
        project_folders.open_project_folder("p", "제이/shot 01")
    assert type(error.value) is OSError
    assert "private executable" not in str(error.value)


@pytest.mark.parametrize("path", ["", "/제이", "../outside", "a/../../b", "a/./b", "a//b",
    "C:/a", "C:a", "\\\\server\\share", "\\\\?\\C:\\a", "a\x00b", 'a"b', "a:b", "a?b", "a*/b", "a./b", "a /b"])
def test_rejects_unsafe_path_before_file_access(folder, monkeypatch, path):
    _, _, opener = folder
    lookup = Mock(side_effect=AssertionError("must reject before root access"))
    monkeypatch.setattr(project_folders, "render_root_state", lookup)
    with pytest.raises(ValueError):
        project_folders.open_project_folder("p", path)
    opener.assert_not_called()


def test_missing_directory_is_not_created_and_does_not_fallback(folder):
    render, _, opener = folder
    with pytest.raises(FileNotFoundError):
        project_folders.open_project_folder("p", "missing")
    assert not (render / "missing").exists()
    opener.assert_not_called()


def test_file_is_not_opened(folder):
    render, _, opener = folder
    (render / "file.txt").write_text("fixture", encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        project_folders.open_project_folder("p", "file.txt")
    opener.assert_not_called()


def test_resolved_link_escape_is_rejected(folder, monkeypatch):
    _, _, opener = folder
    join = Mock(return_value=None)
    monkeypatch.setattr(project_folders, "safe_join", join)
    with pytest.raises(ValueError, match="밖"):
        project_folders.open_project_folder("p", "link")
    join.assert_called_once()
    opener.assert_not_called()


def test_unconfigured_root_is_not_opened(folder, monkeypatch):
    _, _, opener = folder
    monkeypatch.setattr(project_folders, "effective_root_path", lambda pid: "")
    with pytest.raises(ValueError, match="연결되지"):
        project_folders.open_project_folder("p", "folder")
    opener.assert_not_called()


def request(host="127.0.0.1", client="127.0.0.1", extra=()):
    return Request({"type": "http", "client": (client, 123),
                    "headers": [(b"host", host.encode()), *extra]})


@pytest.fixture
def route(monkeypatch):
    monkeypatch.setattr(manage._proxy, "is_shared_team_server", lambda: False)
    read = Mock()
    opener = Mock()
    monkeypatch.setattr(manage, "_require_project_read", read)
    monkeypatch.setattr(project_folders, "open_project_folder", opener)
    monkeypatch.setattr(active_account, "account_key", lambda: "")
    monkeypatch.setattr(active_account, "active_uid", lambda: "fixture-owner")
    body = manage.ProjectFolderRevealIn(project_id="p", folder_path="제이/shot 01")
    return body, read, opener


def test_route_checks_project_and_calls_local_service(route):
    body, read, opener = route
    req = request()
    assert manage.reveal_project_folder(body, req) == {"ok": True}
    read.assert_called_once_with(req, "p")
    opener.assert_called_once_with("p", "제이/shot 01")


@pytest.mark.parametrize("req", [request(client="192.0.2.10"), request(host="evil.invalid"),
    request(extra=[(b"origin", b"https://evil.invalid")]),
    request(extra=[(b"sec-fetch-site", b"cross-site")]),
    request(extra=[(b"x-forwarded-for", b"192.0.2.10")])])
def test_remote_browser_cannot_open_explorer(route, req):
    body, read, opener = route
    with pytest.raises(HTTPException) as error:
        manage.reveal_project_folder(body, req)
    assert error.value.status_code == 403
    read.assert_not_called()
    opener.assert_not_called()


def test_team_server_rejects_even_loopback(route, monkeypatch):
    body, read, opener = route
    monkeypatch.setattr(manage._proxy, "is_shared_team_server", lambda: True)
    with pytest.raises(HTTPException) as error:
        manage.reveal_project_folder(body, request())
    assert error.value.status_code == 403
    read.assert_not_called()
    opener.assert_not_called()


def test_no_project_access_never_opens_folder(route):
    body, read, opener = route
    read.side_effect = HTTPException(403, "no access")
    with pytest.raises(HTTPException) as error:
        manage.reveal_project_folder(body, request())
    assert error.value.status_code == 403
    opener.assert_not_called()


@pytest.mark.parametrize("failure,status", [(ValueError("invalid"), 400),
    (FileNotFoundError("missing"), 404), (PermissionError("private-path"), 500)])
def test_failure_is_not_reported_as_success(route, failure, status):
    body, _, opener = route
    opener.side_effect = failure
    with pytest.raises(HTTPException) as error:
        manage.reveal_project_folder(body, request())
    assert error.value.status_code == status
    assert "private-path" not in error.value.detail


def test_local_only_and_no_change_notification():
    path = "/api/manage/project-folders/reveal"
    assert is_local_path(path)
    assert notification_domains("POST", path, 200) == ()
    assert notification_domains("PUT", "/api/manage/project-folders/p", 200) == ("manage",)


def test_http_route_and_empty_path_validation(route):
    _, _, opener = route
    app = FastAPI()
    app.include_router(manage.router)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 123)) as client:
        response = client.post("/api/manage/project-folders/reveal",
                               json={"project_id": "p", "folder_path": "제이/shot 01"})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        invalid = client.post("/api/manage/project-folders/reveal",
                              json={"project_id": "p", "folder_path": ""})
        assert invalid.status_code == 422
    opener.assert_called_once()


def test_account_pair_is_restored_after_failure(route, monkeypatch):
    body, read, opener = route
    before_key, before_uid = active_account._override.get(), active_account._uid_override.get()
    def check_scope(*args):
        assert active_account._override.get() == ""
        assert active_account._uid_override.get() == ("fixture-owner",)
    read.side_effect = check_scope
    opener.side_effect = OSError("failed")
    with pytest.raises(HTTPException):
        manage.reveal_project_folder(body, request())
    assert active_account._override.get() == before_key
    assert active_account._uid_override.get() == before_uid
