"""팀 탭 개인메타 필터(색/태그/전역태그) — 허브 로컬 필터 + 무한스크롤 채우기.

개인메타(내 g.color·tags·auto_tags·남 카드 shadow 색)는 로컬 전용이라 서버 색/태그 필터로 안 잡힌다.
_team_local_filtered 가 해당 필터를 뺀 요청으로 서버 페이지를 받아 overlay 후 로컬에서 거르고,
limit 이 찰 때까지 커서를 전진하며 이어 받는지(무한스크롤 조기중단 방지) 고정한다.
proxy_json/overlay 를 모킹해 순수 로직만 검증.
"""

import unittest

import pytest


class TeamLocalFilterTests(unittest.TestCase):
    def _run(self, pages, *, colors=None, tags=None, auto=None, ws=None, limit=200,
             workspace_scope=None,
             overlay_shadow=None, overlay_tags=None,
             query="tab=team&colors=%23ff0000&limit=200"):
        """pages: 서버가 커서별로 돌려줄 목록들. overlay_shadow/{id:color}·overlay_tags/{id:[tag]} 주입."""
        from app.routers import library

        calls = {"n": 0, "queries": []}

        def fake_proxy_json(method, path, *, raw_query=None, **kw):
            calls["queries"].append(raw_query or "")
            i = calls["n"]
            calls["n"] += 1
            return pages[i] if i < len(pages) else []

        def fake_overlay(data, request):
            for g in data:
                if overlay_shadow and g.get("id") in overlay_shadow:
                    g["color"] = overlay_shadow[g["id"]]
                if overlay_tags and g.get("id") in overlay_tags:
                    g["tags"] = overlay_tags[g["id"]]
            return data

        class Req:
            class url:
                pass
        Req.url.query = query

        orig_pj, orig_ov = library._proxy.proxy_json, library._overlay_personal_meta
        library._proxy.proxy_json = fake_proxy_json
        library._overlay_personal_meta = fake_overlay
        try:
            out = library._team_local_filtered(
                Req(), colors, tags, auto, ws, limit, None, None, workspace_scope=workspace_scope
            )
        finally:
            library._proxy.proxy_json = orig_pj
            library._overlay_personal_meta = orig_ov
        return out, calls

    def _card(self, cid, color=None, tags=None, auto=None, ts=1.0, ws=None):
        card = {"id": cid, "job_id": cid, "color": color, "tags": tags or [],
                "auto_tags": auto or [], "sort_ts": ts}
        if ws:
            card.update(workspace_scope="team", workspace_id=ws)
        return card

    # ── 워크스페이스 중복 선택(Jay 2026-09-14) ──
    # 팀 탭은 쿼리스트링이 공유 서버로 그대로 넘어간다. **옛 서버는 workspace_ids 를 모른다** —
    # 그러면 필터가 조용히 안 걸린 전체가 온다. 그래서 허브가 한 번 더 거른다.
    def test_filters_by_multiple_workspaces_local(self):
        page = [self._card("a", ws="ws-1"), self._card("b", ws="ws-2"),
                self._card("c", ws="ws-3"), self._card("d")]
        out, _ = self._run([page], ws=["ws-1", "ws-3"])
        self.assertEqual([g["id"] for g in out], ["a", "c"])

    def test_personal_and_unknown_rows_never_match_a_workspace_pick(self):
        # 개인·미상 소속은 workspace_id 를 못 가진다(WORKSPACE_DATA_CONTRACT 규칙 2).
        # 같은 id 가 남아 있는 비정상 행도 scope 가 team 이 아니면 안 걸려야 한다.
        rows = [self._card("a", ws="ws-1"), self._card("b")]
        rows[1].update(workspace_scope="personal", workspace_id="ws-1")
        out, _ = self._run([rows], ws=["ws-1"])
        self.assertEqual([g["id"] for g in out], ["a"])

    def test_no_workspace_pick_means_everything(self):
        page = [self._card("a", ws="ws-1"), self._card("b")]
        out, _ = self._run([page], ws=[])
        self.assertEqual([g["id"] for g in out], ["a", "b"])

    def test_personal_scope_filters_old_server_rows_without_including_unknown(self):
        personal = self._card("personal")
        personal.update(workspace_scope="personal", creator_uid="other")
        page = [personal, self._card("team", ws="ws-a"), self._card("unknown")]
        out, calls = self._run([page], workspace_scope="personal", query="tab=team&workspace_scope=personal")
        self.assertEqual([g["id"] for g in out], ["personal"])
        self.assertIn("workspace_scope=personal", calls["queries"][0])

    def test_personal_and_team_filters_intersect_even_when_old_server_ignores_both(self):
        personal = self._card("personal", ws="ws-a")
        personal["workspace_scope"] = "personal"
        out, _ = self._run(
            [[personal, self._card("team", ws="ws-a")]], ws=["ws-a"], workspace_scope="personal",
        )
        self.assertEqual(out, [])

    def test_personal_old_server_fills_page_after_two_hundred_nonmatching_rows(self):
        first = [self._card(f"team-{i}", ws="ws-a", ts=1000 - i) for i in range(200)]
        personal = self._card("personal", ts=10)
        personal["workspace_scope"] = "personal"
        out, calls = self._run(
            [first, [personal]], workspace_scope="personal", limit=1,
            query="tab=team&workspace_scope=personal&project_id=p&limit=1",
        )
        self.assertEqual([g["id"] for g in out], ["personal"])
        self.assertEqual(calls["n"], 2)
        self.assertIn("cursor_id=team-199", calls["queries"][1])
        self.assertIn("project_id=p", calls["queries"][1])

    def test_personal_old_server_safety_limit_does_not_report_a_false_end_of_results(self):
        from fastapi import HTTPException

        pages = [
            [self._card(f"team-{page}-{i}", ws="ws-a", ts=20000 - page * 200 - i) for i in range(200)]
            for page in range(60)
        ]
        with self.assertRaises(HTTPException) as error:
            self._run(pages, workspace_scope="personal")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("업데이트", error.exception.detail)

    # ── 색 ──
    def test_filters_by_color_local(self):
        page = [self._card("a", "#ff0000"), self._card("b", "#00ff00"), self._card("c", "#ff0000")]
        out, calls = self._run([page], colors=["#ff0000"])
        self.assertEqual([g["id"] for g in out], ["a", "c"])
        self.assertNotIn("colors", calls["queries"][0])

    def test_shadow_color_counts_in_filter(self):
        page = [self._card("x"), self._card("y")]
        out, _ = self._run([page], colors=["#ff0000"], overlay_shadow={"x": "#ff0000"})
        self.assertEqual([g["id"] for g in out], ["x"])

    # ── 태그 ──
    def test_filters_by_tag_local(self):
        page = [self._card("a", tags=["hero"]), self._card("b", tags=["bg"]), self._card("c", tags=["hero", "bg"])]
        out, calls = self._run([page], tags=["hero"], query="tab=team&tags=hero&limit=200")
        self.assertEqual([g["id"] for g in out], ["a", "c"])  # hero 를 가진 카드(OR)
        self.assertNotIn("tags=", calls["queries"][0])  # 서버엔 태그 안 보냄

    def test_overlay_tags_counts_in_filter(self):
        # 서버 태그는 비어도, overlay 가 내 태그를 입힌 카드가 필터에 걸려야 한다.
        page = [self._card("m"), self._card("n")]
        out, _ = self._run([page], tags=["mine"], overlay_tags={"m": ["mine"]}, query="tab=team&tags=mine&limit=200")
        self.assertEqual([g["id"] for g in out], ["m"])

    def test_auto_tag_filter(self):
        page = [self._card("a", auto=["g1"]), self._card("b", auto=["g2"])]
        out, _ = self._run([page], auto=["g1"], query="tab=team&auto_tags=g1&limit=200")
        self.assertEqual([g["id"] for g in out], ["a"])

    # ── 조합(AND across groups) ──
    def test_color_and_tag_combined_and(self):
        page = [
            self._card("a", "#ff0000", tags=["hero"]),  # 색O 태그O → 매치
            self._card("b", "#ff0000", tags=["bg"]),    # 색O 태그X → 탈락
            self._card("c", "#00ff00", tags=["hero"]),  # 색X 태그O → 탈락
        ]
        out, _ = self._run([page], colors=["#ff0000"], tags=["hero"],
                           query="tab=team&colors=%23ff0000&tags=hero&limit=200")
        self.assertEqual([g["id"] for g in out], ["a"])

    # ── 페이지네이션 ──
    def test_paginates_until_filled_not_early_stop(self):
        p1 = [self._card(f"p1_{i}", "#ff0000" if i == 0 else "#000000", ts=100 - i) for i in range(200)]
        p2 = [self._card("p2_a", "#ff0000", ts=1.0), self._card("p2_b", "#ff0000", ts=0.5)]
        out, calls = self._run([p1, p2], colors=["#ff0000"], limit=3)
        self.assertEqual([g["id"] for g in out], ["p1_0", "p2_a", "p2_b"])
        self.assertEqual(calls["n"], 2)
        self.assertIn("cursor_id=p1_199", calls["queries"][1])

    def test_stops_when_server_exhausted(self):
        out, calls = self._run([[self._card("only", "#ff0000")]], colors=["#ff0000"])
        self.assertEqual([g["id"] for g in out], ["only"])
        self.assertEqual(calls["n"], 1)

    def test_caps_matches_at_limit(self):
        page = [self._card(f"r{i}", "#ff0000", ts=100 - i) for i in range(5)]
        out, _ = self._run([page], colors=["#ff0000"], limit=3)
        self.assertEqual(len(out), 3)

    def test_strips_legacy_single_params(self):
        page = [self._card("a", "#ff0000", tags=["hero"])]
        _, calls = self._run(
            [page], colors=["#ff0000"], tags=["hero"],
            query="tab=team&color=%23ff0000&colors=%23ff0000&tag=hero&tags=hero&cursor_ts=9&cursor_id=z&limit=200",
        )
        q = calls["queries"][0]
        for gone in ("color=", "colors=", "tag=", "tags=", "cursor_ts=", "cursor_id="):
            self.assertNotIn(gone, q)
        self.assertIn("tab=team", q)


class TeamTabDispatchTests(unittest.TestCase):
    """팀 탭에서 **언제** 허브가 직접 거르는가 — 이 판단이 없으면 위 필터는 불려지지도 않는다.

    팀 탭 요청은 쿼리스트링이 공유 서버로 그대로 넘어간다(_proxy.proxy_get). 그래서
     · 한 개 선택 → 단수 `workspace_id` 가 같이 나가 **서버가** 거른다(옛 서버에서도 동작).
     · 두 개 이상 → 옛 서버는 `workspace_ids` 를 모른다 → **허브가** 거른다.
    """

    def _call(self, ws_ids, workspace_scope=None):
        from unittest import mock

        from fastapi import BackgroundTasks
        from starlette.requests import Request

        from app.routers import library

        request = Request({
            "type": "http", "method": "GET", "path": "/api/generations",
            "query_string": b"tab=team", "headers": [],
        })

        with (
            mock.patch.object(library._proxy, "proxying", return_value=True),
            mock.patch.object(library, "_team_local_filtered", return_value=[]) as local,
            mock.patch.object(library._proxy, "proxy_get", return_value=[]) as passthrough,
            mock.patch.object(library, "_overlay_personal_meta", side_effect=lambda d, r: d),
            mock.patch.object(library, "_schedule_remote_thumb_prewarm", return_value=False),
        ):
            library.list_generations(
                request, BackgroundTasks(), tab="team",
                colors=[], tags=[], auto_tags=[], workspace_ids=ws_ids, limit=500,
                workspace_scope=workspace_scope,
            )
        return local, passthrough

    def test_two_or_more_picks_are_filtered_by_the_hub(self):
        local, passthrough = self._call(["ws-1", "ws-2"])
        self.assertEqual(local.call_args.args[4], ["ws-1", "ws-2"])
        passthrough.assert_not_called()

    def test_a_single_pick_is_left_to_the_server(self):
        # 서버가 거르면 상한(약 12,000행) 없이 정확하다 — 굳이 허브가 다시 걸 필요가 없다.
        local, passthrough = self._call(["ws-1"])
        local.assert_not_called()
        passthrough.assert_called_once()

    def test_no_pick_is_left_to_the_server(self):
        local, passthrough = self._call([])
        local.assert_not_called()
        passthrough.assert_called_once()

    def test_personal_scope_uses_local_safety_filter_for_old_server(self):
        local, passthrough = self._call([], workspace_scope="personal")
        self.assertEqual(local.call_args.kwargs["workspace_scope"], "personal")
        passthrough.assert_not_called()

    def test_personal_scope_does_not_drop_single_workspace_intersection(self):
        local, passthrough = self._call(["ws-a"], workspace_scope="personal")
        self.assertEqual(local.call_args.args[4], ["ws-a"])
        self.assertEqual(local.call_args.kwargs["workspace_scope"], "personal")
        passthrough.assert_not_called()

    def test_single_workspace_is_trimmed_and_deduplicated_before_old_server_proxy(self):
        from urllib.parse import parse_qs

        local, passthrough = self._call([" ws-a ", "ws-a"])
        local.assert_not_called()
        query = parse_qs(passthrough.call_args.args[1].url.query)
        self.assertEqual(query["workspace_ids"], ["ws-a"])
        self.assertEqual(query["workspace_id"], ["ws-a"])


@pytest.mark.parametrize("fail", [False, True])
def test_personal_pagination_pins_account_key_and_uid_then_restores(monkeypatch, fail):
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app import active_account, config
    from app.routers import library

    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "a@example.test", "uid": "a"}])
    calls = []

    def proxy(*args, **kwargs):
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        calls.append(kwargs)
        if len(calls) == 1:
            # 실제 로그인·DB는 바꾸지 않고 페이지 사이 머신 포인터 변경만 재현한다.
            active_account._cache[:] = [True, {"email": "b@example.test", "uid": "b"}]
            return [
                {"id": f"team-{i}", "sort_ts": 1000 - i, "workspace_scope": "team", "workspace_id": "ws-a"}
                for i in range(200)
            ]
        if fail:
            raise HTTPException(502, "unavailable")
        return [{"id": "personal", "sort_ts": 1, "workspace_scope": "personal"}]

    def overlay(rows, request):
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        return rows

    monkeypatch.setattr(library._proxy, "proxy_json", proxy)
    monkeypatch.setattr(library, "_overlay_personal_meta", overlay)
    request = SimpleNamespace(url=SimpleNamespace(query="tab=team&workspace_scope=personal"))
    if fail:
        with pytest.raises(HTTPException):
            library._team_local_filtered(request, [], [], [], [], 1, None, None, workspace_scope="personal")
    else:
        result = library._team_local_filtered(request, [], [], [], [], 1, None, None, workspace_scope="personal")
        assert [row["id"] for row in result] == ["personal"]
    assert len(calls) == 2
    assert active_account.account_key() == "b@example.test"
    assert active_account.active_uid() == "b"
