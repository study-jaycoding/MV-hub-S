"""팀 탭 개인메타 필터(색/태그/전역태그) — 허브 로컬 필터 + 무한스크롤 채우기.

개인메타(내 g.color·tags·auto_tags·남 카드 shadow 색)는 로컬 전용이라 서버 색/태그 필터로 안 잡힌다.
_team_local_filtered 가 해당 필터를 뺀 요청으로 서버 페이지를 받아 overlay 후 로컬에서 거르고,
limit 이 찰 때까지 커서를 전진하며 이어 받는지(무한스크롤 조기중단 방지) 고정한다.
proxy_json/overlay 를 모킹해 순수 로직만 검증.
"""

import unittest


class TeamLocalFilterTests(unittest.TestCase):
    def _run(self, pages, *, colors=None, tags=None, auto=None, limit=200,
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
            out = library._team_local_filtered(Req(), colors, tags, auto, limit, None, None)
        finally:
            library._proxy.proxy_json = orig_pj
            library._overlay_personal_meta = orig_ov
        return out, calls

    def _card(self, cid, color=None, tags=None, auto=None, ts=1.0):
        return {"id": cid, "job_id": cid, "color": color, "tags": tags or [], "auto_tags": auto or [], "sort_ts": ts}

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
