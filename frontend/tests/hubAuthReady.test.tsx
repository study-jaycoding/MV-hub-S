// @vitest-environment jsdom
// authReady 는 인증 설정(auth/config)을 받기 전에는 거짓이다(2026-10-03 점검 S1).
// 전에는 설정을 받기 전에도 참이라 목록·통계·패싯·프로젝트(3.38MB 급 목록 포함)를 한 번 먼저 받았다가, 계정이 확정되면 버리고 다시 받았다.
// AUTH-off(로컬 허브)는 화면 게이트와 같은 시점 — 공유 서버 상태를 받은 뒤 — 에 준비된다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: Root | null;
let host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount(routes: Record<string, () => Promise<Response>>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    seen.push(url);
    const route = routes[url];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route();
  }));
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  const ready: boolean[] = [];
  function Host() {
    ready.push(useHubAuth().authReady);
    return null;
  }
  await act(async () => root!.render(<Host />));
  return { seen, ready };
}

it("AUTH-off: 설정·공유 서버 상태를 받기 전에는 준비되지 않고, 최종 권한도 묻지 않는다", async () => {
  const config = deferred<Response>();
  const status = deferred<Response>();
  const { seen, ready } = await mount({
    "/api/auth/config": () => config.promise,
    "/api/shared-server/status": () => status.promise,
    "/api/projects/my-finalize-roles": () => Promise.resolve(response({ project_ids: [] })),
  });
  expect(ready.at(-1)).toBe(false);
  expect(seen).not.toContain("/api/projects/my-finalize-roles");

  await act(async () => { config.resolve(response({ auth_enabled: false, has_accounts: false })); });
  expect(ready.at(-1)).toBe(false); // 화면도 공유 서버 상태를 기다린다(App 의 sharedSrv === null 게이트)

  await act(async () => { status.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" })); });
  expect(ready.at(-1)).toBe(true);
  expect(seen).toContain("/api/projects/my-finalize-roles"); // 설정을 받은 뒤에야 묻는다
});

it.each([
  [502, true],
  [403, false],
])("최종 권한 조회가 %s 로 실패하면 30초 뒤 다시 묻는가 = %s (서버가 돌아와도 '권한 없음'으로 굳지 않게, 2026-10-03)", async (status, retries) => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const { useHubAuth } = await (async () => {
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
        if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" }));
        if (url === "/api/projects/my-finalize-roles") {
          calls += 1;
          return Promise.resolve(calls === 1
            ? new Response(JSON.stringify({ detail: "공유 서버 연결 실패" }), { status })
            : response({ project_ids: ["p1"] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }));
      return import("../src/lib/useHubAuth");
    })();
    let finalize = new Set<string>();
    function Host() {
      finalize = useHubAuth().finalizeProjects;
      return null;
    }
    await act(async () => root!.render(<Host />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(calls).toBe(1);
    expect(finalize.size).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(calls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(retries ? 2 : 1);
    expect([...finalize]).toEqual(retries ? ["p1"] : []);
    await act(async () => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0); // 성공·확정 거부 뒤엔 남은 재시도 타이머가 없다
  } finally {
    vi.useRealTimers();
  }
});

it("AUTH-on: 설정이 오기 전 참이었다가 거짓으로 출렁이지 않는다(로그인 전에는 거짓)", async () => {
  const config = deferred<Response>();
  const { ready } = await mount({ "/api/auth/config": () => config.promise });
  expect(ready.every((value) => value === false)).toBe(true);
  await act(async () => { config.resolve(response({ auth_enabled: true, has_accounts: true })); });
  expect(ready.every((value) => value === false)).toBe(true); // 토큰 없음 → 로그인 화면, 여전히 준비 안 됨
});
