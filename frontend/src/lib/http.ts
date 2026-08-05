import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import {
  createLibraryMutationOrigin,
  LIBRARY_CLIENT_ID_HEADER,
  LIBRARY_MUTATION_ID_HEADER,
  markMutationDomainsSucceeded,
  MUTATION_DOMAINS_HEADER,
  type MutationDomain,
} from "./librarySync";
import { loadString, removeStorage, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

const TOKEN_KEY = STORAGE_KEYS.authToken;
let authToken: string | null = (() => {
  const token = loadString(TOKEN_KEY);
  return token || null;
})();

export function setAuthToken(token: string | null): void {
  authToken = token;
  if (token) saveString(TOKEN_KEY, token);
  else removeStorage(TOKEN_KEY);
}

export function getAuthToken(): string | null {
  return authToken;
}

async function responseErrorDetail(res: Response, fallback?: string): Promise<string> {
  let detail = fallback || res.statusText;
  try {
    const j = await res.json();
    let d = j?.detail ?? j?.message ?? j;
    if (typeof d !== "string") d = JSON.stringify(d);
    detail = d || detail;
  } catch {
    /* ignore */
  }
  return detail;
}

export async function throwHttpError(res: Response, url: string, fallback?: string): Promise<never> {
  if (res.status === 401 && !url.includes("/api/auth/")) {
    setAuthToken(null);
    dispatchAppEvent(APP_EVENTS.authRequired);
  }
  throw new Error(`${res.status}: ${await responseErrorDetail(res, fallback)}`);
}

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const mutationOrigin = createLibraryMutationOrigin(init?.method);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (mutationOrigin) {
    headers[LIBRARY_CLIENT_ID_HEADER] = mutationOrigin.client_id;
    headers[LIBRARY_MUTATION_ID_HEADER] = mutationOrigin.mutation_id;
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) await throwHttpError(res, url);
  if (mutationOrigin) {
    const domainHeader = res.headers?.get(MUTATION_DOMAINS_HEADER) ?? null;
    // P36 서버는 변경 id만 되돌려주므로 도메인 헤더가 없으면 library로 간주해 롤링 업데이트를
    // 유지한다. 새 서버의 명시적 빈/알 수 없는 값은 임의로 성공 처리하지 않는다.
    const domains: MutationDomain[] = domainHeader === null
      ? ["library"]
      : domainHeader
          .split(",")
          .map((part) => part.trim())
          .filter((part): part is MutationDomain =>
            part === "library" || part === "assets" || part === "manage",
          );
    markMutationDomainsSucceeded(
      mutationOrigin,
      res.headers?.get(LIBRARY_MUTATION_ID_HEADER) ?? null,
      domains,
    );
  }
  return res.json() as Promise<T>;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function authFormHeaders(): HeadersInit | undefined {
  return authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
}
