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
export const AUTH_STATE_HEADER = "X-MVHub-Auth-State";
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

// 상태코드를 구조로 보존한 HTTP 오류 — 구서버 폴백(404/405 판별)이 message 문자열
// 파싱에 의존하지 않게 한다. message 형식("<status>: <detail>")은 기존과 동일하게 유지.
export class HttpError extends Error {
  status: number;
  detail: string;

  constructor(status: number, message: string, detail = message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export function isHttpStatus(error: unknown, ...codes: number[]): boolean {
  return error instanceof HttpError && codes.includes(error.status);
}

/**
 * 라우트 자체가 없는 구서버 응답만 판별한다.
 *
 * 같은 404라도 "없는 작업", "접근 가능한 워크스페이스가 아님"은 정상 권한/도메인 오류다.
 * 상태코드만 보고 폴백하면 그 오류를 다른 API로 우회해 버릴 수 있으므로 FastAPI의 표준
 * 라우트 부재 본문만 구버전으로 인정한다.
 */
export function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const detail = error.detail.trim();
  return (
    (error.status === 404 && detail === "Not Found") ||
    (error.status === 405 && detail === "Method Not Allowed")
  );
}

/**
 * 요청이 '상대 서버에 못 닿아서' 실패했나 — 자격증명·권한 문제와 구분한다.
 *
 * 로컬 허브는 공유 서버 연결 실패를 502로 올린다(_proxy.raw_request). 502/504거나
 * 아예 HTTP 응답조차 못 받은 경우(fetch 자체 실패)는 주소가 틀렸을 수 있으므로,
 * 로그인 화면이 '서버 주소 변경' 패널을 자동으로 펼치는 신호로 쓴다.
 */
export function isUpstreamUnreachable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 502 || error.status === 504;
  return true;
}

export function shouldInvalidateAuth(res: Response, url: string): boolean {
  if (res.status !== 401 || url.includes("/api/auth/")) return false;
  // 새 서버·로컬 프록시는 요청별 401과 세션 만료를 구분한다. 헤더가 없는 구버전은 기존처럼
  // 로그아웃해 안전한 롤링 업데이트를 유지한다.
  return res.headers.get(AUTH_STATE_HEADER) !== "preserved";
}

export async function throwHttpError(res: Response, url: string, fallback?: string): Promise<never> {
  if (shouldInvalidateAuth(res, url)) {
    setAuthToken(null);
    dispatchAppEvent(APP_EVENTS.authRequired);
  }
  const detail = await responseErrorDetail(res, fallback);
  throw new HttpError(res.status, `${res.status}: ${detail}`, detail);
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
