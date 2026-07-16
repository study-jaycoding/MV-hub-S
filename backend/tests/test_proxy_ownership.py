"""프록시 ownership 불변식 — 로컬 허브가 어떤 API 를 서버로 위임하는지 고정.

_proxy.is_local_path() 는 '로컬 기본, 목록만 예외'가 아니라 '로컬 목록(_LOCAL_PREFIXES/_LOCAL_EXACT)만
로컬, 나머지 /api/* 는 전부 서버 위임'이다. 그래서 새 로컬-전용 라우트를 목록에 안 넣으면 조용히 서버로
오프록시되어(비공개 로컬 메타·seen·byte-cache 유실) '유령' 버그가 난다.

이 테스트는 '서버로 위임되는 라우트 집합'을 골든 스냅샷으로 고정한다:
  · 새 라우트가 서버로 분류되면(=로컬이어야 할 신규 라우트 오프록시 위험) → 집합 불일치로 실패.
  · 기존 서버 라우트가 사라지거나 분류가 로컬로 바뀌면 → 실패.
로컬로 분류되는 신규 라우트는 안전한 기본값이라 강제 등록하지 않는다(핸들러가 돌아 재분기·미러 처리).
"""

import os
import tempfile
import unittest

# 서버(공유 팀 서버)로 위임되는 /api/* 라우트 — 팀 계정·매니징·크레딧·발행 등 '서버가 진실원천'인 것만.
# ★비공개 로컬 메타/seen/byte-cache 는 여기 없어야 한다(있으면 오프록시 버그).
EXPECTED_SERVER_ROUTES = frozenset(
    {
        "/api/account/hf",
        "/api/auth/access",
        "/api/auth/accounts",
        "/api/auth/accounts/{email}/global-roles",
        "/api/auth/accounts/{email}/hidden",
        "/api/auth/accounts/{email}/reset-password",
        "/api/auth/accounts/{email}/status",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/me",
        "/api/auth/me/name",
        "/api/auth/me/password",
        "/api/auth/register",
        "/api/credits",
        "/api/db-backup",
        "/api/db-backup/latest",
        "/api/manage/breakdown",
        "/api/manage/hf-missing-apply",
        "/api/manage/hf-missing-candidates",
        "/api/manage/matrix",
        "/api/manage/planning/{pid}",
        "/api/manage/summary",
        "/api/manage/tasks",
        "/api/manage/tasks-batch",
        "/api/manage/tasks/assignees/bulk",
        "/api/manage/tasks/{tid}",
        "/api/manage/tasks/{tid}/assignees/{uid}",
        "/api/manage/tasks/{tid}/generations",
        "/api/manage/tasks/{tid}/generations/{gen_id}",
        "/api/manage/team-overview",
        "/api/manage/team-timeseries",
        "/api/manage/telemetry/push",
        "/api/manage/timeseries",
        "/api/members",
        "/api/members/{uid}/global-roles",
        "/api/provider",
        "/api/share/publish-bundle",
    }
)


class ProxyOwnershipTests(unittest.TestCase):
    def setUp(self):
        # 라우트 열거만 하지만, app import 가 config/DB 를 건드려도 안전하게 임시 DB 로.
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")

    def tearDown(self):
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        self.tmp.cleanup()

    def _server_routes(self) -> set[str]:
        from app.main import app
        from app.routers._proxy import is_local_path

        seen: set[str] = set()
        server: set[str] = set()
        for r in app.routes:
            p = getattr(r, "path", None)
            if not p or not p.startswith("/api") or p in seen:
                continue
            seen.add(p)
            if not is_local_path(p):
                server.add(p)
        return server

    def test_server_delegated_routes_frozen(self):
        server = self._server_routes()
        extra = sorted(server - EXPECTED_SERVER_ROUTES)
        missing = sorted(EXPECTED_SERVER_ROUTES - server)
        self.assertEqual(
            (extra, missing),
            ([], []),
            "프록시 분류 변경 감지 — extra=새로 서버로 감(로컬이어야 할 신규 라우트 오프록시 위험?), "
            f"missing=서버 목록에서 사라짐. extra={extra} missing={missing}. "
            "의도된 변경이면 EXPECTED_SERVER_ROUTES 를 갱신하라(오프록시 버그가 아닌지 확인 후).",
        )

    def test_local_dispatch_routes_are_local(self):
        # ★회귀 방지: 핸들러가 로컬/서버로 재분기하는 by-id 코멘트·seen·byte-cache 는 반드시 로컬로 들어와야 한다.
        from app.routers._proxy import is_local_path

        for p in (
            "/api/generation-comments/c1",
            "/api/generation-comments/c1/seen",
            "/api/cache-all",
            "/api/generations/g1/comments/read",
            "/api/sync-status",  # 로컬 허브 자기 상태 — 서버 위임 금지
        ):
            self.assertTrue(is_local_path(p), f"{p} 는 로컬로 들어와 핸들러가 재분기해야 한다(서버 오프록시 금지)")

    def test_sample_real_paths_match_templates(self):
        # 파라미터 실경로가 템플릿과 같은 분류인지(스냅샷이 템플릿경로 기준이라 안전성 확인).
        from app.routers._proxy import is_local_path

        self.assertFalse(is_local_path("/api/manage/tasks/t1/assignees/u1"))  # server
        self.assertFalse(is_local_path("/api/auth/accounts/a%40x.com/status"))  # server
        self.assertTrue(is_local_path("/api/generations/abc/history"))  # local
        self.assertTrue(is_local_path("/api/trash/xyz"))  # local


if __name__ == "__main__":
    unittest.main()
