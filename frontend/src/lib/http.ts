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

/** 다른 탭이 로그아웃했다 — 이 탭의 메모리 토큰만 비운다. 공유 저장소는 그 탭이 이미 비웠고, 그 뒤에 다른 탭의 새 로그인이 있을 수 있다(4B). */
export function forgetAuthToken(): void {
  authToken = null;
}

// ── 멈춤(Jay 결정 4B) — 다른 탭에서 로그아웃했는데 이 탭에 저장하지 못한 것이 있으면 화면은 남기고, 앱이 시작하는 /api 요청은
//  GET 까지 하나도 보내지 않는다(쓰는 GET 이 있다 — 프로젝트 목록 캐시·공유 서버 상태의 설정 정리·Comfy 상태의 장부 복원).
//  img·video 가 직접 부르는 그림 주소는 브라우저가 부르므로 관문 밖이다. 설계 docs/status/결정일곱_설계_2026-10-15.md 4B·E9.
export type ApiPause = "shared" | "hub" | null;
export const API_PAUSED_MESSAGE = "다른 탭에서 로그아웃해 이 탭의 서버 요청을 멈췄습니다 — 위의 띠를 보세요";
export class ApiPausedError extends Error {
  name = "ApiPausedError";
}
let apiPause: ApiPause = null;
const pauseSubs = new Set<() => void>();
export const getApiPause = (): ApiPause => apiPause;
export function setApiPause(next: ApiPause): void {
  if (apiPause === next) return;
  apiPause = next;
  pauseSubs.forEach((fn) => fn());
}
export function subscribeApiPause(fn: () => void): () => void {
  pauseSubs.add(fn);
  return () => pauseSubs.delete(fn);
}

/** 이 앱의 /api 주소인가(같은 오리진의 /api/…). */
export function isApiRequest(url: string): boolean {
  try {
    const here = new URL(globalThis.location?.href ?? "http://localhost/");
    const target = new URL(url, here);
    return target.origin === here.origin && target.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** 링크로 여는 /api 주소(DB 내보내기·다운로드 폴백)도 같은 관문을 지난다 — 멈춤이면 ApiPausedError. */
export function assertApiOpen(url: string): void {
  if (apiPause && isApiRequest(url)) throw new ApiPausedError(API_PAUSED_MESSAGE);
}

// 응답마다 그 요청에 실어 보낸 토큰 — 늦게 온 401 이 그사이 새로 로그인한 토큰을 지우지 않게(4B·D10). 관문이 적는다.
const sentTokens = new WeakMap<Response, string | null>();

/** 인증 거부를 받은 요청(연결)에 실어 보낸 토큰이 지금 토큰일 때만 로그인을 지운다 — 공유 저장소도 그 값일 때만(다른 탭이 저장한
 *  새 로그인을 옛 요청의 거부가 지우지 않게, 4B·D10). 지웠으면 true(부르는 쪽이 로그인 요구를 알린다). */
export function dropAuthIfCurrent(sent: string | null): boolean {
  if (sent !== authToken) return false;
  authToken = null;
  if ((loadString(TOKEN_KEY) || null) === sent) removeStorage(TOKEN_KEY);
  return true;
}

/** 앱의 모든 fetch 앞 관문(main.tsx 가 한 번 건다) — 직접 fetch 하는 업로드·Comfy·재시도까지 같은 자리를 지난다. */
export function installApiGate(target: { fetch: typeof fetch } = globalThis): void {
  const send = target.fetch.bind(target);
  target.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    assertApiOpen(request ? request.url : String(input));
    const auth = new Headers(init?.headers ?? request?.headers).get("Authorization");
    const res = await send(input, init);
    sentTokens.set(res, auth?.startsWith("Bearer ") ? auth.slice(7) : null);
    return res;
  };
}

// 오류 본문의 글 — 서버가 구조로 준 오류({code, message, …} — 늦은 서버의 원장 참조 등, Jay 결정 10A)는 글은 message 로, 나머지는 info 로 남긴다.
async function responseErrorDetail(res: Response, fallback?: string): Promise<{ detail: string; info?: Record<string, unknown> }> {
  let detail = fallback || res.statusText;
  try {
    const j = await res.json();
    let d = j?.detail ?? j?.message ?? j;
    if (d && typeof d === "object" && typeof d.message === "string") return { detail: d.message, info: d };
    if (typeof d !== "string") d = JSON.stringify(d);
    detail = d || detail;
  } catch {
    /* ignore */
  }
  return { detail };
}

// 상태코드를 구조로 보존한 HTTP 오류 — 구서버 폴백(404/405 판별)이 message 문자열
// 파싱에 의존하지 않게 한다. message 형식("<status>: <detail>")은 기존과 동일하게 유지.
export class HttpError extends Error {
  status: number;
  detail: string;
  info?: Record<string, unknown>; // 서버가 구조로 준 오류의 나머지(code·refs …)

  constructor(status: number, message: string, detail = message, info?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.info = info;
  }

  // 글로 바꾸면 여느 Error 와 같은 모양이다("Error: 500: …"). 안내를 만드는 곳들이 `String(e)` 의 "Error: " 앞머리만 떼는데, 이름이
  //  "HttpError" 라 그 치환을 지나 "HttpError: 500: …" 이 화면에 그대로 보였다(조작 점검 14회 격리 실측 — 단위 시험은 `new Error("…")` 로
  //  흉내 내어 못 봤다). 이름(`name`)은 그대로 둔다.
  toString(): string {
    return `Error: ${this.message}`;
  }
}

/** 안내에 붙일 실패 까닭 — 앞머리("Error: "·상태코드 "500: ")를 뗀, 서버가 준 글만. */
export function errorDetail(error: unknown): string {
  return String(error).replace(/^\w*Error:\s*(\d{3}:\s*)?/, "");
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
  // 관문 밖에서 받은 응답(시험)은 지금 토큰으로 보낸 것으로 본다.
  if (shouldInvalidateAuth(res, url) && dropAuthIfCurrent(sentTokens.has(res) ? sentTokens.get(res)! : authToken)) {
    dispatchAppEvent(APP_EVENTS.authRequired);
  }
  const { detail, info } = await responseErrorDetail(res, fallback);
  throw new HttpError(res.status, `${res.status}: ${detail}`, detail, info);
}

/**
 * 읽기 요청에 제한 시간 — 넘으면 실제로 요청을 끊고(본문 읽기까지 포함) message 로 실패한다. 허브가 멎으면 목록 줄이 끝없이
 * '불러오는 중'에 막혔다(Jay 결정 15A). 다른 이유의 실패는 그대로 던진다.
 */
export async function withRequestTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 답을 받지 못한 요청을 한 번 더 보내고도 못 받았을 때 — 서버에는 들어갔을 수 있다(Jay 결정 2A).
export const NO_RESPONSE_MESSAGE = "답을 받지 못했습니다 — 들어갔을 수 있으니 목록을 확인한 뒤 다시 누르세요";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * opts.retryNoResponse — 요청표가 있는 쓰기(생성·재생성)에만 켠다. **전송(fetch)과 본문 읽기만** 최대 두 번 — fetch 가
 * TypeError(답 없음)로 실패했거나 본문을 다 못 읽었을 때 1초 뒤 같은 헤더(요청표·변경 id·토큰)·같은 본문으로 다시 보낸다.
 * HTTP 오류·그 뒤의 데이터 보정은 다시 보내지 않는다(보정 중 TypeError 를 '답 없음'으로 오인하지 않게 — Codex C6).
 */
export async function jsonFetch<T>(
  url: string,
  init?: RequestInit,
  validateResponse?: (response: Response) => void,
  opts: { retryNoResponse?: boolean } = {},
): Promise<T> {
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
  for (let attempt = 1; ; attempt += 1) {
    const last = !opts.retryNoResponse || attempt >= 2;
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (error) {
      // 다시 보내기가 어떤 까닭으로든(멈춤 — 다른 탭 로그아웃 포함) 못 나가도 첫 요청은 들어갔을 수 있다 — 실패로 바꾸지 않는다(Codex 61회차)
      if (attempt > 1) throw new Error(NO_RESPONSE_MESSAGE);
      const noResponse = error instanceof TypeError; // AbortError(DOMException)·그 밖의 예외는 그대로
      if (!noResponse || !opts.retryNoResponse) throw error;
      await sleep(1000);
      continue;
    }
    if (!res.ok) await throwHttpError(res, url);
    validateResponse?.(res);
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
    try {
      return (await res.json()) as T;
    } catch (error) {
      // 본문을 다 못 읽었다 — 서버는 이미 처리했으니 같은 요청표로 다시 받는다. 마지막도 못 읽으면 '들어갔을 수 있다'로(Codex 2A 리뷰)
      if (last) throw opts.retryNoResponse ? new Error(NO_RESPONSE_MESSAGE) : error;
      await sleep(1000);
    }
  }
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function authFormHeaders(): HeadersInit | undefined {
  return authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
}
