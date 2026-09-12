"""목록 응답에서만 `params.prompt` 를 뺀다 — 그리고 **오직 목록에서만**.

★왜(2026-09-12 실측, C-1): `/api/generations?limit=200` 이 **3.38MB** 인데 그중
 **26.3%·896KB** 가 `row.prompt` 와 같은 값의 중복이었다. 팀 탭은 이 목록을 **15초마다**
 다시 받는다(`useGenerationAutoRefresh` 의 light 리로드). 조건부 요청으로 줄일 수도 없다 —
 이 엔드포인트에는 ETag 가 없다(관리 쪽 `manage.py` 에는 있다).

★**표식이 필요 없다**(코덱스 판정): 레시피는 이미 받는 히스토리 응답의 온전한
 `target.params` 를 쓰도록 프론트를 함께 고쳤다. 목록만으로 원래 params 를 복원하려 하지 않는다.

★**옛 프론트 공존**: 옛 화면은 아직 **목록 행**으로 레시피를 만든다. 그래서 축약은
 클라이언트가 `lean_params=1` 로 **명시적으로 요청할 때만** 한다.
"""

from __future__ import annotations

from app.routers.library import _strip_list_prompt


def test_the_duplicated_prompt_is_dropped():
    """★이 시험이 이 파일의 이유다 — 같은 값이 `prompt` 필드로 이미 온다."""
    rows = [{"id": "g1", "prompt": "고양이", "params": {"prompt": "고양이", "aspect_ratio": "16:9"}}]
    _strip_list_prompt(rows)
    assert rows[0]["params"] == {"aspect_ratio": "16:9"}
    assert rows[0]["prompt"] == "고양이"  # 화면이 쓰는 값은 그대로


def test_a_params_prompt_that_differs_is_also_dropped_from_the_list():
    """★불일치 0.2%(실측 1332건 중 2건)도 **목록에서는** 뺀다.

    복원하지 않기 때문에 안전하다 — 레시피는 히스토리의 온전한 값을 쓴다.
    DB 와 상세 응답의 값은 건드리지 않는다(아래 시험이 그걸 본다).
    """
    rows = [{"id": "g1", "prompt": "새 프롬프트", "params": {"prompt": "옛 프롬프트", "seed": 7}}]
    _strip_list_prompt(rows)
    assert rows[0]["params"] == {"seed": 7}


def test_everything_else_in_params_survives():
    params = {"prompt": "x", "aspect_ratio": "1:1", "duration": 4, "mode": "omni_reference",
              "resolution": "1080p", "seed": 0, "enabled": False, "nested": {"a": 1}}
    rows = [{"id": "g1", "params": dict(params)}]
    _strip_list_prompt(rows)
    assert rows[0]["params"] == {k: v for k, v in params.items() if k != "prompt"}


def test_missing_or_null_params_are_left_alone():
    """`params: null` 은 유효한 원본 값이다 — 빈 dict 로 바꾸면 없던 값을 만든다."""
    rows = [{"id": "a", "params": None}, {"id": "b"}, {"id": "c", "params": {}}]
    _strip_list_prompt(rows)
    assert rows[0]["params"] is None
    assert "params" not in rows[1]
    assert rows[2]["params"] == {}


def test_a_params_without_prompt_is_not_rebuilt():
    """★손대지 않는다 — 새 dict 로 바꾸면 쓸데없이 할당만 늘고 동일성 비교가 깨진다."""
    original = {"aspect_ratio": "16:9"}
    rows = [{"id": "g1", "params": original}]
    _strip_list_prompt(rows)
    assert rows[0]["params"] is original


def test_the_original_params_dict_is_not_mutated():
    """★원본 dict 를 지우면 그것을 공유하는 다른 경로가 함께 상한다."""
    shared = {"prompt": "고양이", "seed": 1}
    rows = [{"id": "g1", "params": shared}]
    _strip_list_prompt(rows)
    assert shared == {"prompt": "고양이", "seed": 1}  # 원본은 그대로
    assert rows[0]["params"] is not shared


def test_rubbish_rows_do_not_crash_the_list():
    rows = [None, "문자열", 42, {"id": "ok", "params": {"prompt": "p"}}]
    _strip_list_prompt(rows)
    assert rows[3]["params"] == {}


def test_many_rows_are_all_handled():
    rows = [{"id": f"g{i}", "prompt": "p", "params": {"prompt": "p", "i": i}} for i in range(200)]
    _strip_list_prompt(rows)
    assert all("prompt" not in r["params"] for r in rows)
    assert [r["params"]["i"] for r in rows] == list(range(200))
