import hashlib
import json
from pathlib import Path
import sqlite3
import sys

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))
from workroom_materials import apply, plan, walk


def fixture(tmp_path):
    source, runtime = tmp_path / 'source', tmp_path / 'room'
    for root in (source, runtime / 'data'):
        (root / 'db').mkdir(parents=True)
        with sqlite3.connect(root / 'db/content_hub.db') as conn:
            conn.executescript('''
                CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT,render_root_path TEXT);
                CREATE TABLE project_folder_link(project_id TEXT PRIMARY KEY,root_path TEXT,selected_path TEXT,updated_at TEXT);
                INSERT INTO project VALUES('project','Fixture',NULL);
                INSERT INTO project_folder_link VALUES('project','','e001/keep','original');
                CREATE TABLE generation(id TEXT,prompt TEXT);
                INSERT INTO generation VALUES('keep','user work');
            ''')
    render = source / 'project/Render'
    (render / 'e001/c0010').mkdir(parents=True)
    (render / '.hidden').mkdir()
    (render / 'e001/c0010/large.mov').write_bytes(b'not copied')
    with sqlite3.connect(source / 'db/content_hub.db') as conn:
        conn.execute('UPDATE project SET render_root_path=?', (str(render.parent),))
    (source / 'media/.thumb-sources/00').mkdir(parents=True)
    (source / 'media/.thumb-sources/00/image.jpg').write_bytes(b'image fixture')
    (source / 'media/.thumbs').mkdir()
    (source / 'media/.thumbs/old-path-key.jpg').write_bytes(b'derived cache')
    (runtime / '.mvhub-workroom.json').write_text(json.dumps({'version': 1, 'repo': str(REPO)}))
    return source, runtime


def test_additive_copy_keeps_source_and_work_and_is_idempotent(tmp_path):
    source, runtime = fixture(tmp_path)
    before = hashlib.sha256((source / 'db/content_hub.db').read_bytes()).digest()
    result = apply(plan(source, runtime))
    assert result['copied'] == 1 and result['linked_projects'] == 1
    with sqlite3.connect(runtime / 'data/db/content_hub.db') as conn:
        root, selected = conn.execute('SELECT root_path,selected_path FROM project_folder_link').fetchone()
        assert selected == 'e001/keep'
        assert conn.execute('SELECT prompt FROM generation').fetchone()[0] == 'user work'
        assert conn.execute('SELECT render_root_path FROM project').fetchone()[0] is None
    assert Path(root).is_relative_to(runtime)
    assert (Path(root) / 'Render/e001/c0010').is_dir()
    assert not (Path(root) / 'Render/e001/c0010/large.mov').exists()
    assert not (Path(root) / 'Render/.hidden').exists()
    copied = runtime / 'data/media/.thumb-sources/00/image.jpg'
    assert copied.read_bytes() == b'image fixture'
    assert not (runtime / 'data/media/.thumbs').exists()
    copied.write_bytes(b'user edited copy')
    second = apply(plan(source, runtime))
    assert second['copied'] == 0 and second['different_existing'] == 1
    assert copied.read_bytes() == b'user edited copy'
    assert hashlib.sha256((source / 'db/content_hub.db').read_bytes()).digest() == before
    assert (source / 'media/.thumb-sources/00/image.jpg').read_bytes() == b'image fixture'


def test_changed_source_fails_before_publish_and_preserves_links(tmp_path):
    source, runtime = fixture(tmp_path)
    prepared = plan(source, runtime)
    (source / 'media/.thumb-sources/00/image.jpg').write_bytes(b'changed')
    with pytest.raises(RuntimeError, match='원본이 변경'):
        apply(prepared)
    assert not (runtime / 'data/media/.thumb-sources/00/image.jpg').exists()
    with sqlite3.connect(runtime / 'data/db/content_hub.db') as conn:
        assert conn.execute('SELECT root_path FROM project_folder_link').fetchone()[0] == ''


def test_foreign_marker_and_existing_link_preserved(tmp_path):
    source, runtime = fixture(tmp_path)
    with sqlite3.connect(runtime / 'data/db/content_hub.db') as conn:
        conn.execute("UPDATE project_folder_link SET root_path='existing user root'")
    assert plan(source, runtime)['links'] == []
    (runtime / '.mvhub-workroom.json').write_text('{}')
    with pytest.raises(ValueError, match='소유한 시험실'):
        plan(source, runtime)


def test_directory_enumeration_failure_is_not_empty_tree(tmp_path, monkeypatch):
    import workroom_materials
    def denied(_):
        raise PermissionError('fixture')
    monkeypatch.setattr(workroom_materials.os, 'scandir', denied)
    with pytest.raises(PermissionError):
        walk(tmp_path, folders_only=True)


def test_cache_exclusion_only_applies_to_direct_media_cache(tmp_path):
    source, runtime = fixture(tmp_path)
    for directory in [source / 'assets/.thumbs', source / 'media/nested/.thumbs']:
        directory.mkdir(parents=True)
        (directory / 'keep.jpg').write_bytes(b'keep')
    prepared = plan(source, runtime)
    assert len(prepared['files']) == 3
    apply(prepared)
    assert (runtime / 'data/assets/.thumbs/keep.jpg').read_bytes() == b'keep'
    assert (runtime / 'data/media/nested/.thumbs/keep.jpg').read_bytes() == b'keep'


def test_destination_junction_rejected(tmp_path):
    import subprocess
    source, runtime = fixture(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    dest = runtime / 'data/media'
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(dest), str(outside)], capture_output=True)
    assert result.returncode == 0
    try:
        with pytest.raises(ValueError, match='링크 경로'):
            plan(source, runtime)
        assert list(outside.iterdir()) == []
    finally:
        dest.rmdir()
