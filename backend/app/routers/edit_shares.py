"""편집 공유 — 서버에 저장한 '보이는 것 한 줄'(스냅샷)을 팀이 본다. 공유 서버 DB 가 권위다(repo/edit_shares).

로컬 허브(AUTH off)에서 이 경로는 _proxy._LOCAL_PREFIXES 에 있어 일반 중계(_forward)를 타지 않는다 — 일반 중계는 본문을 받은 뒤에
연결을 읽고 화면 계정을 대조하지 않는다(Codex 설계 검토). 여기서 ① 저장은 출처 검사(다른 사이트의 POST) ② 화면 계정 머리글 필수 대조
③ 주소·토큰을 고정해 공유 서버로 넘긴다. 서버에 로그인하지 않았으면 409 — 로컬 DB 에 저장하고 '서버에 저장됨'으로 보이지 않게.
공유 서버 본체(AUTH on)는 인증 계정으로 처리한다: 조회 = 인증 + 프로젝트 권한, 저장 = 본문 expect_account 가 인증 계정 email 과 같아야.
주소·토큰을 따로 두 번 읽는 것은 공용 중계와 같은 한계다(어긋난 쌍 — 공용 작업으로 이관, 설계 문서 §4).
"""

from contextlib import contextmanager
from typing import Iterator

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import active_account, config, rbac, repo
from ..deps import EXPECT_ACCOUNT_HEADER, account_global_roles, account_scope_uid, current_account, expected_account_differs
from ..emailnorm import norm_email
from ..services.request_guards import require_local_browser_context

router = APIRouter(prefix="/api/edit-shares", tags=["edit-shares"])

NOT_CONNECTED = "공유 서버에 로그인하지 않아 서버에 저장할 수 없습니다"
ACCOUNT_CHANGED = "화면과 허브의 계정이 달라 멈췄습니다. 새로 고쳐 주세요."


class ShareIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=512)
    seq: str = Field(min_length=1, max_length=4096)
    data: str = Field(min_length=1, max_length=repo.SHARE_SNAPSHOT_MAX)  # 글자 수 1차 상한 — 정확한 판정은 repo 의 'ASCII 로 감싼 길이'
    expect_account: str = Field(default="", max_length=1024)  # 허브가 고정한 계정 email 로 채운다 — 서버는 비었거나 다르면 409


@contextmanager
def _relay(request: Request, *, write: bool) -> Iterator[str]:
    """로컬 허브의 중계 문맥 — 고정한 계정 email 을 돌려준다. 이 안의 proxy_json 은 고정한 주소·토큰으로 간다."""
    if write:
        require_local_browser_context(request, "다른 사이트의 요청이라 막았습니다")
    with active_account.pinned_account_scope() as key:
        owner = norm_email(key)
        if not request.headers.get(EXPECT_ACCOUNT_HEADER, "").strip() or expected_account_differs(request, owner):
            raise HTTPException(409, ACCOUNT_CHANGED)
        if not _proxy.proxying():
            raise HTTPException(409, NOT_CONNECTED)
        with _proxy.pinned_connection((_proxy.base_url(), _proxy.token())):
            yield owner


def _viewer(request: Request) -> tuple[str, str, object, bool]:
    """공유 서버 본체의 요청 계정 — (email, 표시 이름, 범위 uid, read_all)."""
    account = current_account(request)
    email = norm_email((account or {}).get("email"))
    if not account or not email:
        raise HTTPException(401, "로그인이 필요합니다")
    read_all = rbac.has_global_cap(account_global_roles(request), "read_all")
    return email, (account.get("name") or ""), account_scope_uid(request), read_all  # 이름이 없어도 email 로 채우지 않는다(목록에 나간다)


@contextmanager
def _answers() -> Iterator[None]:
    try:
        yield
    except LookupError as exc:
        raise HTTPException(403, "이 프로젝트의 편집 공유를 볼 수 없습니다") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/save")
def save_share(body: ShareIn, request: Request):
    with _answers():
        repo.check_share_fields(project_id=body.project_id, seq=body.seq, expect_account=body.expect_account)
        if config.AUTH_ENABLED:
            email, name, viewer, read_all = _viewer(request)
            expect = body.expect_account.strip()  # 허브는 email 로, 서버에 바로 붙은 화면은 머리글과 같은 'acct:<email>' 로 싣는다
            if not expect or norm_email(expect.removeprefix("acct:")) != email:
                raise HTTPException(409, ACCOUNT_CHANGED)
            return repo.save_edit_share(body.project_id, body.seq, email, name, body.data, viewer_uid=viewer, read_all=read_all)
    with _relay(request, write=True) as owner:
        return _proxy.proxy_json("POST", "/api/edit-shares/save", body={**body.model_dump(), "expect_account": owner})


@router.get("")
def list_shares(request: Request, project_id: str = Query(min_length=1, max_length=512), seq: str = Query(min_length=1, max_length=4096)):
    if config.AUTH_ENABLED:
        email, _name, viewer, read_all = _viewer(request)
        with _answers():
            return repo.list_edit_shares(project_id, seq, email, viewer_uid=viewer, read_all=read_all)
    with _relay(request, write=False):
        return _proxy.proxy_json("GET", "/api/edit-shares", params={"project_id": project_id, "seq": seq})


@router.get("/doc")
def get_share(
    request: Request, project_id: str = Query(min_length=1, max_length=512), seq: str = Query(min_length=1, max_length=4096),
    key: str = Query(pattern=r"^[0-9a-f]{32}$"),
):
    if config.AUTH_ENABLED:
        _email, _name, viewer, read_all = _viewer(request)
        with _answers():
            return repo.get_edit_share(project_id, seq, key, viewer_uid=viewer, read_all=read_all)
    with _relay(request, write=False):
        return _proxy.proxy_json("GET", "/api/edit-shares/doc", params={"project_id": project_id, "seq": seq, "key": key})
