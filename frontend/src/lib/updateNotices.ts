import { jsonBody, jsonFetch } from "./http";
import type { LatestReleaseMetadata } from "./releaseUpdate";

export interface UpdateNotice {
  id: string;
  version: string;
  file: string;
  released_at: string;
  pinned: boolean;
  announcement_revision: number;
  announced_at: string | null;
  unread: boolean;
  sha256?: string;
  size?: number;
}

export const updateNoticeApi = {
  list: () => jsonFetch<UpdateNotice[]>("/api/update-notices"),
  seen: (id: string, revision: number) =>
    jsonFetch<{ ok: boolean }>(`/api/update-notices/${encodeURIComponent(id)}/seen`, {
      method: "POST",
      body: jsonBody({ revision }),
    }),
  seenAll: () =>
    jsonFetch<{ ok: boolean; seen: number }>("/api/update-notices/seen-all", {
      method: "POST",
      body: jsonBody({}),
    }),
  adminList: () => jsonFetch<UpdateNotice[]>("/api/update-notices/admin/list"),
  // 후보 sha 로 하나 — 최근 5개 밖으로 밀린 항목도 찾는다(B안). 없으면 404.
  adminItem: (sha256: string) =>
    jsonFetch<UpdateNotice>(`/api/update-notices/admin/item?sha256=${encodeURIComponent(sha256)}`),
  // [해제] — 목록·팀원 알림에서만 지운다. 없는 항목도 성공(removed=false), 404 는 옛 서버뿐.
  remove: (id: string) =>
    jsonFetch<{ ok: boolean; removed: boolean }>(
      `/api/update-notices/admin/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  register: (release: LatestReleaseMetadata) =>
    jsonFetch<{ ok: boolean; created: boolean; item: UpdateNotice }>(
      "/api/update-notices/admin/register",
      { method: "POST", body: jsonBody(release) },
    ),
  pin: (id: string, pinned: boolean) =>
    jsonFetch<{ ok: boolean; item: UpdateNotice }>(
      `/api/update-notices/admin/${encodeURIComponent(id)}/pin`,
      { method: "PUT", body: jsonBody({ pinned }) },
    ),
  announce: (id: string) =>
    jsonFetch<{ ok: boolean; item: UpdateNotice }>(
      `/api/update-notices/admin/${encodeURIComponent(id)}/announce`,
      { method: "POST", body: jsonBody({}) },
    ),
};
