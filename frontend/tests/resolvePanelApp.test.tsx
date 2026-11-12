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
vi.mock("../src/api", () => ({ api: { authConfig: mocks.config, me: mocks.me, myFinalizeRoles: vi.fn(async () => ({ project_ids: [] })),
  thumbOrRaw: (path: string) => path, assetThumbUrl: (path: string) => path } }));
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
vi.mock("../src/lib/useEditSequence", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/useEditSequence")>(), useEditProjects: mocks.projects, useEditGenerations: mocks.generations }));
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
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "S/C2" }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.config.mockResolvedValue({ auth_enabled: false, has_accounts: true }); mocks.me.mockResolvedValue({ email: "a" });
  mocks.identity.mockResolvedValue(identity);
  mocks.cache.mockImplementation(async (body: { gen_ids: string[] }) => ({ items: body.gen_ids.map(gen_id => ({ gen_id, state: "cached" })) }));
  mocks.prepare.mockResolvedValue({ state: "prepared", gen_id: "g", path: "Z:/file.mp4" });
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }] });
  mocks.unstage.mockResolvedValue({ state: "ok" });
  mocks.inventory.mockResolvedValue({ ...destination, items: [], more: false });
  mocks.target.mockResolvedValue(destination); mocks.currentBin.mockResolvedValue(destination); mocks.adopt.mockResolvedValue({ state: "in_bin" });
  mocks.projects.mockReturnValue({ projectsState: "ok", projects: [{ id: "p", name: "영화" }], reloadCounts: mocks.countsReload, tree: { state: "ready", roots: [{ path: "S", name: "S", children: [
    { path: "S/C10", name: "C10", count: 1, reviewCounts: { final: 0, held: 1 } },
    { path: "S/C2", name: "C2", count: 3, reviewCounts: { final: 1, held: 1 } },
    { path: "S/C30", name: "C30", count: 0 },
  ] }, { path: "T", name: "T", children: [{ path: "T/C1", name: "C1", count: 2 }] }] } });
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen], reload: mocks.listReload, startedAt: 1 });
  window.mvhubResolve = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); delete window.mvhubResolve; });

it("트리·상태·전체 워크스페이스, 오른쪽 = 미디어 풀 보기 전용·카드 표", async () => {
  await render();
  expect(host.textContent).toContain("리졸브 빈: MV Hub/영화/S/C2");
  expect(host.querySelector(".rp-foot")!.textContent).toContain("띄움 1");
  expect(host.textContent).not.toMatch(/V1|V2|\.\.\./);
  expect(host.querySelector('[aria-label="보기 방식"]')).not.toBeNull(); // 편집 탭 미디어 풀 그대로(세 보기)
  const row = host.querySelector<HTMLElement>(".ed-prow-meta")!;
  expect(row.dataset.id).toBe("g");
  expect(row.title).toBe(""); // 편집 탭 안내 글(끌기 = 타임라인에 넣기…)이 새지 않는다
  expect(row.querySelector(".ed-pmarks")!.textContent).toBe("띄움");
  expect(host.querySelector(".ed-pool-sel")).toBeNull();
  expect(mocks.projects.mock.calls[0][0].workspace.scope).toBe("unknown");
  expect(mocks.generations.mock.calls[0][0].allWorkspaces).toBe(true);
  expect(mocks.cache.mock.invocationCallOrder[0]).toBeLessThan(mocks.target.mock.invocationCallOrder[0]);
  expect(mocks.target.mock.invocationCallOrder[0]).toBeLessThan(mocks.stage.mock.invocationCallOrder[0]);
  // 컷을 눌러도 같은 target 에 에피소드의 생성물 있는 컷(0개 컷 C30 은 빼고)을 실어 빈 표를 받는다
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ create: true, folder_path: "S/C2", episode_path: "S", create_paths: ["S/C2", "S/C10"] });
});

it("에피소드 이름 = target 한 번·stage 없음·타일 / 화살표 = 펼치기만", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "", cut: "" }));
  await render();
  expect(mocks.target).not.toHaveBeenCalled();
  const chevron = host.querySelector<HTMLButtonElement>('[aria-label="T 폴더 펼치기"]')!;
  await act(async () => chevron.click()); await flush();
  expect(host.textContent).toContain("C1");
  expect(mocks.target).not.toHaveBeenCalled();
  const name = [...host.querySelectorAll<HTMLButtonElement>(".rp-name")].find(button => button.textContent === "T")!;
  await act(async () => name.click()); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ create: true, folder_path: "T", episode_path: "T", create_paths: ["T/C1"] });
  expect(mocks.stage).not.toHaveBeenCalled();
  expect([...host.querySelectorAll(".rp-tile")].map(tile => tile.textContent)).toEqual(["C12"]);
});

it("다빈치에서 컷 빈에 들어가면 그 컷으로 — target 없이 bin_id 로 한 번 · 에피소드 빈으로 오면 선택만 풀고 · 다른 빈은 무시", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const episodeBins = { ...destination, bin_id: "epS", bin_path: "MV Hub/영화/S", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" };
  mocks.target.mockResolvedValue(episodeBins);
  let davinci = "epS";
  mocks.currentBin.mockImplementation(async () => ({ ...destination, bin_id: davinci, bin_path: "MV Hub/영화/" + davinci }));
  await render(); await tick(2000);
  expect(mocks.target).toHaveBeenCalledTimes(1); expect(mocks.stage).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".rp-tile")).toHaveLength(2);
  davinci = "b2"; await tick(2000); await tick(10);
  expect(mocks.target).toHaveBeenCalledTimes(1);
  expect(mocks.stage).toHaveBeenCalledTimes(1);
  expect(mocks.stage.mock.calls[0][0]).toMatchObject({ folder_path: "S/C2", bin_id: "b2" });
  expect(host.querySelector('[aria-label="보기 방식"]')).not.toBeNull();
  expect(host.querySelector(".rp-cut.selected")!.textContent).toContain("C2");
  await tick(6000);
  expect(mocks.stage).toHaveBeenCalledTimes(1); // 빈 ID 가 바뀔 때 한 번만
  davinci = "epS"; await tick(2000); await tick(10);
  expect(host.querySelectorAll(".rp-tile")).toHaveLength(2);
  expect(mocks.target).toHaveBeenCalledTimes(1); expect(mocks.unstage).not.toHaveBeenCalled();
  davinci = "person-bin"; await tick(2000); await tick(10);
  expect(host.querySelectorAll(".rp-tile")).toHaveLength(2);
  expect(mocks.target).toHaveBeenCalledTimes(1); expect(mocks.stage).toHaveBeenCalledTimes(1);
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
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.updateSet([])); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(1); expect(mocks.stage).toHaveBeenCalledTimes(2);
  expect(mocks.stage.mock.calls[1][0].gen_ids).toEqual([]);
});

it("used는 prepare 다음 adopt 한 번, 반복 폴링 중복 없음", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, used: ["g"] });
  await render(false); await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush(); await tick(6000);
  expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.adopt).toHaveBeenCalledTimes(1);
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.adopt.mock.invocationCallOrder[0]);
});

it("같은 에피소드 안 컷 이동·에피소드로 돌아오기는 지우지 않음", async () => {
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C10", [])); await flush();
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  expect(mocks.unstage).not.toHaveBeenCalled();
  expect(mocks.stage).toHaveBeenCalledTimes(3);
});

it("다른 에피소드: 새 target 먼저, 그 뒤 앞 에피소드 컷마다 쓴 것 옮기고 비면 빈까지 지움", async () => {
  const bins: Record<string, string> = { "S/C2": "b2", "S/C10": "b10", "T/C1": "t1" };
  mocks.currentBin.mockImplementation(async (_ctx: unknown, _project: string, folder: string) =>
    ({ ...destination, bin_id: "elsewhere", target_bin_id: bins[folder] ?? "ep", used: folder === "S/C2" ? ["g"] : [] }));
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValueOnce({ ...destination, bin_id: "epT", bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ episode_path: "S", create_paths: ["S/C2", "S/C10"] });
  expect(mocks.stage).not.toHaveBeenCalled();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  expect(mocks.unstage.mock.calls.map(call => [call[0].folder_path, call[0].bin_id, call[0].delete_empty])).toEqual([["S/C2", "b2", true], ["S/C10", "b10", true]]);
  expect(mocks.target.mock.invocationCallOrder[1]).toBeLessThan(mocks.currentBin.mock.invocationCallOrder[0]);
  expect(mocks.adopt.mock.invocationCallOrder[0]).toBeLessThan(mocks.unstage.mock.invocationCallOrder[0]); // 쓴 것을 NAS 로 옮긴 뒤 정리
});

it("앞 에피소드 정리 중에 그 에피소드를 다시 고르면(A→B→A) 남은 컷은 지우지 않음", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValue({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  const held = deferred<typeof destination>();
  mocks.currentBin.mockReturnValueOnce(held.promise);
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => held.resolve({ ...destination, target_bin_id: "b2" })); await flush();
  expect(mocks.unstage.mock.calls.filter(call => call[0].bin_id === "b2" || call[0].bin_id === "b10")).toEqual([]);
});

it("다른 에피소드(빈 표 없음): 새 컷을 먼저 띄운 뒤 앞 컷 정리 — 기다리는 사이 A 를 다시 고르면 A 는 안 지움", async () => {
  await render(false); await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const held = deferred<typeof destination>();
  mocks.currentBin.mockReturnValueOnce(held.promise).mockResolvedValue({ ...destination, bin_id: "elsewhere" });
  await act(async () => control.selectFolder("p", "T", "T/C1", [])); await flush();
  expect(mocks.stage.mock.invocationCallOrder[1]).toBeLessThan(mocks.currentBin.mock.invocationCallOrder[0]); // 새 컷 먼저
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => held.resolve({ ...destination, bin_id: "elsewhere" })); await flush();
  expect(mocks.stage).toHaveBeenCalledTimes(3);
  expect(mocks.unstage.mock.calls.map(call => [call[0].folder_path, call[0].delete_empty])).toEqual([["T/C1", undefined]]); // 빈 표가 없으면 빈은 안 지운다
});

it("새 target 이 실패하면 앞 에피소드는 미뤄 두었다가 [맞추기]로 맞춘 뒤 정리", async () => {
  mocks.currentBin.mockImplementation(async (_ctx: unknown, _project: string, folder: string) =>
    ({ ...destination, bin_id: "elsewhere", target_bin_id: ({ "S/C2": "b2", "S/C10": "b10" } as Record<string, string>)[folder] ?? "ep" }));
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValueOnce({ state: "unavailable" })
    .mockResolvedValue({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  expect(mocks.unstage).not.toHaveBeenCalled();
  await act(async () => control.align()); await flush();
  expect(mocks.unstage.mock.calls.map(call => call[0].bin_id)).toEqual(["b2", "b10"]);
});

it("낡은 B 작업은 그사이 C 를 골랐으면 정리하지 않고, C 의 target 뒤에 앞 에피소드를 정리", async () => {
  mocks.currentBin.mockImplementation(async (_ctx: unknown, _project: string, folder: string) =>
    ({ ...destination, bin_id: "elsewhere", target_bin_id: ({ "S/C2": "b2", "S/C10": "b10" } as Record<string, string>)[folder] ?? "x" }));
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  const held = deferred<typeof destination>();
  mocks.stage.mockReturnValueOnce(held.promise);
  await act(async () => control.selectFolder("p", "T", "T/C1", [gen])); await flush();
  await act(async () => control.selectFolder("p", "V", "V/C1", [])); await flush();
  await act(async () => held.resolve({ ...destination, items: [] })); await flush();
  const targetV = mocks.target.mock.calls.findIndex(call => call[0].folder_path === "V/C1");
  expect(mocks.unstage.mock.calls.map(call => call[0].bin_id).slice(0, 2)).toEqual(["b2", "b10"]);
  expect(mocks.target.mock.invocationCallOrder[targetV]).toBeLessThan(mocks.unstage.mock.invocationCallOrder[0]);
});

it("다빈치 빈 읽기를 기다리는 사이 목록 갱신으로 선택 객체가 바뀌어도 따라가기를 놓치지 않음", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "b2", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2", "S/C10"])); await flush();
  const held = deferred<typeof destination>();
  mocks.currentBin.mockReturnValueOnce(held.promise);
  await tick(2000);
  await act(async () => control.updateSet([gen])); await flush();
  await act(async () => held.resolve({ ...destination, bin_id: "b10" })); await flush();
  expect(control.follow).toMatchObject({ project: "p", episode: "S", cut: "S/C10" });
});

it("따라온 선택은 늦게 고르더라도 target 으로 바뀌지 않음(그사이 다빈치가 표 밖 빈으로 가도) · [맞추기]는 target", async () => {
  mocks.target.mockResolvedValue({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  let davinci = "epS";
  mocks.currentBin.mockImplementation(async () => ({ ...destination, bin_id: davinci }));
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  davinci = "b10"; await tick(2000);
  expect(control.follow).toMatchObject({ cut: "S/C10" });
  davinci = "person-bin"; await tick(2000); // 화면이 목록을 기다리는 사이 사람이 표 밖 빈으로
  await act(async () => control.selectFolder("p", "S", "S/C10", [gen], false, ["S/C2", "S/C10"])); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  expect(mocks.stage.mock.calls.at(-1)![0]).toMatchObject({ folder_path: "S/C10", bin_id: "b10" });
  // 보류된 뒤 사람이 그 컷 빈에 다시 들어오면 target 없이 한 번 가져온다(머무는 동안 더 부르지 않음)
  const staged = mocks.stage.mock.calls.length;
  davinci = "b10"; await tick(2000); await tick(10);
  expect(mocks.stage.mock.calls.length).toBe(staged + 1);
  expect(mocks.stage.mock.calls.at(-1)![0]).toMatchObject({ folder_path: "S/C10", bin_id: "b10" });
  await tick(4000);
  expect(mocks.stage.mock.calls.length).toBe(staged + 1);
  expect(mocks.target).toHaveBeenCalledTimes(1);
  davinci = "person-bin"; await tick(2000); await tick(10); // 다시 표 밖으로 — 사람이 누른 [맞추기]는 따라온 선택이어도 target
  await act(async () => control.align()); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(2);
});

it("프로젝트를 바꿔 선택이 풀리면 정리하되 다빈치가 들어가 있는 컷 빈은 남김", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  mocks.currentBin.mockImplementation(async (_ctx: unknown, _project: string, folder: string) =>
    ({ ...destination, bin_id: "b2", target_bin_id: ({ "S/C2": "b2", "S/C10": "b10" } as Record<string, string>)[folder] }));
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("", "", "", [])); await flush();
  expect(mocks.unstage.mock.calls.map(call => [call[0].bin_id, call[0].delete_empty])).toEqual([["b10", true]]);
});

it("에피소드를 다시 누르면 지금 트리의 컷 목록으로 target(그사이 생긴 컷 빈도)", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  await render();
  expect(mocks.target.mock.calls[0][0].create_paths).toEqual(["S/C2", "S/C10"]);
  const tree = mocks.projects.mock.results[0].value.tree;
  mocks.projects.mockReturnValue({ ...mocks.projects.mock.results[0].value, tree: { ...tree, roots: [{ ...tree.roots[0],
    children: [...tree.roots[0].children, { path: "S/C40", name: "C40", count: 2 }] }, tree.roots[1]] } });
  await act(async () => root.render(<ResolvePanelApp />)); await flush();
  const name = [...host.querySelectorAll<HTMLButtonElement>(".rp-name")].find(button => button.textContent === "S")!;
  await act(async () => name.click()); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(2);
  expect(mocks.target.mock.calls[1][0].create_paths).toEqual(["S/C2", "S/C10", "S/C40"]);
});

it("다시 열 때 저장된 에피소드의 컷 빈은 inventory 정리에서 건너뛰고 빈은 안 지움", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const row = { resolve_project_id: "r", project_id: "p", bin_path: "x", item_id: "i", gen_id: "g", usage: 0 };
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: [
    { ...row, folder_path: "S/C2", bin_id: "b2" }, { ...row, folder_path: "S2/C1", bin_id: "s2" }, { ...row, folder_path: "T/C1", bin_id: "t1" }] });
  await render(false); await flush();
  expect(mocks.unstage.mock.calls.map(call => [call[0].bin_id, call[0].inventory_cleanup, call[0].delete_empty])).toEqual([["s2", true, undefined], ["t1", true, undefined]]);
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
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C10", [])); await flush();
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
  await render(false); await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush(); await tick(6000);
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

it("빠른 A B A(다른 에피소드)에서 만들지 않은 B 빈은 정리 실패가 아님", async () => {
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const held = deferred<typeof destination>(); mocks.currentBin.mockReturnValueOnce(held.promise);
  await act(async () => control.selectFolder("p", "T", "T/C1", [])); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  mocks.currentBin.mockResolvedValueOnce({ state: "ok", resolve_project_id: "r" });
  await act(async () => held.resolve(destination)); await flush();
  expect(control.failures).toEqual([]); expect(mocks.stage).toHaveBeenCalledTimes(3);
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
