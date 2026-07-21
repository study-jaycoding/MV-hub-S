"""팀 탭 색 필터 — 허브 로컬 필터(개인색은 서버에 없어 서버가 못 거름) + 무한스크롤 채우기.

개인색(내 g.color·shadow)은 로컬 전용이라 서버 색 필터로 안 잡힌다. _team_color_filtered 가 색을 뺀
요청으로 서버 페이지를 받아 overlay 후 로컬에서 색으로 거르고, limit 이 찰 때까지 커서를 전진하며
페이지를 이어 받는지(무한스크롤 조기중단 방지) 고정한다. proxy_json/overlay 를 모킹해 순수 로직만 검증.
"""

import unittest


class TeamColorFilterTests(unittest.TestCase):
    def _run(self, pages, want, limit, *, overlay_shadow=None, query="tab=team&colors=%23ff0000&limit=200"):
        """pages: 서버가 커서별로 돌려줄 목록들(순서대로). overlay_shadow: {id: color} 로 shadow 색 주입."""
        from app.routers import library

        calls = {"n": 0, "queries": []}

        def fake_proxy_json(method, path, *, raw_query=None, **kw):
            calls["queries"].append(raw_query or "")
            i = calls["n"]
            calls["n"] += 1
            return pages[i] if i < len(pages) else []

        def fake_overlay(data, request):
            if overlay_shadow:
                for g in data:
                    if g.get("id") in overlay_shadow:
                        g["color"] = overlay_shadow[g["id"]]
            return data

        class Req:
            class url:
                pass
        Req.url.query = query

        orig_pj, orig_ov = library._proxy.proxy_json, library._overlay_personal_meta
        library._proxy.proxy_json = fake_proxy_json
        library._overlay_personal_meta = fake_overlay
        try:
            out = library._team_color_filtered(Req(), want, limit, None, None)
        finally:
            library._proxy.proxy_json = orig_pj
            library._overlay_personal_meta = orig_ov
        return out, calls

    def _card(self, cid, color=None, ts=1.0):
        return {"id": cid, "job_id": cid, "color": color, "sort_ts": ts}

    def test_filters_by_color_local(self):
        page = [self._card("a", "#ff0000"), self._card("b", "#00ff00"), self._card("c", "#ff0000")]
        out, calls = self._run([page], {"#ff0000"}, 200)
        self.assertEqual([g["id"] for g in out], ["a", "c"])
        # 색을 뺀 요청이어야(서버가 색으로 안 거르게) — raw_query 에 colors 없음.
        self.assertNotIn("colors", calls["queries"][0])

    def test_shadow_color_counts_in_filter(self):
        # 서버 색은 없지만(None) overlay 가 shadow 로 빨강을 입힌 카드도 필터에 걸려야 한다.
        page = [self._card("x", None), self._card("y", None)]
        out, _ = self._run([page], {"#ff0000"}, 200, overlay_shadow={"x": "#ff0000"})
        self.assertEqual([g["id"] for g in out], ["x"])

    def test_paginates_until_filled_not_early_stop(self):
        # 1페이지(200개, 매칭 1개) → 부족하니 2페이지 이어 받아 매칭 채움(조기중단 방지).
        p1 = [self._card(f"p1_{i}", "#ff0000" if i == 0 else "#000000", ts=100 - i) for i in range(200)]
        p2 = [self._card("p2_a", "#ff0000", ts=1.0), self._card("p2_b", "#ff0000", ts=0.5)]
        out, calls = self._run([p1, p2], {"#ff0000"}, 3)
        self.assertEqual([g["id"] for g in out], ["p1_0", "p2_a", "p2_b"])
        self.assertEqual(calls["n"], 2)  # 2페이지 다 받음
        # 2번째 요청은 1페이지 마지막 행 커서로 이어졌는지.
        self.assertIn("cursor_id=p1_199", calls["queries"][1])

    def test_stops_when_server_exhausted(self):
        # 한 페이지가 PAGE(200) 미만이면 서버 소진 → 더 안 받음.
        out, calls = self._run([[self._card("only", "#ff0000")]], {"#ff0000"}, 200)
        self.assertEqual([g["id"] for g in out], ["only"])
        self.assertEqual(calls["n"], 1)

    def test_caps_matches_at_limit(self):
        page = [self._card(f"r{i}", "#ff0000", ts=100 - i) for i in range(5)]
        out, _ = self._run([page], {"#ff0000"}, 3)
        self.assertEqual(len(out), 3)

    def test_strips_legacy_single_color_param(self):
        # color(단수)·colors(복수) 둘 다 서버 요청에서 빠져야 서버가 색으로 안 거른다.
        page = [self._card("a", "#ff0000")]
        _, calls = self._run(
            [page], {"#ff0000"}, 200,
            query="tab=team&color=%23ff0000&colors=%23ff0000&cursor_ts=9&cursor_id=z&limit=200",
        )
        q = calls["queries"][0]
        self.assertNotIn("color=", q)   # color= 도 colors= 도 없어야(둘 다 색 파라미터)
        self.assertNotIn("colors=", q)
        self.assertIn("tab=team", q)    # 다른 필터는 유지
