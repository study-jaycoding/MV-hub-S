// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
const mocks = vi.hoisted(() => ({
  config: vi.fn(), me: vi.fn(), identity: vi.fn(), cache: vi.fn(), prepare: vi.fn(), target: vi.fn(), currentBin: vi.fn(), adopt: vi.fn(), stage: vi.fn(), unstage: vi.fn(), inventory: vi.fn(),
  projects: vi.fn(), generations: vi.fn(), login: vi.fn(), token: "", pause: (() => {}) as () => void,
  editCard: vi.fn(), setTags: vi.fn(), review: vi.fn(), listReload: vi.fn(), countsReload: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: { authConfig: mocks.config, me: mocks.me, myFinalizeRoles: vi.fn(async () => ({ project_ids: [] })) } }));
// 썸네일 칸의 라이브러리 카드와 앱 저장 훅은 각자 시험이 있다 — 여기서는 패널이 그것을 그대로 연결하는지만 본다.
vi.mock("../src/components/timeline/EditCard", async importOriginal => ({
  ...await importOriginal<typeof import("../src/components/timeline/EditCard")>(),
  EditCard: (props: unknown) => { mocks.editCard(props); return <div className="stub-card">card</div>; },
}));
vi.mock("../src/lib/useGenerationTagActions", () => ({ useGenerationTagActions: () => ({ onSetTags: mocks.setTags, onSetAutoTags: vi.fn() }) }));
vi.mock("../src/lib/useGenerationCardActions", () => ({ useGenerationCardActions: () => ({ onReview: mocks.review, onFinalize: vi.fn(), onUnfinalize: vi.fn() }) }));
vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn(), getAuthToken: () => mocks.token, setAuthToken: (value: string) => { mocks.token = value; },
  forgetAuthToken: () => { mocks.token = ""; },
  subscribeApiPause: (fn: () => void) => { mocks.pause = fn; return () => {}; } }));
vi.mock("../src/lib/resolvePanelApi", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/resolvePanelApi")>(),
  resolvePanelApi: { identity: mocks.identity, cache: mocks.cache, prepare: mocks.prepare, target: mocks.target, currentBin: mocks.currentBin, adopt: mocks.adopt, stage: mocks.stage, unstage: mocks.unstage, inventory: mocks.inventory },
}));
vi.mock("../src/lib/useEditSequence", () => ({ useEditProjects: mocks.projects, useEditGenerations: mocks.generations }));
vi.mock("../src/components/LoginScreen", () => ({ LoginScreen: (props: unknown) => { mocks.login(props); return <div>LoginScreen</div>; } }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
import { ResolvePanelApp } from "../src/components/resolvePanel/ResolvePanelApp";
import { useResolvePanel } from "../src/lib/useResolvePanel";
import { APP_EVENTS } from "../src/lib/appEvents";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const identity = { instance: "hub", account: "account", epoch: 1, protocol: { min: 1, max: 1 }, writer: true, generation: 1 };
const destination = { state: "ok", resolve_project_id: "r", bin_id: "bin", bin_path: "MV Hub/영화/S/C2", target_bin_id: "bin", used: [] as string[] };
const gen = { id: "g", folder_path: "S/C2", status: "done", creator_name: "Jay", model: "Model", created_at: "2026-11-11", params: { duration: 5 }, prompt: "clay fish",
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
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }] });
  mocks.unstage.mockResolvedValue({ state: "ok" });
  mocks.inventory.mockResolvedValue({ ...destination, items: [], more: false });
  mocks.target.mockResolvedValue(destination); mocks.currentBin.mockResolvedValue(destination); mocks.adopt.mockResolvedValue({ state: "in_bin" });
  mocks.projects.mockReturnValue({ projectsState: "ok", projects: [{ id: "p", name: "영화" }], reloadCounts: mocks.countsReload, tree: { roots: [{ path: "S", name: "S", children: [
    { path: "S/C10", name: "C10", count: 1, reviewCounts: { final: 0, held: 1 } },
    { path: "S/C2", name: "C2", count: 3, reviewCounts: { final: 1, held: 1 } },
  ] }] } });
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen], reload: mocks.listReload });
  window.mvhubResolve = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); delete window.mvhubResolve; });

it("트리·상태·전체 워크스페이스, 카드·보기·끌기 없음", async () => {
  await render();
  expect(host.textContent).toContain("리졸브 빈: MV Hub/영화/S/C2");
  expect(host.textContent).toContain("띄움 1");
  expect(host.textContent).not.toMatch(/V1|V2|\.\.\./);
  expect(host.querySelector("article")).toBeNull();
  expect(host.querySelector('[aria-label="보기 방식"]')).toBeNull();
  expect(mocks.projects.mock.calls[0][0].workspace.scope).toBe("unknown");
  expect(mocks.generations.mock.calls[0][0].allWorkspaces).toBe(true);
  expect(mocks.cache.mock.invocationCallOrder[0]).toBeLessThan(mocks.target.mock.invocationCallOrder[0]);
  expect(mocks.target.mock.invocationCallOrder[0]).toBeLessThan(mocks.stage.mock.invocationCallOrder[0]);
  expect(mocks.target.mock.calls[0][0].create).toBe(true);
});

it("다리 없음: 컷·거르기·시간 경과에도 여덟 API 0", async () => {
  delete window.mvhubResolve; await render(); await tick(16_000);
  await act(async () => (host.querySelector(".rp-cut") as HTMLButtonElement).click()); await flush();
  for (const fn of [mocks.cache, mocks.target, mocks.stage, mocks.unstage, mocks.inventory, mocks.prepare, mocks.adopt, mocks.currentBin]) expect(fn).not.toHaveBeenCalled();
  expect(mocks.identity.mock.calls.every(call => call[1] === false)).toBe(true);
  expect(host.textContent).toContain("리졸브의 MV Hub 창에서만 끌어 넣을 수 있습니다");
});

it("AUTH-on은 LoginScreen", async () => {
  mocks.config.mockResolvedValue({ auth_enabled: true, has_accounts: true }); await render();
  expect(host.textContent).toBe("LoginScreen"); expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.login.mock.calls[0][0]).toMatchObject({ onAuthed: expect.any(Function) });
});

it("인증 설정 실패 뒤 재시도는 오류를 비움", async () => {
  mocks.config.mockRejectedValueOnce(new Error("offline")); await render();
  expect(host.textContent).toContain("offline"); await tick(3000);
  expect(host.textContent).not.toContain("offline");
});

it("인증 만료는 문맥을 버림", async () => {
  await render(false);
  await act(async () => window.dispatchEvent(new Event(APP_EVENTS.authRequired)));
  expect(control.identity).toBeNull(); expect(control.authReady).toBe(false);
});

it("로그아웃 저장소 이벤트도 문맥을 버림", async () => {
  await render(false);
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.authToken, newValue: null })));
  await flush(); expect(control.target).toBeNull();
});

it("identity 폴링은 처음 한 번만 claim", async () => {
  await render(false); await tick(5000);
  expect(mocks.identity.mock.calls[0][1]).toBe(true);
  expect(mocks.identity.mock.calls.slice(1).every(call => call[1] === false)).toBe(true);
});

it("다른 창은 쓰지 않고 넘겨받기로 진행", async () => {
  mocks.identity.mockResolvedValue({ ...identity, writer: false }); await render();
  expect(host.textContent).toContain("다른 MV 창이 리졸브를 맡고 있습니다");
  expect(mocks.stage).not.toHaveBeenCalled();
  mocks.identity.mockResolvedValue(identity);
  await act(async () => ([...host.querySelectorAll("button")].find(button => button.textContent === "넘겨받기")!).click()); await flush();
  expect(mocks.stage).toHaveBeenCalled();
});

it("같은 컷 집합 변경은 stage만 다시, target 반복 없음", async () => {
  await render(false);
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  await act(async () => control.updateSet([])); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(1); expect(mocks.stage).toHaveBeenCalledTimes(2);
  expect(mocks.stage.mock.calls[1][0].gen_ids).toEqual([]);
});

it("used는 prepare 다음 adopt 한 번, 반복 폴링 중복 없음", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, used: ["g"] });
  await render(false); await act(async () => control.selectCut("p", "S/C2", [gen])); await flush(); await tick(6000);
  expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.adopt).toHaveBeenCalledTimes(1);
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.adopt.mock.invocationCallOrder[0]);
});

it("앞 컷 정리를 끝낸 뒤 다시 A를 띄움", async () => {
  await render(false); await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  const held = deferred<typeof destination>();
  mocks.currentBin.mockReturnValueOnce(held.promise);
  await act(async () => control.selectCut("p", "S/C10", [])); await flush();
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  expect(mocks.stage).toHaveBeenCalledTimes(1);
  await act(async () => held.resolve(destination)); await flush();
  expect(mocks.unstage).toHaveBeenCalled();
  expect(mocks.stage).toHaveBeenCalledTimes(2);
  expect(mocks.unstage.mock.invocationCallOrder[0]).toBeLessThan(mocks.stage.mock.invocationCallOrder[1]);
});

it("501개 inventory 끝 쪽 used까지 처리, 복구는 prepare 생략", async () => {
  const row = { resolve_project_id: "r", project_id: "p", folder_path: "S/old", bin_id: "old", bin_path: "MV Hub/영화/S/old", item_id: "i", gen_id: "g", usage: null };
  mocks.inventory.mockResolvedValueOnce({ ...destination, items: Array.from({ length: 500 }, (_, n) => ({ ...row, item_id: String(n) })), more: true, after: ["old", "499"] })
    .mockResolvedValueOnce({ ...destination, items: [{ ...row, item_id: "500", recovery: true, usage: 1 }], more: false });
  await render(false); await flush();
  expect(mocks.inventory).toHaveBeenCalledTimes(2);
  expect(mocks.inventory.mock.calls[1][1]).toEqual(["old", "499"]);
  expect(mocks.adopt).toHaveBeenCalledTimes(1); expect(mocks.prepare).not.toHaveBeenCalled();
});

it("deferred·같은 파일·다른 허브·확인 필요 상태", async () => {
  mocks.stage.mockResolvedValue({ ...destination, deferred: 2, items: [{ gen_id: "g", state: "same_file_exists" }] });
  mocks.inventory.mockResolvedValue({ ...destination, items: [], other_owner: 3, needs_attention: 4 });
  await render();
  expect(host.textContent).toContain("새 공유물 2"); expect(host.textContent).toContain("같은 파일 항목이 이미 있습니다 1");
  expect(host.textContent).toContain("다른 허브 3"); expect(host.textContent).toContain("확인 필요 4");
});

it("늦은 컷 응답은 새 컷 상태를 덮지 않음", async () => {
  await render(false);
  const held = deferred<typeof destination>(); mocks.target.mockReturnValueOnce(held.promise);
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  await act(async () => control.selectCut("p", "S/C10", [])); await flush();
  await act(async () => held.resolve({ ...destination, bin_path: "old" })); await flush();
  expect(control.notice).not.toContain("old");
});

it("15초 재조회는 목록과 수만 새로 읽음", async () => {
  await render(); await tick(15_000);
  expect(mocks.listReload).toHaveBeenCalled(); expect(mocks.countsReload).toHaveBeenCalled();
  expect(mocks.target).toHaveBeenCalledTimes(1);
});

it("복구 대기는 자동 재시도·다시 단추 없음", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, used: ["g"] });
  mocks.adopt.mockResolvedValue({ state: "rebuild_recovery_pending" });
  await render(); await tick(6000);
  expect(mocks.adopt).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("정렬 복구가 끝나지 않았습니다");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "다시")).toBe(false);
});

it("실패한 adopt는 수동 다시 뒤에만 재시도", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, used: ["g"] });
  mocks.adopt.mockResolvedValueOnce({ state: "replace_failed" });
  await render(false); await act(async () => control.selectCut("p", "S/C2", [gen])); await flush(); await tick(6000);
  expect(mocks.adopt).toHaveBeenCalledTimes(1);
  await act(async () => control.retry()); await flush(); await tick(2000);
  expect(mocks.adopt).toHaveBeenCalledTimes(2);
});

it.each([{ account: "new-account" }, { instance: "new-hub" }])("새 문맥 %j는 자동 claim 후 복구 재개", async change => {
  await render();
  const next = { ...identity, ...change };
  mocks.identity.mockImplementation(async (_window: string, claim: boolean) => ({ ...next, writer: claim, owner_state: claim ? "writer" : "unclaimed" }));
  mocks.identity.mockClear(); mocks.inventory.mockClear(); mocks.stage.mockClear();
  await tick(1500);
  expect(mocks.identity.mock.calls.map(call => call[1])).toEqual([false, true]);
  expect(mocks.inventory).toHaveBeenCalled(); expect(mocks.stage).toHaveBeenCalled();
});

it("새 문맥의 실제 다른 담당 창은 자동으로 빼앗지 않음", async () => {
  await render();
  mocks.identity.mockResolvedValue({ ...identity, account: "new-account", writer: false, owner_state: "other_window" });
  mocks.identity.mockClear(); mocks.stage.mockClear(); mocks.inventory.mockClear();
  await tick(4500);
  expect(mocks.identity.mock.calls.every(call => call[1] === false)).toBe(true);
  expect(mocks.stage).not.toHaveBeenCalled(); expect(mocks.inventory).not.toHaveBeenCalled();
  expect(host.textContent).toContain("다른 MV 창이 리졸브를 맡고 있습니다");
});

it("빠른 A B A에서 만들지 않은 B 빈은 정리 실패가 아님", async () => {
  await render(false);
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  const held = deferred<typeof destination>(); mocks.currentBin.mockReturnValueOnce(held.promise);
  await act(async () => control.selectCut("p", "S/C10", [])); await flush();
  await act(async () => control.selectCut("p", "S/C2", [gen])); await flush();
  mocks.currentBin.mockResolvedValueOnce({ state: "ok", resolve_project_id: "r" });
  await act(async () => held.resolve(destination)); await flush();
  expect(control.failures).toEqual([]); expect(mocks.stage).toHaveBeenCalledTimes(2);
});

it("큰 컷은 오래된 200개만 보내고 잘린 목록은 capped 전달", async () => {
  const rows = Array.from({ length: 2501 }, (_, n) => ({ ...gen, id: String(n), created_at: String(n).padStart(5, "0") })).reverse();
  mocks.generations.mockReturnValue({ state: "capped", gens: rows, reload: mocks.listReload });
  await render();
  const body = mocks.stage.mock.calls[0][0];
  expect(body.capped).toBe(true); expect(body.gen_ids).toHaveLength(200);
  expect(body.gen_ids[0]).toBe("0"); expect(body.gen_ids[199]).toBe("199");
  mocks.stage.mockClear();
  mocks.generations.mockReturnValue({ state: "capped", gens: [gen], reload: mocks.listReload });
  await act(async () => root.render(<ResolvePanelApp />)); await flush();
  expect(mocks.stage.mock.calls[0][0]).toMatchObject({ capped: true, gen_ids: ["g"] });
});

it("예상과 다른 가져오기는 손대지 않은 개수로 표시", async () => {
  mocks.stage.mockResolvedValue({ ...destination, unexpected_imports: 2 });
  await render();
  expect(host.textContent).toContain("가져오기가 어긋난 항목 2개 — 손대지 않았습니다");
});
