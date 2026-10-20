"""실제 SQLite·실행 저널·로컬 스냅샷으로 Comfy 입력/결과 판을 검증한다."""
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, UploadFile

from app import db, repo
from app.routers import comfy
from app.repo import asset_sync as ledger
from test_comfy_run_journal import h  # noqa: F401 - 동일한 격리 실행 harness 재사용


def start_media(h, monkeypatch, data, *, kind="image", content_id=None, project_id=""):
    media_node = {"class_type": "LoadImage", "inputs": {"image": "x.png"}} if kind == "image" else {
        "class_type": "VHS_LoadVideo", "inputs": {"video": "x.mov"}}
    workflow = {"1": media_node, "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "old"}}}
    monkeypatch.setattr(comfy.comfy_client, "upload_file", Mock(return_value="mvhub/submitted"))
    return comfy.run(
        request=h.request(), content=json.dumps(workflow), param_values='{"2|text":"executed prompt"}',
        media_meta=json.dumps([{"type": kind, "role": "character", "source_url": "asset:imports|original.png",
                                "asset_content_id": content_id or "sha256:" + hashlib.sha256(data).hexdigest()}]),
        media=[UploadFile(io.BytesIO(data), filename="source.png" if kind == "image" else "source.mov")],
        project_id=project_id,
    )["job_id"]


def test_run_journal_freezes_actual_bytes_and_save_ignores_later_form(h, monkeypatch):
    h.successful()
    original = b"actual-image-input"
    job_id = start_media(h, monkeypatch, original)
    h.drain()
    record = h.rows()[0]
    evidence = record["input_evidence"][0]
    assert Path(evidence["path"]).read_bytes() == original
    assert evidence["asset_content_id"] == "sha256:" + hashlib.sha256(original).hexdigest()
    assert evidence["position"] == 0 and evidence["slot"] == {"node_id": "1", "field": "image"}
    assert comfy.comfy_client.upload_file.call_args.args[2] == Path(evidence["path"])
    output = comfy.run_status(job_id, h.request())["outputs"][0]
    body = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=output["url"], kind="video")], prompt="later edited",
                                  params={"2|text": "wrong"}, inputs=[comfy.ComfyRefItem(url="/media/wrong.png")])
    saved = comfy.save_to_library(body, h.request())["saved"][0]
    generation = repo.get_generation(saved["generation_id"])
    assert generation["prompt"] == "executed prompt"
    assert generation["params"]["2|text"] == "executed prompt"
    assert generation["params"]["comfy_input_provenance"][0]["asset_content_id"] == evidence["asset_content_id"]
    assert generation["references"][0]["file_path"] == evidence["file_path"]
    assert generation["references"][0]["content_sha"] == evidence["sha256"]
    assert generation["assets"][0]["asset_content_id"] == record["outputs"][0]["asset_content_id"]
    assert generation["assets"][0]["type"] == "image"


def test_cloud_conversion_archives_and_records_transmitted_mp4_not_original(h, monkeypatch):
    h.successful()
    source = b"original-mov-content"
    converted = h.tmp / "converted.mp4"
    converted.write_bytes(b"actual-h264-input")
    monkeypatch.setattr(comfy.video_convert, "to_cloud_mp4_path", lambda _source: converted)
    start_media(h, monkeypatch, source, kind="video")
    h.drain()
    evidence = h.rows()[0]["input_evidence"][0]
    assert evidence["sha256"] == hashlib.sha256(b"actual-h264-input").hexdigest()
    assert evidence["source_asset_content_id"] == "sha256:" + hashlib.sha256(source).hexdigest()
    original_snapshot = comfy.provenance.local_input_path(evidence["source_file_path"], comfy.MEDIA_DIR,
                                                         evidence["source_file_path"].split("/")[-2])
    assert original_snapshot.read_bytes() == source
    assert Path(evidence["path"]).read_bytes() == b"actual-h264-input"
    assert not converted.exists()
    assert comfy.comfy_client.upload_file.call_args.args[2] == Path(evidence["path"])


def test_claimed_content_id_mismatch_stops_before_provider_submission(h, monkeypatch):
    h.successful()
    start_media(h, monkeypatch, b"input", content_id="sha256:" + "0" * 64)
    h.drain()
    h.mocks["submit"].assert_not_called()
    comfy.comfy_client.upload_file.assert_not_called()


def test_changed_output_cannot_be_saved_under_downloaded_content_id(h):
    h.successful()
    job_id = h.start()
    h.drain()
    record = h.rows()[0]
    output = comfy.run_status(job_id, h.request())["outputs"][0]
    (comfy.MEDIA_DIR / record["outputs"][0]["rel"]).write_bytes(b"changed-since-download")
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(**output)]), h.request())
    assert error.value.status_code == 409
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation WHERE generator='comfy'").fetchone()[0] == 0


def test_project_and_origin_are_pinned_at_run_and_queued_for_actual_snapshots(h, monkeypatch):
    h.successful()
    monkeypatch.setattr(comfy.shared_connection, "base_url", lambda: "http://server-original.invalid")
    start_media(h, monkeypatch, b"input", project_id="project-original")
    monkeypatch.setattr(comfy.shared_connection, "base_url", lambda: "http://server-new.invalid")
    h.drain()
    with db.get_connection() as conn:
        rows = conn.execute("SELECT project_id,server_origin FROM asset_sync_outbox").fetchall()
    assert rows and all(row["project_id"] == "project-original" for row in rows)
    assert all(row["server_origin"] == "http://server-original.invalid" for row in rows)


def test_legacy_output_without_bytes_gets_no_fabricated_content_id(h):
    saved = comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(
        url="/media/comfy/legacy-absent.png", kind="image")]), h.request())["saved"][0]
    generation = repo.get_generation(saved["generation_id"])
    assert generation["assets"][0].get("asset_content_id") is None


def test_existing_legacy_private_output_without_owner_proof_is_rejected(h):
    path = comfy.MEDIA_DIR / 'comfy' / 'private-flat.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'another accounts private output')
    # A client-controlled URL reference is not verified ownership of those bytes.
    repo.create_comfy_generation(worker_id=comfy.DEFAULT_WORKER_ID, creator_uid=repo.get_my_uid(),
        prompt='unverified claim', display_prompt=None, params={}, kind='image', file_path='/media/claim.png',
        thumbnail_path=None, references=[{'file_path': '/media/comfy/private-flat.png', 'type': 'image'}])
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(
            url='/media/comfy/private-flat.png', kind='image')], project_id='other-project'), h.request())
    assert error.value.status_code == 403
    with db.get_connection() as connection:
        assert connection.execute('SELECT COUNT(*) FROM asset_sync_outbox').fetchone()[0] == 0
    assert not list((comfy.MEDIA_DIR.parent / 'comfy-inputs').rglob('*.part'))


def test_legacy_ownership_is_checked_on_exact_staged_bytes_before_registration(h, monkeypatch):
    path = comfy.MEDIA_DIR / 'flat.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'actual copied bytes')
    observed = []
    def ownership(staged, owner):
        assert staged != path and staged.suffix == '.part'
        observed.append(staged.read_bytes())
        return False
    monkeypatch.setattr(comfy.provenance.asset_sync, 'owns_local_content', ownership)
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(
            url='/media/flat.png', kind='image')]), h.request())
    assert error.value.status_code == 403 and observed == [b'actual copied bytes']


def test_legacy_output_accepts_current_owner_verified_bytes_not_other_owner(h):
    path = comfy.MEDIA_DIR / 'legacy.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'verified original')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with comfy._comfy_request_scope(h.request()) as identity:
        owner = identity.creator_uid or identity.pin[1] or repo.get_my_uid() or (
            'acct:' + identity.owner if identity.owner != 'local' else 'local')
    with db.get_connection() as connection:
        ledger.register_local(connection, path=path, file_path='/media/other-alias.png', digest=digest,
            size=path.stat().st_size, media_type='image', owner_uid='other-owner')
    body = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url='/media/legacy.png', kind='image')])
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(body, h.request())
    assert error.value.status_code == 403
    with db.get_connection() as connection:
        ledger.register_local(connection, path=path, file_path='/media/different-alias.png', digest=digest,
            size=path.stat().st_size, media_type='image', owner_uid=owner)
    saved = comfy.save_to_library(body, h.request())['saved'][0]
    generation = repo.get_generation(saved['generation_id'])
    assert generation['assets'][0]['asset_content_id'] == 'sha256:' + digest


@pytest.mark.parametrize('changed', [False, True])
def test_legacy_journal_bytes_authorize_only_exact_recorded_output(h, changed):
    path = comfy.MEDIA_DIR / 'comfy' / 'recorded-legacy.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    original = b'journal verified output'
    path.write_bytes(original)
    with comfy._comfy_request_scope(h.request()) as identity:
        row = comfy._new_run_record('e' * 32, identity)
        row.update(phase='collected', prompt_id='legacy-provider-id', terminal_kind='success',
            outputs_enumerated=True, media_output_count=1, outputs=[{'rel': 'comfy/recorded-legacy.png',
                'kind': 'image', 'downloaded': True, 'sha256': hashlib.sha256(original).hexdigest(),
                'bytes': len(original), 'acked': False}])
        comfy.run_journal.admit(row, False)
    if changed:
        path.write_bytes(b'changed since recorded')
    body = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url='/media/comfy/recorded-legacy.png', kind='image')])
    if changed:
        with pytest.raises(HTTPException) as error:
            comfy.save_to_library(body, h.request())
        assert error.value.status_code == 409
    else:
        saved = comfy.save_to_library(body, h.request())['saved'][0]
        assert repo.get_generation(saved['generation_id'])['assets'][0]['asset_content_id'] == 'sha256:' + hashlib.sha256(original).hexdigest()


def test_parallel_path_video_inputs_with_same_filename_keep_distinct_actual_bytes(tmp_path):
    def fill(index):
        source = tmp_path / ('source-' + str(index) + '.mp4')
        source.write_bytes(('video bytes ' + str(index)).encode())
        workflow = {'1': {'class_type': 'VHS_LoadVideoPath', 'inputs': {'video': 'same.mp4'}}}
        slot = {'node_id': '1', 'field': 'video', 'class_type': 'VHS_LoadVideoPath', 'mode': 'path'}
        comfy._fill_videos({'cloud': False}, workflow, [slot],
            [comfy._MediaUpload('same.mp4', source, source.stat().st_size)], str(tmp_path / 'input'), str(index))
        return Path(workflow['1']['inputs']['video'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(fill, (1, 2)))
    assert first != second
    assert first.read_bytes() == b'video bytes 1' and second.read_bytes() == b'video bytes 2'
    assert first.stem == hashlib.sha256(first.read_bytes()).hexdigest()
    assert second.stem == hashlib.sha256(second.read_bytes()).hexdigest()
    assert not list((tmp_path / 'input').rglob('*.part'))


def test_path_video_commit_never_overwrites_conflicting_existing_content(tmp_path):
    source = tmp_path / 'source.mp4'
    source.write_bytes(b'expected video')
    target = comfy.provenance.materialize_path_input(source, str(tmp_path / 'input'))
    assert comfy.provenance.materialize_path_input(source, str(tmp_path / 'input')) == target
    target.write_bytes(b'unrelated conflicting bytes')
    with pytest.raises(ValueError, match='바이트'):
        comfy.provenance.materialize_path_input(source, str(tmp_path / 'input'))
    assert target.read_bytes() == b'unrelated conflicting bytes'
    assert not list((tmp_path / 'input').rglob('*.part'))


def test_path_video_changed_after_archive_does_not_create_wrong_journal_provenance(tmp_path):
    expected = hashlib.sha256(b'original archived bytes').hexdigest()
    source = tmp_path / (expected + '.mp4')
    source.write_bytes(b'changed after archive')
    with pytest.raises(ValueError, match='바이트'):
        comfy.provenance.materialize_path_input(source, str(tmp_path / 'input'), expected_sha=expected)
    assert not list((tmp_path / 'input').rglob('*.mp4'))
    assert not list((tmp_path / 'input').rglob('*.part'))


def test_execution_metadata_preserves_prompt_but_excludes_credentials():
    snapshot = comfy.provenance.execution_snapshot({"1": {"class_type": "TextPrompt", "inputs": {
        "text": "actual prompt", "api_key": "synthetic-sensitive-value", "url": "https://example.invalid/input?token=synthetic"}}})
    assert snapshot["prompt"] == "actual prompt"
    assert snapshot["params"]["1|api_key"] == "<redacted>"
    assert snapshot["params"]["1|url"] == "https://example.invalid/input"


def test_input_snapshot_cannot_be_served_from_another_account_scope(h, monkeypatch):
    h.successful()
    start_media(h, monkeypatch, b"private-input")
    h.drain()
    evidence = h.rows()[0]["input_evidence"][0]
    _, _, _, _, scope, filename = evidence["file_path"].split("/")
    with comfy._comfy_request_scope(h.request()) as identity:
        assert not Path(evidence["path"]).is_relative_to(comfy.MEDIA_DIR)
        assert comfy.provenance.local_input_path(evidence["file_path"], comfy.MEDIA_DIR, identity.scope) == Path(evidence["path"])
        response = comfy.input_file(scope, filename, h.request())
        assert Path(response.path) == Path(evidence["path"])
    monkeypatch.setattr(comfy.active_account, "_cache", [True, {"email": "different@example.invalid", "uid": None}])
    with pytest.raises(HTTPException) as error:
        comfy.input_file(scope, filename, h.request())
    assert error.value.status_code == 404


def test_provider_only_baked_input_is_explicitly_unverified(h):
    h.successful()
    job_id = comfy.run(request=h.request(), content='{"1":{"class_type":"LoadImage","inputs":{"image":"provider-only.png"}}}',
                       param_values="{}", media_meta="[]", media=[])["job_id"]
    h.drain()
    record = h.rows()[0]
    assert record["input_evidence"] == []
    assert record["comfy_unverified_input_slots"] == [{"node_id": "1", "field": "image", "type": "image"}]
    output = comfy.run_status(job_id, h.request())["outputs"][0]
    saved = comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(**output)]), h.request())["saved"][0]
    generation = repo.get_generation(saved["generation_id"])
    assert generation["references"] == []
    assert generation["params"]["comfy_unverified_input_slots"] == record["comfy_unverified_input_slots"]
