import { jsonBody, jsonFetch } from "./http";
import { pathPart } from "./url";

export const authApi = {
  // 인증/계정(보안)
  authConfig: () => jsonFetch<import("../types").AuthConfig>("/api/auth/config"),
  register: (email: string, password: string, name?: string) =>
    jsonFetch<{ account: import("../types").Account; token: string | null }>(
      "/api/auth/register",
      { method: "POST", body: jsonBody({ email, password, name }) },
    ),
  login: (email: string, password: string) =>
    jsonFetch<{ account: import("../types").Account; token: string }>("/api/auth/login", {
      method: "POST",
      body: jsonBody({ email, password }),
    }),
  access: (email: string, password: string) =>
    jsonFetch<{ account: import("../types").Account; token: string | null; pending: boolean }>(
      "/api/auth/access",
      { method: "POST", body: jsonBody({ email, password }) },
    ),
  me: () => jsonFetch<import("../types").Account>("/api/auth/me"),
  setMyName: (name: string) =>
    jsonFetch<import("../types").Account>("/api/auth/me/name", {
      method: "POST",
      body: jsonBody({ name }),
    }),
  logout: () => jsonFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  listAccounts: (status?: string, includeHidden?: boolean) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (includeHidden) p.set("include_hidden", "true");
    const qs = p.toString();
    return jsonFetch<import("../types").Account[]>(
      `/api/auth/accounts${qs ? `?${qs}` : ""}`,
    );
  },
  setAccountStatus: (email: string, status: string) =>
    jsonFetch<import("../types").Account>(
      `/api/auth/accounts/${pathPart(email)}/status`,
      { method: "PATCH", body: jsonBody({ status }) },
    ),
  setMyPassword: (current: string, password: string) =>
    jsonFetch<{ ok: boolean }>("/api/auth/me/password", {
      method: "POST",
      body: jsonBody({ current, password }),
    }),
  adminResetPassword: (email: string) =>
    jsonFetch<{ ok: boolean }>(`/api/auth/accounts/${pathPart(email)}/reset-password`, {
      method: "POST",
    }),
  adminSetHidden: (email: string, hidden: boolean) =>
    jsonFetch<import("../types").Account>(`/api/auth/accounts/${pathPart(email)}/hidden`, {
      method: "PATCH",
      body: jsonBody({ hidden }),
    }),
};
