import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import {
  createLibraryMutationOrigin,
  LIBRARY_CLIENT_ID_HEADER,
  LIBRARY_MUTATION_ID_HEADER,
  markLibraryMutationSucceeded,
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
    markLibraryMutationSucceeded(
      mutationOrigin,
      res.headers?.get(LIBRARY_MUTATION_ID_HEADER) ?? null,
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
