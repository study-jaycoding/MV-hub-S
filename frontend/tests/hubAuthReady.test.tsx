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
beforeEach(async () => {
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

it("최종 조작이 403 으로 거절됐다는 알림이 오면 최종 권한을 다시 읽는다 — 회수된 검수 역할의 단추가 남지 않게(49회차)", async () => {
  let roles = ["p1"];
  const { seen } = await mount({
    "/api/auth/config": () => Promise.resolve(response({ auth_enabled: false, has_accounts: false })),
    "/api/shared-server/status": () => Promise.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" })),
    "/api/projects/my-finalize-roles": () => Promise.resolve(response({ project_ids: roles })),
  });
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
  let finalize = new Set<string>();
  function Probe() { finalize = useHubAuth().finalizeProjects; return null; }
  await act(async () => root!.render(<Probe />));
  await act(async () => { await Promise.resolve(); });
  expect([...finalize]).toEqual(["p1"]);
  roles = []; // 다른 관리자가 검수 역할을 회수했다
  await act(async () => { dispatchAppEvent(APP_EVENTS.finalizeRolesStale); });
  await act(async () => { await Promise.resolve(); });
  expect([...finalize]).toEqual([]);
  expect(seen.filter((url) => url === "/api/projects/my-finalize-roles").length).toBeGreaterThanOrEqual(2);
});

// 14회차(조작 규칙 41): AUTH-off 의 로그아웃은 허브에 세션 정리를 시키고 새로 고친다. 전엔 그 요청의 실패를 삼키고 새로 고쳐,
//  허브에 세션이 남은 채 로그인 화면 없이 같은 계정으로 말없이 돌아왔다(로그아웃된 줄 안다).
it("AUTH-off 로그아웃 — 허브가 실패를 답하면 새로 고치지 않고 알리며 '로그아웃 안 됨'을 돌려준다", async () => {
  const reloadPage = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
    hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: reloadPage });
  let hubAnswers = false;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
    if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" }));
    if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
    if (url === "/api/shared-server/logout") {
      return Promise.resolve(hubAnswers ? response({ ok: true, has_token: false }) : new Response(JSON.stringify({ detail: "boom" }), { status: 500 }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const flashes: string[] = [];
  const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  try {
    const { useHubAuth } = await import("../src/lib/useHubAuth");
    let logout!: () => Promise<boolean>;
    function Host() {
      logout = useHubAuth().logout;
      return null;
    }
    await act(async () => root!.render(<Host />));
    await act(async () => {});
    let loggedOut: boolean | undefined;
    await act(async () => { loggedOut = await logout(); });
    expect(loggedOut).toBe(false);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(flashes).toEqual(["로그아웃하지 못했습니다 — 잠시 뒤 다시 시도하세요."]);
    hubAnswers = true;
    await act(async () => { loggedOut = await logout(); });
    expect(loggedOut).toBe(true);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(flashes).toHaveLength(1);
  } finally {
    window.removeEventListener("ch:flash", onFlash);
  }
});

// 배포 전 재검토(2026-10-13, Codex): 저장하지 못한 편집(편집 탭 — lib/unloadGuard 가 쥔다)이 있는데 로그아웃하면 새로고침으로 그 편집이
//  사라진다. 계정·서버의 상태를 바꾸기 전에 묻는다 — 바꾼 뒤에 새로고침만 막으면 화면이 옛 계정의 것으로 남는다.
it("저장하지 못한 편집이 있으면 로그아웃 전에 묻는다 — 취소하면 아무것도 하지 않고, 계속하면 묻지 않고 새로 고친다", async () => {
  const reloadPage = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
    hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: reloadPage });
  const asked: string[] = [];
  let answer = false;
  vi.stubGlobal("confirm", (message: string) => { asked.push(message); return answer; });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    requests.push(url);
    if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
    if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" }));
    if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
    if (url === "/api/shared-server/logout") return Promise.resolve(response({ ok: true, has_token: false }));
    throw new Error(`Unexpected request: ${url}`);
  }));
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  const { holdUnload } = await import("../src/lib/unloadGuard");
  let logout!: () => Promise<boolean>;
  function Host() {
    logout = useHubAuth().logout;
    return null;
  }
  await act(async () => root!.render(<Host />));
  await act(async () => {});
  holdUnload("edit-docs", true);
  try {
    let loggedOut: boolean | undefined;
    await act(async () => { loggedOut = await logout(); });
    expect([loggedOut, asked.length, requests.includes("/api/shared-server/logout"), reloadPage.mock.calls.length]).toEqual([false, 1, false, 0]);
    answer = true;
    await act(async () => { loggedOut = await logout(); });
    expect([loggedOut, asked.length, reloadPage.mock.calls.length]).toEqual([true, 2, 1]);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false); // 새로고침은 문지기를 풀고 한다 — 브라우저가 한 번 더 묻지 않는다
  } finally {
    holdUnload("edit-docs", false);
  }
});

// Codex 재검토 3회째: 위의 확인은 요청 전에 한 번뿐이다. 응답을 기다리는 동안 한 편집이 저장에 실패하면 묻지 못한 채 새로고침에 사라진다 —
//  그사이는 '떠나는 중'이라 편집 문서가 조작을 받지 않는다(useEditDoc 이 isLeaving 을 본다 — editDocStore 시험). 실패하면 풀린다.
it("AUTH-off 로그아웃 — 응답을 기다리는 동안은 '떠나는 중'이고, 실패하면 풀린다", async () => {
  const reloadPage = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
    hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: reloadPage });
  const answer = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
    if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: false, url: "http://127.0.0.1:9" }));
    if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
    if (url === "/api/shared-server/logout") return answer.promise;
    throw new Error(`Unexpected request: ${url}`);
  }));
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  const { isLeaving } = await import("../src/lib/unloadGuard");
  let logout!: () => Promise<boolean>;
  function Host() {
    logout = useHubAuth().logout;
    return null;
  }
  await act(async () => root!.render(<Host />));
  await act(async () => {});
  expect(isLeaving()).toBe(false);
  let pending!: Promise<boolean>;
  await act(async () => { pending = logout(); });
  expect(isLeaving()).toBe(true);
  let loggedOut: boolean | undefined;
  await act(async () => {
    answer.resolve(new Response(JSON.stringify({ detail: "boom" }), { status: 500 }));
    loggedOut = await pending;
  });
  expect([loggedOut, isLeaving(), reloadPage.mock.calls.length]).toEqual([false, false, 0]);
});

// Codex 재검토 4회째: (1) 로그아웃을 두 번 누르면 요청이 둘 — 하나의 실패가 편집 잠금을 풀고, 아직 기다리던 다른 하나의 성공이 그사이의
//  편집을 새로고침으로 지웠다. 요청은 하나뿐이고 두 번째 누름은 그 결과를 같이 기다린다. (2) 응답이 끝나지 않으면 잠금이 영영 남았다 —
//  제한 시간 뒤에 끊고, 로그아웃이 됐는지를 허브에 물어 정한다.
it("AUTH-off 로그아웃 — 진행 중에 다시 눌러도 요청은 하나다. 응답이 안 끝나면 허브에 물어, 됐으면 새로 고치고 아니면 풀고 알린다", async () => {
  vi.useFakeTimers();
  const reloadPage = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
    hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: reloadPage });
  let stillLoggedIn = true;
  let ready = false; // 화면이 뜬 뒤의 상태 조회만 센다
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (ready) asked.push(url);
    if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
    if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: stillLoggedIn, url: "http://127.0.0.1:9" }));
    if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
    if (url === "/api/auth/me") return Promise.resolve(response({ email: "a@test", name: "a", roles: [] }));
    if (url === "/api/shared-server/logout") return new Promise<Response>(() => {}); // 끝나지 않는 응답
    throw new Error(`Unexpected request: ${url}`);
  }));
  const flashes: string[] = [];
  const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  try {
    const { useHubAuth } = await import("../src/lib/useHubAuth");
    const { isLeaving } = await import("../src/lib/unloadGuard");
    let logout!: () => Promise<boolean>;
    function Host() {
      logout = useHubAuth().logout;
      return null;
    }
    await act(async () => root!.render(<Host />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    ready = true;
    reloadPage.mockClear(); // 처음 로그인한 계정의 범위를 맞추는 새로고침(이 시험의 일이 아니다)
    const results: boolean[] = [];
    await act(async () => {
      void logout().then((done) => results.push(done));
      void logout().then((done) => results.push(done)); // 다시 누름
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect([asked.filter((url) => url.endsWith("/logout")).length, isLeaving(), results]).toEqual([1, true, []]);
    // 제한 시간이 지났다 — 허브에 묻는다. 세션이 그대로면 로그아웃은 안 된 것: 풀고 알린다(새로 고치지 않는다)
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect([results, isLeaving(), reloadPage.mock.calls.length, flashes]).toEqual(
      [[false, false], false, 0, ["로그아웃하지 못했습니다 — 잠시 뒤 다시 시도하세요."]]);
    expect(asked.filter((url) => url.endsWith("/status"))).toHaveLength(1);
    // 다시 누른다 — 이번에는 응답은 안 끝났지만 허브의 세션이 없어졌다(로그아웃은 됐다): 새로 고친다
    stillLoggedIn = false;
    await act(async () => {
      void logout().then((done) => results.push(done));
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect([results, reloadPage.mock.calls.length, flashes.length]).toEqual([[false, false, true], 1, 1]);
  } finally {
    window.removeEventListener("ch:flash", onFlash);
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
