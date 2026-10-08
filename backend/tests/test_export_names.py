"""저장 파일의 번호 이름과 렌더 폴더 장부(설계: docs/EXPORT_SYNC_DESIGN.md §6).

여기서 고정하는 규칙:
- 이름은 <폴더 마디 전부>_<토큰>_<번호 3자리 이상>. 토큰이 다르면 번호도 따로 센다.
- 생성물은 번호를 하나만, 번호는 생성물을 하나만 갖는다 — 두 PC 가 동시에 배정해도 하나로 모인다.
- 한 번 쓴 번호는 다시 쓰지 않는다. 장부에 없더라도 폴더에 이미 있는 번호는 건너뛴다.
- 읽지 못했거나 서로 어긋난 장부는 '없음'이 아니라 오류다(번호를 새로 주지 않는다).
- 확정은 덮어쓰지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import export_names
from app.services.export_names import NameBook, RegistryError


def book(render: Path, token: str = "fin", folder: str = "e020/c0010") -> NameBook:
    return NameBook(render, folder, token)


def dest_dir(render: Path) -> Path:
    return render / "e020" / "c0010"


def test_name_shape_and_parsing():
    assert export_names.name_base("e020\\c0010/") == "e020_c0010"
    assert export_names.numbered_name("e020_c0010", "share", 1, ".mp4") == "e020_c0010_share_001.mp4"
    assert export_names.numbered_name("e020_c0010", "fin", 1000, ".png") == "e020_c0010_fin_1000.png"  # 999 다음은 네 자리
    assert export_names.parse_numbered("e020_c0010_fin_001.mp4") == ("e020_c0010", "fin", 1)
    assert export_names.parse_numbered("v1.2_c0010_davinci_012") == ("v1.2_c0010", "davinci", 12)  # 폴더 이름의 점은 확장자가 아니다
    for other in ("c0010_6e5c7b95-63c.mp4", "e020_c0010_00.mp4", "e020_c0010_fin_01.mp4", "e020_c0010_fin_001.mp4.ab12.part"):
        assert export_names.parse_numbered(other) is None  # 옛 저장 이름 · 옛 다빈치 이름 · 두 자리 · 저장 중 임시 파일


def test_numbers_go_up_per_token_and_a_generation_keeps_its_number(tmp_path):
    fin = book(tmp_path)
    assert fin.name_of("gen-a") is None  # 조회는 번호를 만들지 않는다
    assert not (tmp_path / export_names.SYNC_DIR).exists()
    assert fin.allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_001.mp4"
    assert fin.allocate("gen-b", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_002.mp4"
    assert fin.allocate("gen-a", ".mov", dest_dir(tmp_path)) == "e020_c0010_fin_001.mp4"  # 번호도 확장자도 처음 배정한 그대로
    assert book(tmp_path, "share").allocate("gen-a", ".mp4", dest_dir(tmp_path) / "shared") == "e020_c0010_share_001.mp4"
    assert book(tmp_path, "davinci").allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_davinci_001.mp4"
    assert book(tmp_path, folder="E020/C0010").name_of("gen-b") == "e020_c0010_fin_002.mp4"  # 폴더 대소문자는 같은 장부
    assert book(tmp_path, folder="e020/c0020").name_of("gen-a") is None  # 다른 컷은 다른 장부


def test_two_pcs_allocating_the_same_generation_end_on_one_name(tmp_path):
    first, second = book(tmp_path), book(tmp_path)  # 둘 다 빈 장부를 읽은 상태
    assert first.allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_001.mp4"
    assert second.allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_001.mp4"
    third = book(tmp_path)
    assert first.allocate("gen-b", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_002.mp4"
    assert third.allocate("gen-c", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_003.mp4"  # 낡은 장부로도 남의 번호를 못 가져간다


def test_losing_the_race_for_the_generation_record_uses_the_winner(tmp_path):
    loser = book(tmp_path)
    real = NameBook._publish

    def other_pc_first(self, entry, payload):
        if self is loser and entry.startswith("g."):  # 내가 번호를 잡고 생성물 기록을 쓰기 직전에 다른 PC 가 같은 생성물을 끝냈다
            assert book(tmp_path).allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_002.mp4"
        return real(self, entry, payload)

    NameBook._publish = other_pc_first
    try:
        assert loser.allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_002.mp4"  # 이긴 쪽 이름
    finally:
        NameBook._publish = real
    assert book(tmp_path).allocate("gen-b", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_003.mp4"  # 진 쪽의 001 은 결번


def test_numbers_on_disk_are_skipped_even_without_a_registry(tmp_path):
    folder = dest_dir(tmp_path)
    folder.mkdir(parents=True)
    (folder / "e020_c0010_fin_007.mov").write_bytes(b"x")       # 장부를 잃은 뒤 남은 파일
    (folder / "e020_c0010_davinci_020.mp4").write_bytes(b"x")   # 다른 토큰은 세지 않는다
    (folder / "e020_c0010_00.mp4").write_bytes(b"x")            # 옛 다빈치 이름도 세지 않는다
    assert book(tmp_path).allocate("gen-a", ".mp4", folder) == "e020_c0010_fin_008.mp4"


def test_done_mark_is_tied_to_the_owner(tmp_path):
    fin = book(tmp_path)
    fin.allocate("gen-a", ".mp4", dest_dir(tmp_path))
    assert not fin.is_done("gen-a")
    fin.mark_done("gen-a")
    fin.mark_done("gen-a")  # 다시 적어도 그대로
    assert book(tmp_path).is_done("gen-a") and not book(tmp_path).is_done("gen-b")
    with pytest.raises(RegistryError):
        fin.mark_done("gen-never-allocated")


@pytest.mark.parametrize("damage", ["owner_gone", "done_without_owner", "broken_json", "foreign_name", "other_folder", "done_of_another", "record_of_another", "record_misfiled"])
def test_inconsistent_registry_stops_instead_of_reallocating(tmp_path, damage):
    fin = book(tmp_path)
    fin.allocate("gen-a", ".mp4", dest_dir(tmp_path))
    fin.mark_done("gen-a")
    owner = fin.dir / "n.fin.001"
    if damage == "owner_gone":            # g·d 만 남았다 — 이 번호를 남에게 주면 한 이름에 두 생성물이 놓인다
        owner.unlink()
    elif damage == "done_without_owner":  # d 만 남았다
        owner.unlink()
        next(fin.dir.glob("g.fin.*")).unlink()
    elif damage == "broken_json":
        owner.write_text("{", encoding="utf-8")
    elif damage == "foreign_name":        # 장부의 이름도 바깥에서 온 값이다
        owner.write_text(json.dumps({"gen": "gen-a", "name": "../evil_fin_001.mp4", "folder": fin.key}), encoding="utf-8")
    elif damage == "other_folder":
        owner.write_text(json.dumps({"gen": "gen-a", "name": "e020_c0010_fin_001.mp4", "folder": "e020/c0099"}), encoding="utf-8")
    elif damage == "done_of_another":     # 확정 표식이 다른 생성물의 것이다 — 번호의 주인과 맞지 않는다
        (fin.dir / "d.fin.001").write_text(json.dumps({"gen": "gen-b", "name": "e020_c0010_fin_001.mp4", "folder": fin.key}), encoding="utf-8")
    elif damage == "record_of_another":   # 생성물 기록이 남의 번호를 가리킨다
        fin.allocate("gen-b", ".mp4", dest_dir(tmp_path))
        record = fin.dir / ("g.fin." + export_names._gen_file("gen-a"))
        record.write_text(json.dumps({"gen": "gen-a", "seq": 2, "name": "e020_c0010_fin_002.mp4", "folder": fin.key}), encoding="utf-8")
    else:                                  # 생성물 기록의 파일 이름(해시)이 그 생성물의 것이 아니다
        record = fin.dir / ("g.fin." + export_names._gen_file("gen-a"))
        record.rename(fin.dir / ("g.fin." + export_names._gen_file("gen-zzz")))
    with pytest.raises(RegistryError):
        book(tmp_path)


def test_unreadable_folder_is_an_error_not_an_empty_registry(tmp_path, monkeypatch):
    fin = book(tmp_path)

    def denied(self):
        raise PermissionError("NAS 가 끊겼다")

    monkeypatch.setattr(Path, "iterdir", denied)
    with pytest.raises(RegistryError):
        fin.reload()
    with pytest.raises(RegistryError):
        export_names.disk_numbers(dest_dir(tmp_path), "e020_c0010", "fin")


def test_commit_never_overwrites(tmp_path):
    dest, tmp = tmp_path / "clip.mp4", tmp_path / "clip.mp4.part"
    dest.write_bytes(b"first")
    tmp.write_bytes(b"second")
    with pytest.raises(FileExistsError):
        export_names.commit_new(tmp, dest)
    assert dest.read_bytes() == b"first" and tmp.read_bytes() == b"second"
    fresh = tmp_path / "fresh.mp4"
    export_names.commit_new(tmp, fresh)
    assert fresh.read_bytes() == b"second" and not tmp.exists()


def test_a_lost_answer_counts_as_written_only_when_the_entry_really_matches(tmp_path, monkeypatch):
    """이름 바꾸기는 됐는데 응답이 끊겼다 — 다시 읽어 내가 쓴 그대로면 성공, 아니면 멈춘다(다음 번호로 넘어가지 않는다)."""
    real = export_names.commit_new

    def done_but_answer_lost(tmp, dest):
        real(tmp, dest)
        raise OSError("연결이 끊겼습니다")

    monkeypatch.setattr(export_names, "commit_new", done_but_answer_lost)
    assert book(tmp_path).allocate("gen-a", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_001.mp4"

    def never_written(tmp, dest):
        raise OSError("연결이 끊겼습니다")

    monkeypatch.setattr(export_names, "commit_new", never_written)
    with pytest.raises(RegistryError):
        book(tmp_path).allocate("gen-b", ".mp4", dest_dir(tmp_path))
    monkeypatch.setattr(export_names, "commit_new", real)
    assert book(tmp_path).allocate("gen-b", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_002.mp4"  # 끊긴 시도는 번호를 남기지 않았다


def test_a_stale_book_jumps_past_everything_taken_since(tmp_path, monkeypatch):
    """낡은 장부를 든 채 다른 PC 가 번호를 많이 가져갔다 — 하나씩 더듬다 한도에 걸리지 않고 마지막 번호 다음으로 건너뛴다."""
    stale = book(tmp_path)
    other = book(tmp_path)
    for i in range(8):
        other.allocate(f"gen-{i}", ".mp4", dest_dir(tmp_path))
    monkeypatch.setattr(export_names, "_MAX_PROBES", 3)
    assert stale.allocate("gen-new", ".mp4", dest_dir(tmp_path)) == "e020_c0010_fin_009.mp4"
