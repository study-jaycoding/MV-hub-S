import { jsonBody, jsonFetch } from "./http";

export const sharedApi = {
  // 선택 발행(로컬 허브 → 원격 공유 서버) — 로컬 우선 모델
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
  sharedServerElevate: (email: string, password: string) =>
    jsonFetch<{ ok: boolean; elevated_as: string; elevated: boolean }>(
      "/api/shared-server/elevate",
      { method: "POST", body: jsonBody({ email, password }) },
    ),
  sharedServerDeElevate: () =>
    jsonFetch<{ ok: boolean; elevated: boolean }>("/api/shared-server/de-elevate", {
      method: "POST",
      body: jsonBody({}),
    }),
  sharedServerLogin: (url: string | null, email: string, password: string) =>
    jsonFetch<{ ok: boolean; account: import("../types").Account | null; has_token: boolean }>(
      "/api/shared-server/login",
      { method: "POST", body: jsonBody({ url, email, password }) },
    ),
  sharedServerRegister: (email: string, password: string, name: string | null) =>
    jsonFetch<{
      ok: boolean;
      account: import("../types").Account | null;
      pending: boolean;
      auto_logged_in: boolean;
      has_token: boolean;
    }>("/api/shared-server/register", {
      method: "POST",
      body: jsonBody({ email, password, name }),
    }),
  sharedServerLogout: () =>
    jsonFetch<{ ok: boolean; has_token: boolean }>("/api/shared-server/logout", {
      method: "POST",
      body: jsonBody({}),
    }),
  setSharedServerUrl: (url: string) =>
    jsonFetch<{ url: string | null; is_admin: boolean }>("/api/shared-server/url", {
      method: "POST",
      body: jsonBody({ url }),
    }),
  publishToShared: (genIds: string[]) =>
    jsonFetch<{
      ok: boolean;
      published: number;
      remote: { inserted: number; updated: number; unchanged: number; skipped: number };
    }>("/api/publish-to-shared", {
      method: "POST",
      body: jsonBody({ gen_ids: genIds }),
    }),
};
