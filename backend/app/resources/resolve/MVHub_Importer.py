#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MV Hub prepared-media importer for DaVinci Resolve.

외부 Resolve API 연결을 사용할 수 없는 환경에서도 Workspace > Scripts 메뉴에서
직접 실행할 수 있다. 로컬 MV Hub가 준비한 manifest를 받아 현재 프로젝트의
Media Pool에 ``MV Hub / 프로젝트 / 에피소드 / 시퀀스`` 구조로 가져온다.
"""

from __future__ import print_function

import json
import os
import re

try:
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen
except ImportError:  # pragma: no cover - Resolve의 구형 Python 2 폴백
    from urllib2 import HTTPError, Request, URLError, urlopen


PLUGIN_VERSION = "0.1.0"
WINDOW_ID = "com.millionvolt.mvhub.importer-result"
HUB_URLS = tuple(
    value.strip().rstrip("/")
    for value in os.environ.get(
        "MVHUB_LOCAL_URLS", "http://127.0.0.1:8010,http://127.0.0.1:8012"
    ).split(",")
    if value.strip()
)
_NUMBER_CHUNKS = re.compile(r"(\d+)")
_UNSAFE_FOLDER_CHARS = re.compile(r"[\\/\x00-\x1f]")


class ImporterError(RuntimeError):
    pass


def _resolve_context():
    resolve_obj = globals().get("resolve")
    fusion_obj = globals().get("fusion")
    bmd_obj = globals().get("bmd")
    app_obj = globals().get("app")
    if resolve_obj is None and app_obj is not None:
        getter = getattr(app_obj, "GetResolve", None)
        if callable(getter):
            resolve_obj = getter()
    if resolve_obj is None:
        try:
            import DaVinciResolveScript as dvr_script
        except ImportError:
            raise ImporterError("Resolve 내부 스크립팅 환경을 찾을 수 없습니다")
        resolve_obj = dvr_script.scriptapp("Resolve")
        bmd_obj = bmd_obj or dvr_script
    if resolve_obj is None:
        raise ImporterError("현재 실행 중인 Resolve에 연결할 수 없습니다")
    fusion_obj = fusion_obj or resolve_obj.Fusion()
    return resolve_obj, fusion_obj, bmd_obj


def _http_json(method, path, payload=None, bases=None):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    errors = []
    for base in bases or HUB_URLS:
        try:
            request = Request(base + path, data=body, headers=headers)
            if hasattr(request, "method"):
                request.method = method
            else:  # Python 2
                request.get_method = lambda: method
            response = urlopen(request, timeout=5)
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else {}, base
        except HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", "replace")
            except Exception:
                detail = str(exc)
            errors.append("{0}: HTTP {1} {2}".format(base, exc.code, detail[:200]))
        except (URLError, OSError, ValueError) as exc:
            errors.append("{0}: {1}".format(base, exc))
    raise ImporterError(
        "로컬 MV Hub에 연결할 수 없습니다. MV Hub를 먼저 실행하세요.\n"
        + "\n".join(errors)
    )


def _folder_name(value, fallback):
    cleaned = _UNSAFE_FOLDER_CHARS.sub("_", str(value or "").strip()).strip(" .")
    return cleaned or fallback


def _folder_parts(value):
    parts = []
    for raw in str(value or "").replace("\\", "/").split("/"):
        raw = raw.strip()
        if not raw or raw in (".", ".."):
            continue
        parts.append(_folder_name(raw, "미분류"))
    return parts


def _natural_key(value):
    chunks = []
    for chunk in _NUMBER_CHUNKS.split(str(value or "")):
        if not chunk:
            continue
        chunks.append((1, int(chunk)) if chunk.isdigit() else (0, chunk.lower()))
    return tuple(chunks)


def _identity(value):
    text = str(value or "")
    return text.casefold() if hasattr(text, "casefold") else text.lower()


def _project_identity(project):
    name = str(project.GetName() or "")
    getter = getattr(project, "GetUniqueId", None)
    try:
        unique_id = str(getter() or "") if callable(getter) else ""
    except Exception:
        unique_id = ""
    return unique_id, name


def _matches_expected_project(manifest, project):
    target = manifest.get("resolve_target") or {}
    expected_id = str(target.get("project_id") or "")
    expected_name = str(target.get("project_name") or "")
    if not expected_id and not expected_name:
        return True, ""
    current_id, current_name = _project_identity(project)
    id_mismatch = bool(expected_id and current_id and expected_id != current_id)
    name_mismatch = bool(
        expected_name
        and (not expected_id or not current_id)
        and expected_name != current_name
    )
    if not id_mismatch and not name_mismatch:
        return True, ""
    return False, "예정 {0} / 현재 {1}".format(
        expected_name or expected_id,
        current_name or current_id or "확인 불가",
    )


def _find_subfolder(parent, name):
    wanted = _identity(name)
    for folder in parent.GetSubFolderList() or []:
        if _identity(folder.GetName()) == wanted:
            return folder
    return None


def _subfolder(media_pool, parent, name):
    existing = _find_subfolder(parent, name)
    if existing is not None:
        return existing
    created = media_pool.AddSubFolder(parent, name)
    if not created:
        raise ImporterError("Media Pool 폴더를 만들 수 없습니다: {0}".format(name))
    return created


# 매핑 드라이브("z:") → UNC 루트 캐시 — resolve_bridge._normal_path 와 같은 규칙.
_DRIVE_UNC_CACHE = {}


def _drive_unc(drive):
    if os.name != "nt" or len(drive) != 2 or drive[1] != ":":
        return None
    key = drive.lower()
    if key in _DRIVE_UNC_CACHE:
        return _DRIVE_UNC_CACHE[key]
    unc = None
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(1024)
        length = ctypes.c_ulong(len(buf))
        if ctypes.windll.mpr.WNetGetConnectionW(drive, buf, ctypes.byref(length)) == 0:
            unc = buf.value or None
    except Exception:
        unc = None
    _DRIVE_UNC_CACHE[key] = unc
    return unc


def _normal_path(value):
    # Z:↔UNC 표기 통일 — Resolve 클립의 File Path 는 등록 표기를 그대로 돌려주므로,
    # 한쪽만 UNC 면 dedupe 가 어긋나 중복 import·거짓 실패가 난다(resolve_bridge 와 동일 규칙).
    normalized = os.path.normcase(os.path.normpath(os.path.abspath(str(value or ""))))
    drive, rest = os.path.splitdrive(normalized)
    if drive and not drive.startswith("\\\\"):
        unc = _drive_unc(drive)
        if unc:
            normalized = os.path.normcase(os.path.normpath(unc + rest))
    return normalized


def _clip_path(clip):
    try:
        props = clip.GetClipProperty()
        if isinstance(props, dict):
            return str(props.get("File Path") or "")
    except Exception:
        pass
    try:
        return str(clip.GetClipProperty("File Path") or "")
    except Exception:
        return ""


def _existing_paths(folder):
    result = set()
    for clip in folder.GetClipList() or []:
        path = _clip_path(clip)
        if path:
            result.add(_normal_path(path))
    return result


def _ready_items(manifest):
    result = []
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        if item.get("status") not in ("downloaded", "skipped"):
            continue
        path = str(item.get("local_path") or "")
        if path and os.path.isfile(path):
            result.append(item)
    return result


def _post_result(base, manifest, result):
    payload = {
        "project_id": str(manifest.get("project_id") or ""),
        "transfer_id": str(manifest.get("transfer_id") or ""),
        "status": result["status"],
        "total": result["total"],
        "imported": result["imported"],
        "skipped": result["skipped"],
        "error_count": result["error_count"],
        "error": result.get("error"),
    }
    _http_json("POST", "/api/resolve/transfers/manual-result", payload, bases=(base,))


def import_pending(resolve_obj):
    response, hub_base = _http_json("GET", "/api/resolve/transfers/pending")
    manifests = response.get("items") or []
    if not manifests:
        return "가져올 준비 완료 원본이 없습니다. 먼저 MV Hub에서 다빈치 보내기를 누르세요."

    manager = resolve_obj.GetProjectManager()
    project = manager.GetCurrentProject() if manager else None
    if project is None:
        raise ImporterError("Resolve에서 가져올 프로젝트를 먼저 여세요")
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder() if media_pool else None
    if root is None:
        raise ImporterError("Resolve Media Pool을 열 수 없습니다")
    previous_folder = media_pool.GetCurrentFolder()
    managed_root = None

    total_imported = 0
    total_skipped = 0
    total_errors = 0
    warnings = []
    for manifest in reversed(manifests):
        matches, mismatch = _matches_expected_project(manifest, project)
        if not matches:
            warnings.append("다른 프로젝트 전송은 보류했습니다: {0}".format(mismatch))
            continue
        ready = _ready_items(manifest)
        if not ready:
            warnings.append(
                "준비된 원본 파일을 찾지 못해 전송을 보류했습니다: {0}".format(
                    manifest.get("transfer_id") or "확인 불가"
                )
            )
            continue
        if managed_root is None:
            managed_root = _subfolder(media_pool, root, "MV Hub")
        result = {
            "status": "failed",
            "total": len(ready),
            "imported": 0,
            "skipped": 0,
            "error_count": 0,
            "error": None,
        }
        project_folder = _subfolder(
            media_pool,
            managed_root,
            _folder_name(manifest.get("project_name"), "미분류 프로젝트"),
        )
        grouped = {}
        for item in ready:
            parts = tuple(_folder_parts(item.get("folder_path")))
            grouped.setdefault(parts, []).append(item)

        for parts in sorted(grouped, key=lambda value: tuple(_natural_key(p) for p in value)):
            target = project_folder
            for part in parts:
                target = _subfolder(media_pool, target, part)
            existing = _existing_paths(target)
            missing = []
            for item in grouped[parts]:
                normalized = _normal_path(item.get("local_path"))
                if normalized in existing:
                    result["skipped"] += 1
                else:
                    missing.append(item)
            if not missing:
                continue
            try:
                if not media_pool.SetCurrentFolder(target):
                    raise ImporterError("대상 Media Pool 폴더를 선택할 수 없습니다")
                imported = media_pool.ImportMedia(
                    [str(item["local_path"]) for item in missing]
                )
                refresh = getattr(media_pool, "RefreshFolders", None)
                if callable(refresh):
                    refresh()
                returned = set()
                if isinstance(imported, (list, tuple)):
                    returned = {
                        _normal_path(path)
                        for path in (_clip_path(clip) for clip in imported)
                        if path
                    }
                current = _existing_paths(target) | returned
                trust_return_count = (
                    isinstance(imported, (list, tuple))
                    and len(imported) == len(missing)
                    and not returned
                )
                for item in missing:
                    if _normal_path(item.get("local_path")) in current or trust_return_count:
                        result["imported"] += 1
                    else:
                        result["error_count"] += 1
            except Exception as exc:
                result["error_count"] += len(missing)
                result["error"] = str(exc)

        ok_count = result["imported"] + result["skipped"]
        result["status"] = (
            "complete"
            if result["error_count"] == 0
            else ("partial" if ok_count else "failed")
        )
        total_imported += result["imported"]
        total_skipped += result["skipped"]
        total_errors += result["error_count"]
        try:
            _post_result(hub_base, manifest, result)
        except Exception as exc:
            warnings.append("완료 기록 실패: {0}".format(exc))

    if previous_folder is not None:
        try:
            media_pool.SetCurrentFolder(previous_folder)
        except Exception:
            pass
    if total_imported and not manager.SaveProject():
        warnings.append("Resolve 프로젝트 저장 확인 실패")
    message = "가져오기 완료: 새 원본 {0}개, 기존 {1}개".format(
        total_imported, total_skipped
    )
    if total_errors:
        message += ", 실패 {0}개".format(total_errors)
    if warnings:
        message += "\n" + "\n".join(warnings)
    return message


def _show_message(fusion_obj, bmd_obj, text):
    print("MV Hub Importer: {0}".format(text))
    if fusion_obj is None or bmd_obj is None:
        return
    try:
        ui = fusion_obj.UIManager
        dispatcher = bmd_obj.UIDispatcher(ui)
        window = dispatcher.AddWindow(
            {
                "ID": WINDOW_ID,
                "Geometry": [320, 220, 620, 180],
                "WindowTitle": "MV Hub Importer {0}".format(PLUGIN_VERSION),
            },
            ui.VGroup(
                {"Spacing": 10},
                [
                    ui.Label({"Text": str(text), "WordWrap": True}),
                    ui.Button({"ID": "Close", "Text": "확인"}),
                ],
            ),
        )

        def close(_event):
            dispatcher.ExitLoop()

        window.On[WINDOW_ID].Close = close
        window.On["Close"].Clicked = close
        window.Show()
        dispatcher.RunLoop()
        window.Hide()
    except Exception as exc:
        print("MV Hub Importer dialog unavailable: {0}".format(exc))


def main():
    resolve_obj = fusion_obj = bmd_obj = None
    try:
        resolve_obj, fusion_obj, bmd_obj = _resolve_context()
        message = import_pending(resolve_obj)
    except Exception as exc:
        message = "가져오기 실패: {0}".format(exc)
    _show_message(fusion_obj, bmd_obj, message)


if __name__ == "__main__" or "resolve" in globals() or "app" in globals():
    main()
