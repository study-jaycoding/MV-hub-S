// 타입 안전 API 클라이언트. 모든 호출은 /api 프록시를 통해 로컬 백엔드로.
import type {
  AssetComment,
  AssetMeta,
  AssetMount,
  AssetTree,
  Creator,
  Facets,
  GenQuery,
  GenStats,
  Generation,
  History,
  HistoryGraph,
  Member,
  ModelInfo,
  Project,
  ProjectsInfo,
  ProjectsResponse,
  Workspace,
} from "./types";

// ── 인증 토큰(세션) — localStorage 영속 + 모든 요청에 Bearer 첨부 ──────────────
const TOKEN_KEY = "ch.auth.token";
let authToken: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    // 401 = 세션 만료/무효 → 토큰 폐기 + 로그인 요구 신호(App 이 받아 로그인 화면 표시)
    if (res.status === 401 && !url.includes("/api/auth/")) {
      setAuthToken(null);
      window.dispatchEvent(new CustomEvent("ch:auth-required"));
    }
    let detail = res.statusText;
    try {
      const j = await res.json();
      // detail 이 객체/배열(FastAPI 422 배열, 중첩 detail 등)이면 String 보간 시 "[object Object]"
      // 가 되므로 안전하게 평탄화한다.
      let d = j?.detail ?? j;
      if (typeof d !== "string") d = JSON.stringify(d);
      detail = d || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

// 무한 스크롤 페이지 크기. 한 페이지가 이 크기 미만이면 마지막 페이지.
export const GEN_PAGE = 200;

// 키셋(seek) 커서 — 직전 페이지 마지막 행의 (sort_ts, id). null 이면 첫 페이지.
// OFFSET 대신 이 커서로 다음 묶음을 받으므로, 몇만 번째 페이지든 서버가 일정 속도로 응답.
export interface GenCursor {
  ts: number;
  id: string;
}

// 모든 필터(기본 + 서버사이드 인스턴트)를 쿼리스트링으로. project_id·컬러·태그·타입까지
// 서버가 거르므로, 클라이언트가 전량 로드해서 거를 필요가 없다(어떤 규모든 일정 성능).
function buildQuery(q: GenQuery, cursor: GenCursor | null = null, limit = GEN_PAGE): string {
  const p = new URLSearchParams();
  p.set("tab", q.tab);
  if (q.worker_id) p.set("worker_id", q.worker_id);
  if (q.share_dir) p.set("share_dir", q.share_dir);
  if (q.local_only) p.set("local_only", "true");
  if (q.creator_uid) p.set("creator_uid", q.creator_uid);
  if (q.project_id) p.set("project_id", q.project_id); // 서버사이드 — 누락 없이 정확
  if (q.search) p.set("search", q.search);
  if (q.include_deleted) p.set("include_deleted", "true");
  if (q.deleted_only) p.set("deleted_only", "true");
  if (q.media_type) p.set("media_type", q.media_type);
  for (const c of q.colors || []) p.append("colors", c);
  for (const t of q.tags || []) p.append("tags", t);
  for (const a of q.auto_tags || []) p.append("auto_tags", a);
  if (q.shared_only) p.set("shared_only", "true");
  if (q.comment_only) p.set("comment_only", "true");
  if (q.final_only) p.set("final_only", "true");
  p.set("limit", String(limit));
  if (cursor) {
    p.set("cursor_ts", String(cursor.ts));
    p.set("cursor_id", cursor.id);
  }
  return p.toString();
}

// 코멘트 스레드 캐시(genId → 코멘트들) — 호버 prefetch + stale-while-revalidate.
// 패널이 열릴 때 캐시를 즉시 그리고, 동시에 서버 재요청으로 최신화한다.
const genCommentsCache = new Map<string, import("./types").GenComment[]>();

export const api = {
  // 한 페이지(커서 뒤 limit개)만 받아온다. 무한 스크롤이 호출. cursor=null 이면 첫 페이지.
  // 서버가 모든 필터를 거르므로 반환된 페이지가 곧 화면에 그릴 정확한 결과.
  listGenerations: (query: GenQuery, cursor: GenCursor | null = null, limit = GEN_PAGE) =>
    jsonFetch<Generation[]>(`/api/generations?${buildQuery(query, cursor, limit)}`),

  // 전역 파생값(실패 수·미확인 코멘트) — 클라이언트 전량 집계 대체.
  generationStats: () => jsonFetch<GenStats>("/api/generations-stats"),

  // ── 휴지통(별도 DB) — 지운 것 검색·복원·영구삭제 ────────────────────────
  // 지운 항목 목록(최근 삭제순, prompt·source_name 부분일치). 그리드가 그대로 그림(deleted=true).
  listTrash: (search?: string, offset = 0, limit = GEN_PAGE) => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    return jsonFetch<Generation[]>(`/api/trash?${p.toString()}`);
  },
  trashCount: () => jsonFetch<{ count: number }>("/api/trash-count"),
  // 휴지통에서 영구 삭제(복원 불가)
  purgeTrashed: (id: string) =>
    jsonFetch<{ purged: boolean }>(`/api/trash/${id}`, { method: "DELETE" }),
  // 휴지통 비우기 — beforeDays 면 그보다 오래된 것만, 없으면 전부
  emptyTrash: (beforeDays?: number) =>
    jsonFetch<{ purged: number }>("/api/trash/empty", {
      method: "POST",
      body: JSON.stringify(beforeDays != null ? { before_days: beforeDays } : {}),
    }),

  getGeneration: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}`),

  // 한 결과물의 가계(재료⬆/파생⬇/사용처/형제) — 히스토리 패널용
  history: (id: string) => jsonFetch<History>(`/api/generations/${id}/history`),

  // 연결된 가계 전체 그래프(노드+엣지+루트) — 구성탭 히스토리 트리용
  historyTree: (id: string) => jsonFetch<HistoryGraph>(`/api/generations/${id}/history-tree`),

  // 수동 히스토리 연결 — id 의 부모를 parentId 로 지정(동기화 잡 등 자동 히스토리 없는 것 묶기)
  addHistory: (id: string, parentId: string, relation: "derived" | "reference" = "derived") =>
    jsonFetch<History>(`/api/generations/${id}/history`, {
      method: "POST",
      body: JSON.stringify({ parent_gen_id: parentId, relation }),
    }),

  // 히스토리 엣지 해제 — id 와 그 부모 parentId 의 연결 풀기
  removeHistory: (id: string, parentId: string) =>
    jsonFetch<History>(`/api/generations/${id}/history/${parentId}`, { method: "DELETE" }),

  // 생성 직후 파생 부모(들) 일괄 기록 — 서버가 전이 축소(조상 잉여 엣지 제거)해 가장 가까운 부모만 남김
  deriveFrom: (id: string, parentIds: string[]) =>
    jsonFetch<History>(`/api/generations/${id}/derive-from`, {
      method: "POST",
      body: JSON.stringify({ parent_ids: parentIds }),
    }),

  facets: () => jsonFetch<Facets>("/api/facets"),

  models: () => jsonFetch<ModelInfo[]>("/api/models"),

  // 모델별 CLI 조절 가능 파라미터(동적 옵션)
  modelParams: (jobSetType: string) =>
    jsonFetch<import("./types").ModelParamsOut>(
      `/api/models/${encodeURIComponent(jobSetType)}/params`,
    ),

  // 예상 크레딧 추정(잡 생성 안 함) — Generate 버튼 표시용
  estimateCost: (model: string, params: Record<string, unknown>, prompt = "") =>
    jsonFetch<{ credits: number }>("/api/cost", {
      method: "POST",
      body: JSON.stringify({ model, params, prompt }),
    }),

  // 계정 상태(연결·크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회
  account: () =>
    jsonFetch<{ connected: boolean; credits: number | null; email: string; plan: string }>(
      "/api/account",
    ),

  // 외부 JSON(다른 작업자의 generate list export) 가져오기 — UUID 병합 + 생성자 자동 구분
  importJobs: (jobs: unknown[]) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/import-jobs",
      { method: "POST", body: JSON.stringify(jobs) },
    ),

  // content-hub 번들 내보내기(사실 + 오버레이: 레퍼런스 위치·태그·코멘트·생성자).
  // mine=true 면 내 생성자 것만. >100 제약을 누적 DB 로 우회해 전부 공유.
  exportBundle: (mine = false) =>
    jsonFetch<{ format: string; version: number; generations: unknown[] }>(
      `/api/export-bundle${mine ? "?mine=true" : ""}`,
    ),

  // content-hub 번들 가져오기 — uuid 멱등 병합(태그 union, 코멘트 dedup append)
  importBundle: (bundle: unknown) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/import-bundle",
      { method: "POST", body: JSON.stringify(bundle) },
    ),

  // ── 제공자 신원 (공유 파일명·작성자 표기 기준) ──────────────────────────
  // {uid(불변 앵커), name(편집 가능 표시이름), email}. CLI 이메일에서 기본값을 잡음.
  provider: () =>
    jsonFetch<{ uid: string | null; name: string | null; email: string | null }>(
      "/api/provider",
    ),
  // 표시이름 변경 → 이후 공유 파일명·작성자 표기에 반영(uid 는 그대로라 병합 안 깨짐)
  setProviderName: (name: string) =>
    jsonFetch<{ uid: string | null; name: string | null; email: string | null }>(
      "/api/provider",
      { method: "PATCH", body: JSON.stringify({ name }) },
    ),

  // ── 프로젝트(작업 묶음) — 공유·이동의 단위 ─────────────────────────────
  projects: (includeArchived = false) =>
    jsonFetch<ProjectsResponse>(
      `/api/projects${includeArchived ? "?include_archived=true" : ""}`,
    ),
  // 내가 최종(골드) 지정 가능한 project_id 목록(supervisor/PM). '*' = 전역 모드(전체 가능)
  myFinalizeRoles: () =>
    jsonFetch<{ project_ids: string[] }>("/api/projects/my-finalize-roles"),
  createProject: (name: string, kind = "team") =>
    jsonFetch<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    }),
  updateProject: (id: string, patch: { name?: string; archived?: boolean }) =>
    jsonFetch<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProject: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  // 관리자 탭에서 정한 프로젝트 표시 순서 저장(위→아래 순서대로의 id 목록)
  reorderProjects: (ids: string[]) =>
    jsonFetch<{ ok: boolean }>("/api/projects/reorder", {
      method: "POST",
      body: JSON.stringify({ project_ids: ids }),
    }),
  // 결과물들을 프로젝트에 귀속(project_id=null 이면 미분류로 해제)
  assignProject: (generationIds: string[], projectId: string | null) =>
    jsonFetch<{ ok: boolean; updated: number }>("/api/projects/assign", {
      method: "POST",
      body: JSON.stringify({ generation_ids: generationIds, project_id: projectId }),
    }),

  // 팀 크레딧 집계(에이전트가 push 때 보고한 마지막 잔액 기준)
  credits: () => jsonFetch<import("./types").CreditSummary>("/api/credits"),

  // 로그인 계정 본인이 에이전트로 보고한 힉스필드 상태(크레딧·워크스페이스) — 비-하우스 계정 메뉴용
  accountHf: () => jsonFetch<import("./types").ReportedHfStatus>("/api/account/hf"),

  // 내 에이전트 연결 상태(롱폴 대기 중인가) — 연결 점 표시용
  agentStatus: () => jsonFetch<{ connected: boolean }>("/api/agent/status"),
  // "내 작업 올리기" — 내 에이전트를 깨워 로컬 결과물을 즉시 push
  agentSync: () =>
    jsonFetch<{ ok: boolean; connected: boolean }>("/api/agent/sync", { method: "POST" }),
  // 과거 백필 — MCP show_generations 원시 아이템 배열을 웹 세션으로 직접 적재(파일 업로드 경로). 멱등.
  ingestMcp: (items: unknown[]) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number; linked_uid: string | null }>(
      "/api/ingest/mcp",
      { method: "POST", body: JSON.stringify({ items }) },
    ),

  // ── 인증/계정(보안) — 로드맵 §4-1/§4-2 ────────────────────────────────
  authConfig: () =>
    jsonFetch<import("./types").AuthConfig>("/api/auth/config"),
  register: (email: string, password: string, name?: string) =>
    jsonFetch<{ account: import("./types").Account; token: string | null }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name }) },
    ),
  login: (email: string, password: string) =>
    jsonFetch<{ account: import("./types").Account; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  // 로그인=가입 통합 — 처음 보는 이메일이면 자동 등록(승인 대기), 있으면 로그인. pending=승인 전.
  access: (email: string, password: string) =>
    jsonFetch<{ account: import("./types").Account; token: string | null; pending: boolean }>(
      "/api/auth/access",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),
  me: () => jsonFetch<import("./types").Account>("/api/auth/me"),
  // 본인 표시이름 변경(계정별) — 갱신된 account 반환
  setMyName: (name: string) =>
    jsonFetch<import("./types").Account>("/api/auth/me/name", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  logout: () => jsonFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  // 관리자: 계정 목록·승인/거부·등급
  listAccounts: (status?: string, includeHidden?: boolean) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (includeHidden) p.set("include_hidden", "true");
    const qs = p.toString();
    return jsonFetch<import("./types").Account[]>(
      `/api/auth/accounts${qs ? `?${qs}` : ""}`,
    );
  },
  setAccountStatus: (email: string, status: string) =>
    jsonFetch<import("./types").Account>(
      `/api/auth/accounts/${encodeURIComponent(email)}/status`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),
  // 본인 비밀번호 변경 — 현재 비번 확인 후 새 비번. 에이전트 로그인에도 같은 비번을 쓴다.
  setMyPassword: (current: string, password: string) =>
    jsonFetch<{ ok: boolean }>("/api/auth/me/password", {
      method: "POST",
      body: JSON.stringify({ current, password }),
    }),
  // 관리자: 비밀번호 111111 로 초기화
  adminResetPassword: (email: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/auth/accounts/${encodeURIComponent(email)}/reset-password`,
      { method: "POST" },
    ),
  // 관리자: 계정 숨김/표시
  adminSetHidden: (email: string, hidden: boolean) =>
    jsonFetch<import("./types").Account>(
      `/api/auth/accounts/${encodeURIComponent(email)}/hidden`,
      { method: "PATCH", body: JSON.stringify({ hidden }) },
    ),
  // v02 전역 역할(복수) 부여(enforcement 가 읽는 축)
  setAccountGlobalRoles: (email: string, global_roles: string[]) =>
    jsonFetch<import("./types").Account>(
      `/api/auth/accounts/${encodeURIComponent(email)}/global-roles`,
      { method: "PATCH", body: JSON.stringify({ global_roles }) },
    ),

  // ── 멤버·전역역할(복수) — 관리자 창 ────────────────────────────────────
  members: () => jsonFetch<Member[]>("/api/members"),
  // v02 전역 역할(복수) 부여 → 갱신된 멤버 목록
  setMemberGlobalRoles: (uid: string, global_roles: string[]) =>
    jsonFetch<Member[]>(`/api/members/${encodeURIComponent(uid)}/global-roles`, {
      method: "PATCH",
      body: JSON.stringify({ global_roles }),
    }),
  // ── 프로젝트 멤버·역할(v02 RBAC PART 1) ─────────────────────────────────
  projectMembers: (pid: string) =>
    jsonFetch<import("./types").ProjectMember[]>(
      `/api/projects/${encodeURIComponent(pid)}/members`,
    ),
  // 모든 프로젝트 멤버를 1회로 {pid: [...]} — 관리자 창 prefetch(요청 N→1)
  projectMembersAll: () =>
    jsonFetch<Record<string, import("./types").ProjectMember[]>>(
      "/api/projects/members-all",
    ),
  setProjectRoles: (pid: string, creator_uid: string, project_roles: string[]) =>
    jsonFetch<import("./types").ProjectMember[]>(
      `/api/projects/${encodeURIComponent(pid)}/members`,
      { method: "PATCH", body: JSON.stringify({ creator_uid, project_roles }) },
    ),
  // 프로젝트에서 멤버 제거(행 삭제) → 갱신된 멤버 목록
  removeProjectMember: (pid: string, uid: string) =>
    jsonFetch<import("./types").ProjectMember[]>(
      `/api/projects/${encodeURIComponent(pid)}/members/${encodeURIComponent(uid)}`,
      { method: "DELETE" },
    ),

  // ── 팀 공유 파일(data/shared) ──────────────────────────────────────────
  // 내 share 파일을 현재 share-set(공유 표시된 것들)으로 강제 재생성
  rebuildShare: () =>
    jsonFetch<{ path: string | null; count: number }>("/api/share/rebuild", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // shared 폴더에서 받은(남의) share 파일 요약 목록 — in 뷰
  receivedShares: () =>
    jsonFetch<{
      items: {
        filename: string;
        provider: { uid: string | null; name: string | null; email: string | null };
        count: number;
      }[];
    }>("/api/share/received"),
  // 받은 share 파일 1개를 내 라이브러리로 병합(받기)
  importReceived: (filename: string) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/share/received/import",
      { method: "POST", body: JSON.stringify({ filename }) },
    ),
  // shared 폴더의 받은 share 파일 전부 일괄 병합
  importReceivedAll: () =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/share/received/import-all",
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 생성자(팀 워크스페이스 작성자) — 목록·이름붙이기
  creators: (tab: "my" | "team" = "my", projectId?: string) => {
    const p = new URLSearchParams({ tab });
    if (projectId) p.set("project_id", projectId);
    return jsonFetch<Creator[]>(`/api/creators?${p.toString()}`);
  },
  renameCreator: (uid: string, name: string) =>
    jsonFetch<{ ok: boolean }>(`/api/creators/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  // 이 생성자를 '나'로 지정 → 그 작업이 내 작업(is_mine)으로 잡히고 제공자 이름 표시.
  // 팀 워크스페이스에선 CLI 가 내 user_<id> 를 안 줘서 1회 지정 필요(초기화 후엔 다시).
  claimCreator: (uid: string) =>
    jsonFetch<{ my_creator_uid: string | null; name: string | null }>(
      `/api/creators/${encodeURIComponent(uid)}/claim`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 워크스페이스(팀 공유 UUID 공간) — 목록·선택·해제
  workspaces: () => jsonFetch<Workspace[]>("/api/workspaces"),
  selectWorkspace: (workspace_id: string) =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/select", {
      method: "POST",
      body: JSON.stringify({ workspace_id }),
    }),
  unselectWorkspace: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/unselect", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  sync: () =>
    jsonFetch<{ fetched: number; inserted: number; updated: number }>(
      "/api/sync",
      { method: "POST" },
    ),

  // 출처 영속화: 소스·결과물을 로컬로 보관(원격 URL 만료 무관하게 재사용 가능)
  cacheAll: () =>
    jsonFetch<{ cached: number; failed: number; generations: number }>(
      "/api/cache-all",
      { method: "POST" },
    ),

  create: (body: {
    prompt: string;
    display_prompt?: string;
    model: string;
    params?: Record<string, unknown>;
    color?: string | null;
    tags?: string[];
    auto_tags?: string[];
    references?: {
      file_path: string;
      type: string;
      role: string;
      name?: string;
      thumbnail?: string;
      source_url?: string;
      source_gen_id?: string; // 출처 generation → 히스토리 reference 엣지
    }[];
    project_id?: string; // 생성 시 보던 프로젝트로 자동 귀속
  }) =>
    // 생성은 서버가 아니라 '내 로컬 CLI'로 실행 — 서버엔 요청만 남기고 placeholder 카드를
    // 즉시 받는다(내 PC의 push 에이전트가 실행→결과 채움). project_content_hub_push_model.
    jsonFetch<Generation>("/api/gen-requests", {
      method: "POST",
      body: JSON.stringify({ kind: "create", create: body }),
    }),

  regenerate: (
    id: string,
    body: { prompt?: string; color?: string | null; auto_tags?: string[] },
  ) =>
    // 재생성도 로컬 실행 요청 — placeholder 즉시 반환, 내 에이전트가 내 CLI로 실행.
    jsonFetch<Generation>("/api/gen-requests", {
      method: "POST",
      body: JSON.stringify({ kind: "regenerate", source_gen_id: id, regenerate: body }),
    }),

  // 진행중(pending/running) 내 로컬 생성물 — '생성중' 카드 표시용. 로컬 큐라 프록시 안 됨(이 허브 DB).
  // 서버 직결 모드에선 서버에 완료분만 오므로, 이걸 받아 서버 라이브러리 위에 머지한다.
  activeGenRequests: () => jsonFetch<Generation[]>("/api/gen-requests/active"),

  setTags: (id: string, tags: string[]) =>
    jsonFetch<Generation>(`/api/generations/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    }),

  // 태그 전역 삭제(모든 생성본에서 제거) — 에셋 T 패널 ✕ 와 동일
  deleteTag: (tag: string) =>
    jsonFetch<{ removed: number }>(`/api/tags/${encodeURIComponent(tag)}`, {
      method: "DELETE",
    }),

  // 힉스필드 존재 검증(generate get) → 삭제된 것 hf_missing 표시. 로컬 보기/흐림에 반영
  verifyHiggsfield: () =>
    jsonFetch<{ checked: number; missing: number }>(
      "/api/generations/verify-higgsfield",
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 힉스필드에 안 올라간 로컬 유령 실패(failed+job_id 없음) 일괄 삭제
  clearFailed: () =>
    jsonFetch<{ removed: number }>("/api/generations/clear-failed", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // generation 1건 삭제(로컬 기록만)
  deleteGeneration: (id: string) =>
    jsonFetch<{ deleted: boolean }>(`/api/generations/${id}`, { method: "DELETE" }),

  // 휴지통 복구 — deleted_at 해제(카탈로그 정상 표시로)
  restoreGeneration: (id: string) =>
    jsonFetch<{ restored: boolean }>(`/api/generations/${id}/restore`, { method: "POST" }),

  // 자동 태그(별도 네임스페이스) — 필터 사이드바 +버튼/×
  createAutoTag: (name: string) =>
    jsonFetch<{ ok: boolean; name: string }>(`/api/auto-tags`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteAutoTag: (name: string) =>
    jsonFetch<{ removed: number }>(`/api/auto-tags/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  setColor: (id: string, color: string | null) =>
    jsonFetch<Generation>(`/api/generations/${id}/color`, {
      method: "PUT",
      body: JSON.stringify({ color }),
    }),

  // 소스 라이브러리 등록/해제(@이름)
  setSource: (id: string, name: string | null, is_source = true) =>
    jsonFetch<Generation>(`/api/generations/${id}/source`, {
      method: "PUT",
      body: JSON.stringify({ name, is_source }),
    }),

  setComment: (id: string, comment: string | null) =>
    jsonFetch<Generation>(`/api/generations/${id}/comment`, {
      method: "PUT",
      body: JSON.stringify({ comment }),
    }),

  // 생성본 코멘트 스레드(공유, 에셋과 별개) — 글·답글. 팀 공유 대상.
  // 코멘트 스레드 — 캐시에 채우며 반환(호버 prefetch + stale-while-revalidate 용)
  genComments: (genId: string) =>
    jsonFetch<import("./types").GenComment[]>(
      `/api/generations/${encodeURIComponent(genId)}/comments`,
    ).then((c) => {
      genCommentsCache.set(genId, c);
      return c;
    }),
  // 캐시된 코멘트(없으면 undefined) — 패널이 먼저 그려놓고 뒤에서 갱신해 체감 딜레이 제거
  genCommentsCached: (genId: string): import("./types").GenComment[] | undefined =>
    genCommentsCache.get(genId),
  // 호버 시 미리 불러와 캐시를 채운다(에러 무시) — 클릭 전에 준비되게.
  // 이미 캐시에 있으면 재요청 안 함(호버 연타 방지) — 최신화는 패널이 열릴 때 한다.
  prefetchGenComments: (genId: string): void => {
    if (genCommentsCache.has(genId)) return;
    void api.genComments(genId).catch(() => {});
  },
  addGenComment: (
    genId: string,
    text: string,
    parent_id?: string | null,
    muted = false,
  ) =>
    jsonFetch<{ id: string }>(`/api/generations/${encodeURIComponent(genId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ text, parent_id: parent_id ?? null, muted }),
    }),
  editGenComment: (commentId: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteGenComment: (commentId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${commentId}`, { method: "DELETE" }),
  markGenCommentsRead: (genId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/generations/${encodeURIComponent(genId)}/comments/read`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  // 코멘트 한 건 확인(패널에서 NEW 코멘트 클릭) → 그 행만 seen 처리. 전부 seen 이면 카드 C 뱃지 꺼짐.
  markGenCommentSeen: (commentId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${commentId}/seen`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // 스포트라이트 @/# 피커: 소스를 이름(query) 또는 태그(tag)로 검색.
  // assetProject/assetDir 를 주면 에셋 파트 소스(그 폴더로 스코프)도 합류한다.
  searchSources: (query?: string, tag?: string, assetProject?: string, assetDir?: string) => {
    const q = new URLSearchParams();
    if (query) q.set("query", query);
    if (tag) q.set("tag", tag);
    if (assetProject) q.set("asset_project", assetProject);
    if (assetDir) q.set("asset_dir", assetDir);
    return jsonFetch<Generation[]>(`/api/sources?${q.toString()}`);
  },

  publish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ visibility: "team" }),
    }),

  // 팀 공유 해제(내가 공유한 것 되돌리기). ⚠️ 최종(골드)이면 409
  unpublish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/unpublish`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // ── 선택 발행(로컬 허브 → 원격 공유 서버) — 로컬 우선 모델 ───────────────────
  sharedServerStatus: () =>
    jsonFetch<{
      configured: boolean;
      url: string | null;
      email: string | null;
      name: string | null;
      roles: string[];
      is_admin: boolean;
      has_token: boolean;
      elevated: boolean;
      elevated_as: string | null;
    }>("/api/shared-server/status"),
  // 임시 관리자 권한 — 본인 계정 유지한 채 admin 비번으로 '승인 절차' 권한만 일시 획득.
  sharedServerElevate: (email: string, password: string) =>
    jsonFetch<{ ok: boolean; elevated_as: string; elevated: boolean }>(
      "/api/shared-server/elevate",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),
  sharedServerDeElevate: () =>
    jsonFetch<{ ok: boolean; elevated: boolean }>("/api/shared-server/de-elevate", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // 공유 서버(팀 계정) 로그인 → 토큰 저장. url 비우면 기본/설정 주소 사용.
  sharedServerLogin: (url: string | null, email: string, password: string) =>
    jsonFetch<{ ok: boolean; account: import("./types").Account | null; has_token: boolean }>(
      "/api/shared-server/login",
      { method: "POST", body: JSON.stringify({ url, email, password }) },
    ),
  sharedServerRegister: (email: string, password: string, name: string | null) =>
    jsonFetch<{
      ok: boolean;
      account: import("./types").Account | null;
      pending: boolean;
      auto_logged_in: boolean;
      has_token: boolean;
    }>("/api/shared-server/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  sharedServerLogout: () =>
    jsonFetch<{ ok: boolean; has_token: boolean }>("/api/shared-server/logout", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // 공유 서버 주소 변경 — 관리자 창 '공유 서버' 탭(admin 전용)
  setSharedServerUrl: (url: string) =>
    jsonFetch<{ url: string | null; is_admin: boolean }>("/api/shared-server/url", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  // 고른 생성물만 공유 서버로 발행(기존 번들 직렬화 재활용)
  publishToShared: (genIds: string[]) =>
    jsonFetch<{
      ok: boolean;
      published: number;
      remote: { inserted: number; updated: number; unchanged: number; skipped: number };
    }>("/api/publish-to-shared", {
      method: "POST",
      body: JSON.stringify({ gen_ids: genIds }),
    }),

  // v02 CMS — Supervisor 최종(골드) 지정/해제. 공유 없으면 finalize 가 함께 발행.
  finalize: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/finalize`, { method: "POST" }),
  unfinalize: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/unfinalize`, { method: "POST" }),

  importToWorkspace: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/import`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Assets(구성) 패널
  assetProjects: () => jsonFetch<ProjectsInfo>("/api/assets/projects"),

  // 외부 폴더 등록(마운트) — 임의 경로 폴더에 이름을 붙여 프로젝트처럼 추가
  assetMounts: () => jsonFetch<{ mounts: AssetMount[] }>("/api/assets/mounts"),
  addAssetMount: (name: string, path: string) =>
    jsonFetch<{ mounts: AssetMount[] }>("/api/assets/mounts", {
      method: "POST",
      body: JSON.stringify({ name, path }),
    }),
  delAssetMount: (name: string) =>
    jsonFetch<{ mounts: AssetMount[] }>(
      `/api/assets/mounts/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  assetTree: (project: string) =>
    jsonFetch<AssetTree>(`/api/assets/tree?project=${encodeURIComponent(project)}`),

  // 파일 URL (원본/미리보기). 프록시를 통해 백엔드가 서빙.
  assetFileUrl: (project: string, path: string) =>
    `/api/assets/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,

  // 리사이즈 썸네일 URL(이미지 전용) — 그리드/리스트 스크롤 성능용. 디스크 캐시.
  assetThumbUrl: (project: string, path: string, w = 512) =>
    `/api/assets/thumb?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&w=${w}`,

  // 생성 미디어 썸네일 URL(로컬 /media 이미지 전용) — 풀해상도 원본 대신 작은 이미지 디코딩.
  genThumbUrl: (mediaPath: string, w = 512) =>
    `/api/media-thumb?src=${encodeURIComponent(mediaPath)}&w=${w}`,

  // 외부 파일 가져오기(드롭 업로드) → 현재 폴더(dir)에 저장. multipart 라 jsonFetch 미사용.
  uploadAssets: async (project: string, dir: string, files: File[]) => {
    const fd = new FormData();
    fd.append("project", project);
    fd.append("dir", dir);
    for (const f of files) fd.append("files", f);
    const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        let d = j?.detail ?? j;
        if (typeof d !== "string") d = JSON.stringify(d);
        detail = d || detail;
      } catch {
        /* ignore */
      }
      throw new Error(`${res.status}: ${detail}`);
    }
    return res.json() as Promise<{ saved: string[]; skipped: string[] }>;
  },

  // OS 파일 탐색기에서 원본 위치 열기(해당 파일 선택)
  revealAsset: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/reveal`, {
      method: "POST",
      body: JSON.stringify({ project, path }),
    }),

  // 로컬 보관된 결과물/소스(/media/...)의 원본 위치를 탐색기에서 열기
  revealMedia: (path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/reveal-media`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  // 분리 창 파일별 메타데이터 (미확인 뱃지는 코멘트별 muted 플래그를 따름)
  assetMeta: (project: string) =>
    jsonFetch<Record<string, AssetMeta>>(
      `/api/assets/meta?project=${encodeURIComponent(project)}`,
    ),

  // 파일 코멘트 스레드(공유)
  assetComments: (project: string, path: string) =>
    jsonFetch<AssetComment[]>(
      `/api/assets/comments?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    ),
  addAssetComment: (
    project: string,
    path: string,
    text: string,
    parent_id?: string | null,
    muted = false,
  ) =>
    jsonFetch<{ id: string }>(`/api/assets/comments`, {
      method: "POST",
      body: JSON.stringify({ project, path, text, parent_id: parent_id ?? null, muted }),
    }),
  editAssetComment: (id: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteAssetComment: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${id}`, { method: "DELETE" }),
  markCommentsRead: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/read`, {
      method: "POST",
      body: JSON.stringify({ project, path }),
    }),
  setAssetSource: (project: string, path: string, name: string | null, is_source: boolean) =>
    jsonFetch(`/api/assets/source`, {
      method: "PUT",
      body: JSON.stringify({ project, path, name, is_source }),
    }),
  setAssetTags: (project: string, path: string, tags: string[]) =>
    jsonFetch(`/api/assets/tags`, {
      method: "PUT",
      body: JSON.stringify({ project, path, tags }),
    }),
  setAssetComment: (project: string, path: string, comment: string | null) =>
    jsonFetch(`/api/assets/comment`, {
      method: "PUT",
      body: JSON.stringify({ project, path, comment }),
    }),
  setAssetColor: (project: string, path: string, color: string | null) =>
    jsonFetch(`/api/assets/color`, {
      method: "PUT",
      body: JSON.stringify({ project, path, color }),
    }),
};

// WebSocket 진행률 구독. 끊기면 자동 재연결(백오프)하고, (재)연결될 때마다
// onReconnect 로 알린다 → 끊긴 동안 놓친 상태 전이를 reload 로 따라잡게 한다.
export function connectProgress(
  onMessage: (m: import("./types").ProgressMessage) => void,
  onReconnect?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
      onReconnect?.(); // 연결/재연결 시 최신 상태로 동기화
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (closed) return;
      backoff = Math.min(backoff * 1.6, 15000);
      retry = setTimeout(connect, backoff); // 백엔드 재시작/네트워크 끊김 → 재연결
    };
    // 일부 프록시는 idle 연결을 끊으므로 keepalive ping
    ping = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  };
  connect();

  return () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
