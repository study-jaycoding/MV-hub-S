import { jsonBody, jsonFetch } from "./http";

export const sharedApi = {
  // 선택 발행(로컬 허브 → 원격 공유 서버) — 로컬 우선 모델
  sharedServerStatus: () =>
    jsonFetch<{
      configured: boolean;
      url: string | null;
      url_history: string[];
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
  // 주소만 확인(저장 없음) — 로그인 화면 '연결 테스트'. 서버가 이사해 로그인 화면에
  // 갇혔을 때 새 주소가 맞는지 로그인 전에 확인하는 탈출구.
  sharedServerProbe: (url: string) =>
    jsonFetch<{
      url: string;
      ok: boolean;
      reachable: boolean;
      server_version: string | null;
      reason: string | null;
    }>("/api/shared-server/probe", { method: "POST", body: jsonBody({ url }) }),
  sharedServerLogin: (url: string | null, email: string, password: string) =>
    jsonFetch<{ ok: boolean; account: import("../types").Account | null; has_token: boolean }>(
      "/api/shared-server/login",
      { method: "POST", body: jsonBody({ url, email, password }) },
    ),
  sharedServerRegister: (
    url: string | null,
    email: string,
    password: string,
    name: string | null,
  ) =>
    jsonFetch<{
      ok: boolean;
      account: import("../types").Account | null;
      pending: boolean;
      auto_logged_in: boolean;
      has_token: boolean;
    }>("/api/shared-server/register", {
      method: "POST",
      body: jsonBody({ url, email, password, name }),
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
      blocked?: number;
      message?: string;
      mirror_pending?: boolean;
      remote: { inserted: number; updated: number; unchanged: number; skipped: number };
    }>("/api/publish-to-shared", {
      method: "POST",
      body: jsonBody({ gen_ids: genIds }),
    }),
};
