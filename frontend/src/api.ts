// 타입 안전 API 클라이언트. 모든 호출은 /api 프록시를 통해 로컬 백엔드로.
import type {
  Facets,
  GenQuery,
  GenStats,
  Generation,
  History,
  HistoryGraph,
  ModelInfo,
} from "./types";
import { authApi } from "./lib/authApi";
import { assetsApi } from "./lib/assetsApi";
import {
  getAuthToken,
  jsonBody,
  jsonFetch,
  setAuthToken,
} from "./lib/http";
import { projectApi } from "./lib/projectApi";
import { sharedApi } from "./lib/sharedApi";
import { pathPart } from "./lib/url";

export { getAuthToken, jsonFetch, setAuthToken };
export { connectProgress } from "./lib/progressSocket";

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
  if (q.folder_path) p.set("folder_path", q.folder_path); // 폴더 접두사 필터
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
  // 휴지통에서 영구 삭제(복원 불가)
  purgeTrashed: (id: string) =>
    jsonFetch<{ purged: boolean }>(`/api/trash/${pathPart(id)}`, { method: "DELETE" }),

  getGeneration: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}`),

  // 한 결과물의 가계(재료⬆/파생⬇/사용처/형제) — 히스토리 패널용
  history: (id: string) => jsonFetch<History>(`/api/generations/${pathPart(id)}/history`),

  // 연결된 가계 전체 그래프(노드+엣지+루트) — 구성탭 히스토리 트리용
  historyTree: (id: string) => jsonFetch<HistoryGraph>(`/api/generations/${pathPart(id)}/history-tree`),

  // 생성물의 실제 크레딧·소요시간(정보 팝업) — generation_metrics(매칭 실제값·허브 소요시간)
  generationMetrics: (id: string) =>
    jsonFetch<{
      est_credits: number | null;
      real_credits: number | null;
      credit_source: string | null;
      elapsed_seconds: number | null;
    }>(`/api/generations/${pathPart(id)}/metrics`),

  // 수동 히스토리 연결 — id 의 부모를 parentId 로 지정(동기화 잡 등 자동 히스토리 없는 것 묶기)
  addHistory: (id: string, parentId: string, relation: "derived" | "reference" = "derived") =>
    jsonFetch<History>(`/api/generations/${pathPart(id)}/history`, {
      method: "POST",
      body: jsonBody({ parent_gen_id: parentId, relation }),
    }),

  // 히스토리 엣지 해제 — id 와 그 부모 parentId 의 연결 풀기
  removeHistory: (id: string, parentId: string) =>
    jsonFetch<History>(`/api/generations/${pathPart(id)}/history/${pathPart(parentId)}`, { method: "DELETE" }),

  // 생성 직후 파생 부모(들) 일괄 기록 — 서버가 전이 축소(조상 잉여 엣지 제거)해 가장 가까운 부모만 남김
  deriveFrom: (id: string, parentIds: string[]) =>
    jsonFetch<History>(`/api/generations/${pathPart(id)}/derive-from`, {
      method: "POST",
      body: jsonBody({ parent_ids: parentIds }),
    }),

  facets: (tab: "my" | "team" = "my") =>
    jsonFetch<Facets>(`/api/facets?tab=${tab}`),

  models: () => jsonFetch<ModelInfo[]>("/api/models"),

  // 모델별 CLI 조절 가능 파라미터(동적 옵션)
  modelParams: (jobSetType: string) =>
    jsonFetch<import("./types").ModelParamsOut>(
      `/api/models/${pathPart(jobSetType)}/params`,
    ),

  // 예상 크레딧 추정(잡 생성 안 함) — Generate 버튼 표시용
  estimateCost: (model: string, params: Record<string, unknown>, prompt = "") =>
    jsonFetch<{ credits: number }>("/api/cost", {
      method: "POST",
      body: jsonBody({ model, params, prompt }),
    }),

  // 계정 상태(연결·크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회
  account: () =>
    jsonFetch<{ connected: boolean; credits: number | null; email: string; plan: string }>(
      "/api/account",
    ),

  // ── 제공자 신원 (작성자 표기 기준) ──────────────────────────
  // {uid(불변 앵커), name(편집 가능 표시이름), email}. CLI 이메일에서 기본값을 잡음.
  provider: () =>
    jsonFetch<{ uid: string | null; name: string | null; email: string | null }>(
      "/api/provider",
    ),

  ...projectApi,

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
      { method: "POST", body: jsonBody({ items }) },
    ),

  ...authApi,
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
    folder_path?: string; // 무장 폴더(렌더 루트 상대 경로) — 관리탭 자동 파생·완료본 저장 경로
  }) =>
    // 생성은 서버가 아니라 '내 로컬 CLI'로 실행 — 서버엔 요청만 남기고 placeholder 카드를
    // 즉시 받는다(내 PC의 push 에이전트가 실행→결과 채움). project_content_hub_push_model.
    jsonFetch<Generation>("/api/gen-requests", {
      method: "POST",
      body: jsonBody({ kind: "create", create: body }),
    }),

  regenerate: (
    id: string,
    body: { prompt?: string; color?: string | null; auto_tags?: string[] },
  ) =>
    // 재생성도 로컬 실행 요청 — placeholder 즉시 반환, 내 에이전트가 내 CLI로 실행.
    jsonFetch<Generation>("/api/gen-requests", {
      method: "POST",
      body: jsonBody({ kind: "regenerate", source_gen_id: id, regenerate: body }),
    }),

  setTags: (id: string, tags: string[]) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/tags`, {
      method: "PUT",
      body: jsonBody({ tags }),
    }),

  // 전역(auto) 태그를 이 카드에 부여/해제(교체). 신규 전역태그 생성은 사이드바 전용.
  setGenAutoTags: (id: string, auto_tags: string[]) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/auto-tags`, {
      method: "PUT",
      body: jsonBody({ auto_tags }),
    }),

  // 태그 전역 삭제(모든 생성본에서 제거) — 에셋 T 패널 ✕ 와 동일
  deleteTag: (tag: string) =>
    jsonFetch<{ removed: number }>(`/api/tags/${pathPart(tag)}`, {
      method: "DELETE",
    }),

  // 힉스필드에 안 올라간 로컬 유령 실패(failed+job_id 없음) 일괄 삭제
  clearFailed: () =>
    jsonFetch<{ removed: number }>("/api/generations/clear-failed", {
      method: "POST",
      body: jsonBody({}),
    }),
  // 힉스필드에서 삭제된 내 생성물을 찾아 휴지통으로 보냄(무료 점검 — generate get)
  trashHfMissing: () =>
    jsonFetch<{
      checked: number;
      trashed: number;
      server_checked?: number;
      server_trashed?: number;
    }>("/api/generations/trash-hf-missing", {
      method: "POST",
      body: jsonBody({}),
    }),
  // generation 1건 삭제(로컬 기록만)
  deleteGeneration: (id: string) =>
    jsonFetch<{ deleted: boolean }>(`/api/generations/${pathPart(id)}`, { method: "DELETE" }),

  // 휴지통 복구 — deleted_at 해제(카탈로그 정상 표시로)
  restoreGeneration: (id: string) =>
    jsonFetch<{ restored: boolean }>(`/api/generations/${pathPart(id)}/restore`, { method: "POST" }),

  // 자동 태그(별도 네임스페이스) — 필터 사이드바 +버튼/×
  createAutoTag: (name: string) =>
    jsonFetch<{ ok: boolean; name: string }>(`/api/auto-tags`, {
      method: "POST",
      body: jsonBody({ name }),
    }),
  deleteAutoTag: (name: string) =>
    jsonFetch<{ removed: number }>(`/api/auto-tags/${pathPart(name)}`, {
      method: "DELETE",
    }),

  setColor: (id: string, color: string | null) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/color`, {
      method: "PUT",
      body: jsonBody({ color }),
    }),

  // 소스 라이브러리 등록/해제(@이름)
  setSource: (id: string, name: string | null, is_source = true) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/source`, {
      method: "PUT",
      body: jsonBody({ name, is_source }),
    }),

  // 생성본 코멘트 스레드(공유, 에셋과 별개) — 글·답글. 팀 공유 대상.
  // 코멘트 스레드 — 캐시에 채우며 반환(호버 prefetch + stale-while-revalidate 용)
  genComments: (genId: string) =>
    jsonFetch<import("./types").GenComment[]>(
      `/api/generations/${pathPart(genId)}/comments`,
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
    jsonFetch<{ id: string }>(`/api/generations/${pathPart(genId)}/comments`, {
      method: "POST",
      body: jsonBody({ text, parent_id: parent_id ?? null, muted }),
    }),
  editGenComment: (commentId: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${pathPart(commentId)}`, {
      method: "PUT",
      body: jsonBody({ text }),
    }),
  deleteGenComment: (commentId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${pathPart(commentId)}`, { method: "DELETE" }),
  // 코멘트 한 건 확인(패널에서 NEW 코멘트 클릭) → 그 행만 seen 처리. 전부 seen 이면 카드 C 뱃지 꺼짐.
  markGenCommentSeen: (commentId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${pathPart(commentId)}/seen`, {
      method: "POST",
      body: jsonBody({}),
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

  // 팀 공유 해제(내가 공유한 것 되돌리기). ⚠️ 최종(골드)이면 409
  unpublish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/unpublish`, {
      method: "POST",
      body: jsonBody({}),
    }),

  ...sharedApi,

  // v02 CMS — Supervisor 최종(골드) 지정/해제. 공유 없으면 finalize 가 함께 발행.
  finalize: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/finalize`, { method: "POST" }),
  unfinalize: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/unfinalize`, { method: "POST" }),

  importToWorkspace: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${pathPart(id)}/import`, {
      method: "POST",
      body: jsonBody({}),
    }),

  ...assetsApi,
};
