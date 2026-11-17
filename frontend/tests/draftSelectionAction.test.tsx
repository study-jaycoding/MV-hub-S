// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { BoardSelectionActionBar, LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import { GenerationCard } from "../src/components/GenerationCard";
import { setAccountScope } from "../src/lib/accountScope";
import { captureOperationContext } from "../src/app/operationContext";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ cost: vi.fn(), history: vi.fn(), estimate: vi.fn() }));
vi.mock("../src/lib/useModels", () => ({ sharedCostEstimate: mocks.cost }));
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return { ...actual, api: { ...actual.api, history: mocks.history, estimateCost: mocks.estimate } };
});
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));
const draft = { id: "draft", model: "seedance_2_5", status: "done", is_mine: true,
  job_id: "job", params: { draft: true, duration: 4, seed: 34, draft_job_id: undefined }, deleted: false } as unknown as Generation;
const noop = () => {};
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const option = (resolution: string) => document.querySelector<HTMLButtonElement>(`.draft-finish-${resolution}`)!;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.cost.mockReset().mockImplementation((_model, opts) => Promise.resolve({ credits: opts.resolution === "4k" ? 112 : 64 }));
  mocks.history.mockReset().mockResolvedValue({ children: [] });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });
function mount(library = false) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const finish = vi.fn();
  dispose = () => { act(() => root.unmount()); host.remove(); };
  const render = (selected: Generation[] = [draft], busy: (resolution: "1080p" | "4k") => boolean | "uncertain" = () => false, context = "one", revision = 0) => act(() => root.render(library ?
    <LibrarySelectionActionBar selectedCount={selected.length} selectedGenerations={selected} projects={[]} onShare={noop}
      onDownload={noop} onResolveTransfer={noop} onResolveRetry={null} resolveRetryProjectName="" resolveTransferBusy={false}
      resolveTransferPendingCount={0} onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop}
      onFinishDraft={finish} draftBusy={busy} draftContextKey={context} draftRevision={revision} /> :
    <BoardSelectionActionBar selected={selected} projects={[]} onShare={noop} onDownload={noop} onCompare={noop}
      onAssign={noop} onDelete={noop} onFinishDraft={finish} draftBusy={busy} draftContextKey={context} draftRevision={revision} />));
  render();
  return { host, finish, render, button: () => host.querySelector<HTMLButtonElement>(".sb-draft")! };
}

it.each([false, true])("막대는 창만 열고 4초 견적·위쪽 순서·화질별 제출을 제공한다 (library=%s)", async (library) => {
  const view = mount(library); await settle();
  expect(view.host.querySelector(".sb-count")?.nextElementSibling).toBe(view.button());
  expect(view.button().textContent).toBe("Draft 1080p ✦64 ⌃");
  expect(mocks.cost).toHaveBeenCalledTimes(2);
  expect(mocks.cost).toHaveBeenCalledWith("seedance_2_5", { duration: 4, seed: 34, resolution: "4k" });
  act(() => view.button().click()); await settle();
  expect(view.finish).not.toHaveBeenCalled();
  const menu = document.querySelector<HTMLElement>(".draft-finish-menu")!;
  expect(menu.firstElementChild?.textContent).toContain("4초 · Higgsfield 견적");
  expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["4K로 생성 ✦112", "1080p로 생성 ✦64"]);
  expect(Number.parseInt(menu.style.bottom)).toBeGreaterThanOrEqual(8);
  expect(menu.style.maxHeight).not.toBe("");
  act(() => option("4k").click()); expect(view.finish).toHaveBeenLastCalledWith(draft, "4k");
  act(() => option("1080p").click()); expect(view.finish).toHaveBeenLastCalledWith(draft, "1080p");
  view.render(); await settle(); expect(mocks.cost).toHaveBeenCalledTimes(2);
  expect(menu.textContent).not.toContain("...");
});

it("견적 실패는 숫자만 생략하고 정상 0은 표시한다", async () => {
  mocks.cost.mockImplementation((_model, opts) => opts.resolution === "4k" ? Promise.resolve({ credits: 0 }) : Promise.reject(new Error("offline")));
  const view = mount(); await settle(); expect(view.button().textContent).toBe("Draft 1080p ✦ ⌃");
  act(() => view.button().click()); await settle();
  expect(option("4k").textContent).toBe("4K로 생성 ✦0"); expect(option("1080p").disabled).toBe(false);
});

it("화질별 진행 잠금·완료 개수·현재 시도 변화에 따른 history 갱신", async () => {
  mocks.history.mockResolvedValue({ children: [
    { ...draft, id: "one", params: { draft_job_id: "job", resolution: "1080p" } },
    { ...draft, id: "two", params: { draft_job_id: "job", resolution: "4k" } },
    { ...draft, id: "run", status: "done", execution_phase: "tracking", params: { draft_job_id: "job", resolution: "4k" } },
  ] });
  const view = mount(); act(() => view.button().click()); await settle();
  expect(document.querySelector(".draft-finish-menu")?.textContent).toContain("이 드래프트로 만든 것: 1080p 1 · 4K 1");
  expect(option("4k").disabled).toBe(true); expect(option("1080p").disabled).toBe(false);
  mocks.history.mockResolvedValue({ children: [] });
  view.render([draft], (resolution) => resolution === "1080p"); await settle();
  expect(view.button().disabled).toBe(false); expect(option("1080p").disabled).toBe(true); expect(option("4k").disabled).toBe(false);
  view.render(); await settle(); expect(option("1080p").disabled).toBe(false);
  expect(mocks.history).toHaveBeenCalledTimes(3);
});

it("현재 job 만료만 두 화질을 막고 새 선택은 창을 닫는다", async () => {
  mocks.history.mockResolvedValue({ children: [{ ...draft, id: "expired", status: "failed",
    params: { draft_job_id: "job" }, error: "CLI 실패: Error: Seedance 2.5 draft has expired" }] });
  const view = mount(); act(() => view.button().click()); await settle();
  expect(option("1080p").disabled).toBe(true); expect(option("4k").disabled).toBe(true);
  expect(document.querySelector("[role=status]")?.textContent).toBe("드래프트 만료 · 새 드래프트를 만드세요");
  view.render([{ ...draft, job_id: "today" }]); await settle(); expect(document.querySelector(".draft-finish-menu")).toBeNull();
  act(() => view.button().click()); await settle(); expect(option("4k").disabled).toBe(false);
});

it("키보드 선택·Esc 초점 복귀·바깥 클릭·권한·선택 수를 지킨다", async () => {
  const view = mount(); await settle();
  act(() => { view.button().focus(); view.button().click(); }); await settle();
  expect(view.button().getAttribute("aria-expanded")).toBe("true");
  expect(view.button().getAttribute("aria-controls")).toBe(document.querySelector(".draft-finish-menu")?.id);
  act(() => { option("4k").focus(); option("4k").click(); }); expect(view.finish).toHaveBeenCalledWith(draft, "4k");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(view.button()); expect(document.querySelector(".draft-finish-menu")).toBeNull();
  act(() => view.button().click()); act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(document.querySelector(".draft-finish-menu")).toBeNull();
  view.render([{ ...draft, is_mine: false }]); expect(view.button().disabled).toBe(true);
  for (const selected of [[{ ...draft, params: { resolution: "480p" } }], [draft, draft]]) {
    view.render(selected); expect(view.host.querySelector(".sb-draft")).toBeNull();
  }
});

it.each([false, true])("키보드로 열고 Enter를 누르면 기본 1080p만 제출한다 (library=%s)", async (library) => {
  const view = mount(library); await settle();
  // jsdom은 Enter의 기본 click을 만들지 않으므로, 키 이벤트가 허용되면 초점 단추를 활성화한다.
  const enter = () => act(() => {
    const target = document.activeElement as HTMLButtonElement;
    if (target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) target.click();
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
  act(() => view.button().focus()); enter(); await settle();
  expect(document.activeElement).toBe(option("1080p"));
  expect(view.finish).not.toHaveBeenCalled();
  enter();
  expect(view.finish).toHaveBeenCalledExactlyOnceWith(draft, "1080p");
});

it("권한 때문에 비활성이면 진행 중으로 표시하지 않는다", async () => {
  const view = mount(); act(() => view.button().click()); await settle();
  view.render([{ ...draft, is_mine: false }]); await settle();
  for (const resolution of ["1080p", "4k"]) {
    expect(option(resolution).disabled).toBe(true);
    expect(option(resolution).textContent).not.toContain("진행·확인 중");
  }
  view.render([draft], resolution => resolution === "1080p"); await settle();
  expect(option("1080p").textContent).toContain("진행·확인 중");
  expect(option("4k").textContent).not.toContain("진행·확인 중");
});

it("늦은 이전 선택·계정 응답은 새 메뉴를 덮지 않는다", async () => {
  let cost!: (value: { credits: number }) => void;
  let history!: (value: { children: Generation[] }) => void;
  mocks.cost.mockReturnValue(new Promise((resolve) => { cost = resolve; }));
  mocks.history.mockReturnValue(new Promise((resolve) => { history = resolve; }));
  const view = mount(); act(() => view.button().click()); await settle();
  setAccountScope("new-account"); captureOperationContext({ scope: "personal", id: null, name: null });
  await act(async () => { cost({ credits: 999 }); history({ children: [{ ...draft, id: "old", status: "failed", params: { draft_job_id: "job" }, error: "Seedance 2.5 draft has expired" }] }); });
  expect(view.button().textContent).not.toContain("999"); expect(option("4k").textContent).not.toContain("999"); expect(option("4k").disabled).toBe(false);
  view.render([draft], () => false, "new-account"); expect(document.querySelector(".draft-finish-menu")).toBeNull();
  setAccountScope(null);
});

// Jay 10-22: 캔버스 카드처럼 워크스페이스·'생성 결과' 창의 격자 카드에도 Draft 생성물 표시.
it("격자 카드에 Draft 생성물 표시 — Draft 만, 남의 카드는 작성자 배지 아래, 목록 보기에는 없다", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const noop = () => {};
  const base = {
    id: "g1", prompt: "test", shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-10-22",
    assets: [{ id: "a", generation_id: "g1", type: "video", file_path: "/media/a.mp4", thumbnail_path: null }],
    references: [], tags: [], auto_tags: [], deleted: false, model: "seedance_2_5", params: { draft: true }, job_id: "job",
  } as unknown as Generation;
  const render = (gen: Generation, layout: "grid" | "list" = "grid") => act(() => root.render(
    <GenerationCard gen={gen} tab="my" layout={layout} onSetSource={noop} onSetTags={noop} onOpenComments={noop}
      onRequestEdit={noop} onEditDone={noop} onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop}
      onUnfinalize={noop} onImport={noop} onRestore={noop} onInfo={noop} onPreview={noop} onToggleSelect={noop} />,
  ));
  const badge = () => host.querySelector<HTMLElement>(".card-thumb .linb-draft");
  try {
    render(base);
    expect(badge()?.textContent).toBe("Draft");
    expect(badge()?.classList.contains("below-creator")).toBe(false);
    render({ ...base, is_mine: false, creator_name: "리버" } as Generation);
    expect(badge()?.classList.contains("below-creator")).toBe(true); // 작성자 배지(오른쪽 위)와 겹치지 않게
    render({ ...base, params: { draft: true, draft_job_id: "done-job" } } as Generation); // 1080p 로 완성된 결과는 Draft 가 아니다
    expect(badge()).toBeNull();
    render({ ...base, model: "nano_banana_flash" } as Generation);
    expect(badge()).toBeNull();
    render(base, "list");
    expect(badge()).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});


it("두 단추의 같은 견적 옵션은 기존 공유 캐시에서 합쳐진다", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useModels")>("../src/lib/useModels");
  mocks.cost.mockImplementation(actual.sharedCostEstimate);
  mocks.estimate.mockReset().mockImplementation(async (_model, opts) => ({ credits: opts.resolution === "4k" ? 112 : 64, saved_at: Date.now() / 1000, stale: false }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  act(() => root.render(<>{[1, 2].map((key) => <BoardSelectionActionBar key={key} selected={[{ ...draft, params: { ...draft.params, seed: 883 } }]} projects={[]}
    onShare={noop} onDownload={noop} onCompare={noop} onAssign={noop} onDelete={noop} onFinishDraft={noop} />)}</>));
  await settle();
  expect(mocks.estimate).toHaveBeenCalledTimes(2);
  expect([...host.querySelectorAll(".sb-draft")].map((button) => button.textContent)).toEqual(["Draft 1080p ✦64 ⌃", "Draft 1080p ✦64 ⌃"]);
});


it("같은 화질이 계속 잠긴 채 접수돼도 history를 갱신하고 창을 유지한다", async () => {
  const view = mount(); const busy = () => true;
  view.render([draft], busy, "one", 1);
  act(() => view.button().click()); await settle();
  expect(mocks.history).toHaveBeenCalledTimes(1);
  view.render([draft], busy, "one", 2); await settle();
  expect(mocks.history).toHaveBeenCalledTimes(2);
  expect(view.button().getAttribute("aria-expanded")).toBe("true");
});
