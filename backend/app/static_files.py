"""배포 프론트의 해시 자산 서빙 정책."""

from __future__ import annotations

from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope


class ImmutableStaticFiles(StaticFiles):
    """파일명 해시가 붙은 빌드 자산을 브라우저가 다시 확인하지 않게 한다."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code in (200, 206, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
