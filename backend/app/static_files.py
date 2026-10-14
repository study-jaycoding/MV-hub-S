"""배포 프론트의 해시 자산 서빙 정책."""

from __future__ import annotations

import mimetypes
import stat

import anyio
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.responses import Response
from starlette.types import Scope

from .list_gzip import accepts_gzip


class ImmutableStaticFiles(StaticFiles):
    """파일명 해시가 붙은 빌드 자산을 브라우저가 다시 확인하지 않게 한다."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        headers = Headers(scope=scope)
        compressible = path.endswith((".js", ".css"))
        response = None
        if (
            compressible
            and scope["method"] in ("GET", "HEAD")
            and "range" not in headers
            and accepts_gzip(headers.get("accept-encoding"))
        ):
            try:
                _, original_stat = await anyio.to_thread.run_sync(self.lookup_path, path)
                if original_stat and stat.S_ISREG(original_stat.st_mode):
                    gzip_path, gzip_stat = await anyio.to_thread.run_sync(self.lookup_path, path + ".gz")
                    if gzip_stat and stat.S_ISREG(gzip_stat.st_mode):
                        # Select the representation before Starlette checks its ETag.
                        response = self.file_response(gzip_path, gzip_stat, scope)
                        if response.status_code == 200:
                            media_type = mimetypes.guess_type(path)[0] or "text/plain"
                            response.headers["Content-Type"] = Response(media_type=media_type).headers["content-type"]
                        response.headers["Content-Encoding"] = "gzip"
            except (OSError, ValueError):
                # Preserve the original file's normal error handling and legacy fallback.
                pass
        if response is None:
            response = await super().get_response(path, scope)
        if response.status_code in (200, 206, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            if compressible:
                response.headers.append("Vary", "Accept-Encoding")
        return response
