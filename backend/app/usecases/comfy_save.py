"""Shared save context for browser saves, canvas completion and recovery."""
from __future__ import annotations

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..services import comfy_asset_provenance as provenance


def durable_context(record: dict) -> dict:
    """Only execution evidence, never connection settings or private filesystem paths."""
    result = {key: record[key] for key in (
        "execution_snapshot", "asset_project_id", "asset_server_origin",
        "comfy_unverified_input_slots", "save_meta",
    ) if key in record}
    result["input_evidence"] = [
        {key: value for key, value in item.items() if key not in ("path", "server_location")}
        for item in record.get("input_evidence", [])
    ]
    return provenance._metadata_value(result)


def save_output(*, url: str, kind: str, record: dict, output: dict,
                creator_uid, prompt: str, params: dict, references: list,
                project_id, folder_path, can_view_source, archive_output,
                canvas_attempt_id=None, canvas_output_key=None) -> dict:
    # A persisted link wins even if the user deleted the generation or its file.
    if canvas_attempt_id:
        row = repo.comfy_canvas_runs.get(canvas_attempt_id)
        linked = next((item for item in row["outputs"] if item["output_key"] == canvas_output_key), None)
        if linked and linked.get("generation_id"):
            return {"url": url, "generation_id": linked["generation_id"], "existed": True}
    snapshot = record.get("execution_snapshot")
    if isinstance(snapshot, dict):
        prompt = snapshot.get("prompt") or "Comfy 출력"
        params = dict(snapshot.get("params") or {})
        params["comfy_workflow"] = snapshot.get("workflow")
        params["comfy_unverified_input_slots"] = record.get("comfy_unverified_input_slots", [])
        evidence = sorted(record.get("input_evidence", []), key=lambda item: item["position"])
        params["comfy_input_provenance"] = [
            {key: value for key, value in item.items() if key not in ("path", "server_location")}
            for item in evidence
        ]
        name = record.get("save_meta", {}).get("name")
        if name:
            params["workflow_name"] = name
        references = []
        for item in evidence:
            source_id = item.get("source_gen_id")
            references.append({
                "file_path": item["file_path"], "type": item["type"], "name": item["name"],
                "role": item.get("role"), "source_url": item["file_path"],
                "source_gen_id": source_id if source_id and can_view_source(source_id) else None,
                "_submitted_sha": item["sha256"], "_submitted_bytes": item["bytes"],
            })
        params = provenance._metadata_value(params)
    evidence = archive_output(url, kind, project_id, output)
    if canvas_attempt_id and evidence is None:
        raise ValueError("캔버스 출력 파일을 확인할 수 없어 저장하지 않았습니다")
    gid, existed = repo.create_comfy_generation(
        worker_id=DEFAULT_WORKER_ID, creator_uid=creator_uid, prompt=prompt,
        display_prompt=None, params=params, kind=kind, file_path=url,
        thumbnail_path=None, references=references, project_id=project_id, folder_path=folder_path,
        output_sha=evidence["sha256"] if evidence else None,
        output_bytes=evidence["bytes"] if evidence else None,
        **({"canvas_attempt_id": canvas_attempt_id, "canvas_output_key": canvas_output_key} if canvas_attempt_id else {}),
    )
    return {"url": url, "generation_id": gid, "existed": existed}
