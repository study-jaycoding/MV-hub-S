"""Pydantic 모델 — API 요청/응답 스키마 (Phase 2).

API 응답은 snake_case JSON (CLAUDE.md 컨벤션).
DB row(sqlite3.Row) → 응답 모델 변환은 라우터의 직렬화 헬퍼에서 처리한다.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# ── 공통 타입 ────────────────────────────────────────────────────────────
MediaType = Literal["image", "video"]
GenStatus = Literal["pending", "running", "done", "failed"]
AccountType = Literal["personal", "team"]


# ── 응답 모델 ────────────────────────────────────────────────────────────
class WorkerOut(BaseModel):
    id: str
    name: str
    account_type: AccountType = "personal"


class AssetOut(BaseModel):
    id: str
    generation_id: str
    type: MediaType
    file_path: str
    thumbnail_path: Optional[str] = None
    source_url: Optional[str] = None  # 원본 원격 URL(로컬 캐시 후에도 출처 보존)
    cached: bool = False  # file_path 가 로컬(/media)인지


class ReferenceOut(BaseModel):
    id: str
    type: MediaType
    file_path: str
    thumbnail_path: Optional[str] = None
    source: Optional[str] = None
    role: Optional[str] = None  # gen_reference.role (조회 맥락에 따라 채워짐)
    source_url: Optional[str] = None  # 원본 원격 URL
    cached: bool = False


class GenerationOut(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    prompt: str
    display_prompt: Optional[str] = None  # UI 표시용(칩 자리에 @소스명). 없으면 prompt
    model: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    color: Optional[str] = None
    # 동기화 status 를 그대로 노출 — 힉스필드가 'nsfw' 등 4종 외 상태를 줄 수 있어 비제약(str).
    # (Literal 로 묶으면 예상 못 한 상태 1개가 목록 전체 응답을 500 으로 깨뜨린다.)
    status: str
    created_at: str
    sort_ts: Optional[float] = None  # 정렬 정밀 epoch — 키셋 페이지네이션의 다음 커서(클라가 사용)
    assets: list[AssetOut] = Field(default_factory=list)
    references: list[ReferenceOut] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 별도 네임스페이스(사이드바 필터 전용)
    shared: bool = False
    parent_gen_id: Optional[str] = None  # history 상 파생(derived) 부모(있으면 재생성·가져오기본)
    child_count: int = 0  # 이 결과물을 부모로 한 파생/사용 수(히스토리 ⑂N 뱃지)
    source_count: int = 0  # 이 결과물이 @소스로 쓴 재료(reference 부모) 수
    is_source: bool = False  # 소스 라이브러리 등록 여부(@ 참조 대상)
    source_name: Optional[str] = None  # @이름
    comment: Optional[str] = None  # 카드 코멘트(메모, 레거시 — UI 미사용)
    error: Optional[str] = None  # 실패 사유(status=failed 일 때)
    comment_count: int = 0  # 공유 코멘트 스레드 글 수
    has_unread: bool = False  # 미확인 코멘트 존재(뷰어 기준 — C 뱃지)
    local_only: bool = False  # 힉스필드에 없고 로컬에만 있음(흐림 처리 + '로컬 보기' 필터)
    creator_uid: Optional[str] = None  # 생성자 식별자(팀 워크스페이스)
    creator_name: Optional[str] = None  # 사용자 지정 이름(uid→이름)
    is_mine: bool = True  # 내 생성물인가(아니면 팀원)
    project_id: Optional[str] = None  # 귀속 프로젝트(작업 묶음·내부 식별자). NULL=미분류
    project_name: Optional[str] = None  # 프로젝트 표시 이름 — UI 는 이것만 보여준다(uuid 노출 금지)
    deleted: bool = False  # 휴지통(soft delete) — 우리 카탈로그에서만 숨김. 힉스필드 원본 영향 없음
    is_final: bool = False  # v02 CMS: Supervisor 가 지정한 최종(골드)
    final_by: Optional[str] = None  # 최종 지정자 creator_uid


class HistoryOut(BaseModel):
    """한 결과물의 가계(히스토리) — relation 별 분리."""

    ancestors: list[GenerationOut] = Field(default_factory=list)  # 파생 부모 → … → 루트
    materials: list[GenerationOut] = Field(default_factory=list)  # 쓴 @소스(재료 ⬆)
    target: GenerationOut
    children: list[GenerationOut] = Field(default_factory=list)  # 파생 버전 ⬇(최신순)
    used_by: list[GenerationOut] = Field(default_factory=list)  # 이걸 @소스로 쓴 것(사용처)
    siblings: list[GenerationOut] = Field(default_factory=list)  # 같은 입력소스 공유(약한 형제, Phase C)


class HistoryEdgeIn(BaseModel):
    """수동 히스토리 연결/해제 — 자동 히스토리가 없는(동기화) 결과물을 손으로 묶기."""

    parent_gen_id: str
    relation: str = "derived"  # 'derived' | 'reference'


class HistoryEdgeOut(BaseModel):
    parent_gen_id: str
    child_gen_id: str
    relation: str = "derived"


class HistoryGraphOut(BaseModel):
    """연결된 가계 전체 그래프 — 구성탭 히스토리 트리(노드+엣지+루트)."""

    nodes: list[GenerationOut] = Field(default_factory=list)
    edges: list[HistoryEdgeOut] = Field(default_factory=list)
    root_ids: list[str] = Field(default_factory=list)  # 원본(부모 없는 노드)
    focus_id: str  # 진입(포커스)한 결과물 — 하이라이트용


class FacetsOut(BaseModel):
    """좌측 필터 사이드바용 패싯(DESIGN.md §4)."""

    colors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 자동 태그(별도 네임스페이스)
    workers: list[WorkerOut] = Field(default_factory=list)


class ModelOut(BaseModel):
    display_name: str
    job_set_type: str
    type: str  # 'image' | 'video' | 'text'


# ── 요청 모델 ────────────────────────────────────────────────────────────
class ReferenceIn(BaseModel):
    """생성 모달의 레퍼런스 슬롯(@Image/@Video)."""

    file_path: str  # 로컬 경로/업로드 UUID 또는 asset:proj|path 토큰
    type: MediaType = "image"
    role: str = "@Image1"
    name: Optional[str] = None  # 칩 표시 이름(@소스명) — 프롬프트 인라인 칩 복원/매칭용
    thumbnail: Optional[str] = None  # 표시용 썸네일 URL(에셋 소스 칩의 썸네일)
    source_url: Optional[str] = None  # 출처 URL(있으면 보존)
    source_gen_id: Optional[str] = None  # 이 @소스가 온 generation id → 히스토리 reference 엣지 기록용


class GenerationCreate(BaseModel):
    prompt: str = Field(min_length=1)
    display_prompt: Optional[str] = None  # UI 표시용(칩 자리에 @소스명)
    model: str  # job_set_type, 예: 'nano_banana_2'
    params: dict[str, Any] = Field(default_factory=dict)
    color: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 무장된 자동 태그(별도 네임스페이스)
    references: list[ReferenceIn] = Field(default_factory=list)
    worker_id: Optional[str] = None  # 없으면 기본 작업자
    project_id: Optional[str] = None  # 생성 시 보던 프로젝트로 자동 귀속(없으면 미분류)


class RegenerateIn(BaseModel):
    """기존 generation 을 재활용해 새 잡 생성(프롬프트·레퍼런스 복제)."""

    prompt: Optional[str] = None  # 없으면 부모 프롬프트 그대로
    model: Optional[str] = None
    color: Optional[str] = None
    worker_id: Optional[str] = None
    auto_tags: Optional[list[str]] = None  # 재생성 시점 무장된 자동태그(부모 자동태그에 더해 적용)


# ── 로컬 실행 생성요청(gen-request) — 버튼은 요청만, 실행은 각자 로컬 에이전트 ──────
class GenRequestIn(BaseModel):
    """허브의 생성/재생성 버튼이 서버에 남기는 '로컬 실행 요청'. 서버는 placeholder 카드만
    즉시 만들고, 요청자의 PC 에이전트가 가져가 자기 로컬 CLI 로 실행한다."""

    kind: str = Field(default="create", pattern="^(create|regenerate)$")
    create: Optional[GenerationCreate] = None  # kind=create 일 때
    source_gen_id: Optional[str] = None  # kind=regenerate 일 때 원본
    regenerate: Optional[RegenerateIn] = None  # kind=regenerate 옵션(프롬프트/모델/색 덮어쓰기)


class PendingRequestOut(BaseModel):
    """에이전트가 가져가는 대기 요청 — 로컬 CLI 실행에 필요한 레시피."""

    id: str
    gen_id: str
    kind: str
    model: Optional[str] = None
    prompt: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    references: list[dict[str, Any]] = Field(default_factory=list)  # [{file_path(url), type, role}]


class FulfillIn(BaseModel):
    """에이전트가 로컬 실행 완료 후 결과를 보고 — raw 는 `generate get/list` 의 한 잡(dict)."""

    job: dict[str, Any]


class TagsIn(BaseModel):
    tags: list[str]


class ColorIn(BaseModel):
    color: Optional[str] = None


class SourceIn(BaseModel):
    """선택한 생성본을 소스 라이브러리에 등록(@이름)."""

    name: Optional[str] = None  # @이름. is_source=False 면 무시
    is_source: bool = True


class CommentIn(BaseModel):
    comment: Optional[str] = None  # 빈 문자열/None 이면 코멘트 제거


class PublishIn(BaseModel):
    visibility: str = "team"
    shared_by: Optional[str] = None  # 없으면 기본 작업자


class ImportIn(BaseModel):
    """팀 공유 항목을 내 워크스페이스로 가져오기(로컬 복제 + history)."""

    worker_id: Optional[str] = None


# ── 프로젝트(작업 묶음) ───────────────────────────────────────────────────
class ProjectOut(BaseModel):
    id: str
    name: str
    kind: str = "team"  # 'team' | 'personal'
    created_by: Optional[str] = None
    created_at: str
    archived: bool = False
    count: int = 0  # 내 작업(viewer) 기준 결과물 수 — 사이드바 My Work 용
    total: int = 0  # 프로젝트 전체 결과물 수(작성자 무관) — 관리자 탭에서 표시


class ProjectsOut(BaseModel):
    projects: list[ProjectOut] = Field(default_factory=list)
    unassigned: int = 0  # 미분류(project_id IS NULL) 결과물 수
    archived_count: int = 0  # 보관된 프로젝트 수(사이드바 보관함 지연 로딩 판단용)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    kind: str = "team"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    archived: Optional[bool] = None


class AssignProjectIn(BaseModel):
    """결과물들을 프로젝트에 귀속(또는 project_id=None 으로 미분류 해제)."""

    generation_ids: list[str] = Field(default_factory=list)
    project_id: Optional[str] = None


# ── 멤버 전역 역할(복수) — v02 RBAC PART 1 ────────────────────────────────
class MemberOut(BaseModel):
    uid: str
    name: Optional[str] = None
    # 전역 역할(복수 가능): admin/product_director/production_director/member
    global_roles: list[str] = Field(default_factory=lambda: ["member"])
    is_mine: bool = False
    count: int = 0  # 생성물 수
    email: Optional[str] = None  # 로그인 계정 멤버면 채워짐(외부 creator 는 None)
    status: Optional[str] = None  # 계정 상태(approved/pending/…) — 계정 멤버만. creator-only=None


class GlobalRolesIn(BaseModel):
    """v02 전역 역할(복수) 부여 — 빈 리스트면 member 로 간주."""

    global_roles: list[str] = Field(default_factory=list)


# ── push 적재(ingest) — 각자 로컬 CLI 결과물을 서버로 밀어올림 ────────────────
class IngestIn(BaseModel):
    """팀원 PC의 push 에이전트가 보내는 묶음. jobs = 로컬 `generate list --json` 원본 배열.
    creator_uid 는 비우면 서버가 결과 URL에서 자동 추출(가장 많은 uid = 푸시한 사람)."""

    jobs: list[dict] = Field(default_factory=list)
    creator_uid: Optional[str] = None  # 명시하면 그 uid 로 귀속(없으면 자동 추출)
    account_status: Optional[dict] = None  # {email, credits, plan, workspaces} — 크레딧 집계용


class IngestMcpIn(BaseModel):
    """과거 백필 — MCP show_generations 원시 아이템 배열(100개 밖 이력). Claude 가 cursor 순회 POST.
    items 는 mcp_item_to_cli 로 CLI 형태 변환 후 /ingest 와 동일 코어로 적재."""

    items: list[dict] = Field(default_factory=list)
    account_status: Optional[dict] = None


class IngestOut(BaseModel):
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    linked_uid: Optional[str] = None  # 이 계정에 연결된 힉스필드 생성자 uid


# ── 프로젝트 역할(복수, v02 RBAC PART 1) ──────────────────────────────────
class ProjectMemberOut(BaseModel):
    uid: str
    name: Optional[str] = None
    roles: list[str] = Field(default_factory=list)  # project_manager/supervisor/editor (복수)


class ProjectRolesIn(BaseModel):
    creator_uid: str
    project_roles: list[str] = Field(default_factory=list)  # 빈 리스트면 역할만 비움(멤버 유지)
