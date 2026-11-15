// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
const mocks = vi.hoisted(() => ({
  config: vi.fn(), me: vi.fn(), identity: vi.fn(), cache: vi.fn(), prepare: vi.fn(), target: vi.fn(), currentBin: vi.fn(), adopt: vi.fn(), stage: vi.fn(), unstage: vi.fn(), inventory: vi.fn(),
  prestage: vi.fn(), rename: vi.fn(), save: vi.fn(), settle: vi.fn(), creators: vi.fn(), creatorsReload: vi.fn(),
  projects: vi.fn(), generations: vi.fn(), login: vi.fn(), token: "", pause: (() => {}) as () => void,
  editCard: vi.fn(), setTags: vi.fn(), review: vi.fn(), listReload: vi.fn(), countsReload: vi.fn(),
  live: null as null | ((message: { type?: string; status?: string }) => void),
}));
vi.mock("../src/lib/progressSocket", () => ({ connectProgress: (onMessage: (message: { type?: string; status?: string }) => void) => { mocks.live = onMessage; return () => { mocks.live = null; }; } }));
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
  resolvePanelApi: { identity: mocks.identity, cache: mocks.cache, prepare: mocks.prepare, target: mocks.target, currentBin: mocks.currentBin, adopt: mocks.adopt, stage: mocks.stage, unstage: mocks.unstage, inventory: mocks.inventory,
    prestage: mocks.prestage, rename: mocks.rename, save: mocks.save, settle: mocks.settle },
}));
vi.mock("../src/lib/useLibraryCreators", () => ({ useLibraryCreators: mocks.creators }));
vi.mock("../src/lib/useEditSequence", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/useEditSequence")>(), useEditProjects: mocks.projects, useEditGenerations: mocks.generations }));
vi.mock("../src/components/LoginScreen", () => ({ LoginScreen: (props: unknown) => { mocks.login(props); return <div>LoginScreen</div>; } }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
import { ResolvePanelApp } from "../src/components/resolvePanel/ResolvePanelApp";
import { useResolvePanel } from "../src/lib/useResolvePanel";
import { panelFailure } from "../src/lib/resolvePanelApi";
import { APP_EVENTS } from "../src/lib/appEvents";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const identity = { instance: "hub", account: "account", epoch: 1, protocol: { min: 1, max: 1 }, writer: true, generation: 1 };
const destination = { state: "ok", resolve_project_id: "r", bin_id: "bin", bin_path: "MV Hub/영화/S/C2", target_bin_id: "bin", used: [] as string[] };
const gen = { id: "g", folder_path: "S/C2", status: "done", creator_name: "Jay", model: "Model", created_at: "2026-11-11", params: { duration: 5 }, prompt: "clay fish",
  assets: [{ type: "image", file_path: "/media/image.png", thumbnail_path: "/media/thumb.png" }], is_final: true } as Generation;

it.each([false, true])("저장 전환은 모두 유예하고 뒤 항목 실패=%s일 때 최종 저장을 건너뜀", async fail => {
  await render(false);
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: ["g", "h"].map(gen_id => ({
    resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: gen_id, gen_id, usage: 1,
  })) });
  mocks.adopt.mockImplementation(async body => ({ state: fail && body.gen_id === "h" ? "replace_failed" : "in_bin" }));
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.adopt).toHaveBeenCalledTimes(2);
  for (const [body] of mocks.adopt.mock.calls) expect(body.defer_save).toBe(true);
  expect(mocks.save).toHaveBeenCalledTimes(fail ? 0 : 1);
  expect(control.saveState.phase).toBe(fail ? "blocked" : "done");
});

it("최종 저장 뒤 장부 실패는 저장 성공과 기록 재시도를 구분한다", async () => {
  await render(false);
  mocks.save.mockResolvedValue({ state: "ledger_failed", project_saved: true });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(control.notice).toContain("프로젝트는 저장했습니다");
  expect(control.notice).toContain("다시 저장");
  expect(control.notice).not.toContain("저장하지 않았습니다");
  expect(control.saveState.phase).toBe("blocked");
});

it.each(["cleanup_failed", "ledger_failed"])("저장 후 %s와 복구 기록 정리 실패를 구분해 재시도를 안내한다", async state => {
  await render(false);
  mocks.save.mockResolvedValue({ state, project_saved: true, cleanup_failed: true });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(control.notice).toContain("프로젝트는 저장했습니다");
  expect(control.notice).toContain("복구 기록 정리");
  expect(control.notice).toContain("다시 저장");
  expect(control.notice.includes("전환 기록")).toBe(state === "ledger_failed");
  expect(control.notice).not.toContain("...");
  expect(panelFailure("cleanup_failed")).toContain("복구 기록 정리");
  expect(control.saveState.phase).toBe("blocked");
});

it("공통 검사의 복구 기록 정리 실패 안내는 '다시 저장' 없이 원인만 — 저장 안내는 [저장] 마무리에서만(재확인 4차 낮음)", () => {
  expect(panelFailure("cleanup_pending")).toContain("복구 기록");
  expect(panelFailure("cleanup_pending")).not.toContain("다시 저장");
  expect(panelFailure("cleanup_pending")).not.toMatch(/(\.\.\.|…)/);
  // 공통 check() 는 settle·stage·prestage·adopt 어디서나 불려 문맥을 모른다 — 저장용 문구를 쓰지 않는다
  const source = readFileSync(new NodeURL("../src/lib/useResolvePanel.ts", import.meta.url), "utf8");
  const check = source.slice(source.indexOf("const check = "), source.indexOf("const itemName = "));
  expect(check).toContain('panelFailure("cleanup_pending")');
  expect(check).not.toContain('panelFailure("cleanup_failed")');
});

it("실패 클립 삭제 뒤 확인된 부재는 중복 복구 행까지 건너뛰어 최종 저장한다", async () => {
  await render(false);
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: ["g", "h1", "h2"].map(item_id => ({
    resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id,
    gen_id: item_id === "g" ? "g" : "h", recovery: true,
  })) });
  mocks.adopt.mockImplementation(async body => ({ state: body.gen_id === "g" ? "in_bin" : "replace_failed" }));
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.adopt.mockClear();
  mocks.adopt.mockImplementation(async body => body.gen_id === "g" ? { state: "in_bin" } :
    { state: "not_seen", missing_record_ids: ["h1", "h2"], cleanup_failed: true });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.adopt).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(control.saveState.phase).toBe("done");
  expect(control.notice).toContain("NAS로 옮김 1");
});

it.each([undefined, ["other"]])("부재 증거 %j가 요청 항목과 맞지 않으면 저장하지 않는다", async missing_record_ids => {
  await render(false);
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: [{
    resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", recovery: true,
  }] });
  mocks.adopt.mockResolvedValue({ state: "not_seen", missing_record_ids });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(control.saveState.phase).toBe("blocked");
});

it("충돌은 저장을 막고 원래 파일 재연결과 미사용 클립 제거 후 재시도를 안내한다", async () => {
  await render(false);
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: [{
    resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", recovery: true,
  }] });
  mocks.adopt.mockResolvedValue({ state: "conflict" });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(control.failures.join(" ")).toContain("원래 파일로 다시 연결");
  expect(control.failures.join(" ")).toContain("사용하지 않는 클립");
  expect(control.failures.join(" ")).toContain("다시 저장");
});
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
  mocks.prestage.mockResolvedValue({ state: "ok", resolve_project_id: "r", cuts: {} }); mocks.rename.mockResolvedValue({ state: "ok", resolve_project_id: "r", named: 0, remaining: 0 });
  mocks.save.mockResolvedValue({ state: "ok", resolve_project_id: "r" });
  mocks.settle.mockResolvedValue({ state: "ok", resolve_project_id: "r", bins: {}, removed: 0 });
  // 기본 = 서버 생성자 집계를 못 받음 → 받은 카드로 센 목록(지금까지와 같음)
  mocks.creators.mockReturnValue({ creators: [], loading: false, error: "failed", reload: mocks.creatorsReload });
  mocks.projects.mockReturnValue({ projectsState: "ok", projects: [{ id: "p", name: "영화" }], reloadCounts: mocks.countsReload, tree: { state: "ready", roots: [{ path: "S", name: "S",
    count: 4, reviewCounts: { final: 1, held: 2, shared: 4 }, children: [ // 위 폴더 수 = 아래 컷의 합(실제 트리처럼)
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

const row = (path: string) => host.querySelector<HTMLButtonElement>(`button.folder-tree-row[title="${path}"]`);

it("생성자 거르기: 목록은 프로젝트 전체 서버 집계 · 고르면 트리 숫자 조회에 그 사람 uid · 목록에서 사라지면 풂 · 못 받으면 카드 집계(이름 키는 안 넘김)", async () => {
  const both = [{ uid: "u-jay", name: "제이", count: 3, is_mine: true }, { uid: "u-riv", name: "리버", count: 335, is_mine: false }];
  mocks.creators.mockReturnValue({ creators: both, loading: false, error: null, reload: mocks.creatorsReload });
  await render();
  expect(mocks.creators.mock.calls.at(-1)![0]).toMatchObject({ tab: "team", projectId: "p", ready: true });
  const foot = () => host.querySelector<HTMLButtonElement>(".sidebar-foot-toggle")!;
  await act(async () => foot().click()); await flush();
  const names = () => [...host.querySelectorAll(".creator-name")].map(name => name.textContent);
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".creator-pick")].find(button => button.textContent?.includes(name))!;
  expect(names()).toEqual(["제이", "리버"]); // 고른 컷의 카드(Jay 하나)만이 아니라 프로젝트 전체
  expect(mocks.projects.mock.calls.at(-1)![0].creatorUid).toBeUndefined();
  await act(async () => pick("리버").click()); await flush();
  expect(mocks.projects.mock.calls.at(-1)![0].creatorUid).toBe("u-riv"); // 폴더 숫자도 그 사람 것만
  // 공유 해제 등으로 목록에서 사라지면 선택을 풀어 빈 거르기에 갇히지 않는다
  mocks.creators.mockReturnValue({ creators: [both[0]], loading: false, error: null, reload: mocks.creatorsReload });
  await act(async () => { foot().click(); }); await flush();
  await act(async () => { foot().click(); }); await flush();
  expect(mocks.projects.mock.calls.at(-1)![0].creatorUid).toBeUndefined();
  expect(host.querySelector(".creator-row.on")).toBeNull();
  // 서버 집계를 못 받으면 받은 카드로 센 목록 — creator_uid 없는 카드의 이름 키는 트리 조회에 넘기지 않는다
  mocks.creators.mockReturnValue({ creators: [], loading: false, error: "failed", reload: mocks.creatorsReload });
  await act(async () => { foot().click(); }); await flush();
  await act(async () => { foot().click(); }); await flush();
  expect(names()).toEqual(["Jay"]);
  await act(async () => pick("Jay").click()); await flush();
  expect(host.querySelector(".creator-row.on")).not.toBeNull();
  expect(mocks.projects.mock.calls.at(-1)![0].creatorUid).toBeUndefined();
});

it("MV 폴더 트리: 누르기 = 고르기(에피소드 target 한 번·stage 없음·타일) · 폴더 아이콘·두 번 누르기 = 펴고 접기만 · 위 폴더 표시", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "", cut: "" }));
  await render();
  expect(mocks.target).not.toHaveBeenCalled();
  expect(row("T/C1")).toBeNull();
  await act(async () => row("T")!.click()); await flush(); // 접힌 에피소드를 한 번 누르기 = 고르기만, 펼치지 않는다(Codex P2)
  expect(row("T/C1")).toBeNull();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ create: true, folder_path: "T", episode_path: "T", create_paths: ["T/C1"], expect_project: "r" });
  expect(mocks.stage).not.toHaveBeenCalled();
  expect([...host.querySelectorAll(".rp-tile")].map(tile => tile.textContent)).toEqual(["C12"]);
  expect(row("T")!.className).toContain("selected");
  await act(async () => row("T")!.querySelector<HTMLElement>(".folder-tree-fold")!.click()); await flush(); // 폴더 아이콘 = 펴기만
  expect(row("T/C1")).not.toBeNull();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  // 두 번 누르기 — 고른 에피소드를 다시 누르는 것은 아무것도 안 하고, 더블클릭은 접기만
  await act(async () => { row("T")!.click(); row("T")!.click(); row("T")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  expect(row("T/C1")).toBeNull();
  expect(row("S")!.textContent).toContain("★"); // 위 폴더에도 최종 표시(아래 컷의 합)
});

it("맨 위 프로젝트 단추 → 목록 → 고르면 그 프로젝트 · 맨 아래 프로젝트 줄 없음 · 사이드바 닫기·넓이 손잡이", async () => {
  mocks.projects.mockImplementation(({ projectId }: { projectId: string | null }) => ({ projectsState: "ok", reloadCounts: mocks.countsReload,
    projects: [{ id: "p", name: "영화" }, { id: "q", name: "블룸메이커" }],
    tree: projectId === "q" ? { state: "ready", roots: [{ path: "B", name: "B", count: 1, children: [{ path: "B/C1", name: "C1", count: 1 }] }] }
      : { state: "ready", roots: [{ path: "S", name: "S", count: 4, children: [{ path: "S/C2", name: "C2", count: 3 }, { path: "S/C10", name: "C10", count: 1 }] }] } }));
  await render();
  expect(host.querySelector(".rp-project")!.textContent).toContain("영화");
  expect(host.querySelector(".rp-menu")).toBeNull();
  expect(host.querySelector('[role="separator"]')).not.toBeNull(); // 넓이 손잡이
  await act(async () => (host.querySelector(".rp-project") as HTMLButtonElement).click()); await flush();
  const items = [...host.querySelectorAll<HTMLButtonElement>(".rp-item")];
  expect(items.map(item => item.querySelector(".rp-pname")!.textContent)).toEqual(["영화", "블룸메이커"]);
  await act(async () => items[1].click()); await flush();
  expect(host.querySelector(".rp-menu")).toBeNull();
  expect(host.querySelector(".rp-project")!.textContent).toContain("블룸메이커");
  expect(row("B")).not.toBeNull();
  // 닫기 — 오른쪽 머리줄의 끝선 단추, 닫아도 다시 여는 단추가 남는다
  const toggle = () => host.querySelector<HTMLButtonElement>(".side-edge-toggle")!;
  await act(async () => toggle().click()); await flush();
  expect(host.querySelector(".rp-side")).toBeNull();
  await act(async () => toggle().click()); await flush();
  expect(host.querySelector(".rp-side")).not.toBeNull();
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
  expect(row("S/C2")!.className).toContain("selected");
  expect(row("S/C2")!.className).not.toContain("viewed-resolve"); // 다빈치 위치 = 고른 곳이면 라임 그대로(다빈치 표는 다를 때만)
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
  await act(async () => row("S/C10")!.click()); await flush();
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

it("네이티브 끌기는 준비된 로컬 항목만 동기로 시작하고 미준비·낡은 확인·저장 중 거절", async () => {
  const drag = window.mvhubResolve!.startDrag;
  await render(false);
  await act(async () => control.startNativeDrag("g"));
  expect(drag).not.toHaveBeenCalled();
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "i", preview_url: "/media/g.mp4" } } });
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const requests = [mocks.cache, mocks.stage, mocks.prepare, mocks.adopt].map(fn => fn.mock.calls.length);
  await act(async () => control.startNativeDrag("g"));
  expect(drag).toHaveBeenCalledWith("C:/cache/g.mp4", { protocol: 1 });
  expect([mocks.cache, mocks.stage, mocks.prepare, mocks.adopt].map(fn => fn.mock.calls.length)).toEqual(requests);
  vi.setSystemTime(Date.now() + 2100);
  await act(async () => control.startNativeDrag("g"));
  expect(drag).toHaveBeenCalledTimes(1);
  await tick(2000);
  const held = deferred<{ state: string }>(); mocks.save.mockReturnValueOnce(held.promise);
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  await act(async () => control.startNativeDrag("g"));
  expect(drag).toHaveBeenCalledTimes(1);
  expect(control.dragItems).toEqual({});
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/refreshed.mp4", item_id: "new-item", preview_url: "/media/g.mp4" } } });
  await act(async () => held.resolve({ state: "ok" })); await flush();
  expect(control.dragItems.g.item_id).toBe("new-item");
  await act(async () => control.startNativeDrag("g"));
  expect(drag).toHaveBeenLastCalledWith("C:/cache/refreshed.mp4", { protocol: 1 });
});

it("정상 2초 폴링 사이에도 최근 5초 연결 확인으로 끌 수 있고 더 낡으면 차단", async () => {
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "i", preview_url: "/media/g.mp4" } } });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const held = deferred<Record<string, unknown>>(); mocks.currentBin.mockReturnValueOnce(held.promise);
  await tick(3500);
  await act(async () => control.startNativeDrag("g"));
  expect(window.mvhubResolve!.startDrag).toHaveBeenCalledTimes(1);
  await tick(2100);
  await act(async () => control.startNativeDrag("g"));
  expect(window.mvhubResolve!.startDrag).toHaveBeenCalledTimes(1);
  await act(async () => held.resolve(destination)); await flush();
});

it("느린 stage가 선택 변경 뒤 도착해도 옛 로컬 준비를 재사용하지 않음", async () => {
  await render(false);
  const held = deferred<Record<string, unknown>>(); mocks.stage.mockReturnValueOnce(held.promise);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.selectFolder("", "", "", []));
  await act(async () => held.resolve({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/old.mp4", item_id: "old", preview_url: "/media/old.mp4" } } })); await flush();
  expect(control.dragItems).toEqual({});
  await act(async () => control.startNativeDrag("g"));
  expect(window.mvhubResolve!.startDrag).not.toHaveBeenCalled();
});

it("소유 불명 로컬 드롭은 미사용 항목 정리·새 NAS 전환 전에 저장을 막음", async () => {
  await render(false);
  mocks.inventory.mockResolvedValue({ ...destination, unmanaged_local: 1, more: false, items: [
    { resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", usage: 0 }] });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(mocks.unstage).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  expect(control.saveState.phase).toBe("blocked");
});

it("저장이 막히면 새 로컬 항목을 자동으로 만들거나 복구 대기 항목을 재준비하지 않음", async () => {
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const staged = mocks.stage.mock.calls.length;
  mocks.save.mockResolvedValueOnce({ state: "save_failed" });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(control.saveState.phase).toBe("blocked");
  expect(mocks.stage.mock.calls.length).toBe(staged);
  expect(control.dragItems).toEqual({});
  await act(async () => control.startNativeDrag("g"));
  expect(control.notice).toContain("다시 저장");
});

it("저장 후 낡은 끌기 정보는 버리고 이미 받은 로컬 미리보기는 유지", async () => {
  mocks.cache.mockResolvedValue({ items: [{ gen_id: "g", state: "cached", preview_url: "/media/kept.mp4" }] });
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "i", preview_url: "/media/kept.mp4" } } });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  expect(control.previews.g).toBe("/media/kept.mp4");
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "refreshed-item", preview_url: "/media/kept.mp4" } } });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
  expect(control.dragItems.g.item_id).toBe("refreshed-item"); expect(control.previews.g).toBe("/media/kept.mp4");
  await act(async () => control.startNativeDrag("g"));
  expect(window.mvhubResolve!.startDrag).toHaveBeenCalledWith("C:/cache/g.mp4", { protocol: 1 });
});

it("선택이 바뀐 뒤 끝난 cache는 새 미리보기에 섞이지 않음", async () => {
  await render(false);
  const held = deferred<{ items: { gen_id: string; state: string; preview_url: string }[] }>();
  mocks.cache.mockReturnValueOnce(held.promise);
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.selectFolder("", "", "", []));
  await act(async () => held.resolve({ items: [{ gen_id: "g", state: "cached", preview_url: "/media/old.mp4" }] })); await flush();
  expect(control.previews).toEqual({});
});

it("영상 카드에는 준비된 로컬 미리보기 URL과 네이티브 끌기를 연결, 미준비 원격 원본은 비움", async () => {
  localStorage.setItem("mvhub.resolvePanel.ui", JSON.stringify({ pool: { view: "thumb", size: 130, sort: "new" } }));
  const videoGen = { ...gen, assets: [{ type: "video", file_path: "https://remote.invalid/g.mp4", thumbnail_path: "/media/thumb.png" }] } as Generation;
  mocks.generations.mockReturnValue({ state: "ok", gens: [videoGen], reload: mocks.listReload, startedAt: 1 });
  const held = deferred<Record<string, unknown>>(); mocks.stage.mockReturnValueOnce(held.promise);
  await render();
  expect(mocks.editCard.mock.lastCall![0].item.gen.assets[0].file_path).toBe("");
  await act(async () => held.resolve({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "i", preview_url: "/media/g.mp4" } } })); await flush();
  const props = mocks.editCard.mock.lastCall![0];
  expect(props.item.gen.assets[0].file_path).toBe("/media/g.mp4");
  await act(async () => props.onNativeDrag("g"));
  expect(window.mvhubResolve!.startDrag).toHaveBeenCalledWith("C:/cache/g.mp4", { protocol: 1 });
});

it("메타데이터 보기에서도 로컬 영상 호버 재생·이탈 정지·끌기 정지", async () => {
  const videoGen = { ...gen, assets: [{ type: "video", file_path: "https://remote.invalid/g.mp4", thumbnail_path: "/media/thumb.png" }] } as Generation;
  mocks.generations.mockReturnValue({ state: "ok", gens: [videoGen], reload: mocks.listReload, startedAt: 1 });
  mocks.stage.mockResolvedValue({ ...destination, items: [{ gen_id: "g", state: "staged" }],
    drag_items: { g: { path: "C:/cache/g.mp4", item_id: "i", preview_url: "/media/g.mp4" } } });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  try {
    await render();
    const video = host.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/media/g.mp4");
    await act(async () => video.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(play).toHaveBeenCalled(); expect(video.muted).toBe(true);
    await act(async () => video.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(pause).toHaveBeenCalled(); expect(video.currentTime).toBe(0);
    const before = pause.mock.calls.length;
    await act(async () => host.querySelector(".ed-prow-meta")!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })));
    expect(pause.mock.calls.length).toBeGreaterThan(before);
    expect(window.mvhubResolve!.startDrag).toHaveBeenCalledWith("C:/cache/g.mp4", { protocol: 1 });
  } finally { play.mockRestore(); pause.mockRestore(); }
});

it("used 감지는 NAS 전환 없이 표시만, 명시적 저장에서 prepare 다음 adopt", async () => {
  mocks.currentBin.mockResolvedValue({ ...destination, used: ["g"] });
  await render(false); await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush(); await tick(6000);
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.adopt).not.toHaveBeenCalled();
  mocks.inventory.mockResolvedValue({ ...destination, items: [{ resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", usage: 1 }], more: false });
  await act(async () => control.saveProject("p", "S/C2")); await flush();
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
  expect(mocks.settle).not.toHaveBeenCalled();
  expect(mocks.stage).toHaveBeenCalledTimes(3);
});

// AUTO-CLEANUP-OFF — 아래 표식이 붙은 시험은 자동 지우기(Jay 11-12 끔)용이다. 스위치를 다시 켜면 되살리고, 정리 단계에서 지운다.
it.skip("다른 에피소드: 새 target 먼저, 그 뒤 앞 에피소드 컷 빈 전부를 settle 한 번 · 쓴 것은 그 뒤 NAS 로", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValueOnce({ ...destination, bin_id: "epT", bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  mocks.settle.mockResolvedValue({ state: "ok", resolve_project_id: "r", removed: 3, bins: {
    "S/C2": { state: "ok", removed: 1, bin_deleted: false, used: ["g"] }, "S/C10": { state: "ok", removed: 2, bin_deleted: true, used: [] } } });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ episode_path: "S", create_paths: ["S/C2", "S/C10"] });
  expect(mocks.stage).not.toHaveBeenCalled();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  expect(mocks.settle).toHaveBeenCalledTimes(1);
  expect(mocks.settle.mock.calls[0][0]).toMatchObject({ folder_path: "S", bins: [{ folder_path: "S/C2", bin_id: "b2" }, { folder_path: "S/C10", bin_id: "b10" }] });
  expect(mocks.unstage).not.toHaveBeenCalled(); // 컷마다 지우지 않는다
  expect(mocks.currentBin.mock.calls.filter(call => call[2] === "S/C2" || call[2] === "S/C10")).toEqual([]); // 컷마다 읽지도 않는다
  expect(mocks.target.mock.invocationCallOrder[1]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]);
  expect(mocks.adopt.mock.calls.map(call => [call[0].folder_path, call[0].gen_id, call[0].bin_id])).toEqual([["S/C2", "g", "b2"]]);
  expect(mocks.settle.mock.invocationCallOrder[0]).toBeLessThan(mocks.adopt.mock.invocationCallOrder[0]); // 안 쓴 것을 지운 뒤 쓴 것을 NAS 로
});

it.skip("앞 에피소드 settle 전에 그 에피소드를 다시 고르면(A→B→A) 지우지 않음 · settle 도는 중에 다시 고르면 그 target 은 settle 뒤에", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  const heldTarget = deferred<typeof destination>();
  mocks.target.mockReturnValueOnce(heldTarget.promise);
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => heldTarget.resolve({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" })); await flush();
  expect(mocks.settle.mock.calls.filter(call => call[0].folder_path === "S")).toEqual([]);
  // settle 이 도는 사이 다시 고르면 — 그 선택의 target 은 대기열에서 settle 이 끝난 뒤 돈다(지운 빈을 다시 만든다)
  const heldSettle = deferred<{ state: string; resolve_project_id: string; bins: Record<string, unknown> }>();
  mocks.settle.mockReturnValueOnce(heldSettle.promise);
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  expect(mocks.settle.mock.calls.at(-1)![0]).toMatchObject({ folder_path: "S" });
  const targets = mocks.target.mock.calls.length;
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  expect(mocks.target.mock.calls.length).toBe(targets);
  await act(async () => heldSettle.resolve({ state: "ok", resolve_project_id: "r", bins: {} })); await flush();
  expect(mocks.target.mock.calls.length).toBe(targets + 1);
  expect(mocks.target.mock.calls.at(-1)![0]).toMatchObject({ folder_path: "S", create_paths: ["S/C2", "S/C10"] });
});

it.skip("다른 에피소드(빈 표 없음): 새 컷을 먼저 띄운 뒤 앞 컷 정리 — 기다리는 사이 A 를 다시 고르면 A 는 안 지움", async () => {
  await render(false); await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  const held = deferred<typeof destination>();
  mocks.currentBin.mockReturnValueOnce(held.promise).mockResolvedValue({ ...destination, bin_id: "elsewhere" });
  await act(async () => control.selectFolder("p", "T", "T/C1", [])); await flush();
  const settleRead = mocks.currentBin.mock.calls.findIndex(call => call[2] === "S/C2");
  expect(mocks.stage.mock.invocationCallOrder[1]).toBeLessThan(mocks.currentBin.mock.invocationCallOrder[settleRead]); // 새 컷 먼저
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => held.resolve({ ...destination, bin_id: "elsewhere" })); await flush();
  expect(mocks.stage).toHaveBeenCalledTimes(3);
  expect(mocks.unstage.mock.calls.map(call => [call[0].folder_path, call[0].delete_empty])).toEqual([["T/C1", undefined]]); // 빈 표가 없으면 빈은 안 지운다
});

it.skip("새 target 이 실패하면 앞 에피소드는 미뤄 두었다가 [맞추기]로 맞춘 뒤 정리", async () => {
  mocks.currentBin.mockImplementation(async (_ctx: unknown, _project: string, folder: string) =>
    ({ ...destination, bin_id: "elsewhere", target_bin_id: ({ "S/C2": "b2", "S/C10": "b10" } as Record<string, string>)[folder] ?? "ep" }));
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValueOnce({ state: "unavailable" })
    .mockResolvedValue({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  expect(mocks.settle).not.toHaveBeenCalled();
  await act(async () => control.align()); await flush();
  expect(mocks.settle.mock.calls.map(call => call[0].bins.map((bin: { bin_id: string }) => bin.bin_id))).toEqual([["b2", "b10"]]);
});

it.skip("낡은 B 작업은 그사이 C 를 골랐으면 정리하지 않고, C 의 target 뒤에 앞 에피소드를 정리", async () => {
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
  expect(mocks.settle.mock.calls.map(call => call[0].bins.map((bin: { bin_id: string }) => bin.bin_id))).toEqual([["b2", "b10"]]);
  expect(mocks.target.mock.invocationCallOrder[targetV]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]);
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

it.skip("프로젝트를 바꿔 선택이 풀리면 앞 에피소드를 settle 로 정리(다빈치가 들어가 있는 빈은 리졸브 쪽이 남김)", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  mocks.settle.mockResolvedValue({ state: "ok", resolve_project_id: "r", bins: { "S/C2": { state: "current" }, "S/C10": { state: "ok", removed: 1, bin_deleted: true, used: [] } } });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("", "", "", [])); await flush();
  expect(mocks.settle.mock.calls.map(call => call[0].bins.map((bin: { bin_id: string }) => bin.bin_id))).toEqual([["b2", "b10"]]);
  expect(mocks.unstage).not.toHaveBeenCalled();
});

const settleUsed = { "S/C2": { state: "ok", used: ["g"] }, "S/C10": { state: "ok", used: ["h"] } };
const switchEpisodes = async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValueOnce({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
};

it.skip("settle 이 다른 다빈치 프로젝트로 답하면 쓴 것 NAS 옮기기도 안 함", async () => {
  mocks.settle.mockResolvedValueOnce({ state: "project_changed", resolve_project_id: "other", bins: settleUsed });
  await switchEpisodes();
  expect(mocks.settle).toHaveBeenCalledTimes(1);
  expect(mocks.adopt).not.toHaveBeenCalled();
});

it.skip("settle 이 ok 가 아니면 알림", async () => {
  mocks.settle.mockResolvedValueOnce({ state: "unavailable", details: "x" });
  await switchEpisodes();
  expect(control.failures.some(line => line.includes("앞 컷 정리를 확인하지 못했습니다"))).toBe(true);
  expect(mocks.adopt).not.toHaveBeenCalled();
});

it.skip("settle 이 정리 뒤 다빈치 지금 빈을 못 되돌렸으면(restore_failed) 알리고 쓴 것 옮기기는 이어 감", async () => {
  mocks.settle.mockResolvedValueOnce({ state: "restore_failed", resolve_project_id: "r", bins: settleUsed });
  await switchEpisodes();
  expect(control.failures).toContain("다빈치 지금 빈을 처음 자리로 되돌리지 못했습니다");
  expect(mocks.adopt.mock.calls.map(call => call[0].gen_id)).toEqual(["g", "h"]);
});

it.skip("쓴 것 NAS 옮기기 하나가 실패해도 다음 것은 옮김", async () => {
  mocks.settle.mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", bins: settleUsed });
  mocks.adopt.mockResolvedValueOnce({ state: "replace_failed" }).mockResolvedValueOnce({ state: "in_bin" });
  await switchEpisodes();
  expect(mocks.adopt.mock.calls.map(call => [call[0].gen_id, call[0].bin_id])).toEqual([["g", "b2"], ["h", "b10"]]);
  expect(control.failures.length).toBeGreaterThan(0);
});

it("실시간: 새로 활성이 된 컷은 keep_current target 한 번 · 실패면 같은 묶음 재시도 없음 · /ws 알림은 1초 묶어 다시 읽기", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render();
  expect(mocks.target).toHaveBeenCalledTimes(1);
  const base = mocks.projects.mock.results[0].value;
  mocks.projects.mockReturnValue({ ...base, tree: { ...base.tree, roots: [{ ...base.tree.roots[0],
    children: [...base.tree.roots[0].children, { path: "S/C40", name: "C40", count: 2 }] }, base.tree.roots[1]] } });
  mocks.target.mockResolvedValueOnce({ state: "unavailable", resolve_project_id: "r", details: "정렬 실패" });
  await act(async () => root.render(<ResolvePanelApp />)); await flush();
  expect(mocks.target).toHaveBeenCalledTimes(2);
  expect(mocks.target.mock.calls[1][0]).toMatchObject({ keep_current: true, folder_path: "S", episode_path: "S",
    create_paths: ["S/C2", "S/C10", "S/C40"], expect_project: "r" });
  expect(host.textContent).toContain("새 컷 빈을 만들지 못했습니다");
  await act(async () => root.render(<ResolvePanelApp />)); await flush(); await tick(16_000);
  expect(mocks.target).toHaveBeenCalledTimes(2); // 같은 묶음 — /ws·15초가 와도 다시 안 부름(실패마다 저장·백업이 되풀이되지 않게)
  mocks.listReload.mockClear(); mocks.countsReload.mockClear();
  await act(async () => { mocks.live!({ type: "synced" }); mocks.live!({ status: "done" }); });
  await tick(900);
  expect(mocks.listReload).not.toHaveBeenCalled();
  await tick(200);
  expect(mocks.listReload).toHaveBeenCalled(); expect(mocks.countsReload).toHaveBeenCalledTimes(1);
});

it("다빈치 프로젝트별 기억: 바뀌면 그 프로젝트 선택으로 · 앞 프로젝트 정리 안 함 · 처음 보는 프로젝트는 빈 선택 · 쓰기마다 expect_project", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ last: { project: "p", episode: "S", cut: "S/C2" },
    byDavinci: { r: { project: "p", episode: "S", cut: "S/C2" }, r2: { project: "p", episode: "T", cut: "T/C1" } } }));
  let davinci = "r";
  mocks.currentBin.mockImplementation(async () => ({ ...destination, resolve_project_id: davinci }));
  mocks.target.mockImplementation(async (body: { folder_path: string }) => ({ ...destination, resolve_project_id: davinci, bin_path: "MV Hub/영화/" + body.folder_path }));
  mocks.stage.mockImplementation(async () => ({ ...destination, resolve_project_id: davinci, items: [] }));
  await render();
  expect(mocks.target.mock.calls[0][0]).toMatchObject({ folder_path: "S/C2", expect_project: "r" });
  expect(mocks.stage.mock.calls[0][0].expect_project).toBe("r");
  davinci = "r2"; await tick(2000); await tick(10);
  expect(mocks.target.mock.calls.at(-1)![0]).toMatchObject({ folder_path: "T/C1", expect_project: "r2" });
  expect(mocks.unstage).not.toHaveBeenCalled(); // 다른 다빈치 프로젝트의 같은 이름 빈은 정리하지 않는다
  expect(row("T/C1")!.className).toContain("selected");
  const before = mocks.target.mock.calls.length;
  davinci = "r3"; await tick(2000); await tick(10);
  expect(mocks.target.mock.calls.length).toBe(before); // 처음 보는 프로젝트 — 묻지 않고 빈을 만들지 않는다
  expect(host.textContent).toContain("왼쪽에서 에피소드나 컷을 고르세요");
});

it("다시 짓기(ids_changed) 뒤 옛 빈 ID 로 stage 하지 않음 · 다른 다빈치 프로젝트에서 온 응답은 버림", async () => {
  await render(false);
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" })
    .mockResolvedValueOnce({ ...destination, bin_id: "b2", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    // 실시간 새 컷(C40) 빈 만들기가 순서를 맞추며 다시 지었다 — 빈 ID 가 모두 바뀌었고 bin_id 는 되돌린 사람의 지금 빈
    .mockResolvedValueOnce({ ...destination, bin_id: "person", bins: { "S/C2": "n2", "S/C10": "n10", "S/C40": "n40" }, episode_bin_id: "nS", ids_changed: true });
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2", "S/C10"])); await flush();
  expect(mocks.stage.mock.calls.at(-1)![0].bin_id).toBe("b2");
  await act(async () => control.syncCuts(["S/C2", "S/C10", "S/C40"])); await flush();
  expect(mocks.target.mock.calls.at(-1)![0]).toMatchObject({ keep_current: true, create_paths: ["S/C2", "S/C10", "S/C40"] });
  await act(async () => control.updateSet([gen])); await flush();
  expect(mocks.stage.mock.calls.at(-1)![0].bin_id).toBe("n2");
  await act(async () => control.selectFolder("p", "T", "T/C1", [])); await flush();
  expect(mocks.stage.mock.calls.at(-1)![0].bin_id).toBeUndefined(); // T 의 옛 빈 ID(t1)는 버렸다
  mocks.target.mockResolvedValueOnce({ state: "project_changed", resolve_project_id: "r2" });
  const staged = mocks.stage.mock.calls.length;
  await act(async () => control.selectFolder("p", "S", "S/C10", [])); await flush();
  expect(mocks.stage.mock.calls.length).toBe(staged);
  expect(control.davinci).toBe("r2");
});

it("선택이 바뀐 사이에 온 다시 짓기 응답도 옛 빈 ID 를 버림 · 일부 빈만 못 만든 실시간 묶음은 재시도 없음(Codex P2)", async () => {
  await render(false);
  let release!: (value: unknown) => void;
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  await act(async () => { void control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2", "S/C10"]); }); await flush();
  await act(async () => { void control.selectFolder("p", "T", "T/C1", []); }); await flush(); // S 의 target 을 기다리는 사이 T 로
  await act(async () => release({ ...destination, bin_id: "b2", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS", ids_changed: true }));
  await flush();
  expect(mocks.stage.mock.calls.at(-1)![0].bin_id).toBeUndefined(); // 버린 응답이어도 T 의 옛 빈 ID(t1)로 stage 하지 않는다
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "T/C1": "n1" }, episode_bin_id: "nT" })
    .mockResolvedValueOnce({ ...destination, bin_id: "person", bins: { "T/C1": "n1" }, episode_bin_id: "nT", bin_create_failed: ["T/C5"] });
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  const before = mocks.target.mock.calls.length;
  await act(async () => control.syncCuts(["T/C1", "T/C5"])); await flush();
  expect(mocks.target.mock.calls.length).toBe(before + 1);
  await act(async () => control.syncCuts(["T/C1", "T/C5"])); await flush();
  expect(mocks.target.mock.calls.length).toBe(before + 1); // ok 라도 일부 빈을 못 만들었으면 같은 묶음 재시도 없음
});

it("느린 target 사이 목록 갱신으로 선택 객체만 바뀌어도 새 빈 표를 지킴 — 그 뒤 실시간 빈 만들기가 돈다(Codex P2 2차)", async () => {
  await render(false);
  let release!: (value: unknown) => void;
  mocks.target.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { void control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2", "S/C10"]); }); await flush();
  await act(async () => { control.updateSet([gen]); }); await flush(); // 같은 컷, 새 선택 객체
  await act(async () => release({ ...destination, bin_id: "b2", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS", ids_changed: true }));
  await flush();
  expect(mocks.stage.mock.calls.at(-1)![0].bin_id).toBe("b2");
  const before = mocks.target.mock.calls.length;
  await act(async () => control.syncCuts(["S/C2", "S/C10", "S/C40"])); await flush();
  expect(mocks.target.mock.calls.length).toBe(before + 1);
  expect(mocks.target.mock.calls.at(-1)![0]).toMatchObject({ keep_current: true, create_paths: ["S/C2", "S/C10", "S/C40"] });
});

it("띄움 속도: 빈 표가 있으면 다빈치 빈 읽기를 0.7초마다, 없으면 2초마다", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "", cut: "" }));
  await render();
  const reads = () => mocks.currentBin.mock.calls.length;
  let before = reads();
  await tick(800);
  expect(reads()).toBe(before); // 빈 표 없음 — 2초 간격
  await tick(1300);
  expect(reads()).toBe(before + 1);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await act(async () => row("S")!.click()); await flush();
  await tick(2100); // 앞 간격(2초) 지나고 새 간격으로
  before = reads();
  await tick(800);
  expect(reads()).toBe(before + 1); // 빈 표 있음 — 0.7초 간격
});

it("미리 캐시: 선택의 target 뒤에 에피소드 컷 원본을 받아 둠(지금 선택 seq) · 받은 것은 다시 안 물음 · stage·리졸브 쓰기 0", async () => {
  const g10 = { ...gen, id: "g10", folder_path: "S/C10" } as Generation;
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen, g10], reload: mocks.listReload, startedAt: 1 });
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const held = deferred<unknown>();
  mocks.target.mockImplementationOnce(() => held.promise);
  await render();
  expect(mocks.cache).not.toHaveBeenCalled(); // 선택의 target 이 대기열에 있는 동안은 미리 받지 않는다
  await act(async () => held.resolve({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })); await flush();
  expect(mocks.cache.mock.calls.map(([body]) => [body.folder_path, body.gen_ids])).toEqual([["S/C2", ["g"]], ["S/C10", ["g10"]]]); // MV 컷 순서
  expect(mocks.cache.mock.calls.every(([body]) => body.seq === mocks.target.mock.calls[0][0].seq)).toBe(true);
  expect(mocks.stage).not.toHaveBeenCalled();
  const count = mocks.cache.mock.calls.length;
  await act(async () => row("S")!.querySelector<HTMLElement>(".folder-tree-fold")!.click()); await flush();
  await act(async () => row("S/C2")!.click()); await flush(); // 같은 에피소드 컷 — 그 컷 받기는 선택이 하고, 미리 받기는 다시 안 묻는다
  expect(mocks.cache.mock.calls.slice(count).map(([body]) => body.folder_path)).toEqual(["S/C2"]);
});

it("미리 캐시: 받는 중 에피소드를 바꾸면 옛 판은 남은 컷을 묻지 않음", async () => {
  const g10 = { ...gen, id: "g10", folder_path: "S/C10" } as Generation;
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen, g10], reload: mocks.listReload, startedAt: 1 });
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const first = deferred<unknown>();
  mocks.cache.mockImplementationOnce(() => first.promise);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render();
  expect(mocks.cache.mock.calls.map(([body]) => body.folder_path)).toEqual(["S/C2"]); // 첫 컷을 받는 중
  await act(async () => row("T")!.click()); await flush();
  await act(async () => first.resolve({ items: [{ gen_id: "g", state: "cached" }] })); await flush();
  expect(mocks.cache.mock.calls.map(([body]) => body.folder_path)).toEqual(["S/C2"]); // S/C10 은 묻지 않는다
});

it("미리 캐시: 기다리는 사이 뒤에 붙은 선택의 일(다시 띄우기)이 먼저", async () => {
  await render(false);
  const held = deferred<unknown>();
  mocks.target.mockImplementationOnce(() => held.promise);
  await act(async () => { void control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2", "S/C10"]); }); await flush();
  await act(async () => { control.precache("p", "S", [["S/C2", ["g", "g2"]], ["S/C10", ["g10"]]]); }); await flush();
  await act(async () => { control.retry(); }); await flush(); // 미리 받기가 기다리는 사이 선택의 다시 띄우기가 대기열 뒤에
  await act(async () => held.resolve({ ...destination, bin_id: "b2", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })); await flush();
  expect(mocks.cache.mock.calls.map(([body]) => body.gen_ids)).toEqual([["g"], ["g"], ["g2"], ["g10"]]); // 선택·다시 띄우기 → 미리 받기
});

it("미리 캐시: 거르기로 목록이 비면 옛 판도 끝남", async () => {
  const g10 = { ...gen, id: "g10", folder_path: "S/C10" } as Generation;
  mocks.generations.mockReturnValue({ state: "ok", gens: [gen, g10], reload: mocks.listReload, startedAt: 1 });
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const first = deferred<unknown>();
  mocks.cache.mockImplementationOnce(() => first.promise);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await render();
  expect(mocks.cache.mock.calls.map(([body]) => body.folder_path)).toEqual(["S/C2"]);
  mocks.generations.mockReturnValue({ state: "ok", gens: [], reload: mocks.listReload, startedAt: 2 }); // 같은 에피소드, 목록이 빔
  await act(async () => root.render(<ResolvePanelApp />)); await flush();
  await act(async () => first.resolve({ items: [{ gen_id: "g", state: "cached" }] })); await flush();
  expect(mocks.cache.mock.calls.map(([body]) => body.folder_path)).toEqual(["S/C2"]); // 옛 판의 S/C10 은 묻지 않는다
});

it("미리 띄우기: 다 받으면 컷 빈 표의 컷들을 조각(40개 안팎)으로 채우고 이름 뒤따르기는 남은 0·진전 없음에서 멈춤", async () => {
  const many = (folder: string, n: number) => Array.from({ length: n }, (_, i) => ({ ...gen, id: `${folder}-${i}`, folder_path: folder, created_at: `2026-11-11T00:${String(i).padStart(2, "0")}` }) as Generation);
  mocks.generations.mockReturnValue({ state: "ok", gens: [...many("S/C2", 30), ...many("S/C10", 30)], reload: mocks.listReload, startedAt: 1 });
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  mocks.rename.mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 10, remaining: 1, after: [0, 10] })
    .mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 5, remaining: 0, after: null });
  await render();
  expect(mocks.prestage.mock.calls.map(([body]) => body.cuts.map((cut: { folder_path: string; bin_id: string; gen_ids: string[] }) => [cut.folder_path, cut.bin_id, cut.gen_ids.length])))
    .toEqual([[["S/C2", "b2", 30]], [["S/C10", "b10", 30]]]); // 30+30 > 40 → 조각 둘
  expect(mocks.prestage.mock.calls[0][0]).toMatchObject({ folder_path: "S", episode_bin_id: "epS", expect_project: "r" });
  expect(mocks.rename.mock.calls.map(([body]) => [body.limit, body.after])).toEqual([[10, undefined], [10, [0, 10]]]); // 이어갈 자리가 없으면 멈춤
  expect(mocks.stage).not.toHaveBeenCalled();
});

it("[저장]: 쓴 것은 항목 ID 로 다시 NAS 로(전에 옮긴 생성물도) · 안 쓴 것 정리 · 고정 프로젝트로 save · 끝나면 다시 미리 띄우기", async () => {
  await render(false);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.precache("p", "S", [["S/C2", ["g"]]])); await flush();
  const prestaged = mocks.prestage.mock.calls.length;
  const items = [{ resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "b2", bin_path: "x", item_id: "i1", gen_id: "g", usage: 1 },
    { resolve_project_id: "r", project_id: "p", folder_path: "S/C10", bin_id: "b10", bin_path: "y", item_id: "i2", gen_id: "g10", usage: 0 }];
  mocks.inventory.mockResolvedValue({ ...destination, items, more: false });
  mocks.unstage.mockResolvedValue({ state: "ok", resolve_project_id: "r", removed: 1 });
  for (let round = 0; round < 2; round++) { // 두 번째 저장 — 같은 생성물을 다시 띄워 쓴 클립도 다시 옮긴다
    await act(async () => control.saveProject("p", "S")); await flush();
  }
  expect(mocks.adopt.mock.calls.map(([body]) => [body.gen_id, body.resolve_project_id, body.item_ids])).toEqual([["g", "r", ["i1"]], ["g", "r", ["i1"]]]);
  expect(mocks.unstage.mock.calls.at(-1)![0]).toMatchObject({ bin_id: "b10", expect_project: "r" });
  expect(mocks.save.mock.calls.map(([body]) => body.expect_project)).toEqual(["r", "r"]);
  expect(control.notice).toContain("저장했습니다 — 이 저장 시점의 검사 통과");
  expect(mocks.prestage.mock.calls.length).toBeGreaterThan(prestaged); // 저장 뒤 다시 미리 띄움
});

it("[저장]: NAS 로 못 옮기면 저장하지 않음 · not_clean 이면 빈 경로를 알림", async () => {
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2"])); await flush();
  mocks.inventory.mockResolvedValue({ ...destination, items: [{ resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "b2", bin_path: "x", item_id: "i1", gen_id: "g", usage: 1 }], more: false });
  mocks.adopt.mockResolvedValueOnce({ state: "replace_failed" });
  await act(async () => control.saveProject("p", "S")); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(control.notice).toContain("저장하지 않았습니다");
  expect(control.saveState).toEqual({ phase: "blocked", bins: [] }); // [저장] 칸 = 저장 안 됨
  mocks.inventory.mockResolvedValue({ ...destination, items: [], more: false });
  mocks.save.mockResolvedValueOnce({ state: "not_clean", resolve_project_id: "r", not_clean: { mine: 0, other: 1, in_use: 1, bins: [{ path: "MV Hub/영화/S/C2", in_use: true, mine: false }] } });
  await act(async () => control.saveProject("p", "S")); await flush();
  expect(control.notice).toContain("이 PC 클립이 남아 저장하지 않았습니다");
  // 걸린 빈은 [저장] 칸 옆 목록으로(C안 ④) — 알림 목록에 또 넣지 않는다
  expect(control.saveState).toEqual({ phase: "blocked", bins: [{ path: "MV Hub/영화/S/C2", in_use: true, mine: false }] });
  expect(control.failures.some(line => line.includes("MV Hub/영화/S/C2"))).toBe(false);
});

it("미리 띄우기가 건너뛴 컷이 있으면 에피소드 빈에 두 번 연속 머물 때 한 번 다시(스쳐 지나가기엔 안 돎)", async () => {
  let bin = "b2";
  mocks.currentBin.mockImplementation(async () => ({ ...destination, bin_id: bin }));
  mocks.prestage.mockResolvedValue({ state: "ok", resolve_project_id: "r", cuts: { "S/C10": { state: "ok", items: [{ gen_id: "g10", state: "deferred" }], deferred: 1 } } });
  await render(false);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" });
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.precache("p", "S", [["S/C10", ["g10"]]])); await flush();
  const before = mocks.prestage.mock.calls.length;
  bin = "epS"; await tick(800); // 한 번 — 스쳐 지나가기
  bin = "b2"; await tick(800);
  expect(mocks.prestage.mock.calls.length).toBe(before);
  bin = "epS"; await tick(800); await tick(800); // 두 번 연속 머묾
  expect(mocks.prestage.mock.calls.length).toBe(before + 1);
  await tick(800); await tick(800);
  expect(mocks.prestage.mock.calls.length).toBe(before + 1); // 돌아올 때 한 번만
});

it("미리 띄우기는 받은 것만(일부만 받은 컷은 capped) · 이름 뒤따르기는 앞 작업이 멈춘 자리부터", async () => {
  await render(false);
  mocks.target.mockResolvedValueOnce({ ...destination, bin_id: "epS", bins: { "S/C2": "b2" }, episode_bin_id: "epS" });
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2"])); await flush();
  mocks.cache.mockImplementation(async (body: { gen_ids: string[] }) => ({ items: body.gen_ids.map(gen_id => ({ gen_id, state: gen_id === "g2" ? "failed" : "cached" })) }));
  mocks.rename.mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 9, failed: 1, remaining: 2, after: [0, 10] })
    .mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 0, failed: 0, remaining: 1, after: [0, 40] }) // 바꿀 것 없이 자리만 앞으로 = 진전
    .mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 3, failed: 0, remaining: 0, after: null })
    .mockResolvedValueOnce({ state: "ok", resolve_project_id: "r", named: 1, failed: 0, remaining: 0, after: null }); // 앞 실패 때문에 처음부터 한 번 더
  await act(async () => control.precache("p", "S", [["S/C2", ["g", "g2"]]])); await flush();
  expect(mocks.prestage.mock.calls[0][0].cuts).toEqual([{ folder_path: "S/C2", bin_id: "b2", gen_ids: ["g"], capped: true }]);
  expect(mocks.rename.mock.calls.map(([body]) => body.after)).toEqual([undefined, [0, 10], [0, 40], undefined]);
});

it("[저장] 단추: 리졸브 안·쓰기 담당일 때만 보이고 누르면 저장 흐름", async () => {
  delete window.mvhubResolve;
  await render();
  expect(host.querySelector(".rp-save")).toBeNull(); // 리졸브 밖
  await act(async () => root.unmount()); root = createRoot(host);
  window.mvhubResolve = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
  await render();
  const button = () => host.querySelector<HTMLButtonElement>(".rp-save")!;
  expect(button().textContent).toBe("저장");
  expect(button().className).toBe("rp-save rp-save-idle");
  expect(host.querySelector(".resolve-panel-head")!.className).toContain("has-save"); // 머리줄 글은 칸만큼 비운다
  // C안 ② 저장 중 — 단계가 작은 줄에, 누를 수 없음
  const held = deferred<{ state: string; resolve_project_id: string }>();
  mocks.save.mockReturnValueOnce(held.promise);
  await act(async () => button().click()); await flush();
  expect(mocks.save.mock.calls[0][0]).toMatchObject({ project_id: "p", expect_project: "r" });
  expect([button().className, button().disabled, button().textContent]).toEqual(["rp-save rp-save-saving", true, "저장 중검사"]);
  // ③ 저장됨 — 시각과 함께, 3초 뒤 기본
  await act(async () => held.resolve({ state: "ok", resolve_project_id: "r" })); await flush();
  expect(button().className).toBe("rp-save rp-save-done");
  expect(button().querySelector("b")!.textContent).toBe("저장됨");
  expect(button().querySelector("small")!.textContent).toMatch(/^\d\d:\d\d$/);
  await tick(3000);
  expect(button().className).toBe("rp-save rp-save-idle");
  // ④ 막힘 — 걸린 빈 수·다시 저장, 머리줄에 빈 목록 · 다시 누르면 다시 저장
  mocks.save.mockResolvedValueOnce({ state: "not_clean", resolve_project_id: "r", not_clean: { mine: 1, other: 1, in_use: 1,
    bins: [{ path: "MV Hub/영화/S/C2", count: 12, in_use: false, mine: false }, { path: "MV Hub/영화/S/C10", count: 2, in_use: true, mine: true }] } });
  await act(async () => button().click()); await flush();
  expect([button().className, button().querySelector("b")!.textContent, button().querySelector("small")!.textContent])
    .toEqual(["rp-save rp-save-blocked", "남은 빈 2", "다시 저장"]);
  expect([...host.querySelectorAll(".rp-save-list > div")].map(row => row.textContent)).toEqual([
    "다른 허브MV Hub/영화/S/C2 · 12 (다빈치에서 직접 확인)", "내 것MV Hub/영화/S/C10 · 2 · 쓰는 중 (다시 저장하면 풀릴 수 있음)"]);
  expect(host.querySelector(".resolve-panel-status")!.className).toContain("bad");
  await act(async () => button().click()); await flush();
  expect(mocks.save).toHaveBeenCalledTimes(3);
  expect(host.querySelector(".rp-save-list")).toBeNull(); // 다시 저장해 깨끗하면 목록이 걷힌다
});

it("미리 캐시: 기다린 뒤 선택이 그사이 받은 ID 는 다시 묻지 않음", async () => {
  await render(false);
  const held = deferred<unknown>();
  mocks.target.mockImplementationOnce(() => held.promise);
  await act(async () => { void control.selectFolder("p", "S", "", [], false, ["S/C2"]); }); await flush(); // 대기열이 바쁨
  await act(async () => { control.precache("p", "S", [["S/C2", ["g"]]]); }); await flush(); // g 를 받으려고 기다림
  await act(async () => { void control.selectFolder("p", "S", "S/C2", [gen], false, ["S/C2"]); }); await flush(); // 선택이 g 를 받는다
  await act(async () => held.resolve({ ...destination, bin_id: "epS", bins: { "S/C2": "b2" }, episode_bin_id: "epS" })); await flush();
  expect(mocks.cache.mock.calls.map(([body]) => body.gen_ids)).toEqual([["g"]]); // 미리 받기는 다시 안 묻는다
});

it.skip("다시 열 때 저장된 에피소드의 컷 빈은 inventory 정리에서 건너뛰고 빈은 안 지움 — AUTO-CLEANUP-OFF", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "S", cut: "" }));
  const row = { resolve_project_id: "r", project_id: "p", bin_path: "x", item_id: "i", gen_id: "g", usage: 0 };
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: [
    { ...row, folder_path: "S/C2", bin_id: "b2" }, { ...row, folder_path: "S2/C1", bin_id: "s2" }, { ...row, folder_path: "T/C1", bin_id: "t1" }] });
  await render(false); await flush();
  expect(mocks.unstage.mock.calls.map(call => [call[0].bin_id, call[0].inventory_cleanup, call[0].delete_empty])).toEqual([["s2", true, undefined], ["t1", true, undefined]]);
});

it("자동 지우기 끔(Jay 11-12): 에피소드를 옮겨도·프로젝트를 풀어도·[맞추기] 뒤에도 settle·unstage 없음", async () => {
  mocks.target.mockResolvedValueOnce({ ...destination, bins: { "S/C2": "b2", "S/C10": "b10" }, episode_bin_id: "epS" })
    .mockResolvedValue({ ...destination, bins: { "T/C1": "t1" }, episode_bin_id: "epT" });
  await render(false);
  await act(async () => control.selectFolder("p", "S", "", [], false, ["S/C2", "S/C10"])); await flush();
  await act(async () => control.selectFolder("p", "T", "", [], false, ["T/C1"])); await flush();
  await act(async () => control.align()); await flush();
  await act(async () => control.selectFolder("p", "S", "S/C2", [gen])); await flush();
  await act(async () => control.selectFolder("", "", "", [])); await flush();
  expect(mocks.settle).not.toHaveBeenCalled();
  expect(mocks.unstage).not.toHaveBeenCalled();
  expect(mocks.target.mock.calls.length).toBeGreaterThan(2); // 빈 맞추기는 그대로 돈다
});

it("재열기는 새 NAS 전환·자동 삭제 없이 중단된 복구만 이어감", async () => {
  localStorage.setItem("mvhub.resolvePanel.selection", JSON.stringify({ project: "p", episode: "", cut: "" }));
  const row = { resolve_project_id: "r", project_id: "p", bin_path: "x", item_id: "i", gen_id: "g" };
  mocks.inventory.mockResolvedValue({ ...destination, more: false, items: [
    { ...row, folder_path: "T/C1", bin_id: "t1", usage: 0 }, { ...row, folder_path: "S2/C1", bin_id: "s2", item_id: "i2", gen_id: "g2", usage: 1 },
    { ...row, folder_path: "S2/C1", bin_id: "s2", item_id: "i3", gen_id: "g3", usage: 1, recovery: true }] });
  await render(false); await flush();
  expect(mocks.unstage).not.toHaveBeenCalled();
  expect(mocks.adopt.mock.calls.map(([body]) => [body.gen_id, body.item_ids])).toEqual([["g3", ["i3"]]]);
  expect(mocks.prepare).not.toHaveBeenCalled();
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
  mocks.inventory.mockResolvedValue({ ...destination, items: [{ resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", recovery: true }], more: false });
  mocks.adopt.mockResolvedValue({ state: "rebuild_recovery_pending" });
  await render(); await tick(6000);
  expect(mocks.adopt).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("정렬 복구가 끝나지 않았습니다");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "다시")).toBe(false);
});

it("실패한 adopt는 수동 다시 뒤에만 재시도", async () => {
  mocks.inventory.mockResolvedValue({ ...destination, items: [{ resolve_project_id: "r", project_id: "p", folder_path: "S/C2", bin_id: "bin", item_id: "i", gen_id: "g", recovery: true }], more: false });
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
