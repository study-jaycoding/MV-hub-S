// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
const mocks = vi.hoisted(() => ({
  config: vi.fn(), me: vi.fn(), identity: vi.fn(), cache: vi.fn(), prepare: vi.fn(), target: vi.fn(), currentBin: vi.fn(), adopt: vi.fn(),
  projects: vi.fn(), generations: vi.fn(), login: vi.fn(), token: "", pause: (() => {}) as () => void,
}));
vi.mock("../src/api", () => ({ api: { authConfig: mocks.config, me: mocks.me } }));
vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn(), getAuthToken: () => mocks.token, setAuthToken: (value: string) => { mocks.token = value; },
  forgetAuthToken: () => { mocks.token = ""; },
  subscribeApiPause: (fn: () => void) => { mocks.pause = fn; return () => {}; } }));
vi.mock("../src/lib/resolvePanelApi", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/resolvePanelApi")>(),
  resolvePanelApi: { identity: mocks.identity, cache: mocks.cache, prepare: mocks.prepare, target: mocks.target, currentBin: mocks.currentBin, adopt: mocks.adopt },
}));
vi.mock("../src/lib/useEditSequence", () => ({ useEditProjects: mocks.projects, useEditGenerations: mocks.generations }));
vi.mock("../src/components/LoginScreen", () => ({ LoginScreen: (props: unknown) => { mocks.login(props); return <div>LoginScreen</div>; } }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
import { ResolvePanelApp } from "../src/components/resolvePanel/ResolvePanelApp";
import { useResolvePanel } from "../src/lib/useResolvePanel";
import { APP_EVENTS } from "../src/lib/appEvents";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const identity = { instance: "hub", account: "account", epoch: 1, protocol: { min: 1, max: 1 } };
const destination = { state: "ok", resolve_project_id: "r", bin_id: "bin", bin_path: "MV Hub/영화/S/C2" };
const gen = { id: "g", folder_path: "S/C2", status: "done", creator_name: "Jay", model: "Model", created_at: "2026-11-11", params: { duration: 5 },
  assets: [{ type: "image", file_path: "/media/image.png", thumbnail_path: "/media/thumb.png" }], is_final: true } as Generation;
let root: Root, host: HTMLDivElement;
let control: ReturnType<typeof useResolvePanel>;
function Harness() { control = useResolvePanel(); return null; }
const flush = () => act(async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); });
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };
async function render(screen = true) { await act(async () => root.render(screen ? <ResolvePanelApp /> : <Harness />)); await flush(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.token = "";
  localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", sequence: "S", cut: "S/C2" }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.config.mockResolvedValue({ auth_enabled: false, has_accounts: true }); mocks.me.mockResolvedValue({ email: "a" });
  mocks.identity.mockResolvedValue(identity);
  mocks.cache.mockImplementation(async (body: { gen_ids: string[] }) => ({ items: body.gen_ids.map(gen_id => ({ gen_id, state: "cached" })) }));
  mocks.prepare.mockResolvedValue({ state: "prepared", gen_id: "g", path: "Z:/file.mp4" });
  mocks.target.mockResolvedValue(destination); mocks.currentBin.mockResolvedValue(destination); mocks.adopt.mockResolvedValue({ state: "in_bin" });
  mocks.projects.mockReturnValue({ projectsState: "ok", projects: [{ id: "p", name: "영화" }], tree: { roots: [{ path: "S", name: "S", children: [
    { path: "S/C10", name: "C10", count: 1, reviewCounts: { final: 0, held: 1 } },
    { path: "S/C2", name: "C2", count: 3, reviewCounts: { final: 1, held: 1 } },
  ] }] } });
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen] });
  window.mvhubResolve = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); delete window.mvhubResolve; });

it("컷 자연 정렬·카드·상태 줄·전체 워크스페이스, 넣기 단추와 점 세 개 없음", async () => {
  await render();
  const text = host.textContent || "";
  expect(text).toContain("MV Hub"); expect(text).toContain("리졸브 빈: MV Hub/영화/S/C2");
  expect(text).toContain("Jay"); expect(text).toContain("Model"); expect(text).toContain("5s"); expect(text).toContain("★ 최종");
  expect(text.indexOf("C2")).toBeLessThan(text.lastIndexOf("C10"));
  expect(text).not.toMatch(/V1|V2|\.\.\./);
  expect(mocks.projects.mock.calls[0][0].workspace).toEqual({ scope: "unknown", id: null, name: null });
  expect(mocks.generations.mock.calls[0][0].allWorkspaces).toBe(true);
  expect(mocks.target.mock.calls[0][0].create).toBe(false);
});

it("다리 없는 브라우저에도 목록과 안내", async () => {
  delete window.mvhubResolve; await render();
  expect(host.textContent).toContain("리졸브의 MV Hub 창에서만 끌어 넣을 수 있습니다");
  expect(host.querySelectorAll("article")).toHaveLength(1);
});

it("다리 없으면 컷 선택·카드 누름·폴링 뒤에도 다섯 API 호출 0", async () => {
  delete window.mvhubResolve; await render();
  const cuts = host.querySelectorAll("nav button");
  await act(async () => (cuts[1] as HTMLButtonElement).click());
  await act(async () => (cuts[0] as HTMLButtonElement).click());
  await flush();
  await act(async () => host.querySelector("article")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await tick(10_000);
  for (const api of [mocks.cache, mocks.target, mocks.prepare, mocks.adopt, mocks.currentBin]) expect(api).not.toHaveBeenCalled();
  expect(mocks.identity.mock.calls.length).toBeGreaterThan(1);
  expect(mocks.projects).toHaveBeenCalled(); expect(mocks.generations).toHaveBeenCalled();
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect([...host.querySelectorAll('[role="status"]')].map(node => node.textContent)).toEqual(["리졸브의 MV Hub 창에서만 끌어 넣을 수 있습니다"]);
  expect(host.textContent).not.toMatch(/받는 중|NAS 준비 중|카드를 누르면 준비합니다/);
});

it("다리가 사라진 뒤 다시 확인·맞추기·카드 누름·폴링은 호출하지 않음", async () => {
  await render(false);
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  delete window.mvhubResolve;
  const apis = [mocks.cache, mocks.target, mocks.prepare, mocks.adopt, mocks.currentBin];
  apis.forEach(api => api.mockClear());
  await act(async () => { control.align(); await control.adopt("g"); await control.prepareCard("g"); });
  await tick(4000);
  apis.forEach(api => expect(api).not.toHaveBeenCalled());
});

it("현재 빈 다름 줄과 맞추기, busy에서는 다름 대신 확인 중", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, bin_id: "other" }); await render(); await tick(2000);
  expect(host.textContent).toContain("리졸브 지금 빈이 선택한 컷과 다릅니다");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "맞추기")).toBe(true);
  mocks.currentBin.mockResolvedValue({ state: "busy" }); await tick(2000);
  expect(host.textContent).not.toContain("리졸브 지금 빈이 선택한 컷과 다릅니다"); expect(host.textContent).toContain("확인 중");
});

it("AUTH-on 로그인 전 기존 LoginScreen props", async () => {
  mocks.config.mockResolvedValue({ auth_enabled: true, has_accounts: true }); await render();
  expect(host.textContent).toBe("LoginScreen"); expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.login.mock.calls[0][0]).toMatchObject({ config: { auth_enabled: true }, onAuthed: expect.any(Function) });
});

it.each([null, STORAGE_KEYS.authToken])("다른 창 로그아웃 %s는 메모리만 비우고 새 로그인 저장값을 보존", async key => {
  mocks.config.mockResolvedValue({ auth_enabled: true, has_accounts: true }); mocks.token = "old";
  await render();
  localStorage.setItem(STORAGE_KEYS.authToken, "new-login");
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue: null })));
  await flush();
  expect(mocks.token).toBe(""); expect(localStorage.getItem(STORAGE_KEYS.authToken)).toBe("new-login");
  expect(host.textContent).toBe("LoginScreen");
});

it("늦은 토큰 변경 이벤트는 저장소의 최신 계정으로 다시 읽음", async () => {
  await render(); localStorage.setItem(STORAGE_KEYS.authToken, "latest-login");
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.authToken, newValue: "older-login" })));
  await flush(); expect(mocks.token).toBe("latest-login");
});

it.each([APP_EVENTS.authRequired, APP_EVENTS.accountUpdated, "storage"])("인증 신호 %s에 목록을 버리고 늦은 응답 무시", async event => {
  await render();
  const old = deferred<typeof identity>(); mocks.identity.mockReturnValueOnce(old.promise);
  await act(async () => window.dispatchEvent(new Event("focus")));
  mocks.config.mockReturnValue(new Promise(() => {}));
  await act(async () => window.dispatchEvent(event === "storage" ? new StorageEvent("storage", { key: STORAGE_KEYS.activeAccount, newValue: "other" }) : new Event(event)));
  expect(host.querySelectorAll("article")).toHaveLength(0);
  await act(async () => old.resolve(identity)); await flush();
  expect(host.querySelectorAll("article")).toHaveLength(0);
});

it("씬 저장소 부팅 전 전용 갈래", () => {
  const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
  const branch = main.indexOf("embed === EMBED_MODES.resolvePanel");
  expect(branch).toBeGreaterThan(0); expect(branch).toBeLessThan(main.indexOf("await bootSceneStore()"));
  expect(main.slice(branch, main.indexOf("} else if (isCanvasWindow", branch))).toContain("render(<ResolvePanelApp />)");
});

async function select() { await render(false); act(() => control.selectCut("p", "S/C2", [gen])); await flush(); }
it("카드 준비·화면 판 전달·false면 adopt 금지", async () => {
  await select(); await act(async () => control.prepareCard("g"));
  window.mvhubResolve!.startDrag = vi.fn(() => false);
  act(() => control.drag("g", { preventDefault: vi.fn() })); await tick(1000);
  expect(window.mvhubResolve!.startDrag).toHaveBeenCalledWith("Z:/file.mp4", { protocol: 1 });
  expect(mocks.adopt).not.toHaveBeenCalled(); expect(control.cards.g.message).toContain("판이 맞지 않습니다");
});

it("missing일 때만 빈 만들고 준비, ready에는 중복 복사 없음", async () => {
  mocks.target.mockResolvedValueOnce({ state: "missing" }).mockResolvedValue(destination);
  await select(); await act(async () => control.prepareCard("g")); await act(async () => control.prepareCard("g"));
  expect(mocks.target.mock.calls.map(call => call[0].create)).toEqual([false, true]); expect(mocks.prepare).toHaveBeenCalledTimes(1);
});

it("컷 변경 시 늦은 target·prepare를 버림", async () => {
  await select(); const ready = deferred<{ state: string; path: string }>(); mocks.prepare.mockReturnValueOnce(ready.promise);
  let work!: Promise<void>; act(() => { work = control.prepareCard("g"); }); await flush();
  act(() => control.selectCut("p", "S/C10", [])); await flush();
  await act(async () => { ready.resolve({ state: "prepared", path: "old" }); await work; });
  expect(control.cards.g).toBeUndefined();
});

it("501건을 순서대로 나누고 컷 변경 뒤 남은 묶음 중단", async () => {
  await render(false); const delayed = deferred<{ items: [] }>(); mocks.cache.mockReturnValueOnce(delayed.promise);
  act(() => control.selectCut("p", "S/C2", Array.from({ length: 501 }, (_, n) => ({ ...gen, id: String(n) })))); await flush();
  expect(mocks.cache.mock.calls[0][0].gen_ids).toHaveLength(500);
  act(() => control.selectCut("p", "S/C10", [])); await act(async () => delayed.resolve({ items: [] })); await flush();
  expect(mocks.cache).toHaveBeenCalledTimes(1);
});

it("current-bin은 앞 요청이 끝날 때까지 겹치지 않음", async () => {
  await select(); const delayed = deferred<typeof destination>(); mocks.currentBin.mockReturnValueOnce(delayed.promise);
  await tick(2000); const count = mocks.currentBin.mock.calls.length; await tick(10_000);
  expect(mocks.currentBin).toHaveBeenCalledTimes(count);
  await act(async () => delayed.resolve(destination)); await tick(2000); expect(mocks.currentBin.mock.calls.length).toBe(count + 1);
});

it.each(["stamp_failed", "save_failed", "ledger_failed", "unknown", "conflict", "elsewhere", "project_changed", "rebuild_recovery_pending"])("adopt %s는 즉시 멈춤", async state => {
  await select(); await act(async () => control.prepareCard("g")); mocks.adopt.mockResolvedValue({ state, details: "injected" });
  act(() => { void control.adopt("g"); }); await tick(9000);
  expect(mocks.adopt).toHaveBeenCalledTimes(1); expect(control.cards.g.retry).toBe(state !== "rebuild_recovery_pending"); expect(control.cards.g.message).not.toContain("빈에 있음:");
  if (state === "rebuild_recovery_pending") expect(control.target?.state).toBe(state);
});

it("not_prepared 재준비 뒤 adopt 한 번만", async () => {
  await select(); await act(async () => control.prepareCard("g")); mocks.adopt.mockResolvedValue({ state: "not_prepared" });
  act(() => { void control.adopt("g"); }); await tick(9000);
  expect(mocks.adopt).toHaveBeenCalledTimes(2); expect(mocks.prepare).toHaveBeenCalledTimes(2);
});
it("not_seen 8번, busy는 누적 30초까지", async () => {
  await select(); mocks.adopt.mockResolvedValue({ state: "not_seen" });
  act(() => { void control.adopt("g"); }); await tick(9000); expect(mocks.adopt).toHaveBeenCalledTimes(8);
  mocks.adopt.mockClear().mockResolvedValue({ state: "busy" });
  act(() => { void control.adopt("g"); }); await tick(31_000); expect(mocks.adopt).toHaveBeenCalledTimes(30);
});
it.each([{"state": "not_seen", end: 8000, message: "확인 못 함 — 놓지 않았거나 다른 빈"},
  {"state": "busy", end: 30000, message: "확인 중 — 리졸브가 바쁨"}])("$state 진행 중은 확인 중만, 종료 뒤 문구와 단추", async ({ state, end, message }) => {
  mocks.adopt.mockResolvedValue({ state }); await render();
  await act(async () => host.querySelector("article")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await flush();
  act(() => { host.querySelector("article")!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })); });
  await tick(end - 1000);
  const status = () => host.querySelector(".resolve-panel-card-state")!;
  expect(status().textContent).toBe("확인 중"); expect(status().querySelector("button")).toBeNull();
  await tick(1000);
  expect(status().textContent).toContain(message); expect(status().querySelector("button")?.textContent).toBe("다시 확인");
});

it.each(["prepared-project", "expired-context", "current-project"])("drag 훅은 %s 불일치에서 다리 호출을 거절", async reason => {
  await select(); await act(async () => control.prepareCard("g"));
  if (reason === "prepared-project") {
    mocks.target.mockResolvedValue({ ...destination, resolve_project_id: "other" });
    act(() => control.align()); await flush();
  } else if (reason === "expired-context") {
    mocks.identity.mockReturnValue(new Promise(() => {})); await tick(2001);
  } else {
    mocks.currentBin.mockResolvedValue({ ...destination, resolve_project_id: "other" }); await tick(2000);
  }
  act(() => control.drag("g", { preventDefault: vi.fn() })); await tick(1000);
  expect(window.mvhubResolve!.startDrag).not.toHaveBeenCalled(); expect(mocks.adopt).not.toHaveBeenCalled();
  expect(control.cards.g.message).toBe(reason === "expired-context" ? "계정 문맥을 확인 중입니다" : "리졸브 빈을 먼저 확인해 주세요");
});

it("identity는 앞 응답 뒤 1.5초에 다시 확인", async () => {
  await render(false); const delayed = deferred<typeof identity>(); mocks.identity.mockReturnValueOnce(delayed.promise);
  await tick(1499); expect(mocks.identity).toHaveBeenCalledTimes(1);
  await tick(1); expect(mocks.identity).toHaveBeenCalledTimes(2);
  await tick(3000); expect(mocks.identity).toHaveBeenCalledTimes(2);
  await act(async () => delayed.resolve(identity)); await flush();
  await tick(1499); expect(mocks.identity).toHaveBeenCalledTimes(2);
  await tick(1); expect(mocks.identity).toHaveBeenCalledTimes(3);
});

it("UUID가 없는 환경에서도 창 id를 처음 한 번만 생성", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  const random = vi.spyOn(Math, "random");
  try {
    await select(); const first = mocks.target.mock.calls[0][0].window;
    expect(first).toMatch(/^panel_/); random.mockClear();
    await tick(3000); act(() => control.selectCut("p", "S/C10", [])); await flush();
    expect(mocks.target.mock.calls[1][0].window).toBe(first); expect(random).not.toHaveBeenCalled();
  } finally {
    random.mockRestore();
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});
it("adopt HTTP 오류는 서버 문구로 즉시 멈춤", async () => {
  await select(); mocks.adopt.mockRejectedValue(new Error("503: 시작 중"));
  act(() => { void control.adopt("g"); }); await tick(9000);
  expect(mocks.adopt).toHaveBeenCalledTimes(1); expect(control.cards.g.message).toBe("503: 시작 중");
});

it("창 재열기는 새 window id와 seq 1부터", async () => {
  await select(); const first = mocks.target.mock.calls[0][0];
  await act(async () => root.unmount()); root = createRoot(host);
  await select(); const second = mocks.target.mock.calls[1][0];
  expect(first.window).not.toBe(second.window); expect(first.seq).toBe(1); expect(second.seq).toBe(1);
});

it("늦은 target와 stale은 새 컷의 성공을 덮지 않음", async () => {
  await render(false); const old = deferred<typeof destination>(); mocks.target.mockReturnValueOnce(old.promise);
  act(() => control.selectCut("p", "S/C2", [gen])); await flush();
  act(() => control.selectCut("p", "S/C10", [])); await flush();
  await act(async () => old.resolve({ ...destination, bin_path: "old" })); await flush();
  expect(control.target?.bin_path).toBe(destination.bin_path);
  mocks.target.mockResolvedValue({ state: "stale" }); act(() => control.align()); await flush();
  expect(control.target?.bin_path).toBe(destination.bin_path);
});

it("끌기 성공 뒤 확인하고 account_changed는 준비·target 전부 버림", async () => {
  await select(); await act(async () => control.prepareCard("g"));
  act(() => control.drag("g", { preventDefault: vi.fn() })); await tick(1000);
  expect(control.cards.g.message).toContain("리졸브 빈에 있음"); expect(mocks.adopt).toHaveBeenCalledTimes(1);
  mocks.adopt.mockResolvedValue({ state: "account_changed" }); mocks.identity.mockReturnValue(new Promise(() => {}));
  act(() => { void control.adopt("g"); }); await tick(1000);
  expect(control.identity).toBeNull(); expect(control.target).toBeNull(); expect(control.cards).toEqual({});
});

it("501건 두 번째 묶음은 앞 응답 뒤, 빈 목록은 생략", async () => {
  await render(false); const old = deferred<{ items: [] }>(); mocks.cache.mockReturnValueOnce(old.promise);
  act(() => control.selectCut("p", "S/C2", Array.from({ length: 501 }, (_, n) => ({ ...gen, id: String(n) })))); await flush();
  expect(mocks.cache).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve({ items: [] })); await flush();
  expect(mocks.cache.mock.calls.map(call => call[0].gen_ids.length)).toEqual([500, 1]);
  act(() => control.selectCut("p", "S/C10", [])); await flush(); expect(mocks.cache).toHaveBeenCalledTimes(2);
});

it("identity 문맥 변경은 목록 재조회와 준비 폐기", async () => {
  await select(); await act(async () => control.prepareCard("g"));
  mocks.identity.mockResolvedValue({ ...identity, instance: "restarted" }); await tick(2000);
  expect(control.identity?.instance).toBe("restarted"); expect(control.cards).toEqual({}); expect(control.target).toBeNull();
});
