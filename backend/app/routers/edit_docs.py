"""개인 편집 백업은 계정 DB에만 보관하며 팀 서버로 프록시하지 않는다."""

from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, StrictInt

from .. import active_account, config, repo
from ..deps import EXPECT_ACCOUNT_HEADER, current_account, expected_account_differs
from ..emailnorm import norm_email

router = APIRouter(prefix="/api/edit-docs", tags=["edit-docs"])


@contextmanager
def _owner(request: Request):
    with active_account.pinned_account_scope() as key:
        account = current_account(request)
        if config.AUTH_ENABLED and not account:
            raise HTTPException(401, "로그인이 필요합니다")
        owner = norm_email((account or {}).get("email")) if config.AUTH_ENABLED else norm_email(key)
        if not request.headers.get(EXPECT_ACCOUNT_HEADER, "").strip() or expected_account_differs(request, owner):
            raise HTTPException(409, "화면과 허브의 계정이 달라 편집 백업을 멈췄습니다. 새로 고쳐 주세요.")
        # email은 creator_uid 연결 전후에도 같다. 신원 리맵에서 유일한 복구 사본을 지우지 않는다.
        try:
            yield owner or "local"
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc


class BackupIn(BaseModel):
    doc_key: str = Field(min_length=1, max_length=4096)
    data: str = Field(max_length=1024 * 1024)
    base_revision: StrictInt | None = Field(ge=1)


class RestoreSource(BaseModel):
    data: str | None = Field(default=None, max_length=1024 * 1024)
    copy_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class RestoreIn(BaseModel):
    doc_key: str = Field(min_length=1, max_length=4096)
    base_revision: StrictInt | None = Field(ge=1)
    source: RestoreSource
    local_raw: str | None = Field(default=None, max_length=1024 * 1024)
    kind: Literal["pre_restore", "pre_adopt"] = "pre_restore"


@router.get("/backup")
def get_backup(request: Request, doc_key: str = Query(min_length=1, max_length=4096),
               include_data: bool = False, copy_hash: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$"),
               offset: int = Query(default=0, ge=0), limit: int = Query(default=20, ge=1, le=100)):
    with _owner(request) as owner:
        return repo.get_edit_backup(owner, doc_key, include_data=include_data, copy_hash=copy_hash, offset=offset, limit=limit)


@router.put("/backup")
def put_backup(body: BackupIn, request: Request):
    with _owner(request) as owner:
        return repo.save_edit_backup(owner, body.doc_key, body.data, body.base_revision)


@router.post("/backup/restore")
def restore_backup(body: RestoreIn, request: Request):
    with _owner(request) as owner:
        return repo.restore_edit_backup(owner, body.doc_key, body.base_revision, data=body.source.data,
                                        copy_hash=body.source.copy_hash, local_raw=body.local_raw, kind=body.kind)
