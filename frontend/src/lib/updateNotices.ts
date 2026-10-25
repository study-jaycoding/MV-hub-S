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
  // 해제·고정·공지는 2026-10-23 서버 관리 창 [릴리스]로 옮겼다 — 웹은 선설치용 등록만 한다.
  register: (release: LatestReleaseMetadata) =>
    jsonFetch<{ ok: boolean; created: boolean; item: UpdateNotice }>(
      "/api/update-notices/admin/register",
      { method: "POST", body: jsonBody(release) },
    ),
};
