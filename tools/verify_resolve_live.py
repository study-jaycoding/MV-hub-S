"""실행 중인 DaVinci Resolve와 MV Hub 가져오기·내보내기를 실제로 왕복 검증한다.

사용자 프로젝트를 수정하지 않도록 고유한 임시 Resolve 프로젝트와 OS 임시폴더만 사용한다.
검증이 끝나면 원래 프로젝트를 다시 열고, 이 도구가 만든 프로젝트만 정확한 이름으로 삭제한다.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.resolve_bridge import (  # noqa: E402
    _connect_resolve,
    import_manifest_to_current_project,
)
from app.services.resolve_script_installer import resolve_script_status  # noqa: E402


TEST_PROJECT_PREFIX = "MVHub_Live_Verify_"
RENDER_TIMEOUT_SECONDS = 90.0


class LiveVerifyError(RuntimeError):
    """실측 실패를 사람이 바로 이해할 수 있는 메시지로 전달한다."""


def _load_exporter() -> Any:
    path = BACKEND / "app" / "resources" / "resolve" / "MVHub_Clip_Exporter.py"
    spec = importlib.util.spec_from_file_location("mvhub_live_exporter", path)
    if spec is None or spec.loader is None:
        raise LiveVerifyError(f"Exporter를 불러올 수 없습니다: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _default_source() -> Path:
    candidates = sorted((BACKEND / "data" / "media").glob("**/*.mp4"))
    for candidate in candidates:
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    raise LiveVerifyError("실측할 로컬 MP4가 없습니다. --source로 파일을 지정하세요")


def _find_clip(folder: Any, source: Path) -> Any | None:
    expected = str(source.resolve()).casefold()
    for clip in folder.GetClipList() or []:
        try:
            actual = str(clip.GetClipProperty("File Path") or "")
            if str(Path(actual).resolve()).casefold() == expected:
                return clip
        except (OSError, RuntimeError):
            continue
    for child in folder.GetSubFolderList() or []:
        found = _find_clip(child, source)
        if found is not None:
            return found
    return None


def _folder_at_path(root: Any, names: list[str]) -> Any | None:
    current = root
    for name in names:
        current = next(
            (
                child
                for child in (current.GetSubFolderList() or [])
                if str(child.GetName() or "") == name
            ),
            None,
        )
        if current is None:
            return None
    return current


def _wait_for_render(project: Any, job_ids: list[str]) -> list[dict[str, Any]]:
    deadline = time.monotonic() + RENDER_TIMEOUT_SECONDS
    while bool(project.IsRenderingInProgress()):
        if time.monotonic() >= deadline:
            project.StopRendering()
            raise LiveVerifyError("Resolve 실제 렌더가 제한 시간 90초를 넘었습니다")
        time.sleep(0.25)

    statuses: list[dict[str, Any]] = []
    for job_id in job_ids:
        raw = project.GetRenderJobStatus(job_id) or {}
        status = dict(raw) if isinstance(raw, dict) else {"JobStatus": str(raw)}
        statuses.append(status)
        label = str(status.get("JobStatus") or status.get("Status") or "").casefold()
        if label not in {"complete", "completed"}:
            raise LiveVerifyError(f"Resolve 렌더 작업이 완료되지 않았습니다: {status}")
    return statuses


def _rendered_files(job: dict[str, Any]) -> list[Path]:
    output_dir = Path(str(job["output_dir"]))
    prefix = str(job["output_name"])
    return [
        path
        for path in output_dir.glob(f"{prefix}.*")
        if path.is_file() and path.stat().st_size > 0
    ]


def verify(source: Path) -> dict[str, Any]:
    source = source.resolve()
    if not source.is_file() or source.stat().st_size <= 0:
        raise LiveVerifyError(f"실측 원본을 읽을 수 없습니다: {source}")

    scripts = resolve_script_status()
    if not scripts.get("installed") or not scripts.get("up_to_date"):
        raise LiveVerifyError("Resolve 스크립트가 최신 상태로 설치되지 않았습니다")

    resolve = _connect_resolve()
    manager = resolve.GetProjectManager()
    if manager is None:
        raise LiveVerifyError("Resolve Project Manager를 열 수 없습니다")
    previous = manager.GetCurrentProject()
    previous_name = str(previous.GetName() or "") if previous else ""
    test_name = TEST_PROJECT_PREFIX + uuid.uuid4().hex[:10]
    test_project = None
    owns_test_project = False
    cleanup: dict[str, Any] = {
        "original_project_restored": False,
        "test_project_deleted": False,
    }
    result: dict[str, Any] | None = None

    try:
        test_project = manager.CreateProject(test_name)
        if test_project is None or str(test_project.GetName() or "") != test_name:
            raise LiveVerifyError("격리 Resolve 프로젝트를 만들 수 없습니다")
        owns_test_project = True

        with tempfile.TemporaryDirectory(prefix="mvhub-resolve-live-") as tmp:
            project_root = Path(tmp) / "PROJECT_MVHUBLIVE" / "10_ai"
            source_root = project_root / "render"
            manifest_root = project_root / "@davinci"
            local_source_15 = source_root / "e001" / "c0015" / "live-source-15.mp4"
            local_source_10 = source_root / "e001" / "c0010" / "live-source-10.mp4"
            local_source_15.parent.mkdir(parents=True)
            local_source_10.parent.mkdir(parents=True)
            manifest_root.mkdir(parents=True)
            shutil.copy2(source, local_source_15)
            shutil.copy2(source, local_source_10)

            manifest_base = {
                "format": "mvhub.resolve-transfer",
                "version": 2,
                "project_id": "live-verify-project",
                "project_name": "MVHub Live Verify",
                "manifest_root": str(manifest_root),
                "source_root": str(source_root),
            }
            manifest_15 = {
                **manifest_base,
                "items": [
                    {
                        "generation_id": "live-verify-generation-15",
                        "folder_path": "e001/c0015",
                        "local_path": str(local_source_15),
                        "status": "downloaded",
                    }
                ],
            }
            manifest_10 = {
                **manifest_base,
                "items": [
                    {
                        "generation_id": "live-verify-generation-10",
                        "folder_path": "e001/c0010",
                        "local_path": str(local_source_10),
                        "status": "downloaded",
                    }
                ],
            }
            imported_15 = import_manifest_to_current_project(manifest_15, resolve=resolve)
            imported_10 = import_manifest_to_current_project(manifest_10, resolve=resolve)
            repeated_10 = import_manifest_to_current_project(manifest_10, resolve=resolve)
            if imported_15.get("status") != "complete" or imported_15.get("imported") != 1:
                raise LiveVerifyError(f"첫 번째 Resolve 가져오기가 실패했습니다: {imported_15}")
            if imported_10.get("status") != "complete" or imported_10.get("imported") != 1:
                raise LiveVerifyError(f"두 번째 Resolve 가져오기가 실패했습니다: {imported_10}")
            if repeated_10.get("status") != "complete" or repeated_10.get("skipped") != 1:
                raise LiveVerifyError(f"Resolve 중복 가져오기 방지가 실패했습니다: {repeated_10}")

            media_pool = test_project.GetMediaPool()
            root_folder = media_pool.GetRootFolder() if media_pool else None
            episode = (
                _folder_at_path(
                    root_folder, ["MV Hub", "MVHub Live Verify", "e001"]
                )
                if root_folder
                else None
            )
            folder_order = [
                str(child.GetName() or "") for child in (episode.GetSubFolderList() or [])
            ] if episode else []
            if folder_order != ["c0010", "c0015"]:
                raise LiveVerifyError(f"Resolve 폴더 자연 정렬이 맞지 않습니다: {folder_order}")

            clip_10 = _find_clip(root_folder, local_source_10) if root_folder else None
            clip_15 = _find_clip(root_folder, local_source_15) if root_folder else None
            if clip_10 is None or clip_15 is None:
                raise LiveVerifyError("가져온 원본을 Resolve Media Pool에서 찾을 수 없습니다")
            timeline = media_pool.CreateTimelineFromClips(
                "MVHub Live Timeline", [clip_10, clip_15]
            )
            if timeline is None or not test_project.SetCurrentTimeline(timeline):
                raise LiveVerifyError("가져온 원본으로 실측 타임라인을 만들 수 없습니다")

            exporter = _load_exporter()
            records = exporter.collect_timeline_clips(test_project, 1)
            output_root = project_root / "assets" / "reference"
            jobs = exporter.build_render_jobs(
                records,
                str(output_root),
                version="001",
                description="live",
                episode="1",
                sequence_step=10,
            )
            render_root = project_root / "render-output"
            created_folders = exporter.create_render_sequence_folders(
                jobs, str(render_root)
            )
            job_ids = exporter.enqueue_render_jobs(test_project, jobs)
            try:
                exporter.start_render_jobs(test_project, job_ids)
                render_statuses = _wait_for_render(test_project, job_ids)
                outputs = [path for job in jobs for path in _rendered_files(job)]
                if len(outputs) != len(jobs):
                    raise LiveVerifyError(
                        f"렌더 결과 수가 맞지 않습니다: 작업 {len(jobs)}개, 파일 {len(outputs)}개"
                    )
            finally:
                for job_id in job_ids:
                    try:
                        test_project.DeleteRenderJob(job_id)
                    except Exception:
                        pass

            result = {
                "ok": True,
                "resolve": {
                    "product": str(resolve.GetProductName() or ""),
                    "version": str(resolve.GetVersionString() or ""),
                },
                "scripts": {
                    "exporter": scripts.get("installed_version"),
                    "importer": scripts.get("importer_bundled_version"),
                },
                "import": {
                    "statuses": [
                        imported_15.get("status"),
                        imported_10.get("status"),
                        repeated_10.get("status"),
                    ],
                    "imported": imported_15.get("imported", 0)
                    + imported_10.get("imported", 0),
                    "duplicate_skipped": repeated_10.get("skipped"),
                    "folder_order": folder_order,
                    "target_root": imported_10.get("target_root"),
                },
                "export": {
                    "jobs": len(job_ids),
                    "statuses": render_statuses,
                    "output_names": [path.name for path in outputs],
                    "sequence_folders": [Path(path).name for path in created_folders],
                },
                "cleanup": cleanup,
            }
    finally:
        if test_project is not None:
            try:
                if bool(test_project.IsRenderingInProgress()):
                    test_project.StopRendering()
            except Exception:
                pass
            try:
                manager.CloseProject(test_project)
            except Exception:
                pass
        if previous_name:
            try:
                restored = manager.LoadProject(previous_name)
                cleanup["original_project_restored"] = bool(restored)
            except Exception:
                cleanup["original_project_restored"] = False
        else:
            cleanup["original_project_restored"] = True
        if owns_test_project and test_name.startswith(TEST_PROJECT_PREFIX):
            try:
                cleanup["test_project_deleted"] = bool(manager.DeleteProject(test_name))
            except Exception:
                cleanup["test_project_deleted"] = False

    if result is None:
        raise LiveVerifyError("Resolve 실측 결과가 만들어지지 않았습니다")
    if not cleanup["original_project_restored"]:
        raise LiveVerifyError("실측 뒤 원래 Resolve 프로젝트를 복원하지 못했습니다")
    if not cleanup["test_project_deleted"]:
        raise LiveVerifyError(f"실측용 Resolve 프로젝트를 정리하지 못했습니다: {test_name}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="실측할 로컬 MP4")
    args = parser.parse_args()
    try:
        result = verify(args.source or _default_source())
    except Exception as exc:  # noqa: BLE001 - 검증 CLI는 원인을 JSON으로 남긴다.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
