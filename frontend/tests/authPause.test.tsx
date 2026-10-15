// @vitest-environment jsdom
// Jay 결정 4B(10-15) — 같은 브라우저의 다른 탭에서 로그아웃하면 이 탭도 정리한다. 저장하지 못한 것이 있으면 화면은 남기고
//  앱이 시작하는 /api 요청은 하나도 보내지 않는다(멈춤). 늦게 온 401 은 그 요청에 실어 보낸 토큰이 지금 토큰일 때만 로그인을 지운다.
//  설계: docs/status/결정일곱_설계_2026-10-15.md 4B · 4차 보완 E8~E10.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: Root | null;
let host: HTMLDivElement;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ACCOUNT = { email: "a@test", name: "a", status: "approved", global_roles: [], creator_uid: null, created_at: "", approved_at: null };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 다른 탭이 저장소를 바꿨다 — 브라우저가 이 탭에 보내는 알림을 흉내 낸다(저장소 값은 먼저 바꿔 둔다).
function otherTab(key: string, newValue: string | null) {
  if (newValue === null) localStorage.removeItem(key);
  else localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("전송 관문(installApiGate)", () => {
  it("멈춤 동안 /api 요청은 보내지 않고 멈춤 오류로 끝난다 — 그림 주소 같은 다른 요청은 보낸다", async () => {
    const raw = vi.fn(() => Promise.resolve(response({ ok: true })));
    const target = { fetch: raw as unknown as typeof fetch };
    const http = await import("../src/lib/http");
    http.installApiGate(target);
    http.setApiPause("shared");
    await expect(target.fetch("/api/projects")).rejects.toBeInstanceOf(http.ApiPausedError);
    await expect(target.fetch(new Request("http://localhost:3000/api/scenes/backup", { method: "PUT" }))).rejects.toThrow(http.API_PAUSED_MESSAGE);
    await target.fetch("/files/a.png");
    expect(raw).toHaveBeenCalledTimes(1);
    http.setApiPause(null);
    await target.fetch("/api/projects");
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("Comfy 실행 — 멈춤 오류는 다시 보내거나 '들어갔을 수 있다'(답 없음)로 바꾸지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const raw = vi.fn(() => Promise.resolve(response({ job_id: "j1" })));
      vi.stubGlobal("fetch", raw);
      const http = await import("../src/lib/http");
      http.installApiGate();
      (await import("../src/lib/hubFeatures")).setHubFeatures(["request_retry_v1"]);
      const { comfyApi } = await import("../src/lib/comfyApi");
      http.setApiPause("hub");
      const run = comfyApi.run("{}");
      const settled = expect(run).rejects.toBeInstanceOf(http.ApiPausedError);
      await vi.advanceTimersByTimeAsync(2000);
      await settled;
      expect(raw).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("늦게 온 401 — 그 요청의 토큰이 지금 토큰이 아니면(그사이 새로 로그인) 새 로그인을 지우지 않는다", async () => {
    const http = await import("../src/lib/http");
    const { APP_EVENTS } = await import("../src/lib/appEvents");
    const required = vi.fn();
    window.addEventListener(APP_EVENTS.authRequired, required);
    let answer!: (res: Response) => void;
    const target = { fetch: vi.fn(() => new Promise<Response>((done) => (answer = done))) as unknown as typeof fetch };
    http.installApiGate(target);
    try {
      http.setAuthToken("A");
      const pending = target.fetch("/api/projects", { headers: { Authorization: "Bearer A" } });
      http.setAuthToken("B"); // 다른 계정으로 새로 로그인했다
      answer(response({ detail: "expired" }, 401));
      const res = await pending;
      await expect(http.throwHttpError(res, "/api/projects")).rejects.toBeInstanceOf(http.HttpError);
      expect([http.getAuthToken(), localStorage.getItem("ch.auth.token"), required.mock.calls.length]).toEqual(["B", "B", 0]);

      const now = target.fetch("/api/projects", { headers: { Authorization: "Bearer B" } });
      answer(response({ detail: "expired" }, 401));
      await expect(http.throwHttpError(await now, "/api/projects")).rejects.toBeInstanceOf(http.HttpError);
      expect([http.getAuthToken(), localStorage.getItem("ch.auth.token"), required.mock.calls.length]).toEqual([null, null, 1]);
    } finally {
      window.removeEventListener(APP_EVENTS.authRequired, required);
    }
  });
});

describe("다른 탭의 로그아웃(useHubAuth)", () => {
  async function mountShared() {
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: vi.fn() }); // 처음 계정 범위를 맞추는 새로고침(이 시험의 일이 아니다)
    localStorage.setItem("ch.auth.token", "A");
    const requests: string[] = [];
    const raw = vi.fn((url: string) => {
      requests.push(url);
      if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: true, has_accounts: true }));
      if (url === "/api/auth/me") return Promise.resolve(response(ACCOUNT));
      if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
      return Promise.resolve(response({ detail: "expired" }, 401));
    });
    vi.stubGlobal("fetch", raw);
    const http = await import("../src/lib/http");
    http.installApiGate(); // main.tsx 와 같게 — 시험이 바꿔 낀 fetch 를 감싼다
    const { useHubAuth } = await import("../src/lib/useHubAuth");
    const state: { current: ReturnType<typeof useHubAuth> | null } = { current: null };
    function Host() {
      state.current = useHubAuth();
      return null;
    }
    await act(async () => root!.render(<Host />));
    await act(async () => {});
    expect(state.current!.account?.email).toBe("a@test");
    return { http, state, requests, raw };
  }

  it("공유 서버 — 지킬 것이 없으면 로그인 화면으로 가고 '다른 탭에서 로그아웃했습니다'를 알린다", async () => {
    const { http, state } = await mountShared();
    await act(async () => otherTab("ch.auth.token", null));
    expect([state.current!.account, state.current!.loggedOutElsewhere, http.getAuthToken(), http.getApiPause()]).toEqual([null, true, null, null]);
  });

  it("공유 서버 — 저장하지 못한 것이 있으면 화면은 두고 요청을 멈춘다 · 늦은 401 도 화면을 내리지 않는다 · 띠의 단추로 로그인 화면", async () => {
    const { http, state, requests } = await mountShared();
    const { holdUnload } = await import("../src/lib/unloadGuard");
    const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
    holdUnload("comment:g1", true);
    try {
      await act(async () => otherTab("ch.auth.token", null));
      expect([state.current!.account?.email, state.current!.apiPause, http.getAuthToken()]).toEqual(["a@test", "shared", null]);
      const before = requests.length;
      await expect(fetch("/api/generations")).rejects.toBeInstanceOf(http.ApiPausedError);
      expect(requests.length).toBe(before); // 보내지 않았다
      await act(async () => dispatchAppEvent(APP_EVENTS.authRequired)); // 진행 중이던 요청의 401 이 뒤늦게 왔다
      expect(state.current!.account?.email).toBe("a@test");
      vi.stubGlobal("confirm", () => true);
      await act(async () => state.current!.leavePause());
      expect([state.current!.account, state.current!.apiPause, state.current!.loggedOutElsewhere]).toEqual([null, null, true]);
    } finally {
      holdUnload("comment:g1", false);
    }
  });

  it("공유 서버 — 토큰이 없던 탭 · 다른 계정으로 바뀐 것(새 값이 있음)은 아무 일 없다", async () => {
    const { http, state } = await mountShared();
    await act(async () => otherTab("ch.auth.token", "B"));
    expect([state.current!.account?.email, http.getApiPause(), http.getAuthToken()]).toEqual(["a@test", null, "A"]);
  });

  async function mountHub() {
    const reloadPage = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload: reloadPage });
    localStorage.setItem("ch.activeAccount", "a@test"); // 이미 이 계정으로 연 탭(범위 맞추는 새로고침 없음)
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: false, has_accounts: false }));
      if (url === "/api/shared-server/status") return Promise.resolve(response({ configured: true, has_token: true, url: "http://127.0.0.1:9", email: "a@test", name: "a", roles: [] }));
      if (url === "/api/auth/me") return Promise.resolve(response(ACCOUNT));
      if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
      if (url === "/api/shared-server/logout") return Promise.resolve(response({ ok: true, has_token: false }));
      throw new Error(`Unexpected request: ${url}`);
    }));
    const http = await import("../src/lib/http");
    http.installApiGate();
    const { useHubAuth } = await import("../src/lib/useHubAuth");
    const state: { current: ReturnType<typeof useHubAuth> | null } = { current: null };
    function Host() {
      state.current = useHubAuth();
      return null;
    }
    await act(async () => root!.render(<Host />));
    await act(async () => {});
    reloadPage.mockClear();
    return { http, state, reloadPage };
  }

  it("로컬 허브 — 로그아웃한 탭은 시각을 남기고, 다른 탭은 지킬 것이 없으면 새로 고친다", async () => {
    const { state, reloadPage } = await mountHub();
    await act(async () => { await state.current!.logout(); });
    expect(localStorage.getItem("mvhub.hubLogoutAt")).toMatch(/^\d+$/);
    reloadPage.mockClear();
    await act(async () => otherTab("mvhub.hubLogoutAt", String(Date.now())));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("로컬 허브 — 지킬 것이 있으면 새로 고치지 않고 멈춘다(씬 백업 같은 자동 요청도 안 나간다) · 띠의 [새로 고침]은 묻고 새로 고친다", async () => {
    const { http, state, reloadPage } = await mountHub();
    const { holdUnload } = await import("../src/lib/unloadGuard");
    holdUnload("scene-save", true);
    try {
      await act(async () => otherTab("mvhub.hubLogoutAt", String(Date.now())));
      expect([reloadPage.mock.calls.length, state.current!.apiPause]).toEqual([0, "hub"]);
      await expect(fetch("/api/scenes/backup", { method: "PUT" })).rejects.toBeInstanceOf(http.ApiPausedError);
      const asked: string[] = [];
      vi.stubGlobal("confirm", (message: string) => { asked.push(message); return false; });
      await act(async () => state.current!.leavePause());
      expect([asked.length, reloadPage.mock.calls.length]).toEqual([1, 0]); // 취소하면 그대로
      vi.stubGlobal("confirm", () => true);
      await act(async () => state.current!.leavePause());
      expect(reloadPage).toHaveBeenCalledTimes(1);
    } finally {
      holdUnload("scene-save", false);
    }
  });

  // ── Codex 4B 리뷰(09:17) ──
  it("P1 — 토큰을 지운 뒤 곧바로 새 로그인 B 가 저장돼도(알림이 늦게 옴) 이 탭은 로그아웃을 알아채고, B 는 지우지 않는다", async () => {
    const { http, state } = await mountShared();
    localStorage.setItem("ch.auth.token", "B"); // 저장소는 이미 B — 지움 알림은 그 뒤에 도착한다
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "ch.auth.token", newValue: null })));
    expect([state.current!.account, http.getAuthToken(), localStorage.getItem("ch.auth.token")]).toEqual([null, null, "B"]);
  });

  it("P2 — 멈춘 중에 계정 메뉴의 로그아웃을 눌러도 멈춤이 풀려 로그인 화면으로 간다(로그인 요청이 막히지 않게)", async () => {
    const { http, state } = await mountShared();
    const { holdUnload } = await import("../src/lib/unloadGuard");
    holdUnload("comment:g1", true);
    try {
      await act(async () => otherTab("ch.auth.token", null));
      localStorage.setItem("ch.auth.token", "B"); // 그사이 다른 탭이 새로 로그인했다
      vi.stubGlobal("confirm", () => true);
      let done: boolean | undefined;
      await act(async () => { done = await state.current!.logout(); });
      expect([done, state.current!.account, http.getApiPause(), localStorage.getItem("ch.auth.token")]).toEqual([true, null, null, "B"]);
    } finally {
      holdUnload("comment:g1", false);
    }
  });

  it("P2 — 계정 정보를 다시 읽는 중에 다른 탭 로그아웃으로 로그인 화면이 되면, 늦게 온 성공이 옛 계정 화면을 되살리지 않는다", async () => {
    const { state, raw } = await mountShared();
    let answer!: (res: Response) => void;
    raw.mockImplementationOnce(() => new Promise<Response>((done) => (answer = done)));
    const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
    await act(async () => dispatchAppEvent(APP_EVENTS.accountUpdated)); // me() 를 보냈다 — 답이 늦다
    await act(async () => otherTab("ch.auth.token", null)); // 지킬 것 없음 → 로그인 화면
    expect(state.current!.account).toBeNull();
    await act(async () => { answer(response(ACCOUNT)); });
    expect(state.current!.account).toBeNull();
  });
});

describe("분리 창(installPopupLogoutWatch)", () => {
  async function popup() {
    const reloadPage = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/?embed=manage", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "?embed=manage", hash: "", reload: reloadPage });
    localStorage.setItem("ch.auth.token", "A");
    const http = await import("../src/lib/http");
    const watch = await import("../src/lib/otherTabLogout");
    const { holdUnload } = await import("../src/lib/unloadGuard");
    watch.installPopupLogoutWatch();
    return { http, holdUnload, reloadPage };
  }

  it("저장하지 못한 설명이 있으면 멈추고(토큰은 이 창에서만 비움), 없으면 멈추지 않는다", async () => {
    const { http, holdUnload } = await popup();
    holdUnload("task-desc", true);
    try {
      otherTab("ch.auth.token", null);
      expect([http.getApiPause(), http.getAuthToken()]).toEqual(["shared", null]);
    } finally {
      holdUnload("task-desc", false);
    }
  });

  it("로컬 허브 로그아웃 — 지킬 것이 없으면 새로 고친다", async () => {
    const { http, reloadPage } = await popup();
    otherTab("mvhub.hubLogoutAt", String(Date.now()));
    expect([reloadPage.mock.calls.length, http.getApiPause()]).toEqual([1, null]);
  });

  // ── Codex 4B 2차(09:28) ──
  it("관리 창 권한 — 멈춘 중의 30초 재조회·로그인 요구는 권한을 바꾸지 않는다(작업표가 다시 그려져 초안을 잃지 않게)", async () => {
    localStorage.setItem("ch.auth.token", "A");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: true, has_accounts: true }));
      if (url === "/api/auth/me") return Promise.resolve(response({ ...ACCOUNT, creator_uid: "u1", global_roles: ["admin"] }));
      return Promise.resolve(response([], 200));
    }));
    const http = await import("../src/lib/http");
    http.installApiGate();
    const { useManageCaps } = await import("../src/lib/useManageCaps");
    const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
    let caps: ReturnType<typeof useManageCaps> | null = null;
    function Host({ signal }: { signal: number }) {
      caps = useManageCaps(signal);
      return null;
    }
    await act(async () => root!.render(<Host signal={0} />));
    await act(async () => {});
    const before = caps!;
    expect(before.loaded).toBe(true);
    http.setApiPause("shared");
    await act(async () => root!.render(<Host signal={1} />)); // 30초 갱신 — 요청은 막혀 실패한다
    await act(async () => {});
    await act(async () => dispatchAppEvent(APP_EVENTS.authRequired));
    await act(async () => otherTab("ch.auth.token", null));
    expect(caps).toBe(before);
  });

  it("Assets 끌어 내보내기 — 멈춘 중엔 브라우저가 직접 받는 주소를 싣지 않는다", async () => {
    const http = await import("../src/lib/http");
    const { setSingleFileDrag, setZipDrag } = await import("../src/components/assets/exportDrag");
    const data = new Map<string, string>();
    const dt = { setData: (key: string, value: string) => data.set(key, value), effectAllowed: "" } as unknown as DataTransfer;
    http.setApiPause("shared");
    setZipDrag(dt, "p1", ["a.png", "b.png"]);
    setSingleFileDrag(dt, "p1", "c.mp4", "c.mp4");
    expect(data.size).toBe(0);
    http.setApiPause(null);
    setZipDrag(dt, "p1", ["a.png", "b.png"]);
    expect(data.has("DownloadURL")).toBe(true);
  });
});