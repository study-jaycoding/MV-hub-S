"""대시보드 집계를 **한 번만 훑는다** — 그러면서 지금 값·의미를 그대로 지킨다.

★왜(2026-09-12 실측): 관리 창 **기본 탭이 대시보드**이고 요약은 **날짜 없이** 부른다.
 `team_overview()` 는 같은 WHERE 로 팩트 표를 **10번** 훑었다 — 22,392행에서 중앙값 **149.99ms**.
 합성 키(작업자×프로젝트×모델×출력)로 한 번 훑고 파이썬에서 접으면 **56.84ms (2.6배)**.

★폴더는 합성 키에 **넣지 않았다.** 폴더만 카디널리티가 열려 있다 — 생성물마다 다른 경로가 오면
 합성 그룹이 행 수까지 불어난다. 실측: 폴더를 넣으면 그 경우 **247ms → 421ms 로 느려졌고**
 메모리도 41.2MB 였다. 빼니 **249.81 → 140.45ms (1.8배)**, 16.1MB. 폴더 집계는 **원래 SQL 그대로**
 한 번 더 훑는다 — 그래서 폴더 행의 정렬·NULL·구분자 의미는 아예 바뀌지 않는다.

★아래 시험은 대부분 **코덱스가 준 반례**다. 내 위험 목록에는 크레딧 재결합밖에 없었다.
"""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path

import pytest

from app import manage_db

_COLUMNS = (
    "id, account_email, creator_uid, creator_name, local_gen_id, workspace_scope, "
    "workspace_id, project_id, project_name, folder_path, model, output_type, "
    "real_credits, est_credits, elapsed_seconds, created_at, is_final"
)
_FIELDS = [c.strip() for c in _COLUMNS.split(",")]


def _fact(index: int, **overrides):
    row = dict(
        id=f"r{index}",
        account_email="me@example.com",
        creator_uid="u1",
        creator_name="이름",
        local_gen_id=f"g{index}",
        workspace_scope="team",
        workspace_id="ws1",
        project_id="p1",
        project_name="프로젝트",
        folder_path="EP01/S01",
        model="seedance_2_5",
        output_type="image",
        real_credits=2.0,
        est_credits=None,
        elapsed_seconds=1.5,
        created_at="2026-09-05T03:00:00Z",
        is_final=0,
    )
    row.update(overrides)
    return tuple(row[f] for f in _FIELDS)


@pytest.fixture()
def overview(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """팩트 행을 넣고 **제품 함수**를 부르는 헬퍼를 준다. 시험 안에 SQL 을 베끼지 않는다."""
    path = tmp_path / "manage_hub.db"
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
    manage_db.init_manage_db()

    def run(rows, **kwargs):
        with sqlite3.connect(path) as conn:
            conn.executemany(
                f"INSERT INTO team_generation_fact({_COLUMNS}) "
                f"VALUES({','.join('?' * len(_FIELDS))})",
                rows,
            )
        return manage_db.team_overview(**kwargs)

    return run


# ── 코덱스 반례 ────────────────────────────────────────────────────────────
def test_three_different_models_can_share_one_display_name(overview):
    """★원시값 `NULL`·빈 문자열·문자열 '알 수 없음' 은 **서로 다른 세 그룹**인데 표시명이 같다.

    표시명을 접기 키로 쓰면 세 행이 하나로 뭉쳐 **행이 사라진다**(코덱스 지적).
    검증에서도 표시명으로 dict 를 만들면 이 오류를 숨긴다 — 그래서 행 수로 본다.
    """
    data = overview([
        _fact(1, model=None), _fact(2, model=""), _fact(3, model="알 수 없음"),
        _fact(4, model="seedance_2_5"),
    ])
    unknown = [r for r in data["by_model"] if r["model"] == "알 수 없음"]
    assert len(unknown) == 3, "세 그룹이 한 행으로 뭉쳤다"
    assert sum(r["count"] for r in unknown) == 3
    # 상세 배열에도 같은 성질이 있다
    for key in ("worker_models", "project_models", "output_models"):
        assert len([r for r in data[key] if r["model"] == "알 수 없음"]) == 3, key


def test_sqlite_lower_is_not_python_lower(overview):
    """★SQLite `LOWER()` 는 ASCII 만 낮춘다 — 파이썬 `.lower()` 로 옮기면 그룹이 합쳐진다."""
    data = overview([
        _fact(1, output_type="Ä"), _fact(2, output_type="ä"),
        _fact(3, output_type="IMAGE"), _fact(4, output_type="image"),
    ])
    labels = [r["output_type"] for r in data["by_output_type"]]
    assert "Ä" in labels and "ä" in labels, f"비ASCII 대문자가 합쳐졌다: {labels}"
    assert labels.count("image") == 1  # ASCII 는 지금처럼 합쳐진다
    assert sum(r["count"] for r in data["by_output_type"]) == 4


def test_folder_paths_are_not_tidied_before_grouping(overview):
    """★역슬래시 경로와 슬래시 경로는 **별도 행**이고, 구분자·공백 정리는 집계 **뒤** 파생값에만."""
    data = overview([
        _fact(1, folder_path="A\\B"), _fact(2, folder_path="A/B"),
        _fact(3, folder_path=None), _fact(4, folder_path=""),
        _fact(5, folder_path="  EP  /  S  "),
    ])
    paths = [r["folder_path"] for r in data["folder_efficiency"]]
    assert "A\\B" in paths and "A/B" in paths, f"경로가 합쳐졌다: {paths}"
    assert paths.count("(폴더 미지정)") == 1  # NULL 과 빈 문자열은 하나로
    assert sum(r["count"] for r in data["folder_efficiency"] if r["folder_path"] == "(폴더 미지정)") == 2
    spaced = next(r for r in data["folder_efficiency"] if r["folder_path"] == "  EP  /  S  ")
    assert (spaced["episode"], spaced["scene"]) == ("EP", "S")  # 파생값에서만 다듬는다


def test_estimated_count_means_no_real_credits(overview):
    """★'견적이 있는 건수' 가 아니다 — `real_credits IS NULL` 인 행 수다.

    파이썬 `real or est or 0` 은 **실제값 0 을 버려** 이 수를 틀리게 만든다(코덱스).
    """
    data = overview([
        _fact(1, real_credits=0.0, est_credits=99.0),   # 실제값 0 — 세지 **않는다**
        _fact(2, real_credits=None, est_credits=99.0),  # 센다
        _fact(3, real_credits=None, est_credits=None),  # 둘 다 없어도 센다
    ])
    assert data["totals"]["estimated_count"] == 2
    assert data["totals"]["credits"] == pytest.approx(99.0)  # 0 + 99 + 0


def test_each_scope_gets_its_own_name_snapshot(overview):
    """★이름은 **접는 범위마다 다시 `MAX`** 해야 한다 — 전역 이름표를 재사용하면 틀린다.

    같은 프로젝트라도 폴더마다 이름 스냅샷이 다를 수 있다.
    """
    data = overview([
        _fact(1, project_name="가나다", folder_path="F1"),
        _fact(2, project_name=None, folder_path="F2"),
    ])
    assert data["by_project"][0]["project_name"] == "가나다"     # 전역은 MAX
    folders = {r["folder_path"]: r["project_name"] for r in data["folder_efficiency"]}
    assert folders["F1"] == "가나다"
    assert folders["F2"] is None, "F2 에 전역 이름이 새어 들어왔다"


def test_a_name_is_maxed_across_composite_groups(overview):
    """★합성 그룹을 가로질러 접을 때도 이름은 **`MAX`** 여야 한다 — 마지막 값이 아니다.

    같은 작업자·프로젝트라도 모델이 다르면 **다른 합성 그룹**이고, 그 그룹마다 이름 스냅샷이
    다를 수 있다. SQL 은 그룹 안에서만 MAX 하므로 접는 쪽이 다시 MAX 해야 한다.
    """
    data = overview([
        _fact(1, model="m1", creator_name="힣", project_name="힣"),
        _fact(2, model="m2", creator_name="가", project_name="가"),  # 뒤에 오지만 더 작다
    ])
    assert data["by_worker"][0]["creator_name"] == "힣"
    assert data["by_project"][0]["project_name"] == "힣"
    assert data["matrix"][0]["creator_name"] == "힣"


def test_names_that_are_all_null_stay_null(overview):
    data = overview([_fact(1, creator_name=None, project_name=None)])
    assert data["by_worker"][0]["creator_name"] is None
    assert data["by_project"][0]["project_name"] is None
    assert data["matrix"][0]["creator_name"] is None


def test_distinct_counts_skip_null_but_count_empty_string(overview):
    """`COUNT(DISTINCT x)` 의 의미 — NULL 은 세지 않고 빈 문자열은 센다."""
    data = overview([
        _fact(1, creator_uid=None, model=None, output_type=None, project_id=None),
        _fact(2, creator_uid="", model="", output_type="", project_id=""),
        _fact(3, creator_uid="u1", model="m1", output_type="image", project_id="p1"),
    ])
    t = data["totals"]
    assert (t["workers"], t["projects"], t["models"], t["features"]) == (2, 2, 2, 2)
    assert t["count"] == 3


def test_an_empty_table_gives_zeroes_and_empty_arrays(overview):
    data = overview([])
    assert data["totals"] == {
        "count": 0, "credits": 0, "elapsed_seconds": 0, "estimated_count": 0,
        "final_count": 0, "workers": 0, "projects": 0, "models": 0, "features": 0,
    }
    for key, value in data.items():
        if key != "totals":
            assert value == [], key


# ── 권한 ──────────────────────────────────────────────────────────────────
def test_the_viewer_scope_needs_both_uid_and_email(overview):
    """일반 멤버 범위는 `(creator_uid, account_email)` **둘 다** 맞아야 한다 — 접기 전에 거른다."""
    rows = [
        _fact(1, creator_uid="u1", account_email="me@example.com"),
        _fact(2, creator_uid="u2", account_email="me@example.com"),
        _fact(3, creator_uid="u1", account_email="other@example.com"),
    ]
    mine = overview(rows, viewer=("u1", "me@example.com"))
    assert mine["totals"]["count"] == 1
    for key, value in mine.items():
        if key != "totals":
            assert sum(r["count"] for r in value) == 1, key


# ── 합산 ──────────────────────────────────────────────────────────────────
def test_the_folded_total_matches_what_sqlite_sums_directly(overview, tmp_path):
    """★접은 합계가 **SQLite 가 한 번에 더한 값**과 같아야 한다.

    SQLite 3.50.4 의 `SUM` 은 보정합산이라 `SUM(0.1,0.2,0.3)` 이 정확히 `0.6` 이다.
    부분합을 왼쪽부터 누적하면 `0.6000000000000001` 이 되어 갈린다 — 그래서 오라클로 대조한다.
    (여기서 `0.6` 을 손으로 적지 않는 이유: 기대값을 베끼면 오라클이 아니라 또 하나의 구현이 된다.)
    """
    assert 0.1 + 0.2 + 0.3 != 0.6  # 왼쪽부터 누적하면 갈린다는 전제 자체를 못 박는다
    data = overview([
        _fact(1, creator_uid="a", real_credits=0.1),
        _fact(2, creator_uid="b", real_credits=0.2),
        _fact(3, creator_uid="c", real_credits=0.3),
    ])
    with sqlite3.connect(manage_db.MANAGE_DB_PATH) as conn:
        oracle = conn.execute(
            "SELECT SUM(COALESCE(real_credits, est_credits, 0)) FROM team_generation_fact"
        ).fetchone()[0]
    assert data["totals"]["credits"] == oracle


def test_group_sums_add_up_to_the_totals(overview):
    rows = [
        _fact(1, creator_uid="a", project_id="p1", model="m1", real_credits=3.5, elapsed_seconds=2.25, is_final=1),
        _fact(2, creator_uid="b", project_id="p2", model="m2", real_credits=1.25, elapsed_seconds=0.5),
        _fact(3, creator_uid="a", project_id="p2", model="m1", real_credits=None, est_credits=7.0, is_final=1),
    ]
    data = overview(rows)
    t = data["totals"]
    for key in ("by_worker", "by_project", "by_model", "matrix", "folder_efficiency"):
        assert math.fsum(r["credits"] for r in data[key]) == pytest.approx(t["credits"]), key
        assert sum(r["count"] for r in data[key]) == t["count"], key
    assert t["final_count"] == 2
    assert t["elapsed_seconds"] == pytest.approx(4.25)


# ── 정렬 ──────────────────────────────────────────────────────────────────
def test_ties_get_a_deterministic_order(overview):
    """★새 계약이다 — 종전 SQLite 의 동점 순서는 보장된 적이 없다.

    같은 크레딧이면 **원시 식별자** 순으로, NULL 이 앞이다.
    """
    rows = [
        _fact(1, creator_uid="c", real_credits=10.0),
        _fact(2, creator_uid="a", real_credits=10.0),
        _fact(3, creator_uid="b", real_credits=10.0),
        _fact(4, creator_uid=None, real_credits=10.0),
        _fact(5, creator_uid="z", real_credits=99.0),
    ]
    order = [r["creator_uid"] for r in overview(rows)["by_worker"]]
    assert order == ["z", None, "a", "b", "c"]


def test_model_ties_are_ordered_by_the_raw_key_not_by_first_appearance(overview):
    """★합성 그룹은 `(작업자, 프로젝트, 모델, 출력)` 순으로 나온다 — **모델 순이 아니다.**

    보조 정렬 키가 없으면 동점 모델이 '먼저 나온 순' 으로 남아 조회 순서에 끌려다닌다.
    """
    rows = [
        _fact(1, creator_uid="u1", model="zz", real_credits=1.0),
        _fact(2, creator_uid="u2", model="aa", real_credits=1.0),
        _fact(3, creator_uid="u3", model="mm", real_credits=1.0),
    ]
    assert [r["model"] for r in overview(rows)["by_model"]] == ["aa", "mm", "zz"]


def test_every_tie_broken_array_ignores_the_order_rows_arrive_in(overview):
    """★합성 그룹은 `(작업자, 프로젝트, 모델, 출력)` 순으로 온다 — 다른 축의 동점은 그 순서에
    끌려다닌다. 보조 정렬 키가 그걸 끊는지 축마다 확인한다.

    (`by_worker`·`by_project` 의 보조키는 **오늘의 실행 계획에서는 관측되지 않는다** —
     합성 그룹이 이미 그 축으로 정렬돼 나오기 때문이다. SQLite 가 GROUP BY 출력 순서를
     보장하지는 않으므로 보조키는 그대로 둔다. 아래는 관측 가능한 축들이다.)
    """
    # 출력유형: 뒤 라벨이 먼저 나오도록 배치한다
    data = overview([
        _fact(1, creator_uid="u1", output_type="zzz", real_credits=1.0),
        _fact(2, creator_uid="u2", output_type="aaa", real_credits=1.0),
    ])
    assert [r["output_type"] for r in data["by_output_type"]] == ["aaa", "zzz"]

    # 작업자별 모델: 같은 작업자 안에서 프로젝트가 다르면 모델이 역순으로 들어온다
    data = overview([
        _fact(3, creator_uid="w1", project_id="p1", model="zz", real_credits=1.0),
        _fact(4, creator_uid="w1", project_id="p2", model="aa", real_credits=1.0),
    ])
    mine = [r["model"] for r in data["worker_models"] if r["creator_uid"] == "w1"]
    assert mine == ["aa", "zz"]

    # 프로젝트별 모델: 같은 프로젝트 안에서 작업자가 다르면 모델이 역순으로 들어온다
    data = overview([
        _fact(5, creator_uid="a1", project_id="pp", model="zz", real_credits=1.0),
        _fact(6, creator_uid="a2", project_id="pp", model="aa", real_credits=1.0),
    ])
    mine = [r["model"] for r in data["project_models"] if r["project_id"] == "pp"]
    assert mine == ["aa", "zz"]

    # 출력유형별 모델도 같다
    data = overview([
        _fact(7, creator_uid="b1", output_type="img", model="zz", real_credits=1.0),
        _fact(8, creator_uid="b2", output_type="img", model="aa", real_credits=1.0),
    ])
    mine = [r["model"] for r in data["output_models"] if r["output_type"] == "img"]
    assert mine == ["aa", "zz"]


def test_the_same_data_always_comes_back_in_the_same_order(overview):
    rows = [_fact(i, creator_uid=f"u{i % 3}", model=f"m{i % 4}", real_credits=5.0) for i in range(12)]
    first = overview(rows)
    second = manage_db.team_overview()
    assert first == second


# ── 훑는 횟수 ──────────────────────────────────────────────────────────────
def test_the_folder_axis_does_not_inflate_the_composite_key(overview):
    """★폴더는 합성 키에 **들어가면 안 된다** — 카디널리티가 열려 있는 유일한 축이다.

    생성물마다 폴더가 다르면 합성 그룹이 행 수까지 불어나고, 그때 접기는 **느려진다**
    (실측 22,392행·폴더 전부 다름: 합성 키에 넣으면 247->421ms·41.2MB,
     빼면 249.81->140.45ms·16.1MB).

    제품의 SQL 상수를 그대로 써서 **실제 그룹 수**를 센다 — 상수만 읽으면 동어반복이 된다.
    """
    rows = [
        _fact(i, creator_uid=f"u{i % 2}", folder_path=f"EP/{i}")  # 폴더는 전부 다르다
        for i in range(50)
    ]
    overview(rows)
    with sqlite3.connect(manage_db.MANAGE_DB_PATH) as conn:
        groups = conn.execute(
            f"SELECT {manage_db._FOLD_COLUMNS} FROM team_generation_fact "
            f"{manage_db._FOLD_GROUP_BY}"
        ).fetchall()
    assert len(groups) == 2, f"폴더 50종이 합성 그룹을 {len(groups)}개로 불렸다"


def test_the_dashboard_reads_the_fact_table_twice_not_ten_times(overview, monkeypatch):
    """★이 시험이 이 파일의 이유다 — 같은 필터로 열 번 훑던 것을 두 번으로 줄였다.

    (합성 키 한 번 + 폴더 한 번. 폴더를 합성 키에 넣으면 고카디널리티에서 **느려진다**.)
    """
    seen: list[str] = []
    original = manage_db.get_connection

    class Counting:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, parameters=()):
            if "FROM team_generation_fact" in sql and sql.lstrip()[:6].upper() == "SELECT":
                seen.append(sql)
            return self._conn.execute(sql, parameters)

    import contextlib

    @contextlib.contextmanager
    def counting_connection():
        with original() as conn:
            yield Counting(conn)

    monkeypatch.setattr(manage_db, "get_connection", counting_connection)
    overview([_fact(1), _fact(2, creator_uid="u2")])
    assert len(seen) == 2, f"팩트 표를 {len(seen)}번 훑었다:\n" + "\n".join(seen)
