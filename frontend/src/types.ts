// 백엔드 API 응답 타입 (backend/app/models.py 와 1:1)

export type MediaType = "image" | "video";
export type GenStatus = "pending" | "running" | "done" | "failed" | "nsfw";

export interface Asset {
  id: string;
  generation_id: string;
  type: MediaType;
  file_path: string;
  thumbnail_path: string | null;
  source_url: string | null;
  cached: boolean;
}

export interface Reference {
  id: string;
  type: "image" | "video" | "audio";
  file_path: string;
  thumbnail_path: string | null;
  source: string | null;
  role: string | null;
  source_url: string | null;
  cached: boolean;
}

export interface Generation {
  id: string;
  worker_id: string;
  worker_name: string | null;
  prompt: string;
  display_prompt: string | null; // UI 표시용(칩 자리에 @소스명). 없으면 prompt
  model: string | null;
  params: Record<string, unknown> | null;
  color: string | null;
  status: GenStatus;
  created_at: string;
  sort_ts?: number | null; // 정렬 정밀 epoch — 무한 스크롤 키셋 커서(다음 페이지 요청에 사용)
  job_id?: string | null; // 힉스필드 잡 앵커 — 팀 카드(서버 UUID)↔로컬 개인메타 매핑용
  assets: Asset[];
  references: Reference[];
  tags: string[];
  auto_tags: string[]; // 자동 태그(별도 네임스페이스 — 사이드바 필터 전용, 카드 미표시)
  shared: boolean;
  parent_gen_id: string | null; // 파생(derived) 부모 — 재생성·가져오기본
  child_count?: number; // 이 결과물을 부모로 한 파생/사용 수(히스토리 ⑂N 뱃지)
  source_count?: number; // 이 결과물이 @소스로 쓴 재료(reference 부모) 수
  is_source: boolean; // 소스 라이브러리 등록 여부(@ 참조)
  source_name: string | null; // @이름
  comment: string | null; // 카드 코멘트(메모, 레거시 — UI 미사용)
  error: string | null; // 실패 사유(status=failed 일 때)
  comment_count: number; // 공유 코멘트 스레드 글 수
  has_unread: boolean; // 미확인 코멘트 존재(C 뱃지)
  local_only: boolean; // 힉스필드에 없고 로컬에만 있음(흐림 처리 + '로컬 보기' 필터)
  creator_uid: string | null; // 생성자 식별자(팀 워크스페이스)
  creator_name: string | null; // 사용자 지정 이름
  is_mine: boolean; // 내 생성물인가(아니면 팀원)
  project_id: string | null; // 귀속 프로젝트(작업 묶음·내부 식별자). null=미분류
  project_name?: string | null; // 프로젝트 표시 이름 — UI 는 이것만 보여준다(uuid 노출 금지)
  folder_path?: string | null; // 렌더 루트 기준 상대 폴더 경로(예 'ep001/c0010'). null=미지정
  deleted: boolean; // 휴지통(soft delete) — 카탈로그에서만 숨김. 힉스필드 원본 영향 없음
  is_final?: boolean; // v02 CMS: Supervisor 가 지정한 최종(골드)
  final_by?: string | null; // 최종 지정자 creator_uid
  depth?: number; // 히스토리 형제 전용: 자기 'derived' 체인 깊이(루트=0) — 깊이별 그룹화·연결 방향용
}

// 한 결과물의 가계(히스토리) — 카드 뱃지 클릭 시 패널 표시. relation 별 분리.
export interface History {
  ancestors: Generation[]; // 파생 부모 → … → 루트(버전 체인)
  materials: Generation[]; // 이 결과물이 @소스로 쓴 재료 ⬆
  target: Generation;
  children: Generation[]; // 파생 버전 ⬇(최신순)
  used_by: Generation[]; // 이 결과물을 @소스로 쓴 것(사용처)
  siblings: Generation[]; // 같은 입력 소스를 공유한 약한 형제
}

// 연결된 가계 전체 그래프 — 구성탭 히스토리 트리(원본→파생 한눈에).
export interface HistoryEdge {
  parent_gen_id: string;
  child_gen_id: string;
  relation: string; // 'derived' | 'reference'
}
export interface HistoryGraph {
  nodes: Generation[];
  edges: HistoryEdge[];
  root_ids: string[]; // 원본(부모 없는 노드)
  focus_id: string; // 진입(포커스)한 결과물
  truncated?: boolean; // 안전상한(limit)에 닿아 계보 일부가 생략됨(무음 절단 방지 표식)
}

// 프로젝트(작업 묶음) — 공유·이동의 단위. Assets 패널의 폴더(ProjectsInfo)와 별개.
export interface Project {
  id: string;
  name: string;
  kind: string; // 'team' | 'personal'
  created_by: string | null;
  created_at: string;
  archived: boolean;
  count: number; // 내 작업(viewer) 기준 결과물 수 — 사이드바 My Work 용
  total?: number; // 프로젝트 전체 결과물 수(작성자 무관) — 관리자 탭에서 표시
}

export interface ProjectsResponse {
  projects: Project[];
  unassigned: number; // 미분류 결과물 수
  archived_count?: number; // 보관된 프로젝트 수(보관함 지연 로딩 판단용)
}

export interface ProjectFolderNode {
  name: string;
  path: string; // Render 폴더 기준 상대 경로. 루트 Render 는 빈 문자열.
  count: number; // 하위 전체 파일 수
  children: ProjectFolderNode[];
}

export interface ProjectFolderLink {
  project_id: string;
  root_path: string;
  selected_path: string;
  updated_at?: string | null;
}

export interface ProjectFolderState extends ProjectFolderLink {
  render_path: string;
  tree: ProjectFolderNode | null;
  error: string | null;
  truncated: boolean;
}

// 멤버(=생성자) + 전역 역할(복수). 관리자 창. v02 RBAC PART 1.
export interface Member {
  uid: string;
  name: string | null;
  global_roles: string[]; // v02 전역 역할(복수): admin/product_director/production_director/member
  is_mine: boolean;
  count: number; // 생성물 수
  email: string | null; // '나'(제공자)만
}

// 로그인 계정(보안) — 로드맵 §4-1/§4-2
export interface Account {
  email: string;
  name: string | null;
  status: string; // pending | approved | rejected
  global_roles?: string[]; // v02 전역 역할(복수)
  creator_uid: string | null;
  is_house?: boolean; // 서버 힉스필드(my_creator_uid)에 연결된 계정 = 워크스페이스 전환 등 서버 CLI 주체
  hidden?: boolean; // 관리자가 숨긴 계정(목록에서 가림, '숨긴 계정 보기'로 재표시)
  created_at: string;
  approved_at: string | null;
}

// 프로젝트 멤버 + 그 안에서의 역할(복수, v02 RBAC PART 1)
export interface ProjectMember {
  uid: string;
  name: string | null;
  roles: string[]; // project_manager/supervisor/creator (복수)
}

export interface AuthConfig {
  auth_enabled: boolean;
  has_accounts: boolean;
  manage_enabled?: boolean; // PM 대시보드(분리형) 활성 여부 — 버튼 노출 게이트
}

// 팀 크레딧 집계 — 각 계정 에이전트가 보고한 마지막 잔액(실시간 아님).
export interface CreditSummary {
  total: number;
  accounts: { email: string; name: string; credits: number | null; plan?: string | null }[];
}

// 로그인 계정 본인이 에이전트로 보고한 힉스필드 상태(비-하우스 계정 메뉴 — 읽기전용·마지막 동기화 기준).
export interface ReportedHfStatus {
  reported: boolean; // 보고 이력 있음? (false=에이전트 미연결)
  credits: number | null;
  plan?: string | null;
  connected?: boolean;
  workspaces: Workspace[];
}

// v02 전역 역할(사람 단위, 복수 보유 가능) — RBAC_CMS_DAM 로드맵 §1-1.
export const GLOBAL_ROLES = [
  "admin",
  "product_manager",
  "production_director",
  "member",
] as const;
export const GLOBAL_ROLE_LABEL: Record<string, string> = {
  admin: "Admin · 시스템·가입·전역인사",
  product_manager: "Manager · 프로젝트 생성·역할부여",
  production_director: "Director · 제작총괄·전체읽기",
  member: "Member · 기본 작업자",
};

// v02 프로젝트 역할(그 프로젝트 안) — 로드맵 §1-2.
export const PROJECT_ROLES = ["project_manager", "supervisor", "creator"] as const;
export const PROJECT_ROLE_LABEL: Record<string, string> = {
  project_manager: "PM · 운영·멤버관리",
  supervisor: "Supervisor · 작업+검수(최종선택)",
  creator: "Creator · 작업",
};

// 프로젝트 배치 시 자동 기본 역할(백엔드 rbac.GLOBAL_TO_PROJECT_DEFAULT 미러). 복수면 합집합.
export const GLOBAL_TO_PROJECT_DEFAULT: Record<string, string[]> = {
  admin: ["project_manager", "supervisor", "creator"],
  product_manager: ["project_manager"],
  production_director: ["supervisor", "creator"],
  member: ["creator"],
};
export function defaultProjectRoles(globalRoles: string[] | undefined): string[] {
  const acc = new Set<string>();
  for (const r of globalRoles || [])
    (GLOBAL_TO_PROJECT_DEFAULT[r] || ["creator"]).forEach((x) => acc.add(x));
  return (PROJECT_ROLES as readonly string[]).filter((r) => acc.has(r));
}

// 전역 역량 매트릭스 — 백엔드 rbac.GLOBAL_CAPS 미러(관리자 창 탭 노출 판정에 사용).
export const GLOBAL_CAPS: Record<string, string[]> = {
  admin: ["system", "approve_signup", "grant_global", "read_all"],
  product_manager: ["grant_project_role", "create_project", "read_all"],
  production_director: ["create_work", "read_all"],
  member: ["create_work"],
};
// 보유 역할(복수) 중 하나라도 이 역량을 가지면 true.
export function hasGlobalCap(roles: string[] | undefined, cap: string): boolean {
  return (roles || []).some((r) => (GLOBAL_CAPS[r] || []).includes(cap));
}

export interface Creator {
  uid: string;
  name: string | null;
  count: number;
  is_mine: boolean;
}

// 생성본 코멘트 스레드 항목(에셋 코멘트와 동일 모양, 키만 gen_id)
export type GenComment = AssetComment;

export interface Worker {
  id: string;
  name: string;
  account_type: string;
}

export interface Facets {
  colors: string[];
  tags: string[];
  auto_tags: string[]; // 자동 태그(별도 네임스페이스 — 필터 사이드바 전용)
  workers: Worker[];
}

export interface ModelInfo {
  display_name: string;
  job_set_type: string;
  type: string;
}

// 모델별 CLI 조절 가능 파라미터(동적 옵션)
export interface ModelParam {
  name: string;
  type: string; // string | integer | array | object …
  default: unknown;
  required: boolean;
  enum?: string[];
}
export interface ModelParamsOut {
  display_name?: string;
  job_set_type: string;
  type: string;
  params: ModelParam[];
}

export interface Workspace {
  id: string;
  name: string | null;
  plan_type: string; // free | team …
  credits: number;
  is_selected: boolean; // 현재 컨텍스트
  user_role: string; // owner | member …
}

export interface Filters {
  tab: "my" | "team" | "compose";
  worker_id?: string;
  color?: string;
  tag?: string;
  share_dir?: "mine" | "received"; // 공유한 것 / 공유 받은 것(타 작업자 생성)
  local_only?: boolean; // 로컬 보기 — 힉스필드에 없고 로컬에만 있는 것
  creator_uid?: string; // 특정 생성자(팀원)만 보기
  project_id?: string; // 프로젝트 필터. 특정 id 또는 'none'(미분류)
  folder_path?: string; // 폴더 필터(접두사) — 그 폴더 + 하위 전부. 프로젝트 선택 시 해제
  search?: string;
  include_deleted?: boolean; // 휴지통(지운 생성물) 함께 보기 — 정상+지운것, 지운건 흐리게
  deleted_only?: boolean; // 지운 것만 보기(휴지통 전용 뷰)
}

// 서버사이드 인스턴트 필터까지 포함한 조회 쿼리(무한 스크롤이 서버에서 거름).
// App 이 흩어진 필터 상태(typeFilter/colorFilter/…)를 이 하나로 합쳐 보낸다.
export interface GenQuery extends Filters {
  media_type?: "image" | "video" | "audio"; // 'all' 은 생략
  colors?: string[]; // 다중 컬러(OR)
  tags?: string[]; // 다중 태그(OR)
  auto_tags?: string[]; // 무장된 전역 태그(OR)
  shared_only?: boolean; // 팀 공유된 것만
  comment_only?: boolean; // 코멘트 있는 것만
  final_only?: boolean; // 최종(골드)만
}

// 전역 파생값(무한 스크롤 모드에서 클라이언트 전량 로드 대체)
export interface GenStats {
  failed_count: number;
  has_unread: boolean;
}

// Assets(구성) 패널 — PV 구성탭(폴더 트리)
export interface AssetNode {
  name: string;
  type: "dir" | "image" | "video" | "audio";
  path: string;
  mtime?: number | null; // 파일 수정시각(epoch 초) — 날짜별 구분용. 폴더는 없음
  children?: AssetNode[];
}

export interface AssetTree {
  project: string;
  name: string;
  children: AssetNode[];
}

export interface ProjectsInfo {
  projects: string[];
  default: string;
  root: string;
}

// 등록된 외부 폴더(마운트) — 임의 경로 폴더에 이름을 붙여 프로젝트처럼 추가
export interface AssetMount {
  name: string;
  path: string;
  exists?: boolean;
  auto?: boolean; // PM 프로젝트 설정에서 자동으로 노출된 읽기 전용 마운트
}

// 분리 창 파일별 메타데이터(소스/태그/코멘트/컬러)
export interface AssetMeta {
  is_source: boolean;
  source_name: string | null;
  tags: string[];
  comment: string | null;
  color: string | null;
  comment_count: number;
  has_unread: boolean; // 미확인 코멘트 존재(C 뱃지)
}

// 파일 코멘트 스레드 항목
export interface AssetComment {
  id: string;
  author: string;
  author_name: string | null;
  text: string;
  created_at: string;
  parent_id: string | null; // 답글이면 부모 id
  unread?: boolean; // 생성본 코멘트 전용 — 내가 아직 확인 안 한 새 코멘트(NEW 표시·클릭해 확인)
}

// 중간클릭 정보 팝업 대상 (generation 카드 또는 Assets 파일)
export type InfoTarget =
  | { kind: "generation"; gen: Generation; x: number; y: number }
  | { kind: "file"; project: string; node: AssetNode; meta?: AssetMeta; x: number; y: number };

// 클릭 시 떠오르는 미디어 미리보기(이미지 표시 / 영상 재생)
export interface PreviewItem {
  url: string;
  type: "image" | "video" | "audio";
  name: string;
  genId?: string; // 결과물 미리보기면 그 generation id('구성에서 보기'용). 에셋(파일)이면 없음.
}
export interface PreviewTarget {
  url: string;
  type: "image" | "video" | "audio";
  name: string;
  genId?: string; // 결과물 미리보기면 그 generation id('구성에서 보기'용). 에셋(파일)이면 없음.
  // 같은 목록(그리드/폴더)의 이미지·영상 — 있으면 ←/→ 방향키로 이전·다음 이동(생성·에셋 공통).
  items?: PreviewItem[];
  index?: number; // items 내 현재 위치
}

// WebSocket 진행률 메시지
export interface ProgressMessage {
  type: "queued" | "progress" | "synced"; // synced = 주기 동기화로 변동 발생(전체 새로고침)
  generation_id?: string;
  status?: GenStatus;
  result_url?: string | null;
  error?: string;
}
