"""파일 이름 v2 — `<프로젝트>_<폴더 마디>_<종류>_<작업자>_<번호>` 와 그 장부(설계: docs/EXPORT_SYNC_DESIGN.md §7).

여기서 고정하는 규칙:
- 번호는 '컷 폴더 × 작업자' 한 줄에서 이름을 처음 받은 순서. 종류(work·share·fin·davinci)와 무관하게 생성물마다 하나다.
- 프로젝트·작업자 이름·확장자는 처음 배정할 때의 것으로 굳는다.
- 열쇠 후보(job_id·id) 가운데 하나라도 맞으면 같은 배정이다. 프로젝트 id 가 다르면 다른 배정이다.
- 두 PC 가 동시에 배정해도 하나로 모인다. 한 번 쓴 번호는 다시 쓰지 않고, 폴더에 이미 있는 번호는 건너뛴다.
- 읽지 못했거나 서로 어긋난 장부는 '없음'이 아니라 오류다.
- 어느 것이 종류인지 가릴 수 없는 이름은 저장본으로 보지 않는다(미러가 건드리지 않는다).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import export_names
from app.services.export_names import Ident, NameBook2, RegistryError

FOLDER = "e035/C0050"


def ident(gen: str, worker: str | None = "리버", *, job: str | None = None, pid: str = "p1", project: str = "뻘뻘뻘") -> Ident:
    return Ident(pid, project, job, gen, worker)


def book(render: Path, folder: str = FOLDER) -> NameBook2:
    return NameBook2(render, folder)


def dirs(render: Path) -> list[Path]:
    cut = render / "e035" / "C0050"
    return [cut, cut / "shared"]


def test_name_shape_and_cleaning():
    assert export_names.v2_name("뻘뻘뻘", "e035_C0050", "share", "리버", "001", ".mp4") == "뻘뻘뻘_e035_C0050_share_리버_001.mp4"
    assert export_names.v2_name("", "", "work", "리버", "001", ".png") == "work_리버_001.png"  # 프로젝트·폴더가 없으면 그 부분을 뺀다
    assert export_names.clean_part('  A/B: "C"?  ', 24) == "A_B_C"  # 금지 문자·공백은 '_', 연속은 하나, 앞뒤는 뗀다
    assert export_names.clean_part("x" * 40, 24) == "x" * 24
    assert Ident("p", "프로 젝트", None, "g", None).worker == "noname"  # 이름이 없는 작업자
    assert Ident("p", "프로 젝트", None, "g", " . ").worker == "noname"
    assert Ident("p", "프로 젝트", "job", "gen", "리버").keys == ("job", "gen")  # 열쇠 후보 — job_id 먼저
    assert Ident("p", "프로 젝트", "same", "same", "리버").keys == ("same",)
    assert Ident("p", "프로 젝트", None, "g", "리버").project == "프로_젝트"


def test_names_old_versions_or_windows_would_misread_are_avoided(tmp_path):
    """Codex 통합 검토(2026-10-13) — 이름이 옛 판·Windows 에서 다른 뜻으로 읽히지 않게.
    P1: 작업자 이름이 종류 글자(`fin`)면 10-08 판(§6)이 `…_share_fin_001` 을 자기 저장본 `…_fin_001` 로 읽어 미러가 치울 수 있다.
    P2: 프로젝트 이름의 점 앞이 장치 이름(`CON.x`)이면 파일 이름 전체가 장치를 가리킨다."""
    names = book(tmp_path)
    for gen, worker in (("gen-a", "fin"), ("gen-b", "share"), ("gen-c", "davinci"), ("gen-d", "work")):
        name = names.allocate(ident(gen, worker), "share", ".mp4", dirs(tmp_path))
        assert name.split("_")[-2] == worker.capitalize()
        assert export_names.parse_numbered(name) is None  # §6 의 읽기로는 번호 이름이 아니다
        assert export_names.parse_v2(name, FOLDER) == ("share", 1)
    assert names.allocate(ident("gen-e", "Fin"), "share", ".mp4", dirs(tmp_path)).endswith("_share_Fin_002.mp4")  # 같은 줄(대소문자 무시)
    assert export_names.clean_part("CON.final", 24) == "CON_.final"
    assert export_names.clean_part("lpt1.x", 24) == "lpt1_.x"
    assert export_names.clean_part("CONTEST.x", 24) == "CONTEST.x"  # 장치 이름 그 자체일 때만
    assert export_names.clean_part("lee.jaelyun", 16) == "lee.jaelyun"  # 이메일 앞부분의 점은 그대로


def test_a_path_too_long_for_windows_takes_no_number(tmp_path):
    """Codex 통합 검토 P2(2026-10-13) — 전체 경로가 260자를 넘으면 LongPathsEnabled 가 꺼진 PC·다빈치가 못 연다. 번호를 쥐기 전에 멈춘다."""
    deep = tmp_path / ("d" * 120) / ("e" * 60)
    with pytest.raises(RegistryError, match="저장 경로가 너무 깁니다"):
        book(tmp_path).allocate(ident("gen-a"), "share", ".mp4", [deep, deep / "shared"])
    assert not any((tmp_path / export_names.SYNC_DIR).rglob("n.*"))  # 번호를 쥐지 않았다
    assert book(tmp_path).allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_001.mp4")  # 짧은 곳은 그대로


def test_number_follows_the_worker_line_and_stays_across_kinds(tmp_path):
    names = book(tmp_path)
    a, b, other = ident("gen-a"), ident("gen-b"), ident("gen-c", "제이")
    assert names.name_of(a, "share") is None  # 조회는 번호를 만들지 않는다
    assert not (tmp_path / export_names.SYNC_DIR).exists()
    assert names.allocate(a, "work", ".mp4", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_work_리버_001.mp4"
    assert names.allocate(b, "share", ".mp4", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_share_리버_002.mp4"
    assert names.allocate(other, "fin", ".mp4", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_fin_제이_001.mp4"  # 작업자마다 따로 센다
    # 상태가 바뀌어도 번호는 그대로 — 종류만 바뀐다
    assert names.allocate(a, "share", ".mov", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_share_리버_001.mp4"  # 확장자도 처음 것
    assert names.name_of(a, "fin") == "뻘뻘뻘_e035_C0050_fin_리버_001.mp4"
    assert names.name_of(a, "davinci") == "뻘뻘뻘_e035_C0050_davinci_리버_001.mp4"
    assert book(tmp_path, "E035/c0050").name_of(b, "share") == "뻘뻘뻘_e035_C0050_share_리버_002.mp4"  # 폴더 대소문자는 같은 장부
    assert book(tmp_path, "e035/C0060").name_of(a, "share") is None  # 다른 컷은 다른 장부
    assert not (tmp_path / export_names.SYNC_DIR / export_names.NAMES_DIR).exists()  # v1 장부는 건드리지 않는다


def test_names_are_frozen_when_the_project_or_worker_is_renamed(tmp_path):
    names = book(tmp_path)
    names.allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path))
    renamed = ident("gen-a", "River", project="새 이름")
    assert book(tmp_path).name_of(renamed, "share") == "뻘뻘뻘_e035_C0050_share_리버_001.mp4"  # 그 생성물의 이름은 그대로
    assert book(tmp_path).allocate(ident("gen-z", "River", project="새 이름"), "share", ".mp4", dirs(tmp_path)) == "새_이름_e035_C0050_share_River_001.mp4"


def test_same_label_shares_one_line_and_case_does_not_split_it(tmp_path):
    names = book(tmp_path)
    assert names.allocate(ident("gen-a", "Kim"), "share", ".mp4", dirs(tmp_path)).endswith("_Kim_001.mp4")
    assert names.allocate(ident("gen-b", "kim"), "share", ".mp4", dirs(tmp_path)).endswith("_kim_002.mp4")  # 동명이인은 한 줄


def test_any_known_key_finds_the_assignment_and_new_keys_are_linked(tmp_path):
    names = book(tmp_path)
    first = names.allocate(ident("local-id"), "work", ".mp4", dirs(tmp_path))  # 만든 PC — job_id 가 아직 없다
    later = ident("local-id", job="job-9")  # job_id 가 나중에 채워졌다
    assert book(tmp_path).name_of(later, "work") == first
    assert book(tmp_path).allocate(later, "work", ".mp4", dirs(tmp_path)) == first  # 새 번호를 만들지 않고, job_id 로도 찾게 잇는다
    received = ident("server-uuid", job="job-9")  # 공유로 건너간 쪽 — id 는 다르고 job_id 가 같다
    assert book(tmp_path).name_of(received, "share") == "뻘뻘뻘_e035_C0050_share_리버_001.mp4"
    assert book(tmp_path).allocate(ident("gen-b"), "work", ".mp4", dirs(tmp_path)).endswith("_002.mp4")


def test_another_project_in_the_same_folder_gets_its_own_assignment(tmp_path):
    names = book(tmp_path)
    assert names.allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_리버_001.mp4")
    moved = ident("gen-a", pid="p2", project="다른")
    assert names.name_of(moved, "share") is None  # 같은 생성물이어도 프로젝트가 다르면 옛 배정을 받지 않는다
    assert names.allocate(moved, "share", ".mp4", dirs(tmp_path)) == "다른_e035_C0050_share_리버_002.mp4"  # 번호 줄은 작업자가 같이 쓴다


def test_two_pcs_allocating_the_same_generation_end_on_one_name(tmp_path):
    first, second = book(tmp_path), book(tmp_path)  # 둘 다 빈 장부를 읽은 상태
    assert first.allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_001.mp4")
    assert second.allocate(ident("gen-a"), "fin", ".mp4", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_fin_리버_001.mp4"
    third = book(tmp_path)
    assert first.allocate(ident("gen-b"), "share", ".mp4", dirs(tmp_path)).endswith("_002.mp4")
    assert third.allocate(ident("gen-c"), "share", ".mp4", dirs(tmp_path)).endswith("_003.mp4")  # 낡은 장부로도 남의 번호를 못 가져간다


def test_losing_the_race_for_the_generation_record_uses_the_winner(tmp_path):
    loser = book(tmp_path)
    real = NameBook2._publish

    def other_pc_first(self, entry, payload):
        if self is loser and entry.startswith("g."):  # 내가 번호를 잡고 생성물 기록을 쓰기 직전에 다른 PC 가 같은 생성물을 끝냈다
            assert book(tmp_path).allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_002.mp4")
        return real(self, entry, payload)

    NameBook2._publish = other_pc_first
    try:
        assert loser.allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_002.mp4")  # 이긴 쪽 번호 — 내 001 은 결번
    finally:
        NameBook2._publish = real
    assert book(tmp_path).allocate(ident("gen-b"), "share", ".mp4", dirs(tmp_path)).endswith("_003.mp4")  # 결번은 다시 쓰지 않는다


def test_numbers_already_on_disk_are_skipped_whatever_the_kind(tmp_path):
    cut, shared = dirs(tmp_path)
    shared.mkdir(parents=True)
    (cut / "뻘뻘뻘_e035_C0050_fin_리버_004.mp4").write_bytes(b"x")  # 장부를 잃었는데 파일은 남아 있다
    (shared / "뻘뻘뻘_E035_c0050_share_리버_007.mp4").write_bytes(b"x")  # 대소문자가 달라도 같은 이름이다
    (cut / "뻘뻘뻘_e035_C0050_davinci_제이_020.mp4").write_bytes(b"x")  # 다른 작업자의 줄
    (cut / "e035_C0050_fin_009.mp4").write_bytes(b"x")  # v1 이름은 v2 번호와 무관하다
    assert book(tmp_path).allocate(ident("gen-a"), "work", ".mp4", [cut, shared]).endswith("_리버_008.mp4")
    assert book(tmp_path).allocate(ident("gen-b", "제이"), "work", ".mp4", [cut, shared]).endswith("_제이_021.mp4")


def test_the_destination_folders_are_listed_once_per_worker_line(tmp_path, monkeypatch):
    """파일마다 대상 폴더를 다시 훑지 않는다 — 장부 하나(저장·전송 한 번)에 작업자 줄마다 한 번. 다음 요청의 새 장부는 다시 훑는다."""
    cut, shared = dirs(tmp_path)
    shared.mkdir(parents=True)
    (cut / "뻘뻘뻘_e035_C0050_fin_리버_004.mp4").write_bytes(b"x")  # 장부에 없는 파일
    listed = []
    real = export_names.disk_numbers2

    def counting(folders, project, base, worker):
        listed.append(worker)
        return real(folders, project, base, worker)

    monkeypatch.setattr(export_names, "disk_numbers2", counting)
    names = book(tmp_path)
    assert [names.allocate(ident(f"gen-{i}"), "share", ".mp4", [cut, shared])[-8:] for i in range(3)] == ["_005.mp4", "_006.mp4", "_007.mp4"]
    assert names.allocate(ident("gen-j", "제이"), "work", ".mp4", [cut, shared]).endswith("_제이_001.mp4")
    assert listed == ["리버", "제이"]
    (shared / "뻘뻘뻘_e035_C0050_share_리버_030.mp4").write_bytes(b"x")  # 훑은 뒤에 장부 없이 놓인 파일 — 든 장부는 모르고, 새 장부가 건너뛴다
    assert book(tmp_path).allocate(ident("gen-new"), "work", ".mp4", [cut, shared]).endswith("_리버_031.mp4")


def test_done_marks_are_per_kind(tmp_path):
    names = book(tmp_path)
    a = ident("gen-a")
    with pytest.raises(RegistryError):
        names.mark_done(a, "share")  # 배정되지 않은 생성물
    names.allocate(a, "share", ".mp4", dirs(tmp_path))
    assert not names.is_done(a, "share")
    names.mark_done(a, "share")
    names.mark_done(a, "share")  # 두 번 적어도 같은 뜻
    assert names.is_done(a, "share") and not names.is_done(a, "fin") and not names.is_done(a, "davinci")
    fresh = book(tmp_path)
    assert fresh.is_done(ident("other-id", job="gen-a"), "share")  # 다른 PC 도, 별칭으로도 본다
    fresh.mark_done(a, "davinci")
    assert book(tmp_path).is_done(a, "davinci")


def test_a_broken_or_inconsistent_ledger_is_an_error_not_an_empty_one(tmp_path):
    names = book(tmp_path)
    a = ident("gen-a")
    names.allocate(a, "share", ".mp4", dirs(tmp_path))
    names.mark_done(a, "share")
    folder = names.dir
    entries = {entry.name.split(".")[0]: entry for entry in folder.iterdir()}

    saved = entries["g"].read_text(encoding="utf-8")
    entries["g"].write_text("{not json", encoding="utf-8")
    with pytest.raises(RegistryError):
        book(tmp_path)
    entries["g"].write_text(json.dumps({**json.loads(saved), "seq": 2}), encoding="utf-8")  # n 과 번호가 다르다
    with pytest.raises(RegistryError):
        book(tmp_path)
    entries["g"].write_text(saved, encoding="utf-8")

    mark = entries["d"].read_text(encoding="utf-8")
    entries["d"].write_text(json.dumps({**json.loads(mark), "name": "남의_이름_share_리버_001.mp4"}), encoding="utf-8")
    with pytest.raises(RegistryError):
        book(tmp_path)
    entries["d"].write_text(mark, encoding="utf-8")

    owner = entries["n"].read_text(encoding="utf-8")
    entries["n"].unlink()  # 번호의 주인을 잃었다 — 생성물 기록만으로 번호를 믿지 않는다
    with pytest.raises(RegistryError):
        book(tmp_path)
    entries["n"].write_text(owner, encoding="utf-8")
    (folder / "n.zzz").write_text("{}", encoding="utf-8")  # 꼴이 다른 항목
    with pytest.raises(RegistryError):
        book(tmp_path)
    (folder / "n.zzz").unlink()
    line = entries["n"].name.split(".")[1]
    for target in (1, 9):  # 이어진 번호(r)가 제자리로 돌아오거나 없는 번호를 가리킨다
        (folder / f"r.{line}.001").write_text(json.dumps({"line": line, "seq": target, "folder": names.key}), encoding="utf-8")
        with pytest.raises(RegistryError):
            book(tmp_path)
    (folder / f"r.{line}.001").unlink()
    (folder / ".abc.tmp").write_text("쓰는 중", encoding="utf-8")  # 다른 PC 가 쓰는 중인 임시 파일은 건너뛴다
    assert book(tmp_path).name_of(a, "share").endswith("_001.mp4")


def test_an_unreadable_destination_folder_stops_allocation(tmp_path, monkeypatch):
    names = book(tmp_path)
    cut = dirs(tmp_path)[0]
    cut.mkdir(parents=True)
    real = Path.iterdir

    def broken(self):
        if self == cut:
            raise PermissionError("NAS 가 끊겼다")
        return real(self)

    monkeypatch.setattr(Path, "iterdir", broken)
    with pytest.raises(RegistryError):
        names.allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path))  # 폴더를 못 읽은 채 번호를 주지 않는다
    monkeypatch.setattr(Path, "iterdir", real)
    assert book(tmp_path).allocate(ident("gen-a"), "share", ".mp4", dirs(tmp_path)).endswith("_001.mp4")


def test_long_names_are_shortened_and_an_impossible_one_is_refused(tmp_path):
    long_folder = "ep" + "x" * 60 + "/cut" + "y" * 50
    names = book(tmp_path, long_folder)
    name = names.allocate(ident("gen-a", "작업자" * 5, project="프로젝트" * 6), "davinci", ".mp4", [])
    assert len(name) <= export_names.NAME_MAX and name.endswith("_001.mp4") and "_davinci_" in name
    with pytest.raises(RegistryError):
        book(tmp_path, "a" * 100 + "/" + "b" * 60).allocate(ident("gen-a"), "share", ".mp4", [])  # 폴더 이름만으로 넘는다
    temp = export_names.temp_name(ident("gen-a"), "a" * 100 + "/" + "b" * 60, "work", ".mp4")
    assert len(temp) <= export_names.NAME_MAX and "_work_" in temp  # 임시 이름은 실패하지 않는다


def test_temp_name_has_the_same_shape_and_is_never_recorded(tmp_path):
    a = ident("gen-a", job="job-1")
    name = export_names.temp_name(a, FOLDER, "work", ".mp4")
    assert name.startswith("뻘뻘뻘_e035_C0050_work_리버_x") and name.endswith(".mp4") and len(name.rsplit("_", 1)[1]) == len("x12345678.mp4")
    assert export_names.temp_name(a, FOLDER, "work", ".mp4") == name  # 같은 생성물은 같은 임시 이름
    assert export_names.temp_name(ident("id-on-another-pc", job="job-1"), FOLDER, "work", ".mp4") == name  # PC 마다 id 가 달라도(공통 열쇠로 센다)
    assert export_names.temp_name(ident("gen-b", job="job-2"), FOLDER, "work", ".mp4") != name
    assert export_names.temp_name(ident("g", None, pid="", project=""), "", "work", ".png").startswith("work_noname_x")
    assert not (tmp_path / export_names.SYNC_DIR).exists()


def test_only_unambiguous_saved_names_are_recognised():
    parse = export_names.parse_v2_saved
    assert parse("뻘뻘뻘_e035_C0050_share_리버_001.mp4", FOLDER) == ("share", 1)
    assert parse("뻘뻘뻘_E035_c0050_fin_리버_1000.mp4", FOLDER) == ("fin", 1000)  # 대소문자 무시 · 네 자리 번호
    assert parse("e035_C0050_fin_리버_002.mp4", FOLDER) == ("fin", 2)  # 프로젝트 이름이 없는 것
    assert parse("뻘뻘뻘_e035_C0050_share_kim_fin_003.mp4", FOLDER) == ("share", 3)  # 작업자 이름의 끝이 fin 인 것은 가릴 수 있다
    # 종류 글자가 이름에 여러 번 나와도 **폴더 마디 바로 뒤의 것**이 종류다 — 작업자·프로젝트·폴더 이름에 같은 글자가 있어도 읽힌다
    assert parse("뻘뻘뻘_e035_C0050_share_fin_kim_fin_001.mp4", FOLDER) == ("share", 1)  # 작업자 `fin_kim_fin`
    assert parse("work_fin_e035_C0050_fin_리버_004.mp4", FOLDER) == ("fin", 4)  # 프로젝트 `work_fin`
    assert parse("P_ep_work_c1_fin_kim_005.mp4", "ep/work/c1") == ("fin", 5)  # 폴더 이름이 `work`
    for other in (
        "뻘뻘뻘_e035_C0050_work_리버_001.mp4",  # 작업물 — 렌더 폴더의 저장본이 아니다
        "뻘뻘뻘_e035_C0050_davinci_리버_001.mp4",  # 다빈치 파일 — 저장본이 아니다
        "뻘뻘뻘_e035_C0050_davinci_fin_001.mp4",  # 작업자 이름이 `fin` 인 다빈치 파일
        "뻘뻘뻘_e035_C0050_fin_e035_C0050_share_kim_001.mp4",  # 폴더 마디 뒤의 종류가 둘 — 어느 것이 종류인지 모른다
        "뻘뻘뻘_e035_C0060_share_리버_001.mp4",  # 다른 컷의 이름
        "e035_C0050_share_001.mp4",  # v1 이름(작업자 자리가 없다)
        "뻘뻘뻘_e035_C0050_share_리버_01.mp4",  # 두 자리
        "뻘뻘뻘_e035_C0050_share_리버_001.mp4.ab12.part",  # 저장 중 임시 파일
        "c0050_6e5c7b95-63c.mp4",  # 옛 이름
    ):
        assert parse(other, FOLDER) is None, other
    assert parse("share_리버_001.mp4", "") == ("share", 1)  # 폴더가 없는 이름(맨 앞이 종류)


def test_saved_shape_lets_the_v2_reading_decide_before_the_old_one():
    shape = export_names.saved_shape
    assert shape("뻘뻘뻘_e035_C0050_fin_리버_001.mp4", FOLDER) and shape("e035_C0050_share_001.mp4", FOLDER)  # v2 저장본 · §6 번호 이름
    assert shape("ep_work_c1_fin_001.mp4", "ep/work/c1")  # §6 이름 — 폴더 이름이 `work` 여도 저장본이다
    # 작업자 이름이 `fin` 인 다빈치 파일·작업물은 §6 꼴(`…_fin_001`)로도 읽히지만 저장본이 아니다 — v2 로 읽힌 종류가 정한다
    assert not shape("뻘뻘뻘_e035_C0050_davinci_fin_001.mp4", FOLDER) and not shape("뻘뻘뻘_e035_C0050_work_fin_001.mp4", FOLDER)
    assert not shape("e035_C0050_davinci_001.mp4", FOLDER) and not shape("c0050_6e5c7b95-63c.mp4", FOLDER) and not shape("메모.png", FOLDER)
    # v2 로 읽는 방법이 둘이라 가릴 수 없는 이름은 §6 으로 다시 읽지 않는다(끝이 `…_fin_001` 이어도 저장본 꼴이 아니다)
    assert not shape("뻘뻘뻘_e035_C0050_fin_e035_C0050_davinci_fin_001.mp4", FOLDER)


def test_a_pc_that_knows_more_keys_cannot_split_one_generation(tmp_path):
    """같은 생성물을 한 PC 는 id 로만, 다른 PC 는 job_id·id 로 **동시에** 배정해도 번호는 하나다(적는 순서 = id 먼저 — Codex 코드 리뷰)."""
    knows_id, knows_both = book(tmp_path), book(tmp_path)  # 둘 다 빈 장부를 읽은 상태
    real = NameBook2._publish
    met = []

    def interleave(self, entry, payload):
        if self is knows_both and entry.startswith("g.") and not met:  # 번호를 잡고 첫 기록을 적기 직전에 다른 PC 가 끝낸다
            met.append(knows_id.allocate(ident("local"), "share", ".mp4", dirs(tmp_path)))
        return real(self, entry, payload)

    NameBook2._publish = interleave
    try:
        mine = knows_both.allocate(ident("local", job="job-9"), "share", ".mp4", dirs(tmp_path))
    finally:
        NameBook2._publish = real
    assert met == [mine]  # 두 PC 가 같은 이름으로 끝난다(어느 번호인지는 누가 먼저 적었느냐에 달렸다 — 진 쪽 번호는 결번)
    received = ident("server-uuid", job="job-9")  # job_id 만 같은 PC 도 같은 번호를 본다
    assert book(tmp_path).name_of(received, "share") == mine and book(tmp_path).name_of(ident("local"), "share") == mine


def test_pcs_with_private_ids_meet_on_the_shared_job_id(tmp_path):
    """PC 마다 id 가 다르고 job_id 만 같을 때(받은 생성물) 동시에 배정하면 — 먼저 job_id 를 적은 쪽으로 모이고 진 쪽 번호는 결번이다."""
    first, second = book(tmp_path), book(tmp_path)
    real = NameBook2._publish
    met = []

    def interleave(self, entry, payload):
        if self is second and entry.startswith("g.") and not met:
            met.append(first.allocate(ident("id-on-pc-1", job="job-9"), "share", ".mp4", dirs(tmp_path)))
        return real(self, entry, payload)

    NameBook2._publish = interleave
    try:
        mine = second.allocate(ident("id-on-pc-2", job="job-9"), "share", ".mp4", dirs(tmp_path))
    finally:
        NameBook2._publish = real
    assert met == [mine] and mine.endswith("_002.mp4")  # 001 은 진 쪽이 쥐었던 번호 — 결번
    for someone in ("id-on-pc-1", "id-on-pc-2", "id-on-pc-3"):  # 진 PC 자신도, 처음 보는 PC 도 job_id 로 같은 번호를 찾는다
        assert book(tmp_path).name_of(ident(someone, job="job-9"), "fin") == mine.replace("_share_", "_fin_")
    # 진 PC 의 id **만** 아는 쪽(job_id 를 안 주는 옛 서버 등)도 진 번호 001 이 아니라 이긴 번호에 닿는다 — 001 은 002 로 이어져 있다
    for alone in ("id-on-pc-1", "id-on-pc-2"):
        assert book(tmp_path).name_of(Ident("p1", None, None, alone, None, named=False), "share") == mine
    assert book(tmp_path).allocate(ident("gen-b"), "share", ".mp4", dirs(tmp_path)).endswith("_003.mp4")


def test_a_job_id_filled_in_later_joins_the_number_it_already_has_elsewhere(tmp_path):
    """job_id 가 없을 때 id 로 001 을 받았는데, 그사이 job_id 만 아는 다른 PC 가 같은 생성물에 002 를 줬다(서로 알 길이 없었다).
    job_id 가 채워진 뒤에는 찾는 순서대로 002 가 그 생성물의 번호이고, 001 은 002 로 이어진다 — id 만 아는 쪽도 002 를 본다."""
    early = book(tmp_path).allocate(ident("local-id"), "share", ".mp4", dirs(tmp_path))
    other = book(tmp_path).allocate(ident("id-on-another-pc", job="job-9"), "share", ".mp4", dirs(tmp_path))
    assert (early.endswith("_001.mp4"), other.endswith("_002.mp4")) == (True, True)
    book(tmp_path).link(ident("local-id", job="job-9"))  # 이미 저장된 파일을 다시 만났다 — job_id 가 채워져 있다
    assert book(tmp_path).name_of(ident("local-id"), "share") == other
    assert book(tmp_path).name_of(ident("local-id", job="job-9"), "share") == other
    assert len(list(book(tmp_path).dir.glob("r.*"))) == 1
    book(tmp_path).link(ident("local-id", job="job-9"))  # 두 번 이어도 같다
    assert len(list(book(tmp_path).dir.glob("r.*"))) == 1


def test_files_confirmed_under_an_earlier_number_stay_findable_after_the_numbers_are_joined(tmp_path):
    """001 로 공유본을 확정한 뒤 번호가 002 로 이어지면, 뒤에 온 PC 는 지금 이름(…_002)만 보면 이미 있는 공유본을 놓친다 —
    옛 번호로 확정된 파일 이름도 알려 준다. 옛 번호의 확정 표식을 지금 이름의 증거로 쓰지는 않는다(Codex 코드 리뷰)."""
    early, late = ident("local-id"), ident("id-on-another-pc", job="job-9")
    names = book(tmp_path)
    shared_001 = names.allocate(early, "share", ".mp4", dirs(tmp_path))
    names.mark_done(early, "share")
    names.allocate(late, "fin", ".mp4", dirs(tmp_path))
    names.mark_done(late, "fin")
    assert names.older_names(late, "share") == []  # 아직 같은 생성물인 줄 모른다
    book(tmp_path).link(ident("local-id", job="job-9"))
    fresh = book(tmp_path)
    for someone in (late, early, ident("id-on-a-third-pc", job="job-9")):
        assert fresh.name_of(someone, "share").endswith("_share_리버_002.mp4")
        assert fresh.older_names(someone, "share") == [shared_001] and fresh.older_names(someone, "fin") == []
        assert not fresh.is_done(someone, "share") and fresh.is_done(someone, "fin")
    assert fresh.older_names(ident("gen-z"), "share") == []


def test_a_ledger_read_before_another_pc_wrote_is_read_again_before_a_number_is_used(tmp_path):
    """읽어 둔 장부(저장 한 번 동안 들고 쓴다)는 그사이 다른 PC 가 번호를 이은 것을 모른다 — 쓰기 직전에 장부가 바뀌었는지 보고
    다시 읽는다. 안 그러면 id 만 아는 쪽이 옛 번호 이름으로 한 번 더 저장한다(Codex 코드 리뷰)."""
    first = book(tmp_path).allocate(ident("local-id"), "fin", ".mp4", dirs(tmp_path))
    held = book(tmp_path)  # 저장을 시작하며 읽어 둔 장부 — 001 만 안다
    other = book(tmp_path).allocate(ident("id-on-another-pc", job="job-9"), "fin", ".mp4", dirs(tmp_path))
    book(tmp_path).link(ident("local-id", job="job-9"))  # 다른 PC 가 001 을 002 로 이었다
    assert held.name_of(ident("local-id"), "fin") == first  # 조회는 읽어 둔 값 그대로다(다시 읽지 않는다)
    assert held.allocate(ident("local-id"), "fin", ".mp4", dirs(tmp_path)) == other  # 쓰기 직전에는 다시 읽는다
    reads = []
    real = NameBook2.reload
    NameBook2.reload = lambda self: reads.append(1) or real(self)
    try:
        assert held.allocate(ident("local-id"), "fin", ".mp4", dirs(tmp_path)) == other
        assert held.allocate(ident("gen-b"), "fin", ".mp4", dirs(tmp_path)).endswith("_003.mp4")
        assert held.allocate(ident("gen-b"), "share", ".mp4", dirs(tmp_path)).endswith("_003.mp4")
    finally:
        NameBook2.reload = real
    assert reads == []  # 바뀐 것이 없으면(내가 적은 것뿐이면) 다시 읽지 않는다


def test_a_write_that_was_only_recovered_never_hides_what_another_pc_wrote(tmp_path, monkeypatch):
    """응답이 끊겨 '이미 같은 내용이 있으니 성공'으로 친 쓰기는 항목을 늘리지 않았을 수 있다 — 그것을 하나 센 채로 두면, 그사이
    다른 PC 가 적은 항목 하나(번호 잇기)와 수가 맞아떨어져 다시 읽지 않는다(Codex 코드 리뷰)."""
    a = ident("local-id")
    first = book(tmp_path).allocate(a, "fin", ".mp4", dirs(tmp_path))
    other = book(tmp_path).allocate(ident("id-on-another-pc", job="job-9"), "fin", ".mp4", dirs(tmp_path))
    book(tmp_path).mark_done(a, "fin")
    held = book(tmp_path)
    real = export_names.commit_new

    def cut_off(tmp, dest):
        if dest.name.startswith("d."):
            raise OSError("응답이 끊겼다")  # 확정 표식은 전부터 있었다 — 새로 만들어진 것이 없다
        return real(tmp, dest)

    monkeypatch.setattr(export_names, "commit_new", cut_off)
    held.mark_done(a, "fin")
    monkeypatch.setattr(export_names, "commit_new", real)
    book(tmp_path).link(ident("local-id", job="job-9"))  # 다른 PC 가 항목 하나(r)를 적었다
    assert held.name_of(a, "fin") == first and held.allocate(a, "fin", ".mp4", dirs(tmp_path)) == other


def test_link_adds_a_newly_known_key_without_making_a_number(tmp_path):
    first = book(tmp_path).allocate(ident("local-id"), "fin", ".mp4", dirs(tmp_path))
    fresh = book(tmp_path)
    fresh.link(ident("never-named", job="job-0"))  # 배정이 없는 생성물 — 아무것도 만들지 않는다
    assert fresh.name_of(ident("never-named", job="job-0"), "fin") is None
    fresh.link(ident("local-id", job="job-9"))  # 이미 저장된 파일을 다시 만났다 — 그사이 job_id 가 채워졌다
    assert book(tmp_path).name_of(ident("server-uuid", job="job-9"), "fin") == first  # job_id 만 아는 PC 도 같은 번호
    assert book(tmp_path).allocate(ident("gen-b"), "fin", ".mp4", dirs(tmp_path)).endswith("_002.mp4")


def test_a_confirmed_number_is_found_again_when_only_its_generation_record_is_lost(tmp_path):
    names = book(tmp_path)
    kept, unconfirmed = ident("gen-a", job="job-a"), ident("gen-b")
    saved = names.allocate(kept, "share", ".mp4", dirs(tmp_path))
    names.mark_done(kept, "share")
    names.allocate(unconfirmed, "share", ".mp4", dirs(tmp_path))  # 번호만 받고 파일은 확정하지 못했다
    for entry in names.dir.glob("g.*"):
        entry.unlink()  # 생성물 기록(g)만 잃었다 — 번호의 주인(n)과 확정 표식(d)은 남아 있다
    fresh = book(tmp_path)
    assert fresh.name_of(kept, "share") == saved and fresh.is_done(kept, "share")  # 확정된 번호는 그 생성물의 것이다
    assert fresh.name_of(ident("server-uuid", job="job-a"), "share") is None  # 주인으로 적힌 열쇠(id)를 모르면 되찾지 못한다
    assert fresh.allocate(kept, "fin", ".mp4", dirs(tmp_path)) == saved.replace("_share_", "_fin_")  # 새 번호를 주지 않고 기록을 다시 적는다
    assert book(tmp_path).name_of(ident("server-uuid", job="job-a"), "share") == saved
    assert book(tmp_path).allocate(unconfirmed, "share", ".mp4", dirs(tmp_path)).endswith("_003.mp4")  # 확정 안 된 번호는 되찾지 않는다


def test_an_ident_without_name_facts_only_finds_what_exists(tmp_path):
    named = ident("gen-a", job="job-a")
    saved = book(tmp_path).allocate(named, "fin", ".mp4", dirs(tmp_path))
    bare = Ident("p1", None, None, "gen-a", None, named=False)  # 옛 서버의 사실 — 이름 재료가 없다
    assert book(tmp_path).name_of(bare, "fin") == saved and book(tmp_path).allocate(bare, "fin", ".mp4", dirs(tmp_path)) == saved
    with pytest.raises(RegistryError):
        book(tmp_path).allocate(Ident("p1", None, None, "gen-b", None, named=False), "fin", ".mp4", dirs(tmp_path))  # 새 번호는 받지 않는다
    assert len(list(book(tmp_path).dir.glob("n.*"))) == 1


def test_dots_never_make_a_name_the_destination_check_refuses(tmp_path):
    assert export_names.clean_part("P..1", 24) == "P_1" and export_names.clean_part("A...B.c", 24) == "A_B.c"
    assert ".." not in book(tmp_path).allocate(ident("gen-a", "A..B", project="P..1"), "share", ".mp4", dirs(tmp_path))
    odd = book(tmp_path, "ep/c..1")
    with pytest.raises(RegistryError):
        odd.allocate(ident("gen-a"), "share", ".mp4", [])  # 폴더 이름의 `..` 은 못 고친다 — 번호를 쥐기 전에 그만둔다
    assert not odd.dir.exists()


def test_the_number_line_does_not_depend_on_the_extension(tmp_path):
    """이름이 길어 작업자 이름을 줄일 때 확장자 길이에 따라 다르게 줄면 같은 작업자가 두 줄로 갈린다(Codex 코드 리뷰)."""
    folder = "a" * 58 + "/" + "b" * 58
    names = book(tmp_path, folder)
    worker, project = "abcdefghijklmnop", "P" * 24
    first = names.allocate(ident("gen-a", worker, project=project), "share", ".mp4", [])
    second = names.allocate(ident("gen-b", worker, project=project), "share", ".jpeg", [])
    assert first.endswith("_001.mp4") and second.endswith("_002.jpeg")
    assert max(len(first), len(second)) <= export_names.NAME_MAX and first.rsplit("_", 1)[0] == second.rsplit("_", 1)[0]


def test_books_hand_out_one_v2_ledger_per_folder(tmp_path):
    books = export_names.Books(tmp_path)
    assert books.v2(FOLDER) is books.v2("E035/c0050")
    assert books.v2(FOLDER) is not books.v2("e035/C0060")
    assert books.get(FOLDER, "fin").allocate("gen-a", ".mp4", dirs(tmp_path)[0]) == "e035_C0050_fin_001.mp4"  # v1 은 그대로
    assert books.v2(FOLDER).allocate(ident("gen-a"), "fin", ".mp4", dirs(tmp_path)) == "뻘뻘뻘_e035_C0050_fin_리버_001.mp4"
